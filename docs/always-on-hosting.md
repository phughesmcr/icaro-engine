# Always-on multiplayer hosting

Research notes, 2026-11-25. The goal: multiplayer that runs without the
maintainer's Mac being on or connected, preferably on Cloudflare. This
supersedes the recommendation in
[cloudflare-multiplayer.md](cloudflare-multiplayer.md) (a Cloudflare Tunnel
to the home Mac), which still describes the transports and the options that
need a home machine. Nothing was deployed and no account was created.

Tags, as in that doc:

- **[docs]**: read on the cited official page on 2026-11-25.
- **[search]**: seen only in search-result snippets.
- **[measured]**: measured here with the tools below.
- **[unverified]**: inference or estimate. Check it before relying on it.

## Recommendation

**Run each room in a Cloudflare Container, with the lobby as a Worker plus a
Durable Object.** One container per room starts when someone creates or
joins the room and stops when the room's idle timeout makes the process
exit. So the game is always *reachable* without anything always *running*,
and nothing depends on the Mac.

- **Why not a Durable Object per room:** a room needs about 97 MB of heap and
  buffers after a full GC, and more at peak [measured], against a 128 MB
  isolate limit that instances of the same class can share [docs]. The
  engine keeps its state in module globals, so two rooms can't share an
  isolate either. Fitting would mean trimming the server build *and*
  de-globalising `src/`. That is a large refactor for a saving of about
  $3/month over Containers at this scale.
- **Why Containers over a VPS:** it is Cloudflare-hosted, there is no machine
  to patch or certificate to renew, and idle rooms cost nothing. It costs
  about $6–10/month at "a few rooms, a handful of players", most of it the
  Workers Paid minimum. It needs a moderate amount of new code (see the plan
  below), and players lose WebTransport: Cloudflare can only carry the
  WebSocket transport.
- **Fallback, and the zero-code option:** today's lobby on a small VM (about
  €5.50–$9/month) runs unchanged, keeps WebTransport for browsers that
  have it, and can be up the same day. Pick this if WebTransport's
  unreliable datagrams matter more than staying on Cloudflare, or if the
  Containers spike (step 1 of the plan) turns up a blocker.

## What a room needs at runtime

`server/lobby_server.js` (one process) spawns one `server/game_server.js`
Deno process per room through `server/room_process_manager.ts`. A room:

- **Imports most of `src/`.** Server modules import client and renderer
  modules, so the whole engine graph loads, with `three` mapped to
  `server/browser_shim.js`. That costs about 31 MB of heap before anything
  runs [measured].
- **Deno APIs:** `Deno.args`, `Deno.exit` and `Deno.stdin` (status lines to
  the lobby on stdout; exit when the lobby's stdin closes); `Deno.readFile`,
  `Deno.statSync` and `Deno.openSync` in `src/pak.js`; `Deno.serve` and
  `Deno.upgradeWebSocket` (WebSocket driver); `Deno.QuicEndpoint` and
  `Deno.upgradeWebTransport` under `--unstable-net` (WebTransport driver).
  `src/` itself only touches Deno in `pak.js` and `Sys_IsDeno`.
- **Game data:** `static/pak0.pak` (18.7 MB) is read whole into memory; only
  paks over 64 MB (`COM_LAZY_PAK_SIZE`) are read lazily from disk. Loose
  files (custom maps) are read from `static/` on demand.
- **Startup requirements:** `-cert`/`-key` are mandatory, because the room
  always opens a WebTransport listener and exits if it can't. A
  WebSocket-only room needs a small change (plan step 3).
- **Timers:** one `setInterval` at `sys_ticrate` (50 ms, 20 Hz) plus a 5 s
  watchdog. `Sys_FloatTime` is `performance.now()`.
- **Startup time:** about 120–130 ms from the start of the main module to the
  first tick (pak load and `SV_SpawnServer`), plus Deno's own start
  [measured].

## Measurements

Tools added for this (not part of the game or CI, not linted):

- `tools/room_bench.js` starts a real `game_server.js` room and connects
  headless bots over WebSocket through the real client driver
  (`src/net_websocket.js`). Each bot completes the signon, then sends a
  `clc_move` at 72 Hz (as `host_maxfps`) with `clc_delta` acks: it runs,
  turns, strafes, jumps now and then, fires constantly and switches weapons
  every few seconds. `tools/room_bench_preload.js` is preloaded into the room
  and reports its memory, CPU time and the wall time of each tick.
- `tools/room_memory_probe.js` runs the room's init stages without
  networking and records memory after a forced GC at each stage.

Hardware: Apple M4 Pro, Deno 2.9.8. A shared cloud vCPU is slower than one
M4 Pro core; budget about 2× the CPU figures below [unverified]. Each row is
a 30 s window after an 8 s warm-up, one run each, nothing else running.
Bandwidth counts WebSocket payload bytes only (add TCP/IP and TLS overhead).

MATRIX_TABLE

What the numbers say:

MATRIX_NOTES

### Memory by stage (after a forced GC)

`deno run -A --v8-flags=--expose-gc tools/room_memory_probe.js <map>`:

| Stage | JS heap | Off-heap (ArrayBuffers) | Heap + off-heap | Process RSS |
|---|---|---|---|---|
| Empty Deno | 2.0 MB | 0.3 MB | 2.3 MB | 28 MB |
| Engine modules imported | 31.3 MB | 6.4 MB | 37.8 MB | 82–85 MB |
| Subsystems initialised (16 client slots) | 31.6 MB | 7.1 MB | 38.7 MB | 83–87 MB |
| `pak0.pak` loaded | 31.7 MB | 24.9 MB | 56.6 MB | 122–126 MB |
| Map spawned (`start` / `e1m1` / `e1m3`) | 60.8–61.1 MB | 35.4–37.0 MB | 96.2–97.9 MB | 253–256 MB |

`SV_SpawnServer` took 82–93 ms on these maps. Spawning adds about 29 MB of
heap and 11 MB of buffers. The server loads every precached model as the
client would (alias models are meshed for rendering, for example), so a
server-only build could probably shed part of that and of the 31 MB of
imported modules [unverified]. Process RSS includes Deno's own runtime and
V8's reserved heap, so it is the number that matters for a container or VM;
heap plus off-heap is the number that matters for a Workers isolate.

The lobby on its own, idle, uses about 35 MB RSS [measured].

## Options

### A. Durable Object per room

**Verdict: not feasible without a large refactor, and not worth it.**

- **Memory:** "Each isolate can consume up to 128 MB of memory, including the
  JavaScript heap and WebAssembly allocations" [docs]
  ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/)).
  The page doesn't say whether ArrayBuffers count; assume they do. A room
  settles at about 97 MB and peaks higher under load (see the table), so
  one room alone is marginal. Going over doesn't fail one allocation: the
  isolate is replaced [docs], which drops every WebSocket in it.
- **Isolate sharing:** the DO pricing page bills instances that share an
  isolate as 128 MB each [docs]
  ([DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)),
  so instances of one class do share isolates. Two rooms in one isolate would
  share `src/`'s module globals (`sv`, `svs`, the progs VM, edicts) and
  corrupt each other, and would need about 200 MB.
  - Bundling the engine as a factory (one copy of the module state per call)
    would fix the globals without touching `src/`, but doubles memory per
    room in a shared isolate, so it doesn't help [unverified].
- **Runtime:** `Date.now()` "does not advance during code execution" [docs]
  ([security model](https://developers.cloudflare.com/workers/reference/security-model/));
  whether `performance.now()` behaves the same isn't stated. `Sys_FloatTime`
  only needs time between ticks, so this is probably fine, but the tick
  timing above couldn't be measured in a DO [unverified].
- **CPU:** 30 s per invocation by default, reset by every incoming message
  [docs] ([DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/)).
  How `setInterval` callbacks are metered isn't documented, and neither is
  whether the Workers Free plan's 10 ms applies to SQLite-backed DOs.
- **Lifecycle:** timers and the standard WebSocket API keep a DO from
  hibernating, but DOs still restart for code and runtime updates, and
  WebSockets are dropped then [docs]
  ([lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)).
  A game in progress would end, as with any server restart.
- **Data:** a static asset may be up to 25 MiB, so the pak fits as an asset;
  the Worker's global scope must start within 1 s [docs]. The engine would
  load the pak at the first request, not at startup.
- **Cost (if it worked):** incoming WebSocket messages are billed 20:1,
  outgoing are free, and an accepted WebSocket bills duration at 128 MB for
  as long as it's open [docs]. Four players at 72 moves/s are 288
  messages/s, about 14 billed requests/s. On the Free plan's 100 k
  requests/day that is about 2 hours of play a day. On Paid it is about
  $1.70/month for 240 room-hours, on top of the $5 minimum.
- **Spike not done:** `wrangler dev` runs workerd locally, and no Cloudflare
  page says it enforces the 128 MB or CPU limits, so a local spike would only
  show that the APIs work, not that a room fits. The measured memory already
  answers the question that matters.

### B. Cloudflare Containers, one per room (recommended)

**Verdict: the Cloudflare option that keeps the engine as it is.**

- **Status and plan:** generally available since 2026-04-13 [search],
  Workers Paid only [docs] ([Containers](https://developers.cloudflare.com/containers/)).
- **Instance size:** `lite` (1/16 vCPU, 256 MiB) is too small: an idle room
  is about 195 MB RSS and a busy one 350 MB. Use **`basic` (1/4 vCPU,
  1 GiB, 4 GB disk)** [docs] ([pricing](https://developers.cloudflare.com/containers/pricing/)).
  Its CPU share is enough for rooms of up to about 8 players; for 16, use
  `standard-1` (1/2 vCPU, 4 GiB) [unverified: see the CPU column].
- **Traffic path:** "A Container can only be accessed through its Durable
  Object" [docs]
  ([architecture](https://developers.cloudflare.com/containers/platform-details/architecture/)).
  A WebSocket upgrade goes Worker → the room's DO → the container's port.
  There is no inbound UDP, so WebSocket only.
- **Lifecycle:** cold starts are "often in the 1-3 second range"; there is no
  maximum runtime; Cloudflare picks the location when the DO starts the
  container, and you can only constrain the jurisdiction [docs]
  ([FAQ](https://developers.cloudflare.com/containers/faq/)). The room's own
  idle timeout (300 s by default) ends the process, which stops the
  container.
- **Billing:** memory and disk for the time the container runs, CPU only when
  active, and each container's DO at DO rates [docs]. Whether every
  proxied WebSocket message counts as a DO request isn't documented; the
  costs below assume it does.
- **Latency:** player → nearest Cloudflare location → Worker → DO → container,
  which Cloudflare places near the request and its cached images. No region
  can be chosen. Measure it after the spike; don't assume UK-local
  [unverified].
- **Transport cost:** TCP head-of-line blocking on a lossy link; see
  [cloudflare-multiplayer.md](cloudflare-multiplayer.md#the-websocket-driver-used-by-options-1-3-and-3b).

### C. A small always-on VM or Fly.io machine (fallback)

**Verdict: zero code changes, keeps WebTransport, but it's a server to run.**

- **Fit:** the lobby (35 MB) plus each room (about 200–350 MB RSS). 1 GB holds
  the lobby and three small rooms; 2 GB is comfortable [measured, plus
  estimate].
- **Prices** (ex VAT, as listed on 2026-11-25):
  - Hetzner CPX02, 1 vCPU / 1 GB, €5.49 including IPv4; Germany and Finland,
    no UK [docs] ([Hetzner](https://www.hetzner.com/cloud/regular-performance)).
    The cheaper 2 vCPU / 4 GB CX23 and CAX11 plans were marked unavailable.
  - DigitalOcean 1 GB, $6, London [docs]
    ([DigitalOcean](https://www.digitalocean.com/pricing/droplets)).
  - Vultr 1 GB, about $5, London and Manchester [search].
  - Fly.io shared-cpu-1x 1 GB, $6.70 (iad) to $7.73 (fra); UDP needs a
    dedicated IPv4 at $2/month and a bind to `fly-global-services` [docs]
    ([pricing](https://docs.fly.io/about/pricing),
    [UDP](https://docs.fly.io/networking/udp-and-tcp)). The QUIC listener
    binds `[::]` today, so Fly's WebTransport needs a bind-address option
    [unverified].
  - Oracle Always Free is $0, but it reclaims instances whose 95th-percentile
    CPU stays under 20% for 7 days [docs]
    ([Oracle](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)),
    which a mostly idle game server would be.
- **Setup:** as option 5 of
  [cloudflare-multiplayer.md](cloudflare-multiplayer.md#5-hybrid-cloudflare-for-the-web-game-servers-elsewhere),
  with the VM in place of the Mac: open UDP 4433–4443 and the WebSocket TCP
  port, a DNS-only `mp` record, a Let's Encrypt certificate by DNS-01,
  `deno task lobby` under systemd. A second, proxied hostname can carry the
  WebSocket lobby through Cloudflare. Copy only `static/pak0.pak`.
- **Latency:** direct UDP from players to a London or Frankfurt VM, the best
  of the three [unverified].

## Costs

Scenarios: **light** = one 4-player room for 2 hours a day (60 room-hours a
month); **regular** = two 4-player rooms for 4 hours a day (240
room-hours). CPU assumes 0.1 vCPU per 4-player room (the measured ~5% of an
M4 Pro core, doubled). All figures in USD per month [unverified estimates
from the [docs] prices above].

| | Light | Regular | Notes |
|---|---|---|---|
| **Containers** (`basic`) | ~$5.65 | ~$10.10 | $5 Workers Paid minimum; memory $0.32 / $1.94; CPU $0 / $1.28; disk ~$0 / $0.19; DO requests $0.31 / $1.71 if each proxied message counts (else ~$8.40 regular) |
| **DO per room** (if it fitted) | ~$5.30 | ~$6.70 | Paid; duration inside the 400 k GB-s included; requests as above |
| **VM** | $5–9 flat | $5–9 flat | the same whether rooms run or not |

Egress is negligible everywhere: 16 busy players are about 85 KB/s, or about
0.3 GB an hour [measured], against 1 TB included on Containers.

**Lever:** the client sends a `clc_move` every client frame (up to 72 Hz).
On WebSocket, where per-message billing applies, sending moves at the server
tick rate (20 Hz) instead would cut the request count by about 3.5×.
Prediction already works on whole ticks, but this changes how input feels,
so it would need testing [unverified].

## Plan: rooms on Cloudflare Containers

Each step is its own PR against `dev`, except where noted.

1. **Paid spike (needs your go-ahead: Workers Paid, $5/month).** Deploy one
   container running a room with the shareware pak and a Worker that proxies
   `/room/<id>` WebSocket upgrades to it. Settle what the docs don't say:
   - whether each proxied WebSocket message is billed as a DO request
     (Cloudflare dashboard metrics after a 4-bot run of `tools/room_bench.js`
     pointed at the deployed room);
   - cold start from the first request to the first tick;
   - round-trip time from the UK (the HUD ping) and where the container ran
     (`cf-ray` / the colo in the request);
   - that an open WebSocket keeps the container running past its inactivity
     timeout.
2. **Container image** (`server/Dockerfile`, new): a pinned Deno image, then
   `COPY` an explicit allowlist: `deno.json`, `server/`, `src/` and
   `static/pak0.pak`. Never `COPY static/` whole: registered and rerelease
   data must not reach Cloudflare's registry. Add a `.dockerignore` that
   excludes everything except the allowlist as a second guard, and a CI
   check that fails if the image contains any other `.pak`.
3. **WebSocket-only rooms** (`server/game_server.js`): make the WebTransport
   listener optional (for example, skip it when no `-port`/`-cert` is
   given, or add `-nowt`), so a room starts without a certificate. Listen
   with `-wshost 0.0.0.0` inside the container. Add tests next to
   `tests/game_server_args_test.js`.
4. **Client address in rooms** (`server/client_address.ts`): inside a
   container, the peer is Cloudflare's network, not loopback, so the room
   needs to trust a header the room DO sets (for example `cf-connecting-ip`
   forwarded by the DO, or `?ip=` as the lobby proxy does today). Only the
   DO can reach the container, so trusting it is safe [docs: "only through
   its Durable Object"].
5. **Lobby as a Worker** (new `cloudflare/` directory: `worker.js`,
   `wrangler.jsonc`):
   - `/mp/lobby`: accept the WebSocket and speak the existing framed
     `LOBBY_LIST`/`LOBBY_CREATE`/`LOBBY_JOIN` protocol, so
     `src/net_websocket.js` needs no change. Reuse `parseCreateConfig`,
     the room id rules and the per-IP limits from `lobby_server.js` by moving
     them into a module both can import.
   - A singleton **lobby DO** holds the room registry (id, map, options,
     player count, owner IP) and the rate limits that today live in memory.
   - `/mp/room/<id>`: route to the **room DO** (`getByName(id)`), which
     starts the container with the room's arguments (map, max players, game
     options, `-idletimeout`) and forwards the upgrade.
   - The room DO counts its open player connections and reports them to the
     lobby DO, instead of parsing the room's stdout status lines; when the
     container exits (the idle timeout), it removes the room.
   - `room_process_manager.ts` and the per-room port range aren't used
     there; keep them for the self-hosted lobby.
6. **Client transport default** (`src/net_main.js`, `NET_UseWebSocket`): off
   localhost and without `?server=`, the WebTransport default lobby is
   `https://localhost:4433`, which can't work on a public page. Use
   WebSocket there, so players don't need `?transport=ws`. Keep
   `?transport=wt` and `?server=https://...` for a self-hosted lobby.
7. **Static site:** keep serving the client as today, or move it to Workers
   static assets. Either way, deploy from an allowlist, never the working
   tree (see the pak warning in
   [cloudflare-multiplayer.md](cloudflare-multiplayer.md#5-hybrid-cloudflare-for-the-web-game-servers-elsewhere)).
8. **Docs:** a deploy section in `server/README.md` (wrangler commands,
   secrets, the allowlist), and the new commands in AGENTS.md.

Steps 2–4 and 6 are small and also help the VM option; step 5 is the bulk of
the work.

## Not verified

- Whether each WebSocket message proxied to a container is billed as a DO
  request.
- Container cold start for this image, placement for UK players, and the
  round-trip time through Worker → DO → container.
- Whether an open, proxied WebSocket keeps a container from being stopped.
- Whether ArrayBuffers count toward the 128 MB isolate limit, and how DO
  timer callbacks are metered for CPU.
- Whether a server-only build could shed enough memory to fit a room in a
  DO; the memory-by-stage table suggests where to look.
- CPU on a real cloud vCPU (the figures above are from an M4 Pro).
- Fly.io's UDP with QUIC/WebTransport, and its `lhr` prices.
- Whether a 20 Hz client move rate on WebSocket feels the same in play.
