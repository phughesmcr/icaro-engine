// The lobby Worker's checks before a request reaches the Durable Object:
// path, WebSocket upgrade, the page's Origin and a per-IP connection rate.
// Kept out of worker.js (which imports cloudflare:workers) so Deno tests can
// run it. A request turned away here never wakes the Durable Object, so it
// costs one Worker request and no Durable Object request.

/** Whether `origin` (a request's Origin header, or null) may open a socket. */
export function Lobby_OriginAllowed(origin, allowed) {
  // Non-browser clients send no Origin and could forge one anyway. The check
  // stops other sites' pages from using this lobby (and its TURN relays)
  // through their visitors' browsers.
  if (origin === null) return true;
  if (allowed.length === 0) return true;
  return allowed.includes(origin.toLowerCase());
}

/**
 * LOBBY_ORIGINS as a list: comma-separated origins such as
 * "https://quake.example.com", lowercased, with no trailing slash. Unset or
 * empty means any origin.
 */
export function Lobby_ParseOrigins(value) {
  if (typeof value !== "string") return [];
  return value.split(",")
    .map((origin) => origin.trim().toLowerCase().replace(/\/+$/, ""))
    .filter((origin) => origin.length > 0);
}

/**
 * Call a Workers rate-limit binding for `key`. True if the request may go
 * ahead: also when the binding isn't configured, or fails (fail open: the
 * Durable Object's own limits still apply).
 */
export async function Lobby_RateLimitOk(limiter, key) {
  if (limiter === undefined || limiter === null) return true;
  try {
    const { success } = await limiter.limit({ key });
    return success !== false;
  } catch {
    return true;
  }
}

/**
 * The Response to turn `request` away with, or null to pass it to the
 * Durable Object. env holds LOBBY_ORIGINS and the LOBBY_CONNECT_LIMIT
 * binding (both optional).
 */
export async function Lobby_Gate(request, env) {
  const url = new URL(request.url);
  if (/\/lobby\/?$/.test(url.pathname) === false) {
    return new Response(
      "Icaro Engine lobby: the WebSocket endpoint is /lobby. Rooms here are hosted in browsers.\n",
      { status: 404 },
    );
  }
  if ((request.headers.get("upgrade") ?? "").toLowerCase() !== "websocket") {
    return new Response("WebSocket only\n", {
      status: 426,
      headers: { upgrade: "websocket" },
    });
  }
  const origins = Lobby_ParseOrigins(env.LOBBY_ORIGINS);
  if (Lobby_OriginAllowed(request.headers.get("origin"), origins) === false) {
    return new Response("Origin not allowed\n", { status: 403 });
  }
  // Set by Cloudflare's edge, so a client can't forge it. Absent only under
  // wrangler dev, where every client shares the "unknown" bucket.
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  if (await Lobby_RateLimitOk(env.LOBBY_CONNECT_LIMIT, ip) === false) {
    return new Response("Too many requests\n", {
      status: 429,
      headers: { "retry-after": "60" },
    });
  }
  return null;
}
