// Check_Gamma (gl_vidnt.c) bakes pow( ( c + 1 ) / 256, vid_gamma ) into the
// palette. The gamma and contrast cvars are QuakeSpasm's post-process
// (gl_gamma.js): pow( colour * contrast, gamma ) on the finished view.

// vid.js alone hits a pre-existing import cycle (render.js vrect_t TDZ);
// load the renderer graph in its safe order first.
await import("../src/gl_rsurf.js");

const { Check_Gamma, Check_Gamma_Palette } = await import("../src/vid.js");
const { VID_SetTestRenderer } = await import("../src/vid.js");
const {
  R_ContrastValue,
  R_GammaActive,
  R_GammaContextRestored,
  R_GammaCorrect,
  R_GammaValue,
} = await import("../src/gl_gamma.js");
const { v_contrast, v_gamma } = await import("../src/view.js");
const { r_framecount, set_r_framecount } = await import("../src/glquake.js");

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

// Straight transcription of the C loop, float maths and (unsigned char) cast.
function cCheckGamma(c, gamma) {
  const f = Math.pow((c + 1) / 256.0, gamma);
  let inf = f * 255 + 0.5;
  if (inf < 0) inf = 0;
  if (inf > 255) inf = 255;
  return Math.trunc(inf);
}

Deno.test("Check_Gamma_Palette matches the C formula at vid_gamma 0.7", () => {
  const pal = new Uint8Array(768);
  for (let i = 0; i < 768; i++) pal[i] = i & 255;
  Check_Gamma_Palette(pal, 0.7);

  for (let i = 0; i < 768; i++) {
    assertEqual(pal[i], cCheckGamma(i & 255, 0.7), `entry ${i}`);
  }

  // spot checks: black lifts, mid-grey brightens, white stays white
  assertEqual(cCheckGamma(0, 0.7), 5, "black");
  assertEqual(cCheckGamma(128, 0.7), 158, "mid-grey");
  assertEqual(cCheckGamma(255, 0.7), 255, "white");
});

Deno.test("Check_Gamma_Palette at vid_gamma 1 is the 3Dfx near-identity", () => {
  const pal = new Uint8Array(768);
  for (let i = 0; i < 768; i++) pal[i] = i & 255;
  Check_Gamma_Palette(pal, 1.0);
  for (let i = 0; i < 768; i++) {
    assertEqual(pal[i], cCheckGamma(i & 255, 1.0), `entry ${i}`);
  }
});

Deno.test("gamma pass: QuakeSpasm's uniforms and when it runs", () => {
  // GLSLGamma_GammaCorrect passes vid_gamma as is
  assertEqual(R_GammaValue(1), 1, "default");
  assertEqual(R_GammaValue(0.6), 0.6, "gamma 0.6");
  assertEqual(R_GammaValue(0), 1, "gamma 0 guarded");
  assertEqual(R_GammaValue(-1), 1, "negative gamma guarded");
  assertEqual(R_GammaValue(NaN), 1, "NaN guarded");
  // q_min( 2.0f, q_max( 1.0f, vid_contrast.value ) )
  assertEqual(R_ContrastValue(1), 1, "default contrast");
  assertEqual(R_ContrastValue(0.5), 1, "contrast can't darken");
  assertEqual(R_ContrastValue(1.5), 1.5, "contrast 1.5");
  assertEqual(R_ContrastValue(3), 2, "contrast capped at 2");
  assertEqual(R_ContrastValue(NaN), 1, "NaN contrast");
  // "if (vid_gamma.value == 1 && vid_contrast.value == 1) return;"
  assertEqual(R_GammaActive(1, 1), false, "off at the defaults");
  assertEqual(R_GammaActive(0.7, 1), true, "gamma alone");
  assertEqual(R_GammaActive(1, 1.4), true, "contrast alone");
  assertEqual(R_GammaActive(1, 0.5), false, "clamped contrast is 1");
});

Deno.test("contrast is QuakeSpasm's archived cvar, default 1", () => {
  assertEqual(v_contrast.name, "contrast", "name");
  assertEqual(v_contrast.string, "1", "default");
  assertEqual(v_contrast.archive, true, "archived");
});

Deno.test("Check_Gamma defaults to 0.7, honours -gamma, and corrects each palette once", () => {
  const pal = new Uint8Array([0, 128, 255]);
  Check_Gamma(pal);
  assertEqual(pal[1], cCheckGamma(128, 0.7), "default 0.7");
  Check_Gamma(pal);
  assertEqual(pal[1], cCheckGamma(128, 0.7), "not applied twice");

  const pal2 = new Uint8Array([0, 128, 255]);
  Check_Gamma(pal2, 1.0);
  assertEqual(pal2[1], cCheckGamma(128, 1.0), "-gamma 1 on a fresh palette");
});

/**
 * A renderer that records what R_GammaCorrect asks of it. The viewport and
 * drawing buffer are in pixels, as R_SetupGL leaves them.
 */
function gammaRenderer(viewport, buffer) {
  return {
    autoClear: true,
    copies: [],
    renders: [],
    getCurrentViewport(target) {
      return target.set(viewport[0], viewport[1], viewport[2], viewport[3]);
    },
    getDrawingBufferSize(target) {
      return target.set(buffer[0], buffer[1]);
    },
    copyFramebufferToTexture(texture, position) {
      this.copies.push({
        texture,
        width: texture.image.width,
        height: texture.image.height,
        x: position.x,
        y: position.y,
      });
    },
    render(scene, camera) {
      const mesh = scene.children[0];
      const u = mesh.material.uniforms;
      this.renders.push({
        autoClear: this.autoClear,
        texture: u.GammaTexture.value,
        gamma: u.GammaValue.value,
        contrast: u.ContrastValue.value,
        camera,
      });
    },
  };
}

Deno.test("gamma pass: copies the view and draws it back once a frame", () => {
  const oldGamma = v_gamma.value;
  const oldContrast = v_contrast.value;
  const oldFrame = r_framecount;
  // a view that hangs off the buffer's left and bottom edges
  const r = gammaRenderer([-10, 5, 200, 100], [150, 90]);
  try {
    VID_SetTestRenderer(r, 1);

    // QuakeSpasm skips the pass at gamma 1 and contrast 1
    v_gamma.value = 1;
    v_contrast.value = 1;
    set_r_framecount(1000);
    R_GammaCorrect();
    assertEqual(r.copies.length + r.renders.length, 0, "off at the defaults");

    v_gamma.value = 0.7;
    v_contrast.value = 3;
    set_r_framecount(1001);
    R_GammaCorrect();
    assertEqual(r.copies.length, 1, "one copy");
    const copy = r.copies[0];
    // clamped to the buffer: x 0..150, y 5..90
    assertEqual(copy.x, 0, "x");
    assertEqual(copy.y, 5, "y");
    assertEqual(copy.width, 150, "width");
    assertEqual(copy.height, 85, "height");
    assertEqual(r.renders.length, 1, "one draw");
    const draw = r.renders[0];
    assertEqual(draw.texture, copy.texture, "draws the copy");
    assertEqual(draw.gamma, 0.7, "GammaValue");
    assertEqual(draw.contrast, 2, "ContrastValue clamped");
    assertEqual(draw.autoClear, false, "draws over the view");
    assertEqual(r.autoClear, true, "autoClear restored");

    // no new 3D frame: nothing to correct
    R_GammaCorrect();
    assertEqual(r.renders.length, 1, "once per r_framecount");

    // same size: the copy texture is kept
    set_r_framecount(1002);
    R_GammaCorrect();
    assertEqual(r.copies[1].texture, copy.texture, "texture reused");

    // a context restore drops it, and the next frame makes a new one
    R_GammaContextRestored();
    set_r_framecount(1003);
    R_GammaCorrect();
    assertEqual(r.copies[2].texture !== copy.texture, true, "new texture");
    assertEqual(r.renders[2].texture, r.copies[2].texture, "draws the new one");
  } finally {
    VID_SetTestRenderer(null, 1);
    v_gamma.value = oldGamma;
    v_contrast.value = oldContrast;
    set_r_framecount(oldFrame);
  }
});

Deno.test("gamma pass: a view outside the buffer draws nothing", () => {
  const oldGamma = v_gamma.value;
  const oldFrame = r_framecount;
  const r = gammaRenderer([200, 0, 50, 50], [150, 90]);
  try {
    VID_SetTestRenderer(r, 1);
    v_gamma.value = 0.7;
    set_r_framecount(2000);
    R_GammaCorrect();
    assertEqual(r.copies.length + r.renders.length, 0, "nothing drawn");
  } finally {
    VID_SetTestRenderer(null, 1);
    v_gamma.value = oldGamma;
    set_r_framecount(oldFrame);
  }
});
