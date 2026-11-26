// Listen-server rules: -listen in Host_FindMaxClients (WinQuake/host.c), and
// a host tab going away telling its players (Host_PageHide, a web addition).

await import("../src/gl_rsurf.js");
const common = await import("../src/common.js");
const host = await import("../src/host.js");
const cvar = await import("../src/cvar.js");
const net = await import("../src/net.js");
const { svs, sv, client_t } = await import("../src/server.js");
const { svc_disconnect } = await import("../src/protocol.js");

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

function quiet(fn) {
  const original = console.log;
  console.log = () => {};
  try {
    return fn();
  } finally {
    console.log = original;
  }
}

Deno.test("Host_FindMaxClients: -listen sets the slots and deathmatch as in the C", () => {
  const savedArgv = common.com_argv.slice();
  const saved = {
    maxclients: svs.maxclients,
    limit: svs.maxclientslimit,
    clients: svs.clients,
  };
  if (cvar.Cvar_FindVar("deathmatch") === null) {
    cvar.Cvar_RegisterVariable(host.deathmatch);
  }
  const savedDeathmatch = cvar.Cvar_VariableString("deathmatch");

  const cases = [
    // argv, maxclients, maxclientslimit, deathmatch
    [[], 1, 4, 0],
    [["-listen"], 8, 8, 1],
    [["-listen", "6"], 6, 6, 1],
    [["-listen", "2"], 2, 4, 1],
    [["-listen", "1"], 1, 4, 0],
    [["-listen", "0"], 8, 8, 1],
    [["-listen", "99"], 16, 16, 1],
    [["-listen", "-particles", "9"], 8, 8, 1],
  ];

  try {
    for (const [args, maxclients, limit, dm] of cases) {
      common.COM_InitArgv(["quake", ...args]);
      host.Host_FindMaxClients();
      const label = args.join(" ") || "no flag";
      assertEqual(svs.maxclients, maxclients, label + ": maxclients");
      assertEqual(svs.maxclientslimit, limit, label + ": maxclientslimit");
      assertEqual(svs.clients.length, limit, label + ": client slots");
      assertEqual(host.deathmatch.value, dm, label + ": deathmatch");
    }
  } finally {
    common.COM_InitArgv(savedArgv);
    svs.maxclients = saved.maxclients;
    svs.maxclientslimit = saved.limit;
    svs.clients = saved.clients;
    cvar.Cvar_Set("deathmatch", savedDeathmatch);
  }
});

Deno.test("Host_PageHide: a listen server sends svc_disconnect to its players; single player does nothing", () => {
  // A remote driver in slot 1 that records what it sends
  const sent = [];
  let closed = 0;
  const driver = {
    initialized: true,
    CanSendMessage: () => true,
    QSendMessage: (_sock, data) => {
      sent.push(Array.from(data.data.subarray(0, data.cursize)));
      return 1;
    },
    QGetMessage: () => 0,
    Close: () => {
      closed++;
    },
  };

  const saved = {
    maxclients: svs.maxclients,
    clients: svs.clients,
    drivers: net.net_drivers.slice(0, 2),
    numdrivers: net.net_numdrivers,
    active: sv.active,
  };

  function remotePlayer() {
    const sock = new net.qsocket_t();
    sock.driver = 1;
    sock.disconnected = false;
    net.set_net_activeSockets(sock);
    const c = new client_t();
    c.active = true;
    c.spawned = false; // no QuakeC to run
    c.name = "joiner";
    c.netconnection = sock;
    c.message.data = c.msgbuf;
    c.message.maxsize = c.msgbuf.length;
    return c;
  }

  try {
    net.set_net_numdrivers(2);
    net.net_drivers[1] = driver;

    // Single player: the server keeps running
    svs.maxclients = 1;
    svs.clients = [remotePlayer()];
    sv.active = true;
    quiet(() => host.Host_PageHide());
    assertEqual(sv.active, true, "single player untouched");
    assertEqual(sent.length, 0, "nothing sent");

    // Listen server with one remote player
    svs.maxclients = 4;
    svs.clients = [
      remotePlayer(),
      new client_t(),
      new client_t(),
      new client_t(),
    ];
    const player = svs.clients[0];
    const start = performance.now();
    quiet(() => host.Host_PageHide());
    // NET_SendToAll once waited out its 5 s block time on the empty slots
    assertEqual(
      performance.now() - start < 1000,
      true,
      "no wait on empty slots",
    );
    assertEqual(sv.active, false, "server shut down");
    assertEqual(sent.length > 0, true, "something sent");
    assertEqual(
      sent.every((m) => m.includes(svc_disconnect)),
      true,
      "svc_disconnect sent: " + JSON.stringify(sent),
    );
    assertEqual(closed, 1, "connection closed");
    assertEqual(player.active, false, "player dropped");

    // Nothing running: nothing to do
    sent.length = 0;
    quiet(() => host.Host_PageHide());
    assertEqual(sent.length, 0, "no server, nothing sent");

    // A backed-up connection: a closing tab tries once instead of waiting
    // 3 s for the flush and 5 s in NET_SendToAll
    driver.CanSendMessage = () => false;
    closed = 0;
    svs.maxclients = 4;
    svs.clients = [
      remotePlayer(),
      new client_t(),
      new client_t(),
      new client_t(),
    ];
    const stuck = svs.clients[0];
    stuck.message.cursize = 1; // a pending message the flush loop can't send
    sv.active = true;
    const stuckStart = performance.now();
    quiet(() => host.Host_PageHide());
    assertEqual(
      performance.now() - stuckStart < 1000,
      true,
      "no wait on a backed-up connection",
    );
    assertEqual(sv.active, false, "server shut down");
    assertEqual(closed, 1, "connection closed");
    assertEqual(stuck.active, false, "player dropped");
  } finally {
    net.set_net_activeSockets(null);
    net.set_net_numdrivers(saved.numdrivers);
    net.net_drivers[0] = saved.drivers[0];
    net.net_drivers[1] = saved.drivers[1];
    svs.maxclients = saved.maxclients;
    svs.clients = saved.clients;
    sv.active = saved.active;
  }
});
