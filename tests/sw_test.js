// Tests for sw.js, the offline service worker. It runs here against fake
// self, caches and fetch: the routing table, offline answers for pak0 (with
// the loader's Range probe), network-first code, and the page's cache-urls
// message.

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
    return new Response(files[path], {
      status: 200,
      headers: { "content-length": String(files[path].length) },
    });
  };
  return net;
}

function loadWorker(files) {
  const listeners = new Map();
  const self = {
    location: new URL(SCOPE + "sw.js"),
    registration: { scope: SCOPE },
    clients: { claim: () => Promise.resolve() },
    skipWaiting: () => Promise.resolve(),
    addEventListener: (type, fn) => listeners.set(type, fn),
  };
  const caches = new FakeCaches();
  const net = makeNet({ ...files }); // tests change files; keep FILES as written
  new Function("self", "caches", "fetch", SW_SOURCE)(self, caches, net.fetch);

  const extendable = () => {
    const waits = [];
    return { waits, waitUntil: (p) => waits.push(p) };
  };

  return {
    self,
    caches,
    net,
    async lifecycle(type, extra = {}) {
      const ev = { ...extendable(), ...extra };
      listeners.get(type)(ev);
      await Promise.all(ev.waits);
    },
    // Resolves to the worker's Response, or null if it didn't respond
    fetch(request) {
      let answer = null;
      listeners.get("fetch")({
        request,
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
  "/game/static/maps/edc.bsp": "bsp",
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
      "passthrough",
    ],
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

Deno.test("sw: cache-urls skips streamed music", async () => {
  const w = loadWorker({ ...FILES, "/game/static/music/track02.ogg": "ogg" });
  await w.lifecycle("message", {
    data: { type: "cache-urls", urls: [SCOPE + "static/music/track02.ogg"] },
  });
  const cache = await w.caches.open(w.self.SW_CACHE_NAME);
  if (cache.entries.size !== 0) fail("music was cached");
});
