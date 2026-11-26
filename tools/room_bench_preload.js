// Preloaded into a game_server.js room by tools/room_bench.js (deno run
// --preload). It reports the room's memory, CPU time and the wall time of each
// server tick on stderr as "ROOM_BENCH {json}" lines. Not used by the game.

import process from "node:process";

const t0 = performance.now();
const cpu0 = process.cpuUsage();
const durations = [];
let tickStart = null;
let ticks = 0;
let peakRss = 0;
let peakIsolate = 0;

function memory() {
  const m = Deno.memoryUsage();
  if (m.rss > peakRss) peakRss = m.rss;
  // What a Workers isolate would count: the JS heap plus ArrayBuffers and
  // other off-heap allocations held by JS objects
  const isolate = m.heapTotal + m.external;
  if (isolate > peakIsolate) peakIsolate = isolate;
  return m;
}

function report(kind) {
  const m = memory();
  const cpu = process.cpuUsage(cpu0);
  const sorted = durations.slice().sort((a, b) => a - b);
  const pick = (q) =>
    sorted.length > 0 ?
      sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] :
      0;
  const sum = sorted.reduce((a, b) => a + b, 0);
  console.error(
    "ROOM_BENCH " + JSON.stringify({
      kind,
      t: Math.round(performance.now() - t0),
      tickStartMs: tickStart,
      ticks,
      rss: m.rss,
      heapUsed: m.heapUsed,
      heapTotal: m.heapTotal,
      external: m.external,
      peakRss,
      peakIsolate,
      cpuUserMs: cpu.user / 1000,
      cpuSystemMs: cpu.system / 1000,
      tickMeanMs: sorted.length > 0 ? sum / sorted.length : 0,
      tickP50Ms: pick(0.5),
      tickP95Ms: pick(0.95),
      tickP99Ms: pick(0.99),
      tickMaxMs: pick(1),
      samples: sorted.length,
    }),
  );
}

// Wrap the server loop's setInterval (the only one at sys_ticrate, 50 ms) to
// time each tick. Room_ReportStatus and the rest of the callback are included.
const nativeSetInterval = globalThis.setInterval;
globalThis.setInterval = function (fn, ms, ...args) {
  if (ms !== 50 || typeof fn !== "function") {
    return nativeSetInterval(fn, ms, ...args);
  }

  tickStart = Math.round(performance.now() - t0);
  report("init");
  // Started here, not at the top level: deno run --preload waits for the
  // preload's event loop to drain before it runs the main module.
  nativeSetInterval(() => memory(), 1000);
  return nativeSetInterval(() => {
    const s = performance.now();
    fn(...args);
    durations.push(performance.now() - s);
    ticks++;
  }, ms);
};

// The bench asks for a report (and a reset of the tick samples) by sending
// SIGUSR1 at the start of each measured window, SIGUSR2 at the end.
Deno.addSignalListener("SIGUSR1", () => {
  report("window-start");
  durations.length = 0;
});
Deno.addSignalListener("SIGUSR2", () => report("window-end"));
