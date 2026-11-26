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

// the input handlers IN_Init registers, by event type
const handlers = {};

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
    addEventListener(type, fn) {
      (handlers[type] ??= []).push(fn);
    },
    removeEventListener() {},
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 640, height: 480 };
    },
  };
}

cmd.Cbuf_Init();
cmd.Cmd_Init();

// the fake page, kept for the handlers that read document
let fakeDocument = null;

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
  fakeDocument = doc;
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

let connected = true;

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
    value: {
      AudioContext: FakeContext,
      devicePixelRatio: 1,
      innerWidth: 640,
      innerHeight: 480,
      addEventListener() {},
      removeEventListener() {},
    },
  });
  Object.defineProperty(navigator, "getGamepads", {
    configurable: true,
    value: () => connected ? [pad] : [],
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
    // an unplugged pad forgets it was the last device used
    connected = false;
    input.IN_Move({ forwardmove: 0, sidemove: 0, upmove: 0 });
    connected = true;
    effects.length = 0;
    resets = 0;
    fn(ctx, frame, (ms) => {
      clock += ms;
      ctx.currentTime += ms / 1000;
      input.IN_Commands();
    });
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

      // Ironwail's level, |mono| * 0.5 / volume, once the envelopes settle
      const lo = snd.S_GetLoFreqLevel();
      const hi = snd.S_GetHiFreqLevel();
      assert(Math.abs(lo - 0.2) < 0.01, `lo ${lo}`);
      assert(Math.abs(hi - 0.2) < 0.01, `hi ${hi}`);

      ctx.state = "suspended";
      snd.S_UpdateLevels();
      assert(snd.S_GetLoFreqLevel() === 0, "silent context reads 0");
    } finally {
      cvar.Cvar_Set("volume", saved);
    }
  });
});

Deno.test("the two envelopes rise at the C's rates", () => {
  withPadAndSound((ctx) => {
    snd.S_UpdateLevels(); // creates the analyser
    ctx.amplitude = 0.5;
    ctx.currentTime += 200 / ctx.sampleRate;
    snd.S_UpdateLevels();

    // the level is 0.5 * 0.5 / 0.7; 200 samples of each filter from 0
    const target = 0.25 / 0.7;
    const lo = target * (1 - Math.pow(1 - 1e-3, 200));
    const hi = target * (1 - Math.pow(1 - 1e-2, 200));
    assert(Math.abs(snd.S_GetLoFreqLevel() - lo) < 1e-4, "low envelope");
    assert(Math.abs(snd.S_GetHiFreqLevel() - hi) < 1e-4, "high envelope");
  });
});

Deno.test("part-loud sound follows Ironwail's curve on each motor", () => {
  withPadAndSound((ctx, frame) => {
    ctx.amplitude = 0.35; // level 0.35 * 0.5 / 0.7 = 0.25
    useStick();
    for (let i = 0; i < 10; i++) frame();
    const e = effects.at(-1);
    const strong = 0.3 * (0.25 - 0.067) / (0.45 - 0.067);
    const weak = 0.3 * Math.pow((0.25 - 0.061) / (0.45 - 0.061), 2);
    assert(Math.abs(e.strongMagnitude - strong) < 1e-4, "strong motor");
    assert(Math.abs(e.weakMagnitude - weak) < 1e-4, "weak motor");
  });
});

Deno.test("effects are sent at most every 50 ms", () => {
  withPadAndSound((ctx, frame, step) => {
    ctx.amplitude = 0.7;
    useStick();
    for (let i = 0; i < 10; i++) frame();
    effects.length = 0;
    for (let i = 0; i < 20; i++) step(10);
    assert(effects.length === 4, `${effects.length} effects in 200 ms`);
  });
});

Deno.test("keys, mouse buttons, the wheel and touches take over from the pad", () => {
  const event = {
    code: "F24",
    key: "F24",
    button: 1,
    deltaY: 0,
    pointerType: "touch",
    target: null,
    preventDefault() {},
  };
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: fakeDocument,
  });
  try {
    const others = ["keydown", "keyup", "mouseup", "wheel", "pointerdown"];
    for (const type of others) {
      withPadAndSound((ctx, frame) => {
        ctx.amplitude = 0.7;
        useStick();
        for (let i = 0; i < 10; i++) frame();
        assert(effects.length > 0, "no rumble");
        assert(handlers[type] !== undefined, `no ${type} handler`);
        for (const handler of handlers[type]) handler(event);
        const count = effects.length;
        for (let i = 0; i < 5; i++) frame();
        assert(effects.length === count, `still rumbling after ${type}`);
      });
    }

    // as in Ironwail, moving the mouse doesn't
    withPadAndSound((ctx, frame) => {
      ctx.amplitude = 0.7;
      useStick();
      for (let i = 0; i < 10; i++) frame();
      for (const handler of handlers.mousemove) {
        handler({ movementX: 5, movementY: 0, pointerType: "mouse" });
      }
      const count = effects.length;
      frame();
      assert(effects.length === count + 1, "mouse movement stopped the rumble");
    });
  } finally {
    if (oldDocument) {
      Object.defineProperty(globalThis, "document", oldDocument);
    } else delete globalThis.document;
  }
});

Deno.test("loud sound rumbles the pad once it is the last device used", () => {
  withPadAndSound((ctx, frame) => {
    ctx.amplitude = 0.7;
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
      ctx.amplitude = 0.7;
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
