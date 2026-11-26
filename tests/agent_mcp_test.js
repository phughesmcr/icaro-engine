// server/agent_mcp.ts: the MCP server over the headless host, through the
// official SDK's stdio entry (tests/agent_mcp_client.js). Checks both
// protocol eras, the tool schemas, that calls run one at a time, and that a
// seeded game replayed from an action log ends in the same state
// (Agent_StateHash), even against the process's first game.

import { Sys_FloatTime, Sys_Random } from "../src/sys.js";
import {
  mcp_connect,
  mcp_session,
  MODERN_META,
  MODERN_VERSION,
} from "./agent_mcp_client.js";

function assert(cond, message) {
  if (cond !== true) {
    throw new Error(message);
  }
}

const TOOL_NAMES = [
  "start",
  "step",
  "goto",
  "turn_to",
  "attack",
  "observe",
  "rl_spec",
  "rl_step",
  "cmd",
  "key",
  "menu",
  "screenshot",
];

// agent.js keeps a MessageChannel open for its yields, and the host runs
// once per process, so the engine tests share it and skip the sanitizers
const ENGINE_TEST = { sanitizeResources: false, sanitizeOps: false };

// One connection for the engine tests, opened on first use
let session = null;
async function call(name, args = {}) {
  if (session === null) {
    session = await mcp_session();
  }
  return await session.call(name, args);
}

async function raw(name, args) {
  if (session === null) {
    session = await mcp_session();
  }
  return await session.raw(name, args);
}

function footer(text) {
  const m = /\ntic=([0-9]+) hash=([0-9a-f]{8})$/.exec(text);
  assert(m !== null, "no tic/hash footer in: " + text);
  return { tic: Number(m[1]), hash: m[2] };
}

Deno.test("agent_mcp: initialize negotiates the protocol version", async () => {
  const c = mcp_connect();
  try {
    const r = await c.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "t", version: "1" },
    });
    assert(
      r.result.protocolVersion === "2025-06-18",
      "a supported version is echoed: " + JSON.stringify(r),
    );
    assert(r.result.capabilities.tools !== undefined, "tools capability");
    assert(r.result.serverInfo.name === "icaro-engine", "server info");
    assert(
      typeof r.result.instructions === "string" &&
        r.result.instructions.includes("goto"),
      "instructions",
    );

    const old = await c.request("initialize", {
      protocolVersion: "2000-01-01",
      capabilities: {},
      clientInfo: { name: "t", version: "1" },
    });
    assert(
      /^2025-/.test(old.result.protocolVersion),
      "an unknown version gets a supported one: " + JSON.stringify(old),
    );
  } finally {
    await c.close();
  }
});

Deno.test("agent_mcp: serves 2026-07-28 clients from the same tools", async () => {
  const c = mcp_connect();
  try {
    const newer = await c.request("server/discover", {
      _meta: {
        ...MODERN_META,
        "io.modelcontextprotocol/protocolVersion": "2099-01-01",
      },
    });
    assert(
      newer.error !== undefined && newer.error.code === -32022,
      "unsupported version error: " + JSON.stringify(newer),
    );
    assert(
      newer.error.data.supported.includes(MODERN_VERSION),
      "the error lists the supported versions",
    );

    const d = await c.request("server/discover", { _meta: MODERN_META });
    assert(
      d.result !== undefined &&
        d.result.supportedVersions.includes(MODERN_VERSION),
      "discover: " + JSON.stringify(d),
    );
    assert(d.result.instructions.includes("goto"), "instructions");
    const list = await c.request("tools/list", { _meta: MODERN_META });
    const names = list.result.tools.map((t) => t.name);
    assert(
      JSON.stringify(names) === JSON.stringify(TOOL_NAMES),
      "tools: " + names,
    );
    // Checked against the schema before the engine is touched
    const bad = await c.request("tools/call", {
      name: "step",
      arguments: { tics: -1 },
      _meta: MODERN_META,
    });
    assert(bad.result.isError === true, "bad argument: " + JSON.stringify(bad));
  } finally {
    await c.close();
  }
});

Deno.test("agent_mcp: lists tools, ignores notifications, rejects unknown methods", async () => {
  const c = mcp_connect();
  try {
    const list = await c.request("tools/list", {}, "a");
    assert(list.id === "a", "string ids are echoed");
    const names = list.result.tools.map((t) => t.name);
    assert(
      JSON.stringify(names) === JSON.stringify(TOOL_NAMES),
      "tools: " + names,
    );
    for (const t of list.result.tools) {
      assert(
        t.inputSchema.type === "object" && typeof t.description === "string",
        t.name + " schema",
      );
      assert(
        t.inputSchema.additionalProperties === false,
        t.name + " takes unknown arguments",
      );
    }

    const go = list.result.tools.find((t) =>
      t.name === "goto"
    ).inputSchema.properties;
    assert(
      go.pos.type === "array" && go.pos.minItems === 3 && go.pos.maxItems === 3,
      "goto pos: " + JSON.stringify(go.pos),
    );
    assert(
      list.result.tools.find((t) => t.name === "observe").annotations
        .readOnlyHint === true,
      "observe is read-only",
    );

    c.notify("notifications/initialized");
    const ping = await c.request("ping", {});
    assert(JSON.stringify(ping.result) === "{}", "ping");
    const bad = await c.request("resources/list", {});
    assert(bad.error.code === -32601, "method not found");
    const unknown = await c.request("tools/call", { name: "fly" });
    assert(
      unknown.error !== undefined || unknown.result.isError === true,
      "unknown tool: " + JSON.stringify(unknown),
    );
    const extra = await c.request("tools/call", {
      name: "cmd",
      arguments: { text: "echo", loud: true },
    });
    assert(extra.result.isError === true, "an unknown argument is an error");
    assert(
      c.unmatched.length === 0,
      "replies without a request: " + JSON.stringify(c.unmatched),
    );
  } finally {
    await c.close();
  }
});

Deno.test("agent_mcp: stdio framing, one JSON reply per line", async () => {
  const c = mcp_connect();
  try {
    // Junk lines get no reply and don't end the connection
    c.write("not json\n\n");
    // A message split mid-line, as a pipe may
    const msg = '{"jsonrpc":"2.0","id":41,"method":"ping"}\n';
    const reply = c.request("ping", {}, 42);
    c.write(msg.slice(0, 17));
    await new Promise((r) => setTimeout(r, 10));
    c.write(msg.slice(17));
    assert((await reply).result !== undefined, "ping 42");
    await new Promise((r) => setTimeout(r, 10));
    assert(
      c.unmatched.length === 1 && c.unmatched[0].id === 41 &&
        c.unmatched[0].result !== undefined,
      "split ping: " + JSON.stringify(c.unmatched),
    );
  } finally {
    await c.close();
  }
});

Deno.test({
  name: "agent_mcp: calls run one at a time, in order",
  ...ENGINE_TEST,
  fn: async () => {
    await call("start", { map: "e1m1", skill: 1 });
    await call("step", { tics: 50, ents: 0 });
    // Sent together: observe must wait for the new game. start does work
    // outside src/agent.js's own queue (the map check, the disconnect).
    const [started, seen] = await Promise.all([
      call("start", { map: "e1m1", skill: 1 }),
      call("observe", { ents: 0 }),
    ]);
    assert(
      footer(seen).tic === footer(started).tic,
      "observe ran during start: " + footer(started).tic + " vs " +
        footer(seen).tic,
    );
    const [stepped, after] = await Promise.all([
      call("step", { tics: 30, ents: 0 }),
      call("observe", { ents: 0 }),
    ]);
    assert(
      footer(after).tic === footer(stepped).tic,
      "observe ran during the step",
    );
  },
});

Deno.test({
  name: "agent_mcp: bad tool arguments come back as tool errors",
  ...ENGINE_TEST,
  fn: async () => {
    const bad = [
      ["start", { map: "e1m1;quit" }],
      ["start", { seed: 1.5 }],
      ["start", { map: "nope" }],
      ["start", { skill: 4 }],
      ["cmd", {}],
      ["step", { tics: "many" }],
      ["step", { tics: 99999 }],
      ["step", { impulse: 0 }],
    ];
    for (const [name, args] of bad) {
      const r = await raw(name, args);
      assert(
        r.isError === true,
        name + " " + JSON.stringify(args) + ": " + JSON.stringify(r),
      );
    }
  },
});

Deno.test({
  name: "agent_mcp: a missing map fails at once and keeps the game",
  ...ENGINE_TEST,
  fn: async () => {
    const before = footer(await call("start", { map: "e1m1", skill: 1 }));
    const t0 = performance.now();
    const r = await raw("start", { map: "e1m9x" });
    assert(
      r.isError === true && r.content[0].text.includes("no map"),
      JSON.stringify(r),
    );
    assert(
      performance.now() - t0 < 1000,
      "took " + Math.round(performance.now() - t0) + " ms",
    );
    const after = await call("observe", { ents: 0 });
    assert(after.startsWith("e1m1 "), "the game ended: " + after);
    assert(footer(after).tic === before.tic, "tics ran");
  },
});

// Moves, turns, switches weapon, fires, jumps, walks a path: player physics,
// QuakeC weapon code, goto and (with the noise) the monsters' reactions. It starts with
// buttons held from the game before, which start must release.
const ACTION_LOG = [
  ["cmd", { text: "god" }], // the goto meets grunts; stay alive for the weapon check
  ["goto", { pos: [688, 480, 80], max_tics: 200 }],
  ["step", { buttons: "forward", tics: 72 }],
  ["step", { yaw: 90, tics: 1 }],
  ["step", { buttons: "forward,moveleft", tics: 36 }],
  ["step", { impulse: 1, tics: 10 }],
  ["step", { impulse: 2, buttons: "attack", tics: 40 }],
  ["step", { yaw: -135, buttons: "forward,jump", tics: 60 }],
  ["cmd", { text: "give h 10" }],
  ["step", { buttons: "attack", tics: 72 }],
  ["step", { tics: 144 }],
  ["cmd", { text: "impulse 1" }],
  ["step", { tics: 10 }],
];

async function playLog(seed) {
  // Leave buttons held in whatever game is running
  await call("step", { buttons: "moveright,attack", hold: true, tics: 0 });
  const start = footer(await call("start", { map: "e1m1", skill: 1, seed }));
  let last = "";
  for (const [name, args] of ACTION_LOG) {
    last = await call(name, args);
  }
  return { start, end: footer(last), text: last };
}

Deno.test({
  name: "agent_mcp: a seeded action log replays to the same state hash",
  ...ENGINE_TEST,
  fn: async () => {
    // The process's first game, then a restart: the strict case, since the
    // first load also fills the model and sound caches
    const a = await playLog(1234);
    const b = await playLog(1234);
    assert(
      a.start.tic === b.start.tic && a.start.hash === b.start.hash,
      "after start: " + JSON.stringify(a.start) + " vs " +
        JSON.stringify(b.start),
    );
    assert(a.end.tic === b.end.tic, "tics " + a.end.tic + " vs " + b.end.tic);
    assert(
      a.end.hash === b.end.hash,
      "replay diverged:\n" + a.text + "\n---\n" + b.text,
    );
    assert(
      a.end.tic > a.start.tic + 400,
      "the log ran " + (a.end.tic - a.start.tic) + " tics",
    );
    // The axe arrives as weapon 0 (a byte): Agent_Weapon names it
    assert(
      / weapon=axe /.test(a.text),
      "weapon after impulse 1: " + a.text.split("\n")[0],
    );

    // A different seed is a different game (monsters' first thinks are random)
    const c = await playLog(99);
    assert(c.start.hash !== a.start.hash, "seed 99 matches seed 1234 at start");
    assert(c.end.hash !== a.end.hash, "seed 99 matches seed 1234 at the end");

    // Unseeded: both hooks are off again
    await call("start", { map: "e1m1", skill: 1 });
    // The virtual clock only moves with tics; the wall clock moves while we wait
    const c0 = Sys_FloatTime();
    await new Promise((r) => setTimeout(r, 20));
    assert(Sys_FloatTime() - c0 > 0.01, "the virtual clock is still on");
    const realRandom = Math.random;
    Math.random = () => 0.125;
    try {
      assert(Sys_Random() === 0.125, "Sys_Random is still seeded");
    } finally {
      Math.random = realRandom;
    }
  },
});
