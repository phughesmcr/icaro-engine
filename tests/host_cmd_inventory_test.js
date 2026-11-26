// Port-inventory gaps G5 (crosshair cvar), G8 (sv_* server flag), G9
// (version, flush, mcache and viewthing commands) and G10 (serverprofile)
// against WinQuake's view.c, sv_phys.c, sv_user.c, host_cmd.c, zone.c and
// host.c.

const common = await import("../src/common.js");
const cmd = await import("../src/cmd.js");
const cvar = await import("../src/cvar.js");
const progs = await import("../src/progs.js");
const server = await import("../src/server.js");
const client = await import("../src/client.js");
const zone = await import("../src/zone.js");
const view = await import("../src/view.js");
const sv_phys = await import("../src/sv_phys.js");
const gl_model = await import("../src/gl_model.js");
const host = await import("../src/host.js");
const host_cmd = await import("../src/host_cmd.js");

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${
        JSON.stringify(actual)
      }`,
    );
  }
}

// Collects Con_Printf output, formatted the way console.js does
const printed = [];
const consolejs = await import("../src/console.js");
common.Con_SetPrintFunctions(
  (fmt, ...args) =>
    printed.push(
      args.length === 0 ? String(fmt) : consolejs._sprintf(fmt, ...args),
    ),
  () => {},
);

function output(fn) {
  printed.length = 0;
  fn();
  return printed.join("");
}

cmd.Cbuf_Init();
cmd.Cmd_Init();
zone.Memory_Init();
host_cmd.Host_InitCommands();

Deno.test("G5: crosshair defaults to 0 and is archived (view.c)", () => {
  assertEqual(view.crosshair.string, "0", "default");
  assertEqual(view.crosshair.archive, true, "archive flag");
});

Deno.test("G8: sv_gravity, sv_friction and sv_maxspeed are server cvars and announce changes", () => {
  const announced = [];
  const vars = [sv_phys.sv_gravity, sv_phys.sv_friction, sv_phys.sv_maxspeed];
  const old = vars.map((v) => v.string);
  try {
    for (const v of vars) {
      assertEqual(v.server, true, v.name + " server flag");
      if (cvar.Cvar_FindVar(v.name) === null) cvar.Cvar_RegisterVariable(v);
    }

    cvar.Cvar_SetServerBroadcast((msg) => announced.push(msg));
    cvar.Cvar_Set("sv_gravity", "200");
    cvar.Cvar_Set("sv_gravity", "200"); // unchanged: no second message
    assertEqual(
      announced.join(""),
      '"sv_gravity" changed to "200"\n',
      "cvar.c Cvar_Set broadcast",
    );
  } finally {
    cvar.Cvar_SetServerBroadcast(null);
    vars.forEach((v, i) => cvar.Cvar_Set(v.name, old[i]));
  }
});

Deno.test("G9: version, flush and mcache are registered as in C", () => {
  for (
    const name of [
      "version",
      "flush",
      "mcache",
      "viewmodel",
      "viewframe",
      "viewnext",
      "viewprev",
    ]
  ) {
    assertEqual(cmd.Cmd_Exists(name), true, name + " registered");
  }

  assertEqual(
    output(() => cmd.Cmd_ExecuteString("version")),
    "Version 1.09\n",
    "Host_Version_f",
  );
  if (
    output(() => cmd.Cmd_ExecuteString("mcache")).startsWith(
      "Cached models:\n",
    ) !== true
  ) {
    throw new Error("mcache runs Mod_Print");
  }
  cmd.Cmd_ExecuteString("flush"); // Cache_Flush: nothing cached, must not throw
});

Deno.test("G9: the view* commands step a viewthing through its model frames", () => {
  const oldProgsSV = progs.sv;
  const oldStrings = progs.pr_strings_data;
  const oldNumEdicts = server.sv.num_edicts;
  const oldPrecache = client.cl.model_precache[3];
  try {
    // no edicts: C prints a message and does nothing
    server.sv.num_edicts = 0;
    assertEqual(
      output(() => cmd.Cmd_ExecuteString("viewnext")),
      "No viewthing on map\n",
      "no viewthing",
    );

    progs.PR_SetStringsData(new TextEncoder().encode("\0player\0viewthing\0"));
    const edicts = [{ v: { classname: 1 } }, {
      v: { classname: 8, modelindex: 3, frame: 0 },
    }];
    progs.PR_SetSV({ edicts: edicts, max_edicts: 2 });
    server.sv.num_edicts = 2;
    const frames = ["stand1", "stand2", "run1"].map((name) => ({ name: name }));
    client.cl.model_precache[3] = {
      type: gl_model.mod_alias,
      numframes: 3,
      cache: { data: { frames: frames } },
    };
    const thing = edicts[1];

    assertEqual(
      output(() => cmd.Cmd_ExecuteString("viewnext")),
      "frame 1: stand2\n",
      "viewnext",
    );
    output(() => cmd.Cmd_ExecuteString("viewnext"));
    assertEqual(
      output(() => cmd.Cmd_ExecuteString("viewnext")),
      "frame 2: run1\n",
      "viewnext stops at the last frame",
    );
    cmd.Cmd_ExecuteString("viewframe 0");
    assertEqual(thing.v.frame, 0, "viewframe sets the frame");
    cmd.Cmd_ExecuteString("viewframe 9");
    assertEqual(thing.v.frame, 2, "viewframe clamps to numframes - 1");
    cmd.Cmd_ExecuteString("viewframe 0");
    assertEqual(
      output(() => cmd.Cmd_ExecuteString("viewprev")),
      "frame 0: stand1\n",
      "viewprev stops at frame 0",
    );

    // viewmodel: an unknown model leaves the viewthing alone
    thing.v.frame = 1;
    assertEqual(
      output(() => cmd.Cmd_ExecuteString("viewmodel progs/nosuch.mdl")),
      "Can't load progs/nosuch.mdl\n",
      "viewmodel with a missing model",
    );
    assertEqual(thing.v.frame, 1, "frame unchanged on failure");

    // viewmodel: swaps the viewthing's precache slot and resets its frame
    const mdl = gl_model.Mod_FindName("progs/viewtest.mdl");
    mdl.needload = false;
    mdl.type = gl_model.mod_alias;
    mdl.numframes = 2;
    mdl.cache.data = { frames: [{ name: "pose1" }, { name: "pose2" }] };
    cmd.Cmd_ExecuteString("viewmodel progs/viewtest.mdl");
    assertEqual(
      client.cl.model_precache[3],
      mdl,
      "model_precache[ modelindex ] is the new model",
    );
    assertEqual(thing.v.frame, 0, "frame reset to 0");
    assertEqual(
      output(() => cmd.Cmd_ExecuteString("viewnext")),
      "frame 1: pose2\n",
      "steps the new model",
    );

    // a brush model has no alias frames: the frame moves, no name is printed
    client.cl.model_precache[3] = {
      type: 0,
      numframes: 2,
      cache: { data: null },
    };
    assertEqual(
      output(() => cmd.Cmd_ExecuteString("viewnext")),
      "",
      "no frame name for a brush model",
    );
    assertEqual(thing.v.frame, 1, "frame still steps");
  } finally {
    progs.PR_SetSV(oldProgsSV);
    progs.PR_SetStringsData(oldStrings);
    server.sv.num_edicts = oldNumEdicts;
    client.cl.model_precache[3] = oldPrecache;
  }
});

Deno.test("G10: host_speeds prints the frame timings each frame (host.c _Host_Frame)", () => {
  if (cvar.Cvar_FindVar("host_speeds") === null) {
    cvar.Cvar_RegisterVariable(host.host_speeds);
  }
  try {
    // 0.1 s frames pass _Host_FilterTime, so each call runs a whole frame
    cvar.Cvar_Set("host_speeds", "0");
    assertEqual(output(() => host.Host_Frame(0.1)), "", "off: nothing printed");

    cvar.Cvar_Set("host_speeds", "1");
    const lines = output(() => {
      host.Host_Frame(0.1);
      host.Host_Frame(0.1);
    }).split("\n");
    assertEqual(lines.length, 3, "one line per frame");
    for (const line of lines.slice(0, 2)) {
      if (
        /^[ \d]{2}\d tot [ \d]{2}\d server [ \d]{2}\d gfx [ \d]{2}\d snd$/.test(
          line,
        ) !== true
      ) {
        throw new Error(
          '"%3i tot %3i server %3i gfx %3i snd", got ' + JSON.stringify(line),
        );
      }
    }
  } finally {
    cvar.Cvar_Set("host_speeds", "0");
  }
});

Deno.test("G10: serverprofile prints the average frame time every 1000 frames", () => {
  if (cvar.Cvar_FindVar("serverprofile") === null) {
    cvar.Cvar_RegisterVariable(host.serverprofile);
  }
  try {
    cvar.Cvar_Set("serverprofile", "1");
    const out = output(() => {
      for (let i = 0; i < 1000; i++) host.Host_Frame(0);
    });
    if (/^serverprofile: {2}0 clients +\d+ msec\n$/.test(out) !== true) {
      throw new Error("host.c Host_Frame report, got " + JSON.stringify(out));
    }
  } finally {
    cvar.Cvar_Set("serverprofile", "0");
  }
});
