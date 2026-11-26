// Icaro Engine service worker: offline play and instant repeat launches
// (docs/mobile-roadmap.md, item 9). Web-only addition with no Quake
// equivalent. index.html registers it.
//
// What it caches, and how:
// - static/pak0.pak (the shareware pak) and version-pinned CDN modules
//   (three, nipplejs and zip.js from cdn.jsdelivr.net/npm/<name>@<version>/):
//   cache first. Their contents never change under the same URL. Each is
//   cached when the page first asks for it, so pak0 is cached only once a
//   person has pressed Play on the intro page (src/intro.js).
// - Music in static/music/ (a player's own static/music/trackNN.ogg or .mp3):
//   cache first, in a cache of its own. Media elements read with Range and
//   cache.put rejects a 206, so a track that isn't cached streams from the
//   server unchanged while the worker fetches it whole, without Range, and
//   stores that. Its first play online therefore downloads it twice. Cached,
//   it is answered here: 200, or a 206 cut from the whole copy. A track
//   is cached once played, so one never played has no offline music.
//   Exception: a page that was open before the worker controlled it (a first
//   visit), or while a worker without a music cache did, is network first
//   until it is reloaded, because its music may already be loading with the
//   server's own responses (see SW_Music).
//   A track is not stored if it is larger than MUSIC_MAX_BYTES or would leave
//   less than MUSIC_RESERVE_BYTES of the storage quota free; it still streams.
//   A rip replaced under the same name stays cached until the site's data is
//   cleared or MUSIC_CACHE_NAME is bumped.
// - Everything else on this origin (index.html, main.js, src/, icons,
//   loose maps): network first, so a deploy reaches players on their next
//   online launch and every module of one load comes from the same version.
//   A successful response is copied into the cache; offline, the cached copy
//   is served.
// - Not cached: other paks (registered or rerelease data: big, and lazy paks
//   are read with Range requests), anything under static/librequake/ (the
//   LibreQuake download, 56 to 116 MB, which src/librequake.js keeps in the
//   browser's storage itself), music in any other music/ directory (the
//   mission packs' and the rerelease's: their paks aren't cached, so an
//   offline launch can't use it) and any other request carrying a Range
//   header. Offline, these get a 404, which the pak loader treats as "no such
//   pak", so an offline launch still starts.
//
// On install it fetches the shell, but no pak: a bot that loads the page
// runs this too, and nothing pak-related is fetched before a person acts
// (src/intro.js). The first page load runs before
// this worker controls it, so once the page has loaded it posts the URLs it
// fetched (main.js, src/*.js, three's files) and the worker caches those
// too, music last. No file list is kept here, so new modules need no change to
// this file.
//
// Bump CACHE_NAME to drop everything cached by an older worker. Bump it
// whenever static/pak0.pak changes: it is cache first under the same URL, so
// players would otherwise keep the old copy. Music survives that bump.

const CACHE_NAME = "icaro-v1";
const CACHE_PREFIX = "icaro-";
const MUSIC_CACHE_NAME = "icaro-music-v1";
// A whole CD track as 320 kbit/s MP3 is well under this
const MUSIC_MAX_BYTES = 64 * 1024 * 1024;
// Quota left for the game: a full origin couldn't cache a new deploy
const MUSIC_RESERVE_BYTES = 50 * 1024 * 1024;

const SHELL = [
  "./",
  "index.html",
  "main.js",
  "manifest.webmanifest",
  "static/icon.svg",
  "static/icon.png",
  "static/icon-192.png",
  "static/icon-maskable-512.png",
  "static/apple-touch-icon.png",
  "static/mainmenu.png",
];

const PAK0_PATH = "static/pak0.pak";
// CD tracks as cd_audio.js names them (CDAudio_TrackURLs)
const TRACK_FILE = /\/music\/track\d{2,}\.(ogg|mp3)$/i;
const OFFLINE_MUSIC_DIR = "static/music/";
// The LibreQuake download and a developer's unpacked copy (src/librequake.js)
const LIBREQUAKE_DIR = "static/librequake/";
const MEDIA_EXT = /\.(ogg|mp3|wav|flac|opus|m4a)$/i;
const CDN_HOST = "cdn.jsdelivr.net";
// npm package with an exact version: /npm/three@0.183.0/...
const CDN_PINNED = /^\/npm\/(@[^/]+\/)?[^/@]+@\d+\.\d+\.\d+\//;

function scopeURL() {
  return new URL(
    self.registration !== undefined ?
      self.registration.scope :
      self.location.href,
  );
}

function sameOrigin(url) {
  return url.origin === self.location.origin;
}

// How to answer a GET: 'pak0', 'music', 'immutable', 'network', 'passthrough'
// or null (let the browser handle it). Exported for tests through self.
function SW_Route(request) {
  if (request.method !== "GET") return null;

  const url = new URL(request.url);
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  if (sameOrigin(url)) {
    const scope = scopeURL();
    if (url.pathname === new URL(PAK0_PATH, scope).pathname) return "pak0";
    if (/\.pak$/i.test(url.pathname)) return "passthrough";
    if (url.pathname.startsWith(new URL(LIBREQUAKE_DIR, scope).pathname)) {
      return "passthrough";
    }
    if (TRACK_FILE.test(url.pathname)) {
      const dir = new URL(OFFLINE_MUSIC_DIR, scope).pathname;
      const cached = url.pathname.startsWith(dir) &&
        url.pathname.lastIndexOf("/") === dir.length - 1;
      return cached ? "music" : "passthrough";
    }

    if (request.headers.has("range")) return "passthrough";
    if (!url.pathname.startsWith(scope.pathname)) return null;
    return "network";
  }

  if (
    url.hostname === CDN_HOST && CDN_PINNED.test(url.pathname) &&
    !request.headers.has("range")
  ) {
    return "immutable";
  }

  return null;
}

// The answer for something we can't fetch and don't have. The engine's
// loaders take a 404 as "not there" and carry on.
function offlineResponse() {
  return new Response("", { status: 404, statusText: "Not available offline" });
}

// Cache key for a request: navigations drop the query (?room=, ?map= and
// the rest all load the same index.html)
function cacheKey(request) {
  if (request.mode !== "navigate") return request.url;
  const url = new URL(request.url);
  url.search = "";
  url.hash = "";
  return url.href;
}

async function putIfOk(cache, key, response) {
  // basic (same origin) or cors (CDN): never cache opaque or partial responses
  if (
    response.status !== 200 ||
    (response.type !== "basic" && response.type !== "cors" &&
      response.type !== "default")
  ) {
    return;
  }
  try {
    await cache.put(key, response);
  } catch {
    // over quota: the page still gets the response
  }
}

// pak0: the cached whole pak answers every request, including the loader's
// Range: bytes=0-11 probe. pak.js takes a 200 to mean the server ignored the
// Range and reads the whole pak from it.
async function SW_Pak0(_request) {
  const cache = await caches.open(CACHE_NAME);
  const key = new URL(PAK0_PATH, scopeURL()).href;
  const cached = await cache.match(key);
  if (cached !== undefined) return cached;

  let response;
  try {
    response = await fetch(key);
  } catch {
    return offlineResponse();
  }

  if (response.status === 200) await cache.put(key, response.clone());
  return response;
}

async function SW_Immutable(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request.url);
  if (cached !== undefined) return cached;

  const response = await fetch(request);
  await putIfOk(cache, request.url, response.clone());
  return response;
}

// Slow (not failed) network: after this long, a cached copy is served and
// the fetch finishes in the background to refresh the cache. On a link that
// hangs rather than fails, waiting for the browser's own timeout would hold
// up every module. A load that crosses a deploy at that moment can mix
// versions; the next launch is consistent again.
let networkTimeoutMs = 5000;

async function SW_Network(request) {
  const cache = await caches.open(CACHE_NAME);
  const key = cacheKey(request);

  const network = fetch(request).then(async (response) => {
    await putIfOk(cache, key, response.clone());
    return response;
  });

  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), networkTimeoutMs);
  });

  try {
    const first = await Promise.race([network, timeout]);
    if (first !== null) return first;

    const cached = await cache.match(key);
    if (cached !== undefined) {
      network.catch(() => {});
      return cached;
    }

    return await network;
  } catch {
    const cached = await cache.match(key);
    if (cached !== undefined) return cached;
    if (request.mode === "navigate") {
      const shell = await cache.match(new URL("./", scopeURL()).href);
      if (shell !== undefined) return shell;
    }

    return offlineResponse();
  } finally {
    clearTimeout(timer);
  }
}

async function SW_Passthrough(request) {
  try {
    return await fetch(request);
  } catch {
    return offlineResponse();
  }
}

// The answer to a request from a whole cached track: the cached 200, or for
// a single byte range a 206 (416 if it starts past the end). A Range header
// we don't understand, several ranges included, is ignored, as HTTP allows.
async function SW_RangeResponse(cached, range) {
  const match = range === null ? null : /^bytes=(\d*)-(\d*)$/.exec(range);
  if (match === null || (match[1] === "" && match[2] === "")) return cached;

  const blob = await cached.blob();
  const size = blob.size;
  let start;
  let end = size - 1;
  if (match[1] === "") {
    // bytes=-n: the last n bytes
    start = Math.max(size - Number(match[2]), 0);
  } else {
    start = Number(match[1]);
    if (match[2] !== "") {
      // last byte before first: invalid, so ignored
      if (Number(match[2]) < start) {
        return new Response(blob, { headers: cached.headers });
      }

      end = Math.min(Number(match[2]), end);
    }
  }

  if (start >= size) {
    return new Response(null, {
      status: 416,
      statusText: "Range Not Satisfiable",
      headers: { "Content-Range": `bytes */${size}` },
    });
  }

  const headers = new Headers(cached.headers);
  headers.delete("content-encoding"); // the cached body is already decoded
  headers.set("Accept-Ranges", "bytes");
  headers.set("Content-Length", String(end - start + 1));
  headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
  return new Response(blob.slice(start, end + 1), {
    status: 206,
    statusText: "Partial Content",
    headers,
  });
}

// Whether a track of this many bytes may be stored
async function SW_MusicFits(size) {
  if (size > MUSIC_MAX_BYTES) return false;

  const storage = self.navigator?.storage;
  if (storage?.estimate === undefined) return true; // cache.put enforces quota
  const { quota, usage } = await storage.estimate();
  if (quota === undefined || usage === undefined) return true;
  return quota - usage - size >= MUSIC_RESERVE_BYTES;
}

async function SW_FetchTrack(url) {
  const cache = await caches.open(MUSIC_CACHE_NAME);
  if (await cache.match(url) !== undefined) return;

  // no-store: the Cache API copy is the one kept, and this fetch doesn't
  // wait on the HTTP cache entry the media element is writing
  const response = await fetch(url, { cache: "no-store" });
  // a server that answers a missing file with an HTML page and a 200
  const type = response.headers.get("content-type") ?? "";
  if (response.status !== 200 || type.startsWith("text/html")) {
    await response.body?.cancel();
    return;
  }

  const length = response.headers.get("content-length");
  if (length !== null) {
    if (await SW_MusicFits(Number(length))) {
      await putIfOk(cache, url, response);
    } else {
      unfitTracks.add(url);
      await response.body?.cancel();
    }

    return;
  }

  // the size is known only once the body has arrived
  const blob = await response.blob();
  if (!await SW_MusicFits(blob.size)) {
    unfitTracks.add(url);
    return;
  }

  await putIfOk(cache, url, new Response(blob, { headers: response.headers }));
}

// url -> the fetch in progress: a media element sends several requests for
// one track
const trackFetches = new Map();
// Tracks that didn't fit, not fetched again until the worker restarts: without
// a Content-Length, finding that out downloads the whole file
const unfitTracks = new Set();

// Store a whole track. Never rejects: a track that can't be stored (offline,
// over quota) is tried again the next time it is requested.
function SW_CacheTrack(url) {
  if (unfitTracks.has(url)) return Promise.resolve();

  let pending = trackFetches.get(url);
  if (pending === undefined) {
    pending = SW_FetchTrack(url)
      .catch(() => {})
      .finally(() => trackFetches.delete(url));
    trackFetches.set(url, pending);
  }

  return pending;
}

// The pages whose music may be loading with the network's own responses, as a
// list of client ids. Kept in the music cache: the browser stops idle workers,
// and a CACHE_NAME bump must not forget it.
const CLAIMED_KEY = "sw-claimed-pages";
let claimedPages = null; // Promise<Set<string>>

// null if no list has been saved
async function SW_ReadClaimedPages() {
  const cache = await caches.open(MUSIC_CACHE_NAME);
  const saved = await cache.match(new URL(CLAIMED_KEY, scopeURL()).href);
  return saved === undefined ? null : new Set(await saved.json());
}

function SW_ClaimedPages() {
  claimedPages ??= SW_ReadClaimedPages()
    .then((pages) => pages ?? new Set())
    .catch(() => new Set());
  return claimedPages;
}

// Called on activate, before clients.claim(). Pages already listed stay listed
// while they are open; pages without a worker now are added. With no saved
// list, every open page is: a controlled one had a worker that passed music on
// as the network's own response.
async function SW_NoteClaimedPages() {
  const controlled = new Set(
    (await self.clients.matchAll()).map((client) => client.id),
  );
  const open = await self.clients.matchAll({ includeUncontrolled: true });
  const before = await SW_ReadClaimedPages();
  const pages = new Set(
    open.map((client) => client.id).filter((id) =>
      before === null || before.has(id) || !controlled.has(id)
    ),
  );
  claimedPages = Promise.resolve(pages);

  const cache = await caches.open(MUSIC_CACHE_NAME);
  await cache.put(
    new URL(CLAIMED_KEY, scopeURL()).href,
    new Response(JSON.stringify([...pages])),
  );
}

async function SW_CachedTrack(request) {
  try {
    const cache = await caches.open(MUSIC_CACHE_NAME);
    const cached = await cache.match(request.url);
    if (cached !== undefined) {
      return await SW_RangeResponse(cached, request.headers.get("range"));
    }
  } catch {
    // unreadable cache: stream it
  }

  return null;
}

// Chromium fails a media element (PIPELINE_ERROR_READ) that got some of a
// track from the network's own response and a later range from one built
// here, which has no URL. So each page gets one kind:
// - normally cache first, and a streamed response is passed on as a new
//   Response, because the track may be cached while it plays;
// - a claimed page, whose media element may have started before this worker
//   did, gets the network's response itself, and the cache only if the
//   network fails.
async function SW_Music(request, event) {
  const claimed = (await SW_ClaimedPages()).has(event.clientId);
  if (!claimed) {
    const cached = await SW_CachedTrack(request);
    if (cached !== null) return cached;
  }

  let response;
  try {
    response = await fetch(request);
  } catch {
    const cached = claimed ? await SW_CachedTrack(request) : null;
    return cached ?? offlineResponse();
  }

  if (response.status !== 200 && response.status !== 206) return response;

  event.waitUntil(SW_CacheTrack(request.url));
  if (claimed) return response;

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

const handlers = {
  pak0: SW_Pak0,
  music: SW_Music,
  immutable: SW_Immutable,
  network: SW_Network,
  passthrough: SW_Passthrough,
};

// Cache the URLs a page reports it loaded (see the header). Each URL is
// fetched on its own, so one failure doesn't drop the rest.
async function SW_CacheURLs(urls) {
  const cache = await caches.open(CACHE_NAME);
  const tracks = [];
  for (const raw of urls) {
    if (typeof raw !== "string") continue;
    let request;
    try {
      request = new Request(raw);
    } catch {
      continue;
    }

    const route = SW_Route(request);
    if (route === "music") {
      tracks.push(request.url);
      continue;
    }

    if (route !== "network" && route !== "immutable") continue;
    // other media the page streamed
    if (MEDIA_EXT.test(new URL(request.url).pathname)) continue;
    if (await cache.match(request.url) !== undefined) continue;

    try {
      await putIfOk(cache, request.url, await fetch(request));
    } catch {
      // offline or blocked: it will be cached when next fetched
    }
  }

  // last: big, and the code matters more
  for (const url of tracks) await SW_CacheTrack(url);
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    const scope = scopeURL();
    for (const path of SHELL) {
      const url = new URL(path, scope).href;
      try {
        await putIfOk(cache, url, await fetch(url));
      } catch {
        // a missing icon must not block offline play
      }
    }

    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (
        name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME &&
        name !== MUSIC_CACHE_NAME
      ) {
        await caches.delete(name);
      }
    }

    try {
      await SW_NoteClaimedPages();
    } catch {
      // storage refused: claim anyway
    }

    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const route = SW_Route(event.request);
  if (route === null) return;
  event.respondWith(handlers[route](event.request, event));
});

self.addEventListener("message", (event) => {
  const data = event.data;
  if (
    data === null || typeof data !== "object" || data.type !== "cache-urls" ||
    !Array.isArray(data.urls)
  ) {
    return;
  }
  event.waitUntil(SW_CacheURLs(data.urls));
});

// For tests (tests/sw_test.js)
self.SW_Route = SW_Route;
self.SW_CACHE_NAME = CACHE_NAME;
self.SW_MUSIC_CACHE_NAME = MUSIC_CACHE_NAME;
self.SW_SetNetworkTimeout = (ms) => {
  networkTimeoutMs = ms;
};
