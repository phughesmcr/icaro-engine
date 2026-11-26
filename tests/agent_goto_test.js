// src/agent.js goto over the headless host (through server/agent_mcp.ts):
// the walk graph built at map load, and goto's outcomes on LibreQuake's
// lq_e1m1 (a secret door) and lq_e1m2 (grunts).
// A seeded start makes each run the same game.

import { mcp_session } from "./agent_mcp_client.js";
import {
  Agent_Entities,
  Agent_Goto,
  Agent_NavGraph,
  GOTO_DEFAULT_TICS,
  GOTO_MAX_TICS,
} from "../src/agent.js";
import { NAV_NODE_EXIT } from "../src/nav.js";
import { GD_MAPS } from "../server/game_data.js";

function assert(cond, message) {
  if (cond !== true) {
    throw new Error(message);
  }
}

// One host per process, kept across tests (see agent_mcp_test.js)
const ENGINE_TEST = { sanitizeResources: false, sanitizeOps: false };

// One connection, opened on first use
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
// lq_e1m1's item_armor1 (#190), in a closet behind secret door #191, which
// opens when it is shot. The walk from the start gets there in about 650 tics.
const ARMOR = [608, 1632, 64];
const DOOR = 191;
const ARMOR_ID = 190;

// lq_e1m1 starts the player in a train, behind secret doors that open from the
// far side, so only its closet is reachable. The tests that need grunts use
// lq_e1m2, which starts in the open with three of them in the first hall.
const GRUNT_MAP = "lq_e1m2";
const HEALTH = [-480, -96, -192]; // lq_e1m2's item_health, past the grunts
// Another item_health, farther on: a grunt and the ogre hurt the player on
// the way (seed 1, no god, whether or not it is the process's first game)
const FAR_HEALTH = [344, 312, 272];

async function start(seed, cheats, map = GD_MAPS.level) {
  await call("start", { map, skill: 1, seed });
  if (cheats) {
    await call("cmd", { text: "god" });
    await call("cmd", { text: "notarget" });
  }
}

Deno.test({
  name: "agent goto: a walk graph is built at map load, and again on a new map",
  ...ENGINE_TEST,
  fn: async () => {
    await start(1, false);
    const g = Agent_NavGraph();
    assert(
      g !== null && g.node_flags.length > 1000,
      GD_MAPS.level + " graph: " + (g === null ? null : g.node_flags.length),
    );
    assert(
      g.node_flags.some((f) => (f & NAV_NODE_EXIT) !== 0),
      "the exit is in the graph",
    );

    await call("start", { map: GD_MAPS.next, skill: 1, seed: 1 });
    const g2 = Agent_NavGraph();
    assert(
      g2 !== null && g2 !== g && g2.node_flags.length !== g.node_flags.length,
      GD_MAPS.next + " has its own graph",
    );
  },
});

Deno.test({
  name:
    "agent goto: a closed secret door is blocked and says to shoot it; after it, goto arrives",
  ...ENGINE_TEST,
  fn: async () => {
    await start(1, true);
    const blocked = first(
      await call("goto", { pos: ARMOR, ents: 0, stop_on_enemy: false }),
    );
    assert(
      new RegExp(
        "^goto 608,1632,64: blocked by #" + DOOR +
          " secret_door .*\\(shoot it\\)",
      ).test(blocked),
      blocked,
    );
    // It avoids the door now, until the door moves
    assert(
      Agent_NavGraph().link_cost.some((c) => c >= 1e6),
      "no links avoided",
    );

    // Shoot it: the door slides aside
    const shot = first(
      await call("attack", { id: DOOR, ents: 0, max_tics: 30 }),
    );
    assert(shot.startsWith("attack #" + DOOR + ": "), shot);
    const armor = await call("goto", {
      pos: ARMOR,
      ents: 0,
      stop_on_enemy: false,
    });
    assert(/^goto 608,1632,64: arrived/.test(first(armor)), first(armor));
    assert(
      / armor=100\(green\) /.test(armor),
      "picked up the armor: " + armor.split("\n")[1],
    );
    // The next goto sees the door has moved, and stops avoiding it
    assert(
      /: arrived \(0 tics\)/.test(
        first(
          await call("goto", { pos: ARMOR, ents: 0, stop_on_enemy: false }),
        ),
      ),
      "already there",
    );
    assert(
      Agent_NavGraph().link_cost.every((c) => c < 1e6),
      "the door moved: nothing is avoided",
    );
  },
});

Deno.test({
  name: "agent goto: an item by id arrives when it is picked up",
  ...ENGINE_TEST,
  fn: async () => {
    await start(1, true);
    await call("goto", { pos: ARMOR, ents: 0, stop_on_enemy: false }); // stopped at the door
    await call("attack", { id: DOOR, ents: 0, max_tics: 30 }); // shoot it open
    const t = await call("goto", {
      id: ARMOR_ID,
      ents: 0,
      stop_on_enemy: false,
    });
    assert(
      new RegExp(
        "^goto #" + ARMOR_ID + ": arrived \\(#" + ARMOR_ID + " is gone",
      )
        .test(first(t)),
      first(t),
    );
    assert(
      / armor=100\(green\) /.test(t),
      "picked up the armor: " + t.split("\n")[1],
    );
  },
});

Deno.test({
  name: "agent goto: timeout, no path, damage",
  ...ENGINE_TEST,
  fn: async () => {
    await start(1, false, GRUNT_MAP);
    const slow = first(
      await call("goto", { pos: FAR_HEALTH, max_tics: 10, ents: 0 }),
    );
    assert(/^goto 344,312,272: timeout \(10 tics\)/.test(slow), slow);
    // Seed 1, no god: something shoots on the way
    const hurt = first(
      await call("goto", { pos: FAR_HEALTH, ents: 0, stop_on_enemy: false }),
    );
    assert(/: took damage \(-[0-9]+ hp\), stopped/.test(hurt), hurt);
    const on = first(
      await call("goto", {
        pos: FAR_HEALTH,
        ents: 0,
        max_tics: 144,
        stop_on_damage: false,
        stop_on_enemy: false,
      }),
    );
    assert(
      /: took damage/.test(on) === false,
      "stop_on_damage: false still stopped: " + on,
    );

    // Last: the seeded fight above is the same only while no tics pass first
    const nowhere = first(
      await call("goto", { pos: [99999, 99999, 0], ents: 0 }),
    );
    assert(/: no path/.test(nowhere), nowhere);
  },
});

Deno.test({
  name: "agent goto: a monster coming into sight stops it, once per level",
  ...ENGINE_TEST,
  fn: async () => {
    await start(1, true, GRUNT_MAP);
    const NEW =
      /^goto -480,-96,-192: new enemy #(\d+) grunt \d+u .*hp\d+, stopped/;
    const met = first(await call("goto", { pos: HEALTH, ents: 0 }));
    const m = met.match(NEW);
    assert(m !== null, met);
    const id = Number(m[1]);
    const e = Agent_Entities(64).find((x) => x.id === id);
    assert(e !== undefined && e.visible === true, "#" + id + " not in sight");

    // Announced: the next goto walks on past it
    const next = first(await call("goto", { pos: HEALTH, ents: 0 }));
    assert(!next.includes("new enemy #" + id + " "), next);

    // A new game forgets it
    await start(1, true, GRUNT_MAP);
    const again = first(await call("goto", { pos: HEALTH, ents: 0 }));
    assert(again === met, again + " != " + met);

    // Opted out, the same walk doesn't stop for it
    await start(1, true, GRUNT_MAP);
    const on = first(
      await call("goto", { pos: HEALTH, ents: 0, stop_on_enemy: false }),
    );
    assert(!on.includes("new enemy"), on);

    // A monster that is the goto's own target is never news
    await start(1, true, GRUNT_MAP);
    const to = first(await call("goto", { id, ents: 0, max_tics: 400 }));
    assert(!to.includes("new enemy #" + id + " "), to);
  },
});

Deno.test({
  name: "agent goto: bad targets are errors",
  ...ENGINE_TEST,
  fn: async () => {
    await start(1, false);
    const list = await session.request("tools/list", {});
    const schema = list.result.tools.find((t) =>
      t.name === "goto"
    ).inputSchema.properties.max_tics;
    assert(
      schema.maximum === GOTO_MAX_TICS,
      "the goto schema and GOTO_MAX_TICS disagree",
    );
    assert(
      schema.description.includes("(default " + GOTO_DEFAULT_TICS + " "),
      "the goto schema and GOTO_DEFAULT_TICS disagree: " + schema.description,
    );
    for (
      const args of [{}, { id: ARMOR_ID, pos: ARMOR }, { pos: [1, 2] }, {
        id: 0,
      }, {
        id: 9999,
      }, { pos: ARMOR, max_tics: 0 }]
    ) {
      const r = await raw("goto", args);
      assert(
        r.isError === true,
        JSON.stringify(args) + ": " + r.content[0].text,
      );
    }

    let threw = false;
    try {
      await Agent_Goto("abc");
    } catch (e) {
      threw = e instanceof Error && /goto: target/.test(e.message);
    }

    assert(threw, 'Agent_Goto( "abc" ) throws');
    const typed = first(await Agent_Goto(new Float32Array([99999, 99999, 0])));
    assert(/: no path/.test(typed), "a Float32Array point: " + typed);
  },
});
