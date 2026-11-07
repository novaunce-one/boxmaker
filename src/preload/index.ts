import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import { Channels, type BoxmakerApi } from '../shared/api'

// The only surface the renderer gets. Each method is a thin pass-through to an
// IPC handler registered in the main process (src/main/index.ts).
const api: BoxmakerApi = {
  openStl: () => ipcRenderer.invoke(Channels.openStl),
  saveStl: (fileName, data) => ipcRenderer.invoke(Channels.saveStl, fileName, data),
  loadTemplate: () => ipcRenderer.invoke(Channels.loadTemplate)
}

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('electron', electronAPI)
  contextBridge.exposeInMainWorld('boxmaker', api)
} else {
  // @ts-expect-error — only reached if contextIsolation is disabled (it isn't).
  window.electron = electronAPI
  // @ts-expect-error — see above.
  window.boxmaker = api
}
