# boxmaker

An app that engraves (debosses) user images into the faces of a fixed print-in-place
hinged jewelry-box STL and exports a printable STL. Ships first as a single-page browser
app, then as an Electron desktop app for Mac + Windows.

**Status: electron-vite scaffold in place; core geometry/image modules are typed stubs
(some implemented, some `throw "not implemented"` with `TODO(stageN-stepM)` markers).**

The full plan — goals, decisions, cutting pipeline, hinge safeguards, tech stack, and
build order — lives in [docs/PLAN.md](docs/PLAN.md). Read it before starting work.

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

`core/` is implemented for STL I/O, vertex welding, connected-component splitting (the hinge
safeguard), the face coordinate basis, and image thresholding. Marching-squares tracing, the
manifold cut pipeline, and the UI interactions are stubbed with `TODO(stageN-stepM)` markers
matching the build order in PLAN.md §8.

## Still needed from the user before coding
- The template STL, sample images, confirmed default cut depth/margin, and whether the lid
  underside is ever engraved. See the "Open inputs" section in PLAN.md.
