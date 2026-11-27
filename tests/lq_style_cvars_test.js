// Ironwail's r_scale, r_softemu, r_showtris and r_showbboxes, which
// LibreQuake's style_ironwail_*.cfg and dev.cfg set (see gl_softemu.js,
// gl_rdebug.js and vid.js VID_SetScaleDivisor).

// Bootstrap the renderer's existing circular module graph in its safe order.
await import("../src/gl_rsurf.js");

const gl_rmisc = await import("../src/gl_rmisc.js");
const common = await import("../src/common.js");
const cmd = await import("../src/cmd.js");
const consolejs = await import("../src/console.js");
const { Cvar_FindVar, Cvar_Set } = await import("../src/cvar.js");
const vid = await import("../src/vid.js");
const { R_ScaleDivisor, r_scale, VID_DynResFrame, vid_dynres } = await import(
  "../src/vid_dynres.js"
);
const softemu = await import("../src/gl_softemu.js");
const { R_BBoxColor, R_ShowTrisMode } = await import("../src/gl_rdebug.js");
const { R_GammaCorrect, R_PostprocessOwnsBlend } = await import(
  "../src/gl_gamma.js"
);
const { v_contrast, v_gamma } = await import("../src/view.js");
const { gl_polyblend, r_framecount, set_r_framecount, v_blend } = await import(
  "../src/glquake.js"
);
const { mod_alias, mod_brush, mod_sprite } = await import(
  "../src/mod_types.js"
);

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

function near(a, b) {
  return Math.abs(a - b) < 1e-9;
}

Deno.test("R_Init registers Ironwail's names, defaults and archive flags", () => {
  gl_rmisc.R_Init();
  for (
    const [name, value, archive] of [
      ["r_scale", "1", true],
      ["r_softemu", "0", true],
      ["r_softemu_metric", "-1", true],
      ["r_showtris", "0", undefined],
      ["r_showbboxes", "0", undefined],
    ]
  ) {
    const cvar = Cvar_FindVar(name);
    if (cvar === null) throw new Error(name + " not registered");
    assertEqual(cvar.default_string, value, name + " default");
    assertEqual(cvar.archive, archive, name + " archive");
  }
});

Deno.test("LibreQuake's style and dev cvars are known commands", () => {
  gl_rmisc.R_Init();
  cmd.Cbuf_Init();
  cmd.Cmd_Init();
  const printed = [];
  common.Con_SetPrintFunctions(
    (fmt, ...args) =>
      printed.push(
        args.length === 0 ? String(fmt) : consolejs._sprintf(fmt, ...args),
      ),
    () => {},
  );
  const names = [
    "r_softemu",
    "r_scale",
    "r_showbboxes",
    "r_showtris",
  ];
  const old = names.map((n) => Cvar_FindVar(n).string);
  try {
    cmd.Cbuf_AddText(
      "r_softemu 3\nr_scale 4\ntoggle r_showbboxes\ntoggle r_showtris\n",
    );
    cmd.Cbuf_Execute();
    const out = printed.join("");
    if (out.includes("Unknown command")) throw new Error(out);
    assertEqual(Cvar_FindVar("r_softemu").value, 3, "r_softemu set");
    assertEqual(Cvar_FindVar("r_scale").value, 4, "r_scale set");
    assertEqual(Cvar_FindVar("r_showbboxes").value, 1, "r_showbboxes on");
    assertEqual(Cvar_FindVar("r_showtris").value, 1, "r_showtris on");
  } finally {
    names.forEach((n, i) => Cvar_Set(n, old[i]));
  }
});

Deno.test("r_scale: Ironwail's CLAMP (1, (int)r_scale, vid.maxscale)", () => {
  for (
    const [value, max, expected] of [
      [1, 4, 1],
      [4, 4, 4],
      [3.9, 4, 3],
      [8, 4, 4],
      [8, 9, 8],
      [0, 4, 1],
      [-3, 4, 1],
      [NaN, 4, 1],
    ]
  ) {
    assertEqual(R_ScaleDivisor(value, max), expected, `r_scale ${value}`);
  }
  // gl_vidsdl.c: q_max (4, vid.height / 240)
  assertEqual(vid.VID_MaxScale(480), 4, "480p");
  assertEqual(vid.VID_MaxScale(1080), 4, "1080p");
  assertEqual(vid.VID_MaxScale(2160), 9, "2160p");
});

Deno.test("r_scale divides the drawing buffer with ?scale= and vid_dynres", () => {
  const hadWindow = "window" in globalThis;
  const oldWindow = globalThis.window;
  globalThis.window = { location: { search: "" }, devicePixelRatio: 2 };
  vid.VID_ResetPixelRatio();
  const calls = [];
  const r = {
    xr: { isPresenting: false },
    setPixelRatio: (pr) => calls.push(pr),
  };
  const oldScale = r_scale.value;
  const oldDynres = vid_dynres.value;
  const oldHeight = vid.vid.height;
  try {
    vid.VID_SetTestRenderer(r, 0.5);
    vid.vid.height = 540; // 1080 device pixels: maxscale 4
    vid_dynres.value = 0;

    r_scale.value = 1;
    VID_DynResFrame(72, false);
    assertEqual(calls.length, 0, "r_scale 1 changes nothing");

    r_scale.value = 4;
    VID_DynResFrame(72, false);
    assertEqual(calls.length, 1, "resized once");
    if (!near(vid.vid_renderscale, 0.125)) throw new Error("0.5 / 4");
    if (!near(calls[0], 2 * 0.125)) throw new Error(`pixel ratio ${calls}`);
    VID_DynResFrame(72, false);
    assertEqual(calls.length, 1, "no resize while unchanged");

    vid.VID_SetDynamicScale(0.5);
    if (!near(vid.vid_renderscale, 0.0625)) throw new Error("times dynres");

    vid.VID_SetDynamicScale(1);
    r_scale.value = 16; // clamped to maxscale
    VID_DynResFrame(72, true);
    if (!near(vid.vid_renderscale, 0.125)) {
      throw new Error(`clamped: ${vid.vid_renderscale}`);
    }
  } finally {
    vid.VID_SetTestRenderer(null, 1);
    r_scale.value = oldScale;
    vid_dynres.value = oldDynres;
    vid.vid.height = oldHeight;
    vid.VID_ResetPixelRatio();
    if (hadWindow) globalThis.window = oldWindow;
    else delete globalThis.window;
  }
});

Deno.test("r_softemu: mode and metric as Ironwail picks them", () => {
  for (
    const [value, mode] of [[0, 0], [1, 1], [2.5, 2], [3, 3], [7, 3], [-1, 0]]
  ) {
    assertEqual(softemu.R_SoftEmuMode(value), mode, `r_softemu ${value}`);
  }
  const { R_SoftEmuMetric } = softemu;
  // automatic: OKLab, but naive RGB for mode 3 in a map without a .lit
  assertEqual(R_SoftEmuMetric(-1, 3, true), 0, "banded, no .lit");
  assertEqual(R_SoftEmuMetric(-1, 3, false), 2, "banded, .lit or no map");
  assertEqual(R_SoftEmuMetric(-1, 1, true), 2, "fine");
  assertEqual(R_SoftEmuMetric(1, 3, true), 1, "explicit");
  assertEqual(R_SoftEmuMetric(9, 3, true), 2, "clamped");
});

Deno.test("r_softemu: the Bayer matrix is Ironwail's bayer01", () => {
  // Ironwail's bit tricks, with bitfieldReverse done by hand
  function ironwail(x, y) {
    x &= 15;
    y = (y & 15) ^ x;
    let v = (y | (x << 8)) >>> 0;
    v = (v ^ (v << 2)) & 0x3333;
    v = (v ^ (v << 1)) & 0x5555;
    v |= v >> 7;
    let rev = 0;
    for (let i = 0; i < 32; i++) rev |= ((v >>> i) & 1) << (31 - i);
    return (rev >>> 24) / 256;
  }
  const seen = new Set();
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const b = softemu.R_SoftEmuBayer(x, y);
      assertEqual(b, ironwail(x, y), `bayer ${x},${y}`);
      seen.add(b);
    }
  }
  assertEqual(seen.size, 256, "every level once");
  assertEqual(
    softemu.R_SoftEmuBayer(16, 3),
    softemu.R_SoftEmuBayer(0, 3),
    "tiles",
  );
});

Deno.test("r_softemu: each metric maps a palette colour to itself", () => {
  const palette = [
    [0, 0, 0],
    [255, 255, 255],
    [143, 0, 0],
    [0, 107, 31],
    [35, 35, 179],
    [231, 199, 75],
    [127, 127, 127],
  ];
  const out = new Float64Array(palette.length * 3);
  const target = new Float64Array(3);
  for (const metric of [0, 1, 2]) {
    palette.forEach((c, i) =>
      softemu.R_SoftEmuNormalize(c[0], c[1], c[2], metric, out, i * 3)
    );
    palette.forEach((c, i) => {
      softemu.R_SoftEmuNormalize(c[0], c[1], c[2], metric, target, 0);
      let best = -1;
      let bestDist = Infinity;
      for (let j = 0; j < palette.length; j++) {
        const d = softemu.R_SoftEmuDistance(target, 0, out, j * 3, metric);
        if (d < bestDist) {
          bestDist = d;
          best = j;
        }
      }
      assertEqual(best, i, `metric ${metric}, colour ${i}`);
    });
  }
  // OKLab: white is lightness 1, no chroma
  softemu.R_SoftEmuNormalize(255, 255, 255, 2, target, 0);
  if (Math.abs(target[0] - 1) > 1e-4 || Math.abs(target[1]) > 1e-4) {
    throw new Error(`white in OKLab: ${target}`);
  }
});

Deno.test("r_showtris and r_showbboxes: Ironwail's modes and colours", () => {
  assertEqual(R_ShowTrisMode(0, 1), 0, "off");
  assertEqual(R_ShowTrisMode(1, 1), 1, "through walls");
  assertEqual(R_ShowTrisMode(2, 1), 2, "depth tested");
  assertEqual(R_ShowTrisMode(1.5, 1), 2, "between: depth tested, as != 1");
  assertEqual(R_ShowTrisMode(3, 1), 0, "out of range");
  assertEqual(R_ShowTrisMode(1, 2), 0, "never in multiplayer");

  // little-endian RGBA: red in the low byte
  assertEqual(R_BBoxColor(1, mod_brush, 0), 0x7fff8080, "brush: light blue");
  assertEqual(R_BBoxColor(1, mod_alias, 0), 0x7f408080, "alias");
  assertEqual(R_BBoxColor(1, mod_sprite, 0), 0x7f4040ff, "sprite: red");
  assertEqual(R_BBoxColor(1, -1, 0), 0x7f800080, "no model");
  assertEqual(R_BBoxColor(1, mod_brush, 50), 0x7f0000ff, "alive: red");
  assertEqual(R_BBoxColor(-1, mod_brush, 50), 0x7fffffff, "negative: white");
});

Deno.test("r_softemu: the pass palettizes and takes over the view blend", () => {
  const oldSoftemu = softemu.r_softemu.value;
  const oldGamma = v_gamma.value;
  const oldContrast = v_contrast.value;
  const oldFrame = r_framecount;
  const oldBlend = Array.from(v_blend);
  const oldPolyblend = gl_polyblend.value;
  const renders = [];
  let target = null;
  const r = {
    autoClear: true,
    getCurrentViewport: (t) => t.set(0, 0, 64, 48),
    getDrawingBufferSize: (t) => t.set(64, 48),
    copyFramebufferToTexture() {},
    getRenderTarget: () => target,
    setRenderTarget(t) {
      target = t;
    },
    render(scene) {
      const material = scene.children[0].material;
      renders.push({
        target,
        palettize: material.defines === undefined ?
          undefined :
          material.defines.PALETTIZE,
        uniforms: material.uniforms,
      });
    },
  };
  try {
    vid.VID_SetTestRenderer(r, 1);
    v_gamma.value = 1;
    v_contrast.value = 1;
    softemu.r_softemu.value = 0;
    assertEqual(R_PostprocessOwnsBlend(), false, "off: R_PolyBlend draws");

    softemu.r_softemu.value = 3;
    assertEqual(R_PostprocessOwnsBlend(), true, "on: the pass blends");
    v_blend.set([1, 0.5, 0, 0.25]);
    gl_polyblend.value = 1;
    set_r_framecount(5000);
    R_GammaCorrect();
    // the lookup table is drawn into its target first, then the view
    assertEqual(renders.length, 2, "table then pass");
    assertEqual(renders[0].target !== null, true, "table into a target");
    assertEqual(renders[1].target, null, "pass onto the canvas");
    assertEqual(renders[1].palettize, 2, "banded variant");
    const u = renders[1].uniforms;
    assertEqual(u.Dither.value, 0, "no dither");
    assertEqual(u.BlendColor.value.w, 0.25, "blend alpha");
    assertEqual(u.PaletteLUT.value, renders[0].target.texture, "the table");

    // same palette: the table is kept
    softemu.r_softemu.value = 1;
    set_r_framecount(5001);
    R_GammaCorrect();
    assertEqual(renders.length, 3, "no rebuild");
    assertEqual(renders[2].palettize, 1, "dithered variant");
    assertEqual(u.Dither.value, softemu.SOFTEMU_NOISESCALE, "dither amount");
  } finally {
    vid.VID_SetTestRenderer(null, 1);
    softemu.r_softemu.value = oldSoftemu;
    v_gamma.value = oldGamma;
    v_contrast.value = oldContrast;
    set_r_framecount(oldFrame);
    v_blend.set(oldBlend);
    gl_polyblend.value = oldPolyblend;
  }
});
