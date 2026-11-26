// The client Worker's per-request CSP nonce (cloudflare/client/src/nonce.js):
// where the nonce goes in the policy, and which responses get one.

import {
  Client_AddScriptNonce,
  Client_NewNonce,
  Client_WithNonce,
} from "../cloudflare/client/src/nonce.js";
import { Client_Headers } from "../cloudflare/client/build.js";

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${
        JSON.stringify(actual)
      }`,
    );
  }
}

const CSP = "default-src 'self'; script-src 'self' 'sha256-abc='; " +
  "object-src 'none'";

function page(headers) {
  return new Response("<!doctype html>", { status: 200, headers });
}

Deno.test("client nonce: added to script-src only", () => {
  assertEqual(
    Client_AddScriptNonce(CSP, "N0nce=="),
    "default-src 'self'; script-src 'self' 'sha256-abc=' 'nonce-N0nce=='; " +
      "object-src 'none'",
    "nonce after the hashes",
  );
  assertEqual(
    Client_AddScriptNonce("script-src 'self'", "x"),
    "script-src 'self' 'nonce-x'",
    "script-src first",
  );
  assertEqual(
    Client_AddScriptNonce("default-src 'self'; script-src-elem 'self'", "x"),
    null,
    "script-src-elem is not script-src",
  );
  assertEqual(
    Client_AddScriptNonce("default-src 'self'", "x"),
    null,
    "no script-src",
  );
});

Deno.test("client nonce: the build's policy takes one", async () => {
  const headers = await Client_Headers(
    "<script>console.log(1)</script>",
  );
  const csp = headers.split("\n").find((line) =>
    line.trim().startsWith("Content-Security-Policy:")
  ).split(": ").slice(1).join(": ");
  const policy = Client_AddScriptNonce(csp, "x");
  if (policy === null || policy.includes("'nonce-x'") === false) {
    throw new Error("build policy got no nonce: " + policy);
  }
});

Deno.test("client nonce: fresh and base64", () => {
  const a = Client_NewNonce(), b = Client_NewNonce();
  if (a === b) throw new Error("two nonces matched");
  assertEqual(/^[A-Za-z0-9+/]{22}==$/.test(a), true, "16 bytes in base64");
});

Deno.test("client nonce: only HTML with a policy is changed", async () => {
  const html = Client_WithNonce(
    page({
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": CSP,
      "X-Frame-Options": "DENY",
    }),
    "n",
  );
  assertEqual(
    html.headers.get("Content-Security-Policy").includes("'nonce-n'"),
    true,
    "HTML gets the nonce",
  );
  assertEqual(html.headers.get("X-Frame-Options"), "DENY", "others kept");
  assertEqual(await html.text(), "<!doctype html>", "body kept");

  const redirect = page({ Location: "/", "Content-Security-Policy": CSP });
  assertEqual(Client_WithNonce(redirect, "n"), redirect, "no type: as is");

  const script = page({
    "Content-Type": "text/javascript",
    "Content-Security-Policy": CSP,
  });
  assertEqual(Client_WithNonce(script, "n"), script, "not HTML: as is");

  const revalidated = new Response(null, {
    status: 304,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": CSP,
    },
  });
  assertEqual(
    Client_WithNonce(revalidated, "n"),
    revalidated,
    "304: as is, so the cached page keeps its nonce",
  );

  const bare = page({ "Content-Type": "text/html" });
  assertEqual(Client_WithNonce(bare, "n"), bare, "no policy: as is");
});
