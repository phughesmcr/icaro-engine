# Three.js code review (r183)

Snapshot review of the Three.js rendering code at `dev` 223a180, against the
pinned `three@0.183.0`. Like the other files in `docs/`, it is a snapshot: check
each claim against the code before acting on it.

**Method.** Four parallel read-only reviewers each covered one group of files
and one cross-file concern:

- world surfaces, lightmaps and warp
- models and meshes
- renderer setup and passes
- particles, WebXR and the 2D overlay

**Sources.** Best-practice claims were checked against three sources:

- **r183 source.** Files on the `r183` tag
  (`raw.githubusercontent.com/mrdoob/three.js/r183/src/...`):
  `WebGLRenderer.js`, `WebGLBackground.js`, `WebGLGeometries.js`,
  `WebGLAttributes.js`, `BufferGeometry.js`, `BatchedMesh.js` and `Material.js`.
- **The r183 manual.** These pages were read as `manual/en/<page>.html` at the
  same tag: `cleanup`, `responsive`, `optimize-lots-of-objects`,
  `rendering-on-demand`, `webxr-basics` and `tips`. The `threejs.org/docs` and
  `/manual` URLs returned only navigation shells or 404s to the fetch tool.
- **The C source.** `id-Software/Quake` for C-fidelity claims.

Every finding marked **verified** was re-read in the code by the lead reviewer,
and against the r183 or C source where that matters. **Reported** means one
reviewer found it and it was not re-checked.

**Not verified.** Nothing was run in a browser, a headset or a profiler. All
performance claims are static analysis. Before fixing a leak or draw-call
finding, a cheap way to confirm or kill it is to read `renderer.info.memory` and
`renderer.info.render.calls` before and after a few `map` changes on the
shareware pak.

**Not covered.**

- **Files only grepped:** `gl_rmisc.js` and most of `glquake.js` were grepped
  for allocations and `needsUpdate`, not read in full.
- **Allocation sweep:** the whole-frame sweep was partial. It covered the render
  path and the `new Float32Array` hits in client files, not every allocation in
  `src/`.
- **`WebGLRenderer.js`:** one reviewer read it through a summarising fetch. The
  quotes used here were re-checked in the raw file only for the background-clear
  logic and the `sortObjects` gate.
- **Migration Guide:** only partly read (r180-r183 entries).

**Server shim.** No proposed fix needs a new Three.js export.
`Uint16BufferAttribute` and `Uint32BufferAttribute` (fix 1) are already in
`server/browser_shim.js`. `DynamicDrawUsage` (fix 6c) is not in the shim, but it
would only be read inside the client draw path, as `r_part.js` already does. Add
it to the shim if anything reads it at import time.

## Status since the review

Fixes merged into or opened against `dev` after the snapshot:

- **#120** (merged): finding 1. One index attribute per `paliashdr`, shared by
  the entity and shadow geometries. The old shadow geometry is now disposed,
  which is half of finding 13. The regrown colour attribute is still replaced
  without freeing its buffer.
- **#121** (merged): finding 2. Water and sky geometries are tracked in a module
  `Set` and disposed in `GL_BuildLightmaps`, along with the cached water
  materials.
- **#122** (merged): findings 5 and 14. Alias materials are cached by skin
  texture, so a single-frame skin has one material pair, and the viewmodel keeps
  one registered clone per base material.
- **#129** (merged): findings 8 and 9, and finding 15's polyblend tone mapping,
  water transparency, per-frame `Set`, particle scratch vectors, batch key and
  stale comment. Not done from 15: `addUpdateRange` objects, brush entity group
  re-adds, shutdown disposal and `powerPreference`. For finding 9 it calls
  `setPixelRatio` after `setSize`, as `VID_Init` does, with no XR guard: while
  XR is presenting, r183 ignores both calls. #164 later added a guard:
  `VID_Resize` returns while XR is presenting, and a `sessionend` listener calls
  it again.

**Browser measurement (finding 2).** On the shareware pak in Chromium, a
four-map cycle was repeated with `renderer.info.memory` read after each map.
Before #121, `geometries` grew by 72 per cycle; after it, the count was flat
across cycles. Screenshots of each map after #120, #121 and #122 showed no
missing or broken world, sky or viewmodel geometry.

- **#131** (merged): finding 7. World batches set `sortObjects`,
  `perObjectFrustumCulled` and (underwater) `frustumCulled` to false. On e1m1
  the frame went from 1.34 to 0.75 ms at yaw 90, 11 of 12 test views got faster,
  and the output was pixel-identical.
- **#132** (merged): finding 6. The per-vertex lighting and colour upload are
  skipped unless the shade dots, shade light, pose templates or blend change.
  The colour attributes use `DynamicDrawUsage`. 60 idle frames made no upload,
  and the viewmodel relit when moved into a dark spot. Not done: lighting in the
  shader (6b), as nothing measured justified another shader variant.
- **#133** (merged): finding 3. `scene.background` is `null` outside XR and
  `GL_BeginRendering` clears colour only, leaving two clears per frame (colour,
  then `R_Clear`'s depth). The review's fix of dropping that colour clear, as C
  has none, was tried and rejected. Chromium kept old pixels around a small view
  (`viewsize 50`, `gl_clear 0`), so the clear stays as a marked deviation. XR
  still clears with a background colour.
- **#135** (merged): findings 4 and 10. The HUD quad has its own scene, rendered
  after the world only while XR is presenting. Two renders per XR frame are safe
  because `antialias: false` gives the XR target no samples (no
  colour-invalidating resolve), and a null background with `autoClear = false`
  clears nothing. HUD uploads are capped at 30 Hz, and a map swap no longer
  recompiles the material. Not verified on a headset. Not done from 10:
  uploading only when the overlay changed and sizing the canvas for the headset
  (both need `gl_draw.js`).
- **#136** (merged): finding 11's unused return object in `_calculateUIScale`.
  Overlay caching was not done: an open console made 679 to 1394 `drawImage`
  calls at about 0.4 ms of CPU, which doesn't justify it.

**Finding 12, not done in that round** (#215 did it later, below). On e1m3 the
world batches are in the scene at `R_NewMap`, but entity, water and particle
meshes are added lazily by the per-frame render. Only four programs compiled, on
the first two frames after signon (13 and 5 ms, on a warm page). `compileAsync`
at `R_NewMap` would only pre-compile world materials that the first frame
compiles anyway, not the mid-game compiles (dlight counts, first water or sky,
new entity materials).

**Finding 13, rest not done.** The regrown colour attribute is still replaced
without freeing its buffer. It regrows only when an entity switches to a model
with more vertices, so the leak is bounded.

Still open: the items above from 15 (`addUpdateRange` objects, brush entity
group re-adds, shutdown disposal and `powerPreference`), uploading the XR HUD
only on change (10), and the rest of 13. All were judged low value.

Later work on `dev`, checked against the code at `c0ea1d7` (2026-11-26), not in
a browser:

- **#158** (merged): finding 16. `R_BlendLightmaps` (`src/gl_rsurf.js`) no
  longer returns early with `gl_texsort 0`, so lightmaps update. TEX-1 in
  `port-review.md` also disputes the finding's reading of C: there
  `R_DrawSequentialPoly` uploads the changed rows itself. The C was not
  rechecked for this note.
- **#214** (merged): 15's context loss. `src/gl_contextloss.js` skips drawing
  while the context is lost, and on restore rebuilds the lightmaps and
  screenwarp and resets `depthRange`.
- **#215** (merged): finding 12. `R_WarmupStart` (`src/gl_warmup.js`), called
  after `R_NewMap` (`src/cl_parse.js:582`), runs `compileAsync` for the dlight
  buckets, with stand-ins for water, sky, sprites and particles, and holds the
  loading plaque for a capped time. Alias materials, the mirror pass and the
  render-target passes are not warmed, and XR is skipped.
- **#181** and **#212** (merged): finding 9's remark on full DPR. Touch-primary
  devices are capped at 2, `?dpr=` overrides, and `vid_quality` presets can set
  `vid_dprcap` (`src/vid.js` `VID_ComputePixelRatio`).

## Summary

| #  | Sev     | Area     | Finding                                                                                                 | Status                                                   |
| -- | ------- | -------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 1  | High    | models   | `setIndex( array )` makes a new index attribute and GL buffer on every pose change                      | verified; fixed (#120)                                   |
| 2  | Med     | world    | Water and sky geometries that are off screen at map change are never disposed; the renderer keeps them  | verified; fixed (#121, measured)                         |
| 3  | Med     | renderer | Each frame clears three times, two of them redundant                                                    | verified; fixed (#133, one colour clear kept on purpose) |
| 4  | Med     | XR       | `renderOrder` is ignored (`sortObjects = false`), so particles draw over the VR HUD                     | verified; fixed (#135, no headset test)                  |
| 5  | Med     | models   | Viewmodel material is cloned every 100 ms with default cvars, and the old clones are never disposed     | verified; fixed (#122)                                   |
| 6  | Med     | models   | Per-vertex CPU lighting and a full colour re-upload per alias entity per frame                          | verified; fixed (#132)                                   |
| 7  | Med     | world    | `BatchedMesh.sortObjects` defaults to true, so every batch is culled and sorted per instance each frame | verified; fixed (#131, measured)                         |
| 8  | Med     | perf     | `R_SetFrustum` allocates about 100 typed arrays per frame when fov is not 90                            | verified; fixed (#129)                                   |
| 9  | Low-med | renderer | Resize handler never refreshes the pixel ratio                                                          | verified; fixed (#129)                                   |
| 10 | Low-med | XR       | HUD texture re-uploaded every XR frame at window size times DPR                                         | reported; capped at 30 Hz (#135)                         |
| 11 | Low-med | overlay  | Full-size Canvas2D overlay is cleared and redrawn every frame (one `drawImage` per glyph)               | measured; caching not justified, allocation fixed (#136) |
| 12 | Low-med | renderer | No shader precompile at map load                                                                        | measured; not done then, added later (#215)              |
| 13 | Low     | models   | Shadow geometry and regrown colour attribute replaced without `dispose()`                               | reported; partly fixed (#120)                            |
| 14 | Low     | models   | Material cache makes 4 identical materials per non-animated skin                                        | verified; fixed (#122)                                   |
| 15 | Low     | various  | Smaller items (see below)                                                                               | reported; mostly fixed (#129, context loss #214)         |
| 16 | Info    | world    | `gl_texsort 0` freezes lightmaps, but this is C-faithful                                                | C reading disputed (TEX-1); port changed (#158)          |

## Findings

The findings describe the code at `223a180`, and many have since been fixed (see
the status above). Line numbers were re-mapped at `c0ea1d7` (2026-11-26), and
those that moved since at `8474098`, where the code is still there, though a fix
may have changed it. A number marked `223a180` is to code that has since gone,
as it stood at that revision.

### 1. Index buffer churn on every alias pose change (high)

The code is at `src/gl_mesh.js:1163` at `223a180`, and the same pattern is in
the shadow path at `src/gl_mesh.js:1371` at `223a180`.

`geometry.setIndex( template.indices )` runs each time an entity's pose changes,
about 10 times a second per animated entity. `template.indices` is a plain
array, and the problem follows from what r183 does with it:

- r183 `BufferGeometry.setIndex` wraps any array in a **new**
  `Uint16BufferAttribute` or `Uint32BufferAttribute`.
- The renderer then creates and uploads a new `ELEMENT_ARRAY_BUFFER` for it.
- `WebGLAttributes` keys buffers in a `WeakMap` and deletes a buffer only
  through `remove()`, which runs on `geometry.dispose()` for the _current_
  index.
- Replaced index buffers are therefore reclaimed only if and when the browser
  garbage-collects the `WebGLBuffer` wrapper. That is unbounded churn: a typed
  array allocation and a GPU upload on every pose change.

The topology is the same for every pose of a model.

**Fix:** build one index attribute per `paliashdr`. Share it across the entity
and shadow geometries, and call `setIndex` only when `geometry.index` differs.

### 2. Water and sky geometry leak on map change (medium)

The geometries are created in `src/gl_rsurf.js` `EmitWaterPolysQuake` and
`EmitSkyPolysQuake`, and cached on the surface as `fa._waterGeoCache`,
`_skyGeoCache` and `_skyGeoCache2` (from about lines 1028 and 1118).

Some of these geometries are never disposed:

- `R_CleanupWaterMeshes` (`gl_rsurf.js:2087-2094`) removes from the scene each
  water or sky mesh that was not drawn this frame.
- `GL_BuildLightmaps` (`gl_rsurf.js:3235-3270`) disposes the batched meshes and
  whatever is _still_ a child of `worldGroup`. So it frees only the water and
  sky meshes that are on screen at the moment the map changes.
- r183 `WebGLGeometries` holds every rendered geometry in a plain object keyed
  by `geometry.id`, and frees it only on `dispose`.
- So the geometry of every water or sky surface that was drawn at some point but
  is off screen at the map change stays alive in GPU and JS memory. The total
  grows with each map.

**Fix:** record each created geometry in a module `Set`. Dispose and clear the
set in `GL_BuildLightmaps`.

### 3. Triple clear per frame (medium)

The code involved is at `src/gl_rmain.js:1551` at `223a180`, `src/host.js:259`
and `src/gl_rmain.js:766-778`.

`scene.background = new THREE.Color( 0x000000 )` is the cause. In r183
`WebGLBackground.render`, a Color background sets `forceClear = true`, and it
clears whenever `renderer.autoClear || forceClear`. So the frame clears three
times:

1. `_GL_BeginRendering` calls `renderer.clear()`.
2. `R_Clear` clears again.
3. The main `renderer.render( scene, camera )` clears colour, depth and stencil
   again, despite `autoClear = false`.

In C (`WinQuake/gl_vidnt.c` and `gl_rmain.c`, checked), `GL_BeginRendering` does
not clear at all. `R_Clear` clears depth, and colour too only when `gl_clear` is
set.

`gl_clear 0` still could not keep the previous frame's colour in the port, even
with the background removed. The renderer uses the default
`preserveDrawingBuffer: false`, so the browser may clear the canvas after each
present. The r183 manual's `tips` page notes that `preserveDrawingBuffer: true`
is needed to stop the canvas being cleared. The finding is therefore about the
two redundant full-screen clears, not about `gl_clear`.

**Fix:** make `R_Clear` the single owner of the clear. Set
`scene.background = null` and drop the clear in host.js. Leave
`preserveDrawingBuffer` alone, because enabling it costs performance.

**XR caveat:** `renderer.clear()` outside `render()` may not reach the XR
framebuffer, so the Color background may be what clears the eye buffers. Keep
the background while `renderer.xr.isPresenting`, or test in a headset.

### 4. VR HUD drawn under particles and translucent entities (medium, XR only)

The HUD is set up in `src/webxr.js:388` and `:398` at `223a180`. The particle
mesh is removed and re-added in `src/r_part.js:904` and `:928`.

`hudMesh.renderOrder = 10000` with `depthTest: false` is meant to draw last, but
`vid.js:298` sets `renderer.sortObjects = false`. r183 sorts render lists only
when `sortObjects === true`, so `renderOrder` is ignored and transparent objects
draw in scene-child order.

`r_part.js` removes `pointsMesh` whenever no particles are live and re-adds it,
which puts it at the end of `scene.children`, after the HUD. Particles then
blend over the HUD. Newly added translucent entity meshes do the same. The
viewmodel's `renderOrder = 999` (`gl_rmain.js:987`) is also ignored.

**Fix:** draw the HUD in its own small `Scene` with a second `renderer.render`
at the end of `R_RenderView`, only while XR is presenting. Do not enable
`sortObjects`, because that breaks the BSP ordering.

### 5. Viewmodel material cloned every 100 ms (medium)

The code is at `src/gl_rmain.js:709-713` at `223a180`, together with
`src/gl_mesh.js:867-869`.

With the default `r_lerpmodels 0`, the gun takes the clone path:
`currententity._viewmodelMaterial = baseMaterial.clone()` whenever
`baseMaterial` changes. Two things make that frequent:

- The alias material cache key includes `anim = floor( cl.time * 10 ) & 3` even
  for non-animated skins (finding 14).
- `baseMaterial` is `mesh.material`, which `gl_mesh.js:1230` sets from
  `R_GetAliasMaterial` each frame.
- So `baseMaterial` cycles through 4 cached materials, and a new clone is made
  every 100 ms.

The old clones are never disposed. They share a program, so the GPU cost is
small, but this churns JS objects and renderer property state. The clones are
also not registered with `GL_RegisterCullMaterial`, so `gl_cull` changes miss
them.

**Fix:** cache one clone per base material, or dispose the previous clone, and
register it with `GL_RegisterCullMaterial`. Fixing finding 14 removes most of
the churn by itself.

### 6. Per-vertex CPU lighting and colour upload per entity per frame (medium, unmeasured)

The code is at `src/gl_mesh.js:1124-1174`.

Every alias entity loops over all its vertices each frame, doing a shade-table
lookup and writing R=G=B into a `Float32Array`. It then sets
`color.needsUpdate`, which re-uploads 12 bytes per vertex with the static usage
hint.

The options, cheapest first:

- (a) Compute the 162 normal shades once per entity per frame.
- (b) Move the lighting into the existing `onBeforeCompile` vertex patch: a
  `lightnormalindex` attribute plus the shade table as a uniform. This removes
  the per-frame upload.
- (c) At minimum, `setUsage( THREE.DynamicDrawUsage )`.

Shade values must stay as they are in C.

### 7. World `BatchedMesh` sorts every frame (medium, unmeasured)

The code is at `src/gl_rsurf.js:3145` (`R_InitWorldBatch`).

`batchedMesh.sortObjects` is never set, and its default in r183
(`BatchedMesh.js:221`) is `true`. The renderer-level `sortObjects = false` does
not affect it. In r183, `onBeforeRender` returns early only when
`!_visibilityChanged && !perObjectFrustumCulled && !sortObjects`
(`BatchedMesh.js:1507`).

So every batch does three things every frame:

- a frustum test per instance
- a depth sort
- an indirect-texture re-upload

This happens even though the world is static and PVS visibility changes only on
a leaf change.

**Fix:** `batchedMesh.sortObjects = false`. The underwater batches already
disable per-object culling, so for them `onBeforeRender` then becomes a no-op on
most frames. The trade-off is that the front-to-back sort helps early-z on
opaque batches, so measure draw time before and after.

Related observations:

- The batching design itself is right. The r183 manual's
  `optimize-lots-of-objects` page names merging geometry to cut draw calls as
  the main optimisation, and `BatchedMesh` does that while keeping per-surface
  PVS visibility.
- Without `WEBGL_multi_draw`, r183 falls back to one draw per visible instance.
- World geometry is non-indexed triangle fans with per-vertex normals.
- Indexed geometry could be tried if profiling shows the need.

### 8. `R_SetFrustum` allocations at fov other than 90 (medium)

The code is at `src/gl_rmain.js:447-468`, which calls `src/mathlib.js`
`RotatePointAroundVector` and `PerpendicularVector`.

For any fov other than 90, `R_SetFrustum` calls `RotatePointAroundVector` 4
times per frame. Each call allocates 15 `Float32Array`s in five matrix arrays,
plus `vr`, `vup` and `vf`, plus `PerpendicularVector`'s `tempvec`. That breaks
Golden Rule #4.

**Fix:** use module-level scratch in mathlib.js. Neither function is recursive,
and the C signatures stay the same.

### 9. Resize ignores DPR changes (low-medium)

The code is at `src/vid.js:306-308` and `333-351`.

`setPixelRatio` is called only once, at init. A browser zoom, or moving the
window to a monitor with a different DPR, leaves the WebGL buffer at the old
ratio, while `gl_draw.js` re-reads `devicePixelRatio` for the overlay.

**Fix:** in the resize handler, call
`renderer.setPixelRatio( window.devicePixelRatio * vid_renderscale )` before
`setSize`. Skip it while `renderer.xr.isPresenting`, where r183 `setSize` warns
and returns.

The r183 manual's `responsive` page bears on this in two ways:

- **Recompute on resize.** Its pattern recomputes size from the canvas's display
  size, so changes are always picked up.
- **Cost of full DPR.** It warns that rendering at full `devicePixelRatio` costs
  up to 9 times the pixels on 3x phones, and that heavy apps usually shouldn't.
  The port renders at full DPR unless `?scale=` is given. A default DPR cap on
  mobile is worth considering, though that is a product decision rather than a
  bug.

### 10. XR HUD texture upload every frame (low-medium)

The code is at `src/webxr.js:430-476`.

`XR_UpdateHUD` sets `hudTexture.needsUpdate` and calls `initTexture` every XR
frame, at 72-120 Hz. That uploads the whole window-size times DPR overlay canvas
each time. Line 345's (at `223a180`) `material.needsUpdate` on a map swap is
also unnecessary: a map swap doesn't need a recompile, and only the null to
non-null change does.

**Fix:** upload only when the overlay was redrawn (finding 11's dirty flag), or
at a capped rate, and size the canvas for the headset. This is the same idea as
the r183 manual's `rendering-on-demand` page: do work only when something
changed.

### 11. Canvas2D overlay redrawn every frame (low-medium, unmeasured)

The code is at `src/gl_draw.js:540-591`.

`Draw_BeginFrame` clears the whole overlay every frame, and an open console
issues about 2000 `drawImage` calls, one per glyph. MDN's "Optimizing canvas"
recommends three things:

- pre-render repeated content to offscreen canvases
- avoid unnecessary state changes
- layer canvases by how often they change

Console rows and sbar pics are candidates for caching. Separately,
`_calculateUIScale` (`gl_draw.js:111-135` at `223a180`) returns an unused object
5-8 times a frame.

### 12. No shader precompile at map load (low-medium)

`R_PadDlights` already documents compile hitches of 20-250 ms per new light
count. Other first-use compiles are still paid mid-game:

- the first water and sky
- each entity material variant
- the mirror, warp and polyblend passes

**Fix:** call `renderer.compileAsync( scene, camera )` after `R_NewMap`. The
exact r183 signature is unverified.

### 13. Replaced geometry and attributes not disposed (low)

These are in `src/gl_mesh.js`:

- **Shadow geometry (1366-1374 at `223a180`):** a new shadow `BufferGeometry`
  replaces the old one when the vertex count changes, without
  `oldGeo.dispose()`.
- **Colour attribute (1110-1117):** when the buffer is regrown, `setAttribute`
  replaces the old attribute, and its GL buffer is not removed.

Both are bounded by model switches and swept partly at map change.

### 14. Four identical materials per non-animated skin (low)

The code is at `src/gl_mesh.js:867-869`.

`anim` comes from `cl.time` whether or not the skin group is animated. C does
`anim = (int)(cl.time*10) & 3` too (`gl_rmain.c:550`), but only to pick
`gl_texturenum[skinnum][anim]`. For a single-frame skin, `Mod_LoadAllSkins`
fills all four slots with the same texture (`gl_model.c:1442-1445`), so C binds
one texture where the port builds four materials.

**Fix:** use `anim = 0` when the skin has a single frame. This also fixes most
of finding 5.

### 15. Smaller items (low)

- **Polyblend tone mapping** (`src/gl_rmain.js:1307-1341` at `223a180`): the
  polyblend `MeshBasicMaterial` is tone-mapped. When gamma is not 1,
  `toneMappingExposure` scales the blend colour, whereas the warp and mirror
  handle this themselves. Add `toneMapped: false`.
- **Water transparency** (`src/gl_rsurf.js:597-603` at `223a180`): water
  materials are `transparent: true` even in the opacity-1 bucket. Use
  `transparent: opKey === 0`.
- **Per-frame Set** (`src/gl_rsurf.js:2011` at `223a180`):
  `_waterMeshesThisFrame = new Set()` runs every frame. Allocate it once and
  call `.clear()`.
- **Brush entity groups** (`src/gl_rsurf.js:2062-2068`, re-added at
  `1889-1890`): the groups are removed from the scene and re-added every frame.
  Toggling `visible` would avoid the `children` splices.
- **Particle allocations:**
  - `R_RocketTrail` allocates two `Float32Array( 3 )` per trailing entity per
    frame (`src/r_part.js:622-623` at `223a180`).
  - `R_MarkParticleUpload` pushes two `{ start, count }` objects per frame
    through `addUpdateRange`.
- **Batch key** (`src/gl_rsurf.js:3015` at `223a180`):
  `t._buildId = Math.random()` is used as a batch key. Use a `Map` keyed by the
  texture or a counter.
- **Unfreed one-off resources at shutdown:** the mirror render target, the warp
  `FramebufferTexture`, the particle geometry, material and texture, and the
  shader materials have no dispose path. They are one-off, so this only matters
  for a renderer re-init.
- **Renderer options:** consider `powerPreference: 'high-performance'` (the r183
  default is `'default'`).
- **Context loss:** there is no app-level handling. r183 restores GPU resources
  itself, and the CPU texture data is kept, so this is low risk.
- **Stale comment** (`src/gl_mesh.js:576-582` at `223a180`): the comment says
  alias data is garbage-collected on map load. `Mod_ClearAll` keeps alias
  models, as C does, so fix the comment, not the behaviour.

### 16. `gl_texsort 0` freezes lightmaps (info, C-faithful)

The code is at `src/gl_rsurf.js:2235` at `223a180`.

The world reviewer reported this as a fidelity bug. It isn't. In C
`R_DrawSequentialPoly`, the lightmap is uploaded with `glTexSubImage2D` only in
the `gl_mtexable` branch. The non-multitexture branch never uploads, and
`R_BlendLightmaps` returns early when `gl_texsort` is 0. The port has
`gl_mtexable` false (`gl_rsurf.js:466`, `glquake.js:178`), so it matches C.

Changing it would be a deliberate deviation. That would only matter if
`gl_texsort 0` is meant to be usable.

## Already good (don't re-raise)

- **Lightmap upload:** partial uploads use r183
  `copyTextureToTexture( src, dst, srcRegion, dstPosition )` from a
  never-rendered CPU source (one `texSubImage2D`).
- **Lightmap textures:** linear, no mipmaps, sRGB with intensity compensation,
  and disposed on map change.
- **World textures:** mipmaps, anisotropy and colour space are set once, and
  `Mod_ClearAll` disposes every tracked texture with de-duplication.
- **Shader patches:** every `onBeforeCompile` patch has a stable
  `customProgramCacheKey`, and the shared uniforms are mutated in place. Water,
  sky and underwater warp run in the vertex shader.
- **Pose lerp:** done in the vertex shader with shared per-pose attributes. A
  culling sphere covers all poses.
- **Alias mesh, geometry and buffers:** pooled per entity, with module-level
  scratch maths.
- **Map-change cleanup:** entity meshes, sprite caches and the player skin
  texture are cleaned up correctly.
- **Dynamic lights:** a pooled `PointLight` set, with light counts bucketed by
  `R_PadDlights` to avoid recompiles.
- **Particles:** one `Points` mesh with preallocated `DynamicDrawUsage` buffers,
  `setDrawRange` plus update ranges, `frustumCulled = false` and
  `depthWrite: false`.
- **Renderer:** the camera is created once with a manual `matrixWorld`;
  `R_SetupGL` uses scratch buffers; the options are sensible (no AA, alpha or
  stencil); and the colour space is explicit.
- **Mirror and screenwarp passes:** sized from viewport times DPR, disposed on
  resize, autoClear saved and restored, and tone mapping handled correctly for
  render-target output. `copyFramebufferToTexture` is used correctly for r183.
- **WebXR:** reference-space probing before `setSession`, `setAnimationLoop`, a
  manual rig `updateMatrixWorld` (needed in r183), and the mirror, warp and
  polyblend passes gated off. (Since #156, XR draws the screen blend with
  `XR_PolyBlend` instead.)
- **API currency:** no deprecated or removed r183 APIs were found
  (`outputEncoding`, `Geometry`, `WebGLMultisampleRenderTarget`). The migration
  guide was checked only partly.
