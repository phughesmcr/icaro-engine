// Tests for cl_maxpitch / cl_minpitch (FitzQuake variable pitch clamping):
// keyboard look (CL_AdjustAngles) and gamepad look (in_web.js) both clamp
// to them, and the defaults keep id's 80 / -70.

// Bootstrap the renderer's existing circular module graph in its safe order.
await import("../src/gl_rsurf.js");

const cmd = await import("../src/cmd.js");
const cvar = await import("../src/cvar.js");
const keys = await import("../src/keys.js");
const host = await import("../src/host.js");
const cl_input = await import("../src/cl_input.js");
const input = await import("../src/in_web.js");
const { cl } = await import("../src/client.js");
const { PITCH } = await import("../src/quakedef.js");

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

cmd.Cbuf_Init();
cmd.Cmd_Init();
cl_input.CL_InitInput();

function withPitchLimits(max, min, fn) {
  const oldMax = cl_input.cl_maxpitch.string;
  const oldMin = cl_input.cl_minpitch.string;
  const oldPitch = cl.viewangles[PITCH];

  try {
    cvar.Cvar_Set("cl_maxpitch", max);
    cvar.Cvar_Set("cl_minpitch", min);
    fn();
  } finally {
    cvar.Cvar_Set("cl_maxpitch", oldMax);
    cvar.Cvar_Set("cl_minpitch", oldMin);
    cl.viewangles[PITCH] = oldPitch;
  }
}

Deno.test("cl_maxpitch / cl_minpitch are registered, archived and default to id's 80 / -70", () => {
  assertEqual(
    cvar.Cvar_FindVar("cl_maxpitch"),
    cl_input.cl_maxpitch,
    "cl_maxpitch registered",
  );
  assertEqual(
    cvar.Cvar_FindVar("cl_minpitch"),
    cl_input.cl_minpitch,
    "cl_minpitch registered",
  );
  assertEqual(cl_input.cl_maxpitch.value, 80, "cl_maxpitch default");
  assertEqual(cl_input.cl_minpitch.value, -70, "cl_minpitch default");
  assertEqual(cl_input.cl_maxpitch.archive, true, "cl_maxpitch archived");
  assertEqual(cl_input.cl_minpitch.archive, true, "cl_minpitch archived");
});

Deno.test("CL_AdjustAngles clamps pitch to cl_maxpitch / cl_minpitch", () => {
  withPitchLimits("80", "-70", () => {
    cl.viewangles[PITCH] = 85;
    cl_input.CL_AdjustAngles();
    assertEqual(cl.viewangles[PITCH], 80, "default max");
    cl.viewangles[PITCH] = -75;
    cl_input.CL_AdjustAngles();
    assertEqual(cl.viewangles[PITCH], -70, "default min");
  });

  withPitchLimits("90", "-90", () => {
    cl.viewangles[PITCH] = 85;
    cl_input.CL_AdjustAngles();
    assertEqual(cl.viewangles[PITCH], 85, "85 allowed with 90");
    cl.viewangles[PITCH] = -95;
    cl_input.CL_AdjustAngles();
    assertEqual(cl.viewangles[PITCH], -90, "clamped to -90");
  });
});

Deno.test("gamepad look clamps pitch to cl_maxpitch", () => {
  const pad = {
    index: 0,
    connected: true,
    axes: [0, 0, 0, 1], // right stick fully down
    buttons: Array.from({ length: 16 }, () => ({ pressed: false, value: 0 })),
  };
  const hadGetGamepads = Object.getOwnPropertyDescriptor(
    navigator,
    "getGamepads",
  );
  Object.defineProperty(navigator, "getGamepads", {
    value: () => [pad],
    configurable: true,
  });
  const oldFrametime = host.host_frametime;
  const oldDest = keys.key_dest;

  try {
    keys.set_key_dest(keys.key_game);
    host.set_host_frametime(1);

    withPitchLimits("85", "-70", () => {
      cl.viewangles[PITCH] = 0;
      input.IN_Move({ forwardmove: 0, sidemove: 0, upmove: 0 });
      assertEqual(cl.viewangles[PITCH], 85, "stick look stops at cl_maxpitch");
    });
  } finally {
    host.set_host_frametime(oldFrametime);
    keys.set_key_dest(oldDest);
    if (hadGetGamepads) {
      Object.defineProperty(navigator, "getGamepads", hadGetGamepads);
    } else delete navigator.getGamepads;
  }
});
