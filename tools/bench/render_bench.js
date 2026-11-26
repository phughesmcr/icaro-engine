// CPU-side benchmark of the client's per-frame render paths: particles, the
// rocket trail, and the 2D overlay draw calls into a stub canvas context.
//
//   deno run --allow-read tools/bench/render_bench.js [-runs N] [-json]
//
// Not part of the engine or the test suite. Prints median microseconds per
// call over several runs, so changes can be compared on the same machine.

globalThis.window = { devicePixelRatio: 1 };
await import("../../src/gl_rsurf.js"); // bootstraps the renderer's import cycle

const THREE = await import("three");
const { cl } = await import("../../src/client.js");
const {
  R_InitParticles,
  R_SetParticleExternals,
  R_ClearParticles,
  R_RocketTrail,
  R_ParticleExplosion,
  R_DrawParticles,
} = await import("../../src/r_part.js");
const draw = await import("../../src/gl_draw.js");

const args = Deno.args;
const RUNS = Number(
  args.includes("-runs") ? args[args.indexOf("-runs") + 1] : 7,
);
const JSON_OUT = args.includes("-json");
const results = {};

function median(a) {
  a = a.slice().sort((x, y) => x - y);
  return a[a.length >> 1];
}

// fn is called iters times per run; reports microseconds per call
function bench(name, iters, fn, setup = null) {
  for (let i = 0; i < Math.min(iters, 200); i++) fn(i);
  const times = [];
  for (let r = 0; r < RUNS; r++) {
    if (setup !== null) setup();
    const t0 = performance.now();
    for (let i = 0; i < iters; i++) fn(i);
    times.push((performance.now() - t0) * 1000 / iters);
  }

  results[name] = median(times);
  if (!JSON_OUT) console.log(name.padEnd(44), results[name].toFixed(3), "us");
}

//------------------------------------------------------------------ particles

const scene = new THREE.Scene();
R_InitParticles();
R_SetParticleExternals({ scene: scene });
const a = new Float32Array([0, 0, 0]);
const b = new Float32Array([300, 0, 0]);
const org = new Float32Array([0, 0, 0]);

cl.time = 10;
cl.oldtime = 9.99;

// the full 16384 pool of long-lived static particles: the walk and the pack
function fillStatic() {
  R_ClearParticles();
  cl.time = 10;
  cl.oldtime = 9.99;
  for (let i = 0; i < 160; i++) R_RocketTrail(a, b, 128 + 3); // tracers: 300 each, die in 0.5 s
  cl.time = 10;
}

// pt_grav particles that live for 2 s (blood): physics, no death
function fillBlood() {
  R_ClearParticles();
  cl.time = 10;
  for (let i = 0; i < 40; i++) R_RocketTrail(a, b, 128 + 2);
}

bench("R_DrawParticles, 12000 blood", 200, () => {
  cl.oldtime = cl.time;
  cl.time += 0.001; // never reach the 2 s lifetime
  R_DrawParticles();
}, fillBlood);

bench("R_DrawParticles, 2000 explosion (mixed)", 200, () => {
  cl.oldtime = cl.time;
  cl.time += 0.0005;
  R_DrawParticles();
}, () => {
  R_ClearParticles();
  cl.time = 10;
  cl.oldtime = 9.99;
  for (let i = 0; i < 2; i++) R_ParticleExplosion(org);
});

bench("R_RocketTrail 300u (alloc + fill 100)", 100, () => {
  R_RocketTrail(a, b, 0);
}, () => {
  R_ClearParticles();
  cl.time = 10;
});

bench("alloc/free churn: trail + draw (4 rockets)", 500, (i) => {
  cl.oldtime = cl.time;
  cl.time += 0.016;
  for (let k = 0; k < 4; k++) R_RocketTrail(a, b, 0);
  R_DrawParticles();
}, () => {
  R_ClearParticles();
  cl.time = 10;
});

//--------------------------------------------------------------------- 2D layer

let calls = 0;
const ctx = new Proxy({}, {
  get(t, k) {
    if (k in t) return t[k];
    return () => {
      calls++;
    };
  },
  set(t, k, v) {
    t[k] = v;
    return true;
  },
});
ctx.drawImage = () => {
  calls++;
};
ctx.fillRect = () => {
  calls++;
};
ctx.createPattern = () => ({ pattern: true });
const fakeCanvas = { width: 1280, height: 960, getContext: () => ctx };
try {
  draw.Draw_Init(fakeCanvas);
} catch { /* no WAD here */ }
// A grey-ramp palette so Draw_Fill takes its palette path
const pal = new Uint8Array(768);
for (let i = 0; i < 768; i++) pal[i] = (i / 3) | 0;
draw.Draw_SetExternals({ host_basepal: pal });
globalThis.__benchCalls = () => calls;

bench("Draw_BeginFrame", 20000, () => draw.Draw_BeginFrame());
bench(
  "Draw_String 40 chars",
  20000,
  () => draw.Draw_String(0, 0, "the quick brown fox jumps over the lazy dog!"),
);
bench(
  "Draw_Fill (palette colour)",
  100000,
  (i) => draw.Draw_Fill(0, 0, 8, 8, i & 255),
);
bench("Draw_TileClear x4 (viewsize < 100)", 50000, () => {
  draw.Draw_TileClear(0, 0, 320, 20);
  draw.Draw_TileClear(0, 220, 320, 20);
  draw.Draw_TileClear(0, 20, 20, 200);
  draw.Draw_TileClear(300, 20, 20, 200);
});

if (JSON_OUT) console.log(JSON.stringify(results));
