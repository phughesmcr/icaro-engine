// r_lerpmodels and r_lerpmove: FitzQuake/QuakeSpasm interpolation of
// alias-model animation (R_SetupAliasFrame) and MOVETYPE_STEP movement
// (R_SetupEntityTransform), and the lerpflags the client sets for them.

// Bootstrap the client renderer graph in its established safe import order.
await import("../src/gl_rsurf.js");

const { R_SetupAliasFrame, R_SetupEntityTransform, lerpdata_t } = await import(
  "../src/gl_mesh.js"
);
const { CL_RelinkEntities } = await import("../src/cl_main.js");
const { cl, cls, cl_entities, entity_t } = await import("../src/client.js");
const { sv } = await import("../src/server.js");
const { PS_NOLERP, PS_BOX } = await import("../src/protocol.js");
const {
  CL_ResetPrediction,
  CL_SetValidSequence,
  CL_SetServerSequence,
  CL_GetEntityFrame,
} = await import("../src/cl_pred.js");
const {
  r_lerpmodels,
  r_lerpmove,
  r_nolerp_list,
  LERP_MOVESTEP,
  LERP_RESETANIM,
  LERP_RESETANIM2,
  LERP_RESETMOVE,
} = await import("../src/render.js");
const { MOD_NOLERP, nameInList, mod_alias } = await import(
  "../src/gl_model.js"
);

function assertNear(actual, expected, message) {
  if (Math.abs(actual - expected) > 1e-4) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

function assertEq(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

function setCvar(cvar, value) {
  cvar.value = value;
  cvar.string = String(value);
}

// Runs fn with the lerp cvars and cl.time set, and restores them after.
function withLerp(models, move, fn) {
  const old = {
    models: r_lerpmodels.value,
    move: r_lerpmove.value,
    time: cl.time,
  };
  try {
    setCvar(r_lerpmodels, models);
    setCvar(r_lerpmove, move);
    fn();
  } finally {
    setCvar(r_lerpmodels, old.models);
    setCvar(r_lerpmove, old.move);
    cl.time = old.time;
  }
}

// frames 0 and 1: one pose each; frame 2: a two-pose group, 0.2 s per pose
function makeHdr() {
  return {
    numframes: 3,
    numposes: 4,
    frames: [
      { firstpose: 0, numposes: 1, interval: 0 },
      { firstpose: 1, numposes: 1, interval: 0 },
      { firstpose: 2, numposes: 2, interval: 0.2 },
    ],
  };
}

function makeEntity(name = "progs/ogre.mdl") {
  const e = new entity_t();
  e.model = { name, type: mod_alias, flags: 0, extraflags_list: null };
  return e;
}

function frame(e, hdr, f, time, ld) {
  cl.time = time;
  e.frame = f;
  R_SetupAliasFrame(e, hdr, f, ld);
}

Deno.test("R_SetupAliasFrame blends to a new pose over 0.1 s", () =>
  withLerp(1, 0, () => {
    const hdr = makeHdr();
    const e = makeEntity();
    const ld = new lerpdata_t();

    // a new entity starts with LERP_RESETANIM: nothing to lerp from
    frame(e, hdr, 0, 10.0, ld);
    assertEq(ld.pose1, 0, "first pose1");
    assertEq(ld.pose2, 0, "first pose2");
    assertEq(ld.blend, 1, "first blend");
    assertEq(e.lerpflags & LERP_RESETANIM, 0, "reset flag cleared");

    frame(e, hdr, 1, 10.0, ld);
    assertEq(ld.pose1, 0, "start pose1");
    assertEq(ld.pose2, 1, "start pose2");
    assertNear(ld.blend, 0, "start blend");

    frame(e, hdr, 1, 10.05, ld);
    assertNear(ld.blend, 0.5, "halfway blend");

    frame(e, hdr, 1, 10.2, ld);
    assertEq(ld.blend, 1, "finished blend");
    assertEq(ld.pose1, 1, "finished lerp drops the old pose");

    // a pose group lerps over its own interval
    frame(e, hdr, 2, 10.0, ld); // pose 2 + ( 10.0 / 0.2 | 0 ) % 2 = 2
    assertEq(ld.pose2, 2, "group pose");
    assertNear(e.lerptime, 0.2, "group lerptime");
    frame(e, hdr, 2, 10.1, ld);
    assertNear(ld.blend, 0.5, "group halfway");
  }));

Deno.test("R_SetupAliasFrame with r_lerpmodels 0 draws id's pose", () =>
  withLerp(0, 0, () => {
    const hdr = makeHdr();
    const e = makeEntity();
    const ld = new lerpdata_t();
    frame(e, hdr, 0, 10.0, ld);
    frame(e, hdr, 1, 10.01, ld);
    assertEq(ld.pose1, 1, "pose1");
    assertEq(ld.pose2, 1, "pose2");
    assertEq(ld.blend, 1, "blend");
    frame(e, hdr, 2, 10.3, ld); // 2 + ( 10.3 / 0.2 | 0 ) % 2 = 3
    assertEq(ld.pose2, 3, "group pose");
    assertEq(ld.pose1, 3, "group pose1");
  }));

Deno.test("LERP_RESETANIM, LERP_RESETANIM2 and model changes stop the blend", () =>
  withLerp(1, 0, () => {
    const hdr = makeHdr();
    const e = makeEntity();
    const ld = new lerpdata_t();
    frame(e, hdr, 0, 10.0, ld);

    e.lerpflags |= LERP_RESETANIM;
    frame(e, hdr, 1, 10.0, ld);
    assertEq(ld.pose1, 1, "RESETANIM pose1");
    assertEq(ld.blend, 1, "RESETANIM blend");

    // muzzle flash: no lerping for two frames
    e.lerpflags |= LERP_RESETANIM | LERP_RESETANIM2;
    frame(e, hdr, 0, 10.5, ld);
    assertEq(ld.blend, 1, "first frame after flash");
    frame(e, hdr, 1, 10.5, ld);
    assertEq(ld.pose1, 1, "second frame after flash pose1");
    assertEq(ld.blend, 1, "second frame after flash");
    frame(e, hdr, 0, 11.0, ld);
    assertEq(ld.pose1, 1, "third frame lerps from pose1");
    assertNear(ld.blend, 0, "third frame lerps");

    // a new model under the entity (view.js, cl_tent.js set e.model directly)
    const hdr2 = makeHdr();
    frame(e, hdr2, 1, 11.0, ld);
    assertEq(ld.pose1, 1, "new model pose1");
    assertEq(ld.blend, 1, "new model blend");
  }));

Deno.test("r_nolerp_list models (MOD_NOLERP) lerp only with r_lerpmodels 2", () => {
  const oldList = r_nolerp_list.string;
  try {
    withLerp(1, 0, () => {
      const hdr = makeHdr();
      const e = makeEntity("progs/flame2.mdl");
      const ld = new lerpdata_t();
      frame(e, hdr, 0, 10.0, ld);
      frame(e, hdr, 1, 10.05, ld);
      if ((e.model.flags & MOD_NOLERP) === 0) {
        throw new Error("flame2 should get MOD_NOLERP");
      }
      assertEq(ld.blend, 1, "nolerp model at 1");
      assertEq(ld.pose1, 1, "nolerp model pose1");

      setCvar(r_lerpmodels, 2);
      frame(e, hdr, 0, 10.1, ld);
      assertEq(ld.pose1, 1, "nolerp model at 2 pose1");
      assertNear(ld.blend, 0, "nolerp model at 2 lerps");

      // a changed list takes effect without a reload
      setCvar(r_lerpmodels, 1);
      r_nolerp_list.string = "progs/flame.mdl";
      frame(e, hdr, 1, 10.3, ld);
      assertEq(e.model.flags & MOD_NOLERP, 0, "flag cleared when list changes");
      assertNear(ld.blend, 0, "lerps once off the list");
    });
  } finally {
    r_nolerp_list.string = oldList;
  }
});

Deno.test("nameInList matches whole comma-separated entries", () => {
  assertEq(
    nameInList("progs/flame.mdl,progs/flame2.mdl", "progs/flame2.mdl"),
    true,
    "second entry",
  );
  assertEq(
    nameInList("progs/flame.mdl,progs/flame2.mdl", "progs/flame.mdl"),
    true,
    "first entry",
  );
  assertEq(nameInList("progs/flame2.mdl", "progs/flame.mdl"), false, "prefix");
  assertEq(
    nameInList("progs/flame.mdl,,progs/x.mdl", "progs/x.mdl"),
    true,
    "double comma",
  );
  assertEq(nameInList("", "progs/x.mdl"), false, "empty list");
});

Deno.test("R_SetupEntityTransform slides MOVETYPE_STEP entities over 0.1 s", () =>
  withLerp(0, 1, () => {
    const e = makeEntity();
    const ld = new lerpdata_t();
    e.lerpflags |= LERP_MOVESTEP;
    e.origin[0] = 100;
    e.angles[1] = 350;
    cl.time = 5.0;
    R_SetupEntityTransform(e, ld); // LERP_RESETMOVE from the constructor
    assertEq(e.lerpflags & LERP_RESETMOVE, 0, "reset flag cleared");
    assertNear(ld.origin[0], 100, "first origin");

    // the server moves it a step
    e.origin[0] = 108;
    e.angles[1] = 10;
    R_SetupEntityTransform(e, ld);
    assertNear(ld.origin[0], 100, "start origin");
    cl.time = 5.05;
    R_SetupEntityTransform(e, ld);
    assertNear(ld.origin[0], 104, "halfway origin");
    assertNear(ld.angles[1], 360, "halfway angle turns through 0");
    cl.time = 5.5;
    R_SetupEntityTransform(e, ld);
    assertNear(ld.origin[0], 108, "finished origin");

    // a teleport (LERP_RESETMOVE) snaps
    e.origin[0] = 900;
    e.lerpflags |= LERP_RESETMOVE;
    R_SetupEntityTransform(e, ld);
    assertNear(ld.origin[0], 900, "teleport snaps");
    assertNear(e.previousorigin[0], 900, "teleport resets previousorigin");

    // r_lerpmove 0 draws the entity where it is
    e.origin[0] = 908;
    setCvar(r_lerpmove, 0);
    R_SetupEntityTransform(e, ld);
    assertNear(ld.origin[0], 908, "r_lerpmove 0");

    // only MOVETYPE_STEP entities lerp, and never the gun
    setCvar(r_lerpmove, 1);
    e.lerpflags &= ~LERP_MOVESTEP;
    cl.time = 6.0;
    e.origin[0] = 916;
    R_SetupEntityTransform(e, ld);
    assertNear(ld.origin[0], 916, "not MOVESTEP");

    const oldViewent = cl.viewent;
    try {
      cl.viewent = e;
      e.lerpflags |= LERP_MOVESTEP;
      e.origin[0] = 924;
      R_SetupEntityTransform(e, ld);
      assertNear(ld.origin[0], 924, "viewent");
    } finally {
      cl.viewent = oldViewent;
    }
  }));

function sendPacket(seq, x, effects) {
  CL_SetServerSequence(seq);
  CL_SetValidSequence(seq);
  const pak = CL_GetEntityFrame(seq).packet_entities;
  pak.num_entities = 2;
  for (let i = 0; i < 2; i++) {
    const s = pak.state(i);
    s.number = 2 + i;
    s.modelindex = 1;
    s.origin[0] = x;
    s.angles[1] = 0;
    s.effects = effects;
    // entity 2 is a walking monster, entity 3 isn't
    s.solid = i === 0 ? PS_BOX | PS_NOLERP : PS_BOX;
  }
}

function saveClient() {
  return {
    active: sv.active,
    maxclients: cl.maxclients,
    num: cl.num_entities,
    view: cl.viewentity,
    model: cl.model_precache[1],
    time: cl.time,
    m0: cl.mtime[0],
    m1: cl.mtime[1],
    demo: cls.demoplayback,
    timedemo: cls.timedemo,
  };
}

function restoreClient(old) {
  CL_ResetPrediction();
  sv.active = old.active;
  cl.maxclients = old.maxclients;
  cl.num_entities = old.num;
  cl.viewentity = old.view;
  cl.model_precache[1] = old.model;
  cl.time = old.time;
  cl.mtime[0] = old.m0;
  cl.mtime[1] = old.m1;
  cls.demoplayback = old.demo;
  cls.timedemo = old.timedemo;
  for (let i = 2; i <= 3; i++) {
    cl_entities[i].model = null;
    cl_entities[i]._lastPESeq = 0;
    cl_entities[i].lerpflags = LERP_RESETMOVE | LERP_RESETANIM;
  }
}

Deno.test("CL_LinkPacketEntities sets lerpflags from the packet", () =>
  withLerp(1, 1, () => {
    const old = saveClient();
    try {
      CL_ResetPrediction();
      sv.active = false;
      cls.demoplayback = false;
      cls.timedemo = false;
      cl.maxclients = 1;
      cl.viewentity = 1;
      cl.num_entities = 4;
      cl.model_precache[1] = {
        name: "progs/ogre.mdl",
        type: mod_alias,
        flags: 0,
        synctype: 0,
      };
      cl_entities[2]._lastPESeq = 0;
      cl_entities[3]._lastPESeq = 0;

      cl.mtime[1] = 0.9;
      cl.mtime[0] = 1.0;
      cl.time = 1.0;
      sendPacket(1, 0, 0);
      cl_entities[2].lerpflags = 0;
      cl_entities[3].lerpflags = 0;
      CL_RelinkEntities();

      // first appearance: nothing to lerp from
      assertEq(
        cl_entities[2].lerpflags & (LERP_RESETMOVE | LERP_RESETANIM),
        LERP_RESETMOVE | LERP_RESETANIM,
        "new entity resets",
      );
      assertEq(
        cl_entities[2].lerpflags & LERP_MOVESTEP,
        LERP_MOVESTEP,
        "PS_NOLERP sets LERP_MOVESTEP",
      );
      assertEq(
        cl_entities[3].lerpflags & LERP_MOVESTEP,
        0,
        "no PS_NOLERP, no LERP_MOVESTEP",
      );

      // a step, then a muzzle flash
      cl_entities[2].lerpflags &= ~(LERP_RESETMOVE | LERP_RESETANIM);
      cl.mtime[1] = 1.0;
      cl.mtime[0] = 1.1;
      cl.time = 1.1;
      sendPacket(2, 8, 0x0002); // EF_MUZZLEFLASH
      CL_RelinkEntities();
      assertEq(
        cl_entities[2].lerpflags & LERP_RESETMOVE,
        0,
        "a step is not a teleport",
      );
      assertEq(
        cl_entities[2].lerpflags & (LERP_RESETANIM | LERP_RESETANIM2),
        LERP_RESETANIM | LERP_RESETANIM2,
        "muzzle flash stops the anim lerp",
      );
      assertNear(
        cl_entities[2].origin[0],
        8,
        "MOVESTEP still snaps for r_lerpmove",
      );

      // with r_lerpmodels 2 the flash doesn't
      setCvar(r_lerpmodels, 2);
      cl_entities[2].lerpflags &= ~(LERP_RESETANIM | LERP_RESETANIM2);
      cl.mtime[1] = 1.1;
      cl.mtime[0] = 1.2;
      cl.time = 1.2;
      sendPacket(3, 16, 0x0002);
      CL_RelinkEntities();
      assertEq(
        cl_entities[2].lerpflags & LERP_RESETANIM2,
        0,
        "r_lerpmodels 2 ignores the flash",
      );
      // CL_RelinkEntities's NQ loop clears ent.model at every packet on
      // this path; that mustn't count as a model change or a removal
      assertEq(
        cl_entities[2].lerpflags & (LERP_RESETANIM | LERP_RESETMOVE),
        0,
        "a new packet keeps the lerps",
      );

      // a jump of more than 100 units is a teleport
      cl.mtime[1] = 1.2;
      cl.mtime[0] = 1.3;
      cl.time = 1.3;
      sendPacket(4, 500, 0);
      CL_RelinkEntities();
      assertEq(
        cl_entities[2].lerpflags & LERP_RESETMOVE,
        LERP_RESETMOVE,
        "teleport resets the move lerp",
      );
      assertEq(
        cl_entities[3].lerpflags & LERP_RESETMOVE,
        LERP_RESETMOVE,
        "teleport (not MOVESTEP)",
      );
    } finally {
      restoreClient(old);
    }
  }));

Deno.test("CL_RelinkEntities (NQ) resets the lerp on teleport and removal", () =>
  withLerp(1, 1, () => {
    const old = saveClient();
    try {
      CL_ResetPrediction();
      CL_SetValidSequence(0); // NetQuake path
      sv.active = false;
      cls.demoplayback = false;
      cls.timedemo = false;
      cl.maxclients = 1;
      cl.viewentity = 1;
      cl.num_entities = 4;
      cl.mtime[1] = 1.0;
      cl.mtime[0] = 1.1;
      cl.time = 1.05;
      const model = {
        name: "progs/ogre.mdl",
        type: mod_alias,
        flags: 0,
        synctype: 0,
      };

      const e = cl_entities[2];
      e.model = model;
      e.msgtime = 1.1;
      e.forcelink = false;
      e.lerpflags = 0;
      e.msg_origins[1][0] = 0;
      e.msg_origins[0][0] = 500;
      CL_RelinkEntities();
      assertEq(e.lerpflags & LERP_RESETMOVE, LERP_RESETMOVE, "teleport");
      assertNear(e.origin[0], 500, "teleport snaps");

      // a MOVETYPE_STEP entity isn't cl_lerped when r_lerpmove will lerp it
      e.lerpflags = LERP_MOVESTEP;
      e.msg_origins[1][0] = 0;
      e.msg_origins[0][0] = 8;
      CL_RelinkEntities();
      assertNear(e.origin[0], 8, "MOVESTEP not cl_lerped");
      e.lerpflags = 0;
      CL_RelinkEntities();
      assertNear(e.origin[0], 4, "others are cl_lerped");

      // left out of the last message: removed, and reset for the next user
      e.msgtime = 1.0;
      CL_RelinkEntities();
      assertEq(e.model, null, "removed");
      assertEq(
        e.lerpflags & (LERP_RESETMOVE | LERP_RESETANIM),
        LERP_RESETMOVE | LERP_RESETANIM,
        "removal resets",
      );
    } finally {
      restoreClient(old);
    }
  }));

Deno.test("CL_EntityNum and CL_NoLerpMuzzleFlash set the reset flags", async () => {
  const { CL_EntityNum } = await import("../src/cl_parse.js");
  const { CL_NoLerpMuzzleFlash } = await import("../src/cl_main.js");
  const old = saveClient();
  const oldView = cl.viewent.lerpflags;
  try {
    // A new slot starts with its lerps reset (CL_EntityNum, johnfitz).
    cl.num_entities = 2;
    cl_entities[2].lerpflags = 0;
    cl_entities[3].lerpflags = 0;
    CL_EntityNum(3);
    assertEq(cl.num_entities, 4, "slots grow to the number");
    assertEq(
      cl_entities[2].lerpflags,
      LERP_RESETMOVE | LERP_RESETANIM,
      "skipped slot reset",
    );
    assertEq(
      cl_entities[3].lerpflags,
      LERP_RESETMOVE | LERP_RESETANIM,
      "new slot reset",
    );

    // An existing slot keeps its flags.
    cl_entities[3].lerpflags = LERP_MOVESTEP;
    CL_EntityNum(3);
    assertEq(
      cl_entities[3].lerpflags,
      LERP_MOVESTEP,
      "existing slot untouched",
    );

    // The muzzle flash stops the lerp for two pose changes, on the gun
    // for the view entity and on the entity itself otherwise.
    cl.viewentity = 2;
    cl.viewent.lerpflags = 0;
    CL_NoLerpMuzzleFlash(2);
    assertEq(
      cl.viewent.lerpflags,
      LERP_RESETANIM | LERP_RESETANIM2,
      "gun reset",
    );
    assertEq(
      cl_entities[2].lerpflags & LERP_RESETANIM2,
      0,
      "view entity itself untouched",
    );
    CL_NoLerpMuzzleFlash(3);
    assertEq(
      cl_entities[3].lerpflags,
      LERP_MOVESTEP | LERP_RESETANIM | LERP_RESETANIM2,
      "other entity reset",
    );
  } finally {
    cl.viewent.lerpflags = oldView;
    restoreClient(old);
  }
});
