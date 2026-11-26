// Touch HUD layout editor
//
// Web-only, no C counterpart. An HTML layer over the touch controls (opened
// with touch_editlayout, or Edit Layout on the Touch Controls page) where the
// player drags buttons to move them, picks one to resize, hide or bring it
// back, adds buttons that run any console command, and keeps several layouts
// as named profiles (touch_layout.js). touch_layout <name> switches profile
// from the console or a config.
//
// While it is open it takes every pointer and key event in the capture phase
// on window, before in_web.js's document listeners: a mouse click would
// otherwise switch the page out of touch mode, and keys typed into a label
// would reach the game.

import { Cmd_AddCommand, Cmd_Argc, Cmd_Argv } from "./cmd.js";
import { Con_Printf } from "./console.js";
import {
  TL_Active,
  TL_AddCustom,
  TL_AddProfile,
  TL_Button,
  TL_DeleteActive,
  TL_HIDE_ONLY,
  TL_MAX_COMMAND,
  TL_MAX_CUSTOM,
  TL_MAX_LABEL,
  TL_MAX_NAME,
  TL_MAX_PROFILES,
  TL_MAX_SIZE,
  TL_MIN_SIZE,
  TL_MOVABLE,
  TL_MoveButton,
  TL_MoveCustom,
  TL_RemoveCustom,
  TL_RenameActive,
  TL_ResetButtons,
  TL_Save,
  TL_SetActive,
  TL_SetButton,
  TL_SetCustom,
  TL_Store,
} from "./touch_layout.js";
import {
  Touch_EditTargets,
  Touch_IsInitialized,
  Touch_LayoutMirrored,
  Touch_LayoutScale,
  Touch_Relayout,
  Touch_SetEditing,
} from "./touch.js";

let open = false;
let layer = null;
let toolbar = null;
let profileSelect = null;
let nameInput = null;
let deleteButton = null;
let resetButton = null;
let addButton = null;
let selRow = null;
let selName = null;
let sizeInput = null;
let hideButton = null;
let customRow = null;
let labelInput = null;
let commandInput = null;
let hintLine = null;

// The picked button: its element id and custom index (-1: built-in), or ""
let selId = "";
let selCustom = -1;

// A drag in progress: the pointer, where it started, and the button's centre
// then (layout units)
let dragPointer = -1;
const dragStart = { x: 0, y: 0, cx: 0, cy: 0, size: 0 };
const targets = [];
const _btn = { cx: 0, cy: 0, size: 0, hidden: false };

// A second tap on Delete or Reset within this time confirms it
const CONFIRM_MS = 3000;
let confirmWhat = "";
let confirmTime = 0;

/** Registers touch_editlayout and touch_layout */
export function TE_Init() {
  Cmd_AddCommand("touch_editlayout", TE_EditLayout_f);
  Cmd_AddCommand("touch_layout", TE_Layout_f);
}

function TE_EditLayout_f() {
  if (open) return;
  TE_Open();
}

// touch_layout: list the profiles; touch_layout <name>: switch to one
function TE_Layout_f() {
  const s = TL_Store();
  if (Cmd_Argc() < 2) {
    Con_Printf("Touch layouts (* in use):\n");
    for (const p of s.profiles) {
      Con_Printf((p.name === s.active ? " * " : "   ") + p.name + "\n");
    }
    return;
  }

  let name = Cmd_Argv(1);
  for (let i = 2; i < Cmd_Argc(); i++) name += " " + Cmd_Argv(i);
  if (!TL_SetActive(name)) {
    Con_Printf('No touch layout "' + name + '"\n');
    return;
  }
  if (Touch_IsInitialized()) Touch_Relayout();
  if (open) TE_Refresh();
}

/** Is the editor open */
export function TE_IsOpen() {
  return open;
}

/** Opens the editor over the touch controls */
export function TE_Open() {
  if (open) return;
  if (!Touch_IsInitialized() || typeof document === "undefined") {
    Con_Printf("touch_editlayout: this device has no touch controls\n");
    return;
  }

  if (layer === null) TE_Build();
  open = true;
  selId = "";
  selCustom = -1;
  dragPointer = -1;
  confirmWhat = "";
  layer.style.display = "block";
  TE_Hint(HINT);
  Touch_SetEditing(true);

  for (const type of CAPTURED) {
    window.addEventListener(type, TE_OnEvent, {
      capture: true,
      passive: false,
    });
  }
  TE_Refresh();
}

/** Closes the editor and saves */
export function TE_Close() {
  if (!open) return;
  open = false;
  dragPointer = -1;
  for (const type of CAPTURED) {
    window.removeEventListener(type, TE_OnEvent, { capture: true });
  }
  if (document.activeElement && layer.contains(document.activeElement)) {
    document.activeElement.blur();
  }
  layer.style.display = "none";
  TL_Save();
  Touch_SetEditing(false);
}

// Events the editor keeps from the game while open
const CAPTURED = [
  "pointerdown",
  "pointermove",
  "pointerup",
  "pointercancel",
  "mousedown",
  "mouseup",
  "keydown",
  "keyup",
];

function TE_OnEvent(e) {
  if (!open) return;
  e.stopPropagation();

  switch (e.type) {
    case "keydown":
      if (e.key === "Escape") {
        e.preventDefault();
        TE_Close();
      }
      return;
    case "pointerdown":
      TE_PointerDown(e);
      return;
    case "pointermove":
      TE_PointerMove(e);
      return;
    case "pointerup":
    case "pointercancel":
      if (e.pointerId === dragPointer) {
        dragPointer = -1;
        TL_Save();
      }
      return;
  }
}

function TE_PointerDown(e) {
  // The toolbar's own controls work as usual (click, input, focus)
  if (toolbar.contains(e.target)) return;
  e.preventDefault();

  // The topmost button under the finger: custom ones are drawn last
  Touch_EditTargets(targets);
  let hit = null;
  for (let i = targets.length - 1; i >= 0; i--) {
    const t = targets[i];
    if (t.el.style.display === "none") continue;
    const r = t.el.getBoundingClientRect();
    if (
      e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top &&
      e.clientY <= r.bottom
    ) {
      hit = t;
      break;
    }
  }

  if (hit === null) {
    selId = "";
    selCustom = -1;
    TE_Refresh();
    return;
  }

  selId = hit.id;
  selCustom = hit.custom;
  TE_Refresh();

  if (!TE_Movable()) return;
  TE_Current(_btn);
  dragPointer = e.pointerId;
  dragStart.x = e.clientX;
  dragStart.y = e.clientY;
  dragStart.cx = _btn.cx;
  dragStart.cy = _btn.cy;
  dragStart.size = _btn.size;
}

function TE_PointerMove(e) {
  if (e.pointerId !== dragPointer) return;
  e.preventDefault();

  // Screen px to layout units: x is measured in from the action-side edge
  // (the right, unless mirrored) and y up from the bottom
  const scale = Touch_LayoutScale();
  const dx = (e.clientX - dragStart.x) / scale;
  const dy = (e.clientY - dragStart.y) / scale;
  let cx = dragStart.cx + (Touch_LayoutMirrored() ? dx : -dx);
  let cy = dragStart.cy - dy;

  // Keep the whole button on screen
  const half = dragStart.size / 2;
  const w = window.innerWidth / scale;
  const h = window.innerHeight / scale;
  cx = Math.min(Math.max(cx, half), Math.max(w - half, half));
  cy = Math.min(Math.max(cy, half), Math.max(h - half, half));

  if (selCustom >= 0) TL_MoveCustom(selCustom, cx, cy);
  else TL_MoveButton(selId, cx, cy);
  Touch_Relayout();
}

// Can the picked button move and resize (the bar's buttons only hide)
function TE_Movable() {
  if (selCustom >= 0) return true;
  for (const d of TL_MOVABLE) if (d.id === selId) return true;
  return false;
}

// The picked button's centre, size and hidden flag
function TE_Current(out) {
  if (selCustom >= 0) {
    const c = TL_Active().custom[selCustom];
    out.cx = c.cx;
    out.cy = c.cy;
    out.size = c.size;
    out.hidden = c.hidden;
    return out;
  }
  return TL_Button(selId, out);
}

function TE_Label(id) {
  for (const d of TL_MOVABLE) if (d.id === id) return d.label;
  for (const d of TL_HIDE_ONLY) if (d.id === id) return d.label;
  return id;
}

// TOOLBAR

const CONTROL_CSS = `
	min-height: 36px;
	padding: 0 10px;
	border-radius: 8px;
	border: 1px solid rgba(255, 255, 255, 0.4);
	background: rgba(255, 255, 255, 0.12);
	color: #fff;
	font: 14px sans-serif;
`;

function TE_Element(tag, css, parent) {
  const el = document.createElement(tag);
  el.style.cssText = css;
  parent.appendChild(el);
  return el;
}

function TE_Button(text, parent, onClick) {
  const el = TE_Element("button", CONTROL_CSS, parent);
  el.type = "button";
  el.textContent = text;
  el.addEventListener("click", onClick);
  return el;
}

function TE_Input(parent, maxLength, width) {
  const el = TE_Element("input", CONTROL_CSS + `width: ${width};`, parent);
  el.type = "text";
  el.maxLength = maxLength;
  el.autocomplete = "off";
  el.spellcheck = false;
  el.setAttribute("autocapitalize", "off");
  return el;
}

function TE_Row(parent) {
  return TE_Element(
    "div",
    `
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		align-items: center;
		justify-content: center;
	`,
    parent,
  );
}

function TE_Build() {
  layer = document.createElement("div");
  layer.id = "touch-layout-editor";
  // Above the touch controls (200), menu taps (199), sysbar (201) and the
  // rotate prompt (202)
  layer.style.cssText = `
		position: fixed;
		inset: 0;
		z-index: 210;
		display: none;
		background: rgba(0, 0, 0, 0.3);
		touch-action: none;
		user-select: none;
		-webkit-user-select: none;
	`;

  toolbar = TE_Element(
    "div",
    `
		position: absolute;
		top: calc(env(safe-area-inset-top, 0px) + 8px);
		left: 50%;
		transform: translateX(-50%);
		max-width: calc(100vw - 16px);
		box-sizing: border-box;
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 8px;
		border-radius: 10px;
		background: rgba(0, 0, 0, 0.8);
		color: #fff;
		font: 14px sans-serif;
		touch-action: manipulation;
		user-select: auto;
		-webkit-user-select: auto;
	`,
    layer,
  );

  const profiles = TE_Row(toolbar);
  profileSelect = TE_Element("select", CONTROL_CSS, profiles);
  profileSelect.addEventListener("change", () => {
    TL_SetActive(profileSelect.value);
    TE_Deselect();
  });
  nameInput = TE_Input(profiles, TL_MAX_NAME, "9em");
  nameInput.setAttribute("aria-label", "Layout name");
  nameInput.addEventListener("change", () => {
    nameInput.value = TL_RenameActive(nameInput.value);
    TE_Refresh();
  });
  TE_Button("New", profiles, () => {
    TE_Deselect();
    TE_Hint(
      TL_AddProfile() === null ?
        TL_MAX_PROFILES + " layouts at most" :
        "A copy of the last layout: change it as you like",
    );
    TE_Refresh();
  });
  deleteButton = TE_Button("Delete", profiles, () => {
    if (!TE_Confirm("delete")) return;
    TL_DeleteActive();
    TE_Deselect();
    TE_Hint(HINT);
  });
  resetButton = TE_Button("Reset", profiles, () => {
    if (!TE_Confirm("reset")) return;
    TL_ResetButtons();
    TE_Deselect();
    TE_Hint(HINT);
  });
  addButton = TE_Button("+ Button", profiles, () => {
    const i = TL_AddCustom("", "");
    if (i < 0) {
      TE_Hint(TL_MAX_CUSTOM + " buttons at most");
      return;
    }
    selCustom = i;
    selId = "touch-custom-" + (i + 1);
    Touch_Relayout();
    TE_Refresh();
    TE_Hint("Type the command it runs, e.g. impulse 9 or +attack");
  });
  TE_Button("Done", profiles, TE_Close);

  selRow = TE_Row(toolbar);
  selName = TE_Element("span", "font-weight: bold; min-width: 3em;", selRow);
  const sizeLabel = TE_Element("label", "display: flex; gap: 4px;", selRow);
  sizeLabel.textContent = "Size";
  sizeInput = TE_Element("input", "width: 8em;", sizeLabel);
  sizeInput.type = "range";
  sizeInput.min = String(TL_MIN_SIZE);
  sizeInput.max = String(TL_MAX_SIZE);
  sizeInput.step = "2";
  sizeInput.addEventListener("input", () => {
    const size = Number(sizeInput.value);
    if (selCustom >= 0) TL_SetCustom(selCustom, { size }, false);
    else TL_SetButton(selId, undefined, undefined, size, undefined, false);
    Touch_Relayout();
  });
  sizeInput.addEventListener("change", () => TL_Save());
  hideButton = TE_Button("Hide", selRow, () => {
    const hidden = !TE_Current(_btn).hidden;
    if (selCustom >= 0) TL_SetCustom(selCustom, { hidden });
    else TL_SetButton(selId, undefined, undefined, undefined, hidden);
    Touch_Relayout();
    TE_Refresh();
  });

  customRow = TE_Row(toolbar);
  labelInput = TE_Input(customRow, TL_MAX_LABEL, "5em");
  labelInput.placeholder = "Label";
  labelInput.setAttribute("aria-label", "Button label");
  labelInput.addEventListener("input", () => {
    if (selCustom < 0) return;
    TL_SetCustom(selCustom, { label: labelInput.value });
    Touch_Relayout();
  });
  commandInput = TE_Input(customRow, TL_MAX_COMMAND, "12em");
  commandInput.placeholder = "Command";
  commandInput.setAttribute("aria-label", "Command");
  commandInput.addEventListener("input", () => {
    if (selCustom < 0) return;
    TL_SetCustom(selCustom, { command: commandInput.value });
    Touch_Relayout();
  });
  TE_Button("Remove", customRow, () => {
    if (selCustom < 0) return;
    TL_RemoveCustom(selCustom);
    TE_Deselect();
  });

  hintLine = TE_Element(
    "div",
    "text-align: center; opacity: 0.8; font-size: 13px;",
    toolbar,
  );

  document.body.appendChild(layer);
}

// Delete and Reset need a second tap
function TE_Confirm(what) {
  const now = performance.now();
  if (confirmWhat === what && now - confirmTime < CONFIRM_MS) {
    confirmWhat = "";
    return true;
  }
  confirmWhat = what;
  confirmTime = now;
  TE_Hint(
    what === "delete" ?
      "Tap Delete again to delete this layout" :
      "Tap Reset again to put the built-in buttons back",
  );
  return false;
}

const HINT = "Drag a button to move it, or tap one to change it";

function TE_Hint(text) {
  if (hintLine !== null) hintLine.textContent = text;
}

function TE_Deselect() {
  selId = "";
  selCustom = -1;
  Touch_Relayout();
  TE_Refresh();
}

/** Shows the toolbar for the current profile and picked button */
function TE_Refresh() {
  if (layer === null) return;
  const s = TL_Store();

  profileSelect.textContent = "";
  for (const p of s.profiles) {
    const o = document.createElement("option");
    o.value = p.name;
    o.textContent = p.name;
    profileSelect.appendChild(o);
  }
  profileSelect.value = s.active;
  if (document.activeElement !== nameInput) nameInput.value = s.active;
  deleteButton.disabled = s.profiles.length <= 1;
  addButton.disabled = TL_Active().custom.length >= TL_MAX_CUSTOM;
  resetButton.disabled = false;

  // A custom button removed (or a profile switched) under the selection
  if (selCustom >= TL_Active().custom.length) {
    selId = "";
    selCustom = -1;
  }

  if (selId === "") {
    selRow.style.display = "none";
    customRow.style.display = "none";
    return;
  }

  TE_Current(_btn);
  selRow.style.display = "flex";
  selName.textContent = selCustom >= 0 ?
    "Button " + (selCustom + 1) :
    TE_Label(selId);
  sizeInput.disabled = !TE_Movable();
  if (TE_Movable()) sizeInput.value = String(Math.round(_btn.size));
  hideButton.textContent = _btn.hidden ? "Show" : "Hide";

  if (selCustom >= 0) {
    const c = TL_Active().custom[selCustom];
    customRow.style.display = "flex";
    if (document.activeElement !== labelInput) labelInput.value = c.label;
    if (document.activeElement !== commandInput) commandInput.value = c.command;
  } else {
    customRow.style.display = "none";
  }
}
