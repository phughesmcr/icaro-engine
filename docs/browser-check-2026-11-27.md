# Browser check: `dev` at `bf3915f` (2026-11-27)

Read-only check in the Claude desktop app's built-in browser pane (Chromium,
headless audio) against `deno task serve` on port 8137, with LibreQuake from
`deno task fetch-data` (full variant). Screenshots are in
[`browser-check-2026-11-27/`](browser-check-2026-11-27/). Screenshots 19 and 20
showed retail Quake and Arcane Dimensions data and are not committed.

Status since: FAIL A and FAIL B were fixed in PR #282, the loose `.cfg` files
and the literal `\n` log lines in PR #281. A snapshot otherwise.

## Outcome

Seven of the eight areas work, with two real bugs and a few minor ones. Check 4
is only partly covered: protocols 15 and 999 parse without errors, but no
protocol 666 demo was available, so 666 wasn't exercised.

- **FAIL A:** the attract demo fails on every page load, not only the first.
  demo1's map isn't loaded yet, and the client prints "Couldn't fetch
  maps/lq_e1m4.bsp" even though the fetch worked. The first screen is then a
  full-screen console flooded with sound warnings.
- **FAIL B (pre-existing):** LibreQuake demos (`svc_cutscene`) leave a black
  band where the status bar would be.
- **Loose cfg files can't be `exec`ed:** LibreQuake's
  `style_ironwail_modern.cfg` (at every startup), `zoom90.cfg`, `zoom120.cfg`,
  `dev.cfg` and the style toggle all print "couldn't exec", although the files
  ship loose in `static/librequake/id1/`. Found in the in-game console audit
  (section 9).
- **Environment:** a stale HTTP-cached module from another worktree on the same
  origin broke startup (`B_ALPHA` export missing). Seen in local dev; production
  is probably not affected but wasn't checked (see Setup notes).

| # | Area                                   | Result                    |
| - | -------------------------------------- | ------------------------- |
| 1 | Intro, Play, menu, HUD, console        | PASS, except FAIL A       |
| 2 | Fence `{` textures (#253)              | PASS                      |
| 3 | Lighting and gamma (#269, #272)        | PASS                      |
| 4 | Protocol 666/999 demos (#278)          | 15/999 clean; 666 not run |
| 5 | URL config (#276) and game dirs (#277) | PASS, one minor           |
| 6 | `?agent=lockstep`, `icaro.help()`      | PASS                      |
| 7 | Mobile and touch layout                | PASS, with caveats        |
| 8 | Retail data (`?base=id1`, AD)          | PASS                      |
| 9 | In-game console audit (54 maps)        | 1 engine gap, data issues |

## Setup notes

- My first load on `localhost:8137` failed with
  `Uncaught SyntaxError: The requested module './protocol.js' does not provide
  an export named 'B_ALPHA'`.
  The source is fine. Every worktree's server shares the `localhost:8137`
  origin. `deno task serve` sends no `Cache-Control`, so Chromium cached
  `src/protocol.js` from an older checkout heuristically. `sw.js` is
  network-first, but it fetches with the default cache mode, so the HTTP cache
  still answered. To work around it, I unregistered the service worker, deleted
  the `icaro-v2` cache and refetched every `src/*.js` with `{cache: "reload"}`.
  After that I used fresh `*.localhost` subdomains (`bc1127.localhost`,
  `bc1127b.localhost`), which each get their own cache.
- Production (`cloudflare/client`) also sets no `Cache-Control`. The generated
  `_headers` file only carries security headers. Workers static assets
  revalidate by default, so production probably isn't affected. I didn't verify
  this against the deployed site.
- I couldn't send the console key (`` ` ``) through the pane's automation;
  synthetic `KeyboardEvent`s on `document` worked. The pane's clicks are mouse
  pointer events, so touch mode needed a synthetic `PointerEvent` with
  `pointerType: "touch"`.

## 1. Intro, Play, menu, HUD, console: PASS (FAIL A)

- The intro page shows (01). Download LibreQuake (local `full.zip`) starts the
  engine. The menu (Solo, Online, Options, Manual, Quit) works. New Game loads
  the start map with the HUD (04). The console toggles and accepts typing.
- These 404s on every load are expected probes: `static/librequake/id1/pak2.pak`
  and `PAK2.PAK`.
- These console lines are benign:
  - `Couldn't load sound/player/slimbrn2.wav` (a LibreQuake data gap).
  - Many `Unknown command` lines from LibreQuake's cfgs for
    QuakeSpasm/Ironwail/FTE cvars.
  - The browser console shows `LibreQuake in %s\n OPFS` with the format string
    unformatted (cosmetic; `src/userdata.js:394`).

### FAIL A: the attract demo can't fetch its map on any page load

To reproduce: open the site (a fresh origin needs Download LibreQuake first),
wait for the engine to start, and watch the console (02). Reloading an origin
that has already played shows the same thing (21).

```
Fetching maps/lq_e1m4.bsp...
Couldn't fetch maps/lq_e1m4.bsp
CL_ParseStartSoundPacket: sound_num 74 not precached
CL_ParseStartSoundPacket: sound_num 101 not precached
CL_ParseStartSoundPacket: sound_num 75 not precached
... (repeats for the length of the demo)
```

- `cl.worldmodel` stays null and the full-screen console is the first screen. On
  mobile it covers the whole screen until you tap ← Back (16).
- It happens on every page load: I reloaded an origin that had already played
  and got the same console (21). `playdemo demo1` straight afterwards plays fine
  (03), which shows the fetch succeeded within the page. The first
  `playdemo demo3` (`maps/lqdm3.bsp`, a loose file) failed the same way.
- Cause: in `CL_ParseServerInfo` (`src/cl_parse.js` ~597-615),
  `COM_EnsureFile(...).then(...)` reconnects only when `cls.netcon.address` is
  set. During demo playback there is no netcon, so a successful fetch takes the
  `else` branch. It prints "Couldn't fetch" and never restarts the demo, and
  playback carries on without a world.
- Candidate follow-up: `src/cl_parse.js` `CL_ParseServerInfo`. In the demo
  branch, restart the demo (or `CL_NextDemo`) after `COM_EnsureFile` succeeds.
  Print "Couldn't fetch" only when the fetch actually failed. Stop parsing the
  demo until the map is there.

## 2. Fence textures (#253): PASS

- `start.bsp` uses `{char_*` textures for the EASY/NORMAL/HARD letters, and they
  are see-through over the brick (09).
- Other LibreQuake maps with `{` textures: lq_e1m6, e1m8, e2m1, e2m5, e2m6,
  e2m7, e3m5, e3m7, e4m2, e4m6, e4m7, e4m8, end and dev.
- lq_e1m1 has none. The black block there is an unlit crate face (checked with
  `r_fullbright 1`).

## 3. Lighting and gamma (#269, #272): PASS

Defaults: `gl_overbright 1`, `gl_overbright_models 1`, `gamma 1`, `contrast 1`.
I measured mean luma of the 3D view only, with
`icaro.screen_rgba(320, 0, false)`, from a fixed position.

| Map     | Setting                  | Mean luma | Visible?                 |
| ------- | ------------------------ | --------- | ------------------------ |
| lq_e1m1 | defaults                 | 8.38      | (05)                     |
| lq_e1m1 | `gamma 0.7`              | 20.05     | yes                      |
| lq_e1m1 | `gamma 0.5`              | 37.18     | yes (06)                 |
| lq_e1m1 | `contrast 1.5`           | 12.78     | yes                      |
| lq_e1m1 | `contrast 2`             | 16.74     | yes                      |
| lq_e1m1 | `gl_overbright 0`        | 8.44      | no (dark corridor)       |
| lq_e1m1 | `gl_overbright_models 0` | 8.13      | barely                   |
| lq_e0m1 | `gl_overbright 1`        | ~63.9     | (07)                     |
| lq_e0m1 | `gl_overbright 0`        | ~59.6     | yes, ~7% darker (08)     |
| lq_e0m1 | `gl_overbright_models 0` | ~62.9     | slight, on the viewmodel |

- All four cvars change the image.
- Overbright only shows where the lightmaps go above 128. That's expected, and
  the start of lq_e1m1 is too dark to show it.
- Side observation (not checked further): with `r_fullbright 1` the viewmodel
  looked darker than the world.

## 4. Protocol 666/999 demos (#278): 15 and 999 clean, 666 not exercised

| Demo  | Protocol        | Map     | Notes                                       |
| ----- | --------------- | ------- | ------------------------------------------- |
| demo1 | 15              | lq_e1m4 | FAIL A on first play; fine on retry         |
| demo2 | 15              | lq_e2m5 | fog 0.03 from worldspawn; played first time |
| demo3 | 999 (flags 130) | lqdm3   | fog 0.05 white from worldspawn (10)         |

- LibreQuake ships no protocol 666 demo, so I couldn't test 666 in the browser.
  Recording one locally isn't possible either: the server always sends
  `PROTOCOL_ICARO` (`src/sv_main.js:576`).
- Neither the world nor the demos sent `svc_fog` (41) or `svc_skybox` (37). Fog
  came from the worldspawn `fog` key, and `sky` stayed `""`. No bonus flash
  (`svc_bf`, 40) appeared during demo3's ~35 s (`cl.cshifts[2]` stayed 0). The
  unit tests cover these messages, but LibreQuake data doesn't exercise them in
  the browser. AD's skybox and fog did show up in check 8 (screenshot 20, not
  committed).
- No `Bad server message`, `CL_ParseServerMessage` or illegal-svc errors
  appeared in any demo.

### FAIL B (pre-existing): black status bar band during `svc_cutscene`

To reproduce: `playdemo demo2` (or any LibreQuake demo) and look at the bottom
of the view (11).

- The LibreQuake demos run as cutscenes (`cl.intermission = 3`). `Sbar_Draw`
  returns early during an intermission (`src/sbar.js:944`), but the 3D view
  stays sized for a status bar, which leaves a black band.
- `SCR_CalcRefdef` (`src/gl_screen.js` 475-520) handles intermission correctly
  with `sb_lines = 0`. It only runs when `vid.recalc_refdef` is set, and
  `CL_Parse_svc_intermission`, `svc_finale` and `svc_cutscene`
  (`src/cl_parse.js` ~2075, 2081, 2091) have
  `// vid.recalc_refdef = true; // go to full screen` commented out. The same
  line is commented out after `svc_serverinfo` (~1905). It dates from the first
  commit.
- End-of-level intermissions probably show the same band (not checked). The id1
  demo, which isn't a cutscene, shows the HUD normally (screenshot 19, not
  committed).
- Candidate follow-up: `src/cl_parse.js`. Set `recalc_refdef` again at those
  sites, as WinQuake `cl_parse.c` does. Note that `cl_parse.js` imports no
  `vid`, and the flag `SCR_UpdateScreen` reads is `gl_screen.js`'s private
  `_vid` (lines 174-192), so the fix needs an exported way to set it.

## 5. URL config (#276) and game dirs (#277): PASS (one minor)

The link
`?cfg.fov=110&cfg.gamma=abc&cfg.viewsize=500&cfg.sv_gravity=100&cfg.rcon_password=x`
printed these lines in the browser console:

```
Ignoring cfg.gamma "abc" (expected a number)
cfg.viewsize "500" clamped to 120 (expected a whole number 30 to 120)
Ignoring cfg.sv_gravity "100" (not a setting a link may change)
Ignoring cfg.rcon_password "x" (not a setting a link may change)
```

- The game console then showed `Link set fov "110" (not saved)` and
  `Link set viewsize "120" (not saved)` (12).
- Afterwards: fov 110, viewsize 120, gamma 1, sv_gravity 800.
  `localStorage.quake_cvar_fov` was null, so nothing was saved.

Game dirs:

- `?game=nosuchdir`: the intro explains that id's files aren't in this browser
  and offers Play LibreQuake. LibreQuake then plays without the pack (13).
- `?game=../x` is rejected with
  `Ignoring game "../x" (expected a directory name: up to 32 letters, digits,
  _ and -, not id1 or a base)`.
- Minor: the intro page still says the link "starts Quake from id Software's own
  files". `src/intro.js` (`INTRO_ID1_PARAMS = ["game"]`) checks the raw `?game=`
  parameter, not `url_config.js`'s validated value. Candidate follow-up:
  `src/intro.js`, use the parsed `urlCfg.game`.

## 6. Agent link: PASS

`?agent=lockstep&map=lq_e1m1&skill=1`:

- On an origin that has already played, the intro is skipped and lq_e1m1 loads
  at skill 1. `icaro.help()` returns its help text, and `icaro.observe()` and
  `icaro.step()` work (15).
- On a fresh origin the intro says "This link starts LibreQuake". "First episode
  only (56 MB)" fails locally with "Couldn't get LibreQuake: the download isn't
  available from this site yet", because `static/librequake/lite.zip` 404s:
  `deno task fetch-data` fetches only the full variant unless given
  `--variant lite`. The failure is handled gracefully (14), and this is a
  dev-environment gap, not a bug. After the full download the agent API works.
- Observations:
  - While frozen in lockstep, the console stays partly down.
  - Outside lockstep, `icaro.cmd(text)` returns the previous command's output,
    one call late. Candidate follow-up: `src/agent.js` `Agent_Command`.

## 7. Mobile and touch: PASS (caveats)

Pane mobile preset (375x812, Android Chrome user agent, touch points):

- The engine logs `Mobile device detected - touch controls available`.
- First launch shows the full-screen console because of FAIL A (16). ← Back
  reaches the menu, and menu taps (Solo, New Game) work.
- The touch HUD appears once a touch pointer event arrives (the pane's clicks
  are mouse events, which switch to mouse mode by design in `src/in_web.js`).
- Portrait shows "Rotate your device … Tap to continue" (17).
- Landscape (812x375) shows pause, SAVE, CON, WPN▶, ◀, FIRE, JUMP and DOWN (18).
  A synthetic touch on FIRE fired (ammo 25 → 24 → 23), at the same refire rate
  as `+attack`.
- Minor: DOWN slightly overlaps the right edge of the status bar.
- Observation: sliding the console in tall portrait took ~8-10 s.
- I reset the viewport to desktop afterwards.

## 8. Retail data: PASS

The worktree has no retail data. For this check only, I symlinked the main
checkout's `static/pak0.pak`, `static/pak1.pak` and `static/ad` into the
worktree, then removed them. Nothing was committed or uploaded, and `git status`
showed only this report's screenshots afterwards.

- `?base=id1` on `127.0.0.1` loaded `pak0.pak` and `pak1.pak` (registered) and
  played demo1 on e1m3 with the HUD.
- `?base=id1&game=ad` loaded AD's pak0, pak1 and pak2. `map start` worked with
  skybox `moonrise_` and fog `0.04 0.2 0.2 0.3`.
- Not tested: quoth, rerelease, hipnotic, rogue.

## 9. In-game console audit

Requested after the first report. I recorded the engine's own console (every
`Con_Print` call from console init onward) by installing a hook from the page
with `Con_SetAgentHook` (`src/console.js`); the agent was never attached, so
nothing else used the hook. Lines printed before the console exists go only to
the browser console, which I read separately. Icaro has no `condump`.

Coverage:

- Startup and the attract loop on a fresh origin (`bc1127c.localhost`), and
  again on reloads.
- `playdemo demo1`, `demo2` and `demo3` once their maps were loaded.
- `map <name>` for all 54 maps in LibreQuake's paks and loose files: `start`,
  `dev`, `lq_e0m1`-`8`, `lq_e1m1`-`8`, `lq_e2m1`-`7`, `lq_e3m1`-`7`,
  `lq_e4m1`-`8`, `lq_end` and `lqdm1`-`13`. All 54 loaded. After each load the
  game ran 8 s with the player standing still.
- The same 54 maps again with `developer 1`.
- `?game=nosuchdir`, `?game=../x` and the `?cfg.` link from check 5, each
  recorded from page load.

To make the demos and maps run faster than the hidden pane's throttled frame
rate, I called `Host_Frame(0.1)` from the page between loads. My first map pass
did that during the connect too, and the client got stuck at signon 0. A plain
`map lq_e0m3` with normal frames loaded fine, so that was my harness, not the
engine. The pass reported here waits in real time for each load and only drives
frames once the map is in.

Never seen: `PF_precache_*` or "Cannot precache", "model not precached", missing
textures or wads, `SZ_GetSpace` overflow, bad entity or edict errors, QuakeC
runtime errors (`PR_RunError`), cvar warnings, and protocol or parse errors.

### Engine bugs or gaps

| Message                                                                                                                                                                                                                     | Count, where                                                                                                                  | Likely file                                                                              |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `Fetching maps/lq_e1m4.bsp...` then `Couldn't fetch maps/lq_e1m4.bsp`, followed by `CL_ParseStartSoundPacket: sound_num N not precached`                                                                                    | Every page load (demo1), and demo3 (`lqdm3.bsp`) on its first play; the sound line repeats hundreds of times per attract loop | FAIL A, `src/cl_parse.js` `CL_ParseServerInfo`                                           |
| `couldn't exec style_ironwail_modern.cfg`                                                                                                                                                                                   | Every startup (from `default.cfg`'s `lq_style_modern`)                                                                        | `src/cmd.js` `Cmd_Exec_f`, `src/pak.js` loose files                                      |
| `couldn't exec zoom90.cfg`, `zoom120.cfg`, `dev.cfg`, `style_ironwail_retro.cfg`                                                                                                                                            | When the `zoom90`, `zoom120`, `dev` or `lq_toggle_style` aliases run                                                          | same                                                                                     |
| Literal `\n` at the end of log lines (`Loading pak files...\n`, `Added packfile pak0.pak (370 files)\n`, `Memory initialized (JavaScript GC mode)\n`, `Loaded custom menu images\n`); `LibreQuake in %s\n OPFS` unformatted | Every startup, browser console                                                                                                | `main.js` 158-229, `src/pak.js` 132-921, `src/zone.js` 50 and 238, `src/userdata.js:394` |

About the loose cfg files:

- `exec` reads the file synchronously with `COM_LoadFileAsString`. Loose files
  are only in memory after something fetches them, so `exec` can't see them. All
  four files exist in `static/librequake/id1/`. Ironwail runs them from `id1/`.
- The effect players see: LibreQuake's modern style (`r_softemu 0`,
  `r_scale
  1`, `r_lerpmodels 1`, `r_lerpmove 1`, `hudstyle 2`) is never
  applied. `quake.rc` prints "Zoom90 or Zoom120 for the zoom function" and "Dev
  for development bindings", and those commands do nothing.
- I didn't check whether Icaro has all five style cvars.
- The literal `\n` strings in `src/pak.js` 830, 842 and 883 and
  `src/zone.js:238` are `Con_Printf` calls that can run after the console
  starts, so they would show a literal `\n` in the game console too. I didn't
  trigger them.

### LibreQuake data issues

| Message                                                                                                                                   | Count, where                                             | Note                                                                                                |
| ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `Couldn't load sound/player/slimbrn2.wav`                                                                                                 | Once per map load: 57 times over 54 maps, plus each demo | Not in LibreQuake's paks or loose files; its progs precache it                                      |
| `Couldn't load sound/boss2/death.wav`, `idle.wav`, `pop2.wav`, `sight.wav`                                                                | 3 times each: `dev`, `lq_end`                            | Not in the data                                                                                     |
| `======OBJECT ERROR in movetarget_f:` / `monster_movetarget: no targetname`, edict 548 `path_corner` at `'1512 1608 584'`, target `pt6_1` | Once: lq_e3m4                                            | QuakeC `objerror` (same text as vanilla `PF_objerror`, `src/pr_cmds.js:202`); the entity is removed |
| `couldn't exec cam.cfg`                                                                                                                   | When the `cam` alias runs                                | `cam.cfg` isn't in the data, though `quake.rc` advertises "Cam"                                     |
| `"scr_conalpha" is "-1" (default)`                                                                                                        | Every startup                                            | `default.cfg` line 94 has `scr_conalpha` with no value, which prints the cvar                       |
| `You receieve 100 health`                                                                                                                 | Once each on 11 maps                                     | LibreQuake progs text (their typo); a normal pickup message                                         |

Unknown commands from LibreQuake's cross-engine cfgs, at every startup:

- QuakeWorld or FTE commands that NetQuake engines don't have: `topcolor`,
  `bottomcolor`, `serverinfo`, `if`. `default.cfg` also sets `color 11 10`,
  which works.
- Ironwail/QuakeSpasm settings Icaro doesn't implement: `vid_fsaa`,
  `vid_fsaamode`, `scr_pixelaspect`, `sv_autoload`. These are feature gaps, not
  bugs.
- Settings for other engines, which every NetQuake engine rejects:
  `cl_fakeshaft`, `gl_texturemode_viewmodels`, `r_lerpmuzzlehack`,
  `gl_texturemode_sky`, `gl_texturemode_hud`, `gl_overbright_model`,
  `gl_smoothfont`, `cl_stainmaps`, `cl_decals`, `cl_particles_quake`,
  `cl_beams_polygons`, `r_font_postprocess_mono`, `r_waterscroll`.
- When `lq_toggle_style` runs: `cl_warncmd` (twice) and `vid_reload`.

Developer-only warnings about the map data (`developer 1`; QuakeSpasm prints the
same):

- `walkmonster in wall at: '...'`: 33 times over 11 maps. Most on lq_e2m3,
  lq_e3m1, lq_e3m3, lq_e4m3, lq_e4m4 and lq_e4m5.
- `Bonus item fell out of level at '...'`: 22 times over 13 maps.
- `Monster can't find target at '...'`: 11 times on lq_e1m3, lq_e1m4, lq_e1m5
  and lq_e4m4.
- `Unstuck.`: once on lqdm11.
- `'<key>' is not a field` (`src/pr_edict.js:811`), from entity keys the progs
  don't define:
  - `mapversion` on 53 maps.
  - `credits` and `credits_` on up to 19 maps.
  - Commented-out `//_sunlight..._color` keys on 13 maps.
  - Worldspawn `wateralpha` (7 maps), `lavaalpha` (lq_e0m4) and `slimealpha`
    (lq_e3m1).
  - `color` 22 times on lqdm2, `property 1` 16 times on lq_e3m3 and lq_e3m4, `5`
    15 times on lq_e4m3, `minlight` 7 times on lqdm6, `deviance` on lq_e1m1 and
    lq_e1m8, `button_done` on lq_e1m8, `sunlight2` on lqdm9.
  - QuakeSpasm also prints this for worldspawn alpha keys. I didn't check
    whether Icaro applies per-map `wateralpha`.

### Expected

- `couldn't exec config.cfg` and `couldn't exec autoexec.cfg`: every startup.
  Icaro keeps the config in localStorage, and played origins also print
  `Loaded saved config from localStorage`.
- `Persistent storage denied.`: once (`src/host_cmd.js:1212`). The pane didn't
  grant `navigator.storage.persist()`.
- `CDAudio_Play: Bad track number 0.` (developer): 15 maps with no CD track
  (start, dev, lq_e1m6, e2m1, e2m6, e2m7, e3m5, e3m7, e4m2, e4m6, e4m7, e4m8,
  lq_end, lqdm11, lqdm13). The current music keeps playing, as in `cd_win.c`.
- `Warning: N byte signon buffer exceeds standard limit of 7998.` (developer,
  `src/sv_main.js:2441`): 8 maps. lq_e1m4 11410, lq_e1m5 13178, lq_e2m3 9396,
  lq_e2m4 15391, lq_e2m5 20347, lq_e3m4 11826, lq_e4m3 11674, lq_e4m5 10416. All
  are under the QuakeSpasm limit of 63998.
- Developer information on every map: `N entities inhibited`, the sound precache
  list, `SpawnServer`, `CL_SignonReply`, `maps/*.lit loaded`, `R_WarmupStart`,
  `Programs occupy`.
- URL cases: the game console shows `Link set fov "110" (not saved)` and
  `Link set viewsize "120" (not saved)`. The `Ignoring ...` lines for
  `cfg.gamma`, `cfg.sv_gravity`, `cfg.rcon_password` and `game "../x"` appear
  only in the browser console. `?game=nosuchdir` and `?game=../x` produce the
  same game-console output as a plain load, FAIL A included.

Not covered: combat, finishing levels and intermissions, saving and loading, and
QuakeC paths that need the player to move. Each map got only 8 s of standing
still.

## Console and network logs

I read the browser console 15 times and the network log 3 times during the run,
not once per check. Errors and notable lines:

- Checks 1 and 4: FAIL A's lines above (game console), plus the benign lines
  under check 1. No parse errors in any demo.
- Network: the 404s I saw were the expected `id1/pak2.pak` and `PAK2.PAK` probes
  and `static/librequake/lite.zip` (check 6).
- Check 5: the `cfg.` and `game` messages quoted above.
- Checks 2, 3, 7 and 8: I didn't read the browser console separately for these,
  so their logs weren't captured. Nothing failed on screen.
- Environment: the `B_ALPHA` `SyntaxError` in Setup notes.

## Candidate follow-ups

| Issue                                                                      | Likely file                               |
| -------------------------------------------------------------------------- | ----------------------------------------- |
| FAIL A: demo map fetch never restarts the demo                             | `src/cl_parse.js` `CL_ParseServerInfo`    |
| FAIL B: black band during cutscene/intermission                            | `src/cl_parse.js` (`recalc_refdef` sites) |
| Stale HTTP-cached modules in local dev                                     | `sw.js` (`cache: "no-cache"`), dev server |
| Intro trusts raw `?game=`                                                  | `src/intro.js` `INTRO_ID1_PARAMS`         |
| `LibreQuake in %s` unformatted in the browser console                      | `src/userdata.js:394`                     |
| `icaro.cmd` output one call late outside lockstep                          | `src/agent.js` `Agent_Command`            |
| `lite.zip` missing locally (dev-only)                                      | `tools/fetch_data.js` / docs              |
| Loose `.cfg` files can't be `exec`ed (LibreQuake style, zoom, dev aliases) | `src/cmd.js` `Cmd_Exec_f`, `src/pak.js`   |
| Literal `\n` in startup log lines                                          | `main.js`, `src/pak.js`, `src/zone.js`    |
| DOWN button overlaps the status bar in landscape                           | `src/touch.js`                            |

## Not verified

- Audio (the pane is headless), real touch devices, Safari, WebGL context loss,
  protocol 666 demos in the browser, and `svc_skybox`, `svc_fog` and `svc_bf`
  from LibreQuake data.
- Mission packs other than AD, and the rerelease.
- Production cache headers on the deployed site.

## Manual Safari checklist (macOS and iOS, real devices)

1. **Install as a PWA.** iOS: Share → Add to Home Screen. macOS Safari: File →
   Add to Dock. Launch it from the icon and check that it opens standalone (no
   browser chrome), the icon and name are right, and a relaunch while offline
   still reaches the intro or menu.
2. **Audio unlock.** On first launch, the first tap or keypress should start
   sound (menu clicks, demo audio). Check that the iOS silent switch and the
   volume behave, and that sound comes back after switching away and back. Check
   that CD music plays if present.
3. **Touch (iOS).** Rotate prompt in portrait, touch HUD in landscape. Move and
   look sticks, FIRE, JUMP, WPN cycling, SAVE and CON. No page scroll, pinch
   zoom, double-tap zoom or text selection while playing. Menu taps work.
4. **WebGL context loss.** Background the app (home swipe or tab switch) for 30
   s or more, lock and unlock the device, then return. The game should come back
   rendering, not as a black or frozen canvas, with the console free of errors.
   Repeat during a demo and in a level.
5. **Orientation and fullscreen.** Rotate during play, check safe-area insets
   around the notch and home indicator, and on macOS enter and leave fullscreen.
6. **First run on a fresh profile.** Download LibreQuake and watch for FAIL A's
   console on the first screen; check that OPFS storage persists across
   relaunches.
