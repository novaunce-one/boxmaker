import type { FacePlane, IndexedMesh, Vec3 } from './types'

/**
 * Face detection and the face coordinate frame (docs/PLAN.md §4).
 *
 * Z-up is assumed throughout (the viewer sets `camera.up = (0,0,1)`). The
 * basis is chosen so the engraved image reads correctly from outside the box:
 * `u × v === normal`.
 */

const EPS = 1e-6

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
function normalize(a: Vec3): Vec3 {
  const l = Math.hypot(a[0], a[1], a[2]) || 1
  return [a[0] / l, a[1] / l, a[2] / l]
}
function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

/**
 * In-plane basis (u, v) for a face with outward normal `n`.
 * - Side faces: v = world Z projected onto the plane; u = v × n.
 * - Top/bottom (n ≈ ±Z): v = world +Y; u = v × n.
 */
export function faceBasis(n: Vec3): { u: Vec3; v: Vec3 } {
  const normal = normalize(n)
  const up: Vec3 = Math.abs(normal[2]) > 0.99 ? [0, 1, 0] : [0, 0, 1]
  // Project `up` onto the plane to get v, then u completes a right-handed frame.
  const dot = up[0] * normal[0] + up[1] * normal[1] + up[2] * normal[2]
  const v = normalize([up[0] - dot * normal[0], up[1] - dot * normal[1], up[2] - dot * normal[2]])
  const u = normalize(cross(v, normal))
  return { u, v }
}

function triNormal(m: IndexedMesh, t: number): Vec3 {
  const ia = m.indices[t * 3],
    ib = m.indices[t * 3 + 1],
    ic = m.indices[t * 3 + 2]
  const a: Vec3 = [m.vertices[ia * 3], m.vertices[ia * 3 + 1], m.vertices[ia * 3 + 2]]
  const b: Vec3 = [m.vertices[ib * 3], m.vertices[ib * 3 + 1], m.vertices[ib * 3 + 2]]
  const c: Vec3 = [m.vertices[ic * 3], m.vertices[ic * 3 + 1], m.vertices[ic * 3 + 2]]
  return normalize(cross(sub(b, a), sub(c, a)))
}

function triCentroid(m: IndexedMesh, t: number): Vec3 {
  const ia = m.indices[t * 3],
    ib = m.indices[t * 3 + 1],
    ic = m.indices[t * 3 + 2]
  return [
    (m.vertices[ia * 3] + m.vertices[ib * 3] + m.vertices[ic * 3]) / 3,
    (m.vertices[ia * 3 + 1] + m.vertices[ib * 3 + 1] + m.vertices[ic * 3 + 1]) / 3,
    (m.vertices[ia * 3 + 2] + m.vertices[ib * 3 + 2] + m.vertices[ic * 3 + 2]) / 3
  ]
}

/**
 * Flood-fill the coplanar face containing `seedTriangle`: grow across triangles
 * that share an edge and have (nearly) the same normal and plane offset.
 *
 * `angleTol` in degrees; `planeTol` in mm.
 */
export function detectFace(
  mesh: IndexedMesh,
  seedTriangle: number,
  pieceId: number,
  angleTol = 1,
  planeTol = 0.05
): FacePlane {
  const normal = triNormal(mesh, seedTriangle)
  const origin = triCentroid(mesh, seedTriangle)
  const offset = origin[0] * normal[0] + origin[1] * normal[1] + origin[2] * normal[2]
  const cosTol = Math.cos((angleTol * Math.PI) / 180)

  const adjacency = buildEdgeAdjacency(mesh)
  const triangles: number[] = []
  const seen = new Set<number>()
  const stack = [seedTriangle]
  while (stack.length) {
    const t = stack.pop()!
    if (seen.has(t)) continue
    seen.add(t)

    const nt = triNormal(mesh, t)
    const align = nt[0] * normal[0] + nt[1] * normal[1] + nt[2] * normal[2]
    if (align < cosTol) continue
    const ct = triCentroid(mesh, t)
    const d = ct[0] * normal[0] + ct[1] * normal[1] + ct[2] * normal[2]
    if (Math.abs(d - offset) > planeTol) continue

    triangles.push(t)
    for (const nb of adjacency.get(t) ?? []) if (!seen.has(nb)) stack.push(nb)
  }

  const { u, v } = faceBasis(normal)
  return { origin, normal, u, v, triangles, pieceId }
}

/** Map each triangle to its edge-adjacent triangles (shared vertex-index edge). */
function buildEdgeAdjacency(mesh: IndexedMesh): Map<number, number[]> {
  const edgeMap = new Map<string, number[]>()
  const tris = mesh.indices.length / 3
  const key = (a: number, b: number): string => (a < b ? `${a}_${b}` : `${b}_${a}`)
  for (let t = 0; t < tris; t++) {
    const a = mesh.indices[t * 3],
      b = mesh.indices[t * 3 + 1],
      c = mesh.indices[t * 3 + 2]
    for (const [i, j] of [
      [a, b],
      [b, c],
      [c, a]
    ]) {
      const k = key(i, j)
      let list = edgeMap.get(k)
      if (!list) edgeMap.set(k, (list = []))
      list.push(t)
    }
  }
  const adj = new Map<number, number[]>()
  for (const tsel of edgeMap.values()) {
    for (const t of tsel) {
      let list = adj.get(t)
      if (!list) adj.set(t, (list = []))
      for (const other of tsel) if (other !== t && Math.abs(other - t) > EPS) list.push(other)
    }
  }
  return adj
}
