# docs

Design notes, reviews and research. Most are snapshots taken at a past revision:
check their claims against the code before relying on them. Status sections are
updated by a docs PR after a batch of work merges, not by each feature PR (see
AGENTS.md, Git workflow).

- `vision.md`: the project's goals and direction. Kept current, not a snapshot.
- `audit/`: the November 2026 audit against `vision.md`: runtime and standard
  compatibility, rendering, multiplayer security and architecture.
  `audit/README.md` has the decisions, the roadmap and a status section saying
  what has been done since; the five track files are snapshots, each noting
  which of its findings have been addressed.
- `browser-check-2026-11-27.md`: a browser check of `dev` at `bf3915f` after the
  LibreQuake and protocol merges, with an in-game console audit of all 54
  LibreQuake maps and a manual Safari checklist. A snapshot; its status line
  lists the fixes merged since.
- `browser-check-content-2026-11-27.md`: a browser check of `dev` at `3603119`
  across content sets (id1, hipnotic, rogue, quoth, the rerelease and its add-on
  mg1, LibreQuake): play, save and load, bundled demos, a map sweep with a
  console audit, and the HUD styles. A snapshot; its status line says which of
  its follow-ups have been fixed or addressed since.
- `port-review.md`: a fidelity review of the port against the C source. A
  snapshot.
- `port-inventory.md`: every C function, cvar and command in the GLQuake build's
  files checked for a counterpart in the port, with the ranked list of gaps.
  `tools/port_inventory.py` regenerates its raw tables; the analysis around them
  is only spot-updated.
- `rerelease-gaps.md`: what blocked the 2021 rerelease content and how each item
  was done; every item is now done or not needed. A snapshot.
- `threejs-review.md`: a review of the Three.js rendering code against r183,
  with the status of each finding. A snapshot.
- `cloudflare-multiplayer.md`: research notes on hosting multiplayer behind
  Cloudflare; its status note says how `quake.anglezarke.games` is served now.
  Its claims about this repository were rechecked on 2026-11-26; the Cloudflare
  facts were not, and can change.
- `always-on-hosting.md`: hosting multiplayer without the home Mac (Containers,
  Durable Objects, VMs), with room memory/CPU/bandwidth measurements and the
  plan. Supersedes the recommendation in `cloudflare-multiplayer.md`, but its
  own recommendation (Containers) was not built, though some steps of its plan
  were: the project went with browser-hosted rooms instead. A snapshot.
- `browser-hosted-rooms.md`: design for rooms hosted in a player's browser tab
  and joined over WebRTC, with a Durable Object lobby for signalling. Built
  through PR 5 (the menus), with reconnect to a browser-hosted room since, and a
  hidden host tab that keeps its room running (measured in desktop Chrome; no
  phone tried); its status line says what has been checked in a browser.
- `mobile-roadmap.md`: mobile-friendliness review (controls, rendering, offline,
  lifecycle, networking, competitive landscape) with confirmed bugs and a ranked
  roadmap; its status section lists the items built since (all three tiers but
  the store wrappers, item 23). A snapshot; the review itself was not tested on
  a device, the status section records a later test on one phone, and tier 3 was
  checked only in emulation.
- `agent-interface.md`: research and plan for making the engine playable by LLM
  agents and RL (lockstep clock, text observations, macro actions, MCP/Gymnasium
  adapters). Phase 1 (`src/agent.js`) is built, and so are headless play, the
  stdio MCP server, seeded randomness, the navigation graph (`src/nav.js`, built
  offline by `tools/nav/nav_build.js` and at map load in agent games), the
  `goto`, `turn_to` and `attack` macros (which stop on damage or a new enemy),
  the ASCII `map` tier, the numeric `rl` tier, the browser-only `screen` tier
  and a Gymnasium env (`tools/gym/icaro_env.py`); its status section says what
  isn't. A snapshot.
- `librequake-content.md`: LibreQuake as the browser's standard content: the
  intro page and its gate, full or lite, resumable download and hash check,
  quota, hosting the zips, and the CSP. Its status line says what is built.
- `style-cleanup-plan.md`: plan to adopt `deno fmt` (two-space indent, 80
  columns) and collapse the C-style comment banners, with trial results, tiers,
  neutrality checks and how open PRs catch up. Its status line says which tiers
  are done.
- `architecture-plan.md`: a staged plan to split `src/` into platform, core and
  game layers with downward imports only: the file-by-file assignment, the edges
  that break the rule, the cut that keeps the renderer out of the dedicated
  server, duplicated state, TypeScript and bundling, and PR-sized steps.
  Measured on `dev` at 694b2cc; a snapshot. Since then the `gl_model.js` split
  it raises (open question 10) has been done (PR #280), and so have step 1, the
  layer checker and its ratchet (PR #295), and step 2, deleting unused
  duplicates (PR #312); the layers aren't built.
- `protocol-design.md`: design for a versioned Icaro network protocol: the hello
  with a revision, a game profile and capability words, a reserved svc range for
  Icaro's own messages, room for games that aren't Quake (Hexen II as the worked
  example), readers for 15/666/999 demos, and a migration plan. Compares FTEQW,
  Quakespasm-Spiked, DarkPlaces and Ironwail. Migration steps 1 to 3 are built;
  steps 4 to 6 are design only.
