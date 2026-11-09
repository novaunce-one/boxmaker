import { manifold } from './manifold'
import { toManifold, fromManifold } from './engrave'
import type { MeshPiece } from './types'

/**
 * Export-time uniform scaling with hinge-gap restoration (SPEC §2.17 FR-SCALE).
 *
 * Scaling a print-in-place box by `s` multiplies every gap by `s`, so a template
 * with a 0.28 mm hinge gap scaled to 80% has a 0.22 mm gap that may bind or fuse.
 * `scaleMeshes` scales the model; `restoreClearance` then re-opens any joint that
 * ended up tighter than the target by carving a thin shell out of one piece:
 *
 *   carved = piece − (neighbour ⊕ ball(target gap))
 *
 * which guarantees the two pieces are at least `target` apart, removes material
 * only where they were already closer than that, and leaves everything else
 * byte-for-byte alike. Pieces that are already far enough apart (scale ≥ 100%, or
 * a generous template) pass through untouched.
 */

/**
 * Polygon count of the Minkowski ball. Cost grows quickly with it (≈7 s on the
 * real template at 16, ≈12 s at 24) while a coarse ball is inscribed in the true
 * sphere and under-delivers the gap (measured: ~0.82× at 8, 0.92× at 12, 0.955×
 * at 16), so the radius is inflated to compensate.
 */
const BALL_SEGMENTS = 16
/** Over-size the polyhedral ball so the real gap is never below target. */
const BALL_INFLATE = 1.08
/** Gaps within this of the target count as met. */
const GAP_TOL_MM = 1e-3

/**
 * Uniformly scale every piece about the model's minimum corner, so the box
 * keeps sitting on z = min and stays in the same place. `scale === 1` returns the
 * input pieces untouched.
 */
export function scaleMeshes(pieces: MeshPiece[], scale: number): MeshPiece[] {
  if (scale === 1 || pieces.length === 0) return pieces
  let mx = Infinity
  let my = Infinity
  let mz = Infinity
  for (const p of pieces) {
    const v = p.mesh.vertices
    for (let i = 0; i < v.length; i += 3) {
      if (v[i] < mx) mx = v[i]
      if (v[i + 1] < my) my = v[i + 1]
      if (v[i + 2] < mz) mz = v[i + 2]
    }
  }
  return pieces.map((p) => {
    const src = p.mesh.vertices
    const vertices = new Float32Array(src.length)
    for (let i = 0; i < src.length; i += 3) {
      vertices[i] = mx + (src[i] - mx) * scale
      vertices[i + 1] = my + (src[i + 1] - my) * scale
      vertices[i + 2] = mz + (src[i + 2] - mz) * scale
    }
    return { id: p.id, mesh: { vertices, indices: p.mesh.indices } }
  })
}

export interface ExactGap {
  /** Smallest surface-to-surface gap between any two pieces (mm), or Infinity if none within `searchMm`. */
  minGap: number
  /** The two piece ids at that gap, or null. */
  betweenPieces: [number, number] | null
}

type Solid = import('manifold-3d').Manifold

function solidsOf(pieces: MeshPiece[]): Map<number, Solid> {
  const out = new Map<number, Solid>()
  for (const p of pieces) out.set(p.id, toManifold(p.mesh))
  return out
}

function boxesNear(a: Solid, b: Solid, margin: number): boolean {
  const x = a.boundingBox()
  const y = b.boundingBox()
  for (let k = 0; k < 3; k++) {
    if (x.min[k] - margin > y.max[k] || y.min[k] - margin > x.max[k]) return false
  }
  return true
}

function gapBetween(a: Solid, b: Solid, searchMm: number): number {
  if (!boxesNear(a, b, searchMm)) return Infinity
  const g = a.minGap(b, searchMm)
  return g >= searchMm ? Infinity : g
}

/**
 * Exact (surface-to-surface) smallest gap between distinct pieces, via
 * manifold's `minGap`. Unlike the vertex-based `measureClearance` this is not
 * fooled by long triangles. Gaps beyond `searchMm` are reported as Infinity.
 */
export function measureExactGap(pieces: MeshPiece[], searchMm = 2): ExactGap {
  const solids = solidsOf(pieces)
  let best = Infinity
  let pair: [number, number] | null = null
  for (let i = 0; i < pieces.length; i++) {
    for (let j = i + 1; j < pieces.length; j++) {
      const g = gapBetween(solids.get(pieces[i].id)!, solids.get(pieces[j].id)!, searchMm)
      if (g < best) {
        best = g
        pair = [pieces[i].id, pieces[j].id]
      }
    }
  }
  return { minGap: best, betweenPieces: pair }
}

export interface RestoreResult {
  pieces: MeshPiece[]
  /** Gap before restoring (mm), Infinity if no pieces were within reach. */
  gapBefore: number
  /** Gap after restoring (mm). */
  gapAfter: number
  /** True if any piece was carved. */
  carved: boolean
  warnings: string[]
}

/**
 * Ensure every pair of pieces is at least `targetGapMm` apart by carving the
 * larger piece of any pair that is closer. See the module comment.
 */
export function restoreClearance(pieces: MeshPiece[], targetGapMm: number): RestoreResult {
  const warnings: string[] = []
  const search = Math.max(targetGapMm * 4, 1)
  const solids = solidsOf(pieces)
  const { Manifold } = manifold()
  const out = new Map<number, MeshPiece>(pieces.map((p) => [p.id, p]))

  let gapBefore = Infinity
  let carved = false

  for (let i = 0; i < pieces.length; i++) {
    for (let j = i + 1; j < pieces.length; j++) {
      const idA = pieces[i].id
      const idB = pieces[j].id
      const a0 = solids.get(idA)!
      const b0 = solids.get(idB)!
      const gap = gapBetween(a0, b0, search)
      gapBefore = Math.min(gapBefore, gap)
      if (gap >= targetGapMm - GAP_TOL_MM) continue

      // Carve the bulkier piece: it loses a sliver of a much larger solid.
      const [carveId, keep, carve] = a0.volume() >= b0.volume() ? [idA, b0, a0] : [idB, a0, b0]
      try {
        // Only the part of the neighbour within reach of the piece being carved matters.
        const bb = carve.boundingBox()
        const pad = targetGapMm * 2
        const window = Manifold.cube(
          [bb.max[0] - bb.min[0] + 2 * pad, bb.max[1] - bb.min[1] + 2 * pad, bb.max[2] - bb.min[2] + 2 * pad],
          false
        ).translate([bb.min[0] - pad, bb.min[1] - pad, bb.min[2] - pad])
        const near = keep.intersect(window)
        const shell = near.minkowskiSum(Manifold.sphere(targetGapMm * BALL_INFLATE, BALL_SEGMENTS))
        const result = carve.subtract(shell)
        out.set(carveId, { id: carveId, mesh: fromManifold(result) })
        solids.set(carveId, result)
        carved = true
      } catch (e) {
        warnings.push(
          `Could not re-open the gap between pieces ${idA} and ${idB}: ${e instanceof Error ? e.message : String(e)}`
        )
      }
    }
  }

  let gapAfter = Infinity
  for (let i = 0; i < pieces.length; i++) {
    for (let j = i + 1; j < pieces.length; j++) {
      gapAfter = Math.min(gapAfter, gapBetween(solids.get(pieces[i].id)!, solids.get(pieces[j].id)!, search))
    }
  }
  if (carved && gapAfter < targetGapMm - GAP_TOL_MM) {
    warnings.push(
      `Hinge gap is ${gapAfter.toFixed(3)} mm after scaling, below the ${targetGapMm.toFixed(2)} mm target.`
    )
  }

  return { pieces: pieces.map((p) => out.get(p.id)!), gapBefore, gapAfter, carved, warnings }
}

export interface ScaledExport {
  pieces: MeshPiece[]
  /** Human-readable notes for the export dialog. */
  notes: string[]
  warnings: string[]
}

/**
 * Scale the engraved pieces and restore the joint clearance. `targetGapMm` is
 * the minimum gap to enforce afterwards (the template's own gap by default, or
 * the user's override); `null` skips the clearance step.
 */
export function applyExportScale(
  pieces: MeshPiece[],
  scale: number,
  targetGapMm: number | null
): ScaledExport {
  if (scale === 1 && targetGapMm === null) return { pieces, notes: [], warnings: [] }
  const scaled = scaleMeshes(pieces, scale)
  const notes = scale === 1 ? [] : [`Scaled to ${(scale * 100).toFixed(0)}%.`]
  if (targetGapMm === null) return { pieces: scaled, notes, warnings: [] }
  const r = restoreClearance(scaled, targetGapMm)
  if (r.carved) {
    notes.push(
      `Hinge gap re-opened to ${r.gapAfter.toFixed(2)} mm (it was ${r.gapBefore.toFixed(2)} mm).`
    )
  }
  return { pieces: r.pieces, notes, warnings: r.warnings }
}
