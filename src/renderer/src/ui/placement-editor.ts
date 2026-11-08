import { DEFAULT_CUT, type FacePlane, type ImageSource, type Placement, type Vec2 } from '@core/types'

/**
 * The 2D placement editor (docs/PLAN.md §3, step 3). Full drag/resize/rotate
 * handles land later; for now it provides the minimal placement needed to drive
 * the live preview and undo/redo (SPEC §2 FR-EDIT).
 */
export class PlacementEditor {
  private face: FacePlane | null = null

  constructor(private readonly root: HTMLElement) {}

  open(face: FacePlane): void {
    this.face = face
    this.root.hidden = false
  }

  close(): void {
    this.face = null
    this.root.hidden = true
  }

  get activeFace(): FacePlane | null {
    return this.face
  }
}

/**
 * Build a centered placement for an image on a face: image "up" aligned to the
 * face's v axis, a sensible default size, and the default cut settings.
 */
export function createCenteredPlacement(image: ImageSource, longEdgeMm = 30): Placement {
  const aspect = image.width / image.height
  const size: Vec2 = aspect >= 1 ? [longEdgeMm, longEdgeMm / aspect] : [longEdgeMm * aspect, longEdgeMm]
  return { center: [0, 0], size, rotation: 0, image, cut: { ...DEFAULT_CUT } }
}
