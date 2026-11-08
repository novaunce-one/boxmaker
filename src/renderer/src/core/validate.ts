import type { IndexedMesh } from './types'

/**
 * Mesh validation for clean export (SPEC §2 `FR-VALIDATE`).
 *
 * Detects the defect classes that online STL repair tools (e.g.
 * formware.co/onlinestlrepair) fix, so an exported boxmaker STL needs no such
 * round-trip:
 *   - degenerate (zero-area) triangles
 *   - duplicate triangles
 *   - boundary edges  → holes / not watertight
 *   - non-manifold edges (shared by > 2 triangles)
 *   - non-manifold vertices ("bowties": incident faces form > 1 fan)
 *   - inconsistent triangle winding (flipped / reversed faces)
 *   - unreferenced vertices
 *   - non-finite (NaN/Inf) vertex coordinates
 *   - sliver triangles (valid but near-degenerate; a print-quality warning)
 *
 * Self-intersection detection is intentionally omitted: manifold-3d guarantees
 * the booleaned piece is non-self-intersecting, and checking it on pass-through
 * pieces is O(n²) with little payoff. It is noted as a limitation in the SPEC.
 */

export interface MeshDiagnostics {
  triangleCount: number
  vertexCount: number
  /** Triangle indices with (near) zero area. */
  degenerateTriangles: number[]
  /** Count of triangles that duplicate an earlier triangle (same vertex set). */
  duplicateTriangles: number
  /** Edges used by exactly one triangle — open boundaries / holes. */
  boundaryEdges: number
  /** Edges shared by three or more triangles — non-manifold. */
  nonManifoldEdges: number
  /** Vertices whose incident faces form more than one fan ("bowties"). */
  nonManifoldVertices: number
  /** A manifold edge whose two triangles traverse it the same way (bad winding). */
  inconsistentlyOrientedEdges: number
  /** Vertices not referenced by any triangle. */
  unreferencedVertices: number
  /** Vertices with a NaN or Infinity coordinate. */
  nanVertices: number
  /** Non-degenerate but very thin triangles (shape quality below threshold). */
  sliverTriangles: number[]
  /** Closed surface: no boundary and no non-manifold edges. */
  isWatertight: boolean
  /** Every edge/vertex is manifold and triangles are consistently wound. */
  isManifold: boolean
}

const AREA_EPS = 1e-10
/** Normalized shape quality below this flags a sliver (1 = equilateral). */
const SLIVER_QUALITY = 0.01

/** Undirected edge key for a vertex-index pair. */
function edgeKey(a: number, b: number): number {
  // Pack two 32-bit-ish indices into one number (safe for < 2^26 verts).
  return a < b ? a * 67108864 + b : b * 67108864 + a
}

function triArea2(m: IndexedMesh, t: number): number {
  const ia = m.indices[t * 3],
    ib = m.indices[t * 3 + 1],
    ic = m.indices[t * 3 + 2]
  const ax = m.vertices[ia * 3],
    ay = m.vertices[ia * 3 + 1],
    az = m.vertices[ia * 3 + 2]
  const bx = m.vertices[ib * 3] - ax,
    by = m.vertices[ib * 3 + 1] - ay,
    bz = m.vertices[ib * 3 + 2] - az
  const cx = m.vertices[ic * 3] - ax,
    cy = m.vertices[ic * 3 + 1] - ay,
    cz = m.vertices[ic * 3 + 2] - az
  const nx = by * cz - bz * cy
  const ny = bz * cx - bx * cz
  const nz = bx * cy - by * cx
  return nx * nx + ny * ny + nz * nz // squared area × 4; compared against eps
}

/** Normalized triangle quality in [0,1]: 4√3·area / Σ(edge²). 0 = sliver. */
function triQuality(m: IndexedMesh, t: number): number {
  const ia = m.indices[t * 3],
    ib = m.indices[t * 3 + 1],
    ic = m.indices[t * 3 + 2]
  const ax = m.vertices[ia * 3],
    ay = m.vertices[ia * 3 + 1],
    az = m.vertices[ia * 3 + 2]
  const bx = m.vertices[ib * 3],
    by = m.vertices[ib * 3 + 1],
    bz = m.vertices[ib * 3 + 2]
  const cx = m.vertices[ic * 3],
    cy = m.vertices[ic * 3 + 1],
    cz = m.vertices[ic * 3 + 2]
  const e1 = (ax - bx) ** 2 + (ay - by) ** 2 + (az - bz) ** 2
  const e2 = (bx - cx) ** 2 + (by - cy) ** 2 + (bz - cz) ** 2
  const e3 = (cx - ax) ** 2 + (cy - ay) ** 2 + (cz - az) ** 2
  const sum = e1 + e2 + e3
  if (sum === 0) return 0
  const area = Math.sqrt(triArea2(m, t)) / 2
  return (4 * Math.sqrt(3) * area) / sum
}

/** Count vertices whose incident faces split into more than one edge-fan. */
function countNonManifoldVertices(vertTris: Map<number, number[]>, indices: Uint32Array): number {
  let count = 0
  for (const [v, tris] of vertTris) {
    if (tris.length < 2) continue
    const parent = tris.map((_, i) => i)
    const find = (a: number): number => {
      while (parent[a] !== a) a = parent[a] = parent[parent[a]]
      return a
    }
    const spoke = new Map<number, number>() // other-endpoint vertex → local tri index
    for (let li = 0; li < tris.length; li++) {
      const t = tris[li]
      for (const x of [indices[t * 3], indices[t * 3 + 1], indices[t * 3 + 2]]) {
        if (x === v) continue // the two non-v verts are v's spoke edges
        const prev = spoke.get(x)
        if (prev === undefined) spoke.set(x, li)
        else parent[find(li)] = find(prev)
      }
    }
    const roots = new Set<number>()
    for (let i = 0; i < tris.length; i++) roots.add(find(i))
    if (roots.size > 1) count++
  }
  return count
}

export function validateMesh(mesh: IndexedMesh): MeshDiagnostics {
  const triCount = mesh.indices.length / 3
  const vtxCount = mesh.vertices.length / 3

  let nanVertices = 0
  for (let i = 0; i < mesh.vertices.length; i++) {
    if (!Number.isFinite(mesh.vertices[i])) {
      nanVertices++
      // advance to the next vertex so one bad vertex counts once
      i += 2 - (i % 3)
    }
  }

  const degenerateTriangles: number[] = []
  const sliverTriangles: number[] = []
  const triKeys = new Set<string>()
  let duplicateTriangles = 0

  const edgeCount = new Map<number, number>()
  const edgeDir = new Map<number, number>() // +1 a→b, −1 b→a
  const vertexUsed = new Uint8Array(vtxCount)
  const vertTris = new Map<number, number[]>()

  for (let t = 0; t < triCount; t++) {
    const a = mesh.indices[t * 3],
      b = mesh.indices[t * 3 + 1],
      c = mesh.indices[t * 3 + 2]
    vertexUsed[a] = vertexUsed[b] = vertexUsed[c] = 1

    if (triArea2(mesh, t) < AREA_EPS) {
      degenerateTriangles.push(t)
      continue // a zero-area tri has no meaningful edges/fans
    }
    if (triQuality(mesh, t) < SLIVER_QUALITY) sliverTriangles.push(t)

    const sorted = [a, b, c].sort((x, y) => x - y).join(',')
    if (triKeys.has(sorted)) duplicateTriangles++
    else triKeys.add(sorted)

    for (const v of [a, b, c]) {
      let list = vertTris.get(v)
      if (!list) vertTris.set(v, (list = []))
      list.push(t)
    }
    for (const [i, j] of [
      [a, b],
      [b, c],
      [c, a]
    ] as const) {
      const key = edgeKey(i, j)
      edgeCount.set(key, (edgeCount.get(key) ?? 0) + 1)
      edgeDir.set(key, (edgeDir.get(key) ?? 0) + (i < j ? 1 : -1))
    }
  }

  let boundaryEdges = 0
  let nonManifoldEdges = 0
  let inconsistentlyOrientedEdges = 0
  for (const [key, count] of edgeCount) {
    if (count === 1) boundaryEdges++
    else if (count > 2) nonManifoldEdges++
    else if (edgeDir.get(key) !== 0) inconsistentlyOrientedEdges++
  }

  const nonManifoldVertices = countNonManifoldVertices(vertTris, mesh.indices)

  let unreferencedVertices = 0
  for (let v = 0; v < vtxCount; v++) if (!vertexUsed[v]) unreferencedVertices++

  const isWatertight = boundaryEdges === 0 && nonManifoldEdges === 0
  const isManifold = isWatertight && inconsistentlyOrientedEdges === 0 && nonManifoldVertices === 0

  return {
    triangleCount: triCount,
    vertexCount: vtxCount,
    degenerateTriangles,
    duplicateTriangles,
    boundaryEdges,
    nonManifoldEdges,
    nonManifoldVertices,
    inconsistentlyOrientedEdges,
    unreferencedVertices,
    nanVertices,
    sliverTriangles,
    isWatertight,
    isManifold
  }
}

/**
 * True if the mesh is free of the defects boxmaker guarantees fixing before
 * export — non-manifold **edges** and **vertices**, reversed faces, degenerate
 * and duplicate triangles, and non-finite coordinates. Open boundary edges
 * (holes) and sliver triangles are reported separately and do not block export:
 * print-in-place templates are legitimately not always watertight.
 */
export function isExportable(d: MeshDiagnostics): boolean {
  return (
    d.nonManifoldEdges === 0 &&
    d.nonManifoldVertices === 0 &&
    d.inconsistentlyOrientedEdges === 0 &&
    d.degenerateTriangles.length === 0 &&
    d.duplicateTriangles === 0 &&
    d.nanVertices === 0
  )
}

/** Human-readable summary of the problems found, for warnings/dialogs. */
export function describeDiagnostics(d: MeshDiagnostics): string[] {
  const msgs: string[] = []
  if (d.nanVertices) msgs.push(`${d.nanVertices} vertex/vertices with non-finite coordinates`)
  if (d.degenerateTriangles.length) msgs.push(`${d.degenerateTriangles.length} degenerate triangle(s)`)
  if (d.duplicateTriangles) msgs.push(`${d.duplicateTriangles} duplicate triangle(s)`)
  if (d.nonManifoldEdges) msgs.push(`${d.nonManifoldEdges} non-manifold edge(s)`)
  if (d.nonManifoldVertices) msgs.push(`${d.nonManifoldVertices} non-manifold vertex/vertices`)
  if (d.inconsistentlyOrientedEdges) msgs.push(`${d.inconsistentlyOrientedEdges} flipped-normal edge(s)`)
  if (d.boundaryEdges) msgs.push(`${d.boundaryEdges} open edge(s) (holes / not watertight)`)
  if (d.sliverTriangles.length) msgs.push(`${d.sliverTriangles.length} sliver triangle(s) (thin; may print poorly)`)
  if (d.unreferencedVertices) msgs.push(`${d.unreferencedVertices} unreferenced vertex/vertices`)
  return msgs
}
