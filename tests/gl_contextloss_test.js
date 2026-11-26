// Bootstrap the renderer's existing circular module graph in its safe order.
const gl_rsurf = await import( '../src/gl_rsurf.js' );
const gl_rmain = await import( '../src/gl_rmain.js' );
const { cl } = await import( '../src/client.js' );
const loss = await import( '../src/gl_contextloss.js' );
const screenwarp = await import( '../src/gl_screenwarp.js' );
const gl_screen = await import( '../src/gl_screen.js' );
const console_ = await import( '../src/console.js' );
const cmd = await import( '../src/cmd.js' );

function assertEqual( actual, expected, message ) {

	if ( actual !== expected )
		throw new Error( `${message}: expected ${expected}, got ${actual}` );

}

function makeCanvas() {

	const listeners = {};
	return {
		addEventListener( type, fn ) {

			listeners[ type ] = fn;

		},
		fire( type ) {

			const event = {
				prevented: false,
				preventDefault() {

					this.prevented = true;

				}
			};
			listeners[ type ]( event );
			return event;

		}
	};

}

function makeSurface() {

	return {
		flags: 0,
		numedges: 0,
		firstedge: 0,
		polys: null,
		extents: new Int16Array( [ 16, 16 ] ),
		texturemins: new Int16Array( [ 0, 0 ] ),
		styles: new Uint8Array( [ 0, 255, 255, 255 ] ),
		cached_light: new Int32Array( 4 ),
		cached_dlight: false,
		dlightframe: - 1,
		dlightbits: new Uint32Array( 2 ),
		samples: new Uint8Array( [ 30, 0, 0, 0 ] ),
		sampleOffset: 0,
		rgbsamples: false,
		plane: { normal: new Float32Array( [ 0, 0, 1 ] ), dist: 0 },
		texinfo: { vecs: [ new Float32Array( [ 1, 0, 0, 0 ] ), new Float32Array( [ 0, 1, 0, 0 ] ) ] },
		lightmaptexturenum: 0,
		light_s: 0,
		light_t: 0
	};

}

Deno.test( 'context loss pauses drawing; restore re-sends the lightmaps', () => {

	const warn = console.warn;
	const oldFrame = gl_rmain.r_framecount;
	const oldModel = cl.model_precache[ 1 ];
	const oldNext = cl.model_precache[ 2 ];
	const oldWorldmodel = cl.worldmodel;
	console.warn = () => {};

	try {

		const world = {
			name: 'maps/__ctxloss_world.bsp',
			litfile: false,
			lightdata: new Uint8Array( 1 ),
			numsurfaces: 1,
			surfaces: [ makeSurface() ],
			vertexes: [],
			edges: [],
			surfedges: []
		};
		cl.worldmodel = world;
		cl.model_precache[ 1 ] = world;
		cl.model_precache[ 2 ] = null;
		gl_rsurf.GL_BuildLightmaps();

		const tex = gl_rsurf.lightmapTextures[ 0 ];
		assertEqual( tex !== undefined, true, 'a lightmap block exists' );
		tex.needsUpdate = false; // pretend it was uploaded
		const lastRow = ( gl_rsurf.BLOCK_HEIGHT - 1 ) * gl_rsurf.BLOCK_WIDTH * 4;
		tex.image.data.fill( 7 );

		// nothing pending: a blend pass leaves the data alone
		gl_rsurf.R_BlendLightmaps();
		assertEqual( tex.image.data[ lastRow ], 7, 'no pending rows before the loss' );

		loss.GL_ContextLoss_Reset();
		const canvas = makeCanvas();
		const depthCalls = [];
		loss.GL_ContextLoss_Init( {
			domElement: canvas,
			getContext() {

				return {
					depthRange( n, f ) {

						depthCalls.push( n + ',' + f );

					}
				};

			}
		} );

		assertEqual( loss.GL_ContextLost(), false, 'not lost at start' );
		const lostEvent = canvas.fire( 'webglcontextlost' );
		assertEqual( lostEvent.prevented, true, 'preventDefault on lost' );
		assertEqual( loss.GL_ContextLost(), true, 'lost flag set' );

		canvas.fire( 'webglcontextrestored' );
		assertEqual( loss.GL_ContextLost(), false, 'lost flag cleared' );
		assertEqual( depthCalls.join( ' ' ), '0,1', 'depthRange reset to 0..1' );
		assertEqual( tex.needsUpdate, true, 'lightmap texture queued for a full upload' );

		// the whole block is converted on the next blend pass
		gl_rsurf.R_BlendLightmaps();
		assertEqual( tex.image.data[ lastRow ] !== 7, true, 'every row converted after restore' );

	} finally {

		console.warn = warn;
		loss.GL_ContextLoss_Reset();
		cl.model_precache[ 1 ] = oldModel;
		cl.model_precache[ 2 ] = oldNext;
		cl.worldmodel = oldWorldmodel;
		gl_rsurf.GL_BuildLightmaps();
		gl_rmain.set_r_framecount( oldFrame );

	}

} );

Deno.test( 'GL_ContextLoss_Init ignores a missing renderer and a canvas without listeners', () => {

	loss.GL_ContextLoss_Reset();
	loss.GL_ContextLoss_Init( null );
	loss.GL_ContextLoss_Init( { domElement: null } );
	loss.GL_ContextLoss_Init( { domElement: {} } );
	assertEqual( loss.GL_ContextLost(), false, 'still not lost' );

} );

Deno.test( 'R_WarpContextRestored is safe before the warp exists', () => {

	screenwarp.R_WarpContextRestored();

} );

Deno.test( 'SCR_UpdateScreen draws nothing while the context is lost', () => {

	const hadWindow = 'window' in globalThis;
	if ( ! hadWindow )
		globalThis.window = { location: { search: '' }, innerWidth: 640, innerHeight: 480, devicePixelRatio: 1 };

	cmd.Cbuf_Init();
	cmd.Cmd_Init();
	console_.Con_Init();
	gl_screen.SCR_Init();

	let begun = 0;
	gl_screen.SCR_SetExternals( { GL_BeginRendering() {

		begun ++;

	} } );

	const warn = console.warn;
	console.warn = () => {};

	try {

		const canvas = makeCanvas();
		loss.GL_ContextLoss_Reset();
		loss.GL_ContextLoss_Init( { domElement: canvas, getContext() {

			return null;

		} } );

		canvas.fire( 'webglcontextlost' );
		gl_screen.SCR_UpdateScreen();
		assertEqual( begun, 0, 'no GL_BeginRendering while lost' );

		canvas.fire( 'webglcontextrestored' );
		try {

			gl_screen.SCR_UpdateScreen();

		} catch ( _e ) {

			// the rest of the frame may need a full engine; only the gate matters
		}

		assertEqual( begun, 1, 'the frame starts again once restored' );

	} finally {

		console.warn = warn;
		loss.GL_ContextLoss_Reset();
		if ( ! hadWindow ) delete globalThis.window;

	}

} );
