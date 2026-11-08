import type { CutSettings, FacePlane, ImageSource, MeshPiece, ProjectState, Rect2, Vec2, Vec3 } from './types'

/**
 * Project file (de)serialization (SPEC §2.16 FR-PROJECT). A `.boxmaker` file is
 * a single self-contained JSON document: the template STL (base64), every
 * placed image (once, referenced by id), and the editable `ProjectState`
 * (placements, cut settings, de-etch regions, margin). Undo history is not
 * saved.
 *
 * UI-free: pixel encoding is injected (`ImageEncoder`/`ImageDecoder`) so this
 * module stays unit-testable without a canvas. Face triangle indices refer to
 * the pieces produced by welding + splitting the embedded template, which is
 * deterministic, so they remain valid on reload (see `checkProjectFits`).
 */

export const PROJECT_FORMAT = 'boxmaker-project'
export const PROJECT_VERSION = 1
export const PROJECT_EXTENSION = 'boxmaker'

export interface ProjectDocument {
  /** File name of the template STL the project was made from. */
  templateName: string
  /** Binary STL bytes of the template. */
  template: Uint8Array
  state: ProjectState
}

/** Encode an image's pixels to a string (e.g. a PNG data URL). */
export type ImageEncoder = (image: ImageSource) => Promise<string>
/** Inverse of `ImageEncoder`. */
export type ImageDecoder = (encoded: string) => Promise<ImageSource>

export async function serializeProject(doc: ProjectDocument, encode: ImageEncoder): Promise<string> {
  // Placements may share one decoded image by reference; store each once.
  const images: string[] = []
  const ids = new Map<ImageSource, number>()
  const imageId = async (img: ImageSource): Promise<number> => {
    let id = ids.get(img)
    if (id === undefined) {
      id = images.length
      images.push(await encode(img))
      ids.set(img, id)
    }
    return id
  }

  const faces: unknown[] = []
  for (const fw of doc.state.faces) {
    const placements: unknown[] = []
    for (const pl of fw.placements) {
      placements.push({
        center: [pl.center[0], pl.center[1]],
        size: [pl.size[0], pl.size[1]],
        rotation: pl.rotation,
        cut: { ...pl.cut },
        image: await imageId(pl.image)
      })
    }
    faces.push({ face: faceToJson(fw.face), placements })
  }

  const smoothed = doc.state.smoothed.map((sw) => ({
    face: faceToJson(sw.face),
    rects: sw.rects.map((r) => ({ min: [r.min[0], r.min[1]], max: [r.max[0], r.max[1]] }))
  }))

  return JSON.stringify({
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    template: { name: doc.templateName, data: toBase64(doc.template) },
    images,
    state: { marginMm: doc.state.marginMm, faces, smoothed }
  })
}

export async function deserializeProject(text: string, decode: ImageDecoder): Promise<ProjectDocument> {
  let root: unknown
  try {
    root = JSON.parse(text)
  } catch {
    throw new Error('Not a boxmaker project file (invalid JSON).')
  }
  const doc = rec(root, 'project')
  if (doc.format !== PROJECT_FORMAT) throw new Error('Not a boxmaker project file.')
  if (doc.version !== PROJECT_VERSION) {
    throw new Error(
      `Unsupported project version ${String(doc.version)} (this app reads version ${PROJECT_VERSION}).`
    )
  }

  const tpl = rec(doc.template, 'template')
  const template = fromBase64(str(tpl.data, 'template data'))
  const templateName = typeof tpl.name === 'string' && tpl.name ? tpl.name : 'template.stl'

  const encodedImages = arr(doc.images, 'images')
  const images: ImageSource[] = []
  for (const enc of encodedImages) images.push(await decode(str(enc, 'image')))

  const st = rec(doc.state, 'state')
  const faces = arr(st.faces, 'faces').map((f) => {
    const fw = rec(f, 'face entry')
    return {
      face: faceFromJson(fw.face),
      placements: arr(fw.placements, 'placements').map((p) => {
        const pl = rec(p, 'placement')
        const image = images[num(pl.image, 'image id')]
        if (!image) throw new Error('Project refers to a missing image.')
        return {
          center: vec2(pl.center, 'center'),
          size: vec2(pl.size, 'size'),
          rotation: num(pl.rotation, 'rotation'),
          image,
          cut: cutFromJson(pl.cut)
        }
      })
    }
  })
  const smoothed = arr(st.smoothed, 'smoothed').map((s) => {
    const sw = rec(s, 'de-etch entry')
    return {
      face: faceFromJson(sw.face),
      rects: arr(sw.rects, 'rects').map((r): Rect2 => {
        const rc = rec(r, 'rect')
        return { min: vec2(rc.min, 'rect.min'), max: vec2(rc.max, 'rect.max') }
      })
    }
  })

  return { templateName, template, state: { marginMm: num(st.marginMm, 'margin'), faces, smoothed } }
}

/**
 * Verify every saved face still points at real triangles of the freshly built
 * pieces. Returns a human-readable problem, or null when the project fits.
 */
export function checkProjectFits(pieces: MeshPiece[], state: ProjectState): string | null {
  const faces = [...state.faces.map((f) => f.face), ...state.smoothed.map((s) => s.face)]
  for (const face of faces) {
    const piece = pieces.find((p) => p.id === face.pieceId)
    if (!piece) return 'A saved face refers to a piece that is not in the embedded template.'
    const triCount = piece.mesh.indices.length / 3
    if (face.triangles.some((t) => !Number.isInteger(t) || t < 0 || t >= triCount)) {
      return 'A saved face does not match the embedded template geometry.'
    }
  }
  return null
}

// --- encoding helpers -----------------------------------------------------

function faceToJson(f: FacePlane): unknown {
  return {
    origin: [...f.origin],
    normal: [...f.normal],
    u: [...f.u],
    v: [...f.v],
    triangles: f.triangles,
    pieceId: f.pieceId
  }
}

function faceFromJson(x: unknown): FacePlane {
  const f = rec(x, 'face')
  return {
    origin: vec3(f.origin, 'origin'),
    normal: vec3(f.normal, 'normal'),
    u: vec3(f.u, 'u'),
    v: vec3(f.v, 'v'),
    triangles: arr(f.triangles, 'triangles').map((t) => num(t, 'triangle')),
    pieceId: num(f.pieceId, 'pieceId')
  }
}

function cutFromJson(x: unknown): CutSettings {
  const c = rec(x, 'cut settings')
  return {
    threshold: num(c.threshold, 'threshold'),
    invert: c.invert === true,
    depth: num(c.depth, 'depth'),
    smoothing: num(c.smoothing, 'smoothing')
  }
}

function toBase64(bytes: Uint8Array): string {
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

// --- validation helpers ---------------------------------------------------

function rec(x: unknown, what: string): Record<string, unknown> {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) throw new Error(`Corrupt project: bad ${what}.`)
  return x as Record<string, unknown>
}
function arr(x: unknown, what: string): unknown[] {
  if (!Array.isArray(x)) throw new Error(`Corrupt project: bad ${what}.`)
  return x
}
function str(x: unknown, what: string): string {
  if (typeof x !== 'string') throw new Error(`Corrupt project: bad ${what}.`)
  return x
}
function num(x: unknown, what: string): number {
  if (typeof x !== 'number' || !Number.isFinite(x)) throw new Error(`Corrupt project: bad ${what}.`)
  return x
}
function vec2(x: unknown, what: string): Vec2 {
  const a = arr(x, what)
  if (a.length !== 2) throw new Error(`Corrupt project: bad ${what}.`)
  return [num(a[0], what), num(a[1], what)]
}
function vec3(x: unknown, what: string): Vec3 {
  const a = arr(x, what)
  if (a.length !== 3) throw new Error(`Corrupt project: bad ${what}.`)
  return [num(a[0], what), num(a[1], what), num(a[2], what)]
}
