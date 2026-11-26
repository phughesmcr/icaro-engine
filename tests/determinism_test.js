// Determinism hooks (src/sys.js): Sys_SetRandomSeed makes the server's
// gameplay randomness reproducible, and Sys_SetClockOverride replaces the wall
// clock. A seeded headless e1m1 run must end in the same state every time,
// and a different seed must give a different one.

import { COM_AddPakSequence, COM_SetLooseFileBasePaths } from "../src/pak.js";
import { COM_InitArgv, LOC_Init } from "../src/common.js";
import { Cbuf_Init, Cmd_Init } from "../src/cmd.js";
import { Host_InitCommands } from "../src/host_cmd.js";
import {
  campaign,
  coop,
  deathmatch,
  horde,
  skill,
  sv_cheats,
} from "../src/host.js";
import { Cvar_RegisterVariable } from "../src/cvar.js";
import { Memory_Init } from "../src/zone.js";
import { ED_FindFunction, PR_Init } from "../src/pr_edict.js";
import { PR_ExecuteProgram } from "../src/pr_exec.js";
import { OFS_PARM0, OFS_PARM1, OFS_PARM2, OFS_PARM3 } from "../src/pr_comp.js";
import {
  EDICT_TO_PROG,
  pr_functions,
  pr_globals_float,
  pr_globals_int,
} from "../src/progs.js";
import { SV_ClearDatagram, SV_Init, SV_SpawnServer } from "../src/sv_main.js";
import { SV_Physics, SV_SetFrametime } from "../src/sv_phys.js";
import { FL_MONSTER, sv, svs } from "../src/server.js";
import { Mod_Init, R_InitTextures } from "../src/gl_model.js";
import {
  Sys_DoubleTime,
  Sys_FloatTime,
  Sys_Random,
  Sys_SetClockOverride,
  Sys_SetRandomSeed,
} from "../src/sys.js";

const FRAMES = 300; // 30 seconds of game time at 0.1 s per frame

function assert(cond, message) {
  if (cond !== true) {
    throw new Error(message);
  }
}

let engineReady = null;

// Brings up the server side once, as tools/bench/server_bench.js does
function initEngine() {
  if (engineReady !== null) {
    return engineReady;
  }

  engineReady = (async () => {
    const realLog = console.log;
    globalThis.__ICARO_QUIET_LOGS = true;
    console.log = () => {};
    try {
      COM_InitArgv(["determinism_test"]);
      Memory_Init();
      Cbuf_Init();
      Cmd_Init();
      Host_InitCommands();
      PR_Init();
      Mod_Init();
      R_InitTextures();
      SV_Init();
      Cvar_RegisterVariable(campaign);
      Cvar_RegisterVariable(horde);
      Cvar_RegisterVariable(sv_cheats);

      const root = decodeURIComponent(
        new URL("../static/", import.meta.url).pathname,
      );
      if (await COM_AddPakSequence(root + "pak0.pak") === 0) {
        throw new Error("static/pak0.pak missing");
      }
      LOC_Init();
      COM_SetLooseFileBasePaths([root]);
    } finally {
      console.log = realLog;
    }
  })();
  return engineReady;
}

// Calls a QuakeC function with up to four arguments (edicts or floats)
function callQC(name, ...args) {
  const f = ED_FindFunction(name);
  if (f === null) {
    throw new Error("QuakeC function " + name + " not found");
  }
  const parms = [OFS_PARM0, OFS_PARM1, OFS_PARM2, OFS_PARM3];
  for (let i = 0; i < args.length; i++) {
    if (typeof args[i] === "number") {
      pr_globals_float[parms[i]] = args[i];
    } else {
      pr_globals_int[parms[i]] = EDICT_TO_PROG(args[i]);
    }
  }

  PR_ExecuteProgram(pr_functions.indexOf(f));
}

const fnv = (h, x) => Math.imul(h ^ x, 16777619) >>> 0;
const timeFloat = new Float64Array(1);
const timeBits = new Int32Array(timeFloat.buffer);

// FNV-1a over sv.time, the QuakeC globals and every field of every live
// edict, plus monster origins and health for readable failures
function stateHash() {
  timeFloat[0] = sv.time;
  let h = fnv(fnv(0x811c9dc5, timeBits[0]), timeBits[1]);
  for (let i = 0; i < pr_globals_int.length; i++) {
    h = fnv(h, pr_globals_int[i]);
  }
  const monsters = [];
  for (let e = 0; e < sv.num_edicts; e++) {
    const ent = sv.edicts[e];
    h = fnv(h, ent.free ? 1 : 0);
    if (ent.free) {
      continue;
    }
    const fields = ent._intView;
    for (let i = 0; i < fields.length; i++) {
      h = fnv(h, fields[i]);
    }
    if ((ent.v.flags & FL_MONSTER) !== 0) {
      monsters.push(
        e + ":" + Array.from(ent.v.origin, (x) => x.toFixed(1)).join(",") +
          ":" + ent.v.health,
      );
    }
  }

  return { hash: h, monsters: monsters.join(" ") };
}

// Spawns e1m1 with the given seed, sets two monsters on each other so the AI
// moves (SV_MoveToGoal, SV_NewChaseDir) and fights (QuakeC random()), and
// runs FRAMES server frames. Math.random throws meanwhile, so any gameplay
// randomness that bypasses Sys_Random fails the test.
async function runSeeded(seed) {
  await initEngine();
  const realLog = console.log;
  const realRandom = Math.random;
  const saved = [deathmatch, coop, skill].map((v) => [v, v.value, v.string]);
  console.log = () => {};
  Math.random = () => {
    throw new Error("Math.random called during a seeded server run");
  };

  try {
    deathmatch.value = 0;
    deathmatch.string = "0";
    coop.value = 0;
    coop.string = "0";
    skill.value = 1;
    skill.string = "1";

    Sys_SetRandomSeed(seed);
    const spawns = svs.spawncount;
    SV_SpawnServer("e1m1");
    assert(sv.active === true, "could not spawn e1m1");
    // net_rtclobby.js tells a spawn by it
    assert(svs.spawncount === spawns + 1, "spawncount counts the spawn");

    SV_SetFrametime(0.1);
    // let monsters drop to the floor and start their idle think
    for (let f = 0; f < 10; f++) {
      SV_ClearDatagram();
      SV_Physics();
    }

    const monsters = [];
    for (let e = 1; e < sv.num_edicts; e++) {
      const ent = sv.edicts[e];
      if (
        ent.free !== true && (ent.v.flags & FL_MONSTER) !== 0 &&
        ent.v.health > 0
      ) {
        monsters.push(ent);
      }
    }

    assert(monsters.length >= 2, "e1m1 has fewer than two monsters");
    const fighters = [monsters[0], monsters[1]];
    const startOrigins = fighters.map((ent) => Array.from(ent.v.origin));
    // monster infighting, as QuakeC's T_Damage starts it
    callQC("T_Damage", monsters[0], monsters[1], monsters[1], 1);
    callQC("T_Damage", monsters[1], monsters[0], monsters[0], 1);

    for (let f = 0; f < FRAMES; f++) {
      SV_ClearDatagram();
      SV_Physics();
    }

    const moved = fighters.some((ent, i) =>
      ent.v.origin.some((x, k) => x !== startOrigins[i][k])
    );
    assert(
      moved,
      "neither fighting monster moved, so SV_MoveToGoal was not exercised",
    );

    return stateHash();
  } finally {
    console.log = realLog;
    Math.random = realRandom;
    Sys_SetRandomSeed(null);
    for (const [v, value, string] of saved) {
      v.value = value;
      v.string = string;
    }
  }
}

Deno.test("Sys_Random repeats its sequence for a seed and differs between seeds", () => {
  try {
    const draw = (seed) => {
      Sys_SetRandomSeed(seed);
      const out = [];
      for (let i = 0; i < 64; i++) {
        const r = Sys_Random();
        assert(r >= 0 && r < 1, "Sys_Random out of range: " + r);
        out.push(r);
      }

      return out.join(",");
    };

    assert(draw(1) === draw(1), "seed 1 gave two different sequences");
    assert(draw(1) !== draw(2), "seeds 1 and 2 gave the same sequence");
    assert(draw(0) !== draw(1), "seeds 0 and 1 gave the same sequence");
  } finally {
    Sys_SetRandomSeed(null);
  }
});

Deno.test("Sys_Random uses Math.random until seeded and after Sys_SetRandomSeed( null )", () => {
  const realRandom = Math.random;
  try {
    Math.random = () => 0.25;
    assert(
      Sys_Random() === 0.25,
      "unseeded Sys_Random did not call Math.random",
    );
    Sys_SetRandomSeed(7);
    assert(Sys_Random() !== 0.25, "seeded Sys_Random called Math.random");
    Sys_SetRandomSeed(null);
    assert(
      Sys_Random() === 0.25,
      "Sys_SetRandomSeed( null ) did not restore Math.random",
    );
  } finally {
    Math.random = realRandom;
    Sys_SetRandomSeed(null);
  }
});

Deno.test("Sys_SetClockOverride replaces the wall clock until cleared", () => {
  try {
    let t = 12.5;
    Sys_SetClockOverride(() => t);
    assert(
      Sys_FloatTime() === 12.5 && Sys_DoubleTime() === 12.5,
      "override not used",
    );
    t += 0.1;
    assert(Sys_FloatTime() === t, "override not read on each call");
    Sys_SetClockOverride(null);
    const now = performance.now() / 1000;
    assert(Math.abs(Sys_FloatTime() - now) < 1, "wall clock not restored");
  } finally {
    Sys_SetClockOverride(null);
  }
});

Deno.test("seeded headless e1m1 runs end in the same state, and other seeds do not", async () => {
  const a = await runSeeded(1234);
  const b = await runSeeded(1234);
  assert(
    a.hash === b.hash,
    "same seed, different state:\n" + a.monsters + "\n" + b.monsters,
  );

  const c = await runSeeded(99);
  assert(c.hash !== a.hash, "seeds 1234 and 99 ended in the same state");
  assert(
    c.monsters !== a.monsters,
    "seeds 1234 and 99 left the monsters in the same places and health",
  );
});
