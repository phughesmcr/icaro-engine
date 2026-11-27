// The LibreQuake zip Worker's request handling, without the Workers-only
// parts (worker.js holds those), so Deno tests can drive it with a fake
// bucket. It serves the pinned release zips (src/librequake.js,
// LQ_RELEASES) from R2 at the path the client downloads them from
// (LQ_DOWNLOAD_BASE): GET and HEAD only, an allowlist of keys, single byte
// ranges for resumed downloads, and the validators a browser cache uses.
//
// The Range and conditional headers are read here rather than handed to
// R2: head() gives the size and ETag, the response is decided from them,
// and get() is asked only for a plain offset and length. That keeps 416,
// If-Range and If-None-Match to what this file says, and lets the fake
// bucket stay small. The bucket is never listed.

/**
 * Request paths to R2 keys. The paths must be what the client fetches,
 * LQ_DOWNLOAD_BASE + file for each of LQ_RELEASES, under the site's root;
 * tests/cloudflare_librequake_test.js checks that. The keys are the
 * version folder and file name, as the README uploads them.
 */
export const LQ_R2_OBJECTS = Object.freeze({
  "/static/librequake/v0.09-beta/full.zip": "v0.09-beta/full.zip",
  "/static/librequake/v0.09-beta/lite.zip": "v0.09-beta/lite.zip",
});

/** The paths are versioned, so a zip under one never changes. */
const LQ_R2_CACHE_CONTROL = "public, max-age=31536000, immutable";

const LQ_R2_ALLOW = "GET, HEAD";

/**
 * A single "bytes=" range against an object of size bytes:
 * { offset, length } to serve, "unsatisfiable" for 416, or null to ignore
 * it and send the whole object. Several ranges, another unit and a
 * malformed or backwards range are ignored, as RFC 9110 allows.
 */
export function LQ_R2_ParseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null) return null;
  const [, first, last] = match;
  if (first === "" && last === "") return null;

  if (first === "") {
    // -N: the last N bytes
    const suffix = Number(last);
    if (suffix === 0 || size === 0) return "unsatisfiable";
    const length = Math.min(suffix, size);
    return { offset: size - length, length };
  }

  const offset = Number(first);
  if (last !== "" && Number(last) < offset) return null;
  if (offset >= size) return "unsatisfiable";
  const end = last === "" ? size - 1 : Math.min(Number(last), size - 1);
  return { offset, length: end - offset + 1 };
}

// An ETag with any weak prefix taken off, for the weak comparison
// If-None-Match uses
function LQ_R2_Opaque(etag) {
  return etag.startsWith("W/") ? etag.slice(2) : etag;
}

/** True when an If-None-Match list matches etag (weak comparison). */
export function LQ_R2_NoneMatch(header, etag) {
  const list = header.split(",").map((tag) => tag.trim());
  if (list.includes("*")) return true;
  const opaque = LQ_R2_Opaque(etag);
  return list.some((tag) => LQ_R2_Opaque(tag) === opaque);
}

/**
 * True when an If-Range validator still matches the object, so its Range
 * may be served: the same strong ETag, or exactly its Last-Modified date.
 */
export function LQ_R2_RangeStillValid(header, etag, last_modified) {
  const value = header.trim();
  if (value.startsWith('"') || value.startsWith("W/")) {
    return value.startsWith("W/") === false && value === etag;
  }
  return value === last_modified;
}

// The headers every answer about an object carries
function LQ_R2_Validators(object) {
  return {
    ETag: object.httpEtag,
    "Last-Modified": object.uploaded.toUTCString(),
    "Cache-Control": LQ_R2_CACHE_CONTROL,
    "Accept-Ranges": "bytes",
    "X-Content-Type-Options": "nosniff",
  };
}

function LQ_R2_Text(status, text, headers = {}) {
  return new Response(text + "\n", {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    },
  });
}

/**
 * The response for request, reading from bucket (an R2Bucket binding, or a
 * fake with the same head() and get()). Anything but GET or HEAD is 405;
 * a path outside LQ_R2_OBJECTS, or one whose object isn't uploaded, is
 * 404, which the client reports as "not available yet".
 */
export async function LQ_R2_Serve(request, bucket) {
  const method = request.method;
  if (method !== "GET" && method !== "HEAD") {
    return LQ_R2_Text(405, "Method not allowed", { Allow: LQ_R2_ALLOW });
  }

  const path = new URL(request.url).pathname;
  const key = Object.hasOwn(LQ_R2_OBJECTS, path) ? LQ_R2_OBJECTS[path] : null;
  if (key === null) return LQ_R2_Text(404, "Not found");

  const object = await bucket.head(key);
  if (object === null) return LQ_R2_Text(404, "Not found");

  const size = object.size;
  const validators = LQ_R2_Validators(object);
  const headers = request.headers;

  // If-None-Match wins over If-Modified-Since (RFC 9110, 13.2.2)
  const none_match = headers.get("If-None-Match");
  if (none_match !== null) {
    if (LQ_R2_NoneMatch(none_match, object.httpEtag)) {
      return new Response(null, { status: 304, headers: validators });
    }
  } else {
    const since = headers.get("If-Modified-Since");
    if (since !== null) {
      const date = Date.parse(since);
      // HTTP dates have whole seconds
      const uploaded = Math.floor(object.uploaded.getTime() / 1000) * 1000;
      if (Number.isNaN(date) === false && uploaded <= date) {
        return new Response(null, { status: 304, headers: validators });
      }
    }
  }

  let range = null;
  const range_header = headers.get("Range");
  if (range_header !== null) {
    const if_range = headers.get("If-Range");
    if (
      if_range === null ||
      LQ_R2_RangeStillValid(
        if_range,
        object.httpEtag,
        validators["Last-Modified"],
      )
    ) {
      range = LQ_R2_ParseRange(range_header, size);
    }
  }

  if (range === "unsatisfiable") {
    // Not cached: the next request may ask for a range that fits
    return LQ_R2_Text(416, "Range not satisfiable", {
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
      "Content-Range": "bytes */" + size,
    });
  }

  const status = range === null ? 200 : 206;
  const offset = range === null ? 0 : range.offset;
  const length = range === null ? size : range.length;
  const out = {
    ...validators,
    "Content-Type": "application/zip",
    "Content-Length": String(length),
  };
  if (range !== null) {
    out["Content-Range"] = "bytes " + offset + "-" + (offset + length - 1) +
      "/" + size;
  }
  if (method === "HEAD") return new Response(null, { status, headers: out });

  // Only if it is still the object head() described, so the body can't come
  // from a newer upload than the headers
  const body = await bucket.get(key, {
    range: { offset, length },
    onlyIf: { etagMatches: object.etag },
  });
  if (body === null) return LQ_R2_Text(404, "Not found");
  if (body.body === undefined) {
    // Replaced between head() and get(): the client retries
    return LQ_R2_Text(503, "Changed while being read; try again", {
      "Retry-After": "1",
      "Cache-Control": "no-store",
    });
  }
  return new Response(body.body, { status, headers: out });
}
