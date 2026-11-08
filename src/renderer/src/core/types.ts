/**
 * Shared geometry types for the engraving pipeline. All lengths are in
 * millimetres (the STL's native unit). See docs/PLAN.md sections 4–5.
 */

export type Vec3 = readonly [number, number, number]
export type Vec2 = readonly [number, number]

/**
 * A triangle soup: the raw form STL gives us. `positions` holds
 * `triangleCount * 9` floats (3 vertices × xyz, flattened).
 */
export interface TriangleMesh {
  positions: Float32Array
  /** Optional per-triangle normals (`triangleCount * 3`). */
  normals?: Float32Array
  triangleCount: number
}

/**
 * A mesh with welded, de-duplicated vertices and an index buffer — the form
 * needed for connected-component splitting and manifold construction.
 */
export interface IndexedMesh {
  /** `vertexCount * 3` floats. */
  vertices: Float32Array
  /** `triangleCount * 3` vertex indices. */
  indices: Uint32Array
}

/** One connected component of the STL (e.g. the lid, the base, a hinge pin). */
export interface MeshPiece {
  mesh: IndexedMesh
  /** Index of this piece within the original model. */
  id: number
}

/** An outward-facing, coplanar region selected for engraving. */
export interface FacePlane {
  /** A point on the plane. */
  origin: Vec3
  /** Outward unit normal. */
  normal: Vec3
  /** In-plane basis: image "right". */
  u: Vec3
  /** In-plane basis: image "up". `u × v === normal`. */
  v: Vec3
  /** Triangle indices (into the owning piece) that make up this face. */
  triangles: number[]
  /** Which piece this face belongs to. */
  pieceId: number
}

/** A placed image on a face, in that face's (u, v) millimetre coordinates. */
export interface Placement {
  /** Centre of the image in face-local mm. */
  center: Vec2
  /** Rendered size in mm. Aspect-locked by the editor. */
  size: Vec2
  /** Rotation about the face normal, radians. */
  rotation: number
  image: ImageSource
  cut: CutSettings
}

/** Decoded image pixels plus the controls that turn them into a binary mask. */
export interface ImageSource {
  width: number
  height: number
  /** RGBA, length `width * height * 4`. */
  rgba: Uint8ClampedArray
}

export interface CutSettings {
  /** 0–255 luminance threshold; pixels darker than this are cut. */
  threshold: number
  invert: boolean
  /** Cut depth in mm (inward along −normal). */
  depth: number
  /** Edge-smoothing / contour simplification tolerance in mm. */
  smoothing: number
}

/** Defaults proposed in the plan (section 9). */
export const DEFAULT_CUT: CutSettings = {
  threshold: 128,
  invert: false,
  depth: 0.6,
  smoothing: 0.1
}

/** Edge margin kept clear of every face edge (hinge/lip safety), in mm. */
export const DEFAULT_MARGIN_MM = 2

/** Minimum material left behind by any cut, in mm (wall-thickness guard). */
export const MIN_WALL_MM = 0.8

/** One face together with the images placed on it. */
export interface FaceWork {
  face: FacePlane
  placements: Placement[]
}

/**
 * The full editable project state — the unit the undo/redo `History` snapshots.
 * Decoded images (`Placement.image`) are shared by reference across snapshots;
 * only transforms and cut settings are duplicated per snapshot.
 */
export interface ProjectState {
  faces: FaceWork[]
  /** Project-wide edge margin in mm. */
  marginMm: number
}

export const EMPTY_PROJECT: ProjectState = { faces: [], marginMm: DEFAULT_MARGIN_MM }
