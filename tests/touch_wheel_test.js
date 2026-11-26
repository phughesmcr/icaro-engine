// Weapon wheel geometry and the overlay-button rule (port-roadmap items 11, 12)

// Bootstrap the renderer's existing circular module graph in its safe order.
await import("../src/gl_rsurf.js");

const touch = await import("../src/touch.js");
const q = await import("../src/quakedef.js");

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${
        JSON.stringify(actual)
      }`,
    );
  }
}

const IN = 30;
const OUT = 190;

Deno.test("wheel: slots run clockwise from straight up", () => {
  const r = 90;
  const s = Math.SQRT1_2 * r;
  const cases = [
    [0, -r, 1],
    [s, -s, 2],
    [r, 0, 3],
    [s, s, 4],
    [0, r, 5],
    [-s, s, 6],
    [-r, 0, 7],
    [-s, -s, 8],
  ];

  for (const [dx, dy, slot] of cases) {
    assertEqual(
      touch.Touch_WheelSlotAt(dx, dy, IN, OUT),
      slot,
      `(${dx}, ${dy})`,
    );
  }
});

Deno.test("wheel: sector edges and the wrap past slot 1", () => {
  // 20 degrees either side of up is still slot 1; 25 degrees is the next slot
  const at = (deg) =>
    touch.Touch_WheelSlotAt(
      Math.sin(deg * Math.PI / 180) * 100,
      -Math.cos(deg * Math.PI / 180) * 100,
      IN,
      OUT,
    );
  assertEqual(at(20), 1, "+20");
  assertEqual(at(-20), 1, "-20");
  assertEqual(at(25), 2, "+25");
  assertEqual(at(-25), 8, "-25");
  assertEqual(at(180), 5, "180");
  assertEqual(at(350), 1, "350");
});

Deno.test("wheel: dead zone and far distance select nothing", () => {
  assertEqual(touch.Touch_WheelSlotAt(0, 0, IN, OUT), null, "centre");
  assertEqual(
    touch.Touch_WheelSlotAt(0, -29, IN, OUT),
    null,
    "inside dead zone",
  );
  assertEqual(
    touch.Touch_WheelSlotAt(0, -31, IN, OUT),
    1,
    "just outside dead zone",
  );
  assertEqual(touch.Touch_WheelSlotAt(0, -191, IN, OUT), null, "too far");
});

function weapons() {
  const out = [];
  for (let i = 0; i < 8; i++) out.push({ owned: false, ammo: false });
  return out;
}

Deno.test("wheel: weapons come from items and ammo stats", () => {
  const stats = new Int32Array(q.MAX_CL_STATS);
  stats[q.STAT_SHELLS] = 25;
  stats[q.STAT_ROCKETS] = 0;
  const w = touch.Touch_WheelWeapons(
    q.IT_AXE | q.IT_SHOTGUN | q.IT_ROCKET_LAUNCHER,
    stats,
    weapons(),
  );

  assertEqual(w[0].owned && w[0].ammo, true, "axe is owned and needs no ammo");
  assertEqual(w[1].owned && w[1].ammo, true, "shotgun with shells");
  assertEqual(w[2].owned, false, "no super shotgun");
  assertEqual(w[6].owned, true, "rocket launcher owned");
  assertEqual(w[6].ammo, false, "rocket launcher without rockets is dim");
  assertEqual(w[7].owned, false, "no lightning");
});

Deno.test("wheel: an unowned slot cancels, an owned one selects", () => {
  const stats = new Int32Array(q.MAX_CL_STATS);
  const w = touch.Touch_WheelWeapons(q.IT_AXE | q.IT_SHOTGUN, stats, weapons());

  assertEqual(touch.Touch_WheelSelect(0, -90, IN, OUT, w), 1, "axe (up)");
  assertEqual(
    touch.Touch_WheelSelect(64, -64, IN, OUT, w),
    2,
    "shotgun (up-right)",
  );
  assertEqual(
    touch.Touch_WheelSelect(0, 90, IN, OUT, w),
    null,
    "slot 5 not owned",
  );
  assertEqual(touch.Touch_WheelSelect(0, 0, IN, OUT, w), null, "centre");
});

Deno.test("buttons: quick save and load need a local single-player game", () => {
  const out = { save: false, load: false, console: false, chat: false };

  touch.Touch_ButtonsVisible(true, false, false, out);
  assertEqual(out.save, true, "sp save");
  assertEqual(out.load, false, "sp load without a slot");
  assertEqual(out.console, true, "sp console");
  assertEqual(out.chat, false, "sp chat");

  touch.Touch_ButtonsVisible(true, false, true, out);
  assertEqual(out.load, true, "sp load with a slot");

  touch.Touch_ButtonsVisible(false, true, true, out);
  assertEqual(out.save, false, "mp save");
  assertEqual(out.load, false, "mp load even with a slot");
  assertEqual(out.chat, true, "mp chat");
  assertEqual(out.console, true, "mp console");

  touch.Touch_ButtonsVisible(false, false, true, out);
  assertEqual(
    out.save || out.load || out.console || out.chat,
    false,
    "demo or menu: nothing",
  );
});

Deno.test("buttons: the bar shrinks to fit a narrow screen", () => {
  // touch_size 2 on a 320 px portrait screen: four buttons from x = 100
  const s = touch.Touch_BarScale(2, 100, 320, 4);
  if (!(s < 2 && s >= 0.5)) throw new Error(`scale ${s}`);
  const end = 100 + 4 * 44 * s + 3 * 6;
  if (end > 320 - 12 + 1e-9) throw new Error(`row ends at ${end}`);

  assertEqual(
    touch.Touch_BarScale(1, 60, 844, 4),
    1,
    "room to spare keeps touch_size",
  );
  assertEqual(touch.Touch_BarScale(1, 60, 100, 4), 0.5, "never below 0.5");
  assertEqual(touch.Touch_BarScale(1.5, 60, 320, 0), 1.5, "nothing shown");
  assertEqual(touch.Touch_BarScale(1.5, 60, 0, 4), 1.5, "no window");
});

// DOM-level: tap versus hold on WPN▶
const cmd = await import("../src/cmd.js");
const client = await import("../src/client.js");
const cl_input = await import("../src/cl_input.js");

function makeEl() {
  const listeners = new Map();
  return {
    style: {},
    children: [],
    textContent: "",
    appendChild(c) {
      this.children.push(c);
      return c;
    },
    addEventListener(t, l) {
      if (!listeners.has(t)) listeners.set(t, []);
      listeners.get(t).push(l);
    },
    removeEventListener(t, l) {
      const list = listeners.get(t);
      if (list !== undefined && list.includes(l)) {
        list.splice(list.indexOf(l), 1);
      }
    },
    getBoundingClientRect() {
      return { left: 500, top: 300, width: 56, height: 56 };
    },
    fire(t, e) {
      for (const l of (listeners.get(t) || []).slice()) l(e);
    },
  };
}

Deno.test("wheel: tap cycles; hold, slide and release sends the slot; release off-slot cancels", async () => {
  const all = [];
  const docTarget = makeEl();
  const body = makeEl();
  docTarget.body = body;
  docTarget.visibilityState = "visible";
  docTarget.createElement = () => {
    const el = makeEl();
    all.push(el);
    return el;
  };
  const winTarget = makeEl();

  const saved = {};
  for (const name of ["document", "window", "innerWidth", "innerHeight"]) {
    saved[name] = Object.getOwnPropertyDescriptor(globalThis, name);
  }
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: docTarget,
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: winTarget,
  });
  Object.defineProperty(globalThis, "innerWidth", {
    configurable: true,
    value: 640,
  });
  Object.defineProperty(globalThis, "innerHeight", {
    configurable: true,
    value: 480,
  });

  const savedItems = client.cl.items;
  const impulses = [];
  cmd.Cbuf_Init();
  cmd.Cmd_AddCommand("impulse", () => impulses.push(cmd.Cmd_Argv(1)));

  try {
    client.cl.items = q.IT_AXE | q.IT_SHOTGUN | q.IT_ROCKET_LAUNCHER;
    touch.Touch_Init(body);
    touch.Touch_Enable();

    const wpn = all.find((e) => e.textContent === "WPN▶");
    if (wpn === undefined) throw new Error("WPN button not created");
    const ev = (type, x, y) => ({
      type,
      changedTouches: [{ identifier: 7, clientX: x, clientY: y }],
      targetTouches: [],
      preventDefault() {},
    });
    const run = () => cmd.Cbuf_Execute();
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));

    // Quick tap: impulse 10 on release
    wpn.fire("touchstart", ev("touchstart", 528, 328));
    wpn.fire("touchend", ev("touchend", 528, 328));
    run();
    assertEqual(impulses.join(","), "10", "tap cycles");

    // Hold: the wheel opens centred on the button, (528, 328), inside the
    // 640x480 view. Slot 7 (rocket launcher) is straight left of it.
    impulses.length = 0;
    wpn.fire("touchstart", ev("touchstart", 528, 328));
    await wait(360);
    wpn.fire("touchmove", ev("touchmove", 528 - 92, 328));
    wpn.fire("touchend", ev("touchend", 528 - 92, 328));
    run();
    assertEqual(impulses.join(","), "7", "rocket launcher slot");

    // Release over an unowned slot (straight down is 5): cancel, and a
    // long hold is not a tap
    impulses.length = 0;
    wpn.fire("touchstart", ev("touchstart", 528, 328));
    await wait(360);
    wpn.fire("touchmove", ev("touchmove", 528, 328 + 92));
    wpn.fire("touchend", ev("touchend", 528, 328 + 92));
    run();
    assertEqual(impulses.length, 0, "unowned slot cancels");

    // Release in the middle: cancel
    wpn.fire("touchstart", ev("touchstart", 528, 328));
    await wait(360);
    wpn.fire("touchend", ev("touchend", 528, 328));
    run();
    assertEqual(impulses.length, 0, "release at the centre cancels");

    // A second finger cancelled on WPN▶ leaves the first finger's wheel open
    const ev2 = (type, id, x, y) => ({
      type,
      changedTouches: [{ identifier: id, clientX: x, clientY: y }],
      targetTouches: [],
      preventDefault() {},
    });
    wpn.fire("touchstart", ev("touchstart", 528, 328));
    await wait(360);
    wpn.fire("touchstart", ev2("touchstart", 9, 540, 340));
    wpn.fire("touchcancel", ev2("touchcancel", 9, 540, 340));
    wpn.fire("touchmove", ev("touchmove", 528 - 92, 328));
    wpn.fire("touchend", ev("touchend", 528 - 92, 328));
    run();
    assertEqual(
      impulses.join(","),
      "7",
      "other finger cancelled: the wheel still selects",
    );

    // The wheel's own finger cancelled: no impulse
    impulses.length = 0;
    wpn.fire("touchstart", ev("touchstart", 528, 328));
    await wait(360);
    wpn.fire("touchmove", ev("touchmove", 528 - 92, 328));
    wpn.fire("touchcancel", ev("touchcancel", 528 - 92, 328));
    wpn.fire("touchend", ev("touchend", 528 - 92, 328));
    run();
    assertEqual(impulses.length, 0, "cancel sends nothing");

    // Releasing all buttons (focus loss, menu) with the wheel open: no
    // impulse, and the pending hold timer is cleared too
    wpn.fire("touchstart", ev("touchstart", 528, 328));
    await wait(360);
    wpn.fire("touchmove", ev("touchmove", 528 - 92, 328));
    touch.Touch_ReleaseButtons();
    wpn.fire("touchend", ev("touchend", 528 - 92, 328));
    wpn.fire("touchstart", ev("touchstart", 528, 328));
    touch.Touch_ReleaseButtons();
    await wait(360);
    wpn.fire("touchend", ev("touchend", 528, 328));
    run();
    assertEqual(
      impulses.length,
      0,
      "release-all closes the wheel and its timer",
    );

    // DOWN holds +movedown while touched and lets go on touchend,
    // touchcancel and release-all
    const down = all.find((e) => e.textContent === "DOWN");
    if (down === undefined) throw new Error("DOWN button not created");
    cl_input.in_down.state = 0;
    down.fire("touchstart", ev("touchstart", 140, 40));
    assertEqual(cl_input.in_down.state & 1, 1, "DOWN held");
    down.fire("touchend", ev("touchend", 140, 40));
    assertEqual(cl_input.in_down.state & 1, 0, "DOWN let go on touchend");
    down.fire("touchstart", ev("touchstart", 140, 40));
    down.fire("touchcancel", ev("touchcancel", 140, 40));
    assertEqual(cl_input.in_down.state & 1, 0, "DOWN let go on touchcancel");
    down.fire("touchstart", ev("touchstart", 140, 40));
    touch.Touch_ReleaseButtons();
    assertEqual(cl_input.in_down.state & 1, 0, "DOWN let go on release-all");
    cl_input.in_down.state = 0;

    touch.Touch_Disable();
  } finally {
    client.cl.items = savedItems;
    for (const name in saved) {
      if (saved[name] === undefined) delete globalThis[name];
      else Object.defineProperty(globalThis, name, saved[name]);
    }
  }
});
