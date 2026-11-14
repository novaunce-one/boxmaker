import type { CutSettings, ImageSource, Placement, Vec2 } from './types'

/**
 * Image → binary mask → contours (docs/PLAN.md §4).
 *
 * The mask is downscaled so the long edge is ~`maxLongEdge` px before tracing,
 * keeping contour counts manageable for the geometry kernel.
 */

const DEFAULT_MAX_LONG_EDGE = 400

export interface BinaryMask {
  width: number
  height: number
  /** 1 = cut (inside), 0 = keep. Row-major. */
  bits: Uint8Array
}

/**
 * Crop an image to the bounding box of its artwork — pixels that are both cut
 * (per `cut`) and not transparent — trimming the empty white/transparent margin
 * around e.g. a logo. This makes a placement's size (and therefore the editor's
 * bounding box and its drag limits) match the visible image instead of the
 * original canvas. Returns the image unchanged when it has no content or already
 * fills the frame. `padPx` leaves a thin border so edge strokes aren't clipped.
 */
export function trimToContent(
  image: ImageSource,
  cut: Pick<CutSettings, 'threshold' | 'invert'>,
  padPx = 1
): ImageSource {
  const { width, height, rgba } = image
  let minX = width,
    minY = height,
    maxX = -1,
    maxY = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4
      const lum = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2]
      let cutHere = lum < cut.threshold
      if (cut.invert) cutHere = !cutHere
      if (cutHere && rgba[p + 3] > 16) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < minX || maxY < minY) return image // nothing would be cut — keep as-is
  minX = Math.max(0, minX - padPx)
  minY = Math.max(0, minY - padPx)
  maxX = Math.min(width - 1, maxX + padPx)
  maxY = Math.min(height - 1, maxY + padPx)
  const cw = maxX - minX + 1
  const ch = maxY - minY + 1
  if (cw === width && ch === height) return image // already tight
  const out = new Uint8ClampedArray(cw * ch * 4)
  for (let y = 0; y < ch; y++) {
    const srcStart = ((minY + y) * width + minX) * 4
    out.set(rgba.subarray(srcStart, srcStart + cw * 4), y * cw * 4)
  }
  return { width: cw, height: ch, rgba: out }
}

/** Grayscale + threshold (+ optional invert) → binary mask, with downscaling. */
export function toBinaryMask(
  image: ImageSource,
  cut: Pick<CutSettings, 'threshold' | 'invert'>,
  maxLongEdge = DEFAULT_MAX_LONG_EDGE
): BinaryMask {
  const scale = Math.min(1, maxLongEdge / Math.max(image.width, image.height))
  const width = Math.max(1, Math.round(image.width * scale))
  const height = Math.max(1, Math.round(image.height * scale))
  const bits = new Uint8Array(width * height)

  for (let y = 0; y < height; y++) {
    const sy = Math.min(image.height - 1, Math.floor(y / scale))
    for (let x = 0; x < width; x++) {
      const sx = Math.min(image.width - 1, Math.floor(x / scale))
      const p = (sy * image.width + sx) * 4
      // Rec. 601 luma.
      const lum = 0.299 * image.rgba[p] + 0.587 * image.rgba[p + 1] + 0.114 * image.rgba[p + 2]
      let cutHere = lum < cut.threshold
      if (cut.invert) cutHere = !cutHere
      bits[y * width + x] = cutHere ? 1 : 0
    }
  }
  return { width, height, bits }
}

/**
 * A traced ring of points in mask-pixel coordinates. Outer rings wind one way,
 * holes the other, so an EvenOdd fill rule reconstructs the solid regions.
 */
export type Contour = Vec2[]

/**
 * Trace `mask` into closed contours and return rings in normalized [0,1] space
 * (x right, y **up**) ready to scale into face mm.
 *
 * Method: marching squares by boundary-edge cancellation. Each cut pixel emits
 * its 4 unit edges wound CCW (A→B→C→D); edges shared by two cut pixels occur in
 * opposite directions and cancel, leaving only the region boundary as
 * consistently-oriented directed edges. Those are stitched into loops, and runs
 * of collinear points are merged so a rectangle yields 4 corners, not a long
 * staircase. Outer rings and holes both fall out; feed the result to a
 * CrossSection with the EvenOdd fill rule.
 */
export function traceContours(mask: BinaryMask, _smoothingMm = 0.1): Contour[] {
  const { width: w, height: h, bits } = mask
  const vid = (x: number, y: number): number => y * (w + 1) + x // grid-vertex id

  // Directed boundary edges as a per-vertex adjacency list. A vertex may have
  // two outgoing edges transiently (pinch points), so a list — not a single
  // successor — is required; shared internal edges cancel against their reverse.
  const adj = new Map<number, number[]>()
  const removeOne = (a: number, b: number): boolean => {
    const list = adj.get(a)
    if (!list) return false
    const i = list.indexOf(b)
    if (i < 0) return false
    list.splice(i, 1)
    return true
  }
  const addEdge = (ax: number, ay: number, bx: number, by: number): void => {
    const a = vid(ax, ay),
      b = vid(bx, by)
    if (removeOne(b, a)) return // cancel the shared internal edge
    let list = adj.get(a)
    if (!list) adj.set(a, (list = []))
    list.push(b)
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!bits[y * w + x]) continue
      // CCW in a y-down grid: A(x,y) → B(x,y+1) → C(x+1,y+1) → D(x+1,y) → A
      addEdge(x, y, x, y + 1)
      addEdge(x, y + 1, x + 1, y + 1)
      addEdge(x + 1, y + 1, x + 1, y)
      addEdge(x + 1, y, x, y)
    }
  }

  const px = (id: number): [number, number] => [id % (w + 1), Math.floor(id / (w + 1))]
  const contours: Contour[] = []
  for (const start of adj.keys()) {
    while ((adj.get(start)?.length ?? 0) > 0) {
      const loop: [number, number][] = []
      let cur = start
      while (true) {
        const list = adj.get(cur)
        if (!list || list.length === 0) break
        const next = list.pop() as number
        loop.push(px(cur))
        cur = next
        if (cur === start) break
      }
      if (loop.length >= 3) contours.push(normalizeRing(mergeCollinear(loop), w, h))
    }
  }
  return contours
}

/** Drop middle points of any collinear run (incl. wrap-around). */
function mergeCollinear(pts: [number, number][]): [number, number][] {
  const n = pts.length
  const out: [number, number][] = []
  for (let i = 0; i < n; i++) {
    const a = pts[(i - 1 + n) % n],
      b = pts[i],
      c = pts[(i + 1) % n]
    const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
    if (cross !== 0) out.push(b)
  }
  return out.length >= 3 ? out : pts
}

/** Grid coords → [0,1] with y flipped so the image reads upright (y up). */
function normalizeRing(pts: [number, number][], w: number, h: number): Contour {
  return pts.map(([x, y]) => [x / w, 1 - y / h] as Vec2)
}

// --- smooth (sub-pixel) tracing -------------------------------------------

/**
 * Smooth outlines (SPEC §2.7 FR-IMG-5).
 *
 * Tracing the binary mask follows pixel edges, so every outline is a staircase
 * (steps as wide as an image pixel — hundreds of µm for a low-res logo). Instead
 * we keep the grayscale: luminance → signed field (positive = artwork) → optional
 * Gaussian blur whose sigma is the user's smoothing in mm → marching squares with
 * linear interpolation along cell edges, which lands vertices at sub-pixel
 * positions. Pixel blocks blur into rounded curves and anti-aliased edges trace
 * exactly, so the result is smooth without hand-tuned polyline filtering.
 */

/** Signed scalar grid, row-major; artwork where value > 0. */
export interface ScalarField {
  width: number
  height: number
  values: Float32Array
}

/** Largest blur sigma, in field cells (keeps the kernel cheap). */
const MAX_SIGMA_CELLS = 12
/** Below this sigma (cells) blurring does nothing useful, so skip it. */
const MIN_SIGMA_CELLS = 0.25

/**
 * Luminance → signed field (`threshold − luma`, flipped by Invert), area-averaged
 * down so the long edge is ≤ `maxLongEdge`. Images smaller than that keep their
 * native resolution (interpolation and blur handle the rest).
 */
export function buildField(
  image: ImageSource,
  cut: Pick<CutSettings, 'threshold' | 'invert'>,
  maxLongEdge = DEFAULT_MAX_LONG_EDGE
): ScalarField {
  const scale = Math.min(1, maxLongEdge / Math.max(image.width, image.height))
  const width = Math.max(1, Math.round(image.width * scale))
  const height = Math.max(1, Math.round(image.height * scale))
  const values = new Float32Array(width * height)
  for (let y = 0; y < height; y++) {
    const y0 = Math.min(image.height - 1, Math.floor(y / scale))
    const y1 = Math.min(image.height, Math.max(y0 + 1, Math.floor((y + 1) / scale)))
    for (let x = 0; x < width; x++) {
      const x0 = Math.min(image.width - 1, Math.floor(x / scale))
      const x1 = Math.min(image.width, Math.max(x0 + 1, Math.floor((x + 1) / scale)))
      let sum = 0
      let n = 0
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const p = (sy * image.width + sx) * 4
          sum += 0.299 * image.rgba[p] + 0.587 * image.rgba[p + 1] + 0.114 * image.rgba[p + 2] // Rec. 601
          n++
        }
      }
      const lum = sum / n
      values[y * width + x] = cut.invert ? lum - cut.threshold : cut.threshold - lum
    }
  }
  return { width, height, values }
}

/** Separable Gaussian blur with clamp-to-edge borders. `sigma` is in cells. */
export function gaussianBlur(field: ScalarField, sigma: number): ScalarField {
  if (sigma < MIN_SIGMA_CELLS) return field
  const s = Math.min(sigma, MAX_SIGMA_CELLS)
  const radius = Math.ceil(s * 3)
  const kernel = new Float32Array(radius * 2 + 1)
  let total = 0
  for (let i = -radius; i <= radius; i++) {
    const k = Math.exp(-(i * i) / (2 * s * s))
    kernel[i + radius] = k
    total += k
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= total

  const { width: w, height: h } = field
  const tmp = new Float32Array(w * h)
  const out = new Float32Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0
      for (let i = -radius; i <= radius; i++) {
        const xx = Math.min(w - 1, Math.max(0, x + i))
        acc += field.values[y * w + xx] * kernel[i + radius]
      }
      tmp[y * w + x] = acc
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0
      for (let i = -radius; i <= radius; i++) {
        const yy = Math.min(h - 1, Math.max(0, y + i))
        acc += tmp[yy * w + x] * kernel[i + radius]
      }
      out[y * w + x] = acc
    }
  }
  return { width: w, height: h, values: out }
}

// Marching-squares segment table. Corner bits: a=TL(1) b=TR(2) c=BR(4) d=BL(8)
// (y-down); edges: T, R, B, L. Each pair is a directed segment [from, to] with
// the artwork on a consistent side, so shared edges chain segments into loops.
const T = 0,
  R = 1,
  B = 2,
  L = 3
const SEGMENTS: Record<number, [number, number][]> = {
  1: [[T, L]],
  2: [[R, T]],
  3: [[R, L]],
  4: [[B, R]],
  // 5 and 10 are saddles, resolved by the cell centre in `traceField`
  6: [[B, T]],
  7: [[B, L]],
  8: [[L, B]],
  9: [[T, B]],
  11: [[R, B]],
  12: [[L, R]],
  13: [[T, R]],
  14: [[L, T]]
}

/**
 * Marching squares with linear interpolation over `field`; returns closed rings
 * in the field's pixel coordinates (cell centres at x + 0.5). The field is padded
 * with one background cell so shapes touching the border still close.
 */
function traceField(field: ScalarField): [number, number][][] {
  const gw = field.width + 2
  const gh = field.height + 2
  const grid = new Float32Array(gw * gh).fill(-1)
  for (let y = 0; y < field.height; y++) {
    for (let x = 0; x < field.width; x++) grid[(y + 1) * gw + x + 1] = field.values[y * field.width + x]
  }

  // Edge ids: horizontal edge (x,y)–(x+1,y) = (y*gw+x)*2, vertical (x,y)–(x,y+1) = (y*gw+x)*2+1.
  const hId = (x: number, y: number): number => (y * gw + x) * 2
  const vId = (x: number, y: number): number => (y * gw + x) * 2 + 1
  const next = new Map<number, number>()

  for (let y = 0; y < gh - 1; y++) {
    for (let x = 0; x < gw - 1; x++) {
      const a = grid[y * gw + x] > 0
      const b = grid[y * gw + x + 1] > 0
      const c = grid[(y + 1) * gw + x + 1] > 0
      const d = grid[(y + 1) * gw + x] > 0
      const mask = (a ? 1 : 0) | (b ? 2 : 0) | (c ? 4 : 0) | (d ? 8 : 0)
      if (mask === 0 || mask === 15) continue

      let segs = SEGMENTS[mask]
      if (mask === 5 || mask === 10) {
        const centre =
          (grid[y * gw + x] + grid[y * gw + x + 1] + grid[(y + 1) * gw + x + 1] + grid[(y + 1) * gw + x]) / 4 > 0
        segs =
          mask === 5
            ? centre
              ? [[T, R], [B, L]] // artwork joined through the middle
              : [[T, L], [B, R]]
            : centre
              ? [[L, T], [R, B]]
              : [[R, T], [L, B]]
      }
      const edge = (e: number): number =>
        e === T ? hId(x, y) : e === B ? hId(x, y + 1) : e === L ? vId(x, y) : vId(x + 1, y)
      for (const [from, to] of segs) next.set(edge(from), edge(to))
    }
  }

  const pointOf = (id: number): [number, number] => {
    const idx = id >> 1
    const sx = idx % gw
    const sy = Math.floor(idx / gw)
    const f0 = grid[sy * gw + sx]
    if (id & 1) {
      const f1 = grid[(sy + 1) * gw + sx]
      return [sx, sy + f0 / (f0 - f1)]
    }
    const f1 = grid[sy * gw + sx + 1]
    return [sx + f0 / (f0 - f1), sy]
  }

  const rings: [number, number][][] = []
  const seen = new Set<number>()
  for (const start of next.keys()) {
    if (seen.has(start)) continue
    const ring: [number, number][] = []
    let cur: number | undefined = start
    while (cur !== undefined && !seen.has(cur)) {
      seen.add(cur)
      const [gx, gy] = pointOf(cur)
      ring.push([gx - 0.5, gy - 0.5]) // padded index p ↔ pixel coordinate p − 0.5
      cur = next.get(cur)
    }
    if (ring.length >= 3) rings.push(ring)
  }
  return rings
}

/**
 * Smooth contours of an image's artwork as normalized [0,1] rings (x right, y
 * **up**), the same shape `traceContours` returns. `smoothingMm` is the Gaussian
 * blur sigma in mm of the placed image (`sizeMm` = its width × height); 0 keeps
 * only the sub-pixel interpolation.
 */
export function traceSmoothContours(
  image: ImageSource,
  cut: Pick<CutSettings, 'threshold' | 'invert' | 'smoothing'>,
  sizeMm: Vec2,
  maxLongEdge = DEFAULT_MAX_LONG_EDGE
): Contour[] {
  const field = buildField(image, cut, maxLongEdge)
  const cellMm = sizeMm[0] / field.width
  const sigma = cellMm > 0 ? Math.max(0, cut.smoothing) / cellMm : 0
  const rings = traceField(gaussianBlur(field, sigma))
  const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))
  return rings.map((ring) =>
    ring.map(([x, y]) => [clamp01(x / field.width), 1 - clamp01(y / field.height)] as Vec2)
  )
}

/** Quantize a size so tiny resizes share one preview trace (≈15% steps). */
function sizeBucket(mm: number): number {
  return Math.round(Math.log(Math.max(mm, 0.01)) / Math.log(1.15))
}

/** Cache key for a placement's preview trace (everything the outline depends on). */
export function previewKey(pl: Pick<Placement, 'size' | 'cut'>): string {
  return `${pl.cut.threshold}|${pl.cut.invert}|${pl.cut.smoothing}|${sizeBucket(pl.size[0])}`
}

const previewCache = new WeakMap<ImageSource, Map<string, Contour[]>>()

/**
 * Cached smooth contours for the 2D editor and overlay previews. The editor
 * re-renders on every pointer move, so the trace is keyed on image identity,
 * threshold, invert, smoothing and a coarse size bucket (the blur only depends on
 * size through the cell width, so a sliver of resize needn't retrace). Geometry
 * (`engraveFace`) uses the exact, uncached `traceSmoothContours`.
 */
export function previewContours(pl: Pick<Placement, 'image' | 'size' | 'cut'>): Contour[] {
  const bucket = sizeBucket(pl.size[0])
  const key = previewKey(pl)
  let perImage = previewCache.get(pl.image)
  if (!perImage) previewCache.set(pl.image, (perImage = new Map()))
  let rings = perImage.get(key)
  if (!rings) {
    const w = Math.pow(1.15, bucket)
    rings = traceSmoothContours(pl.image, pl.cut, [w, w * (pl.size[1] / pl.size[0])])
    if (perImage.size >= 12) perImage.clear() // bound memory while a slider is scrubbed
    perImage.set(key, rings)
  }
  return rings
}

/**
 * Flag artwork whose thinnest traced feature is below the nozzle limit. Uses a
 * conservative proxy: the shortest edge of the simplified contours, in the
 * caller-supplied mm scale. Returns true if anything is finer than
 * `minFeatureMm`.
 */
export function tooFineForNozzle(contours: Contour[], minFeatureMm = 0.4): boolean {
  let min = Infinity
  for (const ring of contours) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i],
        b = ring[(i + 1) % ring.length]
      min = Math.min(min, Math.hypot(b[0] - a[0], b[1] - a[1]))
    }
  }
  return min < minFeatureMm
}
