// Web addition: the game rules a multiplayer room applies before its map
// spawns. server/game_server.js uses them for lobby rooms. A room hosted in a
// browser (docs/browser-hosted-rooms.md) takes its exit rules from
// Room_ExitRuleValues (M_HostInBrowser in menu.js) and its game options from
// the menu's cvars, so both kinds of room behave alike.
// Moved here from server/game_server.js.
//
// Call these before SV_SpawnServer, while sv.active is false: noexit is a
// server cvar, and setting it on a running server broadcasts the change.

import { Sys_Printf } from "./sys.js";
import { Cvar_FindVar, Cvar_RegisterVariable, Cvar_SetValue } from "./cvar.js";
import {
  coop,
  deathmatch,
  fraglimit,
  noexit,
  samelevel,
  skill,
  teamplay,
  timelimit,
} from "./host.js";

/**
 * menu.c M_GameOptions_Key sets coop, teamplay, skill, fraglimit and timelimit
 * before "map". Same here. Only the options given are touched; with none, the
 * room is exactly as before. In the dedicated room these cvars are not
 * registered (Host_InitLocal never runs there), so register them first or
 * Cvar_SetValue finds nothing.
 */
export function Room_ApplyGameOptions(options) {
  const cvars = { coop, teamplay, skill, fraglimit, timelimit };
  for (const name of Object.keys(cvars)) {
    if (Object.hasOwn(options, name) === false) continue;
    if (Cvar_FindVar(name) === null) Cvar_RegisterVariable(cvars[name]);
    Cvar_SetValue(name, options[name]);
  }

  // SV_SpawnServer zeroes deathmatch when coop is set, but only through the
  // cvar list, where the dedicated room keeps deathmatch unregistered.
  if (options.coop === 1) {
    deathmatch.value = 0;
    deathmatch.string = "0";
  }
}

/** The noexit and samelevel values Room_ApplyExitRules sets. */
export function Room_ExitRuleValues(options) {
  const coopRoom = options.coop === 1;
  return { noexit: coopRoom ? 0 : 1, samelevel: coopRoom ? 0 : 2 };
}

/**
 * Deliberate deviation from a C listen server, which leaves both at 0: a
 * deathmatch room keeps its map. noexit 1 makes id1's changelevel_touch kill a
 * player who walks into an exit, and samelevel 2 makes GotoNextMap reload the
 * same map after a fraglimit or timelimit intermission (QuakeC treats any
 * non-zero samelevel that way). A co-op room plays through the episode, so
 * both are 0 there, as in a C co-op game. QuakeC reads them with cvar(), which
 * goes through the cvar list; the dedicated room never registers them in
 * Host_InitLocal, so register them first.
 */
export function Room_ApplyExitRules(options) {
  const coopRoom = options.coop === 1;
  const rules = Room_ExitRuleValues(options);
  for (
    const [cvar, value] of [[noexit, rules.noexit], [
      samelevel,
      rules.samelevel,
    ]]
  ) {
    if (Cvar_FindVar(cvar.name) === null) Cvar_RegisterVariable(cvar);
    Cvar_SetValue(cvar.name, value);
  }

  Sys_Printf(
    "Level exits: noexit %d, samelevel %d%s\n",
    noexit.value,
    samelevel.value,
    coopRoom ?
      " (co-op: exits change the map)" :
      " (exits kill the player; the room keeps its map)",
  );
}
