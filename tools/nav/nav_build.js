// Builds navigation graphs (src/nav.js) for maps in the repository's data
// (server/game_data.js) and prints node and link counts and build times.
//
//   deno run --allow-read tools/nav/nav_build.js [-maps a,b] [-grid 32] [-runs N]
//       [-json out_dir] [-skill 1] [-deathmatch]
//
// -json writes <out_dir>/<map>.nav.json (needs --allow-write). Without
// -maps it builds every maps/*.bsp in the paks (-maps also finds loose ones). "first" is the first build in
// this process (hull flattening and JIT included: what a browser pays at map
// load); "median" is over -runs builds.
//
// Not part of the engine or the test suite.

import {
  COM_AddPakSequence,
  COM_EnsureFile,
  COM_ListFiles,
  COM_SetLooseFileBasePaths,
} from "../../src/pak.js";
import { COM_InitArgv } from "../../src/common.js";
import { Memory_Init } from "../../src/zone.js";
import { Mod_ForName, Mod_Init } from "../../src/gl_model.js";
import { ca_dedicated, cls } from "../../src/client.js";
import {
  Nav_Build,
  Nav_Components,
  NAV_LINK_DOOR,
  NAV_LINK_DROP,
  NAV_LINK_PLAT,
  NAV_LINK_TELEPORT,
  NAV_NODE_EXIT,
} from "../../src/nav.js";
import { GD_ID1_DIR, GD_PAK_PATH } from "../../server/game_data.js";

const args = Deno.args;
function arg(name, def) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
}

const RUNS = Math.max(1, Number(arg("-runs", "1")));
const JSON_DIR = arg("-json", null);
const opts = {
  grid: Number(arg("-grid", "32")),
  skill: Number(arg("-skill", "1")),
  deathmatch: args.includes("-deathmatch"),
};

// Quiet the engine's console output (hull traces' "backup past 0" too)
const realLog = console.log;
globalThis.__ICARO_QUIET_LOGS = true;
console.log = () => {};
console.debug = () => {};

COM_InitArgv(["nav_build"]);
Memory_Init();
Mod_Init();
cls.state = ca_dedicated; // no textures or drawing data
if (await COM_AddPakSequence(GD_PAK_PATH) === 0) {
  throw new Error(GD_PAK_PATH + " missing");
}
COM_SetLooseFileBasePaths([GD_ID1_DIR]);

let maps = arg("-maps", null);
if (maps !== null) {
  maps = maps.split(",");
} else {
  maps = [];
  for (const f of COM_ListFiles("maps", "bsp", 32768)) {
    maps.push(f);
  }
}

function median(a) {
  const s = [...a].sort((x, y) => x - y);
  return s[s.length >> 1];
}

function count_flag(arr, n, flag) {
  let c = 0;
  for (let i = 0; i < n; i++) {
    if ((arr[i] & flag) !== 0) c++;
  }
  return c;
}

function to_json(g) {
  const links = [];
  for (let a = 0; a < g.node_count; a++) {
    for (let l = g.link_start[a]; l < g.link_start[a + 1]; l++) {
      links.push([
        a,
        g.link_to[l],
        g.link_flags[l],
        g.link_ent[l],
        Math.round(g.link_cost[l] * 10) / 10,
      ]);
    }
  }
  const nodes = [];
  for (let i = 0; i < g.node_count; i++) {
    nodes.push([
      g.node_pos[i * 3],
      g.node_pos[i * 3 + 1],
      Math.round(g.node_pos[i * 3 + 2] * 100) / 100,
      g.node_flags[i],
      g.node_ent[i],
    ]);
  }
  const ents = g.ents.map((e) => ({ ...e }));
  return {
    version: 1,
    map: g.name,
    grid: g.grid,
    opts: g.opts,
    nodes,
    links,
    ents,
  };
}

const rows = [];
for (const map of maps) {
  const name = "maps/" + map + ".bsp";
  if (await COM_EnsureFile(name) !== true) {
    realLog("skip " + map + " (not found)");
    continue;
  }

  const t = performance.now();
  const model = Mod_ForName(name, true);
  const load_ms = performance.now() - t;

  const times = [];
  let g = null;
  for (let r = 0; r < RUNS; r++) {
    g = Nav_Build(model, opts);
    times.push(g.build_ms);
  }

  const comp = Nav_Components(g);
  const sizes = new Map();
  for (let i = 0; i < g.node_count; i++) {
    sizes.set(comp[i], (sizes.get(comp[i]) || 0) + 1);
  }
  let biggest = 0;
  for (const s of sizes.values()) if (s > biggest) biggest = s;

  rows.push({
    map,
    load_ms: load_ms.toFixed(1),
    first_ms: times[0].toFixed(1),
    median_ms: median(times).toFixed(1),
    nodes: g.node_count,
    links: g.link_count,
    drop: count_flag(g.link_flags, g.link_count, NAV_LINK_DROP),
    door: count_flag(g.link_flags, g.link_count, NAV_LINK_DOOR),
    plat: count_flag(g.link_flags, g.link_count, NAV_LINK_PLAT),
    tele: count_flag(g.link_flags, g.link_count, NAV_LINK_TELEPORT),
    exit: count_flag(g.node_flags, g.node_count, NAV_NODE_EXIT),
    comps: sizes.size,
    biggest,
    traces: g.traces,
  });

  if (JSON_DIR !== null) {
    await Deno.writeTextFile(
      JSON_DIR + "/" + map + ".nav.json",
      JSON.stringify(to_json(g)),
    );
  }
}

console.log = realLog;
const cols = Object.keys(rows[0]);
console.log(`grid=${opts.grid} runs=${RUNS} (ms)`);
console.log(
  cols.map((c, i) => i === 0 ? c.padEnd(8) : c.padStart(10)).join(""),
);
for (const r of rows) {
  console.log(
    cols.map((c, i) =>
      i === 0 ? String(r[c]).padEnd(8) : String(r[c]).padStart(10)
    ).join(""),
  );
}
