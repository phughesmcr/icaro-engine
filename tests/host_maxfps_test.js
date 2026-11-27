// host_maxfps: renderer/network isolation timing (host.js) and the partial
// command prediction runs between ticks (cl_pred.js)

import { CONTENTS_EMPTY, CONTENTS_SOLID } from "../src/bspfile.js";
import { ca_connected, cl, cls, SIGNONS } from "../src/client.js";
import {
  _Host_FilterTime,
  _Host_NetFrame,
  host_frametime,
  host_maxfps,
  host_netaccum,
  host_netframetime,
  HOST_NETINTERVAL,
  host_netinterval,
  HOST_NETTICK_SLACK,
  Host_NetTickTime,
  set_host_netaccum,
  set_host_netinterval,
} from "../src/host.js";
import {
  CL_AccumulateCmd,
  cl_yawspeed,
  in_mlook,
  in_right,
  in_strafe,
} from "../src/cl_input.js";
import {
  CL_AcknowledgeCommand,
  CL_InitPrediction,
  cl_prediction_active,
  CL_PredictMove,
  CL_ResetPrediction,
  CL_SetServerState,
  cl_simorg,
  CL_StoreCommand,
} from "../src/cl_pred.js";

const I = HOST_NETINTERVAL;

function assertNear(actual, expected, epsilon, message) {
  if (
    Number.isFinite(actual) !== true || Math.abs(actual - expected) > epsilon
  ) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

// Deterministic frame times: 1/hz, plus or minus up to jitter seconds
function frameTimes(hz, jitter, seconds) {
  let seed = 12345;
  const out = [];
  const frames = Math.round(hz * seconds);
  for (let f = 0; f < frames; f++) {
    seed = (seed * 16807) % 2147483647;
    out.push(1 / hz + (seed / 2147483647 * 2 - 1) * jitter);
  }

  return out;
}

// Runs the network tick the way host.js _Host_NetFrame does
function runTicks(times) {
  let accum = 0;
  let total = 0;
  let ticked = 0;
  const ticks = [];
  for (const dt of times) {
    total += dt;
    accum += dt;
    const tick = Host_NetTickTime(accum, I);
    if (tick > 0) {
      accum -= tick;
      ticked += tick;
    }

    ticks.push(tick);
    if (accum < -HOST_NETTICK_SLACK - 1e-12 || accum > I + 1e-12) {
      throw new Error(`carry ${accum} outside [-slack, interval]`);
    }
  }

  return { ticks, accum, total, ticked };
}

Deno.test("Host_NetTickTime keeps a 72 Hz tick without drift at common display rates", () => {
  const cases = [
    [72, 0],
    [72, 0.0002],
    [75, 0],
    [90, 0],
    [90, 0.0005],
    [120, 0],
    [144, 0],
    [144, 0.0005],
    [160, 0],
    [240, 0],
  ];
  for (const [hz, jitter] of cases) {
    const seconds = 10;
    const r = runTicks(frameTimes(hz, jitter, seconds));
    const label = `${hz} Hz +-${jitter * 1000} ms`;

    // no drift: every bit of frame time is ticked or still carried
    assertNear(r.ticked + r.accum, r.total, 1e-9, `${label} time`);

    // 72 ticks a second, at most one per frame
    const count = r.ticks.filter((t) => t > 0).length;
    if (Math.abs(count - 72 * seconds) > 1) {
      throw new Error(`${label}: ${count} ticks in ${seconds} s`);
    }

    // each tick is one interval, apart from a catch-up after jitter
    for (const t of r.ticks) {
      if (t > 0 && (t < I || t > I + 2 * jitter + 1e-12)) {
        throw new Error(`${label}: tick of ${t * 1000} ms`);
      }
    }
  }
});

Deno.test("Host_NetTickTime ticks every frame below 72 Hz, one frame time each", () => {
  const r = runTicks(frameTimes(60, 0, 10));
  if (r.ticks.some((t) => t === 0)) {
    throw new Error("a 60 Hz frame ran no tick");
  }
  assertNear(r.ticked + r.accum, r.total, 1e-9, "60 Hz time");
  // after the carry fills up, each tick is the whole frame
  for (const t of r.ticks.slice(10)) {
    assertNear(t, 1 / 60, 1e-9, "60 Hz tick");
  }
});

Deno.test("Host_NetTickTime takes a hitch in one tick, then goes back to the interval", () => {
  const times = frameTimes(144, 0, 1);
  times[50] = 0.2; // the most _Host_NetFrame adds in one frame
  const r = runTicks(times);
  assertNear(r.ticked + r.accum, r.total, 1e-9, "hitch time");
  // all but one interval of the time so far runs in the hitch's tick
  const carried = runTicks(times.slice(0, 50)).accum;
  assertNear(r.ticks[50], carried + 0.2 - I, 1e-9, "hitch tick");
  for (const t of r.ticks.slice(52)) {
    if (t !== 0 && Math.abs(t - I) > 1e-12) {
      throw new Error(`tick of ${t * 1000} ms after the hitch`);
    }
  }
});

function withMaxfps(value, fn) {
  const oldString = host_maxfps.string;
  const oldValue = host_maxfps.value;
  try {
    host_maxfps.string = String(value);
    host_maxfps.value = value;
    fn();
  } finally {
    host_maxfps.string = oldString;
    host_maxfps.value = oldValue;
    _Host_FilterTime(1); // back to the default's isolation state
  }
}

Deno.test("_Host_FilterTime at host_maxfps 72 (a saved WinQuake value) matches WinQuake frame for frame", () => {
  withMaxfps(72, () => {
    _Host_FilterTime(1); // a frame always runs: realtime and oldrealtime agree
    let realtime = 0;
    let oldrealtime = 0;
    for (const hz of [60, 72, 90, 120, 144]) {
      for (const dt of frameTimes(hz, 0.0003, 2)) {
        realtime += dt;
        const expected = realtime - oldrealtime >= 1.0 / 72.0;
        if (expected) {
          oldrealtime = realtime;
        }
        const ran = _Host_FilterTime(dt);
        if (ran !== expected) {
          throw new Error(`${hz} Hz: frame ran ${ran}, WinQuake ${expected}`);
        }
        if (host_netinterval !== 0) {
          throw new Error("isolation turned on at host_maxfps 72");
        }
      }
    }
  });
});

Deno.test("the default host_maxfps draws every display frame and ticks the game at 72 Hz", () => {
  // Ironwail's default; QuakeSpasm's 72 skipped frames on 90/120/165 Hz
  // displays. The cvar_t's string is the default until a config sets it.
  if (host_maxfps.string !== "250") {
    throw new Error(`default host_maxfps is ${host_maxfps.string}`);
  }
  withMaxfps(250, () => {
    for (const hz of [60, 72, 90, 120, 144, 165, 240]) {
      _Host_FilterTime(1);
      _Host_NetFrame(); // settle the carry after the long frame
      if (host_netinterval !== I) {
        throw new Error(`${hz} Hz: isolation is off`);
      }
      const seconds = 10;
      const times = frameTimes(hz, 0.0003, seconds);
      let frames = 0;
      let ticks = 0;
      let ticked = 0;
      for (const dt of times) {
        if (_Host_FilterTime(dt) !== true) continue;
        frames++;
        const before = host_netaccum;
        _Host_NetFrame();
        const tick = before + dt - host_netaccum;
        if (tick > 1e-9) {
          ticks++;
          ticked += host_netframetime;
          assertNear(host_netframetime, tick, 1e-9, `${hz} Hz tick length`);
          // at 72 Hz or faster each tick is one 1/72 s server frame, give or
          // take the jitter a catch-up tick absorbs
          if (hz >= 72 && Math.abs(host_netframetime - I) > 0.0007) {
            throw new Error(`${hz} Hz: tick of ${host_netframetime * 1000} ms`);
          }
        }
      }
      if (frames !== times.length) {
        throw new Error(`${hz} Hz: drew ${frames} of ${times.length} frames`);
      }
      // the game runs in real time: 72 ticks a second at 72 Hz or faster, one
      // per frame below it
      const expectedTicks = Math.min(hz, 72) * seconds;
      if (Math.abs(ticks - expectedTicks) > 2) {
        throw new Error(`${hz} Hz: ${ticks} ticks in ${seconds} s`);
      }
      const total = times.reduce((a, b) => a + b, 0);
      assertNear(ticked, total, I + 0.002, `${hz} Hz game time`);
    }
  });
});

Deno.test("a saved host_maxfps of 72 or below keeps the single loop", () => {
  for (const saved of [72, 60, 30]) {
    withMaxfps(saved, () => {
      _Host_FilterTime(1);
      if (host_netinterval !== 0) {
        throw new Error(`host_maxfps ${saved} isolated`);
      }
    });
  }
});

Deno.test("_Host_FilterTime renders up to host_maxfps once isolated", () => {
  for (
    const [maxfps, hz, expected] of [
      [0, 144, 144],
      [250, 144, 144],
      [144, 144, 144],
      [100, 144, 100],
      [120, 240, 120],
    ]
  ) {
    withMaxfps(maxfps, () => {
      _Host_FilterTime(1);
      if (host_netinterval !== I) {
        throw new Error(`host_maxfps ${maxfps} did not isolate`);
      }
      let frames = 0;
      for (const dt of frameTimes(hz, 0.0003, 10)) {
        if (_Host_FilterTime(dt)) {
          frames++;
        }
      }
      if (Math.abs(frames / 10 - expected) > 1) {
        throw new Error(
          `host_maxfps ${maxfps} at ${hz} Hz: ${
            frames / 10
          } fps, expected ${expected}`,
        );
      }
    });
  }
});

Deno.test("_Host_NetFrame sends one interval per tick and caps a hitch at 0.1", () => {
  withMaxfps(0, () => {
    _Host_FilterTime(1);
    _Host_NetFrame(); // a 1 s frame: one capped tick, carry back to an interval
    let ticks = 0;
    for (const dt of frameTimes(144, 0, 1)) {
      _Host_FilterTime(dt);
      const before = host_netaccum;
      const renderframetime = host_frametime;
      _Host_NetFrame();
      if (host_netaccum < before) {
        ticks++;
        assertNear(host_netframetime, I, 1e-12, "tick length");
      }

      if (host_frametime !== renderframetime) {
        throw new Error("host_frametime changed by the network frame");
      }
    }

    if (Math.abs(ticks - 72) > 1) {
      throw new Error(`${ticks} ticks in a second at 144 Hz`);
    }

    _Host_FilterTime(0.25); // a hitch: Ironwail adds at most 0.2
    _Host_NetFrame();
    assertNear(host_netframetime, 0.1, 0, "hitch tick");
    if (host_netaccum > I + 1e-12) {
      throw new Error(`carry ${host_netaccum} after the hitch`);
    }
  });
});

// Holds +right for one second of 144 Hz frames and returns the yaw turned
function turnFor(mlook) {
  const oldState = cls.state;
  const oldSignon = cls.signon;
  const oldMoves = cl.movemessages;
  const oldCmd = cl.cmd;
  const oldYaw = cl.viewangles[1];
  const oldRight = in_right.state;
  const oldMlook = in_mlook.state;
  try {
    cls.state = ca_connected;
    cls.signon = SIGNONS;
    in_right.state = 1;
    in_mlook.state = mlook ? 1 : 0;
    cl.viewangles[1] = 0;
    let turned = 0;
    let elapsed = 0;
    _Host_FilterTime(1);
    for (const dt of frameTimes(144, 0, 1)) {
      _Host_FilterTime(dt);
      elapsed += host_frametime;
      const yaw = cl.viewangles[1];
      cl.movemessages = 0; // CL_SendMove drops the first two: nothing is sent
      _Host_NetFrame();
      let d = yaw - cl.viewangles[1];
      if (d < 0) d += 360;
      turned += d;
    }

    return { turned, elapsed };
  } finally {
    cls.state = oldState;
    cls.signon = oldSignon;
    cl.movemessages = oldMoves;
    cl.cmd = oldCmd;
    cl.viewangles[1] = oldYaw;
    in_right.state = oldRight;
    in_mlook.state = oldMlook;
  }
}

Deno.test("isolated frames turn the view at cl_yawspeed with or without +mlook", () => {
  withMaxfps(0, () => {
    for (const mlook of [true, false]) {
      const { turned, elapsed } = turnFor(mlook);
      // the last frames' turn may wait for a tick that hasn't run yet
      assertNear(
        turned,
        cl_yawspeed.value * elapsed,
        cl_yawspeed.value * I * 1.1,
        `yaw turned with mlook ${mlook}`,
      );
    }
  });
});

Deno.test("CL_AccumulateCmd turns the view only while the mouse turns it", () => {
  const oldState = cls.state;
  const oldSignon = cls.signon;
  const oldYaw = cl.viewangles[1];
  const oldRight = in_right.state;
  const oldStrafe = in_strafe.state;
  const oldMlook = in_mlook.state;
  try {
    cls.state = ca_connected;
    cls.signon = SIGNONS;
    in_right.state = 1;
    in_mlook.state = 1;
    cl.viewangles[1] = 90;
    if (CL_AccumulateCmd() !== true || !(cl.viewangles[1] < 90)) {
      throw new Error(`+mlook frame did not turn: yaw ${cl.viewangles[1]}`);
    }

    // +strafe: the mouse moves the player, so wait for CL_SendCmd
    in_strafe.state = 1;
    cl.viewangles[1] = 90;
    if (CL_AccumulateCmd() !== false || cl.viewangles[1] !== 90) {
      throw new Error("+strafe frame turned the view");
    }
  } finally {
    cls.state = oldState;
    cls.signon = oldSignon;
    cl.viewangles[1] = oldYaw;
    in_right.state = oldRight;
    in_strafe.state = oldStrafe;
    in_mlook.state = oldMlook;
  }
});

// Floor with its top at z = 0 (hull 1: origin z >= 24)
function floorHull(z) {
  return {
    firstclipnode: 0,
    lastclipnode: 0,
    clipnodes: [{
      planenum: 0,
      children: new Int16Array([CONTENTS_EMPTY, CONTENTS_SOLID]),
    }],
    planes: [{
      type: 2,
      dist: z,
      normal: new Float32Array([0, 0, 1]),
      signbits: 0,
    }],
  };
}

function forwardCmd(msec) {
  return {
    msec,
    angles: new Float32Array(3),
    forwardmove: 200,
    sidemove: 0,
    upmove: 0,
    buttons: 0,
    impulse: 0,
  };
}

let initialised = false;

function withIsolatedPrediction(fn) {
  if (initialised === false) {
    initialised = true;
    try {
      CL_InitPrediction();
    } catch (e) {
      // cvar / command registration may already have happened in this isolate
      void e;
    }
  }

  const oldWorld = cl.worldmodel;
  const oldView = cl.viewentity;
  const oldHealth = cl.stats[0];
  const oldAngles = cl.viewangles.slice();
  try {
    CL_ResetPrediction();
    cl.worldmodel = {
      name: "maps/test.bsp",
      hulls: [floorHull(0), floorHull(24)],
    };
    cl.viewentity = 1;
    cl.stats[0] = 100; // STAT_HEALTH
    cl.viewangles.fill(0);
    set_host_netinterval(I);
    fn();
  } finally {
    set_host_netinterval(0);
    set_host_netaccum(0);
    CL_ResetPrediction();
    cl.worldmodel = oldWorld;
    cl.viewentity = oldView;
    cl.stats[0] = oldHealth;
    cl.viewangles.set(oldAngles);
  }
}

// Acknowledged state on the floor, then n commands moving forward
function setupCommands(n) {
  CL_SetServerState(new Float32Array([0, 0, 24]), new Float32Array(3), true);
  CL_StoreCommand(forwardCmd(0), -2); // sequence 0, the acknowledged one
  for (let i = 0; i < n; i++) {
    CL_StoreCommand(forwardCmd(I * 1000), -1 + i * 0.001);
  }
}

function predictAt(accum) {
  set_host_netaccum(accum);
  CL_PredictMove();
  return cl_simorg[0];
}

Deno.test("isolated prediction moves the view between ticks and runs on into the next command", () => {
  withIsolatedPrediction(() => {
    setupCommands(4);

    // between ticks the view moves forward with the untimed time
    let last = -Infinity;
    for (let k = 0; k <= 8; k++) {
      const x = predictAt(I * k / 8);
      if (x <= last && k > 0) {
        throw new Error(`view went back between ticks: ${last} then ${x}`);
      }
      last = x;
    }

    // no time to predict: the newest command's state
    const atTick = predictAt(0);
    const fullTick = predictAt(I);
    if (!(fullTick > atTick)) {
      throw new Error(`partial move did not move: ${atTick} -> ${fullTick}`);
    }

    // the next tick sends one interval with the same input; the view right
    // after it is where the partial move had it just before
    CL_StoreCommand(forwardCmd(I * 1000), 0.5);
    const afterTick = predictAt(0);
    assertNear(afterTick, fullTick, 1e-3, "view across the tick");
  });
});

Deno.test("isolated prediction runs on from the server state once every command is acknowledged", () => {
  withIsolatedPrediction(() => {
    setupCommands(1);
    CL_AcknowledgeCommand(1); // the newest command; nothing left to predict
    CL_SetServerState(
      new Float32Array([0, 0, 24]),
      new Float32Array([100, 0, 0]),
      true,
    );
    const atAck = predictAt(0);
    const later = predictAt(I / 2);
    assertNear(atAck, 0, 0, "view on the acknowledged state");
    if (!(later > atAck)) {
      throw new Error(
        `view froze after the acknowledgement: ${atAck} -> ${later}`,
      );
    }
  });
});

Deno.test("isolated prediction leaves the view alone before any command is stored", () => {
  withIsolatedPrediction(() => {
    CL_SetServerState(
      new Float32Array([0, 0, 24]),
      new Float32Array([100, 0, 0]),
      true,
    );
    predictAt(I / 2);
    if (cl_prediction_active !== false || cl_simorg[0] !== 0) {
      throw new Error(
        `predicted from an unused frame: active ${cl_prediction_active}, x ${
          cl_simorg[0]
        }`,
      );
    }
  });
});

Deno.test("prediction ignores host_netaccum while isolation is off", () => {
  withIsolatedPrediction(() => {
    setupCommands(4);
    set_host_netinterval(0);
    const a = predictAt(0);
    const b = predictAt(I / 2);
    assertNear(b, a, 0, "single loop view");
  });
});
