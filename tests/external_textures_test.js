// External textures (QuakeSpasm gl_model.c Mod_LoadTextures; QSS external
// alias skins): the search order, the _glow and _luma fullbright layers, the
// in-place install, and no request for a texture without a replacement.
// Every map, model and image here is synthetic: commercial data must never
// be committed.

// Bootstrap the renderer's existing circular module graph in its safe order.
await import("../src/gl_rsurf.js");

const gl_model = await import("../src/gl_model.js");
const upload = await import("../src/gl_model_upload.js");
const { Image_FindExternal } = await import("../src/image.js");
const { COM_AddPack } = await import("../src/pak.js");
const { vid } = await import("../src/vid.js");
const { writeMap, smallMap } = await import("./synthetic_bsp.js");

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

// A top-down 32-bit targa of width x height, every texel rgba
function tga(width, height, rgba) {
  const bytes = new Uint8Array(18 + width * height * 4);
  bytes[2] = 2; // truecolor
  bytes[12] = width;
  bytes[14] = height;
  bytes[16] = 32;
  bytes[17] = 0x28; // top-left origin, 8 alpha bits
  for (let i = 0; i < width * height; i++) {
    bytes.set([rgba[2], rgba[1], rgba[0], rgba[3]], 18 + i * 4);
  }
  return bytes;
}

// Adds [ name, Uint8Array ] entries as one pack read whole
function addFiles(entries) {
  let size = 0;
  for (const [, body] of entries) size += body.length;
  const data = new Uint8Array(size);
  const files = [];
  let pos = 0;
  for (const [name, body] of entries) {
    data.set(body, pos);
    files.push({ name: name, filepos: pos, filelen: body.length });
    pos += body.length;
  }
  COM_AddPack({ files: files, data: data.buffer });
}

// Adds a pack whose entries are read one at a time, as a lazily opened pak
// in the browser; returns the log of reads
function addLazyFiles(entries) {
  const reads = [];
  const files = [];
  let pos = 0;
  for (const [name, body] of entries) {
    files.push({ name: name, filepos: pos, filelen: body.length, data: null });
    pos += body.length;
  }
  COM_AddPack({
    filename: "lazy.pak",
    files: files,
    data: null,
    reader: {
      read: (filepos) => {
        const i = files.findIndex((f) => f.filepos === filepos);
        reads.push(files[i].name);
        return Promise.resolve(entries[i][1]);
      },
      readSync: null,
    },
  });
  return reads;
}

let serial = 0;

// smallMap with the given texture names, face 0 on the first. Returns the
// map's base name; the caller adds its images first, then loads it.
function mapWithTextures(names) {
  const map = smallMap();
  map.texinfo = names.length;
  map.textures = names.map((name) => ({ name: name, flags: 0 }));
  return { base: "__ext_" + (serial++), map: map };
}

function loadMap(base, map) {
  const name = "maps/" + base + ".bsp";
  const bytes = writeMap(false, map);
  addFiles([[name, bytes]]);
  const oldFullbright = vid.fullbright;
  try {
    vid.fullbright = 224; // VID_SetPalette's value; tests never run it
    return gl_model.Mod_ForName(name, true);
  } finally {
    vid.fullbright = oldFullbright;
  }
}

function textureNamed(mod, name) {
  return mod.textures.find((t) => t !== null && t.name === name);
}

const RED = [255, 0, 0, 255];
const GREEN = [0, 255, 0, 255];
const BLUE = [0, 0, 255, 255];
const GLOW = [200, 100, 50, 255];

Deno.test("Image_FindExternal takes png, then tga, then jpg (Ironwail)", () => {
  addFiles([
    ["textures/__order_a.jpg", new Uint8Array(4)],
    ["textures/__order_a.tga", new Uint8Array(4)],
    ["textures/__order_a.png", new Uint8Array(4)],
    ["textures/__order_b.jpg", new Uint8Array(4)],
    ["textures/__order_b.tga", new Uint8Array(4)],
    ["textures/__order_c.jpg", new Uint8Array(4)],
  ]);
  assertEqual(
    Image_FindExternal("textures/__order_a"),
    "textures/__order_a.png",
    "png",
  );
  assertEqual(
    Image_FindExternal("textures/__order_b"),
    "textures/__order_b.tga",
    "tga",
  );
  assertEqual(
    Image_FindExternal("TEXTURES/__Order_C"),
    "TEXTURES/__Order_C.jpg",
    "jpg, any case",
  );
  assertEqual(Image_FindExternal("textures/__order_d"), null, "none");
});

Deno.test("a world texture is replaced from textures/<map>/ before textures/", async () => {
  const { base, map } = mapWithTextures(["__wall", "__floor", "__plain"]);
  addFiles([
    ["textures/" + base + "/__wall.tga", tga(4, 2, RED)],
    ["textures/__wall.tga", tga(2, 2, GREEN)],
    ["textures/__floor.tga", tga(2, 4, BLUE)],
  ]);
  const mod = loadMap(base, map);
  const wall = textureNamed(mod, "__wall");
  const floor = textureNamed(mod, "__floor");
  const plain = textureNamed(mod, "__plain");
  const wallTexture = wall.gl_texture;
  const plainImage = plain.gl_texture.image;
  assertEqual(wallTexture.image.width, 16, "8-bit until the image arrives");

  await upload.GL_WaitExternalTextures();
  assertEqual(wall.gl_texture, wallTexture, "the same texture object");
  assertEqual(wallTexture.image.width, 4, "textures/<map>/ width");
  assertEqual(wallTexture.image.height, 2, "textures/<map>/ height");
  assertEqual(wallTexture.image.data[0], 255, "textures/<map>/ red");
  assertEqual(wallTexture.needsUpdate, true, "uploaded again");
  assertEqual(floor.gl_texture.image.height, 4, "textures/ height");
  assertEqual(floor.gl_texture.image.data[2], 255, "textures/ blue");
  assertEqual(plain.gl_texture.image, plainImage, "no replacement");
  // texture coordinates are normalised by the miptex size
  assertEqual(wall.width, 16, "miptex width kept");
});

Deno.test("the found image's _glow, else _luma, is the fullbright layer", async () => {
  const { base, map } = mapWithTextures(["__glow", "__luma", "__noglow"]);
  addFiles([
    ["textures/__glow.tga", tga(2, 2, RED)],
    ["textures/__glow_glow.png", new Uint8Array(4)], // png before tga
    ["textures/__glow_glow.tga", tga(2, 2, BLUE)],
    ["textures/__glow_luma.tga", tga(2, 2, GREEN)],
    ["textures/" + base + "/__luma.tga", tga(2, 2, RED)],
    // beside the found image only: not the textures/ one
    ["textures/__luma_glow.tga", tga(2, 2, BLUE)],
    ["textures/" + base + "/__luma_luma.tga", tga(2, 2, GLOW)],
    ["textures/__noglow.tga", tga(2, 2, RED)],
  ]);
  const mod = loadMap(base, map);
  const glow = textureNamed(mod, "__glow").gl_texture;
  const luma = textureNamed(mod, "__luma").gl_texture;
  const noglow = textureNamed(mod, "__noglow").gl_texture;
  // the 8-bit pixels (all 0) have no fullbrights: a blank layer for the glow
  if (glow._fullbright === undefined) throw new Error("no fullbright layer");
  assertEqual(glow._fullbright.image.data[3], 255, "blank layer is black");
  assertEqual(noglow._fullbright, undefined, "no glow, no layer");

  await upload.GL_WaitExternalTextures();
  // __glow_glow.png doesn't decode under Deno: the image stays, the layer
  // goes blank
  assertEqual(glow.image.data[0], 255, "base loaded");
  assertEqual(glow._fullbright.image.width, 1, "undecodable glow");
  assertEqual(luma._fullbright.image.data[0], 200, "_luma red");
  assertEqual(luma._fullbright.image.data[2], 50, "_luma blue");
  assertEqual(luma._fullbright.image.width, 2, "_luma width");
});

Deno.test("an external image drops the 8-bit fullbrights", async () => {
  const { base, map } = mapWithTextures(["__bright"]);
  addFiles([["textures/__bright.tga", tga(2, 2, RED)]]);
  const oldFullbright = vid.fullbright;
  let mod;
  try {
    // every texel (index 0) counts as fullbright
    vid.fullbright = 0;
    const bytes = writeMap(false, map);
    addFiles([["maps/" + base + ".bsp", bytes]]);
    mod = gl_model.Mod_ForName("maps/" + base + ".bsp", true);
  } finally {
    vid.fullbright = oldFullbright;
  }
  const texture = textureNamed(mod, "__bright").gl_texture;
  const fullbright = texture._fullbright;
  if (fullbright === undefined) throw new Error("no 8-bit fullbrights");

  await upload.GL_WaitExternalTextures();
  assertEqual(texture._fullbright, fullbright, "the same layer object");
  assertEqual(fullbright.image.width, 1, "blank");
  assertEqual(fullbright.image.data[0], 0, "black");
});

Deno.test("a liquid is looked for as #name, with no fullbright layer", async () => {
  const { base, map } = mapWithTextures(["*__lava", "!__slime"]);
  addFiles([
    ["textures/#__lava.tga", tga(2, 2, RED)],
    ["textures/#__lava_glow.tga", tga(2, 2, BLUE)],
    ["textures/" + base + "/#__slime.tga", tga(2, 2, GREEN)],
  ]);
  const mod = loadMap(base, map);
  const lava = textureNamed(mod, "*__lava").gl_texture;
  const slime = textureNamed(mod, "!__slime").gl_texture;

  await upload.GL_WaitExternalTextures();
  assertEqual(lava.image.data[0], 255, "*name as #name");
  assertEqual(lava._fullbright, undefined, "no glow for liquids");
  assertEqual(slime.image.data[1], 255, "!name, map directory");
});

// Runs fn, logging every loose-file request: fetch in the browser,
// Deno.readFile under Deno (pak.js COM_PreloadLooseFile)
async function withRequestLog(fn) {
  const realFetch = globalThis.fetch;
  const realReadFile = Deno.readFile;
  const requests = [];
  globalThis.fetch = (url) => {
    requests.push(String(url));
    return Promise.resolve(new Response("missing", { status: 404 }));
  };
  Deno.readFile = (path) => {
    requests.push(String(path));
    return Promise.reject(new Deno.errors.NotFound(String(path)));
  };
  try {
    await fn();
  } finally {
    globalThis.fetch = realFetch;
    Deno.readFile = realReadFile;
  }
  return requests;
}

Deno.test("a texture without a replacement costs no request", async () => {
  const requests = await withRequestLog(async () => {
    const { base, map } = mapWithTextures(["__none_a", "*__none_b"]);
    loadMap(base, map);
    await upload.GL_WaitExternalTextures();
  });
  assertEqual(requests.length, 0, "requests: " + requests.join(", "));
});

Deno.test("a replacement in a lazily opened pak is read from the pak", async () => {
  let texture;
  let reads;
  const requests = await withRequestLog(async () => {
    const { base, map } = mapWithTextures(["__lazy"]);
    reads = addLazyFiles([["textures/__lazy.tga", tga(2, 2, BLUE)]]);
    texture = textureNamed(loadMap(base, map), "__lazy").gl_texture;
    await upload.GL_WaitExternalTextures();
  });
  assertEqual(texture.image.data[2], 255, "installed");
  assertEqual(reads.join(), "textures/__lazy.tga", "read from the pak");
  assertEqual(requests.length, 0, "no loose-file request");
});

Deno.test("an image arriving after its model was freed is dropped", async () => {
  const { base, map } = mapWithTextures(["__freed"]);
  addFiles([["textures/__freed.tga", tga(2, 2, RED)]]);
  const mod = loadMap(base, map);
  const texture = textureNamed(mod, "__freed").gl_texture;
  const image = texture.image;
  mod._threeTextures.delete(texture); // as Mod_ClearAll does
  await upload.GL_WaitExternalTextures();
  assertEqual(texture.image, image, "not installed");
});

// A one-frame, one-triangle MDL with a single 8x8 skin (as in
// alias_fullbright_test.js)
function buildMdl(skin) {
  const numverts = 3;
  const size = 84 + 4 + 64 + numverts * 12 + 16 + 4 + 24 + numverts * 4;
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, gl_model.IDPOLYHEADER, true);
  view.setInt32(4, gl_model.ALIAS_VERSION, true);
  for (let i = 0; i < 3; i++) view.setFloat32(8 + i * 4, 1, true); // scale
  view.setInt32(48, 1, true); // numskins
  view.setInt32(52, 8, true); // skinwidth
  view.setInt32(56, 8, true); // skinheight
  view.setInt32(60, numverts, true);
  view.setInt32(64, 1, true); // numtris
  view.setInt32(68, 1, true); // numframes
  view.setFloat32(80, 1, true); // size

  let pos = 84 + 4; // ALIAS_SKIN_SINGLE
  bytes.set(skin, pos);
  pos += 64;
  for (let i = 0; i < numverts; i++, pos += 12) {
    view.setInt32(pos + 4, i * 2, true);
    view.setInt32(pos + 8, i, true);
  }

  view.setInt32(pos, 1, true); // facesfront
  for (let j = 0; j < 3; j++) view.setInt32(pos + 4 + j * 4, j, true);
  pos += 16;
  view.setInt32(pos, gl_model.ALIAS_SINGLE, true);
  pos += 4 + 24;
  bytes[pos + 4] = 4;
  bytes[pos + 9] = 4;
  return bytes;
}

function loadMdl(name, skin) {
  addFiles([[name, buildMdl(skin)]]);
  const oldFullbright = vid.fullbright;
  try {
    vid.fullbright = 224;
    return gl_model.Mod_Extradata(gl_model.Mod_ForName(name, true));
  } finally {
    vid.fullbright = oldFullbright;
  }
}

Deno.test("an alias skin is replaced by <model>_<skin> (QSS), its glow as a mask", async () => {
  const name = "progs/__ext_" + (serial++) + ".mdl";
  const skin = new Uint8Array(64).fill(15);
  skin[9] = 250; // a fullbright texel
  addFiles([
    [name + "_0.tga", tga(4, 4, RED)],
    [name + "_0_luma.tga", tga(4, 4, [100, 40, 200, 255])],
  ]);
  const hdr = loadMdl(name, skin);
  const texture = hdr.gl_texturenum[0][0];
  const mask = texture._fullbright;
  if (mask === undefined) throw new Error("no fullbright mask");

  await upload.GL_WaitExternalTextures();
  assertEqual(texture.image.width, 4, "skin replaced");
  assertEqual(hdr.gl_texturenum[0][3], texture, "every frame slot");
  assertEqual(texture._fullbright, mask, "the same mask object");
  assertEqual(mask.image.width, 4, "the _luma image");
  assertEqual(mask.image.data[3], 200, "alpha: the brightest channel");
  assertEqual(mask.image.data[0], 0, "the mask's colour is unused");
});

Deno.test("an alias skin without a glow image loses its 8-bit fullbrights", async () => {
  const name = "progs/__ext_" + (serial++) + ".mdl";
  const skin = new Uint8Array(64).fill(15);
  skin[9] = 250;
  addFiles([[name + "_0.tga", tga(4, 4, RED)]]);
  const texture = loadMdl(name, skin).gl_texturenum[0][0];

  await upload.GL_WaitExternalTextures();
  assertEqual(texture._fullbright.image.width, 1, "blank mask");
  assertEqual(texture._fullbright.image.data[3], 0, "transparent");
});

Deno.test("GL_GlowMask scales the brightest channel by the glow's alpha", () => {
  const mask = upload.GL_GlowMask(
    new Uint8Array([0, 0, 0, 255, 10, 255, 20, 255, 255, 0, 0, 128]),
  );
  assertEqual(mask[3], 0, "black");
  assertEqual(mask[7], 255, "bright");
  assertEqual(mask[11], 128, "half transparent");
});
