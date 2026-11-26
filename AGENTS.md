# AGENTS.md

Icaro Engine is a multi-platform web game engine that runs Quake: an engine that
runs Quake, not only a Quake engine. `docs/vision.md` gives the goals. It began
as a function-by-function port of id Software's WinQuake/GLQuake (C) to
JavaScript ES modules and is becoming a modern source port: the port's structure
is where it started, not a limit. The client renders with Three.js r183 in the
browser. Multiplayer uses WebTransport (or WebSocket where WebTransport is
missing or a Cloudflare Tunnel sits in front), with QuakeWorld-style client
prediction, and runs on a Deno lobby server that starts one `game_server.js`
process per room. It was forked from mrdoob's three-quake.

## Layout

- `src/`: the engine, shared by the browser and the Deno server. File names
  mirror the C files (`sv_phys.js` is `sv_phys.c`). Web-only additions:
  `in_web.js`, `touch.js`, `webxr.js`, `net_webtransport.js`,
  `net_websocket.js`, `net_webrtc.js` (browser-hosted rooms; the design is
  `docs/browser-hosted-rooms.md`), `net_rtclobby.js` (that driver's lobby
  signaller: hosting and joining by code), `room_rules.js` (game rules shared by
  lobby rooms and browser-hosted ones), `pak.js`, `menu_cvars.js`, `agent.js`
  (the agent API, `window.icaro`; see `docs/agent-interface.md`), `turnstile.js`
  (the Turnstile widget shown before creating a room), `pwa_launch.js` (what the
  installed app does when launched again while open), `nav.js` (the walk graph
  behind the agent's `goto` and `map`), `cl_reconnect.js` (reconnect after a
  lost multiplayer connection, browser-hosted rooms included), `autosave.js`
  (the autosave-on-hide rules), `gl_contextloss.js` (WebGL context loss and
  restore), `gl_warmup.js` (shader warm-up behind the loading plaque),
  `vid_dynres.js` (dynamic resolution, `vid_dynres`), `userdata.js` (bring your
  own data: the Game data panel, its OPFS or IndexedDB store, and the player's
  paks, saves, configs and demos), `touch_layout.js` (the touch HUD's saved
  layout profiles) and `touch_editor.js` (the layout editor,
  `touch_editlayout`), `intro.js` (the intro page: nothing pak-related loads
  before a person presses Play) and `librequake.js` (LibreQuake's download, hash
  check and unpack; see `docs/librequake-content.md`). Some files port features
  from Ironwail or QuakeSpasm rather than id's C, and their headers cite it
  (`gl_fog.js`, `gl_sky.js`, `gl_md5.js`, `gl_entalpha.js`, `gl_screenwarp.js`,
  `gl_gamma.js`, `image.js`, `pr_sprintf.js`, `default_cfg.js`,
  `unicode_translit.js`). For those, Ironwail's source is the reference.
- `main.js` and `index.html`: the browser entry. `index.html`'s import map loads
  `three` and `nipplejs` from jsDelivr, and zip.js (for LibreQuake's download)
  with an integrity hash; both `deno.json` files repeat the zip.js entry, and
  its file is a remote entry in `deno.lock`. Assets are in `static/`. `sw.js` is
  the service worker (offline play and caching; see its header), and
  `manifest.webmanifest` the install metadata, with its screenshots in
  `static/screenshots/`.
- `server/`: `lobby_server.js`, `game_server.js` and the WebTransport and
  WebSocket server drivers (`.ts`). `lobby_rtc.js` is the lobby for rooms hosted
  in browsers (room table and WebRTC signal relay) and `room_config.js` the
  room-config checks, and `turnstile.js` checks a Turnstile token with
  Siteverify before a room is created (see `server/README.md`); all three are
  pure, so the Cloudflare lobby imports them too. Under Deno, `three` maps to
  `server/browser_shim.js` (root `deno.json`). If `src/` starts using a new
  Three.js export, add it to the shim or the server and tests break.
  `server/deno.json` repeats the root import map for scripts run from `server/`
  and editors; keep the two in step. The only npm packages are the MCP SDK and
  zod, for `server/agent_mcp.ts`, and `@babel/parser`, for
  `tools/fmt_ast_check.js` and `tools/collapse_banners.js` (imported by full
  `npm:` specifier, not through the import map), all pinned in the root
  `deno.lock`; the engine, servers and room image import none.
  `server/headless_host.js` runs the whole game (host, local server and a
  loopback client) under Deno with no browser or rendering, for scripted play;
  its header says how to wait for a level to load. `server/agent_mcp.ts` is an
  MCP server (stdio, on the official MCP TypeScript SDK) on top of it that
  exposes `src/agent.js` as tools, so MCP clients can play headless
  (`deno task agent-mcp`; its header gives the `claude mcp add` line).
  `server/Dockerfile` builds the game-room image from an allowlist (`deno.json`,
  `server/`, `src/`, `static/pak0.pak`), with the root `.dockerignore` as a
  second guard; never widen either to registered data (see Game data).
- `cloudflare/lobby/`: the lobby Worker and Durable Object for rooms hosted in
  browsers, with TURN credentials and the Turnstile check (its README says how
  to deploy). `src/worker.js` imports `cloudflare:workers`, so tests run
  `src/lobby_core.js` and `src/gate.js` (the Origin check and rate limits before
  the Durable Object) instead. Its route serves it at
  `quake.anglezarke.games/mp/lobby`. Run wrangler only from that folder: from
  the repository root it offers to upload the whole repository, registered data
  included.
- `cloudflare/client/`: the Worker that serves the game page at
  `quake.anglezarke.games` as static assets, with a script for the page alone
  that adds a CSP nonce (`src/nonce.js`, tested by
  `tests/cloudflare_client_nonce_test.js`). `build.js`
  (`deno task client-build`) fills its gitignored `dist/` from an allowlist of
  tracked files with a deny check for registered data, and wrangler uploads only
  `dist/` as assets; its README gives the deploy steps.
  `tests/client_build_test.js` covers the rules.
- `docs/`: design notes, reviews and research; `docs/README.md` says what each
  one covers. Most are snapshots taken at a past revision, so check their claims
  against the code before relying on them.
- `tools/`: `nav/nav_build.js` builds the agent's walk graphs offline (its
  header gives the command; not linted or run in CI). `port_inventory.py`
  regenerates the raw tables of `docs/port-inventory.md` (Python, standard
  library only; not linted or run in CI). `room_bench.js` (with
  `room_bench_preload.js`) load-tests one room with headless WebSocket bots, and
  `room_memory_probe.js` measures a room's memory by init stage; their headers
  give the commands. `webrtc_spike/` is a static page that answers the WebRTC
  questions in `docs/browser-hosted-rooms.md`; its `index.html` says how to run
  it. `do_cpu_probe/` is a throwaway Cloudflare Worker that measures the Free
  plan's Durable Object limits; `probe.js` gives the deploy steps, which need
  the maintainer's account. Not linted or run in CI. `make_splash.py` draws the
  iOS launch images in `static/splash/` from `static/icon.png` and writes their
  tags into `index.html` (Python, standard library only; not linted or run in
  CI, but `tests/manifest_test.js` checks its output). `gym/icaro_env.py` is a
  Gymnasium env that plays through the agent MCP server's rl tools, one server
  per env (Python; needs gymnasium, numpy and Deno; its header gives the
  command; not linted or run in CI, but `tests/agent_rl_test.js` runs its call
  sequence). `fmt_ast_check.js` compares each changed file's syntax tree with
  its version at a git ref, to show that a formatting change (see
  `docs/style-cleanup-plan.md`) changed nothing else; its header gives the
  command and what it accepts. Not linted or run in CI. `collapse_banners.js`
  turned the C-style comment banners into doc comments and `//` lines (tier 2 of
  the plan); the plan's catch-up steps for an open PR run it again.
  `--verify <ref>` checks that no comment text was lost but the name lines of
  the banners it deleted. Not linted or run in CI. `check_container_image.sh`
  (`deno task image-check`, needs Docker) fails if the game-room image or its
  build context holds any `.pak` but `static/pak0.pak`, or TLS or env files,
  then starts a room in the image; CI runs it.
- `tools/bench/`: headless Deno benchmarks (not linted or run in CI). They use
  pak0 by default; the server, build, model and net benchmarks also take
  `-base rerelease` (and, except model, the game flags) to run on the gitignored
  data. `server_bench.js` times map load, physics and QuakeC frames, and hull
  traces (`-dedicated` measures the server's load path). Its checksum column
  must not change: a different checksum means behaviour changed.
  `build_bench.js` (map build), `model_bench.js` (alias and MD5 loads) and
  `net_bench.js` (server send, client parse, prediction) print hashes or
  checksums that must not change either. `load_bench.js`, `world_bench.js` and
  `render_bench.js` cover cold model loads, the world's visibility pass, and
  particles and the 2D layer. Each file's header gives its command. Compare
  before and after on the same machine.

## Commands

- `deno task ci` runs what CI's main job runs: `deno fmt --check`,
  `deno task test`, `deno task lint` and `deno task check`. Run it before
  calling work done. CI's second job is `deno task image-check` (needs Docker).
- `deno task test`: the whole suite (about 30 s). Its permissions are scoped: no
  network, env limited to the `FAKE_ROOM_*` variables, and run limited to
  `tests/fixtures/fake_room_server.sh`. A test that needs more must widen the
  task deliberately. For one file:
  `deno test --allow-read --allow-write tests/<file>_test.js` (add the task's
  `--allow-env`/`--allow-run` for `server_lobby_test.js`). Narrow further with
  `--filter`.
- `deno task check` type-checks `main.js`, the server entry points (the MCP
  server `server/agent_mcp.ts` included), the room process manager
  (`server/room_process_manager.ts`), the WebSocket server driver
  (`server/net_websocket_server.ts`), the client Worker's build script
  (`cloudflare/client/build.js`) and the two TypeScript tests
  (`tests/net_webtransport_server_test.ts`, `tests/quic_listen_test.ts`).
- `deno task agent-mcp` runs the agent MCP server on stdio (reads only
  `static/`; no network).
- `deno task client-build` fills `cloudflare/client/dist/` for the client Worker
  (runs `git`; refuses uncommitted client files unless given `--allow-dirty`).
  Deploy with `cd cloudflare/client && npx wrangler deploy`.
- `deno task lobby` and `deno task game` need `server/cert.pem` and
  `server/key.pem` (see `server/README.md`). Both are gitignored.
- To run the client, `deno task serve` and open http://localhost:8137/. It is
  Deno's std file server (version pinned in the task, its modules in
  `deno.lock`), bound to 127.0.0.1 so registered data in `static/` isn't served
  to the network, and it honours HTTP Range, which the rerelease's lazily loaded
  paks need. Any static file server works otherwise. `.claude/launch.json`
  defines the preview servers for Claude Code: `static` (`deno task serve`),
  `client-worker` (`wrangler dev` on `cloudflare/client/dist/`, port 8788, with
  its security headers; run `deno task client-build` first) and `lobby`
  (`deno task lobby`: port 4433, the client's default, with rooms on 4434–4443;
  it needs the certs). To drive it as an agent, open
  `?agent=lockstep&map=e1m1&skill=1`, press the intro page's Play button, and
  call `icaro.help()` in the page.
- CI (`.github/workflows/ci.yml`) runs on PRs to `dev` and `main` and on pushes
  to them: a check that no pak but `static/pak0.pak` is tracked, then
  `deno fmt --check`, test, lint and check, on the Deno version pinned in
  `.tool-versions`, and, in a second job, `tools/check_container_image.sh`. The
  Dockerfile pins the same Deno version: bump both together
  (`tests/deno_version_pin_test.js` fails if they differ). Actions are pinned by
  SHA and Dependabot bumps them weekly. Tests cover logic only: rendering, audio
  and touch changes need a browser check. If you didn't do one, say so.

### Lint and format

- `deno task lint` (config in root `deno.json`: `main.js`, `sw.js`, `src/`,
  `server/`, `tests/`, `cloudflare/`; `no-window` rules off) passes with zero
  problems. The bar is **lint passes**; CI enforces it.
- Unused parameters kept for C-signature parity get a `_` prefix
  (`Z_Free(_ptr)`). Use a line-level `// deno-lint-ignore no-unused-vars` with a
  reason only for C-parity state that has no reader in the port.
- `deno fmt` sets the layout (settings in root `deno.json`): run it before
  committing. CI runs `deno fmt --check`, and `deno task ci` runs it first.
  Markdown is formatted too (wrapped at 80 columns). HTML, CSS, SVG, `static/`,
  `tests/fixtures/`, `cloudflare/client/dist/`, `.claude/` and `.vscode/` are
  excluded. A data table that reads better in rows gets a `// deno-fmt-ignore`
  line with a reason above it.

## Compatibility and fidelity

- Each layer of the engine has its own reference. Follow the one for the code
  you touch:
  - **Vanilla Quake** (id1, the mission packs, protocol 15, the QuakeC VM,
    physics, GLQuake rendering): id's C,
    [id-Software/Quake](https://github.com/id-Software/Quake). `WinQuake/`
    covers WinQuake and GLQuake (`gl_*.c`), and `QW/` covers QuakeWorld.
  - **Community standard** (protocols 666 and 999, BSP2, `.lit`, fog, skyboxes,
    alpha, raised limits, the QuakeC extensions mods test for):
    [QuakeSpasm](https://github.com/sezero/quakespasm) and
    [Ironwail](https://github.com/andrei-drexler/ironwail). For extensions they
    lack, [Quakespasm-Spiked](https://github.com/Shpoike/Quakespasm),
    [FTEQW](https://github.com/fte-team/fteqw) and
    [DarkPlaces](https://github.com/DarkPlacesEngine/DarkPlaces).
  - **The 2021 rerelease (KEX)**: Ironwail.
  - **Icaro's own features** (the web platform, netplay, input, the agent API, a
    future Icaro-native standard): no reference. Design them, but don't let them
    change how Quake content plays.
- The references fix behaviour, not code structure. Within a layer, keep what
  players and content see as the reference has it: how the game plays, looks and
  sounds, and what QuakeC, configs, demos and saves rely on. Don't invent new
  behaviour there, and note any deliberate deviation in a comment and in the PR
  body. The code itself may be restructured, modernised or rewritten as long as
  that behaviour is kept and tested (unit tests, the benchmarks' checksums).
- Keep the names content depends on: **cvar and console names exactly as in
  Quake** or the port that introduced them, and QuakeC builtins and fields.
  Players' configs and QuakeC depend on them. A cvar or command that is Icaro's
  own must not reuse a name any reference port uses for something else.
- Code that still mirrors a reference function keeps its name (`SV_Physics`,
  `R_MarkLeaves`), globals and struct fields, so the two can be compared. Files
  ported from a reference start with a header citing it, e.g.
  `// Ported from: WinQuake/common.c` or `Ironwail Quake/gl_fog.c`. Where the JS
  name differs, or one function covers several C ones, a comment names the
  function it mirrors. Rewritten code may use new names; a comment names what it
  replaces.
- Before deleting code that looks dead or odd, check whether it mirrors the
  reference. In code that still mirrors it, keep it with
  `// deno-lint-ignore <rule>` and a "mirrors the C" comment. Unused parameters
  often exist only to keep the C signature.
- The server runs NetQuake physics (`sv_phys.js`, `sv_user.js`) and must stay
  NQ-faithful. The client predicts with QW `pmove` (`pmove.js`, `cl_pred.js`).
  Fix prediction mismatches on the client side.
- Protocols: NetQuake 15, FitzQuake 666 and RMQ 999 are compatibility targets,
  since demos exist in all three. The messages QuakeC writes itself are NetQuake
  ones, which read the same under every protocol. Icaro's own netplay protocol
  (`PROTOCOL_ICARO` in `protocol.js`, with QuakeWorld-style delta packet
  entities) is the base of a future Icaro-native standard. Only Icaro clients
  and servers talk to each other: joining a native engine's server is not a
  goal. Client and server ship together, so a message-format change must update
  both sides in the same PR.
- Anything a link, a host or a mod can feed the client is untrusted: URL
  parameters, `stuffcmd` from a server (a browser-hosted room's host is a
  player), and downloaded files. URL parameters may set only an explicit
  allowlist of safe settings, never commands that bind keys, define aliases, run
  other commands or scripts, connect somewhere or write files.
- A remote host's `stuffcmd` text must pass an allowlist, and nothing it sets is
  saved; only your own local server is trusted fully (not yet enforced; see
  `docs/audit/README.md`, decision 2).

## Code style

- `deno fmt` decides layout (two-space indent, 80 columns, double quotes). Use
  snake_case for ported identifiers.
- Comments: `/** */` documents a declaration (a top-level function, variable or
  class, or a class member). Everything else is `//`: notes, deviations from the
  C, directions. No `====` banners, and no empty `//` lines above and below a
  comment.
- **Golden Rule #2**: use explicit null checks (`x !== null`), not falsy checks.
- **Golden Rule #4**: don't allocate in per-frame or per-call hot paths.
  Pre-allocate module-level scratch buffers (`Float32Array(3)` vectors, etc.).
- Use an established, maintained library where one fits (zip reading, for
  example) rather than writing a new one. Pin it (`deno.lock`, or a versioned
  import-map URL for the browser), check that its licence is compatible with
  GPL-2.0, and list it in `THIRD_PARTY.md`.
- Imports are relative and include the `.js`/`.ts` extension.
- Tests use `Deno.test` and throw `Error` by hand (no assert library). Tests
  that change a cvar must restore it in `finally`. Browser globals are stubbed
  per test (see `tests/audio_ui_test.js`, `tests/fake_webtransport.js`).

## Engine gotchas

- C globals are module exports. An importer can't assign to an imported binding,
  so writes go through `set_*` setters in the owning module. Where C shared one
  global across files, the port may keep several copies (for example
  `host_frametime` in `host.js` and in `sv_phys.js`). A setter must update every
  copy, so check that before trusting it.
- Some modules are in import cycles. A top-level `new SomeClass()` whose class
  comes from another module in the cycle throws a TDZ error ("Cannot access
  before initialization"). Use a hoisted function or lazy initialization.
- Some state is duplicated across similar modules (e.g. `glquake.js` and
  `gl_rmain.js`). Check which copy is live before changing it.
- `src/` touches `window` and `document`. Code reached from `server/` or
  `tests/` must not touch them at import time.
- Mission-pack flags (`rogue`, `hipnotic`, `standard_quake`) are `export let` in
  `common.js` and are set by `COM_InitArgv` (from `?game=` in `main.js`, or the
  server flags), not by importers.

## Game data

[LibreQuake](https://github.com/lavenderdotpet/LibreQuake) is to become the
project's standard content: use it for new features, tests, demos and
screenshots where it can serve. Players get it as a pinned release downloaded on
first run, behind an introductory page so crawlers and bots never fetch pak
data; it isn't committed. Retail and rerelease data are for compatibility
testing only.

`static/pak0.pak` is the shareware Episode 1 pak and is committed. Registered or
commercial data (`static/pak1.pak`, and the mission packs in `static/hipnotic/`
and `static/rogue/`, and the 2021 rerelease in `static/rerelease/`,
`static/id1/` and `static/{mg1,mg3,dopa,ctf}/`) must **never** be committed or
deployed publicly; `.gitignore` covers those paths and every `.pak` but
`static/pak0.pak`, and CI fails if another pak is tracked. `.gitignore` also
covers `static/music/`, a player's CD rips, which `sw.js` caches on the player's
device for offline play (no other `music/` folder is cached). LibreQuake, the
browser's default content, is never committed or deployed either: it is
downloaded into the player's browser storage, and `static/librequake/` (a local
copy for testing, and the release zips under `v0.09-beta/`) is gitignored and
denied by the client build. The client loads a mission pack with
`?game=hipnotic` or `?game=rogue`, a rerelease add-on with `?game=mg1` (etc.),
the rerelease layout with `?base=rerelease`, LibreQuake with `?base=librequake`
and id's data with `?base=id1`; the servers take `-hipnotic`, `-rogue` or
`-game <dir>`. If the data isn't present, test that the shareware game is
unchanged and list manual test steps in the PR.

## Git workflow

- `dev` is the integration branch. Branch from an up-to-date `dev`
  (`git fetch origin` first). Before you start, check that the bug isn't already
  fixed there. `main` is for releases: never branch from it or target it.
- Branch names: `agent/<topic>`, `fix/<topic>`, `refactor/<topic>`,
  `feat/<topic>`.
- Commit subjects are short imperative sentences: no prefix, no trailing period,
  e.g. "Restore gl_doubleeys console cvar name". The body, if any, says why.
  Commits are signed. Never disable signing.
- Open one PR per concern with `--base dev`, then stop. Merge a PR only when the
  maintainer asks for it in chat ("merge into dev", "merge all"), and then only
  PRs whose CI has passed, with `gh pr merge <n> --merge` (outside the sandbox).
  Always a merge commit: never squash, rebase or auto-merge.
- Status docs (`docs/rerelease-gaps.md`, `docs/port-review.md`, the status
  sections of the other `docs/` files) collect most of the merge conflicts
  between parallel PRs. A feature PR leaves them alone unless the doc is its
  subject; one docs PR updates them after a batch of work merges.
- A PR body says why, lists each finding as fixed or not (with the reason), how
  it was verified (test count, lint), and what was _not_ verified (browser, real
  device, live QUIC).
- When several agents work in parallel, each owns a disjoint set of files. If a
  fix needs a file you don't own, leave it out and name it in the PR body.
