// Bring your own data (web-only, no C source). A player's own copy of
// registered Quake (pak1.pak), a mission pack or the 2021 rerelease is copied
// from a file picker into this browser's storage, on this device only, and
// mounted at the next start in place of the URL the game would fetch (see
// COM_SetUserPaks in pak.js). Registered data must never be hosted, so this is
// the only way to play it from the public site, and on a phone, which has no
// static/ folder to copy files into. Saves, configs and demos can be exported
// and imported too, since a phone has no game folder to copy them from.
//
// Storage is the origin private file system (OPFS) where the browser can
// write a file there from the page (FileSystemFileHandle.createWritable), else
// IndexedDB, which keeps a Blob without reading it into memory. Either way a
// pak is read back through Blob.slice. Nothing here touches window, document
// or navigator at import time: the server and the tests import pak.js and
// cl_demo.js, which import this.
//
// LibreQuake, the game's standard content (src/librequake.js), is kept in the
// same store: its files under the URLs ?base=librequake fetches
// (static/librequake/id1/...), mounted only once its manifest is stored.

import {
  COM_AddVirtualFile,
  COM_SetUserFiles,
  COM_SetUserPaks,
} from "./pak.js";
import { Con_Printf } from "./common.js";
import { Cbuf_AddText, Cmd_AddCommand } from "./cmd.js";
import { key_dest, key_menu, Key_WriteBindings } from "./keys.js";
import { Cvar_WriteVariables } from "./cvar.js";
import { CDAudio_SetStoredTracks } from "./cd_audio.js";

// localStorage keys of host_cmd.js (saves) and host.js (config)
const SAVE_STORAGE_PREFIX = "quake_save_";
const CONFIG_STORAGE_KEY = "quake_config";
const SAVEGAME_VERSION = "5"; // host_cmd.js

const OPFS_DIR = "icaro-userdata";
const IDB_NAME = "icaro-userdata";
const IDB_STORE = "files";

// Store keys: a pak's is the URL main.js would fetch it from (lower case), a
// demo's "demos/<name>.dem"
const DEMO_PREFIX = "demos/";

/** Store keys of LibreQuake's files: the URLs ?base=librequake fetches. */
export const UD_LQ_PREFIX = "static/librequake/id1/";
/**
 * Store key of LibreQuake's manifest, written last by src/librequake.js: its
 * files are mounted only when it is there.
 */
export const UD_LQ_MANIFEST = "librequake/manifest.json";
/** Store keys of a LibreQuake download's parts, kept so it can resume. */
export const UD_LQ_PARTS = "librequake/download/";

/**
 * localStorage key of the content a person last picked to play (src/intro.js
 * Intro_Decide): "librequake" or "id1". Set only by a click.
 */
export const UD_CHOICE_KEY = "icaro_content";

/** Remembers the content a person picked; storage refused is no error. */
export function UD_RememberChoice(base) {
  try {
    localStorage.setItem(UD_CHOICE_KEY, base);
  } catch {
    // no localStorage: the intro asks again next time
  }
}

// CD tracks (music/trackNN.ogg or .mp3) among stored loose files
const UD_TRACK_FILE = /\/music\/track\d{2,}\.(ogg|mp3)$/;

/**
 * What a pak is, from the names in its directory (a Set of lower-case names):
 * { dir, label } where dir is the game directory under static/ ("id1" for
 * id1's own, which is static/ itself), or null for a pak this can't place.
 * Every 2021 rerelease pak has a bots/ directory and no original pak does.
 * Order matters: the rogue pak has ctf1.bsp too.
 */
export function UD_ClassifyPak(names) {
  let rerelease = false;
  for (const n of names) {
    if (n.startsWith("bots/")) {
      rerelease = true;
      break;
    }
  }

  const has = (n) => names.has(n);
  if (has("mapdb.json")) {
    return { dir: "rerelease/id1", label: "Quake (2021 rerelease)" };
  }
  if (has("maps/hip1m1.bsp")) {
    return rerelease ?
      { dir: "rerelease/hipnotic", label: "Scourge of Armagon (rerelease)" } :
      { dir: "hipnotic", label: "Scourge of Armagon" };
  }
  if (has("maps/r1m1.bsp")) {
    return rerelease ?
      { dir: "rerelease/rogue", label: "Dissolution of Eternity (rerelease)" } :
      { dir: "rogue", label: "Dissolution of Eternity" };
  }
  if (!rerelease) {
    if (has("maps/e2m1.bsp") && !has("progs.dat")) {
      return { dir: "id1", label: "Quake (registered)" };
    }
    return null;
  }
  if (has("maps/e5m1.bsp")) {
    return { dir: "rerelease/dopa", label: "Dimension of the Past" };
  }
  if (has("mg-dawn.nfo")) {
    return { dir: "rerelease/mg3", label: "Add-on mg3" };
  }
  if (has("maps/horde1.bsp")) {
    return { dir: "rerelease/mg1", label: "Dimension of the Machine" };
  }
  if (has("maps/ctf1.bsp")) {
    return { dir: "rerelease/ctf", label: "Capture the Flag (rerelease)" };
  }
  return null;
}

/** The store key, and so the URL main.js fetches, of a pak in dir. */
export function UD_PakKey(dir) {
  const name = dir === "id1" ? "pak1.pak" : "pak0.pak";
  return "static/" + (dir === "id1" ? "" : dir + "/") + name;
}

/**
 * The names in a pak's directory, read from a Blob without reading the rest,
 * as a Set of lower-case names; null when the Blob is not a pak.
 */
export async function UD_ReadPakNames(blob) {
  if (blob.size < 12) return null;
  const header = new DataView(await blob.slice(0, 12).arrayBuffer());
  if (header.getUint32(0, false) !== 0x5041434B) return null; // "PACK"
  const dirofs = header.getInt32(4, true);
  const dirlen = header.getInt32(8, true);
  if (dirofs < 12 || dirlen < 0 || dirofs + dirlen > blob.size) return null;

  const dir = new Uint8Array(
    await blob.slice(dirofs, dirofs + dirlen).arrayBuffer(),
  );
  const names = new Set();
  for (let i = 0; i + 64 <= dir.length; i += 64) {
    let name = "";
    for (let j = 0; j < 56 && dir[i + j] !== 0; j++) {
      name += String.fromCharCode(dir[i + j]);
    }
    names.add(name.toLowerCase());
  }
  return names;
}

/**
 * The games a set of stored keys can start, each { label, query } with the
 * query string for main.js. A rerelease add-on needs the rerelease's id1.
 * id's own data is ?base=id1, since a launch without ?base plays the content
 * the intro last started (src/intro.js).
 */
export function UD_PlayOptions(keys) {
  const has = (dir) => keys.has(UD_PakKey(dir));
  const out = [];
  if (keys.has(UD_LQ_MANIFEST)) {
    out.push({ label: "LibreQuake", query: "?base=librequake" });
  }
  out.push({
    label: has("id1") ? "Quake (registered)" : "Quake (shareware)",
    query: "?base=id1",
  });
  if (has("hipnotic")) {
    out.push({ label: "Scourge of Armagon", query: "?game=hipnotic" });
  }
  if (has("rogue")) {
    out.push({ label: "Dissolution of Eternity", query: "?game=rogue" });
  }
  if (!has("rerelease/id1")) return out;
  out.push({ label: "Quake (2021 rerelease)", query: "?base=rerelease" });
  const addons = [
    ["hipnotic", "Scourge of Armagon (rerelease)"],
    ["rogue", "Dissolution of Eternity (rerelease)"],
    ["mg1", "Dimension of the Machine"],
    ["mg3", "Add-on mg3"],
    ["dopa", "Dimension of the Past"],
    ["ctf", "Capture the Flag (rerelease)"],
  ];
  for (const [game, label] of addons) {
    if (has("rerelease/" + game)) {
      out.push({ label: label, query: "?base=rerelease&game=" + game });
    }
  }
  return out;
}

/**
 * The slot name a .sav file imports to (its base name), or null when the
 * name can't be a slot or the text isn't a version 5 save.
 */
export function UD_SaveSlot(filename, text) {
  const m = /^([A-Za-z0-9_-]{1,32})\.sav$/i.exec(filename);
  if (m === null) return null;
  const first = text.split("\n", 1)[0].trim();
  if (first !== SAVEGAME_VERSION) return null;
  return m[1];
}

/** A demo's file name, made safe for a playdemo command line. */
export function UD_DemoName(filename) {
  const base = filename.split(/[\\/]/).pop().toLowerCase();
  const safe = base.replace(/[^a-z0-9_.-]/g, "_");
  return safe.endsWith(".dem") ? safe : safe + ".dem";
}

// OPFS store, or null when this browser can't write a file from the page
async function UD_OpenOpfs() {
  const storage = globalThis.navigator?.storage;
  if (typeof storage?.getDirectory !== "function") return null;
  const handle = globalThis.FileSystemFileHandle;
  if (typeof handle?.prototype?.createWritable !== "function") return null;

  const root = await storage.getDirectory();
  const dir = await root.getDirectoryHandle(OPFS_DIR, { create: true });
  const fname = (key) => encodeURIComponent(key);

  return {
    kind: "OPFS",
    list: async () => {
      const out = [];
      for await (const [name, h] of dir.entries()) {
        if (h.kind !== "file") continue;
        const file = await h.getFile();
        out.push({ key: decodeURIComponent(name), size: file.size });
      }
      return out;
    },
    get: async (key) => {
      try {
        return await (await dir.getFileHandle(fname(key))).getFile();
      } catch {
        return null;
      }
    },
    put: async (key, blob) => {
      let existed = true;
      try {
        await dir.getFileHandle(fname(key));
      } catch {
        existed = false;
      }
      const h = await dir.getFileHandle(fname(key), { create: true });
      try {
        // the write lands only when the stream closes, so a failure part
        // way leaves the old file as it was
        await blob.stream().pipeTo(await h.createWritable());
      } catch (e) {
        if (!existed) await dir.removeEntry(fname(key)).catch(() => {});
        throw e;
      }
    },
    remove: (key) => dir.removeEntry(fname(key)).catch(() => {}),
  };
}

function UD_Request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// IndexedDB store, or null without IndexedDB
async function UD_OpenIdb() {
  const idb = globalThis.indexedDB;
  if (idb === undefined || idb === null) return null;
  const open = idb.open(IDB_NAME, 1);
  open.onupgradeneeded = () => open.result.createObjectStore(IDB_STORE);
  const db = await UD_Request(open);
  const store = (mode) =>
    db.transaction(IDB_STORE, mode).objectStore(IDB_STORE);

  return {
    kind: "IndexedDB",
    list: () =>
      new Promise((resolve, reject) => {
        const out = [];
        const req = store("readonly").openCursor();
        req.onsuccess = () => {
          const cursor = req.result;
          if (cursor === null) {
            resolve(out);
            return;
          }
          out.push({ key: String(cursor.key), size: cursor.value.size });
          cursor.continue();
        };
        req.onerror = () => reject(req.error);
      }),
    get: async (key) => (await UD_Request(store("readonly").get(key))) ?? null,
    put: async (key, blob) => {
      await UD_Request(store("readwrite").put(blob, key));
    },
    remove: async (key) => {
      await UD_Request(store("readwrite").delete(key));
    },
  };
}

let ud_store = null; // the open store, once UD_OpenStore has run
let ud_storePromise = null;

/** Opens the store (OPFS, else IndexedDB); resolves to null without one. */
export function UD_OpenStore() {
  if (ud_storePromise === null) {
    ud_storePromise = (async () => {
      for (const open of [UD_OpenOpfs, UD_OpenIdb]) {
        try {
          const store = await open();
          if (store !== null) return store;
        } catch (e) {
          Con_Printf("Game data: %s\n", e.message);
        }
      }
      return null;
    })().then((store) => {
      ud_store = store;
      return store;
    });
  }
  return ud_storePromise;
}

/**
 * Called by main.js before the paks load: hands the stored paks and loose
 * files to pak.js, the stored CD tracks to cd_audio.js, and adds the stored
 * demos as loose files. Never throws: without storage, or with a store it
 * can't read, the game starts with the server's data. store stands in for
 * the browser's in tests.
 */
export async function UD_MountPaks(store = undefined) {
  try {
    if (store === undefined) store = await UD_OpenStore();
    if (store === null) return;
    const items = await store.list();
    // LibreQuake's files count only once all of them are in (the manifest)
    const lq = items.some((i) => i.key === UD_LQ_MANIFEST);
    const paks = new Map();
    const files = new Map();
    const tracks = new Map();
    let own = 0;
    for (const { key } of items) {
      const isLq = key.startsWith(UD_LQ_PREFIX);
      if (isLq && lq === false) continue;
      // the download's parts (librequake/download/) are never mounted
      if (
        key.startsWith("static/") === false &&
        key.startsWith(DEMO_PREFIX) === false
      ) {
        continue;
      }
      const blob = await store.get(key);
      if (blob === null) continue;
      if (key.startsWith(DEMO_PREFIX)) {
        COM_AddVirtualFile(
          key.slice(DEMO_PREFIX.length),
          new Uint8Array(await blob.arrayBuffer()),
        );
      } else if (key.startsWith("static/") && key.endsWith(".pak")) {
        paks.set(key, blob);
        if (isLq === false) own++;
      } else if (UD_TRACK_FILE.test(key)) {
        tracks.set(key, URL.createObjectURL(blob));
      } else if (key.startsWith("static/")) {
        files.set(key, blob);
      }
    }
    COM_SetUserPaks(paks);
    COM_SetUserFiles(files);
    CDAudio_SetStoredTracks(tracks);
    if (own > 0) {
      Con_Printf("%d pak(s) of your own in %s\n", own, store.kind);
    }
    if (lq) Con_Printf("LibreQuake in %s\n", store.kind);
  } catch (e) {
    Con_Printf("Couldn't read your game data: %s\n", e.message);
  }
}

/**
 * Keeps a recorded demo (CL_Stop_f): in the store, for the next start, and as
 * a loose file, so playdemo finds it now. Does nothing without storage.
 */
export function UD_KeepDemo(name, data) {
  if (ud_store === null) return;
  // stored under a name safe to quote (which the panel's Play uses), and
  // found now under the recorded one too
  const demo = UD_DemoName(name);
  COM_AddVirtualFile(name, data);
  COM_AddVirtualFile(demo, data);
  ud_store.put(DEMO_PREFIX + demo, new Blob([data])).catch((e) =>
    Con_Printf("Couldn't keep %s: %s\n", demo, e.message)
  );
}

// Free space the browser will give this origin, or Infinity if it won't say
async function UD_FreeSpace() {
  try {
    const est = await navigator.storage.estimate();
    if (typeof est.quota !== "number") return Infinity;
    return est.quota - (est.usage ?? 0);
  } catch {
    return Infinity;
  }
}

/**
 * Imports files a player picked: paks into the store (by what they hold, not
 * their names, since every mission pack is a pak0.pak), .sav files into the
 * save slots, .cfg files run as console commands, and .dem files kept as
 * demos. Returns one line per file saying what happened, and whether a pak
 * was added (which needs a restart).
 */
export async function UD_Import(files) {
  const store = await UD_OpenStore();
  const lines = [];
  let paks = 0;
  for (const file of files) {
    const lower = file.name.toLowerCase();
    try {
      if (lower.endsWith(".sav")) {
        const text = await file.text();
        const slot = UD_SaveSlot(file.name, text);
        if (slot === null) {
          lines.push(file.name + ": not a Quake save");
          continue;
        }
        localStorage.setItem(SAVE_STORAGE_PREFIX + slot, text);
        lines.push(file.name + ": saved to slot " + slot);
        continue;
      }
      if (lower.endsWith(".cfg")) {
        Cbuf_AddText("\n" + await file.text() + "\n");
        lines.push(file.name + ": run");
        continue;
      }
      if (lower.endsWith(".dem")) {
        const demo = UD_DemoName(file.name);
        const data = new Uint8Array(await file.arrayBuffer());
        COM_AddVirtualFile(demo, data);
        if (store !== null) await store.put(DEMO_PREFIX + demo, file);
        lines.push(file.name + ": demo " + demo);
        continue;
      }

      const names = await UD_ReadPakNames(file);
      if (names === null) {
        lines.push(file.name + ": not a pak, save, config or demo");
        continue;
      }
      const what = UD_ClassifyPak(names);
      if (what === null) {
        lines.push(
          file.name +
            (names.has("maps/e1m1.bsp") ?
              ": id1's pak0.pak, which the game already has" :
              ": a pak this can't place"),
        );
        continue;
      }
      if (store === null) {
        lines.push(file.name + ": this browser has no storage for it");
        continue;
      }
      if (file.size > await UD_FreeSpace()) {
        lines.push(file.name + ": not enough storage space");
        continue;
      }
      await store.put(UD_PakKey(what.dir), file);
      paks++;
      lines.push(file.name + ": " + what.label);
    } catch (e) {
      lines.push(file.name + ": " + e.message);
    }
  }

  if (paks > 0) {
    // the same request host_cmd.js makes after the first save
    navigator.storage?.persist?.().catch(() => {});
  }
  return { lines: lines, paks: paks };
}

/**
 * Hands a file to the player: the share sheet where the browser can share
 * that file (phones), else a download. Returns how.
 */
export async function UD_Export(name, data) {
  const file = new File([data], name, { type: "application/octet-stream" });
  if (navigator.canShare?.({ files: [file] }) === true) {
    try {
      await navigator.share({ files: [file] });
      return "shared";
    } catch (e) {
      if (e.name === "AbortError") return "cancelled";
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return "downloaded";
}

// The panel

const UD_STYLE = `
.ud-panel { position: fixed; inset: 0; z-index: 10000; overflow: auto;
  background: rgba(0, 0, 0, 0.92); color: #ddd; font: 15px/1.4 system-ui,
  sans-serif; padding: max(16px, env(safe-area-inset-top))
  max(16px, env(safe-area-inset-right)) 16px max(16px, env(safe-area-inset-left));
  touch-action: pan-y; -webkit-user-select: text; user-select: text; }
.ud-panel h2 { margin: 0 0 8px; font-size: 20px; color: #fc8; }
.ud-panel h3 { margin: 16px 0 6px; font-size: 16px; color: #fc8; }
.ud-panel p { margin: 6px 0; max-width: 40em; }
.ud-panel button { font: inherit; min-height: 44px; min-width: 44px;
  padding: 6px 14px; margin: 3px 6px 3px 0; color: #fff; background: #533;
  border: 1px solid #a76; border-radius: 6px; }
.ud-row { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px;
  padding: 2px 0; }
.ud-row span { flex: 1 1 12em; }
.ud-status { white-space: pre-wrap; color: #cfc; }
`;

let ud_panel = null;

function UD_El(tag, text, parent) {
  const el = document.createElement(tag);
  if (text !== null) el.textContent = text;
  if (parent !== null) parent.appendChild(el);
  return el;
}

function UD_Button(text, parent, onClick) {
  const b = UD_El("button", text, parent);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

function UD_Size(bytes) {
  if (bytes < 1024 * 1024) return Math.ceil(bytes / 1024) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

// While the panel is open, keys aimed anywhere else (focus falls to <body>
// when a clicked button is rebuilt) go no further than the window: the
// game's handlers are on document. Escape closes the panel from anywhere.
function UD_KeyGuard(e) {
  if (ud_panel === null || ud_panel.contains(e.target)) return;
  e.stopPropagation();
  if (e.type === "keydown" && e.key === "Escape") UD_Close();
}

function UD_Close() {
  if (ud_panel === null) return;
  ud_panel.remove();
  ud_panel = null;
  window.removeEventListener("keydown", UD_KeyGuard, true);
  window.removeEventListener("keyup", UD_KeyGuard, true);
}

// Closes the panel and the menu behind it, for a command that starts play
function UD_CloseAndRun(text) {
  UD_Close();
  if (key_dest === key_menu) Cbuf_AddText("togglemenu\n");
  Cbuf_AddText(text);
}

async function UD_Fill(body, status) {
  body.replaceChildren();
  const store = await UD_OpenStore();
  const items = store !== null ? await store.list() : [];
  items.sort((a, b) => a.key < b.key ? -1 : 1);
  const keys = new Set(items.map((i) => i.key));

  const isLq = (key) =>
    key.startsWith(UD_LQ_PREFIX) || key.startsWith("librequake/");
  const lqItems = items.filter((i) => isLq(i.key));
  if (lqItems.length > 0) {
    UD_El("h3", "LibreQuake", body);
    const row = UD_El("div", null, body);
    row.className = "ud-row";
    const bytes = lqItems.reduce((n, i) => n + i.size, 0);
    UD_El(
      "span",
      (keys.has(UD_LQ_MANIFEST) ? "Installed" : "Part downloaded") + " (" +
        UD_Size(bytes) + ")",
      row,
    );
    UD_Button("Remove", row, async () => {
      // the manifest first, so a removal cut short leaves nothing mounted
      await store.remove(UD_LQ_MANIFEST);
      for (const item of lqItems) await store.remove(item.key);
      status.textContent = "Removed LibreQuake. Restart the game to stop " +
        "using it.";
      UD_Fill(body, status);
    });
  }

  UD_El("h3", "Your paks", body);
  const paks = items.filter((i) =>
    !i.key.startsWith(DEMO_PREFIX) && !isLq(i.key)
  );
  if (store === null) {
    UD_El("p", "This browser has no storage for game data.", body);
  } else if (paks.length === 0) {
    UD_El("p", "None yet.", body);
  }
  for (const item of paks) {
    const row = UD_El("div", null, body);
    row.className = "ud-row";
    UD_El("span", item.key.slice(7) + " (" + UD_Size(item.size) + ")", row);
    UD_Button("Remove", row, async () => {
      await store.remove(item.key);
      status.textContent = "Removed " + item.key.slice(7) +
        ". Restart the game to stop using it.";
      UD_Fill(body, status);
    });
  }

  UD_El("h3", "Play", body);
  UD_El("p", "Restarts the game with these paks.", body);
  const play = UD_El("div", null, body);
  play.className = "ud-row";
  for (const opt of UD_PlayOptions(keys)) {
    UD_Button(opt.label, play, () => {
      // a plain launch plays this from now on (src/intro.js)
      const base = new URLSearchParams(opt.query).get("base");
      if (base === "librequake" || base === "id1") UD_RememberChoice(base);
      // keep the other parameters (lobby, quality...) but the game's own
      const params = new URLSearchParams(location.search);
      params.delete("game");
      params.delete("base");
      for (const [k, v] of new URLSearchParams(opt.query)) params.set(k, v);
      const q = params.toString();
      location.href = location.pathname + (q !== "" ? "?" + q : "");
    });
  }

  UD_El("h3", "Saves", body);
  const saves = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k !== null && k.startsWith(SAVE_STORAGE_PREFIX)) saves.push(k);
    }
  } catch {
    // no localStorage
  }
  saves.sort();
  if (saves.length === 0) UD_El("p", "None yet.", body);
  for (const k of saves) {
    const slot = k.slice(SAVE_STORAGE_PREFIX.length);
    const row = UD_El("div", null, body);
    row.className = "ud-row";
    UD_El("span", slot + ".sav", row);
    UD_Button("Export", row, async () => {
      const text = localStorage.getItem(k);
      if (text === null) return;
      status.textContent = slot + ".sav " +
        await UD_Export(slot + ".sav", text);
    });
  }

  UD_El("h3", "Config", body);
  UD_Button("Export config.cfg", body, async () => {
    // what Host_WriteConfiguration keeps (host.js)
    const text = Key_WriteBindings() + Cvar_WriteVariables();
    try {
      localStorage.setItem(CONFIG_STORAGE_KEY, text);
    } catch {
      // the export still works
    }
    status.textContent = "config.cfg " + await UD_Export("config.cfg", text);
  });

  UD_El("h3", "Demos", body);
  const demos = items.filter((i) => i.key.startsWith(DEMO_PREFIX));
  if (demos.length === 0) {
    UD_El("p", "None yet. Record one with the record command.", body);
  }
  for (const item of demos) {
    const name = item.key.slice(DEMO_PREFIX.length);
    const row = UD_El("div", null, body);
    row.className = "ud-row";
    UD_El("span", name + " (" + UD_Size(item.size) + ")", row);
    UD_Button("Play", row, () => UD_CloseAndRun('playdemo "' + name + '"\n'));
    UD_Button("Export", row, async () => {
      const blob = await store.get(item.key);
      if (blob === null) return;
      status.textContent = name + " " + await UD_Export(name, blob);
    });
    UD_Button("Remove", row, async () => {
      await store.remove(item.key);
      UD_Fill(body, status);
    });
  }

  if (store !== null) {
    try {
      const est = await navigator.storage.estimate();
      UD_El(
        "p",
        "Stored in " + store.kind + ": " + UD_Size(est.usage ?? 0) +
          " used of " +
          UD_Size(est.quota ?? 0) + " available to this site.",
        body,
      );
    } catch {
      // no estimate
    }
  }
}

/** Opens the Game data panel (the menu_gamedata command). */
export function UD_OpenPanel() {
  if (ud_panel !== null || typeof document === "undefined") return;

  if (document.getElementById("ud-style") === null) {
    const style = UD_El("style", UD_STYLE, document.head);
    style.id = "ud-style";
  }

  const panel = UD_El("div", null, document.body);
  panel.className = "ud-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Game data");
  ud_panel = panel;
  window.addEventListener("keydown", UD_KeyGuard, true);
  window.addEventListener("keyup", UD_KeyGuard, true);

  // keep the game's handlers (keys, touch look, pointer lock) out of it
  for (
    const type of [
      "keydown",
      "keyup",
      "mousedown",
      "mouseup",
      "touchstart",
      "touchmove",
      "touchend",
      "wheel",
      "contextmenu",
    ]
  ) {
    panel.addEventListener(type, (e) => {
      e.stopPropagation();
      if (type === "keydown" && e.key === "Escape") UD_Close();
    });
  }

  UD_El("h2", "Game data", panel);
  UD_El(
    "p",
    "Add your own Quake files: pak1.pak from registered Quake, a mission " +
      "pack's pak0.pak, or the 2021 rerelease's paks. They are copied into " +
      "this browser's storage on this device and are never uploaded. " +
      "Saves (.sav), configs (.cfg) and demos (.dem) can be added too.",
    panel,
  );

  // no accept attribute: some phones grey out files whose type they don't know
  const input = UD_El("input", null, panel);
  input.type = "file";
  input.multiple = true;
  input.hidden = true;

  const top = UD_El("div", null, panel);
  top.className = "ud-row";
  const add = UD_Button("Add files…", top, () => input.click());
  UD_Button("Close", top, UD_Close);

  const status = UD_El("div", null, panel);
  status.className = "ud-status";
  status.setAttribute("aria-live", "polite");
  const body = UD_El("div", null, panel);

  input.addEventListener("change", async () => {
    const files = [...input.files];
    input.value = "";
    if (files.length === 0) return;
    add.disabled = true;
    status.textContent = "Copying " + files.length + " file(s)…";
    const result = await UD_Import(files);
    add.disabled = false;
    status.textContent = result.lines.join("\n") +
      (result.paks > 0 ? "\nPick a game under Play to start with them." : "");
    UD_Fill(body, status);
  });

  UD_Fill(body, status);
  add.focus();
}

/** Registers menu_gamedata (main.js, after Host_Init). */
export function UD_Init() {
  Cmd_AddCommand("menu_gamedata", UD_OpenPanel);
  UD_OpenStore();
}
