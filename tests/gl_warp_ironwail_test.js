// Bootstrap the renderer's existing circular module graph in its safe order.
await import( '../src/gl_rsurf.js' );

const gl_warp = await import( '../src/gl_warp.js' );
const { Con_SetPrintFunctions } = await import( '../src/common.js' );

// Runs fn and returns what it printed through Con_Printf
function capturePrints( fn ) {

	const printed = [];
	Con_SetPrintFunctions( ( text ) => printed.push( text ), null );
	try {

		fn();

	} finally {

		Con_SetPrintFunctions( null, null );

	}

	return printed.join( '' );

}

function assertEqual( actual, expected, message ) {

	if ( actual !== expected )
		throw new Error( `${message}: expected ${expected}, got ${actual}` );

}

// Palette where index p is the colour ( p, p, p ) with full alpha
const palette = new Uint32Array( 256 );
for ( let p = 0; p < 256; p ++ ) palette[ p ] = ( 0xff << 24 ) | ( p << 16 ) | ( p << 8 ) | p;

// Left half (front, masked) is index 1 except a 0 at the first texel;
// right half (back, solid) is index 7.
function makeSky( width, height ) {

	const data = new Uint8Array( width * height );
	for ( let y = 0; y < height; y ++ )
		for ( let x = 0; x < width; x ++ )
			data[ y * width + x ] = x < width / 2 ? 1 : 7;
	data[ 0 ] = 0;
	return data;

}

Deno.test( 'R_InitSky splits a 256x128 sky into two 128x128 layers', () => {

	let sky = null;
	const printed = capturePrints( () => {

		sky = gl_warp.R_InitSky( { data: makeSky( 256, 128 ), offsets: [ 0 ], width: 256, height: 128 }, palette );

	} );
	assertEqual( printed, '', 'no warning for a 256x128 sky' );
	assertEqual( sky.solidTexture.image.width, 128, 'solid width' );
	assertEqual( sky.solidTexture.image.height, 128, 'solid height' );
	assertEqual( sky.solidTexture.image.data[ 0 ], 7, 'solid texel' );
	assertEqual( sky.alphaTexture.image.data[ 3 ], 0, 'masked texel alpha' );
	assertEqual( sky.alphaTexture.image.data[ 0 ], 7, 'masked texel takes the back average' );
	assertEqual( sky.alphaTexture.image.data[ 4 ], 1, 'front texel' );
	assertEqual( sky.alphaTexture.image.data[ 7 ], 255, 'front texel alpha' );

} );

Deno.test( 'R_InitSky uses width/2 layers for other sizes, as QuakeSpasm does', () => {

	const width = 64, height = 32;
	let sky = null;
	const printed = capturePrints( () => {

		sky = gl_warp.R_InitSky( { data: makeSky( width, height ), offsets: [ 0 ], width, height, name: 'sky_small' }, palette );

	} );
	assertEqual( printed, 'Sky texture sky_small is 64 x 32, expected 256 x 128\n', 'size warning' );
	assertEqual( sky.solidTexture.image.width, 32, 'solid width' );
	assertEqual( sky.solidTexture.image.height, 32, 'solid height' );
	assertEqual( sky.alphaTexture.image.width, 32, 'alpha width' );
	assertEqual( sky.alphaTexture.image.data.length, 32 * 32 * 4, 'alpha size' );
	// Last texel of each layer comes from the right row and half
	const last = ( 32 * 32 - 1 ) * 4;
	assertEqual( sky.solidTexture.image.data[ last ], 7, 'last solid texel' );
	assertEqual( sky.alphaTexture.image.data[ last ], 1, 'last front texel' );

} );

Deno.test( 'R_InitSky gives no sky for a texture too small to split', () => {

	let sky;
	capturePrints( () => {

		sky = gl_warp.R_InitSky( { data: new Uint8Array( 1 ), offsets: [ 0 ], width: 1, height: 1 }, palette );

	} );
	assertEqual( sky, null, 'sky' );

} );

Deno.test( 'BoundPoly bounds vertices beyond 9999 units', () => {

	const verts = new Float32Array( [
		20000, 20000, 20000,
		30000, 30000, 30000,
		25000, 25000, 25000
	] );
	const mins = new Float32Array( 3 );
	const maxs = new Float32Array( 3 );
	gl_warp.BoundPoly( 3, verts, mins, maxs );
	assertEqual( mins[ 0 ], 20000, 'mins' );
	assertEqual( maxs[ 2 ], 30000, 'maxs' );

	verts.fill( - 20000 );
	gl_warp.BoundPoly( 3, verts, mins, maxs );
	assertEqual( mins[ 1 ], - 20000, 'negative mins' );
	assertEqual( maxs[ 1 ], - 20000, 'negative maxs' );

} );
