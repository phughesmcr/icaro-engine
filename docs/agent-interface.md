# Agent interface: research and plan

Research notes, 2026-11-25, written at `dev` `ad9a0fb`. The goal is to make
Icaro the easiest Quake engine for LLM agents (Claude in a browser, Claude Code,
other MCP clients) to drive, and a good RL environment in the ViZDoom mould. It
must stay fast and keep observations cheap in tokens. Like the other docs, it is
a snapshot, so check engine claims against the code.

## Status

Phase 1 is built: `src/agent.js`, exposed as `window.icaro` by `main.js`
(`icaro.help()` prints the usage). How it differs from the design below:

- Buttons go through the client's own `+forward`/`-forward` commands with a
  reserved key number, and look changes write `cl.viewangles`. So there is no
  hook in `CL_SendCmd`.
- Events come from two hooks, `Con_SetAgentHook` (`src/console.js`) and
  `SCR_SetAgentHook` (`src/gl_screen.js`), plus stat changes compared after each
  tic. There is no hook in `cl_parse.js`.
- Lockstep pins `host_framerate` to 1/72 (and `host_maxfps` to 72,
  `host_timescale` to 0), restoring them on detach. Each `Host_Frame` therefore
  advances exactly one tic.
- Measured in the browser pane on e1m1 in lockstep: `new_game` took 85 ms, and
  72 tics with rendering took about 90 ms (13x real time).
- With a local server, the entity list adds monster health, door, button and
  lift kinds, and the level's exits and teleporters. Secret triggers are left
  out as spoilers.
- The `map` tier: `observe({ map: 21 })` (also an option of `step`, `goto`,
  `turn_to` and `attack`, and of those MCP tools and `observe`) adds an ASCII
  grid of 32-unit cells, 5 to 41 across, turned freely with the view so the
  player is `^` at the centre facing up (the grid is resampled, not snapped to
  90 degrees). `Agent_Map()` returns an object with the rows for programs.
  Floors come from the walk graph's cell index (the node nearest the player's
  height: level, a ledge up to 64 units above, or a drop down to 256), walls and
  liquids from hull 0 point contents, and closed doors, lifts and `func_wall`s
  from the client's brush entity boxes. Only cells a flood from the player's
  cell reaches (a hull 0 trace between neighbours) are drawn, so rooms behind
  walls stay blank. Entities in the latest update are glyphs (`M` monster, `i`
  item, ...). With a local server and `truth`, brush entities get their kind
  (`D`, `L`, `B`; a secret door stays `#`) and exits and teleporters are drawn;
  without it every brush entity is `#`. A 41x41 map takes about 0.4 ms headless;
  the text form cuts blank rows and columns. `tests/agent_map_test.js` covers it
  on LibreQuake's lq_e1m1 and lq_e1m2.
- The `screen` tier, in the browser only (#246): `icaro.screenshot( width )` (a
  JPEG data URL) and
  `icaro.screen_rgba( width = 84, height = 0,
  overlay = true )`
  (`Agent_ScreenRGBA`), which returns `{ width, height,
  data }` with RGBA
  bytes of the 3D view and, unless `overlay` is false, the 2D overlay, scaled to
  the size asked for (height 0 keeps the view's aspect; each side is clamped to
  16–1920). The headless server has no renderer, so the MCP `screenshot` tool
  always returns an error that names these two calls. The PR measured a 4-tic
  step plus `screen_rgba(84)` at about 6.8 ms.
- Not built yet: the `rl` tier's pixel buffers (depth and per-pixel label render
  targets; `rl` below is numeric), the `use` macro, the render-skip flag, labels
  for the options menu, `/agent.md` or `llms.txt` and its `<meta>` link (only
  the hidden line in `index.html` exists), and the adapters other than
  `window.icaro`, the stdio MCP server and the Gymnasium env (below): WebMCP,
  the accessibility mirror and the MCP server's HTTP transport.

Parts of phases 2 and 3 are built too (status checked against the code at `dev`
`694b2cc`; measurements are the PRs', not rerun):

- Headless play: `server/headless_host.js` runs the host, a local server and a
  loopback client under Deno with no rendering (#191). Its header gives the
  usage.
- MCP server: `server/agent_mcp.ts` (stdio, `deno task agent-mcp`) runs the
  headless host in lockstep and exposes `start`, `step`, `goto`, `turn_to`,
  `attack`, `observe`, `rl_spec`, `rl_step`, `cmd`, `key`, `menu` and
  `screenshot` (`step`, `goto`, `turn_to`, `attack` and `observe` take `map`;
  `screenshot` always errors, see above). Each result is the text observation
  plus `tic=N hash=H` (tics since `start`, and `Agent_StateHash`, a hash of the
  server's edicts and the client's stats). `start` with a `seed` turns on both
  determinism hooks below, with a virtual clock that advances one tic per frame;
  without one they are off. It is built on the official MCP TypeScript SDK
  (`@modelcontextprotocol/server` 2.4.0, pinned in `deno.lock`), whose
  `serveStdio` serves both the initialize-based versions (2024-11-05 to
  2025-11-25) and 2026-07-28. It has no Streamable HTTP transport or `act` yet;
  the SDK's `createMcpHandler` is the way to add HTTP. `tests/agent_mcp_test.js`
  replays a seeded action log (moving, firing, a console command) against the
  process's first game and gets the same hash.
- Determinism: `Sys_SetRandomSeed` and `Sys_SetClockOverride` in `src/sys.js`
  seed the gameplay randomness and override the clock, both opt-in.
  `tests/determinism_test.js` checks them (#190).
- `turn_to( id | { yaw }, { ents, map } )` and
  `attack( id, { max_tics, stop_on_enemy, ents, map } )`: in `src/agent.js`
  (`Agent_TurnTo`, `Agent_Attack`, and the MCP `turn_to` and `attack` tools).
  Look changes in this API are immediate, so `turn_to` sets the view at once
  (yaw and pitch at the entity's centre) and doesn't advance the game. `attack`
  (lockstep only) aims at the target's centre every tic and holds fire while a
  hull 0 trace from the eye reaches it. It doesn't move. The first line of the
  result is `killed` (with a local server: the monster's health, or its edict
  freed or gibbed), `gone (not in view)` (36 tics out of the client's updates),
  `out of sight` (36 tics with no line of sight), `out of ammo`,
  `out of reach (axe only ...)` (beyond 80 units with only the axe),
  `new enemy #id ...` (see `goto`), `died`, `level changed`,
  `level done (intermission)` or `timeout` (default 10 s). The kill check runs
  first, so a killing shot reads `killed`. It aims for the agent, so it is aim
  assistance; the benchmark profile that would turn it off isn't built.
  `tests/agent_attack_test.js` covers both on LibreQuake's lq_e1m2.
- Navigation: `src/nav.js` builds a walk graph from the BSP and answers A* path
  queries; `tools/nav/nav_build.js` builds graphs offline (#194). `src/agent.js`
  builds one on each level event while an agent is attached
  (`Agent_NavGraph()`), with the server's skill and deathmatch filters.
- `goto( id | [x, y, z], { max_tics, stop_on_damage, stop_on_enemy, ents, map } )`:
  in `src/agent.js` (`icaro.goto`, and the MCP `goto` tool), lockstep only. It
  follows the graph's path one tic at a time: yaw toward the next waypoint,
  `forward` held, jump tapped on jump links, swim up on swim links, standing
  still while a plat rises. The first line of the result is one of `arrived` (an
  item by id also arrives when it is picked up),
  `blocked by #id
  <kind> at x,y,z (...)`, `took damage (-N hp), stopped`,
  `new enemy #id <entity line>, stopped`, `died`, `level changed`,
  `level done (intermission)`, `no path` or `timeout`. Stuck means 36 tics
  without getting 8 units closer to the waypoint (144 on door and plat links);
  goto hops, then replans, then reports blocked. A blocked report names a
  monster in the way, or the graph's entity on the link with how it opens (a
  key, `button #id`, shoot it), and the next goto avoids that entity's links
  until it moves (or the level changes). Damage means a `svc_damage` message
  (`cl.faceanimtime` moved) with a health drop, so megahealth wearing off
  doesn't stop it. A new enemy (#237) is a live monster coming into sight: in
  the client's latest update, a hull 0 trace from the eye reaches its centre
  with no brush entity box in between (with a local server and `truth`, corpses
  are skipped). Each monster is announced once per level, monsters in sight when
  the macro starts count as known, the macro's own target is never reported, and
  `(+N more)` counts others that appeared on the same tic.
  `stop_on_enemy: false` turns it off (on `attack` too). Not built: realtime
  mode. `tests/agent_goto_test.js` covers it on LibreQuake's lq_e1m1 and
  lq_e1m2; before the tests moved to LibreQuake, a scripted id1 e1m1 run with
  god and notarget (goto the exit; on a block, press the named button or shoot
  the monster) reached the far water rooms but not the exit. Stalls left: from
  inside, the shoot-to-open secret door #50 doesn't open to shots, and door #65
  is "opened by a trigger elsewhere" (its trigger isn't in the graph's
  activators).
- The `rl` tier (#243), the "RL TIER" section of `src/agent.js`:
  `icaro.rl_spec( opts )`, `rl_observe( opts )` and
  `rl_step( action, tics = 4, opts )`, and the MCP `rl_spec` and `rl_step`
  tools. It is numeric, not the design's render targets:
  - `rl_spec` gives the layout (`version: 1`): each field's name, offset, size,
    bounds and classes, the map glyph codes, the action components and the
    default reward weights. Adapters build their spaces from it.
  - The observation is one reused `Float32Array`: 41 status values (health,
    ammo, weapons, items, flags, position, velocity, facing, kills and secrets,
    time); the nearest `ents` entities (default 16, up to 64), egocentric, each
    with present, class, forward, left, up, dist, visible and hp (−1 without
    `truth`); `rays` horizontal world-trace distances (default 32, up to 128;
    entities don't block them); and, with `map`, the map tier's grid as glyph
    codes. `truth: false` hides hp and what only the server knows.
  - The action is 8 integers: move, strafe, turn, look, attack, jump, speed and
    weapon (an impulse). Buttons stay held between steps and are released when
    the episode ends. Lockstep only, serialized with the macros.
  - The reward is per step: kill, secret, hurt (per hp lost), death, exit and
    tic, each overridable with `opts.reward`. It doesn't consume the event log.
    `why` is `died`, `level done`, `level changed` or `level restarted` when the
    episode ends.
  - The PR measured about 2,600 steps/s headless at 4 tics a step, and about 43
    µs an observation (101 µs with a 21x21 map). `tests/agent_rl_test.js` covers
    it; the `secret` weight, weapon impulses, the strafe and look signs and held
    buttons have no test.
- Gymnasium env (#244): `tools/gym/icaro_env.py` (Python: gymnasium, numpy and
  Deno; not linted or run in CI). Each env starts its own `server/agent_mcp.ts`
  and speaks MCP JSON-RPC over stdio to it, not the framed protocol the design
  below planned. Its spaces (`Box`, `MultiDiscrete`) come from `rl_spec`;
  `reset` is `start` plus a 0-tic `rl_step`, and `step` returns Gymnasium's
  5-tuple. Its header gives the run line. The PR measured about 2,000 steps/s on
  a random id1 e1m1 episode (its default map is now LibreQuake's lq_e1m1). Not
  done: vectorised envs (`AsyncVectorEnv` is untried), ViZDoom-style scenario
  `.cfg` files, and a training run.

Confidence labels on outside claims: **[V]** read on a primary source, **[S]**
secondary source or search summary, **[U]** unverified. Claims about this engine
were checked in the code or measured in a browser (see "Measured here").

## Recommendation in brief

Build one engine-side core, `src/agent.js`, and put thin adapters on it.

1. **Agent-held clock.** The game advances only when the agent calls `step`, so
   thinking time costs nothing. This is ViZDoom's sync mode and doom-mcp's
   "virtual time". It is the single most important property: pixel agents
   playing in real time scored 0% on Doom II in VideoGameBench [S]. It works
   now: see "Measured here".
2. **Tiered observations, text first.** A one-line status plus an egocentric
   entity list is the default, at roughly 20 to 60 tokens. An ASCII map, the
   menu and console, a small screenshot, and RL buffers (depth, labels) are
   opt-in.
3. **Events since the last call** (damage, pickups, centerprints, console lines,
   deaths, level changes) instead of resending full state.
4. **Two action layers.** Low-level actions are buttons, look deltas and
   impulses held for N tics (DeepMind Lab and ViZDoom style). Macro actions are
   `turn_to`, `goto`, `attack`, `use` and `select_menu`, and they return
   step-by-step outcomes. Failures say what to try next ("blocked by door #42:
   try use").
5. **Adapters**, in order of value:
   - a `window.icaro` JS API, which any browser agent with a JavaScript tool can
     use today, including this app's browser pane and Claude in Chrome;
   - an MCP server on Deno, headless and uncapped, for Claude Code and other MCP
     clients;
   - a Gymnasium bridge for RL;
   - WebMCP tool registration, feature-detected;
   - an `aria-live` text mirror and DOM menu for accessibility-tree agents and
     screen-reader players.

## Measured here

These were run in this app's browser pane on `localhost`, on id's shareware pak0
(which the repository shipped then, so the maps are id1's), with the page's
existing `window.cl`/`cls`/`sv` debug globals.

- **Accessibility tree is empty.** `read_page` on the running game returned
  "(empty page)". An agent that reads the page structure sees nothing, so it is
  left with screenshots or JavaScript today.
- **Agent stepping works with no engine change.**
  - Procedure: `map e1m1`, then `renderer.setAnimationLoop( null )`, then
    `Host_Frame( 1/72 )` called synchronously in a loop.
    `import(
    '/src/host.js' )` resolves to the same module instance
    `main.js` uses.
  - Result: 2,358 `Host_Frame` calls in 1.0 s of wall time, and `cl.time`
    advanced by 2358 / 72 s, which is 33x real time.
  - Not shown: that every call simulated and rendered a frame. A call that
    `_Host_FilterTime` rejects (`src/host.js:816`, the `host_maxfps` gate at
    `:827`) rolls its time into the next call, so the `cl.time` total matches
    either way, and `1/72` sits right on the gate's edge. Whatever rendering
    happened was queued GPU work, not presented or read back. Throughput with
    readback will be lower and is not measured.
- **Compact observation size.**
  - The status line
    `e1m1 t35.9 hp100 ar0 sh25 | #108 maps/b_shell0.bsp 1073u R3` is 59
    characters, about 20 tokens. Mapping file names to kinds (`shells`) would
    shorten it.
  - The same data as JSON (stats array, origin, angles, entity tuples) is 153
    characters, about 50 tokens.
  - A 1024x768 screenshot costs about 1,050 tokens by Anthropic's `w*h/750`
    image estimate, which is 20 to 50 times more. A 320x240 screenshot is about
    100 tokens.
  - e1m1's start had only one entity in the PVS. A busy room will be longer, so
    cap the list (nearest 10) and report how many were left out.
- **Navigation data exists for id1 maps.** The 2021 rerelease's `pak0.pak` ships
  51 bot navigation files, `bots/navigation/*.nav`, magic `NAV2`. They cover
  e1m1 to e4m8, dm1 to dm8, start, end and test maps. The format is undocumented
  here [U]. This is commercial data, so it can only be loaded at runtime from a
  user's own copy and never committed.

## Prior art and lessons

| Source                                                                                                                                                                                            | What it gives the agent                                                                                                                                                                                                                                                                                             | Lesson for us                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ViZDoom [V] ([API](https://vizdoom.farama.org/api/python/doom_game/), [releases](https://vizdoom.farama.org/release_notes/index.html); 1.3.3, 2026-11-22)                                         | Sync and async modes; `make_action(a, tics)` frame-skip; buffers for screen, depth, labels, automap, `objects_info`, `sectors_info`, audio and notifications; game variables; scenario `.cfg` files; Gymnasium environments                                                                                         | Copy the shape: sync stepping, opt-in buffers, ground-truth side channels, cfg scenarios, Gymnasium. The `objects`/`labels` buffers are the RL version of our entity list      |
| DeepMind Lab [V] ([Python API](https://github.com/google-deepmind/lab/blob/master/docs/users/python_api.md), [actions](https://github.com/google-deepmind/lab/blob/master/docs/users/actions.md)) | Quake III based. Seven integer actions (look x/y in pixels, strafe, move, fire, jump, crouch); `step(action, num_steps)`; observations by name (`RGB`, `RGBD`, `DEBUG.POS.TRANS`, `VEL.*`, `INSTR`); `events()` since the last call; Lua level scripts                                                              | The closest precedent: a Quake engine as an environment. Its action spec maps almost exactly onto `usercmd_t`, and its named-observation and `events()` design is what we want |
| doom-mcp [V] ([post](https://dev.to/gunnargrosch/can-it-run-doom-playing-doom-in-claude-code-with-doom-mcp-1ck1), [repo](https://github.com/gunnargrosch/doom-mcp))                               | Three tools: `doom_start`, `doom_action("forward,fire", ticks)` and `doom_screenshot` (320x200). Each action returns a status line plus enemy lines such as "Imp (HP:60) to your left (turn_left ~9) nearby" and "Door AHEAD (use to activate)". Line-of-sight uses `P_CheckSight`. The game runs only during calls | Few, coarse tools. Relative-direction text with a suggested action. No pathfinding, so the model steers by hand                                                                |
| CData DooMCP [S] ([blog](https://www.cdata.com/blog/doom-mcp-server))                                                                                                                             | `look`, `go_to` and `attack`. Failures suggest the next step                                                                                                                                                                                                                                                        | Macro verbs and corrective error text. Its cost figures ($0.07 to $0.78 per level, god mode) are anecdotal                                                                     |
| VideoGameBench [S] ([paper](https://arxiv.org/pdf/2505.18134))                                                                                                                                    | Raw pixels in real time. Frontier VLMs scored 0% on Doom II. The Lite variant pauses while the model thinks                                                                                                                                                                                                         | Real-time pixel play is the wrong default                                                                                                                                      |
| BALROG [S] ([paper](https://arxiv.org/pdf/2411.13543)), Agentick [V] ([paper](https://arxiv.org/html/2605.06869))                                                                                 | Text and ASCII maps by default. Adding images often hurt. ASCII beat prose in Agentick's Qwen runs, and a short reasoning step before acting helped 3 to 10 times                                                                                                                                                   | Text first. Images and ASCII maps on demand                                                                                                                                    |
| Claude/Gemini Plays Pokémon [S] ([1](https://latent.space/reading/claude-plays-pokemon/), [2](https://michaelyliu6.github.io/posts/claude-plays-pokemon))                                         | Harnesses grew a knowledge-base or notes tool, a navigator tool, and overlays parsed from memory                                                                                                                                                                                                                    | Navigation and memory help more than extra perception. Give `goto` and a notes slot                                                                                            |
| Orak [S] ([paper](https://arxiv.org/html/2506.03610v3))                                                                                                                                           | Each game is an independent MCP server                                                                                                                                                                                                                                                                              | MCP is already the benchmark packaging                                                                                                                                         |
| SIMA 2 [S] ([blog](https://deepmind.google/blog/sima-2-an-agent-that-plays-reasons-and-learns-with-you-in-virtual-3d-worlds/), 2025-11)                                                           | Pixels and keyboard/mouse only                                                                                                                                                                                                                                                                                      | The pixel path should exist (screenshot plus low-level actions), but it is not the efficient path                                                                              |

I found no published Quake-specific LLM-agent project or MCP server (one search,
[S]), and no paper measuring token cost across observation formats. Searches on
Mineflayer, MineDojo, Lumine, Melting Pot, PettingZoo, lmgame-bench, `llms.txt`
and Chrome's built-in agent features returned nothing usable, so the table is
not a complete survey. The 59- and 153-character figures above are our own.

### Interface standards (late 2026)

- **WebMCP** [S]
  ([1](https://richdevtools.com/articles/web/webmcp-origin-trial),
  [2](https://missiongrowth.io/blog/webmcp),
  [3](https://mcpplaygroundonline.com/blog/what-is-webmcp)):
  - Status: an origin trial from Chrome 149. Local testing works via
    `chrome://flags/#enable-webmcp-testing`. The spec is a W3C Community Group
    draft.
  - API:
    `document.modelContext.registerTool( { name, description,
    inputSchema, execute, annotations } )`.
    The older `navigator.modelContext` is deprecated from Chrome 150, so
    feature-detect both. Tools are removed by aborting the signal they were
    registered with.
  - Trial end date: sources conflict (Chrome 156 or 162).
  - Consumers: I found no source showing Claude consuming WebMCP tools.
  - Use: a cheap, optional adapter. Not the base layer.
- **MCP** [S]:
  - Version: 2026-07-28 is reported as current.
  - Transport: stateless Streamable HTTP. HTTP+SSE is deprecated. The 2025-11-25
    spec is still valid.
  - MCP Apps (interactive HTML in a sandboxed iframe) is final.
  - Fit: an MCP server is how Claude Code and Claude desktop would play without
    a browser. An MCP App could also show the live game inside the chat while
    tools drive it.
- **JavaScript in the page** [V, measured]: this app's browser pane and Claude
  in Chrome both have a JavaScript tool. A documented `window.icaro` object
  works with them today and needs no browser flag.

## Design

### Core: `src/agent.js`

This is a web-only addition, like `in_web.js`.

- It must not touch `window` or `document` at import, so the Deno server and
  tests can load it.
- It holds all agent logic. The ported files get only small hooks: an event
  push, an action-merge call, a clock override. Hooks follow AGENTS.md rules:
  - C names stay.
  - No allocation in per-frame paths. Use ring buffers and preallocated scratch.
  - A hook costs a single `null` check when no agent is attached.

### Clock modes

- **`realtime`** (default): the existing `renderer.setAnimationLoop` loop
  (`main.js:213`).
- **`lockstep`**: the agent owns time.
  - `agent_attach( { mode: 'lockstep' } )` stops the animation loop.
  - `step( action, tics )` runs `tics` host frames, then returns the
    observation. Each must be exactly one tic, so `step` sets the frame time
    itself (`host_framerate`, or a bypass of `_Host_FilterTime`) rather than
    relying on `Host_Frame( 1 / 72 )` passing the `host_maxfps` gate.
  - `step` must be async. Map loads fetch files with promises (`COM_EnsureFile`
    in `src/host_cmd.js:1534` and `src/cl_parse.js:419`), so `map` and
    `changelevel` finish across event-loop turns. `step` should wait for the
    level to be ready before counting tics.
  - This removes the dependence on `requestAnimationFrame`, which browsers
    throttle or stop in background tabs. That matters when an agent drives a
    hidden pane or tab.
  - Rendering can be skipped on non-final tics (ViZDoom's
    `update_state =
    false`) with a flag checked around `SCR_UpdateScreen`
    (`src/host.js:711`).
- **Determinism**, for RL and reproducible bug reports:
  - **Clock.** `Sys_FloatTime` reads `performance.now()` (`src/sys.js:314`).
    Lockstep needs a virtual clock behind it.
  - **RNG.** `Math.random` is used by QuakeC `random()` (`src/pr_cmds.js:459`),
    monster movement (`src/sv_move.js:382`, `403`, `474`), particles and temp
    entities. `tools/bench/net_bench.js` already replaces `Math.random` with a
    seeded generator, so reuse that approach behind a `seed` option.
  - Gameplay determinism only needs the server-side calls seeded. The
    client-side calls are cosmetic.
- **Multiplayer rooms** run in real time on the server, so lockstep is
  single-player (and local listen server) only. Against a room, the agent can't
  pause anything. Macro actions that run on the client over several frames are
  the only help there.

### Observations

Each tier is opt-in per call: `observe( { tiers: [ ... ] } )`. Every result
carries `tick` and a short state hash, so an agent can tell that nothing changed
and skip rereading.

| Tier     | Content                                                                                                                                                                                            | Approx. size           | Source                                                                                     |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------ |
| `status` | map, time, health, armour, ammo, weapon, keys and powerups (`cl.stats`, `cl.items`), facing, on-ground or in-water, intermission                                                                   | ~20 tokens             | `src/client.js:279`                                                                        |
| `ents`   | nearest N entities, egocentric: id, kind, distance, bearing L/R, up/down, visible flag, hp if known                                                                                                | ~5 to 10 tokens each   | `cl_entities` and `cl.model_precache` names, plus a line-of-sight trace                    |
| `events` | damage taken (from `svc_damage`), pickups, centerprints (`SCR_CenterPrint`, `src/gl_screen.js:149`), console and notify lines (`Con_Printf`, `src/console.js:407`), deaths and kills, level change | varies                 | ring buffer with a cursor                                                                  |
| `map`    | egocentric ASCII grid (for example 21x21 cells of 32 units, player at centre and facing up), with walls from hull traces and entity glyphs                                                         | ~150 to 250 tokens     | world model hull traces (`SV_Move`, `src/world.js:1444`, or pmove traces)                  |
| `ui`     | current menu name, items as text, cursor; console visible or not; last N console lines                                                                                                             | ~30 tokens             | `m_state` (`src/menu.js:105`), plus the cursor getter `M_AgentState` (`src/menu.js`)       |
| `screen` | PNG or JPEG of the composited 3D canvas and 2D overlay at a chosen size                                                                                                                            | ~100 tokens at 320x240 | read back right after render, since there is no `preserveDrawingBuffer` (`src/vid.js:211`) |
| `rl`     | typed arrays: RGB, depth, per-pixel entity-id labels, automap                                                                                                                                      | binary                 | render targets. None exist yet; `gl_rmirror.js` already uses a depth render target         |

Points about the tiers:

- **Kinds, not file names.** Map `progs/soldier.mdl` to `grunt` and
  `maps/b_shell0.bsp` to `shells`, with one table per game (id1, hipnotic,
  rogue). Health per entity is server-only knowledge (see "Fair play").
- **Text format.** The default is one line per item with fixed field order, not
  pretty JSON. A `format: 'json'` option serves programmatic clients.
- **Ground truth.** When `sv.active` (single player or listen server), the
  `ents` and `map` tiers may read server edicts (classname, health) directly.
  Against a remote room they must use only what the client received (see "Fair
  play").

### Actions

- **Low-level**, mapped onto the existing input path:
  - **Format:**
    `{ buttons: 'forward,attack', yaw: -15, pitch: 0, impulse:
    7, tics: 8 }`.
  - **Buttons:** the agent sets `kbutton_t` state (`in_forward` and the others,
    `src/cl_input.js:75-93`).
  - **Look and impulse:** the agent adds view-angle deltas and the impulse
    between `CL_BaseMove` and `CL_SendMove` in `CL_SendCmd`
    (`src/cl_main.js:1470-1476`).
  - **Result:** the server sees an ordinary `usercmd_t`, so NQ physics are
    untouched.
  - **Granularity:** tics are 1/72 s, matching `host_maxfps`.
- **Macro**, implemented in `agent.js` as small client-side controllers that
  issue low-level actions each tic:
  - `turn_to( id | yaw )`: closed-loop turning toward a target.
  - `goto( id | xyz, { max_tics } )`: a path from the nav graph, followed with
    stuck detection. Returns `arrived`, `blocked by #id (door: try use)`,
    `took damage, stopped`, or `timeout`.
  - `attack( id )`: turn to the target, then fire until it is dead, out of sight
    or out of ammo.
  - `use()`: Quake has no use key, so this walks into a button or door.
  - `select_menu( 'New Game' )`, `console( 'map e1m2' )`, and
    `new_game( { map, skill } )`.

  Each macro stops early on an interrupting event (damage, new enemy) and
  returns it. The model replans from one line of text instead of watching
  frames.
- **Fair-play switch.** A `benchmark` profile disables aim assistance (`attack`
  only fires straight ahead, and the agent aims with `turn_to` or deltas) and
  hides server-only fields. Scores from different agents are only comparable
  within one profile.

### Navigation (the hard part)

The working Doom harnesses either have no pathfinding (doom-mcp) or don't
document it. A useful `goto` needs a graph. Options, in order:

1. **Generate per map from the BSP**, offline in Deno, and cache it as JSON:
   - sample walkable points on floor faces (plane normal z > 0.7);
   - snap them to a grid;
   - link neighbours whose player-hull trace succeeds within step height (18
     units) and drop height;
   - mark links that cross `func_door`, `func_plat`, teleporters and buttons.

   This works for every map, including LibreQuake's and custom maps. It is the
   real work item.
2. **Load the rerelease's `bots/navigation/<map>.nav`** when the user's own
   rerelease data is present. The format must be reverse-engineered, and it only
   covers id1 maps.
3. **Fallback.** Steer straight toward the target with stuck detection, using
   the monster logic in `sv_move.js` (`SV_StepDirection`) as a model. This is
   enough for "go to that visible item" with no graph.

### Adapters

- **`window.icaro`**, browser.
  - Calls (as built): `help()` returns the usage text. Also `attach( mode )`,
    `detach()`, `mode()`, `new_game( map, skill )`,
    `step( action, tics, opts )`, `goto( target, opts )`,
    `turn_to( target, opts )`, `attack( id, opts )`, `observe( opts )`,
    `rl_spec( opts )`, `rl_observe( opts )`, `rl_step( action, tics, opts )`,
    `cmd( text )`, `key( name )`, `menu( label )`, `screenshot( width )` and
    `screen_rgba( width, height, overlay )`. Events come back inside each
    observation. Of the macro actions `goto`, `turn_to` and `attack` are built
    (no `act`).
  - Typical use: one `javascript_tool` call does `icaro.step(...)` and gets the
    next observation back, so each turn is one round trip.
  - URL flags (as built): `window.icaro` is always present. `?agent=lockstep` or
    `?agent=realtime` attaches at startup, and `?map=lq_e1m1&skill=1` starts
    that map instead of the intro demos, once a person (or the agent) presses
    the intro page's Play button (`src/intro.js`; no game data loads before it).
  - Discovery: serve a short `/agent.md` (or `llms.txt`), and link it from a
    `<meta>` tag and a visually hidden line in `index.html`, so an agent landing
    on the page can learn the API in one read.
- **MCP server on Deno** (`server/agent_mcp.ts`):
  - Runs the same core headless, with stdio and Streamable HTTP transports.
  - Tools stay few and coarse, as in doom-mcp: `start`, `step`, `act`, `observe`
    and `screenshot`. Each returns the default text observation. As built, the
    headless `screenshot` returns an error instead (see Status).
  - The headless loopback client this needed is built
    (`server/headless_host.js`), and the stdio server is (`server/agent_mcp.ts`;
    see Status).
  - Without rendering, the `screen` and `rl` pixel tiers are unavailable, but
    the text tiers work, and this is where uncapped speed matters.
- **Gymnasium bridge** (`tools/gym/`, Python):
  - Shape: a `gymnasium.Env` speaking framed JSON or binary over stdio to a Deno
    process per environment. Vectorise with `AsyncVectorEnv`, since this repo
    already runs one process per room. As built (see Status), it speaks MCP
    JSON-RPC to one `server/agent_mcp.ts` per env.
  - Names: ViZDoom's (`make_action`, buffers, scenario `.cfg` files with map,
    skill, buttons and reward variables).
  - Reward: from stat and event deltas (kills `STAT_MONSTERS`, secrets, damage,
    death, level exit).
- **WebMCP**: register the same tools on `document.modelContext` or
  `navigator.modelContext` when present. Use `readOnlyHint` for `observe`. It is
  a few dozen lines once the core exists.
- **Accessibility mirror**:
  - Keep a visually hidden `aria-live="polite"` region holding the status line,
    centerprints and pickup messages.
  - When a menu is open, add a DOM list mirroring its items, with focus
    following `m_state` and the cursor.
  - This gives accessibility-tree agents, which today see "(empty page)",
    something to read. It is also real accessibility work for blind players.
    Throttle updates (on change, at most a few per second).

### Fair play and multiplayer

- On a public lobby, server-only tiers (edict health, entities outside the PVS,
  ASCII map through walls) are a wallhack. Gate them on `sv.active`, or on a
  server cvar the room host sets (for example an agent-friendly room flag).
- Bots on the public lobby should identify themselves, for example with a name
  prefix and a protocol flag. Whether to allow them is the maintainer's call.
- The server stays NQ-faithful. Nothing here changes `sv_phys.js` or
  `sv_user.js`.

## Engine touch points

| Need                     | Where                                                                                         | Change                                                                                                                                       |
| ------------------------ | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Clock override           | `main.js:213`, `src/sys.js:314`                                                               | lockstep driver; virtual `Sys_FloatTime`                                                                                                     |
| Seeded RNG               | `src/pr_cmds.js:459`, `src/sv_move.js`                                                        | route through a seedable generator (pattern in `tools/bench/net_bench.js`)                                                                   |
| Action injection         | `src/cl_main.js:1470-1476`, `src/cl_input.js:75-93`                                           | one hook between `CL_BaseMove` and `CL_SendMove`                                                                                             |
| Events                   | `src/console.js:407`, `src/gl_screen.js:149`, `src/cl_parse.js` (damage, stats, intermission) | push to a ring buffer when an agent is attached                                                                                              |
| Menu state               | `src/menu.js:38-63`                                                                           | export a read-only cursor getter and item labels per menu (the items are drawn as pictures, e.g. `gfx/mainmenu.lmp`, so labels need a table) |
| Render skip and readback | `src/host.js:711`, `src/vid.js:211`                                                           | skip-render flag; capture after render                                                                                                       |
| Debug globals            | `main.js:199-205`                                                                             | already exposes `cl`, `cls`, `sv` and `Cbuf_AddText`; `window.icaro` replaces these as the supported surface                                 |

## Phased plan

1. **Core and `window.icaro`**: clock modes, `status`, `ents` and `events`
   tiers, low-level actions, `ui` tier with menu text, `?agent=` flags,
   `/agent.md`. Test it by having Claude play lq_e1m1 through the browser pane.
2. **Headless MCP server**: prove a headless loopback client under Deno, then
   `server/agent_mcp.ts` (stdio). Add seeded RNG and a virtual clock, and a
   determinism test that replays an action log and compares a state hash.
3. **Navigation and macros**: BSP walk-graph generator, `goto`, `attack`,
   `turn_to`, and stuck and interrupt handling. Optionally the rerelease `.nav`
   loader.
4. **RL**: `rl` buffers (depth and label render targets), Gymnasium bridge,
   scenario files, vectorised benchmark.
5. **Extras**: WebMCP adapter, `aria-live` and DOM menu mirror, MCP App view,
   and fair-play controls for lobby rooms.

## Open questions

- Should the agent API be on in production builds, or only with `?agent=`? As
  built it is always on (it does nothing until called). It is cheap either way,
  but `window.icaro` widens what page scripts can do.
- Should agents be allowed on the public lobby, and how should they be labelled?
- Should the benchmark profile use NQ's or QW's view of other players?
  Prediction makes the client's picture differ slightly from the server's.
- Is the rerelease `.nav` format worth reverse-engineering, given the generated
  graph is needed anyway?
- What does Claude actually do best with: `ents` text, the ASCII `map`, or a
  small screenshot? Measure task success and tokens per level on lq_e1m1 now
  that phase 1 exists. That is the one number nobody has published.
