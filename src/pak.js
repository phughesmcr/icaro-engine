// PAK file loader -- new module for browser-based asset loading
// Quake stores all game data in pak0.pak (and optionally pak1.pak)
// PAK format: 4-byte magic "PACK", 4-byte directory offset, 4-byte directory length
// Directory entries: 56-byte filename + 4-byte offset + 4-byte length

import { Sys_Error, Sys_Printf } from "./sys.js";
import { COM_SetModified, Con_Printf } from "./common.js";
import { CRC_Init, CRC_ProcessByte } from "./crc.js";

const MAX_FILES_IN_PACK = 2048;

// the shareware/registered id1 pak0.pak (common.c)
const PAK0_COUNT = 339;
const PAK0_CRC = 32981;

class packfile_t {
  constructor() {
    this.name = "";
    this.filepos = 0;
    this.filelen = 0;
    this.data = null; // Uint8Array, once fetched from a lazily opened pack
  }
}

class pack_t {
  constructor() {
    this.filename = "";
    this.files = []; // array of packfile_t
    this.data = null; // ArrayBuffer of the entire pak, or null when lazy
    this.reader = null; // pak_reader_t of a lazily opened pak (see COM_FetchPak)
  }
}

// Search paths
const com_searchpaths = []; // array of { pack, path, path_id }

// QuakeSpasm searchpath_t path_id: one per game directory, larger for the
// directories searched first. Mod_LoadLighting compares a .lit's with its map's.
let com_last_path_id = 0;

// Loaded packs
const loadedPacks = [];

// Virtual files (for loose files not in pak)
const virtualFiles = new Map();

// Entries of lazily opened paks already reported missing by COM_FindFile
const warnedUnfetched = new Set();

// COM_EnsureFile's Range fetches in flight, by packfile_t
const pendingFetches = new Map();

// Base path for on-demand loose file fetching
// Browser: 'static/' (relative URLs like 'static/maps/foo.bsp')
// Deno: '/opt/icaro-engine/static/' (absolute filesystem path)
// (several with COM_SetLooseFileBasePaths: game directory first)
let looseFileBasePaths = ["static/"];

/**
 * Takes an ArrayBuffer of the .pak file contents
 * Returns a pack_t or null
 */
export function COM_LoadPackFile(filename, buffer) {
  if (!isPack(new Uint8Array(buffer))) {
    Sys_Error(filename + " is not a packfile");
    return null;
  }

  const view = new DataView(buffer);
  const dirofs = view.getInt32(4, true);
  const dirlen = view.getInt32(8, true);

  const pack = COM_LoadPackDirectory(
    filename,
    new Uint8Array(buffer, dirofs, dirlen),
  );
  pack.data = buffer;
  return pack;
}

/**
 * The directory half of common.c COM_LoadPackFile: builds a pack_t from the
 * directory's bytes alone, so a lazily opened pak (see COM_FetchPak) never
 * needs the rest of the file in memory. The caller sets pack.data or
 * pack.reader.
 */
function COM_LoadPackDirectory(filename, dir) {
  const dirlen = dir.byteLength;
  const view = new DataView(dir.buffer, dir.byteOffset, dirlen);

  const numpackfiles = Math.floor(dirlen / 64); // each dir entry is 64 bytes

  if (numpackfiles > MAX_FILES_IN_PACK) {
    Sys_Error(filename + " has too many files (" + numpackfiles + ")");
  }

  if (numpackfiles !== PAK0_COUNT) {
    COM_SetModified(true); // not the original file
  }

  // crc the directory to check for modifications
  let crc = CRC_Init();
  for (let i = 0; i < dirlen; i++) {
    crc = CRC_ProcessByte(crc, dir[i]);
  }
  if (crc !== PAK0_CRC) {
    COM_SetModified(true);
  }

  const pack = new pack_t();
  pack.filename = filename;

  for (let i = 0; i < numpackfiles; i++) {
    const entryOffset = i * 64;
    const file = new packfile_t();

    // Read filename (56 bytes, null terminated)
    let name = "";
    for (let j = 0; j < 56; j++) {
      const c = dir[entryOffset + j];
      if (c === 0) break;
      name += String.fromCharCode(c);
    }

    file.name = name.toLowerCase();
    file.filepos = view.getInt32(entryOffset + 56, true);
    file.filelen = view.getInt32(entryOffset + 60, true);

    pack.files.push(file);
  }

  Con_Printf("Added packfile " + filename + " (" + numpackfiles + " files)\\n");

  loadedPacks.push(pack);

  return pack;
}

/**
 * Adds pak0.pak, pak1.pak... from dir (a URL or path, without a trailing
 * slash), searched before everything added so far, as common.c does for
 * <basedir>/rogue or hipnotic. Loose files in dir are looked up only if the
 * caller also passes dir to COM_SetLooseFileBasePaths. Returns the number of paks added.
 */
export function COM_AddGameDirectory(dir, onProgress) {
  return COM_AddPakSequence(dir + "/pak0.pak", onProgress);
}

/**
 * Adds a loaded pack to the search path. Paks of one game directory share a
 * path_id (COM_AddPakSequence passes it); a pack added on its own gets a new one.
 */
export function COM_AddPack(pack, path_id = ++com_last_path_id) {
  com_searchpaths.unshift({ pack: pack, path: null, path_id: path_id });
}

/**
 * Searches through the path looking for a file.
 * Returns { data: Uint8Array, size: number, path_id: number } or null. path_id
 * is the QuakeSpasm one (see com_last_path_id); loose files, which are searched
 * after every pak, have 0.
 *
 * Deliberately not ported: common.c refuses loose files whose name has a
 * '/' or '\\' when !static_registered ("don't ever go beyond base"). This
 * port ships the shareware pak0.pak with its deathmatch maps as loose
 * static/maps/*.bsp files, so that check would refuse every one of them.
 */
export function COM_FindFile(filename) {
  const search = filename.toLowerCase();

  // Search through loaded packs (reverse order - last added has priority)
  const found = COM_FindPackFile(search);
  if (found !== null) {
    const pack = found.pack;
    const file = found.file;

    if (pack.data !== null) {
      const data = new Uint8Array(pack.data, file.filepos, file.filelen);
      return { data: data, size: file.filelen, path_id: found.path_id };
    }

    if (file.data !== null) {
      return { data: file.data, size: file.filelen, path_id: found.path_id };
    }

    // Deno reads a lazily opened pak synchronously from disk, once: the
    // map commands look a map up before loading it
    if (pack.reader.readSync !== null) {
      file.data = pack.reader.readSync(file.filepos, file.filelen);
      return { data: file.data, size: file.filelen, path_id: found.path_id };
    }

    // Browser: the entry is in the directory but not fetched yet. Stop
    // here rather than fall through to a lower-priority copy; the map
    // commands and the world model fetch it with COM_EnsureFile.
    if (
      !COM_PakEntryIsDeferred(file.name, file.filelen) &&
      !warnedUnfetched.has(search)
    ) {
      warnedUnfetched.add(search);
      Con_Printf(
        "Warning: %s is in %s but was not fetched\n",
        search,
        pack.filename,
      );
    }

    return null;
  }

  // Check virtual files (preloaded loose files)
  if (virtualFiles.has(search)) {
    const data = virtualFiles.get(search);
    return { data: data, size: data.length, path_id: 0 };
  }

  return null;
}

/**
 * Ironwail common.c: is filename in the search path, and in which game
 * directory? Returns its path_id, or -1. Unlike COM_FindFile it counts a
 * lazily opened pak's entries that are not fetched yet, and it does not look
 * for loose files on the server.
 */
export function COM_FileExists(filename) {
  const search = filename.toLowerCase();
  const found = COM_FindPackFile(search);
  if (found !== null) {
    return found.path_id;
  }
  return virtualFiles.has(search) ? 0 : -1;
}

// Not in id's common.c. The first entry named search (lower case) in the
// search path, as { pack, file, path_id }, or null.
function COM_FindPackFile(search) {
  for (let i = 0; i < com_searchpaths.length; i++) {
    const pack = com_searchpaths[i].pack;
    if (pack === null) continue;

    for (let j = 0; j < pack.files.length; j++) {
      if (pack.files[j].name === search) {
        return {
          pack: pack,
          file: pack.files[j],
          path_id: com_searchpaths[i].path_id,
        };
      }
    }
  }

  return null;
}

/**
 * Not in id's common.c. Returns the sorted, unique base names (no directory, no
 * extension) of the files directly in dir ('maps', or '' for the root) with the
 * given extension, from the loaded packs and the preloaded loose files. Files
 * of minsize bytes or fewer are skipped. Console tab completion uses it like
 * Ironwail's ExtraMaps_Init (maps over 32k, so not id's b_*.bsp item models;
 * LibreQuake's are up to 42k, so the size rule lists them) and DemoList_Init.
 */
export function COM_ListFiles(dir, ext, minsize) {
  const prefix = dir.length > 0 ? dir.toLowerCase() + "/" : "";
  const suffix = "." + ext.toLowerCase();
  const names = new Set();

  const add = (name, size) => {
    if (size <= minsize) return;
    if (!name.startsWith(prefix) || !name.endsWith(suffix)) return;
    const base = name.substring(prefix.length, name.length - suffix.length);
    if (base.length === 0 || base.includes("/")) return; // no subdirectories
    names.add(base);
  };

  for (let i = 0; i < com_searchpaths.length; i++) {
    const pack = com_searchpaths[i].pack;
    if (!pack) continue;
    for (let j = 0; j < pack.files.length; j++) {
      add(pack.files[j].name, pack.files[j].filelen);
    }
  }

  for (const [name, data] of virtualFiles) {
    add(name, data.length);
  }

  return [...names].sort();
}

/**
 * Sets the base path for on-demand loose file fetching.
 * Browser: 'static/' (default, uses relative URLs like 'static/maps/foo.bsp')
 * Deno: '/opt/icaro-engine/static/' (absolute filesystem path)
 */
export function COM_SetLooseFileBasePath(basePath) {
  looseFileBasePaths = [basePath];
}

/**
 * Like COM_SetLooseFileBasePath, for several directories searched in order,
 * as common.c COM_FindFile searches each game directory's loose files: the
 * game directory (e.g. 'static/rerelease/mg1/') before id1's. Each path ends
 * in '/'.
 */
export function COM_SetLooseFileBasePaths(basePaths) {
  looseFileBasePaths = basePaths.slice();
}

/**
 * Checks if a file is available in pak or virtualFiles.
 * If not, attempts to fetch it on demand and cache it.
 * Returns a Promise<boolean>.
 *
 * For maps/<name>.bsp it also fetches maps/<name>.lit (see COM_EnsureLitFile),
 * without changing the result.
 */
export async function COM_EnsureFile(filename) {
  // The .lit fetch runs alongside the map's. Its failure is ignored (see
  // COM_EnsureLitFile), and the handler is attached now so that it cannot be
  // an unhandled rejection if the map's own load throws first.
  const lit = COM_EnsureLitFile(filename).catch(() => {});
  const found = await COM_EnsureOneFile(filename);
  await lit;
  return found;
}

/**
 * Not in id's common.c. Mod_LoadLighting (Ironwail) reads maps/<name>.lit
 * synchronously when it loads maps/<name>.bsp, and lazily opened paks defer
 * .lit entries, so fetch it along with the map. A .lit is looked for loose only
 * when the map itself is not in a pak, so maps in paks cost no extra request.
 * Failures are ignored: the map then loads with its mono lighting.
 */
async function COM_EnsureLitFile(filename) {
  const search = filename.toLowerCase();
  if (!search.startsWith("maps/") || !search.endsWith(".bsp")) {
    return;
  }

  const litname = search.slice(0, -4) + ".lit";
  const found = COM_FindPackFile(litname);
  if (found === null && COM_FindPackFile(search) !== null) {
    return;
  }

  // Deno reads it from disk when Mod_LoadLighting asks, if it asks (not on
  // a dedicated server)
  if (
    found !== null && found.pack.reader != null &&
    found.pack.reader.readSync !== null
  ) {
    return;
  }

  await COM_EnsureOneFile(litname);
}

/** COM_EnsureFile for one file */
async function COM_EnsureOneFile(filename) {
  // Already available in pak or virtualFiles?
  if (COM_FindFile(filename) !== null) {
    return true;
  }

  // In a lazily opened pak but not fetched yet: fetch just that entry
  const found = COM_FindPackFile(filename.toLowerCase());
  if (found !== null) {
    const file = found.file;
    try {
      // one fetch per entry, however many callers wait for it
      let pending = pendingFetches.get(file);
      if (pending === undefined) {
        pending = found.pack.reader.read(file.filepos, file.filelen);
        pendingFetches.set(file, pending);
      }

      try {
        file.data = await pending;
      } finally {
        pendingFetches.delete(file);
      }

      return true;
    } catch (e) {
      Con_Printf(
        "Failed to fetch %s from %s: %s\n",
        file.name,
        found.pack.filename,
        e.message,
      );
      return false;
    }
  }

  // Construct URL from each base path + filename
  for (const basePath of looseFileBasePaths) {
    if (await COM_PreloadLooseFile(filename, basePath + filename)) return true;
  }

  return false;
}

/**
 * Not in id's common.c. Adds data (a Uint8Array) as a loose file, found by
 * COM_FindFile after every pak: a demo the player imported or recorded.
 */
export function COM_AddVirtualFile(filename, data) {
  virtualFiles.set(filename.toLowerCase(), data);
}

/**
 * Fetches a loose file from URL/path and adds it to virtualFiles.
 * Used for custom maps not included in pak files.
 * In Deno, reads from filesystem. In browser, uses fetch().
 */
export async function COM_PreloadLooseFile(filename, url) {
  try {
    let data;

    // a loose file in the browser's storage (see COM_SetUserFiles) first
    const user = com_userfiles.get(url.toLowerCase());
    if (user !== undefined) {
      data = new Uint8Array(await user.arrayBuffer());
    } else if (typeof Deno !== "undefined") {
      // Load from filesystem in Deno
      try {
        data = await Deno.readFile(url);
      } catch {
        return false;
      }
    } else {
      // Browser: use fetch
      const response = await fetch(url);
      if (!response.ok) {
        return false;
      }

      const buffer = await response.arrayBuffer();
      data = new Uint8Array(buffer);
    }

    virtualFiles.set(filename.toLowerCase(), data);
    return true;
  } catch {
    return false;
  }
}

/**
 * Preloads loose map files from the static/maps/ directory.
 * basePath is optional - used by Deno server to specify absolute path.
 */
export async function COM_PreloadMaps(mapList, basePath) {
  let loaded = 0;

  // Default base path, or use provided one (for Deno server)
  const base = basePath || "static/maps/";

  for (const mapName of mapList) {
    const filename = "maps/" + mapName + ".bsp";
    const url = base + mapName + ".bsp";

    if (await COM_PreloadLooseFile(filename, url)) {
      loaded++;
    }
  }

  if (loaded > 0) {
    Sys_Printf("Preloaded %d custom maps\\n", loaded);
  }

  return loaded;
}

/**
 * Loads a file from the pack system.
 * Returns an ArrayBuffer of the file contents, or null if not found.
 */
export function COM_LoadFile(filename) {
  const result = COM_FindFile(filename);
  if (!result) return null;

  // Return a copy of the data as an ArrayBuffer
  const buf = new ArrayBuffer(result.size);
  const dest = new Uint8Array(buf);
  dest.set(result.data);
  return buf;
}

/** Convenience: load a file and return it as a string */
export function COM_LoadFileAsString(filename) {
  const result = COM_FindFile(filename);
  if (!result) return null;

  let str = "";
  for (let i = 0; i < result.size; i++) {
    str += String.fromCharCode(result.data[i]);
  }

  return str;
}

// True when bytes (a Uint8Array) start with the 'PACK' magic
function isPack(bytes) {
  if (bytes.byteLength < 12) return false;
  return bytes[0] === 0x50 && bytes[1] === 0x41 && bytes[2] === 0x43 &&
    bytes[3] === 0x4B;
}

/**
 * Lazy paks (not in id's common.c, which reads entries from an open file
 * handle). A pak bigger than com_lazypaksize, such as the 2021 rerelease's
 * id1/pak0.pak (221 MB) or mg1/pak0.pak (497 MB), is not read whole: only its
 * header and directory are, and entries are read through a pak_reader_t:
 *
 * 	read( filepos, filelen )     Promise<Uint8Array>
 * 	readSync( filepos, filelen ) Uint8Array, or null when only async reads work
 *
 * Deno reads from disk with a seek, synchronously, so COM_FindFile works as
 * before. The browser uses HTTP Range requests: at load it fetches every entry
 * the engine reads synchronously (see COM_PakEntryIsDeferred), and the rest,
 * mainly maps, when COM_EnsureFile asks for them (the map, changelevel and load
 * commands and the client's world model already do). Smaller paks, including
 * the shareware and registered id1 paks, still load whole.
 */
export const COM_LAZY_PAK_SIZE = 64 * 1024 * 1024;
let com_lazypaksize = COM_LAZY_PAK_SIZE;

// Set by COM_FetchPak when it returned null because the file does not exist
// (rather than not being a pak), so COM_AddPakSequence tries the upper-case name
let com_fetchmissing = false;

// Coalesce eager entries closer together than this into one Range request
const RANGE_GAP = 256 * 1024;

// Files the engine reads only on demand (.lit coloured lighting, fetched with
// its map by COM_EnsureFile; skybox .tga faces, fetched by Sky_LoadSkyBox;
// .md5mesh and .md5anim, fetched with their .mdl by gl_model.js
// Mod_LoadMD5Replacement) or never (editor and KEX assets; archive/ is the
// source and tools tree, about 97 MB, in the re-release ctf pak)
const DEFERRED_EXTENSIONS = [
  ".lit",
  ".map",
  ".ent",
  ".png",
  ".tga",
  ".jpg",
  ".md5mesh",
  ".md5anim",
  ".nav",
  ".fgd",
];
const DEFERRED_DIRS = ["tactile/", "vault/", "archive/"];

/** Sets the size above which COM_FetchPak opens a pak lazily (tests use it). */
export function COM_SetLazyPakSize(size) {
  com_lazypaksize = size;
}

/**
 * True when a lazily opened pak's entry is fetched only on demand through
 * COM_EnsureFile rather than at load: maps bigger than 32k (as in
 * COM_ListFiles) but never the b_*.bsp item models, which QuakeC precaches
 * synchronously and LibreQuake's are up to 42k; the mapper texture wads in
 * gfx/, .lit files (fetched with their map), and file types and directories
 * the engine never reads.
 */
export function COM_PakEntryIsDeferred(name, filelen) {
  if (name.startsWith("maps/") && name.endsWith(".bsp")) {
    return filelen > 32 * 1024 && name.startsWith("maps/b_") === false;
  }
  if (name.startsWith("gfx/") && name.endsWith(".wad")) {
    return true;
  }
  for (const dir of DEFERRED_DIRS) {
    if (name.startsWith(dir)) return true;
  }
  for (const ext of DEFERRED_EXTENSIONS) {
    if (name.endsWith(ext)) return true;
  }
  return false;
}

// pak_reader_t over a file on disk (Deno). Each read opens the file, so no
// handle stays open between reads.
function COM_FileReader(path) {
  const readSync = (pos, len) => {
    const out = new Uint8Array(len);
    const f = Deno.openSync(path, { read: true });
    try {
      f.seekSync(pos, Deno.SeekMode.Start);
      let off = 0;
      while (off < len) {
        const n = f.readSync(out.subarray(off));
        if (n === null || n === 0) throw new Error("unexpected end of " + path);
        off += n;
      }
    } finally {
      f.close();
    }

    return out;
  };

  return {
    read: (pos, len) => Promise.resolve().then(() => readSync(pos, len)),
    readSync: readSync,
  };
}

// pak_reader_t over HTTP Range requests (browser)
function COM_RangeReader(url) {
  const read = async (pos, len) => {
    if (len === 0) return new Uint8Array(0);
    const response = await fetch(url, {
      headers: { Range: "bytes=" + pos + "-" + (pos + len - 1) },
    });
    if (response.status !== 206) {
      if (response.body !== null) await response.body.cancel();
      throw new Error(
        "HTTP " + response.status + " for a byte range of " + url,
      );
    }

    const data = new Uint8Array(await response.arrayBuffer());
    if (data.length !== len) throw new Error("short byte range from " + url);
    return data;
  };

  return { read: read, readSync: null };
}

// pak_reader_t over a Blob: a pak the player copied into the browser's
// storage (see src/userdata.js). Blob.slice reads only the bytes asked for.
function COM_BlobReader(blob) {
  const read = async (pos, len) => {
    if (len === 0) return new Uint8Array(0);
    const data = new Uint8Array(
      await blob.slice(pos, pos + len).arrayBuffer(),
    );
    if (data.length !== len) throw new Error("short read");
    return data;
  };

  return { read: read, readSync: null };
}

/**
 * Not in id's common.c. Opens a pak held in a Blob, such as a File: whole when
 * it is at most com_lazypaksize, else lazily, as COM_FetchPak does for a URL.
 * Returns a Promise of the pack_t, or null (with a message) when the Blob is
 * not a pak or can't be read.
 */
export async function COM_OpenBlobPak(blob, filename, onProgress) {
  try {
    const reader = COM_BlobReader(blob);
    const header = await reader.read(0, Math.min(12, blob.size));
    if (!isPack(header)) {
      Con_Printf("%s is not a packfile\n", filename);
      return null;
    }

    if (blob.size > com_lazypaksize) {
      return await COM_OpenLazyPack(
        filename,
        filename,
        reader,
        header,
        onProgress,
      );
    }

    const buffer = await blob.arrayBuffer();
    if (onProgress) onProgress(1);
    return COM_LoadPackFile(filename, buffer);
  } catch (e) {
    Con_Printf("Couldn't read %s: %s\n", filename, e.message);
    return null;
  }
}

// Paks the player copied into the browser's storage, by the lower-case URL
// COM_AddPakSequence would otherwise fetch (src/userdata.js UD_MountPaks)
let com_userpaks = new Map();

/**
 * Not in id's common.c. Sets the player's own paks (a Map from lower-case URL,
 * such as "static/pak1.pak", to Blob). COM_AddPakSequence opens each in place
 * of fetching its URL, so registered data never has to be on the server.
 */
export function COM_SetUserPaks(paks) {
  com_userpaks = paks;
}

// Loose files in the browser's storage, by lower-case URL, as com_userpaks
let com_userfiles = new Map();

/**
 * Not in id's common.c. Sets loose files kept in the browser's storage (a Map
 * from lower-case URL, such as "static/librequake/id1/maps/lqdm1.bsp", to
 * Blob). COM_PreloadLooseFile reads one in place of fetching its URL.
 */
export function COM_SetUserFiles(files) {
  com_userfiles = files;
}

/**
 * Builds a pack_t from header (the pak's first 12 bytes) and the directory read
 * through reader. Without readSync, also fetches every entry that is not
 * deferred, coalescing neighbours into few requests.
 */
async function COM_OpenLazyPack(url, filename, reader, header, onProgress) {
  const view = new DataView(header.buffer, header.byteOffset, 12);
  const dirofs = view.getInt32(4, true);
  const dirlen = view.getInt32(8, true);

  const pack = COM_LoadPackDirectory(
    filename,
    await reader.read(dirofs, dirlen),
  );
  pack.reader = reader;

  if (reader.readSync !== null) {
    if (onProgress) onProgress(1);
    return pack;
  }

  const files = [];
  for (const f of pack.files) {
    if (COM_PakEntryIsDeferred(f.name, f.filelen)) continue;
    if (f.filelen === 0) f.data = new Uint8Array(0);
    else files.push(f);
  }

  files.sort((a, b) => a.filepos - b.filepos);

  let total = 0;
  for (const f of files) total += f.filelen;

  let done = 0;
  let requests = 0;
  for (let i = 0; i < files.length;) {
    // one group: files[ i .. j ), each starting within RANGE_GAP of the last's end
    const start = files[i].filepos;
    let end = start + files[i].filelen;
    let j = i + 1;
    while (j < files.length && files[j].filepos <= end + RANGE_GAP) {
      end = Math.max(end, files[j].filepos + files[j].filelen);
      j++;
    }

    const chunk = await reader.read(start, end - start);
    requests++;
    for (let k = i; k < j; k++) {
      const f = files[k];
      f.data = chunk.subarray(f.filepos - start, f.filepos - start + f.filelen);
      done += f.filelen;
    }

    if (onProgress && total > 0) onProgress(done / total);
    i = j;
  }

  if (onProgress) onProgress(1);

  Sys_Printf(
    "Fetched %d of %d files from %s (%d bytes, %d requests)\n",
    files.length,
    pack.files.length,
    url,
    done,
    requests,
  );
  return pack;
}

/**
 * Fetches a .pak file and returns a Promise<pack_t>. A local path is read in
 * Deno; an http(s) URL, or any URL in the browser, is fetched. A pak bigger
 * than com_lazypaksize opens lazily (see COM_OpenLazyPack). In the browser
 * that needs a server that honours Range requests: one that ignores them
 * (python3 -m http.server does) answers the first, 12-byte request with the
 * whole pak, which then loads whole as before.
 * With optional set, a missing file (Deno NotFound, HTTP 404, or a body that
 * is not a PACK, such as a web host's index.html fallback) returns null
 * without a message, as COM_AddGameDirectory stops quietly at the first
 * missing pakN.pak.
 */
export async function COM_FetchPak(
  url,
  filename,
  onProgress,
  optional = false,
) {
  com_fetchmissing = false;

  if (!optional) Sys_Printf("Fetching " + url + "...\\n");

  if (typeof Deno !== "undefined" && !/^https?:/.test(url)) {
    // Load from filesystem in Deno
    try {
      const size = Deno.statSync(url).size;
      if (size > com_lazypaksize) {
        const reader = COM_FileReader(url);
        const header = reader.readSync(0, 12);
        if (!isPack(header)) {
          if (optional) return null;
          Sys_Error(url + " is not a packfile");
          return null;
        }

        return await COM_OpenLazyPack(
          url,
          filename,
          reader,
          header,
          onProgress,
        );
      }

      const data = await Deno.readFile(url);
      if (optional && !isPack(data)) return null;
      if (onProgress) onProgress(1);
      return COM_LoadPackFile(filename, data.buffer);
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) com_fetchmissing = true;
      if (!(optional && e instanceof Deno.errors.NotFound)) {
        Con_Printf("Failed to load " + url + ": " + e.message + "\\n");
      }
      return null;
    }
  }

  // Browser: ask for the header only, to learn the pak's size
  let response = await fetch(url, { headers: { Range: "bytes=0-11" } });
  if (!response.ok) {
    // 416: an empty file, which has no byte 0
    if (response.status === 404) com_fetchmissing = true;
    if (!(optional && (response.status === 404 || response.status === 416))) {
      Con_Printf("Failed to fetch " + url + ": " + response.statusText + "\\n");
    }
    return null;
  }

  if (response.status === 206) {
    const header = new Uint8Array(await response.arrayBuffer());
    if (!isPack(header)) {
      if (optional) return null;
      Sys_Error(url + " is not a packfile");
      return null;
    }

    const range = /\/(\d+)\s*$/.exec(
      response.headers.get("content-range") || "",
    );
    const size = range !== null ? parseInt(range[1], 10) : 0;
    if (range === null) {
      Con_Printf(
        "No pak size in the Content-Range of %s (cross-origin servers must expose it); loading it whole\n",
        url,
      );
    }
    if (size > com_lazypaksize) {
      try {
        return await COM_OpenLazyPack(
          url,
          filename || url,
          COM_RangeReader(url),
          header,
          onProgress,
        );
      } catch (e) {
        Con_Printf("Failed to fetch " + url + ": " + e.message + "\n");
        return null;
      }
    }

    // a small pak loads whole, as before
    response = await fetch(url);
    if (!response.ok) {
      Con_Printf("Failed to fetch " + url + ": " + response.statusText + "\\n");
      return null;
    }
  }

  // 200: the whole pak, either asked for or because Range was ignored
  let buffer;
  const contentLength = response.headers.get("content-length");

  if (onProgress && contentLength && response.body) {
    const total = parseInt(contentLength, 10);
    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      chunks.push(value);
      received += value.length;
      onProgress(Math.min(1, received / total));
    }

    buffer = new ArrayBuffer(received);
    const dest = new Uint8Array(buffer);
    let offset = 0;
    for (const chunk of chunks) {
      dest.set(chunk, offset);
      offset += chunk.length;
    }
  } else {
    buffer = await response.arrayBuffer();
    if (onProgress) onProgress(1);
  }

  if (optional && !isPack(new Uint8Array(buffer))) return null;

  Sys_Printf("Loaded " + url + " (" + buffer.byteLength + " bytes)\\n");

  return COM_LoadPackFile(filename || url, buffer);
}

/**
 * Loads pak0.pak, pak1.pak, ... from the directory of pak0Url and adds each
 * one, stopping at the first missing file, as common.c COM_AddGameDirectory
 * does. Later paks are searched first, so pak1 (registered) overrides pak0.
 * pak0 is required; the rest are optional. Returns the number of paks added.
 * A pak the player added through the Game data panel (COM_SetUserPaks) is
 * tried first, and the server's copy only if there is none or it does not
 * open. Each server name is tried in lower case, then upper case (PAK1.PAK as
 * copied from a Windows install), since web servers and most file systems
 * other than macOS's are case-sensitive. A URL that does not end in pak0.pak
 * (in either case) is loaded on its own. onProgress runs from 0 to 1 for each
 * pak in turn, since the total size is not known in advance.
 */
export async function COM_AddPakSequence(pak0Url, onProgress) {
  const match = /^(.*?)pak0\.pak$/i.exec(pak0Url);
  if (match === null) {
    const pak = await COM_FetchPak(pak0Url, "pak0.pak", onProgress);
    if (pak === null) return 0;
    COM_AddPack(pak);
    return 1;
  }

  const dir = match[1];
  const path_id = ++com_last_path_id;
  let count = 0;
  for (let i = 0;; i++) {
    const name = "pak" + i + ".pak";
    // the player's own copy first (see COM_SetUserPaks); one that doesn't
    // open falls back to the server's, so a bad copy can't stop the game
    const user = com_userpaks.get((dir + name).toLowerCase());
    let pak = user !== undefined ?
      await COM_OpenBlobPak(user, name, onProgress) :
      null;
    if (pak === null) {
      pak = await COM_FetchPak(dir + name, name, onProgress, true);
    }
    if (pak === null && com_fetchmissing === true) {
      pak = await COM_FetchPak(
        dir + name.toUpperCase(),
        name,
        onProgress,
        i > 0,
      );
    } else if (pak === null && i === 0) {
      Sys_Error(dir + name + " is not a packfile");
    }
    if (pak === null) break;
    COM_AddPack(pak, path_id);
    count++;
  }

  return count;
}
