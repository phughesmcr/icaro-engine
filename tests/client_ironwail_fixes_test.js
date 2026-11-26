// Client fixes taken from Ironwail/QuakeSpasm: the cl_bobcycle 0 guard, the
// CL_Disconnect reset, the chase camera wall trace, CL_KeepaliveMessage, and
// the single definition of MAX_DLIGHTS / MAX_VISEDICTS.

// Bootstrap the client renderer graph in its established safe import order.
await import("../src/gl_rsurf.js");

const view = await import("../src/view.js");
const { scr_viewsize } = await import("../src/gl_screen.js");
const { CL_Disconnect } = await import("../src/cl_main.js");
const { Chase_Init, Chase_Update } = await import("../src/chase.js");
const { CL_KeepaliveMessage } = await import("../src/cl_parse.js");
const client = await import("../src/client.js");
const { cl, cls, ca_connected, ca_disconnected } = client;
const { sv } = await import("../src/server.js");
const { r_refdef } = await import("../src/render.js");
const { Cvar_FindVar, Cvar_Set } = await import("../src/cvar.js");
const { CONTENTS_EMPTY, CONTENTS_SOLID } = await import("../src/bspfile.js");
const gl_rmain = await import("../src/gl_rmain.js");
const gl_rlight = await import("../src/gl_rlight.js");
const net = await import("../src/net.js");
const { SZ_Alloc, SZ_Clear, SZ_Write, COM_SetNetMessage } = await import(
  "../src/common.js"
);
const common = await import("../src/common.js");
const { svc_nop, svc_time, svc_print, clc_nop, PF_NOCLIP } = await import(
  "../src/protocol.js"
);
const { CL_ParseClientdata } = await import("../src/cl_parse.js");
const { CL_SetPlayerInfo, CL_GetPredictedPlayer } = await import(
  "../src/cl_pred.js"
);
const { R_AddEfrags, R_Efrag_SetExternals } = await import(
  "../src/gl_refrag.js"
);

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

function assertNear(actual, expected, epsilon, message) {
  if (
    Number.isFinite(actual) !== true || Math.abs(actual - expected) > epsilon
  ) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

Deno.test("MAX_DLIGHTS and MAX_VISEDICTS have one definition", () => {
  assertEqual(gl_rmain.MAX_DLIGHTS, client.MAX_DLIGHTS, "gl_rmain MAX_DLIGHTS");
  assertEqual(
    gl_rlight.MAX_DLIGHTS,
    client.MAX_DLIGHTS,
    "gl_rlight MAX_DLIGHTS",
  );
  assertEqual(
    gl_rmain.MAX_VISEDICTS,
    client.MAX_VISEDICTS,
    "gl_rmain MAX_VISEDICTS",
  );
  assertEqual(client.cl_dlights.length, client.MAX_DLIGHTS, "cl_dlights size");
  assertEqual(
    client.cl_visedicts.length,
    client.MAX_VISEDICTS,
    "cl_visedicts size",
  );
  assertEqual(
    client.cl_static_entities.length,
    client.MAX_STATIC_ENTITIES,
    "cl_static_entities size",
  );
});

Deno.test("cl_bobcycle 0 does not bob", () => {
  if (Cvar_FindVar("cl_bobcycle") === null) {
    view.V_Init();
  }

  const cycle = Cvar_FindVar("cl_bobcycle");
  const saved = {
    cycle: cycle.string,
    active: sv.active,
    demo: cls.demoplayback,
    time: cl.time,
    velocity: Float32Array.from(cl.velocity),
  };

  try {
    // V_UsePrediction() is false with a local server: the WinQuake path
    sv.active = true;
    cl.time = 1.25;
    cl.velocity[0] = 320;
    cl.velocity[1] = 0;

    Cvar_Set("cl_bobcycle", "0.6");
    const bob = view.V_CalcBob();
    assertEqual(
      Number.isFinite(bob) && bob !== 0,
      true,
      "bob with cl_bobcycle 0.6",
    );

    Cvar_Set("cl_bobcycle", "0");
    assertEqual(view.V_CalcBob(), 0, "bob with cl_bobcycle 0");
  } finally {
    Cvar_Set("cl_bobcycle", saved.cycle);
    sv.active = saved.active;
    cls.demoplayback = saved.demo;
    cl.time = saved.time;
    cl.velocity.set(saved.velocity);
  }
});

Deno.test("CL_Disconnect clears the intermission and colour shifts", () => {
  const saved = {
    state: cls.state,
    demo: cls.demoplayback,
    timedemo: cls.timedemo,
    signon: cls.signon,
    intermission: cl.intermission,
    cshift: view.cshift_empty.percent,
    blend: Float32Array.from(view.v_blend),
  };

  try {
    cls.state = ca_disconnected;
    cls.demoplayback = false;
    cl.intermission = 2;
    view.cshift_empty.percent = 50;
    view.v_blend.set([1, 0.5, 0.25, 0.75]);

    CL_Disconnect();

    assertEqual(cl.intermission, 0, "intermission");
    assertEqual(view.cshift_empty.percent, 0, "v_cshift percent");
    for (let i = 0; i < 4; i++) {
      assertEqual(view.v_blend[i], 0, "v_blend[" + i + "]");
    }
  } finally {
    cls.state = saved.state;
    cls.demoplayback = saved.demo;
    cls.timedemo = saved.timedemo;
    cls.signon = saved.signon;
    cl.intermission = saved.intermission;
    view.cshift_empty.percent = saved.cshift;
    view.v_blend.set(saved.blend);
  }
});

// One plane at x = wallx: empty in front (x > wallx), solid behind.
function wallHull(wallx) {
  return {
    firstclipnode: 0,
    lastclipnode: 0,
    clipnodes: [{
      planenum: 0,
      children: new Int16Array([CONTENTS_EMPTY, CONTENTS_SOLID]),
    }],
    planes: [{ type: 0, dist: wallx, normal: new Float32Array([1, 0, 0]) }],
  };
}

Deno.test("Chase_Update stops the camera at a wall", async () => {
  Chase_Init();
  // Chase_Init loads world.js lazily; let that import settle
  await import("../src/world.js");
  await new Promise((resolve) => setTimeout(resolve, 0));

  const saved = {
    worldmodel: cl.worldmodel,
    viewangles: Float32Array.from(cl.viewangles),
    vieworg: Float32Array.from(r_refdef.vieworg),
    refangles: Float32Array.from(r_refdef.viewangles),
  };

  try {
    // looking along +x, so chase_back 100 puts the camera at x = -100
    cl.viewangles.fill(0);

    cl.worldmodel = { hulls: [wallHull(-1000)] };
    r_refdef.vieworg.fill(0);
    Chase_Update();
    assertNear(r_refdef.vieworg[0], -100, 1e-4, "open camera x");
    assertNear(r_refdef.vieworg[2], 16, 1e-4, "open camera z");

    cl.worldmodel = { hulls: [wallHull(-64)] };
    r_refdef.vieworg.fill(0);
    Chase_Update();
    // SV_RecursiveHullCheck stops DIST_EPSILON in front of the plane
    assertNear(r_refdef.vieworg[0], -64 + 0.03125, 1e-3, "walled camera x");
    assertEqual(
      r_refdef.vieworg[2] > 0 && r_refdef.vieworg[2] < 16,
      true,
      "walled camera z on the trace",
    );
  } finally {
    cl.worldmodel = saved.worldmodel;
    cl.viewangles.set(saved.viewangles);
    r_refdef.vieworg.set(saved.vieworg);
    r_refdef.viewangles.set(saved.refangles);
  }
});

// Runs fn connected to a fake net driver whose queue holds the given server
// messages ({ reliable, bytes }). Returns what the client sent reliably.
function withFakeServer(queue, fn) {
  const FAKE_DRIVER = net.MAX_NET_DRIVERS - 1;
  const savedDriver = net.net_drivers[FAKE_DRIVER];
  const savedActive = net.net_activeSockets;
  const savedFree = net.net_freeSockets;
  const saved = {
    state: cls.state,
    netcon: cls.netcon,
    demoplayback: cls.demoplayback,
    demonum: cls.demonum,
    svactive: sv.active,
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
  const savedNow = performance.now;

  const sent = [];
  net.net_drivers[FAKE_DRIVER] = {
    initialized: true,
    QGetMessage(_sock) {
      if (queue.length === 0) {
        return 0;
      }
      const msg = queue.shift();
      SZ_Clear(net.net_message);
      SZ_Write(net.net_message, msg.bytes, msg.bytes.length);
      return msg.reliable ? 1 : 2;
    },
    QSendMessage(_sock, data) {
      sent.push(Array.from(data.data.subarray(0, data.cursize)));
      return 1;
    },
    SendUnreliableMessage() {
      return 1;
    },
    Close() {},
  };

  try {
    // more than 5 s after the last keepalive
    performance.now = () => 1e9;

    const sock = new net.qsocket_t();
    sock.disconnected = false;
    sock.driver = FAKE_DRIVER;
    sock.lastMessageTime = 1e9;
    sock.next = null;
    net.set_net_activeSockets(sock);

    cls.state = ca_connected;
    cls.netcon = sock;
    cls.demoplayback = false;
    cls.demonum = -1;
    sv.active = false;
    SZ_Alloc(cls.message, 1024);

    COM_SetNetMessage(net.net_message);
    net.net_message.data = new Uint8Array(1024);
    net.net_message.maxsize = 1024;

    fn();
    return sent;
  } finally {
    performance.now = savedNow;
    net.net_drivers[FAKE_DRIVER] = savedDriver;
    net.set_net_activeSockets(savedActive);
    net.set_net_freeSockets(savedFree);
    cls.state = saved.state;
    cls.netcon = saved.netcon;
    cls.demoplayback = saved.demoplayback;
    cls.demonum = saved.demonum;
    sv.active = saved.svactive;
    cls.message.data = savedClientMessage.data;
    cls.message.maxsize = savedClientMessage.maxsize;
    SZ_Clear(cls.message);
    net.net_message.data = savedMessage.data;
    net.net_message.maxsize = savedMessage.maxsize;
    net.net_message.cursize = savedMessage.cursize;
    COM_SetNetMessage(savedCommonMessage);
  }
}

Deno.test("CL_KeepaliveMessage reads queued datagrams and sends a nop", () => {
  const queue = [
    { reliable: false, bytes: new Uint8Array([svc_nop]) },
    // a stale entity update from before a level change
    { reliable: false, bytes: new Uint8Array([svc_time, 1, 2, 3, 4]) },
  ];

  const sent = withFakeServer(queue, () => {
    // the message being parsed (CL_ParseServerInfo's)
    SZ_Clear(net.net_message);
    SZ_Write(net.net_message, new Uint8Array([9, 8, 7]), 3);

    CL_KeepaliveMessage();

    assertEqual(queue.length, 0, "queued messages read");
    assertEqual(net.net_message.cursize, 3, "net_message size restored");
    assertEqual(
      Array.from(net.net_message.data.subarray(0, 3)).join(","),
      "9,8,7",
      "net_message data restored",
    );
    assertEqual(cls.message.cursize, 0, "cls.message cleared");
  });

  assertEqual(sent.length, 1, "reliable messages sent");
  assertEqual(sent[0].join(","), String(clc_nop), "clc_nop sent");
});

Deno.test("CL_KeepaliveMessage errors on a reliable message", () => {
  const queue = [{ reliable: true, bytes: new Uint8Array([svc_print, 0]) }];

  withFakeServer(queue, () => {
    SZ_Clear(net.net_message);
    let thrown = null;
    try {
      CL_KeepaliveMessage();
    } catch (e) {
      thrown = e;
    }

    assertEqual(
      thrown !== null &&
        thrown.message.startsWith(
          "Host_Error: CL_KeepaliveMessage: received a message",
        ),
      true,
      "Host_Error",
    );
    assertEqual(cls.state, ca_disconnected, "disconnected");
  });
});

Deno.test("efrags are allocated on demand once the pool is used up", () => {
  const saved = { free: cl.free_efrags, worldmodel: cl.worldmodel };
  const leaf = { contents: CONTENTS_EMPTY, efrags: null };
  const ent = new client.entity_t();
  ent.model = {
    mins: new Float32Array([-8, -8, -8]),
    maxs: new Float32Array([8, 8, 8]),
  };

  try {
    R_Efrag_SetExternals({ cl });
    cl.worldmodel = { nodes: [leaf] };
    cl.free_efrags = null;

    R_AddEfrags(ent);

    assertEqual(
      ent.efrag !== null && ent.efrag.entity === ent,
      true,
      "entity efrag",
    );
    assertEqual(leaf.efrags, ent.efrag, "leaf efrag");
    let free = 0;
    for (let ef = cl.free_efrags; ef !== null; ef = ef.entnext) {
      free++;
    }
    assertEqual(free, 127, "efrags left from the new batch");
  } finally {
    cl.free_efrags = saved.free;
    cl.worldmodel = saved.worldmodel;
  }
});

Deno.test("svc_clientdata stops pitch drift during signon", () => {
  const saved = {
    signon: cls.signon,
    nodrift: cl.nodrift,
    laststop: cl.laststop,
    pitchvel: cl.pitchvel,
    time: cl.time,
    viewheight: cl.viewheight,
    idealpitch: cl.idealpitch,
    items: cl.items,
    onground: cl.onground,
    inwater: cl.inwater,
    stats: Int32Array.from(cl.stats),
    punch: Float32Array.from(cl.punchangle),
    mvel0: Float32Array.from(cl.mvelocity[0]),
    mvel1: Float32Array.from(cl.mvelocity[1]),
    message: {
      data: net.net_message.data,
      maxsize: net.net_message.maxsize,
      cursize: net.net_message.cursize,
    },
    commonMessage: common.net_message,
  };

  try {
    COM_SetNetMessage(net.net_message);
    net.net_message.data = new Uint8Array(64);
    net.net_message.maxsize = 64;

    for (const [signon, drifting] of [[2, false], [client.SIGNONS, true]]) {
      cls.signon = signon;
      cl.time = 3;
      cl.laststop = 0;
      cl.nodrift = false;
      cl.pitchvel = 10;
      // bits 0: items, health, ammo, four ammo counts and the weapon
      net.net_message.cursize = 16;
      net.net_message.data.fill(0);
      common.MSG_BeginReading();

      CL_ParseClientdata(0);

      assertEqual(cl.nodrift, !drifting, "nodrift at signon " + signon);
      assertEqual(
        cl.laststop,
        drifting ? 0 : 3,
        "laststop at signon " + signon,
      );
    }
  } finally {
    cls.signon = saved.signon;
    cl.nodrift = saved.nodrift;
    cl.laststop = saved.laststop;
    cl.pitchvel = saved.pitchvel;
    cl.time = saved.time;
    cl.viewheight = saved.viewheight;
    cl.idealpitch = saved.idealpitch;
    cl.items = saved.items;
    cl.onground = saved.onground;
    cl.inwater = saved.inwater;
    cl.stats.set(saved.stats);
    cl.punchangle.set(saved.punch);
    cl.mvelocity[0].set(saved.mvel0);
    cl.mvelocity[1].set(saved.mvel1);
    net.net_message.data = saved.message.data;
    net.net_message.maxsize = saved.message.maxsize;
    net.net_message.cursize = saved.message.cursize;
    COM_SetNetMessage(saved.commonMessage);
  }
});

Deno.test("stair smoothing is skipped in noclip", () => {
  if (Cvar_FindVar("cl_bobcycle") === null) {
    view.V_Init();
  }

  const ent = client.cl_entities[1];
  const pplayer = CL_GetPredictedPlayer(0);
  const saved = {
    active: sv.active,
    viewentity: cl.viewentity,
    onground: cl.onground,
    time: cl.time,
    oldtime: cl.oldtime,
    viewheight: cl.viewheight,
    origin: Float32Array.from(ent.origin),
    flags: pplayer !== null ? pplayer.flags : 0,
    vieworg: Float32Array.from(r_refdef.vieworg),
    refangles: Float32Array.from(r_refdef.viewangles),
  };
  const setNoclip = (flags) =>
    CL_SetPlayerInfo(
      0,
      ent.origin,
      cl.velocity,
      0,
      flags,
      0,
      0,
      0,
      0,
      null,
      0,
      0,
    );

  // Step up 10 units while on the ground; returns how far the view lags.
  const stepLag = () => {
    ent.origin.fill(0);
    cl.onground = false;
    view.V_CalcRefdef(); // settles the smoothing at z 0
    ent.origin[2] = 10;
    cl.onground = true;
    view.V_CalcRefdef();
    return 10 + cl.viewheight - r_refdef.vieworg[2];
  };

  try {
    sv.active = true; // the WinQuake path: cl.onground and the entity origin
    cl.viewentity = 1;
    cl.viewheight = 22;
    cl.time = 2;
    cl.oldtime = 1.99;

    setNoclip(0);
    assertEqual(stepLag() > 9, true, "walking lags the view behind the step");

    setNoclip(PF_NOCLIP);
    assertNear(stepLag(), 0, 1, "noclip view lag");
  } finally {
    setNoclip(saved.flags);
    sv.active = saved.active;
    cl.viewentity = saved.viewentity;
    cl.onground = saved.onground;
    cl.time = saved.time;
    cl.oldtime = saved.oldtime;
    cl.viewheight = saved.viewheight;
    ent.origin.set(saved.origin);
    r_refdef.vieworg.set(saved.vieworg);
    r_refdef.viewangles.set(saved.refangles);
  }
});

Deno.test("QuakeSpasm r_viewmodel_quake 0 drops id's gun height fudge", () => {
  if (Cvar_FindVar("cl_bobcycle") === null) {
    view.V_Init();
  }
  if (Cvar_FindVar("r_viewmodel_quake") === null) {
    throw new Error("V_Init did not register r_viewmodel_quake");
  }

  const ent = client.cl_entities[1];
  const saved = {
    active: sv.active,
    viewentity: cl.viewentity,
    onground: cl.onground,
    time: cl.time,
    oldtime: cl.oldtime,
    viewheight: cl.viewheight,
    origin: Float32Array.from(ent.origin),
    vieworg: Float32Array.from(r_refdef.vieworg),
    refangles: Float32Array.from(r_refdef.viewangles),
    viewsize: scr_viewsize.value,
  };

  const gunZ = () => {
    view.V_CalcRefdef();
    return cl.viewent.origin[2] - r_refdef.vieworg[2];
  };

  try {
    sv.active = true;
    cl.viewentity = 1;
    cl.viewheight = 22;
    cl.onground = false;
    cl.time = 2;
    cl.oldtime = 1.99;
    ent.origin.fill(0);
    scr_viewsize.value = 100;

    assertEqual(view.r_viewmodel_quake.string, "1", "default keeps id's view");
    const fudged = gunZ();
    Cvar_Set("r_viewmodel_quake", "0");
    assertNear(fudged - gunZ(), 2, 1e-4, "viewsize 100 raises the gun by 2");
  } finally {
    Cvar_Set("r_viewmodel_quake", "1");
    scr_viewsize.value = saved.viewsize;
    sv.active = saved.active;
    cl.viewentity = saved.viewentity;
    cl.onground = saved.onground;
    cl.time = saved.time;
    cl.oldtime = saved.oldtime;
    cl.viewheight = saved.viewheight;
    ent.origin.set(saved.origin);
    r_refdef.vieworg.set(saved.vieworg);
    r_refdef.viewangles.set(saved.refangles);
  }
});
