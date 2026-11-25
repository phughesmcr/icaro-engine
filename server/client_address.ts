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
