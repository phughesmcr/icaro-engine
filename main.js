// Icaro Engine entry point
// Equivalent to WinQuake/sys_win.c WinMain() + main()

import { Sys_Error, Sys_Init, Sys_Printf } from "./src/sys.js";
import { COM_InitArgv, hipnotic, rogue } from "./src/common.js";
import { Host_Frame, Host_Init } from "./src/host.js";
import {
  COM_AddGameDirectory,
  COM_AddPakSequence,
  COM_SetLooseFileBasePaths,
} from "./src/pak.js";
import { Cbuf_AddText } from "./src/cmd.js";
import { NET_LobbyJoinURL, NET_LobbyServer } from "./src/net_main.js";
import { ca_connected, cl, cls } from "./src/client.js";
import { sv } from "./src/server.js";
import { camera, scene } from "./src/gl_rmain.js";
import { renderer } from "./src/vid.js";
import { Draw_CachePicFromPNG, Draw_GetOverlayCanvas } from "./src/gl_draw.js";
import { XR_Init } from "./src/webxr.js";
import { UD_Init, UD_MountPaks } from "./src/userdata.js";
import { Intro_Gate } from "./src/intro.js";
import { PWA_InitLaunchQueue } from "./src/pwa_launch.js";
import {
  CDAudio_SetTrackURLProvider,
  CDAudio_TrackURLs,
} from "./src/cd_audio.js";
import {
  Agent_Attach,
  Agent_Attack,
  Agent_Command,
  Agent_Detach,
  Agent_Goto,
  AGENT_HELP,
  Agent_Key,
  Agent_Lockstep,
  Agent_MenuSelect,
  Agent_Mode,
  Agent_NewGame,
  Agent_Observe,
  Agent_RLObserve,
  Agent_RLSpec,
  Agent_RLStep,
  Agent_ScreenRGBA,
  Agent_Screenshot,
  Agent_Step,
  Agent_TurnTo,
} from "./src/agent.js";

// web-only: set up before the game can rewrite the page's URL
PWA_InitLaunchQueue(
  window,
  () => cls.state === ca_connected && cls.demoplayback === false,
);

const parms = {
  basedir: ".",
  argc: 0,
  argv: [],
};

// ?game=rogue or ?game=hipnotic stands in for WinQuake's -rogue and
// -hipnotic: the flag is passed to COM_InitArgv, and static/<game>/pak*.pak
// load after id1's. ?game=mg1 (and the other names in GAME_DIRS) stands in
// for -game mg1: only the directory's paks load. Other values are ignored,
// so the parameter never reaches a fetch path.
const MISSION_PACKS = ["rogue", "hipnotic"];
const GAME_DIRS = ["mg1", "mg3", "dopa", "ctf"]; // the 2021 rerelease's add-ons

// ?base=rerelease stands in for -basedir: the 2021 rerelease's directories,
// static/rerelease/id1 and static/rerelease/<game>. ?base=librequake is
// LibreQuake, kept in the browser's storage under static/librequake/id1
// (src/librequake.js). Without either (?base=id1), id1's paks are
// static/pak*.pak and game directories are static/<game>. The intro page
// (src/intro.js) picks the base when the URL doesn't.
const BASE_DIRS = {
  rerelease: "static/rerelease",
  librequake: "static/librequake",
};

// ?particles=<n> stands in for -particles <n> (r_part.c R_InitParticles
// sizes the particle pool from it). Only whole numbers are passed on. C has
// no maximum, but a URL can come from a shared link, so values above
// PARTICLES_URL_MAX (16 times Ironwail's default) are ignored rather than
// allocated.
const PARTICLES_ARG = /^[0-9]+$/;
const PARTICLES_URL_MAX = 262144;

// ?listen=<n> stands in for -listen <n> (host.c Host_FindMaxClients): this
// tab can host n players (MAX_SCOREBOARD, 16, caps larger values; 0 means 8)
// and starts in deathmatch mode when n > 1, as the C does with the flag.
// ?listen with no value is -listen alone, 8 players. Values that aren't a
// whole number of up to three digits are ignored.
const LISTEN_ARG = /^[0-9]{1,3}$/;

// Web-only agent flags (docs/agent-interface.md): ?agent=lockstep or
// ?agent=realtime attaches window.icaro at startup, and ?map=<name> with
// optional ?skill=<0-3> starts that map instead of the intro demos. The map
// name is checked, so a shared link can't run other commands.
const AGENT_MODES = ["lockstep", "realtime"];
const AGENT_MAP_ARG = /^[A-Za-z0-9_]{1,32}$/;

// window.icaro: the agent API. Always present; it does nothing until called.
function Agent_ExposeAPI() {
  window.icaro = Object.freeze({
    help: () => AGENT_HELP,
    attach: (mode = "lockstep") => Agent_Attach(mode),
    detach: () => Agent_Detach(),
    mode: () => Agent_Mode(),
    new_game: (map = "lq_e1m1", skill = 1) => Agent_NewGame(map, skill),
    step: (action = {}, tics = 1, opts = {}) => Agent_Step(action, tics, opts),
    goto: (target, opts = {}) => Agent_Goto(target, opts),
    turn_to: (target, opts = {}) => Agent_TurnTo(target, opts),
    attack: (target, opts = {}) => Agent_Attack(target, opts),
    observe: (opts = {}) => Agent_Observe(opts),
    rl_spec: (opts = {}) => Agent_RLSpec(opts),
    rl_observe: (opts = {}) => Agent_RLObserve(opts),
    rl_step: (action, tics, opts = {}) => Agent_RLStep(action, tics, opts),
    cmd: (text) => Agent_Command(text),
    key: (name, count = 1) => Agent_Key(name, count),
    menu: (label) => Agent_MenuSelect(label),
    screenshot: (width = 320) =>
      Agent_Screenshot(renderer.domElement, Draw_GetOverlayCanvas(), width),
    screen_rgba: (width = 84, height = 0, overlay = true) =>
      Agent_ScreenRGBA(
        renderer.domElement,
        overlay === true ? Draw_GetOverlayCanvas() : null,
        width,
        height,
      ),
  });
}

async function main() {
  try {
    Sys_Init();

    const urlParams = new URLSearchParams(window.location.search);
    const game = urlParams.get("game");
    let gamedir = null; // -game <dir>
    if (MISSION_PACKS.includes(game)) {
      parms.argv = ["quake", "-" + game];
      parms.argc = parms.argv.length;
    } else if (GAME_DIRS.includes(game)) {
      gamedir = game;
      parms.argv = ["quake", "-game", game];
      parms.argc = parms.argv.length;
    } else if (game !== null) {
      Sys_Printf(
        'Ignoring unknown game "%s" (expected %s)\n',
        game,
        [...MISSION_PACKS, ...GAME_DIRS].join(", "),
      );
    }

    // No game data is fetched before a person presses Play on the intro page
    const base = await Intro_Gate(urlParams);
    if (
      base === "librequake" && game !== null && urlParams.get("base") === null
    ) {
      // the link asked for a pack of id's data, which isn't in this browser
      // (the intro page said so): play LibreQuake without the pack
      parms.argv = [];
      parms.argc = 0;
      gamedir = null;
    }
    let basedir = "static";
    let id1dir = "static";
    if (Object.hasOwn(BASE_DIRS, base)) {
      basedir = BASE_DIRS[base];
      id1dir = basedir + "/id1";
    } else if (base !== null) {
      Sys_Printf(
        'Ignoring unknown base "%s" (expected %s)\n',
        base,
        Object.keys(BASE_DIRS).join(", "),
      );
    }

    const particles = urlParams.get("particles");
    if (
      particles !== null && PARTICLES_ARG.test(particles) &&
      Number(particles) <= PARTICLES_URL_MAX
    ) {
      if (parms.argv.length === 0) parms.argv = ["quake"];
      parms.argv = [...parms.argv, "-particles", particles];
      parms.argc = parms.argv.length;
    } else if (particles !== null) {
      Sys_Printf(
        'Ignoring particles "%s" (expected a whole number up to %d)\n',
        particles,
        PARTICLES_URL_MAX,
      );
    }

    const listen = urlParams.get("listen");
    if (listen === "" || (listen !== null && LISTEN_ARG.test(listen))) {
      if (parms.argv.length === 0) parms.argv = ["quake"];
      parms.argv = listen === "" ?
        [...parms.argv, "-listen"] :
        [...parms.argv, "-listen", listen];
      parms.argc = parms.argv.length;
    } else if (listen !== null) {
      Sys_Printf('Ignoring listen "%s" (expected a player count)\n', listen);
    }

    COM_InitArgv(parms.argv);

    // Loading bar
    const loadingProgress = document.getElementById("loading-progress");
    const loadingOverlay = document.getElementById("loading");

    const setProgress = (value) => {
      if (loadingProgress) {
        loadingProgress.style.width = (value * 100) + "%";
      }
    };

    // The player's own paks (id1's pak0.pak and pak1.pak, mission packs,
    // rerelease), copied into this browser's storage from the Game data
    // panel, load in place of the URL the game would fetch: the site serves
    // no pak of id's (see src/userdata.js)
    await UD_MountPaks();

    // Load id1's pak0.pak, then pak1.pak (registered) and so on if present.
    // LibreQuake (?base=librequake) has no paks, only loose files.
    Sys_Printf("Loading pak files...\\n");
    const pakCount = await COM_AddPakSequence(
      id1dir + "/pak0.pak",
      setProgress,
    );
    if (pakCount > 0) {
      Sys_Printf(pakCount + " pak file(s) loaded\\n");
    } else {
      if (base !== "librequake") {
        Sys_Printf(
          "Warning: id's pak0.pak is not in this browser - add it in " +
            "Options, Game data\\n",
        );
      }
    }

    // common.c COM_InitFilesystem: the mission pack's or -game directory
    // after id1, so its progs.dat, gfx.wad and maps are found first
    const gameDirs = [];
    for (
      const dir of [
        rogue ? "rogue" : null,
        hipnotic ? "hipnotic" : null,
        gamedir,
      ]
    ) {
      if (dir === null) continue;
      if (await COM_AddGameDirectory(basedir + "/" + dir, setProgress) === 0) {
        Sys_Error(
          basedir + "/" + dir + "/pak0.pak not found. -" + dir +
            " needs the pack's pak0.pak there.",
        );
      }
      gameDirs.push(basedir + "/" + dir);
    }

    // Loose files (custom maps) from the game directory, then id1's, then
    // static/ where this port has always kept them
    const looseDirs = [...gameDirs, id1dir];
    if (id1dir !== "static") looseDirs.push("static");
    COM_SetLooseFileBasePaths(looseDirs.map((dir) => dir + "/"));

    // CD tracks play from music/trackNN.ogg or .mp3 (QuakeSpasm/Ironwail
    // BGM_PlayCDtrack), looked up in the game directory first, then in
    // id1's (static/, or static/rerelease/id1)
    const musicDirs = [...gameDirs, id1dir];
    CDAudio_SetTrackURLProvider((track) => CDAudio_TrackURLs(track, musicDirs));

    await Host_Init(parms);
    UD_Init();

    // Remove loading overlay
    if (loadingOverlay) {
      loadingOverlay.remove();
    }

    // Preload custom menu images
    try {
      await Draw_CachePicFromPNG("gfx/mainmenu_ext.lmp", "static/mainmenu.png");
      Sys_Printf("Loaded custom menu images\\n");
    } catch {
      Sys_Printf("Warning: Could not load custom menu images\\n");
    }

    // Check URL parameters for auto-join
    const roomId = urlParams.get("room");

    if (roomId) {
      // ?server= or the default lobby, over WebTransport or WebSocket
      // (see NET_UseWebSocket). NET_LobbyServer checks the lobby and
      // NET_LobbyJoinURL encodes the room id, so a crafted link can't end
      // the quoted argument and run commands.
      const connectUrl = NET_LobbyJoinURL(NET_LobbyServer(), roomId);
      if (connectUrl !== null) {
        Sys_Printf("Auto-joining room: %s\\n", roomId);
        Cbuf_AddText('connect "' + connectUrl + '"\n');
      } else {
        Sys_Printf(
          "Not auto-joining: ?server= is not a valid lobby address (wts://, https://, or ws:// or wss:// with a path)\n",
        );
      }
    }

    // Initialize WebXR (creates rig, offers VR session — must be after Host_Init)
    XR_Init(scene);

    Agent_ExposeAPI();
    const agentMode = urlParams.get("agent");
    if (AGENT_MODES.includes(agentMode)) Agent_Attach(agentMode);
    const agentMap = urlParams.get("map");
    if (agentMap !== null && roomId === null) {
      if (AGENT_MAP_ARG.test(agentMap)) {
        const skillParam = urlParams.get("skill");
        const skillArg = skillParam !== null && /^[0-3]$/.test(skillParam) ?
          Number(skillParam) :
          1;
        Agent_NewGame(agentMap, skillArg).catch((e) => console.error(e));
      } else {
        Sys_Printf(
          'Ignoring map "%s" (expected letters, digits and _)\n',
          agentMap,
        );
      }
    }

    // Expose for debugging
    window.Cbuf_AddText = Cbuf_AddText;
    window.cls = cls;
    window.cl = cl;
    window.sv = sv;
    window.scene = scene;
    Object.defineProperty(window, "camera", { get: () => camera });
    Object.defineProperty(window, "renderer", { get: () => renderer });

    let oldtime = performance.now() / 1000;

    // Use renderer.setAnimationLoop instead of requestAnimationFrame.
    // This is required for WebXR — Three.js automatically switches to
    // xrSession.requestAnimationFrame when a VR session is active.
    // In non-XR mode, behavior is identical to regular rAF.
    renderer.setAnimationLoop(function (timestamp) {
      const newtime = timestamp / 1000;
      const time = newtime - oldtime;
      oldtime = newtime;

      // In lockstep the agent runs the frames (src/agent.js Agent_Step)
      if (Agent_Lockstep()) return;

      Host_Frame(time);
    });
  } catch (e) {
    console.error("Icaro Engine Fatal Error:", e);
    Sys_Error(e.message);
  }
}

main();
