// Mirror surfaces -- Three.js port of GLQuake's R_Mirror (gl_rmain.c) and
// R_MirrorChain (gl_rsurf.c).
//
// GLQuake only reflects when r_mirroralpha != 1. It re-renders the scene from
// the viewpoint reflected through the mirror plane, then draws the mirror
// surface over that image at r_mirroralpha. Here the reflected scene goes into
// a render target (Reflector-style: a proper-rotation virtual camera plus an
// oblique near plane), and the mirror surface is redrawn with a shader that
// mixes the surface texture with the reflection in output (gamma) space, as
// GLQuake's framebuffer blend does:
//   colour = mix( reflection, texture, r_mirroralpha )
//
// Limits: not run under WebXR (stereo views need one reflection per eye), and
// the reflected pass reuses the main view's PVS and entity list, as GLQuake's
// does, so entities culled by the main frustum are missing from reflections.
//
// The maths helpers use plain arrays (column-major 4x4, like THREE.Matrix4)
// so they can be unit tested without WebGL.

import * as THREE from "three";

// Gate

// True when a mirror pass should run. GLQuake runs it for r_mirroralpha != 1;
// values above 1 mean nothing, so only < 1 counts. No pass under WebXR.
export function R_MirrorGate(alpha, xrActive) {
  return xrActive !== true && alpha < 1;
}

// Reflection maths. A plane is normal . p = dist, normal unit length.

export function R_ReflectPoint(out, p, normal, dist) {
  const d = normal[0] * p[0] + normal[1] * p[1] + normal[2] * p[2] - dist;
  out[0] = p[0] - 2 * d * normal[0];
  out[1] = p[1] - 2 * d * normal[1];
  out[2] = p[2] - 2 * d * normal[2];
  return out;
}

export function R_ReflectVector(out, v, normal) {
  const d = normal[0] * v[0] + normal[1] * v[1] + normal[2] * v[2];
  out[0] = v[0] - 2 * d * normal[0];
  out[1] = v[1] - 2 * d * normal[1];
  out[2] = v[2] - 2 * d * normal[2];
  return out;
}

// Scratch for R_MirrorCameraWorld (reflected in place: R_ReflectPoint and
// R_ReflectVector read the input before writing the output).
const _mcPos = new Float64Array(3);
const _mcUp = new Float64Array(3);
const _mcFwd = new Float64Array(3);

// World matrix of the virtual camera: the camera reflected through the plane.
// A true mirror matrix has determinant -1, so the right vector is rebuilt as
// forward x up to keep a proper rotation (the image comes out flipped, which
// the projective texture lookup in the mirror shader undoes).
// cam is a column-major camera world matrix: x = right, y = up, z = -forward.
export function R_MirrorCameraWorld(out, cam, normal, dist) {
  _mcPos[0] = cam[12];
  _mcPos[1] = cam[13];
  _mcPos[2] = cam[14];
  _mcUp[0] = cam[4];
  _mcUp[1] = cam[5];
  _mcUp[2] = cam[6];
  _mcFwd[0] = -cam[8];
  _mcFwd[1] = -cam[9];
  _mcFwd[2] = -cam[10];
  const pos = R_ReflectPoint(_mcPos, _mcPos, normal, dist);
  const up = R_ReflectVector(_mcUp, _mcUp, normal);
  const fwd = R_ReflectVector(_mcFwd, _mcFwd, normal);

  // right = forward x up
  const rx = fwd[1] * up[2] - fwd[2] * up[1];
  const ry = fwd[2] * up[0] - fwd[0] * up[2];
  const rz = fwd[0] * up[1] - fwd[1] * up[0];

  out[0] = rx;
  out[1] = ry;
  out[2] = rz;
  out[3] = 0;
  out[4] = up[0];
  out[5] = up[1];
  out[6] = up[2];
  out[7] = 0;
  out[8] = -fwd[0];
  out[9] = -fwd[1];
  out[10] = -fwd[2];
  out[11] = 0;
  out[12] = pos[0];
  out[13] = pos[1];
  out[14] = pos[2];
  out[15] = 1;
  return out;
}

// Rigid-body inverse of a column-major matrix with orthonormal axes.
export function R_RigidInverse(out, m) {
  out[0] = m[0];
  out[1] = m[4];
  out[2] = m[8];
  out[3] = 0;
  out[4] = m[1];
  out[5] = m[5];
  out[6] = m[9];
  out[7] = 0;
  out[8] = m[2];
  out[9] = m[6];
  out[10] = m[10];
  out[11] = 0;
  out[12] = -(m[0] * m[12] + m[1] * m[13] + m[2] * m[14]);
  out[13] = -(m[4] * m[12] + m[5] * m[13] + m[6] * m[14]);
  out[14] = -(m[8] * m[12] + m[9] * m[13] + m[10] * m[14]);
  out[15] = 1;
  return out;
}

// Express the world plane (normal . p = dist, kept side positive) in camera
// space as [ a, b, c, d ] with a*x + b*y + c*z + d >= 0 on the kept side.
// view is the column-major world->camera matrix.
export function R_PlaneToCameraSpace(out, normal, dist, view) {
  const nx = view[0] * normal[0] + view[4] * normal[1] + view[8] * normal[2];
  const ny = view[1] * normal[0] + view[5] * normal[1] + view[9] * normal[2];
  const nz = view[2] * normal[0] + view[6] * normal[1] + view[10] * normal[2];

  // a point on the plane, into camera space
  const px = normal[0] * dist, py = normal[1] * dist, pz = normal[2] * dist;
  const cx = view[0] * px + view[4] * py + view[8] * pz + view[12];
  const cy = view[1] * px + view[5] * py + view[9] * pz + view[13];
  const cz = view[2] * px + view[6] * py + view[10] * pz + view[14];

  out[0] = nx;
  out[1] = ny;
  out[2] = nz;
  out[3] = -(nx * cx + ny * cy + nz * cz);
  return out;
}

// Lengyel's oblique near-plane clipping: replaces the near plane of a
// perspective projection (column-major, in place) with clipPlane (camera
// space, kept side positive, camera on the clipped side). Same as
// THREE.Reflector.
export function R_ObliqueProjection(proj, clipPlane, bias = 0) {
  const qx = (Math.sign(clipPlane[0]) + proj[8]) / proj[0];
  const qy = (Math.sign(clipPlane[1]) + proj[9]) / proj[5];
  const qz = -1.0;
  const qw = (1.0 + proj[10]) / proj[14];

  const k = 2.0 /
    (clipPlane[0] * qx + clipPlane[1] * qy + clipPlane[2] * qz +
      clipPlane[3] * qw);

  proj[2] = clipPlane[0] * k;
  proj[6] = clipPlane[1] * k;
  proj[10] = clipPlane[2] * k + 1.0 - bias;
  proj[14] = clipPlane[3] * k;
  return proj;
}

// Render pass

const MIRROR_VERTEX = `
uniform mat4 textureMatrix;
varying vec4 vReflUv;
varying vec2 vUv;
void main() {
	vUv = uv;
	vReflUv = textureMatrix * vec4( position, 1.0 );
	gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

const MIRROR_FRAGMENT = `
uniform sampler2D map;
uniform sampler2D reflection;
uniform float alpha;
varying vec4 vReflUv;
varying vec2 vUv;
// GLQuake blends in the framebuffer, on gamma-encoded colours, so both
// inputs are taken to output space (exposure, then sRGB) before the mix.
// The reflection target holds linear colour without tone mapping, as
// three.js renders into a render target.
vec3 R_MirrorOutput( vec3 c ) {
#if defined( TONE_MAPPING )
	c = toneMapping( c );
#endif
	return linearToOutputTexel( vec4( c, 1.0 ) ).rgb;
}
void main() {
	vec3 refl = R_MirrorOutput( texture2D( reflection, vReflUv.xy / vReflUv.w ).rgb );
	vec3 tex = R_MirrorOutput( texture2D( map, vUv ).rgb );
	gl_FragColor = vec4( mix( refl, tex, alpha ), 1.0 );
}
`;

// Everything the pass needs per frame is allocated once here or on first use
// (Golden Rule #4): R_MirrorPass and R_MirrorCleanup allocate nothing after
// the first frame, except when a map has more visible mirror surfaces than
// any frame before it, which grows the pools below.
let _target = null;
let _material = null;
let _group = null;
let _virtualCamera = null;
let _viewport = null; // THREE.Vector4 for renderer.getViewport
const _textureMatrix = new THREE.Matrix4(); // the overlay's textureMatrix uniform
const _keepNormal = new Float64Array(3);
const _clipPlane = new Float64Array(4);

// Overlay meshes, one per visible mirror surface, kept in _group. They take
// their surface's geometry for the frame and give it back in R_MirrorCleanup
// (pointing at _emptyGeometry), so a disposed geometry from an earlier map
// (R_ClearMirrors) is never kept alive by the pool.
const _meshes = [];
let _emptyGeometry = null;

// Undo list for the frame in progress: mirror instances hidden in the world
// batches, with their previous visibility. _restoreCount is -1 when there is
// nothing to undo.
const _restoreBatch = [];
const _restoreId = [];
const _restoreVisible = [];
let _restoreCount = -1;

// Objects hidden for the reflection render only.
const _hidden = [];

function _ensureTarget(w, h) {
  if (_target !== null && (_target.width !== w || _target.height !== h)) {
    _target.dispose();
    _target = null;
  }

  if (_target === null) {
    _target = new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false,
      depthBuffer: true,
    });
  }

  return _target;
}

function _ensureOverlay() {
  if (_material === null) {
    _material = new THREE.ShaderMaterial({
      uniforms: {
        map: { value: null },
        reflection: { value: null },
        alpha: { value: 1 },
        textureMatrix: { value: _textureMatrix },
      },
      vertexShader: MIRROR_VERTEX,
      fragmentShader: MIRROR_FRAGMENT,
    });
  }

  if (_emptyGeometry === null) {
    _emptyGeometry = new THREE.BufferGeometry();
  }

  if (_group === null) {
    _group = new THREE.Group();
    _group.name = "quake_mirror";
  }
}

// Render the reflected scene and put the mirror overlay into the scene.
// items: [ { geom, texture, batch, instanceId } ] for the visible mirror
// surfaces on `plane` ({ normal, dist }). hide: objects to hide in the
// reflection (the view weapon). Call R_MirrorCleanup after the main render.
// Returns false when nothing was drawn.
export function R_MirrorPass(
  renderer,
  scene,
  camera,
  plane,
  items,
  alpha,
  hide,
) {
  if (items.length === 0) {
    return false;
  }

  camera.updateMatrixWorld();
  const cam = camera.matrixWorld.elements;

  // keep the side of the plane the viewer is on
  const side = plane.normal[0] * cam[12] + plane.normal[1] * cam[13] +
    plane.normal[2] * cam[14] - plane.dist;
  if (Math.abs(side) < 0.5) {
    return false; // eye on the plane, nothing sensible to reflect
  }

  const sgn = side > 0 ? 1 : -1;
  _keepNormal[0] = plane.normal[0] * sgn;
  _keepNormal[1] = plane.normal[1] * sgn;
  _keepNormal[2] = plane.normal[2] * sgn;
  const keepDist = plane.dist * sgn;

  // virtual camera
  if (_virtualCamera === null) {
    _virtualCamera = new THREE.PerspectiveCamera();
  }

  const vc = _virtualCamera;
  vc.fov = camera.fov;
  vc.aspect = camera.aspect;
  vc.near = camera.near;
  vc.far = camera.far;
  vc.updateProjectionMatrix();

  vc.matrixAutoUpdate = false;
  vc.matrixWorldAutoUpdate = false;
  const world = vc.matrixWorld.elements;
  R_MirrorCameraWorld(world, cam, _keepNormal, keepDist);
  R_RigidInverse(vc.matrixWorldInverse.elements, world);

  // projective texture matrix: bias * projection * view, before the
  // oblique modification
  _textureMatrix.set(
    0.5,
    0.0,
    0.0,
    0.5,
    0.0,
    0.5,
    0.0,
    0.5,
    0.0,
    0.0,
    0.5,
    0.5,
    0.0,
    0.0,
    0.0,
    1.0,
  );
  _textureMatrix.multiply(vc.projectionMatrix);
  _textureMatrix.multiply(vc.matrixWorldInverse);

  R_PlaneToCameraSpace(
    _clipPlane,
    _keepNormal,
    keepDist,
    vc.matrixWorldInverse.elements,
  );
  R_ObliqueProjection(vc.projectionMatrix.elements, _clipPlane);
  vc.projectionMatrixInverse.copy(vc.projectionMatrix).invert();

  // render target at the size of the main viewport
  if (_viewport === null) {
    _viewport = new THREE.Vector4();
  }

  const vp = renderer.getViewport(_viewport);
  const ratio = renderer.getPixelRatio();
  const w = Math.max(1, Math.min(4096, Math.round(vp.width * ratio)));
  const h = Math.max(1, Math.min(4096, Math.round(vp.height * ratio)));
  const target = _ensureTarget(w, h);

  // hide the real mirror surfaces and the objects that don't belong in a reflection
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    _restoreBatch[i] = it.batch;
    _restoreId[i] = it.instanceId;
    _restoreVisible[i] = it.batch.getVisibleAt(it.instanceId);
    it.batch.setVisibleAt(it.instanceId, false);
  }

  _restoreCount = items.length;

  let numHidden = 0;
  for (let i = 0; i < hide.length; i++) {
    const o = hide[i];
    if (o !== null && o !== undefined && o.visible === true) {
      o.visible = false;
      _hidden[numHidden++] = o;
    }
  }

  const prevTarget = renderer.getRenderTarget();
  renderer.setRenderTarget(target);
  renderer.clear(true, true, true);
  renderer.render(scene, vc);
  renderer.setRenderTarget(prevTarget);

  for (let i = 0; i < numHidden; i++) {
    _hidden[i].visible = true;
    _hidden[i] = null;
  }

  // overlay: the mirror surface drawn with the reflection mixed in. No
  // lightmap, as in GLQuake: R_Mirror's overlay loop calls R_RenderBrushPoly,
  // which draws the texture and only chains the poly onto lightmap_polys.
  // Both R_BlendLightmaps calls (gl_rsurf.c R_DrawBrushModel :1169 and
  // R_DrawWorld :1336) have already run for the frame, and the next
  // R_DrawWorld clears the chains, so the overlay is never lightmapped.
  _ensureOverlay();

  // there is only ever one mirror texture
  _material.uniforms.map.value = items[0].texture;
  _material.uniforms.reflection.value = target.texture;
  _material.uniforms.alpha.value = alpha;

  for (let i = 0; i < items.length; i++) {
    let mesh = _meshes[i];
    if (mesh === undefined) {
      mesh = new THREE.Mesh(items[i].geom, _material);
      mesh.frustumCulled = false;
      _meshes[i] = mesh;
      _group.add(mesh);
    }

    mesh.geometry = items[i].geom;
    mesh.visible = true;
  }

  for (let i = items.length; i < _meshes.length; i++) {
    _meshes[i].geometry = _emptyGeometry;
    _meshes[i].visible = false;
  }

  scene.add(_group);
  return true;
}

// Undo R_MirrorPass after the main render. Safe to call every frame.
export function R_MirrorCleanup() {
  if (_restoreCount < 0) {
    return;
  }

  for (let i = 0; i < _restoreCount; i++) {
    _restoreBatch[i].setVisibleAt(_restoreId[i], _restoreVisible[i]);
    _restoreBatch[i] = null;
  }

  _restoreCount = -1;

  if (_group !== null && _group.parent !== null) {
    _group.parent.remove(_group);
  }

  for (let i = 0; i < _meshes.length; i++) {
    _meshes[i].geometry = _emptyGeometry;
  }
}
