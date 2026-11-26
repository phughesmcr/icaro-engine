# Architecture plan: platform, core and game layers

A staged plan to move `src/` into three layers whose imports point only
downwards: `platform/` (browser, Deno and desktop I/O), `core/` (the engine any
id-Tech-1 game shares) and `games/quake/` (Quake's own client and server code,
and later other games such as Hexen II). It gives the target, a file-by-file
assignment, the edges that break the rule today, how to cut the import cycle
that pulls the renderer into the dedicated server, the duplicated state to
resolve, where TypeScript and a bundle step fit, and a sequence of PR-sized
steps.

Snapshot: measured on `dev` at bbcb183 (2026-11-26) with a throwaway
import-graph script that step 1 lands as `tools/layer_graph.js`. The script
parses every module in `src/`, `main.js` and `server/` with `@babel/parser` and
counts unique (importer, imported, kind) pairs; `import type` is ignored and
re-exports count. The audit's numbers (`docs/audit/architecture.md`, PR #251,
measured at 2798ac9 with another method) differ slightly; where they disagree,
this doc's are the current ones. Re-run the script before relying on a number.

It follows the agreed direction in the audit (decision 6, "three layers") and
the revised rules of PR #245: code may be restructured, but behaviour stays, and
so do the names content depends on: cvar and console command names, QuakeC
builtins and fields. It fits `docs/style-cleanup-plan.md`: tiers 0–3 are done,
and tier 4 (C idioms, fixed file by file when a PR already edits the file) never
rides in a move or split commit.

## Target

```
entry points   main.js, server/game_server.js, server/headless_host.js,
               server/agent_mcp.ts, server/lobby_server.js, ...
     |
games/quake/   Quake's client, server, HUD, menus, QuakeC builtins, protocol
     |
core/          files and paks, console, cvars, commands, QuakeC VM, net
     |         channel and loopback, sound mixer, model loading, renderer
platform/      browser (WebGL canvas, input, WebAudio, WebTransport, WebSocket,
               WebRTC, storage), Deno (QUIC, sockets, files), later desktop
```

Rules:

- A module may import its own layer or a lower one. Cycles inside a layer are
  allowed (the C has them: `console` and `keys` call each other), but each step
  in this plan should leave them no larger.
- Upcalls (a lower layer calling a higher one) go through hooks the entry point
  or a higher layer sets: the existing `*_SetExternals` and `*_SetCallbacks`
  functions (12 of them; `host.js` makes 7 of the calls), or a driver table as
  in the C's `net_win.c`. No new mechanism is needed.
- Core imports only target-neutral platform modules. The target-specific ones
  (`platform/browser/*`, `platform/deno/*`) are imported by entry points, which
  register them. That is what lets the dedicated server and the browser load the
  same core without `server/browser_shim.js`.
- Platform code that today registers cvars, prints to the console or opens menus
  does it through a front end one layer up that owns the cvars and commands; the
  platform module gets plain values and calls hooks. The C has the same split in
  places (`snd_dma.c` against `snd_win.c`, QuakeSpasm's `bgmusic.c` against
  `cd_sdl.c`, `net_dgrm.c` against `net_wins.c`).
- Only the renderer in core and the platform video module import `three`.
- File basenames stay, so the mapping to C files survives the moves
  (`src/core/cvar.js` is still `cvar.c`).

Directories, proposed: `src/platform/browser/`, `src/platform/deno/` (later
`src/platform/desktop/`), `src/core/`, `src/games/quake/`. The `server/` drivers
(`net_webtransport_server.ts`, `net_websocket_server.ts`, `quic_listen.ts`,
`client_address.ts`, `sys_server.ts`) are platform code but can stay in
`server/` until there is a reason to move them (open question 4).

## Measured state

- 94 files in `src/`, 109 in all; 632 unique static file pairs inside `src/`.
- Two import cycles: one of 52 modules and one of 4 (`cmd`, `common`, `cvar`,
  `pak`). Removing any single edge shrinks the 52-module cycle by at most 2
  modules (`pr_edict` → `pr_cmds` and `vid` → `console` each leave 50), so the
  cycle needs seams, not one cut.
- Most-imported: `common` 49 importers, `cvar` 33, `sys` 32, `quakedef` 30,
  `cmd` 30, `client` 24, `mathlib` 22, `protocol` 20, `host` 19, `pak` 17,
  `vid` 16.
- 171 `export let` bindings and 44 `set_*` setters. The audit (A3) recommends
  against rewriting this pattern, and this plan keeps it.
- 18 files import `three`: `vid`, `webxr`, `glquake`, `r_part` and 14 `gl_*`
  files.
- Dynamic imports: `server/agent_mcp.ts` → `headless_host`, `agent`, `pak`,
  `sys`, `cmd`; `chase` → `world`; `view` → `chase`.
- `server/game_server.js` reaches 97 modules (90 in `src/`), all 18 `three`
  files among them, through `gl_model.js`. `headless_host.js` reaches 90 and
  `agent_mcp.ts` 93. `lobby_server.js` reaches 18 (11 in `src/`) and no `three`.

## File-by-file assignment

The first layer named is where the file goes. Files marked _split_ hold code for
two layers and are split before they move (see Violations).

**platform/browser/** (17): `in_web` (split), `touch` (split), `touch_editor`,
`touch_layout`, `webxr`, `pwa_launch`, `turnstile`, `net_websocket`,
`net_webtransport`, `net_webrtc`, `net_rtclobby` (split), `vid` (split),
`gl_contextloss`, `cd_audio` (split), `autosave`, `userdata` (split), and `sys`
(split: its print and error hooks are target-neutral and stay importable by
core; its DOM code is browser-only).

**platform/deno/**, staying in `server/` for now: `net_webtransport_server.ts`,
`net_websocket_server.ts`, `quic_listen.ts`, `client_address.ts`,
`sys_server.ts`, and `browser_shim.js` until it is retired.

**core/** (46):

- Files and data: `common` (split, step 12), `pak`, `wad`, `image`, `crc`,
  `zone`, `mathlib`, `unicode_translit`, `bspfile`, `anorm_dots`.
- Console and commands: `cmd`, `cvar`, `console`, `keys`.
- QuakeC VM: `pr_exec`, `pr_edict`, `pr_comp`, `progs`, `pr_sprintf`.
- Net: `net` (split: the WebTransport and WebSocket framing goes to platform),
  `net_main`, `net_loop`.
- Sound: `sound`, `snd_dma`, `snd_mem`, `snd_mix`.
- Models and renderer: `gl_model`, `gl_md5`, `render`, `glquake`, `gl_rmain`,
  `gl_rsurf`, `gl_warp`, `gl_sky`, `gl_fog`, `gl_rlight`, `gl_refrag`,
  `gl_mesh`, `gl_draw`, `gl_rmisc`, `gl_entalpha`, `gl_screenwarp`, `gl_warmup`,
  `gl_rmirror`, `r_part`, `vid_dynres`.

**games/quake/** (31):

- Shared: `quakedef` (split: engine limits move to core), `protocol` (split:
  `ENTALPHA_*` move to core), `progdefs`, `pr_cmds`, `host`, `host_cmd`,
  `default_cfg`, `room_rules`.
- Client: `client`, `cl_main`, `cl_parse`, `cl_input`, `cl_demo`, `cl_tent`,
  `cl_pred`, `cl_reconnect`, `pmove`, `view`, `chase`, `gl_screen`, `sbar`,
  `menu`, `menu_cvars`.
- Server: `server`, `sv_main`, `sv_phys`, `sv_user`, `sv_move`, `world`.
- Agent: `agent`, `nav`.

**Entry points**: `main.js`, `server/game_server.js`, `server/headless_host.js`,
`server/agent_mcp.ts`, `server/lobby_server.js`,
`server/room_process_manager.ts`, and the lobby's pure helpers
`server/lobby_rtc.js`, `server/room_config.js`, `server/turnstile.js` (they
import nothing from `src/`; `lobby_server.js` imports only `net.js` and what it
reaches).

Placements worth a second look: `keys` (core, as `keys.c` is engine code, with
its menu and screen calls made hooks), `world` (game for now; its hull traces
are shared BSP code a second game could reuse), `r_part` (core, although its
effect functions are Quake's), and `agent`/`nav` (game, as they read Quake's
items and stats).

Other assignments were measured and gave fewer violations but put things in the
wrong place: the renderer in the game layer leaves 87 violating file pairs;
`quakedef`, `protocol` and `client` in core, 84; input in game and the net
drivers in core, 58. None removes the need to split mixed files.

## Violations

With the assignment above, 107 file pairs import upwards: platform → core 45,
core → game 40, platform → game 22. By importer: `in_web` 16, `touch` 9,
`net_webrtc` 7, `cd_audio`, `net_websocket`, `net_webtransport` and `pr_edict` 6
each, `userdata` 5, `gl_rmain` 4, `gl_rsurf` and `net_rtclobby` 3, then 26 files
with 1 or 2. By target: `client` 13, `quakedef` 10, `protocol` 7, `server` 7.
They fall into the seams below; the step that cuts each is given in brackets.

### Core importing the game

- **G1, render scene** (step 7). The renderer reads the client's state:
  `gl_rmain` imports `cl`, `cl_dlights`, `cl_entities`, `cl_lightstyle`,
  `cl_numvisedicts`, `cl_static_entities`, `cl_temp_entities`, `cl_visedicts`,
  `MAX_DLIGHTS` and `MAX_VISEDICTS` from `client`; `gl_rsurf` the same plus
  `set_cl_numvisedicts`; `gl_rlight`, `gl_fog`, `gl_mesh`, `gl_rmisc`,
  `gl_warmup`, `r_part` and `snd_dma` smaller parts; `gl_refrag` the `efrag_t`
  class; `gl_model` `ca_dedicated`, `cls` and `MAX_DLIGHTS`. `gl_rsurf` also
  reads `realtime` from `host`. The cut: a scene object in core (`render.js`
  already holds `r_refdef`) that names the arrays the renderer draws from. The
  client sets it once at init, so the per-frame path allocates nothing (Golden
  Rule #4); counts the client writes per frame (`cl_numvisedicts`) are written
  to the scene object too.
- **G2, header constants** (step 8). Core reads constants from game headers:
  `quakedef` (`VERSION`, `GLQUAKE_VERSION`, `MAX_LIGHTSTYLES`, `MAX_MODELS`,
  `MAX_DATAGRAM`, `MAX_SCOREBOARD`, `PITCH`, `YAW`, `ROLL`, `entity_state_t`)
  and `protocol` (`ENTALPHA_*`). They move down; the game files re-export them
  so no importer or name changes. `entity_state_t` differs per game (Hexen II
  adds scale, draw flags and absolute light), so core keeps the shared fields
  and a game may extend the class.
- **G3, QuakeC profile** (step 9; the Hexen II seam). `pr_edict` imports
  `PR_InitBuiltins`, `PR_InitProgsBuiltins` and `PF_Format5_1f` from `pr_cmds`,
  `PROGHEADER_CRC` and `globalvars_t` from `progdefs`, `ENTALPHA_*` from
  `protocol`, `EF_QEX_*` from `server`, `SV_ReserveSignonSpace` from `sv_main`
  and `SV_UnlinkEdict` from `world`; `progs` imports `entvars_t`; `pr_exec`
  imports `ss_active`. The cut: the game registers a progs profile (header CRC,
  globals and fields layout, builtin table, the edict hooks) with the VM before
  loading `progs.dat`. Hexen II registers its own.
- **G4, keys, draw and menus** (step 4). `keys` imports `M_Keydown`,
  `M_KeyRepeats` and `M_ToggleMenu_f` from `menu` and `scr_conscale` and
  `SCR_UpdateScreen` from `gl_screen`; `gl_draw` imports `Sbar_Changed`. Both
  files already have a `*_SetExternals` function to carry these.
- **G5, renderer calling the view** (step 7). `gl_rmain` imports `V_CalcBlend`
  and `V_SetContentsColor` from `view` and `chase_active` from `chase`. Hooks,
  set with the scene.
- **G6, engine services calling the game** (step 10). `cmd` imports the embedded
  `default_cfg` (which the game can register as a virtual file with
  `COM_AddVirtualFile` instead) and `clc_stringcmd` (for `Cmd_ForwardToServer`,
  client code that `cmd.c` happens to hold); `net_main` and `net_loop` read `sv`
  and `svs`; `gl_model` calls `Host_Error`; `mathlib` reads `PITCH`/`YAW`/`ROLL`
  (G2).

### Platform importing core or the game

- **P1, net drivers** (step 11). The browser drivers import `Con_*`/`SZ_*` from
  `common`, `net_message` and the `WT_*`/`WS_*` framing from `net`,
  `NET_NewQSocket` and friends from `net_main`, `key_menu`/`set_key_dest` from
  `keys`, `M_ConnectionError` from `menu`, `clc_disconnect` from `protocol`;
  `net_webrtc` calls `CLR_GiveUp`; `net_rtclobby` reads `server` and calls
  `Cvar_Set`. The server drivers import only the framing from `net.js`. The
  framing moves to a platform module both sides import; the socket bookkeeping
  stays in core, which calls the drivers through the driver table (as
  `net_dgrm.c` calls `net_wins.c`); menu and reconnect reactions become hooks.
- **P2, input** (step 11). `in_web` imports from 16 modules (`cl_input`,
  `cl_main`'s `sensitivity` and friends, `client`, `cmd`, `console`, `cvar`,
  `gl_draw`, `host_cmd`'s `Host_AutoSave`, `host`'s `host_frametime`, `keys`,
  `menu`, `pmove`'s `movevars`, `quakedef`, `server`, `snd_dma`, `view`);
  `touch` from 9; `touch_editor` from `cmd` and `console`. The cvars, commands
  and game reactions move to a front end in the game layer; the platform modules
  turn DOM events into key and move events.
- **P3, audio** (step 11). `cd_audio` registers the `cd` command, reads cvars
  and calls the mixer. QuakeSpasm's split applies: commands and cvars in core
  (`bgmusic.c`), playback in platform (`cd_sdl.c`).
- **P4, video** (step 11). `vid` registers cvars and prints; `webxr` calls
  `gl_draw`; `gl_contextloss` calls `gl_rsurf` and `gl_screenwarp` to rebuild
  GPU state. The cvars move to core, the context-loss and XR reactions become
  hooks the renderer sets.
- **P5, storage and files** (step 11). `userdata` imports `Cvar_WriteVariables`,
  `COM_AddVirtualFile`, `COM_SetUserPaks`, the key bindings and commands;
  `autosave` is already clean. Core files also touch browser globals: `cvar`
  (localStorage), `keys` (document, localStorage, navigator, Deno), `console`
  (window), `common` (navigator), `gl_draw` (document), `pak` (Deno, fetch),
  `snd_dma` (window). These go behind platform functions so that core runs the
  same in the browser, Deno and the desktop build.

### Cycles left inside each layer

If every violating edge were cut, these cycles would remain, all inside one
layer: game 16 modules (`cl_*`, `gl_screen`, `host`, `host_cmd`, `menu`,
`room_rules`, `sbar`, `server`, `sv_main`, `view`, `world`); core 6 (`gl_md5`,
`gl_mesh`, `gl_model`, `gl_rmain`, `gl_rmisc`, `gl_rsurf`), 4 (`cmd`, `common`,
`cvar`, `pak`), 3 (`console`, `gl_draw`, `keys`), 2 (`net_loop`, `net_main`) and
2 (`pr_edict`, `pr_exec`). The layer rule allows them; the server cut below
breaks the ones that matter for the server.

## The server cut

`server/game_server.js` loads 90 `src/` modules, including the whole renderer,
because `gl_model.js` imports `three` directly and because `host.js`,
`host_cmd.js`, `net_main.js`, `keys.js` and `console.js` import client and
renderer modules. Under Deno `three` resolves to the 683-line
`server/browser_shim.js` (root `deno.json`), which stubs `WebGLRenderer`,
`DataTexture`, `Mesh`, `Scene` and the rest so those modules evaluate.

Splitting `gl_model.js` alone is not enough: `host.js` and `net_main.js` pull
the client in on their own. A hand-picked set of 38 edges in six seams is
enough, measured by dropping them from the graph:

- **S1, model loader** (step 5): `gl_model` → `three` (`DataTexture`, filters
  and formats for its texture uploads), `vid` (`d_8to24table`, `renderer`),
  `gl_warp` (`GL_SubdivideSurface`, `GL_Warp_SetLoadmodel`, `R_InitSky`),
  `gl_mesh` (`GL_MakeAliasModelDisplayLists`, `cl_gun_fovscale`), `gl_md5`
  (`Mod_LoadMD5MeshModel`), `glquake` (the texture registry, `r_novis`) and
  `render` (`r_nolerp_list`). The renderer registers these as loader hooks; with
  no renderer, the loader builds the same model data and skips the GPU work,
  which is what the shim does today. `GL_LoadTexture` exists twice:
  `gl_model.js` (1 importer) and `gl_draw.js` (none). The C keeps it in
  `gl_draw.c`, so the live copy moves there.
- **S2, host** (step 6): `host` → `view`, `chase`, `menu`, `gl_rmisc`,
  `gl_rmain`, `vid`, `gl_draw`, `gl_screen`, `cd_audio`, `sbar`, `cl_main`,
  `cl_input`, `net_rtclobby`, `webxr`, `in_web`, `render`, `gl_refrag`,
  `r_part`, `vid_dynres`. These are the client half of `Host_Init`, `Host_Frame`
  and `Host_Shutdown` (the C's `cls.state != ca_dedicated` blocks) and the
  `*_SetExternals` wiring. They move to a client host module that registers
  itself with `host.js`; the browser and headless entries load it,
  `game_server.js` does not.
- **S3, host commands** (step 6): `host_cmd` → `cl_main` (`cl_color`,
  `CL_Disconnect`, `CL_EstablishConnection`, `cl_name`, `CL_NextDemo`),
  `gl_screen`, `cl_demo`. Client hooks, set by the same client host module.
- **S4, roll angle** (step 4): `sv_main` → `view` for `V_CalcRoll`. `sv_user`
  already receives it as an injected slot; `sv_main` should too, or `V_CalcRoll`
  and its two cvars move to a module the server can import.
- **S5, net driver table** (step 3): `net_main` → `net_webtransport`,
  `net_websocket`, `net_webrtc`, `net_rtclobby`. The table moves to the entry
  points, as the C keeps it in `net_win.c` and `net_bsd.c`.
- **S6, screen metrics and menus** (step 4): `console` → `gl_draw`
  (`Draw_GetVirtualWidth`/`Height`), `keys` → `menu`, `gl_screen`, `gl_draw`
  (also `Draw_SetCanvasScale`). Through `Con_SetExternals` and
  `Key_SetExternals`.

With all six cut, `game_server.js` reaches 49 modules (42 in `src/`) and no
`three` file. The 52-module cycle becomes cycles of 26 (client and renderer), 13
(`gl_model`, `host`, `host_cmd`, `net_loop`, `net_main`, `pr_cmds`, `pr_edict`,
`pr_exec`, `server`, `snd_dma`, `sv_main`, `sv_move`, `world`), 4 and 2. The
dedicated server then no longer loads the shim.

`headless_host.js` and `agent_mcp.ts` still load the client, and with it `three`
(85 and 88 modules after the cut, through `gl_screen` → `vid`), and so do many
tests. The shim stays for them until one of: a null renderer the client host
module can load instead of the Three.js one; or real `npm:three` under Deno for
tests and headless play (needs a spike: `WebGLRenderer` will not construct
without a canvas, so a stub is still needed for it). See open question 5.

## Duplicated state

The script found 170 names exported by more than one `src/` file. By kind:

- **Dead copies in `glquake.js`** (step 2). `glquake.js` mirrors `glquake.h` and
  exports `const` copies of state that lives elsewhere, none imported:
  `currententity`, `r_worldentity`, `r_viewleaf`, `r_oldviewleaf`, `mirror`,
  `mirror_plane`, `glx`/`gly`/`glwidth`/`glheight` (640 and 480 here, live
  values elsewhere), `gldepthmin`/`gldepthmax`, `r_visframecount`,
  `c_brush_polys`/`c_alias_polys`, `gl_lightmap_format`, `skytexturenum` (also
  in `gl_warp` and `gl_rsurf`), `r_cache_thrash`, `frustum`, `r_refdef`
  (`const null`, while `render.js`'s live one has 7 importers), `r_origin`,
  `vpn`/`vright`/`vup`, and constants copied from `gl_rmain` and `gl_model`.
  `currenttexture` is a `let` in both `glquake` and `gl_rmain`. A reader who
  imports the wrong copy gets a constant that never changes. Delete the copies
  with no importers; keep the live one where it is.
- **Stubs in `render.js`** (step 2). `R_Init`, `R_NewMap`, `R_RenderView` and
  others are empty ("Implemented in gl_rmain.js") with no importers. The `R_*`
  particle functions are forwarders to `r_part.js` that `cl_tent` uses; they
  stay until step 7.
- **Two classes for one C struct** (step 7): `entity_t` and `efrag_t` in
  `client.js` and `render.js`, `dlight_t` in `client.js` and `gl_rlight.js`,
  `mplane_t` in `gl_model.js` and `gl_rmain.js`, `glpoly_t` in `gl_model.js` and
  `glquake.js`. One canonical class each, in core; the others re-export.
- **Injected copies** (step 13). `sv_phys.js` holds its own `sv`, `svs`,
  `sv_player`, `pr_global_struct`, `host_frametime` and ten function slots, set
  by `SV_SetCallbacks` and `SV_SetFrametime`; `sv_user.js` holds `host_client`
  and five function slots; `sv_move.js` three; `progs.js` `sv` and `svs`. They
  exist to break cycles. Four are values that must stay in step with an
  original: `host_frametime` (`host.js`, 5 importers, and `sv_phys.js`),
  `host_client` (`server.js` and `sv_user.js`), `sv_player` and
  `pr_global_struct`. After the server cut, `sv_phys`, `sv_user` and `sv_move`
  can import these directly from game modules without pulling the client in.
  Collapsing them is optional (the audit's A3 says leave the pattern); if done,
  it goes one name per commit with the bench checksums checked, and a test first
  that the copies agree after a frame.
- **`Con_Printf` twice**: `common.js` has a forwarder (33 importers) that calls
  the real one in `console.js` (11) through `_realConPrintf`, so leaf modules
  can print without importing the console. It becomes the `sys.js` print hook in
  step 12.
- **`net_message`** in `common.js` is a `let` set by `COM_SetNetMessage` from
  `net.js`'s `const`. It goes with the `MSG_*` functions in step 12.
- **Constants that differ**: `PLANE_ANYZ` is 5 in `bspfile.js` (as in the C) and
  3 in `gl_rmain.js`, which uses it for frustum planes. `BoxOnPlaneSide` only
  tests `type < 3`, so both give the same result; use the C value (open question
  8).
- **Same-value constants** (97): `CONTENTS_*` in `bspfile` and `sv_phys`,
  `FL_*`, `MOVETYPE_*` and `SOLID_*` in `server` and `sv_phys`, `SURF_*`,
  `clc_*`, `EF_*`, `AMBIENT_*`, `PLANE_*`. Harmless; each step that touches one
  of these files makes the copy a re-export of the header that owns it.

## TypeScript and a bundle step

- **Bundle first, on its own track.** Vendor `three` and `nipplejs` (today
  loaded from jsDelivr by `index.html`'s import map) so the page, the service
  worker and the desktop build don't depend on a CDN; then add `deno bundle` to
  `deno task client-build` for production while development keeps loading the ES
  modules directly. This is the audit's B2 and doesn't depend on the layering,
  but it must land before any `.ts` file in `src/`, because browsers can't load
  TypeScript. Vite only if `deno bundle` falls short.
- **TypeScript after the cuts.** Type-checking a cycle of 52 modules buys little
  and makes every error point everywhere. Once steps 3–12 have landed, add
  `// @ts-check` with JSDoc typedefs to core leaves first (`mathlib`, `crc`,
  `zone`, `bspfile`, `wad`, `image`), then the typedefs the audit (T1) lists:
  `edict_t`, `entity_t`, `mleaf_t`, `msurface_t`, `qsocket_t`, `usercmd_t`,
  `cvar_t`. `deno task check` already type-checks `main.js` and the server
  entries, so this is a matter of adding files, not tooling. Renaming files to
  `.ts` waits for the bundle step; Deno-only platform code can be `.ts` today
  (the server drivers already are).

## Steps

Every step must: keep `deno task ci` green; leave the checksums and hashes of
`tools/bench/server_bench.js`, `build_bench.js`, `model_bench.js` and
`net_bench.js` unchanged (run before and after on the same machine); lower or
keep the violation count `tools/layer_graph.js` reports (from step 1 a test
fails if it rises); and change no cvar, command, builtin or field name. Steps
that touch a module inside the 52-module cycle can change the order modules
evaluate in, which shows up only as a TDZ error ("Cannot access before
initialization") in the entry point that loads them in that order, so they also
need a browser load: `deno task serve`, play e1m1, open the menu, play a demo,
and connect to a browser-hosted room. The headless tests cover the server's
order.

Conflicts are with the PRs open when this was written: #255 (QuakeC builtins:
`cmd`, `pr_cmds`, `pr_edict`, `sv_user`), #253 (fence textures: `browser_shim`,
`gl_entalpha`, `gl_model`, `gl_rsurf`), #252 (headless game directories:
`headless_host`), #249 (centerprint and localization: `common`, `gl_screen`),
#246 (screen tier: `main.js`, `agent_mcp.ts`, `agent.js`), #245 and #251 (docs
only), and sessions in progress without a PR (stuffcmd trust: `cl_main`,
`cl_parse`, `cmd`, `cvar`, `net_loop`; protocol design: likely `protocol.js`).
Re-check with `gh pr list` before starting a step.

1. **Checker and ratchet.** Add `tools/layer_graph.js` (the measuring script,
   with the layer table above) and a test that fails when a new violating edge
   appears, with the current 107 pairs as its baseline, and reports pairs that
   disappeared so each later step lowers the baseline. Conflicts: none.
2. **Delete dead duplicates.** The unimported copies in `glquake.js` and the
   empty `render.js` stubs. Conflicts: none of the open PRs touch those two
   files; land after #253 if it adds an importer.
3. **Net driver table to the entry points** (S5). `NET_Init` keeps loopback in
   slot 0; the browser drivers are registered by the browser entry instead of
   being imported by `net_main.js`, as `game_server.js` already fills its own
   slots after `NET_Init`. Conflicts: `main.js` (#246).
4. **Screen metrics, menus and roll angle** (S4, S6, G4): `keys` and `console`
   reach `menu`, `gl_screen` and `gl_draw` through their existing
   `*_SetExternals`; `gl_draw` reaches `Sbar_Changed` the same way; `sv_main`
   stops importing `view`. Browser check required. Conflicts: none open.
5. **Model loader hooks** (S1), and the live `GL_LoadTexture` moved to
   `gl_draw.js`. Conflicts: `gl_model.js`, `browser_shim.js` (#253): land after
   #253.
6. **Client host module and host commands** (S2, S3). Adds a test that
   `game_server.js`'s module graph contains no `three` file. Browser check
   required. Conflicts: `headless_host.js` (#252), `main.js` (#246).
7. **Render scene** (G1, G5, the duplicate classes). Browser check required.
   Conflicts: `gl_rsurf.js`, `gl_entalpha.js` (#253).
8. **Header constants** (G2). Constants move to core and the game headers
   re-export them. Conflicts: `protocol.js` (the protocol-design work):
   coordinate or land first, as it is mechanical.
9. **QuakeC profile** (G3). Conflicts: `pr_edict.js`, `pr_cmds.js` (#255): land
   after #255.
10. **Engine services** (G6): `default_cfg` as a virtual file,
    `Cmd_ForwardToServer` to the client, `net_main`/`net_loop` and `pr_exec`
    reading server state through hooks. Conflicts: `cmd.js` (#255, stuffcmd
    trust), `net_loop.js` (stuffcmd trust).
11. **Platform splits**, one PR each: P1 net (after step 3), P2 input, P3 audio,
    P4 video, P5 storage. Input and storage touch many files but no open PR.
    Browser and phone checks required (touch, gyro, audio unlock, context loss).
12. **Split `common.js`** into the audit's `msg.js`, `sz.js`, `com_args.js` and
    `com_file.js`, with `LOC_*` in its own module and `Con_Printf` going through
    the `sys.js` print hook, which breaks the `cmd`/`common`/`cvar`/ `pak`
    cycle. `common.js` re-exports during the step so its 49 importers move over
    in the same PR or the next. Conflicts: `common.js` (#249): land after #249.
13. **Optional: collapse the injected copies** in `sv_phys`, `sv_user`,
    `sv_move` and `progs` (see Duplicated state). Conflicts: `sv_user.js`
    (#255).
14. **Move files into the directories**, one PR per layer (platform, then core,
    then game), each made by a codemod that rewrites import specifiers in
    `src/`, `server/`, `main.js`, `tests/` and `tools/bench/` and the text
    references tests make (`new URL("../src/pr_exec.js", import.meta.url)` in
    `tests/pr_exec_ops_test.js`, the source reads in
    `tests/menu_advanced_test.js`): 978 references in tests and 71 in the
    benches. The checker switches from its table to the directories. A move
    commit changes nothing but paths, so git's rename detection carries open PRs
    across: they merge `dev` and only import lines conflict. The codemod stays
    in `tools/` so an open PR can run it on its own new imports, as the style
    tiers' catch-up recipe does. Paths that name the directory and not a file
    keep working: the Dockerfile's `COPY src/`, `.dockerignore`'s `!src/`,
    `CLIENT_DIRS` in `cloudflare/client/build.js`, the lint include in
    `deno.json`, `sw.js`. New files created by steps 3–12 go straight into their
    final directory, so this step only moves files that existed before.
    Conflicts: every open PR that touches `src/`; pick a quiet moment.
15. **TypeScript**: `@ts-check` and typedefs, core leaves first.
16. **Retire the shim** once the headless host and tests no longer need it (open
    question 5).

Dependencies: 3 before 11 (P1) and 6; 3, 4 and 5 before 6, which adds the
no-`three` test; 6 before 13; 12 after 10 (both edit `cmd`/`common` imports); 14
after 3–12 so the codemod runs once over files in their final shape (it can run
per layer as soon as that layer's splits are done); the bundle track before any
`.ts` in `src/`. Steps 2, 4, 5, 7, 8, 9 and 12 are independent of each other
apart from the open PRs they wait for.

## Open questions for the maintainer

1. **Order of platform and core.** This plan puts platform at the bottom, so
   core can call target-neutral platform functions and entry points pick the
   implementation. The other order (core at the bottom, platform drivers
   implementing core's ports) leaves about 98 violating pairs instead of 107 and
   is closer to how the C's `vid_win.c` and `in_win.c` register cvars. Either
   works with the same seams; which do you prefer?
2. **Cvars, console and the QuakeC VM in core** (as the task says) or in the
   Quake layer (the audit's sketch)? This plan puts them in core, since Hexen II
   uses the same ones; only the progs profile (G3) is per game.
3. **Entry points as a fourth tier**: is a top tier above `games/` that only
   wires things up acceptable, or should entry points count as game code?
4. **Directories**: `src/platform/{browser,deno}`, `src/core`,
   `src/games/quake`? And should the Deno drivers in `server/` move to
   `src/platform/deno/` or stay?
5. **Headless renderer**: after the server cut, should headless play and the
   tests get a null renderer (no shim), run real `npm:three` with a stubbed
   `WebGLRenderer` (a smaller shim), or keep the current shim?
6. **The checker**: commit `tools/layer_graph.js` with a ratchet test (it uses
   `@babel/parser`, already in `deno.lock`), or use `deno info --json` instead
   (no parser, but `deno task test` would need `--allow-run` for `deno`)?
7. **Moves**: a codemod that rewrites every import (this plan), or leave
   re-export stubs at the old paths for a while to spare open PRs?
8. **`PLANE_ANYZ`**: make `gl_rmain.js` use the C value 5 from `bspfile.js` (no
   behaviour change, as `BoxOnPlaneSide` only tests `type < 3`)?
9. **Injected copies** (step 13): collapse them once the cycles allow, or keep
   the pattern as the audit recommends?
10. **`gl_model.js`** is 3552 lines. Split it into brush, alias and sprite
    loaders while doing step 5, or leave it whole?
