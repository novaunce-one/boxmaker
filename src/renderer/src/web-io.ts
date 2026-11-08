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
