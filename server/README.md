# Three-Quake Dedicated Server

Headless multiplayer server for Three-Quake built on Deno and WebTransport (HTTP/3 over QUIC).

The live server uses a two-tier multi-process architecture:

- **`lobby_server.js`** handles room listing, creation, and joining on port `4433`, spawning isolated room processes via `room_process_manager.ts`.
- **`game_server.js`** runs a full Quake dedicated server per room (or standalone) by importing the engine modules directly from `../src/` — including the QuakeC VM (`progs.dat`), BSP collision, physics (`SV_Physics`), entity synchronization, and full Quake network protocol.

## Requirements

- [Deno](https://deno.land/) with `--unstable-net` support (`Deno.QuicEndpoint` / `Deno.upgradeWebTransport`)
- `pak0.pak` from Quake (shareware `static/pak0.pak` is included in the repository)
- TLS certificates (required by WebTransport / HTTP/3)

## Quick Start

### 1. Generate TLS Certificates (Development)

For local development, generate self-signed certificates:

```bash
cd server
openssl req -x509 -newkey rsa:4096 -keyout key.pem -out cert.pem -days 365 -nodes -subj "/CN=localhost"
```

### 2. Run a Standalone Game Server

From the `server/` directory:

```bash
deno run --allow-net --allow-read --unstable-net --config ../deno.json \
  game_server.js -cert cert.pem -key key.pem -pak ../static/pak0.pak -map start
```

Or from the repository root:

```bash
deno run --allow-net --allow-read --unstable-net --config deno.json \
  server/game_server.js -cert server/cert.pem -key server/key.pem -pak static/pak0.pak -map start
```

The `--config` flag maps `"three"` to `server/browser_shim.js` so the engine modules in `src/` can run headlessly in Deno.

### 3. Run the Lobby Server (Multi-Room)

```bash
deno run --allow-net --allow-read --allow-run --unstable-net \
  server/lobby_server.js -port 4433 -cert server/cert.pem -key server/key.pem -pak static/pak0.pak
```

The lobby server listens on port `4433` and spawns `game_server.js` child processes on ports `4434`–`4443` (up to 10 concurrent rooms).

> **Note:** `room_process_manager.ts` defaults its Deno binary path (`denoPath`) to `/root/.deno/bin/deno` for production Linux deployments. For local runs where `deno` lives elsewhere, adjust `denoPath` or configure it via `RoomManager_SetConfig`.

## Command Line Options

### `lobby_server.js`

| Option | Default | Description |
|--------|---------|-------------|
| `-port <port>` | `4433` | Lobby WebTransport port (rooms spawn on `4434`–`4443`) |
| `-cert <path>` | `/etc/letsencrypt/live/wts.mrdoob.com/fullchain.pem` | TLS certificate file (forwarded to room servers) |
| `-key <path>` | `/etc/letsencrypt/live/wts.mrdoob.com/privkey.pem` | TLS private key file (forwarded to room servers) |
| `-pak <path>` | `/opt/three-quake/static/pak0.pak` | Path to `pak0.pak` (forwarded to room servers) |

### `game_server.js`

| Option | Default | Description |
|--------|---------|-------------|
| `-port <port>` | `4433` | WebTransport port |
| `-maxclients <num>` | `4` | Maximum players |
| `-map <name>` | `start` | Starting map |
| `-pak <path>` | `../static/pak0.pak` | Path to `pak0.pak` |
| `-cert <path>` | `/etc/letsencrypt/live/wts.mrdoob.com/fullchain.pem` | TLS certificate file |
| `-key <path>` | `/etc/letsencrypt/live/wts.mrdoob.com/privkey.pem` | TLS private key file |
| `-room <id>` | `null` | Room ID assigned by `lobby_server.js` (enables room idle-exit tracking) |
| `-direct` | `false` | Direct connection mode flag |
| `-idletimeout <sec>` | `300` | Seconds empty before a room server exits (after at least one player has joined) |

## Connecting from Browser

- **Multiplayer menu (lobby mode):** Queries `lobby_server.js` on port `4433` to list, create, or join rooms, then connects directly to the assigned room's `game_server.js` port (`4434`–`4443`). Joining a valid 6-character shared room code for an expired room auto-creates it.
- **Direct console connection:** In the Three-Quake console, connect directly to a `game_server.js` instance:

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
- **Lobby protocol (`lobby_server.js`)**: Single bidirectional stream per request using `[type:1][length:2][payload:N]` frames (`LOBBY_LIST`, `LOBBY_JOIN`, `LOBBY_CREATE`, `LOBBY_ROOMS`, `LOBBY_ERROR`).
- **Game transport (`net_webtransport_server.ts`)**:
  - **Bidirectional stream** (length-prefixed frames) for reliable Quake messages (signon data, string commands, score/name updates).
  - **WebTransport datagrams** (with serialized outbound writes and reliable-stream fallback on timeout/error) for unreliable messages (entity updates, clientdata, `clc_move`).
  - **Sequencing header** (`0x71`, 4-byte sequence, 4-byte ack) with separate reliable and datagram receive sequence lanes and transport-level acknowledgments for client prediction.

### Game Simulation (`game_server.js`)

- Runs headless in dedicated mode (`cls.state = ca_dedicated`) using the shared engine code in `src/`:
  - Full QuakeC VM (`PR_Init`, `progs.dat`)
  - Full server physics and collision (`SV_Physics`, `Mod_Init`, BSP hulls)
  - Full Quake client/server protocol (`SV_SpawnServer`, `SV_RunClients`, `SV_SendClientMessages`)
- Runs at `sys_ticrate` (default `0.05`s / 20 Hz) with `deathmatch 1`, `samelevel 2`, and `noexit 1`.
- Loads `pak0.pak` from disk and supports on-demand loose map files via `COM_EnsureFile`.
- Emits `[Heartbeat]` logs every 30s and `[WATCHDOG]` stderr ticks every 5s so `room_process_manager.ts` can track player counts, hide or terminate wedged processes, and reap idle rooms.

### Files

**Live server:**

- `lobby_server.js` — WebTransport lobby server for room listing, creation, and joining
- `room_process_manager.ts` — Spawns, monitors, and cleans up isolated `game_server.js` room processes (ports `4434`–`4443`)
- `game_server.js` — Dedicated game server running the full Quake VM, physics, and protocol from `../src/`
- `net_webtransport_server.ts` — Deno WebTransport server network driver
- `browser_shim.js` — Minimal `three` stubs mapped via `deno.json` for headless execution
- `sys_server.ts` — Deno system utilities and production log filtering (`__THREE_QUAKE_QUIET_LOGS`)

**Tests & utilities:**

- `net_webtransport_server_test.ts` — Unit tests for WebTransport packet sequencing (`deno test server/net_webtransport_server_test.ts`)
- `test_imports.js` — Smoke check verifying Deno imports of `../src/` modules

**Legacy prototype (not used by the live server):**

- `main.ts`, `host_server.ts`, `pak_server.ts`, `mod_server.ts`, `rooms.ts`, `sys_deno.js` — Earlier standalone TypeScript server prototype superseded by `lobby_server.js` and `game_server.js`

## Production Deployment

Use valid TLS certificates (e.g. Let's Encrypt) and open UDP ports `4433` (lobby) and `4434`–`4443` (room servers):

```bash
deno run --allow-net --allow-read --allow-run --unstable-net \
  /opt/three-quake/server/lobby_server.js \
  -port 4433 \
  -cert /etc/letsencrypt/live/your-domain.com/fullchain.pem \
  -key /etc/letsencrypt/live/your-domain.com/privkey.pem \
  -pak /opt/three-quake/static/pak0.pak
```

## License

GPL v2 (same as original Quake source)
