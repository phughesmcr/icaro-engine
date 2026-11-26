// src/librequake.js: the LibreQuake download (resume, hash check) and its
// unpacking with zip.js into the browser's store. The store is an in-memory
// stand-in for userdata.js's OPFS and IndexedDB stores, and the zips are
// built here with zip.js's own writer.

import * as zip from "@zip.js/zip.js";
import {
  LQ_Download,
  LQ_EntryPath,
  LQ_Error,
  LQ_Extract,
  LQ_Install,
  LQ_Installed,
  LQ_PART_BYTES,
  LQ_Parts,
  LQ_RELEASES,
  LQ_Sha256,
} from "../src/librequake.js";
import { UD_LQ_MANIFEST, UD_LQ_PARTS, UD_LQ_PREFIX } from "../src/userdata.js";

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

// The store interface of src/userdata.js (list, get, put, remove)
function memoryStore(quotaBytes = Infinity) {
  const files = new Map();
  const used = () => [...files.values()].reduce((n, b) => n + b.size, 0);
  return {
    kind: "memory",
    files,
    list: () =>
      Promise.resolve(
        [...files].map(([key, blob]) => ({ key, size: blob.size })),
      ),
    get: (key) => Promise.resolve(files.get(key) ?? null),
    put: (key, blob) => {
      if (used() - (files.get(key)?.size ?? 0) + blob.size > quotaBytes) {
        const e = new Error("quota");
        e.name = "QuotaExceededError";
        return Promise.reject(e);
      }
      files.set(key, blob);
      return Promise.resolve();
    },
    remove: (key) => {
      files.delete(key);
      return Promise.resolve();
    },
  };
}

async function sha256(bytes) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

// A pak-sized file that doesn't compress, so the zip spans several download
// parts: "PACK" then bytes from a fixed xorshift sequence
const PAK_BYTES = LQ_PART_BYTES + 1024 * 1024;
const PAK = (() => {
  const pak = new Uint8Array(PAK_BYTES);
  let x = 2463534242;
  for (let i = 0; i < pak.length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    pak[i] = x & 0xff;
  }
  pak.set([0x50, 0x41, 0x43, 0x4b]);
  return pak;
})();

// A zip laid out like LibreQuake's release (full/id1/...), and a release
// record for it
async function makeRelease(extra = {}) {
  const writer = new zip.ZipWriter(new zip.Uint8ArrayWriter());
  const pak = PAK;
  const entries = {
    "full/id1/PAK0.PAK": pak,
    "full/id1/maps/lqdm1.bsp": new Uint8Array([29, 0, 0, 0]),
    "full/id1/music/track02.ogg": new TextEncoder().encode("OggS"),
    "full/id1/docs/COPYING": new TextEncoder().encode("BSD"),
    "full/id1/docs/branding/logo.png": new Uint8Array(10),
    "full/README.txt": new TextEncoder().encode("outside id1"),
    ...extra,
  };
  await writer.add("full/", undefined, { directory: true });
  for (const [name, data] of Object.entries(entries)) {
    await writer.add(name, new zip.Uint8ArrayReader(data));
  }
  const bytes = await writer.close();
  return {
    bytes,
    release: {
      ...LQ_RELEASES.full,
      size: bytes.length,
      sha256: await sha256(bytes),
      unpacked: 0,
    },
  };
}

// fetch for one file that honours a simple Range: bytes=N- and records each
// request. opts.ignoreRange answers 200 every time; opts.cutAt ends the
// first response's body with an error after that many bytes.
function fakeServer(bytes, opts = {}) {
  const requests = [];
  let first = true;
  const fetch = (url, init = {}) => {
    const range = init.headers?.Range ?? null;
    requests.push({ url, range });
    let start = 0;
    let status = 200;
    const headers = new Headers();
    if (range !== null && opts.ignoreRange !== true) {
      start = Number(/^bytes=(\d+)-$/.exec(range)[1]);
      status = 206;
      headers.set(
        "Content-Range",
        "bytes " + start + "-" + (bytes.length - 1) + "/" + bytes.length,
      );
    }
    const body = bytes.subarray(start);
    const cut = first && opts.cutAt !== undefined ? opts.cutAt : null;
    first = false;
    // in 64 KiB chunks, as a network body arrives (pulled, since erroring
    // a stream drops the chunks still queued in it)
    const end = cut !== null ? cut : body.length;
    let at = 0;
    const stream = new ReadableStream({
      pull(controller) {
        if (at < end) {
          controller.enqueue(body.slice(at, Math.min(end, at + 65536)));
          at += 65536;
        } else if (cut !== null) {
          controller.error(new TypeError("network lost"));
        } else {
          controller.close();
        }
      },
    });
    return Promise.resolve(new Response(stream, { status, headers }));
  };
  return { fetch, requests };
}

Deno.test("LQ_RELEASES pins the v0.09-beta zips by size and SHA-256", () => {
  const full = LQ_RELEASES.full;
  assert(full.size === 115678161, "full size");
  assert(
    full.sha256 ===
      "623e463b35811216244f9ba15e0c45abc1765288650b5e3d36a899b35e4bcf3d",
    "full sha256",
  );
  assert(LQ_RELEASES.lite.size === 55987573, "lite size");
  assert(Object.isFrozen(full), "frozen");
});

Deno.test("LQ_EntryPath keeps id1's files as plain lower-case paths", () => {
  const r = LQ_RELEASES.full;
  const cases = [
    ["full/id1/pak0.pak", "pak0.pak"],
    ["full/id1/PAK1.PAK", "pak1.pak"],
    ["full/id1/maps/lqdm1.bsp", "maps/lqdm1.bsp"],
    ["full/id1/music/track02.ogg", "music/track02.ogg"],
    ["full/id1/docs/COPYING", "docs/copying"],
    ["full/id1/docs/branding/icon.svg", null],
    ["full/id1/maps/", null],
    ["full/id1/", null],
    ["full/README.txt", null],
    ["lite/id1/pak0.pak", null],
    ["full/id1/../../evil.js", null],
    ["full/id1/.hidden", null],
    ["full/id1/maps/a b.bsp", null],
    ["full/id1/maps\\x.bsp", null],
  ];
  for (const [name, expected] of cases) {
    const got = LQ_EntryPath(name, r);
    assert(got === expected, name + ": expected " + expected + ", got " + got);
  }
});

Deno.test("LQ_Sha256 matches Web Crypto on the whole file", async () => {
  const bytes = new TextEncoder().encode("abc");
  assert(
    await LQ_Sha256(new Blob([bytes])) ===
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    "sha256 of abc",
  );
});

Deno.test("LQ_Extract stores id1's files from a zip.js archive", async () => {
  const { bytes, release } = await makeRelease();
  const store = memoryStore();
  const progress = [];
  const keys = await LQ_Extract(
    new Blob([bytes]),
    release,
    store,
    zip,
    (done, total) => progress.push([done, total]),
  );
  const expected = [
    "pak0.pak",
    "maps/lqdm1.bsp",
    "music/track02.ogg",
    "docs/copying",
  ].map((p) => UD_LQ_PREFIX + p);
  assert(
    JSON.stringify(keys.sort()) === JSON.stringify(expected.sort()),
    "stored keys " + keys.join(", "),
  );
  const pak = new Uint8Array(
    await (await store.get(UD_LQ_PREFIX + "pak0.pak")).arrayBuffer(),
  );
  assert(pak.length === PAK_BYTES, "pak size");
  assert(await sha256(pak) === await sha256(PAK), "pak bytes");
  const last = progress[progress.length - 1];
  assert(last[0] === last[1] && last[1] > PAK_BYTES, "progress total");
});

Deno.test("LQ_Download resumes from its stored parts with a Range request", async () => {
  const { bytes, release } = await makeRelease();
  assert(bytes.length > LQ_PART_BYTES, "test zip spans two parts");
  const store = memoryStore();
  // the first response breaks off part way through
  const cutAt = LQ_PART_BYTES + 12345;
  const server = fakeServer(bytes, { cutAt });
  let failed = false;
  try {
    await LQ_Download(store, release, { fetch: server.fetch, url: "z" });
  } catch (e) {
    failed = e instanceof TypeError;
  }
  assert(failed, "the cut is passed on");
  const kept = await LQ_Parts(store, release);
  assert(kept.bytes === cutAt, "kept " + kept.bytes + " of " + cutAt);
  assert(kept.parts.length === 2, "a whole part and the rest");

  const blob = await LQ_Download(store, release, {
    fetch: server.fetch,
    url: "z",
  });
  assert(server.requests[0].range === null, "first request whole");
  assert(
    server.requests[1].range === "bytes=" + cutAt + "-",
    "resume range " + server.requests[1].range,
  );
  assert(await LQ_Sha256(blob) === release.sha256, "resumed zip intact");
});

Deno.test("LQ_Download starts over when the server ignores Range", async () => {
  const { bytes, release } = await makeRelease();
  const store = memoryStore();
  const server = fakeServer(bytes, { cutAt: 100000, ignoreRange: true });
  await LQ_Download(store, release, { fetch: server.fetch, url: "z" })
    .catch(() => {});
  const blob = await LQ_Download(store, release, {
    fetch: server.fetch,
    url: "z",
  });
  assert(server.requests[1].range !== null, "asked for a range");
  assert(blob.size === bytes.length, "size " + blob.size);
  assert(await LQ_Sha256(blob) === release.sha256, "whole file");
});

Deno.test("LQ_Download explains a 404 and a file that runs long", async () => {
  const store = memoryStore();
  const notFound = () => Promise.resolve(new Response("no", { status: 404 }));
  let err = null;
  try {
    await LQ_Download(store, LQ_RELEASES.lite, { fetch: notFound, url: "z" });
  } catch (e) {
    err = e;
  }
  assert(err instanceof LQ_Error && err.kind === "http", "404 kind");
  assert(/isn't available/.test(err.message), err.message);

  const { bytes, release } = await makeRelease();
  const short = { ...release, size: bytes.length - 10 };
  err = null;
  try {
    await LQ_Download(store, short, {
      fetch: fakeServer(bytes).fetch,
      url: "z",
    });
  } catch (e) {
    err = e;
  }
  assert(err instanceof LQ_Error && err.kind === "hash", "overrun kind");
});

Deno.test("LQ_Install checks the hash, unpacks, then writes the manifest", async () => {
  const { bytes, release } = await makeRelease();
  const store = memoryStore();
  const phases = new Set();
  const manifest = await LQ_Install(release, {
    store,
    fetch: fakeServer(bytes).fetch,
    url: "z",
    zip,
    freeSpace: () => Promise.resolve(Infinity),
    onProgress: (phase) => phases.add(phase),
  });
  assert(manifest.variant === "full", "variant");
  assert((await LQ_Installed(store)).files === 4, "manifest stored");
  assert(store.files.has(UD_LQ_PREFIX + "pak0.pak"), "pak stored");
  assert(
    [...store.files.keys()].every((k) => !k.startsWith(UD_LQ_PARTS)),
    "parts removed once unpacked",
  );
  assert(
    phases.has("download") && phases.has("verify") && phases.has("unpack"),
    "phases " + [...phases].join(" "),
  );
});

Deno.test("LQ_Install refuses a zip whose hash differs and drops it", async () => {
  const { bytes, release } = await makeRelease();
  const store = memoryStore();
  const wrong = { ...release, sha256: "0".repeat(64) };
  let err = null;
  try {
    await LQ_Install(wrong, {
      store,
      fetch: fakeServer(bytes).fetch,
      url: "z",
      zip,
      freeSpace: () => Promise.resolve(Infinity),
    });
  } catch (e) {
    err = e;
  }
  assert(err instanceof LQ_Error && err.kind === "hash", "hash kind");
  assert(store.files.size === 0, "nothing kept: " + [...store.files.keys()]);
  assert(await LQ_Installed(store) === null, "not installed");
});

Deno.test("LQ_Install says how much storage it needs, before downloading", async () => {
  const store = memoryStore();
  let fetched = false;
  let err = null;
  try {
    await LQ_Install(LQ_RELEASES.full, {
      store,
      fetch: () => {
        fetched = true;
        return Promise.reject(new Error("no"));
      },
      url: "z",
      zip,
      freeSpace: () => Promise.resolve(100e6),
    });
  } catch (e) {
    err = e;
  }
  assert(err instanceof LQ_Error && err.kind === "quota", "quota kind");
  assert(/365 MB/.test(err.message), err.message);
  assert(fetched === false, "no download started");
});

Deno.test("LQ_Install reports storage refused part way as quota", async () => {
  const { bytes, release } = await makeRelease();
  // room for the zip but not its unpacked files as well
  const store = memoryStore(bytes.length + 1024 * 1024);
  let err = null;
  try {
    await LQ_Install(release, {
      store,
      fetch: fakeServer(bytes).fetch,
      url: "z",
      zip,
      freeSpace: () => Promise.resolve(Infinity),
    });
  } catch (e) {
    err = e;
  }
  assert(err instanceof LQ_Error && err.kind === "quota", "quota kind");
  assert(await LQ_Installed(store) === null, "not installed");
  assert(
    [...store.files.keys()].every((k) => !k.startsWith(UD_LQ_PREFIX)),
    "unpacked files removed",
  );
  assert(!store.files.has(UD_LQ_MANIFEST), "no manifest");
});
