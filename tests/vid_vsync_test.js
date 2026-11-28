// vid_vsync: which scheduler drives frames, the uncapped loop's pacing, and
// the loop itself with a stand-in renderer and document (vid_vsync.js)

import {
  VID_FrameMode,
  VID_StartFrameLoop,
  VID_StopFrameLoop,
  VID_UncappedInterval,
  VID_UncappedNext,
  vid_vsync,
  VSYNC_RAF,
  VSYNC_UNCAPPED,
} from "../src/vid_vsync.js";
// vid.js alone hits a pre-existing import cycle (render.js vrect_t TDZ), as in
// vid_dynres_test.js
await import("../src/gl_rsurf.js");
const { DynRes_Held } = await import("../src/vid_dynres.js");

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(msg + ": expected " + expected + ", got " + actual);
  }
}

function assertNear(actual, expected, msg) {
  if (Math.abs(actual - expected) > 1e-9) {
    throw new Error(msg + ": expected " + expected + ", got " + actual);
  }
}

Deno.test("vid_vsync: archived, on by default", () => {
  assertEqual(vid_vsync.name, "vid_vsync", "name");
  assertEqual(vid_vsync.string, "1", "default string");
  assertEqual(vid_vsync.value, 1, "default value");
  assertEqual(vid_vsync.archive, true, "archived");
});

Deno.test("vid_vsync: the uncapped loop only with 0, visible and outside XR", () => {
  assertEqual(VID_FrameMode(0, false, false), VSYNC_UNCAPPED, "0, visible");
  assertEqual(VID_FrameMode(1, false, false), VSYNC_RAF, "1");
  // Ironwail's swap intervals and adaptive vsync all mean on
  assertEqual(VID_FrameMode(2, false, false), VSYNC_RAF, "interval 2");
  assertEqual(VID_FrameMode(-1, false, false), VSYNC_RAF, "adaptive");
  assertEqual(VID_FrameMode(0, true, false), VSYNC_RAF, "hidden tab");
  assertEqual(VID_FrameMode(0, false, true), VSYNC_RAF, "WebXR session");
  assertEqual(VID_FrameMode(0, true, true), VSYNC_RAF, "hidden and XR");
});

Deno.test("vid_vsync: uncapped frames are paced by host_maxfps", () => {
  assertNear(VID_UncappedInterval(250, false), 4, "250 fps");
  assertNear(VID_UncappedInterval(120, false), 1000 / 120, "120 fps");
  assertNear(VID_UncappedInterval(60, false), 1000 / 60, "60 fps");
  // 0 (no cap) and caps above it stop at 1000 fps, as host.js does
  assertNear(VID_UncappedInterval(0, false), 1, "no cap");
  assertNear(VID_UncappedInterval(5000, false), 1, "over 1000");
  // a timedemo runs as fast as it can, as in _Host_FilterTime
  assertEqual(VID_UncappedInterval(250, true), 0, "timedemo");
  assertEqual(VID_UncappedInterval(0, true), 0, "timedemo, no cap");
});

Deno.test("vid_vsync: the schedule makes up for late timers and resets after a hitch", () => {
  // on time: one interval on
  assertEqual(VID_UncappedNext(100, 100, 4), 104, "on time");
  // 1.5 ms late: the next is still due on the grid, so it comes sooner
  assertEqual(VID_UncappedNext(100, 101.5, 4), 104, "a little late");
  // more than an interval behind: start again from now
  assertEqual(VID_UncappedNext(100, 110, 4), 114, "a hitch");
  // the loop starts with nothing due
  assertEqual(VID_UncappedNext(0, 5000, 4), 5004, "first frame");
  // a timedemo (interval 0) is always due
  assertEqual(VID_UncappedNext(5000, 5003, 0), 5003, "timedemo");

  // 1000 frames whose timers each fire 0.7 ms late still average 250 fps
  let due = 0;
  let now = 1000;
  let first = 0;
  for (let i = 0; i < 1000; i++) {
    due = VID_UncappedNext(due, now, 4);
    if (i === 0) first = now;
    now = Math.max(now + 0.2, due + 0.7); // the frame, then a late wake
  }
  assertNear(Math.round((now - first) / 1000), 4, "average interval (ms)");
});

Deno.test("vid_vsync: dynamic resolution holds while frames are uncapped", () => {
  assertEqual(DynRes_Held(false, false, 1), false, "normal play");
  assertEqual(DynRes_Held(false, false, 0), true, "vid_vsync 0");
  assertEqual(DynRes_Held(true, false, 1), true, "timedemo");
  assertEqual(DynRes_Held(false, true, 1), true, "WebXR");
});

function macrotask() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

Deno.test("vid_vsync: the frame loop switches between animation frames and the uncapped loop", async () => {
  const hadDocument = "document" in globalThis;
  const oldDocument = globalThis.document;
  globalThis.document = { visibilityState: "visible" };
  const oldVsync = vid_vsync.value;
  const renderer = {
    loop: null,
    setAnimationLoop(fn) {
      this.loop = fn;
    },
  };
  const stamps = [];
  let lockstep = false;
  function frame(timestamp) {
    if (lockstep) return false;
    stamps.push(timestamp);
    return true;
  }

  try {
    VID_StartFrameLoop(renderer, frame, () => 0);
    assertEqual(typeof renderer.loop, "function", "animation loop set");

    // vid_vsync 1: each animation frame is a frame
    vid_vsync.value = 1;
    renderer.loop(16);
    renderer.loop(33);
    assertEqual(stamps.join(), "16,33", "animation frames drive it");

    // vid_vsync 0: the animation frame only starts the uncapped loop, which
    // keeps going between animation frames on performance.now() stamps
    vid_vsync.value = 0;
    stamps.length = 0;
    renderer.loop(50);
    assertEqual(stamps.length, 0, "no frame from the animation frame");
    await macrotask();
    await macrotask();
    const running = stamps.length;
    assertEqual(running > 1, true, "uncapped frames run (" + running + ")");
    assertEqual(stamps.includes(50), false, "stamps are its own");
    // another animation frame doesn't start a second loop or draw
    renderer.loop(66);
    assertEqual(stamps.includes(66), false, "animation frame skipped");

    // a hidden tab stops the loop; requestAnimationFrame takes over
    globalThis.document.visibilityState = "hidden";
    await macrotask();
    const stopped = stamps.length;
    await macrotask();
    await macrotask();
    assertEqual(stamps.length, stopped, "stopped while hidden");
    renderer.loop(500);
    assertEqual(stamps[stamps.length - 1], 500, "animation frame while hidden");

    // visible again: the next animation frame restarts it
    globalThis.document.visibilityState = "visible";
    renderer.loop(516);
    assertEqual(stamps[stamps.length - 1], 500, "restart doesn't draw");
    await macrotask();
    assertEqual(stamps.length > stopped + 1, true, "running again");

    // a frame that doesn't run (lockstep) stops the loop rather than spin
    lockstep = true;
    await macrotask();
    await macrotask();
    lockstep = false;
    const held = stamps.length;
    await macrotask();
    await macrotask();
    assertEqual(stamps.length, held, "stopped after a frame that didn't run");
    renderer.loop(600);
    await macrotask();
    assertEqual(stamps.length > held, true, "the next animation frame resumes");

    // back to 1: the loop ends and animation frames draw again
    vid_vsync.value = 1;
    await macrotask();
    await macrotask();
    const back = stamps.length;
    await macrotask();
    assertEqual(stamps.length, back, "uncapped loop ended");
    renderer.loop(700);
    assertEqual(stamps[stamps.length - 1], 700, "animation frames again");
  } finally {
    vid_vsync.value = oldVsync;
    VID_StopFrameLoop();
    if (hadDocument) globalThis.document = oldDocument;
    else delete globalThis.document;
  }
  assertEqual(renderer.loop, null, "stop clears the animation loop");
});
