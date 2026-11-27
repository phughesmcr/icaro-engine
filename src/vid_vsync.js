// vid_vsync (QuakeSpasm/Ironwail gl_vidsdl.c): nonzero waits for the
// display's refresh, 0 draws frames as fast as host_maxfps allows. A browser
// has no swap interval to set, so here it picks what drives Host_Frame:
// nonzero is requestAnimationFrame, as before; 0 is a MessageChannel and
// setTimeout loop paced by host_maxfps while the tab is visible and no WebXR
// session is active, falling back to requestAnimationFrame otherwise.
//
// The compositor still shows the canvas once per refresh, so 0 draws frames
// that are never shown and costs CPU and battery without a smoother picture.
// What it is good for is what it is used for in QuakeSpasm: timedemo and
// other benchmarks, which run at the engine's speed instead of the display's.
// The game ticks at 72 Hz either way (host.js host_netinterval).
//
// Deviations: the default is 1 (QuakeSpasm and Ironwail default to 0), as the
// browser has always synced frames to the display. Ironwail's swap intervals
// (2 to 4, and negative for adaptive vsync) all count as 1.

import { Cvar_RegisterVariable } from "./cvar.js";

/** vid_vsync: 1 (default) display-synced frames, 0 uncapped. Archived. */
export const vid_vsync = {
  name: "vid_vsync",
  string: "1",
  value: 1,
  archive: true,
};

/** Frames come from requestAnimationFrame. */
export const VSYNC_RAF = 0;
/** Frames come from the MessageChannel/setTimeout loop. */
export const VSYNC_UNCAPPED = 1;

// The fastest the uncapped loop asks for frames when host_maxfps is 0. It
// matches host.js, whose frames are at least 1 ms long (_Host_FilterTime) and
// whose render cap stops at 1000 fps.
const VSYNC_MAX_FPS = 1000;
// A wait shorter than this runs the frame at once: host.js runs a tick up to
// HOST_NETTICK_SLACK (1 ms) early, and timers aren't finer than that
export const VSYNC_MIN_WAIT = 1;

/**
 * Which scheduler drives frames: VSYNC_UNCAPPED only with vid_vsync 0 in a
 * visible tab outside WebXR (an XR session has to draw on its own frames,
 * and a hidden tab shouldn't spin).
 */
export function VID_FrameMode(vsync, hidden, xr) {
  if (vsync !== 0 || hidden === true || xr === true) return VSYNC_RAF;
  return VSYNC_UNCAPPED;
}

/**
 * Milliseconds between uncapped frames for host_maxfps (0 = no cap, paced
 * at VSYNC_MAX_FPS). A timedemo isn't paced (0), as _Host_FilterTime doesn't
 * cap it either.
 */
export function VID_UncappedInterval(maxfps, timedemo) {
  if (timedemo === true) return 0;
  return 1000 / (maxfps > 0 ? Math.min(maxfps, VSYNC_MAX_FPS) : VSYNC_MAX_FPS);
}

/**
 * When the frame after one that began at now is due (ms), given when this
 * one was due. Keeping to the schedule makes up for timers that fire late,
 * so the average holds host_maxfps; a frame more than an interval behind
 * (a hitch, a slow frame) starts the schedule again from now.
 */
export function VID_UncappedNext(due, now, interval) {
  const next = due + interval;
  return next < now ? now + interval : next;
}

let vsync_frame = null; // (nowMs) => boolean, set by VID_StartFrameLoop
let vsync_interval = null; // () => VID_UncappedInterval(...)
let vsync_renderer = null;
let vsync_channel = null;
let vsync_running = false; // the uncapped loop has a frame or wait queued
let vsync_due = 0; // performance.now() time the next uncapped frame is due

function VID_CurrentMode() {
  return VID_FrameMode(
    vid_vsync.value,
    document.visibilityState === "hidden",
    // what makes Three.js run the animation loop on the XR session's frames
    // (webxr.js isXRActive, without the import cycle back to vid.js)
    vsync_renderer.xr !== undefined && vsync_renderer.xr.isPresenting === true,
  );
}

// A message runs the next frame, or waits for it. The wait's setTimeout is
// set from a message task, not a timer, so the browser's 4 ms clamp on
// nested timers doesn't apply to it.
function VID_UncappedMessage() {
  const wait = vsync_due - performance.now();
  if (wait >= VSYNC_MIN_WAIT) {
    setTimeout(VID_UncappedFrame, wait);
    return;
  }
  VID_UncappedFrame();
}

function VID_UncappedFrame() {
  if (vsync_channel === null || VID_CurrentMode() !== VSYNC_UNCAPPED) {
    vsync_running = false; // requestAnimationFrame takes over
    return;
  }
  const now = performance.now();
  // frame returns false when it didn't run one (the agent's lockstep):
  // stop until the next animation frame, rather than spin
  if (vsync_frame(now) === false) {
    vsync_running = false;
    return;
  }
  vsync_due = VID_UncappedNext(vsync_due, now, vsync_interval());
  vsync_channel.port2.postMessage(null);
}

function VID_AnimationFrame(timestamp) {
  if (vsync_channel === null || VID_CurrentMode() === VSYNC_RAF) {
    vsync_frame(timestamp);
    return;
  }
  if (vsync_running === false) {
    vsync_running = true;
    vsync_due = 0;
    vsync_channel.port2.postMessage(null);
  }
}

/**
 * Starts the frame loop: renderer.setAnimationLoop (requestAnimationFrame, or
 * the XR session's) always runs, and either calls frame itself or, with
 * vid_vsync 0, starts the uncapped loop if it has stopped. frame gets a
 * timestamp in milliseconds on the performance.now() clock and returns false
 * if it ran no frame; interval returns the uncapped loop's pacing in ms
 * (VID_UncappedInterval).
 */
export function VID_StartFrameLoop(renderer, frame, interval) {
  vsync_frame = frame;
  vsync_interval = interval;
  vsync_renderer = renderer;
  if (typeof MessageChannel === "function") {
    vsync_channel = new MessageChannel();
    vsync_channel.port1.onmessage = VID_UncappedMessage;
  }
  renderer.setAnimationLoop(VID_AnimationFrame);
}

/** Stops the frame loop VID_StartFrameLoop started. */
export function VID_StopFrameLoop() {
  if (vsync_renderer !== null) vsync_renderer.setAnimationLoop(null);
  if (vsync_channel !== null) {
    vsync_channel.port1.close();
    vsync_channel.port2.close();
  }
  vsync_renderer = null;
  vsync_channel = null;
  vsync_running = false;
}

/** Registers vid_vsync (VID_Init). */
export function VID_VSync_Init() {
  Cvar_RegisterVariable(vid_vsync);
}
