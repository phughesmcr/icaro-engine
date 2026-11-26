// R_DrawAliasModel lights vertices with glColor3f, which GL clamps to [0, 1]
// and applies in display space. Three multiplies vertex colours in linear
// space, so GL_LinearLight decodes the level from sRGB.

// Bootstrap the renderer's circular module graph in its safe order.
await import("../src/gl_rsurf.js");

const { GL_LinearLight } = await import("../src/gl_mesh.js");

function assertClose(actual, expected, message, epsilon = 1e-6) {
  if (Math.abs(actual - expected) > epsilon) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

Deno.test("GL_LinearLight clamps like glColor3f and decodes sRGB", () => {
  assertClose(GL_LinearLight(0), 0, "black");
  assertClose(GL_LinearLight(-0.5), 0, "negative clamps");
  assertClose(GL_LinearLight(NaN), 0, "NaN clamps");
  assertClose(GL_LinearLight(1), 1, "full");
  assertClose(GL_LinearLight(1.8), 1, "overbright clamps");
  // 8-bit levels are exact
  assertClose(
    GL_LinearLight(128 / 255),
    Math.pow((128 / 255 + 0.055) / 1.055, 2.4),
    "mid",
  );
  assertClose(GL_LinearLight(5 / 255), 5 / 255 / 12.92, "linear toe");

  // Encoding the decoded level back gives the display-space level.
  for (const l of [0.1, 0.25, 0.5, 0.75, 0.9]) {
    const d = GL_LinearLight(l);
    const e = d <= 0.0031308 ? d * 12.92 : 1.055 * Math.pow(d, 1 / 2.4) - 0.055;
    assertClose(e, l, `round trip ${l}`, 0.5 / 255 + 1e-6);
  }
});
