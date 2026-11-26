// BSP2 map loading (Ironwail Mod_LoadBrushModel and the bsp2 variants of the
// edge, face, marksurface, leaf, node and clipnode loaders). Every map here is
// synthetic: commercial BSP2 data must never be committed.

// Bootstrap the renderer's existing circular module graph in its safe order.
await import("../src/gl_rsurf.js");

const gl_model = await import("../src/gl_model.js");
const bspfile = await import("../src/bspfile.js");
const { writeMap, smallMap } = await import("./synthetic_bsp.js");
const { COM_AddPack } = await import("../src/pak.js");
const { SV_HullPointContents, SV_FindTouchedLeafs } = await import(
  "../src/world.js"
);
const { PM_HullPointContents } = await import("../src/pmove.js");
const { edict_t } = await import("../src/progs.js");

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

let pakSerial = 0;

function loadBsp(bytes) {
  const name = "maps/__bsp2_" + (pakSerial++) + ".bsp";
  COM_AddPack({
    files: [{ name: name, filepos: 0, filelen: bytes.length }],
    data: bytes.buffer,
  });
  return gl_model.Mod_ForName(name, true);
}

// Indexes of a loaded model's objects, for comparing two loads
function describe(mod) {
  const planeIdx = new Map(mod.planes.map((p, i) => [p, i]));
  const nodeIdx = new Map(mod.nodes.map((n, i) => [n, i]));
  const leafIdx = new Map(mod.leafs.map((l, i) => [l, i]));
  const surfIdx = new Map(mod.surfaces.map((s, i) => [s, i]));
  const ref = (n) =>
    n === null ?
      null :
      (nodeIdx.has(n) ? "n" + nodeIdx.get(n) : "l" + leafIdx.get(n));
  return JSON.stringify({
    edges: mod.edges.map((e) => Array.from(e.v)),
    surfaces: mod.surfaces.map((
      s,
    ) => [
      s.firstedge,
      s.numedges,
      s.flags,
      planeIdx.get(s.plane),
      mod.texinfo.indexOf(s.texinfo),
      Array.from(s.styles),
      s.samples === null ? null : s.sampleOffset,
      Array.from(s.texturemins),
      Array.from(s.extents),
    ]),
    marksurfaces: mod.marksurfaces.map((s) => surfIdx.get(s)),
    leafs: mod.leafs.map((
      l,
    ) => [
      l.contents,
      ref(l.parent),
      Array.from(l.minmaxs),
      l.nummarksurfaces,
      l.firstmarksurface.map((s) => surfIdx.get(s)),
      Array.from(l.ambient_sound_level),
    ]),
    nodes: mod.nodes.map((
      n,
    ) => [
      planeIdx.get(n.plane),
      ref(n.children[0]),
      ref(n.children[1]),
      ref(n.parent),
      Array.from(n.minmaxs),
      n.firstsurface,
      n.numsurfaces,
    ]),
    hulls: [0, 1, 2].map((h) =>
      mod.hulls[h].clipnodes.map((
        c,
      ) => [c.planenum, c.children[0], c.children[1]])
    ),
  });
}

// Tests

Deno.test('BSP2VERSION_BSP2 is the "BSP2" magic', () => {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setInt32(0, bspfile.BSP2VERSION_BSP2, true);
  assertEqual(new TextDecoder().decode(bytes), "BSP2", "magic");
});

Deno.test("the same map loads identically from BSP29 and BSP2", () => {
  const a = loadBsp(writeMap(false, smallMap()));
  const da = describe(a);
  const b = loadBsp(writeMap(true, smallMap()));
  const db = describe(b);
  assertEqual(db, da, "loaded structures");

  // and the BSP2 load has the values the map describes
  assertEqual(b.numsurfaces, 2, "faces");
  assertEqual(
    b.surfaces[1].flags & gl_model.SURF_PLANEBACK,
    gl_model.SURF_PLANEBACK,
    "side 1",
  );
  assertEqual(b.surfaces[1].styles[0], 5, "styles");
  assertEqual(b.surfaces[1].sampleOffset, 64, "lightofs");
  assertEqual(b.surfaces[0].numedges, 4, "numedges");
  assertEqual(b.leafs[2].ambient_sound_level[3], 7, "ambient level");
  assertEqual(b.leafs[2].firstmarksurface[0], b.surfaces[1], "marksurface");
  assertEqual(
    b.surfaces[1].flags & gl_model.SURF_UNDERWATER,
    gl_model.SURF_UNDERWATER,
    "underwater from the water leaf",
  );
  assertEqual(b.nodes[0].children[0], b.nodes[1], "node child");
  assertEqual(b.nodes[1].children[1], b.leafs[0], "leaf 0 child");
  assertEqual(
    b.hulls[1].clipnodes[1].children[0],
    bspfile.CONTENTS_WATER,
    "clipnode contents",
  );
});

Deno.test("BSP2 reads node bounds as floats past the short range", () => {
  const map = smallMap();
  map.nodes[0].mins = [-40000.5, -64, -32];
  map.nodes[0].maxs = [40000.25, 64, 32];
  map.leafs[1].mins = [-50000, -64, -32];
  map.leafs[1].maxs = [0, 70000, 32];
  const mod = loadBsp(writeMap(true, map));
  assertEqual(mod.nodes[0].minmaxs[0], -40000.5, "node mins");
  assertEqual(mod.nodes[0].minmaxs[3], 40000.25, "node maxs");
  assertEqual(mod.leafs[1].minmaxs[0], -50000, "leaf mins");
  assertEqual(mod.leafs[1].minmaxs[4], 70000, "leaf maxs");
});

Deno.test("BSP2 node children past 16 bits, and bad children map to the solid leaf", () => {
  // 70000 nodes: the root's front child is node 69999
  const map = smallMap();
  const count = 70000;
  const filler = {
    planenum: 0,
    children: [-1, -1],
    mins: [0, 0, 0],
    maxs: [0, 0, 0],
    firstface: 0,
    numfaces: 0,
  };
  map.nodes = new Array(count).fill(filler);
  map.nodes[0] = { ...filler, children: [count - 1, -1 - 1] };
  // leaf 2; then a leaf index past the leafs, which maps to leaf 0
  map.nodes[count - 1] = { ...filler, planenum: 1, children: [-1 - 2, -1 - 5] };
  // child 0 is never a node in BSP2 (Ironwail Mod_LoadNodes_L2 tests p > 0)
  map.nodes[1] = { ...filler, children: [0, count] };

  const mod = loadBsp(writeMap(true, map));
  assertEqual(
    mod.nodes[0].children[0],
    mod.nodes[count - 1],
    "node index past 65535",
  );
  assertEqual(mod.nodes[0].children[1], mod.leafs[1], "leaf 1");
  assertEqual(mod.nodes[count - 1].children[0], mod.leafs[2], "leaf 2");
  assertEqual(
    mod.nodes[count - 1].children[1],
    mod.leafs[0],
    "leaf index past the leafs",
  );
  assertEqual(
    mod.nodes[count - 1].parent,
    mod.nodes[0],
    "parent set through the far child",
  );
  assertEqual(
    mod.nodes[1].children[0],
    mod.leafs[0],
    "child 0 is the solid leaf",
  );
  assertEqual(
    mod.nodes[1].children[1],
    mod.leafs[0],
    "child past the nodes is a bad leaf",
  );

  // hull 0 keeps the node index
  assertEqual(mod.hulls[0].clipnodes[0].children[0], count - 1, "hull 0 child");
});

Deno.test("BSP2 clipnode children past 16 bits work in world.js and pmove.js", () => {
  // clipnode 0 splits on x = 0 (plane 0): front goes to clipnode 69999,
  // back is empty; 69999 splits on y = 8 (plane 1): front water, back solid
  const map = smallMap();
  const count = 70000;
  map.clipnodes = new Array(count).fill([
    0,
    bspfile.CONTENTS_EMPTY,
    bspfile.CONTENTS_EMPTY,
  ]);
  map.clipnodes[0] = [0, count - 1, bspfile.CONTENTS_EMPTY];
  map.clipnodes[count - 1] = [
    1,
    bspfile.CONTENTS_WATER,
    bspfile.CONTENTS_SOLID,
  ];

  const mod = loadBsp(writeMap(true, map));
  const hull = mod.hulls[1];
  assertEqual(
    hull.clipnodes[0].children[0],
    count - 1,
    "clipnode index past 65535",
  );
  assertEqual(hull.lastclipnode, count - 1, "lastclipnode");

  const cases = [
    [[10, 20, 0], bspfile.CONTENTS_WATER],
    [[10, 0, 0], bspfile.CONTENTS_SOLID],
    [[-10, 20, 0], bspfile.CONTENTS_EMPTY],
  ];
  for (const [p, contents] of cases) {
    const v = new Float32Array(p);
    assertEqual(
      SV_HullPointContents(hull, 0, v),
      contents,
      `SV_HullPointContents ${p}`,
    );
    assertEqual(
      PM_HullPointContents(hull, 0, v),
      contents,
      `PM_HullPointContents ${p}`,
    );
  }
});

Deno.test("BSP2 edge vertex numbers and marksurfaces past 16 bits", () => {
  const map = smallMap();
  const far = 70000;
  while (map.vertexes.length <= far) map.vertexes.push([0, 0, 0]);
  map.vertexes[far] = [128, 128, 0];
  // a triangle through vertexes 2 (64, 64), far (128, 128) and 1 (64, 0)
  map.edges.push([2, far], [far, 1], [1, 2]);
  map.surfedges.push(7, 8, 9);
  // enough faces that a marksurface needs more than 16 bits
  const face = {
    planenum: 2,
    side: 0,
    firstedge: 7,
    numedges: 3,
    texinfo: 0,
    styles: [0, 255, 255, 255],
    lightofs: -1,
  };
  while (map.faces.length <= far) map.faces.push(face);
  map.marksurfaces = [0, 1, far, 1];
  map.leafs[1].nummark = 3;
  map.leafs[2].firstmark = 3;

  const mod = loadBsp(writeMap(true, map));
  assertEqual(mod.edges[7].v[1], far, "edge vertex past 65535");
  assertEqual(
    mod.leafs[1].firstmarksurface[2],
    mod.surfaces[far],
    "marksurface past 65535",
  );
  // CalcSurfaceExtents went through the far vertex: x runs 64..128
  assertEqual(
    mod.surfaces[far].texturemins[0],
    64,
    "texturemins from the far vertex",
  );
  assertEqual(mod.surfaces[far].extents[0], 64, "extents from the far vertex");
});

Deno.test("BSP2 texturemins past 16 bits do not wrap (Ironwail int texturemins)", () => {
  // The synthetic texinfo maps s = x and t = y, so a face out at
  // x = 40000, y = -40064 has texture-space minimums beyond a short.
  // In an Int16Array they would wrap to -25536 and 25472.
  const map = smallMap();
  const base = map.vertexes.length;
  map.vertexes.push([40000, -40064, 0], [40064, -40064, 0], [40064, -40000, 0]);
  const firstedge = map.surfedges.length;
  const e = map.edges.length;
  map.edges.push([base, base + 1], [base + 1, base + 2], [base + 2, base]);
  map.surfedges.push(e, e + 1, e + 2);
  map.faces.push({
    planenum: 2,
    side: 0,
    firstedge: firstedge,
    numedges: 3,
    texinfo: 0,
    styles: [0, 255, 255, 255],
    lightofs: -1,
  });

  const mod = loadBsp(writeMap(true, map));
  const s = mod.surfaces[map.faces.length - 1];
  assertEqual(s.texturemins[0], 40000, "texturemins[0] past +32767");
  assertEqual(s.texturemins[1], -40064, "texturemins[1] past -32768");
  assertEqual(s.extents[0], 64, "extents[0]");
  assertEqual(s.extents[1], 64, "extents[1]");
});

Deno.test("BSP2 has no leaf limit, BSP29 keeps MAX_MAP_LEAFS", () => {
  const map = smallMap();
  const count = bspfile.MAX_MAP_LEAFS + 8;
  const empty = map.leafs[1];
  while (map.leafs.length < count) map.leafs.push({ ...empty, nummark: 0 });
  map.visleafs = count - 1;
  const far = count - 1;
  map.nodes[1].children = [-1 - far, -1 - 0];

  assertThrows(
    () => loadBsp(writeMap(false, map)),
    /leafs exceeds limit/,
    "BSP29 limit",
  );

  const mod = loadBsp(writeMap(true, map));
  assertEqual(mod.leafs.length, count, "leafs");
  assertEqual(mod.nodes[1].children[0], mod.leafs[far], "leaf past 32767");

  // an edict touching that leaf keeps its number (edict_t.leafnums is int)
  const ent = new edict_t(1, 0);
  ent.v = {
    absmin: new Float32Array([8, 16, -8]),
    absmax: new Float32Array([12, 20, 8]),
  };
  SV_FindTouchedLeafs(ent, mod.nodes[0]);
  assertEqual(ent.num_leafs, 1, "one leaf touched");
  assertEqual(ent.leafnums[0], far - 1, "leaf number past 32767");
});

Deno.test("BSP2 lump sizes are checked against the BSP2 structs", () => {
  const bytes = writeMap(true, smallMap());
  // cut the clipnode lump to a BSP29 clipnode's size
  const view = new DataView(bytes.buffer);
  view.setInt32(4 + bspfile.LUMP_CLIPNODES * 8 + 4, 8, true);
  assertThrows(() => loadBsp(bytes), /funny lump size/, "clipnodes");
});

Deno.test("other BSP versions are refused", () => {
  const bytes = writeMap(false, smallMap());
  new DataView(bytes.buffer).setInt32(0, 30, true);
  assertThrows(
    () => loadBsp(bytes),
    /unsupported version number \(30\)/,
    "version 30",
  );

  // RMQ's 2PSB isn't supported
  new DataView(bytes.buffer).setInt32(0, 0x42535032, true);
  assertThrows(() => loadBsp(bytes), /unsupported version number/, "2PSB");
});

Deno.test("BSP2 faces beyond id's 999999 / -99999 extents seeds get the right extents (Ironwail FLT_MAX seeds)", () => {
  // s = x and t = y. A face at x = 2000000..2000064 is above id's 999999
  // min seed, and one at y = -200000..-199936 is below its -99999 max seed.
  const map = smallMap();
  const base = map.vertexes.length;
  map.vertexes.push([2000000, -200000, 0], [2000064, -200000, 0], [
    2000064,
    -199936,
    0,
  ]);
  const firstedge = map.surfedges.length;
  const e = map.edges.length;
  map.edges.push([base, base + 1], [base + 1, base + 2], [base + 2, base]);
  map.surfedges.push(e, e + 1, e + 2);
  map.faces.push({
    planenum: 2,
    side: 0,
    firstedge: firstedge,
    numedges: 3,
    texinfo: 0,
    styles: [0, 255, 255, 255],
    lightofs: -1,
  });

  const mod = loadBsp(writeMap(true, map));
  const s = mod.surfaces[map.faces.length - 1];
  assertEqual(
    s.texturemins[0],
    2000000,
    "texturemins[0] above the old min seed",
  );
  assertEqual(s.texturemins[1], -200000, "texturemins[1]");
  assertEqual(s.extents[0], 64, "extents[0]");
  assertEqual(s.extents[1], 64, "extents[1]");
});
