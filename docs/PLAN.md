# Jewelry Box Image-Engraving App — Project Handoff

> Handoff from a planning conversation (2026-11-07) for use in Claude Code.
> Status: **planning complete, no code written yet.**

---

## 1. Goal

Build an app that takes an existing **STL of a jewelry box with a print-in-place hinge** (used as a fixed
template), lets the user **upload images and place them on the lid top and sides** with a graphical
drag/drop/resize/rotate editor, **cuts (debosses) the images into the surfaces**, and **exports a printable STL**.

Delivery in two stages:
1. **Browser app** (single HTML page) — get the engraving and hinge safeguards right here first.
2. **Mac + Windows desktop app** — the same code wrapped in **Electron**.

## 2. Decisions made

| Topic | Decision |
| --- | --- |
| How images are applied | **Cut into the surface (deboss/engrave)** — not embossed, not color |
| Template | One fixed hinged-box STL supplied by the user (not arbitrary boxes) |
| Language | **TypeScript** throughout |
| Desktop framework | **Electron** (chosen over Tauri for identical Chromium on both OSes) |
| Rejected | NativeScript — mobile-focused (iOS/Android); macOS only as a preview Node-API runtime, no Windows; no browser engine for the 3D view/WASM, so it would be a near rewrite |
| Build order | Browser version first, then Electron wrapper |
| Future mobile (optional) | Capacitor would wrap the same web code if an iPad/phone version is ever wanted |

## 3. User workflow

1. **Load the template** — STL loaded once; the browser version remembers it (IndexedDB); desktop bundles it.
2. **Pick a face** — click the lid top or a side in a rotatable 3D view; the app flood-fills the whole coplanar
   face and highlights it.
3. **Place the image** — a 2D editor shows that face's outline; drag, resize (aspect-locked) and rotate with
   handles, or enter exact mm values.
4. **Tune the cut** — black/white threshold, invert, cut depth, edge smoothing; preview shows exactly which
   areas will be cut.
5. **Live 3D preview** — engraving updates on the box as you edit (debounced).
6. **Repeat** for other faces; each face can hold several images.
7. **Export** the finished STL.

## 4. How the cutting works

- Image → grayscale → threshold (+ optional invert) → binary mask (downscale to ~400 px on the long edge).
- Trace mask with **marching squares** → contours (outer + holes) → simplify.
- Build a manifold `CrossSection` from the contours (EvenOdd fill rule), `simplify()`.
- **Clip** the artwork to the face region: union the face's projected triangles into a `CrossSection`,
  `offset(-margin)`, then intersect with the artwork.
- **Extrude** to `depth + ε`, transform into place so it starts ε outside the surface and extends `depth`
  inward along −normal, then **subtract** from the piece.
- Logos, monograms, line art give the sharpest results; photos need contrast adjustment first.

### Face coordinate frame (avoid mirrored images)
Assume Z-up (set `camera.up = (0,0,1)` in Three.js). For a face with outward normal `n`:
- Side faces: `v` = world Z projected onto the plane (image "up"), `u = v × n`.
- Top/bottom faces (n ≈ ±Z): `v` = world +Y, `u = v × n`.
This makes the image read correctly when viewed from outside the box (`u × v = n`).

## 5. Protecting the print-in-place hinge

- **Process only the piece being engraved.** Merge vertices, split the STL into connected components
  (union-find over shared vertex indices), build a manifold per component, and run booleans only on the
  component containing the selected face. Other pieces are passed through byte-for-byte. Hinge gaps between
  pieces cannot be closed by a cut.
- **Edge margin** — artwork stays ≥ margin from every edge of the face (default 2 mm, adjustable); keeps it
  clear of hinge knuckles and lid lip.
- **Wall-thickness guard** — raycast inward (−normal) from sample points across the artwork area; cap depth
  so ≥ 0.8 mm of material remains; warn if the user tries to go deeper.
- **Break-through check** — before export, confirm no cut goes through the wall (e.g. compare removed volume
  vs. cutter volume, or re-raycast).

## 6. Constraints & known issues

- **Browser download format:** the hosted claude.ai artifact page can only save allowlisted extensions
  (`.stl` is not allowed; `.zip` is). The browser build exports a **.zip containing the .stl**.
  If hosted elsewhere, a normal `.stl` download works. **The desktop app saves `.stl` directly.**
- **Mesh quality:** print-in-place STLs are sometimes not watertight. Manifold construction will throw on a
  non-manifold piece → attempt repair (merge vertices with tolerance), and report clearly if it fails. Only the
  piece being cut must be manifold.
- **Detail size:** features narrower than ~0.4 mm won't print cleanly on a 0.4 mm nozzle → flag too-fine artwork.

## 7. Tech stack

| Layer | Choice | Role |
| --- | --- | --- |
| Language | TypeScript | Typed face planes, placements (mm), cut settings, mesh pieces |
| 3D view | Three.js `0.187.0` (`@types/three`) | Rendering, orbit, raycast face picking, STLLoader, BufferGeometryUtils.mergeVertices |
| Geometry | manifold-3d `3.5.4` (WASM, ships TS types) | Components, CrossSection, extrude, boolean subtract, watertight output |
| Image processing | Canvas API | Threshold, invert, marching-squares tracing |
| Build (web) | Vite | Dev server; bundle to a single HTML page |
| Build (desktop) | electron-vite | Main, preload and renderer together |
| Desktop shell | Electron | Native windows, file dialogs, bundled template |
| Packaging | electron-builder | Universal `.dmg` (Apple Silicon + Intel), Windows `.exe` (NSIS) |
| CI | GitHub Actions | macOS + Windows runners build installers on each release |
| Tests | Vitest | Face detection, tracing, depth limits, against the real STL |

Versions above were the latest on npm on 2026-11-07.

### manifold-3d API notes (v3.5.4, from `manifold-encapsulated-types.d.ts`)
- Init: `import Module from 'manifold-3d'; const wasm = await Module(); wasm.setup(); const { Manifold, Mesh, CrossSection } = wasm;`
- `new CrossSection(contours: Polygons, fillRule?: FillRule)` / `CrossSection.ofPolygons(...)`
- `CrossSection`: `offset(...)`, `simplify(epsilon?)`, `transform(Mat3)`, `decompose()`, static `union`, `compose`
- `Manifold.extrude(...)`, `new Manifold(mesh: Mesh)`, `transform(Mat4)`, `decompose()`, static `union`/`compose`,
  `getMesh()`, `simplify(tolerance?)`, `setTolerance(...)`
- `new Mesh({ numProp, vertProperties, triVerts, ... })`

### Code layout
```
core/      geometry + image processing, no UI — shared everywhere, main test target
ui/        3D view, 2D placement editor, controls
desktop/   Electron main process + preload bridge
web/       browser entry point
```

### Electron structure
- **Renderer (window):** the web app UI, sandboxed — `contextIsolation: true`, `nodeIntegration: false`.
- **Preload bridge:** exposes only `openStl`, `saveStl`, `loadTemplate` via `contextBridge`, with a **shared typed
  interface** used by both renderer and main.
- **Main process:** file dialogs, disk access, bundled template, app menus. Node.js available here for heavy
  mesh work or a future 3MF export.

### Distribution notes
- Installers ~100–150 MB.
- **Mac:** Apple Developer account ($99/yr) + notarization, or Gatekeeper blocks the app. For personal use, an
  unsigned app can be approved manually once. Mac builds must run on macOS (use GitHub Actions macOS runner).
- **Windows:** code-signing cert optional for personal use; without it SmartScreen shows "unknown publisher".
- Auto-updates supported (electron-updater) but optional for v1.

## 8. Build order

### Stage 1 — browser app
1. Test geometry steps against the real STL: split into pieces, detect faces, trace image, cut, export.
2. Build the 3D view and face picking.
3. Build the 2D placement editor (drag / aspect-locked resize / rotate handles + numeric mm inputs; show face
   outline and margin inset; show thresholded mask preview).
4. Add live preview, hinge safeguards, export.
5. Test end to end with a sample logo; publish the page.

### Stage 2 — desktop app
1. Wrap the finished web app in an Electron shell with the preload bridge.
2. Replace browser file handling with native dialogs and direct `.stl` saving.
3. Bundle the template STL.
4. Set up electron-builder + GitHub Actions for Mac and Windows installers.
5. Add signing/notarization once distribution beyond own machines is decided.

## 9. Open inputs (still needed from Lorn)

- [ ] **The template STL** (hinged jewelry box)
- [ ] **One or two sample images** of the kind typically used
- [ ] **Default cut depth and edge margin** — proposed 0.6 mm depth, 2 mm margin
- [ ] **Lid underside** — ever engraved, or only outside faces?

## 10. Reference

- Plan doc (Claude Docs): https://claude.ai/artifact/JeXzJxbchpKKxQgij9dM4F

## 11. Conversation log (summary)

1. **Can Claude read/modify .3mf?** Yes — 3MF is a ZIP of XML (`3D/3dmodel.model` + slicer `Metadata/`);
   can transform, duplicate, boolean, edit slicer settings/filament assignments, render previews.
2. **Feasibility of the engraving app** — yes, as a browser app; key issues identified: STL has no color
   (so images become geometry), and the print-in-place hinge must be protected.
3. **User decision:** existing hinged-box STL is the template; images are **cut into** the surfaces.
4. Started prototyping; user asked to **plan only** → plan written, then saved to a Claude Doc.
5. **Mac/Windows executable?** Yes — wrap the web app (Tauri or Electron).
6. **Electron?** Yes — chosen; plan doc updated with a Desktop app (Electron) section.
7. **NativeScript?** Not a fit (mobile-focused, no Windows, no browser engine).
8. **TypeScript?** Yes — adopted; Tech stack section added to the plan doc.
9. Exported this handoff for Claude Code.
