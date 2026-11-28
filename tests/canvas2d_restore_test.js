// The 2D canvases that are drawn once (charset, conback, pics) are drawn
// again when the browser restores a lost context. Fake canvases stand in for
// the DOM: lose() does what a loss does, blanking the bitmap and then firing
// contextrestored.

import { TD_Mount } from "./test_data.js";

await import("../src/gl_rsurf.js");

const { Canvas2D_DrawRestorable } = await import("../src/canvas2d.js");
const draw = await import("../src/gl_draw.js");
const pak = await import("../src/pak.js");
const wad = await import("../src/wad.js");
const { VID_SetPalette, d_8to24table } = await import("../src/vid.js");

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

// A canvas whose bitmap is the last thing put or drawn on it
function fakeCanvas() {
  const listeners = {};
  const canvas = {
    width: 0,
    height: 0,
    style: {},
    bitmap: null,
    patterns: 0,
    listeners,
    addEventListener(type, fn) {
      (listeners[type] ??= []).push(fn);
    },
    getContext: () => ctx,
    lose() {
      this.bitmap = null;
      for (const fn of listeners.contextrestored ?? []) fn();
    },
  };
  const ctx = {
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    putImageData(image) {
      canvas.bitmap = image.data.join(",");
    },
    drawImage(source) {
      canvas.bitmap = source.src ?? "drawn";
    },
    createPattern() {
      canvas.patterns++;
      return {};
    },
    fillRect() {},
    setTransform() {},
  };
  return canvas;
}

// Runs fn with a document that makes fake canvases, which it is given
async function withFakeDocument(fn) {
  const made = [];
  const savedDocument = globalThis.document;
  const hadWindow = globalThis.window !== undefined;
  if (!hadWindow) globalThis.window = { devicePixelRatio: 1 }; // gl_draw.js sizes the UI from it
  globalThis.document = {
    createElement() {
      const canvas = fakeCanvas();
      made.push(canvas);
      return canvas;
    },
  };

  try {
    await fn(made);
  } finally {
    if (savedDocument === undefined) delete globalThis.document;
    else globalThis.document = savedDocument;
    if (!hadWindow) delete globalThis.window;
  }
}

Deno.test("Canvas2D_DrawRestorable draws now and on each restore, and never cancels a loss", () => {
  const canvas = fakeCanvas();
  const contexts = [];
  Canvas2D_DrawRestorable(canvas, (ctx) => contexts.push(ctx));
  assertEqual(contexts.length, 1, "drawn when made");

  canvas.lose();
  canvas.lose();
  assertEqual(contexts.length, 3, "drawn again after each restore");
  assertEqual(contexts[2], canvas.getContext("2d"), "on the canvas's context");

  // a contextlost listener that called preventDefault would stop the restore
  assertEqual(
    Object.keys(canvas.listeners).join(","),
    "contextrestored",
    "events listened for",
  );
});

Deno.test("Canvas2D_DrawRestorable only draws on a canvas without events", () => {
  let draws = 0;
  Canvas2D_DrawRestorable({ getContext: () => ({}) }, () => draws++);
  assertEqual(draws, 1, "draws");
});

Deno.test("the charset, conback and WAD pics come back after a lost context", async () => {
  await TD_Mount();
  const gfx = pak.COM_FindFile("gfx.wad").data.slice();
  wad.W_LoadWadFile(gfx.buffer);

  await withFakeDocument((made) => {
    const palette = new Uint8Array(768);
    for (let i = 0; i < 768; i++) palette[i] = i % 251;
    VID_SetPalette(palette);
    draw.Draw_SetExternals({ d_8to24table });

    const overlay = fakeCanvas();
    draw.Draw_Init(overlay);
    const pic = draw.Draw_PicFromWad("net");

    // charset, conback, disc, backtile and net
    assertEqual(made.length, 5, "canvases made");
    assertEqual(made[4], pic.canvas, "the pic's canvas");
    const before = made.map((c) => c.bitmap);

    draw.Draw_TileClear(0, 0, 8, 8);
    draw.Draw_TileClear(0, 0, 8, 8);
    assertEqual(overlay.patterns, 1, "the tile pattern is cached");

    // a redraw must not depend on the lump or the palette staying as they
    // were: VID_ShiftPalette rewrites the palette in place
    gfx.fill(0, 12);
    palette.fill(7);
    VID_SetPalette(palette);

    for (let i = 0; i < made.length; i++) {
      made[i].lose();
      assertEqual(made[i].bitmap, before[i], `canvas ${i} after the restore`);
    }

    draw.Draw_TileClear(0, 0, 8, 8);
    assertEqual(overlay.patterns, 2, "the tile pattern is made again");
  });
});

Deno.test("a cached PNG pic comes back after a lost context", async () => {
  const savedImage = globalThis.Image;
  globalThis.Image = class {
    width = 4;
    height = 2;
    set src(url) {
      this.url = url;
      queueMicrotask(() => this.onload());
    }
    get src() {
      return this.url;
    }
  };

  try {
    await withFakeDocument(async () => {
      const pic = await draw.Draw_CachePicFromPNG("gfx/test.lmp", "test.png");
      assertEqual(pic.canvas.bitmap, "test.png", "drawn when loaded");
      pic.canvas.lose();
      assertEqual(pic.canvas.bitmap, "test.png", "after the restore");
    });
  } finally {
    if (savedImage === undefined) delete globalThis.Image;
    else globalThis.Image = savedImage;
  }
});
