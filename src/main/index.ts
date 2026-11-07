import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { join } from 'path'
import { readFile, writeFile } from 'fs/promises'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { Channels, type SaveResult, type StlFile } from '../shared/api'

/** Absolute path to the bundled template STL (packaged into resources/). */
function templatePath(): string {
  // `process.resourcesPath` points at the asar-unpacked resources dir in a
  // packaged app; in dev we read straight from the repo's resources/ folder.
  return is.dev
    ? join(__dirname, '../../resources/template.stl')
    : join(process.resourcesPath, 'resources/template.stl')
}

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    title: 'boxmaker',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // The renderer stays isolated and without Node integration, per the plan.
      // `sandbox: false` is required so the preload bridge can use ipcRenderer.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow.show())

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for the renderer in dev; the built index.html in production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/** Register the IPC handlers that back the preload `BoxmakerApi`. */
function registerIpc(): void {
  ipcMain.handle(Channels.openStl, async (): Promise<StlFile | null> => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: 'Open STL',
      properties: ['openFile'],
      filters: [{ name: 'STL', extensions: ['stl'] }]
    })
    if (canceled || filePaths.length === 0) return null
    const path = filePaths[0]
    const data = await readFile(path)
    return { name: path.split(/[\\/]/).pop() ?? 'model.stl', data: new Uint8Array(data) }
  })

  ipcMain.handle(
    Channels.saveStl,
    async (_evt, fileName: string, data: Uint8Array): Promise<SaveResult> => {
      const { canceled, filePath } = await dialog.showSaveDialog({
        title: 'Export STL',
        defaultPath: fileName,
        filters: [{ name: 'STL', extensions: ['stl'] }]
      })
      if (canceled || !filePath) return { canceled: true }
      await writeFile(filePath, Buffer.from(data))
      return { canceled: false, filePath }
    }
  )

  ipcMain.handle(Channels.loadTemplate, async (): Promise<StlFile> => {
    const path = templatePath()
    const data = await readFile(path)
    return { name: 'template.stl', data: new Uint8Array(data) }
  })
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.lornthomas.boxmaker')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  registerIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
