// Ported from: Ironwail Quake/gl_texmgr.c (r_softemu, r_softemu_metric,
// GLPalette_UpdateLookupTable, GLPalette_Postprocess) and Quake/gl_shaders.h
// (palette_init_compute_shader, NOISE_FUNCTIONS, postprocess_fragment_shader)
//
// r_softemu, software renderer emulation: the finished 3D view is reduced to
// the 256-colour palette, as the software renderer drew it. Each colour is
// looked up in a 128x128x128 table of nearest palette entries; the view
// blend, contrast and gamma are then applied to the palette colour, as
// Ironwail applies them to the palette (GLPalette_Postprocess). The pass
// itself is gl_gamma.js's, which is Ironwail's postprocess shader.
//   0 off
//   1 "Subtle": a 16x16 Bayer dither before the lookup
//   2 "Balanced": the lookup without dither (see deviations)
//   3 "Raw": the lookup without dither
//
// Deliberate deviations from Ironwail:
// - WebGL 2 has no compute shaders, so the table is drawn into a 2048x1024
//   render target (16x8 slices of 128x128, one per blue level) by a fragment
//   shader, and the source palette is a float texture.
// - Ironwail's mode 2 adds a world-space dither to lightmapped surfaces
//   nearby (the world shader's DITHER 1); modes 2 and 3 band the lightmaps
//   (r_softemu_lightmap_banding) and force nearest texture filtering
//   (TexMgr_UsesFilterOverride); r_softemu_mdl_warp warps alias models.
//   None of that is here: those live in Ironwail's surface and model
//   shaders, so mode 2 draws as mode 3 does. r_dither and
//   r_softemu_dither_screen are taken as their defaults (1).
// - Only the 3D view is reduced: the HUD, menus and console are a separate
//   2D canvas (see gl_gamma.js), and nothing is done in WebXR.

import * as THREE from "three";
import { ca_connected, cl, cls, SIGNONS } from "./client.js";
import { d_8to24table } from "./vid.js";

/** Ironwail r_softemu (gl_texmgr.c): 0 to 3, see above. Archived. */
export const r_softemu = {
  name: "r_softemu",
  string: "0",
  value: 0,
  archive: true,
};

/**
 * Ironwail r_softemu_metric (gl_texmgr.c): the colour distance for the
 * lookup. -1 automatic, 0 naive RGB, 1 Riemersma, 2 OKLab. Archived.
 */
export const r_softemu_metric = {
  name: "r_softemu_metric",
  string: "-1",
  value: -1,
  archive: true,
};

export const SOFTEMU_OFF = 0;
export const SOFTEMU_FINE = 1;
export const SOFTEMU_COARSE = 2;
export const SOFTEMU_BANDED = 3;
const SOFTEMU_NUMMODES = 4;

export const SOFTEMU_METRIC_NAIVE = 0;
export const SOFTEMU_METRIC_RIEMERSMA = 1;
export const SOFTEMU_METRIC_OKLAB = 2;
const SOFTEMU_METRIC_COUNT = 3;

/** Ironwail gl_rmain.c NOISESCALE */
export const SOFTEMU_NOISESCALE = 9 / 255;

/** Ironwail TexMgr_SoftEmu_f: CLAMP (0, (int)r_softemu.value, 3). */
export function R_SoftEmuMode(value) {
  const n = Math.trunc(value);
  if (!(n > 0)) return SOFTEMU_OFF;
  return n < SOFTEMU_NUMMODES ? n : SOFTEMU_NUMMODES - 1;
}

/**
 * Ironwail GLPalette_UpdateLookupTable's metric: r_softemu_metric clamped,
 * or when it is negative OKLab, except naive RGB for mode 3 in a map whose
 * lighting is not coloured (no .lit).
 */
export function R_SoftEmuMetric(metric, softemu, inMapWithoutLit) {
  if (metric < 0) {
    return softemu === SOFTEMU_BANDED && inMapWithoutLit === true ?
      SOFTEMU_METRIC_NAIVE :
      SOFTEMU_METRIC_OKLAB;
  }
  const n = Math.trunc(metric);
  return n < SOFTEMU_METRIC_COUNT ? n : SOFTEMU_METRIC_COUNT - 1;
}

function sRGBToLinear(v) {
  return v > 0.04045 ? Math.pow((v + 0.055) / 1.055, 2.4) : v / 12.92;
}

/**
 * Ironwail NormalizeColor: an 8-bit colour in the metric's space, written to
 * out[o..o+2].
 */
export function R_SoftEmuNormalize(r8, g8, b8, metric, out, o) {
  let r = r8 / 255;
  let g = g8 / 255;
  let b = b8 / 255;
  if (metric >= SOFTEMU_METRIC_RIEMERSMA) {
    r = sRGBToLinear(r);
    g = sRGBToLinear(g);
    b = sRGBToLinear(b);
  }
  if (metric >= SOFTEMU_METRIC_OKLAB) {
    // Bjorn Ottosson's OKLab
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    r = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
    g = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
    b = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
  }
  out[o] = r;
  out[o + 1] = g;
  out[o + 2] = b;
}

/** Ironwail ColorDistanceSquared, on normalized colours. */
export function R_SoftEmuDistance(c0, o0, c1, o1, metric) {
  let dr = c1[o1] - c0[o0];
  const dg = c1[o1 + 1] - c0[o0 + 1];
  let db = c1[o1 + 2] - c0[o0 + 2];
  if (metric === SOFTEMU_METRIC_RIEMERSMA) {
    const rmean = (c0[o0] + c1[o1]) * 0.5;
    return dr * dr * (2 + rmean) + dg * dg * 4 + db * db * (3 - rmean);
  }
  if (metric === SOFTEMU_METRIC_OKLAB) {
    dr *= 1.25; // lightness
    db *= 1.5; // blue-yellow
  }
  return dr * dr + dg * dg + db * db;
}

/**
 * Ironwail's 16x16 Bayer value (bayer01) for a pixel, 0 to 255/256. The
 * shader has no bitfieldReverse in GLSL ES 3.00, so the reversed bit
 * interleave is spelled out here and in SOFTEMU_NOISE_GLSL.
 */
export function R_SoftEmuBayer(x, y) {
  const cx = x & 15;
  const cy = (y ^ x) & 15;
  const v = ((cy & 1) << 7) | ((cx & 1) << 6) | ((cy & 2) << 4) |
    ((cx & 2) << 3) | ((cy & 4) << 1) | (cx & 4) | ((cy & 8) >> 2) |
    ((cx & 8) >> 3);
  return v / 256;
}

/** GLSL for the postprocess shader: bayer01, tri and DITHER_NOISE. */
export const SOFTEMU_NOISE_GLSL = `
float bayer01( ivec2 coord ) {
	uint x = uint( coord.x ) & 15u;
	uint y = ( uint( coord.y ) ^ uint( coord.x ) ) & 15u;
	uint v = ( ( y & 1u ) << 7 ) | ( ( x & 1u ) << 6 ) | ( ( y & 2u ) << 4 ) |
		( ( x & 2u ) << 3 ) | ( ( y & 4u ) << 1 ) | ( x & 4u ) |
		( ( y & 8u ) >> 2 ) | ( ( x & 8u ) >> 3 );
	return float( v ) * ( 1.0 / 256.0 );
}
float tri( float x ) {
	float orig = x * 2.0 - 1.0;
	uint signbit = floatBitsToUint( orig ) & 0x80000000u;
	x = sqrt( abs( orig ) ) - 1.0;
	return uintBitsToFloat( floatBitsToUint( x ) ^ signbit );
}
vec3 softemu_lookup( sampler2D lut, vec3 c ) {
	ivec3 clr = ivec3( clamp( c, 0.0, 1.0 ) * 127.0 + 0.5 );
	return texelFetch( lut, ivec2( ( clr.b & 15 ) * 128 + clr.r,
		( clr.b >> 4 ) * 128 + clr.g ), 0 ).rgb;
}
`;

// The lookup table: texel (x, y) of slice b (b & 15, b >> 4) holds the
// palette colour nearest to (r, g, b) = (x, y, b) * 2 + (x, y, b) / 64.
const LUT_FRAGMENT_SHADER = `
uniform sampler2D Palette; // 512x1: 256 normalized colours, then the RGB
uniform int Metric;
void main() {
	ivec2 p = ivec2( gl_FragCoord.xy );
	ivec3 gid = ivec3( p.x & 127, p.y & 127, ( p.y >> 7 ) * 16 + ( p.x >> 7 ) );
	ivec3 c8 = ( gid << 1 ) + ( gid >> 6 );
	vec3 target = vec3( c8 ) * ( 1.0 / 255.0 );
	if ( Metric >= 1 ) {
		target = mix( target / 12.92, pow( ( target + 0.055 ) / 1.055, vec3( 2.4 ) ),
			greaterThan( target, vec3( 0.04045 ) ) );
	}
	if ( Metric >= 2 ) {
		float l = pow( 0.4122214708 * target.r + 0.5363325363 * target.g + 0.0514459929 * target.b, 1.0 / 3.0 );
		float m = pow( 0.2119034982 * target.r + 0.6806995451 * target.g + 0.1073969566 * target.b, 1.0 / 3.0 );
		float s = pow( 0.0883024619 * target.r + 0.2817188376 * target.g + 0.6299787005 * target.b, 1.0 / 3.0 );
		target = vec3(
			0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
			1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
			0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s );
	}
	int bestidx = 0;
	float bestdist = 1e32;
	for ( int i = 0; i < 256; i++ ) {
		vec3 delta = texelFetch( Palette, ivec2( i, 0 ), 0 ).rgb - target;
		float dist;
		if ( Metric == 1 ) {
			float rmean = target.r + delta.r * 0.5;
			dist = dot( delta * delta, vec3( 2.0 + rmean, 4.0, 3.0 - rmean ) );
		} else {
			if ( Metric == 2 ) delta *= vec3( 1.25, 1.0, 1.5 );
			dist = dot( delta, delta );
		}
		if ( dist < bestdist ) {
			bestidx = i;
			bestdist = dist;
		}
	}
	gl_FragColor = vec4( texelFetch( Palette, ivec2( 256 + bestidx, 0 ), 0 ).rgb, 1.0 );
}
`;

const LUT_VERTEX_SHADER = `
void main() {
	gl_Position = vec4( position.xy, 0.0, 1.0 );
}
`;

// Created on first use (no THREE objects at import time)
let lutTarget = null;
let lutScene = null;
let lutCamera = null;
let lutMaterial = null;
let lutPalette = null; // DataTexture
let lutValid = false;
let lutMetric = -1;
const lutPaletteCache = new Uint32Array(256);

function R_SoftEmuCreate() {
  lutTarget = new THREE.WebGLRenderTarget(2048, 1024, {
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    generateMipmaps: false,
    depthBuffer: false,
    stencilBuffer: false,
  });
  lutPalette = new THREE.DataTexture(
    new Float32Array(512 * 4),
    512,
    1,
    THREE.RGBAFormat,
    THREE.FloatType,
  );
  lutPalette.minFilter = THREE.NearestFilter;
  lutPalette.magFilter = THREE.NearestFilter;
  lutPalette.generateMipmaps = false;
  lutMaterial = new THREE.ShaderMaterial({
    uniforms: { Palette: { value: lutPalette }, Metric: { value: 0 } },
    vertexShader: LUT_VERTEX_SHADER,
    fragmentShader: LUT_FRAGMENT_SHADER,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), lutMaterial);
  mesh.frustumCulled = false;
  lutScene = new THREE.Scene();
  lutScene.add(mesh);
  lutCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
}

/** The current mode, from r_softemu. */
export function R_SoftEmuActive() {
  return R_SoftEmuMode(r_softemu.value);
}

/**
 * Ironwail GLPalette_UpdateLookupTable: the lookup table for the current
 * palette and metric, rebuilt when either changes. Returns its texture.
 */
export function R_SoftEmuLookupTable(renderer, softemu) {
  const inMapWithoutLit = cls.state === ca_connected &&
    cls.signon === SIGNONS && cl.worldmodel !== null &&
    cl.worldmodel.litfile !== true;
  const metric = R_SoftEmuMetric(
    r_softemu_metric.value,
    softemu,
    inMapWithoutLit,
  );

  if (lutTarget === null) R_SoftEmuCreate();

  let same = lutValid === true && metric === lutMetric;
  for (let i = 0; i < 256 && same; i++) {
    if (lutPaletteCache[i] !== d_8to24table[i]) same = false;
  }
  if (same) return lutTarget.texture;

  lutMetric = metric;
  lutPaletteCache.set(d_8to24table);
  const data = lutPalette.image.data;
  for (let i = 0; i < 256; i++) {
    const c = d_8to24table[i];
    const r = c & 0xff;
    const g = (c >>> 8) & 0xff;
    const b = (c >>> 16) & 0xff;
    R_SoftEmuNormalize(r, g, b, metric, data, i * 4);
    data[i * 4 + 3] = 1;
    data[(256 + i) * 4] = r / 255;
    data[(256 + i) * 4 + 1] = g / 255;
    data[(256 + i) * 4 + 2] = b / 255;
    data[(256 + i) * 4 + 3] = 1;
  }
  lutPalette.needsUpdate = true;
  lutMaterial.uniforms.Metric.value = metric;

  const oldTarget = renderer.getRenderTarget();
  const autoClear = renderer.autoClear;
  renderer.autoClear = false;
  renderer.setRenderTarget(lutTarget);
  renderer.render(lutScene, lutCamera);
  renderer.setRenderTarget(oldTarget);
  renderer.autoClear = autoClear;
  lutValid = true;
  return lutTarget.texture;
}

/** After a WebGL context restore the table's contents are gone. */
export function R_SoftEmuContextRestored() {
  lutValid = false;
}
