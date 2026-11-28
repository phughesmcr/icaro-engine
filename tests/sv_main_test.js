import { Con_SetPrintFunctions, sizebuf_t, SZ_Alloc } from "../src/common.js";
import {
  edict_t,
  pr_fielddefs,
  pr_global_struct,
  PR_SetFieldDefs,
  PR_SetGlobalStruct,
  PR_SetProgs,
  PR_SetStringsData,
  PR_SetSV,
  pr_strings_data,
  progs,
  sv as progs_sv,
} from "../src/progs.js";
import {
  DEFAULT_VIEWHEIGHT,
  SU_ITEMS,
  SU_WEAPON,
  svc_clientdata,
  svc_sound,
} from "../src/protocol.js";
import {
  client_t,
  host_client,
  set_host_client,
  sv,
  svs,
} from "../src/server.js";
import {
  net_activeconnections,
  set_net_activeconnections,
} from "../src/net.js";
import { GetEdictFieldValue } from "../src/pr_edict.js";
import { sv_player, SV_SetPlayer } from "../src/sv_phys.js";
import {
  SV_DropClient,
  SV_StartSound,
  SV_WriteClientdataToMessage,
} from "../src/sv_main.js";

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

Deno.test("SV_StartSound encodes the source edict index", () => {
  const oldProgsSV = progs_sv;
  const oldNumEdicts = sv.num_edicts;
  const oldMaxEdicts = sv.max_edicts;
  const oldSound1 = sv.sound_precache[1];
  const oldSound2 = sv.sound_precache[2];
  const oldDatagramData = sv.datagram.data;
  const oldDatagramMaxsize = sv.datagram.maxsize;
  const oldDatagramCursize = sv.datagram.cursize;
  const oldDatagramAllowoverflow = sv.datagram.allowoverflow;
  const oldDatagramOverflowed = sv.datagram.overflowed;

  try {
    PR_SetSV(sv);
    sv.num_edicts = 8;
    sv.max_edicts = 600;
    sv.sound_precache[1] = "test/entity.wav";
    sv.sound_precache[2] = null;
    sv.datagram.data = new Uint8Array(sv.datagram_buf.length);
    sv.datagram.maxsize = sv.datagram_buf.length;
    sv.datagram.cursize = 0;
    sv.datagram.allowoverflow = true;
    sv.datagram.overflowed = false;

    const entity = new edict_t(7, 105);
    SV_StartSound(entity, 3, "test/entity.wav", 255, 1);

    const data = sv.datagram.data;
    const packedChannel = data[2] | (data[3] << 8);
    assertEqual(sv.datagram.cursize, 17, "sound packet size"); // 5 + 3 int32 coords
    assertEqual(data[0], svc_sound, "service opcode");
    assertEqual(data[1], 0, "optional field mask");
    assertEqual(packedChannel >> 3, 7, "encoded entity index");
    assertEqual(packedChannel & 7, 3, "encoded sound channel");
    assertEqual(data[4], 1, "sound precache index");
  } finally {
    PR_SetSV(oldProgsSV);
    sv.num_edicts = oldNumEdicts;
    sv.max_edicts = oldMaxEdicts;
    sv.sound_precache[1] = oldSound1;
    sv.sound_precache[2] = oldSound2;
    sv.datagram.data = oldDatagramData;
    sv.datagram.maxsize = oldDatagramMaxsize;
    sv.datagram.cursize = oldDatagramCursize;
    sv.datagram.allowoverflow = oldDatagramAllowoverflow;
    sv.datagram.overflowed = oldDatagramOverflowed;
  }
});

function writeAndReadItems(ent) {
  const msg = new sizebuf_t();
  SZ_Alloc(msg, 64);
  SV_SetPlayer(ent);
  SV_WriteClientdataToMessage(ent, msg);

  const view = new DataView(msg.data.buffer, msg.data.byteOffset, msg.cursize);
  assertEqual(msg.data[0], svc_clientdata, "clientdata opcode");
  assertEqual(view.getUint16(1, true), SU_ITEMS | SU_WEAPON, "clientdata bits");
  assertEqual(msg.cursize, 17, "clientdata packet size"); // SU_WEAPON is a short
  return view.getUint32(3, true);
}

Deno.test("SV_WriteClientdataToMessage packs an optional items2 field", () => {
  const oldProgs = progs;
  const oldFieldDefs = pr_fielddefs;
  const oldGlobalStruct = pr_global_struct;
  const oldStringsData = pr_strings_data;
  const oldPlayer = sv_player;
  const items2Offset = 105;
  const ent = new edict_t(1, items2Offset + 1);

  ent.v.items = 0x00123456;
  ent.v.view_ofs[2] = DEFAULT_VIEWHEIGHT;

  try {
    PR_SetProgs({ numfielddefs: 1 });
    PR_SetFieldDefs([{ ofs: items2Offset, s_name: 1 }]);
    PR_SetStringsData(new TextEncoder().encode("\0items2\0"));
    PR_SetGlobalStruct({ serverflags: 5 });

    GetEdictFieldValue(ent, "__items2_initial_evict_a");
    GetEdictFieldValue(ent, "__items2_initial_evict_b");
    ent._fieldAccessor.setFloat(items2Offset, 3);
    assertEqual(writeAndReadItems(ent), 0x01923456, "items2 packed items");

    ent._fieldAccessor.setFloat(items2Offset, 0);
    assertEqual(writeAndReadItems(ent), 0x00123456, "zero items2 packed items");

    GetEdictFieldValue(ent, "__items2_present_evict_a");
    GetEdictFieldValue(ent, "__items2_present_evict_b");
    PR_SetProgs({ numfielddefs: 0 });
    PR_SetFieldDefs([]);
    assertEqual(
      writeAndReadItems(ent),
      0x50123456,
      "serverflags fallback items",
    );
  } finally {
    GetEdictFieldValue(ent, "__items2_absent_evict_a");
    GetEdictFieldValue(ent, "__items2_absent_evict_b");
    PR_SetProgs(oldProgs);
    PR_SetFieldDefs(oldFieldDefs);
    PR_SetGlobalStruct(oldGlobalStruct);
    PR_SetStringsData(oldStringsData);
    SV_SetPlayer(oldPlayer);
  }
});

Deno.test("SV_DropClient logs the removal with Sys_Printf, as WinQuake's host.c does", () => {
  const oldHostClient = host_client;
  const oldClients = svs.clients;
  const oldMaxclients = svs.maxclients;
  const oldConnections = net_activeconnections;
  const oldLog = console.log;
  const logged = [];
  const printed = [];

  try {
    const client = new client_t();
    client.active = true;
    client.name = "100%s";
    svs.clients = [client];
    svs.maxclients = 1;
    set_host_client(client);
    set_net_activeconnections(1);
    Con_SetPrintFunctions((fmt) => printed.push(String(fmt)), () => {});
    console.log = (line) => logged.push(line);

    SV_DropClient(true);
  } finally {
    console.log = oldLog;
    Con_SetPrintFunctions(null, null);
    svs.clients = oldClients;
    svs.maxclients = oldMaxclients;
    set_host_client(oldHostClient);
    set_net_activeconnections(oldConnections);
  }

  assertEqual(logged.join("|"), "Client 100%s removed\n", "system log");
  assertEqual(printed.length, 0, "nothing in the game console");
});
