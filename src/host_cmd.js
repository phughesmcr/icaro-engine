// Ported from: WinQuake/host_cmd.c

import { Sys_FloatTime, Sys_Printf } from "./sys.js";
import {
  COM_Parse,
  COM_StripExtension,
  com_token,
  Con_DPrintf,
  Con_Printf,
  hipnotic,
  MSG_WriteAngle,
  MSG_WriteByte,
  MSG_WriteFloat,
  MSG_WriteLong,
  MSG_WriteShort,
  MSG_WriteString,
  rogue,
  SZ_Clear,
} from "./common.js";
import {
  svc_lightstyle,
  svc_setangle,
  svc_setpause,
  svc_signonnum,
  svc_time,
  svc_updatecolors,
  svc_updatefrags,
  svc_updatename,
  svc_updatestat,
} from "./protocol.js";
import { Q_atof } from "./common.js";
import {
  HIT_LASER_CANNON,
  HIT_MJOLNIR,
  HIT_PROXIMITY_GUN,
  IT_ARMOR1,
  IT_ARMOR2,
  IT_ARMOR3,
  IT_GRENADE_LAUNCHER,
  IT_LIGHTNING,
  IT_NAILGUN,
  IT_ROCKET_LAUNCHER,
  IT_SHOTGUN,
  IT_SUPER_NAILGUN,
  IT_SUPER_SHOTGUN,
  MAX_LIGHTSTYLES,
  RIT_LAVA_NAILGUN,
  RIT_LAVA_SUPER_NAILGUN,
  RIT_MULTI_GRENADE,
  RIT_MULTI_ROCKET,
  RIT_PLASMA_GUN,
  SAVEGAME_COMMENT_LENGTH,
  STAT_MONSTERS,
  STAT_SECRETS,
  STAT_TOTALMONSTERS,
  STAT_TOTALSECRETS,
  VERSION,
} from "./quakedef.js";
import {
  EDICT_NUM,
  EDICT_TO_PROG,
  NUM_FOR_EDICT,
  PR_GetString,
  pr_global_struct,
} from "./progs.js";
import { PR_ExecuteProgram } from "./pr_exec.js";
import {
  ED_NewString,
  ED_ParseEdict,
  ED_ParseGlobals,
  ED_Write,
  ED_WriteGlobals,
  GetEdictFieldValue,
  nomonsters,
} from "./pr_edict.js";
import { sv_player } from "./sv_phys.js";
import {
  FL_GODMODE,
  FL_NOTARGET,
  MOVETYPE_FLY,
  MOVETYPE_NOCLIP,
  MOVETYPE_WALK,
} from "./sv_phys.js";
import {
  Cvar_FindVar,
  Cvar_RegisterVariable,
  Cvar_Set,
  Cvar_SetValue,
  cvar_t,
  Cvar_VariableString,
  Cvar_VariableValue,
} from "./cvar.js";
import { net_activeconnections, net_time } from "./net.js";
import {
  Cbuf_AddText,
  Cmd_AddCommand,
  Cmd_Argc,
  Cmd_Args,
  Cmd_Argv,
  Cmd_ExecuteString,
  Cmd_ForwardToServer,
  cmd_source,
  src_command,
} from "./cmd.js";
import {
  current_skill,
  SV_DropClient,
  SV_SaveSpawnparms,
  SV_SpawnServer,
  SV_WriteClientdataToMessage,
} from "./sv_main.js";
import {
  host_client,
  NUM_PING_TIMES,
  NUM_SPAWN_PARMS,
  PRESPAWN_FLUSH,
  PRESPAWN_SIGNONBUFS,
  set_host_client,
  sv,
  svs,
} from "./server.js";
import {
  ca_connected,
  ca_dedicated,
  cl,
  cls,
  MAX_DEMOS,
  SIGNONS,
} from "./client.js";
import { key_game, Key_ModalActive, MAXCMDLINE, set_key_dest } from "./keys.js";
import {
  cl_color,
  CL_Disconnect,
  CL_EstablishConnection,
  cl_name,
  CL_NextDemo,
} from "./cl_main.js";
import { CL_StopPlayback } from "./cl_demo.js";
import { SCR_BeginLoadingPlaque, SCR_ModalMessage } from "./gl_screen.js";
import {
  Autosave_Consume,
  Autosave_OfferDecision,
  Autosave_ReadMeta,
  AUTOSAVE_SLOT,
  Autosave_WriteMeta,
} from "./autosave.js";
import { hostname } from "./net_main.js";
import { SV_LinkEdict } from "./world.js";
import {
  Host_Error,
  Host_Shutdown,
  Host_ShutdownServer,
  SV_BroadcastPrintf,
  SV_ClientPrintf,
} from "./host.js";
import { Loop_IsServerSocket } from "./net_loop.js";
import { COM_EnsureFile, COM_FindFile } from "./pak.js";
import {
  mod_alias,
  Mod_Extradata,
  Mod_ForName,
  Mod_Print,
} from "./gl_model.js";

export let noclip_anglehack = false;

export function set_noclip_anglehack(v) {
  noclip_anglehack = v;
}

// Host_InitCommands

// Web-only cvar (no Quake equivalent): save the game when the page is hidden
// (Host_AutoSave). 0 turns it off.
const web_autosave = new cvar_t("web_autosave", "1", true);

// Deliberate deviation from host_cmd.c, which trusts every client: it gates
// god, notarget, fly, noclip, give and kick on deathmatch alone, and pause not
// at all, because NetQuake assumed a LAN of friends. Anyone with an Icaro
// room's link can join it, so a guest (Host_ClientIsGuest) can't kick or
// pause, and gets the cheats only when the server sets sv_guestcheats 1. The
// player at this machine (single-player, a room's host, the agent's headless
// host) keeps id's powers. Not saved: every server starts with guests barred.
const sv_guestcheats = new cvar_t("sv_guestcheats", "0");

/**
 * Whether client joined over a network driver and isn't privileged: anyone
 * but the player on this machine's loopback connection (net_loop.js).
 */
export function Host_ClientIsGuest(client) {
  return client.privileged === false &&
    Loop_IsServerSocket(client.netconnection) === false;
}

/** The cheat commands' check: host_cmd.c's, then Icaro's guest rule. */
function Host_CheatAllowed() {
  if (pr_global_struct.deathmatch !== 0 && host_client.privileged === false) {
    return false; // id's C refuses silently
  }

  if (sv_guestcheats.value === 0 && Host_ClientIsGuest(host_client)) {
    SV_ClientPrintf("Cheats are for the host only.\n");
    return false;
  }

  return true;
}

// QuakeWorld's chat flood protection (QW/server/sv_ccmds.c): more than
// fp_messages lines in fp_persecond seconds silences the client for
// fp_secondsdead seconds. NetQuake has none. Icaro applies it to guests only.
// QW times it with realtime; net_time is the same clock, and NET_GetMessage
// refreshes it just before the client's command runs.
let fp_messages = 4;
let fp_persecond = 4;
let fp_secondsdead = 10;
let fp_msg = "";

/** sv.paused starts false and pause toggles it to a number (sv.paused ^ 1). */
function Host_ServerPaused() {
  return sv.paused !== false && sv.paused !== 0;
}

/** QW/server/sv_ccmds.c SV_Floodprot_f. */
function Host_Floodprot_f() {
  if (Cmd_Argc() === 1) {
    if (fp_messages !== 0) {
      Con_Printf(
        "Current floodprot settings: \nAfter %d msgs per %d seconds, silence for %d seconds\n",
        fp_messages,
        fp_persecond,
        fp_secondsdead,
      );
      return;
    }
    Con_Printf("No floodprots enabled.\n");
  }

  if (Cmd_Argc() !== 4) {
    Con_Printf(
      "Usage: floodprot <# of messages> <per # of seconds> <seconds to silence>\n",
    );
    Con_Printf(
      "Use floodprotmsg to set a custom message to say to the flooder.\n",
    );
    return;
  }

  const arg1 = parseInt(Cmd_Argv(1)) || 0; // atoi
  const arg2 = parseInt(Cmd_Argv(2)) || 0;
  const arg3 = parseInt(Cmd_Argv(3)) || 0;

  if (arg1 <= 0 || arg2 <= 0 || arg3 <= 0) {
    Con_Printf("All values must be positive numbers\n");
    return;
  }

  if (arg1 > 10) {
    Con_Printf("Can only track up to 10 messages.\n");
    return;
  }

  fp_messages = arg1;
  fp_persecond = arg2;
  fp_secondsdead = arg3;
}

/** QW/server/sv_ccmds.c SV_Floodprotmsg_f. */
function Host_Floodprotmsg_f() {
  if (Cmd_Argc() === 1) {
    Con_Printf("Current msg: %s\n", fp_msg);
    return;
  } else if (Cmd_Argc() !== 2) {
    Con_Printf('Usage: floodprotmsg "<message>"\n');
    return;
  }
  fp_msg = Cmd_Argv(1);
}

/**
 * QW/server/sv_user.c SV_Say's flood check: true (and the client is told) when
 * client may not send this chat line. Records the line otherwise.
 */
export function Host_ChatFlooded(client) {
  if (fp_messages === 0 || Host_ClientIsGuest(client) === false) {
    return false;
  }

  if (Host_ServerPaused() === false && net_time < client.lockedtill) {
    // host.js SV_ClientPrintf formats only %s
    const left = (client.lockedtill - net_time) | 0;
    SV_ClientPrintf("You can't talk for %s more seconds\n", String(left));
    return true;
  }

  let tmp = client.whensaidhead - fp_messages + 1;
  if (tmp < 0) tmp = 10 + tmp;
  if (
    Host_ServerPaused() === false && client.whensaid[tmp] !== 0 &&
    net_time - client.whensaid[tmp] < fp_persecond
  ) {
    client.lockedtill = net_time + fp_secondsdead;
    if (fp_msg !== "") {
      SV_ClientPrintf("FloodProt: %s\n", fp_msg);
    } else {
      SV_ClientPrintf(
        "FloodProt: You can't talk for %s seconds.\n",
        String(fp_secondsdead),
      );
    }
    return true;
  }

  client.whensaidhead++;
  if (client.whensaidhead > 9) client.whensaidhead = 0;
  client.whensaid[client.whensaidhead] = net_time;
  return false;
}

/**
 * QW/server/sv_main.c SV_ExtractFromUserinfo's name spam check: true when
 * client may not change its name now. Deviation: QW kicks the client for a
 * seventh change within five seconds of the first; Icaro refuses the change.
 * Guests only, as with chat.
 */
export function Host_NameFlooded(client) {
  if (Host_ServerPaused() || Host_ClientIsGuest(client) === false) return false;

  if (client.lastnametime === 0 || net_time - client.lastnametime > 5) {
    client.lastnamecount = 0;
    client.lastnametime = net_time;
  } else if (client.lastnamecount++ > 4) {
    SV_ClientPrintf("You can't change your name that often.\n");
    return true;
  }

  return false;
}

export function Host_InitCommands() {
  if (Cvar_FindVar(web_autosave.name) === null) {
    Cvar_RegisterVariable(web_autosave);
  }
  if (Cvar_FindVar(sv_guestcheats.name) === null) {
    Cvar_RegisterVariable(sv_guestcheats);
  }
  Cmd_AddCommand("floodprot", Host_Floodprot_f);
  Cmd_AddCommand("floodprotmsg", Host_Floodprotmsg_f);

  Cmd_AddCommand("status", Host_Status_f);
  Cmd_AddCommand("quit", Host_Quit_f);
  Cmd_AddCommand("map", Host_Map_f);
  Cmd_AddCommand("changelevel", Host_Changelevel_f);
  Cmd_AddCommand("restart", Host_Restart_f);
  Cmd_AddCommand("reconnect", Host_Reconnect_f);
  Cmd_AddCommand("connect", Host_Connect_f);
  Cmd_AddCommand("name", Host_Name_f);
  Cmd_AddCommand("pause", Host_Pause_f);
  Cmd_AddCommand("say", Host_Say_f);
  Cmd_AddCommand("say_team", Host_Say_Team_f);
  Cmd_AddCommand("tell", Host_Tell_f);
  Cmd_AddCommand("color", Host_Color_f);
  Cmd_AddCommand("kill", Host_Kill_f);
  Cmd_AddCommand("god", Host_God_f);
  Cmd_AddCommand("notarget", Host_Notarget_f);
  Cmd_AddCommand("fly", Host_Fly_f);
  Cmd_AddCommand("noclip", Host_Noclip_f);
  Cmd_AddCommand("version", Host_Version_f);
  Cmd_AddCommand("give", Host_Give_f);
  Cmd_AddCommand("ping", Host_Ping_f);
  Cmd_AddCommand("kick", Host_Kick_f);
  Cmd_AddCommand("save", Host_Savegame_f);
  Cmd_AddCommand("load", Host_Loadgame_f);
  Cmd_AddCommand("savegame", Host_Savegame_f);
  Cmd_AddCommand("loadgame", Host_Loadgame_f);
  Cmd_AddCommand("startdemos", Host_Startdemos_f);
  Cmd_AddCommand("demos", Host_Demos_f);
  Cmd_AddCommand("stopdemo", Host_Stopdemo_f);

  Cmd_AddCommand("viewmodel", Host_Viewmodel_f);
  Cmd_AddCommand("viewframe", Host_Viewframe_f);
  Cmd_AddCommand("viewnext", Host_Viewnext_f);
  Cmd_AddCommand("viewprev", Host_Viewprev_f);

  Cmd_AddCommand("mcache", Mod_Print);
  Cmd_AddCommand("spawn", Host_Spawn_f);
  Cmd_AddCommand("begin", Host_Begin_f);
  Cmd_AddCommand("prespawn", Host_PreSpawn_f);

  Cmd_AddCommand("vibrate", Host_Vibrate_f); // 2021 re-release
}

function Host_Status_f() {
  let print;

  if (cmd_source === src_command) {
    if (!sv.active) {
      Cmd_ForwardToServer();
      return;
    }

    print = Host_Status_ConPrint;
  } else {
    print = Host_Status_ClientPrint;
  }

  print("host:    " + Cvar_VariableString("hostname") + "\n");
  print("version: " + VERSION.toFixed(2) + "\n");
  // C prints the tcp/ip and ipx addresses here; this port has neither
  print("map:     " + sv.name + "\n");
  print(
    "players: " + net_activeconnections + " active (" + svs.maxclients +
      " max)\n\n",
  );

  for (let j = 0; j < svs.maxclients; j++) {
    const client = svs.clients[j];
    if (!client.active) {
      continue;
    }

    let seconds = (net_time - client.netconnection.connecttime) | 0;
    let minutes = (seconds / 60) | 0;
    let hours;
    if (minutes) {
      seconds -= minutes * 60;
      hours = (minutes / 60) | 0;
      if (hours) {
        minutes -= hours * 60;
      }
    } else {
      hours = 0;
    }

    // "#%-2u %-16.16s  %3i  %2i:%02i:%02i\n"
    print(
      "#" + String(j + 1).padEnd(2, " ") +
        " " + client.name.substring(0, 16).padEnd(16, " ") +
        "  " + String(client.edict.v.frags | 0).padStart(3, " ") +
        "  " + String(hours).padStart(2, " ") +
        ":" + String(minutes).padStart(2, "0") +
        ":" + String(seconds).padStart(2, "0") + "\n",
    );
    print("   " + client.netconnection.address + "\n");
  }
}

function Host_Status_ConPrint(s) {
  Con_Printf("%s", s);
}

function Host_Status_ClientPrint(s) {
  SV_ClientPrintf("%s", s);
}

function Host_Quit_f() {
  Host_Shutdown();
}

/**
 * Ironwail's cl.mapname (the world model's name without "maps/" and ".bsp"),
 * which this port's client_state_t doesn't keep
 */
function Host_ClientMapName() {
  if (cl.worldmodel === null || cl.worldmodel === undefined) {
    return "";
  }

  let name = cl.worldmodel.name;
  if (name.startsWith("maps/")) {
    name = name.substring(5);
  }
  return COM_StripExtension(name);
}

function Host_Map_f() {
  // Ironwail: with no map name, say what is running instead of starting a
  // server for an empty name
  if (Cmd_Argc() < 2) {
    if (cls.state === ca_dedicated) {
      if (sv.active) {
        Con_Printf("Current map: %s\n", sv.name);
      } else {
        Con_Printf("Server not active\n");
      }
    } else if (cls.state === ca_connected) {
      Con_Printf(
        "Current map: %s ( %s )\n",
        cl.levelname,
        Host_ClientMapName(),
      );
    } else {
      Con_Printf("map <levelname>: start a new server\n");
    }

    return;
  }

  if (cmd_source !== src_command) {
    return;
  }

  let name = Cmd_Argv(1);
  // remove (any) trailing ".bsp" from mapname -- S.A. (QuakeSpasm/Ironwail)
  const bsp = name.indexOf(".bsp");
  if (bsp !== -1 && bsp + 4 === name.length) {
    name = name.substring(0, bsp);
  }

  const filename = "maps/" + name + ".bsp";

  // If the map file isn't loaded yet, fetch it on demand
  if (COM_FindFile(filename) === null) {
    Con_Printf("Fetching %s...\n", filename);
    COM_EnsureFile(filename).then((success) => {
      if (success) {
        // Re-issue the map command now that the file is cached
        Cbuf_AddText("map " + name + "\n");
      } else {
        Con_Printf("Couldn't find map: %s\n", name);
      }
    });
    return;
  }

  cls.demonum = -1; // stop demo loop in case this fails

  Autosave_Consume(); // web-only: a new game replaces the autosave's game (autosave.js)

  CL_Disconnect();
  Host_ShutdownServer(false);

  set_key_dest(key_game); // remove console or menu
  SCR_BeginLoadingPlaque();

  cls.mapstring = "";
  for (let i = 0; i < Cmd_Argc(); i++) {
    cls.mapstring += Cmd_Argv(i) + " ";
  }

  cls.mapstring += "\n";

  svs.serverflags = 0; // haven't completed an episode yet

  SV_SpawnServer(name);

  if (!sv.active) {
    return;
  }

  if (cls.state !== ca_dedicated) {
    cls.spawnparms = "";

    for (let i = 2; i < Cmd_Argc(); i++) {
      cls.spawnparms += Cmd_Argv(i) + " ";
    }

    Cmd_ExecuteString("connect local", src_command);
  }
}

function Host_Changelevel_f() {
  if (Cmd_Argc() !== 2) {
    Con_Printf("changelevel <levelname> : continue game on a new level\n");
    return;
  }

  if (!sv.active || cls.demoplayback) {
    Con_Printf("Only the server may changelevel\n");
    return;
  }

  const level = Cmd_Argv(1);
  const filename = "maps/" + level + ".bsp";

  // If the map file isn't loaded yet, fetch it on demand
  if (COM_FindFile(filename) === null) {
    Con_Printf("Fetching %s...\n", filename);
    COM_EnsureFile(filename).then((success) => {
      if (success) {
        Cbuf_AddText("changelevel " + level + "\n");
      } else {
        Con_Printf("Couldn't find map: %s\n", level);
      }
    });
    return;
  }

  SV_SaveSpawnparms();
  SV_SpawnServer(level);
  // Note: SV_SpawnServer handles client reconnection internally via SV_SendReconnect
  // which calls Host_Reconnect_f to reset cls.signon. We do NOT call CL_EstablishConnection
  // here because the client is already connected - it just needs new signon messages.
}

/** Restarts the current server for a dead player */
function Host_Restart_f() {
  if (cls.demoplayback || !sv.active) {
    return;
  }

  if (cmd_source !== src_command) {
    return;
  }

  // must copy out, because it gets cleared in SV_SpawnServer.
  // SV_SpawnServer keeps the clients connected, so each client's
  // spawn_parms (the inventory it entered the level with) survive.
  const mapname = sv.name;
  SV_SpawnServer(mapname);
}

function Host_Reconnect_f() {
  if (cls.demoplayback) { // cross-map demo playback fix from Baker (QuakeSpasm/Ironwail)
    return;
  }

  SCR_BeginLoadingPlaque();
  cls.signon = 0; // need new connection messages
}

function Host_Connect_f() {
  cls.demonum = -1; // stop demo loop in case this fails
  if (cls.demoplayback) {
    CL_StopPlayback();
    CL_Disconnect();
  }

  // Use Cmd_Argv(1) to get the server address
  // When quoted (e.g., connect "wts://host:port"), Cmd_Argv(1) properly returns the unquoted URL
  // Cmd_Args() would include the quotes which breaks URL parsing
  const name = Cmd_Argv(1);
  if (!name || name.length === 0) {
    Con_Printf("usage: connect <server>\n");
    return;
  }

  Con_Printf("Connecting to %s...\n", name);

  // CL_EstablishConnection is async (WebTransport handshake)
  // Use .then() to call Host_Reconnect_f when connection succeeds
  CL_EstablishConnection(name).then(() => {
    Host_Reconnect_f();
  }).catch((e) => {
    Con_Printf("connect: %s\n", e.message);
  });
}

function Host_Name_f() {
  let newName;

  if (Cmd_Argc() === 1) {
    Con_Printf('"name" is "%s"\n', cl_name.string);
    return;
  }

  if (Cmd_Argc() === 2) {
    newName = Cmd_Argv(1);
  } else {
    newName = Cmd_Args();
  }

  // Sanitize name: only printable ASCII, max 15 chars
  newName = newName.replace(/[^\x20-\x7E]/g, ""); // Remove non-printable chars
  if (newName.length > 15) {
    newName = newName.substring(0, 15);
  }
  if (newName.length === 0) {
    newName = "player"; // Fallback for empty names
  }

  if (cmd_source === src_command) {
    // Client-side: update cvar and forward to server
    if (cl_name.string === newName) {
      return;
    }

    Cvar_Set("_cl_name", newName);

    if (cls.state === ca_connected) {
      Cmd_ForwardToServer();
    }

    return;
  }

  // Server-side: update the client's name (only if changed)
  if (host_client.name === newName) {
    return; // No change, skip update
  }

  if (Host_NameFlooded(host_client)) return;

  if (host_client.name !== "" && host_client.name !== "unconnected") {
    Con_Printf("%s renamed to %s\n", host_client.name, newName);
  }

  host_client.name = newName;

  // Set the netname on the edict
  if (host_client.edict != null) {
    host_client.edict.v.netname = ED_NewString(newName);
  }

  // Send notification to all clients
  MSG_WriteByte(sv.reliable_datagram, svc_updatename);
  MSG_WriteByte(sv.reliable_datagram, svs.clients.indexOf(host_client));
  MSG_WriteString(sv.reliable_datagram, host_client.name);
}

function Host_Pause_f() {
  // ericw -- demo pause support (QuakeSpasm, inspired by MarkV)
  if (cls.demoplayback) {
    cls.demopaused = cls.demopaused !== true;
    cl.paused = cls.demopaused;
    return;
  }

  if (cmd_source === src_command) {
    Cmd_ForwardToServer();
    return;
  }

  // Icaro: a guest can't pause (see sv_guestcheats above); id's C lets anyone
  if (Host_ClientIsGuest(host_client)) {
    SV_ClientPrintf("Only the host can pause.\n");
    return;
  }

  if (Cvar_VariableValue("pausable") === 0) {
    SV_ClientPrintf("Pause not allowed.\n");
  } else {
    sv.paused = sv.paused ^ 1;

    if (sv.paused) {
      SV_BroadcastPrintf(
        "%s paused the game\n",
        PR_GetString(sv_player.v.netname),
      );
    } else {
      SV_BroadcastPrintf(
        "%s unpaused the game\n",
        PR_GetString(sv_player.v.netname),
      );
    }

    // send notification to all clients
    MSG_WriteByte(sv.reliable_datagram, svc_setpause);
    MSG_WriteByte(sv.reliable_datagram, sv.paused);
  }
}

/**
 * The check-length-and-truncate step of Ironwail's Host_Say and Host_Tell_f.
 * id's C cuts the line to fit a 64-byte buffer (about 46 characters of
 * message); Ironwail's buffer is MAXCMDLINE. Without truncation it drops
 * trailing CRs and LFs, and the closing quote only if the message began with
 * one (id's C drops the last character whether or not it is a quote).
 */
export function Host_ChatLine(text, quoted) {
  if (text.length >= MAXCMDLINE - 1) {
    return text.substring(0, MAXCMDLINE - 2) + "\n";
  }

  let j = text.length;
  while (j > 0) {
    const c = text.charAt(j - 1);
    if (c !== "\r" && c !== "\n" && (c !== '"' || quoted === false)) {
      break;
    }
    if (c === '"') {
      quoted = false;
    }
    j--;
  }

  return text.substring(0, j) + "\n";
}

function Host_Say(teamonly) {
  let fromServer = false;

  if (cmd_source === src_command) {
    if (cls.state === ca_dedicated) {
      fromServer = true;
      teamonly = false;
    } else {
      Cmd_ForwardToServer();
      return;
    }
  }

  if (Cmd_Argc() < 2) return;

  if (fromServer === false && Host_ChatFlooded(host_client)) return;

  const save = host_client;

  let p = Cmd_Args();

  // remove quotes if present
  let quoted = false;
  if (p.charAt(0) === '"') {
    p = p.substring(1);
    quoted = true;
  }

  // turn on color set 1
  let text;
  if (fromServer === false) {
    text = "\x01" + save.name + ": " + p;
  } else {
    text = "\x01<" + hostname.string + "> " + p;
  }

  text = Host_ChatLine(text, quoted);

  const teamplayValue = Cvar_VariableValue("teamplay");

  for (let j = 0; j < svs.maxclients; j++) {
    const client = svs.clients[j];
    if (client == null || client.active === false || client.spawned === false) {
      continue;
    }
    if (
      teamplayValue !== 0 && teamonly &&
      client.edict.v.team !== save.edict.v.team
    ) continue;
    set_host_client(client);
    SV_ClientPrintf("%s", text);
  }

  set_host_client(save);

  Sys_Printf("%s", text.substring(1));
}

function Host_Say_f() {
  Host_Say(false);
}

function Host_Say_Team_f() {
  Host_Say(true);
}

function Host_Tell_f() {
  if (cmd_source === src_command) {
    Cmd_ForwardToServer();
    return;
  }

  if (Cmd_Argc() < 3) return;

  // Icaro: tell shares say's flood protection (QW has no tell)
  if (Host_ChatFlooded(host_client)) return;

  let p = Cmd_Args();

  // remove quotes if present
  let quoted = false;
  if (p.charAt(0) === '"') {
    p = p.substring(1);
    quoted = true;
  }

  const text = Host_ChatLine(host_client.name + ": " + p, quoted);

  const save = host_client;

  for (let j = 0; j < svs.maxclients; j++) {
    const client = svs.clients[j];
    if (client == null || client.active === false || client.spawned === false) {
      continue;
    }
    if (client.name.toLowerCase() !== Cmd_Argv(1).toLowerCase()) continue;
    set_host_client(client);
    SV_ClientPrintf("%s", text);
    break;
  }

  set_host_client(save);
}

function Host_Color_f() {
  if (Cmd_Argc() === 1) {
    Con_Printf(
      '"color" is "' + ((cl_color.value | 0) >> 4) + " " +
        ((cl_color.value | 0) & 0x0f) + '"\n',
    );
    Con_Printf("color <0-13> [0-13]\n");
    return;
  }

  let top, bottom;

  if (Cmd_Argc() === 2) {
    top = bottom = parseInt(Cmd_Argv(1)) || 0;
  } else {
    top = parseInt(Cmd_Argv(1)) || 0;
    bottom = parseInt(Cmd_Argv(2)) || 0;
  }

  top &= 15;
  if (top > 13) top = 13;
  bottom &= 15;
  if (bottom > 13) bottom = 13;

  const playercolor = top * 16 + bottom;

  if (cmd_source === src_command) {
    Cvar_SetValue("_cl_color", playercolor);
    if (cls.state === ca_connected) {
      Cmd_ForwardToServer();
    }

    return;
  }

  host_client.colors = playercolor;
  host_client.edict.v.team = bottom + 1;

  // send notification to all clients
  MSG_WriteByte(sv.reliable_datagram, svc_updatecolors);
  MSG_WriteByte(sv.reliable_datagram, svs.clients.indexOf(host_client));
  MSG_WriteByte(sv.reliable_datagram, host_client.colors);
}

function Host_Kill_f() {
  if (cmd_source === src_command) {
    // always forward, even to a local server, so the server runs it with
    // host_client / sv_player set to the client that typed it
    Cmd_ForwardToServer();
    return;
  }

  if (sv_player.v.health <= 0) {
    SV_ClientPrintf("Can't suicide -- allready dead!\n");
    return;
  }

  pr_global_struct.time = sv.time;
  pr_global_struct.self = EDICT_TO_PROG(sv_player);
  PR_ExecuteProgram(pr_global_struct.ClientKill);
}

function Host_God_f() {
  if (cmd_source === src_command) {
    Cmd_ForwardToServer();
    return;
  }

  if (Host_CheatAllowed() === false) {
    return;
  }

  // johnfitz: "god 0" and "god 1" set it explicitly
  switch (Cmd_Argc()) {
    case 1:
      sv_player.v.flags = (sv_player.v.flags | 0) ^ FL_GODMODE;
      if (!((sv_player.v.flags | 0) & FL_GODMODE)) {
        SV_ClientPrintf("godmode OFF\n");
      } else {
        SV_ClientPrintf("godmode ON\n");
      }
      break;
    case 2:
      if (Q_atof(Cmd_Argv(1)) !== 0) {
        sv_player.v.flags = (sv_player.v.flags | 0) | FL_GODMODE;
        SV_ClientPrintf("godmode ON\n");
      } else {
        sv_player.v.flags = (sv_player.v.flags | 0) & ~FL_GODMODE;
        SV_ClientPrintf("godmode OFF\n");
      }

      break;
    default:
      Con_Printf("god [value] : toggle god mode. values: 0 = off, 1 = on\n");
      break;
  }
}

function Host_Notarget_f() {
  if (cmd_source === src_command) {
    Cmd_ForwardToServer();
    return;
  }

  if (Host_CheatAllowed() === false) {
    return;
  }

  // johnfitz: "notarget 0" and "notarget 1" set it explicitly
  switch (Cmd_Argc()) {
    case 1:
      sv_player.v.flags = (sv_player.v.flags | 0) ^ FL_NOTARGET;
      if (!((sv_player.v.flags | 0) & FL_NOTARGET)) {
        SV_ClientPrintf("notarget OFF\n");
      } else {
        SV_ClientPrintf("notarget ON\n");
      }
      break;
    case 2:
      if (Q_atof(Cmd_Argv(1)) !== 0) {
        sv_player.v.flags = (sv_player.v.flags | 0) | FL_NOTARGET;
        SV_ClientPrintf("notarget ON\n");
      } else {
        sv_player.v.flags = (sv_player.v.flags | 0) & ~FL_NOTARGET;
        SV_ClientPrintf("notarget OFF\n");
      }

      break;
    default:
      Con_Printf(
        "notarget [value] : toggle notarget mode. values: 0 = off, 1 = on\n",
      );
      break;
  }
}

function Host_Fly_f() {
  if (cmd_source === src_command) {
    Cmd_ForwardToServer();
    return;
  }

  if (Host_CheatAllowed() === false) {
    return;
  }

  if (sv_player.v.movetype !== MOVETYPE_FLY) {
    sv_player.v.movetype = MOVETYPE_FLY;
    SV_ClientPrintf("flymode ON\n");
  } else {
    sv_player.v.movetype = MOVETYPE_WALK;
    SV_ClientPrintf("flymode OFF\n");
  }
}

function Host_Noclip_f() {
  if (cmd_source === src_command) {
    Cmd_ForwardToServer();
    return;
  }

  if (Host_CheatAllowed() === false) {
    return;
  }

  if (sv_player.v.movetype !== MOVETYPE_NOCLIP) {
    noclip_anglehack = true;
    sv_player.v.movetype = MOVETYPE_NOCLIP;
    SV_ClientPrintf("noclip ON\n");
  } else {
    noclip_anglehack = false;
    sv_player.v.movetype = MOVETYPE_WALK;
    SV_ClientPrintf("noclip OFF\n");
  }
}

function Host_Give_f() {
  if (cmd_source === src_command) {
    Cmd_ForwardToServer();
    return;
  }

  if (Host_CheatAllowed() === false) {
    return;
  }

  const t = Cmd_Argv(1);
  const v = parseInt(Cmd_Argv(2)) || 0; // atoi
  const c0 = t.charAt(0);
  let val;

  switch (c0) {
    case "0":
    case "1":
    case "2":
    case "3":
    case "4":
    case "5":
    case "6":
    case "7":
    case "8":
    case "9":
      // MED 01/04/97 added hipnotic give stuff
      if (hipnotic) {
        if (c0 === "6") {
          if (t.charAt(1) === "a") {
            sv_player.v.items = (sv_player.v.items | 0) | HIT_PROXIMITY_GUN;
          } else {
            sv_player.v.items = (sv_player.v.items | 0) | IT_GRENADE_LAUNCHER;
          }
        } else if (c0 === "9") {
          sv_player.v.items = (sv_player.v.items | 0) | HIT_LASER_CANNON;
        } else if (c0 === "0") {
          sv_player.v.items = (sv_player.v.items | 0) | HIT_MJOLNIR;
        } else if (c0 >= "2") {
          sv_player.v.items = (sv_player.v.items | 0) |
            (IT_SHOTGUN << (t.charCodeAt(0) - 50));
        }
      } else {
        if (c0 >= "2") {
          sv_player.v.items = (sv_player.v.items | 0) |
            (IT_SHOTGUN << (t.charCodeAt(0) - 50));
        }
      }

      break;

    case "s":
      if (rogue) {
        val = GetEdictFieldValue(sv_player, "ammo_shells1");
        if (val) {
          val.accessor.setFloat(val.ofs, v);
        }
      }

      sv_player.v.ammo_shells = v;
      break;

    case "n":
      if (rogue) {
        val = GetEdictFieldValue(sv_player, "ammo_nails1");
        if (val) {
          val.accessor.setFloat(val.ofs, v);
          if (sv_player.v.weapon <= IT_LIGHTNING) {
            sv_player.v.ammo_nails = v;
          }
        }
      } else {
        sv_player.v.ammo_nails = v;
      }

      break;

    case "l":
      if (rogue) {
        val = GetEdictFieldValue(sv_player, "ammo_lava_nails");
        if (val) {
          val.accessor.setFloat(val.ofs, v);
          if (sv_player.v.weapon > IT_LIGHTNING) {
            sv_player.v.ammo_nails = v;
          }
        }
      }

      break;

    case "r":
      if (rogue) {
        val = GetEdictFieldValue(sv_player, "ammo_rockets1");
        if (val) {
          val.accessor.setFloat(val.ofs, v);
          if (sv_player.v.weapon <= IT_LIGHTNING) {
            sv_player.v.ammo_rockets = v;
          }
        }
      } else {
        sv_player.v.ammo_rockets = v;
      }

      break;

    case "m":
      if (rogue) {
        val = GetEdictFieldValue(sv_player, "ammo_multi_rockets");
        if (val) {
          val.accessor.setFloat(val.ofs, v);
          if (sv_player.v.weapon > IT_LIGHTNING) {
            sv_player.v.ammo_rockets = v;
          }
        }
      }

      break;

    case "h":
      sv_player.v.health = v;
      break;

    case "c":
      if (rogue) {
        val = GetEdictFieldValue(sv_player, "ammo_cells1");
        if (val) {
          val.accessor.setFloat(val.ofs, v);
          if (sv_player.v.weapon <= IT_LIGHTNING) {
            sv_player.v.ammo_cells = v;
          }
        }
      } else {
        sv_player.v.ammo_cells = v;
      }

      break;

    case "p":
      if (rogue) {
        val = GetEdictFieldValue(sv_player, "ammo_plasma");
        if (val) {
          val.accessor.setFloat(val.ofs, v);
          if (sv_player.v.weapon > IT_LIGHTNING) {
            sv_player.v.ammo_cells = v;
          }
        }
      }

      break;

    // johnfitz -- give armour
    case "a":
      if (v > 150) {
        Host_GiveArmor(0.8, v, IT_ARMOR3);
      } else if (v > 100) {
        Host_GiveArmor(0.6, v, IT_ARMOR2);
      } else if (v >= 0) {
        Host_GiveArmor(0.3, v, IT_ARMOR1);
      }
      break;
  }

  // johnfitz -- update currentammo to match new ammo (so statusbar updates correctly)
  switch (sv_player.v.weapon | 0) {
    case IT_SHOTGUN:
    case IT_SUPER_SHOTGUN:
      sv_player.v.currentammo = sv_player.v.ammo_shells;
      break;
    case IT_NAILGUN:
    case IT_SUPER_NAILGUN:
    case RIT_LAVA_SUPER_NAILGUN:
      sv_player.v.currentammo = sv_player.v.ammo_nails;
      break;
    case IT_GRENADE_LAUNCHER:
    case IT_ROCKET_LAUNCHER:
    case RIT_MULTI_GRENADE:
    case RIT_MULTI_ROCKET:
      sv_player.v.currentammo = sv_player.v.ammo_rockets;
      break;
    case IT_LIGHTNING:
    case HIT_LASER_CANNON:
    case HIT_MJOLNIR:
      sv_player.v.currentammo = sv_player.v.ammo_cells;
      break;
    case RIT_LAVA_NAILGUN: // same as IT_AXE
      if (rogue) {
        sv_player.v.currentammo = sv_player.v.ammo_nails;
      }
      break;
    case RIT_PLASMA_GUN: // same as HIT_PROXIMITY_GUN
      if (rogue) {
        sv_player.v.currentammo = sv_player.v.ammo_cells;
      }
      if (hipnotic) {
        sv_player.v.currentammo = sv_player.v.ammo_rockets;
      }
      break;
  }
}

// johnfitz: "give a" replaces the armour type, as picking up armour does
function Host_GiveArmor(armortype, value, item) {
  const items = sv_player.v.items | 0;
  sv_player.v.armortype = armortype;
  sv_player.v.armorvalue = value;
  sv_player.v.items = items - (items & (IT_ARMOR1 | IT_ARMOR2 | IT_ARMOR3)) +
    item;
}

function Host_Ping_f() {
  if (cmd_source === src_command) {
    Cmd_ForwardToServer();
    return;
  }

  SV_ClientPrintf("Client ping times:\n");

  for (let i = 0; i < svs.maxclients; i++) {
    const client = svs.clients[i];
    if (client == null || client.active === false) continue;

    let total = 0;
    for (let j = 0; j < NUM_PING_TIMES; j++) {
      total += client.ping_times[j];
    }

    total /= NUM_PING_TIMES;
    SV_ClientPrintf("  " + ((total * 1000) | 0) + " " + client.name + "\n");
  }
}

function Host_Kick_f() {
  if (cmd_source === src_command) {
    if (sv.active === false) {
      Cmd_ForwardToServer();
      return;
    }
  } else if (
    pr_global_struct.deathmatch !== 0 && host_client.privileged === false
  ) {
    return;
  } else if (Host_ClientIsGuest(host_client)) {
    // Icaro: a guest can't kick (see sv_guestcheats above)
    SV_ClientPrintf("Only the host can kick.\n");
    return;
  }

  const save = host_client;

  let i;
  let byNumber = false;

  if (Cmd_Argc() > 2 && Cmd_Argv(1) === "#") {
    i = (parseFloat(Cmd_Argv(2)) | 0) - 1;
    if (i < 0 || i >= svs.maxclients) return;
    if (svs.clients[i] == null || svs.clients[i].active === false) return;
    set_host_client(svs.clients[i]);
    byNumber = true;
  } else {
    for (i = 0; i < svs.maxclients; i++) {
      set_host_client(svs.clients[i]);
      if (host_client == null || host_client.active === false) continue;
      if (host_client.name.toLowerCase() === Cmd_Argv(1).toLowerCase()) break;
    }
  }

  if (i < svs.maxclients) {
    let who;
    if (cmd_source === src_command) {
      if (cls.state === ca_dedicated) {
        who = "Console";
      } else {
        who = cl_name.string;
      }
    } else {
      who = save.name;
    }

    // can't kick yourself!
    if (host_client === save) {
      set_host_client(save);
      return;
    }

    let message = null;
    if (Cmd_Argc() > 2) {
      // message = COM_Parse( Cmd_Args() ): skip the first token (the
      // player name, or the '#')
      let args = COM_Parse(Cmd_Args()) || "";
      if (byNumber) {
        args = args.substring(1); // skip the #
        while (args.charAt(0) === " ") { // skip white space
          args = args.substring(1);
        }
        args = args.substring(Cmd_Argv(2).length); // skip the number
      }

      while (args.charAt(0) === " ") {
        args = args.substring(1);
      }
      message = args;
    }

    if (message != null) {
      SV_ClientPrintf("%s", "Kicked by " + who + ": " + message + "\n");
    } else {
      SV_ClientPrintf("%s", "Kicked by " + who + "\n");
    }

    SV_DropClient(false);
  }

  set_host_client(save);
}

const SAVEGAME_VERSION = 5;
const SAVE_STORAGE_PREFIX = "quake_save_";

// Web-only (the C writes files): saves live in localStorage, which Safari may
// evict for sites that aren't installed. Ask for persistent storage once, after
// the first user-initiated save, never at boot (some browsers prompt).
let persist_requested = false;

function Host_RequestPersistentStorage() {
  if (persist_requested === true) return;
  if (typeof navigator === "undefined" || navigator === null) return;
  const storage = navigator.storage;
  if (
    storage === undefined || storage === null ||
    typeof storage.persist !== "function"
  ) return;
  persist_requested = true;

  try {
    const ask = () =>
      storage.persist().then(
        (granted) =>
          Con_DPrintf(
            "Persistent storage %s.\n",
            granted === true ? "granted" : "denied",
          ),
        () => {},
      );

    if (typeof storage.persisted === "function") {
      storage.persisted().then(
        (already) => already === true ? undefined : ask(),
        () => {},
      );
    } else {
      ask();
    }
  } catch {
    // fire and forget
  }
}

/**
 * Writes a SAVEGAME_COMMENT_LENGTH character comment describing the current game
 */
function Host_SavegameComment() {
  // Build comment: levelname padded to 22 chars, then kills:xxx/xxx.
  // QuakeSpasm/Ironwail: fall back to the map name when the level has no
  // message (cl.mapname there; saving needs a local server, so sv.name is
  // the same map), and turn CRs and LFs into spaces: a level name with a
  // newline (autumn_sp) would otherwise break the line-based save file.
  let text = cl.levelname !== "" ? cl.levelname : sv.name;
  text = text.substring(0, 22).replace(/[\r\n]/g, " ");
  while (text.length < 22) text += " ";

  const kills = "kills:" + String(cl.stats[STAT_MONSTERS]).padStart(3, " ") +
    "/" + String(cl.stats[STAT_TOTALMONSTERS]).padStart(3, " ");
  text += kills;

  // Pad to SAVEGAME_COMMENT_LENGTH
  while (text.length < SAVEGAME_COMMENT_LENGTH) text += " ";
  text = text.substring(0, SAVEGAME_COMMENT_LENGTH);

  // convert spaces to _ (original C format)
  return text.replace(/ /g, "_");
}

function Host_Savegame_f() {
  if (cmd_source !== src_command) return;

  const refusal = Host_SaveRefusal();
  if (refusal !== null) {
    Con_Printf(refusal);
    return;
  }

  if (Cmd_Argc() !== 2) {
    Con_Printf("save <savename> : save a game\n");
    return;
  }

  if (Cmd_Argv(1).indexOf("..") !== -1) {
    Con_Printf("Relative pathnames are not allowed.\n");
    return;
  }

  const dead = Host_SaveDeadRefusal();
  if (dead !== null) {
    Con_Printf(dead);
    return;
  }

  Host_WriteSave(Cmd_Argv(1), false);
}

// The refusals Host_Savegame_f makes before it looks at its arguments: the
// message to print, or null if the game can be saved. Host_AutoSave shares them.
function Host_SaveRefusal() {
  if (sv.active === false) return "Not playing a local game.\n";

  // Ironwail: a save made with the monsters removed would carry that into
  // the loaded game
  if (sv.nomonsters) return 'Can\'t save when using "nomonsters".\n';

  if (cl.intermission !== 0) return "Can't save in intermission.\n";

  if (svs.maxclients !== 1) return "Can't save multiplayer games.\n";

  return null;
}

function Host_SaveDeadRefusal() {
  for (let i = 0; i < svs.maxclients; i++) {
    if (
      svs.clients[i] != null && svs.clients[i].active &&
      svs.clients[i].edict.v.health <= 0
    ) {
      return "Can't savegame with a dead player\n";
    }
  }

  return null;
}

// The body of Host_Savegame_f. quiet: the automatic path prints nothing.
// Returns true if the save was stored.
function Host_WriteSave(name, quiet) {
  if (quiet === false) Con_Printf("Saving game to %s...\n", name);

  const lines = [];

  lines.push(String(SAVEGAME_VERSION));
  lines.push(Host_SavegameComment());

  for (let i = 0; i < NUM_SPAWN_PARMS; i++) {
    lines.push(String(svs.clients[0].spawn_parms[i]));
  }

  lines.push(String(current_skill));
  lines.push(sv.name);
  lines.push(String(sv.time));

  // write the light styles
  for (let i = 0; i < MAX_LIGHTSTYLES; i++) {
    if (sv.lightstyles[i] != null) {
      lines.push(sv.lightstyles[i]);
    } else {
      lines.push("m");
    }
  }

  // write globals
  ED_WriteGlobals(lines);

  // write all edicts
  for (let i = 0; i < sv.num_edicts; i++) {
    ED_Write(lines, EDICT_NUM(i));
  }

  // Store in localStorage
  const saveData = lines.join("\n") + "\n";

  try {
    localStorage.setItem(SAVE_STORAGE_PREFIX + name, saveData);
  } catch {
    if (quiet === false) {
      Con_Printf("ERROR: couldn't save (localStorage full?).\n");
    }
    return false;
  }

  if (quiet === false) Con_Printf("done.\n");
  Host_RequestPersistentStorage();
  return true;
}

// Host_AutoSave
//
// Web-only deviation (mobile roadmap Tier 2 item 14, rules in autosave.js): iOS
// discards background tabs, so in_web.js calls this when the page is hidden
// (visibilitychange, pagehide). A local single-player game in progress is saved
// into the reserved slot "autosave", which the s0-s11 menu slots never touch.
// It uses the refusals of Host_Savegame_f but prints nothing, and it is
// synchronous (localStorage), so it finishes inside the event. Returns true if
// a save was written.
let autosave_last_name = "";
let autosave_last_time = -1;

export function Host_AutoSave() {
  if (web_autosave.value === 0) return false;

  // a local game in progress: one client, past signon and spawned, not a demo
  if (
    cls.state !== ca_connected || cls.signon !== SIGNONS || cls.demoplayback
  ) return false;
  if (sv.active !== true || svs.clients === null || svs.clients[0] == null) {
    return false;
  }
  if (svs.clients[0].active !== true || svs.clients[0].spawned !== true) {
    return false;
  }

  if (Host_SaveRefusal() !== null) return false;
  if (Host_SaveDeadRefusal() !== null) return false;

  // visibilitychange and pagehide both fire: don't write the same moment twice
  if (sv.name === autosave_last_name && sv.time === autosave_last_time) {
    return false;
  }

  if (Host_WriteSave(AUTOSAVE_SLOT, true) !== true) return false;

  autosave_last_name = sv.name;
  autosave_last_time = sv.time;
  Autosave_WriteMeta(Date.now(), sv.name);
  return true;
}

/**
 * The page is visible again, so the game in memory is the live one: nothing to
 * recover if it is discarded later than this (autosave.js rules).
 */
export function Host_AutosaveVisible() {
  // Only the autosave this page wrote: one left by an earlier page waits
  // for the Continue offer, even if the player switches tabs first
  if (autosave_last_name !== "") Autosave_Consume();
  autosave_last_name = "";
  autosave_last_time = -1;
}

// Host_MaybeOfferContinue
//
// Web-only. Called once per frame by Host_Frame until it returns true. On the
// first page load after an autosave it asks, with the engine's YES/NO prompt
// (SCR_ModalMessage, which takes touch taps), whether to continue. Yes loads
// the autosave; either answer consumes it. Rules: autosave.js.
let offer_frames = 0;

export function Host_MaybeOfferContinue() {
  offer_frames++;

  if (web_autosave.value === 0) return true; // autosave is off: offer nothing

  let saveExists = false;
  try {
    saveExists =
      localStorage.getItem(SAVE_STORAGE_PREFIX + AUTOSAVE_SLOT) !== null;
  } catch {
    // ignore
  }

  const decision = Autosave_OfferDecision({
    search: typeof location !== "undefined" && location !== null ?
      location.search :
      "",
    now: Date.now(),
    metaText: Autosave_ReadMeta(),
    saveExists: saveExists,
    connected: sv.active === true ||
      (cls.state === ca_connected && cls.demoplayback !== true), // a title demo is not a game
    dedicated: cls.state === ca_dedicated,
    modalActive: Key_ModalActive(),
    ready: offer_frames > 3, // the config and the title demo have started
  });

  if (decision === "wait") return false;
  if (decision === "skip") return true;

  SCR_ModalMessage("Continue your last game?\n", function (yes) {
    Autosave_Consume();
    if (yes !== true) return;

    set_key_dest(key_game);
    SCR_BeginLoadingPlaque();
    Cbuf_AddText("load " + AUTOSAVE_SLOT + "\n");
  });
  return true;
}

function Host_Loadgame_f() {
  if (cmd_source !== src_command) return;

  if (Cmd_Argc() !== 2) {
    Con_Printf("load <savename> : load a game\n");
    return;
  }

  // Ironwail: the loaded game should keep its monsters. Ironwail prints this
  // with Con_Warning, which the port doesn't have.
  if (nomonsters.value !== 0) {
    Con_Printf('Warning: "%s" disabled automatically.\n', nomonsters.name);
    Cvar_SetValue(nomonsters.name, 0);
  }

  cls.demonum = -1; // stop demo loop in case this fails

  const name = Cmd_Argv(1);

  Con_Printf("Loading game from %s...\n", name);

  let saveData;

  try {
    saveData = localStorage.getItem(SAVE_STORAGE_PREFIX + name);
  } catch {
    // ignore
  }

  if (saveData == null) {
    Con_Printf("ERROR: couldn't open.\n");
    return;
  }

  // Parse the save file line by line
  const allLines = saveData.split("\n");
  let lineIdx = 0;

  function nextLine() {
    if (lineIdx < allLines.length) return allLines[lineIdx++];
    return "";
  }

  const version = parseInt(nextLine());
  if (version !== SAVEGAME_VERSION) {
    Con_Printf("Savegame is version %i, not %i\n", version, SAVEGAME_VERSION);
    return;
  }

  nextLine(); // skip comment

  const spawn_parms = new Float32Array(NUM_SPAWN_PARMS);
  for (let i = 0; i < NUM_SPAWN_PARMS; i++) {
    spawn_parms[i] = parseFloat(nextLine()) || 0;
  }

  // this silliness is so we can load 1.06 save files, which have float skill values
  const tfloat = parseFloat(nextLine()) || 0;
  const loadSkill = (tfloat + 0.1) | 0;
  Cvar_SetValue("skill", loadSkill);

  const mapname = nextLine();
  const time = parseFloat(nextLine()) || 0;

  // If the map file isn't loaded yet, fetch it on demand
  const mapfilename = "maps/" + mapname + ".bsp";
  if (COM_FindFile(mapfilename) === null) {
    Con_Printf("Fetching %s...\n", mapfilename);
    COM_EnsureFile(mapfilename).then((success) => {
      if (success) {
        // Re-issue the load command (will re-parse save data from localStorage)
        Cbuf_AddText("load " + name + "\n");
      } else {
        Con_Printf("Couldn't find map: %s\n", mapname);
      }
    });
    return;
  }

  CL_Disconnect();

  SV_SpawnServer(mapname);

  if (sv.active === false) {
    Con_Printf("Couldn't load map\n");
    return;
  }

  sv.paused = true; // pause until all clients connect
  sv.loadgame = true;

  // load the light styles
  for (let i = 0; i < MAX_LIGHTSTYLES; i++) {
    sv.lightstyles[i] = nextLine();
  }

  // load the edicts out of the savegame file. The rest of the file is
  // parsed as one token stream, as in C, so a } inside a quoted value
  // doesn't end its block.
  let data = allLines.slice(lineIdx).join("\n");
  let entnum = -1; // -1 is the globals

  while (data !== null && data.length > 0) {
    data = COM_Parse(data);
    if (com_token.length === 0) break; // end of file
    if (com_token !== "{") {
      Host_Error("First token isn't a brace"); // id: Sys_Error; Ironwail's Host_Error
    }

    if (entnum === -1) {
      // parse the global vars
      data = ED_ParseGlobals(data);
    } else {
      // parse an edict
      const ent = EDICT_NUM(entnum);
      ent.free = false;
      data = ED_ParseEdict(data, ent);

      // link it into the bsp tree
      if (ent.free === false) {
        SV_LinkEdict(ent, false);
      }
    }

    entnum++;
  }

  sv.num_edicts = entnum;
  sv.time = time;

  for (let i = 0; i < NUM_SPAWN_PARMS; i++) {
    svs.clients[0].spawn_parms[i] = spawn_parms[i];
  }

  if (cls.state !== ca_dedicated) {
    CL_EstablishConnection("local");
    Host_Reconnect_f();
  }
}

function Host_Startdemos_f() {
  if (cls.state === ca_dedicated) {
    if (!sv.active) {
      Cbuf_AddText("map start\n");
    }
    return;
  }

  let c = Cmd_Argc() - 1;
  if (c > MAX_DEMOS) {
    Con_Printf("Max %i demos in demoloop\n", MAX_DEMOS);
    c = MAX_DEMOS;
  }

  Con_Printf("%i demo(s) in loop\n", c);

  for (let i = 1; i < c + 1; i++) {
    cls.demos[i - 1] = Cmd_Argv(i);
  }

  if (!sv.active && cls.demonum !== -1 && !cls.demoplayback) {
    cls.demonum = 0;
    CL_NextDemo();
  } else {
    cls.demonum = -1;
  }
}

function Host_Demos_f() {
  if (cls.state === ca_dedicated) {
    return;
  }
  if (cls.demonum === -1) {
    cls.demonum = 1;
  }
  CL_Disconnect();
  CL_NextDemo();
}

function Host_Stopdemo_f() {
  if (cls.state === ca_dedicated) {
    return;
  }
  if (!cls.demoplayback) {
    return;
  }
  CL_StopPlayback();
  CL_Disconnect();
}

/**
 * C also prints the build time ("Exe: " __TIME__ " " __DATE__). The port has
 * no build step that could stamp one, so that line is left out.
 */
export function Host_Version_f() {
  Con_Printf("Version " + VERSION.toFixed(2) + "\n");
}

/**
 * The view* commands step a "viewthing" entity through a model's frames, for
 * modders inspecting a model. They read both the local server's edicts and the
 * client's model_precache, so like C they only work in a local game.
 */
export function FindViewthing() {
  for (let i = 0; i < sv.num_edicts; i++) {
    const e = EDICT_NUM(i);
    if (PR_GetString(e.v.classname) === "viewthing") {
      return e;
    }
  }

  Con_Printf("No viewthing on map\n");
  return null;
}

export function Host_Viewmodel_f() {
  const e = FindViewthing();
  if (e === null) {
    return;
  }

  const m = Mod_ForName(Cmd_Argv(1), false);
  if (m === null) {
    Con_Printf("Can't load %s\n", Cmd_Argv(1));
    return;
  }

  e.v.frame = 0;
  cl.model_precache[Math.trunc(e.v.modelindex)] = m;
}

export function Host_Viewframe_f() {
  const e = FindViewthing();
  if (e === null) {
    return;
  }
  const m = cl.model_precache[Math.trunc(e.v.modelindex)];

  let f = parseInt(Cmd_Argv(1), 10) || 0; // atoi
  if (f >= m.numframes) {
    f = m.numframes - 1;
  }

  e.v.frame = f;
}

function PrintFrameName(m, frame) {
  // C casts any model's extra data to aliashdr_t and reads garbage for a
  // brush or sprite model; the port's Mod_Extradata would Sys_Error on a
  // brush model instead, so only alias models print a name.
  if (m.type !== mod_alias) {
    return;
  }

  // C's "if (!hdr) return;" is left out: Mod_Extradata returns the data or
  // calls Sys_Error.
  const hdr = Mod_Extradata(m);
  const pframedesc = hdr.frames[frame];

  Con_Printf("frame %i: %s\n", frame, pframedesc.name);
}

export function Host_Viewnext_f() {
  const e = FindViewthing();
  if (e === null) {
    return;
  }
  const m = cl.model_precache[Math.trunc(e.v.modelindex)];

  e.v.frame = e.v.frame + 1;
  if (e.v.frame >= m.numframes) {
    e.v.frame = m.numframes - 1;
  }

  PrintFrameName(m, e.v.frame);
}

export function Host_Viewprev_f() {
  const e = FindViewthing();
  if (e === null) {
    return;
  }

  const m = cl.model_precache[Math.trunc(e.v.modelindex)];

  e.v.frame = e.v.frame - 1;
  if (e.v.frame < 0) {
    e.v.frame = 0;
  }

  PrintFrameName(m, e.v.frame);
}

/**
 * Deliberate addition; not in id's Quake or Ironwail. The 2021 re-release's
 * published QuakeC has `stuffcmd (self, "vibrate tactile/....bnvib")` at ten
 * sites in weapons.qc, all commented out, and no shipped progs.dat contains
 * "vibrate". The KEX executable has the command and the paks ship the .bnvib
 * files under tactile/. Registered so a mod that re-enables those lines gets
 * silence instead of "Unknown command"; it ignores its arguments.
 */
function Host_Vibrate_f() {
}

function Host_PreSpawn_f() {
  if (cmd_source === src_command) {
    Con_Printf("prespawn is not valid from the console\n");
    return;
  }

  if (host_client.spawned) {
    Con_Printf("prespawn not valid -- allready spawned\n");
    return;
  }

  // johnfitz/Ironwail: SV_SendClientMessages sends the signon buffers,
  // one per message, then svc_signonnum 2
  host_client.sendsignon = PRESPAWN_SIGNONBUFS;
  host_client.signonidx = 0;
}

function Host_Spawn_f() {
  if (cmd_source === src_command) {
    Con_Printf("spawn is not valid from the console\n");
    return;
  }

  if (host_client.spawned) {
    Con_Printf("Spawn not valid -- allready spawned\n");
    return;
  }

  // run the entrance script
  if (sv.loadgame) {
    // loaded games are fully inited allready
    // if this is the last client to be connected, unpause
    sv.paused = false;
  } else {
    // set up the edict
    const ent = host_client.edict;

    // clear entity fields (C does: memset(&ent->v, 0, progs->entityfields * 4))
    ent.clearFields();

    // set key fields after clearing
    const colormap = NUM_FOR_EDICT(ent);
    const team = (host_client.colors & 15) + 1;
    ent.v.colormap = colormap;
    ent.v.team = team;
    ent.v.netname = ED_NewString(host_client.name);

    // copy spawn parms out of the client_t
    if (pr_global_struct) {
      for (let i = 0; i < NUM_SPAWN_PARMS; i++) {
        pr_global_struct["parm" + (i + 1)] = host_client.spawn_parms[i];
      }

      // call the spawn function
      pr_global_struct.time = sv.time;
      pr_global_struct.self = EDICT_TO_PROG(sv_player);
      PR_ExecuteProgram(pr_global_struct.ClientConnect);

      if (
        (Sys_FloatTime() - host_client.netconnection.connecttime) <= sv.time
      ) {
        Sys_Printf("%s entered the game\n", host_client.name);
      }

      PR_ExecuteProgram(pr_global_struct.PutClientInServer);
    }
  }

  // send all current names, colors, and frag counts
  SZ_Clear(host_client.message);

  // send time of update
  MSG_WriteByte(host_client.message, svc_time);
  MSG_WriteFloat(host_client.message, sv.time);

  for (let i = 0; i < svs.maxclients; i++) {
    const client = svs.clients[i];
    MSG_WriteByte(host_client.message, svc_updatename);
    MSG_WriteByte(host_client.message, i);
    MSG_WriteString(host_client.message, client.name);
    MSG_WriteByte(host_client.message, svc_updatefrags);
    MSG_WriteByte(host_client.message, i);
    MSG_WriteShort(host_client.message, client.old_frags);
    MSG_WriteByte(host_client.message, svc_updatecolors);
    MSG_WriteByte(host_client.message, i);
    MSG_WriteByte(host_client.message, client.colors);
  }

  // send all current light styles
  for (let i = 0; i < MAX_LIGHTSTYLES; i++) {
    MSG_WriteByte(host_client.message, svc_lightstyle);
    MSG_WriteByte(host_client.message, i);
    MSG_WriteString(host_client.message, sv.lightstyles[i] || "");
  }

  // send some stats
  MSG_WriteByte(host_client.message, svc_updatestat);
  MSG_WriteByte(host_client.message, STAT_TOTALSECRETS);
  MSG_WriteLong(
    host_client.message,
    pr_global_struct ? pr_global_struct.total_secrets : 0,
  );

  MSG_WriteByte(host_client.message, svc_updatestat);
  MSG_WriteByte(host_client.message, STAT_TOTALMONSTERS);
  MSG_WriteLong(
    host_client.message,
    pr_global_struct ? pr_global_struct.total_monsters : 0,
  );

  MSG_WriteByte(host_client.message, svc_updatestat);
  MSG_WriteByte(host_client.message, STAT_SECRETS);
  MSG_WriteLong(
    host_client.message,
    pr_global_struct ? pr_global_struct.found_secrets : 0,
  );

  MSG_WriteByte(host_client.message, svc_updatestat);
  MSG_WriteByte(host_client.message, STAT_MONSTERS);
  MSG_WriteLong(
    host_client.message,
    pr_global_struct ? pr_global_struct.killed_monsters : 0,
  );

  // send a fixangle
  // Never send a roll angle, because savegames can catch the server
  // in a state where it is expecting the client to correct the angle
  // and it won't happen if the game was just loaded, so you wind up
  // with a permanent head tilt
  // Ironwail: a loaded game sends the view angles. The model's angles have
  // the pitch negated and divided by 3 (SV_ClientThink), so id's C left the
  // view pitched the wrong way after a load.
  const ent = EDICT_NUM(1 + svs.clients.indexOf(host_client));
  MSG_WriteByte(host_client.message, svc_setangle);
  for (let i = 0; i < 2; i++) {
    MSG_WriteAngle(
      host_client.message,
      sv.loadgame ? ent.v.v_angle[i] : ent.v.angles[i],
    );
  }
  MSG_WriteAngle(host_client.message, 0);

  SV_WriteClientdataToMessage(sv_player, host_client.message);

  MSG_WriteByte(host_client.message, svc_signonnum);
  MSG_WriteByte(host_client.message, 3);
  host_client.sendsignon = PRESPAWN_FLUSH;
}

function Host_Begin_f() {
  if (cmd_source === src_command) {
    Con_Printf("begin is not valid from the console\n");
    return;
  }

  host_client.spawned = true;
}
