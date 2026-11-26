// The client Worker's script: it runs only for the page itself ("/", see
// run_worker_first in wrangler.jsonc). Every other path is served as a
// static asset without it. nonce.js says why it exists.

import { Client_WithNonce } from "./nonce.js";

export default {
  async fetch(request, env) {
    return Client_WithNonce(await env.ASSETS.fetch(request));
  },
};
