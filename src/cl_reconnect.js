// Web-only addition: no C equivalent.
//
// Reconnect after a lost multiplayer connection. WinQuake treats a dead
// connection as fatal (Host_Error in CL_ReadFromServer). A browser loses its
// connection far more often: iOS freezes a background page, or the phone
// moves from Wi-Fi to cellular. This module remembers the address of the
// remote server the client joined and, when the connection is lost (not when
// the player or the server ended it), runs the connect again with bounded,
// backing-off retries. The player gets a fresh slot: NetQuake has no identity
// to resume, so score and inventory start over.
//
// Browser-hosted WebRTC rooms ("rtc:<code>") are retried the same way: each
// attempt joins the room by code through the lobby again and offers the host a
// new peer connection (net_webrtc.js). When the lobby says the room is gone
// (its host left), the driver calls CLR_GiveUp, which ends the retries at once
// with that reason instead of running through the remaining attempts.
//
// The module touches no browser global at import time: CL_Init calls
// CLR_Init, which registers the page listeners if the page has them.

export const CLR_MAX_ATTEMPTS = 6;
export const CLR_BACKOFF_BASE_MS = 1000;
export const CLR_BACKOFF_MAX_MS = 8000;
// A connection that stayed up this long is a fresh start: its next loss gets
// a full set of attempts. A shorter one (the server accepts us and drops us
// again) keeps counting, so a flapping server can't hold the client in a loop.
export const CLR_STABLE_MS = 15000;

/** Delay before attempt number n (0-based): 1 s, 2 s, 4 s, then 8 s. */
export function CLR_BackoffMs(n) {
  if (n < 0) n = 0;
  return Math.min(CLR_BACKOFF_BASE_MS * Math.pow(2, n), CLR_BACKOFF_MAX_MS);
}

/**
 * True for an address a plain connect can be repeated for: a remote
 * WebTransport, WebSocket or WebRTC room address, not the loopback "local".
 */
export function CLR_IsReconnectable(host) {
  if (typeof host !== "string" || host.length === 0) return false;
  if (host.toLowerCase() === "local") return false;
  return true;
}

// Dependencies, set by CLR_Init (cl_main.js; tests pass fakes):
//   connect( host )  async; true when the connect succeeded (quiet: shows no menu)
//   canReconnect()   false in a local game or demo, or when dedicated
//   isHidden()       true while the page is in the background
//   print( str )     console line
//   notify( str )    on-screen message
//   giveUp( str )    out of attempts: tell the player and return to the menu
//   now()            milliseconds
//   setTimer( fn, ms ) / clearTimer( id )
let deps = null;

let session = null; // { host } while a remote connection is worth restoring
let phase = "idle"; // 'idle', 'waiting' (a retry is scheduled), 'connecting'
let attempts = 0;
let timer = null;
let epoch = 0; // bumped by cancel, so a stale connect result is ignored
let connectedAt = 0;
let listeners_installed = false;

export function CLR_Phase() {
  return phase;
}
export function CLR_Attempts() {
  return attempts;
}
export function CLR_HasSession() {
  return session !== null;
}

/**
 * Install the dependencies and, in a browser, the wake-up listeners. Safe to
 * call again: the listeners are installed once, the state is reset each time.
 */
export function CLR_Init(d) {
  CLR_Cancel();
  deps = d;

  if (
    listeners_installed === false && typeof window !== "undefined" &&
    typeof document !== "undefined"
  ) {
    listeners_installed = true;
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") CLR_OnWake();
    });
    window.addEventListener("pageshow", CLR_OnWake);
    window.addEventListener("online", CLR_OnWake);
  }
}

function _clearTimer() {
  if (timer !== null && deps !== null) deps.clearTimer(timer);
  timer = null;
}

/** A connect to host succeeded. */
export function CLR_Connected(host) {
  _clearTimer();
  phase = "idle";
  if (CLR_IsReconnectable(host) === false) {
    session = null;
    attempts = 0;
    return;
  }

  session = { host };
  connectedAt = deps !== null ? deps.now() : 0;
}

/**
 * The player (or the server) ended the connection, or started another one:
 * forget the session and drop any retry in flight.
 */
export function CLR_Cancel() {
  _clearTimer();
  epoch++;
  session = null;
  phase = "idle";
  attempts = 0;
}

/**
 * True when a lost connection should be restored rather than treated as fatal.
 */
export function CLR_CanReconnect() {
  return deps !== null && session !== null && deps.canReconnect() === true;
}

function _schedule(ms) {
  _clearTimer();
  phase = "waiting";
  timer = deps.setTimer(_attempt, ms);
}

/** The connection died (CL_Disconnect saw it). Start the retries. */
export function CLR_ConnectionLost() {
  if (CLR_CanReconnect() === false) {
    CLR_Cancel();
    return false;
  }

  if (phase !== "idle") return true;

  if (deps.now() - connectedAt >= CLR_STABLE_MS) attempts = 0;
  if (attempts >= CLR_MAX_ATTEMPTS) {
    // A server that keeps accepting and dropping us: stop
    CLR_Cancel();
    deps.giveUp("Lost connection to the server and could not reconnect");
    return false;
  }

  deps.print("Connection to " + session.host + " lost\n");
  deps.notify("Reconnecting...");
  _schedule(CLR_BackoffMs(attempts));
  return true;
}

async function _attempt() {
  timer = null;
  if (session === null) return;

  if (deps.canReconnect() === false) {
    CLR_Cancel();
    return;
  }

  // Retry when the page returns: a hidden page's network is unreliable and
  // its timers may be frozen.
  if (deps.isHidden() === true) {
    phase = "waiting";
    return;
  }

  const myEpoch = epoch;
  const host = session.host;
  attempts++;
  phase = "connecting";
  deps.print(
    "Reconnecting to " + host + " (" + attempts + "/" + CLR_MAX_ATTEMPTS +
      ")...\n",
  );
  deps.notify("Reconnecting... (" + attempts + "/" + CLR_MAX_ATTEMPTS + ")");

  let ok = false;
  try {
    ok = await deps.connect(host);
  } catch {
    ok = false;
  }

  if (myEpoch !== epoch) return; // cancelled while connecting

  if (ok === true) {
    CLR_Connected(host);
    deps.print("Reconnected\n");
    deps.notify("");
    return;
  }

  if (attempts >= CLR_MAX_ATTEMPTS) {
    CLR_Cancel();
    deps.notify("");
    deps.giveUp("Lost connection to the server and could not reconnect");
    return;
  }

  _schedule(CLR_BackoffMs(attempts));
}

/**
 * A retry's connect learnt that the server is gone for good (a browser-hosted
 * room whose host left): stop retrying and tell the player why. Only a retry in
 * flight is ended; returns false (and does nothing) otherwise, so a connect the
 * player started reports its own failure.
 */
export function CLR_GiveUp(reason) {
  if (deps === null || session === null || phase !== "connecting") return false;
  CLR_Cancel();
  deps.notify("");
  deps.giveUp(reason);
  return true;
}

/**
 * The page became visible, was shown again, or the browser came back online:
 * if a retry is waiting, run it now.
 */
export function CLR_OnWake() {
  if (deps === null || session === null || phase !== "waiting") return;
  _clearTimer();
  _attempt();
}
