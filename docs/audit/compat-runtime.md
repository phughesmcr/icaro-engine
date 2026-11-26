# Runtime compatibility audit

Audited at `2798ac9` (branch `agent/vision-rules`, equal to `origin/dev`), on
2026-11-26. This audit measures what runs, by loading local content headless
under Deno. Findings from reading the code are marked as such.

## Method

- Throwaway driver outside the repo (`$TMPDIR`-style temp dir, not committed).
  It mirrors `server/headless_host.js` `headless_init`, with two changes: it
  mounts the pak sequence and the game directories (`COM_AddGameDirectory`)
  **before** `Host_Init`, as `main.js` and `game_server.js` do, and it hooks
  `Con_SetAgentHook` to capture every console line. It uses `headless_map`,
  `headless_frame` and `headless_wait_signon` from the repo.
- One Deno process per content set (the host can only be initialised once).
  Flags per set: `-hipnotic`, `-rogue`, `-game mg1|mg3|dopa|ctf`, with the base
  pak and the game directory mounted. Rerelease sets use
  `static/rerelease/id1/pak0.pak` as the base. Retail uses `PAK0.PAK` plus
  `PAK1.PAK`.
- A map "passes" when the loopback client reaches `SIGNONS`, the run does not
  throw, the player has health, and the console shows no error, warning, "not
  found", "couldn't" or "unknown command" line. Console lines are matched with a
  regex, so a map title such as "The Bad Place" shows up as a false hit and was
  discarded by hand.
- Defaults: skill 1, 300 frames at 1/72 s (about 4 s of game time), one player.
- Not downloaded or copied: all data was read from the gitignored `static/`
  paths.

Headless limits: no rendering, no audio, no input. So rendering, sound, touch,
WebTransport and browser storage were not exercised (see "Needs browser").

## Coverage table

Counts are maps (or demos) that passed over maps (or demos) tried. "Own maps"
means the maps in that set's own pak, so a mission pack is not credited with the
id1 maps it also loads.

| Set (flags)                                      | Spawn, skill 1             | Spawn, dm and coop (maxplayers 4) | Save and load | Demos (attract) | Record and replay | Exit, intermission, changelevel       |
| ------------------------------------------------ | -------------------------- | --------------------------------- | ------------- | --------------- | ----------------- | ------------------------------------- |
| Shareware `pak0.pak`                             | 9/9                        | not run                           | 2/2           | 3/3             | pass              | 8/9 (`start` is expected)             |
| Retail id1 (`PAK0`+`PAK1`)                       | 38/38                      | 38/38 and 38/38                   | 6/6           | 3/3             | pass              | 37/38 (`start` is expected)           |
| Hipnotic (`-hipnotic`, retail base)              | 18/18                      | 18/18 and 18/18                   | 3/3           | 4/4             | pass              | 16/17 (`start` is expected)           |
| Rogue (`-rogue`, retail base)                    | 17/17                      | 17/17 and 17/17                   | 4/4           | 3/3             | pass              | 15/16 (`start` is expected)           |
| Rerelease id1 (incl. 15 `test/`, 11 `vault/`)    | 68/68                      | 68/68 and 68/68                   | 7/7           | 3/3             | pass              | 42/43                                 |
| Rerelease hipnotic                               | 18/18                      | not run                           | 2/2           | 4/4             | pass              | 16/17                                 |
| Rerelease rogue                                  | 17/17                      | not run                           | 2/2           | 2/2             | pass              | 15/16                                 |
| Rerelease mg1 (`-game mg1`)                      | 25/25                      | 25/25 and 25/25                   | 5/5           | 1/1 (id1 demo)  | pass              | 22/24                                 |
| Rerelease mg3 (`-game mg3`, Dawn of the Machine) | 20/20                      | 20/20 and 20/20                   | 4/4           | 1/1 (id1 demo)  | pass              | 18/18                                 |
| Rerelease dopa (`-game dopa`)                    | 13/13                      | 13/13 and 13/13                   | 3/3           | 3/3             | pass              | 10/12                                 |
| Rerelease ctf (`-game ctf`)                      | 10/10                      | 10/10 and 10/10                   | 3/3           | n/a (no demo)   | not run           | 2/2 intermission, 1/2 changelevel (6) |
| Community maps (8 loose `.bsp`, retail base)     | 8/8                        | 8/8 (dm only)                     | not run       | n/a             | n/a               | not run                               |
| LibreQuake, Quoth, Arcane Dimensions             | not run (data not present) |                                   |               |                 |                   |                                       |

Notes on the table.

- Spawn totals: 261 map spawns at skill 1, 418 with maxplayers 4 and deathmatch
  or coop, all with signon reached and no exception. The same sets also ran with
  their parent set's maps under every flag combination, with no new failure
  other than the Dopa case in finding 4.
- Skill 3: retail 38/38 and mg3 20/20 signed on. Long run (3000 frames, about 40
  s of game time): retail `e1m1`, `e2m2`, `e3m3`, `e4m4`, and mg3 `map4`,
  `map5`, `secret2` all survived (mg3 `secret2` has 1467 edicts).
- Save and load: `save` then `load` in the same process, then 120 more frames.
  After load the edict count, living-entity count and summed entity health
  matched the state at save time on 41 of 41 maps. This was a round trip of this
  build's own save format. A save made by another engine was not tried.
- Demos: every attract demo plays to the end (the "ended" check is
  `cls.demoplayback` going false). Record: `record <name> <map>` then `stop`
  produced 25 to 70 KB of demo and `CL_PlayDemoFromData` played it back to the
  same `cl.time` (within 0.03 s) on 10 sets. The blob comes out through a
  browser download, so the driver stubbed `document.createElement("a").click`.
  No player input was injected, so the recorded demos contain an idle player.
- Exit and changelevel: the player was placed in the first `trigger_changelevel`
  and relinked, which started the intermission (7 frames) on every map that has
  one, then `changelevel <target>` loaded the next map and ran 60 frames.
  "Expected" means a `start` hub whose triggers have no intermission. The
  waiting-for-key leg of the intermission was not driven (no input).

## Findings, ranked

No blockers and no crash was found. Everything in the table passed, so the
findings are gaps and risks, not failures of the content that was available.

### 1. Mission packs and game directories cannot be run through the headless host (medium)

- Evidence (by running). `headless_init` mounts one pak and no game directory
  (`server/headless_host.js:207-243`). Calling `COM_AddGameDirectory` after it
  returns (the obvious workaround) fails every Hipnotic and Rogue map's status
  bar: 37 and 13 distinct `Sys_Error: W_GetLumpinfo: inv_laser not found`,
  `r_lava not found` and similar lines, because `gfx.wad` was already loaded by
  `Host_Init`. The first, wrong, rerelease run in `docs/rerelease-gaps.md` ("The
  mission-pack flags were not set") has the same gap. My driver's order
  (directories first, then `Host_Init`) fixes it.
- Impact: the agent API, `server/agent_mcp.ts` and any scripted test cannot load
  hipnotic, rogue, mg1, mg3, dopa, ctf, Quoth or LibreQuake. This also bears on
  #237 and #243 (agent API), which should not assume id1 only.
- Effort: S. Fix: `headless_init` accepts `opts.game_dirs` (and `opts.base`) and
  calls `COM_AddGameDirectory` for each before `Host_Init`, then the loose-file
  paths as `tools/bench/server_bench.js:111-117` does. Reference:
  `server/game_server.js:495-520` (the order the real servers use).

### 2. Only protocol 15 (demos) and Icaro's 1015 exist; no 666 or 999 (medium, by reading)

- Evidence: `src/protocol.js:3-26` defines `PROTOCOL_VERSION = 15` and
  `PROTOCOL_ICARO = 1015` only. Nothing in `src/` mentions FitzQuake's 666 or
  RMQ's 999 as a protocol the client reads.
- Impact: demos recorded by QuakeSpasm, Ironwail or Quakespasm-based tools
  (including most community speed-run demos) will not play. With "only Icaro
  servers must interoperate" this is by design for the network. For demos and
  for mods whose QuakeC reads `sv.protocol` it is a visible gap. The port's own
  header says demos recorded by earlier Icaro builds no longer play, so any demo
  format change needs a version tag.
- Effort: M for read-only 666 and 999 demo playback (client parse paths exist
  for the extension bits; the framing and `svc_` tables differ). Reference:
  Ironwail `protocol.h`, `cl_parse.c`.

### 3. `-quoth` is not a recognised flag (low, by reading)

- Evidence: `COM_InitArgv` handles `-rogue` and `-hipnotic`
  (`src/common.js:777`) and the servers handle those plus `-game`
  (`server/game_server.js:164-167`). `-game quoth` works as a plain game
  directory on the game server. (Correction: the browser's `?game=quoth` is
  ignored, because `main.js` accepts only its fixed list.) QuakeSpasm and
  Ironwail also accept `-quoth` as a shortcut.
- Impact: only convenience and command-line parity. Quoth itself was not run (no
  data); what a test needs is under "Content not present".
- Effort: S. Fix: map `-quoth` to `-game quoth` in `COM_InitArgv` and
  `game_server.js`. Reference: Ironwail `common.c` (`COM_InitFilesystem`).

### 4. Dopa progs cannot start four id1 maps without mg1's rune model (low)

- Evidence (by running): with `-game dopa`, `e1m7`, `e2m6`, `e3m6` and `e4m7`
  never sign on: `Host_Error: Mod_LoadModel: progs/mg1_rune1.mdl not found`. The
  model is only in `rerelease/mg1/pak0.pak` and `rerelease/mg3/pak0.pak`, not in
  `QuakeEX.kpf` (627 entries, checked with `zipfile`). All 13 of Dopa's own maps
  pass.
- Impact: probably also the case in the real game (Dopa's four boss maps use its
  rune, which ships in mg1), so it may be data, not engine. After the
  `Host_Error`, `headless_map` waits until timeout: the client stays at signon
  0, with no visible error beyond the console line.
- Effort: S to confirm with Ironwail or KEX using `-game dopa`; none if
  confirmed as data. Reference: Ironwail, KEX.

### 5. `ctfscores` is an unknown command on every CTF map (low)

- Evidence (by running): `Unknown command "ctfscores"` on all 10 `-game ctf`
  maps, in both spawn modes (the console line is at the first frames). It is a
  `stuffcmd` from the CTF progs, so it comes from QuakeC.
- Impact: console noise now. Whether the KEX client does something with it (a
  scoreboard) was not checked.
- Effort: S to register a no-op; M if a scoreboard is wanted. Reference: KEX
  (via Ironwail, which has no CTF client). Check what Ironwail does with it.

### 6. `ctf4` exits to `idctf1`, which is not in the CTF pak (low, data)

- Evidence (by running): `changelevel idctf1` gives
  `Couldn't find map:
  idctf1`. Only `zoidctf4.rmf` matches in the CTF pak.
  Likely a leftover in the shipped data, not an engine bug. Listed so it is not
  mistaken for one.
- Effort: none. Reference: rerelease data.

### 7. `ogre_rocket.md5anim` bone count warning on first mg3 load (low)

- Evidence (by running):
  `Warning: progs/ogre_rocket.md5anim has incorrect bone
  count (expected 55, found 39)`,
  once per process, on the first mg3 map that loads the model (`map1` or `hub`).
  It is printed without `developer`.
- Impact: the model falls back to the `.mdl`, so a visible difference is
  possible. Not seen in a browser. The warning comes from `src/gl_md5.js`.
- Effort: S to read what Ironwail does with the same pair of files
  (`gl_model.c`, `Mod_LoadMD5Anim`); it may also warn there. Reference:
  Ironwail.

### 8. Headless sound noise and recording needs a browser download (low, tooling)

- Evidence (by running): without audio, replayed sounds print
  `CL_ParseStartSoundPacket: sound_num N not precached` (after `load` and in
  demos). `src/agent.js:346` already filters this one line. `CL_Stop_f`
  downloads the demo through `document.createElement("a").click()`
  (`src/cl_demo.js:253-263`), so `record` and `stop` throw
  `a.click is not a
  function` in the headless host.
- Effort: S for both. Fix: give `fakeElement` a `click`, and either keep the
  last demo buffer in a virtual file or return it for scripts.

### 9. Large signon buffers on big maps (informational, `developer 1` only)

- Evidence (by running, `developer 1`):
  `Warning: N byte signon buffer exceeds
  standard limit of 7998` on 1 retail
  map (`e2m6`, 8109 bytes), many mission pack and mg1 maps, and 14 of 20 mg3
  maps (up to 26131 bytes on `map8`). Source: `src/sv_main.js:2436-2441`.
- Impact: none for Icaro's own client and server (the buffer is not limited to
  8000 bytes here). It matters if a second engine ever joins; the goals say it
  does not need to. The retail `e2m6` hit means vanilla NetQuake clients would
  have trouble with it, as with the original game.

## Clean results worth recording

- No `Host_Error`, exception, `Sys_Error` or missing-asset line on any own map
  of retail, shareware, hipnotic, rogue, rerelease id1 (including `test/` and
  `vault/`), mg1 (including the 11 BSP2 maps), mg3 (including `secret2`: 607
  models, 1467 edicts) and the 8 community maps. This extends
  `docs/rerelease-gaps.md` "Headless spawn" (no client, 100 frames, no
  mission-pack flags) to a client signed on, 300 frames, flags set, and both
  deathmatch and coop with four slots.
- `couldn't exec config.cfg` and `autoexec.cfg` print on the first map only, as
  in the C engine with no config files. Not a finding.

## Needs browser (not checkable headless)

- Rendering of every map, the BSP2 map limits (3 maps have over 32767 leafs),
  MD5 models (finding 7), fog, `.lit` files, skyboxes.
- Sound, music and the `sound_num not precached` path with real audio.
- Touch, WebXR, gamepad, the menu `Load` and `Save` screens, and saves kept in
  browser storage (the headless host uses an in-memory store; a v5 file from
  another session was not loaded).
- WebTransport, WebSocket and WebRTC with more than one real client. Slots 2 to
  4 were empty in the coop and deathmatch runs, so spawning a second player and
  `SV_SpawnServer` with real remote clients are not covered.
- Recording with live input, and playing back a demo made in a browser session.

## Content not present: what a test would need

- **LibreQuake**: a `pak0.pak` and `pak1.pak` pair under a game directory (it is
  meant to replace id1, so mount it as the base, with no id1 behind it). The
  test is the same spawn, save, demo and exit runs as above plus a check that
  the menus, the status bar and `gfx.wad` lumps do not depend on id1 names.
  Needs the project's own copy to be added to `static/` (gitignored or
  committed, a decision for the maintainer). Source: the LibreQuake releases
  page on GitHub.
- **Quoth** (2.x): `-game quoth` with `quoth/pak0.pak` (maps, `progs.dat`),
  loose `.lit` files, and a map from a Quoth-based mod. It needs QuakeC
  extension builtins (`checkextension` exists, `src/pr_cmds.js:1404`; the
  extensions list it reports and the builtin numbers should be diffed against
  QuakeSpasm's). Test: spawn all maps of one Quoth mod, then watch the console
  for "unimplemented builtin" lines.
- **Arcane Dimensions**: needs `ad/` (about 10 paks), large BSP2 maps, extended
  `.mdl` frame counts, many external sounds, and QuakeSpasm 0.95 or Ironwail as
  its reference. Test with `-game ad`, several maps, and 3000 frames to catch
  entity and model limits. Also a good check of finding 2's protocol story.

## Overlaps with open PRs (not duplicated here)

- #237 and #243 (agent API): finding 1 belongs with them if `window.icaro` or
  the MCP server load `headless_init`; the agent options need game directories.
- #240 (BYO paks from browser storage): the game-directory order (directories
  before `Host_Init`) in finding 1 applies to that loader too.
- #242 (status docs): numbers in the coverage table can replace the "Headless
  spawn" section in `docs/rerelease-gaps.md`, which says the mission-pack flags
  were not set.
- #235, #238, #239 and #241 were not touched by this track.
