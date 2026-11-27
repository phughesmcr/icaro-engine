// Lit water (QuakeSpasm/Ironwail Mod_LoadFaces haslitwater, r_litwater): a
// liquid face without TEX_SPECIAL keeps its extents and gets a lightmap, and
// is drawn with it while r_litwater is on. Every map here is synthetic:
// commercial data must never be committed.

// Bootstrap the renderer's existing circular module graph in its safe order.
const gl_rsurf = await import("../src/gl_rsurf.js");
const gl_rmain = await import("../src/gl_rmain.js");
const gl_model = await import("../src/gl_model.js");
const bspfile = await import("../src/bspfile.js");
const { cl } = await import("../src/client.js");
const { COM_AddPack } = await import("../src/pak.js");
const { writeMap, smallMap } = await import("./synthetic_bsp.js");

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

const LIGHT_LEN = 128;

let mapSerial = 0;

// smallMap with *water1 on face 0 and TEX_SPECIAL *slime0 on face 1
function liquidMap(opts = {}) {
  const map = smallMap();
  map.texinfo = 2;
  map.textures = [
    // a texture offset: the warp polys' s/t leave it out, the lightmap's
    // coordinates must not
    { name: "*water1", flags: 0, offset: [24, -40] },
    { name: "*slime0", flags: bspfile.TEX_SPECIAL },
  ];
  map.faces[0].texinfo = 0;
  map.faces[0].lightofs = opts.waterLightofs !== undefined ?
    opts.waterLightofs :
    0;
  map.faces[1].texinfo = 1;
  if (opts.lighting !== false) {
    map.lighting = new Uint8Array(LIGHT_LEN).fill(100);
  }
  return map;
}

function loadMap(map) {
  const name = "maps/__litwater_" + (mapSerial++) + ".bsp";
  const bytes = writeMap(false, map);
  COM_AddPack({
    files: [{ name: name, filepos: 0, filelen: bytes.length }],
    data: bytes.buffer,
  });
  return gl_model.Mod_ForName(name, true);
}

Deno.test("a liquid face with samples and no TEX_SPECIAL is lit water", () => {
  const mod = loadMap(liquidMap());
  assertEqual(mod.haslitwater, true, "haslitwater");

  const water = mod.surfaces[0];
  assertEqual(
    water.flags & gl_model.SURF_DRAWTURB,
    gl_model.SURF_DRAWTURB,
    "turb",
  );
  assertEqual(water.flags & gl_rmain.SURF_DRAWTILED, 0, "not tiled");
  assertEqual(
    water.flags & gl_model.SURF_DRAWWATER,
    gl_model.SURF_DRAWWATER,
    "water flag",
  );
  assertEqual(water.extents[0], 80, "real s extent");
  assertEqual(water.extents[1], 80, "real t extent");
  assertEqual(water.texturemins[0], 16, "real s texturemin (offset 24)");
  assertEqual(gl_rsurf.R_IsLitTurb(water), true, "R_IsLitTurb");
  if (water.polys === null) throw new Error("lit water is still subdivided");

  const slime = mod.surfaces[1];
  assertEqual(
    slime.flags & gl_rmain.SURF_DRAWTILED,
    gl_rmain.SURF_DRAWTILED,
    "TEX_SPECIAL is tiled",
  );
  assertEqual(slime.extents[0], 16384, "tiled s extent");
  assertEqual(slime.texturemins[1], -8192, "tiled t texturemin");
  assertEqual(
    slime.flags & gl_model.SURF_DRAWSLIME,
    gl_model.SURF_DRAWSLIME,
    "slime flag",
  );
  assertEqual(gl_rsurf.R_IsLitTurb(slime), false, "TEX_SPECIAL is not lit");
});

Deno.test("only a non-TEX_SPECIAL liquid with samples marks the map", () => {
  // The TEX_SPECIAL slime has samples (lightofs 64) but doesn't count
  const unlit = loadMap(liquidMap({ waterLightofs: -1 }));
  assertEqual(unlit.haslitwater, false, "no samples");
  // QuakeSpasm/Ironwail: still not tiled; its lightmap is black
  assertEqual(gl_rsurf.R_IsLitTurb(unlit.surfaces[0]), true, "not tiled");

  const nolight = loadMap(liquidMap({ lighting: false }));
  assertEqual(nolight.haslitwater, false, "no lighting lump");
});

Deno.test("r_litwater draws lit water with its lightmap, else fullbright", () => {
  const oldWorldmodel = cl.worldmodel;
  const oldModels = cl.model_precache.slice();
  const oldLitWater = gl_rsurf.r_litwater.value;
  const oldFrame = gl_rmain.r_framecount;
  const mod = loadMap(liquidMap());
  const water = mod.surfaces[0];
  const slime = mod.surfaces[1];

  try {
    cl.worldmodel = mod;
    cl.model_precache.fill(null);
    cl.model_precache[1] = mod;
    gl_rsurf.GL_BuildLightmaps();

    assertEqual(water.lightmaptexturenum >= 0, true, "lit water lightmap");
    assertEqual(gl_rsurf.R_IsLitTurb(slime), false, "slime");

    gl_rsurf.r_litwater.value = 1;
    gl_rsurf.R_DrawSequentialPoly(water);
    // (the Deno three shim keeps no lightMap; the program key says which)
    assertEqual(
      water._waterMesh.material.customProgramCacheKey(),
      "quake-lightmap-turb",
      "lit material",
    );
    const uv1 = water._waterMesh.geometry.attributes.uv1;
    if (uv1 === undefined) throw new Error("lit water geometry has no uv1");
    // BuildSurfaceDisplayList's formula, with s = x + 24 and t = y - 40:
    // (s - texturemins + light_s*16 + 8) / (BLOCK_WIDTH*16)
    assertEqual(water.texturemins[0], 16, "texturemins with the offset");
    const pos = water._waterMesh.geometry.attributes.position;
    for (let i = 0; i < uv1.array.length / 2; i++) {
      const s = (pos.array[i * 3] + 24 - water.texturemins[0] +
        water.light_s * 16 + 8) / (gl_rsurf.BLOCK_WIDTH * 16);
      const t = (pos.array[i * 3 + 1] - 40 - water.texturemins[1] +
        water.light_t * 16 + 8) / (gl_rsurf.BLOCK_HEIGHT * 16);
      if (
        Math.abs(uv1.array[i * 2] - s) > 1e-6 ||
        Math.abs(uv1.array[i * 2 + 1] - t) > 1e-6
      ) {
        throw new Error(
          `uv1 ${i}: expected ${s}, ${t}, got ${uv1.array[i * 2]}, ` +
            uv1.array[i * 2 + 1],
        );
      }
    }

    gl_rsurf.R_DrawSequentialPoly(slime);
    assertEqual(
      slime._waterMesh.material.customProgramCacheKey(),
      "quake-turb",
      "TEX_SPECIAL stays fullbright",
    );

    gl_rsurf.r_litwater.value = 0;
    gl_rsurf.R_DrawSequentialPoly(water);
    assertEqual(
      water._waterMesh.material.customProgramCacheKey(),
      "quake-turb",
      "r_litwater 0",
    );

    gl_rsurf.r_litwater.value = 1;
    mod.haslitwater = false;
    gl_rsurf.R_DrawSequentialPoly(water);
    assertEqual(
      water._waterMesh.material.customProgramCacheKey(),
      "quake-turb",
      "a map without lit water",
    );
  } finally {
    mod.haslitwater = true;
    gl_rsurf.r_litwater.value = oldLitWater;
    cl.worldmodel = oldWorldmodel;
    cl.model_precache.splice(0, cl.model_precache.length, ...oldModels);
    gl_rsurf.GL_BuildLightmaps();
    gl_rmain.set_r_framecount(oldFrame);
  }
});
