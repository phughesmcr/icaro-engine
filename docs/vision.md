# Vision

Icaro is a multi-platform game engine for the modern web. It runs Quake, but it
is meant as a general-purpose engine for building multi-platform indie games: an
engine that runs Quake, rather than a Quake engine. It was forked from
`mrdoob/three-quake`, a JavaScript and Three.js port of the C code of
WinQuake/QuakeWorld.

## Goals

- **Quake compatible.** It runs these without issues:
  - the original shareware and retail games (`pak0.pak` and `id1/`);
  - the official mission packs, Scourge of Armagon (`-hipnotic`) and Dissolution
    of Eternity (`-rogue`);
  - Quoth (`-quoth`);
  - the official 2021 rerelease (KEX) content, including the 2026 update
    (`rerelease/`);
  - LibreQuake.
- **Mod compatible.** It supports what modern maps and mods assume. In practice
  QuakeSpasm-level support is the bar, including protocols 666 (FitzQuake) and
  999 (RMQ).
- **Its own standard, later.** Icaro will define its own protocol and features
  for Icaro games, while still supporting the range of Quake mods.
- **Multiplayer without subscriptions or memberships.** Old-school play through
  modern technology: WebRTC, WebSockets, WebTransport, peer to peer.
  - A secure, fast, stand-alone peer-to-peer server: start a match on a phone,
    and a friend joins from a laptop with just a link.
  - A hosted lobby: a permanent set of servers on Cloudflare, run by the
    project.
  - Only Icaro clients and servers talk to each other. Joining a native engine's
    server is not a goal.
- **Configuration through the URL.** `autoexec.cfg`-style settings (see
  [quakestarter's annotated example](https://github.com/neogeographica/quakestarter/blob/main/id1/autoexec-cfg-example-annotated.txt))
  through URL search parameters, limited to settings that are safe to accept
  from a shared link.
- **Many inputs.** Touch, keyboard and mouse, XR.
- **Where it runs.** In the browser at https://quake.anglezarke.games, and as a
  desktop executable (client and server) built with
  [Deno Desktop](https://docs.deno.com/runtime/desktop/) (CEF backend), which
  supports the original command-line features such as `-hipnotic` as well as
  every engine feature.
- **Modern code.** ES2026 and later, written for V8; a Vite bundle step if it is
  needed; eventually TypeScript.

## Content

LibreQuake is to become the standard content. Retail Quake and the rerelease are
here for compatibility testing only and are never committed or served publicly
(see AGENTS.md, Game data).

## Fidelity

Each layer of the engine follows its own reference (AGENTS.md, Compatibility and
fidelity): id's C for vanilla Quake, QuakeSpasm and Ironwail for the community
standard, Ironwail for the rerelease, and none for Icaro's own features.

## Plans, in order

1. A really good single-player Quake and mod-compatible engine that runs in the
   latest desktop Chrome.
2. Multiplayer that works really well.
3. Performance: rendering and more.
4. Agent accessibility: MCP and the agent API.
5. Mobile: performance, multiplayer, UI (a new HUD).
6. A Three.js deep dive: elite-level Three.js code.

## Source ports to learn from

- [NakedWinQuake](https://github.com/atsb/NakedWinQuake)
- [ChocolateQuake](https://github.com/Henrique194/chocolate-quake)
- [QrustyQuake](https://github.com/cyanbun96/qrustyquake)
- [QuakeSpasm](https://github.com/sezero/quakespasm)
- [Ironwail](https://github.com/andrei-drexler/ironwail)
- [Quakespasm-Spiked](https://github.com/Shpoike/Quakespasm)
- [JoeQuake](https://github.com/j0zzz/JoeQuake/)
- [FTEQW](https://github.com/fte-team/fteqw): the source of most extensions
  modern mods test for, and it already runs in the browser.
- [DarkPlaces](https://github.com/DarkPlacesEngine/DarkPlaces): the `DP_*`
  extensions.
- [vkQuake](https://github.com/Novum/vkQuake)
