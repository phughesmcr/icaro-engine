// Mission-pack support (-rogue / -hipnotic): the flags, the game directory
// search order, the status bar branches and the game options menu lists.

const common = await import("../src/common.js");
const pak = await import("../src/pak.js");
const cmd = await import("../src/cmd.js");
const cvar = await import("../src/cvar.js");
const keys = await import("../src/keys.js");
const sbar = await import("../src/sbar.js");
const scr = await import("../src/gl_screen.js");
const menu = await import("../src/menu.js");
const host = await import("../src/host.js");
const q = await import("../src/quakedef.js");
const sys = await import("../src/sys.js");

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${
        JSON.stringify(actual)
      }`,
    );
  }
}

Deno.test("COM_InitArgv sets rogue, hipnotic and standard_quake from -rogue and -hipnotic", () => {
  try {
    common.COM_InitArgv(["quake", "-rogue"]);
    assertEqual(
      [common.rogue, common.hipnotic, common.standard_quake].join(),
      "true,false,false",
      "-rogue",
    );

    common.COM_InitArgv(["quake", "-hipnotic"]);
    assertEqual(
      [common.rogue, common.hipnotic, common.standard_quake].join(),
      "false,true,false",
      "-hipnotic",
    );

    common.COM_InitArgv(["-rogue"]); // argv[0] is the program name, as in C
    assertEqual(common.standard_quake, true, "argv[0] is not a parameter");

    common.COM_InitArgv([]);
    assertEqual(
      [common.rogue, common.hipnotic, common.standard_quake].join(),
      "false,false,true",
      "reset",
    );
  } finally {
    common.COM_InitArgv([]);
  }
});

Deno.test("-quoth and -game <mission pack> set the flags as in QuakeSpasm", () => {
  const flags = (...args) => {
    common.COM_InitArgv(["quake", ...args]);
    return [common.rogue, common.hipnotic, common.standard_quake].join();
  };
  try {
    assertEqual(flags("-quoth"), "false,true,false", "-quoth is hipnotic");
    assertEqual(flags("-game", "quoth"), "false,true,false", "-game quoth");
    assertEqual(flags("-game", "Rogue"), "true,false,false", "-game Rogue");
    assertEqual(flags("-game", "mymod"), "false,false,true", "a mod");
    assertEqual(flags("-game", "../rogue"), "false,false,true", "a path");
  } finally {
    common.COM_InitArgv([]);
  }
});

Deno.test("COM_GameDirArgs: the directories to mount, in common.c order", () => {
  const dirs = (...args) => common.COM_GameDirArgs(["quake", ...args]).join();
  assertEqual(dirs(), "", "standard Quake");
  assertEqual(dirs("-quoth"), "quoth", "-quoth mounts quoth only");
  assertEqual(
    dirs("-game", "mod", "-hipnotic", "-rogue"),
    "rogue,hipnotic,mod",
    "mission packs first, then -game",
  );
  assertEqual(
    dirs("-rogue", "-game", "ROGUE", "-game", "a", "-game", "A"),
    "rogue,a",
    "a directory is mounted once, whatever its case",
  );
  assertEqual(
    dirs("-game", "../x", "-game", "id1", "-game", "rerelease", "-game"),
    "",
    "unsafe or reserved names are skipped",
  );
  assertEqual(
    common.COM_GameDirArgs(["-rogue"]).join(),
    "",
    "argv[0] is the program name",
  );
});

Deno.test("COM_GameDirIsValid: one safe path component, not id1 or a base", () => {
  for (const ok of ["mg1", "quoth", "My-Mod_2", "_x", "a".repeat(32)]) {
    assertEqual(common.COM_GameDirIsValid(ok), true, ok);
  }
  for (
    const bad of [
      "",
      ".",
      "..",
      "a/b",
      "a\\b",
      "a:b",
      "a.b",
      "-x",
      "a".repeat(33),
      "id1",
      "ID1",
      "rerelease",
      "librequake",
      "music",
      null,
      undefined,
    ]
  ) {
    assertEqual(common.COM_GameDirIsValid(bad), false, String(bad));
  }
});

// A pack with one file (see pak_sequence_test.js)
function makePak(name, text) {
  const body = new TextEncoder().encode(text);
  const dirofs = 12 + body.length;
  const bytes = new Uint8Array(dirofs + 64);
  const view = new DataView(bytes.buffer);
  bytes.set([0x50, 0x41, 0x43, 0x4B], 0); // 'PACK'
  view.setInt32(4, dirofs, true);
  view.setInt32(8, 64, true);
  bytes.set(body, 12);
  bytes.set(new TextEncoder().encode(name), dirofs);
  view.setInt32(dirofs + 56, 12, true);
  view.setInt32(dirofs + 60, body.length, true);
  return bytes;
}

Deno.test("COM_AddGameDirectory: the game directory's paks are searched before id1's", async () => {
  const dir = await Deno.makeTempDir();
  const wasModified = common.com_modified;
  try {
    await Deno.mkdir(dir + "/rogue");
    await Deno.writeFile(dir + "/pak0.pak", makePak("mptest/progs.dat", "id1"));
    await Deno.writeFile(
      dir + "/pak1.pak",
      makePak("mptest/only_id1.txt", "id1 pak1"),
    );
    await Deno.writeFile(
      dir + "/rogue/pak0.pak",
      makePak("mptest/progs.dat", "rogue"),
    );

    assertEqual(await pak.COM_AddPakSequence(dir + "/pak0.pak"), 2, "id1 paks");
    assertEqual(await pak.COM_AddGameDirectory(dir + "/rogue"), 1, "rogue pak");
    assertEqual(
      await pak.COM_AddGameDirectory(dir + "/hipnotic"),
      0,
      "missing game dir adds nothing",
    );

    const text = (name) =>
      new TextDecoder().decode(pak.COM_FindFile(name).data);
    assertEqual(text("mptest/progs.dat"), "rogue", "game dir overrides id1");
    assertEqual(
      text("mptest/only_id1.txt"),
      "id1 pak1",
      "id1 files still found",
    );
  } finally {
    common.COM_SetModified(wasModified); // test paks are not the original pak0
    await Deno.remove(dir, { recursive: true });
  }
});

// Draws the status bar with recording Draw_* stand-ins. Returns the pics
// drawn as "name@x,y" (y relative to the status bar), the characters and the
// fills.
function drawSbar(game, clState) {
  const pics = [];
  const chars = [];
  const fills = [];
  const cl = {
    stats: new Int32Array(32),
    items: 0,
    gametype: 1, // GAME_DEATHMATCH: no centring offset
    scores: [],
    time: 100,
    faceanimtime: 0,
    maxclients: 1,
    levelname: "",
    item_gettime: new Float32Array(32),
    viewentity: 1,
    ...clState,
  };
  cl.stats[q.STAT_HEALTH] = 100;
  for (const [k, v] of Object.entries(clState.statValues || {})) {
    cl.stats[Number(k)] = v;
  }

  const hadWindow = "window" in globalThis;
  if (!hadWindow) globalThis.window = { devicePixelRatio: 1 };
  // an opaque bar: the translucent default draws through the overlay canvas
  const oldAlpha = scr.scr_sbaralpha.value;
  scr.scr_sbaralpha.value = 1;

  try {
    let base = 0;
    sbar.Sbar_SetExternals({
      cl,
      hipnotic: game === "hipnotic",
      rogue: game === "rogue",
      Draw_PicFromWad: (name) => ({ name }),
      Draw_Pic: (x, y, pic) => pics.push(pic.name + "@" + x + "," + (y - base)),
      Draw_Character: (x, y, c) => chars.push([x, y - base, c]),
      Draw_Fill: (x, y, w, h, c) => fills.push([x, y - base, w, h, c]),
    });
    sbar.Sbar_Init();
    sbar.set_sb_lines(48); // status bar and inventory

    // Sbar_DrawPic adds vid.height - SBAR_HEIGHT; measure it once
    sbar.Sbar_SetExternals({
      Draw_Pic: (_x, y) => {
        base = y;
      },
    });
    sbar.Sbar_DrawNum(0, 0, 1, 1, 0);
    sbar.Sbar_SetExternals({
      Draw_Pic: (x, y, pic) => pics.push(pic.name + "@" + x + "," + (y - base)),
    });

    sbar.Sbar_Draw();
  } finally {
    if (!hadWindow) delete globalThis.window;
    scr.scr_sbaralpha.value = oldAlpha;
    sbar.Sbar_SetExternals({ hipnotic: false, rogue: false });
    sbar.set_sb_lines(0);
  }

  return { pics, chars, fills };
}

function assertDrawn(pics, expected, message) {
  for (const p of expected) {
    if (pics.includes(p) === false) {
      throw new Error(`${message}: ${p} not drawn in ${pics.join(" ")}`);
    }
  }
}

function assertNotDrawn(pics, prefix, message) {
  const found = pics.find((p) => p.startsWith(prefix));
  if (found !== undefined) throw new Error(`${message}: ${found} drawn`);
}

Deno.test("Sbar: id1 draws ibar, keys in the inventory and sigils", () => {
  const { pics } = drawSbar(null, {
    items: q.IT_KEY1 | q.IT_SIGIL1 | q.IT_ARMOR2 | q.IT_SHELLS,
  });
  assertDrawn(pics, [
    "ibar@0,-24",
    "sb_key1@192,-16",
    "sb_sigil1@288,-16",
    "sb_armor2@0,0",
    "sb_shells@224,0",
  ], "id1");
});

Deno.test("Sbar: fresh items and sigils are drawn at once while the active weapon is lit", () => {
  // The weapons loop leaves flashon = 1 for the selected shotgun; sbar.c
  // resets it before the items loop, so a key or sigil picked up 0.5 s ago
  // is drawn rather than hidden for its 2 s pickup window.
  const item_gettime = new Float32Array(32);
  item_gettime[17] = 99.5; // IT_KEY1
  item_gettime[28] = 99.5; // IT_SIGIL1
  const { pics } = drawSbar(null, {
    items: q.IT_SHOTGUN | q.IT_KEY1 | q.IT_SIGIL1,
    item_gettime,
    statValues: { [q.STAT_ACTIVEWEAPON]: q.IT_SHOTGUN },
  });
  assertDrawn(pics, [
    "inv2_shotgun@0,-16",
    "sb_key1@192,-16",
    "sb_sigil1@288,-16",
  ], "flashon reset");
});

Deno.test("Sbar: rogue invbar, powered-up weapon, items, armour and ammo icons, no sigils", () => {
  const { pics } = drawSbar("rogue", {
    items: q.RIT_LAVA_NAILS | q.RIT_ARMOR2 | q.RIT_SHIELD,
    statValues: { [q.STAT_ACTIVEWEAPON]: q.RIT_LAVA_NAILGUN },
  });
  assertDrawn(pics, [
    "r_invbar1@0,-24",
    "r_lava@48,-16",
    "r_shield1@288,-16",
    "sb_armor2@0,0",
    "r_ammolava@224,0",
  ], "rogue");
  assertNotDrawn(pics, "ibar@", "rogue has its own invbar");
  assertNotDrawn(pics, "sb_sigil", "rogue reuses the sigil bits");

  const plain =
    drawSbar("rogue", { statValues: { [q.STAT_ACTIVEWEAPON]: q.IT_SHOTGUN } })
      .pics;
  assertDrawn(plain, ["r_invbar2@0,-24"], "rogue with an id1 weapon");
});

Deno.test("Sbar: rogue CTF draws the team border and frags instead of the face", () => {
  const old = host.teamplay.value;
  try {
    host.teamplay.value = 4; // Capture the Flag
    const { pics, chars, fills } = drawSbar("rogue", {
      maxclients: 4,
      scores: [{ name: "p", colors: 0x00, frags: 12 }],
    });
    assertDrawn(pics, ["r_teambord@112,0"], "team border");
    assertNotDrawn(pics, "face", "no face");
    // (the fills above the status bar are Sbar_DrawFrags')
    assertEqual(
      JSON.stringify(fills.filter((f) => f[1] >= 0).map((f) => f.slice(0, 4))),
      JSON.stringify([[113, 3, 22, 9], [113, 12, 22, 9]]),
      "colour swatch",
    );
    // top colour 8 draws the frags with the status bar digit characters
    const frags = chars.filter(([, y]) => y === 3).map((c) => c[2]);
    assertEqual(frags.join(), [18 + 1, 18 + 2].join(), "frags");

    host.teamplay.value = 2;
    assertDrawn(
      drawSbar("rogue", {
        maxclients: 4,
        scores: [{ name: "p", colors: 0, frags: 0 }],
      }).pics,
      ["face1@112,0"],
      "face outside CTF modes",
    );
  } finally {
    host.teamplay.value = old;
  }
});

Deno.test("Sbar: hipnotic keys on the status bar, proximity gun, items", () => {
  const { pics } = drawSbar("hipnotic", {
    items: q.IT_KEY1 | q.IT_KEY2 | q.HIT_PROXIMITY_GUN | q.IT_GRENADE_LAUNCHER |
      q.HIT_LASER_CANNON | (1 << 24),
    statValues: { [q.STAT_ACTIVEWEAPON]: q.HIT_PROXIMITY_GUN },
  });
  assertDrawn(pics, [
    "sb_key1@209,3",
    "sb_key2@209,12", // moved onto the status bar
    "inv2_prox_gren@96,-16", // active proximity gun shares the grenade slot
    "inv_laser@176,-16",
    "sb_wsuit@288,-16", // item bit 24 (sbar.c; quakedef.h's HIT_WETSUIT is bit 25)
  ], "hipnotic");
  assertNotDrawn(pics, "sb_key1@192", "no key in the inventory");

  const prox = drawSbar("hipnotic", { items: q.HIT_PROXIMITY_GUN }).pics;
  assertDrawn(
    prox,
    ["inv_prox@96,-16"],
    "proximity gun without the grenade launcher",
  );
});

cmd.Cbuf_Init();
cmd.Cmd_Init();
keys.Key_Init();
if (cvar.Cvar_FindVar("teamplay") === null) {
  cvar.Cvar_RegisterVariable(host.teamplay);
}

function gameOptionsKeys(...presses) {
  cmd.Cmd_ExecuteString("menu_gameoptions");
  for (const k of presses) menu.M_Keydown(k);
}

Deno.test("game options menu: hipnotic and rogue episode and level lists, rogue teamplay modes", () => {
  // The menu cursor is module state, so this is one test: it starts on row 0
  const oldTeamplay = host.teamplay.value;
  try {
    common.COM_InitArgv(["quake", "-hipnotic"]);
    menu.M_Init();
    assertEqual(menu.M_NumEpisodes(), 6, "hipnotic episodes");
    assertEqual(
      menu.M_StartLevel().name,
      "start",
      "hipnotic starts at Command HQ",
    );
    // cursor to Episode (row 7), one episode on, then one level on
    gameOptionsKeys(
      keys.K_DOWNARROW,
      keys.K_DOWNARROW,
      keys.K_DOWNARROW,
      keys.K_DOWNARROW,
      keys.K_DOWNARROW,
      keys.K_DOWNARROW,
      keys.K_DOWNARROW,
      keys.K_RIGHTARROW,
      keys.K_DOWNARROW,
      keys.K_RIGHTARROW,
    );
    assertEqual(
      menu.M_StartLevel().name,
      "hip1m2",
      "Fortress of the Dead, second level",
    );
    menu.M_Keydown(keys.K_UPARROW);
    menu.M_Keydown(keys.K_LEFTARROW);
    menu.M_Keydown(keys.K_LEFTARROW);
    assertEqual(
      menu.M_StartLevel().name,
      "hipdm1",
      "wraps back to the Deathmatch Arena",
    );

    common.COM_InitArgv(["quake", "-rogue"]);
    menu.M_Init();
    assertEqual(menu.M_NumEpisodes(), 4, "rogue episodes");
    menu.M_Keydown(keys.K_LEFTARROW);
    assertEqual(menu.M_StartLevel().name, "ctf1", "rogue Deathmatch Arena");

    // up to Teamplay (row 3); one step left from Off wraps to the last mode
    cvar.Cvar_SetValue("teamplay", 0);
    for (let i = 0; i < 4; i++) menu.M_Keydown(keys.K_UPARROW);
    menu.M_Keydown(keys.K_LEFTARROW);
    assertEqual(host.teamplay.value, 6, "rogue wraps to Three Team CTF");

    common.COM_InitArgv([]);
    cvar.Cvar_SetValue("teamplay", 0);
    menu.M_Keydown(keys.K_LEFTARROW);
    assertEqual(host.teamplay.value, 2, "id1 wraps to Friendly Fire");
  } finally {
    common.COM_InitArgv([]);
    cvar.Cvar_SetValue("teamplay", oldTeamplay);
    keys.set_key_dest(keys.key_game);
  }
});

Deno.test("Sys_PageURL keeps game=, server= and transport= for share links, adds room= and drops other parameters", () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, "location");
  const setLocation = (search) =>
    Object.defineProperty(globalThis, "location", {
      value: {
        origin: "https://example.test",
        pathname: "/play/",
        search: search,
      },
      configurable: true,
      writable: true,
    });

  try {
    setLocation("?game=rogue&room=OLD1&foo=1");
    assertEqual(
      sys.Sys_PageURL("AB12"),
      "https://example.test/play/?room=AB12&game=rogue",
      "room and game",
    );
    assertEqual(
      sys.Sys_PageURL(null),
      "https://example.test/play/?game=rogue",
      "game only",
    );

    setLocation("?room=OLD1");
    assertEqual(
      sys.Sys_PageURL(null),
      "https://example.test/play/",
      "nothing kept",
    );

    // The lobby and transport choice travel with a share link
    setLocation(
      "?room=OLD1&server=wss%3A%2F%2Fexample.test%2Fmp&transport=ws&foo=1",
    );
    assertEqual(
      sys.Sys_PageURL("AB12"),
      "https://example.test/play/?room=AB12&server=wss%3A%2F%2Fexample.test%2Fmp&transport=ws",
      "server and transport",
    );
  } finally {
    if (saved !== undefined) {
      Object.defineProperty(globalThis, "location", saved);
    } else delete globalThis.location;
  }
});
