# resources/

Runtime files bundled into the packaged desktop app (electron-builder
`extraResources`) and read in dev by the main process.

- `template.stl` — the hinged jewelry-box template. **Not yet supplied** (see
  the "Open inputs" list in `docs/PLAN.md`). Drop the binary STL here as
  `template.stl`; `window.boxmaker.loadTemplate()` returns it.
