// Ported from: WinQuake/pr_cmds.c -- QuakeC built-in functions

import { SV_BroadcastPrintf } from "./host.js";
import {
  COM_Parse,
  com_token,
  Con_DPrintf,
  Con_Printf,
  LOC_Format,
  LOC_GetString,
  LOC_HasPlaceholders,
  MSG_WriteAngle,
  MSG_WriteByte,
  MSG_WriteChar,
  MSG_WriteCoord,
  MSG_WriteLong,
  MSG_WriteShort,
  MSG_WriteString,
} from "./common.js";
import {
  anglemod,
  AngleVectors,
  CrossProduct,
  DotProduct,
  Length,
  M_PI,
  vec3_origin,
  VectorAdd,
  VectorCopy,
  VectorMA,
  VectorNormalize,
  VectorScale,
  VectorSubtract,
} from "./mathlib.js";
import { MAX_LIGHTSTYLES, MAX_MODELS, MAX_SOUNDS } from "./quakedef.js";
import {
  ev_entity,
  ev_float,
  ev_string,
  ev_vector,
  OFS_PARM0,
  OFS_PARM1,
  OFS_PARM2,
  OFS_PARM3,
  OFS_PARM4,
  OFS_RETURN,
} from "./pr_comp.js";
import {
  EDICT_NUM,
  EDICT_TO_PROG,
  G_EDICT,
  G_EDICTNUM,
  G_FLOAT,
  G_FLOAT_SET,
  G_INT,
  G_INT_SET,
  G_STRING,
  G_VECTOR,
  NUM_FOR_EDICT,
  pr_argc,
  PR_ClearZoneStrings,
  pr_functions,
  PR_GetString,
  pr_global_struct,
  PR_SetBuiltins,
  PR_SetTempString,
  PR_SetTrace,
  PR_SetXFunction,
  PR_strcmp_ofs,
  PR_UnzoneString,
  pr_xfunction,
  PR_ZoneString,
  PROG_TO_EDICT,
  RETURN_EDICT,
  STRINGTEMP_LENGTH,
  sv,
} from "./progs.js";
import { PF_sprintf_internal, Q_FloatToInt } from "./pr_sprintf.js";
import { Sys_Random } from "./sys.js";
import {
  ED_Alloc,
  ED_Free,
  ED_Print,
  ED_PrintEdicts,
  ED_PrintNum,
} from "./pr_edict.js";
import { PR_HostError, PR_RunError } from "./pr_exec.js";
import {
  SV_LeafTree,
  SV_LinkEdict,
  SV_Move,
  SV_MoveInto,
  SV_PointContents,
  trace_t,
} from "./world.js";
import {
  SV_CheckBottom,
  SV_Move_SetCallbacks,
  SV_movestep,
  SV_MoveToGoal as SV_MoveToGoal_Real,
} from "./sv_move.js";
import {
  sv_aim,
  SV_LocalSound,
  SV_ReserveSignonSpace,
  SV_StartParticle,
  SV_StartSound,
} from "./sv_main.js";
import {
  Cbuf_AddText,
  Cmd_AliasExists,
  Cmd_ExecuteString,
  Cmd_FindCommand,
  src_client,
} from "./cmd.js";
import { Cvar_FindVar, Cvar_Set, cvar_t, Cvar_VariableValue } from "./cvar.js";
import { SV_ClientCommandAllowed } from "./sv_user.js";
import {
  FL_FLY,
  FL_ONGROUND,
  FL_SWIM,
  host_client,
  set_host_client,
  ss_active,
  ss_loading,
  svs,
  teamplay,
} from "./server.js";
import { Mod_ForName, Mod_LeafPVS, Mod_PointInLeaf } from "./gl_model.js";
import {
  ENTALPHA_ZERO,
  svc_centerprint,
  svc_lightstyle,
  svc_print,
  svc_spawnstatic,
  svc_spawnstaticsound,
  svc_stufftext,
} from "./protocol.js";

// BUILT-IN FUNCTIONS

// Ironwail pr_cmds.c PF_GetStringArg: argument idx after the format string,
// localized
function PF_GetStringArg(idx, offset) {
  idx += offset;
  if (idx < 0 || idx >= pr_argc) {
    return "";
  }
  return LOC_GetString(G_STRING(OFS_PARM0 + idx * 3));
}

// Ironwail's PF_VarString: resolves 2021 rerelease "$key" strings, and fills
// "{}"/"{N}" placeholders in a localized format string with the arguments that
// follow it. With no localization loaded it only concatenates, as WinQuake.
function PF_VarString(first) {
  if (first >= pr_argc) {
    return "";
  }

  const format = LOC_GetString(G_STRING(OFS_PARM0 + first * 3));
  if (LOC_HasPlaceholders(format)) {
    return LOC_Format(format, PF_GetStringArg, first + 1);
  }

  // Use array.join() instead of string concatenation to avoid O(n²) allocations
  const parts = [format];
  for (let i = first + 1; i < pr_argc; i++) {
    parts.push(LOC_GetString(G_STRING(OFS_PARM0 + i * 3)));
  }

  return parts.join("");
}

/**
 * This is a TERMINAL error, which will kill off the entire server.
 * Dumps self.
 *
 * error(value)
 */
function PF_error() {
  const s = PF_VarString(0);
  Con_Printf(
    "======SERVER ERROR in %s:\n%s\n",
    PR_GetString(pr_xfunction.s_name),
    s,
  );
  const ed = PROG_TO_EDICT(pr_global_struct.self);
  ED_Print(ed);

  PR_HostError("Program error");
}

/**
 * Dumps out self, then an error message. The program is aborted and self is
 * removed, but the level can continue.
 *
 * objerror(value)
 */
function PF_objerror() {
  const s = PF_VarString(0);
  Con_Printf(
    "======OBJECT ERROR in %s:\n%s\n",
    PR_GetString(pr_xfunction.s_name),
    s,
  );
  const ed = PROG_TO_EDICT(pr_global_struct.self);
  ED_Print(ed);
  ED_Free(ed);

  // Deviation from id's C, which called Host_Error( "Program error" ) here
  // and ended the level. Ironwail and QuakeSpasm comment it out (johnfitz:
  // "by design, this should not be fatal"): self is freed and play goes on.
}

/**
 * Writes new values for v_forward, v_up, and v_right based on angles
 * makevectors(vector)
 */
function PF_makevectors() {
  const ang = G_VECTOR(OFS_PARM0);
  const forward = pr_global_struct.v_forward;
  const right = pr_global_struct.v_right;
  const up = pr_global_struct.v_up;
  AngleVectors(ang, forward, right, up);
}

/** setorigin (entity, origin) */
function PF_setorigin() {
  const e = G_EDICT(OFS_PARM0);
  const org = G_VECTOR(OFS_PARM1);
  VectorCopy(org, e.v.origin);
  SV_LinkEdict(e, false);
}

/**
 * the size box is rotated by the current angle
 *
 * setsize (entity, minvector, maxvector)
 */
function PF_setsize() {
  const e = G_EDICT(OFS_PARM0);
  const min = G_VECTOR(OFS_PARM1);
  const max = G_VECTOR(OFS_PARM2);

  for (let i = 0; i < 3; i++) {
    if (min[i] > max[i]) {
      PR_RunError("backwards mins/maxs");
    }
  }

  VectorCopy(min, e.v.mins);
  VectorCopy(max, e.v.maxs);
  VectorSubtract(max, min, e.v.size);

  SV_LinkEdict(e, false);
}

/** setmodel(entity, model) */
function PF_setmodel() {
  const e = G_EDICT(OFS_PARM0);
  const m = G_STRING(OFS_PARM1);

  // check to see if model was properly precached
  let i = 0;
  if (sv.model_precache) {
    for (i = 0; i < sv.model_precache.length; i++) {
      if (sv.model_precache[i] == null) break;
      if (sv.model_precache[i] === m) break;
    }

    if (i >= sv.model_precache.length || sv.model_precache[i] == null) {
      PR_RunError("no precache: %s\n", m);
    }
  }

  e.v.model = G_INT(OFS_PARM1);
  e.v.modelindex = i;

  // Set mins/maxs from model if available
  if (sv.models && sv.models[i]) {
    const mod = sv.models[i];
    VectorCopy(mod.mins, e.v.mins);
    VectorCopy(mod.maxs, e.v.maxs);
    VectorSubtract(mod.maxs, mod.mins, e.v.size);
  } else {
    VectorCopy(vec3_origin, e.v.mins);
    VectorCopy(vec3_origin, e.v.maxs);
    VectorCopy(vec3_origin, e.v.size);
  }

  SV_LinkEdict(e, false);
}

/**
 * broadcast print to everyone on server
 *
 * bprint(value)
 */
function PF_bprint() {
  const s = PF_VarString(0);
  SV_BroadcastPrintf("%s", s);
}

/**
 * single print to a specific client
 *
 * sprint(clientent, value)
 */
function PF_sprint() {
  const entnum = G_EDICTNUM(OFS_PARM0);
  const s = PF_VarString(1);

  if (entnum < 1 || entnum > (svs.maxclients || 1)) {
    Con_Printf("tried to sprint to a non-client\n");
    return;
  }

  const client = svs.clients[entnum - 1];
  if (client) {
    MSG_WriteByte(client.message, svc_print);
    MSG_WriteString(client.message, s);
  }
}

/**
 * single print to a specific client
 *
 * centerprint(clientent, value)
 */
function PF_centerprint() {
  const entnum = G_EDICTNUM(OFS_PARM0);
  const s = PF_VarString(1);

  if (entnum < 1 || entnum > (svs.maxclients || 1)) {
    Con_Printf("tried to sprint to a non-client\n");
    return;
  }

  const client = svs.clients[entnum - 1];
  if (client) {
    MSG_WriteByte(client.message, svc_centerprint);
    MSG_WriteString(client.message, s);
  }
}

/** vector normalize(vector) */
function PF_normalize() {
  const value1 = G_VECTOR(OFS_PARM0);

  let len = value1[0] * value1[0] + value1[1] * value1[1] +
    value1[2] * value1[2];
  len = Math.sqrt(len);

  const ret = G_VECTOR(OFS_RETURN);
  if (len === 0) {
    ret[0] = ret[1] = ret[2] = 0;
  } else {
    len = 1 / len;
    ret[0] = value1[0] * len;
    ret[1] = value1[1] * len;
    ret[2] = value1[2] * len;
  }
}

/** scalar vlen(vector) */
function PF_vlen() {
  const value1 = G_VECTOR(OFS_PARM0);

  let len = value1[0] * value1[0] + value1[1] * value1[1] +
    value1[2] * value1[2];
  len = Math.sqrt(len);

  G_FLOAT_SET(OFS_RETURN, len);
}

/** float vectoyaw(vector) */
function PF_vectoyaw() {
  const value1 = G_VECTOR(OFS_PARM0);
  let yaw;

  if (value1[1] === 0 && value1[0] === 0) {
    yaw = 0;
  } else {
    yaw = (Math.atan2(value1[1], value1[0]) * 180 / M_PI) | 0;
    if (yaw < 0) {
      yaw += 360;
    }
  }

  G_FLOAT_SET(OFS_RETURN, yaw);
}

/** vector vectoangles(vector) */
function PF_vectoangles() {
  const value1 = G_VECTOR(OFS_PARM0);
  let yaw, pitch;

  if (value1[1] === 0 && value1[0] === 0) {
    yaw = 0;
    if (value1[2] > 0) {
      pitch = 90;
    } else {
      pitch = 270;
    }
  } else {
    yaw = (Math.atan2(value1[1], value1[0]) * 180 / M_PI) | 0;
    if (yaw < 0) {
      yaw += 360;
    }

    const forward = Math.sqrt(value1[0] * value1[0] + value1[1] * value1[1]);
    pitch = (Math.atan2(value1[2], forward) * 180 / M_PI) | 0;
    if (pitch < 0) {
      pitch += 360;
    }
  }

  G_FLOAT_SET(OFS_RETURN, pitch);
  G_FLOAT_SET(OFS_RETURN + 1, yaw);
  G_FLOAT_SET(OFS_RETURN + 2, 0);
}

// PF_Random
//
// Returns a number from 0<= num < 1
//
// random()
function PF_random() {
  // The C returns ( rand() & 0x7fff ) / (float)0x7fff; Sys_Random keeps the
  // port's 0 <= num < 1 and can be seeded (see Sys_SetRandomSeed)
  G_FLOAT_SET(OFS_RETURN, Sys_Random());
}

/** particle(origin, color, count) */
function PF_particle() {
  const org = G_VECTOR(OFS_PARM0);
  const dir = G_VECTOR(OFS_PARM1);
  const color = G_FLOAT(OFS_PARM2);
  const count = G_FLOAT(OFS_PARM3);
  SV_StartParticle(org, dir, color, count);
}

function PF_ambientsound() {
  const pos = G_VECTOR(OFS_PARM0);
  const samp = G_STRING(OFS_PARM1);
  const vol = G_FLOAT(OFS_PARM2);
  const attenuation = G_FLOAT(OFS_PARM3);

  // find the sound in the precache list
  let soundnum;
  for (soundnum = 0; soundnum < MAX_SOUNDS; soundnum++) {
    if (sv.sound_precache[soundnum] == null) break;
    if (samp === sv.sound_precache[soundnum]) break;
  }

  if (soundnum >= MAX_SOUNDS || sv.sound_precache[soundnum] == null) {
    Con_Printf("no precache: %s\n", samp);
    return;
  }

  // PROTOCOL_ICARO (protocol.js): 4-byte coords and a short sound index
  SV_ReserveSignonSpace(1 + 3 * 4 + 2 + 1 + 1);

  // write it to the signon buffer
  MSG_WriteByte(sv.signon, svc_spawnstaticsound);
  for (let i = 0; i < 3; i++) {
    MSG_WriteCoord(sv.signon, pos[i]);
  }

  MSG_WriteShort(sv.signon, soundnum); // C: a byte
  MSG_WriteByte(sv.signon, (vol * 255) | 0);
  MSG_WriteByte(sv.signon, (attenuation * 64) | 0);
}

/**
 * Each entity can have eight independent sound sources, like voice,
 * weapon, feet, etc.
 */
function PF_sound() {
  const entity = G_EDICT(OFS_PARM0);
  const channel = G_FLOAT(OFS_PARM1) | 0;
  const sample = G_STRING(OFS_PARM2);
  const volume = (G_FLOAT(OFS_PARM3) * 255) | 0;
  const attenuation = G_FLOAT(OFS_PARM4);

  // id has Sys_Error; Host_Error is Ironwail's (deliberate deviation), so a
  // bad QuakeC sound() call ends the map instead of killing the engine
  if (volume < 0 || volume > 255) {
    PR_HostError("SV_StartSound: volume = " + volume);
  }

  if (attenuation < 0 || attenuation > 4) {
    PR_HostError("SV_StartSound: attenuation = " + attenuation.toFixed(6));
  }

  if (channel < 0 || channel > 7) {
    PR_HostError("SV_StartSound: channel = " + channel);
  }

  SV_StartSound(entity, channel, sample, volume, attenuation);
}

/** break() */
function PF_break() {
  Con_Printf("break statement\n");
  // In C this dumps to debugger; in JS we just log
  // deno-lint-ignore no-debugger
  debugger;
}

/**
 * Used for use tracing and shot targeting
 *
 * traceline (vector1, vector2, tryents, ignore)
 */
function PF_traceline() {
  const v1 = G_VECTOR(OFS_PARM0);
  const v2 = G_VECTOR(OFS_PARM1);
  const nomonsters = G_FLOAT(OFS_PARM2) | 0;
  const ent = G_EDICT(OFS_PARM3);

  // Deliberate deviation from id, taken from Ironwail/QuakeSpasm: some
  // progs.dat pass NaN vectors, which would poison the trace. Zero them in
  // place (G_VECTOR is a view on the globals), warning when developer is set.
  const v1nan = Number.isNaN(v1[0]) || Number.isNaN(v1[1]) ||
    Number.isNaN(v1[2]);
  const v2nan = Number.isNaN(v2[0]) || Number.isNaN(v2[1]) ||
    Number.isNaN(v2[2]);
  if (v1nan || v2nan) {
    Con_DPrintf(
      "NAN in traceline:\nv1(" + v1[0].toFixed(6) + " " + v1[1].toFixed(6) +
        " " + v1[2].toFixed(6) +
        ") v2(" + v2[0].toFixed(6) + " " + v2[1].toFixed(6) + " " +
        v2[2].toFixed(6) +
        ")\nentity " + NUM_FOR_EDICT(ent) + "\n",
    );
    if (v1nan) {
      v1[0] = v1[1] = v1[2] = 0;
    }
    if (v2nan) {
      v2[0] = v2[1] = v2[2] = 0;
    }
  }

  // the trace is copied into the globals below, before any other SV_Move or
  // QuakeC, so one scratch trace_t serves every traceline
  if (traceline_trace === null) {
    traceline_trace = new trace_t();
  }
  const trace = SV_MoveInto(
    v1,
    vec3_origin,
    vec3_origin,
    v2,
    nomonsters,
    ent,
    traceline_trace,
  );

  pr_global_struct.trace_allsolid = trace.allsolid ? 1 : 0;
  pr_global_struct.trace_startsolid = trace.startsolid ? 1 : 0;
  pr_global_struct.trace_fraction = trace.fraction;
  VectorCopy(trace.endpos, pr_global_struct.trace_endpos);
  VectorCopy(trace.plane.normal, pr_global_struct.trace_plane_normal);
  pr_global_struct.trace_plane_dist = trace.plane.dist;
  if (trace.ent != null) {
    pr_global_struct.trace_ent = EDICT_TO_PROG(trace.ent);
  } else {
    pr_global_struct.trace_ent = EDICT_TO_PROG(sv.edicts[0]);
  }
  pr_global_struct.trace_inopen = trace.inopen ? 1 : 0;
  pr_global_struct.trace_inwater = trace.inwater ? 1 : 0;
}

// PF_checkclient
//
// Returns a client (or object that has a client enemy) that would be a
// valid target.
let checkpvs = null;
let traceline_trace = null; // PF_traceline's scratch trace_t, made on first use

// Scratch vectors for builtins (Golden Rule #4). None of these builtins runs
// QuakeC while its scratch is live, except PF_walkmove, whose SV_movestep
// calls touch functions only after its last use of move.
const newcheck_org = new Float32Array(3);
const checkclient_view = new Float32Array(3);
const findradius_eorg = new Float32Array(3);
const walkmove_move = new Float32Array(3);
const droptofloor_end = new Float32Array(3);
const aim_start = new Float32Array(3);
const aim_dir = new Float32Array(3);
const aim_end = new Float32Array(3);
const aim_bestdir = new Float32Array(3);

// PF_checkclient's per-call leaf lookup, which Mod_PointInLeaf spends a lot of
// time on over the node objects ( every monster that is looking for a target
// calls it each frame ). It walks world.js's flat copy of the BSP tree, which
// holds the same plane values as doubles and applies the same test, so it
// picks the same leaf.

// The last leaf found for each entity's view point, by entity number: a
// monster standing still asks about the same point every frame. A slot holds
// x, y, z and the leaf index; NaN never matches, so an empty slot misses.
let leafmemo_key = new Float32Array(0);
let leafmemo_leaf = new Int32Array(0);
let leafmemo_tree = null; // the SV_LeafTree the memo's leaves belong to

// Mod_PointInLeaf( p, model )._leafIndex, remembering the answer for entnum
export function PF_LeafIndexForPoint(p, model, entnum) {
  const tree = SV_LeafTree(model);
  if (tree === null) {
    return Mod_PointInLeaf(p, model)._leafIndex;
  }

  if (tree !== leafmemo_tree) {
    leafmemo_tree = tree;
    leafmemo_key.fill(NaN);
  }

  if (entnum >= leafmemo_leaf.length) {
    const size = Math.max(entnum + 1, leafmemo_leaf.length * 2, 256);
    leafmemo_key = new Float32Array(size * 3).fill(NaN);
    leafmemo_leaf = new Int32Array(size);
  }

  const k = entnum * 3;
  const key = leafmemo_key;
  if (key[k] === p[0] && key[k + 1] === p[1] && key[k + 2] === p[2]) {
    return leafmemo_leaf[entnum];
  }

  const plane = tree.plane;
  const child = tree.child;
  const x = p[0], y = p[1], z = p[2];
  let node = 0;

  do {
    const o = node << 2;
    const d = x * plane[o] + y * plane[o + 1] + z * plane[o + 2] - plane[o + 3];
    node = child[(node << 1) + (d > 0 ? 0 : 1)];
  } while (node >= 0);

  key[k] = p[0];
  key[k + 1] = p[1];
  key[k + 2] = p[2];
  leafmemo_leaf[entnum] = ~node;
  return ~node;
}

function PF_newcheckclient(check) {
  // cycle to the next one
  if (check < 1) {
    check = 1;
  }
  if (check > svs.maxclients) {
    check = svs.maxclients;
  }

  let i;
  if (check === svs.maxclients) {
    i = 1;
  } else {
    i = check + 1;
  }

  let ent;
  for (;; i++) {
    if (i === svs.maxclients + 1) {
      i = 1;
    }

    ent = EDICT_NUM(i);

    if (i === check) {
      break; // didn't find anything else
    }

    if (ent.free) {
      continue;
    }
    if (ent.v.health <= 0) {
      continue;
    }
    if ((ent.v.flags | 0) & 128) { // FL_NOTARGET
      continue;
    }

    // anything that is a client, or has a client as an enemy
    break;
  }

  // get the PVS for the entity
  if (sv.worldmodel) {
    const org = newcheck_org;
    VectorAdd(ent.v.origin, ent.v.view_ofs, org);
    const leaf = Mod_PointInLeaf(org, sv.worldmodel);
    const pvs = Mod_LeafPVS(leaf, sv.worldmodel);
    const numBytes = (sv.worldmodel.numleafs + 7) >> 3;
    if (!checkpvs || checkpvs.length < numBytes) {
      checkpvs = new Uint8Array(numBytes);
    }
    checkpvs.set(pvs.subarray(0, numBytes));
  }

  return i;
}

function PF_checkclient() {
  // find a new check if on a new frame
  if (sv.time - sv.lastchecktime >= 0.1) {
    sv.lastcheck = PF_newcheckclient(sv.lastcheck);
    sv.lastchecktime = sv.time;
  }

  // return check if it might be visible
  const ent = EDICT_NUM(sv.lastcheck);
  if (ent.free || ent.v.health <= 0) {
    RETURN_EDICT(sv.edicts[0]);
    return;
  }

  // if current entity can't possibly see the check entity, return 0
  if (sv.worldmodel && checkpvs) {
    const self = PROG_TO_EDICT(pr_global_struct.self);
    const view = checkclient_view;
    VectorAdd(self.v.origin, self.v.view_ofs, view);
    // get leaf index: leaf._leafIndex is set during BSP load
    const l = PF_LeafIndexForPoint(view, sv.worldmodel, self.index) - 1;
    if (l < 0 || !(checkpvs[l >> 3] & (1 << (l & 7)))) {
      RETURN_EDICT(sv.edicts[0]);
      return;
    }
  }

  // might be able to see it
  RETURN_EDICT(ent);
}

/**
 * Sends text over to the client's execution buffer
 *
 * stuffcmd (clientent, value)
 */
function PF_stuffcmd() {
  const entnum = G_EDICTNUM(OFS_PARM0);
  if (entnum < 1 || entnum > (svs.maxclients || 1)) {
    PR_RunError("Parm 0 not a client");
  }

  const str = G_STRING(OFS_PARM1);
  const client = svs.clients[entnum - 1];
  if (client) {
    MSG_WriteByte(client.message, svc_stufftext);
    MSG_WriteString(client.message, str);
  }
}

/**
 * Sends text to the server's command buffer
 *
 * localcmd (string)
 */
function PF_localcmd() {
  const str = G_STRING(OFS_PARM0);
  Cbuf_AddText(str);
}

/** float cvar (string) */
function PF_cvar() {
  const str = G_STRING(OFS_PARM0);
  G_FLOAT_SET(OFS_RETURN, Cvar_VariableValue(str));
}

/** float cvar (string) */
function PF_cvar_set() {
  const varName = G_STRING(OFS_PARM0);
  const val = G_STRING(OFS_PARM1);
  Cvar_Set(varName, val);
}

/**
 * Returns a chain of entities that have origins within a spherical area
 *
 * findradius (origin, radius)
 */
function PF_findradius() {
  let chain = sv.edicts[0];

  const org = G_VECTOR(OFS_PARM0);
  const rad = G_FLOAT(OFS_PARM1);

  const eorg = findradius_eorg;

  for (let i = 1; i < sv.num_edicts; i++) {
    const ent = EDICT_NUM(i);
    if (ent.free) {
      continue;
    }
    if (ent.v.solid === 0) { // SOLID_NOT
      continue;
    }
    for (let j = 0; j < 3; j++) {
      eorg[j] = org[j] -
        (ent.v.origin[j] + (ent.v.mins[j] + ent.v.maxs[j]) * 0.5);
    }
    if (Length(eorg) > rad) {
      continue;
    }

    ent.v.chain = EDICT_TO_PROG(chain);
    chain = ent;
  }

  RETURN_EDICT(chain);
}

function PF_dprint() {
  Con_DPrintf("%s", PF_VarString(0));
}

// C printf "%5.1f": one decimal, right-aligned in a 5-character field
export function PF_Format5_1f(v) {
  return v.toFixed(1).padStart(5, " ");
}

// ftos/vtos return a temp string in pr_strings space (PR_SetTempString)
function PF_ftos() {
  const v = G_FLOAT(OFS_PARM0);
  let str;

  if (v === (v | 0)) {
    str = String(v | 0); // %d
  } else {
    str = PF_Format5_1f(v); // %5.1f
  }

  // Write into the next pr_string_temp buffer (see PR_SetTempString)
  const ofs = PR_SetTempString(str);
  G_INT_SET(OFS_RETURN, ofs);
}

function PF_fabs() {
  const v = G_FLOAT(OFS_PARM0);
  G_FLOAT_SET(OFS_RETURN, Math.abs(v));
}

function PF_vtos() {
  const v = G_VECTOR(OFS_PARM0);
  // sprintf( pr_string_temp, "'%5.1f %5.1f %5.1f'", ... )
  const str = "'" + PF_Format5_1f(v[0]) + " " + PF_Format5_1f(v[1]) + " " +
    PF_Format5_1f(v[2]) + "'";

  // Write into the next pr_string_temp buffer (see PR_SetTempString)
  const ofs = PR_SetTempString(str);
  G_INT_SET(OFS_RETURN, ofs);
}

function PF_Spawn() {
  const ed = ED_Alloc();
  RETURN_EDICT(ed);
}

function PF_Remove() {
  const ed = G_EDICT(OFS_PARM0);
  ED_Free(ed);
}

// entity (entity start, .string field, string match) find = #5;
function PF_Find() {
  let e = G_EDICTNUM(OFS_PARM0);
  const f = G_INT(OFS_PARM1);

  // The search string and each entity's field are compared in the string
  // table, not as JS strings: this loop visits every entity on each call. An
  // empty string is a valid search that matches entities whose field is
  // empty or unset ( C tests char pointers here, which are never NULL ).
  const s = G_INT(OFS_PARM2);

  for (e++; e < sv.num_edicts; e++) {
    const ed = EDICT_NUM(e);
    if (ed.free) {
      continue;
    }
    if (PR_strcmp_ofs(ed._intView[f], s) === 0) {
      RETURN_EDICT(ed);
      return;
    }
  }

  RETURN_EDICT(sv.edicts[0]);
}

function PR_CheckEmptyString(s) {
  if (s == null || s.length === 0 || s.charCodeAt(0) <= 32) {
    PR_RunError("Bad string");
  }
}

function PF_precache_file() {
  // precache_file is only used to copy files with qcc, it does nothing
  G_INT_SET(OFS_RETURN, G_INT(OFS_PARM0));
}

function PF_precache_sound() {
  const s = G_STRING(OFS_PARM0);
  G_INT_SET(OFS_RETURN, G_INT(OFS_PARM0));
  PR_CheckEmptyString(s);

  if (sv.state !== ss_loading) {
    PR_RunError("PF_Precache_*: Precache can only be done in spawn functions");
  }

  if (sv.sound_precache) {
    for (let i = 0; i < MAX_SOUNDS; i++) {
      if (sv.sound_precache[i] == null) {
        sv.sound_precache[i] = s;
        return;
      }

      if (sv.sound_precache[i] === s) {
        return;
      }
    }

    PR_RunError("PF_precache_sound: overflow");
  }
}

function PF_precache_model() {
  const s = G_STRING(OFS_PARM0);
  G_INT_SET(OFS_RETURN, G_INT(OFS_PARM0));
  PR_CheckEmptyString(s);

  if (sv.state !== ss_loading) {
    PR_RunError("PF_Precache_*: Precache can only be done in spawn functions");
  }

  if (sv.model_precache) {
    for (let i = 0; i < MAX_MODELS; i++) {
      if (sv.model_precache[i] == null) {
        sv.model_precache[i] = s;
        sv.models[i] = Mod_ForName(s, true);
        return;
      }

      if (sv.model_precache[i] === s) {
        return;
      }
    }

    PR_RunError("PF_precache_model: overflow");
  }
}

function PF_coredump() {
  ED_PrintEdicts();
}

function PF_traceon() {
  PR_SetTrace(true);
}

function PF_traceoff() {
  PR_SetTrace(false);
}

function PF_eprint() {
  ED_PrintNum(G_EDICTNUM(OFS_PARM0));
}

/** float(float yaw, float dist) walkmove */
function PF_walkmove() {
  const ent = PROG_TO_EDICT(pr_global_struct.self);
  const yaw = G_FLOAT(OFS_PARM0);
  const dist = G_FLOAT(OFS_PARM1);

  if (!((ent.v.flags | 0) & (FL_ONGROUND | FL_FLY | FL_SWIM))) {
    G_FLOAT_SET(OFS_RETURN, 0);
    return;
  }

  const yawRad = yaw * M_PI / 180;
  const move = walkmove_move;
  move[0] = Math.cos(yawRad) * dist;
  move[1] = Math.sin(yawRad) * dist;
  move[2] = 0;

  // save program state, because SV_movestep may call other progs
  const oldf = pr_xfunction;
  const oldself = pr_global_struct.self;

  G_FLOAT_SET(OFS_RETURN, SV_movestep(ent, move, true) ? 1 : 0);

  // restore program state
  PR_SetXFunction(oldf);
  pr_global_struct.self = oldself;
}

/** void() droptofloor */
function PF_droptofloor() {
  const ent = PROG_TO_EDICT(pr_global_struct.self);

  const end = droptofloor_end;
  VectorCopy(ent.v.origin, end);
  end[2] -= 256;

  const trace = SV_Move(ent.v.origin, ent.v.mins, ent.v.maxs, end, false, ent);

  if (trace.fraction === 1 || trace.allsolid) {
    G_FLOAT_SET(OFS_RETURN, 0);
  } else {
    VectorCopy(trace.endpos, ent.v.origin);
    SV_LinkEdict(ent, false);
    ent.v.flags = (ent.v.flags | 0) | FL_ONGROUND;
    ent.v.groundentity = EDICT_TO_PROG(trace.ent);
    G_FLOAT_SET(OFS_RETURN, 1);
  }
}

/** void(float style, string value) lightstyle */
function PF_lightstyle() {
  const style = G_FLOAT(OFS_PARM0) | 0;
  const val = G_STRING(OFS_PARM1);

  // Deliberate deviation from id, taken from Ironwail/QuakeSpasm: bounds
  // check the style, which id used unchecked to index sv.lightstyles and
  // sent to clients (whose CL_ParseServerMessage Sys_Errors on >= 64)
  if (style < 0 || style >= MAX_LIGHTSTYLES) {
    Con_DPrintf("PF_lightstyle: invalid style " + style + "\n");
    return;
  }

  // change the string in sv
  if (sv.lightstyles) {
    sv.lightstyles[style] = val;
  }

  // send message to all clients on this server
  if (sv.state !== ss_active) {
    return;
  }

  for (let j = 0; j < svs.maxclients; j++) {
    const client = svs.clients[j];
    if (!client) continue;
    if (client.active || client.spawned) {
      MSG_WriteChar(client.message, svc_lightstyle);
      MSG_WriteChar(client.message, style);
      MSG_WriteString(client.message, val);
    }
  }
}

function PF_rint() {
  const f = G_FLOAT(OFS_PARM0);
  if (f > 0) {
    G_FLOAT_SET(OFS_RETURN, (f + 0.5) | 0);
  } else {
    G_FLOAT_SET(OFS_RETURN, (f - 0.5) | 0);
  }
}

function PF_floor() {
  G_FLOAT_SET(OFS_RETURN, Math.floor(G_FLOAT(OFS_PARM0)));
}

function PF_ceil() {
  G_FLOAT_SET(OFS_RETURN, Math.ceil(G_FLOAT(OFS_PARM0)));
}

function PF_checkbottom() {
  const ent = G_EDICT(OFS_PARM0);
  G_FLOAT_SET(OFS_RETURN, SV_CheckBottom(ent) ? 1 : 0);
}

function PF_pointcontents() {
  const v = G_VECTOR(OFS_PARM0);
  G_FLOAT_SET(OFS_RETURN, SV_PointContents(v));
}

/** entity nextent(entity) */
function PF_nextent() {
  let i = G_EDICTNUM(OFS_PARM0);

  while (true) {
    i++;
    if (i === sv.num_edicts) {
      RETURN_EDICT(sv.edicts[0]);
      return;
    }

    const ent = EDICT_NUM(i);
    if (!ent.free) {
      RETURN_EDICT(ent);
      return;
    }
  }
}

// PF_aim
//
// Pick a vector for the player to shoot along
// vector aim(entity, missilespeed)
const DAMAGE_AIM = 2;

function PF_aim() {
  const ent = G_EDICT(OFS_PARM0);
  const teamplayValue = teamplay.value;
  // speed = G_FLOAT( OFS_PARM1 ); // not used in original C

  const start = aim_start;
  const dir = aim_dir;
  const end = aim_end;
  const bestdir = aim_bestdir;

  VectorCopy(ent.v.origin, start);
  start[2] += 20;

  // try sending a trace straight
  VectorCopy(pr_global_struct.v_forward, dir);
  VectorMA(start, 2048, dir, end);
  const tr = SV_Move(start, vec3_origin, vec3_origin, end, false, ent);
  if (
    tr.ent && tr.ent.v.takedamage === DAMAGE_AIM &&
    (teamplayValue === 0 || ent.v.team <= 0 || ent.v.team !== tr.ent.v.team)
  ) {
    const ret = G_VECTOR(OFS_RETURN);
    VectorCopy(pr_global_struct.v_forward, ret);
    return;
  }

  // try all possible entities
  VectorCopy(dir, bestdir);
  let bestdist = sv_aim.value;
  let bestent = null;

  for (let i = 1; i < sv.num_edicts; i++) {
    const check = EDICT_NUM(i);
    if (check.v.takedamage !== DAMAGE_AIM) {
      continue;
    }
    if (check === ent) {
      continue;
    }
    if (teamplayValue !== 0 && ent.v.team > 0 && ent.v.team === check.v.team) {
      continue; // don't aim at teammate
    }

    for (let j = 0; j < 3; j++) {
      end[j] = check.v.origin[j] + 0.5 * (check.v.mins[j] + check.v.maxs[j]);
    }
    VectorSubtract(end, start, dir);
    VectorNormalize(dir);
    const dist = DotProduct(dir, pr_global_struct.v_forward);
    if (dist < bestdist) {
      continue; // too far to turn
    }
    const tr2 = SV_Move(start, vec3_origin, vec3_origin, end, false, ent);
    if (tr2.ent === check) {
      // can shoot at this one
      bestdist = dist;
      bestent = check;
    }
  }

  const ret = G_VECTOR(OFS_RETURN);
  if (bestent != null) {
    VectorSubtract(bestent.v.origin, ent.v.origin, dir);
    const dist = DotProduct(dir, pr_global_struct.v_forward);
    VectorScale(pr_global_struct.v_forward, dist, end);
    end[2] = dir[2];
    VectorNormalize(end);
    VectorCopy(end, ret);
  } else {
    VectorCopy(bestdir, ret);
  }
}

/** This was a major timewaster in progs, so it was converted to C */
function PF_changeyaw() {
  const ent = PROG_TO_EDICT(pr_global_struct.self);
  const current = anglemod(ent.v.angles[1]);
  const ideal = ent.v.ideal_yaw;
  const speed = ent.v.yaw_speed;

  if (current === ideal) {
    return;
  }

  let move = ideal - current;
  if (ideal > current) {
    if (move >= 180) {
      move = move - 360;
    }
  } else {
    if (move <= -180) {
      move = move + 360;
    }
  }

  if (move > 0) {
    if (move > speed) {
      move = speed;
    }
  } else {
    if (move < -speed) {
      move = -speed;
    }
  }

  ent.v.angles[1] = anglemod(current + move);
}

// MESSAGE WRITING

const MSG_BROADCAST = 0; // unreliable to all
const MSG_ONE = 1; // reliable to one (msg_entity)
const MSG_ALL = 2; // reliable to all
const MSG_INIT = 3; // write to the init string

function WriteDest() {
  const dest = G_FLOAT(OFS_PARM0) | 0;

  switch (dest) {
    case MSG_BROADCAST:
      return sv.datagram;
    case MSG_ONE: {
      const ent = PROG_TO_EDICT(pr_global_struct.msg_entity);
      const entnum = NUM_FOR_EDICT(ent);
      if (entnum < 1 || entnum > (svs.maxclients || 1)) {
        PR_RunError("WriteDest: not a client");
        return null;
      }

      const client = svs.clients[entnum - 1];
      return client.message;
    }

    case MSG_ALL:
      return sv.reliable_datagram;
    case MSG_INIT:
      return sv.signon;
    default:
      PR_RunError("WriteDest: bad destination");
      return null;
  }
}

function PF_WriteByte() {
  const dest = WriteDest();
  if (dest) MSG_WriteByte(dest, G_FLOAT(OFS_PARM1) | 0);
}

function PF_WriteChar() {
  const dest = WriteDest();
  if (dest) MSG_WriteChar(dest, G_FLOAT(OFS_PARM1) | 0);
}

function PF_WriteShort() {
  const dest = WriteDest();
  if (dest) MSG_WriteShort(dest, G_FLOAT(OFS_PARM1) | 0);
}

function PF_WriteLong() {
  const dest = WriteDest();
  if (dest) MSG_WriteLong(dest, G_FLOAT(OFS_PARM1) | 0);
}

function PF_WriteCoord() {
  const dest = WriteDest();
  if (dest) MSG_WriteCoord(dest, G_FLOAT(OFS_PARM1));
}

function PF_WriteAngle() {
  const dest = WriteDest();
  if (dest) MSG_WriteAngle(dest, G_FLOAT(OFS_PARM1));
}

function PF_WriteString() {
  const dest = WriteDest();
  // Ironwail localizes this too: svc_finale "$qc_finale_end"
  if (dest) MSG_WriteString(dest, LOC_GetString(G_STRING(OFS_PARM1)));
}

function PF_WriteEntity() {
  const dest = WriteDest();
  if (dest) MSG_WriteShort(dest, NUM_FOR_EDICT(G_EDICT(OFS_PARM1)));
}

function PF_makestatic() {
  const ent = G_EDICT(OFS_PARM0);

  //johnfitz -- don't send invisible static entities
  if (ent.alpha === ENTALPHA_ZERO) {
    ED_Free(ent);
    return;
  }
  //johnfitz

  // PROTOCOL_ICARO (protocol.js): a short model index, a short frame,
  // 4-byte coords and an alpha byte (Ironwail's svc_spawnstatic2 sends
  // them with B_LARGEMODEL, B_LARGEFRAME and B_ALPHA)
  SV_ReserveSignonSpace(1 + 2 + 2 + 2 + 3 * (4 + 1) + 1);

  MSG_WriteByte(sv.signon, svc_spawnstatic);
  MSG_WriteShort(sv.signon, ent.v.modelindex | 0);
  MSG_WriteShort(sv.signon, ent.v.frame | 0);
  MSG_WriteByte(sv.signon, ent.v.colormap | 0);
  MSG_WriteByte(sv.signon, ent.v.skin | 0);
  for (let i = 0; i < 3; i++) {
    MSG_WriteCoord(sv.signon, ent.v.origin[i]);
    MSG_WriteAngle(sv.signon, ent.v.angles[i]);
  }
  MSG_WriteByte(sv.signon, ent.alpha); //johnfitz -- alpha

  // throw the entity away now
  ED_Free(ent);
}

function PF_setspawnparms() {
  const ent = G_EDICT(OFS_PARM0);
  const i = NUM_FOR_EDICT(ent);
  if (i < 1 || i > svs.maxclients) {
    PR_RunError("Entity is not a client");
  }

  // copy spawn parms out of the client_t
  const client = svs.clients[i - 1];
  for (let j = 0; j < 16; j++) { // NUM_SPAWN_PARMS = 16
    pr_global_struct["parm" + (j + 1)] = client.spawn_parms[j];
  }
}

function PF_changelevel() {
  // make sure we don't issue two changelevels
  if (svs.changelevel_issued) {
    return;
  }
  svs.changelevel_issued = true;

  const s = G_STRING(OFS_PARM0);
  Cbuf_AddText("changelevel " + s + "\n");
}

function SV_MoveToGoal() {
  SV_MoveToGoal_Real();
}

// EXTENSION BUILT-INS
//
// Not in id's Quake. Ported from Ironwail's pr_cmds.c, with its builtin
// numbers, so that mods written for QuakeSpasm-family engines (Arcane
// Dimensions and others) load. Before these, any call past #78 ended the map
// with "Bad builtin call number".

// Ironwail's Con_Warning and Con_DWarning
function PF_Warning(msg) {
  Con_Printf("%s", "Warning: " + msg);
}

function PF_DWarning(msg) {
  Con_DPrintf("%s", "Warning: " + msg);
}

// C's atof: like parseFloat, but 0 where nothing parses
function PF_atof(s) {
  const f = parseFloat(s);
  return Number.isNaN(f) ? 0 : f;
}

// 2021 re-release: float() finaleFinished = #79
function PF_finalefinished() {
  G_FLOAT_SET(OFS_RETURN, 0);
}

// 2021 re-release update 3: float( entity playerEnt ) ex_CheckPlayerEXFlags.
// The KEX engine returns the player's PEF_CHANGEONLYNEW / PEF_CHANGENEVER
// weapon-switch preferences; Ironwail (pr_cmds.c PF_CheckPlayerEXFlags) has
// no such settings and returns 0, so pickups switch weapons as in id's QC.
function PF_CheckPlayerEXFlags() {
  G_FLOAT_SET(OFS_RETURN, 0);
}

// 2021 re-release update 3: float( float movedist, vector goal )
// ex_walkpathtogoal. The KEX engine paths monsters along its .nav graphs;
// Ironwail (pr_cmds.c PF_walkpathtogoal) returns 0 (PATH_ERROR), and the QC
// falls back to movetogoal.
function PF_walkpathtogoal() {
  G_FLOAT_SET(OFS_RETURN, 0); // PATH_ERROR
}

/**
 * Ported from Ironwail's pr_cmds.c (2021 re-release builtin): plays a sound
 * that only the given client hears.
 *
 * localsound(clientent, sample)
 */
function PF_localsound() {
  const entnum = G_EDICTNUM(OFS_PARM0);
  const sample = G_STRING(OFS_PARM1);

  if (entnum < 1 || entnum > svs.maxclients) {
    Con_Printf("tried to localsound to a non-client\n");
    return;
  }

  SV_LocalSound(svs.clients[entnum - 1], sample);
}

/**
 * spike - enables qc extensions. if 0 then they're ALL BLOCKED! Mods read it
 * with cvar("pr_checkextension") before calling checkextension (Ironwail's
 * pr_cmds.c; registered by PR_Init).
 */
export const pr_checkextension = new cvar_t("pr_checkextension", "1");

/**
 * The extension names Ironwail knows (progs.h QCEXTENSIONS_ALL, in its order;
 * pr_exec.c pr_extnames). Index 0 is the standard instruction set. The
 * builtin table tags each extension builtin with one of these.
 */
export const pr_extnames = [
  "STD_QC",
  "FRIK_FILE",
  "FTE_STRINGS",
  "FTE_QC_CHECKCOMMAND",
  "DP_QC_ETOS",
  "DP_QC_MINMAXBOUND",
  "DP_QC_SINCOSSQRTPOW",
  "DP_QC_ASINACOSATANATAN2TAN",
  "DP_QC_VECTORVECTORS",
  "DP_QC_STRING_CASE_FUNCTIONS",
  "DP_QC_SPRINTF",
  "DP_QC_TOKENIZE_CONSOLE",
  "DP_QC_STRFTIME",
  "KRIMZON_SV_PARSECLIENTCOMMAND",
];

const FTE_QC_CHECKCOMMAND = 3;

/** Returns the known extension's index, or 0 for an unrecognized name. */
export function PR_FindExtensionByName(name) {
  for (let i = 1; i < pr_extnames.length; i++) {
    if (name === pr_extnames[i]) {
      return i;
    }
  }

  return 0;
}

/**
 * float(string extname) checkextension = #99
 *
 * As Ironwail, answers true only for FTE_QC_CHECKCOMMAND, so that older
 * Arcane Dimensions builds (1.42, as in jam8) take their FTE code path and
 * not their buggy DP one. Every other name is false, even where all its
 * builtins exist: mods trust the answer. Ironwail's checked_ext and
 * advertised_ext bits only feed its developer warnings
 * (PR_CheckBuiltinExtension), which are not ported.
 */
function PF_checkextension() {
  const i = PR_FindExtensionByName(G_STRING(OFS_PARM0));
  G_FLOAT_SET(OFS_RETURN, i === FTE_QC_CHECKCOMMAND ? 1 : 0);
}

// maths stuff
function PF_Sin() {
  G_FLOAT_SET(OFS_RETURN, Math.sin(G_FLOAT(OFS_PARM0)));
}

function PF_Cos() {
  G_FLOAT_SET(OFS_RETURN, Math.cos(G_FLOAT(OFS_PARM0)));
}

function PF_Sqrt() {
  G_FLOAT_SET(OFS_RETURN, Math.sqrt(G_FLOAT(OFS_PARM0)));
}

function PF_asin() {
  G_FLOAT_SET(OFS_RETURN, Math.asin(G_FLOAT(OFS_PARM0)));
}

function PF_acos() {
  G_FLOAT_SET(OFS_RETURN, Math.acos(G_FLOAT(OFS_PARM0)));
}

function PF_tan() {
  G_FLOAT_SET(OFS_RETURN, Math.tan(G_FLOAT(OFS_PARM0)));
}

function PF_atan() {
  G_FLOAT_SET(OFS_RETURN, Math.atan(G_FLOAT(OFS_PARM0)));
}

function PF_atan2() {
  G_FLOAT_SET(
    OFS_RETURN,
    Math.atan2(G_FLOAT(OFS_PARM0), G_FLOAT(OFS_PARM1)),
  );
}

function PF_pow() {
  G_FLOAT_SET(OFS_RETURN, Math.pow(G_FLOAT(OFS_PARM0), G_FLOAT(OFS_PARM1)));
}

function PF_mod() {
  const a = G_FLOAT(OFS_PARM0);
  const n = G_FLOAT(OFS_PARM1);

  if (n === 0) {
    PF_DWarning("PF_mod: mod by zero\n");
    G_FLOAT_SET(OFS_RETURN, 0);
  } else {
    // because QC is inherantly floaty, lets use floats.
    // C: a - ( n * (int)( a / n ) ), all in single precision
    const q = Q_FloatToInt(Math.fround(a / n));
    G_FLOAT_SET(OFS_RETURN, Math.fround(a - Math.fround(n * q)));
  }
}

function PF_min() {
  let r = G_FLOAT(OFS_PARM0);
  for (let i = 1; i < pr_argc; i++) {
    if (r > G_FLOAT(OFS_PARM0 + i * 3)) {
      r = G_FLOAT(OFS_PARM0 + i * 3);
    }
  }

  G_FLOAT_SET(OFS_RETURN, r);
}

function PF_max() {
  let r = G_FLOAT(OFS_PARM0);
  for (let i = 1; i < pr_argc; i++) {
    if (r < G_FLOAT(OFS_PARM0 + i * 3)) {
      r = G_FLOAT(OFS_PARM0 + i * 3);
    }
  }

  G_FLOAT_SET(OFS_RETURN, r);
}

function PF_bound() {
  const minval = G_FLOAT(OFS_PARM0);
  let curval = G_FLOAT(OFS_PARM1);
  const maxval = G_FLOAT(OFS_PARM2);
  if (curval > maxval) {
    curval = maxval;
  }
  if (curval < minval) {
    curval = minval;
  }
  G_FLOAT_SET(OFS_RETURN, curval);
}

function PF_vectorvectors() {
  const forward = pr_global_struct.v_forward;
  const right = pr_global_struct.v_right;
  VectorCopy(G_VECTOR(OFS_PARM0), forward);
  VectorNormalize(forward);
  // C's !x: zero is false, NaN is not
  if (forward[0] === 0 && forward[1] === 0) {
    if (forward[2] !== 0) {
      right[1] = -1;
    } else {
      right[1] = 0;
    }
    right[0] = right[2] = 0;
  } else {
    right[0] = forward[1];
    right[1] = -forward[0];
    right[2] = 0;
    VectorNormalize(right);
  }
  CrossProduct(right, forward, pr_global_struct.v_up);
}

// string stuff
function PF_strlen() {
  // FIXME: doesn't try to handle utf-8
  G_FLOAT_SET(OFS_RETURN, G_STRING(OFS_PARM0).length);
}

function PF_strcat() {
  let out = "";
  for (let i = 0; i < pr_argc; i++) {
    out += G_STRING(OFS_PARM0 + i * 3);
    if (out.length >= STRINGTEMP_LENGTH) {
      PF_Warning("PF_strcat: overflow (string truncated)\n");
      break;
    }
  }

  // PR_SetTempString cuts it to STRINGTEMP_LENGTH - 1, as q_strlcat does
  G_INT_SET(OFS_RETURN, PR_SetTempString(out));
}

function PF_substring() {
  const s = G_STRING(OFS_PARM0);
  let start = Q_FloatToInt(G_FLOAT(OFS_PARM1));
  let length = Q_FloatToInt(G_FLOAT(OFS_PARM2));

  let slen = s.length; // utf-8 should use chars, not bytes.

  if (start < 0) {
    start = slen + start;
  }
  if (length < 0) {
    length = slen - start + (length + 1);
  }
  if (start < 0) {
    // length += start;
    start = 0;
  }

  if (start >= slen || length <= 0) {
    G_INT_SET(OFS_RETURN, PR_SetTempString(""));
    return;
  }

  slen -= start;
  if (length > slen) {
    length = slen;
  }

  if (length >= STRINGTEMP_LENGTH) {
    length = STRINGTEMP_LENGTH - 1;
    PF_Warning("PF_substring: truncation\n");
  }

  G_INT_SET(OFS_RETURN, PR_SetTempString(s.substr(start, length)));
}

/**
 * Copies its arguments, joined, into a string that lasts until strunzone
 * (see PR_ZoneString)
 */
function PF_strzone() {
  let s = "";
  for (let i = 0; i < pr_argc; i++) {
    s += G_STRING(OFS_PARM0 + i * 3);
  }

  G_INT_SET(OFS_RETURN, PR_ZoneString(s));
}

function PF_strunzone() {
  const ofs = G_INT(OFS_PARM0);
  if (ofs === 0) {
    return; // don't bug out if they gave a null string
  }

  if (!PR_UnzoneString(ofs)) {
    PF_Warning("PF_strunzone: string wasn't strzoned\n");
  }
}

// should be just \n and 32-127, but we don't actually support any actual
// unicode and we don't really want to make things worse.
function qc_isascii(u) {
  return u < 256;
}

function PF_str2chr() {
  const instr = G_STRING(OFS_PARM0);
  let ofs = pr_argc > 1 ? Q_FloatToInt(G_FLOAT(OFS_PARM1)) : 0;

  if (ofs < 0) {
    ofs = instr.length + ofs;
  }

  // C: if (ofs && (ofs < 0 || ofs > strlen)) '\0' else instr[ofs], and
  // instr[strlen] is the NUL
  if (ofs < 0 || ofs >= instr.length) {
    G_FLOAT_SET(OFS_RETURN, 0);
  } else {
    G_FLOAT_SET(OFS_RETURN, instr.charCodeAt(ofs));
  }
}

function PF_chr2str() {
  let out = "";
  for (let i = 0; out.length < STRINGTEMP_LENGTH - 6 && i < pr_argc; i++) {
    // C converts the float to an unsigned int
    const u = Q_FloatToInt(G_FLOAT(OFS_PARM0 + i * 3)) >>> 0;
    if (u >= 0xe000 && u < 0xe100) {
      out += String.fromCharCode(u & 0xff); // quake chars.
    } else if (qc_isascii(u)) {
      out += String.fromCharCode(u);
    } else {
      out += "?"; // no unicode support
    }
  }

  G_INT_SET(OFS_RETURN, PR_SetTempString(out));
}

// part of PF_strconv
function chrconv_number(i, base, conv) {
  i -= base;
  switch (conv) {
    default:
    case 5:
    case 6:
    case 0:
      break;
    case 1:
      base = 48; // '0'
      break;
    case 2:
      base = 48 + 128;
      break;
    case 3:
      base = 48 - 30;
      break;
    case 4:
      base = 48 + 128 - 30;
      break;
  }
  return i + base;
}

// part of PF_strconv
function chrconv_punct(i, base, conv) {
  i -= base;
  switch (conv) {
    default:
    case 0:
      break;
    case 1:
      base = 0;
      break;
    case 2:
      base = 128;
      break;
  }
  return i + base;
}

// part of PF_strconv
function chrchar_alpha(i, basec, baset, convc, convt, charnum) {
  // convert case and colour seperatly...

  i -= baset + basec;
  switch (convt) {
    default:
    case 0:
      break;
    case 1:
      baset = 0;
      break;
    case 2:
      baset = 128;
      break;

    case 5:
    case 6:
      baset = 128 * ((charnum & 1) === convt - 5 ? 1 : 0);
      break;
  }

  switch (convc) {
    default:
    case 0:
      break;
    case 1:
      basec = 97; // 'a'
      break;
    case 2:
      basec = 65; // 'A'
      break;
  }
  return i + basec + baset;
}

/**
 * FTE_STRINGS: bulk convert a string. change case or colouring.
 *
 * string(float ccase, float redalpha, float redchars, string str, ...) strconv
 */
function PF_strconv() {
  const ccase = Q_FloatToInt(G_FLOAT(OFS_PARM0)); // 0 same, 1 lower, 2 upper
  // 0 same, 1 white, 2 red, 5 alternate, 6 alternate-alternate
  const redalpha = Q_FloatToInt(G_FLOAT(OFS_PARM1));
  // 0 same, 1 white, 2 red, 3 redspecial, 4 whitespecial, 5 alternate,
  // 6 alternate-alternate
  const rednum = Q_FloatToInt(G_FLOAT(OFS_PARM2));
  const string = PF_VarString(3);
  let len = string.length;

  // UTF-8-FIXME: cope with utf+^U etc

  if (len >= STRINGTEMP_LENGTH) {
    len = STRINGTEMP_LENGTH - 1;
  }

  let result = "";
  for (let i = 0; i < len; i++) { // should this be done backwards?
    const c = string.charCodeAt(i);
    let r;
    if (c >= 48 && c <= 57) { // normal numbers...
      r = chrconv_number(c, 48, rednum);
    } else if (c >= 48 + 128 && c <= 57 + 128) {
      r = chrconv_number(c, 48 + 128, rednum);
    } else if (c >= 48 + 128 - 30 && c <= 57 + 128 - 30) {
      r = chrconv_number(c, 48 + 128 - 30, rednum);
    } else if (c >= 48 - 30 && c <= 57 - 30) {
      r = chrconv_number(c, 48 - 30, rednum);
    } else if (c >= 97 && c <= 122) { // a-z
      r = chrchar_alpha(c, 97, 0, ccase, redalpha, i);
    } else if (c >= 65 && c <= 90) { // A-Z
      r = chrchar_alpha(c, 65, 0, ccase, redalpha, i);
    } else if (c >= 97 + 128 && c <= 122 + 128) {
      r = chrchar_alpha(c, 97, 128, ccase, redalpha, i);
    } else if (c >= 65 + 128 && c <= 90 + 128) {
      r = chrchar_alpha(c, 65, 128, ccase, redalpha, i);
    } else if ((c & 127) < 16 || redalpha === 0) { // special chars..
      r = c;
    } else if (c < 128) {
      r = chrconv_punct(c, 0, redalpha);
    } else {
      r = chrconv_punct(c, 128, redalpha);
    }

    result += String.fromCharCode(r & 0xff); // C stores an unsigned char
  }

  G_INT_SET(OFS_RETURN, PR_SetTempString(result));
}

// string tokenizing (gah)
const MAXQCTOKENS = 64;
const qctoken = [];

function PF_ArgC() {
  G_FLOAT_SET(OFS_RETURN, qctoken.length);
}

function tokenizeqc(str) {
  qctoken.length = 0;
  let pos = 0;
  while (qctoken.length < MAXQCTOKENS) {
    // skip whitespace here so the token's start is accurate
    while (pos < str.length && str.charCodeAt(pos) <= 32) {
      pos++;
    }

    if (pos >= str.length) {
      break;
    }

    const rest = COM_Parse(str.slice(pos));
    if (rest === null) {
      break;
    }

    qctoken.push(com_token);
    pos = str.length - rest.length;
  }

  return qctoken.length;
}

// KRIMZON_SV_PARSECLIENTCOMMAND added these two - note that for
// compatibility with DP, this tokenize builtin is veeery vauge and doesn't
// match the console
function PF_Tokenize() {
  G_FLOAT_SET(OFS_RETURN, tokenizeqc(G_STRING(OFS_PARM0)));
}

// Ironwail passes tokenizeqc a flag for DP's punctuation rules, but ignores
// it, so this is the same tokenizer as PF_Tokenize.
function PF_tokenize_console() {
  G_FLOAT_SET(OFS_RETURN, tokenizeqc(G_STRING(OFS_PARM0)));
}

function PF_ArgV() {
  let idx = Q_FloatToInt(G_FLOAT(OFS_PARM0));

  // negative indexes are relative to the end
  if (idx < 0) {
    idx += qctoken.length;
  }

  if (idx < 0 || idx >= qctoken.length) {
    G_INT_SET(OFS_RETURN, 0);
  } else {
    G_INT_SET(OFS_RETURN, PR_SetTempString(qctoken[idx]));
  }
}

function PF_sprintf() {
  const out = PF_sprintf_internal(G_STRING(OFS_PARM0), 1, STRINGTEMP_LENGTH);
  G_INT_SET(OFS_RETURN, PR_SetTempString(out));
}

// conversions (mostly string)
function PF_stof() {
  G_FLOAT_SET(OFS_RETURN, PF_atof(G_STRING(OFS_PARM0)));
}

function PF_stov() {
  let s = G_STRING(OFS_PARM0);
  const v = G_VECTOR(OFS_RETURN);
  for (let i = 0; i < 3; i++) {
    s = COM_Parse(s);
    v[i] = PF_atof(com_token);
  }
}

function PF_etos() {
  // yes, this is lame
  G_INT_SET(OFS_RETURN, PR_SetTempString("entity " + G_EDICTNUM(OFS_PARM0)));
}

function PF_ftoi() {
  G_INT_SET(OFS_RETURN, Q_FloatToInt(G_FLOAT(OFS_PARM0)));
}

function PF_itof() {
  G_FLOAT_SET(OFS_RETURN, G_INT(OFS_PARM0));
}

// Ironwail's MAX_CL_STATS (quakedef.h), the bound clientstat checks. id's
// is 32 (MAX_CL_STATS in quakedef.js).
const MAX_CL_STATS_EXT = 256;

// Ironwail's etype_t ev_ext_integer (pr_comp.h)
const ev_ext_integer = 8;

/**
 * Ironwail's sv.customstats: the stats clientstat registered, as
 * { idx, type, fld }. Cleared when progs load (Ironwail clears sv per map).
 *
 * Deviation from Ironwail: SV_WriteStats, which sends these to clients for
 * CSQC to read, is not ported, because Icaro has no CSQC to read them.
 * Registering them keeps mods that call clientstat from worldspawn (Arcane
 * Dimensions, Copper) running, as they do on Ironwail.
 */
export const sv_customstats = [];

function PR_CustomStat(idx, type) {
  if (idx < 0 || idx >= MAX_CL_STATS_EXT) {
    return null;
  }
  switch (type) {
    case ev_ext_integer:
    case ev_float:
    case ev_vector:
    case ev_entity:
      break;
    default:
      return null;
  }

  let i;
  for (i = 0; i < sv_customstats.length; i++) {
    const stat = sv_customstats[i];
    if (
      stat.idx === idx && (stat.type === ev_string) === (type === ev_string)
    ) {
      break;
    }
  }
  if (i === sv_customstats.length) {
    sv_customstats.push({ idx: 0, type: 0, fld: 0 });
  }
  const stat = sv_customstats[i];
  stat.idx = idx;
  stat.type = type;
  stat.fld = 0;
  return stat;
}

/** void(float num, float type, .__variant fld) clientstat = #232 */
function PF_clientstat() {
  const idx = Q_FloatToInt(G_FLOAT(OFS_PARM0));
  const type = Q_FloatToInt(G_FLOAT(OFS_PARM1));
  const fldofs = G_INT(OFS_PARM2);
  const stat = PR_CustomStat(idx, type);
  if (stat === null) {
    return;
  }
  stat.fld = fldofs;
}

// server/client stuff

/**
 * float(string name) checkcommand = #294: 1 for a command, 2 for an alias, 3
 * for a cvar, 0 for none. Commands and aliases match case-insensitively, as
 * Ironwail's Cmd_Exists and Cmd_AliasExists.
 */
function PF_checkcommand() {
  const name = G_STRING(OFS_PARM0);
  if (Cmd_FindCommand(name) !== null) {
    G_FLOAT_SET(OFS_RETURN, 1);
  } else if (Cmd_AliasExists(name)) {
    G_FLOAT_SET(OFS_RETURN, 2);
  } else if (Cvar_FindVar(name) !== null) {
    G_FLOAT_SET(OFS_RETURN, 3);
  } else {
    G_FLOAT_SET(OFS_RETURN, 0);
  }
}

/**
 * void(entity e, string s) clientcommand = #440: runs s as if client e had
 * sent it.
 *
 * Ironwail's Cmd_ExecuteString runs only client commands for src_client.
 * Icaro's runs anything, and the server checks a client's commands against
 * id's list first (SV_ClientCommandAllowed), so this checks the same list.
 */
function PF_clientcommand() {
  const ed = G_EDICT(OFS_PARM0);
  const str = G_STRING(OFS_PARM1);
  const i = NUM_FOR_EDICT(ed) - 1;
  if (i >= 0 && i < svs.maxclients && svs.clients[i].active) {
    const ohc = host_client;
    set_host_client(svs.clients[i]);
    if (SV_ClientCommandAllowed(str)) {
      Cmd_ExecuteString(str, src_client);
    } else {
      Con_DPrintf("%s tried to %s\n", host_client.name, str);
    }
    set_host_client(ohc);
  } else {
    Con_Printf("PF_clientcommand: not a client\n");
  }
}

function PF_Fixme() {
  PR_RunError("unimplemented builtin");
}

// Builtin dispatch table
// This matches the C pr_builtin[] array exactly

const pr_builtin = [
  PF_Fixme, // #0
  PF_makevectors, // void(entity e) makevectors = #1;
  PF_setorigin, // void(entity e, vector o) setorigin = #2;
  PF_setmodel, // void(entity e, string m) setmodel = #3;
  PF_setsize, // void(entity e, vector min, vector max) setsize = #4;
  PF_Fixme, // void(entity e, vector min, vector max) setabssize = #5;
  PF_break, // void() break = #6;
  PF_random, // float() random = #7;
  PF_sound, // void(entity e, float chan, string samp) sound = #8;
  PF_normalize, // vector(vector v) normalize = #9;
  PF_error, // void(string e) error = #10;
  PF_objerror, // void(string e) objerror = #11;
  PF_vlen, // float(vector v) vlen = #12;
  PF_vectoyaw, // float(vector v) vectoyaw = #13;
  PF_Spawn, // entity() spawn = #14;
  PF_Remove, // void(entity e) remove = #15;
  PF_traceline, // float(vector v1, vector v2, float tryents) traceline = #16;
  PF_checkclient, // entity() clientlist = #17;
  PF_Find, // entity(entity start, .string fld, string match) find = #18;
  PF_precache_sound, // void(string s) precache_sound = #19;
  PF_precache_model, // void(string s) precache_model = #20;
  PF_stuffcmd, // void(entity client, string s) stuffcmd = #21;
  PF_findradius, // entity(vector org, float rad) findradius = #22;
  PF_bprint, // void(string s) bprint = #23;
  PF_sprint, // void(entity client, string s) sprint = #24;
  PF_dprint, // void(string s) dprint = #25;
  PF_ftos, // void(string s) ftos = #26;
  PF_vtos, // void(string s) vtos = #27;
  PF_coredump, // #28
  PF_traceon, // #29
  PF_traceoff, // #30
  PF_eprint, // void(entity e) debug print an entire entity = #31
  PF_walkmove, // float(float yaw, float dist) walkmove = #32
  PF_Fixme, // #33
  PF_droptofloor, // #34
  PF_lightstyle, // #35
  PF_rint, // #36
  PF_floor, // #37
  PF_ceil, // #38
  PF_Fixme, // #39
  PF_checkbottom, // #40
  PF_pointcontents, // #41
  PF_Fixme, // #42
  PF_fabs, // #43
  PF_aim, // #44
  PF_cvar, // #45
  PF_localcmd, // #46
  PF_nextent, // #47
  PF_particle, // #48
  PF_changeyaw, // #49
  PF_Fixme, // #50
  PF_vectoangles, // #51

  PF_WriteByte, // #52
  PF_WriteChar, // #53
  PF_WriteShort, // #54
  PF_WriteLong, // #55
  PF_WriteCoord, // #56
  PF_WriteAngle, // #57
  PF_WriteString, // #58
  PF_WriteEntity, // #59

  PF_Fixme, // #60 (Quake2: sin; set from pr_extbuiltins)
  PF_Fixme, // #61 (Quake2: cos; set from pr_extbuiltins)
  PF_Fixme, // #62 (Quake2: sqrt; set from pr_extbuiltins)
  PF_Fixme, // #63 (Quake2: changepitch)
  PF_Fixme, // #64 (Quake2: TraceToss)
  PF_Fixme, // #65 (Quake2: etos; set from pr_extbuiltins)
  PF_Fixme, // #66 (Quake2: WaterMove)

  SV_MoveToGoal, // #67
  PF_precache_file, // #68
  PF_makestatic, // #69

  PF_changelevel, // #70
  PF_Fixme, // #71

  PF_cvar_set, // #72
  PF_centerprint, // #73

  PF_ambientsound, // #74

  PF_precache_model, // #75 precache_model2
  PF_precache_sound, // #76 precache_sound2 is different only for qcc
  PF_precache_file, // #77

  PF_setspawnparms, // #78
];

// Names of id's builtins, for the name remap in PR_InitProgsBuiltins
// (Ironwail's pr_builtindefs). Index is the builtin number.
const pr_builtin_names = [
  null,
  "makevectors",
  "setorigin",
  "setmodel",
  "setsize",
  null,
  "break",
  "random",
  "sound",
  "normalize",
  "error",
  "objerror",
  "vlen",
  "vectoyaw",
  "spawn",
  "remove",
  "traceline",
  "checkclient",
  "find",
  "precache_sound",
  "precache_model",
  "stuffcmd",
  "findradius",
  "bprint",
  "sprint",
  "dprint",
  "ftos",
  "vtos",
  "coredump",
  "traceon",
  "traceoff",
  "eprint",
  "walkmove",
  null,
  "droptofloor",
  "lightstyle",
  "rint",
  "floor",
  "ceil",
  null,
  "checkbottom",
  "pointcontents",
  null,
  "fabs",
  "aim",
  "cvar",
  "localcmd",
  "nextent",
  "particle",
  "ChangeYaw",
  null,
  "vectoangles",
  "WriteByte",
  "WriteChar",
  "WriteShort",
  "WriteLong",
  "WriteCoord",
  "WriteAngle",
  "WriteString",
  "WriteEntity",
  null,
  null,
  null,
  null,
  null,
  null,
  null,
  "movetogoal",
  "precache_file",
  "makestatic",
  "changelevel",
  null,
  "cvar_set",
  "centerprint",
  "ambientsound",
  "precache_model2",
  "precache_sound2",
  "precache_file2",
  "setspawnparms",
];

// Extension builtins: Ironwail's pr_builtindefs past id's #1-#78, in its
// order and with its numbers and extension tags (pr_extnames; null for none).
// Number 0 means Ironwail gives it none: QuakeC declares it "= #0" and
// PR_InitProgsBuiltins binds it by name to a slot counting down from the top
// of the table, in this order. The CSQC-only rows (#316-#352) have no server
// builtin in Ironwail either, so they stay PF_Fixme: calling them is
// "unimplemented builtin", as there.
export const pr_extbuiltins = [
  ["sin", PF_Sin, 60, "DP_QC_SINCOSSQRTPOW"], // float(float angle)
  ["cos", PF_Cos, 61, "DP_QC_SINCOSSQRTPOW"], // float(float angle)
  ["sqrt", PF_Sqrt, 62, "DP_QC_SINCOSSQRTPOW"], // float(float value)
  ["etos", PF_etos, 65, "DP_QC_ETOS"], // string(entity ent)
  ["finaleFinished", PF_finalefinished, 79, null], // float() (2021 re-release)
  ["localsound", PF_localsound, 80, null], // void(entity client, string sample) (2021 re-release)
  ["stof", PF_stof, 81, "FRIK_FILE"], // float(string)
  ["ex_centerprint", PF_centerprint, 0, null], // void(entity client, string s, ...)
  ["ex_bprint", PF_bprint, 0, null], // void(string s, ...)
  ["ex_sprint", PF_sprint, 0, null], // void(entity client, string s, ...)
  ["ex_finalefinished", PF_finalefinished, 0, null], // float()
  ["ex_CheckPlayerEXFlags", PF_CheckPlayerEXFlags, 0, null], // float(entity playerEnt)
  ["ex_walkpathtogoal", PF_walkpathtogoal, 0, null], // float(float movedist, vector goal)
  ["ex_localsound", PF_localsound, 0, null], // void(entity client, string sample)
  ["min", PF_min, 94, "DP_QC_MINMAXBOUND"], // float(float a, float b, ...)
  ["max", PF_max, 95, "DP_QC_MINMAXBOUND"], // float(float a, float b, ...)
  ["bound", PF_bound, 96, "DP_QC_MINMAXBOUND"], // float(float minimum, float val, float maximum)
  ["pow", PF_pow, 97, "DP_QC_SINCOSSQRTPOW"], // float(float value, float exp)
  ["checkextension", PF_checkextension, 99, null], // float(string extname)
  ["strlen", PF_strlen, 114, "FRIK_FILE"], // float(string s)
  ["strcat", PF_strcat, 115, "FRIK_FILE"], // string(string s1, ...)
  ["substring", PF_substring, 116, "FRIK_FILE"], // string(string s, float start, float length)
  ["stov", PF_stov, 117, "FRIK_FILE"], // vector(string s)
  ["strzone", PF_strzone, 118, "FRIK_FILE"], // string(string s, ...)
  ["strunzone", PF_strunzone, 119, "FRIK_FILE"], // void(string s)
  ["str2chr", PF_str2chr, 222, "FTE_STRINGS"], // float(string str, float index)
  ["chr2str", PF_chr2str, 223, "FTE_STRINGS"], // string(float chr, ...)
  ["strconv", PF_strconv, 224, "FTE_STRINGS"], // string(float ccase, float redalpha, float redchars, string str, ...)
  ["clientstat", PF_clientstat, 232, null], // void(float num, float type, .__variant fld)
  ["mod", PF_mod, 245, null], // float(float a, float n)
  ["ftoi", PF_ftoi, 0, null], // int(float)
  ["itof", PF_itof, 0, null], // float(int)
  ["checkcommand", PF_checkcommand, 294, "FTE_QC_CHECKCOMMAND"], // float(string name)
  ["iscachedpic", PF_Fixme, 316, null],
  ["precache_pic", PF_Fixme, 317, null],
  ["drawgetimagesize", PF_Fixme, 318, null],
  ["drawcharacter", PF_Fixme, 320, null],
  ["drawrawstring", PF_Fixme, 321, null],
  ["drawpic", PF_Fixme, 322, null],
  ["drawfill", PF_Fixme, 323, null],
  ["drawsetcliparea", PF_Fixme, 324, null],
  ["drawresetcliparea", PF_Fixme, 325, null],
  ["drawstring", PF_Fixme, 326, null],
  ["stringwidth", PF_Fixme, 327, null],
  ["drawsubpic", PF_Fixme, 328, null],
  ["getstati", PF_Fixme, 330, null],
  ["getstatf", PF_Fixme, 331, null],
  ["getstats", PF_Fixme, 332, null],
  ["getplayerkeyvalue", PF_Fixme, 348, null],
  ["getplayerkeyfloat", PF_Fixme, 0, null],
  ["registercommand", PF_Fixme, 352, null],
  ["vectorvectors", PF_vectorvectors, 432, "DP_QC_VECTORVECTORS"], // void(vector dir)
  ["clientcommand", PF_clientcommand, 440, "KRIMZON_SV_PARSECLIENTCOMMAND"], // void(entity e, string s)
  ["tokenize", PF_Tokenize, 441, "KRIMZON_SV_PARSECLIENTCOMMAND"], // float(string s)
  ["argv", PF_ArgV, 442, "KRIMZON_SV_PARSECLIENTCOMMAND"], // string(float n)
  ["argc", PF_ArgC, 0, null], // float()
  ["asin", PF_asin, 471, "DP_QC_ASINACOSATANATAN2TAN"], // float(float s)
  ["acos", PF_acos, 472, "DP_QC_ASINACOSATANATAN2TAN"], // float(float c)
  ["atan", PF_atan, 473, "DP_QC_ASINACOSATANATAN2TAN"], // float(float t)
  ["atan2", PF_atan2, 474, "DP_QC_ASINACOSATANATAN2TAN"], // float(float c, float s)
  ["tan", PF_tan, 475, "DP_QC_ASINACOSATANATAN2TAN"], // float(float a)
  ["tokenize_console", PF_tokenize_console, 514, "DP_QC_TOKENIZE_CONSOLE"], // float(string str)
  ["sprintf", PF_sprintf, 627, "DP_QC_SPRINTF"], // string(string fmt, ...)
];

// Ironwail's MAX_BUILTINS. Every slot is filled (PF_Fixme where nothing is
// ported), so an unported extension number is "unimplemented builtin" when
// called, not "Bad builtin call number" when reached.
const MAX_BUILTINS = 1280;

// name -> builtin number, for every builtin (id's and the extensions)
const pr_builtin_numbers = new Map();

const pr_builtin_table = (function () {
  const table = new Array(MAX_BUILTINS).fill(PF_Fixme);
  for (let i = 0; i < pr_builtin.length; i++) {
    table[i] = pr_builtin[i];
    if (pr_builtin_names[i]) {
      pr_builtin_numbers.set(pr_builtin_names[i], i);
    }
  }

  // as Ironwail, numberless builtins count down from MAX_BUILTINS - 2
  let next = MAX_BUILTINS - 2;
  for (const [name, func, number] of pr_extbuiltins) {
    const n = number !== 0 ? number : next--;
    table[n] = func;
    pr_builtin_numbers.set(name, n);
  }

  // Deliberate deviation from Ironwail: the re-release progs declare
  // "finaleFinished = #0:ex_finaleFinished" (capital F), but Ironwail
  // registers "ex_finalefinished", and the name match is case-sensitive.
  // Unbound, the "= #0" function returns 0 anyway; bind the progs' name
  // to the same slot so it reaches PF_finalefinished. Not a table row, so
  // the numberless slots above keep Ironwail's numbers.
  pr_builtin_numbers.set(
    "ex_finaleFinished",
    pr_builtin_numbers.get("ex_finalefinished"),
  );

  return table;
})();

/**
 * Called by PR_LoadProgs once the functions are parsed. Mirrors the second
 * half of Ironwail's PR_InitBuiltins: a function declared "= #0" (no
 * statements, parms or locals) is bound by name to the builtin with that name.
 * Also resets the state the extension builtins keep per progs: zoned strings
 * (they live in the string table that PR_LoadProgs replaces), tokens and the
 * clientstat registrations.
 */
export function PR_InitProgsBuiltins() {
  for (let i = 0; i < pr_functions.length; i++) {
    const func = pr_functions[i];
    if (
      func.first_statement !== 0 || func.parm_start !== 0 || func.locals !== 0
    ) {
      continue;
    }

    const number = pr_builtin_numbers.get(PR_GetString(func.s_name));
    if (number !== undefined) {
      func.first_statement = -number;
    }
  }

  PR_ClearZoneStrings();
  qctoken.length = 0;
  sv_customstats.length = 0;
}

/** Registers the builtin function table. Called during PR_Init. */
export function PR_InitBuiltins() {
  PR_SetBuiltins(pr_builtin_table, MAX_BUILTINS);

  // Wire up sv_move.js callbacks
  SV_Move_SetCallbacks({
    PF_changeyaw: PF_changeyaw,
    G_FLOAT: G_FLOAT,
    G_FLOAT_SET: G_FLOAT_SET,
  });
}
