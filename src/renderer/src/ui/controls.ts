/**
 * The sidebar controls: load template, undo/redo, cut settings, export
 * (docs/PLAN.md §3, SPEC §2 FR-VIEW/FR-CUT/FR-UNDO/FR-EXP). Stage 1 starts with
 * load + undo/redo wired; cut settings and export land with the editor.
 */
export interface ControlsCallbacks {
  onLoadTemplate: () => void | Promise<void>
  onUndo: () => void
  onRedo: () => void
}

export class Controls {
  private undoBtn!: HTMLButtonElement
  private redoBtn!: HTMLButtonElement

  constructor(
    private readonly root: HTMLElement,
    private readonly cb: ControlsCallbacks
  ) {}

  render(): void {
    const loadBtn = document.createElement('button')
    loadBtn.textContent = 'Load template STL'
    loadBtn.addEventListener('click', () => void this.cb.onLoadTemplate())

    const historyRow = document.createElement('div')
    historyRow.className = 'row'
    this.undoBtn = this.makeButton('Undo', this.cb.onUndo)
    this.redoBtn = this.makeButton('Redo', this.cb.onRedo)
    historyRow.append(this.undoBtn, this.redoBtn)

    this.root.replaceChildren(loadBtn, historyRow)
    this.setHistoryState(false, false)
    // TODO(stage1-step3/4): threshold/invert/depth/margin inputs + Export.
  }

  /** Reflect whether undo/redo are available (called after every state change). */
  setHistoryState(canUndo: boolean, canRedo: boolean): void {
    this.undoBtn.disabled = !canUndo
    this.redoBtn.disabled = !canRedo
  }

  private makeButton(label: string, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement('button')
    btn.textContent = label
    btn.addEventListener('click', onClick)
    return btn
  }
}
