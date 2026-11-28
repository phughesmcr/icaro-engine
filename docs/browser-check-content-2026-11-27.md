# Browser check across content sets, 2026-11-27

A browser check of `dev` at `3603119` with each content set the engine supports:
id's retail Quake (id1), the two mission packs (hipnotic, rogue), Quoth, the
2021 rerelease and its add-on Dimension of the Machine (mg1), and LibreQuake.
For each set: load it, start a map, a minute of play (move, shoot, pick up, a
door or lift), save and load, the bundled demos, a map sweep, and an audit of
the in-game console. Then the overlaid status bar (`hudstyle`, `scr_sbaralpha`),
`r_scale` and `r_softemu` on LibreQuake. A snapshot.

Nothing here was fixed: the findings are listed for triage at the end. The only
screenshots are of LibreQuake; none shows id's or other commercial content.

Status since (checked at `dev` `da4ea21` by reading the code; this check wasn't
rerun): of the candidate follow-ups at the end,

- **1** (`R_Init`'s newlines), **2** (Quoth's intro label), **3** (the
  influences notice is developer-only), **4** (`Client <name> removed` goes to
  `Sys_Printf`, not the game console; a crash drop prints it too, a marked
  deviation) and **7** (`.gitignore`) were fixed in #310, which had no browser
  check or live dedicated server run.
- **6** (`isReady`) was fixed in #309: the shader warm-up polls its programs
  itself instead of calling `compileAsync`. In the desktop app's browser pane
  the PR reproduced the error on `dev` with an injected disposal, and didn't get
  it with the fix. What caused this report's five errors wasn't reproduced.
- **5** (blank 2D canvases) is addressed in #311, not confirmed fixed: the
  charset, pic and PNG canvases are redrawn on `contextrestored`. Only a
  simulated loss was tested. A real discard was never reproduced, so it isn't
  shown that one caused this symptom, or that Chrome fires the event on these
  canvases.
- **8** (agent pathing) is open.

A snapshot otherwise.

## Summary

| Content set                      | Result | Demos (protocol)                                  | Play, save and load     | Map sweep        |
| -------------------------------- | ------ | ------------------------------------------------- | ----------------------- | ---------------- |
| id1 (retail, `?base=id1`)        | PASS   | demo1-3 (15), clean                               | PASS (e1m1)             | 38/38 clean      |
| hipnotic (`?game=hipnotic`)      | PASS   | hipdemo1-4 (15), clean                            | PASS (hip1m1)           | 18/18 clean      |
| rogue (`?game=rogue`)            | PASS   | demo1-3 (15), clean                               | PASS (r1m1)             | 17/17 clean      |
| Quoth (`?game=quoth`)            | PASS   | vongug, coop, coop2 (15); 2 missing sounds (data) | PASS (e1m1quoth)        | 11/12; 1 is data |
| Rerelease (`?base=rerelease`)    | PASS   | demo1-3 (15), clean                               | PASS (e1m1)             | 42/42 load       |
| mg1 (`?base=rerelease&game=mg1`) | PASS   | none ship; the rerelease's demo1-3 play           | PASS (mge1m1, mge2m1)   | 25/25 load       |
| LibreQuake (`?base=librequake`)  | PASS   | demo1, demo2 (15), demo3 (999)                    | PASS (lq_e1m1, lq_e1m2) | 54/54 load       |

No content set ships a protocol 666 demo, so 666 playback was not checked (see
Not verified). No `Host_Error` came from the engine; the one `Host_Error` seen
is a Quoth file that isn't a playable map (below).

The finding most worth triaging is not tied to a content set: after a long
session with the page often hidden, the status bar and all 2D text stopped
drawing until a reload (follow-up 5).

## Setup

- Browser: the Claude desktop app's built-in browser pane
  (Chrome/156.0.8078.100, macOS, Apple Silicon). Claude in Chrome was not
  connected.
- Server: `jsr:@std/http@1.1.4/file-server` on `127.0.0.1:8145` with
  `Cache-Control: no-cache`, serving the worktree (an uncommitted
  `.claude/launch.json` entry). Range requests work, so maps in large paks print
  `Fetching maps/<name>.bsp...` and then load: that line is expected and is left
  out of the tables below.
- Data: the retail directories were symlinked from the main checkout's
  gitignored `static/` (`pak0.pak`, `pak1.pak`, `hipnotic`, `rogue`, `quoth`,
  `rerelease`). LibreQuake came from `deno task fetch-data` (v0.09-beta,
  `full.zip`). Nothing data-related is committed.
- Origins: each set ran on a fresh origin. `src/intro.js` `Intro_IsDevHost`
  accepts only `localhost`, `127.0.0.1` and `[::1]` (not `*.localhost`), so the
  sets built on id1's `static/pak0.pak` ran there; the rerelease, mg1 and
  LibreQuake ran on `rr.localhost`, `mg1.localhost` and `lq.localhost`.
- The pane was often hidden, which throttles `requestAnimationFrame` to about 3
  fps and, through `src/in_web.js`, opens the menu (a web-only deviation). An
  untracked in-page harness replaced the animation loop with a pump that calls
  `Host_Frame` between `MessageChannel` yields, and stopped `visibilitychange`
  and `blur` in the capture phase. Play used the agent API (`window.icaro`) in
  lockstep: shoot, then `goto` the nearest items, doors and monsters (`attack`),
  with `god` on; then a teleport onto the three nearest items to check pickup;
  then `save cbc`, a change of state, `load cbc`, and a comparison of health,
  armour, ammo, items, kills, secrets, position and time. Door and lift movement
  was measured from the push entities' origins. The sweep ran `map <name>` for
  each map and kept what the console printed until signon.
- The console was read through `Con_SetAgentHook`, which sees everything the
  game console prints. The console key was checked once (on id1): a synthetic
  Backquote toggles `key_dest` 0, 1, 0.

## Startup lines on every set

These print on every start (the last one whenever the harness played) and are
expected or cosmetic:

| Line                                                             | Why                                                                                                                                                                 |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `couldn't exec config.cfg`, `couldn't exec autoexec.cfg`         | A fresh origin has neither                                                                                                                                          |
| 404s for `pak2.pak`/`PAK2.PAK` and the game directory's next pak | `COM_AddPakSequence` probes until a pak is missing (browser console only)                                                                                           |
| 404s for `static/music/trackNN.ogg`/`.mp3`                       | No CD tracks are served (browser console only)                                                                                                                      |
| `R_InitR_Init: Three.js renderer ready`                          | Missing newline: `src/gl_rmain.js:1862` prints `"R_Init"` without `\n` (follow-up 1)                                                                                |
| `meshing <model>...`                                             | C parity: GLQuake's `gl_mesh.c` prints it with `Con_Printf`                                                                                                         |
| `Disabling renderer/network isolation.`                          | Not at startup: the agent's lockstep sets `host_maxfps 72` (`src/agent.js:151`), and `Host_UpdateNetInterval` (`src/host.js`) prints it as QuakeSpasm does; harness |

## Per content set

### id1 (retail)

`http://localhost:8145/?base=id1`. Loaded `pak0.pak` (339 files) and `pak1.pak`
(85 files).

- Demos: demo1 (e1m3), demo2 (e1m4), demo3 (e1m6), all protocol 15, nothing
  printed.
- e1m1: firing took shells from 25 to 24; three kills; doors moved and two
  buttons were pressed; health and shells picked up. Save and load restored the
  state exactly.
- Sweep: all 38 maps (start, e1m1-e4m8, end, dm1-dm6) loaded with nothing
  printed.
- The main menu opens when the page is hidden (the expected `src/in_web.js`
  deviation).

### hipnotic

`http://127.0.0.1:8145/?game=hipnotic` (argv `-hipnotic`).

- Demos, protocol 15, nothing printed: hipdemo1 (hip1m5), hipdemo2 (hip2m2),
  hipdemo3 (hip3m2), hipdemo4 (hipdm1). hipdemo1 shows `forcetrack -158` because
  its header line is `" 2\n"` with a leading space; `src/cl_demo.js` parses it
  as `cl_demo.c` does, so this is C parity.
- hip1m1: doors and a train moved, pickups (red armour, nailgun), a secret
  found; save and load identical.
- Sweep: 18/18 maps clean.
- The status bar showed hipnotic's extra weapons in `hudstyle` 0, 1 and 2
  (looked at, not saved).

### rogue

`http://localhost:8145/?game=rogue` after clearing that origin's storage (argv
`-rogue`).

- Demos, protocol 15, nothing printed: demo1 (r1m5), demo2 (r2m7), demo3 (ctf1).
- r1m1: doors moved, six kills, shells and nails picked up; save and load
  identical.
- Sweep: 17/17 maps clean. The status bar looked right.

### Quoth

`http://127.0.0.1:8145/?game=quoth` (argv `-quoth`, which sets the hipnotic
flag). Loaded Quoth's `pak0.pak` to `pak2.pak`.

- The intro page says "This link starts Quake.": `INTRO_GAME_LABELS` in
  `src/intro.js` has no `quoth` entry (follow-up 2). Startup plays id1's
  demo1-3, since Quoth's demos aren't in a `demo1`-`demo3` loop.
- Demos, protocol 15:
  - vongug (kelltest4): `Couldn't load sound/necros/sec_shft.wav` and
    `Couldn't load sound/weapons/click.wav`. Neither file is in Quoth's or id1's
    paks (Quoth has `items/click.wav`), so this is the data.
  - coop (e1m1quoth, 234 s): nothing printed.
  - coop2 (e1m2quoth): `Fetching maps/e1m2quoth.bsp...`, then it played (the
    fetch-then-retry path from PR #282).
- e1m1quoth: doors moved, the "Shoot this secret door." centre print, a secret
  found; save and load identical.
- Sweep: 11 of 12 maps loaded. `kellbase1_fan` stops with
  `SERVER ERROR in SelectSpawnPoint: PutClientInServer: no info_player_start on level`
  and `Host_Error: Program error`. It is a brush model kept as a map file (no
  spawn point), not a playable map, so this is Quoth's QuakeC behaving as it
  should.
- The status bar uses the hipnotic layout, as expected.

### Rerelease

`http://rr.localhost:8145/?base=rerelease`. The intro says "This link starts
Quake (2021 rerelease)." Loaded `localization/loc_english.txt` (1679 strings)
and `loc_english_mod.txt`.

- Demos, protocol 15, nothing printed apart from model notices: demo1 (e1m3),
  demo2 (e1m4), demo3 (e1m6).
- `progs/<name>.mdl uses up to N influences per vertex` prints the first time
  each MD5 replacement model loads: zombie 5, ogre 8, wizard 5, demon 7,
  shambler 7, boss 6, enforcer 5, hknight 5, fish 6, tarbaby 6, oldone 7. From
  `src/gl_md5.js:1097`, which keeps four weights per vertex as Ironwail does;
  the line is a developer notice shown to every player (follow-up 3).
- e1m1: firing took shells from 25 to 24, one kill, four doors moved, shells
  picked up (health was full, so health wasn't taken: correct). Save and load
  identical. No unlocalised `$` string appeared in the console.
- Sweep: all 42 maps (start, e1m1-e4m8, end, dm1-dm8, base32b, death32c) loaded;
  only the model notices printed.

### mg1 (Dimension of the Machine)

`http://mg1.localhost:8145/?base=rerelease&game=mg1` (argv `-game mg1`). The
intro says "This link starts Quake (2021 rerelease): Dimension of the Machine."
Loaded the rerelease's `id1/pak0.pak` (1282 files) and `mg1/pak0.pak` (172).

- No demos ship with mg1; startup plays the rerelease's demo1-3.
- mge1m1: firing took a shell; two `func_bob`s moved; green armour and shells
  picked up (health was full); save and load identical. The agent's `goto` found
  no path from the start to any door on this map, so a second play ran on
  mge2m1: big shells picked up, a secret found, two doors moved.
- Sweep: all 25 maps (start, hub, mge1m1-mge5m2, mgend, horde1-7, mgdm1-4)
  loaded. Every horde map prints `Couldn't load sound/horde/nyom.wav`: the progs
  ask for it, but it is in neither `mg1/pak0.pak` nor the rerelease's
  `id1/pak0.pak`, so this is the data. horde2 also prints
  `Texture thordetrime (256 x 8) is not 16 aligned` (and `thordetrimf`), which
  QuakeSpasm prints as a warning too.

### LibreQuake

`http://lq.localhost:8145/?base=librequake`. The intro says "This link starts
LibreQuake."

- The pane offered this origin 184 MB of storage (the disk had 121 GB free), and
  Download LibreQuake stopped with "Couldn't get LibreQuake: it needs 365 MB of
  storage and this browser offers the site 183 MB." That message is the intended
  handling (`src/librequake.js`); the small quota is the pane's. So this run
  didn't use the download: the harness wrote a stand-in manifest
  (`librequake/manifest.json`, no files) into the origin's store, and the engine
  read LibreQuake's paks and loose files from `static/librequake/id1/` over
  HTTP. The download and stored install were checked in
  `browser-check-2026-11-27.md`, not here. At a later reload the stand-in
  manifest was gone (the store empty, `icaro_played` still set) and had to be
  written again; I didn't look into what removed it.
- With nothing stored, `COM_PreloadLooseConfigs` (`src/pak.js`) has no listing
  of loose `.cfg` files (HTTP has none, by design), so `default.cfg`'s
  `exec style_ironwail_modern.cfg` printed `couldn't exec` and the style's cvars
  (`hudstyle 2`, `r_softemu 0`, `r_scale 1`) weren't applied. This is the setup,
  not a regression of PR #281's fix, which reads stored files; it was not
  rechecked on a stored install.
- Demos: demo1 (lq_e1m4) and demo2 (lq_e2m5) are protocol 15; demo3 (lqdm3, a
  loose map) is protocol 999 with flags 130. All three played to the end. Each
  printed `FITZQUAKE 0.85 SERVER (26063 CRC)` (the demo's own server message)
  and `Couldn't load sound/player/slimbrn2.wav`; demo3 printed the server line
  twice, once before and once after `Fetching maps/lqdm3.bsp...`, because the
  demo restarts after the fetch (PR #282).
- lq_e1m1: firing took a shell; shells, green armour (a secret) and nails picked
  up; save and load identical. The agent's `goto` timed out or found no path to
  the doors, so no door moved. A second play on lq_e1m2: a lift (`plat`) rose
  264 units, four kills (grunts and an ogre), shells, nails and rockets picked
  up.
- Sweep: all 54 maps (start, dev, lq_e0m1-lq_e4m8, lq_end, lqdm1-lqdm13) loaded.
  The data messages match the earlier report's audit exactly: `slimbrn2.wav` on
  every map, the four `boss2` sounds on `dev` and `lq_end`,
  `OBJECT ERROR in movetarget_f` on lq_e3m4, and `You receieve 100 health` on 11
  maps.
- After about half an hour of the harness in the often-hidden pane, the status
  bar, crosshair, console text and centre prints stopped drawing; the 3D view
  went on. The 2D overlay canvas itself drew a test fill, and a status bar pic
  made from `gfx.wad` there and then drew, but `Draw_String` drew nothing: the
  charset canvas made once at startup (`src/gl_draw.js`) had gone blank, and the
  status bar pics made at startup (`src/sbar.js`) presumably had too: I didn't
  read them back, and the pic I tested may have been made fresh. A reload
  brought everything back. Chrome can discard the backing store of a 2D canvas
  in a background page (the `contextlost` event), and nothing in `src/` handles
  that event for 2D canvases (`src/gl_contextloss.js` covers WebGL only). The
  cause is likely but not proven (follow-up 5).
- Five
  `Uncaught TypeError: Cannot read properties of undefined (reading
  'isReady')`
  from `checkMaterialsReady` in `three.module.js` appeared in the browser
  console of that long session. Three.js calls it from `compileAsync`, which
  only `src/gl_warmup.js` uses; I didn't find which map change caused it
  (follow-up 6).
- `Client LQ Player removed` prints in the game console at every map change, on
  every content set (the harness filtered it on the others). See follow-up 4.

## Status bar, r_scale and r_softemu

LibreQuake's `start` map after a reload (fresh canvases), `viewsize 100`,
`scr_sbarscale 3`, captured at 640 px wide with `icaro.screenshot`. Each row
changes one setting from the row before. All ten look as intended:

| Shot                                                             | Settings                           | What it shows                                                                                                        |
| ---------------------------------------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| [01](browser-check-content-2026-11-27/01-hudstyle0-alpha1.jpg)   | `hudstyle 0`, `scr_sbaralpha 1`    | The classic bar, opaque; the 3D view stops at its top edge                                                           |
| [02](browser-check-content-2026-11-27/02-hudstyle0-alpha0.3.jpg) | `scr_sbaralpha 0.3`                | The bar's background translucent, the floor drawn under it to the bottom edge (the view grows, as in QuakeSpasm)     |
| [03](browser-check-content-2026-11-27/03-hudstyle1.jpg)          | `scr_sbaralpha 0.75`, `hudstyle 1` | Ironwail's centre-ammo HUD: health bottom left, current ammo bottom right, ammo counts in a row at the bottom centre |
| [04](browser-check-content-2026-11-27/04-hudstyle2.jpg)          | `hudstyle 2`                       | The side-ammo HUD: the ammo list above the current ammo, bottom right                                                |
| [05](browser-check-content-2026-11-27/05-hudstyle2-alpha0.3.jpg) | `scr_sbaralpha 0.3`                | As 04, the ammo panel's background fainter                                                                           |
| [06](browser-check-content-2026-11-27/06-r_scale2.jpg)           | `hudstyle 0`, `r_scale 2`          | The 3D view at half resolution, the bar still sharp                                                                  |
| [07](browser-check-content-2026-11-27/07-r_scale4.jpg)           | `r_scale 4`                        | The 3D view at a quarter resolution, the bar sharp                                                                   |
| [08](browser-check-content-2026-11-27/08-r_softemu1.jpg)         | `r_scale 1`, `r_softemu 1`         | Software emulation: a slightly warmer palette and faint dithering                                                    |
| [09](browser-check-content-2026-11-27/09-r_softemu2.jpg)         | `r_softemu 2`                      | Stronger dithering and banding                                                                                       |
| [10](browser-check-content-2026-11-27/10-r_softemu3.jpg)         | `r_softemu 3`                      | The strongest: darker, the heaviest dithering; the HUD unaffected                                                    |

On hipnotic, `hudstyle` 0, 1 and 2 were looked at but not saved (commercial
art): its extra weapons showed in all three. The rogue and Quoth status bars
were looked at in the default style only. These checks are by eye: nothing was
compared against Ironwail's own output.

## Console audit

Lines from the engine or the data, by content set, leaving out the startup lines
above and `Fetching maps/...`.

| Line                                                                                      | Where                          | Source                                                               |
| ----------------------------------------------------------------------------------------- | ------------------------------ | -------------------------------------------------------------------- |
| `forcetrack -158`                                                                         | hipnotic hipdemo1              | Demo header `" 2"`; C parity (`src/cl_demo.js`)                      |
| `Couldn't load sound/necros/sec_shft.wav`, `Couldn't load sound/weapons/click.wav`        | Quoth vongug demo              | Not in the data                                                      |
| `SERVER ERROR in SelectSpawnPoint ... no info_player_start`, `Host_Error: Program error`  | Quoth `map kellbase1_fan`      | Not a playable map; Quoth's QuakeC                                   |
| `progs/<name>.mdl uses up to N influences per vertex`                                     | Rerelease and mg1, per model   | `src/gl_md5.js:1097` (follow-up 3)                                   |
| `Couldn't load sound/horde/nyom.wav`                                                      | mg1 horde1-7                   | Not in the data                                                      |
| `Texture thordetrime (256 x 8) is not 16 aligned`, `thordetrimf`                          | mg1 horde2                     | QuakeSpasm warns the same                                            |
| `Client <name> removed`                                                                   | Every set, every map change    | `src/sv_main.js:2077` `Con_Printf`; C has `Sys_Printf` (follow-up 4) |
| `Couldn't load sound/player/slimbrn2.wav`                                                 | LibreQuake, every map and demo | Not in the data (as in the earlier report)                           |
| `Couldn't load sound/boss2/{death,idle,sight,pop2}.wav`                                   | LibreQuake `dev`, `lq_end`     | Not in the data                                                      |
| `======OBJECT ERROR in movetarget_f:` ... `path_corner` edict 548                         | LibreQuake lq_e3m4             | LibreQuake's QuakeC (`objerror`)                                     |
| `You receieve 100 health`                                                                 | LibreQuake, 11 maps            | LibreQuake's progs text (their typo)                                 |
| `couldn't exec style_ironwail_modern.cfg`                                                 | LibreQuake startup             | This run's setup (nothing stored); see LibreQuake                    |
| `"scr_conalpha" is "-1" (default)` and the `Unknown command` lines from LibreQuake's cfgs | LibreQuake startup             | Unchanged from the earlier report                                    |
| `Uncaught TypeError ... 'isReady'` (browser console)                                      | LibreQuake, long session       | Three.js `compileAsync` (follow-up 6)                                |

## Candidate follow-ups

None of these stops a content set from playing. Ranked by how much a player
would notice:

| # | Finding                                                                                                                                                                                                                                                                                                   | Likely files                                                                     |
| - | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 5 | The HUD and all 2D text can vanish in a long session with the page often hidden: the charset canvas made at startup went blank (the status bar pics presumably too) and nothing rebuilds it. Likely Chrome discarding 2D canvas backing stores (`contextlost`), which isn't handled. Needs a reproduction | `src/gl_draw.js` (charset, pic canvases), `src/sbar.js`, `src/gl_contextloss.js` |
| 6 | `Uncaught TypeError: ... 'isReady'` from Three.js `checkMaterialsReady`, seen five times in one long session                                                                                                                                                                                              | `src/gl_warmup.js` (`R_WarmupRun`, `compileAsync`)                               |
| 3 | `progs/<name>.mdl uses up to N influences per vertex` shows in the console for most rerelease monsters; a developer notice, so `Con_DPrintf` may fit better (check what Ironwail prints)                                                                                                                  | `src/gl_md5.js:1097`                                                             |
| 4 | `Client <name> removed` prints in the game console at every map change; id's `host.c:368` uses `Sys_Printf`, which doesn't reach the console. Check whether the browser-hosted rooms rely on it before changing                                                                                           | `src/sv_main.js:2077`                                                            |
| 2 | The intro page says "This link starts Quake." for `?game=quoth`: `INTRO_GAME_LABELS` has no `quoth` entry                                                                                                                                                                                                 | `src/intro.js`                                                                   |
| 1 | `R_InitR_Init: Three.js renderer ready`: the `R_Init` print has no newline                                                                                                                                                                                                                                | `src/gl_rmain.js:1862`                                                           |
| 7 | `.gitignore` has no entry for `static/quoth` or `static/ad`, and its `static/hipnotic/`-style entries (trailing slash) don't match a symlink, so symlinked data dirs in a worktree show as untracked; here only the main checkout's `.git/info/exclude` covered id1, hipnotic, rogue and the rerelease    | `.gitignore`                                                                     |
| 8 | The agent's `goto` found no path to most targets on mg1's mge1m1 and mge2m1 and on LibreQuake's lq_e1m1, so a minute of agent play covers little there. Not a player-facing bug                                                                                                                           | `src/nav.js`, `src/agent.js`                                                     |

Data issues, not the engine's (for reference only): Quoth's missing
`necros/sec_shft.wav` and `weapons/click.wav` and its `kellbase1_fan` map file;
mg1's missing `horde/nyom.wav`; LibreQuake's missing sounds, `objerror` and cfg
lines (unchanged since the earlier report).

## Not verified

- Protocol 666 demos: no content set here ships one (all bundled demos are 15,
  apart from LibreQuake's demo3, which is 999).
- LibreQuake's download and stored install: the pane's 184 MB quota refused
  them, so LibreQuake was read over HTTP (see LibreQuake). The loose cfg exec
  from a stored install was not rechecked.
- The rerelease's own hipnotic, rogue, dopa, mg3 and ctf directories, and Arcane
  Dimensions (`static/ad`, present but not in the task's list).
- Multiplayer, coop and deathmatch with more than one client; demo recording.
- Real keyboard, mouse, touch and gamepad input: play went through the agent
  API, and only the console key was pressed (synthetically). Audio was not
  listened to.
- The status bar on id1, the rerelease and mg1, and `hudstyle` 1 and 2 on any
  commercial set but hipnotic.
- Rendering beyond the screenshots and a look at each set: no comparison with
  Ironwail or QuakeSpasm, and fog, skyboxes, `.lit` files and alpha surfaces
  were not specifically checked.
- Other browsers (Safari, Firefox, mobile) and Chrome outside the desktop app's
  pane; Claude in Chrome was not connected.
- Play was at skill 1 with `god` on, for a minute per set; nothing was played
  through to a level's exit.
