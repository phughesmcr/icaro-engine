# Icaro Engine Dedicated Server

Headless multiplayer server for Icaro Engine built on Deno and WebTransport (HTTP/3 over QUIC).

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
deno run --allow-net=0.0.0.0:4433 --allow-read=static,server/cert.pem,server/key.pem --unstable-net \
  server/game_server.js -cert server/cert.pem -key server/key.pem -pak static/pak0.pak -map start
```

Running from the repository root picks up the root `deno.json`, which maps `"three"` to `server/browser_shim.js` so the engine modules in `src/` can run headlessly in Deno. (Pass `--config deno.json` if you run it from elsewhere.)

### 3. Run the Lobby Server (Multi-Room)

From the repository root:

```bash
deno task lobby
```

which runs:

```bash
deno run --allow-net=0.0.0.0:4433 --allow-read=server/cert.pem,server/key.pem --allow-run=deno --unstable-net \
  server/lobby_server.js -cert server/cert.pem -key server/key.pem -pak static/pak0.pak
```

The lobby server listens on port `4433` and spawns `game_server.js` child processes on ports `4434`–`4443` (up to 10 concurrent rooms), using the same Deno binary as the lobby (`Deno.execPath()`, override with `-deno <path>`).

### Permissions

The lobby and the rooms run with scoped permissions:

| Process | Flag | Scope | Why |
|---------|------|-------|-----|
| Lobby | `--allow-net` | `0.0.0.0:<lobby port>` | QUIC listener |
| Lobby | `--allow-read` | the cert and key files | TLS |
| Lobby | `--allow-run` | the Deno binary | Spawning room processes |
| Room | `--allow-net` | `0.0.0.0:<room port>` | QUIC listener |
| Room | `--allow-read` | `static/`, the pak, the cert and key, and `rogue/` or `hipnotic/` next to the pak when `-rogue` or `-hipnotic` is set | Game data and TLS |

The lobby builds the room flags itself (`room_process_manager.ts`). If you change `-port` or the cert/key paths, change the lobby's flags to match. `--allow-run=deno` resolves `deno` on `PATH` at startup; if that is a version-manager shim rather than the real binary, Deno will refuse to spawn rooms. Pass the binary's real path instead (`deno eval 'console.log(Deno.execPath())'`).

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

### `game_server.js`

| Option | Default | Description |
|--------|---------|-------------|
| `-port <port>` | `4433` | WebTransport port |
| `-maxclients <num>` | `4` | Maximum players (clamped to 1–16) |
| `-map <name>` | `start` | Starting map |
| `-pak <path>` | `../static/pak0.pak` | Path to `pak0.pak` |
| `-rogue`, `-hipnotic` | off | Mission pack, as WinQuake's flags: also loads `rogue/pak0.pak` or `hipnotic/pak0.pak` (and later paks) from the `-pak` file's directory, searched first. Browser clients must use the matching `?game=` |
| `-cert <path>` | `cert.pem` | TLS certificate file |
| `-key <path>` | `key.pem` | TLS private key file |
| `-room <id>` | `null` | Room ID assigned by `lobby_server.js` (enables room idle-exit tracking) |
| `-direct` | `false` | Direct connection mode flag (no effect; kept for compatibility) |
| `-idletimeout <sec>` | `300` | Room mode: seconds with no players before the server exits, counted from startup or from when the last player left |
| `-statusnonce <token>` | none | Room mode: emit `@@ICARO_STATUS <token> {...}` status lines on stdout for the lobby |
| `-parentwatch` | off | Exit when stdin closes. The lobby passes this so rooms exit when the lobby dies |

## Connecting from Browser

- **Multiplayer menu (lobby mode):** Queries `lobby_server.js` on port `4433` to list, create, or join rooms, then connects directly to the assigned room's `game_server.js` port (`4434`–`4443`). Joining a valid 6-character shared room code for an expired room re-creates it, subject to the same limits as creating a room.
- **Direct console connection:** In the Icaro Engine console, connect directly to a `game_server.js` instance:

```text
connect wts://your-server.com:4433
```

Or for local development:

```text
connect wts://localhost:4433
```

WebTransport requires valid HTTPS/TLS certificates (and UDP access for QUIC on the lobby port plus room ports `4434`–`4443`). For local self-signed certificates, configure your browser to trust the cert or launch Chrome with `--ignore-certificate-errors-spki-list`.

## Architecture

### Transport & Protocol

- **WebTransport over HTTP/3 (QUIC)** via `Deno.QuicEndpoint` and `Deno.upgradeWebTransport`.
- **Lobby protocol (`lobby_server.js`)**: Single bidirectional stream per request using `[type:1][length:2][payload:N]` frames (`LOBBY_LIST`, `LOBBY_JOIN`, `LOBBY_CREATE`, `LOBBY_ROOMS`, `LOBBY_ERROR`). Requests over 4 KB are rejected.
- **Lobby limits** (`LIMITS` in `lobby_server.js`):
  - 64 concurrent lobby sessions, 8 per client IP.
  - Room creation (including re-creating a shared room on join) is limited to 3 per minute per IP and 10 per minute overall. Attempts whose room fails to start still count.
  - Each IP may have at most 3 live rooms.
  - `maxPlayers` is clamped to an integer from 1 to 16; `hostName` has control characters stripped and is capped at 32 UTF-8 bytes; map names must match `[A-Za-z0-9_]{1,32}`.
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
- Runs at `sys_ticrate` (default `0.05`s / 20 Hz) with `deathmatch 1`, `samelevel 2`, and `noexit 1`.
- Loads `pak0.pak` and any `pak1.pak`, `pak2.pak`, ... in the same directory (stopping at the first missing one). Rooms spawned by the lobby can read extra paks only when they are under `static/`; otherwise the room prints a "Failed to load" read-permission error and continues with the paks it has. Supports on-demand loose map files via `COM_EnsureFile`.
- In room mode, reports its player count to the lobby on a structured stdout status line (`@@ICARO_STATUS`), on every change and every 5s. It also emits `[Heartbeat]` log lines every 30s and `[WATCHDOG]` stderr ticks every 5s, which `room_process_manager.ts` uses to hide or terminate wedged processes.

### Room lifecycle

- A room counts as started once it has bound its port and spawned its map. A missing map or a port that is already in use fails room creation instead of listing a dead room.
- The lobby reaps rooms that have reported no players for 5 minutes, and rooms whose watchdog stops. Rooms that report players are never reaped as idle.
- A room exits by itself after `-idletimeout` seconds with no players (whether or not anyone ever joined), when its server shuts down after a `Host_Error`, or when the lobby goes away (its stdin pipe closes).
- On SIGINT, SIGTERM or SIGHUP the lobby sends SIGTERM to all rooms and exits; rooms that don't stop on SIGTERM still exit when their stdin closes. A room the lobby terminates while running (idle, wedged or failed startup) is killed with SIGKILL if it hasn't exited 5 seconds after SIGTERM. A room's port is only reused once its process has exited.
- The lobby logs its own operational lines unfiltered. Room processes keep the quiet allowlist (`__ICARO_QUIET_LOGS`), and the lobby relays what they print, except status and watchdog lines.

### Files

**Live server:**

- `lobby_server.js` — WebTransport lobby server for room listing, creation, and joining
- `room_process_manager.ts` — Spawns, monitors, and cleans up isolated `game_server.js` room processes (ports `4434`–`4443`)
- `game_server.js` — Dedicated game server running the full Quake VM, physics, and protocol from `../src/`
- `net_webtransport_server.ts` — Deno WebTransport server network driver
- `browser_shim.js` — Minimal `three` stubs mapped via `deno.json` for headless execution
- `sys_server.ts` — Deno system utilities and production log filtering (`__ICARO_QUIET_LOGS`)
- `deno.json` — Maps `"three"` to `browser_shim.js` when running from `server/` (the root `deno.json` does the same from the repository root)

**Tests & utilities:**

- `../tests/net_webtransport_server_test.ts` — Unit tests for WebTransport packet sequencing (`deno task test` from the repository root)
- `../tests/net_webtransport_server_lifecycle_test.js` and `../tests/net_webtransport_client_lifecycle_test.js` — Handshake, session-limit, timeout and close-path tests for both drivers, run against in-memory transports (`../tests/fake_webtransport.js`, `../tests/webtransport_test_env.js`)
- `../tests/server_lobby_test.js` — Lobby and room-manager tests (`deno task test` from the repository root). The room-process tests need run access to `tests/fixtures/fake_room_server.sh`, write access and the `FAKE_ROOM_*` env vars (the task grants them), and are skipped without them.
- `test_imports.js` — Smoke check verifying Deno imports of `../src/` modules (`cd server && deno run --allow-read test_imports.js`)

## Production Deployment

Use valid TLS certificates (e.g. Let's Encrypt) and open UDP ports `4433` (lobby) and `4434`–`4443` (room servers):

```bash
deno run --unstable-net \
  --allow-net=0.0.0.0:4433 \
  --allow-read=/etc/letsencrypt/live/your-domain.com/fullchain.pem,/etc/letsencrypt/live/your-domain.com/privkey.pem \
  --allow-run="$(command -v deno)" \
  /opt/icaro-engine/server/lobby_server.js \
  -port 4433 \
  -cert /etc/letsencrypt/live/your-domain.com/fullchain.pem \
  -key /etc/letsencrypt/live/your-domain.com/privkey.pem \
  -pak /opt/icaro-engine/static/pak0.pak
```

Rooms need to read `static/`, the pak, and the cert and key, so the user running the lobby must be able to read all of them.

## License

GPL v2 (same as original Quake source)
