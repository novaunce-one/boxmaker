import { beforeAll, describe, expect, it } from 'vitest'
import { traceContours, tooFineForNozzle } from './image-trace'
import { maskToRgba } from '../ui/preview-overlay'
import { engraveFace, smoothRegion } from './engrave'
import { componentVolume } from './components'
import { initManifold } from './manifold'
import type { BinaryMask } from './image-trace'
import type { FacePlane, ImageSource, MeshPiece } from './types'

describe('traceContours (marching squares)', () => {
  it('traces a filled block as one 4-corner ring', () => {
    // 4×4 grid, 2×2 cut block in the middle.
    const bits = new Uint8Array(16)
    for (const [x, y] of [
      [1, 1],
      [2, 1],
      [1, 2],
      [2, 2]
    ])
      bits[y * 4 + x] = 1
    const mask: BinaryMask = { width: 4, height: 4, bits }
    const contours = traceContours(mask)
    expect(contours).toHaveLength(1)
    expect(contours[0]).toHaveLength(4) // collinear staircase merged to corners
  })

  it('traces a block with a hole as two rings', () => {
    // 5×5 solid with the center pixel empty → outer ring + hole ring.
    const bits = new Uint8Array(25).fill(1)
    bits[2 * 5 + 2] = 0
    const contours = traceContours({ width: 5, height: 5, bits })
    expect(contours).toHaveLength(2)
  })
})

describe('mask → overlay RGBA', () => {
  it('makes cut pixels opaque and kept pixels transparent', () => {
    const mask: BinaryMask = { width: 2, height: 1, bits: new Uint8Array([1, 0]) }
    const { data } = maskToRgba(mask)
    expect(data[3]).toBeGreaterThan(0) // cut → opaque
    expect(data[7]).toBe(0) // keep → transparent
  })
})

describe('tooFineForNozzle', () => {
  it('flags artwork with sub-threshold edges', () => {
    // A tiny 0.1mm square ring.
    const ring: [number, number][] = [
      [0, 0],
      [0.1, 0],
      [0.1, 0.1],
      [0, 0.1]
    ]
    expect(tooFineForNozzle([ring], 0.4)).toBe(true)
    expect(tooFineForNozzle([ring.map(([x, y]) => [x * 10, y * 10]) as [number, number][]], 0.4)).toBe(false)
  })
})

describe('engraveFace (real cut)', () => {
  beforeAll(async () => {
    await initManifold()
  })

  it('debosses the top face of a cube, removing volume and staying watertight', () => {
    const cube = unitCube(20) // 20mm cube from 0..20
    const pieceBefore = componentVolume(cube.mesh)

    // A solid black 16×16 image → a filled square cutter.
    const image = solidBlackImage(16, 16)
    const placement = {
      center: [0, 0] as [number, number],
      size: [10, 10] as [number, number],
      rotation: 0,
      image,
      cut: { threshold: 128, invert: false, depth: 1, smoothing: 0.1 }
    }

    const { piece, warnings } = engraveFace(cube, topFace(), [placement], 2)
    const after = componentVolume(piece.mesh)

    expect(warnings).toHaveLength(0)
    expect(after).toBeGreaterThan(0)
    expect(after).toBeLessThan(pieceBefore) // material was removed
  })
})

describe('smoothRegion (de-etch)', () => {
  beforeAll(async () => {
    await initManifold()
  })

  it('fills an etched notch back flush, restoring volume', () => {
    const cube = unitCube(20)
    const full = componentVolume(cube.mesh)

    // Etch a 10×10×1 notch into the top, then de-etch the region over it.
    const image = solidBlackImage(16, 16)
    const placement = {
      center: [0, 0] as [number, number],
      size: [10, 10] as [number, number],
      rotation: 0,
      image,
      cut: { threshold: 128, invert: false, depth: 1, smoothing: 0.1 }
    }
    const etched = engraveFace(cube, topFace(), [placement], 2).piece
    const etchedVol = componentVolume(etched.mesh)
    expect(etchedVol).toBeLessThan(full)

    const smoothed = smoothRegion(etched, topFace(), [{ min: [-6, -6], max: [6, 6] }], 2).piece
    const smoothedVol = componentVolume(smoothed.mesh)

    expect(smoothedVol).toBeGreaterThan(etchedVol) // material added back
    expect(Math.abs(smoothedVol - full)).toBeLessThan(1) // ~flush with the surface
  })
})

// --- fixtures ------------------------------------------------------------

function solidBlackImage(w: number, h: number): ImageSource {
  const rgba = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < w * h; i++) rgba[i * 4 + 3] = 255 // black, opaque
  return { width: w, height: h, rgba }
}

/** The +Z top face of the cube at z = size, origin at its center. */
function topFace(): FacePlane {
  return {
    origin: [10, 10, 20],
    normal: [0, 0, 1],
    u: [1, 0, 0],
    v: [0, 1, 0],
    triangles: [2, 3], // the two triangles of the cube's top quad (see unitCube)
    pieceId: 0
  }
}

/** An axis-aligned cube [0,size]³ as a watertight indexed MeshPiece. */
function unitCube(size: number): MeshPiece {
  const s = size
  const v = [
    0, 0, 0, s, 0, 0, s, s, 0, 0, s, 0, // bottom z=0
    0, 0, s, s, 0, s, s, s, s, 0, s, s // top z=s
  ]
  const quads = [
    [0, 1, 2, 3], // bottom (−Z)
    [4, 7, 6, 5], // top (+Z)
    [0, 4, 5, 1], // −Y
    [1, 5, 6, 2], // +X
    [2, 6, 7, 3], // +Y
    [3, 7, 4, 0] // −X
  ]
  const idx: number[] = []
  for (const [a, b, c, d] of quads) idx.push(a, b, c, a, c, d)
  return { id: 0, mesh: { vertices: new Float32Array(v), indices: new Uint32Array(idx) } }
}
