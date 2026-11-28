// src/intro.js: the intro page that gates every game-data fetch on a
// person's click. fetch is replaced with a recorder for each test, so a
// test fails if anything is fetched before the click, and the page runs
// against a minimal stand-in for the DOM.

import {
  Intro_Decide,
  Intro_Describe,
  Intro_Gate,
  Intro_IsDevHost,
  Intro_LocalPaks,
  INTRO_PLAYED_KEY,
  Intro_Want,
} from "../src/intro.js";
import { LQ_Error, LQ_RELEASES } from "../src/librequake.js";
import { UD_CHOICE_KEY, UD_LQ_MANIFEST } from "../src/userdata.js";

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

class FakeElement {
  constructor(doc, tag) {
    this.doc = doc;
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parent = null;
    this.textContent = "";
    this.listeners = new Map();
    this.style = {};
    this.hidden = false;
    this.disabled = false;
    this.id = "";
    this.className = "";
    this.attributes = new Map();
  }
  appendChild(child) {
    child.parent = this;
    this.children.push(child);
    return child;
  }
  remove() {
    if (this.parent === null) return;
    this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }
  setAttribute(name, value) {
    this.attributes.set(name, value);
  }
  addEventListener(type, fn) {
    this.listeners.set(type, fn);
  }
  focus() {
    this.doc.focused = this;
  }
  // a click as the page gets it: ignored while disabled
  click() {
    if (this.disabled) return undefined;
    return this.listeners.get("click")?.();
  }
  *walk() {
    yield this;
    for (const c of this.children) yield* c.walk();
  }
}

function fakeDocument() {
  const doc = { focused: null };
  doc.createElement = (tag) => new FakeElement(doc, tag);
  doc.head = new FakeElement(doc, "head");
  doc.body = new FakeElement(doc, "body");
  doc.getElementById = (id) => {
    for (const root of [doc.head, doc.body]) {
      for (const el of root.walk()) if (el.id === id) return el;
    }
    return null;
  };
  doc.buttons = () =>
    [...doc.body.walk()].filter((el) =>
      el.tagName === "BUTTON" && el.hidden === false
    );
  doc.button = (pattern) => {
    const b = doc.buttons().find((el) => pattern.test(el.textContent));
    if (b === undefined) {
      throw new Error(
        "no button " + pattern + " in " +
          doc.buttons().map((el) => el.textContent).join(" | "),
      );
    }
    return b;
  };
  doc.text = () => [...doc.body.walk()].map((el) => el.textContent).join("\n");
  return doc;
}

// A store holding the given keys (see src/userdata.js)
function fakeStore(files = {}) {
  const map = new Map(Object.entries(files));
  return {
    list: () =>
      Promise.resolve([...map].map(([key, b]) => ({ key, size: b.size }))),
    get: (key) => Promise.resolve(map.get(key) ?? null),
    put: (key, blob) => {
      map.set(key, blob);
      return Promise.resolve();
    },
    remove: (key) => {
      map.delete(key);
      return Promise.resolve();
    },
  };
}

const INSTALLED = {
  [UD_LQ_MANIFEST]: new Blob([
    JSON.stringify({ version: "v0.09-beta", variant: "full", files: 60 }),
  ]),
};

function fakeEnv({ storage = {}, store = fakeStore(), install } = {}) {
  const local = new Map(Object.entries(storage));
  const env = {
    document: fakeDocument(),
    local,
    get: (k) => local.get(k) ?? null,
    set: (k, v) => local.set(k, v),
    remember: (base) => local.set(UD_CHOICE_KEY, base),
    openStore: () => Promise.resolve(store),
    installs: [],
    install: install ?? ((release, opts) => {
      env.installs.push(release);
      opts.onProgress("download", release.size, release.size);
      return Promise.resolve({});
    }),
    persist: () => {},
  };
  return env;
}

// Runs fn with fetch recording every call; returns the calls
async function withFetchRecorder(fn) {
  const calls = [];
  const saved = globalThis.fetch;
  globalThis.fetch = (input) => {
    calls.push(String(input?.url ?? input));
    return Promise.reject(new Error("no network in this test"));
  };
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = saved;
  }
  return calls;
}

// Lets the gate's awaits (store, manifest) run up to its page
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const params = (q) => new URLSearchParams(q);

Deno.test("Intro_Want: the URL's content, else the last pick, else LibreQuake", () => {
  const want = (q, choice = null, id1 = false) =>
    JSON.stringify(Intro_Want(params(q), choice, id1));
  const is = (base, named, missing) =>
    JSON.stringify(
      missing === undefined ? { base, named } : { base, named, missing },
    );
  // a fresh profile
  assert(want("") === is("librequake", false), "plain launch");
  assert(want("", "librequake") === is("librequake", false), "picked LQ");
  // remembered id's data: only with its pak0 stored
  assert(want("", "id1") === is("librequake", false), "id1 not stored");
  assert(want("", "id1", true) === is(null, false), "id1 stored");
  // ?base=id1
  assert(
    want("?base=id1") === is("librequake", true, true),
    "?base=id1, nothing stored",
  );
  assert(want("?base=id1", null, true) === is(null, true, false), "stored");
  assert(
    want("?game=hipnotic") === is("librequake", true, true),
    "mission pack, nothing stored",
  );
  assert(
    want("?game=hipnotic", null, true) === is(null, true, false),
    "mission pack, stored",
  );
  assert(want("?base=rerelease") === is("rerelease", true), "rerelease");
  assert(want("?base=librequake") === is("librequake", true), "?base=LQ");
  assert(want("?base=nope") === is("nope", true), "unknown base passed on");
  // rooms and map links start LibreQuake, even with id's data stored
  for (const q of ["?room=abc", "?agent=lockstep&map=lq_e1m1&skill=1"]) {
    for (const id1 of [false, true]) {
      assert(
        want(q, "id1", id1) === is("librequake", true, false),
        q + " id1=" + id1,
      );
    }
  }
  assert(
    want("?base=librequake&map=lq_e1m1") === is("librequake", true),
    "LibreQuake map link",
  );
});

Deno.test("Intro_Decide asks a first-time visitor whatever the URL says", () => {
  for (
    const q of ["", "?base=id1", "?room=abc", "?agent=lockstep&map=lq_e1m1"]
  ) {
    for (const installed of [false, true]) {
      for (const id1 of [false, true]) {
        const d = Intro_Decide({
          params: params(q),
          played: false,
          choice: null,
          installed,
          id1,
        });
        assert("ask" in d, q + " installed=" + installed + " asks");
      }
    }
  }
});

Deno.test("Intro_Decide lets a returning player through unless it must download", () => {
  const decide = (q, installed, choice = null, id1 = false) =>
    Intro_Decide({ params: params(q), played: true, choice, installed, id1 });
  assert(decide("", true).start === "librequake", "LibreQuake installed");
  assert("ask" in decide("", false), "LibreQuake not there: ask");
  assert(decide("", false, "id1", true).start === null, "picked id's data");
  assert(
    decide("", true, "id1").start === "librequake",
    "remembered id's data, none stored: LibreQuake",
  );
  assert(
    "ask" in decide("", false, "id1"),
    "remembered id's data, none stored, no LibreQuake: ask",
  );
  assert(decide("?game=rogue", false, null, true).start === null, "pack");
  assert("ask" in decide("?base=librequake", false), "LQ link, not there");
  assert(
    decide("?room=abc", true, "id1", true).start === "librequake",
    "room",
  );
  // a link to id's data with none stored always shows its page, even with
  // LibreQuake installed, and never starts id's data
  const d = decide("?base=id1", true);
  assert("ask" in d && d.ask.missing === true, "?base=id1, nothing stored");
  assert(decide("?base=id1", true, null, true).start === null, "stored");
});

Deno.test("Intro_Describe names what a link starts", () => {
  assert(
    Intro_Describe(params("?game=hipnotic")) === "Scourge of Armagon",
    "h",
  );
  assert(Intro_Describe(params("?room=x")) === "a multiplayer game", "room");
  assert(
    Intro_Describe(params("?base=rerelease&game=mg1")) ===
      "Quake (2021 rerelease): Dimension of the Machine",
    "mg1",
  );
  assert(Intro_Describe(params("?game=quoth")) === "Quoth", "quoth");
  assert(
    Intro_Describe(params("?base=rerelease&game=quoth")) ===
      "Quake (2021 rerelease): Quoth",
    "quoth over the rerelease",
  );
  assert(Intro_Describe(params("?map=lq_e1m1")) === "LibreQuake", "map");
  assert(Intro_Describe(params("?base=id1")) === "Quake", "id's data");
});

Deno.test("Intro_Gate fetches nothing until a button is pressed", async () => {
  const env = fakeEnv();
  const calls = await withFetchRecorder(async (calls) => {
    let base;
    const gate = Intro_Gate(params(""), env).then((b) => {
      base = b;
    });
    await settle();
    await settle();
    assert(base === undefined, "waits for a person");
    assert(env.document.getElementById("intro") !== null, "page shown");
    assert(calls.length === 0, "fetched before the click: " + calls);
    assert(
      env.document.focused === env.document.buttons()[0],
      "first button focused",
    );
    const labels = env.document.buttons().map((b) => b.textContent);
    assert(
      !/shareware|Play Quake/.test(labels.join("|")),
      "no id button without id's pak0: " + labels.join("|"),
    );
    assert(!/shareware/i.test(env.document.text()), "no shareware text");

    env.document.button(/^Download LibreQuake/).click();
    await gate;
    assert(base === "librequake", "LibreQuake");
    assert(env.document.getElementById("intro") === null, "page removed");
  });
  assert(calls.length === 0, "the gate itself fetches nothing: " + calls);
  assert(env.local.get(INTRO_PLAYED_KEY) === "1", "played remembered");
});

Deno.test("Intro_Gate downloads LibreQuake only when its button is pressed", async () => {
  const env = fakeEnv();
  await withFetchRecorder(async (calls) => {
    const gate = Intro_Gate(params(""), env);
    await settle();
    await settle();
    assert(env.installs.length === 0, "no download before the click");
    env.document.button(/^Download LibreQuake \(116 MB\)/).click();
    assert(await gate === "librequake", "LibreQuake starts");
    assert(env.installs[0] === LQ_RELEASES.full, "the full release");
    assert(calls.length === 0, "fetches go through env.install");
  });
  assert(env.local.get(UD_CHOICE_KEY) === "librequake", "choice");
});

Deno.test("Intro_Gate offers the first episode alone as the smaller download", async () => {
  const env = fakeEnv();
  const gate = Intro_Gate(params(""), env);
  await settle();
  await settle();
  env.document.button(/^First episode only \(56 MB\)/).click();
  assert(await gate === "librequake", "starts");
  assert(env.installs[0] === LQ_RELEASES.lite, "the lite release");
});

Deno.test("Intro_Gate keeps the page up after a failed download, and can retry", async () => {
  let tries = 0;
  const env = fakeEnv({
    install: () => {
      tries++;
      return tries === 1 ?
        Promise.reject(
          new LQ_Error(
            "http",
            "the download isn't available from this site yet",
          ),
        ) :
        Promise.resolve({});
    },
  });
  let base;
  const gate = Intro_Gate(params(""), env).then((b) => {
    base = b;
  });
  await settle();
  await settle();
  const download = env.document.button(/^Download LibreQuake/);
  await download.click();
  await settle();
  assert(base === undefined, "still waiting");
  assert(/isn't available/.test(env.document.text()), "explains the failure");
  assert(download.disabled === false, "buttons back");
  await download.click();
  await gate;
  assert(base === "librequake", "second try starts");
});

Deno.test("Intro_Gate: a returning player with LibreQuake goes straight in", async () => {
  const env = fakeEnv({
    storage: { [INTRO_PLAYED_KEY]: "1" },
    store: fakeStore(INSTALLED),
  });
  const calls = await withFetchRecorder(async () => {
    assert(await Intro_Gate(params(""), env) === "librequake", "LibreQuake");
  });
  assert(env.document.getElementById("intro") === null, "no page");
  assert(calls.length === 0, "nothing fetched");
});

Deno.test("Intro_Gate: a link that names its content gets one Play button", async () => {
  const env = fakeEnv({ store: fakeStore(INSTALLED) });
  const gate = Intro_Gate(params("?room=abc"), env);
  await settle();
  await settle();
  assert(/multiplayer game/.test(env.document.text()), "says what it starts");
  const labels = env.document.buttons().map((b) => b.textContent);
  assert(
    labels.join("|") === "Play LibreQuake",
    "buttons: " + labels.join("|"),
  );
  env.document.button(/^Play LibreQuake$/).click();
  assert(await gate === "librequake", "LibreQuake for a lobby room");
  assert(!env.local.has(UD_CHOICE_KEY), "a link's content isn't remembered");
});

Deno.test("Intro_Gate: ?base=id1 with nothing stored says so and offers LibreQuake", async () => {
  const env = fakeEnv({
    storage: { [INTRO_PLAYED_KEY]: "1" },
    store: fakeStore(INSTALLED),
  });
  const gate = Intro_Gate(params("?base=id1"), env);
  await settle();
  await settle();
  assert(env.document.getElementById("intro") !== null, "page shown");
  assert(/aren't in this browser/.test(env.document.text()), "says so");
  assert(/Game data/.test(env.document.text()), "says where to add them");
  const labels = env.document.buttons().map((b) => b.textContent);
  assert(labels.join("|") === "Play LibreQuake", labels.join("|"));
  env.document.button(/^Play LibreQuake$/).click();
  assert(await gate === "librequake", "LibreQuake, never id's data");
});

Deno.test("Intro_Gate: ?base=id1 with pak0 stored plays id's data", async () => {
  const env = fakeEnv({
    storage: { [INTRO_PLAYED_KEY]: "1" },
    store: fakeStore({ "static/pak0.pak": new Blob(["PACK"]) }),
  });
  assert(await Intro_Gate(params("?base=id1"), env) === null, "id's data");
  assert(env.document.getElementById("intro") === null, "no page");
});

Deno.test("Intro_Gate: remembered id's data with nothing stored falls back to LibreQuake", async () => {
  const env = fakeEnv({
    storage: { [INTRO_PLAYED_KEY]: "1", [UD_CHOICE_KEY]: "id1" },
    store: fakeStore(INSTALLED),
  });
  assert(await Intro_Gate(params(""), env) === "librequake", "LibreQuake");
  assert(env.document.getElementById("intro") === null, "no page");
});

Deno.test("Intro_Gate offers Quake by name when id1's pak0 is stored", async () => {
  const env = fakeEnv({
    store: fakeStore({ "static/pak0.pak": new Blob(["PACK"]) }),
  });
  const gate = Intro_Gate(params(""), env);
  await settle();
  await settle();
  env.document.button(/^Play Quake$/).click();
  assert(await gate === null, "id's data");
  assert(env.local.get(UD_CHOICE_KEY) === "id1", "choice remembered");
});

Deno.test("Intro_Gate offers registered Quake by name when pak1 is stored too", async () => {
  const env = fakeEnv({
    store: fakeStore({
      "static/pak0.pak": new Blob(["PACK"]),
      "static/pak1.pak": new Blob(["PACK"]),
    }),
  });
  const gate = Intro_Gate(params(""), env);
  await settle();
  await settle();
  env.document.button(/^Play Quake \(registered\)$/).click();
  assert(await gate === null, "id's data");
});

// A fetch that answers HEAD with each path's { status, type }, recording calls
function headFetch(answers) {
  const calls = [];
  const fetch = (path, init) => {
    calls.push({ path, method: init?.method });
    const a = answers[path];
    if (a === undefined) return Promise.reject(new Error("refused"));
    return Promise.resolve(
      new Response(null, {
        status: a.status,
        headers: { "content-type": a.type ?? "application/octet-stream" },
      }),
    );
  };
  return { fetch, calls };
}

Deno.test("Intro_IsDevHost: this machine only", () => {
  for (const h of ["localhost", "127.0.0.1", "[::1]"]) {
    assert(Intro_IsDevHost(h), h);
  }
  for (
    const h of [
      "quake.anglezarke.games",
      "localhost.example.com",
      "app.localhost",
      "127.0.0.2",
      "192.168.1.2",
      "::1",
      "",
    ]
  ) {
    assert(Intro_IsDevHost(h) === false, h);
  }
});

Deno.test("Intro_LocalPaks asks nothing on another host", async () => {
  const f = headFetch({ "static/pak0.pak": { status: 200 } });
  const local = await Intro_LocalPaks("quake.anglezarke.games", f.fetch);
  assert(local.pak0 === false && local.pak1 === false, "none");
  assert(f.calls.length === 0, "no request: " + JSON.stringify(f.calls));
});

Deno.test("Intro_LocalPaks: HEAD for static/'s id1 paks on a dev host", async () => {
  let f = headFetch({
    "static/pak0.pak": { status: 200 },
    "static/pak1.pak": { status: 200 },
  });
  let local = await Intro_LocalPaks("localhost", f.fetch);
  assert(local.pak0 && local.pak1, "both: " + JSON.stringify(local));
  assert(f.calls.every((c) => c.method === "HEAD"), "HEAD only");
  assert(
    f.calls.map((c) => c.path).join(" ") === "static/pak0.pak static/pak1.pak",
    "paths",
  );

  f = headFetch({ "static/pak0.pak": { status: 200 } });
  local = await Intro_LocalPaks("127.0.0.1", f.fetch);
  assert(local.pak0 && local.pak1 === false, "pak0 alone");

  // no pak0: pak1 isn't asked about
  f = headFetch({
    "static/pak0.pak": { status: 404 },
    "static/pak1.pak": { status: 200 },
  });
  local = await Intro_LocalPaks("[::1]", f.fetch);
  assert(local.pak0 === false && local.pak1 === false, "404");
  assert(f.calls.length === 1, "pak1 not asked");

  // a server's HTML fallback for a missing file
  f = headFetch({ "static/pak0.pak": { status: 200, type: "text/html" } });
  local = await Intro_LocalPaks("localhost", f.fetch);
  assert(local.pak0 === false, "HTML isn't a pak");

  // the request fails
  f = headFetch({});
  local = await Intro_LocalPaks("localhost", f.fetch);
  assert(local.pak0 === false, "network error");
});

Deno.test("Intro_Gate offers Quake from static/ on a dev host with nothing stored", async () => {
  const env = fakeEnv();
  env.localPaks = () => Promise.resolve({ pak0: true, pak1: true });
  const gate = Intro_Gate(params(""), env);
  await settle();
  await settle();
  env.document.button(/^Play Quake \(registered\)$/).click();
  assert(await gate === null, "id's data");
});

Deno.test("Intro_Gate: ?base=id1 plays static/'s paks on a dev host", async () => {
  const env = fakeEnv({ storage: { [INTRO_PLAYED_KEY]: "1" } });
  env.localPaks = () => Promise.resolve({ pak0: true, pak1: false });
  assert(await Intro_Gate(params("?base=id1"), env) === null, "id's data");
  assert(env.document.getElementById("intro") === null, "no page");
});

Deno.test("Intro_Gate doesn't ask static/ when id1's pak0 is stored", async () => {
  let asked = false;
  const env = fakeEnv({
    storage: { [INTRO_PLAYED_KEY]: "1" },
    store: fakeStore({ "static/pak0.pak": new Blob(["PACK"]) }),
  });
  env.localPaks = () => {
    asked = true;
    return Promise.resolve({ pak0: false, pak1: false });
  };
  assert(await Intro_Gate(params("?base=id1"), env) === null, "id's data");
  assert(asked === false, "not asked");
});

Deno.test("Intro_Gate doesn't ask static/ when the URL names another base", async () => {
  let asked = false;
  const env = fakeEnv({ storage: { [INTRO_PLAYED_KEY]: "1" } });
  env.localPaks = () => {
    asked = true;
    return Promise.resolve({ pak0: true, pak1: true });
  };
  // the gate waits on LibreQuake's page; the probe would have run by now
  Intro_Gate(params("?base=librequake"), env);
  await settle();
  await settle();
  assert(asked === false, "not asked");
});

Deno.test("main.js waits on the intro page before it loads any game data", async () => {
  const src = await Deno.readTextFile(new URL("../main.js", import.meta.url));
  const body = src.slice(src.indexOf("async function main()"));
  const gate = body.indexOf("await Intro_Gate(");
  assert(gate > 0, "main() calls Intro_Gate");
  for (
    const loader of [
      "UD_MountPaks(",
      "COM_AddPakSequence(",
      "COM_AddGameDirectory(",
      "Host_Init(",
    ]
  ) {
    const at = body.indexOf(loader);
    assert(at > gate, loader + " runs after the gate");
  }
});

Deno.test("index.html and deno.json load the same pinned zip.js", async () => {
  const html = await Deno.readTextFile(
    new URL("../index.html", import.meta.url),
  );
  const map = JSON.parse(
    /<script type="importmap">([\s\S]*?)<\/script>/.exec(html)[1],
  );
  const url = map.imports["@zip.js/zip.js"];
  assert(/@zip\.js\/zip\.js@\d+\.\d+\.\d+\//.test(url), "pinned: " + url);
  assert(/^sha384-/.test(map.integrity[url]), "integrity for " + url);
  for (const path of ["../deno.json", "../server/deno.json"]) {
    const json = JSON.parse(
      await Deno.readTextFile(new URL(path, import.meta.url)),
    );
    assert(json.imports["@zip.js/zip.js"] === url, path + " matches");
  }
});
