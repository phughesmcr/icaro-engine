// QuakeSpasm/Ironwail fixes in the GL model loader and renderer: model load
// errors that drop to the console instead of killing the page or room,
// R_LightPoint's trace (deep BSPs, sample-less surfaces, 8192 units, the
// raised retry start), and water turbulence that stops with cl.time.

// Bootstrap the renderer's existing circular module graph in its safe order.
const gl_rsurf = await import("../src/gl_rsurf.js");

const gl_rmain = await import("../src/gl_rmain.js");
const gl_model = await import("../src/gl_model.js");
const gl_rlight = await import("../src/gl_rlight.js");
const glquake = await import("../src/glquake.js");
const bspfile = await import("../src/bspfile.js");
const { cl } = await import("../src/client.js");
const { COM_AddPack } = await import("../src/pak.js");

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

function assertThrows(fn, pattern, message) {
  try {
    fn();
  } catch (e) {
    if (!pattern.test(e.message)) {
      throw new Error(`${message}: wrong error "${e.message}"`);
    }
    return;
  }

  throw new Error(`${message}: did not throw`);
}

// ----------------------------------------------------------------------------
// Model load errors
// ----------------------------------------------------------------------------

Deno.test("a missing model with crash set is a Host_Error, not a Sys_Error", () => {
  assertThrows(
    () => gl_model.Mod_ForName("progs/__no_such_model.mdl", true),
    /^Host_Error: Mod_LoadModel: progs\/__no_such_model\.mdl not found/,
    "crash true",
  );
  assertEqual(
    gl_model.Mod_ForName("progs/__no_such_model_2.mdl", false),
    null,
    "crash false",
  );
});

// A BSP29 with one texture and the lumps Mod_LoadBrushModel needs.
// opts: numleafs, clipnodePlanenum, marksurfaces (array of surface numbers)
function buildBspWithTexture(width, height, opts = {}) {
  const lumps = [];
  const numleafs = opts.numleafs !== undefined ? opts.numleafs : 2;

  const planes = new Uint8Array(20);
  new DataView(planes.buffer).setFloat32(0, 1, true);
  lumps[bspfile.LUMP_PLANES] = planes;

  const leafs = new Uint8Array(numleafs * 28);
  const lv = new DataView(leafs.buffer);
  for (let i = 0; i < numleafs; i++) {
    lv.setInt32(i * 28, i === 0 ? -2 : -1, true);
    lv.setInt32(i * 28 + 4, -1, true);
  }

  lumps[bspfile.LUMP_LEAFS] = leafs;

  if (opts.marksurfaces !== undefined) {
    const marks = new Uint8Array(opts.marksurfaces.length * 2);
    const kv = new DataView(marks.buffer);
    opts.marksurfaces.forEach((m, i) => kv.setUint16(i * 2, m, true));
    lumps[bspfile.LUMP_MARKSURFACES] = marks;
  }

  const nodes = new Uint8Array(24);
  const nv = new DataView(nodes.buffer);
  nv.setUint16(4, 0xffff, true);
  nv.setUint16(6, 0xfffe, true);
  lumps[bspfile.LUMP_NODES] = nodes;

  const clipnodes = new Uint8Array(8);
  const cv = new DataView(clipnodes.buffer);
  cv.setInt32(
    0,
    opts.clipnodePlanenum !== undefined ? opts.clipnodePlanenum : 0,
    true,
  );
  cv.setUint16(4, 0xffff, true);
  cv.setUint16(6, 0xfffe, true);
  lumps[bspfile.LUMP_CLIPNODES] = clipnodes;

  const models = new Uint8Array(64);
  const mv = new DataView(models.buffer);
  for (let j = 0; j < 3; j++) {
    mv.setFloat32(j * 4, -64, true);
    mv.setFloat32(12 + j * 4, 64, true);
  }

  mv.setInt32(52, numleafs - 1, true);
  lumps[bspfile.LUMP_MODELS] = models;

  let pixels = 0;
  for (let m = 0; m < 4; m++) pixels += (width >> m) * (height >> m);
  const tex = new Uint8Array(8 + 40 + pixels);
  const tv = new DataView(tex.buffer);
  tv.setInt32(0, 1, true);
  tv.setInt32(4, 8, true);
  const name = "odd";
  for (let c = 0; c < name.length; c++) tex[8 + c] = name.charCodeAt(c);
  tv.setUint32(8 + 16, width, true);
  tv.setUint32(8 + 20, height, true);
  let mipofs = 40;
  for (let m = 0; m < 4; m++) {
    tv.setUint32(8 + 24 + m * 4, mipofs, true);
    mipofs += (width >> m) * (height >> m);
  }

  lumps[bspfile.LUMP_TEXTURES] = tex;

  const header = 4 + bspfile.HEADER_LUMPS * 8;
  let size = header;
  for (let i = 0; i < bspfile.HEADER_LUMPS; i++) {
    size += lumps[i] !== undefined ? (lumps[i].length + 3) & ~3 : 0;
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

Deno.test("a texture that is not 16 aligned loads with a warning", () => {
  for (const [width, height] of [[24, 8], [20, 12]]) {
    const bytes = buildBspWithTexture(width, height);
    const name = "maps/__odd_texture_" + width + "x" + height + ".bsp";
    COM_AddPack({
      files: [{ name: name, filepos: 0, filelen: bytes.length }],
      data: bytes.buffer,
    });
    const mod = gl_model.Mod_ForName(name, true);
    assertEqual(mod.numtextures, 1, "numtextures");
    assertEqual(mod.textures[0].width, width, "texture width");
    assertEqual(mod.textures[0].height, height, "texture height");
  }
});

let bspSerial = 0;

function loadBsp(bytes) {
  const name = "maps/__host_error_" + (bspSerial++) + ".bsp";
  COM_AddPack({
    files: [{ name: name, filepos: 0, filelen: bytes.length }],
    data: bytes.buffer,
  });
  return gl_model.Mod_ForName(name, true);
}

Deno.test("bad leaf, clipnode and marksurface lumps are Host_Errors", () => {
  assertThrows(
    () =>
      loadBsp(
        buildBspWithTexture(16, 16, { numleafs: bspfile.MAX_MAP_LEAFS + 1 }),
      ),
    /^Host_Error: Mod_LoadLeafs: \d+ leafs exceeds limit/,
    "leaf limit",
  );
  assertThrows(
    () => loadBsp(buildBspWithTexture(16, 16, { clipnodePlanenum: 5 })),
    /^Host_Error: Mod_LoadClipnodes: planenum out of bounds/,
    "clipnode planenum",
  );
  assertThrows(
    () => loadBsp(buildBspWithTexture(16, 16, { marksurfaces: [3] })),
    /^Host_Error: Mod_ParseMarksurfaces: bad surface number/,
    "marksurface",
  );
});

// ----------------------------------------------------------------------------
// R_LightPoint
// ----------------------------------------------------------------------------

const LEAF = { contents: -1 };

function zPlane(dist) {
  return { type: 2, normal: new Float32Array([0, 0, 1]), dist: dist };
}

// A lightmapped surface on plane, 128x128 units around the origin. With
// samples, every luxel is `value` in light style 0.
function surface(plane, value) {
  return {
    flags: 0,
    plane: plane,
    texinfo: { vecs: [[1, 0, 0, 0], [0, 1, 0, 0]] },
    texturemins: [-64, -64],
    extents: [128, 128],
    samples: value === null ? null : new Uint8Array(9 * 9).fill(value),
    sampleOffset: 0,
    styles: [0, 255, 255, 255],
  };
}

// nodes: array of { dist, surfaces }; each node's back child is the next.
function worldOf(nodes) {
  const surfaces = [];
  const out = nodes.map((n) => {
    const plane = zPlane(n.dist);
    const node = {
      contents: 0,
      plane: plane,
      children: [LEAF, LEAF],
      firstsurface: surfaces.length,
      numsurfaces: n.surfaces.length,
    };
    for (const value of n.surfaces) surfaces.push(surface(plane, value));
    return node;
  });
  for (let i = 0; i + 1 < out.length; i++) out[i].children[1] = out[i + 1];
  return { lightdata: new Uint8Array(1), nodes: out, surfaces: surfaces };
}

function withWorld(worldmodel, fn) {
  const oldWorld = cl.worldmodel;
  const oldStyle = glquake.d_lightstylevalue[0];
  try {
    cl.worldmodel = worldmodel;
    glquake.d_lightstylevalue[0] = 256;
    fn();
  } finally {
    cl.worldmodel = oldWorld;
    glquake.d_lightstylevalue[0] = oldStyle;
  }
}

const ORIGIN = new Float32Array([0, 0, 0]);

Deno.test("R_LightPoint traces through more than 32 planes", () => {
  const nodes = [];
  for (let i = 0; i < 48; i++) {
    nodes.push({ dist: -10 * (i + 1), surfaces: [] });
  }
  nodes[47].surfaces.push(90);
  withWorld(worldOf(nodes), () => {
    assertEqual(gl_rlight.R_LightPoint(ORIGIN, cl), 90, "light at depth 47");
  });
});

Deno.test("R_LightPoint looks past a lightmapped surface without samples", () => {
  // id returns black here; QuakeSpasm and Ironwail use the lit surface
  withWorld(worldOf([{ dist: -100, surfaces: [null, 100] }]), () => {
    assertEqual(
      gl_rlight.R_LightPoint(ORIGIN, cl),
      100,
      "overlapping lit surface",
    );
  });

  // a lit surface more than 8 units past the sample-less one stays black
  withWorld(
    worldOf([{ dist: -100, surfaces: [null] }, {
      dist: -200,
      surfaces: [100],
    }]),
    () => {
      assertEqual(
        gl_rlight.R_LightPoint(ORIGIN, cl),
        0,
        "lit surface 100 units further",
      );
    },
  );

  withWorld(
    worldOf([{ dist: -100, surfaces: [null] }, {
      dist: -105,
      surfaces: [100],
    }]),
    () => {
      assertEqual(
        gl_rlight.R_LightPoint(ORIGIN, cl),
        100,
        "lit surface 5 units further",
      );
    },
  );
});

Deno.test("R_LightPoint traces 8192 units down", () => {
  withWorld(worldOf([{ dist: -3000, surfaces: [70] }]), () => {
    assertEqual(
      gl_rlight.R_LightPoint(ORIGIN, cl),
      70,
      "floor 3000 units down",
    );
  });

  withWorld(worldOf([{ dist: -9000, surfaces: [70] }]), () => {
    assertEqual(gl_rlight.R_LightPoint(ORIGIN, cl), 0, "floor 9000 units down");
  });
});

Deno.test("R_LightPoint ofs starts the trace above the point", () => {
  withWorld(worldOf([{ dist: 10, surfaces: [60] }]), () => {
    assertEqual(
      gl_rlight.R_LightPoint(ORIGIN, cl),
      0,
      "origin under the floor",
    );
    assertEqual(
      gl_rlight.R_LightPoint(ORIGIN, cl, 20),
      60,
      "retry from 20 units up",
    );
    assertEqual(gl_rlight.lightspot[2], 10, "lightspot on the floor");
  });
});

// ----------------------------------------------------------------------------
// Water turbulence clock
// ----------------------------------------------------------------------------

Deno.test("water turbulence follows cl.time, so it stops while paused", () => {
  const oldWorldmodel = cl.worldmodel;
  const oldModels = cl.model_precache.slice();
  const oldTime = cl.time;
  const oldFrame = gl_rmain.r_framecount;
  const geometry = { attributes: { uv: { needsUpdate: false } }, dispose() {} };
  const surf = {
    flags: gl_rmain.SURF_DRAWTURB,
    polys: {},
    texinfo: { texture: { anim_total: 0, gl_texture: { id: 876543 } } },
    _waterGeoCache: { geometry: geometry, vertexCount: 1 },
  };
  // The turbulence runs in the vertex shader; read its clock uniform.
  const shader = { uniforms: {}, vertexShader: "" };
  gl_rsurf.R_PatchTurbVertexShader(shader);
  const clock = shader.uniforms.quakeTurbTime;

  try {
    cl.worldmodel = {
      numleafs: 0,
      leafs: [],
      firstmodelsurface: 0,
      nummodelsurfaces: 0,
      numsurfaces: 0,
      surfaces: [],
    };
    cl.model_precache.fill(null);
    gl_rsurf.GL_BuildLightmaps();

    cl.time = Math.PI / 2 + 0.001;
    gl_rsurf.R_DrawSequentialPoly(surf);
    assertEqual(
      clock.value,
      gl_rsurf.R_WaterWarpTime(cl.time),
      "clock is cl.time",
    );

    // realtime is 0 here: a clock on realtime (id), which keeps running
    // while paused, would read 0.
    if (clock.value === 0) {
      throw new Error("clock follows realtime, not cl.time");
    }

    cl.time = Math.PI * 5 / 2 + 0.001;
    gl_rsurf.R_DrawSequentialPoly(surf);
    if (Math.abs(clock.value - (Math.PI / 2 + 0.001)) > 1e-9) {
      throw new Error(`clock wraps at 2 PI: got ${clock.value}`);
    }
  } finally {
    gl_rsurf.GL_BuildLightmaps();
    cl.worldmodel = oldWorldmodel;
    cl.model_precache.splice(0, cl.model_precache.length, ...oldModels);
    cl.time = oldTime;
    gl_rmain.set_r_framecount(oldFrame);
  }
});
