// Web-only addition: no C equivalent.
//
// A dedicated Worker that ticks for host_hidden.js while the page hosting a
// room is hidden. Chrome holds a hidden page's own timers to one run a second
// but not a Worker's, and the page still gets the Worker's messages at once,
// so each message runs one host frame on the page. Post a number of
// milliseconds to tick at that interval, or 0 to stop. A classic Worker with
// no imports, so it loads under the deployed CSP (worker-src 'self') without
// the page's import map.

/** @type {any} */
const scope = globalThis;
let tick_timer = null;

scope.addEventListener("message", (/** @type {MessageEvent} */ e) => {
  if (tick_timer !== null) {
    clearInterval(tick_timer);
    tick_timer = null;
  }
  const ms = e.data;
  if (typeof ms === "number" && ms > 0) {
    tick_timer = setInterval(() => scope.postMessage(0), ms);
  }
});
