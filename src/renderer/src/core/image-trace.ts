import type { CutSettings, ImageSource, Vec2 } from './types'

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
