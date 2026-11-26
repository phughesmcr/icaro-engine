# docs

Design notes, reviews and research. Most are snapshots taken at a past revision:
check their claims against the code before relying on them. Status sections are
updated by a docs PR after a batch of work merges, not by each feature PR (see
AGENTS.md, Git workflow).

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
  Cloudflare. Its claims about this repository were rechecked on 2026-11-26; the
  Cloudflare facts were not, and can change.
- `always-on-hosting.md`: hosting multiplayer without the home Mac (Containers,
  Durable Objects, VMs), with room memory/CPU/bandwidth measurements and the
  plan. Supersedes the recommendation in `cloudflare-multiplayer.md`, but its
  own recommendation (Containers) was not built, though some steps of its plan
  were: the project went with browser-hosted rooms instead. A snapshot.
- `browser-hosted-rooms.md`: design for rooms hosted in a player's browser tab
  and joined over WebRTC, with a Durable Object lobby for signalling. Built
  through PR 5 (the menus); its status line says what has been checked in a
  browser.
- `mobile-roadmap.md`: mobile-friendliness review (controls, rendering, offline,
  lifecycle, networking, competitive landscape) with confirmed bugs and a ranked
  roadmap; its status section lists the items built since. A snapshot; nothing
  in it was tested on a device.
- `agent-interface.md`: research and plan for making the engine playable by LLM
  agents and RL (lockstep clock, text observations, macro actions, MCP/Gymnasium
  adapters). Phase 1 (`src/agent.js`) is built, and so are headless play, the
  stdio MCP server, seeded randomness, the navigation graph (`src/nav.js`, built
  offline by `tools/nav/nav_build.js` and at map load in agent games) and the
  `goto` macro; its status section says what isn't. A snapshot.
- `style-cleanup-plan.md`: plan to adopt `deno fmt` (two-space indent, 80
  columns) and collapse the C-style comment banners, with trial results, tiers,
  neutrality checks and how open PRs catch up. Its status line says which tiers
  are done.
