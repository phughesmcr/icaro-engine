// Fetches LibreQuake, the game data tests, benchmarks and the servers run on,
// into a gitignored folder (web-only, no C source). The release is the one
// the browser downloads, pinned in src/librequake.js's LQ_RELEASES (version,
// size and SHA-256), and the files land where ?base=librequake fetches them:
//
//   static/librequake/v0.09-beta/full.zip   the release zip, kept
//   static/librequake/id1/                   its id1 folder, unpacked
//   static/librequake/fetch.json             what was unpacked (written last)
//
//   deno task fetch-data                     (full, into static/librequake)
//   deno run --allow-net=github.com,release-assets.githubusercontent.com \
//     --allow-read=<dir> --allow-write=<dir> tools/fetch_data.js \
//     [--variant full|lite] [--out <dir>] [--print-sha]
//
// A zip whose size or SHA-256 differs from the pin is deleted and refused.
// Entries are stored as the browser stores them (LQ_EntryPath: lower-cased,
// plain relative paths only, docs/branding/ skipped). The id1 folder is
// unpacked beside the old one and renamed into place, so a run that stops
// leaves the old folder, or none, but never a half-written one. When
// fetch.json already names the pinned release, nothing is fetched or
// unpacked. An id1 folder with no fetch.json (someone's own copy) is left
// alone: the run stops and says so. --print-sha prints the pinned SHA-256
// and exits (CI's cache key).

import * as zip from "@zip.js/zip.js";
import {
  LQ_DOWNLOAD_BASE,
  LQ_Extract,
  LQ_RELEASES,
} from "../src/librequake.js";
import { UD_LQ_PREFIX } from "../src/userdata.js";

/** Where GitHub serves a release's assets (redirects to release-assets). */
export const FD_RELEASE_URL =
  "https://github.com/lavenderdotpet/LibreQuake/releases/download/";

/** The folder the repository's tools read: static/librequake/. */
export const FD_DEFAULT_OUT = decodeURIComponent(
  new URL("../static/librequake/", import.meta.url).pathname,
);

/** The file that records the unpacked release, beside id1/. */
export const FD_MARKER = "fetch.json";

// UD_LQ_PREFIX is static/librequake/id1/; LQ_Extract's keys start with it
const ID1 = "id1";

function join(dir, name) {
  return dir.endsWith("/") ? dir + name : dir + "/" + name;
}

async function exists(path) {
  try {
    await Deno.lstat(path);
    return true;
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return false;
    throw e;
  }
}

async function hashFile(path) {
  const data = await Deno.readFile(path);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function readMarker(out) {
  try {
    return JSON.parse(await Deno.readTextFile(join(out, FD_MARKER)));
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return null;
    if (e instanceof SyntaxError) return null;
    throw e;
  }
}

/** True when the zip at path has the release's size and SHA-256. */
async function zipMatches(path, release) {
  const info = await Deno.stat(path);
  if (info.size !== release.size) return false;
  return await hashFile(path) === release.sha256;
}

// Downloads the release zip to path (through a .part file)
async function download(release, path, doFetch, log) {
  const url = FD_RELEASE_URL + release.version + "/" + release.file;
  log("Downloading " + url + " (" + release.size + " bytes)");
  const response = await doFetch(url);
  if (response.ok === false || response.body === null) {
    await response.body?.cancel();
    throw new Error(url + ": HTTP " + response.status);
  }
  const part = path + ".part";
  const file = await Deno.open(part, {
    write: true,
    create: true,
    truncate: true,
  });
  await response.body.pipeTo(file.writable);
  await Deno.rename(part, path);
}

/** A store (src/userdata.js's interface, put only) that writes to dir. */
function directoryStore(dir) {
  return {
    put: async (key, blob) => {
      if (key.startsWith(UD_LQ_PREFIX) === false) {
        throw new Error("unexpected key " + key);
      }
      const path = join(dir, key.slice(UD_LQ_PREFIX.length));
      await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), {
        recursive: true,
      });
      await Deno.writeFile(path, blob.stream());
    },
  };
}

/**
 * Makes out hold the release: its zip under LQ_DOWNLOAD_BASE's folder name,
 * its id1 folder, and the fetch.json marker. opts: { release (default
 * LQ_RELEASES.full), out (default static/librequake/), fetch, log }.
 * Returns "current" when nothing needed doing, else "unpacked". Throws on a
 * bad hash (the zip is deleted) or an id1 folder it didn't write.
 */
export async function FetchData_Run(opts = {}) {
  const release = opts.release ?? LQ_RELEASES.full;
  const out = opts.out ?? FD_DEFAULT_OUT;
  const doFetch = opts.fetch ?? globalThis.fetch;
  const log = opts.log ?? ((text) => console.error(text));

  const id1 = join(out, ID1);
  const marker = await readMarker(out);
  if (marker === null && await exists(id1)) {
    throw new Error(
      id1 + " exists but fetch-data didn't write it (no " + FD_MARKER +
        "). Move it aside and run again.",
    );
  }
  if (
    marker !== null && marker.version === release.version &&
    marker.variant === release.variant && marker.sha256 === release.sha256 &&
    await exists(id1)
  ) {
    log(id1 + " holds LibreQuake " + release.version + " " + release.variant);
    return "current";
  }

  // static/librequake/v0.09-beta/: the folder the browser downloads from
  const zipDir = join(out, LQ_DOWNLOAD_BASE.split("/").at(-2));
  const zipPath = join(zipDir, release.file);
  await Deno.mkdir(zipDir, { recursive: true });
  if (await exists(zipPath) === false || !await zipMatches(zipPath, release)) {
    await download(release, zipPath, doFetch, log);
    if (!await zipMatches(zipPath, release)) {
      await Deno.remove(zipPath);
      throw new Error(
        release.file + " doesn't match the SHA-256 and size pinned in " +
          "src/librequake.js (LQ_RELEASES); deleted",
      );
    }
  }

  log("Unpacking " + zipPath);
  // a fixed name, so a run that stopped part way is cleared by the next
  const tmp = join(out, ID1 + ".tmp");
  await Deno.remove(tmp, { recursive: true }).catch(() => {});
  const blob = new Blob([await Deno.readFile(zipPath)]);
  const keys = await LQ_Extract(blob, release, directoryStore(tmp), zip);
  if (keys.length === 0) throw new Error(release.file + " holds no id1 files");

  // The marker goes first so a stop between the two steps leaves no id1 the
  // next run would refuse to replace
  await Deno.remove(join(out, FD_MARKER)).catch(() => {});
  await Deno.remove(id1, { recursive: true }).catch(() => {});
  await Deno.rename(tmp, id1);
  await Deno.writeTextFile(
    join(out, FD_MARKER),
    JSON.stringify(
      {
        version: release.version,
        variant: release.variant,
        sha256: release.sha256,
        files: keys.length,
      },
      null,
      2,
    ) + "\n",
  );
  log("Unpacked " + keys.length + " files into " + id1);
  return "unpacked";
}

function parseArgs(args) {
  const opts = { variant: "full", out: FD_DEFAULT_OUT, printSha: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--variant" && i + 1 < args.length) opts.variant = args[++i];
    else if (a === "--out" && i + 1 < args.length) opts.out = args[++i];
    else if (a === "--print-sha") opts.printSha = true;
    else throw new Error("unknown argument " + a);
  }
  if (Object.hasOwn(LQ_RELEASES, opts.variant) === false) {
    throw new Error("--variant must be one of " + Object.keys(LQ_RELEASES));
  }
  return opts;
}

if (import.meta.main) {
  try {
    const opts = parseArgs(Deno.args);
    const release = LQ_RELEASES[opts.variant];
    if (opts.printSha) {
      console.log(release.sha256);
    } else {
      await FetchData_Run({ release, out: opts.out });
    }
  } catch (e) {
    console.error("fetch-data: " + e.message);
    Deno.exit(1);
  }
}
