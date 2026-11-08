import type { IndexedMesh } from './types'

/**
 * Mesh repair targeting the two defects the exported STL must never carry
 * (SPEC §2 `FR-REPAIR`): **non-manifold edges** and **reversed faces** (flipped
 * normals / inconsistent winding). Degenerate and duplicate triangles are also
 * removed since they are a common cause of both.
 *
 * All fixes preserve geometry (vertex positions never move) and never close the
 * print-in-place hinge gaps:
 *   - drop triangles with non-finite (NaN/Inf) coordinates
 *   - drop degenerate (zero-area) triangles
 *   - drop duplicate triangles (same vertex set)
 *   - split non-manifold edges by un-sharing vertices so each manifold sheet
 *     gets its own vertices (an edge is never left shared by > 2 triangles).
 *     This also resolves non-manifold ("bowtie") vertices, since disjoint fans
 *     fall into different sheets and no longer share a vertex.
 *   - make winding consistent per connected component, then orient outward
 *     (positive signed volume) — fixing reversed faces
 *
 * It deliberately does NOT fill holes: hole-filling could bridge two hinge
 * pieces and fuse the joint. Remaining open edges are reported by
 * `validateMesh`, not silently stitched. Input SHOULD be vertex-welded first
 * (see `weldVertices`).
 */

const AREA_EPS = 1e-10

function area2(v: ArrayLike<number>, a: number, b: number, c: number): number {
  const ax = v[a * 3],
    ay = v[a * 3 + 1],
    az = v[a * 3 + 2]
  const bx = v[b * 3] - ax,
    by = v[b * 3 + 1] - ay,
    bz = v[b * 3 + 2] - az
  const cx = v[c * 3] - ax,
    cy = v[c * 3 + 1] - ay,
    cz = v[c * 3 + 2] - az
  const nx = by * cz - bz * cy
  const ny = bz * cx - bx * cz
  const nz = bx * cy - by * cx
  return nx * nx + ny * ny + nz * nz
}

function edgeKey(a: number, b: number): number {
  return a < b ? a * 67108864 + b : b * 67108864 + a
}

/** True if vertex `i`'s three coordinates are all finite. */
function finiteVert(v: ArrayLike<number>, i: number): boolean {
  return Number.isFinite(v[i * 3]) && Number.isFinite(v[i * 3 + 1]) && Number.isFinite(v[i * 3 + 2])
}

/** Direction of undirected edge {x,y} within triangle [v0,v1,v2]: +1 x→y, −1 y→x, 0 absent. */
function edgeDir(tri: number[], x: number, y: number): number {
  const p: [number, number][] = [
    [tri[0], tri[1]],
    [tri[1], tri[2]],
    [tri[2], tri[0]]
  ]
  for (const [i, j] of p) {
    if (i === x && j === y) return 1
    if (i === y && j === x) return -1
  }
  return 0
}

class UnionFind {
  private p: Int32Array
  constructor(n: number) {
    this.p = new Int32Array(n)
    for (let i = 0; i < n; i++) this.p[i] = i
  }
  find(a: number): number {
    while (this.p[a] !== a) a = this.p[a] = this.p[this.p[a]]
    return a
  }
  union(a: number, b: number): void {
    const ra = this.find(a),
      rb = this.find(b)
    if (ra !== rb) this.p[rb] = ra
  }
}

export function repairMesh(mesh: IndexedMesh): IndexedMesh {
  // 1. Keep only finite, non-degenerate, de-duplicated triangles (orig indices).
  const seen = new Set<string>()
  const tris: number[][] = []
  const triCount = mesh.indices.length / 3
  for (let t = 0; t < triCount; t++) {
    const a = mesh.indices[t * 3],
      b = mesh.indices[t * 3 + 1],
      c = mesh.indices[t * 3 + 2]
    if (!finiteVert(mesh.vertices, a) || !finiteVert(mesh.vertices, b) || !finiteVert(mesh.vertices, c))
      continue
    if (area2(mesh.vertices, a, b, c) < AREA_EPS) continue
    const key = [a, b, c].slice().sort((x, y) => x - y).join(',')
    if (seen.has(key)) continue
    seen.add(key)
    tris.push([a, b, c])
  }

  // 2. Edge → incident triangles.
  const edgeTris = new Map<number, number[]>()
  for (let t = 0; t < tris.length; t++) {
    const [a, b, c] = tris[t]
    for (const [i, j] of [
      [a, b],
      [b, c],
      [c, a]
    ] as const) {
      const k = edgeKey(i, j)
      let list = edgeTris.get(k)
      if (!list) edgeTris.set(k, (list = []))
      list.push(t)
    }
  }

  // 3. Partition triangles into manifold "sheets": union triangles that share
  //    an edge used by *exactly two* triangles. Non-manifold edges (> 2) are
  //    left as sheet boundaries — the cut that removes the non-manifold edge.
  const sheets = new UnionFind(tris.length)
  for (const list of edgeTris.values()) {
    if (list.length === 2) sheets.union(list[0], list[1])
  }

  // 4. Rebuild vertices keyed by (sheet, original vertex). Vertices on a
  //    non-manifold edge thus get a separate copy per sheet, so no edge is
  //    shared by more than two triangles anymore.
  const vmap = new Map<string, number>()
  const verts: number[] = []
  const newTris: number[][] = tris.map((tri, t) => {
    const sheet = sheets.find(t)
    return tri.map((orig) => {
      const key = `${sheet}:${orig}`
      let n = vmap.get(key)
      if (n === undefined) {
        n = verts.length / 3
        verts.push(mesh.vertices[orig * 3], mesh.vertices[orig * 3 + 1], mesh.vertices[orig * 3 + 2])
        vmap.set(key, n)
      }
      return n
    })
  })

  // 5. Consistent winding: BFS each sheet, flipping neighbors that traverse a
  //    shared (now strictly manifold) edge the same way as the fixed triangle.
  const newEdgeTris = new Map<number, number[]>()
  for (let t = 0; t < newTris.length; t++) {
    const [a, b, c] = newTris[t]
    for (const [i, j] of [
      [a, b],
      [b, c],
      [c, a]
    ] as const) {
      const k = edgeKey(i, j)
      let list = newEdgeTris.get(k)
      if (!list) newEdgeTris.set(k, (list = []))
      list.push(t)
    }
  }
  const visited = new Uint8Array(newTris.length)
  for (let start = 0; start < newTris.length; start++) {
    if (visited[start]) continue
    visited[start] = 1
    const queue = [start]
    while (queue.length) {
      const t = queue.pop() as number
      const [a, b, c] = newTris[t]
      for (const [i, j] of [
        [a, b],
        [b, c],
        [c, a]
      ] as const) {
        const nbrs = newEdgeTris.get(edgeKey(i, j)) ?? []
        if (nbrs.length !== 2) continue
        const n = nbrs[0] === t ? nbrs[1] : nbrs[0]
        if (visited[n]) continue
        if (edgeDir(newTris[t], i, j) === edgeDir(newTris[n], i, j)) {
          const tmp = newTris[n][1]
          newTris[n][1] = newTris[n][2]
          newTris[n][2] = tmp
        }
        visited[n] = 1
        queue.push(n)
      }
    }
  }

  // 6. Orient outward: per connected component, flip the whole component if its
  //    signed volume is negative (normals pointing inward = reversed faces).
  orientOutward(verts, newTris)

  // 7. Flatten.
  const indices = new Uint32Array(newTris.length * 3)
  for (let t = 0; t < newTris.length; t++) {
    indices[t * 3] = newTris[t][0]
    indices[t * 3 + 1] = newTris[t][1]
    indices[t * 3 + 2] = newTris[t][2]
  }
  return { vertices: new Float32Array(verts), indices }
}

/** Flip each connected component whose signed volume is negative. */
function orientOutward(verts: number[], tris: number[][]): void {
  const uf = new UnionFind(verts.length / 3)
  for (const [a, b, c] of tris) {
    uf.union(a, b)
    uf.union(b, c)
  }
  const volume = new Map<number, number>()
  for (const [a, b, c] of tris) {
    const root = uf.find(a)
    volume.set(root, (volume.get(root) ?? 0) + signedTetraVolume(verts, a, b, c))
  }
  for (const tri of tris) {
    if ((volume.get(uf.find(tri[0])) ?? 0) < 0) {
      const tmp = tri[1]
      tri[1] = tri[2]
      tri[2] = tmp
    }
  }
}

/** 6× the signed volume of the tetrahedron (origin, a, b, c). */
function signedTetraVolume(v: number[], a: number, b: number, c: number): number {
  const ax = v[a * 3],
    ay = v[a * 3 + 1],
    az = v[a * 3 + 2]
  const bx = v[b * 3],
    by = v[b * 3 + 1],
    bz = v[b * 3 + 2]
  const cx = v[c * 3],
    cy = v[c * 3 + 1],
    cz = v[c * 3 + 2]
  return ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)
}
