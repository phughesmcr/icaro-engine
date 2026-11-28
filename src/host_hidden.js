// Web-only addition: no C equivalent.
//
// Keeps a room hosted in this browser (net_rtclobby.js) running while its tab
// is hidden. The frame loop is requestAnimationFrame (main.js), which stops in
// a hidden tab, so the listen server stops and every joiner sees a frozen
// game. Measured in desktop Chrome 158 with the tab behind another tab
// (docs/browser-hosted-rooms.md, "Hidden host"): a hidden page's own
// setInterval( 50 ) runs once a second, while a dedicated Worker's runs every
// 50 ms and its messages reach the page at once. So while the host is hidden
// a Worker (host_tick_worker.js) ticks at sys_ticrate's 20 Hz, as the
// dedicated server does, and each tick runs main.js's frame function, the
// same one the animation loop runs, with one clock between them.
//
// Phones freeze a hidden page, Workers and all, so nothing here keeps a room
// alive on a locked phone. For those this module holds a Screen Wake Lock
// while hosting (so the screen doesn't lock by itself), warns the host when
// the room starts, and tells the joiners when the host's tab goes into the
// background and when it comes back. Joiners also show their own notice when
// the host goes quiet (cl_reconnect.js), which covers a host that froze
// before it could say so.
//
// No browser global is touched at import time.

import { MSG_WriteByte, MSG_WriteString } from "./common.js";
import { Con_Printf } from "./console.js";
import { svc_print } from "./protocol.js";
import { svs } from "./server.js";
import { VID_SetDynamicScale } from "./vid.js";
import {
  DynRes_ResetTiming,
  dynres_state,
  DYNRES_STEPS,
} from "./vid_dynres.js";
import { WakeLock_Hold, WakeLock_Release } from "./wake_lock.js";
import { isXRActive } from "./webxr.js";

/** The hidden tick: sys_ticrate's 20 Hz, as server/game_server.js runs. */
export const HOSTHIDDEN_TICK_MS = 50;

/** The wake lock reason held while hosting (wake_lock.js). */
export const HOSTHIDDEN_WAKE_REASON = "host";

/** The console warning when a room starts in this tab. */
export const HOSTHIDDEN_WARNING =
  "Keep this tab in front and the screen on while you host: in the " +
  "background the game slows or stops for everyone, and a phone stops it " +
  "when the screen locks.\n";

/** What the joiners are told when the host's tab is hidden. */
export const HOSTHIDDEN_AWAY_MESSAGE =
  "The host's game is in the background: play may stall until it returns\n";

/** What the joiners are told when it is shown again. */
export const HOSTHIDDEN_BACK_MESSAGE = "The host's game is back\n";

/**
 * Which driver should run the host's frames: "raf" (main.js's animation loop;
 * nothing to do here), "worker" (host_tick_worker.js) or "timer" (the page's
 * own setTimeout, which a hidden page runs at most once a second). Only a
 * hidden page that hosts a room, outside WebXR (whose session runs its own
 * frames), needs one.
 */
export function HostHidden_ChooseDriver(hidden, hosting, workerUsable, xr) {
  if (hidden !== true || hosting !== true || xr === true) return "raf";
  return workerUsable === true ? "worker" : "timer";
}

/**
 * The host's console line when its tab is shown again after awayMs hidden
 * with the given driver.
 */
export function HostHidden_ReturnMessage(awayMs, driver) {
  const seconds = Math.max(0, Math.round(awayMs / 1000));
  let line = "This tab was in the background for " + seconds + " s";
  if (driver === "timer") {
    line += ": this browser ran the game at about one frame a second";
  }
  return line + "\n";
}

let hosthidden_frame = null; // main.js's frame function (timestamp in ms)
let hosthidden_hosting = false;
let hosthidden_hidden = false;
let hosthidden_driver = "raf";
let hosthidden_worker = null;
let hosthidden_worker_failed = false;
let hosthidden_timer = null;
let hosthidden_away_since = 0;
let hosthidden_away_driver = "raf";
let hosthidden_dynres_level = 0;

/**
 * main.js: frame( timestamp ) is the animation loop's body, with timestamps
 * on performance.now()'s clock. Safe to call more than once.
 */
export function HostHidden_Init(frame) {
  const first = hosthidden_frame === null;
  hosthidden_frame = frame;
  if (first === false || typeof document === "undefined") return;
  hosthidden_hidden = document.visibilityState === "hidden";
  document.addEventListener("visibilitychange", () => {
    HostHidden_SetHidden(document.visibilityState === "hidden");
  });
}

/**
 * net_rtclobby.js: a room hosted here was listed (true) or has ended
 * (false).
 */
export function HostHidden_SetHosting(on) {
  if (on === hosthidden_hosting) return;
  hosthidden_hosting = on;
  if (on === true) {
    WakeLock_Hold(HOSTHIDDEN_WAKE_REASON);
    Con_Printf("%s", HOSTHIDDEN_WARNING);
    // The room was listed after the tab was hidden: count the time away
    // from now, so the return is reported as for a hide while hosting
    if (hosthidden_hidden === true) {
      hosthidden_away_since = performance.now();
      hosthidden_dynres_level = dynres_state.level;
    }
  } else {
    WakeLock_Release(HOSTHIDDEN_WAKE_REASON);
    hosthidden_away_since = 0;
  }
  _HostHidden_Update();
}

/** True while a room hosted here is running. */
export function HostHidden_IsHosting() {
  return hosthidden_hosting;
}

/** The driver running now: "raf", "worker" or "timer". */
export function HostHidden_Driver() {
  return hosthidden_driver;
}

/** The page was hidden (true) or shown again (false). */
export function HostHidden_SetHidden(hidden) {
  if (hidden === hosthidden_hidden) return;
  hosthidden_hidden = hidden;

  if (hosthidden_hosting === true) {
    if (hidden === true) {
      hosthidden_away_since = performance.now();
      hosthidden_dynres_level = dynres_state.level;
      HostHidden_TellJoiners(HOSTHIDDEN_AWAY_MESSAGE);
      // A phone may freeze the page as soon as this handler returns: send
      // the notice now rather than on the next tick
      _HostHidden_RunFrame();
    } else if (hosthidden_away_since !== 0) {
      Con_Printf(
        "%s",
        HostHidden_ReturnMessage(
          performance.now() - hosthidden_away_since,
          hosthidden_away_driver,
        ),
      );
      hosthidden_away_since = 0;
      HostHidden_TellJoiners(HOSTHIDDEN_BACK_MESSAGE);
      _HostHidden_RestoreDynRes();
    }
  }

  hosthidden_away_driver = "raf";
  _HostHidden_Update();
}

/**
 * svc_print msg to every spawned remote client, as SV_BroadcastPrintf does
 * but without the host's own player (the loopback connection, driver 0),
 * which gets HostHidden_ReturnMessage instead. Returns how many were told.
 */
export function HostHidden_TellJoiners(msg) {
  let told = 0;
  for (let i = 0; i < svs.maxclients; i++) {
    const client = svs.clients[i];
    if (client == null || client.active !== true || client.spawned !== true) {
      continue;
    }
    const sock = client.netconnection;
    if (sock === null || sock === undefined || sock.driver === 0) continue;
    MSG_WriteByte(client.message, svc_print);
    MSG_WriteString(client.message, msg);
    told++;
  }
  return told;
}

// vid_dynres reads the 20 Hz hidden frames as slow and steps the resolution
// down: put back the step the page had when it was hidden
function _HostHidden_RestoreDynRes() {
  if (dynres_state.level === hosthidden_dynres_level) return;
  dynres_state.level = hosthidden_dynres_level;
  DynRes_ResetTiming(dynres_state);
  VID_SetDynamicScale(DYNRES_STEPS[hosthidden_dynres_level]);
}

function _HostHidden_RunFrame() {
  if (hosthidden_frame !== null) hosthidden_frame(performance.now());
}

function _HostHidden_Update() {
  const want = HostHidden_ChooseDriver(
    hosthidden_hidden,
    hosthidden_hosting,
    hosthidden_worker_failed === false && typeof Worker !== "undefined",
    isXRActive(),
  );
  if (want === hosthidden_driver) return;
  _HostHidden_Stop();
  hosthidden_driver = want;
  if (want === "worker") {
    if (_HostHidden_StartWorker() === false) {
      hosthidden_driver = "timer";
      _HostHidden_StartTimer();
    }
  } else if (want === "timer") {
    _HostHidden_StartTimer();
  }
}

function _HostHidden_Stop() {
  if (hosthidden_worker !== null) hosthidden_worker.postMessage(0);
  if (hosthidden_timer !== null) {
    clearTimeout(hosthidden_timer);
    hosthidden_timer = null;
  }
}

function _HostHidden_StartWorker() {
  if (hosthidden_worker === null) {
    try {
      hosthidden_worker = new Worker(
        new URL("./host_tick_worker.js", import.meta.url),
      );
    } catch (err) {
      console.log(
        "Hidden host ticker unavailable:",
        err instanceof Error ? err.message : String(err),
      );
      hosthidden_worker_failed = true;
      return false;
    }
    hosthidden_worker.onmessage = _HostHidden_OnTick;
    // A Worker that fails to load (a CSP refusal, a 404) reports it here:
    // fall back to the page's own timer
    hosthidden_worker.onerror = () => {
      hosthidden_worker_failed = true;
      if (hosthidden_worker !== null) hosthidden_worker.terminate();
      hosthidden_worker = null;
      if (hosthidden_driver === "worker") {
        hosthidden_driver = "raf";
        _HostHidden_Update();
      }
    };
  }
  hosthidden_worker.postMessage(HOSTHIDDEN_TICK_MS);
  return true;
}

function _HostHidden_OnTick() {
  // A tick queued before the driver stopped
  if (hosthidden_driver !== "worker") return;
  _HostHidden_RunFrame();
}

function _HostHidden_StartTimer() {
  hosthidden_away_driver = "timer";
  hosthidden_timer = setTimeout(_HostHidden_OnTimer, HOSTHIDDEN_TICK_MS);
}

function _HostHidden_OnTimer() {
  hosthidden_timer = null;
  if (hosthidden_driver !== "timer") return;
  _HostHidden_RunFrame();
  _HostHidden_StartTimer();
}
