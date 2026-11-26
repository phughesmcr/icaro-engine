// Tests for the reconnect controller (src/cl_reconnect.js): backoff, address
// filtering, retry bounds, and the cases that must not reconnect.

const r = await import("../src/cl_reconnect.js");

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

// Fake dependencies with a manual clock and timer list
function makeEnv(opts = {}) {
  const env = {
    time: 0,
    timers: [],
    nextId: 1,
    log: [],
    notes: [],
    giveUps: [],
    connects: [],
    results: opts.results ?? [],
    allowed: true,
    hidden: false,
    pending: null,
  };
  env.deps = {
    connect: (host) => {
      env.connects.push(host);
      if (env.pending !== null) return env.pending;
      const res = env.results.length > 0 ? env.results.shift() : false;
      if (res instanceof Error) return Promise.reject(res);
      return Promise.resolve(res);
    },
    canReconnect: () => env.allowed,
    isHidden: () => env.hidden,
    print: (s) => env.log.push(s),
    notify: (s) => env.notes.push(s),
    giveUp: (s) => env.giveUps.push(s),
    now: () => env.time,
    setTimer: (fn, ms) => {
      const id = env.nextId++;
      env.timers.push({ id, fn, ms });
      return id;
    },
    clearTimer: (id) => {
      env.timers = env.timers.filter((t) => t.id !== id);
    },
  };
  // Fire the next timer and let its async work settle
  env.fire = async () => {
    const t = env.timers.shift();
    if (t === undefined) throw new Error("no timer pending");
    await t.fn();
    await Promise.resolve();
    return t.ms;
  };
  r.CLR_Init(env.deps);
  return env;
}

Deno.test("CLR_BackoffMs doubles and caps", () => {
  assertEqual(r.CLR_BackoffMs(0), 1000, "n=0");
  assertEqual(r.CLR_BackoffMs(1), 2000, "n=1");
  assertEqual(r.CLR_BackoffMs(2), 4000, "n=2");
  assertEqual(r.CLR_BackoffMs(3), 8000, "n=3");
  assertEqual(r.CLR_BackoffMs(9), 8000, "capped");
  assertEqual(r.CLR_BackoffMs(-1), 1000, "negative");
});

Deno.test("CLR_IsReconnectable accepts remote addresses and rtc rooms", () => {
  assertEqual(
    r.CLR_IsReconnectable("https://host:4433?room=abc"),
    true,
    "wt room",
  );
  assertEqual(r.CLR_IsReconnectable("wss://host/mp/room/x"), true, "wss");
  assertEqual(r.CLR_IsReconnectable("local"), false, "local");
  assertEqual(r.CLR_IsReconnectable("LOCAL"), false, "LOCAL");
  assertEqual(r.CLR_IsReconnectable("rtc:ABCD"), true, "rtc room");
  assertEqual(r.CLR_IsReconnectable(""), false, "empty");
  assertEqual(r.CLR_IsReconnectable(null), false, "null");
});

Deno.test("a lost connection reconnects to the same address", async () => {
  const env = makeEnv({ results: [true] });
  r.CLR_Connected("https://host:4433?room=abc");
  assertEqual(r.CLR_ConnectionLost(), true, "handled");
  assertEqual(r.CLR_Phase(), "waiting", "phase");
  assertEqual(env.timers[0].ms, 1000, "first delay");
  assertEqual(env.notes[0], "Reconnecting...", "notified");

  await env.fire();
  assertEqual(env.connects.length, 1, "one connect");
  assertEqual(env.connects[0], "https://host:4433?room=abc", "same address");
  assertEqual(r.CLR_Phase(), "idle", "idle after success");
  assertEqual(r.CLR_HasSession(), true, "session kept");
  assertEqual(env.giveUps.length, 0, "no give up");
});

Deno.test("failed attempts back off, then give up after the maximum", async () => {
  const env = makeEnv();
  r.CLR_Connected("wss://host/mp");
  r.CLR_ConnectionLost();

  const delays = [];
  for (let i = 0; i < r.CLR_MAX_ATTEMPTS; i++) {
    delays.push(await env.fire());
  }

  assertEqual(delays.join(","), "1000,2000,4000,8000,8000,8000", "delays");
  assertEqual(env.connects.length, r.CLR_MAX_ATTEMPTS, "attempts");
  assertEqual(env.giveUps.length, 1, "gave up once");
  assertEqual(env.timers.length, 0, "no timer left");
  assertEqual(r.CLR_HasSession(), false, "session forgotten");
  assertEqual(r.CLR_ConnectionLost(), false, "no more reconnecting");
});

Deno.test("a rejected connect counts as a failed attempt", async () => {
  const env = makeEnv({ results: [new Error("boom"), true] });
  r.CLR_Connected("wss://host/mp");
  r.CLR_ConnectionLost();
  await env.fire();
  assertEqual(r.CLR_Phase(), "waiting", "retry scheduled");
  await env.fire();
  assertEqual(r.CLR_Phase(), "idle", "connected");
  assertEqual(env.giveUps.length, 0, "no give up");
});

Deno.test("cancel (disconnect command) stops a pending retry", () => {
  const env = makeEnv();
  r.CLR_Connected("wss://host/mp");
  r.CLR_ConnectionLost();
  r.CLR_Cancel();
  assertEqual(env.timers.length, 0, "timer cleared");
  assertEqual(r.CLR_HasSession(), false, "session gone");
  assertEqual(r.CLR_ConnectionLost(), false, "nothing to restore");
  assertEqual(env.connects.length, 0, "never connected");
});

Deno.test("cancel during a connect discards its result", async () => {
  const env = makeEnv();
  let resolve;
  env.pending = new Promise((res) => {
    resolve = res;
  });
  r.CLR_Connected("wss://host/mp");
  r.CLR_ConnectionLost();
  const fired = env.fire();
  assertEqual(r.CLR_Phase(), "connecting", "connecting");
  r.CLR_Cancel();
  resolve(false);
  await fired;
  assertEqual(env.timers.length, 0, "no retry scheduled");
  assertEqual(env.giveUps.length, 0, "no give up");
});

Deno.test("local games and demos never reconnect", () => {
  const env = makeEnv();
  r.CLR_Connected("local");
  assertEqual(r.CLR_HasSession(), false, "local not remembered");

  r.CLR_Connected("wss://host/mp");
  env.allowed = false; // sv.active or a demo
  assertEqual(r.CLR_ConnectionLost(), false, "refused");
  assertEqual(r.CLR_HasSession(), false, "session dropped");
  assertEqual(env.timers.length, 0, "no timer");
});

Deno.test("a retry that fires after a local game started is dropped", async () => {
  const env = makeEnv();
  r.CLR_Connected("wss://host/mp");
  r.CLR_ConnectionLost();
  env.allowed = false;
  await env.fire();
  assertEqual(env.connects.length, 0, "no connect");
  assertEqual(r.CLR_HasSession(), false, "session dropped");
});

Deno.test("a hidden page waits for the wake-up instead of retrying", async () => {
  const env = makeEnv({ results: [true] });
  r.CLR_Connected("wss://host/mp");
  r.CLR_ConnectionLost();
  env.hidden = true;
  await env.fire();
  assertEqual(env.connects.length, 0, "no connect while hidden");
  assertEqual(r.CLR_Phase(), "waiting", "still waiting");

  env.hidden = false;
  r.CLR_OnWake();
  await Promise.resolve();
  await Promise.resolve();
  assertEqual(env.connects.length, 1, "connects on wake");
  assertEqual(r.CLR_Phase(), "idle", "reconnected");
});

Deno.test("wake skips the backoff delay", async () => {
  const env = makeEnv({ results: [true] });
  r.CLR_Connected("wss://host/mp");
  r.CLR_ConnectionLost();
  r.CLR_OnWake();
  await Promise.resolve();
  await Promise.resolve();
  assertEqual(env.connects.length, 1, "connected at once");
  assertEqual(env.timers.length, 0, "timer cleared");
});

Deno.test("wake does nothing when no retry is waiting", () => {
  const env = makeEnv();
  r.CLR_Connected("wss://host/mp");
  r.CLR_OnWake();
  assertEqual(env.connects.length, 0, "no connect");
});

Deno.test("a connection that drops again at once keeps its attempt count", async () => {
  const env = makeEnv({ results: [false, true] });
  r.CLR_Connected("wss://host/mp");
  r.CLR_ConnectionLost();
  await env.fire();
  await env.fire(); // success after 2 attempts
  assertEqual(r.CLR_Attempts(), 2, "attempts kept");

  env.time += 1000; // dropped again after 1 s: not stable
  r.CLR_ConnectionLost();
  assertEqual(r.CLR_Attempts(), 2, "still counting");
  assertEqual(env.timers[0].ms, 4000, "longer delay");

  r.CLR_Cancel();
  r.CLR_Connected("wss://host/mp");
  env.time += r.CLR_STABLE_MS;
  r.CLR_ConnectionLost();
  assertEqual(
    env.timers[env.timers.length - 1].ms,
    1000,
    "fresh start after a stable connection",
  );
});

Deno.test("a server that accepts and drops us repeatedly ends in a give up", async () => {
  const env = makeEnv({
    results: [true, true, true, true, true, true, true, true],
  });
  r.CLR_Connected("wss://host/mp");
  let handled = true;
  for (let i = 0; i < 10 && handled === true; i++) {
    handled = r.CLR_ConnectionLost();
    if (handled === true) {
      await env.fire();
      env.time += 500;
    }
  }
  assertEqual(handled, false, "loop ended");
  assertEqual(env.giveUps.length, 1, "gave up once");
  assertEqual(r.CLR_HasSession(), false, "session forgotten");
});

Deno.test("a lost rtc room reconnects to the same code", async () => {
  const env = makeEnv({ results: [false, true] });
  r.CLR_Connected("rtc:ABCDEFGH");
  assertEqual(r.CLR_HasSession(), true, "rtc remembered");
  assertEqual(r.CLR_ConnectionLost(), true, "handled");
  await env.fire();
  assertEqual(r.CLR_Phase(), "waiting", "retry after a failed attempt");
  await env.fire();
  assertEqual(env.connects.join(), "rtc:ABCDEFGH,rtc:ABCDEFGH", "same code");
  assertEqual(r.CLR_Phase(), "idle", "reconnected");
  assertEqual(env.giveUps.length, 0, "no give up");
});

Deno.test("CLR_GiveUp ends a retry in flight with its reason, once", async () => {
  const env = makeEnv();
  let resolve;
  env.pending = new Promise((res) => {
    resolve = res;
  });
  r.CLR_Connected("rtc:ABCDEFGH");
  r.CLR_ConnectionLost();
  const fired = env.fire();
  assertEqual(r.CLR_Phase(), "connecting", "connecting");

  // The driver learns the room is gone, then its connect fails
  assertEqual(r.CLR_GiveUp("The host has left the room"), true, "gave up");
  resolve(false);
  await fired;

  assertEqual(env.giveUps.join("|"), "The host has left the room", "reason");
  assertEqual(env.connects.length, 1, "no further attempts");
  assertEqual(env.timers.length, 0, "no retry scheduled");
  assertEqual(r.CLR_HasSession(), false, "session forgotten");
  assertEqual(r.CLR_Phase(), "idle", "idle");
});

Deno.test("CLR_GiveUp does nothing outside a retry's connect", () => {
  const env = makeEnv();
  assertEqual(r.CLR_GiveUp("gone"), false, "no session");

  r.CLR_Connected("rtc:ABCDEFGH");
  assertEqual(r.CLR_GiveUp("gone"), false, "connected, no retry");
  r.CLR_ConnectionLost();
  assertEqual(r.CLR_GiveUp("gone"), false, "a retry waiting, not connecting");
  assertEqual(env.timers.length, 1, "the retry is still scheduled");
  assertEqual(env.giveUps.length, 0, "no give up");
});
