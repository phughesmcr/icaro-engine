// Touch HUD layouts: saved profiles of where the touch buttons sit, how big
// they are, which are hidden, and the player's own command buttons.
//
// Web-only, no C counterpart. touch.js places its buttons from the active
// profile, and touch_editor.js edits it. Profiles live in localStorage as
// JSON; whatever is read back is checked and clamped, and a bad copy falls
// back to the defaults instead of throwing.
//
// Positions use touch.js's layout units: px at touch_size 1, the centre
// measured from the bottom edge and from the action-side edge (the right, or
// the left when touch_lefthanded mirrors the layout). touch_size and the
// mirror still apply on top.

const STORAGE_KEY = "icaro_touch_layouts";

export const TL_MAX_PROFILES = 8;
export const TL_MAX_CUSTOM = 8;
export const TL_MAX_LABEL = 6;
export const TL_MAX_COMMAND = 128;
export const TL_MAX_NAME = 16;
export const TL_MIN_SIZE = 32;
export const TL_MAX_SIZE = 160;
const TL_MAX_POS = 4000;

// The custom buttons' key numbers for +commands ("+attack 1001"), as
// keys.c passes a key number, so each button holds its kbutton on its own.
// Above every real key (keys.js), and never 0 or -1, which KeyUp treats as
// "release all".
export const TL_CUSTOM_KEY_BASE = 1000;

/**
 * The buttons a profile can move and resize, with their default centre and
 * size (what Touch_Layout used before profiles). FIRE is 88 px across, its
 * centre 100 px in from the action edge and 112 px up.
 *
 * Only JUMP sits low in the corner: a phone's status bar (about 480 x 72 px
 * in landscape) leaves just 93 px beside it on a 667 px screen. The rest
 * start above that bar; Touch_Layout lifts them further where the HUD is in
 * the way (tablets, scr_sbarscale, deathmatch, the modern HUD's corners).
 */
// deno-fmt-ignore -- a table reads better in rows
export const TL_MOVABLE = [
  { id: "touch-fire",        label: "FIRE", cx: 100, cy: 112, size: 88 },
  { id: "touch-jump",        label: "JUMP", cx: 48,  cy: 48,  size: 64 },
  { id: "touch-weapon-next", label: "WPN▶", cx: 96,  cy: 206, size: 56 },
  { id: "touch-weapon-prev", label: "◀",    cx: 168, cy: 176, size: 44 },
  { id: "touch-movedown",    label: "DOWN", cx: 176, cy: 100, size: 44 }, // beside FIRE, over the status bar (was 148, 40: on it)
];

/** The top bar's buttons: these can only be hidden (the bar lays them out) */
export const TL_HIDE_ONLY = [
  { id: "touch-quicksave", label: "SAVE" },
  { id: "touch-quickload", label: "LOAD" },
  { id: "touch-console", label: "CON" },
  { id: "touch-chat", label: "CHAT" },
];

// Where a new custom button starts: inside FIRE and DOWN, towards the middle
const CUSTOM_CX = 240;
const CUSTOM_CY = 110;
const CUSTOM_SIZE = 52;

/**
 * Bumped on every change, so touch.js knows to lay the buttons out again.
 */
export let tl_version = 0;

let store = null; // { active, profiles: [{ name, buttons, custom }] }

function TL_Clamp(v, lo, hi, fallback) {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return v < lo ? lo : (v > hi ? hi : v);
}

function TL_Text(v, max) {
  if (typeof v !== "string") return "";
  // One line: a newline in a command would end it early in the buffer
  return v.replace(/[\r\n]+/g, " ").slice(0, max);
}

/** A profile with every button where Touch_Layout always put it */
export function TL_NewProfile(name) {
  return { name, buttons: {}, custom: [] };
}

function TL_ValidId(id) {
  for (const b of TL_MOVABLE) if (b.id === id) return true;
  for (const b of TL_HIDE_ONLY) if (b.id === id) return true;
  return false;
}

function TL_Default(id) {
  for (const b of TL_MOVABLE) if (b.id === id) return b;
  return null;
}

function TL_CheckButton(id, o) {
  const d = TL_Default(id);
  const out = {
    hidden: o !== null && typeof o === "object" && o.hidden === true,
  };
  if (d !== null && o !== null && typeof o === "object") {
    out.cx = TL_Clamp(o.cx, 0, TL_MAX_POS, d.cx);
    out.cy = TL_Clamp(o.cy, 0, TL_MAX_POS, d.cy);
    out.size = TL_Clamp(o.size, TL_MIN_SIZE, TL_MAX_SIZE, d.size);
  }
  return out;
}

function TL_CheckCustom(o) {
  if (o === null || typeof o !== "object") return null;
  return {
    label: TL_Text(o.label, TL_MAX_LABEL),
    command: TL_Text(o.command, TL_MAX_COMMAND),
    cx: TL_Clamp(o.cx, 0, TL_MAX_POS, CUSTOM_CX),
    cy: TL_Clamp(o.cy, 0, TL_MAX_POS, CUSTOM_CY),
    size: TL_Clamp(o.size, TL_MIN_SIZE, TL_MAX_SIZE, CUSTOM_SIZE),
    hidden: o.hidden === true,
  };
}

function TL_CheckProfile(p, fallbackName) {
  if (p === null || typeof p !== "object") return null;
  const name = TL_Text(p.name, TL_MAX_NAME).trim();
  const out = TL_NewProfile(name !== "" ? name : fallbackName);
  if (p.buttons !== null && typeof p.buttons === "object") {
    for (const id of Object.keys(p.buttons)) {
      if (TL_ValidId(id)) out.buttons[id] = TL_CheckButton(id, p.buttons[id]);
    }
  }
  if (Array.isArray(p.custom)) {
    for (const c of p.custom) {
      if (out.custom.length >= TL_MAX_CUSTOM) break;
      const checked = TL_CheckCustom(c);
      if (checked !== null) out.custom.push(checked);
    }
  }
  return out;
}

/**
 * Reads a stored layout set from JSON text, checking and clamping every
 * field. Anything unreadable gives the default set (one default profile).
 */
export function TL_Parse(text) {
  let data = null;
  try {
    data = typeof text === "string" ? JSON.parse(text) : null;
  } catch (_e) {
    data = null;
  }

  const out = { active: "", profiles: [] };
  if (
    data !== null && typeof data === "object" && Array.isArray(data.profiles)
  ) {
    for (const p of data.profiles) {
      if (out.profiles.length >= TL_MAX_PROFILES) break;
      const checked = TL_CheckProfile(p, "Layout " + (out.profiles.length + 1));
      if (checked === null) continue;
      checked.name = TL_UniqueName(out.profiles, checked.name, null);
      out.profiles.push(checked);
    }
  }
  if (out.profiles.length === 0) out.profiles.push(TL_NewProfile("Layout 1"));

  out.active = out.profiles[0].name;
  if (data !== null && typeof data === "object") {
    for (const p of out.profiles) {
      if (p.name === data.active) out.active = p.name;
    }
  }
  return out;
}

// name, or name 2, name 3... so no two profiles share one (skip: a profile
// that may keep its own name)
function TL_UniqueName(profiles, name, skip) {
  const taken = (n) => profiles.some((p) => p !== skip && p.name === n);
  if (!taken(name)) return name;
  for (let i = 2;; i++) {
    const suffix = " " + i;
    const n = name.slice(0, TL_MAX_NAME - suffix.length) + suffix;
    if (!taken(n)) return n;
  }
}

let storageOverride = undefined; // set by tests (TL_SetStorage)

/** Uses s ({getItem, setItem}, or null for none) instead of localStorage */
export function TL_SetStorage(s) {
  storageOverride = s;
}

function TL_Storage() {
  if (storageOverride !== undefined) return storageOverride;
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch (_e) {
    return null; // storage blocked (private mode, sandboxed frame)
  }
}

/** The layout set, read from storage the first time */
export function TL_Store() {
  if (store === null) {
    const ls = TL_Storage();
    let text = null;
    try {
      text = ls !== null ? ls.getItem(STORAGE_KEY) : null;
    } catch (_e) {
      text = null;
    }
    store = TL_Parse(text);
  }
  return store;
}

/** Replaces the layout set (tests, and TL_Parse results) */
export function TL_SetStore(s) {
  store = s;
  tl_version++;
}

/** Writes the layout set to storage */
export function TL_Save() {
  const ls = TL_Storage();
  if (ls === null || store === null) return;
  try {
    ls.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch (e) {
    console.log("Touch layouts: could not save:", e.message);
  }
}

function TL_Changed() {
  tl_version++;
  TL_Save();
}

/** The profile in use */
export function TL_Active() {
  const s = TL_Store();
  for (const p of s.profiles) if (p.name === s.active) return p;
  s.active = s.profiles[0].name;
  return s.profiles[0];
}

/**
 * Fills out with button id's centre, size and hidden flag in the active
 * profile (its defaults where the profile doesn't move it). Returns out.
 */
export function TL_Button(id, out) {
  const d = TL_Default(id);
  const o = TL_Active().buttons[id];
  out.cx = d !== null ? d.cx : 0;
  out.cy = d !== null ? d.cy : 0;
  out.size = d !== null ? d.size : 0;
  out.hidden = false;
  if (o !== undefined) {
    if (o.cx !== undefined) out.cx = o.cx;
    if (o.cy !== undefined) out.cy = o.cy;
    if (o.size !== undefined) out.size = o.size;
    out.hidden = o.hidden;
  }
  return out;
}

/** Is button id hidden in the active profile */
export function TL_Hidden(id) {
  const o = TL_Active().buttons[id];
  return o !== undefined && o.hidden === true;
}

/**
 * Is (cx, cy) button id's default centre. Touch_Layout lifts only these
 * clear of the status bar: a centre the player dragged stays where they put
 * it. A hide or resize stores the default centre too, so it still counts.
 */
export function TL_AtDefault(id, cx, cy) {
  const d = TL_Default(id);
  return d !== null && cx === d.cx && cy === d.cy;
}

// The HUD
//
// Touch_Layout keeps the default buttons off the HUD (the status bar and its
// numbers, or the modern HUD's corners), from sbar.js's Sbar_GetFootprint.
// These work in CSS px on the screen, measured from the action-side edge (the
// right, or the left when mirrored) and up from the bottom edge.

/** Gap kept between a button and the HUD, px */
export const TL_HUD_MARGIN = 4;

/**
 * Fills out with a footprint rectangle ({ x, y, w, h } from the top left of
 * a vw x vh screen) as { near, far, bottom, top }: its distances from the
 * action-side edge and from the bottom edge. Returns out.
 */
export function TL_HudEdges(rect, vw, vh, mirror, out) {
  out.near = mirror ? rect.x : vw - rect.x - rect.w;
  out.far = mirror ? rect.x + rect.w : vw - rect.x;
  out.bottom = vh - rect.y - rect.h;
  out.top = vh - rect.y;
  return out;
}

/**
 * Does a button, a circle (centre x px in from the action-side edge and y px
 * up, safe-area insets included; size: its diameter), come within margin px
 * (TL_HUD_MARGIN if left out) of HUD rectangle e (TL_HudEdges)? An empty
 * rectangle covers nothing.
 */
export function TL_HudOverlap(x, y, size, e, margin = TL_HUD_MARGIN) {
  if (!(e.far > e.near) || !(e.top > e.bottom)) return false;
  const dx = Math.max(e.near - x, 0, x - e.far);
  const dy = Math.max(e.bottom - y, 0, y - e.top);
  const reach = size / 2 + margin;
  return dx * dx + dy * dy < reach * reach;
}

// Is HUD rectangle e along the bottom edge: nearer it than half its own
// height (the status bar, the modern HUD's corners and ammo strip; not its
// weapon column)
function TL_AlongBottom(e) {
  return e.bottom < (e.top - e.bottom) / 2;
}

// Would raising every button by lift clear every rectangle? (only those
// along the bottom edge when bottomOnly)
function TL_LiftClears(buttons, n, edges, m, lift, bottomOnly) {
  for (let j = 0; j < m; j++) {
    const e = edges[j];
    if (bottomOnly && !TL_AlongBottom(e)) continue;
    for (let i = 0; i < n; i++) {
      const b = buttons[i];
      if (TL_HudOverlap(b.x, b.y + lift, b.size, e)) return false;
    }
  }
  return true;
}

// The smallest of 0 and the lifts that set a button just over a rectangle
// that clears them all, up to maxLift; -1 if none does
function TL_LeastLift(buttons, n, edges, m, maxLift, bottomOnly) {
  if (TL_LiftClears(buttons, n, edges, m, 0, bottomOnly)) return 0;
  let best = -1;
  for (let j = 0; j < m; j++) {
    const e = edges[j];
    if (!(e.far > e.near) || !(e.top > e.bottom)) continue;
    if (bottomOnly && !TL_AlongBottom(e)) continue;
    for (let i = 0; i < n; i++) {
      const b = buttons[i];
      const lift = e.top + TL_HUD_MARGIN - (b.y - b.size / 2);
      if (lift <= 0 || lift > maxLift || (best >= 0 && lift >= best)) continue;
      if (TL_LiftClears(buttons, n, edges, m, lift, bottomOnly)) best = lift;
    }
  }
  return best;
}

/**
 * How far to raise the default buttons, all together so they keep their
 * spacing, to clear the HUD: the least lift up to maxLift that takes every
 * button (the first n of buttons, { x, y, size } as TL_HudOverlap takes them)
 * off every rectangle (the first m of edges, from TL_HudEdges). Where none
 * does (a rectangle part way up the screen, like the modern HUD's weapon
 * column, in the way at every height), the least lift that clears those
 * along the bottom edge; failing that, 0.
 */
export function TL_HudLift(buttons, n, edges, m, maxLift) {
  let lift = TL_LeastLift(buttons, n, edges, m, maxLift, false);
  if (lift < 0) lift = TL_LeastLift(buttons, n, edges, m, maxLift, true);
  return lift < 0 ? 0 : lift;
}

/**
 * Moves, resizes or hides a built-in button in the active profile. Fields
 * left undefined keep their value. save: write storage now (false while
 * dragging; the editor saves on release).
 */
export function TL_SetButton(id, cx, cy, size, hidden, save) {
  if (!TL_ValidId(id)) return;
  const p = TL_Active();
  const cur = TL_Button(id, { cx: 0, cy: 0, size: 0, hidden: false });
  const o = { hidden: hidden !== undefined ? hidden === true : cur.hidden };
  if (TL_Default(id) !== null) {
    o.cx = TL_Clamp(cx !== undefined ? cx : cur.cx, 0, TL_MAX_POS, cur.cx);
    o.cy = TL_Clamp(cy !== undefined ? cy : cur.cy, 0, TL_MAX_POS, cur.cy);
    o.size = TL_Clamp(
      size !== undefined ? size : cur.size,
      TL_MIN_SIZE,
      TL_MAX_SIZE,
      cur.size,
    );
  }
  p.buttons[id] = o;
  if (save === false) tl_version++;
  else TL_Changed();
}

/**
 * Moves a built-in button during a drag, in place: no allocation once the
 * button has an override. Not saved; TL_Save does that when the drag ends.
 */
export function TL_MoveButton(id, cx, cy) {
  if (TL_Default(id) === null) return;
  const o = TL_Active().buttons[id];
  if (o === undefined || o.cx === undefined) {
    TL_SetButton(id, cx, cy, undefined, undefined, false);
    return;
  }
  o.cx = TL_Clamp(cx, 0, TL_MAX_POS, o.cx);
  o.cy = TL_Clamp(cy, 0, TL_MAX_POS, o.cy);
  tl_version++;
}

/** Moves custom button i during a drag, in place; not saved */
export function TL_MoveCustom(i, cx, cy) {
  const c = TL_Active().custom[i];
  if (c === undefined) return;
  c.cx = TL_Clamp(cx, 0, TL_MAX_POS, c.cx);
  c.cy = TL_Clamp(cy, 0, TL_MAX_POS, c.cy);
  tl_version++;
}

/** Changes custom button i of the active profile; undefined fields stay */
export function TL_SetCustom(i, fields, save) {
  const p = TL_Active();
  const c = p.custom[i];
  if (c === undefined) return;
  const next = TL_CheckCustom({
    label: fields.label !== undefined ? fields.label : c.label,
    command: fields.command !== undefined ? fields.command : c.command,
    cx: fields.cx !== undefined ? fields.cx : c.cx,
    cy: fields.cy !== undefined ? fields.cy : c.cy,
    size: fields.size !== undefined ? fields.size : c.size,
    hidden: fields.hidden !== undefined ? fields.hidden : c.hidden,
  });
  p.custom[i] = next;
  if (save === false) tl_version++;
  else TL_Changed();
}

/** Adds a custom button to the active profile; its index, or -1 when full */
export function TL_AddCustom(label, command) {
  const p = TL_Active();
  if (p.custom.length >= TL_MAX_CUSTOM) return -1;
  // Each new one a little further in, so they don't stack exactly
  const n = p.custom.length;
  p.custom.push(TL_CheckCustom({
    label,
    command,
    cx: CUSTOM_CX + 24 * (n % 4),
    cy: CUSTOM_CY + 24 * Math.floor(n / 4),
    size: CUSTOM_SIZE,
  }));
  TL_Changed();
  return n;
}

export function TL_RemoveCustom(i) {
  const p = TL_Active();
  if (i < 0 || i >= p.custom.length) return;
  p.custom.splice(i, 1);
  TL_Changed();
}

/** Puts the built-in buttons back where they started; custom ones stay */
export function TL_ResetButtons() {
  TL_Active().buttons = {};
  TL_Changed();
}

/** Switches profile by name; false if there is none */
export function TL_SetActive(name) {
  const s = TL_Store();
  for (const p of s.profiles) {
    if (p.name === name) {
      s.active = name;
      TL_Changed();
      return true;
    }
  }
  return false;
}

/**
 * Adds a profile copied from the active one and switches to it. Returns its
 * name, or null when there are TL_MAX_PROFILES already.
 */
export function TL_AddProfile() {
  const s = TL_Store();
  if (s.profiles.length >= TL_MAX_PROFILES) return null;
  const copy = TL_CheckProfile(JSON.parse(JSON.stringify(TL_Active())), "");
  copy.name = TL_UniqueName(
    s.profiles,
    "Layout " + (s.profiles.length + 1),
    null,
  );
  s.profiles.push(copy);
  s.active = copy.name;
  TL_Changed();
  return copy.name;
}

/** Renames the active profile; returns the name it got (made unique) */
export function TL_RenameActive(name) {
  const s = TL_Store();
  const p = TL_Active();
  const n = TL_Text(name, TL_MAX_NAME).trim();
  if (n === "") return p.name;
  p.name = TL_UniqueName(s.profiles, n, p);
  s.active = p.name;
  TL_Changed();
  return p.name;
}

/** Deletes the active profile (never the last); the first one takes over */
export function TL_DeleteActive() {
  const s = TL_Store();
  if (s.profiles.length <= 1) return false;
  s.profiles.splice(s.profiles.indexOf(TL_Active()), 1);
  s.active = s.profiles[0].name;
  TL_Changed();
  return true;
}

/**
 * What a custom button runs when pressed, as keys.c's Key_Event runs a
 * binding: a +command gets the key number so its release can match it.
 */
export function TL_BindDown(command, key) {
  if (command === "") return "";
  if (command[0] === "+") return command + " " + key + "\n";
  return command + "\n";
}

/** What it runs on release: the -command for a +command, else nothing */
export function TL_BindUp(command, key) {
  if (command === "" || command[0] !== "+") return "";
  return "-" + command.slice(1) + " " + key + "\n";
}
