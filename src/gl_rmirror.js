// Mirror surfaces -- Three.js port of GLQuake's R_Mirror (gl_rmain.c) and
// R_MirrorChain (gl_rsurf.c).
//
// GLQuake only reflects when r_mirroralpha != 1. It re-renders the scene from
// the viewpoint reflected through the mirror plane, then draws the mirror
// surface over that image at r_mirroralpha. Here the reflected scene goes into
// a render target (Reflector-style: a proper-rotation virtual camera plus an
// oblique near plane), and the mirror surface is redrawn with a shader that
// mixes the surface texture with the reflection:
//   colour = mix( reflection, texture, r_mirroralpha )
//
// Limits: not run under WebXR (stereo views need one reflection per eye), and
// the reflected pass reuses the main view's PVS and entity list, as GLQuake's
// does, so entities culled by the main frustum are missing from reflections.
//
// The maths helpers use plain arrays (column-major 4x4, like THREE.Matrix4)
// so they can be unit tested without WebGL.

import * as THREE from 'three';

//============================================================================
// Gate
//============================================================================

// True when a mirror pass should run. GLQuake runs it for r_mirroralpha != 1;
// values above 1 mean nothing, so only < 1 counts. No pass under WebXR.
export function R_MirrorGate( alpha, xrActive ) {

	return xrActive !== true && alpha < 1;

}

//============================================================================
// Reflection maths. A plane is normal . p = dist, normal unit length.
//============================================================================

export function R_ReflectPoint( out, p, normal, dist ) {

	const d = normal[ 0 ] * p[ 0 ] + normal[ 1 ] * p[ 1 ] + normal[ 2 ] * p[ 2 ] - dist;
	out[ 0 ] = p[ 0 ] - 2 * d * normal[ 0 ];
	out[ 1 ] = p[ 1 ] - 2 * d * normal[ 1 ];
	out[ 2 ] = p[ 2 ] - 2 * d * normal[ 2 ];
	return out;

}

export function R_ReflectVector( out, v, normal ) {

	const d = normal[ 0 ] * v[ 0 ] + normal[ 1 ] * v[ 1 ] + normal[ 2 ] * v[ 2 ];
	out[ 0 ] = v[ 0 ] - 2 * d * normal[ 0 ];
	out[ 1 ] = v[ 1 ] - 2 * d * normal[ 1 ];
	out[ 2 ] = v[ 2 ] - 2 * d * normal[ 2 ];
	return out;

}

// World matrix of the virtual camera: the camera reflected through the plane.
// A true mirror matrix has determinant -1, so the right vector is rebuilt as
// forward x up to keep a proper rotation (the image comes out flipped, which
// the projective texture lookup in the mirror shader undoes).
// cam is a column-major camera world matrix: x = right, y = up, z = -forward.
export function R_MirrorCameraWorld( out, cam, normal, dist ) {

	const pos = R_ReflectPoint( [ 0, 0, 0 ], [ cam[ 12 ], cam[ 13 ], cam[ 14 ] ], normal, dist );
	const up = R_ReflectVector( [ 0, 0, 0 ], [ cam[ 4 ], cam[ 5 ], cam[ 6 ] ], normal );
	const fwd = R_ReflectVector( [ 0, 0, 0 ], [ - cam[ 8 ], - cam[ 9 ], - cam[ 10 ] ], normal );

	// right = forward x up
	const rx = fwd[ 1 ] * up[ 2 ] - fwd[ 2 ] * up[ 1 ];
	const ry = fwd[ 2 ] * up[ 0 ] - fwd[ 0 ] * up[ 2 ];
	const rz = fwd[ 0 ] * up[ 1 ] - fwd[ 1 ] * up[ 0 ];

	out[ 0 ] = rx; out[ 1 ] = ry; out[ 2 ] = rz; out[ 3 ] = 0;
	out[ 4 ] = up[ 0 ]; out[ 5 ] = up[ 1 ]; out[ 6 ] = up[ 2 ]; out[ 7 ] = 0;
	out[ 8 ] = - fwd[ 0 ]; out[ 9 ] = - fwd[ 1 ]; out[ 10 ] = - fwd[ 2 ]; out[ 11 ] = 0;
	out[ 12 ] = pos[ 0 ]; out[ 13 ] = pos[ 1 ]; out[ 14 ] = pos[ 2 ]; out[ 15 ] = 1;
	return out;

}

// Rigid-body inverse of a column-major matrix with orthonormal axes.
export function R_RigidInverse( out, m ) {

	out[ 0 ] = m[ 0 ]; out[ 1 ] = m[ 4 ]; out[ 2 ] = m[ 8 ]; out[ 3 ] = 0;
	out[ 4 ] = m[ 1 ]; out[ 5 ] = m[ 5 ]; out[ 6 ] = m[ 9 ]; out[ 7 ] = 0;
	out[ 8 ] = m[ 2 ]; out[ 9 ] = m[ 6 ]; out[ 10 ] = m[ 10 ]; out[ 11 ] = 0;
	out[ 12 ] = - ( m[ 0 ] * m[ 12 ] + m[ 1 ] * m[ 13 ] + m[ 2 ] * m[ 14 ] );
	out[ 13 ] = - ( m[ 4 ] * m[ 12 ] + m[ 5 ] * m[ 13 ] + m[ 6 ] * m[ 14 ] );
	out[ 14 ] = - ( m[ 8 ] * m[ 12 ] + m[ 9 ] * m[ 13 ] + m[ 10 ] * m[ 14 ] );
	out[ 15 ] = 1;
	return out;

}

// Express the world plane (normal . p = dist, kept side positive) in camera
// space as [ a, b, c, d ] with a*x + b*y + c*z + d >= 0 on the kept side.
// view is the column-major world->camera matrix.
export function R_PlaneToCameraSpace( out, normal, dist, view ) {

	const nx = view[ 0 ] * normal[ 0 ] + view[ 4 ] * normal[ 1 ] + view[ 8 ] * normal[ 2 ];
	const ny = view[ 1 ] * normal[ 0 ] + view[ 5 ] * normal[ 1 ] + view[ 9 ] * normal[ 2 ];
	const nz = view[ 2 ] * normal[ 0 ] + view[ 6 ] * normal[ 1 ] + view[ 10 ] * normal[ 2 ];

	// a point on the plane, into camera space
	const px = normal[ 0 ] * dist, py = normal[ 1 ] * dist, pz = normal[ 2 ] * dist;
	const cx = view[ 0 ] * px + view[ 4 ] * py + view[ 8 ] * pz + view[ 12 ];
	const cy = view[ 1 ] * px + view[ 5 ] * py + view[ 9 ] * pz + view[ 13 ];
	const cz = view[ 2 ] * px + view[ 6 ] * py + view[ 10 ] * pz + view[ 14 ];

	out[ 0 ] = nx; out[ 1 ] = ny; out[ 2 ] = nz;
	out[ 3 ] = - ( nx * cx + ny * cy + nz * cz );
	return out;

}

// Lengyel's oblique near-plane clipping: replaces the near plane of a
// perspective projection (column-major, in place) with clipPlane (camera
// space, kept side positive, camera on the clipped side). Same as
// THREE.Reflector.
export function R_ObliqueProjection( proj, clipPlane, bias = 0 ) {

	const qx = ( Math.sign( clipPlane[ 0 ] ) + proj[ 8 ] ) / proj[ 0 ];
	const qy = ( Math.sign( clipPlane[ 1 ] ) + proj[ 9 ] ) / proj[ 5 ];
	const qz = - 1.0;
	const qw = ( 1.0 + proj[ 10 ] ) / proj[ 14 ];

	const k = 2.0 / ( clipPlane[ 0 ] * qx + clipPlane[ 1 ] * qy + clipPlane[ 2 ] * qz + clipPlane[ 3 ] * qw );

	proj[ 2 ] = clipPlane[ 0 ] * k;
	proj[ 6 ] = clipPlane[ 1 ] * k;
	proj[ 10 ] = clipPlane[ 2 ] * k + 1.0 - bias;
	proj[ 14 ] = clipPlane[ 3 ] * k;
	return proj;

}

//============================================================================
// Render pass
//============================================================================

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
void main() {
	vec3 refl = texture2D( reflection, vReflUv.xy / vReflUv.w ).rgb;
	vec3 tex = texture2D( map, vUv ).rgb;
	gl_FragColor = vec4( mix( refl, tex, alpha ), 1.0 );
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
}
`;

let _target = null;
let _material = null;
let _group = null;
let _virtualCamera = null;
let _restore = null; // undo list for the frame in progress

function _ensureTarget( w, h ) {

	if ( _target !== null && ( _target.width !== w || _target.height !== h ) ) {

		_target.dispose();
		_target = null;

	}

	if ( _target === null ) {

		_target = new THREE.WebGLRenderTarget( w, h, {
			minFilter: THREE.LinearFilter,
			magFilter: THREE.LinearFilter,
			generateMipmaps: false,
			depthBuffer: true
		} );

	}

	return _target;

}

// Render the reflected scene and put the mirror overlay into the scene.
// items: [ { geom, texture, batch, instanceId } ] for the visible mirror
// surfaces on `plane` ({ normal, dist }). hide: objects to hide in the
// reflection (the view weapon). Call R_MirrorCleanup after the main render.
// Returns false when nothing was drawn.
export function R_MirrorPass( renderer, scene, camera, plane, items, alpha, hide ) {

	if ( items.length === 0 )
		return false;

	camera.updateMatrixWorld();
	const cam = camera.matrixWorld.elements;

	// keep the side of the plane the viewer is on
	const side = plane.normal[ 0 ] * cam[ 12 ] + plane.normal[ 1 ] * cam[ 13 ] + plane.normal[ 2 ] * cam[ 14 ] - plane.dist;
	if ( Math.abs( side ) < 0.5 )
		return false; // eye on the plane, nothing sensible to reflect

	const sgn = side > 0 ? 1 : - 1;
	const keepNormal = [ plane.normal[ 0 ] * sgn, plane.normal[ 1 ] * sgn, plane.normal[ 2 ] * sgn ];
	const keepDist = plane.dist * sgn;

	// virtual camera
	if ( _virtualCamera === null )
		_virtualCamera = new THREE.PerspectiveCamera();

	const vc = _virtualCamera;
	vc.fov = camera.fov;
	vc.aspect = camera.aspect;
	vc.near = camera.near;
	vc.far = camera.far;
	vc.updateProjectionMatrix();

	vc.matrixAutoUpdate = false;
	vc.matrixWorldAutoUpdate = false;
	const world = vc.matrixWorld.elements;
	R_MirrorCameraWorld( world, cam, keepNormal, keepDist );
	R_RigidInverse( vc.matrixWorldInverse.elements, world );

	// projective texture matrix: bias * projection * view, before the
	// oblique modification
	const textureMatrix = new THREE.Matrix4();
	textureMatrix.set(
		0.5, 0.0, 0.0, 0.5,
		0.0, 0.5, 0.0, 0.5,
		0.0, 0.0, 0.5, 0.5,
		0.0, 0.0, 0.0, 1.0
	);
	textureMatrix.multiply( vc.projectionMatrix );
	textureMatrix.multiply( vc.matrixWorldInverse );

	const clipPlane = R_PlaneToCameraSpace( [ 0, 0, 0, 0 ], keepNormal, keepDist, vc.matrixWorldInverse.elements );
	R_ObliqueProjection( vc.projectionMatrix.elements, clipPlane );
	vc.projectionMatrixInverse.copy( vc.projectionMatrix ).invert();

	// render target at the size of the main viewport
	const vp = renderer.getViewport( new THREE.Vector4() );
	const ratio = renderer.getPixelRatio();
	const w = Math.max( 1, Math.min( 4096, Math.round( vp.width * ratio ) ) );
	const h = Math.max( 1, Math.min( 4096, Math.round( vp.height * ratio ) ) );
	const target = _ensureTarget( w, h );

	// hide the real mirror surfaces and the objects that don't belong in a reflection
	_restore = [];
	for ( let i = 0; i < items.length; i ++ ) {

		const it = items[ i ];
		_restore.push( { batch: it.batch, id: it.instanceId, visible: it.batch.getVisibleAt( it.instanceId ) } );
		it.batch.setVisibleAt( it.instanceId, false );

	}

	const hidden = [];
	for ( let i = 0; i < hide.length; i ++ ) {

		if ( hide[ i ] != null && hide[ i ].visible === true ) {

			hide[ i ].visible = false;
			hidden.push( hide[ i ] );

		}

	}

	const prevTarget = renderer.getRenderTarget();
	renderer.setRenderTarget( target );
	renderer.clear( true, true, true );
	renderer.render( scene, vc );
	renderer.setRenderTarget( prevTarget );

	for ( let i = 0; i < hidden.length; i ++ )
		hidden[ i ].visible = true;

	// overlay: the mirror surface drawn with the reflection mixed in
	if ( _material === null ) {

		_material = new THREE.ShaderMaterial( {
			uniforms: {
				map: { value: null },
				reflection: { value: null },
				alpha: { value: 1 },
				textureMatrix: { value: new THREE.Matrix4() }
			},
			vertexShader: MIRROR_VERTEX,
			fragmentShader: MIRROR_FRAGMENT
		} );

	}

	// there is only ever one mirror texture
	_material.uniforms.map.value = items[ 0 ].texture;
	_material.uniforms.reflection.value = target.texture;
	_material.uniforms.alpha.value = alpha;
	_material.uniforms.textureMatrix.value.copy( textureMatrix );

	if ( _group === null ) {

		_group = new THREE.Group();
		_group.name = 'quake_mirror';

	}

	for ( let i = 0; i < items.length; i ++ ) {

		const mesh = new THREE.Mesh( items[ i ].geom, _material );
		mesh.frustumCulled = false;
		_group.add( mesh );

	}

	scene.add( _group );
	return true;

}

// Undo R_MirrorPass after the main render. Safe to call every frame.
export function R_MirrorCleanup() {

	if ( _restore === null )
		return;

	for ( let i = 0; i < _restore.length; i ++ ) {

		const r = _restore[ i ];
		r.batch.setVisibleAt( r.id, r.visible );

	}

	_restore = null;

	if ( _group !== null ) {

		if ( _group.parent ) _group.parent.remove( _group );
		_group.clear(); // geometries belong to the world mirror list

	}

}
