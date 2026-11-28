// Entity scale (QuakeSpasm's U_SCALE and B_SCALE): the ENTSCALE_* encoding,
// field defaults, and the PROTOCOL_ICARO extension that carries it
// (ICAP_OPT_ENTSCALE, ICARO_EXT_ENTSCALE and ICARO_EXT_STATICSCALE in
// protocol.js), written by the server and read back by the real client
// parser. The 666/999 U_SCALE and B_SCALE reads are in protocol_icaro_test.js.

// Bootstrap the client renderer graph in its established safe import order.
await import("../src/gl_rsurf.js");

const common = await import("../src/common.js");
const net = await import("../src/net.js");
const { MAX_MSGLEN, entity_state_t } = await import("../src/quakedef.js");
const {
  ENTSCALE_DECODE,
  ENTSCALE_DEFAULT,
  ENTSCALE_ENCODE,
  ICAP_OPT_ENTSCALE,
  ICARO_EXT_ENTSCALE,
  ICARO_EXT_STATICSCALE,
  PROTOCOL_ICARO,
  svc_icaro_ext,
  svc_packetentities,
  svc_serversequence,
  svc_spawnstatic,
  svc_version,
} = await import("../src/protocol.js");
const client = await import("../src/client.js");
const { cl, cls, cl_static_entities, SIGNONS } = client;
const render = await import("../src/render.js");
const { CL_EntityScale, CL_ParseServerMessage, CL_SetProtocol, cl_icaro } =
  await import("../src/cl_parse.js");
const { CL_GetEntityFrame, CL_ResetPrediction } = await import(
  "../src/cl_pred.js"
);
const { PR_AllocEdicts, pr_extfields } = await import("../src/pr_edict.js");
const { PR_SetSV, PR_SetStringsData, pr_strings_data, sv: progs_sv } =
  await import("../src/progs.js");
const { client_t, sv, svs } = await import("../src/server.js");
const {
  SV_EntScale,
  SV_SendServerinfo,
  SV_WriteEntitiesToClient,
  SV_WritePlayersToClient,
  SV_WriteStaticScale,
} = await import("../src/sv_main.js");

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

function makeMsg(size) {
  const msg = new common.sizebuf_t();
  common.SZ_Alloc(msg, size);
  return msg;
}

function copyInto(dst, src) {
  common.SZ_Write(dst, src.data.subarray(0, src.cursize), src.cursize);
}

// An edict field offset for "scale" inside PR_AllocEdicts(n, 105)
const SCALE_OFS = 100;

function withScaleField(ofs, fn) {
  const saved = pr_extfields.scale;
  try {
    pr_extfields.scale = ofs;
    return fn();
  } finally {
    pr_extfields.scale = saved;
  }
}

// Run the client parser over one PROTOCOL_ICARO message (svc_version, then
// whatever `write` puts in) with the optional capability words `optional`.
// Restores the client state it touches.
function clientParse(optional, write, check) {
  const saved = {
    data: net.net_message.data,
    maxsize: net.net_message.maxsize,
    cursize: net.net_message.cursize,
    common: common.net_message,
    protocol: cl.protocol,
    signon: cls.signon,
    num_statics: cl.num_statics,
    optional: cl_icaro.optional.slice(),
  };

  try {
    common.COM_SetNetMessage(net.net_message);
    net.net_message.data = new Uint8Array(net.NET_MAXMESSAGE);
    net.net_message.maxsize = net.NET_MAXMESSAGE;
    common.SZ_Clear(net.net_message);
    CL_SetProtocol(PROTOCOL_ICARO, 0);
    cl_icaro.optional.length = 0;
    cl_icaro.optional.push(...optional);
    common.MSG_WriteByte(net.net_message, svc_version);
    common.MSG_WriteLong(net.net_message, PROTOCOL_ICARO);
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
    cl.num_statics = saved.num_statics;
    cl_icaro.optional.length = 0;
    cl_icaro.optional.push(...saved.optional);
    CL_ResetPrediction();
  }
}

// An ICARO_EXT_ENTSCALE message from [entnum, scale] pairs
function writeEntScale(m, pairs) {
  common.MSG_WriteByte(m, svc_icaro_ext);
  common.MSG_WriteShort(m, ICARO_EXT_ENTSCALE);
  common.MSG_WriteShort(m, pairs.length * 3);
  for (const [num, scale] of pairs) {
    common.MSG_WriteShort(m, num);
    common.MSG_WriteByte(m, scale);
  }
}

// An empty full svc_packetentities for sequence `seq`
function writeEmptyPacket(m, seq) {
  common.MSG_WriteByte(m, svc_serversequence);
  common.MSG_WriteLong(m, seq);
  common.MSG_WriteByte(m, svc_packetentities);
  common.MSG_WriteShort(m, 0);
}

Deno.test("ENTSCALE_ENCODE matches QuakeSpasm's macro, 0 meaning 1", () => {
  const cases = [
    [0, 16],
    [1, 16],
    [2, 32],
    [0.5, 8],
    [1.5, 24],
    [15.9375, 255],
    // C stores (a)*16 in an unsigned char with no clamp; x86 keeps the
    // low 8 bits
    [16, 0],
    [20, 64],
    [-1, 240],
  ];
  for (const [value, byte] of cases) {
    assertEqual(ENTSCALE_ENCODE(value), byte, `ENTSCALE_ENCODE(${value})`);
  }
  assertEqual(ENTSCALE_DECODE(ENTSCALE_DEFAULT), 1, "default decodes to 1");
  assertEqual(ENTSCALE_DECODE(8), 0.5, "8 decodes to 0.5");
  assertEqual(ENTSCALE_DECODE(255), 15.9375, "largest scale");
});

Deno.test("entities and entity states default to ENTSCALE_DEFAULT", () => {
  assertEqual(new client.entity_t().scale, ENTSCALE_DEFAULT, "client entity");
  assertEqual(new render.entity_t().scale, ENTSCALE_DEFAULT, "render entity");
  const s = new entity_state_t();
  assertEqual(s.scale, ENTSCALE_DEFAULT, "entity state");
  s.scale = 40;
  const t = new entity_state_t();
  t.copyFrom(s);
  assertEqual(t.scale, 40, "copyFrom copies scale");
});

Deno.test("SV_EntScale reads the scale field only when the progs has one", () => {
  const ed = PR_AllocEdicts(2, 105)[1];
  ed._fieldAccessor.setFloat(SCALE_OFS, 2);
  withScaleField(-1, () => {
    assertEqual(SV_EntScale(ed), ENTSCALE_DEFAULT, "no scale field");
  });
  withScaleField(SCALE_OFS, () => {
    assertEqual(SV_EntScale(ed), 32, "scale 2");
    ed._fieldAccessor.setFloat(SCALE_OFS, 0);
    assertEqual(SV_EntScale(ed), ENTSCALE_DEFAULT, "scale 0 means 1");
  });
});

// docs/protocol-design.md, "The hello": the optional word list
Deno.test("the hello sets ICAP_OPT_ENTSCALE only for a progs with scale", () => {
  const saved = {
    maxclients: svs.maxclients,
    clients: svs.clients,
    edicts: sv.edicts,
    models: sv.model_precache,
    sounds: sv.sound_precache,
  };
  // the optional word count, and the word if there is one
  const hello = () => {
    const c = new client_t();
    c.message.data = c.msgbuf;
    c.message.maxsize = MAX_MSGLEN;
    svs.clients = [c];
    SV_SendServerinfo(c);
    const m = c.message.data;
    const game = m.indexOf(0x71, m.indexOf(0, 1)); // "quake"
    const o = m.indexOf(0, game) + 2; // past the string and required count
    return [
      m[o],
      new DataView(m.buffer).getInt32(o + 1, true),
    ];
  };
  try {
    svs.maxclients = 4;
    sv.edicts = [{ v: { message: -1, sounds: 0 } }];
    sv.model_precache = [null, "maps/x.bsp"];
    sv.sound_precache = [null];
    withScaleField(-1, () => {
      assertEqual(hello()[0], 0, "no optional words without scale");
    });
    withScaleField(SCALE_OFS, () => {
      const [n, word] = hello();
      assertEqual(n, 1, "one optional word");
      assertEqual(word, ICAP_OPT_ENTSCALE, "ICAP_OPT_ENTSCALE");
    });
  } finally {
    svs.maxclients = saved.maxclients;
    svs.clients = saved.clients;
    sv.edicts = saved.edicts;
    sv.model_precache = saved.models;
    sv.sound_precache = saved.sounds;
  }
});

// Save and restore the server state SV_Write*ToClient reads
function withServer(fn) {
  const saved = Object.assign({}, sv);
  const oldProgsSV = progs_sv;
  const oldClients = svs.clients;
  const oldMaxclients = svs.maxclients;
  const oldStrings = pr_strings_data;
  try {
    // offset 0 is a one-letter string, so v.model = 0 names a model
    PR_SetStringsData(new Uint8Array([0x61, 0]));
    return fn();
  } finally {
    Object.assign(sv, saved);
    PR_SetSV(oldProgsSV);
    svs.clients = oldClients;
    svs.maxclients = oldMaxclients;
    PR_SetStringsData(oldStrings);
  }
}

// One server datagram's entities: a player (edict 1) and edicts 2-4 with
// the given scale field values, all visible
function writeEntities(scales, playerScale) {
  const edicts = PR_AllocEdicts(8, 105);
  PR_SetSV({ max_edicts: 8, num_edicts: 8, edicts });
  sv.num_edicts = 8;
  sv.time = 1;
  sv.model_precache = ["", "maps/x.bsp", "progs/a.mdl", "progs/player.mdl"];
  svs.maxclients = 1;
  const c = new client_t();
  c.active = true;
  c.spawned = true;
  c.edict = edicts[1];
  svs.clients = [c];
  edicts[1].v.modelindex = 3;
  edicts[1].v.health = 100;
  edicts[1]._fieldAccessor.setFloat(SCALE_OFS, playerScale);
  for (let i = 0; i < scales.length; i++) {
    const ed = edicts[2 + i];
    ed.v.modelindex = 2;
    ed.v.model = 0;
    ed.num_leafs = 1;
    ed.leafnums[0] = 0;
    ed._fieldAccessor.setFloat(SCALE_OFS, scales[i]);
  }
  const pvs = new Uint8Array([1]);
  const msg = makeMsg(MAX_MSGLEN);
  SV_WritePlayersToClient(c, edicts[1], pvs, msg);
  SV_WriteEntitiesToClient(c, edicts[1], pvs, msg);
  return msg;
}

Deno.test("ICARO_EXT_ENTSCALE carries entity and player scale before the packet entities", () => {
  withServer(() => {
    const msg = withScaleField(
      SCALE_OFS,
      () => writeEntities([2, 0, 0.5], 1.5),
    );
    const ext = msg.data.indexOf(svc_icaro_ext);
    const pe = msg.data.indexOf(svc_packetentities, ext);
    if (ext < 0 || pe < 0) {
      throw new Error(`escape at ${ext}, packet entities at ${pe}`);
    }

    clientParse([ICAP_OPT_ENTSCALE], (m) => {
      cls.signon = SIGNONS;
      cl.maxclients = 1;
      common.MSG_WriteByte(m, svc_serversequence);
      common.MSG_WriteLong(m, 5);
      copyInto(m, msg);
    }, () => {
      assertEqual(
        CL_GetEntityFrame(5).packet_entities.num_entities,
        3,
        "packet entities parsed after the escape",
      );
      assertEqual(CL_EntityScale(1), 24, "player scale 1.5");
      assertEqual(CL_EntityScale(2), 32, "scale 2");
      assertEqual(CL_EntityScale(3), ENTSCALE_DEFAULT, "scale 0");
      assertEqual(CL_EntityScale(4), 8, "scale 0.5");
    });

    // the next datagram has no escape: every entity is back to the default
    clientParse([ICAP_OPT_ENTSCALE], (m) => {
      cls.signon = SIGNONS;
      writeEmptyPacket(m, 6);
    }, () => {
      for (let e = 1; e <= 4; e++) {
        assertEqual(CL_EntityScale(e), ENTSCALE_DEFAULT, `entity ${e} reset`);
      }
    });
  });
});

Deno.test("a progs without scale sends no escape", () => {
  withServer(() => {
    const msg = withScaleField(-1, () => writeEntities([2, 0, 0.5], 1.5));
    assertEqual(
      msg.data.subarray(0, msg.cursize).indexOf(svc_icaro_ext),
      -1,
      "no svc_icaro_ext",
    );
  });
});

Deno.test("ICARO_EXT_ENTSCALE is skipped without ICAP_OPT_ENTSCALE", () => {
  clientParse([], (m) => {
    cls.signon = SIGNONS;
    writeEntScale(m, [[2, 32]]);
    writeEmptyPacket(m, 7);
  }, () => {
    assertEqual(CL_EntityScale(2), ENTSCALE_DEFAULT, "ignored");
  });

  // a later datagram's list replaces the whole state
  clientParse([ICAP_OPT_ENTSCALE], (m) => {
    cls.signon = SIGNONS;
    writeEntScale(m, [[2, 32], [3, 48]]);
    writeEmptyPacket(m, 8);
    writeEntScale(m, [[3, 8]]);
    writeEmptyPacket(m, 9);
  }, () => {
    assertEqual(CL_EntityScale(2), ENTSCALE_DEFAULT, "dropped from the list");
    assertEqual(CL_EntityScale(3), 8, "replaced");
  });
});

Deno.test("ICARO_EXT_STATICSCALE follows a makestatic and scales that static", () => {
  withServer(() => {
    const signon = makeMsg(1024);
    sv.signon = signon;
    sv.signon_buffers = [signon];
    sv.num_signon_buffers = 1;
    const ed = PR_AllocEdicts(2, 105)[1];
    withScaleField(SCALE_OFS, () => {
      ed._fieldAccessor.setFloat(SCALE_OFS, 1);
      SV_WriteStaticScale(ed);
      assertEqual(sv.signon.cursize, 0, "nothing for the default scale");
      ed._fieldAccessor.setFloat(SCALE_OFS, 3);
      SV_WriteStaticScale(ed);
    });
    const ext = sv.signon;
    assertEqual(ext.cursize, 6, "header and one byte");
    assertEqual(ext.data[0], svc_icaro_ext, "svc_icaro_ext");
    assertEqual(ext.data[1] | (ext.data[2] << 8), ICARO_EXT_STATICSCALE, "id");
    assertEqual(ext.data[5], 48, "scale 3");

    // PF_makestatic's layout, then the escape
    const spawnstatic = (m) => {
      common.MSG_WriteByte(m, svc_spawnstatic);
      common.MSG_WriteShort(m, 2);
      common.MSG_WriteShort(m, 0);
      common.MSG_WriteByte(m, 0);
      common.MSG_WriteByte(m, 0);
      for (let i = 0; i < 3; i++) {
        common.MSG_WriteCoord(m, 64);
        common.MSG_WriteAngle(m, 0);
      }
      common.MSG_WriteByte(m, 0);
    };
    clientParse([ICAP_OPT_ENTSCALE], (m) => {
      spawnstatic(m);
      copyInto(m, ext);
      spawnstatic(m);
    }, () => {
      const a = cl_static_entities[cl.num_statics - 2];
      const b = cl_static_entities[cl.num_statics - 1];
      assertEqual(a.scale, 48, "scaled static");
      assertEqual(a.baseline.scale, 48, "scaled static baseline");
      assertEqual(b.scale, ENTSCALE_DEFAULT, "the next static");
    });
    clientParse([], (m) => {
      spawnstatic(m);
      copyInto(m, ext);
    }, () => {
      const a = cl_static_entities[cl.num_statics - 1];
      assertEqual(a.scale, ENTSCALE_DEFAULT, "skipped without the cap");
    });
  });
});
