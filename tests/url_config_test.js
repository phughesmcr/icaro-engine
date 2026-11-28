// src/url_config.js: the page's URL parameters, checked against an explicit
// allowlist. ?cfg.<cvar>= sets only allowlisted cvars, parsed into numbers and
// clamped, and never saved. The engine runs headless for the cvar checks
// (server/headless_host.js), so the cvars are the real registered ones.

import { headless_frame, headless_init } from "../server/headless_host.js";
import {
  URLCfg_Argv,
  URLCfg_BaseDirs,
  URLCFG_CVARS,
  URLCfg_LobbyServer,
  URLCfg_MapPathIsSafe,
  URLCFG_MAX_CVARS,
  URLCfg_Parse,
  URLCfg_ParseCvarValue,
  URLCfg_PixelRatio,
  URLCfg_RenderScale,
} from "../src/url_config.js";
import {
  Cvar_FindVar,
  Cvar_RestoreServerChanges,
  Cvar_Set,
  Cvar_SetTransient,
  Cvar_WriteVariables,
} from "../src/cvar.js";
import {
  Cbuf_AddServerText,
  Cbuf_AddText,
  Cbuf_Execute,
  Cbuf_IsEmpty,
} from "../src/cmd.js";
import { Host_SetConfigDoneCallback } from "../src/host.js";

function assert(cond, message) {
  if (cond !== true) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(message + ": got " + a + ", expected " + e);
}

Deno.test("URLCfg_Parse: no parameters means nothing to pass", () => {
  const cfg = URLCfg_Parse("");
  assertEqual(cfg.game, null, "game");
  assertEqual(cfg.base, null, "base");
  assertEqual(cfg.cvars, [], "cvars");
  assertEqual(cfg.messages, [], "messages");
  assertEqual(URLCfg_Argv(cfg), [], "argv");
});

Deno.test("URLCfg_Parse: ?game= mission packs and rerelease add-ons", () => {
  assertEqual(URLCfg_Argv(URLCfg_Parse("?game=rogue")), [
    "quake",
    "-rogue",
  ], "rogue");
  assertEqual(URLCfg_Argv(URLCfg_Parse("?game=hipnotic")), [
    "quake",
    "-hipnotic",
  ], "hipnotic");
  assertEqual(URLCfg_Argv(URLCfg_Parse("?game=quoth")), [
    "quake",
    "-quoth",
  ], "quoth");
  assertEqual(
    URLCfg_Parse("?game=ROGUE").game,
    { dir: "rogue", mission: true },
    "mission packs in any case",
  );
  const mod = URLCfg_Parse("?game=My-Mod_2");
  assertEqual(mod.game, { dir: "My-Mod_2", mission: false }, "any safe mod");
  assertEqual(URLCfg_Argv(mod), ["quake", "-game", "My-Mod_2"], "mod argv");
  const mg1 = URLCfg_Parse("?game=mg1");
  assertEqual(mg1.game, { dir: "mg1", mission: false }, "mg1");
  assertEqual(URLCfg_Argv(mg1), ["quake", "-game", "mg1"], "mg1 argv");
  assertEqual(URLCfg_Argv(mg1, false), [], "game left out");
});

Deno.test("URLCfg_Parse: an unknown or unsafe ?game= is ignored", () => {
  for (
    const bad of [
      "../id1",
      "id1",
      "ID1",
      "rerelease",
      "librequake",
      "a/b",
      "a\\b",
      "a.b",
      ".",
      "..",
      "-x",
      "",
      "rogue;quit",
      "x".repeat(33),
    ]
  ) {
    const cfg = URLCfg_Parse(new URLSearchParams({ game: bad }));
    assertEqual(cfg.game, null, bad);
    assert(cfg.messages.length === 1, bad + ": one message");
    assertEqual(URLCfg_Argv(cfg), [], bad + ": argv");
  }
});

Deno.test("URLCfg_Parse: ?particles= and ?listen=", () => {
  assertEqual(
    URLCfg_Argv(URLCfg_Parse("?game=rogue&particles=4096&listen=4")),
    ["quake", "-rogue", "-particles", "4096", "-listen", "4"],
    "all three",
  );
  assertEqual(URLCfg_Argv(URLCfg_Parse("?listen")), [
    "quake",
    "-listen",
  ], "bare listen");
  assertEqual(URLCfg_Argv(URLCfg_Parse("?listen=")), [
    "quake",
    "-listen",
  ], "empty listen");
  for (const bad of ["?particles=262145", "?particles=-1", "?particles=1e3"]) {
    const cfg = URLCfg_Parse(bad);
    assertEqual(cfg.particles, null, bad);
    assert(cfg.messages.length === 1, bad + ": message");
  }
  for (const bad of ["?listen=1000", "?listen=4;quit", "?listen=x"]) {
    const cfg = URLCfg_Parse(bad);
    assertEqual(cfg.listen, null, bad);
    assert(cfg.messages.length === 1, bad + ": message");
  }
});

Deno.test("URLCfg_Parse: ?agent=, ?map= and ?skill=", () => {
  const cfg = URLCfg_Parse("?agent=lockstep&map=lq_e1m1&skill=3");
  assertEqual(
    [cfg.agent, cfg.map, cfg.skill],
    ["lockstep", "lq_e1m1", 3],
    "ok",
  );
  const bad = URLCfg_Parse("?agent=evil&map=e1m1;quit&skill=9");
  assertEqual([bad.agent, bad.map, bad.skill], [null, null, 1], "bad");
  assertEqual(bad.messages.length, 2, "agent and map messages");
});

Deno.test("URLCfg_PixelRatio and URLCfg_RenderScale", () => {
  const p = (s) => URLCfg_PixelRatio(new URLSearchParams(s));
  const r = (s) => URLCfg_RenderScale(new URLSearchParams(s));
  assertEqual([p(""), p("?dpr=2"), p("?dpr=native"), p("?dpr=9")], [
    null,
    2,
    "native",
    4,
  ], "dpr");
  assertEqual([r(""), r("?scale=0.5"), r("?scale=0.1"), r("?scale=x")], [
    1,
    0.5,
    0.25,
    1,
  ], "scale");
  assertEqual(URLCfg_Parse("?dpr=x&scale=y").messages.length, 2, "messages");
});

Deno.test("URLCfg_BaseDirs", () => {
  assertEqual(URLCfg_BaseDirs(null), {
    basedir: "static",
    id1dir: "static",
    message: null,
  }, "id's data");
  assertEqual(
    URLCfg_BaseDirs("librequake").id1dir,
    "static/librequake/id1",
    "lq",
  );
  assertEqual(URLCfg_BaseDirs("rerelease").basedir, "static/rerelease", "rr");
  const bad = URLCfg_BaseDirs("../x");
  assert(bad.basedir === "static" && bad.message !== null, "unknown base");
  assert(URLCfg_BaseDirs("constructor").message !== null, "prototype name");
});

Deno.test("URLCfg ?cfg.: allowed values are parsed, rebuilt and clamped", () => {
  const cfg = URLCfg_Parse(
    "?cfg.fov=100&cfg.sensitivity=4.5&cfg.r_lerpmove=1&cfg.viewsize=200" +
      "&cfg.m_pitch=-0.022&cfg.volume=.5",
  );
  assertEqual(cfg.cvars, [
    ["fov", "100"],
    ["sensitivity", "4.5"],
    ["r_lerpmove", "1"],
    ["viewsize", "120"],
    ["m_pitch", "-0.022"],
    ["volume", "0.5"],
  ], "cvars");
  assertEqual(cfg.messages.length, 1, "the clamp is reported");
  // ranges come from the Options menu's rows
  assertEqual(URLCfg_ParseCvarValue("fov", "200").value, "130", "menu max");
  assertEqual(URLCfg_ParseCvarValue("host_maxfps", "500").value, "250", "max");
  assertEqual(URLCfg_ParseCvarValue("gl_picmip", "1").value, "1", "choice");
});

Deno.test("URLCfg ?cfg.: a repeated name keeps its last value", () => {
  const cfg = URLCfg_Parse("?cfg.fov=90&cfg.volume=1&cfg.fov=110");
  assertEqual(cfg.cvars, [["volume", "1"], ["fov", "110"]], "last wins");
});

Deno.test("URLCfg ?cfg.: unsafe and unknown names are refused", () => {
  const names = [
    "alias",
    "bind",
    "exec",
    "connect",
    "quit",
    "cmd",
    "say",
    "developer",
    "sv_cheats",
    "sv_gravity",
    "host_timescale",
    "host_framerate",
    "pausable",
    "deathmatch",
    "skill",
    "name",
    "_cl_name",
    "cl_shownet",
    "registered",
    "cmdline",
    "net_messagetimeout",
    "scr_ofsx",
    "vid_quality",
    "rcon_password",
    "FOV",
    "",
    "__proto__",
    "constructor",
    "toString",
    "hasOwnProperty",
  ];
  for (const name of names) {
    const cfg = URLCfg_Parse(new URLSearchParams([["cfg." + name, "1"]]));
    assertEqual(cfg.cvars, [], name);
    assertEqual(cfg.messages.length, 1, name + ": message");
  }
});

Deno.test("URLCfg ?cfg.: values that aren't plain numbers are refused", () => {
  const values = [
    "",
    " ",
    "100;quit",
    ";quit",
    "100\nquit",
    '100"',
    "\\",
    "0x10",
    "1e2",
    "Infinity",
    "NaN",
    "+5",
    "1,5",
    "5 ",
    "١٠٠", // Arabic-Indic digits
    "9".repeat(65),
  ];
  for (const value of values) {
    const cfg = URLCfg_Parse(new URLSearchParams([["cfg.fov", value]]));
    assertEqual(cfg.cvars, [], JSON.stringify(value));
    assertEqual(cfg.messages.length, 1, JSON.stringify(value) + ": message");
  }
  assert(URLCfg_ParseCvarValue("viewsize", "100.5").error !== undefined, "int");
  assert(URLCfg_ParseCvarValue("r_lerpmove", "2").error !== undefined, "bool");
  assert(URLCfg_ParseCvarValue("r_lerpmove", "on").error !== undefined, "on");
});

Deno.test("URLCfg ?cfg.: at most URLCFG_MAX_CVARS are read", () => {
  const params = new URLSearchParams();
  for (let i = 0; i < URLCFG_MAX_CVARS + 10; i++) {
    params.append("cfg.fov", "90");
  }
  params.append("cfg.volume", "1");
  const cfg = URLCfg_Parse(params);
  assertEqual(cfg.cvars, [["fov", "90"]], "the rest are ignored");
  assertEqual(cfg.messages.length, 1, "one message for the rest");
});

Deno.test("URLCfg ?cfg.: other parameters are not cvars", () => {
  const cfg = URLCfg_Parse("?fov=100&cfgfov=100&cfg=fov:100&bind.q=%2Bjump");
  assertEqual(cfg.cvars, [], "only cfg.<name>");
});

Deno.test("URLCFG_CVARS entries are well formed", () => {
  for (const name of Object.keys(URLCFG_CVARS)) {
    const spec = URLCFG_CVARS[name];
    assert(["float", "int", "bool"].includes(spec.type), name + ": type");
    if (spec.type !== "bool") {
      assert(
        Number.isFinite(spec.min) && Number.isFinite(spec.max) &&
          spec.min <= spec.max,
        name + ": range",
      );
    }
  }
});

// The engine, for the checks against real cvars
await headless_init();
// the startup configs queued by Host_Init run first (they hold a wait)
for (let i = 0; i < 10 && !Cbuf_IsEmpty(); i++) headless_frame();

Deno.test("every URLCFG_CVARS name is a registered client cvar", () => {
  const missing = [];
  for (const name of Object.keys(URLCFG_CVARS)) {
    const v = Cvar_FindVar(name);
    // in_web.js, touch.js and webxr.js register theirs only in a browser
    if (v === null) {
      if (/^(joy_|gp_|xr_|in_rawmouse$|m_filter$)/.test(name)) continue;
      missing.push(name);
      continue;
    }
    assert(v.server !== true, name + " is a server cvar");
  }
  assertEqual(missing, [], "unregistered cvars");
});

Deno.test("Cvar_SetTransient: the URL's value is used but never saved", () => {
  // viewsize is archived: both save paths apply
  const viewsize = Cvar_FindVar("viewsize");
  const before = viewsize.string;
  const key = "quake_cvar_viewsize";
  const storedBefore = localStorage.getItem(key);
  try {
    Cvar_Set("viewsize", "95");
    Cvar_SetTransient("viewsize", "120");
    assertEqual([viewsize.string, viewsize.value], ["120", 120], "live value");
    assertEqual(localStorage.getItem(key), "95", "per-cvar storage untouched");
    assert(Cvar_WriteVariables().includes('viewsize "95"'), "config keeps 95");

    // a second URL value still saves the player's
    Cvar_SetTransient("viewsize", "110");
    assert(Cvar_WriteVariables().includes('viewsize "95"'), "still 95");

    // a remote server's change on top: the server's value is used, the
    // player's is still the one saved, and a disconnect puts the URL's back
    // (progs_dump's cutscenes stuff sizedown: viewsize 110 to 100)
    Cbuf_AddServerText("sizedown\n");
    Cbuf_Execute();
    assertEqual(viewsize.value, 100, "server value");
    assert(Cvar_WriteVariables().includes('viewsize "95"'), "95 under server");
    Cvar_RestoreServerChanges();
    assertEqual(viewsize.string, "110", "URL value after disconnect");
    assert(Cvar_WriteVariables().includes('viewsize "95"'), "95 after it");

    // the player's own change is saved as usual
    Cvar_Set("viewsize", "100");
    assertEqual(localStorage.getItem(key), "100", "player's change stored");
    assert(Cvar_WriteVariables().includes('viewsize "100"'), "config has 100");
  } finally {
    Cvar_Set("viewsize", before);
    if (storedBefore === null) localStorage.removeItem(key);
    else localStorage.setItem(key, storedBefore);
  }
});

Deno.test("Host_SetConfigDoneCallback runs once the command buffer drains", () => {
  assert(Cbuf_IsEmpty(), "startup configs ran");
  let calls = 0;
  Cbuf_AddText("wait\necho url_config_test\n");
  Host_SetConfigDoneCallback(() => calls++);
  headless_frame(); // stops at the wait
  assertEqual(calls, 0, "not while text waits");
  headless_frame();
  assertEqual(calls, 1, "once drained");
  headless_frame();
  assertEqual(calls, 1, "only once");
});

Deno.test("URLCfg_LobbyServer: public lobbies need a DNS name and TLS", () => {
  const cases = [
    // [?server=, expected]
    ["wss://quake.example.com/mp/lobby", "wss://quake.example.com/mp/lobby"],
    [
      "wss://icaro-lobby.acct.workers.dev",
      "wss://icaro-lobby.acct.workers.dev",
    ],
    ["https://mp.example:4433", "https://mp.example:4433"],
    ["wts://lobby.example:4433", "https://lobby.example:4433"],
    ["lobby.example", "https://lobby.example"],
    ["wss://xn--bcher-kva.example/mp", "wss://xn--bcher-kva.example/mp"],
    // Plain ws:// and IP literals only on this machine or a LAN
    ["ws://127.0.0.1:4433", "ws://127.0.0.1:4433"],
    ["ws://localhost:4433/mp", "ws://localhost:4433/mp"],
    ["ws://game.localhost:4433", "ws://game.localhost:4433"],
    ["ws://192.168.1.20:4433/mp", "ws://192.168.1.20:4433/mp"],
    ["ws://10.0.0.5:4433", "ws://10.0.0.5:4433"],
    ["ws://172.20.0.5:4433", "ws://172.20.0.5:4433"],
    ["ws://[::1]:4433", "ws://[::1]:4433"],
    ["https://localhost:4433", "https://localhost:4433"],
    ["ws://quake.example.com/mp", null],
    ["wss://203.0.113.7/mp", null],
    ["https://203.0.113.7:4433", null],
    ["ws://172.32.0.5:4433", null],
    ["wss://[2001:db8::1]/mp", null],
    ["wss://intranet/mp", null],
    ["wss://bad_host.example/mp", null],
    ["wss://-bad.example/mp", null],
    ["wss://bad-.example/mp", null],
    ["wss://example.123/mp", null],
    // Sys_ParseLobbyURL's own refusals still hold
    ["wss://a.example/mp%22;bind%20w%20quit;%22", null],
    ["wss://user:pw@a.example/mp", null],
    ["javascript:alert(1)", null],
    ["https://a.example/path", null],
    ["", null],
  ];
  for (const [raw, expected] of cases) {
    const got = URLCfg_LobbyServer(raw);
    if (got !== expected) {
      throw new Error(`${raw}: expected ${expected}, got ${got}`);
    }
  }
});

Deno.test("URLCfg_MapPathIsSafe: only plain maps/*.bsp paths", () => {
  for (
    const name of [
      "maps/e1m1.bsp",
      "maps/start.bsp",
      "maps/ad_e1m1.bsp",
      "maps/jam9-author.bsp",
      "maps/E1M1.BSP",
      "maps/dm/arena.bsp",
      "maps/lq.e1m1.bsp",
    ]
  ) {
    if (URLCfg_MapPathIsSafe(name) !== true) throw new Error(name);
  }
  for (
    const name of [
      "maps/../pak0.pak",
      "maps/../../etc/passwd.bsp",
      "maps/..bsp",
      "maps/./e1m1.bsp",
      "maps//e1m1.bsp",
      "maps/e1m1..bsp",
      "/maps/e1m1.bsp",
      "maps\\..\\e1m1.bsp",
      "maps/e1m1.bsp?x=1",
      "maps/e1m1.bsp#x",
      "maps/c:e1m1.bsp",
      "maps/e1 m1.bsp",
      "maps/%2e%2e/e1m1.bsp",
      "https://evil.example/maps/e1m1.bsp",
      "progs/player.mdl",
      "maps/e1m1",
      "maps/.bsp",
      "maps/" + "a".repeat(60) + ".bsp",
      "",
      null,
      undefined,
    ]
  ) {
    if (URLCfg_MapPathIsSafe(name) !== false) {
      throw new Error("accepted " + JSON.stringify(name));
    }
  }
});
