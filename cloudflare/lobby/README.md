# Lobby Worker for rooms hosted in browsers

A Cloudflare Worker and one Durable Object that list rooms hosted in players'
browsers and relay their WebRTC signals. The design is
[docs/browser-hosted-rooms.md](../../docs/browser-hosted-rooms.md). The room
table and relay are `server/lobby_rtc.js`, shared with the Deno lobby
(`deno task lobby`), which serves the same protocol for local development.

This lobby can't start Deno rooms: it refuses `LOBBY_CREATE`, and a deployment
that points its `/mp/lobby` here lists only rooms hosted in browsers.

## Files

- `wrangler.jsonc`: the Worker, its Durable Object binding (`LOBBY`) and the
  SQLite migration the Free plan needs, and the `/mp/lobby` route. No assets:
  the game page is the client Worker's (`../client/`).
- `src/worker.js`: routes `<prefix>/lobby` to the Durable Object and upgrades
  the WebSocket. Workers-only code.
- `src/gate.js`: the checks before the Durable Object (path, upgrade, Origin,
  connection rate; see Abuse limits). `tests/cloudflare_lobby_gate_test.js`
  covers it.
- `src/lobby_core.js`: the Durable Object's logic: hibernation-safe session
  state, the alarm that drops silent hosts, TURN credentials.
  `tests/cloudflare_lobby_test.js` runs it under Deno with a fake `ctx`.

## Deploy

Always run wrangler **from this folder**. From the repository root, wrangler
takes the whole repository for a static site and offers to upload it, registered
game data in `static/` included.

```bash
cd cloudflare/lobby && npx wrangler deploy
```

The Worker is then at `https://icaro-lobby.<account>.workers.dev/lobby`, and at
`https://quake.anglezarke.games/mp/lobby`, the lobby the game page there uses by
default, through the route in `wrangler.jsonc`. Clients elsewhere reach it with
`?server=wss://icaro-lobby.<account>.workers.dev`. For another zone, change the
route's `pattern` and `zone_name`. The route needs a proxied DNS record for the
hostname; the client Worker's Custom Domain (`../client/`) is one. While a
Cloudflare Tunnel still serves that hostname, the route takes `/mp/lobby` from
it as soon as it is deployed, and the Deno lobby behind the tunnel stops
receiving lobby connections.

## TURN

Without TURN, clients get Cloudflare's STUN server only, and players behind NATs
that need a relay (many mobile networks) can't join. To hand out TURN
credentials, create a TURN key in the Cloudflare dashboard (Realtime, TURN),
then store its id and API token as secrets:

```bash
cd cloudflare/lobby && npx wrangler secret put TURN_KEY_ID
```

```bash
cd cloudflare/lobby && npx wrangler secret put TURN_KEY_API_TOKEN
```

The lobby mints credentials only for a client that has just hosted a room or
joined one, within the lobby's rate limits. They last 6 hours
(`TURN_TTL_SECONDS` overrides that), since a relay can't be refreshed once they
expire. If minting fails, clients get STUN only.

## Abuse limits

Three layers, from the edge in:

1. **The Worker** (`src/gate.js`) turns a request away before it wakes the
   Durable Object, so it costs no Durable Object request:
   - The page's `Origin` must be in `LOBBY_ORIGINS` (a var in `wrangler.jsonc`,
     comma-separated). Other sites' pages can't use this lobby, or its TURN
     relays, through their visitors' browsers. While the var is set, a request
     with no `Origin` (curl, a script's bare WebSocket) is refused too. A
     non-browser client could forge the header, so this only stops casual
     scripts; the limits below are what hold a determined one. Deno clients (the
     headless host, the agent MCP server) send no `Origin` and are refused, but
     lose nothing: this lobby serves only rooms hosted in browsers, and Deno has
     no WebRTC to join one. The Deno lobby (`deno task lobby`) doesn't use this
     gate. Leave the var empty to accept any request, or add
     `http://localhost:8137` to test a local page against the deployed lobby.
   - `LOBBY_CONNECT_LIMIT`, a Workers rate-limit binding: 30 lobby connections
     per IP per minute, then 429. Every room-list refresh, host and join is one
     connection.
2. **TURN minting.** `LOBBY_TURN_LIMIT`: 10 TURN credentials per IP per minute.
   Past it, a host or joiner gets STUN only, so a game can still start where no
   relay is needed. TURN is the one thing here billed by use (past the free
   allowance), and credentials are minted only after a `LOBBY_HOST` (behind
   Turnstile) or a `LOBBY_JOIN` for a live room.
3. **The Durable Object** (`server/lobby_rtc.js`, `RTC_LOBBY_LIMITS`): rooms
   hosted, joins and missed joins per IP per minute, and frames per socket.
   These live in its memory and start again when it hibernates, which is why the
   two bindings exist. The caps on open sockets, rooms and joiners per IP always
   hold, since they count live sockets.

The bindings' counts are approximate and kept per Cloudflare location. Many
players behind one address (a school, a mobile carrier's NAT) share a limit;
raise `limit` in `wrangler.jsonc` if they hit it. Each binding needs a
`namespace_id` unused elsewhere in the account. The code treats a missing or
failing binding as "allowed", so if a deploy refuses the `ratelimits` block (for
example, if the account's plan lacks the binding), removing it leaves the Origin
check and the Durable Object's limits in place.

A Cloudflare WAF rate-limiting rule is a fourth, optional layer, set in the
dashboard (Security, WAF, Rate limiting rules). The Free plan allows one rule,
counted per IP over 10 s. For example: requests matching
`starts_with(http.request.uri.path, "/mp/lobby")` on `quake.anglezarke.games`,
more than 20 in 10 s, block for 10 s.

## Turnstile

With the `TURNSTILE_SITEKEY` secret stored, a `LOBBY_HOST` needs a Turnstile
token (`server/turnstile.js`, and "Turnstile" in `server/README.md`).
`wrangler.jsonc` sets `TURNSTILE_HOSTNAMES`, the game page's hostnames (not the
Worker's). Until `TURNSTILE_SECRET` is stored too, every `LOBBY_HOST` token is
refused, so no room can be hosted. Store both from the Cloudflare dashboard's
widget settings, with an installed Wrangler rather than `npx`, since the
commands handle secrets:

```bash
cd cloudflare/lobby && wrangler secret put TURNSTILE_SITEKEY
```

```bash
cd cloudflare/lobby && wrangler secret put TURNSTILE_SECRET
```

The sitekey isn't secret (every visitor's browser gets it); it is stored as one
only to keep it out of the repository. To turn the check off, delete it:

```bash
cd cloudflare/lobby && wrangler secret delete TURNSTILE_SITEKEY
```

## Check the bundle without deploying

```bash
cd cloudflare/lobby && npx wrangler deploy --dry-run --outdir /tmp/icaro-lobby-bundle
```
