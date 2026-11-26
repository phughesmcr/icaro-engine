// Ported from: WinQuake/pr_edict.c -- entity dictionary

import { Sys_Error } from "./sys.js";
import {
  COM_Parse,
  com_token,
  Con_DPrintf,
  Con_Printf,
  Q_atof,
} from "./common.js";
import { Cmd_AddCommand, Cmd_Argv } from "./cmd.js";
import { Cvar_RegisterVariable, cvar_t } from "./cvar.js";
import {
  PF_Format5_1f,
  PR_InitBuiltins,
  PR_InitProgsBuiltins,
} from "./pr_cmds.js";
import { CRC_Init, CRC_ProcessByte, CRC_Value } from "./crc.js";
import {
  ENTALPHA_DEFAULT,
  ENTALPHA_ENCODE,
  ENTALPHA_TOSAVE,
} from "./protocol.js";
import {
  ddef_t,
  DEF_SAVEGLOBAL,
  dfunction_t,
  dprograms_t,
  dstatement_t,
  ev_entity,
  ev_field,
  ev_float,
  ev_function,
  ev_pointer,
  ev_string,
  ev_vector,
  ev_void,
  MAX_PARMS,
  PROG_VERSION,
} from "./pr_comp.js";
import { PROGHEADER_CRC } from "./progdefs.js";
import { globalvars_t } from "./progdefs.js";
import {
  ED_GrowEdicts,
  EDICT_NUM,
  edict_t,
  EDICT_TO_PROG,
  EdictFieldAccessor,
  NUM_FOR_EDICT,
  PR_AppendString,
  pr_fielddefs,
  pr_functions,
  PR_GetString,
  pr_global_struct,
  pr_globaldefs,
  pr_globals,
  pr_globals_int,
  PR_HostError,
  PR_SetCRC,
  PR_SetEdictSize,
  PR_SetFieldDefs,
  PR_SetFunctions,
  PR_SetGlobalDefs,
  PR_SetGlobals,
  PR_SetGlobalsFloat,
  PR_SetGlobalsInt,
  PR_SetGlobalStruct,
  PR_SetProgs,
  PR_SetStatements,
  PR_SetStringsData,
  PR_SetStringTempOfs,
  progs,
  STRINGTEMP_BUFFERS,
  STRINGTEMP_LENGTH,
  sv,
  svs,
  type_size,
} from "./progs.js";
import { PR_ExecuteProgram } from "./pr_exec.js";
import { SV_UnlinkEdict } from "./world.js";
import { SV_ReserveSignonSpace } from "./sv_main.js";
import {
  EF_QEX_CANDLELIGHT,
  EF_QEX_PENTALIGHT,
  EF_QEX_QUADLIGHT,
} from "./server.js";

// Module state

const MAX_FIELD_LEN = 64;
const GEFV_CACHESIZE = 2;

const gefvCache = [
  { pcache: null, field: "" },
  { pcache: null, field: "" },
];

// Cvar stubs (will be replaced when cvar system is connected)

export const nomonsters = new cvar_t("nomonsters", "0");
const gamecfg = new cvar_t("gamecfg", "0");
const scratch1 = new cvar_t("scratch1", "0");
const scratch2 = new cvar_t("scratch2", "0");
const scratch3 = new cvar_t("scratch3", "0");
const scratch4 = new cvar_t("scratch4", "0");
const savedgamecfg = new cvar_t("savedgamecfg", "0", true);
const saved1 = new cvar_t("saved1", "0", true);
const saved2 = new cvar_t("saved2", "0", true);
const saved3 = new cvar_t("saved3", "0", true);
const saved4 = new cvar_t("saved4", "0", true);

// Spawn flag constants
const SPAWNFLAG_NOT_EASY = 256;
const SPAWNFLAG_NOT_MEDIUM = 512;
const SPAWNFLAG_NOT_HARD = 1024;
const SPAWNFLAG_NOT_DEATHMATCH = 2048;

// Movetype constant needed by ED_Count
const MOVETYPE_STEP = 4;

// deathmatch cvar reference (stub)
let deathmatch = { value: 0 };
let current_skill = 0;

export function PR_SetDeathmatch(dm) {
  deathmatch = dm;
}
export function PR_SetCurrentSkill(s) {
  current_skill = s;
}

/** Sets everything to NULL */
export function ED_ClearEdict(e) {
  e.clearFields();
  e.free = false;
}

// Ironwail's qcvm->extfields: field offsets for the extension fields the
// engine reads (set by PR_LoadProgs; -1 if the progs lacks the field)
export const pr_extfields = { alpha: -1 };

// Ironwail's qcvm->effects_mask (set by PR_LoadProgs): the effects bits the
// server sends. The 2021 rerelease light bits are on only for a progs that
// defines them (PR_FindSupportedEffects).
export let pr_effects_mask = -1;
export function PR_SetEffectsMask(mask) {
  pr_effects_mask = mask;
}

/**
 * Either finds a free edict, or allocates a new one.
 * Try to avoid reusing an entity that was recently freed, because it
 * can cause the client to think the entity morphed into something else
 * instead of being removed and recreated, which can cause interpolated
 * angles and bad trails.
 */
export function ED_Alloc() {
  let i;

  // skip clients + world entity
  for (i = svs.maxclients + 1; i < sv.num_edicts; i++) {
    const e = EDICT_NUM(i);
    // the first couple seconds of server time can involve a lot of
    // freeing and allocating, so relax the replacement policy
    if (e.free && (e.freetime < 2 || sv.time - e.freetime > 0.5)) {
      ED_ClearEdict(e);
      return e;
    }
  }

  // id compares with MAX_EDICTS; Ironwail with qcvm->max_edicts
  if (i === sv.max_edicts) {
    PR_HostError(
      "ED_Alloc: no free edicts (max_edicts is " + sv.max_edicts + ")",
    ); // id: Sys_Error; Ironwail's Host_Error (deliberate deviation)
  }

  sv.num_edicts++;
  ED_GrowEdicts(sv.num_edicts + 1); // keep NEXT_EDICT of the last one valid
  const e = EDICT_NUM(i);
  ED_ClearEdict(e);

  return e;
}

/** Marks the edict as free */
export function ED_Free(ed) {
  SV_UnlinkEdict(ed); // unlink from world bsp

  ed.free = true;
  ed.v.model = 0;
  ed.v.takedamage = 0;
  ed.v.modelindex = 0;
  ed.v.colormap = 0;
  ed.v.skin = 0;
  ed.v.frame = 0;
  const origin = ed.v.origin;
  origin[0] = 0;
  origin[1] = 0;
  origin[2] = 0;
  const angles = ed.v.angles;
  angles[0] = 0;
  angles[1] = 0;
  angles[2] = 0;
  ed.v.nextthink = -1;
  ed.v.solid = 0;
  ed.alpha = ENTALPHA_DEFAULT; //johnfitz -- reset alpha for next entity

  ed.freetime = sv.time;
}

export function ED_GlobalAtOfs(ofs) {
  for (let i = 0; i < progs.numglobaldefs; i++) {
    const def = pr_globaldefs[i];
    if (def.ofs === ofs) {
      return def;
    }
  }

  return null;
}

export function ED_FieldAtOfs(ofs) {
  // Deviation from id's C, which started at 0: fielddef 0 is the null def
  // with ofs 0, so .modelindex (also ofs 0) was never found. Ironwail
  // commit fe459b4 starts at 1.
  for (let i = 1; i < progs.numfielddefs; i++) {
    const def = pr_fielddefs[i];
    if (def.ofs === ofs) {
      return def;
    }
  }

  return null;
}

// Not in the C: the C scans the defs comparing strings. The names never
// change once a progs is loaded, so each table is indexed once by name, first
// def winning as in the scan, and the index is rebuilt when PR_LoadProgs
// swaps the table. (Without it every entity key and spawn function paid a
// scan of the whole table, building a string per def.)
let fieldIndex = null, fieldIndexDefs = null, fieldIndexCount = 0;
let globalIndex = null, globalIndexDefs = null, globalIndexCount = 0;
let functionIndex = null, functionIndexDefs = null, functionIndexCount = 0;

function ED_BuildIndex(defs, count) {
  const index = new Map();
  for (let i = 0; i < count; i++) {
    const name = PR_GetString(defs[i].s_name);
    if (!index.has(name)) {
      index.set(name, i);
    }
  }

  return index;
}

export function ED_FindField(name) {
  if (
    fieldIndex === null || fieldIndexDefs !== pr_fielddefs ||
    fieldIndexCount !== progs.numfielddefs
  ) {
    fieldIndex = ED_BuildIndex(pr_fielddefs, progs.numfielddefs);
    fieldIndexDefs = pr_fielddefs;
    fieldIndexCount = progs.numfielddefs;
  }

  const i = fieldIndex.get(name);
  return i !== undefined ? pr_fielddefs[i] : null;
}

export function ED_FindGlobal(name) {
  if (
    globalIndex === null || globalIndexDefs !== pr_globaldefs ||
    globalIndexCount !== progs.numglobaldefs
  ) {
    globalIndex = ED_BuildIndex(pr_globaldefs, progs.numglobaldefs);
    globalIndexDefs = pr_globaldefs;
    globalIndexCount = progs.numglobaldefs;
  }

  const i = globalIndex.get(name);
  return i !== undefined ? pr_globaldefs[i] : null;
}

/** Not in the C: the index of the function in pr_functions, or -1. */
function ED_FindFunctionIndex(name) {
  if (
    functionIndex === null || functionIndexDefs !== pr_functions ||
    functionIndexCount !== progs.numfunctions
  ) {
    functionIndex = ED_BuildIndex(pr_functions, progs.numfunctions);
    functionIndexDefs = pr_functions;
    functionIndexCount = progs.numfunctions;
  }

  const i = functionIndex.get(name);
  return i !== undefined ? i : -1;
}

export function ED_FindFunction(name) {
  const i = ED_FindFunctionIndex(name);
  return i >= 0 ? pr_functions[i] : null;
}

// GetEdictFieldValue
let gefvCache_rep = 0;

export function GetEdictFieldValue(ed, field) {
  let def = null;

  for (let i = 0; i < GEFV_CACHESIZE; i++) {
    if (field === gefvCache[i].field) {
      def = gefvCache[i].pcache;
      if (def === null) {
        return null;
      }
      return { accessor: ed._fieldAccessor, ofs: def.ofs };
    }
  }

  def = ED_FindField(field);

  if (field.length < MAX_FIELD_LEN) {
    gefvCache[gefvCache_rep].pcache = def;
    gefvCache[gefvCache_rep].field = field;
    gefvCache_rep ^= 1;
  }

  if (def === null) {
    return null;
  }

  return { accessor: ed._fieldAccessor, ofs: def.ofs };
}

/** Returns a string describing *data in a type specific manner */
export function PR_ValueString(type, accessor, ofs) {
  type &= ~DEF_SAVEGLOBAL;

  switch (type) {
    case ev_string:
      return PR_GetString(accessor.getInt32(ofs));
    case ev_entity:
      return "entity " + accessor.getInt32(ofs);
    case ev_function: {
      const f = pr_functions[accessor.getInt32(ofs)];
      return PR_GetString(f.s_name) + "()";
    }

    case ev_field: {
      const def = ED_FieldAtOfs(accessor.getInt32(ofs));
      return "." + PR_GetString(def.s_name);
    }

    case ev_void:
      return "void";
    case ev_float:
      return PF_Format5_1f(accessor.getFloat(ofs)); // "%5.1f"
    case ev_vector: {
      // "'%5.1f %5.1f %5.1f'"
      const v = accessor.getVector(ofs);
      return "'" + PF_Format5_1f(v[0]) + " " + PF_Format5_1f(v[1]) + " " +
        PF_Format5_1f(v[2]) + "'";
    }

    case ev_pointer:
      return "pointer";
    default:
      return "bad type " + type;
  }
}

/**
 * Returns a string describing *data in a type specific manner
 * Easier to parse than PR_ValueString
 */
export function PR_UglyValueString(type, accessor, ofs) {
  type &= ~DEF_SAVEGLOBAL;

  switch (type) {
    case ev_string:
      return PR_GetString(accessor.getInt32(ofs));
    case ev_entity:
      return "" + accessor.getInt32(ofs);
    case ev_function: {
      const f = pr_functions[accessor.getInt32(ofs)];
      return PR_GetString(f.s_name);
    }

    case ev_field: {
      const def = ED_FieldAtOfs(accessor.getInt32(ofs));
      return PR_GetString(def.s_name);
    }

    case ev_void:
      return "void";
    case ev_float:
      return "" + accessor.getFloat(ofs);
    case ev_vector: {
      const v = accessor.getVector(ofs);
      return v[0] + " " + v[1] + " " + v[2];
    }

    default:
      return "bad type " + type;
  }
}

/**
 * Returns a string with a description and the contents of a global,
 * padded to 20 field width
 */
export function PR_GlobalString(ofs) {
  const def = ED_GlobalAtOfs(ofs);
  let line;

  if (def === null) {
    line = ofs + "(???)";
  } else {
    const s = PR_ValueString(def.type, pr_globals, ofs);
    line = ofs + "(" + PR_GetString(def.s_name) + ")" + s;
  }

  while (line.length < 20) {
    line += " ";
  }
  line += " ";

  return line;
}

export function PR_GlobalStringNoContents(ofs) {
  const def = ED_GlobalAtOfs(ofs);
  let line;

  if (def === null) {
    line = ofs + "(???)";
  } else {
    line = ofs + "(" + PR_GetString(def.s_name) + ")";
  }

  while (line.length < 20) {
    line += " ";
  }
  line += " ";

  return line;
}

/** For debugging */
export function ED_Print(ed) {
  if (ed.free) {
    Con_Printf("FREE\n");
    return;
  }

  Con_Printf("\nEDICT %i:\n", NUM_FOR_EDICT(ed));

  for (let i = 1; i < progs.numfielddefs; i++) {
    const d = pr_fielddefs[i];
    const name = PR_GetString(d.s_name);
    if (name.length >= 2 && name[name.length - 2] === "_") {
      continue; // skip _x, _y, _z vars
    }

    // if the value is still all 0, skip the field
    const type = d.type & ~DEF_SAVEGLOBAL;
    let allZero = true;

    for (let j = 0; j < type_size[type]; j++) {
      if (ed._fieldAccessor.getInt32(d.ofs + j) !== 0) {
        allZero = false;
        break;
      }
    }

    if (allZero) {
      continue;
    }

    let line = name;
    while (line.length < 15) {
      line += " ";
    }

    line += PR_ValueString(d.type, ed._fieldAccessor, d.ofs);

    Con_Printf("%s\n", line);
  }
}

/** For savegames */
export function ED_Write(lines, ed) {
  lines.push("{");

  if (ed.free) {
    lines.push("}");
    return;
  }

  for (let i = 1; i < progs.numfielddefs; i++) {
    const d = pr_fielddefs[i];
    const name = PR_GetString(d.s_name);
    if (name.length >= 2 && name[name.length - 2] === "_") {
      continue; // skip _x, _y, _z vars
    }

    const type = d.type & ~DEF_SAVEGLOBAL;
    let allZero = true;

    for (let j = 0; j < type_size[type]; j++) {
      if (ed._fieldAccessor.getInt32(d.ofs + j) !== 0) {
        allZero = false;
        break;
      }
    }

    if (allZero) {
      continue;
    }

    lines.push(
      '"' + name + '" "' +
        PR_UglyValueString(d.type, ed._fieldAccessor, d.ofs) + '"',
    );
  }

  //johnfitz -- save entity alpha manually when progs.dat doesn't know about alpha
  if (pr_extfields.alpha < 0 && ed.alpha !== ENTALPHA_DEFAULT) {
    lines.push('"alpha" "' + ENTALPHA_TOSAVE(ed.alpha).toFixed(6) + '"');
  }
  //johnfitz

  lines.push("}");
}

export function ED_PrintNum(ent) {
  ED_Print(EDICT_NUM(ent));
}

/** For debugging, prints a single edict */
function ED_PrintEdict_f() {
  const i = parseInt(Cmd_Argv(1)) || 0;
  if (i >= sv.num_edicts) {
    Con_Printf("Bad edict number\n");
    return;
  }

  ED_PrintNum(i);
}

/** For debugging, prints all the entities in the current server */
export function ED_PrintEdicts() {
  Con_Printf("%i entities\n", sv.num_edicts);
  for (let i = 0; i < sv.num_edicts; i++) {
    ED_PrintNum(i);
  }
}

/** For debugging */
export function ED_Count() {
  let active = 0, models = 0, solid = 0, step = 0;

  for (let i = 0; i < sv.num_edicts; i++) {
    const ent = EDICT_NUM(i);
    if (ent.free) {
      continue;
    }
    active++;
    if (ent.v.solid) {
      solid++;
    }
    if (ent.v.model) {
      models++;
    }
    if (ent.v.movetype === MOVETYPE_STEP) {
      step++;
    }
  }

  Con_Printf("num_edicts:%3i\n", sv.num_edicts);
  Con_Printf("active    :%3i\n", active);
  Con_Printf("view      :%3i\n", models);
  Con_Printf("touch     :%3i\n", solid);
  Con_Printf("step      :%3i\n", step);
}

// ARCHIVING GLOBALS
//
// FIXME: need to tag constants, doesn't really work

export function ED_WriteGlobals(lines) {
  lines.push("{");

  for (let i = 0; i < progs.numglobaldefs; i++) {
    const def = pr_globaldefs[i];
    let type = def.type;

    if (!(def.type & DEF_SAVEGLOBAL)) {
      continue;
    }
    type &= ~DEF_SAVEGLOBAL;

    if (type !== ev_string && type !== ev_float && type !== ev_entity) {
      continue;
    }

    const name = PR_GetString(def.s_name);
    lines.push(
      '"' + name + '" "' + PR_UglyValueString(type, pr_globals, def.ofs) + '"',
    );
  }

  lines.push("}");
}

/**
 * Returns the text after the closing brace, as Ironwail's does (id's returns
 * nothing; Host_Loadgame_f needs it to go on to the edicts).
 */
export function ED_ParseGlobals(data) {
  while (true) {
    // parse key
    data = COM_Parse(data);
    if (com_token === "}") {
      break;
    }
    if (data === null) {
      PR_HostError("ED_ParseEntity: EOF without closing brace"); // id: Sys_Error; Ironwail's Host_Error (deliberate deviation)
    }

    const keyname = com_token;

    // parse value
    data = COM_Parse(data);
    if (data === null) {
      PR_HostError("ED_ParseEntity: EOF without closing brace"); // id: Sys_Error; Ironwail's Host_Error (deliberate deviation)
    }

    if (com_token === "}") {
      PR_HostError("ED_ParseEntity: closing brace without data"); // id: Sys_Error; Ironwail's Host_Error (deliberate deviation)
    }

    const key = ED_FindGlobal(keyname);
    if (key === null) {
      Con_Printf("'%s' is not a global\n", keyname);
      continue;
    }

    if (!ED_ParseEpair(pr_globals, key, com_token)) {
      PR_HostError("ED_ParseGlobals: parse error"); // Host_Error as in id
    }
  }

  return data;
}

/**
 * Returns an offset into the string table for a newly allocated string.
 * Handles backslash-n escape sequences.
 */
export function ED_NewString(string) {
  // Use array + join() instead of string concatenation to avoid O(n²) allocations
  const chars = [];

  for (let i = 0; i < string.length; i++) {
    if (string[i] === "\\" && i < string.length - 1) {
      i++;
      if (string[i] === "n") {
        chars.push("\n");
      } else {
        chars.push("\\");
      }
    } else {
      chars.push(string[i]);
    }
  }

  return PR_AppendString(chars.join(""));
}

/**
 * Can parse either fields or globals
 * returns false if error
 */
export function ED_ParseEpair(accessor, key, s) {
  const ofs = key.ofs;

  switch (key.type & ~DEF_SAVEGLOBAL) {
    case ev_string:
      accessor.setInt32(ofs, ED_NewString(s));
      break;

    case ev_float:
      // atof() gives 0 where parseFloat gives NaN (e.g. "wait" "")
      accessor.setFloat(ofs, parseFloat(s) || 0);
      break;

    case ev_vector: {
      const parts = s.split(" ");
      accessor.setFloat(ofs, parseFloat(parts[0]) || 0);
      accessor.setFloat(ofs + 1, parseFloat(parts[1]) || 0);
      accessor.setFloat(ofs + 2, parseFloat(parts[2]) || 0);
      break;
    }

    case ev_entity:
      accessor.setInt32(ofs, EDICT_TO_PROG(EDICT_NUM(parseInt(s))));
      break;

    case ev_field: {
      const def = ED_FindField(s);
      if (def === null) {
        Con_Printf("Can't find field %s\n", s);
        return false;
      }

      accessor.setInt32(ofs, pr_globals_int[def.ofs]);
      break;
    }

    case ev_function: {
      const func = ED_FindFunction(s);
      if (func === null) {
        Con_Printf("Can't find function %s\n", s);
        return false;
      }

      accessor.setInt32(ofs, ED_FindFunctionIndex(s));
      break;
    }

    default:
      break;
  }

  return true;
}

/**
 * Parses an edict out of the given string, returning the new position
 * ed should be a properly initialized empty edict.
 * Used for initial level load and for savegames.
 */
export function ED_ParseEdict(data, ent) {
  let init = false;

  // clear it
  if (ent !== sv.edicts[0]) { // hack
    ent.clearFields();
  }

  // go through all the dictionary pairs
  while (true) {
    // parse key
    data = COM_Parse(data);
    if (com_token === "}") {
      break;
    }
    if (data === null) {
      PR_HostError("ED_ParseEntity: EOF without closing brace"); // id: Sys_Error; Ironwail's Host_Error (deliberate deviation)
    }

    // anglehack is to allow QuakeEd to write single scalar angles
    // and allow them to be turned into vectors. (FIXME...)
    const anglehack = com_token === "angle";
    let keyname = anglehack ? "angles" : com_token;

    // FIXME: change light to _light to get rid of this hack
    if (keyname === "light") {
      keyname = "light_lev"; // hack for single light def
    }

    // another hack to fix keynames with trailing spaces
    keyname = keyname.trimEnd();

    // parse value
    data = COM_Parse(data);
    if (data === null) {
      PR_HostError("ED_ParseEntity: EOF without closing brace"); // id: Sys_Error; Ironwail's Host_Error (deliberate deviation)
    }

    if (com_token === "}") {
      PR_HostError("ED_ParseEntity: closing brace without data"); // id: Sys_Error; Ironwail's Host_Error (deliberate deviation)
    }

    init = true;

    // keynames with a leading underscore are used for utility comments,
    // and are immediately discarded by quake
    if (keyname[0] === "_") {
      continue;
    }

    //johnfitz -- hack to support .alpha even when progs.dat doesn't know about it
    if (keyname === "alpha") {
      ent.alpha = ENTALPHA_ENCODE(Q_atof(com_token));
    }
    //johnfitz

    const key = ED_FindField(keyname);
    if (key === null) {
      // Deviation from id's C (Con_Printf): Ironwail/FitzQuake print this
      // only with developer set, and stay silent for the sky, fog and
      // alpha keys that map editors add but defs.qc may not declare.
      if (
        !keyname.startsWith("sky") && keyname !== "fog" && keyname !== "alpha"
      ) {
        Con_DPrintf("'%s' is not a field\n", keyname);
      }
      continue;
    }

    let value = com_token;
    if (anglehack) {
      value = "0 " + com_token + " 0";
    }

    if (!ED_ParseEpair(ent._fieldAccessor, key, value)) {
      PR_HostError("ED_ParseEdict: parse error"); // Host_Error as in id
    }
  }

  if (!init) {
    ent.free = true;
  }

  return data;
}

/**
 * The entities are directly placed in the array, rather than allocated with
 * ED_Alloc, because otherwise an error loading the map would have entity
 * number references out of order.
 *
 * Creates a server's entity / program execution context by
 * parsing textual entity definitions out of an ent file.
 *
 * Used for both fresh maps and savegame loads. A fresh map would also need
 * to call ED_CallSpawnFunctions () to let the objects initialize themselves.
 */
export function ED_LoadFromFile(data) {
  let ent = null;
  let inhibit = 0;
  pr_global_struct.time = sv.time;

  // parse ents
  while (true) {
    // parse the opening brace
    data = COM_Parse(data);
    if (data === null) {
      break;
    }
    if (com_token !== "{") {
      PR_HostError("ED_LoadFromFile: found " + com_token + " when expecting {"); // id: Sys_Error; Ironwail's Host_Error (deliberate deviation)
    }

    if (ent === null) {
      ent = EDICT_NUM(0);
    } else {
      ent = ED_Alloc();
    }

    data = ED_ParseEdict(data, ent);

    // remove things from different skill levels or deathmatch
    if (deathmatch.value !== 0) {
      if (((ent.v.spawnflags | 0) & SPAWNFLAG_NOT_DEATHMATCH)) {
        ED_Free(ent);
        inhibit++;
        continue;
      }
    } else if (
      (current_skill === 0 && ((ent.v.spawnflags | 0) & SPAWNFLAG_NOT_EASY)) ||
      (current_skill === 1 &&
        ((ent.v.spawnflags | 0) & SPAWNFLAG_NOT_MEDIUM)) ||
      (current_skill >= 2 && ((ent.v.spawnflags | 0) & SPAWNFLAG_NOT_HARD))
    ) {
      ED_Free(ent);
      inhibit++;
      continue;
    }

    // immediately call spawn function
    //
    // Check if classname string is empty (offset 0 points to empty string)
    const classname = PR_GetString(ent.v.classname);
    if (classname === "") {
      Con_Printf("No classname for:\n");
      ED_Print(ent);
      ED_Free(ent);
      continue;
    }

    // remove monsters if nomonsters is set (Ironwail; id registers the
    // cvar but never reads it)
    if (sv.nomonsters && classname.startsWith("monster_")) {
      ED_Free(ent);
      inhibit++;
      continue;
    }

    // look for the spawn function
    const func = ED_FindFunction(classname);

    if (func == null) {
      Con_Printf("No spawn function for:\n");
      ED_Print(ent);
      ED_Free(ent);
      continue;
    }

    // Ironwail: room for the spawn function's MSG_INIT writes, so
    // they don't straddle two signon buffers
    SV_ReserveSignonSpace(512);

    pr_global_struct.self = EDICT_TO_PROG(ent);
    PR_ExecuteProgram(ED_FindFunctionIndex(classname));
  }

  Con_DPrintf("%i entities inhibited\n", inhibit);
}

/** Loads progs.dat from the provided ArrayBuffer */
export function PR_LoadProgs(fileData) {
  // flush the non-C variable lookup cache
  for (let i = 0; i < GEFV_CACHESIZE; i++) {
    gefvCache[i].field = "";
  }

  // fileData is an ArrayBuffer of progs.dat
  if (fileData === null) {
    Sys_Error("PR_LoadProgs: couldn't load progs.dat");
  }

  Con_DPrintf("Programs occupy %iK.\n", (fileData.byteLength / 1024) | 0);

  const dataView = new DataView(fileData);
  const byteView = new Uint8Array(fileData);

  // CRC computation - compute CRC over entire progs.dat file
  let crc = CRC_Init();
  for (let i = 0; i < byteView.length; i++) {
    crc = CRC_ProcessByte(crc, byteView[i]);
  }

  PR_SetCRC(CRC_Value(crc));

  // Parse header (dprograms_t) - all fields are int32 little-endian
  const header = new dprograms_t();
  let offset = 0;

  header.version = dataView.getInt32(offset, true);
  offset += 4;
  header.crc = dataView.getInt32(offset, true);
  offset += 4;
  header.ofs_statements = dataView.getInt32(offset, true);
  offset += 4;
  header.numstatements = dataView.getInt32(offset, true);
  offset += 4;
  header.ofs_globaldefs = dataView.getInt32(offset, true);
  offset += 4;
  header.numglobaldefs = dataView.getInt32(offset, true);
  offset += 4;
  header.ofs_fielddefs = dataView.getInt32(offset, true);
  offset += 4;
  header.numfielddefs = dataView.getInt32(offset, true);
  offset += 4;
  header.ofs_functions = dataView.getInt32(offset, true);
  offset += 4;
  header.numfunctions = dataView.getInt32(offset, true);
  offset += 4;
  header.ofs_strings = dataView.getInt32(offset, true);
  offset += 4;
  header.numstrings = dataView.getInt32(offset, true);
  offset += 4;
  header.ofs_globals = dataView.getInt32(offset, true);
  offset += 4;
  header.numglobals = dataView.getInt32(offset, true);
  offset += 4;
  header.entityfields = dataView.getInt32(offset, true);
  offset += 4;

  if (header.version !== PROG_VERSION) {
    PR_HostError(
      "progs.dat has wrong version number (" + header.version + " should be " +
        PROG_VERSION + ")",
    ); // id: Sys_Error; Ironwail's Host_Error (deliberate deviation)
  }
  if (header.crc !== PROGHEADER_CRC) {
    PR_HostError(
      "progs.dat system vars have been modified, progdefs.h is out of date",
    ); // id: Sys_Error; Ironwail's Host_Error (deliberate deviation)
  }

  PR_SetProgs(header);

  // Parse strings, with room after them for the pr_string_temp buffers
  const stringsDataWithTemp = new Uint8Array(
    header.numstrings + STRINGTEMP_BUFFERS * STRINGTEMP_LENGTH,
  );
  stringsDataWithTemp.set(
    new Uint8Array(fileData, header.ofs_strings, header.numstrings),
  );
  // Zero-fill the temp area (already done by Uint8Array constructor)
  PR_SetStringsData(stringsDataWithTemp);
  PR_SetStringTempOfs(header.numstrings);

  // Parse statements
  const statements = [];
  offset = header.ofs_statements;
  for (let i = 0; i < header.numstatements; i++) {
    const st = new dstatement_t();
    st.op = dataView.getUint16(offset, true);
    offset += 2;
    st.a = dataView.getInt16(offset, true);
    offset += 2;
    st.b = dataView.getInt16(offset, true);
    offset += 2;
    st.c = dataView.getInt16(offset, true);
    offset += 2;
    statements.push(st);
  }

  PR_SetStatements(statements);

  // Parse functions
  const functions = [];
  offset = header.ofs_functions;
  for (let i = 0; i < header.numfunctions; i++) {
    const f = new dfunction_t();
    f.first_statement = dataView.getInt32(offset, true);
    offset += 4;
    f.parm_start = dataView.getInt32(offset, true);
    offset += 4;
    f.locals = dataView.getInt32(offset, true);
    offset += 4;
    f.profile = dataView.getInt32(offset, true);
    offset += 4;
    f.s_name = dataView.getInt32(offset, true);
    offset += 4;
    f.s_file = dataView.getInt32(offset, true);
    offset += 4;
    f.numparms = dataView.getInt32(offset, true);
    offset += 4;
    for (let j = 0; j < MAX_PARMS; j++) {
      f.parm_size[j] = byteView[offset + j];
    }

    offset += MAX_PARMS;
    functions.push(f);
  }

  PR_SetFunctions(functions);

  // bind "= #0" builtins by name, and reset per-progs builtin state
  PR_InitProgsBuiltins();

  // Parse globaldefs
  const globaldefs = [];
  offset = header.ofs_globaldefs;
  for (let i = 0; i < header.numglobaldefs; i++) {
    const def = new ddef_t();
    def.type = dataView.getUint16(offset, true);
    offset += 2;
    def.ofs = dataView.getUint16(offset, true);
    offset += 2;
    def.s_name = dataView.getInt32(offset, true);
    offset += 4;
    globaldefs.push(def);
  }

  PR_SetGlobalDefs(globaldefs);

  // Parse fielddefs
  const fielddefs = [];
  offset = header.ofs_fielddefs;
  for (let i = 0; i < header.numfielddefs; i++) {
    const def = new ddef_t();
    def.type = dataView.getUint16(offset, true);
    offset += 2;
    if (def.type & DEF_SAVEGLOBAL) {
      PR_HostError("PR_LoadProgs: pr_fielddefs[i].type & DEF_SAVEGLOBAL"); // id: Sys_Error; Ironwail's Host_Error (deliberate deviation)
    }
    def.ofs = dataView.getUint16(offset, true);
    offset += 2;
    def.s_name = dataView.getInt32(offset, true);
    offset += 4;
    fielddefs.push(def);
  }

  PR_SetFieldDefs(fielddefs);

  // Parse globals
  // Globals are stored as raw 32-bit values (can be read as int or float)
  const globalsBuffer = new ArrayBuffer(header.numglobals * 4);
  const globalsBytes = new Uint8Array(globalsBuffer);
  const srcGlobals = new Uint8Array(
    fileData,
    header.ofs_globals,
    header.numglobals * 4,
  );
  globalsBytes.set(srcGlobals);

  const globalsFloat = new Float32Array(globalsBuffer);
  const globalsInt = new Int32Array(globalsBuffer);
  const globalsAccessor = new EdictFieldAccessor(
    globalsBuffer,
    0,
    header.numglobals,
  );

  PR_SetGlobalsFloat(globalsFloat);
  PR_SetGlobalsInt(globalsInt);
  PR_SetGlobals(globalsAccessor);

  // Set up pr_global_struct as a globalvars_t proxy over the globals
  PR_SetGlobalStruct(new globalvars_t(globalsAccessor));

  // Calculate edict size
  // In C: pr_edict_size = progs->entityfields * 4 + sizeof(edict_t) - sizeof(entvars_t);
  // In JS we just store entityfields count - the edict_t class handles the rest
  PR_SetEdictSize(header.entityfields);

  // Ironwail PR_LoadProgs (QCEXTFIELD): the field offsets of the
  // extensions the engine reads, -1 when the progs doesn't declare them
  const alphadef = ED_FindField("alpha");
  pr_extfields.alpha = alphadef !== null ? alphadef.ofs : -1;

  pr_effects_mask = PR_FindSupportedEffects();
}

/** Ironwail pr_edict.c */
function PR_HasGlobal(name, value) {
  const g = ED_FindGlobal(name);
  return g !== null && (g.type & ~DEF_SAVEGLOBAL) === ev_float &&
    pr_globals.getFloat(g.ofs) === value;
}

/**
 * Ironwail pr_edict.c: checks for the presence of Quake 2021 release effects
 * flags and returns a mask with the corresponding bits either on or off
 * depending on the result, in order to avoid conflicts (e.g. Arcane Dimensions
 * uses bit 32 for its explosions)
 */
export function PR_FindSupportedEffects() {
  const isqex = PR_HasGlobal("EF_QUADLIGHT", EF_QEX_QUADLIGHT) &&
    (PR_HasGlobal("EF_PENTLIGHT", EF_QEX_PENTALIGHT) ||
      PR_HasGlobal("EF_PENTALIGHT", EF_QEX_PENTALIGHT));
  return isqex ?
    -1 :
    -1 & ~(EF_QEX_QUADLIGHT | EF_QEX_PENTALIGHT | EF_QEX_CANDLELIGHT);
}

function PR_Profile_f() {
  let num = 0;

  do {
    let max = 0;
    let best = null;

    for (let i = 0; i < progs.numfunctions; i++) {
      const f = pr_functions[i];
      if (f.profile > max) {
        max = f.profile;
        best = f;
      }
    }

    if (best != null) {
      if (num < 10) {
        Con_Printf("%7i %s\n", best.profile, PR_GetString(best.s_name));
      }

      num++;
      best.profile = 0;
    } else {
      break;
    }
  } while (true);
}

export function PR_Init() {
  Cmd_AddCommand("edict", ED_PrintEdict_f);
  Cmd_AddCommand("edicts", ED_PrintEdicts);
  Cmd_AddCommand("edictcount", ED_Count);
  Cmd_AddCommand("profile", PR_Profile_f);

  Cvar_RegisterVariable(nomonsters);
  Cvar_RegisterVariable(gamecfg);
  Cvar_RegisterVariable(scratch1);
  Cvar_RegisterVariable(scratch2);
  Cvar_RegisterVariable(scratch3);
  Cvar_RegisterVariable(scratch4);
  Cvar_RegisterVariable(savedgamecfg);
  Cvar_RegisterVariable(saved1);
  Cvar_RegisterVariable(saved2);
  Cvar_RegisterVariable(saved3);
  Cvar_RegisterVariable(saved4);

  PR_InitBuiltins();
}

/**
 * Allocates the edict array for the server.
 * Called by server init (not in original C - we need this because
 * JS doesn't have pointer arithmetic over a flat memory block).
 */
export function PR_AllocEdicts(maxEdicts, entityfields) {
  const edicts = [];
  for (let i = 0; i < maxEdicts; i++) {
    edicts.push(new edict_t(i, entityfields));
  }

  return edicts;
}
