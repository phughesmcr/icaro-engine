// Alias model skins get a fullbright mask (QuakeSpasm gl_fullbrights 1):
// fullbright palette entries keep their colour in the skin and show unlit
// through AliasMaterial's fragment shader patch.

// Bootstrap the renderer's existing circular module graph in its safe order.
await import("../src/gl_rsurf.js");

const gl_model = await import("../src/gl_model.js");
const gl_mesh = await import("../src/gl_mesh.js");
const { R183_MESHBASIC_FRAGMENT } = await import("./three_r183_shaders.js");
const { entity_t } = await import("../src/client.js");
const { COM_AddPack } = await import("../src/pak.js");
const { d_8to24table, vid } = await import("../src/vid.js");

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

// A one-frame, one-triangle MDL with a single 8x8 skin of the given pixels.
function buildMdl(skin, flags = 0) {
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
  view.setInt32(76, flags, true);
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

let serial = 0;

function loadMdl(bytes) {
  const name = "progs/__fullbright_" + (serial++) + ".mdl";
  COM_AddPack({
    files: [{ name: name, filepos: 0, filelen: bytes.length }],
    data: bytes.buffer,
  });
  const oldFullbright = vid.fullbright;
  try {
    vid.fullbright = 224; // VID_SetPalette's value; tests never run it
    const mod = gl_model.Mod_ForName(name, true);
    const hdr = gl_model.Mod_Extradata(mod);
    return { mod, hdr };
  } finally {
    vid.fullbright = oldFullbright;
  }
}

// pixel 0 (the flood fill seed) is a dark colour; pixel 9 is fullbright
const NORMAL = 15;
const FULLBRIGHT = 250;

function skinWithFullbright() {
  const skin = new Uint8Array(64).fill(NORMAL);
  skin[9] = FULLBRIGHT;
  return skin;
}

Deno.test("alias skins keep fullbright pixels and get a fullbright mask", () => {
  const { hdr } = loadMdl(buildMdl(skinWithFullbright()));
  const texture = hdr.gl_texturenum[0][0];
  const fullbright = texture._fullbright;
  if (fullbright == null) throw new Error("no fullbright texture");

  const color = d_8to24table[FULLBRIGHT];
  assertEqual(
    texture.image.data[9 * 4],
    color & 0xff,
    "skin keeps the fullbright colour",
  );
  assertEqual(fullbright.image.data[9 * 4], color & 0xff, "mask colour");
  assertEqual(
    fullbright.image.data[9 * 4 + 3],
    255,
    "mask alpha on the fullbright pixel",
  );
  assertEqual(fullbright.image.data[8 * 4 + 3], 0, "mask alpha elsewhere");

  // without a palette (the server) no mask is made
  const name = "progs/__fullbright_nopalette.mdl";
  const bytes = buildMdl(skinWithFullbright());
  COM_AddPack({
    files: [{ name: name, filepos: 0, filelen: bytes.length }],
    data: bytes.buffer,
  });
  const serverHdr = gl_model.Mod_Extradata(gl_model.Mod_ForName(name, true));
  assertEqual(
    serverHdr.gl_texturenum[0][0]._fullbright == null,
    true,
    "no mask without a palette",
  );

  // a skin with no fullbright pixels gets no mask
  const { hdr: plain } = loadMdl(buildMdl(new Uint8Array(64).fill(NORMAL)));
  assertEqual(
    plain.gl_texturenum[0][0]._fullbright == null,
    true,
    "no mask without fullbrights",
  );
});

Deno.test("alias materials draw the fullbright mask and keep it when cloned", () => {
  const { mod, hdr } = loadMdl(buildMdl(skinWithFullbright()));
  const e = new entity_t();
  e.model = mod;
  const material = gl_mesh.R_GetAliasMaterial(hdr, e, true, null);
  assertEqual(material instanceof gl_mesh.AliasMaterial, true, "AliasMaterial");
  assertEqual(
    material.fullbrightMap,
    hdr.gl_texturenum[0][0]._fullbright,
    "fullbright map",
  );

  const shader = {
    uniforms: {},
    vertexShader: "#include <begin_vertex>",
    fragmentShader: R183_MESHBASIC_FRAGMENT,
  };
  material.onBeforeCompile(shader);
  assertEqual(
    shader.uniforms.fullbrightMap.value,
    material.fullbrightMap,
    "uniform",
  );
  // the mask gives only the weight; the colour comes from the skin
  assertEqual(
    shader.fragmentShader.includes("texture2D( map, vMapUv ).rgb"),
    true,
    "skin colour",
  );
  assertEqual(
    shader.fragmentShader.includes("texture2D( fullbrightMap, vMapUv ).a"),
    true,
    "mask alpha",
  );
  assertEqual(
    shader.vertexShader.includes("r_lerpblend"),
    false,
    "no lerp without r_lerpmodels",
  );
  // the skin is lit by the vertex colour on encoded values, in place of
  // three's linear color_fragment
  assertEqual(
    shader.fragmentShader.includes("#include <color_fragment>"),
    false,
    "color_fragment replaced",
  );
  assertEqual(
    shader.fragmentShader.includes(
      "sRGBTransferOETF( vec4( diffuseColor.rgb, 1.0 ) ).rgb * vColor.rgb",
    ),
    true,
    "encoded modulate",
  );
  // the lit skin is clamped before the fullbright pixels are mixed in
  const clampAt = shader.fragmentShader.indexOf("min( outgoingLight");
  const maskAt = shader.fragmentShader.indexOf("fullbrightMap, vMapUv");
  assertEqual(clampAt !== -1 && clampAt < maskAt, true, "clamp before mask");

  // gl_rmain.js clones the view model's material for its depth hack.
  // Material.copy doesn't copy an instance's onBeforeCompile, so the hooks
  // must be class methods. (The Deno three shim has no clone to try.)
  for (const hook of ["onBeforeCompile", "customProgramCacheKey", "copy"]) {
    assertEqual(
      Object.hasOwn(material, hook),
      false,
      `${hook} is not an own property`,
    );
    assertEqual(
      Object.hasOwn(gl_mesh.AliasMaterial.prototype, hook),
      true,
      `${hook} on the class`,
    );
  }

  // no mask: the plain program
  const { mod: plainMod, hdr: plainHdr } = loadMdl(
    buildMdl(new Uint8Array(64).fill(NORMAL)),
  );
  const p = new entity_t();
  p.model = plainMod;
  const plainMaterial = gl_mesh.R_GetAliasMaterial(plainHdr, p, true, null);
  assertEqual(plainMaterial.fullbrightMap, null, "no fullbright map");
  const plainShader = {
    uniforms: {},
    vertexShader: "",
    fragmentShader: "#include <color_fragment>\n#include <opaque_fragment>",
  };
  plainMaterial.onBeforeCompile(plainShader);
  // only the encoded-space modulate (GLQuake's GL_MODULATE) and the clamp to
  // 1 that gl_overbright_models needs (QuakeSpasm, Ironwail)
  assertEqual(
    plainShader.fragmentShader,
    gl_mesh.ALIAS_MODULATE_GLSL +
      "\noutgoingLight = min( outgoingLight, vec3( 1.0 ) );\n\t#include <opaque_fragment>",
    "plain shader only modulated and clamped",
  );
  if (
    plainMaterial.customProgramCacheKey() === material.customProgramCacheKey()
  ) {
    throw new Error("fullbright and plain materials share a program key");
  }
});

Deno.test("a new fullbright map reaches the compiled uniform", () => {
  const material = new gl_mesh.AliasMaterial({ map: { isTexture: true } });
  const a = { name: "a" };
  const b = { name: "b" };
  material.fullbrightMap = a;
  const shader = {
    uniforms: {},
    vertexShader: "",
    fragmentShader: R183_MESHBASIC_FRAGMENT,
  };
  material.onBeforeCompile(shader);
  material.fullbrightMap = b;
  assertEqual(
    shader.uniforms.fullbrightMap.value,
    b,
    "uniform follows the map",
  );
});

Deno.test("world textures still black out their fullbright pixels by default", () => {
  const pixels = new Uint8Array(64).fill(NORMAL);
  pixels[9] = FULLBRIGHT;
  const oldFullbright = vid.fullbright;
  try {
    vid.fullbright = 224;
    const world = gl_model.GL_LoadTexture(
      "__fb_world",
      8,
      8,
      pixels,
      false,
      false,
      true,
    );
    const skin = gl_model.GL_LoadTexture(
      "__fb_skin",
      8,
      8,
      pixels,
      false,
      false,
      true,
      true,
    );
    assertEqual(
      world.image.data[9 * 4],
      0,
      "world base is black on the fullbright pixel",
    );
    assertEqual(world._fullbright.image.data[9 * 4 + 3], 255, "world mask");
    assertEqual(
      skin.image.data[9 * 4],
      d_8to24table[FULLBRIGHT] & 0xff,
      "keepBase keeps the colour",
    );
  } finally {
    vid.fullbright = oldFullbright;
  }
});

Deno.test("player skins and lerp materials carry the model skin mask", () => {
  const { mod, hdr } = loadMdl(buildMdl(skinWithFullbright()));
  const mask = hdr.gl_texturenum[0][0]._fullbright;

  // a translated player skin takes the model skin's mask
  const e = new entity_t();
  e.model = mod;
  const translated = { isTexture: true, name: "translated" };
  const player = gl_mesh.R_GetAliasMaterial(hdr, e, true, translated);
  assertEqual(player.map, translated, "player map");
  assertEqual(player.fullbrightMap, mask, "player mask");

  // The Deno three shim has no Material.copy or Color.copy: stub them
  const stubs = [
    Object.getPrototypeOf(gl_mesh.AliasMaterial.prototype),
    Object.getPrototypeOf(player.color),
  ].map((proto) => ({
    proto,
    had: Object.hasOwn(proto, "copy"),
    old: proto.copy,
  }));
  for (const stub of stubs) {
    stub.proto.copy = function () {
      return this;
    };
  }
  try {
    // copy() carries the mask and the lerp blend
    const copyOf = (m) => new gl_mesh.AliasMaterial().copy(m);
    const copied = copyOf(player);
    assertEqual(copied.fullbrightMap, mask, "copied mask");
    assertEqual(copied._lerpblend, null, "copied blend");

    // r_lerpmodels: the per-entity material follows its base,
    // recompiling when the fullbright pass turns on or off
    const base = gl_mesh.R_GetAliasMaterial(hdr, e, true, null);
    const plainBase = new gl_mesh.AliasMaterial({
      map: translated,
      vertexColors: true,
    });
    const l = new entity_t();
    const lerp = gl_mesh.R_GetAliasLerpMaterial(l, base, 0.25);
    assertEqual(lerp.fullbrightMap, mask, "lerp mask");
    assertEqual(lerp._lerpblend.value, 0.25, "lerp blend");
    assertEqual(
      lerp.customProgramCacheKey(),
      "alias-lerp-fullbright",
      "lerp program key",
    );
    assertEqual(copyOf(lerp)._lerpblend, lerp._lerpblend, "copied lerp blend");

    lerp.needsUpdate = false; // a plain flag in the shim
    gl_mesh.R_GetAliasLerpMaterial(l, plainBase, 0.5);
    assertEqual(lerp.fullbrightMap, null, "mask dropped");
    assertEqual(
      lerp.customProgramCacheKey(),
      "alias-lerp",
      "plain lerp program key",
    );
    assertEqual(lerp.needsUpdate, true, "recompile when the mask goes away");
    assertEqual(lerp._lerpblend.value, 0.5, "new blend");
  } finally {
    for (const stub of stubs) {
      if (stub.had) stub.proto.copy = stub.old;
      else delete stub.proto.copy;
    }
  }
});
