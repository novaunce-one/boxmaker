import './assets/main.css'
import { Viewer } from '@ui/viewer'
import { Controls } from '@ui/controls'
import { PlacementEditor, createCenteredPlacement } from '@ui/placement-editor'
import { initManifold } from '@core/manifold'
import { parseBinaryStl } from '@core/stl'
import { weldVertices, connectedComponents } from '@core/components'
import { History } from '@core/history'
import {
  EMPTY_PROJECT,
  cloneProjectState,
  type FacePlane,
  type ImageSource,
  type MeshPiece,
  type ProjectState,
  type Rect2
} from '@core/types'
import type { StlFile } from '@shared/api'

async function bootstrap(): Promise<void> {
  await initManifold() // WASM kernel must be ready before any cut/export

  const viewport = document.querySelector<HTMLElement>('#viewport')!
  const controlsRoot = document.querySelector<HTMLElement>('#controls')!
  const editorRoot = document.querySelector<HTMLElement>('#editor')!

  const viewer = new Viewer(viewport)
  const editor = new PlacementEditor(editorRoot)
  const history = new History<ProjectState>(EMPTY_PROJECT)

  let pieces: MeshPiece[] = []
  let currentFace: FacePlane | null = null

  const applyState = (state: ProjectState): void => {
    viewer.renderPreview(state)
    controls.setHistoryState(history.canUndo, history.canRedo)
  }

  const controls = new Controls(controlsRoot, {
    onLoadTemplate: async () => {
      const file = await loadTemplate()
      const welded = weldVertices(parseBinaryStl(file.data.buffer))
      pieces = connectedComponents(welded)
      viewer.setModel(pieces)
      currentFace = null
      controls.setFacePicked(false)
      history.reset(EMPTY_PROJECT)
      applyState(history.state)
    },
    onAddImage: async (file) => {
      if (!currentFace) return
      const image = await decodeImage(file)
      const next = cloneProjectState(history.state)
      faceWorkFor(next, currentFace).placements.push(createCenteredPlacement(image))
      history.push(next)
      applyState(next)
    },
    onPreviewModeChange: (mode) => {
      viewer.setPreviewMode(mode)
      applyState(history.state)
    },
    onDeEtchModeChange: (on) => viewer.setDeEtchMode(on),
    onUndo: () => applyState(history.undo()),
    onRedo: () => applyState(history.redo())
  })

  viewer.onPickFace = (face) => {
    currentFace = face
    editor.open(face)
    controls.setFacePicked(true)
  }

  // Rubber-band de-etch: fill the selected etched area flush → smooth.
  viewer.onSelectRegion = (face, rect: Rect2) => {
    const next = cloneProjectState(history.state)
    smoothWorkFor(next, face).rects.push(rect)
    history.push(next)
    applyState(next)
  }

  controls.render()
  viewer.start()

  // Undo/redo accelerators: Cmd/Ctrl+Z, Shift+Cmd/Ctrl+Z (or Ctrl+Y).
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
}

/** Find the FaceWork for `face` in `state`, creating it if absent. */
function faceWorkFor(state: ProjectState, face: FacePlane): ProjectState['faces'][number] {
  const existing = state.faces.find(
    (fw) => fw.face.pieceId === face.pieceId && fw.face.triangles[0] === face.triangles[0]
  )
  if (existing) return existing
  const fw = { face, placements: [] }
  state.faces.push(fw)
  return fw
}

/** Find the SmoothWork for `face` in `state`, creating it if absent. */
function smoothWorkFor(state: ProjectState, face: FacePlane): ProjectState['smoothed'][number] {
  const existing = state.smoothed.find(
    (sw) => sw.face.pieceId === face.pieceId && sw.face.triangles[0] === face.triangles[0]
  )
  if (existing) return existing
  const sw = { face, rects: [] }
  state.smoothed.push(sw)
  return sw
}

/** Use the Electron bridge when present; otherwise a browser file picker. */
async function loadTemplate(): Promise<StlFile> {
  if (window.boxmaker) return window.boxmaker.loadTemplate()
  const buffer = await pickFile('.stl,model/stl')
  return { name: 'model.stl', data: new Uint8Array(buffer) }
}

/** Open a browser file dialog and resolve the chosen file's bytes. */
function pickFile(accept: string): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.addEventListener('change', () => {
      const file = input.files?.[0]
      if (!file) return reject(new Error('No file selected'))
      file.arrayBuffer().then(resolve, reject)
    })
    input.click()
  })
}

/** Decode an image file to raw RGBA pixels. */
async function decodeImage(file: File): Promise<ImageSource> {
  const bmp = await createImageBitmap(file)
  const canvas = document.createElement('canvas')
  canvas.width = bmp.width
  canvas.height = bmp.height
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(bmp, 0, 0)
  const { data } = ctx.getImageData(0, 0, bmp.width, bmp.height)
  return { width: bmp.width, height: bmp.height, rgba: data }
}

bootstrap().catch((err) => {
  console.error(err)
  document.body.innerHTML = `<pre style="padding:1rem;color:#c00">${String(err)}</pre>`
})
