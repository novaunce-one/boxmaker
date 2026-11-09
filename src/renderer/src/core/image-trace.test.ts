import { describe, expect, it } from 'vitest'
import { buildField, gaussianBlur, previewContours, traceSmoothContours, type Contour } from './image-trace'
import { DEFAULT_CUT, type ImageSource, type Placement } from './types'

/** Opaque grayscale image from a per-pixel luminance function. */
function image(w: number, h: number, lum: (x: number, y: number) => number): ImageSource {
  const rgba = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = lum(x, y)
      const o = (y * w + x) * 4
      rgba[o] = rgba[o + 1] = rgba[o + 2] = v
      rgba[o + 3] = 255
    }
  return { width: w, height: h, rgba }
}

const cut = (smoothing: number, invert = false): typeof DEFAULT_CUT => ({
  ...DEFAULT_CUT,
  smoothing,
  invert
})

/** Net enclosed area (outer rings minus holes) of normalized rings scaled to mm. */
function areaMm(rings: Contour[], size: [number, number]): number {
  let sum = 0
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const [x0, y0] = ring[i]
      const [x1, y1] = ring[(i + 1) % ring.length]
      sum += x0 * y1 - x1 * y0
    }
  }
  return Math.abs(sum / 2) * size[0] * size[1]
}

/** Std-dev of point distances from the shape centre: 0 for a perfect circle. */
function radialRoughness(rings: Contour[], size: [number, number]): number {
  const pts = rings.flat().map(([x, y]) => [x * size[0], y * size[1]])
  const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length
  const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length
  const r = pts.map(([x, y]) => Math.hypot(x - cx, y - cy))
  const mean = r.reduce((s, v) => s + v, 0) / r.length
  return Math.sqrt(r.reduce((s, v) => s + (v - mean) ** 2, 0) / r.length)
}

describe('traceSmoothContours (FR-IMG-5)', () => {
  it('traces a solid block to about its true area', () => {
    const img = image(20, 20, (x, y) => (x >= 5 && x < 15 && y >= 5 && y < 15 ? 0 : 255))
    const rings = traceSmoothContours(img, cut(0), [20, 20])
    expect(rings).toHaveLength(1)
    expect(areaMm(rings, [20, 20])).toBeGreaterThan(95)
    expect(areaMm(rings, [20, 20])).toBeLessThan(105)
  })

  it('keeps a hole as a second ring', () => {
    const img = image(30, 30, (x, y) => {
      const inOuter = x >= 3 && x < 27 && y >= 3 && y < 27
      const inHole = x >= 12 && x < 18 && y >= 12 && y < 18
      return inOuter && !inHole ? 0 : 255
    })
    const rings = traceSmoothContours(img, cut(0), [30, 30])
    expect(rings).toHaveLength(2)
    // 24×24 outer minus 6×6 hole
    expect(areaMm(rings, [30, 30])).toBeGreaterThan(520)
    expect(areaMm(rings, [30, 30])).toBeLessThan(545)
  })

  it('a pixelated circle is much rounder with smoothing than as raw pixels', () => {
    const img = image(24, 24, (x, y) => (Math.hypot(x + 0.5 - 12, y + 0.5 - 12) < 9 ? 0 : 255))
    const raw = radialRoughness(traceSmoothContours(img, cut(0), [24, 24]), [24, 24])
    const smooth = radialRoughness(traceSmoothContours(img, cut(1), [24, 24]), [24, 24])
    expect(raw).toBeGreaterThan(0.1)
    expect(smooth).toBeLessThan(raw * 0.6)
    expect(smooth).toBeLessThan(0.15)
    // …without shrinking or growing the shape noticeably (π·9² ≈ 254)
    const area = areaMm(traceSmoothContours(img, cut(1), [24, 24]), [24, 24])
    expect(area).toBeGreaterThan(235)
    expect(area).toBeLessThan(270)
  })

  it('places an anti-aliased edge at a sub-pixel position', () => {
    // Luminance ramps 0→255 over 11 px; the 128 threshold sits ~half-way across.
    const img = image(11, 4, (x) => Math.round((x / 10) * 255))
    const rings = traceSmoothContours(img, cut(0), [11, 4])
    // Points strictly between the top and bottom rows lie on the traced threshold line.
    const inner = rings
      .flat()
      .filter(([, y]) => y > 0.01 && y < 0.99)
      .map(([x]) => x * 11)
      .filter((x) => x > 0.01) // drop points clamped to the image's left border
    expect(inner.length).toBeGreaterThan(0)
    for (const x of inner) expect(Math.abs(x - 5.5)).toBeLessThan(0.15)
  })

  it('Invert swaps which side is artwork', () => {
    const black = image(8, 8, () => 0)
    expect(traceSmoothContours(black, cut(0), [8, 8])).toHaveLength(1)
    expect(traceSmoothContours(black, cut(0, true), [8, 8])).toHaveLength(0)
  })

  it('every ring is closed with at least 3 points and stays inside [0,1]', () => {
    const img = image(16, 16, (x, y) => ((x + y) % 5 === 0 ? 0 : 255))
    for (const s of [0, 0.5]) {
      for (const ring of traceSmoothContours(img, cut(s), [16, 16])) {
        expect(ring.length).toBeGreaterThanOrEqual(3)
        for (const [x, y] of ring) {
          expect(x).toBeGreaterThanOrEqual(0)
          expect(x).toBeLessThanOrEqual(1)
          expect(y).toBeGreaterThanOrEqual(0)
          expect(y).toBeLessThanOrEqual(1)
        }
      }
    }
  })
})

describe('field helpers', () => {
  it('buildField is signed by threshold and flips with Invert', () => {
    const img = image(2, 1, (x) => (x === 0 ? 0 : 255))
    const f = buildField(img, { threshold: 128, invert: false })
    expect(f.values[0]).toBeGreaterThan(0) // dark = artwork
    expect(f.values[1]).toBeLessThan(0)
    const g = buildField(img, { threshold: 128, invert: true })
    expect(g.values[0]).toBeLessThan(0)
    expect(g.values[1]).toBeGreaterThan(0)
  })

  it('gaussianBlur preserves the mean and spreads a spike', () => {
    const values = new Float32Array(15 * 15)
    values[7 * 15 + 7] = 25
    const out = gaussianBlur({ width: 15, height: 15, values }, 1)
    const sum = Array.from(out.values).reduce((a, b) => a + b, 0)
    expect(sum).toBeCloseTo(25, 1)
    expect(out.values[7 * 15 + 7]).toBeLessThan(25)
    expect(out.values[7 * 15 + 6]).toBeGreaterThan(0)
  })
})

describe('previewContours cache', () => {
  const pl = (smoothing: number): Placement => ({
    center: [0, 0],
    size: [10, 10],
    rotation: 0,
    image: image(10, 10, (x) => (x < 5 ? 0 : 255)),
    cut: { ...DEFAULT_CUT, smoothing }
  })

  it('reuses the trace for the same settings and retraces when smoothing changes', () => {
    const a = pl(0.3)
    expect(previewContours(a)).toBe(previewContours({ image: a.image, size: [9.9, 9.9], cut: a.cut }))
    const b = { ...a, cut: { ...a.cut, smoothing: 0.6 } }
    expect(previewContours(b)).not.toBe(previewContours(a))
  })
})
