import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { detectFace } from '@core/faces'
import { engraveFace, smoothRegion } from '@core/engrave'
import type { FacePlane, IndexedMesh, MeshPiece, PreviewMode, ProjectState, Rect2 } from '@core/types'
import { buildOverlayGroup } from './preview-overlay'

/**
 * The orbitable 3D view (docs/PLAN.md §3). Renders the box pieces, raycast-picks
 * a coplanar face, shows the live engraving preview in 'overlay' or 'cut' mode,
 * and supports a rubber-band region selection used to de-etch (smooth) an area
 * of an imported box. Z-up throughout. See SPEC §2 FR-VIEW / FR-DEETCH.
 */
export class Viewer {
  private readonly renderer: THREE.WebGLRenderer
  private readonly scene = new THREE.Scene()
  private readonly camera: THREE.PerspectiveCamera
  private readonly controls: OrbitControls
  private readonly raycaster = new THREE.Raycaster()

  private readonly modelGroup = new THREE.Group()
  private readonly highlightGroup = new THREE.Group()
  private overlayGroup: THREE.Group | null = null

  /** Per piece: THREE mesh, the original core mesh, and its smoothed base. */
  private pieces = new Map<number, { object: THREE.Mesh; original: IndexedMesh; base: IndexedMesh }>()
  private previewMode: PreviewMode = 'overlay'
  private cutTimer: ReturnType<typeof setTimeout> | null = null

  private pickedFace: FacePlane | null = null
  private deEtch = false
  private dragStart: { x: number; y: number } | null = null
  private readonly selectionDiv: HTMLDivElement

  /** Fired when the user clicks a face. */
  onPickFace: ((face: FacePlane) => void) | null = null
  /** Fired when the user rubber-band-selects a region on the picked face. */
  onSelectRegion: ((face: FacePlane, rect: Rect2) => void) | null = null

  constructor(private readonly container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true })
    this.renderer.setPixelRatio(window.devicePixelRatio)
    this.container.appendChild(this.renderer.domElement)

    this.selectionDiv = document.createElement('div')
    this.selectionDiv.className = 'selection-box'
    this.selectionDiv.style.display = 'none'
    this.container.appendChild(this.selectionDiv)

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 10000)
    this.camera.up.set(0, 0, 1) // Z-up — matches core/faces.ts basis math
    this.camera.position.set(120, -160, 120)

    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true

    this.scene.background = new THREE.Color(0x1e1f22)
    const key = new THREE.DirectionalLight(0xffffff, 2)
    key.position.set(1, -1, 1)
    this.scene.add(key, new THREE.AmbientLight(0xffffff, 0.6), this.modelGroup, this.highlightGroup)

    const el = this.renderer.domElement
    el.addEventListener('click', (e) => this.handleClick(e))
    el.addEventListener('pointerdown', (e) => this.onPointerDown(e))
    el.addEventListener('pointermove', (e) => this.onPointerMove(e))
    window.addEventListener('pointerup', (e) => this.onPointerUp(e))
    this.resize()
    window.addEventListener('resize', () => this.resize())
  }

  /** Load the box pieces (replaces any current model). */
  setModel(pieces: MeshPiece[]): void {
    this.clearModel()
    for (const p of pieces) {
      const object = new THREE.Mesh(toGeometry(p.mesh), surfaceMaterial())
      object.userData.pieceId = p.id
      this.pieces.set(p.id, { object, original: p.mesh, base: p.mesh })
      this.modelGroup.add(object)
    }
    this.fitCamera()
  }

  setPreviewMode(mode: PreviewMode): void {
    this.previewMode = mode
  }

  /** Toggle rubber-band de-etch selection (disables orbit while active). */
  setDeEtchMode(on: boolean): void {
    this.deEtch = on
    this.controls.enabled = !on
    this.renderer.domElement.style.cursor = on ? 'crosshair' : ''
  }

  /** Re-render the active preview from project state (every edit/undo/redo). */
  renderPreview(state: ProjectState): void {
    this.clearOverlay()
    this.applySmoothedBase(state) // fold de-etch into each piece's base geometry
    if (this.previewMode === 'overlay') {
      this.overlayGroup = buildOverlayGroup(state)
      this.scene.add(this.overlayGroup)
    } else {
      this.scheduleCut(state)
    }
  }

  start(): void {
    const loop = (): void => {
      this.controls.update()
      this.renderer.render(this.scene, this.camera)
      requestAnimationFrame(loop)
    }
    loop()
  }

  // --- picking ------------------------------------------------------------

  private handleClick(e: MouseEvent): void {
    if (this.deEtch || !this.onPickFace || this.pieces.size === 0) return
    const hit = this.raycast(e)
    if (!hit || hit.faceIndex == null) return
    const pieceId = (hit.object as THREE.Mesh).userData.pieceId as number
    const entry = this.pieces.get(pieceId)
    if (!entry) return
    const face = detectFace(entry.original, hit.faceIndex, pieceId)
    this.pickedFace = face
    this.highlightFace(entry.original, face)
    this.onPickFace(face)
  }

  private raycast(e: MouseEvent): THREE.Intersection | undefined {
    const rect = this.renderer.domElement.getBoundingClientRect()
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
    )
    this.raycaster.setFromCamera(ndc, this.camera)
    return this.raycaster.intersectObjects(this.modelGroup.children, false)[0]
  }

  private highlightFace(mesh: IndexedMesh, face: FacePlane): void {
    this.highlightGroup.clear()
    const pos = new Float32Array(face.triangles.length * 9)
    const off = 0.08
    face.triangles.forEach((t, i) => {
      for (let k = 0; k < 3; k++) {
        const vi = mesh.indices[t * 3 + k]
        pos[i * 9 + k * 3] = mesh.vertices[vi * 3] + face.normal[0] * off
        pos[i * 9 + k * 3 + 1] = mesh.vertices[vi * 3 + 1] + face.normal[1] * off
        pos[i * 9 + k * 3 + 2] = mesh.vertices[vi * 3 + 2] + face.normal[2] * off
      }
    })
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    this.highlightGroup.add(
      new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0x4f8cff, transparent: true, opacity: 0.35, side: THREE.DoubleSide }))
    )
  }

  // --- rubber-band de-etch selection -------------------------------------

  private onPointerDown(e: PointerEvent): void {
    if (!this.deEtch || !this.pickedFace) return
    const rect = this.renderer.domElement.getBoundingClientRect()
    this.dragStart = { x: e.clientX - rect.left, y: e.clientY - rect.top }
    Object.assign(this.selectionDiv.style, { display: 'block', left: `${this.dragStart.x}px`, top: `${this.dragStart.y}px`, width: '0px', height: '0px' })
  }

  private onPointerMove(e: PointerEvent): void {
    if (!this.dragStart) return
    const rect = this.renderer.domElement.getBoundingClientRect()
    const x = e.clientX - rect.left,
      y = e.clientY - rect.top
    Object.assign(this.selectionDiv.style, {
      left: `${Math.min(x, this.dragStart.x)}px`,
      top: `${Math.min(y, this.dragStart.y)}px`,
      width: `${Math.abs(x - this.dragStart.x)}px`,
      height: `${Math.abs(y - this.dragStart.y)}px`
    })
  }

  private onPointerUp(e: PointerEvent): void {
    if (!this.dragStart || !this.pickedFace) {
      this.dragStart = null
      return
    }
    this.selectionDiv.style.display = 'none'
    const start = this.dragStart
    this.dragStart = null
    const rectEl = this.renderer.domElement.getBoundingClientRect()
    const a = this.projectToFace(start.x, start.y, rectEl, this.pickedFace)
    const b = this.projectToFace(e.clientX - rectEl.left, e.clientY - rectEl.top, rectEl, this.pickedFace)
    if (!a || !b) return
    const rect: Rect2 = {
      min: [Math.min(a[0], b[0]), Math.min(a[1], b[1])],
      max: [Math.max(a[0], b[0]), Math.max(a[1], b[1])]
    }
    if (rect.max[0] - rect.min[0] < 1e-3 || rect.max[1] - rect.min[1] < 1e-3) return
    this.onSelectRegion?.(this.pickedFace, rect)
  }

  /** Screen pixel → (u,v) mm on the face plane, relative to face.origin. */
  private projectToFace(px: number, py: number, rect: DOMRect, face: FacePlane): [number, number] | null {
    const ndc = new THREE.Vector2((px / rect.width) * 2 - 1, -(py / rect.height) * 2 + 1)
    this.raycaster.setFromCamera(ndc, this.camera)
    const n = new THREE.Vector3(face.normal[0], face.normal[1], face.normal[2])
    const o = new THREE.Vector3(face.origin[0], face.origin[1], face.origin[2])
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, o)
    const hit = this.raycaster.ray.intersectPlane(plane, new THREE.Vector3())
    if (!hit) return null
    const d = hit.sub(o)
    return [
      d.x * face.u[0] + d.y * face.u[1] + d.z * face.u[2],
      d.x * face.v[0] + d.y * face.v[1] + d.z * face.v[2]
    ]
  }

  // --- preview helpers ----------------------------------------------------

  /** Recompute each piece's base mesh = original with all de-etch fills applied. */
  private applySmoothedBase(state: ProjectState): void {
    for (const [pieceId, entry] of this.pieces) {
      let piece: MeshPiece = { id: pieceId, mesh: entry.original }
      for (const sw of state.smoothed) {
        if (sw.face.pieceId !== pieceId) continue
        try {
          piece = smoothRegion(piece, sw.face, sw.rects, Math.max(2, state.marginMm)).piece
        } catch (err) {
          console.error('de-etch failed:', err)
        }
      }
      entry.base = piece.mesh
      entry.object.geometry.dispose()
      entry.object.geometry = toGeometry(piece.mesh)
    }
  }

  private scheduleCut(state: ProjectState): void {
    if (this.cutTimer) clearTimeout(this.cutTimer)
    this.cutTimer = setTimeout(() => this.renderCut(state), 150)
  }

  private renderCut(state: ProjectState): void {
    for (const fw of state.faces) {
      if (fw.placements.length === 0) continue
      const entry = this.pieces.get(fw.face.pieceId)
      if (!entry) continue
      try {
        const { piece } = engraveFace({ id: fw.face.pieceId, mesh: entry.base }, fw.face, fw.placements, state.marginMm)
        entry.object.geometry.dispose()
        entry.object.geometry = toGeometry(piece.mesh)
      } catch (err) {
        console.error('cut preview failed:', err)
      }
    }
  }

  private clearOverlay(): void {
    if (this.overlayGroup) {
      this.scene.remove(this.overlayGroup)
      this.overlayGroup = null
    }
  }

  private clearModel(): void {
    this.pieces.clear()
    this.modelGroup.clear()
    this.highlightGroup.clear()
    this.pickedFace = null
    this.clearOverlay()
  }

  private fitCamera(): void {
    const box = new THREE.Box3().setFromObject(this.modelGroup)
    if (box.isEmpty()) return
    const center = box.getCenter(new THREE.Vector3())
    const size = box.getSize(new THREE.Vector3()).length() || 1
    this.controls.target.copy(center)
    this.camera.position.copy(center).add(new THREE.Vector3(size, -size, size * 0.8))
    this.camera.near = size / 100
    this.camera.far = size * 100
    this.camera.updateProjectionMatrix()
    this.controls.update()
  }

  private resize(): void {
    const { clientWidth: w, clientHeight: h } = this.container
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / Math.max(1, h)
    this.camera.updateProjectionMatrix()
  }
}

function toGeometry(mesh: IndexedMesh): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(mesh.vertices), 3))
  geo.setIndex(new THREE.BufferAttribute(new Uint32Array(mesh.indices), 1))
  geo.computeVertexNormals()
  return geo
}

function surfaceMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color: 0xb9c0c7, metalness: 0.1, roughness: 0.8 })
}
