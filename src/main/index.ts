import { app, shell, BrowserWindow, Menu, ipcMain, dialog, type MenuItemConstructorOptions } from 'electron'
import { basename, join } from 'path'
import { readFile, writeFile } from 'fs/promises'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { Channels, type MenuCommand, type ProjectFile, type SaveResult, type StlFile } from '../shared/api'

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
    autoHideMenuBar: false, // keep the File menu visible on Windows/Linux
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

/**
 * Application menu. File → Open / Save / Save As forward to the renderer, which
 * owns the project state. There is deliberately no Edit → Undo/Redo role: the
 * renderer's own Cmd/Ctrl+Z history must receive those keys, not the webview's.
 */
function buildMenu(): void {
  const isMac = process.platform === 'darwin'
  const send =
    (command: MenuCommand) =>
    (): void => {
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      win?.webContents.send(Channels.menuCommand, command)
    }

  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' } as MenuItemConstructorOptions] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open Project…', accelerator: 'CmdOrCtrl+O', click: send('open-project') },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: send('save-project') },
        { label: 'Save As…', accelerator: 'Shift+CmdOrCtrl+S', click: send('save-project-as') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    // Clipboard roles so Cmd/Ctrl+C/V work in the numeric fields.
    { label: 'Edit', submenu: [{ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { role: 'viewMenu' },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/** Register the IPC handlers that back the preload `BoxmakerApi`. */
function registerIpc(): void {
  const openStlDialog = async (title: string): Promise<StlFile | null> => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title,
      properties: ['openFile'],
      filters: [{ name: 'STL', extensions: ['stl'] }]
    })
    if (canceled || filePaths.length === 0) return null
    const path = filePaths[0]
    const data = await readFile(path)
    return { name: path.split(/[\\/]/).pop() ?? 'model.stl', data: new Uint8Array(data) }
  }

  ipcMain.handle(Channels.openStl, (): Promise<StlFile | null> => openStlDialog('Open STL'))

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

  // Paths the user picked in a native dialog this session. The renderer may only
  // overwrite these silently (Save), never an arbitrary path (NFR-SEC-1).
  const grantedProjectPaths = new Set<string>()
  const PROJECT_FILTER = { name: 'boxmaker project', extensions: ['boxmaker'] }

  ipcMain.handle(Channels.openProject, async (): Promise<ProjectFile | null> => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: 'Open project',
      properties: ['openFile'],
      filters: [PROJECT_FILTER]
    })
    if (canceled || filePaths.length === 0) return null
    const filePath = filePaths[0]
    const data = await readFile(filePath)
    grantedProjectPaths.add(filePath)
    return { name: basename(filePath), filePath, data: new Uint8Array(data) }
  })

  ipcMain.handle(
    Channels.saveProject,
    async (_evt, suggestedName: string, data: Uint8Array, filePath?: string): Promise<SaveResult> => {
      let target = filePath && grantedProjectPaths.has(filePath) ? filePath : undefined
      if (!target) {
        const res = await dialog.showSaveDialog({
          title: 'Save project',
          defaultPath: suggestedName,
          filters: [PROJECT_FILTER]
        })
        if (res.canceled || !res.filePath) return { canceled: true }
        target = res.filePath
        if (!/\.boxmaker$/i.test(target)) target += '.boxmaker'
      }
      await writeFile(target, Buffer.from(data))
      grantedProjectPaths.add(target)
      return { canceled: false, filePath: target }
    }
  )

  ipcMain.handle(Channels.loadTemplate, async (): Promise<StlFile | null> => {
    try {
      const data = await readFile(templatePath())
      return { name: 'template.stl', data: new Uint8Array(data) }
    } catch (err) {
      // No bundled template yet (resources/template.stl not supplied): let the
      // user choose one rather than failing the IPC call.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      return openStlDialog('Choose the template STL (no bundled template found)')
    }
  })
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.lornthomas.boxmaker')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  registerIpc()
  buildMenu()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
