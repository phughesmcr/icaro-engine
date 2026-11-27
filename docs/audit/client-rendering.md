# Audit: client experience, rendering, Three.js, performance

Track: client rendering and experience. Taken at `dev` 2798ac9 (2026-11-26), on
a Mac (Apple Silicon, Deno, no browser or GPU run). Everything marked **needs
browser** is static analysis only. Like the other `docs/` files this is a
snapshot; check claims against the code before acting.

Open PRs that touch this track: #241 (`vid_dynres`, dynamic resolution), #243
and #244 (agent rl tier, Gymnasium env), #237 (enemy interrupt), #240 (player
paks from browser storage, so mod selection UX), #239 (RTC reconnect). Findings
below that overlap them say so and do not duplicate them.

## Status

Checked at `dev` `991c6e2` (2026-11-27). The rest of this file is the older
snapshot.

- Finding 3: the patches go through `GL_PatchShader`, which throws when its
  anchor is missing, and tests run against the pinned Three.js chunks
  (`tests/three_r183_shaders.js`; #272). That is recommendation (a) for the
  patches that use it. Recommendations (b) and (c) are open.
- Finding 4: `gl_overbright` and `gl_overbright_models` (#269, #272) and
  `r_particles` (#263) are done. Lightmaps are now combined with textures on
  their encoded values, as GLQuake does, so `lightMapIntensity` and the sRGB
  lightmap described here are gone. `r_litwater`, external textures and the
  other cvars are open.
- Finding 5: pad buttons, shoulders and triggers are bindable keys, and
  `joy_enable` exists (#263). The Keys menu can't capture them, because the pad
  sends keyboard keys in menus. No real controller was tried.
- Finding 8: tone-mapping exposure is gone. `src/gl_gamma.js` ports QuakeSpasm's
  gamma and `contrast` pass (#272). It covers the 3D view only, not the HUD or
  menus, and doesn't run in WebXR. The renderer still sets no `powerPreference`.
- Finding 12: the phone-test bugs it lists were fixed (#236).
- Finding 14: the MCP `screenshot` tool and the `screen` tier were added (#246).
- Finding 1 is open. The others weren't rechecked.

## Verdict

The renderer is in better shape than most ports: BatchedMesh world, pooled
scratch vectors, cached alias geometry, partial lightmap uploads, shader
warm-up, context-loss recovery. The CPU side is cheap (numbers below). The
biggest risks are not raw speed but frame pacing, a fragment-heavy lighting
model, string-patched shaders that block WebGPU, and missing community-standard
visual features. Nothing here was measured on a GPU.

## Benchmarks (headless Deno, this Mac, medians)

| Benchmark                                | Result                        |
| ---------------------------------------- | ----------------------------- |
| `R_DrawParticles`, 12000 blood           | 172 us                        |
| `R_DrawParticles`, 2000 mixed explosion  | 73.5 us                       |
| `R_RocketTrail` 300u                     | 8.8 us                        |
| Alloc/free churn, trail + draw, 4 rocket | 596 us                        |
| `Draw_String` 40 chars (stub canvas)     | 7.0 us                        |
| World visibility pass, per view (pak0)   | 27 us (e1m6) to 75 us (e1m1)  |
| `R_MarkLeaves` / BSP walk                | 4-7 us / 0.2-4.8 us           |
| Map build (`build_bench`)                | 7-10 ms each, 10-15 lightmaps |
| Cold map load incl. build                | 24-59 ms                      |
| Cold alias load (`model_bench`)          | 61 models, 37 ms total        |

Reading: the CPU frame cost of world, particles and 2D is well under 1 ms. A
frame will be GPU-, driver- or pacing-bound, not JS-bound. Caveats:
`render_bench` printed `Sys_Error: W_GetLumpinfo: conchars not found` before the
2D rows (the 2D numbers use a stub canvas and a missing font lump, so treat
`Draw_*` as a smoke test only). `net_bench` and `server_bench` are in the
multiplayer track's scope; `net_bench` ran but its table was not read here.

World batch estimate (script outside the repo, pak0 faces grouped by texture and
lightmap number): about 36-67 texture groups per map (start 67, e1m1 64, e1m6
57, e2m3 47, e1m3 36). The lightmap number is not final before
`GL_BuildLightmaps`, so real batch counts can be higher. Add water meshes (one
per visible water surface today: 1-10 per view, `water_calls_now` against
`water_calls_grouped` 0.3-0.8 in `world_bench`), sky (up to 6.8 against 0.8
grouped), alias entities (one draw each), particles (one), HUD. **Needs
browser:** read `renderer.info.render.calls` and `.triangles` on e1m1, e2m3 and
a big mod map.

## Findings, ranked

### 1. Default 72 fps cap causes uneven pacing on common displays (High, S)

`_Host_FilterTime` (`src/host.js:836-851`) skips a frame when less than
1/`host_maxfps` (72 by default, `host.js:179`) has passed since the last run.
The loop is `setAnimationLoop` (`main.js:301`), one callback per display
refresh. On a 120 Hz panel (8.3 ms) every second refresh is skipped, so the game
runs at 60 fps with a 16.7 ms cadence; on 90 Hz it runs at 45; on 165 Hz about
55. Only 60, 72 and 144 Hz come out right. This is what a "really good desktop
Chrome" player sees first. The `host_netinterval` branch (`host.js:848`) is
already a render accumulator, and `Host_NetTickTime` gives a render step, so the
fix exists in part.

Recommendation: draw on every rAF by default and keep the 72 Hz client tic
separate from rendering (interpolate between tics), as Ironwail does with
`host_maxfps` above 72. Keep the cap as an option for phones (the quality
presets already set it). **Needs browser:** log rAF deltas at 120 and 144 Hz.

### 2. Dynamic lights are real Three.js PointLights over every lit fragment (High, M)

`R_RenderDlight` (`src/gl_rlight.js:152`) pools `THREE.PointLight`s; with
`gl_flashblend 1` (default, `glquake.js:231`) up to 64 lights, padded to a
bucket of 4/8/16/32/64 (`R_PadDlights`, `gl_rmain.js:1959`, 2079), are added to
the scene. The world and entity materials are Lambert, so every fragment runs
the bucket's light loop, whatever the light's reach, and the program set
recompiles per bucket. The warm-up (`gl_warmup.js`) hides the compile hitches
(20-250 ms measured by the author), but not the per-pixel cost. GLQuake and
Ironwail instead add dlights to the lightmap (the `gl_flashblend 0` path, which
the code also keeps) or draw a corona.

Recommendation: make the lightmap path the default (it is C-faithful, costs CPU
only for touched surfaces, and keeps the shader light-free), or move to a single
custom dlight uniform array with a fixed small cap and a per-batch influence
test. At minimum default `gl_dlightcap` to 8-16. **Needs browser:** GPU time on
e1m1 with an 8 rocket volley, buckets 0 vs 4 vs 64; also check the `.lit`
interaction.

### 3. Shaders are string patches of built-in materials (High for WebGPU, L)

About 40 `.replace(` and `shader.*Shader =` edits across `gl_rsurf.js` (21),
`gl_mesh.js` (6), `r_part.js` (4), `gl_fog.js` (3), `gl_sky.js`, `gl_rmain.js`,
`gl_entalpha.js`, on top of `MeshLambertMaterial`/`MeshBasicMaterial`, and plain
`ShaderMaterial` for sky box, mirror and screen warp. Every Three.js upgrade can
silently break a patch (they match chunk text), and none of this runs on
`WebGPURenderer`, whose materials are `NodeMaterial` and TSL (`onBeforeCompile`
does not exist there). r183's `WebGPURenderer` has a WebGL2 fallback, so one TSL
code path could serve both.

Recommendation, staged: (a) add a test that every patch still applies to the
pinned Three.js chunks (fails loudly on bumps); (b) write one `QuakeSurface`
material in TSL (lightmap, fullbright, fog, warp, dlight array, lerp, overbright
in one node graph) and retire the patches as the single biggest "elite Three.js"
item; (c) behind `?renderer=webgpu`, try `WebGPURenderer`. BatchedMesh,
`DataTexture` lightmaps and `copyTextureToTexture` partial updates need
rechecking there. **Needs browser** (Chrome WebGPU).

### 4. Missing community-standard visual features (Medium, M each)

Checked by `grep` for cvar names: absent are `gl_overbright` (Ironwail default
on: lightmaps over 1.0, the "QuakeSpasm look"), `r_litwater`,
`r_waterquality`/`r_oldwater`, `r_particles` (square or round, 0 off),
`gl_fullbrights` (the cvar; fullbrights are always on via `emissiveMap`,
`gl_rsurf.js:272`), `vid_vsync`, `vid_fsaa`, `r_skyalpha`, `r_fastturb`.
External texture replacement is the largest gap for "mod engine" use: `image.js`
loads only `.tga` for skyboxes (`image.js:13-19`); there is no `gl_load24bit`,
no `textures/` lookup, no png/jpg (the browser decodes them natively, so this is
cheap). Mods and the rerelease HD packs depend on it. `.lit` and MD5 are ported,
which is good.

Recommendation: rank by player impact: external textures (png/jpg/tga, lookup
`textures/<map>/<name>`, `textures/<name>`), `gl_overbright`, `r_particles`,
`r_litwater`. Reference: Ironwail. Lightmaps are one sRGB 8-bit texture
(`gl_rsurf.js:3407`) with `lightMapIntensity = PI` (`glquake.js:23`) to cancel
Lambert's 1/PI, so overbright needs a shader scale, not just a cvar.

### 5. Gamepad buttons are hard-coded, and triggers and shoulders cannot be bound (Medium, S)

`in_web.js:610-636` maps A/B/X/Y, bumpers, triggers and the d-pad to fixed keys
(A jump, RT `K_MOUSE1`, LB shift, X `r`, Y tab). `default_cfg.js:8-12` says
there are no `LSHOULDER`/`RTRIGGER` key names, and the keys menu cannot bind pad
buttons. Ironwail has `JOY1..4`, `LTRIGGER`, `RTRIGGER`, `AUX` binds. The
constants `K_JOY1..K_AUX4` exist in `keys.js:70-79` but the poll does not use
them. Rumble (`in_web.js:541-569`), deadzones and easing are ported properly.

Recommendation: route the poll through the `K_JOY*`/`K_AUX*` keys with names,
default-bind them in `default_cfg.js`, show them in the Keys menu. This is the
base for a controller-first menu flow too. **Needs a gamepad.**

### 6. World and entity vertex lighting is CPU-side per entity (Medium, M)

`R_DrawAliasModel` (`gl_mesh.js:1040-1135`) keeps a per-entity `Float32Array`
colour attribute and a per-pose position buffer set; relighting is skipped when
the shade inputs are unchanged (good, #132), but any moving monster in changing
light does a per-vertex loop and a `DynamicDrawUsage` upload each frame. With 20
monsters of 300-600 vertices that is small on desktop, large on a phone. The
design review already lists "lighting in the shader (6b)" as not done.

Recommendation: one per-entity shade vec3 plus the 162-entry `anorm_dots` table
in the vertex shader (the lerp material already has `pose1`), which removes the
colour buffers, uploads and the per-entity geometry object. Pairs with the TSL
material in finding 3. Hot-path allocations were checked by grep across
`gl_rmain`, `gl_mesh`, `gl_rsurf`, `r_part`, `gl_screen`, `view`, `sbar`: all
remaining `new` hits are load-time, module scratch, or lazy per-entity (once).
No Golden Rule #4 violation was found in those files. Not checked: `cl_main`,
`cl_parse`, `cl_tent`, `snd_dma` and the MD5 path (`gl_md5.js:1117-1140`
allocates per cache miss only).

### 7. Three.js is loaded unminified from a CDN, with the whole library (Medium, S-M)

`index.html:138` imports `three@0.183.0/build/three.module.js` from jsDelivr
(the unminified build, which pulls `three.core.js`), and nipplejs likewise; the
service worker caches the CDN URLs (`mobile-roadmap.md`: not vendored). Cost: a
cold-load hit of roughly a megabyte of unminified JS, a third-party dependency
for the first start, and no tree-shaking.

Recommendation: vendor a built bundle (an esbuild/rollup step with only the used
exports) into `static/`, or at least point at `three.module.min.js`. The Deno
shim already lists the exports in use. **Needs browser** for load timing
(Lighthouse, throttled).

### 8. Renderer setup: no `powerPreference`, extra passes (Low-Medium, S)

`vid.js:279-285`: no `powerPreference: "high-performance"` (dual-GPU laptops may
pick the integrated GPU), `antialias: false` (fine; `vid_fsaa` absent, see 4).
`vid.js:296-303`: `toneMapping = LinearToneMapping` with exposure `1/gamma` is a
brightness multiplier in linear space, not a gamma curve, so `gamma` raises
blacks only a little and clips highlights; it is a documented deviation
(`vid.js:446-457`) but it differs from Ironwail's gamma/contrast. The polyblend
is a separate scene render (`gl_rmain.js:1615`) and the underwater warp copies
the view to a texture and draws it back (`gl_screenwarp.js:1-20`), so water
costs two extra full-screen passes. Not needed on land.

Recommendation: add `powerPreference`; fold polyblend into the main scene as a
quad after the world (it is already a quad); render water warp from a dedicated
render target only while underwater (it already is conditional). #241
`vid_dynres` interacts: render-scale targets and the warp's copy must agree;
review it when it merges.

### 9. Mod and game selection is URL-only (Medium, M)

`main.js:55-61`, `116-129`: `?game=` accepts a fixed list (`rogue`, `hipnotic`,
`mg1`, `mg3`, `dopa`, `ctf`), `?base=rerelease` one base. No in-game way to
choose a mod, switch maps pack, load a mod `.pak`/folder or see what is
installed; unknown names are ignored. #240 (player paks from browser storage) is
the data half; the UX half (a "Games/Mods" menu that lists mounted directories,
remembers the last one, and restarts into it) is not in any open PR. The `game`
console command (QuakeSpasm) was not found. Needs: menu entry, `game <dir>`
command, per-game saved config and saves.

### 10. Accessibility for humans is thin (Medium, M)

`index.html` has one `<title>` and no `aria`, `role` or `prefers-reduced-motion`
handling; `grep` found no colour-blind aids, no subtitles/captions for sounds,
no UI text scale beyond `scr_conscale`/`scr_menuscale`/`scr_sbarscale` (these
exist and are good), no head-bob/screen-shake/flash reduction (`cl_bob`,
`v_kick*`, `gl_polyblend` exist as cvars but are not surfaced as a "reduce
motion" option). The menus are canvas-drawn, so screen readers see nothing.
Recommendation: a "Comfort" options page (bob, kick, polyblend flashes, FOV,
`prefers-reduced-motion` default) and keyboard-hint text; captions need a
sound-event table and are larger work.

### 11. Sound: faithful but heavy per voice, no latency tuning (Low-Medium, S-M)

`snd_dma.js:115-130`: `new AudioContext()` with no `latencyHint` or
`sampleRate`. Each started sound builds a source, two gains and a channel merger
(`snd_dma.js:1096-1114`), five nodes, and `leftvol`/`rightvol` are written to
`gain.value` each frame (`snd_dma.js:1174`), with no ramp, so fast panning can
zipper. Buffers are converted to Float32 per sfx (4x the 8-bit data) and played
at 11025 Hz through the browser resampler, which differs from Quake's mixer and
Ironwail's filter. The classic mixer (`snd_mix.js`) is kept but the Web Audio
path is what plays. Spatialization is Quake's own distance and pan law (no
`PannerNode`, no HRTF, no reverb), which is faithful. Music: `cd_audio.js:56`
supports `ogg` and `mp3` only; QuakeSpasm also loads `flac`, `opus`, `wav` and
tracker formats (not needed, the browser can do flac/opus/wav via the same media
element at no cost). Recommendation: `latencyHint: "interactive"` explicit,
`setTargetAtTime(v, now, 0.01)` for gains, and add the cheap music extensions.
**Needs browser/ear** for latency (use
`audioContext.baseLatency + outputLatency`).

### 12. Touch and mobile HUD (Medium, M, mostly roadmap)

`touch.js` (1894 lines): nipplejs stick, drag-look, fire/jump, weapon wheel,
gyro, left-handed mode, on-screen keyboard. The HUD is the classic sbar scaled
by `scr_sbarscale`; the roadmap's "new HUD" is not started. Open issues from the
phone test in `mobile-roadmap.md` (keyboard button over the menu plaque, VR
button over the status bar in portrait, clipped pickup message) are still listed
as not fixed. Touch controls are DOM, the 2D layer is a separate `<canvas>` (no
per-frame texture upload outside XR), which is a good design for a new HUD: it
can be DOM/CSS or SVG with real text rendering. **Needs a phone.**

### 13. WebXR (Low priority, unverified)

`webxr.js` (798 lines): HUD quad rendered after the world only while presenting,
30 Hz uploads, `antialias: false` (so no multisample XR target,
`docs/threejs-review.md` #135), controller weapon alignment
(`gl_rmain.js:853-861`). The design review says it was never verified on a
headset. Foveation, `XRWebGLLayer` framebuffer scale and hand tracking are not
set; those are the XR performance levers. **Needs a headset.**

### 14. Agent accessibility: state and gaps (note, do not duplicate #237/#243/#244)

`window.icaro` (`src/agent.js`, 2379 lines) and a headless stdio MCP server
(`server/agent_mcp.ts`, tools `start`, `step`, `goto`, `turn_to`, `attack`,
`observe`, `cmd`, `key`, `menu`) are built. Gaps still open after the PRs above:
the MCP server plays the headless host only, so an MCP client cannot drive or
see the real browser client (rendering, touch, XR); there is no `screenshot`
tool and no `screen` tier (only `icaro.screenshot()` data URL); no Streamable
HTTP transport; no remote browser bridge; options-menu labels for agents are
missing. A natural step with elite value: expose `window.icaro` as page tools
(WebMCP, if the browser offers it) so Chrome-based agents use the real renderer,
and add a rendered-frame tool to the MCP server through the browser path rather
than adding rendering to Deno.

### 15. Lower-severity items

- Texture filtering: `gl_texturemode` is ported; `anisotropy` only applies to
  mipmapped textures (`gl_model.js:884-904`), and there is no `gl_picmip`-style
  quality control for `.lit`.
- Particles are one `Points` draw with CPU fill (172 us at 12000); fine.
  Round-vs-square is not selectable (see 4).
- Fog and sky are patched into the same shaders; sky box is a `ShaderMaterial`
  (`gl_rsurf.js:225`). Warp/water grouping (water 10 calls against 0.8 grouped
  on e1m1 in `world_bench`) is a ready draw-call saving: group warp surfaces by
  texture as sky is.
- `docs/threejs-review.md` lists as not done: brush entity group re-adds and
  shutdown disposal. Not re-checked here.

## What would make it "elite Three.js" (social-worthy)

1. One TSL `NodeMaterial` for all Quake surfaces, with WebGPU and WebGL2 from
   the same code (finding 3). Highest visibility.
2. Renderer-wide GPU timing (`EXT_disjoint_timer_query`/`timestamp-query`) in an
   in-game overlay (`scr_showfps` extended), with `renderer.info` live.
3. Indirect/instanced world, entities and particles with GPU-side vertex
   lighting; a handful of draw calls per frame.
4. Dynamic resolution (#241) with a frame-time controller, MSAA-less FXAA/TAA
   option, and vsync-aware pacing (finding 1).
5. Bundled and tree-shaken, no CDN for first load (finding 7).

## Verification plan (browser or device)

- Pacing: `performance.now()` deltas in the animation loop at 60, 120 and 144
  Hz.
- Draw calls and triangles: `renderer.info.render` on e1m1, e2m3, a large mod
  map, with and without dlights; same for `renderer.info.programs.length`.
- GPU time: Chrome DevTools Performance GPU track, or `timestamp-query`; compare
  `gl_flashblend 0` and `1` and dlight caps.
- Memory: `renderer.info.memory` across a map cycle (the existing method).
- Audio latency: `baseLatency + outputLatency` and a click-to-sound test.
- Phone and headset passes as listed in `docs/mobile-roadmap.md`.
