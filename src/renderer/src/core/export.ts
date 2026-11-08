import { writeBinaryStl } from './stl'
import { repairMesh } from './repair'
import { validateMesh, isExportable, describeDiagnostics, type MeshDiagnostics } from './validate'
import { measureClearance } from './clearance'
import type { IndexedMesh, MeshPiece, TriangleMesh } from './types'

/**
 * Export assembly + validation (SPEC §2 `FR-EXP`, `FR-VALIDATE`, `FR-REPAIR`).
 *
 * Recombines the engraved piece with the untouched pieces, runs the
 * hinge-preserving repair, validates the result, and serializes a binary STL —
 * so the file boxmaker hands back needs no online repair pass.
 */

export interface ExportResult {
  /** Serialized binary STL. */
  stl: ArrayBuffer
  /** Diagnostics for the final mesh (post-repair if `repair` was on). */
  diagnostics: MeshDiagnostics
  /** True if free of non-manifold edges and reversed faces (see `isExportable`). */
  clean: boolean
  /** Defects repair fixed, e.g. "non-manifold edges", "reversed faces". */
  repaired: string[]
  /** Non-blocking problems left in the mesh (e.g. open edges / holes). */
  warnings: string[]
}

/** Combine several indexed pieces into one indexed mesh (offsets indices). */
export function mergePieces(pieces: MeshPiece[]): IndexedMesh {
  let vtx = 0
  let idx = 0
  for (const p of pieces) {
    vtx += p.mesh.vertices.length
    idx += p.mesh.indices.length
  }
  const vertices = new Float32Array(vtx)
  const indices = new Uint32Array(idx)
  let vOff = 0
  let iOff = 0
  for (const p of pieces) {
    vertices.set(p.mesh.vertices, vOff)
    const base = vOff / 3
    for (let i = 0; i < p.mesh.indices.length; i++) indices[iOff + i] = p.mesh.indices[i] + base
    vOff += p.mesh.vertices.length
    iOff += p.mesh.indices.length
  }
  return { vertices, indices }
}

/** Expand an indexed mesh back to a flat triangle soup for STL writing. */
export function indexedToTriangles(mesh: IndexedMesh): TriangleMesh {
  const triangleCount = mesh.indices.length / 3
  const positions = new Float32Array(triangleCount * 9)
  for (let t = 0; t < triangleCount; t++) {
    for (let k = 0; k < 3; k++) {
      const vi = mesh.indices[t * 3 + k]
      positions[t * 9 + k * 3] = mesh.vertices[vi * 3]
      positions[t * 9 + k * 3 + 1] = mesh.vertices[vi * 3 + 1]
      positions[t * 9 + k * 3 + 2] = mesh.vertices[vi * 3 + 2]
    }
  }
  return { positions, triangleCount }
}

export interface PrepareOptions {
  /** Apply hinge-preserving repair before validating (default true). */
  repair?: boolean
  /** If set, warn when any two pieces sit closer than this (mm) — may fuse. */
  minClearanceMm?: number
  /**
   * The unedited template pieces. Lets export tell problems the template already
   * had (which the user can't fix) from ones their edits introduced: slivers are
   * reported only beyond the template's count, and a clearance warning notes
   * whether the gap shrank.
   */
  reference?: MeshPiece[]
}

/**
 * Produce an export-ready STL from the model's pieces.
 *
 * The caller passes the (already engraved) pieces; repair never touches the
 * hinge gaps (see repair.ts), so passing all pieces is safe. If the result
 * still has defects that repair cannot safely fix — e.g. a pre-existing hole in
 * the template — `clean` is false and `warnings` explains, letting the UI ask
 * the user before saving.
 */
export function prepareForExport(pieces: MeshPiece[], opts: PrepareOptions = {}): ExportResult {
  const merged = mergePieces(pieces)
  const before = validateMesh(merged)
  const finalMesh = opts.repair === false ? merged : repairMesh(merged)
  const after = validateMesh(finalMesh)

  // Report exactly which targeted defects were eliminated.
  const repaired: string[] = []
  if (before.nonManifoldEdges > 0 && after.nonManifoldEdges === 0) repaired.push('non-manifold edges')
  if (before.nonManifoldVertices > 0 && after.nonManifoldVertices === 0)
    repaired.push('non-manifold vertices')
  if (before.inconsistentlyOrientedEdges > 0 && after.inconsistentlyOrientedEdges === 0)
    repaired.push('reversed faces')
  if (before.degenerateTriangles.length > 0 && after.degenerateTriangles.length === 0)
    repaired.push('degenerate triangles')
  if (before.duplicateTriangles > 0 && after.duplicateTriangles === 0) repaired.push('duplicate triangles')
  if (before.nanVertices > 0 && after.nanVertices === 0) repaired.push('non-finite coordinates')

  const baselineSlivers = opts.reference
    ? validateMesh(mergePieces(opts.reference)).sliverTriangles.length
    : undefined
  const warnings = describeDiagnostics(after, baselineSlivers)
  if (opts.minClearanceMm !== undefined) {
    const clr = measureClearance(pieces, opts.minClearanceMm)
    if (clr.betweenPieces && clr.minGap < opts.minClearanceMm) {
      let note =
        `pieces ${clr.betweenPieces[0]} and ${clr.betweenPieces[1]} are ${clr.minGap.toFixed(3)} mm apart ` +
        `(< ${opts.minClearanceMm} mm) and may fuse when printed`
      if (opts.reference) {
        const was = measureClearance(opts.reference, opts.minClearanceMm).minGap
        note += Math.abs(was - clr.minGap) < 1e-3 ? ' (same as the unedited template)' : ` (template: ${was.toFixed(3)} mm)`
      }
      warnings.push(note)
    }
  }

  const stl = writeBinaryStl(indexedToTriangles(finalMesh))
  return {
    stl,
    diagnostics: after,
    clean: isExportable(after),
    repaired,
    warnings
  }
}
