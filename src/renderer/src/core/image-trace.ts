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
 * Trace `mask` into contours with marching squares, returning rings in
 * normalized [0,1] space (x right, y up) ready to scale into face mm.
 *
 * TODO(stage1-step1): implement marching-squares tracing + contour
 * simplification (Douglas–Peucker at `smoothing` mm). Verify against the real
 * STL + a sample logo before wiring into the live preview.
 */
export function traceContours(_mask: BinaryMask, _smoothingMm = 0.1): Contour[] {
  throw new Error('traceContours: marching-squares tracing not implemented yet (Stage 1, step 1).')
}

/** Flag artwork whose thinnest traced feature is below the nozzle limit. */
export function tooFineForNozzle(_contours: Contour[], _minFeatureMm = 0.4): boolean {
  throw new Error('tooFineForNozzle: not implemented yet (needs contour tracing first).')
}
