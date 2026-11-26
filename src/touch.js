// Touch controls for mobile devices
//
// In game: a floating move stick on the left (nipplejs), drag-to-look on the
// right, FIRE and JUMP buttons that also aim while held, DOWN (swim down),
// weapon next/prev (hold WPN▶ for a weapon wheel) and a menu button, with a
// row of SAVE, LOAD, CON and CHAT beside it. Optional gyro aiming. Mirrored
// with touch_lefthanded.
// In menus and the console: tap-to-select, drag for arrow keys, and a small
// bar with Back and an on-screen keyboard button.

import {
  K_BACKSPACE,
  K_DOWNARROW,
  K_ENTER,
  K_ESCAPE,
  K_LEFTARROW,
  K_RIGHTARROW,
  K_UPARROW,
  Key_Event,
} from "./keys.js";
import { in_attack, in_down, in_jump } from "./cl_input.js";
import { ca_connected, cl, cls } from "./client.js";
import { sv, svs } from "./server.js";
import {
  IT_AXE,
  IT_GRENADE_LAUNCHER,
  IT_LIGHTNING,
  IT_NAILGUN,
  IT_ROCKET_LAUNCHER,
  IT_SHOTGUN,
  IT_SUPER_NAILGUN,
  IT_SUPER_SHOTGUN,
  STAT_CELLS,
  STAT_NAILS,
  STAT_ROCKETS,
  STAT_SHELLS,
} from "./quakedef.js";
import { S_UnlockAudio } from "./snd_dma.js";
import { VID_IsTouchPrimary } from "./vid.js";
import {
  Cvar_FindVar,
  Cvar_RegisterVariable,
  Cvar_SetValue,
  cvar_t,
} from "./cvar.js";
import { Cbuf_AddText } from "./cmd.js";
import { Con_SetNotifyTop } from "./console.js";

// CVARS (archived, set from the Touch Controls menu)

// Web-only: how wide the server's autoaim cone is, 0 (off) to 4. See
// Touch_AimAssistFrame.
export const touch_aimassist = new cvar_t("touch_aimassist", "2", true);
export const touch_sensitivity = new cvar_t("touch_sensitivity", "1", true); // drag look speed
export const touch_gyro = new cvar_t("touch_gyro", "0", true); // gyro aiming on/off
export const touch_gyro_sensitivity = new cvar_t(
  "touch_gyro_sensitivity",
  "1",
  true,
); // 1 = real-world degrees
export const touch_size = new cvar_t("touch_size", "1", true); // button scale
export const touch_opacity = new cvar_t("touch_opacity", "0.6", true);
export const touch_lefthanded = new cvar_t("touch_lefthanded", "0", true); // mirror the layout
export const touch_haptics = new cvar_t("touch_haptics", "1", true); // vibrate on button press (Android)

export function Touch_RegisterCvars() {
  Cvar_RegisterVariable(touch_aimassist);
  Cvar_RegisterVariable(touch_sensitivity);
  Cvar_RegisterVariable(touch_gyro);
  Cvar_RegisterVariable(touch_gyro_sensitivity);
  Cvar_RegisterVariable(touch_size);
  Cvar_RegisterVariable(touch_opacity);
  Cvar_RegisterVariable(touch_lefthanded);
  Cvar_RegisterVariable(touch_haptics);
}

// Degrees of view rotation per CSS pixel of drag at touch_sensitivity 1
// (the same speed as before touch_sensitivity existed)
const LOOK_DEGREES_PER_PX = 0.4;

// STATE

let enabled = false;
let initialized = false;
let menuOverlay = null;
let menuShown = false; // the menu overlay takes taps (Touch_ShowMenu)
let menuTouchCallback = null;
let menuSurfaceGetter = null; // returns the element the menu is drawn into
let fullscreenActivated = false;
let fullscreenPending = false;
let wakeLock = null;
let wakeLockPending = false;

// Movement stick (nipplejs, loaded on demand from the import map)
const JOYSTICK_SIZE = 120; // px, at touch_size 1
const JOYSTICK_DEADZONE = 0.15; // fraction of the radius
const JOYSTICK_FULL = 0.9; // deflection that gives full speed (the thumb rarely reaches the rim)
let nipplejs = null;
let nippleLoad = null;
let stickManager = null;

// Look area (drag to look)
let lookTouch = null;
const lastLookPos = { x: 0, y: 0 };

// Menu touch (tap to select, drag to send arrow keys)
const MENU_DRAG_STEP = 24; // px of drag per arrow key
let menuTouch = null;
let menuDragging = false;
let menuDragAxis = 0; // 0 = undecided, 1 = horizontal, 2 = vertical
const menuTouchStart = { x: 0, y: 0 };
const menuTouchStep = { x: 0, y: 0 };

// "Rotate your device" prompt (portrait, in game). Dismissed for the session.
let portraitPrompt = null;
let portraitDismissed = false;

// Accumulated values for IN_Move
let moveForward = 0;
let moveRight = 0;
let moveRun = false;
let lookYaw = 0; // degrees, + = turn left
let lookPitch = 0; // degrees, + = look down

// Returned by the getters (no per-frame allocation)
const _moveInput = { forward: 0, right: 0, run: false };
const _lookDelta = { yaw: 0, pitch: 0 };

// Gyroscope state
let gyroListening = false;
let gyroPermission = "unknown"; // 'unknown' | 'pending' | 'granted' | 'denied'
let gyroLastTime = -1;

// Layout inputs last applied (re-laid out when a cvar changes)
let layoutKey = "";

// UI elements
let overlay = null;
let moveZone = null;
let lookArea = null;
let pauseButton = null;
let sysBar = null;
let backButton = null;
let keyboardButton = null;
let keyboardInput = null;

/**
 * Hold buttons write kbutton state directly (not via Key_Event) and aim while
 * held: dragging a finger that started on FIRE or JUMP turns the view, so the
 * player can shoot and look with one thumb. Each tracks the touches on it.
 */
const holdButtons = [];

// Tap buttons send a console command
const tapButtons = [];

// getButton returns the kbutton: cl_input.js is part of an import cycle with
// this module, so its exports can't be read while this module loads
function makeHoldButton(id, label, getButton, color) {
  const b = {
    id,
    label,
    getButton,
    color,
    el: null,
    touches: new Set(),
    lastPos: new Map(),
  };
  holdButtons.push(b);
  return b;
}

const fireButton = makeHoldButton(
  "touch-fire",
  "FIRE",
  () => in_attack,
  "255, 90, 90",
);
const jumpButton = makeHoldButton(
  "touch-jump",
  "JUMP",
  () => in_jump,
  "110, 160, 255",
);
const weaponNextButton = {
  id: "touch-weapon-next",
  label: "WPN▶",
  command: "impulse 10\n",
  el: null,
};
const weaponPrevButton = {
  id: "touch-weapon-prev",
  label: "◀",
  command: "impulse 12\n",
  el: null,
};
tapButtons.push(weaponNextButton, weaponPrevButton);

// Swim down: +movedown / -movedown, held like JUMP
const downButton = makeHoldButton(
  "touch-movedown",
  "DOWN",
  () => in_down,
  "110, 220, 200",
);

// Small buttons in a row beside the menu button. They are shown only when
// Touch_ButtonsVisible says so. The commands are the C ones (save, load,
// toggleconsole, messagemode); the buttons are a web-only addition.
const saveButton = {
  id: "touch-quicksave",
  label: "SAVE",
  command: "save quick\n",
  el: null,
  bar: "save",
};
const loadButton = {
  id: "touch-quickload",
  label: "LOAD",
  command: "load quick\n",
  el: null,
  bar: "load",
};
const consoleButton = {
  id: "touch-console",
  label: "CON",
  command: "toggleconsole\n",
  el: null,
  bar: "console",
};
const chatButton = {
  id: "touch-chat",
  label: "CHAT",
  command: "messagemode\n",
  el: null,
  bar: "chat",
};
const barButtons = [saveButton, loadButton, consoleButton, chatButton];
tapButtons.push(...barButtons);

// Weapon wheel (web-only: held WPN▶ opens it, the impulses it sends are the
// C ones, impulse 1-8)
const WHEEL_HOLD_MS = 300; // hold time that opens the wheel; a shorter press cycles
const WHEEL_RING = 92; // px from the wheel centre to a slot centre, at touch_size 1
const WHEEL_SLOT = 54; // px, slot diameter
const WHEEL_INNER = 30; // px, no slot selected closer to the centre than this
const WHEEL_OUTER = 190; // px, nor farther than this
const WHEEL_NAMES = ["AXE", "SG", "SSG", "NG", "SNG", "GL", "RL", "LG"];
const wheelWeapons = [];
for (let i = 0; i < 8; i++) wheelWeapons.push({ owned: false, ammo: false });
const wheelSlotEls = [];
let wheelEl = null;
let wheelTouch = -1; // identifier of the finger on WPN▶, or -1
let wheelTimer = 0;
let wheelOpen = false;
let wheelSelected = null; // 1-8 or null
const wheelCentre = { x: 0, y: 0 };

// What the quick buttons need (set by Touch_Frame)
const QUICK_SAVE_KEY = "quake_save_quick"; // host_cmd.js: SAVE_STORAGE_PREFIX + 'quick'
const barVisible = { save: false, load: false, console: false, chat: false };
let barKey = -1;
let quickSaveExists = false;
let quickSaveChecked = 0;

/**
 * True on touch-first devices (VID_IsTouchPrimary). Touchscreen laptops and
 * tablets with a trackpad return false; in_web.js switches to touch controls
 * when they are actually touched.
 */
export function Touch_IsMobile() {
  if (typeof matchMedia === "function") {
    return VID_IsTouchPrimary((query) => matchMedia(query));
  }

  if (typeof navigator === "undefined") return false;
  return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
    navigator.userAgent || "",
  );
}

/** True if the device has a touchscreen at all */
export function Touch_IsTouchCapable() {
  if (typeof navigator !== "undefined" && navigator.maxTouchPoints > 0) {
    return true;
  }
  return typeof window !== "undefined" && "ontouchstart" in window;
}

// UI CREATION

function makeDiv(id, css) {
  const el = document.createElement("div");
  if (id) el.id = id;
  el.style.cssText = css;
  return el;
}

const BUTTON_CSS = `
	position: absolute;
	border-radius: 50%;
	pointer-events: auto;
	touch-action: none;
	user-select: none;
	-webkit-user-select: none;
	-webkit-touch-callout: none;
	display: flex;
	align-items: center;
	justify-content: center;
	font-family: sans-serif;
	font-weight: bold;
	color: rgba(255, 255, 255, 0.85);
	box-sizing: border-box;
`;

const SYS_BUTTON_CSS = `
	pointer-events: auto;
	touch-action: manipulation;
	user-select: none;
	-webkit-user-select: none;
	min-width: 48px;
	height: 40px;
	padding: 0 12px;
	border-radius: 8px;
	background: rgba(0, 0, 0, 0.45);
	border: 1px solid rgba(255, 255, 255, 0.35);
	color: rgba(255, 255, 255, 0.85);
	font-family: sans-serif;
	font-size: 15px;
	display: flex;
	align-items: center;
	justify-content: center;
`;

function Touch_CreateUI(container) {
  overlay = makeDiv(
    "touch-controls",
    `
		position: fixed;
		inset: 0;
		pointer-events: none;
		z-index: 200;
		display: none;
		touch-action: none;
		user-select: none;
		-webkit-user-select: none;
	`,
  );

  // Move stick zone (the stick appears where the thumb lands)
  moveZone = makeDiv(
    "touch-move",
    `
		position: absolute;
		top: 0;
		width: 45%;
		height: 100%;
		pointer-events: auto;
		touch-action: none;
	`,
  );

  // Look area (the rest of the screen, under the buttons)
  lookArea = makeDiv(
    "touch-look",
    `
		position: absolute;
		top: 0;
		width: 55%;
		height: 100%;
		pointer-events: auto;
		touch-action: none;
	`,
  );

  overlay.appendChild(moveZone);
  overlay.appendChild(lookArea);

  for (const b of holdButtons) {
    b.el = makeDiv(b.id, BUTTON_CSS);
    b.el.textContent = b.label;
    overlay.appendChild(b.el);
  }

  for (const b of tapButtons) {
    b.el = makeDiv(b.id, BUTTON_CSS);
    b.el.textContent = b.label;
    overlay.appendChild(b.el);
  }

  wheelEl = makeDiv(
    "touch-weapon-wheel",
    `
		position: fixed;
		left: 0;
		top: 0;
		width: 0;
		height: 0;
		pointer-events: none;
		display: none;
	`,
  );

  for (let i = 0; i < 8; i++) {
    const el = makeDiv(
      "touch-wheel-" + (i + 1),
      BUTTON_CSS + `
			background: rgba(0, 0, 0, 0.55);
			border: 2px solid rgba(255, 255, 255, 0.6);
			font-size: 14px;
		`,
    );
    el.textContent = WHEEL_NAMES[i];
    wheelEl.appendChild(el);
    wheelSlotEls.push(el);
  }

  overlay.appendChild(wheelEl);

  pauseButton = makeDiv(
    "touch-pause",
    BUTTON_CSS + `
		border-radius: 8px;
	`,
  );
  pauseButton.textContent = "❙❙";
  overlay.appendChild(pauseButton);

  container.appendChild(overlay);

  Touch_CreateMenuUI(container);
  Touch_CreateSysBar(container);
  Touch_CreatePortraitPrompt(container);

  Touch_Layout();
}

/**
 * Size and place the game controls from touch_size, touch_opacity and
 * touch_lefthanded. Positions keep clear of notches and the home indicator
 * (safe-area insets) and sit where the thumbs rest in landscape.
 */
function Touch_Layout() {
  if (overlay === null) return;

  const scale = Math.min(Math.max(touch_size.value || 1, 0.5), 2);
  const opacity = Math.min(Math.max(touch_opacity.value, 0.1), 1);
  const mirror = touch_lefthanded.value !== 0;
  layoutKey = touch_size.string + "|" + touch_opacity.string + "|" +
    touch_lefthanded.string;

  // The action side is the right side unless mirrored
  const near = mirror ? "left" : "right";
  const far = mirror ? "right" : "left";
  const inset = (side) => `env(safe-area-inset-${side}, 0px)`;

  moveZone.style[far] = "0";
  moveZone.style[near] = "";
  lookArea.style[near] = "0";
  lookArea.style[far] = "";

  // Circle centred (cx, cy) px from the near and bottom edges
  const place = (el, cx, cy, size) => {
    const s = size * scale;
    el.style.width = s + "px";
    el.style.height = s + "px";
    el.style[near] = `calc(${inset(near)} + ${cx * scale - s / 2}px)`;
    el.style[far] = "";
    el.style.bottom = `calc(${inset("bottom")} + ${cy * scale - s / 2}px)`;
    el.style.fontSize = Math.round(13 * scale) + "px";
    el.style.opacity = String(opacity);
  };

  place(fireButton.el, 100, 112, 88);
  place(jumpButton.el, 48, 48, 64);
  place(weaponNextButton.el, 96, 206, 56);
  place(weaponPrevButton.el, 168, 176, 44);
  place(downButton.el, 148, 40, 44); // clear of FIRE (its bottom edge is 68)

  for (const b of holdButtons) {
    b.el.style.border = `2px solid rgba(${b.color}, 0.8)`;
    Touch_SetButtonPressed(b, b.touches.size > 0);
  }

  for (const b of tapButtons) {
    b.el.style.border = "2px solid rgba(255, 255, 255, 0.5)";
    b.el.style.background = "rgba(0, 0, 0, 0.25)";
  }

  Touch_LayoutBar();

  // Menu button: top corner on the stick side, small
  const p = 40 * scale;
  pauseButton.style.width = p + "px";
  pauseButton.style.height = p + "px";
  pauseButton.style[far] = `calc(${inset(far)} + 12px)`;
  pauseButton.style[near] = "";
  pauseButton.style.top = `calc(${inset("top")} + 12px)`;
  pauseButton.style.fontSize = Math.round(12 * scale) + "px";
  pauseButton.style.background = "rgba(0, 0, 0, 0.3)";
  pauseButton.style.border = "1px solid rgba(255, 255, 255, 0.5)";
  pauseButton.style.opacity = String(opacity);
  Touch_UpdateNotifyTop();

  // The stick size is a nipplejs option: rebuild it
  if (stickManager !== null) {
    Stick_Destroy();
    Stick_Create();
  }
}

// Touch_LayoutBar
//
// The row of small buttons (SAVE, LOAD, CON, CHAT) to the inside of the menu
// button, in the top corner on the stick side. Hidden ones leave no gap. The
// row shrinks below touch_size when it would run off a narrow screen.

// The bar's button scale: touch_size, shrunk so `count` buttons starting
// `start` px in fit `width` with a 12 px margin, but never below 0.5
export function Touch_BarScale(size, start, width, count) {
  if (count <= 0 || width <= 0) return size;
  const fit = (width - start - 12 - 6 * (count - 1)) / (44 * count);
  return Math.max(Math.min(size, fit), 0.5);
}

function Touch_LayoutBar() {
  if (overlay === null) return;

  const size = Math.min(Math.max(touch_size.value || 1, 0.5), 2);
  const opacity = Math.min(Math.max(touch_opacity.value, 0.1), 1);
  const far = touch_lefthanded.value !== 0 ? "right" : "left";
  let x = 12 + 40 * size + 8; // past the menu button
  let shown = 0;
  for (const b of barButtons) if (barVisible[b.bar] !== false) shown++;
  const width =
    typeof window !== "undefined" && typeof window.innerWidth === "number" ?
      window.innerWidth :
      0;
  const scale = Touch_BarScale(size, x, width, shown);
  const w = 44 * scale;
  const h = 32 * scale;

  for (const b of barButtons) {
    if (barVisible[b.bar] === false) {
      b.el.style.display = "none";
      continue;
    }

    b.el.style.display = "flex";
    b.el.style.borderRadius = "8px";
    b.el.style.width = w + "px";
    b.el.style.height = h + "px";
    b.el.style.top = "calc(env(safe-area-inset-top, 0px) + 12px)";
    b.el.style[far] = `calc(env(safe-area-inset-${far}, 0px) + ${x}px)`;
    b.el.style[far === "left" ? "right" : "left"] = "";
    b.el.style.bottom = "";
    b.el.style.fontSize = Math.round(11 * scale) + "px";
    b.el.style.opacity = String(opacity);
    x += w + 6;
  }
  Touch_UpdateNotifyTop();
}

// Tell the console how far down the top buttons reach, so the notify lines
// (pickup messages) start below them. Nothing covers the top when the game
// controls are hidden.
function Touch_UpdateNotifyTop() {
  if (
    enabled === false || pauseButton === null ||
    typeof pauseButton.getBoundingClientRect !== "function"
  ) {
    Con_SetNotifyTop(0);
    return;
  }
  let bottom = pauseButton.getBoundingClientRect().bottom;
  for (const b of barButtons) {
    if (b.el.style.display === "none") continue;
    bottom = Math.max(bottom, b.el.getBoundingClientRect().bottom);
  }
  Con_SetNotifyTop(bottom > 0 ? bottom + 4 : 0);
}

function Touch_SetButtonPressed(b, pressed) {
  if (b.el === null) return;
  b.el.style.background = pressed ?
    `rgba(${b.color}, 0.35)` :
    "rgba(0, 0, 0, 0.2)";
}

/** Create fullscreen touch area for menu tap-to-select */
function Touch_CreateMenuUI(container) {
  menuOverlay = makeDiv(
    "touch-menu-controls",
    `
		position: fixed;
		inset: 0;
		display: none;
		z-index: 199;
		pointer-events: auto;
		touch-action: none;
	`,
  );

  menuOverlay.addEventListener("touchstart", onMenuTouchStart, {
    passive: false,
  });
  menuOverlay.addEventListener("touchmove", onMenuTouchMove, {
    passive: false,
  });
  menuOverlay.addEventListener("touchend", onMenuTouchEnd, { passive: false });
  menuOverlay.addEventListener("touchcancel", onMenuTouchEnd, {
    passive: false,
  });

  container.appendChild(menuOverlay);
}

/**
 * A full-screen "Rotate your device" card for portrait. The view keeps the
 * vertical FOV of the 4:3 default (fov 90 at 4:3 is about 74 degrees
 * vertically), so a portrait screen shows only about 38 degrees across. Tap to
 * dismiss; it stays dismissed for the session, since foldables and tablets
 * near square may never leave "portrait" by the innerHeight > innerWidth test.
 */
function Touch_CreatePortraitPrompt(container) {
  portraitPrompt = makeDiv(
    "touch-portrait",
    `
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		bottom: 0;
		display: none;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		box-sizing: border-box;
		padding: env(safe-area-inset-top, 0px) env(safe-area-inset-right, 0px) env(safe-area-inset-bottom, 0px) env(safe-area-inset-left, 0px);
		background: rgba(0, 0, 0, 0.8);
		color: rgba(255, 255, 255, 0.9);
		font-family: sans-serif;
		text-align: center;
		z-index: 202;
		pointer-events: auto;
		touch-action: manipulation;
		user-select: none;
		-webkit-user-select: none;
		cursor: pointer;
	`,
  );

  const icon = makeDiv(null, "font-size: 56px; line-height: 1.2;");
  icon.textContent = "\u21BB";
  const title = makeDiv(
    null,
    "font-size: 22px; font-weight: bold; margin: 8px 16px;",
  );
  title.textContent = "Rotate your device";
  const hint = makeDiv(null, "font-size: 14px; opacity: 0.7; margin: 0 16px;");
  hint.textContent = "Landscape gives a wider view. Tap to continue.";
  portraitPrompt.appendChild(icon);
  portraitPrompt.appendChild(title);
  portraitPrompt.appendChild(hint);

  portraitPrompt.addEventListener("click", () => {
    portraitDismissed = true;
    Touch_UpdatePortraitPrompt();
  });

  container.appendChild(portraitPrompt);
}

/**
 * Show the prompt while the game controls are up (touch mode, in game),
 * the window is portrait and it has not been dismissed. Menus, the console
 * and landscape hide it. Called on enable, disable, resize and rotation.
 */
function Touch_UpdatePortraitPrompt() {
  if (portraitPrompt === null) return;

  const portrait = typeof window !== "undefined" &&
    window.innerHeight > window.innerWidth;
  portraitPrompt.style.display =
    (enabled === true && portrait === true && portraitDismissed === false) ?
      "flex" :
      "none";
}

// The portrait prompt and the button bar depend on the window size
function Touch_OnResize() {
  Touch_UpdatePortraitPrompt();
  Touch_LayoutBar();
}

/**
 * Back (Escape) and keyboard buttons, shown in menus, the console and chat,
 * where there is no keyboard to press Escape or type with. The keyboard button
 * focuses an off-screen text field, whose input is forwarded as Quake keys.
 */
function Touch_CreateSysBar(container) {
  sysBar = makeDiv(
    "touch-sysbar",
    `
		position: fixed;
		top: calc(env(safe-area-inset-top, 0px) + 10px);
		right: calc(env(safe-area-inset-right, 0px) + 10px);
		display: none;
		gap: 8px;
		z-index: 201;
		pointer-events: none;
	`,
  );

  backButton = makeDiv("touch-back", SYS_BUTTON_CSS);
  backButton.textContent = "← Back";
  keyboardButton = makeDiv("touch-keyboard", SYS_BUTTON_CSS);
  keyboardButton.textContent = "⌨";
  sysBar.appendChild(backButton);
  sysBar.appendChild(keyboardButton);

  // No preventDefault: the tap must stay a click, which is what lets
  // focus() open the soft keyboard on iOS
  backButton.addEventListener("click", () => {
    S_UnlockAudio();
    Touch_HideKeyboard();
    pressKey(K_ESCAPE);
  });
  keyboardButton.addEventListener("click", Touch_ToggleKeyboard);

  keyboardInput = document.createElement("input");
  keyboardInput.id = "touch-keyboard-input";
  keyboardInput.type = "text";
  keyboardInput.setAttribute &&
    keyboardInput.setAttribute("autocapitalize", "off");
  keyboardInput.setAttribute &&
    keyboardInput.setAttribute("autocomplete", "off");
  keyboardInput.setAttribute &&
    keyboardInput.setAttribute("autocorrect", "off");
  keyboardInput.setAttribute &&
    keyboardInput.setAttribute("spellcheck", "false");
  keyboardInput.setAttribute &&
    keyboardInput.setAttribute("enterkeyhint", "send");
  // 16px stops iOS zooming in on focus; off-screen but focusable
  keyboardInput.style.cssText = `
		position: fixed;
		left: -1000px;
		top: 0;
		width: 10px;
		height: 10px;
		font-size: 16px;
		opacity: 0;
	`;
  keyboardInput.addEventListener("input", onKeyboardInput);
  keyboardInput.addEventListener("keydown", onKeyboardKeyDown);

  container.appendChild(sysBar);
  container.appendChild(keyboardInput);
}

// ON-SCREEN KEYBOARD
//
// Mobile keyboards often send keydown with key "Unidentified", so text comes
// from the input event and the field is emptied after each one. Enter and
// Backspace on an empty field only arrive as keydown.

function onKeyboardInput(e) {
  const type = e.inputType || "";
  if (type.startsWith("delete")) {
    pressKey(K_BACKSPACE);
  } else if (type === "insertLineBreak") {
    pressKey(K_ENTER);
  } else {
    const text = e.data != null ? e.data : keyboardInput.value;
    for (const ch of text) {
      const code = ch.charCodeAt(0);
      if (code >= 32 && code < 127) pressKey(code);
    }
  }

  keyboardInput.value = "";
}

function onKeyboardKeyDown(e) {
  if (e.key === "Enter") {
    e.preventDefault();
    pressKey(K_ENTER);
  } else if (e.key === "Backspace" && keyboardInput.value === "") {
    e.preventDefault();
    pressKey(K_BACKSPACE);
  } else if (e.key === "Escape") {
    e.preventDefault();
    Touch_HideKeyboard();
    pressKey(K_ESCAPE);
  }
}

function Touch_ToggleKeyboard() {
  if (keyboardInput === null) return;
  S_UnlockAudio();

  if (
    typeof document !== "undefined" && document.activeElement === keyboardInput
  ) {
    keyboardInput.blur();
  } else {
    keyboardInput.value = "";
    keyboardInput.focus();
  }
}

function Touch_HideKeyboard() {
  if (
    keyboardInput !== null && typeof document !== "undefined" &&
    document.activeElement === keyboardInput
  ) keyboardInput.blur();
}

// Menu touch handlers
//
// A tap (released without dragging) selects the menu item under the finger.
// Dragging sends arrow keys, one per MENU_DRAG_STEP pixels along the first
// axis moved: up/down moves the cursor, left/right adjusts sliders and
// options. menu.js only takes taps, so drags go through Key_Event.

function findTouch(list, id) {
  for (let i = 0; i < list.length; i++) {
    if (list[i].identifier === id) return list[i];
  }

  return null;
}

function pressKey(key) {
  Key_Event(key, true);
  Key_Event(key, false);
}

function onMenuTouchStart(e) {
  e.preventDefault();

  // Unlock audio on first user gesture
  S_UnlockAudio();

  if (menuTouch !== null || e.changedTouches.length === 0) return;

  const touch = e.changedTouches[0];
  menuTouch = touch.identifier;
  menuDragging = false;
  menuDragAxis = 0;
  menuTouchStart.x = touch.clientX;
  menuTouchStart.y = touch.clientY;
  menuTouchStep.x = touch.clientX;
  menuTouchStep.y = touch.clientY;
}

function onMenuTouchMove(e) {
  e.preventDefault();

  if (menuTouch === null) return;
  const touch = findTouch(e.changedTouches, menuTouch);
  if (touch === null) return;

  if (menuDragAxis === 0) {
    const dx = Math.abs(touch.clientX - menuTouchStart.x);
    const dy = Math.abs(touch.clientY - menuTouchStart.y);
    if (dx < MENU_DRAG_STEP && dy < MENU_DRAG_STEP) return;
    menuDragAxis = dx >= dy ? 1 : 2;
    menuDragging = true;
  }

  if (menuDragAxis === 1) {
    while (touch.clientX - menuTouchStep.x >= MENU_DRAG_STEP) {
      pressKey(K_RIGHTARROW);
      menuTouchStep.x += MENU_DRAG_STEP;
    }

    while (menuTouchStep.x - touch.clientX >= MENU_DRAG_STEP) {
      pressKey(K_LEFTARROW);
      menuTouchStep.x -= MENU_DRAG_STEP;
    }
  } else {
    while (touch.clientY - menuTouchStep.y >= MENU_DRAG_STEP) {
      pressKey(K_DOWNARROW);
      menuTouchStep.y += MENU_DRAG_STEP;
    }

    while (menuTouchStep.y - touch.clientY >= MENU_DRAG_STEP) {
      pressKey(K_UPARROW);
      menuTouchStep.y -= MENU_DRAG_STEP;
    }
  }
}

function onMenuTouchEnd(e) {
  e.preventDefault();

  Menu_HandleTouchEnd(e);

  // touchend is a user activation: if the tap just switched gyro aiming on,
  // iOS can show its motion permission prompt now
  if (e.type === "touchend") Gyro_RequestPermission();
}

function Menu_HandleTouchEnd(e) {
  if (menuTouch === null) return;
  const touch = findTouch(e.changedTouches, menuTouch);
  if (touch === null) return;

  menuTouch = null;

  if (menuDragging || e.type === "touchcancel" || menuTouchCallback == null) {
    return;
  }

  // Tap: pass coordinates relative to the surface the menu is drawn into
  const surface = menuSurfaceGetter ? menuSurfaceGetter() : null;
  if (surface != null && surface.getBoundingClientRect) {
    const rect = surface.getBoundingClientRect();
    menuTouchCallback(
      touch.clientX - rect.left,
      touch.clientY - rect.top,
      rect.width,
      rect.height,
      true,
    );
  } else {
    menuTouchCallback(
      touch.clientX,
      touch.clientY,
      window.innerWidth,
      window.innerHeight,
      true,
    );
  }
}

// GAME TOUCH HANDLERS

function haptic(ms) {
  if (!touch_haptics.value || typeof navigator === "undefined") return;
  if (typeof navigator.vibrate !== "function") return; // iOS has none
  // Chrome logs an error for vibrate before the first real tap
  if (navigator.userActivation && !navigator.userActivation.hasBeenActive) {
    return;
  }
  navigator.vibrate(ms);
}

function addLook(dx, dy) {
  const k = LOOK_DEGREES_PER_PX * touch_sensitivity.value;
  lookYaw -= dx * k;
  lookPitch += dy * k;
}

function onLookTouchStart(e) {
  e.preventDefault();
  S_UnlockAudio();

  for (const touch of e.changedTouches) {
    if (lookTouch !== null) break;
    lookTouch = touch.identifier;
    lastLookPos.x = touch.clientX;
    lastLookPos.y = touch.clientY;
  }
}

function onLookTouchMove(e) {
  e.preventDefault();

  const touch = lookTouch !== null ?
    findTouch(e.changedTouches, lookTouch) :
    null;
  if (touch === null) return;

  addLook(touch.clientX - lastLookPos.x, touch.clientY - lastLookPos.y);
  lastLookPos.x = touch.clientX;
  lastLookPos.y = touch.clientY;
}

function onLookTouchEnd(e) {
  e.preventDefault();

  if (lookTouch !== null && findTouch(e.changedTouches, lookTouch) !== null) {
    lookTouch = null;
  }
  onGameTouchEnd(e);
}

// touchend is a user activation (touchstart is not in Chrome): fullscreen
// and the iOS motion permission prompt can only be requested from it
function onGameTouchEnd(e) {
  if (e.type !== "touchend") return;
  Touch_RequestFullscreen();
  Gyro_Update(true);
}

function onHoldTouchStart(b, e) {
  e.preventDefault();
  S_UnlockAudio();

  for (const touch of e.changedTouches) {
    if (b.touches.size === 0) {
      b.getButton().state |= 1 + 2; // down + impulse down
      Touch_SetButtonPressed(b, true);
      haptic(12);
    }

    b.touches.add(touch.identifier);
    b.lastPos.set(touch.identifier, { x: touch.clientX, y: touch.clientY });
  }
}

function onHoldTouchMove(b, e) {
  e.preventDefault();

  for (const touch of e.changedTouches) {
    const last = b.lastPos.get(touch.identifier);
    if (last === undefined) continue;
    addLook(touch.clientX - last.x, touch.clientY - last.y);
    last.x = touch.clientX;
    last.y = touch.clientY;
  }
}

function onHoldTouchEnd(b, e) {
  e.preventDefault();

  for (const touch of e.changedTouches) {
    b.touches.delete(touch.identifier);
    b.lastPos.delete(touch.identifier);
  }

  if (b.touches.size === 0) Touch_ReleaseHold(b);
  onGameTouchEnd(e);
}

function Touch_ReleaseHold(b) {
  const kbutton = b.getButton();
  if (kbutton.state & 1) {
    kbutton.state &= ~1; // up
    kbutton.state |= 4; // impulse up
  }

  b.touches.clear();
  b.lastPos.clear();
  Touch_SetButtonPressed(b, false);
}

function onTapTouchStart(b, e) {
  e.preventDefault();
  S_UnlockAudio();
  Cbuf_AddText(b.command);
  haptic(8);
  b.el.style.background = "rgba(255, 255, 255, 0.3)";
}

function onTapTouchEnd(b, e) {
  e.preventDefault();
  if (!e.targetTouches || e.targetTouches.length === 0) {
    b.el.style.background = "rgba(0, 0, 0, 0.25)";
  }
  onGameTouchEnd(e);
}

// WEAPON WHEEL
//
// Web-only: the C has no on-screen weapon picker. A quick tap on WPN▶ still
// sends impulse 10 (cycle), now on release; holding it for WHEEL_HOLD_MS opens a
// ring of the weapons the player has. Sliding to a slot and lifting sends
// impulse 1-8 (the C weapon impulses); lifting elsewhere cancels.

/**
 * dx, dy: finger position relative to the wheel centre, in px (y down).
 * Slot 1 is straight up and the slots follow clockwise, 45 degrees apart.
 * Returns 1-8, or null inside the dead zone or beyond outer.
 */
export function Touch_WheelSlotAt(dx, dy, inner, outer) {
  const d = Math.hypot(dx, dy);
  if (d < inner || d > outer) return null;

  const a = Math.atan2(dx, -dy); // 0 = up, + = clockwise
  let sector = Math.round(a / (Math.PI / 4));
  if (sector < 0) sector += 8;
  return (sector % 8) + 1;
}

const WHEEL_ITEM_BITS = [
  IT_AXE,
  IT_SHOTGUN,
  IT_SUPER_SHOTGUN,
  IT_NAILGUN,
  IT_SUPER_NAILGUN,
  IT_GRENADE_LAUNCHER,
  IT_ROCKET_LAUNCHER,
  IT_LIGHTNING,
];
const WHEEL_AMMO_STATS = [
  -1,
  STAT_SHELLS,
  STAT_SHELLS,
  STAT_NAILS,
  STAT_NAILS,
  STAT_ROCKETS,
  STAT_ROCKETS,
  STAT_CELLS,
];

/**
 * Fill out[ 0..7 ] (slot - 1) with { owned, ammo } from cl.items and cl.stats.
 * The axe needs no ammo. Mission-pack weapons are not covered.
 */
export function Touch_WheelWeapons(items, stats, out) {
  for (let i = 0; i < 8; i++) {
    out[i].owned = (items & WHEEL_ITEM_BITS[i]) !== 0;
    out[i].ammo = WHEEL_AMMO_STATS[i] < 0 || stats[WHEEL_AMMO_STATS[i]] > 0;
  }

  return out;
}

/**
 * The slot (1-8) under the finger, or null when it is off the ring or the
 * weapon there isn't owned (so releasing there cancels).
 */
export function Touch_WheelSelect(dx, dy, inner, outer, weapons) {
  const slot = Touch_WheelSlotAt(dx, dy, inner, outer);
  if (slot === null || weapons[slot - 1].owned === false) return null;
  return slot;
}

function Touch_WheelScale() {
  return Math.min(Math.max(touch_size.value || 1, 0.5), 2);
}

function Touch_WheelOpen() {
  if (wheelEl === null || weaponNextButton.el === null) return;

  const scale = Touch_WheelScale();
  Touch_WheelWeapons(cl.items, cl.stats, wheelWeapons);

  // Centre on the button, pushed inwards so the whole ring is on screen
  const r = weaponNextButton.el.getBoundingClientRect();
  const margin = (WHEEL_RING + WHEEL_SLOT / 2 + 4) * scale;
  const vw = typeof innerWidth === "number" ? innerWidth : 640;
  const vh = typeof innerHeight === "number" ? innerHeight : 480;
  wheelCentre.x = Math.min(
    Math.max(r.left + r.width / 2, margin),
    Math.max(vw - margin, margin),
  );
  wheelCentre.y = Math.min(
    Math.max(r.top + r.height / 2, margin),
    Math.max(vh - margin, margin),
  );

  const size = WHEEL_SLOT * scale;

  for (let i = 0; i < 8; i++) {
    const el = wheelSlotEls[i];
    const a = i * Math.PI / 4;
    el.style.display = wheelWeapons[i].owned ? "flex" : "none";
    el.style.width = size + "px";
    el.style.height = size + "px";
    el.style.left =
      (wheelCentre.x + Math.sin(a) * WHEEL_RING * scale - size / 2) + "px";
    el.style.top =
      (wheelCentre.y - Math.cos(a) * WHEEL_RING * scale - size / 2) + "px";
    el.style.opacity = wheelWeapons[i].ammo ? "1" : "0.4"; // dim: no ammo
    el.style.fontSize = Math.round(14 * scale) + "px";
  }

  wheelSelected = null;
  Touch_WheelHighlight();
  wheelEl.style.display = "block";
  wheelOpen = true;
  haptic(15);
}

function Touch_WheelHighlight() {
  for (let i = 0; i < 8; i++) {
    wheelSlotEls[i].style.background = wheelSelected === i + 1 ?
      "rgba(255, 200, 60, 0.75)" :
      "rgba(0, 0, 0, 0.55)";
  }
}

// Close without sending anything
function Touch_WheelClose() {
  if (wheelTimer !== 0) {
    clearTimeout(wheelTimer);
    wheelTimer = 0;
  }

  wheelTouch = -1;
  wheelOpen = false;
  wheelSelected = null;
  if (wheelEl !== null) wheelEl.style.display = "none";
  if (weaponNextButton.el !== null) {
    weaponNextButton.el.style.background = "rgba(0, 0, 0, 0.25)";
  }
}

function onWheelTouchStart(e) {
  e.preventDefault();
  S_UnlockAudio();
  if (wheelTouch !== -1) return; // one finger at a time

  wheelTouch = e.changedTouches[0].identifier;
  haptic(8);
  weaponNextButton.el.style.background = "rgba(255, 255, 255, 0.3)";
  wheelTimer = setTimeout(() => {
    wheelTimer = 0;
    Touch_WheelOpen();
  }, WHEEL_HOLD_MS);
}

function onWheelTouchMove(e) {
  e.preventDefault();
  if (wheelOpen === false) return;

  const touch = findTouch(e.changedTouches, wheelTouch);
  if (touch === null) return;

  const scale = Touch_WheelScale();
  const slot = Touch_WheelSelect(
    touch.clientX - wheelCentre.x,
    touch.clientY - wheelCentre.y,
    WHEEL_INNER * scale,
    WHEEL_OUTER * scale,
    wheelWeapons,
  );

  if (slot !== wheelSelected) {
    wheelSelected = slot;
    Touch_WheelHighlight();
    if (slot !== null) haptic(6);
  }
}

function onWheelTouchEnd(e) {
  e.preventDefault();
  if (findTouch(e.changedTouches, wheelTouch) === null) return;

  if (wheelOpen) {
    if (wheelSelected !== null) Cbuf_AddText("impulse " + wheelSelected + "\n");
  } else {
    Cbuf_AddText(weaponNextButton.command); // a quick tap cycles, as before
  }

  Touch_WheelClose();
  onGameTouchEnd(e);
}

function onWheelTouchCancel(e) {
  e.preventDefault();
  if (findTouch(e.changedTouches, wheelTouch) === null) return;
  Touch_WheelClose();
}

function onPauseTouchStart(e) {
  e.preventDefault();
  pressKey(K_ESCAPE);
}

// Listener table, so Enable/Disable add and remove the same functions
const gameListeners = [];

function Touch_BuildListeners() {
  const add = (el, type, fn) => gameListeners.push({ el, type, fn });

  add(lookArea, "touchstart", onLookTouchStart);
  add(lookArea, "touchmove", onLookTouchMove);
  add(lookArea, "touchend", onLookTouchEnd);
  add(lookArea, "touchcancel", onLookTouchEnd);

  // The stick itself uses pointer events (nipplejs). Its touch events are
  // cancelled so no compatibility mousedown reaches the canvas (that would
  // be +attack), and touchend asks for fullscreen and the gyro permission.
  const cancel = (e) => e.preventDefault();
  add(moveZone, "touchstart", (e) => {
    cancel(e);
    S_UnlockAudio();
  });
  add(moveZone, "touchmove", cancel);
  add(moveZone, "touchend", (e) => {
    cancel(e);
    onGameTouchEnd(e);
  });
  add(moveZone, "touchcancel", cancel);

  for (const b of holdButtons) {
    add(b.el, "touchstart", (e) => onHoldTouchStart(b, e));
    add(b.el, "touchmove", (e) => onHoldTouchMove(b, e));
    add(b.el, "touchend", (e) => onHoldTouchEnd(b, e));
    add(b.el, "touchcancel", (e) => onHoldTouchEnd(b, e));
  }

  for (const b of tapButtons) {
    if (b === weaponNextButton) {
      add(b.el, "touchstart", onWheelTouchStart);
      add(b.el, "touchmove", onWheelTouchMove);
      add(b.el, "touchend", onWheelTouchEnd);
      add(b.el, "touchcancel", onWheelTouchCancel);
      continue;
    }

    add(b.el, "touchstart", (e) => onTapTouchStart(b, e));
    add(b.el, "touchend", (e) => onTapTouchEnd(b, e));
    add(b.el, "touchcancel", (e) => onTapTouchEnd(b, e));
  }

  add(pauseButton, "touchstart", onPauseTouchStart);
}

// MOVE STICK (nipplejs)

// Load nipplejs through the page's import map. The specifier is a variable
// so tools that resolve imports up front (Deno tests) don't fail on it.
function Stick_Load() {
  if (nippleLoad !== null) return nippleLoad;

  const specifier = "nipplejs";
  nippleLoad = import(specifier).then((mod) => {
    nipplejs = mod.default || mod;
    if (enabled && stickManager === null) Stick_Create();
  }).catch((err) => {
    // Try again on the next Touch_Enable (e.g. back online)
    nippleLoad = null;
    console.warn(
      "Touch: could not load the move stick (nipplejs):",
      err.message,
    );
  });

  return nippleLoad;
}

function Stick_Create() {
  if (nipplejs === null || moveZone === null || stickManager !== null) return;

  const scale = Math.min(Math.max(touch_size.value || 1, 0.5), 2);
  stickManager = nipplejs.create({
    zone: moveZone,
    mode: "dynamic",
    size: Math.round(JOYSTICK_SIZE * scale),
    color: "white",
    fadeTime: 120,
    multitouch: false,
    restOpacity: Math.min(Math.max(touch_opacity.value, 0.1), 1),
  });

  // nipplejs 1.x passes one event object; 0.x passed ( event, data )
  stickManager.on("start", () => {
    S_UnlockAudio();
  });
  stickManager.on("move", (evt, data) => {
    const d = data || (evt && evt.data);
    if (d && d.vector) Touch_SetJoystick(d.vector.x, -d.vector.y);
  });
  stickManager.on("end", () => {
    Touch_ResetJoystick();
  });
}

function Stick_Destroy() {
  if (stickManager === null) return;
  stickManager.destroy(); // emits no 'end' for a stick still held
  stickManager = null;
  Touch_ResetJoystick();
}

/**
 * x, y: knob offset as a fraction of the radius (screen axes, y down).
 * Applies the deadzone, then ramps the magnitude linearly from 0 at the
 * deadzone edge to 1 at JOYSTICK_FULL. IN_Move multiplies it by
 * cl_movespeedkey, so the response is continuous: walk speed (1x
 * cl_forwardspeed) lands mid-throw and run speed (cl_movespeedkey x) at full
 * deflection, with no jump between them. `run` only flags full deflection.
 */
export function Touch_SetJoystick(x, y) {
  const mag = Math.sqrt(x * x + y * y);

  if (mag < JOYSTICK_DEADZONE) {
    moveRight = 0;
    moveForward = 0;
    moveRun = false;
    return;
  }

  const t = Math.min(
    (mag - JOYSTICK_DEADZONE) / (JOYSTICK_FULL - JOYSTICK_DEADZONE),
    1,
  );
  moveRun = t >= 1;
  const scale = t / mag;

  // Note: Y is inverted (up = forward = positive)
  moveRight = x * scale;
  moveForward = -y * scale;
}

function Touch_ResetJoystick() {
  moveForward = 0;
  moveRight = 0;
  moveRun = false;
}

/**
 * Release FIRE/JUMP if touch is holding them, reset the stick and look
 * tracking. Called by Touch_Disable and on focus loss.
 */
export function Touch_ReleaseButtons() {
  for (const b of holdButtons) Touch_ReleaseHold(b);
  Touch_WheelClose();
  Touch_ResetJoystick();
  lookTouch = null;
  lookYaw = 0;
  lookPitch = 0;
  menuTouch = null;
}

// GYRO AIMING
//
// devicemotion rotationRate is angular velocity in degrees per second about the
// device axes (beta: x, short edge; gamma: y, long edge; alpha: z, out of the
// screen). It is rotated into screen axes for the current orientation, then
// integrated over the time between events: rotation about the screen's
// vertical axis turns, about its horizontal axis pitches. Rotation about the
// screen normal (roll) is added to yaw ("local space" gyro), so turning while
// the phone is tilted back still turns. touch_gyro_sensitivity 1 maps a real
// degree to a view degree.

function onDeviceMotion(e) {
  if (!enabled) return;

  const r = e.rotationRate;
  const t = typeof e.timeStamp === "number" ? e.timeStamp : performance.now();
  const last = gyroLastTime;
  gyroLastTime = t;

  if (
    r == null || r.alpha == null || r.beta == null || r.gamma == null ||
    last < 0
  ) return;

  // Skip the first event after a pause instead of integrating the gap
  const dt = (t - last) / 1000;
  if (dt <= 0 || dt > 0.25) return;

  const angle = Gyro_ScreenAngle() * Math.PI / 180;
  const c = Math.cos(angle);
  const s = Math.sin(angle);

  // Device axes to screen axes (x right, y up, z towards the viewer)
  const wx = r.beta * c - r.gamma * s;
  const wy = r.beta * s + r.gamma * c;
  const wz = r.alpha;

  const k = touch_gyro_sensitivity.value * dt;
  lookYaw += (wy + wz) * k; // counter-clockwise from above = turn left
  lookPitch -= wx * k; // top edge towards the viewer (camera tilts up) = look up
}

function Gyro_ScreenAngle() {
  if (
    typeof screen !== "undefined" && screen.orientation &&
    typeof screen.orientation.angle === "number"
  ) {
    return screen.orientation.angle;
  }
  if (typeof window !== "undefined" && typeof window.orientation === "number") {
    return (window.orientation + 360) % 360;
  }
  return 0;
}

/**
 * Start or stop listening to match touch_gyro while the game controls are up.
 * fromGesture: we are inside a user activation, so iOS may show its motion
 * permission prompt now (it refuses outside one).
 */
function Gyro_Update(fromGesture) {
  const want = enabled && touch_gyro.value !== 0;

  if (!want) {
    Gyro_Stop();
    return;
  }

  if (gyroListening || typeof window === "undefined") return;

  const DME = typeof DeviceMotionEvent !== "undefined" ?
    DeviceMotionEvent :
    null;
  if (DME === null) return;

  if (
    typeof DME.requestPermission !== "function" || gyroPermission === "granted"
  ) {
    Gyro_Start();
    return;
  }

  if (fromGesture) Gyro_RequestPermission();
}

/**
 * iOS only: ask for motion sensor access while touch_gyro is on. Must run
 * inside a user activation (touchend). Gyro_Update starts listening once it is
 * granted and the game controls are up.
 */
function Gyro_RequestPermission() {
  if (touch_gyro.value === 0 || gyroPermission !== "unknown") return;

  const DME = typeof DeviceMotionEvent !== "undefined" ?
    DeviceMotionEvent :
    null;
  if (DME === null || typeof DME.requestPermission !== "function") return;

  gyroPermission = "pending";
  DME.requestPermission().then((result) => {
    gyroPermission = result === "granted" ? "granted" : "denied";
    if (gyroPermission === "granted") Gyro_Update(false);
    else {console.log(
        "Touch: motion sensor permission denied, gyro aiming is off",
      );}
  }).catch((err) => {
    // Not from a gesture after all: ask again on the next tap
    gyroPermission = "unknown";
    console.log("Touch: motion sensor permission error:", err.message);
  });
}

function Gyro_Start() {
  if (gyroListening) return;
  gyroListening = true;
  gyroLastTime = -1;
  window.addEventListener("devicemotion", onDeviceMotion);
}

function Gyro_Stop() {
  if (!gyroListening) return;
  gyroListening = false;
  window.removeEventListener("devicemotion", onDeviceMotion);
}

/**
 * Called every frame: re-lays out the controls and starts or stops the gyro
 * when the touch cvars change (from the menu or the console)
 */
export function Touch_Frame() {
  if (!initialized) return;

  Touch_AimAssistFrame();

  const key = touch_size.string + "|" + touch_opacity.string + "|" +
    touch_lefthanded.string;
  if (key !== layoutKey) Touch_Layout();

  if ((touch_gyro.value !== 0) !== gyroListening) Gyro_Update(false);

  Touch_UpdateBar();
}

// AIM ASSIST
//
// Web-only, no C counterpart. Touch aiming is coarse, so touch_aimassist
// widens or narrows the cone PF_aim searches for a target, by setting the
// server's sv_aim (the cosine of the cone's half-angle). PF_aim is unchanged:
// it keeps the view's heading and only takes the target's height, so a wider
// cone helps with vertical aim. Only the browser's own server reads sv_aim
// (single player and games this browser hosts, where it applies to every
// player); an online room runs its own.

// sv_aim for each level, about 0, 14, 22, 30 and 37 degrees each side;
// level 2 is Quake's default
const AIM_ASSIST_CONES = [1, 0.97, 0.93, 0.87, 0.8];
const AIM_ASSIST_DEFAULT = 2;

// The level last written to sv_aim. Starting at the default means a player
// who never moves the slider keeps sv_aim as the console or a config set it,
// and a saved level other than the default is applied on the first frame.
let aimAssistApplied = AIM_ASSIST_DEFAULT;

/** touch_aimassist's value as a level, rounded and clamped */
export function Touch_AimAssistLevel(v) {
  const level = Math.round(v);
  if (level < 0) return 0;
  if (level >= AIM_ASSIST_CONES.length) return AIM_ASSIST_CONES.length - 1;
  return level;
}

/** sv_aim for a touch_aimassist level */
export function Touch_AimAssistCone(level) {
  return AIM_ASSIST_CONES[Touch_AimAssistLevel(level)];
}

/** Writes sv_aim when touch_aimassist changes (from the menu or the console) */
export function Touch_AimAssistFrame() {
  const level = Touch_AimAssistLevel(touch_aimassist.value);
  if (level === aimAssistApplied) return;
  if (Cvar_FindVar("sv_aim") === null) return;
  aimAssistApplied = level;
  Cvar_SetValue("sv_aim", AIM_ASSIST_CONES[level]);
}

/**
 * Which of the small buttons show. Quick save and load need a local
 * single-player game (the C's save refuses anything else), and load needs the
 * slot to exist; chat is for games with other players. Fills out and returns it.
 */
export function Touch_ButtonsVisible(
  singleplayer,
  multiplayer,
  quickSave,
  out,
) {
  out.save = singleplayer;
  out.load = singleplayer && quickSave;
  out.console = singleplayer || multiplayer;
  out.chat = multiplayer;
  return out;
}

// Whether the quick slot is in localStorage. Scans the keys rather than
// reading the (large) save, and only twice a second.
function Touch_CheckQuickSave() {
  const now = Date.now();
  if (now - quickSaveChecked < 500 && now >= quickSaveChecked) return;
  quickSaveChecked = now;
  quickSaveExists = false;

  try {
    for (let i = 0; i < localStorage.length; i++) {
      if (localStorage.key(i) === QUICK_SAVE_KEY) {
        quickSaveExists = true;
        break;
      }
    }
  } catch {
    // storage blocked: no slot
  }
}

function Touch_UpdateBar() {
  if (
    overlay === null || cls.state !== ca_connected || cl.worldmodel === null
  ) return;

  const playing = cls.demoplayback === false;
  const singleplayer = playing && sv.active === true && svs.maxclients === 1 &&
    cl.intermission === 0;
  const multiplayer = playing && singleplayer === false &&
    cl.intermission === 0;
  if (singleplayer) Touch_CheckQuickSave();

  Touch_ButtonsVisible(singleplayer, multiplayer, quickSaveExists, barVisible);
  const key = (barVisible.save ? 1 : 0) | (barVisible.load ? 2 : 0) |
    (barVisible.console ? 4 : 0) | (barVisible.chat ? 8 : 0);

  if (key !== barKey) {
    barKey = key;
    Touch_LayoutBar();
  }
}

// Wake Lock - prevents screen from dimming while playing

async function Touch_RequestWakeLock() {
  if (wakeLock !== null || wakeLockPending) return;
  if (typeof navigator === "undefined" || !("wakeLock" in navigator)) return;

  // The request is refused while the page is hidden; the visibilitychange
  // handler retries when it comes back
  if (document.visibilityState !== "visible") return;

  wakeLockPending = true;

  try {
    const lock = await navigator.wakeLock.request("screen");

    // Controls were disabled while the request was pending
    if (!enabled) {
      lock.release().catch(() => {});
      return;
    }

    wakeLock = lock;
    lock.addEventListener("release", () => {
      if (wakeLock === lock) wakeLock = null;
    });
  } catch (err) {
    console.log("Wake Lock request failed:", err.message);
  } finally {
    wakeLockPending = false;
  }
}

function Touch_ReleaseWakeLock() {
  if (wakeLock !== null) {
    const lock = wakeLock;
    wakeLock = null;
    lock.release().catch(() => {});
  }
}

// The browser releases the wake lock when the page is hidden: take it back
function onVisibilityChange() {
  if (enabled && document.visibilityState === "visible") {
    Touch_RequestWakeLock();
  }
}

// Reset when the user leaves fullscreen, so the next tap can enter it again
function onFullscreenChange() {
  if (!document.fullscreenElement && !document.webkitFullscreenElement) {
    fullscreenActivated = false;
  }
}

/** Request fullscreen and lock to landscape orientation on mobile */
export async function Touch_RequestFullscreen() {
  if (fullscreenActivated || fullscreenPending) return;

  // Meta Quest browser has no page fullscreen (as in in_web.js)
  if (
    typeof navigator !== "undefined" &&
    /OculusBrowser|Quest/i.test(navigator.userAgent || "")
  ) return;

  if (document.fullscreenElement || document.webkitFullscreenElement) {
    fullscreenActivated = true;
    return;
  }

  fullscreenPending = true;

  try {
    // Request fullscreen
    const container = document.documentElement;
    if (container.requestFullscreen) {
      await container.requestFullscreen();
    } else if (container.webkitRequestFullscreen) {
      await container.webkitRequestFullscreen();
    }

    // Lock to landscape orientation
    if (screen.orientation && screen.orientation.lock) {
      try {
        await screen.orientation.lock("landscape");
      } catch (e) {
        // Orientation lock may not be supported or allowed
        console.log("Could not lock orientation:", e.message);
      }
    }

    // The user may have left fullscreen while the awaits above were pending
    // (fullscreenchange already ran): only latch the state that is true now
    fullscreenActivated =
      !container.requestFullscreen && !container.webkitRequestFullscreen ||
      !!(document.fullscreenElement || document.webkitFullscreenElement);
  } catch (e) {
    console.log("Could not enter fullscreen:", e.message);
  } finally {
    fullscreenPending = false;
  }
}

/** Exit fullscreen mode */
export async function Touch_ExitFullscreen() {
  if (!document.fullscreenElement && !document.webkitFullscreenElement) return;

  try {
    if (document.exitFullscreen) {
      await document.exitFullscreen();
    } else if (document.webkitExitFullscreen) {
      await document.webkitExitFullscreen();
    }

    // Unlock orientation
    if (screen.orientation && screen.orientation.unlock) {
      screen.orientation.unlock();
    }

    fullscreenActivated = false;
  } catch (e) {
    console.log("Could not exit fullscreen:", e.message);
  }
}

/** Initialize touch controls */
export function Touch_Init(container) {
  if (initialized) return;

  Touch_CreateUI(container || document.body);
  Touch_BuildListeners();

  document.addEventListener("visibilitychange", onVisibilityChange);
  document.addEventListener("fullscreenchange", onFullscreenChange);
  document.addEventListener("webkitfullscreenchange", onFullscreenChange);

  if (typeof window !== "undefined") {
    window.addEventListener("resize", Touch_OnResize);
    window.addEventListener("orientationchange", Touch_OnResize);
  }

  initialized = true;

  // Fetch the stick library now, so it is ready by the first map
  Stick_Load();
}

/** Enable touch controls (show UI, add listeners) */
export function Touch_Enable() {
  if (!initialized) return;
  if (enabled) return;

  enabled = true;
  overlay.style.display = "block";
  Touch_SetPlayingClass(true);
  Touch_UpdateNotifyTop();
  Touch_HideSysBar();
  Touch_UpdatePortraitPrompt();

  for (const l of gameListeners) {
    l.el.addEventListener(l.type, l.fn, { passive: false });
  }

  if (nipplejs === null) Stick_Load();
  Stick_Create();

  // Gyro if switched on and already allowed (the iOS prompt waits for a tap)
  Gyro_Update(false);

  // Keep screen on while playing
  Touch_RequestWakeLock();
}

/** Disable touch controls (hide UI, remove listeners) */
export function Touch_Disable() {
  if (!initialized || !enabled) return;

  enabled = false;
  overlay.style.display = "none";
  Touch_SetPlayingClass(false);
  Con_SetNotifyTop(0);
  Touch_UpdatePortraitPrompt();

  for (const l of gameListeners) l.el.removeEventListener(l.type, l.fn);

  // A stick held now would never see its pointerup
  Stick_Destroy();

  Gyro_Stop();

  // Release wake lock when not playing
  Touch_ReleaseWakeLock();

  // Release FIRE/JUMP (their touchend will never arrive), reset the stick
  Touch_ReleaseButtons();
}

// body.touch-playing hides the ENTER VR button (index.html), which would
// cover the status bar in portrait
function Touch_SetPlayingClass(on) {
  if (typeof document === "undefined") return;
  const body = document.body;
  // Tests stub document.body without classList
  if (body === null || body === undefined || body.classList === undefined) {
    return;
  }
  body.classList.toggle("touch-playing", on);
}

export function Touch_IsEnabled() {
  return enabled;
}

/** Returns normalized movement input from joystick */
export function Touch_GetMoveInput() {
  _moveInput.forward = moveForward;
  _moveInput.right = moveRight;
  _moveInput.run = moveRun;
  return _moveInput;
}

/**
 * Returns the view change from drag look and gyro since the last call, in
 * degrees (yaw: + turns left, pitch: + looks down), and clears it
 */
export function Touch_GetLookDelta() {
  _lookDelta.yaw = lookYaw;
  _lookDelta.pitch = lookPitch;
  lookYaw = 0;
  lookPitch = 0;
  return _lookDelta;
}

/** Show menu touch overlay (and the Back / keyboard bar) */
export function Touch_ShowMenu() {
  if (!initialized || !menuOverlay) return;

  menuOverlay.style.display = "block";
  menuShown = true;
  Touch_ShowSysBar();
}

/** Hide menu touch overlay */
export function Touch_HideMenu() {
  if (!initialized || !menuOverlay) return;

  menuOverlay.style.display = "none";
  menuShown = false;
}

/**
 * True while the menu overlay is up, so menu input comes from taps
 * (menu.js sizes and confirms its rows for fingers then)
 */
export function Touch_MenuShown() {
  return menuShown;
}

// Touch_ShowSysBar / Touch_HideSysBar
//
// The Back / keyboard bar on its own, for the console and chat
export function Touch_ShowSysBar() {
  if (!initialized || !sysBar) return;
  sysBar.style.display = "flex";
}

export function Touch_HideSysBar() {
  if (!initialized || !sysBar) return;
  sysBar.style.display = "none";
  Touch_HideKeyboard();
}

/**
 * Set the callback function for menu touch events
 * Callback receives (touchX, touchY, surfaceWidth, surfaceHeight, true),
 * relative to the element returned by getSurface (the canvas the menu is drawn
 * into); the last argument says the tap came from a finger
 */
export function Touch_SetMenuCallback(callback, getSurface) {
  menuTouchCallback = callback;
  menuSurfaceGetter = getSurface || null;
}
