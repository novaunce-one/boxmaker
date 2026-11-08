import { resolve } from 'path'
import { defineConfig } from 'vite'

/**
 * Standalone browser build of the renderer — no Electron. `main.ts` falls back
 * to a file-picker (open), IndexedDB (template persistence), and a `.zip`
 * download (export) when `window.boxmaker` is absent, so the whole app runs in a
 * plain browser. Used by `npm run dev:web` / `build:web` / `preview:web`.
 *
 * electron-vite's own config (electron.vite.config.ts) stays the source of truth
 * for the desktop build; this only mirrors the renderer's aliases. The
 * 'wasm-unsafe-eval' CSP token manifold-3d needs lives in index.html, so it
 * applies to both builds.
 */
export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  resolve: {
    alias: {
      '@renderer': resolve(__dirname, 'src/renderer/src'),
      '@core': resolve(__dirname, 'src/renderer/src/core'),
      '@ui': resolve(__dirname, 'src/renderer/src/ui'),
      '@shared': resolve(__dirname, 'src/shared')
    }
  },
  server: { port: 5173, open: false },
  build: { outDir: resolve(__dirname, 'out/web'), emptyOutDir: true }
})
