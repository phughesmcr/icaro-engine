// Bootstrap the renderer's existing circular module graph in its safe order.
const gl_rsurf = await import( '../src/gl_rsurf.js' );

const glquake = await import( '../src/glquake.js' );
const gl_rmain = await import( '../src/gl_rmain.js' );
const gl_rlight = await import( '../src/gl_rlight.js' );
const view = await import( '../src/view.js' );
const THREE = await import( 'three' );
const { cl, cl_dlights } = await import( '../src/client.js' );
const { r_origin } = await import( '../src/render.js' );

function assertEqual( actual, expected, message ) {

	if ( actual !== expected )
		throw new Error( `${message}: expected ${expected}, got ${actual}` );

}

function assertNear( actual, expected, message, epsilon = 1e-6 ) {

	if ( Number.isFinite( actual ) === false || Math.abs( actual - expected ) > epsilon )
		throw new Error( `${message}: expected ${expected}, got ${actual}` );

}

Deno.test( 'dynamic lights add their proximity blend to the displayed overlay', () => {

	const oldBlend = new Float32Array( glquake.v_blend );
	const oldFlashblend = glquake.gl_flashblend.value;
	const oldTime = cl.time;
	const oldOrigin = new Float32Array( r_origin );
	const oldLights = cl_dlights.map( ( light ) => ( {
		die: light.die,
		radius: light.radius,
		origin: new Float32Array( light.origin )
	} ) );
	const scene = new THREE.Scene();

	try {

		assertEqual( view.v_blend, glquake.v_blend, 'view blend identity' );
		assertEqual( gl_rmain.v_blend, glquake.v_blend, 'renderer blend identity' );

		glquake.gl_flashblend.value = 1;
		cl.time = 10;
		r_origin.fill( 0 );
		glquake.v_blend.fill( 0 );
		for ( const light of cl_dlights ) {

			light.die = 0;
			light.radius = 0;

		}

		const light = cl_dlights[ cl_dlights.length - 1 ];
		light.die = 11;
		light.radius = 100;
		light.origin.fill( 0 );

		gl_rlight.R_RenderDlights( cl, scene );

		assertNear( gl_rmain.v_blend[ 0 ], 1, 'inside-light red blend' );
		assertNear( gl_rmain.v_blend[ 1 ], 0.5, 'inside-light green blend' );
		assertNear( gl_rmain.v_blend[ 2 ], 0, 'inside-light blue blend' );
		assertNear( gl_rmain.v_blend[ 3 ], 0.03, 'inside-light alpha blend' );
		assertEqual( scene.children.length, 1, 'pooled light attached once' );
		const pointLight = scene.children[ 0 ];

		glquake.v_blend.fill( 0 );
		gl_rlight.R_RenderDlights( cl, scene );
		assertEqual( scene.children.length, 1, 'pooled light not duplicated' );
		assertEqual( scene.children[ 0 ], pointLight, 'pooled light reused' );

		glquake.v_blend.fill( 0 );
		light.origin.set( [ 35, 0, 0 ] );
		gl_rlight.R_RenderDlights( cl, scene );
		assertNear( gl_rmain.v_blend[ 3 ], 0, 'radius boundary has no blend' );

		light.die = 9;
		gl_rlight.R_RenderDlights( cl, scene );
		assertEqual( scene.children.length, 0, 'expired pooled light detached' );

	} finally {

		cl_dlights[ cl_dlights.length - 1 ].die = 0;
		cl_dlights[ cl_dlights.length - 1 ].radius = 0;
		gl_rlight.R_RenderDlights( cl, scene );
		glquake.v_blend.set( oldBlend );
		glquake.gl_flashblend.value = oldFlashblend;
		cl.time = oldTime;
		r_origin.set( oldOrigin );
		for ( let i = 0; i < cl_dlights.length; i ++ ) {

			cl_dlights[ i ].die = oldLights[ i ].die;
			cl_dlights[ i ].radius = oldLights[ i ].radius;
			cl_dlights[ i ].origin.set( oldLights[ i ].origin );

		}

	}

} );

Deno.test( 'dynamic light marks use the renderer frame counter', () => {

	const oldFrame = gl_rmain.r_framecount;
	const oldFlashblend = glquake.gl_flashblend.value;
	const oldTime = cl.time;
	const oldWorldmodel = cl.worldmodel;
	const oldLights = cl_dlights.map( ( light ) => ( {
		die: light.die,
		radius: light.radius,
		origin: new Float32Array( light.origin )
	} ) );

	try {

		const surface = { dlightframe: - 1, dlightbits: new Uint32Array( [ 0x80, 0x80 ] ) };
		const leaf0 = { contents: - 1 };
		const leaf1 = { contents: - 1 };
		const root = {
			contents: 0,
			plane: {
				normal: new Float32Array( [ 1, 0, 0 ] ),
				dist: 0
			},
			firstsurface: 0,
			numsurfaces: 1,
			children: [ leaf0, leaf1 ]
		};

		cl.time = 10;
		cl.worldmodel = { nodes: [ root ], surfaces: [ surface ] };
		glquake.gl_flashblend.value = 0;
		for ( const light of cl_dlights ) {

			light.die = 0;
			light.radius = 0;

		}

		cl_dlights[ 0 ].die = 11;
		cl_dlights[ 0 ].radius = 64;
		cl_dlights[ 0 ].origin.fill( 0 );

		gl_rmain.set_r_framecount( 41 );
		gl_rlight.R_PushDlights( cl );

		assertEqual( glquake.r_framecount, 41, 'shared pre-frame count' );
		assertEqual( gl_rlight.r_dlightframecount, 42, 'dynamic-light frame' );
		assertEqual( surface.dlightframe, 42, 'marked surface frame' );
		assertEqual( surface.dlightbits[ 0 ], 1, 'marked surface bits' );
		assertEqual( surface.dlightbits[ 1 ], 0, 'stale high word cleared' );

		assertEqual( gl_rmain.inc_r_framecount(), 42, 'advanced renderer frame' );
		assertEqual( gl_rmain.r_framecount, 42, 'renderer frame binding' );
		assertEqual( glquake.r_framecount, 42, 'shared frame binding' );
		assertEqual( surface.dlightframe, gl_rmain.r_framecount,
			'mark consumed by the rendered frame' );

	} finally {

		gl_rmain.set_r_framecount( oldFrame );
		glquake.gl_flashblend.value = oldFlashblend;
		cl.time = oldTime;
		cl.worldmodel = oldWorldmodel;
		for ( let i = 0; i < cl_dlights.length; i ++ ) {

			cl_dlights[ i ].die = oldLights[ i ].die;
			cl_dlights[ i ].radius = oldLights[ i ].radius;
			cl_dlights[ i ].origin.set( oldLights[ i ].origin );

		}

	}

} );

Deno.test( 'inline brush models receive dynamic light marks', () => {

	const oldFrame = gl_rmain.r_framecount;
	const oldBrushPolys = gl_rmain.c_brush_polys;
	const oldFlashblend = glquake.gl_flashblend.value;
	const oldTime = cl.time;
	const oldWorldmodel = cl.worldmodel;
	const oldLights = cl_dlights.map( ( light ) => ( {
		die: light.die,
		radius: light.radius,
		origin: new Float32Array( light.origin )
	} ) );

	try {

		const leaf0 = { contents: - 1 };
		const leaf1 = { contents: - 1 };
		const plane = {
			normal: new Float32Array( [ 1, 0, 0 ] ),
			dist: 0
		};
		const worldSurface = { dlightframe: - 1, dlightbits: new Uint32Array( 2 ) };
		const worldRoot = {
			contents: 0,
			plane: plane,
			firstsurface: 0,
			numsurfaces: 1,
			children: [ leaf0, leaf1 ]
		};
		const brushSurface = {
			flags: gl_rmain.SURF_DRAWSKY,
			dlightframe: - 7,
			dlightbits: new Uint32Array( [ 0x80, 0 ] )
		};
		const brushRoot = {
			contents: 0,
			plane: plane,
			firstsurface: 1,
			numsurfaces: 1,
			children: [ leaf0, leaf1 ]
		};
		const brushGroup = {
			children: [],
			parent: { remove() {} },
			position: { set() {} },
			quaternion: { identity() {}, setFromEuler() {} }
		};
		const model = {
			mins: new Float32Array( [ - 1, - 1, - 1 ] ),
			maxs: new Float32Array( [ 1, 1, 1 ] ),
			radius: 2,
			firstmodelsurface: 1,
			nummodelsurfaces: 1,
			nodes: [ brushRoot ],
			hulls: [ { firstclipnode: 0 } ],
			surfaces: [ null, brushSurface ]
		};
		const entity = {
			origin: new Float32Array( 3 ),
			angles: new Float32Array( 3 ),
			frame: 0,
			model: model,
			_brushGroup: brushGroup,
			_brushGroupFrame: 0,
			_brushAnimSurfaces: null
		};

		cl.time = 10;
		cl.worldmodel = { nodes: [ worldRoot ], surfaces: [ worldSurface ] };
		glquake.gl_flashblend.value = 0;
		for ( const light of cl_dlights ) {

			light.die = 0;
			light.radius = 0;

		}

		cl_dlights[ 0 ].die = 11;
		cl_dlights[ 0 ].radius = 64;
		cl_dlights[ 0 ].origin.fill( 0 );

		gl_rmain.set_r_framecount( 41 );
		gl_rlight.R_PushDlights( cl );
		gl_rmain.inc_r_framecount();
		gl_rsurf.R_DrawBrushModel( entity );

		assertEqual( brushSurface.dlightframe, 42, 'brush surface frame' );
		assertEqual( brushSurface.dlightbits[ 0 ], 1, 'brush surface bits' );

	} finally {

		gl_rmain.set_r_framecount( oldFrame );
		gl_rmain.set_c_brush_polys( oldBrushPolys );
		glquake.gl_flashblend.value = oldFlashblend;
		cl.time = oldTime;
		cl.worldmodel = oldWorldmodel;
		for ( let i = 0; i < cl_dlights.length; i ++ ) {

			cl_dlights[ i ].die = oldLights[ i ].die;
			cl_dlights[ i ].radius = oldLights[ i ].radius;
			cl_dlights[ i ].origin.set( oldLights[ i ].origin );

		}

	}

} );

function saveLights() {

	return cl_dlights.map( ( light ) => ( {
		die: light.die,
		radius: light.radius,
		minlight: light.minlight,
		origin: new Float32Array( light.origin )
	} ) );

}

function restoreLights( saved ) {

	for ( let i = 0; i < cl_dlights.length; i ++ ) {

		cl_dlights[ i ].die = saved[ i ].die;
		cl_dlights[ i ].radius = saved[ i ].radius;
		cl_dlights[ i ].minlight = saved[ i ].minlight;
		cl_dlights[ i ].origin.set( saved[ i ].origin );

	}

}

Deno.test( 'light 40 marks only its own surfaces and bit', () => {

	const oldFrame = gl_rmain.r_framecount;
	const oldFlashblend = glquake.gl_flashblend.value;
	const oldTime = cl.time;
	const oldWorldmodel = cl.worldmodel;
	const oldLights = saveLights();

	try {

		assertEqual( gl_rlight.MAX_DLIGHTS > 40, true, 'MAX_DLIGHTS above 40' );

		// root (plane x = 0) holds surface A; its front child (plane
		// x = 1000) holds surface B.
		const surfaceA = { dlightframe: - 1, dlightbits: new Uint32Array( 2 ) };
		const surfaceB = { dlightframe: - 1, dlightbits: new Uint32Array( 2 ) };
		const leaf = { contents: - 1 };
		const front = {
			contents: 0,
			plane: { normal: new Float32Array( [ 1, 0, 0 ] ), dist: 1000 },
			firstsurface: 1,
			numsurfaces: 1,
			children: [ leaf, leaf ]
		};
		const root = {
			contents: 0,
			plane: { normal: new Float32Array( [ 1, 0, 0 ] ), dist: 0 },
			firstsurface: 0,
			numsurfaces: 1,
			children: [ front, leaf ]
		};

		cl.time = 10;
		cl.worldmodel = { nodes: [ root ], surfaces: [ surfaceA, surfaceB ] };
		glquake.gl_flashblend.value = 0;
		for ( const light of cl_dlights ) {

			light.die = 0;
			light.radius = 0;

		}

		// Frame 1: light 40 at A, light 3 at B.
		cl_dlights[ 40 ].die = 11;
		cl_dlights[ 40 ].radius = 64;
		cl_dlights[ 40 ].origin.fill( 0 );
		cl_dlights[ 3 ].die = 11;
		cl_dlights[ 3 ].radius = 64;
		cl_dlights[ 3 ].origin.set( [ 1000, 0, 0 ] );

		gl_rmain.set_r_framecount( 10 );
		gl_rlight.R_PushDlights( cl );

		assertEqual( surfaceA.dlightbits[ 0 ], 0, 'A: no alias onto light 8' );
		assertEqual( surfaceA.dlightbits[ 1 ], 1 << 8, 'A: light 40 bit' );
		assertEqual( surfaceB.dlightbits[ 0 ], 1 << 3, 'B: light 3 bit' );
		assertEqual( surfaceB.dlightbits[ 1 ], 0, 'B: not lit by light 40' );

		// Frame 2: light 3 is gone and light 40 moves to B. B's stale
		// light 3 bit must not survive.
		cl_dlights[ 3 ].radius = 0;
		cl_dlights[ 40 ].origin.set( [ 1000, 0, 0 ] );
		gl_rmain.set_r_framecount( 11 );
		gl_rlight.R_PushDlights( cl );

		assertEqual( surfaceB.dlightframe, 12, 'B marked this frame' );
		assertEqual( surfaceB.dlightbits[ 0 ], 0, 'B: stale light 3 bit cleared' );
		assertEqual( surfaceB.dlightbits[ 1 ], 1 << 8, 'B: light 40 bit' );
		assertEqual( surfaceA.dlightframe, 11, 'A not marked this frame' );

	} finally {

		gl_rmain.set_r_framecount( oldFrame );
		glquake.gl_flashblend.value = oldFlashblend;
		cl.time = oldTime;
		cl.worldmodel = oldWorldmodel;
		restoreLights( oldLights );

	}

} );

Deno.test( 'lightmap dynamic lighting reads light 40, not light 8', () => {

	const oldFrame = gl_rmain.r_framecount;
	const oldWorldmodel = cl.worldmodel;
	const oldLights = saveLights();

	try {

		const surface = {
			extents: new Int16Array( [ 0, 0 ] ),
			texturemins: new Int16Array( [ 0, 0 ] ),
			styles: new Uint8Array( [ 255, 255, 255, 255 ] ),
			cached_light: new Int32Array( 4 ),
			cached_dlight: false,
			samples: null,
			plane: { normal: new Float32Array( [ 0, 0, 1 ] ), dist: 0 },
			texinfo: {
				vecs: [
					new Float32Array( [ 1, 0, 0, 0 ] ),
					new Float32Array( [ 0, 1, 0, 0 ] )
				]
			},
			dlightframe: 5,
			dlightbits: new Uint32Array( 2 )
		};
		const dest = new Uint8Array( 1 );

		cl.worldmodel = null;
		for ( const light of cl_dlights ) {

			light.radius = 0;
			light.minlight = 0;

		}

		gl_rmain.set_r_framecount( 5 );

		// Only light 40's bit is set. A bright light 8 must not be read.
		surface.dlightbits[ 1 ] = 1 << 8;
		cl_dlights[ 8 ].radius = 200;
		cl_dlights[ 8 ].origin.set( [ 0, 0, 16 ] );
		gl_rsurf.R_BuildLightMap( surface, dest, 0, 1 );
		assertEqual( dest[ 0 ], 255, 'light 8 ignored' );

		// Light 40 itself lights the surface.
		cl_dlights[ 40 ].radius = 200;
		cl_dlights[ 40 ].origin.set( [ 0, 0, 16 ] );
		gl_rsurf.R_BuildLightMap( surface, dest, 0, 1 );
		assertEqual( dest[ 0 ] < 255, true, 'light 40 adds light' );

	} finally {

		gl_rmain.set_r_framecount( oldFrame );
		cl.worldmodel = oldWorldmodel;
		restoreLights( oldLights );

	}

} );
