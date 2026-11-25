# What stands between Icaro and the 2021 rerelease

This is a snapshot of `dev` at `d6f2058` (2026-11-25), taken after the Ironwail
rounds (#61–#109) and after #84 (ranged pak loading) and #89 (the `rerelease/`
folder layout) were merged. As with `port-review.md`, check its claims against
the code before relying on them.

**Status updated at `223a180` (2026-11-25)**, after #111–#114. Those PRs fixed
rows 1a, 1b, 1c, 1e, 1f, 6h and 6j, and half of 6i, so both blockers in the
summary are gone. The fixed rows keep their original evidence, with the fix
noted, and every row's source line numbers were rechecked at `223a180`. The
measurements (counts from the paks, the headless spawn) were not rerun; they
are from `d6f2058`, apart from the BSP2 rerun below.

**Item 3 (BSP2) fixed in #126.** Its row, the BSP2 summary bullet, the
headless spawn table and the phase 3 and 4 notes were updated from a new
headless run of every BSP2 map on that branch.

**Items 4b, 4c, 4d and 6c (phase 4) fixed** on `agent/loving-ramanujan-d1bce5`.
Their rows, the limits summary bullet, the headless spawn table and the
phase 4 note were updated from a headless run of 109 maps on that branch.

**Item 6i finished** with a no-op `vibrate` command. A rescan of every
shipped `progs.dat` found no `vibrate`, so its row now corrects the original
"20 sites" claim.

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

- **The BSP29 content loads.** That covers 66 of id1's 68 maps (the 2 BSP2
  vault maps load since #126), hipnotic's 18, rogue's 17, ctf's 10, mg1's 3 deathmatch
  maps and mg3's `secret1`. Each spawns and runs 100 server frames
  headless. At `d6f2058`, two bugs made it unplayable; both are now fixed:
  1. **Picking up any weapon or ammo stopped the server.** The rerelease
     `W_WantsToChangeWeapon` calls `ex_CheckPlayerEXFlags`, which was bound to
     `PF_Fixme`. Its "unimplemented builtin" error became a `Host_Error`.
     Fixed in #111.
  2. **Finding a secret disconnected the client.** `multi_trigger` writes
     `svc_achievement` (52) on every secret. The client had no case for 52, so it
     hit "Illegible server message". Fixed in #112.
- **The text showed raw keys.** id1's QuakeC uses 135 distinct `$key` strings,
  such as `$qc_item_health`. Nothing resolved them, so pickups, triggers and
  the finale printed the keys. Fixed in #124: all but `$qc_death_knight`, which
  `loc_english.txt` itself lacks, now resolve, as do every string in the
  hipnotic, rogue, mg1, mg3, dopa and ctf progs.
- **58 of the 192 `.bsp` files are BSP2.** The 192 are 171 maps plus 21
  `b_*` box models; ctf's `archive/` copies are left out. The BSP2 files are
  all 13 maps of Dimension of the Past (`dopa`), 22 of 25 in Dimension of the
  Machine (`mg1`), 19 of 20 in Dimension of the Doomed (`mg3`) plus its 2
  `maps/bmodel/b_*` models, and 2 id1 vault maps. At `d6f2058` every one
  failed on `Mod_LoadBrushModel`'s version check. #126 loads them all, and
  47 of the 56 maps spawn and run headless.
- **The 9 BSP2 maps that failed hit the protocol's limits.** Phase 4 raised
  them, and all 9 now spawn and run headless:
  - All 9 need more than 256 models (`MAX_MODELS`), counting the QC's
    precaches. `mg3/secret2`'s 525 submodels also filled `MAX_MOD_KNOWN` 512.
  - `mg3/secret2` has 1572 entities at load, against `MAX_EDICTS` 1024.
  - 5 maps extend past the ±4096 coordinate range. They spawned and ran
    headless before, but positions past it would have wrapped on the wire.

## Status of each gap

Status values: **done**; **partial**; **missing**; **n/a** (not needed for the
rerelease). The sizes are rough: **S** is a day or less, **M** a few days, **L** a
week or more.

| # | Gap | Status | Evidence | Size | Files it would touch |
|---|-----|--------|----------|------|----------------------|
| 1a | `ex_CheckPlayerEXFlags` | **done** (#111) | Fixed: `src/pr_cmds.js:2066` binds it to `PF_CheckPlayerEXFlags`, which returns 0 as Ironwail's does. Before #111 it was bound to `PF_Fixme`. Every progs calls it from `W_WantsToChangeWeapon`, on weapon and ammo pickups (`quakec/items.qc:537,722,1393`). Ironwail returns 0 (`Quake/pr_cmds.c` `PF_CheckPlayerEXFlags`). | – | – |
| 1b | `ex_walkpathtogoal` | **done** (#111) | Fixed: `src/pr_cmds.js:2067` binds it to `PF_walkpathtogoal`, which returns 0 (`PATH_ERROR`). Before #111 it was bound to `PF_Fixme`, which blocked mg1 and dopa. `quakec_mg1/ai.qc:798-812` calls it whenever a melee or mixed monster chases. The dopa progs is built from the mg1 code. Ironwail returns 0 (`PATH_ERROR`), and the QC falls back to `movetogoal`. | – | – |
| 1c | `ex_finaleFinished` name | **done** (#111) | Fixed: `src/pr_cmds.js:2156` maps `ex_finaleFinished` to the `ex_finalefinished` slot, a deliberate deviation from Ironwail. Before #111: the progs exports `ex_finaleFinished` (capital F). `src/pr_cmds.js:2065` registers `ex_finalefinished`, and `PR_InitProgsBuiltins` (`:2173`) matches case-sensitively, so it was never bound. An unbound `#0` function enters at statement 0 (`OP_DONE`) and returns 0, which happens to match `PF_finalefinished` (Ironwail has the same name mismatch). | – | – |
| 1d | Other progs builtins | **done** (harmless) | Every rerelease progs also declares `ex_draw_*` (debug), `ex_bot_*` (bots) and `checkextension` (#99). The ctf progs adds `setcolor` (#401) and `ex_prompt`/`ex_promptchoice`/`ex_clearprompt`. The unbound `#0` ones return 0 silently. `setcolor` and the prompts are only called after `cvar("pr_checkextension")` and `checkextension(...)` checks, which are false here. mg3's `draw_bounds` is debug-only. | – | – |
| 1e | `svc_achievement` (52) | **done** (#112) | Fixed: `svc_achievement` is defined in `src/protocol.js:103`, and `src/cl_parse.js:1653` reads and ignores the string. Before #112: QC writes it in id1 (18 sites), hipnotic (13), mg1 (11), mg3 (16), rogue (8) and ctf (1). It comes from `multi_trigger` on every secret, and from intermissions and kills. The `src/cl_parse.js:1425` default case called `Host_Error`. Ironwail reads and ignores the string (`Quake/cl_parse.c:1374`). No other KEX svc is written by QC. | – | – |
| 1f | `campaign`, `horde`, `sv_cheats` cvars | **done** (#113) | Fixed: `src/host.js:109-111` defines them, `Host_InitLocal` registers them (`:242-244`), and `server/game_server.js` registers them for the game server, which doesn't call `Host_InitLocal`. Before #113: every `StartFrame` runs `cvar_set("campaign", …)` (`quakec/world.qc:369`). With no such cvar, `Cvar_Set` (`src/cvar.js:186`) printed "variable campaign not found" every server frame: 101 times in a 100-frame headless run. `horde` turns on mg1's horde mode. Ironwail registers all three (`Quake/host.c:91-93`). | – | – |
| 2 | Localisation | **done** (#124) | `loc_<language>.txt` is in id1's `pak0.pak` under `localization/` (1645 keys, 213 `{}` placeholders, UTF-8) and in `QuakeEX.kpf`. Ironwail resolves keys on the server: in `PF_VarString` (`Quake/pr_cmds.c:60-95`, with `{}` placeholders) and `PF_WriteString` (`:1583`, which covers `svc_finale "$qc_finale_end"`). Its loader is `LOC_*` in `Quake/common.c:3687-4070`, with a `language` cvar. Map names are plain text, and the classic `.lmp` menus need no keys. Only `mapdb.json` episode names use them (menu only); the port has no such menu. #124 ports Ironwail's loader and both call sites, and calls `LOC_Init` in the room server too. It reads the strings from the paks only, not from `QuakeEX.kpf`. | M | `src/common.js` (`LOC_*`, `UTF8_ToQuake`), `src/pr_cmds.js` (`PF_VarString`, `PF_WriteString`), `src/host.js` and `server/game_server.js` (`LOC_Init`), new tests |
| 3 | BSP2 maps | **done** (#126) | Fixed: `Mod_LoadBrushModel` (`src/gl_model.js:2768`) accepts `BSP2VERSION_BSP2` (`src/bspfile.js:44`) and passes a `bsp2` flag to `Mod_LoadEdges`, `Mod_LoadFaces`, `Mod_LoadMarksurfaces`, `Mod_LoadLeafs`, `Mod_LoadNodes` and `Mod_LoadClipnodes`, ported from Ironwail's `Quake/gl_model.c` (`Mod_LoadNodes_L2` `:1549`, `Mod_ProcessLeafs_L2`, `Mod_LoadClipnodes(…, bsp2)` `:1923`). BSP2 has no leaf limit. `medge_t.v` and `edict_t.leafnums` (`src/progs.js:111`) widened to 32 bits as in Ironwail. Clipnode children were already `Int32Array`, and `world.js` and `pmove.js` walk them unchanged. BSP29 loads byte-for-byte as before (176 BSP29 maps compared). 2PSB is still refused: the rerelease has none. Before #126: `src/gl_model.js:2578` accepted only version 29. The rerelease has 58 BSP2 files (56 maps and 2 box models). The largest is `mg1/hub`: 68228 leafs, 228829 vertexes, 412867 edges. | – | – |
| 4a | Signon size | **done** (#96) | Signon buffers of `MAX_MSGLEN/2`, up to 256 of them (`MAX_SIGNON_BUFFERS`, `src/server.js`), allow about 1 MB of signon. Even 2000 baselines at 35 bytes each fit. | – | – |
| 4b | Edict count | **done** (phase 4) | Fixed: `MAX_EDICTS` is 32000 (`src/quakedef.js:32`), as in Ironwail. Packet entities carry the number in 15 bits (`PE_ENT_BITS`, `src/protocol.js:212`). The server's edict array grows on demand (`ED_GrowEdicts`, `src/pr_edict.js`), as do the client's `cl_entities` (`CL_EnsureEntities`, `src/client.js`) and `sv_phys.js`'s push tables, so small maps allocate no more than before. `mg3/secret2` has 1467 edicts after 100 frames. Ironwail's `max_edicts` cvar is not ported. Before: `MAX_EDICTS` 1024 was bounded by `PE_ENT_BITS` 10. Before skill filtering, `mg3/secret2` has 1572 entities that aren't lights or `info_null`, and `mg3/map8` has 988. | – | – |
| 4c | Model and sound indexes | **done** (phase 4) | Fixed: `MAX_MODELS` 4096 and `MAX_SOUNDS` 2048 (`src/quakedef.js:34-35`), and `MAX_MOD_KNOWN` 2048 (`src/gl_model.js:673`), as in Ironwail. Under `PROTOCOL_ICARO` (1015, `src/protocol.js:22`) models are shorts in packet entities, baselines, `svc_spawnstatic`, `svc_clientdata` and `svc_playerinfo`, and `svc_spawnstaticsound` sends a short. `svc_sound` and `svc_localsound` use Ironwail's `SND_LARGEENTITY` and `SND_LARGESOUND` flags. The `SV_SpawnServer` submodel loop now stops with a `Host_Error` when the map has more submodels than `MAX_MODELS`. `mg3/secret2` precaches 607 models; the most sounds on any map is 209. Before: models are sent as bytes in packet entities (`src/sv_main.js:854`), `svc_playerinfo` (`:1572`), baselines (`:1969`) and `svc_spawnstatic` (`src/pr_cmds.js:1472`). Sounds are bytes at `src/sv_main.js:254`. Six maps have more than 200 brush submodels before the QC precaches: `mg1/mge2m2` 285, `mge5m2` 202; `mg3/map2b` 255, `map7` 230, `map8` 364, `secret2` 525. With the QC's precaches, `mg1/mge2m1` and `mg3/map4` and `map6` pass 256 too: the headless run after #126 ends them in `PF_precache_model: overflow`. The `SV_SpawnServer` submodel loop (`src/sv_main.js:2119-2123`) also reads `localmodels[ i ]` past `MAX_MODELS` with no bounds check, so it fails with a crash rather than an error (`Mod_ForName: NULL name` on `mge2m2` and `map8`). `secret2` first fills `mod_known` (`MAX_MOD_KNOWN` 512, `src/gl_model.js:667`; Ironwail 2048). Ironwail: `MAX_MODELS` 4096, `MAX_SOUNDS` 2048, `U_MODEL2` and large-sound flags (`Quake/protocol.h:64`). | – | – |
| 4d | Coordinate range | **done** (phase 4) | Fixed: under `PROTOCOL_ICARO` every coordinate is an int32 of eighths of a unit (`MSG_WriteCoord`, `src/common.js`), as Ironwail's `PRFL_INT32COORD`. `MSG_WriteCoord16` keeps the short form. Prediction needed no change: `pmove.js` still snaps to 1/8 unit. All 5 maps spawn and run headless; `mg1/mge4m2` reaches -5184. Before: `MSG_WriteCoord` (`src/common.js:423`) writes a short in eighths of a unit, ±4096. World bounds pass ±4096 on `id1/vault/jrwiz3`, `mg1/mge1m2`, `mge4m1` and `mge4m2` (±5183), and `mg3/secret1`. Ironwail uses `PROTOCOL_RMQ` with `PRFL_INT32COORD` or float coords (`Quake/protocol.h:31-37`, default `sv_protocol` 999). | – | – |
| 5 | `.lit` coloured lighting | **done** (#137) | Fixed: `Mod_LoadLighting` (`src/gl_model.js`) ports Ironwail's loader (`Quake/gl_model.c:860-895`): it reads `maps/<name>.lit`, checks `QLIT`, version 1, the size and the search-path priority, and otherwise keeps the BSP's mono data, which stays one byte a sample (Ironwail expands it to RGB). `GL_BuildLightmaps` (`src/gl_rsurf.js`) switches to 4-byte RGBA blocks only when a loaded model has a `.lit`, and `R_BuildLightMap`, `R_AddDynamicLights` and the upload carry RGB. `R_LightPoint` (`src/gl_rlight.js`) fills `lightcolor` and returns its mean. `COM_EnsureFile` (`src/pak.js`) fetches the deferred `.lit` with its map. Checked on all six games' data: 127 `.lit` files, all QLIT version 1 (id1 42, mg1 25, mg3 20, dopa 13, hipnotic 18, ctf 9, rogue none). Alias models are tinted by `lightcolor`: `R_SetupAliasLighting` (`src/gl_rmain.js`) carries it through id's clamps as QuakeSpasm's `R_SetupAliasLighting` does, and `src/gl_mesh.js` shades each channel. | – | – |
| 6a | Fog | **done** (#134) | Fixed: `src/gl_fog.js` ports Ironwail's `Quake/gl_fog.c`: `Fog_ParseWorldspawn` reads the worldspawn `fog` key (42 id1, 17 hipnotic and 9 ctf maps), and the `fog` command takes all its argument forms, timed fades included, so mg1, mg3 and dopa's `stuffcmd(…, "fog …")` (`quakec_mg1/fog.qc`) works. Their `fog_*` entity keys are QuakeC fields that feed those commands. Three.js draws it as `FogExp2`, set only while the fog is on. The sky gets Ironwail's flat `r_skyfog` mix (worldspawn `skyfog`, set by 35 mg1, mg3, dopa and ctf maps) instead of distance fog. `svc_fog` isn't needed: QuakeC uses `stuffcmd`. | – | – |
| 6b | Skyboxes | **missing** | 15 mg1 and mg3 maps set `_sky` (for example `mge2m1/mge2m1_`), and their paks ship `gfx/env/*.tga` (mg1 66, mg3 78). Ironwail strips the leading `_` and loads the box (`Quake/gl_sky.c:557-600`). Here `pak.js` defers `.tga`, and there is no skybox renderer or TGA loader. | M | `src/gl_warp.js` or a new `src/gl_sky.js`, `src/pak.js`, an image loader |
| 6c | Entity `alpha` | **done** (phase 4, brush models only) | Fixed: `ED_ParseEdict` reads the `alpha` key with `ENTALPHA_ENCODE` (`src/pr_edict.js`), and the progs field is read when it exists. Packet entities carry it as `PE_ALPHA`, and baselines and statics carry it under `PROTOCOL_ICARO`. Entities at `ENTALPHA_ZERO` with no effects are not sent, and such statics are freed, as in Ironwail. `src/gl_entalpha.js` draws brush entities blended. Alias models, sprites, the player and the view model ignore alpha. Before: 233 mg1 and 321 mg3 entities have an `alpha` key, and the mg1 progs declares `.float alpha`. `src/pr_edict.js:917` only suppresses the "not a field" warning. The protocol carries no alpha. Ironwail: `U_ALPHA` (`Quake/protocol.h:62`), with `ENTALPHA_ENCODE` in `ED_ParseEdict` (`Quake/pr_edict.c:1391`). | – | – |
| 6d | `EF_QUADLIGHT`, `EF_PENTALIGHT`, `EF_CANDLELIGHT` (16, 32, 64) | **done** (#143) | Fixed: `PR_FindSupportedEffects` (`src/pr_edict.js`) ports Ironwail's gate (`Quake/pr_edict.c`): the bits are on only when the progs defines `EF_QUADLIGHT` 16 and `EF_PENTALIGHT` (or `EF_PENTLIGHT`) 32 as floats, as the rerelease `defs.qc` does. Otherwise the server masks them out of the effects byte (`SV_WriteEntitiesToClient`, `SV_WritePlayersToClient`), so mods that use those bits differently are left alone. No wire change: the client handles the bits whenever they arrive. `CL_QexEffectLights` (`src/cl_main.js`) gives quad a blue and pent a red dlight, as Ironwail's `Quake/cl_main.c:654`, from all three linking paths (players, packet entities, NQ demos). `EF_CANDLELIGHT` gets no light, as in Ironwail. `dlight_t` now has QuakeSpasm's `color`: it tints the RGB lightmaps of `.lit` maps, the alias-model shade and the `gl_flashblend 1` PointLights. Mono lightmaps (maps without a `.lit`) stay white. | – | – |
| 6e | Liquid alpha keys | **done** | `R_ParseWorldspawn` strips the leading `_` (`src/gl_rsurf.js:474-516`), so the rerelease's `_lavaalpha` and `_slimealpha` keys work. | – | – |
| 6f | Music | **done** | `music/trackNN.ogg` is looked up per game dir (`main.js:123-127`). id1, hipnotic, rogue and mg3 ship `music/`. | – | – |
| 6g | `menu_credits` | **done** | `src/menu.js:3157`. `finale_6` runs it after the end. | – | – |
| 6h | Missing `default.cfg` | **done** (#113) | Fixed: when `default.cfg` isn't found, `Cmd_Exec_f` runs the embedded QuakeSpasm one (`src/cmd.js:490-493`, `src/default_cfg.js`), as Ironwail does (`Quake/cmd.c:277`, `default_cfg.h`). Before #113: the rerelease id1 has no `default.cfg`, but its `quake.rc` runs `exec default.cfg`. `src/host.js:471-477` adds WASD, jump and attack bindings, but weapon keys and the rest of id's defaults were missing. | – | – |
| 6i | Console noise | **done** (#113, `vibrate`) | `quake.rc` sets `scr_usekfont 1`; #113 registered that cvar (`src/gl_screen.js:64`, read by nothing yet). `vibrate` is registered as a no-op (`src/host_cmd.js:101`, `Host_Vibrate_f` at `:1847`; `tests/host_vibrate_test.js`). The earlier claim that QC stuffs it at 20 sites was wrong: no shipped `progs.dat` (id1, hipnotic, rogue, mg1, mg3, ctf, dopa), pak or `QuakeEX.kpf` contains `vibrate`. The 20 were id1's `tactile/*.bnvib` files. The published QC has `stuffcmd (self, "vibrate tactile/....bnvib")` at ten sites in `weapons.qc`, all commented out, so no "Unknown command" was ever printed for it. The command is there for a mod that re-enables those lines; Ironwail has none. It ignores its arguments and drives no haptics. | – | – |
| 6j | ctf `archive/` in the browser | **done** (#114) | Fixed: `DEFERRED_DIRS` (`src/pak.js:647`) now lists `archive/` with `tactile/` and `vault/`. Before #114: ctf's `pak0.pak` has an `archive/` tree of 172 entries (93 MB of `.exe`, `.zip`, `.bsp`, …), and `?game=ctf` fetched all of it at load. | – | – |
| 6k | MD5 replacement models | **done** | `r_enhancedmodels` (default 1, archived, as in Ironwail) draws `progs/<name>.md5mesh` with its `.md5anim` in place of the `.mdl` when it is in the `.mdl`'s search path or a higher one (`Mod_LoadMD5Replacement`, `src/gl_model.js`). The parser and skinning are in `src/gl_md5.js`, after Ironwail's `Mod_LoadMD5MeshModel` (`Quake/gl_model.c`): Quake frame n is anim frame n, and skins are `progs/<shader>_SS_FF.lmp`. The `.mdl` stays loaded for bounds, flags, frame names and the server. Each pose is skinned on the CPU once and drawn through the `.mdl` path, so lerping, `.lit` tint, alpha, fog, shadows and the colormap work. Lazy paks fetch the MD5 files when the model loads. id1 has 59 `.md5mesh` and 58 `.md5anim`, mg3 5 of each. | – | – |
| 6l | `.mdl`, `.spr` and `.wav` formats | **done** | Every `.mdl` is IDPO version 6, at most 1912 vertices, 1923 triangles and 250 frames, with skins up to 512×480. That is within `MAXALIASVERTS` 2400, `MAXALIASTRIS` 4096 and `MAX_LBM_HEIGHT` 480. Sprites are IDSP version 1. The `.wav` files are PCM, mostly 44.1 kHz 16-bit mono (378 files). Wav playback was not tested. | – | – |
| 6m | Bots, `.nav`, KEX saves, `mapdb.json`, KEX fonts | **n/a for now** | Bots need the `ex_bot_*` builtins and the `bots/*.nav` graphs; Ironwail doesn't do them either. KEX saves (`SAVEGAME_VERSION_KEX` 6, `Quake/host_cmd.c:2574`) matter only for importing them. `mapdb.json` drives the KEX add-on and episode menu. `scr_usekfont` fonts are in `QuakeEX.kpf`. | M–L each | – |
| – | Pak loading (#84), folder layout (#89) | **done** | Both are merged to `dev` (`cba28aa`, `85807a3`). | – | – |

## Headless spawn

`static/rerelease/<game>/pak0.pak` was loaded on the Deno server code with a
throwaway script, not committed. For each map it ran `SV_SpawnServer` and then
100 frames of `SV_Physics` at 0.05 s, with `svs.maxclients` 1 and no client
connected. The BSP2 maps were rerun the same way on the #126 branch, over
id1's `pak0.pak`.

| pak | maps (excluding `b_*`) | spawn and run | fail |
|-----|----------------|---------------|------|
| id1 | 68 (42, plus 15 `test/` and 11 `vault/`) | 68 (`tboss` and `tim14` since #126) | – |
| hipnotic | 18 | 18 | – |
| rogue | 17 | 17 | – |
| ctf | 10 | 10 | – |
| mg1 | 25 | 25 (`mge2m1`, `mge2m2` and `mge5m2` since phase 4) | – |
| mg3 | 20 | 20 (`map2b`, `map4`, `map6`, `map7`, `map8` and `secret2` since phase 4) | – |
| dopa | 13 | 13 | – |

Before #126, all 56 BSP2 maps failed: 22 in mg1, 19 in mg3 and all 13 in
dopa, plus the 2 vault maps. The 2 BSP2 `maps/bmodel/b_*` models in mg3 load
since #126 too. Run in one process, the mg3 maps after `secret2` fail on a
full `mod_known`, since `Mod_ClearAll` keeps the slots as in the C. Each was
rerun in its own process. Of the 47 BSP2 maps that run, the most edicts
after 100 frames is 680 (`mg3/map2`, `map5`), and 3 have more than 32767
leafs (`mg1/hub`, `start` and `mg3/map5`).

Phase 4 reran 109 maps the same way, each in its own process: id1's 40
`maps/*.bsp` and 11 `vault/` maps, and every mg1, mg3 and dopa map. All 109
spawn and run 100 frames. The largest counts are on `mg3/secret2`: 607
models and 1467 edicts. The most sounds is 209. The 9 maps that failed
before precache 269 (`mg1/mge2m1`) to 607 models. The 5 coordinate maps'
world bounds reach -5184 (`mg1/mge4m2`).

The most edicts in use after 100 frames was 541, on `rogue/r2m6`. The
mission-pack flags (`-hipnotic`, `-rogue`) were not set. Calling the rerelease's
`W_WantsToChangeWeapon` directly ended in "unimplemented builtin" and then
`Host_Error: Program error`, as item 1a predicts (fixed since, in #111).

## Suggested order

The order follows how much content each step makes playable.

**Phase 1: make the BSP29 remasters playable (all S).** This covers id1, hipnotic,
rogue, ctf, and the BSP29 maps in mg1 and mg3. All done.

1. Builtins 1a, 1b and 1c (`src/pr_cmds.js`). Done in #111.
2. `svc_achievement` 1e (`src/protocol.js`, `src/cl_parse.js`). This is client-side only: the
   server already passes QC's bytes through. Done in #112.
3. Cvars 1f, plus the 6i no-ops. The cvars and `scr_usekfont` are done
   (#113); the `vibrate` no-op is in `src/host_cmd.js`, though no shipped
   progs sends it (see 6i).
4. `default.cfg` fallback 6h (`src/cmd.js`). Done in #113.
5. The `archive/` deferral 6j (`src/pak.js`). Done in #114.

**Phase 2: localisation (M).** Item 2. Pickups, triggers and the finale need it to read
properly. Done in #124.

**Phase 3: BSP2 (L).** Item 3. Done in #126. This unlocks dopa, the rest of mg1 and mg3, and the two vault
maps. Of those, all but the 9 maps named in phase 4 run within today's
limits. That relies on the `walkpathtogoal` fix from phase 1 (#111).

**Phase 4: protocol limits (L).** Items 4b, 4c and 4d, with entity alpha (6c) in the same
change. Done on `agent/loving-ramanujan-d1bce5`, as `PROTOCOL_ICARO` (1015);
the client still reads protocol 15 for the demos. This unlocks nine maps for models (`mg1/mge2m1`, `mge2m2` and `mge5m2`; `mg3/map2b`, `map4`, `map6`, `map7`,
`map8` and `secret2`), `mg3/secret2` (and probably `map8`) for edicts, and five maps for coordinates.
`secret2` also needs `MAX_MOD_KNOWN` raised.
AGENTS.md requires a message-format change to update the client and server in one PR. The
NQ protocol 15 path must keep working, because the attract demos
(`demo1`–`demo3`, which `quake.rc` starts at boot) are protocol 15. Icaro does
not have to adopt Ironwail's 666 or 999 wire formats, because the client and server ship together.

**Phase 5: fidelity (M each).** In rough order of visible effect:

1. `.lit` (5). Done in #137, with the alias-model tint after it.
2. Fog (6a). Done in #134.
3. Skyboxes (6b)
4. The QEX effect lights (6d). Done in #143.
5. MD5 models (6k). Done.

### What can run in parallel

These share files, so run them in sequence or bundle them. Items already done
(#111–#114, BSP2 in #126, `.lit` in #137, fog in #134, MD5 models (6k), and
the protocol limits and alpha of phase 4) are left out:

- **`src/protocol.js` and `src/cl_parse.js`:** `svc_fog`, if it is ever sent.
- **`src/pak.js`:** skybox `.tga` (6b). It changes
  `DEFERRED_EXTENSIONS` or `DEFERRED_DIRS`, or adds a `COM_EnsureFile` at map
  load. `.lit` (5, #137) shows the pattern: `COM_EnsureLitFile`.
- **`src/gl_rmain.js`:** Entity alpha (6c) adds one
  call into `src/gl_entalpha.js` there.

Groups that can run at the same time:

- **Now:**
  - Fog (new `gl_fog.js`, `gl_rmain.js`). Done in #134; its `gl_rmain.js`
    change is one call into `gl_fog.js`.
  - Skyboxes (`gl_warp.js` or `gl_sky.js`). `.lit` has landed in `pak.js`.

## Not verified

- Nothing ran in a browser, and no client connected. The two blockers come
  from reading the code. 1a was confirmed by calling the QC function headless; 1e
  was not exercised. The fixes in #111 and #112 have unit tests
  (`tests/qc_extension_builtins_test.js`, `tests/cl_parse_achievement_test.js`),
  but no rerelease map has been played since.
- The attract demos were checked for their protocol number (15). Since phase
  4, `tests/protocol_icaro_test.js` parses `demo1` through to its end headless;
  none was played in a browser. Icaro's
  `svc_packetentities`, `svc_deltapacketentities` and `svc_serversequence`
  (47–49, `src/protocol.js:205-207`) reuse KEX's numbers for
  `svc_updatesocial`, `svc_updateplinfo` and `svc_rawprint`. A demo that contains those would misparse. Single-player
  demos probably don't.
- 44.1 kHz 16-bit `.wav` playback and `.ogg` music under `?base=rerelease` were not tested.
- The model counts in rows 4b and 4c are
  brush submodels only, before QC precaches; the phase 4 run under "Headless
  spawn" counts the precaches and sounds. The edict counts are static map
  entities, before skill and deathmatch filtering and runtime spawns.
- Datagram size on big maps was not measured: `MAX_DATAGRAM` is 1024, and WebTransport datagrams are
  about 1200 bytes. More visible entities per frame may drop packet entities.
  Phase 4's wider coordinates and model numbers make each entity update a few
  bytes larger.
- The headless run did not set `-hipnotic`/`-rogue` (they affect the HUD and some engine
  behaviour), and used default skill and `deathmatch 0`.
