// Web-only (no C source): compile the level's shader programs behind the
// loading plaque.
//
// Three.js builds a program the first time a material is drawn with a given
// set of parameters, and one of those parameters is the number of lights in
// the scene (WebGLPrograms.getProgramCacheKey adds numPointLights for every
// material, lit or not). gl_flashblend dlights are PointLights, so every
// light count the scene reaches (R_PadDlights in gl_rmain.js pads to 4, 8,
// 16, 32 or 64) compiles a fresh set of programs for the world, water, sky,
// sprites and particles. Measured in Chrome: 20-250 ms for the frame that
// first reaches each count. R_WarmupStart asks Three.js to compile those
// programs for every bucket during the load, with no frame drawn:
//
//   renderer.compileAsync( scene, view, lights )
//
// compiles the real scene's materials (the world's BatchedMeshes exist once
// R_NewMap has run) against `lights`, a scene holding only the bucket's
// PointLights and the new map's fog. The water, sky and particle materials
// are created lazily by the first frame that draws them, so throwaway
// meshes with the same material and geometry attributes stand in for them
// (R_WarmupMeshes in gl_rsurf.js, R_GetParticleMaterial in r_part.js,
// R_SpriteMaterial in gl_rmain.js); none of them is added to the real
// scene. Three.js keeps every program a material has compiled until the
// material is disposed, so the warm-up needs no bookkeeping.
//
// Not warmed: alias model materials (the variant depends on the skin, the
// lighting, r_lerpmodels and the entity alpha), the mirror pass and the
// render-target passes.
//
// The loading plaque is held (R_WarmupWhenReady) until the compiles are
// ready, for at most R_WARMUP_MAX_WAIT_MS, so a slow device never waits long.
// Without a renderer (the Deno server, headless host, tests) nothing is
// started and R_WarmupWhenReady calls back at once.

import * as THREE from 'three';
import { renderer } from './vid.js';
import { scene, camera, R_DlightBucket, R_SpriteMaterial, gl_flashblend } from './gl_rmain.js';
import { MAX_DLIGHTS } from './client.js';
import { R_RemoveDlights } from './gl_rlight.js';
import { Fog_GetDensity } from './gl_fog.js';
import { isXRActive } from './webxr.js';
import { R_WarmupMeshes } from './gl_rsurf.js';
import { R_GetParticleMaterial } from './r_part.js';
import { Con_DPrintf } from './common.js';

export const R_WARMUP_MAX_WAIT_MS = 1500;

// 0, then 4, 8, 16, 32 and 64 with MAX_DLIGHTS 64: the light counts
// R_PadDlights can reach. Pure. With gl_flashblend 0 no dlight light is ever
// added to the scene, so only 0 is reachable.
export function R_WarmupBuckets( flashblend, max = MAX_DLIGHTS ) {

	const buckets = [ 0 ];
	if ( flashblend === 0 ) return buckets;

	for ( let n = 1; n <= max; n ++ ) {

		const bucket = R_DlightBucket( n );
		if ( bucket !== buckets[ buckets.length - 1 ] ) buckets.push( bucket );

	}

	return buckets;

}

// How many filler lights the warm-up scene needs so that the lights the
// compile sees (these plus the ones already in the real scene) number
// `bucket`; -1 when the real scene already has more than that.
export function R_WarmupFillerCount( bucket, lightsInScene ) {

	return bucket >= lightsInScene ? bucket - lightsInScene : - 1;

}

let _lightScene = null; // holds only the bucket's lights and the fog
const _lights = [];
let _sprite = null; // { texture, geometry }
let _points = null;
let _group = null; // the stand-in meshes, never in the scene
let _fog = null;
let _camera = null;
let _test = null;
let _lightsInScene = 0;

let _generation = 0;
let _pending = false;
let _waiting = null; // callback to run when the warm-up ends
let _timer = null;

// the real camera once R_SetupGL has made it, else a stand-in
export function R_WarmupCamera() {

	if ( camera !== null ) return camera;
	if ( _camera === null ) _camera = new THREE.PerspectiveCamera();
	return _camera;

}

// the lights Three's compile() will gather: traverseVisible, by hand
function R_CountLight( object ) {

	if ( object.visible === false ) return;
	if ( object.isLight === true ) _lightsInScene ++;
	for ( let i = 0; i < object.children.length; i ++ ) R_CountLight( object.children[ i ] );

}

function R_CountSceneLights( root ) {

	// The previous map's dlights and R_PadDlights fillers stay in the scene
	// until the next frame, and would be counted in every bucket. Take them
	// out: R_RenderDlights and R_PadDlights add back what a frame needs.
	R_RemoveDlights();
	for ( let i = root.children.length - 1; i >= 0; i -- ) {

		if ( root.children[ i ].isPointLight === true ) root.remove( root.children[ i ] );

	}

	_lightsInScene = 0;
	R_CountLight( root );
	return _lightsInScene;

}

function R_WarmupLights( fog, fillers ) {

	if ( _lightScene === null ) _lightScene = new THREE.Scene();
	_lightScene.fog = fog;

	for ( let i = 0; i < fillers; i ++ ) {

		let light = _lights[ i ];
		if ( light === undefined ) {

			light = new THREE.PointLight( 0xffffff, 0, 1, 0 );
			_lights[ i ] = light;

		}

		if ( light.parent !== _lightScene ) _lightScene.add( light );

	}

	for ( let i = fillers; i < _lights.length; i ++ ) {

		if ( _lights[ i ].parent !== null ) _lights[ i ].parent.remove( _lights[ i ] );

	}

}

// The sprite, particle, water and sky stand-ins in one Group. Sprite
// programs don't depend on the texture, so one 1x1 texture serves both the
// plain and the decal material.
function R_WarmupExtras( worldmodel ) {

	if ( _group === null ) _group = new THREE.Group();

	for ( let i = _group.children.length - 1; i >= 0; i -- ) _group.remove( _group.children[ i ] );

	if ( _sprite === null ) {

		const geometry = new THREE.BufferGeometry();
		geometry.setAttribute( 'position', new THREE.BufferAttribute( new Float32Array( 12 ), 3 ) );
		geometry.setAttribute( 'uv', new THREE.BufferAttribute( new Float32Array( 8 ), 2 ) );
		geometry.setIndex( [ 0, 1, 2, 0, 2, 3 ] );
		_sprite = { texture: new THREE.DataTexture( new Uint8Array( 4 ), 1, 1, THREE.RGBAFormat ), geometry: geometry };

	}

	// R_SpriteMaterial caches by texture and R_NewMap clears the caches
	// (disposing the materials), so these are new for each map.
	for ( let i = 0; i < 2; i ++ ) {

		const mesh = new THREE.Mesh( _sprite.geometry, R_SpriteMaterial( _sprite.texture, i === 1 ) );
		mesh.frustumCulled = false;
		_group.add( mesh );

	}

	const particles = R_GetParticleMaterial();
	if ( particles !== null && particles.map !== null ) {

		if ( _points === null ) {

			const geometry = new THREE.BufferGeometry();
			geometry.setAttribute( 'position', new THREE.BufferAttribute( new Float32Array( 3 ), 3 ) );
			geometry.setAttribute( 'color', new THREE.BufferAttribute( new Float32Array( 3 ), 3 ) );
			_points = new THREE.Points( geometry, particles );

		} else {

			_points.material = particles;

		}

		_points.frustumCulled = false;
		_group.add( _points );

	}

	const level = R_WarmupMeshes( worldmodel );
	for ( let i = 0; i < level.length; i ++ ) _group.add( level[ i ] );

	return _group;

}

function R_WarmupFinish( generation ) {

	if ( generation !== _generation ) return;

	_pending = false;
	if ( _timer !== null ) {

		clearTimeout( _timer );
		_timer = null;

	}

	const callback = _waiting;
	_waiting = null;
	if ( callback !== null ) callback();

}

function R_WarmupCapped( generation ) {

	_timer = null;
	Con_DPrintf( 'R_WarmupStart: gave up waiting after %d ms\n', R_WARMUP_MAX_WAIT_MS );
	R_WarmupFinish( generation );

}

/*
===============
R_WarmupStart

Called by CL_ParseServerInfo after R_NewMap. Starts compiling the programs
the level's first frames will need; see the header.
===============
*/
export function R_WarmupStart( cl ) {

	// a new map drops the previous one's pending plaque callback: the new
	// signon ends the new plaque
	_generation ++;
	_pending = false;
	_waiting = null;
	if ( _timer !== null ) {

		clearTimeout( _timer );
		_timer = null;

	}

	const r = _test !== null ? _test.renderer : renderer;
	const s = _test !== null ? _test.scene : scene;
	if ( r === null || typeof r.compileAsync !== 'function' ||
		s === null || cl === null || cl.worldmodel === null ||
		isXRActive() === true ) return;

	// R_SetupGL creates the real camera on the first frame, so on a page's
	// first map there is none yet. compile() only reads its layers (and
	// passes it to the render state), so a stand-in does as well.
	const view = R_WarmupCamera();
	const generation = _generation;
	const t0 = performance.now();
	const programs0 = r.info !== undefined && r.info.programs !== null ? r.info.programs.length : 0;
	let fog = null;
	let group = null;
	let fillers = null;

	try {

		const buckets = R_WarmupBuckets( gl_flashblend.value );
		const inScene = R_CountSceneLights( s );

		// Fog_SetupFrame sets scene.fog on the first frame, so it is stale
		// here: use what it will set (a program's key holds only the fog
		// type, so the density and colour don't matter).
		if ( Fog_GetDensity() > 0 ) {

			if ( _fog === null ) _fog = new THREE.FogExp2( 0x000000, 0 );
			fog = _fog;

		}

		group = _test !== null ? new THREE.Group() : R_WarmupExtras( cl.worldmodel );
		fillers = [];
		for ( let i = 0; i < buckets.length; i ++ ) {

			const n = R_WarmupFillerCount( buckets[ i ], inScene );
			if ( n >= 0 ) fillers.push( { bucket: buckets[ i ], fillers: n } );

		}

	} catch ( e ) {

		Con_DPrintf( 'R_WarmupStart: %s\n', e.message );
		return;

	}

	if ( fillers.length === 0 ) return;

	_pending = true;
	_timer = setTimeout( R_WarmupCapped, R_WARMUP_MAX_WAIT_MS, generation );

	// One bucket after another: compiling the same materials for the next
	// bucket replaces their currentProgram, and compileAsync of the earlier
	// bucket polls that, so overlapping buckets could report ready early.
	R_WarmupRun( r, s, view, group, fog, fillers, generation ).then( () => {

		if ( generation !== _generation ) return;
		Con_DPrintf( 'R_WarmupStart: %d programs in %d ms\n',
			( r.info !== undefined && r.info.programs !== null ? r.info.programs.length : 0 ) - programs0,
			Math.round( performance.now() - t0 ) );
		R_WarmupFinish( generation );

	}, ( e ) => {

		Con_DPrintf( 'R_WarmupStart: %s\n', e !== null && e !== undefined ? e.message : 'failed' );
		R_WarmupFinish( generation );

	} );

}

async function R_WarmupRun( r, s, view, group, fog, plan, generation ) {

	for ( let i = 0; i < plan.length; i ++ ) {

		if ( generation !== _generation ) return;

		// compile( scene ) also counts the lights already in the scene; the
		// stand-in group has none, so it needs the whole bucket
		R_WarmupLights( fog, plan[ i ].fillers );
		const a = r.compileAsync( s, view, _lightScene );
		R_WarmupLights( fog, plan[ i ].bucket );
		const b = r.compileAsync( group, view, _lightScene );
		await Promise.all( [ a, b ] );

	}

}

// Tests only: stand in for the renderer and scene (vid.js and gl_rmain.js
// own the real ones, which need a browser); null restores them.
export function R_WarmupSetTest( hooks ) {

	_test = hooks;

}

/*
===============
R_WarmupWhenReady

Calls `callback` once the warm-up has finished or timed out: at once when
none is running. CL_SignonReply uses it to end the loading plaque.
===============
*/
export function R_WarmupWhenReady( callback ) {

	if ( _pending === false ) {

		callback();
		return;

	}

	_waiting = callback;

}

// Stops a warm-up in progress, for a disconnect before its compiles are ready,
// and runs the held plaque callback (once).
export function R_WarmupCancel() {

	_generation ++;
	_pending = false;
	if ( _timer !== null ) {

		clearTimeout( _timer );
		_timer = null;

	}

	// the plaque callback still has to run, or the screen stays disabled
	// until the 60 s "load failed" reset
	const callback = _waiting;
	_waiting = null;
	if ( callback !== null ) callback();

}

export function R_WarmupPending() {

	return _pending;

}
