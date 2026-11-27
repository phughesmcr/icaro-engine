// The LibreQuake zip Worker (cloudflare/librequake/src/serve.js) against a
// fake R2 bucket: the allowlist, methods, byte ranges and conditional
// requests the client's resumed download relies on.

import {
  LQ_R2_NoneMatch,
  LQ_R2_OBJECTS,
  LQ_R2_ParseRange,
  LQ_R2_Serve,
} from "../cloudflare/librequake/src/serve.js";
import { LQ_DOWNLOAD_BASE, LQ_RELEASES } from "../src/librequake.js";

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${
        JSON.stringify(actual)
      }`,
    );
  }
}

const FULL = "/static/librequake/v0.09-beta/full.zip";
const ORIGIN = "https://quake.anglezarke.games";
const UPLOADED = new Date("2026-11-26T12:00:00.500Z");

// A bucket with R2's head() and get() as serve.js uses them: get() takes
// only { range: { offset, length }, onlyIf: { etagMatches } }, and any
// other shape fails the test. No list(), so a listing can't happen.
function FakeBucket(objects) {
  const calls = [];
  const meta = (key, data) => ({
    key,
    size: data.length,
    etag: "e-" + key,
    httpEtag: '"e-' + key + '"',
    uploaded: UPLOADED,
  });
  return {
    calls,
    replaced: false,
    head(key) {
      calls.push(["head", key]);
      const data = objects[key];
      return Promise.resolve(data === undefined ? null : meta(key, data));
    },
    get(key, options) {
      calls.push(["get", key, options]);
      const keys = Object.keys(options).sort().join(",");
      if (keys !== "onlyIf,range") throw new Error("get options: " + keys);
      const { offset, length } = options.range;
      if (Object.keys(options.range).length !== 2) {
        throw new Error("range shape");
      }
      if (offset < 0 || length < 1) throw new Error("bad range");
      const data = objects[key];
      if (data === undefined) return Promise.resolve(null);
      const object = meta(key, data);
      if (this.replaced || options.onlyIf.etagMatches !== object.etag) {
        return Promise.resolve(object);
      }
      if (offset + length > data.length) throw new Error("range past end");
      const body = new Blob([data.subarray(offset, offset + length)]).stream();
      return Promise.resolve({ ...object, body });
    },
  };
}

function zip(size) {
  const data = new Uint8Array(size);
  for (let i = 0; i < size; i++) data[i] = i & 0xff;
  return data;
}

function bucket(size = 1000) {
  return FakeBucket({ "v0.09-beta/full.zip": zip(size) });
}

function request(path, init = {}) {
  return new Request(ORIGIN + path, init);
}

async function bytes(response) {
  return new Uint8Array(await response.arrayBuffer());
}

Deno.test("librequake r2: the allowlist is the client's download URLs", () => {
  const releases = Object.values(LQ_RELEASES);
  const paths = Object.keys(LQ_R2_OBJECTS);
  assertEqual(paths.length, releases.length, "one path a release");
  for (const release of releases) {
    const path = new URL(LQ_DOWNLOAD_BASE + release.file, ORIGIN + "/")
      .pathname;
    assertEqual(
      LQ_R2_OBJECTS[path],
      release.version + "/" + release.file,
      "key for " + path,
    );
  }
});

Deno.test("librequake r2: GET without a range is the whole zip", async () => {
  const b = bucket();
  const response = await LQ_R2_Serve(request(FULL), b);
  assertEqual(response.status, 200, "status");
  const h = response.headers;
  assertEqual(h.get("Content-Type"), "application/zip", "type");
  assertEqual(h.get("Content-Length"), "1000", "length");
  assertEqual(h.get("Accept-Ranges"), "bytes", "accept-ranges");
  assertEqual(h.get("ETag"), '"e-v0.09-beta/full.zip"', "etag");
  assertEqual(h.get("X-Content-Type-Options"), "nosniff", "nosniff");
  assertEqual(
    h.get("Cache-Control"),
    "public, max-age=31536000, immutable",
    "cache-control",
  );
  assertEqual(h.get("Last-Modified"), UPLOADED.toUTCString(), "modified");
  assertEqual(h.get("Content-Range"), null, "no content-range");
  const body = await bytes(response);
  assertEqual(body.length, 1000, "body length");
  assertEqual(body[999], 999 & 0xff, "last byte");
  const get = b.calls.find((c) => c[0] === "get");
  assertEqual(JSON.stringify(get[2].range), '{"offset":0,"length":1000}', "r");
  assertEqual(get[2].onlyIf.etagMatches, "e-v0.09-beta/full.zip", "onlyIf");
});

Deno.test("librequake r2: bytes=N- resumes with 206", async () => {
  const response = await LQ_R2_Serve(
    request(FULL, { headers: { Range: "bytes=400-" } }),
    bucket(),
  );
  assertEqual(response.status, 206, "status");
  assertEqual(
    response.headers.get("Content-Range"),
    "bytes 400-999/1000",
    "content-range",
  );
  assertEqual(response.headers.get("Content-Length"), "600", "length");
  const body = await bytes(response);
  assertEqual(body.length, 600, "body");
  assertEqual(body[0], 400 & 0xff, "first byte");
});

Deno.test("librequake r2: range forms", () => {
  const cases = [
    ["bytes=0-99", { offset: 0, length: 100 }],
    ["bytes=990-5000", { offset: 990, length: 10 }],
    ["bytes=999-", { offset: 999, length: 1 }],
    ["bytes=-10", { offset: 990, length: 10 }],
    ["bytes=-5000", { offset: 0, length: 1000 }],
    ["bytes=0-99999999999999999999999", { offset: 0, length: 1000 }],
    ["bytes=-99999999999999999999999", { offset: 0, length: 1000 }],
    [" bytes=5-9 ", { offset: 5, length: 5 }],
    ["bytes=1000-", "unsatisfiable"],
    ["bytes=1000-2000", "unsatisfiable"],
    ["bytes=99999999999999999999999-", "unsatisfiable"],
    ["bytes=-0", "unsatisfiable"],
    // Ignored: whole object
    ["bytes=0-1,5-9", null],
    ["items=0-9", null],
    ["bytes=9-5", null],
    ["bytes=-", null],
    ["bytes=a-9", null],
    ["bytes=1.5-9", null],
    ["", null],
  ];
  for (const [header, expected] of cases) {
    assertEqual(
      JSON.stringify(LQ_R2_ParseRange(header, 1000)),
      JSON.stringify(expected),
      header,
    );
  }
});

Deno.test("librequake r2: N-M and -N answer 206", async () => {
  let response = await LQ_R2_Serve(
    request(FULL, { headers: { Range: "bytes=10-19" } }),
    bucket(),
  );
  assertEqual(response.status, 206, "N-M status");
  assertEqual(response.headers.get("Content-Range"), "bytes 10-19/1000", "N-M");
  assertEqual((await bytes(response))[0], 10, "N-M first byte");

  response = await LQ_R2_Serve(
    request(FULL, { headers: { Range: "bytes=-4" } }),
    bucket(),
  );
  assertEqual(response.status, 206, "-N status");
  assertEqual(
    response.headers.get("Content-Range"),
    "bytes 996-999/1000",
    "-N",
  );
  assertEqual((await bytes(response)).length, 4, "-N body");
});

Deno.test("librequake r2: an unsatisfiable range is 416", async () => {
  const b = bucket();
  const response = await LQ_R2_Serve(
    request(FULL, { headers: { Range: "bytes=1000-" } }),
    b,
  );
  assertEqual(response.status, 416, "status");
  assertEqual(response.headers.get("Content-Range"), "bytes */1000", "range");
  assertEqual(response.headers.get("Cache-Control"), "no-store", "not cached");
  await response.body?.cancel();
  assertEqual(b.calls.some((c) => c[0] === "get"), false, "no get");
});

Deno.test("librequake r2: an ignored range sends the whole zip", async () => {
  for (const range of ["bytes=0-1,5-9", "items=0-9", "bytes=9-5"]) {
    const response = await LQ_R2_Serve(
      request(FULL, { headers: { Range: range } }),
      bucket(),
    );
    assertEqual(response.status, 200, range);
    assertEqual((await bytes(response)).length, 1000, range + " body");
  }
});

Deno.test("librequake r2: HEAD has the headers and no body", async () => {
  const b = bucket();
  let response = await LQ_R2_Serve(
    request(FULL, { method: "HEAD", headers: { Range: "bytes=0-99" } }),
    b,
  );
  assertEqual(response.status, 206, "ranged HEAD");
  assertEqual(response.headers.get("Content-Range"), "bytes 0-99/1000", "cr");
  assertEqual(response.headers.get("Content-Length"), "100", "length");
  assertEqual(response.body, null, "no body");

  response = await LQ_R2_Serve(request(FULL, { method: "HEAD" }), b);
  assertEqual(response.status, 200, "HEAD");
  assertEqual(response.headers.get("Content-Length"), "1000", "HEAD length");
  assertEqual(b.calls.some((c) => c[0] === "get"), false, "HEAD never gets");
});

Deno.test("librequake r2: other methods are 405", async () => {
  for (const method of ["POST", "PUT", "DELETE", "OPTIONS", "PATCH"]) {
    const b = bucket();
    const response = await LQ_R2_Serve(request(FULL, { method }), b);
    assertEqual(response.status, 405, method);
    assertEqual(response.headers.get("Allow"), "GET, HEAD", method + " allow");
    await response.body?.cancel();
    assertEqual(b.calls.length, 0, method + " touches no bucket");
  }
});

Deno.test("librequake r2: paths outside the allowlist are 404", async () => {
  const paths = [
    "/static/librequake/",
    "/static/librequake/v0.09-beta/",
    "/static/librequake/v0.09-beta/FULL.zip",
    "/static/librequake/v0.09-beta/full.zip/",
    "/static/librequake/v0.09-beta/%66ull.zip",
    "/static/librequake/v0.09-beta/../v0.09-beta/x.zip",
    "/static/librequake/v0.08-beta/full.zip",
    "/static/librequake/full/id1/pak0.pak",
    "/static/librequake/constructor",
    "/static/librequake/__proto__",
    "/",
  ];
  for (const path of paths) {
    const b = bucket();
    const response = await LQ_R2_Serve(request(path), b);
    assertEqual(response.status, 404, path);
    await response.body?.cancel();
    assertEqual(b.calls.length, 0, path + " touches no bucket");
  }
  // A query string doesn't change the object
  const response = await LQ_R2_Serve(request(FULL + "?x=1"), bucket());
  assertEqual(response.status, 200, "query");
  await response.body?.cancel();
});

Deno.test("librequake r2: a zip not uploaded yet is 404", async () => {
  const response = await LQ_R2_Serve(
    request("/static/librequake/v0.09-beta/lite.zip"),
    bucket(),
  );
  assertEqual(response.status, 404, "status");
  await response.body?.cancel();
});

Deno.test("librequake r2: If-None-Match", async () => {
  const etag = '"e-v0.09-beta/full.zip"';
  for (const header of [etag, "W/" + etag, '"x", ' + etag, "*"]) {
    const b = bucket();
    const response = await LQ_R2_Serve(
      request(FULL, {
        headers: { "If-None-Match": header, Range: "bytes=0-" },
      }),
      b,
    );
    assertEqual(response.status, 304, header);
    assertEqual(response.headers.get("ETag"), etag, header + " etag");
    assertEqual(response.body, null, header + " body");
    assertEqual(b.calls.some((c) => c[0] === "get"), false, header + " get");
  }
  const response = await LQ_R2_Serve(
    request(FULL, { headers: { "If-None-Match": '"other"' } }),
    bucket(),
  );
  assertEqual(response.status, 200, "no match");
  await response.body?.cancel();
  assertEqual(LQ_R2_NoneMatch('W/"a"', '"a"'), true, "weak compare");
});

Deno.test("librequake r2: If-Modified-Since", async () => {
  let response = await LQ_R2_Serve(
    request(FULL, {
      headers: { "If-Modified-Since": UPLOADED.toUTCString() },
    }),
    bucket(),
  );
  assertEqual(response.status, 304, "not modified since its own date");

  response = await LQ_R2_Serve(
    request(FULL, {
      headers: { "If-Modified-Since": "Wed, 25 Nov 2026 00:00:00 GMT" },
    }),
    bucket(),
  );
  assertEqual(response.status, 200, "modified since an earlier date");
  await response.body?.cancel();

  // Ignored when If-None-Match is there
  response = await LQ_R2_Serve(
    request(FULL, {
      headers: {
        "If-None-Match": '"other"',
        "If-Modified-Since": UPLOADED.toUTCString(),
      },
    }),
    bucket(),
  );
  assertEqual(response.status, 200, "If-None-Match wins");
  await response.body?.cancel();
});

Deno.test("librequake r2: If-Range", async () => {
  const etag = '"e-v0.09-beta/full.zip"';
  const cases = [
    [etag, 206],
    ['"other"', 200],
    // A weak ETag never matches If-Range
    ["W/" + etag, 200],
    [UPLOADED.toUTCString(), 206],
    ["Wed, 25 Nov 2026 00:00:00 GMT", 200],
  ];
  for (const [header, status] of cases) {
    const response = await LQ_R2_Serve(
      request(FULL, { headers: { Range: "bytes=100-", "If-Range": header } }),
      bucket(),
    );
    assertEqual(response.status, status, header);
    const length = (await bytes(response)).length;
    assertEqual(length, status === 206 ? 900 : 1000, header + " body");
  }
});

Deno.test("librequake r2: a zip replaced mid-request is 503", async () => {
  const b = bucket();
  b.replaced = true;
  const response = await LQ_R2_Serve(request(FULL), b);
  assertEqual(response.status, 503, "status");
  assertEqual(response.headers.get("Cache-Control"), "no-store", "no-store");
  await response.body?.cancel();
});
