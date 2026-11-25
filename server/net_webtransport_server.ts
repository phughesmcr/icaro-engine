// WebTransport server driver for Deno
// Handles incoming client connections via WebTransport/HTTP3

import { Sys_Printf } from "./sys_server.ts";
import { QUIC_CloseEndpoints, QUIC_OpenEndpoints } from "./quic_listen.ts";
import {
  net_message,
  WT_BuildHandshakeReplyFrame,
  WT_HANDSHAKE_ACCEPT,
  WT_HANDSHAKE_REJECT,
  WT_MAX_FRAME_PAYLOAD,
  WT_PACKET_HEADER_BYTES,
  WT_PACKET_MAGIC,
  WT_ParseHello,
  WT_PROTOCOL_VERSION,
} from "../src/net.js";

// Server configuration
let serverPort = 4433;
let certFile = "cert.pem";
let keyFile = "key.pem";

// Minimal structural types so tests can drive the driver with in-memory fakes.
interface BidiStream {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
}

export interface WebTransportLike {
  ready: Promise<unknown>;
  closed: Promise<unknown>;
  incomingBidirectionalStreams: ReadableStream<BidiStream>;
  datagrams?: {
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
    maxDatagramSize?: number;
  } | null;
  close(info?: unknown): void;
}

interface PendingMessage {
  reliable: boolean;
  data: Uint8Array;
}

// Connection tracking
// Transport protocol:
// - Reliable bidirectional stream for signon data, stringcmds, name/frag changes
// - Unreliable WebTransport datagrams for entity updates, clientdata, clc_move
// - The first reliable frame in each direction is the connect handshake
//   (see WT_BuildHelloFrame in src/net.js)
// - Game payloads may be prefixed with transport sequencing header:
//   [magic:1][sequence:4][ack:4][quake_payload...]
interface ClientConnection {
  id: number;
  webTransport: WebTransportLike;
  address: string;
  ip: string;
  sock: QSocket | null;
  reliableWriter: WritableStreamDefaultWriter<Uint8Array> | null;
  reliableReader: ReadableStreamDefaultReader<Uint8Array> | null;
  datagramWriter: WritableStreamDefaultWriter<Uint8Array> | null;
  datagramReader: ReadableStreamDefaultReader<Uint8Array> | null;
  // The session's datagram stream, for its live maxDatagramSize
  datagramStream: { maxDatagramSize?: number } | null;
  maxDatagramSize: number;
  pendingMessages: PendingMessage[];
  // Game-facing state: false once the connection is dead or being closed.
  connected: boolean;
  // WT_Close was called: flushing the reliable queue before closing.
  closing: boolean;
  // The transport itself is gone; nothing more can be written.
  dead: boolean;
  closeFinished: boolean;
  closeFlushed: boolean;
  reliableReaderEnded: boolean;
  closeTimer: ReturnType<typeof setTimeout> | null;
  pendingAcceptTimer: ReturnType<typeof setTimeout> | null;
  // Resolves a reader that paused because pendingMessages is full.
  readResume: (() => void) | null;
  lastMessageTime: number;
  reliableWriteQueue: Uint8Array[];
  reliableWriteInFlight: boolean;
  unreliableQueuedPacket: Uint8Array | null;
  unreliableWriteInFlight: boolean;
  unreliableWriteStartedAt: number;
  datagramCooldownUntil: number;
  outboundDatagramsEnabled: boolean;
  pendingReliableWrites: number;
  pendingUnreliableWrites: number;
  // Sequencing state (explicit flags instead of negative-sequence sentinels).
  peerSequenced: boolean;
  reliableSequenceValid: boolean;
  unreliableSequenceValid: boolean;
  highestReceivedSequence: number;
  hasReceivedSequence: boolean;
  oversizedDatagramLogged: boolean;
  oversizedInboundLogged: boolean;
  // Releases the session's limit slot; called once when the close finishes.
  releaseSession: (() => void) | null;
}

// Socket structure compatible with Quake's qsocket_t
export interface QSocket {
  next: QSocket | null;
  connecttime: number;
  lastMessageTime: number;
  lastSendTime: number;
  disconnected: boolean;
  canSend: boolean;
  sendNext: boolean;
  driver: number;
  landriver: number;
  socket: number;
  driverdata: ClientConnection | null;
  ackSequence: number;
  sendSequence: number;
  unreliableSendSequence: number;
  sendMessageLength: number;
  sendMessage: Uint8Array;
  receiveSequence: number;
  unreliableReceiveSequence: number;
  receiveMessageLength: number;
  receiveMessage: Uint8Array;
  addr: unknown;
  address: string;
  // Largest unreliable payload in one datagram, 0 if unknown (src/net.js)
  maxdatagram: number;
}

// Active sockets (fallback allocator only)
let activeSockets: QSocket | null = null;
let freeSockets: QSocket | null = null;
let numSockets = 0;

// Sockets handed out for sessions that SV_CheckForNewClients has not accepted
const pendingConnections: QSocket[] = [];

// Every connection that has finished the handshake and is not fully closed
const liveConnections = new Set<ClientConnection>();

// QUIC endpoints (IPv6 and/or IPv4, see quic_listen.ts)
let quicEndpoints: Deno.QuicEndpoint[] | null = null;

// Connection ID counter
let nextConnectionId = 1;

// Driver level (set by net_main)
let net_driverlevel = 0;

const NET_MAXMESSAGE = 8192;

// Session limits (NET-2). A session is counted from QUIC accept until its
// transport closes; "handshaking" covers the time before a slot is assigned.
let maxHandshakingSessions = 16;
let maxSessionsPerIp = 8;
// Timeouts can be shortened through WT_SetConfig (tests do).
let WT_HANDSHAKE_TIMEOUT_MS = 10000;
// A socket waiting in pendingConnections longer than this is closed.
let WT_PENDING_ACCEPT_TIMEOUT_MS = 30000;
// Bounded wait for the final reliable frames (disconnect reason) on close.
let WT_CLOSE_FLUSH_MS = 1000;

let handshakingSessions = 0;
const sessionsByIp = new Map<string, number>();

// Inbound queue. Readers pause (QUIC flow control then throttles the peer)
// instead of disconnecting when the game loop falls behind, for example
// during a map load. Consecutive unreliable messages are coalesced on push.
const MAX_PENDING_MESSAGES = 256;
const RESUME_PENDING_MESSAGES = 128;

// Write backpressure limits.
// - Reliable: queued and written in order, one in-flight write at a time.
// - Unreliable: per connection, single flight, one queued "latest" datagram.
//   A connection whose datagram write stalls or times out sends its
//   unreliable traffic on the reliable stream for a cooldown, then retries.
const MAX_PENDING_WRITES_UNRELIABLE = 2;
const MAX_PENDING_WRITES_RELIABLE = 64;
// Unreliable traffic rerouted onto the reliable stream is dropped beyond this
// backlog so it can never push a client into the reliable disconnect limit.
const MAX_UNRELIABLE_ON_RELIABLE = 8;
const WT_DATAGRAM_STALL_MS = 1000;
const WT_DATAGRAM_COOLDOWN_MS = 5000;

const USE_OUTBOUND_DATAGRAMS: boolean = true;

// Yield to the macrotask queue so setInterval (game loop) can run.
// reader.read() resolves via microtasks which can cascade without yielding.
// setTimeout(resolve, 0) ensures the game loop's setInterval gets a chance to fire.
function _yieldAfterRead(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function _isTimeoutLikeError(error: unknown): boolean {
  const msg = String(error).toLowerCase();
  return msg.includes("timed out") || msg.includes("timeout");
}

function _isNewerSequence(sequence: number, current: number): boolean {
  return (((sequence - current) | 0) > 0);
}

// Highest sequence received on either lane. Both lanes share the peer's
// sendSequence counter, so this acknowledges client moves whether they came
// over the reliable stream or as datagrams (PRED-2).
function _ackSequence(sock: QSocket, conn: ClientConnection | null): number {
  if (conn !== null && conn.hasReceivedSequence === true) {
    return conn.highestReceivedSequence | 0;
  }
  return sock.receiveSequence | 0;
}

function _buildSequencedPacket(
  sock: QSocket,
  data: Uint8Array,
  dataLength: number,
  forceHeader = false,
): Uint8Array {
  const conn = sock.driverdata;
  if (!forceHeader && (conn === null || conn.peerSequenced !== true)) {
    // Peer has never sent a sequenced packet: legacy, headerless framing.
    const legacyPacket = new Uint8Array(dataLength);
    legacyPacket.set(data.subarray(0, dataLength), 0);
    return legacyPacket;
  }

  const packet = new Uint8Array(WT_PACKET_HEADER_BYTES + dataLength);
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);

  const sequence = sock.sendSequence | 0;
  const acknowledged = _ackSequence(sock, conn);

  packet[0] = WT_PACKET_MAGIC;
  view.setUint32(1, sequence >>> 0, true);
  view.setUint32(5, acknowledged >>> 0, true);
  packet.set(data.subarray(0, dataLength), WT_PACKET_HEADER_BYTES);

  sock.sendSequence = (sequence + 1) | 0;

  return packet;
}

function _parseSequencedPacket(
  sock: QSocket,
  packet: Uint8Array,
  reliable: boolean,
): Uint8Array | null {
  if (packet.length < WT_PACKET_HEADER_BYTES || packet[0] !== WT_PACKET_MAGIC) {
    return packet;
  }

  const conn = sock.driverdata as ClientConnection;
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

  if (reliable === true) {
    if (
      conn.reliableSequenceValid === true &&
      _isNewerSequence(sequence, sock.receiveSequence | 0) === false
    ) {
      return null;
    }
    sock.receiveSequence = sequence;
    conn.reliableSequenceValid = true;
  } else {
    if (
      conn.unreliableSequenceValid === true &&
      _isNewerSequence(sequence, sock.unreliableReceiveSequence | 0) === false
    ) {
      return null;
    }
    sock.unreliableReceiveSequence = sequence;
    conn.unreliableSequenceValid = true;
  }

  if (
    conn.hasReceivedSequence !== true ||
    _isNewerSequence(sequence, conn.highestReceivedSequence | 0)
  ) {
    conn.highestReceivedSequence = sequence;
  }
  conn.hasReceivedSequence = true;

  return packet.subarray(WT_PACKET_HEADER_BYTES);
}

function _disableOutboundDatagrams(
  conn: ClientConnection,
  reason: string,
): void {
  if (conn.outboundDatagramsEnabled === false) {
    return;
  }

  conn.outboundDatagramsEnabled = false;
  conn.unreliableQueuedPacket = null;

  _updatePendingWriteCounts(conn);
  Sys_Printf(
    "WT_SendUnreliableMessage: disabling outbound datagrams for %s (%s)\n",
    conn.address,
    reason,
  );
}

// Callback for socket allocation (injected from game_server.js)
// This allows using the shared socket pool from net_main.js. The allocator
// receives the number of sockets still waiting in pendingConnections so that
// it can count them against svs.maxclients (NET-1).
let _NET_NewQSocket: ((pendingConnections?: number) => QSocket | null) | null =
  null;
let _NET_FreeQSocket: ((sock: QSocket) => void) | null = null;

/**
 * Set the socket allocator callback
 */
export function WT_SetSocketAllocator(
  allocator: ((pendingConnections?: number) => QSocket | null) | null,
): void {
  _NET_NewQSocket = allocator;
}

/**
 * Sockets handed out but not yet accepted; the WebSocket driver's allocator
 * adds them to its own count (game_server.js).
 */
export function WT_GetPendingConnectionCount(): number {
  return pendingConnections.length;
}

/**
 * Set the socket freer callback
 */
export function WT_SetSocketFreer(
  freer: ((sock: QSocket) => void) | null,
): void {
  _NET_FreeQSocket = freer;
}

/**
 * Initialize the WebTransport server driver
 */
export function WT_Init(): number {
  Sys_Printf("WebTransport server driver initialized\n");
  return 0;
}

/**
 * Shutdown the WebTransport server driver
 */
export function WT_Shutdown(): void {
  Sys_Printf("WebTransport server driver shutting down\n");

  if (quicEndpoints !== null) {
    QUIC_CloseEndpoints(quicEndpoints);
    quicEndpoints = null;
  }

  // Close all connections immediately (the process is going away)
  for (const conn of Array.from(liveConnections)) {
    conn.connected = false;
    conn.closing = true;
    _finishClose(conn);
  }
}

// Store cert/key for listen()
let serverCert = "";
let serverKey = "";

/**
 * Start or stop listening for connections.
 * Resolves to false if the listener could not be started (for example the
 * port is in use or the certificate can't be read), true otherwise.
 */
export async function WT_Listen(state: boolean): Promise<boolean> {
  if (state) {
    if (quicEndpoints !== null) return true; // Already listening

    try {
      // Read TLS certificate and key
      serverCert = await Deno.readTextFile(certFile);
      serverKey = await Deno.readTextFile(keyFile);

      // Create QUIC endpoints. Browsers may resolve localhost to ::1, so
      // listen on IPv6 as well as IPv4.
      const bound = QUIC_OpenEndpoints(serverPort);
      quicEndpoints = bound.endpoints;

      Sys_Printf(
        "WebTransport server listening on port " + serverPort + " on " +
          bound.description + "\n",
      );

      // Start accepting connections in background
      for (const endpoint of quicEndpoints) {
        _acceptConnections(quicEndpoints, endpoint);
      }
      return true;
    } catch (error) {
      Sys_Printf(
        "Failed to start WebTransport listener: " +
          (error as Error).message +
          "\n",
      );
      return false;
    }
  }

  if (quicEndpoints !== null) {
    QUIC_CloseEndpoints(quicEndpoints);
    quicEndpoints = null;
    Sys_Printf("WebTransport server stopped listening\n");
  }
  return true;
}

/**
 * Background task to accept incoming connections on one endpoint. It runs
 * until WT_Listen(false) or WT_Shutdown replaces the endpoint set it belongs to.
 */
async function _acceptConnections(
  endpoints: Deno.QuicEndpoint[],
  endpoint: Deno.QuicEndpoint,
): Promise<void> {
  try {
    // Get listener from endpoint with TLS options
    const listener = endpoint.listen({
      cert: serverCert,
      key: serverKey,
      alpnProtocols: ["h3"], // HTTP/3 for WebTransport
    });

    // Accept connections using listener.accept() which returns QuicConn directly
    while (quicEndpoints === endpoints) {
      try {
        // Use listener.accept() to get QuicConn directly
        const conn = await listener.accept();

        const remoteAddr = conn.remoteAddr;
        const address = remoteAddr.hostname + ":" + remoteAddr.port;
        Sys_Printf("Connection from " + address + "\n");

        _handleIncomingSession(
          // @ts-ignore - unstable API
          () => Deno.upgradeWebTransport(conn) as Promise<WebTransportLike>,
          address,
          remoteAddr.hostname,
          () => {
            try {
              conn.close();
            } catch { /* ignore */ }
          },
        );
      } catch (error) {
        if (quicEndpoints === endpoints) {
          Sys_Printf("Accept error: " + (error as Error).message + "\n");
          // Delay before retrying to prevent 100% CPU spin if accept() fails repeatedly
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
    }
  } catch (error) {
    if (quicEndpoints === endpoints) {
      Sys_Printf(
        "Listener error: " + (error as Error).message + "\n",
      );
    }
  }
}

interface SessionSlot {
  ip: string;
  handshaking: boolean;
  released: boolean;
}

function _reserveSession(ip: string, address: string): SessionSlot | null {
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
  return { ip, handshaking: true, released: false };
}

function _endHandshake(slot: SessionSlot): void {
  if (slot.handshaking) {
    slot.handshaking = false;
    handshakingSessions--;
  }
}

function _releaseSession(slot: SessionSlot): void {
  _endHandshake(slot);
  if (slot.released) return;
  slot.released = true;
  const perIp = (sessionsByIp.get(slot.ip) ?? 1) - 1;
  if (perIp <= 0) {
    sessionsByIp.delete(slot.ip);
  } else {
    sessionsByIp.set(slot.ip, perIp);
  }
}

interface Deadline {
  promise: Promise<never>;
  cancel(): void;
}

function _deadline(ms: number, message: string): Deadline {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const promise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timer = null;
      reject(new Error(message));
    }, ms);
  });
  promise.catch(() => {});
  return {
    promise,
    cancel() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

function _race<T>(promise: Promise<T>, deadline: Deadline): Promise<T> {
  promise.catch(() => {});
  return Promise.race([promise, deadline.promise]);
}

/**
 * Upgrade, handshake and register one incoming session. Every exit path
 * releases the session slot, and the handshake is bounded by a deadline.
 * Resolves once the session is either registered or closed.
 */
async function _handleIncomingSession(
  upgrade: () => Promise<WebTransportLike>,
  address: string,
  ip: string,
  abortRaw: () => void,
): Promise<void> {
  const slot = _reserveSession(ip, address);
  if (slot === null) {
    abortRaw();
    return;
  }

  const deadline = _deadline(
    WT_HANDSHAKE_TIMEOUT_MS,
    "handshake timed out",
  );
  let wt: WebTransportLike | null = null;
  const upgrading = upgrade();

  try {
    try {
      wt = await _race(upgrading, deadline);
    } catch (error) {
      // An upgrade that completes after the deadline is closed straight away.
      upgrading.then((late) => {
        try {
          late.close();
        } catch { /* ignore */ }
      }, () => {});
      throw error;
    }
    const session = wt;
    // Released whenever the transport ends, however that happens.
    session.closed.then(
      () => _releaseSession(slot),
      () => _releaseSession(slot),
    );
    await _handleWebTransportSession(
      session,
      address,
      ip,
      deadline,
      () => _releaseSession(slot),
    );
  } catch (error) {
    Sys_Printf(
      "Session error for %s: %s\n",
      address,
      (error as Error).message,
    );
    if (wt !== null) {
      try {
        wt.close();
      } catch { /* ignore */ }
    } else {
      abortRaw();
      _releaseSession(slot);
    }
  } finally {
    deadline.cancel();
    _endHandshake(slot);
  }
}

function _newConnection(
  wt: WebTransportLike,
  address: string,
  ip: string,
): ClientConnection {
  return {
    id: nextConnectionId++,
    webTransport: wt,
    address,
    ip,
    sock: null,
    reliableWriter: null,
    reliableReader: null,
    datagramWriter: null,
    datagramReader: null,
    datagramStream: null,
    maxDatagramSize: 0,
    pendingMessages: [],
    connected: true,
    closing: false,
    dead: false,
    closeFinished: false,
    closeFlushed: false,
    reliableReaderEnded: false,
    closeTimer: null,
    pendingAcceptTimer: null,
    readResume: null,
    lastMessageTime: Date.now(),
    reliableWriteQueue: [],
    reliableWriteInFlight: false,
    unreliableQueuedPacket: null,
    unreliableWriteInFlight: false,
    unreliableWriteStartedAt: 0,
    datagramCooldownUntil: 0,
    outboundDatagramsEnabled: true,
    pendingReliableWrites: 0,
    pendingUnreliableWrites: 0,
    peerSequenced: false,
    reliableSequenceValid: false,
    unreliableSequenceValid: false,
    highestReceivedSequence: -1,
    hasReceivedSequence: false,
    oversizedDatagramLogged: false,
    oversizedInboundLogged: false,
    releaseSession: null,
  };
}

/**
 * Handle an already-upgraded WebTransport session: wait for the first
 * stream and the client hello, then either assign a socket or reject.
 */
async function _handleWebTransportSession(
  wt: WebTransportLike,
  address: string,
  ip: string,
  deadline: Deadline,
  releaseSession: () => void,
): Promise<void> {
  await _race(wt.ready, deadline);

  const conn = _newConnection(wt, address, ip);
  conn.releaseSession = releaseSession;
  liveConnections.add(conn);
  wt.closed.then(
    () => _onTransportClosed(conn),
    () => _onTransportClosed(conn),
  );

  // Accept the first bidirectional stream (reliable channel)
  const streamReader = wt.incomingBidirectionalStreams.getReader();
  let stream: BidiStream | undefined;
  try {
    const result = await _race(streamReader.read(), deadline);
    stream = result.done ? undefined : result.value;
  } finally {
    try {
      streamReader.releaseLock();
    } catch { /* ignore */ }
  }

  if (!stream) {
    _closeConnection(conn);
    return;
  }

  conn.reliableWriter = stream.writable.getWriter();
  conn.reliableReader = stream.readable.getReader();

  // Connect handshake: the first frame must be a client hello.
  const hello = await _race(_readFramedMessage(conn.reliableReader), deadline);
  const version = hello === null ? -1 : WT_ParseHello(hello);
  if (version !== WT_PROTOCOL_VERSION) {
    Sys_Printf(
      "Rejecting %s: %s\n",
      address,
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

  // Unreliable channel via WebTransport datagrams
  const datagrams = wt.datagrams;
  if (!datagrams) {
    Sys_Printf("Client %s has no datagram support, closing\n", address);
    _rejectConnection(conn, "WebTransport datagrams unavailable");
    return;
  }

  if (conn.dead) {
    _closeConnection(conn);
    return;
  }

  // Create a socket for this game connection. The allocator counts sockets
  // still waiting to be accepted, so it never hands out more sockets than
  // there are free client slots (NET-1).
  const sock = _newQSocket();
  if (!sock) {
    Sys_Printf("No free client slots for %s\n", address);
    _rejectConnection(conn, "Server is full");
    return;
  }

  conn.datagramWriter = datagrams.writable.getWriter();
  conn.datagramReader = datagrams.readable.getReader();
  conn.datagramStream = datagrams;

  sock.address = conn.address;
  sock.driverdata = conn;
  sock.connecttime = performance.now() / 1000;
  sock.lastMessageTime = performance.now() / 1000;
  sock.sendSequence = 0;
  sock.receiveSequence = -1;
  sock.unreliableReceiveSequence = -1;
  sock.ackSequence = -1;
  conn.sock = sock;
  _refreshMaxDatagramSize(conn);

  _queueReliableFrame(
    conn,
    WT_BuildHandshakeReplyFrame(WT_HANDSHAKE_ACCEPT, ""),
  );

  pendingConnections.push(sock);
  conn.pendingAcceptTimer = setTimeout(() => {
    conn.pendingAcceptTimer = null;
    const idx = pendingConnections.indexOf(sock);
    if (idx === -1 || sock.driverdata !== conn) return;
    Sys_Printf("Connection %s was never accepted, closing\n", address);
    pendingConnections.splice(idx, 1);
    sock.driverdata = null;
    conn.sock = null;
    if (_NET_FreeQSocket !== null) {
      _NET_FreeQSocket(sock);
    } else {
      WT_FreeQSocket(sock);
    }
    _closeConnection(conn);
  }, WT_PENDING_ACCEPT_TIMEOUT_MS);

  _startBackgroundReaders(conn);
}

function _rejectConnection(conn: ClientConnection, reason: string): void {
  if (conn.reliableWriter !== null && !conn.dead) {
    _queueReliableFrame(
      conn,
      WT_BuildHandshakeReplyFrame(WT_HANDSHAKE_REJECT, reason),
    );
  }
  _closeConnection(conn);
}

function _wakeReader(conn: ClientConnection): void {
  const resume = conn.readResume;
  if (resume != null) {
    conn.readResume = null;
    resume();
  }
}

function _pushPendingMessage(
  conn: ClientConnection,
  reliable: boolean,
  data: Uint8Array,
): void {
  const queue = conn.pendingMessages;
  // Only the newest of consecutive unreliable messages is ever delivered
  // (see WT_QGetMessage), so replace instead of growing the queue.
  if (!reliable && queue.length > 0 && !queue[queue.length - 1].reliable) {
    queue[queue.length - 1].data = data;
    return;
  }
  queue.push({ reliable, data });
}

/**
 * Start background readers for reliable stream + unreliable datagrams.
 */
function _startBackgroundReaders(
  conn: ClientConnection,
): void {
  // Read reliable messages from the first bidirectional stream
  (async () => {
    let cleanEnd = false;
    try {
      while (conn.connected && conn.reliableReader) {
        // Backpressure: stop reading until the game loop catches up.
        if (conn.pendingMessages.length >= MAX_PENDING_MESSAGES) {
          await new Promise<void>((resolve) => {
            conn.readResume = resolve;
          });
          continue;
        }

        const data = await _readFramedMessage(conn.reliableReader);
        if (data === null) {
          cleanEnd = true;
          break;
        }

        if (conn.connected) {
          _pushPendingMessage(conn, true, data);
          conn.lastMessageTime = Date.now();
        }

        // Yield to macrotask queue after reading so the game loop can run
        await _yieldAfterRead();
      }
    } catch (error) {
      if (conn.connected) {
        Sys_Printf(
          "Reliable reader error for %s: %s\n",
          conn.address,
          String(error),
        );
      }
    }
    if (conn.connected) {
      if (cleanEnd) {
        Sys_Printf("Client %s closed its stream\n", conn.address);
      }
      // A finished reader means the peer is gone (NET-2).
      conn.connected = false;
    }
    conn.reliableReaderEnded = true;
    try {
      conn.reliableReader?.releaseLock();
    } catch { /* ignore */ }
    _maybeFinishClose(conn);
  })();

  // Read unreliable messages from datagrams
  (async () => {
    try {
      while (conn.connected && conn.datagramReader) {
        let result: ReadableStreamReadResult<Uint8Array>;
        try {
          result = await conn.datagramReader.read();
        } catch (error) {
          if (_isTimeoutLikeError(error)) {
            // WebTransport datagram reads can timeout when no moves arrive yet.
            // Keep the connection alive and continue polling.
            await _yieldAfterRead();
            continue;
          }
          throw error;
        }

        const { value, done } = result;
        if (done) {
          // The datagram stream only ends with the session.
          conn.connected = false;
          break;
        }
        if (value === undefined || value.length === 0) {
          // Some runtimes can surface empty datagrams repeatedly.
          // Yield here to avoid microtask spin that starves timers.
          await _yieldAfterRead();
          continue;
        }

        if (value.length > WT_MAX_FRAME_PAYLOAD) {
          if (!conn.oversizedInboundLogged) {
            conn.oversizedInboundLogged = true;
            Sys_Printf(
              "Dropping oversized datagram (%d bytes) from %s\n",
              value.length,
              conn.address,
            );
          }
          continue;
        }

        if (conn.connected) {
          _pushPendingMessage(conn, false, new Uint8Array(value));
          conn.lastMessageTime = Date.now();
        }

        // Yield to macrotask queue after reading so the game loop can run
        await _yieldAfterRead();
      }
    } catch (error) {
      if (conn.connected) {
        Sys_Printf(
          "Datagram reader error for %s: %s\n",
          conn.address,
          String(error),
        );
        conn.connected = false;
      }
    }
    // Release the reader lock when done
    try {
      conn.datagramReader?.releaseLock();
    } catch { /* ignore */ }
  })();
}

/**
 * Read a framed message from the stream
 * Frame format: [length:2][data:N]
 * Returns: Uint8Array or null on EOF. Throws on oversized frames.
 */
const _emptyMessage = new Uint8Array(0);
async function _readFramedMessage(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<Uint8Array | null> {
  // Read header (2 bytes)
  const header = await _readExact(reader, 2);
  if (header === null) {
    return null;
  }

  const length = header[0] | (header[1] << 8);

  if (length === 0) {
    return _emptyMessage;
  }

  if (length > WT_MAX_FRAME_PAYLOAD) {
    throw new Error(
      "oversized reliable frame (" + length + " bytes, max " +
        WT_MAX_FRAME_PAYLOAD + ")",
    );
  }

  // Read message data
  return await _readExact(reader, length);
}

// Buffer for leftover bytes from previous reads (per-reader tracking)
const _readerBuffers = new WeakMap<
  ReadableStreamDefaultReader<Uint8Array>,
  { data: Uint8Array | null; offset: number }
>();

function _getReaderBuffer(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): { data: Uint8Array | null; offset: number } {
  let buf = _readerBuffers.get(reader);
  if (!buf) {
    buf = { data: null, offset: 0 };
    _readerBuffers.set(reader, buf);
  }
  return buf;
}

/**
 * Read exactly n bytes from a reader, with buffering for leftover bytes.
 * Always copies data into a new Uint8Array to avoid holding references to
 * QUIC stream internal buffers (which can cause buffer starvation and
 * event loop freezes in Deno's QUIC stack).
 */
async function _readExact(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  n: number,
): Promise<Uint8Array | null> {
  const buf = _getReaderBuffer(reader);
  const output = new Uint8Array(n);
  let offset = 0;

  // Drain leftover bytes from previous read
  if (buf.data !== null) {
    const available = buf.data.length - buf.offset;
    const bytesToCopy = Math.min(available, n);
    output.set(buf.data.subarray(buf.offset, buf.offset + bytesToCopy), 0);
    offset = bytesToCopy;
    buf.offset += bytesToCopy;

    if (buf.offset >= buf.data.length) {
      buf.data = null;
      buf.offset = 0;
    }
  }

  // Read from stream until we have n bytes
  while (offset < n) {
    let readResult: ReadableStreamReadResult<Uint8Array>;
    try {
      readResult = await reader.read();
    } catch (error) {
      if (_isTimeoutLikeError(error)) {
        await _yieldAfterRead();
        continue;
      }
      throw error;
    }

    const { value, done } = readResult;
    if (done) return null;
    if (value === undefined || value.length === 0) return null;

    const bytesToCopy = Math.min(value.length, n - offset);
    output.set(value.subarray(0, bytesToCopy), offset);
    offset += bytesToCopy;

    // Save leftover bytes for next call
    if (bytesToCopy < value.length) {
      buf.data = value;
      buf.offset = bytesToCopy;
    }
  }

  return output;
}

/**
 * Create a new socket
 * Uses the injected allocator from net_main.js if available (preferred)
 * Otherwise falls back to internal allocation
 */
function _newQSocket(): QSocket | null {
  // If we have an external allocator (from net_main.js), use it
  if (_NET_NewQSocket !== null) {
    const sock = _NET_NewQSocket(pendingConnections.length);
    if (sock !== null) {
      sock.driver = net_driverlevel;
    }
    return sock;
  }

  // Fallback to internal allocation (for standalone testing)
  if (!freeSockets) {
    // Allocate more sockets if needed
    if (numSockets >= 32) return null; // Max sockets

    const sock: QSocket = {
      next: activeSockets,
      connecttime: 0,
      lastMessageTime: 0,
      lastSendTime: 0,
      disconnected: false,
      canSend: true,
      sendNext: false,
      driver: net_driverlevel,
      landriver: 0,
      socket: 0,
      driverdata: null,
      ackSequence: 0,
      sendSequence: 0,
      unreliableSendSequence: 0,
      sendMessageLength: 0,
      sendMessage: new Uint8Array(NET_MAXMESSAGE),
      receiveSequence: 0,
      unreliableReceiveSequence: 0,
      receiveMessageLength: 0,
      receiveMessage: new Uint8Array(NET_MAXMESSAGE),
      addr: null,
      address: "",
      maxdatagram: 0,
    };
    activeSockets = sock;

    numSockets++;
    return sock;
  }

  const sock = freeSockets;
  freeSockets = sock.next;

  // Reset socket state
  sock.next = activeSockets;
  activeSockets = sock;
  sock.disconnected = false;
  sock.canSend = true;
  sock.driverdata = null;
  sock.maxdatagram = 0;

  return sock;
}

/**
 * The transport closed or errored.
 *
 * Per original Quake design (net_main.c):
 * - sock.disconnected is ONLY set by NET_FreeQSocket (after freeing)
 * - We should NOT set it here for sockets assigned to clients
 * - Just set conn.connected = false, which makes WT_QGetMessage return -1
 * - This triggers SV_DropClient -> NET_Close -> WT_Close + NET_FreeQSocket
 *
 * Exception: sockets still in pendingConnections were never assigned to a client,
 * so we must clean them up directly (including setting disconnected and freeing).
 *
 * The handler belongs to one connection. Socket objects are pooled and reused
 * (LIFO), so it only touches the socket while the socket still points at this
 * connection.
 */
function _onTransportClosed(conn: ClientConnection): void {
  conn.dead = true;
  const sock = conn.sock;
  if (sock !== null && sock.driverdata === conn) {
    _handleConnectionDeath(sock, conn);
  } else {
    conn.connected = false;
    _finishClose(conn);
  }
}

function _handleConnectionDeath(sock: QSocket, conn: ClientConnection): void {
  if (sock.driverdata !== conn) {
    return;
  }

  conn.connected = false;
  conn.dead = true;
  conn.reliableWriteQueue.length = 0;
  conn.unreliableQueuedPacket = null;
  conn.outboundDatagramsEnabled = false;
  _updatePendingWriteCounts(conn);
  _wakeReader(conn);

  // Cancel readers to unblock any stuck reader.read() calls in _readExact.
  // Without this, reader loops can spin indefinitely after the transport closes.
  try {
    if (conn.reliableReader) {
      conn.reliableReader.cancel().catch(() => {});
    }
    if (conn.datagramReader) {
      conn.datagramReader.cancel().catch(() => {});
    }
  } catch { /* ignore */ }

  // Check if socket is still in pending queue (never assigned to a client)
  const pendingIdx = pendingConnections.indexOf(sock);
  if (pendingIdx !== -1) {
    // Socket never made it to a client slot - clean up directly
    pendingConnections.splice(pendingIdx, 1);
    _clearPendingAcceptTimer(conn);
    sock.driverdata = null;
    conn.sock = null;

    // Free the socket back to the pool (only for pending sockets)
    if (_NET_FreeQSocket !== null) {
      _NET_FreeQSocket(sock);
    } else {
      WT_FreeQSocket(sock);
    }
    _finishClose(conn);
  }
  // For sockets already assigned to clients:
  // - DON'T set sock.disconnected = true (would skip NET_Close cleanup)
  // - conn.connected = false makes WT_QGetMessage return -1
  // - This triggers SV_DropClient -> NET_Close -> WT_Close + NET_FreeQSocket
}

function _clearPendingAcceptTimer(conn: ClientConnection): void {
  if (conn.pendingAcceptTimer !== null) {
    clearTimeout(conn.pendingAcceptTimer);
    conn.pendingAcceptTimer = null;
  }
}

/**
 * Begin a graceful close: stop delivering messages to the game, flush the
 * queued reliable frames (the disconnect reason), send FIN, and close the
 * transport once the peer has reacted or WT_CLOSE_FLUSH_MS has passed.
 */
function _closeConnection(conn: ClientConnection): void {
  if (conn.closing) return;
  conn.closing = true;
  conn.connected = false;
  _clearPendingAcceptTimer(conn);
  conn.unreliableQueuedPacket = null;
  conn.outboundDatagramsEnabled = false;
  _updatePendingWriteCounts(conn);
  _wakeReader(conn);

  try {
    conn.datagramReader?.cancel().catch(() => {});
  } catch { /* ignore */ }

  if (conn.dead || conn.reliableWriter === null) {
    _finishClose(conn);
    return;
  }

  conn.closeTimer = setTimeout(() => {
    conn.closeTimer = null;
    _finishClose(conn);
  }, WT_CLOSE_FLUSH_MS);

  if (!conn.reliableWriteInFlight) {
    _pumpReliableWrites(conn);
  }
}

function _maybeFinishClose(conn: ClientConnection): void {
  if (
    conn.closing && conn.closeFlushed &&
    (conn.reliableReaderEnded || conn.reliableReader === null || conn.dead)
  ) {
    _finishClose(conn);
  }
}

function _finishClose(conn: ClientConnection): void {
  if (conn.closeFinished) return;
  conn.closeFinished = true;
  conn.connected = false;
  conn.dead = true;
  _clearPendingAcceptTimer(conn);
  if (conn.closeTimer !== null) {
    clearTimeout(conn.closeTimer);
    conn.closeTimer = null;
  }
  conn.reliableWriteQueue.length = 0;
  conn.unreliableQueuedPacket = null;
  _updatePendingWriteCounts(conn);
  _wakeReader(conn);

  try {
    conn.reliableReader?.cancel().catch(() => {});
  } catch { /* ignore */ }
  try {
    conn.datagramReader?.cancel().catch(() => {});
  } catch { /* ignore */ }
  conn.reliableWriter = null;
  conn.datagramWriter = null;

  try {
    conn.webTransport.close();
  } catch { /* ignore */ }

  liveConnections.delete(conn);
  const release = conn.releaseSession;
  conn.releaseSession = null;
  if (release !== null) release();
  Sys_Printf("Connection closed: " + conn.address + "\n");
}

/**
 * Free a socket
 */
export function WT_FreeQSocket(sock: QSocket): void {
  // Remove from active list
  if (sock === activeSockets) {
    activeSockets = sock.next;
  } else {
    let s = activeSockets;
    while (s) {
      if (s.next === sock) {
        s.next = sock.next;
        break;
      }
      s = s.next;
    }
  }

  // Add to free list
  sock.next = freeSockets;
  freeSockets = sock;
  sock.disconnected = true;
}

/**
 * Search for hosts (server doesn't search)
 */
export function WT_SearchForHosts(_xmit: boolean): void {
  // Server doesn't search for other servers
}

/**
 * Connect (server doesn't connect out)
 */
export function WT_Connect(_host: string): null {
  // Server doesn't connect to other servers
  return null;
}

/**
 * Check for new incoming connections
 */
export function WT_CheckNewConnections(): QSocket | null {
  // Filter out any disconnected sockets first
  while (pendingConnections.length > 0) {
    const sock = pendingConnections.shift()!;
    const conn = sock.driverdata;
    if (sock.disconnected) {
      // Socket was already freed
      continue;
    }
    if (conn === null || !conn.connected) {
      // Connection died before we could process it: free the socket here
      Sys_Printf("Skipped disconnected socket in pending queue\n");
      sock.driverdata = null;
      if (conn !== null) {
        conn.sock = null;
        _closeConnection(conn);
      }
      if (_NET_FreeQSocket !== null) {
        _NET_FreeQSocket(sock);
      } else {
        WT_FreeQSocket(sock);
      }
      continue;
    }
    _clearPendingAcceptTimer(conn);
    return sock;
  }
  return null;
}

/**
 * Get a message from a socket
 */
export function WT_QGetMessage(sock: QSocket): number {
  const conn = sock.driverdata;
  if (conn === null) return -1;

  if (!conn.connected && conn.pendingMessages.length === 0) {
    return -1;
  }

  while (conn.pendingMessages.length > 0) {
    // Get next message
    let msg = conn.pendingMessages.shift()!;

    // For unreliable messages, skip to the most recent one.
    // In original Quake, unreliable messages are overwritten by newer ones.
    // Discard stale unreliable messages but preserve any reliable messages.
    if (!msg.reliable) {
      while (conn.pendingMessages.length > 0) {
        const next = conn.pendingMessages[0];
        if (next.reliable) break; // Stop at next reliable message
        conn.pendingMessages.shift();
        msg = next; // Use newer unreliable message
      }
    }

    if (
      conn.readResume != null &&
      conn.pendingMessages.length <= RESUME_PENDING_MESSAGES
    ) {
      _wakeReader(conn);
    }

    const payload = _parseSequencedPacket(sock, msg.data, msg.reliable);
    if (payload === null) {
      continue;
    }

    if (payload.length > net_message.maxsize) {
      if (!msg.reliable) {
        // Unreliable: drop it, the next update supersedes it.
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
      // Reliable: the stream cannot be resynchronised; drop the client.
      Sys_Printf(
        "Oversized reliable message (%d bytes) from %s, disconnecting\n",
        payload.length,
        conn.address,
      );
      conn.connected = false;
      conn.pendingMessages.length = 0;
      return -1;
    }

    // Copy to net_message
    net_message.data.set(payload, 0);
    net_message.cursize = payload.length;

    sock.lastMessageTime = performance.now() / 1000;

    return msg.reliable ? 1 : 2;
  }

  if (conn.connected) {
    return 0;
  }

  return -1;
}

function _updatePendingWriteCounts(conn: ClientConnection): void {
  conn.pendingReliableWrites = conn.reliableWriteQueue.length +
    (conn.reliableWriteInFlight ? 1 : 0);

  if (conn.outboundDatagramsEnabled === false || conn.datagramWriter === null) {
    conn.pendingUnreliableWrites = 0;
    return;
  }

  conn.pendingUnreliableWrites = (conn.unreliableWriteInFlight ? 1 : 0) +
    (conn.unreliableQueuedPacket !== null ? 1 : 0);
}

function _canWriteReliable(conn: ClientConnection): boolean {
  return !conn.dead && conn.reliableWriter !== null &&
    (conn.connected || conn.closing);
}

function _queueReliableFrame(conn: ClientConnection, frame: Uint8Array): void {
  conn.reliableWriteQueue.push(frame);
  _updatePendingWriteCounts(conn);
  _pumpReliableWrites(conn);
}

function _pumpReliableWrites(conn: ClientConnection): void {
  if (!_canWriteReliable(conn) || conn.reliableWriteInFlight) {
    return;
  }

  conn.reliableWriteInFlight = true;
  _updatePendingWriteCounts(conn);

  (async () => {
    while (_canWriteReliable(conn)) {
      const frame = conn.reliableWriteQueue.shift();
      if (frame === undefined) {
        break;
      }

      _updatePendingWriteCounts(conn);

      try {
        await conn.reliableWriter!.write(frame);
      } catch (err) {
        if (!conn.dead) {
          Sys_Printf(
            "WT_QSendMessage: write FAILED: %s\n",
            (err as Error).message,
          );
        }
        conn.connected = false;
        conn.dead = true;
        break;
      }
    }

    conn.reliableWriteInFlight = false;
    _updatePendingWriteCounts(conn);

    if (conn.closing && !conn.closeFinished) {
      if (conn.reliableWriteQueue.length > 0 && _canWriteReliable(conn)) {
        _pumpReliableWrites(conn);
        return;
      }
      // Everything queued has been written: send FIN, then wait for the peer.
      const writer = conn.reliableWriter;
      if (writer !== null && !conn.dead) {
        try {
          await writer.close();
        } catch { /* ignore */ }
      }
      conn.closeFlushed = true;
      _maybeFinishClose(conn);
      return;
    }

    // Covers a race where data was queued between shift() and inFlight=false.
    if (_canWriteReliable(conn) && conn.reliableWriteQueue.length > 0) {
      _pumpReliableWrites(conn);
    }
  })();
}

function _datagramLaneUsable(conn: ClientConnection): boolean {
  if (
    USE_OUTBOUND_DATAGRAMS === false ||
    conn.outboundDatagramsEnabled === false ||
    conn.datagramWriter === null
  ) {
    return false;
  }

  const now = performance.now();
  if (now < conn.datagramCooldownUntil) {
    return false;
  }

  // A write that has not completed for a long time means this client's
  // datagram path is stalled; reroute until it settles.
  if (
    conn.unreliableWriteInFlight &&
    now - conn.unreliableWriteStartedAt > WT_DATAGRAM_STALL_MS
  ) {
    return false;
  }

  return true;
}

function _pumpUnreliableWrites(conn: ClientConnection): void {
  if (
    conn.unreliableWriteInFlight || conn.datagramWriter === null ||
    !conn.connected
  ) {
    return;
  }

  const packet = conn.unreliableQueuedPacket;
  if (packet === null) {
    return;
  }

  conn.unreliableQueuedPacket = null;
  conn.unreliableWriteInFlight = true;
  conn.unreliableWriteStartedAt = performance.now();
  _updatePendingWriteCounts(conn);

  const onDone = (error: unknown) => {
    conn.unreliableWriteInFlight = false;

    if (error !== null && conn.connected) {
      if (_isTimeoutLikeError(error)) {
        // Datagram write timeouts are observed in Deno under load. Send
        // unreliable traffic on the reliable stream for a while, then retry
        // datagrams instead of giving up on them for good.
        conn.datagramCooldownUntil = performance.now() +
          WT_DATAGRAM_COOLDOWN_MS;
        conn.unreliableQueuedPacket = null;
      } else {
        _disableOutboundDatagrams(conn, String(error));
      }
    }

    _updatePendingWriteCounts(conn);

    if (conn.unreliableQueuedPacket !== null && _datagramLaneUsable(conn)) {
      _pumpUnreliableWrites(conn);
    }
  };

  try {
    conn.datagramWriter.write(packet).then(() => onDone(null), onDone);
  } catch (error) {
    onDone(error);
  }
}

/**
 * Send a reliable message.
 */
export function WT_QSendMessage(
  sock: QSocket,
  data: { data: Uint8Array; cursize: number },
): number {
  const conn = sock.driverdata;
  if (!conn || !conn.connected || !conn.reliableWriter) {
    return -1;
  }

  // Backpressure: if too many reliable writes are queued, connection is dead/zombie.
  const pendingReliable = conn.reliableWriteQueue.length +
    (conn.reliableWriteInFlight ? 1 : 0);
  if (pendingReliable >= MAX_PENDING_WRITES_RELIABLE) {
    Sys_Printf(
      "WT_QSendMessage: %d reliable pending writes for %s, disconnecting\n",
      pendingReliable,
      conn.address,
    );
    conn.connected = false;
    return -1;
  }

  const packet = _buildSequencedPacket(sock, data.data, data.cursize);

  // Frame the message: [length:2][data:N]
  const frame = new Uint8Array(2 + packet.length);
  frame[0] = packet.length & 0xff;
  frame[1] = (packet.length >> 8) & 0xff;
  frame.set(packet, 2);

  _queueReliableFrame(conn, frame);

  return 1;
}

// Send unreliable data on the reliable stream, or drop it when the stream is
// already backed up (unreliable data may always be dropped).
function _sendUnreliableOnReliable(
  sock: QSocket,
  conn: ClientConnection,
  data: { data: Uint8Array; cursize: number },
): number {
  if (conn.pendingReliableWrites >= MAX_UNRELIABLE_ON_RELIABLE) {
    return 1;
  }
  return WT_QSendMessage(sock, data);
}

/**
 * Re-read the session's datagram limit and pass it to the engine as
 * sock.maxdatagram (less the transport header), which SV_ClientDatagramSize
 * sizes the client's datagram from. Deno's maxDatagramSize is live: it
 * starts near QUIC's 1200-byte minimum and grows as path MTU discovery
 * probes (on localhost, about 1160 at accept and 1410 half a second later).
 * WT_SendUnreliableMessage checks the same conn.maxDatagramSize, so the two
 * agree within a frame. An unreadable value keeps the last one.
 */
function _refreshMaxDatagramSize(conn: ClientConnection): void {
  const size = conn.datagramStream?.maxDatagramSize;
  if (typeof size === "number" && Number.isFinite(size) && size > 0) {
    conn.maxDatagramSize = size;
  }
  if (conn.sock !== null) {
    conn.sock.maxdatagram = conn.maxDatagramSize > WT_PACKET_HEADER_BYTES
      ? conn.maxDatagramSize - WT_PACKET_HEADER_BYTES
      : 0;
  }
}

/**
 * Send an unreliable message over WebTransport datagrams.
 */
export function WT_SendUnreliableMessage(
  sock: QSocket,
  data: { data: Uint8Array; cursize: number },
): number {
  const conn = sock.driverdata;
  if (!conn || !conn.connected) return -1;

  if (!_datagramLaneUsable(conn)) {
    return _sendUnreliableOnReliable(sock, conn, data);
  }

  if (
    conn.maxDatagramSize > 0 &&
    WT_PACKET_HEADER_BYTES + data.cursize > conn.maxDatagramSize
  ) {
    // Too large for the path MTU: send it on the reliable stream instead of
    // losing it, and say so once per connection.
    if (!conn.oversizedDatagramLogged) {
      conn.oversizedDatagramLogged = true;
      Sys_Printf(
        "WT_SendUnreliableMessage: %d-byte update exceeds max datagram size %d for %s; using reliable stream\n",
        WT_PACKET_HEADER_BYTES + data.cursize,
        conn.maxDatagramSize,
        conn.address,
      );
    }
    return _sendUnreliableOnReliable(sock, conn, data);
  }

  const packet = _buildSequencedPacket(sock, data.data, data.cursize);

  // Only keep the latest unreliable packet while one write is in flight.
  conn.unreliableQueuedPacket = packet;
  _updatePendingWriteCounts(conn);
  _pumpUnreliableWrites(conn);

  return 1;
}

/**
 * Check if we can send a reliable message
 */
export function WT_CanSendMessage(sock: QSocket): boolean {
  const conn = sock.driverdata;
  return conn !== null &&
    conn.connected &&
    conn.reliableWriter !== null &&
    conn.pendingReliableWrites < MAX_PENDING_WRITES_RELIABLE;
}

/**
 * Check if we can send an unreliable message
 */
export function WT_CanSendUnreliableMessage(sock: QSocket): boolean {
  const conn = sock.driverdata;
  if (conn === null || conn.connected === false) {
    return false;
  }

  // SV_SendClientDatagram asks this before it builds the frame's datagram
  _refreshMaxDatagramSize(conn);

  if (!_datagramLaneUsable(conn)) {
    return conn.reliableWriter !== null &&
      conn.pendingReliableWrites < MAX_UNRELIABLE_ON_RELIABLE;
  }

  return !(conn.unreliableWriteInFlight &&
    conn.unreliableQueuedPacket !== null) &&
    conn.pendingUnreliableWrites < MAX_PENDING_WRITES_UNRELIABLE;
}

/**
 * Close a connection. The socket is detached at once (NET_Close frees it
 * straight after); queued reliable frames such as the svc_disconnect or kick
 * reason are still flushed in the background, bounded by WT_CLOSE_FLUSH_MS.
 */
export function WT_Close(sock: QSocket): void {
  const conn = sock.driverdata;
  if (!conn) return;

  sock.driverdata = null;
  conn.sock = null;
  const pendingIdx = pendingConnections.indexOf(sock);
  if (pendingIdx !== -1) {
    pendingConnections.splice(pendingIdx, 1);
  }

  _closeConnection(conn);
}

/**
 * Configure the server
 */
export function WT_SetConfig(config: {
  port?: number;
  certFile?: string;
  keyFile?: string;
  maxSessionsPerIp?: number;
  maxHandshakingSessions?: number;
  handshakeTimeoutMs?: number;
  pendingAcceptTimeoutMs?: number;
  closeFlushMs?: number;
}): void {
  if (config.port) serverPort = config.port;
  if (config.certFile) certFile = config.certFile;
  if (config.keyFile) keyFile = config.keyFile;
  if (config.maxSessionsPerIp && config.maxSessionsPerIp > 0) {
    maxSessionsPerIp = config.maxSessionsPerIp;
  }
  if (config.maxHandshakingSessions && config.maxHandshakingSessions > 0) {
    maxHandshakingSessions = config.maxHandshakingSessions;
  }
  if (config.handshakeTimeoutMs && config.handshakeTimeoutMs > 0) {
    WT_HANDSHAKE_TIMEOUT_MS = config.handshakeTimeoutMs;
  }
  if (config.pendingAcceptTimeoutMs && config.pendingAcceptTimeoutMs > 0) {
    WT_PENDING_ACCEPT_TIMEOUT_MS = config.pendingAcceptTimeoutMs;
  }
  if (config.closeFlushMs && config.closeFlushMs > 0) {
    WT_CLOSE_FLUSH_MS = config.closeFlushMs;
  }
}

/**
 * Set driver level (called by net_main)
 */
export function WT_SetDriverLevel(level: number): void {
  net_driverlevel = level;
}

/**
 * Get the maximum pendingWrites count across all active connections.
 * Used for heartbeat diagnostics to detect write backpressure building up.
 */
export function WT_GetMaxPendingWrites(): number {
  let max = 0;
  for (const conn of liveConnections) {
    const pendingTotal = conn.pendingReliableWrites +
      conn.pendingUnreliableWrites;
    if (pendingTotal > max) {
      max = pendingTotal;
    }
  }
  return max;
}

/**
 * Test hook: run an already-upgraded session through the same path as a
 * real QUIC connection (session limits, handshake, socket allocation).
 * Resolves once the handshake has finished one way or the other.
 */
export function WT_AcceptSessionForTest(
  wt: WebTransportLike,
  address: string,
  ip: string,
): Promise<void> {
  return _handleIncomingSession(() => Promise.resolve(wt), address, ip, () => {
    try {
      wt.close();
    } catch { /* ignore */ }
  });
}

/**
 * Test hook: driver bookkeeping counters.
 */
export function WT_GetSessionStatsForTest(): {
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

/**
 * Export socket type for external use
 */
export type { QSocket as qsocket_t };
