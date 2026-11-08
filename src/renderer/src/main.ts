import './assets/main.css'
import { Viewer } from '@ui/viewer'
import { Controls } from '@ui/controls'
import { PlacementEditor, createCenteredPlacement } from '@ui/placement-editor'
import { initManifold } from '@core/manifold'
import { parseBinaryStl } from '@core/stl'
import { weldVertices, connectedComponents } from '@core/components'
import { History } from '@core/history'
import { applyProject } from '@core/engrave'
import { prepareForExport } from '@core/export'
import { MIN_WALL_MM } from '@core/types'
import {
  EMPTY_PROJECT,
  cloneProjectState,
  type FacePlane,
  type ImageSource,
  type MeshPiece,
  type ProjectState,
  type Rect2
} from '@core/types'
import { pickFile, downloadZip, saveLastTemplate, loadLastTemplate } from './web-io'
import type { StlFile } from '@shared/api'

async function bootstrap(): Promise<void> {
  await initManifold() // WASM kernel must be ready before any cut/export

  const viewport = document.querySelector<HTMLElement>('#viewport')!
  const controlsRoot = document.querySelector<HTMLElement>('#controls')!
  const editorRoot = document.querySelector<HTMLElement>('#editor')!

  const viewer = new Viewer(viewport)
  const history = new History<ProjectState>(EMPTY_PROJECT)

  let pieces: MeshPiece[] = []
  let currentFace: FacePlane | null = null

  const editor = new PlacementEditor(editorRoot, {
    onChange: (placements) => {
      if (!currentFace) return
      const next = cloneProjectState(history.state)
      faceWorkFor(next, currentFace).placements = placements
      history.push(next)
      applyState(next)
    }
  })

  const applyState = (state: ProjectState): void => {
    viewer.renderPreview(state)
    controls.setHistoryState(history.canUndo, history.canRedo)
    // Keep an open editor in sync with undo/redo and external additions.
    const active = editor.activeFace
    if (active) {
      const fw = state.faces.find(
        (f) => f.face.pieceId === active.pieceId && f.face.triangles[0] === active.triangles[0]
      )
      editor.setPlacements(fw ? fw.placements : [])
    }
  }

  /** Weld + split an STL file into pieces, show it, and reset the project. */
  const loadModel = (file: StlFile): void => {
    const welded = weldVertices(parseBinaryStl(file.data.buffer))
    pieces = connectedComponents(welded)
    viewer.setModel(pieces)
    currentFace = null
    controls.setFacePicked(false)
    controls.setModelLoaded(true)
    history.reset(EMPTY_PROJECT)
    applyState(history.state)
  }

  const controls = new Controls(controlsRoot, {
    onLoadTemplate: async () => {
      const file = await loadTemplate()
      loadModel(file)
      if (!window.boxmaker) void saveLastTemplate(file) // FR-LOAD-2 persistence
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
    onRedo: () => applyState(history.redo()),
    onExport: () => exportModel()
  })

  /** Assemble → repair → validate → save (desktop .stl / browser .zip). */
  async function exportModel(): Promise<void> {
    if (pieces.length === 0) return
    const { pieces: finalPieces, warnings: cutWarnings } = applyProject(pieces, history.state)
    const result = prepareForExport(finalPieces, { minClearanceMm: MIN_WALL_MM })
    const notes = [...cutWarnings, ...result.warnings]
    if (result.repaired.length) notes.unshift(`Repaired: ${result.repaired.join(', ')}.`)
    if (notes.length) {
      const proceed = window.confirm(`Export notes:\n\n${notes.join('\n')}\n\nSave anyway?`)
      if (!proceed) return
    }
    const data = new Uint8Array(result.stl)
    if (window.boxmaker) await window.boxmaker.saveStl('boxmaker.stl', data)
    else downloadZip('boxmaker.stl', data)
  }

  viewer.onPickFace = (face) => {
    currentFace = face
    const piece = pieces.find((p) => p.id === face.pieceId)
    const fw = history.state.faces.find(
      (f) => f.face.pieceId === face.pieceId && f.face.triangles[0] === face.triangles[0]
    )
    if (piece) editor.open(face, piece.mesh, fw ? fw.placements : [], history.state.marginMm)
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

  // Browser build: restore the last-loaded template from IndexedDB (FR-LOAD-2).
  if (!window.boxmaker) {
    loadLastTemplate()
      .then((file) => file && loadModel(file))
      .catch((err) => console.warn('template restore failed:', err))
  }

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
  const { name, buffer } = await pickFile('.stl,model/stl')
  return { name, data: new Uint8Array(buffer) }
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
