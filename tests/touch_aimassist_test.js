// touch_aimassist (web-only): the Touch Controls slider that sets the local
// server's sv_aim
const cvar = await import("../src/cvar.js");
const touch = await import("../src/touch.js");

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

// sv_aim goes through Q_atof, which isn't exact
function assertNear(actual, expected, message) {
  if (Math.abs(actual - expected) > 1e-9) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

function registerCvars() {
  if (cvar.Cvar_FindVar("touch_aimassist") === null) {
    touch.Touch_RegisterCvars();
  }
  if (cvar.Cvar_FindVar("sv_aim") === null) {
    // sv_main.js's sv_aim, without importing the server
    cvar.Cvar_RegisterVariable({ name: "sv_aim", string: "0.93", value: 0.93 });
  }
}

Deno.test("aim assist levels map to sv_aim cones, clamped and rounded", () => {
  assertEqual(touch.Touch_AimAssistCone(0), 1, "level 0 is off");
  assertEqual(touch.Touch_AimAssistCone(2), 0.93, "level 2 is Quake's");
  assertEqual(touch.Touch_AimAssistCone(4), 0.8, "level 4 is the widest");
  assertEqual(touch.Touch_AimAssistLevel(2.6), 3, "rounds");
  assertEqual(touch.Touch_AimAssistLevel(-3), 0, "clamps below");
  assertEqual(touch.Touch_AimAssistLevel(9), 4, "clamps above");
});

Deno.test("touch_aimassist writes sv_aim only when it changes", () => {
  registerCvars();
  const sv_aim = cvar.Cvar_FindVar("sv_aim");
  const oldAim = sv_aim.string;
  const oldLevel = touch.touch_aimassist.string;
  const level = (s) => cvar.Cvar_Set("touch_aimassist", s);

  try {
    // At the default level, a console sv_aim stands
    cvar.Cvar_Set("sv_aim", "0.5");
    level("2");
    touch.Touch_AimAssistFrame();
    assertNear(sv_aim.value, 0.5, "default level leaves sv_aim alone");

    // A saved level other than the default is applied on the first frame
    level("3");
    touch.Touch_AimAssistFrame();
    assertNear(sv_aim.value, 0.87, "level 3 applied");

    // Later console edits stand until the level changes again
    cvar.Cvar_Set("sv_aim", "0.95");
    touch.Touch_AimAssistFrame();
    assertNear(sv_aim.value, 0.95, "console edit kept");

    level("0");
    touch.Touch_AimAssistFrame();
    assertNear(sv_aim.value, 1, "level 0 turns autoaim off");

    // Out of range or between levels: clamped and rounded
    level("9");
    touch.Touch_AimAssistFrame();
    assertNear(sv_aim.value, 0.8, "clamped to level 4");
    level("2.6");
    touch.Touch_AimAssistFrame();
    assertNear(sv_aim.value, 0.87, "rounded to level 3");
  } finally {
    level(oldLevel);
    touch.Touch_AimAssistFrame();
    cvar.Cvar_Set("sv_aim", oldAim);
  }
});

Deno.test("the Touch Controls page's last row is the Aim Assist slider", async () => {
  const cmd = await import("../src/cmd.js");
  const keys = await import("../src/keys.js");
  const menu = await import("../src/menu.js");

  const hadWindow = "window" in globalThis;
  if (!hadWindow) globalThis.window = { devicePixelRatio: 1 };
  const oldLevel = touch.touch_aimassist.string;
  try {
    cmd.Cbuf_Init();
    cmd.Cmd_Init();
    keys.Key_Init();
    menu.M_Init();
    registerCvars();
    cvar.Cvar_Set("touch_aimassist", "2");

    // Options row 14 opens Touch Controls
    cmd.Cmd_ExecuteString("menu_options");
    for (let i = 0; i < 64 && menu.M_AgentState().cursor !== 14; i++) {
      menu.M_Keydown(keys.K_DOWNARROW);
    }
    menu.M_Keydown(keys.K_ENTER);
    assertEqual(menu.m_state, menu.m_touch, "Touch Controls open");

    // Wrap to row 0, then up once to the last row (whatever rows come before)
    for (let i = 0; i < 64 && menu.M_AgentState().cursor !== 0; i++) {
      menu.M_Keydown(keys.K_DOWNARROW);
    }
    menu.M_Keydown(keys.K_UPARROW);

    menu.M_Keydown(keys.K_RIGHTARROW);
    assertEqual(touch.touch_aimassist.value, 3, "right steps up");
    menu.M_Keydown(keys.K_RIGHTARROW);
    menu.M_Keydown(keys.K_RIGHTARROW);
    assertEqual(touch.touch_aimassist.value, 4, "stops at the widest");
    for (let i = 0; i < 6; i++) menu.M_Keydown(keys.K_LEFTARROW);
    assertEqual(touch.touch_aimassist.value, 0, "stops at off");
  } finally {
    cvar.Cvar_Set("touch_aimassist", oldLevel);
    keys.set_key_dest(keys.key_game);
    if (!hadWindow) delete globalThis.window;
  }
});
