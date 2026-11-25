# Icaro Engine Dedicated Server

Headless multiplayer server for Icaro Engine built on Deno and WebTransport (HTTP/3 over QUIC), with an optional WebSocket transport (`-wsport`) for browsers without WebTransport and for HTTP-only proxies such as a Cloudflare Tunnel.

The live server uses a two-tier multi-process architecture:

- **`lobby_server.js`** handles room listing, creation, and joining on port `4433`, spawning isolated room processes via `room_process_manager.ts`.
- **`game_server.js`** runs a full Quake dedicated server per room (or standalone) by importing the engine modules directly from `../src/` — including the QuakeC VM (`progs.dat`), BSP collision, physics (`SV_Physics`), entity synchronization, and full Quake network protocol.

## Requirements

- [Deno](https://deno.land/) with `--unstable-net` support (`Deno.QuicEndpoint` / `Deno.upgradeWebTransport`)
- `pak0.pak` from Quake (shareware `static/pak0.pak` is included in the repository). A registered `pak1.pak` next to it is loaded too (for lobby-spawned rooms, only when it is under `static/`; see below).
- TLS certificates (required by WebTransport / HTTP/3)

## Quick Start

### 1. Generate TLS Certificates (Development)

For local development, generate self-signed certificates:

```bash
cd server
openssl req -x509 -newkey rsa:4096 -keyout key.pem -out cert.pem -days 365 -nodes -subj "/CN=localhost"
```

The repository's `.gitignore` excludes `*.pem`, so these files are never committed. Don't rename them to something it doesn't cover.

### 2. Run a Standalone Game Server

From the repository root:

```bash
deno task game
```

which runs:

```bash
deno run '--allow-net=[::]:4433,0.0.0.0:4433,127.0.0.1:4433' --allow-read=static,server/cert.pem,server/key.pem --unstable-net \
  server/game_server.js -cert server/cert.pem -key server/key.pem -pak static/pak0.pak -map start -wsport 4433
```

`-wsport 4433` adds a plain `ws://127.0.0.1:4433` WebSocket listener (TCP) beside the WebTransport one (UDP) on the same port number.

Running from the repository root picks up the root `deno.json`, which maps `"three"` to `server/browser_shim.js` so the engine modules in `src/` can run headlessly in Deno. (Pass `--config deno.json` if you run it from elsewhere.)

### 3. Run the Lobby Server (Multi-Room)

From the repository root:

```bash
deno task lobby
```

which runs:

```bash
deno run '--allow-net=[::]:4433,0.0.0.0:4433,127.0.0.1:4433,127.0.0.1:4434,127.0.0.1:4435,127.0.0.1:4436,127.0.0.1:4437,127.0.0.1:4438,127.0.0.1:4439,127.0.0.1:4440,127.0.0.1:4441,127.0.0.1:4442,127.0.0.1:4443' \
  --allow-read=server/cert.pem,server/key.pem --allow-run=deno --unstable-net \
  server/lobby_server.js -cert server/cert.pem -key server/key.pem -pak static/pak0.pak -wsport 4433
```

The lobby server listens on port `4433` and spawns `game_server.js` child processes on ports `4434`–`4443` (up to 10 concurrent rooms), using the same Deno binary as the lobby (`Deno.execPath()`, override with `-deno <path>`). With `-wsport 4433` it also serves WebSocket clients on `ws://127.0.0.1:4433` and gives each room a loopback WebSocket listener on the room's port, which the lobby proxies to (see [WebSocket transport](#websocket-transport)). The lobby still needs the cert and key: its WebTransport listener always runs.

### Permissions

The lobby and the rooms run with scoped permissions:

| Process | Flag | Scope | Why |
|---------|------|-------|-----|
| Lobby | `--allow-net` | `[::]:<lobby port>` and `0.0.0.0:<lobby port>` | QUIC listener (IPv6 and IPv4) |
| Lobby | `--allow-net` | `<ws host>:<ws port>`, and `127.0.0.1:4434` to `127.0.0.1:4443` (each listed) | With `-wsport`: the WebSocket listener, and the proxy's connections to the rooms |
| Lobby | `--allow-read` | the cert and key files | TLS |
| Lobby | `--allow-run` | the Deno binary | Spawning room processes |
| Room | `--allow-net` | `[::]:<room port>` and `0.0.0.0:<room port>`, plus `127.0.0.1:<room port>` when the lobby has `-wsport` | QUIC listener (IPv6 and IPv4), and the loopback WebSocket listener |
| Room | `--allow-read` | `static/`, the pak, the cert and key, and `rogue/`, `hipnotic/` or the `-game` directory in the pak's basedir when set | Game data and TLS |

The lobby builds the room flags itself (`room_process_manager.ts`). If you change `-port` or the cert/key paths, change the lobby's flags to match. `--allow-run=deno` resolves `deno` on `PATH` at startup; if that is a version-manager shim rather than the real binary, Deno will refuse to spawn rooms. Pass the binary's real path instead (`deno eval 'console.log(Deno.execPath())'`).

Quote the `--allow-net` value in a shell: zsh and bash treat `[::]` as a glob.

### Listening addresses

The lobby and the rooms listen on both IPv6 and IPv4 (`quic_listen.ts`), so `wts://localhost` works when the browser resolves `localhost` to `::1`. Each server binds `[::]` first, then tries `0.0.0.0` on the same port:

- On macOS and Linux, `[::]` is dual-stack and also accepts IPv4. The `0.0.0.0` bind then fails with "address in use", which is expected, and the startup line says `[::] (IPv6 and IPv4)`.
- Where `[::]` is IPv6-only (Windows, or Linux with `net.ipv6.bindv6only=1`), both binds succeed: `[::] (IPv6) and 0.0.0.0 (IPv4)`.
- Where IPv6 is unavailable (some containers), only `0.0.0.0 (IPv4 only)` is bound.

The server can't tell a dual-stack `[::]` from another process already holding `0.0.0.0` on the same port. In that case it still starts, and IPv4 clients reach the other process, so keep the lobby and room ports free.

Both `--allow-net` grants are needed in every case: a missing grant fails startup rather than silently dropping one address family. Clients connecting over IPv4 show up as plain IPv4 addresses (`127.0.0.1`, not `::ffff:127.0.0.1`), so the per-IP limits are unchanged for them.

## Command Line Options

### `lobby_server.js`

| Option | Default | Description |
|--------|---------|-------------|
| `-port <port>` | `4433` | Lobby WebTransport port (rooms spawn on `4434`–`4443`) |
| `-cert <path>` | `cert.pem` | TLS certificate file (forwarded to room servers) |
| `-key <path>` | `key.pem` | TLS private key file (forwarded to room servers) |
| `-pak <path>` | `../static/pak0.pak` | Path to `pak0.pak` (forwarded to room servers) |
| `-deno <path>` | `Deno.execPath()` | Deno binary used to spawn room servers |
| `-rogue`, `-hipnotic` | off | Mission pack for every room (forwarded to room servers) |
| `-game <dir>` | none | Game directory for every room, e.g. `mg1` (forwarded to room servers) |
| `-wsport <port>` | off | Also serve WebSocket clients on this TCP port (`<prefix>/lobby` and `<prefix>/room/<id>`), and start rooms with a loopback WebSocket listener |
| `-wshost <addr>` | `127.0.0.1` | WebSocket listen address. Keep the default behind a local proxy (cloudflared); the lobby only trusts `CF-Connecting-IP` from loopback peers |
| `-wstls` | off | Serve `wss://` with `-cert`/`-key` instead of plain `ws://` |

### `game_server.js`

| Option | Default | Description |
|--------|---------|-------------|
| `-port <port>` | `4433` | WebTransport port |
| `-maxclients <num>` | `4` | Maximum players (clamped to 1–16) |
| `-map <name>` | `start` | Starting map |
| `-pak <path>` | `../static/pak0.pak` | Path to `pak0.pak` |
| `-rogue`, `-hipnotic` | off | Mission pack, as WinQuake's flags: also loads `rogue/pak0.pak` or `hipnotic/pak0.pak` (and later paks) from the basedir, searched first. The basedir is the `-pak` file's directory, or its parent when that directory is `id1` (as in C and the 2021 rerelease, `-pak ../static/rerelease/id1/pak0.pak`). Browser clients must use the matching `?game=` (and `?base=rerelease`) |
| `-game <dir>` | none | The C `-game`: also loads `<basedir>/<dir>/pak0.pak` (and later paks), searched first, e.g. the rerelease's `mg1`. A single directory name only |
| `-coop <0\|1>`, `-teamplay <n>`, `-skill <n>`, `-fraglimit <n>`, `-timelimit <n>` | off (cvar defaults) | The Game Options values the lobby forwards from a room request, set as cvars before the map spawns. Clamped to the menu's ranges (teamplay 0–2, or 0–6 with `-rogue`; skill 0–3; fraglimit 0–100; timelimit 0–60); only the options given are set. `-coop 1` turns `deathmatch` off |
| `-cert <path>` | `cert.pem` | TLS certificate file |
| `-key <path>` | `key.pem` | TLS private key file |
| `-room <id>` | `null` | Room ID assigned by `lobby_server.js` (enables room idle-exit tracking) |
| `-direct` | `false` | Direct connection mode flag (no effect; kept for compatibility) |
| `-idletimeout <sec>` | `300` | Room mode: seconds with no players before the server exits, counted from startup or from when the last player left |
| `-statusnonce <token>` | none | Room mode: emit `@@ICARO_STATUS <token> {...}` status lines on stdout for the lobby |
| `-parentwatch` | off | Exit when stdin closes. The lobby passes this so rooms exit when the lobby dies |
| `-wsport <port>` | off | Also accept game clients over WebSocket on this TCP port. A room started by the lobby gets its own port here |
| `-wshost <addr>` | `127.0.0.1` | WebSocket listen address |
| `-wstls` | off | Serve `wss://` with `-cert`/`-key` instead of plain `ws://` |
| `-nowt` | off | No WebTransport listener: WebSocket only. Needs `-wsport`; without `-wstls` no cert or key is read and `--unstable-net` isn't needed. Not for rooms the lobby starts: it waits for the WebTransport listener's startup line (see [WebSocket-only rooms](#websocket-only-rooms)) |
| `-trustproxy` | off | Take the client's address from `CF-Connecting-IP`, then `?ip=`, whatever the peer, not only from loopback. Only for a listener that nothing but the proxy can reach (see [WebSocket-only rooms](#websocket-only-rooms)) |

## Connecting from Browser

- **Multiplayer menu (lobby mode):** Queries `lobby_server.js` on port `4433` to list, create, or join rooms, then connects directly to the assigned room's `game_server.js` port (`4434`–`4443`). A WebSocket client instead connects to the lobby's `<prefix>/room/<id>` path, which the lobby proxies to the room, so only the lobby's port needs to be reachable. Joining a valid 6-character shared room code for an expired room re-creates it, subject to the same limits as creating a room.
- **Rooms hosted in browsers:** the WebSocket lobby also serves the lobby side of rooms that a player's tab hosts over WebRTC (`lobby_rtc.js`, shared with `cloudflare/lobby/`): a host registers with `LOBBY_HOST` and keeps its lobby socket open, joiners `LOBBY_JOIN` its 8-character code, and the lobby relays their signals. The lobby gives these clients STUN only; TURN credentials come from the Cloudflare lobby. The client side is not built yet (see `docs/browser-hosted-rooms.md`).
- **Direct console connection:** In the Icaro Engine console, connect directly to a `game_server.js` instance:

```text
connect wts://your-server.com:4433
```

Or for local development:

```text
connect wts://localhost:4433
```

WebTransport requires valid HTTPS/TLS certificates (and UDP access for QUIC on the lobby port plus room ports `4434`–`4443`). For local self-signed certificates, configure your browser to trust the cert or launch Chrome with `--ignore-certificate-errors-spki-list`.

### WebSocket transport

A browser without WebTransport uses WebSocket automatically. Page parameters choose otherwise:

| Parameter | Effect |
|-----------|--------|
| `?transport=ws` | Use WebSocket even where WebTransport exists |
| `?transport=wt` | Use WebTransport (when the browser has it) |
| `?server=wss://host/mp` | The lobby. A `ws://` or `wss://` URL implies WebSocket; an `https://` or `wts://` lobby is converted (`https` becomes `wss`). Only a plain host (and port), or for `ws`/`wss` a path of plain segments, is accepted: anything else is refused rather than quoted into a `connect` command (`Sys_ParseLobbyURL` in `src/sys.js`) |

Without `?server=`, a WebSocket client on a `localhost` page uses `ws://127.0.0.1:4433` (`deno task lobby`); a page on any other host uses `wss://<that host>/mp` (or `ws://` for an `http:` page), which is the Cloudflare Tunnel layout below. These parameters are kept in the page URL when a room code is added, so a shared link joins over the same transport.

In the console, `connect ws://127.0.0.1:4433` reaches a standalone `game_server.js -wsport 4433`, and `connect wss://host/mp?room=ABC123` joins a room through a lobby.

The lobby's WebSocket listener matches only the end of the request path, so it works under any prefix:

- `<prefix>/lobby`: one lobby request per connection, in the same `[type][length][payload]` frames as over WebTransport, one frame per WebSocket message.
- `<prefix>/room/<id>`: a game connection, relayed message for message to the room's own WebSocket listener on `ws://127.0.0.1:<room port>`. The lobby's room reply still carries the port, but WebSocket clients ignore it and always go through this path, so only the lobby's port needs to be reachable.
- Anything else, or a plain HTTP request, gets a short text reply.

Trade-off: WebSocket is one ordered TCP stream, so there are no unreliable datagrams. Each message starts with a channel byte (reliable or unreliable; see `WS_CHANNEL_*` in `../src/net.js`) so both sides keep Quake's split, but a lost TCP segment delays every later message (head-of-line blocking): on a lossy link the game stutters where WebTransport would drop the odd update. To stop stale updates piling up, senders drop unreliable messages while their socket is backed up, the server also drops them while the client is more than 20 packets (about a second) behind in acknowledging, and receivers deliver only the newest of consecutive queued unreliable messages.

### Cloudflare Tunnel

A Cloudflare Tunnel carries HTTP and WebSocket only, so players behind one use the WebSocket transport. Run the lobby with `-wsport` on the machine that runs `cloudflared`, and add an ingress rule that sends the `/mp/` path to it, **before** the rule that serves the static client. For a tunnel whose static site is `quake.example.com`:

```yaml
ingress:
  - hostname: quake.example.com
    path: ^/mp/
    service: http://127.0.0.1:4433
  - hostname: quake.example.com
    service: http://127.0.0.1:8080   # the static client (index.html), as before
  - service: http_status:404
```

`cloudflared` speaks plain HTTP to the origin and upgrades WebSocket requests itself, so the lobby needs no `-wstls`. Players then open:

```text
https://quake.example.com/                                    # WebSocket automatically where WebTransport is missing
https://quake.example.com/?transport=ws                       # force WebSocket (WebTransport cannot cross the tunnel)
https://quake.example.com/?server=wss://quake.example.com/mp  # explicit lobby
```

On a browser that has WebTransport, the page still tries WebTransport first unless `?transport=ws` or a `wss://` `?server=` is given, and WebTransport does not reach the lobby through the tunnel: `cloudflared` connects to the origin over HTTP/1.1, or HTTP/2 with `http2Origin` ([origin parameters](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/configure-tunnels/origin-parameters/)), and Cloudflare documents no WebTransport or HTTP/3 path to an origin. Share links with `?transport=ws`.

Notes:

- Keep `-wshost` at its default `127.0.0.1` so only `cloudflared` (and the lobby's own proxy) can reach the WebSocket listeners. The lobby takes the client's address from the `CF-Connecting-IP` header on loopback connections, for its per-IP limits, and passes it on to the room.
- The lobby still starts its WebTransport listener, so it still needs `-cert` and `-key` (a self-signed pair is enough when nobody connects over WebTransport).
- Nothing else needs a public port: the rooms' WebSocket listeners are loopback-only, and the lobby proxies to them.
- `cloudflared` forwards the full request path (`/mp/lobby`, `/mp/room/<id>`) without stripping the matched part, and `path` is a regular expression ([configuration file](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/configure-tunnels/local-management/configuration-file/)). The lobby matches only the end of the path, so the prefix can be anything.
- Cloudflare closes a WebSocket that carries no data for a while, and may close WebSockets when it restarts servers; stopping or restarting `cloudflared` drops them too ([WebSockets](https://developers.cloudflare.com/network/websockets/)). A game connection carries updates every frame, so it is not idle, and Deno pings each server-side socket after 30 s of silence (`Deno.upgradeWebSocket`'s `idleTimeout`). A dropped connection returns the player to the menu, and the room link (`?room=`) rejoins. Cloudflare documents no WebSocket message size limit; game messages are at most 8 KB.
- The lobby takes `CF-Connecting-IP` as the client address ([HTTP headers](https://developers.cloudflare.com/fundamentals/reference/http-headers/)). If a Managed Transform removes visitor IP headers, every tunnel client appears as `127.0.0.1` and shares one set of per-IP limits.

### WebSocket-only rooms

A room can run with only its WebSocket listener, for a host that carries no UDP or that has no certificate, such as a Cloudflare Container reached through its Durable Object ([always-on-hosting.md](../docs/always-on-hosting.md)). From the repository root:

```bash
deno run '--allow-net=0.0.0.0:8080' --allow-read=static server/game_server.js -nowt -wsport 8080 -wshost 0.0.0.0 -trustproxy -room ABC123 -pak static/pak0.pak -map start
```

- `-nowt` skips the WebTransport listener, so the room reads no cert or key (unless `-wstls`) and runs without `--unstable-net`. `-wshost 0.0.0.0` accepts the proxy's connections from outside the container.
- `-room` turns on the idle exit (`-idletimeout`). Without `-trustproxy`, a room trusts a forwarded address only from a loopback peer, as behind the lobby.
- `-trustproxy`: inside a container the peer is the platform's proxy, not loopback, so the room would see every player at the proxy's address and apply one set of per-IP limits to all of them. With it, the room takes `CF-Connecting-IP` from any peer, then `?ip=` only when there is no such header, so a client-supplied `?ip=` can't override it (a malformed header means the peer's address); a proxy that doesn't forward the header must set or overwrite `?ip=` itself.
- Use `-trustproxy` only when the proxy is the only way to reach the port. Anyone who can connect directly can claim any address and get round the per-IP limits.
- The lobby can't start these rooms: it waits for the "WebTransport server listening" line, which a `-nowt` room never prints. Its listener line is "WebSocket server listening on ...", followed by "Server initialized!" once the map has spawned.

## Architecture

### Transport & Protocol

- **WebTransport over HTTP/3 (QUIC)** via `Deno.QuicEndpoint` and `Deno.upgradeWebTransport`.
- **Lobby protocol (`lobby_server.js`)**: Single bidirectional stream per request using `[type:1][length:2][payload:N]` frames (`LOBBY_LIST`, `LOBBY_JOIN`, `LOBBY_CREATE`, `LOBBY_ROOMS`, `LOBBY_ERROR`). Requests over 4 KB are rejected.
- **Lobby limits** (`LIMITS` in `lobby_server.js`):
  - 64 concurrent lobby sessions, 8 per client IP.
  - Room creation (including re-creating a shared room on join) is limited to 3 per minute per IP and 10 per minute overall. Attempts whose room fails to start still count.
  - Each IP may have at most 3 live rooms.
  - With `-wsport`: at most 160 proxied WebSocket room connections, 16 per client IP (`maxProxies`, `maxProxiesPerIp`). WebSocket lobby requests count against the lobby session limits above.
  - `maxPlayers` is clamped to an integer from 1 to 16; `hostName` has control characters stripped and is capped at 32 UTF-8 bytes; map names must match `[A-Za-z0-9_]{1,32}`.
  - `LOBBY_CREATE` may carry `options`, the Game Options menu rows: `coop` (0-1), `teamplay` (0-2, 0-6 when the lobby serves Rogue), `skill` (0-3), `fraglimit` (0-100) and `timelimit` (0-60). Only these keys are read, only finite numbers are accepted, truncated to integers and clamped to those ranges; any other field or value is dropped and the room keeps its default. The room process gets them as `-coop N -teamplay N -skill N -fraglimit N -timelimit N` (only the ones given) and sets the cvars before its map spawns. A request without `options` starts the room as before.
- **Game transport (`net_webtransport_server.ts`)**:
  - **Bidirectional stream** (length-prefixed frames) for reliable Quake messages (signon data, string commands, score/name updates).
  - **WebTransport datagrams** (with serialized outbound writes and reliable-stream fallback on timeout/error) for unreliable messages (entity updates, clientdata, `clc_move`).
  - **Sequencing header** (`0x71`, 4-byte sequence, 4-byte ack) with separate reliable and datagram receive sequence lanes and transport-level acknowledgments for client prediction.
  - **Connect handshake** (defined in `../src/net.js`): the first reliable frame each way. The client sends `"ICARO"` plus a version byte (`WT_PROTOCOL_VERSION`, currently 1). The server replies `"ICARO"`, its version, a status byte (accept/reject) and a UTF-8 reason. A client slot is allocated only after a valid hello. A wrong version, missing datagram support or no free slot gets a reject with a reason (for example "Server is full"), which the client shows instead of a generic connect failure.
  - **Session limits** (NET-2), counted from QUIC accept until the transport closes. Sessions over a limit are closed without a handshake reply. The defaults can be changed with `WT_SetConfig`:

    | Option | Default | Meaning |
    |---|---|---|
    | `maxHandshakingSessions` | 16 | Sessions that have not been assigned a slot yet, across all clients |
    | `maxSessionsPerIp` | 8 | Live sessions per client IP; this also limits players behind one NAT |
    | `handshakeTimeoutMs` | 10000 | Time a session has to send a valid hello |
    | `pendingAcceptTimeoutMs` | 30000 | Time an accepted socket may wait for the engine to pick it up |
    | `closeFlushMs` | 1000 | Bounded wait for the last reliable frames (disconnect reason) on close |

  - **Startup failure**: `WT_Listen` resolves `false` if the listener can't bind its port or load the certificate, and `game_server.js` then exits with an error.

### Game Simulation (`game_server.js`)

- Runs headless in dedicated mode (`cls.state = ca_dedicated`) using the shared engine code in `src/`:
  - Full QuakeC VM (`PR_Init`, `progs.dat`)
  - Full server physics and collision (`SV_Physics`, `Mod_Init`, BSP hulls)
  - Full Quake client/server protocol (`SV_SpawnServer`, `SV_RunClients`, `SV_SendClientMessages`)
- Runs at `sys_ticrate` (default `0.05`s / 20 Hz) with `deathmatch 1` (`0` when the room is created with `coop` 1), `samelevel 2` and `noexit 1` (both `0` in a `coop` room, so its exits change the map).
- Loads `pak0.pak` and any `pak1.pak`, `pak2.pak`, ... in the same directory (stopping at the first missing one). Rooms spawned by the lobby can read extra paks only when they are under `static/`; otherwise the room prints a "Failed to load" read-permission error and continues with the paks it has. A pak over 64 MB is not read into memory: the room reads its directory, then each file from disk when it is loaded. Supports on-demand loose map files via `COM_EnsureFile`.
- In room mode, reports its player count to the lobby on a structured stdout status line (`@@ICARO_STATUS`), on every change and every 5s. It also emits `[Heartbeat]` log lines every 30s and `[WATCHDOG]` stderr ticks every 5s, which `room_process_manager.ts` uses to hide or terminate wedged processes.

### Room lifecycle

- A room counts as started once it has bound its port and spawned its map. A missing map or a port that is already in use fails room creation instead of listing a dead room.
- The lobby reaps rooms that have reported no players for 5 minutes, and rooms whose watchdog stops. Rooms that report players are never reaped as idle.
- A room exits by itself after `-idletimeout` seconds with no players (whether or not anyone ever joined), when its server shuts down after a `Host_Error`, or when the lobby goes away (its stdin pipe closes).
- On SIGINT, SIGTERM or SIGHUP the lobby sends SIGTERM to all rooms and exits; rooms that don't stop on SIGTERM still exit when their stdin closes. A room the lobby terminates while running (idle, wedged or failed startup) is killed with SIGKILL if it hasn't exited 5 seconds after SIGTERM. A room's port is only reused once its process has exited.
- The lobby logs its own operational lines unfiltered. Room processes keep the quiet allowlist (`__ICARO_QUIET_LOGS`), and the lobby relays what they print, except status and watchdog lines.

### Files

**Live server:**

- `lobby_server.js` — WebTransport (and, with `-wsport`, WebSocket) lobby server for room listing, creation, and joining; proxies WebSocket game connections to rooms
- `room_process_manager.ts` — Spawns, monitors, and cleans up isolated `game_server.js` room processes (ports `4434`–`4443`)
- `game_server.js` — Dedicated game server running the full Quake VM, physics, and protocol from `../src/`
- `net_webtransport_server.ts` — Deno WebTransport server network driver
- `net_websocket_server.ts` — Deno WebSocket server network driver (`-wsport`)
- `client_address.ts` — Client address behind a proxy (`CF-Connecting-IP`, the lobby proxy's `?ip=`): from loopback peers, or from any peer with `-trustproxy`
- `quic_listen.ts` — Binds the dual-stack (`[::]` and `0.0.0.0`) QUIC endpoints for the lobby and rooms
- `browser_shim.js` — Minimal `three` stubs mapped via `deno.json` for headless execution
- `headless_host.js` — Runs the whole game (host, local server and a client over the loopback driver) under Deno with no browser, WebGL or audio, for scripted play; its header shows how to start a map and step frames
- `sys_server.ts` — Deno system utilities and production log filtering (`__ICARO_QUIET_LOGS`)
- `deno.json` — Maps `"three"` to `browser_shim.js` when running from `server/` (the root `deno.json` does the same from the repository root)
- `Dockerfile` — The game-room image (see [Container Image](#container-image))

**Tests & utilities:**

- `../tests/net_webtransport_server_test.ts` — Unit tests for WebTransport packet sequencing (`deno task test` from the repository root)
- `../tests/net_webtransport_server_lifecycle_test.js` and `../tests/net_webtransport_client_lifecycle_test.js` — Handshake, session-limit, timeout and close-path tests for both drivers, run against in-memory transports (`../tests/fake_webtransport.js`, `../tests/webtransport_test_env.js`)
- `../tests/net_websocket_test.js` — WebSocket client and server drivers against each other over in-memory sockets (`../tests/fake_websocket.js`): handshake, rejects, acks, backpressure and close paths
- `../tests/headless_client_test.js` — `headless_host.js` loads e1m1 from the shareware pak, signs the client on and steps frames
- `../tests/quic_listen_test.ts` — IPv6/IPv4 bind fallback tests for `quic_listen.ts`
- `../tests/server_lobby_test.js` — Lobby and room-manager tests (`deno task test` from the repository root). The room-process tests need run access to `tests/fixtures/fake_room_server.sh`, write access and the `FAKE_ROOM_*` env vars (the task grants them), and are skipped without them.

## Container Image

`server/Dockerfile` builds a game-room image: one `game_server.js` room per container, for hosting rooms on Cloudflare Containers or a VM (see [always-on-hosting.md](../docs/always-on-hosting.md)). Build it from the repository root, so the root `.dockerignore` applies:

```bash
docker build -f server/Dockerfile -t icaro-room .
```

Cloudflare Containers run `linux/amd64`; on an Apple Silicon Mac add `--platform linux/amd64`.

The image is the pinned `denoland/deno` Debian image (the Deno version in `.tool-versions`) plus an allowlist: `deno.json`, `server/`, `src/` and `static/pak0.pak`. It never copies `static/` whole: registered and rerelease data (`static/pak1.pak`, `hipnotic/`, `rogue/`, `rerelease/`, `id1/`, `mg1/` and the other add-ons) must never reach an image or a registry. The root `.dockerignore` is a second guard: it excludes everything but the allowlist, then every `.pak` but `static/pak0.pak`, and TLS and env files. Keep both when you change either. The custom maps in `static/maps/` are not in the image, so a room can only start on maps in `pak0.pak`.

The entry point is `deno run` on `server/game_server.js -pak /app/static/pak0.pak`, as the unprivileged `deno` user. Arguments after the image name are passed on to it (see [`game_server.js` options](#game_serverjs)) and replace the defaults, `-map start -cert /certs/cert.pem -key /certs/key.pem -wsport 4433 -wshost 0.0.0.0`. The room can listen on any port of `0.0.0.0`, `[::]` and `127.0.0.1` and read `/app/static` and `/certs`. A room still needs a TLS certificate and key for its WebTransport listener; mount them at `/certs` at run time and never bake them into the image. The key must be readable by uid 1993. For example, with the development certificate from step 1:

```bash
docker run --rm -v "$PWD/server/cert.pem:/certs/cert.pem:ro" -v "$PWD/server/key.pem:/certs/key.pem:ro" \
  -p 4433:4433/tcp -p 4433:4433/udp icaro-room \
  -map e1m1 -maxclients 8 -cert /certs/cert.pem -key /certs/key.pem -wsport 4433 -wshost 0.0.0.0
```

`deno task image-check` (`tools/check_container_image.sh`, needs Docker) checks the build context of your working tree and of a copy with decoy paks and keys planted, builds the image, fails if it holds any `.pak` but `/app/static/pak0.pak` or any TLS or env file, and starts a room in it (`--no-run` skips that). CI runs it on PRs to `dev` and `main`. Run it before building an image from a working tree that has registered data in it. Nothing here pushes the image; publishing it is a later step of the hosting plan.

## Production Deployment

Use valid TLS certificates (e.g. Let's Encrypt) and open UDP ports `4433` (lobby) and `4434`–`4443` (room servers), for IPv6 as well as IPv4 if the host has an IPv6 address:

```bash
deno run --unstable-net \
  '--allow-net=[::]:4433,0.0.0.0:4433' \
  --allow-read=/etc/letsencrypt/live/your-domain.com/fullchain.pem,/etc/letsencrypt/live/your-domain.com/privkey.pem \
  --allow-run="$(command -v deno)" \
  /opt/icaro-engine/server/lobby_server.js \
  -port 4433 \
  -cert /etc/letsencrypt/live/your-domain.com/fullchain.pem \
  -key /etc/letsencrypt/live/your-domain.com/privkey.pem \
  -pak /opt/icaro-engine/static/pak0.pak
```

Rooms need to read `static/`, the pak, and the cert and key, so the user running the lobby must be able to read all of them.

The lobby only tells clients a room's port. The client reuses the host it reached the lobby on, so a remote client reaches its room over the same address family it used for the lobby.

## License

GPL v2 (same as original Quake source)
