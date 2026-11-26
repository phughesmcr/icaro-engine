// Fence ('{') textures (QuakeSpasm/Ironwail, from ericw): Mod_LoadTextures
// loads a world texture whose name starts with '{' with TEXPREF_ALPHA, so
// palette index 255 is transparent, TexMgr_AlphaEdgeFix recolours those texels,
// and the world and brush materials alpha-test it at 0.666. Other textures
// load as before.

// Bootstrap the renderer's existing circular module graph in its safe order.
const gl_rsurf = await import("../src/gl_rsurf.js");
const gl_model = await import("../src/gl_model.js");
const bspfile = await import("../src/bspfile.js");
const { COM_AddPack } = await import("../src/pak.js");
const { d_8to24table, vid } = await import("../src/vid.js");

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

function buildBsp(lumps) {
  const header = 4 + bspfile.HEADER_LUMPS * 8;
  let size = header;
  for (let i = 0; i < bspfile.HEADER_LUMPS; i++) {
    size += (lumps[i] !== undefined) ? (lumps[i].length + 3) & ~3 : 0;
  }

  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  view.setInt32(0, bspfile.BSPVERSION, true);

  let ofs = header;
  for (let i = 0; i < bspfile.HEADER_LUMPS; i++) {
    const lump = lumps[i];
    const len = lump !== undefined ? lump.length : 0;
    view.setInt32(4 + i * 8, len > 0 ? ofs : 0, true);
    view.setInt32(4 + i * 8 + 4, len, true);
    if (len > 0) {
      bytes.set(lump, ofs);
      ofs += (len + 3) & ~3;
    }
  }

  return bytes;
}

function lump(size, fill) {
  const out = new Uint8Array(size);
  fill(new DataView(out.buffer), out);
  return out;
}

const SIZE = 16;
const PIXELS = SIZE * SIZE / 64 * 85; // all four mip levels
const MIPTEX = 40;

// A 16 x 16 texture of index 10 with: index 255 at (1, 1), next to a
// fullbright texel (index 240) at (1, 2); and index 255 at (15, 15), whose
// neighbours wrap round both edges.
function fencePixels(transparent) {
  const p = new Uint8Array(PIXELS).fill(10);
  p[SIZE + 1] = transparent;
  p[SIZE + 2] = 240;
  p[SIZE * SIZE - 1] = transparent;
  return p;
}

// One empty leaf and a miptex for each { name, pixels }.
function texturesBsp(textures) {
  const lumps = [];
  lumps[bspfile.LUMP_PLANES] = lump(20, (v) => v.setFloat32(0, 1, true));
  lumps[bspfile.LUMP_LEAFS] = lump(2 * 28, (v) => {
    v.setInt32(0, bspfile.CONTENTS_SOLID, true);
    v.setInt32(4, -1, true);
    v.setInt32(28, bspfile.CONTENTS_EMPTY, true);
    v.setInt32(32, -1, true);
  });
  lumps[bspfile.LUMP_NODES] = lump(24, (v) => {
    v.setUint16(4, 0xffff, true);
    v.setUint16(6, 0xfffe, true);
  });
  lumps[bspfile.LUMP_CLIPNODES] = lump(8, (v) => {
    v.setUint16(4, 0xffff, true);
    v.setUint16(6, 0xfffe, true);
  });
  lumps[bspfile.LUMP_MODELS] = lump(64, (v) => {
    for (let j = 0; j < 3; j++) {
      v.setFloat32(j * 4, -64, true);
      v.setFloat32(12 + j * 4, 64, true);
    }

    v.setInt32(52, 1, true); // visleafs
  });
  // dmiptexlump_t: nummiptex, dataofs[ n ], then each miptex_t and its pixels
  const n = textures.length;
  const head = 4 + n * 4;
  lumps[bspfile.LUMP_TEXTURES] = lump(
    head + n * (MIPTEX + PIXELS),
    (v, bytes) => {
      v.setInt32(0, n, true);
      for (let t = 0; t < n; t++) {
        const ofs = head + t * (MIPTEX + PIXELS);
        v.setInt32(4 + t * 4, ofs, true);
        const name = textures[t].name;
        for (let i = 0; i < name.length; i++) {
          v.setUint8(ofs + i, name.charCodeAt(i));
        }
        v.setUint32(ofs + 16, SIZE, true);
        v.setUint32(ofs + 20, SIZE, true);
        let mip = MIPTEX;
        for (let m = 0; m < 4; m++) {
          v.setUint32(ofs + 24 + m * 4, mip, true);
          mip += (SIZE >> m) * (SIZE >> m);
        }
        bytes.set(textures[t].pixels, ofs + MIPTEX);
      }
    },
  );
  return buildBsp(lumps);
}

let serial = 0;

function loadTextures(textures) {
  const bytes = texturesBsp(textures);
  const name = "maps/__fence_" + (serial++) + ".bsp";
  COM_AddPack({
    files: [{ name: name, filepos: 0, filelen: bytes.length }],
    data: bytes.buffer,
  });
  const mod = gl_model.Mod_ForName(name, true);
  const byName = new Map();
  for (let i = 0; i < mod.numtextures; i++) {
    const t = mod.textures[i];
    if (t !== null && t !== undefined) byName.set(t.name, t);
  }
  return byName;
}

// A palette where every entry has its own colour: (i, 255 - i, 7i), opaque
// but for 255 (VID_SetPalette's d_8to24table)
function withPalette(fn) {
  const saved = d_8to24table.slice();
  const savedFullbright = vid.fullbright;
  try {
    for (let i = 0; i < 256; i++) {
      const a = i === 255 ? 0 : 255;
      d_8to24table[i] = (i | ((255 - i) << 8) | (((i * 7) & 255) << 16) |
        (a << 24)) >>> 0;
    }
    vid.fullbright = 224;
    fn();
  } finally {
    d_8to24table.set(saved);
    vid.fullbright = savedFullbright;
  }
}

function rgb(i) {
  return [i, 255 - i, (i * 7) & 255];
}

function texel(texture, index) {
  const d = texture.image.data;
  return [d[index * 4], d[index * 4 + 1], d[index * 4 + 2], d[index * 4 + 3]];
}

function assertTexel(texture, index, expected, message) {
  const got = texel(texture, index);
  for (let c = 0; c < 4; c++) {
    assertEqual(got[c], expected[c], `${message} [${c}]`);
  }
}

Deno.test("'{' textures make index 255 transparent and alpha-test it", () => {
  withPalette(() => {
    const textures = loadTextures([
      { name: "{grate", pixels: fencePixels(255) },
      { name: "grate", pixels: fencePixels(255) },
      { name: "{solid", pixels: fencePixels(10) },
    ]);
    const fence = textures.get("{grate").gl_texture;
    const plain = textures.get("grate").gl_texture;
    const solid = textures.get("{solid").gl_texture;
    const c10 = rgb(10);

    // TexMgr_AlphaEdgeFix: the average RGB of the opaque neighbours. (1, 1)
    // has seven of index 10 and the fullbright texel, black in the base.
    const avg = (c) => Math.floor(c10[c] * 7 / 8);
    assertTexel(
      fence,
      SIZE + 1,
      [avg(0), avg(1), avg(2), 0],
      "transparent, edge-fixed",
    );
    // (15, 15) wraps to row 0 and column 0: all index 10
    assertTexel(
      fence,
      SIZE * SIZE - 1,
      [c10[0], c10[1], c10[2], 0],
      "edge fix wraps",
    );
    assertTexel(fence, 0, [...c10, 255], "other texels opaque");
    assertTexel(fence, SIZE + 2, [0, 0, 0, 255], "fullbright out of the base");
    assertEqual(fence._cutout, true, "marked for the alpha test");

    // the fullbright map (Ironwail's fbright_fence palette): index 255 is
    // transparent and takes 1/8 of the fullbright texel next to it
    const fb = fence._fullbright;
    const c240 = rgb(240);
    assertTexel(
      fb,
      SIZE + 1,
      [c240[0] >> 3, c240[1] >> 3, c240[2] >> 3, 0],
      "fullbright map edge-fixed",
    );
    assertTexel(fb, SIZE + 2, [...c240, 255], "fullbright texel");
    assertTexel(fb, 0, [0, 0, 0, 255], "other fullbright texels opaque black");

    // a texture without '{' is unchanged: index 255 is an opaque fullbright
    // (black in the base, as 240), nothing edge-fixed, no alpha test
    for (let i = 0; i < SIZE * SIZE; i++) {
      const p = fencePixels(255)[i];
      const expected = p >= 224 ? [0, 0, 0, 255] : [...rgb(p), 255];
      assertTexel(plain, i, expected, `plain texel ${i}`);
    }
    assertEqual(plain._cutout, undefined, "plain not marked");
    assertEqual(
      plain._fullbright.image.data[(SIZE + 1) * 4 + 3],
      255,
      "plain fullbright map: index 255 is a fullbright texel",
    );

    // "detect false alpha cases": a '{' texture with no index 255 is opaque
    assertEqual(solid._cutout, undefined, "no transparent texel, no cutout");

    // the materials: lightmapped and unlit world batches
    for (const lm of [{}, null]) {
      assertEqual(
        gl_rsurf.R_CreateWorldMaterial(fence, lm, false).alphaTest,
        gl_rsurf.FENCE_ALPHATEST,
        "fence material alpha-tests",
      );
      assertEqual(
        gl_rsurf.R_CreateWorldMaterial(fence, lm, true).alphaTest,
        gl_rsurf.FENCE_ALPHATEST,
        "underwater fence material alpha-tests",
      );
      assertEqual(
        gl_rsurf.R_CreateWorldMaterial(plain, lm, false).alphaTest,
        0,
        "plain material does not",
      );
      assertEqual(
        gl_rsurf.R_CreateWorldMaterial(solid, lm, false).alphaTest,
        0,
        "opaque '{' material does not",
      );
    }
    assertEqual(gl_rsurf.FENCE_ALPHATEST, 0.666, "Ironwail's threshold");
  });
});

Deno.test("TexMgr_AlphaEdgeFix leaves a texel with no opaque neighbour", () => {
  // 2 x 1: both transparent, so nothing to average
  const data = new Uint8Array([1, 2, 3, 0, 4, 5, 6, 0]);
  gl_model.TexMgr_AlphaEdgeFix(data, 2, 1);
  assertEqual(data.join(","), "1,2,3,0,4,5,6,0", "unchanged");
});
