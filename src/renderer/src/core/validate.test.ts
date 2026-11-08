import { describe, expect, it } from 'vitest'
import { validateMesh, isExportable } from './validate'
import { repairMesh } from './repair'
import { mergePieces, prepareForExport } from './export'
import { parseBinaryStl } from './stl'
import type { IndexedMesh, MeshPiece } from './types'

// A closed, consistently-wound tetrahedron: watertight + manifold.
const TETRA: IndexedMesh = {
  vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]),
  indices: new Uint32Array([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3])
}

function clone(m: IndexedMesh): IndexedMesh {
  return { vertices: new Float32Array(m.vertices), indices: new Uint32Array(m.indices) }
}

describe('validateMesh', () => {
  it('accepts a watertight, manifold, well-wound mesh', () => {
    const d = validateMesh(TETRA)
    expect(d.isWatertight).toBe(true)
    expect(d.isManifold).toBe(true)
    expect(d.boundaryEdges).toBe(0)
    expect(d.nonManifoldEdges).toBe(0)
    expect(d.inconsistentlyOrientedEdges).toBe(0)
    expect(isExportable(d)).toBe(true)
  })

  it('detects holes (open boundary edges)', () => {
    const open: IndexedMesh = { vertices: TETRA.vertices, indices: TETRA.indices.slice(0, 9) }
    const d = validateMesh(open)
    expect(d.isWatertight).toBe(false)
    expect(d.boundaryEdges).toBeGreaterThan(0)
    // Holes are detected and reported but are not a repair-tool defect, so they
    // do not block export on their own.
    expect(isExportable(d)).toBe(true)
  })

  it('detects a flipped triangle (inconsistent winding)', () => {
    const flipped = clone(TETRA)
    // Swap the last two indices of the final triangle to reverse its winding.
    const n = flipped.indices.length
    const tmp = flipped.indices[n - 1]
    flipped.indices[n - 1] = flipped.indices[n - 2]
    flipped.indices[n - 2] = tmp
    const d = validateMesh(flipped)
    expect(d.inconsistentlyOrientedEdges).toBeGreaterThan(0)
    expect(d.isManifold).toBe(false)
  })

  it('detects degenerate, duplicate, and unreferenced defects', () => {
    const verts = [...TETRA.vertices, 5, 5, 5] // vertex 4 is unused
    const idx = [
      ...TETRA.indices,
      0, 0, 1, // degenerate (repeated vertex → zero area)
      0, 2, 1 // duplicate of triangle 0
    ]
    const dirty: IndexedMesh = {
      vertices: new Float32Array(verts),
      indices: new Uint32Array(idx)
    }
    const d = validateMesh(dirty)
    expect(d.degenerateTriangles).toHaveLength(1)
    expect(d.duplicateTriangles).toBe(1)
    expect(d.unreferencedVertices).toBe(1)
  })
})

// Three triangles sharing edge {0,1}: a non-manifold edge.
const NON_MANIFOLD: IndexedMesh = {
  vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 1]),
  indices: new Uint32Array([0, 1, 2, 0, 1, 3, 0, 1, 4])
}

// Two triangles meeting only at vertex 0 — a non-manifold ("bowtie") vertex.
const BOWTIE: IndexedMesh = {
  vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, -1, 0, 0, 0, -1, 0]),
  indices: new Uint32Array([0, 1, 2, 0, 3, 4])
}

describe('validateMesh — extra defect classes', () => {
  it('detects a non-manifold (bowtie) vertex', () => {
    const d = validateMesh(BOWTIE)
    expect(d.nonManifoldVertices).toBe(1)
    expect(d.nonManifoldEdges).toBe(0) // it is a vertex, not an edge, defect
    expect(isExportable(d)).toBe(false)
  })

  it('detects non-finite (NaN) coordinates', () => {
    const bad = {
      vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, NaN, 0, 0, 0, 0, 1, 1, 1, 1]),
      indices: new Uint32Array([0, 1, 2, 0, 1, 3, 3, 4, 5])
    }
    const d = validateMesh(bad)
    expect(d.nanVertices).toBe(1)
    expect(isExportable(d)).toBe(false)
  })

  it('flags a sliver triangle but does not block export', () => {
    const sliver: IndexedMesh = {
      vertices: new Float32Array([0, 0, 0, 10, 0, 0, 5, 0.001, 0]),
      indices: new Uint32Array([0, 1, 2])
    }
    const d = validateMesh(sliver)
    expect(d.sliverTriangles).toHaveLength(1)
    expect(d.degenerateTriangles).toHaveLength(0) // valid, just thin
  })
})

describe('repairMesh', () => {
  it('fixes non-manifold edges by splitting the shared edge', () => {
    expect(validateMesh(NON_MANIFOLD).nonManifoldEdges).toBe(1)
    const d = validateMesh(repairMesh(NON_MANIFOLD))
    expect(d.nonManifoldEdges).toBe(0)
    expect(isExportable(d)).toBe(true)
  })

  it('fixes a non-manifold vertex by splitting the fans', () => {
    expect(validateMesh(BOWTIE).nonManifoldVertices).toBe(1)
    expect(validateMesh(repairMesh(BOWTIE)).nonManifoldVertices).toBe(0)
  })

  it('drops triangles with non-finite coordinates', () => {
    const bad: IndexedMesh = {
      vertices: new Float32Array([...TETRA.vertices, Infinity, 0, 0]),
      indices: new Uint32Array([...TETRA.indices, 0, 1, 4])
    }
    const d = validateMesh(repairMesh(bad))
    expect(d.nanVertices).toBe(0)
    expect(d.triangleCount).toBe(4) // the Infinity triangle is gone
  })

  it('drops degenerate, duplicate, and unreferenced; keeps the solid', () => {
    const verts = [...TETRA.vertices, 5, 5, 5]
    const idx = [...TETRA.indices, 0, 0, 1, 0, 2, 1]
    const dirty: IndexedMesh = { vertices: new Float32Array(verts), indices: new Uint32Array(idx) }
    const d = validateMesh(repairMesh(dirty))
    expect(d.triangleCount).toBe(4)
    expect(d.unreferencedVertices).toBe(0)
    expect(isExportable(d)).toBe(true)
  })

  it('fixes flipped normals so the result is manifold', () => {
    const flipped = clone(TETRA)
    const n = flipped.indices.length
    const tmp = flipped.indices[n - 1]
    flipped.indices[n - 1] = flipped.indices[n - 2]
    flipped.indices[n - 2] = tmp
    expect(validateMesh(flipped).isManifold).toBe(false)
    expect(validateMesh(repairMesh(flipped)).isManifold).toBe(true)
  })
})

describe('export assembly', () => {
  it('merges pieces with offset indices', () => {
    const pieces: MeshPiece[] = [
      { id: 0, mesh: TETRA },
      { id: 1, mesh: TETRA }
    ]
    const merged = mergePieces(pieces)
    expect(merged.vertices.length).toBe(TETRA.vertices.length * 2)
    // Second piece's indices must be offset past the first piece's vertices.
    expect(Math.max(...merged.indices)).toBe(7) // 8 verts → max index 7
  })

  it('prepareForExport yields a clean, re-parseable STL', () => {
    const res = prepareForExport([{ id: 0, mesh: TETRA }])
    expect(res.clean).toBe(true)
    expect(res.warnings).toHaveLength(0)
    expect(parseBinaryStl(res.stl).triangleCount).toBe(4)
  })

  it('repairs non-manifold edges on export and reports the fix', () => {
    const res = prepareForExport([{ id: 0, mesh: NON_MANIFOLD }])
    expect(res.clean).toBe(true)
    expect(res.diagnostics.nonManifoldEdges).toBe(0)
    expect(res.repaired).toContain('non-manifold edges')
  })

  it('repairs reversed faces on export and reports the fix', () => {
    const flipped = clone(TETRA)
    const n = flipped.indices.length
    const tmp = flipped.indices[n - 1]
    flipped.indices[n - 1] = flipped.indices[n - 2]
    flipped.indices[n - 2] = tmp
    const res = prepareForExport([{ id: 0, mesh: flipped }])
    expect(res.clean).toBe(true)
    expect(res.diagnostics.inconsistentlyOrientedEdges).toBe(0)
    expect(res.repaired).toContain('reversed faces')
  })

  it('surfaces holes as a non-blocking warning (not a repair tool issue)', () => {
    const open: IndexedMesh = { vertices: TETRA.vertices, indices: TETRA.indices.slice(0, 9) }
    const res = prepareForExport([{ id: 0, mesh: open }])
    expect(res.clean).toBe(true) // no non-manifold edges / reversed faces
    expect(res.warnings.join(' ')).toMatch(/hole|watertight/i)
  })
})
