// gl_model.js R_InitSky hands the sky texture's size and name to gl_warp.js
// R_InitSky (QuakeSpasm Sky_LoadTexture), which splits it at any size and
// returns null when it is too small to split.

// Bootstrap the renderer's existing circular module graph in its safe order.
await import( '../src/gl_rsurf.js' );
const gl_model = await import( '../src/gl_model.js' );
const bspfile = await import( '../src/bspfile.js' );
const { COM_AddPack } = await import( '../src/pak.js' );

function assertEqual( actual, expected, message ) {

	if ( actual !== expected )
		throw new Error( `${message}: expected ${expected}, got ${actual}` );

}

function buildBsp( lumps ) {

	const header = 4 + bspfile.HEADER_LUMPS * 8;
	let size = header;
	for ( let i = 0; i < bspfile.HEADER_LUMPS; i ++ )
		size += ( lumps[ i ] !== undefined ) ? ( lumps[ i ].length + 3 ) & ~ 3 : 0;

	const bytes = new Uint8Array( size );
	const view = new DataView( bytes.buffer );
	view.setInt32( 0, bspfile.BSPVERSION, true );

	let ofs = header;
	for ( let i = 0; i < bspfile.HEADER_LUMPS; i ++ ) {

		const lump = lumps[ i ];
		const len = lump !== undefined ? lump.length : 0;
		view.setInt32( 4 + i * 8, len > 0 ? ofs : 0, true );
		view.setInt32( 4 + i * 8 + 4, len, true );
		if ( len > 0 ) {

			bytes.set( lump, ofs );
			ofs += ( len + 3 ) & ~ 3;

		}

	}

	return bytes;

}

function lump( size, fill ) {

	const out = new Uint8Array( size );
	fill( new DataView( out.buffer ) );
	return out;

}

// One empty leaf and one miptex named sky1 of the given size.
function skyBsp( width, height ) {

	const pixels = Math.floor( width * height / 64 * 85 );
	const lumps = [];
	lumps[ bspfile.LUMP_PLANES ] = lump( 20, ( v ) => v.setFloat32( 0, 1, true ) );
	lumps[ bspfile.LUMP_LEAFS ] = lump( 2 * 28, ( v ) => {

		v.setInt32( 0, bspfile.CONTENTS_SOLID, true );
		v.setInt32( 4, - 1, true );
		v.setInt32( 28, bspfile.CONTENTS_EMPTY, true );
		v.setInt32( 32, - 1, true );

	} );
	lumps[ bspfile.LUMP_NODES ] = lump( 24, ( v ) => {

		v.setUint16( 4, 0xffff, true );
		v.setUint16( 6, 0xfffe, true );

	} );
	lumps[ bspfile.LUMP_CLIPNODES ] = lump( 8, ( v ) => {

		v.setUint16( 4, 0xffff, true );
		v.setUint16( 6, 0xfffe, true );

	} );
	lumps[ bspfile.LUMP_MODELS ] = lump( 64, ( v ) => {

		for ( let j = 0; j < 3; j ++ ) {

			v.setFloat32( j * 4, - 64, true );
			v.setFloat32( 12 + j * 4, 64, true );

		}

		v.setInt32( 52, 1, true );	// visleafs

	} );
	// dmiptexlump_t: nummiptex, dataofs[ 1 ], then miptex_t and its pixels
	lumps[ bspfile.LUMP_TEXTURES ] = lump( 8 + 40 + pixels, ( v ) => {

		v.setInt32( 0, 1, true );
		v.setInt32( 4, 8, true );
		const name = 'sky1';
		for ( let i = 0; i < name.length; i ++ )
			v.setUint8( 8 + i, name.charCodeAt( i ) );
		v.setUint32( 8 + 16, width, true );
		v.setUint32( 8 + 20, height, true );
		v.setUint32( 8 + 24, 40, true );

	} );
	return buildBsp( lumps );

}

function loadSkyBsp( name, width, height ) {

	const bytes = skyBsp( width, height );
	COM_AddPack( { files: [ { name: name, filepos: 0, filelen: bytes.length } ], data: bytes.buffer } );
	return gl_model.Mod_ForName( name, true );

}

Deno.test( 'a sky texture of another size is split at its own size', () => {

	loadSkyBsp( 'maps/__sky_wide.bsp', 512, 64 );
	if ( gl_model.solidskytexture === null || gl_model.alphaskytexture === null )
		throw new Error( 'no sky textures' );
	assertEqual( gl_model.solidskytexture.image.width, 256, 'solid layer is the right half' );
	assertEqual( gl_model.solidskytexture.image.height, 64, 'solid layer height' );
	assertEqual( gl_model.alphaskytexture.image.width, 256, 'alpha layer is the left half' );

} );

Deno.test( 'a sky texture too small to split loads no sky', () => {

	loadSkyBsp( 'maps/__sky_ok.bsp', 256, 128 );
	if ( gl_model.solidskytexture === null )
		throw new Error( 'the 256 x 128 sky did not load' );

	gl_model.Mod_ClearAll(); // as Host_ClearMemory does before each map
	loadSkyBsp( 'maps/__sky_tiny.bsp', 1, 16 );
	assertEqual( gl_model.solidskytexture, null, 'no solid sky' );
	assertEqual( gl_model.alphaskytexture, null, 'no alpha sky' );

} );
