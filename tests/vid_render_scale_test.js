// VID_ParseRenderScale: the web-only ?scale= option for weak GPUs.

// vid.js alone hits a pre-existing import cycle (render.js vrect_t TDZ);
// load the renderer graph in its safe order first.
await import("../src/gl_rsurf.js");

const { VID_ParseRenderScale } = await import("../src/vid.js");
const { R_VrectToViewport } = await import("../src/gl_rmain.js");

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

Deno.test("VID_ParseRenderScale reads ?scale=, clamps it, and defaults to full resolution", () => {
  assertEqual(VID_ParseRenderScale(""), 1, "no query");
  assertEqual(VID_ParseRenderScale("?game=rogue"), 1, "no scale");
  assertEqual(VID_ParseRenderScale("?scale=0.5"), 0.5, "half");
  assertEqual(
    VID_ParseRenderScale("?game=hipnotic&scale=0.75"),
    0.75,
    "with another param",
  );
  assertEqual(VID_ParseRenderScale("?scale=0.1"), 0.25, "clamped low");
  assertEqual(VID_ParseRenderScale("?scale=2"), 1, "clamped high");
  assertEqual(VID_ParseRenderScale("?scale=abc"), 1, "invalid");
  assertEqual(VID_ParseRenderScale("?scale="), 1, "empty");
  assertEqual(VID_ParseRenderScale("?scale=Infinity"), 1, "infinite");
});

// R_SetupGL's viewport must not depend on ?scale=: the view rectangle is in
// 2D overlay pixels, and only the WebGL buffer shrinks.
Deno.test("R_VrectToViewport gives the same viewport at every render scale", () => {
  // 760x473 CSS page at devicePixelRatio 2, UI scale 2, status bar visible
  const vrect = { x: 0, y: 0, width: 760, height: 402 };
  const uiScale = 2;
  const full = R_VrectToViewport(
    new Float64Array(4),
    vrect,
    uiScale,
    1,
    1520,
    946,
    2,
  );
  const half = R_VrectToViewport(
    new Float64Array(4),
    vrect,
    uiScale,
    0.5,
    760,
    473,
    1,
  );
  const quarter = R_VrectToViewport(
    new Float64Array(4),
    vrect,
    uiScale,
    0.25,
    380,
    236.5,
    0.5,
  );

  for (let i = 0; i < 4; i++) {
    // GLQuake's one-pixel expansion is in buffer pixels, so it may differ by under one CSS pixel
    if (Math.abs(full[i] - half[i]) > 1) {
      throw new Error(`scale 0.5 component ${i}: ${full[i]} vs ${half[i]}`);
    }
    if (Math.abs(full[i] - quarter[i]) > 2) {
      throw new Error(`scale 0.25 component ${i}: ${full[i]} vs ${quarter[i]}`);
    }
  }

  // Without the render scale the view would come out twice as big
  const wrong = R_VrectToViewport(
    new Float64Array(4),
    vrect,
    uiScale,
    1,
    760,
    473,
    1,
  );
  if (Math.abs(wrong[2] - full[2]) < 100) {
    throw new Error("test does not detect a missing render scale");
  }
});
