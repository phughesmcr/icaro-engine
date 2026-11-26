// TEX-2: VID_SetPalette clears only the alpha of index 255, as gl_vidnt.c
// does. XR-3: the resize handler leaves the drawing buffer alone while an XR
// session is presenting.

// vid.js alone hits a pre-existing import cycle; load the renderer graph first.
await import("../src/gl_rsurf.js");

const { VID_SetPalette, VID_Resize, vid, d_8to24table } = await import(
  "../src/vid.js"
);
const { R_InitSky } = await import("../src/gl_warp.js");

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

Deno.test("TEX-2: palette index 255 keeps its colour and loses only its alpha", () => {
  const palette = new Uint8Array(768);
  for (let i = 0; i < 256; i++) {
    palette[i * 3] = i;
    palette[i * 3 + 1] = 255 - i;
    palette[i * 3 + 2] = 7;
  }

  // Quake's index 255 colour
  palette[765] = 159;
  palette[766] = 91;
  palette[767] = 83;

  VID_SetPalette(palette);

  assertEqual(d_8to24table[255], (83 << 16) | (91 << 8) | 159, "index 255");
  assertEqual(d_8to24table[255] >>> 24, 0, "index 255 alpha");
  assertEqual(d_8to24table[254] >>> 24, 255, "index 254 alpha");
  assertEqual(d_8to24table[0] >>> 24, 255, "index 0 alpha");

  // R_InitSky reads alpha from the table: the front layer's 255 texels are
  // still transparent, now with the palette colour under them. The back
  // layer is forced opaque.
  const width = 256, height = 128;
  const data = new Uint8Array(width * height);
  data.fill(255);
  const sky = R_InitSky({ data, offsets: [0], width, height }, d_8to24table);
  assertEqual(
    sky.alphaTexture.image.data[3],
    0,
    "front 255 texel stays transparent",
  );
  assertEqual(sky.alphaTexture.image.data[0], 159, "front 255 texel keeps red");
  assertEqual(sky.alphaTexture.image.data[2], 83, "front 255 texel keeps blue");
  assertEqual(
    sky.solidTexture.image.data[0],
    159,
    "back 255 texel has the palette colour",
  );
  assertEqual(sky.solidTexture.image.data[3], 255, "back layer is opaque");
});

Deno.test("XR-3: the resize handler skips a presenting session and resyncs afterwards", () => {
  const calls = [];
  const renderer = {
    xr: { isPresenting: true },
    setSize(w, h) {
      calls.push(["size", w, h]);
    },
    setPixelRatio(r) {
      calls.push(["ratio", r]);
    },
  };
  const canvas = { width: 640, height: 480 };
  const savedWidth = vid.width;
  const savedHeight = vid.height;

  globalThis.window = {
    innerWidth: 1000,
    innerHeight: 500,
    devicePixelRatio: 2,
  };

  try {
    VID_Resize(renderer, canvas);
    assertEqual(calls.length, 0, "renderer untouched while presenting");
    assertEqual(canvas.width, 640, "canvas untouched while presenting");
    assertEqual(vid.width, savedWidth, "vid untouched while presenting");

    // The sessionend listener calls VID_Resize again
    renderer.xr.isPresenting = false;
    VID_Resize(renderer, canvas);
    assertEqual(canvas.width, 1000, "canvas width");
    assertEqual(canvas.height, 500, "canvas height");
    assertEqual(vid.width, 1000, "vid.width");
    assertEqual(vid.height, 500, "vid.height");
    assertEqual(calls.length, 2, "setSize and setPixelRatio");
    assertEqual(calls[0][1], 1000, "setSize width");

    // A renderer without WebXR resizes as before
    calls.length = 0;
    VID_Resize({
      setSize() {
        calls.push(1);
      },
      setPixelRatio() {},
    }, canvas);
    assertEqual(calls.length, 1, "renderer without xr resizes");
  } finally {
    delete globalThis.window;
    vid.width = savedWidth;
    vid.height = savedHeight;
  }
});
