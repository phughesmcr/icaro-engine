// Web-only addition, no Quake equivalent: the browser page's URL parameters,
// read in one place. The C engine took these settings from its command line
// (-rogue, -game, -particles, -listen) and from autoexec.cfg; a URL can come
// from a shared link, so it is untrusted input (AGENTS.md). Every parameter
// here is checked against an explicit allowlist and parsed into a number or a
// fixed name; nothing a URL holds is ever concatenated into command text.
// URL parameters never bind keys, define aliases, run commands or scripts,
// connect somewhere or write files.
//
// The parameters:
//   ?game=<dir>          a mission pack (-rogue, -hipnotic, -quoth) or any
//                        other game directory (-game <dir>) whose name
//                        common.js COM_GameDirIsValid accepts
//   ?base=<name>         the data layout (static/, rerelease, librequake)
//   ?particles=<n>       -particles <n>
//   ?listen[=<n>]        -listen [n]
//   ?agent=<mode>        attach the agent API (docs/agent-interface.md)
//   ?map=<name>          start this map, with ?skill=<0-3>
//   ?dpr=<n|native>      the renderer's pixel ratio (vid.js)
//   ?scale=<n>           the 3D view's render scale (vid.js)
//   ?cfg.<cvar>=<value>  a client setting from URLCFG_CVARS, for this page
//                        load only: main.js sets it with Cvar_SetTransient,
//                        so it is never written to the saved config
//
// Not read here: ?room=, ?server= and ?transport= (connection plumbing in
// sys.js, net_main.js and the net drivers, which check them themselves).
//
// The design is docs/audit/multiplayer-security.md, "URL-param config
// design". Deliberate departures from it: no ?bind.<key>= (AGENTS.md: URL
// parameters never bind keys) and no ?cfg= shorthand (one form to check).
//
// Pure: no cvar, DOM or engine state, so it can be tested on its own. Its
// imports are pure tables and functions used only after import, so vid.js can
// import it without an import-cycle problem.

import { advancedPages } from "./menu_cvars.js";
import { COM_GameDirIsValid } from "./common.js";

/**
 * ?game= names that stand in for WinQuake's -rogue and -hipnotic, and
 * QuakeSpasm's -quoth. Any other valid directory name (the rerelease's mg1,
 * a mod) stands in for -game <dir>; static/<dir>/pak0.pak must exist.
 */
export const URLCFG_MISSION_PACKS = Object.freeze([
  "rogue",
  "hipnotic",
  "quoth",
]);

/**
 * ?base= names and their directories. ?base=rerelease stands in for -basedir:
 * the 2021 rerelease's directories, static/rerelease/id1 and
 * static/rerelease/<game>. ?base=librequake is LibreQuake, kept in the
 * browser's storage under static/librequake/id1 (src/librequake.js). Without
 * either (?base=id1), id1's paks are static/pak*.pak and game directories are
 * static/<game>. The intro page (src/intro.js) picks the base when the URL
 * doesn't.
 */
export const URLCFG_BASE_DIRS = Object.freeze({
  rerelease: "static/rerelease",
  librequake: "static/librequake",
});

// ?particles=<n> stands in for -particles <n> (r_part.c R_InitParticles sizes
// the particle pool from it). C has no maximum, but values above
// URLCFG_PARTICLES_MAX (16 times Ironwail's default) are ignored rather than
// allocated.
const PARTICLES_ARG = /^[0-9]+$/;
/** The largest ?particles= value passed on */
export const URLCFG_PARTICLES_MAX = 262144;

// ?listen=<n> stands in for -listen <n> (host.c Host_FindMaxClients): this tab
// can host n players (MAX_SCOREBOARD, 16, caps larger values; 0 means 8) and
// starts in deathmatch mode when n > 1, as the C does with the flag. ?listen
// with no value is -listen alone, 8 players.
const LISTEN_ARG = /^[0-9]{1,3}$/;

// ?agent=, ?map= and ?skill= (docs/agent-interface.md). The map name is
// checked, so a shared link can't run other commands.
const AGENT_MODES = ["lockstep", "realtime"];
const AGENT_MAP_ARG = /^[A-Za-z0-9_]{1,32}$/;
const SKILL_ARG = /^[0-3]$/;

/** A plain decimal number: no hex, exponent, Infinity or empty string */
const DECIMAL = /^-?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)$/;

/** At most this many ?cfg. parameters are read; the rest are ignored */
export const URLCFG_MAX_CVARS = 64;
/** A ?cfg. value longer than this is ignored without being parsed */
export const URLCFG_MAX_VALUE_LENGTH = 64;

/**
 * The cvars ?cfg. may set whose range comes from their row on the Options
 * menu's Advanced pages (menu_cvars.js), so the two stay in step. A slider row
 * gives its min and max; a choice row the lowest and highest of its values
 * (whole numbers if every value is one); a toggle row 0 or 1. Each is
 * client-local, can't affect other players and is safe to set from a link
 * (multiplayer-security.md, "Classification", "Safe").
 */
const MENU_CVARS = [
  // Display & HUD
  "scr_sbarscale",
  "scr_conscale",
  "scr_menuscale",
  "scr_sbaralpha",
  "scr_showfps",
  "scr_clock",
  "host_maxfps",
  "con_notifytime",
  "scr_centertime",
  "con_logcenterprint",
  "scr_printspeed",
  "scr_conspeed",
  "showpause",
  "showturtle",
  // Graphics (not vid_quality: its preset sets the cvars below with
  // Cvar_Set, as the player's own change, so they would be saved)
  "vid_dprcap",
  "vid_dynres",
  "gl_farclip",
  "gl_texture_anisotropy",
  "r_wateralpha",
  "r_lavaalpha",
  "r_slimealpha",
  "r_telealpha",
  "r_waterwarp",
  "r_dynamic",
  "gl_flashblend",
  "r_lerpmodels",
  "r_lerpmove",
  "gl_doubleeys",
  "r_shadows",
  "r_mirroralpha",
  "gl_cshiftpercent",
  "gl_cshiftpercent_contents",
  "gl_cshiftpercent_damage",
  "gl_cshiftpercent_bonus",
  "gl_cshiftpercent_powerup",
  "gl_polyblend",
  "gl_nocolors",
  "gl_picmip",
  "gl_max_size",
  "gl_playermip",
  // View & Camera (not scr_ofsx/y/z: single player only)
  "fov",
  "cl_gun_fovscale",
  "r_drawviewmodel",
  "v_gunkick",
  "v_kickpitch",
  "v_kickroll",
  "v_kicktime",
  "cl_bob",
  "cl_bobcycle",
  "cl_bobup",
  "cl_rollangle",
  "cl_rollspeed",
  "v_idlescale",
  "cl_maxpitch",
  "cl_minpitch",
  "v_centermove",
  "v_centerspeed",
  "chase_active",
  "chase_back",
  "chase_up",
  "chase_right",
  // Movement
  "cl_sidespeed",
  "cl_upspeed",
  "cl_yawspeed",
  "cl_pitchspeed",
  "cl_movespeedkey",
  "cl_anglespeedkey",
  // Mouse
  "m_filter",
  "in_rawmouse",
  "m_yaw",
  "m_forward",
  "m_side",
  // Controller
  "gp_look_yaw",
  "gp_look_pitch",
  "joy_deadzone_move",
  "joy_deadzone_look",
  "joy_outer_threshold_move",
  "joy_outer_threshold_look",
  "joy_exponent_move",
  "joy_exponent",
  "xr_snapturn",
  "xr_turnspeed",
  // Sound
  "ambient_level",
  "ambient_fade",
];

// The cvars ?cfg. may set that have no Advanced-page row, with their ranges.
// Ranges follow the C's own clamps or menu sliders where it has them
// (viewsize 30-120, volume 0-1, sensitivity's slider 1-11 widened for
// high-resolution mice), otherwise a range that covers every sensible value.
// A table kept in rows: deno fmt would split each entry
// deno-fmt-ignore
const OWN_CVARS = {
  viewsize:           { type: "int", min: 30, max: 120 },
  gamma:              { type: "float", min: 0.5, max: 2 },
  contrast:           { type: "float", min: 1, max: 2 },
  crosshair:          { type: "int", min: 0, max: 2 },
  scr_crosshairscale: { type: "float", min: 0, max: 10 },
  r_particles:        { type: "int", min: 0, max: 2 },
  r_viewmodel_quake:  { type: "bool" },
  volume:             { type: "float", min: 0, max: 1 },
  bgmvolume:          { type: "float", min: 0, max: 1 },
  sensitivity:        { type: "float", min: 0.1, max: 30 },
  m_pitch:            { type: "float", min: -0.1, max: 0.1 },
  lookspring:         { type: "bool" },
  lookstrafe:         { type: "bool" },
  cl_alwaysrun:       { type: "bool" },
  cl_forwardspeed:    { type: "int", min: 100, max: 600 },
  cl_backspeed:       { type: "int", min: 100, max: 600 },
};

/** A menu row's range, as an allowlist entry (see MENU_CVARS) */
function URLCfg_SpecFromMenuRow(item) {
  if (item.min !== undefined) {
    return { type: "float", min: item.min, max: item.max };
  }
  if (item.values !== undefined) {
    return {
      type: item.values.every(Number.isInteger) ? "int" : "float",
      min: Math.min(...item.values),
      max: Math.max(...item.values),
    };
  }
  return { type: "bool" };
}

function URLCfg_BuildCvarTable() {
  const rows = new Map();
  for (const page of advancedPages) {
    for (const item of page.items) rows.set(item.cvar, item);
  }

  const table = Object.create(null);
  for (const name of MENU_CVARS) {
    const row = rows.get(name);
    // a renamed or removed row must not leave its cvar unchecked
    if (row === undefined) {
      throw new Error("url_config: no Advanced-page row for " + name);
    }
    table[name] = Object.freeze(URLCfg_SpecFromMenuRow(row));
  }
  for (const name of Object.keys(OWN_CVARS)) {
    table[name] = Object.freeze({ ...OWN_CVARS[name] });
  }
  return Object.freeze(table);
}

/**
 * The cvars ?cfg.<name>= may set: name to { type: "float" | "int" | "bool",
 * min, max }. Built once at import from MENU_CVARS and OWN_CVARS.
 */
export const URLCFG_CVARS = URLCfg_BuildCvarTable();

/**
 * Parses one ?cfg. value for a cvar. Returns { value } (the string to give
 * Cvar_Set, rebuilt from the parsed number), or { error } saying why the value
 * was refused. A number outside the range is clamped, with { clamped: true }.
 */
export function URLCfg_ParseCvarValue(name, raw) {
  if (!Object.hasOwn(URLCFG_CVARS, name)) {
    return { error: "not a setting a link may change" };
  }
  if (raw.length > URLCFG_MAX_VALUE_LENGTH) return { error: "value too long" };
  const spec = URLCFG_CVARS[name];
  if (spec.type === "bool") {
    if (raw === "0" || raw === "1") return { value: raw, clamped: false };
    return { error: "expected 0 or 1" };
  }

  if (DECIMAL.test(raw) === false) return { error: "expected a number" };
  const n = Number(raw);
  if (spec.type === "int" && Number.isInteger(n) === false) {
    return { error: "expected a whole number" };
  }
  const v = Math.min(spec.max, Math.max(spec.min, n));
  return { value: String(v), clamped: v !== n };
}

/** The range of a cvar's allowlist entry, in words, for console messages */
function URLCfg_Expected(name) {
  const spec = URLCFG_CVARS[name];
  if (spec.type === "bool") return "0 or 1";
  return (spec.type === "int" ? "a whole number " : "a number ") +
    spec.min + " to " + spec.max;
}

/**
 * The ?cfg.<cvar>= parameters of params (a URLSearchParams): { cvars, messages }
 * where cvars is [[name, value]] in URL order (the last of a repeated name
 * wins) and messages says what was ignored or clamped.
 */
export function URLCfg_ParseCvars(params) {
  const found = new Map();
  const messages = [];
  let count = 0;
  for (const [key, raw] of params) {
    if (key.startsWith("cfg.") === false) continue;
    const name = key.slice(4);
    count++;
    if (count > URLCFG_MAX_CVARS) {
      if (count === URLCFG_MAX_CVARS + 1) {
        messages.push(
          "Ignoring cfg. parameters after the first " + URLCFG_MAX_CVARS,
        );
      }
      continue;
    }

    const result = URLCfg_ParseCvarValue(name, raw);
    if (result.error !== undefined) {
      messages.push(
        "Ignoring cfg." + name.slice(0, URLCFG_MAX_VALUE_LENGTH) + ' "' +
          raw.slice(0, URLCFG_MAX_VALUE_LENGTH) +
          '" (' + result.error + ")",
      );
      continue;
    }
    if (result.clamped === true) {
      messages.push(
        "cfg." + name + ' "' + raw + '" clamped to ' + result.value +
          " (expected " + URLCfg_Expected(name) + ")",
      );
    }
    found.delete(name); // a repeated name moves to its last position
    found.set(name, result.value);
  }
  return { cvars: [...found], messages };
}

// ?dpr=: a number (clamped to 0.5-4), 'native', or null when absent or
// invalid
function URLCfg_ParsePixelRatioValue(raw) {
  if (raw === null) return null;
  if (raw.toLowerCase() === "native") return "native";
  if (raw.trim() === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.min(4, Math.max(0.5, value));
}

/** The ?dpr= override (vid.js VID_GetPixelRatio): a number, 'native' or null */
export function URLCfg_PixelRatio(params) {
  return URLCfg_ParsePixelRatioValue(params.get("dpr"));
}

/** The ?scale= render scale (vid.js VID_Init): 0.25 to 1, 1 when absent */
export function URLCfg_RenderScale(params) {
  const value = parseFloat(params.get("scale"));
  if (!Number.isFinite(value)) return 1;
  return Math.min(1, Math.max(0.25, value));
}

/**
 * Reads the page's URL parameters (search is location.search or a
 * URLSearchParams). Returns a frozen object:
 * - game: { dir, mission } or null. mission is true for -rogue, -hipnotic
 *   and -quoth.
 * - base: ?base= as written (null if absent); the intro page decides the
 *   base, and URLCfg_BaseDirs checks it.
 * - particles: the -particles count as a string, or null
 * - listen: null, "" (-listen alone) or the count as a string
 * - agent: "lockstep", "realtime" or null; map: a checked map name or null;
 *   skill: 0-3 (1 when absent or invalid)
 * - cvars: [[name, value]] from ?cfg. (URLCfg_ParseCvars)
 * - messages: what was ignored, for the console
 */
export function URLCfg_Parse(search) {
  const params = search instanceof URLSearchParams ?
    search :
    new URLSearchParams(search);
  const messages = [];

  const gameArg = params.get("game");
  let game = null;
  // Mission packs match in any case, as in QuakeSpasm's q_strcasecmp
  const mission = gameArg !== null ? gameArg.toLowerCase() : null;
  if (URLCFG_MISSION_PACKS.includes(mission)) {
    game = Object.freeze({ dir: mission, mission: true });
  } else if (COM_GameDirIsValid(gameArg)) {
    game = Object.freeze({ dir: gameArg, mission: false });
  } else if (gameArg !== null) {
    messages.push(
      'Ignoring game "' + gameArg.slice(0, URLCFG_MAX_VALUE_LENGTH) +
        '" (expected a directory name: up to 32 letters, digits, _ and -,' +
        " not id1 or a base)",
    );
  }

  let particles = params.get("particles");
  if (
    particles !== null &&
    (PARTICLES_ARG.test(particles) === false ||
      Number(particles) > URLCFG_PARTICLES_MAX)
  ) {
    messages.push(
      'Ignoring particles "' + particles +
        '" (expected a whole number up to ' + URLCFG_PARTICLES_MAX + ")",
    );
    particles = null;
  }

  let listen = params.get("listen");
  if (listen !== null && listen !== "" && LISTEN_ARG.test(listen) === false) {
    messages.push('Ignoring listen "' + listen + '" (expected a player count)');
    listen = null;
  }

  const agentArg = params.get("agent");
  const agent = AGENT_MODES.includes(agentArg) ? agentArg : null;
  if (agentArg !== null && agent === null) {
    messages.push(
      'Ignoring agent "' + agentArg + '" (expected ' + AGENT_MODES.join(", ") +
        ")",
    );
  }

  let map = params.get("map");
  if (map !== null && AGENT_MAP_ARG.test(map) === false) {
    messages.push(
      'Ignoring map "' + map + '" (expected letters, digits and _)',
    );
    map = null;
  }
  const skillArg = params.get("skill");
  const skill = skillArg !== null && SKILL_ARG.test(skillArg) ?
    Number(skillArg) :
    1;

  const dprArg = params.get("dpr");
  if (dprArg !== null && URLCfg_ParsePixelRatioValue(dprArg) === null) {
    messages.push(
      'Ignoring dpr "' + dprArg + '" (expected a number or native)',
    );
  }
  const scaleArg = params.get("scale");
  if (scaleArg !== null && !Number.isFinite(parseFloat(scaleArg))) {
    messages.push('Ignoring scale "' + scaleArg + '" (expected a number)');
  }

  const cfg = URLCfg_ParseCvars(params);
  messages.push(...cfg.messages);

  return Object.freeze({
    game,
    base: params.get("base"),
    particles,
    listen,
    agent,
    map,
    skill,
    cvars: Object.freeze(cfg.cvars),
    messages: Object.freeze(messages),
  });
}

/**
 * The command line URLCfg_Parse's result stands for, as COM_InitArgv takes
 * it: [] when there is nothing to pass, otherwise "quake" and the flags.
 * withGame false leaves ?game= out (main.js: the link asked for a pack of
 * id's data that this browser doesn't have, so LibreQuake plays without it).
 */
export function URLCfg_Argv(cfg, withGame = true) {
  const args = [];
  if (withGame === true && cfg.game !== null) {
    if (cfg.game.mission === true) args.push("-" + cfg.game.dir);
    else args.push("-game", cfg.game.dir);
  }
  if (cfg.particles !== null) args.push("-particles", cfg.particles);
  if (cfg.listen === "") args.push("-listen");
  else if (cfg.listen !== null) args.push("-listen", cfg.listen);
  return args.length === 0 ? [] : ["quake", ...args];
}

/**
 * The directories for a base the intro page settled on (Intro_Gate's result):
 * { basedir, id1dir, message } where message is null, or says an unknown base
 * was ignored (and static/ is used, as for id's data).
 */
export function URLCfg_BaseDirs(base) {
  if (base !== null && Object.hasOwn(URLCFG_BASE_DIRS, base)) {
    const basedir = URLCFG_BASE_DIRS[base];
    return { basedir, id1dir: basedir + "/id1", message: null };
  }
  return {
    basedir: "static",
    id1dir: "static",
    message: base === null ? null : 'Ignoring unknown base "' + base +
      '" (expected ' + Object.keys(URLCFG_BASE_DIRS).join(", ") + ")",
  };
}
