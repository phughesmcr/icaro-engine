// Lifecycle tests for the browser driver (src/net_webtransport.js), connected
// to the real server driver through in-memory WebTransport pairs.

const {
  server,
  net,
  net_message,
  assert,
  assertEqual,
  FrameReader,
  openSession,
  svCheckForNewClients,
  setupServer,
  drainMessages,
  message,
  svs,
} = await import("./webtransport_test_env.js");
const client = await import("../src/net_webtransport.js");
const { qsocket_t } = net;
const { svc_disconnect, clc_disconnect, clc_nop } = await import(
  "../src/protocol.js"
);
const keys = await import("../src/keys.js");
const {
  createFakeWebTransportPair,
  writtenBytes,
  splitFrames,
  sequencedPacket,
  delay,
  waitFor,
} = await import("./fake_webtransport.js");

// The driver registers its page-hide handler on window; capture it.
const pageHandlers = {};
globalThis.window = {
  addEventListener(type, handler) {
    pageHandlers[type] = handler;
  },
};

// new WebTransport( url ) returns whatever the current test's factory makes.
let transportFactory = null;
globalThis.WebTransport = function (url) {
  return transportFactory(url);
};

assertEqual(client.WT_Init(), 0, "WT_Init");
delete globalThis.window;
assert(
  typeof pageHandlers.pagehide === "function",
  "pagehide handler registered",
);

client.WT_SetTimeouts({
  connectMs: 2000,
  handshakeMs: 1000,
  closeFlushMs: 300,
});

function freeSocketCount() {
  let n = 0;
  for (let s = net.net_freeSockets; s != null; s = s.next) n++;
  return n;
}

// Each new transport is a fake pair whose server end goes to the server driver.
function useServerDriver(options = {}) {
  const pairs = [];
  transportFactory = () => {
    const session = openSession(null, options);
    pairs.push(session.pair);
    return session.pair.client;
  };
  return pairs;
}

// Capture console output (Con_Printf) while fn runs.
async function captureOutput(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(" "));
  try {
    const result = await fn();
    return { result, output: lines.join("\n") };
  } finally {
    console.log = original;
  }
}

async function connectClient() {
  const pairs = useServerDriver();
  const sock = await client.WT_Connect("localhost:4433");
  assert(sock != null, "client connected");
  const [serverSock] = svCheckForNewClients();
  assert(serverSock != null, "server accepted the client");
  return { sock, serverSock, pair: pairs[0] };
}

function withClientMessageBuffer(fn) {
  return async () => {
    const data = net_message.data;
    const maxsize = net_message.maxsize;
    try {
      await fn();
    } finally {
      net_message.data = data;
      net_message.maxsize = maxsize;
    }
  };
}

Deno.test("client and server complete the handshake and exchange messages", async () => {
  const teardown = setupServer({ maxclients: 4, sockets: 10 });
  try {
    const { sock, serverSock } = await connectClient();
    assertEqual(client.WT_QGetMessage(sock), 0, "client idle");

    server.WT_QSendMessage(serverSock, message([svc_disconnect - 1]));
    await waitFor(
      () => sock.driverdata.pendingMessages.length > 0,
      1000,
      "server message",
    );
    assertEqual(client.WT_QGetMessage(sock), 1, "reliable message");
    assertEqual(net_message.data[0], svc_disconnect - 1, "payload");

    client.WT_QSendMessage(sock, message([clc_nop]));
    await waitFor(
      () => serverSock.driverdata.pendingMessages.length > 0,
      1000,
      "client message",
    );
    assertEqual(server.WT_QGetMessage(serverSock), 1, "server receives");
    assertEqual(net_message.data[0], clc_nop, "client payload");

    client.WT_Close(sock);
  } finally {
    await teardown();
  }
});

Deno.test("MENU-4: an accepted connection clears the Join menu error return", async () => {
  // Set m_return_onerror the way the player does: Join on a room list.
  const cmd = await import("../src/cmd.js");
  const menu = await import("../src/menu.js");
  const sys = await import("../src/sys.js");
  const saved = {};
  for (const name of ["location", "history"]) saved[name] = globalThis[name];
  globalThis.location = {
    origin: "https://example.test",
    pathname: "/",
    search: "",
  };
  globalThis.history = { replaceState: () => {} };

  const teardown = setupServer({ maxclients: 4, sockets: 10 });
  try {
    cmd.Cbuf_Init();
    cmd.Cmd_Init();
    menu.M_Init();
    menu.M_SetExternals({
      // The lobby helpers net_main.js injects, as they behave over WebTransport
      NET_QueryRooms: () =>
        Promise.resolve([{
          id: "AB12",
          map: "e1m1",
          playerCount: 0,
          maxPlayers: 4,
        }]),
      NET_MultiplayerAvailable: () => true,
      NET_LobbyServer: () => sys.Sys_LobbyURL(),
      NET_LobbyJoinURL: (lobby, roomId) =>
        sys.Sys_ConnectURL(lobby, roomId, null),
      key_dest_set: keys.set_key_dest,
      key_dest_get: () => keys.key_dest,
    });
    cmd.Cmd_ExecuteString("menu_lanconfig");
    await delay(0);
    menu.M_Keydown(keys.K_ENTER);
    assert(menu.M_ShouldReturnOnError() === true, "Join sets the error return");

    const { sock } = await connectClient();
    assert(
      menu.M_ShouldReturnOnError() === false,
      "cleared once the server accepts",
    );
    client.WT_Close(sock);
  } finally {
    cmd.Cbuf_Init();
    keys.set_key_dest(keys.key_game);
    for (const name of Object.keys(saved)) {
      if (saved[name] === undefined) delete globalThis[name];
      else globalThis[name] = saved[name];
    }
    await teardown();
  }
});

Deno.test("NET-1/NET-3: a full server rejects with a reason and the client frees everything", async () => {
  const teardown = setupServer({ maxclients: 1, sockets: 10 });
  try {
    const first = await connectClient();
    const free = freeSocketCount();
    keys.set_key_dest(keys.key_game);

    const pairs = useServerDriver();
    const { result, output } = await captureOutput(() =>
      client.WT_Connect("localhost:4433")
    );
    assertEqual(result, null, "connect result");
    assert(output.includes("Server is full"), "reason shown: " + output);
    assertEqual(freeSocketCount(), free, "no client socket leaked");
    assertEqual(keys.key_dest, keys.key_menu, "back in the menu");
    await waitFor(
      () => pairs[0].session.isClosed,
      2000,
      "rejected transport closed",
    );

    client.WT_Close(first.sock);
  } finally {
    await teardown();
  }
});

Deno.test("NET-3: a server that never answers the hello times out and is cleaned up", async () => {
  const teardown = setupServer({ maxclients: 4, sockets: 10 });
  try {
    client.WT_SetTimeouts({ handshakeMs: 100 });
    let pair = null;
    transportFactory = () => {
      pair = createFakeWebTransportPair();
      return pair.client; // nobody serves the other end
    };

    const free = freeSocketCount();
    const start = performance.now();
    const sock = await client.WT_Connect("localhost:4433");
    assertEqual(sock, null, "connect result");
    assert(performance.now() - start < 1000, "handshake timeout honoured");
    assertEqual(freeSocketCount(), free, "no socket allocated");
    await waitFor(() => pair.session.isClosed, 1000, "transport closed");
  } finally {
    client.WT_SetTimeouts({ handshakeMs: 1000 });
    await teardown();
  }
});

Deno.test("NET-3: the connect deadline closes a transport that never becomes ready", async () => {
  const teardown = setupServer({ maxclients: 4, sockets: 10 });
  try {
    client.WT_SetTimeouts({ connectMs: 150 });
    let pair = null;
    transportFactory = () => {
      pair = createFakeWebTransportPair({ ready: new Promise(() => {}) });
      return pair.client;
    };

    const free = freeSocketCount();
    const { result, output } = await captureOutput(() =>
      client.WT_Connect("localhost:4433")
    );
    assertEqual(result, null, "connect result");
    assert(output.includes("timed out"), "timeout reported: " + output);
    assertEqual(freeSocketCount(), free, "no socket allocated");
    assert(pair.session.isClosed, "transport closed by the deadline");
  } finally {
    client.WT_SetTimeouts({ connectMs: 2000 });
    await teardown();
  }
});

Deno.test("NET-4: page hide sends one framed clc_disconnect and closes after the server reacts", async () => {
  const teardown = setupServer({
    maxclients: 4,
    sockets: 10,
    config: { closeFlushMs: 1000 },
  });
  try {
    const { sock, serverSock, pair } = await connectClient();

    pageHandlers.pagehide();

    await waitFor(
      () => serverSock.driverdata.pendingMessages.length > 0,
      1000,
      "clc_disconnect",
    );
    const results = drainMessages(serverSock);
    assertEqual(results[0].ret, 1, "reliable message");
    assertEqual(results[0].payload.length, 1, "payload length");
    assertEqual(results[0].payload[0], clc_disconnect, "payload");

    // Wire format: hello, then one sequenced packet holding clc_disconnect.
    const frames = splitFrames(writtenBytes(pair.streams[0].c2s));
    assertEqual(frames.length, 2, "frames written");
    assertEqual(frames[1][0], 0x71, "sequenced packet magic");
    assertEqual(frames[1].length, 10, "header + clc_disconnect");

    // The server notices the client finished, drops it, and the transport closes.
    await waitFor(
      () => server.WT_QGetMessage(serverSock) === -1,
      1000,
      "server sees disconnect",
    );
    server.WT_Close(serverSock);
    await waitFor(() => pair.session.isClosed, 500, "transport closed");
    assertEqual(client.WT_QGetMessage(sock), -1, "client socket is dead");
  } finally {
    await teardown();
  }
});

Deno.test("NET-4: the client receives the server's final message before the close", async () => {
  const teardown = setupServer({ maxclients: 4, sockets: 10 });
  try {
    const { sock, serverSock } = await connectClient();

    server.WT_QSendMessage(serverSock, message([svc_disconnect]));
    server.WT_Close(serverSock);

    await waitFor(
      () =>
        sock.driverdata.pendingMessages.length > 0 ||
        sock.driverdata.connected === false,
      1000,
      "final message",
    );
    assertEqual(client.WT_QGetMessage(sock), 1, "final message delivered");
    assertEqual(net_message.data[0], svc_disconnect, "svc_disconnect");
    await waitFor(
      () => client.WT_QGetMessage(sock) === -1,
      1000,
      "then the connection ends",
    );
    client.WT_Close(sock);
  } finally {
    await teardown();
  }
});

Deno.test("PRED-2: datagram moves from the client are acknowledged", async () => {
  const teardown = setupServer({ maxclients: 4, sockets: 10 });
  client.WT_SetClientOutboundDatagrams(true);
  try {
    const { sock, serverSock, pair } = await connectClient();

    // The server's first sequenced message tells the client it speaks the header.
    server.WT_QSendMessage(serverSock, message([clc_nop]));
    await waitFor(
      () => sock.driverdata.pendingMessages.length > 0,
      1000,
      "server message",
    );
    client.WT_QGetMessage(sock);

    // clc_move as a datagram, with the sequence CL_StoreCommand records.
    const moveSequence = sock.sendSequence;
    assertEqual(
      client.WT_SendUnreliableMessage(sock, message([0x03, 1, 2, 3])),
      1,
      "move sent",
    );
    await waitFor(
      () => pair.datagramsToServer.written.length === 1,
      1000,
      "datagram on the wire",
    );
    await waitFor(
      () => serverSock.driverdata.pendingMessages.length > 0,
      1000,
      "server got the move",
    );
    drainMessages(serverSock);

    server.WT_QSendMessage(serverSock, message([clc_nop]));
    await waitFor(
      () => sock.driverdata.pendingMessages.length > 0,
      1000,
      "server reply",
    );
    client.WT_QGetMessage(sock);
    assertEqual(
      sock.ackSequence,
      moveSequence,
      "client sees its move acknowledged",
    );

    client.WT_Close(sock);
  } finally {
    client.WT_SetClientOutboundDatagrams(false);
    await teardown();
  }
});

Deno.test("NET-5: client send queues are bounded when the stream stalls", async () => {
  const teardown = setupServer({ maxclients: 4, sockets: 10 });
  try {
    const { sock, pair } = await connectClient();
    pair.streams[0].c2s.setStalled(true);
    await delay(5);

    let sent = 0;
    while (client.WT_CanSendUnreliableMessage(sock)) {
      client.WT_SendUnreliableMessage(sock, message([0x03]));
      sent++;
      assert(sent < 100, "unreliable backpressure never reported");
    }

    assertEqual(sent, 16, "unreliable sends before backpressure");

    // Past the limit, moves are dropped but still use up a sequence number.
    const before = sock.sendSequence;
    assertEqual(
      client.WT_SendUnreliableMessage(sock, message([0x03])),
      1,
      "dropped send result",
    );
    assertEqual(
      sock.sendSequence,
      before + 1,
      "sequence advanced for the dropped move",
    );
    assertEqual(
      sock.driverdata.pendingReliableWrites,
      16,
      "dropped move not queued",
    );

    while (client.WT_CanSendMessage(sock)) {
      client.WT_QSendMessage(sock, message([clc_nop]));
    }
    assertEqual(
      sock.driverdata.pendingReliableWrites,
      64,
      "reliable soft limit",
    );

    let ret = 1;
    for (let i = 0; i < 300 && ret === 1; i++) {
      ret = client.WT_QSendMessage(sock, message([clc_nop]));
    }
    assertEqual(ret, -1, "stuck stream eventually treated as dead");
    assertEqual(sock.driverdata.pendingReliableWrites, 256, "hard limit");
    assertEqual(client.WT_QGetMessage(sock), -1, "connection reported dead");

    pair.streams[0].c2s.setStalled(false);
    client.WT_Close(sock);
  } finally {
    await teardown();
  }
});

Deno.test(
  "NET-5: oversized frames and payloads never reach SZ_Write",
  withClientMessageBuffer(async () => {
    // Reliable frame longer than the protocol allows: the connection is dropped.
    let pair = null;
    transportFactory = () => {
      pair = createFakeWebTransportPair();
      (async () => {
        const reader = pair.server.incomingBidirectionalStreams.getReader();
        const { value: stream } = await reader.read();
        const frames = new FrameReader(stream.readable.getReader());
        await frames.read(); // hello
        const writer = stream.writable.getWriter();
        await writer.write(
          net.WT_BuildHandshakeReplyFrame(net.WT_HANDSHAKE_ACCEPT),
        );
        await writer.write(new Uint8Array([0xff, 0xff, 1, 2, 3]));
      })();
      return pair.client;
    };

    const teardown = setupServer({ maxclients: 4, sockets: 10 });
    try {
      const sock = await client.WT_Connect("localhost:4433");
      assert(sock != null, "connected to the raw server");
      await waitFor(
        () => client.WT_QGetMessage(sock) === -1,
        1000,
        "oversized frame drops the connection",
      );
      client.WT_Close(sock);
      await waitFor(() => pair.session.isClosed, 1000, "transport closed");
    } finally {
      await teardown();
    }

    // Payloads larger than net_message: unreliable dropped, reliable disconnects.
    net_message.data = new Uint8Array(16);
    net_message.maxsize = 16;
    const socket = new qsocket_t();
    socket.receiveSequence = -1;
    socket.unreliableReceiveSequence = -1;
    socket.ackSequence = -1;
    socket.driverdata = {
      connected: true,
      pendingMessages: [
        { reliable: false, data: sequencedPacket(0, 0, new Uint8Array(32)) },
        { reliable: true, data: sequencedPacket(1, 0, new Uint8Array([7])) },
        { reliable: true, data: sequencedPacket(2, 0, new Uint8Array(32)) },
      ],
    };
    assertEqual(client.WT_QGetMessage(socket), 1, "oversized datagram skipped");
    assertEqual(net_message.data[0], 7, "next message delivered");
    assertEqual(
      client.WT_QGetMessage(socket),
      -1,
      "oversized reliable message disconnects",
    );
    assertEqual(socket.driverdata.connected, false, "connection marked dead");
  }),
);

// One room-server tick in WinQuake order (host.c Host_ServerFrame): accept new
// connections first (SV_CheckForNewClients), then read every client and drop
// the ones whose connection is gone (SV_RunClients -> SV_DropClient). Returns
// the slot each new connection got.
function roomServerTick() {
  const slots = [];
  for (const sock of svCheckForNewClients()) {
    slots.push(svs.clients.findIndex((c) => c.netconnection === sock));
  }

  for (const c of svs.clients) {
    if (c.active !== true) continue;
    if (drainMessages(c.netconnection).at(-1) !== -1) continue;
    server.WT_Close(c.netconnection);
    c.active = false;
    c.netconnection = null;
  }

  return slots;
}

Deno.test("a reconnect gets the slot the server freed for the previous connection", async () => {
  const teardown = setupServer({ maxclients: 4, sockets: 10 });
  try {
    const { sock } = await connectClient();
    assertEqual(
      svs.clients.findIndex((c) => c.active),
      0,
      "first connection in slot 0",
    );

    // CL_EstablishConnection: CL_Disconnect closes the old socket, then the
    // new connection starts straight away (cl_parse.js lazy map fetch).
    client.WT_Close(sock);
    let newSock = null;
    const connecting = client.WT_Connect("localhost:4433").then((s) => {
      newSock = s;
    });

    // The room server ticks at sys_ticrate 0.05 (20 Hz).
    const slots = [];
    const deadline = performance.now() + 2000;
    while (
      (newSock === null || slots.length === 0) && performance.now() < deadline
    ) {
      await delay(50);
      slots.push(...roomServerTick());
    }

    await connecting;
    assert(newSock != null, "client reconnected");
    assertEqual(slots.length, 1, "server accepted one new connection");
    assertEqual(slots[0], 0, "reconnect slot");
    assertEqual(
      svs.clients.filter((c) => c.active).length,
      1,
      "active clients",
    );

    client.WT_Close(newSock);
  } finally {
    await teardown();
  }
});
