# Audit, November 2026: summary and roadmap

A snapshot of `dev` at `2798ac9` (2026-11-26), taken against the direction in
`docs/vision.md` and the rules in AGENTS.md as rewritten by #245. Five tracks,
each in its own file:

- `compat-runtime.md`: what runs, measured by loading content headless.
- `compat-standard.md`: mod and community-standard gaps, and the protocol
  strategy.
- `architecture.md`: layering, build, distribution, TypeScript, code health,
  licensing.
- `multiplayer-security.md`: netcode, browser hosting, the lobby, the threat
  model, and the URL-config design.
- `client-rendering.md`: rendering, Three.js, performance, input, sound, agent
  access.

Each item below is tagged **run** (measured by running code), **read** (from
reading code only) or **browser** (needs a browser or device to confirm).

## Status

Checked at `dev` `eac77a1` (2026-11-28). The rest of this file is the older
snapshot.

The body is the snapshot, with a **Done** note after each item that has merged
since. An item without one is open or wasn't rechecked. Each PR's limits are in
its body. This status was checked by reading the code; browser results are those
of the PRs, of `../browser-check-2026-11-27.md` and of
`../browser-check-content-2026-11-27.md`, and weren't rerun. The last one ran at
`3603119`, so it checked nothing from #293–#305 or #307. #307, a fix outside the
roadmap, zeroes each client's `usercmd`: a browser-hosted room froze once, in a
live two-player test, when the host threw on a null one as the guest joined. It
wasn't reproduced or rerun in a browser, and `main.js` still has no `try` around
`Host_Frame`, so any throw there ends the host's loop.

Decisions so far: 2 (`stuffcmd` trust), 3 (LibreQuake on first run) and 5
(`THIRD_PARTY.md`) are done. Decision 1 is designed in `../protocol-design.md`
(#256) and partly built: migration steps 1 to 3 (dispatch tables, the 666 and
999 demo readers, and the versioned hello with Icaro's svcs moved to 96 to 99;
#274, #278, #288). Steps 4 to 6, game profiles among them, aren't. Decision 6 is
planned in `../architecture-plan.md` (#260). `gl_model.js` has been split (#280)
and the plan's step 1, a layer checker with a ratchet, is done (#295), but the
three layers aren't built.

## What was covered, and what wasn't

- **Run, headless, all clean:** 261 map spawns at skill 1 with a loopback client
  and the right mission-pack flags. They cover shareware, retail id1, hipnotic,
  rogue, the rerelease's id1, hipnotic, rogue, mg1, mg3, dopa and ctf, and the 8
  community maps in `static/maps/`. Also 418 deathmatch and coop spawns with 4
  players, save and load on 41 maps, every attract demo, record and replay on 10
  sets, and every `trigger_changelevel`. No crash and no blocker.
- **Run later, headless, on PR #252's `headless_host`:** LibreQuake v0.09-beta
  (`full.zip`), Quoth 2.2 (with the 2.1 patch) and Arcane Dimensions 1.80p1, all
  gitignored under `static/`. Results are in the next section. Copper was not
  run.
- **Not run: anything in a browser.** Rendering, audio, input, storage, real
  multi-client play and real networks are unverified. "No blockers" is a
  headless result.

## LibreQuake, Quoth and Arcane Dimensions

Each map was started at skill 1 with a loopback client and run for 10 seconds of
game time, one host per content set unless noted. **run**

- **Every message over 8000 bytes fails: one fix unblocks AD and a LibreQuake
  demo.** Icaro keeps id's `MAX_MSGLEN` of 8000 (`src/quakedef.js:18`) and
  `NET_MAXMESSAGE` of 8192 (`src/net.js:10`); QuakeSpasm uses 64000 and 65536.
  - AD: all 21 of its maps tried after `start` fail to sign on with
    `SZ_GetSpace: overflow`, because the precache list in `SV_SendServerinfo`
    (`src/sv_main.js`) doesn't fit. With the two limits raised in a scratch
    copy, all 25 AD maps tried (each in its own process) load and run clean.
  - LibreQuake: `demo2.dem` stops at once with `Demo message > MAX_MSGLEN` (one
    message is 9748 bytes); with the limits raised it plays.
- **Done (#262):** `MAX_MSGLEN` and `NET_MAXMESSAGE` are 64000 and `SIGNON_SIZE`
  is 31500; `MAX_DATAGRAM` stays 4096. `demo2.dem` plays.
- **LibreQuake's `demo3.dem` is protocol 999** (flags 130: int32 coordinates,
  short angles) and fails with `Server returned version 999`. `demo1` (protocol
  15) plays. The standard content's attract loop needs the 999 reader. **Done
  (#278, #282):** the 999 reader parses all of `demo3`. #282 fixed a demo whose
  map hadn't been fetched yet, which played with no world.
- **LibreQuake maps: clean.** 39 of 41 single-player maps (`start`, `lq_e0`–
  `lq_e4`, `lq_end`, `dev`) and all 13 `lqdm` maps plus 4 starts in deathmatch.
  The two failures, `lq_e2m8` and `lq_e3m8`, don't exist in v0.09. `lq_e3m4`
  prints a non-fatal `OBJECT ERROR` from its own data (a `monster_movetarget`
  with no `targetname`).
- **LibreQuake's configs use commands Icaro lacks.** `default.cfg` and
  `default_$generic.cfg` call `set`, `if` and `serverinfo` (FTE and DarkPlaces),
  bind QuakeSpasm's `MOUSE5` and gamepad key names (`ABUTTON`, `LTRIGGER`...),
  and set about 25 cvars Icaro doesn't have (`scr_conalpha`, `contrast`,
  `r_particles`, `cl_alwaysrun`, `gl_texturemode_hud`...). Nothing fails, but
  those settings and binds are lost. **Partly done (#263, #269, #272):** `set`,
  `seta`, the key names and many of the cvars, `contrast` included, exist; `if`,
  `serverinfo` and the rest don't. Since then, loose cfgs such as the style
  configs can be `exec`ed (#281), and `r_scale`, `r_softemu` (#289) and
  `hudstyle` (#290) exist. `hudstyle 3` isn't ported, and `r_softemu 2` draws
  like 3.
- **Quoth: clean.** The pak ships only test and example maps; 11 of 12 load and
  run. `kellbase1_fan` has no `info_player_start` (a test map). Quoth's real
  content is third-party maps, which weren't run.

## Correction: why 666 and 999 matter

The earlier reasoning in this session, repeated in #245's AGENTS.md, was that
the server must speak 666 and 999 because mods write protocol messages from
QuakeC. `compat-standard.md` (Protocol strategy) found otherwise. AD, progs_dump
and LibreQuake write only NetQuake messages (svc 3–34, TE 0–13), which have the
same payload in 15, 666, 999 and Icaro's 1015. The engine, not the QuakeC, sets
coordinate width. Icaro already parses them. What needs 666 and 999 is **reading
other engines' demos**. That audit is from reading (**read**), and it didn't
read the Quoth or Copper QuakeC.

## Decisions

The maintainer decided these on 26 November 2026.

1. **Protocol: a versioned Icaro protocol.** Keep 1015, add a capability word to
   the server hello, and move Icaro's private svcs (42 and 47–49, which collide
   with Fitz and KEX numbers) into a reserved range. The client dispatches per
   protocol and gets readers for 15, 666 and 999. Servers don't send 666 or 999.
   The design must leave room for games that aren't Quake, Hexen II for example,
   so it starts with a study of how FTEQW does this (its per-game protocol
   variants and `PEXT`/`PEXT2` bits). The other option, 999 plus FTE's
   extensions as Quakespasm-Spiked does, was not chosen.
2. **`stuffcmd` trust: as proposed.** A host can run any console command on
   joiners (`src/cl_parse.js:1470` → `Cbuf_AddText`), and bindings and archived
   cvars persist to the next session. Hosts are players now, so this is High.
   Your own local server is trusted fully. A remote host's text goes through an
   allowlist, and nothing it sets is persisted. Build the allowlist from id's
   published rerelease QuakeC (`id-Software/quake-rerelease-qc`) and the mods'
   sources, not from string scans. A heuristic scan of the shipped `progs.dat`
   suggests `bf`, `disconnect`, `menu_credits`, `restart`, `skill`, `impulse`,
   `spawn`, `horde`, `clear`, `-attack` and (per `docs/rerelease-gaps.md`)
   `fog`. **read**
3. **LibreQuake: downloaded on first run.** Its art is BSD and its QuakeC GPL-2.
   Release zips are 56–116 MB. Pin a release asset hosted outside the repository
   and download it on first run, behind an introductory page so crawlers and
   bots never fetch pak data. Change the pak allowlists (CI's tracked-pak check,
   the client build, the Docker image) deliberately. Its `levelshots.pk3`, and
   the release zip itself, need a zip reader: use an established library, not a
   new one.
4. **Permanent servers: not now.** The deployed lobby only signals; rooms on
   Cloudflare don't exist (`LOBBY_CREATE` is refused). The project stays on
   Cloudflare's Free plan, so browser-hosted rooms are the only rooms for now.
5. **GPL-2.0: agreed.** Games built on Icaro can keep their data proprietary,
   but engine changes and any desktop build must offer source. The shareware pak
   and the community maps need a `THIRD_PARTY.md`.
6. **Architecture: three layers, agreed.** `games/quake/`, `core/` and
   `platform/`, with downward imports only. The architecture audit assumed the
   Quake layer stays function-by-function; under the revised rules that is a
   choice, not a requirement.

Also decided: use established libraries where they fit (zip, for example) rather
than writing new ones.

## Roadmap

In the order of the vision's plans. Items marked S are a day or less, M a few
days, L a week or more.

### 0. Verification first

- A browser smoke pass on each content set: load, render, a minute of play, save
  and load, a demo. **browser** **Mostly done (#283, #306):**
  `../browser-check-2026-11-27.md` covers LibreQuake, its download and stored
  install included, with some checks on retail id1 and Arcane Dimensions.
  `../browser-check-content-2026-11-27.md` ran retail id1, hipnotic, rogue,
  Quoth, the rerelease's id1, mg1 and LibreQuake: a minute of agent play with
  `god` on, save and load, any bundled demos (mg1 ships none) and a map sweep.
  All passed; one Quoth map file with no player start stops with a `Host_Error`
  from Quoth's QuakeC. It used the desktop app's browser pane with a harness. It
  didn't check protocol 666, the rerelease's other game directories,
  multiplayer, real input, audio or another browser, and compared nothing with
  Ironwail. Its engine follow-ups are open.
- Let `headless_host` mount game directories before `Host_Init`
  (`opts.game_dirs`), so mission packs and mods can be scripted and tested
  through MCP. Today it mounts one pak. S, **run**. Overlaps #237, #243, #244,
  #246. **Done (#252)** in `headless_host` (`opts.base`, the game flags,
  `opts.game_dirs`); the MCP server doesn't expose them.
- Raise `MAX_MSGLEN` to 64000 and `NET_MAXMESSAGE` to 65536, as QuakeSpasm does,
  through every net driver and the signon buffers. Unblocks every AD map and
  LibreQuake's `demo2`. S–M, **run**. **Done (#262)**, with `NET_MAXMESSAGE` at
  64000 and `SIGNON_SIZE` at 31500. Not tried in a browser or over a real
  network.
- The 999 reader comes first among the demo readers: LibreQuake's `demo3` needs
  it. **Done (#278).**
- An allocation gate: a test that runs `Host_Frame` many times and fails if a
  frame allocates. The architecture audit's hot-path counts are a grep, not
  measurements. M, **read**.

### 1. Single-player Quake and mods in desktop Chrome

- **Fence textures.** World textures load with `alpha` false
  (`src/gl_model.js:1453`), so `{` textures aren't transparent. S, **read**
  (checked again for this summary), **browser** to confirm. **Done (#253)**,
  checked in a browser on rerelease maps; no Quoth or AD map was tried.
- **Game directories in the browser.** `?game=` accepts only a fixed list
  (`main.js`). Accept any safe directory name, add `-quoth`, multiple `-game`
  and `lq1`. Only the game server takes any `-game`
  (`server/game_server.js:166`); the headless host mounts none (section 0).
  `compat-runtime.md` finding 3 says `?game=quoth` works in the browser, but
  `main.js` ignores names outside its list. M, **read**. Wait for #240 (players'
  own paks), which edits the same files. **Mostly done (#277):** `?game=` takes
  `rogue`, `hipnotic`, `quoth` or any other name `COM_GameDirIsValid` accepts,
  and `-quoth` exists. The headless host mounts every `-game`, as does the
  browser's command line, though a URL names one `?game=`. The servers still
  take one. There is no `lq1` directory. A directory needs a `pak0.pak`. No
  Quoth or mod data was run in #277; the browser check ran Arcane Dimensions.
- **Protocol dispatch and the 666 and 999 demo readers**, after decision 1. M,
  **read**. **Done (#274, #278):** `src/cl_parse.js` has a reader per protocol.
  LibreQuake's `demo3` (999) parses in a test. No 666 demo was available, so
  666, like svcs 37 and 40 to 44, is covered by hand-built messages only. Entity
  scale, dropped then, is applied since #299.
- **QuakeC extensions.** `checkextension` returns 0 (`src/pr_cmds.js:1404`);
  Ironwail's `str2chr`, `chr2str`, `strconv`, `checkcommand`, `vectorvectors`,
  `clientcommand`, trig and `tokenize_console` are missing. M, **read**. **Done
  (#255):** Ironwail's set; `checkextension` answers true only for
  `FTE_QC_CHECKCOMMAND`. No mod was run, and `clientstat` values aren't sent.
- **Frame pacing.** With the default `host_maxfps` 72, render frames are skipped
  below 1/72 s (`src/host.js:836`), which is uneven on 90, 120 and 165 Hz
  displays. The fix must keep physics at 72 Hz, because NetQuake physics depends
  on frame rate. The QuakeSpasm-style split of render and tick
  (`host_netinterval`) is already there: `Host_UpdateNetInterval`
  (`src/host.js:811`) turns it on when `host_maxfps` is above 72 or 0, so the
  fix may be a default change. S, **read**, **browser** to confirm. **Done
  (#279):** `host_maxfps` defaults to 250, so isolation is on, with physics at
  72 Hz, and a local server's entities and view lerp between ticks. The PR
  measured it in a browser at 120 Hz only. A saved `host_maxfps 72` still wins,
  until the player changes it.
- Each M: entity `scale` and lerp-finish, lit water, `gl_overbright`, 2PSB and
  BSPX, FLAC, Opus and tracker music, external texture replacement,
  `r_particles`, `vid_vsync`. **read** **Mostly done,** with the limits below.
  Lerp-finish is read from 666 and 999 demos (#278), but Icaro's server doesn't
  send it.
  - **Done (#269, #272, #263):** `gl_overbright`, `gl_overbright_models` and
    `r_particles`.
  - **Done (#299):** entity `scale`, from QuakeC, from 666 and 999 messages and
    on Icaro's wire, for alias models and sprites. Brush models aren't scaled. A
    browser check used patched LibreQuake progs; no 666 or 999 demo with scale,
    and no multiplayer over a real network, was tried.
  - **Done (#303):** lit water (`r_litwater`, default 1). Checked in a browser
    on one LibreQuake lite map; not on retail maps, with a light changing on a
    liquid, or with `gl_texsort 0`.
  - **Done (#293):** 2PSB, and BSPX's `RGBLIGHTING` lump only; other BSPX lumps
    are ignored. Tested with synthetic maps; no real 2PSB or BSPX map was loaded
    in a browser.
  - **Done (#300, #301):** FLAC, Opus, WAV and tracker music, and the client
    build's CSP allows the WebAssembly the tracker player needs. A browser check
    used generated files and nobody listened; Safari, Firefox, mobile and the
    player under the built CSP weren't tried. Stored and offline tracks are
    still only `.ogg` and `.mp3`, and music inside paks isn't played.
  - **Done (#305):** external world textures and alias skins, from paks only (no
    loose files); sky isn't replaced. The browser check used virtual files, not
    a real texture pack, and alias skins' load-time hook was checked only in a
    Deno test.
  - **Done (#298):** `vid_vsync`, default 1 (QuakeSpasm and Ironwail default to
    0). 0 helps benchmarking more than play. Checked at 120 Hz only; not in
    Safari, Firefox or WebXR.
- Small items: `ctfscores` unknown on ctf maps; `ctf4` exits to a missing
  `idctf1`; dopa can't start four id1 boss maps without mg1's rune model; an
  `ogre_rocket.md5anim` bone warning; headless `stop` throws. S each, **run**.

### 2. Multiplayer

- `stuffcmd` trust (decision 2): the allowlist and no persistence for a remote
  host. High, M. **Done (#258)** (`cmd_server_allowed` in `src/cmd.js`). Not
  tried in a live room.
- Guests have too much power: `kick` outside deathmatch (whether a guest can
  kick the host was **not run**), `pause`, coop cheats gated only by
  `deathmatch`, and no rate limit on chat or name changes. M, **read**. **Done
  (#294):** a guest is any client that is neither privileged nor loopback, so
  every network client. Guests can't `kick` or `pause`, or use `god`,
  `notarget`, `fly`, `noclip` or `give` unless the host sets `sv_guestcheats 1`
  (never in deathmatch). Chat has QuakeWorld's flood protection and name changes
  its limit. The PR reports a test in which, at `3603119`, a coop guest could
  kick the host. Not tried in a live room or a browser. `color` isn't rate
  limited, and a guest's `status` still prints every player's address (with the
  port, in lobby rooms).
- A phone host dies when its tab is hidden; nothing takes a wake lock. Add one,
  warn the host, and pair it with #239's reconnect. M, **read**, **browser**.
  **Partly done (#304):** while a room's host tab is hidden (outside WebXR), a
  Worker's ticks run the host at 20 Hz, with a page timer at about 1 Hz as the
  fallback. Hosting takes a wake lock, the host is warned, joiners are told when
  the host is hidden and back, and a joiner who hears nothing for 3 s sees
  "Waiting for the host…". Measured in desktop Chrome on macOS only. No phone
  was tried: one is expected to freeze the page and its Workers, so a phone host
  may still stop.
- TURN credentials last 6 hours, and non-browser clients skip the Origin check.
  S, **read**. **Done (#297, #302):** they last 3 hours (finding S5 in
  `multiplayer-security.md` asked for 1 or less), and a live host gets fresh
  ones for new connections; an open relayed connection drops when its
  credentials expire. S5's other recommendations aren't done. A lobby with an
  Origin allowlist (the Cloudflare one) now refuses an upgrade with no `Origin`,
  which a non-browser client can still forge. These need a lobby redeploy, with
  the client deployed first or at the same time, and weren't checked on a
  deployed lobby. Real credential expiry wasn't tried.
- Join links trust `?server=` and the map name the host sends. S, **read**.
  **Partly done (#297):** `?server=` must name a public DNS host, or a local or
  private one (plain `ws://` reaches only those), and the client checks the
  world model's path the server names (`Bad map name`). There is still no
  confirm for a non-default `?server=`, so a hostile lobby on a real domain is
  accepted, and other files a host can name, such as skyboxes and MD5 meshes,
  aren't checked this way. Not tried on a deployed site, or with a bad map name
  in a live room.
- URL config: a new `src/url_config.js` with a typed allowlist (`?cfg.<cvar>=…`,
  `?bind.<key>=+action`), applied with `Cvar_Set` and never saved.
  `multiplayer-security.md` has the classification. M. **Done (#276)**, without
  `?bind.`, on purpose: `src/url_config.js`'s header says URL parameters never
  bind keys. Values last for the page load and aren't saved. #284 made the intro
  page validate `?game=` the same way.
- Permanent servers: not now (decision 4).

### 3. Performance

- Dynamic lights are pooled Three.js `PointLight`s by default
  (`gl_flashblend 1`), which adds up to 64 lights to every lit fragment. Make
  the lightmap path the default or cap it. M, **read**, **browser** to measure.
- Load Three.js minified and vendored instead of unminified from jsDelivr; this
  also unblocks the desktop and offline builds. S–M, **read**.
- CPU cost per frame is well under 1 ms in the headless benchmarks, so frame
  time is bound by the GPU, the driver or pacing. **run**

### 4. Agent access

- `headless_host` game directories (section 0). The MCP screenshot is in #246.

### 5. Mobile

- In progress in #247 and #248 (touch). The wake lock above. Gamepad buttons are
  hard-coded (`src/in_web.js:610`) and triggers can't be bound. S. **Done:**
  #247 and #248 merged, and #263 gave the pad's buttons and triggers bindable
  key names. The Keys menu still can't capture them, because the pad sends
  keyboard keys in menus; bind them from the console or a config. No real
  controller was tried. Touch play takes a screen wake lock, as it did at the
  audit's revision; since #304 hosting shares it (`src/wake_lock.js`), and a
  hidden host tab keeps running in desktop Chrome (section 2; no phone was
  tried). The default touch buttons now stay clear of the status bar and the
  modern HUD (#287, #291); no real device was tried.

### 6. Three.js

- About 40 string patches over built-in materials (`onBeforeCompile`), which
  `WebGPURenderer` doesn't support. Move to one TSL `NodeMaterial`, with a test
  that fails when a Three.js upgrade breaks a patch. L, **read**.

### Platform and architecture (cross-cutting)

- One 49-module import cycle, which pulls the renderer into the server and needs
  the 683-line `server/browser_shim.js`. Split `gl_model.js` first. L, **run**
  (counted). **Split done (#280):** `src/gl_model.js` re-exports the model
  cache, loader and upload modules, and of those only `gl_model_upload.js`
  imports `three`. **Layer checker done (#295):** the plan's step 1
  (`tools/layer_graph.js`), with a test that fails on a new import against the
  layers. At `eac77a1`, `deno task layers` counts 132 upward imports, 49 imports
  of browser-only modules by core or game code, and static import cycles of 61
  and 4 modules, by its own method rather than the audit's. The cycle isn't cut,
  and the server still reaches `three`.
- `glquake.js` exports `const` copies of live `gl_rmain.js` state; make it
  constants only. M, **read**.
- Deno Desktop exists from Deno 2.9.0 (the repo pins 2.9.8); CEF is opt-in. A
  one-day spike: how command-line flags reach the app, and whether WebTransport
  works. **read** (docs).
- A bundle step: vendor `three` and `nipplejs`, then `deno bundle`; Vite isn't
  needed yet. Align with #238's CSP nonce. M.
- TypeScript: no `@ts-check` today. Convert leaf modules first, after the cycle
  is cut. L.
- CI has no build or browser step. M.
- `src/sys.js:14` writes error text into `innerHTML`. S, **read**.
- LibreQuake on first run (decision 3): an introductory page that gates every
  pak fetch, the pinned download, and an established zip library. M. **Done
  (#264, #265, #266, #268, #270, #271):** see `../librequake-content.md`. The
  repository now tracks no pak.
- `THIRD_PARTY.md` (decision 5). S. **Done (#257).**

## Open PRs this overlaps

#237, #243, #244 and #246 (agent API and MCP), #238 (CSP nonce), #239 (WebRTC
reconnect), #240 (players' own paks), #241 (dynamic resolution), #242 (status
docs), #245 (rules), #247 and #248 (touch), #249 (centerprint wrap and mod
localization).

All of these have merged.
