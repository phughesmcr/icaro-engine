// With renderer/network isolation (host_maxfps above 72 or 0) a local
// server's entities, and the camera, lerp between its 72 Hz ticks, as in
// Ironwail cl_main.c CL_LerpPoint / CL_RelinkEntities. In WinQuake's single
// loop they still snap to the newest message.

// Bootstrap the client renderer graph in its established safe import order.
await import("../src/gl_rsurf.js");

const { CL_LerpPoint, CL_RelinkEntities } = await import("../src/cl_main.js");
const { cl, cls, cl_entities } = await import("../src/client.js");
const { sv } = await import("../src/server.js");
const { HOST_NETINTERVAL, host_netinterval, set_host_netinterval } =
  await import("../src/host.js");
const {
  CL_GetEntityFrame,
  CL_ResetPrediction,
  CL_SetPlayerInfo,
  CL_SetServerSequence,
  CL_SetValidSequence,
} = await import("../src/cl_pred.js");
const { Cvar_FindVar, Cvar_RegisterVariable } = await import(
  "../src/cvar.js"
);

function assertNear(actual, expected, message) {
  if (Math.abs(actual - expected) > 1e-4) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

function withClientState(fn) {
  const old = {
    active: sv.active,
    interval: host_netinterval,
    time: cl.time,
    m0: cl.mtime[0],
    m1: cl.mtime[1],
    demo: cls.demoplayback,
    timedemo: cls.timedemo,
  };
  try {
    cls.demoplayback = false;
    cls.timedemo = false;
    fn();
  } finally {
    sv.active = old.active;
    set_host_netinterval(old.interval);
    cl.time = old.time;
    cl.mtime[0] = old.m0;
    cl.mtime[1] = old.m1;
    cls.demoplayback = old.demo;
    cls.timedemo = old.timedemo;
  }
}

Deno.test("CL_LerpPoint lerps a local server only under isolation", () => {
  withClientState(() => {
    sv.active = true;
    cl.mtime[1] = 1.0;
    cl.mtime[0] = 1.0 + HOST_NETINTERVAL;

    set_host_netinterval(0);
    cl.time = 1.0 + HOST_NETINTERVAL / 2;
    assertNear(CL_LerpPoint(), 1, "single loop frac");
    assertNear(cl.time, cl.mtime[0], "single loop snaps cl.time");

    set_host_netinterval(HOST_NETINTERVAL);
    cl.time = 1.0 + HOST_NETINTERVAL / 4;
    assertNear(CL_LerpPoint(), 0.25, "isolated frac");
    assertNear(cl.time, 1.0 + HOST_NETINTERVAL / 4, "cl.time kept");
  });
});

Deno.test("the camera lerps between a local server's ticks under isolation", () => {
  if (Cvar_FindVar("chase_active") === null) {
    Cvar_RegisterVariable({ name: "chase_active", string: "0", value: 0 });
  }
  const old = {
    maxclients: cl.maxclients,
    num: cl.num_entities,
    view: cl.viewentity,
    model: cl.model_precache[1],
  };
  const ent = cl_entities[1];
  const oldEnt = { model: ent.model, origin: Array.from(ent.origin) };
  const zero = new Float32Array(3);
  let seq = 0;

  // one server message: the player at x, mtime moved on by one tick
  function message(x) {
    seq++;
    cl.mtime[1] = cl.mtime[0];
    cl.mtime[0] += HOST_NETINTERVAL;
    CL_SetServerSequence(seq);
    CL_SetValidSequence(seq);
    CL_GetEntityFrame(seq).packet_entities.num_entities = 0;
    CL_SetPlayerInfo(0, [x, 0, 0], zero, 0, 0, 0, 0, 0, 0, null, 1, 0);
  }

  withClientState(() => {
    try {
      CL_ResetPrediction();
      sv.active = true; // no client prediction: the camera is ent.origin
      cl.maxclients = 1;
      cl.viewentity = 1;
      cl.num_entities = 2;
      cl.model_precache[1] = { name: "progs/player.mdl", flags: 0 };
      cl.mtime[0] = 1.0;

      set_host_netinterval(HOST_NETINTERVAL);
      message(100);
      message(110);
      cl.time = cl.mtime[1] + HOST_NETINTERVAL / 2;
      CL_RelinkEntities();
      assertNear(ent.origin[0], 105, "isolated: halfway between ticks");

      cl.time = cl.mtime[0];
      CL_RelinkEntities();
      assertNear(ent.origin[0], 110, "isolated: at the newest tick");

      // a teleport doesn't lerp
      message(400);
      cl.time = cl.mtime[1] + HOST_NETINTERVAL / 2;
      CL_RelinkEntities();
      assertNear(ent.origin[0], 400, "teleport");

      // WinQuake's single loop: the newest server origin, as before
      set_host_netinterval(0);
      message(410);
      cl.time = cl.mtime[1] + HOST_NETINTERVAL / 2;
      CL_RelinkEntities();
      assertNear(ent.origin[0], 410, "single loop");
    } finally {
      CL_ResetPrediction();
      cl.maxclients = old.maxclients;
      cl.num_entities = old.num;
      cl.viewentity = old.view;
      cl.model_precache[1] = old.model;
      ent.model = oldEnt.model;
      ent.origin.set(oldEnt.origin);
    }
  });
});
