// PROTOCOL_ICARO (1015, protocol.js): the wider fields the 2021 rerelease
// maps need, written by the server and read back by the real client parser.
// - coords are int32 eighths, so maps past +-4096 survive;
// - model indexes are shorts (MAX_MODELS 4096) in packet entities,
//   baselines, statics, clientdata and playerinfo;
// - sound indexes and entity numbers use Ironwail's SND_LARGE* flags;
// - packet entity numbers are 15 bits (MAX_EDICTS 32000);
// - entity alpha rides on packet entities, baselines, statics, playerinfo
//   (PF_ALPHA) and clientdata (SU_WEAPONALPHA);
// - frames above 255: PE_FRAME2, short baseline, static and playerinfo
//   frames, and SU_WEAPONFRAME2.
// NetQuake 15 (the shareware attract demos) must still parse.

// Bootstrap the client renderer graph in its established safe import order.
await import("../src/gl_rsurf.js");

const common = await import("../src/common.js");
const net = await import("../src/net.js");
const pak = await import("../src/pak.js");
const {
  MIN_EDICTS,
  MAX_EDICTS,
  MAX_MODELS,
  STAT_WEAPON,
  STAT_WEAPONFRAME,
  packet_entities_t,
} = await import("../src/quakedef.js");
const {
  PROTOCOL_VERSION,
  PROTOCOL_ICARO,
  svc_version,
  svc_spawnbaseline,
  svc_spawnstatic,
  svc_spawnstaticsound,
  svc_serversequence,
  svc_sound,
  svc_clientdata,
  SND_LARGEENTITY,
  SND_LARGESOUND,
  SU_WEAPON,
  SU_ITEMS,
  SU_WEAPONFRAME,
  SU_EXTEND1,
  SU_EXTEND2,
  SU_WEAPONFRAME2,
  SU_WEAPONALPHA,
  PF_ALPHA,
  ENTALPHA_DEFAULT,
  ENTALPHA_ZERO,
  ENTALPHA_ONE,
  ENTALPHA_ENCODE,
  ENTALPHA_DECODE,
  ENTALPHA_TOSAVE,
} = await import("../src/protocol.js");
const { cl, cls, cl_entities, cl_static_entities, scoreboard_t, SIGNONS } =
  await import("../src/client.js");
const { CL_ParseServerMessage } = await import("../src/cl_parse.js");
const { CL_GetEntityFrame, CL_GetPredictedPlayer, CL_ResetPrediction } =
  await import("../src/cl_pred.js");
const { cl_shownet } = await import("../src/cl_main.js");
const {
  PR_SetSV,
  PR_SetSVS,
  PR_SetHostError,
  sv: progs_sv,
  svs: progs_svs,
  edict_t,
  progs,
  pr_fielddefs,
  pr_global_struct,
  pr_strings_data,
  PR_SetProgs,
  PR_SetFieldDefs,
  PR_SetGlobalStruct,
  PR_SetStringsData,
} = await import("../src/progs.js");
const { PR_AllocEdicts, ED_Alloc, ED_Free } = await import(
  "../src/pr_edict.js"
);
const { sv, svs } = await import("../src/server.js");
const {
  SV_EmitPacketEntities,
  SV_WritePlayersToClient,
  SV_StartSound,
  SV_WriteClientdataToMessage,
  max_edicts,
} = await import("../src/sv_main.js");
const { sv_player, SV_SetPlayer } = await import("../src/sv_phys.js");
const consolejs = await import("../src/console.js");

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
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

function makeMsg(size) {
  const msg = new common.sizebuf_t();
  common.SZ_Alloc(msg, size);
  return msg;
}

// Run the client parser over one message: svc_version `protocol`, then
// whatever `write` puts in. Restores the client state it touches.
function clientParse(protocol, write, check) {
  const saved = {
    data: net.net_message.data,
    maxsize: net.net_message.maxsize,
    cursize: net.net_message.cursize,
    common: common.net_message,
    protocol: cl.protocol,
    signon: cls.signon,
    num_entities: cl.num_entities,
    entities: cl_entities.length,
    num_statics: cl.num_statics,
    maxclients: cl.maxclients,
    scores: cl.scores,
  };

  try {
    common.COM_SetNetMessage(net.net_message);
    net.net_message.data = new Uint8Array(8192);
    net.net_message.maxsize = 8192;
    common.SZ_Clear(net.net_message);
    common.MSG_WriteByte(net.net_message, svc_version);
    common.MSG_WriteLong(net.net_message, protocol);
    write(net.net_message);
    CL_ParseServerMessage();
    assertEqual(
      common.msg_readcount,
      net.net_message.cursize,
      "client read the whole message",
    );
    check();
  } finally {
    net.net_message.data = saved.data;
    net.net_message.maxsize = saved.maxsize;
    net.net_message.cursize = saved.cursize;
    common.COM_SetNetMessage(saved.common);
    cl.protocol = saved.protocol;
    common.MSG_SetCoord32(true);
    cls.signon = saved.signon;
    cl.num_entities = saved.num_entities;
    cl_entities.length = saved.entities;
    cl.num_statics = saved.num_statics;
    cl.maxclients = saved.maxclients;
    cl.scores = saved.scores;
    CL_ResetPrediction();
  }
}

function copyInto(dst, src) {
  common.SZ_Write(dst, src.data.subarray(0, src.cursize), src.cursize);
}

//=============================================================================

Deno.test("MSG_WriteCoord sends int32 eighths that read back past +-4096", () => {
  const cases = [
    0,
    4095.875,
    -4096,
    4096.125,
    5000.5,
    -12000.25,
    32767.875,
    -30000,
    100000,
  ];
  const msg = makeMsg(256);
  for (const f of cases) common.MSG_WriteCoord(msg, f);
  assertEqual(msg.cursize, cases.length * 4, "four bytes per coord");

  const saved = common.net_message;
  try {
    common.COM_SetNetMessage(msg);
    common.MSG_BeginReading();
    for (const f of cases) {
      assertEqual(common.MSG_ReadCoord(), f, `coord ${f}`);
    }

    // NetQuake 15: shorts
    common.SZ_Clear(msg);
    common.MSG_WriteCoord16(msg, -4096);
    common.MSG_WriteCoord16(msg, 4095.875);
    common.MSG_SetCoord32(false);
    common.MSG_BeginReading();
    assertEqual(common.MSG_ReadCoord(), -4096, "short coord");
    assertEqual(common.MSG_ReadCoord(), 4095.875, "short coord");
    assertEqual(common.msg_readcount, 4, "two bytes per short coord");
  } finally {
    common.MSG_SetCoord32(true);
    common.COM_SetNetMessage(saved);
  }
});

Deno.test("svc_version switches the client between NetQuake 15 and PROTOCOL_ICARO", () => {
  clientParse(PROTOCOL_VERSION, (m) => {
    // an id baseline: byte model, short coords, no alpha
    common.MSG_WriteByte(m, svc_spawnbaseline);
    common.MSG_WriteShort(m, 7);
    common.MSG_WriteByte(m, 200); // model
    common.MSG_WriteByte(m, 3); // frame
    common.MSG_WriteByte(m, 0); // colormap
    common.MSG_WriteByte(m, 1); // skin
    for (let i = 0; i < 3; i++) {
      common.MSG_WriteCoord16(m, -4000 + i);
      common.MSG_WriteAngle(m, 90);
    }

    // and back to PROTOCOL_ICARO in the same message
    common.MSG_WriteByte(m, svc_version);
    common.MSG_WriteLong(m, PROTOCOL_ICARO);
    common.MSG_WriteByte(m, svc_spawnbaseline);
    common.MSG_WriteShort(m, 9999);
    common.MSG_WriteShort(m, 3000); // model
    common.MSG_WriteShort(m, 300); // frame: a short (B_LARGEFRAME)
    common.MSG_WriteByte(m, 0);
    common.MSG_WriteByte(m, 2);
    for (let i = 0; i < 3; i++) {
      common.MSG_WriteCoord(m, 5000.5 * (i - 1));
      common.MSG_WriteAngle(m, 180);
    }
    common.MSG_WriteByte(m, ENTALPHA_ENCODE(0.5));
  }, () => {
    assertEqual(
      cl.protocol,
      PROTOCOL_ICARO,
      "protocol after the second svc_version",
    );
    const b7 = cl_entities[7].baseline;
    assertEqual(b7.modelindex, 200, "NQ baseline model");
    assertEqual(b7.frame, 3, "NQ baseline frame");
    assertEqual(b7.origin[2], -3998, "NQ baseline coord");
    assertEqual(b7.alpha, ENTALPHA_DEFAULT, "NQ baseline alpha");
    const b = cl_entities[9999].baseline;
    assertEqual(b.modelindex, 3000, "baseline model");
    assertEqual(b.frame, 300, "baseline frame");
    assertEqual(b.skin, 2, "baseline skin after the short frame");
    assertEqual(b.origin[0], -5000.5, "baseline coord");
    assertEqual(b.origin[2], 5000.5, "baseline coord");
    assertEqual(b.alpha, 128, "baseline alpha");
    assertEqual(cl.num_entities, 10000, "cl.num_entities");
  });
});

Deno.test("an unknown protocol is refused", () => {
  let error = null;
  try {
    clientParse(666, () => {}, () => {});
  } catch (e) {
    error = e;
  }

  if (error === null || !String(error.message).includes("protocol 666")) {
    throw new Error("expected a Host_Error for protocol 666, got " + error);
  }
});

Deno.test("svc_spawnstatic and svc_spawnstaticsound read short indexes, frames and alpha", () => {
  clientParse(PROTOCOL_ICARO, (m) => {
    // PF_makestatic's layout
    common.MSG_WriteByte(m, svc_spawnstatic);
    common.MSG_WriteShort(m, MAX_MODELS - 1);
    common.MSG_WriteShort(m, 777); // frame: a short
    common.MSG_WriteByte(m, 0);
    common.MSG_WriteByte(m, 1);
    for (let i = 0; i < 3; i++) {
      common.MSG_WriteCoord(m, -6000);
      common.MSG_WriteAngle(m, 0);
    }
    common.MSG_WriteByte(m, ENTALPHA_ENCODE(0.25));

    // PF_ambientsound's layout
    common.MSG_WriteByte(m, svc_spawnstaticsound);
    for (let i = 0; i < 3; i++) common.MSG_WriteCoord(m, 7000);
    common.MSG_WriteShort(m, 1500);
    common.MSG_WriteByte(m, 255);
    common.MSG_WriteByte(m, 64);
  }, () => {
    const ent = cl_static_entities[cl.num_statics - 1];
    assertEqual(ent.baseline.modelindex, MAX_MODELS - 1, "static model");
    assertEqual(ent.frame, 777, "static frame");
    assertEqual(ent.skinnum, 1, "static skin after the short frame");
    assertEqual(ent.origin[1], -6000, "static origin");
    assertEqual(ent.alpha, ENTALPHA_ENCODE(0.25), "static alpha");
  });
});

//=============================================================================
// packet entities

const NUMBERS = [1023, 1024, 8191, 9999, MAX_EDICTS - 1];

function fillPacket(p, alpha) {
  p.num_entities = NUMBERS.length;
  for (let i = 0; i < NUMBERS.length; i++) {
    const s = p.state(i);
    s.number = NUMBERS[i];
    s.modelindex = 256 + i * 900;
    s.frame = 7;
    s.origin[0] = 5000.5 + i;
    s.origin[1] = -12000.25;
    s.origin[2] = 30000 - i * 0.125;
    s.angles[1] = 90;
    s.alpha = alpha[i];
  }
}

function withServerEdicts(fn) {
  const oldSV = progs_sv;
  try {
    PR_SetSV({
      max_edicts: MAX_EDICTS,
      num_edicts: MAX_EDICTS,
      edicts: PR_AllocEdicts(64, 105),
    });
    fn();
  } finally {
    PR_SetSV(oldSV);
  }
}

Deno.test("packet entities carry 15-bit numbers, short models, wide coords and alpha", () => {
  withServerEdicts(() => {
    const first = new packet_entities_t();
    fillPacket(first, [0, 128, ENTALPHA_ZERO, ENTALPHA_ONE, 2]);
    const full = makeMsg(2048);
    SV_EmitPacketEntities({ delta_sequence: -1, frames: [] }, first, full);
    assertEqual(first.num_entities, NUMBERS.length, "server sent every entity");

    // the next frame deltas from the first: alpha changes alone on one
    // entity, another is removed
    const second = new packet_entities_t();
    fillPacket(second, [0, 200, ENTALPHA_ZERO, ENTALPHA_ONE, 2]);
    second.state(2).copyFrom(second.state(3));
    second.state(3).copyFrom(second.state(4));
    second.num_entities = 4; // 8191 is gone
    const frames = [];
    for (let i = 0; i < 64; i++) {
      frames.push({ entities: new packet_entities_t() });
    }
    frames[10].entities = first;
    const delta = makeMsg(2048);
    SV_EmitPacketEntities(
      { delta_sequence: 10, outgoing_sequence: 11, frames },
      second,
      delta,
    );

    clientParse(PROTOCOL_ICARO, (m) => {
      cls.signon = SIGNONS;
      common.MSG_WriteByte(m, svc_serversequence);
      common.MSG_WriteLong(m, 10);
      copyInto(m, full);
      common.MSG_WriteByte(m, svc_serversequence);
      common.MSG_WriteLong(m, 11);
      copyInto(m, delta);
    }, () => {
      const a = CL_GetEntityFrame(10).packet_entities;
      assertEqual(a.num_entities, NUMBERS.length, "full update entity count");
      for (let i = 0; i < NUMBERS.length; i++) {
        const s = a.entities[i], w = first.entities[i];
        assertEqual(s.number, w.number, `number ${i}`);
        assertEqual(s.modelindex, w.modelindex, `model ${i}`);
        assertEqual(s.origin[0], w.origin[0], `origin x ${i}`);
        assertEqual(s.origin[1], w.origin[1], `origin y ${i}`);
        assertEqual(s.origin[2], w.origin[2], `origin z ${i}`);
        assertEqual(s.alpha, w.alpha, `alpha ${i}`);
      }

      const b = CL_GetEntityFrame(11).packet_entities;
      assertEqual(b.num_entities, 4, "delta entity count");
      assertEqual(
        [...Array(4).keys()].map((i) => b.entities[i].number).join(","),
        [1023, 1024, 9999, MAX_EDICTS - 1].join(","),
        "delta numbers",
      );
      assertEqual(b.entities[1].alpha, 200, "alpha-only change");
      assertEqual(b.entities[1].origin[0], 5001.5, "unchanged origin kept");
      assertEqual(
        b.entities[3].modelindex,
        256 + 4 * 900,
        "unchanged model kept",
      );
      if (cl_entities.length < MAX_EDICTS) {
        throw new Error(
          `cl_entities did not grow to ${MAX_EDICTS}: ${cl_entities.length}`,
        );
      }
    });
  });
});

Deno.test("packet entities send frames above 255 with PE_FRAME2", () => {
  withServerEdicts(() => {
    const FIRST = [300, 7, 1000, 255, 256];
    // 300 -> 44 has the same low byte: PE_FRAME alone must clear the
    // high byte. 7 is unchanged, so 1023's frame isn't sent at all.
    const SECOND = [44, 7, 1001, 256, 4095];

    const first = new packet_entities_t();
    fillPacket(first, [0, 0, 0, 0, 0]);
    for (let i = 0; i < FIRST.length; i++) first.state(i).frame = FIRST[i];
    const full = makeMsg(2048);
    SV_EmitPacketEntities({ delta_sequence: -1, frames: [] }, first, full);

    const second = new packet_entities_t();
    fillPacket(second, [0, 0, 0, 0, 0]);
    for (let i = 0; i < SECOND.length; i++) second.state(i).frame = SECOND[i];
    const frames = [];
    for (let i = 0; i < 64; i++) {
      frames.push({ entities: new packet_entities_t() });
    }
    frames[20].entities = first;
    const delta = makeMsg(2048);
    SV_EmitPacketEntities(
      { delta_sequence: 20, outgoing_sequence: 21, frames },
      second,
      delta,
    );

    clientParse(PROTOCOL_ICARO, (m) => {
      cls.signon = SIGNONS;
      common.MSG_WriteByte(m, svc_serversequence);
      common.MSG_WriteLong(m, 20);
      copyInto(m, full);
      common.MSG_WriteByte(m, svc_serversequence);
      common.MSG_WriteLong(m, 21);
      copyInto(m, delta);
    }, () => {
      const a = CL_GetEntityFrame(20).packet_entities;
      const b = CL_GetEntityFrame(21).packet_entities;
      for (let i = 0; i < FIRST.length; i++) {
        assertEqual(a.entities[i].frame, FIRST[i], `full frame ${i}`);
        assertEqual(b.entities[i].frame, SECOND[i], `delta frame ${i}`);
        assertEqual(
          b.entities[i].origin[1],
          -12000.25,
          `origin after the frame ${i}`,
        );
      }
    });
  });
});

Deno.test("ED_Alloc grows sv.edicts past its initial size and ED_Free resets alpha", () => {
  const oldSV = progs_sv;
  const oldSVS = progs_svs;
  try {
    const s = {
      max_edicts: 2000,
      num_edicts: 2,
      time: 0,
      edicts: PR_AllocEdicts(8, 105),
    };
    PR_SetSV(s);
    PR_SetSVS({ maxclients: 1 });
    let last = null;
    for (let i = 0; i < 1030; i++) last = ED_Alloc();
    assertEqual(s.num_edicts, 1032, "num_edicts after 1030 allocations");
    assertEqual(last.index, 1031, "last allocated edict number");
    assertEqual(s.edicts[1031], last, "edict stored at its number");
    // C's fixed array always has the edict after the last one
    if (s.edicts.length < 1033) {
      throw new Error(
        `NEXT_EDICT of the last edict is missing: ${s.edicts.length}`,
      );
    }

    last.alpha = 128;
    ED_Free(last);
    assertEqual(last.alpha, ENTALPHA_DEFAULT, "ED_Free resets alpha");

    // Ironwail's message names the cvar that raises the cap
    s.max_edicts = s.num_edicts;
    assertEqual(ED_Alloc(), last, "the freed edict is reused first");
    let error = null;
    const oldHostError = PR_SetHostError((m) => {
      throw new Error(m);
    });
    try {
      ED_Alloc();
    } catch (e) {
      error = e;
    } finally {
      PR_SetHostError(oldHostError);
    }

    if (
      error === null || !String(error.message).includes("max_edicts is 1032")
    ) {
      throw new Error(
        'expected "no free edicts (max_edicts is 1032)", got ' + error,
      );
    }
  } finally {
    PR_SetSV(oldSV);
    PR_SetSVS(oldSVS);
  }
});

Deno.test("max_edicts is Ironwail's cvar, with its default and bounds", () => {
  assertEqual(max_edicts.name, "max_edicts", "cvar name");
  assertEqual(max_edicts.string, "16384", "Ironwail default");
  assertEqual(max_edicts.archive, false, "not archived (ericw)");
  assertEqual(MIN_EDICTS, 256, "MIN_EDICTS");
  assertEqual(MAX_EDICTS, 32000, "MAX_EDICTS");
});

//=============================================================================
// sounds, clientdata and playerinfo

Deno.test("svc_sound uses SND_LARGEENTITY and SND_LARGESOUND past 8191 and 255", () => {
  const oldProgsSV = progs_sv;
  const oldPrecache = sv.sound_precache;
  const oldNum = sv.num_edicts;
  const oldMax = sv.max_edicts;
  const savedDatagram = {
    data: sv.datagram.data,
    maxsize: sv.datagram.maxsize,
    cursize: sv.datagram.cursize,
  };
  const savedShownet = cl_shownet.value;
  const savedClPrecache = cl.sound_precache[1300];

  try {
    PR_SetSV(sv);
    sv.num_edicts = 9001;
    sv.max_edicts = MAX_EDICTS;
    // SV_StartSound's lookup stops at the first empty slot
    sv.sound_precache = new Array(2048).fill(null);
    for (let i = 1; i < 1300; i++) sv.sound_precache[i] = "test/s" + i + ".wav";
    sv.sound_precache[1300] = "test/large.wav";
    sv.datagram.data = new Uint8Array(256);
    sv.datagram.maxsize = 256;
    sv.datagram.cursize = 0;

    const entity = new edict_t(9000, 105);
    entity.v.origin[0] = 6000;
    SV_StartSound(entity, 5, "test/large.wav", 255, 1);
    assertEqual(sv.datagram.data[0], svc_sound, "svc_sound written");
    assertEqual(
      sv.datagram.data[1],
      SND_LARGEENTITY | SND_LARGESOUND,
      "field mask",
    );

    cl.sound_precache[1300] = { name: "test/large.wav" };
    cl_shownet.value = 2; // CL_ParseStartSoundPacket prints what it parsed
    printed.length = 0;
    clientParse(PROTOCOL_ICARO, (m) => copyInto(m, sv.datagram), () => {});
    const line = printed.find((s) => s.startsWith("svc_sound:"));
    assertEqual(
      line,
      "svc_sound: test/large.wav (num=1300 ent=9000 ch=5)\n",
      "parsed sound",
    );
  } finally {
    PR_SetSV(oldProgsSV);
    sv.sound_precache = oldPrecache;
    sv.num_edicts = oldNum;
    sv.max_edicts = oldMax;
    sv.datagram.data = savedDatagram.data;
    sv.datagram.maxsize = savedDatagram.maxsize;
    sv.datagram.cursize = savedDatagram.cursize;
    cl_shownet.value = savedShownet;
    cl.sound_precache[1300] = savedClPrecache;
  }
});

// The server side (a short weapon field) is in sv_main_test.js
Deno.test("clientdata SU_WEAPON is a short under PROTOCOL_ICARO and a byte under 15", () => {
  const savedWeapon = cl.stats[STAT_WEAPON];
  const write = (m, short, model) => {
    common.MSG_WriteByte(m, svc_clientdata);
    common.MSG_WriteShort(m, SU_ITEMS | SU_WEAPON);
    common.MSG_WriteLong(m, 1); // items
    if (short) common.MSG_WriteShort(m, model);
    else common.MSG_WriteByte(m, model);
    common.MSG_WriteShort(m, 100); // health
    for (let i = 0; i < 6; i++) common.MSG_WriteByte(m, 0); // ammo, 4 ammo counts, activeweapon
  };

  try {
    clientParse(
      PROTOCOL_ICARO,
      (m) => write(m, true, 3000),
      () => assertEqual(cl.stats[STAT_WEAPON], 3000, "ICARO weapon model"),
    );
    clientParse(
      PROTOCOL_VERSION,
      (m) => write(m, false, 200),
      () => assertEqual(cl.stats[STAT_WEAPON], 200, "NQ weapon model"),
    );
  } finally {
    cl.stats[STAT_WEAPON] = savedWeapon;
  }
});

Deno.test("svc_playerinfo carries a short model index and wide coords", () => {
  const oldClients = svs.clients;
  const oldMaxclients = svs.maxclients;
  const oldPrecache = sv.model_precache;
  const oldTime = sv.time;
  const edicts = PR_AllocEdicts(3, 105);

  try {
    sv.model_precache = ["", "progs/player.mdl"];
    sv.time = 1;
    svs.maxclients = 1;
    const ent = edicts[1];
    ent.v.modelindex = 3001;
    ent.v.health = 100;
    ent.v.origin[0] = -7000.5;
    ent.v.origin[1] = 9000;
    svs.clients = [{ active: true, spawned: true, edict: ent, localtime: 0 }];
    const msg = makeMsg(200);
    SV_WritePlayersToClient(svs.clients[0], ent, new Uint8Array([1]), msg);

    clientParse(PROTOCOL_ICARO, (m) => {
      cl.maxclients = 1;
      copyInto(m, msg);
    }, () => {
      const p = CL_GetPredictedPlayer(0);
      assertEqual(p.modelindex, 3001, "player model");
      assertEqual(p.origin[0], -7000.5, "player origin x");
      assertEqual(p.origin[1], 9000, "player origin y");
    });
  } finally {
    svs.clients = oldClients;
    svs.maxclients = oldMaxclients;
    sv.model_precache = oldPrecache;
    sv.time = oldTime;
  }
});

// SV_WriteClientdataToMessage needs a progs: no fields, an empty string
// table, serverflags 0 (as sv_main_test.js sets up)
function withClientdataProgs(ent, fn) {
  const saved = {
    progs,
    fielddefs: pr_fielddefs,
    globals: pr_global_struct,
    strings: pr_strings_data,
    player: sv_player,
    precache: sv.model_precache,
  };
  try {
    PR_SetProgs({ numfielddefs: 0 });
    PR_SetFieldDefs([]);
    PR_SetStringsData(new TextEncoder().encode("\0"));
    PR_SetGlobalStruct({ serverflags: 0 });
    sv.model_precache = [""];
    SV_SetPlayer(ent);
    fn();
  } finally {
    PR_SetProgs(saved.progs);
    PR_SetFieldDefs(saved.fielddefs);
    PR_SetGlobalStruct(saved.globals);
    PR_SetStringsData(saved.strings);
    sv.model_precache = saved.precache;
    SV_SetPlayer(saved.player);
  }
}

Deno.test("clientdata SU_WEAPONFRAME2 and SU_WEAPONALPHA ride on SU_EXTEND1 and SU_EXTEND2", () => {
  const ent = new edict_t(1, 105);
  ent.v.view_ofs[2] = 22; // DEFAULT_VIEWHEIGHT
  const savedFrame = cl.stats[STAT_WEAPONFRAME];
  const savedAlpha = cl.viewent.alpha;

  const write = (weaponframe, alpha) => {
    ent.v.weaponframe = weaponframe;
    ent.alpha = alpha;
    const msg = makeMsg(64);
    withClientdataProgs(ent, () => SV_WriteClientdataToMessage(ent, msg));
    return msg;
  };

  try {
    // 513: SU_WEAPONFRAME2 (bit 24) needs both extend bytes
    const wide = write(513, 128);
    const bits = wide.data[1] | (wide.data[2] << 8);
    assertEqual(
      bits & (SU_EXTEND1 | SU_WEAPONFRAME | SU_WEAPON),
      SU_EXTEND1 | SU_WEAPONFRAME | SU_WEAPON,
      "short bits",
    );
    assertEqual(wide.data[3], (SU_EXTEND2 >> 16) & 0xFF, "first extend byte");
    assertEqual(
      wide.data[4],
      (SU_WEAPONFRAME2 | SU_WEAPONALPHA) >>> 24,
      "second extend byte",
    );
    clientParse(PROTOCOL_ICARO, (m) => copyInto(m, wide), () => {
      assertEqual(cl.stats[STAT_WEAPONFRAME], 513, "weaponframe high byte");
      assertEqual(cl.viewent.alpha, 128, "view model alpha");
    });

    // an opaque player and a byte frame: no extend bytes, and the view
    // model goes back to ENTALPHA_DEFAULT
    const narrow = write(3, ENTALPHA_DEFAULT);
    assertEqual(narrow.data[2] & 0x80, 0, "no SU_EXTEND1");
    clientParse(PROTOCOL_ICARO, (m) => copyInto(m, narrow), () => {
      assertEqual(cl.stats[STAT_WEAPONFRAME], 3, "weaponframe");
      assertEqual(cl.viewent.alpha, ENTALPHA_DEFAULT, "view model alpha reset");
    });

    // alpha alone (bit 25) still needs SU_EXTEND1 before SU_EXTEND2
    const alphaOnly = write(0, ENTALPHA_ONE);
    clientParse(PROTOCOL_ICARO, (m) => copyInto(m, alphaOnly), () => {
      assertEqual(cl.stats[STAT_WEAPONFRAME], 0, "no weaponframe");
      assertEqual(cl.viewent.alpha, ENTALPHA_ONE, "alpha alone");
    });
  } finally {
    cl.stats[STAT_WEAPONFRAME] = savedFrame;
    cl.viewent.alpha = savedAlpha;
  }
});

Deno.test("svc_playerinfo carries short frames and PF_ALPHA", () => {
  const oldClients = svs.clients;
  const oldMaxclients = svs.maxclients;
  const oldPrecache = sv.model_precache;
  const oldTime = sv.time;
  const edicts = PR_AllocEdicts(4, 105);

  try {
    sv.model_precache = ["", "progs/player.mdl"];
    sv.time = 1;
    svs.maxclients = 2;
    const self = edicts[1], other = edicts[2];
    for (const e of [self, other]) {
      e.v.modelindex = 1;
      e.v.health = 100;
      e.v.mins[2] = -24;
    }
    self.v.frame = 400;
    self.v.weaponframe = 600;
    self.alpha = 64;
    other.v.frame = 12;
    svs.clients = [
      { active: true, spawned: true, edict: self, localtime: 0 },
      { active: true, spawned: true, edict: other, localtime: 0 },
    ];
    other.num_leafs = 1;
    other.leafnums[0] = 0;
    const msg = makeMsg(400);
    SV_WritePlayersToClient(svs.clients[0], self, new Uint8Array([1]), msg);
    const flags = msg.data[2] | (msg.data[3] << 8);
    assertEqual(
      flags & PF_ALPHA,
      PF_ALPHA,
      "PF_ALPHA on the translucent player",
    );

    clientParse(PROTOCOL_ICARO, (m) => {
      cl.maxclients = 2;
      copyInto(m, msg);
    }, () => {
      const p = CL_GetPredictedPlayer(0);
      assertEqual(p.frame, 400, "player frame");
      assertEqual(p.weaponframe, 600, "player weaponframe");
      assertEqual(p.alpha, 64, "player alpha");
      const q = CL_GetPredictedPlayer(1);
      assertEqual(q.frame, 12, "other frame");
      assertEqual(q.alpha, ENTALPHA_DEFAULT, "other alpha");
    });
  } finally {
    svs.clients = oldClients;
    svs.maxclients = oldMaxclients;
    sv.model_precache = oldPrecache;
    sv.time = oldTime;
  }
});

//=============================================================================

Deno.test("ENTALPHA_ENCODE / DECODE / TOSAVE match Ironwail", () => {
  assertEqual(ENTALPHA_ENCODE(0), ENTALPHA_DEFAULT, "encode 0");
  assertEqual(ENTALPHA_ENCODE(1), ENTALPHA_ONE, "encode 1");
  assertEqual(ENTALPHA_ENCODE(0.5), 128, "encode 0.5");
  assertEqual(
    ENTALPHA_ENCODE(-1),
    ENTALPHA_ZERO,
    "encode -1 (a saved ENTALPHA_ZERO)",
  );
  assertEqual(ENTALPHA_ENCODE(2), ENTALPHA_ONE, "encode clamps");
  assertEqual(ENTALPHA_DECODE(ENTALPHA_DEFAULT), 1, "decode default");
  assertEqual(ENTALPHA_DECODE(ENTALPHA_ZERO), 0, "decode zero");
  assertEqual(ENTALPHA_TOSAVE(ENTALPHA_ZERO), -1, "tosave zero");
  assertEqual(ENTALPHA_ENCODE(ENTALPHA_TOSAVE(128)), 128, "save round trip");
});

//=============================================================================
// The shareware attract demo, recorded with NetQuake 15

Deno.test("demo1.dem (protocol 15) parses message by message", async () => {
  await pak.COM_AddPakSequence(
    new URL("../static/pak0.pak", import.meta.url).pathname,
  );
  const file = pak.COM_FindFile("demo1.dem");
  const data = file.data.subarray(0, file.size);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  // the cd track line
  let pos = 0;
  while (data[pos] !== 10) pos++;
  pos++;

  const saved = {
    data: net.net_message.data,
    maxsize: net.net_message.maxsize,
    cursize: net.net_message.cursize,
    common: common.net_message,
    demoplayback: cls.demoplayback,
    demonum: cls.demonum,
    message: {
      data: cls.message.data,
      maxsize: cls.message.maxsize,
      cursize: cls.message.cursize,
      allowoverflow: cls.message.allowoverflow,
    },
    signon: cls.signon,
    protocol: cl.protocol,
    maxclients: cl.maxclients,
    scores: cl.scores,
    num_entities: cl.num_entities,
    num_statics: cl.num_statics,
  };

  let messages = 0;
  let ended = null;
  try {
    common.COM_SetNetMessage(net.net_message);
    net.net_message.data = new Uint8Array(65536);
    net.net_message.maxsize = 65536;
    cls.demoplayback = true;
    cls.demonum = -1;
    common.SZ_Alloc(cls.message, 8192);
    cls.message.allowoverflow = true;

    while (pos + 16 <= data.length) {
      const len = view.getInt32(pos, true);
      pos += 16; // length and view angles
      let msg = data.subarray(pos, pos + len);
      pos += len;

      // CL_ParseServerInfo loads the map and builds the renderer's
      // world, which the headless shim can't. Read the serverinfo here
      // and hand the parser svc_version 15 in its place.
      if (messages === 0) msg = replaceServerinfo(msg);

      net.net_message.data.set(msg, 0);
      net.net_message.cursize = msg.length;
      try {
        CL_ParseServerMessage();
      } catch (e) {
        ended = e;
        break;
      }

      assertEqual(
        common.msg_readcount,
        msg.length,
        `message ${messages} read length`,
      );
      assertEqual(cl.protocol, PROTOCOL_VERSION, "protocol");
      messages++;
    }
  } finally {
    net.net_message.data = saved.data;
    net.net_message.maxsize = saved.maxsize;
    net.net_message.cursize = saved.cursize;
    common.COM_SetNetMessage(saved.common);
    cls.demoplayback = saved.demoplayback;
    cls.demonum = saved.demonum;
    Object.assign(cls.message, saved.message);
    cls.signon = saved.signon;
    cl.protocol = saved.protocol;
    cl.maxclients = saved.maxclients;
    cl.scores = saved.scores;
    cl.num_entities = saved.num_entities;
    cl.num_statics = saved.num_statics;
    common.MSG_SetCoord32(true);
    CL_ResetPrediction();
  }

  // the demo ends with svc_disconnect
  if (
    ended === null || !String(ended.message).includes("Server disconnected")
  ) {
    throw new Error(`demo stopped at message ${messages}: ${ended}`);
  }
  if (messages < 100) throw new Error(`only ${messages} messages`);
  assertEqual(pos, data.length, "every message was read");
});

// The first demo message is svc_serverinfo and the signon that follows it.
// Returns svc_version 15 plus the rest, and sets what CL_ParseServerInfo would.
function replaceServerinfo(msg) {
  let p = 0;
  if (msg[p++] !== 11) {
    throw new Error("demo1 does not start with svc_serverinfo");
  }
  const version = msg[p] | (msg[p + 1] << 8) | (msg[p + 2] << 16) |
    (msg[p + 3] << 24);
  assertEqual(version, PROTOCOL_VERSION, "demo protocol");
  p += 4;
  cl.maxclients = msg[p++];
  cl.scores = [];
  for (let i = 0; i < cl.maxclients; i++) cl.scores.push(new scoreboard_t());
  p++; // gametype
  while (msg[p] !== 0) p++; // level name
  p++;
  for (let list = 0; list < 2; list++) { // model, then sound precaches
    while (msg[p] !== 0) {
      while (msg[p] !== 0) p++;
      p++;
    }
    p++;
  }

  const out = new Uint8Array(5 + msg.length - p);
  out[0] = svc_version;
  new DataView(out.buffer).setInt32(1, PROTOCOL_VERSION, true);
  out.set(msg.subarray(p), 5);
  return out;
}
