// tools/fetch_data.js (deno task fetch-data): the hash check, the unpacked
// layout and the marker that makes a second run a no-op. The release zip is
// a small one built here, served by a fake fetch, so nothing goes online.

import * as zip from "@zip.js/zip.js";
import { FD_MARKER, FetchData_Run } from "../tools/fetch_data.js";
import { LQ_RELEASES } from "../src/librequake.js";

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

async function sha256(bytes) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

// A zip laid out like LibreQuake's full.zip, and a release record pinning it
async function makeRelease() {
  const writer = new zip.ZipWriter(new zip.Uint8ArrayWriter());
  const entries = {
    "full/id1/PAK0.PAK": new TextEncoder().encode("PACK...."),
    "full/id1/maps/lqdm1.bsp": new Uint8Array([29, 0, 0, 0]),
    "full/id1/docs/branding/logo.png": new Uint8Array(10),
    "full/README.txt": new TextEncoder().encode("outside id1"),
  };
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
    },
  };
}

// A fetch that serves bytes and counts its calls
function fakeFetch(bytes) {
  const f = (url) => {
    f.urls.push(url);
    return Promise.resolve(new Response(bytes.slice()));
  };
  f.urls = [];
  return f;
}

async function exists(path) {
  try {
    await Deno.lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function withTempDir(fn) {
  const dir = await Deno.makeTempDir({ prefix: "icaro_fetch_data_" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const quiet = () => {};

Deno.test("fetch-data unpacks id1 as the browser stores it", async () => {
  const { bytes, release } = await makeRelease();
  await withTempDir(async (out) => {
    const fetch = fakeFetch(bytes);
    const result = await FetchData_Run({ release, out, fetch, log: quiet });
    assert(result === "unpacked", "result " + result);
    assert(
      fetch.urls[0] ===
        "https://github.com/lavenderdotpet/LibreQuake/releases/download/" +
          "v0.09-beta/full.zip",
      "url " + fetch.urls[0],
    );
    const pak = await Deno.readTextFile(out + "/id1/pak0.pak");
    assert(pak === "PACK....", "pak0.pak lower-cased and intact");
    assert(await exists(out + "/id1/maps/lqdm1.bsp"), "loose map kept");
    assert(!await exists(out + "/id1/docs/branding"), "branding skipped");
    assert(!await exists(out + "/README.txt"), "files outside id1 skipped");
    const zipped = await Deno.readFile(out + "/v0.09-beta/full.zip");
    assert(await sha256(zipped) === release.sha256, "zip kept");
    const marker = JSON.parse(await Deno.readTextFile(out + "/" + FD_MARKER));
    assert(marker.sha256 === release.sha256, "marker names the release");
    assert(marker.files === 2, "marker counts the files: " + marker.files);
  });
});

Deno.test("fetch-data does nothing when the release is unpacked", async () => {
  const { bytes, release } = await makeRelease();
  await withTempDir(async (out) => {
    await FetchData_Run({ release, out, fetch: fakeFetch(bytes), log: quiet });
    const fetch = fakeFetch(bytes);
    const result = await FetchData_Run({ release, out, fetch, log: quiet });
    assert(result === "current", "result " + result);
    assert(fetch.urls.length === 0, "no download");
  });
});

Deno.test("fetch-data reuses a kept zip that matches the pin", async () => {
  const { bytes, release } = await makeRelease();
  await withTempDir(async (out) => {
    await Deno.mkdir(out + "/v0.09-beta");
    await Deno.writeFile(out + "/v0.09-beta/full.zip", bytes);
    const fetch = fakeFetch(bytes);
    const result = await FetchData_Run({ release, out, fetch, log: quiet });
    assert(result === "unpacked", "result " + result);
    assert(fetch.urls.length === 0, "no download");
    assert(await exists(out + "/id1/pak0.pak"), "unpacked");
  });
});

Deno.test("fetch-data refuses and deletes a zip with the wrong hash", async () => {
  const { bytes, release } = await makeRelease();
  const bad = bytes.slice();
  bad[bad.length - 30] ^= 0xff;
  await withTempDir(async (out) => {
    let error = null;
    try {
      await FetchData_Run({ release, out, fetch: fakeFetch(bad), log: quiet });
    } catch (e) {
      error = e;
    }
    assert(error !== null && /SHA-256/.test(error.message), "refused");
    assert(!await exists(out + "/v0.09-beta/full.zip"), "zip deleted");
    assert(!await exists(out + "/id1"), "nothing unpacked");
    assert(!await exists(out + "/" + FD_MARKER), "no marker");
  });
});

Deno.test("fetch-data refuses a failed download", async () => {
  const { release } = await makeRelease();
  await withTempDir(async (out) => {
    const fetch = () =>
      Promise.resolve(new Response("not found", { status: 404 }));
    let error = null;
    try {
      await FetchData_Run({ release, out, fetch, log: quiet });
    } catch (e) {
      error = e;
    }
    assert(error !== null && /HTTP 404/.test(error.message), "refused");
    assert(!await exists(out + "/v0.09-beta/full.zip"), "no zip");
  });
});

Deno.test("fetch-data leaves an id1 folder it didn't write alone", async () => {
  const { bytes, release } = await makeRelease();
  await withTempDir(async (out) => {
    await Deno.mkdir(out + "/id1");
    await Deno.writeTextFile(out + "/id1/pak0.pak", "mine");
    const fetch = fakeFetch(bytes);
    let error = null;
    try {
      await FetchData_Run({ release, out, fetch, log: quiet });
    } catch (e) {
      error = e;
    }
    assert(error !== null && /didn't write it/.test(error.message), "refused");
    assert(fetch.urls.length === 0, "no download");
    const kept = await Deno.readTextFile(out + "/id1/pak0.pak");
    assert(kept === "mine", "own copy untouched");
  });
});
