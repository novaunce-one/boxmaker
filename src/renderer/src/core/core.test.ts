import { describe, expect, it } from 'vitest'
import { parseBinaryStl, writeBinaryStl } from './stl'
import { weldVertices, connectedComponents } from './components'
import { faceBasis } from './faces'
import { toBinaryMask } from './image-trace'
import type { ImageSource, TriangleMesh } from './types'

/** Build a binary STL buffer from a flat positions array (triangleCount*9). */
function stlFromPositions(positions: number[]): ArrayBuffer {
  const mesh: TriangleMesh = {
    positions: new Float32Array(positions),
    triangleCount: positions.length / 9
  }
  return writeBinaryStl(mesh)
}

// Two disjoint unit triangles — stands in for "two pieces" (lid + base).
const TWO_TRIS = [
  // triangle A near origin
  0, 0, 0, 1, 0, 0, 0, 1, 0,
  // triangle B offset far away
  10, 10, 10, 11, 10, 10, 10, 11, 10
]

describe('stl round-trip', () => {
  it('writes and re-parses the same triangles', () => {
    const buf = stlFromPositions(TWO_TRIS)
    const mesh = parseBinaryStl(buf)
    expect(mesh.triangleCount).toBe(2)
    expect(Array.from(mesh.positions)).toEqual(TWO_TRIS)
  })
})

describe('connected components (hinge safeguard)', () => {
  it('splits two disjoint triangles into two pieces', () => {
    const mesh = parseBinaryStl(stlFromPositions(TWO_TRIS))
    const pieces = connectedComponents(weldVertices(mesh))
    expect(pieces).toHaveLength(2)
  })

  it('keeps edge-sharing triangles as one piece', () => {
    // Two triangles sharing the edge (1,0,0)-(0,1,0): one quad.
    const quad = [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]
    const mesh = parseBinaryStl(stlFromPositions(quad))
    const pieces = connectedComponents(weldVertices(mesh))
    expect(pieces).toHaveLength(1)
  })
})

describe('face basis', () => {
  it('is right-handed: u × v === normal', () => {
    for (const n of [
      [1, 0, 0],
      [0, 0, 1],
      [0, -1, 0]
    ] as const) {
      const { u, v } = faceBasis(n)
      const cross = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
      expect(cross[0]).toBeCloseTo(n[0], 5)
      expect(cross[1]).toBeCloseTo(n[1], 5)
      expect(cross[2]).toBeCloseTo(n[2], 5)
    }
  })
})

describe('image threshold', () => {
  it('cuts dark pixels and keeps light ones', () => {
    // 2x1: black then white.
    const rgba = new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255])
    const img: ImageSource = { width: 2, height: 1, rgba }
    const mask = toBinaryMask(img, { threshold: 128, invert: false })
    expect(mask.bits[0]).toBe(1) // black → cut
    expect(mask.bits[1]).toBe(0) // white → keep
  })
})
