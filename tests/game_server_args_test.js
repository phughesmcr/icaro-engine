// game_server.js command line: -rogue / -hipnotic / -quoth / -game parsing
// and the game directories they add (common.c COM_InitFilesystem).

const {
  configIsRogue,
  createConfig,
  gameArgv,
  parseArgs,
  gameDirectories,
  configError,
  wsTrustConfig,
} = await import("../server/game_server.js");
const common = await import("../src/common.js");

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${
        JSON.stringify(actual)
      }`,
    );
  }
}

// The directories Host_Init_Server mounts for args, after id1
function dirsFor(pakPath, args) {
  return gameDirectories(
    pakPath,
    common.COM_GameDirArgs(gameArgv(parseArgs(args, createConfig()))),
  ).join();
}

Deno.test("parseArgs collects -rogue, -hipnotic and -quoth alongside other flags", () => {
  const config = parseArgs([
    "-port",
    "4500",
    "-rogue",
    "-pak",
    "data/pak0.pak",
    "-hipnotic",
    "-quoth",
    "-map",
    "start",
  ], createConfig());
  assertEqual(
    config.gameFlags.join(),
    "-rogue,-hipnotic,-quoth",
    "game flags in order",
  );
  assertEqual(config.port, 4500, "-port still parsed");
  assertEqual(config.pakPath, "data/pak0.pak", "-pak still parsed");
  assertEqual(config.defaultMap, "start", "-map still parsed");

  assertEqual(
    parseArgs(["-port", "4500"], createConfig()).gameFlags.length,
    0,
    "no game flags by default",
  );
  assertEqual(
    parseArgs(["-game", "rogue", "-ROGUE"], createConfig()).gameFlags.length,
    0,
    "only the exact flags count",
  );
});

Deno.test("parsed game arguments reach COM_InitArgv as in Host_Init_Server", () => {
  const flags = (args) => {
    common.COM_InitArgv(gameArgv(parseArgs(args, createConfig())));
    return [common.rogue, common.hipnotic, common.standard_quake].join();
  };
  try {
    assertEqual(
      flags(["-hipnotic", "-port", "4500"]),
      "false,true,false",
      "hipnotic set",
    );
    assertEqual(
      common.com_argv.join(" "),
      "game_server -hipnotic",
      "-port stays out of com_argv",
    );
    assertEqual(flags(["-quoth"]), "false,true,false", "-quoth is hipnotic");
    assertEqual(
      flags(["-game", "rogue"]),
      "true,false,false",
      "-game rogue sets rogue, as in QuakeSpasm",
    );
    assertEqual(flags(["-game", "mymod"]), "false,false,true", "a mod");
  } finally {
    common.COM_InitArgv([]);
  }
});

Deno.test("gameDirectories resolves the game directories next to the -pak file", () => {
  assertEqual(
    dirsFor("../static/pak0.pak", ["-rogue"]),
    "../static/rogue",
    "rogue",
  );
  assertEqual(
    dirsFor("/srv/quake/id1/pak0.pak", ["-hipnotic"]),
    "/srv/quake/hipnotic",
    "hipnotic beside id1, as in common.c",
  );
  assertEqual(
    dirsFor("data/pak0.pak", ["-hipnotic", "-rogue"]),
    "data/rogue,data/hipnotic",
    "rogue before hipnotic, as in common.c",
  );
  assertEqual(
    dirsFor("data/pak0.pak", ["-quoth"]),
    "data/quoth",
    "-quoth mounts quoth only, as in QuakeSpasm",
  );
  assertEqual(dirsFor("pak0.pak", ["-rogue"]), "./rogue", "bare file name");
  assertEqual(
    dirsFor("C:\\quake\\id1\\pak0.pak", ["-rogue"]),
    "C:\\quake/rogue",
    "Windows separators",
  );
  assertEqual(dirsFor("data/pak0.pak", []), "", "standard Quake adds nothing");
});

Deno.test("-game adds one game directory after the mission packs; the rerelease layout resolves beside id1", () => {
  assertEqual(
    parseArgs(["-game", "mg1"], createConfig()).gameDir,
    "mg1",
    "-game parsed",
  );
  for (const bad of ["../etc", "id1", "librequake", "a.b", ""]) {
    assertEqual(
      parseArgs(["-game", bad], createConfig()).gameDir,
      null,
      "refused: " + bad,
    );
  }
  assertEqual(
    dirsFor("../static/rerelease/id1/pak0.pak", ["-hipnotic", "-game", "mg1"]),
    "../static/rerelease/hipnotic,../static/rerelease/mg1",
    "rerelease dirs",
  );
  assertEqual(
    dirsFor("static/ID1/PAK0.PAK", ["-game", "dopa"]),
    "static/dopa",
    "id1 matched in any case",
  );
  assertEqual(
    dirsFor("../static/pak0.pak", ["-game", "my-mod_2"]),
    "../static/my-mod_2",
    "any safe mod directory",
  );
  assertEqual(
    dirsFor("data/pak0.pak", ["-rogue", "-game", "rogue"]),
    "data/rogue",
    "a mission pack is mounted once",
  );
});

Deno.test("-game rogue widens teamplay to Rogue's modes", () => {
  const config = parseArgs(
    ["-game", "Rogue", "-teamplay", "5"],
    createConfig(),
  );
  assertEqual(configIsRogue(config), true, "-game Rogue is Rogue");
  assertEqual(config.gameOptions.teamplay, 5, "teamplay 5 kept");
  // the lobby passes the game options before -game
  assertEqual(
    parseArgs(["-teamplay", "5", "-game", "rogue"], createConfig()).gameOptions
      .teamplay,
    5,
    "-game rogue after -teamplay",
  );
  assertEqual(
    parseArgs(["-teamplay", "5", "-rogue"], createConfig()).gameOptions
      .teamplay,
    5,
    "-rogue after -teamplay",
  );
  assertEqual(
    parseArgs(["-teamplay", "5"], createConfig()).gameOptions.teamplay,
    2,
    "standard teamplay clamped",
  );
});

Deno.test("parseArgs reads the WebSocket listener flags", () => {
  const defaults = createConfig();
  assertEqual(defaults.wsPort, null, "no WebSocket listener by default");
  assertEqual(defaults.wsHost, "127.0.0.1", "loopback by default");
  assertEqual(defaults.wsTls, false, "plain ws by default");

  const config = parseArgs([
    "-port",
    "4500",
    "-wsport",
    "4501",
    "-wshost",
    "0.0.0.0",
    "-wstls",
  ], createConfig());
  assertEqual(config.wsPort, 4501, "-wsport");
  assertEqual(config.wsHost, "0.0.0.0", "-wshost");
  assertEqual(config.wsTls, true, "-wstls");
  assertEqual(config.port, 4500, "-port still parsed");

  assertEqual(
    parseArgs(["-wsport", "0"], createConfig()).wsPort,
    null,
    "port 0 refused",
  );
  assertEqual(
    parseArgs(["-wsport", "70000"], createConfig()).wsPort,
    null,
    "out of range refused",
  );
  assertEqual(
    parseArgs(["-wsport", "abc"], createConfig()).wsPort,
    null,
    "not a number refused",
  );
});

Deno.test("-nowt starts a WebSocket-only room and needs -wsport", () => {
  const defaults = createConfig();
  assertEqual(
    defaults.noWebTransport,
    false,
    "WebTransport listener on by default",
  );
  assertEqual(configError(defaults), null, "defaults start");
  assertEqual(
    configError(parseArgs(["-wsport", "4501"], createConfig())),
    null,
    "both listeners",
  );

  const config = parseArgs([
    "-nowt",
    "-wsport",
    "8080",
    "-wshost",
    "0.0.0.0",
    "-room",
    "abc",
    "-pak",
    "static/pak0.pak",
  ], createConfig());
  assertEqual(config.noWebTransport, true, "-nowt");
  assertEqual(config.wsPort, 8080, "-wsport");
  assertEqual(config.wsHost, "0.0.0.0", "-wshost");
  assertEqual(configError(config), null, "-nowt with -wsport starts");

  const error = configError(parseArgs(["-nowt"], createConfig()));
  if (error === null || error.includes("-wsport") === false) {
    throw new Error("-nowt alone refused, got " + error);
  }
  assertEqual(
    configError(parseArgs(["-nowt", "-wsport", "0"], createConfig())) !== null,
    true,
    "invalid -wsport is no listener",
  );
});

Deno.test("-trustproxy trusts the forwarded client address from any peer; -room alone keeps loopback-only trust", () => {
  assertEqual(createConfig().trustProxy, false, "off by default");
  assertEqual(
    JSON.stringify(wsTrustConfig(createConfig())),
    JSON.stringify({ trustQueryIp: false, trustAnyPeer: false }),
    "standalone server: header from loopback only",
  );
  assertEqual(
    JSON.stringify(wsTrustConfig(parseArgs(["-room", "abc"], createConfig()))),
    JSON.stringify({ trustQueryIp: true, trustAnyPeer: false }),
    "lobby room: ?ip= from loopback only",
  );
  assertEqual(
    JSON.stringify(wsTrustConfig(parseArgs(["-trustproxy"], createConfig()))),
    JSON.stringify({ trustQueryIp: true, trustAnyPeer: true }),
    "-trustproxy",
  );
  assertEqual(
    JSON.stringify(
      wsTrustConfig(parseArgs(["-room", "abc", "-trustproxy"], createConfig())),
    ),
    JSON.stringify({ trustQueryIp: true, trustAnyPeer: true }),
    "-room -trustproxy",
  );
});

Deno.test("room options are parsed as clamped integers and applied as cvars before the map spawns (MENU-4)", async () => {
  const { Room_ApplyGameOptions: applyGameOptions } = await import(
    "../src/room_rules.js"
  );
  const host = await import("../src/host.js");
  const cvar = await import("../src/cvar.js");
  const names = ["coop", "teamplay", "skill", "fraglimit", "timelimit"];

  const none = parseArgs(["-port", "4500"], createConfig());
  assertEqual(JSON.stringify(none.gameOptions), "{}", "no options by default");

  const config = parseArgs([
    "-coop",
    "1",
    "-teamplay",
    "9",
    "-skill",
    "2",
    "-fraglimit",
    "40",
    "-timelimit",
    "1e9",
    "-map",
    "e1m1",
  ], createConfig());
  assertEqual(
    JSON.stringify(config.gameOptions),
    JSON.stringify({ coop: 1, teamplay: 2, skill: 2, fraglimit: 40 }),
    "clamped; non-integer dropped",
  );
  assertEqual(config.defaultMap, "e1m1", "other args still parsed");
  assertEqual(
    JSON.stringify(
      parseArgs(
        ["-skill", "-3", "-fraglimit", ";quit", "-coop"],
        createConfig(),
      ).gameOptions,
    ),
    "{}",
    "hostile values ignored",
  );
  assertEqual(
    parseArgs(["-rogue", "-teamplay", "9"], createConfig()).gameOptions
      .teamplay,
    6,
    "rogue teamplay modes",
  );

  const savedDeathmatch = [host.deathmatch.value, host.deathmatch.string];
  const saved = names.map((
    n,
  ) => [n, cvar.Cvar_FindVar(n) === null ? null : cvar.Cvar_VariableString(n)]);
  try {
    applyGameOptions({});
    assertEqual(
      host.deathmatch.value,
      savedDeathmatch[0],
      "no options: deathmatch untouched",
    );

    applyGameOptions(config.gameOptions);
    assertEqual(host.coop.value, 1, "coop");
    assertEqual(host.teamplay.value, 2, "teamplay");
    assertEqual(host.skill.value, 2, "skill");
    assertEqual(host.fraglimit.value, 40, "fraglimit");
    assertEqual(host.timelimit.value, 0, "timelimit untouched");
    assertEqual(host.deathmatch.value, 0, "coop clears deathmatch");
  } finally {
    for (const [n, v] of saved) if (v !== null) cvar.Cvar_Set(n, v);
    host.deathmatch.value = savedDeathmatch[0];
    host.deathmatch.string = savedDeathmatch[1];
  }
});

Deno.test("room exit rules reach QuakeC through the cvar list: noexit/samelevel on in deathmatch, off in co-op", async () => {
  const { Room_ApplyExitRules: applyExitRules } = await import(
    "../src/room_rules.js"
  );
  const cvar = await import("../src/cvar.js");
  const names = ["noexit", "samelevel"];

  const saved = names.map((
    n,
  ) => [n, cvar.Cvar_FindVar(n) === null ? null : cvar.Cvar_VariableString(n)]);
  try {
    // PF_cvar reads Cvar_VariableValue, which is 0 for an unregistered cvar
    applyExitRules({});
    assertEqual(
      cvar.Cvar_VariableValue("noexit"),
      1,
      "deathmatch room: noexit",
    );
    assertEqual(
      cvar.Cvar_VariableValue("samelevel"),
      2,
      "deathmatch room: samelevel",
    );

    applyExitRules({ coop: 1 });
    assertEqual(cvar.Cvar_VariableValue("noexit"), 0, "co-op room: noexit");
    assertEqual(
      cvar.Cvar_VariableValue("samelevel"),
      0,
      "co-op room: samelevel",
    );

    applyExitRules({ teamplay: 1 });
    assertEqual(
      cvar.Cvar_VariableValue("noexit"),
      1,
      "deathmatch again: noexit",
    );
    assertEqual(
      cvar.Cvar_VariableValue("samelevel"),
      2,
      "deathmatch again: samelevel",
    );
  } finally {
    // registration can't be undone; an unregistered cvar goes back to its default
    for (const [n, v] of saved) cvar.Cvar_Set(n, v === null ? "0" : v);
  }
});
