// Client address behind a local proxy (no C counterpart)
// Shared by the WebSocket listeners in lobby_server.js and
// net_websocket_server.ts.

const IP_TEXT = /^[0-9A-Fa-f:.]{2,45}$/;

function _isLoopback(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "::1" || host.startsWith("127.") ||
    host.startsWith("::ffff:127.");
}

/**
 * The client's IP for session limits and logs. Behind a local proxy the
 * peer is loopback, so a loopback peer's forwarded address is used: ?ip=
 * (only when trustQuery is set, for a room behind the lobby's proxy), then
 * Cloudflare's CF-Connecting-IP header. Anything else is the peer itself.
 *
 * Cloudflare documents CF-Connecting-IP as the client address it sends from
 * its edge to the origin, and recommends it over X-Forwarded-For
 * (https://developers.cloudflare.com/fundamentals/reference/http-headers/).
 * The page does not mention Tunnel traffic by name, and the "Remove visitor
 * IP headers" Managed Transform strips it; without it every tunnel client
 * shares 127.0.0.1 and the per-IP limits apply to all of them together.
 */
export function WS_ClientAddress(
  url: URL,
  headers: Headers,
  remoteHostname: string,
  trustQuery: boolean,
): string {
  if (_isLoopback(remoteHostname)) {
    if (trustQuery) {
      const ip = url.searchParams.get("ip");
      if (ip !== null && IP_TEXT.test(ip)) return ip;
    }
    const cf = headers.get("cf-connecting-ip");
    if (cf !== null && IP_TEXT.test(cf.trim())) return cf.trim();
  }
  return remoteHostname;
}
