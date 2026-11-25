// BSP2 map loading (Ironwail Mod_LoadBrushModel and the bsp2 variants of the
// edge, face, marksurface, leaf, node and clipnode loaders). Every map here is
// synthetic: commercial BSP2 data must never be committed.

// Bootstrap the renderer's existing circular module graph in its safe order.
await import( '../src/gl_rsurf.js' );

const gl_model = await import( '../src/gl_model.js' );
const bspfile = await import( '../src/bspfile.js' );
const { COM_AddPack } = await import( '../src/pak.js' );
const { SV_HullPointContents, SV_FindTouchedLeafs } = await import( '../src/world.js' );
const { PM_HullPointContents } = await import( '../src/pmove.js' );
const { edict_t } = await import( '../src/progs.js' );

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
// Synthetic BSP builder: one description, written as BSP29 or BSP2
// ----------------------------------------------------------------------------

function buildBsp( version, lumps ) {

	const header = 4 + bspfile.HEADER_LUMPS * 8;
	let size = header;
	for ( let i = 0; i < bspfile.HEADER_LUMPS; i ++ )
		size += ( lumps[ i ] !== undefined ) ? ( lumps[ i ].length + 3 ) & ~ 3 : 0;

	const bytes = new Uint8Array( size );
	const view = new DataView( bytes.buffer );
	view.setInt32( 0, version, true );

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

function lump( count, size, fill ) {

	const out = new Uint8Array( count * size );
	const view = new DataView( out.buffer );
	for ( let i = 0; i < count; i ++ )
		fill( view, i * size, i );
	return out;

}

// Leaf and node children are given as signed values: >= 0 is a node,
// -1 - n is leaf n. Clipnode children: >= 0 is a clipnode, < 0 contents.
//
// map: {
//   planes: count, vertexes: [ [ x, y, z ] ], edges: [ [ v0, v1 ] ],
//   surfedges: [ int ], texinfo: count,
//   faces: [ { planenum, side, firstedge, numedges, texinfo, styles, lightofs } ],
//   marksurfaces: [ int ],
//   leafs: [ { contents, mins, maxs, firstmark, nummark, ambient } ],
//   nodes: [ { planenum, children, mins, maxs, firstface, numfaces } ],
//   clipnodes: [ [ planenum, child0, child1 ] ], visleafs
// }
function writeMap( bsp2, map ) {

	const L = [];
	L[ bspfile.LUMP_PLANES ] = lump( map.planes, 20, ( v, o, i ) => {

		v.setFloat32( o + ( i % 3 ) * 4, 1, true );	// axial normal
		v.setFloat32( o + 12, i * 8, true );		// dist
		v.setInt32( o + 16, i % 3, true );		// PLANE_X/Y/Z

	} );
	L[ bspfile.LUMP_VERTEXES ] = lump( map.vertexes.length, 12, ( v, o, i ) => {

		for ( let j = 0; j < 3; j ++ ) v.setFloat32( o + j * 4, map.vertexes[ i ][ j ], true );

	} );
	L[ bspfile.LUMP_EDGES ] = lump( map.edges.length, bsp2 ? 8 : 4, ( v, o, i ) => {

		if ( bsp2 ) {

			v.setUint32( o, map.edges[ i ][ 0 ], true );
			v.setUint32( o + 4, map.edges[ i ][ 1 ], true );

		} else {

			v.setUint16( o, map.edges[ i ][ 0 ], true );
			v.setUint16( o + 2, map.edges[ i ][ 1 ], true );

		}

	} );
	L[ bspfile.LUMP_SURFEDGES ] = lump( map.surfedges.length, 4, ( v, o, i ) => v.setInt32( o, map.surfedges[ i ], true ) );
	L[ bspfile.LUMP_TEXINFO ] = lump( map.texinfo, 40, ( v, o ) => {

		v.setFloat32( o, 1, true );		// s = x
		v.setFloat32( o + 16 + 4, 1, true );	// t = y

	} );
	L[ bspfile.LUMP_FACES ] = lump( map.faces.length, bsp2 ? 28 : 20, ( v, o, i ) => {

		const f = map.faces[ i ];
		if ( bsp2 ) {

			v.setInt32( o, f.planenum, true );
			v.setInt32( o + 4, f.side, true );
			v.setInt32( o + 8, f.firstedge, true );
			v.setInt32( o + 12, f.numedges, true );
			v.setInt32( o + 16, f.texinfo, true );
			for ( let j = 0; j < 4; j ++ ) v.setUint8( o + 20 + j, f.styles[ j ] );
			v.setInt32( o + 24, f.lightofs, true );

		} else {

			v.setInt16( o, f.planenum, true );
			v.setInt16( o + 2, f.side, true );
			v.setInt32( o + 4, f.firstedge, true );
			v.setInt16( o + 8, f.numedges, true );
			v.setInt16( o + 10, f.texinfo, true );
			for ( let j = 0; j < 4; j ++ ) v.setUint8( o + 12 + j, f.styles[ j ] );
			v.setInt32( o + 16, f.lightofs, true );

		}

	} );
	L[ bspfile.LUMP_MARKSURFACES ] = lump( map.marksurfaces.length, bsp2 ? 4 : 2, ( v, o, i ) => {

		if ( bsp2 ) v.setUint32( o, map.marksurfaces[ i ], true );
		else v.setUint16( o, map.marksurfaces[ i ], true );

	} );
	L[ bspfile.LUMP_LEAFS ] = lump( map.leafs.length, bsp2 ? 44 : 28, ( v, o, i ) => {

		const l = map.leafs[ i ];
		v.setInt32( o, l.contents, true );
		v.setInt32( o + 4, - 1, true );		// no vis
		for ( let j = 0; j < 3; j ++ ) {

			if ( bsp2 ) {

				v.setFloat32( o + 8 + j * 4, l.mins[ j ], true );
				v.setFloat32( o + 20 + j * 4, l.maxs[ j ], true );

			} else {

				v.setInt16( o + 8 + j * 2, l.mins[ j ], true );
				v.setInt16( o + 14 + j * 2, l.maxs[ j ], true );

			}

		}

		if ( bsp2 ) {

			v.setUint32( o + 32, l.firstmark, true );
			v.setUint32( o + 36, l.nummark, true );

		} else {

			v.setUint16( o + 20, l.firstmark, true );
			v.setUint16( o + 22, l.nummark, true );

		}

		for ( let j = 0; j < 4; j ++ ) v.setUint8( o + ( bsp2 ? 40 : 24 ) + j, l.ambient[ j ] );

	} );
	L[ bspfile.LUMP_NODES ] = lump( map.nodes.length, bsp2 ? 44 : 24, ( v, o, i ) => {

		const n = map.nodes[ i ];
		v.setInt32( o, n.planenum, true );
		for ( let j = 0; j < 2; j ++ ) {

			if ( bsp2 ) v.setInt32( o + 4 + j * 4, n.children[ j ], true );
			else v.setInt16( o + 4 + j * 2, n.children[ j ], true );

		}

		for ( let j = 0; j < 3; j ++ ) {

			if ( bsp2 ) {

				v.setFloat32( o + 12 + j * 4, n.mins[ j ], true );
				v.setFloat32( o + 24 + j * 4, n.maxs[ j ], true );

			} else {

				v.setInt16( o + 8 + j * 2, n.mins[ j ], true );
				v.setInt16( o + 14 + j * 2, n.maxs[ j ], true );

			}

		}

		if ( bsp2 ) {

			v.setUint32( o + 36, n.firstface, true );
			v.setUint32( o + 40, n.numfaces, true );

		} else {

			v.setUint16( o + 20, n.firstface, true );
			v.setUint16( o + 22, n.numfaces, true );

		}

	} );
	L[ bspfile.LUMP_CLIPNODES ] = lump( map.clipnodes.length, bsp2 ? 12 : 8, ( v, o, i ) => {

		const c = map.clipnodes[ i ];
		v.setInt32( o, c[ 0 ], true );
		for ( let j = 0; j < 2; j ++ ) {

			if ( bsp2 ) v.setInt32( o + 4 + j * 4, c[ 1 + j ], true );
			else v.setInt16( o + 4 + j * 2, c[ 1 + j ], true );

		}

	} );
	L[ bspfile.LUMP_MODELS ] = lump( 1, 64, ( v, o ) => {

		for ( let j = 0; j < 3; j ++ ) {

			v.setFloat32( o + j * 4, - 64, true );
			v.setFloat32( o + 12 + j * 4, 64, true );

		}

		v.setInt32( o + 52, map.visleafs, true );
		v.setInt32( o + 60, map.faces.length, true );

	} );
	return buildBsp( bsp2 ? bspfile.BSP2VERSION_BSP2 : bspfile.BSPVERSION, L );

}

let pakSerial = 0;

function loadBsp( bytes ) {

	const name = 'maps/__bsp2_' + ( pakSerial ++ ) + '.bsp';
	COM_AddPack( { files: [ { name: name, filepos: 0, filelen: bytes.length } ], data: bytes.buffer } );
	return gl_model.Mod_ForName( name, true );

}

// A small map that fits both formats: a square face and a triangle, two
// nodes over three leafs (one of them water), and a two-node clip hull.
function smallMap() {

	return {
		planes: 3,
		vertexes: [ [ 0, 0, 0 ], [ 64, 0, 0 ], [ 64, 64, 0 ], [ 0, 64, 0 ], [ 32, 96, 16 ] ],
		edges: [ [ 0, 0 ], [ 0, 1 ], [ 1, 2 ], [ 2, 3 ], [ 3, 0 ], [ 2, 4 ], [ 4, 3 ] ],
		surfedges: [ 1, 2, 3, 4, - 3, 5, 6 ],
		texinfo: 1,
		faces: [
			{ planenum: 2, side: 0, firstedge: 0, numedges: 4, texinfo: 0, styles: [ 0, 1, 255, 255 ], lightofs: - 1 },
			{ planenum: 1, side: 1, firstedge: 4, numedges: 3, texinfo: 0, styles: [ 5, 255, 255, 255 ], lightofs: 64 },
		],
		marksurfaces: [ 0, 1, 1 ],
		leafs: [
			{ contents: bspfile.CONTENTS_SOLID, mins: [ 0, 0, 0 ], maxs: [ 0, 0, 0 ], firstmark: 0, nummark: 0, ambient: [ 0, 0, 0, 0 ] },
			{ contents: bspfile.CONTENTS_EMPTY, mins: [ - 64, - 64, - 32 ], maxs: [ 0, 64, 32 ], firstmark: 0, nummark: 2, ambient: [ 1, 2, 3, 4 ] },
			{ contents: bspfile.CONTENTS_WATER, mins: [ 0, - 64, - 32 ], maxs: [ 64, 64, 32 ], firstmark: 2, nummark: 1, ambient: [ 9, 0, 0, 7 ] },
		],
		nodes: [
			{ planenum: 0, children: [ 1, - 1 - 1 ], mins: [ - 64, - 64, - 32 ], maxs: [ 64, 64, 32 ], firstface: 0, numfaces: 1 },
			{ planenum: 1, children: [ - 1 - 2, - 1 - 0 ], mins: [ 0, - 64, - 32 ], maxs: [ 64, 64, 32 ], firstface: 1, numfaces: 1 },
		],
		clipnodes: [ [ 0, 1, bspfile.CONTENTS_EMPTY ], [ 1, bspfile.CONTENTS_WATER, bspfile.CONTENTS_SOLID ] ],
		visleafs: 2,
	};

}

// Indexes of a loaded model's objects, for comparing two loads
function describe( mod ) {

	const planeIdx = new Map( mod.planes.map( ( p, i ) => [ p, i ] ) );
	const nodeIdx = new Map( mod.nodes.map( ( n, i ) => [ n, i ] ) );
	const leafIdx = new Map( mod.leafs.map( ( l, i ) => [ l, i ] ) );
	const surfIdx = new Map( mod.surfaces.map( ( s, i ) => [ s, i ] ) );
	const ref = ( n ) => n === null ? null : ( nodeIdx.has( n ) ? 'n' + nodeIdx.get( n ) : 'l' + leafIdx.get( n ) );
	return JSON.stringify( {
		edges: mod.edges.map( ( e ) => Array.from( e.v ) ),
		surfaces: mod.surfaces.map( ( s ) => [ s.firstedge, s.numedges, s.flags, planeIdx.get( s.plane ),
			mod.texinfo.indexOf( s.texinfo ), Array.from( s.styles ), s.samples === null ? null : s.sampleOffset,
			Array.from( s.texturemins ), Array.from( s.extents ) ] ),
		marksurfaces: mod.marksurfaces.map( ( s ) => surfIdx.get( s ) ),
		leafs: mod.leafs.map( ( l ) => [ l.contents, ref( l.parent ), Array.from( l.minmaxs ), l.nummarksurfaces,
			l.firstmarksurface.map( ( s ) => surfIdx.get( s ) ), Array.from( l.ambient_sound_level ) ] ),
		nodes: mod.nodes.map( ( n ) => [ planeIdx.get( n.plane ), ref( n.children[ 0 ] ), ref( n.children[ 1 ] ),
			ref( n.parent ), Array.from( n.minmaxs ), n.firstsurface, n.numsurfaces ] ),
		hulls: [ 0, 1, 2 ].map( ( h ) => mod.hulls[ h ].clipnodes.map( ( c ) => [ c.planenum, c.children[ 0 ], c.children[ 1 ] ] ) ),
	} );

}

// ----------------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------------

Deno.test( 'BSP2VERSION_BSP2 is the "BSP2" magic', () => {

	const bytes = new Uint8Array( 4 );
	new DataView( bytes.buffer ).setInt32( 0, bspfile.BSP2VERSION_BSP2, true );
	assertEqual( new TextDecoder().decode( bytes ), 'BSP2', 'magic' );

} );

Deno.test( 'the same map loads identically from BSP29 and BSP2', () => {

	const a = loadBsp( writeMap( false, smallMap() ) );
	const da = describe( a );
	const b = loadBsp( writeMap( true, smallMap() ) );
	const db = describe( b );
	assertEqual( db, da, 'loaded structures' );

	// and the BSP2 load has the values the map describes
	assertEqual( b.numsurfaces, 2, 'faces' );
	assertEqual( b.surfaces[ 1 ].flags & gl_model.SURF_PLANEBACK, gl_model.SURF_PLANEBACK, 'side 1' );
	assertEqual( b.surfaces[ 1 ].styles[ 0 ], 5, 'styles' );
	assertEqual( b.surfaces[ 1 ].sampleOffset, 64, 'lightofs' );
	assertEqual( b.surfaces[ 0 ].numedges, 4, 'numedges' );
	assertEqual( b.leafs[ 2 ].ambient_sound_level[ 3 ], 7, 'ambient level' );
	assertEqual( b.leafs[ 2 ].firstmarksurface[ 0 ], b.surfaces[ 1 ], 'marksurface' );
	assertEqual( b.surfaces[ 1 ].flags & gl_model.SURF_UNDERWATER, gl_model.SURF_UNDERWATER, 'underwater from the water leaf' );
	assertEqual( b.nodes[ 0 ].children[ 0 ], b.nodes[ 1 ], 'node child' );
	assertEqual( b.nodes[ 1 ].children[ 1 ], b.leafs[ 0 ], 'leaf 0 child' );
	assertEqual( b.hulls[ 1 ].clipnodes[ 1 ].children[ 0 ], bspfile.CONTENTS_WATER, 'clipnode contents' );

} );

Deno.test( 'BSP2 reads node bounds as floats past the short range', () => {

	const map = smallMap();
	map.nodes[ 0 ].mins = [ - 40000.5, - 64, - 32 ];
	map.nodes[ 0 ].maxs = [ 40000.25, 64, 32 ];
	map.leafs[ 1 ].mins = [ - 50000, - 64, - 32 ];
	map.leafs[ 1 ].maxs = [ 0, 70000, 32 ];
	const mod = loadBsp( writeMap( true, map ) );
	assertEqual( mod.nodes[ 0 ].minmaxs[ 0 ], - 40000.5, 'node mins' );
	assertEqual( mod.nodes[ 0 ].minmaxs[ 3 ], 40000.25, 'node maxs' );
	assertEqual( mod.leafs[ 1 ].minmaxs[ 0 ], - 50000, 'leaf mins' );
	assertEqual( mod.leafs[ 1 ].minmaxs[ 4 ], 70000, 'leaf maxs' );

} );

Deno.test( 'BSP2 node children past 16 bits, and bad children map to the solid leaf', () => {

	// 70000 nodes: the root's front child is node 69999
	const map = smallMap();
	const count = 70000;
	const filler = { planenum: 0, children: [ - 1, - 1 ], mins: [ 0, 0, 0 ], maxs: [ 0, 0, 0 ], firstface: 0, numfaces: 0 };
	map.nodes = new Array( count ).fill( filler );
	map.nodes[ 0 ] = { ...filler, children: [ count - 1, - 1 - 1 ] };
	// leaf 2; then a leaf index past the leafs, which maps to leaf 0
	map.nodes[ count - 1 ] = { ...filler, planenum: 1, children: [ - 1 - 2, - 1 - 5 ] };
	// child 0 is never a node in BSP2 (Ironwail Mod_LoadNodes_L2 tests p > 0)
	map.nodes[ 1 ] = { ...filler, children: [ 0, count ] };

	const mod = loadBsp( writeMap( true, map ) );
	assertEqual( mod.nodes[ 0 ].children[ 0 ], mod.nodes[ count - 1 ], 'node index past 65535' );
	assertEqual( mod.nodes[ 0 ].children[ 1 ], mod.leafs[ 1 ], 'leaf 1' );
	assertEqual( mod.nodes[ count - 1 ].children[ 0 ], mod.leafs[ 2 ], 'leaf 2' );
	assertEqual( mod.nodes[ count - 1 ].children[ 1 ], mod.leafs[ 0 ], 'leaf index past the leafs' );
	assertEqual( mod.nodes[ count - 1 ].parent, mod.nodes[ 0 ], 'parent set through the far child' );
	assertEqual( mod.nodes[ 1 ].children[ 0 ], mod.leafs[ 0 ], 'child 0 is the solid leaf' );
	assertEqual( mod.nodes[ 1 ].children[ 1 ], mod.leafs[ 0 ], 'child past the nodes is a bad leaf' );

	// hull 0 keeps the node index
	assertEqual( mod.hulls[ 0 ].clipnodes[ 0 ].children[ 0 ], count - 1, 'hull 0 child' );

} );

Deno.test( 'BSP2 clipnode children past 16 bits work in world.js and pmove.js', () => {

	// clipnode 0 splits on x = 0 (plane 0): front goes to clipnode 69999,
	// back is empty; 69999 splits on y = 8 (plane 1): front water, back solid
	const map = smallMap();
	const count = 70000;
	map.clipnodes = new Array( count ).fill( [ 0, bspfile.CONTENTS_EMPTY, bspfile.CONTENTS_EMPTY ] );
	map.clipnodes[ 0 ] = [ 0, count - 1, bspfile.CONTENTS_EMPTY ];
	map.clipnodes[ count - 1 ] = [ 1, bspfile.CONTENTS_WATER, bspfile.CONTENTS_SOLID ];

	const mod = loadBsp( writeMap( true, map ) );
	const hull = mod.hulls[ 1 ];
	assertEqual( hull.clipnodes[ 0 ].children[ 0 ], count - 1, 'clipnode index past 65535' );
	assertEqual( hull.lastclipnode, count - 1, 'lastclipnode' );

	const cases = [
		[ [ 10, 20, 0 ], bspfile.CONTENTS_WATER ],
		[ [ 10, 0, 0 ], bspfile.CONTENTS_SOLID ],
		[ [ - 10, 20, 0 ], bspfile.CONTENTS_EMPTY ],
	];
	for ( const [ p, contents ] of cases ) {

		const v = new Float32Array( p );
		assertEqual( SV_HullPointContents( hull, 0, v ), contents, `SV_HullPointContents ${p}` );
		assertEqual( PM_HullPointContents( hull, 0, v ), contents, `PM_HullPointContents ${p}` );

	}

} );

Deno.test( 'BSP2 edge vertex numbers and marksurfaces past 16 bits', () => {

	const map = smallMap();
	const far = 70000;
	while ( map.vertexes.length <= far ) map.vertexes.push( [ 0, 0, 0 ] );
	map.vertexes[ far ] = [ 128, 128, 0 ];
	// a triangle through vertexes 2 (64, 64), far (128, 128) and 1 (64, 0)
	map.edges.push( [ 2, far ], [ far, 1 ], [ 1, 2 ] );
	map.surfedges.push( 7, 8, 9 );
	// enough faces that a marksurface needs more than 16 bits
	const face = { planenum: 2, side: 0, firstedge: 7, numedges: 3, texinfo: 0, styles: [ 0, 255, 255, 255 ], lightofs: - 1 };
	while ( map.faces.length <= far ) map.faces.push( face );
	map.marksurfaces = [ 0, 1, far, 1 ];
	map.leafs[ 1 ].nummark = 3;
	map.leafs[ 2 ].firstmark = 3;

	const mod = loadBsp( writeMap( true, map ) );
	assertEqual( mod.edges[ 7 ].v[ 1 ], far, 'edge vertex past 65535' );
	assertEqual( mod.leafs[ 1 ].firstmarksurface[ 2 ], mod.surfaces[ far ], 'marksurface past 65535' );
	// CalcSurfaceExtents went through the far vertex: x runs 64..128
	assertEqual( mod.surfaces[ far ].texturemins[ 0 ], 64, 'texturemins from the far vertex' );
	assertEqual( mod.surfaces[ far ].extents[ 0 ], 64, 'extents from the far vertex' );

} );

Deno.test( 'BSP2 has no leaf limit, BSP29 keeps MAX_MAP_LEAFS', () => {

	const map = smallMap();
	const count = bspfile.MAX_MAP_LEAFS + 8;
	const empty = map.leafs[ 1 ];
	while ( map.leafs.length < count ) map.leafs.push( { ...empty, nummark: 0 } );
	map.visleafs = count - 1;
	const far = count - 1;
	map.nodes[ 1 ].children = [ - 1 - far, - 1 - 0 ];

	assertThrows( () => loadBsp( writeMap( false, map ) ), /leafs exceeds limit/, 'BSP29 limit' );

	const mod = loadBsp( writeMap( true, map ) );
	assertEqual( mod.leafs.length, count, 'leafs' );
	assertEqual( mod.nodes[ 1 ].children[ 0 ], mod.leafs[ far ], 'leaf past 32767' );

	// an edict touching that leaf keeps its number (edict_t.leafnums is int)
	const ent = new edict_t( 1, 0 );
	ent.v = { absmin: new Float32Array( [ 8, 16, - 8 ] ), absmax: new Float32Array( [ 12, 20, 8 ] ) };
	SV_FindTouchedLeafs( ent, mod.nodes[ 0 ] );
	assertEqual( ent.num_leafs, 1, 'one leaf touched' );
	assertEqual( ent.leafnums[ 0 ], far - 1, 'leaf number past 32767' );

} );

Deno.test( 'BSP2 lump sizes are checked against the BSP2 structs', () => {

	const bytes = writeMap( true, smallMap() );
	// cut the clipnode lump to a BSP29 clipnode's size
	const view = new DataView( bytes.buffer );
	view.setInt32( 4 + bspfile.LUMP_CLIPNODES * 8 + 4, 8, true );
	assertThrows( () => loadBsp( bytes ), /funny lump size/, 'clipnodes' );

} );

Deno.test( 'other BSP versions are refused', () => {

	const bytes = writeMap( false, smallMap() );
	new DataView( bytes.buffer ).setInt32( 0, 30, true );
	assertThrows( () => loadBsp( bytes ), /unsupported version number \(30\)/, 'version 30' );

	// RMQ's 2PSB isn't supported
	new DataView( bytes.buffer ).setInt32( 0, 0x42535032, true );
	assertThrows( () => loadBsp( bytes ), /unsupported version number/, '2PSB' );

} );
