import { toBinaryMask } from '@core/image-trace'
import { wallThickness } from '@core/engrave'
import { maskToRgba } from './preview-overlay'
import {
  DEFAULT_CUT,
  MIN_WALL_MM,
  type FacePlane,
  type ImageSource,
  type IndexedMesh,
  type Placement,
  type Rect2,
  type Vec2
} from '@core/types'

/**
 * The 2D placement editor (docs/PLAN.md §3, SPEC §2.4 FR-EDIT / §2.5 FR-CUT).
 *
 * Shows the picked face's outline and the margin inset, and each placed image as
 * a draggable / aspect-locked-resizable / rotatable box with a live thresholded
 * mask preview. Equivalent numeric mm / degree entry and the per-placement cut
 * controls sit beside it. Artwork is clamped so its (rotated) bounding box never
 * crosses the margin inset (FR-EDIT-5). Each committed gesture emits `onChange`
 * so the caller can push one undo entry (FR-UNDO-2).
 *
 * The editor works in the face's (u, v) millimetre frame; the on-screen y axis
 * is +v (up), matching the 3D view, via an explicit uv↔pixel mapping.
 */

export interface EditorCallbacks {
  /** A gesture (drag/resize/rotate) or numeric/cut edit finished. */
  onChange: (placements: Placement[]) => void
}

const SIZE_PX = 320 // editor canvas long edge
const HANDLE = 7 // handle radius in px
const ROT_ARM = 22 // rotate-handle distance above the box, px
/** Depth slider ceiling when no wall can be measured under the image (nothing to cap against). */
const UNMEASURED_MAX_DEPTH_MM = 5

type Mode = { kind: 'drag' | 'rotate' } | { kind: 'resize'; corner: Vec2 }

export class PlacementEditor {
  private face: FacePlane | null = null
  private placements: Placement[] = []
  private marginMm = 2
  private selected = -1

  // Face (u,v) view window and uv→px scale, computed on open().
  private view = { minU: 0, maxU: 1, minV: 0, maxV: 1 }
  private scale = 1
  private bbox: Rect2 = { min: [0, 0], max: [1, 1] }

  private svg!: SVGSVGElement
  private list!: HTMLElement
  private fields!: HTMLElement
  private active: Mode | null = null

  // Wall-thickness lookup for the depth limit. Ray-casting the whole mesh is
  // costly, so results are cached per placement geometry and never recomputed
  // mid-drag (the last value is reused until the gesture ends).
  private wallMesh: IndexedMesh | null = null
  private wallCache = new Map<string, number>()
  private lastWall = Infinity

  constructor(
    private readonly root: HTMLElement,
    private readonly cb: EditorCallbacks
  ) {
    this.build()
  }

  /**
   * Open the editor for a face, seeding a working copy of its placements.
   * `wallMesh` is the mesh the cut will actually run on (original + de-etch
   * fills); it defaults to `mesh`.
   */
  open(
    face: FacePlane,
    mesh: IndexedMesh,
    placements: Placement[],
    marginMm: number,
    wallMesh: IndexedMesh = mesh
  ): void {
    this.face = face
    this.marginMm = marginMm
    this.placements = placements.map(clonePlacement)
    this.setWallMesh(wallMesh)
    this.bbox = faceBBox(mesh, face)
    this.computeView()
    this.selected = this.placements.length ? this.placements.length - 1 : -1
    this.root.hidden = false
    this.render()
  }

  /** Update the mesh used to measure wall thickness (e.g. after a de-etch fill). */
  setWallMesh(mesh: IndexedMesh): void {
    if (mesh === this.wallMesh) return
    this.wallMesh = mesh
    this.wallCache.clear()
  }

  /**
   * Smallest wall thickness under `pl` (Infinity if unmeasurable). Cached; during
   * a drag/resize/rotate gesture the previous value is returned instead of
   * re-casting rays on every pointer move.
   */
  private wallFor(pl: Placement): number {
    const key = [pl.center[0], pl.center[1], pl.size[0], pl.size[1], pl.rotation].map((n) => n.toFixed(3)).join('|')
    const cached = this.wallCache.get(key)
    if (cached !== undefined) return (this.lastWall = cached)
    if (this.active || !this.wallMesh || !this.face) return this.lastWall
    const wall = wallThickness(this.wallMesh, this.face, pl)
    if (this.wallCache.size > 200) this.wallCache.clear()
    this.wallCache.set(key, wall)
    return (this.lastWall = wall)
  }

  /** Refresh placements without emitting onChange (undo/redo, external add). */
  setPlacements(placements: Placement[]): void {
    if (!this.face) return
    this.placements = placements.map(clonePlacement)
    if (this.selected >= this.placements.length) this.selected = this.placements.length - 1
    this.render()
  }

  close(): void {
    this.face = null
    this.root.hidden = true
  }

  get activeFace(): FacePlane | null {
    return this.face
  }

  // --- layout -------------------------------------------------------------

  private build(): void {
    this.svg = document.createElementNS(SVG, 'svg') as SVGSVGElement
    this.svg.classList.add('editor-svg')
    this.svg.addEventListener('pointerdown', (e) => this.onPointerDown(e))
    window.addEventListener('pointermove', (e) => this.onPointerMove(e))
    window.addEventListener('pointerup', () => this.onPointerUp())

    this.list = document.createElement('div')
    this.list.className = 'editor-list'
    this.fields = document.createElement('div')
    this.fields.className = 'editor-fields'

    const header = document.createElement('div')
    header.className = 'editor-head'
    header.textContent = 'Placement'
    const closeBtn = document.createElement('button')
    closeBtn.textContent = '×'
    closeBtn.title = 'Close editor'
    closeBtn.addEventListener('click', () => this.close())
    header.appendChild(closeBtn)

    this.root.replaceChildren(header, this.svg, this.list, this.fields)
  }

  private computeView(): void {
    const w = this.bbox.max[0] - this.bbox.min[0]
    const h = this.bbox.max[1] - this.bbox.min[1]
    const pad = Math.max(w, h) * 0.15 + 1
    this.view = {
      minU: this.bbox.min[0] - pad,
      maxU: this.bbox.max[0] + pad,
      minV: this.bbox.min[1] - pad,
      maxV: this.bbox.max[1] + pad
    }
    const vw = this.view.maxU - this.view.minU
    const vh = this.view.maxV - this.view.minV
    this.scale = SIZE_PX / Math.max(vw, vh)
    this.svg.setAttribute('width', String(vw * this.scale))
    this.svg.setAttribute('height', String(vh * this.scale))
    this.svg.setAttribute('viewBox', `0 0 ${vw * this.scale} ${vh * this.scale}`)
  }

  private uvToPx(u: number, v: number): [number, number] {
    return [(u - this.view.minU) * this.scale, (this.view.maxV - v) * this.scale]
  }

  private pxToUv(x: number, y: number): [number, number] {
    return [this.view.minU + x / this.scale, this.view.maxV - y / this.scale]
  }

  // --- rendering ----------------------------------------------------------

  private render(): void {
    if (!this.face) return
    while (this.svg.firstChild) this.svg.removeChild(this.svg.firstChild)

    // Face outline (projected triangles) + margin inset rectangle.
    const [bx, by] = this.uvToPx(this.bbox.min[0], this.bbox.max[1])
    const bw = (this.bbox.max[0] - this.bbox.min[0]) * this.scale
    const bh = (this.bbox.max[1] - this.bbox.min[1]) * this.scale
    this.svg.appendChild(rect(bx, by, bw, bh, 'editor-face'))
    const m = this.marginMm
    const [ix, iy] = this.uvToPx(this.bbox.min[0] + m, this.bbox.max[1] - m)
    const iw = Math.max(0, (this.bbox.max[0] - this.bbox.min[0] - 2 * m) * this.scale)
    const ih = Math.max(0, (this.bbox.max[1] - this.bbox.min[1] - 2 * m) * this.scale)
    this.svg.appendChild(rect(ix, iy, iw, ih, 'editor-inset'))

    this.placements.forEach((pl, i) => this.svg.appendChild(this.renderPlacement(pl, i)))
    this.renderList()
    this.renderFields()
  }

  private renderPlacement(pl: Placement, index: number): SVGGElement {
    const g = document.createElementNS(SVG, 'g') as SVGGElement
    const [cx, cy] = this.uvToPx(pl.center[0], pl.center[1])
    // +v is up on screen, so a CCW uv rotation is CW in px → negate degrees.
    const deg = (-pl.rotation * 180) / Math.PI
    g.setAttribute('transform', `translate(${cx} ${cy}) rotate(${deg})`)
    g.dataset.index = String(index)

    const w = pl.size[0] * this.scale
    const h = pl.size[1] * this.scale
    const img = document.createElementNS(SVG, 'image') as SVGImageElement
    img.setAttribute('x', String(-w / 2))
    img.setAttribute('y', String(-h / 2))
    img.setAttribute('width', String(w))
    img.setAttribute('height', String(h))
    img.setAttribute('href', maskDataUrl(pl))
    img.setAttribute('preserveAspectRatio', 'none')
    img.dataset.role = 'body' // dragging the picture itself moves it
    g.appendChild(img)

    const frame = rect(-w / 2, -h / 2, w, h, index === this.selected ? 'editor-box sel' : 'editor-box')
    frame.dataset.role = 'body'
    g.appendChild(frame)

    if (index === this.selected) {
      // Resize handles at the four corners (aspect-locked), rotate handle above.
      const corners: Vec2[] = [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1]
      ]
      for (const [sx, sy] of corners) {
        const hc = handle((sx * w) / 2, (sy * h) / 2, 'editor-handle')
        hc.dataset.role = 'resize'
        hc.dataset.cornerX = String(sx)
        hc.dataset.cornerY = String(sy)
        g.appendChild(hc)
      }
      const rh = handle(0, -h / 2 - ROT_ARM, 'editor-rot')
      rh.dataset.role = 'rotate'
      g.appendChild(rh)
    }
    return g
  }

  private renderList(): void {
    this.list.replaceChildren()
    this.placements.forEach((pl, i) => {
      const row = document.createElement('div')
      row.className = 'editor-row' + (i === this.selected ? ' sel' : '')
      const label = document.createElement('span')
      label.textContent = `Image ${i + 1} (${pl.image.width}×${pl.image.height})`
      label.addEventListener('click', () => {
        this.selected = i
        this.render()
      })
      const del = document.createElement('button')
      del.textContent = 'Delete'
      del.addEventListener('click', () => {
        this.placements.splice(i, 1)
        this.selected = Math.min(this.selected, this.placements.length - 1)
        this.render()
        this.commit()
      })
      row.append(label, del)
      this.list.appendChild(row)
    })
  }

  private renderFields(): void {
    this.fields.replaceChildren()
    const pl = this.placements[this.selected]
    if (!pl) return
    const aspect = pl.size[0] / pl.size[1]
    const commitNum = (set: (v: number) => void) => (v: number) => {
      set(v)
      this.clamp(pl)
      this.render()
      this.commit()
    }
    this.fields.append(
      numField('Center u (mm)', pl.center[0], commitNum((v) => (pl.center = [v, pl.center[1]]))),
      numField('Center v (mm)', pl.center[1], commitNum((v) => (pl.center = [pl.center[0], v]))),
      numField('Width (mm)', pl.size[0], commitNum((v) => (pl.size = [Math.max(0.1, v), Math.max(0.1, v) / aspect]))),
      numField('Rotation (°)', (pl.rotation * 180) / Math.PI, commitNum((v) => (pl.rotation = (v * Math.PI) / 180))),
      this.depthControl(pl),
      numField('Threshold', pl.cut.threshold, commitNum((v) => (pl.cut.threshold = clamp(v, 0, 255)))),
      numField('Smoothing (mm)', pl.cut.smoothing, commitNum((v) => (pl.cut.smoothing = Math.max(0, v)))),
      boolField('Invert', pl.cut.invert, (b) => {
        pl.cut.invert = b
        this.render()
        this.commit()
      })
    )
  }

  /**
   * Depth slider + number + "Max", limited to what the wall allows: the measured
   * wall under the image minus MIN_WALL_MM, so the cut can never go through
   * (FR-HINGE-3, FR-CUT-3). Entry is clamped to that limit; moving the image
   * onto a thinner spot leaves the stored depth alone but the note says what will
   * actually be cut (the engraver applies the same cap).
   */
  private depthControl(pl: Placement): HTMLElement {
    const wall = this.wallFor(pl)
    const measured = Number.isFinite(wall)
    const maxDepth = measured ? Math.max(0, Math.floor((wall - MIN_WALL_MM) * 100) / 100) : UNMEASURED_MAX_DEPTH_MM

    const wrap = document.createElement('div')
    wrap.className = 'editor-depth'
    const title = document.createElement('div')
    title.className = 'editor-depth-title'
    title.textContent = 'Depth (mm)'

    const slider = document.createElement('input')
    slider.type = 'range'
    slider.min = '0'
    slider.max = String(maxDepth)
    slider.step = '0.01'
    slider.value = String(Math.min(pl.cut.depth, maxDepth))
    slider.disabled = maxDepth <= 0

    const num = document.createElement('input')
    num.type = 'number'
    num.min = '0'
    num.max = String(maxDepth)
    num.step = 'any'
    num.value = String(round(pl.cut.depth))

    const maxBtn = document.createElement('button')
    maxBtn.textContent = 'Max'
    maxBtn.title = 'Cut as deep as the wall safely allows'
    maxBtn.disabled = maxDepth <= 0

    const note = document.createElement('div')
    note.className = 'editor-note'
    const refreshNote = (): void => {
      const over = pl.cut.depth > maxDepth + 1e-6
      note.classList.toggle('warn', over || (measured && maxDepth <= 0))
      if (measured && maxDepth <= 0) {
        note.textContent = `Wall here is ${wall.toFixed(2)} mm — too thin to cut (must leave ${MIN_WALL_MM} mm).`
      } else if (!measured) {
        note.textContent = 'No wall measured under this image; depth is not limited.'
      } else {
        note.textContent =
          `Wall here ${wall.toFixed(2)} mm · max depth ${maxDepth.toFixed(2)} mm (leaves ${MIN_WALL_MM} mm).` +
          (over ? ` Will be cut at ${maxDepth.toFixed(2)} mm.` : '')
      }
    }
    refreshNote()

    // Live while scrubbing; one undo entry when released.
    slider.addEventListener('input', () => {
      pl.cut.depth = Number(slider.value)
      num.value = String(round(pl.cut.depth))
      refreshNote()
    })
    slider.addEventListener('change', () => this.commit())
    num.addEventListener('change', () => {
      const v = Number(num.value)
      if (!Number.isFinite(v)) return
      pl.cut.depth = clamp(v, 0, maxDepth)
      this.render()
      this.commit()
    })
    maxBtn.addEventListener('click', () => {
      pl.cut.depth = maxDepth
      this.render()
      this.commit()
    })

    const row = document.createElement('div')
    row.className = 'editor-depth-row'
    row.append(slider, num, maxBtn)
    wrap.append(title, row, note)
    return wrap
  }

  // --- interaction --------------------------------------------------------

  private onPointerDown(e: PointerEvent): void {
    const target = e.target as SVGElement
    const role = target.dataset.role
    const group = target.closest('g[data-index]') as SVGGElement | null
    if (group) this.selected = Number(group.dataset.index)
    if (role === 'rotate') this.active = { kind: 'rotate' }
    else if (role === 'resize')
      this.active = { kind: 'resize', corner: [Number(target.dataset.cornerX), Number(target.dataset.cornerY)] }
    else if (role === 'body') this.active = { kind: 'drag' }
    else {
      this.active = null
      this.render()
      return
    }
    e.preventDefault()
    this.render()
  }

  private onPointerMove(e: PointerEvent): void {
    if (!this.active) return
    const pl = this.placements[this.selected]
    if (!pl) return
    const rect = this.svg.getBoundingClientRect()
    const [u, v] = this.pxToUv(e.clientX - rect.left, e.clientY - rect.top)
    const du = u - pl.center[0]
    const dv = v - pl.center[1]

    if (this.active.kind === 'drag') {
      pl.center = [u, v] // pointer grabs the box center (simple, predictable)
    } else if (this.active.kind === 'rotate') {
      // Handle sits along local +v; angle it toward the pointer (CCW in uv).
      pl.rotation = Math.atan2(-du, dv)
    } else {
      // Aspect-locked resize about the fixed center: project onto local axes.
      const c = Math.cos(pl.rotation)
      const s = Math.sin(pl.rotation)
      const lx = du * c + dv * s // local u
      const ly = -du * s + dv * c // local v
      const aspect = pl.size[0] / pl.size[1]
      const factor = Math.max((Math.abs(lx) * 2) / pl.size[0], (Math.abs(ly) * 2) / pl.size[1])
      pl.size = [Math.max(0.2, pl.size[0] * factor), Math.max(0.2, pl.size[0] * factor) / aspect]
    }
    this.clamp(pl)
    this.render()
  }

  private onPointerUp(): void {
    if (!this.active) return
    this.active = null
    this.commit()
  }

  /** Keep a placement's rotated bounding box inside the margin inset (FR-EDIT-5). */
  private clamp(pl: Placement): void {
    const c = Math.abs(Math.cos(pl.rotation))
    const s = Math.abs(Math.sin(pl.rotation))
    const hw = (c * pl.size[0] + s * pl.size[1]) / 2
    const hh = (s * pl.size[0] + c * pl.size[1]) / 2
    const minU = this.bbox.min[0] + this.marginMm
    const maxU = this.bbox.max[0] - this.marginMm
    const minV = this.bbox.min[1] + this.marginMm
    const maxV = this.bbox.max[1] - this.marginMm
    pl.center = [clampRange(pl.center[0], minU + hw, maxU - hw), clampRange(pl.center[1], minV + hh, maxV - hh)]
  }

  private commit(): void {
    this.cb.onChange(this.placements.map(clonePlacement))
  }
}

/**
 * Build a centered placement for an image on a face: aspect-preserving default
 * size, no rotation, default cut settings (SPEC §2.5 FR-CUT-1).
 */
export function createCenteredPlacement(image: ImageSource, longEdgeMm = 30): Placement {
  const aspect = image.width / image.height
  const size: Vec2 = aspect >= 1 ? [longEdgeMm, longEdgeMm / aspect] : [longEdgeMm * aspect, longEdgeMm]
  return { center: [0, 0], size, rotation: 0, image, cut: { ...DEFAULT_CUT } }
}

// --- helpers --------------------------------------------------------------

const SVG = 'http://www.w3.org/2000/svg'

/** Face triangles projected to the (u,v) plane → axis-aligned bounds. */
function faceBBox(mesh: IndexedMesh, face: FacePlane): Rect2 {
  let minU = Infinity,
    minV = Infinity,
    maxU = -Infinity,
    maxV = -Infinity
  for (const t of face.triangles) {
    for (let k = 0; k < 3; k++) {
      const vi = mesh.indices[t * 3 + k]
      const dx = mesh.vertices[vi * 3] - face.origin[0]
      const dy = mesh.vertices[vi * 3 + 1] - face.origin[1]
      const dz = mesh.vertices[vi * 3 + 2] - face.origin[2]
      const u = dx * face.u[0] + dy * face.u[1] + dz * face.u[2]
      const v = dx * face.v[0] + dy * face.v[1] + dz * face.v[2]
      if (u < minU) minU = u
      if (u > maxU) maxU = u
      if (v < minV) minV = v
      if (v > maxV) maxV = v
    }
  }
  return { min: [minU, minV], max: [maxU, maxV] }
}

/**
 * Mask data URLs keyed by image identity + threshold/invert. The editor
 * re-renders on every pointer move while dragging; without this each frame would
 * re-threshold and re-encode the whole image.
 */
const maskCache = new WeakMap<ImageSource, Map<string, string>>()

/** The thresholded mask of a placement as a data URL for the live preview. */
function maskDataUrl(pl: Placement): string {
  const key = `${pl.cut.threshold}|${pl.cut.invert}`
  let perImage = maskCache.get(pl.image)
  if (!perImage) maskCache.set(pl.image, (perImage = new Map()))
  let url = perImage.get(key)
  if (url === undefined) {
    url = renderMaskDataUrl(pl)
    if (perImage.size >= 8) perImage.clear() // bound memory while a slider is scrubbed
    perImage.set(key, url)
  }
  return url
}

function renderMaskDataUrl(pl: Placement): string {
  const mask = toBinaryMask(pl.image, pl.cut)
  const img = maskToRgba(mask, [20, 20, 20], 235)
  const canvas = document.createElement('canvas')
  canvas.width = img.width
  canvas.height = img.height
  const ctx = canvas.getContext('2d')!
  const data = ctx.createImageData(img.width, img.height)
  data.data.set(img.data)
  ctx.putImageData(data, 0, 0)
  return canvas.toDataURL()
}

function clonePlacement(p: Placement): Placement {
  return {
    center: [p.center[0], p.center[1]],
    size: [p.size[0], p.size[1]],
    rotation: p.rotation,
    image: p.image,
    cut: { ...p.cut }
  }
}

function rect(x: number, y: number, w: number, h: number, cls: string): SVGRectElement {
  const r = document.createElementNS(SVG, 'rect') as SVGRectElement
  r.setAttribute('x', String(x))
  r.setAttribute('y', String(y))
  r.setAttribute('width', String(w))
  r.setAttribute('height', String(h))
  r.setAttribute('class', cls)
  return r
}

function handle(x: number, y: number, cls: string): SVGCircleElement {
  const c = document.createElementNS(SVG, 'circle') as SVGCircleElement
  c.setAttribute('cx', String(x))
  c.setAttribute('cy', String(y))
  c.setAttribute('r', String(HANDLE))
  c.setAttribute('class', cls)
  return c
}

function numField(label: string, value: number, onChange: (v: number) => void): HTMLElement {
  const wrap = document.createElement('label')
  wrap.className = 'editor-field'
  wrap.append(document.createTextNode(label))
  const input = document.createElement('input')
  input.type = 'number'
  input.step = 'any'
  input.value = String(round(value))
  input.addEventListener('change', () => {
    const v = Number(input.value)
    if (Number.isFinite(v)) onChange(v)
  })
  wrap.appendChild(input)
  return wrap
}

function boolField(label: string, value: boolean, onChange: (v: boolean) => void): HTMLElement {
  const wrap = document.createElement('label')
  wrap.className = 'editor-field check'
  const input = document.createElement('input')
  input.type = 'checkbox'
  input.checked = value
  input.addEventListener('change', () => onChange(input.checked))
  wrap.append(input, document.createTextNode(label))
  return wrap
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))
const clampRange = (v: number, lo: number, hi: number): number => (lo > hi ? (lo + hi) / 2 : clamp(v, lo, hi))
const round = (v: number): number => Math.round(v * 100) / 100
