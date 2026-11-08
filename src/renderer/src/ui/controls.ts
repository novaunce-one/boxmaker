import type { PreviewMode } from '@core/types'

/**
 * The sidebar controls: load template, preview-mode toggle, add image,
 * undo/redo (docs/PLAN.md §3, SPEC §2 FR-VIEW/FR-EDIT/FR-UNDO).
 */
export interface ControlsCallbacks {
  onLoadTemplate: () => void | Promise<void>
  onAddImage: (file: File) => void | Promise<void>
  onPreviewModeChange: (mode: PreviewMode) => void
  onDeEtchModeChange: (on: boolean) => void
  onUndo: () => void
  onRedo: () => void
  onExport: () => void | Promise<void>
}

export class Controls {
  private undoBtn!: HTMLButtonElement
  private redoBtn!: HTMLButtonElement
  private addBtn!: HTMLButtonElement
  private overlayBtn!: HTMLButtonElement
  private cutBtn!: HTMLButtonElement
  private deEtchBtn!: HTMLButtonElement
  private exportBtn!: HTMLButtonElement
  private deEtchOn = false

  constructor(
    private readonly root: HTMLElement,
    private readonly cb: ControlsCallbacks
  ) {}

  render(): void {
    const loadBtn = document.createElement('button')
    loadBtn.textContent = 'Load template STL'
    loadBtn.addEventListener('click', () => void this.cb.onLoadTemplate())

    // Preview-mode toggle: Overlay | Cut.
    const modeRow = document.createElement('div')
    modeRow.className = 'row'
    this.overlayBtn = this.makeButton('Overlay', () => this.selectMode('overlay'))
    this.cutBtn = this.makeButton('Cut', () => this.selectMode('cut'))
    modeRow.append(this.overlayBtn, this.cutBtn)

    // Add image to the currently picked face.
    const fileInput = document.createElement('input')
    fileInput.type = 'file'
    fileInput.accept = 'image/*'
    fileInput.style.display = 'none'
    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0]
      if (file) void this.cb.onAddImage(file)
      fileInput.value = ''
    })
    this.addBtn = this.makeButton('Add image to face…', () => fileInput.click())

    // De-etch: rubber-band select an etched area to smooth it flat.
    this.deEtchBtn = this.makeButton('De-etch region', () => this.toggleDeEtch())

    const historyRow = document.createElement('div')
    historyRow.className = 'row'
    this.undoBtn = this.makeButton('Undo', this.cb.onUndo)
    this.redoBtn = this.makeButton('Redo', this.cb.onRedo)
    historyRow.append(this.undoBtn, this.redoBtn)

    // Export: assemble, repair, validate, and save (.stl desktop / .zip web).
    this.exportBtn = this.makeButton('Export STL…', () => void this.cb.onExport())

    this.root.replaceChildren(
      loadBtn,
      label('Preview'),
      modeRow,
      label('Edit'),
      this.addBtn,
      this.deEtchBtn,
      historyRow,
      label('Export'),
      this.exportBtn,
      fileInput
    )
    this.selectMode('overlay')
    this.setFacePicked(false)
    this.setHistoryState(false, false)
    this.setModelLoaded(false)
  }

  /** Export is only meaningful once a model is loaded. */
  setModelLoaded(loaded: boolean): void {
    this.exportBtn.disabled = !loaded
  }

  /** Enable image placement / de-etch only once a face is selected. */
  setFacePicked(picked: boolean): void {
    this.addBtn.disabled = !picked
    this.deEtchBtn.disabled = !picked
    if (!picked && this.deEtchOn) this.toggleDeEtch()
  }

  private toggleDeEtch(): void {
    this.deEtchOn = !this.deEtchOn
    this.deEtchBtn.classList.toggle('active', this.deEtchOn)
    this.cb.onDeEtchModeChange(this.deEtchOn)
  }

  setHistoryState(canUndo: boolean, canRedo: boolean): void {
    this.undoBtn.disabled = !canUndo
    this.redoBtn.disabled = !canRedo
  }

  private selectMode(mode: PreviewMode): void {
    this.overlayBtn.classList.toggle('active', mode === 'overlay')
    this.cutBtn.classList.toggle('active', mode === 'cut')
    this.cb.onPreviewModeChange(mode)
  }

  private makeButton(text: string, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement('button')
    btn.textContent = text
    btn.addEventListener('click', onClick)
    return btn
  }
}

function label(text: string): HTMLElement {
  const el = document.createElement('div')
  el.className = 'label'
  el.textContent = text
  return el
}
