// The lazy map fetch in CL_ParseServerInfo (web-only): a client that joins a
// server whose map it doesn't have must drop the connection while it fetches
// the map, not sign on as a player with no world.

// Bootstrap the client renderer graph in its established safe import order.
await import("../src/gl_rsurf.js");

const { CL_ParseServerMessage } = await import("../src/cl_parse.js");
const { cls, ca_connected, ca_disconnected } = await import("../src/client.js");
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

Deno.test("a missing map drops the connection before it is fetched", async () => {
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

    // SV_SendServerinfo: the serverinfo, then signon 1 in the same message.
    COM_SetNetMessage(net.net_message); // Host_Init does this
    net.net_message.data = new Uint8Array(1024);
    net.net_message.maxsize = 1024;
    SZ_Clear(net.net_message);
    MSG_WriteByte(net.net_message, svc_serverinfo);
    MSG_WriteLong(net.net_message, PROTOCOL_VERSION);
    MSG_WriteByte(net.net_message, 4);
    MSG_WriteByte(net.net_message, GAME_DEATHMATCH);
    MSG_WriteString(net.net_message, "Lazy test");
    MSG_WriteString(net.net_message, "maps/__lazy_missing.bsp");
    MSG_WriteString(net.net_message, "progs/player.mdl");
    MSG_WriteByte(net.net_message, 0);
    MSG_WriteByte(net.net_message, 0);
    MSG_WriteByte(net.net_message, svc_signonnum);
    MSG_WriteByte(net.net_message, 1);

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
});
