// Network path benchmark: per-client server send cost (SV_SendClientMessages:
// clientdata, playerinfo, packet entities, datagram copy) with N fake clients
// placed around a map, then the client side parsing the bytes that produced
// (CL_ParseServerMessage) and pmove/cl_pred replay of a command history.
//
//   deno run --allow-read tools/bench/net_bench.js [-clients N] [-frames N] [-runs N]
//       [-maps a,b[:dm|:coop]] [-mtu N] [-predcalls N] [-noclient] [-json]
//       [-base rerelease] [-hipnotic | -rogue | -game <dir>]
//
// Maps named dm*, or suffixed :dm, run as deathmatch; the rest as coop.
// Everything is seeded (Math.random is replaced), so the checksum of the bytes
// written per client only changes when the wire output does. Not part of the
// engine or the test suite. Prints median milliseconds per stage.

import {
  COM_AddGameDirectory,
  COM_AddPakSequence,
  COM_EnsureFile,
  COM_SetLooseFileBasePaths,
} from "../../src/pak.js";
import { COM_InitArgv, LOC_Init } from "../../src/common.js";
import { Cbuf_Init, Cmd_Init } from "../../src/cmd.js";
import { Host_InitCommands } from "../../src/host_cmd.js";
import {
  campaign,
  coop,
  deathmatch,
  horde,
  skill,
  sv_cheats,
} from "../../src/host.js";
import { Cvar_RegisterVariable } from "../../src/cvar.js";
import { Memory_Init } from "../../src/zone.js";
import { PR_Init } from "../../src/pr_edict.js";
import { PR_ExecuteProgram } from "../../src/pr_exec.js";
import {
  EDICT_NUM,
  EDICT_TO_PROG,
  PR_GetString,
  pr_global_struct,
} from "../../src/progs.js";
import {
  SV_ClearDatagram,
  SV_FatPVS,
  SV_Init,
  SV_SendClientMessages,
  SV_SpawnServer,
} from "../../src/sv_main.js";
import { SV_Physics, SV_SetFrametime } from "../../src/sv_phys.js";
import { SV_RunClients } from "../../src/sv_user.js";
import { SV_LinkEdict, SV_TestEntityPosition } from "../../src/world.js";
import { client_t, set_host_client, sv, svs } from "../../src/server.js";
import { MAX_NET_DRIVERS, net_drivers } from "../../src/net.js";
import { Mod_Init, R_InitTextures } from "../../src/gl_model.js";
import {
  GD_BASE_DIR,
  GD_BENCH_MAPS,
  GD_ID1_DIR,
  GD_PAK_PATH,
} from "../../server/game_data.js";

const args = Deno.args;
const CLIENT = !args.includes("-noclient");
function arg(name, def) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
}

const CLIENTS = Number(arg("-clients", "8"));
const FRAMES = Number(arg("-frames", "300"));
const RUNS = Number(arg("-runs", "5"));
const MTU = Number(arg("-mtu", "1200"));
const MAPS = arg("-maps", GD_BENCH_MAPS.net.join(",")).split(",");
const JSON_OUT = args.includes("-json");

const root = decodeURIComponent(
  new URL("../../static/", import.meta.url).pathname,
);
const BASE = arg("-base", null);
// without -base, the repository's data (server/game_data.js)
const basedir = BASE !== null ? root + BASE + "/" : GD_BASE_DIR;
const pak0 = BASE !== null ? basedir + "id1/pak0.pak" : GD_PAK_PATH;
const id1dir = BASE !== null ? basedir + "id1/" : GD_ID1_DIR;
const gameFlags = [];
const gameDirs = [];
for (const flag of ["-rogue", "-hipnotic"]) {
  if (args.includes(flag)) {
    gameFlags.push(flag);
    gameDirs.push(basedir + flag.slice(1));
  }
}

const GAME = arg("-game", null);
if (GAME !== null) {
  gameFlags.push("-game", GAME);
  gameDirs.push(basedir + GAME);
}

const realLog = console.log;
globalThis.__ICARO_QUIET_LOGS = true;
console.log = () => {};

COM_InitArgv(["bench", ...gameFlags]);
Memory_Init();
Cbuf_Init();
Cmd_Init();
Host_InitCommands();
PR_Init();
Mod_Init();
R_InitTextures();
SV_Init();
Cvar_RegisterVariable(campaign);
Cvar_RegisterVariable(horde);
Cvar_RegisterVariable(sv_cheats);

if (await COM_AddPakSequence(pak0) === 0) {
  throw new Error(pak0 + " missing");
}
for (const dir of gameDirs) {
  if (await COM_AddGameDirectory(dir) === 0) {
    throw new Error(dir + "/pak0.pak missing");
  }
}
LOC_Init();
COM_SetLooseFileBasePaths([
  ...gameDirs.toReversed().map((d) => d + "/"),
  ...(id1dir !== root ? [id1dir] : []),
  root,
]);

function median(a) {
  const s = [...a].sort((x, y) => x - y);
  return s[s.length >> 1];
}

function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// FNV-1a over bytes, continuing from h
function fnv(h, data, start, end) {
  for (let i = start; i < end; i++) {
    h = Math.imul(h ^ data[i], 16777619) >>> 0;
  }
  return h;
}

// Fake net driver: copies each datagram into an arena and records its size
const FAKE_DRIVER = MAX_NET_DRIVERS - 1;
const ARENA = 1 << 22;
const arena = new Uint8Array(ARENA);
let arenaPos = 0;
const sent = new Int32Array(3 * 4096); // per datagram: client index, offset, length
let sendCount = 0;
net_drivers[FAKE_DRIVER] = {
  initialized: true,
  CanSendMessage() {
    return true;
  },
  CanSendUnreliableMessage() {
    return true;
  },
  QSendMessage() {
    return 1;
  },
  QGetMessage() {
    return 0;
  },
  SendUnreliableMessage(sock, data) {
    arena.set(data.data.subarray(0, data.cursize), arenaPos);
    sent[sendCount++] = sock.index;
    sent[sendCount++] = arenaPos;
    sent[sendCount++] = data.cursize;
    arenaPos += data.cursize;
    return 1;
  },
};

// svs.clients for CLIENTS players
svs.maxclients = CLIENTS;
svs.maxclientslimit = Math.max(CLIENTS, 4);
svs.clients = [];
for (let i = 0; i < svs.maxclientslimit; i++) {
  svs.clients[i] = new client_t();
}

// Put the clients at the spots (item, weapon, monster and spawn origins) from
// which the most entities are visible, so the send path has plenty to write
const _org = new Float32Array(3);
function visibleFrom(x, y, z) {
  _org[0] = x;
  _org[1] = y;
  _org[2] = z;
  const pvs = SV_FatPVS(_org);
  let n = 0;
  for (let e = svs.maxclients + 1; e < sv.num_edicts; e++) {
    const ent = EDICT_NUM(e);
    if (ent.free === true || ent.v.modelindex === 0) {
      continue;
    }
    for (let i = 0; i < ent.num_leafs; i++) {
      const l = ent.leafnums[i];
      if (pvs[l >> 3] & (1 << (l & 7))) {
        n++;
        break;
      }
    }
  }

  return n;
}

function placeClients() {
  const spots = [];
  for (let e = svs.maxclients + 1; e < sv.num_edicts; e++) {
    const ent = EDICT_NUM(e);
    if (
      ent.free !== true && ent.v.modelindex !== 0 &&
      /^(item_|weapon_|monster_|info_player)/.test(
        PR_GetString(ent.v.classname),
      )
    ) {
      spots.push({
        e,
        score: visibleFrom(
          ent.v.origin[0],
          ent.v.origin[1],
          ent.v.origin[2] + 8,
        ),
      });
    }
  }

  spots.sort((a, b) => b.score - a.score || a.e - b.e);

  // a bot that starts inside a wall would be unsticking every move
  let placed = 0;
  for (let n = 0; n < spots.length && placed < svs.maxclients; n++) {
    const ent = svs.clients[placed].edict;
    const s = EDICT_NUM(spots[n].e);
    for (let k = 0; k < 3; k++) {
      ent.v.origin[k] = s.v.origin[k] + (k === 2 ? 8 : 0);
    }
    SV_LinkEdict(ent, false);
    if (SV_TestEntityPosition(ent) === null) {
      placed++;
    }
  }
}

function connectClients() {
  for (let i = 0; i < svs.maxclients; i++) {
    const client = svs.clients[i];
    Object.assign(client, new client_t());
    client.active = true;
    client.spawned = true;
    client.name = "bot" + i;
    client.edict = EDICT_NUM(i + 1);
    client.message.data = client.msgbuf;
    client.message.maxsize = client.msgbuf.length;
    client.message.allowoverflow = true;
    client.netconnection = {
      driver: FAKE_DRIVER,
      disconnected: false,
      address: "10.0.0." + i,
      maxdatagram: MTU,
      index: i,
      connecttime: 0,
    };
    client.cmd = { forwardmove: 0, sidemove: 0, upmove: 0 };
    client.lastcmd = {
      angles: new Float32Array(3),
      forwardmove: 0,
      sidemove: 0,
      upmove: 0,
      buttons: 0,
      impulse: 0,
      msec: 0,
    };
    set_host_client(client);
    const ent = client.edict;
    ent.clearFields();
    ent.v.colormap = i + 1;
    ent.v.team = (i & 3) + 1;
    pr_global_struct.time = sv.time;
    pr_global_struct.self = EDICT_TO_PROG(ent);
    PR_ExecuteProgram(pr_global_struct.ClientConnect);
    PR_ExecuteProgram(pr_global_struct.PutClientInServer);
  }
}

// One server frame of bot input: look around, run forward
function driveClients(frame) {
  for (let i = 0; i < svs.maxclients; i++) {
    const client = svs.clients[i];
    const lc = client.lastcmd;
    lc.angles[1] = (frame * 3 + i * 40) % 360;
    lc.forwardmove = 200;
    lc.sidemove = ((frame >> 4) & 1) === 0 ? 100 : -100;
    client.cmd.forwardmove = lc.forwardmove;
    client.cmd.sidemove = lc.sidemove;
    client.cmd.upmove = 0;
    client.edict.v.v_angle[1] = lc.angles[1];
  }
}

// Client half: parse the datagrams client 0 was sent, then replay commands
let C = null;
async function initClient() {
  await import("../../src/gl_rsurf.js"); // the client graph's safe import order
  C = {
    parse: await import("../../src/cl_parse.js"),
    client: await import("../../src/client.js"),
    pred: await import("../../src/cl_pred.js"),
    common: await import("../../src/common.js"),
    protocol: await import("../../src/protocol.js"),
  };
  const msg = new C.common.sizebuf_t();
  msg.data = new Uint8Array(65536);
  msg.maxsize = 65536;
  C.msg = msg;
  C.common.COM_SetNetMessage(msg);
  C.pred.CL_InitPrediction(); // cvars and the pmove box hull
}

if (CLIENT) {
  await initClient();
}

const PRED_CALLS = Number(arg("-predcalls", "2000"));

function clientBench(packets) {
  const { parse, client, pred, protocol } = C;
  const { cl, cls } = client;
  const parseTimes = [];
  const predTimes = [];
  let parseHash = 0, predAcc = 0;

  for (let run = 0; run < RUNS; run++) {
    pred.CL_ResetPrediction();
    cl.worldmodel = sv.worldmodel;
    cl.viewentity = 1;
    cl.maxclients = CLIENTS;
    parse.CL_SetProtocol(protocol.PROTOCOL_ICARO, 0);
    cl.num_entities = 0;
    cls.signon = client.SIGNONS;
    cls.state = client.ca_connected;
    cls.netcon = null;
    for (
      let i = 0;
      i < sv.model_precache.length && sv.model_precache[i] != null;
      i++
    ) {
      cl.model_precache[i] = sv.models[i] ?? null;
    }
    for (let e = 1; e < sv.num_edicts; e++) {
      parse.CL_EntityNum(e).baseline.copyFrom(EDICT_NUM(e).baseline);
    }

    let t = 0;
    let h = 2166136261;
    for (const pkt of packets) {
      C.msg.data.set(pkt);
      C.msg.cursize = pkt.length;
      const t0 = performance.now();
      parse.CL_ParseServerMessage();
      t += performance.now() - t0;

      // what the client now holds: the newest entity frame and the stats
      const pe =
        pred.CL_GetEntityFrame(pred.CL_GetServerSequence()).packet_entities;
      h = Math.imul(h ^ pe.num_entities, 16777619) >>> 0;
      for (let i = 0; i < pe.num_entities; i++) {
        const st = pe.entities[i];
        h = Math.imul(h ^ st.number, 16777619) >>> 0;
        h = Math.imul(
          h ^ st.modelindex ^ (st.frame << 8) ^ (st.effects << 20) ^
            (st.solid << 24),
          16777619,
        ) >>> 0;
        h = Math.imul(
          h ^ (st.origin[0] * 8 | 0) ^ (st.origin[1] * 8 | 0) * 3 ^
            (st.origin[2] * 8 | 0) * 5,
          16777619,
        ) >>> 0;
        h = Math.imul(h ^ (st.angles[1] | 0) ^ st.alpha << 16, 16777619) >>> 0;
      }

      for (let i = 0; i < 8; i++) {
        h = Math.imul(h ^ cl.stats[i], 16777619) >>> 0;
      }
      for (let j = 0; j < CLIENTS; j++) {
        const pp = pred.CL_GetPredictedPlayer(j);
        if (pp !== null) {
          h = Math.imul(
            h ^ (pp.state_origin[0] * 8 | 0) ^ pp.flags ^ pp.modelindex << 16,
            16777619,
          ) >>> 0;
        }
      }
    }

    parseTimes.push(t);
    parseHash = h;

    // prediction: replay 8 commands from the acknowledged state, per call
    const wasActive = sv.active;
    sv.active = false;
    cl.stats[0] = 100; // the bot may be dead; prediction skips the dead
    const cmd = {
      msec: 16,
      angles: new Float32Array(3),
      forwardmove: 200,
      sidemove: 0,
      upmove: 0,
      buttons: 0,
      impulse: 0,
    };
    const org = svs.clients[0].edict.v.origin;
    const vel = new Float32Array(3);
    let acc = 0;
    t = performance.now();
    for (let it = 0; it < PRED_CALLS; it++) {
      pred.CL_AcknowledgeCommand(pred.CL_GetOutgoingSequence() - 1);
      pred.CL_SetServerState(org, vel, true);
      for (let k = 0; k < 8; k++) {
        cmd.angles[1] = (it * 7 + k * 5) % 360;
        cmd.sidemove = (k & 1) !== 0 ? 100 : -100;
        cmd.buttons = (it & 15) === 0 ? 2 : 0; // a jump now and then
        pred.CL_StoreCommand(cmd, -1 + k * 0.01);
      }

      pred.CL_PredictMove();
      acc += pred.cl_simorg[0] + 3 * pred.cl_simorg[1] + 5 * pred.cl_simorg[2];
    }

    predTimes.push(performance.now() - t);
    predAcc = acc;
    sv.active = wasActive;
  }

  return {
    parse_us_per_packet: +(median(parseTimes) / packets.length * 1000).toFixed(
      2,
    ),
    parse_check: parseHash.toString(16),
    predict_us_per_call: +(median(predTimes) / PRED_CALLS * 1000).toFixed(2),
    predict_check: predAcc.toFixed(3),
  };
}

const results = {};

for (const spec of MAPS) {
  const [map, mode] = spec.split(":");
  const dm = mode === "dm" || (mode === undefined && /dm/.test(map));
  if (await COM_EnsureFile("maps/" + map + ".bsp") !== true) {
    realLog("skip " + map + " (not found)");
    continue;
  }

  const send = [];
  const captured = [];
  let checksum = 0, bytes = 0, packets = 0, visible = 0;
  for (let run = 0; run < RUNS; run++) {
    deathmatch.value = dm ? 1 : 0;
    deathmatch.string = dm ? "1" : "0";
    coop.value = dm ? 0 : 1;
    coop.string = dm ? "0" : "1";
    skill.value = 1;
    skill.string = "1";

    Math.random = mulberry32(42);
    for (const c of svs.clients) {
      c.active = false;
    }
    SV_SpawnServer(map);
    if (sv.active !== true) {
      throw new Error("could not spawn " + map);
    }
    SV_SetFrametime(0.1);

    connectClients();
    placeClients();

    let h = 2166136261;
    bytes = 0;
    packets = 0;
    let total = 0;
    for (let f = 0; f < FRAMES; f++) {
      SV_ClearDatagram();
      driveClients(f);
      SV_RunClients();
      SV_Physics();
      for (const c of svs.clients) {
        if (c.active === true) {
          c.delta_sequence = c.outgoing_sequence > 0 ?
            c.outgoing_sequence - 1 :
            -1; // acked a frame late
        }
      }

      arenaPos = 0;
      sendCount = 0;
      const t = performance.now();
      SV_SendClientMessages();
      total += performance.now() - t;

      for (let k = 0; k < sendCount; k += 3) {
        if (sent[k] === 0 && run === RUNS - 1) {
          captured.push(arena.slice(sent[k + 1], sent[k + 1] + sent[k + 2]));
        }
        h = Math.imul(h ^ sent[k], 16777619) >>> 0;
        h = fnv(h, arena, sent[k + 1], sent[k + 1] + sent[k + 2]);
        bytes += sent[k + 2];
        packets++;
      }
    }

    visible = 0;
    for (const c of svs.clients) {
      if (c.active === true) {
        visible +=
          c.frames[(c.outgoing_sequence - 1) & 63].entities.num_entities;
      }
    }
    visible = Math.round(visible / CLIENTS);
    send.push(total);
    checksum = h;
  }

  const cres = CLIENT ? clientBench(captured) : null;

  results[map] = {
    ...cres,
    mode: dm ? "dm" : "coop",
    edicts: sv.num_edicts,
    send_ms_per_frame: +(median(send) / FRAMES).toFixed(4),
    send_us_per_client_frame: +(median(send) / FRAMES / CLIENTS * 1000).toFixed(
      2,
    ),
    ents: visible,
    bytes_per_packet: Math.round(bytes / packets),
    checksum: checksum.toString(16),
  };
}

console.log = realLog;
if (JSON_OUT) {
  console.log(JSON.stringify(results, null, "\t"));
} else {
  console.log(
    `clients=${CLIENTS} frames=${FRAMES} runs=${RUNS} mtu=${MTU} (medians)`,
  );
  console.log(
    "map".padEnd(10) + "mode".padEnd(6) + "edicts".padStart(7) +
      "ents".padStart(6) + "B/pkt".padStart(7) + "send us/cl".padStart(12) +
      "parse us".padStart(10) + "pred us".padStart(9) +
      "  send checksum / parse / pred",
  );
  for (const [map, r] of Object.entries(results)) {
    console.log(
      map.padEnd(10) + r.mode.padEnd(6) + String(r.edicts).padStart(7) +
        String(r.ents).padStart(6) + String(r.bytes_per_packet).padStart(7) +
        String(r.send_us_per_client_frame).padStart(12) +
        String(r.parse_us_per_packet ?? "-").padStart(10) +
        String(r.predict_us_per_call ?? "-").padStart(9) + "  " + r.checksum +
        " " + (r.parse_check ?? "-") + " " + (r.predict_check ?? "-"),
    );
  }
}
