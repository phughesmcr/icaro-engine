# Hosting Icaro Engine multiplayer with Cloudflare

Research notes, 2026-11-25. They were written just before the WebSocket driver
landed (#161) and were then updated to match `dev`: the WebSocket transport and
the Cloudflare Tunnel layout now exist and are documented in
[server/README.md](../server/README.md) ("WebSocket transport" and "Cloudflare
Tunnel"). The other options were researched only, not built. Each Cloudflare
fact is tagged with how it was checked:

- **[docs]**: read on the cited `developers.cloudflare.com` or
  `blog.cloudflare.com` page on 2026-11-25.
- **[search]**: seen only in search-result snippets, not on the page itself.
- **[unverified]**: inference or memory. Measure or check it before relying on
  it.

## Summary

No self-serve Cloudflare product accepts public UDP/QUIC traffic and forwards it
to an origin, so WebTransport (HTTP/3 over QUIC/UDP) can't sit behind
Cloudflare. The game has two transports, and each has a route:

1. **WebTransport bypasses Cloudflare.** Cloudflare keeps serving the static
   client and provides DNS. The lobby and rooms run on a host with public UDP
   (the home Mac with port forwarding, or a VPS), behind a DNS-only record with
   a Let's Encrypt certificate. No code changes: share links keep `?server=`
   (see option 5).
2. **WebSocket goes through Cloudflare.** The WebSocket driver (#161) runs
   through a Cloudflare Tunnel with one ingress rule and no open ports (option
   1, set up as in server/README.md). Containers or Durable Objects could host
   the same driver on Cloudflare itself. WebSocket loses unreliable datagrams
   (TCP head-of-line blocking). WebRTC with Cloudflare TURN would keep them, but
   that is still unbuilt porting work.

> **Superseded for always-on hosting.** The recommendation below needs the home
> Mac on and connected. For hosting that doesn't, see
> [always-on-hosting.md](always-on-hosting.md): rooms in Cloudflare Containers
> with a Worker lobby, or a small VM. It also measures a room's memory, CPU and
> bandwidth, which settles several items in "Not verified" below.

**Recommendation (home Mac):** the Tunnel route is free, needs no router ports
and doesn't expose the home IP, and it works in every browser, so it is the
simplest default. Add the hybrid (option 5) for players who have WebTransport if
stalls under packet loss turn out to matter. Cloudflare Containers is the paid,
fully Cloudflare-hosted version of the Tunnel route. Durable Objects, Spectrum
and the Realtime SFU are poor fits; see below.

## How multiplayer works today

- **Lobby** (`server/lobby_server.js`): a Deno WebTransport server on UDP
  `4433`, using `Deno.QuicEndpoint` + `Deno.upgradeWebTransport` under
  `--unstable-net`. It speaks a small framed protocol (`LOBBY_LIST`,
  `LOBBY_CREATE`, `LOBBY_JOIN`). It spawns one `game_server.js` **process per
  room** with `Deno.Command` (`server/room_process_manager.ts`), on UDP ports
  `4434`–`4443` (10 rooms at most).
- **Room** (`server/game_server.js`): runs the whole engine from `src/`
  headless: the QuakeC VM, NetQuake physics (`SV_Physics`) and QW-style delta
  packet entities. It ticks with `setInterval` at `sys_ticrate` (0.05 s, 20 Hz).
  It reads `static/pak0.pak` (18.7 MB) from disk. Engine state is module-level
  globals (C globals ported as module exports), which is why rooms are separate
  processes.
- **WebTransport** (`server/net_webtransport_server.ts`,
  `src/net_webtransport.js`):
  - One bidirectional stream carries reliable Quake messages (signon,
    stringcmds).
  - WebTransport **datagrams** carry unreliable ones (entity updates,
    clientdata, `clc_move`), with a fallback to the reliable stream.
  - A `0x71` header carries sequence and ack, which drive client prediction.
- **WebSocket** (`server/net_websocket_server.ts`, `src/net_websocket.js`,
  #161): the same messages as frames on one socket. The lobby and rooms listen
  with `-wsport`. A client reaches a room through the lobby's
  `<prefix>/room/<id>` proxy, so only the lobby's port has to be reachable.
  Browsers without WebTransport use it automatically; `?transport=ws` or a
  `ws://`/`wss://` `?server=` forces it.
- **Client discovery** (`src/menu.js`, `main.js`, `src/sys.js`):
  - The WebTransport lobby is `?server=` or `SYS_DEFAULT_LOBBY`
    (`https://localhost:4433`). The WebSocket lobby defaults to
    `ws://127.0.0.1:4433` on a localhost page and `wss://<page host>/mp`
    elsewhere, which is the Tunnel layout.
  - For WebTransport, the lobby replies with **only a port**: the client keeps
    the lobby's host and swaps the port.
  - Share links come from `Sys_PageURL` (`src/sys.js`). They keep `?room=`,
    `?game=`, a valid `?server=` and `?transport=`.
- **Certificates:** the client never passes `serverCertificateHashes`, so the
  lobby and rooms need a **publicly trusted** certificate for the hostname.
  Self-signed certificates work only with Chrome flags. The server doesn't check
  `Origin`, so the page and the game host can be different hosts.
- **Timing needs:**
  - Each client sends a `clc_move` every client frame, up to `host_maxfps` = 72
    Hz.
  - The server sends a datagram per client per tick (20 Hz). For remote clients
    it is capped at `DATAGRAM_MTU` (1400 bytes, as in FitzQuake) so it isn't
    fragmented (`src/quakedef.js`).
  - Prediction (`pmove`, `cl_pred.js`) hides latency, but loss on a reliable
    ordered transport (TCP/WebSocket) stalls everything behind the lost packet
    (head-of-line blocking).
  - Bandwidth is small: 1.3–7 KB/s down and 2.2 KB/s up per player, up to about
    116 KB/s for a 16-player room (measured; see
    [always-on-hosting.md](always-on-hosting.md#measurements)).
- **Engine structure:** `src/net_main.js` keeps the NetQuake driver table
  (`net_drivers`: loopback, WebTransport, WebSocket and, where the browser has
  `RTCPeerConnection`, WebRTC), as in C (`net_dgrm`/`net_loop`). The WebRTC
  driver (`src/net_webrtc.js`) is browser-only: a tab hosts and joiners connect
  to `rtc:<ROOMCODE>`.

## Options

### 1. Cloudflare Tunnel (`cloudflared`)

**Verdict:** it can't carry WebTransport or UDP. It carries the WebSocket
transport, and this is the layout server/README.md documents.

- **Public hostnames** route HTTP/HTTPS, plus TCP/SSH/RDP/SMB. The non-HTTP
  types need `cloudflared` on the _client_ ("Streams TCP over a WebSocket
  connection"). UDP, QUIC and WebTransport aren't offered [docs].
  [Tunnel routing](https://developers.cloudflare.com/tunnel/concepts/routing/),
  [Tunnel](https://developers.cloudflare.com/tunnel/)
- **QUIC** in Tunnel is only the link between `cloudflared` and the edge (port
  7844); it isn't exposed to visitors [search].
  [Blog](https://blog.cloudflare.com/getting-cloudflare-tunnels-to-connect-to-the-cloudflare-network-with-quic/)
- **UDP through a tunnel** exists only for private networks (WARP clients)
  [search], or as a private origin for **Spectrum** UDP apps (Enterprise)
  [docs].
  [Spectrum limitations](https://developers.cloudflare.com/spectrum/reference/limitations/)
- **HTTP/3 to the origin:** the edge speaks HTTP/3 to visitors only: "HTTP/3
  connection to the origin is not yet supported" [docs]. No Cloudflare page
  documents WebTransport proxying.
  [HTTP/3](https://developers.cloudflare.com/speed/optimization/protocol/http3/)
- **WebSockets:** the proxy supports them "without additional configuration".
  Cloudflare may restart servers when it deploys code, "which terminates
  WebSockets connections" [docs].
  [WebSockets](https://developers.cloudflare.com/network/websockets/)
  - The Tunnel FAQ says "Cloudflare Tunnel has full support for Websockets"
    [docs].
    [Tunnel FAQ](https://developers.cloudflare.com/cloudflare-one/faq/tunnel/)
  - That FAQ sits in the Cloudflare One section and doesn't name public
    hostnames specifically. Treat it as very likely but test it.
- **Code changes:** none left. Rooms can't each have a port, so the lobby
  proxies `<prefix>/room/<id>` to the room's loopback WebSocket port, and one
  ingress rule (`path: ^/mp/`) sends the lobby path to it.
- **Cost:** free.
- **Latency:** every packet goes client → nearest Cloudflare PoP → the PoP
  `cloudflared` is attached to → Mac. That's a small detour for remote players,
  but a player on the same LAN as the Mac also goes out to the PoP and back
  [unverified: measure]. Add TCP head-of-line stalls under loss.
- **Constraint:** the existing `icaro` tunnel was not touched. Using a tunnel
  for multiplayer would mean a new ingress rule or a second tunnel, which is
  your decision.

### 2. Cloudflare Spectrum

**Verdict:** not available on Free, and UDP needs a separate Spectrum Enterprise
contract. Not a realistic option.

- **Plans** [docs]
  ([protocols per plan](https://developers.cloudflare.com/spectrum/protocols-per-plan/)):
  - UDP row: Free "No", Pro "No", Business "No", Enterprise "Paid add-on".
  - TCP to an IP/DNS origin: Pro and Business "No".
  - TCP to a Worker origin (beta): Pro and Business, one app per zone.
  - The Enterprise column "requires Spectrum Enterprise access, which is
    separate from a zone's Enterprise plan".
  - One search snippet claimed UDP was a Business add-on; the page itself says
    it isn't.
- **Limits:** "Cloudflare does not support packet fragmentation for UDP
  packets", and Spectrum HTTPS apps don't support HTTP/3 [docs].
  [Limitations](https://developers.cloudflare.com/spectrum/reference/limitations/)
- **QUIC/WebTransport fit:** a UDP app forwards datagrams, and TLS ends at the
  origin, so QUIC should pass through in principle [unverified; Cloudflare
  doesn't document QUIC passthrough].
- **Code changes:** none, beyond pointing DNS at Spectrum.
- **Cost:** neither the Spectrum docs nor the
  [product page](https://www.cloudflare.com/products/cloudflare-spectrum/)
  publish a price, allowance or overage; it's a sales conversation [docs]. The
  general plans page wasn't checked.
- **Latency:** anycast ingress near the player plus Cloudflare's backbone; this
  would be the best latency of any option here, if it were obtainable.

### 3. Workers + Durable Objects

**Verdict:** technically WebSocket-only, and blocked by the engine's
module-level globals. It would be a large refactor, not a port.

- **Transport:**
  - Durable Objects accept WebSockets, with or without the hibernation API
    [docs].
    [DO WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
  - No Workers or DO docs mention WebTransport, and there is no UDP. The new
    inbound `connect()` socket handler is TCP-only and in private beta;
    "UDP-based protocols" are future work [docs].
    [Blog](https://blog.cloudflare.com/grpc-workers/)
- **Isolation (the blocker):**
  - "Multiple instances of the same Durable Object class can share an isolate",
    and instances "may share global memory" [docs].
    [What are DOs](https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects/),
    [In-memory state](https://developers.cloudflare.com/durable-objects/reference/in-memory-state/)
  - `src/` keeps the whole server state (`sv`, `svs`, `pr_*`, edicts, models) in
    module globals. Two rooms in one isolate would corrupt each other.
  - One DO per room therefore means moving all engine state into a per-instance
    context. That touches most of `src/` and fights the keep-C-names/C-globals
    style of the port.
- **Runtime:**
  - The server uses Deno APIs: `Deno.readFile`, `Deno.openSync` and
    `Deno.statSync` in `src/pak.js`; `Deno.args` and `Deno.exit`; `Deno.Command`
    to spawn rooms; QUIC listeners.
  - The pak would have to come from R2 or static assets (25 MiB per asset; R2
    free tier 10 GB-month) [docs].
  - The 128 MB isolate memory limit is shared per isolate [docs]. Whether a room
    plus an 18.7 MB pak fits is [unverified].
  - The Worker size limit is 64 MiB with a 1 s startup budget [docs].
    [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- **Tick loop:**
  - `setInterval`/`setTimeout` prevent hibernation [docs], so a running room is
    billed for duration the whole time.
  - DO CPU is 30 s per invocation by default, and each incoming WebSocket
    message resets it [docs].
    [DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
  - Whether the Workers Free plan's 10 ms CPU limit applies to DO timer
    callbacks or map loads is **not stated** [unverified]. `SV_SpawnServer` on a
    map takes far more than 10 ms.
- **Cost:**
  [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
  [docs], for 4 players at 72 moves/s:
  - Messages: ~1.04 M incoming WebSocket messages/hour, billed 20:1, is about 52
    k requests/hour. **The Free plan's 100 k requests/day lasts about 2 hours of
    play.**
  - Duration: 0.128 GB × 3600 s ≈ 460 GB-s/hour, against 13 k GB-s/day on Free,
    so requests run out first.
  - On Paid ($5/month minimum): 1 M requests and 400 k GB-s included, then
    $0.15/M requests and $12.50/M GB-s. That's cents per evening.
  - Outgoing messages are free.
- **Latency:** a DO "is automatically provisioned geographically close to where
  it is first requested" [docs], so players elsewhere pay the distance.
  [DO overview](https://developers.cloudflare.com/durable-objects/) Location
  hints weren't checked. Add WebSocket head-of-line blocking.

### 3b. Cloudflare Containers

**Verdict:** the only fully Cloudflare-hosted option that keeps the engine as it
is (Deno, pak on disk, one process per room). It would use the WebSocket driver,
with the lobby reworked as below.

- **Plan:** Workers Paid only [docs].
  [Containers](https://developers.cloudflare.com/containers/)
- **Inbound traffic:** HTTP via Worker → DO →
  `container.getTcpPort(port).fetch()`. "Forward WebSocket upgrade requests
  through a Durable Object to a Container" is a documented example [docs].
  There's no inbound UDP; raw TCP needs the private-beta socket handler.
  [WebSocket example](https://developers.cloudflare.com/containers/examples/websocket/)
- **Fit:**
  - One container per room (`getByName(roomId)`) maps directly onto the
    process-per-room model.
  - The lobby becomes a Worker: it lists rooms and creates them by addressing a
    new container.
  - `Deno.Command` spawning and port allocation go away.
- **Instance types:** lite (1/16 vCPU, 256 MiB) up to standard-4 [docs]. A
  `basic` (1/4 vCPU, 1 GiB) is probably enough for one room [unverified].
- **Cost** [docs]
  ([pricing](https://developers.cloudflare.com/containers/pricing/)):
  - Included with Workers Paid: 25 GiB-h memory, 375 vCPU-min and 200 GB-h disk
    per month.
  - Overage: $0.0000025/GiB-s, $0.000020/vCPU-s (active CPU only), and egress
    $0.025/GB in NA/EU after 1 TB.
  - Billing stops when the container sleeps.
  - Example: 4 h/day of one `basic` room is about 120 GiB-h/month, about $0.86
    over the allowance, plus $5 for Workers Paid. CPU and egress are negligible
    [estimate].
  - Each container also has its own Durable Object, billed separately at DO
    rates [docs].
  - Whether every proxied WebSocket message counts as a DO request (72/s per
    player, see option 3) isn't stated [unverified]. If it does, Paid-plan
    request costs from option 3 apply on top, still cents per evening.
- **Latency:** container placement and cold-start time weren't checked
  [unverified]. A cold start delays the first join. Add WebSocket head-of-line
  blocking.

### 4. Cloudflare Realtime (SFU / TURN)

**Verdict:** the SFU is the wrong shape. **TURN** is an interesting NAT
traversal aid, but only if the game moves to WebRTC data channels.

- **SFU data channels** are publish/subscribe between WebRTC sessions:
  - "A publisher creates a named channel. Multiple subscribers can receive its
    messages, and one selected subscriber can reply."
  - They can be unordered and unreliable (`ordered: false`,
    `maxRetransmits: 0`), which matches Quake's datagrams [docs].
    [DataChannels](https://developers.cloudflare.com/realtime/sfu/features/datachannels/)
  - An authoritative server would publish per-client channels and subscribe to
    each client's channel. That works, but it's an awkward relay with a backend
    calling the SFU API.
- **WebSocket adapter:** it works on media tracks, not data channels [docs]. A
  server can't join without a WebRTC stack.
- **The more natural use** is direct WebRTC between browser and server, with
  Cloudflare **TURN** as relay fallback. The home Mac then needs no port
  forwarding: STUN/TURN traverse NAT, and signalling goes over the existing
  HTTPS/tunnel.
- **Cost:** SFU + TURN share 1,000 GB/month free, then $0.05/GB egress [search].
  [Pricing](https://developers.cloudflare.com/realtime/sfu/pricing/)
- **Code changes:**
  - A WebRTC net driver on both sides. The browser side exists
    (`src/net_webrtc.js`); the server side does not.
  - Deno has no built-in `RTCPeerConnection` [unverified]; it would need an npm
    WebRTC library (e.g. `werift`, pure TS, or `node-datachannel`, a native
    addon), and that is untested here.
  - A signalling path for the SDP/ICE exchange.
  - This is the most work of any option.
- **Latency:** direct P2P-style paths when they connect; TURN adds a relay hop.
  Unreliable channels avoid head-of-line blocking.

### 5. Hybrid: Cloudflare for the web, game servers elsewhere

**Verdict:** the servers and the client work unchanged. It is the WebTransport
route, with real unreliable datagrams.

- **Setup:**
  - The static client stays where it is (the existing tunnel, or Workers static
    assets / Pages).
  - If it ever moves to Workers assets or Pages, make sure the upload can't pick
    up the gitignored commercial paks under `static/` (`pak1.pak`, `id1/`,
    `rerelease/`, mission packs). Whether the upload tool honours `.gitignore`
    wasn't checked. Deploy from a clean clone or an explicit allowlist.
  - The lobby and rooms run unchanged on a host with public UDP `4433–4443`
    (IPv4, and IPv6 if available).
  - A **DNS-only (grey-cloud)** record, e.g. `mp.anglezarke.games`, points at
    that host. Proxied (orange) records only carry HTTP and won't pass QUIC to
    the origin.
- **Certificate:** Let's Encrypt via **DNS-01** with a Cloudflare API token (for
  example `certbot-dns-cloudflare` or `lego`), since nothing needs to be
  reachable on port 80. Renew it every ≤90 days and restart the lobby; rooms
  read the cert at spawn.
- **Client:**
  - `menu.js` reads `?server=` for listing, creating and joining, so
    `https://quake.anglezarke.games/?server=https://mp.anglezarke.games:4433`
    works, and `Sys_PageURL` keeps `server=` in room links, reloads and the
    address bar after a failed connect.
  - The WebTransport default lobby is still `https://localhost:4433` off
    localhost, so links without `?server=` don't reach it. Making the default
    the production lobby would shorten links; that is optional.
- **Home Mac:**
  - Forward UDP 4433–4443 on the router.
  - Keep the DNS record current with a small DDNS updater against the Cloudflare
    API, if the home IP changes.
  - Caveats:
    - It exposes the home IP. That's the main cost of not proxying.
    - It doesn't work behind CGNAT; check that the router's WAN IP is public.
    - The Mac must stay awake.
    - A player on the same LAN reaching the public hostname needs hairpin NAT on
      the router, or split DNS [unverified for this router].
    - Chrome's Local Network Access restrictions may also apply to WebTransport
      into a LAN address [search; caniuse lists "WebTransport API: Subject to
      Local Network Access restrictions"].
- **VPS:** any provider that allows inbound UDP works the same way. Pick a
  region near the players. Small VPSs cost a few dollars a month [unverified;
  prices not checked]. Deploy shareware `pak0.pak` only. Registered and
  rerelease paks must never go to a public server.
- **Latency:** the best you can get without Spectrum: a direct UDP path, real
  unreliable datagrams, and LAN speed for LAN players if hairpin/split DNS
  works.
- **Cost:** home Mac free; VPS a few dollars a month. The Cloudflare free plan
  covers DNS and the static site.

#### 5b. Lobby on Cloudflare (Worker), rooms elsewhere

This is possible, but not worth it for a single game host:

- **Protocol:** the lobby speaks WebTransport, so it would have to move to
  HTTP/JSON (or WebSocket) in a Worker. That means replacing the framed
  `LOBBY_*` exchange in `WT_QueryRooms`, `WT_CreateRoom` and the join path of
  `WT_Connect`.
- **Reply:** the lobby's reply would have to carry the **room host** as well as
  the port. Today the client reuses the lobby's host and only swaps the port.
- **Spawning:** rooms are spawned with `Deno.Command`, which can't run in a
  Worker. A small spawner/agent would still run on each game host, and the
  Worker would call it over HTTPS (through a tunnel) to start rooms and get
  their status. The per-IP limits, idle reaping and watchdog in
  `lobby_server.js` and `room_process_manager.ts` would be split between the
  two.
- **When it pays off:** with several game hosts (for example in different
  regions). With one host, the Deno lobby next to the rooms is simpler and
  already hardened.

## The WebSocket driver (used by options 1, 3 and 3b)

Built in #161: `src/net_websocket.js` on the client, and
`server/net_websocket_server.ts` with `Deno.upgradeWebSocket` on the lobby and
rooms. It reuses the existing framing and `0x71` sequence header, and sends
"unreliable" messages as frames on the same socket. The lobby proxies
`<prefix>/room/<id>` to each room's loopback listener, so behind a Tunnel TLS
ends at Cloudflare and no room port is public. Containers or Durable Objects
would still need the lobby reworked (see 3b and 5b).

- **Gameplay cost:**
  - TCP head-of-line blocking: a lost packet delays every later update until it
    is retransmitted, so stutter appears under loss rather than occasional
    dropped frames.
  - On a clean connection, latency is close to UDP.
  - Prediction smooths small jitter, not stalls.
- **Upside:** it works in any browser, and on networks that block UDP.

## Browser support (desktop and mobile)

- **Desktop:** WebTransport ships in Chrome/Edge and Firefox, and in Safari
  26.4+ on macOS 26.4+ [search]. [caniuse](https://caniuse.com/webtransport),
  [WebKit 26.4](https://webkit.org/?p=17862)
- **Mobile:**
  - Android: Chrome has it; Firefox for Android isn't listed here [unverified].
  - iOS: every iOS browser uses WebKit, so it needs iOS 26.4 (March 2026) or
    later. Older iPhones get the client's "requires a browser with WebTransport"
    alert (`menu.js`).
- **Networks:** some corporate, school and public Wi-Fi block or throttle
  UDP/QUIC [unverified]. The WebSocket transport covers those players, but only
  if they reach it through `?transport=ws` or the Tunnel's `wss://` lobby: the
  page tries WebTransport first where the browser has it.
- **Mobile data needs nothing special:** players behind carrier CGNAT are fine,
  because the client starts the connection. Only the _server_ needs a reachable
  public IP.

## Comparison

| Option              | Works with today's code                 | Cloudflare plan           | Rough cost            | Latency                               |
| ------------------- | --------------------------------------- | ------------------------- | --------------------- | ------------------------------------- |
| 1 Tunnel            | **Yes** (WebSocket, #161)               | Free                      | Free                  | +PoP detour, TCP HOL                  |
| 2 Spectrum UDP      | Yes                                     | Spectrum Enterprise       | Unpublished (sales)   | Best                                  |
| 3 Durable Objects   | No: de-globalising the engine           | Free (limits bite) / Paid | Cents/evening on Paid | DO placement, TCP HOL                 |
| 3b Containers       | No: lobby rework                        | Workers Paid              | ~$5–6/month light use | Placement/cold start unknown, TCP HOL |
| 4 Realtime TURN/SFU | No: WebRTC driver + Deno WebRTC lib     | Free tier 1,000 GB        | Free at this scale    | Direct/relay, no HOL                  |
| 5 Hybrid (Mac/VPS)  | **Yes** (WebTransport, with `?server=`) | Free (DNS only)           | Free / VPS few $      | Direct UDP                            |

## Recommended path and next steps

1. **Run the Tunnel route** (option 1) as server/README.md describes: the lobby
   with `-wsport`, and an `^/mp/` ingress rule ahead of the static site. Test on
   desktop, then from a phone on mobile data, with `?transport=ws` on browsers
   that have WebTransport.
2. **If stalls under loss matter, add the hybrid on the home Mac** for
   WebTransport players:
   - Check the router's WAN IP is public (no CGNAT).
   - Forward UDP 4433–4443.
   - Add a DNS-only `mp` record.
   - Issue a Let's Encrypt cert via DNS-01 with a zone-scoped API token.
   - Run `deno task lobby` with that cert, and play via
     `?server=https://mp.anglezarke.games:4433`.
   - Test on desktop, then from a phone on mobile data (outside the LAN).
   - Then test from a device on the home LAN, to check hairpin NAT.
3. **Move to Containers** to get the game off the Mac: the plan is in
   [always-on-hosting.md](always-on-hosting.md).

## Not verified

- Whether Tunnel _public hostnames_ carry WebSockets. The Tunnel FAQ says Tunnel
  supports them, but doesn't name public hostnames.
- Whether the Containers proxy bills each WebSocket message as a DO request
  (still open; see [always-on-hosting.md](always-on-hosting.md)).
- QUIC passthrough on Spectrum UDP, and Spectrum pricing.
- Whether the Free plan's 10 ms CPU limit applies to Durable Objects (still not
  documented).
- Container placement and cold-start latency for this image (the docs say cold
  starts are often 1–3 s).
- Settled in always-on-hosting.md: one room's memory (about 97 MB of heap and
  buffers after GC, about 195 MB RSS idle and up to 425 MB with 16 players),
  which rules out a DO per room, and room memory needs for a container.
- Deno WebRTC library viability.
- Firefox for Android WebTransport support, and how often UDP is blocked on the
  networks players use.
- The router's hairpin NAT and CGNAT status.
- The latency added by the Tunnel detour. Bandwidth per room is now measured in
  always-on-hosting.md.
