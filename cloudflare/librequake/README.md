# LibreQuake zip Worker

A Cloudflare Worker that serves LibreQuake's pinned release zips from an R2
bucket at `https://quake.anglezarke.games/static/librequake/v0.09-beta/full.zip`
and `lite.zip`, the URLs the intro page downloads from (`LQ_DOWNLOAD_BASE` and
`LQ_RELEASES` in `src/librequake.js`). The design is
[docs/librequake-content.md](../../docs/librequake-content.md), Hosting. The
zips are too big for the client Worker's static assets (25 MiB a file), and
GitHub's release downloads send no CORS headers, so the page can't fetch them
from GitHub.

## Files

- `wrangler.jsonc`: the Worker, its R2 binding (`LQ_BUCKET`, bucket
  `icaro-librequake`) and the `quake.anglezarke.games/static/librequake/*`
  route. No assets, no `workers.dev` URL.
- `src/worker.js`: hands each request to `serve.js` with the bucket.
- `src/serve.js`: the request handling. `tests/cloudflare_librequake_test.js`
  runs it under Deno against a fake bucket, and checks that its allowlist is the
  client's URLs.

## What it answers

- Only `GET` and `HEAD`; anything else is 405.
- Only the paths in `LQ_R2_OBJECTS` (one for each of `LQ_RELEASES`); any other
  path under `/static/librequake/` is 404, and so is a zip not uploaded yet. The
  bucket is never listed.
- No `Range`: 200 with the whole zip. One `bytes=` range (`N-`, `N-M` or `-N`):
  206 with `Content-Range`, which is how the client resumes. A range that starts
  past the end: 416 with `Content-Range: bytes */<size>`. Several ranges, or a
  malformed one, are ignored (200).
- `If-None-Match` and `If-Modified-Since` give 304. `If-Range` with the current
  ETag or `Last-Modified` keeps the range; anything else sends the whole zip.
- A zip replaced between the `head` and the `get` gets 503 with `Retry-After`,
  never a body that doesn't match the headers.
- Headers: `Content-Type: application/zip`, `Content-Length`, `Accept-Ranges`,
  `ETag`, `Last-Modified`, `X-Content-Type-Options: nosniff` and
  `Cache-Control: public, max-age=31536000, immutable` (the path holds the
  version, so a zip under it never changes).

The page and the zips are on one origin, so no CORS headers are needed.

## Routing

A Worker on a route runs in front of a Worker on a Custom Domain for the same
hostname (Cloudflare's
[Custom Domains page](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/),
"Interaction with Routes"). So `/static/librequake/*` reaches this Worker, and
every other path still reaches the client Worker (`../client/`), whose static
assets never hold `static/librequake/` (`build.js` denies it). The lobby's
`/mp/lobby*` route (`../lobby/`) works the same way.

## Deploy

Always run wrangler **from this folder**. From the repository root, wrangler
takes the whole repository for a static site and offers to upload it, registered
game data in `static/` included.

1. Get the two zips from the
   [v0.09-beta release](https://github.com/lavenderdotpet/LibreQuake/releases/tag/v0.09-beta)
   into `static/librequake/v0.09-beta/` (gitignored):

   ```bash
   mkdir -p static/librequake/v0.09-beta && gh release download v0.09-beta --repo lavenderdotpet/LibreQuake --pattern full.zip --pattern lite.zip --dir static/librequake/v0.09-beta
   ```

2. Check each file's SHA-256 against `sha256` in `LQ_RELEASES`
   (`src/librequake.js`): `623e463b…` for `full.zip`, `428e736b…` for
   `lite.zip`. A zip with another hash fails the client's check after the whole
   download.

   ```bash
   shasum -a 256 static/librequake/v0.09-beta/full.zip static/librequake/v0.09-beta/lite.zip
   ```

3. Create the bucket, in the Standard storage class (the default; the free tier
   doesn't cover Infrequent Access). The dashboard may ask you to enable R2 for
   the account first.

   ```bash
   cd cloudflare/librequake && npx wrangler r2 bucket create icaro-librequake
   ```

4. Upload both zips under their version folder with their content type.
   `--remote` matters: without it, wrangler writes to the local simulation that
   `wrangler dev` uses.

   ```bash
   cd cloudflare/librequake && npx wrangler r2 object put icaro-librequake/v0.09-beta/full.zip --remote --content-type application/zip --file ../../static/librequake/v0.09-beta/full.zip
   ```

   ```bash
   cd cloudflare/librequake && npx wrangler r2 object put icaro-librequake/v0.09-beta/lite.zip --remote --content-type application/zip --file ../../static/librequake/v0.09-beta/lite.zip
   ```

5. Deploy the Worker and its route. The route needs a proxied DNS record for the
   hostname; the client Worker's Custom Domain is one, so deploy the client
   first (`../client/README.md`).

   ```bash
   cd cloudflare/librequake && npx wrangler deploy
   ```

6. Check a range and the headers (expect 206, `Content-Range: bytes 0-99/…`,
   `Content-Length: 100`), then a whole download against the hash in step 2:

   ```bash
   curl -r 0-99 -I https://quake.anglezarke.games/static/librequake/v0.09-beta/full.zip
   ```

   ```bash
   curl -sf https://quake.anglezarke.games/static/librequake/v0.09-beta/full.zip | shasum -a 256
   ```

   ```bash
   curl -sf https://quake.anglezarke.games/static/librequake/v0.09-beta/lite.zip | shasum -a 256
   ```

   A 404 from the client Worker (an HTML or empty body, without `Accept-Ranges`)
   means the route isn't running; a 404 saying "Not found" with the route
   running means the object's key is wrong. Then press the download button on
   the intro page.

A new release goes under a new version folder: new keys and a new
`LQ_R2_OBJECTS` in `src/serve.js`, matching the new `LQ_RELEASES` and
`LQ_DOWNLOAD_BASE`. The old objects can be deleted once no deployed page names
them.

## Local testing

`deno task serve` serves `static/librequake/v0.09-beta/` itself, with `Range`,
so the client doesn't need this Worker locally. To run the Worker, put a test
object in wrangler's local simulation and start it (neither touches your
account):

```bash
cd cloudflare/librequake && npx wrangler r2 object put icaro-librequake/v0.09-beta/full.zip --local --content-type application/zip --file ../../static/librequake/v0.09-beta/full.zip
```

```bash
cd cloudflare/librequake && npx wrangler dev
```

Then
`curl -r 0-99 -I http://localhost:8787/static/librequake/v0.09-beta/full.zip`.
The local state is in `.wrangler/` (gitignored).

## Free tier

Checked against Cloudflare's pricing and limits pages on 2026-11-26:

- R2 storage: the two zips are 171.7 MB (115,678,161 + 55,987,573 bytes); the
  free tier is 10 GB-month of Standard storage.
- R2 egress to the internet is free.
- R2 operations: each request is a `head` and, for a `GET` that sends a body, a
  `get`, both Class B; the free tier is 10 million Class B operations a month.
  The two uploads are two Class A operations (1 million free). The Worker never
  lists.
- Workers Free: 100,000 requests a day, each download one request (a resume is
  another). Streaming R2's body through spends next to no CPU time.

Responses from a Worker aren't kept by Cloudflare's CDN cache, so every download
reads R2; with free egress that costs only the operations above.
