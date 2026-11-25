# Browser-hosted rooms over WebRTC (design)

Design notes, 2026-11-25, against `dev` at `11e5cbd`. Nothing here is
built, deployed or tested yet. The goal is free multiplayer that doesn't
depend on the maintainer's Mac or a paid server, on desktop and mobile.
One player's browser tab hosts the room, the way a NetQuake listen server
does, and the other players join it directly over WebRTC.

Tags, as in [always-on-hosting.md](always-on-hosting.md):
- **[docs]**: read on the cited page on 2026-11-25.
- **[code]**: read in this repo.
- **[C]**: read in id's source.
- **[measured]**: run with the spike page (see "Spike").
- **[estimate]**: arithmetic on measured figures from always-on-hosting.md.
- **[unverified]**: inference, or a claim not checked at a primary source;
  check it before relying on it.

## What it gives, in short

- **Who can host:** desktop browsers, and only while the host's tab stays
  in the foreground (see "Where the host's server runs"). Phones can host
  only while the browser is in front and the screen is on. iOS suspends a
  backgrounded tab, and WebRTC and Web Audio stop when the screen locks
  (from forum reports, so treat it as [unverified]). Nothing in this design
  changes that.
- **Who can join:** any browser with WebRTC data channels, desktop or mobile
  [unverified: confirm unreliable channels on iOS Safari in the spike].
- **What it costs:**
  - The lobby and signalling run in a Durable Object that hibernates between
    messages, so they stay far inside the Workers Free plan.
  - Cloudflare's STUN server is free and unlimited [docs].
  - Cloudflare's TURN relay is free up to 1,000 GB a month [docs]. Whether it
    needs a billing method on file isn't stated (see "Decisions").
- **What it can't do:**
  - The room ends when the host leaves. There is no host migration in Quake.
  - The host has a zero-ping advantage, and could cheat by modifying their
    own client, which the server code runs in.

## How it works

1. **Host:** chooses *Host game*. Their tab starts a listen server (`listen
   1`, `maxplayers N`, `map X`), opens a long-lived WebSocket to the lobby
   DO, and registers the room. The lobby replies with a six-character room
   code.
2. **Joiner:** picks the room from the list, or types the code. Their tab
   asks the lobby for ICE servers, creates an `RTCPeerConnection` with two
   data channels, and sends its offer through the lobby. The lobby relays
   the offer, the answer and the ICE candidates between joiner and host.
3. **Connection:** once the data channels open, the joiner's engine runs the
   usual `ICARO` hello. The host's WebRTC driver hands the new socket to
   `NET_CheckNewConnections`, and `SV_CheckForNewClients` connects the
   client as for any network player [code: `src/sv_main.js:625`].
4. **During play:** game traffic goes peer to peer, or through TURN when NAT
   blocks a direct path. The lobby only sees the host's heartbeat.

## Where the host's server runs

Three candidates.

**A. The main thread, as the C's listen server does (v1).** The engine
already runs a full server in the tab for single player. The host's own
client connects through loopback, and it skips prediction and lerp under
`sv.active` [code: `src/cl_pred.js:1153`, `src/cl_main.js:601`].

- The frame loop is `renderer.setAnimationLoop` (rAF) [code: `main.js`]. A
  hidden tab stops it, so the server stops, and every joiner times out.
- Timers don't rescue it. Chrome runs background timers at most once a
  second, and an open data channel only exempts a page from the stricter
  once-a-minute tier [docs]
  ([Chrome 88 throttling](https://developer.chrome.com/blog/timer-throttling-in-chrome-88)).
- So in v1 the host keeps the tab visible. The host page asks for a Screen
  Wake Lock, and shows a warning while hosting.

**B. A Worker running the dedicated-room loop (later, if the spike allows
it).** A second copy of the engine runs in a dedicated Worker, ticking at
20 Hz as `server/game_server.js` does. The host's tab becomes an ordinary
client of it over a `MessagePort` loopback, with prediction and lerp like
any joiner. The joiners' data channels are transferred to the Worker.

- `RTCDataChannel` is transferable in Chrome 130 and Firefox 144. WebKit
  fixed it in 2021, but the Safari release isn't named [docs]
  ([Chromium intent](https://groups.google.com/a/chromium.org/g/blink-dev/c/8CZbYcvQJAY),
  [Firefox](https://bugzilla.mozilla.org/show_bug.cgi?id=1209163),
  [WebKit](https://bugs.webkit.org/show_bug.cgi?id=222965)). The spike
  transferred both kinds of channel in Chromium 156 [measured].
- Whether Worker timers keep a 20 Hz cadence in a hidden tab is
  [unverified]; the spike measures it.
- The engine imports `three` as a bare specifier, which `index.html`'s
  import map resolves. A module Worker in Chromium 156 doesn't honour the
  page's import map [measured]. So B needs a bundle (for example `deno bundle`,
  mapping `three` to `server/browser_shim.js` as Deno does), and the repo
  has no build step today.
- Two engine copies in one tab cost about 60 MB more, going by a room's
  memory with a lazily opened pak [estimate].
- B makes the host's view the same as everyone else's. It doesn't help
  phones, which suspend Workers along with the tab.

**C. A desktop host app built with `deno desktop` (later, optional).**
[Deno desktop](https://docs.deno.com/runtime/desktop/) (Deno 2.9+, which the
repo already pins) compiles a Deno program and a webview into one
executable for macOS, Windows (x86-64) and Linux. The room would run as the
Deno program, with the game in the webview.

- `Deno.serve` there binds only to `127.0.0.1`, so the app can't be a
  public WebSocket server [docs]. Joiners would still connect over WebRTC.
  Deno has no built-in `RTCPeerConnection` [unverified], so the data
  channels would live in the webview and relay packets to the Deno side
  through bindings.
- Relaying is event-driven, so a hidden window's timer throttling wouldn't
  stop it [unverified]. The tick runs in the Deno process, which isn't a
  browser tab and isn't throttled the same way [unverified].
- WebRTC is documented only for the CEF backend, which is about 150 MB
  [docs]. The OS webviews "vary per platform".
- Shipping it costs more than the code:
  - macOS builds are signed ad hoc unless you have an Apple identity, so
    users see Gatekeeper warnings.
  - Windows builds have to be signed separately.
  - Auto-update doesn't apply on Windows [docs].
- The executable may bundle only `static/pak0.pak`, the same rule as the
  game-room image's allowlist. Registered data stays on the player's own
  disk, loaded at run time, as in the browser.
- It fits the "downloadable executable" idea better than `deno compile`.
  `deno compile` gives a headless room, which could only serve WebRTC if
  Deno had it [unverified], so players would most likely still need a port
  forward and a certificate to reach it over WebSocket or WebTransport.

**Choice:** ship A, and specify the host side of the WebRTC driver against
a narrow channel interface: `send`, `onmessage`, `onclose`,
`bufferedAmount`, `close`. That is the shape `server/net_websocket_server.ts`
already uses for `WebSocketLike` [code]. Moving the server to B or C later
then means relocating the driver, not rewriting it.

## Tick and snapshot rate

- A C listen server ticks once per host frame. Here that is up to 72 Hz
  (`host_maxfps`), and isolation runs the network at `HOST_NETINTERVAL`,
  also 1/72 s [code: `src/host.js:134`, `Host_UpdateNetInterval`].
- Forcing the server to 20 Hz on the main thread would make the host's own
  view step at 20 Hz, since the host doesn't lerp under `sv.active`. So v1
  keeps the C's per-frame server tick.
- Remote clients would then get up to 72 snapshots a second, against the
  20 the dedicated rooms send. That is about 3.6 times the downstream
  traffic, and it all comes out of the host's upload. At the bench's
  1.3 KB/s (4 players) to 7.3 KB/s (16 players) per client at 20 Hz, 7
  joiners would take at most 30–180 KB/s [estimate]. That is an upper
  bound: delta packets shrink when sent more often.
- **Proposed deviation:** send datagrams to non-`LOCAL` sockets no more than
  every `sys_ticrate` seconds (50 ms), and send the host's own client every
  frame. Joiners would then get updates at the rate a dedicated room sends
  them, the case the client's prediction and ping readout were built for
  [unverified]. The stream isn't identical: the host's physics still steps
  every frame, where a dedicated room steps at 20 Hz. Mark it in `SV_SendClientMessages`
  as a deviation, and test it in a browser.

## Transport

A new `src/net_webrtc.js` implements both roles: joining as a client, and
listening as a host. It is registered in `NET_Init` after the WebSocket
driver, behind a `typeof RTCPeerConnection` guard [code: `src/net_main.js`
`NET_Init`].

- **Channels:** each peer connection gets two data channels.
  - `reliable` (ordered, reliable) carries `QSendMessage`.
  - `unreliable` (`ordered: false`, `maxRetransmits: 0`) carries
    `SendUnreliableMessage`.

  This mirrors WebTransport's stream and datagrams.
- **Framing:** one data-channel message is one game packet, with no length
  prefix, since SCTP keeps message boundaries.
  - The packet is the existing `[0x71][seq u32][ack u32][payload]`, with
    the sequence and ack rules of the WebSocket driver [code: `src/net.js`].
  - The `ICARO` hello and the handshake reply go first, on the reliable
    channel, as `net_websocket.js` sends them.
- **Datagram size:** set `sock.maxdatagram` to about 1,150 bytes.
  `SV_ClientDatagramSize` clamps it to 1,024–1,400 [code].
  - An unreliable message bigger than the path MTU (about 1,200 bytes of
    payload after DTLS and SCTP) gets fragmented. Losing one fragment then
    loses the whole message [unverified].
  - `sctp.maxMessageSize` (reportedly at least 64 KiB in current browsers
    [unverified]; the spike records it) is no guide for unreliable
    messages.
- **Address:** `sock.address` is a synthetic peer id such as `rtc:peer7`,
  not a room code. It
  must never be `LOCAL`, which `SV_ClientDatagramSize` treats as loopback
  [code].
- **Selection:** `NET_Connect` takes a new `rtc:<ROOMCODE>` host form, next
  to its WebTransport and WebSocket branches [code: `src/net_main.js`
  `NET_Connect`].
- **Server-side slots:** the host driver allocates through
  `NET_NewQSocket( pending )`, counting its own pending peers as the server
  drivers do, so slots aren't oversubscribed [code: `server/game_server.js`
  socket allocators].
- **Untrusted peers:**
  - Cap each message at `NET_MAXMESSAGE` (8,192 bytes).
  - Cap the queued reliable bytes per peer.
  - Drop a peer whose hello doesn't arrive within the handshake timeout.
  - The server drivers do the same at the byte level; the engine has no
    per-peer limits of its own [code].
- **Shared code:** the hello, handshake and sequence helpers in `src/net.js`
  are already shared. The host-side accept logic (`_onHello`'s checks and
  replies) is ported from `server/net_websocket_server.ts`. That driver is
  TypeScript and Deno-only, so the browser can't import it.

## Signalling and the lobby

- **Where it runs:** a Worker routes `/mp/lobby` to one lobby Durable
  Object, which uses WebSocket hibernation (`ctx.acceptWebSocket`,
  `webSocketMessage`, tags) [docs]
  ([DO WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)).
  Hibernation works on the Free plan with SQLite-backed classes [docs].
- **Shared state machine:** the lobby's logic goes in a plain module that
  both the DO and `server/lobby_server.js` import. The module handles room
  records, the room-code rules, `parseCreateConfig`, rate limits and the
  signal relay. `deno task test` has no network, so pure functions are the
  only way this gets tested in CI. The self-hosted lobby gains the same
  signalling for local development.
- **Protocol:** it keeps the existing `[type u8][len u16le][payload]` frames
  and `LOBBY_LIST`, `LOBBY_JOIN`, `LOBBY_CREATE` (for Deno rooms) and
  `LOBBY_ROOMS`/`LOBBY_ERROR` [code:
  `server/lobby_server.js`], and adds:
  - `LOBBY_HOST`: the host registers a room and keeps its socket open. The
    room disappears when that socket closes (`webSocketClose`), or when its
    last heartbeat is more than 90 s old. `webSocketClose` doesn't always
    fire when a connection drops abruptly, and a hibernating DO can't
    notice a missed heartbeat by itself. So the DO prunes stale rooms
    whenever it handles a `LIST` or `JOIN`, and sets an alarm only while
    rooms exist. Alarms wake the DO and count as requests [unverified].
  - `LOBBY_SIGNAL`: `{ to, from, kind: offer | answer | candidate, data }`,
    relayed by peer id. The lobby never parses SDP.
  - `LOBBY_ICE`: the ICE server list for this client (see NAT traversal).
  - `LOBBY_HEARTBEAT` from the host, carrying the player count, every 30 s.

  Lobby sockets become long-lived for hosts and for joiners until they
  connect. Today the client opens one socket per request [code:
  `src/net_websocket.js` lobby helpers].
- **Room record:** `{ id, transport: 'rtc', map, maxPlayers, players,
  hostName, options }`. A Deno room has `transport: 'ws'` or `'wt'`, and
  the client picks the driver by `transport`.
  - The DO lobby lists browser-hosted rooms. The Deno lobby lists its own
    rooms and, through the shared module, any browser-hosted rooms
    registered with it.
  - The two lobbies don't share a room table. A deployment points its
    `/mp/lobby` at one of them, and players see that lobby's rooms. A
    combined list would need one lobby to query the other, which would
    make the DO depend on the Mac. That is out of scope.
  - The `/mp/lobby` default from #178 stays the same address.
- **Behaviour that changes:** a `JOIN` for an unknown room code is an error.
  The Deno lobby's auto-create on `JOIN` doesn't apply, since the DO can't
  start a room. Everything a host says about its room (map, options, name)
  is unverified, which is fine for a listing.
- **Cost:** a join is about a dozen messages, and a host's heartbeat is 120
  messages an hour, about 6 billed requests at 20:1. The Free plan's
  100,000 requests a day are far away. `setWebSocketAutoResponse` can answer
  keep-alive pings without waking the DO [docs].

## NAT traversal

- **STUN:** `stun:stun.cloudflare.com:3478`, free and unlimited [docs]
  ([TURN FAQ](https://developers.cloudflare.com/realtime/turn/faq/)).
- **TURN:**
  - The lobby Worker mints short-lived credentials. It POSTs to
    `rtc.live.cloudflare.com/v1/turn/keys/<id>/credentials/generate-ice-servers`
    with the TURN key's API token, held as a Worker secret, and passes the
    `iceServers` to clients in `LOBBY_ICE` [docs]
    ([credentials](https://developers.cloudflare.com/realtime/turn/generate-credentials/)).
  - Offer `turns:turn.cloudflare.com:443?transport=tcp` for networks that
    block UDP.
- **How often TURN is needed:** older studies put it at about 15–22% of
  connections [docs: studies from 2015–16]. Mobile carriers' NATs often behave as
  symmetric NATs [unverified]. Without TURN, a share of mobile players
  couldn't join, so STUN alone doesn't meet the mobile requirement.
- **Privacy:** ICE candidates show peers each other's IP addresses. A
  *Hide my IP* setting (`iceTransportPolicy: 'relay'`) would route that
  player through TURN at the cost of relay bandwidth.
- **Bandwidth:** in a 4-player game with all 3 joiners relayed, each
  joiner moves about 3.5–4.8 KB/s at 20 Hz (1.3–2.6 KB/s down, 2.2 KB/s
  up, from the bench). That is 10.5–14.4 KB/s, or about 0.04–0.05 GB an
  hour, before DTLS, SCTP and UDP headers (roughly 60 bytes a packet,
  about 30% more) [estimate]. 1,000 GB a month is then about 15,000
  relayed 4-player game-hours. At an uncapped 72 Hz it would be about a
  third of that.

## Listen-server rules

- **Player limit:** the client slots are allocated once, at start-up, by
  `Host_FindMaxClients`. This port has dropped its `-dedicated` and
  `-listen` handling, so the browser always has `maxclients` 1 and 4 slots
  [code: `src/host.js:263–266`]. In the C, `-listen [n]` sets `maxclients` and
  the slot count to `n` (8 if omitted, capped at `MAX_SCOREBOARD`) and sets
  `deathmatch 1` [C: `WinQuake/host.c`].
  - Restore the C's `-listen` handling, and let `main.js` pass it from a
    `?listen=N` URL parameter, as it passes `?particles=`.
  - The listen flag changes start-up defaults (`maxclients` N,
    `deathmatch 1`). Single player still works, because the menu's new game
    runs `maxplayers 1`, which drops `listen` and sets `deathmatch 0` [code:
    `src/menu.js:971`, `MaxPlayers_f` in `src/net_main.js`].
  - Since slots can't grow after start-up, *Host in this browser* reloads
    the page with `?listen=16` when it has fewer slots than the host asked
    for. Loading every page with `-listen 16` would avoid the reload but
    start every player in deathmatch mode, which the C never does without
    the flag.
- **Exit and game rules:**
  - `game_server.js` applies `noexit`/`samelevel` and the game options before
    spawning (`applyGameOptions`, `applyExitRules`) [code]. A deathmatch
    room keeps its map: exits kill, and an intermission reloads the same
    map. The browser menu sets neither, so a browser-hosted deathmatch
    would keep the C's listen-server defaults and change level when anyone
    touched an exit.
  - To make the two kinds of room behave alike, move both functions into a
    shared module and call them from the host path before `map`. The room
    defaults aren't marked as a deviation from the C in `game_server.js`
    today; mark them there when they move.
- **Menu:** Start Game sends every game to `_NET_CreateRoom` today. The local
  `listen`/`maxplayers`/`map` path runs only when no lobby exists [code:
  `src/menu.js:1769–1893`]. Add *Host in this browser* next to it, and a
  *Join by code* row. `_NET_MultiplayerAvailable` should count WebRTC.
- **Ending the game:** when the host quits or hits `Host_Error`, call
  `Host_ShutdownServer( true )`, so joiners get `svc_disconnect`. Then close
  the lobby socket, which removes the room.
- **Tab closing:** `pagehide` should send the disconnects and close the lobby
  socket, as the WebSocket driver already does for its own sockets [code].
  - `pagehide` also fires when a phone switches apps and when a page enters
    the back-forward cache, not only on close.
  - Data sent then may not flush.
  - So joiners rely on the data channel's `close` event. The fallback,
    `net_messagetimeout`, defaults to 300 s [code: `src/net_main.js:69`],
    which is too long to wait. Neither the lobby nor the closed lobby
    socket tells joiners anything, since game traffic is peer to peer.

## Spike: settle the unknowns first

`tools/webrtc_spike/` is one static page (not shipped) with two
`RTCPeerConnection`s in the same page, wired to each other. It needs no
signalling, server or account; its `index.html` says how to run it. It
records:

1. Whether an `ordered: false, maxRetransmits: 0` channel opens, and
   `pc.sctp.maxMessageSize`.
2. Loss and delivery for messages of 1,000–1,400 bytes on the unreliable
   channel.
3. With the page hidden for 10 minutes, the cadence of a main-thread
   `setInterval( 50 )`, a dedicated Worker's `setInterval( 50 )`, and
   message delivery to both.
4. Whether a data channel transfers to a Worker, and whether a module
   Worker resolves a bare specifier (as `three` is) through the page's
   import map.

Test 3 decides between A and B, and the other browsers confirm mobile
joining.

### Results so far

**Chromium 156, in the Claude desktop app's browser pane, macOS,
2026-11-25** [measured]:

| Test | Result |
| --- | --- |
| 1. Unreliable channel | Opens; both sides report `ordered: false`, `maxRetransmits: 0`. `sctp.maxMessageSize` is 262,144 on both peers. |
| 2. Paced sends, 1,000–16,000 bytes | 300 of 300 at every size. |
| 2. Burst of 300 | All delivered except 281 of 300 at 4,000 bytes, in one run. The cause isn't established (`bufferedAmount` wasn't recorded); a local buffer overrun is the likely one [unverified]. The host driver should cap queued bytes per peer anyway. |
| 3. Hidden page | Not run. The pane keeps a background tab visible (`visibilityState` stays `visible`), so it can't test throttling. |
| 4a. Transfer a channel created here | Works; it opens in the Worker. |
| 4b. Transfer a channel from `ondatachannel` | Works; it opens in the Worker. |
| 4c. Import map in a module Worker | Not honoured. The bare specifier fails to load, and the same import by relative path loads. |

So option B needs a bundle with `three` resolved at build time.

Test 3's sender-side series (`main_interval`, `worker_interval_own_clock`,
`dc_main_sent`, `dc_worker_sent`) show each timer's cadence. The
`*_received_on_page` series are timed on the hidden page's own main thread,
so they mix delivery with that page's event delays; a joiner on another
device is the true receiver. The
pane's Chromium is embedded in Electron and may differ from Chrome on
throttling, so test 3 must run in real browsers.

**Still to run, on the maintainer's devices:**
- test 3 in desktop Chrome, Firefox and Safari;
- all tests in iOS Safari and Android Chrome.

Paste each run's *Copy results* JSON into this section.

## PRs, in order

1. **The spike page and its results**, written into this doc.
2. **`src/net_webrtc.js`** with both roles, and tests against a fake
   `RTCPeerConnection`/`RTCDataChannel` pair (in the style of
   `tests/fake_webtransport.js`): handshake, sequencing, caps, close.
3. **Listen-server rules:** `-listen` from `?listen=N`, the shared
   `applyGameOptions`/`applyExitRules`, 20 Hz datagrams to remote sockets,
   and shutdown on errors and tab close.
4. **The lobby module, its Deno use and the Durable Object:** the shared
   state machine with tests, `lobby_server.js` using it, and `cloudflare/`
   with the Worker, the DO and TURN credentials. Deploying it needs the
   maintainer's Cloudflare account; the Free plan is enough.
5. **Menus:** *Host in this browser*, *Join by code*, and a room list that
   shows both kinds of room.
6. **Later, depending on the spike:** B (server in a Worker), or C (a
   `deno desktop` host app).

PRs 2 and 4 can be developed in parallel. 3 needs 2 for an end-to-end test,
and 5 needs 2–4.

## Decisions

Decided by the maintainer on 2026-11-25:

- **Hosting rule for v1:** the host keeps the tab in front, phones included.
  A Worker or a desktop host (B or C) comes later, if at all.
- **TURN:** the maintainer will create the Cloudflare Realtime TURN key,
  including a billing method if it asks for one. The lobby Worker holds the
  key's token as a secret; no agent creates keys or accounts.

Still open:

- **Room listing:** a public list of browser-hosted rooms, or codes only
  (private by default, nothing to moderate)?
- **Snapshot rate:** the 20 Hz cap for joiners proposed above, or the C's
  per-frame rate?

## Not verified

- Unreliable data channels on iOS Safari and desktop Safari, and the loss
  of messages near the MTU.
- Timer cadence in a hidden tab for the main thread and for Workers, in
  every browser (the spike's test 3 hasn't run anywhere yet), and
  data-channel delivery while hidden.
- Data-channel transfer to Workers in Safari and Firefox, and import maps
  in module Workers outside Chromium.
- Whether TURN needs a billing method on file.
- Current rates of connections needing TURN, especially on mobile data.
- The C's `-listen` handling restored as described, and whether every
  single-player start path runs `maxplayers 1`.
- Deno desktop: WebRTC on the OS-webview backend, `Deno.listenDatagram` and
  QUIC in a desktop build, timer throttling in a hidden window, and the
  absence of WebRTC in Deno itself.
- Whether 20 Hz snapshots to joiners, with the host's physics stepping at
  up to 72 Hz, feel right in play and keep joiners' prediction accurate.
- The bandwidth estimates: they scale bench payload figures, with packet
  overhead guessed.
