// Tests for the Ironwail HUD scale cvars (scr_sbarscale, scr_conscale):
// gl_draw.js canvas scales and the status bar lines SCR_CalcRefdef leaves
// for the status bar.

await import( '../src/gl_rsurf.js' );
globalThis.window = { devicePixelRatio: 1 }; // gl_draw.js sizes the virtual screen from it

const draw = await import( '../src/gl_draw.js' );
const scr = await import( '../src/gl_screen.js' );

function assertEqual( actual, expected, message ) {

	if ( actual !== expected )
		throw new Error( `${message}: expected ${expected}, got ${actual}` );

}

// gl_draw's default video size is 640x480: the automatic UI scale is
// floor( 480 / 240 ) = 2, a 320x240 virtual screen.

Deno.test( 'Draw_GetCanvasScale clamps like Ironwail and 0 keeps the automatic scale', () => {

	assertEqual( draw.Draw_GetUIScale(), 2, 'automatic UI scale' );
	assertEqual( draw.Draw_GetCanvasScale( 0 ), 2, 'scale 0 is automatic' );
	assertEqual( draw.Draw_GetCanvasScale( - 1 ), 2, 'negative is automatic' );
	assertEqual( draw.Draw_GetCanvasScale( 0.5 ), 1, 'clamped up to 1' );
	assertEqual( draw.Draw_GetCanvasScale( 1.5 ), 1.5, 'fractional scales kept' );
	assertEqual( draw.Draw_GetCanvasScale( 5 ), 2, 'clamped to width / 320' );

} );

Deno.test( 'Draw_SetCanvasScale sizes the virtual screen and the overlay transform', () => {

	const transforms = [];
	const ctx = {
		setTransform: ( a ) => transforms.push( a ),
		clearRect: () => {}, drawImage: () => {}, fillText: () => {}, fillRect: () => {},
	};
	try {

		draw.Draw_Init( { width: 640, height: 480, getContext: () => ctx } );

	} catch {

		// no WAD in tests; only the overlay context matters here

	}

	try {

		transforms.length = 0;
		draw.Draw_SetCanvasScale( 1 );
		assertEqual( draw.Draw_GetVirtualWidth(), 640, 'scale 1 width' );
		assertEqual( draw.Draw_GetVirtualHeight(), 480, 'scale 1 height' );
		assertEqual( draw.Draw_GetUIScale(), 2, 'the UI scale is unchanged' );

		draw.Draw_SetCanvasScale( 1.5 );
		assertEqual( draw.Draw_GetVirtualWidth(), Math.ceil( 640 / 1.5 ), 'scale 1.5 width' );

		draw.Draw_SetCanvasScale( 0 );
		assertEqual( draw.Draw_GetVirtualWidth(), 320, 'reset width' );
		assertEqual( transforms.join( ',' ), '1,1.5,2', 'overlay transforms' );

		// Draw_BeginFrame drops a canvas scale left set
		draw.Draw_SetCanvasScale( 1 );
		draw.Draw_BeginFrame();
		assertEqual( draw.Draw_GetVirtualWidth(), 320, 'BeginFrame resets the canvas' );

	} finally {

		draw.Draw_SetCanvasScale( 0 );

	}

} );

Deno.test( 'SCR_CalcRefdef leaves room for the scaled status bar', () => {

	const r_refdef = { vrect: { x: 0, y: 0, width: 0, height: 0 }, vrectScale: 1, fov_x: 0, fov_y: 0 };
	scr.SCR_SetExternals( { r_refdef, cl: { intermission: 0, paused: false, worldmodel: null, time: 0 } } );

	const saved = scr.scr_sbarscale.value;
	try {

		// viewsize 100: a 48-line status bar, in 2x UI units
		for ( const [ value, height ] of [ [ 0, 240 - 48 ], [ 1, 240 - 24 ], [ 1.5, 240 - 36 ], [ 2, 240 - 48 ], [ 4, 240 - 48 ] ] ) {

			scr.scr_sbarscale.value = value;
			scr.SCR_CalcRefdef();
			assertEqual( r_refdef.vrect.height, height, 'view height at scr_sbarscale ' + value );

		}

	} finally {

		scr.scr_sbarscale.value = saved;

	}

} );
