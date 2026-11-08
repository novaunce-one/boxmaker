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

/** A project file chosen in the open dialog. */
export interface ProjectFile {
  /** Base file name, e.g. `lid-test.boxmaker`. */
  name: string
  /** Absolute path; pass back to `saveProject` to overwrite it (Save). */
  filePath: string
  data: Uint8Array
}

/** IPC channel names, kept in one place so main and preload agree. */
export const Channels = {
  openStl: 'stl:open',
  saveStl: 'stl:save',
  loadTemplate: 'template:load',
  openProject: 'project:open',
  saveProject: 'project:save',
  menuCommand: 'menu:command'
} as const

/** Actions the native File menu asks the renderer to perform. */
export type MenuCommand = 'open-project' | 'save-project' | 'save-project-as'

/**
 * The API surfaced to the renderer via `contextBridge`. In the browser-only
 * build a web shim implements the same interface (file input + .zip download).
 */
export interface BoxmakerApi {
  /** Open a native file dialog and return the chosen STL, or null if cancelled. */
  openStl(): Promise<StlFile | null>
  /** Open a save dialog and write `data` as a .stl file. */
  saveStl(fileName: string, data: Uint8Array): Promise<SaveResult>
  /**
   * Load the bundled template jewelry-box STL shipped with the app. If no
   * template is bundled (resources/template.stl absent), falls back to an
   * open-file dialog. Resolves null if the user cancels that dialog.
   */
  loadTemplate(): Promise<StlFile | null>
  /** Open a native dialog and return the chosen `.boxmaker` project, or null if cancelled. */
  openProject(): Promise<ProjectFile | null>
  /**
   * Write a project file. With `filePath` (one previously returned by
   * `openProject`/`saveProject`) it overwrites that file silently (Save);
   * without it a save dialog is shown (Save As / first save).
   */
  saveProject(suggestedName: string, data: Uint8Array, filePath?: string): Promise<SaveResult>
  /** Subscribe to native File-menu commands. Returns an unsubscribe function. */
  onMenuCommand(handler: (command: MenuCommand) => void): () => void
}
