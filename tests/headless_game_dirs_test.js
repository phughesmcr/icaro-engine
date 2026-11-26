// server/headless_host.js with game directories: opts.base, -game in
// opts.argv and opts.game_dirs mount before Host_Init, in common.c's order,
// over the shareware pak. The fixture game directories are built in a temp
// directory at run time: no pak but static/pak0.pak may be tracked.

import {
  headless_init,
  headless_map,
  headless_search_paths,
} from "../server/headless_host.js";
import { COM_EnsureFile, COM_LoadFileAsString } from "../src/pak.js";
import { host_colormap } from "../src/host.js";
import { sv } from "../src/server.js";

function assert(cond, message) {
  if (cond !== true) {
    throw new Error(message);
  }
}

function same(actual, expected, what) {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    what + ": " + JSON.stringify(actual),
  );
}

const STATIC = decodeURIComponent(
  new URL("../static/", import.meta.url).pathname,
);

Deno.test("headless search paths: the default is the shareware pak alone", () => {
  const paths = headless_search_paths();
  same(paths.pak, STATIC + "pak0.pak", "pak");
  same(paths.pak_sequence, false, "pak_sequence");
  same(paths.argv, ["quake"], "argv");
  same(paths.game_dirs, [], "game_dirs");
  same(paths.loose_dirs, [STATIC], "loose_dirs");
});

Deno.test("headless search paths: common.c's order, then game_dirs", () => {
  const paths = headless_search_paths({
    pak: "/q/id1/pak0.pak",
    argv: ["-game", "mod", "-hipnotic", "-rogue"],
    game_dirs: ["/x/a/", "/y/b"],
  });
  // id1's parent is the basedir, as in C
  same(
    paths.game_dirs,
    ["/q/rogue", "/q/hipnotic", "/q/mod", "/x/a", "/y/b"],
    "game_dirs",
  );
  same(
    paths.loose_dirs,
    ["/y/b/", "/x/a/", "/q/mod/", "/q/hipnotic/", "/q/rogue/", "/q/id1/"],
    "loose_dirs",
  );
  same(paths.pak_sequence, false, "pak_sequence");
  same(
    paths.argv,
    ["quake", "-game", "mod", "-hipnotic", "-rogue"],
    "argv",
  );
});

Deno.test("headless search paths: a pak outside id1 is its own basedir", () => {
  const paths = headless_search_paths({
    pak: "/q/pak0.pak",
    argv: ["-hipnotic"],
  });
  same(paths.game_dirs, ["/q/hipnotic"], "game_dirs");
  same(paths.loose_dirs, ["/q/hipnotic/", "/q/"], "loose_dirs");
});

Deno.test("headless search paths: base sets the id1 pak sequence", () => {
  const paths = headless_search_paths({
    base: "/r/",
    argv: ["-game", "mg1"],
  });
  same(paths.pak, "/r/id1/pak0.pak", "pak");
  same(paths.pak_sequence, true, "pak_sequence");
  same(paths.game_dirs, ["/r/mg1"], "game_dirs");
  same(paths.loose_dirs, ["/r/mg1/", "/r/id1/", STATIC], "loose_dirs");
});

Deno.test("headless search paths: a -game name must be one component", () => {
  for (const argv of [["-game"], ["-game", "../x"], ["-game", "a/b"]]) {
    let threw = false;
    try {
      headless_search_paths({ argv });
    } catch {
      threw = true;
    }
    assert(threw === true, "accepted " + JSON.stringify(argv));
  }
});

/** A pak holding files, a map of name to Uint8Array or string */
function makePak(files) {
  const enc = new TextEncoder();
  const entries = Object.entries(files).map(([name, data]) => [
    name,
    typeof data === "string" ? enc.encode(data) : data,
  ]);
  let size = 12;
  for (const [, data] of entries) size += data.length;
  const dirofs = size;
  size += entries.length * 64;

  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set(enc.encode("PACK"), 0);
  view.setInt32(4, dirofs, true);
  view.setInt32(8, entries.length * 64, true);
  let pos = 12;
  entries.forEach(([name, data], i) => {
    out.set(data, pos);
    const entry = dirofs + i * 64;
    out.set(enc.encode(name), entry);
    view.setInt32(entry + 56, pos, true);
    view.setInt32(entry + 60, data.length, true);
    pos += data.length;
  });

  return out;
}

const SHAREWARE_PAK = decodeURIComponent(
  new URL("../static/pak0.pak", import.meta.url).pathname,
);

// A colormap no Quake pak ships, so finding it in host_colormap shows the
// fixture's gfx/colormap.lmp was mounted when Host_Init loaded it. (Not the
// palette: VID_Init applies gamma to host_basepal in place.)
const FIXTURE_COLORMAP = new Uint8Array(64 * 256 + 1);
for (let i = 0; i < FIXTURE_COLORMAP.length; i++) {
  FIXTURE_COLORMAP[i] = (i * 7 + 3) & 255;
}

// common.c COM_CheckRegistered: on shareware data a modified game (any
// game directory) is a Sys_Error, as in C, so the fixture carries the
// registered version's gfx/pop.lmp, the 128 big-endian shorts of the pop
// table in src/common.js
// A table kept in rows: deno fmt would give each entry its own line
// deno-fmt-ignore
const POP = [
	0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000,
	0x0000, 0x0000, 0x6600, 0x0000, 0x0000, 0x0000, 0x6600, 0x0000,
	0x0000, 0x0066, 0x0000, 0x0000, 0x0000, 0x0000, 0x0067, 0x0000,
	0x0000, 0x6665, 0x0000, 0x0000, 0x0000, 0x0000, 0x0065, 0x6600,
	0x0063, 0x6561, 0x0000, 0x0000, 0x0000, 0x0000, 0x0061, 0x6563,
	0x0064, 0x6561, 0x0000, 0x0000, 0x0000, 0x0000, 0x0061, 0x6564,
	0x0064, 0x6564, 0x0000, 0x6469, 0x6969, 0x6400, 0x0064, 0x6564,
	0x0063, 0x6568, 0x6200, 0x0064, 0x6864, 0x0000, 0x6268, 0x6563,
	0x0000, 0x6567, 0x6963, 0x0064, 0x6764, 0x0063, 0x6967, 0x6500,
	0x0000, 0x6266, 0x6769, 0x6a68, 0x6768, 0x6a69, 0x6766, 0x6200,
	0x0000, 0x0062, 0x6566, 0x6666, 0x6666, 0x6666, 0x6562, 0x0000,
	0x0000, 0x0000, 0x0062, 0x6364, 0x6664, 0x6362, 0x0000, 0x0000,
	0x0000, 0x0000, 0x0000, 0x0062, 0x6662, 0x0000, 0x0000, 0x0000,
	0x0000, 0x0000, 0x0000, 0x0061, 0x6661, 0x0000, 0x0000, 0x0000,
	0x0000, 0x0000, 0x0000, 0x0000, 0x6500, 0x0000, 0x0000, 0x0000,
	0x0000, 0x0000, 0x0000, 0x0000, 0x6400, 0x0000, 0x0000, 0x0000
];
const POP_LMP = new Uint8Array(256);
POP.forEach((v, i) => {
  POP_LMP[2 * i] = v >> 8;
  POP_LMP[2 * i + 1] = v & 255;
});

// <tmp>/id1/pak0.pak links to the shareware pak (opts.base), <tmp>/fixa is
// the -game directory, and <tmp>/elsewhere/fixb, outside the basedir, is in
// opts.game_dirs
const tmp = await Deno.makeTempDir({ prefix: "headless_game_dirs_" });
await Deno.mkdir(tmp + "/id1");
await Deno.symlink(SHAREWARE_PAK, tmp + "/id1/pak0.pak");
await Deno.mkdir(tmp + "/fixa/fixture", { recursive: true });
await Deno.writeFile(
  tmp + "/fixa/pak0.pak",
  makePak({
    "gfx/colormap.lmp": FIXTURE_COLORMAP,
    "gfx/pop.lmp": POP_LMP,
    "fixture/a.txt": "fixa",
    "fixture/shared.txt": "fixa",
  }),
);
await Deno.writeTextFile(tmp + "/fixa/fixture/loose_a.txt", "fixa loose");
await Deno.writeTextFile(tmp + "/fixa/fixture/loose.txt", "fixa loose");
await Deno.mkdir(tmp + "/elsewhere/fixb/fixture", { recursive: true });
await Deno.writeFile(
  tmp + "/elsewhere/fixb/pak0.pak",
  makePak({ "fixture/shared.txt": "fixb" }),
);
await Deno.writeTextFile(
  tmp + "/elsewhere/fixb/fixture/loose.txt",
  "fixb loose",
);

// Host_Init runs once per process, so every test shares this host and they
// run in order
await headless_init({
  base: tmp,
  argv: ["-game", "fixa"],
  game_dirs: [tmp + "/elsewhere/fixb/"],
});

Deno.test("headless game dirs: mounted before Host_Init", () => {
  assert(host_colormap !== null, "no colormap loaded");
  assert(
    host_colormap.length === FIXTURE_COLORMAP.length &&
      host_colormap.every((v, i) => v === FIXTURE_COLORMAP[i]),
    "Host_Init loaded id1's colormap, not the -game directory's",
  );
});

Deno.test("headless game dirs: files found in search-path order", () => {
  assert(
    COM_LoadFileAsString("fixture/a.txt") === "fixa",
    "fixture-only file not found",
  );
  assert(
    COM_LoadFileAsString("fixture/shared.txt") === "fixb",
    "a later game_dirs entry does not override the -game directory",
  );
  const quakerc = COM_LoadFileAsString("quake.rc");
  assert(
    quakerc !== null && quakerc.includes("exec default.cfg"),
    "id1's quake.rc not found under the game directories",
  );
});

Deno.test("headless game dirs: loose files, last game directory first", async () => {
  assert(
    await COM_EnsureFile("fixture/loose.txt") === true &&
      COM_LoadFileAsString("fixture/loose.txt") === "fixb loose",
    "loose file not taken from the last game directory",
  );
  assert(
    await COM_EnsureFile("fixture/loose_a.txt") === true &&
      COM_LoadFileAsString("fixture/loose_a.txt") === "fixa loose",
    "loose file in the -game directory not found",
  );
  assert(
    await COM_EnsureFile("fixture/missing.txt") === false,
    "a missing loose file was found",
  );
});

Deno.test("headless game dirs: an id1 map still loads", async () => {
  await headless_map("e1m1");
  assert(sv.active === true && sv.name === "e1m1", "server map " + sv.name);
});

Deno.test("headless game dirs: remove the fixture", async () => {
  await Deno.remove(tmp, { recursive: true });
});
