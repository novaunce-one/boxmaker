import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

// Cursor is Electron-based and may pass this flag to integrated terminals.
// Remove it so the spawned app runs as Electron rather than plain Node.js.
delete process.env.ELECTRON_RUN_AS_NODE

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@core': resolve('src/renderer/src/core'),
        '@ui': resolve('src/renderer/src/ui'),
        '@shared': resolve('src/shared')
      }
    }
  }
})
