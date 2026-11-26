// Tests for sw.js, the offline service worker. It runs here against fake
// self, caches and fetch: the routing table, offline answers for pak0 (with
// the loader's Range probe), network-first code, music cached whole and served
// by Range, and the page's cache-urls message.

const SW_SOURCE = await Deno.readTextFile(new URL("../sw.js", import.meta.url));
const ORIGIN = "https://play.example.test";
const SCOPE = ORIGIN + "/game/";

function fail(msg) {
  throw new Error(msg);
}

class FakeCache {
  constructor() {
    this.entries = new Map(); // url -> { body, status, statusText, headers }
  }

  static keyOf(key) {
    return typeof key === "string" ? key : key.url;
  }

  match(key) {
    const e = this.entries.get(FakeCache.keyOf(key));
    if (e === undefined) return Promise.resolve(undefined);
    return Promise.resolve(
      new Response(e.body, {
        status: e.status,
        statusText: e.statusText,
        headers: e.headers,
      }),
    );
  }

  async put(key, response) {
    if (response.status === 206) throw new TypeError("partial response");
    const body = new Uint8Array(await response.arrayBuffer());
    this.entries.set(FakeCache.keyOf(key), {
      body,
      status: response.status,
      statusText: response.statusText,
      headers: [...response.headers],
    });
  }
}

class FakeCaches {
  constructor() {
    this.map = new Map();
  }

  open(name) {
    if (!this.map.has(name)) this.map.set(name, new FakeCache());
    return Promise.resolve(this.map.get(name));
  }

  keys() {
    return Promise.resolve([...this.map.keys()]);
  }

  delete(name) {
    return Promise.resolve(this.map.delete(name));
  }
}

// A server: path -> body text. online=false makes every fetch reject.
function makeNet(files) {
  const net = { online: true, files, requests: [] };
  net.fetch = (input) => {
    const request = typeof input === "string" ? new Request(input) : input;
    net.requests.push({
      url: request.url,
      range: request.headers.get("range"),
    });
    if (!net.online) return Promise.reject(new TypeError("Failed to fetch"));
    if (net.hang) {
      return new Promise((resolve) =>
        net.waiting.push(() => resolve(net.answer(request)))
      );
    }
    return Promise.resolve(net.answer(request));
  };
  // hang: fetches wait until release() answers them
  net.hang = false;
  net.waiting = [];
  net.release = () => {
    net.hang = false;
    for (const go of net.waiting.splice(0)) go();
  };
  net.answer = (request) => {
    const path = new URL(request.url).pathname;
    if (!Object.hasOwn(files, path)) {
      return new Response("missing", { status: 404 });
    }
    // like a real server, a Range request gets a 206
    const range = /^bytes=(\d+)-(\d*)$/.exec(
      request.headers.get("range") ?? "",
    );
    if (range !== null) {
      const end = range[2] === "" ? undefined : Number(range[2]) + 1;
      return new Response(files[path].slice(Number(range[1]), end), {
        status: 206,
      });
    }
    const headers = new Headers({
      "content-length": String(files[path].length),
    });
    for (const [name, value] of Object.entries(net.headers)) {
      if (value === null) headers.delete(name);
      else headers.set(name, value);
    }
    return new Response(files[path], { status: 200, headers });
  };
  net.headers = {}; // set on every 200; null removes one
  return net;
}

function loadWorker(files, caches = new FakeCaches()) {
  const listeners = new Map();
  const windows = { open: [], controlled: [] }; // client ids
  const self = {
    location: new URL(SCOPE + "sw.js"),
    registration: { scope: SCOPE },
    clients: {
      claim: () => {
        windows.controlled = [...windows.open];
        return Promise.resolve();
      },
      matchAll: (options) =>
        Promise.resolve(
          (options?.includeUncontrolled ? windows.open : windows.controlled)
            .map((id) => ({ id })),
        ),
    },
    skipWaiting: () => Promise.resolve(),
    addEventListener: (type, fn) => listeners.set(type, fn),
  };
  const net = makeNet({ ...files }); // tests change files; keep FILES as written
  new Function("self", "caches", "fetch", SW_SOURCE)(self, caches, net.fetch);
  const background = []; // fetch events' waitUntil promises

  const extendable = () => {
    const waits = [];
    return { waits, waitUntil: (p) => waits.push(p) };
  };

  return {
    self,
    caches,
    net,
    windows,
    background,
    settle: () => Promise.all(background.splice(0)),
    async lifecycle(type, extra = {}) {
      const ev = { ...extendable(), ...extra };
      listeners.get(type)(ev);
      await Promise.all(ev.waits);
    },
    // Resolves to the worker's Response, or null if it didn't respond
    fetch(request, clientId = "page") {
      let answer = null;
      listeners.get("fetch")({
        request,
        clientId,
        waitUntil: (p) => background.push(p),
        respondWith: (p) => {
          answer = p;
        },
      });
      return answer === null ? Promise.resolve(null) : Promise.resolve(answer);
    },
  };
}

// Deno's Request refuses mode 'navigate'; the worker reads only these fields
function navigation(url) {
  return { url, method: "GET", mode: "navigate", headers: new Headers() };
}

const FILES = {
  "/game/": "<html>shell</html>",
  "/game/index.html": "<html>shell</html>",
  "/game/main.js": "main",
  "/game/manifest.webmanifest": "{}",
  "/game/static/pak0.pak": "PACK-shareware",
  "/game/src/host.js": "host",
  "/game/src/late.js": "late",
  "/game/static/maps/mymap.bsp": "bsp",
};

Deno.test("sw: routes each kind of request", () => {
  const w = loadWorker(FILES);
  const route = (url, init) => w.self.SW_Route(new Request(url, init));
  const range = { headers: { Range: "bytes=0-11" } };

  const cases = [
    [SCOPE + "static/pak0.pak", range, "pak0"],
    [SCOPE + "static/pak0.pak", undefined, "pak0"],
    [SCOPE + "static/pak1.pak", range, "passthrough"],
    [SCOPE + "static/rerelease/id1/pak0.pak", range, "passthrough"],
    [
      SCOPE + "static/music/track02.ogg",
      { headers: { Range: "bytes=0-" } },
      "music",
    ],
    [SCOPE + "static/music/track11.MP3", undefined, "music"],
    // other game directories' music is never cached, with Range or without
    [SCOPE + "static/hipnotic/music/track02.ogg", undefined, "passthrough"],
    [SCOPE + "static/rerelease/id1/music/track02.ogg", range, "passthrough"],
    [SCOPE + "static/music/x/music/track02.ogg", undefined, "passthrough"],
    [ORIGIN + "/static/music/track02.ogg", undefined, "passthrough"],
    // not a CD track: handled as before
    [SCOPE + "sound/music/theme.wav", undefined, "network"],
    [SCOPE + "static/clip.ogg", range, "passthrough"],
    [SCOPE + "src/host.js", undefined, "network"],
    [SCOPE + "?room=abc", undefined, "network"],
    [ORIGIN + "/elsewhere/x.js", undefined, null],
    [SCOPE + "src/host.js", { method: "POST", body: "x" }, null],
    [
      "https://cdn.jsdelivr.net/npm/three@0.183.0/build/three.module.js",
      undefined,
      "immutable",
    ],
    [
      "https://cdn.jsdelivr.net/npm/nipplejs@1.0.4/dist/index.mjs",
      undefined,
      "immutable",
    ],
    [
      "https://cdn.jsdelivr.net/npm/three/build/three.module.js",
      undefined,
      null,
    ],
    [
      "https://cdn.jsdelivr.net/npm/three@latest/build/three.module.js",
      undefined,
      null,
    ],
    ["https://challenges.cloudflare.com/turnstile/v0/api.js", undefined, null],
  ];

  for (const [url, init, expected] of cases) {
    const got = route(url, init);
    if (got !== expected) {
      fail(`${url} ${JSON.stringify(init)}: expected ${expected}, got ${got}`);
    }
  }
});

Deno.test("sw: install precaches the shell and pak0, and an offline launch still loads", async () => {
  const w = loadWorker(FILES);
  await w.lifecycle("install");
  await w.lifecycle("activate");

  w.net.online = false;

  // pak.js probes with Range: bytes=0-11 and takes a 200 as the whole pak
  const pak = await w.fetch(
    new Request(SCOPE + "static/pak0.pak", {
      headers: { Range: "bytes=0-11" },
    }),
  );
  if (pak.status !== 200) fail("pak0 status " + pak.status);
  if (await pak.text() !== "PACK-shareware") fail("pak0 body");
  if (pak.headers.get("content-length") !== "14") {
    fail("pak0 content-length (the progress bar reads it)");
  }

  // pak1 isn't there offline: a 404 so COM_AddPakSequence stops cleanly
  const pak1 = await w.fetch(
    new Request(SCOPE + "static/pak1.pak", {
      headers: { Range: "bytes=0-11" },
    }),
  );
  if (pak1.status !== 404) fail("pak1 offline status " + pak1.status);

  // A shared room link opens the cached shell
  const nav = await w.fetch(navigation(SCOPE + "?room=abc"));
  if (nav.status !== 200 || await nav.text() !== "<html>shell</html>") {
    fail("offline navigation");
  }

  const main = await w.fetch(new Request(SCOPE + "main.js"));
  if (await main.text() !== "main") fail("offline main.js");

  const unknown = await w.fetch(new Request(SCOPE + "src/never_loaded.js"));
  if (unknown.status !== 404) {
    fail("uncached module offline should 404, got " + unknown.status);
  }
});

Deno.test("sw: pak0 is fetched whole once, without the Range header", async () => {
  const w = loadWorker(FILES);
  const first = await w.fetch(
    new Request(SCOPE + "static/pak0.pak", {
      headers: { Range: "bytes=0-11" },
    }),
  );
  if (first.status !== 200 || await first.text() !== "PACK-shareware") {
    fail("first pak0 answer");
  }
  const second = await w.fetch(new Request(SCOPE + "static/pak0.pak"));
  if (await second.text() !== "PACK-shareware") fail("second pak0 answer");

  const pakFetches = w.net.requests.filter((r) => r.url.endsWith("pak0.pak"));
  if (pakFetches.length !== 1) {
    fail("pak0 fetched " + pakFetches.length + " times");
  }
  if (pakFetches[0].range !== null) {
    fail("pak0 fetched with Range " + pakFetches[0].range);
  }
});

Deno.test("sw: code is network first, and the cache follows the server", async () => {
  const w = loadWorker(FILES);
  let r = await w.fetch(new Request(SCOPE + "src/host.js"));
  if (await r.text() !== "host") fail("first fetch");

  w.net.files["/game/src/host.js"] = "host v2";
  r = await w.fetch(new Request(SCOPE + "src/host.js"));
  if (await r.text() !== "host v2") fail("online fetch must reach the server");

  w.net.online = false;
  r = await w.fetch(new Request(SCOPE + "src/host.js"));
  if (await r.text() !== "host v2") {
    fail("offline must serve the last copy fetched");
  }

  // A 404 is never cached
  w.net.online = true;
  r = await w.fetch(new Request(SCOPE + "static/maps/missing.bsp"));
  if (r.status !== 404) fail("missing map status");
  const cache = await w.caches.open(w.self.SW_CACHE_NAME);
  if (cache.entries.has(SCOPE + "static/maps/missing.bsp")) {
    fail("404 was cached");
  }
});

Deno.test("sw: cache-urls caches what the page loaded, skipping foreign URLs and other paks", async () => {
  const w = loadWorker(FILES);
  await w.lifecycle("message", {
    data: {
      type: "cache-urls",
      urls: [
        SCOPE + "src/late.js",
        SCOPE + "static/pak1.pak",
        "https://example.com/tracker.js",
        42,
        "not a url",
      ],
    },
  });

  const cache = await w.caches.open(w.self.SW_CACHE_NAME);
  if (!cache.entries.has(SCOPE + "src/late.js")) fail("src/late.js not cached");
  for (const key of cache.entries.keys()) {
    if (key.includes("pak1") || key.includes("example.com")) {
      fail("cached " + key);
    }
  }

  // Junk messages are ignored
  await w.lifecycle("message", { data: null });
  await w.lifecycle("message", { data: { type: "cache-urls", urls: "x" } });
});

Deno.test("sw: activate drops older icaro caches only", async () => {
  const w = loadWorker(FILES);
  await w.caches.open("icaro-v0");
  await w.caches.open("someone-else");
  await w.lifecycle("activate");
  const names = await w.caches.keys();
  if (names.includes("icaro-v0")) fail("old cache kept");
  if (!names.includes("someone-else")) fail("foreign cache deleted");
});

Deno.test("sw: pinned CDN modules are cache first; errors are not cached", async () => {
  const w = loadWorker(FILES);
  const three =
    "https://cdn.jsdelivr.net/npm/three@0.183.0/build/three.module.js";
  w.net.files["/npm/three@0.183.0/build/three.module.js"] = "three";

  let r = await w.fetch(new Request(three));
  if (await r.text() !== "three") fail("first CDN fetch");
  w.net.online = false;
  r = await w.fetch(new Request(three));
  if (await r.text() !== "three") fail("offline CDN fetch from cache");

  w.net.online = true;
  const missing = "https://cdn.jsdelivr.net/npm/three@0.183.0/build/nope.js";
  r = await w.fetch(new Request(missing));
  if (r.status !== 404) fail("missing CDN file status");
  const cache = await w.caches.open(w.self.SW_CACHE_NAME);
  if (cache.entries.has(missing)) fail("CDN 404 was cached");
});

Deno.test("sw: a hanging network falls back to the cached copy after the timeout", async () => {
  const w = loadWorker(FILES);
  await w.fetch(new Request(SCOPE + "src/host.js")); // cached now
  w.self.SW_SetNetworkTimeout(20);

  w.net.hang = true;
  const r = await w.fetch(new Request(SCOPE + "src/host.js"));
  if (await r.text() !== "host") {
    fail("hanging fetch should serve the cached copy");
  }

  // Nothing cached: keep waiting for the network
  let settled = false;
  const pending = w.fetch(new Request(SCOPE + "src/late.js")).then((resp) => {
    settled = true;
    return resp;
  });
  await new Promise((resolve) => setTimeout(resolve, 60));
  if (settled) fail("an uncached module must wait for the network");
  w.net.release();
  if (await (await pending).text() !== "late") {
    fail("late module after release");
  }
});

const TRACK_PATH = "/game/static/music/track02.ogg";
const TRACK_URL = ORIGIN + TRACK_PATH;
const TRACK = "0123456789";
const MUSIC_FILES = { ...FILES, [TRACK_PATH]: TRACK };

function trackRequest(range) {
  return new Request(
    TRACK_URL,
    range === undefined ? undefined : { headers: { Range: range } },
  );
}

async function musicEntries(w) {
  const cache = await w.caches.open(w.self.SW_MUSIC_CACHE_NAME);
  return cache.entries;
}

async function expectResponse(response, status, body, headers = {}) {
  const got = await response.text();
  if (response.status !== status || got !== body) {
    fail(`expected ${status} "${body}", got ${response.status} "${got}"`);
  }
  for (const [name, value] of Object.entries(headers)) {
    if (response.headers.get(name) !== value) {
      fail(`${name}: expected ${value}, got ${response.headers.get(name)}`);
    }
  }
}

Deno.test("sw: an uncached track streams by Range and is fetched whole behind it", async () => {
  const w = loadWorker(MUSIC_FILES);
  await expectResponse(await w.fetch(trackRequest("bytes=0-3")), 206, "0123");
  await w.settle();

  const ranges = w.net.requests.map((r) => r.range);
  if (JSON.stringify(ranges) !== '["bytes=0-3",null]') {
    fail("expected the page's Range request, then a whole fetch: " + ranges);
  }
  const entry = (await musicEntries(w)).get(TRACK_URL);
  if (entry === undefined || entry.status !== 200) fail("track not cached");
  const main = await w.caches.open(w.self.SW_CACHE_NAME);
  if (main.entries.size !== 0) fail("music went into the main cache");

  // cached: no more requests, online or not
  await expectResponse(await w.fetch(trackRequest("bytes=4-")), 206, "456789");
  if (w.net.requests.length !== 2) fail("a cached track reached the network");
});

Deno.test("sw: a cached track answers Range requests offline", async () => {
  const w = loadWorker(MUSIC_FILES);
  w.net.headers = { "content-type": "audio/ogg" };
  await w.fetch(trackRequest("bytes=0-"));
  await w.settle();
  w.net.online = false;

  const cases = [
    ["bytes=0-", "0123456789", "bytes 0-9/10"],
    ["bytes=0-1", "01", "bytes 0-1/10"], // Safari's probe
    ["bytes=3-6", "3456", "bytes 3-6/10"],
    ["bytes=8-500", "89", "bytes 8-9/10"],
    ["bytes=-3", "789", "bytes 7-9/10"],
    ["bytes=-500", "0123456789", "bytes 0-9/10"],
  ];
  for (const [range, body, contentRange] of cases) {
    await expectResponse(await w.fetch(trackRequest(range)), 206, body, {
      "content-range": contentRange,
      "content-length": String(body.length),
      "content-type": "audio/ogg",
      "accept-ranges": "bytes",
    });
  }

  for (const range of ["bytes=10-", "bytes=-0"]) {
    await expectResponse(await w.fetch(trackRequest(range)), 416, "", {
      "content-range": "bytes */10",
    });
  }

  // no Range, or one that is ignored: the whole track
  const whole = [undefined, "bytes=0-1,4-5", "bytes=6-3", "bytes=-", "x=1-2"];
  for (const range of whole) {
    await expectResponse(await w.fetch(trackRequest(range)), 200, TRACK);
  }
});

// The fake network's last response, to tell it from one the worker built
function spyNetwork(w) {
  const spy = { last: null };
  const answer = w.net.answer;
  w.net.answer = (request) => (spy.last = answer(request));
  return spy;
}

// A browser's network response has a URL, and clone() keeps it
function withURL(response, url) {
  return Object.defineProperties(response, {
    url: { value: url },
    clone: {
      value: () => withURL(Response.prototype.clone.call(response), url),
    },
  });
}

Deno.test("sw: a streamed track is passed on as the worker's own Response", async () => {
  // Chromium can't mix the network's response with ones cut from the cache
  const w = loadWorker(MUSIC_FILES);
  const answer = w.net.answer;
  w.net.answer = (request) => withURL(answer(request), request.url);
  const got = await w.fetch(trackRequest("bytes=0-3"));
  if (got.url !== "") fail("the network's response was passed through");
  await expectResponse(got, 206, "0123");
});

Deno.test("sw: a page claimed mid-load is network first until reloaded", async () => {
  const w = loadWorker(MUSIC_FILES);
  w.windows.open = ["first-visit"];
  await w.lifecycle("activate");
  // opened since, then this worker's next version activates
  w.windows.open = ["first-visit", "updated"];
  w.windows.controlled = ["first-visit", "updated"];
  await w.lifecycle("activate");

  const spy = spyNetwork(w);
  const range = () => trackRequest("bytes=0-3");
  const got = await w.fetch(range(), "first-visit");
  if (got !== spy.last) fail("claimed page: not the network's own response");
  await w.settle();
  if (!(await musicEntries(w)).has(TRACK_URL)) fail("track not cached");

  // cached now, and still from the network
  await w.fetch(range(), "first-visit");
  await w.settle();
  const ranged = w.net.requests.filter((r) => r.range !== null).length;
  if (ranged !== 2) fail("claimed page served from the cache while online");

  for (const id of ["updated", "next-load"]) {
    await w.fetch(range(), id);
  }
  if (w.net.requests.filter((r) => r.range !== null).length !== 2) {
    fail("other pages must be cache first");
  }

  // a restarted worker remembers, and so does the next version's activate
  const restarted = loadWorker(MUSIC_FILES, w.caches);
  restarted.windows.open = ["first-visit"];
  restarted.windows.controlled = ["first-visit"];
  await restarted.lifecycle("activate");
  const again = loadWorker(MUSIC_FILES, w.caches);
  await again.fetch(range(), "first-visit");
  if (again.net.requests.length === 0) fail("claimed page forgotten");

  // offline, the cache is all there is
  again.net.online = false;
  await expectResponse(await again.fetch(range(), "first-visit"), 206, "0123");
});

Deno.test("sw: with a saved list, an uncontrolled page is noted before claim", async () => {
  // e.g. registered again after ?sw=off, which leaves the caches
  const w = loadWorker(MUSIC_FILES);
  await w.lifecycle("activate"); // saves an empty list
  w.windows.open = ["returned"];
  await w.lifecycle("activate");
  const spy = spyNetwork(w);
  const got = await w.fetch(trackRequest("bytes=0-3"), "returned");
  if (got !== spy.last) fail("not the network's own response");
});

Deno.test("sw: replacing a worker with no list claims the pages it controlled", async () => {
  const w = loadWorker(MUSIC_FILES);
  w.windows.open = ["old-worker-page"];
  w.windows.controlled = ["old-worker-page"];
  await w.lifecycle("activate");
  const spy = spyNetwork(w);
  const got = await w.fetch(trackRequest("bytes=0-3"), "old-worker-page");
  if (got !== spy.last) fail("not the network's own response");
});

Deno.test("sw: one whole fetch per track, however many requests", async () => {
  const w = loadWorker(MUSIC_FILES);
  await Promise.all([
    w.fetch(trackRequest("bytes=0-")),
    w.fetch(trackRequest("bytes=5-")),
  ]);
  await w.settle();
  const whole = w.net.requests.filter((r) => r.range === null);
  if (whole.length !== 1) fail("whole fetches: " + whole.length);
});

Deno.test("sw: a missing or offline track is a 404 and is not cached", async () => {
  const w = loadWorker(MUSIC_FILES);
  const missing = new Request(SCOPE + "static/music/track03.ogg", {
    headers: { Range: "bytes=0-" },
  });
  if ((await w.fetch(missing)).status !== 404) fail("missing track status");
  if (w.background.length !== 0) fail("a 404 started a whole fetch");

  w.net.online = false;
  if ((await w.fetch(trackRequest("bytes=0-"))).status !== 404) {
    fail("uncached track offline");
  }

  // a server that answers a missing file with its index page
  w.net.online = true;
  w.net.headers = { "content-type": "text/html" };
  await w.fetch(trackRequest("bytes=0-"));
  await w.settle();
  if ((await musicEntries(w)).size !== 0) fail("cached an HTML page");
});

Deno.test("sw: a track that doesn't fit streams but isn't stored", async () => {
  const MB = 1024 * 1024;
  const noLength = { "content-length": null };
  const room = { quota: 100 * MB, usage: MB };
  // leaves the reserve free for an empty file, not for the 10-byte track
  const full = { quota: 100 * MB, usage: 50 * MB - 5 };
  const cases = [
    ["over the per-track cap", { "content-length": String(65 * MB) }, null, 0],
    ["would eat the reserve", {}, full, 0],
    ["no content-length, no room", noLength, full, 0],
    ["room", {}, room, 1],
    ["no content-length, room", noLength, room, 1],
  ];
  for (const [name, headers, estimate, stored] of cases) {
    const w = loadWorker(MUSIC_FILES);
    w.net.headers = headers;
    if (estimate !== null) {
      w.self.navigator = {
        storage: { estimate: () => Promise.resolve(estimate) },
      };
    }
    await expectResponse(await w.fetch(trackRequest("bytes=0-1")), 206, "01");
    await w.settle();
    const entries = await musicEntries(w);
    if (entries.size !== stored) fail(`${name}: ${entries.size} stored`);

    // neither a stored track nor one that didn't fit is downloaded again
    await w.fetch(trackRequest("bytes=2-3"));
    await w.settle();
    const whole = w.net.requests.filter((r) => r.range === null).length;
    if (whole !== 1) fail(`${name}: ${whole} whole fetches`);
  }
});

Deno.test("sw: a full origin fails neither music nor code", async () => {
  const w = loadWorker(MUSIC_FILES);
  for (const name of [w.self.SW_CACHE_NAME, w.self.SW_MUSIC_CACHE_NAME]) {
    const cache = await w.caches.open(name);
    cache.put = () =>
      Promise.reject(new DOMException("full", "QuotaExceededError"));
  }

  await expectResponse(await w.fetch(trackRequest("bytes=0-1")), 206, "01");
  await w.settle();
  const code = await w.fetch(new Request(SCOPE + "src/host.js"));
  await expectResponse(code, 200, "host");
});

Deno.test("sw: cached music survives a new game cache", async () => {
  const w = loadWorker(MUSIC_FILES);
  await w.caches.open(w.self.SW_MUSIC_CACHE_NAME);
  await w.caches.open("icaro-music-v0");
  await w.lifecycle("activate");
  const names = await w.caches.keys();
  if (!names.includes(w.self.SW_MUSIC_CACHE_NAME)) fail("music cache dropped");
  if (names.includes("icaro-music-v0")) fail("old music cache kept");
});

Deno.test("sw: cache-urls stores music that started before the worker", async () => {
  const rerelease = "/game/static/rerelease/id1/music/track02.ogg";
  const w = loadWorker({
    ...MUSIC_FILES,
    [rerelease]: "registered",
    "/game/static/clip.ogg": "clip",
  });
  await w.lifecycle("message", {
    data: {
      type: "cache-urls",
      urls: [TRACK_URL, ORIGIN + rerelease, SCOPE + "static/clip.ogg"],
    },
  });
  const keys = [...(await musicEntries(w)).keys()];
  if (keys.length !== 1 || keys[0] !== TRACK_URL) fail("cached " + keys);
  const main = await w.caches.open(w.self.SW_CACHE_NAME);
  if (main.entries.size !== 0) fail("media in the main cache");
});
