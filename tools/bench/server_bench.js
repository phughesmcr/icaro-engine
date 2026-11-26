// Headless engine benchmark: map load, server physics + QuakeC, and hull
// traces, on the shareware pak0 and the loose maps in static/maps.
//
//   deno run --allow-read tools/bench/server_bench.js [-frames N] [-traces N] [-runs N] [-maps a,b] [-json]
//       [-base rerelease] [-hipnotic | -rogue | -game <dir>] [-dedicated]
//
// -base rerelease mounts static/rerelease/id1 instead of static/ (as
// ?base=rerelease does in the client); -hipnotic, -rogue and -game mount that
// game directory on top, as game_server.js does. The gitignored data must be
// present for these.
//
// Not part of the engine or the test suite. Prints median milliseconds per
// stage so changes can be compared before and after on the same machine.

import {
  COM_AddGameDirectory,
  COM_AddPakSequence,
  COM_EnsureFile,
  COM_SetLooseFileBasePaths,
} from "../../src/pak.js";
import { COM_InitArgv, LOC_Init } from "../../src/common.js";
import { Cbuf_Init, Cmd_Init } from "../../src/cmd.js";
import { Host_InitCommands } from "../../src/host_cmd.js";
import {
  campaign,
  coop,
  deathmatch,
  horde,
  skill,
  sv_cheats,
} from "../../src/host.js";
import { Cvar_RegisterVariable } from "../../src/cvar.js";
import { Memory_Init } from "../../src/zone.js";
import { PR_Init } from "../../src/pr_edict.js";
import {
  SV_ClearDatagram,
  SV_Init,
  SV_SpawnServer,
} from "../../src/sv_main.js";
import { SV_Physics, SV_SetFrametime } from "../../src/sv_phys.js";
import { SV_Move } from "../../src/world.js";
import { sv } from "../../src/server.js";
import { Mod_Init, R_InitTextures } from "../../src/gl_model.js";
import { ca_dedicated, cls } from "../../src/client.js";

const args = Deno.args;
function arg(name, def) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
}

const FRAMES = Number(arg("-frames", "2000"));
const RUNS = Number(arg("-runs", "5"));
const TRACES = Number(arg("-traces", "200000"));
const MAPS = arg("-maps", "start,e1m1,e1m3,e1m6,edc,rapture1").split(",");
const JSON_OUT = args.includes("-json");
// -dedicated sets cls.state = ca_dedicated as game_server.js does: no .lit or
// MD5 replacement loading, so loads measure what the Deno server pays
if (args.includes("-dedicated")) {
  cls.state = ca_dedicated;
}

const root = decodeURIComponent(
  new URL("../../static/", import.meta.url).pathname,
);
const BASE = arg("-base", null);
const basedir = BASE !== null ? root + BASE + "/" : root;
const pak0 = BASE !== null ? basedir + "id1/pak0.pak" : root + "pak0.pak";
const gameFlags = [];
const gameDirs = [];
for (const flag of ["-rogue", "-hipnotic"]) {
  if (args.includes(flag)) {
    gameFlags.push(flag);
    gameDirs.push(basedir + flag.slice(1));
  }
}

const GAME = arg("-game", null);
if (GAME !== null) {
  gameFlags.push("-game", GAME);
  gameDirs.push(basedir + GAME);
}

// Quiet the engine's console output
const realLog = console.log;
globalThis.__ICARO_QUIET_LOGS = true;
console.log = () => {};

COM_InitArgv(["bench", ...gameFlags]);
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

if (await COM_AddPakSequence(pak0) === 0) {
  throw new Error(pak0 + " missing");
}
for (const dir of gameDirs) {
  if (await COM_AddGameDirectory(dir) === 0) {
    throw new Error(dir + "/pak0.pak missing");
  }
}
LOC_Init();
COM_SetLooseFileBasePaths([
  ...gameDirs.toReversed().map((d) => d + "/"),
  ...(BASE !== null ? [basedir + "id1/"] : []),
  root,
]);

function median(a) {
  const s = [...a].sort((x, y) => x - y);
  return s[s.length >> 1];
}

// Deterministic PRNG so trace endpoints are the same every run
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

const results = {};
const start = new Float32Array(3), end = new Float32Array(3);
const mins = new Float32Array([-16, -16, -24]),
  maxs = new Float32Array([16, 16, 32]);
const zero = new Float32Array(3);

for (const map of MAPS) {
  if (await COM_EnsureFile("maps/" + map + ".bsp") !== true) {
    realLog("skip " + map + " (not found)");
    continue;
  }

  const load = [], phys = [], trace = [];
  let checksum = 0;
  for (let run = 0; run < RUNS; run++) {
    deathmatch.value = 0;
    deathmatch.string = "0";
    coop.value = 0;
    coop.string = "0";
    skill.value = 1;
    skill.string = "1";

    // QuakeC random() and SV_NewChaseDir use Math.random: seed it per run
    // so the checksum only changes when behaviour does
    Math.random = mulberry32(42);
    let t = performance.now();
    SV_SpawnServer(map);
    load.push(performance.now() - t);
    if (sv.active !== true) {
      throw new Error("could not spawn " + map);
    }

    SV_SetFrametime(0.1);
    t = performance.now();
    for (let f = 0; f < FRAMES; f++) {
      SV_ClearDatagram();
      SV_Physics();
    }

    phys.push(performance.now() - t);

    // Hull traces between random points inside the world bounds
    const w = sv.worldmodel;
    const rand = mulberry32(1234);
    let hits = 0;
    t = performance.now();
    for (let i = 0; i < TRACES; i++) {
      for (let k = 0; k < 3; k++) {
        const lo = w.mins[k], span = w.maxs[k] - lo;
        start[k] = lo + rand() * span;
        end[k] = lo + rand() * span;
      }

      const tr = SV_Move(
        start,
        (i & 1) !== 0 ? mins : zero,
        (i & 1) !== 0 ? maxs : zero,
        end,
        0,
        sv.edicts[0],
      );
      hits += tr.fraction < 1 ? 1 : 0;
    }

    trace.push(performance.now() - t);
    checksum = hits + sv.num_edicts * 1e6;
  }

  results[map] = {
    load_first_ms: +load[0].toFixed(2),
    load_ms: +median(load).toFixed(2),
    physics_ms: +median(phys).toFixed(2),
    traces_ms: +median(trace).toFixed(2),
    checksum,
  };
}

console.log = realLog;
if (JSON_OUT) {
  console.log(JSON.stringify(results, null, "\t"));
} else {
  console.log(`frames=${FRAMES} traces=${TRACES} runs=${RUNS} (medians, ms)`);
  console.log(
    "map".padEnd(10) + "load1".padStart(10) + "load".padStart(10) +
      "physics".padStart(10) + "traces".padStart(10) + "  checksum",
  );
  for (const [map, r] of Object.entries(results)) {
    console.log(
      map.padEnd(10) + String(r.load_first_ms).padStart(10) +
        String(r.load_ms).padStart(10) + String(r.physics_ms).padStart(10) +
        String(r.traces_ms).padStart(10) + "  " + r.checksum,
    );
  }
}
