// Web-only addition: no C equivalent.
//
// One Screen Wake Lock for every feature that wants the screen kept on: touch
// play (touch.js) and hosting a room in this browser (host_hidden.js). Each
// holds it under its own reason, and the lock is released when the last
// reason goes. The browser releases the lock whenever the page is hidden, so
// it is asked for again when the page comes back.
//
// No browser global is touched at import time; tests swap the platform with
// WakeLock_SetPlatform.

/** @type {Set<string>} */
const wakelock_reasons = new Set();
let wakelock_sentinel = null;
let wakelock_pending = false;
let wakelock_platform = null; // { nav, doc } from WakeLock_SetPlatform
let wakelock_listening = false;

/**
 * Replace navigator and document (tests); null goes back to the page's,
 * read when used. Forgets the reasons and any lock.
 */
export function WakeLock_SetPlatform(nav, doc) {
  wakelock_platform = nav === null && doc === null ? null : { nav, doc };
  wakelock_reasons.clear();
  wakelock_sentinel = null;
  wakelock_pending = false;
  wakelock_listening = false;
}

/** Keep the screen on for reason (until WakeLock_Release(reason)). */
export function WakeLock_Hold(reason) {
  wakelock_reasons.add(reason);
  _WakeLock_Listen();
  _WakeLock_Request();
}

/** reason no longer needs the screen on; the last one releases the lock. */
export function WakeLock_Release(reason) {
  if (wakelock_reasons.delete(reason) === false) return;
  if (wakelock_reasons.size > 0) return;
  if (wakelock_sentinel !== null) {
    const lock = wakelock_sentinel;
    wakelock_sentinel = null;
    lock.release().catch(() => {});
  }
}

/** True while the browser holds the lock for us. */
export function WakeLock_Held() {
  return wakelock_sentinel !== null;
}

/** True while reason holds the lock (granted or not). */
export function WakeLock_IsHeldFor(reason) {
  return wakelock_reasons.has(reason);
}

/** True while a request is waiting for the browser's answer (tests). */
export function WakeLock_Pending() {
  return wakelock_pending;
}

function _WakeLock_Nav() {
  if (wakelock_platform !== null) return wakelock_platform.nav;
  return typeof navigator !== "undefined" ? navigator : null;
}

function _WakeLock_Doc() {
  if (wakelock_platform !== null) return wakelock_platform.doc;
  return typeof document !== "undefined" ? document : null;
}

function _WakeLock_Listen() {
  const doc = _WakeLock_Doc();
  if (wakelock_listening === true || doc === null || doc === undefined) return;
  if (typeof doc.addEventListener !== "function") return;
  wakelock_listening = true;
  doc.addEventListener("visibilitychange", _WakeLock_OnVisibility);
}

// The browser drops the lock while the page is hidden: take it back
function _WakeLock_OnVisibility() {
  const doc = _WakeLock_Doc();
  if (doc !== null && doc !== undefined && doc.visibilityState === "visible") {
    _WakeLock_Request();
  }
}

async function _WakeLock_Request() {
  if (wakelock_reasons.size === 0) return;
  if (wakelock_sentinel !== null || wakelock_pending === true) return;
  const nav = _WakeLock_Nav();
  if (
    nav === null || nav === undefined || nav.wakeLock === undefined ||
    nav.wakeLock === null
  ) return;

  // Refused while the page is hidden; the visibilitychange handler retries
  const doc = _WakeLock_Doc();
  if (doc === null || doc === undefined || doc.visibilityState !== "visible") {
    return;
  }

  wakelock_pending = true;
  try {
    const lock = await nav.wakeLock.request("screen");

    // Every reason went while the request was pending
    if (wakelock_reasons.size === 0) {
      lock.release().catch(() => {});
      return;
    }

    wakelock_sentinel = lock;
    lock.addEventListener("release", () => {
      if (wakelock_sentinel === lock) wakelock_sentinel = null;
    });
  } catch (err) {
    console.log(
      "Wake Lock request failed:",
      err instanceof Error ? err.message : String(err),
    );
  } finally {
    wakelock_pending = false;
  }
}
