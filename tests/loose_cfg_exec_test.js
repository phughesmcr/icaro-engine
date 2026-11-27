// exec runs loose .cfg files (LibreQuake's style_*.cfg, zoom90.cfg, dev.cfg
// beside its paks), as Ironwail does from id1/. Cmd_Exec_f reads synchronously,
// so Host_Init loads the loose *.cfg files first (pak.js
// COM_PreloadLooseConfigs), and the file's commands still run before the rest
// of the command buffer, as in cmd.c.

// Bootstrap the client graph in its established safe import order.
await import("../src/gl_rsurf.js");

const common = await import("../src/common.js");
const cmd = await import("../src/cmd.js");
const consolejs = await import("../src/console.js");
const {
  COM_FindFile,
  COM_PreloadLooseConfigs,
  COM_SetLooseFileBasePaths,
  COM_SetUserFiles,
} = await import("../src/pak.js");

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
function capture() {
  common.Con_SetPrintFunctions(
    (fmt, ...args) =>
      printed.push(
        args.length === 0 ? String(fmt) : consolejs._sprintf(fmt, ...args),
      ),
    () => {},
  );
}

cmd.Cbuf_Init();
cmd.Cmd_Init();

function exec(text) {
  printed.length = 0;
  cmd.Cbuf_AddText(text);
  cmd.Cbuf_Execute();
  return printed.join("");
}

function text(s) {
  return new Blob([s]);
}

function fileText(name) {
  const found = COM_FindFile(name);
  return found === null ? null : new TextDecoder().decode(found.data);
}

// Runs first, while the console's print functions are unset
Deno.test("Con_Printf before the console starts formats its arguments", () => {
  const log = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args);
  try {
    common.Con_Printf("LibreQuake in %s\n", "OPFS");
  } finally {
    console.log = log;
  }
  assertEqual(lines.length, 1, "lines logged");
  assertEqual(lines[0].length, 1, "arguments to console.log");
  assertEqual(lines[0][0], "LibreQuake in OPFS\n", "line");
});

Deno.test("loose *.cfg files in the browser's storage load before exec", async () => {
  capture();
  COM_SetUserFiles(
    new Map([
      ["lqtest_mod/one.cfg", text("echo mod-one")],
      ["lqtest_id1/one.cfg", text("echo id1-one")],
      ["lqtest_id1/two.cfg", text("echo id1-two")],
      ["lqtest_id1/maps/three.cfg", text("echo three")],
      ["lqtest_id1/four.txt", text("echo four")],
    ]),
  );
  COM_SetLooseFileBasePaths(["lqtest_mod/", "lqtest_id1/"]);
  try {
    assertEqual(fileText("two.cfg"), null, "two.cfg before the preload");
    assertEqual(await COM_PreloadLooseConfigs(), 2, "files loaded");
    assertEqual(fileText("one.cfg"), "echo mod-one", "game directory first");
    assertEqual(fileText("two.cfg"), "echo id1-two", "id1's");
    assertEqual(fileText("maps/three.cfg"), null, "subdirectories skipped");
    assertEqual(fileText("four.txt"), null, "only .cfg");
    assertEqual(await COM_PreloadLooseConfigs(), 0, "loaded only once");
  } finally {
    COM_SetUserFiles(new Map());
    COM_SetLooseFileBasePaths(["static/"]);
  }
});

Deno.test("exec of a loose .cfg runs it before the rest of the buffer", async () => {
  capture();
  COM_SetUserFiles(
    new Map([["lqtest_order/order.cfg", text("echo inside\necho inside2")]]),
  );
  COM_SetLooseFileBasePaths(["lqtest_order/"]);
  try {
    await COM_PreloadLooseConfigs();
    assertEqual(
      exec("exec order.cfg; echo after\n"),
      "execing order.cfg\ninside \ninside2 \nafter \n",
      "exec then echo",
    );
    exec('alias lqtest_order "exec order.cfg"\n');
    assertEqual(
      exec("lqtest_order; echo after\n"),
      "execing order.cfg\ninside \ninside2 \nafter \n",
      "alias that execs",
    );
    assertEqual(
      exec("exec lqtest_missing.cfg\n"),
      "couldn't exec lqtest_missing.cfg\n",
      "missing file",
    );
  } finally {
    exec("unalias lqtest_order\n");
    COM_SetUserFiles(new Map());
    COM_SetLooseFileBasePaths(["static/"]);
  }
});

Deno.test("Deno loads loose *.cfg files from disk", async () => {
  capture();
  const dir = await Deno.makeTempDir({ prefix: "icaro_loose_cfg_" });
  try {
    await Deno.writeTextFile(dir + "/LQTest_Disk.cfg", "echo disk");
    await Deno.writeTextFile(dir + "/lqtest_disk.txt", "echo no");
    COM_SetLooseFileBasePaths([dir + "/"]);
    assertEqual(await COM_PreloadLooseConfigs(), 1, "files loaded");
    assertEqual(
      exec("exec lqtest_disk.cfg\n"),
      "execing lqtest_disk.cfg\ndisk \n",
      "exec, any case",
    );
  } finally {
    COM_SetLooseFileBasePaths(["static/"]);
    await Deno.remove(dir, { recursive: true });
  }
});

const LQ_ID1 = "static/librequake/id1/";
const haveLibreQuake = (() => {
  try {
    return Deno.statSync(LQ_ID1 + "style_ironwail_modern.cfg").isFile;
  } catch {
    return false;
  }
})();

Deno.test({
  name: "LibreQuake's style, zoom and dev cfgs exec",
  ignore: !haveLibreQuake,
  async fn() {
    capture();
    COM_SetLooseFileBasePaths([LQ_ID1]);
    try {
      await COM_PreloadLooseConfigs();
      for (
        const name of [
          "style_ironwail_modern.cfg",
          "style_ironwail_retro.cfg",
          "zoom90.cfg",
          "zoom120.cfg",
          "dev.cfg",
        ]
      ) {
        if (COM_FindFile(name) === null) {
          throw new Error(name + " was not loaded");
        }
      }
      const out = exec("exec style_ironwail_modern.cfg\n");
      if (!out.startsWith("execing style_ironwail_modern.cfg\nModern Style")) {
        throw new Error("style_ironwail_modern.cfg did not run: " + out);
      }
    } finally {
      COM_SetLooseFileBasePaths(["static/"]);
    }
  },
});
