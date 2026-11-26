# docs

Design notes, reviews and research. Most are snapshots taken at a past revision:
check their claims against the code before relying on them. Status sections are
updated by a docs PR after a batch of work merges, not by each feature PR (see
AGENTS.md, Git workflow).

- `vision.md`: the project's goals and direction. Kept current, not a snapshot.
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
  through PR 5 (the menus), with reconnect to a browser-hosted room since; its
  status line says what has been checked in a browser.
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
  Measured on `dev` at 694b2cc; a snapshot.
- `protocol-design.md`: design for a versioned Icaro network protocol: the hello
  with a revision, a game profile and capability words, a reserved svc range for
  Icaro's own messages, room for games that aren't Quake (Hexen II as the worked
  example), readers for 15/666/999 demos, and a migration plan. Compares FTEQW,
  Quakespasm-Spiked, DarkPlaces and Ironwail. Nothing in it is built.
