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

/** `etch` cuts the image into the surface; `emboss` raises it above the surface. */
export type CutMode = 'etch' | 'emboss'

export interface CutSettings {
  /** 0–255 luminance threshold; pixels darker than this are cut (etch) or raised (emboss). */
  threshold: number
  invert: boolean
  /** Etch or emboss (default etch). */
  mode: CutMode
  /** Etch depth in mm (inward along −normal). Used when `mode` is `etch`. */
  depth: number
  /** Emboss height in mm (outward along +normal). Used when `mode` is `emboss`. */
  height: number
  /**
   * Outline smoothing in mm: the Gaussian-blur sigma applied to the image before
   * its outline is traced. 0 keeps raw pixel detail; larger values round pixel
   * stair-steps (and fine detail below about this size).
   */
  smoothing: number
}

/** Defaults proposed in the plan (section 9). */
export const DEFAULT_CUT: CutSettings = {
  threshold: 128,
  invert: false,
  mode: 'etch',
  depth: 0.6,
  height: 0.6,
  smoothing: 0.3
}

/** Tallest emboss offered, in mm. */
export const MAX_EMBOSS_MM = 3

/** How far an embossed image reaches into the wall so it fuses with the surface, in mm. */
export const EMBOSS_FUSE_MM = 0.2

/** Edge margin kept clear of every face edge (hinge/lip safety), in mm. */
export const DEFAULT_MARGIN_MM = 2

/** Minimum material left behind by any cut, in mm (wall-thickness guard). */
export const MIN_WALL_MM = 0.8

/**
 * Smallest gap between separate pieces (hinge knuckles, pins) that still prints
 * apart on a typical FDM printer. Print-in-place hinges are designed with
 * ~0.2–0.5 mm; closer than this and the pieces fuse. NOT the wall thickness.
 */
export const MIN_CLEARANCE_MM = 0.2

/** An axis-aligned rectangle in a face's (u,v) mm coordinates. */
export interface Rect2 {
  min: Vec2
  max: Vec2
}

/** One face together with the images placed on it. */
export interface FaceWork {
  face: FacePlane
  placements: Placement[]
}

/**
 * A "de-etch" operation: regions of an (already etched) face to fill back flush
 * with the surface, making them smooth again. See `smoothRegion` in engrave.ts.
 */
export interface SmoothWork {
  face: FacePlane
  rects: Rect2[]
}

/**
 * The full editable project state — the unit the undo/redo `History` snapshots.
 * Decoded images (`Placement.image`) are shared by reference across snapshots;
 * only transforms and cut settings are duplicated per snapshot.
 */
export interface ProjectState {
  faces: FaceWork[]
  /** Regions to de-etch (fill smooth) on the imported box. */
  smoothed: SmoothWork[]
  /** Project-wide edge margin in mm. */
  marginMm: number
  /**
   * Uniform scale applied to the finished box at export (1 = original size).
   * Hinge gaps shrink with it, so export re-opens them (see scale-export.ts).
   */
  exportScale: number
  /**
   * Minimum gap (mm) enforced between separate pieces after scaling. `null`
   * means "match the template's own gap", which is known to print.
   */
  hingeGapMm: number | null
}

export const EMPTY_PROJECT: ProjectState = {
  faces: [],
  smoothed: [],
  marginMm: DEFAULT_MARGIN_MM,
  exportScale: 1,
  hingeGapMm: null
}

/** Allowed export scale range (a fraction: 0.1 = 10%). */
export const MIN_EXPORT_SCALE = 0.1
export const MAX_EXPORT_SCALE = 4

/** Which preview the 3D view shows (SPEC §2 FR-VIEW). */
export type PreviewMode = 'overlay' | 'cut'

/**
 * Clone a project snapshot for the undo history: transforms and cut settings
 * are duplicated, but decoded images are shared by reference (they are
 * immutable), keeping snapshots cheap.
 */
export function cloneProjectState(s: ProjectState): ProjectState {
  return {
    marginMm: s.marginMm,
    exportScale: s.exportScale,
    hingeGapMm: s.hingeGapMm,
    faces: s.faces.map((fw) => ({
      face: fw.face,
      placements: fw.placements.map((p) => ({
        center: [p.center[0], p.center[1]] as Vec2,
        size: [p.size[0], p.size[1]] as Vec2,
        rotation: p.rotation,
        image: p.image,
        cut: { ...p.cut }
      }))
    })),
    smoothed: s.smoothed.map((sw) => ({
      face: sw.face,
      rects: sw.rects.map((r) => ({
        min: [r.min[0], r.min[1]] as Vec2,
        max: [r.max[0], r.max[1]] as Vec2
      }))
    }))
  }
}
