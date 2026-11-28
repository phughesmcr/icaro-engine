// BSPX lump table and RGBLIGHTING (Quakespasm-Spiked Q1BSPX_Setup,
// Q1BSPX_FindLump and Mod_LoadLighting). Every map here is synthetic:
// commercial data must never be committed.

// Bootstrap the renderer's existing circular module graph in its safe order.
await import("../src/gl_rsurf.js");

const gl_model = await import("../src/gl_model.js");
const { cls, ca_dedicated } = await import("../src/client.js");
const { COM_AddPack } = await import("../src/pak.js");
const { writeMap, smallMap } = await import("./synthetic_bsp.js");

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

const LIGHT_LEN = 128; // smallMap's lit face reads from lightofs 64

function monoLighting() {
  const out = new Uint8Array(LIGHT_LEN);
  for (let i = 0; i < LIGHT_LEN; i++) out[i] = i;
  return out;
}

// RGB samples: r = 10, g = 20, b = sample number
function rgbLighting(samples) {
  const out = new Uint8Array(samples * 3);
  for (let i = 0; i < samples; i++) {
    out[i * 3] = 10;
    out[i * 3 + 1] = 20;
    out[i * 3 + 2] = i & 255;
  }
  return out;
}

function addFile(name, bytes) {
  COM_AddPack({
    files: [{ name: name, filepos: 0, filelen: bytes.length }],
    data: bytes.buffer,
  });
}

let mapSerial = 0;

function loadBytes(bytes, lit = null) {
  const name = "maps/__bspx_" + (mapSerial++);
  addFile(name + ".bsp", bytes);
  if (lit !== null) addFile(name + ".lit", lit);
  return gl_model.Mod_ForName(name + ".bsp", true);
}

function mapWith(bspx, opts = {}) {
  const map = smallMap();
  if (opts.mono !== false) map.lighting = monoLighting();
  map.bspx = bspx;
  return writeMap(opts.bsp2 !== undefined ? opts.bsp2 : false, map);
}

function assertRgb(mod, message) {
  assertEqual(mod.litfile, true, message + ": litfile");
  assertEqual(mod.lightdata.length, LIGHT_LEN * 3, message + ": RGB length");
  assertEqual(mod.lightdata[70 * 3], 10, message + ": red");
  assertEqual(mod.lightdata[70 * 3 + 1], 20, message + ": green");
  assertEqual(mod.lightdata[70 * 3 + 2], 70, message + ": blue");
  assertEqual(mod.surfaces[1].sampleOffset, 64 * 3, message + ": lightofs*3");
  assertEqual(mod.surfaces[1].rgbsamples, true, message + ": rgbsamples");
}

function assertMono(mod, message) {
  assertEqual(mod.litfile, false, message + ": litfile");
  assertEqual(mod.lightdata.length, LIGHT_LEN, message + ": mono length");
  assertEqual(mod.lightdata[70], 70, message + ": mono sample");
  assertEqual(mod.surfaces[1].sampleOffset, 64, message + ": lightofs");
}

Deno.test("RGBLIGHTING is used as RGB lightdata when there is no .lit", () => {
  assertRgb(
    loadBytes(mapWith([["RGBLIGHTING", rgbLighting(LIGHT_LEN)]])),
    "BSP29",
  );
  assertRgb(
    loadBytes(mapWith([["RGBLIGHTING", rgbLighting(LIGHT_LEN)]], {
      bsp2: true,
    })),
    "BSP2",
  );
  assertRgb(
    loadBytes(mapWith([["RGBLIGHTING", rgbLighting(LIGHT_LEN)]], {
      bsp2: "2psb",
    })),
    "2PSB",
  );
});

Deno.test("RGBLIGHTING is found among unknown lumps, which are ignored", () => {
  const mod = loadBytes(mapWith([
    ["LMSHIFT", new Uint8Array(2)],
    ["SOMETHING_NEW", new Uint8Array(13)],
    ["RGBLIGHTING", rgbLighting(LIGHT_LEN)],
    ["LIGHTING_E5BGR9", new Uint8Array(LIGHT_LEN * 4)],
  ]));
  assertRgb(mod, "mixed table");
});

Deno.test("a good .lit wins over RGBLIGHTING (Quakespasm-Spiked order)", () => {
  const lit = new Uint8Array(8 + LIGHT_LEN * 3);
  lit.set(new TextEncoder().encode("QLIT"), 0);
  lit[4] = 1;
  lit.fill(99, 8);
  const mod = loadBytes(
    mapWith([["RGBLIGHTING", rgbLighting(LIGHT_LEN)]]),
    lit,
  );
  assertEqual(mod.litfile, true, "litfile");
  assertEqual(mod.lightdata[70 * 3], 99, ".lit red");
});

Deno.test("RGBLIGHTING of the wrong size is ignored for the mono lump", () => {
  assertMono(
    loadBytes(mapWith([["RGBLIGHTING", rgbLighting(LIGHT_LEN - 1)]])),
    "short",
  );
  assertMono(
    loadBytes(mapWith([["RGBLIGHTING", new Uint8Array(0)]])),
    "empty",
  );
});

Deno.test("RGBLIGHTING is the only lighting when the mono lump is empty", () => {
  const mod = loadBytes(
    mapWith([["RGBLIGHTING", rgbLighting(LIGHT_LEN)]], { mono: false }),
  );
  assertRgb(mod, "no mono lump");
});

Deno.test("a bad BSPX table is ignored and the map still loads", () => {
  const good = mapWith([["RGBLIGHTING", rgbLighting(LIGHT_LEN)]]);
  const view = new DataView(good.buffer);
  let tableAt = -1; // the table's "BSPX"
  for (let i = 0; i + 4 <= good.length && tableAt < 0; i += 4) {
    if (
      good[i] === 0x42 && good[i + 1] === 0x53 && good[i + 2] === 0x50 &&
      good[i + 3] === 0x58
    ) tableAt = i;
  }

  const badMagic = good.slice();
  badMagic[tableAt + 3] = 0x59; // "BSPY"
  assertMono(loadBytes(badMagic), "bad magic");

  const negCount = good.slice();
  new DataView(negCount.buffer).setInt32(tableAt + 4, -1, true);
  assertMono(loadBytes(negCount), "negative count");

  const hugeCount = good.slice();
  new DataView(hugeCount.buffer).setInt32(tableAt + 4, 1 << 20, true);
  assertMono(loadBytes(hugeCount), "count past the end of the file");

  const pastEnd = good.slice();
  new DataView(pastEnd.buffer).setInt32(
    tableAt + 8 + 28,
    view.getInt32(tableAt + 8 + 28, true) + 4096,
    true,
  );
  assertMono(loadBytes(pastEnd), "lump past the end of the file");

  const negOfs = good.slice();
  new DataView(negOfs.buffer).setInt32(tableAt + 8 + 24, -4, true);
  assertMono(loadBytes(negOfs), "negative lump offset");

  // a table cut off after its magic
  const cut = good.slice(0, tableAt + 6);
  assertMono(loadBytes(cut), "truncated table");
});

Deno.test("a BSP without a BSPX table, or with an empty one, loads as before", () => {
  assertMono(loadBytes(mapWith([])), "no table");
  const map = smallMap();
  map.lighting = monoLighting();
  const plain = writeMap(false, map);
  // an empty table: "BSPX" and a zero count after the lumps
  const empty = new Uint8Array(plain.length + 8);
  empty.set(plain, 0);
  empty.set(new TextEncoder().encode("BSPX"), plain.length);
  assertMono(loadBytes(empty), "empty table");
});

Deno.test("a dedicated server does not read RGBLIGHTING", () => {
  const oldState = cls.state;
  try {
    cls.state = ca_dedicated;
    assertMono(
      loadBytes(mapWith([["RGBLIGHTING", rgbLighting(LIGHT_LEN)]])),
      "dedicated",
    );
  } finally {
    cls.state = oldState;
  }
});
