// Ported from: WinQuake/net_main.c -- network main module

import {
  Sys_CommandArgIsSafe,
  Sys_ConnectURL,
  SYS_DEFAULT_LOBBY,
  Sys_Error,
  Sys_FloatTime,
  Sys_ParseLobbyURL,
} from "./sys.js";
import {
  com_argc,
  com_argv,
  COM_CheckParm,
  COM_SetNetMessage,
  Con_Printf,
  Q_atoi,
  SZ_Alloc,
} from "./common.js";
import { Cbuf_AddText, Cmd_AddCommand, Cmd_Argc, Cmd_Argv } from "./cmd.js";
import { Cvar_RegisterVariable, Cvar_Set, cvar_t } from "./cvar.js";
import {
  DEFAULTnet_hostport,
  hostcache,
  hostCacheCount,
  net_activeconnections,
  net_activeSockets,
  net_driverlevel,
  net_drivers,
  net_freeSockets,
  net_hostport,
  NET_MAXMESSAGE,
  net_message,
  net_numdrivers,
  net_numsockets,
  net_time,
  PollProcedure,
  qsocket_t,
  set_DEFAULTnet_hostport,
  set_hostCacheCount,
  set_net_activeSockets,
  set_net_driverlevel,
  set_net_freeSockets,
  set_net_hostport,
  set_net_numdrivers,
  set_net_numsockets,
  set_net_time,
  set_slistInProgress,
  set_slistLocal,
  set_slistSilent,
  slistInProgress,
  slistLocal,
  slistSilent,
} from "./net.js";
import { sv } from "./server.js";
import { svs } from "./server.js";
import {
  Loop_CanSendMessage,
  Loop_CanSendUnreliableMessage,
  Loop_CheckNewConnections,
  Loop_Close,
  Loop_Connect,
  Loop_GetMessage,
  Loop_Init,
  Loop_Listen,
  Loop_SearchForHosts,
  Loop_SendMessage,
  Loop_SendUnreliableMessage,
  Loop_Shutdown,
} from "./net_loop.js";
import {
  WT_CanSendMessage,
  WT_CanSendUnreliableMessage,
  WT_CheckNewConnections,
  WT_Close,
  WT_Connect,
  WT_CreateRoom,
  WT_Init,
  WT_Listen,
  WT_QGetMessage,
  WT_QSendMessage,
  WT_QueryRooms,
  WT_SearchForHosts,
  WT_SendUnreliableMessage,
  WT_Shutdown,
} from "./net_webtransport.js";
import {
  WS_CanSendMessage,
  WS_CanSendUnreliableMessage,
  WS_CheckNewConnections,
  WS_Close,
  WS_Connect,
  WS_CreateRoom,
  WS_DefaultServer,
  WS_Init,
  WS_IsWebSocketURL,
  WS_Listen,
  WS_LobbyURL,
  WS_PageIsLocal,
  WS_QGetMessage,
  WS_QSendMessage,
  WS_QueryRooms,
  WS_RoomURL,
  WS_SearchForHosts,
  WS_SendUnreliableMessage,
  WS_ServerBase,
  WS_Shutdown,
  WS_ToWebSocketURL,
} from "./net_websocket.js";
import {
  RTCLobby_CanHost,
  RTCLobby_HostRoom,
  RTCLobby_Init,
  RTCLOBBY_ROOM_CODE,
} from "./net_rtclobby.js";
import {
  RTC_CanSendMessage,
  RTC_CanSendUnreliableMessage,
  RTC_CheckNewConnections,
  RTC_Close,
  RTC_Connect,
  RTC_Init,
  RTC_IsRoomAddress,
  RTC_Listen,
  RTC_QGetMessage,
  RTC_QSendMessage,
  RTC_SearchForHosts,
  RTC_SendUnreliableMessage,
  RTC_SetDriverLevel,
  RTC_Shutdown,
} from "./net_webrtc.js";
import { Turnstile_GetToken } from "./turnstile.js";

import { MAX_SCOREBOARD } from "./quakedef.js";

// Module-level state

let listening = false;
export function set_listening(state) {
  listening = state;
}

// Driver levels of the browser's remote transports, -1 when not registered
// (see NET_Init). The game server replaces these slots with its own drivers.
let net_wtdriverlevel = -1;
let net_wsdriverlevel = -1;
let net_rtcdriverlevel = -1;

// Web-only (no C counterpart). Set while the client re-runs a connect behind
// the player's back (cl_reconnect.js): the drivers then skip the menu pages
// they show on failure, because the caller retries or reports for itself.
let net_quietconnect = false;
export function NET_SetQuietConnect(quiet) {
  net_quietconnect = quiet;
}
export function NET_QuietConnect() {
  return net_quietconnect;
}

// Web-only. The WebTransport driver sets this when it couldn't open its
// transport at all (UDP blocked, no QUIC route) and left the failure for
// NET_Connect to retry over WebSocket; NET_Connect clears it.
let net_wt_unreachable = false;
export function NET_SetTransportUnreachable(value) {
  net_wt_unreachable = value;
}

let slistStartTime = 0;
let slistLastShown = 0;

const net_messagetimeout = new cvar_t("net_messagetimeout", "300");
export const hostname = new cvar_t("hostname", "UNNAMED");

let pollProcedureList = null;

// macros from C: sfunc = net_drivers[sock.driver], dfunc = net_drivers[net_driverlevel]

export function SetNetTime() {
  set_net_time(Sys_FloatTime());
  return net_time;
}

/**
 * Called by drivers when a new communications endpoint is required
 * The sequence and buffer fields will be filled in properly
 *
 * pendingConnections: sockets the calling driver has already handed out for
 * incoming sessions that SV_CheckForNewClients has not accepted yet. A server
 * driver passes its queue length so that connections opened in the same frame
 * cannot claim more sockets than there are free client slots (net_activeconnections
 * only rises once a socket is accepted). Outgoing and loopback callers pass 0.
 */
export function NET_NewQSocket(pendingConnections = 0) {
  if (net_freeSockets === null) {
    return null;
  }

  if (net_activeconnections + pendingConnections >= svs.maxclients) {
    return null;
  }

  // get one from free list
  const sock = net_freeSockets;
  set_net_freeSockets(sock.next);

  // add it to active list
  sock.next = net_activeSockets;
  set_net_activeSockets(sock);

  sock.disconnected = false;
  sock.lost = false; // web-only: NET_GetMessage/NET_Send* saw the connection die
  sock.connecttime = net_time;
  sock.address = "UNSET ADDRESS";
  sock.driver = net_driverlevel;
  sock.socket = 0;
  sock.driverdata = null;
  sock.canSend = true;
  sock.sendNext = false;
  sock.lastMessageTime = net_time;
  sock.ackSequence = 0;
  sock.hasAck = false;
  sock.sendSequence = 0;
  sock.unreliableSendSequence = 0;
  sock.sendMessageLength = 0;
  sock.receiveSequence = 0;
  sock.unreliableReceiveSequence = 0;
  sock.receiveMessageLength = 0;
  sock.maxdatagram = 0; // the driver sets it (SV_ClientDatagramSize)

  return sock;
}

export function NET_FreeQSocket(sock) {
  // remove it from active list
  if (sock === net_activeSockets) {
    set_net_activeSockets(net_activeSockets.next);
  } else {
    let s = net_activeSockets;
    while (s) {
      if (s.next === sock) {
        s.next = sock.next;
        break;
      }

      s = s.next;
    }

    if (!s) {
      Sys_Error("NET_FreeQSocket: not active\n");
    }
  }

  // add it to free list
  sock.next = net_freeSockets;
  set_net_freeSockets(sock);
  sock.disconnected = true;
}

function NET_Listen_f() {
  if (Cmd_Argc() !== 2) {
    Con_Printf('"listen" is "' + (listening ? 1 : 0) + '"\n');
    return;
  }

  listening = Q_atoi(Cmd_Argv(1)) ? true : false;

  for (let i = 0; i < net_numdrivers; i++) {
    set_net_driverlevel(i);
    if (net_drivers[net_driverlevel].initialized === false) {
      continue;
    }
    net_drivers[net_driverlevel].Listen(listening);
  }
}

function MaxPlayers_f() {
  if (Cmd_Argc() !== 2) {
    Con_Printf('"maxplayers" is "' + svs.maxclients + '"\n');
    return;
  }

  if (sv.active) {
    Con_Printf("maxplayers can not be changed while a server is running.\n");
    return;
  }

  let n = Q_atoi(Cmd_Argv(1));
  if (n < 1) {
    n = 1;
  }
  if (n > svs.maxclientslimit) {
    n = svs.maxclientslimit;
    Con_Printf('"maxplayers" set to "' + n + '"\n');
  }

  if ((n === 1) && listening) {
    Cbuf_AddText("listen 0\n");
  }

  if ((n > 1) && (!listening)) {
    Cbuf_AddText("listen 1\n");
  }

  svs.maxclients = n;
  if (n === 1) {
    Cvar_Set("deathmatch", "0");
  } else {
    Cvar_Set("deathmatch", "1");
  }
}

function NET_Port_f() {
  if (Cmd_Argc() !== 2) {
    Con_Printf('"port" is "' + net_hostport + '"\n');
    return;
  }

  const n = Q_atoi(Cmd_Argv(1));
  if (n < 1 || n > 65534) {
    Con_Printf("Bad value, must be between 1 and 65534\n");
    return;
  }

  set_DEFAULTnet_hostport(n);
  set_net_hostport(n);

  if (listening) {
    // force a change to the new port
    Cbuf_AddText("listen 0\n");
    Cbuf_AddText("listen 1\n");
  }
}

function PrintSlistHeader() {
  Con_Printf("Server          Map             Users\n");
  Con_Printf("--------------- --------------- -----\n");
  slistLastShown = 0;
}

function PrintSlist() {
  for (let n = slistLastShown; n < hostCacheCount; n++) {
    if (hostcache[n].maxusers) {
      Con_Printf(
        hostcache[n].name + " " + hostcache[n].map + " " + hostcache[n].users +
          "/" + hostcache[n].maxusers + "\n",
      );
    } else {
      Con_Printf(hostcache[n].name + " " + hostcache[n].map + "\n");
    }
  }

  slistLastShown = hostCacheCount;
}

function PrintSlistTrailer() {
  if (hostCacheCount) {
    Con_Printf("== end list ==\n\n");
  } else {
    Con_Printf("No Quake servers found.\n\n");
  }
}

export function NET_Slist_f() {
  if (slistInProgress) {
    return;
  }

  if (!slistSilent) {
    Con_Printf("Looking for Quake servers...\n");
    PrintSlistHeader();
  }

  set_slistInProgress(true);
  slistStartTime = Sys_FloatTime();

  SchedulePollProcedure(slistSendProcedure, 0.0);
  SchedulePollProcedure(slistPollProcedure, 0.1);

  set_hostCacheCount(0);
}

function Slist_Send() {
  for (let i = 0; i < net_numdrivers; i++) {
    set_net_driverlevel(i);
    if (!slistLocal && net_driverlevel === 0) {
      continue;
    }
    if (net_drivers[net_driverlevel].initialized === false) {
      continue;
    }
    net_drivers[net_driverlevel].SearchForHosts(true);
  }

  if ((Sys_FloatTime() - slistStartTime) < 0.5) {
    SchedulePollProcedure(slistSendProcedure, 0.75);
  }
}

function Slist_Poll() {
  for (let i = 0; i < net_numdrivers; i++) {
    set_net_driverlevel(i);
    if (!slistLocal && net_driverlevel === 0) {
      continue;
    }
    if (net_drivers[net_driverlevel].initialized === false) {
      continue;
    }
    net_drivers[net_driverlevel].SearchForHosts(false);
  }

  if (!slistSilent) {
    PrintSlist();
  }

  if ((Sys_FloatTime() - slistStartTime) < 1.5) {
    SchedulePollProcedure(slistPollProcedure, 0.1);
    return;
  }

  if (!slistSilent) {
    PrintSlistTrailer();
  }
  set_slistInProgress(false);
  set_slistSilent(false);
  set_slistLocal(true);
}

const slistSendProcedure = new PollProcedure(null, 0.0, Slist_Send);
const slistPollProcedure = new PollProcedure(null, 0.0, Slist_Poll);

/**
 * Web-only (no C counterpart). A send that fails is a lost connection only when
 * the driver has given up on it; a message too large fails without that.
 */
function NET_ConnectionDead(sock) {
  const conn = sock.driverdata;
  return conn == null || conn.connected === false ||
    (conn.error !== undefined && conn.error !== null);
}

/**
 * Web-only (no C counterpart). True when a failed WebTransport connect may be
 * retried over WebSocket: the WebSocket driver is ready and the page didn't
 * force WebTransport with ?transport=wt.
 */
export function NET_WebSocketFallbackAvailable() {
  return _NET_DriverReady(net_wsdriverlevel) &&
    _NET_PageParam("transport") !== "wt";
}

/**
 * Web-only (no C counterpart). WebTransport rides on QUIC (UDP), which some
 * networks block. When the WebTransport driver reports it couldn't open its
 * transport (not that the server refused the player), try the same address once
 * over wss:// before giving up. NET_UseWebSocket only chooses a transport up
 * front, so this is the only place a failed WebTransport falls back.
 */
function NET_WebSocketFallback(promise, host) {
  return promise.then((sock) => {
    if (sock || net_wt_unreachable === false) {
      return sock;
    }

    net_wt_unreachable = false;
    Con_Printf("WebTransport is unreachable, trying WebSocket...\n");
    set_net_driverlevel(net_wsdriverlevel);
    return net_drivers[net_wsdriverlevel].Connect(WS_ToWebSocketURL(host));
  });
}

/**
 * Connects to a host. For local connections, this is synchronous.
 * For remote connections (WebTransport or WebSocket), this returns a Promise.
 */
export function NET_Connect(host) {
  SetNetTime();

  if (host && host.length === 0) {
    host = null;
  }

  if (host) {
    if (host.toLowerCase() === "local") {
      // only use loopback driver
      set_net_driverlevel(0);
      if (net_drivers[0].initialized === false) {
        return null;
      }
      const ret = net_drivers[0].Connect(host);
      return ret;
    }

    if (hostCacheCount) {
      for (let n = 0; n < hostCacheCount; n++) {
        if (host.toLowerCase() === hostcache[n].name.toLowerCase()) {
          host = hostcache[n].cname;
          break;
        }
      }
    }
  }

  // rtc:<ROOMCODE> joins a browser-hosted room over WebRTC
  if (RTC_IsRoomAddress(host) === true) {
    if (_NET_DriverReady(net_rtcdriverlevel) === false) {
      Con_Printf("NET_Connect: WebRTC not available for remote connection\n");
      return null;
    }

    set_net_driverlevel(net_rtcdriverlevel);
    return net_drivers[net_rtcdriverlevel].Connect(host);
  }

  // Check if this looks like a remote address (not 'local')
  // For remote connections, ONLY use a remote driver - never fallback to loopback
  if (host && host !== "local") {
    // ws:// and wss:// addresses use the WebSocket driver; any other
    // address uses the page's transport (NET_UseWebSocket)
    const useWebSocket = WS_IsWebSocketURL(host) || NET_UseWebSocket();
    const level = useWebSocket ? net_wsdriverlevel : net_wtdriverlevel;
    if (
      level < 0 || level >= net_numdrivers || !net_drivers[level].initialized
    ) {
      Con_Printf(
        "NET_Connect: %s not available for remote connection\n",
        useWebSocket ? "WebSocket" : "WebTransport",
      );
      return null;
    }

    set_net_driverlevel(level);

    // Remote Connect is async, return the promise
    // If it fails, the error will propagate - do NOT fallback to loopback
    net_wt_unreachable = false;
    const ret = net_drivers[level].Connect(
      useWebSocket ? WS_ToWebSocketURL(host) : host,
    );
    if (ret && useWebSocket === false && ret instanceof Promise) {
      return NET_WebSocketFallback(ret, host);
    }
    if (ret) return ret;

    // The driver failed to start connection
    Con_Printf("NET_Connect: failed to connect to %s\n", host);
    return null;
  }

  // Local connection - use loopback driver
  for (let i = 0; i < net_numdrivers; i++) {
    set_net_driverlevel(i);
    if (net_drivers[net_driverlevel].initialized === false) {
      continue;
    }
    const ret = net_drivers[net_driverlevel].Connect(host);
    if (ret) {
      return ret;
    }
  }

  return null;
}

// Remote transport choice (no C counterpart)
//
// The browser client reaches lobbies and rooms over WebTransport or, where
// WebTransport is missing or an HTTP-only proxy sits in front (Cloudflare
// Tunnel), over WebSocket. Page parameters:
//   ?transport=ws        use WebSocket
//   ?transport=wt        use WebTransport (if the browser has it)
//   ?server=<url>        the lobby; a ws:// or wss:// URL implies WebSocket,
//                        any other scheme WebTransport
// Without either, a page on localhost uses WebTransport and the local lobby
// (SYS_DEFAULT_LOBBY), and a page on any other host uses WebSocket and the
// lobby at /mp on its own host (WS_DefaultServer): WebTransport's default
// lobby, https://localhost:4433, can't work for a public page, and WebTransport
// doesn't reach a lobby behind Cloudflare (docs/always-on-hosting.md).

function _NET_PageParam(name) {
  const loc = globalThis.location;
  if (loc == null || typeof loc.search !== "string") return null;
  return new URLSearchParams(loc.search).get(name);
}

function _NET_DriverReady(level) {
  return level >= 0 && level < net_numdrivers &&
    net_drivers[level].initialized === true;
}

/**
 * The transport decision behind NET_UseWebSocket, from its inputs: whether
 * each driver is ready, the page's ?transport= and ?server= (null when
 * absent), and whether the page is local (WS_PageIsLocal). An empty ?server=
 * counts as absent, as in NET_LobbyServer.
 */
export function NET_ChooseWebSocket(
  wtReady,
  wsReady,
  transport,
  server,
  pageIsLocal,
) {
  if (wtReady === false) return true;
  if (wsReady === false) return false;

  if (transport === "ws") return true;
  if (transport === "wt") return false;

  if (server !== null && server.length > 0) return WS_IsWebSocketURL(server);

  return pageIsLocal === false;
}

/** True when remote connections should use the WebSocket driver. */
export function NET_UseWebSocket() {
  return NET_ChooseWebSocket(
    _NET_DriverReady(net_wtdriverlevel),
    _NET_DriverReady(net_wsdriverlevel),
    _NET_PageParam("transport"),
    _NET_PageParam("server"),
    WS_PageIsLocal(),
  );
}

/**
 * True when the browser has a remote transport at all: WebTransport or
 * WebSocket for lobby rooms, or WebRTC for rooms hosted in browsers.
 */
export function NET_MultiplayerAvailable() {
  return _NET_DriverReady(net_wtdriverlevel) ||
    _NET_DriverReady(net_wsdriverlevel) ||
    _NET_DriverReady(net_rtcdriverlevel);
}

/**
 * The lobby URL: ?server=, or the transport's default, checked by
 * Sys_ParseLobbyURL. Null when ?server= is not a valid lobby address (callers
 * refuse to connect rather than fall back to a default).
 */
export function NET_LobbyServer() {
  const server = _NET_PageParam("server");
  if (server !== null && server.length > 0) return Sys_ParseLobbyURL(server);
  return NET_UseWebSocket() ?
    Sys_ParseLobbyURL(WS_DefaultServer()) :
    SYS_DEFAULT_LOBBY;
}

// A WebSocket connect address built on a checked lobby, or null.
function _NET_WebSocketConnectURL(serverUrl, build) {
  const lobby = Sys_ParseLobbyURL(serverUrl);
  if (lobby === null) return null;
  const url = build(lobby);
  return Sys_CommandArgIsSafe(url) ? url : null;
}

function _NET_ServerUsesWebSocket(serverUrl) {
  return WS_IsWebSocketURL(serverUrl) || NET_UseWebSocket();
}

// NET_QueryRooms / NET_CreateRoom
//
// The lobby's room list, and a new room, over the chosen transport.
export function NET_QueryRooms(serverUrl) {
  return _NET_ServerUsesWebSocket(serverUrl) ?
    WS_QueryRooms(serverUrl) :
    WT_QueryRooms(serverUrl);
}

function _NET_CreateRoomOnce(serverUrl, config) {
  return _NET_ServerUsesWebSocket(serverUrl) ?
    WS_CreateRoom(serverUrl, config) :
    WT_CreateRoom(serverUrl, config);
}

// Where NET_CreateRoom gets a Turnstile token; tests replace it
let net_turnstile_token = Turnstile_GetToken;

export function NET_SetTurnstileTokenSource(getToken) {
  net_turnstile_token = getToken !== null ? getToken : Turnstile_GetToken;
}

// A lobby that checks room creation answers a first request with
// LOBBY_VERIFY (server/turnstile.js): show the widget, then ask once more
// with its token.
export async function NET_CreateRoom(serverUrl, config) {
  try {
    return await _NET_CreateRoomOnce(serverUrl, config);
  } catch (error) {
    if (
      error === null || typeof error !== "object" ||
      error.turnstile === undefined
    ) throw error;
    const token = await net_turnstile_token(
      error.turnstile.sitekey,
      error.turnstile.action,
    );

    try {
      return await _NET_CreateRoomOnce(serverUrl, {
        ...config,
        turnstile: token,
      });
    } catch (retryError) {
      // The lobby refused the token it asked for
      if (
        retryError !== null && typeof retryError === "object" &&
        retryError.turnstile !== undefined
      ) {
        throw new Error("Verification failed. Try again.");
      }
      throw retryError;
    }
  }
}

/**
 * The error for a LOBBY_VERIFY reply to a room request: its `turnstile` is
 * { sitekey, action }, for NET_CreateRoom.
 */
export function NET_LobbyVerifyError(data) {
  let challenge = null;

  try {
    challenge = JSON.parse(new TextDecoder().decode(data));
  } catch {
    challenge = null;
  }

  if (
    challenge === null || typeof challenge !== "object" ||
    typeof challenge.sitekey !== "string" || challenge.sitekey === "" ||
    typeof challenge.action !== "string" || challenge.action === ""
  ) {
    return new Error("Invalid verification request from server");
  }

  const error = new Error("Verification required");
  error.turnstile = { sitekey: challenge.sitekey, action: challenge.action };
  return error;
}

/**
 * The connect address that joins room roomId through the lobby (which
 * re-creates a room that has expired). The result is quoted into a `connect`
 * command, so the lobby is checked and the room id encoded: null when either
 * could end the quoted argument (see Sys_ConnectURL).
 */
export function NET_LobbyJoinURL(serverUrl, roomId) {
  if (serverUrl === null) return null;

  // A room hosted in a browser: the WebRTC driver joins it through the
  // lobby (src/net_rtclobby.js)
  if (RTCLOBBY_ROOM_CODE.test(String(roomId))) return "rtc:" + roomId;

  if (_NET_ServerUsesWebSocket(serverUrl)) {
    return _NET_WebSocketConnectURL(serverUrl, (lobby) => {
      const params = new URLSearchParams();
      params.set("room", String(roomId));
      return WS_ServerBase(lobby) + "?" + params.toString();
    });
  }

  return Sys_ConnectURL(serverUrl, roomId, null);
}

/**
 * Web addition: the lobby address for rooms hosted in browsers. Their
 * signalling needs a lobby socket that stays open, which only the WebSocket
 * lobby has, so this is null when the page reaches its lobby over
 * WebTransport.
 */
export function NET_RtcLobbyURL() {
  const server = NET_LobbyServer();
  if (server === null || _NET_ServerUsesWebSocket(server) === false) {
    return null;
  }
  return WS_LobbyURL(server);
}

// NET_CanHostInBrowser / NET_HostRoom
//
// Web addition: host a room in this browser (src/net_rtclobby.js). The caller
// starts the listen server; NET_HostRoom registers it with the lobby once its
// map is up.
export function NET_CanHostInBrowser() {
  return _NET_DriverReady(net_rtcdriverlevel) && RTCLobby_CanHost();
}

/**
 * Whether Start Game's Host on starts at "This browser", from its inputs:
 * whether this browser can host, and the page's ?server= (null when absent)
 * and whether the page is local (WS_PageIsLocal). Off localhost with no
 * ?server=, the lobby is the Cloudflare one (cloudflare/lobby/), which can't
 * start rooms on a server, so "Lobby server" would fail there. An empty
 * ?server= counts as absent, as in NET_LobbyServer.
 */
export function NET_ChooseHostInBrowser(canHost, server, pageIsLocal) {
  if (canHost === false) return false;
  if (server !== null && server.length > 0) return false;
  return pageIsLocal === false;
}

/** Start Game's first Host on choice: true for "This browser". */
export function NET_DefaultHostInBrowser() {
  return NET_ChooseHostInBrowser(
    NET_CanHostInBrowser(),
    _NET_PageParam("server"),
    WS_PageIsLocal(),
  );
}

export function NET_HostRoom(config, spawnCount, exitRules) {
  return RTCLobby_HostRoom(config, spawnCount, exitRules);
}

/**
 * The connect address of a room the lobby has just returned: its own port for
 * WebTransport, the lobby's /room/<id> proxy path for WebSocket. Null when
 * the lobby, room id or port is not safe to quote into a `connect` command.
 */
export function NET_RoomURL(serverUrl, room) {
  if (serverUrl === null) return null;

  if (_NET_ServerUsesWebSocket(serverUrl)) {
    return _NET_WebSocketConnectURL(
      serverUrl,
      (lobby) => WS_RoomURL(lobby, String(room.id)),
    );
  }

  if (room.port == null) {
    return NET_LobbyJoinURL(serverUrl, room.id);
  }

  return Sys_ConnectURL(serverUrl, null, Number(room.port));
}

export function NET_CheckNewConnections() {
  SetNetTime();

  // SV_CheckForNewClients calls Sys_Error when it gets a connection with no
  // free client slot. Leave connections queued in their driver until a slot
  // frees up (the driver times out ones that wait too long).
  if (NET_HasFreeClientSlot() === false) {
    return null;
  }

  for (let i = 0; i < net_numdrivers; i++) {
    set_net_driverlevel(i);
    if (net_drivers[net_driverlevel].initialized === false) {
      continue;
    }
    if (net_driverlevel !== 0 && listening === false) {
      continue;
    }
    const ret = net_drivers[net_driverlevel].CheckNewConnections();
    if (ret != null) {
      return ret;
    }
  }

  return null;
}

function NET_HasFreeClientSlot() {
  if (svs.clients == null) {
    return true;
  }

  const max = Math.min(svs.maxclients, svs.clients.length);
  for (let i = 0; i < max; i++) {
    if (svs.clients[i] != null && !svs.clients[i].active) {
      return true;
    }
  }

  return false;
}

export function NET_Close(sock) {
  if (!sock) {
    return;
  }

  if (sock.disconnected) {
    return;
  }

  SetNetTime();

  // call the driver_Close function
  net_drivers[sock.driver].Close(sock);

  NET_FreeQSocket(sock);
}

/**
 * If there is a complete message, return it in net_message
 *
 * returns 0 if no data is waiting
 * returns 1 if a message was received
 * returns 2 if an unreliable message was received
 * returns -1 if connection is invalid
 */
export function NET_GetMessage(sock) {
  if (!sock) {
    return -1;
  }

  if (sock.disconnected) {
    Con_Printf("NET_GetMessage: disconnected socket\n");
    return -1;
  }

  SetNetTime();

  const ret = net_drivers[sock.driver].QGetMessage(sock);

  // Web-only: remember that the connection died, so CL_Disconnect can tell
  // a lost connection (reconnect) from a deliberate disconnect.
  if (ret === -1) {
    sock.lost = true;
  }

  // see if this connection has timed out
  if (ret === 0 && sock.driver) {
    if (net_time - sock.lastMessageTime > net_messagetimeout.value) {
      sock.lost = true;
      NET_Close(sock);
      return -1;
    }
  }

  if (ret > 0) {
    if (sock.driver) {
      sock.lastMessageTime = net_time;
      if (ret === 1) {
        // messagesReceived ++ handled in net.js
        // For now just track locally
      }
    }
  }

  return ret;
}

/**
 * Try to send a complete length+message unit over the reliable stream.
 * returns 0 if the message cannot be delivered reliably, but the connection
 * 		is still considered valid
 * returns 1 if the message was sent properly
 * returns -1 if the connection died
 */
export function NET_SendMessage(sock, data) {
  if (!sock) {
    return -1;
  }

  if (sock.disconnected) {
    Con_Printf("NET_SendMessage: disconnected socket\n");
    return -1;
  }

  SetNetTime();
  const r = net_drivers[sock.driver].QSendMessage(sock, data);
  if (r === -1 && NET_ConnectionDead(sock) === true) {
    sock.lost = true; // web-only, see NET_GetMessage
  }

  return r;
}

export function NET_SendUnreliableMessage(sock, data) {
  if (!sock) {
    return -1;
  }

  if (sock.disconnected) {
    Con_Printf("NET_SendMessage: disconnected socket\n");
    return -1;
  }

  SetNetTime();
  const r = net_drivers[sock.driver].SendUnreliableMessage(sock, data);
  if (r === -1 && NET_ConnectionDead(sock) === true) {
    sock.lost = true; // web-only, see NET_GetMessage
  }

  return r;
}

/**
 * Returns true or false if the given qsocket can currently accept a
 * message to be transmitted.
 */
export function NET_CanSendMessage(sock) {
  if (!sock) {
    return false;
  }

  if (sock.disconnected) {
    return false;
  }

  SetNetTime();

  const r = net_drivers[sock.driver].CanSendMessage(sock);

  return r;
}

/**
 * Returns true or false if the given qsocket can currently accept an
 * unreliable message to be transmitted.
 */
export function NET_CanSendUnreliableMessage(sock) {
  if (!sock) {
    return false;
  }

  if (sock.disconnected) {
    return false;
  }

  SetNetTime();

  const r = net_drivers[sock.driver].CanSendUnreliableMessage(sock);

  return r;
}

/** This is a reliable *blocking* send to all attached clients. */
export function NET_SendToAll(data, blocktime) {
  const start = Sys_FloatTime();
  let count = 0;
  // The C leaves these uninitialized, so a slot with no netconnection,
  // which the first loop skips, holds whatever was on the stack. Starting
  // at false made the second loop wait on empty slots until blocktime ran
  // out (5 s in Host_ShutdownServer) whenever a remote client was
  // connected. True means "nothing to send", which is what an empty slot
  // needs.
  const state1 = new Array(MAX_SCOREBOARD).fill(true);
  const state2 = new Array(MAX_SCOREBOARD).fill(true);

  for (let i = 0; i < svs.maxclients; i++) {
    const client = svs.clients[i];
    if (!client.netconnection) {
      continue;
    }
    if (client.active) {
      if (client.netconnection.driver === 0) {
        NET_SendMessage(client.netconnection, data);
        state1[i] = true;
        state2[i] = true;
        continue;
      }

      count++;
      state1[i] = false;
      state2[i] = false;
    } else {
      state1[i] = true;
      state2[i] = true;
    }
  }

  // For browser/loopback, the while loop is essentially instant
  while (count) {
    count = 0;
    for (let i = 0; i < svs.maxclients; i++) {
      const client = svs.clients[i];

      if (!state1[i]) {
        if (NET_CanSendMessage(client.netconnection)) {
          state1[i] = true;
          NET_SendMessage(client.netconnection, data);
        } else {
          NET_GetMessage(client.netconnection);
        }

        count++;
        continue;
      }

      if (!state2[i]) {
        if (NET_CanSendMessage(client.netconnection)) {
          state2[i] = true;
        } else {
          NET_GetMessage(client.netconnection);
        }

        count++;
        continue;
      }
    }

    if ((Sys_FloatTime() - start) > blocktime) {
      break;
    }
  }

  return count;
}

export function NET_Init() {
  let i = COM_CheckParm("-port");
  if (i === 0) {
    i = COM_CheckParm("-udpport");
  }
  if (i === 0) {
    i = COM_CheckParm("-ipxport");
  }

  if (i !== 0) {
    if (i < com_argc - 1) {
      set_DEFAULTnet_hostport(Q_atoi(com_argv[i + 1]));
    } else {
      Sys_Error("NET_Init: you must specify a number after -port");
    }
  }

  set_net_hostport(DEFAULTnet_hostport);

  if (COM_CheckParm("-listen")) {
    listening = true;
  }

  set_net_numsockets(svs.maxclientslimit);
  // non-dedicated, add one more for client
  set_net_numsockets(net_numsockets + 1);

  SetNetTime();

  // allocate qsockets into the free list
  for (let j = 0; j < net_numsockets; j++) {
    const s = new qsocket_t();
    s.next = net_freeSockets;
    set_net_freeSockets(s);
    s.disconnected = true;
  }

  // allocate space for network message buffer
  SZ_Alloc(net_message, NET_MAXMESSAGE);

  // Share the canonical net_message with common.js (MSG_Read* functions)
  COM_SetNetMessage(net_message);

  Cvar_RegisterVariable(net_messagetimeout);
  Cvar_RegisterVariable(hostname);

  Cmd_AddCommand("slist", NET_Slist_f);
  Cmd_AddCommand("listen", NET_Listen_f);
  Cmd_AddCommand("maxplayers", MaxPlayers_f);
  Cmd_AddCommand("port", NET_Port_f);

  // Set up the loopback driver (driver 0) for single-player
  set_net_numdrivers(1);
  net_drivers[0].name = "Loopback";
  net_drivers[0].Init = Loop_Init;
  net_drivers[0].Listen = Loop_Listen;
  net_drivers[0].SearchForHosts = Loop_SearchForHosts;
  net_drivers[0].Connect = Loop_Connect;
  net_drivers[0].CheckNewConnections = Loop_CheckNewConnections;
  net_drivers[0].QGetMessage = Loop_GetMessage;
  net_drivers[0].QSendMessage = Loop_SendMessage;
  net_drivers[0].SendUnreliableMessage = Loop_SendUnreliableMessage;
  net_drivers[0].CanSendMessage = Loop_CanSendMessage;
  net_drivers[0].CanSendUnreliableMessage = Loop_CanSendUnreliableMessage;
  net_drivers[0].Close = Loop_Close;
  net_drivers[0].Shutdown = Loop_Shutdown;

  // Set up the WebTransport driver (driver 1) for multiplayer
  if (typeof WebTransport !== "undefined") {
    set_net_numdrivers(2);
    net_drivers[1].name = "WebTransport";
    net_drivers[1].Init = WT_Init;
    net_drivers[1].Listen = WT_Listen;
    net_drivers[1].SearchForHosts = WT_SearchForHosts;
    net_drivers[1].Connect = WT_Connect;
    net_drivers[1].CheckNewConnections = WT_CheckNewConnections;
    net_drivers[1].QGetMessage = WT_QGetMessage;
    net_drivers[1].QSendMessage = WT_QSendMessage;
    net_drivers[1].SendUnreliableMessage = WT_SendUnreliableMessage;
    net_drivers[1].CanSendMessage = WT_CanSendMessage;
    net_drivers[1].CanSendUnreliableMessage = WT_CanSendUnreliableMessage;
    net_drivers[1].Close = WT_Close;
    net_drivers[1].Shutdown = WT_Shutdown;
    net_wtdriverlevel = 1;
  }

  // Set up the WebSocket driver for browsers without WebTransport and for
  // HTTP-only proxies (see src/net_websocket.js)
  if (typeof WebSocket !== "undefined") {
    const d = net_numdrivers;
    set_net_numdrivers(d + 1);
    net_drivers[d].name = "WebSocket";
    net_drivers[d].Init = WS_Init;
    net_drivers[d].Listen = WS_Listen;
    net_drivers[d].SearchForHosts = WS_SearchForHosts;
    net_drivers[d].Connect = WS_Connect;
    net_drivers[d].CheckNewConnections = WS_CheckNewConnections;
    net_drivers[d].QGetMessage = WS_QGetMessage;
    net_drivers[d].QSendMessage = WS_QSendMessage;
    net_drivers[d].SendUnreliableMessage = WS_SendUnreliableMessage;
    net_drivers[d].CanSendMessage = WS_CanSendMessage;
    net_drivers[d].CanSendUnreliableMessage = WS_CanSendUnreliableMessage;
    net_drivers[d].Close = WS_Close;
    net_drivers[d].Shutdown = WS_Shutdown;
    net_wsdriverlevel = d;
  }

  // Set up the WebRTC driver for browser-hosted rooms: joining one, and
  // hosting one (see src/net_webrtc.js)
  if (typeof RTCPeerConnection !== "undefined") {
    const d = net_numdrivers;
    set_net_numdrivers(d + 1);
    net_drivers[d].name = "WebRTC";
    net_drivers[d].Init = RTC_Init;
    net_drivers[d].Listen = RTC_Listen;
    net_drivers[d].SearchForHosts = RTC_SearchForHosts;
    net_drivers[d].Connect = RTC_Connect;
    net_drivers[d].CheckNewConnections = RTC_CheckNewConnections;
    net_drivers[d].QGetMessage = RTC_QGetMessage;
    net_drivers[d].QSendMessage = RTC_QSendMessage;
    net_drivers[d].SendUnreliableMessage = RTC_SendUnreliableMessage;
    net_drivers[d].CanSendMessage = RTC_CanSendMessage;
    net_drivers[d].CanSendUnreliableMessage = RTC_CanSendUnreliableMessage;
    net_drivers[d].Close = RTC_Close;
    net_drivers[d].Shutdown = RTC_Shutdown;
    net_rtcdriverlevel = d;
    RTC_SetDriverLevel(d);
    RTCLobby_Init(NET_RtcLobbyURL, () => listening);
  }

  // initialize all the drivers
  for (let d = 0; d < net_numdrivers; d++) {
    set_net_driverlevel(d);
    const controlSocket = net_drivers[net_driverlevel].Init();
    if (controlSocket === -1) {
      continue;
    }
    net_drivers[net_driverlevel].initialized = true;
    net_drivers[net_driverlevel].controlSock = controlSocket;
    if (listening) {
      net_drivers[net_driverlevel].Listen(true);
    }
  }

  Con_Printf("NET_Init complete\n");
}

export function NET_Shutdown() {
  SetNetTime();

  let sock = net_activeSockets;
  while (sock) {
    const next = sock.next;
    NET_Close(sock);
    sock = next;
  }

  // shutdown the drivers
  for (let i = 0; i < net_numdrivers; i++) {
    set_net_driverlevel(i);
    if (net_drivers[net_driverlevel].initialized === true) {
      net_drivers[net_driverlevel].Shutdown();
      net_drivers[net_driverlevel].initialized = false;
    }
  }
}

export function NET_Poll() {
  SetNetTime();

  let pp = pollProcedureList;
  while (pp) {
    if (pp.nextTime > net_time) {
      break;
    }
    pollProcedureList = pp.next;
    pp.procedure(pp.arg);
    pp = pollProcedureList;
  }
}

export function SchedulePollProcedure(proc, timeOffset) {
  proc.nextTime = Sys_FloatTime() + timeOffset;

  let pp = pollProcedureList;
  let prev = null;
  while (pp) {
    if (pp.nextTime >= proc.nextTime) {
      break;
    }
    prev = pp;
    pp = pp.next;
  }

  if (prev === null) {
    proc.next = pollProcedureList;
    pollProcedureList = proc;
    return;
  }

  proc.next = pp;
  prev.next = proc;
}
