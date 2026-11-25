// WebSocket server driver for Deno (no C counterpart)
// Accepts game clients over WebSocket (Deno.serve + Deno.upgradeWebSocket)
// beside the WebTransport driver, for browsers without WebTransport and for
// HTTP-only proxies such as a Cloudflare Tunnel. The wire format is in
// src/net.js (WS_CHANNEL_*): the WebTransport handshake, then one packet per
// WebSocket message, [channel][magic][sequence][ack][quake payload].
//
// Trade-off: everything shares one ordered TCP stream, so a lost segment
// delays every later message (head-of-line blocking), and "unreliable"
// updates are never lost, only late. To keep stale updates from piling up,
// unreliable sends are dropped while the socket is backed up or while the
// client is far behind in acknowledging what it has been sent.

import { Sys_Printf } from "./sys_server.ts";
import { WS_ClientAddress } from "./client_address.ts";
import {
  net_message,
  WS_CHANNEL_BYTES,
  WS_CHANNEL_RELIABLE,
  WS_CHANNEL_UNRELIABLE,
  WS_MAX_MESSAGE_BYTES,
  WT_BuildHandshakeReplyFrame,
  WT_HANDSHAKE_ACCEPT,
  WT_HANDSHAKE_REJECT,
  WT_PACKET_HEADER_BYTES,
  WT_PACKET_MAGIC,
  WT_ParseHello,
  WT_PROTOCOL_VERSION,
} from "../src/net.js";

// Server configuration (WS_SetConfig)
let serverPort = 0;
let serverHostname = "127.0.0.1";
let useTls = false;
let certFile = "cert.pem";
let keyFile = "key.pem";
// Trust ?ip= from loopback peers: set for lobby-spawned rooms, whose
// WebSocket clients all arrive through the lobby's proxy (lobby_server.js).
let trustQueryIp = false;

// Minimal structural type so tests can drive the driver with in-memory fakes.
export interface WebSocketLike {
  readyState: number;
  bufferedAmount: number;
  binaryType: string;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
}

const WS_OPEN = 1;

interface PendingMessage {
  reliable: boolean;
  data: Uint8Array;
}

interface ClientConnection {
  id: number;
  socket: WebSocketLike;
  address: string;
  ip: string;
  sock: QSocket | null;
  pendingMessages: PendingMessage[];
  // The hello has been answered with an accept.
  accepted: boolean;
  // Game-facing state: false once the connection is dead or being closed.
  connected: boolean;
  closing: boolean;
  // The socket itself is gone; nothing more can be written.
  dead: boolean;
  closeFinished: boolean;
  closeRequested: boolean;
  closeDeadline: number;
  closeTimer: ReturnType<typeof setTimeout> | null;
  handshakeTimer: ReturnType<typeof setTimeout> | null;
  pendingAcceptTimer: ReturnType<typeof setTimeout> | null;
  // Last sequence written to the socket, for the ack-lag gate
  lastWrittenSequence: number;
  peerSequenced: boolean;
  reliableSequenceValid: boolean;
  unreliableSequenceValid: boolean;
  highestReceivedSequence: number;
  hasReceivedSequence: boolean;
  oversizedInboundLogged: boolean;
  releaseSession: (() => void) | null;
}

// Socket structure compatible with Quake's qsocket_t (see
// net_webtransport_server.ts); only the fields this driver uses.
export interface QSocket {
  disconnected: boolean;
  driver: number;
  driverdata: ClientConnection | null;
  connecttime: number;
  lastMessageTime: number;
  ackSequence: number;
  sendSequence: number;
  receiveSequence: number;
  unreliableReceiveSequence: number;
  address: string;
  maxdatagram: number;
}

// Sockets handed out for connections that SV_CheckForNewClients has not accepted
const pendingConnections: QSocket[] = [];

// Every connection from upgrade until its close finishes
const liveConnections = new Set<ClientConnection>();

let nextConnectionId = 1;
let net_driverlevel = 0;

const NET_MAXMESSAGE = 8192;

// Session limits, as in net_webtransport_server.ts
let maxHandshakingSessions = 16;
let maxSessionsPerIp = 8;
let handshakingSessions = 0;
const sessionsByIp = new Map<string, number>();

// Timeouts (WS_SetConfig can shorten them; tests do)
let WS_HANDSHAKE_TIMEOUT_MS = 10000;
let WS_PENDING_ACCEPT_TIMEOUT_MS = 30000;
let WS_CLOSE_FLUSH_MS = 1000;
const WS_CLOSE_POLL_MS = 20;

// Inbound queue. A WebSocket can't be paused, so past this many queued
// messages (consecutive unreliable ones are coalesced) the client is dropped.
const MAX_PENDING_MESSAGES = 1024;

// Outbound backpressure in bytes queued on the socket. Deno's bufferedAmount
// stays 0 until the kernel's send buffer is full, so these only act on a
// badly stalled peer; the ack-lag gate below catches a slow one sooner.
const WS_MAX_UNRELIABLE_BUFFERED = 64 * 1024;
const WS_MAX_RELIABLE_BUFFERED = 1024 * 1024;
const WS_HARD_BUFFERED = 4 * 1024 * 1024;
// Unreliable sends stop while the client has acknowledged nothing from the
// last this-many packets (about a second at the default 20 Hz sys_ticrate),
// and resume once it catches up. Unacknowledged reliable packets count too.
const WS_MAX_UNACKED_PACKETS = 20;

// Outgoing message scratch: [channel:1][header:9][payload]. WebSocket.send
// copies the bytes before it returns, so one buffer serves every send.
const ws_sendbuf = new Uint8Array(
  WS_CHANNEL_BYTES + WT_PACKET_HEADER_BYTES + NET_MAXMESSAGE,
);
const ws_sendview = new DataView(ws_sendbuf.buffer);

export { WS_ClientAddress };

// Abort controller and server of the current Deno.serve listener
let listenAbort: AbortController | null = null;
let listenServer: Deno.HttpServer | null = null;

function _isNewerSequence(sequence: number, current: number): boolean {
  return (((sequence - current) | 0) > 0);
}

// Socket allocation callbacks (injected from game_server.js), as in
// net_webtransport_server.ts. The allocator receives the number of sockets
// still waiting in pendingConnections (NET-1).
let _NET_NewQSocket: ((pendingConnections?: number) => QSocket | null) | null =
  null;
let _NET_FreeQSocket: ((sock: QSocket) => void) | null = null;

export function WS_SetSocketAllocator(
  allocator: ((pendingConnections?: number) => QSocket | null) | null,
): void {
  _NET_NewQSocket = allocator;
}

export function WS_SetSocketFreer(
  freer: ((sock: QSocket) => void) | null,
): void {
  _NET_FreeQSocket = freer;
}

function _freeQSocket(sock: QSocket): void {
  if (_NET_FreeQSocket !== null) {
    _NET_FreeQSocket(sock);
  } else {
    sock.disconnected = true;
  }
}

/**
 * Sockets handed out but not yet accepted; the WebTransport driver's
 * allocator adds them to its own count.
 */
export function WS_GetPendingConnectionCount(): number {
  return pendingConnections.length;
}

export function WS_Init(): number {
  Sys_Printf("WebSocket server driver initialized\n");
  return 0;
}

export function WS_Shutdown(): void {
  Sys_Printf("WebSocket server driver shutting down\n");
  _stopListening();
  for (const conn of Array.from(liveConnections)) {
    conn.connected = false;
    conn.closing = true;
    _finishClose(conn);
  }
}

function _stopListening(): void {
  if (listenAbort !== null) {
    listenAbort.abort();
    listenAbort = null;
    listenServer = null;
  }
}

/**
 * Start or stop listening. Resolves to false if the listener could not be
 * started (port in use, unreadable certificate), true otherwise.
 */
export async function WS_Listen(state: boolean): Promise<boolean> {
  if (!state) {
    if (listenAbort !== null) {
      _stopListening();
      Sys_Printf("WebSocket server stopped listening\n");
    }
    return true;
  }

  if (listenAbort !== null) return true;

  try {
    const abort = new AbortController();
    const options: Deno.ServeTcpOptions & Partial<Deno.TlsCertifiedKeyPem> = {
      port: serverPort,
      hostname: serverHostname,
      signal: abort.signal,
      onListen: ({ hostname, port }) => {
        Sys_Printf(
          "WebSocket server listening on " + (useTls ? "wss" : "ws") + "://" +
            (hostname.includes(":") ? "[" + hostname + "]" : hostname) + ":" +
            port + "\n",
        );
      },
      onError: (error) => {
        Sys_Printf("WebSocket request error: %s\n", (error as Error).message);
        return new Response("Internal Server Error", { status: 500 });
      },
    };
    if (useTls) {
      options.cert = await Deno.readTextFile(certFile);
      options.key = await Deno.readTextFile(keyFile);
    }
    listenServer = Deno.serve(options, WS_HandleRequest);
    listenAbort = abort;
    return true;
  } catch (error) {
    Sys_Printf(
      "Failed to start WebSocket listener: " + (error as Error).message + "\n",
    );
    return false;
  }
}

/**
 * HTTP handler: upgrade a WebSocket request into a game connection. Other
 * requests get 426 (Upgrade Required).
 */
export function WS_HandleRequest(
  req: Request,
  info: Deno.ServeHandlerInfo<Deno.NetAddr>,
): Response {
  if ((req.headers.get("upgrade") ?? "").toLowerCase() !== "websocket") {
    return new Response("Icaro Engine game server: WebSocket only\n", {
      status: 426,
      headers: { upgrade: "websocket" },
    });
  }

  const remote = info.remoteAddr;
  const ip = WS_ClientAddress(
    new URL(req.url),
    req.headers,
    remote.hostname,
    trustQueryIp,
  );
  const address = ip + ":" + remote.port;

  const release = _reserveSession(ip, address);
  if (release === null) {
    return new Response("Too many connections\n", { status: 503 });
  }

  let upgraded;
  try {
    upgraded = Deno.upgradeWebSocket(req);
  } catch (error) {
    release();
    Sys_Printf(
      "WebSocket upgrade failed for %s: %s\n",
      address,
      (error as Error).message,
    );
    return new Response("Bad Request\n", { status: 400 });
  }

  Sys_Printf("Connection from " + address + "\n");
  _acceptSocket(upgraded.socket as unknown as WebSocketLike, address, ip, release);
  return upgraded.response;
}

/*
 * Session limits, as in net_webtransport_server.ts: a connection counts as
 * handshaking until it is accepted or closed, and against its IP until its
 * close finishes. Returns the release function, or null if over a limit.
 */
function _reserveSession(
  ip: string,
  address: string,
): ((endHandshakeOnly?: boolean) => void) | null {
  if (handshakingSessions >= maxHandshakingSessions) {
    Sys_Printf(
      "Rejecting %s: %d sessions already handshaking\n",
      address,
      handshakingSessions,
    );
    return null;
  }

  const perIp = sessionsByIp.get(ip) ?? 0;
  if (perIp >= maxSessionsPerIp) {
    Sys_Printf(
      "Rejecting %s: %d sessions already open from %s\n",
      address,
      perIp,
      ip,
    );
    return null;
  }

  handshakingSessions++;
  sessionsByIp.set(ip, perIp + 1);

  let handshaking = true;
  let released = false;
  const release = (endHandshakeOnly = false) => {
    if (handshaking) {
      handshaking = false;
      handshakingSessions--;
    }
    if (endHandshakeOnly || released) return;
    released = true;
    const n = (sessionsByIp.get(ip) ?? 1) - 1;
    if (n <= 0) {
      sessionsByIp.delete(ip);
    } else {
      sessionsByIp.set(ip, n);
    }
  };
  return release;
}

function _acceptSocket(
  socket: WebSocketLike,
  address: string,
  ip: string,
  release: (endHandshakeOnly?: boolean) => void,
): void {
  socket.binaryType = "arraybuffer";

  const conn: ClientConnection = {
    id: nextConnectionId++,
    socket,
    address,
    ip,
    sock: null,
    pendingMessages: [],
    accepted: false,
    connected: false,
    closing: false,
    dead: false,
    closeFinished: false,
    closeRequested: false,
    closeDeadline: 0,
    closeTimer: null,
    handshakeTimer: null,
    pendingAcceptTimer: null,
    lastWrittenSequence: -1,
    peerSequenced: false,
    reliableSequenceValid: false,
    unreliableSequenceValid: false,
    highestReceivedSequence: -1,
    hasReceivedSequence: false,
    oversizedInboundLogged: false,
    releaseSession: () => release(),
  };
  liveConnections.add(conn);

  conn.handshakeTimer = setTimeout(() => {
    conn.handshakeTimer = null;
    if (conn.accepted || conn.closing) return;
    Sys_Printf("Session error for %s: handshake timed out\n", address);
    _closeConnection(conn);
  }, WS_HANDSHAKE_TIMEOUT_MS);

  socket.onmessage = (event: MessageEvent) => {
    if (!conn.accepted) {
      _onHello(conn, event.data, release);
    } else {
      _onMessage(conn, event.data);
    }
  };
  socket.onclose = () => _onTransportClosed(conn);
  socket.onerror = () => _onTransportClosed(conn);
}

function _sendHandshakeReply(
  conn: ClientConnection,
  status: number,
  reason: string,
): void {
  try {
    conn.socket.send(WT_BuildHandshakeReplyFrame(status, reason).subarray(2));
  } catch { /* the close event reports a dead socket */ }
}

function _rejectConnection(conn: ClientConnection, reason: string): void {
  _sendHandshakeReply(conn, WT_HANDSHAKE_REJECT, reason);
  _closeConnection(conn);
}

/**
 * The first message: the client hello. Reply with an accept and queue the
 * socket for SV_CheckForNewClients, or with a reject and close.
 */
function _onHello(
  conn: ClientConnection,
  raw: unknown,
  release: (endHandshakeOnly?: boolean) => void,
): void {
  if (conn.closing) return;

  if (conn.handshakeTimer !== null) {
    clearTimeout(conn.handshakeTimer);
    conn.handshakeTimer = null;
  }

  const version = raw instanceof ArrayBuffer
    ? WT_ParseHello(new Uint8Array(raw))
    : -1;
  if (version !== WT_PROTOCOL_VERSION) {
    Sys_Printf(
      "Rejecting %s: %s\n",
      conn.address,
      version < 0 ? "no handshake" : "protocol version " + version,
    );
    _rejectConnection(
      conn,
      version < 0
        ? "Protocol mismatch: update your client"
        : "Protocol version " + version + " not supported (server uses " +
          WT_PROTOCOL_VERSION + ")",
    );
    return;
  }

  // The allocator counts sockets still waiting to be accepted, so it never
  // hands out more sockets than there are free client slots (NET-1).
  const sock = _NET_NewQSocket !== null
    ? _NET_NewQSocket(pendingConnections.length)
    : null;
  if (sock === null) {
    Sys_Printf("No free client slots for %s\n", conn.address);
    _rejectConnection(conn, "Server is full");
    return;
  }

  release(true);
  conn.accepted = true;
  conn.connected = true;

  sock.driver = net_driverlevel;
  sock.address = conn.address;
  sock.driverdata = conn;
  sock.connecttime = performance.now() / 1000;
  sock.lastMessageTime = performance.now() / 1000;
  sock.sendSequence = 0;
  sock.receiveSequence = -1;
  sock.unreliableReceiveSequence = -1;
  sock.ackSequence = -1;
  // No path MTU on a TCP stream: SV_ClientDatagramSize clamps this to
  // DATAGRAM_MTU, the size every remote client gets in FitzQuake.
  sock.maxdatagram = NET_MAXMESSAGE;
  conn.sock = sock;

  _sendHandshakeReply(conn, WT_HANDSHAKE_ACCEPT, "");

  pendingConnections.push(sock);
  conn.pendingAcceptTimer = setTimeout(() => {
    conn.pendingAcceptTimer = null;
    const idx = pendingConnections.indexOf(sock);
    if (idx === -1 || sock.driverdata !== conn) return;
    Sys_Printf("Connection %s was never accepted, closing\n", conn.address);
    pendingConnections.splice(idx, 1);
    sock.driverdata = null;
    conn.sock = null;
    _freeQSocket(sock);
    _closeConnection(conn);
  }, WS_PENDING_ACCEPT_TIMEOUT_MS);
}

function _protocolError(conn: ClientConnection, reason: string): void {
  Sys_Printf("WebSocket %s: %s, disconnecting\n", conn.address, reason);
  conn.connected = false;
  conn.pendingMessages.length = 0;
}

/**
 * Queue one received game message for WS_QGetMessage.
 */
function _onMessage(conn: ClientConnection, raw: unknown): void {
  if (!conn.connected) return;

  if (!(raw instanceof ArrayBuffer) || raw.byteLength < WS_CHANNEL_BYTES + 1) {
    _protocolError(conn, "malformed message");
    return;
  }

  const bytes = new Uint8Array(raw);
  const channel = bytes[0];
  if (channel !== WS_CHANNEL_RELIABLE && channel !== WS_CHANNEL_UNRELIABLE) {
    _protocolError(conn, "unknown channel " + channel);
    return;
  }

  if (bytes.length > WS_MAX_MESSAGE_BYTES) {
    if (channel === WS_CHANNEL_UNRELIABLE) {
      if (!conn.oversizedInboundLogged) {
        conn.oversizedInboundLogged = true;
        Sys_Printf(
          "Dropping oversized message (%d bytes) from %s\n",
          bytes.length,
          conn.address,
        );
      }
      return;
    }
    _protocolError(conn, "oversized reliable message (" + bytes.length + " bytes)");
    return;
  }

  const queue = conn.pendingMessages;
  const data = bytes.subarray(WS_CHANNEL_BYTES);

  // Only the newest of consecutive unreliable messages is ever delivered
  // (see WS_QGetMessage), so replace instead of growing the queue.
  if (
    channel === WS_CHANNEL_UNRELIABLE && queue.length > 0 &&
    !queue[queue.length - 1].reliable
  ) {
    queue[queue.length - 1].data = data;
    return;
  }

  if (queue.length >= MAX_PENDING_MESSAGES) {
    _protocolError(conn, "receive queue overflow");
    return;
  }

  queue.push({ reliable: channel === WS_CHANNEL_RELIABLE, data });
}

/**
 * The socket closed or errored. As in net_webtransport_server.ts: a socket
 * assigned to a client is left for WS_QGetMessage to report (-1 leads to
 * SV_DropClient -> NET_Close); one still pending is freed here.
 */
function _onTransportClosed(conn: ClientConnection): void {
  conn.dead = true;
  conn.connected = false;
  const sock = conn.sock;
  if (sock === null || sock.driverdata !== conn) {
    _finishClose(conn);
    return;
  }

  const pendingIdx = pendingConnections.indexOf(sock);
  if (pendingIdx !== -1) {
    pendingConnections.splice(pendingIdx, 1);
    sock.driverdata = null;
    conn.sock = null;
    _freeQSocket(sock);
    _finishClose(conn);
  }
}

function _clearTimers(conn: ClientConnection): void {
  if (conn.handshakeTimer !== null) {
    clearTimeout(conn.handshakeTimer);
    conn.handshakeTimer = null;
  }
  if (conn.pendingAcceptTimer !== null) {
    clearTimeout(conn.pendingAcceptTimer);
    conn.pendingAcceptTimer = null;
  }
  if (conn.closeTimer !== null) {
    clearTimeout(conn.closeTimer);
    conn.closeTimer = null;
  }
}

function _bufferedAmount(conn: ClientConnection): number {
  const amount = conn.socket.bufferedAmount;
  return typeof amount === "number" ? amount : 0;
}

/**
 * Begin a graceful close: stop delivering messages, let the queued messages
 * (the disconnect reason) drain, then close the socket and wait for the
 * client's close, all bounded by WS_CLOSE_FLUSH_MS.
 */
function _closeConnection(conn: ClientConnection): void {
  if (conn.closing) return;
  conn.closing = true;
  conn.connected = false;
  _clearTimers(conn);

  if (conn.dead || conn.socket.readyState !== WS_OPEN) {
    _finishClose(conn);
    return;
  }

  conn.closeDeadline = Date.now() + WS_CLOSE_FLUSH_MS;
  _pollClose(conn);
}

function _pollClose(conn: ClientConnection): void {
  conn.closeTimer = null;
  if (conn.closeFinished) return;

  if (conn.dead || Date.now() >= conn.closeDeadline) {
    _finishClose(conn);
    return;
  }

  if (!conn.closeRequested && _bufferedAmount(conn) === 0) {
    conn.closeRequested = true;
    try {
      conn.socket.close(1000);
    } catch {
      _finishClose(conn);
      return;
    }
  }

  conn.closeTimer = setTimeout(() => _pollClose(conn), WS_CLOSE_POLL_MS);
}

function _finishClose(conn: ClientConnection): void {
  if (conn.closeFinished) return;
  conn.closeFinished = true;
  conn.connected = false;
  conn.dead = true;
  _clearTimers(conn);
  conn.pendingMessages.length = 0;

  const socket = conn.socket;
  socket.onmessage = null;
  socket.onclose = null;
  socket.onerror = null;
  try {
    socket.close(1000);
  } catch { /* ignore */ }

  liveConnections.delete(conn);
  const release = conn.releaseSession;
  conn.releaseSession = null;
  if (release !== null) release();
  Sys_Printf("Connection closed: " + conn.address + "\n");
}

export function WS_SearchForHosts(_xmit: boolean): void {
  // Server doesn't search for other servers
}

export function WS_Connect(_host: string): null {
  // Server doesn't connect to other servers
  return null;
}

/**
 * Check for new incoming connections
 */
export function WS_CheckNewConnections(): QSocket | null {
  while (pendingConnections.length > 0) {
    const sock = pendingConnections.shift()!;
    const conn = sock.driverdata;
    if (sock.disconnected) continue;
    if (conn === null || !conn.connected) {
      Sys_Printf("Skipped disconnected socket in pending queue\n");
      sock.driverdata = null;
      if (conn !== null) {
        conn.sock = null;
        _closeConnection(conn);
      }
      _freeQSocket(sock);
      continue;
    }
    if (conn.pendingAcceptTimer !== null) {
      clearTimeout(conn.pendingAcceptTimer);
      conn.pendingAcceptTimer = null;
    }
    return sock;
  }
  return null;
}

function _parseSequencedPacket(
  sock: QSocket,
  conn: ClientConnection,
  packet: Uint8Array,
  reliable: boolean,
): Uint8Array | null {
  if (packet.length < WT_PACKET_HEADER_BYTES || packet[0] !== WT_PACKET_MAGIC) {
    return packet;
  }

  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  const sequence = view.getUint32(1, true) | 0;
  const acknowledged = view.getUint32(5, true) | 0;

  if (
    conn.peerSequenced !== true ||
    _isNewerSequence(acknowledged, sock.ackSequence | 0)
  ) {
    sock.ackSequence = acknowledged;
  }
  conn.peerSequenced = true;

  if (reliable) {
    if (
      conn.reliableSequenceValid &&
      !_isNewerSequence(sequence, sock.receiveSequence | 0)
    ) {
      return null;
    }
    sock.receiveSequence = sequence;
    conn.reliableSequenceValid = true;
  } else {
    if (
      conn.unreliableSequenceValid &&
      !_isNewerSequence(sequence, sock.unreliableReceiveSequence | 0)
    ) {
      return null;
    }
    sock.unreliableReceiveSequence = sequence;
    conn.unreliableSequenceValid = true;
  }

  if (
    !conn.hasReceivedSequence ||
    _isNewerSequence(sequence, conn.highestReceivedSequence | 0)
  ) {
    conn.highestReceivedSequence = sequence;
  }
  conn.hasReceivedSequence = true;

  return packet.subarray(WT_PACKET_HEADER_BYTES);
}

/**
 * Get a message: 0 = none, 1 = reliable, 2 = unreliable, -1 = dead
 */
export function WS_QGetMessage(sock: QSocket): number {
  const conn = sock.driverdata;
  if (conn === null) return -1;

  if (!conn.connected && conn.pendingMessages.length === 0) return -1;

  while (conn.pendingMessages.length > 0) {
    let msg = conn.pendingMessages.shift()!;

    // Skip to the newest unreliable message before the next reliable one:
    // in original Quake, unreliable messages are overwritten by newer ones.
    if (!msg.reliable) {
      while (conn.pendingMessages.length > 0) {
        const next = conn.pendingMessages[0];
        if (next.reliable) break;
        conn.pendingMessages.shift();
        msg = next;
      }
    }

    const payload = _parseSequencedPacket(sock, conn, msg.data, msg.reliable);
    if (payload === null) continue;

    if (payload.length > net_message.maxsize) {
      if (!msg.reliable) {
        if (!conn.oversizedInboundLogged) {
          conn.oversizedInboundLogged = true;
          Sys_Printf(
            "Dropping oversized message (%d bytes) from %s\n",
            payload.length,
            conn.address,
          );
        }
        continue;
      }
      Sys_Printf(
        "Oversized reliable message (%d bytes) from %s, disconnecting\n",
        payload.length,
        conn.address,
      );
      conn.connected = false;
      conn.pendingMessages.length = 0;
      return -1;
    }

    net_message.data.set(payload, 0);
    net_message.cursize = payload.length;

    sock.lastMessageTime = performance.now() / 1000;

    return msg.reliable ? 1 : 2;
  }

  return conn.connected ? 0 : -1;
}

// Common checks before a send; false if the connection can't send.
function _checkSendable(conn: ClientConnection): boolean {
  if (!conn.connected) return false;
  if (conn.socket.readyState !== WS_OPEN) {
    conn.connected = false;
    return false;
  }
  if (_bufferedAmount(conn) >= WS_HARD_BUFFERED) {
    Sys_Printf(
      "WebSocket %s: send buffer stalled, disconnecting\n",
      conn.address,
    );
    conn.connected = false;
    return false;
  }
  return true;
}

function _sendPacket(
  sock: QSocket,
  conn: ClientConnection,
  channel: number,
  data: { data: Uint8Array; cursize: number },
): void {
  const length = data.cursize;
  const sequence = sock.sendSequence | 0;
  // Highest sequence received on either channel acknowledges client moves
  // whichever channel they came on (PRED-2)
  const acknowledged = conn.hasReceivedSequence
    ? conn.highestReceivedSequence | 0
    : sock.receiveSequence | 0;

  ws_sendbuf[0] = channel;
  ws_sendbuf[1] = WT_PACKET_MAGIC;
  ws_sendview.setUint32(2, sequence >>> 0, true);
  ws_sendview.setUint32(6, acknowledged >>> 0, true);
  ws_sendbuf.set(
    data.data.subarray(0, length),
    WS_CHANNEL_BYTES + WT_PACKET_HEADER_BYTES,
  );

  sock.sendSequence = (sequence + 1) | 0;
  conn.lastWrittenSequence = sequence;

  conn.socket.send(
    ws_sendbuf.subarray(0, WS_CHANNEL_BYTES + WT_PACKET_HEADER_BYTES + length),
  );
}

/**
 * Send a reliable message. TCP handles ordering and retransmission.
 */
export function WS_QSendMessage(
  sock: QSocket,
  data: { data: Uint8Array; cursize: number },
): number {
  const conn = sock.driverdata;
  if (conn === null || !_checkSendable(conn)) return -1;

  if (data.cursize > NET_MAXMESSAGE) {
    Sys_Printf(
      "WS_QSendMessage: message too large (%d bytes) for %s\n",
      data.cursize,
      conn.address,
    );
    return -1;
  }

  try {
    _sendPacket(sock, conn, WS_CHANNEL_RELIABLE, data);
  } catch (error) {
    Sys_Printf(
      "WS_QSendMessage error for %s: %s\n",
      conn.address,
      (error as Error).message,
    );
    conn.connected = false;
    return -1;
  }
  return 1;
}

// True while unreliable sends should be dropped (see WS_MAX_UNACKED_PACKETS)
function _unreliableBlocked(sock: QSocket, conn: ClientConnection): boolean {
  if (_bufferedAmount(conn) >= WS_MAX_UNRELIABLE_BUFFERED) return true;
  if (!conn.peerSequenced) return false;
  return ((conn.lastWrittenSequence - (sock.ackSequence | 0)) | 0) >
    WS_MAX_UNACKED_PACKETS;
}

/**
 * Send an unreliable message on the stream, or drop it while the client is
 * backed up. A dropped message uses no sequence number.
 */
export function WS_SendUnreliableMessage(
  sock: QSocket,
  data: { data: Uint8Array; cursize: number },
): number {
  const conn = sock.driverdata;
  if (conn === null || !_checkSendable(conn)) return -1;

  if (data.cursize > NET_MAXMESSAGE || _unreliableBlocked(sock, conn)) {
    return 1;
  }

  try {
    _sendPacket(sock, conn, WS_CHANNEL_UNRELIABLE, data);
  } catch {
    // Unreliable: a failed send is a dropped message; the close event or
    // the next reliable send reports a dead socket.
  }
  return 1;
}

export function WS_CanSendMessage(sock: QSocket): boolean {
  const conn = sock.driverdata;
  return conn !== null && conn.connected &&
    conn.socket.readyState === WS_OPEN &&
    _bufferedAmount(conn) < WS_MAX_RELIABLE_BUFFERED;
}

/**
 * False while unreliable sends would be dropped, so SV_SendClientDatagram
 * skips building the frame's datagram.
 */
export function WS_CanSendUnreliableMessage(sock: QSocket): boolean {
  const conn = sock.driverdata;
  if (conn === null || !conn.connected) return false;
  if (conn.socket.readyState !== WS_OPEN) return false;
  return !_unreliableBlocked(sock, conn);
}

/**
 * Close a connection. The socket is detached at once (NET_Close frees it
 * straight after); queued messages such as the svc_disconnect or kick reason
 * still drain in the background, bounded by WS_CLOSE_FLUSH_MS.
 */
export function WS_Close(sock: QSocket): void {
  const conn = sock.driverdata;
  if (conn === null) return;

  sock.driverdata = null;
  conn.sock = null;
  const pendingIdx = pendingConnections.indexOf(sock);
  if (pendingIdx !== -1) pendingConnections.splice(pendingIdx, 1);

  _closeConnection(conn);
}

/**
 * Configure the server. hostname defaults to 127.0.0.1: the WebSocket
 * listener is meant to sit behind a local proxy (the lobby, cloudflared).
 */
export function WS_SetConfig(config: {
  port?: number;
  hostname?: string;
  tls?: boolean;
  certFile?: string;
  keyFile?: string;
  trustQueryIp?: boolean;
  maxSessionsPerIp?: number;
  maxHandshakingSessions?: number;
  handshakeTimeoutMs?: number;
  pendingAcceptTimeoutMs?: number;
  closeFlushMs?: number;
}): void {
  if (config.port) serverPort = config.port;
  if (config.hostname) serverHostname = config.hostname;
  if (config.tls !== undefined) useTls = config.tls;
  if (config.certFile) certFile = config.certFile;
  if (config.keyFile) keyFile = config.keyFile;
  if (config.trustQueryIp !== undefined) trustQueryIp = config.trustQueryIp;
  if (config.maxSessionsPerIp && config.maxSessionsPerIp > 0) {
    maxSessionsPerIp = config.maxSessionsPerIp;
  }
  if (config.maxHandshakingSessions && config.maxHandshakingSessions > 0) {
    maxHandshakingSessions = config.maxHandshakingSessions;
  }
  if (config.handshakeTimeoutMs && config.handshakeTimeoutMs > 0) {
    WS_HANDSHAKE_TIMEOUT_MS = config.handshakeTimeoutMs;
  }
  if (config.pendingAcceptTimeoutMs && config.pendingAcceptTimeoutMs > 0) {
    WS_PENDING_ACCEPT_TIMEOUT_MS = config.pendingAcceptTimeoutMs;
  }
  if (config.closeFlushMs && config.closeFlushMs > 0) {
    WS_CLOSE_FLUSH_MS = config.closeFlushMs;
  }
}

export function WS_SetDriverLevel(level: number): void {
  net_driverlevel = level;
}

/**
 * The listener's bound address, or null when not listening (tests use it
 * with port 0).
 */
export function WS_GetListenAddrForTest(): Deno.NetAddr | null {
  return listenServer !== null ? listenServer.addr as Deno.NetAddr : null;
}

/**
 * Test hook: run an already-open socket through the same path as an
 * upgraded request (session limits, handshake, socket allocation). Returns
 * false if a session limit rejected it.
 */
export function WS_AcceptSocketForTest(
  socket: WebSocketLike,
  address: string,
  ip: string,
): boolean {
  const release = _reserveSession(ip, address);
  if (release === null) return false;
  _acceptSocket(socket, address, ip, release);
  return true;
}

/**
 * Test hook: driver bookkeeping counters.
 */
export function WS_GetSessionStatsForTest(): {
  handshaking: number;
  sessionsByIp: number;
  pending: number;
  live: number;
} {
  let perIp = 0;
  for (const n of sessionsByIp.values()) perIp += n;
  return {
    handshaking: handshakingSessions,
    sessionsByIp: perIp,
    pending: pendingConnections.length,
    live: liveConnections.size,
  };
}
