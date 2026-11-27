// Ironwail's hudstyle cvar (LibreQuake's style_ironwail_modern.cfg sets
// hudstyle 2): its registration and values, the view under the modern HUD,
// and the modern HUD's canvas scale (sbar.js Sbar2_CanvasScale).

await import("../src/gl_rsurf.js");
globalThis.window = { devicePixelRatio: 1 }; // gl_draw.js sizes the virtual screen from it

const scr = await import("../src/gl_screen.js");
const sbar = await import("../src/sbar.js");
const common = await import("../src/common.js");
const cmd = await import("../src/cmd.js");
const consolejs = await import("../src/console.js");
const { Cvar_FindVar, Cvar_Set } = await import("../src/cvar.js");

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

Deno.test("the status bar defaults to Ironwail's translucent overlay", () => {
  scr.SCR_Init();
  const cvar = Cvar_FindVar("scr_sbaralpha");
  if (cvar === null) throw new Error("scr_sbaralpha not registered");
  assertEqual(cvar.default_string, "0.75", "scr_sbaralpha default");
  const r_refdef = {
    vrect: { x: 0, y: 0, width: 0, height: 0 },
    vrectScale: 1,
    fov_x: 0,
    fov_y: 0,
  };
  scr.SCR_SetExternals({
    r_refdef,
    cl: { intermission: 0, paused: false, worldmodel: null, time: 0 },
  });
  const old = cvar.string;
  try {
    Cvar_Set("scr_sbaralpha", "0.75");
    scr.SCR_CalcRefdef();
    assertEqual(r_refdef.vrect.height, 240, "the view under the bar");
    Cvar_Set("scr_sbaralpha", "1");
    scr.SCR_CalcRefdef();
    assertEqual(r_refdef.vrect.height, 240 - 48, "scr_sbaralpha 1");
  } finally {
    Cvar_Set("scr_sbaralpha", old);
  }
});

Deno.test("SCR_Init registers hudstyle, archived, defaulting to classic", () => {
  scr.SCR_Init();
  const cvar = Cvar_FindVar("hudstyle");
  if (cvar === null) throw new Error("hudstyle not registered");
  assertEqual(cvar, scr.scr_hudstyle, "the gl_screen.js cvar");
  // Deviation: Ironwail defaults to 2 (modern, side ammo); Icaro keeps the
  // classic status bar unless a config asks for another
  assertEqual(cvar.default_string, "0", "default");
  assertEqual(cvar.archive, true, "archive");
});

Deno.test("hudstyle values clamp like Ironwail's 0..3", () => {
  const old = scr.scr_hudstyle.string;
  try {
    for (
      const [value, style, modern] of [
        ["0", scr.HUD_CLASSIC, false],
        ["1", scr.HUD_MODERN_CENTERAMMO, true],
        ["2", scr.HUD_MODERN_SIDEAMMO, true],
        ["3", scr.HUD_QUAKEWORLD, false],
        ["2.7", scr.HUD_MODERN_SIDEAMMO, true],
        ["9", scr.HUD_QUAKEWORLD, false],
        ["-1", scr.HUD_CLASSIC, false],
        ["junk", scr.HUD_CLASSIC, false],
      ]
    ) {
      Cvar_Set("hudstyle", value);
      assertEqual(scr.SCR_HudStyle(), style, "hudstyle " + value);
      assertEqual(scr.SCR_ModernHud(), modern, "modern at " + value);
    }
  } finally {
    Cvar_Set("hudstyle", old);
  }
});

Deno.test("LibreQuake's hudstyle line is a known command", () => {
  scr.SCR_Init();
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
  const old = scr.scr_hudstyle.string;
  try {
    cmd.Cbuf_AddText("hudstyle 2\n");
    cmd.Cbuf_Execute();
    const out = printed.join("");
    if (out.includes("Unknown command")) throw new Error(out);
    assertEqual(scr.scr_hudstyle.value, 2, "hudstyle set");
  } finally {
    Cvar_Set("hudstyle", old);
  }
});

Deno.test("the modern HUD takes no lines from the view", () => {
  const r_refdef = {
    vrect: { x: 0, y: 0, width: 0, height: 0 },
    vrectScale: 1,
    fov_x: 0,
    fov_y: 0,
  };
  scr.SCR_SetExternals({
    r_refdef,
    cl: { intermission: 0, paused: false, worldmodel: null, time: 0 },
  });
  const old = scr.scr_hudstyle.string;
  const oldScale = scr.scr_sbarscale.value;
  const oldAlpha = scr.scr_sbaralpha.value;
  try {
    scr.scr_sbarscale.value = 0;
    scr.scr_sbaralpha.value = 1; // an opaque classic bar
    // 640x480 at the automatic 2x UI scale: a 320x240 virtual screen, the
    // classic bar 48 lines of it at viewsize 100
    for (
      const [value, height] of [
        ["0", 240 - 48],
        ["1", 240],
        ["2", 240],
        ["3", 240 - 48], // QuakeWorld isn't ported: drawn classic
      ]
    ) {
      Cvar_Set("hudstyle", value);
      scr.SCR_CalcRefdef();
      assertEqual(r_refdef.vrect.height, height, "view at hudstyle " + value);
    }
  } finally {
    Cvar_Set("hudstyle", old);
    scr.scr_sbarscale.value = oldScale;
    scr.scr_sbaralpha.value = oldAlpha;
  }
});

Deno.test("Sbar2_CanvasScale: CLAMP (1, scr_sbarscale, min (w / 400, h / 225))", () => {
  for (
    const [sbarscale, w, h, auto, expected] of [
      [2, 1920, 1080, 4, 2],
      [8, 1920, 1080, 4, 4.8], // 1080 / 225
      [8, 1600, 1200, 4, 4], // 1600 / 400
      [0.5, 1920, 1080, 4, 1],
      [0, 1920, 1080, 4, 4], // Icaro's automatic scale
      [0, 640, 480, 2, 1.6], // 640 / 400
      [0.5, 640, 480, 2, 1], // never under 1...
      [0, 320, 200, 1, 0.8], // ...unless the screen is (CLAMP tests max last)
    ]
  ) {
    const got = sbar.Sbar2_CanvasScale(sbarscale, w, h, auto);
    if (Math.abs(got - expected) > 1e-9) {
      throw new Error(
        `scr_sbarscale ${sbarscale} at ${w}x${h}: expected ${expected}, got ${got}`,
      );
    }
  }
});

Deno.test("Sbar_GetFootprint gives the HUD's area in CSS pixels", () => {
  const cl = {
    intermission: 0,
    gametype: 0,
    items: 0,
    stats: new Array(32).fill(0),
  };
  cl.stats[0] = 100; // STAT_HEALTH
  sbar.Sbar_SetExternals({ cl, vid: { width: 640, height: 480 } });
  const old = scr.scr_hudstyle.string;
  const oldScale = scr.scr_sbarscale.value;
  const oldLines = sbar.sb_lines;
  const used = (rects) => rects.filter((r) => r.w > 0 && r.h > 0);
  try {
    scr.scr_sbarscale.value = 0;

    // classic at the automatic 2x scale: 320 x 48 centred at the bottom
    Cvar_Set("hudstyle", "0");
    sbar.set_sb_lines(48);
    let rects = sbar.Sbar_GetFootprint();
    assertEqual(rects.length, 4, "a fixed array");
    let r = used(rects);
    assertEqual(r.length, 1, "classic rectangles");
    assertEqual(
      [r[0].x, r[0].y, r[0].w, r[0].h].join(),
      "0,384,640,96",
      "classic bar",
    );
    sbar.set_sb_lines(0);
    assertEqual(used(sbar.Sbar_GetFootprint()).length, 0, "viewsize 120");

    // hudstyle 2 on CANVAS_SBAR2 at 640 / 400 = 1.6: the bottom corners and
    // the weapon column
    sbar.set_sb_lines(48);
    Cvar_Set("hudstyle", "2");
    rects = sbar.Sbar_GetFootprint();
    r = used(rects);
    assertEqual(r.length, 3, "modern rectangles");
    const near = (a, b) => Math.abs(a - b) < 1e-6;
    // left: x 16, y 300 - 10 - 48, 104 x 48 canvas pixels
    if (
      !near(r[0].x, 16 * 1.6) || !near(r[0].y, 242 * 1.6) ||
      !near(r[0].w, 104 * 1.6) || !near(r[0].h, 48 * 1.6)
    ) {
      throw new Error("left corner: " + JSON.stringify(r[0]));
    }
    if (!near(r[1].x + r[1].w, 640 - 16 * 1.6)) {
      throw new Error("right corner: " + JSON.stringify(r[1]));
    }
    if (!near(r[2].x + r[2].w, 640)) {
      throw new Error("weapon column: " + JSON.stringify(r[2]));
    }
    assertEqual(sbar.Sbar_GetFootprint(), rects, "the same array each call");

    Cvar_Set("hudstyle", "1");
    assertEqual(used(sbar.Sbar_GetFootprint()).length, 4, "the ammo strip");
  } finally {
    Cvar_Set("hudstyle", old);
    scr.scr_sbarscale.value = oldScale;
    sbar.set_sb_lines(oldLines);
  }
});
