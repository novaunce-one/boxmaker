import { describe, expect, it } from 'vitest'
import { componentVolume, removeNoiseShells } from './components'
import { measureClearance, hasTightClearance } from './clearance'
import type { IndexedMesh, MeshPiece } from './types'

/** A unit-ish closed tetrahedron, translated by (dx,dy,dz). */
function tetra(dx = 0, dy = 0, dz = 0): IndexedMesh {
  const v = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]
  const vertices = new Float32Array(v.length)
  for (let i = 0; i < v.length; i += 3) {
    vertices[i] = v[i] + dx
    vertices[i + 1] = v[i + 1] + dy
    vertices[i + 2] = v[i + 2] + dz
  }
  return { vertices, indices: new Uint32Array([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]) }
}

describe('removeNoiseShells', () => {
  it('computes a positive volume for a closed solid', () => {
    expect(componentVolume(tetra())).toBeCloseTo(1 / 6, 6)
  })

  it('drops a stray sub-triangle shell but keeps real solids', () => {
    const noise: IndexedMesh = {
      vertices: new Float32Array([0, 0, 0, 0.01, 0, 0, 0, 0.01, 0]),
      indices: new Uint32Array([0, 1, 2]) // 1 triangle, ~0 volume
    }
    const pieces: MeshPiece[] = [
      { id: 0, mesh: tetra() },
      { id: 1, mesh: noise }
    ]
    const { kept, removed } = removeNoiseShells(pieces)
    expect(kept).toHaveLength(1)
    expect(removed).toHaveLength(1)
    expect(kept[0].id).toBe(0) // re-indexed from 0
  })
})

describe('measureClearance (hinge gap)', () => {
  it('finds the small gap between two near pieces', () => {
    // Second tetra shifted +2 in x: nearest vertices are (1,0,0) and (2,0,0) → gap 1.
    const pieces: MeshPiece[] = [
      { id: 0, mesh: tetra() },
      { id: 1, mesh: tetra(2, 0, 0) }
    ]
    const report = measureClearance(pieces, 1.5)
    expect(report.betweenPieces).toEqual([0, 1])
    expect(report.minGap).toBeCloseTo(1, 6)
  })

  it('reports no close approach when pieces are far apart', () => {
    const pieces: MeshPiece[] = [
      { id: 0, mesh: tetra() },
      { id: 1, mesh: tetra(50, 0, 0) }
    ]
    expect(measureClearance(pieces, 0.5).betweenPieces).toBeNull()
  })

  it('hasTightClearance flags gaps below the printable minimum', () => {
    const pieces: MeshPiece[] = [
      { id: 0, mesh: tetra() },
      { id: 1, mesh: tetra(1.1, 0, 0) } // gap ~0.1 mm
    ]
    expect(hasTightClearance(pieces, 0.3)).not.toBeNull()
    expect(hasTightClearance(pieces, 0.05)).toBeNull() // 0.1 > 0.05 → fine
  })
})
