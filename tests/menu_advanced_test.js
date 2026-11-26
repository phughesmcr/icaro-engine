// Options > Advanced (web-only): the cvar table's stepping and clamping, and
// the pages driven by keys and taps.

import {
  ADV_WHEN,
  advancedPages,
  M_CvarItem_Format,
  M_CvarItem_Fraction,
  M_CvarItem_FromFraction,
  M_CvarItem_IsChoice,
  M_CvarItem_IsSlider,
  M_CvarItem_Snap,
  M_CvarItem_Step,
  M_CvarWhen_Applies,
} from "../src/menu_cvars.js";

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

const bob = {
  label: "View bob",
  cvar: "cl_bob",
  min: 0,
  max: 0.05,
  step: 0.005,
};
const pitch = {
  label: "Look down limit",
  cvar: "cl_minpitch",
  min: -90,
  max: -45,
  step: 5,
};
const alpha = {
  label: "Lava opacity",
  cvar: "r_lavaalpha",
  min: 0,
  max: 1,
  step: 0.1,
  zero: "water",
};
const kick = {
  label: "Gun kick",
  cvar: "v_gunkick",
  values: [0, 1, 2],
  names: ["off", "on", "smooth"],
};
const clip = {
  label: "Draw distance",
  cvar: "gl_farclip",
  values: [2048, 4096, 8192, 16384],
};
const flag = { label: "Shadows", cvar: "r_shadows" };

Deno.test("advanced menu: sliders snap to the step grid from min and clamp", () => {
  assertEqual(M_CvarItem_Snap(bob, 0.02), 0.02, "on the grid");
  assertEqual(
    M_CvarItem_Snap(bob, 0.013),
    0.015,
    "off the grid snaps to the nearest step",
  );
  assertEqual(M_CvarItem_Snap(bob, 1), 0.05, "above the range");
  assertEqual(M_CvarItem_Snap(bob, -1), 0, "below the range");
  assertEqual(M_CvarItem_Snap(bob, NaN), 0, "NaN");
  assertEqual(M_CvarItem_Snap(pitch, -70), -70, "negative range");
  assertEqual(M_CvarItem_Snap(pitch, -71), -70, "negative range, off the grid");
  assertEqual(M_CvarItem_Snap(pitch, 0), -45, "negative range, above it");
  assertEqual(
    M_CvarItem_Snap(alpha, 0.30000000000000004),
    0.3,
    "float noise dropped",
  );
});

Deno.test("advanced menu: stepping stops sliders at their ends and wraps choices and toggles", () => {
  assertEqual(M_CvarItem_Step(bob, 0.02, 1), 0.025, "slider up");
  assertEqual(M_CvarItem_Step(bob, 0.02, -1), 0.015, "slider down");
  assertEqual(M_CvarItem_Step(bob, 0.05, 1), 0.05, "slider stops at max");
  assertEqual(M_CvarItem_Step(bob, 0, -1), 0, "slider stops at min");
  assertEqual(
    M_CvarItem_Step(bob, 0.0124, -1),
    0.005,
    "off-grid value still moves down",
  );
  assertEqual(
    M_CvarItem_Step(bob, 0.0124, 1),
    0.015,
    "off-grid value still moves up",
  );
  assertEqual(M_CvarItem_Step(pitch, -70, -1), -75, "negative range down");
  assertEqual(
    M_CvarItem_Step(pitch, 10, -1),
    -45,
    "out of range comes back to the nearest end",
  );

  let v = 0.3;
  for (let i = 0; i < 7; i++) v = M_CvarItem_Step(alpha, v, 1);
  assertEqual(v, 1, "repeated 0.1 steps land on 1 exactly");

  assertEqual(M_CvarItem_Step(kick, 2, 1), 0, "choice wraps up");
  assertEqual(M_CvarItem_Step(kick, 0, -1), 2, "choice wraps down");
  assertEqual(M_CvarItem_Step(clip, 4096, 1), 8192, "choice up");
  assertEqual(
    M_CvarItem_Step(clip, 5000, 1),
    8192,
    "off-list value steps from the nearest choice",
  );
  assertEqual(M_CvarItem_Step(flag, 0, 1), 1, "toggle on");
  assertEqual(M_CvarItem_Step(flag, 1, 1), 0, "toggle off");
  assertEqual(M_CvarItem_Step(flag, 2, -1), 0, "any non-zero toggles off");
});

Deno.test("advanced menu: slider fractions and value text", () => {
  assertEqual(M_CvarItem_Fraction(pitch, -90), 0, "left end");
  assertEqual(M_CvarItem_Fraction(pitch, -45), 1, "right end");
  assertEqual(
    M_CvarItem_Fraction(pitch, 50),
    1,
    "out of range draws at the end",
  );
  assertEqual(
    M_CvarItem_FromFraction(pitch, 0.5),
    -65,
    "middle snaps to a step",
  );
  assertEqual(M_CvarItem_FromFraction(bob, 2), 0.05, "fraction clamped");
  assertEqual(M_CvarItem_FromFraction(bob, -1), 0, "fraction clamped below");

  assertEqual(M_CvarItem_Format(bob, 0.005), "0.005", "small step shows");
  assertEqual(M_CvarItem_Format(pitch, -70), "-70", "negative");
  assertEqual(M_CvarItem_Format(alpha, 0), "water", "zero name");
  assertEqual(M_CvarItem_Format(alpha, 0.5), "0.5", "slider number");
  assertEqual(M_CvarItem_Format(kick, 2), "smooth", "choice name");
  assertEqual(
    M_CvarItem_Format(kick, 3),
    "3",
    "a value off the list shows as a number",
  );
  assertEqual(M_CvarItem_Format(clip, 16384), "16384", "choice without names");
  assertEqual(M_CvarItem_Format(flag, 1), "on", "toggle on");
  assertEqual(M_CvarItem_Format(flag, 0), "off", "toggle off");
});

// Every row names a cvar defined in src/ under that console name, and its
// default is a value the row can show and reach: on the slider grid, in the
// choices, or 0/1 for a toggle. This catches typos such as gl_doubleeyes (the
// JS name) for gl_doubleeys (the console name).
Deno.test("advanced menu: every row is a real cvar whose default the row can reach", async () => {
  const defaults = new Map();
  // Either quote and any spacing, so the patterns hold with or without
  // deno fmt's layout. Group 2 is the name and group 4 the default
  const patterns = [
    /name:\s*(['"])([A-Za-z0-9_]+)\1,\s*string:\s*(['"])([^'"]*)\3/g,
    /new cvar_t\(\s*(['"])([A-Za-z0-9_]+)\1,\s*(['"])([^'"]*)\3/g,
  ];
  for await (const entry of Deno.readDir(new URL("../src/", import.meta.url))) {
    if (entry.isFile !== true || entry.name.endsWith(".js") !== true) {
      continue;
    }
    const text = await Deno.readTextFile(
      new URL("../src/" + entry.name, import.meta.url),
    );
    for (const re of patterns) {
      for (const m of text.matchAll(re)) {
        defaults.set(m[2], Number(m[4]));
      }
    }
  }

  const seen = new Set();
  for (const page of advancedPages) {
    // The page list right-aligns titles to x 136, so 17 characters reach 0
    assertEqual(
      page.title.length <= 16,
      true,
      page.title + ": title fits the page list",
    );
    // A misspelt `when` would show the page in every game
    if (page.when !== undefined) {
      assertEqual(
        ADV_WHEN.includes(page.when),
        true,
        page.title + ": when is " + ADV_WHEN.join(" or "),
      );
    }
    // The note is centred on the 40-character line above the rows
    if (page.note !== undefined) {
      assertEqual(
        page.note.length <= 40,
        true,
        page.title + ": note fits the line",
      );
    }

    for (const item of page.items) {
      const name = page.title + " / " + item.label;
      assertEqual(
        defaults.has(item.cvar),
        true,
        name + ": " + item.cvar + " is defined in src/",
      );
      assertEqual(
        seen.has(item.cvar),
        false,
        name + ": " + item.cvar + " is listed once",
      );
      seen.add(item.cvar);
      assertEqual(
        item.label.length <= 15,
        true,
        name + ": label fits left of the cursor",
      );
      if (item.when !== undefined) {
        assertEqual(
          ADV_WHEN.includes(item.when),
          true,
          name + ": when is " + ADV_WHEN.join(" or "),
        );
      }

      const def = defaults.get(item.cvar);
      if (M_CvarItem_IsSlider(item)) {
        assertEqual(
          M_CvarItem_Snap(item, def),
          def,
          name + ": default on the grid",
        );
        assertEqual(
          M_CvarItem_Format(item, def).length <= 6,
          true,
          name + ": value text fits",
        );
      } else if (M_CvarItem_IsChoice(item)) {
        assertEqual(
          item.values.includes(def),
          true,
          name + ": default is a choice",
        );
        for (const v of item.values) {
          assertEqual(
            M_CvarItem_Format(item, v).length <= 6,
            true,
            name + ": value text fits",
          );
        }
      } else {
        assertEqual(
          def === 0 || def === 1,
          true,
          name + ": toggle default is 0 or 1",
        );
      }
    }
  }
});

Deno.test("advanced menu: when hides local rows online and single-player rows in multiplayer", () => {
  for (const remote of [false, true]) {
    for (const multiplayer of [false, true]) {
      const at = ` (remote ${remote}, multiplayer ${multiplayer})`;
      assertEqual(
        M_CvarWhen_Applies(undefined, remote, multiplayer),
        true,
        "no when: always" + at,
      );
      assertEqual(
        M_CvarWhen_Applies("local", remote, multiplayer),
        !remote,
        "local" + at,
      );
      assertEqual(
        M_CvarWhen_Applies("single", remote, multiplayer),
        !multiplayer,
        "single" + at,
      );
    }
  }
});

Deno.test("advanced menu: the Developer and Local game pages are hidden online", () => {
  for (const title of ["Developer", "Local game"]) {
    const page = advancedPages.find((p) => p.title === title);
    assertEqual(page !== undefined, true, title + " page exists");
    assertEqual(page.when, "local", title + " page is local only");
  }
});

Deno.test("advanced menu: Options row, page list, slider taps, wrapping, scrolling and reset", async () => {
  const cmd = await import("../src/cmd.js");
  const keys = await import("../src/keys.js");
  const menu = await import("../src/menu.js");
  const cvar = await import("../src/cvar.js");
  const draw = await import("../src/gl_draw.js");

  // A test page of throwaway cvars, long enough to scroll: a slider, a
  // choice, a toggle and 17 more toggles. One row's cvar is never
  // registered, so the page leaves it out.
  const items = [
    { label: "Slider", cvar: "test_adv_slider", min: -90, max: -45, step: 5 },
    {
      label: "Choice",
      cvar: "test_adv_choice",
      values: [0, 1, 2],
      names: ["a", "b", "c"],
    },
    { label: "Missing", cvar: "test_adv_missing" },
  ];
  for (let i = 0; i < 15; i++) {
    items.push({ label: "Toggle " + i, cvar: "test_adv_toggle" + i });
  }
  const page = { title: "Test", items };

  // menu.js sizes its row buffers from the longest real page at import
  const longest = Math.max(...advancedPages.map((p) => p.items.length));
  assertEqual(
    items.length <= longest,
    true,
    "the test page fits the row buffers",
  );

  const hadWindow = "window" in globalThis;
  if (!hadWindow) globalThis.window = { devicePixelRatio: 1 };
  // The test page stands in for the last page, as the page list is sized
  // from the real pages at import
  const last = advancedPages.length - 1;
  const realLast = advancedPages[last];
  advancedPages[last] = page;
  try {
    cmd.Cbuf_Init();
    cmd.Cmd_Init();
    keys.Key_Init();
    menu.M_Init();
    for (const item of items) {
      if (
        item.cvar !== "test_adv_missing" &&
        cvar.Cvar_FindVar(item.cvar) === null
      ) {
        cvar.Cvar_RegisterVariable({
          name: item.cvar,
          string: item.min !== undefined ? "-70" : "0",
          value: 0,
        });
      }
    }

    cvar.Cvar_Set("test_adv_slider", "-70");
    const value = (name) => cvar.Cvar_FindVar(name).value;

    const w = draw.Draw_GetVirtualWidth();
    const h = draw.Draw_GetVirtualHeight();
    const tap = (vx, vy) =>
      menu.M_TouchInput(vx + (w - 320) / 2, vy + (h - 200) / 2, w, h);
    const row = (r) => 48 + r * 8 + 4;

    // Options row 15 opens the page list; the test page is its last row
    cmd.Cmd_ExecuteString("menu_options");
    tap(100, 32 + 15 * 8 + 4);
    assertEqual(
      menu.m_state,
      menu.m_advanced,
      "Advanced row opens the page list",
    );
    tap(100, row(advancedPages.length - 1));
    assertEqual(menu.m_state, menu.m_advpage, "a page list row opens the page");

    // Slider: the track's ends and middle, then a label tap steps up
    tap(300, row(0));
    assertEqual(value("test_adv_slider"), -45, "right end of the track");
    tap(210, row(0));
    assertEqual(value("test_adv_slider"), -90, "left cap");
    tap(256, row(0));
    assertEqual(value("test_adv_slider"), -65, "middle snaps to a step");
    tap(100, row(0));
    assertEqual(value("test_adv_slider"), -60, "label tap steps up");
    menu.M_Keydown(keys.K_LEFTARROW);
    assertEqual(value("test_adv_slider"), -65, "left arrow steps down");

    // Choice: taps step up and wrap, so every value is reachable by tap
    tap(100, row(1));
    tap(100, row(1));
    assertEqual(value("test_adv_choice"), 2, "two taps step up twice");
    tap(100, row(1));
    assertEqual(value("test_adv_choice"), 0, "a third tap wraps");

    // Row 2 is the first toggle: the unregistered row was left out
    tap(100, row(2));
    assertEqual(value("test_adv_toggle0"), 1, "row 2 is Toggle 0");

    // 2 + 15 toggles + Reset = 18 rows, one more than fit: the "more" row
    // below the list pages down, as far as the last row
    tap(100, 48 + 17 * 8 + 4);
    assertEqual(menu.M_MenuRowAt(100, row(0)), 1, "scrolled down to the end");

    // The last row, Reset defaults, resets the page
    tap(100, row(16));
    assertEqual(value("test_adv_slider"), -70, "Reset restores the slider");
    assertEqual(value("test_adv_choice"), 0, "Reset restores the choice");
    assertEqual(value("test_adv_toggle0"), 0, "Reset restores the toggle");

    // The keyboard cursor wraps and scrolls the list with it
    menu.M_Keydown(keys.K_DOWNARROW);
    assertEqual(
      menu.M_MenuRowAt(100, row(0)),
      0,
      "down from the last row wraps to the top",
    );
    menu.M_Keydown(keys.K_UPARROW);
    assertEqual(
      menu.M_MenuRowAt(100, row(0)),
      1,
      "up from the top wraps and scrolls",
    );

    // The "more" row above the list pages back up
    tap(100, 48 - 4);
    assertEqual(menu.M_MenuRowAt(100, row(0)), 0, "scrolled back up");

    // Escape goes back to the page list, then to Options
    menu.M_Keydown(keys.K_ESCAPE);
    assertEqual(menu.m_state, menu.m_advanced, "back to the page list");
    menu.M_Keydown(keys.K_ESCAPE);
    assertEqual(menu.m_state, menu.m_options, "back to Options");

    // Connected to an online multiplayer server: the Local game page
    // and a 'local' row are left out
    menu.M_SetExternals({
      cls: { state: 2, demonum: -1, demoplayback: false },
      sv: { active: false },
      cl: { maxclients: 4 },
    });
    items.unshift({ label: "Local", cvar: "test_adv_toggle0", when: "local" });
    items.unshift({
      label: "Single",
      cvar: "test_adv_toggle1",
      when: "single",
    });
    tap(100, 32 + 15 * 8 + 4);
    assertEqual(
      menu.m_state,
      menu.m_advanced,
      "Advanced row opens the page list online",
    );
    assertEqual(
      menu.M_MenuRowAt(100, row(last)),
      -1,
      "online, the list is a page shorter",
    );
    // The cursor was on the test page, and stays on it as it moves up
    menu.M_Keydown(keys.K_ENTER);
    assertEqual(
      menu.m_state,
      menu.m_advpage,
      "the cursor followed the test page up a row",
    );
    tap(300, row(0));
    assertEqual(
      value("test_adv_slider"),
      -45,
      "online, row 0 is the slider: the local and single rows are left out",
    );
    assertEqual(value("test_adv_toggle0"), 0, "the local row was not stepped");
    assertEqual(value("test_adv_toggle1"), 0, "the single row was not stepped");

    // The shorter list wraps at its own end
    menu.M_Keydown(keys.K_ESCAPE);
    menu.M_Keydown(keys.K_DOWNARROW);
    menu.M_Keydown(keys.K_UPARROW);
    menu.M_Keydown(keys.K_ENTER);
    tap(210, row(0));
    assertEqual(
      value("test_adv_slider"),
      -90,
      "down wrapped to the first page and up back to the test page",
    );
    menu.M_Keydown(keys.K_ESCAPE);

    // A cursor on Local game when it is hidden moves to the page before
    // it, so one Down reaches the test page
    menu.M_SetExternals({
      cls: { state: 0, demonum: -1, demoplayback: false },
    });
    menu.M_Keydown(keys.K_ESCAPE);
    tap(100, 32 + 15 * 8 + 4);
    menu.M_Keydown(keys.K_UPARROW);
    menu.M_Keydown(keys.K_ESCAPE);
    menu.M_SetExternals({
      cls: { state: 2, demonum: -1, demoplayback: false },
    });
    tap(100, 32 + 15 * 8 + 4);
    menu.M_Keydown(keys.K_DOWNARROW);
    menu.M_Keydown(keys.K_ENTER);
    tap(300, row(0));
    assertEqual(
      value("test_adv_slider"),
      -45,
      "the cursor moved from hidden Local game to Sound",
    );
    menu.M_Keydown(keys.K_ESCAPE);

    // A demo playing isn't online: the title screen lists every page
    menu.M_SetExternals({ cls: { state: 2, demonum: 0, demoplayback: true } });
    menu.M_Keydown(keys.K_ESCAPE);
    tap(100, 32 + 15 * 8 + 4);
    assertEqual(
      menu.M_MenuRowAt(100, row(last)),
      last,
      "during a demo, every page is listed",
    );
  } finally {
    menu.M_SetExternals({
      cls: { state: 0, demonum: -1, demoplayback: false },
      sv: { active: false },
      cl: { intermission: 0, gametype: 0 },
    });
    advancedPages[last] = realLast;
    if (!hadWindow) delete globalThis.window;
  }
});
