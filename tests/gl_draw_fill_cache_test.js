// Draw_Fill caches one colour string per palette index. The palette is
// rewritten in place (gamma shifts), so the cache must follow its values.

await import("../src/gl_rsurf.js"); // bootstraps the renderer's import cycle

const draw = await import("../src/gl_draw.js");

Deno.test("Draw_Fill sets the palette colour and follows in-place palette changes", () => {
  const styles = [];
  const ctx = {
    set fillStyle(v) {
      styles.push(v);
    },
    fillRect() {},
    getContext() {
      return this;
    },
  };
  try {
    draw.Draw_Init({ width: 640, height: 480, getContext: () => ctx });
  } catch { /* no WAD here: the context is set before the pics load */ }

  const pal = new Uint8Array(768);
  pal.set([10, 20, 30], 5 * 3);
  pal.set([255, 0, 1], 255 * 3);
  draw.Draw_SetExternals({ host_basepal: pal });

  draw.Draw_Fill(0, 0, 1, 1, 5);
  draw.Draw_Fill(0, 0, 1, 1, 5);
  draw.Draw_Fill(0, 0, 1, 1, 255);
  pal.set([11, 21, 31], 5 * 3); // VID_ShiftPalette rewrites in place
  draw.Draw_Fill(0, 0, 1, 1, 5);
  draw.Draw_Fill(0, 0, 1, 1, 256); // out of range

  const expected = [
    "rgb(10,20,30)",
    "rgb(10,20,30)",
    "rgb(255,0,1)",
    "rgb(11,21,31)",
    "#ffffff",
  ];
  if (JSON.stringify(styles) !== JSON.stringify(expected)) {
    throw new Error("fillStyle sequence " + JSON.stringify(styles));
  }
});
