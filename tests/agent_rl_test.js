// src/agent.js rl tier over the headless host (through server/agent_mcp.ts),
// on LibreQuake (lq_e1m1, and lq_e1m2 where a grunt is needed): the layout,
// the vector's contents, the reward and episode ends, and determinism under a
// seed.

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
import { EDICT_NUM, PR_GetString } from "../src/progs.js";
import { sv } from "../src/server.js";
import { SV_LinkEdict } from "../src/world.js";
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

// lq_e1m1 starts the player in a train, behind secret doors that open from the
// far side, so the agent can't walk it anywhere. The tests that need to meet
// a grunt use lq_e1m2, which starts in the open with grunts in the first hall.
const GRUNT_MAP = "lq_e1m2";
const HEALTH = [-480, -96, -192]; // lq_e1m2's item_health, past the grunts
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
    await call("start", { map: GD_MAPS.level, skill: 1, seed: 1 });
    const spec = Agent_RLSpec({ map: 21 });
    const o = Agent_RLObserve({ map: 21 }).slice();
    assert(o.length === spec.size, "length " + o.length);
    assert(o[at(spec, "health")] === 100, "health " + o[at(spec, "health")]);
    assert(o[at(spec, "weapon")] === 2, "weapon (shotgun) " + o[2]);
    assert(o[at(spec, "has_shotgun")] === 1, "has the shotgun");
    assert(o[at(spec, "shells")] === 25, "shells");
    assert(Math.round(o[at(spec, "x")]) === 968, "x " + o[at(spec, "x")]);
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
    await call("start", { map: GRUNT_MAP, skill: 1, seed: 1 });
    const h = Agent_StateHash();
    Agent_RLObserve({ map: 21 });
    Agent_RLSpec();
    assert(Agent_StateHash() === h, "an rl read changed the game");

    // No god: walk at the grunts of the first hall until hurt (seed 1)
    await call("goto", { pos: HEALTH, ents: 0, max_tics: 200 });
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
      await call("start", { map: GD_MAPS.level, skill: 1, seed: 7 });
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
  name: "agent rl: random play over MCP stays inside the spec's bounds",
  ...ENGINE_TEST,
  fn: async () => {
    // The call sequence a Gymnasium adapter makes (tools/gym/icaro_env.py)
    const layout = { ents: 16, rays: 32, map: 9 };
    const spec = JSON.parse(
      (await call("rl_spec", layout)).split("\n")[0],
    );
    const step = async (action, tics) =>
      JSON.parse(
        (await call("rl_step", { action, tics, ...layout })).split("\n")[0],
      );
    let rng = 12345; // an LCG: the same actions every run
    const pick = (n) => {
      rng = (Math.imul(rng, 1103515245) + 12345) >>> 0;
      return (rng >>> 16) % n;
    };
    const check = (r, i) => {
      assert(r.obs.length === spec.size, "size " + r.obs.length);
      for (let k = 0; k < spec.size; k++) {
        const v = r.obs[k];
        assert(
          v >= spec.low[k] && v <= spec.high[k],
          "step " + i + " obs[" + k + "] = " + v + " outside " +
            spec.low[k] + ".." + spec.high[k],
        );
      }
    };
    for (let seed = 1; seed <= 3; seed++) {
      await call("start", { map: GD_MAPS.level, skill: 2, seed });
      let r = await step(NOOP, 0);
      check(r, 0);
      for (let i = 1; i <= 150 && !r.terminated; i++) {
        r = await step(spec.action.nvec.map((n) => pick(n)), 4);
        check(r, i);
      }
    }
  },
});

Deno.test({
  name: "agent rl: truth false hides hp and server-only entities",
  ...ENGINE_TEST,
  fn: async () => {
    await call("start", { map: GRUNT_MAP, skill: 1, seed: 1 });
    await call("cmd", { text: "god" });
    await call("goto", { pos: HEALTH, ents: 0 }); // near the grunts
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
    await call("start", { map: GRUNT_MAP, skill: 1, seed: 1 });
    await call("cmd", { text: "god" });
    await call("goto", { pos: HEALTH, ents: 0 });
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
    // Seed 1, no god: hurt by a grunt, then left with 1 hp
    await call("start", { map: GRUNT_MAP, skill: 1, seed: 1 });
    await call("goto", { pos: HEALTH, ents: 0 });
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

    // not GD_MAPS.next: that is GRUNT_MAP, the map we are on
    Cbuf_AddText("changelevel " + GD_MAPS.level + "\n");
    const c = await Agent_RLStep(NOOP, 8);
    assert(c.why === "level changed", "changelevel: " + c.why);
    assert(c.reward === RL_REWARD.exit, "exit reward " + c.reward);

    const w = await Agent_RLStep(NOOP, 2, { reward: { tic: -0.5 } });
    assert(w.reward === -1 && w.why === "", "tic weight: " + w.reward);
  },
});

Deno.test({
  name: "agent rl: the level's end is rewarded once, through intermission",
  ...ENGINE_TEST,
  fn: async () => {
    await call("start", { map: GD_MAPS.level, skill: 1, seed: 1 });
    await call("cmd", { text: "god" });
    // Put the player in the exit's trigger (the server's copy)
    let exit = null;
    for (let e = 1; e < sv.num_edicts && exit === null; e++) {
      const ed = EDICT_NUM(e);
      if (
        ed.free !== true &&
        PR_GetString(ed.v.classname) === "trigger_changelevel"
      ) {
        exit = ed;
      }
    }
    assert(exit !== null, "no trigger_changelevel on " + GD_MAPS.level);
    const player = EDICT_NUM(1);
    for (let k = 0; k < 3; k++) {
      player.v.origin[k] = (exit.v.absmin[k] + exit.v.absmax[k]) / 2;
    }
    SV_LinkEdict(player, true);

    const reward = { exit: 3, tic: 0 };
    let d = null;
    for (let i = 0; i < 20 && (d === null || !d.terminated); i++) {
      d = await Agent_RLStep(NOOP, 4, { reward });
    }
    assert(d.why === "level done", "the exit: " + d.why);
    assert(d.reward === 3, "exit weight " + d.reward);
    assert(d.obs[26] === 1, "intermission flag " + d.obs[26]);

    // Stepping on in intermission, and leaving it, isn't paid again
    const on = await Agent_RLStep(NOOP, 72 * 5, { reward });
    assert(on.why === "" && on.reward === 0, "in intermission: " + on.reward);
    const next = await Agent_RLStep([0, 0, 5, 2, 1, 0, 0, 0], 72, { reward });
    assert(next.why === "level changed", "after intermission: " + next.why);
    assert(next.reward === 0, "paid twice: " + next.reward);
  },
});

Deno.test({
  name: "agent rl: bad actions and arguments are errors",
  ...ENGINE_TEST,
  fn: async () => {
    await call("start", { map: GD_MAPS.level, skill: 1, seed: 1 });
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
