// MAX_MSGLEN and NET_MAXMESSAGE at QuakeSpasm's 64000 (id: 8000 and 8192),
// on the headless host over the loopback driver: the loopback queue takes a
// full reliable message behind a full queue of datagrams, a serverinfo over
// 8000 bytes (an Arcane Dimensions map's precache lists) signs the client on,
// and a demo message of MAX_MSGLEN bytes plays.

import {
  headless_frame,
  headless_init,
  headless_map,
  headless_wait_signon,
} from "../server/headless_host.js";
import { cls, SIGNONS } from "../src/client.js";
import { sv, svs } from "../src/server.js";
import { SV_SendServerinfo } from "../src/sv_main.js";
import { Cbuf_AddText, Cmd_ExecuteString, src_command } from "../src/cmd.js";
import { COM_AddPack } from "../src/pak.js";
import { Con_SetAgentHook } from "../src/console.js";
import { MAX_MSGLEN, MAX_SOUNDS } from "../src/quakedef.js";
import { NET_MAXMESSAGE, net_message } from "../src/net.js";
import {
  Loop_GetMessage,
  LOOP_QUEUE_BYTES,
  Loop_SendMessage,
  Loop_SendUnreliableMessage,
} from "../src/net_loop.js";
import { svc_disconnect, svc_nop, svc_print } from "../src/protocol.js";
import { GD_MAPS } from "../server/game_data.js";

function assert(cond, message) {
  if (cond !== true) {
    throw new Error(message);
  }
}

// Host_Init runs once per process, so the tests share this host and run in
// order
await headless_init();
await headless_map(GD_MAPS.level);

function message(n, fill) {
  return { data: new Uint8Array(n).fill(fill), cursize: n };
}

Deno.test("loopback: a MAX_MSGLEN reliable message fits behind a full queue of datagrams", () => {
  assert(MAX_MSGLEN === 64000, "MAX_MSGLEN " + MAX_MSGLEN);
  assert(NET_MAXMESSAGE === 64000, "NET_MAXMESSAGE " + NET_MAXMESSAGE);
  const serverSock = svs.clients[0].netconnection;
  const clientSock = cls.netcon;
  assert(clientSock.receiveMessage.length >= LOOP_QUEUE_BYTES, "queue size");
  assert(clientSock.receiveMessageLength === 0, "queue starts empty");

  // Datagrams stop at NET_MAXMESSAGE, as in C
  let datagrams = 0;
  while (Loop_SendUnreliableMessage(serverSock, message(4096, 2)) === 1) {
    datagrams++;
  }
  assert(datagrams === 15, datagrams + " datagrams queued");

  // C would Sys_Error here (Loop_SendMessage: overflow)
  assert(
    Loop_SendMessage(serverSock, message(MAX_MSGLEN, 1)) === 1,
    "reliable send",
  );

  for (let i = 0; i < datagrams; i++) {
    assert(Loop_GetMessage(clientSock) === 2, "datagram " + i);
    assert(net_message.cursize === 4096, "datagram size");
  }
  assert(Loop_GetMessage(clientSock) === 1, "then the reliable message");
  assert(net_message.cursize === MAX_MSGLEN, "reliable size");
  assert(
    net_message.data[0] === 1 && net_message.data[MAX_MSGLEN - 1] === 1,
    "reliable payload",
  );
  assert(Loop_GetMessage(clientSock) === 0, "queue empty");
  assert(serverSock.canSend === true, "server can send again");
});

Deno.test("a serverinfo over 8000 bytes signs a loopback client on", async () => {
  let first = 1;
  while (sv.sound_precache[first] !== null) first++;
  // Sound names as long as an Arcane Dimensions one; the files needn't exist
  let bytes = 0;
  let last = first;
  for (; bytes < 9000 && last < MAX_SOUNDS; last++) {
    const name = "maxmsglen/" + "x".repeat(40) + last + ".wav";
    sv.sound_precache[last] = name;
    bytes += name.length + 1;
  }

  const client = svs.clients[0];
  try {
    // As a changelevel does: the client drops its signon (the server's
    // "reconnect"), then gets the new serverinfo
    Cmd_ExecuteString("reconnect", src_command);
    SV_SendServerinfo(client);
    assert(
      client.message.overflowed === false,
      "client.message overflowed (SZ_GetSpace)",
    );
    assert(
      client.message.cursize > 9000,
      "serverinfo is " + client.message.cursize + " bytes",
    );

    await headless_wait_signon();
    assert(cls.signon === SIGNONS, "cls.signon " + cls.signon);
    assert(client.active === true && client.spawned === true, "client kept");
    for (let i = 0; i < 10; i++) headless_frame();
    assert(client.active === true, "client still connected");
  } finally {
    for (let i = first; i < last; i++) sv.sound_precache[i] = null;
  }
});

// A demo file: the cd track line, then [length][angles][message] records
function demoFile(messages) {
  let size = 3;
  for (const m of messages) size += 16 + m.length;
  const data = new Uint8Array(size);
  data.set([0x2d, 0x31, 0x0a], 0); // "-1\n"
  const view = new DataView(data.buffer);
  let pos = 3;
  for (const m of messages) {
    view.setInt32(pos, m.length, true);
    data.set(m, pos + 16);
    pos += 16 + m.length;
  }
  return data;
}

Deno.test("a demo message of 64000 bytes (QuakeSpasm's MAX_MSGLEN) plays", async () => {
  const size = 64000;
  const marker = "maxmsglen demo marker\n";
  const big = new Uint8Array(size).fill(svc_nop);
  const tail = size - marker.length - 2;
  big[tail] = svc_print;
  for (let i = 0; i < marker.length; i++) {
    big[tail + 1 + i] = marker.charCodeAt(i);
  }
  big[size - 1] = 0;
  const demo = demoFile([big, new Uint8Array([svc_disconnect])]);
  COM_AddPack({
    filename: "maxmsglen.pak",
    files: [{ name: "maxmsglen.dem", filepos: 0, filelen: demo.length }],
    data: demo.buffer,
  });

  const lines = [];
  Con_SetAgentHook((text) => lines.push(text));
  try {
    Cbuf_AddText("playdemo maxmsglen\n");
    for (let i = 0; i < 20 && lines.join("").includes(marker) === false; i++) {
      headless_frame();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const text = lines.join("");
    assert(
      text.includes("Demo message > MAX_MSGLEN") === false,
      "demo refused: " + text,
    );
    assert(text.includes(marker), "demo message not parsed: " + text);
  } finally {
    Con_SetAgentHook(null);
  }
});
