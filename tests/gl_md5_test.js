// MD5 replacement models (Ironwail r_enhancedmodels): .md5mesh/.md5anim
// parsing, skinning, the Quake frame to MD5 pose mapping, .lmp skins, and
// when the .mdl is drawn instead. Every model here is synthetic: commercial
// data must never be committed.

// Bootstrap the renderer's existing circular module graph in its safe order.
await import("../src/gl_rsurf.js");

const gl_model = await import("../src/gl_model.js");
const gl_mesh = await import("../src/gl_mesh.js");
const gl_md5 = await import("../src/gl_md5.js");
const { cl, cls, ca_dedicated, cl_entities } = await import("../src/client.js");
const gl_rmisc = await import("../src/gl_rmisc.js");
const { r_avertexnormals } = await import("../src/anorm_dots.js");
const { COM_SetModified, com_modified, Con_SetPrintFunctions } = await import(
  "../src/common.js"
);
const {
  COM_AddPack,
  COM_AddPakSequence,
  COM_EnsureFile,
  COM_FindFile,
  COM_SetLazyPakSize,
  COM_LAZY_PAK_SIZE,
  COM_SetLooseFileBasePaths,
} = await import("../src/pak.js");

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

function assertNear(actual, expected, message) {
  if (Math.abs(actual - expected) > 1e-4) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

const encoder = new TextEncoder();

// Synthetic files

// Two joints: root at the origin and child 10 up. v0 and v1 hang off root,
// v2 off child, so moving child moves only v2.
function md5mesh(shader, opts = {}) {
  const weights = opts.weights !== undefined ? opts.weights : [
    "weight 0 0 1 ( 10 0 0 )",
    "weight 1 0 1 ( 0 10 0 )",
    "weight 2 1 1 ( 0 0 0 )",
  ];
  const counts = opts.counts !== undefined ?
    opts.counts :
    [[0, 1], [1, 1], [2, 1]];
  const mesh = `mesh {
	shader "${shader}"
	numverts 3
	vert 0 ( 0 0 ) ${counts[0][0]} ${counts[0][1]}
	vert 1 ( 1 0 ) ${counts[1][0]} ${counts[1][1]}
	vert 2 ( 0 1 ) ${counts[2][0]} ${counts[2][1]}
	numtris 1
	tri 0 0 1 2
	numweights ${weights.length}
	${weights.join("\n\t")}
}
`;
  const nummeshes = opts.nummeshes !== undefined ? opts.nummeshes : 1;
  return `MD5Version 10
commandline "synthetic"
numJoints 2
numMeshes ${nummeshes}
joints {
	"root" -1 ( 0 0 0 ) ( 0 0 0 )
	"child" 0 ( 0 0 10 ) ( 0 0 0 )
}
` + mesh.repeat(nummeshes);
}

// Two frames: child 10 up, then 20 up (positions are relative to the parent)
const MD5ANIM = `MD5Version 10
commandline "synthetic"
numFrames 2
numJoints 2
frameRate 10
numAnimatedComponents 3
hierarchy {
	"root" -1 0 0
	"child" 0 7 0
}
bounds {
	( -10 -10 0 ) ( 10 10 10 )
	( -10 -10 0 ) ( 10 10 20 )
}
baseframe {
	( 0 0 0 ) ( 0 0 0 )
	( 0 0 10 ) ( 0 0 0 )
}
frame 0 {
	0 0 10
}
frame 1 {
	0 0 20
}
`;

// A one-frame, one-triangle MDL with a single 8x8 skin (as alias_holey_test)
function buildMdl() {
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
  bytes.fill(15, pos, pos + 64);
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

// A qpic: int width, int height, then 8-bit pixels
function lmp(width, height, fill) {
  const bytes = new Uint8Array(8 + width * height);
  const view = new DataView(bytes.buffer);
  view.setInt32(0, width, true);
  view.setInt32(4, height, true);
  bytes.fill(fill, 8);
  return bytes;
}

function addPack(entries) {
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

let serial = 0;

// progs/<name>.mdl and, unless left out, its .md5mesh, .md5anim and skins
// in one pack. Returns the base name and shader.
function addModel(opts = {}) {
  const name = "progs/__md5_" + (serial++);
  const shader = name.substring(6);
  const entries = [[name + ".mdl", buildMdl()]];
  if (opts.mesh !== null) {
    entries.push([
      name + ".md5mesh",
      encoder.encode(opts.mesh !== undefined ? opts.mesh : md5mesh(shader)),
    ]);
  }
  if (opts.anim !== null) {
    entries.push([
      name + ".md5anim",
      encoder.encode(opts.anim !== undefined ? opts.anim : MD5ANIM),
    ]);
  }
  const skins = opts.skins !== undefined ? opts.skins : [[3]]; // fills, per skin per frame
  skins.forEach((frames, s) =>
    frames.forEach((fill, f) =>
      entries.push([
        "progs/" + shader + "_" + String(s).padStart(2, "0") + "_" +
        String(f).padStart(2, "0") + ".lmp",
        lmp(16, 8, fill),
      ])
    )
  );
  addPack(entries);
  return name;
}

// Runs fn (sync or async) with r_enhancedmodels at value and a client (not
// dedicated) state
async function withEnhanced(value, fn) {
  const oldValue = gl_model.r_enhancedmodels.value;
  const oldString = gl_model.r_enhancedmodels.string;
  const oldState = cls.state;
  gl_model.r_enhancedmodels.value = value;
  gl_model.r_enhancedmodels.string = String(value);
  if (cls.state === ca_dedicated) cls.state = 0;
  try {
    return await fn();
  } finally {
    gl_model.r_enhancedmodels.value = oldValue;
    gl_model.r_enhancedmodels.string = oldString;
    cls.state = oldState;
  }
}

// Parsing and skinning

Deno.test("MD5_ParseModel reads joints, mesh and every anim frame as a pose", () => {
  const md5 = gl_md5.MD5_ParseModel("progs/x.md5mesh", md5mesh("x"), MD5ANIM);
  assertEqual(md5.numjoints, 2, "numjoints");
  assertEqual(md5.names[1], "child", "joint name");
  assertEqual(md5.parents[1], 0, "parent");
  assertEqual(md5.numposes, 2, "one pose per anim frame");
  assertEqual(md5.shader, "x", "shader");
  assertEqual(md5.numverts, 3, "numverts");
  assertEqual(md5.numtris, 1, "numtris");
  assertEqual(md5.st[2], 1, "st");
  // bind-pose positions: the weight offsets moved by their joints
  assertNear(md5.xyz[0], 10, "v0 x");
  assertNear(md5.xyz[4], 10, "v1 y");
  assertNear(md5.xyz[8], 10, "v2 z (child joint)");
  assertEqual(md5.maxinfluences, 1, "maxinfluences");
});

Deno.test("MD5_SkinPose moves each vertex by its joint in that pose", () => {
  const md5 = gl_md5.MD5_ParseModel("progs/x.md5mesh", md5mesh("x"), MD5ANIM);
  const out = new Float32Array(9);
  const normals = new Float32Array(9);
  const lni = new Uint8Array(3);

  gl_md5.MD5_SkinPose(md5, 0, out, normals, lni);
  assertNear(out[0], 10, "pose 0 v0 x");
  assertNear(out[8], 10, "pose 0 v2 z");

  gl_md5.MD5_SkinPose(md5, 1, out, normals, lni);
  assertNear(out[0], 10, "pose 1 v0 x (root did not move)");
  assertNear(out[4], 10, "pose 1 v1 y");
  assertNear(out[8], 20, "pose 1 v2 z (child moved up 10)");

  // a unit normal, and its nearest Quake normal
  const len = Math.hypot(normals[0], normals[1], normals[2]);
  assertNear(len, 1, "unit normal");
  assertEqual(
    lni[0],
    gl_md5.MD5_NearestNormal(normals[0], normals[1], normals[2]),
    "lightnormalindex",
  );
});

Deno.test("MD5_NearestNormal picks the Quake normal closest to the direction", () => {
  for (const i of [0, 5, 37, 161]) {
    const n = r_avertexnormals[i];
    assertEqual(gl_md5.MD5_NearestNormal(n[0], n[1], n[2]), i, "normal " + i);
  }
});

Deno.test("MD5 vertices keep their four strongest weights, renormalised", () => {
  // v2 has five weights on child; the weakest (0.04) is dropped
  const mesh = md5mesh("x", {
    weights: [
      "weight 0 0 1 ( 10 0 0 )",
      "weight 1 0 1 ( 0 10 0 )",
      "weight 2 1 0.3 ( 0 0 0 )",
      "weight 3 1 0.2 ( 0 0 0 )",
      "weight 4 1 0.04 ( 0 0 0 )",
      "weight 5 1 0.26 ( 0 0 0 )",
      "weight 6 1 0.2 ( 0 0 0 )",
    ],
    counts: [[0, 1], [1, 1], [2, 5]],
  });
  const md5 = gl_md5.MD5_ParseModel("progs/x.md5mesh", mesh, MD5ANIM);
  assertEqual(md5.maxinfluences, 5, "maxinfluences counts every weight");
  let sum = 0;
  for (let k = 0; k < 4; k++) sum += md5.weight[8 + k];
  assertNear(sum, 1, "four weights sum to 1");
  assertNear(md5.weight[8], 0.3 / 0.96, "strongest first, renormalised");
  for (let k = 0; k < 4; k++) {
    if (Math.abs(md5.weight[8 + k] - 0.04 / 0.96) < 1e-4) {
      throw new Error("weakest weight kept");
    }
  }
});

Deno.test("MD5_ParseModel rejects a missing anim, extra meshes and bad indices", () => {
  const cases = [
    [md5mesh("x"), null, "has no poses"],
    [md5mesh("x", { nummeshes: 2 }), MD5ANIM, "only one is supported"],
    [
      md5mesh("x", {
        counts: [[0, 1], [1, 1], [2, 1]],
        weights: ["weight 0 5 1 ( 0 0 0 )"],
      }),
      MD5ANIM,
      "out of bounds",
    ],
    [
      md5mesh("x"),
      MD5ANIM.replace('"child" 0 7 0', '"elbow" 0 7 0'),
      "was renamed",
    ],
    ["MD5Version 11", MD5ANIM, 'expected "10"'],
  ];
  for (const [mesh, anim, message] of cases) {
    let error = null;
    try {
      gl_md5.MD5_ParseModel("progs/x.md5mesh", mesh, anim);
    } catch (e) {
      error = e;
    }

    if (error === null || !error.message.includes(message)) {
      throw new Error(
        `expected "${message}", got ${
          error === null ? "no error" : error.message
        }`,
      );
    }
  }
});

// Loading beside the .mdl

Deno.test("the influences-per-vertex notice is a developer print", () =>
  withEnhanced(1, () => {
    const mesh = md5mesh("__md5_" + serial, {
      weights: [0, 1, 2, 3, 4, 5, 6].map((i) =>
        `weight ${i} 0 ${i < 2 ? 1 : 0.2} ( 0 0 0 )`
      ),
      counts: [[0, 1], [1, 1], [2, 5]],
    });
    const name = addModel({ mesh: mesh });
    const printed = [];
    const developer = [];
    Con_SetPrintFunctions(
      (fmt) => printed.push(String(fmt)),
      (fmt) => developer.push(String(fmt)),
    );
    try {
      const mod = gl_model.Mod_ForName(name + ".mdl", true);
      assertEqual(mod.md5state, gl_model.MD5_DONE, "the MD5 loaded");
    } finally {
      Con_SetPrintFunctions(null, null);
    }
    const notice = (line) => line.includes("influences per vertex");
    assertEqual(developer.filter(notice).length, 1, "Con_DPrintf");
    assertEqual(printed.filter(notice).length, 0, "not Con_Printf");
  }));

Deno.test("an .md5mesh replaces the .mdl for drawing only", () =>
  withEnhanced(1, () => {
    const name = addModel();
    const mod = gl_model.Mod_ForName(name + ".mdl", true);
    const mdl = gl_model.Mod_Extradata(mod);
    const hdr = gl_model.Mod_EnhancedAliasHeader(mod);

    assertEqual(
      mod.md5state,
      gl_model.MD5_DONE,
      "loaded now: the files are in the pack",
    );
    assertEqual(hdr === mdl, false, "draws the MD5");
    assertEqual(hdr, mod.md5hdr, "md5hdr");
    assertEqual(hdr.md5 !== null && hdr.md5 !== undefined, true, "hdr.md5");
    // Quake frame n is pose n
    assertEqual(hdr.numframes, 2, "numframes");
    assertEqual(hdr.frames[1].firstpose, 1, "frame 1 firstpose");
    assertEqual(hdr.frames[1].numposes, 1, "frame 1 numposes");
    // the .mdl is still what everything else reads
    assertEqual(mod.cache.data, mdl, "cache.data is the .mdl");
    assertEqual(mdl.numframes, 1, ".mdl numframes");
    assertEqual(mod.mins[0], -16, ".mdl bounds");
    // the skin, at the lmp's size, with texels for the colormap
    assertEqual(hdr.numskins, 1, "numskins");
    assertEqual(hdr.skinwidth, 16, "skinwidth");
    assertEqual(hdr.skinheight, 8, "skinheight");
    assertEqual(hdr.texels[0][0], 3, "texels");
    const slots = hdr.gl_texturenum[0];
    assertEqual(
      slots[0] !== null && slots[0] !== undefined,
      true,
      "skin 0 frame 0",
    );
    assertEqual(slots[1], slots[0], "one frame fills slot 1");
    assertEqual(slots[2], slots[0], "and slot 2");
    assertEqual(slots[3], slots[0], "and slot 3");
  }));

Deno.test("MD5 skins: several skins, and two frames fill four slots", () =>
  withEnhanced(1, () => {
    const name = addModel({ skins: [[1, 2], [4]] });
    const mod = gl_model.Mod_ForName(name + ".mdl", true);
    const hdr = gl_model.Mod_EnhancedAliasHeader(mod);
    assertEqual(hdr.numskins, 2, "numskins");
    const a = hdr.gl_texturenum[0];
    assertEqual(a[0] !== a[1], true, "two frames");
    assertEqual(a[2], a[0], "slot 2 is frame 0");
    assertEqual(a[3], a[1], "slot 3 is frame 1");
    assertEqual(hdr.texels[1][0], 4, "skin 1 texels");
  }));

Deno.test("r_enhancedmodels 0 draws the .mdl, and 1 loads the MD5 when first drawn", async () => {
  let mod;
  let mdl;
  const name = addModel();
  await withEnhanced(0, () => {
    mod = gl_model.Mod_ForName(name + ".mdl", true);
    mdl = gl_model.Mod_Extradata(mod);
    assertEqual(mod.md5state, gl_model.MD5_UNTRIED, "not looked for");
    assertEqual(gl_model.Mod_EnhancedAliasHeader(mod), mdl, "off: the .mdl");
  });
  await withEnhanced(1, () => {
    const hdr = gl_model.Mod_EnhancedAliasHeader(mod);
    assertEqual(hdr !== mdl && hdr.md5 != null, true, "on: the MD5");
  });
  await withEnhanced(
    0,
    () => assertEqual(gl_model.Mod_EnhancedAliasHeader(mod), mdl, "off again"),
  );
});

Deno.test("a bad or incomplete MD5 leaves the .mdl, with a warning", () =>
  withEnhanced(1, () => {
    for (
      const opts of [{ anim: null }, { mesh: "MD5Version 10 numJoints" }, {
        mesh: md5mesh("x", { nummeshes: 2 }),
      }]
    ) {
      const name = addModel(opts);
      const mod = gl_model.Mod_ForName(name + ".mdl", true);
      assertEqual(mod.md5hdr, null, "no md5hdr");
      assertEqual(
        gl_model.Mod_EnhancedAliasHeader(mod),
        gl_model.Mod_Extradata(mod),
        "the .mdl",
      );
    }
  }));

Deno.test("an .md5mesh in a lower search path than the .mdl is not used", () =>
  withEnhanced(1, () => {
    const name = "progs/__md5_low_" + (serial++);
    const shader = name.substring(6);
    addPack([
      [name + ".md5mesh", encoder.encode(md5mesh(shader))],
      [name + ".md5anim", encoder.encode(MD5ANIM)],
    ]);
    addPack([[name + ".mdl", buildMdl()]]); // a mod's .mdl
    const mod = gl_model.Mod_ForName(name + ".mdl", true);
    assertEqual(mod.md5hdr, null, "the mod .mdl wins");
  }));

Deno.test("a dedicated server never loads MD5s", () => {
  const oldState = cls.state;
  cls.state = ca_dedicated;
  try {
    const name = addModel();
    const mod = gl_model.Mod_ForName(name + ".mdl", true);
    assertEqual(mod.md5hdr, null, "no md5hdr");
    assertEqual(mod.md5state, gl_model.MD5_DONE, "not looked for again");
  } finally {
    cls.state = oldState;
  }
});

// Drawing

Deno.test("GL_DrawAliasFrame skins an MD5 pose once and shares the uvs and index", () =>
  withEnhanced(1, () => {
    const name = addModel();
    const mod = gl_model.Mod_ForName(name + ".mdl", true);
    const hdr = gl_model.Mod_EnhancedAliasHeader(mod);

    const t0 = gl_mesh.GL_DrawAliasFrame(hdr, 0);
    const t1 = gl_mesh.GL_DrawAliasFrame(hdr, 1);
    assertEqual(gl_mesh.GL_DrawAliasFrame(hdr, 1), t1, "cached");
    assertEqual(gl_mesh.GL_DrawAliasFrame(hdr, 2), null, "no pose 2");
    assertEqual(t0.vertexCount, 3, "vertexCount");
    assertEqual(t0.uvAttr, t1.uvAttr, "shared uvs");
    assertEqual(t0.indexAttr, t1.indexAttr, "shared index");
    assertNear(t0.posAttr.array[8], 10, "pose 0 v2 z");
    assertNear(t1.posAttr.array[8], 20, "pose 1 v2 z");
    assertEqual(t0.lightnormalindices.length, 3, "lightnormalindices");
    // turned round like the .mdl's triangles
    const index = t0.indexAttr.array;
    assertEqual(`${index[0]},${index[1]},${index[2]}`, "0,2,1", "winding");
  }));

function buildEntity(mod) {
  return {
    frame: 0,
    lerpflags: 0,
    colormap: null,
    model: mod,
    origin: new Float32Array(3),
    angles: new Float32Array(3),
    currentorigin: new Float32Array(3),
    currentangles: new Float32Array(3),
    previousorigin: new Float32Array(3),
    previousangles: new Float32Array(3),
  };
}

const DOTS = new Float32Array(162).fill(1);
const SHADE = new Float64Array([0.5, 0.5, 0.5]);

Deno.test("one entity drawn as the .mdl, then the MD5: geometry, frames and shadow follow the header", () =>
  withEnhanced(1, () => {
    const name = addModel();
    const mod = gl_model.Mod_ForName(name + ".mdl", true);
    const mdl = gl_model.Mod_Extradata(mod);
    const md5 = gl_model.Mod_EnhancedAliasHeader(mod);
    const e = buildEntity(mod);
    const lerpdata = new gl_mesh.lerpdata_t();
    const lightspot = new Float32Array(3);
    const shadevector = new Float32Array([0.5, 0.5, 1]);

    // both have 3 vertices, so only the index tells them apart
    gl_mesh.R_DrawAliasModel(e, mdl, DOTS, SHADE);
    gl_mesh.R_SetupAliasFrame(e, mdl, 0, lerpdata);
    gl_mesh.GL_DrawAliasShadow(e, mdl, lerpdata, lightspot, shadevector);
    const mdlIndex = gl_mesh.GL_DrawAliasFrame(mdl, 0).indexAttr;
    assertEqual(e._aliasShadowGeo.index, mdlIndex, ".mdl shadow index");

    e.frame = 1;
    gl_mesh.R_DrawAliasModel(e, md5, DOTS, SHADE);
    const t1 = gl_md5.GL_DrawMD5Frame(md5, 1);
    assertEqual(e._aliasGeo.index, t1.indexAttr, "MD5 index");
    gl_mesh.R_SetupAliasFrame(e, md5, 1, lerpdata);
    assertEqual(lerpdata.pose2, 1, "frame 1 is pose 1");
    gl_mesh.GL_DrawAliasShadow(e, md5, lerpdata, lightspot, shadevector);
    assertEqual(
      e._aliasShadowGeo.index,
      t1.indexAttr,
      "shadow rebuilt for the MD5",
    );

    // a frame the .mdl has but the MD5 lacks, or the reverse, draws frame 0
    e.frame = 7;
    gl_mesh.R_DrawAliasModel(e, md5, DOTS, SHADE);
    gl_mesh.R_SetupAliasFrame(e, md5, 7, lerpdata);
    assertEqual(lerpdata.pose2, 0, "past numposes: pose 0");
  }));

Deno.test("a player skin translated from the .mdl is translated again for its MD5, once", async () => {
  const name = addModel({ skins: [[3]] });
  const bare = addModel({ skins: [] }); // an MD5 with no skin files
  const ent = cl_entities[1];
  const old = {
    scores: cl.scores,
    maxclients: cl.maxclients,
    model: ent.model,
    skinnum: ent.skinnum,
    colormap: ent.colormap,
  };
  try {
    cl.scores = [{ colors: 0x4c }];
    cl.maxclients = 1;
    ent.skinnum = 0;
    ent.colormap = 1;
    ent.frame = 0;
    ent.lerpflags = 0;

    for (const [base, translates] of [[name, true], [bare, false]]) {
      let mod;
      let mdl;
      let md5;
      // translated while r_enhancedmodels was 0: the .mdl's skin
      await withEnhanced(0, () => {
        mod = gl_model.Mod_ForName(base + ".mdl", true);
        mdl = gl_model.Mod_Extradata(mod);
        ent.model = mod;
        gl_rmisc.R_TranslatePlayerSkin(0);
      });
      const mdlTexture = gl_rmisc.R_GetPlayerSkinTexture(0);
      assertEqual(mdlTexture._paliashdr, mdl, base + ": .mdl translation");

      await withEnhanced(1, () => {
        md5 = gl_model.Mod_EnhancedAliasHeader(mod);
        assertEqual(md5 !== mdl, true, base + ": MD5 loaded");
        gl_mesh.R_DrawAliasModel(ent, md5, DOTS, SHADE);
        const texture = gl_rmisc.R_GetPlayerSkinTexture(0);
        if (translates) {
          assertEqual(
            texture._paliashdr,
            md5,
            base + ": translated for the MD5",
          );
          assertEqual(
            texture.image.width,
            16,
            base + ": at the MD5 skin width",
          );
          gl_mesh.R_DrawAliasModel(ent, md5, DOTS, SHADE);
          assertEqual(
            gl_rmisc.R_GetPlayerSkinTexture(0),
            texture,
            base + ": not again",
          );
        } else {
          assertEqual(texture, mdlTexture, base + ": no skin to translate");
          assertEqual(ent._skinRetranslated, md5, base + ": tried once");
        }
      });
    }
  } finally {
    cl.scores = old.scores;
    cl.maxclients = old.maxclients;
    ent.model = old.model;
    ent.skinnum = old.skinnum;
    ent.colormap = old.colormap;
  }
});

// Lazily opened paks

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
    bytes.set(encoder.encode(name), e);
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

Deno.test("a lazy pak fetches the .md5mesh and .md5anim when the model loads", () =>
  lazyTest(false));
Deno.test("a failed MD5 fetch leaves the .mdl", () => lazyTest(true));

async function lazyTest(fail) {
  const wasModified = com_modified;
  const realFetch = globalThis.fetch;
  const log = [];
  const name = "progs/__md5_lazy" + (fail ? "_fail" : "");
  const shader = name.substring(6);
  const pak = makePak([
    [name + ".mdl", buildMdl()],
    [name + ".md5mesh", encoder.encode(md5mesh(shader))],
    [name + ".md5anim", encoder.encode(MD5ANIM)],
    ["progs/" + shader + "_00_00.lmp", lmp(16, 8, 3)],
  ]);
  COM_SetLazyPakSize(0);
  const url = "http://md5.test/" + (fail ? "b" : "a") + "/pak0.pak";
  const files = new Map([[url, pak]]);
  globalThis.fetch = stubFetch(files, log);
  try {
    await withEnhanced(1, async () => {
      assertEqual(await COM_AddPakSequence(url), 1, "pak added");
      assertEqual(COM_FindFile(name + ".md5mesh"), null, ".md5mesh deferred");
      assertEqual(await COM_EnsureFile(name + ".mdl"), true, ".mdl fetched");
      if (fail) files.delete(url); // the pak is gone when the MD5 is fetched
      const mod = gl_model.Mod_ForName(name + ".mdl", true);
      assertEqual(mod.md5state, gl_model.MD5_PENDING, "fetching");
      assertEqual(
        gl_model.Mod_EnhancedAliasHeader(mod),
        gl_model.Mod_Extradata(mod),
        ".mdl meanwhile",
      );

      for (let i = 0; i < 50 && mod.md5state === gl_model.MD5_PENDING; i++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      assertEqual(mod.md5state, gl_model.MD5_DONE, "fetched");
      if (fail) {
        assertEqual(mod.md5hdr, null, "no MD5");
        assertEqual(
          gl_model.Mod_EnhancedAliasHeader(mod),
          gl_model.Mod_Extradata(mod),
          "the .mdl",
        );
        return;
      }

      assertEqual(
        mod.md5hdr !== null && mod.md5hdr.numframes === 2,
        true,
        "MD5 loaded",
      );
      assertEqual(
        mod.md5hdr.numskins,
        1,
        "its .lmp skin, fetched with the pak",
      );
      assertEqual(
        log.filter((l) => l.includes("bytes=")).length >= 2,
        true,
        "range requests: " + log.join("; "),
      );
    });
  } finally {
    COM_SetLazyPakSize(COM_LAZY_PAK_SIZE);
    COM_SetLooseFileBasePaths(["static/"]);
    globalThis.fetch = realFetch;
    COM_SetModified(wasModified); // test paks are not the original pak0
  }
}
