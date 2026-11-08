import type { MeshPiece } from './types'

/**
 * Hinge-clearance check (SPEC §2 `FR-CLEAR`).
 *
 * Measures the smallest gap between distinct pieces. If two pieces approach
 * closer than the printer's minimum printable clearance they will fuse into one
 * solid — destroying a print-in-place hinge. boxmaker never booleans the other
 * pieces, so this mainly validates the supplied template, and warns before
 * export if a joint is too tight to print.
 *
 * The measure is vertex-based and therefore approximate (it samples vertices,
 * not whole triangle surfaces), but it reliably catches close approaches when
 * the mesh is reasonably tessellated. A uniform spatial hash keeps it ~O(n):
 * only pieces that come within `searchRadius` are compared.
 */

export interface ClearanceReport {
  /** Smallest vertex-to-vertex gap found between different pieces (mm). */
  minGap: number
  /** The two piece ids at that gap, or null if none were within `searchRadius`. */
  betweenPieces: [number, number] | null
}

interface GridPoint {
  x: number
  y: number
  z: number
  piece: number
}

export function measureClearance(pieces: MeshPiece[], searchRadius = 0.5): ClearanceReport {
  const cell = Math.max(searchRadius, 1e-6)
  const grid = new Map<string, GridPoint[]>()
  const keyOf = (ix: number, iy: number, iz: number): string => `${ix},${iy},${iz}`

  // Index every vertex by its grid cell, tagged with its piece id.
  for (const p of pieces) {
    const v = p.mesh.vertices
    for (let i = 0; i < v.length; i += 3) {
      const pt: GridPoint = { x: v[i], y: v[i + 1], z: v[i + 2], piece: p.id }
      const key = keyOf(Math.floor(pt.x / cell), Math.floor(pt.y / cell), Math.floor(pt.z / cell))
      let bucket = grid.get(key)
      if (!bucket) grid.set(key, (bucket = []))
      bucket.push(pt)
    }
  }

  let minSq = Infinity
  let pair: [number, number] | null = null
  const radiusSq = searchRadius * searchRadius

  for (const p of pieces) {
    const v = p.mesh.vertices
    for (let i = 0; i < v.length; i += 3) {
      const x = v[i],
        y = v[i + 1],
        z = v[i + 2]
      const cx = Math.floor(x / cell),
        cy = Math.floor(y / cell),
        cz = Math.floor(z / cell)
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++)
          for (let dz = -1; dz <= 1; dz++) {
            const bucket = grid.get(keyOf(cx + dx, cy + dy, cz + dz))
            if (!bucket) continue
            for (const q of bucket) {
              if (q.piece === p.id) continue // same piece — ignore
              const d = (q.x - x) ** 2 + (q.y - y) ** 2 + (q.z - z) ** 2
              if (d < minSq && d <= radiusSq) {
                minSq = d
                pair = p.id < q.piece ? [p.id, q.piece] : [q.piece, p.id]
              }
            }
          }
    }
  }

  return { minGap: pair ? Math.sqrt(minSq) : Infinity, betweenPieces: pair }
}

/** Convenience: is any joint tighter than `minClearanceMm` (and printable)? */
export function hasTightClearance(pieces: MeshPiece[], minClearanceMm: number): ClearanceReport | null {
  const report = measureClearance(pieces, minClearanceMm)
  return report.betweenPieces && report.minGap < minClearanceMm ? report : null
}
