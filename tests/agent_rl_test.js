// src/agent.js rl tier over the headless host (through server/agent_mcp.ts),
// on e1m1 from pak0: the layout, the vector's contents, the reward and
// episode ends, and determinism under a seed.

import { mcp_session } from "./agent_mcp_client.js";
import {
  Agent_Entities,
  Agent_Map,
  Agent_RLObserve,
  Agent_RLSpec,
  Agent_RLStep,
  Agent_StateHash,
  Agent_TurnTo,
  RL_CLASSES,
  RL_DEFAULT_TICS,
  RL_MAX_ENTS,
  RL_MAX_RAYS,
  RL_MAX_TICS,
  RL_REWARD,
} from "../src/agent.js";
import { Cbuf_AddText } from "../src/cmd.js";

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

const ARMOR = [688, 480, 80]; // item_armor1, across the bridge
const NOOP = [0, 0, 5, 2, 0, 0, 0, 0];
const FORWARD = [1, 0, 5, 2, 0, 0, 1, 0]; // forward, running

// Offset of a status field
function at(spec, name) {
  return spec.fields.find((f) => f.name === name).offset;
}

Deno.test({
  name: "agent rl: the spec describes the vector, and MCP agrees",
  ...ENGINE_TEST,
  fn: async () => {
    const spec = Agent_RLSpec();
    assert(spec.version === 1, "version " + spec.version);
    const sum = spec.fields.reduce((n, f) => n + f.size, 0);
    assert(sum === spec.size, "fields add up to " + sum + ", not " + spec.size);
    assert(
      spec.low.length === spec.size && spec.high.length === spec.size,
      "bounds are not one per element",
    );
    assert(spec.low.every((v, i) => v < spec.high[i]), "an empty bound");
    for (let i = 1; i < spec.fields.length; i++) {
      const f = spec.fields[i - 1];
      assert(
        spec.fields[i].offset === f.offset + f.size,
        "field " + spec.fields[i].name + " is not after " + f.name,
      );
    }
    assert(
      JSON.stringify(spec.action.nvec) === "[3,3,11,5,2,2,2,9]",
      "nvec " + spec.action.nvec,
    );
    assert(
      JSON.stringify(spec.action.noop) === JSON.stringify(NOOP),
      "noop " + spec.action.noop,
    );
    assert(spec.tics === RL_DEFAULT_TICS, "default tics");
    const big = Agent_RLSpec({ ents: 2, rays: 4, map: 5 });
    assert(
      big.size === spec.fields[0].offset + at(spec, "time") + 1 + 2 * 8 + 4 +
          25,
      "size with ents 2, rays 4, map 5: " + big.size,
    );

    // The MCP schema's limits match the engine's
    const list = await session_list();
    const props = list.find((t) => t.name === "rl_step").inputSchema
      .properties;
    assert(props.ents.maximum === RL_MAX_ENTS, "ents max");
    assert(props.rays.maximum === RL_MAX_RAYS, "rays max");
    assert(props.tics.maximum === RL_MAX_TICS, "tics max");
    assert(
      props.tics.description.includes("(default " + RL_DEFAULT_TICS + ")"),
      "tics default: " + props.tics.description,
    );
    const mspec = JSON.parse(
      (await call("rl_spec", { ents: 2 })).split("\n")[0],
    );
    assert(mspec.size === Agent_RLSpec({ ents: 2 }).size, "rl_spec size");

    for (
      const bad of [{ ents: -1 }, { ents: 65 }, { rays: 1.5 }, { map: 4 }, {
        map: 43,
      }]
    ) {
      let threw = false;
      try {
        Agent_RLSpec(bad);
      } catch {
        threw = true;
      }
      assert(threw, "accepted " + JSON.stringify(bad));
    }
  },
});

async function session_list() {
  if (session === null) session = await mcp_session();
  return (await session.request("tools/list", {})).result.tools;
}

Deno.test({
  name: "agent rl: the vector holds the status, nearest entities, rays and map",
  ...ENGINE_TEST,
  fn: async () => {
    await call("start", { map: "e1m1", skill: 1, seed: 1 });
    const spec = Agent_RLSpec({ map: 21 });
    const o = Agent_RLObserve({ map: 21 }).slice();
    assert(o.length === spec.size, "length " + o.length);
    assert(o[at(spec, "health")] === 100, "health " + o[at(spec, "health")]);
    assert(o[at(spec, "weapon")] === 2, "weapon (shotgun) " + o[2]);
    assert(o[at(spec, "has_shotgun")] === 1, "has the shotgun");
    assert(o[at(spec, "shells")] === 25, "shells");
    assert(Math.round(o[at(spec, "x")]) === 480, "x " + o[at(spec, "x")]);
    assert(o[at(spec, "total_monsters")] > 0, "total monsters");
    for (let i = 0; i < o.length; i++) {
      assert(
        o[i] >= spec.low[i] && o[i] <= spec.high[i],
        "element " + i + " = " + o[i] + " out of bounds",
      );
    }

    // Slot 0 is the nearest entity Agent_Entities lists
    const ents = spec.fields.find((f) => f.name === "ents");
    const e0 = Agent_Entities(1)[0];
    const p = ents.offset;
    assert(o[p] === 1, "slot 0 empty");
    assert(Math.abs(o[p + 5] - e0.dist) <= 1, o[p + 5] + " vs " + e0.dist);
    const fwd = o[p + 2], left = o[p + 3];
    const bearing = Math.atan2(left, fwd) * 180 / Math.PI;
    assert(Math.abs(bearing - e0.yaw) <= 1, bearing + " vs yaw " + e0.yaw);
    assert(RL_CLASSES[o[p + 1]] !== "none", "slot 0 has no class");

    // Rays: within range, and some wall within the start room
    const rays = spec.fields.find((f) => f.name === "rays");
    const r = o.slice(rays.offset, rays.offset + rays.size);
    assert(r.every((d) => d > 0 && d <= rays.range), "rays " + r);
    assert(Math.min(...r) < 256, "no wall near the start: " + r);

    // Map codes are the map tier's glyphs
    const map = spec.fields.find((f) => f.name === "map");
    const m = Agent_Map(21);
    for (let row = 0; row < 21; row++) {
      for (let col = 0; col < 21; col++) {
        const g = m.rows[row][col] ?? " ";
        const code = o[map.offset + row * 21 + col];
        assert(
          spec.map_glyphs[code] === g,
          "cell " + row + "," + col + ": code " + code + ", glyph '" + g + "'",
        );
      }
    }
  },
});

Deno.test({
  name: "agent rl: reading it changes nothing, and steps don't eat events",
  ...ENGINE_TEST,
  fn: async () => {
    await call("start", { map: "e1m1", skill: 1, seed: 1 });
    const h = Agent_StateHash();
    Agent_RLObserve({ map: 21 });
    Agent_RLSpec();
    assert(Agent_StateHash() === h, "an rl read changed the game");

    // No god: walk at the grunt by the bridge until hurt (seed 1)
    await call("goto", { pos: ARMOR, ents: 0, max_tics: 200 });
    let hurt = 0;
    for (let i = 0; i < 200 && hurt === 0; i++) {
      const r = await Agent_RLStep(NOOP, 4);
      if (r.reward < 0) hurt = r.reward;
      assert(r.terminated === false, "died standing: " + r.why);
    }
    assert(hurt < 0, "never hurt");
    const text = await call("observe", { ents: 0 });
    assert(/\nhurt: -\d+ hp/.test(text), "hurt event gone: " + text);
  },
});

Deno.test({
  name: "agent rl: a seed and an action list replay to the same vectors",
  ...ENGINE_TEST,
  fn: async () => {
    const actions = [];
    for (let i = 0; i < 40; i++) {
      actions.push([
        i % 3 === 0 ? 0 : 1,
        i % 5 === 0 ? 1 : 0,
        (i * 7) % 11,
        2,
        i % 4 === 0 ? 1 : 0,
        i % 9 === 0 ? 1 : 0,
        1,
        0,
      ]);
    }
    const run = async () => {
      await call("start", { map: "e1m1", skill: 1, seed: 7 });
      const out = [];
      for (const a of actions) {
        const r = await Agent_RLStep(a, 3);
        out.push(Array.from(r.obs).join(",") + "|" + r.reward + "|" + r.why);
      }
      return out;
    };
    const a = await run();
    const b = await run();
    for (let i = 0; i < a.length; i++) {
      assert(a[i] === b[i], "step " + i + " differs");
    }
    assert(a[0] !== a[a.length - 1], "the actions changed nothing");
  },
});

Deno.test({
  name: "agent rl: truth false hides hp and server-only entities",
  ...ENGINE_TEST,
  fn: async () => {
    await call("start", { map: "e1m1", skill: 1, seed: 1 });
    await call("cmd", { text: "god" });
    await call("goto", { pos: ARMOR, ents: 0 }); // near the grunt and the bridge
    const spec = Agent_RLSpec({ ents: 64 });
    const p = spec.fields.find((f) => f.name === "ents").offset;
    const slots = (truth) => {
      const o = Agent_RLObserve({ ents: 64, truth });
      const s = [];
      for (let j = 0; j < 64; j++) {
        const q = p + j * 8;
        if (o[q] === 1) s.push({ cls: RL_CLASSES[o[q + 1]], hp: o[q + 7] });
      }
      return s;
    };
    const t = slots(true);
    assert(t.some((s) => s.hp > 0), "no monster hp with truth");
    assert(
      t.some((s) => ["door", "button", "exit"].includes(s.cls)),
      "no server-only kinds with truth",
    );
    const f = slots(false);
    assert(f.every((s) => s.hp === -1), "hp without truth");
    assert(
      !f.some((s) =>
        ["door", "button", "lift", "exit", "teleport"].includes(s.cls)
      ),
      "server-only kinds without truth",
    );
  },
});

Deno.test({
  name: "agent rl: a kill is rewarded",
  ...ENGINE_TEST,
  fn: async () => {
    await call("start", { map: "e1m1", skill: 1, seed: 1 });
    await call("cmd", { text: "god" });
    await call("goto", { pos: ARMOR, ents: 0 });
    const m = Agent_Entities(64).find((e) => e.hp !== null && e.dist < 400);
    assert(m !== undefined, "no monster near");
    let total = 0;
    for (let i = 0; i < 100; i++) {
      if (!Agent_Entities(64).some((e) => e.id === m.id && e.hp !== null)) {
        break;
      }
      Agent_TurnTo(m.id);
      const r = await Agent_RLStep([0, 0, 5, 2, 1, 0, 0, 0], 4);
      total += r.reward;
    }
    assert(
      Math.abs(total - RL_REWARD.kill) < 1e-9,
      "reward " + total + " for one kill in god mode",
    );
  },
});

Deno.test({
  name: "agent rl: death, a changelevel and a restart end the episode",
  ...ENGINE_TEST,
  fn: async () => {
    // Seed 1, no god: hurt by the grunt by the bridge, then left with 1 hp
    await call("start", { map: "e1m1", skill: 1, seed: 1 });
    await call("goto", { pos: ARMOR, ents: 0 });
    await call("cmd", { text: "give h 1" });
    await Agent_RLStep(FORWARD, 1); // hold a button: released at the end
    let d = null;
    for (let i = 0; i < 300 && (d === null || !d.terminated); i++) {
      d = await Agent_RLStep(FORWARD, 4);
    }
    assert(d.terminated && d.why === "died", "1 hp: " + d.why);
    assert(
      Math.abs(d.reward - (RL_REWARD.death + RL_REWARD.hurt)) < 1e-9,
      "death reward " + d.reward,
    );
    assert(d.obs[0] <= 0, "health " + d.obs[0]);

    // Dead, attack (pressed after the death animation) respawns: the same
    // map again, unrewarded
    const wait = await Agent_RLStep(NOOP, 144); // up to 1.1 s of falling
    assert(wait.why === "" && wait.obs[25] === 1, "dead and waiting");
    const again = await Agent_RLStep([0, 0, 5, 2, 1, 0, 0, 0], 72);
    assert(again.why === "level restarted", "respawn: " + again.why);
    assert(again.reward === 0, "restart rewarded " + again.reward);
    assert(again.obs[0] === 100, "health after the restart " + again.obs[0]);

    // The kill command restarts the level at once in single player
    Cbuf_AddText("kill\n");
    const k = await Agent_RLStep(NOOP, 8);
    assert(k.why === "level restarted", "kill: " + k.why);

    Cbuf_AddText("changelevel e1m2\n");
    const c = await Agent_RLStep(NOOP, 8);
    assert(c.why === "level changed", "changelevel: " + c.why);
    assert(c.reward === RL_REWARD.exit, "exit reward " + c.reward);

    const w = await Agent_RLStep(NOOP, 2, { reward: { tic: -0.5 } });
    assert(w.reward === -1 && w.why === "", "tic weight: " + w.reward);
  },
});

Deno.test({
  name: "agent rl: bad actions and arguments are errors",
  ...ENGINE_TEST,
  fn: async () => {
    await call("start", { map: "e1m1", skill: 1, seed: 1 });
    for (
      const a of [[0], [3, 0, 0, 0, 0, 0, 0, 0], [0, 0, 11, 0, 0, 0, 0, 0]]
    ) {
      let threw = false;
      try {
        await Agent_RLStep(a, 1);
      } catch (e) {
        threw = e instanceof Error && /^rl: action/.test(e.message);
      }
      assert(threw, "accepted " + JSON.stringify(a));
    }
    for (
      const args of [
        { action: [0, 0, 5] },
        { action: NOOP, tics: RL_MAX_TICS + 1 },
        { action: NOOP, map: 4 },
        { action: NOOP, reward: { kills: 1 } },
      ]
    ) {
      const r = await raw("rl_step", args);
      assert(r.isError === true, JSON.stringify(args) + " ok");
    }
    const ok = JSON.parse(
      (await call("rl_step", { action: NOOP, tics: 1, ents: 1, rays: 0 }))
        .split("\n")[0],
    );
    assert(ok.obs.length === Agent_RLSpec({ ents: 1, rays: 0 }).size, "size");
    assert(ok.terminated === false && ok.tics === 1, JSON.stringify(ok));
  },
});
