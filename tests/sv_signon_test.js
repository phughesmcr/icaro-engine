// Signon buffers (johnfitz/Ironwail): SV_ReserveSignonSpace splits the
// signon into buffers without splitting a message, and SV_SendClientMessages
// sends a prespawning client one buffer per message, then svc_signonnum 2.

import { sizebuf_t, SZ_Write } from "../src/common.js";
import { MAX_MSGLEN } from "../src/quakedef.js";
import * as net from "../src/net.js";
import { svc_signonnum } from "../src/protocol.js";
import {
  client_t,
  host_client,
  PRESPAWN_DONE,
  PRESPAWN_FLUSH,
  PRESPAWN_SIGNONBUFS,
  PRESPAWN_SIGNONMSG,
  set_host_client,
  sv,
  svs,
} from "../src/server.js";
import {
  SIGNON_SIZE,
  SV_CheckMovevars,
  SV_ReserveSignonSpace,
  SV_SendClientMessages,
} from "../src/sv_main.js";
import { PR_InitBuiltins } from "../src/pr_cmds.js";
import { OFS_PARM0, OFS_PARM1, OFS_PARM2, OFS_PARM3 } from "../src/pr_comp.js";
import {
  pr_builtins,
  pr_global_struct,
  pr_globals_float,
  pr_globals_int,
  pr_numbuiltins,
  PR_SetBuiltins,
  PR_SetGlobalsFloat,
  PR_SetGlobalsInt,
  PR_SetGlobalStruct,
  PR_SetStringsData,
  PR_SetSV,
  pr_strings_data,
  sv as progs_sv,
} from "../src/progs.js";

function assert(cond, message) {
  if (!cond) {
    throw new Error(message);
  }
}

function makeBuffer(size) {
  const sb = new sizebuf_t();
  sb.data = new Uint8Array(size);
  sb.maxsize = size;
  return sb;
}

function filler(n, value) {
  return new Uint8Array(n).fill(value);
}

// Swap in a fresh signon (one empty buffer, as SV_SpawnServer leaves it)
// and restore the real one afterwards
function withSignon(fn) {
  const saved = {
    signon: sv.signon,
    buffers: sv.signon_buffers,
    num: sv.num_signon_buffers,
  };
  try {
    const first = makeBuffer(SIGNON_SIZE);
    sv.signon = first;
    sv.signon_buffers = [first];
    sv.num_signon_buffers = 1;
    fn();
  } finally {
    sv.signon = saved.signon;
    sv.signon_buffers = saved.buffers;
    sv.num_signon_buffers = saved.num;
  }
}

Deno.test("SV_ReserveSignonSpace starts a new buffer rather than split a message", () => {
  withSignon(() => {
    const RECORD = 35;
    const perBuffer = Math.floor(SIGNON_SIZE / RECORD);
    const records = perBuffer * 2 + 10;
    for (let i = 0; i < records; i++) {
      SV_ReserveSignonSpace(RECORD);
      SZ_Write(sv.signon, filler(RECORD, i & 0xff), RECORD);
    }

    assert(
      sv.num_signon_buffers === 3,
      `expected 3 buffers, got ${sv.num_signon_buffers}`,
    );
    assert(
      sv.signon === sv.signon_buffers[2],
      "sv.signon is not the last buffer",
    );
    let total = 0;
    for (let i = 0; i < sv.num_signon_buffers; i++) {
      const sb = sv.signon_buffers[i];
      assert(
        sb.cursize % RECORD === 0,
        `buffer ${i} splits a record (${sb.cursize} bytes)`,
      );
      assert(
        sb.cursize <= sb.maxsize && sb.maxsize === SIGNON_SIZE,
        `buffer ${i} size`,
      );
      total += sb.cursize;
    }
    assert(total === records * RECORD, `lost bytes: ${total}`);
    assert(
      SIGNON_SIZE + 2 < MAX_MSGLEN,
      "a buffer and svc_signonnum must fit in one client message",
    );
  });
});

// SV_SendClientMessages over a fake net driver
const FAKE_DRIVER = net.MAX_NET_DRIVERS - 1;

function withClient(fn) {
  const savedDriver = net.net_drivers[FAKE_DRIVER];
  const savedMaxclients = svs.maxclients;
  const savedClients = svs.clients;
  const savedHostClient = host_client;
  const rd = sv.reliable_datagram;
  const savedRd = { data: rd.data, maxsize: rd.maxsize, cursize: rd.cursize };
  const savedEdicts = sv.edicts;

  const sent = [];
  net.net_drivers[FAKE_DRIVER] = {
    initialized: true,
    CanSendMessage() {
      return true;
    },
    QSendMessage(_sock, data) {
      sent.push(data.data.slice(0, data.cursize));
      return 1;
    },
  };

  const client = new client_t();
  client.message.data = client.msgbuf;
  client.message.maxsize = MAX_MSGLEN;
  client.active = true;
  client.spawned = false;
  client.netconnection = { driver: FAKE_DRIVER, disconnected: false };

  try {
    svs.maxclients = 1;
    svs.clients = [client];
    sv.edicts = null; // nothing for SV_CleanupEnts to do
    rd.data = new Uint8Array(1024);
    rd.maxsize = 1024;
    rd.cursize = 0;
    SV_CheckMovevars(); // sync the movevars snapshot so no _movevars is queued
    rd.cursize = 0;

    withSignon(() => fn(client, sent));
  } finally {
    net.net_drivers[FAKE_DRIVER] = savedDriver;
    svs.maxclients = savedMaxclients;
    svs.clients = savedClients;
    set_host_client(savedHostClient);
    rd.data = savedRd.data;
    rd.maxsize = savedRd.maxsize;
    rd.cursize = savedRd.cursize;
    sv.edicts = savedEdicts;
  }
}

// Fill the signon with buffers of the given sizes, each byte set to its
// buffer's index + 10 so the sent messages can be told apart
function fillSignon(sizes) {
  for (let i = 0; i < sizes.length; i++) {
    if (i > 0) {
      SV_ReserveSignonSpace(SIGNON_SIZE); // force a new buffer
    }
    SZ_Write(sv.signon, filler(sizes[i], i + 10), sizes[i]);
  }
  assert(
    sv.num_signon_buffers === sizes.length,
    `set up ${sv.num_signon_buffers} buffers`,
  );
}

function isBuffer(msg, index, size) {
  if (msg.length < size) {
    return false;
  }
  for (let i = 0; i < size; i++) {
    if (msg[i] !== index + 10) {
      return false;
    }
  }
  return true;
}

Deno.test("a prespawning client gets one signon buffer per message, then svc_signonnum 2", () => {
  withClient((client, sent) => {
    fillSignon([3000, 3000, 500]);
    client.sendsignon = PRESPAWN_SIGNONBUFS;
    client.signonidx = 0;

    SV_SendClientMessages();
    assert(
      sent.length === 1 && sent[0].length === 3000 &&
        isBuffer(sent[0], 0, 3000),
      "frame 1: buffer 0",
    );

    SV_SendClientMessages();
    assert(
      sent.length === 2 && sent[1].length === 3000 &&
        isBuffer(sent[1], 1, 3000),
      "frame 2: buffer 1",
    );

    SV_SendClientMessages();
    const last = sent[2];
    assert(
      sent.length === 3 && last.length === 502 && isBuffer(last, 2, 500),
      "frame 3: buffer 2",
    );
    assert(
      last[500] === svc_signonnum && last[501] === 2,
      "frame 3: svc_signonnum 2 after the last buffer",
    );
    assert(
      client.sendsignon === PRESPAWN_DONE,
      `sendsignon ${client.sendsignon} after the flush`,
    );

    // done: queued data waits for the next signon stage
    SZ_Write(client.message, filler(4, 1), 4);
    SV_SendClientMessages();
    assert(sent.length === 3, "sent a non-signon message before spawn");
  });
});

Deno.test("svc_signonnum 2 waits for the next message when only the last buffer fits", () => {
  withClient((client, sent) => {
    fillSignon([SIGNON_SIZE]);
    client.sendsignon = PRESPAWN_SIGNONBUFS;
    client.signonidx = 0;
    // the buffer fits exactly, the 2 bytes of svc_signonnum don't
    const pending = MAX_MSGLEN - SIGNON_SIZE - 1;
    SZ_Write(client.message, filler(pending, 1), pending);

    SV_SendClientMessages();
    assert(
      sent.length === 1 && sent[0].length === pending + SIGNON_SIZE,
      "frame 1: pending data and the buffer",
    );
    assert(
      client.sendsignon === PRESPAWN_SIGNONMSG,
      `frame 1: sendsignon ${client.sendsignon}`,
    );

    SV_SendClientMessages();
    assert(
      sent.length === 2 && sent[1].length === 2,
      "frame 2: svc_signonnum alone",
    );
    assert(
      sent[1][0] === svc_signonnum && sent[1][1] === 2,
      "frame 2: svc_signonnum 2",
    );
    assert(client.sendsignon === PRESPAWN_DONE, "signon finished");
  });
});

Deno.test("pending reliable data is sent first when a signon buffer does not fit with it", () => {
  withClient((client, sent) => {
    fillSignon([SIGNON_SIZE]);
    client.sendsignon = PRESPAWN_SIGNONBUFS;
    client.signonidx = 0;
    SZ_Write(client.message, filler(MAX_MSGLEN - 100, 1), MAX_MSGLEN - 100);

    SV_SendClientMessages();
    assert(
      sent.length === 1 && sent[0].length === MAX_MSGLEN - 100,
      "frame 1: only the pending data",
    );
    assert(
      client.signonidx === 0 && client.sendsignon === PRESPAWN_SIGNONBUFS,
      "frame 1: buffer still queued",
    );

    SV_SendClientMessages();
    assert(
      sent.length === 2 && isBuffer(sent[1], 0, SIGNON_SIZE),
      "frame 2: the buffer",
    );
    assert(
      sent[1][SIGNON_SIZE] === svc_signonnum && sent[1][SIGNON_SIZE + 1] === 2,
      "frame 2: svc_signonnum 2",
    );
    assert(client.sendsignon === PRESPAWN_DONE, "signon finished");
  });
});

Deno.test("PRESPAWN_FLUSH (SV_SendServerinfo, Host_Spawn_f) flushes once", () => {
  withClient((client, sent) => {
    client.sendsignon = PRESPAWN_FLUSH;
    SZ_Write(client.message, filler(10, 1), 10);
    SV_SendClientMessages();
    assert(sent.length === 1, "message not sent");
    assert(
      client.sendsignon === PRESPAWN_DONE,
      `sendsignon ${client.sendsignon}`,
    );

    SZ_Write(client.message, filler(10, 1), 10);
    SV_SendClientMessages();
    assert(sent.length === 1, "sent again before the next signon stage");
  });
});

// PF_ambientsound reserves its room in the signon. Its PROTOCOL_ICARO
// record (int32 coords, short sound index) is 17 bytes, Ironwail's
// reservation; a buffer with 16 bytes free moves it to a new buffer.
const PF_AMBIENTSOUND = 74;

Deno.test("PF_ambientsound reserves signon space before writing", () => {
  const oldBuiltins = pr_builtins;
  const oldNumBuiltins = pr_numbuiltins;
  const oldGlobalStruct = pr_global_struct;
  const oldGlobalsFloat = pr_globals_float;
  const oldGlobalsInt = pr_globals_int;
  const oldStrings = pr_strings_data;
  const oldProgsSV = progs_sv;
  const oldPrecache = sv.sound_precache;

  try {
    const buffer = new ArrayBuffer(64 * 4);
    PR_SetGlobalStruct({});
    PR_SetGlobalsFloat(new Float32Array(buffer));
    PR_SetGlobalsInt(new Int32Array(buffer));
    PR_InitBuiltins();
    PR_SetSV(sv);
    PR_SetStringsData(new TextEncoder().encode("\0ambience/wind2.wav\0"));
    sv.sound_precache = ["", "ambience/wind2.wav"];

    withSignon(() => {
      SZ_Write(sv.signon, filler(SIGNON_SIZE - 16, 1), SIGNON_SIZE - 16);
      pr_globals_float.set([64, 128, 32], OFS_PARM0);
      pr_globals_int[OFS_PARM1] = 1;
      pr_globals_float[OFS_PARM2] = 1;
      pr_globals_float[OFS_PARM3] = 3;
      pr_builtins[PF_AMBIENTSOUND]();

      assert(
        sv.num_signon_buffers === 2,
        `expected a new buffer, got ${sv.num_signon_buffers}`,
      );
      assert(
        sv.signon_buffers[0].cursize === SIGNON_SIZE - 16,
        "the full buffer was written to",
      );
      assert(
        sv.signon_buffers[1].cursize === 17,
        `record size ${sv.signon_buffers[1].cursize}`,
      );
    });
  } finally {
    PR_SetBuiltins(oldBuiltins, oldNumBuiltins);
    PR_SetGlobalStruct(oldGlobalStruct);
    PR_SetGlobalsFloat(oldGlobalsFloat);
    PR_SetGlobalsInt(oldGlobalsInt);
    PR_SetStringsData(oldStrings);
    PR_SetSV(oldProgsSV);
    sv.sound_precache = oldPrecache;
  }
});
