// The client Worker's per-request CSP nonce, without the Workers-only parts
// (worker.js holds those), so Deno tests can drive it.
//
// Cloudflare injects its JavaScript Detections script into the page as an
// inline script. It changes with every request, so build.js can't hash it.
// When the response's Content-Security-Policy header has a nonce in
// script-src, Cloudflare reads it and puts it on the scripts it injects. So
// the Worker runs for the page alone (run_worker_first in wrangler.jsonc)
// and adds a fresh nonce to the policy _headers gives it. The page's own
// inline scripts keep their hashes; a nonce and hashes can sit together.

/** A fresh nonce: 16 random bytes, base64. */
export function Client_NewNonce() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}

/**
 * csp with 'nonce-<nonce>' added to its script-src directive. Null when the
 * policy has no script-src, so the caller serves the page unchanged.
 */
export function Client_AddScriptNonce(csp, nonce) {
  const directives = csp.split(";");
  let found = false;
  for (let i = 0; i < directives.length; i++) {
    const directive = directives[i].trim();
    if (directive.split(/\s+/)[0].toLowerCase() !== "script-src") continue;
    directives[i] = (i === 0 ? "" : " ") + directive + " 'nonce-" + nonce +
      "'";
    found = true;
    break;
  }
  return found ? directives.join(";") : null;
}

/**
 * The page's response with a fresh nonce in its policy. Anything that isn't
 * HTML with a script-src policy (a redirect, a 304, a 404) passes through.
 */
export function Client_WithNonce(response, nonce = Client_NewNonce()) {
  const type = response.headers.get("Content-Type");
  const csp = response.headers.get("Content-Security-Policy");
  if (type === null || type.startsWith("text/html") === false) return response;
  if (csp === null) return response;
  const policy = Client_AddScriptNonce(csp, nonce);
  if (policy === null) return response;

  const headers = new Headers(response.headers);
  headers.set("Content-Security-Policy", policy);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
