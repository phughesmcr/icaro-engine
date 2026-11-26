// Client fixes from the Ironwail review: bad server data drops to the console
// (Host_Error) instead of Sys_Error, no tint in sky, temp-entity beams don't
// allocate or flicker while paused, and the intermission screen is centred.
// The stufftext line-buffering tests are in stufftext_trust_test.js, which
// has a real local server.

// Bootstrap the client renderer graph in its established safe import order.
await import("../src/gl_rsurf.js");

const {
  CL_EntityNum,
  CL_ParseServerMessage,
} = await import("../src/cl_parse.js");
const { CL_TEntSRand, CL_TEntRand, CL_UpdateTEnts } = await import(
  "../src/cl_tent.js"
);
const { V_SetContentsColor } = await import("../src/view.js");
const sbar = await import("../src/sbar.js");
const { Draw_GetVirtualWidth, Draw_GetVirtualHeight } = await import(
  "../src/gl_draw.js"
);
const client = await import("../src/client.js");
const { cl, cls, CSHIFT_CONTENTS } = client;
const net = await import("../src/net.js");
const common = await import("../src/common.js");
const { SZ_Clear, MSG_WriteByte, MSG_WriteString, COM_SetNetMessage } = common;
const {
  svc_lightstyle,
  svc_updatestat,
  svc_serverinfo,
  PROTOCOL_VERSION,
} = await import("../src/protocol.js");
const { MSG_WriteLong } = common;
const { CONTENTS_SKY, CONTENTS_WATER, CONTENTS_EMPTY } = await import(
  "../src/bspfile.js"
);

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

function expectHostError(fn, prefix) {
  let thrown = null;
  try {
    fn();
  } catch (e) {
    thrown = e;
  }

  assertEqual(
    thrown !== null && thrown.message.startsWith("Host_Error: " + prefix),
    true,
    "Host_Error " + prefix + " (got " +
      (thrown === null ? "nothing" : thrown.message) + ")",
  );
}

// Runs fn with net_message holding the bytes write() puts there.
function withServerMessage(write, fn) {
  const saved = {
    data: net.net_message.data,
    maxsize: net.net_message.maxsize,
    cursize: net.net_message.cursize,
  };
  const savedCommon = common.net_message;
  try {
    COM_SetNetMessage(net.net_message); // Host_Init does this
    net.net_message.data = new Uint8Array(1024);
    net.net_message.maxsize = 1024;
    SZ_Clear(net.net_message);
    write(net.net_message);
    fn();
  } finally {
    net.net_message.data = saved.data;
    net.net_message.maxsize = saved.maxsize;
    net.net_message.cursize = saved.cursize;
    COM_SetNetMessage(savedCommon);
  }
}

Deno.test("CL_EntityNum rejects a negative entity number", () => {
  expectHostError(
    () => CL_EntityNum(-1),
    "CL_EntityNum: -1 is an invalid number",
  );
});

Deno.test("bad svc_lightstyle and svc_updatestat indexes are Host_Errors", () => {
  const savedState = cls.state;
  try {
    withServerMessage(
      (m) => {
        MSG_WriteByte(m, svc_lightstyle);
        MSG_WriteByte(m, 255);
        MSG_WriteString(m, "m");
      },
      () =>
        expectHostError(
          () => CL_ParseServerMessage(),
          "svc_lightstyle > MAX_LIGHTSTYLES",
        ),
    );

    withServerMessage(
      (m) => {
        MSG_WriteByte(m, svc_updatestat);
        MSG_WriteByte(m, 255);
      },
      () =>
        expectHostError(
          () => CL_ParseServerMessage(),
          "svc_updatestat: 255 is invalid",
        ),
    );
  } finally {
    cls.state = savedState;
  }
});

Deno.test("a bad serverinfo is a Host_Error, not a half-connected client", () => {
  const savedState = cls.state;
  try {
    withServerMessage(
      (m) => {
        MSG_WriteByte(m, svc_serverinfo);
        MSG_WriteLong(m, PROTOCOL_VERSION);
        MSG_WriteByte(m, 0); // maxclients
      },
      () =>
        expectHostError(
          () => CL_ParseServerMessage(),
          "Bad maxclients (0) from server",
        ),
    );
  } finally {
    cls.state = savedState;
  }
});

Deno.test("sky contents give no colour shift", () => {
  const shift = cl.cshifts[CSHIFT_CONTENTS];
  V_SetContentsColor(CONTENTS_WATER);
  assertEqual(shift.percent > 0, true, "water tints");
  V_SetContentsColor(CONTENTS_SKY);
  assertEqual(shift.percent, 0, "sky does not");
  V_SetContentsColor(CONTENTS_EMPTY);
});

Deno.test("beam roll is fixed for a given cl.time", () => {
  CL_TEntSRand(1234);
  const a = [CL_TEntRand(), CL_TEntRand(), CL_TEntRand()];
  CL_TEntSRand(1234);
  const b = [CL_TEntRand(), CL_TEntRand(), CL_TEntRand()];
  assertEqual(a.join(","), b.join(","), "same seed, same rolls");
  CL_TEntSRand(1235);
  assertEqual(
    CL_TEntRand() !== a[0],
    true,
    "next millisecond rolls differently",
  );
  for (const r of a) {
    assertEqual(r >= 0 && Number.isInteger(r), true, "non-negative integer");
  }
});

Deno.test("CL_UpdateTEnts rolls a beam the same way while cl.time stands still", () => {
  const b = client.cl_beams[0];
  const saved = {
    model: b.model,
    entity: b.entity,
    endtime: b.endtime,
    time: cl.time,
    viewentity: cl.viewentity,
  };
  try {
    b.model = { name: "progs/bolt.mdl" };
    b.entity = 1;
    cl.viewentity = 2;
    cl.time = 10.5;
    b.endtime = cl.time + 1;
    b.start.set([0, 0, 0]);
    b.end.set([0, 0, 100]);

    const rolls = () => {
      client.set_cl_numvisedicts(0);
      CL_UpdateTEnts();
      return [0, 1, 2, 3].map((i) => client.cl_temp_entities[i].angles[2]).join(
        ",",
      );
    };

    const first = rolls();
    assertEqual(rolls(), first, "same cl.time, same rolls");
    cl.time += 0.05;
    assertEqual(rolls() !== first, true, "time moves on, the bolt flickers");
  } finally {
    b.model = saved.model;
    b.entity = saved.entity;
    b.endtime = saved.endtime;
    cl.time = saved.time;
    cl.viewentity = saved.viewentity;
    client.set_cl_numvisedicts(0);
  }
});

Deno.test("intermission screen is centred and the status bar is hidden", () => {
  const pics = [];
  const record = (x, y, pic) => pics.push({ x, y, name: pic.name });
  const fakeCl = {
    stats: new Int32Array(32),
    items: 0,
    gametype: 0,
    scores: [],
    time: 0,
    faceanimtime: 0,
    maxclients: 1,
    levelname: "",
    item_gettime: new Float32Array(32),
    viewentity: 0,
    intermission: 1,
    completed_time: 75,
  };
  const hadWindow = "window" in globalThis; // gl_draw's virtual size reads it
  if (!hadWindow) globalThis.window = { devicePixelRatio: 1 };
  try {
    sbar.Sbar_SetExternals({
      cl: fakeCl,
      Draw_Pic: record,
      Draw_TransPic: record,
      Draw_Character: () => pics.push({ name: "char" }),
      Draw_Fill: () => pics.push({ name: "fill" }),
      Draw_CachePic: (name) => ({ name, width: 0, height: 0 }),
    });

    sbar.Sbar_IntermissionOverlay();
    const complete = pics.find((p) => p.name === "gfx/complete.lmp");
    assertEqual(
      complete.x,
      ((Draw_GetVirtualWidth() - 320) >> 1) + 64,
      "complete.lmp x",
    );
    assertEqual(
      complete.y,
      ((Draw_GetVirtualHeight() - 200) >> 1) + 24,
      "complete.lmp y",
    );

    pics.length = 0;
    sbar.set_sb_lines(48);
    sbar.Sbar_Draw();
    assertEqual(pics.length, 0, "Sbar_Draw draws nothing during intermission");
  } finally {
    sbar.set_sb_lines(0);
    sbar.Sbar_SetExternals({ cl });
    if (!hadWindow) delete globalThis.window;
  }
});
