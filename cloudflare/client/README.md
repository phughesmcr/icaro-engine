# Client Worker: the game page as static files

A Cloudflare Worker with static assets only (no script) that serves the browser
client at `https://quake.anglezarke.games`. The lobby for rooms hosted in
browsers is a separate Worker (`../lobby/`), routed at `/mp/lobby` on the same
hostname, so the page's default lobby (`wss://<host>/mp/lobby`) needs no
`?server=`. Nothing here depends on a home machine.

Static asset requests are free and don't count towards the Workers request
allowance, so the page costs nothing on the Free plan. Limits that matter: 25
MiB per file (`static/pak0.pak` is 17.8 MiB) and 20,000 files per version.

## Files

- `build.js`: fills `dist/` from an allowlist (`deno task client-build`).
- `wrangler.jsonc`: the Worker, its assets folder (`dist/`) and the Custom
  Domain. No `main`.
- `dist/`: build output, gitignored. Never edit it by hand.

## What gets deployed

`build.js` copies only files git tracks, from `index.html`, `main.js`, `sw.js`,
`manifest.webmanifest`, `LICENSE`, `src/` and `static/`. It fails if any of them
is a pak other than `static/pak0.pak`, sits in a registered-data or music folder
(`hipnotic`, `rogue`, `rerelease`, `id1`, `mg1`, `mg3`, `dopa`, `ctf`, `music`),
or is a key, certificate, env file or dotfile, and if `static/pak0.pak` isn't
the shareware pak (its SHA-256 is pinned in `build.js`). It then checks what
landed in `dist/` against the same rules. It refuses to run while a client file
has uncommitted changes, so a deploy is what `HEAD` holds; `--allow-dirty`
overrides that for a test deploy. `tests/client_build_test.js` covers the rules
and checks that every file `sw.js` precaches and `index.html` links is on the
allowlist.

Registered data never reaches the Worker: `.gitignore` keeps it out of git, the
build copies only tracked files, and the deny check runs twice. Never point
`assets.directory` anywhere but `dist/`, and never run wrangler from the
repository root.

## Deploy

```bash
deno task client-build
```

```bash
cd cloudflare/client && npx wrangler deploy
```

Each deploy uploads only files that changed. Players get the new version on
their next load: `sw.js` fetches the page and code network-first, and caches
`static/pak0.pak` until its `CACHE_NAME` changes.

### First deploy

The Custom Domain makes the Worker the hostname's origin and creates its DNS
record. Workers on routes run in front of it (Cloudflare's Custom Domains page,
"Interaction with Routes"), which is how the lobby's `/mp/lobby*` route gets its
path. Cloudflare can't create it while the hostname has another record, such as
the CNAME a Cloudflare Tunnel adds. To move `quake.anglezarke.games` off a
tunnel:

1. Deploy the lobby with its route first (`../lobby/README.md`) and store its
   secrets (Turnstile, TURN). The route takes `/mp/lobby` from the tunnel at
   once.
2. In the dashboard (DNS, Records for `anglezarke.games`), delete the
   `quake.anglezarke.games` CNAME that points at the tunnel.
3. Run the two commands above. Wrangler creates the Custom Domain and its
   record. The site is unreachable between steps 2 and 3.
4. Check `https://quake.anglezarke.games/` loads, and that
   `curl -i https://quake.anglezarke.games/mp/lobby` answers 426 "WebSocket
   only" (the lobby Worker) rather than 404 (this Worker: the route isn't
   running). Then check that hosting a room works (the Turnstile widget's
   hostnames must include `quake.anglezarke.games`).
5. Remove the tunnel's ingress rules for the hostname, or the tunnel itself.

Rooms on the Deno lobby (`deno task lobby`) are no longer reachable from that
page once its `/mp/lobby` is the Worker's: it lists only rooms hosted in
browsers.

## Headers and caching

`build.js` writes `dist/_headers`, which Workers static assets apply to every
response (`Client_Headers`):

- `Content-Security-Policy`: scripts from this origin, jsDelivr (the import map)
  and Turnstile only, plus a SHA-256 hash of each inline script in `index.html`
  (the import map and the service worker's registration). The build computes
  those hashes, so editing either script needs no other change. No framing
  (`frame-ancestors 'none'`), no plugins, no `<base>`. `connect-src` allows any
  `https:` or `wss:` host, since `?server=` may name any lobby. Inline styles
  are allowed (the `<style>` block, touch controls).
- `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: strict-origin-when-cross-origin`,
  `Cross-Origin-Opener-Policy: same-origin`, a `Permissions-Policy` that turns
  off camera, microphone, geolocation, payment and USB, and
  `Strict-Transport-Security` for a year (this hostname only, no preload).

The policy was checked in a browser against `wrangler dev` (the `client-worker`
preview in `.claude/launch.json`): E1M1 loads and renders, the service worker
registers and caches, and the Turnstile widget renders, with no policy
violations. `connect-src` refuses `ws://` lobbies, so this page (deployed or
under `wrangler dev`) can't reach a local lobby such as `ws://127.0.0.1:4433`,
even with `?server=`. Use `deno task serve` for local multiplayer work.

Caching is Cloudflare's default: no long-lived caching (`max-age=0`,
`must-revalidate`) and an `ETag`, so a repeat load costs a 304 per file. No
cross-origin isolation headers are set or needed (the engine doesn't use
`SharedArrayBuffer`), and adding `Cross-Origin-Embedder-Policy` would put the
import map's jsDelivr modules at risk.

Static assets ignore `Range` and answer with the whole file. `src/pak.js` takes
that as "Range was ignored" and loads `pak0.pak` whole, which it needs anyway.
Paks over 64 MiB (the rerelease's) need Range, but those must never be deployed.

With the default `html_handling`, `/index.html` redirects to `/`. `sw.js`
precaches both, so the cached `index.html` is a redirected response; only a
navigation to `/index.html` while offline would use it.

## Not set up

- No CI deploy. A GitHub Actions job would need a `CLOUDFLARE_API_TOKEN` secret
  with Workers Scripts edit (and Zone, Workers Routes and DNS edit for the first
  deploy's Custom Domain) and a `CLOUDFLARE_ACCOUNT_ID` secret. Never commit
  either.
- The optional WAF rate-limiting rule on `/mp/lobby` (`../lobby/README.md`,
  "Abuse limits"); the lobby's own limits are in its code and config.

## Dashboard settings

Settings outside the repository that matter for this hostname:

- SSL/TLS, Edge Certificates: Always Use HTTPS on, minimum TLS version 1.2.
  (HSTS comes from `_headers`; leave the dashboard's HSTS off or set it the
  same.)
- Turnstile: the widget's hostnames are `quake.anglezarke.games` only, as is the
  lobby's `TURNSTILE_HOSTNAMES`.
- Billing: if the account has a payment method, a billing notification warns
  before TURN relay traffic passes the free allowance (not checked which
  notification types the account offers).
- API tokens: a deploy token scoped to this account's Workers (and the zone's
  Workers Routes for the first deploy), nothing wider. Once the tunnel is gone,
  delete it in the dashboard and its credentials file
  (`~/.cloudflared/<id>.json`): anyone holding that file can run the tunnel.
