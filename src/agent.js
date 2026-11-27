// Icaro Engine: agent interface
// Web-only addition with no C counterpart. It lets an LLM agent or an RL
// harness play: compact text observations, an event log, held buttons and
// look deltas, and a lockstep clock so the game only advances when the agent
// steps it. The design is in docs/agent-interface.md. main.js exposes it as
// window.icaro. Nothing here touches window or document at import time.

import { ca_connected, cl, cl_entities, cls, SIGNONS } from "./client.js";
import {
  IT_ARMOR1,
  IT_ARMOR2,
  IT_ARMOR3,
  IT_AXE,
  IT_GRENADE_LAUNCHER,
  IT_INVISIBILITY,
  IT_INVULNERABILITY,
  IT_KEY1,
  IT_KEY2,
  IT_LIGHTNING,
  IT_NAILGUN,
  IT_QUAD,
  IT_ROCKET_LAUNCHER,
  IT_SHOTGUN,
  IT_SUIT,
  IT_SUPER_NAILGUN,
  IT_SUPER_SHOTGUN,
  MAX_EDICTS,
  PITCH,
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
  STAT_TOTALMONSTERS,
  STAT_TOTALSECRETS,
  YAW,
} from "./quakedef.js";
import {
  Cbuf_AddText,
  Cbuf_Execute,
  Cmd_ExecuteString,
  src_command,
} from "./cmd.js";
import { Cvar_FindVar } from "./cvar.js";
import { IN_SetAgentDriven } from "./in_web.js";
import { deathmatch, Host_Frame, host_framecount, skill } from "./host.js";
import { NET_CanSendMessage } from "./net_main.js";
import { Con_SetAgentHook } from "./console.js";
import { SCR_SetAgentHook, SCR_UpdateScreen } from "./gl_screen.js";
import {
  m_advanced,
  m_advpage,
  M_AgentState,
  m_credits,
  m_gameoptions,
  m_help,
  m_keys,
  m_lanconfig,
  m_load,
  m_main,
  m_multiplayer,
  m_net,
  m_none,
  m_options,
  m_quit,
  m_save,
  m_search,
  m_setup,
  m_singleplayer,
  m_slist,
  m_touch,
  m_video,
} from "./menu.js";
import {
  K_BACKSPACE,
  K_DOWNARROW,
  K_ENTER,
  K_ESCAPE,
  K_LEFTARROW,
  K_RIGHTARROW,
  K_TAB,
  K_UPARROW,
  key_console,
  key_dest,
  Key_Event,
  key_menu,
  key_message,
} from "./keys.js";
import { sv } from "./server.js";
import { PR_GetString, pr_globals_int } from "./progs.js";
import {
  SV_HullPointContents,
  SV_RecursiveHullCheck,
  trace_t,
} from "./world.js";
import {
  CONTENTS_LAVA,
  CONTENTS_SKY,
  CONTENTS_SLIME,
  CONTENTS_SOLID,
  CONTENTS_WATER,
} from "./bspfile.js";
import { CL_ClampPitch } from "./cl_input.js";
import { COM_EnsureFile } from "./pak.js";
import {
  Nav_Build,
  Nav_FindPath,
  NAV_LINK_DOOR,
  NAV_LINK_JUMP,
  NAV_LINK_MOVER,
  NAV_LINK_PLAT,
  NAV_LINK_SWIM,
  NAV_NODE_SLIME,
  NAV_NODE_WATER,
} from "./nav.js";

export const AGENT_TIC = 1 / 72; // one step tic: one 72 Hz game tick

// STATE

let agent_mode = "off"; // 'off' | 'realtime' | 'lockstep'
let agent_tics = 0; // tics stepped in lockstep since attach

// Event log: a ring of short text lines with sequence numbers
const EVENT_MAX = 256;
const agent_events = new Array(EVENT_MAX).fill("");
let event_seq = 0; // number of events ever pushed
let event_read = 0; // first event not yet returned by Agent_Observe
let con_partial = ""; // console text since the last newline

// Previous values, for the stat-change events
const prev_stats = new Int32Array(32);
let prev_items = 0;
let prev_map = "";
let prev_intermission = 0;
let prev_valid = false;

// Buttons held for the current step (names from AGENT_BUTTONS)
const held_buttons = new Set();
const AGENT_KEYNUM = "4095"; // a key number no real key uses, so KeyUp matches our KeyDown

// cvars that lockstep pins, with the values to restore on detach
const LOCKSTEP_CVARS = [["host_framerate", String(AGENT_TIC)], [
  "host_timescale",
  "0",
], ["host_maxfps", "72"]];
const saved_cvars = new Map();

// TABLES

// Action button names to the client's +/- commands
export const AGENT_BUTTONS = {
  forward: "forward",
  back: "back",
  moveleft: "moveleft",
  moveright: "moveright",
  left: "left",
  right: "right",
  lookup: "lookup",
  lookdown: "lookdown",
  jump: "jump",
  attack: "attack",
  speed: "speed",
  up: "moveup",
  down: "movedown",
  strafe: "strafe",
  use: "use",
};

// Model names (without progs/ or maps/ and the extension) to short kinds.
// id1 only; anything else reports its file name.
const MODEL_KINDS = {
  soldier: "grunt",
  dog: "dog",
  ogre: "ogre",
  knight: "knight",
  hknight: "death_knight",
  demon: "fiend",
  shambler: "shambler",
  zombie: "zombie",
  wizard: "scrag",
  fish: "fish",
  shalrath: "vore",
  enforcer: "enforcer",
  tarbaby: "spawn",
  oldone: "shub",
  boss: "chthon",
  player: "player",
  backpack: "backpack",
  g_shot: "super_shotgun",
  g_nail: "nailgun",
  g_nail2: "super_nailgun",
  g_rock: "grenade_launcher",
  g_rock2: "rocket_launcher",
  g_light: "thunderbolt",
  quaddama: "quad",
  invulner: "pentagram",
  suit: "biosuit",
  invisibl: "ring",
  w_g_key: "gold_key",
  m_g_key: "gold_key",
  b_g_key: "gold_key",
  w_s_key: "silver_key",
  m_s_key: "silver_key",
  b_s_key: "silver_key",
  end1: "rune",
  end2: "rune",
  end3: "rune",
  end4: "rune",
  b_shell0: "shells",
  b_shell1: "shells_big",
  b_nail0: "nails",
  b_nail1: "nails_big",
  b_rock0: "rockets",
  b_rock1: "rockets_big",
  b_batt0: "cells",
  b_batt1: "cells_big",
  b_bh10: "health_small",
  b_bh25: "health",
  b_bh100: "megahealth",
  b_explob: "explobox",
  b_exbox2: "explobox",
  missile: "rocket_proj",
  grenade: "grenade_proj",
  spike: "nail_proj",
  s_spike: "nail_proj",
  laser: "laser_proj",
  k_spike: "knight_proj",
  w_spike: "scrag_proj",
  v_spike: "vore_proj",
  zom_gib: "zombie_gib_proj",
  lavaball: "lavaball",
};
const FL_MONSTER = 32; // server.h

const ARMOR_SKINS = ["green_armor", "yellow_armor", "red_armor"];

// Models never worth listing: gibs, heads, sprites, the view model
const SKIP_MODEL = /^(gib[0-9]|h_|v_|s_|bubble|flame|lavaball_sm)/;

// Brush entity classnames (server truth) to kinds; others are skipped
const BRUSH_KINDS = {
  func_door: "door",
  func_door_secret: "secret_door",
  func_button: "button",
  func_plat: "lift",
  func_train: "train",
  func_episodegate: "gate",
  func_bossgate: "gate",
};

// Invisible triggers worth reporting from server truth
const TRIGGER_KINDS = {
  trigger_changelevel: "exit",
  trigger_teleport: "teleport",
};

const WEAPON_NAMES = [
  [IT_AXE, "axe"],
  [IT_SHOTGUN, "shotgun"],
  [IT_SUPER_SHOTGUN, "super_shotgun"],
  [IT_NAILGUN, "nailgun"],
  [IT_SUPER_NAILGUN, "super_nailgun"],
  [IT_GRENADE_LAUNCHER, "grenade_launcher"],
  [IT_ROCKET_LAUNCHER, "rocket_launcher"],
  [IT_LIGHTNING, "thunderbolt"],
];

// Text labels for menus drawn as pictures (rows in draw order)
const MENU_NAMES = {
  [m_none]: "none",
  [m_main]: "main",
  [m_singleplayer]: "singleplayer",
  [m_load]: "load",
  [m_save]: "save",
  [m_multiplayer]: "multiplayer",
  [m_setup]: "setup",
  [m_net]: "net",
  [m_options]: "options",
  [m_video]: "video",
  [m_keys]: "keys",
  [m_help]: "help",
  [m_quit]: "quit",
  [m_lanconfig]: "lanconfig",
  [m_gameoptions]: "gameoptions",
  [m_search]: "search",
  [m_slist]: "serverlist",
  [m_credits]: "credits",
  [m_touch]: "touch",
  [m_advanced]: "advanced",
  [m_advpage]: "advanced_page",
};
const MENU_ITEMS = {
  [m_singleplayer]: ["New Game", "Load", "Save"],
  [m_multiplayer]: ["Join a Game", "New Game", "Setup"],
  [m_quit]: ["y = quit", "n = stay"],
};
const MAIN_ITEMS = ["Single Player", "Multiplayer", "Options", "Help", "Quit"];

export const AGENT_KEYS = {
  enter: K_ENTER,
  escape: K_ESCAPE,
  up: K_UPARROW,
  down: K_DOWNARROW,
  left: K_LEFTARROW,
  right: K_RIGHTARROW,
  tab: K_TAB,
  backspace: K_BACKSPACE,
  "`": 96,
  "~": 126,
  space: 32,
};

// EVENTS

function Agent_PushEvent(text) {
  agent_events[event_seq % EVENT_MAX] = text;
  event_seq++;
}

// Quake text: bit 7 picks the gold font, 1 and 2 lead colored lines, 10 is
// newline. Keep printable ASCII.
export function Agent_CleanText(txt) {
  let out = "";
  for (let i = 0; i < txt.length; i++) {
    let c = txt.charCodeAt(i) & 127;
    if (c === 10) {
      out += "\n";
      continue;
    }
    if (c < 32) {
      if (c === 1 || c === 2) continue;
      c = 32;
    }
    out += String.fromCharCode(c);
  }

  return out;
}

// Console lines that are loading chatter, not game events
const AGENT_NOISE =
  /^(meshing |Connecting to local|VERSION [0-9.]+ SERVER|Loading |execing |Unknown command "?(startdemos|demos)|couldn't exec|Client .* removed$|[0-9]+ demo\(s\) in loop$|CL_ParseStartSoundPacket: sound_num [0-9]+ not precached$)/;

function Agent_ConsoleHook(txt) {
  con_partial += Agent_CleanText(txt);
  let nl;
  while ((nl = con_partial.indexOf("\n")) >= 0) {
    const line = con_partial.substring(0, nl).trim();
    con_partial = con_partial.substring(nl + 1);
    // Skip blank lines and the console's ruler lines (Agent_CleanText
    // turned its bar characters into spaces)
    if (
      line.length > 0 && /^[- ]+$/.test(line) === false &&
      AGENT_NOISE.test(line) === false
    ) {
      Agent_PushEvent("msg: " + line);
    }
  }
}

function Agent_CenterHook(str) {
  const text = Agent_CleanText(str).split("\n").map((s) => s.trim()).filter((
    s,
  ) => s.length > 0).join(" / ");
  if (text.length > 0) {
    Agent_PushEvent("center: " + text);
  }
}

let mapname_model = null;
let mapname = "";
function Agent_MapName() {
  if (cl.worldmodel === null || cls.state !== ca_connected) {
    return "";
  }
  if (cl.worldmodel !== mapname_model) {
    mapname_model = cl.worldmodel;
    mapname = cl.worldmodel.name.replace(/^maps\//, "").replace(/\.bsp$/, "");
  }

  return mapname;
}

// Events from stat changes since the last check
function Agent_StatEvents() {
  const map = Agent_MapName();
  if (map === "" || cls.signon !== SIGNONS) {
    prev_valid = false;
    return;
  }

  const st = cl.stats;
  if (prev_valid === false || map !== prev_map) {
    // A new level, or the same one reloaded after a disconnect
    Agent_PushEvent(
      "level: " + map + (cl.levelname !== "" ? ' "' + cl.levelname + '"' : ""),
    );
    prev_map = map;
    Agent_NavBuild(); // a reload of the same map may differ in skill
    Agent_EnemyReset();
  } else {
    const dh = st[STAT_HEALTH] - prev_stats[STAT_HEALTH];
    if (dh < 0) {
      Agent_PushEvent("hurt: " + dh + " hp (now " + st[STAT_HEALTH] + ")");
    }
    if (st[STAT_HEALTH] <= 0 && prev_stats[STAT_HEALTH] > 0) {
      Agent_PushEvent("died: press attack or jump to respawn");
    }
    if (st[STAT_MONSTERS] > prev_stats[STAT_MONSTERS]) {
      Agent_PushEvent(
        "kill: " + st[STAT_MONSTERS] + "/" + st[STAT_TOTALMONSTERS],
      );
    }
    if (st[STAT_SECRETS] > prev_stats[STAT_SECRETS]) {
      Agent_PushEvent(
        "secret: " + st[STAT_SECRETS] + "/" + st[STAT_TOTALSECRETS],
      );
    }
    const gained = cl.items & ~prev_items;
    if (gained & (IT_KEY1 | IT_KEY2)) {
      Agent_PushEvent("key: " + Agent_Keys(gained));
    }
  }

  if (cl.intermission !== 0 && prev_intermission === 0) {
    Agent_PushEvent("intermission: level done; press attack to continue");
  }
  prev_intermission = cl.intermission;

  for (let i = 0; i < 32; i++) prev_stats[i] = st[i];
  prev_items = cl.items;
  prev_valid = true;
}

// ATTACH AND CLOCK

/**
 * mode 'realtime' leaves the game running; 'lockstep' freezes it between
 * Agent_Step calls (main.js stops calling Host_Frame) and pins the frame time
 * to one tic, so each step tic is exactly 1/72 s of game time.
 */
export function Agent_Attach(mode = "realtime") {
  if (mode !== "realtime" && mode !== "lockstep") {
    throw new Error('mode must be "realtime" or "lockstep"');
  }

  Con_SetAgentHook(Agent_ConsoleHook);
  SCR_SetAgentHook(Agent_CenterHook);

  if (mode === "lockstep" && agent_mode !== "lockstep") {
    // Set the fields directly: Cvar_Set would save the archived
    // host_maxfps to localStorage, losing the player's value if the page
    // closes before detach
    for (const [name, value] of LOCKSTEP_CVARS) {
      const v = Cvar_FindVar(name);
      if (v === null) continue;
      saved_cvars.set(name, v.string);
      Agent_PinCvar(v, value);
    }
  } else if (mode === "realtime" && agent_mode === "lockstep") {
    Agent_RestoreCvars();
  }

  agent_mode = mode;
  IN_SetAgentDriven(true);
  return agent_mode;
}

function Agent_PinCvar(v, value) {
  v.string = value;
  v.value = Number.parseFloat(value) || 0;
}

function Agent_RestoreCvars() {
  for (const [name, value] of saved_cvars) {
    const v = Cvar_FindVar(name);
    if (v !== null) Agent_PinCvar(v, value);
  }

  saved_cvars.clear();
}

export function Agent_Detach() {
  Agent_ReleaseButtons();
  if (agent_mode === "lockstep") Agent_RestoreCvars();
  Con_SetAgentHook(null);
  SCR_SetAgentHook(null);
  agent_mode = "off";
  IN_SetAgentDriven(false);
  con_partial = "";
}

export function Agent_Mode() {
  return agent_mode;
}

// Tics stepped in lockstep since the first attach (map loads included). A
// virtual clock built on it (server/agent_mcp.ts) advances exactly with the
// game.
export function Agent_Tics() {
  return agent_tics;
}

// main.js skips its own Host_Frame while this is true
export function Agent_Lockstep() {
  return agent_mode === "lockstep";
}

function Agent_Ready() {
  return cls.state === ca_connected && cls.signon === SIGNONS &&
    cl.worldmodel !== null;
}

// One lockstep tic. The extra microsecond keeps the frame above
// _Host_FilterTime's host_maxfps gate; host_framerate makes the game time
// exactly one tic regardless.
function Agent_Tic() {
  Host_Frame(AGENT_TIC + 1e-6);
  agent_tics++;
  Agent_StatEvents();
}

// Let promises and fetches (map loads) settle. A MessageChannel task is not
// throttled in background tabs the way setTimeout is.
let yield_channel = null;
const yield_waiting = []; // one resolver per posted message, in order
function Agent_Yield() {
  if (typeof MessageChannel === "undefined") {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  if (yield_channel === null) {
    yield_channel = new MessageChannel();
    yield_channel.port1.onmessage = () => {
      const resolve = yield_waiting.shift();
      if (resolve !== undefined) resolve();
    };
  }

  return new Promise((resolve) => {
    yield_waiting.push(resolve);
    yield_channel.port2.postMessage(0);
  });
}

// The async calls run one at a time, in call order, so two never step the
// game together (which would break "exactly N tics")
let agent_queue = Promise.resolve();
export function Agent_Serial(fn) {
  const run = agent_queue.then(fn, fn);
  agent_queue = run.catch(() => {});
  return run;
}

// Longest wait in lockstep, in tics: a load that fails (a Host_Error while
// spawning) gives up after this, not after timeout_ms of frames run as fast
// as they go, which headless is hundreds of thousands of tics
const AGENT_WAIT_TICS = 72 * 120;

// Runs frames (lockstep) or waits (realtime) until done() is true, letting
// fetches settle between frames. Returns done().
async function Agent_WaitFor(done, timeout_ms = 15000) {
  const start = performance.now();
  let tics = 0;
  while (
    done() === false && performance.now() - start < timeout_ms &&
    tics < AGENT_WAIT_TICS
  ) {
    if (agent_mode === "lockstep") {
      Agent_Tic();
      tics++;
    }
    await Agent_Yield();
    if (agent_mode !== "lockstep") {
      await new Promise((r) => setTimeout(r, 1000 / 72));
    }
  }

  return done();
}

// Wait until a connection or map load in progress has finished
function Agent_Settle(timeout_ms = 15000) {
  return Agent_WaitFor(() => Agent_Loading() === false, timeout_ms);
}

// True while a connection or map load is in progress
function Agent_Loading() {
  if (cls.state === ca_connected && cls.signon !== SIGNONS) return true;
  return cls.state !== ca_connected && sv.active === true;
}

// ACTIONS

function Agent_SetButtons(names) {
  for (const name of held_buttons) {
    if (names.has(name)) continue;
    Cmd_ExecuteString(
      "-" + AGENT_BUTTONS[name] + " " + AGENT_KEYNUM,
      src_command,
    );
    held_buttons.delete(name);
  }

  for (const name of names) {
    if (held_buttons.has(name)) continue;
    Cmd_ExecuteString(
      "+" + AGENT_BUTTONS[name] + " " + AGENT_KEYNUM,
      src_command,
    );
    held_buttons.add(name);
  }
}

function Agent_ReleaseButtons() {
  Agent_SetButtons(new Set());
}

// Parses 'forward,attack' or [ 'forward', 'attack' ] into a set of names
function Agent_ParseButtons(buttons) {
  const names = new Set();
  if (buttons === undefined || buttons === null || buttons === "") return names;
  const list = Array.isArray(buttons) ?
    buttons :
    String(buttons).split(/[\s,+]+/);
  for (const raw of list) {
    const name = String(raw).trim().toLowerCase();
    if (name === "") continue;
    if (Object.hasOwn(AGENT_BUTTONS, name) === false) {
      throw new Error(
        'unknown button "' + name + '" (expected ' +
          Object.keys(AGENT_BUTTONS).join(", ") + ")",
      );
    }
    names.add(name);
  }

  return names;
}

function Agent_ApplyLook(action) {
  if (typeof action.yaw === "number" && Number.isFinite(action.yaw)) {
    cl.viewangles[YAW] = Agent_AngleMod(cl.viewangles[YAW] + action.yaw);
  }
  if (typeof action.pitch === "number" && Number.isFinite(action.pitch)) {
    cl.viewangles[PITCH] += action.pitch;
    CL_ClampPitch();
  }

  if (typeof action.face === "number" && Number.isFinite(action.face)) {
    cl.viewangles[YAW] = Agent_AngleMod(action.face);
  }
}

function Agent_AngleMod(a) {
  a %= 360;
  return a < 0 ? a + 360 : a;
}

/**
 * action: { buttons: 'forward,attack', yaw: deg (+ turns left), pitch: deg
 * (+ looks down), face: absolute yaw, impulse: n }. The buttons are held for
 * `tics` tics (1/72 s each) and released after. Look changes apply at once.
 * Returns the observation text (with the events since the last observation).
 */
export function Agent_Step(action = {}, tics = 1, opts = {}) {
  return Agent_Serial(() => Agent_StepNow(action, tics, opts));
}

async function Agent_StepNow(action, tics, opts) {
  if (agent_mode === "off") Agent_Attach("realtime");
  tics = Math.max(0, Math.min(72 * 60, Math.floor(Number(tics) || 0)));

  if (Agent_Loading()) await Agent_Settle();

  const names = Agent_ParseButtons(action.buttons);
  Agent_ApplyLook(action);
  if (
    Number.isInteger(action.impulse) && action.impulse > 0 &&
    action.impulse < 256
  ) {
    Cmd_ExecuteString("impulse " + action.impulse, src_command);
  }
  Agent_SetButtons(names);

  if (agent_mode === "lockstep") {
    for (let i = 0; i < tics; i++) {
      Agent_Tic();
      // A level change mid-step: finish loading before counting on
      if (Agent_Loading()) await Agent_Settle();
    }
  } else {
    const end = cl.time + tics * AGENT_TIC;
    const start = performance.now();
    while (
      cl.time < end && performance.now() - start < tics * 1000 / 72 + 1000
    ) {
      await new Promise((r) => setTimeout(r, 1000 / 72));
      Agent_StatEvents();
    }
  }

  if (action.hold !== true) Agent_ReleaseButtons();
  return Agent_Observe(opts);
}

// NAVIGATION AND MACROS

let nav_graph = null; // src/nav.js walk graph of the current level, or null

// Builds the walk graph for the level just loaded (from Agent_StatEvents'
// level event, so only games with an agent attached pay for it), with the
// entity lump filtered for the game's skill and mode as the server did
function Agent_NavBuild() {
  nav_graph = null;
  goto_avoid.length = 0;
  goto_avoid_links.length = 0;
  goto_base_cost = null;
  const m = cl.worldmodel;
  if (m === null || m.hulls === undefined || m.entities === undefined) return;
  try {
    nav_graph = Nav_Build(m, {
      skill: skill.value | 0,
      deathmatch: deathmatch.value !== 0,
    });
  } catch (e) {
    Agent_PushEvent(
      "nav: no graph for this level (" +
        (e instanceof Error ? e.message : String(e)) + ")",
    );
  }
}

// The current level's walk graph (src/nav.js), or null
export function Agent_NavGraph() {
  return nav_graph;
}

export const GOTO_MAX_TICS = 72 * 120;
export const GOTO_DEFAULT_TICS = 72 * 30;
const GOTO_RADIUS = 20; // a waypoint counts as reached within this, flat
const GOTO_STUCK_TICS = 36; // no progress for this long is stuck
const GOTO_STUCK_DIST = 8;
const GOTO_DOOR_WAIT = 108; // extra patience on door and plat links

// Path being followed (Golden Rule #4: grown, never shrunk)
let goto_pos = new Float32Array(0);
let goto_flags = new Uint16Array(0);
let goto_node = new Int32Array(0);
let goto_count = 0;
let goto_k = 0; // waypoint being walked to
const goto_goal = new Float32Array(3);
const goto_from = new Float32Array(3);
const goto_me = new Float32Array(3);
const goto_mins = new Float32Array(3);
const goto_maxs = new Float32Array(3);
let goto_hasbox = false;

// Holds or releases one agent button, issuing the command only on a change
function Agent_HoldButton(name, on) {
  if (held_buttons.has(name) === on) return;
  Cmd_ExecuteString(
    (on ? "+" : "-") + AGENT_BUTTONS[name] + " " + AGENT_KEYNUM,
    src_command,
  );
  if (on) held_buttons.add(name);
  else held_buttons.delete(name);
}

// The player's origin: the server's when it is local (the client's copy
// lags a frame), else the client entity's
function Agent_PlayerOrigin(out) {
  const ed = Agent_Edict(1);
  const src = ed !== null && sv.active === true && cl.viewentity === 1 ?
    ed.v.origin :
    cl_entities[cl.viewentity].origin;
  out[0] = src[0];
  out[1] = src[1];
  out[2] = src[2];
}

/**
 * Sets goto_goal (and goto_mins/maxs for a brush or trigger) from an entity
 * number or a point. Returns a short label, or throws.
 */
function Agent_GotoTarget(target) {
  goto_hasbox = false;
  const list = Array.isArray(target) || ArrayBuffer.isView(target);
  if (list || (target !== null && typeof target === "object")) {
    const v = list ? Array.from(target) : [target.x, target.y, target.z];
    if (
      v.length !== 3 ||
      v.every((x) => typeof x === "number" && Number.isFinite(x)) === false
    ) {
      throw new Error("goto: a point is [ x, y, z ] (or { x, y, z })");
    }
    goto_goal[0] = v[0];
    goto_goal[1] = v[1];
    goto_goal[2] = v[2];
    return Math.round(v[0]) + "," + Math.round(v[1]) + "," + Math.round(v[2]);
  }

  if (Number.isInteger(target) === false || target <= 0) {
    throw new Error("goto: target must be an entity id (#N) or [ x, y, z ]");
  }
  if (Agent_GotoEntityPos(target) === false) {
    throw new Error("goto: no entity #" + target);
  }
  return "#" + target;
}

// Updates goto_goal from entity num; false if it is gone
function Agent_GotoEntityPos(num) {
  const ed = Agent_Edict(num);
  if (ed !== null) {
    const model = PR_GetString(ed.v.model);
    if (model === "" || model.charCodeAt(0) === 42) {
      // A brush entity or a trigger (InitTrigger clears the model):
      // aim at its centre, arrive on touching its box
      for (let k = 0; k < 3; k++) {
        goto_mins[k] = ed.v.absmin[k];
        goto_maxs[k] = ed.v.absmax[k];
        goto_goal[k] = (ed.v.absmin[k] + ed.v.absmax[k]) / 2;
      }

      goto_hasbox = goto_maxs[0] > goto_mins[0];
      return goto_hasbox === true || model !== "";
    }

    goto_goal[0] = ed.v.origin[0];
    goto_goal[1] = ed.v.origin[1];
    goto_goal[2] = ed.v.origin[2];
    return true;
  }

  if (sv.active === true) return false;
  const ent = cl_entities[num];
  if (ent === undefined || ent === null || ent.model === null) return false;
  goto_goal[0] = ent.origin[0];
  goto_goal[1] = ent.origin[1];
  goto_goal[2] = ent.origin[2];
  return true;
}

// An item picked up (or a monster gibbed) frees its edict or clears its model
// (a trigger has no model to lose, so only targets that had one count)
function Agent_GotoTargetGone(num, had_model) {
  if (num <= 0 || sv.active !== true) return false;
  const ed = Agent_Edict(num);
  return ed === null || (had_model && PR_GetString(ed.v.model) === "");
}

function Agent_GotoArrived() {
  const p = goto_me;
  if (goto_hasbox === true) {
    // player box (VEC_HULL_MIN/MAX) touching the target's
    return p[0] - 16 <= goto_maxs[0] && p[0] + 16 >= goto_mins[0] &&
      p[1] - 16 <= goto_maxs[1] && p[1] + 16 >= goto_mins[1] &&
      p[2] - 24 <= goto_maxs[2] && p[2] + 32 >= goto_mins[2];
  }

  const dz = goto_goal[2] - p[2];
  return Math.hypot(goto_goal[0] - p[0], goto_goal[1] - p[1]) < 28 &&
    dz > -56 && dz < 40;
}

// Plans from the player to goto_goal into the goto_* buffers. False if the
// graph has no path; with no graph, an empty path (walk straight at it).
function Agent_GotoPlan() {
  goto_count = 0;
  goto_k = 0;
  if (nav_graph === null) return true;
  const path = Nav_FindPath(nav_graph, goto_me, goto_goal);
  if (path === null) return false;
  const n = path.count;
  if (goto_node.length < n) {
    const size = Math.max(n, goto_node.length * 2, 64);
    goto_pos = new Float32Array(size * 3);
    goto_flags = new Uint16Array(size);
    goto_node = new Int32Array(size);
  }

  goto_pos.set(path.pos.subarray(0, n * 3));
  goto_flags.set(path.flags.subarray(0, n));
  goto_node.set(path.node.subarray(0, n));
  goto_count = n;
  return true;
}

// True once the player has reached or passed waypoint k, coming from the
// previous one (or from where the walk started)
function Agent_GotoPassed(k) {
  const wx = goto_pos[k * 3],
    wy = goto_pos[k * 3 + 1],
    wz = goto_pos[k * 3 + 2];
  const dx = wx - goto_me[0], dy = wy - goto_me[1];
  const dz = wz - goto_me[2];
  if (dz > 40 || dz < -64) return false; // a plat or a drop: not there yet
  if (dx * dx + dy * dy < GOTO_RADIUS * GOTO_RADIUS) return true;
  const px = k > 0 ? goto_pos[k * 3 - 3] : goto_from[0];
  const py = k > 0 ? goto_pos[k * 3 - 2] : goto_from[1];
  const sx = wx - px, sy = wy - py;
  const len2 = sx * sx + sy * sy;
  if (len2 < 1) return false;
  return ((goto_me[0] - px) * sx + (goto_me[1] - py) * sy) / len2 >= 1;
}

// The graph link into waypoint k (link_to and flags both match), or -1
function Agent_GotoLink(k) {
  const g = nav_graph;
  if (g === null || k <= 0 || k >= goto_count) return -1;
  const a = goto_node[k - 1], b = goto_node[k];
  for (let l = g.link_start[a]; l < g.link_start[a + 1]; l++) {
    if (g.link_to[l] === b && g.link_flags[l] === goto_flags[k]) return l;
  }
  return -1;
}

// The graph entity on the link into waypoint k (link_to and flags both
// match: two nodes can share a walk and a jump link), else the node's own
function Agent_GotoLinkEnt(k) {
  const g = nav_graph;
  const l = Agent_GotoLink(k);
  if (l < 0) return -1;
  if (g.link_ent[l] >= 0) return g.link_ent[l];
  const a = goto_node[k - 1], b = goto_node[k];
  if (g.node_ent[b] >= 0) return g.node_ent[b];
  return g.node_ent[a];
}

// The edict for a graph entity record: brush models by name, triggers
// (whose model InitTrigger cleared) by their box
function Agent_GraphEntEdict(rec) {
  if (sv.active !== true) return -1;
  const want = rec.model > 0 ? "*" + rec.model : null;
  let by_box = -1;
  for (let i = 1; i < sv.num_edicts; i++) {
    const ed = Agent_Edict(i);
    if (ed === null) continue;
    const model = PR_GetString(ed.v.model);
    if (want !== null && model === want) return i;
    // SV_LinkEdict widens absmin/absmax by 1
    if (
      by_box < 0 && model === "" && rec.mins !== null && rec.maxs !== null &&
      Math.abs(ed.v.absmin[0] + 1 - rec.mins[0]) < 2 &&
      Math.abs(ed.v.absmin[1] + 1 - rec.mins[1]) < 2 &&
      Math.abs(ed.v.absmax[0] - 1 - rec.maxs[0]) < 2 &&
      Math.abs(ed.v.absmax[1] - 1 - rec.maxs[1]) < 2
    ) by_box = i;
  }

  return by_box;
}

/**
 * Entities a goto was blocked by: their links cost GOTO_AVOID_COST more, so
 * the next goto takes another way if there is one, until the entity moves
 * (a door opening) or the level changes.
 */
const GOTO_AVOID_COST = 1000000;
const goto_avoid = []; // { e: graph entity, num: edict or -1, x, y, z: its absmin then }
const goto_avoid_links = []; // graph links a goto was blocked on with nothing to name
let goto_base_cost = null; // nav_graph.link_cost as built

function Agent_GotoAvoid(e, num) {
  for (const a of goto_avoid) if (a.e === e) return;
  const ed = num > 0 ? Agent_Edict(num) : null;
  goto_avoid.push({
    e,
    num: ed !== null ? num : -1,
    x: ed !== null ? ed.v.absmin[0] : 0,
    y: ed !== null ? ed.v.absmin[1] : 0,
    z: ed !== null ? ed.v.absmin[2] : 0,
  });
}

// Sets the graph's link costs: as built, plus GOTO_AVOID_COST on the links
// into what is avoided (the links Agent_GotoLinkEnt would blame it for)
function Agent_GotoApplyAvoid() {
  const g = nav_graph;
  if (goto_base_cost === null) {
    if (goto_avoid.length === 0 && goto_avoid_links.length === 0) return;
    goto_base_cost = g.link_cost.slice();
  }

  g.link_cost.set(goto_base_cost);
  for (const l of goto_avoid_links) g.link_cost[l] += GOTO_AVOID_COST;
  if (goto_avoid.length === 0) return;
  for (let l = 0; l < g.link_ent.length; l++) {
    for (const a of goto_avoid) {
      if (g.link_ent[l] === a.e || g.node_ent[g.link_to[l]] === a.e) {
        g.link_cost[l] += GOTO_AVOID_COST;
        break;
      }
    }
  }
}

// Stops avoiding entities that have moved since they blocked a goto (the
// costs follow at the next Agent_GotoApplyAvoid)
function Agent_GotoAvoidUpdate() {
  for (let i = goto_avoid.length - 1; i >= 0; i--) {
    const a = goto_avoid[i];
    if (a.num <= 0) continue; // no edict to watch: avoided until the level changes
    const ed = Agent_Edict(a.num);
    if (
      ed === null ||
      Math.abs(ed.v.absmin[0] - a.x) + Math.abs(ed.v.absmin[1] - a.y) +
            Math.abs(ed.v.absmin[2] - a.z) > 2
    ) {
      goto_avoid.splice(i, 1);
    }
  }
}

// A live monster whose box is within 8 units of the player's, or 0
function Agent_GotoMonsterNear() {
  if (sv.active !== true) return 0;
  const p = goto_me;
  for (let i = 1; i < sv.num_edicts; i++) {
    const ed = Agent_Edict(i);
    if (ed === null || (ed.v.flags & FL_MONSTER) === 0 || ed.v.health <= 0) {
      continue;
    }
    if (
      p[0] - 24 <= ed.v.absmax[0] && p[0] + 24 >= ed.v.absmin[0] &&
      p[1] - 24 <= ed.v.absmax[1] && p[1] + 24 >= ed.v.absmin[1] &&
      p[2] - 32 <= ed.v.absmax[2] && p[2] + 40 >= ed.v.absmin[2]
    ) return i;
  }

  return 0;
}

// "blocked by #id door (needs the gold key)" from the graph's own data
function Agent_GotoBlocked(k) {
  const at = " at " + Math.round(goto_me[0]) + "," + Math.round(goto_me[1]) +
    "," + Math.round(goto_me[2]);
  // A monster in the way (one that doesn't attack: notarget, or asleep)
  const m = Agent_GotoMonsterNear();
  if (m > 0) {
    const ent = cl_entities[m];
    const kind = ent !== undefined && ent.model !== null ?
      Agent_ModelKind(ent) :
      null;
    return "blocked by #" + m + " " + (kind !== null && kind !== "" ?
      kind :
      PR_GetString(Agent_Edict(m).v.classname)) +
      at + " (kill it, or wait for it to move)";
  }

  const e = Agent_GotoLinkEnt(k);
  if (e < 0) {
    // Nothing to name: avoid the link itself from now on
    const l = Agent_GotoLink(k);
    if (l >= 0 && goto_avoid_links.includes(l) === false) {
      goto_avoid_links.push(l);
    }
    Agent_GotoApplyAvoid();
    return "blocked" + at +
      " (the next goto tries another way; or jump, or step and look around)";
  }

  const rec = nav_graph.ents[e];
  const num = Agent_GraphEntEdict(rec);
  Agent_GotoAvoid(e, num);
  Agent_GotoApplyAvoid();
  const kind = BRUSH_KINDS[rec.classname] ?? TRIGGER_KINDS[rec.classname] ??
    rec.classname;
  let s = "blocked by " + (num > 0 ? "#" + num + " " : "") + kind + at;
  switch (rec.opens) {
    case "gold_key":
      return s + " (needs the gold key)";
    case "silver_key":
      return s + " (needs the silver key)";
    case "shoot":
      return s + " (shoot it)";
    case "touch":
      return s + " (walk into it; it may be opening)";
    case "trigger":
    case "trigger_or_shoot": {
      const parts = [];
      for (const a of rec.activators) {
        if (a.ent < 0) continue;
        const an = Agent_GraphEntEdict(nav_graph.ents[a.ent]);
        parts.push(
          (BRUSH_KINDS[a.classname] ?? a.classname) + (an > 0 ? " #" + an : ""),
        );
      }

      s += " (opened by " +
        (parts.length > 0 ? parts.join(" or ") : "a trigger elsewhere");
      return s + (rec.opens === "trigger_or_shoot" ? ", or shoot it)" : ")");
    }

    default:
      if (rec.classname === "func_plat") {
        return s + " (stand on the lift and wait)";
      }
      return s;
  }
}

/**
 * Walks to an entity (#id, as in observations) or a point along the level's
 * walk graph (src/nav.js), one lockstep tic at a time. opts: { max_tics (30 s),
 * stop_on_damage (true), stop_on_enemy (true), ents, map }. The first line of
 * the result says how it ended: arrived, blocked (with what to try), took
 * damage, new enemy (a monster came into sight: Agent_EnemyScan), died, level
 * changed, no path, or timeout. The observation follows.
 */
export function Agent_Goto(target, opts = {}) {
  return Agent_Serial(() => Agent_GotoNow(target, opts));
}

async function Agent_GotoNow(target, opts) {
  if (agent_mode !== "lockstep") {
    throw new Error('goto needs lockstep mode: attach("lockstep") first');
  }
  if (Agent_Loading()) await Agent_Settle();
  if (Agent_Ready() === false) throw new Error("goto: no game running");

  const max_tics = Math.max(
    1,
    Math.min(
      GOTO_MAX_TICS,
      Math.floor(Number(opts.max_tics ?? GOTO_DEFAULT_TICS) || 0),
    ),
  );
  const stop_on_damage = opts.stop_on_damage !== false;
  const stop_on_enemy = opts.stop_on_enemy !== false;
  const truth = opts.truth !== false;
  const label = Agent_GotoTarget(target);
  const target_num = typeof target === "number" ? target : 0;
  const target_ed = target_num > 0 ? Agent_Edict(target_num) : null;
  const had_model = target_ed !== null &&
    PR_GetString(target_ed.v.model) !== "";
  const map = Agent_MapName();
  const finish = (why, tics) =>
    "goto " + label + ": " + why + " (" + tics + " tics)\n" +
    Agent_Observe(opts);

  Agent_PlayerOrigin(goto_me);
  goto_from.set(goto_me);
  if (nav_graph !== null) {
    Agent_GotoAvoidUpdate();
    Agent_GotoApplyAvoid();
  }

  if (Agent_GotoArrived()) return finish("arrived", 0);
  // Monsters already in sight aren't news
  if (stop_on_enemy) Agent_EnemyScan(true, target_num, truth);

  if (Agent_GotoPlan() === false) {
    return finish("no path from here (try another target)", 0);
  }

  let health = cl.stats[STAT_HEALTH];
  let face = cl.faceanimtime; // V_ParseDamage moves it: hurt, not megahealth wearing off
  const planned = new Float32Array(goto_goal); // once per call: the goal the path was planned to
  let best = 0, best_k = -1, still_tics = 0; // closest yet to the waypoint, and for how long not closer
  let stuck = 0, stuck_x = 0, stuck_y = 0; // escalation, and where it began
  let replans = 0; // stuck replans this call: a loop of them is blocked too
  let jump_tic = -1;
  let why = "timeout";
  let tics = 0;

  try {
    for (; tics < max_tics;) {
      // Steer toward the current waypoint, or the goal after the last
      while (goto_k < goto_count && Agent_GotoPassed(goto_k)) goto_k++;

      const final = goto_k >= goto_count;
      const wx = final ? goto_goal[0] : goto_pos[goto_k * 3];
      const wy = final ? goto_goal[1] : goto_pos[goto_k * 3 + 1];
      const wz = final ? goto_goal[2] : goto_pos[goto_k * 3 + 2];
      const flags = final ? 0 : goto_flags[goto_k];
      const dx = wx - goto_me[0], dy = wy - goto_me[1], dz = wz - goto_me[2];
      const flat = Math.hypot(dx, dy);
      if (flat > 1) {
        cl.viewangles[YAW] = Agent_AngleMod(Math.atan2(dy, dx) * 180 / Math.PI);
      }
      // In water, swim at it (Quake pitch is positive looking down);
      // on land, look level
      cl.viewangles[PITCH] = cl.inwater ?
        Math.max(-70, Math.min(70, -Math.atan2(dz, flat) * 180 / Math.PI)) :
        0;

      // Riding a plat up: stand still until it arrives
      const riding = (flags & NAV_LINK_PLAT) !== 0 && dz > 24 && flat < 48;
      Agent_HoldButton("forward", riding === false);
      // Swim links hold jump (swim up); jump links tap it on the ground
      let jump = (flags & NAV_LINK_SWIM) !== 0;
      if (jump_tic >= 0 && tics === jump_tic) jump = true;
      else if (
        (flags & NAV_LINK_JUMP) !== 0 && cl.onground && flat < 64 &&
        held_buttons.has("jump") === false
      ) jump = true;
      Agent_HoldButton("jump", jump);

      Agent_Tic();
      tics++;

      // Interrupts, before the path is touched again
      if (Agent_Loading() || Agent_MapName() !== map) {
        if (Agent_Loading()) await Agent_Settle();
        why = "level changed";
        break;
      }

      const hp = cl.stats[STAT_HEALTH];
      if (hp <= 0) {
        why = "died";
        break;
      }
      if (cl.intermission !== 0) {
        why = "level done (intermission)";
        break;
      }
      const hit = cl.faceanimtime !== face;
      face = cl.faceanimtime;
      if (stop_on_damage && hit && hp < health) {
        why = "took damage (" + (hp - health) + " hp), stopped";
        break;
      }
      health = hp;
      if (stop_on_enemy) {
        const foe = Agent_EnemyScan(false, target_num, truth);
        if (foe !== 0) {
          why = Agent_EnemyReason(foe, truth);
          break;
        }
      }

      Agent_PlayerOrigin(goto_me);
      if (goto_avoid.length > 0) Agent_GotoAvoidUpdate(); // a door opening while we walk counts
      if (target_num > 0) {
        if (Agent_GotoTargetGone(target_num, had_model)) {
          why = "arrived (#" + target_num + " is gone: picked up or killed)";
          break;
        }
        Agent_GotoEntityPos(target_num);
        // A moving target: replan once it has gone a fair way
        if (
          Math.hypot(
            goto_goal[0] - planned[0],
            goto_goal[1] - planned[1],
            goto_goal[2] - planned[2],
          ) > 96
        ) {
          planned.set(goto_goal);
          goto_from.set(goto_me);
          if (Agent_GotoPlan() === false) {
            why = "no path to where #" + target_num + " went";
            break;
          }
        }
      }

      if (Agent_GotoArrived()) {
        why = "arrived";
        break;
      }

      // Walking on a door that isn't where the map put it (open, or a
      // bridge slid away): the player fell below it
      if (
        (flags & NAV_LINK_MOVER) !== 0 && (flags & NAV_LINK_PLAT) === 0 &&
        wz - goto_me[2] > 48
      ) {
        why = Agent_GotoBlocked(goto_k);
        break;
      }

      // Stuck: not getting closer to the waypoint (bobbing in water or
      // sliding along a wall is not progress), unless riding a plat
      const d = Math.hypot(wx - goto_me[0], wy - goto_me[1], wz - goto_me[2]);
      if (goto_k !== best_k || d < best - GOTO_STUCK_DIST || riding) {
        if (goto_k !== best_k || d < best) best = d;
        best_k = goto_k;
        still_tics = 0;
        // Got clear of where it stuck: start the escalation over
        if (
          stuck > 0 &&
          Math.hypot(goto_me[0] - stuck_x, goto_me[1] - stuck_y) > 64
        ) stuck = 0;
      } else if (
        ++still_tics >=
          GOTO_STUCK_TICS +
            ((flags & (NAV_LINK_DOOR | NAV_LINK_PLAT | NAV_LINK_MOVER)) !== 0 &&
                stuck === 0 ?
              GOTO_DOOR_WAIT :
              0)
      ) {
        still_tics = 0;
        if (stuck++ === 0) {
          stuck_x = goto_me[0];
          stuck_y = goto_me[1];
        }
        if (stuck === 1) {
          jump_tic = tics; // hop: a lip or a step the walk caught on
        } else if (stuck === 2 && ++replans <= 3) {
          goto_from.set(goto_me);
          if (Agent_GotoPlan() === false) {
            why = "no path from here (try another target)";
            break;
          }
        } else {
          why = Agent_GotoBlocked(Math.min(goto_k, goto_count - 1));
          break;
        }
      }
    }
  } finally {
    Agent_ReleaseButtons();
  }

  return finish(why, tics);
}

// NEW-ENEMY INTERRUPT

// A monster counts as announced once a macro has seen it (in sight when the
// macro began, or reported when it came into sight), so one that ducks in and
// out of view at a corner stops only one macro. Cleared on each level event.
const enemy_known = new Uint8Array(MAX_EDICTS);
/** Model name -> whether its kind is a monster (cleared with enemy_known). */
const enemy_model = new Map();
const enemy_eye = new Float32Array(3);
const enemy_at = new Float32Array(3);
const enemy_best_at = new Float32Array(3); // centre of Agent_EnemyScan's result
const SOLID_BSP = 4; // server.h
let enemy_new = 0; // how many the last Agent_EnemyScan announced

function Agent_EnemyReset() {
  enemy_known.fill(0);
  enemy_model.clear();
}

function Agent_IsMonsterModel(ent) {
  const name = ent.model.name;
  let is = enemy_model.get(name);
  if (is === undefined) {
    const kind = Agent_ModelKind(ent);
    is = kind !== null && MONSTER_KINDS.has(kind);
    enemy_model.set(name, is);
  }
  return is;
}

// Whether the segment from a to b crosses the box of a brush entity in the
// latest update (a closed door, a lift, a func_wall). Agent_LineOfSight traces
// only the world. With a local server, brush entities that aren't solid
// (func_illusionary) don't block. A box holding either end doesn't block, so
// a player standing inside a door's or lift's box sees through it.
function Agent_BrushBlocks(a, b, truth) {
  for (let i = 1; i < cl.num_entities; i++) {
    const ent = cl_entities[i];
    if (ent === undefined || ent === null || ent.model === null) continue;
    if (ent.msgtime !== cl.mtime[0]) continue;
    const m = ent.model;
    if (m.name.charCodeAt(0) !== 42) continue; // '*': brush model
    if (truth) {
      const ed = Agent_Edict(i);
      if (ed !== null && ed.v.solid !== SOLID_BSP) continue;
    }
    let t0 = 0, t1 = 1, inside_a = true, inside_b = true;
    for (let k = 0; k < 3 && t0 <= t1; k++) {
      const lo = ent.origin[k] + m.mins[k], hi = ent.origin[k] + m.maxs[k];
      if (a[k] < lo || a[k] > hi) inside_a = false;
      if (b[k] < lo || b[k] > hi) inside_b = false;
      const d = b[k] - a[k];
      if (Math.abs(d) < 1e-6) {
        if (a[k] < lo || a[k] > hi) t1 = -1; // parallel and outside the slab
        continue;
      }
      let n = (lo - a[k]) / d, f = (hi - a[k]) / d;
      if (n > f) {
        const s = n;
        n = f;
        f = s;
      }
      if (n > t0) t0 = n;
      if (f < t1) t1 = f;
    }
    if (t0 <= t1 && inside_a === false && inside_b === false) return true;
  }
  return false;
}

/**
 * Scans for live monsters in sight (in the client's latest update, with no
 * world or brush entity between your eye and their centre) that no macro has
 * announced yet, and marks them announced (enemy_new counts them). Returns
 * the nearest such id, or 0.
 * With mark_only, just marks the ones in sight (a macro's start). skip is an
 * entity never reported (the macro's own target), or 0. With a local server
 * and truth, corpses are skipped; without one a corpse looks like a monster.
 */
function Agent_EnemyScan(mark_only, skip, truth) {
  const me = cl_entities[cl.viewentity];
  if (me === undefined || me === null) return 0;
  enemy_eye[0] = me.origin[0];
  enemy_eye[1] = me.origin[1];
  enemy_eye[2] = me.origin[2] + 22; // DEFAULT_VIEWHEIGHT, as Agent_Entities
  const use_truth = truth && sv.active === true;
  let best = 0, best_d = Infinity;
  enemy_new = 0;
  const n = Math.min(cl.num_entities, MAX_EDICTS);
  for (let i = 1; i < n; i++) {
    if (i === cl.viewentity || i === skip || enemy_known[i] !== 0) continue;
    const ent = cl_entities[i];
    if (ent === undefined || ent === null || ent.model === null) continue;
    if (ent.msgtime !== cl.mtime[0]) continue; // not in view
    if (Agent_IsMonsterModel(ent) === false) continue;
    if (use_truth) {
      const ed = Agent_Edict(i);
      if (ed !== null && ed.v.health <= 0) continue; // corpse
    }
    const m = ent.model;
    for (let k = 0; k < 3; k++) {
      enemy_at[k] = ent.origin[k] + (m.mins[k] + m.maxs[k]) / 2;
    }
    if (Agent_LineOfSight(enemy_eye, enemy_at) === false) continue;
    if (Agent_BrushBlocks(enemy_eye, enemy_at, use_truth)) continue;
    enemy_known[i] = 1;
    if (mark_only) continue;
    enemy_new++;
    const d = Math.hypot(
      enemy_at[0] - enemy_eye[0],
      enemy_at[1] - enemy_eye[1],
      enemy_at[2] - enemy_eye[2],
    );
    if (d < best_d) {
      best_d = d;
      best = i;
      enemy_best_at.set(enemy_at);
    }
  }
  return best;
}

// The first line's reason for a new-enemy stop: the entity line of #num
function Agent_EnemyReason(num, truth) {
  los_start.set(enemy_eye); // Agent_Describe measures from los_start
  const ed = truth && sv.active === true ? Agent_Edict(num) : null;
  const hp = ed !== null && (ed.v.flags & FL_MONSTER) !== 0 ?
    Math.round(ed.v.health) :
    null;
  return "new enemy " +
    Agent_EntityLine(
      Agent_Describe(
        num,
        Agent_ModelKind(cl_entities[num]),
        enemy_best_at,
        hp,
        true,
      ),
    ) +
    (enemy_new > 1 ? " (+" + (enemy_new - 1) + " more)" : "") +
    ", stopped";
}

// TURN_TO AND ATTACK

export const ATTACK_MAX_TICS = 72 * 60;
export const ATTACK_DEFAULT_TICS = 72 * 10;
const ATTACK_LOST_TICS = 36; // out of sight this long ends an attack
const ATTACK_AXE_REACH = 80; // the axe's trace is 64 units from the eye

const aim_eye = new Float32Array(3);
const aim_at = new Float32Array(3);

// The centre of entity num as the client sees it (aim_at); false if the
// client has no model for it
function Agent_AimPoint(num) {
  const ent = cl_entities[num];
  if (ent === undefined || ent === null || ent.model === null) return false;
  // origin plus the middle of the model's bounds (a brush entity's too)
  const m = ent.model;
  for (let k = 0; k < 3; k++) {
    aim_at[k] = ent.origin[k] + (m.mins[k] + m.maxs[k]) / 2;
  }
  return true;
}

// Points the view at aim_at from the eye; returns the distance
function Agent_AimView() {
  Agent_PlayerOrigin(aim_eye);
  aim_eye[2] += 22; // DEFAULT_VIEWHEIGHT, as Agent_Entities
  const dx = aim_at[0] - aim_eye[0];
  const dy = aim_at[1] - aim_eye[1];
  const dz = aim_at[2] - aim_eye[2];
  const flat = Math.hypot(dx, dy);
  if (flat > 0.5) {
    cl.viewangles[YAW] = Agent_AngleMod(Math.atan2(dy, dx) * 180 / Math.PI);
  }
  // Quake pitch is positive looking down
  cl.viewangles[PITCH] = -Math.atan2(dz, flat) * 180 / Math.PI;
  CL_ClampPitch();
  return Math.hypot(flat, dz);
}

/**
 * Faces entity #id (yaw and pitch at its centre) or { yaw } (absolute), at once,
 * and returns the observation without advancing the game: the new view goes
 * to the server with the next step. Look changes in this API are immediate
 * (step's yaw and face too), so there is nothing to close a loop on.
 */
export function Agent_TurnTo(target, opts = {}) {
  if (Agent_Ready() === false) throw new Error("turn_to: no game running");
  let label;
  if (Number.isInteger(target) && target > 0) {
    if (Agent_AimPoint(target) === false) {
      throw new Error("turn_to: no entity #" + target);
    }
    Agent_AimView();
    label = "#" + target;
  } else if (
    target !== null && typeof target === "object" &&
    typeof target.yaw === "number" && Number.isFinite(target.yaw)
  ) {
    cl.viewangles[YAW] = Agent_AngleMod(target.yaw);
    cl.viewangles[PITCH] = 0;
    label = "yaw " + Math.round(cl.viewangles[YAW]);
  } else {
    throw new Error("turn_to: target must be an entity id (#N) or { yaw }");
  }
  return "turn_to " + label + ": yaw " +
    Math.round(cl.viewangles[YAW]) + " pitch " +
    Math.round(cl.viewangles[PITCH]) + "\n" + Agent_Observe(opts);
}

/**
 * Aims at entity #id every tic and fires while it is in sight, until it dies
 * or one of the other endings (lockstep only). The first line of the result
 * says how it ended: killed, gone, out of sight, out of ammo, out of reach
 * (axe), new enemy (another monster came into sight), died, level changed,
 * level done, or timeout. opts: { max_tics (10 s), stop_on_enemy (true), ents,
 * map }. With a local server "killed" reads the monster's
 * health; without one, an entity that leaves the client's updates is
 * "gone". It doesn't move: goto first, or step between attacks.
 */
export function Agent_Attack(target, opts = {}) {
  return Agent_Serial(() => Agent_AttackNow(target, opts));
}

async function Agent_AttackNow(target, opts) {
  if (agent_mode !== "lockstep") {
    throw new Error('attack needs lockstep mode: attach("lockstep") first');
  }
  if (Agent_Loading()) await Agent_Settle();
  if (Agent_Ready() === false) throw new Error("attack: no game running");
  if (Number.isInteger(target) === false || target <= 0) {
    throw new Error("attack: target must be an entity id (#N)");
  }
  if (target === cl.viewentity || Agent_AimPoint(target) === false) {
    throw new Error("attack: no entity #" + target);
  }

  const max_tics = Math.max(
    1,
    Math.min(
      ATTACK_MAX_TICS,
      Math.floor(Number(opts.max_tics ?? ATTACK_DEFAULT_TICS) || 0),
    ),
  );
  const map = Agent_MapName();
  const stop_on_enemy = opts.stop_on_enemy !== false;
  const truth = opts.truth !== false;
  if (stop_on_enemy) Agent_EnemyScan(true, target, truth);
  const finish = (why, tics) =>
    "attack #" + target + ": " + why + " (" + tics + " tics)\n" +
    Agent_Observe(opts);

  let why = "timeout";
  let tics = 0;
  let unseen = 0;

  try {
    for (; tics < max_tics;) {
      // Server truth: dead (health gone, or the edict freed or gibbed)
      if (sv.active === true) {
        const ed = Agent_Edict(target);
        if (
          ed === null || PR_GetString(ed.v.model) === "" ||
          ((ed.v.flags & FL_MONSTER) !== 0 && ed.v.health <= 0)
        ) {
          why = "killed";
          break;
        }
      }
      // After the kill check, so a killing shot reads "killed"
      if (stop_on_enemy && tics > 0) {
        const foe = Agent_EnemyScan(false, target, truth);
        if (foe !== 0) {
          why = Agent_EnemyReason(foe, truth);
          break;
        }
      }
      const ent = cl_entities[target];
      if (
        ent === undefined || ent === null || ent.model === null ||
        ent.msgtime !== cl.mtime[0]
      ) {
        if (++unseen > ATTACK_LOST_TICS) {
          why = "gone (not in view)";
          break;
        }
        Agent_HoldButton("attack", false);
      } else {
        Agent_AimPoint(target);
        const dist = Agent_AimView();
        const visible = Agent_LineOfSight(aim_eye, aim_at);
        unseen = visible ? 0 : unseen + 1;
        if (unseen > ATTACK_LOST_TICS) {
          why = "out of sight";
          break;
        }

        if (Agent_HoldsAxe()) {
          if (dist > ATTACK_AXE_REACH) {
            why = "out of reach (axe only: get within " + ATTACK_AXE_REACH +
              " units)";
            break;
          }
        } else if (cl.stats[STAT_AMMO] <= 0) {
          why = "out of ammo";
          break;
        }
        Agent_HoldButton("attack", visible);
      }

      Agent_Tic();
      tics++;

      if (Agent_Loading() || Agent_MapName() !== map) {
        if (Agent_Loading()) await Agent_Settle();
        why = "level changed";
        break;
      }
      if (cl.stats[STAT_HEALTH] <= 0) {
        why = "died";
        break;
      }
      if (cl.intermission !== 0) {
        why = "level done (intermission)";
        break;
      }
    }
  } finally {
    Agent_ReleaseButtons();
  }

  return finish(why, tics);
}

const AGENT_LOAD_CMDS =
  /(^|[\s;])(map|changelevel|restart|load|connect|reconnect)(\s|;|$)/;

// True if console text starts a map load or connection
export function Agent_StartsLoad(text) {
  return AGENT_LOAD_CMDS.test(text);
}

/**
 * Runs console text (e.g. 'map e1m2' or 'god'), lets it take effect, and
 * returns the console lines it printed.
 */
export function Agent_Command(text) {
  return Agent_Serial(() => Agent_CommandNow(text));
}

async function Agent_CommandNow(text) {
  if (agent_mode === "off") Agent_Attach("realtime");
  const first = event_seq;
  text = String(text);
  Cbuf_AddText(text + "\n");
  // Run it now in both modes: in realtime, leaving it to the next frame
  // returned before it had run
  Cbuf_Execute();
  if (Agent_Ready()) {
    // One frame lets it take effect (an impulse rides on the next move)
    if (agent_mode === "lockstep") Agent_Tic();
    else {
      const frame = host_framecount;
      await Agent_WaitFor(() => host_framecount !== frame, 1000);
    }
    await Agent_WaitReply();
  }

  // Map loads fetch files before the server spawns: let those settle
  // (without tics) until the load shows, then run it to signon
  if (Agent_StartsLoad(text)) {
    const start = performance.now();
    while (Agent_Loading() === false && performance.now() - start < 2000) {
      await Agent_Yield();
    }
  }

  await Agent_Settle();
  // Return the unread events too, and mark them read, so the next
  // observation doesn't repeat them
  const lines = Agent_EventsSince(Math.min(first, event_read));
  event_read = event_seq;
  return lines.join("\n");
}

// True while console text forwarded to the server (god, give, kill) is
// still on its way: queued in cls.message, or sent and not yet read (the
// loopback) or acknowledged (a remote server)
function Agent_Forwarding() {
  if (cls.demoplayback === true || cls.netcon === null) return false;
  return cls.message.cursize > 0 || NET_CanSendMessage(cls.netcon) === false;
}

// Commands the server runs print their reply over the connection. The
// reliable message waits a frame behind the frame's move (the server reads
// queued messages only up to an unreliable one, as in C), so a local server
// replies in the frame after the one that sends it; the client reads the
// reply at the end of that frame. A remote server replies after its ack:
// allow two more frames. Lockstep runs the frames; realtime waits for them.
async function Agent_WaitReply() {
  if (Agent_Forwarding() === false) return;
  await Agent_WaitFor(() => Agent_Forwarding() === false, 1000);
  if (sv.active === true) return;
  const frame = host_framecount;
  await Agent_WaitFor(() => host_framecount - frame >= 2, 1000);
}

/**
 * Starts a single-player map at a skill (0 easy to 3 nightmare). Host_Map_f
 * closes the console and menu, as in C.
 */
export function Agent_NewGame(map = "start", skill = 1) {
  return Agent_Serial(() => Agent_NewGameNow(map, skill));
}

async function Agent_NewGameNow(map, skill) {
  if (/^[A-Za-z0-9_]+$/.test(map) === false) throw new Error("bad map name");
  skill = Math.max(0, Math.min(3, Math.floor(Number(skill) || 0)));
  if (agent_mode === "off") Agent_Attach("realtime");
  // A missing map leaves the running game alone (and fails at once, not
  // after the load timeout)
  if (await COM_EnsureFile("maps/" + map + ".bsp") !== true) {
    return 'no map "' + map + '"\n' + Agent_Observe();
  }
  Agent_ReleaseButtons(); // a held step's buttons don't carry into the new game
  const first = Math.min(event_seq, event_read);
  // Disconnect first, so the level counts as loaded only once the new one is
  // (the same map reloaded keeps its cached world model)
  Cmd_ExecuteString("disconnect", src_command);
  await Agent_CommandNow(
    "skill " + skill + "\nmaxplayers 1\ndeathmatch 0\ncoop 0\nmap " + map,
  );
  const ok = await Agent_WaitFor(() =>
    Agent_Ready() && Agent_MapName() === map.toLowerCase()
  );
  event_read = first; // the load's events (level, intro text) come with the observation
  if (ok === false) return "failed to load " + map + "\n" + Agent_Observe();
  return Agent_Observe();
}

/**
 * Presses and releases one key, for menus and the console: a name from
 * AGENT_KEYS or a single character.
 */
export function Agent_Key(name, count = 1) {
  if (agent_mode === "off") Agent_Attach("realtime");
  let k;
  if (Object.hasOwn(AGENT_KEYS, name)) k = AGENT_KEYS[name];
  else if (typeof name === "string" && name.length === 1) {
    k = name.toLowerCase().charCodeAt(0);
  } else {throw new Error(
      'unknown key "' + name + '" (expected one character or ' +
        Object.keys(AGENT_KEYS).join(", ") + ")",
    );}

  count = Math.max(1, Math.min(64, Math.floor(Number(count) || 1)));
  for (let i = 0; i < count; i++) {
    Key_Event(k, true);
    Key_Event(k, false);
  }

  return Agent_UIText();
}

/**
 * Moves the menu cursor to the row whose label contains `label` and presses
 * enter. Only menus with labels (main, single player, multiplayer).
 */
export function Agent_MenuSelect(label) {
  const items = Agent_MenuItems();
  if (items === null) {
    throw new Error("no labelled menu is open (" + Agent_UIText() + ")");
  }
  const want = String(label).toLowerCase();
  const target = items.findIndex((s) => s.toLowerCase().includes(want));
  if (target < 0) {
    throw new Error('no item "' + label + '" in ' + items.join(", "));
  }

  for (
    let guard = 0;
    guard < items.length && M_AgentState().cursor !== target;
    guard++
  ) {
    Key_Event(K_DOWNARROW, true);
    Key_Event(K_DOWNARROW, false);
  }

  Key_Event(K_ENTER, true);
  Key_Event(K_ENTER, false);
  return Agent_UIText();
}

// OBSERVATIONS

function Agent_MenuItems() {
  if (key_dest !== key_menu) return null;
  const ms = M_AgentState();
  if (ms.state === m_main) {
    return ms.in_game ? ["Continue", ...MAIN_ITEMS] : MAIN_ITEMS;
  }
  return Object.hasOwn(MENU_ITEMS, ms.state) ? MENU_ITEMS[ms.state] : null;
}

// One line describing what has keyboard focus
export function Agent_UIText() {
  if (key_dest === key_menu) {
    const ms = M_AgentState();
    const items = Agent_MenuItems();
    let s = "ui=menu:" + (MENU_NAMES[ms.state] ?? ms.state);
    if (items !== null) {
      s += " items=[" + items.map((it, i) =>
        (i === ms.cursor ? ">" : "") + it
      ).join("|") + "]";
    } else if (ms.cursor >= 0) s += " cursor=" + ms.cursor;
    return s + " (keys: up/down/enter/escape)";
  }

  if (key_dest === key_console) {
    return "ui=console (escape closes; or use icaro.cmd)";
  }
  if (key_dest === key_message) return "ui=chat";
  return "ui=game";
}

// The server sends the weapon as a byte (SV_WriteClientdataToMessage), so
// the axe (4096) arrives as 0
function Agent_HoldsAxe() {
  return cl.stats[STAT_ACTIVEWEAPON] === 0 && (cl.items & IT_AXE) !== 0;
}

function Agent_Weapon() {
  const w = cl.stats[STAT_ACTIVEWEAPON];
  if (Agent_HoldsAxe()) return "axe";
  for (const [bit, name] of WEAPON_NAMES) {
    if (w === bit) return name;
  }
  return String(w);
}

function Agent_Keys(items) {
  const k = [];
  if (items & IT_KEY1) k.push("silver");
  if (items & IT_KEY2) k.push("gold");
  return k.length > 0 ? k.join("+") : "-";
}

function Agent_Powerups(items) {
  const p = [];
  if (items & IT_QUAD) p.push("quad");
  if (items & IT_INVULNERABILITY) p.push("pent");
  if (items & IT_INVISIBILITY) p.push("ring");
  if (items & IT_SUIT) p.push("suit");
  return p.join("+");
}

function Agent_ArmorType(items) {
  if (items & IT_ARMOR3) return "red";
  if (items & IT_ARMOR2) return "yellow";
  if (items & IT_ARMOR1) return "green";
  return "";
}

// Status line: one line of numbers that matter every turn
export function Agent_StatusText() {
  if (cls.demoplayback) {
    return 'state=demo (start a game: icaro.new_game("lq_e1m1", 1))';
  }
  if (cls.state !== ca_connected) {
    return 'state=disconnected (start a game: icaro.new_game("lq_e1m1", 1))';
  }
  if (cls.signon !== SIGNONS || cl.worldmodel === null) return "state=loading";

  const st = cl.stats;
  const me = cl_entities[cl.viewentity];
  const org = me !== undefined && me !== null ? me.origin : null;
  const armor = Agent_ArmorType(cl.items);
  const pu = Agent_Powerups(cl.items);
  let s = Agent_MapName() + " t=" + cl.time.toFixed(1);
  if (cl.intermission !== 0) s += " INTERMISSION";
  else if (st[STAT_HEALTH] <= 0) s += " DEAD";
  s += " hp=" + st[STAT_HEALTH] + " armor=" + st[STAT_ARMOR] +
    (armor !== "" ? "(" + armor + ")" : "");
  s += " weapon=" + Agent_Weapon() + " ammo=" + st[STAT_AMMO];
  s += " [sh" + st[STAT_SHELLS] + " nl" + st[STAT_NAILS] + " rk" +
    st[STAT_ROCKETS] + " ce" + st[STAT_CELLS] + "]";
  s += " keys=" + Agent_Keys(cl.items) + (pu !== "" ? " powerups=" + pu : "");
  s += " kills=" + st[STAT_MONSTERS] + "/" + st[STAT_TOTALMONSTERS] +
    " secrets=" + st[STAT_SECRETS] + "/" + st[STAT_TOTALSECRETS];
  if (org !== null) {
    s += " pos=" + Math.round(org[0]) + "," + Math.round(org[1]) + "," +
      Math.round(org[2]);
  }
  s += " yaw=" + Math.round(cl.viewangles[YAW]) + " pitch=" +
    Math.round(cl.viewangles[PITCH]);
  s += cl.onground ? " ground" : " air";
  if (cl.inwater) s += " water";
  return s;
}

// Scratch for the line-of-sight trace (Golden Rule #4)
const los_trace = new trace_t();
const los_start = new Float32Array(3);
const los_end = new Float32Array(3);

function Agent_LineOfSight(from, to) {
  return Agent_WorldTrace(from, to) === 1;
}

function Agent_ModelKind(ent) {
  const name = ent.model.name;
  if (name.charCodeAt(0) === 42) return null; // '*': brush entity, kind from the server
  const base = name.replace(/^(progs|maps)\//, "").replace(
    /\.(mdl|spr|bsp)$/,
    "",
  );
  if (SKIP_MODEL.test(base)) return "";
  if (base === "armor") return ARMOR_SKINS[ent.skinnum] ?? "armor";
  return MODEL_KINDS[base] ?? base;
}

// The server's edict for a client entity, when this game runs a local server
function Agent_Edict(num) {
  if (sv.active !== true || num >= sv.num_edicts) return null;
  const ed = sv.edicts[num];
  return ed === undefined || ed === null || ed.free === true ? null : ed;
}

/**
 * The nearest entities the client knows about, with the yaw and pitch change
 * that would face each one (so `yaw` can be passed straight to Agent_Step).
 * With a local server, `truth` adds monster health, brush entity kinds and
 * the level's exits and teleporters.
 */
export function Agent_Entities(max = 10, truth = true) {
  if (Agent_Ready() === false) return [];
  const me = cl_entities[cl.viewentity];
  if (me === undefined || me === null) return [];
  const useTruth = truth === true && sv.active === true;

  los_start[0] = me.origin[0];
  los_start[1] = me.origin[1];
  los_start[2] = me.origin[2] + 22; // DEFAULT_VIEWHEIGHT

  const list = [];
  for (let i = 1; i < cl.num_entities; i++) {
    if (i === cl.viewentity) continue;
    const ent = cl_entities[i];
    if (ent === undefined || ent === null || ent.model === null) continue;
    if (ent.msgtime !== cl.mtime[0]) continue; // not in the latest update: out of view
    let kind = Agent_ModelKind(ent);
    if (kind === "") continue;

    const ed = useTruth ? Agent_Edict(i) : null;
    let hp = null;
    if (kind === null) {
      // Brush entity: report doors, buttons and lifts at their centre
      if (ed === null) continue;
      kind = BRUSH_KINDS[PR_GetString(ed.v.classname)];
      if (kind === undefined) continue;
      los_end[0] = (ed.v.absmin[0] + ed.v.absmax[0]) / 2;
      los_end[1] = (ed.v.absmin[1] + ed.v.absmax[1]) / 2;
      los_end[2] = (ed.v.absmin[2] + ed.v.absmax[2]) / 2;
    } else {
      // The model's centre: item origins sit on the floor
      const m = ent.model;
      los_end[0] = ent.origin[0] + (m.mins[0] + m.maxs[0]) / 2;
      los_end[1] = ent.origin[1] + (m.mins[1] + m.maxs[1]) / 2;
      los_end[2] = ent.origin[2] + (m.mins[2] + m.maxs[2]) / 2;
      if (ed !== null && (ed.v.flags & FL_MONSTER) !== 0) {
        if (ed.v.health <= 0) continue; // corpse
        hp = Math.round(ed.v.health);
      }
    }

    list.push(Agent_Describe(i, kind, los_end, hp, true));
  }

  if (useTruth) {
    for (let i = 1; i < sv.num_edicts; i++) {
      const ed = Agent_Edict(i);
      if (ed === null) continue;
      const kind = TRIGGER_KINDS[PR_GetString(ed.v.classname)];
      if (kind === undefined) continue;
      los_end[0] = (ed.v.absmin[0] + ed.v.absmax[0]) / 2;
      los_end[1] = (ed.v.absmin[1] + ed.v.absmax[1]) / 2;
      los_end[2] = (ed.v.absmin[2] + ed.v.absmax[2]) / 2;
      list.push(Agent_Describe(i, kind, los_end, null, false));
    }
  }

  list.sort((a, b) => a.dist - b.dist);
  list.more = Math.max(0, list.length - max);
  if (list.length > max) list.length = max;
  return list;
}

function Agent_Describe(num, kind, pos, hp, check_los) {
  const dx = pos[0] - los_start[0];
  const dy = pos[1] - los_start[1];
  const dz = pos[2] - los_start[2];
  const flat = Math.hypot(dx, dy);
  let yaw = Math.atan2(dy, dx) * 180 / Math.PI - cl.viewangles[YAW];
  yaw = ((yaw % 360) + 540) % 360 - 180;
  // Quake pitch is positive looking down
  const pitch = -Math.atan2(dz, flat) * 180 / Math.PI - cl.viewangles[PITCH];
  return {
    id: num,
    kind: kind,
    dist: Math.round(Math.hypot(flat, dz)),
    yaw: Math.round(yaw),
    pitch: Math.round(pitch),
    dz: Math.round(dz),
    visible: check_los ? Agent_LineOfSight(los_start, pos) : null,
    hp: hp,
    x: Math.round(pos[0]),
    y: Math.round(pos[1]),
    z: Math.round(pos[2]),
  };
}

function Agent_EntityLine(e) {
  let s = "#" + e.id + " " + e.kind + " " + e.dist + "u yaw" +
    (e.yaw >= 0 ? "+" : "") + e.yaw;
  if (Math.abs(e.pitch) >= 5) {
    s += " pitch" + (e.pitch >= 0 ? "+" : "") + e.pitch;
  }
  if (e.visible === false) s += " hidden";
  if (e.hp !== null) s += " hp" + e.hp;
  return s;
}

// MAP TIER

export const MAP_DEFAULT_SIZE = 21;
export const MAP_MAX_SIZE = 41;
const MAP_CELL = 32; // units per cell: the walk graph's grid
const MAP_STEP = 18; // STEPSIZE: floor this much off your height is level
const MAP_LEDGE = 64; // higher floor drawn as '+'; above that the cell is a wall
const MAP_DROP = 256; // lower floor drawn as '-' (the graph's longest drop)
const MAP_ENT_DZ = 128; // entities this far above or below aren't drawn
const MAP_N = MAP_MAX_SIZE * MAP_MAX_SIZE;

// Cell state
const MAP_SOLID = 1; // the world is solid at body height
const MAP_BRUSH = 2; // a brush entity (door, lift, wall) fills body height
const MAP_REACHED = 4; // the flood from your cell got here
const MAP_NODE = 8; // a walk graph node stands here

const map_x = new Float32Array(MAP_N); // sample point of each cell
const map_y = new Float32Array(MAP_N);
const map_z = new Float32Array(MAP_N); // its floor's player origin z, or yours
const map_state = new Uint8Array(MAP_N);
const map_glyph = new Uint8Array(MAP_N);
const map_queue = new Int16Array(MAP_N);
const map_point = new Float32Array(3);
const map_a = new Float32Array(3);
const map_b = new Float32Array(3);
const map_me = new Float32Array(3);

const MONSTER_KINDS = new Set([
  "grunt",
  "dog",
  "ogre",
  "knight",
  "death_knight",
  "fiend",
  "shambler",
  "zombie",
  "scrag",
  "fish",
  "vore",
  "enforcer",
  "spawn",
  "shub",
  "chthon",
]);
const WEAPON_KINDS = new Set([
  "super_shotgun",
  "nailgun",
  "super_nailgun",
  "grenade_launcher",
  "rocket_launcher",
  "thunderbolt",
]);

// Glyphs: one character per cell
const G_FLOOR = 46; // '.' floor within a step of your height
const G_HIGH = 43; // '+' floor a ledge above (up to 64 units)
const G_LOW = 45; // '-' floor below (a drop)
const G_WALL = 35; // '#'
const G_WATER = 126; // '~'
const G_SLIME = 33; // '!' slime or lava
const G_NONE = 32; // ' ' nothing to stand on, or not seen

/** Glyph for an entity kind on the map tier; 0 for none. */
function Agent_MapGlyph(kind) {
  if (MONSTER_KINDS.has(kind)) return 77; // 'M'
  if (kind === "player") return 80; // 'P'
  if (kind === "gold_key" || kind === "silver_key") return 107; // 'k'
  if (WEAPON_KINDS.has(kind)) return 119; // 'w'
  if (kind === "explobox") return 120; // 'x'
  if (kind.endsWith("_proj") || kind === "lavaball") return 42; // '*'
  if (kind === "door") return 68; // 'D'
  if (kind === "button") return 66; // 'B'
  if (kind === "lift" || kind === "train") return 76; // 'L'
  if (kind === "exit") return 69; // 'E'
  if (kind === "teleport") return 84; // 'T'
  if (kind === "secret_door" || kind === "gate") return G_WALL;
  return 105; // 'i': ammo, health, armour, powerups, backpacks, runes
}

/** The cell index of world point (x, y), or -1 outside the map. */
function Agent_MapCell(n, x, y, cos, sin) {
  const R = (n - 1) / 2;
  const dx = x - map_me[0], dy = y - map_me[1];
  const fwd = dx * cos + dy * sin;
  const right = dx * sin - dy * cos;
  const r = R - Math.round(fwd / MAP_CELL);
  const c = R + Math.round(right / MAP_CELL);
  if (r < 0 || r >= n || c < 0 || c >= n) return -1;
  return r * n + c;
}

// Marks the cells whose sample point lies in the box, flat, where the box
// spans body height over the cell's floor. Returns how many it marked.
function Agent_MapBox(n, mins, maxs, glyph, block) {
  let marked = 0;
  for (let i = 0; i < n * n; i++) {
    if (map_x[i] < mins[0] || map_x[i] > maxs[0]) continue;
    if (map_y[i] < mins[1] || map_y[i] > maxs[1]) continue;
    // body from a step above the feet (origin - 24 + 18) to the head (+32)
    if (maxs[2] <= map_z[i] - 6 || mins[2] >= map_z[i] + 32) continue;
    if (!block && (map_state[i] & (MAP_SOLID | MAP_BRUSH)) !== 0) continue;
    if (block) map_state[i] |= MAP_BRUSH;
    if (glyph !== 0) map_glyph[i] = glyph;
    marked++;
  }
  return marked;
}

// Whether a player can see across from cell a to neighbour b: a world trace
// at the higher of their two heights, so a ledge or a drop isn't a wall
function Agent_MapOpen(a, b) {
  const z = Math.max(map_z[a], map_z[b]);
  map_a[0] = map_x[a];
  map_a[1] = map_y[a];
  map_a[2] = z;
  map_b[0] = map_x[b];
  map_b[1] = map_y[b];
  map_b[2] = z;
  return Agent_LineOfSight(map_a, map_b);
}

/**
 * The map tier: an n x n ASCII grid of 32-unit cells around the player,
 * egocentric (you are '^' at the centre, facing up; left is left). Floors
 * come from the walk graph (src/nav.js), walls and liquids from the world's
 * hull 0, and doors, lifts and walls from brush entities' boxes. Only cells
 * a flood from your cell reaches (through cells open at body height, with no
 * wall between) are drawn, so rooms behind walls stay hidden. Entities in
 * view are drawn over the floor; with a local server and `truth`, exits and
 * teleporters too, and brush entities get their kind. Returns null before a
 * level is loaded.
 */
export function Agent_Map(size = MAP_DEFAULT_SIZE, truth = true) {
  const n = Agent_MapFill(size, truth);
  if (n === 0) return null;
  const centre = (n * n - 1) / 2;
  const rows = [];
  for (let r = 0; r < n; r++) {
    let s = "";
    for (let c = 0; c < n; c++) {
      const i = r * n + c;
      if (i === centre) s += "^";
      else if ((map_state[i] & MAP_REACHED) === 0) s += " ";
      else s += String.fromCharCode(map_glyph[i]);
    }
    rows.push(s.trimEnd());
  }
  return {
    size: n,
    cell: MAP_CELL,
    yaw: Agent_AngleMod(Math.round(cl.viewangles[YAW])),
    x: Math.round(map_me[0]),
    y: Math.round(map_me[1]),
    z: Math.round(map_me[2]),
    rows,
  };
}

/**
 * Agent_Map's cells without the strings (the rl tier reads them): fills
 * map_state and map_glyph for an n x n grid and returns n, or 0 before a
 * level is loaded. A cell is drawn if MAP_REACHED is set in map_state.
 */
function Agent_MapFill(size, truth) {
  if (Agent_Ready() === false) return 0;
  const me = cl_entities[cl.viewentity];
  const world = cl.worldmodel;
  if (me === undefined || me === null || world === null) return 0;
  if (world.hulls === undefined) return 0;
  let n = Number.isFinite(size) ? Math.floor(size) : MAP_DEFAULT_SIZE;
  n = Math.max(5, Math.min(MAP_MAX_SIZE, n));
  if ((n & 1) === 0) n++;
  const R = (n - 1) / 2;
  const useTruth = truth === true && sv.active === true;
  const graph = nav_graph;
  const hull0 = world.hulls[0];

  map_me[0] = me.origin[0];
  map_me[1] = me.origin[1];
  map_me[2] = me.origin[2];
  const yaw = cl.viewangles[YAW];
  const cos = Math.cos(yaw * Math.PI / 180);
  const sin = Math.sin(yaw * Math.PI / 180);

  // Floors and walls
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const i = r * n + c;
      const fwd = (R - r) * MAP_CELL, right = (c - R) * MAP_CELL;
      const x = map_me[0] + fwd * cos + right * sin;
      const y = map_me[1] + fwd * sin - right * cos;
      map_x[i] = x;
      map_y[i] = y;
      map_z[i] = map_me[2];
      map_state[i] = 0;
      map_glyph[i] = G_NONE;

      // The graph node in this cell nearest your height
      let best = -1, best_dz = 0;
      if (graph !== null) {
        const cx = Math.round(x / graph.grid) - graph.cell_x0;
        const cy = Math.round(y / graph.grid) - graph.cell_y0;
        if (cx >= 0 && cx < graph.cell_w && cy >= 0 && cy < graph.cell_h) {
          const cell = cx + cy * graph.cell_w;
          for (
            let j = graph.cell_start[cell];
            j < graph.cell_start[cell + 1];
            j++
          ) {
            const k = graph.cell_nodes[j];
            const dz = graph.node_pos[k * 3 + 2] - map_me[2];
            if (dz > MAP_LEDGE || dz < -MAP_DROP) continue;
            if (best === -1 || Math.abs(dz) < Math.abs(best_dz)) {
              best = k;
              best_dz = dz;
            }
          }
        }
      }

      if (best !== -1) {
        map_z[i] = graph.node_pos[best * 3 + 2];
        map_state[i] = MAP_NODE;
        const f = graph.node_flags[best];
        if ((f & NAV_NODE_SLIME) !== 0) map_glyph[i] = G_SLIME;
        else if ((f & NAV_NODE_WATER) !== 0) map_glyph[i] = G_WATER;
        else if (best_dz > MAP_STEP) map_glyph[i] = G_HIGH;
        else if (best_dz < -MAP_STEP) map_glyph[i] = G_LOW;
        else map_glyph[i] = G_FLOOR;
        continue;
      }

      map_point[0] = x;
      map_point[1] = y;
      map_point[2] = map_me[2];
      const contents = SV_HullPointContents(
        hull0,
        hull0.firstclipnode,
        map_point,
      );
      if (contents === CONTENTS_SOLID || contents === CONTENTS_SKY) {
        map_state[i] = MAP_SOLID;
        map_glyph[i] = G_WALL;
      } else if (contents === CONTENTS_WATER) {
        map_glyph[i] = G_WATER;
      } else if (contents === CONTENTS_SLIME || contents === CONTENTS_LAVA) {
        map_glyph[i] = G_SLIME;
      } else if (graph === null) {
        map_glyph[i] = G_FLOOR; // no graph: open space, floor unknown
      }
    }
  }

  // Brush entities: closed doors, lifts and func_walls fill cells. Their
  // client boxes work without a local server; truth names their kind
  for (let e = 1; e < cl.num_entities; e++) {
    const ent = cl_entities[e];
    if (ent === undefined || ent === null || ent.model === null) continue;
    if (ent.msgtime !== cl.mtime[0]) continue;
    if (ent.model.name.charCodeAt(0) !== 42) continue; // '*'
    let glyph = G_WALL;
    if (useTruth) {
      const ed = Agent_Edict(e);
      if (ed === null) continue;
      const kind = BRUSH_KINDS[PR_GetString(ed.v.classname)];
      if (kind === undefined && ed.v.solid !== 4) continue; // SOLID_BSP
      if (kind !== undefined) glyph = Agent_MapGlyph(kind);
    }
    map_a[0] = ent.origin[0] + ent.model.mins[0];
    map_a[1] = ent.origin[1] + ent.model.mins[1];
    map_a[2] = ent.origin[2] + ent.model.mins[2];
    map_b[0] = ent.origin[0] + ent.model.maxs[0];
    map_b[1] = ent.origin[1] + ent.model.maxs[1];
    map_b[2] = ent.origin[2] + ent.model.maxs[2];
    if (Agent_MapBox(n, map_a, map_b, glyph, true) > 0 || glyph === G_WALL) {
      continue;
    }
    // A box no sample point falls in (a button on a wall): its centre cell
    const i = Agent_MapCell(
      n,
      (map_a[0] + map_b[0]) / 2,
      (map_a[1] + map_b[1]) / 2,
      cos,
      sin,
    );
    const z = (map_a[2] + map_b[2]) / 2;
    if (i !== -1 && z > map_z[i] - 24 && z < map_z[i] + 32) {
      map_glyph[i] = glyph;
    }
  }

  // Flood from your cell through open cells
  const centre = R * n + R;
  map_state[centre] &= ~(MAP_SOLID | MAP_BRUSH);
  map_state[centre] |= MAP_REACHED;
  map_queue[0] = centre;
  let head = 0, tail = 1;
  while (head < tail) {
    const a = map_queue[head++];
    const r = (a / n) | 0, c = a - r * n;
    for (let d = 0; d < 4; d++) {
      const rr = d === 0 ? r - 1 : d === 1 ? r + 1 : r;
      const cc = d === 2 ? c - 1 : d === 3 ? c + 1 : c;
      if (rr < 0 || rr >= n || cc < 0 || cc >= n) continue;
      const b = rr * n + cc;
      if ((map_state[b] & MAP_REACHED) !== 0) continue;
      // walls are drawn where the flood touches them, but stop it
      if ((map_state[b] & (MAP_SOLID | MAP_BRUSH)) !== 0) {
        map_state[b] |= MAP_REACHED;
        continue;
      }
      if (Agent_MapOpen(a, b) === false) continue;
      map_state[b] |= MAP_REACHED;
      map_queue[tail++] = b;
    }
  }

  // Exits and teleporters (server truth): their whole box
  if (useTruth) {
    for (let e = 1; e < sv.num_edicts; e++) {
      const ed = Agent_Edict(e);
      if (ed === null) continue;
      const kind = TRIGGER_KINDS[PR_GetString(ed.v.classname)];
      if (kind === undefined) continue;
      Agent_MapBox(n, ed.v.absmin, ed.v.absmax, Agent_MapGlyph(kind), false);
    }
  }

  // Point entities in view, on cells the flood reached
  for (let e = 1; e < cl.num_entities; e++) {
    if (e === cl.viewentity) continue;
    const ent = cl_entities[e];
    if (ent === undefined || ent === null || ent.model === null) continue;
    if (ent.msgtime !== cl.mtime[0]) continue;
    const kind = Agent_ModelKind(ent);
    if (kind === null || kind === "") continue;
    if (Math.abs(ent.origin[2] - map_me[2]) > MAP_ENT_DZ) continue;
    if (useTruth) {
      const ed = Agent_Edict(e);
      if (ed !== null && (ed.v.flags & FL_MONSTER) !== 0 && ed.v.health <= 0) {
        continue; // corpse
      }
    }
    const i = Agent_MapCell(n, ent.origin[0], ent.origin[1], cos, sin);
    if (i === -1 || (map_state[i] & MAP_REACHED) === 0) continue;
    const glyph = Agent_MapGlyph(kind);
    // monsters and players win a shared cell
    if (map_glyph[i] === 77 || map_glyph[i] === 80) continue;
    map_glyph[i] = glyph;
  }
  return n;
}

// The map as text: a header, then the rows with the blank rows above and
// below and the blank columns on the left cut ('^' still marks you)
function Agent_MapText(m) {
  let top = 0, bottom = m.rows.length;
  while (top < bottom && m.rows[top] === "") top++;
  while (bottom > top && m.rows[bottom - 1] === "") bottom--;
  let indent = m.size;
  for (let r = top; r < bottom; r++) {
    const row = m.rows[r];
    if (row === "") continue;
    indent = Math.min(indent, row.length - row.trimStart().length);
  }
  let s = "map " + m.size + "x" + m.size + " " + m.cell +
    "u, ^ you facing up (yaw " + m.yaw + ") at " + m.x + " " + m.y + " " +
    m.z;
  for (let r = top; r < bottom; r++) s += "\n" + m.rows[r].slice(indent);
  return s;
}

export function Agent_EventsSince(seq) {
  const out = [];
  for (let i = Math.max(seq, event_seq - EVENT_MAX); i < event_seq; i++) {
    out.push(agent_events[i % EVENT_MAX]);
  }
  return out;
}

/**
 * opts: { ents: max entities (default 10, 0 for none), events: true,
 * truth: true, map: false | true | cells across (Agent_Map; true is 21),
 * format: 'text' | 'json' }. Text is the compact default; json returns an
 * object for programs.
 */
export function Agent_Observe(opts = {}) {
  Agent_StatEvents();
  const max = opts.ents ?? 10;
  const ents = max > 0 ? Agent_Entities(max, opts.truth !== false) : [];
  const events = opts.events === false ? [] : Agent_EventsSince(event_read);
  if (opts.events !== false) event_read = event_seq;
  const status = Agent_StatusText();
  const ui = Agent_UIText();
  const want_map = opts.map === true ||
    (typeof opts.map === "number" && opts.map > 0);
  const map = want_map ?
    Agent_Map(
      opts.map === true ? MAP_DEFAULT_SIZE : opts.map,
      opts.truth !== false,
    ) :
    null;

  if (opts.format === "json") {
    return {
      status,
      ui,
      mode: agent_mode,
      tics: agent_tics,
      entities: ents,
      more: ents.more ?? 0,
      events,
      map,
    };
  }

  let s = status;
  if (ui !== "ui=game") s += "\n" + ui;
  if (map !== null) s += "\n" + Agent_MapText(map);
  for (const e of ents) s += "\n" + Agent_EntityLine(e);
  if ((ents.more ?? 0) > 0) s += "\n(+" + ents.more + " farther)";
  for (const ev of events) s += "\n" + ev;
  return s;
}

const fnv = (h, x) => Math.imul(h ^ x, 16777619) >>> 0;
const hash_time = new Float64Array(1);
const hash_time_bits = new Int32Array(hash_time.buffer);

/**
 * FNV-1a over the local server's gameplay state (sv.time, the QuakeC globals
 * and every field of every edict) and the client's stats, as 8 hex digits.
 * Two runs from the same seed and actions give the same hash. '' without a
 * local server.
 */
export function Agent_StateHash() {
  if (sv.active !== true) return "";
  hash_time[0] = sv.time;
  let h = fnv(fnv(0x811c9dc5, hash_time_bits[0]), hash_time_bits[1]);
  for (let i = 0; i < pr_globals_int.length; i++) {
    h = fnv(h, pr_globals_int[i]);
  }
  for (let e = 0; e < sv.num_edicts; e++) {
    const ent = sv.edicts[e];
    h = fnv(h, ent.free === true ? 1 : 0);
    if (ent.free === true) continue;
    const fields = ent._intView;
    for (let i = 0; i < fields.length; i++) {
      h = fnv(h, fields[i]);
    }
  }

  for (let i = 0; i < 32; i++) {
    h = fnv(h, cl.stats[i]);
  }
  return h.toString(16).padStart(8, "0");
}

// RL TIER

/** Layout version of the rl observation and action (Agent_RLSpec). */
export const RL_VERSION = 1;
export const RL_DEFAULT_ENTS = 16;
export const RL_MAX_ENTS = 64;
export const RL_DEFAULT_RAYS = 32;
export const RL_MAX_RAYS = 128;
export const RL_DEFAULT_TICS = 4;
export const RL_MAX_TICS = 72 * 60;
const RL_RANGE = 4096; // ray length, units
const RL_COORD = 16384; // bound on map coordinates
const RL_ENT_FIELDS = 8;

// Status fields: name, low, high. Stats are bytes or shorts on the wire.
// deno-fmt-ignore -- a table reads better in rows
const RL_STATUS = [
  ["health", -200, 255], ["armor", 0, 255], ["ammo", 0, 255],
  ["shells", 0, 255], ["nails", 0, 255], ["rockets", 0, 255], ["cells", 0, 255],
  ["weapon", 0, 8], // 0 none, 1 axe ... 8 thunderbolt (WEAPON_NAMES order)
  ["has_axe", 0, 1], ["has_shotgun", 0, 1], ["has_super_shotgun", 0, 1],
  ["has_nailgun", 0, 1], ["has_super_nailgun", 0, 1],
  ["has_grenade_launcher", 0, 1], ["has_rocket_launcher", 0, 1],
  ["has_thunderbolt", 0, 1],
  ["armor_type", 0, 3], // 0 none, 1 green, 2 yellow, 3 red
  ["silver_key", 0, 1], ["gold_key", 0, 1],
  ["quad", 0, 1], ["pentagram", 0, 1], ["ring", 0, 1], ["biosuit", 0, 1],
  ["onground", 0, 1], ["inwater", 0, 1], ["dead", 0, 1], ["intermission", 0, 1],
  ["x", -RL_COORD, RL_COORD], ["y", -RL_COORD, RL_COORD], ["z", -RL_COORD, RL_COORD],
  ["vx", -2000, 2000], ["vy", -2000, 2000], ["vz", -2000, 2000], // sv_maxvelocity
  ["yaw_sin", -1, 1], ["yaw_cos", -1, 1], ["pitch", -90, 90],
  ["kills", 0, 65535], ["total_monsters", 0, 65535],
  ["secrets", 0, 65535], ["total_secrets", 0, 65535],
  ["time", 0, 1e7],
];

// Per entity slot, egocentric (forward along your yaw, left, up from the eye)
// deno-fmt-ignore -- a table reads better in rows
const RL_ENT = [
  ["present", 0, 1], ["class", 0, 16],
  ["forward", -2 * RL_COORD, 2 * RL_COORD], ["left", -2 * RL_COORD, 2 * RL_COORD],
  ["up", -2 * RL_COORD, 2 * RL_COORD], ["dist", 0, 4 * RL_COORD],
  ["visible", 0, 1], ["hp", -1, 100000], // hp -1: not known (no truth, or not a monster)
];

/** Entity classes in the rl entity slots (index = class number). */
export const RL_CLASSES = [
  "none",
  "monster",
  "player",
  "weapon",
  "ammo",
  "health",
  "armor",
  "key",
  "powerup",
  "projectile",
  "explobox",
  "door",
  "button",
  "lift",
  "exit",
  "teleport",
  "other",
];

// Map tier glyphs to rl map codes: the code is the index in this string
// (blank, unseen and the player's own cell '^' included)
const RL_MAP_GLYPHS = " .+-#~!MPkwx*DBLETi^";
const rl_glyph_code = new Uint8Array(128);
for (let i = 0; i < RL_MAP_GLYPHS.length; i++) {
  rl_glyph_code[RL_MAP_GLYPHS.charCodeAt(i)] = i;
}

// Action: one integer per component (a MultiDiscrete space)
const RL_TURN = [-24, -12, -6, -3, -1, 0, 1, 3, 6, 12, 24]; // yaw degrees, + left
const RL_LOOK = [-10, -5, 0, 5, 10]; // pitch degrees, + down
// deno-fmt-ignore -- a table reads better in rows
const RL_ACTION = [
  ["move", ["none", "forward", "back"]],
  ["strafe", ["none", "moveleft", "moveright"]],
  ["turn", RL_TURN],
  ["look", RL_LOOK],
  ["attack", [0, 1]],
  ["jump", [0, 1]],
  ["speed", [0, 1]], // +speed: run
  ["weapon", [0, 1, 2, 3, 4, 5, 6, 7, 8]], // impulse; 0 keeps the weapon
];
const RL_IMPULSE = ["", "1", "2", "3", "4", "5", "6", "7", "8"].map((n) =>
  "impulse " + n
);

/** Default reward weights (rl_step's opts.reward overrides any of them). */
export const RL_REWARD = Object.freeze({
  kill: 1, // per monster killed (STAT_MONSTERS)
  secret: 1, // per secret found
  hurt: -0.01, // per point of health lost
  death: -5,
  exit: 10, // the level ended: intermission, or a changelevel to another map
  tic: 0, // per tic stepped (a time penalty if negative)
});

let rl_obs = new Float32Array(0);
const rl_d = new Float64Array(RL_MAX_ENTS);
const rl_id = new Int32Array(RL_MAX_ENTS);
const rl_cls = new Uint8Array(RL_MAX_ENTS);
const rl_hp = new Float32Array(RL_MAX_ENTS);
const rl_pos = new Float32Array(RL_MAX_ENTS * 3);
let rl_count = 0;
const rl_eye = new Float32Array(3);
const rl_end = new Float32Array(3);
/** Model name -> rl class (RL_CLASSES index); 0 for models never listed. */
const rl_model_class = new Map();
const rl_buttons = new Set();

// The rl layout for opts { ents, rays, map }: checked, not clamped, so a
// spec and the vectors it describes always agree
function Agent_RLLayout(opts) {
  const ents = opts.ents ?? RL_DEFAULT_ENTS;
  const rays = opts.rays ?? RL_DEFAULT_RAYS;
  const map = opts.map ?? 0;
  if (!Number.isInteger(ents) || ents < 0 || ents > RL_MAX_ENTS) {
    throw new Error("rl: ents must be an integer 0-" + RL_MAX_ENTS);
  }
  if (!Number.isInteger(rays) || rays < 0 || rays > RL_MAX_RAYS) {
    throw new Error("rl: rays must be an integer 0-" + RL_MAX_RAYS);
  }
  if (
    !Number.isInteger(map) ||
    (map !== 0 && (map < 5 || map > MAP_MAX_SIZE || (map & 1) === 0))
  ) {
    throw new Error("rl: map must be 0 or odd, 5-" + MAP_MAX_SIZE);
  }
  return { ents, rays, map, truth: opts.truth !== false };
}

function Agent_RLSize(l) {
  return RL_STATUS.length + l.ents * RL_ENT_FIELDS + l.rays + l.map * l.map;
}

/**
 * The rl layout for opts { ents (16), rays (32), map (0) }: the vector size,
 * each field's name, offset and size, per-element low and high bounds, the
 * entity classes and map codes, the action components (a MultiDiscrete space:
 * nvec, and the meaning of each value) and the default reward weights.
 * Adapters build their spaces from it.
 */
export function Agent_RLSpec(opts = {}) {
  const l = Agent_RLLayout(opts);
  const size = Agent_RLSize(l);
  const fields = [];
  const low = [], high = [];
  let off = 0;
  for (const [name, lo, hi] of RL_STATUS) {
    fields.push({ name, offset: off++, size: 1 });
    low.push(lo);
    high.push(hi);
  }
  fields.push({
    name: "ents",
    offset: off,
    size: l.ents * RL_ENT_FIELDS,
    slots: l.ents,
    per_slot: RL_ENT.map((f) => f[0]),
  });
  for (let k = 0; k < l.ents; k++) {
    for (const [, lo, hi] of RL_ENT) {
      low.push(lo);
      high.push(hi);
    }
  }
  off += l.ents * RL_ENT_FIELDS;
  fields.push({
    name: "rays",
    offset: off,
    size: l.rays,
    range: RL_RANGE,
    first_yaw: 0,
    step_yaw: l.rays > 0 ? 360 / l.rays : 0,
  });
  for (let k = 0; k < l.rays; k++) {
    low.push(0);
    high.push(RL_RANGE);
  }
  off += l.rays;
  fields.push({ name: "map", offset: off, size: l.map * l.map, cells: l.map });
  for (let k = 0; k < l.map * l.map; k++) {
    low.push(0);
    high.push(RL_MAP_GLYPHS.length - 1);
  }
  return {
    version: RL_VERSION,
    size,
    fields,
    low,
    high,
    classes: RL_CLASSES,
    map_glyphs: RL_MAP_GLYPHS,
    action: {
      names: RL_ACTION.map((a) => a[0]),
      nvec: RL_ACTION.map((a) => a[1].length),
      values: RL_ACTION.map((a) => a[1]),
      noop: [0, 0, RL_TURN.indexOf(0), RL_LOOK.indexOf(0), 0, 0, 0, 0],
    },
    reward: { ...RL_REWARD },
    tics: RL_DEFAULT_TICS,
  };
}

// Fraction of the way from a to b a hull 0 world trace gets (1: clear; 0
// from inside a wall). Leaves the trace in los_trace.
function Agent_WorldTrace(from, to) {
  if (cl.worldmodel === null || cl.worldmodel.hulls === undefined) return 1;
  los_trace.allsolid = false;
  los_trace.startsolid = false;
  los_trace.inopen = false;
  los_trace.inwater = false;
  los_trace.fraction = 1;
  los_trace.ent = null;
  los_trace.endpos[0] = to[0];
  los_trace.endpos[1] = to[1];
  los_trace.endpos[2] = to[2];
  SV_RecursiveHullCheck(cl.worldmodel.hulls[0], 0, 0, 1, from, to, los_trace);
  return los_trace.allsolid ? 0 : los_trace.fraction;
}

function Agent_RLClassOfKind(kind) {
  if (MONSTER_KINDS.has(kind)) return 1;
  if (kind === "player") return 2;
  if (WEAPON_KINDS.has(kind)) return 3;
  if (/^(shells|nails|rockets|cells)/.test(kind)) return 4;
  if (kind.startsWith("health") || kind === "megahealth") return 5;
  if (kind.endsWith("armor")) return 6;
  if (kind.endsWith("_key")) return 7;
  if (
    kind === "quad" || kind === "pentagram" || kind === "ring" ||
    kind === "biosuit"
  ) return 8;
  if (kind.endsWith("_proj") || kind === "lavaball") return 9;
  if (kind === "explobox") return 10;
  if (kind === "door" || kind === "secret_door" || kind === "gate") return 11;
  if (kind === "button") return 12;
  if (kind === "lift" || kind === "train") return 13;
  if (kind === "exit") return 14;
  if (kind === "teleport") return 15;
  return 16;
}

function Agent_RLModelClass(ent) {
  const name = ent.model.name;
  let c = rl_model_class.get(name);
  if (c === undefined) {
    const kind = Agent_ModelKind(ent);
    c = kind === null || kind === "" ? 0 : Agent_RLClassOfKind(kind);
    rl_model_class.set(name, c);
  }
  return c;
}

// Keeps the k nearest offers, sorted by distance
function Agent_RLOffer(k, id, cls, x, y, z, hp) {
  const d = Math.hypot(x - rl_eye[0], y - rl_eye[1], z - rl_eye[2]);
  if (rl_count === k && (k === 0 || d >= rl_d[k - 1])) return;
  let j = rl_count < k ? rl_count++ : k - 1;
  for (; j > 0 && rl_d[j - 1] > d; j--) {
    rl_d[j] = rl_d[j - 1];
    rl_id[j] = rl_id[j - 1];
    rl_cls[j] = rl_cls[j - 1];
    rl_hp[j] = rl_hp[j - 1];
    rl_pos[j * 3] = rl_pos[j * 3 - 3];
    rl_pos[j * 3 + 1] = rl_pos[j * 3 - 2];
    rl_pos[j * 3 + 2] = rl_pos[j * 3 - 1];
  }
  rl_d[j] = d;
  rl_id[j] = id;
  rl_cls[j] = cls;
  rl_hp[j] = hp;
  rl_pos[j * 3] = x;
  rl_pos[j * 3 + 1] = y;
  rl_pos[j * 3 + 2] = z;
}

// The k nearest entities into rl_*: what Agent_Entities lists, without
// allocating
function Agent_RLGather(k, use_truth) {
  rl_count = 0;
  if (k === 0) return;
  for (let i = 1; i < cl.num_entities; i++) {
    if (i === cl.viewentity) continue;
    const ent = cl_entities[i];
    if (ent === undefined || ent === null || ent.model === null) continue;
    if (ent.msgtime !== cl.mtime[0]) continue; // not in view
    const m = ent.model;
    const ed = use_truth ? Agent_Edict(i) : null;
    if (m.name.charCodeAt(0) === 42) {
      // '*': a brush entity, known only by its classname
      if (ed === null) continue;
      const kind = BRUSH_KINDS[PR_GetString(ed.v.classname)];
      if (kind === undefined) continue;
      Agent_RLOffer(
        k,
        i,
        Agent_RLClassOfKind(kind),
        (ed.v.absmin[0] + ed.v.absmax[0]) / 2,
        (ed.v.absmin[1] + ed.v.absmax[1]) / 2,
        (ed.v.absmin[2] + ed.v.absmax[2]) / 2,
        -1,
      );
      continue;
    }
    const cls = Agent_RLModelClass(ent);
    if (cls === 0) continue;
    let hp = -1;
    if (ed !== null && (ed.v.flags & FL_MONSTER) !== 0) {
      if (ed.v.health <= 0) continue; // corpse
      hp = Math.round(ed.v.health);
    }
    Agent_RLOffer(
      k,
      i,
      cls,
      ent.origin[0] + (m.mins[0] + m.maxs[0]) / 2,
      ent.origin[1] + (m.mins[1] + m.maxs[1]) / 2,
      ent.origin[2] + (m.mins[2] + m.maxs[2]) / 2,
      hp,
    );
  }
  if (use_truth) {
    for (let i = 1; i < sv.num_edicts; i++) {
      const ed = Agent_Edict(i);
      if (ed === null) continue;
      const kind = TRIGGER_KINDS[PR_GetString(ed.v.classname)];
      if (kind === undefined) continue;
      Agent_RLOffer(
        k,
        i,
        Agent_RLClassOfKind(kind),
        (ed.v.absmin[0] + ed.v.absmax[0]) / 2,
        (ed.v.absmin[1] + ed.v.absmax[1]) / 2,
        (ed.v.absmin[2] + ed.v.absmax[2]) / 2,
        -1,
      );
    }
  }
}

// Fills rl_obs for layout l (zeros before a level is loaded)
function Agent_RLFill(l) {
  const size = Agent_RLSize(l);
  if (rl_obs.length !== size) rl_obs = new Float32Array(size);
  const o = rl_obs;
  o.fill(0);
  if (Agent_Ready() === false) return o;
  const me = cl_entities[cl.viewentity];
  if (me === undefined || me === null) return o;
  const st = cl.stats;
  const items = cl.items;
  const use_truth = l.truth && sv.active === true;

  let p = 0;
  o[p++] = st[STAT_HEALTH];
  o[p++] = st[STAT_ARMOR];
  o[p++] = st[STAT_AMMO];
  o[p++] = st[STAT_SHELLS];
  o[p++] = st[STAT_NAILS];
  o[p++] = st[STAT_ROCKETS];
  o[p++] = st[STAT_CELLS];
  let weapon = 0;
  if (Agent_HoldsAxe()) weapon = 1;
  else {
    for (let i = 0; i < WEAPON_NAMES.length; i++) {
      if (st[STAT_ACTIVEWEAPON] === WEAPON_NAMES[i][0]) weapon = i + 1;
    }
  }
  o[p++] = weapon;
  for (let i = 0; i < WEAPON_NAMES.length; i++) {
    o[p++] = (items & WEAPON_NAMES[i][0]) !== 0 ? 1 : 0;
  }
  o[p++] = (items & IT_ARMOR3) !== 0 ?
    3 :
    (items & IT_ARMOR2) !== 0 ?
    2 :
    (items & IT_ARMOR1) !== 0 ?
    1 :
    0;
  o[p++] = (items & IT_KEY1) !== 0 ? 1 : 0;
  o[p++] = (items & IT_KEY2) !== 0 ? 1 : 0;
  o[p++] = (items & IT_QUAD) !== 0 ? 1 : 0;
  o[p++] = (items & IT_INVULNERABILITY) !== 0 ? 1 : 0;
  o[p++] = (items & IT_INVISIBILITY) !== 0 ? 1 : 0;
  o[p++] = (items & IT_SUIT) !== 0 ? 1 : 0;
  o[p++] = cl.onground ? 1 : 0;
  o[p++] = cl.inwater ? 1 : 0;
  o[p++] = st[STAT_HEALTH] <= 0 ? 1 : 0;
  o[p++] = cl.intermission !== 0 ? 1 : 0;
  o[p++] = me.origin[0];
  o[p++] = me.origin[1];
  o[p++] = me.origin[2];
  o[p++] = cl.velocity[0];
  o[p++] = cl.velocity[1];
  o[p++] = cl.velocity[2];
  const yaw = cl.viewangles[YAW] * Math.PI / 180;
  const cos = Math.cos(yaw), sin = Math.sin(yaw);
  o[p++] = sin;
  o[p++] = cos;
  o[p++] = cl.viewangles[PITCH];
  o[p++] = st[STAT_MONSTERS];
  o[p++] = st[STAT_TOTALMONSTERS];
  o[p++] = st[STAT_SECRETS];
  o[p++] = st[STAT_TOTALSECRETS];
  o[p++] = cl.time;

  rl_eye[0] = me.origin[0];
  rl_eye[1] = me.origin[1];
  rl_eye[2] = me.origin[2] + 22; // DEFAULT_VIEWHEIGHT, as Agent_Entities
  Agent_RLGather(l.ents, use_truth);
  for (let j = 0; j < l.ents; j++, p += RL_ENT_FIELDS) {
    if (j >= rl_count) continue; // empty slot: zeros
    const dx = rl_pos[j * 3] - rl_eye[0];
    const dy = rl_pos[j * 3 + 1] - rl_eye[1];
    const dz = rl_pos[j * 3 + 2] - rl_eye[2];
    o[p] = 1;
    o[p + 1] = rl_cls[j];
    o[p + 2] = dx * cos + dy * sin;
    o[p + 3] = dy * cos - dx * sin;
    o[p + 4] = dz;
    o[p + 5] = rl_d[j];
    // Triggers (exits, teleporters) have no model to see
    if (rl_cls[j] !== 14 && rl_cls[j] !== 15) {
      rl_end[0] = rl_pos[j * 3];
      rl_end[1] = rl_pos[j * 3 + 1];
      rl_end[2] = rl_pos[j * 3 + 2];
      o[p + 6] = Agent_WorldTrace(rl_eye, rl_end) === 1 ? 1 : 0;
    }
    o[p + 7] = rl_hp[j];
  }

  for (let r = 0; r < l.rays; r++) {
    const a = yaw + r * 2 * Math.PI / l.rays; // counterclockwise: forward, then left
    rl_end[0] = rl_eye[0] + Math.cos(a) * RL_RANGE;
    rl_end[1] = rl_eye[1] + Math.sin(a) * RL_RANGE;
    rl_end[2] = rl_eye[2];
    o[p++] = Agent_WorldTrace(rl_eye, rl_end) * RL_RANGE;
  }

  if (l.map > 0) {
    const n = Agent_MapFill(l.map, l.truth);
    if (n !== 0) {
      const centre = (n * n - 1) / 2;
      for (let i = 0; i < n * n; i++) {
        o[p + i] = i === centre ?
          RL_MAP_GLYPHS.length - 1 :
          (map_state[i] & MAP_REACHED) === 0 ?
          0 :
          rl_glyph_code[map_glyph[i]];
      }
    }
  }
  return o;
}

/**
 * The rl observation for opts { ents, rays, map, truth } (Agent_RLSpec gives
 * its layout), without advancing the game or reading the event log. The
 * array is reused by the next rl call: copy it (slice()) to keep it.
 */
export function Agent_RLObserve(opts = {}) {
  return Agent_RLFill(Agent_RLLayout(opts));
}

// Sets the buttons, look and impulse of an rl action vector
function Agent_RLAct(action) {
  if (action === null || typeof action !== "object") {
    throw new Error("rl: action must be " + RL_ACTION.length + " integers");
  }
  if (action.length !== RL_ACTION.length) {
    throw new Error("rl: action must be " + RL_ACTION.length + " integers");
  }
  for (let i = 0; i < RL_ACTION.length; i++) {
    const v = action[i];
    if (!Number.isInteger(v) || v < 0 || v >= RL_ACTION[i][1].length) {
      throw new Error(
        "rl: action[" + i + "] (" + RL_ACTION[i][0] + ") must be 0-" +
          (RL_ACTION[i][1].length - 1),
      );
    }
  }
  rl_buttons.clear();
  if (action[0] !== 0) rl_buttons.add(action[0] === 1 ? "forward" : "back");
  if (action[1] !== 0) {
    rl_buttons.add(action[1] === 1 ? "moveleft" : "moveright");
  }
  if (action[4] !== 0) rl_buttons.add("attack");
  if (action[5] !== 0) rl_buttons.add("jump");
  if (action[6] !== 0) rl_buttons.add("speed");
  cl.viewangles[YAW] = Agent_AngleMod(cl.viewangles[YAW] + RL_TURN[action[2]]);
  if (RL_LOOK[action[3]] !== 0) {
    cl.viewangles[PITCH] += RL_LOOK[action[3]];
    CL_ClampPitch();
  }
  if (action[7] !== 0) Cmd_ExecuteString(RL_IMPULSE[action[7]], src_command);
  Agent_SetButtons(rl_buttons);
}

/**
 * One rl step (lockstep only): applies an action vector (Agent_RLSpec's
 * action components), runs `tics` tics (default 4) or until the episode
 * ends, and returns { obs, reward, terminated, why, tics }. Buttons stay held
 * between rl steps (the game is frozen between them) and are released when
 * the episode ends. The reward is the weighted sum (opts.reward over
 * RL_REWARD) of kills, secrets, health lost, death, the level's end and tics
 * stepped, over this step only, so it never consumes the event log. why says
 * how the episode ended: "died", "level done", "level changed" (to another
 * map) or "level restarted"; "" while it runs. obs is reused (Agent_RLObserve).
 */
export function Agent_RLStep(action, tics = RL_DEFAULT_TICS, opts = {}) {
  return Agent_Serial(() => Agent_RLStepNow(action, tics, opts));
}

async function Agent_RLStepNow(action, tics, opts) {
  if (agent_mode !== "lockstep") {
    throw new Error('rl_step needs lockstep mode: attach("lockstep") first');
  }
  const l = Agent_RLLayout(opts);
  if (!Number.isInteger(tics) || tics < 0 || tics > RL_MAX_TICS) {
    throw new Error("rl_step: tics must be an integer 0-" + RL_MAX_TICS);
  }
  const w = opts.reward ?? RL_REWARD;
  const weight = (k) => typeof w[k] === "number" ? w[k] : RL_REWARD[k];
  if (Agent_Loading()) await Agent_Settle();
  if (Agent_Ready() === false) throw new Error("rl_step: no game running");
  Agent_RLAct(action);

  const map = Agent_MapName();
  let health = cl.stats[STAT_HEALTH];
  let kills = cl.stats[STAT_MONSTERS];
  let secrets = cl.stats[STAT_SECRETS];
  // The level's end pays once: stepping on in intermission doesn't
  const intermission = cl.intermission;
  let reward = 0;
  let why = "";
  let n = 0;
  while (n < tics) {
    Agent_Tic();
    n++;
    if (Agent_Loading() || Agent_MapName() !== map) {
      // The level went away (its stats with it: rewards count to the last
      // tic). A changelevel without intermission (start's exits) ends it
      // too; the same map again is a restart (after death, or a reload).
      if (Agent_Loading()) await Agent_Settle();
      if (Agent_MapName() !== map) {
        why = "level changed";
        if (intermission === 0) reward += weight("exit");
      } else why = "level restarted";
      break;
    }
    const st = cl.stats;
    reward += weight("kill") * (st[STAT_MONSTERS] - kills);
    reward += weight("secret") * (st[STAT_SECRETS] - secrets);
    if (st[STAT_HEALTH] < health) {
      reward += weight("hurt") * (health - Math.max(0, st[STAT_HEALTH]));
    }
    kills = st[STAT_MONSTERS];
    secrets = st[STAT_SECRETS];
    if (st[STAT_HEALTH] <= 0 && health > 0) {
      reward += weight("death");
      why = "died";
    }
    health = st[STAT_HEALTH];
    if (why === "" && cl.intermission !== 0 && intermission === 0) {
      reward += weight("exit");
      why = "level done";
    }
    if (why !== "") break;
  }
  reward += weight("tic") * n;
  if (why !== "") Agent_ReleaseButtons();
  return {
    obs: Agent_RLFill(l),
    reward,
    terminated: why !== "",
    why,
    tics: n,
  };
}

// SCREEN TIER

// Browser only: the headless host has no renderer, so these need the page's
// WebGL canvas (and the 2D overlay canvas: HUD, menus, console)
export const SCREEN_MIN = 16;
export const SCREEN_MAX = 1920;

/** The canvas the screen tier draws into, reused across calls */
let screen_canvas = null;
let screen_ctx = null;

// A size in pixels, clamped, or def when it isn't a number
function Agent_ScreenClamp(size, def) {
  if (!Number.isFinite(size)) return def;
  return Math.max(SCREEN_MIN, Math.min(SCREEN_MAX, Math.floor(size)));
}

// Draws the current view (3D canvas, then the overlay unless null) scaled to
// w x h into the reused canvas, and returns its context
function Agent_ScreenDraw(gl_canvas, overlay_canvas, w, h) {
  SCR_UpdateScreen(); // draw now, so the WebGL buffer is still readable
  if (screen_canvas === null) {
    screen_canvas = gl_canvas.ownerDocument.createElement("canvas");
    screen_ctx = screen_canvas.getContext("2d", { willReadFrequently: true });
  }
  if (screen_canvas.width !== w) screen_canvas.width = w;
  if (screen_canvas.height !== h) screen_canvas.height = h;
  screen_ctx.drawImage(gl_canvas, 0, 0, w, h);
  if (overlay_canvas !== null) {
    screen_ctx.drawImage(overlay_canvas, 0, 0, w, h);
  }
  return screen_ctx;
}

// The height that keeps the view's aspect at width w, clamped like a width
function Agent_ScreenHeight(gl_canvas, w) {
  return Agent_ScreenClamp(
    Math.round(w * gl_canvas.height / gl_canvas.width),
    w,
  );
}

/**
 * Draws the current view (3D canvas and 2D overlay) into a small image and
 * returns a data URL. In a browser with its own screenshot tool, that tool is
 * cheaper: a data URL comes back as text, which costs far more tokens than an
 * image. This is for adapters (MCP) that return it as an image.
 */
export function Agent_Screenshot(
  gl_canvas,
  overlay_canvas,
  width = 320,
  type = "image/jpeg",
  quality = 0.7,
) {
  const w = Math.max(32, Agent_ScreenClamp(width, 320));
  Agent_ScreenDraw(
    gl_canvas,
    overlay_canvas,
    w,
    Agent_ScreenHeight(gl_canvas, w),
  );
  return screen_canvas.toDataURL(type, quality);
}

/**
 * The screen tier's pixels for RL programs: the current view (3D canvas, then
 * the 2D overlay unless overlay_canvas is null) scaled to width x height
 * (height 0 keeps the view's aspect), as { width, height, data }, where data
 * is RGBA bytes, row by row from the top left (ImageData's layout). Each call
 * returns a new array (getImageData allocates it).
 */
export function Agent_ScreenRGBA(
  gl_canvas,
  overlay_canvas,
  width = 84,
  height = 0,
) {
  const w = Agent_ScreenClamp(width, 84);
  const h = Number.isFinite(height) && height > 0 ?
    Agent_ScreenClamp(height, 84) :
    Agent_ScreenHeight(gl_canvas, w);
  const ctx = Agent_ScreenDraw(gl_canvas, overlay_canvas, w, h);
  return { width: w, height: h, data: ctx.getImageData(0, 0, w, h).data };
}

export const AGENT_HELP = `Icaro Engine (Quake) agent API: window.icaro
Start:  await icaro.new_game('lq_e1m1', 1)   // map, skill 0-3; returns an observation
Clock:  icaro.attach('lockstep')  // game frozen between steps (best for agents)
        icaro.attach('realtime')  // game runs; steps wait in real time
        icaro.mode(), icaro.detach()  // current mode; stop (game runs again)
Act:    await icaro.step({ buttons: 'forward,attack', yaw: 30, pitch: 0, impulse: 2 }, 18)
        buttons held for N tics (72 tics = 1 s), then released.
        buttons: ${Object.keys(AGENT_BUTTONS).join(" ")}
        yaw: degrees, + turns left. pitch: + looks down. face: absolute yaw.
        impulse: 1-8 weapon select (1 axe, 2 shotgun, 3 super shotgun, 4 nailgun, ...).
        Quake has no use key: walk into buttons and doors; shoot some buttons.
Walk:   await icaro.goto(12) or icaro.goto([x, y, z], { max_tics: 2160 })  // lockstep only
        walks to entity #12 or a point on the level's walk graph; the first line says
        how it ended: arrived, blocked by #id (and what opens it), took damage, no path...
        goto and attack stop when a monster comes into sight: "new enemy #id kind ...";
        { stop_on_enemy: false } walks on (each monster stops one macro, once).
Fight:  icaro.turn_to(12) or icaro.turn_to({ yaw: 90 })  // face #12 or a yaw, at once
        await icaro.attack(12, { max_tics: 720 })  // lockstep: aim and fire until it ends;
        the first line says how: killed, gone, out of sight, out of ammo, died...
Look:   icaro.observe()   // status line, ui, nearest entities, events since last call
        entity line: #id kind distance yawN [pitchN] [hidden] [hpN]
        yawN is the yaw change that faces it: step({ yaw: N }).
        exit = level exit trigger (walk into it).
Map:    icaro.observe({ map: 21 })  // also the opts of step, goto, turn_to and attack
        21x21 cells of 32 units, turned so you are ^ at the centre facing up (left is left):
        . floor at your height  + higher  - lower  # wall  ~ water  ! slime/lava
        blank: nothing to stand on, or not in view.  D door  L lift  B button
        E exit  T teleporter  M monster  P player  w weapon  k key  i item  x box  * shot
Menus:  icaro.key('down'|'up'|'enter'|'escape'|'y'|...), icaro.menu('Single Player')
Console: await icaro.cmd('god')   // returns what it printed (lockstep, in game: runs one or two tics)
Image:  use your browser's own screenshot tool (icaro.screenshot() returns a data URL)
Pixels: icaro.screen_rgba(84, 0, true)  // { width, height, data }: RGBA bytes of the view at
        that width (height 0 keeps the aspect); false leaves out the HUD, menus and console
Options: icaro.observe({ ents: 20, map: 21, format: 'json', truth: false })
RL:     icaro.rl_spec({ ents: 16, rays: 32, map: 0 })  // fixed-size vector layout and action space
        await icaro.rl_step([1, 0, 5, 2, 0, 0, 1, 0], 4)  // -> { obs, reward, terminated, why }
        icaro.rl_observe(opts)  // the vector now (Float32Array, reused: slice() to keep)`;
