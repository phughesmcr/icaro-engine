// The LibreQuake zip Worker's script: it runs on the route
// quake.anglezarke.games/static/librequake/* (wrangler.jsonc), in front of
// the client Worker's Custom Domain, and serves the release zips from the
// R2 bucket bound as LQ_BUCKET. serve.js has the logic, so Deno tests can
// run it. See ../README.md to deploy.

import { LQ_R2_Serve } from "./serve.js";

export default {
  fetch(request, env) {
    return LQ_R2_Serve(request, env.LQ_BUCKET);
  },
};
