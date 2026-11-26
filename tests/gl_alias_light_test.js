// R_DrawAliasModel lights vertices with glColor3f, which GL clamps to [0, 1]
// and multiplies into the skin on the gamma-encoded values (GL_MODULATE).
// GL_AliasLight gives that display-space level; AliasMaterial's shader does
// the multiply on encoded values.

// Bootstrap the renderer's circular module graph in its safe order.
await import("../src/gl_rsurf.js");

const { GL_AliasLight } = await import("../src/gl_mesh.js");

function assertClose(actual, expected, message, epsilon = 1e-9) {
  if (Math.abs(actual - expected) > epsilon) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

Deno.test("GL_AliasLight clamps like glColor3f and stays in display space", () => {
  assertClose(GL_AliasLight(0), 0, "black");
  assertClose(GL_AliasLight(-0.5), 0, "negative clamps");
  assertClose(GL_AliasLight(NaN), 0, "NaN clamps");
  assertClose(GL_AliasLight(1), 1, "full");
  assertClose(GL_AliasLight(1.8), 1, "overbright clamps");
  // no sRGB decode: the level is what glColor3f was given
  assertClose(GL_AliasLight(128 / 255), 128 / 255, "mid");
  assertClose(GL_AliasLight(5 / 255), 5 / 255, "dim");
});
