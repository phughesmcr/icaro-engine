# LibreQuake as the standard content

Status (2026-11-26): built. `src/intro.js` (the intro page), `src/librequake.js`
(download, check, unpack) and the hooks in `main.js`, `src/userdata.js`,
`src/pak.js`, `src/cd_audio.js` and `sw.js`. The release zips aren't hosted yet
(see Hosting): until they are, the download button reports that the download
isn't available, and only a player's own Quake files (Options, Game data) play.
The repository ships no pak: id's shareware `static/pak0.pak` was removed, and
the tests, benchmarks, servers and game-room image run LibreQuake too
(`deno task fetch-data`, `server/game_data.js`).

[LibreQuake](https://github.com/lavenderdotpet/LibreQuake) is a free replacement
for id1's data: art and maps under the BSD 3-clause licence, QuakeC under the
GPL-2. A new player in the browser gets it by default, downloaded once and kept
in the browser's storage. A player's own id1 paks (shareware or registered,
added in Options, Game data) still work and can be chosen instead; the site
serves no id pak.

## The intro page and the gate

`main.js` waits on `Intro_Gate` before it loads any game data. Nothing
pak-related is fetched until a person presses a button, so crawlers, link
previews and other bots that load the page never download a pak or the zip.
`sw.js` caches no pak: LibreQuake and a player's own data live in the browser's
storage.

What a launch starts (`Intro_Want`):

1. `?base=` in the URL: `librequake`, `rerelease`, or `id1` for id's data that
   the player has stored (Options, Game data).
2. Otherwise `?game=` means id's data: mission packs and add-ons need it.
   `?room=` and `?map=` mean LibreQuake: lobby rooms run its maps, and agent
   links such as `?map=lq_e1m1` name its maps.
3. A link that asks for id's data when none is stored says so and offers
   LibreQuake instead.
4. Otherwise the person's last pick on the intro page or in the Game data panel
   (`localStorage` `icaro_content`: `librequake` or `id1`). A pick of `id1` with
   nothing stored falls back to LibreQuake.
5. Otherwise LibreQuake.

The page is skipped only when a person has pressed a button on this device
before (`localStorage` `icaro_played`, written only by a click) and what the
launch wants needs no download. A link that names its content gets a single Play
button; otherwise the page offers the full download and the lite one (or "Play
LibreQuake" once it is installed), plus "Play Quake", or "Play Quake
(registered)" with `pak1.pak` too, when the player has stored their own `id1`
`pak0.pak`. There is no shareware button.

## Full or lite

Both are pinned in `LQ_RELEASES`, v0.09-beta:

| Release    | Zip                      | Unpacked | Contents                                                     |
| ---------- | ------------------------ | -------- | ------------------------------------------------------------ |
| `full.zip` | 115,678,161 bytes        | 249 MB   | Episodes 0 to 4, the `lqdm*` deathmatch maps, music, configs |
| `lite.zip` | 55,987,573 bytes (56 MB) | 79 MB    | Episode 0 only, music                                        |

Full is the main button; lite is the second, for slow or metered connections.
Each zip's SHA-256 is pinned beside its size. `docs/branding/` inside the zip is
skipped. Moving to a newer release means new sizes, hashes and a new
`LQ_DOWNLOAD_BASE` folder.

## Download, resume and check

- The zip is fetched in one request and written to the store in 8 MiB parts
  (`librequake/download/<variant>-<version>/<offset>`), so a download that stops
  keeps what it got.
- Pressing the download button again resumes with `Range: bytes=N-`. A 206
  carries on; a 200 (the server ignored the range) starts again from zero; a 206
  whose `Content-Range` starts elsewhere is an error. "Pause download" on the
  page aborts the request, keeping the parts.
- When every byte is there, the parts are hashed in one `crypto.subtle.digest`
  call. A mismatch removes the parts.
- zip.js unpacks the zip (`import("@zip.js/zip.js")`, loaded only now, with web
  workers off so it uses the browser's own `DecompressionStream`). Each file is
  stored under the URL `?base=librequake` would fetch,
  `static/librequake/id1/<path>`, lower-cased, and paths that aren't plain
  relative names are skipped.
- `librequake/manifest.json` is written last, and nothing is used without it, so
  an unpack that stops part way leaves nothing half installed. Then the parts
  are removed.

Memory: the hash reads the whole zip at once (116 MB for full), and the paks are
opened from the store as Blobs, so a large pak is read lazily, as with a
player's own paks.

## Storage and quota

The store is `src/userdata.js`'s (OPFS, or IndexedDB where OPFS is missing).
Before the download, `navigator.storage.estimate()` must show room for the rest
of the zip plus the unpacked files (full: 365 MB in all); if it doesn't, the
page says how much is needed and nothing is fetched. A `QuotaExceededError`
later (during the download or the unpack) is reported the same way, and the
unpacked files are removed. The page asks for persistent storage
(`navigator.storage.persist()`) when the download starts; a refusal changes
nothing, but the browser may then evict the data under storage pressure, and the
page offers the download again. If the store can't be opened at all, the page
still offers id's data.

Options, Game data shows LibreQuake's state (installed, or the part downloaded),
its size, and a Remove button, which deletes the manifest first.

## Hosting

GitHub's release downloads can't be fetched by the page: `github.com` answers
with a 302 to `release-assets.githubusercontent.com` without an
`Access-Control-Allow-Origin` header, so a browser's `fetch` fails (checked in a
Chromium browser on 2026-11-26). The client Worker's static assets can't hold
the zips either (25 MiB a file).

The download URL is one constant, `LQ_DOWNLOAD_BASE` in `src/librequake.js`,
relative to the page: `static/librequake/v0.09-beta/`, then `full.zip` or
`lite.zip`. Either:

- serve that path on the game's own origin from something other than the static
  assets, for example an R2 bucket behind a Worker route on
  `quake.anglezarke.games/static/librequake/*` (routes run in front of the
  Custom Domain), answering `Range` requests with 206; or
- point the constant at an absolute `https:` URL on a host that sends
  `Access-Control-Allow-Origin` for the game's origin. A `bytes=N-` range is a
  CORS-safelisted request header, so no preflight is needed. The host should
  also send `Access-Control-Expose-Headers: Content-Range`; without it, a 206 is
  trusted as starting at the right place and the hash check catches a bad
  resume.

`cloudflare/client/build.js` denies `static/librequake/` (it is gitignored too),
so the zips and unpacked files never reach the static assets, and `sw.js` passes
`static/librequake/` through without caching (the store already keeps it).

For local testing, put `full.zip` and `lite.zip` in
`static/librequake/v0.09-beta/` and run `deno task serve`; Deno's file server
honours `Range`. `deno task fetch-data` puts `full.zip` there, checked against
its pin, and unpacks it into `static/librequake/id1/` for the tests and servers
(`--variant lite` replaces that with lite's).

## Content Security Policy

No change was needed (`cloudflare/client/build.js`, `Client_Headers`).
`connect-src 'self' https: wss:` covers the download from this origin or any
`https:` host. zip.js comes from jsDelivr through the import map with an
integrity hash, which `script-src` already allows, and the import map's own hash
is computed by the build. `worker-src 'self'` is why zip.js's web workers are
off. Stored music plays from `blob:` URLs, which `media-src` allows. Checked
under `wrangler dev` (the `client-worker` preview): zip.js loaded, and the
download's 404 was reported on the page with no policy violation.

## Not covered

- LibreQuake's configs: `set`, `seta` and its key names are accepted (PR #263);
  `if` and `serverinfo` are not, and print harmless messages.
- Lobby rooms run LibreQuake full's maps. A player with lite who joins a room on
  `start` gets lite's `start.bsp`, which differs from full's. Joining a room
  from the menu during a LibreQuake game is untested.
