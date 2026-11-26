// The client Worker's build (cloudflare/client/build.js): what the allowlist
// takes, what the deny check refuses, and that everything the page loads by
// name is on the allowlist, and that the tracked pak0.pak is the shareware one.

import {
  Client_Allowed,
  Client_CheckDist,
  Client_DenyReason,
  CLIENT_FILES,
  Client_Headers,
  Client_InlineScripts,
  Client_ScriptHash,
  Client_SelectFiles,
  Client_Sha256,
  CLIENT_SHAREWARE_PAK,
  CLIENT_SHAREWARE_PAK_SHA256,
} from "../cloudflare/client/build.js";

const root = new URL("../", import.meta.url);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

Deno.test("client build: allowlist takes the client and nothing else", () => {
  for (
    const path of [
      "index.html",
      "main.js",
      "sw.js",
      "manifest.webmanifest",
      "LICENSE",
      "src/host.js",
      "static/pak0.pak",
      "static/maps/mymap.bsp",
      "static/splash/a.png",
    ]
  ) {
    assert(Client_Allowed(path), `${path} should be allowed`);
  }
  for (
    const path of [
      "server/lobby_server.js",
      "server/cert.pem",
      "tests/client_build_test.js",
      "docs/README.md",
      "tools/make_splash.py",
      "cloudflare/lobby/wrangler.jsonc",
      "deno.json",
      ".gitignore",
      "AGENTS.md",
    ]
  ) {
    assert(Client_Allowed(path) === false, `${path} should not be allowed`);
  }
});

Deno.test("client build: deny check refuses registered data and secrets", () => {
  for (
    const path of [
      "static/pak1.pak",
      "static/PAK1.PAK",
      "static/maps/pak0.pak",
      "static/hipnotic/pak0.pak",
      "static/rerelease/id1/pak0.pak",
      "static/Rogue/maps/r1m1.bsp",
      "static/mg1/progs.dat",
      "static/id1/gfx.wad",
      "static/music/track02.ogg",
      "static/ctf/maps/ctf1.bsp",
      "static/dopa/maps/e5m1.bsp",
      "static/mg3/a.bsp",
      "static/librequake/v0.09-beta/full.zip",
      "static/librequake/id1/maps/lqdm1.bsp",
      "static/key.pem",
      "src/tls.key",
      "static/cert.crt",
      "static/.env",
      "static/.env.production",
      "static/.dev.vars",
      "static/.hidden",
      "../static/pak0.pak",
      "static/../server/key.pem",
      "/static/pak0.pak",
      "static//pak0.pak",
      "",
    ]
  ) {
    assert(Client_DenyReason(path) !== null, `${path} should be denied`);
  }
  for (
    const path of [
      CLIENT_SHAREWARE_PAK,
      "src/net_rtclobby.js",
      "src/librequake.js",
      "static/maps/mymap.txt",
      "static/screenshots/e1m1.jpg",
    ]
  ) {
    const reason = Client_DenyReason(path);
    assert(reason === null, `${path} denied: ${reason}`);
  }
});

Deno.test("client build: a tracked bad file fails the build", () => {
  const { files, denied, missing } = Client_SelectFiles([
    ...CLIENT_FILES,
    "src/host.js",
    "static/pak0.pak",
    "static/pak1.pak",
    "server/key.pem",
  ]);
  assert(missing.length === 0, `missing: ${missing}`);
  assert(
    denied.length === 1 && denied[0].path === "static/pak1.pak",
    `denied: ${JSON.stringify(denied)}`,
  );
  assert(files.includes("static/pak0.pak"), "pak0 not selected");
  assert(files.includes("server/key.pem") === false, "server file selected");
});

Deno.test("client build: missing root files are reported", () => {
  const { missing } = Client_SelectFiles(["src/host.js"]);
  assert(missing.length === CLIENT_FILES.length, `missing: ${missing}`);
});

Deno.test("client build: sw.js precache list and index.html links are deployable", async () => {
  const sw = await Deno.readTextFile(new URL("sw.js", root));
  const shell = sw.match(/const SHELL = \[([\s\S]*?)\];/);
  assert(shell !== null, "no SHELL list in sw.js");
  const precached = [...shell[1].matchAll(/"([^"]+)"/g)].map((m) => m[1])
    .filter((path) => path !== "./");
  assert(precached.length > 0, "empty SHELL list");

  const html = await Deno.readTextFile(new URL("index.html", root));
  const linked = [...html.matchAll(/(?:href|src)="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((ref) => /^[a-z]+:|^\/\/|^#/i.test(ref) === false);
  assert(linked.length > 0, "no local links in index.html");

  for (const path of [...precached, ...linked]) {
    assert(Client_Allowed(path), `${path} is not on the allowlist`);
    const reason = Client_DenyReason(path);
    assert(reason === null, `${path} denied: ${reason}`);
    await Deno.stat(new URL(path, root));
  }
});

Deno.test("client build: the dist/ check catches strays and denied files", () => {
  const files = ["index.html", "src/host.js", "static/pak0.pak"];
  const clean = Client_CheckDist([...files].reverse(), files);
  assert(clean.length === 0, `strays in a clean dist: ${clean}`);
  const strays = Client_CheckDist(
    [...files, "static/pak1.pak", "src/extra.js"],
    [...files, "static/pak1.pak"],
  );
  assert(
    strays.length === 2 && strays.includes("static/pak1.pak") &&
      strays.includes("src/extra.js"),
    `strays: ${strays}`,
  );
});

Deno.test("client build: the tracked pak0.pak is the pinned shareware pak", async () => {
  const pak = await Deno.readFile(new URL(CLIENT_SHAREWARE_PAK, root));
  const sha = await Client_Sha256(pak);
  assert(sha === CLIENT_SHAREWARE_PAK_SHA256, `pak0.pak SHA-256 ${sha}`);
});

Deno.test("client build: _headers hashes every inline script in index.html", async () => {
  const html = await Deno.readTextFile(new URL("index.html", root));
  const scripts = Client_InlineScripts(html);
  assert(scripts.length >= 2, `inline scripts: ${scripts.length}`);
  assert(
    scripts.some((s) => s.includes('"imports"')),
    "the import map is an inline script",
  );
  const headers = await Client_Headers(html);
  const lines = headers.split("\n");
  assert(lines[1] === "/*", "one rule for every path");
  const csp = lines.find((l) => l.startsWith("  Content-Security-Policy: "));
  assert(csp !== undefined, "no CSP");
  for (const script of scripts) {
    const hash = await Client_ScriptHash(script);
    assert(csp.includes(hash), `CSP lacks ${hash}`);
  }
  for (
    const needed of [
      "https://cdn.jsdelivr.net",
      "frame-src https://challenges.cloudflare.com",
      "frame-ancestors 'none'",
      "object-src 'none'",
    ]
  ) {
    assert(csp.includes(needed), `CSP lacks ${needed}`);
  }
  assert(csp.includes("'unsafe-inline'; img-src"), "inline styles only");
  assert(/script-src[^;]*unsafe/.test(csp) === false, "no unsafe scripts");
  // Workers static assets: 100 rules, 2,000 characters a line
  for (const line of lines) {
    assert(line.length <= 2000, `line of ${line.length} characters`);
  }
});

Deno.test("client build: an external script is not hashed", () => {
  const scripts = Client_InlineScripts(
    '<script type="module" src="main.js"></script><script>a()</script>',
  );
  assert(scripts.length === 1 && scripts[0] === "a()", `${scripts}`);
});
