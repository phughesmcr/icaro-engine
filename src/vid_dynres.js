// Dynamic resolution (web-only, no C equivalent). With vid_dynres 1, the 3D
// view's drawing buffer shrinks in coarse steps while frames come slower than
// they should, and grows back when they keep up, so a phone that can't hold
// its frame rate in a big room trades sharpness for smoothness instead. The
// 2D overlay (menus, HUD, console) is a separate canvas and stays sharp.
//
// "Slower than they should" compares an EMA of the wall-clock time between
// rendered frames with the interval host_maxfps and the display's refresh
// allow: a 72 fps cap on a 60 Hz screen draws every vsync (16.7 ms), on a
// 90 Hz screen every second one (22.2 ms), and neither is the GPU's fault.
// The refresh interval is the shortest seen since the page loaded (a resize
// or rotation doesn't change the screen), so a game already GPU-bound before
// any frame came at the refresh rate (the menus and demos normally do) isn't
// seen as slow, and a screen that slows down later (iOS Low Power Mode's
// 30 Hz) reads as slow and steps down.
//
// At full speed the EMA can't show headroom, so a step up is a probe: it
// waits DYNRES_UP_DELAY seconds, and each probe that has to step down again
// doubles the wait (to DYNRES_UP_DELAY_MAX), so the scale doesn't oscillate.
// Gaps over DYNRES_MAX_GAP (a hidden tab, a map load, a shader hitch) are not
// samples.

import { Cvar_RegisterVariable } from "./cvar.js";
import { Sys_FloatTime } from "./sys.js";
import { renderer, vid, VID_SetDynamicScale } from "./vid.js";

/** vid_dynres: 0 off (the default), 1 on. Archived. */
export const vid_dynres = {
  name: "vid_dynres",
  string: "0",
  value: 0,
  archive: true,
};

/** The scales tried, from full to the floor (times ?scale=, the ceiling). */
export const DYNRES_STEPS = [1, 0.85, 0.7, 0.6, 0.5];

const DYNRES_EMA = 0.1; // weight of each new interval
const DYNRES_SLOW = 1.25; // EMA over this many expected intervals is slow
const DYNRES_FAST = 1.08; // ...and under this many keeps up
const DYNRES_DOWN_AFTER = 0.5; // seconds slow before a step down
const DYNRES_SETTLE = 1; // seconds after a step before the next decision
export const DYNRES_UP_DELAY = 4; // seconds keeping up before a probe up
export const DYNRES_UP_DELAY_MAX = 60;
const DYNRES_PROBE_OK = 10; // a probe this old has stuck: reset the delay
const DYNRES_MAX_GAP = 0.25;
const DYNRES_MIN_GAP = 1 / 250; // shorter isn't a refresh interval

/** A fresh controller state (one per page; tests make their own). */
export function DynRes_NewState() {
  return {
    level: 0, // index into DYNRES_STEPS
    last: 0, // time of the previous sample, 0 = none
    ema: 0,
    vsync: Infinity, // shortest interval seen
    slow: 0, // seconds slow in a row
    fast: 0, // seconds keeping up in a row
    settle: 0, // seconds before the next decision
    upDelay: DYNRES_UP_DELAY,
    probeAt: 0, // time of the last step up still on probation, 0 = none
  };
}

/**
 * Forgets the timing, keeping the level, the probe back-off and the refresh
 * interval.
 */
export function DynRes_ResetTiming(st) {
  st.last = 0;
  st.ema = 0;
  st.slow = 0;
  st.fast = 0;
  st.settle = DYNRES_SETTLE;
}

/**
 * The interval a frame should take: the host_maxfps interval (0 = no cap)
 * rounded up to whole refresh intervals.
 */
export function DynRes_Expected(maxfps, vsync) {
  const cap = maxfps > 0 ? 1 / maxfps : 0;
  if (!(vsync < Infinity)) return cap;
  // 5% slack: a 72 fps cap on a 72 Hz screen is one interval, not two
  return vsync * Math.max(1, Math.ceil(cap / vsync - 0.05));
}

/**
 * One rendered frame at wall-clock time now (seconds). Returns the new level
 * (an index into DYNRES_STEPS) when it changes, else -1.
 */
export function DynRes_Sample(st, now, maxfps) {
  const dt = now - st.last;
  const first = st.last === 0;
  st.last = now;
  if (first || dt > DYNRES_MAX_GAP || dt <= 0) return -1;

  if (dt >= DYNRES_MIN_GAP && dt < st.vsync) st.vsync = dt;
  st.ema = st.ema === 0 ? dt : st.ema + (dt - st.ema) * DYNRES_EMA;

  // a probe that held long enough: the next one waits the base delay again
  if (st.probeAt !== 0 && now - st.probeAt > DYNRES_PROBE_OK) {
    st.probeAt = 0;
    st.upDelay = DYNRES_UP_DELAY;
  }

  if (st.settle > 0) {
    st.settle -= dt;
    return -1;
  }

  const ratio = st.ema / DynRes_Expected(maxfps, st.vsync);
  if (ratio > DYNRES_SLOW) {
    st.slow += dt;
    st.fast = 0;
  } else if (ratio < DYNRES_FAST) {
    st.fast += dt;
    st.slow = 0;
  } else {
    st.slow = 0;
    st.fast = 0;
  }

  if (st.slow >= DYNRES_DOWN_AFTER && st.level < DYNRES_STEPS.length - 1) {
    if (st.probeAt !== 0) {
      // the probe failed: wait longer before the next
      st.upDelay = Math.min(st.upDelay * 2, DYNRES_UP_DELAY_MAX);
      st.probeAt = 0;
    }
    st.level++;
    st.slow = 0;
    st.fast = 0;
    st.ema = 0;
    st.settle = DYNRES_SETTLE;
    return st.level;
  }

  if (st.fast >= st.upDelay && st.level > 0) {
    st.level--;
    st.probeAt = now;
    st.slow = 0;
    st.fast = 0;
    st.ema = 0;
    st.settle = DYNRES_SETTLE;
    return st.level;
  }

  return -1;
}

/** The page's controller state (exported for tests). */
export const dynres_state = DynRes_NewState();
let dynres_width = 0;
let dynres_height = 0;

/** Registers vid_dynres (VID_Init). */
export function VID_DynResInit() {
  Cvar_RegisterVariable(vid_dynres);
}

/**
 * Once a frame, before the screen is drawn (Host_Frame), so a new buffer size
 * never clears a drawn frame. Does nothing without a renderer (the server and
 * the headless host); hold is true during a timedemo or while a WebXR session
 * presents, and puts the full scale back.
 */
export function VID_DynResFrame(maxfps, hold) {
  if (renderer === null) return;

  if (vid_dynres.value === 0 || hold === true) {
    if (dynres_state.level !== 0) {
      dynres_state.level = 0;
      VID_SetDynamicScale(1);
    }
    dynres_state.last = 0;
    return;
  }

  // a resize (rotation, a new window size) changes the work and maybe the
  // screen: start the timing again, keeping the current step
  if (vid.width !== dynres_width || vid.height !== dynres_height) {
    dynres_width = vid.width;
    dynres_height = vid.height;
    DynRes_ResetTiming(dynres_state);
  }

  const level = DynRes_Sample(dynres_state, Sys_FloatTime(), maxfps);
  if (level !== -1) VID_SetDynamicScale(DYNRES_STEPS[level]);
}
