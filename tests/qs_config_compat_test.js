// QuakeSpasm-family config compatibility, for configs written for those
// engines (LibreQuake's default.cfg and default_$generic.cfg): the
// QuakeSpasm/Ironwail key names, Quakespasm-Spiked's set and seta, and the
// cvars cl_alwaysrun, scr_conalpha and r_particles.

// Bootstrap the client graph in its established safe import order.
await import("../src/gl_rsurf.js");
globalThis.window = { devicePixelRatio: 1 }; // gl_draw.js sizes the virtual screen from it

const THREE = await import("three");
const common = await import("../src/common.js");
const cmd = await import("../src/cmd.js");
const cvar = await import("../src/cvar.js");
const consolejs = await import("../src/console.js");
const keys = await import("../src/keys.js");
const cl_input = await import("../src/cl_input.js");
const client = await import("../src/client.js");
const draw = await import("../src/gl_draw.js");
const glquake = await import("../src/glquake.js");
const part = await import("../src/r_part.js");

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${
        JSON.stringify(actual)
      }`,
    );
  }
}

const printed = [];
common.Con_SetPrintFunctions(
  (fmt, ...args) =>
    printed.push(
      args.length === 0 ? String(fmt) : consolejs._sprintf(fmt, ...args),
    ),
  () => {},
);

cmd.Cbuf_Init();
cmd.Cmd_Init(); // registers set and seta (Cvar_Init)
keys.Key_Init();

function exec(text) {
  printed.length = 0;
  cmd.Cbuf_AddText(text);
  cmd.Cbuf_Execute();
  return printed.join("");
}

const PAD_KEYS = [
  ["MOUSE4", keys.K_MOUSE4, 241],
  ["MOUSE5", keys.K_MOUSE5, 242],
  ["LTHUMB", keys.K_LTHUMB, 243],
  ["RTHUMB", keys.K_RTHUMB, 244],
  ["LSHOULDER", keys.K_LSHOULDER, 245],
  ["RSHOULDER", keys.K_RSHOULDER, 246],
  ["ABUTTON", keys.K_ABUTTON, 247],
  ["BBUTTON", keys.K_BBUTTON, 248],
  ["XBUTTON", keys.K_XBUTTON, 249],
  ["YBUTTON", keys.K_YBUTTON, 250],
  ["LTRIGGER", keys.K_LTRIGGER, 251],
  ["RTRIGGER", keys.K_RTRIGGER, 252],
  ["PRINTSCREEN", keys.K_PRINTSCREEN, 173],
];

Deno.test("QuakeSpasm's mouse and controller key names, and Ironwail's PRINTSCREEN, bind", () => {
  const saved = PAD_KEYS.map(([, k]) => keys.keybindings[k]);
  try {
    for (const [name, k, num] of PAD_KEYS) {
      assertEqual(k, num, name + " keynum");
      assertEqual(keys.Key_StringToKeynum(name), num, name + " by name");
      assertEqual(
        keys.Key_StringToKeynum(name.toLowerCase()),
        num,
        name + " lower case",
      );
      assertEqual(keys.Key_KeynumToString(num), name, name + " name");

      const out = exec('bind "' + name + '" "+jump"\n');
      assertEqual(out, "", name + " is a valid key");
      assertEqual(keys.keybindings[num], "+jump", name + " bound");
      const written = keys.Key_WriteBindings();
      if (!written.includes('bind "' + name + '" "+jump"')) {
        throw new Error(name + " missing from Key_WriteBindings");
      }
    }
  } finally {
    PAD_KEYS.forEach(([, k], i) => keys.Key_SetBinding(k, saved[i] ?? ""));
  }
});

Deno.test("set creates a cvar or sets one, and refuses commands and extra arguments", () => {
  try {
    assertEqual(exec("set qcc_generic darkplaces\n"), "", "create quietly");
    const v = cvar.Cvar_FindVar("qcc_generic");
    if (v === null) throw new Error("set did not create the cvar");
    assertEqual(v.string, "darkplaces", "created value");
    assertEqual(v.userdefined, true, "user defined");
    assertEqual(v.archive, false, "set does not archive");

    exec("set qcc_generic fte\n");
    assertEqual(v.string, "fte", "set again");
    assertEqual(cvar.Cvar_FindVar("qcc_generic"), v, "same cvar");

    // A cvar query reads it like any other
    assertEqual(
      exec("qcc_generic\n"),
      '"qcc_generic" is "fte" (default: "darkplaces")\n',
      "query",
    );

    const extra = exec("set qcc_generic a b\n");
    assertEqual(
      extra,
      'Warning: set "qcc_generic" command with extra args\n',
      "extra args",
    );
    assertEqual(v.string, "fte", "extra args change nothing");

    assertEqual(
      exec("set qcc_generic\n"),
      "set <cvar> <value>\n",
      "usage for a missing value",
    );

    assertEqual(
      exec("set echo 1\n"),
      'set: "echo" is a command\n',
      "a command name",
    );
    assertEqual(cvar.Cvar_FindVar("echo"), null, "no cvar named echo");
  } finally {
    cvar.Cvar_Set("qcc_generic", "darkplaces");
  }
});

Deno.test("set does not expand $: LibreQuake's default_$generic.cfg runs by its literal name", () => {
  try {
    exec("set generic darkplaces\n");
    const out = exec("exec default_$generic.cfg\n");
    if (!out.includes("default_$generic.cfg")) {
      throw new Error("exec did not try the literal name: " + out);
    }
    if (out.includes("default_darkplaces.cfg")) {
      throw new Error("$generic was expanded: " + out);
    }
  } finally {
    cvar.Cvar_Set("generic", "darkplaces");
  }
});

Deno.test("seta archives, and the saved config brings the cvar back", () => {
  const engine = new cvar.cvar_t("qcc_engine", "1");
  cvar.Cvar_RegisterVariable(engine);
  try {
    exec("seta qcc_mine 7\n");
    exec("seta qcc_engine 3\n");
    const mine = cvar.Cvar_FindVar("qcc_mine");
    assertEqual(mine.archive, true, "seta archives a new cvar");
    assertEqual(engine.archive, true, "seta archives an engine cvar");
    assertEqual(engine.string, "3", "engine cvar set");

    const saved = cvar.Cvar_WriteVariables();
    for (const line of ['seta qcc_mine "7"\n', 'seta qcc_engine "3"\n']) {
      if (!saved.includes(line)) {
        throw new Error("missing " + JSON.stringify(line) + " in " + saved);
      }
    }

    // Loading the saved line sets it back
    cvar.Cvar_Set("qcc_mine", "0");
    exec(saved);
    assertEqual(mine.string, "7", "round trip");
  } finally {
    cvar.Cvar_Set("qcc_mine", "7");
    cvar.Cvar_Set("qcc_engine", "1");
  }
});

Deno.test("an engine cvar registered after set takes the value set gave it", () => {
  try {
    exec("seta qcc_late 5\n");
    const late = new cvar.cvar_t("qcc_late", "1");
    printed.length = 0;
    cvar.Cvar_RegisterVariable(late);
    assertEqual(printed.join(""), "", "no 'already defined' message");
    assertEqual(cvar.Cvar_FindVar("qcc_late"), late, "the engine cvar is live");
    assertEqual(late.string, "5", "value kept");
    assertEqual(late.value, 5, "numeric value");
    assertEqual(late.default_string, "1", "engine default");
    assertEqual(late.archive, true, "seta's archive kept");

    let count = 0;
    for (const line of cvar.Cvar_WriteVariables().split("\n")) {
      if (line.includes("qcc_late")) count++;
    }
    assertEqual(count, 1, "written once");
  } finally {
    cvar.Cvar_Set("qcc_late", "1");
  }
});

Deno.test("cl_alwaysrun runs without +speed and walks with it", () => {
  const cmdv = {
    viewangles: new Float32Array(3),
    forwardmove: 0,
    sidemove: 0,
    upmove: 0,
  };
  const { cls } = client;
  const oldSignon = cls.signon;
  const oldForward = cl_input.in_forward.state;
  const oldSpeed = cl_input.in_speed.state;
  const oldFs = cl_input.cl_forwardspeed.string;
  if (cvar.Cvar_FindVar("cl_alwaysrun") === null) {
    cvar.Cvar_RegisterVariable(cl_input.cl_alwaysrun);
  }
  for (const v of [cl_input.cl_forwardspeed, cl_input.cl_movespeedkey]) {
    if (cvar.Cvar_FindVar(v.name) === null) cvar.Cvar_RegisterVariable(v);
  }

  try {
    assertEqual(cl_input.cl_alwaysrun.string, "0", "QuakeSpasm's default");
    cls.signon = 4; // SIGNONS
    cvar.Cvar_Set("cl_forwardspeed", "200");
    cl_input.in_forward.state = 1;
    const speedkey = cl_input.cl_movespeedkey.value;

    cl_input.in_speed.state = 0;
    cl_input.CL_BaseMove(cmdv);
    assertEqual(cmdv.forwardmove, 200, "walk by default");

    cvar.Cvar_Set("cl_alwaysrun", "1");
    cl_input.CL_BaseMove(cmdv);
    assertEqual(cmdv.forwardmove, 200 * speedkey, "always run");

    cl_input.in_speed.state = 1;
    cl_input.CL_BaseMove(cmdv);
    assertEqual(cmdv.forwardmove, 200, "+speed walks");
  } finally {
    cvar.Cvar_Set("cl_alwaysrun", "0");
    cvar.Cvar_Set("cl_forwardspeed", oldFs);
    cl_input.in_forward.state = oldForward;
    cl_input.in_speed.state = oldSpeed;
    cls.signon = oldSignon;
  }
});

Deno.test("scr_conalpha: id's fade by default, Ironwail's alpha when set", () => {
  const alphas = [];
  const ctx = {
    globalAlpha: 1,
    setTransform: () => {},
    clearRect: () => {},
    drawImage: () => {},
    fillRect() {
      alphas.push(this.globalAlpha);
    },
    fillText: () => {},
  };
  try {
    draw.Draw_Init({ width: 640, height: 480, getContext: () => ctx });
  } catch {
    // no WAD in tests; only the overlay context matters here
  }
  if (cvar.Cvar_FindVar("scr_conalpha") === null) {
    cvar.Cvar_RegisterVariable(draw.scr_conalpha);
  }

  const bg = (lines) => {
    alphas.length = 0;
    draw.Draw_ConsoleBackground(lines);
    return alphas.length === 0 ? null : alphas[0];
  };
  const h = draw.Draw_GetVirtualHeight();
  const y = (h * 3) >> 2;

  try {
    assertEqual(draw.scr_conalpha.string, "-1", "default keeps id's fade");
    assertEqual(bg(h), 1, "full console is opaque");
    assertEqual(bg(y / 2), Math.min(1, 0.6), "half way down fades");

    cvar.Cvar_Set("scr_conalpha", "0.5");
    assertEqual(bg(h), 0.5, "Ironwail alpha, full console");
    assertEqual(bg(y / 2), 0.5, "Ironwail alpha, half console");

    consolejs.Con_SetForcedup(true);
    assertEqual(bg(h), 1, "forced up is opaque");
    consolejs.Con_SetForcedup(false);

    cvar.Cvar_Set("scr_conalpha", "0");
    assertEqual(bg(h), null, "0 draws no background");
    assertEqual(ctx.globalAlpha, 1, "alpha left alone");
  } finally {
    consolejs.Con_SetForcedup(false);
    cvar.Cvar_Set("scr_conalpha", "-1");
  }
});

Deno.test("r_particles: 0 hides particles, 2 draws squares, 1 id's dot", () => {
  const oldTime = client.cl.time;
  const oldOldtime = client.cl.oldtime;
  const oldTextures = glquake._allGameTextures.slice();
  const scene = new THREE.Scene();
  if (cvar.Cvar_FindVar("r_particles") === null) {
    cvar.Cvar_RegisterVariable(part.r_particles);
  }

  try {
    assertEqual(part.r_particles.string, "1", "QuakeSpasm's default");
    part.R_InitParticles();
    part.R_SetParticleExternals({ scene: scene });
    client.cl.time = 10;
    client.cl.oldtime = 9.99;
    part.R_RocketTrail(
      new Float32Array([0, 0, 0]),
      new Float32Array([2, 0, 0]),
      3,
    );

    part.R_DrawParticles();
    assertEqual(scene.children.length, 1, "drawn at 1");
    const material = scene.children[0].material;
    const dot = material.map;
    assertEqual(dot.magFilter, THREE.LinearFilter, "id's dot is linear");

    cvar.Cvar_Set("r_particles", "2");
    part.R_DrawParticles();
    const square = material.map;
    if (square === dot) throw new Error("r_particles 2 kept the dot");
    assertEqual(square.magFilter, THREE.NearestFilter, "square is nearest");
    // The square fills the dot's 4x4 corner of the 8x8 texture
    const a = (x, y) => square.image.data[(y * 8 + x) * 4 + 3];
    assertEqual(a(0, 0), 255, "corner solid");
    assertEqual(a(3, 3), 255, "square solid");
    assertEqual(a(4, 0), 0, "outside clear");

    cvar.Cvar_Set("r_particles", "0");
    part.R_DrawParticles();
    assertEqual(scene.children.length, 0, "hidden at 0");

    cvar.Cvar_Set("r_particles", "1");
    part.R_DrawParticles();
    assertEqual(scene.children.length, 1, "back at 1");
    assertEqual(material.map, dot, "dot again");
  } finally {
    cvar.Cvar_Set("r_particles", "1");
    part.R_ClearParticles();
    part.R_DrawParticles();
    client.cl.time = oldTime;
    client.cl.oldtime = oldOldtime;
    glquake._allGameTextures.splice(
      0,
      glquake._allGameTextures.length,
      ...oldTextures,
    );
  }
});
