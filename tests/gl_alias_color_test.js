// R_DrawAliasModel rewrites and re-uploads an entity's vertex colours only
// when its lighting inputs change, not on every frame.

// Bootstrap the renderer's existing circular module graph in its safe order.
await import("../src/gl_rsurf.js");

const gl_mesh = await import("../src/gl_mesh.js");
const glquake = await import("../src/glquake.js");

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

function floatBits(f) {
  const v = new DataView(new ArrayBuffer(4));
  v.setFloat32(0, f, true);
  return v.getInt32(0, true);
}

// One frame, one pose of a 4-vertex strip, lit through normals 0 and 1.
function buildHeader() {
  const pose = [0, 1, 2, 3].map((i) => ({
    v: [i, i, i],
    lightnormalindex: i & 1,
  }));
  const commands = [4];
  for (let i = 0; i < 4; i++) commands.push(floatBits(i / 4), floatBits(0));
  commands.push(0);
  return {
    commands,
    posedata: [pose],
    numframes: 1,
    numposes: 1,
    numskins: 0,
    scale: [1, 1, 1],
    scale_origin: [0, 0, 0],
  };
}

function buildEntity() {
  return {
    frame: 0,
    lerpflags: 0,
    colormap: null,
    model: { name: "progs/test.mdl", type: 2, flags: 0 },
    origin: new Float32Array(3),
    angles: new Float32Array(3),
    currentorigin: new Float32Array(3),
    currentangles: new Float32Array(3),
    previousorigin: new Float32Array(3),
    previousangles: new Float32Array(3),
  };
}

Deno.test("R_DrawAliasModel updates vertex colours only when the lighting changes", () => {
  const oldOverbright = glquake.gl_overbright_models.value;
  glquake.gl_overbright_models.value = 0;
  try {
    vertexColourCacheTest();
  } finally {
    glquake.gl_overbright_models.value = oldOverbright;
  }
});

function vertexColourCacheTest() {
  const paliashdr = buildHeader();
  const entity = buildEntity();
  const dotsA = new Float32Array([0.5, 1.0]);
  const dotsB = new Float32Array([1.0, 0.5]);

  // one scratch shade, rewritten in place as gl_rmain.js's shadecolor is
  const shade = new Float64Array(3);
  const draw = (dots, light) => {
    if (typeof light === "number") shade.fill(light);
    else shade.set(light);
    gl_mesh.R_DrawAliasModel(entity, paliashdr, dots, shade);
    const color = entity._aliasGeo.attributes.color;
    const updated = color.needsUpdate;
    color.needsUpdate = false;
    return updated;
  };

  assertEqual(draw(dotsA, 0.5), true, "first draw writes the colours");
  const colors = entity._aliasGeo.attributes.color.array;
  assertEqual(
    colors[0],
    Math.fround(gl_mesh.GL_AliasLight(0.25)),
    "vertex 0 lit by normal 0",
  );
  assertEqual(
    colors[3],
    Math.fround(gl_mesh.GL_AliasLight(0.5)),
    "vertex 1 lit by normal 1",
  );

  assertEqual(draw(dotsA, 0.5), false, "same lighting: no rewrite");

  assertEqual(draw(dotsA, 0.8), true, "new shadelight rewrites");
  assertEqual(
    colors[0],
    Math.fround(gl_mesh.GL_AliasLight(0.4)),
    "vertex 0 at the new shadelight",
  );

  assertEqual(draw(dotsB, 0.8), true, "new shade table rewrites");
  assertEqual(
    colors[0],
    Math.fround(gl_mesh.GL_AliasLight(0.8)),
    "vertex 0 from the new table",
  );

  // .lit: each channel lit by its own shade; a change in one channel rewrites
  assertEqual(draw(dotsB, [0.8, 0.4, 0.2]), true, "tinted shade rewrites");
  assertEqual(
    colors[0],
    Math.fround(gl_mesh.GL_AliasLight(0.8)),
    "vertex 0 red",
  );
  assertEqual(
    colors[1],
    Math.fround(gl_mesh.GL_AliasLight(0.4)),
    "vertex 0 green",
  );
  assertEqual(
    colors[2],
    Math.fround(gl_mesh.GL_AliasLight(0.2)),
    "vertex 0 blue",
  );
  assertEqual(
    colors[4],
    Math.fround(gl_mesh.GL_AliasLight(0.2)),
    "vertex 1 green",
  );
  assertEqual(draw(dotsB, [0.8, 0.4, 0.2]), false, "same tint: no rewrite");
  assertEqual(draw(dotsB, [0.8, 0.4, 0.3]), true, "new blue rewrites");
  assertEqual(
    colors[2],
    Math.fround(gl_mesh.GL_AliasLight(0.3)),
    "vertex 0 new blue",
  );
  assertEqual(draw(dotsB, 0.8), true, "back to mono rewrites");

  // A cleared entity cache (_clearEntityMeshCache) must relight the new buffer.
  entity._aliasGeo = null;
  entity._aliasColorArray = null;
  entity._aliasMesh = null;
  assertEqual(draw(dotsB, 0.8), true, "rebuilt geometry is relit");

  // gl_overbright_models: a toggle relights the same shade, doubled after
  // the clamp to 1
  glquake.gl_overbright_models.value = 1;
  assertEqual(draw(dotsB, 0.8), true, "overbright toggle rewrites");
  assertEqual(
    entity._aliasGeo.attributes.color.array[0],
    Math.fround(gl_mesh.GL_AliasLight(0.8, true)),
    "vertex 0 overbright",
  );
  assertEqual(draw(dotsB, 0.8), false, "same overbright: no rewrite");
}

Deno.test("GL_AliasLight doubles the clamped level for gl_overbright_models", () => {
  // Ironwail's alias vertex shader: clamp to 1, then double (display space)
  assertEqual(gl_mesh.GL_AliasLight(0.2, true), 0.4, "doubles");
  assertEqual(gl_mesh.GL_AliasLight(1.8, true), 2, "clamp then double");
  assertEqual(gl_mesh.GL_AliasLight(-1, true), 0, "negative is dark");
  assertEqual(gl_mesh.GL_AliasLight(1.8), 1, "without overbright clamps");
});
