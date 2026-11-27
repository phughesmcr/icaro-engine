// Headless single-player host for Deno: the whole engine (Host_Init, a local
// server, and a client signed on over the loopback driver, net_loop.js) with
// no browser, no WebGL and no audio, stepped as fast as the caller likes.
// Web-only: no C counterpart. A dedicated server (game_server.js) has no
// client; this keeps the client and turns only its output off.
//
//   import { headless_init, headless_map, headless_frame } from './server/headless_host.js';
//   await headless_init();                // mounts the repository's data, runs Host_Init
//   await headless_map(GD_MAPS.level);    // resolves once the client has signed on
//   for (let i = 0; i < 720; i++) headless_frame(); // 10 s of game time
//
// The repository's data is set in game_data.js (GD_PAK, GD_MAPS). Other
// game data mounts before Host_Init, as common.c does, so a mission
// pack's gfx.wad is the one loaded:
//
//   await headless_init({ argv: ['-hipnotic'], pak_sequence: true });
//   await headless_init({ base: 'static/rerelease', argv: ['-game', 'mg1'] });
//   await headless_init({ game_dirs: ['/path/to/quoth'] });
//
// Client state is then in src/client.js (cl.time, cl.stats, cl_entities) and
// server state in src/server.js (sv, svs). Commands go in with Cbuf_AddText
// (src/cmd.js) and run on the next frame.
//
// What is turned off, and how:
// - Video: VID_Init gets a fake canvas and the no-op WebGLRenderer from
//   browser_shim.js, and V_RenderView (view refdef plus the 3D pass) is
//   replaced with a no-op through SCR_SetExternals, so r_refdef is not
//   updated. The 2D pass (console, status bar, menus) still runs, into a
//   fake 2D context that ignores every call.
// - Sound: S_Init finds no AudioContext, so sound stays off.
// - Input: the browser listeners go on fake elements and never fire.
// - Storage: localStorage is replaced with an in-memory one, so a run never
//   reads or writes the saved config of another (Deno's localStorage is
//   persistent).
//
// Waiting for a level: the map, changelevel, load and connect commands fetch
// a file that isn't mounted yet with COM_EnsureFile and re-issue themselves
// when the promise resolves (host_cmd.js, cl_parse.js). A file in the mounted
// pak is found at once, so such a map signs on within a few frames, but the
// caller must still yield to the event loop between frames while a level
// loads, or those promises never run. headless_map and headless_wait_signon
// do that (a macrotask between frames) and give up after max_frames.
//
// Console output goes to console.log (Sys_Printf), so stdout is not free for
// a protocol: a stdio server has to redirect console.log.
//
// The process holds one host: Host_Init can't run twice.

import {
  COM_GameDirArgs,
  COM_GameDirIsValid,
  COM_InitArgv,
} from "../src/common.js";
import {
  COM_AddGameDirectory,
  COM_AddPack,
  COM_AddPakSequence,
  COM_FetchPak,
  COM_SetLooseFileBasePaths,
} from "../src/pak.js";
import { Host_Frame, host_framecount, Host_Init } from "../src/host.js";
import { Cbuf_AddText } from "../src/cmd.js";
import { SCR_SetExternals } from "../src/gl_screen.js";
import { cls, SIGNONS } from "../src/client.js";
import { GD_PAK_PATH, GD_PAK_SEQUENCE } from "./game_data.js";

// One host frame at host_maxfps's default of 72. The margin keeps
// _Host_FilterTime's "framerate is too high" test from rejecting a frame
// whose summed realtime came out a rounding error short of 1/72.
export const HEADLESS_FRAMETIME = 1 / 72 + 1e-9;

const STATIC_DIR = decodeURIComponent(
  new URL("../static/", import.meta.url).pathname,
);

let headless_initialized = false;

/** A directory path without its trailing slash */
function _trimSlash(dir) {
  return dir.length > 1 && dir.endsWith("/") ? dir.slice(0, -1) : dir;
}

/**
 * game_server.js gameBaseDirectory: the pak's directory, or its parent when
 * that directory is named id1 (common.c's basedir).
 */
function _gameBaseDirectory(pak) {
  const dir = pak.lastIndexOf("/") >= 0 ?
    pak.slice(0, pak.lastIndexOf("/")) :
    ".";
  const name = dir.slice(dir.lastIndexOf("/") + 1);
  if (name.toLowerCase() !== "id1") return dir;
  return dir.lastIndexOf("/") >= 0 ? dir.slice(0, dir.lastIndexOf("/")) : ".";
}

function noop() {}

const _fakeRect = {
  left: 0,
  top: 0,
  right: 640,
  bottom: 480,
  width: 640,
  height: 480,
  x: 0,
  y: 0,
};

// A 2D canvas context that accepts every call and draws nothing
const _fake2D = new Proxy({}, {
  get(target, prop) {
    if (prop in target) return target[prop];
    if (prop === "measureText") return () => ({ width: 0 });
    if (prop === "getImageData" || prop === "createImageData") {
      return (a, b, w, h) => {
        const width = w !== undefined ? w : a;
        const height = h !== undefined ? h : b;
        return {
          width,
          height,
          data: new Uint8ClampedArray(4 * width * height),
        };
      };
    }
    return noop;
  },
  set(target, prop, value) {
    target[prop] = value;
    return true;
  },
});

function fakeElement(tag) {
  return {
    tagName: String(tag).toUpperCase(),
    style: {},
    dataset: {},
    children: [],
    width: 640,
    height: 480,
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    appendChild: (child) => child,
    removeChild: (child) => child,
    insertBefore: (child) => child,
    remove: noop,
    addEventListener: noop,
    removeEventListener: noop,
    setAttribute: noop,
    getAttribute: () => null,
    getBoundingClientRect: () => _fakeRect,
    getContext: () => _fake2D,
    focus: noop,
    blur: noop,
  };
}

function memoryStorage() {
  const items = new Map();
  return {
    getItem: (key) => items.has(String(key)) ? items.get(String(key)) : null,
    setItem: (key, value) => {
      items.set(String(key), String(value));
    },
    removeItem: (key) => {
      items.delete(String(key));
    },
    clear: () => items.clear(),
    key: (index) => index < items.size ? [...items.keys()][index] : null,
    get length() {
      return items.size;
    },
  };
}

/**
 * Installs the browser globals Host_Init and the frame loop reach for: a
 * window and document with fake elements, and an in-memory localStorage.
 * An existing window or document is kept. localStorage is always replaced,
 * since Deno's own persists to disk.
 */
export function headless_install_globals() {
  Object.defineProperty(globalThis, "localStorage", {
    value: memoryStorage(),
    configurable: true,
    writable: true,
  });

  if (globalThis.document === undefined) {
    globalThis.document = {
      body: fakeElement("body"),
      head: fakeElement("head"),
      documentElement: fakeElement("html"),
      activeElement: null,
      hidden: false,
      visibilityState: "visible",
      createElement: fakeElement,
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: noop,
      removeEventListener: noop,
    };
  }

  if (globalThis.window === undefined) {
    globalThis.window = {
      innerWidth: 640,
      innerHeight: 480,
      devicePixelRatio: 1,
      location: {
        search: "",
        hash: "",
        href: "http://localhost/",
        hostname: "localhost",
        protocol: "http:",
      },
      addEventListener: noop,
      removeEventListener: noop,
      matchMedia: () => ({
        matches: false,
        addEventListener: noop,
        removeEventListener: noop,
      }),
    };
  }
}

/**
 * What headless_init mounts for opts (see there), worked out without
 * touching the file system: { pak, pak_sequence, argv (com_argv, "quake"
 * first), game_dirs (in mount order), loose_dirs (in search order, each
 * ending in '/') }. Throws on a -game name that isn't one path component.
 */
export function headless_search_paths(opts = {}) {
  const base = opts.base !== undefined ? _trimSlash(opts.base) : null;
  const pak = opts.pak !== undefined ?
    opts.pak :
    (base !== null ? base + "/id1/pak0.pak" : GD_PAK_PATH);
  const pak_sequence = opts.pak_sequence !== undefined ?
    opts.pak_sequence :
    (base !== null || (opts.pak === undefined && GD_PAK_SEQUENCE));
  const argv = ["quake", ...(opts.argv !== undefined ? opts.argv : [])];
  const basedir = base !== null ? base : _gameBaseDirectory(pak);

  // common.c COM_InitFilesystem: rogue, hipnotic, quoth, then each -game
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] !== "-game") continue;
    const name = argv[i + 1];
    if (name === undefined || COM_GameDirIsValid(name) === false) {
      throw new Error("headless_init: bad -game directory " + name);
    }
  }
  const gameDirs = COM_GameDirArgs(argv).map((name) => basedir + "/" + name);
  for (const dir of opts.game_dirs !== undefined ? opts.game_dirs : []) {
    gameDirs.push(_trimSlash(dir));
  }

  // Loose files: the game directories (last mounted first), then next to
  // the pak, then static/ when the pak is in another layout
  const loose_dirs = [
    ...gameDirs.toReversed().map((dir) => dir + "/"),
    pak.slice(0, pak.lastIndexOf("/") + 1),
  ];
  if (base !== null) loose_dirs.push(STATIC_DIR);

  return { pak, pak_sequence, argv, game_dirs: gameDirs, loose_dirs };
}

/**
 * Starts the host: mounts the game data, runs Host_Init (quake.rc included,
 * minus its demo loop) and turns the 3D view off. Resolves once the host is
 * ready for commands and frames.
 *
 * opts.pak: path of the pak to mount (default game_data.js's GD_PAK, the
 *   repository's data, or <opts.base>/id1/pak0.pak). Only that file is
 *   mounted, so a local pak1.pak doesn't change what runs, unless
 *   opts.pak_sequence is true (then pak1.pak, pak2.pak... next to it are
 *   mounted too, as the browser does). It defaults to GD_PAK_SEQUENCE for
 *   the default pak.
 * opts.base: a basedir holding id1/ and the game directories, such as
 *   'static/rerelease' (the 2021 rerelease's layout; main.js's ?base=). The
 *   pak then defaults to <base>/id1/pak0.pak, with pak_sequence defaulting to
 *   true. Without it, the basedir is the pak's directory, or its parent when
 *   that directory is named id1 (as game_server.js resolves it).
 * opts.argv: extra command-line arguments (com_argv), e.g. ['-nomonsters'].
 *   As in common.c COM_InitFilesystem, -rogue, -hipnotic, -quoth and each
 *   -game <dir> mount <basedir>/<name>, in that order, after id1 (common.js
 *   COM_GameDirArgs). They also set the mission-pack flags (-quoth and
 *   -game quoth set hipnotic, as in QuakeSpasm).
 * opts.game_dirs: further game directories (paths), mounted after those in
 *   list order, so each is searched before the ones before it.
 *
 * Every game directory needs a pak0.pak (pak1.pak... are mounted too). All
 * of them are mounted before Host_Init, which loads gfx.wad, the palette and
 * quake.rc from the search path. Loose files (maps not in a pak, .lit files)
 * are looked up in the game directories, last mounted first, then next to the
 * id1 pak, then in static/ when opts.base is set (as main.js does).
 */
export async function headless_init(opts = {}) {
  if (headless_initialized === true) {
    throw new Error("headless_init: the host is already running");
  }

  const { pak, pak_sequence, argv, game_dirs, loose_dirs } =
    headless_search_paths(opts);

  headless_initialized = true;

  headless_install_globals();
  COM_InitArgv(argv);

  if (pak_sequence === true) {
    if (await COM_AddPakSequence(pak) === 0) {
      throw new Error("headless_init: could not load " + pak);
    }
  } else {
    const pack = await COM_FetchPak(pak, pak.slice(pak.lastIndexOf("/") + 1));
    if (pack === null) throw new Error("headless_init: could not load " + pak);
    COM_AddPack(pack);
  }
  for (const dir of game_dirs) {
    if (await COM_AddGameDirectory(dir) === 0) {
      throw new Error("headless_init: " + dir + "/pak0.pak not found");
    }
  }

  COM_SetLooseFileBasePaths(loose_dirs);

  await Host_Init({ argv, argc: argv.length, basedir: "" });

  // The 3D view would draw into stubs every frame; skip it
  SCR_SetExternals({ V_RenderView: noop });

  // quake.rc ends in startdemos; as with +map, the demo loop never starts
  cls.demonum = -1;
}

/**
 * Runs one host frame, dt seconds of game time later (default one 1/72 s
 * frame). Returns false when _Host_FilterTime skipped it (dt below
 * 1/host_maxfps); the time still counts toward the next frame.
 */
export function headless_frame(dt = HEADLESS_FRAMETIME) {
  const before = host_framecount;
  Host_Frame(dt);
  return host_framecount !== before;
}

const _nextTask = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Steps frames, yielding to the event loop between them, until the client
 * has all its signon messages (cls.signon === SIGNONS). Use it after a level
 * change the game started (changelevel, a reconnect). Resolves with the
 * number of frames run; rejects after max_frames.
 */
export async function headless_wait_signon(
  max_frames = 1000,
  dt = HEADLESS_FRAMETIME,
) {
  for (let frames = 0; frames < max_frames; frames++) {
    if (cls.signon === SIGNONS) return frames;
    headless_frame(dt);
    await _nextTask();
  }
  if (cls.signon === SIGNONS) return max_frames;
  throw new Error(
    "headless_wait_signon: no signon after " + max_frames + " frames",
  );
}

/**
 * Starts a new game on the named map and resolves, with the number of frames
 * run, once the client has signed on to it. The signon count has to drop
 * first, so a client already in a level doesn't count as ready on the old
 * one while the map file is fetched. That relies on signon taking more than
 * one frame, as it does over loopback (one signon reply per frame). Rejects after max_frames (a missing map,
 * or a Host_Error while spawning, which the frame loop prints and swallows).
 */
export async function headless_map(
  name,
  max_frames = 1000,
  dt = HEADLESS_FRAMETIME,
) {
  if (/["\s;]/.test(name) === true) {
    throw new Error("headless_map: bad map name " + JSON.stringify(name));
  }
  Cbuf_AddText("map " + name + "\n");
  for (let frames = 0; frames < max_frames; frames++) {
    headless_frame(dt);
    await _nextTask();
    if (cls.signon !== SIGNONS) {
      return frames + 1 +
        await headless_wait_signon(max_frames - frames - 1, dt);
    }
  }
  throw new Error(
    "headless_map: " + name + " did not start after " + max_frames + " frames",
  );
}
