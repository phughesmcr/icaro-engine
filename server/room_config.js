// Room config limits and validation, shared by the Deno lobby
// (room_process_manager.ts re-exports these under its RoomManager_ names)
// and the Cloudflare lobby Worker (cloudflare/lobby/). Pure functions with no
// Deno or Worker APIs, so both can import this file.

export const MAX_PLAYERS_LIMIT = 16; // MAX_SCOREBOARD in quakedef.h
export const DEFAULT_MAX_PLAYERS = 4;
export const DEFAULT_MAP = "start";
export const DEFAULT_HOST_NAME = "Player";
export const MAX_HOST_NAME_BYTES = 32;
export const MAX_MAP_NAME_LENGTH = 32;

/**
 * Clamp a requested player limit to an integer in 1..MAX_PLAYERS_LIMIT.
 * Non-numeric input gets the default.
 */
export function Room_ClampMaxPlayers(value) {
  const n = typeof value === "number" ?
    value :
    typeof value === "string" ?
    Number(value) :
    NaN;
  if (Number.isFinite(n) === false) return DEFAULT_MAX_PLAYERS;
  const i = Math.floor(n);
  if (i < 1) return 1;
  if (i > MAX_PLAYERS_LIMIT) return MAX_PLAYERS_LIMIT;
  return i;
}

/**
 * Game options a client may request for a new room: the Game Options menu's
 * rows (WinQuake/menu.c M_GameOptions_Key). Each field maps to the cvar of
 * the same name, and each range is the one that menu allows.
 */
export const GAME_OPTION_RANGES = {
  coop: [0, 1],
  teamplay: [0, 2], // 0..6 under Rogue (menu.c: count = rogue ? 6 : 2)
  skill: [0, 3],
  fraglimit: [0, 100],
  timelimit: [0, 60],
};

/**
 * Whitelist and clamp a client's requested game options. Only the known
 * fields are read, only finite numbers are accepted (truncated to integers
 * and clamped to the menu's range); anything else is dropped so the room
 * keeps its default for that cvar. Returns undefined when nothing valid was
 * requested, so a request without options behaves as before. `rogue` widens
 * teamplay to Rogue's range.
 */
export function Room_SanitizeGameOptions(value, rogue = false) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const out = {};
  let any = false;
  for (const key of Object.keys(GAME_OPTION_RANGES)) {
    if (Object.prototype.hasOwnProperty.call(value, key) === false) continue;
    const n = value[key];
    if (typeof n !== "number" || Number.isFinite(n) === false) continue;
    let max = GAME_OPTION_RANGES[key][1];
    if (key === "teamplay" && rogue === true) max = 6;
    // + 0 turns -0 into 0
    out[key] =
      Math.max(GAME_OPTION_RANGES[key][0], Math.min(max, Math.trunc(n))) + 0;
    any = true;
  }
  return any ? out : undefined;
}

/**
 * Strip control characters, collapse whitespace and cap at
 * MAX_HOST_NAME_BYTES of UTF-8 (without splitting a code point).
 */
export function Room_SanitizeHostName(value) {
  if (typeof value !== "string") return DEFAULT_HOST_NAME;
  // deno-lint-ignore no-control-regex
  let name = value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, "")
    .replace(/\s+/g, " ").trim();
  const encoder = new TextEncoder();
  if (encoder.encode(name).length > MAX_HOST_NAME_BYTES) {
    let out = "";
    let bytes = 0;
    for (const ch of name) {
      const len = encoder.encode(ch).length;
      if (bytes + len > MAX_HOST_NAME_BYTES) break;
      out += ch;
      bytes += len;
    }
    name = out.trim();
  }
  return name.length > 0 ? name : DEFAULT_HOST_NAME;
}

/**
 * Map names may only contain [A-Za-z0-9_] and be at most
 * MAX_MAP_NAME_LENGTH long. Returns null if the name is invalid.
 */
export function Room_SanitizeMapName(value) {
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > MAX_MAP_NAME_LENGTH) return null;
  if (/^[A-Za-z0-9_]+$/.test(value) === false) return null;
  return value;
}
