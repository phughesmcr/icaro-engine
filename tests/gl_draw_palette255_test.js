// TEX-2: GL_Upload8 copies d_8to24table[ p ] for every texel, so a 2D
// texture's index 255 keeps the palette RGB and has alpha 0 (alpha textures).

await import( '../src/gl_rsurf.js' );

const { VID_SetPalette, d_8to24table } = await import( '../src/vid.js' );
const { Draw_SetExternals, GL_LoadTexture } = await import( '../src/gl_draw.js' );

function assertEqual( actual, expected, message ) {

	if ( actual !== expected )
		throw new Error( `${message}: expected ${expected}, got ${actual}` );

}

Deno.test( 'TEX-2: GL_LoadTexture keeps index 255 colour with alpha 0 for alpha textures only', () => {

	const palette = new Uint8Array( 768 );
	palette.fill( 40 );
	palette[ 765 ] = 159;
	palette[ 766 ] = 91;
	palette[ 767 ] = 83;
	VID_SetPalette( palette );
	Draw_SetExternals( { d_8to24table } );

	const uploads = [];
	const savedDocument = globalThis.document;
	globalThis.document = {
		createElement() {

			return {
				getContext() {

					return {
						createImageData: ( w, h ) => ( { data: new Uint8ClampedArray( w * h * 4 ) } ),
						putImageData( image ) { uploads.push( image.data ); }
					};

				}
			};

		}
	};

	try {

		const data = new Uint8Array( [ 255, 3 ] );
		GL_LoadTexture( 'tex2_alpha', 2, 1, data, false, true );
		GL_LoadTexture( 'tex2_solid', 2, 1, data, false, false );

		const [ alphaTex, solidTex ] = uploads;
		assertEqual( alphaTex[ 0 ], 159, 'alpha texture 255 red' );
		assertEqual( alphaTex[ 2 ], 83, 'alpha texture 255 blue' );
		assertEqual( alphaTex[ 3 ], 0, 'alpha texture 255 alpha' );
		assertEqual( alphaTex[ 7 ], 255, 'alpha texture other texel alpha' );
		assertEqual( solidTex[ 0 ], 159, 'solid texture 255 red' );
		assertEqual( solidTex[ 3 ], 255, 'solid texture 255 is opaque' );

	} finally {

		if ( savedDocument === undefined ) delete globalThis.document;
		else globalThis.document = savedDocument;

	}

} );
