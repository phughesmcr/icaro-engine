// Ported from: WinQuake/gl_rlight.c -- dynamic lighting

import * as THREE from "three";
import { DotProduct, Length, VectorCopy, VectorSubtract } from "./mathlib.js";
import { MAX_LIGHTSTYLES } from "./quakedef.js";
import {
  d_lightstylevalue,
  gl_flashblend,
  LIGHTMAP_INTENSITY,
  MAXLIGHTMAPS,
  r_framecount,
  v_blend,
} from "./glquake.js";
import { r_origin } from "./render.js";
import { cl_dlights, MAX_DLIGHTS } from "./client.js";
import { isXRActive, XR_SCALE } from "./webxr.js";

// defined in client.js
export { MAX_DLIGHTS };

// Surface flags
export const SURF_DRAWTILED = 0x20;

// Plane types for axial optimization
const PLANE_X = 0;
const PLANE_Y = 1;
const PLANE_Z = 2;

// Scratch vectors for RecursiveLightPoint, indexed by the number of planes
// the trace has crossed. Most maps need fewer than 32; a deeper BSP grows
// the pool the first time it gets there (_getLightMid).
const _lightMidPool = [];
for (let i = 0; i < 32; i++) _lightMidPool[i] = new Float32Array(3);

function _getLightMid(depth) {
  let mid = _lightMidPool[depth];
  if (mid === undefined) {
    while (_lightMidPool.length <= depth) {
      _lightMidPool.push(new Float32Array(3));
    }
    mid = _lightMidPool[depth];
  }

  return mid;
}

export let r_dlightframecount = 0;

/*
==================
R_AnimateLight
==================
*/
export function R_AnimateLight(cl, cl_lightstyle) {
  //
  // light animations
  // 'm' is normal light, 'a' is no light, 'z' is double bright
  //
  const i = (cl.time * 10) | 0;
  for (let j = 0; j < MAX_LIGHTSTYLES; j++) {
    if (!cl_lightstyle[j] || !cl_lightstyle[j].length) {
      d_lightstylevalue[j] = 256;
      continue;
    }

    const k_index = i % cl_lightstyle[j].length;
    let k = cl_lightstyle[j].map.charCodeAt(k_index) - 97; // 'a' = 97
    k = k * 22;
    d_lightstylevalue[j] = k;
  }
}

/*
=============================================================================

DYNAMIC LIGHTS BLEND RENDERING

=============================================================================
*/

export function AddLightBlend(r, g, b, a2) {
  let a;

  v_blend[3] = a = v_blend[3] + a2 * (1 - v_blend[3]);

  const a2f = a2 / a;

  v_blend[0] = v_blend[0] * (1 - a2f) + r * a2f;
  v_blend[1] = v_blend[1] * (1 - a2f) + g * a2f;
  v_blend[2] = v_blend[2] * (1 - a2f) + b * a2f;
}

/*
=============
R_RenderDlight

Renders a dynamic light using Three.js PointLight.
=============
*/

// Reusable vector for distance check
const _dlightV = new Float32Array(3);

// Reusable vectors for R_LightPoint
const _lightPointStart = new Float32Array(3);
const _lightPointEnd = new Float32Array(3);

// R_LightPoint's trace length. id has 2048; QuakeSpasm and Ironwail 8192.
const LIGHTPOINT_MAXDIST = 8192;

// Trace state for RecursiveLightPoint, set by R_LightPoint (Ironwail passes
// rayorg and maxdist as arguments). A lightmapped surface without samples
// pulls _lightMaxDist in to just past itself; a lit surface found beyond
// that reads as black.
let _lightRayOrg = _lightPointStart;
let _lightMaxDist = LIGHTPOINT_MAXDIST;

// QuakeSpasm lightcolor ("lit support via lordhavoc"): the colour R_LightPoint
// found, r, g and b on the scale of its return value. All three equal it
// without a .lit.
export const lightcolor = new Float32Array(3);

// Pool of PointLights for dynamic lights
const _dlightPool = [];

// The PointLights' colour for an uncoloured (white) dlight, standing in for
// the orange of GLQuake's flashblend corona
const DLIGHT_FLASHBLEND_COLOR = 0xffaa44;

function _getDlight(index) {
  if (_dlightPool[index] != null) return _dlightPool[index];

  const light = new THREE.PointLight(DLIGHT_FLASHBLEND_COLOR, 1, 300, 0);
  _dlightPool[index] = light;
  return light;
}

/*
Brightness of a dynamic light, matched to the gl_flashblend 0 lightmap path.

R_AddDynamicLights adds ( rad - dist ) light units to a texel. R_BuildLightMap
turns L units into a lightmap byte of 2L (blocklights >> 7), and the world
material reads the lightmap with lightMapIntensity LIGHTMAP_INTENSITY, so one
Quake light unit is 2 * LIGHTMAP_INTENSITY / 255 of Three.js irradiance. (The
lightmap is decoded as sRGB and a PointLight adds linear irradiance, so this
matches at full brightness and is only approximate below it.)

Three.js has no linear falloff. With decay 0 a PointLight gives
intensity * ( 1 - ( d / distance )^4 )^2. Setting distance to the light's
reach and matching the light delivered over the lit disc,
	∫ ( 1 - x ) x dx = 1/6  against  ∫ ( 1 - x^4 )^2 x dx = 4/15,
gives intensity = radius * 2 * LIGHTMAP_INTENSITY / 255 * ( 1/6 ) / ( 4/15 ).
The radius already shrinks by dl.decay in CL_DecayLights, which is the only
fade C has; how long the light has left to live plays no part.
*/
const DLIGHT_IRRADIANCE_PER_UNIT = 2 * LIGHTMAP_INTENSITY / 255;
const DLIGHT_WINDOW_FIT = (1 / 6) / (4 / 15);

export function R_DlightIntensity(light) {
  return light.radius * DLIGHT_IRRADIANCE_PER_UNIT * DLIGHT_WINDOW_FIT;
}

// Reach of a dynamic light: R_AddDynamicLights stops where rad - dist
// falls to minlight.
export function R_DlightDistance(light) {
  return light.radius - light.minlight;
}

export function R_RenderDlight(light, dlightIndex) {
  const rad = light.radius * 0.35;

  VectorSubtract(light.origin, r_origin, _dlightV);
  if (Length(_dlightV) < rad) {
    // view is inside the dlight - add screen blend
    AddLightBlend(1, 0.5, 0, light.radius * 0.0003);
    // Note: Still create the PointLight even when inside - it should
    // still illuminate surfaces (unlike the original corona which
    // would be invisible/behind the camera when inside)
  }

  const pointLight = _getDlight(dlightIndex);

  // Position the light in Quake coordinates (same as camera/geometry)
  pointLight.position.set(light.origin[0], light.origin[1], light.origin[2]);

  // A coloured dlight (Ironwail's 2021 rerelease powerup glows) lights in
  // its own colour; a white one keeps the flashblend orange
  const color = light.color;
  if (color[0] === 1 && color[1] === 1 && color[2] === 1) {
    pointLight.color.setHex(DLIGHT_FLASHBLEND_COLOR);
  } else {
    pointLight.color.setRGB(color[0], color[1], color[2], THREE.SRGBColorSpace);
  }

  // Brightness comes from the radius only (see R_DlightIntensity)
  pointLight.intensity = R_DlightIntensity(light);
  pointLight.distance = R_DlightDistance(light);
  pointLight.decay = 0;

  if (isXRActive()) {
    // scene.scale = 1/XR_SCALE: distances are in meters
    pointLight.distance /= XR_SCALE;
  }

  return pointLight;
}

/*
=============
R_RenderDlights

Updates PointLights for all dynamic lights. Lights stay in scene
and have their intensity updated each frame based on decaying radius.
=============
*/
// Web-only, no C equivalent: at most this many dlights become PointLights
// (R_SetDlightLimit, from gl_rmain.js's gl_dlightcap). The lowest-numbered
// active lights win; the rest are left out of the scene.
let _dlightLimit = MAX_DLIGHTS;

export function R_SetDlightLimit(n) {
  _dlightLimit = n;
}

export function R_RenderDlights(cl, scene) {
  if (gl_flashblend.value === 0) {
    // C draws nothing here and has nothing to undo. The port's
    // PointLights stay in the scene until removed, so take out any left
    // from frames drawn with gl_flashblend 1.
    R_RemoveDlights();
    return;
  }

  r_dlightframecount = r_framecount + 1;

  let rendered = 0;

  for (let i = 0; i < MAX_DLIGHTS; i++) {
    const l = cl_dlights[i];
    const pooledLight = _dlightPool[i];

    // Check if this dlight is active (gl_rlight.c R_RenderDlights:
    // l->die < cl.time || !l->radius). A light whose radius doesn't
    // reach past its minlight adds nothing in R_AddDynamicLights.
    const isActive = l != null && l.die >= cl.time && l.radius > 0 &&
      R_DlightDistance(l) > 0 && rendered < _dlightLimit;

    if (isActive) {
      rendered++;

      // Active - update properties (intensity and reach from the radius)
      const pointLight = R_RenderDlight(l, i);

      // Add to scene if not already there
      if (scene != null && pointLight.parent == null) {
        scene.add(pointLight);
      }
    } else {
      // Inactive - remove from scene if it was there
      if (pooledLight != null && pooledLight.parent != null) {
        pooledLight.parent.remove(pooledLight);
      }
    }
  }
}

// Not in C: removes every pooled PointLight from its scene.
export function R_RemoveDlights() {
  for (let i = 0; i < _dlightPool.length; i++) {
    const light = _dlightPool[i];
    if (light != null && light.parent != null) {
      light.parent.remove(light);
    }
  }
}

/*
=============================================================================

DYNAMIC LIGHTS

=============================================================================
*/

/*
=============
R_MarkLights

Deliberate deviation, from QuakeSpasm: takes the light's index rather than
its bit, and sets that bit in the surface's dlightbits word array, so more
than 32 lights (MAX_DLIGHTS) can be told apart.
=============
*/
export function R_MarkLights(light, num, node, surfaces) {
  if (node.contents < 0) {
    return;
  }

  const splitplane = node.plane;
  const dist = DotProduct(light.origin, splitplane.normal) - splitplane.dist;

  if (dist > light.radius) {
    R_MarkLights(light, num, node.children[0], surfaces);
    return;
  }

  if (dist < -light.radius) {
    R_MarkLights(light, num, node.children[1], surfaces);
    return;
  }

  // mark the polygons
  const word = num >> 5;
  const bit = 1 << (num & 31);
  const surfStart = node.firstsurface;
  for (let i = 0; i < node.numsurfaces; i++) {
    const surf = surfaces[surfStart + i];
    if (!surf) continue;

    if (surf.dlightframe !== r_dlightframecount) {
      // QuakeSpasm only sets the light's own word here, which leaves
      // last frame's bits in the other words; clear them all.
      surf.dlightbits.fill(0);
      surf.dlightframe = r_dlightframecount;
    }

    surf.dlightbits[word] |= bit;
  }

  R_MarkLights(light, num, node.children[0], surfaces);
  R_MarkLights(light, num, node.children[1], surfaces);
}

/*
=============
R_PushDlights
=============
*/
export function R_PushDlights(cl) {
  if (gl_flashblend.value) {
    return;
  }

  r_dlightframecount = r_framecount + 1; // because the count hasn't
  //  advanced yet for this frame

  if (!cl.worldmodel || !cl.worldmodel.nodes) {
    return;
  }

  for (let i = 0; i < MAX_DLIGHTS; i++) {
    const l = cl_dlights[i];
    if (!l) continue;
    if (l.die < cl.time || !l.radius) {
      continue;
    }
    R_MarkLights(l, i, cl.worldmodel.nodes[0], cl.worldmodel.surfaces);
  }
}

/*
=============================================================================

LIGHT SAMPLING

=============================================================================
*/

export let lightplane = null;
export const lightspot = new Float32Array(3);

/*
=============
RecursiveLightPoint
=============
*/
// Not exported: it reads the trace state that only R_LightPoint resets.
function RecursiveLightPoint(node, start, end, surfaces, depth = 0) {
  if (!node || node.contents < 0) {
    return -1; // didn't hit anything
  }

  // calculate mid point
  const plane = node.plane;
  if (!plane) return -1;

  // Optimize for axial planes (very common in Quake maps)
  let front, back;
  switch (plane.type) {
    case PLANE_X:
      front = start[0] - plane.dist;
      back = end[0] - plane.dist;
      break;
    case PLANE_Y:
      front = start[1] - plane.dist;
      back = end[1] - plane.dist;
      break;
    case PLANE_Z:
      front = start[2] - plane.dist;
      back = end[2] - plane.dist;
      break;
    default:
      front = DotProduct(start, plane.normal) - plane.dist;
      back = DotProduct(end, plane.normal) - plane.dist;
      break;
  }

  const side = front < 0 ? 1 : 0;

  if ((back < 0) === (front < 0)) {
    return RecursiveLightPoint(
      node.children[side],
      start,
      end,
      surfaces,
      depth,
    );
  }

  const frac = front / (front - back);
  // Use pre-allocated scratch vector from pool (indexed by recursion depth)
  const mid = _getLightMid(depth);
  mid[0] = start[0] + (end[0] - start[0]) * frac;
  mid[1] = start[1] + (end[1] - start[1]) * frac;
  mid[2] = start[2] + (end[2] - start[2]) * frac;

  // go down front side
  let r = RecursiveLightPoint(
    node.children[side],
    start,
    mid,
    surfaces,
    depth + 1,
  );
  if (r >= 0) {
    return r; // hit something
  }

  if ((back < 0) === (front < 0)) {
    return -1; // didn't hit anything
  }

  // check for impact on this node
  VectorCopy(mid, lightspot);
  lightplane = plane;

  const surfStart = node.firstsurface;
  for (let i = 0; i < node.numsurfaces; i++) {
    const surf = surfaces[surfStart + i];
    if (!surf) continue;

    if (surf.flags & SURF_DRAWTILED) {
      continue; // no lightmaps
    }

    const tex = surf.texinfo;

    // r_light.c RecursiveLightPoint declares s, t, ds and dt as int, so the
    // assignment truncates toward zero (`| 0`), as Ironwail's (int) casts do.
    const s = (DotProduct(mid, tex.vecs[0]) + tex.vecs[0][3]) | 0;
    const t = (DotProduct(mid, tex.vecs[1]) + tex.vecs[1][3]) | 0;

    if (s < surf.texturemins[0] || t < surf.texturemins[1]) {
      continue;
    }

    const ds = s - surf.texturemins[0];
    const dt = t - surf.texturemins[1];

    if (ds > surf.extents[0] || dt > surf.extents[1]) {
      continue;
    }

    // Deliberate deviation (QuakeSpasm/Ironwail RecursiveLightPoint): id
    // returns black at the first lightmapped surface without samples.
    // Overlapping surfaces with mixed lighting data made models pitch
    // black in lit areas, so look on for a lit surface within 8 units.
    const sp = surf.plane;
    const sfront = DotProduct(_lightRayOrg, sp.normal) - sp.dist;
    const sback = DotProduct(end, sp.normal) - sp.dist;
    const dx = end[0] - _lightRayOrg[0];
    const dy = end[1] - _lightRayOrg[1];
    const dz = end[2] - _lightRayOrg[2];
    const dist = sfront / (sfront - sback) *
      Math.sqrt(dx * dx + dy * dy + dz * dz);

    if (!surf.samples) {
      _lightMaxDist = Math.min(_lightMaxDist, dist + 8);
      continue;
    }

    if (dist >= _lightMaxDist) {
      return 0;
    }

    const ds4 = ds >> 4;
    const dt4 = dt >> 4;

    const lightmap = surf.samples;
    r = 0;
    if (lightmap && surf.rgbsamples === true) {
      // QuakeSpasm (lit support via lordhavoc): *3 for colour. id's
      // point sample, not QuakeSpasm's bilinear filter, as for mono.
      let lightmapOffset = (surf.sampleOffset || 0) +
        (dt4 * ((surf.extents[0] >> 4) + 1) + ds4) * 3;
      let g = 0;
      let b = 0;

      for (
        let maps = 0;
        maps < MAXLIGHTMAPS && surf.styles[maps] !== 255;
        maps++
      ) {
        const scale = d_lightstylevalue[surf.styles[maps]];
        r += lightmap[lightmapOffset] * scale;
        g += lightmap[lightmapOffset + 1] * scale;
        b += lightmap[lightmapOffset + 2] * scale;
        lightmapOffset += ((surf.extents[0] >> 4) + 1) *
          ((surf.extents[1] >> 4) + 1) * 3;
      }

      r >>= 8;
      g >>= 8;
      b >>= 8;
      lightcolor[0] = r;
      lightcolor[1] = g;
      lightcolor[2] = b;
      // QuakeSpasm R_LightPoint returns the mean of the three
      return ((r + g + b) / 3) | 0;
    } else if (lightmap) {
      let lightmapOffset = (surf.sampleOffset || 0) +
        dt4 * ((surf.extents[0] >> 4) + 1) + ds4;

      for (
        let maps = 0;
        maps < MAXLIGHTMAPS && surf.styles[maps] !== 255;
        maps++
      ) {
        const scale = d_lightstylevalue[surf.styles[maps]];
        r += lightmap[lightmapOffset] * scale;
        lightmapOffset += ((surf.extents[0] >> 4) + 1) *
          ((surf.extents[1] >> 4) + 1);
      }

      r >>= 8;
    }

    lightcolor[0] = lightcolor[1] = lightcolor[2] = r;
    return r;
  }

  // go down back side
  return RecursiveLightPoint(
    node.children[side ? 0 : 1],
    mid,
    end,
    surfaces,
    depth + 1,
  );
}

/*
=============
R_LightPoint
=============
*/
// ofs (Ironwail): start the trace this far above p. R_SetupAliasLighting
// retries with ofs = model maxs[2] * 0.5 when the first trace is black, for
// models whose origin is just below the floor.
export function R_LightPoint(p, cl, ofs = 0) {
  if (!cl.worldmodel || !cl.worldmodel.lightdata) {
    lightcolor[0] = lightcolor[1] = lightcolor[2] = 255;
    return 255;
  }

  lightcolor[0] = lightcolor[1] = lightcolor[2] = 0;

  const start = _lightPointStart;
  start[0] = p[0];
  start[1] = p[1];
  start[2] = p[2] + ofs;

  // Deliberate deviation (QuakeSpasm/Ironwail): trace 8192 units, not 2048
  const end = _lightPointEnd;
  end[0] = start[0];
  end[1] = start[1];
  end[2] = start[2] - LIGHTPOINT_MAXDIST;

  _lightRayOrg = start;
  _lightMaxDist = LIGHTPOINT_MAXDIST;

  let r = RecursiveLightPoint(
    cl.worldmodel.nodes[0],
    start,
    end,
    cl.worldmodel.surfaces,
  );

  if (r === -1) {
    r = 0;
  }

  return r;
}

/*
=============
R_AddDynamicLights

Add contribution of dynamic lights to a surface's lightmap.
In Three.js, this can be used to compute per-vertex lighting contributions
from dynamic lights for surfaces near them.
=============
*/
export function R_AddDynamicLights(surf, cl) {
  if (!cl || !cl.dlights) {
    return;
  }

  for (let lnum = 0; lnum < MAX_DLIGHTS; lnum++) {
    if (!(surf.dlightbits[lnum >> 5] & (1 << (lnum & 31)))) {
      continue; // not lit by this light
    }

    const dl = cl.dlights[lnum];
    if (!dl) continue;

    const dist = DotProduct(dl.origin, surf.plane.normal) - surf.plane.dist;
    const rad = dl.radius - Math.abs(dist);
    if (rad < 0) {
      continue;
    }

    // This light affects this surface
    // In a full Three.js implementation, you'd update the surface's
    // lightmap texture data here based on the light contribution
  }
}

/*
=============
dlight_t class
=============
*/
export class dlight_t {
  constructor() {
    this.origin = new Float32Array(3);
    this.radius = 0;
    this.die = 0; // stop lighting after this time
    this.decay = 0; // drop this each second
    this.minlight = 0; // don't add when contributing less
    this.key = 0;
    this.color = new Float32Array([1, 1, 1]); //johnfitz -- lit support via lordhavoc
  }
}
