// .lit coloured lighting (Ironwail Mod_LoadLighting, QuakeSpasm's "lit
// support via lordhavoc" in R_BuildLightMap, R_AddDynamicLights and
// R_LightPoint). Every map and .lit here is synthetic: commercial data must
// never be committed.

// Bootstrap the renderer's existing circular module graph in its safe order.
const gl_rsurf = await import("../src/gl_rsurf.js");

const gl_rmain = await import("../src/gl_rmain.js");
const gl_model = await import("../src/gl_model.js");
const gl_rlight = await import("../src/gl_rlight.js");
const glquake = await import("../src/glquake.js");
const { cl, cls, ca_dedicated, cl_dlights } = await import("../src/client.js");
const { COM_SetModified, com_modified } = await import("../src/common.js");
const {
  COM_AddPack,
  COM_AddPakSequence,
  COM_EnsureFile,
  COM_FindFile,
  COM_SetLazyPakSize,
  COM_LAZY_PAK_SIZE,
  COM_SetLooseFileBasePaths,
} = await import("../src/pak.js");
const { writeMap, smallMap } = await import("./synthetic_bsp.js");

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

// ----------------------------------------------------------------------------
// Mod_LoadLighting
// ----------------------------------------------------------------------------

const LIGHT_LEN = 128; // smallMap's lit face reads from lightofs 64

function monoLighting() {
  const out = new Uint8Array(LIGHT_LEN);
  for (let i = 0; i < LIGHT_LEN; i++) out[i] = i;
  return out;
}

// A .lit: "QLIT", version, then r, g, b for each mono sample
function makeLit(filelen, opts = {}) {
  const magic = opts.magic !== undefined ? opts.magic : "QLIT";
  const version = opts.version !== undefined ? opts.version : 1;
  const bytes = new Uint8Array(
    8 + filelen * 3 + (opts.extra !== undefined ? opts.extra : 0),
  );
  bytes.set(new TextEncoder().encode(magic), 0);
  new DataView(bytes.buffer).setInt32(4, version, true);
  for (let i = 0; i < filelen; i++) {
    bytes[8 + i * 3] = 200;
    bytes[8 + i * 3 + 1] = 100;
    bytes[8 + i * 3 + 2] = i & 255;
  }

  return bytes;
}

function addFile(name, bytes) {
  COM_AddPack({
    files: [{ name: name, filepos: 0, filelen: bytes.length }],
    data: bytes.buffer,
  });
}

let mapSerial = 0;

// Adds maps/<name>.bsp (with a mono lighting lump), and its .lit if given,
// before (litFirst: a lower search path) or after the map. Returns the model.
function loadMap(lit, litFirst = false) {
  const name = "maps/__lit_" + (mapSerial++);
  const map = smallMap();
  map.lighting = monoLighting();
  if (lit !== null && litFirst) addFile(name + ".lit", lit);
  addFile(name + ".bsp", writeMap(false, map));
  if (lit !== null && !litFirst) addFile(name + ".lit", lit);
  return gl_model.Mod_ForName(name + ".bsp", true);
}

function assertMono(mod, message) {
  assertEqual(mod.litfile, false, message + ": litfile");
  assertEqual(mod.lightdata.length, LIGHT_LEN, message + ": mono lightdata");
  assertEqual(mod.lightdata[70], 70, message + ": mono sample");
  assertEqual(mod.surfaces[1].sampleOffset, 64, message + ": lightofs");
  assertEqual(mod.surfaces[1].rgbsamples, false, message + ": rgbsamples");
}

Deno.test("Mod_LoadLighting uses a good .lit as RGB lightdata", () => {
  const mod = loadMap(makeLit(LIGHT_LEN));
  assertEqual(mod.litfile, true, "litfile");
  assertEqual(mod.lightdata.length, LIGHT_LEN * 3, "RGB lightdata");
  assertEqual(mod.lightdata[70 * 3], 200, "red");
  assertEqual(mod.lightdata[70 * 3 + 1], 100, "green");
  assertEqual(mod.lightdata[70 * 3 + 2], 70, "blue");
  assertEqual(mod.surfaces[1].samples, mod.lightdata, "samples");
  assertEqual(mod.surfaces[1].sampleOffset, 64 * 3, "lightofs * 3");
  assertEqual(mod.surfaces[1].rgbsamples, true, "rgbsamples");
  assertEqual(mod.surfaces[0].samples, null, "lightofs -1 has no samples");
});

Deno.test("Mod_LoadLighting falls back to the mono data for a missing or bad .lit", () => {
  assertMono(loadMap(null), "no .lit");
  assertMono(loadMap(makeLit(LIGHT_LEN, { magic: "QLIX" })), "bad magic");
  assertMono(loadMap(makeLit(LIGHT_LEN, { version: 2 })), "version 2");
  assertMono(loadMap(makeLit(LIGHT_LEN, { extra: 3 })), "outdated size");
  assertMono(loadMap(new Uint8Array(3)), "shorter than the header");
});

Deno.test("Mod_LoadLighting ignores a .lit from a lower search path than its map", () => {
  assertMono(loadMap(makeLit(LIGHT_LEN), true), "lower .lit");
  assertEqual(loadMap(makeLit(LIGHT_LEN), false).litfile, true, "higher .lit");
});

Deno.test("a dedicated server does not read the .lit", () => {
  const oldState = cls.state;
  try {
    cls.state = ca_dedicated;
    assertMono(loadMap(makeLit(LIGHT_LEN)), "dedicated");
  } finally {
    cls.state = oldState;
  }
});

// ----------------------------------------------------------------------------
// COM_EnsureFile fetches the .lit with its map
// ----------------------------------------------------------------------------

const MAP_SIZE = 40000; // deferred: over the 32k of the b_*.bsp item models

// A pack of entries [ name, Uint8Array ]: header, bodies, then the directory
function makePak(entries) {
  let dirofs = 12;
  for (const [, body] of entries) dirofs += body.length;
  const bytes = new Uint8Array(dirofs + 64 * entries.length);
  const view = new DataView(bytes.buffer);
  bytes.set([0x50, 0x41, 0x43, 0x4B], 0); // 'PACK'
  view.setInt32(4, dirofs, true);
  view.setInt32(8, 64 * entries.length, true);
  let pos = 12;
  entries.forEach(([name, body], i) => {
    bytes.set(body, pos);
    const e = dirofs + i * 64;
    bytes.set(new TextEncoder().encode(name), e);
    view.setInt32(e + 56, pos, true);
    view.setInt32(e + 60, body.length, true);
    pos += body.length;
  });
  return bytes;
}

// Stub fetch serving files by URL, honouring Range; logs each request
function stubFetch(files, log) {
  return (url, init) => {
    const body = files.get(url);
    const range = init !== undefined && init.headers !== undefined ?
      init.headers.Range :
      undefined;
    log.push(url + (range === undefined ? "" : " " + range));
    if (body === undefined) {
      return Promise.resolve(new Response("missing", { status: 404 }));
    }
    if (range === undefined) {
      return Promise.resolve(new Response(body, { status: 200 }));
    }
    const m = /^bytes=(\d+)-(\d+)$/.exec(range);
    const start = parseInt(m[1], 10);
    const end = Math.min(parseInt(m[2], 10), body.length - 1);
    return Promise.resolve(
      new Response(body.slice(start, end + 1), {
        status: 206,
        headers: { "content-range": `bytes ${start}-${end}/${body.length}` },
      }),
    );
  };
}

async function withStubFetch(files, fn) {
  const wasModified = com_modified;
  const realFetch = globalThis.fetch;
  const log = [];
  COM_SetLazyPakSize(0);
  globalThis.fetch = stubFetch(files, log);
  try {
    await fn(log);
  } finally {
    COM_SetLazyPakSize(COM_LAZY_PAK_SIZE);
    COM_SetLooseFileBasePaths(["static/"]);
    globalThis.fetch = realFetch;
    COM_SetModified(wasModified); // test paks are not the original pak0
  }
}

Deno.test("COM_EnsureFile on a map in a lazy pak also fetches its .lit", async () => {
  const lit = makeLit(4);
  const pak = makePak([
    ["maps/litpak.bsp", new Uint8Array(MAP_SIZE).fill(7)],
    ["maps/litpak.lit", lit],
    ["maps/nolitpak.bsp", new Uint8Array(MAP_SIZE).fill(8)],
  ]);
  await withStubFetch(
    new Map([["http://lit.test/a/pak0.pak", pak]]),
    async (log) => {
      assertEqual(
        await COM_AddPakSequence("http://lit.test/a/pak0.pak"),
        1,
        "pak added",
      );
      assertEqual(
        COM_FindFile("maps/litpak.lit"),
        null,
        ".lit deferred at load",
      );

      assertEqual(await COM_EnsureFile("maps/litpak.bsp"), true, "map fetched");
      const found = COM_FindFile("maps/litpak.lit");
      assertEqual(found !== null, true, ".lit fetched with the map");
      assertEqual(found.size, lit.length, ".lit size");

      // a map with no .lit in its pak costs no extra request
      const before = log.length;
      assertEqual(
        await COM_EnsureFile("maps/nolitpak.bsp"),
        true,
        "second map fetched",
      );
      assertEqual(
        log.length,
        before + 1,
        "one request: " + log.slice(before).join(", "),
      );
    },
  );
});

Deno.test("COM_EnsureFile on a loose map also fetches a loose .lit", async () => {
  // Under Deno, loose files are read from disk
  const dir = await Deno.makeTempDir();
  const lit = makeLit(4);
  try {
    await Deno.mkdir(dir + "/maps");
    await Deno.writeFile(
      dir + "/maps/__loose_lit.bsp",
      new Uint8Array(100).fill(1),
    );
    await Deno.writeFile(dir + "/maps/__loose_lit.lit", lit);
    await Deno.writeFile(
      dir + "/maps/__loose_nolit.bsp",
      new Uint8Array(100).fill(2),
    );
    await withStubFetch(new Map(), async () => {
      COM_SetLooseFileBasePaths([dir + "/"]);
      assertEqual(
        await COM_EnsureFile("maps/__loose_lit.bsp"),
        true,
        "loose map",
      );
      assertEqual(
        COM_FindFile("maps/__loose_lit.lit").size,
        lit.length,
        "loose .lit",
      );
      assertEqual(
        COM_FindFile("maps/__loose_lit.lit").path_id,
        0,
        "loose files rank lowest",
      );
      assertEqual(
        await COM_EnsureFile("maps/__loose_nolit.bsp"),
        true,
        "a missing .lit does not fail the map",
      );
      assertEqual(COM_FindFile("maps/__loose_nolit.lit"), null, "no .lit");
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ----------------------------------------------------------------------------
// Lightmap build and upload
// ----------------------------------------------------------------------------

// A 2x2-luxel surface with light style 0. samples: the luxel values, one a
// luxel (mono) or three (rgb).
function makeSurface(samples, rgb) {
  return {
    flags: 0,
    numedges: 0,
    firstedge: 0,
    polys: null,
    extents: new Int16Array([16, 16]),
    texturemins: new Int16Array([0, 0]),
    styles: new Uint8Array([0, 255, 255, 255]),
    cached_light: new Int32Array(4),
    cached_dlight: false,
    dlightframe: -1,
    dlightbits: new Uint32Array(2),
    samples: samples,
    sampleOffset: 0,
    rgbsamples: rgb,
    plane: { normal: new Float32Array([0, 0, 1]), dist: 0 },
    texinfo: {
      vecs: [new Float32Array([1, 0, 0, 0]), new Float32Array([0, 1, 0, 0])],
    },
    lightmaptexturenum: 0,
    light_s: 0,
    light_t: 0,
  };
}

// Texel (s, t) of the surface's block texture as [ r, g, b ]
function texel(surf, s, t) {
  const data = gl_rsurf.lightmapTextures[surf.lightmaptexturenum].image.data;
  const p = ((surf.light_t + t) * gl_rsurf.BLOCK_WIDTH + surf.light_s + s) * 4;
  return [data[p], data[p + 1], data[p + 2]].join(",");
}

// Runs fn after GL_BuildLightmaps on a world of the given surfaces, then
// restores the client's models and the renderer.
function withLightmaps(litfile, surfaces, fn) {
  const oldFrame = gl_rmain.r_framecount;
  const oldModel = cl.model_precache[1];
  const oldNext = cl.model_precache[2];
  const oldWorldmodel = cl.worldmodel;
  const oldStyle = glquake.d_lightstylevalue[0];

  try {
    glquake.d_lightstylevalue[0] = 256;
    const world = {
      name: "maps/__lit_world.bsp",
      litfile: litfile,
      lightdata: new Uint8Array(1),
      numsurfaces: surfaces.length,
      surfaces: surfaces,
      vertexes: [],
      edges: [],
      surfedges: [],
    };
    cl.worldmodel = world;
    cl.model_precache[1] = world;
    cl.model_precache[2] = null;
    gl_rsurf.GL_BuildLightmaps();
    fn();
  } finally {
    glquake.d_lightstylevalue[0] = oldStyle;
    cl.model_precache[1] = oldModel;
    cl.model_precache[2] = oldNext;
    cl.worldmodel = oldWorldmodel;
    gl_rsurf.GL_BuildLightmaps();
    gl_rmain.set_r_framecount(oldFrame);
  }
}

Deno.test("a lit map builds RGB lightmaps, and mono surfaces in it stay grey", () => {
  // style 256 doubles each sample (blocklights >> 7), clamped at 255
  const rgb = makeSurface(
    new Uint8Array([10, 50, 100, 0, 0, 0, 200, 1, 2, 3, 4, 5]),
    true,
  );
  const mono = makeSurface(new Uint8Array([30, 0, 0, 0]), false);
  withLightmaps(true, [rgb, mono], () => {
    assertEqual(texel(rgb, 0, 0), "20,100,200", "rgb luxel");
    assertEqual(texel(rgb, 1, 0), "0,0,0", "dark luxel");
    assertEqual(texel(rgb, 0, 1), "255,2,4", "clamped red");
    assertEqual(texel(rgb, 1, 1), "6,8,10", "last luxel");
    assertEqual(texel(mono, 0, 0), "60,60,60", "mono surface in a lit map");

    // the row upload converts all three channels
    const tex = gl_rsurf.lightmapTextures[rgb.lightmaptexturenum];
    tex.image.data.fill(7);
    gl_rsurf.R_UploadLightmapRect(rgb.lightmaptexturenum, {
      l: 0,
      t: rgb.light_t,
      w: 2,
      h: 2,
    }, null);
    assertEqual(texel(rgb, 0, 0), "20,100,200", "uploaded rgb luxel");
    assertEqual(
      tex.image
        .data[(rgb.light_t * gl_rsurf.BLOCK_WIDTH + rgb.light_s) * 4 + 3],
      255,
      "alpha",
    );
  });
});

Deno.test("a map without a .lit keeps one-byte lightmaps", () => {
  const mono = makeSurface(new Uint8Array([30, 40, 50, 60]), false);
  withLightmaps(false, [mono], () => {
    assertEqual(texel(mono, 0, 0), "60,60,60", "first luxel");
    assertEqual(texel(mono, 1, 1), "120,120,120", "last luxel");

    // R_BuildLightMap still writes one byte a texel
    const dest = new Uint8Array(4);
    gl_rsurf.R_BuildLightMap(mono, dest, 0, 2);
    assertEqual(
      Array.from(dest).join(","),
      [255 - 60, 255 - 80, 255 - 100, 255 - 120].join(","),
      "luminance bytes",
    );
  });
});

Deno.test("dynamic lights add their colour to RGB lightmaps", () => {
  const saved = cl_dlights.map((
    l,
  ) => [l.radius, l.minlight, Array.from(l.origin)]);
  const rgb = makeSurface(new Uint8Array(12), true);
  try {
    withLightmaps(true, [rgb], () => {
      for (const light of cl_dlights) {
        light.radius = 0;
        light.minlight = 0;
      }

      gl_rmain.set_r_framecount(9);
      rgb.dlightframe = 9;
      rgb.dlightbits[0] = 1;
      cl_dlights[0].radius = 100;
      cl_dlights[0].origin.set([0, 0, 0]);

      const dest = new Uint8Array(4 * 2 * 2).fill(1);
      gl_rsurf.R_BuildLightMap(rgb, dest, 0, 2 * 4);
      // luxel (0, 0) is at the light: 100 units, 200 after >> 7, inverted
      assertEqual(
        Array.from(dest.subarray(0, 4)).join(","),
        "55,55,55,1",
        "white dlight, alpha byte untouched",
      );
      assertEqual(
        dest[4] === dest[5] && dest[5] === dest[6],
        true,
        "second luxel grey",
      );

      // a coloured dlight (the 2021 quad glow) scales each channel
      cl_dlights[0].color.set([0.25, 0.25, 1]);
      gl_rsurf.R_BuildLightMap(rgb, dest, 0, 2 * 4);
      assertEqual(
        Array.from(dest.subarray(0, 4)).join(","),
        "205,205,55,1",
        "blue dlight",
      );
    });
  } finally {
    cl_dlights.forEach((l, i) => {
      l.radius = saved[i][0];
      l.minlight = saved[i][1];
      l.origin.set(saved[i][2]);
      l.color.fill(1);
    });
  }
});

// ----------------------------------------------------------------------------
// R_LightPoint
// ----------------------------------------------------------------------------

// One node at z = 0 holding one 128x128 surface around the origin (9x9 luxels)
function lightPointWorld(samples, rgb) {
  const plane = { type: 2, normal: new Float32Array([0, 0, 1]), dist: 0 };
  const surf = {
    flags: 0,
    plane: plane,
    texinfo: { vecs: [[1, 0, 0, 0], [0, 1, 0, 0]] },
    texturemins: [-64, -64],
    extents: [128, 128],
    samples: samples,
    sampleOffset: 0,
    rgbsamples: rgb,
    styles: [0, 255, 255, 255],
  };
  const leaf = { contents: -1 };
  const node = {
    contents: 0,
    plane: plane,
    children: [leaf, leaf],
    firstsurface: 0,
    numsurfaces: 1,
  };
  return { lightdata: new Uint8Array(1), nodes: [node], surfaces: [surf] };
}

function lightPoint(world) {
  const oldWorld = cl.worldmodel;
  const oldStyle = glquake.d_lightstylevalue[0];
  try {
    cl.worldmodel = world;
    glquake.d_lightstylevalue[0] = 256;
    const r = gl_rlight.R_LightPoint(new Float32Array([0, 0, 16]), cl);
    return r + " " + Array.from(gl_rlight.lightcolor).join(",");
  } finally {
    cl.worldmodel = oldWorld;
    glquake.d_lightstylevalue[0] = oldStyle;
  }
}

Deno.test("R_LightPoint reads RGB samples into lightcolor and returns their mean", () => {
  const samples = new Uint8Array(9 * 9 * 3);
  for (let i = 0; i < 9 * 9; i++) samples.set([90, 30, 31], i * 3);
  assertEqual(
    lightPoint(lightPointWorld(samples, true)),
    "50 90,30,31",
    "coloured light",
  );

  assertEqual(
    lightPoint(lightPointWorld(new Uint8Array(9 * 9).fill(77), false)),
    "77 77,77,77",
    "mono light",
  );
  assertEqual(
    lightPoint({ lightdata: null }),
    "255 255,255,255",
    "no light data",
  );
});

// ----------------------------------------------------------------------------
// Search-path priority across pak sequences
// ----------------------------------------------------------------------------

Deno.test("paks of one game directory share a search path; a .lit from a lower directory is ignored", async () => {
  const map = smallMap();
  map.lighting = monoLighting();
  const bsp = writeMap(false, map);
  const lit = makeLit(LIGHT_LEN);
  const files = new Map([
    // base directory: a map in pak0 with its .lit in pak1, and a .lit
    // for the game directory's map
    ["http://lit.test/base/pak0.pak", makePak([["maps/__seq_a.bsp", bsp]])],
    [
      "http://lit.test/base/pak1.pak",
      makePak([["maps/__seq_a.lit", lit], ["maps/__seq_b.lit", lit]]),
    ],
    // game directory, searched first
    [
      "http://lit.test/game/pak0.pak",
      makePak([["maps/__seq_b.bsp", bsp], ["maps/__seq_c.lit", lit]]),
    ],
  ]);
  await withStubFetch(files, async () => {
    assertEqual(
      await COM_AddPakSequence("http://lit.test/base/pak0.pak"),
      2,
      "base paks",
    );
    assertEqual(
      await COM_AddPakSequence("http://lit.test/game/pak0.pak"),
      1,
      "game pak",
    );
    // a base map with a game-directory .lit
    COM_AddPack({
      files: [{ name: "maps/__seq_c.bsp", filepos: 0, filelen: bsp.length }],
      data: bsp.buffer,
    }, 0);

    for (
      const name of ["maps/__seq_a.bsp", "maps/__seq_b.bsp", "maps/__seq_c.bsp"]
    ) {
      assertEqual(await COM_EnsureFile(name), true, name);
    }
    assertEqual(
      COM_FindFile("maps/__seq_a.lit").path_id,
      COM_FindFile("maps/__seq_a.bsp").path_id,
      "one id per directory",
    );

    assertEqual(
      gl_model.Mod_ForName("maps/__seq_a.bsp", true).litfile,
      true,
      ".lit in pak1 for a map in pak0",
    );
    assertMono(
      gl_model.Mod_ForName("maps/__seq_b.bsp", true),
      ".lit in a lower directory",
    );
    assertEqual(
      gl_model.Mod_ForName("maps/__seq_c.bsp", true).litfile,
      true,
      ".lit in a higher directory",
    );
  });
});

// ----------------------------------------------------------------------------
// Lightmap rebuilds
// ----------------------------------------------------------------------------

Deno.test("r_fullbright rebuilds RGB lightmaps at the right offsets", () => {
  const rgb = makeSurface(
    new Uint8Array([10, 50, 100, 0, 0, 0, 200, 1, 2, 3, 4, 5]),
    true,
  );
  const mono = makeSurface(new Uint8Array([30, 0, 0, 0]), false);
  const oldFullbright = glquake.r_fullbright.value;
  const oldTexsort = glquake.gl_texsort.value;
  withLightmaps(true, [rgb, mono], () => {
    try {
      glquake.gl_texsort.value = 1;
      glquake.r_fullbright.value = 1;
      gl_rsurf.R_BlendLightmaps();
      assertEqual(texel(rgb, 1, 1), "255,255,255", "fullbright rgb surface");
      assertEqual(texel(mono, 0, 0), "255,255,255", "fullbright mono surface");

      glquake.r_fullbright.value = 0;
      gl_rsurf.R_BlendLightmaps();
      assertEqual(texel(rgb, 0, 0), "20,100,200", "rgb surface restored");
      assertEqual(texel(rgb, 1, 1), "6,8,10", "last rgb luxel restored");
      assertEqual(texel(mono, 0, 0), "60,60,60", "mono surface restored");
    } finally {
      glquake.r_fullbright.value = oldFullbright;
      gl_rsurf.R_BlendLightmaps();
      glquake.gl_texsort.value = oldTexsort;
    }
  });
});

Deno.test("a mono map after a lit map goes back to one-byte lightmaps", () => {
  withLightmaps(
    true,
    [makeSurface(new Uint8Array(12).fill(9), true)],
    () => {},
  );

  const mono = makeSurface(new Uint8Array([30, 40, 50, 60]), false);
  withLightmaps(false, [mono], () => {
    assertEqual(texel(mono, 1, 1), "120,120,120", "mono texel");
    const dest = new Uint8Array(4);
    gl_rsurf.R_BuildLightMap(mono, dest, 0, 2);
    assertEqual(
      Array.from(dest).join(","),
      [255 - 60, 255 - 80, 255 - 100, 255 - 120].join(","),
      "luminance bytes",
    );
  });
});
