# Lobby Worker for rooms hosted in browsers

A Cloudflare Worker and one Durable Object that list rooms hosted in
players' browsers and relay their WebRTC signals. The design is
[docs/browser-hosted-rooms.md](../../docs/browser-hosted-rooms.md). The room
table and relay are `server/lobby_rtc.js`, shared with the Deno lobby
(`deno task lobby`), which serves the same protocol for local development.

This lobby can't start Deno rooms: it refuses `LOBBY_CREATE`, and a
deployment that points its `/mp/lobby` here lists only rooms hosted in
browsers.

## Files

- `wrangler.jsonc`: the Worker, its Durable Object binding (`LOBBY`) and
  the SQLite migration the Free plan needs. No assets.
- `src/worker.js`: routes `<prefix>/lobby` to the Durable Object and
  upgrades the WebSocket. Workers-only code.
- `src/lobby_core.js`: the Durable Object's logic: hibernation-safe session
  state, the alarm that drops silent hosts, TURN credentials.
  `tests/cloudflare_lobby_test.js` runs it under Deno with a fake `ctx`.

## Deploy

Always run wrangler **from this folder**. From the repository root, wrangler
takes the whole repository for a static site and offers to upload it,
registered game data in `static/` included.

```bash
cd cloudflare/lobby && npx wrangler deploy
```

The Worker is then at `https://icaro-lobby.<account>.workers.dev/lobby`.
Clients reach it as their lobby with `?server=wss://icaro-lobby.<account>.workers.dev`.
To serve it at `/mp/lobby` on your own zone instead, add a route
(`"routes": [ { "pattern": "example.com/mp/lobby*", "zone_name": "example.com" } ]`)
or set one in the dashboard.

## TURN

Without TURN, clients get Cloudflare's STUN server only, and players behind
NATs that need a relay (many mobile networks) can't join. To hand out TURN
credentials, create a TURN key in the Cloudflare dashboard (Realtime, TURN),
then store its id and API token as secrets:

```bash
cd cloudflare/lobby && npx wrangler secret put TURN_KEY_ID
```

```bash
cd cloudflare/lobby && npx wrangler secret put TURN_KEY_API_TOKEN
```

The lobby mints credentials only for a client that has just hosted a room
or joined one, within the lobby's rate limits. They last 6 hours
(`TURN_TTL_SECONDS` overrides that), since a relay can't be refreshed once
they expire. If minting fails, clients get STUN only.

## Check the bundle without deploying

```bash
cd cloudflare/lobby && npx wrangler deploy --dry-run --outdir /tmp/icaro-lobby-bundle
```
