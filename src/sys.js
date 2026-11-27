// Ported from: WinQuake/sys.h + sys_win.c -- system interface (browser)

// SYSTEM IO

export function Sys_Init() {
  console.log("Icaro Engine initializing...");
}

export function Sys_Error(error) {
  console.error("Sys_Error: " + error);

  // Display error on screen (browser only)
  if (typeof document !== "undefined") {
    document.body.innerHTML =
      '<pre style="color:red;padding:20px;font-size:16px;">Sys_Error: ' +
      error + "</pre>";
  }

  throw new Error(error);
}

// LOBBY ADDRESS (web only, no C counterpart)
//
// The page's ?server= parameter names the multiplayer lobby. It comes from a
// link anyone can craft, and the menus and the auto-join turn it into a
// `connect "..."` line for the command buffer, so it is checked here: a `"`
// would end the quoted argument, and a `;` or newline would start a new
// command.

export const SYS_DEFAULT_LOBBY = "https://localhost:4433";

// A hostname after URL parsing (lowercase, IDN as punycode), or an IPv6 literal.
const _lobbyHostPattern = /^(?:[a-z0-9_-]+\.)*[a-z0-9_-]+$|^\[[0-9a-f:.]+\]$/;
// Anything that could end a quoted argument or a command line.
const _unsafeCommandChars = /["';\\\s\p{Cc}]/u;
// A WebSocket lobby's path (e.g. the tunnel's /mp): plain segments only.
const _lobbyPathPattern = /^(?:\/[A-Za-z0-9._~-]+)*\/?$/;

/**
 * Returns raw as 'https://host[:port]' if it names a lobby: an https://, wts://
 * or wt:// URL (or a bare host[:port]) with no user info, path, query or
 * fragment. A WebSocket lobby (src/net_websocket.js) may also be a ws:// or
 * wss:// URL with a path of plain segments, returned as
 * 'wss://host[:port]/path' (or ws://) without a trailing slash. Returns null
 * for anything else.
 */
export function Sys_ParseLobbyURL(raw) {
  if (
    typeof raw !== "string" || raw.length === 0 || _unsafeCommandChars.test(raw)
  ) {
    return null;
  }

  let url = raw;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(url);
  if (scheme !== null && /^wss?$/i.test(scheme[1])) {
    return _Sys_ParseWebSocketLobbyURL(raw);
  }
  if (scheme === null) {
    url = "https://" + url;
  } else if (/^(?:https|wts?)$/i.test(scheme[1])) {
    url = "https://" + url.substring(scheme[0].length);
  } else {
    return null;
  }

  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }

  if (u.protocol !== "https:" || u.username !== "" || u.password !== "") {
    return null;
  }
  if (u.pathname !== "/" || u.search !== "" || u.hash !== "") {
    return null;
  }
  if (_lobbyHostPattern.test(u.hostname) === false) {
    return null;
  }

  return "https://" + u.host;
}

function _Sys_ParseWebSocketLobbyURL(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }

  if (
    (u.protocol !== "wss:" && u.protocol !== "ws:") || u.username !== "" ||
    u.password !== ""
  ) {
    return null;
  }
  if (
    u.search !== "" || u.hash !== "" ||
    _lobbyPathPattern.test(u.pathname) === false
  ) {
    return null;
  }
  if (_lobbyHostPattern.test(u.hostname) === false) {
    return null;
  }

  return u.protocol + "//" + u.host + u.pathname.replace(/\/+$/, "");
}

/**
 * True when s can be quoted into a command line as one argument: no quote,
 * semicolon, backslash, whitespace or control character.
 */
export function Sys_CommandArgIsSafe(s) {
  return typeof s === "string" && _unsafeCommandChars.test(s) === false;
}

/**
 * The lobby named by the page's ?server= parameter, as 'https://host[:port]'.
 * SYS_DEFAULT_LOBBY when there is none, and null when it is not a valid lobby
 * address (callers refuse to connect rather than fall back to localhost).
 */
export function Sys_LobbyURL() {
  const server = new URLSearchParams(globalThis.location.search).get("server");
  if (server === null || server === "") {
    return SYS_DEFAULT_LOBBY;
  }
  return Sys_ParseLobbyURL(server);
}

/**
 * The argument for a `connect` command: 'wts://host[:port]' for lobby (a
 * Sys_LobbyURL result), with the port replaced by port when it is not null and
 * '?room=<id>' added when roomId is not null. The room id is percent-encoded.
 * Returns null if lobby or port is invalid, so the caller never quotes an
 * unchecked string into the command buffer.
 */
export function Sys_ConnectURL(lobby, roomId, port) {
  const host = Sys_ParseLobbyURL(lobby);
  if (host === null) {
    return null;
  }

  const u = new URL(host);
  if (port !== null) {
    if (Number.isInteger(port) === false || port < 1 || port > 65535) {
      return null;
    }
    u.port = String(port);
  }

  let connectUrl = "wts://" + u.host;
  if (roomId !== null) {
    const params = new URLSearchParams();
    params.set("room", String(roomId));
    connectUrl += "?" + params.toString();
  }

  // URLSearchParams percent-encodes every character that matters here; this
  // is a last check that nothing can end the quoted argument.
  if (_unsafeCommandChars.test(connectUrl)) {
    return null;
  }
  return connectUrl;
}

/**
 * The page URL to put in the address bar: room= when roomId is given, and
 * game=, server= and transport= kept from the current URL, since whoever opens
 * a shared link needs the same mission pack, lobby and transport. server= is
 * kept only when it is a valid lobby address, and transport= only when it is
 * ws or wt. Other parameters are dropped.
 */
export function Sys_PageURL(roomId) {
  const params = new URLSearchParams();
  if (roomId) params.set("room", roomId);
  const current = new URLSearchParams(globalThis.location.search);
  const game = current.get("game");
  if (game !== null) params.set("game", game);
  const server = current.get("server");
  if (server !== null && Sys_ParseLobbyURL(server) !== null) {
    params.set("server", server);
  }
  const transport = current.get("transport");
  if (transport === "ws" || transport === "wt") {
    params.set("transport", transport);
  }
  const query = params.toString();
  return globalThis.location.origin + globalThis.location.pathname +
    (query.length > 0 ? "?" + query : "");
}

const _quietLogAllowPatterns = [
  /^Connection from /,
  /^Connection closed:/,
  /^Client .*(connected|removed)\b/,
  /^Spawning server for map:/,
  /^SpawnServer:/,
  /^Server initialized!/,
  /^Room .* idle for /,
  /^Host_ServerFrame error:/,
  /^SV_ReadClientMessage:/,
  /^Unhandled promise rejection:/,
  /^WebTransport server listening /,
  /^WebSocket server listening /,
  /^WebTransport server driver initialized/,
  /^NET_Init complete/,
  /^\[Heartbeat\]/,
  /^Host_Error/,
  /^Room .* (shutting down|exiting)/,
];

function _isDenoRuntime() {
  return typeof Deno !== "undefined" && Deno.version != null;
}

/**
 * Not in id's C: fmt with its %s, %d, %i and %f replaced by args, as
 * Sys_Printf prints it (common.js Con_Printf's fallback too).
 */
export function Sys_FormatPrintf(fmt, args) {
  return _formatPrintf(fmt, args);
}

function _formatPrintf(fmt, args) {
  if (args.length === 0) return String(fmt);

  let result = String(fmt);
  let index = 0;
  result = result.replace(/%[sdif]/g, () => {
    if (index >= args.length) return "";
    return String(args[index++]);
  });

  if (index < args.length) {
    result += " " + args.slice(index).map(String).join(" ");
  }

  return result;
}

function _shouldPrintLine(line) {
  if (_isDenoRuntime() !== true) return true;

  const quietLogs = globalThis.__ICARO_QUIET_LOGS === true;
  if (quietLogs !== true) return true;

  const trimmed = line.trim();
  if (trimmed.length === 0) return false;

  for (const pattern of _quietLogAllowPatterns) {
    if (pattern.test(trimmed)) return true;
  }

  return false;
}

export function Sys_Printf(fmt, ...args) {
  const line = _formatPrintf(fmt, args);
  if (_shouldPrintLine(line) !== true) return;
  console.log(line);
}

export function Sys_Quit() {
  console.log("Sys_Quit");
}

// DETERMINISM HOOKS
//
// Not in id's C. A lockstep driver (an agent, an RL environment, a bug-report
// replay) needs a run to be reproducible from a seed and an action log, so the
// clock and the server's gameplay randomness can be put under its control.
// Both are opt-in: with neither set, behaviour is unchanged.

let _clockOverride = null;

/**
 * Makes Sys_FloatTime and Sys_DoubleTime return fn() (seconds) instead of the
 * wall clock; null restores the wall clock. A lockstep driver keeps its own
 * time and passes the matching frame time to Host_Frame.
 */
export function Sys_SetClockOverride(fn) {
  if (fn !== null && typeof fn !== "function") {
    throw new TypeError("Sys_SetClockOverride: expected a function or null");
  }
  _clockOverride = fn;
}

export function Sys_FloatTime() {
  if (_clockOverride !== null) {
    return _clockOverride();
  }
  return performance.now() / 1000.0;
}

export function Sys_DoubleTime() {
  if (_clockOverride !== null) {
    return _clockOverride();
  }
  return performance.now() / 1000.0;
}

// sfc32 state (four 32-bit words); _randomSeeded false means Math.random
let _randomSeeded = false;
let _rand_a = 0, _rand_b = 0, _rand_c = 0, _rand_d = 0;

/**
 * Server-side gameplay randomness, 0 <= num < 1: QuakeC random() (PF_random)
 * and monster chase moves (SV_NewChaseDir, SV_MoveToGoal).
 *
 * Deliberate deviation: Quake drew these from the C library's rand(), which
 * nothing outside the engine could seed. The port used Math.random; it still
 * does unless Sys_SetRandomSeed has been called. Math.random is looked up on
 * each call, so code that swaps it (tools/bench) still controls the default.
 */
export function Sys_Random() {
  if (_randomSeeded !== true) {
    return Math.random();
  }

  // sfc32 (Chris Doty-Humphrey's Small Fast Counting generator)
  const t = (_rand_a + _rand_b | 0) + _rand_d | 0;
  _rand_d = _rand_d + 1 | 0;
  _rand_a = _rand_b ^ _rand_b >>> 9;
  _rand_b = _rand_c + (_rand_c << 3) | 0;
  _rand_c = _rand_c << 21 | _rand_c >>> 11;
  _rand_c = _rand_c + t | 0;
  return (t >>> 0) / 4294967296;
}

/**
 * Seeds Sys_Random with a 32-bit integer (other numbers are truncated to one);
 * null goes back to Math.random. The same seed gives the same sequence.
 */
export function Sys_SetRandomSeed(seed) {
  if (seed === null) {
    _randomSeeded = false;
    return;
  }

  if (typeof seed !== "number" || Number.isFinite(seed) !== true) {
    throw new TypeError("Sys_SetRandomSeed: expected a finite number or null");
  }

  // splitmix32 spreads the seed over the state, so nearby seeds diverge
  let s = seed | 0;
  const next = () => {
    s = s + 0x9e3779b9 | 0;
    let z = s;
    z = Math.imul(z ^ z >>> 16, 0x21f0aaad);
    z = Math.imul(z ^ z >>> 15, 0x735a2d97);
    return z ^ z >>> 15;
  };

  _rand_a = next();
  _rand_b = next();
  _rand_c = next();
  _rand_d = 1;
  _randomSeeded = true;

  // discard the first outputs, as sfc32's reference seeding does
  for (let i = 0; i < 12; i++) {
    Sys_Random();
  }
}
