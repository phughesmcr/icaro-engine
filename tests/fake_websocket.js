// In-memory WebSocket pair for driver tests (src/net_websocket.js,
// server/net_websocket_server.ts, server/lobby_server.js).
//
// Messages are delivered after a small delay, in order. send() copies the
// bytes at call time, as browsers and Deno do. close() on either end closes
// both after the messages already in flight, like a WebSocket closing
// handshake. bufferedAmount is a plain field tests may set.

const DEFAULT_DELAY_MS = 1;

export const CONNECTING = 0;
export const OPEN = 1;
export const CLOSING = 2;
export const CLOSED = 3;

export class FakeWebSocket {
  constructor(url = "", delayMs = DEFAULT_DELAY_MS) {
    this.url = url;
    this.delayMs = delayMs;
    this.readyState = CONNECTING;
    this.bufferedAmount = 0;
    this.binaryType = "blob";
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    this.peer = null;
    this.sent = []; // every message passed to send(), as copies
    this.closeCalls = []; // codes passed to close()
  }

  // Server side of a pair: open at once, as an upgraded socket is.
  // Client side: open after a delay, then fire onopen.
  open() {
    setTimeout(() => {
      if (this.readyState !== CONNECTING) return;
      this.readyState = OPEN;
      if (this.onopen !== null) this.onopen({ type: "open" });
    }, this.delayMs);
  }

  send(data) {
    if (this.readyState !== OPEN) throw new Error("WebSocket is not open");

    let copy;
    if (typeof data === "string") {
      copy = data;
      this.sent.push(data);
    } else {
      const view = data instanceof ArrayBuffer ?
        new Uint8Array(data) :
        new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      const bytes = view.slice();
      this.sent.push(bytes);
      copy = bytes.buffer;
    }

    const peer = this.peer;
    if (peer === null) return;
    setTimeout(() => {
      if (peer.readyState !== OPEN) return;
      if (peer.onmessage !== null) peer.onmessage({ data: copy });
    }, this.delayMs);
  }

  close(code = 1000, reason = "") {
    this.closeCalls.push(code);
    if (this.readyState === CLOSING || this.readyState === CLOSED) return;
    this.readyState = CLOSING;
    const peer = this.peer;
    setTimeout(() => {
      this._closed(code, reason);
      if (peer !== null) peer._closed(code, reason);
    }, this.delayMs);
  }

  // The connection failed or dropped without a closing handshake.
  fail() {
    setTimeout(() => {
      if (this.readyState === CLOSED) return;
      if (this.onerror !== null) this.onerror({ type: "error" });
      this._closed(1006, "");
      if (this.peer !== null) this.peer._closed(1006, "");
    }, this.delayMs);
  }

  _closed(code, reason) {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    if (this.onclose !== null) this.onclose({ code, reason });
  }
}

/**
 * Two linked sockets. The server end is open; the client end opens after a
 * delay (call pair.client.open(), or let the test's WebSocket stub do it).
 */
export function createFakeWebSocketPair(url = "", delayMs = DEFAULT_DELAY_MS) {
  const client = new FakeWebSocket(url, delayMs);
  const server = new FakeWebSocket(url, delayMs);
  client.peer = server;
  server.peer = client;
  server.readyState = OPEN;
  return { client, server };
}

// [channel][magic][sequence][ack][payload], the game message format
export function gameMessage(channel, sequence, acknowledged, payload) {
  const out = new Uint8Array(10 + payload.length);
  const view = new DataView(out.buffer);
  out[0] = channel;
  out[1] = 0x71;
  view.setUint32(2, sequence >>> 0, true);
  view.setUint32(6, acknowledged >>> 0, true);
  out.set(payload, 10);
  return out;
}

export function messageSequence(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .getUint32(2, true) | 0;
}

export function messageAck(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .getUint32(6, true) | 0;
}
