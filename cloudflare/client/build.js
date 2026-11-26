// Builds dist/ for the icaro-client Worker (README.md): the browser client's
// files from an allowlist, never the working tree as a whole.
//
//   deno task client-build [--allow-dirty]
//
// Only files git tracks are copied, so gitignored data (paks, CD
// rips, certs) can't get in, and every copied path then goes through a deny
// check as a second guard, as tools/check_container_image.sh does for the
// room image. The build refuses to run while a client file has uncommitted
// changes, so dist/ is what HEAD holds; --allow-dirty overrides that.

/** Files at the repository root that the page loads. */
export const CLIENT_FILES = [
  "index.html",
  "main.js",
  "sw.js",
  "manifest.webmanifest",
  "LICENSE",
];

/** Folders whose tracked files are copied whole. */
export const CLIENT_DIRS = ["src/", "static/"];

/** Workers static assets refuse a file over 25 MiB. */
export const CLIENT_MAX_FILE_BYTES = 25 * 1024 * 1024;

// Folders that hold registered or commercial data, a player's CD rips, or
// LibreQuake, whose paks are over the asset size limit and are served from
// elsewhere (src/librequake.js LQ_DOWNLOAD_BASE) (.gitignore, AGENTS.md "Game
// data"). Matched on any folder name in a path, in any case.
const DENIED_DIRS = new Set([
  "librequake",
  "hipnotic",
  "rogue",
  "rerelease",
  "id1",
  "mg1",
  "mg3",
  "dopa",
  "ctf",
  "music",
]);

const SECRET_FILE = /\.(pem|key|crt)$/i;
const ENV_FILE = /^(\.env(\..*)?|\.dev\.vars)$/;

/** Whether a repository path is on the allowlist (before the deny check). */
export function Client_Allowed(path) {
  if (CLIENT_FILES.includes(path)) return true;
  return CLIENT_DIRS.some((dir) => path.startsWith(dir));
}

/**
 * Why a path must never be deployed, or null if it may be. The allowlist
 * decides what is copied; this catches what should never have got onto it.
 */
export function Client_DenyReason(path) {
  if (path.length === 0 || path.startsWith("/") || path.includes("\\")) {
    return "not a relative repository path";
  }
  const parts = path.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    return "not a normalised path";
  }
  const name = parts[parts.length - 1];
  if (/\.pak$/i.test(name)) return "a pak (no game data is deployed)";
  for (const dir of parts.slice(0, -1)) {
    if (DENIED_DIRS.has(dir.toLowerCase())) {
      return "registered data or CD rips (" + dir + "/)";
    }
  }
  if (SECRET_FILE.test(name) || ENV_FILE.test(name)) {
    return "a key, certificate or env file";
  }
  if (parts.some((part) => part.startsWith("."))) return "a dotfile";
  return null;
}

/**
 * The files to deploy from git's list of tracked paths: { files, denied,
 * missing }. denied lists allowlisted paths that failed the deny check, with
 * the reason; missing lists CLIENT_FILES that git doesn't track. The build
 * goes ahead only when both are empty.
 */
export function Client_SelectFiles(tracked) {
  const files = [];
  const denied = [];
  for (const path of tracked) {
    if (Client_Allowed(path) === false) continue;
    const reason = Client_DenyReason(path);
    if (reason !== null) denied.push({ path, reason });
    else files.push(path);
  }
  files.sort();
  const missing = CLIENT_FILES.filter((path) => files.includes(path) === false);
  return { files, denied, missing };
}

/**
 * Paths found in dist/ that shouldn't be there: denied, or not among the
 * selected files. A count mismatch with no stray means a selected file is
 * missing, which the caller reports.
 */
export function Client_CheckDist(landed, files) {
  const selected = new Set(files);
  return landed.filter((path) =>
    Client_DenyReason(path) !== null || selected.has(path) === false
  );
}

/** Hex SHA-256 of bytes. */
export async function Client_Sha256(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The headers file Workers static assets read from the assets folder. */
export const CLIENT_HEADERS_FILE = "_headers";

// Sources the page needs beyond its own origin: three and nipplejs from
// jsDelivr (index.html's import map), and the Turnstile widget's script and
// iframe (src/turnstile.js). connect-src stays open to any https: or wss:
// host because ?server= may name any lobby, and WebTransport connects over
// https:. Styles allow inline: index.html has a <style> block, and touch
// controls style their elements.
const CSP_SCRIPT_HOSTS = [
  "https://cdn.jsdelivr.net",
  "https://challenges.cloudflare.com",
];
const CSP_FRAME_HOSTS = ["https://challenges.cloudflare.com"];

/** The inline <script> bodies in an HTML page, as written. */
export function Client_InlineScripts(html) {
  const scripts = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (/\bsrc\s*=/i.test(m[1])) continue;
    scripts.push(m[2]);
  }
  return scripts;
}

/** CSP source for a script body: 'sha256-<base64>'. */
export async function Client_ScriptHash(text) {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
  );
  return "'sha256-" + btoa(String.fromCharCode(...digest)) + "'";
}

/**
 * The _headers file for dist/: security headers on every response, with a
 * Content-Security-Policy whose script-src lists a hash of each inline
 * script in index.html (the import map and the service worker's
 * registration), so editing either updates the policy at the next build.
 */
export async function Client_Headers(indexHtml) {
  const hashes = [];
  for (const script of Client_InlineScripts(indexHtml)) {
    hashes.push(await Client_ScriptHash(script));
  }
  const csp = [
    "default-src 'self'",
    ["script-src 'self'", ...CSP_SCRIPT_HOSTS, ...hashes].join(" "),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "connect-src 'self' https: wss:",
    ["frame-src", ...CSP_FRAME_HOSTS].join(" "),
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
  return [
    "# Generated by build.js: edit it there, not here",
    "/*",
    "  Content-Security-Policy: " + csp,
    "  X-Content-Type-Options: nosniff",
    "  X-Frame-Options: DENY",
    "  Referrer-Policy: strict-origin-when-cross-origin",
    "  Cross-Origin-Opener-Policy: same-origin",
    "  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "  Strict-Transport-Security: max-age=31536000",
    "",
  ].join("\n");
}

async function git(root, args) {
  const out = await new Deno.Command("git", {
    args,
    cwd: root,
    stderr: "inherit",
  })
    .output();
  if (out.success === false) {
    throw new Error("git " + args.join(" ") + " failed");
  }
  return new TextDecoder().decode(out.stdout);
}

function fail(message) {
  console.error("client-build: " + message);
  Deno.exit(1);
}

async function listDist(dist, prefix, out) {
  for await (const entry of Deno.readDir(new URL(prefix, dist))) {
    const path = prefix + entry.name;
    if (entry.isDirectory) await listDist(dist, path + "/", out);
    else out.push(path);
  }
  return out;
}

async function main() {
  const root = new URL("../../", import.meta.url);
  const dist = new URL("./dist/", import.meta.url);
  const allowDirty = Deno.args.includes("--allow-dirty");

  const tracked = (await git(root, ["ls-files", "-z"])).split("\0")
    .filter((path) => path.length > 0);
  const { files, denied, missing } = Client_SelectFiles(tracked);
  if (denied.length > 0) {
    fail(
      "refusing to deploy:\n" +
        denied.map((d) => "  " + d.path + ": " + d.reason).join("\n"),
    );
  }
  if (missing.length > 0) fail("not tracked by git: " + missing.join(", "));

  if (allowDirty === false) {
    const dirty = await git(root, [
      "status",
      "--porcelain",
      "--untracked-files=no",
      "--",
      ...CLIENT_FILES,
      ...CLIENT_DIRS,
    ]);
    if (dirty.length > 0) {
      fail(
        "client files have uncommitted changes (commit them, or pass " +
          "--allow-dirty):\n" + dirty,
      );
    }
  }

  try {
    await Deno.remove(dist, { recursive: true });
  } catch (e) {
    if ((e instanceof Deno.errors.NotFound) === false) throw e;
  }

  let bytes = 0;
  for (const path of files) {
    const from = new URL(path, root);
    let size;
    try {
      size = (await Deno.stat(from)).size;
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) fail(path + " is missing");
      throw e;
    }
    if (size > CLIENT_MAX_FILE_BYTES) {
      fail(path + " is " + size + " bytes, over the 25 MiB asset limit");
    }
    const to = new URL(path, dist);
    await Deno.mkdir(new URL(".", to), { recursive: true });
    await Deno.copyFile(from, to);
    bytes += size;
  }

  await Deno.writeTextFile(
    new URL(CLIENT_HEADERS_FILE, dist),
    await Client_Headers(
      await Deno.readTextFile(new URL("index.html", dist)),
    ),
  );

  // Check what actually landed in dist/, not just what was meant to
  const expected = [...files, CLIENT_HEADERS_FILE];
  const landed = (await listDist(dist, "", [])).sort();
  const strays = Client_CheckDist(landed, expected);
  if (strays.length > 0 || landed.length !== expected.length) {
    fail("dist/ doesn't match the allowlist: " + strays.join(", "));
  }

  console.log(
    "client-build: " + files.length + " files, " +
      (bytes / (1024 * 1024)).toFixed(1) + " MiB in cloudflare/client/dist/",
  );
}

if (import.meta.main) await main();
