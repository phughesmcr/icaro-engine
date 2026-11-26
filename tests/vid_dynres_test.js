// Dynamic resolution controller (src/vid_dynres.js), driven with synthetic
// frame times: no renderer, no browser.

// vid.js alone hits a pre-existing import cycle (render.js vrect_t TDZ)
await import("../src/gl_rsurf.js");
const {
  DynRes_Expected,
  DynRes_NewState,
  DynRes_ResetTiming,
  DynRes_Sample,
  DYNRES_STEPS,
  DYNRES_UP_DELAY,
  DYNRES_UP_DELAY_MAX,
} = await import("../src/vid_dynres.js");

/**
 * Feeds frames for `seconds`. `interval` is a number or a function of the
 * current level. Returns the level changes seen, in order.
 */
function run(st, clock, interval, seconds, maxfps) {
  const changes = [];
  const end = clock.t + seconds;
  while (clock.t < end) {
    clock.t += typeof interval === "function" ? interval(st.level) : interval;
    const level = DynRes_Sample(st, clock.t, maxfps);
    if (level !== -1) changes.push(level);
  }
  return changes;
}

function near(a, b) {
  return Math.abs(a - b) < 1e-9;
}

Deno.test("expected interval: the cap rounded up to whole refreshes", () => {
  if (!near(DynRes_Expected(72, 1 / 60), 1 / 60)) throw new Error("72 @ 60");
  if (!near(DynRes_Expected(72, 1 / 90), 2 / 90)) throw new Error("72 @ 90");
  if (!near(DynRes_Expected(72, 1 / 120), 2 / 120)) {
    throw new Error("72 @ 120");
  }
  if (!near(DynRes_Expected(72, 1 / 72), 1 / 72)) throw new Error("72 @ 72");
  if (!near(DynRes_Expected(30, 1 / 60), 2 / 60)) throw new Error("30 @ 60");
  if (!near(DynRes_Expected(0, 1 / 60), 1 / 60)) throw new Error("0 @ 60");
  if (!near(DynRes_Expected(144, 1 / 60), 1 / 60)) throw new Error("144 @ 60");
  if (!near(DynRes_Expected(72, Infinity), 1 / 72)) {
    throw new Error("no refresh seen yet: the cap");
  }
});

Deno.test("frames at the expected rate never step down", () => {
  for (
    const [maxfps, hz, every] of [
      [72, 60, 1],
      [72, 90, 2],
      [72, 120, 2],
      [30, 60, 2],
      [0, 60, 1],
      [144, 120, 1],
    ]
  ) {
    const st = DynRes_NewState();
    const changes = run(st, { t: 100 }, every / hz, 30, maxfps);
    if (changes.length !== 0) {
      throw new Error(`${maxfps} fps @ ${hz} Hz stepped: ${changes}`);
    }
  }
});

Deno.test("GPU-bound frames step down, one step per settle", () => {
  const st = DynRes_NewState();
  const clock = { t: 100 };
  run(st, clock, 1 / 60, 2, 72); // learn the refresh interval
  const first = run(st, clock, 1 / 30, 1, 72);
  if (first.length !== 1 || first[0] !== 1) {
    throw new Error(`one step down within a second: ${first}`);
  }
  // still slow: keeps stepping to the floor, then stops there
  const rest = run(st, clock, 1 / 30, 20, 72);
  if (rest.join() !== "2,3,4") throw new Error(`to the floor: ${rest}`);
  if (st.level !== DYNRES_STEPS.length - 1) throw new Error("at the floor");
});

Deno.test("a short hitch doesn't step down", () => {
  const st = DynRes_NewState();
  const clock = { t: 100 };
  run(st, clock, 1 / 60, 2, 72);
  const changes = [
    ...run(st, clock, 1 / 20, 0.15, 72),
    ...run(st, clock, 1 / 60, 3, 72),
  ];
  if (changes.length !== 0) throw new Error(`stepped: ${changes}`);
});

Deno.test("gaps over a quarter second are not samples", () => {
  const st = DynRes_NewState();
  const clock = { t: 100 };
  run(st, clock, 1 / 60, 2, 72);
  // a hidden tab: one frame a second for a minute
  const changes = run(st, clock, 1, 60, 72);
  if (changes.length !== 0) throw new Error(`stepped: ${changes}`);
});

/** Runs until the level changes; returns { t, level } or null. */
function next(st, clock, interval, limit, maxfps) {
  const end = clock.t + limit;
  while (clock.t < end) {
    clock.t += interval(st.level);
    const level = DynRes_Sample(st, clock.t, maxfps);
    if (level !== -1) return { t: clock.t, level };
  }
  return null;
}

Deno.test("steps up as a probe after the delay; a failed probe doubles it", () => {
  const st = DynRes_NewState();
  const clock = { t: 100 };
  run(st, clock, 1 / 60, 2, 72);
  // full scale too slow, one step down keeps up
  const gpu = (level) => (level === 0 ? 1 / 30 : 1 / 60);
  let down = next(st, clock, gpu, 2, 72);
  if (down === null || down.level !== 1) throw new Error("down");

  // each probe waits the settle plus the delay; each failure doubles the
  // delay, up to the maximum
  let delay = DYNRES_UP_DELAY;
  for (let i = 0; i < 6; i++) {
    const up = next(st, clock, gpu, 120, 72);
    if (up === null || up.level !== 0) throw new Error(`probe ${i}`);
    const waited = up.t - down.t;
    if (waited < delay + 1 || waited > delay + 1.1) {
      throw new Error(`probe ${i} after ${waited} s, want ${delay + 1}`);
    }
    down = next(st, clock, gpu, 3, 72);
    if (down === null || down.level !== 1) throw new Error(`fail ${i}`);
    delay = Math.min(delay * 2, DYNRES_UP_DELAY_MAX);
    if (st.upDelay !== delay) {
      throw new Error(`delay ${st.upDelay}, want ${delay}`);
    }
  }
  if (st.upDelay !== DYNRES_UP_DELAY_MAX) throw new Error("capped");
});

Deno.test("a probe that holds resets the back-off", () => {
  const st = DynRes_NewState();
  const clock = { t: 100 };
  run(st, clock, 1 / 60, 2, 72);
  let heavy = true;
  const gpu = (level) => (heavy && level === 0 ? 1 / 30 : 1 / 60);
  run(st, clock, gpu, 1.6, 72); // down to 1
  run(st, clock, gpu, DYNRES_UP_DELAY + 2, 72); // probe to 0
  run(st, clock, gpu, 2, 72); // fails: back to 1, delay doubled
  if (st.upDelay !== DYNRES_UP_DELAY * 2) throw new Error("doubled");
  heavy = false; // the scene got lighter
  const up = run(st, clock, gpu, DYNRES_UP_DELAY * 2 + 2, 72);
  if (up.join() !== "0") throw new Error(`up: ${up}`);
  run(st, clock, gpu, 11, 72); // held
  if (st.upDelay !== DYNRES_UP_DELAY) throw new Error("reset");
  if (st.probeAt !== 0) throw new Error("probation over");
});

Deno.test("a reset keeps the level, the back-off and the refresh interval", () => {
  const st = DynRes_NewState();
  const clock = { t: 100 };
  run(st, clock, 1 / 60, 2, 72);
  run(st, clock, 1 / 30, 1.6, 72);
  const level = st.level;
  DynRes_ResetTiming(st);
  if (st.level !== level || level === 0) throw new Error("level kept");
  if (!near(st.vsync, 1 / 60)) throw new Error("refresh interval kept");
  if (st.last !== 0 || st.ema !== 0) throw new Error("timing cleared");
  // the first frame after a reset is not a sample
  if (DynRes_Sample(st, clock.t + 5, 72) !== -1) throw new Error("sampled");
});

const { VID_SetTestRenderer } = await import("../src/vid.js");
const { VID_DynResFrame, dynres_state, vid_dynres } = await import(
  "../src/vid_dynres.js"
);

/** A renderer stub that records setPixelRatio, with a DPR 2 window. */
function withRenderer(basescale, fn) {
  const hadWindow = "window" in globalThis;
  const oldWindow = globalThis.window;
  globalThis.window = { location: { search: "" }, devicePixelRatio: 2 };
  const calls = [];
  const r = {
    xr: { isPresenting: false },
    setPixelRatio: (pr) => calls.push(pr),
  };
  const oldValue = vid_dynres.value;
  try {
    VID_SetTestRenderer(r, basescale);
    fn(r, calls);
  } finally {
    VID_SetTestRenderer(null, 1);
    vid_dynres.value = oldValue;
    dynres_state.level = 0;
    if (hadWindow) globalThis.window = oldWindow;
    else delete globalThis.window;
  }
}

Deno.test("VID_SetDynamicScale multiplies ?scale= and skips XR", async () => {
  const vid = await import("../src/vid.js");
  withRenderer(0.5, (r, calls) => {
    vid.VID_SetDynamicScale(0.7);
    if (!near(vid.vid_renderscale, 0.35)) throw new Error("product");
    if (calls.length !== 1 || !near(calls[0], 2 * 0.35)) {
      throw new Error(`setPixelRatio ${calls}`);
    }
    r.xr.isPresenting = true;
    vid.VID_SetDynamicScale(1);
    if (calls.length !== 1) throw new Error("XR presenting: left alone");
    if (!near(vid.vid_renderscale, 0.5)) throw new Error("scale still kept");
  });
});

Deno.test("VID_DynResFrame puts the full scale back when off or held", async () => {
  const vid = await import("../src/vid.js");
  withRenderer(1, (_r, calls) => {
    vid_dynres.value = 0;
    VID_DynResFrame(72, false);
    if (calls.length !== 0) throw new Error("off at full scale: no call");

    for (const [on, hold] of [[0, false], [1, true]]) {
      vid_dynres.value = on;
      dynres_state.level = 3;
      vid.VID_SetDynamicScale(DYNRES_STEPS[3]);
      calls.length = 0;
      VID_DynResFrame(72, hold);
      if (dynres_state.level !== 0) throw new Error("level reset");
      if (calls.length !== 1 || !near(calls[0], 2)) {
        throw new Error(`full scale back: ${calls}`);
      }
      if (dynres_state.last !== 0) throw new Error("timing dropped");
    }
  });
});

Deno.test("VID_DynResFrame does nothing without a renderer", () => {
  const oldValue = vid_dynres.value;
  try {
    vid_dynres.value = 1;
    dynres_state.level = 2;
    VID_DynResFrame(72, true);
    if (dynres_state.level !== 2) throw new Error("touched");
  } finally {
    vid_dynres.value = oldValue;
    dynres_state.level = 0;
  }
});
