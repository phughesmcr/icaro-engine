// src/agent.js map tier over the headless host (through server/agent_mcp.ts):
// the egocentric ASCII grid on e1m1 from pak0. A seeded start makes each run
// the same game.

import { mcp_session } from "./agent_mcp_client.js";
import {
  Agent_Entities,
  Agent_Map,
  Agent_StateHash,
  MAP_DEFAULT_SIZE,
  MAP_MAX_SIZE,
} from "../src/agent.js";
import { cl, cl_entities } from "../src/client.js";
import { Agent_NavGraph } from "../src/agent.js";
import { NAV_NODE_EXIT, NAV_NODE_TELEPORT } from "../src/nav.js";
import { YAW } from "../src/quakedef.js";

function assert(cond, message) {
  if (cond !== true) {
    throw new Error(message);
  }
}

// One host per process, kept across tests (see agent_mcp_test.js)
const ENGINE_TEST = { sanitizeResources: false, sanitizeOps: false };

let session = null;
async function raw(name, args) {
  if (session === null) {
    session = await mcp_session();
  }
  return await session.raw(name, args);
}

async function call(name, args = {}) {
  const r = await raw(name, args);
  assert(r.isError !== true, name + " failed: " + r.content[0].text);
  return r.content[0].text;
}

// The map at another yaw, without stepping the game
function map_at(yaw, size, truth = true) {
  const saved = cl.viewangles[YAW];
  try {
    cl.viewangles[YAW] = yaw;
    return Agent_Map(size, truth);
  } finally {
    cl.viewangles[YAW] = saved;
  }
}

const cell = (m, r, c) => m.rows[r][c] ?? " ";

Deno.test({
  name: "agent map: an n x n grid with you at the centre, off by default",
  ...ENGINE_TEST,
  fn: async () => {
    const plain = await call("start", { map: "e1m1", skill: 1, seed: 1 });
    assert(!plain.includes("\nmap "), "no map unless asked:\n" + plain);

    const text = await call("observe", { map: 21, ents: 0 });
    assert(text.includes("\nmap 21x21 32u, ^ you facing up"), text);
    assert(text.split("\n").some((l) => l.includes("^")), text);
    assert(text.includes("#") && text.includes("."), "walls and floor");

    const m = Agent_Map();
    assert(m !== null && m.size === MAP_DEFAULT_SIZE, "default size");
    assert(m.rows.length === m.size, "one row per cell");
    assert(m.rows.every((r) => r.length <= m.size), "rows fit the grid");
    const R = (m.size - 1) / 2;
    assert(cell(m, R, R) === "^", "you are at the centre");

    assert(Agent_Map(4).size === 5, "sizes are odd and at least 5");
    assert(Agent_Map(1000).size === MAP_MAX_SIZE, "capped");

    const list = await session.request("tools/list", {});
    for (const name of ["step", "goto", "turn_to", "attack", "observe"]) {
      const schema = list.result.tools.find((t) => t.name === name)
        .inputSchema.properties.map;
      assert(
        schema.maximum === MAP_MAX_SIZE,
        name + ": the map schema and MAP_MAX_SIZE disagree",
      );
    }
  },
});

Deno.test({
  name: "agent map: observing doesn't change the game",
  ...ENGINE_TEST,
  fn: async () => {
    await call("start", { map: "e1m1", skill: 1, seed: 1 });
    const before = Agent_StateHash();
    Agent_Map(MAP_MAX_SIZE);
    map_at(37, 21);
    assert(Agent_StateHash() === before, "state hash changed");
  },
});

Deno.test({
  name: "agent map: turning left 90 degrees turns the grid right",
  ...ENGINE_TEST,
  fn: async () => {
    await call("start", { map: "e1m1", skill: 1, seed: 1 });
    for (const yaw of [0, 90, 225]) {
      const a = map_at(yaw, 21);
      const b = map_at(yaw + 90, 21);
      const n = a.size, R = (n - 1) / 2;
      let same = 0, total = 0;
      for (let r = 0; r < n; r++) {
        for (let c = 0; c < n; c++) {
          if (r === R && c === R) continue;
          // ahead becomes right: cell (r, c) moves to (c, 2R - r)
          total++;
          if (cell(a, r, c) === cell(b, c, 2 * R - r)) same++;
        }
      }
      // sample points coincide up to rounding, so a few cells may differ
      assert(same >= total - 4, "yaw " + yaw + ": " + same + "/" + total);
    }
  },
});

Deno.test({
  name: "agent map: a monster is drawn where the entity list says it is",
  ...ENGINE_TEST,
  fn: async () => {
    await call("start", { map: "e1m1", skill: 1, seed: 1 });
    // walk until a monster is near and in view
    let monster = null;
    for (let i = 0; i < 4 && monster === null; i++) {
      await call("goto", { pos: [688, 480, 80], ents: 0 });
      monster = Agent_Entities(64).find((e) =>
        e.hp !== null && e.visible === true && e.dist < 300 &&
        Math.abs(e.dz) < 100
      ) ?? null;
    }
    assert(monster !== null, "no monster met on the way to the armour");

    const m = Agent_Map(21);
    const R = (m.size - 1) / 2;
    const flat = Math.sqrt(
      monster.dist * monster.dist - monster.dz * monster.dz,
    );
    const yaw = monster.yaw * Math.PI / 180; // + is to the left
    const r = R - Math.round(flat * Math.cos(yaw) / 32);
    const c = R - Math.round(flat * Math.sin(yaw) / 32);
    let found = false;
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (cell(m, r + dr, c + dc) === "M") found = true;
      }
    }
    assert(
      found,
      "#" + monster.id + " yaw" + monster.yaw + " " + monster.dist +
        "u not near row " + r + " col " + c + ":\n" + m.rows.join("\n"),
    );
  },
});

Deno.test({
  name: "agent map: truth names brush entities; without it they are walls",
  ...ENGINE_TEST,
  fn: async () => {
    await call("start", { map: "e1m1", skill: 1, seed: 1 });
    // the first goto toward the armour stops by the bridge's button
    await call("goto", { pos: [688, 480, 80], ents: 0, stop_on_enemy: false });
    const button = Agent_Entities(64).find((e) => e.kind === "button");
    assert(button !== undefined && button.dist < 300, "a button nearby");
    const yaw = cl.viewangles[YAW];
    const truth = map_at(yaw, 21, true).rows.join("\n");
    assert(truth.includes("B"), "button drawn:\n" + truth);
    for (let a = 0; a < 360; a += 45) {
      const m = map_at(yaw + a, MAP_MAX_SIZE, false).rows.join("\n");
      assert(!/[EDLBT]/.test(m), "yaw " + (yaw + a) + ":\n" + m);
    }
  },
});

// The map as if you stood at a walk graph node with this flag, without
// moving the game (the client's copy of your origin is put back)
function map_at_node(flag, truth) {
  const g = Agent_NavGraph();
  const k = g.node_flags.findIndex((f) => (f & flag) !== 0);
  assert(k !== -1, "no node with flag " + flag);
  const me = cl_entities[cl.viewentity].origin;
  const saved = [me[0], me[1], me[2]];
  try {
    me[0] = g.node_pos[k * 3];
    me[1] = g.node_pos[k * 3 + 1];
    me[2] = g.node_pos[k * 3 + 2];
    return Agent_Map(9, truth).rows.join("\n");
  } finally {
    me[0] = saved[0];
    me[1] = saved[1];
    me[2] = saved[2];
  }
}

Deno.test({
  name: "agent map: exits and teleporters are drawn only with truth",
  ...ENGINE_TEST,
  fn: async () => {
    await call("start", { map: "e1m1", skill: 1, seed: 1 });
    for (
      const [flag, glyph] of [[NAV_NODE_EXIT, "E"], [NAV_NODE_TELEPORT, "T"]]
    ) {
      const truth = map_at_node(flag, true);
      assert(truth.includes(glyph), glyph + " with truth:\n" + truth);
      const blind = map_at_node(flag, false);
      assert(!blind.includes(glyph), glyph + " without truth:\n" + blind);
    }
  },
});

Deno.test({
  name: "agent map: the start room, stairs down ahead, nothing behind the wall",
  ...ENGINE_TEST,
  fn: async () => {
    await call("start", { map: "e1m1", skill: 1, seed: 1 });
    // you start facing yaw 90 at the top of the stairs down to the hall
    const m = map_at(90, 21);
    const R = 10;
    assert(
      cell(m, R + 1, R) === ".",
      "floor at your feet:\n" + m.rows.join("\n"),
    );
    for (let r = R - 10; r <= R - 7; r++) {
      assert(
        cell(m, r, R) === "-",
        "lower floor ahead, row " + r + ":\n" + m.rows.join("\n"),
      );
    }
    // the wall behind you is drawn, and nothing past it
    assert(m.rows[R + 3].includes("#"), "wall behind:\n" + m.rows.join("\n"));
    for (let r = R + 4; r < 21; r++) {
      assert(
        m.rows[r] === "",
        "row " + r + " past the wall:\n" + m.rows.join("\n"),
      );
    }
  },
});
