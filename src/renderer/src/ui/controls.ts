import { MAX_EXPORT_SCALE, MIN_EXPORT_SCALE, type PreviewMode } from '@core/types'

/**
 * The sidebar controls: load template, preview-mode toggle, add image,
 * undo/redo (docs/PLAN.md §3, SPEC §2 FR-VIEW/FR-EDIT/FR-UNDO).
 */
export interface ControlsCallbacks {
  onLoadTemplate: () => void | Promise<void>
  onOpenProject: () => void | Promise<void>
  onSaveProject: () => void | Promise<void>
  onSaveProjectAs: () => void | Promise<void>
  onAddImage: (file: File) => void | Promise<void>
  onPreviewModeChange: (mode: PreviewMode) => void
  onDeEtchModeChange: (on: boolean) => void
  onUndo: () => void
  onRedo: () => void
  onExport: () => void | Promise<void>
  /** Export scale (fraction, 1 = 100%) or hinge-gap override (`null` = match template) changed. */
  onExportSettingsChange: (scale: number, hingeGapMm: number | null) => void
}

export class Controls {
  private undoBtn!: HTMLButtonElement
  private redoBtn!: HTMLButtonElement
  private addBtn!: HTMLButtonElement
  private overlayBtn!: HTMLButtonElement
  private cutBtn!: HTMLButtonElement
  private deEtchBtn!: HTMLButtonElement
  private exportBtn!: HTMLButtonElement
  private scaleInput!: HTMLInputElement
  private gapInput!: HTMLInputElement
  private exportHint!: HTMLElement
  private modelLoaded = false
  private exportBusy = false
  private templateGap: number | null | undefined
  private sizeText = ''
  private saveItem: HTMLButtonElement | null = null
  private saveAsItem: HTMLButtonElement | null = null
  private deEtchOn = false

  constructor(
    private readonly root: HTMLElement,
    private readonly cb: ControlsCallbacks,
    /** `fileMenu`: render the in-page File menu (browser build only). */
    private readonly opts: { fileMenu: boolean } = { fileMenu: false }
  ) {}

  render(): void {
    const loadBtn = document.createElement('button')
    loadBtn.className = 'primary'
    loadBtn.textContent = 'Load template STL'
    loadBtn.addEventListener('click', () => void this.cb.onLoadTemplate())

    // Preview-mode toggle: Overlay | Cut (a macOS segmented control).
    const modeRow = document.createElement('div')
    modeRow.className = 'row seg'
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
    this.exportBtn.classList.add('primary')

    // Uniform scale applied at export; hinge gaps are re-opened afterwards.
    this.scaleInput = numberInput(MIN_EXPORT_SCALE * 100, MAX_EXPORT_SCALE * 100, 1)
    this.scaleInput.value = '100'
    this.gapInput = numberInput(0.05, 2, 0.01)
    this.gapInput.addEventListener('change', () => this.commitExportSettings())
    this.scaleInput.addEventListener('change', () => this.commitExportSettings())
    this.exportHint = document.createElement('div')
    this.exportHint.className = 'hint-text'
    const scaleRow = fieldRow('Scale %', this.scaleInput)
    const gapRow = fieldRow('Hinge gap mm', this.gapInput)

    // Desktop uses the native File menu; the browser has none, so it gets an
    // in-page one at the top of the sidebar.
    const top: HTMLElement[] = this.opts.fileMenu ? [this.buildFileMenu()] : []

    this.root.replaceChildren(
      ...top,
      loadBtn,
      label('Preview'),
      modeRow,
      label('Edit'),
      this.addBtn,
      this.deEtchBtn,
      historyRow,
      label('Export'),
      scaleRow,
      gapRow,
      this.exportHint,
      this.exportBtn,
      fileInput
    )
    this.selectMode('overlay')
    this.setFacePicked(false)
    this.setHistoryState(false, false)
    this.setModelLoaded(false)
  }

  /** Export and saving are only meaningful once a model is loaded. */
  setModelLoaded(loaded: boolean): void {
    this.modelLoaded = loaded
    this.updateExportEnabled()
    if (this.saveItem) this.saveItem.disabled = !loaded
    if (this.saveAsItem) this.saveAsItem.disabled = !loaded
  }

  /** Disable export while it runs (the geometry work can take several seconds). */
  setExportBusy(busy: boolean): void {
    this.exportBusy = busy
    this.exportBtn.textContent = busy ? 'Exporting…' : 'Export STL…'
    this.updateExportEnabled()
  }

  private updateExportEnabled(): void {
    this.exportBtn.disabled = !this.modelLoaded || this.exportBusy
  }

  /** Reflect the project's export settings in the fields (after load / undo / redo). */
  setExportSettings(scale: number, hingeGapMm: number | null): void {
    this.scaleInput.value = String(Math.round(scale * 1000) / 10)
    this.gapInput.value = hingeGapMm === null ? '' : String(hingeGapMm)
  }

  /** The template's measured hinge gap (shown as the default); `undefined` while measuring. */
  setTemplateGap(gap: number | null | undefined): void {
    this.templateGap = gap
    this.gapInput.placeholder = gap ? gap.toFixed(2) : 'auto'
    this.refreshHint()
  }

  /** Show the resulting outer size (mm) for the current scale. */
  setSizeInfo(size: [number, number, number] | null, scale: number): void {
    this.sizeText = size ? `${size.map((d) => (d * scale).toFixed(1)).join(' × ')} mm` : ''
    this.refreshHint()
  }

  private refreshHint(): void {
    const gap =
      this.templateGap === undefined
        ? 'measuring hinge gap…'
        : this.templateGap === null
          ? 'no hinge gap found'
          : `blank gap = template (${this.templateGap.toFixed(2)} mm)`
    this.exportHint.textContent = [this.sizeText && `Size ${this.sizeText}`, gap].filter(Boolean).join(' · ')
  }

  /** Validate both fields, normalize them, and report a change. */
  private commitExportSettings(): void {
    const pct = Number(this.scaleInput.value)
    const scale = Number.isFinite(pct) && pct > 0 ? Math.min(MAX_EXPORT_SCALE, Math.max(MIN_EXPORT_SCALE, pct / 100)) : 1
    const raw = this.gapInput.value.trim()
    const g = Number(raw)
    const gap = raw === '' || !Number.isFinite(g) || g <= 0 ? null : Math.min(2, Math.max(0.05, g))
    this.setExportSettings(scale, gap)
    this.cb.onExportSettingsChange(scale, gap)
  }

  /** Browser-only File menu: Open… / Save / Save As… (desktop uses the native menu). */
  private buildFileMenu(): HTMLElement {
    const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+'
    const wrap = document.createElement('div')
    wrap.className = 'file-menu'

    const toggle = document.createElement('button')
    toggle.className = 'file-menu-toggle'
    toggle.textContent = 'File ▾'

    const pop = document.createElement('div')
    pop.className = 'file-menu-pop'
    pop.hidden = true

    const close = (): void => {
      pop.hidden = true
    }
    const item = (text: string, hint: string, run: () => void | Promise<void>): HTMLButtonElement => {
      const b = document.createElement('button')
      b.className = 'file-menu-item'
      const name = document.createElement('span')
      name.textContent = text
      const key = document.createElement('span')
      key.className = 'hint'
      key.textContent = hint
      b.append(name, key)
      b.addEventListener('click', () => {
        close()
        void run()
      })
      pop.appendChild(b)
      return b
    }

    item('Open project…', `${mod}O`, () => this.cb.onOpenProject())
    this.saveItem = item('Save', `${mod}S`, () => this.cb.onSaveProject())
    this.saveAsItem = item('Save as…', `⇧${mod}S`, () => this.cb.onSaveProjectAs())

    toggle.addEventListener('click', () => {
      pop.hidden = !pop.hidden
    })
    document.addEventListener('click', (e) => {
      if (!wrap.contains(e.target as Node)) close()
    })
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') close()
    })

    wrap.append(toggle, pop)
    return wrap
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

function numberInput(min: number, max: number, step: number): HTMLInputElement {
  const el = document.createElement('input')
  el.type = 'number'
  el.min = String(min)
  el.max = String(max)
  el.step = String(step)
  return el
}

function fieldRow(text: string, input: HTMLInputElement): HTMLElement {
  const row = document.createElement('label')
  row.className = 'field-row'
  const name = document.createElement('span')
  name.textContent = text
  row.append(name, input)
  return row
}
