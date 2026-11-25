# What stands between Icaro and the 2021 rerelease

This is a snapshot of `dev` at `d6f2058` (2026-11-25), taken after the Ironwail
rounds (#61–#109) and after #84 (ranged pak loading) and #89 (the `rerelease/`
folder layout) were merged. As with `port-review.md`, check its claims against
the code before relying on them.

The findings come from four sources:

- **The rerelease data.** The 2021 paks in a local `static/rerelease/`
  (gitignored, never committed) were read with throwaway scripts. They gave map versions, entity and model counts, `.lit`
  headers, the progs builtin tables, demo protocols, and formats.
- **id's published rerelease QuakeC**
  ([id-Software/quake-rerelease-qc](https://github.com/id-Software/quake-rerelease-qc)),
  which shows what each progs calls.
- **[Ironwail](https://github.com/andrei-drexler/ironwail)** as the reference
  source port. Its paths are given as `Quake/<file>:<line>` on its default branch at
  the time of writing.
- **A headless spawn of every rerelease map** on the server code (see
  "Headless spawn").

## Summary

- **The BSP29 content loads.** That covers 66 of id1's 68 maps (all but the
  2 BSP2 vault maps), hipnotic's 18, rogue's 17, ctf's 10, mg1's 3 deathmatch
  maps and mg3's `secret1`. Each spawns and runs 100 server frames
  headless. But two bugs make it unplayable:
  1. **Picking up any weapon or ammo stops the server.** The rerelease
     `W_WantsToChangeWeapon` calls `ex_CheckPlayerEXFlags`, which is bound to
     `PF_Fixme`. Its "unimplemented builtin" error becomes a `Host_Error`.
  2. **Finding a secret disconnects the client.** `multi_trigger` writes
     `svc_achievement` (52) on every secret. The client has no case for 52, so it
     hits "Illegible server message".
- **The text shows raw keys.** id1's QuakeC uses 135 distinct `$key` strings,
  such as `$qc_item_health`. Nothing resolves them, so pickups, triggers and
  the finale print the keys.
- **58 of the 192 `.bsp` files are BSP2.** The 192 are 171 maps plus 21
  `b_*` box models; ctf's `archive/` copies are left out. The BSP2 files are
  all 13 maps of Dimension of the Past (`dopa`), 22 of 25 in Dimension of the
  Machine (`mg1`), 19 of 20 in Dimension of the Doomed (`mg3`) plus its 2
  `maps/bmodel/b_*` models, and 2 id1 vault maps. Every one fails on
  `Mod_LoadBrushModel`'s version check.
- **Once BSP2 loads, the next limits are the protocol's:**
  - 6 maps need more than 256 models.
  - `mg3/secret2` has 1572 entities at load, against `MAX_EDICTS` 1024.
  - 5 maps extend past the ±4096 coordinate range.

## Status of each gap

Status values: **done**; **partial**; **missing**; **n/a** (not needed for the
rerelease). The sizes are rough: **S** is a day or less, **M** a few days, **L** a
week or more.

| # | Gap | Status | Evidence | Size | Files it would touch |
|---|-----|--------|----------|------|----------------------|
| 1a | `ex_CheckPlayerEXFlags` | **missing** (blocker) | `src/pr_cmds.js:2046` binds it to `PF_Fixme`. Every progs calls it from `W_WantsToChangeWeapon`, on weapon and ammo pickups (`quakec/items.qc:537,722,1393`). Ironwail returns 0 (`Quake/pr_cmds.c` `PF_CheckPlayerEXFlags`). | S | `src/pr_cmds.js`, `tests/qc_extension_builtins_test.js` |
| 1b | `ex_walkpathtogoal` | **missing** (blocker for mg1 and dopa) | `src/pr_cmds.js:2047` binds it to `PF_Fixme`. `quakec_mg1/ai.qc:798-812` calls it whenever a melee or mixed monster chases. The dopa progs is built from the mg1 code. Ironwail returns 0 (`PATH_ERROR`), and the QC falls back to `movetogoal`. | S | same as 1a |
| 1c | `ex_finaleFinished` name | **partial** | The progs exports `ex_finaleFinished` (capital F). `src/pr_cmds.js:2045` registers `ex_finalefinished`, and `PR_InitProgsBuiltins` (`:2153`) matches case-sensitively, so it is never bound. An unbound `#0` function enters at statement 0 (`OP_DONE`) and returns 0, which happens to match `PF_finalefinished` (Ironwail has the same name mismatch). Fix the name anyway. | S | same as 1a |
| 1d | Other progs builtins | **done** (harmless) | Every rerelease progs also declares `ex_draw_*` (debug), `ex_bot_*` (bots) and `checkextension` (#99). The ctf progs adds `setcolor` (#401) and `ex_prompt`/`ex_promptchoice`/`ex_clearprompt`. The unbound `#0` ones return 0 silently. `setcolor` and the prompts are only called after `cvar("pr_checkextension")` and `checkextension(...)` checks, which are false here. mg3's `draw_bounds` is debug-only. | – | – |
| 1e | `svc_achievement` (52) | **missing** (blocker) | QC writes it in id1 (18 sites), hipnotic (13), mg1 (11), mg3 (16), rogue (8) and ctf (1). It comes from `multi_trigger` on every secret, and from intermissions and kills. The `src/cl_parse.js:1425` default case calls `Host_Error`. Ironwail reads and ignores the string (`Quake/cl_parse.c:1374`). No other KEX svc is written by QC. | S | `src/protocol.js`, `src/cl_parse.js` |
| 1f | `campaign`, `horde`, `sv_cheats` cvars | **missing** | Every `StartFrame` runs `cvar_set("campaign", …)` (`quakec/world.qc:369`). With no such cvar, `Cvar_Set` (`src/cvar.js:186`) prints "variable campaign not found" every server frame: 101 times in a 100-frame headless run. `horde` turns on mg1's horde mode. Ironwail registers all three (`Quake/host.c:91-93`). | S | `src/host.js` |
| 2 | Localisation | **missing** | `loc_<language>.txt` is in id1's `pak0.pak` under `localization/` (1645 keys, 213 `{}` placeholders, UTF-8) and in `QuakeEX.kpf`. Ironwail resolves keys on the server: in `PF_VarString` (`Quake/pr_cmds.c:60-95`, with `{}` placeholders) and `PF_WriteString` (`:1583`, which covers `svc_finale "$qc_finale_end"`). Its loader is `LOC_*` in `Quake/common.c:3687-4070`, with a `language` cvar. Map names are plain text, and the classic `.lmp` menus need no keys. Only `mapdb.json` episode names use them (menu only). | M | `src/common.js` (`LOC_*`, `UTF8_ToQuake`), `src/pr_cmds.js` (`PF_VarString`, `PF_WriteString`), `src/host.js` (`LOC_Init`), new tests |
| 3 | BSP2 maps | **missing** | `src/gl_model.js:2578` accepts only version 29. The rerelease has 58 BSP2 files (56 maps and 2 box models) and no 2PSB ones. Every BSP29 map fits the current limits; the largest is `mg1/mgdm3`, with 8980 leafs under `MAX_MAP_LEAFS` 32767 (`src/bspfile.js:18`). Ironwail's loaders are `Quake/gl_model.c` `Mod_LoadNodes_L2` (`:1549`) and `Mod_LoadClipnodes(…, bsp2)` (`:1923`), with leafs, faces, edges and marksurfaces done the same way. | L | `src/bspfile.js`, `src/gl_model.js` (`Mod_LoadEdges`, `Mod_LoadFaces`, `Mod_LoadNodes`, `Mod_LoadLeafs`, `Mod_LoadClipnodes`, `Mod_LoadMarksurfaces`), and anything that stores 16-bit children or indexes (check `src/world.js` hull code), tests |
| 4a | Signon size | **done** (#96) | Signon buffers of `MAX_MSGLEN/2`, up to 256 of them (`MAX_SIGNON_BUFFERS`, `src/server.js`), allow about 1 MB of signon. Even 2000 baselines at 35 bytes each fit. | – | – |
| 4b | Edict count | **partial** | `MAX_EDICTS` 1024 (`src/quakedef.js:29`) is bounded by `PE_ENT_BITS` 10 (`src/protocol.js:182`). Before skill filtering, `mg3/secret2` has 1572 entities that aren't lights or `info_null`, and `mg3/map8` has 988. Runtime spawns add to that. Ironwail: `MAX_EDICTS` 32000 (`Quake/quakedef.h:106`). | L (with 4c, 4d) | `src/protocol.js`, `src/quakedef.js`, `src/sv_main.js` (packet entities), `src/cl_parse.js`, `src/cl_main.js` |
| 4c | Model and sound indexes | **missing** | Models are sent as bytes in packet entities (`src/sv_main.js:854`), `svc_playerinfo` (`:1572`), baselines (`:1969`) and `svc_spawnstatic` (`src/pr_cmds.js:1472`). Sounds are bytes at `src/sv_main.js:254`. Six maps have more than 200 brush submodels before the QC precaches: `mg1/mge2m2` 285, `mge5m2` 202; `mg3/map2b` 255, `map7` 230, `map8` 364, `secret2` 525. The `SV_SpawnServer` submodel loop (`src/sv_main.js:2119-2123`) also reads `localmodels[ i ]` past `MAX_MODELS` with no bounds check, so it fails with a crash rather than an error. Ironwail: `MAX_MODELS` 4096, `MAX_SOUNDS` 2048, `U_MODEL2` and large-sound flags (`Quake/protocol.h:64`). Sound precache counts were not measured. | (in 4b) | as 4b, plus `src/pr_cmds.js` (`PF_makestatic`, precache) |
| 4d | Coordinate range | **missing** | `MSG_WriteCoord` (`src/common.js:423`) writes a short in eighths of a unit, ±4096. World bounds pass ±4096 on `id1/vault/jrwiz3`, `mg1/mge1m2`, `mge4m1` and `mge4m2` (±5183), and `mg3/secret1`. Ironwail uses `PROTOCOL_RMQ` with `PRFL_INT32COORD` or float coords (`Quake/protocol.h:31-37`, default `sv_protocol` 999). | (in 4b) | `src/common.js`, `src/protocol.js`, `src/cl_parse.js`, prediction (`src/pmove.js`, `src/cl_pred.js`) |
| 5 | `.lit` coloured lighting | **missing** | 127 `.lit` files, all QLIT version 1: id1 42, mg1 25, mg3 20, dopa 13, hipnotic 18, ctf 9, rogue none. `src/gl_model.js:1643` loads mono light data; `src/gl_rsurf.js:277` has `lightmap_bytes = 1`. `src/pak.js:587` defers `.lit`, so map load would have to `COM_EnsureFile` it. Ironwail: `Quake/gl_model.c:860-895`. | M | `src/gl_model.js` (`Mod_LoadLighting`), `src/gl_rsurf.js`, `src/gl_rlight.js` (`R_LightPoint`), `src/pak.js` |
| 6a | Fog | **missing** | The worldspawn `fog` key appears in 42 id1, 17 hipnotic, 9 ctf, 3 mg1 and 2 mg3 maps (as `fog_*`). mg1, mg3 and dopa also set fog from QuakeC with `stuffcmd(…, "fog …")` (`quakec_mg1/fog.qc`), which prints "Unknown command" here. Ironwail: `Quake/gl_fog.c` (`Fog_ParseWorldspawn`, the `fog` command, `svc_fog`). | M | new `src/gl_fog.js`, `src/gl_rmain.js`, `src/cl_parse.js` (`svc_fog` only if the server sends it) |
| 6b | Skyboxes | **missing** | 15 mg1 and mg3 maps set `_sky` (for example `mge2m1/mge2m1_`), and their paks ship `gfx/env/*.tga` (mg1 66, mg3 78). Ironwail strips the leading `_` and loads the box (`Quake/gl_sky.c:557-600`). Here `pak.js` defers `.tga`, and there is no skybox renderer or TGA loader. | M | `src/gl_warp.js` or a new `src/gl_sky.js`, `src/pak.js`, an image loader |
| 6c | Entity `alpha` | **missing** | 233 mg1 and 321 mg3 entities have an `alpha` key, and the mg1 progs declares `.float alpha`. `src/pr_edict.js:917` only suppresses the "not a field" warning. The protocol carries no alpha. Ironwail: `U_ALPHA` (`Quake/protocol.h:62`), with `ENTALPHA_ENCODE` in `ED_ParseEdict` (`Quake/pr_edict.c:1391`). | M (with 4b) | `src/protocol.js`, `src/sv_main.js`, `src/cl_parse.js`, `src/gl_rmain.js`, `src/pr_edict.js` |
| 6d | `EF_QUADLIGHT`, `EF_PENTALIGHT`, `EF_CANDLELIGHT` (16, 32, 64) | **missing** | The rerelease `defs.qc` defines them. `src/cl_main.js:682-693` handles only 4 and 8. Ironwail: `Quake/cl_main.c:654`, gated by `PR_FindSupportedEffects` (`Quake/pr_edict.c`) so mods that use those bits differently are left alone. | S | `src/cl_main.js`, `src/pr_edict.js` |
| 6e | Liquid alpha keys | **done** | `R_ParseWorldspawn` strips the leading `_` (`src/gl_rsurf.js:462-496`), so the rerelease's `_lavaalpha` and `_slimealpha` keys work. | – | – |
| 6f | Music | **done** | `music/trackNN.ogg` is looked up per game dir (`main.js:123-127`). id1, hipnotic, rogue and mg3 ship `music/`. | – | – |
| 6g | `menu_credits` | **done** | `src/menu.js:3157`. `finale_6` runs it after the end. | – | – |
| 6h | Missing `default.cfg` | **partial** | The rerelease id1 has no `default.cfg`, but its `quake.rc` runs `exec default.cfg`. `src/host.js:461-470` adds WASD, jump and attack bindings, but weapon keys and the rest of id's defaults are missing. Ironwail embeds QuakeSpasm's (`Quake/cmd.c:277`, `default_cfg.h`). | S | `src/cmd.js` (`Cmd_Exec_f` fallback), an embedded config |
| 6i | Console noise | **missing** | `quake.rc` sets `scr_usekfont 1`, and QC stuffs `vibrate` at 20 sites (pickups, damage). Each prints "Unknown command" (`src/cmd.js:454`). A no-op `vibrate`, or one mapped to Gamepad haptics, and an `scr_usekfont` cvar would silence them. | S | `src/host.js` or `src/in_web.js`, `src/gl_screen.js` |
| 6j | ctf `archive/` in the browser | **missing** | ctf's `pak0.pak` has an `archive/` tree of 172 entries (93 MB of `.exe`, `.zip`, `.bsp`, …). `DEFERRED_DIRS` (`src/pak.js:588`) lists only `tactile/` and `vault/`, so `?game=ctf` fetches all of it at load. | S | `src/pak.js`, `tests/pak_lazy_test.js` |
| 6k | MD5 replacement models | **missing** (optional) | id1 has 59 `.md5mesh` and 58 `.md5anim`, mg3 5 of each. The `.mdl` originals are still there and load. Ironwail loads an `.md5mesh` whenever one exists beside the `.mdl` (`Quake/gl_model.c:3240-3250`, loader from `:3713`). | L | `src/gl_model.js`, `src/gl_mesh.js`, `src/gl_rmain.js`, `src/pak.js` |
| 6l | `.mdl`, `.spr` and `.wav` formats | **done** | Every `.mdl` is IDPO version 6, at most 1912 vertices, 1923 triangles and 250 frames, with skins up to 512×480. That is within `MAXALIASVERTS` 2400, `MAXALIASTRIS` 4096 and `MAX_LBM_HEIGHT` 480. Sprites are IDSP version 1. The `.wav` files are PCM, mostly 44.1 kHz 16-bit mono (378 files). Wav playback was not tested. | – | – |
| 6m | Bots, `.nav`, KEX saves, `mapdb.json`, KEX fonts | **n/a for now** | Bots need the `ex_bot_*` builtins and the `bots/*.nav` graphs; Ironwail doesn't do them either. KEX saves (`SAVEGAME_VERSION_KEX` 6, `Quake/host_cmd.c:2574`) matter only for importing them. `mapdb.json` drives the KEX add-on and episode menu. `scr_usekfont` fonts are in `QuakeEX.kpf`. | M–L each | – |
| – | Pak loading (#84), folder layout (#89) | **done** | Both are merged to `dev` (`cba28aa`, `85807a3`). | – | – |

## Headless spawn

`static/rerelease/<game>/pak0.pak` was loaded on the Deno server code with a
throwaway script, not committed. For each map it ran `SV_SpawnServer` and then
100 frames of `SV_Physics` at 0.05 s, with `svs.maxclients` 1 and no client
connected.

| pak | maps (excluding `b_*`) | spawn and run | fail |
|-----|----------------|---------------|------|
| id1 | 68 (42, plus 15 `test/` and 11 `vault/`) | 66 | 2 BSP2 vault maps (`tboss`, `tim14`) |
| hipnotic | 18 | 18 | – |
| rogue | 17 | 17 | – |
| ctf | 10 | 10 | – |
| mg1 | 25 | 3 (`mgdm2`–`mgdm4`) | 22, all BSP2 |
| mg3 | 20 | 1 (`secret1`) | 19, all BSP2 (the 2 BSP2 `maps/bmodel/b_*` models fail too) |
| dopa | 13 | 0 | 13, all BSP2 |

The most edicts in use after 100 frames was 541, on `rogue/r2m6`. The
mission-pack flags (`-hipnotic`, `-rogue`) were not set. Calling the rerelease's
`W_WantsToChangeWeapon` directly ended in "unimplemented builtin" and then
`Host_Error: Program error`, as item 1a predicts.

## Suggested order

The order follows how much content each step makes playable.

**Phase 1: make the BSP29 remasters playable (all S).** This covers id1, hipnotic,
rogue, ctf, and the BSP29 maps in mg1 and mg3.

1. Builtins 1a, 1b and 1c (`src/pr_cmds.js`).
2. `svc_achievement` 1e (`src/protocol.js`, `src/cl_parse.js`). This is client-side only: the
   server already passes QC's bytes through.
3. Cvars 1f, plus the 6i no-ops (`src/host.js`, plus `src/in_web.js` if
   `vibrate` drives haptics).
4. `default.cfg` fallback 6h (`src/cmd.js`).
5. The `archive/` deferral 6j (`src/pak.js`).

**Phase 2: localisation (M).** Item 2. Pickups, triggers and the finale need it to read
properly. It touches `src/pr_cmds.js`, so it goes after step 1, or in the same PR.

**Phase 3: BSP2 (L).** Item 3. This unlocks dopa, the rest of mg1 and mg3, and the two vault
maps. Of those, all but the maps named in phase 4 then run within today's
limits. That assumes the `walkpathtogoal` fix from phase 1.

**Phase 4: protocol limits (L).** Items 4b, 4c and 4d, with entity alpha (6c) in the same
change. This unlocks six maps for models (`mg1/mge2m2` and `mge5m2`; `mg3/map2b`, `map7`,
`map8` and `secret2`), `mg3/secret2` (and probably `map8`) for edicts, and five maps for coordinates.
AGENTS.md requires a message-format change to update the client and server in one PR. The
NQ protocol 15 path must keep working, because the attract demos
(`demo1`–`demo3`, which `quake.rc` starts at boot) are protocol 15. Icaro does
not have to adopt Ironwail's 666 or 999 wire formats, because the client and server ship together.

**Phase 5: fidelity (M each).** In rough order of visible effect:

1. `.lit` (5)
2. Fog (6a)
3. Skyboxes (6b)
4. The QEX effect lights (6d)
5. MD5 models (6k), last

### What can run in parallel

These share files, so run them in sequence or bundle them:

- **`src/pr_cmds.js`:** builtins (1a–1c), localisation (2), and the `PF_makestatic` part of the index widening (4c).
- **`src/protocol.js` and `src/cl_parse.js`:** `svc_achievement` (1e), protocol limits (4b–4d), alpha (6c), and `svc_fog` if it is ever sent.
- **`src/gl_model.js`:** BSP2 (3), `.lit` (5) and MD5 (6k). They change different
  functions, but conflict in the `Mod_LoadBrushModel` dispatch.
- **`src/pak.js`:** the `archive/` deferral (6j), `.lit` (5), skybox `.tga` (6b) and MD5 (6k). Each changes
  `DEFERRED_EXTENSIONS` or `DEFERRED_DIRS`, or adds a `COM_EnsureFile` at map load.
- **`src/host.js`:** cvars (1f) and `LOC_Init` (2). Both are one-line additions, so the conflict is trivial.
- **`src/cl_main.js`:** effect lights (6d) and protocol limits (4b, the client entity
  state).
- **`src/gl_rmain.js`:** fog (6a), entity alpha (6c) and MD5 (6k).
- **`src/pr_edict.js`:** alpha (6c) and the effect lights' `PR_FindSupportedEffects`
  (6d).
- **`src/sv_main.js`:** protocol limits (4b, 4c) and alpha (6c), which are one
  change anyway.

Groups that can run at the same time:

- **Now:**
  - Builtins, then localisation (one owner of `pr_cmds.js`).
  - `svc_achievement`.
  - Cvars and no-ops.
  - `default.cfg`.
  - The `archive/` deferral.
  - BSP2.
- **After BSP2 and `svc_achievement` land:**
  - Protocol limits with alpha (network files).
  - `.lit` (`gl_model.js`, `gl_rsurf.js`, `gl_rlight.js`, `pak.js`).
  - Fog (new `gl_fog.js`, `gl_rmain.js`). It shares `gl_rmain.js` with alpha, so
    keep its `gl_rmain.js` change to a call into `gl_fog.js`, or land it after
    the protocol PR.
  - Skyboxes (`gl_warp.js` or `gl_sky.js`). Skyboxes need `pak.js` after `.lit`.

## Not verified

- Nothing ran in a browser, and no client connected. The two blockers come
  from reading the code. 1a was confirmed by calling the QC function headless; 1e
  was not exercised.
- The attract demos were checked only for their protocol number (15), not played. Icaro's
  `svc_packetentities`, `svc_deltapacketentities` and `svc_serversequence`
  (47–49, `src/protocol.js:175-177`) reuse KEX's numbers for
  `svc_updatesocial`, `svc_updateplinfo` and `svc_rawprint`. A demo that contains those would misparse. Single-player
  demos probably don't.
- 44.1 kHz 16-bit `.wav` playback and `.ogg` music under `?base=rerelease` were not tested.
- Sound precache counts per map were not measured. The model counts above are
  brush submodels only, before QC precaches. The edict counts are static map
  entities, before skill and deathmatch filtering and runtime spawns.
- Datagram size on big maps was not measured: `MAX_DATAGRAM` is 1024, and WebTransport datagrams are
  about 1200 bytes. More visible entities per frame may drop packet entities.
- The headless run did not set `-hipnotic`/`-rogue` (they affect the HUD and some engine
  behaviour), and used default skill and `deathmatch 0`.
