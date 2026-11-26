// The nomonsters save guards (Ironwail host_cmd.c): save is refused while the
// current map was spawned with nomonsters, and load turns the cvar off so the
// loaded game keeps its monsters.

await import("../src/gl_rsurf.js");
const common = await import("../src/common.js");
const cmd = await import("../src/cmd.js");
const cvar = await import("../src/cvar.js");
const zone = await import("../src/zone.js");
const host_cmd = await import("../src/host_cmd.js");
const pr_edict = await import("../src/pr_edict.js");
const server = await import("../src/server.js");
const client = await import("../src/client.js");
const consolejs = await import("../src/console.js");

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

function output(fn) {
  printed.length = 0;
  fn();
  return printed.join("");
}

zone.Memory_Init();
cmd.Cbuf_Init();
cmd.Cmd_Init();
host_cmd.Host_InitCommands();
common.Con_SetPrintFunctions(() => {}, () => {});
if (cvar.Cvar_FindVar("nomonsters") === null) {
  cvar.Cvar_RegisterVariable(pr_edict.nomonsters);
}

common.Con_SetPrintFunctions(
  (fmt, ...args) =>
    printed.push(
      args.length === 0 ? String(fmt) : consolejs._sprintf(fmt, ...args),
    ),
  () => {},
);

Deno.test("save is refused while the map was spawned with nomonsters", () => {
  const oldActive = server.sv.active;
  const oldNomonsters = server.sv.nomonsters;
  try {
    server.sv.active = true;
    server.sv.nomonsters = true;
    assertEqual(
      output(() => cmd.Cmd_ExecuteString("save t1", cmd.src_command)),
      'Can\'t save when using "nomonsters".\n',
      "refused",
    );
  } finally {
    server.sv.active = oldActive;
    server.sv.nomonsters = oldNomonsters;
  }
});

Deno.test("load turns nomonsters off before loading", () => {
  const oldStorage = Object.getOwnPropertyDescriptor(
    globalThis,
    "localStorage",
  );
  const oldDemonum = client.cls.demonum;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem() {
        return null;
      },
    },
  });
  try {
    cvar.Cvar_SetValue("nomonsters", 1);
    const text = output(() =>
      cmd.Cmd_ExecuteString("load missing", cmd.src_command)
    );
    assertEqual(
      text.startsWith('Warning: "nomonsters" disabled automatically.\n'),
      true,
      "warning: " + text,
    );
    assertEqual(pr_edict.nomonsters.value, 0, "cvar reset");

    // no warning when it is already off
    const again = output(() =>
      cmd.Cmd_ExecuteString("load missing", cmd.src_command)
    );
    assertEqual(again.includes("nomonsters"), false, "no warning: " + again);
  } finally {
    cvar.Cvar_SetValue("nomonsters", 0);
    client.cls.demonum = oldDemonum;
    if (oldStorage === undefined) {
      delete globalThis.localStorage;
    } else {
      Object.defineProperty(globalThis, "localStorage", oldStorage);
    }
  }
});
