# Audit: architecture, platform, build and code health

Snapshot of `origin/dev` at 2798ac9 (branch `agent/vision-rules`), 2026-11-26.
Read-only audit. Baseline: `deno task check`, `lint` and `test` all pass (1035
tests, 48 s). Counts below come from commands run on that tree. Overlapping open
PRs are named per finding (#235 to #244).

Ranking: severity High, Medium or Low is the cost of leaving it. Effort S is
under a day, M is days, L is weeks.

## Status

Checked at `dev` `eac77a1` (2026-11-28), with A1 and A2 rechecked at `da4ea21`.
The rest of this file is the older snapshot.

- A1 is open; `../architecture-plan.md` (#260) plans the layering. The
  `gl_model.js` split A1 asks for first is done (#280), as is the plan's step 1,
  a layer checker with a ratchet (#295), but the server still reaches `three`.
  At `da4ea21` `deno task layers` counts static import cycles of 61 and 4
  modules, 132 upward imports and 49 imports of browser-only modules by core or
  game code. Its method isn't this audit's, so don't compare the cycle sizes
  with A1's.
- A2: partly done (#312, the plan's step 2). The unused copies in `glquake.js`,
  the `r_worldentity`, `currententity`, `gldepthmin` and `currenttexture` named
  below among them, are deleted, as are the empty stubs in `render.js`.
  `glquake.js` isn't constants only: it still holds some mutable state and GL
  helpers, `VERTEXSIZE` and `MAXLIGHTMAPS` are still defined in both files, and
  the duplicate-export test wasn't added.
- B3 and B4: no pak is tracked or deployed, so the client build's SHA-256 pin
  and the service worker's cache-first `pak0.pak` are gone (#270). The community
  maps were removed (#259). The client build also denies `static/librequake/`.
- L1: `THIRD_PARTY.md` was added (#257). SPDX headers and "or later" are open.
- L2: done (#259, #270; id's artwork was replaced too, #267).
- L3: done, but not as proposed (#264, #265, #266, #268, #270, #271). There is
  no `lq1` directory and no committed pak: the browser downloads a pinned
  release from R2 into its own storage, under `static/librequake/id1`; CI fails
  on any tracked pak; and the game-room image fetches LibreQuake while building.
  See `../librequake-content.md`.
- The other findings weren't rechecked.

## Summary

The port is clean and well tested for a 79k-line `src/`, but it is one cyclic
blob: 49 of 90 modules form a single import cycle, the dedicated server imports
the renderer's model loader and fakes Three.js with a 683-line shim, and the
build is "serve the source tree". None of that blocks the new direction. It does
set the order of work: cut the Quake-to-platform seams first (filesystem, video,
window access), then bundle and ship the desktop build, then add types.

## Target layering

Keep one package, three directories. Dependencies point downwards only.

```
games/quake/   Quake layer: ported C (cl_*, sv_*, pr_*, host*, menu, sbar,
               gl_* draw code), cvars, console, QuakeC VM, NQ/QW protocol
---------------------------------------------------------------------
core/          Icaro core: platform ports (below), net transports, room_rules,
               agent API, pak/file mounts, input mapping, Three.js scene glue
---------------------------------------------------------------------
platform/      browser, deno-server, deno-desktop, headless adapters
```

The platform ports are small interfaces that the Quake layer receives at start
up, instead of importing a global or touching `window`:

- `Files`: mount list, `read(name)`, `readRange`, `list(dir)`. Wraps `pak.js`,
  loose files, BYO storage (#240), and a future Icaro-native archive.
- `Video`: create/resize a surface, `present`, pixel ratio, XR session. Only
  this and the `gl_*` files may import `three`.
- `Input`: events in, polled state out (`in_web.js`, `touch.js`, `webxr.js`
  implement it; the headless host and the agent implement it too).
- `Audio`: `snd_dma.js` mixes into a ring; the port only owns the output node.
- `Net`: already the best seam (`net_main.js` drivers). Keep it.
- `Host`: time, quit, location/query args (`?game=`, `-hipnotic`), page
  lifecycle. Replaces the `window.location` and `addEventListener` calls in
  `cl_main.js` and `host.js`.

Fidelity stays function by function inside `games/quake/`. Anything under
`core/` has no C counterpart, so the "keep C names" rule does not apply there;
that matches the new fidelity-by-layer rule. A move is a rename plus an import
fix, so `git log --follow` and the C-name comments survive.

## Findings

### A1. One 49-module import cycle; server pulls in the renderer (High, L)

Evidence: a strongly-connected-component pass over `src/*.js` imports (637
edges) gives one component of 49 files and one of 4. `common.js` is imported by
51 modules, `cmd.js` and `sys.js` by 33 and 31, `cvar.js` 31, `quakedef.js` 30.
The dedicated server, `server/game_server.js:44`, imports `Mod_Init` from
`src/gl_model.js`, which does `import * as THREE from "three"` (line 7) and
builds `THREE.DataTexture` at line 716. So `deno.json` maps `three` to
`server/browser_shim.js` (683 lines of stub classes) so the server can load. The
`AGENTS.md` warning "if `src/` starts using a new Three.js export, add it to the
shim or the server breaks" is this cost, paid forever. 18 files import `three`:
17 `gl_*`/render files plus `webxr.js`, `vid.js`, `r_part.js`.

Why it matters: any "engine core" cut, a TypeScript port, tree shaking, a lean
server image, or a game that is not Quake all need this untangled first.
Top-level `new SomeClass()` in the cycle already throws TDZ errors (`AGENTS.md`,
"Engine gotchas").

Recommendation:

1. Split `gl_model.js` (3552 lines) into `mod_*` (BSP/alias/sprite parsing, pure
   data, no `three`) and `gl_model_upload.js` (texture creation). The server
   then needs no shim for model loading. Do the same for any other
   server-reachable file that imports `three` (check with
   `deno info server/game_server.js | rg three`).
2. Make texture creation a `Video` port call (`upload_texture(pixels, w, h)`)
   that the server leaves unset.
3. Delete `browser_shim.js` once the server graph has no `three` import. Add a
   test that fails if `server/game_server.js`'s module graph contains `three`.
4. Break the cycle at the hubs: move the `cvar`, `cmd`, `sys` and `console`
   registries into a leaf `core/` module with no upward imports; `common.js`
   (1491 lines, mixes message I/O, args, file system and localisation) gets
   split into `msg.js`, `sz.js`, `com_args.js`, `com_file.js`. The C had the
   same shape (`common.c`), so name the new files after the C sections.

Overlap: none open. #241 touches `vid.js` and `gl_rmain.js`; do the
`gl_model.js` split in a quiet window.

### A2. Duplicated render state: `glquake.js` vs `gl_rmain.js` (High, M)

Evidence: `glquake.js` exports `const r_worldentity = null` (line 133),
`const currententity = null` (137), `const gldepthmin = 0` (53) and
`let currenttexture` (56). `gl_rmain.js` exports the live `let` versions of the
same names (lines 238, 244, 282, 303). `ALIAS_BASE_SIZE_RATIO`, `TILE_SIZE`,
`SKYSHIFT`, `VERTEXSIZE`, `MAXLIGHTMAPS` and more are defined in both (glquake
lines 7 to 36, gl_rmain lines 183 to 231). 14 files import `glquake.js`. A
`const` export that is never assigned is a trap: it reads as live state and
silently stays at its initial value. In the C these are one header (`glquake.h`)
plus `gl_rmain.c` globals.

Recommendation: make `glquake.js` constants-only (it is the header), and let
`gl_rmain.js` re-export or import them. Move every mutable name to its owning
module with a setter. Add a lint-style test that no name is exported from two
`src/` files with different bindings (a 20-line AST script, like
`tools/fmt_ast_check.js`). Then `AGENTS.md` can drop the "check which copy is
live" gotcha.

### A3. 167 `export let` plus 41 `set_*` setters as the state model (Medium, L)

Evidence: `rg "^export let" src` gives 167 mutable exported bindings; setters
number 41, and the project already notes "a setter must update every copy"
(`host_frametime` in `host.js` and `sv_phys.js`).

Why it matters: this is faithful to C globals and cheap, so it is the right
default inside the Quake layer. It is wrong at the boundary: two game instances
in one process (a browser tab hosting a room while a desktop client also runs a
local server; the headless host plus a loopback client; tests) share every
global. `server/headless_host.js` and `listen_server_test.js` already work
around this by running one world at a time, and `game_server.js` is one OS
process per room (`room_process_manager.ts`), which is the cost of not having
instance state.

Recommendation: do not rewrite. Group the client-side and server-side globals
that `net_*`, `agent.js` and `headless_host.js` touch into
`cls`/`sv`/`svs`-style objects (these already exist in `client.js` and
`server.js`), and make new Icaro code take its state as an argument. Revisit
"many rooms per process" only if the per-room process cost (memory probe:
`tools/room_memory_probe.js`) becomes the hosting bottleneck.

### A4. Platform access scattered through the engine (Medium, M)

Evidence: 25 `src/` files touch `window`, `document` or `navigator`; 37
`typeof window/document` guards. Examples: `sys.js:14` writes `error` into
`document.body.innerHTML` (an HTML-injection path: the text can include a map
name or server string); `cl_main.js:328,363` read `window.location.search`;
`host.js:571,575` add `beforeunload` and `pagehide` listeners; `in_web.js` (1974
lines), `touch.js` (1894), `webxr.js`, `menu.js` (4207) all reach for the DOM
directly. Only `typeof` guards keep these importable under Deno, and tests stub
globals per test.

Recommendation: introduce the `Host` port (above) and route the lines in
`sys.js`, `cl_main.js`, `host.js` and `main.js` through it. Replace the
`innerHTML` write with `textContent` now (S, independent). Desktop and headless
then implement `Host` instead of faking `window`.

### A5. Filesystem seam exists but game name and layout are hard-coded (Medium, M)

Evidence: `quakedef.js:6` `GAMENAME = "id1"`. `main.js:135-227` builds the mount
list by hand: `static/pak0.pak`, `pak1.pak`, `id1dir`, `?game=` dirs,
`?base=
rerelease`. `pak.js` is 12 exports (`COM_LoadPackFile`,
`COM_AddGameDirectory`, `COM_FetchPak`, `COM_AddPakSequence` and others) and
handles lazy ranges, so the mechanism is sound; the policy is in `main.js`.

Recommendation: see section "LibreQuake as default content". In short, make the
mount list data (a manifest the host provides), with `id1`/`lq1` and the default
pak name as parameters, so `-game`, `-hipnotic` and `-basedir` behave as in
QuakeSpasm on every platform, and BYO paks (#240) are one more mount source.

### A6. Rendering, input and audio seams (Low to Medium, M)

- Renderer: well isolated by filename (`gl_*`, `vid.js`, `r_part.js`,
  `webxr.js`). Three.js is the backend, GLQuake structure the front. The seam is
  already usable; A1 finishes it. Three.js hot-path rules: see section H3.
- Input: `in_web.js`, `touch.js` and `keys.js` converge on the Quake key and
  `usercmd` model, which is the right abstraction. `agent.js` (2379 lines) is a
  fourth input source; keep it on the same path.
- Audio: `snd_dma.js`, `snd_mix.js`, `snd_mem.js`, `cd_audio.js`; only
  `snd_dma.js` and `cd_audio.js` touch `AudioContext`. Good seam. `snd_mix.js`
  has no test importing it.
- VM: `pr_exec.js`/`pr_edict.js`/`pr_cmds.js` are self-contained and tested
  (`pr_*_test.js`). A game-rules seam for non-Quake games means either another
  `progs.dat` or a JS "game module" interface with the same builtins. Not needed
  yet; do not design it before the first non-Quake game exists.
- Net: `net_main.js` plus `net_loop`, `net_websocket`, `net_webtransport`,
  `net_webrtc`, `net_rtclobby`. Message-format changes already require both
  sides to move together (`AGENTS.md`); add the protocol 666/999 negotiation
  (`protocol.js`) behind a version table here, not in `cl_parse.js`.

## Build and distribution

### B1. Deno Desktop exists and fits, with caveats (High for the direction, M)

Verified from docs.deno.com (runtime/desktop, backends, CLI reference):
`deno
desktop` ships in Deno 2.9.0 and later (pinned here: 2.9.8,
`.tool-versions`). It compiles a project into one binary per platform bundling
code, the Deno runtime and a web engine; the app opens a window onto a local
`Deno.serve()` server. Backends: OS webview (default: WKWebView, WebView2,
WebKitGTK; smallest; no DevTools; WebGPU and Web Audio vary), CEF
(`--backend cef` or `"desktop": {"backend": "cef"}` in `deno.json`; same
rendering on all three OSs; about 150 MB for the framework; DevTools,
autoUpdate, tray; WebGPU and WebRTC named as supported), and `raw` (no web
engine). Cross-compilation with `--target`/`--all-targets`;
`--include`/`--exclude`; icons; `Deno.autoUpdate()` with `latest.json` and
binary diffs; permissions given at compile time are baked in. The docs state no
experimental label.

Not covered by the docs, so unknown until spiked: how command-line arguments
reach the app (needed for `-hipnotic`, `-game`, `-basedir`), WebGL support per
backend, WebTransport and `--unstable-net` QUIC servers inside a compiled app,
gamepad and WebXR, size of the whole bundle, and how `static/` data lives beside
the binary instead of inside it.

Fit with this repo: it is the natural host for `server/game_server.js` plus the
static client in one process, which is the "client + server" executable. Use
CEF, not the OS webview: Icaro needs identical WebGL2, WebRTC and gamepad
behaviour, and WebKitGTK/WKWebView differences are the exact mobile-Safari class
of bug the project already fights.

Recommendation: a one-day spike, `tools/desktop_spike/`, to answer the unknowns
above with a `Deno.serve` file server over `static/`+`src/`, `--backend cef`,
and `Deno.args` forwarded into `COM_InitArgv`. Decide only after it. Command
line parity (`-hipnotic`, `-game`, `-listen`) should read from the `Host` port
(A4), so web (`?game=`), desktop (`Deno.args`) and the server flags share one
parser.

### B2. No bundle step; CDN import map (Medium, M)

Evidence: `index.html:135-149` maps `three` and `three/addons/` to
`cdn.jsdelivr.net/npm/three@0.183.0/...` and `nipplejs@1.0.4`, with SRI hashes
for three's two build files and nipplejs only (not the `addons/`; `src/` does
not import addons today). Modules load unbundled: 90 `src/` files plus
`main.js`, so a cold load is on the order of 100 requests (HTTP/2 hides some of
it). The service worker (`sw.js`) caches the CDN URLs and pak0 cache-first, and
everything else network-first. The desktop executable cannot depend on a CDN,
and offline first launch already fails today because the CDN is the single point
of failure for the first visit.

Recommendation: do not adopt Vite yet. The project needs one output file set,
not a dev server framework. Order:

1. S: vendor `three` and `nipplejs` into the repo (or `npm:` specifiers locked
   in `deno.lock`, which already pins npm packages for the MCP server) and drop
   the CDN. Update `sw.js` cache keys and the `cloudflare/client` allowlist.
2. M: add `deno task bundle` using `deno bundle` (or esbuild) producing
   `dist/main.[hash].js` with `three` tree-shaken (18 `import * as THREE` files;
   check the namespace imports shake) and sourcemaps. Keep `deno task serve` on
   unbundled sources for dev.
3. Reconsider Vite only for HMR on the UI, or if a TypeScript-to-bundle path
   needs plugins `deno bundle` lacks. Deno Desktop's docs list Vite SSR support,
   so the door stays open.

Overlap: #238 (CSP nonce in `cloudflare/client/`). A nonce needs a per-response
rewrite of inline scripts; a bundled single module plus a hash-based CSP is
simpler and also works in the desktop app. Align before #238 merges.

### B3. `cloudflare/client/` deploy (Low, S)

Evidence: `cloudflare/client/build.js` is a good model: tracked files only,
allowlist (`index.html`, `main.js`, `sw.js`, `manifest.webmanifest`, `LICENSE`,
`src/`, `static/`), a deny list of folder names (`hipnotic`, `rogue`,
`rerelease`, `id1`, `mg1`, `mg3`, `dopa`, `ctf`, `music`), a SHA-256 pin of the
shareware pak, and a 25 MiB per-file cap. `wrangler.jsonc` serves `./dist` only.
The working tree's `static/` is 1.8 GB of ignored data, so the allowlist and the
"tracked files only" rule are the real protection and are tested
(`tests/client_build_test.js`).

Gaps: (1) the pak SHA pin and the `.pak` name check are pak0-specific;
LibreQuake (below) needs a second allowed pak with its own hash. (2) With a
bundle step the allowlist changes from `src/` to `dist/`. (3)
`static/maps/*.bsp` (7 community maps, tracked) ship with `.txt` files that
carry author names and no license text; check redistribution terms before
treating them as part of the product.

### B4. Service worker and offline (Low, S)

`sw.js` is network-first for code, which is correct while there is no hash in
file names. Once a bundle with hashed names exists, switch code to cache-first
by hash and keep `index.html` network-first. Bump cache names with the build id
to avoid the "rip replaced under the same name stays cached" problem the header
already describes for music. `tests/sw_test.js` covers the logic.

### B5. CI covers fmt, test, lint, check, image check; not build or browser (Medium, M)

Evidence: `.github/workflows/ci.yml` has two jobs (`check`, `container-image`).
No `client-build` run, no browser smoke test, no coverage report, no Windows or
macOS run (the desktop target needs them), no `deno task bench` checksum gate
(`AGENTS.md` says checksums "must not change" but nothing enforces it), no
dependency or license scan. The workflow is well hardened (SHA-pinned actions,
`persist-credentials: false`, minimal permissions).

Recommendation: add (a) `deno task client-build` to the check job (S), (b) a
Playwright or `chrome --headless` smoke test that loads `index.html?map=e1m1`
and calls `icaro.help()` (M; this is the only way to catch regressions in
rendering, touch and audio, which `AGENTS.md` admits are untested), (c) the
checksum benches as a job (S: `server_bench.js`, `build_bench.js`,
`net_bench.js` print hashes), (d) a matrix of macOS and Windows for the desktop
build once it exists.

## TypeScript readiness

### T1. Baseline is JS with little type information (Medium, L)

Evidence: no `tsconfig.json`; no `// @ts-check` in any `src/` file; 8 JSDoc type
tags in all of `src/` (`rg "@param|@type|@returns"`). `deno check` runs on 9
entry points (`deno.json` `check` task): `main.js` pulls the whole `src/` graph
in, but `.js` files are only type-checked with `"checkJs": true`, which is not
set, so today the check validates imports and `.ts` files, not the engine
bodies. 167 mutable exports and C-style flat structs (`client_t`, `edict_t`
built by hand) will each need a type.

Recommendation, in order of payoff and ease:

1. Turn on `"compilerOptions": {"checkJs": true}` per module, not globally:
   `// @ts-check` first on leaf modules with a clear shape (`mathlib.js`,
   `crc.js`, `zone.js`, `wad.js`, `bspfile.js`, `pak.js`, `protocol.js`,
   `room_rules.js`, `net_*`), then `common.js`, `cvar.js`, `cmd.js`.
2. Define the shared structs once as JSDoc `@typedef` (or `.d.ts`) beside their
   owners: `edict_t`, `entity_t`, `mleaf_t`, `msurface_t`, `qsocket_t`,
   `usercmd_t`, `cvar_t`. These drive most of the errors.
3. Convert to `.ts` file by file, leaves first, after step 1 shows few errors.
   Keep the extension in imports (the project already requires it). Do the
   server `.ts` files first; they are already TypeScript and checked.
4. Last: the `gl_*` files and `menu.js`, where types come from Three.js and the
   code is 40% allocation-shaped C ports.

Do the `src/` layering (A1) before conversion: types on a cycle of 49 modules
cause `any` cascades.

## Code health

### H1. Large files (Medium, M)

Top by lines: `menu.js` 4207, `gl_model.js` 3552, `gl_rsurf.js` 3422,
`sv_main.js` 2456, `agent.js` 2379, `pmove.js` 2330, `gl_rmain.js` 2103,
`in_web.js` 1974, `pr_cmds.js` 1970, `host_cmd.js` 1928, `touch.js` 1894,
`net_webtransport.js` 1782, `net_webrtc.js` 1571. Server side:
`net_webtransport_server.ts` 1868, `lobby_server.js` 1396.

The ported C files should stay large, since function-by-function parity is
easier to review against one C file. Split the Icaro-own files, which have no
such constraint: `agent.js` (observation, actions, nav, RL tier from #243/#244,
all one module and growing), `in_web.js`, `touch.js`, `menu.js` (Icaro menu
additions vs the C `menu.c` port), `net_webtransport.js`/`net_webrtc.js` and
`lobby_server.js`. #243, #244 and #237 all edit `agent.js` and `main.js` now, so
split `agent.js` after they merge.

### H2. Test coverage by module (Medium, M)

190 files in `tests/`, 52k lines of tests against 79k lines of `src/`, 1035
tests passing. Counting tests that import each module, these have none: `crc`,
`default_cfg`, `net_loop`, `pr_sprintf`, `progdefs`, `snd_mix`, `sv_move`,
`unicode_translit`. Imported by a single test only: `autosave`, `cl_reconnect`,
`cl_tent`, `gl_contextloss`, `gl_entalpha`, `gl_fog`, `gl_md5`, `gl_refrag`,
`gl_rmirror`, `gl_sky`, `image`, `net_websocket`, `pwa_launch`, `room_rules`,
`turnstile`, `wad`. Most important: `sv_move.js` (monster movement, used by
every QuakeC monster) and `snd_mix.js` (mixer) have no direct test;
`determinism_test.js` and the `server_bench` checksum partly cover `sv_move`. No
test covers WebRTC against a real peer (`fake_webrtc.js` only), no
rendered-pixel test, no coverage tooling (`deno test --coverage` is available
and unused).

Recommendation: add `deno task coverage` (S) and publish the number; write
direct tests for `sv_move`, `snd_mix`, `pr_sprintf`, `crc`; add a golden-hash
test for one rendered frame in headless Chrome (M) when the smoke test exists.

### H3. Hot-path allocation (Medium, M)

The rule is "no allocation per frame or per call". Indented (non-top-level)
allocations of typed arrays, arrays and Three objects by file: `gl_model.js` 76
(load-time, acceptable), `client.js` 29, `world.js` 27, `gl_rsurf.js` 24,
`gl_md5.js` 20, `pmove.js` 19, `nav.js` 19, `render.js` 14. Lint cannot enforce
the rule. Of these only `gl_rsurf.js`, `pmove.js`, `world.js`, `nav.js` and
`client.js` are per-frame candidates.

Recommendation: do not audit by reading. Add a debug counter that fails a test
if a frame allocates (run `Host_Frame` 600 times in `headless_client_test.js`
and compare `performance.memory`/`--v8-flags=--trace-gc` or
`FinalizationRegistry` counts), then fix what it finds. The benches in
`tools/bench/` give the checksum side but not an allocation gate.

### H4. Dead code and duplication (Low, S to M)

Beyond A2: `src/gl_warmup.js` and `gl_contextloss.js` have tests that stub the
renderer; `docs/` holds nine status files that `AGENTS.md` itself calls
snapshots (`port-review.md` alone is 800+ lines), a recurring merge-conflict
source (#242 exists to refresh them). Move live status into a short generated
table (`tools/port_inventory.py` already regenerates tables) and archive the
prose.

The tool `tools/` set (not linted or run in CI) has bit-rot risk: `deno check`
covers `cloudflare/client/build.js` only. Add `tools/*.js` to the `check` task.

### H5. `Sys_Error` HTML injection and other small items (Low, S)

- `src/sys.js:14` interpolates the error text into `innerHTML` (see A4).
- `src/` has one `innerHTML` use in total, so the fix is local.
- Dynamic `import(specifier)` in `touch.js:1314`, `chase.js:42`, `view.js:1057`
  breaks bundlers that cannot see the specifier; fine for `import("./x.js")`,
  but `touch.js` imports the nipplejs specifier from a variable. Make it a
  literal when bundling.

## Licensing and data

### L1. GPL-2.0 consequences for games built on Icaro (High to decide, S)

Facts: repo `LICENSE` is GPL v2 (full text, "or any later version" clause in the
standard header). The README says only "Code: GPL v2" and does not say "or
later". Sources ported from: id's Quake (GPL v2), Ironwail, QuakeSpasm and
FitzQuake (GPL v2 or later), Three.js (MIT), nipplejs (MIT), three-quake (the
fork source; its licence should be checked and recorded).

Consequences, informally (this is not legal advice):

- A game that ships the Icaro engine (browser JS, Deno desktop binary, mobile
  wrapper) distributes a GPL work; the whole distribution of that engine must
  carry GPL v2 and offer the corresponding source. A browser game that serves
  engine JS to users is distribution. Minified or bundled output needs the
  source map or a source link to count as "preferred form".
- A hosted server alone is not distribution under GPL v2 (no AGPL clause), so
  the Cloudflare lobby and game rooms do not trigger source offers by
  themselves.
- Game assets (levels, art, sound, music) and QuakeC `progs.dat` loaded at run
  time are normally treated as separate works if the game is a "mere aggregate";
  `progs.dat` that uses Icaro-specific builtins is the grey zone, and
  LibreQuake's own `progs.dat` is GPL v2. A game author who wants closed assets
  can ship them as separate packs; one who wants a closed engine extension
  cannot.
- Adding an "Icaro game" exception (a GPL linking exception for content) is a
  decision for the copyright holders; code ported from id and Ironwail cannot be
  relicensed by this project, only a clean new `core/` layer could carry a more
  permissive license. That is an argument for making `core/` (A1) a real
  boundary, and for keeping Icaro-native code free of ported C.

Recommendation: state "GPL-2.0-or-later" explicitly if that is the case (check
each file's origin; `host.js` headers cite WinQuake only), add SPDX headers to
`src/`, add `THIRD_PARTY.md` listing Three.js, nipplejs, Deno, CEF (BSD-style),
fonts and the shareware pak terms, and write a one-page "Shipping a game on
Icaro" note. Do this before the desktop build, which makes redistribution real.

### L2. Shareware pak and community maps (Medium, S)

`static/pak0.pak` (18 MB, committed) is id's shareware data. It may be
redistributed only whole and unmodified under id's shareware terms, which are
not GPL; the repo's license file does not say so. `static/maps/` holds 7
community BSPs tracked in git without license files. Both are separate from the
GPL claim and should be listed in `THIRD_PARTY.md` with their terms; a hosted
game must not imply the GPL covers them. Once LibreQuake is default, the
shareware pak can become a compatibility-test fixture only (see below).

### L3. LibreQuake as the default content (High for the direction, M)

Facts (github.com/lavenderdotpet/LibreQuake, checked 2026-11-26): latest release
`v0.09-beta`; assets `lite.zip` (56 MB), `full.zip` (116 MB), `mod.zip`,
`server.zip` (71 MB), `dev.zip` (22 MB). The game directory in the repo is
`lq1/` (it can be pasted as `id1/`). Licensing, from
`docs/README-IMPORTANT-LICENCE-INFO`: models, textures and sounds are BSD
3-clause; QuakeC, `progs.dat` and `pop.lmp` are GPL v2. The BSD terms need the
copyright notice and disclaimer reproduced in binary distributions and forbid
using the project's name for endorsement. GitHub reports the repo licence as
"other". The project is beta; completeness and any missing episode content
should be checked before it is made default.

What changes in this repo:

1. `src/quakedef.js:6` `GAMENAME = "id1"`: LibreQuake's directory is `lq1`;
   either mount it under `id1` (QuakeSpasm users do) or make the game name data.
   Mods then resolve against `lq1`, the retail-compat path against `id1`.
2. `main.js:135-227` hard-codes `static/pak0.pak`, `pak1.pak` and the retail
   layout. Replace with a manifest-driven mount list (A5), default `lq1` paks,
   retail `id1` paks as an optional mount (BYO paks, #240).
3. `src/pak.js` itself needs no change for BSD or GPL content; check
   LibreQuake's pak layout (it ships loose files, the build script `build.py`
   makes `pak0.pak`.. packs) and that `COM_AddPakSequence`'s lazy-range path
   handles multiple paks of 50 MB or more.
4. `cloudflare/client/build.js`: `CLIENT_SHAREWARE_PAK` and its SHA-256 become a
   list of allowed paks (LibreQuake's pak hashes and a notice file). The deny
   list keeps `id1` out; if LibreQuake mounts as `id1` the deny rule must be
   reworked to match by hash rather than folder name, or LibreQuake must use
   `lq1`. Prefer `lq1` and keep `id1` denied.
5. `.github/workflows/ci.yml` "No registered data" step allows only
   `static/pak0.pak`; it needs the same list, plus a check that LibreQuake's
   notice (`CREDITS`, BSD text) is tracked next to the paks.
6. `server/Dockerfile` and `.dockerignore`: allowlist `deno.json`, `server/`,
   `src/`, `static/pak0.pak`; swap to the LibreQuake pak, and update
   `tools/check_container_image.sh`. The image already refuses other paks, so
   this is a one-list change. `server.zip` (71 MB) is probably the right asset,
   with no client art.
7. Size: tracking a 56 to 116 MB pak in git bloats clones (repo pack is 12 MB
   now). Prefer a release asset fetched by a pinned URL and SHA-256 at build
   time (like the container check) over committing it; Workers static assets cap
   a file at 25 MiB, so a LibreQuake pak needs R2 or a split, which also matters
   for `CLIENT_MAX_FILE_BYTES`.
8. Tests (`pak_*_test.js`, `headless_client_test.js` and others) read
   `static/pak0.pak`; keep that file as a retail-compat fixture and add a
   LibreQuake fixture later. Keep AGENTS.md's "retail data never committed"
   rule; add "LibreQuake only at a pinned release".

Overlap: #240 (BYO paks from browser storage: `main.js`, `src/pak.js`,
`src/menu.js`, `src/userdata.js`) is the same seam; land it first, and build the
manifest on top of it.

## Other

### O1. Agent/MCP surface is large and moving (Low, M)

`agent.js` 2379 lines plus `server/agent_mcp.ts` 488; PRs #237, #243, #244 add
an `rl` tier, a Gymnasium env and goto/attack changes, all editing `agent.js`,
`main.js` and `agent_mcp.ts`. They conflict with each other; merge them in
sequence. A single `docs/agent-interface.md` is the contract; make a version
field in the observation schema before more consumers (Python gym) depend on it.

### O2. Security posture of the browser client (Medium, S)

No CSP exists in `index.html`; #238 adds a nonce one for the Cloudflare client.
The page loads two CDN modules with SRI on the import map, runs inline scripts
(`index.html:150`), and the `?server=` parameter is validated in `sys.js` before
becoming a console line, which is good. When the CDN goes away (B2) a strict
`script-src 'self'` becomes easy; a `?server=` allowlist for the desktop build
avoids a crafted link pointing a signed binary at an arbitrary host.

### O3. Native Icaro standard and protocol 666/999 (Medium, L)

`protocol_icaro_test.js` exists, so an Icaro-native extension has started. Put
the protocol table (15 NetQuake, 666 FitzQuake, 999 RMQ, Icaro) in one
negotiated module, with the existing delta-packet entities as the Icaro variant,
so a QuakeSpasm-level client path and the native path do not fork `cl_parse.js`
(1792 lines) and `sv_main.js` (2456).

## Recommended order

1. S, now: `sys.js` `innerHTML` to `textContent`; add `client-build` to CI;
   `deno test --coverage` task; `THIRD_PARTY.md` and SPDX policy (L1, L2).
2. S to M: vendor `three` and `nipplejs`, align with #238 (B2); desktop spike
   (B1); land #240 then manifest-driven mounts (A5, L3).
3. M: `glquake.js` constants-only (A2); split `gl_model.js` and drop the
   Three.js shim from the server graph (A1).
4. M: `Host` port for `window` access (A4); `deno bundle` step (B2).
5. L: hub-module cycle breaks, `@ts-check` leaves outward, then `.ts` (T1).
6. L: LibreQuake default content with the manifest, hash allowlists in
   `build.js`, CI and the image (L3).
