// XR-3: while an XR session is presenting, R_SetupFrame takes r_origin, the
// view leaf and the contents colour from the previous frame's head, as C
// takes them from the camera. Outside a session it is unchanged.

await import( '../src/gl_rsurf.js' );

const gl_rmain = await import( '../src/gl_rmain.js' );
const webxr = await import( '../src/webxr.js' );
const render = await import( '../src/render.js' );
const { cl } = await import( '../src/client.js' );

const S = webxr.XR_SCALE;

function assert( cond, message ) {

	if ( cond !== true ) throw new Error( message );

}

class FakeGroup {

	constructor() {

		this.parent = null;
		this.position = { set() {} };
		this.matrixWorld = { elements: [ 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1 ] };

	}
	add( o ) { o.parent = this; }

}

Deno.test( 'XR-3: R_SetupFrame uses the head for r_origin and the view leaf only while presenting', () => {

	const listeners = {};
	const cameras = [];
	const fake = {
		xr: {
			enabled: false,
			setReferenceSpaceType() {},
			getController() { return { userData: {}, addEventListener() {} }; },
			addEventListener( type, l ) { ( listeners[ type ] ||= [] ).push( l ); },
			getCamera() { return { cameras }; }
		}
	};
	const fire = ( type ) => { for ( const l of listeners[ type ] || [] ) l( { type } ); };

	const groups = [];
	class Group extends FakeGroup {

		constructor() { super(); groups.push( this ); }

	}

	// One plane at x = 64 + S / 2: the body (x = 64) is behind it in an
	// empty leaf, the head (x = 64 + S) is in front of it in water.
	const emptyLeaf = { contents: - 1 };
	const waterLeaf = { contents: - 3 };
	const worldmodel = {
		nodes: [ {
			contents: 0,
			plane: { normal: new Float32Array( [ 1, 0, 0 ] ), dist: 64 + S / 2 },
			children: [ waterLeaf, emptyLeaf ]
		} ]
	};

	const savedModel = cl.worldmodel;
	const savedOrg = Float32Array.from( render.r_refdef.vieworg );
	const savedAngles = Float32Array.from( render.r_refdef.viewangles );

	webxr.XR_SetTestOverrides( { renderer: fake, THREE: { Group } } );

	try {

		cl.worldmodel = worldmodel;
		render.r_refdef.vieworg.set( [ 64, 32, 0 ] );
		render.r_refdef.viewangles.set( [ 0, 0, 0 ] );

		// Desktop: the body
		gl_rmain.R_SetupFrame();
		assert( render.r_origin[ 0 ] === 64 && render.r_origin[ 1 ] === 32 && render.r_origin[ 2 ] === 0, 'desktop r_origin is vieworg' );
		assert( gl_rmain.r_viewleaf === emptyLeaf, 'desktop view leaf is the body\'s' );

		webxr.XR_Init( null );
		const xrOffset = groups[ 1 ];
		// Rig at the body facing +x, as R_SetupGL poses it: columns right, up, -forward
		xrOffset.matrixWorld.elements = [ 0, - 1, 0, 0, 0, 0, 1, 0, - 1, 0, 0, 0, 64 / S, 32 / S, 0, 1 ];
		// Head one meter ahead of the reference-space origin (-z is forward)
		cameras.push( {
			matrix: { elements: [ 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, - 1, 1 ] },
			projectionMatrix: { elements: [ 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, - 1, - 1, 0, 0, - 1, 0 ] }
		} );

		fire( 'sessionstart' );

		// Presenting but no pose yet: still the body
		gl_rmain.R_SetupFrame();
		assert( render.r_origin[ 0 ] === 64, 'no pose yet: r_origin is vieworg' );
		assert( gl_rmain.r_viewleaf === emptyLeaf, 'no pose yet: body leaf' );

		// R_SetupGL has posed the rig and the eyes are known
		gl_rmain.R_SetupXRFrustum();

		// The next frame uses that head
		gl_rmain.R_SetupFrame();
		assert( Math.abs( render.r_origin[ 0 ] - ( 64 + S ) ) < 1e-3, `head x: ${render.r_origin[ 0 ]}` );
		assert( Math.abs( render.r_origin[ 1 ] - 32 ) < 1e-3 && Math.abs( render.r_origin[ 2 ] ) < 1e-3, 'head y and z' );
		assert( gl_rmain.r_viewleaf === waterLeaf, 'view leaf is the head\'s' );

		// A teleport (view origin jump) drops the stale head for that frame
		render.r_refdef.vieworg.set( [ 64 + 1000, 32, 0 ] );
		gl_rmain.R_SetupFrame();
		assert( render.r_origin[ 0 ] === 64 + 1000, 'after a jump r_origin is vieworg' );
		gl_rmain.R_SetupXRFrustum();
		gl_rmain.R_SetupFrame();
		assert( Math.abs( render.r_origin[ 0 ] - ( 64 + S ) ) < 1e-3, 're-recorded head is used again' );

		// A new map does the same
		gl_rmain.R_NewMap();
		gl_rmain.R_SetupFrame();
		assert( render.r_origin[ 0 ] === 1064, 'after R_NewMap r_origin is vieworg' );
		render.r_refdef.vieworg.set( [ 64, 32, 0 ] );

		// Session over: the body again, and no stale head next session
		fire( 'sessionend' );
		gl_rmain.R_SetupFrame();
		assert( render.r_origin[ 0 ] === 64, 'after the session r_origin is vieworg' );
		assert( gl_rmain.r_viewleaf === emptyLeaf, 'after the session the body leaf' );
		fire( 'sessionstart' );
		gl_rmain.R_SetupFrame();
		assert( render.r_origin[ 0 ] === 64, 'a new session starts without the old head' );

	} finally {

		if ( webxr.isXRActive() ) fire( 'sessionend' );
		cl.worldmodel = savedModel;
		render.r_refdef.vieworg.set( savedOrg );
		render.r_refdef.viewangles.set( savedAngles );
		webxr.XR_SetTestOverrides();

	}

} );
