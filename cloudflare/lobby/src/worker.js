// Lobby Worker for rooms hosted in browsers: routes <prefix>/lobby to one
// Durable Object, which keeps the room table and relays WebRTC signals.
// Only the Workers-only parts are here (the DurableObject base class,
// WebSocketPair, the 101 response); lobby_core.js has the logic, so Deno
// tests can run it. See ../README.md to deploy.

import { DurableObject } from "cloudflare:workers";
import { LobbyCore } from "./lobby_core.js";

export class Lobby extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.core = new LobbyCore(ctx, env);
  }

  async fetch(request) {
    // Set by Cloudflare's edge, so a client can't forge it
    const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
    if (this.core.canAccept(ip) === false) {
      return new Response("Too many sessions\n", { status: 503 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    await this.core.accept(server, ip);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    await this.core.message(ws, message);
  }

  webSocketClose(ws, code, _reason, _wasClean) {
    this.core.closed(ws, code);
  }

  webSocketError(ws, _error) {
    this.core.closed(ws, 1011);
  }

  async alarm() {
    await this.core.alarm();
  }
}

export default {
  fetch(request, env) {
    const url = new URL(request.url);
    if (/\/lobby\/?$/.test(url.pathname) === false) {
      return new Response(
        "Icaro Engine lobby: the WebSocket endpoint is /lobby. Rooms here are hosted in browsers.\n",
        { status: 404 },
      );
    }
    if ((request.headers.get("upgrade") ?? "").toLowerCase() !== "websocket") {
      return new Response("WebSocket only\n", {
        status: 426,
        headers: { upgrade: "websocket" },
      });
    }
    // One lobby for every client: rooms are listed and joined by code
    return env.LOBBY.get(env.LOBBY.idFromName("lobby")).fetch(request);
  },
};
