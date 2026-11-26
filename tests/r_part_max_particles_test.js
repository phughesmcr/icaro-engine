// Bootstrap the renderer's existing circular module graph in its safe order.
await import("../src/gl_rsurf.js");

const THREE = await import("three");
const { cl } = await import("../src/client.js");
const glquake = await import("../src/glquake.js");
const common = await import("../src/common.js");
const r_part = await import("../src/r_part.js");
const {
  R_InitParticles,
  R_SetParticleExternals,
  R_ClearParticles,
  R_ParticleExplosion,
  R_DrawParticles,
  R_MarkParticleUpload,
} = r_part;

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

Deno.test("the particle pool holds Ironwail's 16384 particles", () => {
  const oldTime = cl.time;
  const oldOldtime = cl.oldtime;
  const oldTextures = glquake._allGameTextures.slice();
  const scene = new THREE.Scene();

  try {
    R_InitParticles();
    R_SetParticleExternals({ scene: scene });
    cl.time = 10;
    cl.oldtime = 10;

    // Each explosion takes 1024 particles; id's 2048 held only two
    const org = new Float32Array(3);
    for (let i = 0; i < 17; i++) R_ParticleExplosion(org);

    R_DrawParticles();
    const geometry = scene.children[0].geometry;
    assertEqual(
      geometry.drawRange.count,
      16384,
      "live particles after 17 explosions",
    );
  } finally {
    R_ClearParticles();
    R_DrawParticles();
    cl.time = oldTime;
    cl.oldtime = oldOldtime;
    glquake._allGameTextures.splice(
      0,
      glquake._allGameTextures.length,
      ...oldTextures,
    );
  }
});

Deno.test("R_MarkParticleUpload uploads only the live particles", () => {
  const ranges = [];
  const attribute = {
    itemSize: 3,
    needsUpdate: false,
    clearUpdateRanges() {
      ranges.length = 0;
    },
    addUpdateRange(start, count) {
      ranges.push([start, count]);
    },
  };

  R_MarkParticleUpload(attribute, 10);
  R_MarkParticleUpload(attribute, 25);
  assertEqual(ranges.length, 1, "one range");
  assertEqual(ranges[0][0], 0, "range start");
  assertEqual(ranges[0][1], 75, "range length in floats");
  assertEqual(attribute.needsUpdate, true, "needsUpdate");

  // The server shim has no update ranges
  const plain = { itemSize: 3, needsUpdate: false };
  R_MarkParticleUpload(plain, 5);
  assertEqual(plain.needsUpdate, true, "plain attribute needsUpdate");
});

// Fills the pool with explosions (1024 particles each), draws once and
// returns the points mesh, or null if nothing was drawn
function fillAndDraw(scene) {
  R_SetParticleExternals({ scene: scene });
  cl.time = 10;
  cl.oldtime = 10;
  const org = new Float32Array(3);
  for (let i = 0; i < 40; i++) R_ParticleExplosion(org);
  R_DrawParticles();
  return scene.children.length > 0 ? scene.children[0] : null;
}

Deno.test("-particles sizes the pool like r_part.c R_InitParticles", () => {
  const oldArgv = common.com_argv;
  const oldTime = cl.time;
  const oldOldtime = cl.oldtime;
  const oldTextures = glquake._allGameTextures.slice();

  try {
    // Default: MAX_PARTICLES
    common.COM_InitArgv(["quake"]);
    R_InitParticles();
    const small = fillAndDraw(new THREE.Scene());
    assertEqual(r_part.r_numparticles, 16384, "default size");
    assertEqual(
      small.geometry.drawRange.count,
      16384,
      "default pool fills at 16384",
    );

    // Below ABSOLUTE_MIN_PARTICLES: raised to 512
    common.COM_InitArgv(["quake", "-particles", "100"]);
    R_InitParticles();
    assertEqual(r_part.r_numparticles, 512, "clamped to the minimum");
    assertEqual(small.parent, null, "the old mesh left the scene");
    const scene512 = new THREE.Scene();
    const mesh512 = fillAndDraw(scene512);
    assertEqual(mesh512 !== small, true, "a new mesh for the new buffers");
    assertEqual(mesh512.geometry.drawRange.count, 512, "pool fills at 512");
    assertEqual(
      mesh512.geometry.attributes.position.array.length,
      512 * 3,
      "position buffer size",
    );

    // No upper cap; the upload buffers follow the pool
    common.COM_InitArgv(["quake", "-particles", "20000"]);
    R_InitParticles();
    const big = fillAndDraw(new THREE.Scene());
    assertEqual(r_part.r_numparticles, 20000, "no maximum");
    assertEqual(big.geometry.drawRange.count, 20000, "pool fills at 20000");
    assertEqual(
      big.geometry.attributes.position.array.length,
      20000 * 3,
      "position buffer size",
    );
    assertEqual(
      big.geometry.attributes.color.array.length,
      20000 * 3,
      "color buffer size",
    );

    // Re-initialising at the same size keeps the mesh and its buffers
    R_InitParticles();
    R_ClearParticles();
    assertEqual(
      fillAndDraw(big.parent) === big,
      true,
      "same size keeps the mesh",
    );

    // Ironwail: no number after -particles keeps the default
    common.COM_InitArgv(["quake", "-particles"]);
    R_InitParticles();
    assertEqual(r_part.r_numparticles, 16384, "trailing -particles");
  } finally {
    common.COM_InitArgv(oldArgv);
    R_InitParticles();
    R_ClearParticles();
    R_DrawParticles();
    cl.time = oldTime;
    cl.oldtime = oldOldtime;
    glquake._allGameTextures.splice(
      0,
      glquake._allGameTextures.length,
      ...oldTextures,
    );
  }
});
