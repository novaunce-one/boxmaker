import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { detectFace, findSeedTriangle, rebindFace } from '@core/faces'
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
  /** Set when a de-etch drag finishes so the trailing `click` doesn't re-pick a face. */
  private suppressClick = false
  private readonly selectionDiv: HTMLDivElement

  /** Fired when the user clicks a face. */
  onPickFace: ((face: FacePlane) => void) | null = null
  /** Fired when the picked face is deselected (click it again, or Escape). */
  onDeselectFace: (() => void) | null = null
  /** Fired when the user rubber-band-selects a region on the picked face. */
  onSelectRegion: ((face: FacePlane, rect: Rect2) => void) | null = null

  constructor(private readonly container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
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
    // Lighting: a key light that follows the camera (so relief is always
    // shaded from the viewer's side), plus soft sky/ground fill. A single fixed
    // light left engraved recesses flat and unreadable from most angles.
    const headlight = new THREE.DirectionalLight(0xffffff, 2.2)
    headlight.position.set(0.6, 0.4, 1) // camera space: up-right of the view axis
    this.camera.add(headlight, headlight.target)
    headlight.target.position.set(0, 0, -1)
    this.scene.add(
      this.camera,
      new THREE.HemisphereLight(0xffffff, 0x555560, 0.9),
      this.modelGroup,
      this.highlightGroup
    )

    const el = this.renderer.domElement
    el.addEventListener('click', (e) => this.handleClick(e))
    el.addEventListener('pointerdown', (e) => this.onPointerDown(e))
    el.addEventListener('pointermove', (e) => this.onPointerMove(e))
    window.addEventListener('pointerup', (e) => this.onPointerUp(e))
    this.resize()
    // Track the container itself (not just the window) so the drawing buffer
    // always matches its on-screen size; a stale buffer is stretched and blurry.
    new ResizeObserver(() => this.resize()).observe(this.container)
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

  /** The piece's mesh with de-etch fills applied (what cuts run on), or undefined. */
  baseMesh(pieceId: number): IndexedMesh | undefined {
    return this.pieces.get(pieceId)?.base
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
    // A click that ends a rubber-band drag is not a pick.
    if (this.suppressClick) {
      this.suppressClick = false
      return
    }
    if (!this.onPickFace || this.pieces.size === 0) return
    const hit = this.raycast(e)
    if (!hit || !hit.face) return
    const pieceId = (hit.object as THREE.Mesh).userData.pieceId as number
    const entry = this.pieces.get(pieceId)
    if (!entry) return
    // The mesh on screen may be a de-etched or cut version of the piece, whose
    // triangle numbering differs from `entry.original` (which FacePlanes index).
    // Map the hit position back onto the original so face identity stays stable.
    const seed = findSeedTriangle(
      entry.original,
      [hit.face.normal.x, hit.face.normal.y, hit.face.normal.z],
      [hit.point.x, hit.point.y, hit.point.z]
    )
    if (seed < 0) return
    // Clicking the already-selected face toggles it off.
    if (this.pickedFace && this.pickedFace.pieceId === pieceId && this.pickedFace.triangles.includes(seed)) {
      this.clearSelection()
      return
    }
    const face = detectFace(entry.original, seed, pieceId)
    this.pickedFace = face
    this.refreshHighlight()
    this.onPickFace(face)
  }

  /**
   * Draw the picked face's highlight on the mesh as currently shown. A face is
   * detected on the original piece, where an etching is a hole in the coplanar
   * region — so highlighting that directly would keep outlining the etching
   * even after it was de-etched. Re-derive the face on the de-etched base mesh
   * (the fill makes the region contiguous again) and highlight that instead.
   */
  private refreshHighlight(): void {
    const face = this.pickedFace
    if (!face) return
    const entry = this.pieces.get(face.pieceId)
    if (!entry) return
    const shown = entry.base === entry.original ? face : rebindFace(entry.base, face)
    this.highlightFace(entry.base, shown)
  }

  /** Deselect the picked face: drop the highlight and notify the app. */
  clearSelection(): void {
    if (!this.pickedFace) return
    this.pickedFace = null
    this.highlightGroup.clear()
    this.onDeselectFace?.()
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
    this.suppressClick = false // drop a stale flag (e.g. drag released off-canvas)
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
    // A press-and-release without real movement is a click: let it pick a new
    // face (handled by the `click` event) instead of selecting a region.
    const moved = Math.hypot(e.clientX - rectEl.left - start.x, e.clientY - rectEl.top - start.y)
    if (moved < DRAG_THRESHOLD_PX) return
    this.suppressClick = true
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
    this.refreshHighlight() // follow de-etch fills / undo / redo
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

/** Pointer travel (px) below which a de-etch press is treated as a click-to-pick. */
const DRAG_THRESHOLD_PX = 4

/** Edges sharper than this stay crisp; shallower ones are smoothed (curves, hinge barrels). */
const CREASE_ANGLE_DEG = 35

/**
 * Non-indexed geometry with crease-aware normals. Plain `computeVertexNormals()`
 * on the welded mesh averages normals across every sharp edge, which blurs
 * engraved edges and flat faces into a mushy gradient and hides fine detail.
 * Triangle order is preserved, so raycast `faceIndex` still equals the core
 * mesh triangle index (face picking relies on this).
 */
function toGeometry(mesh: IndexedMesh): THREE.BufferGeometry {
  const { vertices, indices } = mesh
  const triCount = indices.length / 3
  const vtxCount = vertices.length / 3

  // Area-weighted face normals (unnormalized cross product) + unit copies.
  const faceN = new Float32Array(triCount * 3)
  const faceU = new Float32Array(triCount * 3)
  for (let t = 0; t < triCount; t++) {
    const a = indices[t * 3] * 3,
      b = indices[t * 3 + 1] * 3,
      c = indices[t * 3 + 2] * 3
    const ux = vertices[b] - vertices[a],
      uy = vertices[b + 1] - vertices[a + 1],
      uz = vertices[b + 2] - vertices[a + 2]
    const vx = vertices[c] - vertices[a],
      vy = vertices[c + 1] - vertices[a + 1],
      vz = vertices[c + 2] - vertices[a + 2]
    const nx = uy * vz - uz * vy,
      ny = uz * vx - ux * vz,
      nz = ux * vy - uy * vx
    const len = Math.hypot(nx, ny, nz) || 1
    faceN[t * 3] = nx
    faceN[t * 3 + 1] = ny
    faceN[t * 3 + 2] = nz
    faceU[t * 3] = nx / len
    faceU[t * 3 + 1] = ny / len
    faceU[t * 3 + 2] = nz / len
  }

  // vertex -> incident triangles (CSR layout).
  const start = new Uint32Array(vtxCount + 1)
  for (let i = 0; i < indices.length; i++) start[indices[i] + 1]++
  for (let v = 0; v < vtxCount; v++) start[v + 1] += start[v]
  const fill = start.slice(0, vtxCount)
  const incident = new Uint32Array(indices.length)
  for (let t = 0; t < triCount; t++) {
    for (let k = 0; k < 3; k++) incident[fill[indices[t * 3 + k]]++] = t
  }

  const cosCrease = Math.cos((CREASE_ANGLE_DEG * Math.PI) / 180)
  const positions = new Float32Array(triCount * 9)
  const normals = new Float32Array(triCount * 9)
  for (let t = 0; t < triCount; t++) {
    for (let k = 0; k < 3; k++) {
      const vi = indices[t * 3 + k]
      const o = t * 9 + k * 3
      positions[o] = vertices[vi * 3]
      positions[o + 1] = vertices[vi * 3 + 1]
      positions[o + 2] = vertices[vi * 3 + 2]
      let sx = 0,
        sy = 0,
        sz = 0
      for (let j = start[vi]; j < start[vi + 1]; j++) {
        const n = incident[j]
        const dot =
          faceU[t * 3] * faceU[n * 3] + faceU[t * 3 + 1] * faceU[n * 3 + 1] + faceU[t * 3 + 2] * faceU[n * 3 + 2]
        if (dot >= cosCrease) {
          sx += faceN[n * 3]
          sy += faceN[n * 3 + 1]
          sz += faceN[n * 3 + 2]
        }
      }
      const len = Math.hypot(sx, sy, sz)
      if (len > 0) {
        normals[o] = sx / len
        normals[o + 1] = sy / len
        normals[o + 2] = sz / len
      } else {
        normals[o] = faceU[t * 3]
        normals[o + 1] = faceU[t * 3 + 1]
        normals[o + 2] = faceU[t * 3 + 2]
      }
    }
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
  return geo
}

function surfaceMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color: 0xb9c0c7, metalness: 0.1, roughness: 0.8 })
}
