// Web-only: no C counterpart.
//
// Keeping a 2D canvas's contents across a lost context. The browser may
// discard a 2D canvas's backing store (Chrome 99+, OffscreenCanvas too). It
// clears the bitmap, fires contextlost and, once it has new storage, fires
// contextrestored. The canvas stays blank unless it is drawn again, so a
// canvas that is drawn once and then only read goes through here. One that is
// redrawn before every use doesn't need to.
//
// No contextlost listener: unlike webglcontextlost, cancelling it tells the
// browser not to restore the context.
//
// This module touches neither window nor document: it uses the canvas it is
// given.

/**
 * Runs draw( ctx ) on the canvas's 2D context now, and again each time the
 * context is restored. draw must paint the whole contents from data that
 * outlives the canvas. The listener lives as long as the canvas does. Call
 * once per canvas, when it is made.
 */
export function Canvas2D_DrawRestorable(canvas, draw) {
  draw(canvas.getContext("2d"));

  // headless and test canvases have no events, and nothing to lose
  if (typeof canvas.addEventListener !== "function") {
    return;
  }

  canvas.addEventListener("contextrestored", function () {
    draw(canvas.getContext("2d"));
  });
}
