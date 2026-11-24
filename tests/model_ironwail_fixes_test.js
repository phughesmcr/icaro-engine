// Map and model loading fixes taken from QuakeSpasm/Ironwail: truncated vis
// data, unsigned node and clipnode children, clipnode planenum and texture
// lump bounds, and PVS rows sized from the loaded model's leaf count.

// Bootstrap the renderer's existing circular module graph in its safe order.
await import( '../src/gl_rsurf.js' );

const gl_model = await import( '../src/gl_model.js' );
const gl_mesh = await import( '../src/gl_mesh.js' );
const bspfile = await import( '../src/bspfile.js' );
const { COM_AddPack } = await import( '../src/pak.js' );

function assertEqual( actual, expected, message ) {

	if ( actual !== expected )
		throw new Error( `${message}: expected ${expected}, got ${actual}` );

}

function assertThrows( fn, pattern, message ) {

	try {

		fn();

	} catch ( e ) {

		if ( ! pattern.test( e.message ) )
			throw new Error( `${message}: wrong error "${e.message}"` );
		return;

	}

	throw new Error( `${message}: did not throw` );

}

// ----------------------------------------------------------------------------
// Synthetic BSP29 builder
// ----------------------------------------------------------------------------

const SIZEOF_DPLANE = 20;
const SIZEOF_DNODE = 24;
const SIZEOF_DLEAF = 28;
const SIZEOF_DCLIPNODE = 8;
const SIZEOF_DMODEL = 64;

// Lumps default to empty. Each lump given is a Uint8Array.
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

function planesLump( count ) {

	const out = new Uint8Array( count * SIZEOF_DPLANE );
	const view = new DataView( out.buffer );
	for ( let i = 0; i < count; i ++ ) {

		view.setFloat32( i * SIZEOF_DPLANE + ( i % 3 ) * 4, 1, true );	// axial normal
		view.setInt32( i * SIZEOF_DPLANE + 16, i % 3, true );		// PLANE_X/Y/Z

	}

	return out;

}

// nodes: array of [ planenum, child0, child1 ], children as raw uint16 values
function nodesLump( nodes ) {

	const out = new Uint8Array( nodes.length * SIZEOF_DNODE );
	const view = new DataView( out.buffer );
	for ( let i = 0; i < nodes.length; i ++ ) {

		view.setInt32( i * SIZEOF_DNODE, nodes[ i ][ 0 ], true );
		view.setUint16( i * SIZEOF_DNODE + 4, nodes[ i ][ 1 ], true );
		view.setUint16( i * SIZEOF_DNODE + 6, nodes[ i ][ 2 ], true );

	}

	return out;

}

// leaf 0 is solid, the rest empty; no vis, no marksurfaces
function leafsLump( count ) {

	const out = new Uint8Array( count * SIZEOF_DLEAF );
	const view = new DataView( out.buffer );
	for ( let i = 0; i < count; i ++ ) {

		view.setInt32( i * SIZEOF_DLEAF, i === 0 ? - 2 : - 1, true );	// CONTENTS_SOLID / EMPTY
		view.setInt32( i * SIZEOF_DLEAF + 4, - 1, true );		// visofs: none

	}

	return out;

}

// clipnodes: array of [ planenum, child0, child1 ], children as raw uint16
function clipnodesLump( clipnodes ) {

	const out = new Uint8Array( clipnodes.length * SIZEOF_DCLIPNODE );
	const view = new DataView( out.buffer );
	for ( let i = 0; i < clipnodes.length; i ++ ) {

		view.setInt32( i * SIZEOF_DCLIPNODE, clipnodes[ i ][ 0 ], true );
		view.setUint16( i * SIZEOF_DCLIPNODE + 4, clipnodes[ i ][ 1 ], true );
		view.setUint16( i * SIZEOF_DCLIPNODE + 6, clipnodes[ i ][ 2 ], true );

	}

	return out;

}

function modelsLump( visleafs ) {

	const out = new Uint8Array( SIZEOF_DMODEL );
	const view = new DataView( out.buffer );
	for ( let j = 0; j < 3; j ++ ) {

		view.setFloat32( j * 4, - 64, true );
		view.setFloat32( 12 + j * 4, 64, true );

	}

	view.setInt32( 52, visleafs, true );
	return out;

}

function textureLump( nummiptex, entries ) {

	// entries: array of { ofs } (raw dataofs) or { width, height, payload }
	// placed after the directory. payload is how many pixel bytes to store.
	const dirSize = 4 + nummiptex * 4;
	let size = dirSize;
	for ( const e of entries )
		if ( e.width !== undefined ) size += 40 + e.payload;

	const out = new Uint8Array( size );
	const view = new DataView( out.buffer );
	view.setInt32( 0, nummiptex, true );
	let ofs = dirSize;
	for ( let i = 0; i < entries.length; i ++ ) {

		const e = entries[ i ];
		if ( e.width === undefined ) {

			view.setInt32( 4 + i * 4, e.ofs, true );
			continue;

		}

		view.setInt32( 4 + i * 4, ofs, true );
		const name = 'tex' + i;
		for ( let c = 0; c < name.length; c ++ ) out[ ofs + c ] = name.charCodeAt( c );
		view.setUint32( ofs + 16, e.width, true );
		view.setUint32( ofs + 20, e.height, true );
		for ( let p = 0; p < e.payload; p ++ ) out[ ofs + 40 + p ] = 7;
		ofs += 40 + e.payload;

	}

	return out;

}

let pakSerial = 0;

// Puts the BSP in a one-file pack at the front of the search path and loads it.
function loadBsp( bytes ) {

	const name = 'maps/__ironwail_fix_' + ( pakSerial ++ ) + '.bsp';
	COM_AddPack( { files: [ { name: name, filepos: 0, filelen: bytes.length } ], data: bytes.buffer } );
	return gl_model.Mod_ForName( name, true );

}

function minimalLumps( numleafs ) {

	const lumps = [];
	lumps[ bspfile.LUMP_PLANES ] = planesLump( 3 );
	lumps[ bspfile.LUMP_LEAFS ] = leafsLump( numleafs );
	lumps[ bspfile.LUMP_NODES ] = nodesLump( [ [ 0, 0xffff, 0xfffe ] ] );	// leaf 0, leaf 1
	lumps[ bspfile.LUMP_CLIPNODES ] = clipnodesLump( [ [ 0, 0xffff, 0xfffe ] ] );	// -1, -2
	lumps[ bspfile.LUMP_MODELS ] = modelsLump( numleafs - 1 );
	return lumps;

}

// ----------------------------------------------------------------------------
// 1. Mod_DecompressVis on truncated data
// ----------------------------------------------------------------------------

Deno.test( 'Mod_DecompressVis stops at the end of truncated vis data', () => {

	const model = { numleafs: 64, name: 'trunc', viswarn: false };

	// dirty the shared row so stale bits would show
	gl_model.Mod_DecompressVis( null, 0, model );

	// a zero run whose count byte is missing (lump ends after the 0)
	let row = gl_model.Mod_DecompressVis( new Uint8Array( [ 0xaa, 0x00 ] ), 0, model );
	assertEqual( row[ 0 ], 0xaa, 'literal byte before the cut' );
	for ( let i = 1; i < 8; i ++ )
		assertEqual( row[ i ], 0, `byte ${i} after a cut-off run` );
	assertEqual( model.viswarn, true, 'warned once' );

	// literal bytes that stop short of the row
	gl_model.Mod_DecompressVis( null, 0, model );
	row = gl_model.Mod_DecompressVis( new Uint8Array( [ 0x01, 0x02, 0x03 ] ), 1, model );
	assertEqual( row[ 0 ], 0x02, 'first literal' );
	assertEqual( row[ 1 ], 0x03, 'second literal' );
	for ( let i = 2; i < 8; i ++ )
		assertEqual( row[ i ], 0, `byte ${i} past the data` );

	// an offset already past the end of the data
	gl_model.Mod_DecompressVis( null, 0, model );
	row = gl_model.Mod_DecompressVis( new Uint8Array( 4 ), 100, model );
	for ( let i = 0; i < 8; i ++ )
		assertEqual( row[ i ], 0, `byte ${i} for an offset past the data` );

} );

Deno.test( 'Mod_DecompressVis clamps a zero run that overruns the row', () => {

	const model = { numleafs: 16, name: 'overrun', viswarn: false };
	const row = gl_model.Mod_DecompressVis( new Uint8Array( [ 0x00, 0xff, 0x55 ] ), 0, model );
	assertEqual( row[ 0 ], 0, 'first byte' );
	assertEqual( row[ 1 ], 0, 'second byte' );
	assertEqual( model.viswarn, true, 'overrun warned' );

	// a well-formed row decompresses as before
	const ok = { numleafs: 32, name: 'ok', viswarn: false };
	const r2 = gl_model.Mod_DecompressVis( new Uint8Array( [ 0x81, 0x00, 0x02, 0x42 ] ), 0, ok );
	assertEqual( r2[ 0 ], 0x81, 'literal' );
	assertEqual( r2[ 1 ], 0, 'run 1' );
	assertEqual( r2[ 2 ], 0, 'run 2' );
	assertEqual( r2[ 3 ], 0x42, 'literal after run' );
	assertEqual( ok.viswarn, false, 'no warning for good data' );

} );

// ----------------------------------------------------------------------------
// 3. PVS rows sized from the model's leaf count
// ----------------------------------------------------------------------------

Deno.test( 'PVS rows fit maps with more than 8192 leafs', () => {

	const numleafs = 9001;
	const mod = loadBsp( buildBsp( minimalLumps( numleafs ) ) );
	assertEqual( mod.numleafs, numleafs - 1, 'visleafs' );
	const bytes = ( mod.numleafs + 7 ) >> 3;

	const novis = gl_model.Mod_LeafPVS( mod.leafs[ 0 ], mod );
	if ( novis.length < bytes )
		throw new Error( `mod_novis holds ${novis.length} bytes, needs ${bytes}` );
	assertEqual( novis[ bytes - 1 ], 0xff, 'mod_novis last byte' );

	const pvs = gl_model.Mod_LeafPVS( mod.leafs[ numleafs - 1 ], mod );
	if ( pvs.length < bytes )
		throw new Error( `decompressed holds ${pvs.length} bytes, needs ${bytes}` );
	assertEqual( pvs[ bytes - 1 ], 0xff, 'no-vis leaf: last byte visible' );

	// the same row object is reused: no allocation per call
	assertEqual( gl_model.Mod_LeafPVS( mod.leafs[ 1 ], mod ), pvs, 'row reused' );

} );

Deno.test( 'Mod_LoadLeafs rejects more than MAX_MAP_LEAFS leafs', () => {

	assertEqual( bspfile.MAX_MAP_LEAFS, 32767, 'QuakeSpasm BSP29 limit' );
	assertThrows( () => loadBsp( buildBsp( minimalLumps( bspfile.MAX_MAP_LEAFS + 1 ) ) ),
		/leafs exceeds limit/, 'leaf limit' );

} );

// ----------------------------------------------------------------------------
// 2. Unsigned node and clipnode children, clipnode planenum, texture lump
// ----------------------------------------------------------------------------

Deno.test( 'node children are read unsigned', () => {

	// 32770 nodes: the root's front child is node 32769, which a signed
	// short read would take for a leaf.
	const count = 32770;
	const nodes = new Array( count );
	for ( let i = 0; i < count; i ++ ) nodes[ i ] = [ 0, 0xffff, 0xffff ];
	nodes[ 0 ] = [ 0, 32769, 0xfffe ];		// node 32769, leaf 1
	nodes[ 32769 ] = [ 1, 0xfffd, 0x9000 ];	// leaf 2; 65535-0x9000 is no leaf
	const lumps = minimalLumps( 4 );
	lumps[ bspfile.LUMP_NODES ] = nodesLump( nodes );

	const mod = loadBsp( buildBsp( lumps ) );
	assertEqual( mod.nodes[ 0 ].children[ 0 ], mod.nodes[ 32769 ], 'node index past 32767' );
	assertEqual( mod.nodes[ 0 ].children[ 1 ], mod.leafs[ 1 ], 'leaf 1' );
	assertEqual( mod.nodes[ 32769 ].children[ 0 ], mod.leafs[ 2 ], 'leaf 2' );
	assertEqual( mod.nodes[ 32769 ].children[ 1 ], mod.leafs[ 0 ], 'bad leaf index maps to the solid leaf' );
	assertEqual( mod.nodes[ 32769 ].parent, mod.nodes[ 0 ], 'parent set through the far child' );

	// hull 0 keeps the node index rather than wrapping it
	assertEqual( mod.hulls[ 0 ].clipnodes[ 0 ].children[ 0 ], 32769, 'hull 0 child' );

} );

Deno.test( 'clipnode children are read unsigned', () => {

	const count = 32771;
	const clipnodes = new Array( count );
	for ( let i = 0; i < count; i ++ ) clipnodes[ i ] = [ 0, 0xffff, 0xfffe ];
	clipnodes[ 0 ] = [ 0, 32770, 0xfff2 ];	// clipnode 32770, CONTENTS_SKY (-14)
	const lumps = minimalLumps( 2 );
	lumps[ bspfile.LUMP_CLIPNODES ] = clipnodesLump( clipnodes );

	const mod = loadBsp( buildBsp( lumps ) );
	const cn = mod.hulls[ 1 ].clipnodes;
	assertEqual( cn[ 0 ].children[ 0 ], 32770, 'clipnode index past 32767' );
	assertEqual( cn[ 0 ].children[ 1 ], - 14, 'contents stay negative' );
	assertEqual( cn[ 1 ].children[ 0 ], - 1, 'CONTENTS_EMPTY' );
	assertEqual( cn[ 1 ].children[ 1 ], - 2, 'CONTENTS_SOLID' );

} );

Deno.test( 'clipnode planenum is bounds checked', () => {

	for ( const planenum of [ 3, - 1 ] ) {

		const lumps = minimalLumps( 2 );
		lumps[ bspfile.LUMP_CLIPNODES ] = clipnodesLump( [ [ planenum, 0xffff, 0xffff ] ] );
		assertThrows( () => loadBsp( buildBsp( lumps ) ), /planenum out of bounds/, `planenum ${planenum}` );

	}

} );

Deno.test( 'texture lump rejects a miptex count that overruns the lump', () => {

	const lumps = minimalLumps( 2 );
	const counted = new Uint8Array( 8 );	// room for one offset, claims 1000
	new DataView( counted.buffer ).setInt32( 0, 1000, true );
	lumps[ bspfile.LUMP_TEXTURES ] = counted;
	assertThrows( () => loadBsp( buildBsp( lumps ) ), /bad miptex count/, 'nummiptex' );

	const tiny = minimalLumps( 2 );
	tiny[ bspfile.LUMP_TEXTURES ] = new Uint8Array( 2 );
	assertThrows( () => loadBsp( buildBsp( tiny ) ), /funny lump size/, 'short lump' );

} );

Deno.test( 'texture lump skips bad offsets and clamps pixels to the lump', () => {

	const lumps = minimalLumps( 2 );
	lumps[ bspfile.LUMP_TEXTURES ] = textureLump( 5, [
		{ ofs: 1 << 20 },				// far past the lump
		{ ofs: - 8 },					// negative
		{ ofs: - 1 },					// "no texture", as in the C
		{ width: 16, height: 16, payload: 100 },	// pixels run past the lump
		{ width: 0, height: 16, payload: 0 },		// zero sized
	] );

	const mod = loadBsp( buildBsp( lumps ) );
	assertEqual( mod.numtextures, 5, 'numtextures' );
	assertEqual( mod.textures[ 0 ], null, 'offset past the lump' );
	assertEqual( mod.textures[ 1 ], null, 'negative offset' );
	assertEqual( mod.textures[ 2 ], null, '-1 offset' );
	assertEqual( mod.textures[ 4 ], null, 'zero sized' );

	const tx = mod.textures[ 3 ];
	assertEqual( tx.width, 16, 'truncated texture width' );
	assertEqual( tx.pixels.length, 16 * 16 * 85 / 64, 'full mip chain allocated' );
	// the copy stops at the end of the lump, 140 bytes in (its 100 pixel
	// bytes and the next miptex header)
	assertEqual( tx.pixels[ 139 ], 0, 'last byte in the lump' );
	assertEqual( tx.pixels[ 140 ], 0, 'first byte past the lump' );
	assertEqual( tx.pixels[ 0 ], 7, 'copied pixel' );
	assertEqual( tx.pixels[ tx.pixels.length - 1 ], 0, 'pixel past the lump left 0' );

} );

// ----------------------------------------------------------------------------
// 4-6. Limits
// ----------------------------------------------------------------------------

Deno.test( 'alias model limits match QuakeSpasm and gl_mesh.js', () => {

	assertEqual( gl_model.MAXALIASVERTS, 2400, 'MAXALIASVERTS' );
	assertEqual( gl_model.MAXALIASFRAMES, 1024, 'MAXALIASFRAMES' );
	assertEqual( gl_model.MAXALIASTRIS, 4096, 'MAXALIASTRIS' );
	assertEqual( gl_mesh.MAXALIASTRIS, gl_model.MAXALIASTRIS, 'gl_mesh.js copy of MAXALIASTRIS' );
	assertEqual( gl_model.MAX_SURFACE_EXTENTS, 2000, 'surface extents' );

} );
