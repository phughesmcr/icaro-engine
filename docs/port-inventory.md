# Port inventory: every C function, cvar and command vs the JS port

A second, complete pass after [`port-review.md`](port-review.md). That review
compared behaviour function by function. This one asks a narrower question for
every C item: **does the port have it at all?** Each item that is missing, inert
or different was put in one of three groups:

- **(a)** deliberately not ported, or replaced by a web equivalent;
- **(b)** a real gap that a player, server admin or QuakeC could notice;
- **(c)** dead or empty in C too.

It lists gaps only. It fixes nothing.

## Snapshot

- Port: the raw tables, counts and statuses are from `dev` at `c0ea1d7`
  (2026-11-26). The first scan was at `06d4414` (after #31–#33). The
  hand-written analysis (reasons, ranked gaps, parm and platform notes) was only
  spot-updated since, not re-reviewed. PR #280 has since split
  `src/gl_model.js`, so this doc's `src/gl_model.js` locations and line numbers
  are out of date: the code is in `src/model.js`, `src/mod_*.js` and
  `src/gl_model_upload.js`.
- C: [id-Software/Quake](https://github.com/id-Software/Quake) `WinQuake/` at
  `bf4ac42`, the same tree `docs/port-review.md` used.
- Script: [`tools/port_inventory.py`](../tools/port_inventory.py) (Python 3,
  standard library only). To regenerate the raw tables:

  ```bash
  python3 tools/port_inventory.py <path>/WinQuake . > inventory.tsv
  python3 tools/port_inventory.py <path>/WinQuake . --platform > platform.tsv
  ```

## Method

**Files.** The scan covers the GLQuake build's object list (`Makefile.linuxi386`
`GLQUAKE_OBJS`) minus the platform drivers, plus `cd_audio.c`, because
`src/cd_audio.js` cites it. That makes 45 files: `cl_*`, `chase`, `cmd`,
`common`, `console`, `crc`, `cvar`, `gl_*` (not `gl_vid*` or `gl_test`),
`host*`, `keys`, `menu`, `mathlib`, `net_loop`, `net_main`, `pr_*`, `r_part`,
`sbar`, `sv_*`, `zone`, `view`, `wad`, `world`, `snd_dma`, `snd_mem` and
`snd_mix`. The software renderer (`r_*` except `r_part`, `d_*`, `draw.c`,
`model.c`, `screen.c`) is not in GLQuake, so it is out of scope. The Win32
GLQuake drivers (`gl_vidnt`, `in_win`, `cd_win`, `snd_win`, `sys_win`,
`net_dgrm`, `net_win*`, `net_vcr`, `conproc`) were scanned separately for cvars
and commands only.

**Matching.** For each C item, the script looks for a same-named counterpart in
`src/`, `server/` and `main.js`:

- **Functions:** a JS definition. An empty or constant-return body is flagged
  `stub`, but only when every same-named definition is one.
- **Cvars:** a `new cvar_t( 'name', ... )` or `{ name: 'name', ... }`. The
  script also compares:
  - the default value, the archive flag and the server flag;
  - whether the cvar is passed to `Cvar_RegisterVariable`;
  - whether JS ever reads a cvar that C reads.
- **Commands:** a `Cmd_AddCommand( 'name', handler )`. A handler with a
  different name is flagged `handler`.

The script also records the preprocessor conditions around each item and counts
its C call sites. Zero callers, or a `QUAKE2`/`IDGODS` block, is the mechanical
test for (c). Every non-matching row was then read on both sides. The (b) rows
were checked against the C source, with file and line.

**Extra checks, not by name:**

- the `pr_builtin` table, entry by entry: all 79 match the C order;
- every `COM_CheckParm` argument (see below).

**What name matching cannot see:**

- a function that exists but is ported only in part;
- missing `switch` cases;
- differences inside a body.

For those, use `port-review.md`.

- Since those tables (checked at `dev` `991c6e2`, 2026-11-27, not regenerated):
  #249, #255, #258, #262, #263, #269 and #272 added or changed builtins, cvars,
  key names and limits (see "Since then" in [`port-review.md`](port-review.md)).
  Counts and rows may not reflect them.

## Counts (core files)

| Kind      | Total | Matched | Not matched | (a) | (b) | (c) |
| --------- | ----- | ------- | ----------- | --- | --- | --- |
| functions | 927   | 777     | 150         | 101 | 1   | 48  |
| cvars     | 149   | 130     | 19          | 12  | 0   | 7   |
| commands  | 131   | 127     | 4           | 2   | 0   | 2   |

The first scan put 30 items in (b): 13 functions, 8 cvars and 9 commands. All
are fixed. The one still counted there, `DrawGLWaterPolyLightmap`, has no
same-named definition because its work is folded into a material (G1).

## Ranked gaps (b)

Ranked by how many players would notice. Each one was checked in the C and JS
sources cited. None of them was in `port-review.md` at the first scan. Each now
ends with a **Status** paragraph (all fixed, except that G6 is adjustable). The
C, JS, Seen and Fix bullets above it describe the port before that change. Their
JS line numbers point at the named code in the current tree, except those marked
`06d4414`, where that code has since gone.

### G1 · Submerged walls and floors don't wobble — **medium-high**

- **C:**
  - `Mod_LoadLeafs` sets `SURF_UNDERWATER` on every surface in a water, slime or
    lava leaf (`gl_model.c:937`).
  - `R_RenderBrushPoly` then draws those surfaces with `DrawGLWaterPoly`
    (`gl_rsurf.c:779`, also `:394` and `:575`). That moves each vertex by up to
    8 units: `8*sin(y*0.05+realtime)*sin(z*0.05+realtime)` (`gl_rsurf.c:593`).
- **JS:**
  - The flag is set (`src/gl_model.js:2347`), and `DrawGLWaterPoly` is ported
    (`src/gl_rsurf.js:1018`), but nothing calls it.
  - `R_RenderBrushPoly` and `R_DrawSequentialPoly` (`src/gl_rsurf.js:1220`,
    `:1185`) draw those surfaces as normal lightmapped polys.
- **Seen:** in GLQuake, geometry under water, slime or lava sways. In the port
  it is still. This affects most maps.
- **Fix:** the world is one BatchedMesh, so the fix probably needs a
  vertex-shader path for surfaces with `SURF_UNDERWATER`.
- **Not affected:** the water surface's own texture warp, and the no-lightmap
  rule for turbulent surfaces, both match C.

- **Status: fixed.** `R_BuildWorldMeshes` now builds `SURF_UNDERWATER` surfaces
  with `DrawGLWaterPoly` into their own batches. Their material adds the C sum
  in the vertex shader (`R_PatchWaterWarpVertexShader`), driven by `realtime`
  each frame. That one pass moves the texture and the lightmap together, so it
  also stands in for `DrawGLWaterPolyLightmap`. Only the world needs it:
  `Mod_LoadLeafs` reaches only faces listed in world leaves, so brush-model
  surfaces are never flagged, in C or here.

### G2 · Help screens replaced by a credits page — **medium**

- **C:** the main menu's fourth item (`case 3`) and the `help` command open
  `M_Menu_Help_f`. That screen pages through `gfx/help0.lmp`–`help5.lmp` with
  the arrow keys (`menu.c:349`, `:1535-1575`, `:3016`).
- **JS:** both open `M_Menu_Credits_f` instead (`src/menu.js:812` at `06d4414`;
  the function is now at `src/menu.js:3191`). That is a hand-drawn text box that
  links to the GitHub repo. `m_help` is declared but has no handler. No comment
  explains the change.
- **Seen:** players lose the in-game controls and help pages that ship in
  `pak0.pak`.
- **Fix:** either restore Help (it can keep a credits entry elsewhere), or note
  the deviation in `port-review.md` §7.

- **Status: fixed.** Main menu row 4 and `help` open `M_Menu_Help_f` again
  (`src/menu.js`). The main menu draws the PAK's `gfx/mainmenu.lmp`, which reads
  HELP. The custom `static/mainmenu.png` supplies only the in-game Continue row.
  The credits screen moved to a new last row of the Options menu (a port
  addition), and `menu_credits` still opens it. On touch, a tap turns the page.

### G3 · `gl_texturemode` is a 0/1 cvar, not the C command — **medium**

- **C:** `gl_texturemode` is a command (`gl_draw.c:320-361`, registered at
  `:390`).
  - It takes one of the six `GL_NEAREST` … `GL_LINEAR_MIPMAP_LINEAR` names.
  - It re-filters every loaded mipmapped texture.
  - With no argument, it prints the current mode.
  - The default is `GL_LINEAR_MIPMAP_NEAREST`, which looks smooth
    (`gl_draw.c:54`).
- **JS:** it is an archived 0/1 cvar that defaults to 0, nearest (pixelated)
  (`src/glquake.js:277` at `06d4414`).
  - Existing textures are re-filtered only from the Options menu
    (`src/menu.js:1710` at `06d4414`, `GL_UpdateTextureFiltering`). Typing
    `gl_texturemode 1` affects only textures created afterwards.
  - A config line like `gl_texturemode GL_LINEAR_MIPMAP_LINEAR` parses as 0.
- **Seen:**
  - The default look differs from GLQuake.
  - The console form doesn't work.
  - Configs written for GLQuake fall back to nearest.
- **Fix:** the default may be a deliberate pixel-art choice. If it stays,
  comment it and note it in `port-review.md` §7.

- **Status: fixed.** `gl_texturemode` is the C command again
  (`Draw_TextureMode_f`, `src/gl_draw.js`), with C's default
  `GL_LINEAR_MIPMAP_NEAREST`.
  - Each mode maps to the matching Three.js min/mag filter (`GL_ThreeFilter`,
    `src/glquake.js`).
  - As in C, the command re-filters only mipmapped textures. New textures take
    the current mode, and a texture without mipmaps uses `gl_filter_max` both
    ways.
  - Like any command, it is not saved to `config.cfg`. Old `gl_texturemode 0` or
    `1` lines now print "bad filter name".
  - The particle texture is always `GL_LINEAR`, as in
    `gl_rmisc.c R_InitParticleTexture`.
  - The Options menu's Texture Filtering entry (a port addition) now runs the
    command. It switches between `GL_LINEAR_MIPMAP_NEAREST` and
    `GL_NEAREST_MIPMAP_LINEAR`, the old "off" look.

### G4 · Game Options menu lacks Frag Limit and Time Limit — **medium (multiplayer hosts)**

- **C:** `M_GameOptions_Draw`/`Key` has nine rows, including fraglimit (0–100 in
  steps of 10) and timelimit (0–60 in steps of 5) (`menu.c:2537`, `:2610-2619`,
  `:2717-2728`). `maxplayers` goes up to `svs.maxclientslimit`, which is 4
  unless `-listen`/`-dedicated` asks for more (`host.c:181-194`).
- **JS:** it has seven rows (`src/menu.js:139-140` at `06d4414`). There are no
  fraglimit or timelimit rows, so Episode and Level move up 8 px. The maxplayers
  cap is a hard-coded 4 (`src/menu.js:1470` at `06d4414`) rather than
  `svs.maxclientslimit`, which gives the same result at default settings.
- **Seen:** a host can set limits only from the console before creating a room.
- **Fix:** starting the match as a WebTransport room instead of `listen`/`map`
  is deliberate (port-review §7). The missing rows are not.

- **Status: fixed.** Nine rows with C's cursor table; Frag Limit (0–100 by 10)
  and Time Limit (0–60 by 5) wrap as in C, and Episode and Level are back at y
  112 and 120. `maxplayers` is capped by `svs.maxclientslimit`. Left out: C's
  "More than 4 players … see techinfo.txt" box, since the browser has no command
  line. The room request also carries these five values (`options`), and the
  lobby passes them to the room process as `-coop`, `-teamplay`, `-skill`,
  `-fraglimit` and `-timelimit`, so they reach the room server.

### G5 · Crosshair defaults on, isn't saved, and is drawn differently — **low-medium**

- **C:** `crosshair` defaults to `"0"` and is archived (`view.c:61`).
  `SCR_UpdateScreen` draws `+` at the centre of `scr_vrect`, including during
  demos (`gl_screen.c:906`).
- **JS:**
  - The default is `'1'` and the cvar is not archived (`src/view.js:71` at
    `06d4414`).
  - The crosshair is drawn at the centre of the screen and offset by
    `cl_crossx`/`cl_crossy`. In C those two only affect the software renderer
    (`view.c:1056`, `#ifndef GLQUAKE`).
  - It is hidden during demo playback (`src/gl_screen.js:884` at `06d4414`).
- **Seen:** a new player gets a crosshair. Turning it off in Options isn't
  remembered across sessions.

- **Status: fixed.** `crosshair` defaults to `"0"` and is archived.
  `SCR_DrawCrosshair` (`src/gl_screen.js`) draws it at the centre of
  `scr_vrect`, during demos too, and doesn't read `cl_crossx`/`cl_crossy`. Their
  Crosshair X/Y rows left the Advanced Options page. Two FitzQuake/Ironwail
  deviations stay, commented there: the glyph is centred on that point (C puts
  its top-left corner there), and it is hidden during intermission. #263 added
  `scr_crosshairscale`.

### G6 · 2D UI scale differs from GLQuake's 640-wide console — **low-medium**

- **C:** `gl_vidnt.c:1774-1777` sets `vid.conwidth` to 640 by default (or from
  `-conwidth`/`-conheight`), and the height follows the window's aspect ratio.
  The HUD, menus and console are laid out on a 640-wide virtual screen (640×360
  at 16:9) stretched to the window.
- **JS:**
  - `src/gl_draw.js:79-125` uses an integer scale of `floor(height / 240)`, with
    a minimum virtual width of 320. At 1080p that gives about 480×270 (scale 4,
    against C's 3), so 2D elements are about 1.3× larger than in GLQuake.
  - `scr_conheight` and `uiscale+`/`uiscale-` adjust it, and there is no
    `-conwidth`.
- **Seen:** larger HUD and menus. This is probably a deliberate readability
  choice, but it is not listed in port-review §7.

- **Status: adjustable.** Ironwail's `scr_sbarscale`, `scr_conscale` and
  `scr_menuscale` (default 0, the automatic scale above) set the status bar,
  console and menu scales separately. A non-zero value is clamped to between 1
  and `width / 320` and may be fractional (`src/gl_draw.js:160-172`; applied at
  `src/gl_screen.js:719` and `:1109`, and in `src/menu.js:505`). The default
  layout is unchanged.

### G7 · No version string on the console background — **low**

- **C:** `Draw_Init` stamps `(gl 1.00) 1.09` onto `gfx/conback.lmp`, in the
  bottom-right corner (`gl_draw.c:410-419`, `Draw_CharToConback`).
- **JS:** `_loadConback` (`src/gl_draw.js`) used the picture unchanged.

- **Status: fixed.** `Draw_CharToConback` is ported, and `_loadConback` stamps
  `(gl 1.00) 1.09` with it (`Draw_ConbackVersion`, the C block from
  `Draw_Init`), into a copy of the PAK's pixels. C assumes a 320×200 conback;
  one of any other size is left unstamped rather than corrupted.

### G8 · `sv_gravity`, `sv_friction`, `sv_maxspeed` lack the server flag — **low**

- **C:** these three cvars are declared `server` (`sv_phys.c:42`, `:44`;
  `sv_user.c:167`). `Cvar_Set` therefore broadcasts
  `"sv_gravity" changed to "200"` to every player (`cvar.c:123-127`).
- **JS:** the broadcast exists (`src/cvar.js:136`) and the other server cvars
  use it (`src/host.js:185-190`). These three are created without the flag
  (`src/sv_phys.js:189-194` at `06d4414`).
- **Seen:** players aren't told when the host or QuakeC changes gravity or
  speed. This is separate from port-review's "movevars sent once" note (Part 2),
  which is about prediction.
- **Fix:** one token per cvar. Every other cvar's default and flags match C.

- **Status: fixed.** All three have the server flag.

### G9 · Missing console commands — **low**

- **`version`:** `Host_Version_f` (`host_cmd.c:949`, `:1896`). Typing `version`
  gives "Unknown command".
- **`mcache`:** the function exists (`Mod_Print`, `src/gl_model.js:3543`) but is
  never registered (C: `host_cmd.c:1924`).
- **`flush`:** `Cache_Flush` (`src/zone.js:159`) exists but is never registered
  (C: `zone.c:814`). Under GC it would do nothing, so registering it only avoids
  "Unknown command".
- **`viewmodel`, `viewframe`, `viewnext`, `viewprev`:** these step through the
  frames of a `viewthing` entity (`host_cmd.c:1670-1790`). They matter to
  modders only.

- **Status: fixed.**
  - `version` prints `Version 1.09`. C's second line, the build time, is left
    out: the port has no build step to stamp one.
  - `mcache` runs `Mod_Print`.
  - `flush` is registered in `Cache_Init` as in C. Nothing in the port allocates
    from that cache, so it is a near no-op, kept so configs and players get the
    C command.
  - The four view* commands are ported (`src/host_cmd.js`). Like C they need a
    local game. `PrintFrameName` skips non-alias models, where C reads garbage.

### G10 · Inert debug cvars and parms — **low**

- **`host_speeds` and `serverprofile`:** registered (`src/host.js:180`, `:183`)
  but never read. In C they print per-frame timings (`host.c:697-720`,
  `:736-762`).
- **`-particles <n>`:** was ignored. `MAX_PARTICLES` was fixed at 2048, the same
  as C's default (`r_part.c:50-58`).

- **Status: fixed.** `host_speeds` prints the `tot`/`server`/`gfx`/`snd` line
  each frame, and `serverprofile` the 1000-frame average, as in `host.c`. Both
  run in `Host_Frame` only (the browser and `server/headless_host.js` call it);
  the room server has its own frame loop (`server/game_server.js`).
  `MAX_PARTICLES` is now 16384 (`src/r_part.js:25`), a deliberate deviation from
  C's 2048 taken from Ironwail. `-particles <n>` sizes the pool in
  `R_InitParticles`, as in C and Ironwail: at least 512, no maximum, and the
  default when no number follows (Ironwail's check). The browser passes it from
  `?particles=<n>`, which ignores values over 262144 because a link can carry it
  (a port addition).

## Command-line parms

C's `COM_CheckParm` arguments that JS never checks. The browser builds
`com_argv` from the URL (`main.js`: `?game=` →
`-rogue`/`-hipnotic`/`-game <dir>`; `?base=rerelease` sets the basedir;
`?particles=<n>` → `-particles <n>`; `?listen=<n>` → `-listen <n>`). The room
server builds it from its own flags (`server/game_server.js:354`).

| Parm                                                                                                  | C                                        | Verdict                                                                                                                           |
| ----------------------------------------------------------------------------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `-conwidth`, `-conheight`                                                                             | `gl_vidnt.c`                             | (b) G6                                                                                                                            |
| `-game`, `-basedir`, `-path`, `-cachedir`, `-proghack`                                                | `common.c`                               | (a) no filesystem; `?game=` covers the mission packs and the rerelease add-ons (`-game`), `?base=rerelease` the rerelease basedir |
| `-dedicated`                                                                                          | `host.c`, `sys_win.c`                    | (a) `game_server.js` is always dedicated, the browser never                                                                       |
| `-condebug`                                                                                           | `console.c`                              | (a) no log file in the browser                                                                                                    |
| `-nosound`, `-simsound`                                                                               | `snd_dma.c`                              | (a) the `nosound` cvar replaces the parm                                                                                          |
| `-record`, `-playback`                                                                                | `host.c`, `net_main.c`                   | (a) VCR network debugging                                                                                                         |
| `-minmemory`, `-zone`, `-heapsize`                                                                    | `host.c`, `zone.c`, `sys_win.c`          | (a) GC                                                                                                                            |
| `-lm_1` … `-lm_i`, `-nomtex`, `-no8bit`, `-gl11`                                                      | `gl_rsurf.c`, `gl_vidnt.c`               | (a) GL formats and extensions                                                                                                     |
| `-width`, `-height`, `-bpp`, `-window`, `-mode`, `-current`, `-force`, `-fullsbar`, `-noadjustaspect` | `gl_vidnt.c`                             | (a) the canvas follows the browser window                                                                                         |
| `-dinput`, `-nomouse`, `-nojoy`, `-noforcem*`                                                         | `in_win.c`                               | (a) browser input                                                                                                                 |
| `-ip`, `-noudp`, `-nolan`, `-noipx`                                                                   | `net_wins.c`, `net_dgrm.c`, `net_wipx.c` | (a) the web net drivers (WebTransport, WebSocket, WebRTC) replace UDP and IPX                                                     |
| `-cdmediacheck`                                                                                       | `cd_audio.c`                             | (a) no CD drive; `cd_audio.js` plays music files                                                                                  |
| `-primarysound`, `-snoforceformat`, `-wavonly`                                                        | `snd_win.c`                              | (a) Web Audio                                                                                                                     |
| `-HFILE`, `-HPARENT`, `-HCHILD`, `-starttime`                                                         | `sys_win.c`                              | (a) Win32                                                                                                                         |

These are ported: `-rogue`, `-hipnotic`, `-port`, `-udpport`, `-ipxport`,
`-listen`, `-nocdaudio`, `-gamma` and `-particles` (G10).

## Platform files (cvars and commands only)

All (a):

- **`gl_vidnt.c`:**
  - `vid_mode`, `_vid_default_mode*`, `vid_wait`, `vid_nopageflip`,
    `_vid_wait_override`, `vid_config_x`/`_y`, `vid_stretch_by_2` and the
    `vid_describe*`/`vid_nummodes` commands: the video-mode menu is omitted
    (port-review §7).
  - `_windowed_mouse`: replaced by pointer lock.
  - `gl_ztrick`: registered and commented obsolete (`src/glquake.js:238`).
- **`in_win.c`:**
  - the 19 `joy*` cvars and `joyadvancedupdate`: replaced by the Gamepad API in
    `src/in_web.js`, with six of Ironwail's tuning cvars instead
    (`joy_deadzone_move`/`_look`, `joy_outer_threshold_move`/`_look`,
    `joy_exponent` and `joy_exponent_move`) and its rumble strength cvar,
    `joy_rumble` (`src/in_web.js:703-745`, at `8474098`). #263 added
    `joy_enable`.
  - `in_rawmouse` (web-only, off by default) asks pointer lock for
    `unadjustedMovement`, i.e. mouse input without OS acceleration.
  - `m_filter` is ported.
  - `force_centerview` is registered with the handler `IN_ForceCenterView`.
- **`net_dgrm.c`:** `net_stats`, `test`, `test2` and `ban` (`BAN_TEST`): UDP
  datagram diagnostics and IP bans, with no WebTransport counterpart. The `ban`
  string in `src/sv_user.js` is the client-command allow-list, as in C
  `sv_user.c`.
- **`cd_win.c`:** `cd` is ported.

## Every non-matching item

Rows marked `mentioned` or `string-only` have no definition or registration. The
name appears only in a comment, a string, or as a different symbol. `QUAKE2`,
`IDGODS` and `FPS_20` are never defined in the GLQuake build.

Since the first scan, `_Host_Frame` (formerly (a)) and `PF_etos` (formerly (c);
now Ironwail's extension builtin #65) have gained same-named definitions, so
their rows are gone. `cl_crossx` and `cl_crossy` joined (c) with the G5 fix. The
(b) table keeps all 30 first-scan rows as a record. Its **JS status** is the
current one, so most of those rows now match.

### (a) Deliberately not ported or replaced: 115

| Kind     | C name                          | C source         | JS status                                             | Reason                                                                                                                       |
| -------- | ------------------------------- | ---------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| function | `RedBookToSector`               | `cd_audio.c:245` | missing                                               | DOS MSCDEX driver code; `cd_audio.js` plays music files instead                                                              |
| function | `CDAudio_Reset`                 | `cd_audio.c:258` | missing                                               | DOS MSCDEX driver code; `cd_audio.js` plays music files instead                                                              |
| function | `CDAudio_Eject`                 | `cd_audio.c:282` | mentioned (`src/cd_audio.js`)                         | DOS MSCDEX driver code; `cd_audio.js` plays music files instead                                                              |
| function | `CDAudio_GetAudioTrackInfo`     | `cd_audio.c:306` | missing                                               | DOS MSCDEX driver code; `cd_audio.js` plays music files instead                                                              |
| function | `CDAudio_GetAudioDiskInfo`      | `cd_audio.c:343` | missing                                               | DOS MSCDEX driver code; `cd_audio.js` plays music files instead                                                              |
| function | `CDAudio_GetAudioStatus`        | `cd_audio.c:393` | missing                                               | DOS MSCDEX driver code; `cd_audio.js` plays music files instead                                                              |
| function | `CDAudio_MediaChange`           | `cd_audio.c:421` | missing                                               | DOS MSCDEX driver code; `cd_audio.js` plays music files instead                                                              |
| function | `CDAudio_SetVolume`             | `cd_audio.c:449` | missing                                               | DOS MSCDEX driver code; `cd_audio.js` plays music files instead                                                              |
| function | `CopyString`                    | `cmd.c:332`      | missing                                               | C string/memory helpers; JS strings and typed arrays                                                                         |
| function | `Q_memset`                      | `common.c:138`   | mentioned (`src/snd_dma.js`)                          | C string/memory helpers; JS strings and typed arrays                                                                         |
| function | `Q_memcpy`                      | `common.c:154`   | missing                                               | C string/memory helpers; JS strings and typed arrays                                                                         |
| function | `Q_memcmp`                      | `common.c:169`   | missing                                               | C string/memory helpers; JS strings and typed arrays                                                                         |
| function | `Q_strcpy`                      | `common.c:180`   | missing                                               | C string/memory helpers; JS strings and typed arrays                                                                         |
| function | `Q_strncpy`                     | `common.c:189`   | missing                                               | C string/memory helpers; JS strings and typed arrays                                                                         |
| function | `Q_strlen`                      | `common.c:199`   | missing                                               | C string/memory helpers; JS strings and typed arrays                                                                         |
| function | `Q_strrchr`                     | `common.c:210`   | missing                                               | C string/memory helpers; JS strings and typed arrays                                                                         |
| function | `Q_strcat`                      | `common.c:219`   | missing                                               | C string/memory helpers; JS strings and typed arrays                                                                         |
| function | `Q_strcmp`                      | `common.c:225`   | missing                                               | C string/memory helpers; JS strings and typed arrays                                                                         |
| function | `Q_strncmp`                     | `common.c:240`   | missing                                               | C string/memory helpers; JS strings and typed arrays                                                                         |
| function | `Q_strcasecmp`                  | `common.c:287`   | mentioned (`src/cd_audio.js`)                         | C string/memory helpers; JS strings and typed arrays                                                                         |
| function | `ShortSwap`                     | `common.c:443`   | missing                                               | byte-order helpers; DataView little-endian reads                                                                             |
| function | `ShortNoSwap`                   | `common.c:453`   | missing                                               | byte-order helpers; DataView little-endian reads                                                                             |
| function | `LongSwap`                      | `common.c:458`   | missing                                               | byte-order helpers; DataView little-endian reads                                                                             |
| function | `LongNoSwap`                    | `common.c:470`   | missing                                               | byte-order helpers; DataView little-endian reads                                                                             |
| function | `FloatSwap`                     | `common.c:475`   | missing                                               | byte-order helpers; DataView little-endian reads                                                                             |
| function | `FloatNoSwap`                   | `common.c:492`   | missing                                               | byte-order helpers; DataView little-endian reads                                                                             |
| command  | `path`                          | `common.c:1153`  | mentioned (`src/agent.js`)                            | filesystem/search paths; replaced by fetch + `pak.js` (server: `-pak`), `?game=` replaces `-game`                            |
| function | `va`                            | `common.c:1169`  | mentioned (`src/cvar.js`)                             | C string/memory helpers; JS strings and typed arrays                                                                         |
| function | `COM_Path_f`                    | `common.c:1258`  | missing                                               | filesystem/search paths; replaced by fetch + `pak.js` (server: `-pak`), `?game=` replaces `-game`                            |
| function | `COM_WriteFile`                 | `common.c:1281`  | mentioned (`src/gl_rmisc.js`)                         | filesystem/search paths; replaced by fetch + `pak.js` (server: `-pak`), `?game=` replaces `-game`                            |
| function | `COM_CreatePath`                | `common.c:1308`  | missing                                               | filesystem/search paths; replaced by fetch + `pak.js` (server: `-pak`), `?game=` replaces `-game`                            |
| function | `COM_CopyFile`                  | `common.c:1332`  | missing                                               | filesystem/search paths; replaced by fetch + `pak.js` (server: `-pak`), `?game=` replaces `-game`                            |
| function | `COM_OpenFile`                  | `common.c:1485`  | missing                                               | filesystem/search paths; replaced by fetch + `pak.js` (server: `-pak`), `?game=` replaces `-game`                            |
| function | `COM_FOpenFile`                 | `common.c:1498`  | missing                                               | filesystem/search paths; replaced by fetch + `pak.js` (server: `-pak`), `?game=` replaces `-game`                            |
| function | `COM_CloseFile`                 | `common.c:1510`  | missing                                               | filesystem/search paths; replaced by fetch + `pak.js` (server: `-pak`), `?game=` replaces `-game`                            |
| function | `COM_LoadHunkFile`              | `common.c:1581`  | missing                                               | filesystem/search paths; replaced by fetch + `pak.js` (server: `-pak`), `?game=` replaces `-game`                            |
| function | `COM_LoadTempFile`              | `common.c:1586`  | missing                                               | filesystem/search paths; replaced by fetch + `pak.js` (server: `-pak`), `?game=` replaces `-game`                            |
| function | `COM_LoadCacheFile`             | `common.c:1591`  | missing                                               | filesystem/search paths; replaced by fetch + `pak.js` (server: `-pak`), `?game=` replaces `-game`                            |
| function | `COM_LoadStackFile`             | `common.c:1598`  | missing                                               | filesystem/search paths; replaced by fetch + `pak.js` (server: `-pak`), `?game=` replaces `-game`                            |
| function | `COM_InitFilesystem`            | `common.c:1732`  | mentioned (`server/game_server.js`)                   | filesystem/search paths; replaced by fetch + `pak.js` (server: `-pak`), `?game=` replaces `-game`                            |
| function | `Con_DebugLog`                  | `console.c:353`  | missing                                               | `-condebug` log file; no filesystem in the browser                                                                           |
| cvar     | `gl_nobind`                     | `gl_draw.c:30`   | missing                                               | debug cvar that binds the charset to every surface                                                                           |
| function | `Scrap_AllocBlock`              | `gl_draw.c:109`  | missing                                               | GL texture upload/atlas plumbing; Three.js textures, `GL_ResampleTexture8` covers picmip                                     |
| function | `Scrap_Upload`                  | `gl_draw.c:152`  | missing                                               | GL texture upload/atlas plumbing; Three.js textures, `GL_ResampleTexture8` covers picmip                                     |
| function | `Draw_AlphaPic`                 | `gl_draw.c:568`  | missing                                               | its one use (`Draw_ConsoleBackground` fade) is done with canvas `globalAlpha`                                                |
| function | `GL_Set2D`                      | `gl_draw.c:836`  | stub (`src/gl_draw.js`)                               | GL state; canvas 2D / Three.js (commented in code)                                                                           |
| function | `GL_ResampleTexture`            | `gl_draw.c:882`  | mentioned (`src/glquake.js`)                          | GL texture upload/atlas plumbing; Three.js textures, `GL_ResampleTexture8` covers picmip                                     |
| function | `GL_Resample8BitTexture`        | `gl_draw.c:912`  | missing                                               | GL texture upload/atlas plumbing; Three.js textures, `GL_ResampleTexture8` covers picmip                                     |
| function | `GL_MipMap`                     | `gl_draw.c:945`  | missing                                               | GL texture upload/atlas plumbing; Three.js textures, `GL_ResampleTexture8` covers picmip                                     |
| function | `GL_MipMap8Bit`                 | `gl_draw.c:972`  | missing                                               | GL texture upload/atlas plumbing; Three.js textures, `GL_ResampleTexture8` covers picmip                                     |
| function | `GL_Upload32`                   | `gl_draw.c:1004` | stub (`src/gl_draw.js`)                               | GL texture upload/atlas plumbing; Three.js textures, `GL_ResampleTexture8` covers picmip                                     |
| function | `GL_Upload8_EXT`                | `gl_draw.c:1089` | missing                                               | GL texture upload/atlas plumbing; Three.js textures, `GL_ResampleTexture8` covers picmip                                     |
| function | `GL_LoadPicTexture`             | `gl_draw.c:1278` | missing                                               | GL texture upload/atlas plumbing; Three.js textures, `GL_ResampleTexture8` covers picmip                                     |
| function | `GL_SelectTexture`              | `gl_draw.c:1287` | missing                                               | GL texture upload/atlas plumbing; Three.js textures, `GL_ResampleTexture8` covers picmip                                     |
| cvar     | `gl_smoothmodels`               | `gl_rmain.c:92`  | differs (`src/glquake.js`): C reads it, JS never does | GL hints with no WebGL equivalent; commented obsolete (`gl_rmisc.js`)                                                        |
| cvar     | `gl_affinemodels`               | `gl_rmain.c:93`  | differs (`src/glquake.js`): C reads it, JS never does | GL hints with no WebGL equivalent; commented obsolete (`gl_rmisc.js`)                                                        |
| function | `R_RotateForEntity`             | `gl_rmain.c:122` | mentioned (`src/gl_mesh.js`)                          | Three.js camera and mesh transforms (same near/far 4/4096, same rotation order; Hor+ FOV is listed in port-review §7)        |
| function | `MYgluPerspective`              | `gl_rmain.c:844` | missing                                               | Three.js camera and mesh transforms (same near/far 4/4096, same rotation order; Hor+ FOV is listed in port-review §7)        |
| function | `R_Envmap_f`                    | `gl_rmisc.c:106` | mentioned (`src/gl_rmisc.js`)                         | removed on purpose in #33 (developer tool that writes files)                                                                 |
| command  | `envmap`                        | `gl_rmisc.c:177` | mentioned (`src/gl_rmisc.js`)                         | removed on purpose in #33 (developer tool that writes files)                                                                 |
| function | `GL_DisableMultitexture`        | `gl_rsurf.c:286` | stub (`src/glquake.js`)                               | GL state; canvas 2D / Three.js (commented in code)                                                                           |
| function | `GL_EnableMultitexture`         | `gl_rsurf.c:295` | stub (`src/glquake.js`)                               | GL state; canvas 2D / Three.js (commented in code)                                                                           |
| function | `EmitWaterPolys`                | `gl_warp.c:194`  | mentioned (`src/gl_rsurf.js`)                         | ported as `EmitWaterPolysQuake`/`EmitSkyPolysQuake` (same turbsin, scale and sky speeds)                                     |
| function | `EmitSkyPolys`                  | `gl_warp.c:231`  | mentioned (`src/gl_rsurf.js`)                         | ported as `EmitWaterPolysQuake`/`EmitSkyPolysQuake` (same turbsin, scale and sky speeds)                                     |
| function | `EmitBothSkyLayers`             | `gl_warp.c:274`  | missing                                               | ported as `EmitWaterPolysQuake`/`EmitSkyPolysQuake` (same turbsin, scale and sky speeds)                                     |
| function | `Host_ClientCommands`           | `host.c:322`     | missing                                               | inlined into `PF_stuffcmd`, its only caller                                                                                  |
| function | `Host_FilterTime`               | `host.c:501`     | mentioned (`src/cl_pred.js`)                          | `_Host_FilterTime` (`src/host.js:836`); with `host_maxfps` above 72 or 0 it caps render frames instead (QuakeSpasm/Ironwail) |
| function | `Host_GetConsoleCommands`       | `host.c:532`     | missing                                               | dedicated-server stdin console; room servers are lobby-managed and only watch stdin for EOF (`server/game_server.js`)        |
| function | `Host_InitVCR`                  | `host.c:772`     | missing                                               | VCR demo recorder (`-record`/`-playback`) for network debugging                                                              |
| function | `BOPS_Error`                    | `mathlib.c:174`  | missing                                               | assembly helper for `BoxOnPlaneSide`                                                                                         |
| function | `M_Menu_Net_f`                  | `menu.c:885`     | missing                                               | transport menus; replaced by the WebTransport room list (`M_Menu_LanConfig_f`/`M_FetchRooms`), see port-review §7            |
| function | `M_Net_Draw`                    | `menu.c:899`     | missing                                               | transport menus; replaced by the WebTransport room list (`M_Menu_LanConfig_f`/`M_FetchRooms`), see port-review §7            |
| function | `M_Net_Key`                     | `menu.c:978`     | missing                                               | transport menus; replaced by the WebTransport room list (`M_Menu_LanConfig_f`/`M_FetchRooms`), see port-review §7            |
| function | `M_Menu_SerialConfig_f`         | `menu.c:1733`    | missing                                               | transport menus; replaced by the WebTransport room list (`M_Menu_LanConfig_f`/`M_FetchRooms`), see port-review §7            |
| function | `M_SerialConfig_Draw`           | `menu.c:1774`    | missing                                               | transport menus; replaced by the WebTransport room list (`M_Menu_LanConfig_f`/`M_FetchRooms`), see port-review §7            |
| function | `M_SerialConfig_Key`            | `menu.c:1841`    | missing                                               | transport menus; replaced by the WebTransport room list (`M_Menu_LanConfig_f`/`M_FetchRooms`), see port-review §7            |
| function | `M_Menu_ModemConfig_f`          | `menu.c:2017`    | missing                                               | transport menus; replaced by the WebTransport room list (`M_Menu_LanConfig_f`/`M_FetchRooms`), see port-review §7            |
| function | `M_ModemConfig_Draw`            | `menu.c:2026`    | missing                                               | transport menus; replaced by the WebTransport room list (`M_Menu_LanConfig_f`/`M_FetchRooms`), see port-review §7            |
| function | `M_ModemConfig_Key`             | `menu.c:2067`    | missing                                               | transport menus; replaced by the WebTransport room list (`M_Menu_LanConfig_f`/`M_FetchRooms`), see port-review §7            |
| function | `M_Menu_Search_f`               | `menu.c:2842`    | missing                                               | transport menus; replaced by the WebTransport room list (`M_Menu_LanConfig_f`/`M_FetchRooms`), see port-review §7            |
| function | `M_Search_Draw`                 | `menu.c:2855`    | missing                                               | transport menus; replaced by the WebTransport room list (`M_Menu_LanConfig_f`/`M_FetchRooms`), see port-review §7            |
| function | `M_Search_Key`                  | `menu.c:2892`    | missing                                               | transport menus; replaced by the WebTransport room list (`M_Menu_LanConfig_f`/`M_FetchRooms`), see port-review §7            |
| function | `M_Menu_ServerList_f`           | `menu.c:2902`    | missing                                               | transport menus; replaced by the WebTransport room list (`M_Menu_LanConfig_f`/`M_FetchRooms`), see port-review §7            |
| function | `M_ServerList_Draw`             | `menu.c:2914`    | missing                                               | transport menus; replaced by the WebTransport room list (`M_Menu_LanConfig_f`/`M_FetchRooms`), see port-review §7            |
| function | `M_ServerList_Key`              | `menu.c:2955`    | missing                                               | transport menus; replaced by the WebTransport room list (`M_Menu_LanConfig_f`/`M_FetchRooms`), see port-review §7            |
| function | `M_ConfigureNetSubsystem`       | `menu.c:3219`    | missing                                               | transport menus; replaced by the WebTransport room list (`M_Menu_LanConfig_f`/`M_FetchRooms`), see port-review §7            |
| function | `Loop_Init`                     | `net_loop.c:29`  | stub (`src/net_loop.js`)                              | trivial in C too; `Loop_Init` always succeeds because the browser is never dedicated (commented)                             |
| function | `Loop_Shutdown`                 | `net_loop.c:37`  | stub (`src/net_loop.js`)                              | trivial in C too; `Loop_Init` always succeeds because the browser is never dedicated (commented)                             |
| function | `Loop_Listen`                   | `net_loop.c:42`  | stub (`src/net_loop.js`)                              | trivial in C too; `Loop_Init` always succeeds because the browser is never dedicated (commented)                             |
| function | `Loop_CanSendUnreliableMessage` | `net_loop.c:228` | stub (`src/net_loop.js`)                              | trivial in C too; `Loop_Init` always succeeds because the browser is never dedicated (commented)                             |
| cvar     | `_config_com_port`              | `net_main.c:70`  | missing                                               | serial/modem settings                                                                                                        |
| cvar     | `_config_com_irq`               | `net_main.c:71`  | missing                                               | serial/modem settings                                                                                                        |
| cvar     | `_config_com_baud`              | `net_main.c:72`  | missing                                               | serial/modem settings                                                                                                        |
| cvar     | `_config_com_modem`             | `net_main.c:73`  | missing                                               | serial/modem settings                                                                                                        |
| cvar     | `_config_modem_dialtype`        | `net_main.c:74`  | missing                                               | serial/modem settings                                                                                                        |
| cvar     | `_config_modem_clear`           | `net_main.c:75`  | missing                                               | serial/modem settings                                                                                                        |
| cvar     | `_config_modem_init`            | `net_main.c:76`  | missing                                               | serial/modem settings                                                                                                        |
| cvar     | `_config_modem_hangup`          | `net_main.c:77`  | missing                                               | serial/modem settings                                                                                                        |
| function | `SetMinMaxSize`                 | `pr_cmds.c:132`  | missing                                               | inlined into `PF_setsize`; its `rotate` path is disabled in C (`rotate = false`)                                             |
| function | `Sbar_DrawTransPic`             | `sbar.c:273`     | missing                                               | its one use (`Sbar_DrawNum`) calls `Sbar_DrawPic`; same blending under GL                                                    |
| function | `Sbar_itoa`                     | `sbar.c:314`     | mentioned (`src/sbar.js`)                             | inlined into `Sbar_DrawNum` (commented)                                                                                      |
| cvar     | `_snd_mixahead`                 | `snd_dma.c:82`   | missing                                               | DMA mix-ahead; Web Audio schedules its own                                                                                   |
| function | `GetSoundtime`                  | `snd_dma.c:810`  | mentioned (`src/snd_dma.js`)                          | DMA mixing; Web Audio (port-review §7)                                                                                       |
| function | `S_Update_`                     | `snd_dma.c:856`  | mentioned (`src/snd_dma.js`)                          | DMA mixing; Web Audio (port-review §7)                                                                                       |
| function | `Z_ClearZone`                   | `zone.c:74`      | missing                                               | zone/hunk/cache allocator; garbage collection                                                                                |
| function | `Z_Free`                        | `zone.c:99`      | stub (`src/zone.js`)                                  | zone/hunk/cache allocator; garbage collection                                                                                |
| function | `Z_TagMalloc`                   | `zone.c:155`     | missing                                               | zone/hunk/cache allocator; garbage collection                                                                                |
| function | `Z_CheckHeap`                   | `zone.c:247`     | missing                                               | zone/hunk/cache allocator; garbage collection                                                                                |
| function | `Hunk_Check`                    | `zone.c:293`     | stub (`src/zone.js`)                                  | zone/hunk/cache allocator; garbage collection                                                                                |
| function | `Cache_Move`                    | `zone.c:575`     | missing                                               | zone/hunk/cache allocator; garbage collection                                                                                |
| function | `Cache_FreeLow`                 | `zone.c:606`     | missing                                               | zone/hunk/cache allocator; garbage collection                                                                                |
| function | `Cache_FreeHigh`                | `zone.c:628`     | missing                                               | zone/hunk/cache allocator; garbage collection                                                                                |
| function | `Cache_UnlinkLRU`               | `zone.c:650`     | missing                                               | zone/hunk/cache allocator; garbage collection                                                                                |
| function | `Cache_MakeLRU`                 | `zone.c:661`     | missing                                               | zone/hunk/cache allocator; garbage collection                                                                                |
| function | `Cache_TryAlloc`                | `zone.c:680`     | missing                                               | zone/hunk/cache allocator; garbage collection                                                                                |

### (b) Real gaps (ranked list below): 30 at the first scan, all fixed

| Kind     | C name                    | C source          | JS status                      | Reason                                                                                 |
| -------- | ------------------------- | ----------------- | ------------------------------ | -------------------------------------------------------------------------------------- |
| function | `Draw_CharToConback`      | `gl_draw.c:276`   | defined (`src/gl_draw.js`)     | fixed: G7, ported to `src/gl_draw.js`                                                  |
| function | `Draw_TextureMode_f`      | `gl_draw.c:320`   | defined (`src/gl_draw.js`)     | fixed: G3, ported to `src/gl_draw.js`                                                  |
| command  | `gl_texturemode`          | `gl_draw.c:390`   | registered (`src/gl_draw.js`)  | fixed: G3, the C command again (`src/gl_draw.js`)                                      |
| function | `DrawGLWaterPolyLightmap` | `gl_rsurf.c:617`  | mentioned (`src/gl_rsurf.js`)  | fixed: G1, folded into the underwater world material (`src/gl_rsurf.js`)               |
| cvar     | `host_speeds`             | `host.c:58`       | registered (`src/host.js`)     | fixed: G10, read in `Host_Frame`                                                       |
| cvar     | `serverprofile`           | `host.c:61`       | registered (`src/host.js`)     | fixed: G10, read in `Host_Frame`                                                       |
| cvar     | `fraglimit`               | `host.c:63`       | registered (`src/host.js`)     | fixed: G4, the Game Options rows are back (QuakeC reads them through `cvar()` in both) |
| cvar     | `timelimit`               | `host.c:64`       | registered (`src/host.js`)     | fixed: G4, the Game Options rows are back (QuakeC reads them through `cvar()` in both) |
| function | `Host_Version_f`          | `host_cmd.c:949`  | defined (`src/host_cmd.js`)    | fixed: G9 `version` command                                                            |
| function | `FindViewthing`           | `host_cmd.c:1670` | defined (`src/host_cmd.js`)    | fixed: G9 viewthing model-inspection commands                                          |
| function | `Host_Viewmodel_f`        | `host_cmd.c:1690` | defined (`src/host_cmd.js`)    | fixed: G9 viewthing model-inspection commands                                          |
| function | `Host_Viewframe_f`        | `host_cmd.c:1715` | defined (`src/host_cmd.js`)    | fixed: G9 viewthing model-inspection commands                                          |
| function | `PrintFrameName`          | `host_cmd.c:1734` | defined (`src/host_cmd.js`)    | fixed: G9 viewthing model-inspection commands                                          |
| function | `Host_Viewnext_f`         | `host_cmd.c:1752` | defined (`src/host_cmd.js`)    | fixed: G9 viewthing model-inspection commands                                          |
| function | `Host_Viewprev_f`         | `host_cmd.c:1774` | defined (`src/host_cmd.js`)    | fixed: G9 viewthing model-inspection commands                                          |
| command  | `version`                 | `host_cmd.c:1896` | registered (`src/host_cmd.js`) | fixed: G9 `version` command                                                            |
| command  | `viewmodel`               | `host_cmd.c:1919` | registered (`src/host_cmd.js`) | fixed: G9 viewthing model-inspection commands                                          |
| command  | `viewframe`               | `host_cmd.c:1920` | registered (`src/host_cmd.js`) | fixed: G9 viewthing model-inspection commands                                          |
| command  | `viewnext`                | `host_cmd.c:1921` | registered (`src/host_cmd.js`) | fixed: G9 viewthing model-inspection commands                                          |
| command  | `viewprev`                | `host_cmd.c:1922` | registered (`src/host_cmd.js`) | fixed: G9 viewthing model-inspection commands                                          |
| command  | `mcache`                  | `host_cmd.c:1924` | registered (`src/host_cmd.js`) | fixed: G9 `mcache` runs `Mod_Print`                                                    |
| function | `M_Menu_Help_f`           | `menu.c:1535`     | defined (`src/menu.js`)        | fixed: G2                                                                              |
| function | `M_Help_Draw`             | `menu.c:1545`     | defined (`src/menu.js`)        | fixed: G2                                                                              |
| function | `M_Help_Key`              | `menu.c:1551`     | defined (`src/menu.js`)        | fixed: G2                                                                              |
| command  | `help`                    | `menu.c:3016`     | registered (`src/menu.js`)     | fixed: G2                                                                              |
| cvar     | `sv_friction`             | `sv_phys.c:42`    | registered (`src/sv_phys.js`)  | fixed: G8 server flag                                                                  |
| cvar     | `sv_gravity`              | `sv_phys.c:44`    | registered (`src/sv_phys.js`)  | fixed: G8 server flag                                                                  |
| cvar     | `sv_maxspeed`             | `sv_user.c:167`   | registered (`src/sv_phys.js`)  | fixed: G8 server flag                                                                  |
| cvar     | `crosshair`               | `view.c:61`       | registered (`src/view.js`)     | fixed: G5 default and archive flag                                                     |
| command  | `flush`                   | `zone.c:814`      | registered (`src/zone.js`)     | fixed: G9 `flush` registered (near no-op under GC)                                     |

### (c) Dead or empty in C too: 57

| Kind     | C name                  | C source          | JS status                                          | Reason                                                                            |
| -------- | ----------------------- | ----------------- | -------------------------------------------------- | --------------------------------------------------------------------------------- |
| function | `Chase_Reset`           | `chase.c:44`      | stub (`src/chase.js`)                              | empty in C too                                                                    |
| function | `SetPal`                | `cl_main.c:275`   | missing                                            | body is `#if 0`                                                                   |
| function | `memsearch`             | `common.c:1183`   | missing                                            | no callers in C                                                                   |
| function | `Draw_DebugChar`        | `gl_draw.c:559`   | missing                                            | no callers in C                                                                   |
| function | `Draw_EndDisc`          | `gl_draw.c:825`   | stub (`src/gl_draw.js`)                            | empty in C too                                                                    |
| function | `D_FlushCaches`         | `gl_rmisc.c:451`  | stub (`src/gl_rmisc.js`)                           | empty in C too                                                                    |
| function | `SCR_BringDownConsole`  | `gl_screen.c:773` | mentioned (`src/cl_main.js`)                       | only call is commented out in C (`cl_main.c:105`); JS keeps the same comment      |
| function | `LoadPCX`               | `gl_warp.c:376`   | missing                                            | `defined(QUAKE2)` (not defined in the GLQuake build)                              |
| function | `fgetLittleShort`       | `gl_warp.c:460`   | missing                                            | `defined(QUAKE2)` (not defined in the GLQuake build)                              |
| function | `fgetLittleLong`        | `gl_warp.c:470`   | missing                                            | `defined(QUAKE2)` (not defined in the GLQuake build)                              |
| function | `LoadTGA`               | `gl_warp.c:488`   | missing                                            | `defined(QUAKE2)` (not defined in the GLQuake build)                              |
| function | `R_LoadSkys`            | `gl_warp.c:642`   | missing                                            | `defined(QUAKE2)` (not defined in the GLQuake build)                              |
| function | `DrawSkyPolygon`        | `gl_warp.c:717`   | missing                                            | `defined(QUAKE2)` (not defined in the GLQuake build)                              |
| function | `ClipSkyPolygon`        | `gl_warp.c:799`   | missing                                            | `defined(QUAKE2)` (not defined in the GLQuake build)                              |
| function | `R_ClearSkyBox`         | `gl_warp.c:927`   | missing                                            | `defined(QUAKE2)` (not defined in the GLQuake build)                              |
| function | `MakeSkyVec`            | `gl_warp.c:939`   | missing                                            | `defined(QUAKE2)` (not defined in the GLQuake build)                              |
| function | `R_DrawSkyBox`          | `gl_warp.c:982`   | missing                                            | `defined(QUAKE2)` (not defined in the GLQuake build)                              |
| cvar     | `developer`             | `host.c:71`       | differs (`src/host.js`): default C='1' JS='0'      | `defined(QUAKE2)` (not defined in the GLQuake build)                              |
| function | `_Host_ServerFrame`     | `host.c:554`      | missing                                            | `defined(FPS_20)` (not defined in the GLQuake build)                              |
| function | `SaveGamestate`         | `host_cmd.c:710`  | missing                                            | `defined(QUAKE2)` (not defined in the GLQuake build)                              |
| function | `LoadGamestate`         | `host_cmd.c:761`  | missing                                            | `defined(QUAKE2)` (not defined in the GLQuake build)                              |
| function | `Host_Changelevel2_f`   | `host_cmd.c:865`  | missing                                            | `defined(QUAKE2)` (not defined in the GLQuake build)                              |
| function | `Host_Please_f`         | `host_cmd.c:956`  | missing                                            | `defined(IDGODS)` (not defined in the GLQuake build)                              |
| command  | `changelevel2`          | `host_cmd.c:1890` | missing                                            | `defined(QUAKE2)` (not defined in the GLQuake build)                              |
| command  | `please`                | `host_cmd.c:1898` | missing                                            | `defined(IDGODS)` (not defined in the GLQuake build)                              |
| function | `_DotProduct`           | `mathlib.c:337`   | missing                                            | no callers in C                                                                   |
| function | `_VectorSubtract`       | `mathlib.c:342`   | missing                                            | no callers in C                                                                   |
| function | `_VectorAdd`            | `mathlib.c:349`   | missing                                            | no callers in C                                                                   |
| function | `_VectorCopy`           | `mathlib.c:356`   | missing                                            | no callers in C                                                                   |
| function | `Invert24To16`          | `mathlib.c:576`   | missing                                            | no callers in C                                                                   |
| cvar     | `idgods`                | `net_main.c:80`   | missing                                            | `defined(IDGODS)` (not defined in the GLQuake build)                              |
| function | `IsID`                  | `net_main.c:985`  | missing                                            | `defined(IDGODS)` (not defined in the GLQuake build)                              |
| function | `PF_TraceToss`          | `pr_cmds.c:641`   | missing                                            | `defined(QUAKE2)` (not defined in the GLQuake build)                              |
| function | `PF_checkpos`           | `pr_cmds.c:678`   | missing                                            | no callers in C                                                                   |
| function | `PF_changepitch`        | `pr_cmds.c:1455`  | missing                                            | `defined(QUAKE2)` (not defined in the GLQuake build)                              |
| function | `PF_WaterMove`          | `pr_cmds.c:1683`  | missing                                            | `defined(QUAKE2)` (not defined in the GLQuake build)                              |
| function | `PF_sin`                | `pr_cmds.c:1808`  | missing                                            | `defined(QUAKE2)` (not defined in the GLQuake build)                              |
| function | `PF_cos`                | `pr_cmds.c:1813`  | missing                                            | `defined(QUAKE2)` (not defined in the GLQuake build)                              |
| function | `PF_sqrt`               | `pr_cmds.c:1818`  | missing                                            | `defined(QUAKE2)` (not defined in the GLQuake build)                              |
| function | `R_DarkFieldParticles`  | `r_part.c:68`     | missing                                            | `defined(QUAKE2)` (not defined in the GLQuake build)                              |
| function | `Sbar_UpdateScoreboard` | `sbar.c:426`      | missing                                            | only caller is inside `#if 0`                                                     |
| cvar     | `bgmbuffer`             | `snd_dma.c:77`    | missing                                            | registered but never read in C                                                    |
| function | `S_AmbientOff`          | `snd_dma.c:100`   | stub (`src/snd_dma.js`)                            | only toggle `snd_ambient`; nothing in C calls them                                |
| function | `S_AmbientOn`           | `snd_dma.c:106`   | stub (`src/snd_dma.js`)                            | only toggle `snd_ambient`; nothing in C calls them                                |
| function | `S_ClearPrecache`       | `snd_dma.c:1004`  | stub (`src/snd_dma.js`)                            | empty in C too                                                                    |
| function | `S_BeginPrecaching`     | `snd_dma.c:1009`  | stub (`src/snd_dma.js`)                            | empty in C too                                                                    |
| function | `S_EndPrecaching`       | `snd_dma.c:1014`  | stub (`src/snd_dma.js`)                            | empty in C too                                                                    |
| function | `DumpChunks`            | `snd_mem.c:227`   | missing                                            | no callers in C                                                                   |
| function | `SV_Trace_Toss`         | `sv_phys.c:1568`  | missing                                            | `defined(QUAKE2)` (not defined in the GLQuake build)                              |
| cvar     | `lcd_x`                 | `view.c:34`       | differs (`src/view.js`): C reads it, JS never does | stereo-glasses code that writes `vid.buffer`; inert under GL                      |
| cvar     | `lcd_yaw`               | `view.c:35`       | differs (`src/view.js`): C reads it, JS never does | stereo-glasses code that writes `vid.buffer`; inert under GL                      |
| cvar     | `cl_crossx`             | `view.c:62`       | differs (`src/view.js`): C reads it, JS never does | read only by the software renderer's crosshair (`view.c:1056`, `#ifndef GLQUAKE`) |
| cvar     | `cl_crossy`             | `view.c:63`       | differs (`src/view.js`): C reads it, JS never does | read only by the software renderer's crosshair (`view.c:1056`, `#ifndef GLQUAKE`) |
| function | `Z_Print`               | `zone.c:219`      | missing                                            | no callers in C                                                                   |
| function | `Hunk_Print`            | `zone.c:315`      | missing                                            | no callers in C                                                                   |
| function | `Cache_Print`           | `zone.c:772`      | missing                                            | no callers in C                                                                   |
| function | `Cache_Compact`         | `zone.c:799`      | missing                                            | no callers in C                                                                   |
