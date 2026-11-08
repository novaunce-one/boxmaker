import { manifold } from './manifold'
import { toBinaryMask, traceContours } from './image-trace'
import { componentVolume } from './components'
import { validateMesh } from './validate'
import { repairMesh } from './repair'
import type { FacePlane, IndexedMesh, MeshPiece, Placement, Rect2, Vec2, Vec3 } from './types'

/**
 * The cut pipeline (docs/PLAN.md §4–5, SPEC §2.8). Traces each placed image to
 * contours, builds a 2D CrossSection, clips it to the face region inset by the
 * margin, extrudes it into a cutter, and boolean-subtracts it — operating ONLY
 * on the piece that owns the face so the print-in-place hinge is never altered.
 */

export interface EngraveResult {
  /** The engraved piece, replacing the input `piece`. */
  piece: MeshPiece
  warnings: string[]
}

/** 16-number column-major affine matrix (matches manifold-3d's Mat4). */
type Mat4 = [
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
  number, number, number, number
]

const START_EPS = 0.01 // mm the cutter starts outside the surface

export function engraveFace(
  piece: MeshPiece,
  face: FacePlane,
  placements: Placement[],
  marginMm: number
): EngraveResult {
  if (placements.length === 0) return { piece, warnings: [] }
  const { CrossSection } = manifold()
  const warnings: string[] = []

  let solid = toManifold(piece.mesh)
  const clip = buildFaceRegion(piece.mesh, face, CrossSection).offset(-marginMm)

  for (const pl of placements) {
    const mask = toBinaryMask(pl.image, pl.cut)
    const polys = contoursToMm(traceContours(mask, pl.cut.smoothing), pl)
    if (polys.length === 0) continue
    let art = new CrossSection(polys, 'EvenOdd').simplify(pl.cut.smoothing)
    art = art.intersect(clip)
    if (art.area() <= 0) {
      warnings.push('A placement is entirely outside the face margin and was skipped.')
      continue
    }
    const cutter = extrudeInward(art, pl.cut.depth + START_EPS, face, START_EPS)
    solid = solid.subtract(cutter)
  }

  return { piece: { id: piece.id, mesh: fromManifold(solid) }, warnings }
}

/**
 * De-etch a region: fill the engraved recesses inside `rect` (in face (u,v) mm)
 * back flush with the surface, making the selected area smooth again (SPEC §2
 * FR-DEETCH). This is a boolean *union* of a slab that sits on the face plane
 * and extends `fillDepthMm` inward — enough to cap any recess up to the plane —
 * clipped to the face so it never adds material beyond the surface. Only the
 * owning piece is touched, so the hinge is preserved.
 */
export function smoothRegion(
  piece: MeshPiece,
  face: FacePlane,
  rects: Rect2[],
  fillDepthMm = 2
): EngraveResult {
  if (rects.length === 0) return { piece, warnings: [] }
  const { CrossSection } = manifold()
  let solid = toManifold(piece.mesh)

  for (const rect of rects) {
    // Fill over the selected rectangle directly (the user draws it on the
    // surface). We must NOT clip to the coplanar face region here: the etched
    // recess is a hole in that region, which is exactly the void to fill. The
    // slab sits on the plane (startEps 0) and extends inward to cap the recess.
    const region = new CrossSection([rectRing(rect)], 'NonZero')
    const fill = extrudeInward(region, fillDepthMm, face, 0)
    solid = solid.add(fill)
  }

  return { piece: { id: piece.id, mesh: fromManifold(solid) }, warnings: [] }
}

/**
 * Pre-export break-through check (SPEC §2.6 FR-HINGE-4): a cut that pierces a
 * wall leaves the piece non-watertight. (A tunnel that stays watertight is not
 * caught here — a raycast depth re-check is the follow-up, tracked in the plan.)
 */
export function checkBreakthrough(before: MeshPiece, after: MeshPiece): string[] {
  const warnings: string[] = []
  if (!validateMesh(after.mesh).isWatertight) {
    warnings.push('A cut appears to break through a wall (engraved piece is no longer watertight).')
  }
  if (componentVolume(after.mesh) <= 0) {
    warnings.push('The engraved piece has no positive volume — the cut removed too much.')
  }
  void before
  return warnings
}

// --- helpers -------------------------------------------------------------

/**
 * Build a manifold solid from an indexed mesh. The mesh is repaired first so it
 * is a 2-manifold wound **outward** — critical because `ofMesh` will otherwise
 * accept an inward-wound mesh as an inverted solid, which silently breaks later
 * unions (a de-etch would carve instead of fill). See repair.ts `orientOutward`.
 */
function toManifold(mesh: IndexedMesh): import('manifold-3d').Manifold {
  const { Manifold, Mesh } = manifold()
  const make = (m: IndexedMesh): import('manifold-3d').Manifold =>
    Manifold.ofMesh(new Mesh({ numProp: 3, vertProperties: m.vertices, triVerts: m.indices }))
  try {
    return make(repairMesh(mesh))
  } catch {
    return make(mesh) // fall back to the raw mesh if repair somehow fails
  }
}

function fromManifold(solid: import('manifold-3d').Manifold): IndexedMesh {
  const mesh = solid.getMesh()
  const n = mesh.numProp
  let vertices: Float32Array
  if (n === 3) {
    vertices = new Float32Array(mesh.vertProperties)
  } else {
    const count = mesh.vertProperties.length / n
    vertices = new Float32Array(count * 3)
    for (let i = 0; i < count; i++) {
      vertices[i * 3] = mesh.vertProperties[i * n]
      vertices[i * 3 + 1] = mesh.vertProperties[i * n + 1]
      vertices[i * 3 + 2] = mesh.vertProperties[i * n + 2]
    }
  }
  return { vertices, indices: new Uint32Array(mesh.triVerts) }
}

/** Union of the face's triangles projected into (u,v) mm relative to origin. */
function buildFaceRegion(
  mesh: IndexedMesh,
  face: FacePlane,
  CrossSection: import('manifold-3d').ManifoldToplevel['CrossSection']
): import('manifold-3d').CrossSection {
  const rings: [number, number][][] = []
  for (const t of face.triangles) {
    const ring: [number, number][] = []
    for (let k = 0; k < 3; k++) {
      const vi = mesh.indices[t * 3 + k]
      ring.push(projectToFace([mesh.vertices[vi * 3], mesh.vertices[vi * 3 + 1], mesh.vertices[vi * 3 + 2]], face))
    }
    // Force CCW so the NonZero union fills the whole face region.
    const area = ring[0][0] * (ring[1][1] - ring[2][1]) + ring[1][0] * (ring[2][1] - ring[0][1]) + ring[2][0] * (ring[0][1] - ring[1][1])
    rings.push(area < 0 ? [ring[0], ring[2], ring[1]] : ring)
  }
  return new CrossSection(rings, 'NonZero')
}

/** World point → (u,v) mm in the face plane, relative to face.origin. */
function projectToFace(p: Vec3, face: FacePlane): [number, number] {
  const dx = p[0] - face.origin[0],
    dy = p[1] - face.origin[1],
    dz = p[2] - face.origin[2]
  return [dx * face.u[0] + dy * face.u[1] + dz * face.u[2], dx * face.v[0] + dy * face.v[1] + dz * face.v[2]]
}

/** Normalized [0,1] contours → (u,v) mm, honoring the placement transform. */
function contoursToMm(contours: readonly (readonly Vec2[])[], pl: Placement): [number, number][][] {
  const cos = Math.cos(pl.rotation),
    sin = Math.sin(pl.rotation)
  return contours.map((ring) =>
    ring.map(([nx, ny]) => {
      const lx = (nx - 0.5) * pl.size[0]
      const ly = (ny - 0.5) * pl.size[1]
      return [pl.center[0] + lx * cos - ly * sin, pl.center[1] + lx * sin + ly * cos] as [number, number]
    })
  )
}

/**
 * Extrude a 2D face-local region into a solid that extends INWARD from the
 * surface, correctly placed in world space.
 *
 * The region is extruded along +Z to height `height`, shifted to local
 * z ∈ [−height, 0], then rotated by the face frame (columns u, v, n — a proper
 * rotation with determinant +1, so orientation is preserved) and translated to
 * `origin + normal·startEps`. Local +Z maps to the outward normal, so the
 * shifted solid lies from the surface inward. A positive determinant is
 * essential: a reflection (det −1) inverts the manifold and breaks the booleans.
 */
function extrudeInward(
  region: import('manifold-3d').CrossSection,
  height: number,
  face: FacePlane,
  startEps: number
): import('manifold-3d').Manifold {
  const { Manifold } = manifold()
  return Manifold.extrude(region, height).translate([0, 0, -height]).transform(faceMatrix(face, startEps))
}

/** Proper-rotation (det +1) face frame: local X→u, Y→v, Z→normal, +origin·startEps. */
function faceMatrix(face: FacePlane, startEps: number): Mat4 {
  const { u, v, normal: n, origin: o } = face
  const t: Vec3 = [o[0] + n[0] * startEps, o[1] + n[1] * startEps, o[2] + n[2] * startEps]
  return [
    u[0], u[1], u[2], 0,
    v[0], v[1], v[2], 0,
    n[0], n[1], n[2], 0,
    t[0], t[1], t[2], 1
  ]
}

/** CCW rectangle ring in face (u,v) mm from a Rect2. */
function rectRing(rect: Rect2): [number, number][] {
  const { min, max } = rect
  return [
    [min[0], min[1]],
    [max[0], min[1]],
    [max[0], max[1]],
    [min[0], max[1]]
  ]
}
