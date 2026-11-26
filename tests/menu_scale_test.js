// scr_menuscale: the menu is drawn on its own canvas (Ironwail CANVAS_MENU)
// and the mouse maps through the same scale. SCR_ModalMessage's YES/NO stays
// on the automatic UI scale.

await import("../src/gl_rsurf.js");
globalThis.window = { devicePixelRatio: 1 }; // gl_draw.js sizes the virtual screen from it

const cmd = await import("../src/cmd.js");
const cvar = await import("../src/cvar.js");
const keys = await import("../src/keys.js");
const menu = await import("../src/menu.js");
const draw = await import("../src/gl_draw.js");
const screen = await import("../src/gl_screen.js");

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

cmd.Cbuf_Init();
cmd.Cmd_Init();
keys.Key_Init();
menu.M_Init();
menu.M_SetExternals({
  key_dest_set: keys.set_key_dest,
  key_dest_get: () => keys.key_dest,
});

// gl_draw's default video is 640x480 at devicePixelRatio 1, and the element
// is the same size. The automatic UI scale is 2 (a 320x240 screen);
// scr_menuscale 1 gives a 640x480 menu canvas.
const W = 640;
const H = 480;

function withScale(value, fn) {
  const old = menu.scr_menuscale.string;
  try {
    cvar.Cvar_Set("scr_menuscale", String(value));
    fn();
  } finally {
    cvar.Cvar_Set("scr_menuscale", old);
    keys.set_key_dest(keys.key_game);
  }
}

// Click at an element point in the main menu; returns the menu state
function clickMain(x, y) {
  cmd.Cmd_ExecuteString("menu_main");
  menu.M_MouseButton(x, y, W, H);
  menu.M_Keydown(keys.K_MOUSE1);
  return menu.m_state;
}

Deno.test("scr_menuscale is registered, archived and automatic by default", () => {
  const v = cvar.Cvar_FindVar("scr_menuscale");
  assertEqual(v !== null && v.string, "0", "default 0");
  assertEqual(v.archive, true, "archived");
});

Deno.test("the mouse maps through the menu scale", () => {
  // Element ( 260, 202 ): menu ( 130, 81 ) at scale 2, Options (row 2)
  withScale(
    0,
    () => assertEqual(clickMain(260, 202), menu.m_options, "automatic scale"),
  );

  // The same point is menu ( 100, 62 ) at scale 1, Multiplayer (row 1)
  withScale(
    1,
    () =>
      assertEqual(clickMain(260, 202), menu.m_multiplayer, "scr_menuscale 1"),
  );

  // Clamped to what fits 320x200: min( 640 / 320, 480 / 200 ) = 2
  withScale(
    5,
    () => assertEqual(clickMain(260, 202), menu.m_options, "clamped to 2"),
  );
});

Deno.test("M_Draw restores the automatic scale", () => {
  withScale(1, () => {
    cmd.Cmd_ExecuteString("menu_main");
    menu.M_Draw();
    assertEqual(
      draw.Draw_GetVirtualWidth(),
      320,
      "automatic virtual width after drawing",
    );
  });
});

Deno.test("the modal YES/NO is hit on the automatic scale", () => {
  withScale(1, () => {
    cmd.Cmd_ExecuteString("menu_main");
    keys.Key_BeginModal(() => {});

    try {
      // find YES and NO on the 320x240 screen the dialog is drawn on
      let yes = null;
      let no = null;
      for (let y = 0; y < 240 && (yes === null || no === null); y++) {
        for (let x = 0; x < 320; x++) {
          const c = screen.SCR_ModalYesNoAt(x, y);
          if (c === 1 && yes === null) yes = [x, y];
          if (c === 0 && no === null) no = [x, y];
        }
      }

      if (yes === null || no === null) {
        throw new Error("test setup: no YES/NO hit boxes");
      }

      menu.M_Mousemove(no[0] * 2, no[1] * 2, W, H);
      assertEqual(keys.Key_ModalYes(), false, "NO under the mouse");
      menu.M_Mousemove(yes[0] * 2, yes[1] * 2, W, H);
      assertEqual(keys.Key_ModalYes(), true, "YES under the mouse");
    } finally {
      keys.Key_Event(keys.K_ESCAPE, true);
      keys.Key_Event(keys.K_ESCAPE, false);
    }
  });
});

Deno.test("the menu is drawn on the menu canvas", () => {
  const drawn = [];
  menu.M_SetExternals({
    Draw_CachePic: () => ({ width: 100, height: 20 }),
    Draw_TransPic: (x, y) => drawn.push([x, y]),
    Draw_Pic: () => {},
    Draw_SubPic: () => {},
    Draw_Character: () => {},
  });

  // qplaque is the first pic, at menu ( 16, 4 )
  withScale(0, () => {
    cmd.Cmd_ExecuteString("menu_main");
    drawn.length = 0;
    menu.M_Draw();
    assertEqual(drawn[0].join(","), "16,24", "centred in 320x240");
  });

  withScale(1, () => {
    cmd.Cmd_ExecuteString("menu_main");
    drawn.length = 0;
    menu.M_Draw();
    assertEqual(drawn[0].join(","), "176,144", "centred in 640x480");
  });
});

Deno.test("a touch on the modal YES answers it at any menu scale", () => {
  menu.M_SetExternals({ realtime_get: () => 100 });

  withScale(1, () => {
    cmd.Cmd_ExecuteString("menu_main");
    let answer = null;
    keys.Key_BeginModal((yes) => {
      answer = yes;
    });

    try {
      let yes = null;
      for (let y = 0; y < 240 && yes === null; y++) {
        for (let x = 0; x < 320 && yes === null; x++) {
          if (screen.SCR_ModalYesNoAt(x, y) === 1) yes = [x, y];
        }
      }
      if (yes === null) throw new Error("test setup: no YES hit box");

      menu.M_TouchInput(yes[0] * 2, yes[1] * 2, W, H);
      assertEqual(keys.Key_ModalActive(), false, "answered");
      assertEqual(answer, true, "YES");
    } finally {
      if (keys.Key_ModalActive()) {
        keys.Key_Event(keys.K_ESCAPE, true);
        keys.Key_Event(keys.K_ESCAPE, false);
      }

      menu.M_SetExternals({ realtime_get: () => 0 });
    }
  });
});
