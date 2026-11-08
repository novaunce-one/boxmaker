/**
 * Generic snapshot-based undo/redo stack (SPEC §2 `FR-UNDO`).
 *
 * The app drives this with immutable `ProjectState` snapshots: every committed
 * edit (add/move/resize/rotate a placement, change a cut setting, delete) calls
 * `push(next)`. Snapshots share immutable sub-objects (e.g. decoded images) by
 * reference, so the only per-snapshot cost is the placement transforms and cut
 * settings. Callers MUST NOT mutate a snapshot after pushing it.
 */
export interface HistoryOptions {
  /** Max number of undo steps retained; older states are discarded. */
  limit?: number
}

export class History<T> {
  private past: T[] = []
  private future: T[] = []
  private present: T
  private readonly limit: number

  constructor(initial: T, opts: HistoryOptions = {}) {
    this.present = initial
    this.limit = opts.limit ?? 100
  }

  /** The current state. */
  get state(): T {
    return this.present
  }

  get canUndo(): boolean {
    return this.past.length > 0
  }

  get canRedo(): boolean {
    return this.future.length > 0
  }

  /** Record a new committed state. Clears the redo stack (a new branch). */
  push(next: T): void {
    this.past.push(this.present)
    if (this.past.length > this.limit) this.past.shift()
    this.present = next
    this.future.length = 0
  }

  /** Step back one state. No-op (returns current) when nothing to undo. */
  undo(): T {
    if (!this.canUndo) return this.present
    this.future.push(this.present)
    this.present = this.past.pop() as T
    return this.present
  }

  /** Step forward one state. No-op (returns current) when nothing to redo. */
  redo(): T {
    if (!this.canRedo) return this.present
    this.past.push(this.present)
    this.present = this.future.pop() as T
    return this.present
  }

  /** Replace the current state and drop all history (e.g. new template loaded). */
  reset(state: T): void {
    this.present = state
    this.past.length = 0
    this.future.length = 0
  }
}
