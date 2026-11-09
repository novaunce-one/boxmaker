import { beforeAll, describe, expect, it } from 'vitest'
import { traceContours, tooFineForNozzle } from './image-trace'
import { maskToRgba } from '../ui/preview-overlay'
import { engraveFace, freeSpace, smoothRegion, wallThickness } from './engrave'
import { validateMesh } from './validate'
import { componentVolume } from './components'
import { findSeedTriangle, rebindFace } from './faces'
import { initManifold } from './manifold'
import type { BinaryMask } from './image-trace'
import { DEFAULT_CUT, type FacePlane, type ImageSource, type MeshPiece, type Placement } from './types'

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
      cut: { ...DEFAULT_CUT, depth: 1 }
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
      cut: { ...DEFAULT_CUT, depth: 1 }
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

describe('face re-binding after de-etch', () => {
  beforeAll(async () => {
    await initManifold()
  })

  it('finds the same plane on a re-triangulated mesh and engraves it correctly', () => {
    const cube = unitCube(20)
    const placement = centeredPlacement(10, 10, 1)
    const etched = engraveFace(cube, topFace(), [placement], 2).piece
    // De-etch the whole top: the result is re-triangulated, so the original
    // face's triangle indices no longer point at the top surface.
    const smoothed = smoothRegion(etched, topFace(), [{ min: [-9, -9], max: [9, 9] }], 2).piece

    const face = rebindFace(smoothed.mesh, topFace())
    expect(face.origin).toEqual(topFace().origin)
    expect(face.triangles.length).toBeGreaterThan(0)
    for (const t of face.triangles) {
      const z = [0, 1, 2].map((k) => smoothed.mesh.vertices[smoothed.mesh.indices[t * 3 + k] * 3 + 2])
      expect(Math.max(...z) - Math.min(...z)).toBeLessThan(1e-6) // flat
      expect(z[0]).toBeCloseTo(20, 4) // on the top plane
    }

    // Engraving the de-etched piece with the stale face still cuts it.
    const { piece, warnings } = engraveFace(smoothed, topFace(), [placement], 2)
    expect(warnings).toHaveLength(0)
    expect(componentVolume(piece.mesh)).toBeLessThan(componentVolume(smoothed.mesh))
  })

  it('a de-etched face is whole again: no hole where the etching was', () => {
    const area = (mesh: MeshPiece['mesh'], tris: number[]): number => {
      let sum = 0
      for (const t of tris) {
        const p = [0, 1, 2].map((k) => mesh.indices[t * 3 + k] * 3)
        const [ax, ay] = [mesh.vertices[p[0]], mesh.vertices[p[0] + 1]]
        const [bx, by] = [mesh.vertices[p[1]], mesh.vertices[p[1] + 1]]
        const [cx, cy] = [mesh.vertices[p[2]], mesh.vertices[p[2] + 1]]
        sum += Math.abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)) / 2
      }
      return sum
    }
    const etched = engraveFace(unitCube(20), topFace(), [centeredPlacement(10, 10, 1)], 2).piece
    const holed = rebindFace(etched.mesh, topFace()) // etching is a hole in the top face
    expect(area(etched.mesh, holed.triangles)).toBeLessThan(400 - 90)

    const smoothed = smoothRegion(etched, topFace(), [{ min: [-6, -6], max: [6, 6] }], 2).piece
    const whole = rebindFace(smoothed.mesh, topFace())
    expect(area(smoothed.mesh, whole.triangles)).toBeCloseTo(400, 0) // full 20×20 top
  })

  it('maps a point on a face back to a triangle on that face', () => {
    const cube = unitCube(20)
    const seed = findSeedTriangle(cube.mesh, [0, 0, 1], [5, 5, 20])
    expect(topFace().triangles).toContain(seed)
  })
})

describe('wall-thickness guard (FR-HINGE-3)', () => {
  beforeAll(async () => {
    await initManifold()
  })

  it('measures the front-wall thickness under a placement', () => {
    const slab = box(20, 20, 1) // 1 mm thick in Z
    const t = wallThickness(slab.mesh, slabTopFace(1), centeredPlacement(10, 10))
    expect(t).toBeGreaterThan(0.9)
    expect(t).toBeLessThan(1.1)
  })

  it('caps a too-deep cut and warns, leaving the slab watertight', () => {
    const slab = box(20, 20, 1)
    // Request 0.6 mm into a 1 mm wall → would leave 0.4 mm (< 0.8). Must cap.
    const { piece, warnings } = engraveFace(slab, slabTopFace(1), [centeredPlacement(10, 10, 0.6)], 2)
    expect(warnings.some((w) => w.includes('WARN-DEPTH'))).toBe(true)
    expect(componentVolume(piece.mesh)).toBeGreaterThan(0)
  })

  it('leaves a thick wall uncut-capped (no warning)', () => {
    const cube = box(20, 20, 20)
    const { warnings } = engraveFace(cube, slabTopFace(20), [centeredPlacement(10, 10, 0.6)], 2)
    expect(warnings).toHaveLength(0)
  })
})

describe('embossed (raised) images (FR-CUT-4)', () => {
  beforeAll(async () => {
    await initManifold()
  })

  const raised = (h: number, size = 10, center: [number, number] = [0, 0]): Placement => ({
    center,
    size: [size, size],
    rotation: 0,
    image: solidBlackImage(16, 16),
    cut: { ...DEFAULT_CUT, mode: 'emboss', height: h }
  })
  /** A box sitting `gap` mm above the cube's top face (cube top is z = 20). */
  const lidAbove = (gap: number): MeshPiece => {
    const b = box(20, 20, 5)
    for (let i = 2; i < b.mesh.vertices.length; i += 3) b.mesh.vertices[i] += 20 + gap
    return { id: 1, mesh: b.mesh }
  }
  const topZ = (m: MeshPiece['mesh']): number => {
    let z = -Infinity
    for (let i = 2; i < m.vertices.length; i += 3) z = Math.max(z, m.vertices[i])
    return z
  }

  it('raises the image: adds ~area×height of volume, stands proud, stays watertight', () => {
    const cube = unitCube(20)
    const before = componentVolume(cube.mesh)
    const { piece, warnings } = engraveFace(cube, topFace(), [raised(1)], 2)
    expect(warnings).toEqual([])
    expect(componentVolume(piece.mesh) - before).toBeGreaterThan(95) // 10×10 mm × 1 mm
    expect(componentVolume(piece.mesh) - before).toBeLessThan(105)
    expect(topZ(piece.mesh)).toBeCloseTo(21, 4)
    expect(validateMesh(piece.mesh).isWatertight).toBe(true)
  })

  it('a thicker emboss adds proportionally more material', () => {
    const base = componentVolume(unitCube(20).mesh)
    const thin = engraveFace(unitCube(20), topFace(), [raised(0.5)], 2).piece
    const thick = engraveFace(unitCube(20), topFace(), [raised(1.5)], 2).piece
    expect(componentVolume(thick.mesh) - base).toBeGreaterThan(2.5 * (componentVolume(thin.mesh) - base))
  })

  it('caps the height so it stops short of another piece above, and warns', () => {
    const cube = unitCube(20)
    const lid = lidAbove(0.7)
    expect(freeSpace([cube.mesh, lid.mesh], topFace(), raised(1))).toBeCloseTo(0.7, 3)
    const { piece, warnings } = engraveFace(cube, topFace(), [raised(2)], 2, undefined, [lid.mesh])
    expect(warnings.some((w) => w.includes('WARN-HEIGHT'))).toBe(true)
    expect(topZ(piece.mesh)).toBeCloseTo(20.5, 3) // 0.7 free − 0.2 clearance
  })

  it('skips an emboss when there is no free space above it', () => {
    const cube = unitCube(20)
    const before = componentVolume(cube.mesh)
    const { piece, warnings } = engraveFace(cube, topFace(), [raised(1)], 2, undefined, [lidAbove(0.1).mesh])
    expect(warnings.some((w) => w.includes('no free space'))).toBe(true)
    expect(componentVolume(piece.mesh)).toBeCloseTo(before, 3)
  })

  it('mixes etched and embossed images on one face', () => {
    const cube = unitCube(20)
    const before = componentVolume(cube.mesh)
    const etch: Placement = { ...raised(1, 5, [-5, 0]), cut: { ...DEFAULT_CUT, depth: 1 } }
    const { piece, warnings } = engraveFace(cube, topFace(), [etch, raised(1, 5, [5, 0])], 2)
    expect(warnings).toEqual([])
    // −25 mm³ etched, +25 mm³ raised → about even; and the top reaches 21.
    expect(Math.abs(componentVolume(piece.mesh) - before)).toBeLessThan(2)
    expect(topZ(piece.mesh)).toBeCloseTo(21, 4)
    expect(validateMesh(piece.mesh).isWatertight).toBe(true)
  })
})

// --- fixtures ------------------------------------------------------------

function centeredPlacement(w: number, h: number, depth = 1): import('./types').Placement {
  return {
    center: [0, 0],
    size: [w, h],
    rotation: 0,
    image: solidBlackImage(16, 16),
    cut: { ...DEFAULT_CUT, depth }
  }
}

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
  return box(size, size, size)
}

/** The +Z top face (origin centered) of a box whose top sits at z = sz. */
function slabTopFace(sz: number): FacePlane {
  return { origin: [10, 10, sz], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0], triangles: [2, 3], pieceId: 0 }
}

/** An axis-aligned box [0,sx]×[0,sy]×[0,sz] as a watertight indexed MeshPiece. */
function box(sx: number, sy: number, sz: number): MeshPiece {
  const v = [
    0, 0, 0, sx, 0, 0, sx, sy, 0, 0, sy, 0, // bottom z=0
    0, 0, sz, sx, 0, sz, sx, sy, sz, 0, sy, sz // top z=sz
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
