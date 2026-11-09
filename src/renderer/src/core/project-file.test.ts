import { describe, expect, it } from 'vitest'
import {
  checkProjectFits,
  deserializeProject,
  serializeProject,
  type ImageDecoder,
  type ImageEncoder
} from './project-file'
import { DEFAULT_CUT, EMPTY_PROJECT, type FacePlane, type ImageSource, type MeshPiece, type ProjectState } from './types'

// Fake pixel codec: no canvas needed in the Node test environment.
const encode: ImageEncoder = async (img) => `${img.width}x${img.height}:${Array.from(img.rgba).join(',')}`
const decode: ImageDecoder = async (s) => {
  const [dims, px] = s.split(':')
  const [width, height] = dims.split('x').map(Number)
  return { width, height, rgba: new Uint8ClampedArray(px.split(',').map(Number)) }
}

const face = (pieceId = 0, triangles = [2, 3]): FacePlane => ({
  origin: [10, 10, 20],
  normal: [0, 0, 1],
  u: [1, 0, 0],
  v: [0, 1, 0],
  triangles,
  pieceId
})

function sampleState(): { state: ProjectState; shared: ImageSource } {
  const shared: ImageSource = { width: 1, height: 2, rgba: new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255]) }
  const state: ProjectState = {
    marginMm: 3,
    exportScale: 0.8,
    hingeGapMm: 0.3,
    faces: [
      {
        face: face(),
        placements: [
          { center: [1, 2], size: [10, 20], rotation: 0.5, image: shared, cut: { ...DEFAULT_CUT, depth: 0.4, invert: true } },
          { center: [-1, -2], size: [5, 10], rotation: 0, image: shared, cut: { ...DEFAULT_CUT } }
        ]
      }
    ],
    smoothed: [{ face: face(1, [0]), rects: [{ min: [-1, -2], max: [3, 4] }] }]
  }
  return { state, shared }
}

describe('project file (FR-PROJECT)', () => {
  it('round-trips template, placements, cut settings, and de-etch regions', async () => {
    const { state } = sampleState()
    const template = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255])
    const text = await serializeProject({ templateName: 'box.stl', template, state }, encode)
    const back = await deserializeProject(text, decode)

    expect(back.templateName).toBe('box.stl')
    expect(Array.from(back.template)).toEqual(Array.from(template))
    expect(back.state.marginMm).toBe(3)
    expect(back.state.exportScale).toBe(0.8)
    expect(back.state.hingeGapMm).toBe(0.3)
    expect(back.state.faces[0].face).toEqual(state.faces[0].face)
    expect(back.state.faces[0].placements[0]).toMatchObject({
      center: [1, 2],
      size: [10, 20],
      rotation: 0.5,
      cut: { ...DEFAULT_CUT, depth: 0.4, invert: true }
    })
    expect(back.state.smoothed[0].rects).toEqual(state.smoothed[0].rects)
    expect(back.state.smoothed[0].face.pieceId).toBe(1)
  })

  it('stores a shared image once and keeps it shared after loading', async () => {
    const { state, shared } = sampleState()
    const text = await serializeProject({ templateName: 't.stl', template: new Uint8Array(4), state }, encode)
    expect(JSON.parse(text).images).toHaveLength(1)

    const back = await deserializeProject(text, decode)
    const [a, b] = back.state.faces[0].placements
    expect(a.image).toBe(b.image)
    expect(Array.from(a.image.rgba)).toEqual(Array.from(shared.rgba))
  })

  it('handles large templates (base64 chunking)', async () => {
    const template = new Uint8Array(200_000).map((_, i) => i % 256)
    const text = await serializeProject(
      { templateName: 't.stl', template, state: { ...EMPTY_PROJECT } },
      encode
    )
    const back = await deserializeProject(text, decode)
    expect(back.template.length).toBe(template.length)
    expect(back.template[199_999]).toBe(template[199_999])
  })

  it('opens older projects without export settings at 100% / template gap', async () => {
    const { state } = sampleState()
    const text = await serializeProject({ templateName: 't.stl', template: new Uint8Array(4), state }, encode)
    const legacy = JSON.parse(text)
    delete legacy.state.exportScale
    delete legacy.state.hingeGapMm
    const back = await deserializeProject(JSON.stringify(legacy), decode)
    expect(back.state.exportScale).toBe(1)
    expect(back.state.hingeGapMm).toBeNull()

    legacy.state.exportScale = 99
    await expect(deserializeProject(JSON.stringify(legacy), decode)).rejects.toThrow(/scale/)
  })

  it('rejects files that are not projects or are the wrong version', async () => {
    await expect(deserializeProject('not json', decode)).rejects.toThrow(/invalid JSON/)
    await expect(deserializeProject('{"format":"nope"}', decode)).rejects.toThrow(/Not a boxmaker/)
    await expect(deserializeProject('{"format":"boxmaker-project","version":99}', decode)).rejects.toThrow(
      /Unsupported project version/
    )
  })

  it('rejects structurally corrupt projects', async () => {
    const { state } = sampleState()
    const text = await serializeProject({ templateName: 't.stl', template: new Uint8Array(4), state }, encode)
    const bad = JSON.parse(text)
    bad.state.faces[0].placements[0].image = 7 // no such image
    await expect(deserializeProject(JSON.stringify(bad), decode)).rejects.toThrow(/missing image/)
  })

  it('checkProjectFits flags faces that do not match the template', () => {
    const { state } = sampleState()
    const mesh = { vertices: new Float32Array(9), indices: new Uint32Array([0, 1, 2, 0, 1, 2, 0, 1, 2, 0, 1, 2]) }
    const pieces: MeshPiece[] = [
      { id: 0, mesh },
      { id: 1, mesh }
    ]
    expect(checkProjectFits(pieces, state)).toBeNull() // triangles 0..3 exist
    expect(checkProjectFits([pieces[0]], state)).toMatch(/piece/)
    state.faces[0].face.triangles = [99]
    expect(checkProjectFits(pieces, state)).toMatch(/geometry/)
  })
})
