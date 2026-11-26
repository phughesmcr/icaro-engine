// Ported from: ironwail Quake/gl_rmain.c (R_SetupView water_warp, R_WarpScaleView)
// and Quake/gl_shaders.h (warpscale_fragment_shader)
//
// r_waterwarp 1 warps the 3D view while the eye is in water, slime or lava,
// as software WinQuake did (r_misc.c R_SetupFrame, D_WarpScreen). GLQuake
// declared r_waterwarp but never registered or used it. FitzQuake brought
// the effect back: QuakeSpasm warps the FOV instead, and Ironwail does a
// screen-space warp at 1 and the FOV warp above 1.
//
// The port renders straight to the canvas, so the view is copied into a
// texture and drawn back warped over the same viewport. The FOV warp
// (r_waterwarp 2) needs R_SetupFrame and R_SetupGL in gl_rmain.js and is not
// ported: values above 1 draw no warp.

import * as THREE from "three";
import { Cvar_FindVar, Cvar_RegisterVariable } from "./cvar.js";
import { renderer } from "./vid.js";
import { r_framecount, r_waterwarp } from "./glquake.js";
import { r_viewleaf } from "./gl_rmain.js";
import { isXRActive } from "./webxr.js";
import { CONTENTS_LAVA, CONTENTS_SLIME, CONTENTS_WATER } from "./bspfile.js";

// Ironwail draws the warp with amplitude 1/256 of the view
const WARP_AMP = 1 / 256;

// Created on first use (THREE classes can't be built at import time: see
// AGENTS.md on import cycles, and the Deno shim has no WebGL)
let warpScene = null;
let warpCamera = null;
let warpMaterial = null;
let warpTexture = null;

let warp_lastframe = -1;
let _viewport = null; // THREE.Vector4
let _position = null; // THREE.Vector2
let _bufferSize = null; // THREE.Vector2

const WARP_VERTEX_SHADER = `
varying vec2 in_uv;
void main() {
	in_uv = uv;
	gl_Position = vec4( position.xy, 0.0, 1.0 );
}
`;

// Ironwail warpscale_fragment_shader with WARP 1 and a uv scale of 1. The
// aspect ratio is a uniform here; Ironwail derives it from dFdy/dFdx.
const WARP_FRAGMENT_SHADER = `
uniform sampler2D Tex;
uniform float WarpAmp;
uniform float Time;
uniform float Aspect;
varying vec2 in_uv;
void main() {
	vec2 uv = in_uv;
	vec2 warp_amp = vec2( WarpAmp, WarpAmp * Aspect );
	uv = warp_amp + uv * ( 1.0 - 2.0 * warp_amp ); // remap to safe area
	uv += warp_amp * sin( vec2( uv.y / Aspect, uv.x ) * ( 3.14159265 * 8.0 ) + Time );
	gl_FragColor = texture2D( Tex, uv );
}
`;

/*
=============
R_WaterWarp_Init

Registers r_waterwarp (Ironwail gl_rmisc.c R_Init)
=============
*/
export function R_WaterWarp_Init() {
  if (Cvar_FindVar(r_waterwarp.name) === null) {
    Cvar_RegisterVariable(r_waterwarp);
  }
}

/*
=============
R_WaterWarpActive

Ironwail R_SetupView: the screen warp is on when r_waterwarp is nonzero and
not above 1 (above 1 is the FOV warp), and the eye is in a liquid
=============
*/
export function R_WaterWarpActive(value, contents) {
  if (value === 0 || value > 1) {
    return false;
  }

  return contents === CONTENTS_WATER || contents === CONTENTS_SLIME ||
    contents === CONTENTS_LAVA;
}

function R_WarpCreate() {
  warpScene = new THREE.Scene();
  warpCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  warpMaterial = new THREE.ShaderMaterial({
    uniforms: {
      Tex: { value: null },
      WarpAmp: { value: WARP_AMP },
      Time: { value: 0 },
      Aspect: { value: 1 },
    },
    vertexShader: WARP_VERTEX_SHADER,
    fragmentShader: WARP_FRAGMENT_SHADER,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });

  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), warpMaterial);
  mesh.frustumCulled = false;
  warpScene.add(mesh);

  _viewport = new THREE.Vector4();
  _position = new THREE.Vector2();
  _bufferSize = new THREE.Vector2();
}

/*
=============
R_WarpContextRestored

Web-only (see gl_contextloss.js). Drop the framebuffer copy after a WebGL
context restore; R_WarpScreen makes a new one the next time the eye is in
water. The material and scene stay: they hold no GPU objects of their own.
=============
*/
export function R_WarpContextRestored() {
  if (warpTexture !== null) warpTexture.dispose();
  warpTexture = null;
  if (warpMaterial !== null) warpMaterial.uniforms.Tex.value = null;
}

/*
=============
R_WarpScreen

Called by SCR_UpdateScreen right after V_RenderView. Warps the 3D view
rendered this frame when R_WaterWarpActive says so. time is cl.time, as in
Ironwail R_WarpScaleView.
=============
*/
export function R_WarpScreen(time) {
  if (renderer === null || r_viewleaf === null) {
    return;
  }

  // Only right after a 3D frame: the view leaf and viewport are this frame's
  if (r_framecount === warp_lastframe) {
    return;
  }
  warp_lastframe = r_framecount;

  if (R_WaterWarpActive(r_waterwarp.value, r_viewleaf.contents) === false) {
    return;
  }

  // The stereo XR view has no single viewport to copy
  if (isXRActive()) {
    return;
  }

  if (warpScene === null) {
    R_WarpCreate();
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
    warpTexture === null || warpTexture.image.width !== w ||
    warpTexture.image.height !== h
  ) {
    if (warpTexture !== null) warpTexture.dispose();
    warpTexture = new THREE.FramebufferTexture(w, h);
    warpMaterial.uniforms.Tex.value = warpTexture;
  }

  _position.set(x, y);
  renderer.copyFramebufferToTexture(warpTexture, _position);

  warpMaterial.uniforms.Time.value = time;
  warpMaterial.uniforms.Aspect.value = w / h;

  const autoClear = renderer.autoClear;
  renderer.autoClear = false;
  renderer.render(warpScene, warpCamera);
  renderer.autoClear = autoClear;
}
