// Ported from: WinQuake/cl_parse.c -- parse a message received from the server

import {
  entity_state_t,
  MAX_CL_STATS,
  MAX_EDICTS,
  MAX_LIGHTSTYLES,
  MAX_MODELS,
  MAX_SCOREBOARD,
  MAX_SOUNDS,
  STAT_ACTIVEWEAPON,
  STAT_AMMO,
  STAT_ARMOR,
  STAT_CELLS,
  STAT_HEALTH,
  STAT_MONSTERS,
  STAT_NAILS,
  STAT_ROCKETS,
  STAT_SECRETS,
  STAT_SHELLS,
  STAT_WEAPON,
  STAT_WEAPONFRAME,
} from "./quakedef.js";
import {
  Con_DPrintf,
  Con_Printf,
  MSG_ANGLE_16,
  MSG_ANGLE_8,
  MSG_ANGLE_FLOAT,
  msg_badread,
  MSG_BeginReading,
  MSG_COORD_16,
  MSG_COORD_24,
  MSG_COORD_FLOAT,
  MSG_COORD_INT32_16,
  MSG_COORD_INT32_8,
  MSG_ReadAngle,
  MSG_ReadAngle16,
  MSG_ReadByte,
  MSG_ReadChar,
  MSG_ReadCoord,
  msg_readcount,
  MSG_ReadFloat,
  MSG_ReadLong,
  MSG_ReadShort,
  MSG_ReadString,
  MSG_SetCoordModes,
  MSG_WriteByte,
  net_message,
  standard_quake,
  SZ_Clear,
} from "./common.js";
import { Sys_FloatTime } from "./sys.js";
import { COM_EnsureFile, COM_FindFile } from "./pak.js";
import { Cbuf_AddServerText, Cbuf_AddText } from "./cmd.js";
import { Cmd_ExecuteString } from "./cmd.js";
import { src_command } from "./cmd.js";
import {
  B_ALPHA,
  B_LARGEFRAME,
  B_LARGEMODEL,
  B_SCALE,
  clc_nop,
  CM_ANGLE1,
  CM_ANGLE2,
  CM_ANGLE3,
  CM_BUTTONS,
  CM_FORWARD,
  CM_IMPULSE,
  CM_SIDE,
  CM_UP,
  DEFAULT_SOUND_PACKET_ATTENUATION,
  DEFAULT_SOUND_PACKET_VOLUME,
  DEFAULT_VIEWHEIGHT,
  ENTALPHA_DEFAULT,
  MAX_PACKET_ENTITIES,
  PE_ALPHA,
  PE_ANGLE1,
  PE_ANGLE2,
  PE_ANGLE3,
  PE_COLORMAP,
  PE_EFFECTS,
  PE_ENT_MASK,
  PE_FRAME,
  PE_FRAME2,
  PE_MODEL,
  PE_MOREBITS,
  PE_ORIGIN1,
  PE_ORIGIN2,
  PE_ORIGIN3,
  PE_REMOVE,
  PE_SKIN,
  PE_SOLID,
  PE_UPDATE_BACKUP,
  PF_ALPHA,
  PF_COMMAND,
  PF_EFFECTS,
  PF_MODEL,
  PF_MSEC,
  PF_SKINNUM,
  PF_TELEPORT,
  PF_VELOCITY1,
  PF_VELOCITY2,
  PF_VELOCITY3,
  PF_WEAPONFRAME,
  PRFL_24BITCOORD,
  PRFL_EDICTSCALE,
  PRFL_FLOATANGLE,
  PRFL_FLOATCOORD,
  PRFL_INT32COORD,
  PRFL_SHORTANGLE,
  PROTOCOL_FITZQUAKE,
  PROTOCOL_ICARO,
  PROTOCOL_RMQ,
  PROTOCOL_VERSION,
  PS_BOX,
  SND_ATTENUATION,
  SND_LARGEENTITY,
  SND_LARGESOUND,
  SND_VOLUME,
  SU_AMMO2,
  SU_ARMOR,
  SU_ARMOR2,
  SU_CELLS2,
  SU_EXTEND1,
  SU_EXTEND2,
  SU_IDEALPITCH,
  SU_INWATER,
  SU_NAILS2,
  SU_ONGROUND,
  SU_PUNCH1,
  SU_ROCKETS2,
  SU_SHELLS2,
  SU_VELOCITY1,
  SU_VIEWHEIGHT,
  SU_WEAPON,
  SU_WEAPON2,
  SU_WEAPONALPHA,
  SU_WEAPONFRAME,
  SU_WEAPONFRAME2,
  svc_achievement,
  svc_bf,
  svc_cdtrack,
  svc_centerprint,
  svc_clientdata,
  svc_cutscene,
  svc_damage,
  svc_deltapacketentities,
  svc_disconnect,
  svc_finale,
  svc_fog,
  svc_foundsecret,
  svc_intermission,
  svc_killedmonster,
  svc_lightstyle,
  svc_localsound,
  svc_nop,
  svc_packetentities,
  svc_particle,
  svc_playerinfo,
  svc_print,
  svc_sellscreen,
  svc_serverinfo,
  svc_serversequence,
  svc_setangle,
  svc_setpause,
  svc_setview,
  svc_signonnum,
  svc_skybox,
  svc_sound,
  svc_spawnbaseline,
  svc_spawnbaseline2,
  svc_spawnstatic,
  svc_spawnstatic2,
  svc_spawnstaticsound,
  svc_spawnstaticsound2,
  svc_stopsound,
  svc_stufftext,
  svc_temp_entity,
  svc_time,
  svc_updatecolors,
  svc_updatefrags,
  svc_updatename,
  svc_updatestat,
  svc_version,
  U_ALPHA,
  U_ANGLE1,
  U_ANGLE2,
  U_ANGLE3,
  U_COLORMAP,
  U_EFFECTS,
  U_EXTEND1,
  U_EXTEND2,
  U_FRAME,
  U_FRAME2,
  U_LERPFINISH,
  U_LONGENTITY,
  U_MODEL,
  U_MODEL2,
  U_MOREBITS,
  U_NOLERP,
  U_ORIGIN1,
  U_ORIGIN2,
  U_ORIGIN3,
  U_SCALE,
  U_SKIN,
} from "./protocol.js";
import {
  cl,
  CL_EnsureEntities,
  cl_entities,
  cl_lightstyle,
  cl_static_entities,
  cls,
  MAX_STATIC_ENTITIES,
  scoreboard_t,
  SIGNONS,
} from "./client.js";
import { VectorCopy } from "./mathlib.js";
import {
  V_ParseDamage,
  V_StopPitchDrift,
  V_UpdatePunchAngles,
} from "./view.js";
import { Mod_ForName } from "./gl_model.js";
import {
  CL_AcknowledgeCommand,
  CL_AcknowledgeTransportSequence,
  CL_FindAcknowledgedSequence,
  CL_GetEntityFrame,
  CL_GetServerSequence,
  CL_SetPlayerInfo,
  CL_SetServerSequence,
  CL_SetServerState,
  CL_SetValidSequence,
} from "./cl_pred.js";
import { R_TranslatePlayerSkin } from "./gl_rmisc.js";

// QuakeWorld model precache indices (set during CL_ParseServerInfo)
export let cl_playerindex = -1;
import { R_NewMap } from "./gl_rmisc.js";
import { vid } from "./vid.js";
import { R_WarmupStart } from "./gl_warmup.js";
import {
  LERP_FINISH,
  LERP_MOVESTEP,
  LERP_RESETANIM,
  LERP_RESETMOVE,
  R_AddEfrags,
  R_ParseParticleEffect,
} from "./render.js";
import { Host_EndGame, Host_Error, realtime, sv } from "./host.js";
import { NET_SendMessage } from "./net_main.js";
import { Loop_IsClientSocket } from "./net_loop.js";
import { CL_DemoFetchFile, CL_GetMessage } from "./cl_demo.js";
import { set_noclip_anglehack } from "./host_cmd.js";
import { CL_ClearState, cl_shownet, CL_SignonReply } from "./cl_main.js";
import { CL_ParseTEnt } from "./cl_tent.js";
import { Fog_ParseServerMessage } from "./gl_fog.js";
import { Sky_LoadSkyBox } from "./gl_sky.js";
import {
  S_LocalSound,
  S_PrecacheSound,
  S_StartSound,
  S_StaticSound,
  S_StopSound,
} from "./snd_dma.js";
import { CDAudio_Pause, CDAudio_Play, CDAudio_Resume } from "./cd_audio.js";
import {
  Con_ClearLastCenterString,
  Con_LogCenterPrint,
  SCR_CenterPrint,
} from "./gl_screen.js";

export const svc_strings = [
  "svc_bad",
  "svc_nop",
  "svc_disconnect",
  "svc_updatestat",
  "svc_version", // [long] server version
  "svc_setview", // [short] entity number
  "svc_sound", // <see code>
  "svc_time", // [float] server time
  "svc_print", // [string] null terminated string
  "svc_stufftext", // [string] stuffed into client\'s console buffer
  "svc_setangle", // [vec3] set the view angle to this absolute value

  "svc_serverinfo", // [long] version ...
  "svc_lightstyle", // [byte] [string]
  "svc_updatename", // [byte] [string]
  "svc_updatefrags", // [byte] [short]
  "svc_clientdata", // <shortbits + data>
  "svc_stopsound", // <see code>
  "svc_updatecolors", // [byte] [byte]
  "svc_particle", // [vec3] <variable>
  "svc_damage", // [byte] impact [byte] blood [vec3] from

  "svc_spawnstatic",
  "OBSOLETE svc_spawnbinary",
  "svc_spawnbaseline",

  "svc_temp_entity", // <variable>
  "svc_setpause",
  "svc_signonnum",
  "svc_centerprint",
  "svc_killedmonster",
  "svc_foundsecret",
  "svc_spawnstaticsound",
  "svc_intermission",
  "svc_finale", // [string] music [string] text
  "svc_cdtrack", // [byte] track [byte] looptrack
  "svc_sellscreen",
  "svc_cutscene",
];

/** This error checks and tracks the total number of entities */
export function CL_EntityNum(num) {
  //johnfitz -- check minimum number too (Ironwail cl_parse.c)
  if (num < 0) {
    Host_Error("CL_EntityNum: " + num + " is an invalid number");
  }

  if (num >= cl.num_entities) {
    if (num >= MAX_EDICTS) {
      Host_Error("CL_EntityNum: " + num + " is an invalid number");
    }
    CL_EnsureEntities(num + 1); // cl_entities grows on demand (client.js)
    while (cl.num_entities <= num) {
      cl_entities[cl.num_entities].colormap = null; // vid.colormap
      cl_entities[cl.num_entities].lerpflags |= LERP_RESETMOVE | LERP_RESETANIM; //johnfitz
      cl.num_entities++;
    }
  }

  return cl_entities[num];
}

export function CL_ParseStartSoundPacket() {
  const pos = _soundPos;

  const field_mask = MSG_ReadByte();

  let volume;
  if (field_mask & SND_VOLUME) {
    volume = MSG_ReadByte();
  } else {
    volume = DEFAULT_SOUND_PACKET_VOLUME;
  }

  let attenuation;
  if (field_mask & SND_ATTENUATION) {
    attenuation = MSG_ReadByte() / 64.0;
  } else {
    attenuation = DEFAULT_SOUND_PACKET_ATTENUATION;
  }

  // Ironwail cl_parse.c: large entity / large sound flags
  let ent, ch;
  if (field_mask & SND_LARGEENTITY) {
    ent = MSG_ReadShort() & 0xFFFF;
    ch = MSG_ReadByte();
  } else {
    const channel = MSG_ReadShort() & 0xFFFF;
    ent = channel >> 3;
    ch = channel & 7;
  }

  let sound_num;
  if (field_mask & SND_LARGESOUND) {
    sound_num = MSG_ReadShort() & 0xFFFF;
  } else {
    sound_num = MSG_ReadByte();
  }

  if (ent >= MAX_EDICTS) {
    Host_Error("CL_ParseStartSoundPacket: ent = %i", ent);
  }

  for (let i = 0; i < 3; i++) {
    pos[i] = MSG_ReadCoord();
  }

  const sfx = cl.sound_precache[sound_num];
  if (!sfx) {
    Con_Printf(
      "CL_ParseStartSoundPacket: sound_num %d not precached\n",
      sound_num,
    );
    return;
  }

  // Debug: log parsed sound packet
  if (cl_shownet.value >= 2) {
    Con_Printf(
      "svc_sound: %s (num=%d ent=%d ch=%d)\n",
      sfx.name,
      sound_num,
      ent,
      ch,
    );
  }

  S_StartSound(ent, ch, sfx, pos, volume / 255.0, attenuation);
}

// CL_ParseLocalSound - for 2021 rerelease
//
// Ported from Ironwail's cl_parse.c.
export function CL_ParseLocalSound() {
  const field_mask = MSG_ReadByte();
  const sound_num = (field_mask & SND_LARGESOUND) ?
    (MSG_ReadShort() & 0xFFFF) :
    MSG_ReadByte();

  const sfx = cl.sound_precache[sound_num];
  if (sfx == null) {
    // C dereferences the missing entry
    Con_Printf("CL_ParseLocalSound: sound_num %d not precached\n", sound_num);
    return;
  }

  S_LocalSound(sfx.name);
}

// CL_KeepaliveMessage
//
// When the client is taking a long time to load stuff, send keepalive messages
// so the server doesn't disconnect.
let _keepalive_lastmsg = 0;
// net_message is saved here while the queued messages are read (C's olddata)
let _keepalive_olddata = null;

export function CL_KeepaliveMessage() {
  if (sv.active) {
    return; // no need if server is local
  }
  if (cls.demoplayback) {
    return;
  }

  // read messages from server, should just be nops
  const oldsize = net_message.cursize;
  if (
    _keepalive_olddata === null ||
    _keepalive_olddata.length < net_message.data.length
  ) {
    _keepalive_olddata = new Uint8Array(net_message.data.length);
  }
  _keepalive_olddata.set(net_message.data.subarray(0, oldsize));

  let ret;
  do {
    ret = CL_GetMessage();
    switch (ret) {
      case 0:
        break; // nothing waiting
      case 1:
        Host_Error("CL_KeepaliveMessage: received a message");
        break;
      case 2:
        // C reads the byte with MSG_ReadByte, which would move the
        // read cursor of the message being parsed; peek at it instead.
        // CL_GetMessage has already dropped the nops, so this is a
        // real datagram. C errors here. Here WebTransport doesn't
        // order datagrams with the reliable stream, so an entity
        // update sent before a level change can still arrive after
        // svc_serverinfo: drop it instead (deviation for our transport).
        if (net_message.data[0] !== svc_nop) {
          Con_DPrintf("CL_KeepaliveMessage: dropped a stale datagram\n");
        }
        break;
      default:
        Host_Error("CL_KeepaliveMessage: CL_GetMessage failed");
    }
  } while (ret > 0);

  net_message.data.set(_keepalive_olddata.subarray(0, oldsize));
  net_message.cursize = oldsize;

  // check time
  const time = Sys_FloatTime();
  if (time - _keepalive_lastmsg < 5) {
    return;
  }
  _keepalive_lastmsg = time;

  // write out a nop
  // Precaching runs synchronously, so the transport only puts this on the
  // wire once control returns to the event loop.
  Con_Printf("--> client to server keepalive\n");

  MSG_WriteByte(cls.message, clc_nop);
  NET_SendMessage(cls.netcon, cls.message);
  SZ_Clear(cls.message);
}

export function CL_ParseServerInfo() {
  Con_DPrintf("Serverinfo packet received.\n");

  // wipe the client_state_t struct
  CL_ClearState();

  // parse protocol version number
  // Deviation (QuakeSpasm/Ironwail): id's C prints and returns at each of
  // the failure checks below, leaving the client half-connected with no
  // world. Host_Error drops back to the console instead.
  // Fitz/Ironwail accept several protocols; Icaro accepts NetQuake 15 (the
  // shareware attract demos) and its own PROTOCOL_ICARO (protocol.js)
  let i = MSG_ReadLong();
  if (CL_FindReader(i) === null) {
    Host_Error(
      "Server returned version " + i + ", not " + CL_SUPPORTED_PROTOCOLS,
    );
  }

  let protocolflags = 0;
  if (i === PROTOCOL_RMQ) {
    // mh - read protocol flags from server so that we know what protocol
    // features to expect
    protocolflags = MSG_ReadLong();
    if ((protocolflags & ~PRFL_SUPPORTED) !== 0) {
      Con_Printf(
        "\x02Warning: PROTOCOL_RMQ protocolflags %i contains unsupported flags\n",
        protocolflags,
      );
    }
  }
  CL_SetProtocol(i, protocolflags);

  // parse maxclients
  cl.maxclients = MSG_ReadByte();
  if (cl.maxclients < 1 || cl.maxclients > MAX_SCOREBOARD) {
    Host_Error("Bad maxclients (" + cl.maxclients + ") from server");
  }

  cl.scores = [];
  for (let j = 0; j < cl.maxclients; j++) {
    cl.scores.push(new scoreboard_t());
  }

  // parse gametype
  cl.gametype = MSG_ReadByte();

  // parse signon message
  const str = MSG_ReadString();
  cl.levelname = str.substring(0, 39);

  // seperate the printfs so the server message can have a color
  Con_Printf(
    "\n\n\x1d\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1f\n\n",
  );
  Con_Printf("\x02%s\n", str);

  // precache models
  cl.model_precache.fill(null);
  const model_precache = [];
  model_precache[0] = "";
  cl_playerindex = -1;
  let nummodels;
  for (nummodels = 1;; nummodels++) {
    const s = MSG_ReadString();
    if (s.length === 0) {
      break;
    }
    if (nummodels === MAX_MODELS) {
      Host_Error("Server sent too many model precaches"); // QS: was Con_Printf + return
    }

    model_precache[nummodels] = s;

    if (s === "progs/player.mdl") {
      cl_playerindex = nummodels;
    }
  }

  // precache sounds
  cl.sound_precache.fill(null);
  const sound_precache = [];
  sound_precache[0] = "";
  let numsounds;
  for (numsounds = 1;; numsounds++) {
    const s = MSG_ReadString();
    if (!s.length) {
      break;
    }
    if (numsounds === MAX_SOUNDS) {
      Host_Error("Server sent too many sound precaches"); // QS: was Con_Printf + return
    }

    sound_precache[numsounds] = s;
    // S_TouchSound( s );
  }

  // now we try to load everything else until a cache allocation fails

  // Lazy-load (web-only): if the world BSP isn't cached yet, fetch it on
  // demand and reconnect
  if (nummodels > 1 && COM_FindFile(model_precache[1]) === null) {
    Con_Printf("Fetching %s...\n", model_precache[1]);

    // A demo waits at this message for the map, then reads it again. The
    // rest of the message (svc_signonnum, sounds) is discarded: parsed now,
    // it would run against a client with no world.
    if (cls.demoplayback === true) {
      CL_DemoFetchFile(model_precache[1]);
      net_message.cursize = 0;
      return;
    }

    const addr = cls.netcon != null ? cls.netcon.address : null;
    COM_EnsureFile(model_precache[1]).then((success) => {
      if (success !== true) {
        Con_Printf("Couldn't fetch %s\n", model_precache[1]);
      } else if (addr != null) {
        Cbuf_AddText('connect "' + addr + '"\n');
      }
    });

    // Disconnect for the download. Staying connected let the rest of this
    // message (svc_signonnum) sign on a player with no map, holding a server
    // slot until the reconnect. Host_EndGame sends clc_disconnect and
    // discards the rest of the message, as C's longjmp does.
    Host_EndGame("fetching " + model_precache[1] + "\n");
  }

  for (i = 1; i < nummodels; i++) {
    cl.model_precache[i] = Mod_ForName(model_precache[i], false);
    if (cl.model_precache[i] === null) {
      Host_Error("Model " + model_precache[i] + " not found"); // QS: was Con_Printf + return
    }

    CL_KeepaliveMessage();
  }

  // S_BeginPrecaching();
  Con_DPrintf("Sound precache list:\n");
  for (i = 1; i < numsounds; i++) {
    cl.sound_precache[i] = S_PrecacheSound(sound_precache[i]);
    Con_DPrintf("  %d: %s\n", i, sound_precache[i]);
    CL_KeepaliveMessage();
  }
  // S_EndPrecaching();

  // local state
  cl_entities[0].model = cl.worldmodel = cl.model_precache[1];

  R_NewMap(cl);
  R_WarmupStart(cl); // web-only: compile the level's shaders behind the plaque

  // Hunk_Check();

  set_noclip_anglehack(false);

  Con_ClearLastCenterString(); //johnfitz
}

/**
 * Parse a QW-style delta-compressed entity state.
 * Can delta from either a baseline or a previous packet_entity.
 * Ported from: QW/client/cl_ents.c
 *
 * Deviation: QW packs the entity number and the high bits into one short.
 * Icaro's word is the entity number (and PE_REMOVE) alone, and the bits
 * follow in one or two bytes (see PE_* in protocol.js). The model index is a
 * short, PE_ALPHA adds an alpha byte at the end and PE_FRAME2 the frame's
 * high byte after it (Ironwail U_ALPHA and U_FRAME2).
 */
function CL_ParseDelta(from, to, word) {
  // set everything to the state we are delta'ing from
  to.copyFrom(from);

  to.number = word & PE_ENT_MASK;

  let bits = MSG_ReadByte();
  if (bits & PE_MOREBITS) {
    // read in the high order bits
    const i = MSG_ReadByte();
    bits |= i << 8;
  }

  to.flags = bits;

  if (bits & PE_MODEL) {
    to.modelindex = MSG_ReadShort() & 0xFFFF;
  }

  if (bits & PE_FRAME) {
    to.frame = MSG_ReadByte();
  }

  if (bits & PE_COLORMAP) {
    to.colormap = MSG_ReadByte();
  }

  if (bits & PE_SKIN) {
    to.skin = MSG_ReadByte();
  }

  if (bits & PE_EFFECTS) {
    to.effects = MSG_ReadByte();
  }

  if (bits & PE_ORIGIN1) {
    to.origin[0] = MSG_ReadCoord();
  }

  if (bits & PE_ANGLE1) {
    to.angles[0] = MSG_ReadAngle();
  }

  if (bits & PE_ORIGIN2) {
    to.origin[1] = MSG_ReadCoord();
  }

  if (bits & PE_ANGLE2) {
    to.angles[1] = MSG_ReadAngle();
  }

  if (bits & PE_ORIGIN3) {
    to.origin[2] = MSG_ReadCoord();
  }

  if (bits & PE_ANGLE3) {
    to.angles[2] = MSG_ReadAngle();
  }

  // prediction info, delta'd (see PE_SOLID in protocol.js)
  if (bits & PE_SOLID) {
    to.solid = MSG_ReadByte();
    if (to.solid & PS_BOX) {
      for (let i = 0; i < 3; i++) {
        to.mins[i] = MSG_ReadCoord();
      }
      for (let i = 0; i < 3; i++) {
        to.maxs[i] = MSG_ReadCoord();
      }
    }
  }

  if (bits & PE_ALPHA) {
    to.alpha = MSG_ReadByte();
  }

  // Ironwail cl_parse.c CL_ParseUpdate: U_FRAME2. PE_FRAME set the low
  // byte and cleared the high one.
  if (bits & PE_FRAME2) {
    to.frame = (to.frame & 0x00FF) | (MSG_ReadByte() << 8);
  }
}

// FlushEntityPacket
//
// Read and discard all entity data in the packet (on parse error).
// Ported from: QW/client/cl_ents.c
const _flushOlde = new entity_state_t();
const _flushNewe = new entity_state_t();

function FlushEntityPacket() {
  Con_DPrintf("FlushEntityPacket\n");

  CL_SetValidSequence(0); // can't render a frame

  const seq = CL_GetServerSequence();
  CL_GetEntityFrame(seq).invalid = true;

  // read it all, but ignore it
  while (true) {
    const word = MSG_ReadShort() & 0xFFFF;
    if (msg_badread) {
      Host_EndGame("msg_badread in packetentities");
      return;
    }

    if (word === 0) {
      break; // done
    }

    if (word & PE_REMOVE) {
      continue; // a removal carries no bits
    }

    CL_ParseDelta(_flushOlde, _flushNewe, word);
  }
}

/**
 * An svc_packetentities has just been parsed, deal with the
 * rest of the data stream.
 * Ported from: QW/client/cl_ents.c
 */
function CL_ParsePacketEntities(delta) {
  // Only PROTOCOL_ICARO's handler table has packet entities
  // First entity update completes the signon process
  // (same as CL_ParseUpdate does for NQ-style updates)
  if (cls.signon === SIGNONS - 1) {
    cls.signon = SIGNONS;
    CL_SignonReply();
  }

  const seq = CL_GetServerSequence();
  const eframe = CL_GetEntityFrame(seq);
  const newp = eframe.packet_entities;
  eframe.invalid = false;

  let oldpacket;
  if (delta) {
    const from = MSG_ReadByte();
    oldpacket = from;
  } else {
    oldpacket = -1;
  }

  let full = false;
  let oldp;
  if (oldpacket !== -1) {
    let frameDiff = (seq & 255) - oldpacket;
    if (frameDiff < 0) frameDiff += 256;
    if (frameDiff >= PE_UPDATE_BACKUP - 1) {
      // we can't use this, it is too old
      FlushEntityPacket();
      return;
    }

    CL_SetValidSequence(seq);
    oldp = CL_GetEntityFrame(oldpacket).packet_entities;
  } else {
    // this is a full update that we can start delta compressing from now
    oldp = _emptyPacket;
    CL_SetValidSequence(seq);
    full = true;
  }

  let oldindex = 0;
  let newindex = 0;
  newp.num_entities = 0;

  while (true) {
    const word = MSG_ReadShort() & 0xFFFF;
    if (msg_badread) {
      Host_EndGame("msg_badread in packetentities");
      return;
    }

    if (word === 0) {
      // copy all the rest of the entities from the old packet
      while (oldindex < oldp.num_entities) {
        if (newindex >= MAX_PACKET_ENTITIES) {
          Host_EndGame(
            "CL_ParsePacketEntities: newindex == MAX_PACKET_ENTITIES",
          );
          return;
        }

        newp.state(newindex).copyFrom(oldp.entities[oldindex]);
        newindex++;
        oldindex++;
      }

      break;
    }

    const newnum = word & PE_ENT_MASK;
    let oldnum = oldindex >= oldp.num_entities ?
      PE_NUM_END :
      oldp.entities[oldindex].number;

    // copy unchanged old entities that sort before this new entry
    while (newnum > oldnum) {
      if (full) {
        Con_Printf("WARNING: oldcopy on full update");
        FlushEntityPacket();
        return;
      }

      // copy one of the old entities over to the new packet unchanged
      if (newindex >= MAX_PACKET_ENTITIES) {
        Host_EndGame("CL_ParsePacketEntities: newindex == MAX_PACKET_ENTITIES");
        return;
      }

      newp.state(newindex).copyFrom(oldp.entities[oldindex]);
      newindex++;
      oldindex++;
      oldnum = oldindex >= oldp.num_entities ?
        PE_NUM_END :
        oldp.entities[oldindex].number;
    }

    if (newnum < oldnum) {
      // new from baseline
      if (word & PE_REMOVE) {
        if (full) {
          CL_SetValidSequence(0);
          Con_Printf("WARNING: U_REMOVE on full update\n");
          FlushEntityPacket();
          return;
        }

        continue;
      }

      if (newindex >= MAX_PACKET_ENTITIES) {
        Host_EndGame("CL_ParsePacketEntities: newindex == MAX_PACKET_ENTITIES");
        return;
      }

      CL_ParseDelta(CL_EntityBaseline(newnum), newp.state(newindex), word);
      newindex++;
      continue;
    }

    if (newnum === oldnum) {
      // delta from previous
      if (full) {
        CL_SetValidSequence(0);
        Con_Printf("WARNING: delta on full update");
      }

      if (word & PE_REMOVE) {
        oldindex++;
        continue;
      }

      if (newindex >= MAX_PACKET_ENTITIES) {
        Host_EndGame("CL_ParsePacketEntities: newindex == MAX_PACKET_ENTITIES");
        return;
      }

      CL_ParseDelta(oldp.entities[oldindex], newp.state(newindex), word);
      newindex++;
      oldindex++;
    }
  }

  newp.num_entities = newindex;
}

// QW's 9999 sentinel: past every entity number (PE_ENT_MASK is 32767)
const PE_NUM_END = PE_ENT_MASK + 1;

/**
 * The baseline to delta a new entity from. QW indexes cl_baselines directly;
 * cl_entities grows on demand here (client.js CL_EnsureEntities), so make sure
 * the slot exists. Numbers past MAX_EDICTS are a bad message.
 */
function CL_EntityBaseline(num) {
  if (num >= MAX_EDICTS) {
    Host_Error("CL_ParsePacketEntities: entity " + num + " >= MAX_EDICTS");
  }
  CL_EnsureEntities(num + 1);
  return cl_entities[num].baseline;
}

// Empty packet for full updates (no old data)
const _emptyPacket = { num_entities: 0, entities: [] };

// CL_ParseUpdate
//
// Parse an entity update message from the server
// If an entities model or origin changes from frame to frame, it must be
// relinked. Other attributes can change without relinking.
const bitcounts = new Int32Array(16);

// Reusable vectors for per-frame parsing (avoid per-call allocations)
const _soundPos = new Float32Array(3);
const _staticSoundOrg = new Float32Array(3);

// Cached buffers for CL_ParsePlayerInfo (Golden Rule #4)
const _playerinfo_origin = new Float32Array(3);
const _playerinfo_velocity = new Float32Array(3);
const _playerinfo_cmd_angles = new Float32Array(3);
const _playerinfo_cmd = {
  msec: 0,
  angles: _playerinfo_cmd_angles,
  forwardmove: 0,
  sidemove: 0,
  upmove: 0,
  buttons: 0,
  impulse: 0,
};

export function CL_ParseUpdate(bits) {
  if (cls.signon === SIGNONS - 1) {
    // first update is the final signon stage
    cls.signon = SIGNONS;
    CL_SignonReply();
  }

  if (bits & U_MOREBITS) {
    const i = MSG_ReadByte();
    bits |= i << 8;
  }

  let num;
  if (bits & U_LONGENTITY) {
    num = MSG_ReadShort();
  } else {
    num = MSG_ReadByte();
  }

  const ent = CL_EntityNum(num);

  for (let i = 0; i < 16; i++) {
    if (bits & (1 << i)) {
      bitcounts[i]++;
    }
  }

  let forcelink;
  if (ent.msgtime !== cl.mtime[1]) {
    forcelink = true; // no previous frame to lerp from
  } else {
    forcelink = false;
  }

  //johnfitz -- lerping
  if (ent.msgtime + 0.2 < cl.mtime[0]) { //more than 0.2 seconds since the last message (most entities think every 0.1 sec)
    ent.lerpflags |= LERP_RESETANIM; //if we missed a think, we'd be lerping from the wrong frame
  }
  //johnfitz

  ent.msgtime = cl.mtime[0];

  let modnum;
  if (bits & U_MODEL) {
    modnum = MSG_ReadByte();
    if (modnum >= MAX_MODELS) {
      Host_Error("CL_ParseModel: bad modnum");
    }
  } else {
    modnum = ent.baseline.modelindex;
  }

  const model = cl.model_precache[modnum];
  if (model !== ent.model) {
    ent.model = model;
    // automatic animation (torches, etc) can be either all together
    // or randomized
    if (model != null) {
      if (model.synctype === 1) { // ST_RAND
        ent.syncbase = (Math.random() * 0x7fff | 0) / 0x7fff;
      } else {
        ent.syncbase = 0.0;
      }
    } else {
      forcelink = true; // hack to make null model players work
    }

    if (num > 0 && num <= cl.maxclients) {
      R_TranslatePlayerSkin(num - 1);
    }

    ent.lerpflags |= LERP_RESETANIM; //johnfitz -- don't lerp animation across model changes
  }

  if (bits & U_FRAME) {
    ent.frame = MSG_ReadByte();
  } else {
    ent.frame = ent.baseline.frame;
  }

  let i;
  if (bits & U_COLORMAP) {
    i = MSG_ReadByte();
  } else {
    i = ent.baseline.colormap;
  }
  if (i === 0) {
    ent.colormap = null; // vid.colormap
  } else {
    // Deviation: id's C (and Ironwail) Sys_Error here, which in the browser
    // replaces the page. Bad server data drops to the console instead.
    if (i > cl.maxclients) {
      Host_Error(
        "CL_ParseUpdate: colormap " + i + " >= cl.maxclients (entity " + num +
          ")",
      );
    }

    ent.colormap = cl.scores[i - 1].translations;
  }

  let skin;
  if (bits & U_SKIN) {
    skin = MSG_ReadByte();
  } else {
    skin = ent.baseline.skin;
  }
  if (skin !== ent.skinnum) {
    ent.skinnum = skin;
    if (num > 0 && num <= cl.maxclients) {
      R_TranslatePlayerSkin(num - 1);
    }
  }

  if (bits & U_EFFECTS) {
    ent.effects = MSG_ReadByte();
  } else {
    ent.effects = ent.baseline.effects;
  }

  // NetQuake 15 has no U_ALPHA (Fitz/Ironwail): keep the baseline's
  ent.alpha = ent.baseline.alpha;

  // shift the known values for interpolation
  VectorCopy(ent.msg_origins[0], ent.msg_origins[1]);
  VectorCopy(ent.msg_angles[0], ent.msg_angles[1]);

  if (bits & U_ORIGIN1) {
    ent.msg_origins[0][0] = MSG_ReadCoord();
  } else {
    ent.msg_origins[0][0] = ent.baseline.origin[0];
  }
  if (bits & U_ANGLE1) {
    ent.msg_angles[0][0] = MSG_ReadAngle();
  } else {
    ent.msg_angles[0][0] = ent.baseline.angles[0];
  }

  if (bits & U_ORIGIN2) {
    ent.msg_origins[0][1] = MSG_ReadCoord();
  } else {
    ent.msg_origins[0][1] = ent.baseline.origin[1];
  }
  if (bits & U_ANGLE2) {
    ent.msg_angles[0][1] = MSG_ReadAngle();
  } else {
    ent.msg_angles[0][1] = ent.baseline.angles[1];
  }

  if (bits & U_ORIGIN3) {
    ent.msg_origins[0][2] = MSG_ReadCoord();
  } else {
    ent.msg_origins[0][2] = ent.baseline.origin[2];
  }
  if (bits & U_ANGLE3) {
    ent.msg_angles[0][2] = MSG_ReadAngle();
  } else {
    ent.msg_angles[0][2] = ent.baseline.angles[2];
  }

  // U_NOLERP is QS's U_STEP: the server sends it for MOVETYPE_STEP
  if (bits & U_NOLERP) {
    ent.lerpflags |= LERP_MOVESTEP; //johnfitz -- lerping for movetype_step entities
    ent.forcelink = true;
  } else {
    ent.lerpflags &= ~LERP_MOVESTEP;
  }

  if (forcelink) {
    // didn't have an update last message
    VectorCopy(ent.msg_origins[0], ent.msg_origins[1]);
    VectorCopy(ent.msg_origins[0], ent.origin);
    VectorCopy(ent.msg_angles[0], ent.msg_angles[1]);
    VectorCopy(ent.msg_angles[0], ent.angles);
    ent.forcelink = true;
  }
}

/**
 * Ironwail's CL_ParseUpdate under PROTOCOL_FITZQUAKE and PROTOCOL_RMQ: the
 * U_EXTEND1 and U_EXTEND2 bytes, and alpha, scale, a second frame and model
 * byte and the lerp finish time after the angles. The model is looked up
 * after U_MODEL2, as in Ironwail. Not ported: ST_FRAMETIME (gl_model.js has
 * no such synctype) and entity scale (entities have no scale field, so the
 * U_SCALE byte is read and dropped).
 */
function CL_ParseUpdateFitz(bits) {
  if (cls.signon === SIGNONS - 1) {
    // first update is the final signon stage
    cls.signon = SIGNONS;
    CL_SignonReply();
  }

  if (bits & U_MOREBITS) {
    bits |= MSG_ReadByte() << 8;
  }

  //johnfitz -- PROTOCOL_FITZQUAKE
  if (bits & U_EXTEND1) {
    bits |= MSG_ReadByte() << 16;
  }
  if (bits & U_EXTEND2) {
    bits |= MSG_ReadByte() << 24;
  }
  //johnfitz

  let num;
  if (bits & U_LONGENTITY) {
    num = MSG_ReadShort();
  } else {
    num = MSG_ReadByte();
  }

  const ent = CL_EntityNum(num);

  for (let i = 0; i < 16; i++) {
    if (bits & (1 << i)) {
      bitcounts[i]++;
    }
  }

  let forcelink;
  if (ent.msgtime !== cl.mtime[1]) {
    forcelink = true; // no previous frame to lerp from
  } else {
    forcelink = false;
  }

  //johnfitz -- lerping
  if (ent.msgtime + 0.2 < cl.mtime[0]) { //more than 0.2 seconds since the last message (most entities think every 0.1 sec)
    ent.lerpflags |= LERP_RESETANIM; //if we missed a think, we'd be lerping from the wrong frame
  }
  //johnfitz

  ent.msgtime = cl.mtime[0];

  let modnum;
  if (bits & U_MODEL) {
    modnum = MSG_ReadByte();
  } else {
    modnum = ent.baseline.modelindex;
  }

  if (bits & U_FRAME) {
    ent.frame = MSG_ReadByte();
  } else {
    ent.frame = ent.baseline.frame;
  }

  let i;
  if (bits & U_COLORMAP) {
    i = MSG_ReadByte();
  } else {
    i = ent.baseline.colormap;
  }
  if (i === 0) {
    ent.colormap = null; // vid.colormap
  } else {
    // Deviation: Sys_Error in C (see CL_ParseUpdate)
    if (i > cl.maxclients) {
      Host_Error(
        "CL_ParseUpdate: colormap " + i + " >= cl.maxclients (entity " + num +
          ")",
      );
    }

    ent.colormap = cl.scores[i - 1].translations;
  }

  let skin;
  if (bits & U_SKIN) {
    skin = MSG_ReadByte();
  } else {
    skin = ent.baseline.skin;
  }
  if (skin !== ent.skinnum) {
    ent.skinnum = skin;
    if (num > 0 && num <= cl.maxclients) {
      R_TranslatePlayerSkin(num - 1);
    }
  }

  if (bits & U_EFFECTS) {
    ent.effects = MSG_ReadByte();
  } else {
    ent.effects = ent.baseline.effects;
  }

  // shift the known values for interpolation
  VectorCopy(ent.msg_origins[0], ent.msg_origins[1]);
  VectorCopy(ent.msg_angles[0], ent.msg_angles[1]);

  if (bits & U_ORIGIN1) {
    ent.msg_origins[0][0] = MSG_ReadCoord();
  } else {
    ent.msg_origins[0][0] = ent.baseline.origin[0];
  }
  if (bits & U_ANGLE1) {
    ent.msg_angles[0][0] = MSG_ReadAngle();
  } else {
    ent.msg_angles[0][0] = ent.baseline.angles[0];
  }

  if (bits & U_ORIGIN2) {
    ent.msg_origins[0][1] = MSG_ReadCoord();
  } else {
    ent.msg_origins[0][1] = ent.baseline.origin[1];
  }
  if (bits & U_ANGLE2) {
    ent.msg_angles[0][1] = MSG_ReadAngle();
  } else {
    ent.msg_angles[0][1] = ent.baseline.angles[1];
  }

  if (bits & U_ORIGIN3) {
    ent.msg_origins[0][2] = MSG_ReadCoord();
  } else {
    ent.msg_origins[0][2] = ent.baseline.origin[2];
  }
  if (bits & U_ANGLE3) {
    ent.msg_angles[0][2] = MSG_ReadAngle();
  } else {
    ent.msg_angles[0][2] = ent.baseline.angles[2];
  }

  //johnfitz -- lerping for movetype_step entities
  if (bits & U_NOLERP) {
    ent.lerpflags |= LERP_MOVESTEP;
    ent.forcelink = true;
  } else {
    ent.lerpflags &= ~LERP_MOVESTEP;
  }

  //johnfitz -- PROTOCOL_FITZQUAKE
  if (bits & U_ALPHA) {
    ent.alpha = MSG_ReadByte();
  } else {
    ent.alpha = ent.baseline.alpha;
  }
  if (bits & U_SCALE) {
    MSG_ReadByte(); // no entity scale (see above)
  }
  if (bits & U_FRAME2) {
    ent.frame = (ent.frame & 0x00FF) | (MSG_ReadByte() << 8);
  }
  if (bits & U_MODEL2) {
    modnum = (modnum & 0x00FF) | (MSG_ReadByte() << 8);
  }
  if (bits & U_LERPFINISH) {
    ent.lerpfinish = ent.msgtime + MSG_ReadByte() / 255;
    ent.lerpflags |= LERP_FINISH;
  } else {
    ent.lerpflags &= ~LERP_FINISH;
  }
  //johnfitz

  // Deviation: Ironwail checks only the U_MODEL byte; the check moves here
  // so it covers U_MODEL2 too
  if (modnum >= MAX_MODELS) {
    Host_Error("CL_ParseModel: bad modnum");
  }

  //johnfitz -- moved here from above
  const model = cl.model_precache[modnum];
  if (model !== ent.model) {
    ent.model = model;
    // automatic animation (torches, etc) can be either all together
    // or randomized
    if (model != null) {
      if (model.synctype === 1) { // ST_RAND
        ent.syncbase = (Math.random() * 0x7fff | 0) / 0x7fff;
      } else {
        ent.syncbase = 0.0;
      }
    } else {
      forcelink = true; // hack to make null model players work
    }
    if (num > 0 && num <= cl.maxclients) {
      R_TranslatePlayerSkin(num - 1);
    }

    ent.lerpflags |= LERP_RESETANIM; //johnfitz -- don't lerp animation across model changes
  }
  //johnfitz

  if (forcelink) {
    // didn't have an update last message
    VectorCopy(ent.msg_origins[0], ent.msg_origins[1]);
    VectorCopy(ent.msg_origins[0], ent.origin);
    VectorCopy(ent.msg_angles[0], ent.msg_angles[1]);
    VectorCopy(ent.msg_angles[0], ent.angles);
    ent.forcelink = true;
  }
}

// The message layouts: Ironwail's version argument (1 for id's messages, 2
// for FitzQuake's svc_spawnbaseline2 and friends), and Icaro's own.
/** id's layouts (NetQuake 15) */
const VERSION_NETQUAKE = 1;
/** FitzQuake's svc_spawnbaseline2, svc_spawnstatic2, svc_spawnstaticsound2 */
const VERSION_FITZ = 2;
/** PROTOCOL_ICARO's wide layouts (protocol.js). Not in C. */
const VERSION_ICARO = 3;

/** PROTOCOL_ICARO's baselines: Fitz's B_* fields, always present, no byte */
const B_ICARO = B_LARGEMODEL | B_LARGEFRAME | B_ALPHA;

/**
 * Ironwail added the version argument. Version 2 (FitzQuake) starts with a
 * byte of B_* bits; PROTOCOL_ICARO always has a short model index and frame
 * and an alpha byte (protocol.js); id's layout has none of them.
 * Entities have no scale field, so the B_SCALE byte is read and dropped.
 */
export function CL_ParseBaseline(ent, version) {
  let bits = 0;
  if (version === VERSION_FITZ) {
    bits = MSG_ReadByte();
  } else if (version === VERSION_ICARO) {
    bits = B_ICARO;
  }
  ent.baseline.modelindex = (bits & B_LARGEMODEL) !== 0 ?
    (MSG_ReadShort() & 0xFFFF) :
    MSG_ReadByte();
  ent.baseline.frame = (bits & B_LARGEFRAME) !== 0 ?
    (MSG_ReadShort() & 0xFFFF) :
    MSG_ReadByte();
  ent.baseline.colormap = MSG_ReadByte();
  ent.baseline.skin = MSG_ReadByte();
  for (let i = 0; i < 3; i++) {
    ent.baseline.origin[i] = MSG_ReadCoord();
    ent.baseline.angles[i] = MSG_ReadAngle();
  }

  ent.baseline.alpha = (bits & B_ALPHA) !== 0 ?
    MSG_ReadByte() :
    ENTALPHA_DEFAULT;
  if ((bits & B_SCALE) !== 0) {
    MSG_ReadByte(); // no entity scale
  }
}

/**
 * Server information pertaining to this client only. `version` picks the
 * weapon model's size: a byte in id's layout, a short in Icaro's.
 */
export function CL_ParseClientdata(bits, version = VERSION_NETQUAKE) {
  //johnfitz -- PROTOCOL_FITZQUAKE (Ironwail reads the bits here: unsigned short)
  bits &= 0xFFFF;
  if (bits & SU_EXTEND1) {
    bits |= MSG_ReadByte() << 16;
  }
  if (bits & SU_EXTEND2) {
    bits |= MSG_ReadByte() << 24;
  }
  //johnfitz

  if (bits & SU_VIEWHEIGHT) {
    cl.viewheight = MSG_ReadChar();
  } else {
    cl.viewheight = DEFAULT_VIEWHEIGHT;
  }

  if (bits & SU_IDEALPITCH) {
    cl.idealpitch = MSG_ReadChar();
  } else {
    cl.idealpitch = 0;
  }

  // Deliberate deviation, from QuakeSpasm/Ironwail (cl_parse.c
  // CL_ParseClientdata): preserve initial angles (mostly for savegames)
  if (cls.signon < SIGNONS) {
    V_StopPitchDrift();
  }

  VectorCopy(cl.mvelocity[0], cl.mvelocity[1]);
  for (let i = 0; i < 3; i++) {
    if (bits & (SU_PUNCH1 << i)) {
      cl.punchangle[i] = MSG_ReadChar();
    } else {
      cl.punchangle[i] = 0;
    }
    if (bits & (SU_VELOCITY1 << i)) {
      cl.mvelocity[0][i] = MSG_ReadChar() * 16;
    } else {
      cl.mvelocity[0][i] = 0;
    }
  }

  //johnfitz -- update v_punchangles (Ironwail, for v_gunkick 2)
  V_UpdatePunchAngles();

  // [always sent]  if (bits & SU_ITEMS)
  let i = MSG_ReadLong();

  if (cl.items !== i) {
    // set flash times
    // Sbar_Changed();
    for (let j = 0; j < 32; j++) {
      if ((i & (1 << j)) && !(cl.items & (1 << j))) {
        cl.item_gettime[j] = cl.time;
      }
    }
    cl.items = i;
  }

  cl.onground = (bits & SU_ONGROUND) !== 0;
  cl.inwater = (bits & SU_INWATER) !== 0;

  if (bits & SU_WEAPONFRAME) {
    cl.stats[STAT_WEAPONFRAME] = MSG_ReadByte();
  } else {
    cl.stats[STAT_WEAPONFRAME] = 0;
  }

  if (bits & SU_ARMOR) {
    i = MSG_ReadByte();
  } else {
    i = 0;
  }
  if (cl.stats[STAT_ARMOR] !== i) {
    cl.stats[STAT_ARMOR] = i;
    // Sbar_Changed();
  }

  if (bits & SU_WEAPON) { // a short under PROTOCOL_ICARO (MAX_MODELS 4096)
    i = version === VERSION_ICARO ? (MSG_ReadShort() & 0xFFFF) : MSG_ReadByte();
  } else {
    i = 0;
  }
  if (cl.stats[STAT_WEAPON] !== i) {
    cl.stats[STAT_WEAPON] = i;
    // Sbar_Changed();
  }

  i = MSG_ReadShort();
  if (cl.stats[STAT_HEALTH] !== i) {
    cl.stats[STAT_HEALTH] = i;
    // Sbar_Changed();
  }

  i = MSG_ReadByte();
  if (cl.stats[STAT_AMMO] !== i) {
    cl.stats[STAT_AMMO] = i;
    // Sbar_Changed();
  }

  for (i = 0; i < 4; i++) {
    const j = MSG_ReadByte();
    if (cl.stats[STAT_SHELLS + i] !== j) {
      cl.stats[STAT_SHELLS + i] = j;
      // Sbar_Changed();
    }
  }

  i = MSG_ReadByte();

  if (standard_quake) {
    if (cl.stats[STAT_ACTIVEWEAPON] !== i) {
      cl.stats[STAT_ACTIVEWEAPON] = i;
      // Sbar_Changed();
    }
  } else {
    if (cl.stats[STAT_ACTIVEWEAPON] !== (1 << i)) {
      cl.stats[STAT_ACTIVEWEAPON] = 1 << i;
      // Sbar_Changed();
    }
  }

  //johnfitz -- PROTOCOL_FITZQUAKE (Icaro sends only the last two; see
  // SU_EXTEND1 in protocol.js)
  if (bits & SU_WEAPON2) {
    cl.stats[STAT_WEAPON] |= MSG_ReadByte() << 8;
  }
  if (bits & SU_ARMOR2) {
    cl.stats[STAT_ARMOR] |= MSG_ReadByte() << 8;
  }
  if (bits & SU_AMMO2) {
    cl.stats[STAT_AMMO] |= MSG_ReadByte() << 8;
  }
  if (bits & SU_SHELLS2) {
    cl.stats[STAT_SHELLS] |= MSG_ReadByte() << 8;
  }
  if (bits & SU_NAILS2) {
    cl.stats[STAT_NAILS] |= MSG_ReadByte() << 8;
  }
  if (bits & SU_ROCKETS2) {
    cl.stats[STAT_ROCKETS] |= MSG_ReadByte() << 8;
  }
  if (bits & SU_CELLS2) {
    cl.stats[STAT_CELLS] |= MSG_ReadByte() << 8;
  }
  if (bits & SU_WEAPONFRAME2) {
    cl.stats[STAT_WEAPONFRAME] |= MSG_ReadByte() << 8;
  }
  if (bits & SU_WEAPONALPHA) {
    cl.viewent.alpha = MSG_ReadByte();
  } else {
    cl.viewent.alpha = ENTALPHA_DEFAULT;
  }
  //johnfitz

  //johnfitz -- lerping
  if (cl.viewent.model !== cl.model_precache[cl.stats[STAT_WEAPON]]) {
    cl.viewent.lerpflags |= LERP_RESETANIM; //don't lerp animation across model changes
  }
  //johnfitz

  // Update client-side prediction with authoritative server state
  // This provides the base position/velocity for prediction to build on
  if (cl.viewentity >= 1 && cl.viewentity < cl_entities.length) {
    // QuakeWorld-style reconciliation baseline:
    // use the latest transport-level ack from server.
    if (cls.netcon != null) {
      // hasAck, not a sign test: ackSequence is an int32 that wraps
      if (cls.netcon.hasAck === true) {
        CL_AcknowledgeTransportSequence(cls.netcon.ackSequence | 0);
      } else {
        const fallbackAckSeq = CL_FindAcknowledgedSequence(realtime);
        if (fallbackAckSeq >= 0) {
          CL_AcknowledgeCommand(fallbackAckSeq);
        }
      }
    }

    // Then set the server state on the newly acknowledged frame
    // This provides the base position/velocity for prediction replay
    const ent = cl_entities[cl.viewentity];
    CL_SetServerState(ent.msg_origins[0], cl.mvelocity[0], cl.onground);
  }
}

/**
 * QuakeWorld-style player info for client-side prediction.
 * Parses svc_playerinfo message containing player state for other players.
 */
function CL_ParsePlayerInfo() {
  const playernum = MSG_ReadByte();
  const flags = MSG_ReadShort();

  // Always read origin and frame
  const origin = _playerinfo_origin;
  origin[0] = MSG_ReadCoord();
  origin[1] = MSG_ReadCoord();
  origin[2] = MSG_ReadCoord();

  const frame = MSG_ReadShort() & 0xFFFF; // QW: a byte (protocol.js)

  // Read optional msec
  let msec = 0;
  if (flags & PF_MSEC) {
    msec = MSG_ReadByte();
  }

  // Read optional usercmd_t (delta compressed)
  let cmd = null;
  if (flags & PF_COMMAND) {
    const cmdbits = MSG_ReadByte();
    cmd = _playerinfo_cmd;
    cmd.msec = 0;
    _playerinfo_cmd_angles.fill(0);
    cmd.forwardmove = 0;
    cmd.sidemove = 0;
    cmd.upmove = 0;
    cmd.buttons = 0;
    cmd.impulse = 0;

    if (cmdbits & CM_ANGLE1) {
      cmd.angles[0] = MSG_ReadAngle16();
    }
    if (cmdbits & CM_ANGLE2) {
      cmd.angles[1] = MSG_ReadAngle16();
    }
    if (cmdbits & CM_ANGLE3) {
      cmd.angles[2] = MSG_ReadAngle16();
    }
    if (cmdbits & CM_FORWARD) {
      cmd.forwardmove = MSG_ReadShort();
    }
    if (cmdbits & CM_SIDE) {
      cmd.sidemove = MSG_ReadShort();
    }
    if (cmdbits & CM_UP) {
      cmd.upmove = MSG_ReadShort();
    }
    if (cmdbits & CM_BUTTONS) {
      cmd.buttons = MSG_ReadByte();
    }
    if (cmdbits & CM_IMPULSE) {
      cmd.impulse = MSG_ReadByte();
    }
  }

  // Read optional velocity
  const velocity = _playerinfo_velocity;
  velocity[0] = 0;
  velocity[1] = 0;
  velocity[2] = 0;
  if (flags & PF_VELOCITY1) {
    velocity[0] = MSG_ReadShort();
  }
  if (flags & PF_VELOCITY2) {
    velocity[1] = MSG_ReadShort();
  }
  if (flags & PF_VELOCITY3) {
    velocity[2] = MSG_ReadShort();
  }

  // Read optional model (default to player model if not specified)
  let modelindex = cl_playerindex;
  if (flags & PF_MODEL) { // a short (MAX_MODELS 4096); only Icaro servers send playerinfo
    modelindex = MSG_ReadShort() & 0xFFFF;
  }

  // Read optional skin
  let skin = 0;
  if (flags & PF_SKINNUM) {
    skin = MSG_ReadByte();
  }

  // Read optional effects
  let effects = 0;
  if (flags & PF_EFFECTS) {
    effects = MSG_ReadByte();
  }

  // Read optional weaponframe
  let weaponframe = 0;
  if (flags & PF_WEAPONFRAME) {
    weaponframe = MSG_ReadShort() & 0xFFFF; // QW: a byte
  }

  // Read optional teleport_time left (view player), 10 ms units
  let teleport = 0;
  if (flags & PF_TELEPORT) {
    teleport = MSG_ReadByte();
  }

  // Read optional alpha (Ironwail sends players with U_ALPHA)
  let alpha = ENTALPHA_DEFAULT;
  if (flags & PF_ALPHA) {
    alpha = MSG_ReadByte();
  }

  // Store the player info for prediction and rendering
  CL_SetPlayerInfo(
    playernum,
    origin,
    velocity,
    frame,
    flags,
    skin,
    effects,
    weaponframe,
    msec,
    cmd,
    modelindex,
    teleport,
    alpha,
  );
}

export function CL_NewTranslation(slot) {
  // Deviation: Sys_Error in id's C and Ironwail; Host_Error keeps the page
  if (slot > cl.maxclients) {
    Host_Error("CL_NewTranslation: slot > cl.maxclients");
  }

  R_TranslatePlayerSkin(slot);
}

export function CL_ParseStatic(version) { // Ironwail added the argument
  const i = cl.num_statics;
  if (i >= MAX_STATIC_ENTITIES) {
    Host_Error("Too many static entities");
  }
  const ent = cl_static_entities[i];
  cl.num_statics++;
  CL_ParseBaseline(ent, version);

  // copy it to the current state
  ent.model = cl.model_precache[ent.baseline.modelindex];
  ent.lerpflags |= LERP_RESETANIM; //johnfitz -- lerping
  ent.frame = ent.baseline.frame;
  ent.colormap = null; // vid.colormap
  ent.skinnum = ent.baseline.skin;
  ent.effects = ent.baseline.effects;
  ent.alpha = ent.baseline.alpha; //johnfitz -- alpha (Ironwail cl_parse.c)

  VectorCopy(ent.baseline.origin, ent.origin);
  VectorCopy(ent.baseline.angles, ent.angles);
  R_AddEfrags(ent);
}

export function CL_ParseStaticSound(version) { // Ironwail added the argument
  const org = _staticSoundOrg;
  for (let i = 0; i < 3; i++) {
    org[i] = MSG_ReadCoord();
  }
  // a short under svc_spawnstaticsound2 and PROTOCOL_ICARO (MAX_SOUNDS 2048)
  const sound_num = version === VERSION_NETQUAKE ?
    MSG_ReadByte() :
    (MSG_ReadShort() & 0xFFFF);
  const vol = MSG_ReadByte();
  const atten = MSG_ReadByte();

  S_StaticSound(cl.sound_precache[sound_num], org, vol, atten);
}

// CL_ParseStuffText
//
// QuakeSpasm/Ironwail: svc_stufftext text is held until a whole line has
// arrived, then each complete line goes to the command buffer. In id's C the
// text went straight to Cbuf_AddText, and Cbuf_Execute ran whatever was there,
// so a command split across two messages ran half-way. Ironwail's "//" and
// ProQuake handling is not ported: lines go to Cbuf_AddText as in id.
//
// Deviation (web-only): only the player's own local server is trusted. Lines
// from a remote host or a demo go to Cbuf_AddServerText, which runs only the
// commands cmd.js allows and keeps the cvars they change out of the saved
// config.
let cl_stuffcmdbuf = "";
let cl_stuffcmdbuf_local = false; // whose text cl_stuffcmdbuf holds

/**
 * Web-only: whether stuffed text comes from this browser's own server, a
 * single-player game or a room it hosts, both reached over the loopback
 */
export function CL_StuffTextIsLocal() {
  return cls.demoplayback === false && sv.active === true &&
    Loop_IsClientSocket(cls.netcon) === true;
}

export function CL_ParseStuffText(msg) {
  // a fragment never completes a line from another source
  const local = CL_StuffTextIsLocal();
  if (local !== cl_stuffcmdbuf_local) {
    cl_stuffcmdbuf = "";
    cl_stuffcmdbuf_local = local;
  }

  // q_strlcat into the 1024-byte cl.stuffcmdbuf truncates the same way
  cl_stuffcmdbuf = (cl_stuffcmdbuf + msg).substring(0, 1023);
  const end = cl_stuffcmdbuf.lastIndexOf("\n");
  if (end === -1) {
    return;
  }

  if (local === true) {
    Cbuf_AddText(cl_stuffcmdbuf.substring(0, end + 1));
  } else {
    Cbuf_AddServerText(cl_stuffcmdbuf.substring(0, end + 1));
  }
  cl_stuffcmdbuf = cl_stuffcmdbuf.substring(end + 1);
}

// Ironwail clears cl.stuffcmdbuf with the rest of client_state_t
export function CL_ClearStuffText() {
  cl_stuffcmdbuf = "";
}

// The svc handlers. CL_ParseServerMessage looks each command byte up in the
// reader's table (see CL_SetProtocol) instead of id's switch; the bodies are
// the switch's cases. Each takes the command byte.

function CL_ParseIllegible(_cmd) {
  Host_Error("CL_ParseServerMessage: Illegible server message\n");
}

/** A command byte with the high bit set is a fast update (protocol 15) */
function CL_ParseFastUpdate(cmd) {
  CL_ParseUpdate(cmd & 127);
}

/** A fast update under PROTOCOL_FITZQUAKE and PROTOCOL_RMQ */
function CL_ParseFastUpdateFitz(cmd) {
  CL_ParseUpdateFitz(cmd & 127);
}

function CL_Parse_svc_nop(_cmd) {
  // Con_Printf( 'svc_nop\n' );
}

function CL_Parse_svc_time(_cmd) {
  cl.mtime[1] = cl.mtime[0];
  cl.mtime[0] = MSG_ReadFloat();
}

function CL_Parse_svc_clientdata(_cmd) {
  CL_ParseClientdata(MSG_ReadShort(), VERSION_NETQUAKE);
}

function CL_Parse_svc_clientdata_icaro(_cmd) {
  CL_ParseClientdata(MSG_ReadShort(), VERSION_ICARO);
}

function CL_Parse_svc_version(_cmd) {
  const i = MSG_ReadLong();
  // Ironwail: accept any supported protocol and switch to it
  if (CL_SetProtocol(i, cl_protocolflags) === false) {
    Host_Error(
      "CL_ParseServerMessage: Server is protocol " + i + " instead of " +
        CL_SUPPORTED_PROTOCOLS,
    );
  }
}

function CL_Parse_svc_disconnect(_cmd) {
  Host_EndGame("Server disconnected\n");
}

function CL_Parse_svc_print(_cmd) {
  Con_Printf("%s", MSG_ReadString());
}

function CL_Parse_svc_centerprint(_cmd) {
  //johnfitz -- log centerprints to console
  const str = MSG_ReadString();
  SCR_CenterPrint(str);
  Con_LogCenterPrint(str);
}

function CL_Parse_svc_stufftext(_cmd) {
  CL_ParseStuffText(MSG_ReadString());
}

function CL_Parse_svc_damage(_cmd) {
  V_ParseDamage();
}

function CL_Parse_svc_serverinfo(_cmd) {
  CL_ParseServerInfo();
  vid.recalc_refdef = true; // leave intermission full screen
}

function CL_Parse_svc_setangle(_cmd) {
  for (let i = 0; i < 3; i++) {
    cl.viewangles[i] = MSG_ReadAngle();
  }
  VectorCopy(cl.viewangles, cl.setangles); // for V_CalcIntermissionRefdef
}

function CL_Parse_svc_setview(_cmd) {
  cl.viewentity = MSG_ReadShort();
}

function CL_Parse_svc_lightstyle(_cmd) {
  const i = MSG_ReadByte();
  // Deviation: Sys_Error in id's C and Ironwail; Host_Error keeps the page
  if (i >= MAX_LIGHTSTYLES) {
    Host_Error("svc_lightstyle > MAX_LIGHTSTYLES");
  }
  cl_lightstyle[i].map = MSG_ReadString();
  cl_lightstyle[i].length = cl_lightstyle[i].map.length;
}

function CL_Parse_svc_sound(_cmd) {
  CL_ParseStartSoundPacket();
}

function CL_Parse_svc_stopsound(_cmd) {
  const i = MSG_ReadShort();
  S_StopSound(i >> 3, i & 7);
}

function CL_Parse_svc_updatename(_cmd) {
  // Sbar_Changed();
  const i = MSG_ReadByte();
  if (i >= cl.maxclients) {
    Host_Error("CL_ParseServerMessage: svc_updatename > MAX_SCOREBOARD");
  }
  cl.scores[i].name = MSG_ReadString();
}

function CL_Parse_svc_updatefrags(_cmd) {
  // Sbar_Changed();
  const i = MSG_ReadByte();
  if (i >= cl.maxclients) {
    Host_Error("CL_ParseServerMessage: svc_updatefrags > MAX_SCOREBOARD");
  }
  cl.scores[i].frags = MSG_ReadShort();
}

function CL_Parse_svc_updatecolors(_cmd) {
  // Sbar_Changed();
  const i = MSG_ReadByte();
  if (i >= cl.maxclients) {
    Host_Error("CL_ParseServerMessage: svc_updatecolors > MAX_SCOREBOARD");
  }
  cl.scores[i].colors = MSG_ReadByte();
  CL_NewTranslation(i);
}

function CL_Parse_svc_particle(_cmd) {
  R_ParseParticleEffect();
}

function CL_Parse_svc_spawnbaseline(_cmd) {
  const i = MSG_ReadShort();
  // must use CL_EntityNum() to force cl.num_entities up
  CL_ParseBaseline(CL_EntityNum(i), VERSION_NETQUAKE);
}

function CL_Parse_svc_spawnbaseline_icaro(_cmd) {
  const i = MSG_ReadShort();
  CL_ParseBaseline(CL_EntityNum(i), VERSION_ICARO);
}

function CL_Parse_svc_spawnstatic(_cmd) {
  CL_ParseStatic(VERSION_NETQUAKE);
}

function CL_Parse_svc_spawnstatic_icaro(_cmd) {
  CL_ParseStatic(VERSION_ICARO);
}

function CL_Parse_svc_temp_entity(_cmd) {
  CL_ParseTEnt();
}

function CL_Parse_svc_setpause(_cmd) {
  cl.paused = MSG_ReadByte();
  if (cl.paused) {
    CDAudio_Pause();
  } else {
    CDAudio_Resume();
  }
}

function CL_Parse_svc_signonnum(_cmd) {
  const i = MSG_ReadByte();
  if (i <= cls.signon) {
    Host_Error("Received signon %i when at %i", i, cls.signon);
  }
  cls.signon = i;
  CL_SignonReply();
}

function CL_Parse_svc_killedmonster(_cmd) {
  cl.stats[STAT_MONSTERS]++;
}

function CL_Parse_svc_foundsecret(_cmd) {
  cl.stats[STAT_SECRETS]++;
}

function CL_Parse_svc_updatestat(_cmd) {
  const i = MSG_ReadByte();
  // Deviation: Sys_Error in id's C and Ironwail; Host_Error keeps the page
  if (i < 0 || i >= MAX_CL_STATS) {
    Host_Error("svc_updatestat: " + i + " is invalid");
  }
  cl.stats[i] = MSG_ReadLong();
}

function CL_Parse_svc_spawnstaticsound(_cmd) {
  CL_ParseStaticSound(VERSION_NETQUAKE);
}

function CL_Parse_svc_spawnstaticsound_icaro(_cmd) {
  CL_ParseStaticSound(VERSION_ICARO);
}

function CL_Parse_svc_skybox(_cmd) {
  Sky_LoadSkyBox(MSG_ReadString());
}

function CL_Parse_svc_bf(_cmd) {
  Cmd_ExecuteString("bf", src_command);
}

function CL_Parse_svc_fog(_cmd) {
  Fog_ParseServerMessage();
}

function CL_Parse_svc_spawnbaseline2(_cmd) {
  const i = MSG_ReadShort();
  // must use CL_EntityNum() to force cl.num_entities up
  CL_ParseBaseline(CL_EntityNum(i), VERSION_FITZ);
}

function CL_Parse_svc_spawnstatic2(_cmd) {
  CL_ParseStatic(VERSION_FITZ);
}

function CL_Parse_svc_spawnstaticsound2(_cmd) {
  CL_ParseStaticSound(VERSION_FITZ);
}

function CL_Parse_svc_cdtrack(_cmd) {
  cl.cdtrack = MSG_ReadByte();
  cl.looptrack = MSG_ReadByte();
  if ((cls.demoplayback || cls.demorecording) && (cls.forcetrack !== -1)) {
    CDAudio_Play(cls.forcetrack, true);
  } else {
    CDAudio_Play(cl.cdtrack, true);
  }
}

function CL_Parse_svc_intermission(_cmd) {
  cl.intermission = 1;
  cl.completed_time = cl.time;
  vid.recalc_refdef = true; // go to full screen
}

function CL_Parse_svc_finale(_cmd) {
  cl.intermission = 2;
  cl.completed_time = cl.time;
  vid.recalc_refdef = true; // go to full screen
  //johnfitz -- log centerprints to console
  const str = MSG_ReadString();
  SCR_CenterPrint(str);
  Con_LogCenterPrint(str);
}

function CL_Parse_svc_cutscene(_cmd) {
  cl.intermission = 3;
  cl.completed_time = cl.time;
  vid.recalc_refdef = true; // go to full screen
  //johnfitz -- log centerprints to console
  const str = MSG_ReadString();
  SCR_CenterPrint(str);
  Con_LogCenterPrint(str);
}

function CL_Parse_svc_sellscreen(_cmd) {
  Cmd_ExecuteString("help", src_command);
}

function CL_Parse_svc_playerinfo(_cmd) {
  CL_ParsePlayerInfo();
}

function CL_Parse_svc_serversequence(_cmd) {
  CL_SetServerSequence(MSG_ReadLong());
}

function CL_Parse_svc_packetentities(_cmd) {
  CL_ParsePacketEntities(false);
}

function CL_Parse_svc_deltapacketentities(_cmd) {
  CL_ParsePacketEntities(true);
}

// used by the 2021 re-release (Ironwail cl_parse.c). Ironwail hands the id
// to Steam; there are no achievements here.
function CL_Parse_svc_achievement(_cmd) {
  Con_DPrintf("Ignoring svc_achievement (%s)\n", MSG_ReadString());
}

function CL_Parse_svc_localsound(_cmd) {
  CL_ParseLocalSound();
}

/**
 * A reader's handler table: 256 entries, one per command byte. `entries` is
 * a list of [svc, handler] pairs; other numbers below 128 are illegible, and
 * 128 to 255 go to `fastupdate`.
 */
function CL_BuildHandlers(entries, fastupdate) {
  const handlers = new Array(256).fill(CL_ParseIllegible);
  for (let i = 128; i < 256; i++) {
    handlers[i] = fastupdate;
  }
  for (let i = 0; i < entries.length; i++) {
    handlers[entries[i][0]] = entries[i][1];
  }
  return handlers;
}

/**
 * The handlers whose payload is the same under every protocol the client
 * reads: id's svcs (whose coordinates and angles follow the reader's modes)
 * and the two 2021 rerelease ones Ironwail reads under every protocol.
 */
function CL_SharedHandlers() {
  return [
    [svc_nop, CL_Parse_svc_nop],
    [svc_disconnect, CL_Parse_svc_disconnect],
    [svc_updatestat, CL_Parse_svc_updatestat],
    [svc_version, CL_Parse_svc_version],
    [svc_setview, CL_Parse_svc_setview],
    [svc_sound, CL_Parse_svc_sound],
    [svc_time, CL_Parse_svc_time],
    [svc_print, CL_Parse_svc_print],
    [svc_stufftext, CL_Parse_svc_stufftext],
    [svc_setangle, CL_Parse_svc_setangle],
    [svc_serverinfo, CL_Parse_svc_serverinfo],
    [svc_lightstyle, CL_Parse_svc_lightstyle],
    [svc_updatename, CL_Parse_svc_updatename],
    [svc_updatefrags, CL_Parse_svc_updatefrags],
    [svc_stopsound, CL_Parse_svc_stopsound],
    [svc_updatecolors, CL_Parse_svc_updatecolors],
    [svc_particle, CL_Parse_svc_particle],
    [svc_damage, CL_Parse_svc_damage],
    [svc_temp_entity, CL_Parse_svc_temp_entity],
    [svc_setpause, CL_Parse_svc_setpause],
    [svc_signonnum, CL_Parse_svc_signonnum],
    [svc_centerprint, CL_Parse_svc_centerprint],
    [svc_killedmonster, CL_Parse_svc_killedmonster],
    [svc_foundsecret, CL_Parse_svc_foundsecret],
    [svc_intermission, CL_Parse_svc_intermission],
    [svc_finale, CL_Parse_svc_finale],
    [svc_cdtrack, CL_Parse_svc_cdtrack],
    [svc_sellscreen, CL_Parse_svc_sellscreen],
    [svc_cutscene, CL_Parse_svc_cutscene],
    [svc_achievement, CL_Parse_svc_achievement],
    [svc_localsound, CL_Parse_svc_localsound],
  ];
}

/**
 * Ironwail's coordinate and angle modes from the protocol flags (common.c
 * MSG_ReadCoord and MSG_ReadAngle), in its order of precedence. With no
 * flags (protocols 15 and 666): short coordinates and byte angles.
 */
function CL_SetCoordModesFromFlags(flags) {
  let coordmode = MSG_COORD_16;
  if ((flags & PRFL_FLOATCOORD) !== 0) {
    coordmode = MSG_COORD_FLOAT;
  } else if ((flags & PRFL_INT32COORD) !== 0) {
    coordmode = MSG_COORD_INT32_16;
  } else if ((flags & PRFL_24BITCOORD) !== 0) {
    coordmode = MSG_COORD_24;
  }
  let anglemode = MSG_ANGLE_8;
  if ((flags & PRFL_FLOATANGLE) !== 0) {
    anglemode = MSG_ANGLE_FLOAT;
  } else if ((flags & PRFL_SHORTANGLE) !== 0) {
    anglemode = MSG_ANGLE_16;
  }
  MSG_SetCoordModes(coordmode, anglemode);
}

/** PROTOCOL_ICARO: int32 eighths and byte angles (protocol.js) */
function CL_SetCoordModesIcaro(_flags) {
  MSG_SetCoordModes(MSG_COORD_INT32_8, MSG_ANGLE_8);
}

// A protocol reader (docs/protocol-design.md, "Client dispatch"): the
// protocol number, the function that sets the coordinate and angle modes
// from the protocol flags, and the handler table. Not in C, where one switch
// in CL_ParseServerMessage tests cl.protocol inside the shared parsers.

/**
 * NetQuake 15 (id's demos): id's layouts, short coordinates. It has none of
 * Icaro's own svcs (42 and 47 to 49), which a protocol 15 stream never holds.
 */
const cl_reader_netquake = {
  protocol: PROTOCOL_VERSION,
  setmodes: CL_SetCoordModesFromFlags,
  handlers: CL_BuildHandlers([
    ...CL_SharedHandlers(),
    [svc_clientdata, CL_Parse_svc_clientdata],
    [svc_spawnbaseline, CL_Parse_svc_spawnbaseline],
    [svc_spawnstatic, CL_Parse_svc_spawnstatic],
    [svc_spawnstaticsound, CL_Parse_svc_spawnstaticsound],
  ], CL_ParseFastUpdate),
};

// FitzQuake 666 and RMQ 999 (Ironwail's demos and servers), read only: id's
// layouts plus FitzQuake's svcs 37 and 40 to 44 and its wider fast updates.
// Ironwail has no case for 38 (svc_botchat) or 45 to 51 and 53 to 55 (the
// rerelease's), so they stay illegible. Ironwail also reads 37 to 44 under
// protocol 15; this port's 15 reader keeps id's list, as before.
const cl_handlers_fitz = CL_BuildHandlers([
  ...CL_SharedHandlers(),
  [svc_clientdata, CL_Parse_svc_clientdata],
  [svc_spawnbaseline, CL_Parse_svc_spawnbaseline],
  [svc_spawnstatic, CL_Parse_svc_spawnstatic],
  [svc_spawnstaticsound, CL_Parse_svc_spawnstaticsound],
  [svc_skybox, CL_Parse_svc_skybox],
  [svc_bf, CL_Parse_svc_bf],
  [svc_fog, CL_Parse_svc_fog],
  [svc_spawnbaseline2, CL_Parse_svc_spawnbaseline2],
  [svc_spawnstatic2, CL_Parse_svc_spawnstatic2],
  [svc_spawnstaticsound2, CL_Parse_svc_spawnstaticsound2],
], CL_ParseFastUpdateFitz);

/** PROTOCOL_FITZQUAKE (666): short coordinates and byte angles, no flags */
const cl_reader_fitzquake = {
  protocol: PROTOCOL_FITZQUAKE,
  setmodes: CL_SetCoordModesFromFlags,
  handlers: cl_handlers_fitz,
};

/** PROTOCOL_RMQ (999): FitzQuake's messages with svc_serverinfo's PRFL_* */
const cl_reader_rmq = {
  protocol: PROTOCOL_RMQ,
  setmodes: CL_SetCoordModesFromFlags,
  handlers: cl_handlers_fitz,
};

/**
 * PROTOCOL_ICARO: the wide layouts in protocol.js, svc_playerinfo and the
 * packet entities. It keeps id's fast updates, which Icaro's server never
 * sends (docs/protocol-design.md step 3 may drop them).
 */
const cl_reader_icaro = {
  protocol: PROTOCOL_ICARO,
  setmodes: CL_SetCoordModesIcaro,
  handlers: CL_BuildHandlers([
    ...CL_SharedHandlers(),
    [svc_clientdata, CL_Parse_svc_clientdata_icaro],
    [svc_spawnbaseline, CL_Parse_svc_spawnbaseline_icaro],
    [svc_spawnstatic, CL_Parse_svc_spawnstatic_icaro],
    [svc_spawnstaticsound, CL_Parse_svc_spawnstaticsound_icaro],
    [svc_playerinfo, CL_Parse_svc_playerinfo],
    [svc_packetentities, CL_Parse_svc_packetentities],
    [svc_deltapacketentities, CL_Parse_svc_deltapacketentities],
    [svc_serversequence, CL_Parse_svc_serversequence],
  ], CL_ParseFastUpdate),
};

/** The protocols CL_FindReader knows, for error messages */
const CL_SUPPORTED_PROTOCOLS = PROTOCOL_VERSION + ", " + PROTOCOL_FITZQUAKE +
  ", " + PROTOCOL_RMQ + " or " + PROTOCOL_ICARO;

/** The PRFL_* flags CL_SetCoordModesFromFlags reads (Ironwail's list) */
const PRFL_SUPPORTED = PRFL_SHORTANGLE | PRFL_FLOATANGLE | PRFL_24BITCOORD |
  PRFL_FLOATCOORD | PRFL_EDICTSCALE | PRFL_INT32COORD;

/** The reader for a protocol number, or null if the client can't read it */
function CL_FindReader(protocol) {
  switch (protocol) {
    case PROTOCOL_VERSION:
      return cl_reader_netquake;
    case PROTOCOL_FITZQUAKE:
      return cl_reader_fitzquake;
    case PROTOCOL_RMQ:
      return cl_reader_rmq;
    case PROTOCOL_ICARO:
      return cl_reader_icaro;
    default:
      return null;
  }
}

// The reader in use. Icaro's until a server says otherwise, as the server
// writes it. Like the coordinate modes in common.js, it outlives
// CL_ClearState (which zeroes cl.protocol) until the next svc_serverinfo or
// svc_version.
let cl_reader = cl_reader_icaro;
// Ironwail's cl.protocolflags (client.js has no field for it)
let cl_protocolflags = 0;

/**
 * Selects the reader for `protocol` with the protocol flags `flags`, and
 * sets cl.protocol and the coordinate and angle modes. Returns false, and
 * changes nothing, if the client can't read the protocol.
 * svc_serverinfo and svc_version call it; tests and tools call it to read a
 * message without either.
 */
export function CL_SetProtocol(protocol, flags) {
  const reader = CL_FindReader(protocol);
  if (reader === null) {
    return false;
  }
  cl.protocol = protocol;
  cl_protocolflags = flags;
  cl_reader = reader;
  reader.setmodes(flags);
  return true;
}

export function CL_ParseServerMessage() {
  // if recording demos, copy the message out
  if (cl_shownet.value === 1) {
    Con_Printf("%i ", net_message.cursize);
  } else if (cl_shownet.value === 2) {
    Con_Printf("------------------\n");
  }

  cl.onground = false; // unless the server says otherwise

  // parse the message
  MSG_BeginReading();

  while (true) {
    if (msg_badread) {
      Host_Error("CL_ParseServerMessage: Bad server message");
    }

    const cmd = MSG_ReadByte();

    if (cmd === -1) {
      if (cl_shownet.value === 2) {
        Con_Printf("%3i:%s\n", msg_readcount - 1, "END OF MESSAGE");
      }

      // QS/Ironwail: some mods never send the \n, so flush a pending
      // partial line at the end of a short message. The size check avoids
      // flushing a line that a full (overflowing) message split in two.
      if (cl_stuffcmdbuf.length > 0 && net_message.cursize < 512) {
        CL_ParseStuffText("\n");
      }

      return; // end of message
    }

    if (cl_shownet.value === 2) {
      // if the high bit of the command byte is set, it is a fast update
      Con_Printf(
        "%3i:%s\n",
        msg_readcount - 1,
        (cmd & 128) !== 0 ? "fast update" : (svc_strings[cmd] ?? "unknown"),
      );
    }

    // svc_serverinfo and svc_version can change the reader mid-message
    cl_reader.handlers[cmd](cmd);
  }
}
