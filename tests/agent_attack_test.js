// src/agent.js turn_to and attack over the headless host (through
// server/agent_mcp.ts), on LibreQuake's lq_e1m2. A seeded start makes each run
// the same game: the first goto toward the health pack is stopped by a grunt.

import { mcp_session } from "./agent_mcp_client.js";
import {
  Agent_Entities,
  ATTACK_DEFAULT_TICS,
  ATTACK_MAX_TICS,
} from "../src/agent.js";
import { cl } from "../src/client.js";
import { STAT_SHELLS } from "../src/quakedef.js";
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

const first = (text) => text.split("\n")[0];
// lq_e1m1 starts the player in a train, behind secret doors that open from the
// far side, so the agent's walk graph can't take it anywhere. lq_e1m2 starts
// in the open, with grunts in the first hall.
const ATTACK_MAP = "lq_e1m2";
const HEALTH = [-480, -96, -192]; // item_health, past the grunts

// A seeded game, god mode, walked until a grunt comes into sight
async function meet_monster() {
  await call("start", { map: ATTACK_MAP, skill: 1, seed: 1 });
  await call("cmd", { text: "god" });
  await call("goto", { pos: HEALTH, ents: 0 });
  const m = Agent_Entities(64).find((e) =>
    e.hp !== null && e.visible === true && e.dist < 400
  );
  assert(m !== undefined, "no monster near after the first goto");
  return m;
}

Deno.test({
  name: "agent attack: turn_to faces an entity or a yaw without a tic",
  ...ENGINE_TEST,
  fn: async () => {
    const m = await meet_monster();
    const tic = (t) => t.match(/tic=(\d+)/)[1];
    const before = await call("observe", { ents: 0 });
    const text = await call("turn_to", { id: m.id, ents: 64 });
    assert(first(text).startsWith("turn_to #" + m.id + ": yaw "), text);
    assert(tic(text) === tic(before), "turn_to advanced the game");
    const line = text.split("\n").find((l) => l.startsWith("#" + m.id + " "));
    const yaw = Number(line.match(/ yaw([+-]\d+)/)[1]);
    assert(Math.abs(yaw) <= 1, "still off by " + yaw + ": " + line);
    assert(!/ pitch[+-]/.test(line), "pitch not aimed: " + line);

    const y = await call("turn_to", { yaw: 45, ents: 0 });
    assert(y.includes(" yaw=45 "), y);
  },
});

Deno.test({
  name: "agent attack: shoots a grunt until it is killed",
  ...ENGINE_TEST,
  fn: async () => {
    const m = await meet_monster();
    const shells = cl.stats[STAT_SHELLS];
    // the other two grunts of the hall would stop it as new enemies
    const text = await call("attack", {
      id: m.id,
      ents: 0,
      stop_on_enemy: false,
    });
    assert(first(text).startsWith("attack #" + m.id + ": killed ("), text);
    assert(cl.stats[STAT_SHELLS] < shells, "no shells spent");
    assert(
      !Agent_Entities(64).some((e) => e.id === m.id && e.hp !== null),
      "it is still listed alive",
    );
    // the attack button is let go (the client's stats lag a message)
    await call("step", { tics: 2, ents: 0 });
    const after = cl.stats[STAT_SHELLS];
    await call("step", { tics: 72, ents: 0 });
    assert(cl.stats[STAT_SHELLS] >= after, "still firing after the attack"); // its backpack may land on you
  },
});

Deno.test({
  name: "agent attack: a target out of sight isn't shot at",
  ...ENGINE_TEST,
  fn: async () => {
    await meet_monster();
    const far = Agent_Entities(64).find((e) =>
      e.visible === false && e.hp === null
    );
    assert(far !== undefined, "something hidden from the start");
    const shells = cl.stats[STAT_SHELLS];
    const text = first(
      await call("attack", { id: far.id, ents: 0, stop_on_enemy: false }),
    );
    assert(
      /: out of sight \(36 tics\)$/.test(text),
      text,
    );
    assert(cl.stats[STAT_SHELLS] === shells, "fired at a hidden target");
  },
});

Deno.test({
  name: "agent attack: bad targets are errors, and the schema matches",
  ...ENGINE_TEST,
  fn: async () => {
    await call("start", { map: GD_MAPS.level, skill: 1, seed: 1 });
    for (
      const [name, args] of [
        ["attack", {}],
        ["attack", { id: 9999 }],
        ["attack", { id: 1 }], // yourself
        ["attack", { id: 5, max_tics: ATTACK_MAX_TICS + 1 }],
        ["turn_to", {}],
        ["turn_to", { id: 5, yaw: 10 }],
        ["turn_to", { id: 9999 }],
      ]
    ) {
      const r = await raw(name, args);
      assert(r.isError === true, name + " " + JSON.stringify(args) + " ok");
    }

    const list = await session.request("tools/list", {});
    const props = list.result.tools.find((t) => t.name === "attack")
      .inputSchema.properties;
    assert(props.stop_on_enemy?.type === "boolean", "no stop_on_enemy");
    const schema = props.max_tics;
    assert(schema.maximum === ATTACK_MAX_TICS, "max_tics disagrees");
    assert(
      schema.description.includes("(default " + ATTACK_DEFAULT_TICS + " "),
      "default disagrees: " + schema.description,
    );
  },
});

Deno.test({
  name: "agent attack: out of shells, Quake's switch to the axe swings it",
  ...ENGINE_TEST,
  fn: async () => {
    const m = await meet_monster();
    await call("cmd", { text: "give s 0" });
    const text = await call("attack", { id: m.id, ents: 0 });
    assert(text.includes(" weapon=axe "), text);
    assert(
      /^attack #\d+: (killed|out of reach \(axe only: get within 80 units\)) \(\d+ tics\)$/
        .test(first(text)),
      text,
    );
  },
});
