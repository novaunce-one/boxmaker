/**
 * Shared, typed contract for the preload bridge.
 *
 * Both the Electron main process (which implements the IPC handlers) and the
 * renderer (which consumes `window.boxmaker`) import these types, so the two
 * ends can never drift. See the "Electron structure" section of docs/PLAN.md.
 */

/** A loaded STL: raw bytes plus the originating file name (for display/export). */
export interface StlFile {
  name: string
  /** Binary STL contents. Transferred over IPC as a structured-clone copy. */
  data: Uint8Array
}

/** Result of a save dialog + write. */
export interface SaveResult {
  canceled: boolean
  filePath?: string
}

/** IPC channel names, kept in one place so main and preload agree. */
export const Channels = {
  openStl: 'stl:open',
  saveStl: 'stl:save',
  loadTemplate: 'template:load'
} as const

/**
 * The API surfaced to the renderer via `contextBridge`. In the browser-only
 * build a web shim implements the same interface (file input + .zip download).
 */
export interface BoxmakerApi {
  /** Open a native file dialog and return the chosen STL, or null if cancelled. */
  openStl(): Promise<StlFile | null>
  /** Open a save dialog and write `data` as a .stl file. */
  saveStl(fileName: string, data: Uint8Array): Promise<SaveResult>
  /** Load the bundled template jewelry-box STL shipped with the app. */
  loadTemplate(): Promise<StlFile>
}
