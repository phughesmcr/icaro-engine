// Tests for src/image.js (QuakeSpasm Image_LoadTGA) and src/gl_sky.js
// (Ironwail skyboxes): targa decoding, the worldspawn "sky" key and loading
// the six faces. Every image here is synthetic: commercial data must never be
// committed.

import { Image_LoadImage, Image_LoadTGA } from "../src/image.js";
import {
  cubemap_order,
  Sky_ClearAll,
  Sky_GetSkyBox,
  Sky_LoadSkyBox,
  Sky_LoadSkyBoxFaces,
  Sky_NewMap,
  Sky_SkyCommand_f,
} from "../src/gl_sky.js";
import { COM_AddPack } from "../src/pak.js";
import { Con_SetPrintFunctions } from "../src/common.js";
import { Cmd_TokenizeString } from "../src/cmd.js";

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

function assertPixels(image, expected, message) {
  assertEqual(image.data.length, expected.length, message + " length");
  for (let i = 0; i < expected.length; i++) {
    assertEqual(image.data[i], expected[i], message + " byte " + i);
  }
}

// An 18-byte targa header followed by an optional image ID and the data
function tga(
  { type, width, height, bpp, attributes = 0, id = [], colormap = null, body },
) {
  const header = new Uint8Array(18);
  header[0] = id.length;
  if (colormap !== null) {
    header[1] = 1;
    header[5] = colormap.entries & 0xff;
    header[6] = colormap.entries >> 8;
    header[7] = colormap.size;
  }

  header[2] = type;
  header[12] = width & 0xff;
  header[13] = width >> 8;
  header[14] = height & 0xff;
  header[15] = height >> 8;
  header[16] = bpp;
  header[17] = attributes;
  return new Uint8Array([...header, ...id, ...body]);
}

// ----------------------------------------------------------------------------
// Image_LoadTGA
// ----------------------------------------------------------------------------

Deno.test("Image_LoadTGA flips a bottom-up 24-bit targa and swaps BGR", () => {
  // 2x2, bottom row first: bottom = red, green; top = blue, white
  const image = Image_LoadTGA(
    tga({
      type: 2,
      width: 2,
      height: 2,
      bpp: 24,
      body: [
        0,
        0,
        255,
        0,
        255,
        0,
        255,
        0,
        0,
        255,
        255,
        255,
      ],
    }),
  );
  assertEqual(image.width, 2, "width");
  assertEqual(image.height, 2, "height");
  assertPixels(image, [
    0,
    0,
    255,
    255,
    255,
    255,
    255,
    255,
    255,
    0,
    0,
    255,
    0,
    255,
    0,
    255,
  ], "pixels");
});

Deno.test("Image_LoadTGA keeps a top-down 32-bit targa and skips the image ID", () => {
  const image = Image_LoadTGA(
    tga({
      type: 2,
      width: 2,
      height: 1,
      bpp: 32,
      attributes: 0x28,
      id: [9, 9, 9],
      body: [
        1,
        2,
        3,
        4,
        5,
        6,
        7,
        8,
      ],
    }),
  );
  assertPixels(image, [3, 2, 1, 4, 7, 6, 5, 8], "pixels");
});

Deno.test("Image_LoadTGA decodes run-length packets that cross rows", () => {
  // 3x2 top-down, 24-bit: a run of 4 (crosses into row 2), then 2 raw pixels
  const image = Image_LoadTGA(
    tga({
      type: 10,
      width: 3,
      height: 2,
      bpp: 24,
      attributes: 0x20,
      body: [
        0x83,
        10,
        20,
        30,
        0x01,
        1,
        2,
        3,
        4,
        5,
        6,
      ],
    }),
  );
  assertPixels(image, [
    30,
    20,
    10,
    255,
    30,
    20,
    10,
    255,
    30,
    20,
    10,
    255,
    30,
    20,
    10,
    255,
    3,
    2,
    1,
    255,
    6,
    5,
    4,
    255,
  ], "pixels");

  // the same bottom-up, 32-bit: the first packets fill the bottom row
  const up = Image_LoadTGA(tga({
    type: 10,
    width: 3,
    height: 2,
    bpp: 32,
    body: [
      0x01,
      1,
      2,
      3,
      40,
      4,
      5,
      6,
      50,
      0x83,
      10,
      20,
      30,
      60,
    ],
  }));
  assertPixels(up, [
    30,
    20,
    10,
    60,
    30,
    20,
    10,
    60,
    30,
    20,
    10,
    60,
    3,
    2,
    1,
    40,
    6,
    5,
    4,
    50,
    30,
    20,
    10,
    60,
  ], "bottom-up pixels");
});

Deno.test("Image_LoadTGA reads grayscale and paletted targas", () => {
  const gray = Image_LoadTGA(
    tga({
      type: 3,
      width: 2,
      height: 1,
      bpp: 8,
      attributes: 0x20,
      body: [7, 200],
    }),
  );
  assertPixels(gray, [7, 7, 7, 255, 200, 200, 200, 255], "grayscale");

  const paletted = Image_LoadTGA(
    tga({
      type: 1,
      width: 2,
      height: 1,
      bpp: 8,
      attributes: 0x20,
      colormap: { entries: 2, size: 24 },
      body: [1, 2, 3, 4, 5, 6, 1, 0],
    }),
  );
  assertPixels(paletted, [6, 5, 4, 255, 3, 2, 1, 255], "paletted");
});

Deno.test("Image_LoadTGA refuses unsupported targas without ending the game", () => {
  assertEqual(
    Image_LoadTGA(tga({ type: 9, width: 1, height: 1, bpp: 8, body: [0] })),
    null,
    "RLE paletted",
  );
  assertEqual(
    Image_LoadTGA(tga({ type: 2, width: 1, height: 1, bpp: 16, body: [0, 0] })),
    null,
    "16-bit",
  );
  assertEqual(Image_LoadTGA(new Uint8Array(4)), null, "truncated header");
});

// ----------------------------------------------------------------------------
// Skyboxes
// ----------------------------------------------------------------------------

const SUF = ["rt", "bk", "lf", "ft", "up", "dn"];

// Adds gfx/env/<name><suf>.tga faces, each one size x size and filled with
// its suffix index as the red channel, to an in-memory pak
function addSkyBox(name, size, { skip = [], sizes = {} } = {}) {
  const files = [];
  const blobs = [];
  let pos = 0;
  for (let i = 0; i < 6; i++) {
    if (skip.includes(SUF[i])) continue;
    const w = sizes[SUF[i]] !== undefined ? sizes[SUF[i]] : size;
    const body = [];
    for (let p = 0; p < w * size; p++) body.push(0, 0, i + 1); // BGR
    const bytes = tga({
      type: 2,
      width: w,
      height: size,
      bpp: 24,
      attributes: 0x20,
      body,
    });
    files.push({
      name: "gfx/env/" + name + SUF[i] + ".tga",
      filepos: pos,
      filelen: bytes.length,
    });
    blobs.push(bytes);
    pos += bytes.length;
  }

  const data = new Uint8Array(pos);
  let o = 0;
  for (const b of blobs) {
    data.set(b, o);
    o += b.length;
  }

  COM_AddPack({ files, data: data.buffer });
}

function worldspawn(keys) {
  return '{\n"classname" "worldspawn"\n' + keys +
    '\n}\n{\n"classname" "info_null"\n"sky" "__test_other_"\n}\n';
}

addSkyBox("__test_a/a_", 2);
addSkyBox("__test_b/b_", 2, { skip: ["up"] });
addSkyBox("__test_c/c_", 2, { sizes: { lf: 1 } });

Deno.test("Image_LoadImage loads name.tga from the search path", () => {
  const image = Image_LoadImage("gfx/env/__test_a/a_ft");
  assertEqual(image.width, 2, "width");
  assertEqual(image.data[0], 4, "ft red");
  assertEqual(Image_LoadImage("gfx/env/__test_a/a_none"), null, "missing");
});

Deno.test("Sky_LoadSkyBoxFaces orders the faces ft bk up dn rt lf", () => {
  const loaded = Sky_LoadSkyBoxFaces("__test_a/a_");
  assertEqual(loaded.size, 2, "size");
  const names = ["ft", "bk", "up", "dn", "rt", "lf"];
  for (let i = 0; i < 6; i++) {
    assertEqual(cubemap_order[i], SUF.indexOf(names[i]), "cubemap_order " + i);
    assertEqual(
      loaded.faces[i][0],
      SUF.indexOf(names[i]) + 1,
      "face " + names[i],
    );
  }

  // a missing face is null (drawn black); none at all, or mixed sizes, give
  // the scrolling sky
  const partial = Sky_LoadSkyBoxFaces("__test_b/b_");
  assertEqual(partial.faces[2], null, "missing up face");
  assertEqual(partial.faces[0][0], 4, "ft still loaded");
  assertEqual(Sky_LoadSkyBoxFaces("__test_none/n_"), null, "no faces");
  assertEqual(Sky_LoadSkyBoxFaces("__test_c/c_"), null, "mixed sizes");
});

Deno.test("Sky_NewMap loads the worldspawn _sky box and resets without one", async () => {
  try {
    await Sky_NewMap(worldspawn('"_sky" "__test_a/a_"'));
    const sky = Sky_GetSkyBox();
    if (sky === null) throw new Error("_sky: expected a skybox");
    assertEqual(sky.name, "__test_a/a_", "name");
    const images = sky.cubemap.image;
    assertEqual(images.length, 6, "cubemap faces");
    assertEqual(images[0].image.data[0], 4, "+X is ft");
    assertEqual(images[4].image.data[0], 1, "+Z is rt");

    // the same box on the next map is reused
    await Sky_NewMap(worldspawn('"sky " "__test_a/a_"'));
    assertEqual(
      Sky_GetSkyBox(),
      sky,
      'reused for "sky " with a trailing space',
    );

    // no key: the scrolling sky. The info_null's "sky" is not worldspawn's.
    await Sky_NewMap(worldspawn('"wad" "gfx.wad"'));
    assertEqual(Sky_GetSkyBox(), null, "no sky key");

    await Sky_NewMap(worldspawn('"skyname" "__test_a/a_"'));
    assertEqual(Sky_GetSkyBox() !== null, true, "skyname");
    await Sky_NewMap(worldspawn('"qlsky" "__test_none/n_"'));
    assertEqual(Sky_GetSkyBox(), null, "qlsky with no faces");
    await Sky_NewMap(null);
    assertEqual(Sky_GetSkyBox(), null, "no entities");
  } finally {
    Sky_ClearAll();
  }
});

Deno.test("Sky_NewMap drops a box whose faces arrive after the next map loaded", async () => {
  try {
    const pending = Sky_NewMap(worldspawn('"sky" "__test_b/b_"'));
    await Sky_NewMap(worldspawn(""));
    await pending;
    assertEqual(Sky_GetSkyBox(), null, "stale box installed");

    // the sky command, and "" turning the box off
    await Sky_LoadSkyBox("__test_b/b_");
    assertEqual(Sky_GetSkyBox().name, "__test_b/b_", "loaded");
    await Sky_LoadSkyBox("");
    assertEqual(Sky_GetSkyBox(), null, "off");
  } finally {
    Sky_ClearAll();
  }
});

Deno.test("Sky_NewMap frees the cached box when the next map uses another one", async () => {
  try {
    await Sky_NewMap(worldspawn('"sky" "__test_a/a_"'));
    const first = Sky_GetSkyBox();
    let disposed = 0;
    first.cubemap.dispose = () => disposed++;

    // turning the box off keeps it cached, and asking again reuses it
    await Sky_LoadSkyBox("");
    await Sky_LoadSkyBox("__test_a/a_");
    assertEqual(Sky_GetSkyBox(), first, 'reused after sky ""');
    assertEqual(disposed, 0, "disposed while cached");

    await Sky_NewMap(worldspawn('"sky" "__test_b/b_"'));
    assertEqual(disposed, 1, "old box disposed for another box");
    const second = Sky_GetSkyBox();
    second.cubemap.dispose = () => disposed++;
    await Sky_NewMap(worldspawn(""));
    assertEqual(disposed, 2, "old box disposed for no box");
  } finally {
    Sky_ClearAll();
  }
});

// The sky command doesn't return its fetch: the faces are already in the
// pak, so it settles within one macrotask
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

Deno.test("The sky command reports, loads, and retries a box that failed", async () => {
  const printed = [];
  Con_SetPrintFunctions((fmt) => printed.push(fmt), () => {});
  try {
    Cmd_TokenizeString("sky __test_none/n_");
    Sky_SkyCommand_f();
    await settle(); // the command's fetch
    assertEqual(Sky_GetSkyBox(), null, "no faces");

    // a failed load clears the name, so the query shows "" and asking again retries
    printed.length = 0;
    Cmd_TokenizeString("sky");
    Sky_SkyCommand_f();
    assertEqual(printed.join(""), '"sky" is ""\n', "query after failure");

    Cmd_TokenizeString("sky __test_a/a_");
    Sky_SkyCommand_f();
    await settle();
    assertEqual(Sky_GetSkyBox().name, "__test_a/a_", "loaded by the command");

    printed.length = 0;
    Cmd_TokenizeString("sky");
    Sky_SkyCommand_f();
    assertEqual(printed.join(""), '"sky" is "__test_a/a_"\n', "query");

    printed.length = 0;
    Cmd_TokenizeString("sky a b");
    Sky_SkyCommand_f();
    assertEqual(printed.join(""), "usage: sky <skyname>\n", "usage");
  } finally {
    Con_SetPrintFunctions(null, null);
    Sky_ClearAll();
  }
});
