import './assets/main.css'
import { Viewer } from '@ui/viewer'
import { Controls } from '@ui/controls'
import { PlacementEditor, createCenteredPlacement } from '@ui/placement-editor'
import { initManifold } from '@core/manifold'
import { parseBinaryStl } from '@core/stl'
import { weldVertices, connectedComponents } from '@core/components'
import { sameFace } from '@core/faces'
import { trimToContent } from '@core/image-trace'
import { History } from '@core/history'
import { applyProject } from '@core/engrave'
import { prepareForExport } from '@core/export'
import { applyExportScale, measureExactGap, scaleMeshes } from '@core/scale-export'
import {
  DEFAULT_CUT,
  EMPTY_PROJECT,
  MIN_CLEARANCE_MM,
  MIN_WALL_MM,
  cloneProjectState,
  type FacePlane,
  type ImageSource,
  type IndexedMesh,
  type MeshPiece,
  type ProjectState,
  type Rect2
} from '@core/types'
import {
  checkProjectFits,
  deserializeProject,
  serializeProject,
  PROJECT_EXTENSION
} from '@core/project-file'
import {
  pickFile,
  downloadZip,
  saveLastTemplate,
  loadLastTemplate,
  openProjectFile,
  saveProjectFile,
  type WebFileHandle
} from './web-io'
import { encodeImagePng, decodeImagePng } from './image-codec'
import type { StlFile } from '@shared/api'

/** Where the open project lives, so Save can overwrite it (Save As picks anew). */
interface ProjectRef {
  name: string
  /** Desktop: absolute path granted by a native dialog. */
  filePath?: string
  /** Browser (Chromium): File System Access handle. */
  handle?: WebFileHandle
}

const baseName = (p: string): string => p.split(/[\\/]/).pop() ?? p

async function bootstrap(): Promise<void> {
  await initManifold() // WASM kernel must be ready before any cut/export

  const viewport = document.querySelector<HTMLElement>('#viewport')!
  const controlsRoot = document.querySelector<HTMLElement>('#controls')!
  const editorRoot = document.querySelector<HTMLElement>('#editor')!

  const viewer = new Viewer(viewport)
  const history = new History<ProjectState>(EMPTY_PROJECT)

  let pieces: MeshPiece[] = []
  let currentFace: FacePlane | null = null
  let templateFile: StlFile | null = null // embedded in saved projects
  let projectRef: ProjectRef | null = null
  let savedState: ProjectState = EMPTY_PROJECT // state at last open/save/load
  let templateSize: [number, number, number] | null = null // outer size (mm) at 100%
  /** Exact gap between the template's pieces: undefined = not measured yet, null = none. */
  let templateGap: number | null | undefined

  const editor = new PlacementEditor(editorRoot, {
    onChange: (placements) => {
      if (!currentFace) return
      const next = cloneProjectState(history.state)
      faceWorkFor(next, currentFace).placements = placements
      history.push(next)
      applyState(next)
    }
  })

  const isDirty = (): boolean => templateFile !== null && history.state !== savedState

  /** Window title: `• name — boxmaker` (bullet = unsaved changes). */
  const updateTitle = (): void => {
    const name = projectRef?.name ?? (templateFile ? 'Untitled' : '')
    document.title = name ? `${isDirty() ? '• ' : ''}${name} — boxmaker` : 'boxmaker'
  }

  /** Ask before an action that would throw away unsaved edits. */
  const confirmDiscard = (): boolean =>
    !isDirty() || window.confirm('You have unsaved changes. Discard them and continue?')

  const applyState = (state: ProjectState): void => {
    viewer.renderPreview(state)
    controls.setHistoryState(history.canUndo, history.canRedo)
    controls.setExportSettings(state.exportScale, state.hingeGapMm)
    controls.setSizeInfo(templateSize, state.exportScale)
    updateTitle()
    // Keep an open editor in sync with undo/redo and external additions.
    const active = editor.activeFace
    if (active) {
      // The wall limit must be measured on the mesh the cut runs on (with de-etch fills).
      const base = viewer.baseMesh(active.pieceId)
      if (base) editor.setWallMesh(base)
      editor.setNeighbours(otherMeshes(active.pieceId))
      const fw = state.faces.find((f) => sameFace(f.face, active))
      editor.setPlacements(fw ? fw.placements : [])
    }
  }

  /** Meshes of every piece except `pieceId` (obstacles for a raised image). */
  const otherMeshes = (pieceId: number): IndexedMesh[] => pieces.filter((p) => p.id !== pieceId).map((p) => p.mesh)

  /** Exact smallest gap between the template's pieces (null if it is a single piece / far apart). */
  const measureTemplateGap = (): number | null => {
    if (pieces.length < 2) return null
    const { minGap } = measureExactGap(pieces, 2)
    return Number.isFinite(minGap) ? minGap : null
  }

  /** Weld + split an STL file into pieces, show it, and reset the project. */
  const loadModel = (file: StlFile): void => {
    const welded = weldVertices(parseBinaryStl(file.data.buffer))
    pieces = connectedComponents(welded)
    viewer.setModel(pieces)
    currentFace = null
    editor.close()
    templateFile = file
    templateSize = boundsSize(pieces)
    // Measure the template's real hinge gap once (the default export target).
    templateGap = undefined
    controls.setTemplateGap(undefined)
    setTimeout(() => {
      if (templateFile !== file) return // another model was loaded meanwhile
      templateGap = measureTemplateGap()
      controls.setTemplateGap(templateGap)
    }, 0)
    projectRef = null // a fresh model is an untitled project
    controls.setFacePicked(false)
    controls.setModelLoaded(true)
    history.reset(EMPTY_PROJECT)
    savedState = history.state
    applyState(history.state)
  }

  /** Serialize the project and write it (desktop dialog / browser file or download). */
  async function saveProject(saveAs: boolean): Promise<void> {
    if (!templateFile) return
    try {
      const snapshot = history.state // what we save is what we mark clean
      const text = await serializeProject(
        { templateName: templateFile.name, template: templateFile.data, state: snapshot },
        encodeImagePng
      )
      const data = new TextEncoder().encode(text)
      const suggested =
        projectRef?.name ?? `${templateFile.name.replace(/\.stl$/i, '') || 'boxmaker'}.${PROJECT_EXTENSION}`

      if (window.boxmaker) {
        const res = await window.boxmaker.saveProject(suggested, data, saveAs ? undefined : projectRef?.filePath)
        if (res.canceled || !res.filePath) return
        projectRef = { name: baseName(res.filePath), filePath: res.filePath }
      } else {
        const res = await saveProjectFile(suggested, data, projectRef?.handle, saveAs)
        if (!res) return
        projectRef = { name: res.name, handle: res.handle }
      }
      savedState = snapshot
      updateTitle()
    } catch (err) {
      console.error(err)
      window.alert(`Could not save the project:\n\n${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** Pick a project, rebuild the model from its embedded template, restore its state. */
  async function openProject(): Promise<void> {
    if (!confirmDiscard()) return
    try {
      let bytes: Uint8Array
      let ref: ProjectRef
      if (window.boxmaker) {
        const file = await window.boxmaker.openProject()
        if (!file) return
        bytes = file.data
        ref = { name: file.name, filePath: file.filePath }
      } else {
        const file = await openProjectFile()
        if (!file) return
        bytes = file.data
        ref = { name: file.name, handle: file.handle }
      }
      const doc = await deserializeProject(new TextDecoder().decode(bytes), decodeImagePng)
      const template: StlFile = { name: doc.templateName, data: doc.template }
      loadModel(template)
      if (!window.boxmaker) void saveLastTemplate(template)
      const problem = checkProjectFits(pieces, doc.state)
      if (problem) {
        window.alert(`The project could not be restored:\n\n${problem}`)
        return // template stays loaded, project stays empty
      }
      history.reset(doc.state)
      savedState = history.state
      projectRef = ref
      applyState(history.state)
    } catch (err) {
      console.error(err)
      window.alert(`Could not open the project:\n\n${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const controls = new Controls(controlsRoot, {
    onOpenProject: () => openProject(),
    onSaveProject: () => saveProject(false),
    onSaveProjectAs: () => saveProject(true),
    onLoadTemplate: async () => {
      try {
        if (!confirmDiscard()) return
        const file = await loadTemplate()
        if (!file) return // user cancelled the picker
        loadModel(file)
        if (!window.boxmaker) void saveLastTemplate(file) // FR-LOAD-2 persistence
      } catch (err) {
        console.error(err)
        window.alert(`Could not load the template STL:\n\n${err instanceof Error ? err.message : String(err)}`)
      }
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
    onExport: () => exportModel(),
    onExportSettingsChange: (scale, hingeGapMm) => {
      const cur = history.state
      if (cur.exportScale === scale && cur.hingeGapMm === hingeGapMm) return
      const next = cloneProjectState(cur)
      next.exportScale = scale
      next.hingeGapMm = hingeGapMm
      history.push(next)
      applyState(next)
    }
  }, { fileMenu: !window.boxmaker })

  // Desktop: the native File menu (src/main/index.ts) drives these.
  window.boxmaker?.onMenuCommand((command) => {
    if (command === 'open-project') {
      void openProject()
      return
    }
    // Commit a half-typed number field first (its `change` fires on blur).
    if (document.activeElement instanceof HTMLInputElement) document.activeElement.blur()
    void saveProject(command === 'save-project-as')
  })

  /** Assemble → scale + restore hinge gap → repair → validate → save (desktop .stl / browser .zip). */
  async function exportModel(): Promise<void> {
    if (pieces.length === 0) return
    const state = history.state
    const scale = state.exportScale
    controls.setExportBusy(true)
    // Let the busy label paint: the geometry work below blocks the main thread.
    await new Promise((resolve) => setTimeout(resolve, 30))
    let data: Uint8Array
    try {
      // Wall guard in template units so walls are still ≥ MIN_WALL_MM once scaled.
      const { pieces: engraved, warnings: cutWarnings } = applyProject(pieces, state, MIN_WALL_MM / scale)

      // Re-open joint gaps the scaling shrank: to the user's gap, else the template's own.
      if (templateGap === undefined) templateGap = measureTemplateGap()
      const enforce = scale !== 1 || state.hingeGapMm !== null
      const target = enforce ? (state.hingeGapMm ?? templateGap ?? null) : null
      const scaled = applyExportScale(engraved, scale, target)

      const result = prepareForExport(scaled.pieces, {
        minClearanceMm: MIN_CLEARANCE_MM,
        reference: scale === 1 ? pieces : scaleMeshes(pieces, scale)
      })
      const notes = [...scaled.notes, ...cutWarnings, ...scaled.warnings, ...result.warnings]
      if (scale < 0.7) {
        notes.push('Below ~70%, hinge pins and thin walls shrink with the box and may print poorly.')
      }
      if (result.repaired.length) notes.unshift(`Repaired: ${result.repaired.join(', ')}.`)
      if (notes.length) {
        const proceed = window.confirm(`Export notes:\n\n${notes.join('\n')}\n\nSave anyway?`)
        if (!proceed) return
      }
      data = new Uint8Array(result.stl)
    } catch (err) {
      console.error(err)
      window.alert(`Export failed:\n\n${err instanceof Error ? err.message : String(err)}`)
      return
    } finally {
      controls.setExportBusy(false)
    }
    if (window.boxmaker) await window.boxmaker.saveStl('boxmaker.stl', data)
    else downloadZip('boxmaker.stl', data)
  }

  viewer.onPickFace = (picked) => {
    const piece = pieces.find((p) => p.id === picked.pieceId)
    const fw = history.state.faces.find((f) => sameFace(f.face, picked))
    // A face's origin is the centroid of the clicked (seed) triangle, so picking
    // the same face at a different spot yields a shifted frame. Editing saved
    // placements in that shifted frame would move them to the click point. When
    // the face already has work, reuse its stored frame so positions are kept.
    const face = fw ? fw.face : picked
    currentFace = face
    if (piece) {
      editor.setNeighbours(otherMeshes(face.pieceId))
      editor.open(
        face,
        piece.mesh,
        fw ? fw.placements : [],
        history.state.marginMm,
        viewer.baseMesh(face.pieceId) ?? piece.mesh
      )
    }
    controls.setFacePicked(true)
  }

  // Deselect (click the picked face again, or Escape): close the editor and
  // disable the face-dependent controls (also turns de-etch mode off).
  viewer.onDeselectFace = () => {
    currentFace = null
    editor.close()
    controls.setFacePicked(false)
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
  // Guard against clobbering: if the user already loaded a template or opened a
  // project before this async read resolves, do NOT overwrite their state.
  if (!window.boxmaker) {
    loadLastTemplate()
      .then((file) => {
        if (file && templateFile === null) loadModel(file)
      })
      .catch((err) => console.warn('template restore failed:', err))
  }

  // Undo/redo accelerators: Cmd/Ctrl+Z, Shift+Cmd/Ctrl+Z (or Ctrl+Y).
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && currentFace) {
      const t = e.target as HTMLElement | null
      if (!t || !/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) viewer.clearSelection()
      return
    }
    const mod = e.metaKey || e.ctrlKey
    if (!mod) return
    const key = e.key.toLowerCase()
    // Cmd/Ctrl+S/O: on desktop the native menu owns these accelerators.
    if (!window.boxmaker && (key === 's' || key === 'o')) {
      e.preventDefault() // also suppresses the browser's own "save page" / open
      if (key === 'o') {
        void openProject()
      } else {
        // Commit a half-typed number field first (its `change` fires on blur).
        if (document.activeElement instanceof HTMLInputElement) document.activeElement.blur()
        void saveProject(e.shiftKey)
      }
    } else if (key === 'z') {
      e.preventDefault()
      applyState(e.shiftKey ? history.redo() : history.undo())
    } else if (key === 'y') {
      e.preventDefault()
      applyState(history.redo())
    }
  })
}

/** Find the FaceWork for `face` in `state`, creating it if absent. */
/** Width × depth × height (mm) of all pieces' combined bounding box. */
function boundsSize(pieces: MeshPiece[]): [number, number, number] | null {
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (const p of pieces) {
    const v = p.mesh.vertices
    for (let i = 0; i < v.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        if (v[i + k] < min[k]) min[k] = v[i + k]
        if (v[i + k] > max[k]) max[k] = v[i + k]
      }
    }
  }
  if (!Number.isFinite(min[0])) return null
  return [max[0] - min[0], max[1] - min[1], max[2] - min[2]]
}

function faceWorkFor(state: ProjectState, face: FacePlane): ProjectState['faces'][number] {
  const existing = state.faces.find((fw) => sameFace(fw.face, face))
  if (existing) return existing
  const fw = { face, placements: [] }
  state.faces.push(fw)
  return fw
}

/** Find the SmoothWork for `face` in `state`, creating it if absent. */
function smoothWorkFor(state: ProjectState, face: FacePlane): ProjectState['smoothed'][number] {
  const existing = state.smoothed.find((sw) => sameFace(sw.face, face))
  if (existing) return existing
  const sw = { face, rects: [] }
  state.smoothed.push(sw)
  return sw
}

/** Use the Electron bridge when present; otherwise a browser file picker. */
async function loadTemplate(): Promise<StlFile | null> {
  if (window.boxmaker) return window.boxmaker.loadTemplate()
  const { name, buffer } = await pickFile('.stl,model/stl')
  return { name, data: new Uint8Array(buffer) }
}

/** Decode an image file to raw RGBA pixels, trimmed to its artwork bounds. */
async function decodeImage(file: File): Promise<ImageSource> {
  const bmp = await createImageBitmap(file)
  const canvas = document.createElement('canvas')
  canvas.width = bmp.width
  canvas.height = bmp.height
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(bmp, 0, 0)
  const { data } = ctx.getImageData(0, 0, bmp.width, bmp.height)
  // Crop the empty margin so the placement box matches the visible image.
  return trimToContent({ width: bmp.width, height: bmp.height, rgba: data }, DEFAULT_CUT)
}

bootstrap().catch((err) => {
  console.error(err)
  document.body.innerHTML = `<pre style="padding:1rem;color:#c00">${String(err)}</pre>`
})
