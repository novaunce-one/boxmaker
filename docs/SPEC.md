# boxmaker — Software Specification

> Derived from [docs/PLAN.md](PLAN.md) (planning conversation, 2026-11-07).
> The plan is the rationale and decision log; this spec is the normative,
> testable statement of what the software must do. Requirement IDs (e.g. `FR-3`)
> are referenced by tests and commits.
>
> Keyword conventions: **MUST** / **MUST NOT** = required, **SHOULD** =
> recommended, **MAY** = optional. Units are millimetres (mm) unless stated.

---

## 1. Overview

### 1.1 Purpose
boxmaker lets a user deboss (cut) uploaded images into the outer faces of a
fixed, print-in-place hinged jewelry-box STL and export a printable STL, without
damaging the print-in-place hinge.

### 1.2 Scope
- **In scope (v1):** load one hinged-box template STL, pick a coplanar outer
  face, place/scale/rotate one or more images on it, tune the cut, preview the
  result in 3D, and export an STL. Delivered as a browser app first, then an
  Electron desktop app.
- **Out of scope (v1):** arbitrary/unknown box models, embossing (raised) or
  colored artwork, multi-material/3MF export, auto-updates, mobile.

### 1.3 Delivery stages
| Stage | Deliverable | Requirements in force |
| --- | --- | --- |
| 1 | Single-page browser app | All FR/NFR except `FR-DESK-*` |
| 2 | Electron desktop app (macOS + Windows) | Adds `FR-DESK-*`; relaxes `FR-EXP-2` (.zip) |

### 1.4 Definitions
- **Template** — the supplied hinged-box STL used as the fixed starting model.
- **Piece** — one connected component of the template mesh (lid, base, hinge pin…).
- **Face** — a maximal set of coplanar, same-normal, edge-connected triangles on one piece.
- **Placement** — an image positioned on a face in that face's (u, v) mm frame.
- **Cutter** — the extruded solid subtracted from a piece to form an engraving.

---

## 2. Functional requirements

### 2.1 Template loading (`FR-LOAD`)
- **FR-LOAD-1** The app MUST load a binary STL template. ASCII STL MAY be
  rejected with a clear message (see `ERR-STL-ASCII`).
- **FR-LOAD-2** The browser build MUST persist the last-loaded template in
  IndexedDB and restore it on next launch. The desktop build MUST load a
  template bundled with the app (`resources/template.stl`).
- **FR-LOAD-3** On load the app MUST split the template into pieces
  (§2.6) and display it in the 3D view (§2.2), centered and fully visible.

### 2.2 3D view & face picking (`FR-VIEW`)
- **FR-VIEW-1** The view MUST render the template and support orbit, pan, and zoom.
- **FR-VIEW-2** The view MUST be **Z-up** (`camera.up = (0,0,1)`), consistent
  with the face-basis math (§2.3, `FR-FACE-3`).
- **FR-VIEW-3** Clicking a surface MUST raycast to a triangle and flood-fill its
  coplanar face (§2.3), highlighting the whole face.
- **FR-VIEW-4** The view MUST update the engraving preview as placements/cut
  settings change, debounced (§4, NFR-PERF-1).

### 2.3 Face detection (`FR-FACE`)
- **FR-FACE-1** A face MUST be the set of triangles reachable from the seed
  triangle by crossing shared edges while staying within an angle tolerance
  (default 1°) and plane-offset tolerance (default 0.05 mm).
- **FR-FACE-2** Face detection MUST operate on the welded, indexed mesh of the
  piece that owns the seed triangle, and MUST record that `pieceId`.
- **FR-FACE-3** For a face with outward unit normal `n`, the in-plane basis
  MUST be:
  - side faces (|n·Z| ≤ 0.99): `v` = world +Z projected onto the plane; `u = v × n`;
  - top/bottom faces (|n·Z| > 0.99): `v` = world +Y projected onto the plane; `u = v × n`.
  The basis MUST be right-handed so that `u × v = n` (image reads correctly from
  outside the box — i.e. not mirrored).
- **FR-FACE-4** v1 MUST allow picking any outer face. Whether the lid underside
  is selectable is gated on `OQ-4` (§8).

### 2.4 Image placement editor (`FR-EDIT`)
- **FR-EDIT-1** Selecting a face MUST open a 2D editor showing that face's
  outline and the margin inset (§2.5).
- **FR-EDIT-2** The user MUST be able to add one or more images to a face from a
  file. Each face MAY hold several placements.
- **FR-EDIT-3** A placement MUST be movable (drag), resizable with **locked
  aspect ratio** (handles), and rotatable about the face normal (handle), with
  equivalent numeric entry in exact mm / degrees.
- **FR-EDIT-4** The editor MUST show a live preview of the thresholded binary
  mask (§2.7) for each placement.
- **FR-EDIT-5** The editor MUST prevent a placement's artwork from crossing the
  margin inset (§2.5, `FR-HINGE-2`); it MAY clip or block the move.

### 2.5 Cut settings (`FR-CUT`)
- **FR-CUT-1** Per placement the user MUST control: threshold (0–255), invert
  (bool), depth (mm), and **outline smoothing** (mm; slider + number). Defaults:
  threshold 128, invert off, depth **0.6 mm**, smoothing **0.3 mm** (`OQ-3`; see FR-IMG-6).
- **FR-CUT-2** Edge margin MUST be adjustable per project; default **2 mm** (`OQ-3`).
- **FR-CUT-3** The depth control (slider + number + **Max**) MUST be limited to
  the measured wall thickness under the image minus `MIN_WALL_MM`, so an
  engraving can never go through the face. It MUST show the wall thickness and
  the resulting maximum, clamp typed/slider values to it, and — if the stored
  depth exceeds the limit at the current position — state the depth that will
  actually be cut (the engraver applies the same cap, `WARN-DEPTH`).
- **FR-CUT-4** Each placement has a **mode**: `etch` (default; cut inward by depth)
  or `emboss` (raised outward by `height`, default 0.6 mm, max `MAX_EMBOSS_MM` =
  3 mm). Dark pixels are cut/raised; Invert flips that. An embossed image is
  clipped to the face margin like an etch, overlaps `EMBOSS_FUSE_MM` into the wall
  so it fuses with the surface, and is unioned after all etches on the piece so an
  etch never cuts raised art. The height control (slider, number, **−** / **+**
  0.1 mm steppers, **Max**) MUST be limited to the free space above the image
  (rays along +normal against the piece and the other pieces) minus
  `MIN_CLEARANCE_MM`; the engraver applies the same cap and warns (`WARN-HEIGHT`),
  and skips the image when no space remains. Overlay preview tints raised art
  light and etched art dark. Project files without `mode`/`height` open as etch.

### 2.6 Piece splitting / hinge protection (`FR-HINGE`)
- **FR-HINGE-1** The template MUST be split into connected components by welding
  vertices within tolerance (default 1e-4 mm) and union-find over shared vertex
  indices. Booleans MUST run only on the piece containing the selected face;
  all other pieces MUST be passed through **unchanged** (byte-for-byte in the
  exported model where feasible).
- **FR-HINGE-2** Artwork MUST stay ≥ the edge margin from every edge of the face
  (default 2 mm), keeping cuts clear of hinge knuckles and the lid lip.
- **FR-HINGE-3** A wall-thickness guard MUST raycast inward (−normal) from
  sample points across the artwork and cap depth so ≥ **0.8 mm** of material
  remains; the app MUST warn if the user requests a deeper cut.
- **FR-HINGE-4** Before export the app MUST run a break-through check confirming
  no cut pierces a wall (e.g. removed-volume vs. cutter-volume, or re-raycast),
  and MUST warn on failure.

### 2.7 Image → mask → geometry (`FR-IMG`)
- **FR-IMG-1** An image MUST be converted to grayscale (Rec. 601 luma),
  thresholded, optionally inverted, into a binary mask (1 = cut, 0 = keep).
- **FR-IMG-2** The mask MUST be downscaled so its long edge is ≈ 400 px before
  tracing.
- **FR-IMG-3** The artwork outline MUST be traced with marching squares into
  contours (outer rings + holes); geometry uses the smoothed sub-pixel tracer of
  FR-IMG-6 and is then thinned at a fixed 0.02 mm tolerance. (The binary-mask
  `traceContours` remains for tests and the nozzle check.)
- **FR-IMG-4** Contours MUST build a manifold `CrossSection` using the **EvenOdd**
  fill rule, then `simplify()`.
- **FR-IMG-5** The app MUST flag artwork whose thinnest traced feature is below
  ≈ 0.4 mm at the placed size (too fine for a 0.4 mm nozzle) with a warning.
- **FR-IMG-6** Outlines MUST NOT be pixel staircases. The tracer MUST keep the
  grayscale (signed field `threshold − luma`, flipped by Invert), blur it with a
  Gaussian whose sigma is the placement's **smoothing** in mm (converted to field
  cells via the placed width; 0 skips the blur), and run marching squares with
  linear interpolation along cell edges so vertices land at sub-pixel positions.
  Shapes touching the image border MUST still close (background padding).
- **FR-IMG-7** The overlay decal and the editor's preview MUST be drawn from the
  same traced rings (even-odd fill) as the real cut/emboss, so the previews show
  the smoothing. Preview traces are cached by image, threshold, invert, smoothing
  and a coarse size bucket; geometry uses the exact, uncached trace.

### 2.8 Engraving (boolean) pipeline (`FR-ENG`)
For each placement on the selected face, the app MUST:
- **FR-ENG-1** Clip the artwork to the face region: union the face's projected
  triangles into a `CrossSection`, `offset(-margin)`, and intersect with the
  artwork `CrossSection`.
- **FR-ENG-2** Extrude the clipped cross-section to `depth + ε` and transform it
  into place so the cutter starts ε **outside** the surface and extends `depth`
  inward along −normal.
- **FR-ENG-3** Subtract the cutter(s) from the owning piece and produce a
  watertight manifold result.
- **FR-ENG-4** The operation MUST NOT alter any other piece (see `FR-HINGE-1`).

### 2.9 Export (`FR-EXP`)
- **FR-EXP-1** Export MUST recombine the engraved piece with all untouched
  pieces into a single STL.
- **FR-EXP-2** Browser build: because the hosted artifact page only allows
  certain download extensions, export MUST produce a **.zip containing the
  .stl**. If hosted where `.stl` downloads are allowed, a plain `.stl` MAY be
  produced. Desktop build: export MUST save a `.stl` directly via a native dialog.
- **FR-EXP-3** The exported STL MUST be a valid binary STL re-loadable by the app.

### 2.10 Desktop app (`FR-DESK`) — Stage 2
- **FR-DESK-1** The renderer MUST run with `contextIsolation: true` and
  `nodeIntegration: false`.
- **FR-DESK-2** The preload MUST expose only the `BoxmakerApi` (§6) via
  `contextBridge`: `openStl`, `saveStl`, `loadTemplate`.
- **FR-DESK-3** The main process MUST implement native open/save dialogs, disk
  access, and the bundled template; heavy mesh work MAY run here.
- **FR-DESK-4** Packaging MUST produce a universal macOS `.dmg` (Apple Silicon +
  Intel) and a Windows `.exe` (NSIS), built on their respective OS runners.

### 2.11 Undo / redo (`FR-UNDO`)
- **FR-UNDO-1** The app MUST maintain an undo/redo history of the editable
  project state (`ProjectState`: per-face placements + cut settings + margin).
- **FR-UNDO-2** Every committed edit — add/delete an image, move/resize/rotate a
  placement, change a cut setting or the margin — MUST push one history entry.
- **FR-UNDO-3** Undo MUST restore the previous state; redo MUST reapply it. The
  redo branch MUST be cleared when a new edit is committed after an undo.
- **FR-UNDO-4** Undo/redo MUST be reachable via sidebar buttons (disabled when
  unavailable) and the accelerators Cmd/Ctrl+Z (undo) and Shift+Cmd/Ctrl+Z or
  Ctrl+Y (redo).
- **FR-UNDO-5** Loading a new template MUST reset the history. History depth MAY
  be capped (default 100 steps); snapshots MUST share decoded images by
  reference to bound memory.

### 2.12 Export validation & repair (`FR-VALIDATE`, `FR-REPAIR`)
Goal: the exported STL MUST NOT contain the defects an external repair tool
(e.g. formware.co/onlinestlrepair) would fix — chiefly **non-manifold edges**
and **reversed faces** (flipped/inconsistent normals).
- **FR-VALIDATE-1** Before writing the STL the app MUST validate the assembled
  mesh and detect: non-manifold edges, non-manifold vertices ("bowties"),
  reversed faces (inconsistent winding), degenerate (zero-area) triangles,
  duplicate triangles, open boundary edges (holes), unreferenced vertices,
  non-finite (NaN/Inf) coordinates, and sliver (near-degenerate) triangles.
- **FR-VALIDATE-2** Self-intersection detection is OUT OF SCOPE: the booleaned
  piece is non-self-intersecting by construction (manifold-3d), and checking
  pass-through pieces is not worth the O(n²) cost.
- **FR-REPAIR-1** The app MUST automatically, before export, eliminate
  non-manifold edges (split the shared edge so no edge is used by > 2
  triangles), non-manifold vertices (the same split separates disjoint fans),
  and reversed faces (make winding consistent per component, then orient outward
  by signed volume). It MUST also drop degenerate, duplicate, and non-finite
  triangles and unreferenced vertices.
- **FR-REPAIR-2** Repair MUST preserve geometry (vertex positions MUST NOT move)
  and MUST NOT fill holes or stitch boundaries (which could fuse the hinge).
- **FR-REPAIR-3** Export MUST report which defects were repaired, and MUST
  surface any remaining non-blocking problems (holes, slivers, tight clearances)
  as warnings rather than silently shipping or silently altering the model.
- **FR-REPAIR-4** After repair the mesh MUST satisfy `isExportable`: zero
  non-manifold edges and vertices, zero reversed faces, zero degenerate and
  duplicate triangles, zero non-finite coordinates. (Watertightness and slivers
  are reported, not required — see §6 note on print-in-place templates.)

### 2.14 Live preview views (`FR-PREVIEW`)
- **FR-PREVIEW-1** The 3D view MUST offer two switchable preview modes of the
  engraved result, both re-rendered on every edit, undo, and redo:
  - **overlay** — the thresholded image shaded onto the picked face as a decal
    (no geometry change); fast, for interactive editing.
  - **cut** — the true recessed geometry from the manifold boolean (matches
    export); recomputed debounced (~150 ms).
- **FR-PREVIEW-2** De-etch fills (FR-DEETCH) are folded into each piece's base
  geometry and are visible in both modes.

### 2.15 De-etch / smooth a region (`FR-DEETCH`)
For an imported box that already carries engraving:
- **FR-DEETCH-1** The user MUST be able to pick an etched face and drag a
  rubber-band **selection box** over an area; the screen rectangle is projected
  onto the face plane to a (u,v) mm `Rect2`.
- **FR-DEETCH-2** The selected area MUST be de-etched — its recesses filled back
  flush with the surface so it becomes smooth — by a boolean **union** of a slab
  that sits on the face plane and extends inward far enough to cap the recess.
- **FR-DEETCH-3** De-etch MUST NOT be clipped to the coplanar face region (the
  recess is a hole in that region); it fills over the selection directly. Only
  the owning piece is modified, preserving the hinge. Geometry elsewhere is
  untouched.
- **FR-DEETCH-4** De-etch operations MUST be recorded in `ProjectState` so they
  participate in undo/redo and the live preview.
- **FR-DEETCH-5** Meshes MUST be oriented outward before any boolean (an
  inward-wound import would otherwise invert unions and carve instead of fill).

### 2.13 Noise shells & hinge clearance (`FR-SHELL`, `FR-CLEAR`)
- **FR-SHELL-1** The app MAY remove stray "noise" shells — tiny disconnected
  components that are print artifacts, not real parts. Defaults MUST be
  conservative (drop a component only if it has < 4 triangles or enclosed volume
  < 1e-3 mm³) so legitimate small hinge parts are never discarded. Removal MUST
  be reported.
- **FR-CLEAR-1** The app SHOULD measure the minimum gap between distinct pieces
  and warn when a joint is closer than a printable clearance (configurable),
  since sub-clearance gaps fuse when printed and destroy a print-in-place hinge.
  The measure MAY be vertex-based (approximate) for performance.

### 2.16 Project files (`FR-PROJECT`)
- **FR-PROJECT-1** The app MUST let the user **Save** and **Save As** the editable
  project to a `.boxmaker` file, and **Open** one later. Shortcuts: Cmd/Ctrl+S
  (save), Shift+Cmd/Ctrl+S (save as), Cmd/Ctrl+O (open).
- **FR-PROJECT-2** A project file MUST be self-contained: the template STL, every
  placed image (stored once, even if shared), and the `ProjectState` (placements,
  cut settings, de-etch regions, margin). Undo history is NOT saved.
- **FR-PROJECT-3** Save overwrites the file the project was opened from / last
  saved to; Save As (and the first Save) asks for a destination. Loading a
  template makes the project untitled.
- **FR-PROJECT-4** The title MUST show the project name, with a `•` while there
  are unsaved changes; actions that would discard them (open, load template)
  MUST confirm first.
- **FR-PROJECT-5** Opening MUST reject non-project or unsupported-version files
  with a clear message, and MUST verify saved faces still index real triangles of
  the embedded template (`checkProjectFits`).
- **FR-PROJECT-6** Desktop: the renderer MAY only silently overwrite paths the
  user previously chose in a native dialog (NFR-SEC-1). Browser: use the File
  System Access API where available, else fall back to a download.
- **FR-PROJECT-7** `ProjectState` carries `exportScale` and `hingeGapMm`; project
  files written before they existed MUST open at 100% / "match template".

### 2.17 Export scale & hinge-gap restoration (`FR-SCALE`)
- **FR-SCALE-1** The user MUST be able to set a uniform export scale (10–400%,
  default 100%). It applies to the finished, engraved box at export only (image
  mm sizes and cut depth scale with it); the preview stays at template size. The
  setting is part of the undoable/saved project and the UI shows the resulting
  outer size.
- **FR-SCALE-2** Scaling is about the model's minimum corner (the box stays on
  the bed). At exactly 100% with no gap override, export MUST be byte-identical
  to the unscaled pipeline.
- **FR-SCALE-3** After scaling, every pair of pieces closer than the target gap
  MUST be re-opened to at least the target by carving the bulkier piece
  (`piece − (neighbour ⊕ ball(target))`, restricted to the neighbour's part near
  the piece). Pieces already far enough apart (including any scale-up) MUST NOT
  be modified.
- **FR-SCALE-4** The target gap is the user's "Hinge gap" override, else the
  template's own exact surface-to-surface gap (`measureExactGap`, manifold
  `minGap`), which is known to print. The achieved gap MUST be re-measured; if it
  is still below target, export warns.
- **FR-SCALE-5** The wall-thickness guard MUST run in template units with
  `MIN_WALL_MM / scale`, so scaled walls keep ≥ `MIN_WALL_MM`. Export MUST note
  that pins and walls shrink with the box below ~70%.
- **FR-SCALE-6** Export shows a busy state while the geometry work runs (several
  seconds on the real template when a carve is needed).

---

## 3. Data model

Authoritative TypeScript lives in `src/renderer/src/core/types.ts` and
`src/shared/api.ts`; this section is the normative summary.

| Type | Meaning | Key fields |
| --- | --- | --- |
| `TriangleMesh` | Raw STL triangle soup | `positions` (triCount·9), `normals?`, `triangleCount` |
| `IndexedMesh` | Welded, indexed mesh | `vertices` (vtxCount·3), `indices` (triCount·3) |
| `MeshPiece` | One connected component | `id`, `mesh: IndexedMesh` |
| `FacePlane` | Selected coplanar face | `origin`, `normal`, `u`, `v`, `triangles[]`, `pieceId` |
| `Placement` | Image on a face (mm frame) | `center`, `size`, `rotation`, `image`, `cut` |
| `ImageSource` | Decoded pixels | `width`, `height`, `rgba` |
| `CutSettings` | Per-placement cut controls | `threshold`, `invert`, `depth`, `smoothing` |
| `FaceWork` | A face + its placements | `face`, `placements[]` |
| `ProjectState` | Editable state (undo unit) | `faces: FaceWork[]`, `marginMm` |
| `MeshDiagnostics` | Validation report | `nonManifoldEdges`, `nonManifoldVertices`, `inconsistentlyOrientedEdges`, `degenerateTriangles[]`, `duplicateTriangles`, `boundaryEdges`, `unreferencedVertices`, `nanVertices`, `sliverTriangles[]`, `isWatertight`, `isManifold` |
| `ExportResult` | Export output | `stl`, `diagnostics`, `clean`, `repaired[]`, `warnings[]` |
| `ClearanceReport` | Min inter-piece gap | `minGap`, `betweenPieces` |
| `Rect2` | AA rect in face (u,v) mm | `min`, `max` |
| `SmoothWork` | De-etch regions on a face | `face`, `rects: Rect2[]` |
| `PreviewMode` | Which preview is shown | `'overlay' \| 'cut'` |

`ProjectState` now also carries `smoothed: SmoothWork[]` (the de-etch operations).

Constants (normative defaults): `DEFAULT_CUT` (threshold 128, invert false,
depth 0.6, smoothing 0.3), `DEFAULT_MARGIN_MM = 2`, `MIN_WALL_MM = 0.8`,
`EMPTY_PROJECT`, History limit 100.

---

## 4. Non-functional requirements

- **NFR-PERF-1** Live preview updates MUST be debounced so edits stay
  responsive; a single cut on the real template SHOULD complete within ~1 s on a
  typical laptop.
- **NFR-PORT-1** The `core/` and `ui/` code MUST be identical between the
  browser and desktop builds; only the file-I/O shell differs (web shim vs.
  `BoxmakerApi`).
- **NFR-ROBUST-1** Manifold construction MUST fail loudly on a non-manifold
  piece; the app MUST attempt repair (vertex merge with tolerance) and report
  clearly if repair fails (`ERR-NONMANIFOLD`). Only the piece being cut must be
  manifold.
- **NFR-SEC-1** (desktop) The renderer MUST NOT have Node integration; all
  privileged operations go through the typed preload bridge.
- **NFR-TEST-1** `core/` is the primary test target; geometry steps MUST be
  tested against the real template STL once supplied (§7).

---

## 5. Error & warning conditions

| Code | Condition | Behavior |
| --- | --- | --- |
| `ERR-STL-ASCII` | ASCII STL supplied | Reject with message; ask for binary STL |
| `ERR-STL-TRUNCATED` | Byte length < header+count·50 | Reject with message |
| `ERR-NONMANIFOLD` | Selected piece not manifold after repair | Block cut; explain |
| `WARN-DEPTH` | Requested depth leaves < 0.8 mm wall | Warn; cap at guard |
| `WARN-FINE` | Feature < ~0.4 mm at placed size | Warn; allow override |
| `WARN-BREAKTHROUGH` | Pre-export check finds a through-cut | Warn; allow override/cancel |
| `INFO-REPAIRED` | Repair fixed non-manifold edges/vertices, reversed faces, etc. on export | Inform; list fixes |
| `WARN-HOLES` | Final mesh still has open edges (not watertight) | Warn (non-blocking); allow export |
| `WARN-SLIVER` | Non-degenerate but very thin triangles present | Warn (non-blocking) |
| `WARN-CLEARANCE` | Two pieces closer than the printable clearance | Warn (non-blocking); joint may fuse |
| `INFO-NOISE` | Stray noise shells removed | Inform; list removed |

---

## 6. IPC / API contract (desktop)

Defined in `src/shared/api.ts`, imported by both main and renderer.

```ts
interface BoxmakerApi {
  openStl(): Promise<StlFile | null>           // channel "stl:open"
  saveStl(fileName: string, data: Uint8Array)  // channel "stl:save"
    : Promise<SaveResult>
  loadTemplate(): Promise<StlFile | null>      // channel "template:load"
  openProject(): Promise<ProjectFile | null>   // channel "project:open"
  saveProject(suggestedName: string, data: Uint8Array,
              filePath?: string): Promise<SaveResult>  // channel "project:save"
}
interface StlFile { name: string; data: Uint8Array }
interface SaveResult { canceled: boolean; filePath?: string }
```

- The browser build MUST provide a web shim implementing the same interface
  (file input for open, `.zip` download for save, IndexedDB for template).

---

## 7. Acceptance criteria & test plan

Traceable to the FR IDs; Vitest targets `core/`.

| Test | Verifies |
| --- | --- |
| STL round-trip (write→parse equal) | `FR-LOAD-1`, `FR-EXP-3` ✅ implemented |
| Two disjoint tris → 2 pieces; shared-edge quad → 1 piece | `FR-HINGE-1` ✅ implemented |
| `u × v = n` for ±X/±Y/±Z normals | `FR-FACE-3` ✅ implemented |
| Dark pixel cut, light pixel kept | `FR-IMG-1` ✅ implemented |
| Undo/redo sequence, redo-branch clear, limit, reset | `FR-UNDO-1/3/5` ✅ implemented |
| Non-manifold edge detected, then repaired to 0 on export | `FR-VALIDATE-1`, `FR-REPAIR-1/4` ✅ implemented |
| Reversed face detected, then repaired to consistent/outward | `FR-VALIDATE-1`, `FR-REPAIR-1/4` ✅ implemented |
| Degenerate/duplicate/unreferenced detected + removed | `FR-VALIDATE-1`, `FR-REPAIR-1` ✅ implemented |
| Non-manifold vertex (bowtie) detected + repaired | `FR-VALIDATE-1`, `FR-REPAIR-1` ✅ implemented |
| Non-finite coords detected + triangles dropped | `FR-VALIDATE-1`, `FR-REPAIR-1` ✅ implemented |
| Sliver triangle flagged, not blocking | `FR-VALIDATE-1`, `WARN-SLIVER` ✅ implemented |
| Noise shell removed; real solids kept | `FR-SHELL-1`, `INFO-NOISE` ✅ implemented |
| Inter-piece gap measured; tight joint warned | `FR-CLEAR-1`, `WARN-CLEARANCE` ✅ implemented |
| Export reports what it repaired; holes warned not blocked | `FR-REPAIR-3/4`, `WARN-HOLES` ✅ implemented |
| Merge pieces offsets indices; STL re-parses | `FR-EXP-1/3` ✅ implemented |
| Browser `.zip` wraps the `.stl` (valid STORED archive + CRC-32) | `FR-EXP-2` ✅ implemented |
| 2D editor: drag/resize(aspect)/rotate + numeric mm·° + margin clamp | `FR-EDIT-1..5`, `FR-CUT-1/2` ✅ implemented (UI) |
| Flood-fill isolates one face on the real template | `FR-FACE-1/2` — pending STL |
| Marching-squares trace of a block / block-with-hole → 1 / 2 rings | `FR-IMG-3/4` ✅ implemented |
| Smoothed trace: pixelated circle rounder, block area true, sub-pixel edge, holes/invert/border | `FR-IMG-6` ✅ implemented |
| engraveFace debosses a cube: volume drops, stays watertight | `FR-ENG-1..4` ✅ implemented (synthetic) |
| smoothRegion refills an etched notch flush (volume restored) | `FR-DEETCH-2/3/5` ✅ implemented (synthetic) |
| Preview re-renders on undo/redo in both overlay and cut modes | `FR-PREVIEW-1/2` ✅ implemented |
| Cut on real template leaves other pieces unchanged | `FR-HINGE-1`, `FR-ENG-4` — pending STL |
| Depth guard caps at 0.8 mm wall; warns | `FR-HINGE-3`, `WARN-DEPTH` ✅ implemented (synthetic) |
| Last template restored from IndexedDB on next launch | `FR-LOAD-2` ✅ implemented (browser) |
| Break-through check flags a through-cut | `FR-HINGE-4`, `WARN-BREAKTHROUGH` — pending |
| End-to-end: load → place sample logo → cut → export valid STL | Stage 1 exit — pending STL + sample |

**Stage 1 exit:** all FR/NFR (except `FR-DESK-*`) met and the end-to-end test
passes with a real template + sample logo, page published.
**Stage 2 exit:** `FR-DESK-*` met; signed/notarized builds gated separately.

---

## 8. Open questions (blockers from Lorn — see PLAN §9)

- **OQ-1** The template STL (hinged jewelry box). *Blocks all pending tests.*
- **OQ-2** One or two representative sample images.
- **OQ-3** Confirm default cut depth / edge margin (proposed 0.6 mm / 2 mm).
- **OQ-4** Is the lid underside ever engraved, or only outer faces? *Gates `FR-FACE-4`.*

---

## 9. Traceability to tech stack (PLAN §7)

TypeScript · Three.js 0.187.0 (view, raycast, STLLoader, mergeVertices) ·
manifold-3d 3.5.4 WASM (components, CrossSection, extrude, boolean subtract) ·
Canvas API (threshold, tracing) · Vite / electron-vite / electron-builder ·
Vitest. Versions were latest on npm as of 2026-11-07.
