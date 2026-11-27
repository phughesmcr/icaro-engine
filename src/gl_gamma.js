// Ported from: QuakeSpasm Quake/gl_rmain.c (GLSLGamma_GammaCorrect) and
// Ironwail Quake/gl_shaders.h (postprocess_fragment_shader, without
// r_softemu's palettization)
//
// gamma and contrast (QuakeSpasm gl_vidsdl.c vid_gamma and vid_contrast).
// GLQuake's gamma cvar did nothing: VID_ShiftPalette (gl_vidnt.c) is an empty
// stub, and the only gamma is Check_Gamma's, baked into the palette (vid.js).
// QuakeSpasm 0.92 and Ironwail apply both cvars to the finished frame with a
// shader: pow( colour * contrast, gamma ), contrast clamped to [1, 2], and
// nothing done while both are 1. Check_Gamma's palette curve stays under it,
// so Icaro at gamma g is GLQuake's look with QuakeSpasm's curve on top.
//
// Deliberate deviations (see the PR that added this file):
// - Only the 3D view is corrected. The HUD, menus and console are drawn on
//   a separate 2D canvas (gl_draw.js), which QuakeSpasm's pass would cover.
// - Nothing is corrected in WebXR: the stereo view has no single framebuffer
//   to copy (R_WarpScreen skips it for the same reason).
// - gamma 0 or below is taken as 1, where QuakeSpasm's pow would draw a white
//   or broken screen.

import * as THREE from "three";
import { renderer } from "./vid.js";
import { r_framecount } from "./glquake.js";
import { v_contrast, v_gamma } from "./view.js";
import { isXRActive } from "./webxr.js";

// Created on first use (THREE classes can't be built at import time: see
// AGENTS.md on import cycles, and the Deno shim has no WebGL)
let gammaScene = null;
let gammaCamera = null;
let gammaMaterial = null;
let gammaTexture = null;

let gamma_lastframe = -1;
let _viewport = null; // THREE.Vector4
let _position = null; // THREE.Vector2
let _bufferSize = null; // THREE.Vector2

const GAMMA_VERTEX_SHADER = `
varying vec2 in_uv;
void main() {
	in_uv = uv;
	gl_Position = vec4( position.xy, 0.0, 1.0 );
}
`;

// QuakeSpasm's GLSLGamma fragment shader. The copy holds the encoded bytes
// the canvas shows (a FramebufferTexture has no colour space), and the
// ShaderMaterial adds no output conversion, so this works on displayed
// values as QuakeSpasm's does.
const GAMMA_FRAGMENT_SHADER = `
uniform sampler2D GammaTexture;
uniform float GammaValue;
uniform float ContrastValue;
varying vec2 in_uv;
void main() {
	vec4 frag = texture2D( GammaTexture, in_uv );
	frag.rgb = frag.rgb * ContrastValue;
	gl_FragColor = vec4( pow( frag.rgb, vec3( GammaValue ) ), 1.0 );
}
`;

/** The exponent the pass applies for a gamma value: 1 when it isn't above 0. */
export function R_GammaValue(gamma) {
  return gamma > 0 ? gamma : 1;
}

/** QuakeSpasm's q_min( 2.0f, q_max( 1.0f, vid_contrast.value ) ). */
export function R_ContrastValue(contrast) {
  if (!(contrast > 1)) return 1;
  return contrast < 2 ? contrast : 2;
}

/**
 * QuakeSpasm GLSLGamma_GammaCorrect: "if (vid_gamma.value == 1 &&
 * vid_contrast.value == 1) return;"
 */
export function R_GammaActive(gamma, contrast) {
  return R_GammaValue(gamma) !== 1 || R_ContrastValue(contrast) !== 1;
}

function R_GammaCreate() {
  gammaScene = new THREE.Scene();
  gammaCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  gammaMaterial = new THREE.ShaderMaterial({
    uniforms: {
      GammaTexture: { value: null },
      GammaValue: { value: 1 },
      ContrastValue: { value: 1 },
    },
    vertexShader: GAMMA_VERTEX_SHADER,
    fragmentShader: GAMMA_FRAGMENT_SHADER,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });

  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), gammaMaterial);
  mesh.frustumCulled = false;
  gammaScene.add(mesh);

  _viewport = new THREE.Vector4();
  _position = new THREE.Vector2();
  _bufferSize = new THREE.Vector2();
}

/**
 * Web-only (see gl_contextloss.js). Drop the framebuffer copy after a WebGL
 * context restore; R_GammaCorrect makes a new one on its next frame.
 */
export function R_GammaContextRestored() {
  if (gammaTexture !== null) gammaTexture.dispose();
  gammaTexture = null;
  if (gammaMaterial !== null) gammaMaterial.uniforms.GammaTexture.value = null;
}

/**
 * QuakeSpasm GLSLGamma_GammaCorrect. Called by SCR_UpdateScreen once the 3D
 * view is finished (after R_WarpScreen): copies the view's viewport and draws
 * it back through the gamma shader.
 */
export function R_GammaCorrect() {
  if (renderer === null) {
    return;
  }

  // Only right after a 3D frame, as R_WarpScreen: without one the drawing
  // buffer holds nothing of this frame to correct
  if (r_framecount === gamma_lastframe) {
    return;
  }
  gamma_lastframe = r_framecount;

  if (R_GammaActive(v_gamma.value, v_contrast.value) === false) {
    return;
  }

  if (isXRActive()) {
    return;
  }

  if (gammaScene === null) {
    R_GammaCreate();
  }

  // R_SetupGL's viewport, in drawing buffer pixels, clamped to the buffer
  renderer.getCurrentViewport(_viewport);
  renderer.getDrawingBufferSize(_bufferSize);
  const x = Math.max(0, _viewport.x);
  const y = Math.max(0, _viewport.y);
  const w = Math.min(_bufferSize.x, _viewport.x + _viewport.z) - x;
  const h = Math.min(_bufferSize.y, _viewport.y + _viewport.w) - y;
  if (w <= 0 || h <= 0) {
    return;
  }

  if (
    gammaTexture === null || gammaTexture.image.width !== w ||
    gammaTexture.image.height !== h
  ) {
    if (gammaTexture !== null) gammaTexture.dispose();
    gammaTexture = new THREE.FramebufferTexture(w, h);
    gammaMaterial.uniforms.GammaTexture.value = gammaTexture;
  }

  _position.set(x, y);
  renderer.copyFramebufferToTexture(gammaTexture, _position);

  gammaMaterial.uniforms.GammaValue.value = R_GammaValue(v_gamma.value);
  gammaMaterial.uniforms.ContrastValue.value = R_ContrastValue(
    v_contrast.value,
  );

  const autoClear = renderer.autoClear;
  renderer.autoClear = false;
  renderer.render(gammaScene, gammaCamera);
  renderer.autoClear = autoClear;
}
