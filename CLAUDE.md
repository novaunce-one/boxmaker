# boxmaker

An app that engraves (debosses) user images into the faces of a fixed print-in-place
hinged jewelry-box STL and exports a printable STL. Ships first as a single-page browser
app, then as an Electron desktop app for Mac + Windows.

**Status: Stage 1 feature-complete (pending real-template verification).** The engraving
pipeline (image → marching-squares contours → manifold boolean cut), face picking, two live
preview views (overlay + real cut) with undo/redo, a select-box **de-etch** (smooth an
imported box's etched area), the wall-thickness raycast depth guard (WARN-DEPTH), the full 2D
placement editor (drag / aspect-locked resize / rotate + numeric mm·° entry + per-placement
cut controls + margin clamp), export wiring (assemble → repair → validate → save), and the
browser `.stl`-in-`.zip` + IndexedDB template-persistence paths are all implemented; `core/`
is unit-tested (44 tests). Verification against the real template is still blocked on the
template STL + sample images (SPEC §8 OQ-1/OQ-2); the only deferred stub is the FR-HINGE-4
raycast depth re-check (the watertight-based break-through check is already in place).

The full plan — goals, decisions, cutting pipeline, hinge safeguards, tech stack, and
build order — lives in [docs/PLAN.md](docs/PLAN.md). The normative, testable
specification (requirement IDs, acceptance criteria, API contract) is in
[docs/SPEC.md](docs/SPEC.md). Read both before starting work.

## Commands
- `npm run dev` — electron-vite dev server (requires the Electron binary; see note below).
- `npm run build` — typecheck, then bundle main/preload/renderer into `out/`.
- `npm run typecheck` — `tsc` over the node (main/preload/shared) and web (renderer) projects.
- `npm test` / `npm run test:watch` — Vitest over `core/`.
- `npm run build:mac` / `build:win` — electron-builder installers.

> The Electron prebuilt binary could not be downloaded in the sandbox (GitHub DNS blocked),
> so `npm run dev`/`start` won't launch a window until deps are installed on an unrestricted
> network (or `node node_modules/electron/install.js` is run). Typecheck, tests, and
> `electron-vite build` all work without it.

## Key decisions (see PLAN.md for detail)
- Images are **cut into** surfaces (deboss), not embossed or colored.
- **TypeScript** throughout; **Three.js** for the 3D view, **manifold-3d** (WASM) for geometry.
- Only the mesh piece containing the selected face is booleaned — the hinge pieces pass through
  untouched. Edge margin + wall-thickness guard protect the hinge and walls.
- **Vite** for the web build, **electron-vite** + **electron-builder** for desktop.

## Code layout
Follows the electron-vite (`@electron-toolkit` vanilla-ts) convention, with the plan's
`core`/`ui` modules living inside the renderer:
```
src/main/              Electron main process — windows, IPC, file dialogs, bundled template
src/preload/           contextBridge bridge (openStl/saveStl/loadTemplate) + global typings
src/shared/api.ts      typed BoxmakerApi + IPC channel names, imported by main AND renderer
src/renderer/          the web app (this is also the future standalone browser build)
  index.html
  src/main.ts          renderer bootstrap (inits manifold WASM, mounts UI)
  src/core/            geometry + image processing, NO UI — the Vitest target
  src/ui/              Three.js viewer, 2D placement editor, sidebar controls
resources/             runtime assets bundled by electron-builder (template.stl goes here)
out/                   build output (gitignored)
```
Path aliases: `@core`, `@ui`, `@shared`, `@renderer` (see electron.vite.config.ts /
tsconfig.web.json / vitest.config.ts).

`core/` (UI-free, the Vitest target): STL I/O, vertex welding, connected-component splitting
(hinge safeguard), noise-shell removal + inter-piece clearance (`components.ts`,
`clearance.ts`), the face coordinate basis + flood-fill `detectFace` (`faces.ts`), image
threshold + smoothed sub-pixel marching-squares `traceSmoothContours` (blurred grayscale field, so outlines aren't pixel staircases; `image-trace.ts`), the manifold cut pipeline
`engraveFace` (per-placement **etch** or **emboss** — raised art unioned outward after the
etches, height capped by a `freeSpace` raycast against the other pieces), the de-etch `smoothRegion`, the whole-model `applyProject`, and the
wall-thickness raycast `wallThickness` (`engrave.ts`), undo/redo history (`history.ts`),
export-time validation + repair (`validate.ts`, `repair.ts`, `export.ts`), the export-time
uniform scale with hinge-gap restoration (`scale-export.ts`: `scaleMeshes`, exact
`measureExactGap`, `restoreClearance` carving `piece − (neighbour ⊕ ball(gap))` so scaling
never closes the print-in-place hinge), and the
dependency-free STORED `.zip` writer + CRC-32 (`zip.ts`).

`ui/`: `viewer.ts` (Three.js, OrbitControls, raycast face picking, overlay/cut preview,
rubber-band de-etch selection), `preview-overlay.ts` (decal builder), `controls.ts` (load /
preview toggle / add-image / de-etch / undo-redo / export), `placement-editor.ts` (SVG
drag/aspect-resize/rotate handles + numeric mm·° and cut-setting fields, margin-clamp). The
browser I/O shim `web-io.ts` (NOT in `ui/`; lives in `src/renderer/src/`) does file-open,
`.zip` download, and IndexedDB template persistence — the web counterpart to `BoxmakerApi`.
`main.ts` wires model load (Electron bridge or browser picker + IndexedDB restore), picking →
editor open → `history.push`, de-etch, export (`applyProject` → `prepareForExport` → save),
and preview re-render on every state change.

Geometry invariants worth knowing: all booleans go through `toManifold`, which repairs +
**orients meshes outward first** (an inward-wound import otherwise inverts unions — a de-etch
would carve instead of fill). De-etch fills over the selection rect directly and is NOT
clipped to the coplanar face region (the recess is a hole in it). Repair guarantees exports
have no non-manifold edges/vertices, reversed faces, degenerate/duplicate triangles, or
non-finite coords; holes/slivers/tight-clearances are non-blocking warnings.

## Still needed from the user before coding
- The template STL, sample images, confirmed default cut depth/margin, and whether the lid
  underside is ever engraved. See the "Open inputs" section in PLAN.md.
