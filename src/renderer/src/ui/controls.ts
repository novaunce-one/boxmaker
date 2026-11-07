/**
 * The sidebar controls: load template, cut settings, export (docs/PLAN.md §3).
 * Stage 1 starts with just "Load template" wired through to the host bridge.
 */
export interface ControlsCallbacks {
  onLoadTemplate: () => void | Promise<void>
}

export class Controls {
  constructor(
    private readonly root: HTMLElement,
    private readonly cb: ControlsCallbacks
  ) {}

  render(): void {
    const loadBtn = document.createElement('button')
    loadBtn.textContent = 'Load template STL'
    loadBtn.addEventListener('click', () => void this.cb.onLoadTemplate())
    this.root.replaceChildren(loadBtn)
    // TODO(stage1-step3/4): threshold/invert/depth/margin inputs + Export.
  }
}
