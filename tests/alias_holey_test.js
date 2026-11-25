// MF_HOLEY (MarkV/QSS, QuakeSpasm, Ironwail): a model flag that makes
// palette index 255 transparent in an mdl's skins, alpha-tested at 0.666.

// Bootstrap the renderer's existing circular module graph in its safe order.
await import( '../src/gl_rsurf.js' );

const gl_model = await import( '../src/gl_model.js' );
const gl_mesh = await import( '../src/gl_mesh.js' );
const { entity_t } = await import( '../src/client.js' );
const { COM_AddPack } = await import( '../src/pak.js' );

function assertEqual( actual, expected, message ) {

	if ( actual !== expected )
		throw new Error( `${message}: expected ${expected}, got ${actual}` );

}

// A one-frame, one-triangle MDL with a single 8x8 skin of the given pixels.
function buildMdl( skin, flags ) {

	const numverts = 3;
	const size = 84 + 4 + 64 + numverts * 12 + 16 + 4 + 24 + numverts * 4;
	const bytes = new Uint8Array( size );
	const view = new DataView( bytes.buffer );
	view.setUint32( 0, gl_model.IDPOLYHEADER, true );
	view.setInt32( 4, gl_model.ALIAS_VERSION, true );
	for ( let i = 0; i < 3; i ++ ) view.setFloat32( 8 + i * 4, 1, true );	// scale
	view.setInt32( 48, 1, true );		// numskins
	view.setInt32( 52, 8, true );		// skinwidth
	view.setInt32( 56, 8, true );		// skinheight
	view.setInt32( 60, numverts, true );
	view.setInt32( 64, 1, true );		// numtris
	view.setInt32( 68, 1, true );		// numframes
	view.setInt32( 76, flags, true );
	view.setFloat32( 80, 1, true );		// size

	let pos = 84 + 4;			// ALIAS_SKIN_SINGLE
	bytes.set( skin, pos );
	pos += 64;
	for ( let i = 0; i < numverts; i ++, pos += 12 ) {

		view.setInt32( pos + 4, i * 2, true );
		view.setInt32( pos + 8, i, true );

	}

	view.setInt32( pos, 1, true );		// facesfront
	for ( let j = 0; j < 3; j ++ ) view.setInt32( pos + 4 + j * 4, j, true );
	pos += 16;
	view.setInt32( pos, gl_model.ALIAS_SINGLE, true );
	pos += 4 + 24;
	bytes[ pos + 4 ] = 4;
	bytes[ pos + 9 ] = 4;
	return bytes;

}

let serial = 0;

function load( flags ) {

	const skin = new Uint8Array( 64 ).fill( 15 );
	skin[ 9 ] = 255;
	const bytes = buildMdl( skin, flags );
	const name = 'progs/__holey_' + ( serial ++ ) + '.mdl';
	COM_AddPack( { files: [ { name: name, filepos: 0, filelen: bytes.length } ], data: bytes.buffer } );
	const mod = gl_model.Mod_ForName( name, true );
	const hdr = gl_model.Mod_Extradata( mod );
	const e = new entity_t();
	e.model = mod;
	return { mod, hdr, e };

}

Deno.test( 'MF_HOLEY skins make index 255 transparent and alpha-test it', () => {

	assertEqual( gl_model.MF_HOLEY, 1 << 14, 'MF_HOLEY' );

	const holey = load( gl_model.MF_HOLEY );
	assertEqual( ( holey.mod.flags & gl_model.MF_HOLEY ) !== 0, true, 'flag kept after Mod_SetExtraFlags' );
	const texture = holey.hdr.gl_texturenum[ 0 ][ 0 ];
	assertEqual( texture.image.data[ 9 * 4 + 3 ], 0, 'index 255 is transparent' );
	assertEqual( texture.image.data[ 8 * 4 + 3 ], 255, 'other pixels are opaque' );
	assertEqual( gl_mesh.R_GetAliasMaterial( holey.hdr, holey.e, true, null ).alphaTest, 0.666, 'alpha test' );
	const player = gl_mesh.R_GetAliasMaterial( holey.hdr, holey.e, true, { isTexture: true } );
	assertEqual( player.alphaTest, 0.666, 'player alpha test' );

	// id's models: index 255 stays opaque, no alpha test
	const plain = load( 0 );
	assertEqual( plain.hdr.gl_texturenum[ 0 ][ 0 ].image.data[ 9 * 4 + 3 ], 255, 'opaque without the flag' );
	assertEqual( gl_mesh.R_GetAliasMaterial( plain.hdr, plain.e, true, null ).alphaTest, 0, 'no alpha test' );

} );

Deno.test( 'r_lerpmodels materials follow their base alpha test', () => {

	const holey = load( gl_model.MF_HOLEY );
	const plain = load( 0 );
	const holeyBase = gl_mesh.R_GetAliasMaterial( holey.hdr, holey.e, true, null );
	const plainBase = gl_mesh.R_GetAliasMaterial( plain.hdr, plain.e, true, null );

	// the Deno three shim has no Color.copy: stub it
	const colorProto = Object.getPrototypeOf( holeyBase.color );
	const hadCopy = Object.hasOwn( colorProto, 'copy' );
	const oldCopy = colorProto.copy;
	colorProto.copy = function () {

		return this;

	};
	try {

		const e = new entity_t();
		assertEqual( gl_mesh.R_GetAliasLerpMaterial( e, holeyBase, 0.5 ).alphaTest, 0.666, 'holey lerp' );
		assertEqual( gl_mesh.R_GetAliasLerpMaterial( e, plainBase, 0.5 ).alphaTest, 0, 'plain lerp' );

	} finally {

		if ( hadCopy ) colorProto.copy = oldCopy;
		else delete colorProto.copy;

	}

} );
