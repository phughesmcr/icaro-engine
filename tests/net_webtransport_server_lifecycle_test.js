// Session lifecycle tests for server/net_webtransport_server.ts, driven
// through in-memory WebTransport pairs (tests/fake_webtransport.js).

const {
  server,
  netMain,
  net,
  svs,
  net_message,
  assert,
  assertEqual,
  rawClient,
  openSession,
  connectRaw,
  svCheckForNewClients,
  setupServer,
  drainMessages,
  message,
  packetAck,
  packetSequence,
} = await import("./webtransport_test_env.js");
const { svc_disconnect, clc_nop, clc_disconnect } = await import(
  "../src/protocol.js"
);
const { writtenBytes, splitFrames, frame, sequencedPacket, delay, waitFor } =
  await import("./fake_webtransport.js");

Deno.test("NET-1: simultaneous connects beyond maxclients are rejected instead of reaching Sys_Error", async () => {
  const teardown = setupServer({ maxclients: 2 });
  try {
    // Three clients arrive in the same server frame.
    const sessions = [openSession(), openSession(), openSession()];
    const clients = await Promise.all(sessions.map((s) => rawClient(s.pair)));
    await Promise.all(sessions.map((s) => s.accepted));
    const replies = await Promise.all(
      clients.map(async (c) =>
        net.WT_ParseHandshakeReply(await c.frames.read())
      ),
    );

    const accepted = replies.filter((r) =>
      r.status === net.WT_HANDSHAKE_ACCEPT
    );
    const rejected = replies.filter((r) =>
      r.status === net.WT_HANDSHAKE_REJECT
    );
    assertEqual(accepted.length, 2, "accepted handshakes");
    assertEqual(rejected.length, 1, "rejected handshakes");
    assertEqual(rejected[0].reason, "Server is full", "reject reason");
    assertEqual(
      server.WT_GetSessionStatsForTest().pending,
      2,
      "pending sockets",
    );

    // The rejected session is closed after its reason is flushed.
    const rejectedClient = clients[replies.indexOf(rejected[0])];
    await waitFor(
      () => rejectedClient.pair.session.isClosed,
      2000,
      "rejected session close",
    );

    assertEqual(
      svCheckForNewClients().length,
      2,
      "clients accepted by the server loop",
    );

    // A fourth client while the server is full is turned away as well.
    const late = await connectRaw();
    assertEqual(
      late.reply.status,
      net.WT_HANDSHAKE_REJECT,
      "late client status",
    );
    assertEqual(late.reply.reason, "Server is full", "late client reason");
    assertEqual(svCheckForNewClients().length, 0, "nothing more to accept");
  } finally {
    await teardown();
  }
});

Deno.test("NET-1: a pending socket waits while every client slot is taken, then times out", async () => {
  const teardown = setupServer({
    maxclients: 1,
    config: { pendingAcceptTimeoutMs: 150 },
  });
  try {
    const client = await connectRaw();
    assertEqual(
      client.reply.status,
      net.WT_HANDSHAKE_ACCEPT,
      "handshake status",
    );

    // The only slot is taken by someone else (for example a loopback client).
    svs.clients[0].active = true;
    assertEqual(
      svCheckForNewClients().length,
      0,
      "no accept while the server is full",
    );
    assertEqual(
      server.WT_GetSessionStatsForTest().pending,
      1,
      "socket stays queued",
    );

    // Never accepted: the driver closes it and returns the socket to the pool.
    await waitFor(
      () => client.pair.session.isClosed,
      2000,
      "pending session close",
    );
    assertEqual(
      server.WT_GetSessionStatsForTest().pending,
      0,
      "pending queue emptied",
    );
    assert(net.net_activeSockets === null, "socket returned to the free list");
  } finally {
    await teardown();
  }
});

Deno.test("NET-2: a session that never completes the handshake is closed after the timeout", async () => {
  const teardown = setupServer({ config: { handshakeTimeoutMs: 100 } });
  try {
    // No stream at all
    const silent = openSession();
    // A stream, but no hello
    const mute = openSession();
    await rawClient(mute.pair, { hello: false });

    const start = performance.now();
    await Promise.all([silent.accepted, mute.accepted]);
    const elapsed = performance.now() - start;
    assert(
      elapsed < 1000,
      "handshake deadline enforced (took " + elapsed + " ms)",
    );

    await waitFor(
      () => silent.pair.session.isClosed && mute.pair.session.isClosed,
      1000,
      "sessions closed",
    );
    await delay(5);
    const stats = server.WT_GetSessionStatsForTest();
    assertEqual(stats.handshaking, 0, "handshaking sessions");
    assertEqual(stats.sessionsByIp, 0, "per-IP session count");
    assertEqual(stats.pending, 0, "no socket allocated");
  } finally {
    await teardown();
  }
});

Deno.test("NET-2: a client without the handshake gets a reason instead of a slot", async () => {
  const teardown = setupServer();
  try {
    const { pair, accepted } = openSession();
    const client = await rawClient(pair, { hello: false });
    // What a pre-handshake client sends first: a sequenced game message.
    await client.writer.write(
      frame(sequencedPacket(0, 0, new Uint8Array([clc_nop]))),
    );
    await accepted;

    const reply = net.WT_ParseHandshakeReply(await client.frames.read());
    assertEqual(reply.status, net.WT_HANDSHAKE_REJECT, "status");
    assert(
      reply.reason.startsWith("Protocol mismatch"),
      "reason: " + reply.reason,
    );
    await waitFor(() => pair.session.isClosed, 2000, "session close");
    assertEqual(
      server.WT_GetSessionStatsForTest().pending,
      0,
      "no socket allocated",
    );
  } finally {
    await teardown();
  }
});

Deno.test("NET-2: sessions are capped per IP and while handshaking", async () => {
  const teardown = setupServer({
    config: {
      maxSessionsPerIp: 2,
      maxHandshakingSessions: 3,
      handshakeTimeoutMs: 200,
    },
  });
  try {
    const a = openSession("192.0.2.1");
    const b = openSession("192.0.2.1");
    const c = openSession("192.0.2.1");
    await c.accepted;
    assert(
      c.pair.session.isClosed,
      "third session from one IP is closed at once",
    );
    assert(
      a.pair.session.isClosed === false && b.pair.session.isClosed === false,
      "first two still open",
    );

    const d = openSession("192.0.2.2");
    const e = openSession("192.0.2.3");
    await e.accepted;
    assert(
      e.pair.session.isClosed,
      "session beyond the handshaking cap is closed at once",
    );
    assert(
      d.pair.session.isClosed === false,
      "third handshaking session still open",
    );

    await Promise.all([a.accepted, b.accepted, d.accepted]);
    await delay(5);
    const stats = server.WT_GetSessionStatsForTest();
    assertEqual(stats.handshaking, 0, "handshaking count after timeouts");
    assertEqual(stats.sessionsByIp, 0, "per-IP count after timeouts");
  } finally {
    await teardown();
  }
});

Deno.test("NET-2: a client that ends its stream cleanly is reported as disconnected", async () => {
  const teardown = setupServer();
  try {
    const client = await connectRaw();
    const [sock] = svCheckForNewClients();
    assertEqual(server.WT_QGetMessage(sock), 0, "connected and idle");

    await client.writer.close();
    await waitFor(
      () => server.WT_QGetMessage(sock) === -1,
      2000,
      "disconnect after FIN",
    );
  } finally {
    await teardown();
  }
});

Deno.test("NET-4: the server flushes its final reliable message before closing", async () => {
  const teardown = setupServer({ config: { closeFlushMs: 1000 } });
  try {
    const client = await connectRaw();
    const [sock] = svCheckForNewClients();

    assertEqual(
      server.WT_QSendMessage(sock, message([svc_disconnect])),
      1,
      "send result",
    );
    server.WT_Close(sock);
    assert(sock.driverdata === null, "socket detached at once");

    const last = await client.frames.read();
    assert(last !== null, "final message delivered");
    // Legacy framing: this raw client never sent a sequenced packet.
    assertEqual(last.length, 1, "final message length");
    assertEqual(last[0], svc_disconnect, "final message payload");
    assertEqual(
      await client.frames.read(),
      null,
      "stream finished (FIN) after the message",
    );
    assert(
      client.pair.session.isClosed === false,
      "transport still open while waiting for the client",
    );

    // The client finishes its side; the server then closes promptly.
    const start = performance.now();
    await client.writer.close();
    await waitFor(() => client.pair.session.isClosed, 2000, "transport close");
    assert(
      performance.now() - start < 500,
      "closed once the client finished, not on the timer",
    );

    // Bounded wait: a client that never finishes is closed by the timer.
    server.WT_SetConfig({ closeFlushMs: 100 });
    const stuck = await connectRaw();
    const [stuckSock] = svCheckForNewClients();
    server.WT_Close(stuckSock);
    await waitFor(() => stuck.pair.session.isClosed, 1000, "bounded close");
  } finally {
    await teardown();
  }
});

Deno.test("NET-5: a stale transport close does not touch a reused socket", async () => {
  const teardown = setupServer({ config: { closeFlushMs: 200 } });
  try {
    const first = await connectRaw();
    const [sockA] = svCheckForNewClients();

    // SV_DropClient -> NET_Close: driver close, then the socket goes back to the pool.
    server.WT_Close(sockA);
    netMain.NET_FreeQSocket(sockA);
    svs.clients[0].active = false;
    net.set_net_activeconnections(net.net_activeconnections - 1);

    const second = await connectRaw();
    const [sockB] = svCheckForNewClients();
    assert(
      sockB === sockA,
      "pool handed the same socket object to the new connection",
    );
    const connB = sockB.driverdata;

    // The old transport now closes (peer and timer); the new owner is untouched.
    first.pair.client.close();
    await delay(300);
    assert(
      sockB.driverdata === connB,
      "socket still owned by the new connection",
    );
    assertEqual(server.WT_QGetMessage(sockB), 0, "new connection still alive");
    assert(second.pair.session.isClosed === false, "new transport still open");
  } finally {
    await teardown();
  }
});

Deno.test("NET-5: a closing transport leaves a socket that now belongs to another connection", async () => {
  const teardown = setupServer();
  try {
    // A pending socket whose connection still points at it, while the
    // socket itself has been handed to someone else.
    const client = await connectRaw();
    assertEqual(server.WT_GetSessionStatsForTest().pending, 1, "socket queued");
    const sock = net.net_activeSockets;
    const connA = sock.driverdata;
    const other = { connected: true, pendingMessages: [] };
    sock.driverdata = other;

    client.pair.client.close();
    await waitFor(
      () => server.WT_GetSessionStatsForTest().live === 0,
      1000,
      "old connection closed",
    );

    assert(
      sock.driverdata === other,
      "socket still owned by the other connection",
    );
    assertEqual(
      server.WT_GetSessionStatsForTest().pending,
      1,
      "socket not freed from the queue",
    );
    assert(
      net.net_activeSockets === sock && sock.disconnected === false,
      "socket not returned to the pool",
    );

    // Hand it back so teardown can free it normally.
    sock.driverdata = connA;
  } finally {
    await teardown();
  }
});

Deno.test("NET-5: oversized reliable frames drop the client explicitly", async () => {
  const teardown = setupServer();
  try {
    const client = await connectRaw();
    const [sock] = svCheckForNewClients();

    const header = new Uint8Array([0xff, 0xff, 1, 2, 3]);
    await client.writer.write(header);
    await waitFor(
      () => server.WT_QGetMessage(sock) === -1,
      2000,
      "disconnect on oversized frame",
    );
  } finally {
    await teardown();
  }
});

Deno.test("NET-5: a slow server loop pauses the reader instead of dropping the client", async () => {
  const teardown = setupServer();
  try {
    const client = await connectRaw();
    const [sock] = svCheckForNewClients();
    const conn = sock.driverdata;

    const total = 300;
    const parts = [];
    for (let i = 0; i < total; i++) {
      parts.push(
        frame(sequencedPacket(i, 0, new Uint8Array([clc_nop, i & 0xff]))),
      );
    }
    let size = 0;
    for (const p of parts) size += p.length;
    const burst = new Uint8Array(size);
    let offset = 0;
    for (const p of parts) {
      burst.set(p, offset);
      offset += p.length;
    }

    await client.writer.write(burst);
    await waitFor(
      () => conn.pendingMessages.length >= 256,
      5000,
      "queue to fill",
    );
    await delay(30);
    assertEqual(conn.pendingMessages.length, 256, "reader paused at the cap");
    assert(conn.connected === true, "client still connected");

    // Many datagrams while paused collapse into the newest one.
    const dgWriter = client.pair.client.datagrams.writable.getWriter();
    for (let i = 0; i < 50; i++) {
      await dgWriter.write(
        sequencedPacket(1000 + i, 0, new Uint8Array([0x10, i])),
      );
    }
    await waitFor(
      () => conn.pendingMessages.length === 257,
      2000,
      "datagram queued",
    );
    await delay(30);
    assertEqual(
      conn.pendingMessages.length,
      257,
      "consecutive datagrams coalesced",
    );

    const reliable = [];
    let datagram = null;
    const deadline = performance.now() + 5000;
    while (reliable.length < total && performance.now() < deadline) {
      const ret = server.WT_QGetMessage(sock);
      if (ret === 1) reliable.push(net_message.data[1]);
      else if (ret === 2) datagram = net_message.data[1];
      else if (ret === 0) await delay(2);
      else throw new Error("connection dropped while draining");
    }

    assertEqual(reliable.length, total, "every reliable message delivered");
    for (let i = 0; i < total; i++) {
      assertEqual(reliable[i], i & 0xff, "reliable order at " + i);
    }
    assertEqual(datagram, 49, "newest datagram delivered");
  } finally {
    await teardown();
  }
});

Deno.test("NET-5: a stalled datagram path only affects its own connection", async () => {
  const teardown = setupServer();
  try {
    const a = await connectRaw();
    const b = await connectRaw();
    const [sockA, sockB] = svCheckForNewClients();
    const pairFor = (
      sock,
    ) => (sock.driverdata.webTransport === a.pair.server ? a.pair : b.pair);
    const pairA = pairFor(sockA);
    const pairB = pairFor(sockB);

    pairA.datagramsToClient.setStalled(true);

    for (let i = 0; i < 3; i++) {
      assertEqual(
        server.WT_SendUnreliableMessage(sockA, message([0x20, i])),
        1,
        "send A",
      );
      assertEqual(
        server.WT_SendUnreliableMessage(sockB, message([0x20, i])),
        1,
        "send B",
      );
      await delay(5);
    }

    assertEqual(
      pairB.datagramsToClient.written.length,
      3,
      "B datagrams written",
    );
    assertEqual(
      pairA.datagramsToClient.written.length,
      0,
      "A datagrams held by the stall",
    );
    assertEqual(
      server.WT_CanSendUnreliableMessage(sockA),
      false,
      "A reports backpressure",
    );
    assertEqual(
      server.WT_CanSendUnreliableMessage(sockB),
      true,
      "B can still send",
    );

    pairA.datagramsToClient.setStalled(false);
    await waitFor(
      () => pairA.datagramsToClient.written.length === 2,
      1000,
      "A resumes",
    );
    const newest = pairA.datagramsToClient.written[1];
    assertEqual(
      newest[newest.length - 1],
      2,
      "A sends the newest queued update",
    );
  } finally {
    await teardown();
  }
});

Deno.test("the session's maxDatagramSize reaches the engine as sock.maxdatagram and follows path MTU changes", async () => {
  const teardown = setupServer();
  try {
    const { pair, accepted } = openSession(null, { maxDatagramSize: 1159 });
    const client = await rawClient(pair);
    await accepted;
    assertEqual(
      net.WT_ParseHandshakeReply(await client.frames.read()).status,
      net.WT_HANDSHAKE_ACCEPT,
      "handshake",
    );
    const [sock] = svCheckForNewClients();
    assertEqual(
      sock.maxdatagram,
      1159 - net.WT_PACKET_HEADER_BYTES,
      "limit at accept",
    );

    // Deno's value is live: path MTU discovery raises it after the handshake
    pair.server.datagrams.maxDatagramSize = 1413;
    assertEqual(server.WT_CanSendUnreliableMessage(sock), true, "can send");
    assertEqual(
      sock.maxdatagram,
      1413 - net.WT_PACKET_HEADER_BYTES,
      "limit after the probe",
    );

    // an unreadable value keeps the last one
    pair.server.datagrams.maxDatagramSize = undefined;
    server.WT_CanSendUnreliableMessage(sock);
    assertEqual(
      sock.maxdatagram,
      1413 - net.WT_PACKET_HEADER_BYTES,
      "limit kept",
    );
  } finally {
    await teardown();
  }
});

Deno.test("a message of sock.maxdatagram bytes goes as a datagram; one byte more falls back to the reliable stream", async () => {
  const teardown = setupServer();
  try {
    const { pair, accepted } = openSession(null, { maxDatagramSize: 1159 });
    const client = await rawClient(pair);
    await accepted;
    await client.frames.read(); // handshake reply
    const [sock] = svCheckForNewClients();
    const limit = sock.maxdatagram;

    // a sequenced client gets sequenced packets (9-byte header)
    await client.writer.write(
      frame(sequencedPacket(0, 0, new Uint8Array([clc_nop]))),
    );
    await waitFor(
      () => sock.driverdata.pendingMessages.length >= 1,
      1000,
      "client packet",
    );
    drainMessages(sock);

    assertEqual(
      server.WT_SendUnreliableMessage(
        sock,
        message(new Array(limit).fill(0x01)),
      ),
      1,
      "send at the limit",
    );
    await waitFor(
      () => pair.datagramsToClient.written.length === 1,
      1000,
      "datagram at the limit",
    );
    assertEqual(
      pair.datagramsToClient.written[0].length,
      1159,
      "datagram fills maxDatagramSize",
    );

    assertEqual(
      server.WT_SendUnreliableMessage(
        sock,
        message(new Array(limit + 1).fill(0x02)),
      ),
      1,
      "send past the limit",
    );
    const reliable = await client.frames.read();
    assertEqual(
      reliable.length,
      net.WT_PACKET_HEADER_BYTES + limit + 1,
      "oversized update on the reliable stream",
    );
    await delay(20);
    assertEqual(pair.datagramsToClient.written.length, 1, "no second datagram");
  } finally {
    await teardown();
  }
});

Deno.test("PRED-2: the server ack covers datagrams as well as the reliable stream", async () => {
  const teardown = setupServer();
  try {
    const client = await connectRaw();
    const [sock] = svCheckForNewClients();
    const pair = client.pair;

    // Client sequence 0 on the reliable stream, 1 and 2 as datagrams (clc_move).
    await client.writer.write(
      frame(sequencedPacket(0, 0, new Uint8Array([clc_nop]))),
    );
    const dgWriter = pair.client.datagrams.writable.getWriter();
    await waitFor(
      () => sock.driverdata.pendingMessages.length >= 1,
      1000,
      "reliable message",
    );
    drainMessages(sock);
    await dgWriter.write(sequencedPacket(1, 0, new Uint8Array([0x03])));
    await waitFor(
      () => sock.driverdata.pendingMessages.length >= 1,
      1000,
      "datagram 1",
    );
    drainMessages(sock);
    await dgWriter.write(sequencedPacket(2, 0, new Uint8Array([0x03])));
    await waitFor(
      () => sock.driverdata.pendingMessages.length >= 1,
      1000,
      "datagram 2",
    );
    drainMessages(sock);
    assertEqual(sock.receiveSequence, 0, "reliable receive sequence");
    assertEqual(sock.unreliableReceiveSequence, 2, "datagram receive sequence");

    server.WT_SendUnreliableMessage(sock, message([0x01]));
    server.WT_QSendMessage(sock, message([0x01]));
    await waitFor(
      () => pair.datagramsToClient.written.length === 1,
      1000,
      "server datagram",
    );

    assertEqual(
      packetAck(pair.datagramsToClient.written[0]),
      2,
      "datagram ack",
    );
    const reliable = await client.frames.read();
    assertEqual(packetAck(reliable), 2, "reliable ack");
    assertEqual(
      packetSequence(reliable),
      1,
      "server send sequence is shared by both lanes",
    );

    // A late, older datagram does not move the ack backwards.
    await dgWriter.write(sequencedPacket(1, 0, new Uint8Array([0x03])));
    await delay(20);
    drainMessages(sock);
    server.WT_QSendMessage(sock, message([0x01]));
    assertEqual(
      packetAck(await client.frames.read()),
      2,
      "ack after a stale datagram",
    );
  } finally {
    await teardown();
  }
});

Deno.test("NET-4: clc_disconnect from the client reaches the server before the transport closes", async () => {
  const teardown = setupServer();
  try {
    const client = await connectRaw();
    const [sock] = svCheckForNewClients();

    // What the browser does on page hide: one framed, sequenced clc_disconnect.
    await client.writer.write(
      frame(sequencedPacket(0, 0, new Uint8Array([clc_disconnect]))),
    );
    await client.writer.close();

    await waitFor(
      () => sock.driverdata.pendingMessages.length >= 1,
      1000,
      "clc_disconnect",
    );
    const results = drainMessages(sock);
    assertEqual(results[0].ret, 1, "reliable message");
    assertEqual(results[0].payload[0], clc_disconnect, "payload");
    await waitFor(
      () => server.WT_QGetMessage(sock) === -1,
      1000,
      "disconnect after FIN",
    );

    // The written bytes are exactly one well-formed frame.
    const frames = splitFrames(writtenBytes(client.pair.streams[0].c2s));
    assertEqual(frames.length, 2, "hello + clc_disconnect");
  } finally {
    await teardown();
  }
});
