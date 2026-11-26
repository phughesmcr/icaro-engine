// gl_model.js skips drawing data when cls.state is ca_dedicated (the Deno
// game server): alias display lists, texels, RGBA textures and warp polygons.
// A dedicated load must still give everything the server reads; a client
// load must still give the drawing data.

// Bootstrap the renderer's existing circular module graph in its safe order.
await import("../src/gl_rsurf.js");
const gl_model = await import("../src/gl_model.js");
const { cls, ca_dedicated } = await import("../src/client.js");
const { COM_AddPack } = await import("../src/pak.js");

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

// A one-frame, one-triangle MDL with a single 8x8 skin
function buildMdl() {
  const numverts = 3;
  const size = 84 + 4 + 64 + numverts * 12 + 16 + 4 + 24 + numverts * 4;
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, gl_model.IDPOLYHEADER, true);
  view.setInt32(4, gl_model.ALIAS_VERSION, true);
  for (let i = 0; i < 3; i++) view.setFloat32(8 + i * 4, 1, true);
  view.setInt32(48, 1, true);
  view.setInt32(52, 8, true);
  view.setInt32(56, 8, true);
  view.setInt32(60, numverts, true);
  view.setInt32(64, 1, true);
  view.setInt32(68, 1, true);
  view.setInt32(76, 8, true); // flags
  view.setInt32(72, 1, true); // synctype
  view.setFloat32(80, 1, true);

  let pos = 84 + 4;
  bytes.fill(15, pos, pos + 64);
  pos += 64;
  for (let i = 0; i < numverts; i++, pos += 12) {
    view.setInt32(pos + 4, i * 2, true);
    view.setInt32(pos + 8, i, true);
  }

  view.setInt32(pos, 1, true);
  for (let j = 0; j < 3; j++) view.setInt32(pos + 4 + j * 4, j, true);
  pos += 16;
  view.setInt32(pos, gl_model.ALIAS_SINGLE, true);
  pos += 4;
  bytes.set(new TextEncoder().encode("stand1"), pos + 8);
  return bytes;
}

let serial = 0;

function loadAlias(dedicated) {
  const old = cls.state;
  cls.state = dedicated ? ca_dedicated : 1;
  try {
    const bytes = buildMdl();
    const name = "progs/__ded_" + (serial++) + ".mdl";
    COM_AddPack({
      files: [{ name: name, filepos: 0, filelen: bytes.length }],
      data: bytes.buffer,
    });
    const mod = gl_model.Mod_ForName(name, true);
    return { mod, hdr: gl_model.Mod_Extradata(mod) };
  } finally {
    cls.state = old;
  }
}

Deno.test("an alias model loads what the server reads in both modes, and drawing data only for a client", () => {
  const ded = loadAlias(true);
  const cl = loadAlias(false);

  for (const { mod, hdr } of [ded, cl]) {
    assertEqual(mod.numframes, 1, "numframes");
    assertEqual(mod.synctype, 1, "synctype");
    assertEqual((mod.flags & 8) !== 0, true, "flags");
    assertEqual(mod.mins[0], -16, "mins");
    assertEqual(mod.maxs[2], 16, "maxs");
    assertEqual(hdr.numskins, 1, "numskins");
    assertEqual(hdr.numverts, 3, "numverts");
    assertEqual(hdr.numtris, 1, "numtris");
    assertEqual(hdr.numposes, 1, "numposes");
    assertEqual(hdr.frames[0].name, "stand1", "frame name");
    assertEqual(hdr.gl_texturenum[0][0] != null, true, "skin texture object");
  }

  assertEqual(ded.hdr.posedata, null, "dedicated: no posedata");
  assertEqual(ded.hdr.commands, null, "dedicated: no commands");
  assertEqual(ded.hdr.texels[0], 0, "dedicated: no texels");
  assertEqual(
    ded.hdr.gl_texturenum[0][0].image.data,
    null,
    "dedicated: no RGBA pixels",
  );

  assertEqual(cl.hdr.posedata.length, 1, "client: posedata");
  assertEqual(cl.hdr.commands.length > 0, true, "client: commands");
  assertEqual(cl.hdr.texels[0].length, 64, "client: texels");
  assertEqual(
    cl.hdr.gl_texturenum[0][0].image.data.length,
    8 * 8 * 4,
    "client: RGBA pixels",
  );
});

// A real map: the loose deathmatch map beside the shareware pak
Deno.test("a brush model keeps its hulls and extents in both modes, and warp polygons only for a client", async () => {
  const bytes = await Deno.readFile(
    new URL("../static/maps/edc.bsp", import.meta.url),
  );
  const old = cls.state;
  const results = [];
  try {
    for (const dedicated of [true, false]) {
      cls.state = dedicated ? ca_dedicated : 1;
      const name = "maps/__ded_" + (serial++) + ".bsp";
      COM_AddPack({
        files: [{ name: name, filepos: 0, filelen: bytes.length }],
        data: bytes.buffer,
      });
      const mod = gl_model.Mod_ForName(name, true);
      let polys = 0, extents = 0;
      for (const s of mod.surfaces) {
        if (s.polys != null) polys++;
        extents += s.extents[0] + s.extents[1] + s.texturemins[0];
      }

      results.push({ mod, polys, extents });
    }
  } finally {
    cls.state = old;
  }

  const [ded, cl] = results;
  assertEqual(ded.mod.numsurfaces > 0, true, "has surfaces");
  assertEqual(ded.mod.numsurfaces, cl.mod.numsurfaces, "numsurfaces");
  assertEqual(ded.extents, cl.extents, "extents and texturemins");
  assertEqual(
    ded.mod.hulls[1].lastclipnode,
    cl.mod.hulls[1].lastclipnode,
    "hull 1 clipnodes",
  );
  assertEqual(ded.mod.numleafs, cl.mod.numleafs, "numleafs");
  assertEqual(ded.mod.maxs[0], cl.mod.maxs[0], "maxs");
  assertEqual(ded.polys, 0, "dedicated: no warp polygons");
  assertEqual(cl.polys > 0, true, "client: warp polygons");
});
