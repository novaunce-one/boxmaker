import type { FacePlane, MeshPiece, Placement } from './types'

/**
 * The cut pipeline (docs/PLAN.md §4–5). Orchestrates tracing → cross-section →
 * extrude → boolean-subtract, operating ONLY on the piece that owns the face so
 * the print-in-place hinge is never altered.
 *
 * These are typed entry points; the manifold-backed bodies land in Stage 1,
 * steps 1 & 4 and are verified against the real STL.
 */

export interface EngraveResult {
  /** The engraved piece, replacing the input `piece`. */
  piece: MeshPiece
  warnings: string[]
}

/**
 * Cut every `placement` on `face` into `piece`.
 *
 * Steps per placement:
 *  1. image → binary mask → contours → CrossSection (EvenOdd), simplify.
 *  2. clip to the face region: union face triangles → CrossSection,
 *     offset(−margin), intersect with the artwork.
 *  3. extrude depth+ε, transform so it starts ε outside and cuts `depth` inward
 *     along −normal, then subtract from the piece.
 * Enforces the edge margin and wall-thickness guard; collects warnings.
 */
export function engraveFace(
  _piece: MeshPiece,
  _face: FacePlane,
  _placements: Placement[],
  _marginMm: number
): EngraveResult {
  throw new Error('engraveFace: cut pipeline not implemented yet (Stage 1, steps 1 & 4).')
}

/**
 * Pre-export break-through check (docs/PLAN.md §5): confirm no cut pierced the
 * wall, e.g. by comparing removed volume vs. cutter volume or re-raycasting.
 */
export function checkBreakthrough(_before: MeshPiece, _after: MeshPiece): string[] {
  throw new Error('checkBreakthrough: not implemented yet (Stage 1, step 4).')
}
