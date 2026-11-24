// GL cvars that GLQuake reads at texture upload and in R_SetupGL:
// gl_picmip, gl_max_size, gl_playermip (gl_draw.c GL_Upload32,
// gl_rmisc.c R_TranslatePlayerSkin) and gl_cull (gl_rmain.c R_SetupGL).

import * as THREE from 'three';

// Bootstrap the renderer's existing circular module graph in its safe order.
await import( '../src/gl_rsurf.js' );

const {
	gl_picmip, gl_max_size, gl_playermip, gl_cull,
	GL_ScaledTextureSize, GL_ResampleTexture8,
	GL_RegisterCullMaterial, GL_UpdateCull
} = await import( '../src/glquake.js' );
const gl_rmisc = await import( '../src/gl_rmisc.js' );
const { mod_alias } = await import( '../src/gl_rmain.js' );
const { cl, cl_entities } = await import( '../src/client.js' );

function assertEqual( actual, expected, message ) {

	if ( actual !== expected )
		throw new Error( `${message}: expected ${expected}, got ${actual}` );

}

function withCvars( values, fn ) {

	const saved = values.map( ( [ cvar ] ) => [ cvar, cvar.value, cvar.string ] );
	try {

		for ( const [ cvar, value ] of values ) {

			cvar.value = value;
			cvar.string = String( value );

		}

		fn();

	} finally {

		for ( const [ cvar, value, string ] of saved ) {

			cvar.value = value;
			cvar.string = string;

		}

	}

}

Deno.test( 'GL_ScaledTextureSize leaves defaults alone', () => {

	const s = GL_ScaledTextureSize( 64, 32 );
	assertEqual( s.width, 64, 'width' );
	assertEqual( s.height, 32, 'height' );

} );

Deno.test( 'GL_ScaledTextureSize shifts by gl_picmip, clamps to gl_max_size, floors at 1', () => {

	withCvars( [ [ gl_picmip, 1 ] ], () => {

		const s = GL_ScaledTextureSize( 64, 32 );
		assertEqual( s.width, 32, 'picmip 1 width' );
		assertEqual( s.height, 16, 'picmip 1 height' );

	} );

	withCvars( [ [ gl_picmip, 0 ], [ gl_max_size, 16 ] ], () => {

		const s = GL_ScaledTextureSize( 64, 8 );
		assertEqual( s.width, 16, 'max_size width' );
		assertEqual( s.height, 8, 'max_size leaves smaller side' );

	} );

	withCvars( [ [ gl_picmip, 10 ] ], () => {

		const s = GL_ScaledTextureSize( 64, 32 );
		assertEqual( s.width, 1, 'floored width' );
		assertEqual( s.height, 1, 'floored height' );

	} );

} );

Deno.test( 'GL_ResampleTexture8 point-samples like GL_ResampleTexture', () => {

	// 4x2 source, halved to 2x1: C picks the second texel of each pair
	// (frac starts at fracstep / 2) from row 0.
	const src = new Uint8Array( [ 10, 11, 12, 13, 20, 21, 22, 23 ] );
	const out = GL_ResampleTexture8( src, 4, 2, 2, 1 );
	assertEqual( out.length, 2, 'length' );
	assertEqual( out[ 0 ], 11, 'texel 0' );
	assertEqual( out[ 1 ], 13, 'texel 1' );

} );

Deno.test( 'gl_cull switches registered materials between FrontSide and DoubleSide', () => {

	const material = GL_RegisterCullMaterial( new THREE.MeshBasicMaterial() );
	assertEqual( material.side, THREE.FrontSide, 'default side' );

	withCvars( [ [ gl_cull, 0 ] ], () => {

		GL_UpdateCull();
		assertEqual( material.side, THREE.DoubleSide, 'gl_cull 0' );

		const late = GL_RegisterCullMaterial( new THREE.MeshBasicMaterial() );
		assertEqual( late.side, THREE.DoubleSide, 'registered while gl_cull 0' );
		late.dispose();

	} );

	GL_UpdateCull();
	assertEqual( material.side, THREE.FrontSide, 'gl_cull restored' );

	material.dispose();
	withCvars( [ [ gl_cull, 0 ] ], () => {

		GL_UpdateCull();
		assertEqual( material.side, THREE.FrontSide, 'disposed material left alone' );

	} );
	GL_UpdateCull();

} );

Deno.test( 'player skin translation honours gl_max_size and gl_playermip', () => {

	const oldScores = cl.scores;
	const oldModel = cl_entities[ 1 ].model;
	const oldSkinNum = cl_entities[ 1 ].skinnum;

	try {

		cl.scores = [ { colors: 0 } ];
		cl_entities[ 1 ].skinnum = 0;
		cl_entities[ 1 ].model = {
			type: mod_alias,
			cache: { data: {
				numskins: 1, skinwidth: 296, skinheight: 194,
				texels: [ new Uint8Array( 296 * 194 ) ]
			} }
		};

		const sizeOf = () => {

			gl_rmisc.R_TranslatePlayerSkin( 0 );
			const tex = gl_rmisc.R_GetPlayerSkinTexture( 0 );
			return [ tex.image.width, tex.image.height ];

		};

		let [ w, h ] = sizeOf();
		assertEqual( w, 296, 'default width' );
		assertEqual( h, 194, 'default height' );

		withCvars( [ [ gl_playermip, 1 ] ], () => {

			[ w, h ] = sizeOf();
			assertEqual( w, 148, 'playermip width' );
			assertEqual( h, 97, 'playermip height' );

		} );

		withCvars( [ [ gl_max_size, 128 ] ], () => {

			[ w, h ] = sizeOf();
			assertEqual( w, 128, 'max_size width' );
			assertEqual( h, 128, 'max_size height' );

		} );

	} finally {

		cl.scores = oldScores;
		cl_entities[ 1 ].model = oldModel;
		cl_entities[ 1 ].skinnum = oldSkinNum;

	}

} );
