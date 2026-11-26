// Port-inventory gap G5: GLQuake's crosshair (gl_screen.c SCR_UpdateScreen)
// is drawn at the centre of scr_vrect, ignores cl_crossx/cl_crossy and shows
// during demo playback.

await import("../src/gl_rsurf.js");
globalThis.window = { devicePixelRatio: 1 }; // gl_draw.js sizes the virtual screen from it

const draw = await import("../src/gl_draw.js");
const scr = await import("../src/gl_screen.js");
const view = await import("../src/view.js");
const cvar = await import("../src/cvar.js");

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${
        JSON.stringify(actual)
      }`,
    );
  }
}

// With no WAD loaded, Draw_Character falls back to fillText at ( x, y )
const drawn = [];
const ctx = {
  setTransform: () => {},
  clearRect: () => {},
  drawImage: () => {},
  fillRect: () => {},
  fillText: (text, x, y) => drawn.push([text, x, y]),
};
try {
  draw.Draw_Init({ width: 640, height: 480, getContext: () => ctx });
} catch {
  // no WAD in tests; only the overlay context matters here
}

for (const v of [view.crosshair, view.cl_crossx, view.cl_crossy]) {
  if (cvar.Cvar_FindVar(v.name) === null) cvar.Cvar_RegisterVariable(v);
}

function crosshairAt(cl, cls) {
  scr.SCR_SetExternals({ cl, cls });
  drawn.length = 0;
  scr.SCR_DrawCrosshair();
  return drawn.map(([text, x, y]) => text + "@" + x + "," + y).join(" ");
}

Deno.test("G5: the crosshair is centred on scr_vrect, ignores cl_crossx/y and shows in demos", () => {
  const r_refdef = {
    vrect: { x: 0, y: 0, width: 0, height: 0 },
    vrectScale: 1,
    fov_x: 0,
    fov_y: 0,
  };
  const cl = { intermission: 0, paused: false, worldmodel: null, time: 0 };
  const cls = { state: 2, signon: 4, demoplayback: false };
  scr.SCR_SetExternals({ r_refdef, cl });

  const old = [view.crosshair, view.cl_crossx, view.cl_crossy].map((v) =>
    v.string
  );
  try {
    cvar.Cvar_Set("crosshair", "0");
    assertEqual(crosshairAt(cl, cls), "", "crosshair 0 draws nothing");

    // The default viewsize 100 on the 320x240 virtual screen: the 48-line status bar
    // leaves a 320x192 view, centred at ( 160, 96 )
    cvar.Cvar_Set("crosshair", "1");
    scr.SCR_CalcRefdef();
    assertEqual(r_refdef.vrect.height, 192, "test setup: view height");
    assertEqual(crosshairAt(cl, cls), "+@156,92", "centre of scr_vrect");

    cvar.Cvar_Set("cl_crossx", "20");
    cvar.Cvar_Set("cl_crossy", "-10");
    assertEqual(
      crosshairAt(cl, cls),
      "+@156,92",
      "cl_crossx/y are software-only",
    );

    assertEqual(
      crosshairAt(cl, { ...cls, demoplayback: true }),
      "+@156,92",
      "drawn during demo playback",
    );

    // viewsize 60: a 192x144 view at ( 64, 24 ), still centred on ( 160, 96 )
    const oldViewsize = scr.scr_viewsize.value;
    try {
      scr.scr_viewsize.value = 60;
      scr.SCR_CalcRefdef();
      assertEqual(
        r_refdef.vrect.x + "," + r_refdef.vrect.y + " " + r_refdef.vrect.width +
          "x" + r_refdef.vrect.height,
        "64,24 192x144",
        "test setup: viewsize 60 view",
      );
      assertEqual(
        crosshairAt(cl, cls),
        "+@156,92",
        "offset by scr_vrect.x and .y",
      );
    } finally {
      scr.scr_viewsize.value = oldViewsize;
      scr.SCR_CalcRefdef();
    }

    assertEqual(
      crosshairAt({ ...cl, intermission: 3 }, cls),
      "",
      "hidden during intermission (FitzQuake)",
    );
  } finally {
    cvar.Cvar_Set("crosshair", old[0]);
    cvar.Cvar_Set("cl_crossx", old[1]);
    cvar.Cvar_Set("cl_crossy", old[2]);
    scr.SCR_SetExternals({
      cl: { intermission: 0, paused: false, worldmodel: null, time: 0 },
      cls: { state: 0, signon: 0, demoplayback: false },
    });
  }
});

Deno.test("Ironwail scr_crosshairscale draws on its own canvas, centred as before", () => {
  const r_refdef = {
    vrect: { x: 0, y: 0, width: 0, height: 0 },
    vrectScale: 1,
    fov_x: 0,
    fov_y: 0,
  };
  const cl = { intermission: 0, paused: false, worldmodel: null, time: 0 };
  const cls = { state: 2, signon: 4, demoplayback: false };
  scr.SCR_SetExternals({ r_refdef, cl });
  if (cvar.Cvar_FindVar("scr_crosshairscale") === null) {
    cvar.Cvar_RegisterVariable(scr.scr_crosshairscale);
  }

  const oldCrosshair = view.crosshair.string;
  try {
    cvar.Cvar_Set("crosshair", "1");
    scr.SCR_CalcRefdef();
    assertEqual(scr.scr_crosshairscale.string, "0", "default: the UI scale");
    assertEqual(crosshairAt(cl, cls), "+@156,92", "UI scale (2)");

    // The centre ( 160, 96 ) is ( 320, 192 ) physical pixels on 640x480
    cvar.Cvar_Set("scr_crosshairscale", "1");
    assertEqual(crosshairAt(cl, cls), "+@316,188", "scale 1");
    cvar.Cvar_Set("scr_crosshairscale", "1.6");
    assertEqual(crosshairAt(cl, cls), "+@196,116", "scale 1.6");
    // Clamped to width / 320, as the other canvas scales are
    cvar.Cvar_Set("scr_crosshairscale", "3");
    assertEqual(crosshairAt(cl, cls), "+@156,92", "scale 3 clamps to 2");
    assertEqual(draw.Draw_GetVirtualWidth(), 320, "canvas scale reset");
  } finally {
    cvar.Cvar_Set("scr_crosshairscale", "0");
    cvar.Cvar_Set("crosshair", oldCrosshair);
    scr.SCR_SetExternals({
      cl: { intermission: 0, paused: false, worldmodel: null, time: 0 },
      cls: { state: 0, signon: 0, demoplayback: false },
    });
  }
});
