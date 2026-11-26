// Cold model-load benchmark: Mod_ForName on brush/alias/sprite models from the
// repository's data (server/game_data.js),
// forcing a reload each run.
//
//   deno run --allow-read tools/bench/load_bench.js [-runs N]

import {
  COM_AddPakSequence,
  COM_EnsureFile,
  COM_SetLooseFileBasePaths,
} from "../../src/pak.js";
import { COM_InitArgv } from "../../src/common.js";
import { Cbuf_Init, Cmd_Init } from "../../src/cmd.js";
import { Memory_Init } from "../../src/zone.js";
import {
  Mod_FindName,
  Mod_ForName,
  Mod_Init,
  R_InitTextures,
} from "../../src/gl_model.js";
import {
  GD_BENCH_MAPS,
  GD_ID1_DIR,
  GD_PAK_PATH,
} from "../../server/game_data.js";

const args = Deno.args;
const i = args.indexOf("-runs");
const RUNS = i >= 0 ? Number(args[i + 1]) : 15;
const root = decodeURIComponent(
  new URL("../../static/", import.meta.url).pathname,
);
const realLog = console.log;
globalThis.__ICARO_QUIET_LOGS = true;
console.log = () => {};
COM_InitArgv(["bench"]);
Memory_Init();
Cbuf_Init();
Cmd_Init();
Mod_Init();
R_InitTextures();
await COM_AddPakSequence(GD_PAK_PATH);
COM_SetLooseFileBasePaths([...(GD_ID1_DIR !== root ? [GD_ID1_DIR] : []), root]);

const names = [
  ...GD_BENCH_MAPS.load,
  "progs/player.mdl",
  "progs/soldier.mdl",
  "progs/ogre.mdl",
  "progs/s_light.spr",
];
const out = {};
for (const n of names) {
  if (await COM_EnsureFile(n) !== true) continue;
  const t = [];
  for (let r = 0; r < RUNS; r++) {
    const mod = Mod_FindName(n);
    mod.needload = true;
    if (mod.cache !== undefined && mod.cache !== null) mod.cache.data = null;
    const t0 = performance.now();
    Mod_ForName(n, true);
    t.push(performance.now() - t0);
  }

  const first = t[0];
  t.sort((a, b) => a - b);
  out[n] = {
    first_ms: +first.toFixed(2),
    median_ms: +t[t.length >> 1].toFixed(2),
  };
}

console.log = realLog;
for (const [k, v] of Object.entries(out)) {
  console.log(k.padEnd(22), "median", v.median_ms, "first", v.first_ms);
}
