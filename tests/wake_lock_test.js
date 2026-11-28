// Tests for the shared Screen Wake Lock (src/wake_lock.js): reasons, the
// pending request, the browser's release on hide and the retake on show.

import {
  WakeLock_Held,
  WakeLock_Hold,
  WakeLock_IsHeldFor,
  WakeLock_Pending,
  WakeLock_Release,
  WakeLock_SetPlatform,
} from "../src/wake_lock.js";

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

// A fake navigator.wakeLock whose requests resolve when the test says so
function makePlatform() {
  const env = { requests: [], locks: [], listeners: [], refuse: false };
  env.doc = {
    visibilityState: "visible",
    addEventListener: (type, fn) => env.listeners.push({ type, fn }),
  };
  env.nav = {
    wakeLock: {
      request: (type) => {
        if (type !== "screen") throw new Error("not a screen lock");
        return new Promise((resolve, reject) => {
          env.requests.push({ resolve, reject });
        });
      },
    },
  };
  // Grant the oldest request
  env.grant = async () => {
    const req = env.requests.shift();
    const handlers = [];
    const lock = {
      released: false,
      addEventListener: (type, fn) => {
        if (type === "release") handlers.push(fn);
      },
      release: () => {
        lock.released = true;
        for (const fn of handlers) fn();
        return Promise.resolve();
      },
      // the browser drops it (the page was hidden)
      drop: () => {
        lock.released = true;
        for (const fn of handlers) fn();
      },
    };
    env.locks.push(lock);
    req.resolve(lock);
    await settle();
    return lock;
  };
  env.setVisible = (visible) => {
    env.doc.visibilityState = visible ? "visible" : "hidden";
    for (const l of env.listeners) {
      if (l.type === "visibilitychange") l.fn();
    }
  };
  WakeLock_SetPlatform(env.nav, env.doc);
  return env;
}

async function settle() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

Deno.test("WakeLock: one lock for every reason, released by the last", async () => {
  const env = makePlatform();
  WakeLock_Hold("touch");
  WakeLock_Hold("host");
  assertEqual(env.requests.length, 1, "one request");
  assertEqual(WakeLock_Pending(), true, "pending");
  const lock = await env.grant();
  assertEqual(WakeLock_Held(), true, "held");

  WakeLock_Release("touch");
  assertEqual(lock.released, false, "host still holds it");
  assertEqual(WakeLock_IsHeldFor("host"), true, "host reason");
  WakeLock_Release("host");
  assertEqual(lock.released, true, "released with the last reason");
  assertEqual(WakeLock_Held(), false, "not held");

  WakeLock_Release("host");
  assertEqual(env.requests.length, 0, "releasing twice does nothing");
});

Deno.test("WakeLock: a grant after every reason went is released", async () => {
  const env = makePlatform();
  WakeLock_Hold("host");
  WakeLock_Release("host");
  const lock = await env.grant();
  assertEqual(lock.released, true, "released at once");
  assertEqual(WakeLock_Held(), false, "not held");
});

Deno.test("WakeLock: hidden pages wait, and the lock comes back on show", async () => {
  const env = makePlatform();
  env.doc.visibilityState = "hidden";
  WakeLock_Hold("host");
  assertEqual(env.requests.length, 0, "no request while hidden");

  env.setVisible(true);
  assertEqual(env.requests.length, 1, "asked for on show");
  const lock = await env.grant();

  // the browser drops the lock when the page is hidden
  env.doc.visibilityState = "hidden";
  lock.drop();
  env.setVisible(false);
  assertEqual(WakeLock_Held(), false, "dropped");
  assertEqual(env.requests.length, 0, "no request while hidden");

  env.setVisible(true);
  assertEqual(env.requests.length, 1, "asked for again");
  await env.grant();
  assertEqual(WakeLock_Held(), true, "held again");
  assertEqual(
    env.listeners.filter((l) => l.type === "visibilitychange").length,
    1,
    "one listener",
  );
  WakeLock_Release("host");
});

Deno.test("WakeLock: no retake once released, and no request when unsupported", async () => {
  const env = makePlatform();
  WakeLock_Hold("touch");
  await env.grant();
  WakeLock_Release("touch");
  env.setVisible(false);
  env.setVisible(true);
  assertEqual(env.requests.length, 0, "nothing wants it");

  WakeLock_SetPlatform({}, env.doc);
  WakeLock_Hold("host");
  assertEqual(WakeLock_Pending(), false, "no wakeLock: no request");
  assertEqual(WakeLock_IsHeldFor("host"), true, "the reason is kept");
  WakeLock_Release("host");
});

Deno.test("WakeLock: a refused request is retried on the next show", async () => {
  const env = makePlatform();
  const log = console.log;
  console.log = () => {};
  try {
    WakeLock_Hold("host");
    env.requests.shift().reject(new Error("NotAllowedError"));
    await settle();
    assertEqual(WakeLock_Held(), false, "refused");
    assertEqual(WakeLock_Pending(), false, "not pending");
    env.setVisible(false);
    env.setVisible(true);
    assertEqual(env.requests.length, 1, "retried");
    await env.grant();
    assertEqual(WakeLock_Held(), true, "held");
    WakeLock_Release("host");
  } finally {
    console.log = log;
  }
});
