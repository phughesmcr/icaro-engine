// Icaro Engine entry point
// Equivalent to WinQuake/sys_win.c WinMain() + main()

import { Sys_Error, Sys_Init, Sys_Printf } from "./src/sys.js";
import { COM_GameDirArgs, COM_InitArgv } from "./src/common.js";
import {
  Host_Frame,
  Host_Init,
  host_maxfps,
  Host_SetConfigDoneCallback,
} from "./src/host.js";
import { Cvar_SetTransient } from "./src/cvar.js";
import { Con_Printf } from "./src/console.js";
import {
  URLCfg_Argv,
  URLCfg_BaseDirs,
  URLCfg_Parse,
} from "./src/url_config.js";
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
import { VID_StartFrameLoop, VID_UncappedInterval } from "./src/vid_vsync.js";
import { Draw_CachePicFromPNG, Draw_GetOverlayCanvas } from "./src/gl_draw.js";
import { XR_Init } from "./src/webxr.js";
import { HostHidden_Init } from "./src/host_hidden.js";
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

    // Every URL parameter is checked in url_config.js; the messages say
    // what it ignored
    const urlParams = new URLSearchParams(window.location.search);
    const urlCfg = URLCfg_Parse(urlParams);
    for (const message of urlCfg.messages) Sys_Printf("%s\n", message);
    // No game data is fetched before a person presses Play on the intro page
    const base = await Intro_Gate(urlParams);
    let withGame = true;
    if (
      base === "librequake" && urlCfg.game !== null && urlCfg.base === null
    ) {
      // the link asked for a pack of id's data, which isn't in this browser
      // (the intro page said so): play LibreQuake without the pack
      withGame = false;
    }
    const { basedir, id1dir, message: baseMessage } = URLCfg_BaseDirs(base);
    if (baseMessage !== null) Sys_Printf("%s\n", baseMessage);

    parms.argv = URLCfg_Argv(urlCfg, withGame);
    parms.argc = parms.argv.length;
    COM_InitArgv(parms.argv);

    // ?cfg.<cvar>= settings, once quake.rc and the saved config have run so
    // the link's values win, and set so they are never saved
    if (urlCfg.cvars.length > 0) {
      Host_SetConfigDoneCallback(() => {
        for (const [name, value] of urlCfg.cvars) {
          Cvar_SetTransient(name, value);
          Con_Printf('Link set %s "%s" (not saved)\n', name, value);
        }
      });
    }

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
    Sys_Printf("Loading pak files...\n");
    const pakCount = await COM_AddPakSequence(
      id1dir + "/pak0.pak",
      setProgress,
    );
    if (pakCount > 0) {
      Sys_Printf(pakCount + " pak file(s) loaded\n");
    } else {
      if (base !== "librequake") {
        Sys_Printf(
          "Warning: id's pak0.pak is not in this browser - add it in " +
            "Options, Game data\n",
        );
      }
    }

    // common.c COM_InitFilesystem: the mission pack's or -game directory
    // after id1, so its progs.dat, gfx.wad and maps are found first. Taken
    // from the arguments, not the flags: -quoth sets the hipnotic flag but
    // mounts only quoth. A directory must have a pak0.pak: HTTP has no
    // directory listing, so without one a mistyped name would quietly play
    // id1 (Ironwail stops on a missing directory too).
    const gameDirs = [];
    for (const dir of COM_GameDirArgs(parms.argv)) {
      if (await COM_AddGameDirectory(basedir + "/" + dir, setProgress) === 0) {
        Sys_Error(
          basedir + "/" + dir + "/pak0.pak not found. The game directory " +
            dir + " needs its pak0.pak there.",
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
      Sys_Printf("Loaded custom menu images\n");
    } catch {
      Sys_Printf("Warning: Could not load custom menu images\n");
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
        Sys_Printf("Auto-joining room: %s\n", roomId);
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
    if (urlCfg.agent !== null) Agent_Attach(urlCfg.agent);
    if (urlCfg.map !== null && roomId === null) {
      Agent_NewGame(urlCfg.map, urlCfg.skill).catch((e) => console.error(e));
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

    // The one place that runs Host_Frame in the browser. VID_StartFrameLoop
    // drives it from renderer.setAnimationLoop (requestAnimationFrame, which
    // Three.js swaps for the XR session's during WebXR) or, with vid_vsync 0,
    // from an uncapped loop (src/vid_vsync.js). While a room's host tab is
    // hidden, src/host_hidden.js runs the same function from a Worker's ticks,
    // so all of them share one clock. timestamp is in ms; returns false when
    // it ran no frame.
    const frame = function (timestamp) {
      const newtime = timestamp / 1000;
      const time = newtime - oldtime;
      // A frame's timestamp can be older than the last hidden tick, and a
      // switch between the vsync loops can hand over one a little older than
      // the last frame. Not false: the uncapped loop carries on.
      if (time < 0) return true;
      oldtime = newtime;

      // In lockstep the agent runs the frames (src/agent.js Agent_Step)
      if (Agent_Lockstep()) return false;

      Host_Frame(time);
      return true;
    };
    HostHidden_Init(frame);
    VID_StartFrameLoop(
      renderer,
      frame,
      () => VID_UncappedInterval(host_maxfps.value, cls.timedemo === true),
    );
  } catch (e) {
    console.error("Icaro Engine Fatal Error:", e);
    Sys_Error(e.message);
  }
}

main();
