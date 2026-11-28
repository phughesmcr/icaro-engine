// Tests for src/gl_warmup.js with a fake renderer: plaque holding, the wait
// cap, cancelling and superseding. R_WarmupSetTest swaps in the fake renderer
// and scene (the real ones need a browser).

// gl_rsurf.js first, as in gl_rmain_dlight_pad_test.js
await import("../src/gl_rsurf.js");
const {
  R_WarmupStart,
  R_WarmupWhenReady,
  R_WarmupPending,
  R_WarmupCancel,
  R_WarmupSetTest,
  R_WARMUP_MAX_WAIT_MS,
} = await import("../src/gl_warmup.js");
const THREE = await import("three");

function check(cond, msg) {
  if (cond !== true) throw new Error(msg);
}

// Like WebGLProperties: get() makes an empty entry for an unknown object
function fakeProperties() {
  const map = new Map();
  return {
    has: (key) => map.has(key),
    get: (key) => {
      if (!map.has(key)) map.set(key, {});
      return map.get(key);
    },
    remove: (key) => map.delete(key),
  };
}

// A renderer whose programs the test marks ready by hand. Each compile()
// returns one new material; r.materials and r.programs list them in order.
function fakeRenderer() {
  const r = {
    info: { programs: [] },
    properties: fakeProperties(),
    materials: [],
    programs: [],
    polls: 0, // isReady calls
    lost: false,
  };
  r.getContext = () => ({ isContextLost: () => r.lost });
  r.compile = () => {
    const material = {};
    const program = {
      ready: false,
      isReady() {
        r.polls++;
        return this.ready;
      },
    };
    r.materials.push(material);
    r.programs.push(program);
    r.properties.get(material).currentProgram = program;
    return new Set([material]);
  };
  return r;
}

// longer than the warm-up's poll interval
const tick = () => new Promise((resolve) => setTimeout(resolve, 15));
const level = { worldmodel: {} };

async function withFake(fn) {
  const r = fakeRenderer();
  R_WarmupSetTest({ renderer: r, scene: new THREE.Scene() });
  try {
    await fn(r);
  } finally {
    R_WarmupCancel(); // stop timers and drop state
    R_WarmupSetTest(null);
  }
}

// readies every program the fake has compiled, bucket by bucket
// (R_WarmupStart waits for each before starting the next)
async function settleAll(r) {
  for (let i = 0; i < 10; i++) {
    for (const program of r.programs) program.ready = true;
    await tick();
  }
}

Deno.test("R_WarmupWhenReady defers while compiling and runs when they finish", async () => {
  await withFake(async (r) => {
    R_WarmupStart(level);
    check(R_WarmupPending() === true, "should be pending");
    let called = 0;
    R_WarmupWhenReady(() => called++);
    await tick();
    check(called === 0, "ran before the compiles finished");
    await settleAll(r);
    check(called === 1, "should run once, ran " + called);
    check(R_WarmupPending() === false, "still pending");
  });
});

Deno.test("buckets compile one after another", async () => {
  await withFake(async (r) => {
    R_WarmupStart(level);
    await tick();
    check(
      r.programs.length === 2,
      "first bucket: scene and group, got " + r.programs.length,
    );
    r.programs[0].ready = true;
    await tick();
    check(
      r.programs.length === 2,
      "next bucket started before the first finished",
    );
    r.programs[1].ready = true;
    await tick();
    check(
      r.programs.length === 4,
      "next bucket should start, got " + r.programs.length,
    );
  });
});

Deno.test("R_WarmupCancel runs the held plaque callback once", async () => {
  await withFake(async () => {
    R_WarmupStart(level);
    let called = 0;
    R_WarmupWhenReady(() => called++);
    R_WarmupCancel();
    check(called === 1, "cancel should end the plaque, ran " + called);
    check(R_WarmupPending() === false, "still pending");
    R_WarmupCancel();
    await tick();
    check(called === 1, "ran twice");
  });
});

Deno.test("a second R_WarmupStart supersedes the first", async () => {
  await withFake(async (r) => {
    R_WarmupStart(level);
    let first = 0;
    R_WarmupWhenReady(() => first++);
    R_WarmupStart(level);
    let second = 0;
    R_WarmupWhenReady(() => second++);
    await settleAll(r); // also settles the first run's compiles
    check(first === 0, "the superseded callback must not run");
    check(second === 1, "the new callback should run once, ran " + second);
  });
});

Deno.test("the wait is capped at R_WARMUP_MAX_WAIT_MS", async () => {
  await withFake(async (r) => {
    R_WarmupStart(level);
    let called = 0;
    R_WarmupWhenReady(() => called++);
    await new Promise((resolve) =>
      setTimeout(resolve, R_WARMUP_MAX_WAIT_MS + 100)
    );
    check(called === 1, "cap should end the wait, ran " + called);
    check(R_WarmupPending() === false, "still pending after the cap");
    await settleAll(r); // late compiles change nothing
    check(called === 1, "ran again after the late compiles");
  });
});

// compileAsync's own poll threw an uncaught TypeError here (an uncaught error
// in a timer fails a Deno test)
Deno.test("materials disposed while compiling don't stop the warm-up", async () => {
  await withFake(async (r) => {
    R_WarmupStart(level);
    let called = 0;
    R_WarmupWhenReady(() => called++);
    for (const material of r.materials) r.properties.remove(material);
    await tick();
    check(r.programs.length === 4, "next bucket should start");
    await settleAll(r);
    check(called === 1, "should run once, ran " + called);
  });
});

Deno.test("a context restore while compiling doesn't stop the warm-up", async () => {
  await withFake(async (r) => {
    R_WarmupStart(level);
    r.properties = fakeProperties(); // what Three's initGLContext does
    await tick();
    check(r.programs.length === 4, "next bucket should start");
    await settleAll(r);
    check(R_WarmupPending() === false, "still pending");
  });
});

Deno.test("a lost context ends the warm-up", async () => {
  await withFake(async (r) => {
    R_WarmupStart(level);
    let called = 0;
    R_WarmupWhenReady(() => called++);
    r.lost = true;
    await tick();
    check(called === 1, "should run once, ran " + called);
    check(r.programs.length === 2, "no more buckets on a lost context");
  });
});

Deno.test("an error while polling ends the warm-up", async () => {
  await withFake(async (r) => {
    R_WarmupStart(level);
    let called = 0;
    R_WarmupWhenReady(() => called++);
    r.programs[0].isReady = () => {
      throw new Error("boom");
    };
    await tick();
    check(called === 1, "should run once, ran " + called);
  });
});

Deno.test("a cancelled or superseded warm-up is no longer polled", async () => {
  await withFake(async (r) => {
    R_WarmupStart(level);
    R_WarmupCancel();
    let polls = r.polls;
    await tick();
    check(r.polls === polls, "polled after the cancel");
    check(r.programs.length === 2, "compiled after the cancel");

    R_WarmupStart(level);
    R_WarmupStart(level); // programs 2-3 are stale, 4-5 are current
    let stale = 0;
    for (const program of r.programs.slice(2, 4)) {
      program.isReady = () => {
        stale++;
        return false;
      };
    }

    polls = r.polls;
    await tick();
    check(stale === 0, "polled the superseded warm-up");
    check(r.polls > polls, "the current warm-up should be polled");
  });
});
