/**
 * Dual-stack QUIC listening for the lobby and room servers.
 *
 * Browsers may resolve `localhost` to `::1` before `127.0.0.1`, so a listener
 * bound to `0.0.0.0` alone never sees their QUIC handshake. The servers bind
 * the IPv6 wildcard `::` first. Deno opens it with a plain UDP bind and leaves
 * IPV6_V6ONLY at the OS default, which accepts IPv4 too on macOS and on Linux
 * (unless `net.ipv6.bindv6only=1`). The IPv4 wildcard is then bound as well:
 * - if `::` is dual-stack, that bind fails with AddrInUse and `::` covers IPv4;
 * - if `::` is IPv6-only (Windows, or bindv6only=1), it succeeds and serves IPv4;
 * - if IPv6 is unavailable (some containers), `::` fails and IPv4 serves alone.
 *
 * The AddrInUse case can't tell a dual-stack `::` from another process
 * holding `0.0.0.0:<port>`. In that case IPv4 clients reach the other process.
 * Deno exposes no IPV6_V6ONLY query, and probing with a second port would need
 * a wider --allow-net grant, so this is accepted as a port clash.
 *
 * Deno reports IPv4 peers on a dual-stack socket as plain dotted addresses
 * (`127.0.0.1`, not `::ffff:127.0.0.1`; quic.rs applies `to_canonical()`), so
 * per-IP limits see the same key.
 *
 * Both processes need `--allow-net=[::]:<port>,0.0.0.0:<port>`.
 */

export const QUIC_IPV6_ANY = "::";
export const QUIC_IPV4_ANY = "0.0.0.0";

/** Creates one endpoint; injectable for tests. */
export type QuicEndpointFactory = (
  options: { hostname: string; port: number },
) => Deno.QuicEndpoint;

export interface QuicEndpoints {
  endpoints: Deno.QuicEndpoint[];
  /** Human-readable summary of what was bound, for the startup log. */
  description: string;
}

function _defaultFactory(
  options: { hostname: string; port: number },
): Deno.QuicEndpoint {
  return new Deno.QuicEndpoint(options);
}

function _isAddrInUse(error: unknown): boolean {
  return error instanceof Deno.errors.AddrInUse;
}

// Errors that must not be mistaken for "IPv6 is unavailable here": the port is
// taken, or --allow-net does not grant the bind.
function _isFatalBindError(error: unknown): boolean {
  return error instanceof Deno.errors.AddrInUse ||
    error instanceof Deno.errors.NotCapable ||
    error instanceof Deno.errors.PermissionDenied;
}

/**
 * Bind QUIC endpoints on `port` for both IPv6 and IPv4 clients.
 * Throws if no endpoint could be bound, or if the port is already in use.
 */
export function QUIC_OpenEndpoints(
  port: number,
  create: QuicEndpointFactory = _defaultFactory,
): QuicEndpoints {
  let v6: Deno.QuicEndpoint | null = null;
  try {
    v6 = create({ hostname: QUIC_IPV6_ANY, port });
  } catch (error) {
    if (_isFatalBindError(error)) throw error;
    // IPv6 unavailable: carry on with IPv4 alone.
  }

  let v4: Deno.QuicEndpoint | null = null;
  try {
    v4 = create({ hostname: QUIC_IPV4_ANY, port });
  } catch (error) {
    // AddrInUse after a successful `::` bind means `::` is dual-stack.
    if (v6 === null || !_isAddrInUse(error)) {
      if (v6 !== null) {
        try {
          v6.close();
        } catch { /* ignore */ }
      }
      throw error;
    }
  }

  if (v6 !== null && v4 !== null) {
    return {
      endpoints: [v6, v4],
      description: "[::] (IPv6) and 0.0.0.0 (IPv4)",
    };
  }
  if (v6 !== null) {
    return { endpoints: [v6], description: "[::] (IPv6 and IPv4)" };
  }
  return { endpoints: [v4!], description: "0.0.0.0 (IPv4 only)" };
}

/** Close every endpoint, ignoring errors from ones already closed. */
export function QUIC_CloseEndpoints(endpoints: Deno.QuicEndpoint[]): void {
  for (const endpoint of endpoints) {
    try {
      endpoint.close();
    } catch { /* ignore */ }
  }
}
