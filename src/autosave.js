// Web-only addition, no Quake equivalent (mobile roadmap Tier 2 item 14).
//
// iOS discards background tabs, so a single-player game is lost when the
// player switches apps. host_cmd.js Host_AutoSave writes the game into a
// reserved save slot when the page is hidden, and Host_MaybeOfferContinue
// offers to load it on the next page load. This module holds the rules that
// need no engine state, so they can be tested on their own.
//
// Rules:
// - The save goes into the slot "autosave" (localStorage "quake_save_autosave"),
//   which the Save/Load menus (s0-s11) never show or overwrite.
// - A small record in AUTOSAVE_META_KEY says the slot holds a game worth
//   offering. It is written with the save and cleared ("consumed") when the
//   player accepts or declines the offer, starts a new game with `map`, or
//   comes back to the same page (visible again: the game is still in memory,
//   so there is nothing to recover). A record older than AUTOSAVE_MAX_AGE_MS
//   is stale and ignored.
// - The offer is skipped when the page was opened with ?room=, ?map= or
//   ?agent= (those start their own game or are driven by an agent).

export const AUTOSAVE_SLOT = "autosave";
export const AUTOSAVE_META_KEY = "quake_autosave_meta";
export const AUTOSAVE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// The page opened with a URL that decides what to play itself
export function Autosave_UrlBlocksOffer(search) {
  const params = new URLSearchParams(search);
  return params.has("room") || params.has("map") || params.has("agent");
}

export function Autosave_EncodeMeta(now, mapname) {
  return JSON.stringify({ t: now, map: mapname });
}

// Returns { t, map }, or null for a missing, malformed, stale or future record
export function Autosave_ParseMeta(text, now) {
  if (text === null || text === undefined) return null;

  let meta;
  try {
    meta = JSON.parse(text);
  } catch {
    return null;
  }

  if (meta === null || typeof meta !== "object") return null;
  if (
    typeof meta.t !== "number" || !Number.isFinite(meta.t) ||
    typeof meta.map !== "string"
  ) return null;
  if (meta.t > now || now - meta.t > AUTOSAVE_MAX_AGE_MS) return null;
  return { t: meta.t, map: meta.map };
}

/*
state: { search, now, metaText, saveExists, connected (a game is running or
connecting), dedicated, modalActive, ready (the host has run a few frames) }
Returns 'wait' (try again next frame), 'skip' (never offer this page load)
or 'offer'.
*/
export function Autosave_OfferDecision(state) {
  if (state.dedicated === true) return "skip"; // SCR_ModalMessage would answer yes
  if (Autosave_UrlBlocksOffer(state.search)) return "skip";
  if (state.connected === true) return "skip"; // the player already started a game
  if (Autosave_ParseMeta(state.metaText, state.now) === null) return "skip";
  if (state.saveExists !== true) return "skip";
  if (state.ready !== true || state.modalActive === true) return "wait";
  return "offer";
}

function storage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function Autosave_ReadMeta() {
  const ls = storage();
  if (ls === null) return null;
  try {
    return ls.getItem(AUTOSAVE_META_KEY);
  } catch {
    return null;
  }
}

export function Autosave_WriteMeta(now, mapname) {
  const ls = storage();
  if (ls === null) return false;
  try {
    ls.setItem(AUTOSAVE_META_KEY, Autosave_EncodeMeta(now, mapname));
    return true;
  } catch {
    return false;
  }
}

// Mark the autosave consumed: nothing is offered until the next one is written
export function Autosave_Consume() {
  const ls = storage();
  if (ls === null) return;
  try {
    ls.removeItem(AUTOSAVE_META_KEY);
  } catch {
    // ignore
  }
}
