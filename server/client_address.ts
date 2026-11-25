// Client address behind a proxy (no C counterpart)
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
 * trustAnyPeer (a room's -trustproxy) is for a listener that only a proxy can
 * reach but whose peer isn't loopback: a Cloudflare Container, reachable only
 * through its Durable Object. The forwarded address is then used whatever the
 * peer: CF-Connecting-IP first, then ?ip= (when trustQuery is set) only when
 * there is no such header, so a client-supplied ?ip= can't override it. A proxy that doesn't set
 * the header must set or overwrite ?ip= itself. Never use it on a port that
 * anything other than the proxy can reach: every client could then pick its
 * own address and dodge the per-IP limits.
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
  trustAnyPeer = false,
): string {
  if (trustAnyPeer) {
    // A header that is present but malformed doesn't fall through to ?ip=
    if (headers.has("cf-connecting-ip")) {
      return _forwardedHeader(headers) ?? remoteHostname;
    }
    const ip = trustQuery ? _forwardedQuery(url) : null;
    if (ip !== null) return ip;
  } else if (_isLoopback(remoteHostname)) {
    const ip = trustQuery ? _forwardedQuery(url) : null;
    if (ip !== null) return ip;
    const cf = _forwardedHeader(headers);
    if (cf !== null) return cf;
  }
  return remoteHostname;
}

function _forwardedQuery(url: URL): string | null {
  const ip = url.searchParams.get("ip");
  return ip !== null && IP_TEXT.test(ip) ? ip : null;
}

function _forwardedHeader(headers: Headers): string | null {
  const cf = headers.get("cf-connecting-ip");
  if (cf === null) return null;
  const ip = cf.trim();
  return IP_TEXT.test(ip) ? ip : null;
}
