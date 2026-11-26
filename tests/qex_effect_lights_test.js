// 6d: the 2021 rerelease's EF_QUADLIGHT, EF_PENTALIGHT and EF_CANDLELIGHT
// (16, 32, 64). Ironwail's PR_FindSupportedEffects turns them on only for a
// progs that defines them, the server masks them out of the effects byte
// otherwise, and the client gives quad and pent coloured dlights.

import { sizebuf_t } from "../src/common.js";
import { ddef_t, DEF_SAVEGLOBAL, ev_float, ev_string } from "../src/pr_comp.js";
import {
  PR_AllocEdicts,
  pr_effects_mask,
  PR_FindSupportedEffects,
  PR_SetEffectsMask,
} from "../src/pr_edict.js";
import {
  EdictFieldAccessor,
  pr_globaldefs,
  pr_globals,
  PR_SetGlobalDefs,
  PR_SetGlobals,
  PR_SetProgs,
  PR_SetStringsData,
  PR_SetSV,
  pr_strings_data,
  progs,
  sv as progs_sv,
} from "../src/progs.js";
import {
  client_t,
  EF_DIMLIGHT,
  EF_QEX_CANDLELIGHT,
  EF_QEX_PENTALIGHT,
  EF_QEX_QUADLIGHT,
  sv,
  svs,
} from "../src/server.js";
import { ENTALPHA_ZERO } from "../src/protocol.js";
import {
  SV_WriteEntitiesToClient,
  SV_WritePlayersToClient,
} from "../src/sv_main.js";

// Bootstrap the client renderer graph in its established safe import order.
await import("../src/gl_rsurf.js");
const { CL_AllocDlight, CL_QexEffectLights, CL_RelinkEntities } = await import(
  "../src/cl_main.js"
);
const { cl, cls, cl_dlights } = await import("../src/client.js");
const {
  CL_ResetPrediction,
  CL_SetValidSequence,
  CL_SetServerSequence,
  CL_GetEntityFrame,
} = await import("../src/cl_pred.js");

const QEX_BITS = EF_QEX_QUADLIGHT | EF_QEX_PENTALIGHT | EF_QEX_CANDLELIGHT;

function assert(cond, message) {
  if (!cond) {
    throw new Error(message);
  }
}

function makeMsg(size) {
  const msg = new sizebuf_t();
  msg.data = new Uint8Array(size);
  msg.maxsize = size;
  return msg;
}

// Fake a progs whose globals are `defs`: [ name, type, value ] each
function withGlobals(defs, fn) {
  const old = {
    progs,
    defs: pr_globaldefs,
    globals: pr_globals,
    strings: pr_strings_data,
  };
  try {
    const bytes = [0];
    const globaldefs = [];
    const buffer = new ArrayBuffer((defs.length + 1) * 4);
    const accessor = new EdictFieldAccessor(buffer, 0, defs.length + 1);
    defs.forEach(([name, type, value], i) => {
      const def = new ddef_t();
      def.type = type;
      def.ofs = i + 1;
      def.s_name = bytes.length;
      for (const c of name) bytes.push(c.charCodeAt(0));
      bytes.push(0);
      // the value's float bits even for another type, so only the
      // type check can reject it
      accessor.setFloat(def.ofs, value);
      globaldefs.push(def);
    });

    PR_SetProgs({ numglobaldefs: globaldefs.length });
    PR_SetGlobalDefs(globaldefs);
    PR_SetGlobals(accessor);
    PR_SetStringsData(new Uint8Array(bytes));
    return fn();
  } finally {
    PR_SetProgs(old.progs);
    PR_SetGlobalDefs(old.defs);
    PR_SetGlobals(old.globals);
    PR_SetStringsData(old.strings);
  }
}

Deno.test("PR_FindSupportedEffects enables the 2021 light bits only for a progs that defines them", () => {
  const quad = ["EF_QUADLIGHT", ev_float, 16];
  const penta = ["EF_PENTALIGHT", ev_float, 32];
  const cases = [
    [
      "rerelease defs.qc",
      [quad, penta, ["EF_CANDLELIGHT", ev_float, 64]],
      true,
    ],
    [
      "saved globals",
      [["EF_QUADLIGHT", ev_float | DEF_SAVEGLOBAL, 16], penta],
      true,
    ],
    ["EF_PENTLIGHT spelling", [quad, ["EF_PENTLIGHT", ev_float, 32]], true],
    ["no globals", [], false],
    ["quad only", [quad], false],
    ["penta only", [penta], false],
    ["wrong value", [["EF_QUADLIGHT", ev_float, 32], penta], false],
    ["wrong type", [["EF_QUADLIGHT", ev_string, 16], penta], false],
  ];

  for (const [label, defs, isqex] of cases) {
    const mask = withGlobals(defs, PR_FindSupportedEffects);
    const expected = isqex ? -1 : -1 & ~QEX_BITS;
    assert(mask === expected, `${label}: mask ${mask}, expected ${expected}`);
  }
});

// Save and restore what the server tests change
function withServer(mask, fn) {
  const saved = Object.assign({}, sv);
  const old = {
    progsSV: progs_sv,
    clients: svs.clients,
    maxclients: svs.maxclients,
    mask: pr_effects_mask,
    strings: pr_strings_data,
  };
  try {
    PR_SetEffectsMask(mask);
    // v.model = 0 must name a model: give offset 0 a one-letter string
    PR_SetStringsData(new Uint8Array([0x61, 0]));
    return fn();
  } finally {
    Object.assign(sv, saved);
    PR_SetSV(old.progsSV);
    svs.clients = old.clients;
    svs.maxclients = old.maxclients;
    PR_SetEffectsMask(old.mask);
    PR_SetStringsData(old.strings);
  }
}

Deno.test("SV_WriteEntitiesToClient masks the effects with PR_FindSupportedEffects", () => {
  for (
    const [mask, expected] of [[-1, EF_DIMLIGHT | QEX_BITS], [
      -1 & ~QEX_BITS,
      EF_DIMLIGHT,
    ]]
  ) {
    withServer(mask, () => {
      const edicts = PR_AllocEdicts(8, 105);
      PR_SetSV({ max_edicts: 8, num_edicts: 8, edicts });
      sv.num_edicts = 4;
      sv.model_precache = ["", "maps/x.bsp", "progs/a.mdl"];
      svs.maxclients = 1;

      // 2 is visible with lights; 3 is invisible with only 2021 bits
      for (const e of [2, 3]) {
        edicts[e].v.modelindex = 2;
        edicts[e].v.model = 0;
        edicts[e].num_leafs = 1;
        edicts[e].leafnums[0] = 0;
      }

      edicts[2].v.effects = EF_DIMLIGHT | QEX_BITS;
      edicts[3].v.effects = EF_QEX_QUADLIGHT;
      edicts[3].alpha = ENTALPHA_ZERO;

      const client = new client_t();
      SV_WriteEntitiesToClient(
        client,
        edicts[1],
        new Uint8Array([1]),
        makeMsg(1024),
      );
      const pack = client.frames[0].entities;
      const sent = [];
      for (let i = 0; i < pack.num_entities; i++) {
        sent.push(pack.state(i).number);
      }

      assert(
        pack.state(0).number === 2 && pack.state(0).effects === expected,
        `mask ${mask}: effects ${pack.state(0).effects}, expected ${expected}`,
      );
      const sendsInvisible = mask === -1;
      assert(
        sent.includes(3) === sendsInvisible,
        `mask ${mask}: sent ${sent}, invisible quad entity ${
          sendsInvisible ? "should" : "should not"
        } be sent`,
      );
    });
  }
});

Deno.test("SV_WritePlayersToClient masks the effects with PR_FindSupportedEffects", () => {
  // The other player's effects byte is written only when a bit survives the
  // mask (PF_EFFECTS), so the message is one byte shorter without it.
  const sizes = {};
  for (
    const [mask, effects] of [[-1, 0], [-1, EF_QEX_QUADLIGHT], [
      -1 & ~QEX_BITS,
      EF_QEX_QUADLIGHT,
    ]]
  ) {
    withServer(mask, () => {
      const edicts = PR_AllocEdicts(4, 105);
      sv.model_precache = ["", "progs/player.mdl"];
      sv.time = 1;
      svs.maxclients = 2;
      svs.clients = [];
      for (let i = 0; i < 2; i++) {
        edicts[i + 1].v.modelindex = 1;
        edicts[i + 1].v.health = 100;
        edicts[i + 1].num_leafs = 1;
        edicts[i + 1].leafnums[0] = 0;
        svs.clients.push({
          active: true,
          spawned: true,
          edict: edicts[i + 1],
          localtime: 0,
          lastcmd: {
            forwardmove: 0,
            sidemove: 0,
            upmove: 0,
            angles: [0, 0, 0],
          },
        });
      }

      edicts[2].v.effects = effects;
      const msg = makeMsg(1024);
      SV_WritePlayersToClient(
        svs.clients[0],
        edicts[1],
        new Uint8Array([1]),
        msg,
      );
      sizes[`${mask}/${effects}`] = msg.cursize;
    });
  }

  const none = sizes[`-1/0`];
  assert(
    sizes[`-1/${EF_QEX_QUADLIGHT}`] === none + 1,
    `rerelease progs: ${JSON.stringify(sizes)}`,
  );
  assert(
    sizes[`${-1 & ~QEX_BITS}/${EF_QEX_QUADLIGHT}`] === none,
    `other progs: ${JSON.stringify(sizes)}`,
  );
});

Deno.test("CL_QexEffectLights gives quad a blue and pent a red dlight, and none for candle", () => {
  const oldTime = cl.time;
  const saved = cl_dlights.map((dl) => ({ key: dl.key, die: dl.die }));
  try {
    cl.time = 10;
    for (const dl of cl_dlights) {
      dl.key = 0;
      dl.die = 0;
    }

    const origin = new Float32Array([1, 2, 3]);
    CL_QexEffectLights(EF_QEX_QUADLIGHT, 5, origin);
    CL_QexEffectLights(EF_QEX_PENTALIGHT, 6, origin);
    CL_QexEffectLights(EF_QEX_CANDLELIGHT, 7, origin);

    const lights = cl_dlights.filter((dl) => dl.die >= cl.time);
    assert(lights.length === 2, `expected 2 dlights, got ${lights.length}`);
    for (const [key, color] of [[5, [0.25, 0.25, 1]], [6, [1, 0.25, 0.25]]]) {
      const dl = lights.find((l) => l.key === key);
      assert(dl !== undefined, `no dlight for key ${key}`);
      assert(
        dl.origin[0] === 1 && dl.origin[1] === 2 && dl.origin[2] === 3,
        `key ${key}: origin ${dl.origin}`,
      );
      assert(
        dl.radius >= 200 && dl.radius < 232 && Number.isInteger(dl.radius),
        `key ${key}: radius ${dl.radius}`,
      );
      assert(Math.abs(dl.die - 10.001) < 1e-9, `key ${key}: die ${dl.die}`);
      assert(
        dl.color.every((c, i) => c === color[i]),
        `key ${key}: color ${dl.color}`,
      );
    }

    // a slot reused for another light is white again
    const reused = CL_AllocDlight(5);
    assert(
      reused.color.every((c) => c === 1),
      `reused slot keeps color ${reused.color}`,
    );
  } finally {
    cl.time = oldTime;
    saved.forEach((s, i) => {
      cl_dlights[i].key = s.key;
      cl_dlights[i].die = s.die;
      cl_dlights[i].color.fill(1);
    });
  }
});

Deno.test("CL_LinkPacketEntities keeps the quad glow over a muzzle flash", () => {
  const old = {
    active: sv.active,
    maxclients: cl.maxclients,
    num: cl.num_entities,
    model: cl.model_precache[1],
    time: cl.time,
    m0: cl.mtime[0],
    m1: cl.mtime[1],
    demo: cls.demoplayback,
    timedemo: cls.timedemo,
  };
  const saved = cl_dlights.map((dl) => ({ key: dl.key, die: dl.die }));

  try {
    CL_ResetPrediction();
    sv.active = false;
    cls.demoplayback = false;
    cls.timedemo = false;
    cl.maxclients = 1;
    cl.num_entities = 3;
    cl.model_precache[1] = { name: "progs/soldier.mdl", flags: 0, synctype: 0 };
    cl.mtime[1] = 0.9;
    cl.mtime[0] = 1.0;
    cl.time = 1.0;
    for (const dl of cl_dlights) {
      dl.key = 0;
      dl.die = 0;
    }

    // a quad monster that fires: Ironwail lets the quad light win the slot
    CL_SetServerSequence(1);
    CL_SetValidSequence(1);
    const pak = CL_GetEntityFrame(1).packet_entities;
    pak.num_entities = 1;
    const s = pak.state(0);
    s.number = 2;
    s.modelindex = 1;
    s.effects = 0x0002 | EF_QEX_QUADLIGHT; // EF_MUZZLEFLASH
    CL_RelinkEntities();

    const lights = cl_dlights.filter((dl) => dl.key === 2 && dl.die >= cl.time);
    assert(
      lights.length === 1,
      `expected 1 dlight for entity 2, got ${lights.length}`,
    );
    assert(
      lights[0].color[2] === 1 && lights[0].color[0] === 0.25,
      `color ${lights[0].color}`,
    );
  } finally {
    CL_ResetPrediction();
    sv.active = old.active;
    cl.maxclients = old.maxclients;
    cl.num_entities = old.num;
    cl.model_precache[1] = old.model;
    cl.time = old.time;
    cl.mtime[0] = old.m0;
    cl.mtime[1] = old.m1;
    cls.demoplayback = old.demo;
    cls.timedemo = old.timedemo;
    saved.forEach((d, i) => {
      cl_dlights[i].key = d.key;
      cl_dlights[i].die = d.die;
      cl_dlights[i].color.fill(1);
    });
  }
});
