// Headless benchmark of the CPU side of world rendering: R_MarkLeaves, the
// BSP walk (R_RecursiveWorldNode) and the PVS-to-batch visibility pass, on
// pak0 maps. No GPU: BatchedMesh is replaced by a stub that counts
// setVisibleAt calls.
//
//   deno run --allow-read tools/bench/world_bench.js [-iters N] [-runs N] [-maps a,b] [-json]
//
// Not part of the engine or the test suite. Prints median microseconds per
// call so changes can be compared before and after on the same machine.

import {
  COM_AddPakSequence,
  COM_EnsureFile,
  COM_SetLooseFileBasePaths,
} from "../../src/pak.js";
import { COM_InitArgv, LOC_Init } from "../../src/common.js";
import { Cbuf_Init, Cmd_Init } from "../../src/cmd.js";
import { Memory_Init } from "../../src/zone.js";
import { Mod_ForName, Mod_Init, R_InitTextures } from "../../src/gl_model.js";
import { cl } from "../../src/client.js";
import { r_origin, r_refdef, vpn, vright, vup } from "../../src/render.js";
import { AngleVectors } from "../../src/mathlib.js";

const args = Deno.args;
function arg(name, def) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
}

const ITERS = Number(arg("-iters", "300"));
const RUNS = Number(arg("-runs", "7"));
const MAPS = arg("-maps", "start,e1m1,e1m3,e1m6,e2m3").split(",");
const JSON_OUT = args.includes("-json");

const root = decodeURIComponent(
  new URL("../../static/", import.meta.url).pathname,
);
const realLog = console.log;
globalThis.__ICARO_QUIET_LOGS = true;
console.log = () => {};

const gl_rsurf = await import("../../src/gl_rsurf.js");
const gl_rmain = await import("../../src/gl_rmain.js");

COM_InitArgv(["bench"]);
Memory_Init();
Cbuf_Init();
Cmd_Init();
Mod_Init();
R_InitTextures();
if (await COM_AddPakSequence(root + "pak0.pak") === 0) {
  throw new Error("pak0.pak missing");
}
LOC_Init();
COM_SetLooseFileBasePaths([root]);

function median(a) {
  const s = [...a].sort((x, y) => x - y);
  return s[s.length >> 1];
}

function time(fn) {
  const t = performance.now();
  for (let i = 0; i < ITERS; i++) fn(i);
  return (performance.now() - t) * 1000 / ITERS;
}

const results = {};
for (const map of MAPS) {
  if (await COM_EnsureFile("maps/" + map + ".bsp") !== true) continue;
  const world = Mod_ForName("maps/" + map + ".bsp", true);
  cl.worldmodel = world;

  // Instances like R_BuildWorldMeshes: one per drawn surface with all its leaves
  const surfaceToLeaves = new Map();
  for (let li = 1; li <= world.numleafs; li++) {
    const leaf = world.leafs[li];
    if (leaf.contents === -2 || !leaf.firstmarksurface) continue;
    for (let j = 0; j < leaf.nummarksurfaces; j++) {
      const s = leaf.firstmarksurface[j];
      let a = surfaceToLeaves.get(s);
      if (a === undefined) surfaceToLeaves.set(s, a = []);
      a.push(leaf);
    }
  }

  let sets = 0;
  const stub = {
    setVisibleAt() {
      sets++;
    },
  };
  const visInfo = [];
  for (const [, leaves] of surfaceToLeaves) {
    visInfo.push({
      batch: stub,
      batchIndex: visInfo.length % 40,
      instanceId: visInfo.length,
      leaves,
    });
  }
  const batches = Array.from({ length: 40 }, () => ({ visible: true }));
  const counts = new Uint32Array(40);

  // Viewpoints: a spread of leaves
  const spots = [];
  const step = Math.max(1, (world.numleafs / 24) | 0);
  for (let li = 1; li <= world.numleafs && spots.length < 24; li += step) {
    if (world.leafs[li].contents !== -2) spots.push(world.leafs[li]);
  }

  // open frustum so the walk is not cut by the (unset) view planes
  // Draw-call estimate: one view per leaf spot and yaw, a 90 degree frustum.
  // water_now: one Mesh per visible water surface; water_groups: one per
  // water texture. sky_now: two per visible sky surface; sky_groups: 2.
  const angles = new Float32Array(3);
  let views = 0, waterNow = 0, waterGroups = 0, skyNow = 0, skyGroups = 0;
  r_refdef.fov_x = 90;
  r_refdef.fov_y = 90;
  for (const leaf of spots) {
    const mm = leaf.minmaxs;
    for (let k = 0; k < 3; k++) {
      r_origin[k] = r_refdef.vieworg[k] = (mm[k] + mm[k + 3]) / 2;
    }
    for (let yaw = 0; yaw < 360; yaw += 90) {
      angles[1] = yaw;
      AngleVectors(angles, vpn, vright, vup);
      gl_rmain.R_SetFrustum();
      gl_rmain.set_r_viewleaf(leaf);
      gl_rmain.set_r_oldviewleaf(null);
      gl_rsurf.R_MarkLeaves();
      gl_rmain.modelorg.set(r_origin);
      gl_rmain.inc_r_framecount();
      gl_rsurf.R_RecursiveWorldNode(world.nodes[0]);
      views++;
      for (let i = 0; i < world.numtextures; i++) {
        const t = world.textures[i];
        if (
          t === null || t === undefined || t.texturechain === null ||
          t.texturechain === undefined
        ) continue;
        let n = 0;
        for (let f = t.texturechain; f; f = f.texturechain) n++;
        if ((t.texturechain.flags & 0x10) !== 0) {
          waterNow += n;
          waterGroups++;
        } else if ((t.texturechain.flags & 4) !== 0) {
          skyNow += 2 * n;
          skyGroups += 2;
        }
        t.texturechain = null;
      }
    }
  }

  const mark = [], walk = [], vis = [];
  for (let run = 0; run < RUNS; run++) {
    mark.push(time((i) => {
      gl_rmain.set_r_viewleaf(spots[i % spots.length]);
      gl_rmain.set_r_oldviewleaf(null);
      gl_rsurf.R_MarkLeaves();
    }));
    gl_rmain.set_r_viewleaf(spots[0]);
    gl_rmain.set_r_oldviewleaf(null);
    gl_rsurf.R_MarkLeaves();
    vis.push(
      time(() =>
        gl_rsurf.R_SetWorldBatchVisibility(
          visInfo,
          batches,
          counts,
          gl_rmain.r_visframecount,
        )
      ),
    );

    walk.push(time(() => {
      gl_rmain.inc_r_framecount();
      gl_rsurf.R_RecursiveWorldNode(world.nodes[0]);
    }));
  }

  let sky = 0, turb = 0;
  for (let i = 0; i < world.numsurfaces; i++) {
    const f = world.surfaces[i].flags;
    if ((f & 4) !== 0) sky++;
    else if ((f & 0x10) !== 0) turb++;
  }

  results[map] = {
    views,
    water_calls_now: +(waterNow / views).toFixed(1),
    water_calls_grouped: +(waterGroups / views).toFixed(1),
    sky_calls_now: +(skyNow / views).toFixed(1),
    sky_calls_grouped: +(skyGroups / views).toFixed(1),
    sky_surfaces: sky,
    turb_surfaces: turb,
    leaves: world.numleafs,
    surfaces: visInfo.length,
    markleaves_us: +median(mark).toFixed(1),
    walk_us: +median(walk).toFixed(1),
    visibility_us: +median(vis).toFixed(1),
  };
}

console.log = realLog;
if (JSON_OUT) console.log(JSON.stringify(results, null, "\t"));
else {
  console.log(`iters=${ITERS} runs=${RUNS} (median us per call)`);
  for (const [m, r] of Object.entries(results)) {
    console.log(m.padEnd(8), JSON.stringify(r));
  }
}
