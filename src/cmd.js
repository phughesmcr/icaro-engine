// Ported from: WinQuake/cmd.c -- Quake script command processing module

import {
  com_argc,
  com_argv,
  COM_Parse,
  com_token,
  Con_DPrintf,
  Con_Printf,
  MSG_WriteByte,
  SZ_Alloc,
  SZ_Clear,
  SZ_Print,
  SZ_Write,
} from "./common.js";
import {
  Cvar_Command,
  Cvar_Init,
  Cvar_VariableString,
  cvar_vars,
} from "./cvar.js";
import { COM_LoadFileAsString } from "./pak.js";
import { default_cfg } from "./default_cfg.js";
import { clc_stringcmd } from "./protocol.js";

// COMMAND BUFFER

const MAX_ALIAS_NAME = 32;
const MAX_ARGS = 80;

// Command source types
export const src_client = 0; // came in over a net connection as a clc_stringcmd
export const src_command = 1; // from the command buffer

const cmd_text = {
  allowoverflow: false,
  overflowed: false,
  data: null,
  maxsize: 0,
  cursize: 0,
};

export let cmd_alias = null; // read by the console's tab completion
let cmd_wait = false;

let cmd_argc = 0;
const cmd_argv = new Array(MAX_ARGS).fill("");
let cmd_args = null;

export let cmd_source = src_command;

// Deviation (web-only, no C equivalent): text a remote server stuffs into the
// client (svc_stufftext) is untrusted. In id's C it went straight to
// Cbuf_AddText and could run anything: bind keys, write the config, connect
// elsewhere. Cbuf_AddServerText marks each of its commands with this byte,
// Cbuf_Execute carries the mark to every ';'-separated command of the line,
// and Cmd_ExecuteString runs a marked command only if its name is in
// cmd_server_allowed. Text from the player's own local server is not marked
// and runs as in C (cl_parse.js CL_ParseStuffText decides). The byte is
// whitespace to COM_Parse, so a stray one changes no tokens.
const CMD_SERVER_MARK = 0x01;

// What a remote server may run, built from the stuffcmd calls in id's
// rerelease QuakeC (quake-rerelease-qc: quakec, quakec_hipnotic,
// quakec_rogue, quakec_ctf, quakec_mg1, quakec_mg3) and the main mods'
// sources (Arcane Dimensions, Copper, Alkaline, progs_dump, LibreQuake), and
// the text the engine's own server stuffs. No bind, alias, exec, connect or
// file-writing command is here, nor any that changes state a disconnect
// can't undo (Arcane Dimensions' gl_texturemode toggle). Any cvar a server
// changes is neither saved nor kept after disconnect (cvar.js
// Cvar_RestoreServerChanges).
// deno-fmt-ignore
const cmd_server_allowed = new Set([
  "_movevars", // sv_main.js SV_WriteMovevars, every signon (prediction)
  "reconnect", // sv_main.c SV_SendReconnect, every level change
  "bf", // quakec items.qc and every mod: bonus flash on pickup
  "-attack", // quakec client.qc PutClientInServer: no firing on respawn
  "fog", // quakec_mg1/mg3 fog.qc, Copper, Alkaline, progs_dump, AD
  "r_skyfog", // Copper, Alkaline, progs_dump fog.qc; AD globalfog.qc
  "color", // quakec_rogue and quakec_ctf teamplay.qc: team colours
  "disconnect", // quakec_rogue and quakec_ctf teamplay.qc: team-change kick
  "teamplay", // quakec_rogue motd.qc
  "v_cshift", // AD, Copper t_void.qc, Alkaline and progs_dump cshift.qc
  "sky", // AD targets.qc, Alkaline misc.qc: skybox changes
  "sizeup", // progs_dump cutscene.qc
  "sizedown", // progs_dump cutscene.qc
  "-forward", // progs_dump cutscene.qc
  "-strafe", // progs_dump cutscene.qc
]);

// Set while a command from Cbuf_AddServerText runs; cvar.js reads it
let cmd_server_text = false;

/** Web-only: whether the command running now came from a remote server */
export function Cmd_FromServer() {
  return cmd_server_text;
}

export let cmd_functions = null; // linked list of registered commands

// Callback injection for client state (to avoid circular dependency with client.js)
let _getClientState = null;

/**
 * Called from host.js after client.js is loaded to wire up client state access
 */
export function Cmd_SetClientCallbacks(callbacks) {
  _getClientState = callbacks.getClientState;
}

export function Cbuf_Init() {
  // space for commands and script files. id's 8192; QuakeSpasm/Ironwail
  // (Spike) raise it for large configs full of comments
  SZ_Alloc(cmd_text, 1 << 18);
}

/** Adds command text at the end of the buffer */
export function Cbuf_AddText(text) {
  const l = text.length;

  if (cmd_text.cursize + l >= cmd_text.maxsize) {
    Con_Printf("Cbuf_AddText: overflow\n");
    return;
  }

  for (let i = 0; i < l; i++) {
    cmd_text.data[cmd_text.cursize + i] = text.charCodeAt(i);
  }
  cmd_text.cursize += l;
}

/**
 * Web-only: adds whole lines of text from a remote server (svc_stufftext),
 * each marked so that only allowed commands run (see cmd_server_allowed).
 */
export function Cbuf_AddServerText(text) {
  let marked = "";
  // a command left without its newline would take the server's text as
  // arguments
  if (cmd_text.cursize > 0 && cmd_text.data[cmd_text.cursize - 1] !== 0x0A) {
    marked = "\n";
  }

  // Cbuf_Execute always ends a command at '\n', even inside quotes, so each
  // line starts a command
  const mark = String.fromCharCode(CMD_SERVER_MARK);
  let start = 0;
  while (start < text.length) {
    let end = text.indexOf("\n", start);
    end = end === -1 ? text.length : end + 1;
    marked += mark + text.substring(start, end);
    start = end;
  }

  Cbuf_AddText(marked);
}

/**
 * Adds command text immediately after the current command
 * Adds a \n to the text
 * FIXME: actually change the command buffer to do less copying
 */
export function Cbuf_InsertText(text) {
  // copy off any commands still remaining in the exec buffer
  let temp = null;
  const templen = cmd_text.cursize;
  if (templen) {
    temp = new Uint8Array(templen);
    temp.set(cmd_text.data.subarray(0, templen));
    SZ_Clear(cmd_text);
  }

  // add the entire text of the file. QuakeSpasm adds the \n that id's
  // comment promises, so a file whose last line has no newline doesn't run
  // into the next command.
  Cbuf_AddText(text);
  SZ_Write(cmd_text, "\n", 1);

  // add the copied off data
  if (templen) {
    SZ_Write(cmd_text, temp, templen);
  }
}

/** Web-only: true when no command text is waiting (host.js, startup configs) */
export function Cbuf_IsEmpty() {
  return cmd_text.cursize === 0;
}

export function Cbuf_Execute() {
  while (cmd_text.cursize) {
    // find a \n or ; line break
    // Ironwail: a ; after a // comment doesn't end the line. Deviation:
    // Ironwail takes any //; here it must be outside quotes and start a
    // token, where COM_Parse sees a comment, so an unquoted
    // "connect wts://host/x; cmd" still splits.
    const text = cmd_text.data;
    let quotes = 0;
    let comment = false;
    let i;
    for (i = 0; i < cmd_text.cursize; i++) {
      if (text[i] === 0x22) { // '"'
        quotes++;
      }
      if (
        !(quotes & 1) && text[i] === 0x2F && i + 1 < cmd_text.cursize &&
        text[i + 1] === 0x2F && // '//'
        (i === 0 || text[i - 1] <= 32)
      ) {
        comment = true;
      }
      if (!(quotes & 1) && !comment && text[i] === 0x3B) { // ';'
        break; // don't break if inside a quoted string
      }
      if (text[i] === 0x0A) { // '\n'
        break;
      }
    }

    // extract the line as a string
    const server = i > 0 && text[0] === CMD_SERVER_MARK;
    let line = "";
    for (let j = server ? 1 : 0; j < i; j++) {
      line += String.fromCharCode(text[j]);
    }

    // delete the text from the command buffer and move remaining commands down
    if (i === cmd_text.cursize) {
      cmd_text.cursize = 0;
    } else {
      const semicolon = text[i] === 0x3B;
      i++;
      cmd_text.cursize -= i;
      cmd_text.data.copyWithin(0, i, i + cmd_text.cursize);

      // the rest of a server's line is the server's too
      if (server && semicolon) {
        cmd_text.data.copyWithin(1, 0, cmd_text.cursize);
        cmd_text.data[0] = CMD_SERVER_MARK;
        cmd_text.cursize++;
      }
    }

    // execute the command line
    cmd_server_text = server;
    try {
      Cmd_ExecuteString(line, src_command);
    } finally {
      cmd_server_text = false;
    }

    if (cmd_wait) {
      // skip out while text still remains in buffer, leaving it
      // for next frame
      cmd_wait = false;
      break;
    }
  }
}

// COMMAND EXECUTION

export function Cmd_Init() {
  // register our commands
  Cmd_AddCommand("stuffcmds", Cmd_StuffCmds_f);
  Cmd_AddCommand("exec", Cmd_Exec_f);
  Cmd_AddCommand("echo", Cmd_Echo_f);
  Cmd_AddCommand("alias", Cmd_Alias_f);
  Cmd_AddCommand("cmd", Cmd_ForwardToServer);
  Cmd_AddCommand("wait", Cmd_Wait_f);

  // johnfitz / Ironwail
  Cmd_AddCommand("cmdlist", Cmd_List_f);
  Cmd_AddCommand("unalias", Cmd_Unalias_f);
  Cmd_AddCommand("unaliasall", Cmd_Unaliasall_f);
  Cmd_AddCommand("apropos", Cmd_Apropos_f);
  Cmd_AddCommand("find", Cmd_Apropos_f);

  // Ironwail calls Cvar_Init from Host_Init, after Cmd_Init. The room
  // server (server/game_server.js) calls Cmd_Init but not Host_Init, so the
  // cvar commands are registered here to reach both.
  Cvar_Init();
}

export function Cmd_Argc() {
  return cmd_argc;
}

export function Cmd_Argv(arg) {
  if (arg < 0 || arg >= cmd_argc) {
    return "";
  }
  return cmd_argv[arg];
}

export function Cmd_Args() {
  return cmd_args;
}

/** Parses the given string into command line tokens. */
export function Cmd_TokenizeString(text) {
  // clear the args from the last string
  cmd_argc = 0;
  cmd_args = null;

  let pos = 0;

  while (true) {
    // skip whitespace up to a \n
    while (
      pos < text.length && text.charCodeAt(pos) <= 32 &&
      text.charAt(pos) !== "\n"
    ) {
      pos++;
    }

    if (pos >= text.length || text.charAt(pos) === "\n") {
      // a newline separates commands in the buffer
      break;
    }

    if (cmd_argc === 1) {
      cmd_args = text.substring(pos);
    }

    const remaining = COM_Parse(text.substring(pos));
    if (remaining === null) return;

    pos = text.length - (remaining ? remaining.length : 0);

    if (cmd_argc < MAX_ARGS) {
      cmd_argv[cmd_argc] = com_token;
      cmd_argc++;
    }
  }
}

export function Cmd_AddCommand(cmd_name, fn) {
  // fail if the command is a variable name
  if (Cvar_VariableString(cmd_name)) {
    // Only warn if the variable string is non-empty
    const varStr = Cvar_VariableString(cmd_name);
    if (varStr.length > 0) {
      Con_Printf("Cmd_AddCommand: " + cmd_name + " already defined as a var\n");
      return;
    }
  }

  // fail if the command already exists
  let cmd = cmd_functions;
  while (cmd) {
    if (cmd.name === cmd_name) {
      Con_Printf("Cmd_AddCommand: " + cmd_name + " already defined\n");
      return;
    }

    cmd = cmd.next;
  }

  cmd = {
    name: cmd_name,
    fn: fn,
    next: cmd_functions,
  };
  cmd_functions = cmd;
}

export function Cmd_Exists(cmd_name) {
  let cmd = cmd_functions;
  while (cmd) {
    if (cmd.name === cmd_name) {
      return true;
    }
    cmd = cmd.next;
  }

  return false;
}

/**
 * Ironwail's Cmd_FindCommand (cmd.c): the command with this name, matched
 * case-insensitively, or null. id's Cmd_Exists above matches case.
 */
export function Cmd_FindCommand(cmd_name) {
  const name = cmd_name.toLowerCase();
  for (let cmd = cmd_functions; cmd !== null; cmd = cmd.next) {
    if (cmd.name.toLowerCase() === name) {
      return cmd;
    }
  }

  return null;
}

/**
 * Ironwail's Cmd_AliasExists (cmd.c): whether an alias has this name, matched
 * case-insensitively.
 */
export function Cmd_AliasExists(aliasname) {
  const name = aliasname.toLowerCase();
  for (let a = cmd_alias; a !== null; a = a.next) {
    if (a.name.toLowerCase() === name) {
      return true;
    }
  }

  return false;
}

export function Cmd_CompleteCommand(partial) {
  const len = partial.length;

  if (len === 0) {
    return null;
  }

  // check functions
  let cmd = cmd_functions;
  while (cmd) {
    if (cmd.name.substring(0, len) === partial) {
      return cmd.name;
    }
    cmd = cmd.next;
  }

  return null;
}

/**
 * A complete command line has been parsed, so try to execute it
 * FIXME: lookupnoadd the token to speed search?
 */
export function Cmd_ExecuteString(text, src) {
  cmd_source = src;
  Cmd_TokenizeString(text);

  // execute the command line
  if (Cmd_Argc() === 0) {
    return; // no tokens
  }

  // web-only: a remote server runs only the allowed commands, never an alias
  if (
    cmd_server_text === true &&
    cmd_server_allowed.has(cmd_argv[0].toLowerCase()) === false
  ) {
    Con_DPrintf("Server tried to %s\n", text);
    return;
  }

  // check functions
  let cmd = cmd_functions;
  while (cmd) {
    if (cmd_argv[0].toLowerCase() === cmd.name.toLowerCase()) {
      cmd.fn();
      return;
    }

    cmd = cmd.next;
  }

  // QuakeSpasm (cmd.c Cmd_ExecuteString): a client's command never runs an
  // alias or sets a cvar. id's C does both, so a guest whose line passed
  // SV_ClientCommandAllowed's prefix check ("say..." or "ban", which is no
  // command) could run the host's alias with the host's powers.
  if (src === src_client) {
    Con_DPrintf("Client tried to %s\n", text);
    return;
  }

  // check alias
  let a = cmd_server_text === true ? null : cmd_alias;
  while (a) {
    if (cmd_argv[0].toLowerCase() === a.name.toLowerCase()) {
      Cbuf_InsertText(a.value);
      return;
    }

    a = a.next;
  }

  // check cvars
  if (!Cvar_Command()) {
    Con_Printf('Unknown command "' + Cmd_Argv(0) + '"\n');
  }
}

/**
 * Causes execution of the remainder of the command buffer to be delayed until
 * next frame.
 */
function Cmd_Wait_f() {
  cmd_wait = true;
}

/** Executes a script file from the game data */
function Cmd_Exec_f() {
  if (Cmd_Argc() !== 2) {
    Con_Printf("exec <filename> : execute a script file\n");
    return;
  }

  let f = COM_LoadFileAsString(Cmd_Argv(1));
  // Ironwail: the 2021 re-release's id1/pak0.pak has no default.cfg, so run
  // the embedded QuakeSpasm one instead (default_cfg.js)
  if (f === null && Cmd_Argv(1) === "default.cfg") {
    f = default_cfg;
  }
  if (f === null) {
    Con_Printf("couldn't exec " + Cmd_Argv(1) + "\n");
    return;
  }

  Con_Printf("execing " + Cmd_Argv(1) + "\n");

  Cbuf_InsertText(f);
}

/** Just prints the rest of the line to the console */
function Cmd_Echo_f() {
  for (let i = 1; i < Cmd_Argc(); i++) {
    Con_Printf(Cmd_Argv(i) + " ");
  }
  Con_Printf("\n");
}

/**
 * Creates a new command that executes a command string (possibly ; separated)
 */
function Cmd_Alias_f() {
  if (Cmd_Argc() === 1) {
    Con_Printf("Current alias commands:\n");
    let a = cmd_alias;
    while (a) {
      Con_Printf(a.name + " : " + a.value + "\n");
      a = a.next;
    }

    return;
  }

  // johnfitz: "alias name" prints that alias, in Ironwail's format. id's
  // C would set it to an empty string.
  if (Cmd_Argc() === 2) {
    for (let a = cmd_alias; a !== null; a = a.next) {
      if (Cmd_Argv(1) === a.name) {
        Con_Printf("   " + a.name + ": " + a.value);
      }
    }
    return;
  }

  const s = Cmd_Argv(1);
  if (s.length >= MAX_ALIAS_NAME) {
    Con_Printf("Alias name is too long\n");
    return;
  }

  // if the alias already exists, reuse it
  let a = cmd_alias;
  while (a) {
    if (s === a.name) {
      break;
    }
    a = a.next;
  }

  if (!a) {
    a = { name: "", value: "", next: cmd_alias };
    cmd_alias = a;
  }

  a.name = s;

  // copy the rest of the command line
  let cmd = "";
  const c = Cmd_Argc();
  for (let i = 2; i < c; i++) {
    cmd += Cmd_Argv(i);
    if (i !== c) {
      cmd += " ";
    }
  }

  cmd += "\n";

  a.value = cmd;
}

// Cmd_Unalias_f -- johnfitz
function Cmd_Unalias_f() {
  switch (Cmd_Argc()) {
    default:
    case 1:
      Con_Printf("unalias <name> : delete alias\n");
      break;
    case 2: {
      let prev = null;
      for (let a = cmd_alias; a !== null; a = a.next) {
        if (Cmd_Argv(1) === a.name) {
          if (prev !== null) {
            prev.next = a.next;
          } else {
            cmd_alias = a.next;
          }
          return;
        }

        prev = a;
      }

      Con_Printf("No alias named " + Cmd_Argv(1) + "\n");
      break;
    }
  }
}

// Cmd_Unaliasall_f -- johnfitz
function Cmd_Unaliasall_f() {
  cmd_alias = null;
}

// Cmd_List_f -- johnfitz
//
// Ironwail's cmd_functions is kept sorted; this port's is not, so the names
// are sorted here.
function Cmd_List_f() {
  const partial = Cmd_Argc() > 1 ? Cmd_Argv(1) : null;

  const names = [];
  for (let cmd = cmd_functions; cmd !== null; cmd = cmd.next) {
    if (partial === null || cmd.name.startsWith(partial)) {
      names.push(cmd.name);
    }
  }
  names.sort();

  for (const name of names) {
    Con_Printf("   " + name + "\n");
  }

  Con_Printf(
    names.length + " commands" +
      (partial !== null ? ' beginning with "' + partial + '"' : "") + "\n",
  );
}

// Cmd_ListAllContaining -- Ironwail
//
// Lists the commands and cvars whose names contain substr, ignoring case
function Cmd_ListAllContaining(substr) {
  const needle = substr.toLowerCase();
  let hits = 0;

  const names = [];
  for (let cmd = cmd_functions; cmd !== null; cmd = cmd.next) {
    if (cmd.name.toLowerCase().includes(needle)) {
      names.push(cmd.name);
    }
  }
  names.sort();
  for (const name of names) {
    hits++;
    Con_Printf("   " + name + "\n");
  }

  const vars = [];
  for (let v = cvar_vars; v !== null; v = v.next) {
    if (v.name.toLowerCase().includes(needle)) {
      vars.push(v);
    }
  }
  vars.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const v of vars) {
    hits++;
    Con_Printf("   " + v.name + ' (current value: "' + v.string + '")\n');
  }

  const plural = hits === 1 ? "" : "s";
  if (hits === 0) {
    Con_Printf("no cvars/commands contain '" + substr + "'\n");
  } else {
    Con_Printf(
      hits + " cvar" + plural + "/command" + plural + " containing '" + substr +
        "'\n",
    );
  }
}

// Cmd_Apropos_f -- Ironwail
//
// apropos and find
function Cmd_Apropos_f() {
  const substr = Cmd_Argv(1);
  if (substr === "") {
    Con_Printf(
      Cmd_Argv(0) +
        " <substring> : search through commands and cvars for the given substring\n",
    );
    return;
  }

  Cmd_ListAllContaining(substr);
}

/**
 * Adds command line parameters as script statements
 * Commands lead with a +, and continue until a - or another +
 */
function Cmd_StuffCmds_f() {
  if (Cmd_Argc() !== 1) {
    Con_Printf("stuffcmds : execute command line parameters\n");
    return;
  }

  // build the combined string to parse from
  let s = 0;
  for (let i = 1; i < com_argc; i++) {
    if (com_argv[i] == null) {
      continue; // NEXTSTEP nulls out -NXHost
    }
    s += com_argv[i].length + 1;
  }

  if (s === 0) {
    return;
  }

  let text = "";
  for (let i = 1; i < com_argc; i++) {
    if (com_argv[i] == null) {
      continue; // NEXTSTEP nulls out -NXHost
    }
    text += com_argv[i];
    if (i !== com_argc - 1) {
      text += " ";
    }
  }

  // pull out the commands
  let build = "";

  for (let i = 0; i < text.length - 1; i++) {
    if (text.charAt(i) === "+") {
      i++;

      let j = i;
      while (
        j < text.length && text.charAt(j) !== "+" && text.charAt(j) !== "-"
      ) {
        j++;
      }

      build += text.substring(i, j);
      build += "\n";
      i = j - 1;
    }
  }

  if (build.length > 0) {
    Cbuf_InsertText(build);
  }
}

/**
 * Returns the position (1 to argc-1) in the command's argument list
 * where the given parameter appears, or 0 if not present
 */
export function Cmd_CheckParm(parm) {
  if (parm == null) {
    Con_Printf("Cmd_CheckParm: NULL\n");
    return 0;
  }

  for (let i = 1; i < Cmd_Argc(); i++) {
    if (Cmd_Argv(i).toLowerCase() === parm.toLowerCase()) {
      return i;
    }
  }

  return 0;
}

/** Sends the entire command line over to the server */
export function Cmd_ForwardToServer() {
  // Get client state through callback (avoids circular dependency)
  if (_getClientState == null) {
    Con_Printf("Cmd_ForwardToServer: client not initialized\n");
    return;
  }

  const clientState = _getClientState();
  const cls = clientState.cls;
  const ca_connected = clientState.ca_connected;

  if (cls.state !== ca_connected) {
    Con_Printf("Can't \"" + Cmd_Argv(0) + '", not connected\n');
    return;
  }

  if (cls.demoplayback) {
    return; // not really connected
  }

  MSG_WriteByte(cls.message, clc_stringcmd);

  // If the command isn't "cmd", write the command name
  if (Cmd_Argv(0).toLowerCase() !== "cmd") {
    SZ_Print(cls.message, Cmd_Argv(0));
    SZ_Print(cls.message, " ");
  }

  // Write the arguments or just a newline
  if (Cmd_Argc() > 1) {
    SZ_Print(cls.message, Cmd_Args());
  } else {
    SZ_Print(cls.message, "\n");
  }
}
