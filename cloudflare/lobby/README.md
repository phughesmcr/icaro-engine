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

The rate limits (rooms hosted, joins and missed joins per IP per minute, frames
per socket) live in the Durable Object's memory. When it hibernates and leaves
memory, they start again from nothing, so a client that pauses between bursts
can get past them. The caps on open sockets, rooms and joiners per IP hold,
since they count live sockets. If that matters, add a Cloudflare rate-limiting
rule on the route as well.

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
