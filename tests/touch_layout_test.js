// Touch HUD layout profiles (touch_layout.js), the touch controls placing
// buttons from them (touch.js), and the layout editor (touch_editor.js)

// Bootstrap the renderer's circular module graph in its safe order
await import("../src/gl_rsurf.js");

const cmd = await import("../src/cmd.js");
const cvar = await import("../src/cvar.js");
const tl = await import("../src/touch_layout.js");
const touch = await import("../src/touch.js");
const editor = await import("../src/touch_editor.js");
const sbar = await import("../src/sbar.js");

// Keep the tests off Deno's own localStorage, which persists on disk
const memoryStorage = new Map();
tl.TL_SetStorage({
  getItem: (k) => memoryStorage.has(k) ? memoryStorage.get(k) : null,
  setItem: (k, v) => memoryStorage.set(k, String(v)),
});

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${
        JSON.stringify(actual)
      }`,
    );
  }
}

// MODEL

Deno.test("layouts: unreadable storage gives one default profile", () => {
  for (const text of [null, "", "not json", "[]", '{"profiles":5}', "null"]) {
    const s = tl.TL_Parse(text);
    assertEqual(s.profiles.length, 1, "one profile for " + text);
    assertEqual(s.active, "Layout 1", "active for " + text);
    assertEqual(
      Object.keys(s.profiles[0].buttons).length,
      0,
      "no overrides for " + text,
    );
  }
});

Deno.test("layouts: stored values are checked, clamped and capped", () => {
  const custom = [];
  for (let i = 0; i < 12; i++) {
    custom.push({ label: "LONGLABEL", command: "say hi\nquit", size: 1 });
  }
  const s = tl.TL_Parse(JSON.stringify({
    active: "Mine",
    profiles: [
      {
        name: "Mine",
        buttons: {
          "touch-fire": { cx: 300, cy: "x", size: 999, hidden: true },
          "touch-chat": { hidden: true, cx: 5 },
          "touch-pause": { hidden: true }, // the menu button can't be hidden
          nonsense: { cx: 1 },
        },
        custom,
      },
      { name: "Mine" }, // same name: renamed
      7, // not a profile
      ...Array.from({ length: 10 }, (_, i) => ({ name: "P" + i })),
    ],
  }));

  assertEqual(s.profiles.length, tl.TL_MAX_PROFILES, "profiles capped");
  assertEqual(s.active, "Mine", "active kept");
  assertEqual(s.profiles[1].name, "Mine 2", "duplicate name made unique");
  const p = s.profiles[0];
  const fire = p.buttons["touch-fire"];
  assertEqual(fire.cx, 300, "cx kept");
  assertEqual(fire.cy, 112, "bad cy falls back to the default");
  assertEqual(fire.size, tl.TL_MAX_SIZE, "size clamped");
  assertEqual(fire.hidden, true, "hidden kept");
  assertEqual(p.buttons["touch-chat"].hidden, true, "bar button hidden");
  assertEqual(p.buttons["touch-chat"].cx, undefined, "bar buttons don't move");
  assertEqual(p.buttons["touch-pause"], undefined, "menu button dropped");
  assertEqual(p.buttons["nonsense"], undefined, "unknown id dropped");
  assertEqual(p.custom.length, tl.TL_MAX_CUSTOM, "custom buttons capped");
  assertEqual(p.custom[0].label, "LONGLA", "label cut to 6");
  assertEqual(p.custom[0].command, "say hi quit", "newline removed");
  assertEqual(p.custom[0].size, tl.TL_MIN_SIZE, "custom size clamped");

  // An unknown active name falls back to the first profile
  const t = tl.TL_Parse(JSON.stringify({ active: "Gone", profiles: [{}] }));
  assertEqual(t.active, "Layout 1", "unknown active");
});

Deno.test("layouts: buttons, custom buttons and profiles", () => {
  tl.TL_SetStore(tl.TL_Parse(null));
  const b = { cx: 0, cy: 0, size: 0, hidden: false };

  tl.TL_Button("touch-jump", b);
  assertEqual(b.cx + "," + b.cy + "," + b.size, "48,48,64", "JUMP default");
  const v = tl.tl_version;
  tl.TL_SetButton("touch-jump", 70, undefined, 80, undefined, false);
  assertEqual(tl.tl_version > v, true, "a change bumps the version");
  tl.TL_Button("touch-jump", b);
  assertEqual(b.cx + "," + b.cy + "," + b.size, "70,48,80", "JUMP moved");
  tl.TL_SetButton("touch-console", 1, 2, 3, true);
  assertEqual(tl.TL_Hidden("touch-console"), true, "CON hidden");
  tl.TL_SetButton("touch-pause", 1, 2, 3, true);
  assertEqual(tl.TL_Hidden("touch-pause"), false, "the menu button stays");

  assertEqual(tl.TL_AddCustom("GL", "impulse 6"), 0, "first custom button");
  tl.TL_SetCustom(0, { command: "+attack", size: 60 });
  assertEqual(tl.TL_Active().custom[0].command, "+attack", "command set");
  assertEqual(tl.TL_Active().custom[0].label, "GL", "label kept");

  // A new profile copies the current one; deleting goes back to the first
  const name = tl.TL_AddProfile();
  assertEqual(name, "Layout 2", "new profile");
  assertEqual(tl.TL_Active().custom.length, 1, "copied custom buttons");
  assertEqual(tl.TL_RenameActive("Layout 1"), "Layout 1 2", "unique rename");
  tl.TL_ResetButtons();
  tl.TL_Button("touch-jump", b);
  assertEqual(b.cx, 48, "reset puts JUMP back");
  assertEqual(tl.TL_Active().custom.length, 1, "reset keeps custom buttons");
  assertEqual(tl.TL_DeleteActive(), true, "deleted");
  assertEqual(tl.TL_Store().active, "Layout 1", "first profile active");
  tl.TL_Button("touch-jump", b);
  assertEqual(b.cx, 70, "the first profile kept its JUMP");
  assertEqual(tl.TL_DeleteActive(), false, "the last profile stays");
  assertEqual(tl.TL_SetActive("nope"), false, "no such profile");

  for (let i = 1; i < tl.TL_MAX_CUSTOM; i++) tl.TL_AddCustom("", "");
  assertEqual(tl.TL_AddCustom("", ""), -1, "custom buttons full");
  tl.TL_RemoveCustom(0);
  assertEqual(tl.TL_Active().custom.length, tl.TL_MAX_CUSTOM - 1, "removed");
  tl.TL_SetStore(tl.TL_Parse(null));
});

Deno.test("layouts: custom buttons run commands as Key_Event runs bindings", () => {
  assertEqual(tl.TL_BindDown("+attack", 1001), "+attack 1001\n", "+ down");
  assertEqual(tl.TL_BindUp("+attack", 1001), "-attack 1001\n", "+ up");
  assertEqual(tl.TL_BindDown("impulse 9", 1002), "impulse 9\n", "plain down");
  assertEqual(tl.TL_BindUp("impulse 9", 1002), "", "plain up");
  assertEqual(tl.TL_BindDown("", 1003), "", "empty down");
  assertEqual(tl.TL_BindUp("", 1003), "", "empty up");
});

Deno.test("layouts: saved to and read from storage", () => {
  try {
    tl.TL_SetStore(tl.TL_Parse(null));
    tl.TL_SetButton("touch-fire", 200, 150, 100, false);
    const back = tl.TL_Parse(memoryStorage.get("icaro_touch_layouts"));
    assertEqual(back.profiles[0].buttons["touch-fire"].cx, 200, "round trip");
  } finally {
    tl.TL_SetStore(tl.TL_Parse(null));
  }
});

// TOUCH CONTROLS AND EDITOR (fake DOM)

function makeElement(tag) {
  const listeners = new Map();
  const el = {
    tagName: tag || "DIV",
    style: {},
    children: [],
    parent: null,
    listeners,
    textContent: "",
    attributes: {},
    appendChild(child) {
      child.parent = this;
      this.children.push(child);
      return child;
    },
    insertBefore(child, ref) {
      child.parent = this;
      const i = this.children.indexOf(ref);
      if (i < 0) this.children.push(child);
      else this.children.splice(i, 0, child);
      return child;
    },
    remove() {
      if (this.parent === null) return;
      const list = this.parent.children;
      list.splice(list.indexOf(this), 1);
      this.parent = null;
    },
    contains(other) {
      for (let n = other; n !== null && n !== undefined; n = n.parent) {
        if (n === this) return true;
      }
      return false;
    },
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      const list = listeners.get(type);
      if (!list.includes(listener)) list.push(listener);
    },
    removeEventListener(type, listener) {
      const list = listeners.get(type);
      if (list && list.includes(listener)) {
        list.splice(list.indexOf(listener), 1);
      }
    },
    getBoundingClientRect() {
      return {
        left: 0,
        top: 0,
        right: 640,
        bottom: 480,
        width: 640,
        height: 480,
      };
    },
    fire(type, event) {
      for (const l of (listeners.get(type) || []).slice()) l(event);
    },
  };
  return el;
}

const documentTarget = makeElement("DOCUMENT");
const body = makeElement("BODY");
documentTarget.body = body;
documentTarget.activeElement = null;
documentTarget.visibilityState = "visible";
documentTarget.fullscreenElement = null;
documentTarget.createElement = (tag) => makeElement(tag.toUpperCase());
const windowTarget = makeElement("WINDOW");
windowTarget.innerWidth = 640;
windowTarget.innerHeight = 480;

function byId(id, root = body) {
  for (const c of root.children) {
    if (c.id === id) return c;
    const found = byId(id, c);
    if (found !== null) return found;
  }
  return null;
}

const executed = [];
function registerTestCommands() {
  if (cmd.Cmd_Exists("+tl")) return;
  cmd.Cbuf_Init();
  cmd.Cmd_AddCommand("+tl", () => executed.push("+tl " + cmd.Cmd_Argv(1)));
  cmd.Cmd_AddCommand("-tl", () => executed.push("-tl " + cmd.Cmd_Argv(1)));
  cmd.Cmd_AddCommand("tlsay", () => executed.push("tlsay"));
}

function run() {
  cmd.Cbuf_Execute();
  const out = executed.slice();
  executed.length = 0;
  return out;
}

function withFakeDom(fn) {
  const saved = {};
  for (const name of ["document", "window", "matchMedia"]) {
    saved[name] = Object.getOwnPropertyDescriptor(globalThis, name);
  }
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: documentTarget,
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: windowTarget,
  });
  Object.defineProperty(globalThis, "matchMedia", {
    configurable: true,
    value: (q) => ({ matches: q === "(pointer: coarse)" }),
  });
  try {
    return fn();
  } finally {
    for (const name in saved) {
      if (saved[name] === undefined) delete globalThis[name];
      else Object.defineProperty(globalThis, name, saved[name]);
    }
  }
}

const touchEvent = (type, id) => ({
  type,
  changedTouches: [{ identifier: id, clientX: 0, clientY: 0 }],
  targetTouches: [],
  preventDefault() {},
});

function pointer(type, x, y, target) {
  return {
    type,
    pointerId: 7,
    clientX: x,
    clientY: y,
    target,
    defaultPrevented: false,
    stopped: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {
      this.stopped = true;
    },
  };
}

function setup() {
  if (cvar.Cvar_FindVar("touch_size") === null) touch.Touch_RegisterCvars();
  registerTestCommands();
  run();
  touch.Touch_Init(body);
}

Deno.test("touch controls place, hide and add buttons from the active layout", () => {
  withFakeDom(() => {
    setup();
    tl.TL_SetStore(tl.TL_Parse(null));
    try {
      touch.Touch_Enable();
      tl.TL_SetButton("touch-jump", 60, 70, 80);
      tl.TL_SetButton("touch-fire", undefined, undefined, undefined, true);
      tl.TL_SetButton("touch-chat", undefined, undefined, undefined, true);
      tl.TL_AddCustom("ATK", "+tl");
      tl.TL_AddCustom("", "tlsay");
      touch.Touch_Frame(); // sees the new tl_version

      const jump = byId("touch-jump");
      assertEqual(jump.style.width, "80px", "JUMP resized");
      assertEqual(
        jump.style.right,
        "calc(env(safe-area-inset-right, 0px) + 20px)",
        "JUMP moved",
      );
      assertEqual(
        jump.style.bottom,
        "calc(env(safe-area-inset-bottom, 0px) + 30px)",
        "JUMP raised",
      );
      assertEqual(byId("touch-fire").style.display, "none", "FIRE hidden");
      assertEqual(byId("touch-chat").style.display, "none", "CHAT hidden");

      const atk = byId("touch-custom-1");
      assertEqual(atk !== null, true, "custom button made");
      assertEqual(atk.textContent, "ATK", "its label");
      assertEqual(
        byId("touch-custom-2").textContent,
        "2",
        "no label: its number",
      );

      // Off-screen positions (a layout from a bigger screen) are kept on it
      tl.TL_SetCustom(1, { cx: 3000, cy: 3000, size: 50 });
      touch.Touch_Frame();
      assertEqual(
        byId("touch-custom-2").style.right,
        "calc(env(safe-area-inset-right, 0px) + 590px)",
        "clamped to the left edge",
      );

      // A +command is held while the finger stays, released on lift
      atk.fire("touchstart", touchEvent("touchstart", 1));
      assertEqual(run().join("|"), "+tl 1001", "pressed");
      atk.fire("touchend", touchEvent("touchend", 1));
      assertEqual(run().join("|"), "-tl 1001", "released");
      byId("touch-custom-2").fire("touchstart", touchEvent("touchstart", 2));
      byId("touch-custom-2").fire("touchend", touchEvent("touchend", 2));
      assertEqual(run().join("|"), "tlsay", "a plain command runs once");

      // Disabling the controls lets go of a held one
      atk.fire("touchstart", touchEvent("touchstart", 3));
      run();
      touch.Touch_Disable();
      assertEqual(run().join("|"), "-tl 1001", "released on disable");

      // So does removing it, and changing its command
      touch.Touch_Enable();
      atk.fire("touchstart", touchEvent("touchstart", 4));
      run();
      tl.TL_SetCustom(0, { command: "tlsay" });
      touch.Touch_Frame();
      assertEqual(run().join("|"), "-tl 1001", "released on a new command");
      tl.TL_RemoveCustom(1);
      touch.Touch_Frame();
      assertEqual(
        byId("touch-custom-2"),
        null,
        "removed button's element gone",
      );
    } finally {
      touch.Touch_Disable();
      tl.TL_SetStore(tl.TL_Parse(null));
      touch.Touch_Relayout();
      run();
    }
  });
});

Deno.test("layout editor: shows the controls, drags a button, keeps keys from the game", () => {
  withFakeDom(() => {
    setup();
    tl.TL_SetStore(tl.TL_Parse(null));
    try {
      tl.TL_SetButton("touch-fire", undefined, undefined, undefined, true);
      tl.TL_AddCustom("X", "tlsay");
      editor.TE_Open();
      assertEqual(editor.TE_IsOpen(), true, "open");
      assertEqual(
        byId("touch-controls").style.display,
        "block",
        "controls shown",
      );
      assertEqual(
        byId("touch-fire").style.display,
        "flex",
        "hidden FIRE shown",
      );
      assertEqual(byId("touch-fire").style.borderStyle, "dashed", "and marked");

      // The fake rects all cover the screen: the custom button is on top
      const layer = byId("touch-layout-editor");
      const down = pointer("pointerdown", 300, 300, layer);
      windowTarget.fire("pointerdown", down);
      assertEqual(down.stopped, true, "the game doesn't see the pointer");
      const start = tl.TL_Active().custom[0].cx;
      windowTarget.fire("pointermove", pointer("pointermove", 280, 290, layer));
      windowTarget.fire("pointerup", pointer("pointerup", 280, 290, layer));
      assertEqual(tl.TL_Active().custom[0].cx, start + 20, "dragged left");
      assertEqual(tl.TL_Active().custom[0].cy, 120, "and up");

      // Touch input does nothing while editing
      byId("touch-custom-1").fire("touchstart", touchEvent("touchstart", 5));
      byId("touch-custom-1").fire("touchend", touchEvent("touchend", 5));
      assertEqual(run().length, 0, "no command while editing");

      // Keys stop at the editor; Escape closes it
      const key = {
        type: "keydown",
        key: "a",
        stopPropagation() {
          this.stopped = true;
        },
        preventDefault() {},
      };
      windowTarget.fire("keydown", key);
      assertEqual(key.stopped, true, "typed keys kept from the game");
      windowTarget.fire("keydown", {
        type: "keydown",
        key: "Escape",
        stopPropagation() {},
        preventDefault() {},
      });
      assertEqual(editor.TE_IsOpen(), false, "Escape closes");
      assertEqual(
        byId("touch-controls").style.display,
        "none",
        "controls hidden again",
      );
      assertEqual(
        byId("touch-fire").style.display,
        "none",
        "FIRE hidden again",
      );
      assertEqual(
        (windowTarget.listeners.get("keydown") || []).length,
        0,
        "listeners removed",
      );
    } finally {
      editor.TE_Close();
      tl.TL_SetStore(tl.TL_Parse(null));
      touch.Touch_Relayout();
    }
  });
});

Deno.test("touch_layout lists and switches profiles", () => {
  tl.TL_SetStore(tl.TL_Parse(JSON.stringify({
    profiles: [{ name: "One" }, { name: "Two Thumbs" }],
  })));
  try {
    registerTestCommands();
    if (!cmd.Cmd_Exists("touch_layout")) editor.TE_Init();
    cmd.Cmd_ExecuteString("touch_layout Two Thumbs");
    assertEqual(tl.TL_Store().active, "Two Thumbs", "switched");
    cmd.Cmd_ExecuteString("touch_layout nope");
    assertEqual(tl.TL_Store().active, "Two Thumbs", "unknown name ignored");
  } finally {
    tl.TL_SetStore(tl.TL_Parse(null));
  }
});

Deno.test("Touch Controls menu: Enter on Edit Layout opens the editor", async () => {
  const keys = await import("../src/keys.js");
  const menu = await import("../src/menu.js");
  const hadWindow = "window" in globalThis;
  if (!hadWindow) globalThis.window = { devicePixelRatio: 1 };
  try {
    cmd.Cbuf_Init();
    cmd.Cmd_Init();
    keys.Key_Init();
    menu.M_Init();
    if (cvar.Cvar_FindVar("touch_size") === null) touch.Touch_RegisterCvars();
    // Stands in for TE_Init's command, so the test sees what the row runs
    let opened = 0;
    cmd.Cmd_AddCommand("touch_editlayout", () => {});
    let node = cmd.cmd_functions;
    while (node.name !== "touch_editlayout") node = node.next;
    node.fn = () => opened++;

    // Options row 14 opens Touch Controls
    cmd.Cmd_ExecuteString("menu_options");
    for (let i = 0; i < 64 && menu.M_AgentState().cursor !== 14; i++) {
      menu.M_Keydown(keys.K_DOWNARROW);
    }
    menu.M_Keydown(keys.K_ENTER);
    assertEqual(menu.m_state, menu.m_touch, "Touch Controls open");

    // The row's index, from the table's source (other rows may come and go)
    const text = await Deno.readTextFile(
      new URL("../src/menu.js", import.meta.url),
    );
    const table = text.slice(text.indexOf("const touchItems = ["));
    const labels = table.slice(0, table.indexOf("];")).match(/label: "[^"]*"/g);
    const row = labels.findIndex((l) => l.includes("Edit Layout"));
    assertEqual(row >= 0, true, "Edit Layout row in the table");
    for (let i = 0; i < 64 && menu.M_AgentState().cursor !== row; i++) {
      menu.M_Keydown(keys.K_DOWNARROW);
    }
    assertEqual(menu.M_AgentState().cursor, row, "Edit Layout row reached");
    menu.M_Keydown(keys.K_LEFTARROW);
    menu.M_Keydown(keys.K_RIGHTARROW);
    cmd.Cbuf_Execute();
    assertEqual(opened, 0, "arrows don't open it");
    menu.M_Keydown(keys.K_ENTER);
    cmd.Cbuf_Execute();
    assertEqual(opened, 1, "Enter opens it");
  } finally {
    keys.set_key_dest(keys.key_game);
    if (!hadWindow) delete globalThis.window;
  }
});

Deno.test("held buttons let go when hidden or when the editor opens", async () => {
  const ci = await import("../src/cl_input.js");
  withFakeDom(() => {
    setup();
    tl.TL_SetStore(tl.TL_Parse(null));
    try {
      touch.Touch_Enable();
      tl.TL_AddCustom("A", "+tl");
      touch.Touch_Frame();
      const a = byId("touch-custom-1");

      a.fire("touchstart", touchEvent("touchstart", 1));
      assertEqual(run().join("|"), "+tl 1001", "custom pressed");
      tl.TL_SetCustom(0, { hidden: true });
      touch.Touch_Frame();
      assertEqual(run().join("|"), "-tl 1001", "released when hidden");

      tl.TL_SetCustom(0, { hidden: false });
      touch.Touch_Frame();
      a.fire("touchstart", touchEvent("touchstart", 2));
      run();
      editor.TE_Open();
      assertEqual(run().join("|"), "-tl 1001", "released when editing");
      editor.TE_Close();

      touch.Touch_Enable();
      const fire = byId("touch-fire");
      fire.fire("touchstart", touchEvent("touchstart", 3));
      assertEqual(ci.in_attack.state & 1, 1, "FIRE held");
      tl.TL_SetButton("touch-fire", undefined, undefined, undefined, true);
      touch.Touch_Frame();
      assertEqual(ci.in_attack.state & 1, 0, "FIRE let go when hidden");
    } finally {
      editor.TE_Close();
      touch.Touch_Disable();
      tl.TL_SetStore(tl.TL_Parse(null));
      touch.Touch_Relayout();
      run();
    }
  });
});

Deno.test("layout editor: a mirrored layout drags the other way", () => {
  withFakeDom(() => {
    setup();
    tl.TL_SetStore(tl.TL_Parse(null));
    const old = touch.touch_lefthanded.string;
    try {
      cvar.Cvar_Set("touch_lefthanded", "1");
      tl.TL_AddCustom("X", "tlsay");
      editor.TE_Open();
      const layer = byId("touch-layout-editor");
      const start = tl.TL_Active().custom[0].cx;
      windowTarget.fire("pointerdown", pointer("pointerdown", 300, 300, layer));
      windowTarget.fire("pointermove", pointer("pointermove", 280, 300, layer));
      windowTarget.fire("pointerup", pointer("pointerup", 280, 300, layer));
      // Measured from the left edge now, so moving left brings it closer
      assertEqual(tl.TL_Active().custom[0].cx, start - 20, "dragged left");
    } finally {
      editor.TE_Close();
      cvar.Cvar_Set("touch_lefthanded", old);
      tl.TL_SetStore(tl.TL_Parse(null));
      touch.Touch_Relayout();
    }
  });
});

// THE STATUS BAR
//
// The default buttons keep off the status bar (TL_HudRect, TL_HudClearance,
// and Touch_Layout's lift).

// The status bar's CSS px per sbar pixel, as gl_draw.js sizes it by default
// (scr_conheight 240, scr_sbarscale 0) at a touch screen's pixel ratio cap 2
function hudUnit(vw, vh, dpr = 2) {
  let ui = Math.max(1, Math.floor(vh * dpr / 240));
  while (ui > 1 && Math.floor(vw * dpr / ui) < 320) ui--;
  return ui / dpr;
}

// Touch_Layout's lift, at touch_size 1, for the default layout
function defaultLift(vw, hud, mirror, inset) {
  const near = mirror ? hud.left : vw - hud.right;
  const far = mirror ? hud.right : vw - hud.left;
  let lift = 0;
  for (const d of tl.TL_MOVABLE) {
    lift = Math.max(
      lift,
      tl.TL_HudClearance(
        inset.side + d.cx,
        inset.bottom + d.cy,
        d.size,
        near,
        far,
        hud.height,
      ),
    );
  }
  return { lift, near, far };
}

const PHONES = [[812, 375], [844, 390], [932, 430], [667, 375]];
const TABLETS = [[1024, 768], [768, 1024], [1180, 820], [1366, 1024]];
// No notch, then iPhone notch and Dynamic Island insets in landscape
const INSETS = [
  { side: 0, bottom: 0 },
  { side: 47, bottom: 21 },
  { side: 59, bottom: 21 },
];

Deno.test("status bar: footprint on phones, tablets and in deathmatch", () => {
  const out = { left: 0, right: 0, height: 0 };
  // 812x375 at ratio 2: UI scale 3, so 1.5 CSS px per sbar pixel
  tl.TL_HudRect(812, hudUnit(812, 375), 48, false, out);
  assertEqual(out.left, 166.5, "phone: centred, left");
  assertEqual(out.right, 646.5, "phone: right");
  assertEqual(out.height, 72, "phone: 48 lines tall");
  // An iPad's bar nearly fills the bottom edge
  tl.TL_HudRect(1024, hudUnit(1024, 768), 48, false, out);
  assertEqual(out.right - out.left, 960, "tablet: 960 wide");
  assertEqual(out.height, 144, "tablet: 144 tall");
  // Deathmatch: at the left edge, with the frag list beside it
  tl.TL_HudRect(812, 1.5, 48, true, out);
  assertEqual(out.left, 0, "deathmatch: left edge");
  assertEqual(out.right, 750, "deathmatch: frag list to x 500");
  tl.TL_HudRect(667, 1.5, 48, true, out);
  assertEqual(out.right, 480, "deathmatch, under 512 wide: no frag list");
  // A bar wider than the screen (scr_sbarscale) stops at its edges
  tl.TL_HudRect(400, 2, 24, false, out);
  assertEqual(out.left, 0, "wide: left");
  assertEqual(out.right, 400, "wide: right");
  // viewsize 120: no bar, nothing to clear
  tl.TL_HudRect(812, 1.5, 0, false, out);
  assertEqual(out.height, 0, "no bar");
  assertEqual(tl.TL_HudClearance(100, 20, 44, 0, 812, 0), 0, "no lift");
});

Deno.test("status bar: clearance is how far a button must rise", () => {
  const m = tl.TL_HUD_MARGIN;
  // Bar 72 tall from 166 to 646 px in from the action edge
  assertEqual(tl.TL_HudClearance(48, 48, 64, 166, 646, 72), 0, "beside it");
  assertEqual(
    tl.TL_HudClearance(148, 40, 44, 166, 646, 72),
    72 + m - 18,
    "the old DOWN spot overlapped it",
  );
  assertEqual(tl.TL_HudClearance(176, 100, 44, 166, 646, 72), 0, "above it");
  assertEqual(tl.TL_HudClearance(700, 30, 44, 166, 646, 72), 0, "past it");
});

Deno.test("status bar: no default button covers it, on phones and tablets", () => {
  const hud = { left: 0, right: 0, height: 0 };
  // The default buttons never overlap each other (the lift moves them as one)
  for (const a of tl.TL_MOVABLE) {
    for (const b of tl.TL_MOVABLE) {
      if (a === b) continue;
      const gap = Math.hypot(a.cx - b.cx, a.cy - b.cy) - (a.size + b.size) / 2;
      if (gap < 4) throw new Error(`${a.id} and ${b.id} ${gap} px apart`);
    }
  }
  for (const [vw, vh] of [...PHONES, ...TABLETS]) {
    for (const inset of INSETS) {
      for (const mirror of [false, true]) {
        for (const dm of [false, true]) {
          const what = `${vw}x${vh} inset ${inset.side}/${inset.bottom}` +
            (mirror ? " mirrored" : "") + (dm ? " deathmatch" : "");
          tl.TL_HudRect(vw, hudUnit(vw, vh), 48, dm, hud);
          const { lift, near, far } = defaultLift(vw, hud, mirror, inset);
          for (const d of tl.TL_MOVABLE) {
            const x = inset.side + d.cx;
            const y = inset.bottom + d.cy + lift;
            // Clear of the bar by the margin...
            const r = d.size / 2;
            const beside = x + r <= near - tl.TL_HUD_MARGIN ||
              x - r >= far + tl.TL_HUD_MARGIN;
            if (!beside && y - r < hud.height + tl.TL_HUD_MARGIN) {
              throw new Error(`${what}: ${d.id} covers the status bar`);
            }
            // ...and under the top bar's row (12 + 32 px)
            if (y + r > vh - 56) {
              throw new Error(`${what}: ${d.id} lifted off the top`);
            }
          }
          // Phones keep the usual spot outside deathmatch (667 px, a phone
          // with no notch: FIRE's bottom edge dips 4 px under the bar's top,
          // so a few px up)
          if (!dm && vh < 500 && (vw !== 667 || inset.side === 0)) {
            const most = vw === 667 ? 8 : 0;
            if (lift > most) throw new Error(`${what}: lifted ${lift} px`);
          }
        }
      }
    }
  }
});

Deno.test("status bar: Touch_Layout lifts default buttons, not moved ones", () => {
  withFakeDom(() => {
    setup();
    tl.TL_SetStore(tl.TL_Parse(null));
    const oldLines = sbar.sb_lines;
    try {
      touch.Touch_Enable();
      // The fake screen is 640x480 at ratio 1: UI scale 2, so the bar fills
      // the bottom edge, 96 px tall
      sbar.set_sb_lines(48);
      tl.TL_MoveButton("touch-fire", 100, 30); // the player put FIRE low
      tl.TL_SetButton("touch-weapon-prev", undefined, undefined, 50); // resized
      tl.TL_Save();
      const saved = memoryStorage.get("icaro_touch_layouts");
      touch.Touch_Frame(); // sees the bar change
      const lift = 96 + tl.TL_HUD_MARGIN - (48 - 32); // JUMP's bottom edge
      assertEqual(
        byId("touch-jump").style.bottom,
        `calc(env(safe-area-inset-bottom, 0px) + ${16 + lift}px)`,
        "JUMP lifted over the bar",
      );
      assertEqual(
        byId("touch-weapon-prev").style.bottom,
        `calc(env(safe-area-inset-bottom, 0px) + ${176 - 25 + lift}px)`,
        "a resized button at its default centre lifts too",
      );
      assertEqual(
        byId("touch-fire").style.bottom,
        "calc(env(safe-area-inset-bottom, 0px) + 0px)",
        "the moved FIRE stays put",
      );
      assertEqual(
        memoryStorage.get("icaro_touch_layouts"),
        saved,
        "nothing saved",
      );

      // The editor picks DOWN up where it is shown, so it doesn't jump
      editor.TE_Open();
      const layer = byId("touch-layout-editor");
      windowTarget.fire("pointerdown", pointer("pointerdown", 300, 300, layer));
      windowTarget.fire("pointermove", pointer("pointermove", 300, 290, layer));
      windowTarget.fire("pointerup", pointer("pointerup", 300, 290, layer));
      const b = tl.TL_Button("touch-movedown", {});
      assertEqual(b.cy, 100 + lift + 10, "dragged up from its lifted spot");

      // No bar (viewsize 120): back down
      editor.TE_Close();
      tl.TL_ResetButtons();
      sbar.set_sb_lines(0);
      touch.Touch_Frame();
      assertEqual(
        byId("touch-jump").style.bottom,
        "calc(env(safe-area-inset-bottom, 0px) + 16px)",
        "no bar, no lift",
      );
    } finally {
      editor.TE_Close();
      sbar.set_sb_lines(oldLines);
      tl.TL_SetStore(tl.TL_Parse(null));
      touch.Touch_Frame();
      touch.Touch_Disable();
    }
  });
});
