// The lobby Worker's gate (cloudflare/lobby/src/gate.js): path, upgrade,
// Origin and the per-IP connection limit, and the TURN minting limit in
// lobby_core.js. The rate-limit bindings are fakes with the binding's
// limit({ key }) -> { success } shape.

import {
  Lobby_Gate,
  Lobby_OriginAllowed,
  Lobby_ParseOrigins,
  Lobby_RateLimitOk,
} from "../cloudflare/lobby/src/gate.js";
import { LobbyCore } from "../cloudflare/lobby/src/lobby_core.js";

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${
        JSON.stringify(actual)
      }`,
    );
  }
}

// A rate-limit binding that allows `limit` calls per key
function fakeLimiter(limit) {
  const counts = new Map();
  return {
    keys: [],
    limit({ key }) {
      this.keys.push(key);
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      return Promise.resolve({ success: n <= limit });
    },
  };
}

function upgrade(headers = {}, path = "/mp/lobby") {
  return new Request("https://quake.example.com" + path, {
    headers: { upgrade: "websocket", ...headers },
  });
}

Deno.test("lobby gate: origins parse to a lowercased list", () => {
  assertEqual(
    JSON.stringify(
      Lobby_ParseOrigins(" https://Quake.Example.com/ ,http://localhost:8137,"),
    ),
    JSON.stringify(["https://quake.example.com", "http://localhost:8137"]),
    "parsed",
  );
  assertEqual(Lobby_ParseOrigins(undefined).length, 0, "unset");
  assertEqual(Lobby_ParseOrigins("").length, 0, "empty");
});

Deno.test("lobby gate: Origin must be listed when a list is set", () => {
  const list = ["https://quake.example.com"];
  assertEqual(
    Lobby_OriginAllowed("https://quake.example.com", list),
    true,
    "listed",
  );
  assertEqual(
    Lobby_OriginAllowed("https://QUAKE.example.com", list),
    true,
    "case",
  );
  assertEqual(
    Lobby_OriginAllowed("https://evil.example", list),
    false,
    "unlisted",
  );
  assertEqual(Lobby_OriginAllowed("null", list), false, "opaque origin");
  assertEqual(Lobby_OriginAllowed(null, list), false, "no Origin header");
  assertEqual(Lobby_OriginAllowed("https://evil.example", []), true, "no list");
  assertEqual(Lobby_OriginAllowed(null, []), true, "no list, no Origin");
});

Deno.test("lobby gate: path, upgrade and Origin answers", async () => {
  const env = { LOBBY_ORIGINS: "https://quake.example.com" };
  assertEqual(
    (await Lobby_Gate(upgrade({}, "/mp/room/ABC"), env)).status,
    404,
    "other paths",
  );
  assertEqual(
    (await Lobby_Gate(new Request("https://quake.example.com/mp/lobby"), env))
      .status,
    426,
    "plain HTTP",
  );
  assertEqual(
    (await Lobby_Gate(upgrade({ origin: "https://evil.example" }), env)).status,
    403,
    "foreign page",
  );
  assertEqual(
    await Lobby_Gate(upgrade({ origin: "https://quake.example.com" }), env),
    null,
    "the game page",
  );
  assertEqual(
    (await Lobby_Gate(upgrade(), env)).status,
    403,
    "no Origin while a list is set",
  );
  assertEqual(await Lobby_Gate(upgrade(), {}), null, "no Origin, no list");
  assertEqual(
    await Lobby_Gate(upgrade({}, "/lobby/"), {}),
    null,
    "workers.dev path, no settings",
  );
});

Deno.test("lobby gate: connections over the per-IP limit get 429", async () => {
  const limiter = fakeLimiter(2);
  const env = { LOBBY_CONNECT_LIMIT: limiter };
  const from = (ip) => upgrade({ "cf-connecting-ip": ip });
  assertEqual(await Lobby_Gate(from("10.0.0.1"), env), null, "first");
  assertEqual(await Lobby_Gate(from("10.0.0.1"), env), null, "second");
  const refused = await Lobby_Gate(from("10.0.0.1"), env);
  assertEqual(refused.status, 429, "third");
  assertEqual(refused.headers.get("retry-after"), "60", "retry-after");
  assertEqual(await Lobby_Gate(from("10.0.0.2"), env), null, "another IP");
  assertEqual(limiter.keys[0], "10.0.0.1", "keyed by IP");
  await Lobby_Gate(upgrade(), env);
  assertEqual(limiter.keys.at(-1), "unknown", "no cf-connecting-ip");

  // A refused Origin never reaches the limiter
  await Lobby_Gate(
    upgrade({ origin: "https://evil.example", "cf-connecting-ip": "10.0.0.3" }),
    { ...env, LOBBY_ORIGINS: "https://quake.example.com" },
  );
  assertEqual(limiter.keys.includes("10.0.0.3"), false, "origin first");
});

Deno.test("lobby gate: a missing or failing binding lets requests through", async () => {
  assertEqual(await Lobby_RateLimitOk(undefined, "k"), true, "unbound");
  assertEqual(
    await Lobby_RateLimitOk(
      { limit: () => Promise.reject(new Error("x")) },
      "k",
    ),
    true,
    "binding error",
  );
  assertEqual(
    await Lobby_RateLimitOk(
      { limit: () => Promise.resolve({ success: false }) },
      "k",
    ),
    false,
    "over the limit",
  );
});

Deno.test("lobby gate: TURN minting over the per-IP limit falls back to STUN", async () => {
  let minted = 0;
  const fetch = () => {
    minted++;
    return Promise.resolve(
      new Response(
        JSON.stringify({
          iceServers: [{ urls: ["turn:turn.example:3478"], username: "u" }],
        }),
        { status: 201 },
      ),
    );
  };
  const limiter = fakeLimiter(1);
  const env = {
    TURN_KEY_ID: "id",
    TURN_KEY_API_TOKEN: "token",
    LOBBY_TURN_LIMIT: limiter,
  };
  const ctx = { getWebSockets: () => [] };
  const core = new LobbyCore(ctx, env, { fetch, now: () => 0 });
  assertEqual((await core.iceServers("10.0.0.1", "host")).length, 1, "first");
  assertEqual(
    (await core.iceServers("10.0.0.1", "joiner")).length,
    0,
    "second: STUN only",
  );
  assertEqual(minted, 1, "nothing minted past the limit");
  assertEqual(limiter.keys[1], "10.0.0.1", "keyed by IP");
  assertEqual(
    (await core.iceServers("10.0.0.2", "joiner")).length,
    1,
    "another IP",
  );
});
