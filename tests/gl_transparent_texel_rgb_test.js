// gl_draw.c GL_Upload8 copies d_8to24table[ p ] for every texel, so a
// transparent texel (palette 255 with alpha on) keeps the palette's RGB and
// gets alpha 0 instead of black (TEX-2, gl_model.js half).

await import( '../src/gl_rsurf.js' );

const gl_model = await import( '../src/gl_model.js' );
const { d_8to24table } = await import( '../src/vid.js' );

function assertEqual( actual, expected, message ) {

	if ( actual !== expected )
		throw new Error( `${message}: expected ${expected}, got ${actual}` );

}

Deno.test( 'GL_LoadTexture keeps the palette RGB under transparent texels', () => {

	const old255 = d_8to24table[ 255 ];
	try {

		// RGB 159, 91, 83 with alpha 0, as VID_SetPalette leaves entry 255
		d_8to24table[ 255 ] = ( 83 << 16 ) | ( 91 << 8 ) | 159;
		const data = new Uint8Array( [ 15, 255, 255, 15 ] );
		const t = gl_model.GL_LoadTexture( '__transparent_rgb', 2, 2, data, false, true, false );
		const px = t.image.data;
		assertEqual( px[ 4 ], 159, 'R under the transparent texel' );
		assertEqual( px[ 5 ], 91, 'G' );
		assertEqual( px[ 6 ], 83, 'B' );
		assertEqual( px[ 7 ], 0, 'alpha 0' );
		assertEqual( px[ 3 ], 255, 'opaque texel alpha' );

		// without alpha, index 255 is an ordinary opaque colour
		const o = gl_model.GL_LoadTexture( '__opaque_255', 2, 2, data, false, false, false );
		assertEqual( o.image.data[ 7 ], 255, 'alpha off: opaque' );

	} finally {

		d_8to24table[ 255 ] = old255;

	}

} );
