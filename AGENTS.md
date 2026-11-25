# AGENTS.md

Icaro Engine is a function-by-function port of id Software's WinQuake/GLQuake
(C) to JavaScript ES modules. The client renders with Three.js r183 in the
browser. Multiplayer uses WebTransport (or WebSocket where WebTransport is
missing or a Cloudflare Tunnel sits in front), with QuakeWorld-style client
prediction, and runs on a Deno lobby server that starts one `game_server.js`
process per room. It was forked from mrdoob's three-quake.

## Layout

- `src/`: the engine, shared by the browser and the Deno server. File names
  mirror the C files (`sv_phys.js` is `sv_phys.c`). Web-only additions:
  `in_web.js`, `touch.js`, `webxr.js`, `net_webtransport.js`,
  `net_websocket.js`, `net_webrtc.js` (browser-hosted rooms; the design is
  `docs/browser-hosted-rooms.md`, added in #195), `pak.js`,
  `menu_cvars.js`, `agent.js` (the agent API,
  `window.icaro`; see `docs/agent-interface.md`). Some files port features
  from Ironwail or QuakeSpasm rather than id's C, and their headers cite it
  (`gl_fog.js`, `gl_sky.js`, `gl_md5.js`, `gl_entalpha.js`,
  `gl_screenwarp.js`, `image.js`, `pr_sprintf.js`, `default_cfg.js`,
  `unicode_translit.js`). For those, Ironwail's source is the reference.
- `main.js` and `index.html`: the browser entry. `index.html`'s import map
  loads `three` and `nipplejs` from jsDelivr. Assets are in `static/`.
- `server/`: `lobby_server.js`, `game_server.js` and the WebTransport and
  WebSocket server drivers (`.ts`). Under Deno, `three` maps to `server/browser_shim.js` (root
  `deno.json`). If `src/` starts using a new Three.js export, add it to the
  shim or the server and tests break. `server/headless_host.js` runs the
  whole game (host, local server and a loopback client) under Deno with no
  browser or rendering, for scripted play; its header says how to wait for
  a level to load. `server/Dockerfile` builds the
  game-room image from an allowlist (`deno.json`, `server/`, `src/`,
  `static/pak0.pak`), with the root `.dockerignore` as a second guard; never
  widen either to registered data (see Game data).
- `docs/port-review.md`: a fidelity review of the port against the C source.
  It is a snapshot taken at a past revision, so check its claims against the
  code before relying on them.
- `docs/port-inventory.md`: every C function, cvar and command in the
  GLQuake build's files checked for a counterpart in the port, with the
  ranked list of gaps.
- `docs/rerelease-gaps.md`: what blocked the 2021 rerelease content and
  how each item was done; every item is now done or not needed. It is a
  snapshot too.
- `docs/threejs-review.md`: a review of the Three.js rendering code against
  r183, with the status of each finding. A snapshot.
- `docs/cloudflare-multiplayer.md`: research notes on hosting multiplayer
  behind Cloudflare. Checked against `dev` when written; Cloudflare facts
  can change.
- `docs/always-on-hosting.md`: hosting multiplayer without the home Mac
  (Containers, Durable Objects, VMs), with room memory/CPU/bandwidth
  measurements and the plan. Supersedes the recommendation in
  `cloudflare-multiplayer.md`. A snapshot.
- `docs/mobile-roadmap.md`: mobile-friendliness review (controls, rendering,
  offline, lifecycle, networking, competitive landscape) with confirmed bugs
  and a ranked roadmap. A snapshot; nothing in it was tested on a device.
- `docs/agent-interface.md`: research and plan for making the engine
  playable by LLM agents and RL (lockstep clock, text observations, macro
  actions, MCP/Gymnasium adapters). Phase 1 (`src/agent.js`) is built; the
  rest is a plan. A snapshot.
- `tools/`: `port_inventory.py` regenerates that inventory's raw tables
  (Python, standard library only; not linted or run in CI).
  `room_bench.js` (with `room_bench_preload.js`) load-tests one room with
  headless WebSocket bots, and `room_memory_probe.js` measures a room's
  memory by init stage; their headers give the commands. Not linted or run
  in CI. `check_container_image.sh` (`deno task image-check`, needs Docker)
  fails if the game-room image or its build context holds any `.pak` but
  `static/pak0.pak`, or TLS or env files, then starts a room in the image;
  CI runs it.
- `tools/bench/`: headless Deno benchmarks (not linted or run in CI). They
  use pak0 by default; the server, build, model and net benchmarks also take
  `-base rerelease` (and, except model, the game flags) to run on the
  gitignored data. `server_bench.js` times map load, physics and
  QuakeC frames, and hull traces (`-dedicated` measures the server's load
  path). Its checksum column must not change: a different checksum means
  behaviour changed. `build_bench.js` (map build), `model_bench.js` (alias
  and MD5 loads) and `net_bench.js` (server send, client parse, prediction)
  print hashes or checksums that must not change either. `load_bench.js`,
  `world_bench.js` and `render_bench.js` cover cold model loads, the world's
  visibility pass, and particles and the 2D layer. Each file's header gives
  its command. Compare before and after on the same machine.

## Commands

- `deno task ci` runs what CI's main job runs: `deno task test`,
  `deno task lint` and `deno task check`. Run it before calling work done.
  CI's second job is `deno task image-check` (needs Docker).
- `deno task test`: the whole suite (~790 tests, ~20 s). Its permissions are
  scoped: no network, env limited to the `FAKE_ROOM_*` variables, and run
  limited to `tests/fixtures/fake_room_server.sh`. A test that needs more must
  widen the task deliberately. For one file:
  `deno test --allow-read --allow-write tests/<file>_test.js` (add the task's
  `--allow-env`/`--allow-run` for `server_lobby_test.js`). Narrow further with
  `--filter`.
- `deno task check` type-checks `main.js`, the server entry points, the room
  process manager (`server/room_process_manager.ts`), the
  WebSocket server driver (`server/net_websocket_server.ts`) and the two
  TypeScript tests (`tests/net_webtransport_server_test.ts`,
  `tests/quic_listen_test.ts`).
- `deno task lobby` and `deno task game` need `server/cert.pem` and
  `server/key.pem` (see `server/README.md`). Both are gitignored.
- To run the client, serve the repo root with any static file server
  (`python3 -m http.server`) and open `index.html`. To drive it as an
  agent, open `?agent=lockstep&map=e1m1&skill=1` and call `icaro.help()`
  in the page.
- CI (`.github/workflows/ci.yml`) runs on PRs to `dev` and `main`: test, lint
  and check, on the Deno version pinned in `.tool-versions`, and, in a second
  job, `tools/check_container_image.sh`. The Dockerfile pins the same Deno
  version: bump both together. Actions are
  pinned by SHA and Dependabot bumps them weekly. Tests cover logic only:
  rendering, audio and touch changes need a browser check. If you didn't do
  one, say so.

### Lint and format

- `deno task lint` (config in root `deno.json`: `main.js`, `src/`, `server/`,
  `tests/`; `no-window` rules off) passes with zero problems. The bar is
  **lint passes**; CI enforces it.
- Unused parameters kept for C-signature parity get a `_` prefix
  (`Z_Free( _ptr )`). Use a line-level `// deno-lint-ignore no-unused-vars`
  with a reason only for C-parity state that has no reader in the port.
- Never run `deno fmt` without `--check`. The code doesn't follow its style, so
  it would rewrite every file.

## Port fidelity

- Restore the C behaviour; don't invent new behaviour. The reference is
  [id-Software/Quake](https://github.com/id-Software/Quake): `WinQuake/` covers
  WinQuake and GLQuake (`gl_*.c`), and `QW/` covers QuakeWorld. Note any
  deliberate deviation in a comment and in the PR body.
- Keep C names: functions (`SV_Physics`, `R_MarkLeaves`), globals, struct
  fields, and **cvar/console names exactly as in Quake**. Players' configs and
  QuakeC depend on them.
- New ported files start with a header citing their C source, e.g.
  `// Ported from: WinQuake/common.c`. Comments on a ported function name the C
  function it mirrors.
- Before deleting code that looks dead or odd, check whether it mirrors the C.
  If it does, keep it with `// deno-lint-ignore <rule>` and a "mirrors the C"
  comment. Unused parameters often exist only to keep the C signature.
- The server runs NetQuake physics (`sv_phys.js`, `sv_user.js`) and must stay
  NQ-faithful. The client predicts with QW `pmove` (`pmove.js`, `cl_pred.js`).
  Fix prediction mismatches on the client side.
- Entity updates use QuakeWorld-style delta packet entities (`protocol.js`).
  Client and server ship together, so a message-format change must update both
  sides in the same PR.

## Code style

- Use tabs, spaces inside parentheses and brackets (`foo( a, b )`,
  `v[ 0 ]`), and snake_case for ported identifiers. Match the surrounding file.
  `server/` keeps its own existing formatting.
- **Golden Rule #2**: use explicit null checks (`x !== null`), not falsy
  checks.
- **Golden Rule #4**: don't allocate in per-frame or per-call hot paths.
  Pre-allocate module-level scratch buffers (`Float32Array(3)` vectors, etc.).
- Imports are relative and include the `.js`/`.ts` extension.
- Tests use `Deno.test` and throw `Error` by hand (no assert library). Tests
  that change a cvar must restore it in `finally`. Browser globals are stubbed
  per test (see `tests/audio_ui_test.js`, `tests/fake_webtransport.js`).

## Engine gotchas

- C globals are module exports. An importer can't assign to an imported
  binding, so writes go through `set_*` setters in the owning module. Where C
  shared one global across files, the port may keep several copies (for
  example `host_frametime` in `host.js` and in `sv_phys.js`). A setter must
  update every copy, so check that before trusting it.
- Some modules are in import cycles. A top-level `new SomeClass()` whose class
  comes from another module in the cycle throws a TDZ error ("Cannot access
  before initialization"). Use a hoisted function or lazy initialization.
- Some state is duplicated across similar modules (e.g. `glquake.js` and
  `gl_rmain.js`). Check which copy is live before changing it.
- `src/` touches `window` and `document`. Code reached from `server/` or
  `tests/` must not touch them at import time.
- Mission-pack flags (`rogue`, `hipnotic`, `standard_quake`) are `export let`
  in `common.js` and are set by `COM_InitArgv` (from `?game=` in `main.js`,
  or the server flags), not by importers.

## Game data

`static/pak0.pak` is the shareware Episode 1 pak and is committed. Registered
or commercial data (`static/pak1.pak`, and the mission packs in
`static/hipnotic/` and `static/rogue/`, and the 2021 rerelease in
`static/rerelease/`, `static/id1/` and `static/{mg1,mg3,dopa,ctf}/`) must
**never** be committed or deployed publicly; `.gitignore` covers those paths.
The client loads a mission pack with `?game=hipnotic` or `?game=rogue`, a
rerelease add-on with `?game=mg1` (etc.), and the rerelease layout with
`?base=rerelease`; the servers take `-hipnotic`, `-rogue` or `-game <dir>`.
If the data isn't present, test that the shareware game is unchanged and
list manual test steps in the PR.

## Git workflow

- `dev` is the integration branch. Branch from an up-to-date `dev`
  (`git fetch origin` first). Before you start, check that the bug isn't
  already fixed there. `main` is for releases: never branch from it or target
  it.
- Branch names: `agent/<topic>`, `fix/<topic>`, `refactor/<topic>`, `feat/<topic>`.
- Commit subjects are short imperative sentences: no prefix, no trailing
  period, e.g. "Restore gl_doubleeys console cvar name". The body, if any,
  says why. Commits are signed. Never disable signing.
- Open one PR per concern with `--base dev`, then stop. **Never merge PRs.**
  The maintainer merges with merge commits, not squash.
- A PR body says why, lists each finding as fixed or not (with the reason),
  how it was verified (test count, lint), and what was *not* verified
  (browser, real device, live QUIC).
- When several agents work in parallel, each owns a disjoint set of files. If
  a fix needs a file you don't own, leave it out and name it in the PR body.
