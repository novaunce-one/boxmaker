import './assets/main.css'
import { Viewer } from '@ui/viewer'
import { Controls } from '@ui/controls'
import { PlacementEditor } from '@ui/placement-editor'
import { initManifold } from '@core/manifold'
import { parseBinaryStl } from '@core/stl'
import { History } from '@core/history'
import { EMPTY_PROJECT, type ProjectState } from '@core/types'
import type { StlFile } from '@shared/api'

async function bootstrap(): Promise<void> {
  // The WASM geometry kernel must be ready before any cut/export runs.
  await initManifold()

  const viewport = document.querySelector<HTMLElement>('#viewport')!
  const controlsRoot = document.querySelector<HTMLElement>('#controls')!
  const editorRoot = document.querySelector<HTMLElement>('#editor')!

  const viewer = new Viewer(viewport)
  const editor = new PlacementEditor(editorRoot)

  // Undo/redo over the editable project state (SPEC §2 FR-UNDO). Each committed
  // edit calls `history.push(nextState)`; undo/redo re-apply a snapshot.
  const history = new History<ProjectState>(EMPTY_PROJECT)
  const applyState = (state: ProjectState): void => {
    // TODO(stage1-step3/4): re-render placements + live preview from `state`.
    void state
    controls.setHistoryState(history.canUndo, history.canRedo)
  }

  const controls = new Controls(controlsRoot, {
    onLoadTemplate: async () => {
      const file = await loadTemplate()
      const mesh = parseBinaryStl(file.data.buffer)
      viewer.setTemplate(mesh)
      history.reset(EMPTY_PROJECT) // a fresh template starts a clean history
      applyState(history.state)
    },
    onUndo: () => applyState(history.undo()),
    onRedo: () => applyState(history.redo())
  })

  controls.render()
  viewer.start()

  // Standard undo/redo accelerators: Cmd/Ctrl+Z and Shift+Cmd/Ctrl+Z (or Ctrl+Y).
  window.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey
    if (!mod) return
    const key = e.key.toLowerCase()
    if (key === 'z') {
      e.preventDefault()
      applyState(e.shiftKey ? history.redo() : history.undo())
    } else if (key === 'y') {
      e.preventDefault()
      applyState(history.redo())
    }
  })

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
