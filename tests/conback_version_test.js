// Port-inventory gap G7: gl_draw.c Draw_Init stamps "(gl 1.00) 1.09" onto
// gfx/conback.lmp with Draw_CharToConback.

await import( '../src/gl_rsurf.js' );

const draw = await import( '../src/gl_draw.js' );
const pak = await import( '../src/pak.js' );
const wad = await import( '../src/wad.js' );

function assertEqual( actual, expected, message ) {

	if ( actual !== expected )
		throw new Error( `${message}: expected ${JSON.stringify( expected )}, got ${JSON.stringify( actual )}` );

}

// A 128x128 conchars sheet where every glyph is solid colour 1, except
// pixel ( 0, 0 ) of each, which is 0 (transparent), and pixel ( 1, 0 ),
// which is 255 (transparent in C after Draw_Init's 0 -> 255 pass)
function solidChars() {

	const chars = new Uint8Array( 128 * 128 ).fill( 1 );
	for ( let y = 0; y < 128; y += 8 )
		for ( let x = 0; x < 128; x += 8 ) {

			chars[ y * 128 + x ] = 0;
			chars[ y * 128 + x + 1 ] = 255;

		}

	return chars;

}

Deno.test( 'G7: Draw_CharToConback copies a glyph as 0x60 + index, skipping 0 and 255', () => {

	const chars = new Uint8Array( 128 * 128 );
	// glyph 'A' (65): row 4, col 1. Mark its ( 2, 3 ) pixel with 5.
	const glyph = ( 4 << 10 ) + ( 1 << 3 );
	chars[ glyph + 3 * 128 + 2 ] = 5;
	chars[ glyph + 7 * 128 + 7 ] = 0xa0; // 0x60 + 0xa0 wraps to 0

	const dest = new Uint8Array( 320 * 16 ).fill( 7 );
	draw.Draw_CharToConback( 65, dest, 320 + 10, chars );

	assertEqual( dest[ 320 + 10 + 3 * 320 + 2 ], 0x65, 'opaque pixel' );
	assertEqual( dest[ 320 + 10 + 7 * 320 + 7 ], 0, 'byte wrap' );
	let changed = 0;
	for ( let i = 0; i < dest.length; i ++ ) if ( dest[ i ] !== 7 ) changed ++;
	assertEqual( changed, 2, 'transparent pixels are left alone' );

} );

Deno.test( 'G7: the version string lands in the conback\'s bottom-right corner', () => {

	const pixels = new Uint8Array( 320 * 200 );
	draw.Draw_ConbackVersion( pixels, 320, 200, solidChars() );

	// "(gl 1.00) 1.09" is 14 characters: columns 197-308, rows 186-193
	const left = 320 - 11 - 8 * 14;
	let minx = 320, maxx = - 1, miny = 200, maxy = - 1;
	for ( let y = 0; y < 200; y ++ )
		for ( let x = 0; x < 320; x ++ )
			if ( pixels[ y * 320 + x ] !== 0 ) {

				assertEqual( pixels[ y * 320 + x ], 0x61, `pixel ( ${x}, ${y} )` );
				minx = Math.min( minx, x ); maxx = Math.max( maxx, x );
				miny = Math.min( miny, y ); maxy = Math.max( maxy, y );

			}

	assertEqual( [ minx, maxx, miny, maxy ].join( ',' ), [ left, 308, 186, 193 ].join( ',' ), 'stamped box' );
	assertEqual( pixels[ 186 * 320 + left ], 0, 'glyph pixel 0 is transparent' );
	assertEqual( pixels[ 186 * 320 + left + 1 ], 0, 'glyph pixel 255 is transparent' );

	// C assumes a 320x200 conback; any other size is left alone
	const other = new Uint8Array( 640 * 400 );
	draw.Draw_ConbackVersion( other, 640, 400, solidChars() );
	assertEqual( other.some( ( v ) => v !== 0 ), false, '640x400 conback untouched' );

} );

Deno.test( 'G7: the shareware conback gets the version stamp and nothing else changes', async () => {

	await pak.COM_AddPakSequence( new URL( '../static/pak0.pak', import.meta.url ).pathname );
	const gfx = pak.COM_FindFile( 'gfx.wad' );
	wad.W_LoadWadFile( gfx.data.slice().buffer );
	const lump = wad.W_GetLumpName( 'conchars' );
	const chars = lump.data.subarray( lump.offset, lump.offset + lump.size );

	const cb = pak.COM_FindFile( 'gfx/conback.lmp' );
	const view = new DataView( cb.data.buffer, cb.data.byteOffset, cb.size );
	assertEqual( view.getInt32( 0, true ) + 'x' + view.getInt32( 4, true ), '320x200', 'conback size' );
	const before = cb.data.slice( 8, 8 + 320 * 200 );
	const pixels = before.slice();
	draw.Draw_ConbackVersion( pixels, 320, 200, chars );

	let changed = 0;
	for ( let i = 0; i < pixels.length; i ++ ) {

		if ( pixels[ i ] === before[ i ] ) continue;
		changed ++;
		const x = i % 320, y = Math.floor( i / 320 );
		if ( x < 197 || x > 308 || y < 186 || y > 193 )
			throw new Error( `pixel ( ${x}, ${y} ) changed outside the version box` );

	}

	if ( changed < 100 ) throw new Error( `only ${changed} pixels stamped` );

} );
