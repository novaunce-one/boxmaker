import { beforeAll, describe, expect, it } from 'vitest'
import { initManifold, manifold } from './manifold'
import { componentVolume } from './components'
import { fromManifold } from './engrave'
import { applyExportScale, measureExactGap, restoreClearance, scaleMeshes } from './scale-export'
import type { MeshPiece } from './types'

/** An axis-aligned box piece spanning [x, x+size] × [0, size] × [0, size]. */
function box(id: number, x: number, size = 20): MeshPiece {
  const { Manifold } = manifold()
  return { id, mesh: fromManifold(Manifold.cube([size, size, size], false).translate([x, 0, 0])) }
}

function bbox(p: MeshPiece): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  const v = p.mesh.vertices
  for (let i = 0; i < v.length; i += 3)
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], v[i + k])
      max[k] = Math.max(max[k], v[i + k])
    }
  return { min, max }
}

describe('export scale + hinge-gap restoration (FR-SCALE)', () => {
  beforeAll(async () => {
    await initManifold()
  })

  it('scaleMeshes scales uniformly about the min corner (stays on the bed)', () => {
    const [a, b] = scaleMeshes([box(0, 5), box(1, 40)], 0.5)
    expect(bbox(a).min).toEqual([5, 0, 0])
    expect(bbox(a).max).toEqual([15, 10, 10])
    expect(bbox(b).max[0]).toBeCloseTo(5 + (60 - 5) * 0.5, 4)
  })

  it('measures the exact gap between pieces', () => {
    const gap = measureExactGap([box(0, 0), box(1, 20.3)])
    expect(gap.minGap).toBeCloseTo(0.3, 3)
    expect(gap.betweenPieces).toEqual([0, 1])
  })

  it('re-opens a gap that scaling shrank below the target', () => {
    const pieces = [box(0, 0), box(1, 20.3)]
    const target = measureExactGap(pieces).minGap // template's own gap
    const scaled = scaleMeshes(pieces, 0.8)
    expect(measureExactGap(scaled).minGap).toBeCloseTo(target * 0.8, 3) // too tight now

    const r = restoreClearance(scaled, target)
    expect(r.carved).toBe(true)
    expect(r.warnings).toEqual([])
    expect(measureExactGap(r.pieces).minGap).toBeGreaterThanOrEqual(target - 1e-3)
    // Only a thin shell is removed: the volume loss is tiny.
    const lost = componentVolume(scaled[0].mesh) + componentVolume(scaled[1].mesh) -
      componentVolume(r.pieces[0].mesh) - componentVolume(r.pieces[1].mesh)
    expect(lost).toBeGreaterThan(0)
    // ~0.075 mm deep across the 16×16 mm facing wall (target×1.05 − scaled gap).
    expect(lost).toBeLessThan(0.1 * 16 * 16)
  })

  it('carves nothing when the gap is already large enough (scale-up / far pieces)', () => {
    const pieces = [box(0, 0), box(1, 20.3)]
    const target = measureExactGap(pieces).minGap
    const up = scaleMeshes(pieces, 1.5)
    const r = restoreClearance(up, target)
    expect(r.carved).toBe(false)
    expect(r.pieces[0].mesh).toBe(up[0].mesh)
    expect(r.pieces[1].mesh).toBe(up[1].mesh)

    const far = restoreClearance([box(0, 0), box(1, 80)], 0.3)
    expect(far.carved).toBe(false)
    expect(far.gapAfter).toBe(Infinity)
  })

  it('applyExportScale is a no-op at 100% unless a gap target is requested', () => {
    const pieces = [box(0, 0), box(1, 20.3)]
    const same = applyExportScale(pieces, 1, null)
    expect(same.pieces).toBe(pieces)
    expect(same.notes).toEqual([])

    const target = measureExactGap(pieces).minGap
    const atTemplate = applyExportScale(pieces, 1, target)
    expect(atTemplate.notes).toEqual([]) // gap already meets the template's own gap
    expect(atTemplate.pieces[0].mesh).toBe(pieces[0].mesh)

    const wider = applyExportScale(pieces, 1, 0.5) // user asks for a bigger gap
    expect(measureExactGap(wider.pieces).minGap).toBeGreaterThanOrEqual(0.5 - 1e-3)
    expect(wider.notes.join(' ')).toMatch(/re-opened/)
  })

  it('applyExportScale scales then restores, reporting both', () => {
    const pieces = [box(0, 0), box(1, 20.3)]
    const r = applyExportScale(pieces, 0.8, 0.3)
    expect(r.notes[0]).toBe('Scaled to 80%.')
    expect(r.notes[1]).toMatch(/Hinge gap re-opened to 0\.3\d mm/)
    expect(measureExactGap(r.pieces).minGap).toBeGreaterThanOrEqual(0.3 - 1e-3)
    expect(bbox(r.pieces[1]).max[0]).toBeCloseTo(40.3 * 0.8, 3)
  })
})
