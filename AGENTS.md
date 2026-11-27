# AGENTS.md

Icaro Engine is a multi-platform web game engine that runs Quake
(`docs/vision.md`). It began as a JS ES module port of id Software's
WinQuake/GLQuake (forked from mrdoob's `three-quake`) and is becoming a modern
source port. Browser rendering uses Three.js r183; multiplayer uses
WebTransport, WebSocket, or WebRTC (browser-hosted rooms) with QuakeWorld-style
client prediction.

## Layout

- `src/`: engine shared by browser and Deno server (names mirror C files, plus
  web/modern additions; Ironwail/QuakeSpasm ports cite their reference in file
  headers).
- `main.js`, `index.html`, `sw.js`, `manifest.webmanifest`, `static/`: browser
  entry, CDN import map (`three`, `nipplejs`, `zip.js` with SRI hashes), service
  worker, and assets. Keep `deno.json` and `server/deno.json` import maps in
  step.
- `server/`: `lobby_server.js`, `game_server.js`, WebTransport/WebSocket
  drivers, `headless_host.js`, `agent_mcp.ts`, `game_data.js` (canonical
  test/server content config), and `Dockerfile` (allowlist + `.dockerignore`:
  never widen to `.pak` or registered data). Under Deno, `three` maps to
  `server/browser_shim.js` — add new Three.js exports there or server/tests
  break.
- `cloudflare/{client,lobby,librequake}/`: Cloudflare Workers (each has its own
  README). Run `wrangler` only from inside the target Worker folder — from repo
  root it offers to publish the whole repo.
- `docs/`: design notes and snapshots (`docs/README.md` indexes them; verify
  claims against current code).
- `tools/`: offline helpers and `tools/bench/` headless Deno benchmarks (only
  `tools/fetch_data.js` and `tools/layer_graph.js` are linted/type-checked in
  CI). `tools/layer_graph.js` holds the platform/core/game layer table
  (`docs/architecture-plan.md`); a new `src/` or `server/` file needs a row
  there. Benchmark checksums in `server_bench.js`, `build_bench.js`,
  `model_bench.js`, and `net_bench.js` must not change unless behaviour
  intentionally changes.

## Commands

- `deno task ci`: runs `deno fmt --check`, `deno task test`, `deno task lint`,
  `deno task check`. Run before calling work done.
- `deno task test`: full suite (~30 s, scoped permissions). Single file:
  `deno test --allow-read --allow-write tests/<file>_test.js` (add `--filter` to
  narrow).
- `deno task check` / `deno task lint` / `deno fmt`: type-check, lint (must pass
  with zero problems), and format (2 spaces, 80 cols, double quotes; includes
  Markdown). Use `_` prefix for unused C-parity params; line-level
  `// deno-lint-ignore` with a reason only for C-parity state.
- `deno task layers`: reports imports that break the layer plan. The ratchet
  test fails on a new violation or one gone from `tools/layer_baseline.txt`;
  `deno task layers --update` rewrites the baseline (rerun it after a rebase).
- `deno task fetch-data`: downloads pinned LibreQuake release (SHA-256 checked)
  into gitignored `static/librequake/`.
- `deno task serve`: local dev server on `http://127.0.0.1:8137/` (supports HTTP
  Range). `.claude/launch.json` defines `static`, `client-worker` (`8788`), and
  `lobby` (`4433`, needs gitignored `server/{cert,key}.pem`).
- `deno task client-build`: builds gitignored `cloudflare/client/dist/`.
- `deno task agent-mcp`: stdio MCP server over `server/headless_host.js`.
- `deno task image-check`: Docker image allowlist/smoke check (CI job 2). Keep
  Deno version pinned identically in `.tool-versions` and `server/Dockerfile`
  (`tests/deno_version_pin_test.js`).
- Tests cover logic only; rendering, audio, and touch need a browser check. Say
  explicitly if you didn't run one.

## Compatibility and fidelity

- Follow the reference for the layer you touch:
  - **Vanilla Quake**: [id-Software/Quake](https://github.com/id-Software/Quake)
    (`WinQuake/`, `QW/`).
  - **Community standard** (protocols 666/999, BSP2, `.lit`, fog, skyboxes,
    alpha, raised limits, QC extensions):
    [QuakeSpasm](https://github.com/sezero/quakespasm) and
    [Ironwail](https://github.com/andrei-drexler/ironwail) (fallback:
    Quakespasm-Spiked, FTEQW, DarkPlaces).
  - **2021 rerelease (KEX)**: Ironwail.
  - **Icaro features** (web platform, netplay, input, agent API): no reference;
    don't alter how Quake content plays.
- Preserve player-visible and content-visible behaviour, cvar/console names, and
  QuakeC builtins/fields. Note deliberate deviations in a comment and PR body.
  Code that still mirrors C keeps its reference names and cites the file in its
  header; before deleting odd/dead code, verify it isn't C-parity.
- Server runs NetQuake physics (`sv_phys.js`, `sv_user.js`); client predicts
  with QW `pmove` (`pmove.js`, `cl_pred.js`). Fix prediction mismatches on the
  client side.
- Compatibility targets: protocols 15, 666, 999 (for demos). `PROTOCOL_ICARO`
  (`protocol.js`) is Icaro-to-Icaro only; update client and server together.
- URL parameters and remote `stuffcmd` are untrusted: URL params use an explicit
  safe allowlist; remote `stuffcmd` is filtered and never saved.

## Code style & engine gotchas

- Comments: `/** */` for declarations; `//` for notes/deviations. No `====`
  banners or blank `//` padding lines.
- **Golden Rule #2**: explicit null checks (`x !== null`), not falsy checks.
- **Golden Rule #4**: no allocations in per-frame/per-call hot paths;
  pre-allocate module-level scratch buffers.
- Prefer established GPL-2.0-compatible libraries (pinned in `deno.lock` or
  versioned CDN URL with SRI, listed in `THIRD_PARTY.md`). Relative imports with
  `.js`/`.ts`. Tests use `Deno.test`, throw `Error` directly, and restore cvars
  in `finally`.
- **Module-export globals**: write via owning `set_*` setters; check for
  duplicated copies across files (e.g. `host_frametime` in `host.js` and
  `sv_phys.js`) and duplicated state (`glquake.js` vs `gl_rmain.js`).
- **Import cycles**: top-level `new Class()` across cycles throws TDZ errors;
  use hoisted functions or lazy init.
- **No DOM at import time**: `src/` modules reached by `server/` or `tests/`
  must not touch `window`/`document` at import time.
- **Mission-pack flags** (`rogue`, `hipnotic`, `standard_quake`) are owned by
  `common.js` (`COM_InitArgv`).

## Game data

- LibreQuake is the default content (fetched via `deno task fetch-data` for
  tests/servers, downloaded behind `src/intro.js` on first browser run).
- Never commit or publicly deploy `.pak` files, id/commercial data (`pak0.pak`,
  `pak1.pak`, `hipnotic`, `rogue`, `rerelease`, `id1`, `mg1`, `mg3`, `dopa`,
  `ctf`), or `static/music/`. CI fails if any `.pak` is tracked.
- Client flags: `?base=librequake|id1|rerelease`, `?game=hipnotic|rogue|mg1`.
  Server flags: `-hipnotic`, `-rogue`, `-game <dir>`.

## Git workflow

- Branch from up-to-date `dev` (`git fetch origin`). Never branch from or target
  `main`. Branch names: `agent/<topic>`, `fix/<topic>`, `refactor/<topic>`,
  `feat/<topic>`.
- Short imperative commit subjects (no prefix, no trailing period). Commits are
  signed; never disable signing.
- One PR per concern (`--base dev`), then stop. Merge only when asked in chat
  and CI passes, using `gh pr merge <n> --merge` (always merge commits; never
  squash, rebase, or auto-merge).
- Leave status docs (`docs/rerelease-gaps.md`, `docs/port-review.md`, etc.)
  alone in feature PRs to avoid merge conflicts.
- PR body states why, findings fixed/skipped, verification (test count, lint),
  and what was not verified. Respect disjoint file ownership across parallel
  agents.
- Do not add unsolicited guardrails, hooks, CI checks, or agent tooling.
