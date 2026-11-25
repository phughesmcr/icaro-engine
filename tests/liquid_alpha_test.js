// QuakeSpasm's per-liquid alpha: r_lavaalpha, r_slimealpha, r_telealpha
// (0 falls back to r_wateralpha) and the worldspawn _wateralpha keys.

// Bootstrap the renderer's existing circular module graph in its safe order.
const gl_rsurf = await import( '../src/gl_rsurf.js' );
const gl_model = await import( '../src/gl_model.js' );
const { cl } = await import( '../src/client.js' );
const { r_wateralpha, r_novis } = await import( '../src/glquake.js' );
const bspfile = await import( '../src/bspfile.js' );
const { COM_AddPack } = await import( '../src/pak.js' );
const { Con_SetPrintFunctions } = await import( '../src/common.js' );

function assertEqual( actual, expected, message ) {

	if ( actual !== expected )
		throw new Error( `${message}: expected ${expected}, got ${actual}` );

}

const water = { flags: gl_model.SURF_DRAWTURB | gl_model.SURF_DRAWWATER };
const lava = { flags: gl_model.SURF_DRAWTURB | gl_model.SURF_DRAWLAVA };
const slime = { flags: gl_model.SURF_DRAWTURB | gl_model.SURF_DRAWSLIME };
const tele = { flags: gl_model.SURF_DRAWTURB | gl_model.SURF_DRAWTELE };

const ALL_LIQUIDS = gl_model.SURF_DRAWWATER | gl_model.SURF_DRAWLAVA |
	gl_model.SURF_DRAWSLIME | gl_model.SURF_DRAWTELE;

function setCvar( cvar, value ) {

	cvar.value = value;
	cvar.string = String( value );

}

// Runs fn with a fresh world (entities string) and the cvars restored after.
function withWorld( entities, fn ) {

	const cvars = [ r_wateralpha, gl_model.r_lavaalpha, gl_model.r_slimealpha, gl_model.r_telealpha ];
	const saved = cvars.map( ( c ) => c.value );
	const oldWorld = cl.worldmodel;
	try {

		cl.worldmodel = { entities, contentstransparent: ALL_LIQUIDS };
		fn( cl.worldmodel );

	} finally {

		cl.worldmodel = oldWorld;
		cvars.forEach( ( c, i ) => setCvar( c, saved[ i ] ) );

	}

}

Deno.test( 'liquid textures get their SURF_DRAW* flag by name', () => {

	assertEqual( gl_model.Mod_LiquidFlagFromName( '*lava1' ), gl_model.SURF_DRAWLAVA, 'lava' );
	assertEqual( gl_model.Mod_LiquidFlagFromName( '*slime0' ), gl_model.SURF_DRAWSLIME, 'slime' );
	assertEqual( gl_model.Mod_LiquidFlagFromName( '*teleport' ), gl_model.SURF_DRAWTELE, 'tele' );
	assertEqual( gl_model.Mod_LiquidFlagFromName( '*water1' ), gl_model.SURF_DRAWWATER, 'water' );
	assertEqual( gl_model.Mod_LiquidFlagFromName( '*04water' ), gl_model.SURF_DRAWWATER, 'other' );
	for ( const name of [ 'r_lavaalpha', 'r_slimealpha', 'r_telealpha' ] )
		assertEqual( gl_model[ name ].string, '0', name + ' defaults to 0' );

} );

Deno.test( 'by default every liquid uses r_wateralpha, as in GLQuake', () => {

	withWorld( '{\n"classname" "worldspawn"\n}', () => {

		setCvar( r_wateralpha, 1 );
		for ( const s of [ water, lava, slime, tele ] )
			assertEqual( gl_rsurf.GL_WaterAlphaForSurface( s ), 1, 'opaque' );

		setCvar( r_wateralpha, 0.5 );
		for ( const s of [ water, lava, slime, tele ] )
			assertEqual( gl_rsurf.GL_WaterAlphaForSurface( s ), 0.5, 'r_wateralpha' );

	} );

} );

Deno.test( 'per-liquid cvars override r_wateralpha', () => {

	withWorld( '{\n"classname" "worldspawn"\n}', () => {

		setCvar( r_wateralpha, 0.5 );
		setCvar( gl_model.r_lavaalpha, 1 );
		setCvar( gl_model.r_telealpha, 0.25 );
		assertEqual( gl_rsurf.GL_WaterAlphaForSurface( water ), 0.5, 'water' );
		assertEqual( gl_rsurf.GL_WaterAlphaForSurface( lava ), 1, 'lava' );
		assertEqual( gl_rsurf.GL_WaterAlphaForSurface( tele ), 0.25, 'tele' );
		assertEqual( gl_rsurf.GL_WaterAlphaForSurface( slime ), 0.5, 'slime falls back' );

	} );

} );

Deno.test( 'worldspawn keys set the map alpha until a cvar changes', () => {

	setCvar( r_wateralpha, 1 );
	withWorld( '{\n"classname" "worldspawn"\n"_wateralpha" "0.4"\n"lavaalpha" "0.8"\n}\n{\n"wateralpha" "0.1"\n}', () => {

		assertEqual( gl_rsurf.GL_WaterAlphaForSurface( water ), 0.4, '_wateralpha' );
		assertEqual( gl_rsurf.GL_WaterAlphaForSurface( lava ), 0.8, 'lavaalpha' );
		assertEqual( gl_rsurf.GL_WaterAlphaForSurface( slime ), 1, 'slime falls back to r_wateralpha' );

		// setting the cvar overrides the map (QS's cvar callback)
		setCvar( r_wateralpha, 0.6 );
		assertEqual( gl_rsurf.GL_WaterAlphaForSurface( water ), 0.6, 'cvar wins' );
		assertEqual( gl_rsurf.GL_WaterAlphaForSurface( lava ), 0.8, 'lava keeps the map value' );
		assertEqual( gl_rsurf.GL_WaterAlphaForSurface( slime ), 0.6, 'fallback follows the cvar' );

	} );

	// a new map reparses its own worldspawn
	withWorld( '{\n"classname" "worldspawn"\n}', () => {

		setCvar( r_wateralpha, 1 );
		assertEqual( gl_rsurf.GL_WaterAlphaForSurface( water ), 1, 'next map' );

	} );

} );

Deno.test( 'worldspawn keys only apply to liquids the vis sees through', () => {

	setCvar( r_wateralpha, 1 );
	withWorld( '{\n"_wateralpha" "0.4"\n"_lavaalpha" "0.3"\n}', ( world ) => {

		world.contentstransparent = gl_model.SURF_DRAWLAVA;	// water isn't vised
		assertEqual( gl_rsurf.GL_WaterAlphaForSurface( water ), 1, 'unvised water stays opaque' );
		assertEqual( gl_rsurf.GL_WaterAlphaForSurface( lava ), 0.3, 'vised lava' );

	} );

} );

Deno.test( 'a map without entities drops the last map\'s worldspawn alpha', () => {

	setCvar( r_wateralpha, 1 );
	withWorld( '{\n"_wateralpha" "0.4"\n}', () => {

		assertEqual( gl_rsurf.GL_WaterAlphaForSurface( water ), 0.4, 'first map' );

	} );
	withWorld( null, () => {

		assertEqual( gl_rsurf.GL_WaterAlphaForSurface( water ), 1, 'next map has no entities' );

	} );

} );

// ----------------------------------------------------------------------------
// Mod_CheckWaterVis on a tiny BSP: leaf 1 is slime and sees leaf 2 (empty),
// leaves 3 and 4 are lava and see only lava, and there is no water.
// extraLeafs appends leafs past visleafs (as submodels' leafs are), and vis
// replaces the vis lump.
// ----------------------------------------------------------------------------

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

function waterVisBsp( extraLeafs = 0, vis = [ 0x02, 0x04 ] ) {

	const lumps = [];
	lumps[ bspfile.LUMP_PLANES ] = lump( 20, ( v ) => v.setFloat32( 0, 1, true ) );
	// [ contents, visofs ]
	// leaf 4 is lava too and sees only leaf 3 (lava)
	const leafs = [ [ bspfile.CONTENTS_SOLID, - 1 ], [ bspfile.CONTENTS_SLIME, 0 ],
		[ bspfile.CONTENTS_EMPTY, - 1 ], [ bspfile.CONTENTS_LAVA, 1 ], [ bspfile.CONTENTS_LAVA, 1 ] ];
	const visleafs = leafs.length - 1;
	for ( let i = 0; i < extraLeafs; i ++ )
		leafs.push( [ bspfile.CONTENTS_EMPTY, - 1 ] );
	lumps[ bspfile.LUMP_LEAFS ] = lump( leafs.length * 28, ( v ) => leafs.forEach( ( l, i ) => {

		v.setInt32( i * 28, l[ 0 ], true );
		v.setInt32( i * 28 + 4, l[ 1 ], true );

	} ) );
	// leaf 1 sees leaf 2 (bit 1); leaves 3 and 4 see leaf 3 (bit 2)
	lumps[ bspfile.LUMP_VISIBILITY ] = new Uint8Array( vis );
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

		v.setInt32( 52, visleafs, true );

	} );
	return buildBsp( lumps );

}

function loadWaterVisBsp( name, extraLeafs = 0, vis = undefined ) {

	const bytes = waterVisBsp( extraLeafs, vis );
	COM_AddPack( { files: [ { name: name, filepos: 0, filelen: bytes.length } ], data: bytes.buffer } );
	return gl_model.Mod_ForName( name, true );

}

Deno.test( 'Mod_CheckWaterVis finds the liquids the vis sees through', () => {

	const mod = loadWaterVisBsp( 'maps/__watervis.bsp' );
	assertEqual( mod.contentstransparent & gl_model.SURF_DRAWSLIME, gl_model.SURF_DRAWSLIME, 'slime sees out' );
	assertEqual( mod.contentstransparent & gl_model.SURF_DRAWLAVA, 0, 'lava sees only lava' );
	assertEqual( mod.contentstransparent & ( gl_model.SURF_DRAWWATER | gl_model.SURF_DRAWTELE ),
		gl_model.SURF_DRAWWATER | gl_model.SURF_DRAWTELE, 'liquids the map lacks count as see-through' );

} );

// Every map has more leafs than visleafs (submodels' leafs have no vis), so
// a PVS row sized from all the leafs runs on into the next leaf's data. Here
// 17 leafs make a 3-byte row and 4 visleafs a 1-byte one; decoding leaf 1 on
// past its byte reaches leaf 3's data and then a zero run of 9 bytes.
Deno.test( 'Mod_CheckWaterVis sizes PVS rows from visleafs, not all the leafs', () => {

	const printed = [];
	Con_SetPrintFunctions( ( msg ) => printed.push( msg ), () => {} );
	try {

		const mod = loadWaterVisBsp( 'maps/__watervis_rows.bsp', 12, [ 0x02, 0x04, 0x00, 0x09 ] );
		assertEqual( mod.numleafs, 4, 'world numleafs is visleafs' );
		assertEqual( printed.filter( ( m ) => m.includes( 'Mod_DecompressVis' ) ).length, 0, 'vis warnings' );
		assertEqual( mod.viswarn, false, 'viswarn' );
		assertEqual( mod.contentstransparent & gl_model.SURF_DRAWSLIME, gl_model.SURF_DRAWSLIME, 'slime sees out' );
		assertEqual( mod.contentstransparent & gl_model.SURF_DRAWLAVA, 0, 'lava sees only lava' );

	} finally {

		Con_SetPrintFunctions( null, null );

	}

} );

Deno.test( 'Mod_CheckWaterVis with r_novis set counts every liquid as see-through', () => {

	const old = r_novis.value;
	try {

		r_novis.value = 1;
		const mod = loadWaterVisBsp( 'maps/__watervis_novis.bsp' );
		assertEqual( mod.contentstransparent, ALL_LIQUIDS, 'all liquids' );

	} finally {

		r_novis.value = old;

	}

} );
