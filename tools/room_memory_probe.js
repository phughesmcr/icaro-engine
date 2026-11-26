// Memory attribution for one room: the JS heap and off-heap (ArrayBuffer)
// memory after a full GC at each stage of game_server.js's Host_Init_Server,
// without networking. Used for docs/always-on-hosting.md; not part of the
// game or CI.
//
//   deno run -A --v8-flags=--expose-gc tools/room_memory_probe.js [map] [pak] [--lazy]
//
// --lazy opens the pak lazily (COM_SetLazyPakSize( 0 )), reading only the
// files the room asks for instead of holding the whole pak in memory.

const lazy = Deno.args.includes("--lazy");
const args = Deno.args.filter((a) => a !== "--lazy");
const map = args[0] ?? "start";
const pak = args[1] ?? "static/pak0.pak";
const rows = [];
const mb = (x) => +(x / 1048576).toFixed(1);

function sample(stage) {
  if (typeof globalThis.gc !== "function") {
    throw new Error("run with --v8-flags=--expose-gc");
  }
  globalThis.gc();
  globalThis.gc();
  const m = Deno.memoryUsage();
  rows.push({
    stage,
    heapUsedMB: mb(m.heapUsed),
    externalMB: mb(m.external),
    isolateMB: mb(m.heapUsed + m.external),
    rssMB: mb(m.rss),
  });
}

sample("empty");

// Everything game_server.js imports (its main() only runs as the entry point)
await import("../server/game_server.js");
const { COM_InitArgv, LOC_Init } = await import("../src/common.js");
const { COM_AddPakSequence, COM_EnsureFile, COM_SetLazyPakSize } = await import(
  "../src/pak.js"
);
const { Cbuf_Init, Cmd_Init } = await import("../src/cmd.js");
const { Host_InitCommands } = await import("../src/host_cmd.js");
const { deathmatch, campaign, horde, sv_cheats } = await import(
  "../src/host.js"
);
const { Cvar_RegisterVariable } = await import("../src/cvar.js");
const { cls, ca_dedicated } = await import("../src/client.js");
const { Memory_Init } = await import("../src/zone.js");
const { PR_Init } = await import("../src/pr_edict.js");
const { SV_Init, SV_SpawnServer } = await import("../src/sv_main.js");
const { svs, sv, client_t } = await import("../src/server.js");
const { Mod_Init, R_InitTextures } = await import("../src/gl_model.js");
const { NET_Init } = await import("../src/net_main.js");
sample("engine modules imported");

const quiet = console.log;
console.log = () => {};
COM_InitArgv(["game_server"]);
Memory_Init();
Cbuf_Init();
Cmd_Init();
Host_InitCommands();
cls.state = ca_dedicated;
svs.maxclients = 16;
svs.maxclientslimit = 16;
svs.clients = [];
for (let i = 0; i < 16; i++) svs.clients[i] = new client_t();
NET_Init();
PR_Init();
Mod_Init();
R_InitTextures();
SV_Init();
Cvar_RegisterVariable(campaign);
Cvar_RegisterVariable(horde);
Cvar_RegisterVariable(sv_cheats);
deathmatch.value = 1;
deathmatch.string = "1";
console.log = quiet;
sample("subsystems initialised (16 client slots)");

console.log = () => {};
if (lazy) COM_SetLazyPakSize(0);
if (await COM_AddPakSequence(pak) === 0) throw new Error("no pak");
LOC_Init();
console.log = quiet;
sample("pak loaded");

console.log = () => {};
const t0 = performance.now();
await COM_EnsureFile("maps/" + map + ".bsp");
SV_SpawnServer(map);
const spawnMs = performance.now() - t0;
console.log = quiet;
if (sv.active !== true) throw new Error("map did not spawn");
sample("map " + map + " spawned");

console.log(JSON.stringify({ map, lazy, spawnMs: +spawnMs.toFixed(1), rows }));
