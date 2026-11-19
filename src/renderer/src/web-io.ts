import { zipStore } from '@core/zip'
import type { StlFile } from '@shared/api'

/**
 * Browser-only I/O shim (SPEC §6): the web build's counterpart to the Electron
 * `BoxmakerApi`. File open via `<input>`, template persistence in IndexedDB
 * (FR-LOAD-2), and `.stl`-in-`.zip` download for export (FR-EXP-2). The desktop
 * build uses the native bridge instead; `core/` and `ui/` stay identical across
 * both (NFR-PORT-1).
 */

const DB_NAME = 'boxmaker'
const STORE = 'templates'
const LAST_KEY = 'last'

/** Open a browser file dialog and resolve the chosen file's bytes. */
export function pickFile(accept: string): Promise<{ name: string; buffer: ArrayBuffer }> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.addEventListener('change', () => {
      const file = input.files?.[0]
      if (!file) return reject(new Error('No file selected'))
      file.arrayBuffer().then((buffer) => resolve({ name: file.name, buffer }), reject)
    })
    input.click()
  })
}

/** Download `data` as `name` wrapped in a single-entry `.zip` (FR-EXP-2). */
export function downloadZip(name: string, data: Uint8Array): void {
  const zip = zipStore([{ name, data }])
  const base = name.replace(/\.stl$/i, '') || 'boxmaker'
  triggerDownload(`${base}.zip`, new Blob([zip], { type: 'application/zip' }))
}

// --- project files (browser) ---------------------------------------------
// Chromium's File System Access API lets Save overwrite the same file. Other
// browsers fall back to a download (Save = re-download, Save As = ask a name).

/** The subset of FileSystemFileHandle we use (not in every TS DOM lib). */
export interface WebFileHandle {
  name: string
  getFile(): Promise<File>
  createWritable(): Promise<{ write(data: BlobPart): Promise<void>; close(): Promise<void> }>
}

interface FsAccessWindow {
  showOpenFilePicker?: (opts: unknown) => Promise<WebFileHandle[]>
  showSaveFilePicker?: (opts: unknown) => Promise<WebFileHandle>
}

const PROJECT_TYPES = [{ description: 'boxmaker project', accept: { 'application/json': ['.boxmaker'] } }]
const fsAccess = (): FsAccessWindow => window as unknown as FsAccessWindow
const isAbort = (e: unknown): boolean => e instanceof DOMException && e.name === 'AbortError'

export interface OpenedProject {
  name: string
  data: Uint8Array
  handle?: WebFileHandle
}

/** Ask for a project file; null if the user cancels. */
export async function openProjectFile(): Promise<OpenedProject | null> {
  if (fsAccess().showOpenFilePicker) {
    try {
      const [handle] = await fsAccess().showOpenFilePicker!({ types: PROJECT_TYPES })
      const file = await handle.getFile()
      return { name: file.name, data: new Uint8Array(await file.arrayBuffer()), handle }
    } catch (e) {
      if (isAbort(e)) return null
      throw e
    }
  }
  const { name, buffer } = await pickFile('.boxmaker,application/json')
  return { name, data: new Uint8Array(buffer) }
}

/**
 * Save a project. With a `handle` (and not `saveAs`) the file is overwritten in
 * place; otherwise the user chooses a destination. Returns null on cancel.
 */
export async function saveProjectFile(
  suggestedName: string,
  data: Uint8Array,
  handle: WebFileHandle | undefined,
  saveAs: boolean
): Promise<{ name: string; handle?: WebFileHandle } | null> {
  if (fsAccess().showSaveFilePicker) {
    try {
      const target = handle && !saveAs ? handle : await fsAccess().showSaveFilePicker!({ suggestedName, types: PROJECT_TYPES })
      const writable = await target.createWritable()
      await writable.write(new Blob([data as BlobPart]))
      await writable.close()
      return { name: target.name, handle: target }
    } catch (e) {
      if (isAbort(e)) return null
      throw e
    }
  }
  let name = suggestedName
  if (saveAs) {
    const answer = window.prompt('Save project as:', suggestedName)
    if (!answer) return null
    name = answer
  }
  if (!/\.boxmaker$/i.test(name)) name += '.boxmaker'
  triggerDownload(name, new Blob([data as BlobPart], { type: 'application/json' }))
  return { name }
}

function triggerDownload(fileName: string, blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

/** Persist the last-loaded template so it restores next launch (FR-LOAD-2). */
export async function saveLastTemplate(file: StlFile): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put({ name: file.name, data: file.data }, LAST_KEY)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
  db.close()
}

/** Restore the last-loaded template, or null if none is stored. */
export async function loadLastTemplate(): Promise<StlFile | null> {
  const db = await openDb()
  const rec = await new Promise<{ name: string; data: Uint8Array } | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).get(LAST_KEY)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  db.close()
  return rec ? { name: rec.name, data: rec.data } : null
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

// --- recent projects (browser) -------------------------------------------
// Chromium's FileSystemFileHandle is structured-cloneable, so we keep up to
// RECENT_MAX of them in IndexedDB and reopen with a permission re-request.
// Browsers without the File System Access API have no durable handle, so a
// downloaded project simply isn't added to the list.

const RECENT_KEY = 'recent-projects'
const RECENT_MAX = 4

interface RecentRecord {
  name: string
  handle: WebFileHandle
}

/** The FileSystemHandle permission methods, not in every TS DOM lib. */
interface PermissionedHandle {
  queryPermission?: (opts: { mode: string }) => Promise<string>
  requestPermission?: (opts: { mode: string }) => Promise<string>
  isSameEntry?: (other: WebFileHandle) => Promise<boolean>
}

/** Record a just-opened/saved project at the top of the recents (needs a handle). */
export async function addRecentProject(entry: { name: string; handle?: WebFileHandle }): Promise<void> {
  const handle = entry.handle
  if (!handle) return // no durable reference (download fallback) ⇒ cannot reopen
  const list = await getRecents()
  const kept: RecentRecord[] = []
  for (const r of list) {
    if (!(await isSameEntry(r.handle, handle))) kept.push(r)
  }
  await putRecents([{ name: entry.name, handle }, ...kept].slice(0, RECENT_MAX))
}

/** Names of recent projects, most-recent first. */
export async function listRecentProjects(): Promise<string[]> {
  return (await getRecents()).map((r) => r.name)
}

/** Reopen recent #index: re-request read permission and read the file; null if gone/denied. */
export async function openRecentProject(index: number): Promise<OpenedProject | null> {
  const list = await getRecents()
  const rec = list[index]
  if (!rec) return null
  const perm = rec.handle as unknown as PermissionedHandle
  try {
    let state = (await perm.queryPermission?.({ mode: 'read' })) ?? 'granted'
    if (state !== 'granted') state = (await perm.requestPermission?.({ mode: 'read' })) ?? 'denied'
    if (state !== 'granted') return null
    const file = await rec.handle.getFile()
    const data = new Uint8Array(await file.arrayBuffer())
    return { name: rec.handle.name || rec.name, data, handle: rec.handle }
  } catch {
    // File moved or deleted — forget this entry.
    await putRecents(list.filter((_, i) => i !== index))
    return null
  }
}

/** Forget all recent projects. */
export async function clearRecentProjects(): Promise<void> {
  await putRecents([])
}

async function isSameEntry(a: WebFileHandle, b: WebFileHandle): Promise<boolean> {
  const pa = a as unknown as PermissionedHandle
  try {
    return pa.isSameEntry ? await pa.isSameEntry(b) : a.name === b.name
  } catch {
    return a.name === b.name
  }
}

async function getRecents(): Promise<RecentRecord[]> {
  const db = await openDb()
  const list = await new Promise<RecentRecord[]>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).get(RECENT_KEY)
    req.onsuccess = () => resolve(Array.isArray(req.result) ? (req.result as RecentRecord[]) : [])
    req.onerror = () => reject(req.error)
  })
  db.close()
  return list
}

async function putRecents(list: RecentRecord[]): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(list, RECENT_KEY)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
  db.close()
}
