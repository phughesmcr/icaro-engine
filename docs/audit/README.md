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

## What was covered, and what wasn't

- **Run, headless, all clean:** 261 map spawns at skill 1 with a loopback client
  and the right mission-pack flags. They cover shareware, retail id1, hipnotic,
  rogue, the rerelease's id1, hipnotic, rogue, mg1, mg3, dopa and ctf, and the 8
  community maps in `static/maps/`. Also 418 deathmatch and coop spawns with 4
  players, save and load on 41 maps, every attract demo, record and replay on 10
  sets, and every `trigger_changelevel`. No crash and no blocker.
- **Not run: LibreQuake, Quoth, Arcane Dimensions, Copper.** None of them is in
  `static/`, which holds retail id1, the mission packs, the rerelease and the
  community maps. `compat-runtime.md` lists what a test of each needs.
- **Not run: anything in a browser.** Rendering, audio, input, storage, real
  multi-client play and real networks are unverified. "No blockers" is a
  headless result.

## Correction: why 666 and 999 matter

The earlier reasoning in this session, repeated in #245's AGENTS.md, was that
the server must speak 666 and 999 because mods write protocol messages from
QuakeC. `compat-standard.md` (Protocol strategy) found otherwise. AD, progs_dump
and LibreQuake write only NetQuake messages (svc 3–34, TE 0–13), which have the
same payload in 15, 666, 999 and Icaro's 1015. The engine, not the QuakeC, sets
coordinate width. Icaro already parses them. What needs 666 and 999 is **reading
other engines' demos**. That audit is from reading (**read**), and it didn't
read the Quoth or Copper QuakeC.

## Decisions needed

1. **Protocol.** The recommendation is a versioned Icaro protocol: keep 1015,
   add a capability word to the server hello, and move Icaro's private svcs (42,
   47–49, which collide with Fitz and KEX numbers) into a reserved range. The
   client then dispatches per protocol and gets readers for 15, 666 and 999. The
   alternative, 999 plus FTE's extensions as Quakespasm-Spiked does, plays QSS
   demos too but ties Icaro's standard to FTE's and costs L–XL. A server that
   sends 666 or 999 gains nothing for netplay.
2. **Trusting `stuffcmd`.** A host can run any console command on joiners
   (`src/cl_parse.js:1470` → `Cbuf_AddText`), and bindings and archived cvars
   persist to the next session. Hosts are players now, so this is High. A
   heuristic scan of the shipped `progs.dat` strings suggests they stuff `bf`,
   `disconnect`, `menu_credits`, `restart`, `skill`, `impulse`, `spawn`,
   `horde`, `clear`, `-attack` and (per `docs/rerelease-gaps.md`) `fog`. The
   scan can't tell `stuffcmd` from `localcmd` or printed text, so build the real
   allowlist from id's published rerelease QuakeC
   (`id-Software/quake-rerelease-qc`) and the mods' sources. The proposal is to
   trust your own local server fully and filter a remote host's text through
   that allowlist, with nothing it sets persisted. This is a design decision,
   not a quick patch. **read**
3. **How LibreQuake is delivered.** Its art is BSD and its QuakeC GPL-2. Release
   zips are 56–116 MB. Recommended: pin a release asset hosted outside the
   repository, and change the pak allowlists (CI's tracked-pak check, the client
   build, the Docker image) deliberately. Its `levelshots.pk3` needs a zip
   reader, which Icaro lacks.
4. **Permanent servers.** The deployed lobby only signals; rooms on Cloudflare
   don't exist (`LOBBY_CREATE` is refused). Options: browser hosting only, or
   add Cloudflare Containers rooms over WebSocket. The cost in
   `docs/always-on-hosting.md` (roughly $6–10 a month) was not re-checked.
5. **GPL-2.0.** Games built on Icaro can keep their data proprietary, but engine
   changes and any desktop build must offer source. The shareware pak and the
   community maps need a `THIRD_PARTY.md`.
6. **Architecture direction.** The architecture audit proposes three layers with
   downward imports: `games/quake/`, `core/`, `platform/`. It assumed the Quake
   layer stays function-by-function; under the revised rules that is a choice,
   not a requirement.

## Roadmap

In the order of the vision's plans. Items marked S are a day or less, M a few
days, L a week or more.

### 0. Verification first

- A browser smoke pass on each content set: load, render, a minute of play, save
  and load, a demo. **browser**
- Let `headless_host` mount game directories before `Host_Init`
  (`opts.game_dirs`), so mission packs and mods can be scripted and tested
  through MCP. Today it mounts one pak. S, **run**. Overlaps #237, #243, #244,
  #246.
- Get LibreQuake, Quoth and AD into `static/` (gitignored) and run the same
  headless sweep on them. LibreQuake's attract demos matter most: if they are
  666 or 999, the standard content can't boot until the client reads those
  protocols.
- An allocation gate: a test that runs `Host_Frame` many times and fails if a
  frame allocates. The architecture audit's hot-path counts are a grep, not
  measurements. M, **read**.

### 1. Single-player Quake and mods in desktop Chrome

- **Fence textures.** World textures load with `alpha` false
  (`src/gl_model.js:1453`), so `{` textures aren't transparent. S, **read**
  (checked again for this summary), **browser** to confirm.
- **Game directories in the browser.** `?game=` accepts only a fixed list
  (`main.js`). Accept any safe directory name, add `-quoth`, multiple `-game`
  and `lq1`. Only the game server takes any `-game`
  (`server/game_server.js:166`); the headless host mounts none (section 0).
  `compat-runtime.md` finding 3 says `?game=quoth` works in the browser, but
  `main.js` ignores names outside its list. M, **read**. Wait for #240 (players'
  own paks), which edits the same files.
- **Protocol dispatch and the 666 and 999 demo readers**, after decision 1. M,
  **read**.
- **QuakeC extensions.** `checkextension` returns 0 (`src/pr_cmds.js:1404`);
  Ironwail's `str2chr`, `chr2str`, `strconv`, `checkcommand`, `vectorvectors`,
  `clientcommand`, trig and `tokenize_console` are missing. M, **read**.
- **Frame pacing.** With the default `host_maxfps` 72, render frames are skipped
  below 1/72 s (`src/host.js:836`), which is uneven on 90, 120 and 165 Hz
  displays. The fix must keep physics at 72 Hz, because NetQuake physics depends
  on frame rate. The QuakeSpasm-style split of render and tick
  (`host_netinterval`) is already there: `Host_UpdateNetInterval`
  (`src/host.js:811`) turns it on when `host_maxfps` is above 72 or 0, so the
  fix may be a default change. S, **read**, **browser** to confirm.
- Each M: entity `scale` and lerp-finish, lit water, `gl_overbright`, 2PSB and
  BSPX, FLAC, Opus and tracker music, external texture replacement,
  `r_particles`, `vid_vsync`. **read**
- Small items: `ctfscores` unknown on ctf maps; `ctf4` exits to a missing
  `idctf1`; dopa can't start four id1 boss maps without mg1's rune model; an
  `ogre_rocket.md5anim` bone warning; headless `stop` throws. S each, **run**.

### 2. Multiplayer

- Decision 2 (`stuffcmd` trust). High.
- Guests have too much power: `kick` outside deathmatch (whether a guest can
  kick the host was **not run**), `pause`, coop cheats gated only by
  `deathmatch`, and no rate limit on chat or name changes. M, **read**.
- A phone host dies when its tab is hidden; nothing takes a wake lock. Add one,
  warn the host, and pair it with #239's reconnect. M, **read**, **browser**.
- TURN credentials last 6 hours, and non-browser clients skip the Origin check.
  S, **read**.
- Join links trust `?server=` and the map name the host sends. S, **read**.
- URL config: a new `src/url_config.js` with a typed allowlist (`?cfg.<cvar>=…`,
  `?bind.<key>=+action`), applied with `Cvar_Set` and never saved.
  `multiplayer-security.md` has the classification. M.
- Decision 4 (permanent servers).

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
  hard-coded (`src/in_web.js:610`) and triggers can't be bound. S.

### 6. Three.js

- About 40 string patches over built-in materials (`onBeforeCompile`), which
  `WebGPURenderer` doesn't support. Move to one TSL `NodeMaterial`, with a test
  that fails when a Three.js upgrade breaks a patch. L, **read**.

### Platform and architecture (cross-cutting)

- One 49-module import cycle, which pulls the renderer into the server and needs
  the 683-line `server/browser_shim.js`. Split `gl_model.js` first. L, **run**
  (counted).
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

## Open PRs this overlaps

#237, #243, #244 and #246 (agent API and MCP), #238 (CSP nonce), #239 (WebRTC
reconnect), #240 (players' own paks), #241 (dynamic resolution), #242 (status
docs), #245 (rules), #247 and #248 (touch), #249 (centerprint wrap and mod
localization).
