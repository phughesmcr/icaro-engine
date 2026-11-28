// Icaro rooms are public links, so a guest (a client that joined over a
// network driver) can't act as the host: no kick, no pause, no cheats unless
// sv_guestcheats is 1, whatever deathmatch is. The player on the loopback
// connection keeps id's powers. Guests' chat and name changes are flood
// protected as QuakeWorld's server does (QW/server/sv_user.c SV_Say,
// sv_main.c SV_ExtractFromUserinfo).

import { TD_Mount } from "./test_data.js";

await import("../src/gl_rsurf.js");
const common = await import("../src/common.js");
await import("../src/pak.js");
const cmd = await import("../src/cmd.js");
const cvar = await import("../src/cvar.js");
const zone = await import("../src/zone.js");
await import("../src/host.js");
const host_cmd = await import("../src/host_cmd.js");
const pr_edict = await import("../src/pr_edict.js");
const progs = await import("../src/progs.js");
const sv_main = await import("../src/sv_main.js");
const sv_phys = await import("../src/sv_phys.js");
const sv_user = await import("../src/sv_user.js");
const gl_model = await import("../src/gl_model.js");
const server = await import("../src/server.js");
const client = await import("../src/client.js");
const net = await import("../src/net.js");
const net_main = await import("../src/net_main.js");
const net_loop = await import("../src/net_loop.js");
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
common.Con_SetPrintFunctions(
  (fmt, ...args) =>
    printed.push(
      args.length === 0 ? String(fmt) : consolejs._sprintf(fmt, ...args),
    ),
  () => {},
);

async function quietly(fn) {
  const log = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
  }
}

zone.Memory_Init();
cmd.Cbuf_Init();
cmd.Cmd_Init();
host_cmd.Host_InitCommands();

let ready = null;
let hostClient = null;
let guestClient = null;
let guestSocket = null;

/**
 * A two-player server on start: client 0 is the player on the loopback
 * connection, client 1 a guest on a network socket (driver 1, never called:
 * the socket is marked disconnected, so dropping it sends nothing).
 */
function setup() {
  if (ready === null) ready = setupOnce();
  return ready;
}

async function setupOnce() {
  await TD_Mount();
  client.cls.state = client.ca_dedicated; // map doesn't connect a local client
  server.svs.maxclients = 2;
  server.svs.maxclientslimit = 2;
  server.svs.clients = [new server.client_t(), new server.client_t()];

  const hadWindow = "window" in globalThis;
  if (hadWindow === false) globalThis.window = { addEventListener() {} };
  try {
    await quietly(() => net_main.NET_Init());
  } finally {
    if (hadWindow === false) delete globalThis.window;
  }

  printed.length = 0;
  pr_edict.PR_Init();
  gl_model.Mod_Init();
  sv_main.SV_Init();
  cmd.Cmd_ExecuteString("map start", cmd.src_command);
  assertEqual(server.sv.active, true, "map start ran");

  net_loop.Loop_Connect("local");
  const loopSocket = net_loop.Loop_CheckNewConnections();
  assertEqual(net_loop.Loop_IsServerSocket(loopSocket), true, "loopback");

  guestSocket = new net.qsocket_t();
  guestSocket.address = "rtc:GUEST";
  guestSocket.driver = 1;
  guestSocket.disconnected = true;

  hostClient = server.svs.clients[0];
  guestClient = server.svs.clients[1];
  const sockets = [loopSocket, guestSocket];
  const names = ["Host", "Guest"];
  for (let i = 0; i < 2; i++) {
    const c = server.svs.clients[i];
    c.netconnection = sockets[i];
    c.message.data = c.msgbuf;
    c.message.maxsize = c.msgbuf.length;
    c.message.allowoverflow = true;
    c.edict = progs.EDICT_NUM(i + 1);
    c.name = names[i];
  }
}

/** Activates both clients, as players in the game. */
function reset() {
  for (const c of server.svs.clients) {
    c.active = true;
    c.spawned = true;
    c.privileged = false;
    c.edict.v.flags = 0;
    c.edict.v.movetype = sv_phys.MOVETYPE_WALK;
    c.lockedtill = 0;
    c.whensaid.fill(0);
    c.whensaidhead = 0;
    c.lastnametime = 0;
    c.lastnamecount = 0;
    common.SZ_Clear(c.message);
  }
  server.sv.paused = false;
}

/** Runs text as client c's clc_stringcmd does once it is allowed. */
function runAs(c, text) {
  assertEqual(sv_user.SV_ClientCommandAllowed(text), true, "allowed " + text);
  server.set_host_client(c);
  sv_phys.SV_SetPlayer(c.edict);
  printed.length = 0;
  const log = console.log; // Host_Say echoes chat with Sys_Printf
  console.log = () => {};
  try {
    cmd.Cmd_ExecuteString(text, cmd.src_client);
  } finally {
    console.log = log;
  }
}

/** The text SV_ClientPrintf has queued for c since the last reset. */
function queued(c) {
  const bytes = c.message.data.subarray(0, c.message.cursize);
  return new TextDecoder().decode(bytes);
}

Deno.test("Host_ClientIsGuest: the loopback player isn't a guest, a network client is", async () => {
  await setup();
  reset();
  assertEqual(host_cmd.Host_ClientIsGuest(hostClient), false, "host");
  assertEqual(host_cmd.Host_ClientIsGuest(guestClient), true, "guest");
  guestClient.privileged = true;
  assertEqual(host_cmd.Host_ClientIsGuest(guestClient), false, "privileged");
});

Deno.test("a guest can't kick the host (or anyone) in co-op", async () => {
  await setup();
  const pr = progs.pr_global_struct;
  const oldDeathmatch = pr.deathmatch;
  try {
    for (const deathmatch of [0, 1]) {
      reset();
      pr.deathmatch = deathmatch;
      runAs(guestClient, "kick Host");
      assertEqual(hostClient.active, true, `dm ${deathmatch}: host stays`);
      runAs(guestClient, "kick # 1 bye");
      assertEqual(hostClient.active, true, `dm ${deathmatch}: by number`);
    }
    assertEqual(
      queued(guestClient).includes("Only the host can kick."),
      false,
      "deathmatch refuses silently, as id's C does",
    );
    reset();
    pr.deathmatch = 0;
    runAs(guestClient, "kick Host");
    assertEqual(
      queued(guestClient).includes("Only the host can kick."),
      true,
      "co-op tells the guest",
    );
  } finally {
    pr.deathmatch = oldDeathmatch;
    reset();
  }
});

Deno.test("the host can still kick a guest from the console", async () => {
  await setup();
  reset();
  try {
    // host_cmd.c's "can't kick yourself" compares with host_client
    server.set_host_client(hostClient);
    printed.length = 0;
    cmd.Cmd_ExecuteString("kick Guest", cmd.src_command);
    assertEqual(guestClient.active, false, "guest dropped");
    assertEqual(hostClient.active, true, "host stays");
  } finally {
    guestClient.netconnection = guestSocket; // SV_DropClient cleared it
    reset();
  }
});

Deno.test("a guest can't pause; the loopback player can", async () => {
  await setup();
  // host.js registers pausable in Host_InitLocal, which this test skips
  if (cvar.Cvar_FindVar("pausable") === null) {
    cvar.Cvar_RegisterVariable(new cvar.cvar_t("pausable", "1"));
  }
  const oldPausable = cvar.Cvar_VariableString("pausable");
  try {
    reset();
    cvar.Cvar_Set("pausable", "1");
    runAs(guestClient, "pause");
    assertEqual(server.sv.paused, false, "guest refused");
    assertEqual(
      queued(guestClient).includes("Only the host can pause."),
      true,
      "guest told",
    );
    runAs(hostClient, "pause");
    assertEqual(server.sv.paused, 1, "host pauses");
  } finally {
    cvar.Cvar_Set("pausable", oldPausable);
    reset();
  }
});

Deno.test("guests get no cheats in co-op unless sv_guestcheats is 1", async () => {
  await setup();
  const pr = progs.pr_global_struct;
  const oldDeathmatch = pr.deathmatch;
  const oldGuestCheats = cvar.Cvar_VariableString("sv_guestcheats");
  try {
    assertEqual(oldGuestCheats, "0", "sv_guestcheats defaults to 0");
    reset();
    pr.deathmatch = 0;
    const v = guestClient.edict.v;
    const items = v.items;
    runAs(guestClient, "god");
    runAs(guestClient, "notarget");
    assertEqual(v.flags | 0, 0, "no god or notarget");
    runAs(guestClient, "fly");
    runAs(guestClient, "noclip");
    assertEqual(v.movetype, sv_phys.MOVETYPE_WALK, "no fly or noclip");
    runAs(guestClient, "give 8");
    assertEqual(v.items, items, "no give");
    assertEqual(
      queued(guestClient).includes("Cheats are for the host only."),
      true,
      "guest told",
    );

    // the loopback player keeps them
    runAs(hostClient, "god");
    assertEqual(
      ((hostClient.edict.v.flags | 0) & sv_phys.FL_GODMODE) !== 0,
      true,
      "host god",
    );

    cvar.Cvar_Set("sv_guestcheats", "1");
    runAs(guestClient, "god");
    assertEqual(((v.flags | 0) & sv_phys.FL_GODMODE) !== 0, true, "opt-in god");

    // id's deathmatch gate still holds with sv_guestcheats 1
    v.flags = 0;
    pr.deathmatch = 1;
    runAs(guestClient, "god");
    assertEqual(v.flags | 0, 0, "deathmatch refuses");
  } finally {
    pr.deathmatch = oldDeathmatch;
    cvar.Cvar_Set("sv_guestcheats", oldGuestCheats);
    reset();
  }
});

Deno.test("a client's command never runs an alias or sets a cvar (QuakeSpasm)", async () => {
  await setup();
  reset();
  const oldGuestCheats = cvar.Cvar_VariableString("sv_guestcheats");
  try {
    cmd.Cmd_ExecuteString('alias ban "sv_guestcheats 1"', cmd.src_command);
    runAs(guestClient, "ban Host"); // id's list allows "ban", no such command
    cmd.Cbuf_Execute();
    assertEqual(cvar.Cvar_VariableString("sv_guestcheats"), "0", "no alias");
  } finally {
    cvar.Cvar_Set("sv_guestcheats", oldGuestCheats);
    reset();
  }
});

/** The chat lines that reached the host's client since the last reset. */
function chatLines() {
  return queued(hostClient).split("\x01").length - 1;
}

Deno.test("a guest's chat is flood protected as QuakeWorld's SV_Say", async () => {
  await setup();
  const oldTime = net.net_time;
  try {
    reset();
    net.set_net_time(100);
    for (let i = 0; i < 4; i++) runAs(guestClient, "say hi " + i);
    assertEqual(chatLines(), 4, "four lines pass");
    runAs(guestClient, "say_team five");
    assertEqual(chatLines(), 4, "the fifth in 4 seconds is dropped");
    assertEqual(
      queued(guestClient).includes(
        "FloodProt: You can't talk for 10 seconds.",
      ),
      true,
      "guest told",
    );

    net.set_net_time(105);
    runAs(guestClient, "say still locked");
    assertEqual(chatLines(), 4, "locked for 10 seconds");
    assertEqual(
      queued(guestClient).includes("You can't talk for 5 more seconds"),
      true,
      "time left",
    );
    runAs(guestClient, "tell Host psst");
    assertEqual(queued(hostClient).includes("psst"), false, "tell too");

    net.set_net_time(110.5);
    runAs(guestClient, "say back");
    assertEqual(chatLines(), 5, "talks again after the lock");

    // the loopback player isn't limited
    for (let i = 0; i < 8; i++) runAs(hostClient, "say host " + i);
    assertEqual(chatLines(), 13, "host unlimited");

    // floodprot changes the limits, with QW's checks
    printed.length = 0;
    cmd.Cmd_ExecuteString("floodprot 0 1 1", cmd.src_command);
    assertEqual(
      printed.join("").includes("All values must be positive numbers"),
      true,
      "floodprot can't turn it off",
    );
    cmd.Cmd_ExecuteString("floodprot 2 4 10", cmd.src_command);
    reset();
    net.set_net_time(200);
    runAs(guestClient, "say one");
    runAs(guestClient, "say two");
    runAs(guestClient, "say three");
    assertEqual(chatLines(), 2, "floodprot 2 4 10");
  } finally {
    cmd.Cmd_ExecuteString("floodprot 4 4 10", cmd.src_command);
    net.set_net_time(oldTime);
    reset();
  }
});

Deno.test("a guest's name changes are rate limited (QuakeWorld's name spam check)", async () => {
  await setup();
  const oldTime = net.net_time;
  try {
    reset();
    net.set_net_time(300);
    for (let i = 1; i <= 6; i++) runAs(guestClient, "name Guest" + i);
    assertEqual(guestClient.name, "Guest6", "six changes in 5 seconds pass");
    runAs(guestClient, "name Spammer");
    assertEqual(guestClient.name, "Guest6", "the seventh is refused");
    assertEqual(guestClient.active, true, "not kicked, unlike QW");
    assertEqual(
      queued(guestClient).includes("You can't change your name that often."),
      true,
      "guest told",
    );

    net.set_net_time(305.5);
    runAs(guestClient, "name Calm");
    assertEqual(guestClient.name, "Calm", "allowed after 5 seconds");

    for (let i = 1; i <= 10; i++) runAs(hostClient, "name Host" + i);
    assertEqual(hostClient.name, "Host10", "host unlimited");
  } finally {
    net.set_net_time(oldTime);
    hostClient.name = "Host";
    guestClient.name = "Guest";
    reset();
  }
});
