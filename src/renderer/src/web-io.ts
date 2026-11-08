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
