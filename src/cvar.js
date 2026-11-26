// Ported from: WinQuake/cvar.c -- dynamic variable tracking

// cvar_t variables are used to hold scalar or string variables that can be
// changed or displayed at the console or prog code as well as accessed directly
// in C code.
//
// it is sufficient to initialize a cvar_t with just the first two fields, or
// you can add a ,true flag for variables that you want saved to the configuration
// file when the game is quit:
//
// Cvars must be registered before use, or they will have a 0 value instead of
// the float interpretation of the string. Generally, all cvar_t declarations
// should be registered in the appropriate init function before any console
// commands are executed:
// Cvar_RegisterVariable(host_framerate);

import { Con_Printf, Q_atof } from "./common.js";
import {
  Cmd_AddCommand,
  Cmd_Argc,
  Cmd_Argv,
  Cmd_Exists,
  Cmd_FromServer,
} from "./cmd.js";

// Callback for broadcasting server cvar changes (injected to avoid circular deps)
let _serverBroadcast = null;

export function Cvar_SetServerBroadcast(fn) {
  _serverBroadcast = fn;
}

// localStorage key prefix for saved cvars
const CVAR_STORAGE_PREFIX = "quake_cvar_";

// Save a cvar to localStorage
function Cvar_SaveToStorage(_var) {
  if (typeof localStorage === "undefined") return;

  try {
    localStorage.setItem(CVAR_STORAGE_PREFIX + _var.name, _var.string);
  } catch {
    // localStorage might be full or disabled
    Con_Printf(
      "Warning: Could not save cvar " + _var.name + " to localStorage\n",
    );
  }
}

// Load a cvar from localStorage (returns null if not found)
function Cvar_LoadFromStorage(name) {
  if (typeof localStorage === "undefined") return null;

  try {
    return localStorage.getItem(CVAR_STORAGE_PREFIX + name);
  } catch {
    return null;
  }
}

export class cvar_t {
  constructor(name, string, archive, server) {
    this.name = name;
    this.string = string || "";
    this.archive = archive || false; // set to true to cause it to be saved to vars.rc
    this.server = server || false; // notifies players when changed
    this.value = Q_atof(this.string);
    this.default_string = null; // johnfitz: the value "reset" restores, set by Cvar_RegisterVariable
    this.next = null;
  }
}

export let cvar_vars = null; // read by the console's tab completion

// Name lookup for Cvar_FindVar, which runs for every console command and
// QuakeC cvar() call. C walks the cvar_vars list; this map holds the same
// cvars.
const cvar_map = new Map();

export function Cvar_FindVar(var_name) {
  const _var = cvar_map.get(var_name);
  return _var === undefined ? null : _var;
}

export function Cvar_VariableValue(var_name) {
  const _var = Cvar_FindVar(var_name);
  if (!_var) {
    return 0;
  }
  return Q_atof(_var.string);
}

export function Cvar_VariableString(var_name) {
  const _var = Cvar_FindVar(var_name);
  if (!_var) {
    return "";
  }
  return _var.string;
}

export function Cvar_CompleteVariable(partial) {
  const len = partial.length;

  if (len === 0) {
    return null;
  }

  // check functions
  let _var = cvar_vars;
  while (_var) {
    if (_var.name.substring(0, len) === partial) {
      return _var.name;
    }
    _var = _var.next;
  }

  return null;
}

/**
 * Ironwail: sets the function that lists a cvar's values for console tab
 * completion. It is called as func( var, partial ) and adds each value with
 * Con_AddToTabList. Not in id's cvar.c.
 */
export function Cvar_SetCompletion(variable, func) {
  variable.completion = func;
}

// Deviation (web-only, no C equivalent): the cvars a remote server changed
// through svc_stufftext (cmd.js Cbuf_AddServerText), each with the value it
// had before. A server's value is used but never saved: Cvar_Set skips
// localStorage, Cvar_WriteVariables writes the player's value, and
// CL_Disconnect puts the player's values back. A change by the player drops
// the entry, so the player's own value is saved as usual.
const cvar_server_saved = new Map();

/** Web-only: puts back every cvar a remote server changed (CL_Disconnect) */
export function Cvar_RestoreServerChanges() {
  for (const [name, string] of cvar_server_saved) {
    const _var = Cvar_FindVar(name);
    _var.string = string;
    _var.value = Q_atof(string);
  }

  cvar_server_saved.clear();
}

export function Cvar_Set(var_name, value) {
  const _var = Cvar_FindVar(var_name);
  if (!_var) {
    // there is an error in C code if this happens
    Con_Printf("Cvar_Set: variable " + var_name + " not found\n");
    return;
  }

  const changed = _var.string !== value;

  const fromServer = Cmd_FromServer();
  if (fromServer === true) {
    if (cvar_server_saved.has(_var.name) === false) {
      cvar_server_saved.set(_var.name, _var.string);
    }
  } else {
    cvar_server_saved.delete(_var.name);
  }

  _var.string = value;
  _var.value = Q_atof(_var.string);

  if (_var.server && changed) {
    if (_serverBroadcast != null) {
      _serverBroadcast(
        '"' + _var.name + '" changed to "' + _var.string + '"\n',
      );
    }
  }

  // Save to localStorage if this cvar should be archived
  if (_var.archive && changed && fromServer === false) {
    Cvar_SaveToStorage(_var);
  }
}

export function Cvar_SetValue(var_name, value) {
  // Match original Quake behavior (va("%f", value)) and avoid scientific
  // notation strings that Q_atof cannot parse correctly.
  if (Number.isFinite(value) === true) {
    Cvar_Set(var_name, value.toFixed(6));
    return;
  }

  Cvar_Set(var_name, String(value));
}

/** Adds a freestanding variable to the variable list. */
export function Cvar_RegisterVariable(variable) {
  // first check to see if it has already been defined
  if (Cvar_FindVar(variable.name)) {
    Con_Printf(
      "Can't register variable " + variable.name + ", already defined\n",
    );
    return;
  }

  // check for overlap with a command
  if (Cmd_Exists(variable.name)) {
    Con_Printf("Cvar_RegisterVariable: " + variable.name + " is a command\n");
    return;
  }

  // johnfitz: keep the initial value for "reset". Ironwail also takes
  // values set before Host_Init ends (default.cfg) as the default; this
  // port runs its configs after init, so the default is the value the code
  // registers, taken before a saved value replaces it.
  variable.default_string = variable.string;

  // Check for saved value in localStorage (for archived cvars)
  if (variable.archive) {
    const savedValue = Cvar_LoadFromStorage(variable.name);
    if (savedValue !== null) {
      variable.string = savedValue;
    }
  }

  // parse the value
  variable.value = Q_atof(variable.string);

  // link the variable in
  variable.next = cvar_vars;
  cvar_vars = variable;
  cvar_map.set(variable.name, variable);
}

/** Handles variable inspection and changing from the console */
export function Cvar_Command() {
  const v = Cvar_FindVar(Cmd_Argv(0));
  if (!v) {
    return false;
  }

  // perform a variable print or set. Ironwail adds the default.
  if (Cmd_Argc() === 1) {
    if (v.default_string !== null) {
      if (v.string === v.default_string) {
        Con_Printf('"' + v.name + '" is "' + v.string + '" (default)\n');
      } else {
        Con_Printf(
          '"' + v.name + '" is "' + v.string + '" (default: "' +
            v.default_string + '")\n',
        );
      }
    } else {
      Con_Printf('"' + v.name + '" is "' + v.string + '"\n');
    }

    return true;
  }

  Cvar_Set(v.name, Cmd_Argv(1));
  return true;
}

/**
 * Writes lines containing "set variable value" for all variables
 * with the archive flag set to true.
 */
export function Cvar_WriteVariables() {
  const lines = [];
  let _var = cvar_vars;
  while (_var) {
    if (_var.archive) {
      // a remote server's value is not saved (Cvar_RestoreServerChanges)
      const saved = cvar_server_saved.get(_var.name);
      const string = saved === undefined ? _var.string : saved;
      lines.push(_var.name + ' "' + string + '"\n');
    }
    _var = _var.next;
  }

  return lines.join("");
}

// Cvar_Reset -- johnfitz
export function Cvar_Reset(name) {
  const _var = Cvar_FindVar(name);
  if (_var === null) {
    Con_Printf('variable "' + name + '" not found\n');
  } else {
    Cvar_Set(_var.name, _var.default_string);
  }
}

// cvar_vars sorted by name: Ironwail keeps its list in that order
function Cvar_SortedList() {
  const list = [];
  for (let _var = cvar_vars; _var !== null; _var = _var.next) {
    list.push(_var);
  }
  return list.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

// Cvar_List_f -- johnfitz
function Cvar_List_f() {
  const partial = Cmd_Argc() > 1 ? Cmd_Argv(1) : null;

  let count = 0;
  for (const _var of Cvar_SortedList()) {
    if (partial !== null && _var.name.startsWith(partial) !== true) {
      continue;
    }
    Con_Printf(
      (_var.archive ? "*" : " ") + (_var.server ? "s" : " ") +
        " " + _var.name + ' "' + _var.string + '"\n',
    );
    count++;
  }

  Con_Printf(
    count + " cvars" +
      (partial !== null ? ' beginning with "' + partial + '"' : "") + "\n",
  );
}

// Cvar_Inc_f -- johnfitz
function Cvar_Inc_f() {
  switch (Cmd_Argc()) {
    default:
    case 1:
      Con_Printf("inc <cvar> [amount] : increment cvar\n");
      break;
    case 2:
      Cvar_SetValue(Cmd_Argv(1), Cvar_VariableValue(Cmd_Argv(1)) + 1);
      break;
    case 3:
      Cvar_SetValue(
        Cmd_Argv(1),
        Cvar_VariableValue(Cmd_Argv(1)) + Q_atof(Cmd_Argv(2)),
      );
      break;
  }
}

// Cvar_Toggle_f -- johnfitz
function Cvar_Toggle_f() {
  switch (Cmd_Argc()) {
    default:
    case 1:
      Con_Printf("toggle <cvar> : toggle cvar\n");
      break;
    case 2:
      if (Cvar_VariableValue(Cmd_Argv(1)) !== 0) {
        Cvar_Set(Cmd_Argv(1), "0");
      } else {
        Cvar_Set(Cmd_Argv(1), "1");
      }
      break;
  }
}

// Cvar_HasValue
//
// Ironwail: a value that reads as a number (sscanf "%f") matches the cvar's
// value, anything else its string. Compared as floats, as C does. Unlike
// sscanf, this doesn't read inf, nan or hex as numbers; those compare as
// strings.
const CVAR_FLOAT_PREFIX = /^\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/;

function Cvar_HasValue(_var, value) {
  const m = CVAR_FLOAT_PREFIX.exec(value);
  if (m !== null) {
    return Math.fround(parseFloat(m[0])) === Math.fround(_var.value);
  }
  return value === _var.string;
}

// Cvar_Cycle_f -- johnfitz
//
// cycle and cycleback
function Cvar_Cycle_f() {
  const argc = Cmd_Argc();
  if (argc < 3) {
    Con_Printf(
      Cmd_Argv(0) +
        " <cvar> <value list>: cycle cvar through a list of values\n",
    );
    return;
  }

  const _var = Cvar_FindVar(Cmd_Argv(1));
  if (_var === null) {
    Con_Printf('Cvar "' + Cmd_Argv(1) + '" not found\n');
    return;
  }

  // loop through the args until you find one that matches the current cvar value.
  // yes, this will get stuck on a list that contains the same value twice.
  // it's not worth dealing with, and i'm not even sure it can be dealt with.
  let i;
  if (Cmd_Argv(0).toLowerCase() === "cycle") { // forward
    for (i = 2; i < argc; i++) {
      if (Cvar_HasValue(_var, Cmd_Argv(i))) {
        break;
      }
    }
    if (++i >= argc) {
      i = 2;
    }
  } else { // backward
    for (i = argc - 1; i >= 2; i--) {
      if (Cvar_HasValue(_var, Cmd_Argv(i))) {
        break;
      }
    }
    if (--i < 2) {
      i = argc - 1;
    }
  }

  Cvar_Set(_var.name, Cmd_Argv(i));
}

// Cvar_Reset_f -- johnfitz
function Cvar_Reset_f() {
  switch (Cmd_Argc()) {
    default:
    case 1:
      Con_Printf("reset <cvar> : reset cvar to default\n");
      break;
    case 2:
      Cvar_Reset(Cmd_Argv(1));
      break;
  }
}

// Cvar_ResetAll_f -- johnfitz
function Cvar_ResetAll_f() {
  for (const _var of Cvar_SortedList()) {
    Cvar_Reset(_var.name);
  }
}

// Cvar_ResetCfg_f -- QuakeSpasm
//
// Resets the archived cvars, the ones a config saves
function Cvar_ResetCfg_f() {
  for (const _var of Cvar_SortedList()) {
    if (_var.archive) {
      Cvar_Reset(_var.name);
    }
  }
}

// Cvar_Init -- johnfitz
//
// Registers the cvar commands (Ironwail; id's cvar.c has none)
export function Cvar_Init() {
  Cmd_AddCommand("cvarlist", Cvar_List_f);
  Cmd_AddCommand("toggle", Cvar_Toggle_f);
  Cmd_AddCommand("cycle", Cvar_Cycle_f);
  Cmd_AddCommand("cycleback", Cvar_Cycle_f);
  Cmd_AddCommand("inc", Cvar_Inc_f);
  Cmd_AddCommand("reset", Cvar_Reset_f);
  Cmd_AddCommand("resetall", Cvar_ResetAll_f);
  Cmd_AddCommand("resetcfg", Cvar_ResetCfg_f);
}
