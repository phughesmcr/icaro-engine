// Bring your own data (src/userdata.js): sorting a player's paks by what they
// hold, and mounting them from a Blob (pak.js COM_OpenBlobPak and
// COM_SetUserPaks). Paks here are built in memory: never registered data.

import { com_modified, COM_SetModified } from "../src/common.js";
import {
  COM_AddPack,
  COM_AddPakSequence,
  COM_EnsureFile,
  COM_FindFile,
  COM_LAZY_PAK_SIZE,
  COM_OpenBlobPak,
  COM_PreloadLooseFile,
  COM_SetLazyPakSize,
  COM_SetUserFiles,
  COM_SetUserPaks,
} from "../src/pak.js";
import { CDAudio_SetStoredTracks, CDAudio_TrackURLs } from "../src/cd_audio.js";
import {
  UD_ClassifyPak,
  UD_DemoName,
  UD_MountPaks,
  UD_PakKey,
  UD_PlayOptions,
  UD_ReadPakNames,
  UD_SaveSlot,
} from "../src/userdata.js";

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${
        JSON.stringify(actual)
      }`,
    );
  }
}

// A pack of entries [ name, string or Uint8Array ]: header, bodies, directory
function makePak(entries) {
  const bodies = entries.map(([, b]) =>
    typeof b === "string" ? new TextEncoder().encode(b) : b
  );
  let dirofs = 12;
  for (const body of bodies) dirofs += body.length;
  const bytes = new Uint8Array(dirofs + 64 * entries.length);
  const view = new DataView(bytes.buffer);
  bytes.set([0x50, 0x41, 0x43, 0x4B], 0); // 'PACK'
  view.setInt32(4, dirofs, true);
  view.setInt32(8, 64 * entries.length, true);
  let pos = 12;
  entries.forEach(([name], i) => {
    bytes.set(bodies[i], pos);
    const e = dirofs + i * 64;
    bytes.set(new TextEncoder().encode(name), e);
    view.setInt32(e + 56, pos, true);
    view.setInt32(e + 60, bodies[i].length, true);
    pos += bodies[i].length;
  });
  return bytes;
}

function text(name) {
  const file = COM_FindFile(name);
  return file === null ? null : new TextDecoder().decode(file.data);
}

// The marker files of each pak, as in the real paks' directories
const KINDS = [
  [["progs.dat", "maps/e1m1.bsp", "maps/start.bsp"], null],
  [["maps/e2m1.bsp", "gfx/pop.lmp"], "id1"],
  [["progs.dat", "maps/hip1m1.bsp"], "hipnotic"],
  [["progs.dat", "maps/r1m1.bsp", "maps/ctf1.bsp"], "rogue"],
  [["bots/x", "progs.dat", "mapdb.json", "maps/e1m1.bsp"], "rerelease/id1"],
  [["bots/x", "progs.dat", "maps/hip1m1.bsp"], "rerelease/hipnotic"],
  [["bots/x", "maps/r1m1.bsp", "maps/ctf1.bsp"], "rerelease/rogue"],
  [["bots/x", "maps/horde1.bsp", "maps/mgdm1.bsp"], "rerelease/mg1"],
  [["bots/x", "mg-dawn.nfo", "maps/dm1.bsp"], "rerelease/mg3"],
  [["bots/x", "maps/e5m1.bsp"], "rerelease/dopa"],
  [["bots/x", "archive/x", "maps/ctf1.bsp"], "rerelease/ctf"],
  [["maps/mymap.bsp"], null],
];

Deno.test("UD_ClassifyPak places each pak by its contents, not its name", () => {
  for (const [names, dir] of KINDS) {
    const what = UD_ClassifyPak(new Set(names));
    assertEqual(what === null ? null : what.dir, dir, names.join(" "));
  }
});

Deno.test("UD_PakKey is the URL main.js fetches", () => {
  assertEqual(UD_PakKey("id1"), "static/pak1.pak", "registered");
  assertEqual(UD_PakKey("hipnotic"), "static/hipnotic/pak0.pak", "hipnotic");
  assertEqual(
    UD_PakKey("rerelease/id1"),
    "static/rerelease/id1/pak0.pak",
    "rerelease",
  );
  assertEqual(
    UD_PakKey("rerelease/mg1"),
    "static/rerelease/mg1/pak0.pak",
    "mg1",
  );
});

Deno.test("UD_ReadPakNames reads the directory and refuses what isn't a pak", async () => {
  const pak = makePak([["MAPS/E2M1.BSP", "x"], ["gfx/pop.lmp", "y"]]);
  const names = await UD_ReadPakNames(new Blob([pak]));
  assertEqual(names.has("maps/e2m1.bsp"), true, "lower-cased name");
  assertEqual(names.size, 2, "both entries");

  assertEqual(
    await UD_ReadPakNames(new Blob(["<html>not a pak</html>"])),
    null,
    "HTML",
  );
  assertEqual(await UD_ReadPakNames(new Blob(["PACK"])), null, "too short");
  const bad = pak.slice();
  new DataView(bad.buffer).setInt32(4, 1 << 30, true);
  assertEqual(
    await UD_ReadPakNames(new Blob([bad])),
    null,
    "directory past the end",
  );
});

Deno.test("UD_PlayOptions offers only games whose paks are stored", () => {
  const labels = (keys) =>
    UD_PlayOptions(new Set(keys)).map((o) => o.query).join(" ");
  assertEqual(labels([]), "?base=id1", "shareware only");
  assertEqual(
    labels(["static/pak1.pak", "static/hipnotic/pak0.pak"]),
    "?base=id1 ?game=hipnotic",
    "registered and hipnotic",
  );
  assertEqual(
    labels(["static/rerelease/mg1/pak0.pak"]),
    "?base=id1",
    "an add-on without the rerelease's id1 can't start",
  );
  assertEqual(
    labels(["static/rerelease/id1/pak0.pak", "static/rerelease/mg1/pak0.pak"]),
    "?base=id1 ?base=rerelease ?base=rerelease&game=mg1",
    "rerelease and mg1",
  );
  // LibreQuake once its manifest is stored, not for its files alone
  assertEqual(
    labels(["static/librequake/id1/pak0.pak"]),
    "?base=id1",
    "LibreQuake part unpacked",
  );
  assertEqual(
    labels(["librequake/manifest.json", "static/librequake/id1/pak0.pak"]),
    "?base=librequake ?base=id1",
    "LibreQuake installed",
  );
});

Deno.test("UD_SaveSlot takes a version 5 save with a plain slot name", () => {
  assertEqual(UD_SaveSlot("s0.sav", "5\nkills\n"), "s0", "slot s0");
  assertEqual(UD_SaveSlot("S3.SAV", "5\r\nx"), "S3", "upper case, CRLF");
  assertEqual(UD_SaveSlot("s0.sav", "4\nold"), null, "old version");
  assertEqual(UD_SaveSlot("../x.sav", "5\n"), null, "path");
  assertEqual(UD_SaveSlot("s0.txt", "5\n"), null, "not .sav");
});

Deno.test("UD_DemoName keeps a demo name safe to quote in playdemo", () => {
  assertEqual(UD_DemoName("My Run.DEM"), "my_run.dem", "spaces");
  assertEqual(UD_DemoName('a"b;quit'), "a_b_quit.dem", "quote and semicolon");
  assertEqual(UD_DemoName("dir/x.dem"), "x.dem", "directory dropped");
});

Deno.test("COM_OpenBlobPak opens a small pak whole and a big one lazily", async () => {
  const wasModified = com_modified;
  try {
    const small = await COM_OpenBlobPak(
      new Blob([makePak([["udblob/a.txt", "whole"]])]),
      "pak9.pak",
    );
    COM_AddPack(small);
    assertEqual(text("udblob/a.txt"), "whole", "small pak entry");

    COM_SetLazyPakSize(0);
    const map = new Uint8Array(40000).fill(65);
    const progress = [];
    const lazy = await COM_OpenBlobPak(
      new Blob([
        makePak([["udblob/b.txt", "eager"], ["maps/udblob.bsp", map]]),
      ]),
      "pak8.pak",
      (p) => progress.push(p),
    );
    COM_AddPack(lazy);
    assertEqual(lazy.data, null, "not read whole");
    assertEqual(text("udblob/b.txt"), "eager", "engine file read at load");
    assertEqual(COM_FindFile("maps/udblob.bsp"), null, "map deferred");
    assertEqual(await COM_EnsureFile("maps/udblob.bsp"), true, "map fetched");
    assertEqual(COM_FindFile("maps/udblob.bsp").size, 40000, "map size");
    assertEqual(progress[progress.length - 1], 1, "progress ends at 1");

    assertEqual(
      await COM_OpenBlobPak(new Blob(["nope"]), "bad.pak"),
      null,
      "not a pak",
    );
  } finally {
    COM_SetLazyPakSize(COM_LAZY_PAK_SIZE);
    COM_SetModified(wasModified);
  }
});

Deno.test("COM_AddPakSequence opens the player's paks in place of the server's", async () => {
  const wasModified = com_modified;
  const dir = await Deno.makeTempDir();
  try {
    // the server has pak0 only; the player adds pak1
    await Deno.writeFile(
      dir + "/pak0.pak",
      makePak([["udseq/a.txt", "server0"], ["udseq/b.txt", "server0"]]),
    );
    COM_SetUserPaks(
      new Map([[
        (dir + "/pak1.pak").toLowerCase(),
        new Blob([makePak([["udseq/b.txt", "user1"]])]),
      ]]),
    );
    assertEqual(await COM_AddPakSequence(dir + "/pak0.pak"), 2, "pak count");
    assertEqual(text("udseq/a.txt"), "server0", "server's pak0");
    assertEqual(text("udseq/b.txt"), "user1", "player's pak1 searched first");

    // a copy that isn't a pak falls back to the server's
    await Deno.writeFile(
      dir + "/pak0.pak",
      makePak([["udseq/c.txt", "server again"]]),
    );
    COM_SetUserPaks(
      new Map([[
        (dir + "/pak0.pak").toLowerCase(),
        new Blob(["not a pak"]),
      ]]),
    );
    assertEqual(await COM_AddPakSequence(dir + "/pak0.pak"), 1, "fallback");
    assertEqual(text("udseq/c.txt"), "server again", "server's copy loaded");
  } finally {
    COM_SetUserPaks(new Map());
    COM_SetModified(wasModified);
    await Deno.remove(dir, { recursive: true });
  }
});

// The store interface of UD_OpenStore, in memory
function memoryStore(files) {
  const map = new Map(Object.entries(files));
  return {
    kind: "memory",
    list: () =>
      Promise.resolve([...map].map(([key, b]) => ({ key, size: b.size }))),
    get: (key) => Promise.resolve(map.get(key) ?? null),
    put: () => Promise.resolve(),
    remove: () => Promise.resolve(),
  };
}

Deno.test("UD_MountPaks mounts LibreQuake's loose files and music only once its manifest is stored", async () => {
  const lq = "static/librequake/id1/";
  // not a LibreQuake map, so deno task fetch-data's copy on disk (which
  // COM_PreloadLooseFile falls back to) doesn't answer for the store
  const files = {
    [lq + "maps/ud_test.bsp"]: new Blob([new Uint8Array([29, 0, 0, 0])]),
    [lq + "music/track02.ogg"]: new Blob(["OggS"]),
  };
  const track = (dirs) => CDAudio_TrackURLs(2, dirs)[0];
  try {
    await UD_MountPaks(memoryStore(files));
    assertEqual(
      await COM_PreloadLooseFile("maps/ud_test.bsp", lq + "maps/ud_test.bsp"),
      false,
      "no manifest: not mounted",
    );
    assertEqual(track([lq.slice(0, -1)]), lq + "music/track02.ogg", "url");

    await UD_MountPaks(memoryStore({
      ...files,
      "librequake/manifest.json": new Blob(['{"version":"v0.09-beta"}']),
    }));
    assertEqual(
      await COM_PreloadLooseFile("maps/ud_test.bsp", lq + "maps/ud_test.bsp"),
      true,
      "manifest: the stored map is read",
    );
    assertEqual(
      track([lq.slice(0, -1)]).startsWith("blob:"),
      true,
      "the stored track plays from a blob: URL",
    );
    assertEqual(track(["static"]), "static/music/track02.ogg", "id1's music");
  } finally {
    COM_SetUserPaks(new Map());
    COM_SetUserFiles(new Map());
    CDAudio_SetStoredTracks(new Map());
  }
});
