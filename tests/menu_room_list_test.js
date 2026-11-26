// MENU-4 (docs/port-review.md section 14): the Join Game room list keeps
// only the latest reply, survives bad entries, and the Setup menu sends
// `name` only when it changed (menu.c M_Setup_Key).

const cmd = await import("../src/cmd.js");
const common = await import("../src/common.js");
const keys = await import("../src/keys.js");
const menu = await import("../src/menu.js");
const sys = await import("../src/sys.js");

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

// Replace a global for the length of fn, then put it back.
async function withGlobals(globals, fn) {
  const saved = {};
  for (const name of Object.keys(globals)) {
    saved[name] = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, {
      value: globals[name],
      configurable: true,
      writable: true,
    });
  }

  try {
    await fn();
  } finally {
    for (const name of Object.keys(globals)) {
      if (saved[name] !== undefined) {
        Object.defineProperty(globalThis, name, saved[name]);
      } else delete globalThis[name];
    }
  }
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Wait for the menu's await to resume.
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// Commands the menu sends, recorded instead of run.
const executed = { connect: [], name: [], color: [] };

// Text the menu draws this frame: M_Print adds 128 to each character.
let drawn = "";

const queryCalls = [];

function fakeQueryRooms(serverUrl) {
  const d = deferred();
  queryCalls.push({ serverUrl, d });
  return d.promise;
}

const cl_name = { name: "_cl_name", string: "player" };

cmd.Cbuf_Init();
cmd.Cmd_Init();
for (const name of Object.keys(executed)) {
  cmd.Cmd_AddCommand(name, () => {
    const args = [];
    for (let i = 1; i < cmd.Cmd_Argc(); i++) args.push(cmd.Cmd_Argv(i));
    executed[name].push(args);
  });
}

common.COM_Init();
keys.Key_Init();
menu.M_Init();
// The lobby helpers net_main.js injects, as they behave over WebTransport
menu.M_SetExternals({
  NET_QueryRooms: fakeQueryRooms,
  NET_MultiplayerAvailable: () => true,
  NET_LobbyServer: () => sys.Sys_LobbyURL(),
  NET_LobbyJoinURL: (lobby, roomId) => sys.Sys_ConnectURL(lobby, roomId, null),
  cl_name: cl_name,
  key_dest_set: keys.set_key_dest,
  key_dest_get: () => keys.key_dest,
  Draw_CachePic: () => ({ width: 0, height: 0 }),
  Draw_Character: (_x, _y, num) => {
    drawn += String.fromCharCode(num & 127);
  },
  realtime_get: () => 0,
  host_time_get: () => 0,
});

function reset() {
  cmd.Cbuf_Init();
  for (const name of Object.keys(executed)) executed[name].length = 0;
  queryCalls.length = 0;
  drawn = "";
}

function drawMenu() {
  drawn = "";
  menu.M_Draw();
  return drawn;
}

function rooms(...ids) {
  return ids.map((id) => ({
    id: id,
    name: id,
    map: "e1m1",
    playerCount: 0,
    maxPlayers: 4,
  }));
}

const joinGlobals = () => ({
  location: {
    origin: "https://example.test",
    pathname: "/play/",
    search: "?server=wts%3A%2F%2Flobby.example%3A4433",
  },
  history: { replaceState: () => {} },
  WebTransport: class {},
  window: { devicePixelRatio: 1 }, // read by Draw_SetCanvasScale in M_Draw
});

// Press Enter on the room list and return the room id that reached `connect`.
function joinSelected() {
  menu.M_Keydown(keys.K_ENTER);
  cmd.Cbuf_Execute();
  if (executed.connect.length === 0) return null;
  const url = executed.connect[executed.connect.length - 1][0];
  return new URL(url).searchParams.get("room");
}

// Room list: stale replies

Deno.test("an older room list reply that finishes last is dropped", async () => {
  await withGlobals(joinGlobals(), async () => {
    try {
      reset();
      cmd.Cmd_ExecuteString("menu_lanconfig");
      menu.M_Keydown(32); // Space: refresh while the first fetch runs
      assertEqual(queryCalls.length, 2, "two fetches");

      // The newer reply arrives first.
      queryCalls[1].d.resolve(rooms("NEW1"));
      await settle();
      assertEqual(
        drawMenu().includes("Searching"),
        false,
        "newest reply shown",
      );

      // The older one arrives later and must not replace it.
      queryCalls[0].d.resolve(rooms("OLD1", "OLD2"));
      await settle();
      assertEqual(joinSelected(), "NEW1", "joined the newest list");
    } finally {
      keys.set_key_dest(keys.key_game);
    }
  });
});

Deno.test("Searching stays up until the latest reply, and an older error is dropped", async () => {
  await withGlobals(joinGlobals(), async () => {
    try {
      reset();
      cmd.Cmd_ExecuteString("menu_lanconfig");
      menu.M_Keydown(32);

      queryCalls[0].d.reject(new Error("old failure"));
      await settle();
      const text = drawMenu();
      assertEqual(
        text.includes("Searching"),
        true,
        "still searching after the older reply",
      );
      assertEqual(text.includes("old failure"), false, "older error not shown");

      queryCalls[1].d.resolve(rooms("ROOM1"));
      await settle();
      assertEqual(
        drawMenu().includes("Searching"),
        false,
        "searching ends with the latest reply",
      );
      assertEqual(joinSelected(), "ROOM1", "latest list live");
    } finally {
      keys.set_key_dest(keys.key_game);
    }
  });
});

// Room list: cursor and bad entries

Deno.test("a refresh that returns a shorter list clamps the cursor", async () => {
  await withGlobals(joinGlobals(), async () => {
    try {
      reset();
      cmd.Cmd_ExecuteString("menu_lanconfig");
      queryCalls[0].d.resolve(rooms("A1", "A2", "A3"));
      await settle();
      menu.M_Keydown(keys.K_DOWNARROW);
      menu.M_Keydown(keys.K_DOWNARROW); // cursor on A3

      menu.M_Keydown(32);
      queryCalls[1].d.resolve(rooms("B1"));
      await settle();
      drawMenu();
      assertEqual(joinSelected(), "B1", "Enter joins the one room left");
    } finally {
      keys.set_key_dest(keys.key_game);
    }
  });
});

Deno.test("null and malformed room entries are skipped", async () => {
  await withGlobals(joinGlobals(), async () => {
    try {
      reset();
      cmd.Cmd_ExecuteString("menu_lanconfig");
      queryCalls[0].d.resolve([
        null,
        "ROOM",
        { id: "NOMAP", playerCount: 0, maxPlayers: 4 },
        { id: 7, map: "e1m1", playerCount: 0, maxPlayers: 4 },
        { id: "NAN", map: "e1m1", playerCount: "x", maxPlayers: 4 },
        { id: "GOOD", map: "e1m2", playerCount: 1, maxPlayers: 4 },
      ]);
      await settle();

      const text = drawMenu();
      assertEqual(text.includes("e1m2 (1/4)"), true, "valid room drawn");
      assertEqual(text.includes("NOMAP"), false, "room with no map skipped");
      assertEqual(joinSelected(), "GOOD", "cursor on the valid room");
    } finally {
      keys.set_key_dest(keys.key_game);
    }
  });
});

Deno.test("a reply that is not an array is an empty list", async () => {
  await withGlobals(joinGlobals(), async () => {
    try {
      reset();
      cmd.Cmd_ExecuteString("menu_lanconfig");
      queryCalls[0].d.resolve(null);
      await settle();
      assertEqual(drawMenu().includes("No games found"), true, "no games");
      assertEqual(joinSelected(), null, "nothing to join");
    } finally {
      keys.set_key_dest(keys.key_game);
    }
  });
});

// Return state

Deno.test("Join sets the error return, and M_ClearReturnOnError clears it as a connect does", async () => {
  await withGlobals(joinGlobals(), async () => {
    try {
      reset();
      cmd.Cmd_ExecuteString("menu_lanconfig");
      queryCalls[0].d.resolve(rooms("R1"));
      await settle();
      assertEqual(joinSelected(), "R1", "joined");
      assertEqual(menu.M_ShouldReturnOnError(), true, "set on Join");

      menu.M_ClearReturnOnError();
      assertEqual(
        menu.M_ShouldReturnOnError(),
        false,
        "cleared once connected",
      );

      // A later failed console connect falls back to Multiplayer, not the room list.
      menu.M_ConnectionError("Connection refused");
      assertEqual(menu.m_state, menu.m_multiplayer, "multiplayer menu");
    } finally {
      keys.set_key_dest(keys.key_game);
    }
  });
});

// Setup: Accept sends name only when it changed (menu.c:797-798)

Deno.test("Setup Accept sends name only when it changed", () => {
  const saved = cl_name.string;
  try {
    reset();
    cl_name.string = "ranger";
    cmd.Cmd_ExecuteString("menu_setup"); // cursor starts on Accept
    menu.M_Keydown(keys.K_ENTER);
    cmd.Cbuf_Execute();
    assertEqual(executed.name.length, 0, "unchanged name not sent");
    assertEqual(executed.color.length, 0, "unchanged colours not sent");
    assertEqual(menu.m_state, menu.m_multiplayer, "back to multiplayer");

    cmd.Cmd_ExecuteString("menu_setup");
    menu.M_Keydown(keys.K_UPARROW);
    menu.M_Keydown(keys.K_UPARROW);
    menu.M_Keydown(keys.K_UPARROW); // name field
    menu.M_Keydown("s".charCodeAt(0));
    menu.M_Keydown(keys.K_DOWNARROW);
    menu.M_Keydown(keys.K_DOWNARROW);
    menu.M_Keydown(keys.K_DOWNARROW); // Accept
    menu.M_Keydown(keys.K_ENTER);
    cmd.Cbuf_Execute();
    assertEqual(executed.name.length, 1, "changed name sent");
    assertEqual(executed.name[0][0], "rangers", "new name");
  } finally {
    cl_name.string = saved;
    keys.set_key_dest(keys.key_game);
  }
});
