import './assets/main.css'
import { Viewer } from '@ui/viewer'
import { Controls } from '@ui/controls'
import { PlacementEditor } from '@ui/placement-editor'
import { initManifold } from '@core/manifold'
import { parseBinaryStl } from '@core/stl'
import type { StlFile } from '@shared/api'

async function bootstrap(): Promise<void> {
  // The WASM geometry kernel must be ready before any cut/export runs.
  await initManifold()

  const viewport = document.querySelector<HTMLElement>('#viewport')!
  const controlsRoot = document.querySelector<HTMLElement>('#controls')!
  const editorRoot = document.querySelector<HTMLElement>('#editor')!

  const viewer = new Viewer(viewport)
  const editor = new PlacementEditor(editorRoot)
  const controls = new Controls(controlsRoot, {
    onLoadTemplate: async () => {
      const file = await loadTemplate()
      const mesh = parseBinaryStl(file.data.buffer)
      viewer.setTemplate(mesh)
    }
  })

  controls.render()
  viewer.start()
  // `editor` is wired up once a face is picked in the viewer (Stage 1, step 3).
  void editor
}

/** Use the Electron bridge when present; a web shim will fill this in later. */
async function loadTemplate(): Promise<StlFile> {
  if (window.boxmaker) return window.boxmaker.loadTemplate()
  throw new Error('No template source: running outside Electron and web loader not implemented yet.')
}

bootstrap().catch((err) => {
  console.error(err)
  document.body.innerHTML = `<pre style="padding:1rem;color:#c00">${String(err)}</pre>`
})
