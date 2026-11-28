# Audit: mod and community-standard compatibility, and the protocol strategy

Snapshot of `dev` at `2798ac9` (branch `agent/vision-rules`), 2026-11-26.
Read-only audit; no engine code was run. Icaro citations are `file:line` as seen
at that revision. Reference ports were read from their default branches on
GitHub (HEAD, not a tag), so cite them by function or file, not line. Anything
not checked is under "Not verified".

Reference source read: QuakeSpasm `sezero/quakespasm` (QS), Quakespasm-Spiked
`Shpoike/Quakespasm` (QSS), Ironwail `andrei-drexler/ironwail` (IW, release
0.8.2). Mod sources read: Arcane Dimensions (`SimsOCallaghan/ArcaneDimensions`),
progs_dump (`progs-dump-dev/progs_dump`), LibreQuake
(`lavenderdotpet/LibreQuake`, v0.09-beta release, main at 2026-11-25).

Open PRs touching this track: #240 (BYO paks) edits `src/cl_demo.js`,
`src/pak.js`, `main.js`, `src/menu.js`, adds `src/userdata.js`. It overlaps
findings 1 (demos), 4 (game directories) and 8. #235, #238 and #241 to #243 were
not inspected (#235 and #238 were not in the list I was given and `gh` shows
#238 as merged); #243 and #244 are the RL tier and look unrelated.

## Status

Checked at `dev` `3603119` (2026-11-27). The rest of this file is the older
snapshot.

- Finding 3: Ironwail's builtin set and its `checkextension` answer are ported
  (#255), with `pr_checkextension` (default 1). The Quakespasm-Spiked tier
  isn't. No mod was run. This changes the matrix's `checkextension` row to
  Ironwail's one name and the `str2chr` row to yes.
- Finding 6: fence textures are alpha-tested (#253), tried in a browser on
  rerelease maps but no Quoth or AD map. Lit water is open. MF_HOLEY skins and
  sprites don't get the edge fix.
- Finding 4: `headless_host` mounts game directories (#252). `?game=` takes any
  safe directory name and `-quoth` exists (#277). The headless host mounts
  several `-game` directories; a URL names one and the servers take one.
  LibreQuake is the default content as `?base=librequake`, not as an `lq1` game
  directory.
- LibreQuake section: no pak is tracked (#270). `demo1.dem` (protocol 15),
  `demo2.dem` (since #262) and `demo3.dem` (protocol 999, since #278) play.
  `set`, `seta`, the key names and more cvars are accepted (#263, #289, #290);
  `if` isn't. Loose cfgs can be `exec`ed (#281). Fence textures are done.
- Finding 1: the client reads 666 and 999 (#274, #278). No 666 demo was run, and
  entity scale is read and dropped.
- Finding 2: Icaro's svcs moved to 96 to 99 behind a versioned hello (#288), and
  each protocol has its own handler table (#274). The 666 and 999 readers handle
  37 and 40 to 44. The 15 reader and Icaro's revision 1 reader don't; revision
  0, kept for old Icaro demos, reads 42 as `svc_playerinfo`.
- The others weren't rechecked.

## Summary

- The client reads only protocol 15 and Icaro's private 1015. A demo or server
  speaking 666 or 999 stops at `Host_Error` (`src/cl_parse.js:462`). This is the
  biggest mod-ecosystem gap that is not a missing feature: community demos and
  any 666/999 attract loop fail.
- QC-written messages are not the problem they look like. Every
  `WriteByte(MSG_*,
  svc_*)` that AD, progs_dump and LibreQuake emit uses
  NetQuake numbers 3 to 34 and TE 0 to 13, which the client already parses. The
  risk is only in a few messages whose 1015 layout differs from NetQuake (see
  finding 2).
- QuakeC extension coverage is the real functional gap: `checkextension` always
  returns 0 and nine Ironwail builtins are `PF_Fixme`.
- Game directories are a fixed whitelist: no `-quoth`, no arbitrary `-game`, no
  layering, no `lq1`.
- Recommendation: keep a private Icaro wire, but version it with a capability
  word, and add 15/666/999 readers on the client for demos and compat. Details
  in "Protocol strategy".

## Findings, ranked

Severity: High breaks a whole class of content; Medium breaks some content or
needs a workaround; Low is polish or rare. Effort: S under a day, M a few days,
L a week or more.

### 1. Client accepts only protocols 15 and 1015 (High, M)

- Icaro: `src/cl_parse.js:460-469` (`CL_ParseServerInfo`) and `:1560-1571`
  (`svc_version`) throw on anything but `PROTOCOL_VERSION` 15 and
  `PROTOCOL_ICARO` 1015 (`src/protocol.js:3,26`). `CL_ParseUpdate` (fast update)
  is the NetQuake form only; the Fitz bits `U_EXTEND1`, `U_ALPHA`, `U_FRAME2`,
  `U_MODEL2`, `U_LERPFINISH`, `U_SCALE` are not defined in `src/protocol.js`
  (only `SU_EXTEND1/2`, `SU_WEAPONFRAME2` and `SU_WEAPONALPHA` are, lines
  65-68).
- Reference: IW `protocol.h` (`PROTOCOL_FITZQUAKE 666`, `PROTOCOL_RMQ 999`, the
  `U_*`, `SU_*`, `B_*`, `SND_*`, `PRFL_*` tables) and `cl_parse.c`
  `CL_ParseServerInfo`, `CL_ParseUpdate`, `CL_ParseBaseline`,
  `CL_ParseStaticSound`. QS has the same set. IW's server default is 999
  (`sv_main.c`, `sv_protocol = PROTOCOL_RMQ`); QS's default is 666 (not
  re-checked).
- Effect: no 666/999 demo plays (`playdemo`, and the attract loop of any pak
  whose `demo1-3.dem` are 666/999). Whether LibreQuake's `demo1.dem` to
  `demo3.dem` are 15 or newer is not verified (binary assets, not downloaded);
  if they are 666/999, boot hits the `Host_Error` through `startdemos`.
- Recommendation: add a client-only `cl.protocol` dispatch for 666 and 999 that
  covers the NQ-style message set (no packet entities). Needs: per-protocol
  `CL_ParseUpdate`/baseline/static/staticsound/clientdata layouts, the RMQ
  `protocolflags` word (`PRFL_SHORTANGLE`, `FLOATANGLE`, `24BITCOORD`,
  `FLOATCOORD`, `EDICTSCALE`, `ALPHASANITY`, `INT32COORD`), and U_TRANS
  (Nehahra) is optional. `MSG_ReadCoord`/`MSG_ReadAngle` already switch on a
  flag (`MSG_SetCoord32`, `src/cl_parse.js:469`); generalise it to the RMQ
  flags. Overlap: #240 touches `cl_demo.js` (saves demos to browser storage); no
  conflict in `cl_parse.js`.

### 2. Wire-number and layout collisions in 1015 (High for any shared dispatch, S to fix)

- Icaro: `svc_playerinfo = 42` (`src/protocol.js:162`) is Fitz
  `svc_spawnbaseline2` (42); 43 and 44 are Fitz `svc_spawnstatic2` and
  `svc_spawnstaticsound2`, unused in Icaro.
  `svc_packetentities/deltapacketentities/serversequence` are 47/48/49
  (`:208-210`), which are KEX/IW `svc_updatesocial`, `svc_updateplinfo`,
  `svc_rawprint` (already noted in `docs/rerelease-gaps.md`). `svc_achievement`
  52 and `svc_localsound` 56 match IW (`:132,135`).
- Fitz 37 (`svc_skybox`), 40 (`svc_bf`), 41 (`svc_fog`), 42 to 44 fall to
  "Illegible server message" (`src/cl_parse.js:1543`). `bf` works as a stufftext
  command (`src/view.js:1011`), so only the raw svc is missing.
- Impact: a 666/999 demo parser cannot share Icaro's switch (`:1546-1787`)
  without a protocol check, and the 1015 numbers will confuse any future tool
  that decodes both. QC rarely writes 37 to 44 by hand, so mod risk is low.
- Recommendation: dispatch by `cl.protocol` (a small table per protocol) rather
  than renumber now. When the Icaro standard is defined, move its private svcs
  to a reserved high range (see strategy).

### 3. QC extension builtins and `checkextension` (High, M)

- Icaro: `src/pr_cmds.js:1404` `PF_checkextension` returns 0 for every name
  (documented deviation at `:1394-1403`). `PF_Fixme` rows that IW implements
  (`:1854-1891`): `str2chr` 222, `chr2str` 223, `strconv` 224, `clientstat` 232,
  `checkcommand` 294, `vectorvectors` 432, `clientcommand` 440, `asin`/`acos`/
  `atan`/`atan2`/`tan` 471-475, `tokenize_console` 514. The CSQC draw and stat
  builtins 316-352 are also `PF_Fixme`, and IW has them as CSQC-only stubs too.
- Reference: IW `pr_cmds.c` builtin table (`pr_builtindefs`, near the end of the
  file) and `PF_checkextension`: IW answers true only for `FTE_QC_CHECKCOMMAND`
  (so AD takes its FTE path) and implements the list above. Plain QS `pr_cmds.c`
  has no `checkextension` and no extension builtins beyond the rerelease slots
  79 and 80 (`PF_finalefinished`, `PF_localsound`); so at QS level Icaro is
  already equal. At IW level it is not. QSS `pr_ext.c` (`qcextensions`, near the
  end) advertises about 110 names (DP_QC__, DP_SV__, FTE_*, FRIK_FILE,
  ZQ_QC_STRINGS, EXT_BITSHIFT, EX_EXTENDED_EF, ...) and implements the large
  builtin set behind them (FRIK_FILE `fopen`..., `strstrofs`, `strpad`,
  `bitshift` 218, `fgets`, `hash`, `argv`, `crossproduct`, `tracebox`,
  `copyentity`, `findchain*`, strbuf, ...). Not ported.
- Mod evidence: AD's `fteextensions.qc` declares #100 to #245 builtins and calls
  `checkextension` for `FTE_SV_POINTPARTICLES` (4 sites), `FRIK_FILE` (3),
  `FTE_STRINGS`, `FTE_PART_NAMESPACE_EFFECTINFO`, `FTE_ENT_SKIN_CONTENTS`,
  `EXT_BITSHIFT`, `DP_TE_PARTICLESNOW`, `DP_TE_PARTICLERAIN`, `DP_SV_SETCOLOR`,
  `DP_SV_ROTATINGBMODEL`, `DP_SV_POINTPARTICLES`, `DP_QC_SPRINTF`,
  `DP_QC_SINCOSSQRTPOW`, `DP_QC_RANDOMVEC`, `DP_QC_MINMAXBOUND`,
  `DP_QC_GETSURFACE`, `DP_GFX_FOG`. Returning 0 keeps AD on its vanilla paths
  (that is what QS and IW do for all but one name), so AD runs at "QS parity"; I
  did not run AD to confirm its fallbacks. progs_dump's `defs.qc` uses only id
  builtins plus `SVC_SETVIEWPORT` (5), `SVC_SETVIEWANGLES` (10) and
  `SVC_CUTSCENE` (34), all handled (`src/cl_parse.js:1546-1787`). LibreQuake's
  NQ progs use only id builtins and `stof` #81 (`qcsrc/defs.qc`).
- Quoth and Copper QC were not read (not found on GitHub in this pass).
- Recommendation, in order: (a) implement the IW set above (all small; IW is the
  reference; S to M); (b) keep `checkextension` returning 0 except
  `FTE_QC_CHECKCOMMAND` once `checkcommand` exists, as IW; (c) treat QSS's
  FRIK_FILE/strbuf/`tracebox`/`findchain*` as an opt-in tier driven by what real
  mods need (M to L). Do not claim DP_/FTE_ names for which builtins are
  missing: mods trust the answer.

### 4. Game directories: no `-quoth`, no arbitrary `-game`, no layering, no `lq1` (High, M)

- Icaro: `main.js:60-61` has `MISSION_PACKS = ["rogue","hipnotic"]` and
  `GAME_DIRS = ["mg1","mg3","dopa","ctf"]`; `main.js:118-129` ignores any other
  `?game=` value; `main.js:198-217` loads at most one directory beyond id1 and
  fails if it has no `pak0.pak`. `src/common.js:777-779` knows `-rogue` and
  `-hipnotic` only; `src/common.js:696` says there is no `-game` or `-path`.
  `grep -ri quoth` finds nothing in `src/`, `server/`, `docs/`. Loose files in a
  mod directory are fetched per file from a configured base path
  (`COM_SetLooseFileBasePaths`, `main.js:220-221`), not discovered.
- Reference: IW `common.c`: `COM_InitFilesystem` adds `-rogue`, `-hipnotic` and
  `-quoth` in that order and then each `-game` (more than one is allowed, and
  `COM_AddGameDirectory` treats `hipnotic` and `quoth` specially so the HUD
  switches: `if (!q_strcasecmp(dir,"hipnotic") || !q_strcasecmp(dir,"quoth"))`);
  `COM_CheckParm("-hipnotic") || COM_CheckParm("-quoth")` sets the hipnotic flag
  (the Quoth HUD is Hipnotic's). QS equivalent. IW also lists
  `id1, hipnotic, rogue, dopa, mg1` as episode dirs for the rerelease.
- Effect: Quoth, AD (`ad/`), Copper and every total conversion cannot be named
  at all. LibreQuake (`lq1`) cannot be selected; its `lq1/` layout is `pak0`/
  `pak1` plus loose `default.cfg`, `quake.rc`, `progs/`, `maps/`.
- Recommendation: replace the two whitelists with a validated name pattern
  (`[a-z0-9_]{1,32}`) and an ordered list (`?game=quoth,ad`), `-quoth` mapping
  to `hipnotic = true` plus the directory, and per-directory `pak*.pak`
  discovery by trying `pak0..pakN` as `COM_AddPakSequence` already does. Keep
  the no-path-traversal rule that the whitelist currently gives. Overlap: #240
  (BYO paks) is the mechanism that would supply the files; design the two
  together, and record that a mod pak is user data, never committed (AGENTS.md
  Game data).

### 5. Entity scale, lerp finish and the Fitz entity bits (Medium, M)

- Icaro: no `scale` in `src/sv_main.js`, `src/protocol.js` or the renderers; the
  server reads only `alpha`, `items2`, `gravity` and the ammo extras
  (`GetEdictFieldValue` uses in `src/sv_main.js:1489`, `src/sv_phys.js:535`,
  `src/pr_edict.js:797,1128`). Packet entities carry alpha (the `PE_*` layout,
  `src/protocol.js:176-215`) but not scale or lerpfinish.
- Reference: IW `sv_main.c` `SV_WriteEntitiesToClient` (`U_SCALE` when
  `PRFL_EDICTSCALE`; `U_LERPFINISH`), `cl_parse.c` `CL_ParseUpdate`; QSS the
  same plus `DP_ENT_SCALE`. AD declares `DP_ENT_SCALE`/`DP_ENT_ALPHA`/
  `DP_ENT_COLORMOD` via its extension list; whether AD sets `.scale` without
  `checkextension` is unverified.
- Effect: `.scale` set by a mod does nothing. `U_LERPFINISH` is how IW
  interpolates movers; Icaro has `r_lerpmove` (`src/render.js:25-42`) and its
  own step-lerp, so the visible loss is small.
- Recommendation: if the Icaro wire grows an entity-extras byte (see strategy),
  add scale and colormod there; and honour them in 666/999 demos.

### 6. Fence textures, lit water and render-side compatibility (Medium, S to M)

- Icaro: no handling of `{` (fence) world textures was found in
  `src/gl_model.js` or `src/gl_rsurf.js` (searched for `fence`, `alphaTest`,
  name checks; the only `alphaTest` is the sky layer, `src/gl_rsurf.js:2524`).
  `r_litwater` is absent (also reported in `docs/audit/client-rendering.md`).
  `.lit` is done (`src/gl_model.js:1565-1612`).
- Reference: IW `gl_model.c` `Mod_TextureType` (`texname[0] == '{'` returns
  `TEXTYPE_CUTOUT`), `haslitwater` in `Mod_LoadFaces`.
- Effect: fence textures in Quoth, AD and most modern maps would render as
  opaque palette index 255. High value for mod maps; the rendering auditor owns
  the fix. Listed here because maps in this track depend on it.
- Recommendation: S for fence alpha (treat index 255 as transparent, mipmap
  padding as IW does); M for lit water. Mark as a dependency for LibreQuake and
  AD.

### 7. BSP variants and BSPX lumps (Medium, M each)

- Icaro: BSP29 and BSP2 only (`src/gl_model.js:2589-2603`,
  `src/bspfile.js:38-42`; RMQ `2PSB` explicitly unsupported). No BSPX parsing
  (no `BSPX`, `RGBLIGHTING`, `LIGHTING_E5BGR9`, `DECOUPLED_LM`, `LMSHIFT`
  anywhere in `src/`).
- Reference: IW `Mod_LoadBrushModel` accepts `BSP2VERSION_2PSB` (`gl_model.c` at
  the two version switches) and has no BSPX. QSS `gl_model.c` (`Q1BSPX_Setup`,
  `Q1BSPX_FindLump`) reads `RGBLIGHTING` (.lit-in-bsp), `LIGHTING_E5BGR9` (HDR),
  `DECOUPLED_LM`/`LMSHIFT`/`LMOFFSET`/`LMSTYLE(16)`, light grid, and also loads
  `Q64` BSP, MD3 and IQM models.
- Effect: 2PSB maps (older RMQ and Quoth-era releases) fail with `Sys_Error`
  ("unsupported version number"). BSPX lumps are ignored, so maps still load
  (the data is after the standard lumps) but without in-BSP lighting. LibreQuake
  compiles with `qbsp -bspx` and ericw `light -bounce -dirt`
  (`lq1/maps/compile_maps.py` `LQ_GLOBAL_BSP_FLAGS`, `LQ_DEF_LIG_FLAGS`) and
  ships separate `.lit` files, so the standard content works without BSPX.
  Per-map `-bsp2` flags were not checked.
- Recommendation: 2PSB (S: a second struct layout, as in IW) first;
  `RGBLIGHTING` and `LMSHIFT` only if community maps need them (M). MD3/IQM are
  Not planned unless a mod target needs them (QSS only).

### 8. Raw `svc_fog`, `svc_skybox`, hand-written layout risks (Low to Medium, S)

- Icaro: `src/gl_fog.js:15` says `svc_fog` is not ported (the rerelease QC uses
  `stuffcmd "fog"`); same for 37 and 40-44. AD's `globalfog.qc` and `fog.qc` in
  progs_dump use stuffcmd, which works.
- 1015 layout changes that bite QC hand-writers: `svc_spawnstaticsound` takes a
  short sample (`src/protocol.js:21-24`), `svc_spawnbaseline`/`svc_spawnstatic`
  end with alpha and have shorts (`src/cl_parse.js:1101-1115`), `svc_clientdata`
  uses Fitz bits. AD and progs_dump only define `SVC_SPAWNSTATICSOUND` (29) and
  do not write it (searched; defined in `defs.qc` and `defscustom.qc`, no call).
  Nothing in the three QC trees writes a coordinate with `WriteShort`.
- Recommendation: parse 37, 40, 41 (cheap, mirrors IW `Fog_ParseServerMessage`
  and `Sky_LoadSkyBox`) in the new per-protocol table. Document in the QC author
  notes that a hand-written `svc_spawnstatic*`/`svc_spawnbaseline` is
  protocol-dependent.

### 9. Music, sound and external assets (Low, S to M)

- Icaro: CD tracks play `music/trackNN.ogg` or `.mp3` through an HTML audio
  element (`src/cd_audio.js:53-55`); sound effects load `.wav` only
  (`src/snd_dma.js:994,1006`). Music is done; tracker (`.xm`, `.it`, `.mod`),
  FLAC and Opus music are not.
- Reference: QS/IW `bgmusic.c` `music_handlers` (mp3, ogg, opus, flac, wav, mod,
  xm, it, s3m, umx) and `snd_codec.c`.
- Effect: mods that ship tracker music (some Quoth maps use `.mod`/`.it` tracks
  through `cd play`/worldspawn `sounds`) are silent. Browsers play ogg, mp3,
  flac, opus and wav natively; trackers need a WASM decoder.
- Recommendation: add `flac`, `opus`, `wav` to `MUSIC_EXTENSIONS` (S). Trackers:
  later (M).

### 10. Savegames, demos, configs (Low, S each)

- Saves: Icaro writes the NetQuake text format version 5
  (`src/host_cmd.js:1189`, `:1320`), the same as QS and IW, so `.sav` files
  should load across them for vanilla progs (not tested). KEX/rerelease JSON
  saves are not read; IW has `json.c` for some of that; not verified which.
- Demos: Icaro writes NQ demos; its own 1015 demos from older builds no longer
  play (`src/protocol.js:21-24`). See finding 1.
- Config order: `src/host.js:544` runs `exec quake.rc`, then hard-codes WASD,
  `MOUSE1` and `cl_forwardspeed 400` (`:546-556`), then the localStorage config.
  The comment says user config can override, which is true only for the last
  step. A mod's `quake.rc` (LibreQuake runs `exec default.cfg`, `config.cfg`,
  `autoexec.cfg`, `stuffcmds`, `startdemos`) has its binds replaced for six keys
  at every boot. LibreQuake's `default.cfg` binds `+melee` (a command no engine
  here defines; the vanilla console prints "Unknown command" and continues) and
  its style cfgs set IW cvars (`hudstyle`, `r_softemu`, `r_scale`) that Icaro
  lacks (`hudstyle` not found; the others unverified).
- Recommendation: apply the web defaults before `exec quake.rc` (or only for
  unbound keys), and make unknown cvars in a cfg silent when `developer 0`.

### 11. Features QSS adds that Icaro lacks (Low for now)

PEXT2 negotiation (`PEXT2_REPLACEMENTDELTAS`, `PREDINFO`, `SETANGLEDELTA`,
`MAXPLAYERS`, `NEWSIZEENCODING`, voice), CSQC (`PEXT1_CSQC`), scriptable
particle effectinfo (`FTE_PART_SCRIPT`), `DP_CON_SET`, bot clients,
`PF_particleeffect`. Icaro has no equivalents and none is needed for the targets
in the brief. The one overlap with Icaro's own work is delta entities with
prediction (below).

## Gap matrix

`yes` = supported, `part` = partial, `no` = absent, `?` = not verified.

| Feature                         | QS 0.96         | QSS            | IW              | Icaro                                     |
| ------------------------------- | --------------- | -------------- | --------------- | ----------------------------------------- |
| Protocol 15                     | yes             | yes            | yes             | yes (client; server uses 1015)            |
| Protocol 666 / 999              | yes             | yes            | yes             | no (finding 1)                            |
| RMQ flags, `U_SCALE`            | yes             | yes            | yes             | no                                        |
| FTE PEXT1/PEXT2 negotiation     | no              | yes            | no              | no                                        |
| `PEXT2_REPLACEMENTDELTAS`       | no              | yes            | no              | no (own PE_* deltas in 1015)              |
| Client prediction               | no              | yes (PREDINFO) | no              | yes (QW pmove)                            |
| `svc_fog`/`skybox` raw          | yes             | yes            | yes             | no (stufftext works)                      |
| `checkextension` names          | none            | ~110           | 1               | none                                      |
| id builtins 1-78                | yes             | yes            | yes             | yes                                       |
| Rerelease builtins 79-81, ex_*  | yes             | yes            | yes             | yes                                       |
| `str2chr`, `strconv`, trig, ... | no              | yes            | yes             | no (`PF_Fixme`)                           |
| FRIK_FILE, strbuf, tracebox     | no              | yes            | no              | no                                        |
| CSQC                            | no              | yes            | no              | no                                        |
| `-quoth`, `-game` (multiple)    | yes             | yes            | yes             | no (finding 4)                            |
| BSP29, BSP2                     | yes             | yes            | yes             | yes                                       |
| BSP 2PSB                        | yes             | yes            | yes             | no                                        |
| BSPX lumps, Q64 BSP             | no              | yes            | no              | no                                        |
| `.lit` colour                   | yes             | yes            | yes             | yes                                       |
| Lit water                       | yes             | yes            | yes             | no                                        |
| Fence (`{`) textures            | yes             | yes            | yes             | no (?)                                    |
| External textures (tga/png)     | yes             | yes            | yes             | ? (not checked)                           |
| Sprites                         | yes             | yes            | yes             | yes (`src/gl_model.js:105-110`)           |
| MD3, IQM                        | no              | yes            | no              | no                                        |
| MD5 replacements                | no              | no             | yes             | yes (#146)                                |
| Music ogg/mp3                   | yes             | yes            | yes             | yes                                       |
| Music flac/opus/tracker         | yes             | yes            | yes             | no                                        |
| Savegame v5 text                | yes             | yes            | yes             | yes                                       |
| Fog, skybox                     | yes             | yes            | yes             | yes (#134, #144)                          |
| Entity alpha                    | yes             | yes            | yes             | yes                                       |
| Entity scale                    | yes             | yes            | no?             | no                                        |
| MAX_EDICTS / MODELS / SOUNDS    | 32000/4096/2048 | larger         | 32000/4096/2048 | 32000/4096/2048 (`src/quakedef.js:44-47`) |

Limits: Icaro matches Fitz and IW; QSS goes higher through its own protocol.

## Protocol strategy

### What actually needs to be compatible

Only three things produce bytes the client reads, so judge each option by what
it does for them rather than for wire interop with QS or QSS:

1. Icaro's own server. Free to choose any format; it is the only place netplay
   features (delta entities, prediction, WebTransport/WebRTC) live.
2. QuakeC `WriteByte(MSG_*, ...)`. It writes NetQuake message numbers and
   payloads. The surveyed mods (AD, progs_dump, LibreQuake) use only
   `SVC_TEMPENTITY` (TE 0-13), `SVC_UPDATESTAT`, `SVC_CDTRACK`, `SVC_FINALE`,
   `SVC_KILLEDMONSTER`, `SVC_FOUNDSECRET`, `SVC_INTERMISSION`, `SVC_SELLSCREEN`,
   `SVC_CENTERPRINT`, `SVC_SETVIEW`, `SVC_SETVIEWPORT`, `SVC_SETVIEWANGLES`,
   `SVC_CUTSCENE`, QW-only `SVC_SMALLKICK`/`BIGKICK`/`multicast` behind `__QW__`
   (not used by the NQ build). All of them exist in 15, 666, 999 and 1015 with
   the same payload. What changes by protocol is only the width of coordinates
   and angles written with `WriteCoord`/`WriteAngle`, which the engine applies
   (`MSG_WriteCoord`), so QC never has to know.
3. Foreign `.dem` files (15, 666, 999, rerelease). They need a reader, not a
   server.

### Options

A. Keep 1015 and add 666/999 server and client paths.

- Server: two more `SV_WriteEntitiesToClient` and baseline paths, plus
  `sv_protocol`. Cost L. Gains nothing for Icaro netplay because 666/999 have no
  delta entities or prediction support (QS and IW are NQ-style, with
  full-state-per-frame `svc_update`). It would also fork the netplay code three
  ways. Rejected for the server side.
- Client side only (read 666/999 for demos, and for a future "connect to a QS
  server through a bridge"): cost M, no server change. This is the useful part.

B. Adopt 999 plus FTE extension negotiation as QSS does.

- Gets a real standard for free: PEXT2 `REPLACEMENTDELTAS` (delta entities),
  `PREDINFO` (input acks), `SETANGLEDELTA`, `MAXPLAYERS`, `NEWSIZEENCODING`. QSS
  has working code (`sv_main.c`, `cl_parse.c`, `common.c` use
  `PEXT2_REPLACEMENTDELTAS`; `PEXT2_SUPPORTED_SERVER` in `protocol.h`). Demos
  from QSS would play. Cost L to XL: Icaro's `PE_*` and `svc_playerinfo` layouts
  (`src/protocol.js:155-215`, `src/sv_main.js:1352-1460`, `:1796`) are replaced
  by FTE's `UF_*` deltas and `PREDINFO` stats; `clc_move` gains the FTE form
  (`src/cl_input.js:484`); the handshake must carry the extension words (QSS
  puts them in `CCREQ_CONNECT`; Icaro's transports have no such packet, so it
  would go in the lobby/WebTransport hello).
- Risks: FTE's format is large and still evolving; the spec lives in QSS and
  FTEQW code, not a document; Icaro would inherit "mods write svcs the PEXT
  table reassigns" (QSS uses numbers above 52 for svcs). It also ties the Icaro
  standard to another project's choices, against the stated goal of defining
  Icaro's own.

C. A versioned Icaro protocol with capability bits.

- Keep a private wire (what 1015 is today) but make it explicit: the server
  hello sends `PROTOCOL_ICARO` plus a 32-bit capability word (coord32, large
  models, packet entities, scale/colormod, alpha, ...), and the client replies
  with the subset it accepts (like PEXT, but defined by Icaro). Cost M: today's
  behaviour becomes capability bits `1 << n`; no behaviour change at first.
- Moves the private svcs (42, 47-49) into a reserved range that cannot collide
  with Fitz, IW or KEX numbers (for example 64-111, below the 128 fast-update
  flag), and lets future features (WebRTC resend, voice, scale/colormod) land
  without bumping the protocol number every time.
- Risk: the standard becomes Icaro's alone; mitigated by publishing the table in
  `docs/` and by option A's client-side readers.

### Recommendation: C, with the client-side half of A

1. Add a per-protocol dispatch table in `cl_parse.js` and make `cl.protocol` in
   {15, 666, 999, 1015}. Implement 666 and 999 readers for demos only (finding
   1). The Icaro server keeps sending 1015.
2. Define 1015's capability word now (hello message in `src/sv_main.js:576`),
   with today's features as bits. Renumber the private svcs (42, 47-49) into a
   reserved range when the first non-compatible change forces a bump; until
   then, protocol-gated dispatch removes the collision risk.
3. Add entity extras (scale, colormod) and the Fitz `svc_fog`/`skybox`/`bf`
   readers as capability-gated features, shared with the 666/999 readers.
4. Revisit B only if Icaro needs to talk to QSS servers or demos, or if
   replacement-deltas turn out to beat the current `PE_*` encoding in
   measurements. Nothing in the brief needs it, and browsers cannot do UDP to
   native servers anyway.

Why not A or B as the main path: A multiplies server code without netplay
benefit; B couples the standard to FTE. C gives the same demo and mod
compatibility as either (the client can read 15/666/999 regardless of what the
server sends) and keeps Icaro's netplay design.

## LibreQuake as standard content

- Licence: the repository root has no licence field on GitHub (`NOASSERTION`).
  `qcsrc/README` says "everything in this folder us under the gpl2 licence";
  `docs/misc-docs/LibreProgsDeluxe.md` extends GPL-2 to `lq1/progs.dat`,
  `progs.lno`, `qwprogs.dat`; the project text says art is BSD. Icaro is GPL-2
  (`LICENSE`), so the progs are compatible with shipping alongside; combining
  GPL-2 progs with BSD art is fine for hosting. Per-asset credits are in
  `docs/CREDITS` of the release; those must travel with any pak Icaro hosts. I
  did not read the full `COPYING` or `README-IMPORTANT-LICENCE-INFO`.
- Hosting: v0.09-beta release zips are 56 MB (`lite`) to 116 MB (`full`), and a
  `server.zip` of 71 MB. Icaro's rule allows only `static/pak0.pak` committed
  (`.dockerignore` lines 10 and 22, `AGENTS.md` Game data). LibreQuake is free,
  so the "never commit registered data" reasoning does not apply, but the CI
  check (no pak but `pak0.pak` tracked) and the Dockerfile allowlist would have
  to be widened deliberately for `lq1/`, and a 56 MB pak should be hosted
  off-repo (R2 or a release asset) and fetched by range, as the rerelease paks
  are. The `lite` zip is the browser candidate. This also needs a licence
  manifest next to the data.
- Progs: LibreQuake's NQ progs are mostly vanilla (`LibreProgsDeluxe` is based
  on the clean 1.01 GPL QuakeC with bug fixes). They use id builtins plus `stof`
  #81, `MSG_*` temp entities, and `svc_cutscene` for the camera system
  (`qcsrc/lq1/cutscene_camera.qc`, `LQ_` prefixes). `__QW__` code paths
  (`multicast`, `SVC_SMALLKICK`) are for `qwprogs.dat`, which the NQ server does
  not load. Expect Icaro to run them today; this was not run.
- `lq1` game directory: needs finding 4. `quake.rc` runs `default.cfg`,
  `config.cfg`, `autoexec.cfg`, `stuffcmds`, `startdemos demo1 demo2 demo3` (all
  Icaro-compatible), and echoes banners with `Echo` in mixed case (command names
  are case-insensitive in Quake; Icaro's `Cmd_Argv`/`Cmd_ExecuteString` handling
  of that was not checked).
- Attract demos: `demo1`-`demo3` and the `_lite` versions are in `pak0`
  (`build_components.json`). Their protocol is unknown (binary, not downloaded).
  If they are 666/999, finding 1 becomes a boot blocker for LQ. Check first by
  reading the first bytes of the `forcetrack` line and the first
  `svc_serverinfo` protocol field of one demo.
- Maps: compiled with ericw-tools (`qbsp -bspx`, `light -bounce -dirt`); `.lit`
  files shipped beside the `.bsp`. Needs BSP29/BSP2 and `.lit`, both done. Fence
  textures and lit water (finding 6) matter for the look.
- `levelshots.pk3` is a zip inside pak0 (`build_components.json`); Icaro has no
  zip reader (no `pk3`, `inflate` or `DecompressionStream` in `src/`), so those
  images are unreachable; harmless unless menus use them.
- Config: `default.cfg` binds `+melee` and uses cvars that Icaro lacks (finding
  10). `style_ironwail_*.cfg` expect IW cvars; `style_fte_*` and
  `default_fte.cfg` are for FTE.
- LibreQuake's recommended engines are FTEQW first, then vkQuake, QSS and
  Ironwail: its content is tested against them, so IW-level behaviour
  (finding 3) is the practical bar.

## Not verified

- No code was run: not Icaro, not AD, not LibreQuake's progs or maps.
- LibreQuake demo protocol, map BSP versions and per-map flags; LibreQuake's
  full licence text; the LQ `build_releases.json` contents.
- Quoth and Copper QC (sources not located); their extension use and whether
  they set `.scale`. AD's fallback behaviour when `checkextension` returns 0.
- Whether QS's default `sv_protocol` is 666 (stated from memory of QS; IW's 999
  is read from `sv_main.c`).
- External texture loading (tga/png) in Icaro; fence textures (a source search,
  not a render test); `Echo` case handling; `hudstyle`, `r_softemu`, `r_scale`
  cvars.
- `.sav` interchange with QS/IW in practice, and KEX saves; whether IW's
  `json.c` is for saves.
- QS `sv_protocol` default and QSS's exact `qcextensions` count (about 110, from
  a rough listing).
- #235, #241, #242, #243 contents.
