// Tests for gamepad rumble (Ironwail in_sdl.c IN_Commands and snd_mix.c
// S_UpdateLevels): the level meter, and when the pad is told to vibrate.

// Bootstrap the renderer's existing circular module graph in its safe order.
await import("../src/gl_rsurf.js");

const cmd = await import("../src/cmd.js");
const cvar = await import("../src/cvar.js");
const keys = await import("../src/keys.js");
const input = await import("../src/in_web.js");
const snd = await import("../src/snd_dma.js");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// A fake context whose analyser always reads a signal of `amplitude`
class FakeContext {
  static last = null;

  constructor() {
    this.state = "running";
    this.sampleRate = 44100;
    this.currentTime = 1;
    this.amplitude = 0;
    this.destination = {};
    FakeContext.last = this;
  }

  createGain() {
    return { gain: { value: 1 }, connect() {} };
  }

  createAnalyser() {
    return {
      fftSize: 2048,
      getFloatTimeDomainData: (out) => {
        for (let i = 0; i < out.length; i++) {
          out[i] = i % 2 === 0 ? this.amplitude : -this.amplitude;
        }
      },
    };
  }

  addEventListener() {}
  resume() {
    return Promise.resolve();
  }
  suspend() {
    return Promise.resolve();
  }
  close() {
    return Promise.resolve();
  }
}

const effects = [];
let resets = 0;
const pad = {
  index: 0,
  connected: true,
  axes: [0, 0, 0, 0],
  buttons: Array.from({ length: 16 }, () => ({ pressed: false, value: 0 })),
  vibrationActuator: {
    playEffect(type, params) {
      effects.push({ type, ...params });
      return Promise.resolve("complete");
    },
    reset() {
      resets++;
      return Promise.resolve("complete");
    },
  },
};

function makeElement(tag) {
  return {
    tagName: tag,
    style: {},
    children: [],
    textContent: "",
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    addEventListener() {},
    removeEventListener() {},
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 640, height: 480 };
    },
  };
}

cmd.Cbuf_Init();
cmd.Cmd_Init();

// IN_Init registers in_web.js's cvars and lets IN_Commands run; do it once
// against a fake DOM
{
  const saved = {};
  for (const name of ["document", "window", "matchMedia"]) {
    saved[name] = Object.getOwnPropertyDescriptor(globalThis, name);
  }

  const doc = makeElement("DOCUMENT");
  doc.body = makeElement("BODY");
  doc.pointerLockElement = null;
  doc.visibilityState = "visible";
  doc.fullscreenElement = null;
  doc.createElement = (tag) => makeElement(tag.toUpperCase());
  const win = makeElement("WINDOW");
  win.innerWidth = 640;
  win.innerHeight = 480;
  const fakes = {
    document: doc,
    window: win,
    matchMedia: (q) => ({ matches: q === "(any-pointer: fine)" }),
  };
  for (const name in fakes) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: fakes[name],
    });
  }

  try {
    input.IN_Init(doc.body);
  } finally {
    for (const name in saved) {
      if (saved[name] === undefined) delete globalThis[name];
      else Object.defineProperty(globalThis, name, saved[name]);
    }
  }
}

// One monotonic clock for all the tests, as performance.now is
let clock = 1000;

// Runs fn with sound started on the fake context and the fake pad connected
function withPadAndSound(fn) {
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const oldPads = Object.getOwnPropertyDescriptor(navigator, "getGamepads");
  const oldDest = keys.key_dest;
  const oldNow = performance.now;

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { AudioContext: FakeContext, devicePixelRatio: 1 },
  });
  Object.defineProperty(navigator, "getGamepads", {
    configurable: true,
    value: () => [pad],
  });
  performance.now = () => clock;

  let savedVolume = null;
  try {
    snd.S_Init();
    // a saved volume (localStorage outlives a test run) must not decide this
    const volume = cvar.Cvar_FindVar("volume");
    savedVolume = volume.string;
    cvar.Cvar_Set("volume", "0.7");
    keys.set_key_dest(keys.key_game);
    const ctx = FakeContext.last;
    // one frame: 60 ms of audio and wall clock
    const frame = () => {
      clock += 60;
      ctx.currentTime += 0.06;
      input.IN_Commands();
    };
    effects.length = 0;
    resets = 0;
    fn(ctx, frame);
  } finally {
    input.IN_ClearAllStates();
    pad.axes = [0, 0, 0, 0];
    if (savedVolume !== null) cvar.Cvar_Set("volume", savedVolume);
    snd.S_Shutdown();
    performance.now = oldNow;
    keys.set_key_dest(oldDest);
    if (oldPads) Object.defineProperty(navigator, "getGamepads", oldPads);
    else delete navigator.getGamepads;
    if (oldWindow) Object.defineProperty(globalThis, "window", oldWindow);
    else delete globalThis.window;
  }
}

// A stick push makes the pad the last device used
function useStick() {
  pad.axes = [0, -1, 0, 0];
  input.IN_Move({ forwardmove: 0, sidemove: 0, upmove: 0 });
  pad.axes = [0, 0, 0, 0];
}

Deno.test("joy_rumble is registered with Ironwail's default", () => {
  const v = cvar.Cvar_FindVar("joy_rumble");
  assert(v !== null, "joy_rumble not registered");
  assert(v.string === "0.3", `default ${v.string}`);
  assert(v.archive === true, "not archived");
});

Deno.test("the level meter follows the output and divides the volume out", () => {
  withPadAndSound((ctx) => {
    const volume = cvar.Cvar_FindVar("volume");
    const saved = volume.string;
    try {
      cvar.Cvar_Set("volume", "0.5");
      snd.S_UpdateLevels(); // creates the analyser
      ctx.amplitude = 0.2;
      for (let i = 0; i < 20; i++) {
        ctx.currentTime += 0.05;
        snd.S_UpdateLevels();
      }

      // |mono| / volume = 0.4 once the envelopes have settled
      const lo = snd.S_GetLoFreqLevel();
      const hi = snd.S_GetHiFreqLevel();
      assert(Math.abs(lo - 0.4) < 0.01, `lo ${lo}`);
      assert(Math.abs(hi - 0.4) < 0.01, `hi ${hi}`);

      ctx.state = "suspended";
      snd.S_UpdateLevels();
      assert(snd.S_GetLoFreqLevel() === 0, "silent context reads 0");
    } finally {
      cvar.Cvar_Set("volume", saved);
    }
  });
});

Deno.test("loud sound rumbles the pad once it is the last device used", () => {
  withPadAndSound((ctx, frame) => {
    ctx.amplitude = 0.5;
    for (let i = 0; i < 10; i++) frame();
    assert(effects.length === 0, "an untouched pad must not rumble");

    useStick();
    for (let i = 0; i < 10; i++) frame();
    assert(effects.length > 0, "no rumble");
    const e = effects.at(-1);
    assert(e.type === "dual-rumble", e.type);
    assert(e.duration === 100, `duration ${e.duration}`);
    // full level, scaled by joy_rumble 0.3
    assert(Math.abs(e.strongMagnitude - 0.3) < 1e-6, `${e.strongMagnitude}`);
    assert(Math.abs(e.weakMagnitude - 0.3) < 1e-6, `${e.weakMagnitude}`);

    // going quiet stops the effect, once
    ctx.amplitude = 0;
    for (let i = 0; i < 40; i++) frame();
    const count = effects.length;
    const stopped = resets;
    frame();
    assert(effects.length === count, "still rumbling in silence");
    assert(stopped === 1 && resets === 1, `resets ${resets}`);
  });
});

Deno.test("joy_rumble 0 and clearing the input states stop the rumble", () => {
  withPadAndSound((ctx, frame) => {
    const rumble = cvar.Cvar_FindVar("joy_rumble");
    const saved = rumble.string;
    try {
      ctx.amplitude = 0.5;
      useStick();
      for (let i = 0; i < 10; i++) frame();
      assert(effects.length > 0, "no rumble");

      input.IN_ClearAllStates();
      assert(resets === 1, "clearing states must reset the actuator");

      cvar.Cvar_Set("joy_rumble", "0");
      const count = effects.length;
      for (let i = 0; i < 5; i++) frame();
      assert(effects.length === count, "rumbled with joy_rumble 0");
    } finally {
      cvar.Cvar_Set("joy_rumble", saved);
    }
  });
});

Deno.test("a pad without a vibration actuator is left alone", () => {
  const actuator = pad.vibrationActuator;
  delete pad.vibrationActuator;
  try {
    withPadAndSound((ctx, frame) => {
      ctx.amplitude = 0.5;
      useStick();
      for (let i = 0; i < 5; i++) frame();
    });
  } finally {
    pad.vibrationActuator = actuator;
  }
});
