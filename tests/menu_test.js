const cmd = await import("../src/cmd.js");
const keys = await import("../src/keys.js");
const menu = await import("../src/menu.js");

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

Deno.test("customize controls binds printable and named keys", () => {
  const oldBindings = keys.keybindings.slice();

  try {
    cmd.Cbuf_Init();
    cmd.Cmd_Init();
    keys.Key_Init();
    menu.M_Init();
    keys.keybindings.fill(null);

    cmd.Cmd_ExecuteString("menu_keys");
    menu.M_Keydown(keys.K_ENTER);
    menu.M_Keydown(49);
    cmd.Cbuf_Execute();
    assertEqual(keys.keybindings[49], "+attack", "printable key binding");

    menu.M_Keydown(keys.K_ENTER);
    menu.M_Keydown(keys.K_MOUSE1);
    cmd.Cbuf_Execute();
    assertEqual(
      keys.keybindings[keys.K_MOUSE1],
      "+attack",
      "mouse key binding",
    );
  } finally {
    keys.keybindings.splice(0, keys.keybindings.length, ...oldBindings);
  }
});

Deno.test("the game options menu offers the registered episodes only when registered", async () => {
  const common = await import("../src/common.js");
  common.COM_Init(); // creates the registered cvar
  const old = common.registered.value;
  try {
    common.registered.value = 0;
    assertEqual(
      menu.M_NumEpisodes(),
      2,
      "shareware: Welcome, Doomed Dimension",
    );
    common.registered.value = 1;
    assertEqual(
      menu.M_NumEpisodes(),
      7,
      "registered adds E2-E4, the end and the id1 DM maps",
    );
  } finally {
    common.registered.value = old;
  }
});

Deno.test("touch menus: Touch Controls page, slider taps and Setup rows", async () => {
  const cvar = await import("../src/cvar.js");
  const touch = await import("../src/touch.js");
  const sound = await import("../src/sound.js");
  const draw = await import("../src/gl_draw.js");

  const hadWindow = "window" in globalThis;
  if (!hadWindow) globalThis.window = { devicePixelRatio: 1 };
  try {
    cmd.Cbuf_Init();
    cmd.Cmd_Init();
    keys.Key_Init();
    menu.M_Init();
    if (cvar.Cvar_FindVar("touch_sensitivity") === null) {
      touch.Touch_RegisterCvars();
    }
    if (cvar.Cvar_FindVar("volume") === null) {
      cvar.Cvar_RegisterVariable(sound.volume);
    }
    for (const [name, value] of [["viewsize", "100"], ["sensitivity", "3"]]) {
      if (cvar.Cvar_FindVar(name) === null) {
        cvar.Cvar_RegisterVariable({
          name,
          string: value,
          value: Number(value),
        });
      }
    }

    // Tap at a point in the 320x200 menu space
    const w = draw.Draw_GetVirtualWidth();
    const h = draw.Draw_GetVirtualHeight();
    const tap = (vx, vy) =>
      menu.M_TouchInput(vx + (w - 320) / 2, vy + (h - 200) / 2, w, h);
    const near = (a, b, m) =>
      assertEqual(
        Math.abs(a - b) < 1e-6,
        true,
        m + " (" + a + " vs " + b + ")",
      );

    // Options row 14 opens the Touch Controls page
    cmd.Cmd_ExecuteString("menu_options");
    tap(100, 32 + 14 * 8 + 4);
    assertEqual(
      menu.m_state,
      menu.m_touch,
      "Touch controls row opens the page",
    );

    // Look Speed slider (row 0, y 48): ends of the slider and the middle, snapped to 0.25
    tap(300, 52);
    near(touch.touch_sensitivity.value, 3, "right end is the maximum");
    tap(210, 52);
    near(touch.touch_sensitivity.value, 0.25, "left cap is the minimum");
    tap(256, 52);
    near(touch.touch_sensitivity.value, 1.75, "middle snaps to a step");

    // Gyro Aiming (row 1) is a choice: a tap steps it, wrapping, and
    // left from off wraps to the last
    const gyro = touch.touch_gyro.value;
    try {
      cvar.Cvar_SetValue("touch_gyro", 2);
      tap(100, 48 + 8 + 4);
      assertEqual(touch.touch_gyro.value, 3, "tap steps the choice");
      tap(100, 48 + 8 + 4);
      assertEqual(touch.touch_gyro.value, 0, "and wraps to off");
      menu.M_Keydown(keys.K_LEFTARROW);
      assertEqual(touch.touch_gyro.value, 3, "left from off wraps");
    } finally {
      cvar.Cvar_SetValue("touch_gyro", gyro);
    }

    // Tapping a label steps a slider up and flips a toggle
    tap(100, 52);
    near(touch.touch_sensitivity.value, 2, "label tap steps up");
    const lefty = touch.touch_lefthanded.value;
    tap(100, 48 + 6 * 8 + 4);
    assertEqual(
      touch.touch_lefthanded.value,
      lefty ? 0 : 1,
      "Left-Handed toggles",
    );
    tap(100, 48 + 6 * 8 + 4);

    // Look Screen-Size toggles; Look Acceleration slides
    const screenOn = touch.touch_look_screen.value;
    const accel = touch.touch_look_accel.value;
    try {
      cvar.Cvar_SetValue("touch_look_screen", 1);
      tap(100, 48 + menu.M_TouchRow("touch_look_screen") * 8 + 4);
      assertEqual(touch.touch_look_screen.value, 0, "Look Screen-Size toggles");
      tap(300, 48 + menu.M_TouchRow("touch_look_accel") * 8 + 4);
      near(touch.touch_look_accel.value, 2, "Look Acceleration maximum");
    } finally {
      cvar.Cvar_SetValue("touch_look_screen", screenOn);
      cvar.Cvar_SetValue("touch_look_accel", accel);
    }

    // Escape goes back to Options; a tap on the Sound Volume slider (row 8) sets it
    menu.M_Keydown(keys.K_ESCAPE);
    assertEqual(menu.m_state, menu.m_options, "back to Options");
    tap(220, 32 + 8 * 8 + 4);
    near(sound.volume.value, 0, "volume at the left end");
    tap(256, 32 + 8 * 8 + 4);
    near(sound.volume.value, 0.5, "volume in the middle");

    // Screen size (row 4) and mouse speed (row 6) have their own ranges
    tap(292, 32 + 4 * 8 + 4);
    near(
      cvar.Cvar_FindVar("viewsize").value,
      120,
      "screen size at the right end",
    );
    tap(220, 32 + 4 * 8 + 4);
    near(
      cvar.Cvar_FindVar("viewsize").value,
      30,
      "screen size at the left end",
    );
    tap(256, 32 + 6 * 8 + 4);
    near(
      cvar.Cvar_FindVar("sensitivity").value,
      6,
      "mouse speed in the middle",
    );

    // Setup: the name row only takes the cursor, Accept Changes leaves the menu
    cmd.Cmd_ExecuteString("menu_setup");
    assertEqual(menu.m_state, menu.m_setup, "setup menu open");
    tap(100, 42);
    assertEqual(menu.m_state, menu.m_setup, "name row stays in setup");
    tap(100, 126);
    assertEqual(
      menu.m_state === menu.m_setup,
      false,
      "Accept Changes leaves setup",
    );
  } finally {
    touch.touch_sensitivity.value = 1;
    touch.touch_sensitivity.string = "1";
    if (!hadWindow) delete globalThis.window;
  }
});

Deno.test("touch taps on dense menus select first, then act; taps just outside a list snap to it", async () => {
  const cvar = await import("../src/cvar.js");
  const touch = await import("../src/touch.js");
  const sound = await import("../src/sound.js");
  const draw = await import("../src/gl_draw.js");

  const hadWindow = "window" in globalThis;
  if (!hadWindow) globalThis.window = { devicePixelRatio: 1 };
  try {
    cmd.Cbuf_Init();
    cmd.Cmd_Init();
    keys.Key_Init();
    menu.M_Init();
    if (cvar.Cvar_FindVar("touch_sensitivity") === null) {
      touch.Touch_RegisterCvars();
    }
    if (cvar.Cvar_FindVar("volume") === null) {
      cvar.Cvar_RegisterVariable(sound.volume);
    }

    const w = draw.Draw_GetVirtualWidth();
    const h = draw.Draw_GetVirtualHeight();
    const finger = (vx, vy) =>
      menu.M_TouchInput(vx + (w - 320) / 2, vy + (h - 200) / 2, w, h, true);
    const mouse = (vx, vy) =>
      menu.M_TouchInput(vx + (w - 320) / 2, vy + (h - 200) / 2, w, h);
    const cursor = () => menu.M_AgentState().cursor;

    // Options (8-unit rows): a finger on row 14 moves the cursor only
    cmd.Cmd_ExecuteString("menu_options");
    finger(100, 32 + 14 * 8 + 4);
    assertEqual(menu.m_state, menu.m_options, "first tap stays in Options");
    assertEqual(cursor(), 14, "first tap moves the cursor");
    finger(100, 32 + 14 * 8 + 4);
    assertEqual(
      menu.m_state,
      menu.m_touch,
      "second tap on the cursor row opens Touch Controls",
    );

    // A slider row: the first tap selects without changing the value
    menu.M_Keydown(keys.K_ESCAPE);
    const vol = sound.volume.value;
    finger(220, 32 + 8 * 8 + 4);
    assertEqual(cursor(), 8, "slider row selected");
    assertEqual(sound.volume.value, vol, "first tap leaves the slider alone");
    finger(220, 32 + 8 * 8 + 4);
    assertEqual(sound.volume.value, 0, "second tap sets it");

    // Mouse clicks still act at once (the hover has already moved the cursor)
    mouse(100, 32 + 14 * 8 + 4);
    assertEqual(
      menu.m_state,
      menu.m_touch,
      "mouse click acts on the first click",
    );

    // Snap: a finger just outside the Options list takes its nearest row
    menu.M_Keydown(keys.K_ESCAPE);
    const listEnd = 32 + 18 * 8; // OPTIONS_ITEMS rows of 8 units
    assertEqual(
      menu.M_MenuRowAt(100, 1000),
      -1,
      "far below the list is no row",
    );
    assertEqual(
      menu.M_MenuRowAt(100, 31, 4),
      0,
      "just above the list snaps to row 0",
    );
    assertEqual(
      menu.M_MenuRowAt(100, listEnd + 3, 4),
      17,
      "just below the list snaps to the last row",
    );
    assertEqual(menu.M_MenuRowAt(100, 31), -1, "without slack, no row");
    assertEqual(menu.M_MenuRowAt(100, 27, 4), -1, "beyond the slack, no row");
    finger(100, listEnd + 3);
    assertEqual(
      cursor(),
      17,
      "a finger just below the list selects the last row",
    );

    // The 20-unit main menu acts on the first tap
    cmd.Cmd_ExecuteString("menu_main");
    finger(100, 31);
    assertEqual(menu.m_state, menu.m_main, "no snap on the main menu");
    finger(100, 32 + 1 * 20 + 10);
    assertEqual(
      menu.m_state,
      menu.m_multiplayer,
      "main menu row 1 opens at once",
    );
  } finally {
    keys.set_key_dest(keys.key_game);
    if (!hadWindow) delete globalThis.window;
  }
});
