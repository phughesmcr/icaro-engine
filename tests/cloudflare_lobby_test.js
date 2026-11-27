// Tests for the lobby Durable Object's logic (cloudflare/lobby/src/
// lobby_core.js) with a fake ctx: one-request sockets, hosts and joiners
// that stay, waking from hibernation, the alarm, and TURN credentials.

import {
  ALARM_INTERVAL_MS,
  LobbyCore,
  TURN_REFRESH_FRACTION,
  TURN_TTL_SECONDS,
} from "../cloudflare/lobby/src/lobby_core.js";
import {
  LOBBY_CREATE,
  Lobby_DecodeFrame,
  Lobby_EncodeFrame,
  LOBBY_ERROR,
  LOBBY_HEARTBEAT,
  LOBBY_HOST,
  LOBBY_ICE,
  LOBBY_JOIN,
  LOBBY_LIST,
  LOBBY_ROOMS,
  LOBBY_SIGNAL,
  LOBBY_SIGNAL_RELAY,
  RTC_DEFAULT_ICE_SERVERS,
  RTC_LOBBY_LIMITS,
} from "../server/lobby_rtc.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${
        JSON.stringify(actual)
      }`,
    );
  }
}

// A hibernatable WebSocket's server end
class FakeHibernatableSocket {
  constructor() {
    this.sent = [];
    this.closed = null;
    this.attachment = undefined;
  }

  send(bytes) {
    if (this.closed !== null) throw new Error("closed");
    const frame = Lobby_DecodeFrame(new Uint8Array(bytes));
    const text = decoder.decode(frame.data);
    this.sent.push({
      type: frame.type,
      body: frame.type === LOBBY_ERROR ? text : JSON.parse(text),
    });
  }

  close(code, reason) {
    if (this.closed !== null) throw new Error("already closed");
    this.closed = { code, reason };
  }

  serializeAttachment(value) {
    this.attachment = JSON.stringify(value);
  }

  deserializeAttachment() {
    return this.attachment === undefined ? null : JSON.parse(this.attachment);
  }
}

function fakeCtx() {
  const ctx = {
    sockets: [],
    alarm: null,
    acceptWebSocket(ws) {
      ctx.sockets.push(ws);
    },
    getWebSockets() {
      return ctx.sockets.filter((ws) => ws.closed === null);
    },
    storage: {
      getAlarm: () => Promise.resolve(ctx.alarm),
      setAlarm: (ms) => {
        ctx.alarm = ms;
        return Promise.resolve();
      },
    },
  };
  return ctx;
}

function frame(type, value) {
  const data = value === undefined ?
    new Uint8Array(0) :
    typeof value === "string" ?
    encoder.encode(value) :
    encoder.encode(JSON.stringify(value));
  return Lobby_EncodeFrame(type, data).buffer;
}

async function connect(core, ip) {
  const ws = new FakeHibernatableSocket();
  await core.accept(ws, ip);
  return ws;
}

Deno.test("Cloudflare lobby: LIST and CREATE are one request per socket", async () => {
  const ctx = fakeCtx();
  const clock = { t: 1000 };
  const core = new LobbyCore(ctx, {}, { now: () => clock.t });

  const hostWs = await connect(core, "10.0.0.1");
  await core.message(
    hostWs,
    frame(LOBBY_HOST, { public: true, hostName: "Pub" }),
  );
  assertEqual(
    ctx.alarm,
    1000 + ALARM_INTERVAL_MS,
    "alarm set while sockets are open",
  );

  const old = await connect(core, "10.0.0.2");
  await core.message(old, frame(LOBBY_LIST));
  assertEqual(
    JSON.stringify(old.sent[0].body),
    "[]",
    "an empty LIST gets no browser-hosted rooms",
  );
  assertEqual(old.closed.code, 1000, "closed after the reply");

  const lister = await connect(core, "10.0.0.2");
  await core.message(lister, frame(LOBBY_LIST, { rtc: true }));
  assertEqual(lister.sent[0].body.length, 1, "public room listed");
  assertEqual(lister.sent[0].body[0].hostName, "Pub", "its record");

  const creator = await connect(core, "10.0.0.2");
  await core.message(creator, frame(LOBBY_CREATE, {}));
  assertEqual(creator.sent[0].type, LOBBY_ERROR, "CREATE refused");
  assertEqual(creator.closed.code, 1000, "closed");

  const joiner = await connect(core, "10.0.0.2");
  await core.message(joiner, frame(LOBBY_JOIN, "ABC123"));
  assertEqual(
    joiner.sent[0].body,
    "Room not found. The game may have ended.",
    "a Deno room code",
  );

  const garbage = await connect(core, "10.0.0.2");
  await core.message(garbage, "text");
  assertEqual(garbage.closed.code, 1002, "text frames are malformed");

  assertEqual(hostWs.closed, null, "the host stays");
  assertEqual(core.lobby.sessions.size, 1, "only the host left");
});

Deno.test("Cloudflare lobby: host, join and relay survive hibernation", async () => {
  const ctx = fakeCtx();
  const clock = { t: 0 };
  const first = new LobbyCore(ctx, {}, { now: () => clock.t });

  const hostWs = await connect(first, "10.0.0.1");
  await first.message(hostWs, frame(LOBBY_HOST, { maxPlayers: 4 }));
  const room = hostWs.sent[0].body;
  assertEqual(hostWs.sent[1].type, LOBBY_ICE, "ICE servers");
  assertEqual(
    JSON.stringify(hostWs.sent[1].body),
    JSON.stringify(RTC_DEFAULT_ICE_SERVERS),
    "STUN without TURN secrets",
  );

  const joinWs = await connect(first, "10.0.0.2");
  await first.message(joinWs, frame(LOBBY_JOIN, room.id));
  assertEqual(joinWs.sent[0].type, LOBBY_ROOMS, "joined");
  assertEqual(joinWs.closed, null, "joiner stays");

  // Hibernation: a new object over the same sockets
  const second = new LobbyCore(ctx, {}, { now: () => clock.t });
  await second.message(
    joinWs,
    frame(LOBBY_SIGNAL, {
      to: room.id,
      kind: "offer",
      data: { type: "offer", sdp: "v=0" },
    }),
  );
  const offer = hostWs.sent[2];
  assertEqual(offer.type, LOBBY_SIGNAL_RELAY, "offer relayed after waking");
  await second.message(
    hostWs,
    frame(LOBBY_SIGNAL, {
      to: offer.body.from,
      kind: "answer",
      data: { type: "answer", sdp: "v=0" },
    }),
  );
  assertEqual(joinWs.sent[2].type, LOBBY_SIGNAL_RELAY, "answer relayed");
  assertEqual(joinWs.sent[2].body.from, room.id, "from the room");

  // The host's socket closes: its room goes
  second.closed(hostWs, 1006);
  assertEqual(hostWs.closed.code, 1000, "closed with a sendable code");
  assertEqual(second.lobby.hasRoom(room.id), false, "room gone");
});

Deno.test("Cloudflare lobby: the alarm drops silent hosts and stops once no socket is open", async () => {
  const ctx = fakeCtx();
  const clock = { t: 0 };
  const core = new LobbyCore(ctx, {}, { now: () => clock.t });
  const live = await connect(core, "10.0.0.1");
  await core.message(live, frame(LOBBY_HOST, {}));
  const silent = await connect(core, "10.0.0.2");
  await core.message(silent, frame(LOBBY_HOST, {}));

  clock.t = RTC_LOBBY_LIMITS.heartbeatTimeoutMs - 1000;
  await core.message(live, frame(LOBBY_HEARTBEAT, { players: 2 }));
  clock.t = RTC_LOBBY_LIMITS.heartbeatTimeoutMs + 1;
  await core.alarm();
  assertEqual(silent.closed.code, 1000, "silent host closed");
  assertEqual(live.closed, null, "live host kept");
  assertEqual(ctx.alarm, clock.t + ALARM_INTERVAL_MS, "next alarm");

  core.closed(live, 1000);
  ctx.alarm = null;
  await core.alarm();
  assertEqual(ctx.alarm, null, "no alarm with no sockets");
});

Deno.test("Cloudflare lobby: TURN credentials from the TURN key, filtered; STUN when minting fails", async () => {
  const requests = [];
  const env = { TURN_KEY_ID: "key id", TURN_KEY_API_TOKEN: "token" };
  const fetch = (url, init) => {
    requests.push({ url, init });
    return Promise.resolve(
      new Response(
        JSON.stringify({
          iceServers: [
            {
              urls: [
                "stun:stun.cloudflare.com:3478",
                "stun:stun.cloudflare.com:53",
              ],
            },
            {
              urls: [
                "turn:turn.cloudflare.com:3478?transport=udp",
                "turn:turn.cloudflare.com:53?transport=udp",
              ],
              username: "u",
              credential: "c",
            },
          ],
        }),
        { status: 201 },
      ),
    );
  };
  const core = new LobbyCore(fakeCtx(), env, { fetch, now: () => 0 });
  const bare = await connect(core, "10.0.0.1");
  await core.message(bare, frame(LOBBY_LIST));
  assertEqual(requests.length, 0, "nothing minted for a LIST");

  const hostWs = await connect(core, "10.0.0.1");
  await core.message(hostWs, frame(LOBBY_HOST, {}));
  assertEqual(requests.length, 1, "minted for the host");
  assertEqual(
    requests[0].url,
    "https://rtc.live.cloudflare.com/v1/turn/keys/key%20id/credentials/generate-ice-servers",
    "endpoint",
  );
  assertEqual(requests[0].init.method, "POST", "method");
  assertEqual(requests[0].init.headers.authorization, "Bearer token", "token");
  assertEqual(JSON.parse(requests[0].init.body).ttl, TURN_TTL_SECONDS, "ttl");
  const servers = hostWs.sent[1].body;
  assertEqual(
    JSON.stringify(servers.map((s) => s.urls)),
    JSON.stringify([["stun:stun.cloudflare.com:3478"], [
      "turn:turn.cloudflare.com:3478?transport=udp",
    ]]),
    "port 53 dropped",
  );
  assertEqual(servers[1].credential, "c", "credential passed on");

  const down = new LobbyCore(fakeCtx(), env, {
    fetch: () => Promise.resolve(new Response("no", { status: 500 })),
    now: () => 0,
  });
  const ws = await connect(down, "10.0.0.1");
  await down.message(ws, frame(LOBBY_HOST, {}));
  assertEqual(
    JSON.stringify(ws.sent[1].body),
    JSON.stringify(RTC_DEFAULT_ICE_SERVERS),
    "STUN on failure",
  );
});

Deno.test("Cloudflare lobby: a host's TURN credentials last 3 hours and are refreshed over its socket", async () => {
  assertEqual(TURN_TTL_SECONDS, 3 * 3600, "3 hours by default");
  const bodies = [];
  let n = 0;
  const fetch = (_url, init) => {
    bodies.push(JSON.parse(init.body));
    n++;
    return Promise.resolve(
      new Response(
        JSON.stringify({
          iceServers: [{
            urls: ["turn:turn.cloudflare.com:3478?transport=udp"],
            username: "u" + n,
            credential: "c",
          }],
        }),
        { status: 201 },
      ),
    );
  };
  const clock = { t: 0 };
  const env = {
    TURN_KEY_ID: "id",
    TURN_KEY_API_TOKEN: "token",
    TURN_TTL_SECONDS: "1200",
  };
  const ctx = fakeCtx();
  const core = new LobbyCore(ctx, env, { fetch, now: () => clock.t });
  const hostWs = await connect(core, "10.0.0.1");
  await core.message(hostWs, frame(LOBBY_HOST, {}));
  assertEqual(bodies[0].ttl, 1200, "TURN_TTL_SECONDS overrides");
  assertEqual(hostWs.sent[1].body[0].username, "u1", "first credentials");

  // Waking from hibernation keeps the time they were minted
  const woken = new LobbyCore(ctx, env, { fetch, now: () => clock.t });
  const refreshAt = 1200 * 1000 * TURN_REFRESH_FRACTION;
  clock.t = refreshAt - 1;
  await woken.message(hostWs, frame(LOBBY_HEARTBEAT, { players: 1 }));
  assertEqual(hostWs.sent.length, 2, "nothing before the refresh time");
  clock.t = refreshAt;
  await woken.message(hostWs, frame(LOBBY_HEARTBEAT, { players: 1 }));
  assertEqual(hostWs.sent.length, 3, "one frame");
  assertEqual(hostWs.sent[2].type, LOBBY_ICE, "LOBBY_ICE");
  assertEqual(hostWs.sent[2].body[0].username, "u2", "fresh credentials");
  assertEqual(bodies.length, 2, "minted once more");

  // No TURN key: no refresh, and nothing minted
  const plain = new LobbyCore(fakeCtx(), {}, { fetch, now: () => clock.t });
  const ws = await connect(plain, "10.0.0.2");
  await plain.message(ws, frame(LOBBY_HOST, {}));
  clock.t += 100 * 3600 * 1000;
  await plain.message(ws, frame(LOBBY_HEARTBEAT, {}));
  assertEqual(ws.sent.length, 2, "STUN host: no refresh");
  assertEqual(bodies.length, 2, "nothing minted without a key");
});

Deno.test("Cloudflare lobby: with TURNSTILE_SITEKEY, LOBBY_HOST needs a token checked at Siteverify", async () => {
  const env = {
    TURNSTILE_SITEKEY: "sitekey",
    TURNSTILE_SECRET: "secret",
    TURNSTILE_HOSTNAMES: "anglezarke.games",
  };
  const siteverify = [];
  const fetch = (url, init) => {
    const body = new URLSearchParams(init.body);
    siteverify.push({
      url,
      secret: body.get("secret"),
      token: body.get("response"),
      ip: body.get("remoteip"),
    });
    const ok = body.get("response") === "good";
    return Promise.resolve(
      new Response(JSON.stringify(
        ok ?
          {
            success: true,
            action: "create_room",
            hostname: "anglezarke.games",
          } :
          { success: false },
      )),
    );
  };
  const core = new LobbyCore(fakeCtx(), env, { fetch, now: () => 0 });

  const asked = await connect(core, "10.0.0.1");
  await core.message(asked, frame(LOBBY_HOST, {}));
  assertEqual(asked.sent[0].type, 0x86, "LOBBY_VERIFY");
  assertEqual(
    JSON.stringify(asked.sent[0].body),
    '{"sitekey":"sitekey","action":"create_room"}',
    "challenge",
  );
  assertEqual(asked.closed.code, 1000, "one request per socket until it hosts");

  const refused = await connect(core, "10.0.0.1");
  await core.message(refused, frame(LOBBY_HOST, { turnstile: "bad" }));
  assertEqual(
    refused.sent[0].body,
    "Verification failed. Try again.",
    "refused",
  );

  const hostWs = await connect(core, "10.0.0.1");
  await core.message(hostWs, frame(LOBBY_HOST, { turnstile: "good" }));
  assertEqual(hostWs.sent[0].type, LOBBY_ROOMS, "hosted");
  assertEqual(hostWs.closed, null, "the host stays");
  assertEqual(siteverify.length, 2, "Siteverify asked for each token");
  assertEqual(siteverify[1].secret, "secret", "the secret from env");
  assertEqual(siteverify[1].ip, "10.0.0.1", "client IP");

  // Without the sitekey the check is off
  const off = new LobbyCore(fakeCtx(), {}, { fetch, now: () => 0 });
  const plain = await connect(off, "10.0.0.1");
  await off.message(plain, frame(LOBBY_HOST, {}));
  assertEqual(plain.sent[0].type, LOBBY_ROOMS, "hosted without a token");
});

Deno.test("Cloudflare lobby: sockets per IP are capped", () => {
  const core = new LobbyCore(fakeCtx(), {}, { now: () => 0 });
  for (let i = 0; i < RTC_LOBBY_LIMITS.maxSessionsPerIp; i++) {
    core.lobby.open("s" + i, "10.0.0.1", 0);
  }
  assertEqual(core.canAccept("10.0.0.1"), false, "capped");
  assertEqual(core.canAccept("10.0.0.2"), true, "other IPs");
});

Deno.test("Cloudflare lobby: LIST and CREATE on a host's socket are refused and rate limited", async () => {
  const core = new LobbyCore(fakeCtx(), {}, { now: () => 0 });
  const hostWs = await connect(core, "10.0.0.1");
  await core.message(hostWs, frame(LOBBY_HOST, { public: true }));
  await core.message(hostWs, frame(LOBBY_LIST, { rtc: true }));
  assertEqual(
    hostWs.sent[2].body,
    "Not available on this connection",
    "LIST refused",
  );
  await core.message(hostWs, frame(LOBBY_CREATE, {}));
  assertEqual(
    hostWs.sent[3].body,
    "Not available on this connection",
    "CREATE refused",
  );
  for (let i = 0; i < RTC_LOBBY_LIMITS.messagesPerSessionPerWindow; i++) {
    await core.message(hostWs, frame(LOBBY_LIST));
  }
  assertEqual(
    hostWs.sent.length,
    RTC_LOBBY_LIMITS.messagesPerSessionPerWindow + 2,
    "replies stop at the limit",
  );
  assertEqual(hostWs.closed, null, "the host stays");
});
