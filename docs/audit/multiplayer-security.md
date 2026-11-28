# Audit: multiplayer, hosting and security

Branch `agent/vision-rules` (= `origin/dev` at 2798ac9), 2026-11-26. Read-only
audit; the only file written is this one. Docs are snapshots, so every claim
below was checked against code unless marked **[unverified]**.

Run: `tools/bench/net_bench.js -clients 4` and
`tools/room_bench.js -map e1m1 -bots 4 -seconds 20` (localhost only).

## Status

Checked at `dev` `3603119` (2026-11-27). The rest of this file is the older
snapshot.

- S1 is fixed (#258): a remote host's `stuffcmd` runs only the commands in
  `cmd_server_allowed` (`src/cmd.js`), which differs from the list recommended
  below, and the cvars it changes are not saved and are restored on disconnect.
  Only the player's own local server is trusted, and demos aren't. Not tried in
  a live room. The threat model's "Malicious host" row is now gated by this.
- Netcode, reconnect: browser-hosted rooms are retried too (#239).
- S2: `touch.js` takes a screen wake lock while touch play is on (it did at the
  audit's revision too). Nothing handles a hidden host tab.
- S8 and S9: the service worker caches no pak, and the client build denies every
  pak, so the shareware SHA-256 pin is gone (#270). The CSP nonce merged (#238).
- The URL config design is built in `src/url_config.js` (#276), without `?bind.`
  or the `?cfg=` shorthand; its header gives the departures.
- The other findings weren't rechecked.

## Summary

The transport work is in good shape: WebRTC unreliable channels, packet caps,
rate-limited lobby, Turnstile, a fail-closed deploy allowlist for game data. The
big gaps are about trust, not transport:

1. A joining client executes whatever the host sends (`svc_stufftext` goes
   straight to the command buffer with the full command set). In a P2P world
   every host is untrusted, so this is the top issue.
2. A phone host stops when the tab is hidden: the loop is
   `requestAnimationFrame` and nothing holds a wake lock.
3. "A permanent set of servers on Cloudflare" does not exist yet. The deployed
   lobby is signalling only; game traffic is peer to peer. Dedicated rooms need
   Containers or a VM (designed in `docs/always-on-hosting.md`, not built).
4. URL config: only a handful of hand-validated params exist. An allowlist
   design is in the last section.

## Findings, ranked

### S1 (High) A host can run any console command on joiners

- Evidence: `src/cl_parse.js:1470-1482` (`CL_ParseStuffText` calls
  `Cbuf_AddText` with whole lines; comment at `:1469` says Ironwail's filtering
  is "not ported"). `Cmd_ExecuteString` (`src/cmd.js:310`) has no source check
  for the client side. About 150 commands exist (list from `Cmd_AddCommand`).
- What a hostile host can do to a joiner:
  - `bind`, `unbindall`, `alias`, then the saved config persists them:
    `Host_WriteConfiguration` (`src/host.js:1130`) writes bindings and archived
    cvars to `localStorage`, and `Host_Init` re-runs that text with
    `Cbuf_AddText(savedConfig)` (`src/host.js:558-566`). So grief survives
    reload (`bind w quit`, `sensitivity 0`, `name`, `unbind` movement keys).
  - `connect "<other server>"` (redirect), `disconnect`, `quit`, `map`,
    `load`/`save` (overwrites the player's `localStorage` saves), `resetcfg`,
    `record`/`stop` (triggers a file download, `src/cl_demo.js:259`),
    `screenshot` (download, `src/gl_screen.js:996`), `say`/`name`
    (impersonation), `exec` of any local cfg, `host_timescale`, `fov`,
    `developer`, `listen`/`maxplayers`.
  - No remote code execution and no data theft path was found: there is no
    command that reads cookies, makes arbitrary `fetch` calls with a host-chosen
    URL, or writes outside `localStorage`. Impact is grief, redirect and
    persistence, not compromise.
- Effort: M. Recommendation: in `CL_ParseStuffText`, when connected to a
  non-local, non-demo server, run each line through a client-side stuffcmd
  allowlist before `Cbuf_AddText`. Keep what real QuakeC uses: `bf`, `v_cshift`,
  `cd`, `play`, `playvol`, `stopsound`, `centerview`, `fog`, `sky`, `skybox`,
  `vibrate`, `echo`, `reconnect`, `name`/`color` (own), `impulse`, `cl_*`-less
  cvars that mods set (`r_*` effects, `viewsize`), and `+attack`/`-attack` style
  button commands. Drop `bind`, `unbind*`, `alias`, `exec`, `connect`, `quit`,
  `map`, `save*`, `load*`, `record`, `screenshot`, `resetcfg`,
  `writeconfig`-class commands, `playdemo`, `startdemos`, and all
  non-allowlisted cvars. Print dropped lines at `developer 1`. Also mark that
  cvar writes from stuffcmd never reach `Host_WriteConfiguration` (a "session"
  write list). Overlap: none of the open PRs touch `cl_parse.js` as far as the
  titles show **[unverified]**.

### S2 (High) Phone host dies when the tab is hidden; no wake lock

- Evidence: `renderer.setAnimationLoop` drives `Host_Frame` (`main.js`, end of
  `main()`), so hidden tabs stop the game. `grep wakeLock` over `src/` and
  `main.js` finds nothing. `docs/browser-hosted-rooms.md` records "Background
  tabs there stop the game loop" and spike test 3 (hidden-page timers) never ran
  on a real device. iOS suspends a backgrounded page within seconds.
- Impact: "start a match on my phone and my friend joins" works only while the
  phone is unlocked, in the foreground, and not sleeping. Screen auto-lock (30 s
  default on iOS) kills the room. Thermal and battery were not measured
  **[unverified: no devices]**. Joiners see a host that goes silent; the
  datagram path has no heartbeat to the lobby after hide, so the lobby keeps the
  room listed up to `heartbeatTimeoutMs` (90 s, `server/lobby_rtc.js` limits).
- Effort: S for the wake lock, M for the rest. Recommendation:
  1. `navigator.wakeLock.request("screen")` while hosting (Safari 16.4+, Chrome,
     Firefox); re-acquire on `visibilitychange`. Show a "keep this screen on"
     banner on the host.
  2. Host-only low-power mode: lower `host_maxfps`, skip rendering when no local
     player input (still run the server). Rendering is the main battery cost;
     the server tick is 0.4 ms (see Netcode).
  3. On `visibilitychange: hidden` while hosting, send joiners a pause message
     rather than letting them time out at `net_messagetimeout` (300 s,
     `src/net_main.js:69`).
  4. Longer term: the Deno Desktop host and the Cloudflare dedicated room
     (below) are the real answers for "host in a pocket".

### S3 (High) The "permanent servers" goal is not built

- Exists: `cloudflare/lobby/` (Worker + one Durable Object named `lobby`,
  signalling and room table for browser-hosted rooms, TURN credentials,
  Turnstile, per-IP limits, Origin check) and `cloudflare/client/` (static
  assets on `quake.anglezarke.games`, CSP via `_headers`). `LOBBY_CREATE` is
  refused (`cloudflare/lobby/src/lobby_core.js`, "can't start rooms").
- Missing: any always-on game room. The Deno `lobby_server.js` +
  `game_server.js` path needs a machine.
- Options (prices from `docs/always-on-hosting.md`, not re-checked online:
  **[unverified, prices change]**):

| Option                              | Fit                                     | Cost/limits                                                  |
| ----------------------------------- | --------------------------------------- | ------------------------------------------------------------ |
| Cloudflare Containers, room per ctr | Best match; WebSocket only (no WT)      | about $6-10/mo, mostly Workers Paid minimum                  |
| DO per room                         | Blocked: engine state is module globals | isolate sharing and 128 MB limit; room needs about 97-160 MB |
| Small VM (Fly, Hetzner)             | Works today, keeps WebTransport         | about 5.5-9 EUR/USD per month                                |
| P2P only (status quo)               | Free; host must stay awake              | TURN free to 1000 GB/mo, then paid                           |

- Measured here: one room, 4 bots, 20 s: tick mean 0.4 ms, p99 0.85 ms, 2.2%
  CPU, RSS 281 MB, peak isolate 159 MB, 7.7 KB/s out and 8.7 KB/s in in total.
  Memory, not CPU, is the constraint.
- Recommendation (effort L): keep the P2P lobby as the free default; add a small
  "official rooms" tier on Containers behind the same lobby DO, with the lobby
  choosing Container rooms only when the host has no WebRTC (or on request). Do
  it after S1, S2 and S4, since official servers raise the stakes of every abuse
  path. The Deno Desktop app can host with the same `game_server.js` (needs
  `deno desktop` WebRTC check **[unverified]**).

### S4 (Medium) Any joiner has more power than a guest should

- `clc_stringcmd` allowlist (`src/sv_user.js:617-654`) is faithful to id, but in
  a listen room every joiner is a stranger to the host:
  - `kick` is allowed unless `deathmatch` is set (`src/host_cmd.js:1115`).
    Browser-hosted coop rooms run `deathmatch 0` (`src/room_rules.js`,
    `Room_ApplyGameOptions`), so a joiner can `kick` others, probably the host's
    own slot too **[unverified: not run]**.
  - `pause` is allowed while `pausable 1` (default, `src/host.js:198`): any
    joiner can freeze the room.
  - `give`, `god`, `noclip`, `fly`, `notarget` are gated only by `deathmatch`
    (`:770-884`), so in a coop room they are cheats open to all (`sv_cheats` is
    not consulted on this path; check against the C).
  - No rate limit on `say`, `name`, `color` or `tell`; each `name` change is
    broadcast to all clients, so one joiner can flood everyone's bandwidth. Only
    queue length is capped (`MAX_PENDING_MESSAGES` 1024,
    `server/net_websocket_server.ts:153`, `src/net_webrtc.js:98`).
- Effort: S-M. Recommendation: for non-local clients, a per-client token bucket
  on `clc_stringcmd` (for example 4 per second, burst 10); reject `kick`,
  `pause`, `give`, cheats from non-host clients regardless of deathmatch
  (host-only through a flag set in the room rules); keep faithful behaviour for
  single player and the local client.

### S5 (Medium) TURN credentials can be farmed

- Evidence: `iceServers()` mints credentials with a 6 h TTL
  (`cloudflare/lobby/src/lobby_core.js`, `TURN_TTL_SECONDS`), limited by
  `LOBBY_TURN_LIMIT` 10 per minute per IP "per Cloudflare location"
  (`cloudflare/lobby/wrangler.jsonc`). The Origin check is bypassed by
  non-browser clients (`gate.js`, `Lobby_OriginAllowed` accepts no Origin). A
  joiner needs a valid room code, but a bot can host its own room (one Turnstile
  solve) and join it repeatedly. Anyone holding credentials can use TURN as a
  free relay until the TTL ends. Cost beyond 1000 GB/mo is on the maintainer
  **[unverified: pricing and whether a card is on file]**.
- Effort: S. Recommendation: TTL of 1 h or less (a game is rarely longer; the
  client can re-request); one credential per session; alert on Cloudflare
  Realtime usage; consider requiring a Turnstile token on `LOBBY_JOIN` after N
  joins from one IP. Do not log credentials.

### S6 (Medium) Room creation abuse

- Good: Turnstile with action and hostname check, fail closed
  (`server/turnstile.js`), `maxRooms` 500, `maxHostsPerIp` 2,
  `hostsPerIpPerWindow` 5, signal size caps, `RTC_ROOM_CODE` 8 chars from a
  32-letter alphabet (about 10^12). Room names are sanitised
  (`server/room_config.js`).
- Gaps:
  - Everything is one Durable Object (`idFromName("lobby")`): hot spot and
    single point of failure. 1000 sessions is `maxSessions`; a flood of sockets
    from many IPs holds all slots. DO limits are in memory and reset on
    hibernation (documented); only `LOBBY_CONNECT_LIMIT` (30/min/IP) is durable
    and it is per colo.
  - Public room list shows host-chosen names (sanitised to 32 bytes, control
    characters stripped, but not profanity or URL spam). No report or ban.
  - Private room safety rests on the 8-character code;
    `joinMissesPerIpPerWindow` 20/min per IP makes online guessing impractical
    from one IP, but a botnet scale of 10^12 is still far out of reach. Fine.
- Effort: M. Recommendation: shard the DO by region or room-code prefix when
  traffic warrants; add a Cloudflare WAF rate rule on `/mp/lobby`; add a name
  filter and an operator kill switch (a `BLOCKED_HOSTS` var).

### S7 (Medium) Join links trust `?server=` and the host-supplied map name

- `?server=wss://anything` is accepted if it looks like a lobby
  (`Sys_ParseLobbyURL`, `src/sys.js`), and the CSP allows
  `connect-src https:
  wss:` (`cloudflare/client/build.js:177`). A crafted link
  `?server=wss://evil/mp/lobby&room=X` sends the player to an attacker lobby.
  With S1 fixed the impact is the same as joining any hostile host, but the page
  looks like the official one (phishing for chat or the Turnstile widget is not
  possible; Turnstile verifies page hostname). Mitigation: show the lobby host
  in the connect screen and a one-time confirm when `?server=` is not the
  default.
- A hostile host names the map: `CL_ParseServerInfo` calls
  `COM_EnsureFile(model_precache[1])` (`src/cl_parse.js:542`), which becomes
  `fetch("static/" + name)` (`src/pak.js` `COM_PreloadLooseFile`), so the host
  can make the joiner issue same-origin GETs, including `..` segments. No
  cross-origin fetch (the prefix keeps it relative). In Deno clients (agent MCP,
  headless host) the same name reaches `Deno.readFile`, a path-traversal read
  that is parsed as a BSP (error only). Effort: S. Validate to
  `maps/[a-z0-9_]+\.bsp` before fetching, as `Room_SanitizeMapName` does for
  creation.

### S8 (Low) CSP and service worker

- CSP lives only in the generated `_headers` (`cloudflare/client/build.js:171`),
  not in `index.html`, so local dev and any other host serve no CSP. Uses script
  hashes, `style-src 'unsafe-inline'`, `connect-src https: wss:` (needed for
  `?server=`, a trade-off), `frame-ancestors 'none'`, `object-src 'none'`, HSTS.
  No `require-trusted-types`. Overlaps PR #238 (nonce): coordinate so hash and
  nonce do not both land.
- `connect-src` open means any XSS can exfiltrate. With scripts limited to self,
  jsDelivr and Turnstile, risk is jsDelivr supply chain. The import map pins
  versions but has no SRI (browsers do not support SRI for import maps
  **[unverified]**). Recommendation: vendor `three` and `nipplejs` into the
  deploy (S, removes jsDelivr from `script-src`).
- `sw.js`: never caches non-shareware paks (`:100`), caches only same-origin and
  version-pinned CDN. Network-first for code. Fine. A compromised deploy would
  persist in the cache until the next online load; acceptable.

### S9 (Low) Data hygiene

- Good: `cloudflare/client/build.js` copies git-tracked files only, rejects any
  `.pak` but `static/pak0.pak`, and checks its SHA-256 (`:24-30`, `:74`,
  `:284`). Dockerfile uses an allowlist. `cloudflare/lobby` has no assets. Keep.
- Gap: the lobby's `workers.dev` stays on (`workers_dev: true`) and its Origin
  list covers only the main hostname, fine; the client Worker disables it. No
  finding beyond this.

### S10 (Low) Malformed or oversized input

- Lobby frames capped at 64 KB, requests 4 KB, SDP 16 KB (lobby), 64 KB (client
  side `RTC_MAX_SDP_BYTES`), candidates 64 per connection, handshakes 8
  (`src/net_webrtc.js:85-106`). Game datagrams capped: unreliable 1200 bytes,
  reliable `NET_MAXMESSAGE`, buffer caps 16 KB and 256 KB. These look sound. No
  fuzzing was run.
- A joiner can send a QuakeC-visible `clc_stringcmd` of any length up to the
  message limit; the cvar path and `say` truncate in the C way. Fine.

## Netcode quality

- Rates (measured, localhost, no loss): about 20 unreliable packets per bot per
  second, 7.7 KB/s total server to 4 clients, 8.7 KB/s clients to server;
  `net_bench`: 70-130 bytes per packet, send cost 13-43 us per client, parse 1-7
  us, prediction 10-40 us per call. Cost is not a concern.
- Datagram size: RTC unreliable messages are capped at 1200 bytes
  (`src/net_webrtc.js:113`), under the usual path MTU; SCTP max message size was
  262144 in Chromium. The 281-of-300 loss at 4000 bytes in a burst is
  unexplained (`docs/browser-hosted-rooms.md`); the cap avoids it.
- Loss and jitter: unreliable channels use `ordered:false, maxRetransmits:0`;
  the driver drops stale or reordered packets (`_RTC_ParseSequenced`-style check
  near `src/net_webrtc.js:1184`). The entity protocol is delta against acked
  baselines (QW style), so loss costs bandwidth, not correctness. I did not
  inject loss or latency, so jitter buffering, correction snapping and the 20 Hz
  snapshots versus 72 Hz physics question (`docs/browser-hosted-rooms.md`, Not
  verified) remain **[unverified]**. A netem-style test (Chrome DevTools
  throttling plus `room_bench` with a lossy proxy) is the first thing to do
  before claiming "real network" quality.
- Reconnect: `cl_reconnect.js` retries only WebTransport and WebSocket addresses
  and explicitly excludes `rtc:` (`:37-43`). A phone joiner that switches Wi-Fi
  to cellular loses a P2P game with no recovery (PR #239 is open for this: check
  it covers re-signalling through the lobby, and that the host keeps the slot
  for a grace period). There is no host migration (none in Quake); if the host's
  tab sleeps the room ends.
- Tick rates: server physics follows the frame rate (up to 72 Hz) and snapshots
  are per frame in listen mode ("joiners get the C's per-frame rate", Decisions
  in the browser-hosted doc) while the dedicated room measures 20 Hz. Pick one
  documented rate for P2P; a phone host at 72 Hz doubles upstream and heat for
  little gain.
- NAT: STUN `stun.cloudflare.com`; TURN offered over UDP 3478/443, TCP 3478/80
  and TLS 443/5349, which is the right set for carrier and corporate networks.
  Not tested on real NATs, CGNAT or iOS **[unverified]**. Expect about 15-22%
  relayed (old studies) and more on mobile.

## Threat model (short)

| Actor                        | Can do today                                     | Gate                               |
| ---------------------------- | ------------------------------------------------ | ---------------------------------- |
| Anonymous web client         | Open 16 sockets per IP, list rooms, join by code | Origin (browser only), rate limits |
| Room creator                 | Create 2 rooms per IP                            | Turnstile                          |
| Joiner (guest)               | `kick`, `pause`, chat flood, coop cheats (S4)    | Allowlist of id only               |
| Malicious host               | Console control of joiners, redirect, grief (S1) | None                               |
| Network observer             | See IPs through ICE; DTLS protects payload       | WebRTC DTLS; `relay` option absent |
| Site visitor on other origin | Open lobby socket via a visitor's browser        | Origin check                       |

The "only Icaro servers talk to Icaro clients" rule is not enforced anywhere. A
protocol hello check exists (`ICARO` hello over RTC); add a version and build
identifier there when the 666/999 and native-protocol work lands, and refuse
non-matching peers.

## URL-param config design

Goal: `autoexec.cfg` through the URL, safe by construction.

### Classification

Safe (client-local, cannot affect other players, cannot persist beyond the page,
bounded range):

- Video and HUD: `fov`, `viewsize`, `gamma`, `crosshair`, `scr_sbarscale`,
  `scr_conscale`, `scr_menuscale`, `scr_sbaralpha`, `scr_showfps`, `scr_clock`,
  `host_maxfps`, `vid_quality`, `vid_dprcap`, `gl_texture_anisotropy`,
  `gl_texturemode` (value allowlist), `gl_picmip`, `gl_polyblend`,
  `gl_cshiftpercent*`, `r_wateralpha`, `r_lavaalpha`, `r_slimealpha`,
  `r_telealpha`, `r_lerpmodels`, `r_lerpmove`, `r_waterwarp`, `r_dynamic`,
  `r_particles`, `r_drawviewmodel`, `r_viewmodel_quake`, `scr_crosshairscale`,
  `cl_bob*`, `cl_rollangle`, `cl_gun_fovscale`, `v_gunkick`, `v_kick*`,
  `chase_*`, `con_notifytime`, `scr_centertime`.
- Audio: `volume`, `bgmvolume`, `ambient_level`, `ambient_fade`.
- Input feel: `sensitivity`, `m_pitch`, `m_yaw`, `m_forward`, `m_side`,
  `m_filter`, `in_rawmouse`, `lookspring`, `lookstrafe`, `cl_forwardspeed`
  family, `cl_maxpitch`, `cl_minpitch`, `joy_*`, `gp_look_*`, `xr_*`, `touch_*`,
  `invert` (as negative `m_pitch`).
- Identity: `name` and `color` (length and character limits already in
  `Host_Name_f`), `_cl_name`, `_cl_color`.
- Debug display only: `scr_showfps`, `cl_shownet` 0 only.
- Binds: `bind <key> <button>` where the target is in a fixed list of `+action`
  commands and `impulse 1-8`, `impulse 10`, `toggleconsole`, `togglemenu`,
  `screenshot` excluded. Optional `unbind`.

Needs care (allow only from the user's own URL, with a range clamp, never from a
host or server, and not persisted): `host_timescale` and `host_framerate`
(single-player only, clamp 0.5-2; offline only, otherwise disable), `skill`,
`coop`, `deathmatch`, `teamplay`, `fraglimit`, `timelimit`, `maxplayers`, `map`
(already `?map=`, regex-checked), `sv_*` and other server cvars (only meaningful
when hosting; accept as `host.*` params, range from `GAME_OPTION_RANGES`).

Unsafe (never from URL): `alias`, `exec`, `connect`, `quit`, `cmd`, `say`,
`load`, `save*`, `playdemo`, `record`, `startdemos`, `resetcfg`, `writeconfig`,
`stuffcmds`, `developer`, `sv_cheats`, `god`, `noclip`, `give`, `impulse`
outside the list, `rcon`-style anything, `net_*` and `*server*` cvars,
`cmdline`, `registered`, `gamecfg`, `max_edicts`, `sys_ticrate`, `pausable`
(room rule), any command that writes a file or sends a message, and any
free-text value containing `;`, `"`, `\`, a newline or control characters (reuse
`Sys_CommandArgIsSafe`, `src/sys.js`).

From the quakestarter annotated autoexec example: `host_maxfps`, `crosshair`,
`scr_crosshairscale`, `gl_texturemode`, `gl_texture_anisotropy`,
`r_viewmodel_quake`, `r_particles`, `r_wateralpha`, `r_lavaalpha`,
`r_slimealpha`, `r_telealpha`, `r_lerpmove`, `r_lerpmodels` are all in the safe
list; `sv_aim` and `skill` fall under "needs care". Only the first group is
video, the example sets no binds, aliases or network cvars.

### Mapping

One namespace, no free-form command string:

- `?cfg.<cvar>=<value>`, for example `?cfg.fov=100&cfg.sensitivity=4`. The
  `cfg.` prefix keeps it clear of the existing params (`game`, `base`, `map`,
  `room`, `server`, `listen`, `agent`, `dpr`, `scale`, `particles`).
- `?bind.<key>=<action>` for binds, for example `?bind.q=%2Bjump`.
- Optional shorthand `?cfg=fov:100,sensitivity:4` for links that must be short.
- No `?autoexec=` raw text. A raw text param is the thing to avoid: the C
  autoexec is a script; a URL is untrusted input.

### Code path

1. New module `src/url_config.js` (web addition, header says so), pure with no
   DOM at import time. Exports `URLCfg_Parse(search)` returning
   `{ cvars: [[name, value]], binds: [[key, cmd]], rejected: [..] }`. Holds the
   allowlist as a table
   `{ name: { type: "float"|"int"|"bool"|
   "enum", min, max, values } }`;
   every value is parsed and clamped, never concatenated into a command string.
   Reuse the rows of `src/menu_cvars.js` (`advancedPages` already has min, max,
   step and values per cvar) as the source of ranges so the two stay in step;
   add a test that every allowlisted name is a registered cvar.
2. Apply in `main.js` after `Host_Init` and after the saved config loads
   (`src/host.js:558`), before the auto-join `connect`, so URL values win over
   saved ones: call `Cvar_Set(name, String(value))` and `Key_SetBinding`
   directly, not `Cbuf_AddText`. Per-page-load only: add a `session-only` set so
   these values are not written by `Host_WriteConfiguration` (skip names in the
   URL set when writing), so a shared link cannot change a friend's saved
   settings.
3. Print each applied and rejected param to the console (`Con_Printf`) so
   players see what the link did. Cap the number of params (for example 64) and
   the length of each value (64).
4. Joining links (`?room=`) may carry `cfg.` for the friend's preferences only;
   the link-sharing UI should not add them automatically.
5. Tests in `tests/url_config_test.js`: every unsafe name rejected, clamping,
   injection strings (`;quit`, newline, quotes), unknown cvars, `bind` of
   non-allowed commands, and the "saved config untouched" property.

This shares one idea with S1: the same table can back the client's stuffcmd
allowlist (host-sent `cfg` is a strict subset of what the player's own URL may
set).

## What was not verified

- Real devices: phone hosting under screen lock, thermal, battery, iOS Safari
  unreliable channels, Android Chrome.
- Real NATs, CGNAT, TURN relay under load; Cloudflare pricing and whether TURN
  needs a billing method.
- Packet loss and jitter behaviour; only a localhost bench with no loss.
- `kick` of the host slot by a joiner; coop cheat commands by a joiner (read
  from code only).
- The deployed Cloudflare lobby and Turnstile on the live site.
- The other open PRs' diffs (#235, #238-#243): only their topics are known.
