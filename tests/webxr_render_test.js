// WebXR render path. XR-1: R_CullBox culls with the headset's eye frusta,
// not the body's frustum from r_refdef.viewangles. XR-2: R_PolyBlend draws
// v_blend in the headset.

// Bootstrap the renderer's existing circular module graph in its safe order.
await import( '../src/gl_rsurf.js' );

const gl_rmain = await import( '../src/gl_rmain.js' );
const webxr = await import( '../src/webxr.js' );
const render = await import( '../src/render.js' );
const { AngleVectors } = await import( '../src/mathlib.js' );
const glquake = await import( '../src/glquake.js' );

const S = webxr.XR_SCALE;

function assert( cond, message ) {

	if ( cond !== true ) throw new Error( message );

}

function newPlanes() {

	return [ 0, 1, 2, 3 ].map( () => new gl_rmain.mplane_t() );

}

// Column-major off-axis projection, as THREE.Matrix4.makePerspective. The
// extents are tangents of the half-angles (left and bottom negative).
function projection( left, right, bottom, top ) {

	const n = 0.1, f = 100;
	const l = left * n, r = right * n, b = bottom * n, t = top * n;
	const e = new Array( 16 ).fill( 0 );
	e[ 0 ] = 2 * n / ( r - l );
	e[ 8 ] = ( r + l ) / ( r - l );
	e[ 5 ] = 2 * n / ( t - b );
	e[ 9 ] = ( t + b ) / ( t - b );
	e[ 10 ] = - ( f + n ) / ( f - n );
	e[ 14 ] = - 2 * f * n / ( f - n );
	e[ 11 ] = - 1;
	return e;

}

// Column-major eye-to-world matrix in meters for a view with Quake angles at
// a Quake origin, built as R_SetupGL builds the rig: columns right, up,
// -forward. side moves the eye along its right vector, in Quake units.
function eyeWorld( angles, origin, side = 0 ) {

	const f = new Float32Array( 3 ), r = new Float32Array( 3 ), u = new Float32Array( 3 );
	AngleVectors( angles, f, r, u );
	return [
		r[ 0 ], r[ 1 ], r[ 2 ], 0,
		u[ 0 ], u[ 1 ], u[ 2 ], 0,
		- f[ 0 ], - f[ 1 ], - f[ 2 ], 0,
		( origin[ 0 ] + r[ 0 ] * side ) / S, ( origin[ 1 ] + r[ 1 ] * side ) / S, ( origin[ 2 ] + r[ 2 ] * side ) / S, 1
	];

}

function finalize( planes ) {

	for ( const p of planes ) {

		p.type = gl_rmain.PLANE_ANYZ;
		let bits = 0;
		for ( let j = 0; j < 3; j ++ ) if ( p.normal[ j ] < 0 ) bits |= 1 << j;
		p.signbits = bits;

	}

	return planes;

}

// A 16-unit box centred at origin + dir * dist
function box( origin, dir, dist ) {

	const len = Math.hypot( dir[ 0 ], dir[ 1 ], dir[ 2 ] );
	const mins = new Float32Array( 3 ), maxs = new Float32Array( 3 );
	for ( let j = 0; j < 3; j ++ ) {

		const c = origin[ j ] + dir[ j ] / len * dist;
		mins[ j ] = c - 8;
		maxs[ j ] = c + 8;

	}

	return [ mins, maxs ];

}

// Runs fn with R_SetFrustum's inputs set to the body's view, then restores them
function withBodyView( angles, origin, fov_x, fov_y, fn ) {

	const saved = {
		fov_x: render.r_refdef.fov_x, fov_y: render.r_refdef.fov_y,
		origin: Float32Array.from( render.r_origin ), vpn: Float32Array.from( render.vpn ),
		vright: Float32Array.from( render.vright ), vup: Float32Array.from( render.vup )
	};

	try {

		render.r_refdef.fov_x = fov_x;
		render.r_refdef.fov_y = fov_y;
		render.r_origin.set( origin );
		AngleVectors( angles, render.vpn, render.vright, render.vup );
		gl_rmain.R_SetFrustum();
		fn();

	} finally {

		render.r_refdef.fov_x = saved.fov_x;
		render.r_refdef.fov_y = saved.fov_y;
		render.r_origin.set( saved.origin );
		render.vpn.set( saved.vpn );
		render.vright.set( saved.vright );
		render.vup.set( saved.vup );

	}

}

Deno.test( 'XR-1: a symmetric eye frustum matches R_SetFrustum for the same view', () => {

	const angles = [ - 20, 35, 0 ];
	const origin = [ 100, - 250, 40 ];

	// 90° (R_SetFrustum's unnormalized branch) and 106.26° x 90°
	for ( const [ fov_x, fov_y ] of [ [ 90, 90 ], [ 2 * Math.atan( 4 / 3 ) * 180 / Math.PI, 90 ] ] ) {

		const tx = Math.tan( fov_x / 2 * Math.PI / 180 ), ty = Math.tan( fov_y / 2 * Math.PI / 180 );
		const planes = newPlanes();
		webxr.XR_FrustumFromView( projection( - tx, tx, - ty, ty ), eyeWorld( angles, origin ), planes );

		withBodyView( angles, origin, fov_x, fov_y, () => {

			for ( const q of gl_rmain.frustum ) {

				const len = Math.hypot( q.normal[ 0 ], q.normal[ 1 ], q.normal[ 2 ] );
				const match = planes.find( ( p ) =>
					p.normal[ 0 ] * q.normal[ 0 ] + p.normal[ 1 ] * q.normal[ 1 ] + p.normal[ 2 ] * q.normal[ 2 ] > len * 0.99999 );
				assert( match !== undefined, `fov ${fov_x}: no eye plane matches body plane ${q.normal}` );
				assert( Math.abs( match.dist - q.dist / len ) < 1e-3, `fov ${fov_x}: dist ${match.dist} vs ${q.dist / len}` );

			}

		} );

	}

} );

Deno.test( 'XR-1: a head turned from the body keeps what it sees and culls what is behind it', () => {

	const origin = [ 0, 0, 0 ];
	const views = [ finalize( newPlanes() ) ];
	// Body faces +x (yaw 0); the head looks left, +y (yaw 90)
	webxr.XR_FrustumFromView( projection( - 1, 1, - 1, 1 ), eyeWorld( [ 0, 90, 0 ], origin ), views[ 0 ] );
	finalize( views[ 0 ] );

	const [ seenMins, seenMaxs ] = box( origin, [ 0, 1, 0 ], 300 ); // where the head looks
	const [ behindMins, behindMaxs ] = box( origin, [ 0, - 1, 0 ], 300 );
	const [ aheadMins, aheadMaxs ] = box( origin, [ 1, 0, 0 ], 300 ); // where the body faces

	withBodyView( [ 0, 0, 0 ], origin, 90, 90, () => {

		// The old behaviour: the body's frustum culls what the head is looking at
		assert( gl_rmain.R_CullBox( seenMins, seenMaxs ) === true, 'body frustum culls the box the head sees' );

	} );

	assert( gl_rmain.R_CullBoxViews( seenMins, seenMaxs, views, 1 ) === false, 'eye frustum keeps the box the head sees' );
	assert( gl_rmain.R_CullBoxViews( behindMins, behindMaxs, views, 1 ) === true, 'eye frustum culls the box behind the head' );
	assert( gl_rmain.R_CullBoxViews( aheadMins, aheadMaxs, views, 1 ) === true, 'eye frustum culls the box the body faces' );

} );

Deno.test( 'XR-1: asymmetric eyes keep a box only one eye sees', () => {

	const origin = [ 0, 0, 0 ];
	// Each eye sees further to its own side: tan 1.2 outwards, 0.8 inwards,
	// with the eyes 1 unit either side of the head
	const views = [ newPlanes(), newPlanes() ];
	webxr.XR_FrustumFromView( projection( - 1.2, 0.8, - 1, 1 ), eyeWorld( [ 0, 0, 0 ], origin, - 1 ), views[ 0 ] );
	webxr.XR_FrustumFromView( projection( - 0.8, 1.2, - 1, 1 ), eyeWorld( [ 0, 0, 0 ], origin, 1 ), views[ 1 ] );
	finalize( views[ 0 ] );
	finalize( views[ 1 ] );

	// Forward is +x and left is +y. At tan 1.0 to the left only the left eye sees it.
	const [ leftMins, leftMaxs ] = box( origin, [ 1, 1.0, 0 ], 400 );
	assert( gl_rmain.R_CullBoxViews( leftMins, leftMaxs, [ views[ 1 ] ], 1 ) === true, 'right eye alone culls it' );
	assert( gl_rmain.R_CullBoxViews( leftMins, leftMaxs, views, 2 ) === false, 'both eyes keep it' );

	const [ rightMins, rightMaxs ] = box( origin, [ 1, - 1.0, 0 ], 400 );
	assert( gl_rmain.R_CullBoxViews( rightMins, rightMaxs, [ views[ 0 ] ], 1 ) === true, 'left eye alone culls it' );
	assert( gl_rmain.R_CullBoxViews( rightMins, rightMaxs, views, 2 ) === false, 'both eyes keep the right one' );

	// Beyond either eye's outer edge (tan 1.5)
	const [ farMins, farMaxs ] = box( origin, [ 1, 1.5, 0 ], 400 );
	assert( gl_rmain.R_CullBoxViews( farMins, farMaxs, views, 2 ) === true, 'outside both eyes is culled' );

	// Up and down use rows 1 and 3
	const [ upMins, upMaxs ] = box( origin, [ 1, 0, 1.5 ], 400 );
	assert( gl_rmain.R_CullBoxViews( upMins, upMaxs, views, 2 ) === true, 'above both eyes is culled' );
	const [ fwdMins, fwdMaxs ] = box( origin, [ 1, 0, 0.5 ], 400 );
	assert( gl_rmain.R_CullBoxViews( fwdMins, fwdMaxs, views, 2 ) === false, 'in front is kept' );

	// With no views (no pose yet) nothing is culled
	assert( gl_rmain.R_CullBoxViews( farMins, farMaxs, views, 0 ) === false, 'no views culls nothing' );

} );

// Fake WebXR renderer: XR_Init with no scene needs only these
function makeFakeRenderer( cameras ) {

	const listeners = {};
	return {
		xr: {
			enabled: false,
			setReferenceSpaceType() {},
			getController() { return { userData: {}, addEventListener() {} }; },
			addEventListener( type, l ) { ( listeners[ type ] ||= [] ).push( l ); },
			getCamera() { return { cameras }; }
		},
		fire( type ) { for ( const l of listeners[ type ] || [] ) l( { type } ); }
	};

}

class FakeGroup {

	constructor() {

		this.parent = null;
		this.position = { set() {} };
		// Identity until the test poses the rig
		this.matrixWorld = { elements: [ 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1 ] };

	}
	add( o ) { o.parent = this; }

}

Deno.test( 'XR-1: R_SetupXRFrustum culls with the posed eyes in XR and with frustum[] outside it', () => {

	// Body at (64, 32, 0) faces +x. The rig's xrOffset carries the body's
	// rotation; the headset turns 90° left in the rig's space.
	const origin = [ 64, 32, 0 ];
	// Head pose in the reference space (Three's axes: -z forward, y up):
	// 90° about +y, so -z (forward) turns to -x (left)
	const headLocal = [ 0, 0, - 1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1 ];
	const rig = eyeWorld( [ 0, 0, 0 ], origin ); // rig rotation and position, as R_SetupGL sets them
	const cameras = [
		{ matrix: { elements: headLocal }, projectionMatrix: { elements: projection( - 1, 1, - 1, 1 ) } }
	];
	const fake = makeFakeRenderer( cameras );

	// Find the fake xrOffset: XR_Init creates the rig, then the offset
	const groups = [];
	class Group extends FakeGroup {

		constructor() { super(); groups.push( this ); }

	}

	webxr.XR_SetTestOverrides( { renderer: fake, THREE: { Group } } );

	const [ seenMins, seenMaxs ] = box( origin, [ 0, 1, 0 ], 300 ); // +y: where the head looks
	const [ aheadMins, aheadMaxs ] = box( origin, [ 1, 0, 0 ], 300 ); // +x: where the body faces

	try {

		webxr.XR_Init( null );
		const xrOffset = groups[ 1 ];
		xrOffset.matrixWorld.elements = rig;

		withBodyView( [ 0, 0, 0 ], origin, 90, 90, () => {

			// Not in a session: frustum[] (the body) decides
			gl_rmain.R_SetupXRFrustum();
			assert( gl_rmain.R_CullBox( seenMins, seenMaxs ) === true, 'outside XR the body frustum culls +y' );
			assert( gl_rmain.R_CullBox( aheadMins, aheadMaxs ) === false, 'outside XR the body frustum keeps +x' );

			fake.fire( 'sessionstart' );
			gl_rmain.R_SetupXRFrustum();
			assert( gl_rmain.R_CullBox( seenMins, seenMaxs ) === false, 'in XR the head keeps +y' );
			assert( gl_rmain.R_CullBox( aheadMins, aheadMaxs ) === true, 'in XR the head culls +x' );

			// Before the first pose nothing is culled
			cameras.length = 0;
			gl_rmain.R_SetupXRFrustum();
			assert( gl_rmain.R_CullBox( aheadMins, aheadMaxs ) === false, 'no pose culls nothing' );

			fake.fire( 'sessionend' );
			gl_rmain.R_SetupXRFrustum();
			assert( gl_rmain.R_CullBox( seenMins, seenMaxs ) === true, 'after XR the body frustum is back' );

		} );

	} finally {

		if ( webxr.isXRActive() ) fake.fire( 'sessionend' );
		gl_rmain.R_SetupXRFrustum();
		webxr.XR_SetTestOverrides();

	}

} );

// Fake THREE for the HUD scene (browser_shim.js has no PlaneGeometry)
function makeHUDThree() {

	const meshes = [];
	class Group extends FakeGroup {

		constructor() { super(); this.children = []; this.scale = { setScalar() {} }; }
		add( o ) {

			if ( o.parent != null ) o.parent.remove( o );
			this.children.push( o );
			o.parent = this;

		}
		remove( o ) { this.children.splice( this.children.indexOf( o ), 1 ); o.parent = null; }

	}
	class Scene extends Group {}
	class Matrix4 {

		makeScale( x, y, z ) { this.scaled = [ x, y, z ]; return this; }
		setPosition( x, y, z ) { this.moved = [ x, y, z ]; return this; }

	}
	class Mesh {

		constructor( _geometry, material ) { this.material = material; this.visible = true; this.parent = null; meshes.push( this ); }

	}
	class MeshBasicMaterial {

		constructor( params ) {

			Object.assign( this, params );
			this.map = null;
			this.color = { setRGB( r, g, b, space ) { this.rgb = [ r, g, b, space ]; } };

		}

	}
	class PlaneGeometry {}
	return { THREE: { Group, Scene, Matrix4, Mesh, MeshBasicMaterial, PlaneGeometry, SRGBColorSpace: 'srgb' }, meshes };

}

Deno.test( 'XR-2: R_PolyBlend draws v_blend in XR, under the HUD, with its C gates', () => {

	const three = makeHUDThree();
	const fake = makeFakeRenderer( [] );
	const renders = [];
	fake.render = ( scene, camera ) => renders.push( { scene, camera, blendVisible: three.meshes[ 1 ].visible } );
	webxr.XR_SetTestOverrides( { renderer: fake, THREE: three.THREE } );

	const savedBlend = Float32Array.from( glquake.v_blend );
	const savedPolyblend = glquake.gl_polyblend.value;
	const camera = {};

	try {

		webxr.XR_Init( new three.THREE.Group() );

		// Outside a session nothing is drawn
		glquake.v_blend.set( [ 1, 0, 0, 0.5 ] );
		webxr.XR_PolyBlend( glquake.v_blend );
		webxr.XR_RenderHUD( camera );
		assert( renders.length === 0, 'no draw outside a session' );

		fake.fire( 'sessionstart' );
		const [ hud, blend ] = three.meshes;
		const hudScene = hud.parent;
		assert( hudScene.children[ 0 ] === blend && hudScene.children[ 1 ] === hud, 'blend quad drawn before the HUD quad' );
		assert( blend.material.depthTest === false && blend.material.transparent === true && blend.material.toneMapped === false, 'blend material as R_PolyBlend' );
		assert( blend.frustumCulled === false, 'blend quad never culled' );

		// No blend and no HUD upload yet: nothing to draw
		glquake.v_blend[ 3 ] = 0;
		gl_rmain.R_PolyBlend();
		webxr.XR_RenderHUD( camera );
		assert( renders.length === 0, 'no draw with v_blend[ 3 ] 0 and no HUD' );

		// gl_polyblend 0 draws no blend
		glquake.v_blend.set( [ 1, 0.5, 0.25, 0.5 ] );
		glquake.gl_polyblend.value = 0;
		gl_rmain.R_PolyBlend();
		webxr.XR_RenderHUD( camera );
		assert( renders.length === 0, 'no draw with gl_polyblend 0' );

		// A blend draws even before the HUD's first upload
		glquake.gl_polyblend.value = 1;
		gl_rmain.R_PolyBlend();
		assert( blend.visible === true, 'blend shown' );
		assert( blend.material.color.rgb.join() === '1,0.5,0.25,srgb', 'blend colour, sRGB' );
		assert( blend.material.opacity === 0.5, 'blend alpha' );
		webxr.XR_RenderHUD( camera );
		assert( renders.length === 1 && renders[ 0 ].scene === hudScene && renders[ 0 ].camera === camera, 'HUD scene drawn with the view camera' );
		assert( renders[ 0 ].blendVisible === true, 'blend visible while drawn' );
		assert( blend.visible === false, 'blend lasts one frame' );

		// The next frame without a blend draws nothing
		webxr.XR_RenderHUD( camera );
		assert( renders.length === 1, 'no draw once the blend is gone' );

		// A new session re-adds both quads, blend first, hidden
		fake.fire( 'sessionend' );
		assert( blend.parent === null && hud.parent === null, 'quads removed with the session' );
		fake.fire( 'sessionstart' );
		assert( hudScene.children[ 0 ] === blend && hudScene.children[ 1 ] === hud, 'blend still first' );
		assert( blend.visible === false, 'blend hidden at session start' );

	} finally {

		if ( webxr.isXRActive() ) fake.fire( 'sessionend' );
		glquake.v_blend.set( savedBlend );
		glquake.gl_polyblend.value = savedPolyblend;
		webxr.XR_SetTestOverrides();

	}

} );
