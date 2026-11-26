// LibreQuake as the game's standard content (web-only, no C source).
// LibreQuake (https://github.com/lavenderdotpet/LibreQuake) is a free
// replacement for id1's data: art and maps under the BSD 3-clause licence,
// QuakeC under the GPL-2. Its paks are too big for the client Worker's
// static assets (25 MiB a file), so a pinned release's zip is downloaded
// once, when a person asks for it on the intro page (src/intro.js), checked
// against its SHA-256, unpacked with zip.js and kept in the browser's storage
// (src/userdata.js's store) under the URLs ?base=librequake would fetch.
// docs/librequake-content.md covers the choices: hosting, full or lite,
// resume, quota and the CSP.
//
// zip.js is loaded with import() when a download is unpacked, so a page
// that never downloads never fetches it. Nothing here touches window,
// document or navigator at import time.

import {
  UD_LQ_MANIFEST,
  UD_LQ_PARTS,
  UD_LQ_PREFIX,
  UD_OpenStore,
} from "./userdata.js";

/**
 * Where the release zips are served from: the one setting to change when the
 * hosting moves (docs/librequake-content.md, "Hosting"). GitHub's release
 * downloads can't be read cross-origin (their redirect has no CORS headers),
 * so they are served from this site's own origin, at a path the client
 * Worker's static assets don't hold, or from any https: host that sends CORS
 * headers for this origin. Relative to the page.
 */
export const LQ_DOWNLOAD_BASE = "static/librequake/v0.09-beta/";

/**
 * The pinned releases: full (all five episodes and the deathmatch maps) and
 * lite (episode 0 only). size and sha256 are the zip's; unpacked is what the
 * stored files take; root is the folder inside the zip that holds id1.
 */
export const LQ_RELEASES = Object.freeze({
  full: Object.freeze({
    variant: "full",
    version: "v0.09-beta",
    file: "full.zip",
    size: 115678161,
    sha256: "623e463b35811216244f9ba15e0c45abc1765288650b5e3d36a899b35e4bcf3d",
    unpacked: 248939038,
    root: "full/id1/",
  }),
  lite: Object.freeze({
    variant: "lite",
    version: "v0.09-beta",
    file: "lite.zip",
    size: 55987573,
    sha256: "428e736b2f01d953e09a08c60bee975bdc4a0ac2219e97fa095c8af41754da83",
    unpacked: 79089126,
    root: "lite/id1/",
  }),
});

/** The import map's name for zip.js (index.html, deno.json). */
const LQ_ZIP_MODULE = "@zip.js/zip.js";

/**
 * A download is kept in parts of this size, so a failed or cancelled one
 * resumes from its last whole part and memory holds one part at a time.
 */
export const LQ_PART_BYTES = 8 * 1024 * 1024;

// Files in the zip that aren't kept: the project's branding images (logos
// and store art, 3.6 MB). Its licence texts in docs/ are kept.
const LQ_SKIP_PREFIX = "docs/branding/";

// A stored path: lower-case segments of letters, digits, _ . -, none starting
// with a dot, so a name can't climb out of the prefix
const LQ_SAFE_PATH = /^[a-z0-9_-][a-z0-9_.-]*(\/[a-z0-9_-][a-z0-9_.-]*)*$/;

/** An error the intro page explains: kind is "http", "hash" or "quota". */
export class LQ_Error extends Error {
  constructor(kind, message) {
    super(message);
    this.name = "LQ_Error";
    this.kind = kind;
  }
}

/** The URL a release downloads from, resolved against base (the page). */
export function LQ_DownloadURL(release, base) {
  return new URL(LQ_DOWNLOAD_BASE + release.file, base).href;
}

/**
 * The path a zip entry is stored under (below UD_LQ_PREFIX), or null when it
 * isn't kept: outside the release's id1 folder, a folder, branding, or a
 * name that isn't a plain relative path.
 */
export function LQ_EntryPath(name, release) {
  if (name.startsWith(release.root) === false) return null;
  const rel = name.slice(release.root.length).toLowerCase();
  if (rel === "" || rel.endsWith("/")) return null;
  if (rel.startsWith(LQ_SKIP_PREFIX)) return null;
  if (LQ_SAFE_PATH.test(rel) === false) return null;
  return rel;
}

/** The stored manifest ({ version, variant, files }), or null. */
export async function LQ_Installed(store) {
  if (store === null) return null;
  try {
    const blob = await store.get(UD_LQ_MANIFEST);
    if (blob === null) return null;
    const manifest = JSON.parse(await blob.text());
    if (typeof manifest?.version !== "string") return null;
    return manifest;
  } catch {
    return null;
  }
}

// Store key of the part that starts at offset: sorted by name, the parts are
// in file order
function LQ_PartKey(release, offset) {
  return UD_LQ_PARTS + release.variant + "-" + release.version + "/" +
    String(offset).padStart(12, "0");
}

/**
 * The stored parts of a release's download, in order, as { key, offset,
 * size }, and the bytes they hold. Parts that don't follow on from the ones
 * before (a gap or an overlap) end the list; they and anything after are
 * listed in stale for removal.
 */
export async function LQ_Parts(store, release) {
  const prefix = LQ_PartKey(release, 0).slice(0, -12);
  const found = (await store.list())
    .filter((i) => i.key.startsWith(prefix))
    .map((i) => ({
      key: i.key,
      offset: Number(i.key.slice(prefix.length)),
      size: i.size,
    }))
    .sort((a, b) => a.offset - b.offset);
  const parts = [];
  const stale = [];
  let bytes = 0;
  for (const part of found) {
    if (stale.length === 0 && part.offset === bytes && part.size > 0) {
      parts.push(part);
      bytes += part.size;
    } else {
      stale.push(part);
    }
  }
  return { parts, stale, bytes };
}

/** Removes every stored part of every LibreQuake download. */
export async function LQ_RemoveParts(store) {
  for (const { key } of await store.list()) {
    if (key.startsWith(UD_LQ_PARTS)) await store.remove(key);
  }
}

function LQ_IsQuota(e) {
  return e?.name === "QuotaExceededError";
}

/**
 * Downloads a release's zip into the store in parts, resuming from the parts
 * already there with a Range request; a server that answers it with the
 * whole file (200) starts it over. Resolves to the zip as one Blob made of
 * the stored parts. opts: { fetch, signal, onProgress(bytes, total), url }.
 * Received bytes are stored before an error or a cancel is passed on, so
 * the next try resumes after them.
 */
export async function LQ_Download(store, release, opts) {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const onProgress = opts.onProgress ?? (() => {});

  let { parts, stale, bytes } = await LQ_Parts(store, release);
  for (const part of stale) await store.remove(part.key);
  if (bytes > release.size) {
    for (const part of parts) await store.remove(part.key);
    parts = [];
    bytes = 0;
  }

  if (bytes < release.size) {
    const headers = bytes > 0 ? { Range: "bytes=" + bytes + "-" } : {};
    const response = await doFetch(opts.url, {
      headers,
      signal: opts.signal,
      cache: "no-store",
    });
    if (bytes > 0 && response.status === 200) {
      // Range ignored: this is the whole file, from the start
      for (const part of parts) await store.remove(part.key);
      parts = [];
      bytes = 0;
    } else if (bytes > 0 && response.status === 206) {
      // Content-Range is readable cross-origin only if the server exposes it
      const range = /^bytes (\d+)-/.exec(
        response.headers.get("content-range") ?? "",
      );
      if (range !== null && Number(range[1]) !== bytes) {
        await response.body?.cancel();
        throw new LQ_Error("http", "the server resumed at the wrong place");
      }
    } else if (response.status !== 200) {
      await response.body?.cancel();
      throw new LQ_Error(
        "http",
        response.status === 404 ?
          "the download isn't available from this site yet" :
          "the server answered " + response.status,
      );
    }

    onProgress(bytes, release.size);
    const reader = response.body.getReader();
    let chunks = [];
    let pending = 0;
    const flush = async () => {
      if (pending === 0) return;
      const key = LQ_PartKey(release, bytes);
      const blob = new Blob(chunks);
      chunks = [];
      const size = pending;
      pending = 0;
      await store.put(key, blob);
      parts.push({ key, offset: bytes, size });
      bytes += size;
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        pending += value.length;
        if (bytes + pending > release.size) {
          throw new LQ_Error("hash", "the download is larger than expected");
        }
        if (pending >= LQ_PART_BYTES) await flush();
        onProgress(bytes + pending, release.size);
      }
      await flush();
    } catch (e) {
      // keep what arrived, unless it is the overrun or storage is full
      if (e instanceof LQ_Error === false && LQ_IsQuota(e) === false) {
        try {
          await flush();
        } catch {
          // the part is lost; the next try fetches it again
        }
      }
      reader.cancel().catch(() => {});
      // an overrun means the host serves another file: resuming would only
      // overrun again, so start from nothing next time
      if (e instanceof LQ_Error && e.kind === "hash") {
        for (const part of parts) await store.remove(part.key);
      }
      if (LQ_IsQuota(e)) {
        throw new LQ_Error(
          "quota",
          "this browser's storage for the site is full",
        );
      }
      throw e;
    }
  }

  if (bytes !== release.size) {
    throw new LQ_Error(
      "http",
      "the download ended early (" + bytes + " of " + release.size +
        " bytes); try again to resume it",
    );
  }

  const blobs = [];
  for (const part of parts) {
    const blob = await store.get(part.key);
    if (blob === null) throw new LQ_Error("http", "a stored part is missing");
    blobs.push(blob);
  }
  return new Blob(blobs);
}

/**
 * Hex SHA-256 of a Blob. Web Crypto has no streaming digest, so the whole
 * zip is read into memory once (116 MB for full).
 */
export async function LQ_Sha256(blob) {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()),
  );
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Unpacks a verified release zip into the store: each kept entry (see
 * LQ_EntryPath) under UD_LQ_PREFIX. zip is the zip.js module. Returns the
 * stored keys. Workers are off: the CSP's worker-src allows only this
 * origin, and the browser's own DecompressionStream inflates on the page.
 */
export async function LQ_Extract(blob, release, store, zip, onProgress) {
  zip.configure({ useWebWorkers: false });
  const reader = new zip.ZipReader(new zip.BlobReader(blob));
  const keys = [];
  try {
    const entries = (await reader.getEntries()).filter((e) =>
      e.directory === false && LQ_EntryPath(e.filename, release) !== null
    );
    const total = entries.reduce((n, e) => n + e.uncompressedSize, 0);
    let done = 0;
    for (const entry of entries) {
      const key = UD_LQ_PREFIX + LQ_EntryPath(entry.filename, release);
      // a pak at a time in memory: BlobWriter keeps the entry as one Blob
      const data = await entry.getData(new zip.BlobWriter());
      await store.put(key, data);
      keys.push(key);
      done += entry.uncompressedSize;
      if (onProgress !== undefined) onProgress(done, total);
    }
  } finally {
    await reader.close();
  }
  return keys;
}

// Free space the browser will give this origin, or Infinity if it won't say
async function LQ_FreeSpace() {
  try {
    const est = await globalThis.navigator.storage.estimate();
    if (typeof est.quota !== "number") return Infinity;
    return est.quota - (est.usage ?? 0);
  } catch {
    return Infinity;
  }
}

/**
 * Downloads, checks and unpacks a release, then writes the manifest that
 * makes UD_MountPaks mount it. opts: { store, fetch, signal, url, zip,
 * freeSpace, onProgress(phase, done, total) } with phase "download",
 * "verify" or "unpack"; store, fetch, zip and freeSpace default to the
 * browser's. Throws an LQ_Error the intro page explains, or the fetch's
 * AbortError when cancelled. The download's parts stay for a resume unless
 * the zip fails its hash; unpacked files are removed if unpacking fails.
 */
export async function LQ_Install(release, opts = {}) {
  const store = opts.store ?? await UD_OpenStore();
  if (store === null) {
    throw new LQ_Error("quota", "this browser has no storage for game data");
  }
  const onProgress = opts.onProgress ?? (() => {});

  // the zip and its unpacked files sit side by side until the zip goes
  const { bytes } = await LQ_Parts(store, release);
  const need = release.size - bytes + release.unpacked;
  const free = await (opts.freeSpace ?? LQ_FreeSpace)();
  if (need > free) {
    throw new LQ_Error(
      "quota",
      "it needs " + Math.ceil(need / 1e6) + " MB of storage and this " +
        "browser offers the site " + Math.max(0, Math.floor(free / 1e6)) +
        " MB",
    );
  }

  const zipBlob = await LQ_Download(store, release, {
    fetch: opts.fetch,
    signal: opts.signal,
    url: opts.url ?? LQ_DownloadURL(release, globalThis.location?.href),
    onProgress: (done, total) => onProgress("download", done, total),
  });

  onProgress("verify", 0, 1);
  const sha = await LQ_Sha256(zipBlob);
  if (sha !== release.sha256) {
    await LQ_RemoveParts(store);
    throw new LQ_Error(
      "hash",
      "the download doesn't match the pinned release (SHA-256 " + sha + ")",
    );
  }

  // the old install stops counting before its files are replaced
  await store.remove(UD_LQ_MANIFEST);
  const zip = opts.zip ?? await import(LQ_ZIP_MODULE);
  let keys;
  try {
    keys = await LQ_Extract(
      zipBlob,
      release,
      store,
      zip,
      (done, total) => onProgress("unpack", done, total),
    );
  } catch (e) {
    await LQ_RemoveFiles(store);
    if (LQ_IsQuota(e)) {
      throw new LQ_Error(
        "quota",
        "this browser's storage for the site is full",
      );
    }
    throw e;
  }

  // files an older install had and this one doesn't
  const kept = new Set(keys);
  for (const { key } of await store.list()) {
    if (key.startsWith(UD_LQ_PREFIX) && kept.has(key) === false) {
      await store.remove(key);
    }
  }
  const manifest = {
    version: release.version,
    variant: release.variant,
    sha256: release.sha256,
    files: keys.length,
  };
  await store.put(
    UD_LQ_MANIFEST,
    new Blob([JSON.stringify(manifest)], { type: "application/json" }),
  );
  await LQ_RemoveParts(store);
  return manifest;
}

/** Removes LibreQuake's unpacked files and its manifest (manifest first). */
export async function LQ_RemoveFiles(store) {
  await store.remove(UD_LQ_MANIFEST);
  for (const { key } of await store.list()) {
    if (key.startsWith(UD_LQ_PREFIX)) await store.remove(key);
  }
}
