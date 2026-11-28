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
// NetQuake 15 (the shareware attract demos) must still parse, and so must
// FitzQuake 666 and RMQ 999 (Ironwail's demos), which the client only reads.

import { TD_Mount } from "./test_data.js";

// Bootstrap the client renderer graph in its established safe import order.
await import("../src/gl_rsurf.js");

const common = await import("../src/common.js");
const net = await import("../src/net.js");
const pak = await import("../src/pak.js");
const {
  MIN_EDICTS,
  MAX_EDICTS,
  MAX_MODELS,
  STAT_AMMO,
  STAT_ARMOR,
  STAT_CELLS,
  STAT_NAILS,
  STAT_ROCKETS,
  STAT_SHELLS,
  STAT_WEAPON,
  STAT_WEAPONFRAME,
  packet_entities_t,
} = await import("../src/quakedef.js");
const {
  PROTOCOL_VERSION,
  PROTOCOL_ICARO,
  PROTOCOL_FITZQUAKE,
  PROTOCOL_RMQ,
  ICARO_REVISION,
  svc_icaro_ext,
  svc_playerinfo,
  svc_packetentities,
  svc_deltapacketentities,
  svc_playerinfo_rev0,
  svc_packetentities_rev0,
  svc_deltapacketentities_rev0,
  svc_serversequence_rev0,
  svc_print,
  clc_delta,
  clc_icaro_ext,
  clc_nop,
  PRFL_SHORTANGLE,
  PRFL_FLOATANGLE,
  PRFL_24BITCOORD,
  PRFL_FLOATCOORD,
  PRFL_INT32COORD,
  B_LARGEMODEL,
  B_LARGEFRAME,
  B_ALPHA,
  B_SCALE,
  U_MOREBITS,
  U_ORIGIN1,
  U_ANGLE2,
  U_FRAME,
  U_MODEL,
  U_LONGENTITY,
  U_EXTEND1,
  U_ALPHA,
  U_FRAME2,
  U_MODEL2,
  U_LERPFINISH,
  U_SCALE,
  svc_skybox,
  svc_bf,
  svc_fog,
  svc_spawnbaseline2,
  svc_spawnstatic2,
  svc_spawnstaticsound2,
  SU_ARMOR,
  SU_WEAPON2,
  SU_ARMOR2,
  SU_AMMO2,
  SU_SHELLS2,
  SU_NAILS2,
  SU_ROCKETS2,
  SU_CELLS2,
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
  ENTSCALE_DEFAULT,
} = await import("../src/protocol.js");
const { cl, cls, cl_entities, cl_static_entities, scoreboard_t, SIGNONS } =
  await import("../src/client.js");
const { CL_ParseServerMessage, CL_SetProtocol, cl_icaro } = await import(
  "../src/cl_parse.js"
);
const { LERP_FINISH } = await import("../src/render.js");
const { Fog_GetState, Fog_Update } = await import("../src/gl_fog.js");
const { Sky_GetSkyBox, Sky_LoadSkyBox } = await import("../src/gl_sky.js");
const { V_Init } = await import("../src/view.js");
const { CSHIFT_BONUS } = await import("../src/client.js");
const { Cvar_FindVar } = await import("../src/cvar.js");
const {
  CL_GetEntityFrame,
  CL_GetPredictedPlayer,
  CL_GetServerSequence,
  CL_ResetPrediction,
} = await import("../src/cl_pred.js");
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
const sv_phys = await import("../src/sv_phys.js");
const { sv_player, SV_SetPlayer } = sv_phys;
const { SV_ReadClientMessage, SV_User_SetCallbacks } = await import(
  "../src/sv_user.js"
);
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
// whatever `write` puts in, starting from that protocol's reader (Icaro's,
// at `revision`, if the client can't read it). `flags` are the PRFL_* flags
// svc_serverinfo would have set (svc_version keeps them). Restores the
// client state it touches.
function clientParse(
  protocol,
  write,
  check,
  flags = 0,
  revision = ICARO_REVISION,
) {
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
    net.net_message.data = new Uint8Array(net.NET_MAXMESSAGE);
    net.net_message.maxsize = net.NET_MAXMESSAGE;
    common.SZ_Clear(net.net_message);
    if (CL_SetProtocol(protocol, flags, revision) === false) {
      CL_SetProtocol(PROTOCOL_ICARO, flags, revision);
    }
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
    CL_SetProtocol(PROTOCOL_ICARO, 0);
    cl.protocol = saved.protocol;
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
    common.MSG_SetCoordModes(common.MSG_COORD_16, common.MSG_ANGLE_8);
    common.MSG_BeginReading();
    assertEqual(common.MSG_ReadCoord(), -4096, "short coord");
    assertEqual(common.MSG_ReadCoord(), 4095.875, "short coord");
    assertEqual(common.msg_readcount, 4, "two bytes per short coord");
  } finally {
    common.MSG_SetCoordModes(common.MSG_COORD_INT32_8, common.MSG_ANGLE_8);
    common.COM_SetNetMessage(saved);
  }
});

Deno.test("svc_version switches the client from NetQuake 15 to PROTOCOL_ICARO", () => {
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
    clientParse(1234, () => {}, () => {});
  } catch (e) {
    error = e;
  }

  if (error === null || !String(error.message).includes("protocol 1234")) {
    throw new Error("expected a Host_Error for protocol 1234, got " + error);
  }
});

Deno.test("CL_SetProtocol refuses an unknown protocol and keeps the reader", () => {
  const savedProtocol = cl.protocol;
  try {
    if (CL_SetProtocol(PROTOCOL_VERSION, 0) !== true) {
      throw new Error("protocol 15 refused");
    }
    assertEqual(common.msg_coordmode, common.MSG_COORD_16, "15: short coords");
    assertEqual(CL_SetProtocol(1234, 0), false, "unknown protocol");
    assertEqual(cl.protocol, PROTOCOL_VERSION, "cl.protocol unchanged");
    assertEqual(common.msg_coordmode, common.MSG_COORD_16, "modes unchanged");
    if (CL_SetProtocol(PROTOCOL_ICARO, 0) !== true) {
      throw new Error("PROTOCOL_ICARO refused");
    }
    assertEqual(
      common.msg_coordmode,
      common.MSG_COORD_INT32_8,
      "Icaro: int32 eighths",
    );
    assertEqual(common.msg_anglemode, common.MSG_ANGLE_8, "byte angles");
  } finally {
    CL_SetProtocol(PROTOCOL_ICARO, 0);
    cl.protocol = savedProtocol;
  }
});

/** Throws unless parsing `write` under `protocol` is a Host_Error with `text` */
function expectParseError(protocol, revision, write, text, what) {
  let error = null;
  try {
    clientParse(protocol, write, () => {}, 0, revision);
  } catch (e) {
    error = e;
  }
  if (error === null || !String(error.message).includes(text)) {
    throw new Error(`${what}: expected "${text}", got ${error}`);
  }
}

Deno.test("Icaro's own svcs are illegible under protocol 15", () => {
  for (const svc of [96, 97, 98, 99, 127, 42, 47, 48, 49]) {
    expectParseError(
      PROTOCOL_VERSION,
      ICARO_REVISION,
      (m) => {
        common.MSG_WriteByte(m, svc);
        common.MSG_WriteLong(m, 0);
      },
      "Illegible",
      `svc ${svc} under 15`,
    );
  }

  // and svc_serversequence still parses under PROTOCOL_ICARO
  clientParse(PROTOCOL_ICARO, (m) => {
    common.MSG_WriteByte(m, svc_serversequence);
    common.MSG_WriteLong(m, 1234);
  }, () => {});
});

Deno.test("revision 1 moves Icaro's svcs to 96 to 99; revision 0 keeps 42 and 47 to 49", () => {
  assertEqual(svc_playerinfo, 96, "svc_playerinfo");
  assertEqual(svc_packetentities, 97, "svc_packetentities");
  assertEqual(svc_deltapacketentities, 98, "svc_deltapacketentities");
  assertEqual(svc_serversequence, 99, "svc_serversequence");
  assertEqual(svc_icaro_ext, 127, "svc_icaro_ext");

  // the old numbers are the 2021 rerelease's and FitzQuake's under revision 1
  for (const svc of [42, 47, 48, 49]) {
    expectParseError(
      PROTOCOL_ICARO,
      1,
      (m) => {
        common.MSG_WriteByte(m, svc);
        common.MSG_WriteLong(m, 0);
      },
      "Illegible",
      `svc ${svc} under revision 1`,
    );
  }

  // and Icaro's under revision 0 (old demos); 96 to 127 aren't
  const pairs = [
    [svc_serversequence_rev0, svc_serversequence],
    [svc_packetentities_rev0, svc_packetentities],
    [svc_deltapacketentities_rev0, svc_deltapacketentities],
    [svc_playerinfo_rev0, svc_playerinfo],
  ];
  assertEqual(pairs[0][0], 49, "revision 0 svc_serversequence");
  clientParse(
    PROTOCOL_ICARO,
    (m) => {
      common.MSG_WriteByte(m, svc_serversequence_rev0);
      common.MSG_WriteLong(m, 4321);
    },
    () => {
      assertEqual(CL_GetServerSequence(), 4321, "revision 0 sequence");
    },
    0,
    0,
  );
  for (const [, svc] of pairs) {
    expectParseError(
      PROTOCOL_ICARO,
      0,
      (m) => {
        common.MSG_WriteByte(m, svc);
        common.MSG_WriteLong(m, 0);
      },
      "Illegible",
      `svc ${svc} under revision 0`,
    );
  }
  expectParseError(
    PROTOCOL_ICARO,
    0,
    (m) => {
      common.MSG_WriteByte(m, svc_icaro_ext);
      common.MSG_WriteLong(m, 0);
    },
    "Illegible",
    "svc_icaro_ext under revision 0",
  );
});

Deno.test("svc_version under revision 1 must name 1015; revision 0 keeps Ironwail's switch", () => {
  expectParseError(
    PROTOCOL_ICARO,
    1,
    (m) => {
      common.MSG_WriteByte(m, svc_version);
      common.MSG_WriteLong(m, PROTOCOL_VERSION);
    },
    "protocol 15 instead of 1015",
    "svc_version 15 under revision 1",
  );

  // 1015 is accepted and keeps the revision
  clientParse(PROTOCOL_ICARO, (m) => {
    common.MSG_WriteByte(m, svc_version);
    common.MSG_WriteLong(m, PROTOCOL_ICARO);
    common.MSG_WriteByte(m, svc_serversequence);
    common.MSG_WriteLong(m, 77);
  }, () => {
    assertEqual(cl_icaro.revision, 1, "revision kept");
    assertEqual(CL_GetServerSequence(), 77, "revision 1 sequence");
  });

  // revision 0: svc_version 1015 keeps revision 0's numbers
  clientParse(
    PROTOCOL_ICARO,
    (m) => {
      common.MSG_WriteByte(m, svc_version);
      common.MSG_WriteLong(m, PROTOCOL_ICARO);
      common.MSG_WriteByte(m, svc_serversequence_rev0);
      common.MSG_WriteLong(m, 78);
    },
    () => {
      assertEqual(cl_icaro.revision, 0, "revision 0 kept");
      assertEqual(CL_GetServerSequence(), 78, "revision 0 sequence");
    },
    0,
    0,
  );

  // and may switch to 15, as before
  clientParse(
    PROTOCOL_ICARO,
    (m) => {
      common.MSG_WriteByte(m, svc_version);
      common.MSG_WriteLong(m, PROTOCOL_VERSION);
    },
    () => {
      assertEqual(cl.protocol, PROTOCOL_VERSION, "revision 0 to 15");
    },
    0,
    0,
  );
});

Deno.test("svc_icaro_ext is skipped by its length, mid-message", () => {
  for (
    const [id, length] of [[0, 0], [0x0001, 3], [0x8000, 300], [0xffff, 40000]]
  ) {
    printed.length = 0;
    clientParse(PROTOCOL_ICARO, (m) => {
      common.MSG_WriteByte(m, svc_icaro_ext);
      common.MSG_WriteShort(m, id);
      common.MSG_WriteShort(m, length);
      for (let i = 0; i < length; i++) {
        // bytes that would misparse as svcs if the reader didn't skip them
        common.MSG_WriteByte(m, i % 2 === 0 ? svc_print : 255);
      }
      common.MSG_WriteByte(m, svc_print);
      common.MSG_WriteString(m, "after\n");
    }, () => {
      assertEqual(printed.join(""), "after\n", `ext ${id}: next svc read`);
    });
  }
});

/**
 * Runs SV_ReadClientMessage over one client message holding what `write`
 * puts in. Returns [its result, the client].
 */
function serverRead(write) {
  const saved = {
    data: net.net_message.data,
    maxsize: net.net_message.maxsize,
    cursize: net.net_message.cursize,
    common: common.net_message,
  };
  const savedState = [sv_phys.sv, sv_phys.svs, sv_phys.pr_global_struct];
  const client = { active: true, netconnection: {}, delta_sequence: 0 };
  let pending = 1;
  try {
    sv_phys.SV_SetState(sv, svs, savedState[2]); // for sv.time
    common.COM_SetNetMessage(net.net_message);
    net.net_message.data = new Uint8Array(net.NET_MAXMESSAGE);
    net.net_message.maxsize = net.NET_MAXMESSAGE;
    common.SZ_Clear(net.net_message);
    write(net.net_message);
    SV_User_SetCallbacks({
      host_client: client,
      NET_GetMessage: () => pending--,
    });
    return [SV_ReadClientMessage(), client];
  } finally {
    net.net_message.data = saved.data;
    net.net_message.maxsize = saved.maxsize;
    net.net_message.cursize = saved.cursize;
    common.COM_SetNetMessage(saved.common);
    SV_User_SetCallbacks({ host_client: null });
    sv_phys.SV_SetState(...savedState);
  }
}

Deno.test("clc_icaro_ext is skipped by its length, and clc_delta is 96", () => {
  assertEqual(clc_delta, 96, "clc_delta");
  assertEqual(clc_icaro_ext, 127, "clc_icaro_ext");
  for (const length of [0, 9, 40000]) {
    const [ok, client] = serverRead((m) => {
      common.MSG_WriteByte(m, clc_icaro_ext);
      common.MSG_WriteShort(m, 0x8001);
      common.MSG_WriteShort(m, length);
      for (let i = 0; i < length; i++) {
        common.MSG_WriteByte(m, i % 2 === 0 ? clc_delta : 200);
      }
      common.MSG_WriteByte(m, clc_delta);
      common.MSG_WriteByte(m, 37);
      common.MSG_WriteByte(m, clc_nop);
    });
    assertEqual(ok, true, `ext of ${length} bytes accepted`);
    assertEqual(client.delta_sequence, 37, `clc_delta after ${length} bytes`);
  }
});

Deno.test("a clc_icaro_ext past the end of the message drops the client", () => {
  const [ok] = serverRead((m) => {
    common.MSG_WriteByte(m, clc_icaro_ext);
    common.MSG_WriteShort(m, 1);
    common.MSG_WriteShort(m, 3);
    common.MSG_WriteByte(m, 0);
  });
  assertEqual(ok, false, "overrun refused");
  const [ok2] = serverRead((m) => common.MSG_WriteByte(m, clc_icaro_ext));
  assertEqual(ok2, false, "truncated header refused");
  // revision 0's clc_delta number is unknown now
  const [ok3] = serverRead((m) => {
    common.MSG_WriteByte(m, 5);
    common.MSG_WriteByte(m, 1);
  });
  assertEqual(ok3, false, "clc 5 refused");
});

Deno.test("an svc_icaro_ext past the end of the message is a Host_Error", () => {
  expectParseError(
    PROTOCOL_ICARO,
    1,
    (m) => {
      common.MSG_WriteByte(m, svc_icaro_ext);
      common.MSG_WriteShort(m, 5);
      common.MSG_WriteShort(m, 4);
      common.MSG_WriteByte(m, 0);
      common.MSG_WriteByte(m, 0);
      common.MSG_WriteByte(m, 0);
    },
    "overruns",
    "short payload",
  );
  expectParseError(
    PROTOCOL_ICARO,
    1,
    (m) => {
      common.MSG_WriteByte(m, svc_icaro_ext);
      common.MSG_WriteByte(m, 5); // half an id
    },
    "overruns",
    "truncated header",
  );
});

Deno.test("a fast update reads short coords under 15 and int32 under PROTOCOL_ICARO revision 0", () => {
  const U_ORIGIN1 = 1 << 1, U_ORIGIN3 = 1 << 3;
  for (const protocol of [PROTOCOL_VERSION, PROTOCOL_ICARO]) {
    const write = protocol === PROTOCOL_ICARO ?
      common.MSG_WriteCoord :
      common.MSG_WriteCoord16;
    clientParse(
      protocol,
      (m) => {
        cls.signon = SIGNONS; // past the signon CL_ParseUpdate completes
        common.MSG_WriteByte(m, 128 | U_ORIGIN1 | U_ORIGIN3);
        common.MSG_WriteByte(m, 20); // entity
        write(m, -1234.5);
        write(m, 2047.875);
      },
      () => {
        const org = cl_entities[20].msg_origins[0];
        assertEqual(org[0], -1234.5, `${protocol}: origin x`);
        assertEqual(org[1], cl_entities[20].baseline.origin[1], "origin y");
        assertEqual(org[2], 2047.875, `${protocol}: origin z`);
      },
      0,
      0,
    );
  }

  // Icaro's server never sends them, so revision 1 has none
  expectParseError(
    PROTOCOL_ICARO,
    1,
    (m) => {
      common.MSG_WriteByte(m, 128 | U_ORIGIN1);
      common.MSG_WriteByte(m, 20);
      common.MSG_WriteCoord(m, 1);
    },
    "Illegible",
    "a fast update under revision 1",
  );
});

// FitzQuake 666 and RMQ 999: hand-built messages in Ironwail's layouts
// (cl_parse.c, protocol.h). RMQ's coordinates and angles follow the PRFL_*
// flags svc_serverinfo carries; 666 has none.

/** int32 sixteenths (PRFL_INT32COORD) */
function writeCoordInt32(m, f) {
  common.MSG_WriteLong(m, Math.round(f * 16));
}

/** 16.8 fixed point (PRFL_24BITCOORD) */
function writeCoord24(m, whole, frac255) {
  common.MSG_WriteShort(m, whole);
  common.MSG_WriteByte(m, frac255);
}

/** short angles (PRFL_SHORTANGLE) */
function writeAngleShort(m, a) {
  common.MSG_WriteShort(m, Math.round(a * 65536 / 360));
}

Deno.test("PROTOCOL_RMQ's flags pick Ironwail's coordinate and angle modes", () => {
  const savedProtocol = cl.protocol;
  const C = common;
  const cases = [
    [PROTOCOL_FITZQUAKE, 0, C.MSG_COORD_16, C.MSG_ANGLE_8],
    [PROTOCOL_RMQ, 0, C.MSG_COORD_16, C.MSG_ANGLE_8],
    // demo3's flags
    [
      PROTOCOL_RMQ,
      PRFL_SHORTANGLE | PRFL_INT32COORD,
      C.MSG_COORD_INT32_16,
      C.MSG_ANGLE_16,
    ],
    [PROTOCOL_RMQ, PRFL_24BITCOORD, C.MSG_COORD_24, C.MSG_ANGLE_8],
    // float > int32 > 24-bit; float > short
    [
      PROTOCOL_RMQ,
      PRFL_FLOATCOORD | PRFL_INT32COORD | PRFL_24BITCOORD | PRFL_FLOATANGLE |
      PRFL_SHORTANGLE,
      C.MSG_COORD_FLOAT,
      C.MSG_ANGLE_FLOAT,
    ],
    [PROTOCOL_RMQ, PRFL_INT32COORD | PRFL_24BITCOORD, C.MSG_COORD_INT32_16, 0],
    [PROTOCOL_VERSION, 0, C.MSG_COORD_16, C.MSG_ANGLE_8],
    [PROTOCOL_ICARO, 0, C.MSG_COORD_INT32_8, C.MSG_ANGLE_8],
  ];
  try {
    for (const [protocol, flags, coordmode, anglemode] of cases) {
      assertEqual(CL_SetProtocol(protocol, flags), true, `${protocol} read`);
      assertEqual(C.msg_coordmode, coordmode, `${protocol}/${flags} coords`);
      assertEqual(C.msg_anglemode, anglemode, `${protocol}/${flags} angles`);
    }
  } finally {
    CL_SetProtocol(PROTOCOL_ICARO, 0);
    cl.protocol = savedProtocol;
  }
});

Deno.test("PROTOCOL_RMQ reads 24-bit, float and short-angle baselines", () => {
  // id's svc_spawnbaseline layout, with the flags' coordinates and angles
  const write = (m, num, coord, angle) => {
    common.MSG_WriteByte(m, svc_spawnbaseline);
    common.MSG_WriteShort(m, num);
    common.MSG_WriteByte(m, 5); // model
    common.MSG_WriteByte(m, 6); // frame
    common.MSG_WriteByte(m, 0); // colormap
    common.MSG_WriteByte(m, 2); // skin
    for (let i = 0; i < 3; i++) {
      coord(m, i);
      angle(m, i);
    }
  };
  clientParse(PROTOCOL_RMQ, (m) => {
    write(m, 40, (m, i) => writeCoord24(m, -9000 + i, 51), (m, i) => {
      common.MSG_WriteAngle(m, i * 90);
    });
  }, () => {
    const b = cl_entities[40].baseline;
    assertEqual(b.origin[0], Math.fround(-9000 + 51 / 255), "24-bit coord");
    assertEqual(b.origin[2], Math.fround(-8998 + 51 / 255), "24-bit coord");
    assertEqual(b.angles[1], 90, "byte angle");
    assertEqual(b.skin, 2, "skin");
  }, PRFL_24BITCOORD);
  clientParse(PROTOCOL_RMQ, (m) => {
    write(m, 41, (m, i) => common.MSG_WriteFloat(m, 40000.5 * (i - 1)), (m) => {
      common.MSG_WriteFloat(m, 12.25);
    });
  }, () => {
    const b = cl_entities[41].baseline;
    assertEqual(b.origin[0], -40000.5, "float coord");
    assertEqual(b.origin[2], 40000.5, "float coord");
    assertEqual(b.angles[2], 12.25, "float angle");
  }, PRFL_FLOATCOORD | PRFL_FLOATANGLE);
});

Deno.test("svc_spawnbaseline2 reads FitzQuake's B_* fields under PROTOCOL_RMQ", () => {
  clientParse(PROTOCOL_RMQ, (m) => {
    common.MSG_WriteByte(m, svc_spawnbaseline2);
    common.MSG_WriteShort(m, 300);
    common.MSG_WriteByte(m, B_LARGEMODEL | B_LARGEFRAME | B_ALPHA | B_SCALE);
    common.MSG_WriteShort(m, 700); // model
    common.MSG_WriteShort(m, 400); // frame
    common.MSG_WriteByte(m, 0); // colormap
    common.MSG_WriteByte(m, 3); // skin
    for (let i = 0; i < 3; i++) {
      writeCoordInt32(m, -5000.5 + i * 10000);
      writeAngleShort(m, -90 + i * 90);
    }
    common.MSG_WriteByte(m, ENTALPHA_ENCODE(0.5));
    common.MSG_WriteByte(m, 32); // scale 2.0

    // with no B_* bits: id's byte model and frame, no alpha
    common.MSG_WriteByte(m, svc_spawnbaseline2);
    common.MSG_WriteShort(m, 301);
    common.MSG_WriteByte(m, 0);
    common.MSG_WriteByte(m, 9); // model
    common.MSG_WriteByte(m, 8); // frame
    common.MSG_WriteByte(m, 0);
    common.MSG_WriteByte(m, 1);
    for (let i = 0; i < 3; i++) {
      writeCoordInt32(m, 1.0625);
      writeAngleShort(m, 45);
    }
  }, () => {
    const b = cl_entities[300].baseline;
    assertEqual(b.modelindex, 700, "B_LARGEMODEL");
    assertEqual(b.frame, 400, "B_LARGEFRAME");
    assertEqual(b.skin, 3, "skin");
    assertEqual(b.origin[0], -5000.5, "int32 sixteenths");
    assertEqual(b.origin[2], 15000 - 0.5, "int32 sixteenths");
    assertEqual(b.angles[0], -90, "short angle");
    assertEqual(b.angles[2], 90, "short angle");
    assertEqual(b.alpha, ENTALPHA_ENCODE(0.5), "B_ALPHA");
    const b2 = cl_entities[301].baseline;
    assertEqual(b2.modelindex, 9, "byte model");
    assertEqual(b2.frame, 8, "byte frame");
    assertEqual(b2.origin[1], 1.0625, "int32 sixteenths");
    assertEqual(b2.angles[1], 45, "short angle");
    assertEqual(b2.alpha, ENTALPHA_DEFAULT, "no B_ALPHA");
    assertEqual(b.scale, 32, "B_SCALE");
    assertEqual(b2.scale, ENTSCALE_DEFAULT, "no B_SCALE");
  }, PRFL_SHORTANGLE | PRFL_INT32COORD);
});

Deno.test("svc_spawnstatic2 and svc_spawnstaticsound2 under PROTOCOL_FITZQUAKE", () => {
  clientParse(PROTOCOL_FITZQUAKE, (m) => {
    common.MSG_WriteByte(m, svc_spawnstatic2);
    common.MSG_WriteByte(m, B_LARGEFRAME | B_ALPHA | B_SCALE);
    common.MSG_WriteByte(m, 4); // model: a byte without B_LARGEMODEL
    common.MSG_WriteShort(m, 513); // frame
    common.MSG_WriteByte(m, 0);
    common.MSG_WriteByte(m, 1);
    for (let i = 0; i < 3; i++) {
      common.MSG_WriteCoord16(m, -4000.5);
      common.MSG_WriteAngle(m, 90);
    }
    common.MSG_WriteByte(m, ENTALPHA_ENCODE(0.25));
    common.MSG_WriteByte(m, 8); // scale 0.5

    // a short sound index, short coords
    common.MSG_WriteByte(m, svc_spawnstaticsound2);
    for (let i = 0; i < 3; i++) common.MSG_WriteCoord16(m, 100);
    common.MSG_WriteShort(m, 300);
    common.MSG_WriteByte(m, 255);
    common.MSG_WriteByte(m, 64);

    // and id's spawnstaticsound: a byte
    common.MSG_WriteByte(m, svc_spawnstaticsound);
    for (let i = 0; i < 3; i++) common.MSG_WriteCoord16(m, 100);
    common.MSG_WriteByte(m, 3);
    common.MSG_WriteByte(m, 255);
    common.MSG_WriteByte(m, 64);
  }, () => {
    const ent = cl_static_entities[cl.num_statics - 1];
    assertEqual(ent.baseline.modelindex, 4, "static model");
    assertEqual(ent.frame, 513, "static frame");
    assertEqual(ent.skinnum, 1, "static skin after the short frame");
    assertEqual(ent.origin[1], -4000.5, "static origin");
    assertEqual(ent.angles[1], 90, "static angle");
    assertEqual(ent.alpha, ENTALPHA_ENCODE(0.25), "static alpha");
    assertEqual(ent.scale, 8, "static B_SCALE");
  });
});

Deno.test("Fitz clientdata reads the SU_*2 high bytes after the active weapon", () => {
  const STATS = [
    STAT_WEAPON,
    STAT_ARMOR,
    STAT_AMMO,
    STAT_SHELLS,
    STAT_NAILS,
    STAT_ROCKETS,
    STAT_CELLS,
  ];
  const saved = STATS.map((s) => cl.stats[s]);
  try {
    clientParse(PROTOCOL_FITZQUAKE, (m) => {
      common.MSG_WriteByte(m, svc_clientdata);
      common.MSG_WriteShort(m, SU_ITEMS | SU_ARMOR | SU_WEAPON | SU_EXTEND1);
      common.MSG_WriteByte(
        m,
        (SU_WEAPON2 | SU_ARMOR2 | SU_AMMO2 | SU_SHELLS2 | SU_NAILS2 |
          SU_ROCKETS2 | SU_CELLS2) >> 16,
      );
      common.MSG_WriteLong(m, 1); // items
      common.MSG_WriteByte(m, 10); // armor
      common.MSG_WriteByte(m, 11); // weapon model
      common.MSG_WriteShort(m, 100); // health
      common.MSG_WriteByte(m, 12); // ammo
      for (let i = 0; i < 4; i++) common.MSG_WriteByte(m, 13 + i);
      common.MSG_WriteByte(m, 0); // active weapon
      for (let i = 0; i < 7; i++) common.MSG_WriteByte(m, 1 + i); // *2
    }, () => {
      const expect = [11, 10, 12, 13, 14, 15, 16];
      for (let i = 0; i < STATS.length; i++) {
        assertEqual(
          cl.stats[STATS[i]],
          ((1 + i) << 8) | expect[i],
          `stat ${STATS[i]} high byte`,
        );
      }
    });
  } finally {
    STATS.forEach((s, i) => cl.stats[s] = saved[i]);
  }
});

Deno.test("a Fitz fast update reads U_EXTEND1, alpha, frame2, model2 and lerpfinish", () => {
  const savedMtime = [cl.mtime[0], cl.mtime[1]];
  const write = (m, model2, lerp) => {
    common.MSG_WriteByte(m, 128 | U_MOREBITS | U_ORIGIN1 | U_ANGLE2 | U_FRAME);
    common.MSG_WriteByte(m, (U_EXTEND1 | U_LONGENTITY | U_MODEL) >> 8);
    common.MSG_WriteByte(
      m,
      (U_ALPHA | U_SCALE | U_FRAME2 | U_MODEL2 | (lerp ? U_LERPFINISH : 0)) >>
        16,
    );
    common.MSG_WriteShort(m, 3000); // entity
    common.MSG_WriteByte(m, 0x34); // model
    common.MSG_WriteByte(m, 0x10); // frame
    writeCoordInt32(m, 6000.25);
    writeAngleShort(m, 270 - 360);
    common.MSG_WriteByte(m, 77); // alpha
    common.MSG_WriteByte(m, 40); // scale 2.5
    common.MSG_WriteByte(m, 0x01); // frame2
    common.MSG_WriteByte(m, model2);
    if (lerp) common.MSG_WriteByte(m, 51);
  };
  try {
    clientParse(PROTOCOL_RMQ, (m) => {
      cls.signon = SIGNONS;
      cl.mtime[0] = 10;
      write(m, 0x02, true);
    }, () => {
      const ent = cl_entities[3000];
      assertEqual(ent.msg_origins[0][0], 6000.25, "int32 coord");
      assertEqual(ent.msg_angles[0][1], -90, "short angle");
      assertEqual(ent.frame, 0x110, "U_FRAME2");
      assertEqual(ent.model, cl.model_precache[0x234], "U_MODEL2");
      assertEqual(ent.alpha, 77, "U_ALPHA");
      assertEqual(ent.scale, 40, "U_SCALE");
      assertEqual(ent.lerpfinish, 10 + 51 / 255, "U_LERPFINISH");
      assertEqual((ent.lerpflags & LERP_FINISH) !== 0, true, "LERP_FINISH");
    }, PRFL_SHORTANGLE | PRFL_INT32COORD);

    clientParse(PROTOCOL_RMQ, (m) => {
      cls.signon = SIGNONS;
      write(m, 0x02, false);
    }, () => {
      const ent = cl_entities[3000];
      assertEqual((ent.lerpflags & LERP_FINISH) !== 0, false, "cleared");
    }, PRFL_SHORTANGLE | PRFL_INT32COORD);

    // U_MODEL2 can't name a model past MAX_MODELS
    let error = null;
    try {
      clientParse(
        PROTOCOL_RMQ,
        (m) => {
          cls.signon = SIGNONS;
          write(m, 0xFF, false);
        },
        () => {},
        PRFL_SHORTANGLE | PRFL_INT32COORD,
      );
    } catch (e) {
      error = e;
    }
    if (error === null || !String(error.message).includes("bad modnum")) {
      throw new Error("expected bad modnum, got " + error);
    }
  } finally {
    cl.mtime[0] = savedMtime[0];
    cl.mtime[1] = savedMtime[1];
  }
});

Deno.test("svc_fog, svc_bf and svc_skybox under PROTOCOL_FITZQUAKE", async () => {
  if (Cvar_FindVar("gl_cshiftpercent_damage") === null) {
    V_Init(); // registers "bf"
  }
  const bonus = cl.cshifts[CSHIFT_BONUS];
  const savedPercent = bonus.percent;
  try {
    bonus.percent = 0;
    clientParse(PROTOCOL_FITZQUAKE, (m) => {
      common.MSG_WriteByte(m, svc_fog);
      common.MSG_WriteByte(m, 51); // density
      common.MSG_WriteByte(m, 255);
      common.MSG_WriteByte(m, 0);
      common.MSG_WriteByte(m, 102);
      common.MSG_WriteShort(m, 250); // time, hundredths
      common.MSG_WriteByte(m, svc_bf);
      common.MSG_WriteByte(m, svc_skybox);
      common.MSG_WriteString(m, "");
    }, () => {
      const fog = Fog_GetState();
      assertEqual(fog.density, 51 / 255, "fog density");
      assertEqual(fog.red, 1, "fog red");
      assertEqual(fog.green, 0, "fog green");
      assertEqual(fog.blue, 102 / 255, "fog blue");
      assertEqual(fog.fade_time, 2.5, "fog time");
      assertEqual(bonus.percent, 50, "bf");
      assertEqual(Sky_GetSkyBox(), null, "skybox off");
    });
  } finally {
    bonus.percent = savedPercent;
    Fog_Update(0, 0.3, 0.3, 0.3, 0);
    await Sky_LoadSkyBox("");
  }
});

Deno.test("FitzQuake's svcs are illegible under 15 and PROTOCOL_ICARO", () => {
  const cases = [
    [PROTOCOL_VERSION, [svc_skybox, svc_bf, svc_fog, 42, 43, 44]],
    [PROTOCOL_ICARO, [svc_skybox, svc_bf, svc_fog, 43, 44]],
    [PROTOCOL_RMQ, [38, 45, 47, 48, 49]],
  ];
  for (const [protocol, svcs] of cases) {
    for (const svc of svcs) {
      let error = null;
      try {
        clientParse(protocol, (m) => common.MSG_WriteByte(m, svc), () => {});
      } catch (e) {
        error = e;
      }
      if (error === null || !String(error.message).includes("Illegible")) {
        throw new Error(`svc ${svc} under ${protocol}: got ${error}`);
      }
    }
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

// The data's attract demos: LibreQuake's demo1 was recorded by FitzQuake
// 0.85 under protocol 15 (its first message prints the server's banner
// before svc_serverinfo); demo3 under PROTOCOL_RMQ with PRFL_SHORTANGLE and
// PRFL_INT32COORD.

Deno.test("demo1.dem (protocol 15) parses message by message", async () => {
  await demoParses("demo1.dem", PROTOCOL_VERSION, 0);
});

Deno.test("demo3.dem (PROTOCOL_RMQ) parses message by message", async () => {
  await demoParses(
    "demo3.dem",
    PROTOCOL_RMQ,
    PRFL_SHORTANGLE | PRFL_INT32COORD,
  );
});

async function demoParses(name, protocol, flags) {
  await TD_Mount();
  const file = pak.COM_FindFile(name);
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
      // and hand the parser svc_version in its place.
      if (messages === 0) msg = replaceServerinfo(msg, protocol, flags);

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
      assertEqual(cl.protocol, protocol, "protocol");
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
    cl.maxclients = saved.maxclients;
    cl.scores = saved.scores;
    cl.num_entities = saved.num_entities;
    cl.num_statics = saved.num_statics;
    CL_SetProtocol(PROTOCOL_ICARO, 0);
    cl.protocol = saved.protocol;
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
}

// The first demo message is svc_serverinfo and the signon that follows it.
// Returns svc_version plus the rest, and sets what CL_ParseServerInfo would
// (with PROTOCOL_RMQ's flags, which svc_version keeps).
function replaceServerinfo(msg, protocol, flags) {
  let p = 0;
  if (msg[p] === 8) { // svc_print
    p++;
    while (msg[p] !== 0) p++;
    p++;
  }
  const head = p;
  if (msg[p++] !== 11) {
    throw new Error("the demo does not start with svc_serverinfo");
  }
  const view = new DataView(msg.buffer, msg.byteOffset, msg.byteLength);
  assertEqual(view.getInt32(p, true), protocol, "demo protocol");
  p += 4;
  if (protocol === PROTOCOL_RMQ) {
    assertEqual(view.getInt32(p, true), flags, "demo protocol flags");
    p += 4;
  }
  CL_SetProtocol(protocol, flags);
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

  const out = new Uint8Array(head + 5 + msg.length - p);
  out.set(msg.subarray(0, head), 0);
  out[head] = svc_version;
  new DataView(out.buffer).setInt32(head + 1, protocol, true);
  out.set(msg.subarray(p), head + 5);
  return out;
}
