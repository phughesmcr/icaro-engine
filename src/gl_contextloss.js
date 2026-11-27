// Web-only: no C counterpart (WinQuake/GLQuake never lost its GL context).
//
// WebGL context loss and restore. The browser may drop the context at any
// time (GPU reset, a phone backgrounding the tab, too many contexts); the
// canvas then goes black until the context comes back, if it does.
//
// Three.js's WebGLRenderer already listens for webglcontextlost and
// webglcontextrestored on its canvas, calls preventDefault and rebuilds its
// own state (programs, buffers, texture and render target objects). It
// uploads textures and geometry again lazily, because the per-object GPU
// bookkeeping is gone and each texture's version is ahead of it. This
// module covers what Three.js doesn't:
//   - no drawing while the context is lost: SCR_UpdateScreen asks
//     GL_ContextLost() and skips the frame, so the engine keeps running
//     (network, sound, game) without calling the renderer on a dead context;
//   - rebuilding the engine's own state after a restore:
//     R_LightmapsContextRestored (pending partial uploads were never sent),
//     R_WarpContextRestored and R_GammaContextRestored (the screenwarp's and
//     the gamma pass's framebuffer copies) and the
//     viewmodel's depthRange, which is a raw gl call outside Three.js.
//
// GL_ContextLoss_Init is called from SCR_Init. This module touches neither
// window nor document: it uses the renderer's own canvas.

import { R_LightmapsContextRestored } from "./gl_rsurf.js";
import { R_WarpContextRestored } from "./gl_screenwarp.js";
import { R_GammaContextRestored } from "./gl_gamma.js";

let contextLost = false;
let hooked = null; // the canvas the listeners are on

// True between webglcontextlost and webglcontextrestored
export function GL_ContextLost() {
  return contextLost;
}

// Everything to redo after the context is back. Exported so tests can run it.
export function GL_ContextRestored(r) {
  contextLost = false;

  // depthRange is raw GL state that Three.js doesn't track; a new context
  // starts at 0..1, so this only makes sure the viewmodel hack from before
  // the loss can't leak into the first frame.
  const gl =
    r !== null && r !== undefined && typeof r.getContext === "function" ?
      r.getContext() :
      null;
  if (gl !== null && typeof gl.depthRange === "function") {
    gl.depthRange(0, 1);
  }

  R_LightmapsContextRestored();
  R_WarpContextRestored();
  R_GammaContextRestored();
}

export function GL_ContextLoss_Init(r) {
  if (r === null || r === undefined) {
    return; // dedicated server or headless: nothing to lose
  }

  const canvas = r.domElement;
  if (
    canvas === null || canvas === undefined ||
    typeof canvas.addEventListener !== "function"
  ) {
    return;
  }
  if (hooked === canvas) {
    return;
  }
  hooked = canvas;

  canvas.addEventListener("webglcontextlost", function (event) {
    // Without preventDefault the browser never restores the context.
    // Three.js does it too; doing it here as well costs nothing.
    event.preventDefault();
    contextLost = true;
    console.warn("WebGL context lost; drawing paused until it is restored");
  });

  canvas.addEventListener("webglcontextrestored", function () {
    GL_ContextRestored(r);
    console.warn("WebGL context restored");
  });
}

// For tests: forget the hooked canvas and the lost flag
export function GL_ContextLoss_Reset() {
  contextLost = false;
  hooked = null;
}
