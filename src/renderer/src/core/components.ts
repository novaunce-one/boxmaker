import type { IndexedMesh, MeshPiece, TriangleMesh } from './types'

/**
 * Weld near-coincident vertices and split the model into connected components.
 *
 * This is the heart of the hinge safeguard (docs/PLAN.md §5): once the STL is
 * split into pieces, booleans run only on the piece holding the selected face,
 * so the print-in-place hinge gaps between pieces are never touched.
 */

/** Merge vertices that fall within `tolerance` mm into a single indexed vertex. */
export function weldVertices(mesh: TriangleMesh, tolerance = 1e-4): IndexedMesh {
  const { positions, triangleCount } = mesh
  const map = new Map<string, number>()
  const verts: number[] = []
  const indices = new Uint32Array(triangleCount * 3)
  const q = 1 / tolerance

  for (let i = 0; i < triangleCount * 3; i++) {
    const x = positions[i * 3],
      y = positions[i * 3 + 1],
      z = positions[i * 3 + 2]
    const key = `${Math.round(x * q)},${Math.round(y * q)},${Math.round(z * q)}`
    let idx = map.get(key)
    if (idx === undefined) {
      idx = verts.length / 3
      verts.push(x, y, z)
      map.set(key, idx)
    }
    indices[i] = idx
  }

  return { vertices: new Float32Array(verts), indices }
}

/** Union-find split of a welded mesh into connected components. */
export function connectedComponents(mesh: IndexedMesh): MeshPiece[] {
  const vertexCount = mesh.vertices.length / 3
  const parent = new Int32Array(vertexCount)
  for (let i = 0; i < vertexCount; i++) parent[i] = i

  const find = (a: number): number => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]] // path halving
      a = parent[a]
    }
    return a
  }
  const union = (a: number, b: number): void => {
    const ra = find(a),
      rb = find(b)
    if (ra !== rb) parent[rb] = ra
  }

  const tris = mesh.indices.length / 3
  for (let t = 0; t < tris; t++) {
    const a = mesh.indices[t * 3],
      b = mesh.indices[t * 3 + 1],
      c = mesh.indices[t * 3 + 2]
    union(a, b)
    union(b, c)
  }

  // Group triangles by their component root, then re-index each component to
  // its own compact vertex buffer.
  const groups = new Map<number, number[]>()
  for (let t = 0; t < tris; t++) {
    const root = find(mesh.indices[t * 3])
    let g = groups.get(root)
    if (!g) groups.set(root, (g = []))
    g.push(t)
  }

  const pieces: MeshPiece[] = []
  let id = 0
  for (const triList of groups.values()) {
    pieces.push({ id: id++, mesh: extractPiece(mesh, triList) })
  }
  // Largest pieces first — usually base/lid before small hinge parts.
  pieces.sort((a, b) => b.mesh.indices.length - a.mesh.indices.length)
  pieces.forEach((p, i) => (p.id = i))
  return pieces
}

/** Absolute enclosed volume of a (closed) component, in mm³. */
export function componentVolume(mesh: IndexedMesh): number {
  let v6 = 0
  const tris = mesh.indices.length / 3
  for (let t = 0; t < tris; t++) {
    const a = mesh.indices[t * 3],
      b = mesh.indices[t * 3 + 1],
      c = mesh.indices[t * 3 + 2]
    const ax = mesh.vertices[a * 3],
      ay = mesh.vertices[a * 3 + 1],
      az = mesh.vertices[a * 3 + 2]
    const bx = mesh.vertices[b * 3],
      by = mesh.vertices[b * 3 + 1],
      bz = mesh.vertices[b * 3 + 2]
    const cx = mesh.vertices[c * 3],
      cy = mesh.vertices[c * 3 + 1],
      cz = mesh.vertices[c * 3 + 2]
    v6 += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)
  }
  return Math.abs(v6) / 6
}

export interface NoiseShellOptions {
  /** Drop components with fewer triangles than this (a closed solid needs ≥ 4). */
  minTriangles?: number
  /** Drop components whose enclosed volume is below this (mm³). */
  minVolume?: number
}

/**
 * Remove stray "noise" shells — tiny disconnected components that are print
 * artifacts, not real parts (SPEC §2 `FR-SHELL`). Defaults are deliberately
 * conservative so legitimate small hinge parts (which are proper solids with
 * real volume) are never dropped.
 */
export function removeNoiseShells(
  pieces: MeshPiece[],
  opts: NoiseShellOptions = {}
): { kept: MeshPiece[]; removed: MeshPiece[] } {
  const minTriangles = opts.minTriangles ?? 4
  const minVolume = opts.minVolume ?? 1e-3
  const kept: MeshPiece[] = []
  const removed: MeshPiece[] = []
  for (const p of pieces) {
    const tris = p.mesh.indices.length / 3
    const isNoise = tris < minTriangles || componentVolume(p.mesh) < minVolume
    ;(isNoise ? removed : kept).push(p)
  }
  kept.forEach((p, i) => (p.id = i))
  return { kept, removed }
}

function extractPiece(mesh: IndexedMesh, triList: number[]): IndexedMesh {
  const remap = new Map<number, number>()
  const verts: number[] = []
  const indices = new Uint32Array(triList.length * 3)
  let w = 0
  for (const t of triList) {
    for (let k = 0; k < 3; k++) {
      const old = mesh.indices[t * 3 + k]
      let n = remap.get(old)
      if (n === undefined) {
        n = verts.length / 3
        verts.push(mesh.vertices[old * 3], mesh.vertices[old * 3 + 1], mesh.vertices[old * 3 + 2])
        remap.set(old, n)
      }
      indices[w++] = n
    }
  }
  return { vertices: new Float32Array(verts), indices }
}
