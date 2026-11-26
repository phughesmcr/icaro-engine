// Web addition: the client side of the lobby for rooms hosted in browsers
// (docs/browser-hosted-rooms.md). The lobby is server/lobby_rtc.js, served by
// the Deno lobby's WebSocket listener and by cloudflare/lobby/.
//
// It is the WebRTC driver's signaller (src/net_webrtc.js):
//   - joining: `connect rtc:<CODE>` asks join( code ), which opens a lobby
//     socket, sends LOBBY_JOIN and waits for the room and its ICE servers.
//     The driver's offer, answer and candidates then go through that
//     socket, and the driver calls leave() once the host has accepted or
//     the connect has failed, so a joiner never holds a lobby socket.
//   - hosting: RTCLobby_HostRoom waits for the listen server the caller has
//     started, then registers it with LOBBY_HOST and keeps that socket open
//     for joiners' signals and the heartbeat. The room ends (its socket
//     closes) when Host_ShutdownServer calls RTCLobby_ServerShutdown.
//
// Lobby frames are [type:1][length:2 LE][data], one per WebSocket message,
// as in src/net_websocket.js.

import { Con_DPrintf, Con_Printf } from "./common.js";
import { Cvar_Set } from "./cvar.js";
import { sv, svs } from "./server.js";
import { RTC_HandleSignal, RTC_SetSignaller } from "./net_webrtc.js";
import { Turnstile_Cancel, Turnstile_GetToken } from "./turnstile.js";

// Frame types, as in server/lobby_rtc.js
const LOBBY_JOIN = 0x02;
const LOBBY_HOST = 0x04;
const LOBBY_SIGNAL = 0x05;
const LOBBY_HEARTBEAT = 0x06;
const LOBBY_ROOMS = 0x81;
const LOBBY_ERROR = 0x82;
const LOBBY_ICE = 0x84;
const LOBBY_SIGNAL_RELAY = 0x85;
const LOBBY_VERIFY = 0x86;

// A browser-hosted room's code (server/lobby_rtc.js RTC_ROOM_CODE_PATTERN)
export const RTCLOBBY_ROOM_CODE = /^[A-HJ-NP-Z2-9]{8}$/;

// STUN only, until the lobby sends its list
const RTCLOBBY_DEFAULT_ICE_SERVERS = [{
  urls: ["stun:stun.cloudflare.com:3478"],
}];

let RTCLOBBY_REQUEST_TIMEOUT_MS = 10000; // socket open, then the lobby's reply
let RTCLOBBY_SPAWN_TIMEOUT_MS = 60000; // the host's map loading, map fetch included
let RTCLOBBY_POLL_MS = 1000; // host: spawn, then player count
let RTCLOBBY_HEARTBEAT_MS = 30000; // the lobby drops a host silent for 90 s

const _encoder = new TextEncoder();
const _decoder = new TextDecoder();

let rtclobby_url = null; // () => the lobby's WebSocket URL, or null
let rtclobby_listening = null; // () => true while the server accepts players
let host_session = null; // the hosted room's lobby session
let host_token = 0; // bumped to cancel a HostRoom in progress
let host_timer = null;
let join_session = null; // a join in progress
let join_token = 0; // bumped by each join, so a superseded one gives way
let host_armed = false; // the hosted room's map has spawned
let rules_set = false; // the hosted room set noexit/samelevel
let host_verifying = false; // the host is waiting on the Turnstile widget

// Where a host gets a Turnstile token (src/turnstile.js); tests replace it
let rtclobby_turnstile_token = Turnstile_GetToken;

export function RTCLobby_SetTurnstileTokenSource(getToken) {
  rtclobby_turnstile_token = getToken !== null ? getToken : Turnstile_GetToken;
}

/** Test hook: shorter timers. */
export function RTCLobby_SetTimeouts(
  { requestMs, spawnMs, pollMs, heartbeatMs } = {},
) {
  if (requestMs !== undefined) RTCLOBBY_REQUEST_TIMEOUT_MS = requestMs;
  if (spawnMs !== undefined) RTCLOBBY_SPAWN_TIMEOUT_MS = spawnMs;
  if (pollMs !== undefined) RTCLOBBY_POLL_MS = pollMs;
  if (heartbeatMs !== undefined) RTCLOBBY_HEARTBEAT_MS = heartbeatMs;
}

function _RTCLobby_Frame(type, value) {
  const data = typeof value === "string" ?
    _encoder.encode(value) :
    _encoder.encode(JSON.stringify(value));
  const frame = new Uint8Array(3 + data.length);
  frame[0] = type;
  frame[1] = data.length & 0xff;
  frame[2] = (data.length >> 8) & 0xff;
  frame.set(data, 3);
  return frame;
}

function _RTCLobby_Decode(message) {
  if ((message instanceof ArrayBuffer) === false) return null;
  const bytes = new Uint8Array(message);
  if (bytes.length < 3 || bytes.length !== 3 + (bytes[1] | (bytes[2] << 8))) {
    return null;
  }
  const text = _decoder.decode(bytes.subarray(3));
  if (bytes[0] === LOBBY_ERROR) return { type: bytes[0], value: text };
  try {
    return { type: bytes[0], value: text.length > 0 ? JSON.parse(text) : null };
  } catch {
    return null;
  }
}

// An error the lobby (or reaching it) gave: the driver shows its text
function _RTCLobby_Error(message) {
  const error = new Error(message);
  error.lobby = true;
  return error;
}

// A host given up for something newer (another Start Game, or the server
// stopping): not a failure to report
function _RTCLobby_Cancelled() {
  const error = _RTCLobby_Error("Hosting was cancelled");
  error.cancelled = true;
  return error;
}

function _RTCLobby_Send(session, type, value) {
  if (session.closed === true) return;
  try {
    session.socket.send(_RTCLobby_Frame(type, value));
  } catch (error) {
    Con_DPrintf("Lobby send failed: " + error.message + "\n");
  }
}

function _RTCLobby_Close(session) {
  if (session === null || session.closed === true) return;
  session.closed = true;
  session.ending = true;
  try {
    session.socket.close(1000);
  } catch { /* already closed */ }
}

/**
 * Open a lobby socket, send one LOBBY_HOST or LOBBY_JOIN, and resolve to the
 * session once the lobby has replied with the room (LOBBY_ROOMS) and the ICE
 * servers (LOBBY_ICE). The socket stays open for signals. Rejects with the
 * lobby's LOBBY_ERROR text, or on a timeout or a closed socket. A lobby that
 * wants a Turnstile token first (LOBBY_VERIFY) rejects with an error whose
 * `turnstile` is { sitekey, action }.
 */
function _RTCLobby_Request(url, role, type, value) {
  return new Promise((resolve, reject) => {
    let socket;
    try {
      socket = new WebSocket(url);
    } catch (error) {
      reject(_RTCLobby_Error("Could not reach the lobby: " + error.message));
      return;
    }

    socket.binaryType = "arraybuffer";
    const session = {
      socket,
      role,
      code: null,
      room: null,
      iceServers: null,
      closed: false,
      ending: false,
      onLost: null,
    };
    let settled = false;

    const fail = (message, turnstile) => {
      if (settled === true) return;
      settled = true;
      clearTimeout(timer);
      _RTCLobby_Close(session);
      const error = _RTCLobby_Error(message);
      if (turnstile !== undefined) error.turnstile = turnstile;
      reject(error);
    };
    const timer = setTimeout(
      () => fail("The lobby did not answer"),
      RTCLOBBY_REQUEST_TIMEOUT_MS,
    );

    socket.onopen = () => _RTCLobby_Send(session, type, value);

    socket.onmessage = (event) => {
      const frame = _RTCLobby_Decode(event.data);
      if (frame === null) return;

      if (settled === false) {
        if (frame.type === LOBBY_ERROR) {
          fail(frame.value);
        } else if (frame.type === LOBBY_VERIFY) {
          const challenge = frame.value;
          if (
            challenge === null || typeof challenge !== "object" ||
            typeof challenge.sitekey !== "string" || challenge.sitekey === "" ||
            typeof challenge.action !== "string" || challenge.action === ""
          ) {
            fail("Invalid verification request from the lobby");
          } else {
            fail("Verification required", {
              sitekey: challenge.sitekey,
              action: challenge.action,
            });
          }
        } else if (
          frame.type === LOBBY_ROOMS && frame.value !== null &&
          typeof frame.value.id === "string"
        ) {
          session.room = frame.value;
        } else if (frame.type === LOBBY_ICE && session.room !== null) {
          session.iceServers = Array.isArray(frame.value) ?
            frame.value :
            RTCLOBBY_DEFAULT_ICE_SERVERS;
          settled = true;
          clearTimeout(timer);
          resolve(session);
        }
        return;
      }

      if (
        frame.type === LOBBY_SIGNAL_RELAY && frame.value !== null &&
        typeof frame.value.from === "string"
      ) {
        RTC_HandleSignal(frame.value.from, frame.value.kind, frame.value.data);
      } else if (frame.type === LOBBY_ERROR) {
        Con_DPrintf("Lobby: " + frame.value + "\n");
      }
    };

    socket.onclose = () => {
      const lost = session.closed === false;
      session.closed = true;
      fail("Lost the connection to the lobby");
      if (lost === true && session.onLost !== null) session.onLost();
    };
    socket.onerror = () => {};
  });
}

// The WebRTC driver's signaller
const rtclobby_signaller = {
  send(to, kind, data) {
    // A joiner addresses the room's code; a host, its joiners' peer ids.
    // A joiner's late candidates, after leave(), go nowhere.
    let session = null;
    if (join_session !== null && join_session.code === to) {
      session = join_session;
    } else if (RTCLOBBY_ROOM_CODE.test(to) === false) session = host_session;
    if (session !== null) {
      _RTCLobby_Send(session, LOBBY_SIGNAL, { to, kind, data });
    }
  },

  iceServers() {
    const session = join_session !== null ? join_session : host_session;
    return session !== null && session.iceServers !== null ?
      session.iceServers :
      RTCLOBBY_DEFAULT_ICE_SERVERS;
  },

  // Before a joiner's offer: find the room through the lobby
  async join(code) {
    const url = rtclobby_url !== null ? rtclobby_url() : null;
    if (url === null) {
      throw _RTCLobby_Error("Rooms hosted in browsers need a WebSocket lobby");
    }

    _RTCLobby_Close(join_session);
    join_session = null;
    const token = ++join_token;

    const session = await _RTCLobby_Request(url, "joiner", LOBBY_JOIN, code);
    if (token !== join_token) {
      // A newer connect started while the lobby answered this one
      _RTCLobby_Close(session);
      throw _RTCLobby_Error("Superseded by a newer connect");
    }
    session.code = code;
    join_session = session;
    return session;
  },

  // After the host accepted the joiner, or the connect failed
  leave(session) {
    if (session === null || session === undefined) return;
    _RTCLobby_Close(session);
    if (join_session === session) join_session = null;
  },
};

/**
 * Install the signaller. lobbyUrl() gives the lobby's WebSocket address (or
 * null when the page's lobby isn't reached over WebSocket); listening() says
 * whether the server accepts remote players.
 */
export function RTCLobby_Init(lobbyUrl, listening) {
  rtclobby_url = lobbyUrl;
  rtclobby_listening = listening;
  RTC_SetSignaller(rtclobby_signaller);

  // A joiner's lobby socket goes with the page; a host's room ends through
  // Host_PageHide's Host_ShutdownServer
  if (
    typeof window !== "undefined" &&
    typeof window.addEventListener === "function"
  ) {
    window.addEventListener("pagehide", () => {
      _RTCLobby_Close(join_session);
      join_session = null;
    });
  }
}

/** True if hosting in this browser can work here: a WebSocket lobby. */
export function RTCLobby_CanHost() {
  return rtclobby_url !== null && rtclobby_url() !== null;
}

function _RTCLobby_PlayerCount() {
  let players = 0;
  for (let i = 0; i < svs.maxclients; i++) {
    if (svs.clients[i] != null && svs.clients[i].active) players++;
  }
  return players;
}

function _RTCLobby_Wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Register the listen server this page is starting with the lobby. The caller
 * has already queued its commands (maxplayers, listen, map); spawnCount is
 * svs.spawncount from before them, so a server that was running before
 * doesn't count. Resolves to the room record (its id is the code to share).
 * config: { map, hostName, public, options }; maxPlayers comes from the server.
 * exitRules: the caller set the room's noexit/samelevel, to undo at the end.
 */
export async function RTCLobby_HostRoom(config, spawnCount, exitRules) {
  const token = ++host_token;
  _RTCLobby_EndHost();
  host_armed = false;
  rules_set = exitRules === true;

  const url = rtclobby_url !== null ? rtclobby_url() : null;
  if (url === null) {
    _RTCLobby_ResetRules();
    throw _RTCLobby_Error("Rooms hosted in browsers need a WebSocket lobby");
  }

  // Register only once joiners can be answered: the map is up and the
  // driver accepts offers
  const deadline = Date.now() + RTCLOBBY_SPAWN_TIMEOUT_MS;
  for (;;) {
    if (token !== host_token) throw _RTCLobby_Cancelled();

    // The caller queued one map: a second spawn, or another map, means
    // the room's game ended before it registered and something else runs
    if (
      svs.spawncount !== spawnCount && (svs.spawncount !== spawnCount + 1 ||
        (typeof config.map === "string" && sv.name !== config.map))
    ) {
      _RTCLobby_ResetRules();
      throw _RTCLobby_Error("Another game started before the room was listed");
    }

    if (
      svs.spawncount !== spawnCount && sv.active === true &&
      svs.maxclients >= 2 &&
      rtclobby_listening !== null && rtclobby_listening() === true
    ) break;

    if (Date.now() > deadline) {
      // The room never registered, so its end won't reset the rules:
      // whatever runs now is an ordinary game
      _RTCLobby_ResetRules();
      throw _RTCLobby_Error("The game did not start");
    }
    await _RTCLobby_Wait(RTCLOBBY_POLL_MS);
  }

  // From here Host_ShutdownServer ends this room, lobby or not
  host_armed = true;

  const request = {
    map: sv.name,
    maxPlayers: svs.maxclients,
    hostName: config.hostName,
    public: config.public === true,
  };
  if (config.options !== undefined) request.options = config.options;

  let session;
  try {
    session = await _RTCLobby_RequestHost(url, request, token);
  } catch (error) {
    // Superseded while the lobby answered: a cancel, whatever it said
    if (token !== host_token || host_armed === false) {
      throw _RTCLobby_Cancelled();
    }
    throw error;
  }
  if (token !== host_token || host_armed === false) {
    // The server stopped while the lobby answered
    _RTCLobby_Close(session);
    throw _RTCLobby_Cancelled();
  }

  session.code = session.room.id;
  session.onLost = () => {
    Con_Printf(
      "Lost the lobby: new players can't join room %s\n",
      session.code,
    );
    if (host_session === session) _RTCLobby_EndHost();
  };
  host_session = session;

  // Heartbeat: every RTCLOBBY_HEARTBEAT_MS, and at once when the player
  // count changes, so the lobby's "room is full" stays right
  let sentPlayers = 1;
  let sentAt = Date.now();
  host_timer = setInterval(() => {
    if (host_session !== session) return;
    const players = _RTCLobby_PlayerCount();
    const now = Date.now();
    if (players === sentPlayers && now - sentAt < RTCLOBBY_HEARTBEAT_MS) return;
    sentPlayers = players;
    sentAt = now;
    _RTCLobby_Send(session, LOBBY_HEARTBEAT, { players });
  }, RTCLOBBY_POLL_MS);

  return session.room;
}

/**
 * Send LOBBY_HOST. A lobby that checks room creation (server/turnstile.js)
 * answers the first request with LOBBY_VERIFY: show the widget, then ask once
 * more with its token, as NET_CreateRoom does for lobby rooms. token is the
 * HostRoom's, to notice a cancel while the widget is up.
 */
async function _RTCLobby_RequestHost(url, request, token) {
  let challenge;
  try {
    return await _RTCLobby_Request(url, "host", LOBBY_HOST, request);
  } catch (error) {
    if (error.turnstile === undefined) throw error;
    challenge = error.turnstile;
  }

  if (token !== host_token || host_armed === false) throw _RTCLobby_Cancelled();

  let verified;
  host_verifying = true;
  try {
    verified = await rtclobby_turnstile_token(
      challenge.sitekey,
      challenge.action,
    );
  } catch (error) {
    // The server stopping, or a newer Start Game, removes the widget
    if (token !== host_token || host_armed === false) {
      throw _RTCLobby_Cancelled();
    }
    throw _RTCLobby_Error(
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    host_verifying = false;
  }

  if (token !== host_token || host_armed === false) throw _RTCLobby_Cancelled();

  try {
    return await _RTCLobby_Request(url, "host", LOBBY_HOST, {
      ...request,
      turnstile: verified,
    });
  } catch (error) {
    // The lobby refused the token it asked for
    if (error.turnstile !== undefined) {
      throw _RTCLobby_Error("Verification failed. Try again.");
    }
    throw error;
  }
}

function _RTCLobby_EndHost() {
  if (host_verifying === true) Turnstile_Cancel();

  if (host_timer !== null) {
    clearInterval(host_timer);
    host_timer = null;
  }
  _RTCLobby_Close(host_session);
  host_session = null;
}

/**
 * Host_ShutdownServer ends the hosted room: its lobby socket closes, which
 * removes the room, and the exit rules it set go back to the C's defaults so
 * a later single-player game isn't affected. Before the room's own map has
 * spawned (the "disconnect" ahead of its "map"), this does nothing.
 */
export function RTCLobby_ServerShutdown() {
  if (host_armed === false) return;

  host_armed = false;
  if (host_session !== null) {
    Con_DPrintf("Closing lobby room %s\n", host_session.code);
  }
  host_token++;
  _RTCLobby_EndHost();
  _RTCLobby_ResetRules();
}

function _RTCLobby_ResetRules() {
  if (rules_set === false) return;
  rules_set = false;
  Cvar_Set("noexit", "0");
  Cvar_Set("samelevel", "0");
}

/** Test hook: the open sessions. */
export function RTCLobby_GetStateForTest() {
  return { host: host_session, join: join_session };
}
