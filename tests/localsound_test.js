// localsound (Ironwail, 2021 re-release builtin #80 and ex_localsound): the
// server sends svc_localsound to one client, which plays the sound locally.

await import("../src/gl_rsurf.js");
const common = await import("../src/common.js");
const net = await import("../src/net.js");
const { PR_InitBuiltins } = await import("../src/pr_cmds.js");
const { OFS_PARM0, OFS_PARM1 } = await import("../src/pr_comp.js");
const progs = await import("../src/progs.js");
const server = await import("../src/server.js");
const { cl } = await import("../src/client.js");
const { svc_localsound } = await import("../src/protocol.js");
const { CL_ParseServerMessage } = await import("../src/cl_parse.js");
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

// Calls builtin #80 as QuakeC would: localsound( EDICT_NUM( entnum ), sample ).
// Returns the bytes written to each client's message, joined.
function localsound(entnum, sample, left = null) {
  const saved = {
    builtins: progs.pr_builtins,
    numbuiltins: progs.pr_numbuiltins,
    float: progs.pr_globals_float,
    int: progs.pr_globals_int,
    strings: progs.pr_strings_data,
    progs_sv: progs.sv,
    progs_svs: progs.svs,
    maxclients: server.svs.maxclients,
    clients: server.svs.clients,
    precache: server.sv.sound_precache,
  };

  try {
    const buffer = new ArrayBuffer(64 * 4);
    progs.PR_SetGlobalsFloat(new Float32Array(buffer));
    progs.PR_SetGlobalsInt(new Int32Array(buffer));
    progs.PR_SetStringsData(new TextEncoder().encode("\0" + sample + "\0"));
    PR_InitBuiltins();

    const edicts = [];
    for (let i = 0; i < 4; i++) {
      edicts.push({ index: i });
    }
    progs.PR_SetSV({ edicts, num_edicts: 4 });
    progs.PR_SetSVS(server.svs);

    server.svs.maxclients = 2;
    server.svs.clients = [new server.client_t(), new server.client_t()];
    for (const client of server.svs.clients) {
      common.SZ_Alloc(client.message, 16);
      if (left !== null) {
        client.message.cursize = client.message.maxsize - left;
      }
    }

    server.sv.sound_precache = new Array(256).fill(null);
    server.sv.sound_precache[1] = "misc/talk.wav";
    server.sv.sound_precache[2] = "items/r_item1.wav";

    progs.pr_globals_int[OFS_PARM0] = entnum;
    progs.pr_globals_int[OFS_PARM1] = 1;
    printed.length = 0;
    const start = server.svs.clients.map((c) => c.message.cursize);
    progs.pr_builtins[80]();

    return server.svs.clients.map((c, i) =>
      Array.from(c.message.data.subarray(start[i], c.message.cursize)).join(",")
    ).join(" | ");
  } finally {
    progs.PR_SetBuiltins(saved.builtins, saved.numbuiltins);
    progs.PR_SetGlobalsFloat(saved.float);
    progs.PR_SetGlobalsInt(saved.int);
    progs.PR_SetStringsData(saved.strings);
    progs.PR_SetSV(saved.progs_sv);
    progs.PR_SetSVS(saved.progs_svs);
    server.svs.maxclients = saved.maxclients;
    server.svs.clients = saved.clients;
    server.sv.sound_precache = saved.precache;
  }
}

Deno.test("localsound writes svc_localsound to that client only", () => {
  assertEqual(
    localsound(2, "items/r_item1.wav"),
    ` | ${svc_localsound},0,2`,
    "client 2",
  );
  assertEqual(
    localsound(1, "misc/talk.wav"),
    `${svc_localsound},0,1 | `,
    "client 1",
  );
  assertEqual(printed.length, 0, "nothing printed");
});

Deno.test("localsound to a non-client or an unprecached sound sends nothing", () => {
  assertEqual(localsound(0, "misc/talk.wav"), " | ", "world");
  assertEqual(
    printed.join(""),
    "tried to localsound to a non-client\n",
    "world message",
  );
  assertEqual(localsound(3, "misc/talk.wav"), " | ", "past maxclients");
  assertEqual(
    printed.join(""),
    "tried to localsound to a non-client\n",
    "past maxclients message",
  );
  assertEqual(localsound(1, "misc/none.wav"), " | ", "not precached");
  assertEqual(
    printed.join(""),
    "SV_LocalSound: misc/none.wav not precached\n",
    "not precached message",
  );
});

Deno.test("localsound is dropped when the client message is nearly full", () => {
  // Ironwail's check: cursize > maxsize - 4
  assertEqual(
    localsound(1, "misc/talk.wav", 4),
    `${svc_localsound},0,1 | `,
    "sent with 4 bytes left",
  );
  assertEqual(
    localsound(1, "misc/talk.wav", 3),
    " | ",
    "dropped with 3 bytes left",
  );
});

Deno.test("the client parses svc_localsound and goes on to the next message", () => {
  const saved = {
    data: net.net_message.data,
    maxsize: net.net_message.maxsize,
    cursize: net.net_message.cursize,
  };
  const savedCommon = common.net_message;
  const savedPrecache = cl.sound_precache[2];
  try {
    common.COM_SetNetMessage(net.net_message);
    net.net_message.data = new Uint8Array(64);
    net.net_message.maxsize = 64;

    // a precached sound: S_LocalSound returns at once, as sound isn't started
    cl.sound_precache[2] = { name: "items/r_item1.wav" };
    common.SZ_Clear(net.net_message);
    common.MSG_WriteByte(net.net_message, svc_localsound);
    common.MSG_WriteByte(net.net_message, 0);
    common.MSG_WriteByte(net.net_message, 2);
    common.MSG_WriteByte(net.net_message, svc_localsound);
    common.MSG_WriteByte(net.net_message, 0);
    common.MSG_WriteByte(net.net_message, 3);
    printed.length = 0;
    CL_ParseServerMessage();
    assertEqual(common.msg_readcount, 6, "read both messages");
    assertEqual(
      printed.join(""),
      "CL_ParseLocalSound: sound_num 3 not precached\n",
      "second sound missing",
    );
  } finally {
    cl.sound_precache[2] = savedPrecache;
    net.net_message.data = saved.data;
    net.net_message.maxsize = saved.maxsize;
    net.net_message.cursize = saved.cursize;
    common.COM_SetNetMessage(savedCommon);
  }
});
