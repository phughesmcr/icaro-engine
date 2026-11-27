// The lazy map fetch in CL_ParseServerInfo (web-only): a client that joins a
// server whose map it doesn't have must drop the connection while it fetches
// the map, not sign on as a player with no world.

// Bootstrap the client renderer graph in its established safe import order.
await import("../src/gl_rsurf.js");

const { CL_ParseServerMessage, cl_icaro } = await import("../src/cl_parse.js");
const { cl, cls, ca_connected, ca_disconnected } = await import(
  "../src/client.js"
);
const { SV_SendServerinfo } = await import("../src/sv_main.js");
const { client_t, sv, svs } = await import("../src/server.js");
const net = await import("../src/net.js");
const {
  MSG_WriteByte,
  MSG_WriteLong,
  MSG_WriteString,
  SZ_Clear,
  SZ_Alloc,
  COM_SetNetMessage,
} = await import("../src/common.js");
const common = await import("../src/common.js");
const { COM_SetLooseFileBasePath } = await import("../src/pak.js");
const {
  PROTOCOL_ICARO,
  PROTOCOL_VERSION,
  GAME_DEATHMATCH,
  svc_serverinfo,
  svc_signonnum,
  clc_disconnect,
} = await import("../src/protocol.js");

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

/**
 * Connects the client over a fake driver, parses the message `write` puts in
 * net_message, checks that the client dropped the connection for the map
 * fetch, then runs `check` and restores the state it touched.
 */
async function lazyMapCase(write, check) {
  const FAKE_DRIVER = net.MAX_NET_DRIVERS - 1;
  const savedDriver = net.net_drivers[FAKE_DRIVER];
  const savedActive = net.net_activeSockets;
  const savedFree = net.net_freeSockets;
  const saved = {
    state: cls.state,
    netcon: cls.netcon,
    signon: cls.signon,
    demonum: cls.demonum,
    demoplayback: cls.demoplayback,
  };
  const savedMessage = {
    data: net.net_message.data,
    maxsize: net.net_message.maxsize,
    cursize: net.net_message.cursize,
  };
  const savedCommonMessage = common.net_message;
  const savedClientMessage = {
    data: cls.message.data,
    maxsize: cls.message.maxsize,
  };
  const tempDir = await Deno.makeTempDir();

  const sent = [];
  let closes = 0;
  net.net_drivers[FAKE_DRIVER] = {
    initialized: true,
    SendUnreliableMessage(_sock, data) {
      sent.push(Array.from(data.data.subarray(0, data.cursize)));
      return 1;
    },
    Close() {
      closes++;
    },
  };

  try {
    const sock = new net.qsocket_t();
    sock.disconnected = false;
    sock.driver = FAKE_DRIVER;
    sock.address = "wts://127.0.0.1:4434";
    sock.next = null;
    net.set_net_activeSockets(sock);

    // Connected to a remote server, as Host_Connect_f leaves it.
    cls.state = ca_connected;
    cls.netcon = sock;
    cls.signon = 0;
    cls.demonum = -1;
    cls.demoplayback = false;
    SZ_Alloc(cls.message, 1024); // CL_Init allocates it
    COM_SetLooseFileBasePath(tempDir + "/");

    COM_SetNetMessage(net.net_message); // Host_Init does this
    net.net_message.data = new Uint8Array(1024);
    net.net_message.maxsize = 1024;
    SZ_Clear(net.net_message);
    write(net.net_message);

    let thrown = null;
    try {
      CL_ParseServerMessage();
    } catch (e) {
      thrown = e;
    }

    // Host_EndGame unwinds to Host_Frame, as C's longjmp does.
    assertEqual(
      thrown !== null && thrown.message.startsWith("Host_EndGame:"),
      true,
      "parse ended with Host_EndGame",
    );
    assertEqual(cls.state, ca_disconnected, "client state");
    assertEqual(cls.netcon, null, "netcon");
    assertEqual(closes, 1, "NET_Close calls");
    assertEqual(sent.length, 1, "unreliable messages sent");
    assertEqual(sent[0][0], clc_disconnect, "clc_disconnect sent");
    // The rest of the message (signon 1) was discarded: no "prespawn" queued.
    assertEqual(cls.message.cursize, 0, "queued client message bytes");

    check();

    // Let the (failing) fetch settle before the test ends.
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    net.net_drivers[FAKE_DRIVER] = savedDriver;
    net.set_net_activeSockets(savedActive);
    net.set_net_freeSockets(savedFree);
    cls.state = saved.state;
    cls.netcon = saved.netcon;
    cls.signon = saved.signon;
    cls.demonum = saved.demonum;
    cls.demoplayback = saved.demoplayback;
    cls.message.data = savedClientMessage.data;
    cls.message.maxsize = savedClientMessage.maxsize;
    SZ_Clear(cls.message);
    net.net_message.data = savedMessage.data;
    net.net_message.maxsize = savedMessage.maxsize;
    net.net_message.cursize = savedMessage.cursize;
    COM_SetNetMessage(savedCommonMessage);
    COM_SetLooseFileBasePath("static/");
    await Deno.remove(tempDir, { recursive: true });
  }
}

Deno.test("a missing map drops the connection before it is fetched", async () => {
  // SV_SendServerinfo's layout: the serverinfo, then signon 1 in the same
  // message (here NetQuake 15's, with no hello)
  await lazyMapCase((m) => {
    MSG_WriteByte(m, svc_serverinfo);
    MSG_WriteLong(m, PROTOCOL_VERSION);
    MSG_WriteByte(m, 4);
    MSG_WriteByte(m, GAME_DEATHMATCH);
    MSG_WriteString(m, "Lazy test");
    MSG_WriteString(m, "maps/__lazy_missing.bsp");
    MSG_WriteString(m, "progs/player.mdl");
    MSG_WriteByte(m, 0);
    MSG_WriteByte(m, 0);
    MSG_WriteByte(m, svc_signonnum);
    MSG_WriteByte(m, 1);
  }, () => {
    assertEqual(cl.protocol, PROTOCOL_VERSION, "protocol");
    assertEqual(cl.maxclients, 4, "maxclients");
    assertEqual(cl.levelname, "Lazy test", "levelname");
  });
});

// The server's own serverinfo, versioned hello included (protocol.js), read
// by the client up to the map fetch.
Deno.test("the client reads SV_SendServerinfo's versioned hello", async () => {
  const saved = {
    maxclients: svs.maxclients,
    clients: svs.clients,
    edicts: sv.edicts,
    models: sv.model_precache,
    sounds: sv.sound_precache,
  };
  const client = new client_t();
  client.message.data = client.msgbuf;
  client.message.maxsize = client.msgbuf.length;
  try {
    svs.maxclients = 3;
    svs.clients = [client];
    sv.edicts = [{ v: { message: -1, sounds: 2 } }];
    sv.model_precache = [null, "maps/__lazy_missing.bsp", "progs/player.mdl"];
    sv.sound_precache = [null, "weapons/r_exp3.wav"];
    SV_SendServerinfo(client);

    await lazyMapCase((m) => {
      common.SZ_Write(
        m,
        client.message.data.subarray(0, client.message.cursize),
        client.message.cursize,
      );
    }, () => {
      assertEqual(cl.protocol, PROTOCOL_ICARO, "protocol");
      assertEqual(cl_icaro.revision, 1, "revision");
      assertEqual(cl_icaro.game, "quake", "game profile");
      assertEqual(cl_icaro.required.length, 0, "required words");
      assertEqual(cl_icaro.optional.length, 0, "optional words");
      assertEqual(cl.maxclients, 3, "maxclients after the hello");
      assertEqual(cl.gametype, 0, "gametype (coop)");
    });
  } finally {
    svs.maxclients = saved.maxclients;
    svs.clients = saved.clients;
    sv.edicts = saved.edicts;
    sv.model_precache = saved.models;
    sv.sound_precache = saved.sounds;
  }
});
