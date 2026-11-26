// Bootstrap the renderer's existing circular module graph in its safe order.
await import("../src/gl_rsurf.js");

const gl_model = await import("../src/gl_model.js");
const glquake = await import("../src/glquake.js");
const { Cvar_FindVar, Cvar_RegisterVariable, Cvar_Set } = await import(
  "../src/cvar.js"
);

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

Deno.test("gl_texture_anisotropy is clamped and re-applied to mipmapped textures only", () => {
  const cvar = gl_model.gl_texture_anisotropy;
  if (Cvar_FindVar(cvar.name) === null) Cvar_RegisterVariable(cvar);

  const oldString = cvar.string;
  const oldArchive = cvar.archive;
  cvar.archive = false; // keep the test out of localStorage

  const mipmapped = {
    generateMipmaps: true,
    anisotropy: 4,
    needsUpdate: false,
  };
  const flat = { generateMipmaps: false, anisotropy: 4, needsUpdate: false };
  glquake.GL_RegisterTexture(mipmapped);
  glquake.GL_RegisterTexture(flat);

  try {
    assertEqual(cvar.string, "1", "default");

    // No renderer (Deno), so the driver maximum is 1: TexMgr_Anisotropy_f
    // clamps the cvar back and re-filters the mipmapped textures.
    Cvar_Set(cvar.name, "8");
    gl_model.GL_CheckAnisotropy();
    assertEqual(cvar.value, 1, "clamped to the driver maximum");
    assertEqual(mipmapped.anisotropy, 1, "mipmapped texture re-filtered");
    assertEqual(mipmapped.needsUpdate, true, "mipmapped texture re-uploaded");
    assertEqual(flat.anisotropy, 4, "texture without mipmaps untouched");
    assertEqual(
      flat.needsUpdate,
      false,
      "texture without mipmaps not re-uploaded",
    );

    Cvar_Set(cvar.name, "0");
    gl_model.GL_CheckAnisotropy();
    assertEqual(cvar.value, 1, "clamped to at least 1");

    // A driver maximum of 16: values within it reach the textures as set.
    Cvar_Set(cvar.name, "8");
    gl_model.GL_CheckAnisotropy(16);
    assertEqual(cvar.value, 8, "value within the maximum kept");
    assertEqual(mipmapped.anisotropy, 8, "mipmapped texture gets 8");
    assertEqual(flat.anisotropy, 4, "texture without mipmaps still untouched");

    Cvar_Set(cvar.name, "32");
    gl_model.GL_CheckAnisotropy(16);
    assertEqual(cvar.value, 16, "clamped to a maximum of 16");
    assertEqual(mipmapped.anisotropy, 16, "mipmapped texture gets 16");

    // Unchanged value: no sweep.
    mipmapped.anisotropy = 2;
    mipmapped.needsUpdate = false;
    gl_model.GL_CheckAnisotropy();
    assertEqual(mipmapped.needsUpdate, false, "no sweep without a change");
  } finally {
    glquake.GL_UnregisterTexture(mipmapped);
    glquake.GL_UnregisterTexture(flat);
    Cvar_Set(cvar.name, oldString);
    gl_model.GL_CheckAnisotropy();
    cvar.archive = oldArchive;
  }
});
