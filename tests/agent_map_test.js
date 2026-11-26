// src/agent.js map tier over the headless host (through server/agent_mcp.ts):
// the egocentric ASCII grid on LibreQuake's lq_e1m1 and lq_e1m2. A seeded
// start makes each run the same game.

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
import {
  NAV_NODE_BUTTON,
  NAV_NODE_EXIT,
  NAV_NODE_TELEPORT,
} from "../src/nav.js";
import { YAW } from "../src/quakedef.js";
import { GD_MAPS } from "../server/game_data.js";

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

// lq_e1m1 starts the player in a train, behind secret doors that open from the
// far side, so the agent can't walk it anywhere. The tests that walk to meet
// a grunt use lq_e1m2, which starts in the open with grunts in the first hall,
// and whose walk graph has teleporters and an exit.
const GRUNT_MAP = "lq_e1m2";
const HEALTH = [-480, -96, -192]; // lq_e1m2's item_health, past the grunts
const ARMOR = [608, 1632, 64]; // lq_e1m1's item_armor1, behind a secret door

Deno.test({
  name: "agent map: an n x n grid with you at the centre, off by default",
  ...ENGINE_TEST,
  fn: async () => {
    const plain = await call("start", {
      map: GD_MAPS.level,
      skill: 1,
      seed: 1,
    });
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
    await call("start", { map: GD_MAPS.level, skill: 1, seed: 1 });
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
    await call("start", { map: GD_MAPS.level, skill: 1, seed: 1 });
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
    await call("start", { map: GRUNT_MAP, skill: 1, seed: 1 });
    // walk until a monster is near and in view
    let monster = null;
    for (let i = 0; i < 4 && monster === null; i++) {
      await call("goto", { pos: HEALTH, ents: 0 });
      monster = Agent_Entities(64).find((e) =>
        e.hp !== null && e.visible === true && e.dist < 300 &&
        Math.abs(e.dz) < 100
      ) ?? null;
    }
    assert(monster !== null, "no monster met on the way to the health");

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

// Runs fn as if you stood at the nth walk graph node with this flag, without
// moving the game (the client's copy of your origin is put back). The n-th
// node, or null when there are fewer
function at_node(flag, fn, nth = 0) {
  const g = Agent_NavGraph();
  let k = -1;
  for (let i = 0, seen = 0; i < g.node_count && k === -1; i++) {
    if ((g.node_flags[i] & flag) !== 0 && seen++ === nth) k = i;
  }
  if (k === -1) {
    return null;
  }
  const me = cl_entities[cl.viewentity].origin;
  const saved = [me[0], me[1], me[2]];
  try {
    me[0] = g.node_pos[k * 3];
    me[1] = g.node_pos[k * 3 + 1];
    me[2] = g.node_pos[k * 3 + 2];
    return fn();
  } finally {
    me[0] = saved[0];
    me[1] = saved[1];
    me[2] = saved[2];
  }
}

function map_at_node(flag, truth) {
  const text = at_node(flag, () => Agent_Map(9, truth).rows.join("\n"));
  assert(text !== null, "no node with flag " + flag);
  return text;
}

Deno.test({
  name: "agent map: truth names brush entities; without it they are walls",
  ...ENGINE_TEST,
  fn: async () => {
    await call("start", { map: GD_MAPS.level, skill: 1, seed: 1 });
    // the walk to the armour closet (stopped by its secret door) brings the
    // level's buttons and doors into the client's view
    await call("goto", { pos: ARMOR, ents: 0, stop_on_enemy: false });
    // standing where a func_button is touched (the game is not moved): the
    // first such node that has a button in view
    let checked = false;
    for (let n = 0; n < 200 && checked === false; n++) {
      const done = at_node(NAV_NODE_BUTTON, () => {
        const yaw = cl.viewangles[YAW];
        const truth = map_at(yaw, 21, true).rows.join("\n");
        if (!truth.includes("B")) {
          return false;
        }
        for (let a = 0; a < 360; a += 45) {
          const m = map_at(yaw + a, MAP_MAX_SIZE, false).rows.join("\n");
          assert(!/[EDLBT]/.test(m), "yaw " + (yaw + a) + ":\n" + m);
        }
        return true;
      }, n);
      assert(done !== null, "no button drawn at any button node");
      checked = done;
    }
    assert(checked, "no button drawn at the first 200 button nodes");
  },
});

Deno.test({
  name: "agent map: exits and teleporters are drawn only with truth",
  ...ENGINE_TEST,
  fn: async () => {
    await call("start", { map: GRUNT_MAP, skill: 1, seed: 1 });
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
  name: "agent map: the start platform, a drop beside it, nothing behind",
  ...ENGINE_TEST,
  fn: async () => {
    await call("start", { map: GD_MAPS.level, skill: 1, seed: 1 });
    // you start on a narrow platform above the hall, facing yaw 80
    const m = map_at(90, 21);
    const R = 10;
    const rows = "\n" + m.rows.join("\n");
    assert(cell(m, R + 1, R) === ".", "floor at your feet:" + rows);
    for (let r = R - 5; r < R; r++) {
      assert(cell(m, r, R) === ".", "platform ahead, row " + r + ":" + rows);
      assert(cell(m, r, R - 1) === "-", "a drop beside it, row " + r + rows);
    }
    // the platform ends behind you, with nothing to stand on past it
    assert(cell(m, R + 2, R) === " ", "nothing behind:" + rows);
  },
});
