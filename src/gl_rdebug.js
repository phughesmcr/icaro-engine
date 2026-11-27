// Ported from: Ironwail Quake/gl_rmain.c (R_ShowTris, R_ShowBoundingBoxes,
// R_EmitWireBox, R_EmitWirePoint) -- johnfitz's debug views
//
// r_showtris draws every triangle of the 3D view as white lines; 1 shows
// them through walls, 2 only where visible. r_showbboxes draws the local
// server's entity boxes (the physics boxes, not the renderer's cull boxes).
// Both are single-player only, as in Ironwail: with cl.maxclients above 1
// they would show players and monsters through walls.
//
// Deliberate deviations from Ironwail:
// - r_showtris draws the whole Three.js scene again with one override
//   material, so model interpolation (r_lerpmodels), the water vertex warp
//   and the sky's shaders are left out of the lines; Ironwail draws each
//   model with its own pipeline in line mode. WebGL has no polygon offset
//   for lines, so mode 2 moves the lines a little towards the camera instead.
// - r_showbboxes leaves out Ironwail's later additions: the focused box
//   under the crosshair and its links (r_showbboxes_links, _targets), the
//   filters (r_showbboxes_think, _health, r_showbboxes_filter) and
//   r_showfields. In mode 2 an entity with no leafs is shown, where Ironwail
//   tests its box against the PVS.

import * as THREE from "three";
import { cl } from "./client.js";
import { r_drawentities } from "./glquake.js";
import { R_CullBox } from "./gl_rmain.js";
import { renderer } from "./vid.js";
import { sv } from "./server.js";
import { sv_player } from "./sv_phys.js";
import { SV_FatPVS } from "./sv_main.js";
import { MAX_ENT_LEAFS } from "./progs.js";
import { mod_alias, mod_brush, mod_sprite } from "./mod_types.js";

/** Ironwail r_showtris (gl_rmain.c): 0 off, 1 through walls, 2 visible only */
export const r_showtris = { name: "r_showtris", string: "0", value: 0 };

/**
 * Ironwail r_showbboxes (gl_rmain.c): 0 off, 1 every entity in view, 2 only
 * those in the player's PVS; a negative value draws the boxes white.
 */
export const r_showbboxes = { name: "r_showbboxes", string: "0", value: 0 };

/** Ironwail R_ShowTris: whether r_showtris draws this frame. */
export function R_ShowTrisMode(value, maxclients) {
  if (value < 1 || value > 2 || maxclients > 1) return 0;
  return value === 1 ? 1 : 2;
}

/**
 * Ironwail R_ShowBoundingBoxes: the box colour, as its little-endian RGBA
 * uint32 (red in the low byte). modeltype is the edict's model type, or -1.
 */
export function R_BBoxColor(showbboxes, modeltype, health) {
  if (showbboxes > 0) {
    if (health > 0) return 0x7f0000ff;
    if (modeltype === mod_brush) return 0x7fff8080;
    if (modeltype === mod_alias) return 0x7f408080;
    if (modeltype === mod_sprite) return 0x7f4040ff;
    return 0x7f800080;
  }
  if (showbboxes < 0) return 0x7fffffff;
  return 0x5f7f7f7f;
}

// r_showtris. Three.js wireframe doesn't work for BatchedMesh (the world and
// brush models): its line index doesn't follow the batch's draw ranges. So
// unindexed geometry draws filled with only the pixels next to an edge kept,
// the corner coming from gl_VertexID; indexed geometry (alias models) uses
// ordinary wireframe lines.
let _trisMaterial = null; // [ through walls, depth tested ]

const TRIS_VERTEX_SHADER = `
#include <common>
#include <batching_pars_vertex>
uniform float Offset;
varying vec3 vCorner;
void main() {
	#include <batching_vertex>
	#include <begin_vertex>
	#include <project_vertex>
	// stands in for GL_PolygonOffset (OFFSET_SHOWTRIS)
	gl_Position.z -= Offset * gl_Position.w;
	int corner = gl_VertexID % 3;
	vCorner = vec3( corner == 0, corner == 1, corner == 2 );
}
`;

const TRIS_FRAGMENT_SHADER = `
uniform float Edges;
varying vec3 vCorner;
void main() {
	if ( Edges > 0.5 && all( greaterThan( vCorner, fwidth( vCorner ) ) ) ) {
		discard;
	}
	gl_FragColor = vec4( 1.0 );
}
`;

/** Per draw: edge pixels for unindexed geometry, lines for indexed. */
function R_TrisBeforeRender(_renderer, _scene, _camera, geometry) {
  const edges = geometry.index === null ? 1 : 0;
  this.wireframe = edges === 0;
  if (this.uniforms.Edges.value !== edges) {
    this.uniforms.Edges.value = edges;
    this.uniformsNeedUpdate = true;
  }
}

function R_TrisCreate() {
  _trisMaterial = [];
  for (let i = 0; i < 2; i++) {
    const material = new THREE.ShaderMaterial({
      uniforms: {
        Edges: { value: 0 },
        Offset: { value: i === 1 ? 0.0005 : 0 },
      },
      vertexShader: TRIS_VERTEX_SHADER,
      fragmentShader: TRIS_FRAGMENT_SHADER,
      depthTest: i === 1,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    material.onBeforeRender = R_TrisBeforeRender;
    _trisMaterial.push(material);
  }
}

/**
 * Ironwail R_ShowTris, called by R_RenderView once the scene is drawn: draws
 * the scene again in white lines.
 */
export function R_ShowTris(scene, camera) {
  const mode = R_ShowTrisMode(r_showtris.value, cl.maxclients);
  if (mode === 0 || renderer === null || scene === null || camera === null) {
    return;
  }
  if (_trisMaterial === null) R_TrisCreate();

  const background = scene.background;
  scene.background = null;
  scene.overrideMaterial = _trisMaterial[mode - 1];
  renderer.render(scene, camera);
  scene.overrideMaterial = null;
  scene.background = background;
}

// r_showbboxes: one line list, refilled each frame. Grows (and only then
// allocates) when a map has more boxes in view than it holds.
const BOX_VERTS = 24; // 12 edges
let _bboxScene = null;
let _bboxLines = null;
let _bboxPositions = null;
let _bboxColors = null;
let _bboxCapacity = 0; // boxes
let _bboxVerts = 0;
const _bboxMins = new Float32Array(3);
const _bboxMaxs = new Float32Array(3);
const _bboxOrg = new Float32Array(3);

// sRGB byte to linear: Three converts the line colours back on output
const _srgbToLinear = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const s = i / 255;
  _srgbToLinear[i] = s <= 0.04045 ?
    s / 12.92 :
    Math.pow((s + 0.055) / 1.055, 2.4);
}

function R_BBoxAlloc(boxes) {
  _bboxCapacity = boxes;
  _bboxPositions = new Float32Array(boxes * BOX_VERTS * 3);
  _bboxColors = new Float32Array(boxes * BOX_VERTS * 4);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(_bboxPositions, 3).setUsage(
      THREE.DynamicDrawUsage,
    ),
  );
  geometry.setAttribute(
    "color",
    new THREE.BufferAttribute(_bboxColors, 4).setUsage(THREE.DynamicDrawUsage),
  );
  if (_bboxLines === null) {
    // Ironwail R_FlushDebugGeometry: alpha blended, no depth write, and no
    // depth test for the boxes (R_SetDebugGeometryZTest (false))
    const material = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      fog: false,
      toneMapped: false,
    });
    _bboxLines = new THREE.LineSegments(geometry, material);
    _bboxLines.frustumCulled = false;
    _bboxScene = new THREE.Scene();
    _bboxScene.add(_bboxLines);
  } else {
    _bboxLines.geometry.dispose();
    _bboxLines.geometry = geometry;
  }
}

function R_EmitLine(ax, ay, az, bx, by, bz, color) {
  const p = _bboxVerts * 3;
  _bboxPositions[p] = ax;
  _bboxPositions[p + 1] = ay;
  _bboxPositions[p + 2] = az;
  _bboxPositions[p + 3] = bx;
  _bboxPositions[p + 4] = by;
  _bboxPositions[p + 5] = bz;
  const r = _srgbToLinear[color & 0xff];
  const g = _srgbToLinear[(color >>> 8) & 0xff];
  const b = _srgbToLinear[(color >>> 16) & 0xff];
  const a = ((color >>> 24) & 0xff) / 255;
  const c = _bboxVerts * 4;
  for (let i = 0; i < 8; i += 4) {
    _bboxColors[c + i] = r;
    _bboxColors[c + i + 1] = g;
    _bboxColors[c + i + 2] = b;
    _bboxColors[c + i + 3] = a;
  }
  _bboxVerts += 2;
}

/** Ironwail R_EmitWirePoint: a 16-unit cross for a point entity. */
function R_EmitWirePoint(org, color) {
  const x = org[0];
  const y = org[1];
  const z = org[2];
  R_EmitLine(x - 8, y, z, x + 8, y, z, color);
  R_EmitLine(x, y - 8, z, x, y + 8, z, color);
  R_EmitLine(x, y, z - 8, x, y, z + 8, color);
}

// Ironwail boxidx: corner i has x = i & 1 ? mins : maxs, y = i & 2, z = i & 4
const BOXIDX = [
  0,
  1,
  0,
  2,
  0,
  4,
  1,
  3,
  1,
  5,
  2,
  3,
  2,
  6,
  3,
  7,
  4,
  5,
  4,
  6,
  5,
  7,
  6,
  7,
];
const _boxCorners = new Float32Array(24);

/** Ironwail R_EmitWireBox: the 12 edges of an axis-aligned box. */
function R_EmitWireBox(mins, maxs, color) {
  for (let i = 0; i < 8; i++) {
    _boxCorners[i * 3] = (i & 1) !== 0 ? mins[0] : maxs[0];
    _boxCorners[i * 3 + 1] = (i & 2) !== 0 ? mins[1] : maxs[1];
    _boxCorners[i * 3 + 2] = (i & 4) !== 0 ? mins[2] : maxs[2];
  }
  for (let i = 0; i < BOXIDX.length; i += 2) {
    const a = BOXIDX[i] * 3;
    const b = BOXIDX[i + 1] * 3;
    R_EmitLine(
      _boxCorners[a],
      _boxCorners[a + 1],
      _boxCorners[a + 2],
      _boxCorners[b],
      _boxCorners[b + 1],
      _boxCorners[b + 2],
      color,
    );
  }
}

function R_EdictInPVS(ed, pvs) {
  if (ed.num_leafs === 0 || ed.num_leafs >= MAX_ENT_LEAFS) return true;
  for (let i = 0; i < ed.num_leafs; i++) {
    const leafnum = ed.leafnums[i];
    if ((pvs[leafnum >> 3] & (1 << (leafnum & 7))) !== 0) return true;
  }
  return false;
}

/**
 * Ironwail R_ShowBoundingBoxes, called by R_RenderView once the scene is
 * drawn: the local server's entity boxes, over everything.
 */
export function R_ShowBoundingBoxes(camera) {
  const mode = Math.abs(Math.trunc(r_showbboxes.value));
  if (
    mode === 0 || cl.maxclients > 1 || r_drawentities.value === 0 ||
    sv.active !== true || sv.edicts === null || renderer === null ||
    camera === null
  ) {
    return;
  }
  if (_bboxLines === null) R_BBoxAlloc(256);

  let pvs = null;
  if (mode >= 2 && sv_player !== null) {
    for (let i = 0; i < 3; i++) {
      _bboxOrg[i] = sv_player.v.origin[i] + sv_player.v.view_ofs[i];
    }
    pvs = SV_FatPVS(_bboxOrg);
  }

  _bboxVerts = 0;
  for (let e = 1; e < sv.num_edicts; e++) {
    const ed = sv.edicts[e];
    if (ed === sv_player || ed.free === true) continue;

    const v = ed.v;
    const point = v.mins[0] === v.maxs[0] && v.mins[1] === v.maxs[1] &&
      v.mins[2] === v.maxs[2];
    // point entities are culled as a 16-unit box
    const extend = point ? 8 : 0;
    for (let j = 0; j < 3; j++) {
      _bboxMins[j] = v.origin[j] + v.mins[j] - extend;
      _bboxMaxs[j] = v.origin[j] + v.maxs[j] + extend;
    }
    if (R_CullBox(_bboxMins, _bboxMaxs)) continue;
    if (pvs !== null && R_EdictInPVS(ed, pvs) === false) continue;

    if (_bboxVerts + BOX_VERTS > _bboxCapacity * BOX_VERTS) {
      // keep what is filled so far
      const positions = _bboxPositions;
      const colors = _bboxColors;
      R_BBoxAlloc(_bboxCapacity * 2);
      _bboxPositions.set(positions);
      _bboxColors.set(colors);
    }

    const modelindex = v.modelindex | 0;
    const model = modelindex >= 0 && modelindex < sv.models.length ?
      sv.models[modelindex] :
      null;
    const color = R_BBoxColor(
      r_showbboxes.value,
      model !== null && model !== undefined ? model.type : -1,
      v.health,
    );

    if (point) {
      R_EmitWirePoint(v.origin, color);
    } else {
      for (let j = 0; j < 3; j++) {
        _bboxMins[j] = v.origin[j] + v.mins[j];
        _bboxMaxs[j] = v.origin[j] + v.maxs[j];
      }
      R_EmitWireBox(_bboxMins, _bboxMaxs, color);
    }
  }

  if (_bboxVerts === 0) return;
  const geometry = _bboxLines.geometry;
  geometry.setDrawRange(0, _bboxVerts);
  geometry.attributes.position.needsUpdate = true;
  geometry.attributes.color.needsUpdate = true;
  renderer.render(_bboxScene, camera);
}
