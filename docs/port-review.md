# Port fidelity review: Icaro Engine vs WinQuake / GLQuake

Review of the JavaScript engine in `src/` against id Software's original C source, looking for places where the port **behaves** differently from the original (gameplay, rendering, sound, correctness).

| | |
|---|---|
| Date | 2026-11-23 |
| Port revision | `dfef74a` (branch `dev`) |
| Reference source | [id-Software/Quake](https://github.com/id-Software/Quake) `bf4ac42` — `WinQuake/` (WinQuake + GLQuake `gl_*.c`), `QW/` (QuakeWorld) |
| Renderer | Three.js r183 |
| Test baseline | `deno test --allow-read --allow-net --allow-env tests/` → 36 passed, 0 failed |

## Method

1. A script inventoried every C function, cvar and console command in the reference and checked for a same-named counterpart in `src/`.
2. Reviewers, one per subsystem, compared the port function by function against the matching C file. They looked for integer truncation, signedness, float32 vs double, falsy-zero checks, aliasing, dropped branches and wrong constants.
3. The model loaders were also checked empirically. A Deno script loaded every map, model and sprite in the shareware `pak0.pak` through the port and compared the results against C-equivalent computations.
4. The lead reviewer opened both sides for every finding ranked medium or higher before including it.

Nothing was played in a browser. Severity is judged from the code.

**Status legend**

- **Verified**: the lead reviewer read both the JS and the C and confirmed the difference.
- **Reported**: a subsystem reviewer read both sides; not independently re-checked.

Line numbers refer to `dfef74a`. C references use function names, which are stable across copies of the source.

## Fix status

Every finding but one has a fix in an open PR against `dev`. The exception is C-5 (mirrors), which is documented in the code instead of fixed. No PR is merged yet. Each PR's description has a per-item table.

Test counts are from `deno test --allow-read --allow-net --allow-env tests/` on each PR's branch. Nothing has been played in a browser or against a live server.

[#2]: https://github.com/phughesmcr/icaro-engine/pull/2
[#3]: https://github.com/phughesmcr/icaro-engine/pull/3
[#4]: https://github.com/phughesmcr/icaro-engine/pull/4
[#5]: https://github.com/phughesmcr/icaro-engine/pull/5
[#6]: https://github.com/phughesmcr/icaro-engine/pull/6
[#7]: https://github.com/phughesmcr/icaro-engine/pull/7
[#8]: https://github.com/phughesmcr/icaro-engine/pull/8
[#9]: https://github.com/phughesmcr/icaro-engine/pull/9
[#10]: https://github.com/phughesmcr/icaro-engine/pull/10

| Findings | PR | Status |
|---|---|---|
| SP-7, MP-3, C-8 to C-14, C-20 to C-22 | [#2] | Fixed (55 tests pass) |
| SP-1, SP-5, SP-6, SP-9, MP-1, MP-5 (server items), MOD-1 to MOD-4, C-19 | [#3] | Fixed (47 pass) |
| SRV-1 to SRV-5 | [#4] | Fixed; the lobby's own permissions are documented rather than enforced (47 pass; 1 more test needs `--allow-run --allow-write`) |
| SP-2, SP-3, SP-4, SP-8, MP-4, MP-5 (client half), MOD-5, C-1 to C-4, C-6, C-7, C-15 to C-18, IN-3 (view comfort) | [#5] | Fixed (41 pass) |
| C-5 (mirrors) | [#5] | **Not fixed.** The stub stays, with a comment: GLQuake only draws mirrors when `r_mirroralpha` is below its default of 1, the only mirror is in registered-only e2m3, and a real one needs a mirrored render-to-texture pass |
| PRED-1, PRED-3, PRED-4, PRED-5, IN-3 (movement angles) | [#6] | Fixed, with residuals below (50 pass) |
| IN-1, IN-2, IN-3 (rest), IN-4, IN-5 | [#7] | Fixed, with residuals below (48 pass) |
| NET-1 to NET-5, PRED-2 | [#8] | Fixed (59 pass) |
| `WT_*` no-op stubs, `WT_Listen` failure, server README | [#9] | Fixed; stacked on #4 and #8 (71 pass) |
| MP-2, MP-5 (`U_NOLERP`), solid monsters for prediction (`PE_SOLID`), movevars 11–12, player movetype, `COM_CheckRegistered`, menu episodes | [#10] | Fixed; stacked on #3, #5 and #6 (76 pass) |

All nine fix branches merge into `dev` together without conflicts. With `--allow-run --allow-write` added, the combined tree passes all 143 tests.

**Merge order:**
- #2 to #8 are independent of each other.
- Merge #9 after #4 and #8.
- Merge #10 after #3, #5 and #6.
- #10 changes the packet-entity wire format without bumping `PROTOCOL_VERSION`, which has to stay 15 for the shipped demos. Deploy the client and server together, and make sure clients don't keep a cached bundle across the change.

**Unsigned commits** (made while no one could answer the signing prompt): re-sign these before merging.
- [#9]: `278f182` and `0b8f2b3`
- [#10]: `7a37ad0`
- [#1]: the commits that added this section

[#1]: https://github.com/phughesmcr/icaro-engine/pull/1

### Residuals and follow-ups

Deliberate gaps and items noticed along the way. None has a PR.

- **Prediction ([#6], [#10]):** the teleport back-move lock, `punchangle`/`fixangle` and QuakeC `pausetime` are not predicted, because the server never sends `teleport_time` or `pausetime` and sends only the latest `punchangle`.
- **Input ([#7]):**
  - Ctrl/Alt key combos stay blocked in the browser.
  - XR smooth turn speed is unchanged; snap turn is opt-in through `xr_snapturn`.
  - Numpad keys map as `vid_win.c` does, not to separate `K_KP_*` codes.
  - The touch-menu, snap-turn and XR internals have no tests.
- **Transport ([#8]):**
  - Moves stay on the reliable stream by design. Switching them to datagrams is a one-line change but needs a load test.
  - Joining through the lobby port without a redirect is still broken (it predates the PR); it now fails cleanly.
  - `cl_parse.js` still uses `ackSeq >= 0` as a "have an ack" sentinel.
- **Registered content ([#10]):**
  - `COM_FindFile`'s shareware rule refusing loose files with `/` in the path is not ported, since it would refuse the loose deathmatch maps.
  - WinQuake's `WINDED` dedicated-server error is not ported.
- **Packet entities ([#10]):**
  - When a frame overflows the datagram, high-numbered entities wait for later frames.
  - `delta_sequence` is not age-checked against `PE_UPDATE_BACKUP`.

---

## 1. Findings that affect every single-player session

### SP-1 · Dying restarts the level with a fresh inventory — **high**, Verified

- **Port:** [`src/host_cmd.js:218`](../src/host_cmd.js) `Host_Restart_f` runs `Cbuf_AddText('map ' + mapname)`.
- **C:** `host_cmd.c` `Host_Restart_f` calls `SV_SpawnServer(mapname)` directly. It also returns early during demo playback and for commands not typed locally.
- **Why it matters:** the game code in `progs.dat` sends `restart` from `respawn()` whenever the player dies in single player. The string `restart\n` is present in `static/pak0.pak`.
- **Mechanism:**
  1. `Host_Map_f` calls `CL_Disconnect` and `Host_ShutdownServer`, and zeroes `svs.serverflags`.
  2. The client then reconnects through `SV_ConnectClient`.
  3. `SV_ConnectClient` runs `SetNewParms` because `sv.loadgame` is false.
- **Effect:**
  - After every death the player respawns with the shotgun, 100 health and no carried items. In the original you get the inventory you had when you entered the level.
  - Collected runes are wiped, so the episode-completion state is lost.
- **Fix direction:** port `Host_Restart_f` literally. Keep the `cls.demoplayback` and `cmd_source` guards, and call `SV_SpawnServer(sv.name)` so the clients' `spawn_parms` survive.

### SP-2 · No muzzle-flash light for any player — **medium-high**, Verified

- **Port:** [`src/cl_main.js:866`](../src/cl_main.js) `CL_LinkPlayers` handles only `EF_BRIGHTLIGHT` and `EF_DIMLIGHT`.
  - `EF_MUZZLEFLASH` is only checked for packet entities (`:664`) and in the NetQuake relink loop (`:1070`).
  - Both of those loops skip player slots. Nothing else in `src/` creates the light.
- **C:** `cl_main.c` `CL_RelinkEntities` creates the muzzle-flash dynamic light for every entity, including `cl.viewentity`.
- **Effect:** firing a weapon never lights the surroundings, in single player or for other players in deathmatch.
- **Fix direction:** add the `EF_MUZZLEFLASH` light (radius 200 + rand&31, minlight 32, die +0.1, positioned forward of the player) to `CL_LinkPlayers`.

### SP-3 · Dynamic light brightness depends on lifetime, not radius — **medium-high**, Verified

- **Port:** [`src/gl_rlight.js:172-181`](../src/gl_rlight.js)

  ```js
  const timeLeft = Math.min( l.die - cl.time, 0.5 );
  pointLight.intensity = 10000 * timeLeft;
  pointLight.distance = l.radius;
  ```

- **C:** with the default `gl_flashblend 1`, GLQuake draws a corona of radius × 0.35 and does not light the world. With `gl_flashblend 0`, it adds `rad - dist` into the lightmaps.
- **Effect:**
  - Per-frame lights get intensity about 10, which is effectively invisible. These include rockets and `EF_BRIGHTLIGHT`/`EF_DIMLIGHT` entities, created with `die = cl.time + 0.001` at `cl_main.js:649`, `:660` and `:882`.
  - Explosions get 5000 (`cl_tent.js:202`), so lights with the same radius differ in brightness by up to 500×.
- **Fix direction:** derive intensity from `l.radius` (and `minlight`), and use the remaining time only for the fade-out.

### SP-4 · Damage kick and strafe roll use zeroed prediction state — **medium**, Verified

- **Port:**
  - [`src/view.js:389`](../src/view.js) and `:396` (`V_ParseDamage`) use `cl_simorg` and `cl_simangles`.
  - `:739` (`V_CalcViewRoll`) uses `V_CalcRoll(cl_simangles, cl_simvel)`.
- **C:** `view.c` uses `cl_entities[cl.viewentity].origin` and `.angles`, and `cl.velocity`.
- **Mechanism:**
  - `cl_simorg` and `cl_simangles` are only written inside `CL_PredictMove` (`cl_pred.js:860-927`).
  - `CL_PredictMove` only runs when `!sv.active && !cls.demoplayback` (`cl_main.js:1190`).
  - In single player and demo playback they therefore stay at (0, 0, 0).
  - Other call sites in the same file already guard with `usePrediction` (`view.js:808`, `:856`).
- **Effect:**
  - Damage kicks the view in an arbitrary direction, computed from the attacker's absolute position.
  - Strafe roll depends on world-Y velocity instead of velocity relative to facing.
- **Fix direction:** use the same `usePrediction ? cl_sim* : entity/cl` selection as `V_CalcRefdef`.

### SP-5 · Map-load "settle" frames run with the wrong time step — **medium**, Verified

- **Port:** [`src/sv_main.js:1764`](../src/sv_main.js) calls `set_host_frametime(0.1)` and then `SV_Physics()` twice.
- **Mechanism:**
  - `set_host_frametime` (`host.js:98`) only sets `host.js`'s own variable.
  - `sv_phys.js` keeps its own `host_frametime` (`:186`). Only `SV_SetFrametime` updates it, once per host frame (`host.js:454`).
  - `SV_Physics` advances `sv.time` by that local copy (`sv_phys.js:1626`).
- **C:** `sv_main.c` `SV_SpawnServer` sets the shared global `host_frametime = 0.1`, and both settle frames advance time by 0.1 s.
- **Effect:**
  - On the first map load the step is 0. On later loads it is the previous frame's step (about 0.014 s).
  - Spawn-time thinks scheduled within 0.2 s don't run before `SV_CreateBaseline`. These include item `droptofloor`, door linking and `monster_start_go`.
  - Baselines are therefore captured at unsettled origins, and game time starts about 0.2 s behind.
- **Fix direction:** make `set_host_frametime` also call `SV_SetFrametime`, or have the settle frames call it directly.

### SP-6 · `SV_WalkMove` can throw on an empty step trace — **medium (rare)**, Verified

- **Port:** [`src/sv_phys.js:1218`](../src/sv_phys.js) sets `steptrace = {}` before the step-up `SV_FlyMove`. `:1237` then runs `if (clip & 2) SV_WallFriction(ent, steptrace)`.
- **Mechanism:** `SV_FlyMove` only fills `steptrace` when it hits a vertical wall. Two paths return with bit 2 set but leave the trace untouched:
  - the all-solid return (3)
  - `SV_TryUnstick` returning 7
- **C:** `steptrace` is a stack struct that still holds the first move's trace, so the original never faults.
- **Effect:** in rare geometry, `SV_WallFriction` reads `trace.plane.normal` of `{}`, throws a TypeError and aborts the frame.
- **Fix direction:** reuse one persistent trace object, as C does, or guard on `steptrace.plane`.

### SP-7 · Sound channel selection and ambient spatialisation — **medium**, Verified

- **Channel picking:** [`src/snd_dma.js:299`](../src/snd_dma.js) `SND_PickChannel`.
  - The first empty and first finished channel are skipped with `continue`, so they never become `first_to_die`.
  - `paintedtime` never advances, because `S_PaintChannels` has no callers. So `end - paintedtime` is the sound's total length, not the time remaining.
  - C's `SND_PickChannel` picks the channel nearest completion, and empty channels (end = 0) win.
- **Ambient channels:** [`src/snd_dma.js:751`](../src/snd_dma.js) `S_Update` spatialises channels starting at `i = 0`. C starts at `NUM_AMBIENTS`.
- **Effect:**
  - When exactly one channel is free, or all 32 are busy, the port cuts off the shortest sound rather than the one about to finish.
  - Water and wind ambience is treated as a point source at the map origin. It pans and can play up to 2× too loud.
- **Fix direction:** prefer empty or finished channels, then pick the shortest time remaining. Start the spatialise loop at `NUM_AMBIENTS`.

### SP-8 · Demos recorded by the port likely play back without entities — **medium**, Verified (code path), not run

- **Port:** [`src/cl_main.js:989`](../src/cl_main.js) has `usePacketEntities = CL_GetValidSequence() !== 0 && cls.demoplayback === false`.
- **Mechanism:**
  - Recording captures the live stream, which uses QuakeWorld-style `svc_packetentities` and `svc_playerinfo`.
  - During playback the NetQuake relink path is forced. That path only knows entities set up by `CL_ParseUpdate`, which never arrives.
  - Original Quake demos are unaffected.
- **Fix direction:** link packet entities during playback whenever the demo contains them.

### SP-9 · Freed entities are never unlinked from the world — **low-medium**, Verified

- **Port:** [`src/pr_edict.js:150`](../src/pr_edict.js) `ED_Free` only runs `sv.SV_UnlinkEdict` if it exists. Nothing assigns it.
- **C:** `pr_edict.c` `ED_Free` calls `SV_UnlinkEdict(ed)` unconditionally.
- **Effect:** removed entities (rockets, gibs, triggers) stay in the area-node lists until their slot is reused. Collision mostly ignores them because `ED_Free` sets them non-solid. The cost is extra list walking, plus a risk for any code that reads the lists without checking `solid`.
- **Fix direction:** import `SV_UnlinkEdict` from `world.js` (or inject it at init) and call it.

---

## 2. Findings that affect multiplayer

### MP-1 · Datagram overflow is fatal — **high impact, low-medium probability**, Verified

- **Port:**
  - The client datagram is `{ maxsize: MAX_DATAGRAM /*1024*/, allowoverflow: false }` ([`src/sv_main.js:1245`](../src/sv_main.js)).
  - Entities are capped only by count (`:842`). `SV_WriteDelta`, `SV_EmitPacketEntities` and `SV_WritePlayersToClient` never check the remaining size.
  - [`src/common.js:246`](../src/common.js) `SZ_GetSpace` then calls `Sys_Error('SZ_GetSpace: overflow without allowoverflow set')`.
- **C:** `sv_main.c` `SV_WriteEntitiesToClient` stops with "packet overflow" when fewer than 16 bytes remain.
- **Worst case:**
  - About 56 fully changed entities overflow the 1024 bytes after fixed overhead.
  - With 16 players in view, about 50 entities are enough.
  - This happens on full-update frames (first frame, after a flush, level start) in busy scenes.
  - When the entities fill the buffer, the trailing `sv.datagram` copy (sounds, particles, temp entities) is also silently skipped.
- **Fix direction:** add a size check before each entity and player write, and stop the packet gracefully.

### MP-2 · Hard cap of 64 entities per packet — **medium**, Verified

- **Port:** [`src/sv_main.js:842`](../src/sv_main.js) has `if ( pack.num_entities >= MAX_PACKET_ENTITIES ) continue;`, where `MAX_PACKET_ENTITIES = 64`.
- **C:** NetQuake has no count cap; its only limit is the byte-budget check above.
- **Effect:** entities are visited in edict order, so in big fights the most recently spawned ones vanish: projectiles, gibs, the player's own rockets.

### MP-3 · Team chat is never team-only — **medium**, Verified

- **Port:** [`src/console.js:173`](../src/console.js) `Con_MessageMode2_f` only sets `key_dest`. `team_message` (`src/keys.js:276`) is never assigned anywhere.
- **C:** `console.c` sets `team_message = true` in `Con_MessageMode2_f` and `false` in `Con_MessageMode_f`.
- **Effect:** `messagemode2` always sends `say`, never `say_team`.

### MP-4 · Other players' shirt and pants colours are never applied — **medium**, Reported

- **Port:** `src/cl_main.js` `CL_LinkPlayers` (~`:909-917`) never sets `ent.colormap`.
- **C:** `cl_parse.c` sets `ent->colormap = cl.scores[i-1].translations`.

### MP-5 · Other multiplayer divergences — **low to low-medium**, Reported

- **`kill` with a local server:** [`src/host_cmd.js:562`](../src/host_cmd.js) `Host_Kill_f` re-executes the command locally with stale `host_client`/`sv_player` instead of forwarding it. With `maxclients > 1` it can kill the last-iterated client rather than the one who typed it.
- **`bprint` to connecting clients:** [`src/pr_cmds.js:239`](../src/pr_cmds.js) `PF_bprint` writes to clients that are active but not yet spawned, and also echoes to the local console. C goes through `SV_BroadcastPrintf`, which requires `spawned`.
- **Duplicate console lines:** `SV_BroadcastPrintf` (`src/host.js:868`) also prints locally, so pause and fraglimit messages appear twice on a listen server.
- **`kick` reason:** [`src/host_cmd.js:769`](../src/host_cmd.js) `Host_Kick_f` includes the player's name in the kick reason.
- **`status`:** [`src/host_cmd.js:86`](../src/host_cmd.js) `Host_Status_f` is a three-line stub with no client list and no forwarding to a remote server.
- **Monster interpolation:** `U_NOLERP` / `MOVETYPE_STEP` is not carried by packet entities, so remote clients would interpolate step-moving monsters. There is no effect in single player. While PRED-1 stands, remote clients don't interpolate anything; this applies once PRED-1 is fixed.
- **Slots re-entering the view:** an entity slot that re-enters the PVS or is reused within 64 sequences would interpolate from its stale position on remote clients. This only applies once PRED-1 is fixed.
- **Origin deltas:** the delta threshold compares against the last acknowledged frame, not a fixed baseline. Drift below 0.1 unit per frame on an axis is never sent. This is QuakeWorld's own behaviour.
- **Chase camera:** `chase_active 1` shows no player body, because `CL_LinkPlayers` always skips the view entity.

---

## 3. Findings that affect mods or retail data

### MOD-1 · `find()` with an empty string ends the game — **medium (mods)**, Verified

- **Port:** [`src/pr_cmds.js:870`](../src/pr_cmds.js) `PF_Find` does `if ( ! s ) PR_RunError(...)`, and `if ( ! t ) continue;` for each entity.
- **C:** `pr_cmds.c` `PF_Find` tests `char *` pointers there, and those are never NULL. The empty string is a valid search that matches entities with an empty field.
- **Effect:** `find(world, targetname, self.target)` with an unset `target` raises a QuakeC program error, which ends the game.

### MOD-2 · No `registered` cvar — **medium with retail pak**, Verified

- `common.c` `COM_CheckRegistered` sets `registered 1` when `gfx/pop.lmp` exists. The port has neither the cvar nor the check.
- With the shipped shareware `pak0.pak` the behaviour is correct.
- With a retail pak, the episode gates in `start.bsp` (`trigger_onlyregistered`) stay shut.

### MOD-3 · Entity strings with bytes ≥ 0x80 are corrupted — **low-medium**, Reported

- **Port:** [`src/pr_edict.js:742`](../src/pr_edict.js) `ED_NewString` encodes strings as UTF-8, but `PR_GetString` decodes them byte by byte as Latin-1.
- **Effect:** coloured or gold text in entity fields reads back as two garbage characters per byte.

### MOD-4 · Smaller builtin differences — **low**, Reported

- `PF_ftos` and `PF_vtos` drop the `%5.1f` padding.
- `OP_NE_S` returns 1 instead of the raw `strcmp` value. Truthiness is unchanged.
- `PF_sound` dropped the range checks on volume, attenuation and channel.
- `PR_GlobalString` is a stub, so runtime-error statement dumps show raw offsets.
- The `give` command lacks the hipnotic and rogue items.

### MOD-5 · Model edge cases (loaders) — **low**, Reported (checked on all shareware assets)

- `StripLength`/`FanLength` in `src/gl_mesh.js` keep scanning where C's `goto done` stops. This only matters for non-manifold meshes.
- The seam offset (`skinwidth / 2`) and sprite `mins`/`maxs` use float division where C truncates to int. This only matters for odd sizes.
- The face `planenum` is read as unsigned where C uses a signed short.

None of these change any shareware model. All 61 MDLs produced byte-identical display-list commands to a C-faithful implementation.

---

## 4. Cosmetic and presentation differences

| ID | Where | Difference | Status |
|---|---|---|---|
| C-1 | `src/gl_rmain.js:812` `R_DrawAliasModel` | Missing `progs/eyes.mdl` 2× scale under `gl_doubleeyes` (the cvar is registered but never read). | Verified |
| C-2 | `src/r_part.js:800` | Particles are 3-unit point sprites centred on the origin, with no `1 + dist*0.004` growth. Far particles look smaller and near ones about 2× larger than in GLQuake. | Reported (sizing verified) |
| C-3 | `src/gl_rsurf.js` (~`:969`, `:1961`, `:1995`) | Water warp is driven by `cl.time`, not `realtime`, so it freezes when paused. | Reported |
| C-4 | `src/gl_rsurf.js` (~`:1886`) | `r_fullbright` and `r_lightmap` have no effect; materials always apply the lightmap. | Reported |
| C-5 | `src/gl_rmain.js:1309` `R_Mirror` | Mirrors aren't implemented, so the e2m3 mirror shows no reflection. The code documents this as a known gap. | Verified |
| C-6 | `src/gl_draw.js:743` `Draw_ConsoleBackground` | The console is always opaque; GLQuake fades it to about 0.8 alpha at half height. | Reported |
| C-7 | `src/view.js:765` `V_CalcIntermissionRefdef` | The intermission and finale camera follows the mouse (uses `cl.viewangles` instead of the entity angles). | Reported |
| C-8 | `src/gl_screen.js:377` `SCR_SizeUp_f`/`SizeDown_f` | Edit `.value` directly, so viewsize changed with +/- isn't shown in the console or saved. | Reported |
| C-9 | `src/sbar.js` (~`:820`) | No disc over the armour icon during invulnerability. | Reported |
| C-10 | `src/sbar.js` (~`:368`) `Sbar_DrawNum` | Keeps the leftmost digits for values above 999, and draws the minus sign outside the digit cells. | Reported |
| C-11 | `src/menu.js` (~`:711`) | "New Game" starts without the "Are you sure?" prompt. | Reported |
| C-12 | `src/menu.js` (~`:1513`) | The Options menu lacks the CD Music Volume slider; the Keys menu lets you bind backtick. | Reported |
| C-13 | `src/console.js` (~`:524`) `Con_DrawNotify` | No blinking cursor in chat input. | Reported |
| C-14 | `src/console.js` (~`:102`) `Con_ToggleConsole_f` | Clears the input line but doesn't reset `key_linepos`, so the next command is lost. | Reported |
| C-15 | `src/client.js:88` | `cshift.percent` is a double, not an int, so damage and bonus flashes fade at a slightly different, frame-rate-independent speed. | Reported |
| C-16 | `src/cl_tent.js` | Ricochet sounds are evenly distributed; C plays `ric3` 50% of the time (`rand()&3`). | Reported |
| C-17 | `src/cl_parse.js` `CL_ParseServerInfo` | The `\x02` highlight is dropped from the level-name banner. | Reported |
| C-18 | `src/view.js:131` `V_CalcBob` | Weapon bob freezes while airborne in single player, and its phase isn't tied to `cl.time`. | Reported |
| C-19 | `src/sv_user.js` (~`:141`) `SV_SetIdealPitch` | Uses fractional steps where C truncates to int, so very gentle ramps cause view pitch drift. | Reported |
| C-20 | `src/snd_dma.js` (~`:1029`) | The gain/pan model (`max(l,r)/255` plus a StereoPanner) lacks C's per-side 255 clamp, so hard-panned sounds can be up to 6 dB louder. | Reported |
| C-21 | `src/sound.js:162`, `src/snd_dma.js` `S_PlayVol` | The default `volume` is 0.4 instead of 0.7; `playvol x 0` plays at full volume. | Reported |
| C-22 | `src/console.js` `_sprintf` | `%i` floors instead of truncating, and there's no `%x`. | Reported |

---

## 5. Areas that match the original

These were compared function by function and found faithful:

- **QuakeC VM:**
  - every opcode in `PR_ExecuteProgram`
  - the builtin table (indices 0-78)
  - all 92 global offsets and 105 entity-field slots, checked programmatically against `progdefs.q1`
  - the `ED_Alloc` 0.5 s reuse rule
- **Physics and collision:**
  - `SV_FlyMove`, `SV_PushMove`, `SV_WalkMove` (apart from SP-6), `SV_RecursiveHullCheck`, `SV_Move`, area-node linking
  - monster movement (`sv_move.c`)
  - friction and acceleration
- **Map and model loading:** the BSP, MDL and SPR loaders, including surface extents with float32 rounding. These were confirmed empirically on all 21 shareware maps (42,398 faces), 61 models and 3 sprites.
- **Wire format:**
  - all original `svc_` messages are byte-identical
  - `MSG_Read*`/`MSG_Write*` rounding and wrap
  - `CL_ParseServerMessage`
  - the demo file format
- **Core:**
  - the `COM_Parse` tokenizer, `Cbuf`/`Cmd_TokenizeString`, cvars and `Q_atof`/`Q_atoi`
  - the CRC table
  - `mathlib`
  - `Host_FilterTime`
- **Lighting:**
  - `R_AnimateLight` (lightstyles animate correctly)
  - `R_BuildLightMap`
  - `R_MarkLights`/`R_PushDlights`
  - `R_TextureAnimation`
  - the `anorms` and `anorm_dots` tables, and the `turbsin` table (diffed numerically)
- **Particles:** every `r_part.c` effect function and the particle physics.

## 6. Claims checked and rejected

- **`gl_doubleeys` is misspelled.** No: that is id's own spelling (`gl_rmain.c`). The real gap is C-1.
- **Particles don't attenuate with distance.** No: the material uses `sizeAttenuation: true`. The real difference is C-2.
- **`RecursiveLightPoint` samples the wrong lightmap texel.** No: the port uses `ds >> 4`, so only a negligible boundary case differs.
- **Duplicate cvars in `screen.js` and `gl_screen.js` cause split state.** No: `screen.js` is dead code that nothing imports.
- **`SND_PickChannel` steals channels even with 30 free.** No: only the first free slot is skipped (see SP-7).
- **Dynamic lights are applied twice.** No: with `gl_flashblend 0` the PointLight path returns early, and `R_PushDlights` in `render.js` is an unused stub.

- **"Command acks never advance on WebTransport, so prediction is unusable."**
  - Rejected for the current build: with `USE_CLIENT_OUTBOUND_DATAGRAMS = false`, client moves travel on the reliable lane, which the ack tracks.
  - The bug is real but latent, so it is kept as PRED-2.

## 7. Intentional deviations (not bugs)

- **Rendering:** Three.js rendering (Lambert world materials with lightmaps on `uv1`, fullbright emissive maps, the BatchedMesh world, the PointLight pool, CubeCamera, point-sprite particles, Hor+ FOV).
- **Networking:**
  - WebTransport networking with lobby/room support.
  - The QuakeWorld-style entity protocol (`svc_packetentities`, `svc_playerinfo`, `svc_serversequence`, `clc_delta`) and client-side prediction (`pmove.js`, `cl_pred.js`).
- **Platform replacements:**
  - Web Audio instead of DMA mixing; `snd_mix.js` is dead code.
  - localStorage for config and saves; fetch-based pak and map loading.
  - Garbage collection instead of zone/hunk.
  - Browser, touch and WebXR input.
- **Fixes to original bugs:**
  - `CL_UpdateTEnts` loop variable.
  - `chase.c` trace initialisation.
  - Alias frame `bboxmax`.
  - `Mod_FloodFillSkin` on every skin.
- **Omitted platform features:** the DOS/Win32 platform code, serial/modem/IPX menus, the video mode menu, and `#ifdef QUAKE2` code.

## 8. Not covered by this review

- `cd_audio.js` internals
- the web-specific multiplayer menus
- XR rendering and texture upload paths
- any live run: no browser session, no remote multiplayer session, no lobby or room server

---

# Part 2: QuakeWorld prediction, WebTransport, Deno server, touch and VR input

These parts have no WinQuake counterpart, or only a QuakeWorld one, so they were reviewed for correctness and robustness as well as fidelity.

## Part 2 summary, most urgent first

1. **SRV-1:** the lobby never learns room player counts, so every room is killed after 5-10 minutes, mid-game included.
2. **NET-1:** simultaneous connects can make a room call `Sys_Error`, which exits the process and drops every player.
3. **NET-2, SRV-2:**
   - There is no handshake, auth or rate limit, so one client can fill every room slot and every room.
   - `maxPlayers` isn't validated, so `1e9` exhausts the room's memory.
4. **PRED-1:** client prediction overwrites `cl.time` with a different clock, which disables entity interpolation in remote play.
5. **IN-1:** keys stick after alt-tab or Cmd-Tab.
6. **IN-2:** touchscreen laptops lose mouse look.
7. **IN-3:** VR has no menu or HUD, and its movement disagrees with the server.
8. **PRED-3, PRED-4, PRED-5:** systematic prediction errors from running QW pmove against NetQuake server physics.
9. **Deployment:**
   - `denoPath` is hard-coded.
   - There is no `.gitignore` for the TLS key.
   - The `deno.json` tasks are stale.
   - The client leaks sockets on failed connects.

## 9. QuakeWorld prediction (`src/pmove.js`, `src/cl_pred.js`)

### What matches the original

`pmove.js` and `cl_pred.js` faithfully port QW `pmove.c`, `pmovetst.c` and `cl_pred.c`. All of these match line by line, with no wrong constants:

- the movement and trace functions: `PM_FlyMove`, `PM_GroundMove`, the friction and acceleration functions, `PM_WaterMove`, `JumpButton`, `CheckWaterJump`, `PM_RecursiveHullCheck`, `PM_PlayerMove`
- the `CL_PredictMove` time window
- the `UPDATE_BACKUP` guard
- the 128-unit teleport snap

### The real problem: two physics models

The client predicts with QW pmove while the server simulates players with NetQuake physics (`sv_user.js`/`sv_phys.js`). With a reliable-stream ack and no `msec` in `clc_move`, prediction is necessarily approximate. The items below are the places where the two systematically disagree.

### PRED-1 · Prediction overwrites `cl.time` with a different clock — **high (remote play)**, Verified

- **Mechanism:**
  - `CL_PredictMove` sets `cl.time = realtime - latency` (`cl_pred.js:845`), which is client wall-clock time.
  - `CL_LerpPoint` compares `cl.time` with `cl.mtime[]` (`cl_main.js:567`), which holds the server's map time.
  - The two clocks are unrelated, so `frac` is always clamped and `cl.time` snaps to `mtime[0]` or `mtime[1]` (`:573`, `:583`).
- **C:** in QW, both clocks are in the realtime domain. In NQ, `cl.time` stays in server time.
- **Effect:**
  - In remote play, monsters, doors, platforms and projectiles are never interpolated. With 20 Hz rooms that is visible stutter.
  - Dynamic lights stamped with `die = cl.time + …` in the snapped (server) clock are decayed by `CL_DecayLights` (`host.js:578`) after `cl.time` is back on the client clock, so they may vanish at once or linger.
- `cl.mtime[0]` comes from `svc_time` (`cl_parse.js:1283`), and the packet-entity linker uses `CL_LerpPoint`'s `frac` (`cl_main.js:956`), so this covers the QuakeWorld-style entity path too.
  - Beams were already patched to use `cl.mtime` (`cl_tent.js:73`), which suggests this problem had been noticed before.
- **Fix direction:** keep the prediction time in its own variable, as QW effectively does, and leave `cl.time` in server time.

### PRED-2 · Command acks only work while moves use the reliable stream — **latent**, Verified

- The acknowledgement each side puts in its packets is `sock.receiveSequence`, and only the reliable lane updates it (`net_webtransport.js:108`, server `:185`).
- With `USE_CLIENT_OUTBOUND_DATAGRAMS = false` (current setting), `clc_move` goes over the reliable stream with a forced sequence header (`net_webtransport.js:1371`). The server echoes that sequence in its own headered packets, so acks advance.
- If datagrams are switched on for client moves:
  - no move is ever acked;
  - every stored command is replayed;
  - after 63 commands `CL_PredictMove` stops updating, and the view freezes on a stale `cl_simorg`.
- The prediction reviewer reported this as a live critical bug. It is not live today, but it blocks the obvious latency fix (see NET-5).
- **Fix direction:** acknowledge the unreliable lane too, or acknowledge the highest sequence received on either lane.

### PRED-3 · Movement physics mismatch between pmove and the NetQuake server — **medium**, Reported (code-read)

| Situation | NetQuake server | pmove (client) | Result |
|---|---|---|---|
| Looking up or down | `AngleVectors(angles)` with pitch/3, Z zeroed, no renormalise | flattened and renormalised forward/right | server ~0.89× forward speed at 80° pitch, so rubber-banding |
| Angles | 8-bit quantised, truncated to whole degrees | exact `cl.viewangles` | up to ~2.4° yaw error |
| Frame time | full `host_frametime`, last command per server frame | `msec = floor(frametime*1000)` | prediction travels 4-6% less |
| Water | NQ friction ×4 and `SV_WaterMove` accel | QW `waterlevel`-scaled friction, projected accel, step press-down | different swim speed and deceleration |
| Edges | point trace, `edgefriction` cvar | hull trace from feet, hard-coded 2 | differs near drops |
| Walls | `SV_WallFriction` | none | prediction slides faster along walls |
| Jump frame | friction and accel, then +270 | jump first, air accel capped at 30 | first jump frame differs |
| Other | `sv_maxvelocity` clamp, teleport back-move lock, 2D friction speed | none / 3D speed | small divergences |
| noclip / fly / dead | no gravity or collision / toss | always walk physics | constant rubber-banding in noclip and fly |

- **Movevars sent once:** they go out at signon only (`sv_main.js:297`), so mid-game `sv_gravity`/`sv_maxspeed` changes are never predicted.
- **XR:** sends controller aim angles but predicts with head angles (see IN-3).

### PRED-4 · Collision set differs from the server — **medium**, Reported

- **Brush entities:** `CL_SetSolidEntities` treats every brush entity as solid, including box pickups (`SOLID_TRIGGER`) and `func_illusionary`. The player stops and snaps when walking into them. Monsters (`SOLID_SLIDEBOX`) are not physents, so walking into one rubber-bands.
- **Overflow crash:** once 32 physents are in use, `CL_SetSolidPlayers` reads `pmove.physents[numphysent]` before its bounds check (`cl_pred.js:623` vs `:633`). Assigning to that undefined entry throws a TypeError.

### PRED-5 · Other players are extrapolated from already-extrapolated positions — **medium**, Reported

- **Compounding extrapolation:** `CL_SetUpPlayerPrediction` writes the predicted origin back into `pplayer.origin` (`cl_pred.js:497-512`) and runs twice per frame. QW always starts from the server state. Players therefore race ahead between updates.
- **Stale and missing physents:**
  - The physents list is the previous frame's and includes the player being predicted, so the player can start inside its own box.
  - QW restores `numphysent` after this step; the port never does.
  - On a listen-server host there are no physents at all, so remote players fall through the floor between updates.
- **Long-command split:** splitting a command over 100 ms reuses shared buffers across the recursive call. The second half runs with the wrong `msec`.
- **Stale state across maps:** `CL_ResetPrediction` leaves `waterjumptime`, `oldbuttons` and `onground` from the previous map.

## 10. WebTransport transport (`src/net_webtransport.js`, `server/net_webtransport_server.ts`)

- **Tests:** both transport tests pass, but they only cover sequence handling in `WT_QGetMessage`. They don't cover:
  - frame reassembly
  - sending
  - the connect, close and drop lifecycle
  - hostile input
- **Not run:** no live client/server session.

### NET-1 · Simultaneous connects can crash the room process — **high**, Verified (logic)

- **Mechanism:**
  - The server driver gets a socket from `NET_NewQSocket` as soon as a session opens its first stream, and queues it in `pendingConnections` (`net_webtransport_server.ts:455-471`).
  - `NET_NewQSocket` only checks `net_activeconnections` (`src/net_main.js:91`). That counter rises in `SV_CheckForNewClients`, once per frame, so pending sockets aren't counted.
  - The pool has `maxclientslimit + 1` sockets.
- **Effect:** if more sessions open in one frame than there are free client slots, `SV_CheckForNewClients` reaches `Sys_Error('Host_CheckForNewClients: no free clients')` (`src/sv_main.js:402`). On the server that is `Deno.exit(1)` (`server/sys_server.ts:9`), which drops every player in the room.
- **Fix direction:** count pending sockets in the check, and reject gracefully instead of calling `Sys_Error`.

### NET-2 · No handshake, timeouts or limits on server sessions — **high (internet-facing)**, Verified (code)

- **No connect/accept exchange:** any session that opens a stream and sends a byte gets a client slot, and the only reaper is `net_messagetimeout` (300 s). One client can hold every slot in a room indefinitely.
- **No timers or caps:** the WebTransport upgrade and the first `streamReader.read()` (`:333-352`, `:424`) have neither. A session that never opens a stream is held forever.
- **Clean end of stream ignored:** a reader that ends cleanly (`:503`, `:557`) leaves `conn.connected` true, so the dead client lingers until the 300 s timeout.

### NET-3 · Client leaks sockets on failed connects — **medium**, Verified

- **Unreleased resources on failure:**
  - In the lobby-join path, `sock` and `transport` are scoped inside the `try`, so the `catch` (`net_webtransport.js:897-916`) frees neither.
  - `_WT_ConnectDirect` has the same problem when datagrams are unavailable or the stream fails.
- **Late completion after timeout:** `CL_Connect` abandons a connect after 30 s (`src/cl_main.js:283`) without cancelling it. A connect that completes later leaves an unowned socket and a ghost client on the server.
- **Effect:** the client pool holds only 2-5 sockets, so a couple of failures make every later connect fail with "no free sockets" until reload.

### NET-4 · Disconnect messages are lost — **low**, Verified (page-hide frame), Reported (rest)

- **Page-hide frame:** the frame sent on page hide (`net_webtransport.js:161-166`) adds a "frame type" byte that the stream framing doesn't have. The server reads a length of 257 and waits forever, so `clc_disconnect` is never delivered.
- **Close order:** `WT_Close` on both sides clears the write queue and closes the transport straight away. The `svc_disconnect`/kick reason, or `clc_disconnect`, that was just queued is usually never sent, so users see "lost connection" instead of the reason.

### NET-5 · Throughput, backpressure and edge cases — **low to medium**, Reported

- **One global datagram queue:** all server datagram sends go through a single single-flight queue (`:1023-1052`), so one stalled client delays every other client's entity updates.
  - A write timeout permanently downgrades that client to reliable-only.
  - The 64-frame cap can then drop it.
- **Unbounded client buffers:** the reliable writer has no backpressure or cap, and `pendingMessages` has no limit. A hidden tab keeps buffering every server packet until it is shown again.
- **Moves on the reliable stream:** client moves go on the reliable stream (`USE_CLIENT_OUTBOUND_DATAGRAMS = false`), so one lost packet stalls all later moves. Each received message also costs a `setTimeout(0)` yield on the server, which caps intake at an unmeasured rate.
- **Pending-queue drop:** a client whose pending queue passes 100 messages is dropped, for example while the server awaits a map load for more than about 1.4 s.
- **Oversized payloads:**
  - Server: a reliable frame over 8 KB is silently truncated.
  - Client: a payload over 8 KB hits `Sys_Error` in `SZ_Write`, so a malicious server can crash the tab.
- **Sequence sentinel:** `receiveSequence < 0` means "legacy, headerless", and it flips after 2³¹ packets (about 11 months at 72 Hz).
- **Stale `wt.closed` handler:** it identifies the connection by its `QSocket` object, so with the pool's LIFO reuse it can free a newer connection's socket. Check `sock.driverdata === conn`.

## 11. Deno server (`server/`)

Static review only; the lobby and room servers were not run (they need a TLS certificate and a QUIC listener). `deno check` passes for the live entry points (`lobby_server.js`, `game_server.js`, `room_process_manager.ts`).

### SRV-1 · Lobby never learns player counts, so occupied rooms are killed — **high**, Verified

- **Mechanism:**
  - `room_process_manager.ts:234-258` parses each room's stdout for `[Heartbeat] ... players=N`, `Client ... connected` and `Client ... removed`.
  - `game_server.js:48` sets `__ICARO_QUIET_LOGS`, and `src/sys.js:32-45` then drops any line that matches no allow-pattern. `[Heartbeat]` matches none (`game_server.js:310`).
  - The connect and remove lines go through `Con_DPrintf`/`Con_Printf` (`src/sv_main.js:330`, `:1412`). `Con_Printf` returns before printing anything while `con_initialized` is false (`src/console.js:418`), and `game_server.js` never calls `Con_Init`.
- **Effect:**
  - `room.playerCount` stays 0, so the lobby's five-minute sweep (`RoomManager_CleanupIdleRooms`, `room_process_manager.ts:469`) SIGTERMs every room older than five minutes, mid-game included.
  - "Room is full" never triggers, and the room list always shows 0 players.
- **Fix direction:** allow-list `^\[Heartbeat\]`, or report counts on a dedicated channel rather than by scraping logs.

### SRV-2 · Unauthenticated room creation and unvalidated `maxPlayers` — **high**, Verified (code), not run

- **Room creation:** `LOBBY_CREATE`, and `LOBBY_JOIN` on any unknown six-character id, spawn a Deno child process with no auth, rate limit or per-IP cap (`lobby_server.js:223-233`, `:270-278`). One client can fill all `MAX_ROOMS = 10` slots for 5-10 minutes at a time.
- **`maxPlayers`:** `config.maxPlayers || 4` (`lobby_server.js:230`) is passed unchecked to the child's `-maxclients`. The child allocates that many `client_t` objects (`game_server.js:145`). `1e9` exhausts memory; a negative value or NaN gives a broken `svs.maxclients`. It is not clamped to Quake's 16.
- **Map names** are sanitised (`[A-Za-z0-9_]`), so there is no path or flag injection.

### SRV-3 · Room-list framing overflows at 64 KB — **medium**, Verified

- `sendFramedMessage` (`lobby_server.js:141-144`) writes a 2-byte length with no bounds check.
- `hostName` is unbounded and unsanitised, so a room with a ~60 KB host name wraps the length field and corrupts `LOBBY_LIST` for every client while the room exists.

### SRV-4 · Deployment defaults — **medium**, Verified

- `denoPath` defaults to `/root/.deno/bin/deno` (`room_process_manager.ts:47`) and nothing overrides it, so room creation fails on any other host. `Deno.execPath()` would fix this.
- There is no `.gitignore`, and the README has users generate `cert.pem` and `key.pem` inside `server/`. A `git add .` commits the TLS private key.
- `--allow-run`, `--allow-read` and `--allow-net` are unscoped for the lobby and its children.
- Stale entry points:
  - The root `deno.json` `server` task points to a non-existent `game_server.js` at the repo root.
  - `server/deno.json`'s `start`/`dev` tasks and its `exports` point to `main.ts`, which fails at import (`net_message` and `WT_SetRoomResolver` no longer exported).

### SRV-5 · Process lifecycle — **medium**, Reported

- **Orphaned rooms:** only SIGTERM is handled. After a lobby crash or Ctrl-C the rooms keep ports 4434-4443, and the next lobby hands those ports out again. A room nobody joined never exits by itself.
- **Stale exit handler:** a room's exit handler frees its port and id unconditionally (`room_process_manager.ts:294-297`). If a new room has already reused them, they are freed from under it.
- **Dead rooms reported as ready:**
  - A missing map leaves `sv.active` false after the room has already announced "listening".
  - After a `Host_Error`, the room stays alive but never runs the game again.
- **Logging:**
  - Most lobby log lines are filtered out by the quiet allowlist.
  - `sys_server.ts` passes user text as a `String.replace` replacement string, so `$&`-style sequences get expanded.
  - Stdout is decoded per chunk without `{stream: true}`, so lines split across chunks are mis-parsed.
- **Dead options:** `WT_SetMapCallbacks` and `WT_SetMaxClientsCallback` are documented no-ops, so `game_server.js:243-260` (map change and the maxclients clamp) never runs.

## 12. Keyboard, mouse, touch and WebXR input (`in_web.js`, `touch.js`, `webxr.js`)

The mouse-look maths in `IN_MouseMove` matches `in_win.c` (`m_filter`, `sensitivity`, `m_yaw`/`m_pitch`, `lookstrafe`, pitch clamp), apart from the omitted `noclip_anglehack` branch. Nothing was tested on a device.

### IN-1 · Keys stick after focus loss — **high**, Verified

- **Missing handling:**
  - Nothing calls `Key_ClearStates` (`keys.js:943`).
  - There is no `blur` listener, and `handleVisibilityChange` is an empty placeholder (`in_web.js:540`).
  - Losing pointer lock only clears `mouseactive`.
  - `mouseup` is bound to the canvas only, so a button released outside it is never seen.
- **C:** Win32 clears key and mouse state when the window loses focus (`Key_ClearStates`/`IN_ClearStates` in `vid_win.c:225` and `gl_vidnt.c:940`).
- **Effect:** holding W or fire while alt-tabbing (or pressing Cmd-Tab, or Cmd+letter on macOS) leaves `+forward`/`+attack` latched.
- **Compounding:** browser shortcuts are only suppressed for Tab, Space, F5, F11 and F12 (`in_web.js:361-373`). Ctrl+S, Ctrl+F and Ctrl+D still fire and steal focus, which is reachable with default bindings if Ctrl is `+attack`.

### IN-2 · Touchscreen laptops lose mouse look — **high (for those users)**, Verified

`Touch_IsMobile` (`touch.js:60`) returns true for any device with `maxTouchPoints > 2`. That includes Windows and ChromeOS touchscreen laptops and iPad desktop mode. When it is true, pointer lock is never requested (`in_web.js:353`, `:459`, `:911`), so mouse users get the touch overlay and no mouse look.

### IN-3 · WebXR integration — **medium-high**, Verified (code)

- **Movement mismatch:**
  - In XR, `CL_SendMove` sends the controller aim angles (`cl_input.js:380`), but stores `cl.viewangles` for prediction (`:423`).
  - The NetQuake server moves the player along the angles it receives.
  - So with prediction on, client and server apply forward/strafe in different directions, and the player rubber-bands.
- **Latched triggers:** trigger state (`_xrPrevLeftTrigger`/`_xrPrevRightTrigger`, `in_web.js:860-875`) is never reset when the session ends. Leaving VR with a trigger held leaves `+attack`/`+jump` latched.
- **No 2D UI in the headset:** menu, console and HUD are a DOM overlay canvas, and `R_PolyBlend` is skipped in XR. None of it is visible in the headset.
- **Controls:** controllers map only to move, turn, jump and attack. There is no menu, weapon switch or `+use`.
- **Menu and demo state ignored:** XR input is not gated on `key_dest` or demo playback.
- **Comfort:** view bob, damage roll and strafe roll are applied to the XR rig, and turning is only smooth turning, at about 280°/s.

### IN-4 · Touch controls — **medium**, Verified (state handling), Reported (the rest)

- **Latched buttons:** `Touch_Disable` (`touch.js`) removes the button listeners but never clears `in_attack`/`in_jump` state set at `:325`/`:331`. Holding FIRE while pausing leaves the player firing after resume.
- **Wake lock:**
  - It is never re-acquired after the tab is hidden, because the visibility handler is empty.
  - The async request can leak a lock if the controls are disabled before it resolves.
- **Joystick:** there is no deadzone, and full deflection equals walk speed. Backward uses `cl_forwardspeed`.
- **Tap-to-jump:** advertised in the header comment but not implemented (`Touch_CheckJump` has no callers).
- **Fullscreen:**
  - It is requested only from canvas `touchstart`. The overlays swallow those touches, and `touchstart` is not a user activation in Chrome.
  - `fullscreenActivated` is never reset after the user exits.
- **Menu touch:** uses `e.touches[0]` instead of `changedTouches`, and has no drag (sliders).

### IN-5 · Keyboard mapping gaps — **low**, Reported

- **Shifted punctuation can stick:** non-letter keys are mapped from `event.key`. A Shift-modified key (`:`) can be released as its unshifted form (`;`), leaving the shifted key down.
- **Numpad:** there are no `K_KP_*` codes.
- **Non-US layouts:** characters in the range 128-255 alias Quake's special key codes (e.g. `ÿ` = `K_PAUSE`).
- **Mouse wheel:** it doesn't call `preventDefault`, so Ctrl+wheel zooms the page.

---

## Reproducing

```bash
git clone --depth 1 https://github.com/id-Software/Quake.git /tmp/idquake
```

```bash
deno test --allow-read --allow-net --allow-env tests/
```

Compare each `src/*.js` file with the C file named on its first line (`// Ported from: …`).
