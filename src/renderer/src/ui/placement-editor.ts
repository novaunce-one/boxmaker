import type { FacePlane, Placement } from '@core/types'

/**
 * The 2D placement editor (docs/PLAN.md §3, step 3): shows the selected face's
 * outline with the margin inset, lets the user drag / aspect-locked resize /
 * rotate an image or type exact mm values, and previews the thresholded mask.
 */
export class PlacementEditor {
  private face: FacePlane | null = null
  private placements: Placement[] = []

  constructor(private readonly root: HTMLElement) {}

  /** Show the editor for a newly picked face. */
  open(face: FacePlane): void {
    this.face = face
    this.placements = []
    this.root.hidden = false
    // TODO(stage1-step3): render face outline + margin inset, handles, mm inputs.
  }

  close(): void {
    this.face = null
    this.root.hidden = true
  }

  /** The face currently being edited, or null when the editor is closed. */
  get activeFace(): FacePlane | null {
    return this.face
  }

  getPlacements(): Placement[] {
    return this.placements
  }
}
