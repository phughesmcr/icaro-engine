// R_GetAliasMaterial caches by skin texture: a single-frame skin, whose four
// gl_texturenum slots hold one texture (Mod_LoadAllSkins), keeps one material
// as cl.time advances; an animated skin still cycles.

// Bootstrap the renderer's existing circular module graph in its safe order.
await import( '../src/gl_rsurf.js' );

const gl_mesh = await import( '../src/gl_mesh.js' );
const { cl, entity_t } = await import( '../src/client.js' );

function assertEqual( actual, expected, message ) {

	if ( actual !== expected )
		throw new Error( `${message}: expected ${expected}, got ${actual}` );

}

function materialsOverTime( skinGroup, hasLighting ) {

	const paliashdr = { gl_texturenum: [ skinGroup ] };
	const entity = new entity_t();
	entity.model = { flags: 0 };
	const result = [];
	for ( let i = 0; i < 4; i ++ ) {

		cl.time = 1 + i * 0.1 + 0.01;
		result.push( gl_mesh.R_GetAliasMaterial( paliashdr, entity, hasLighting, null ) );

	}

	return result;

}

Deno.test( 'a single-frame alias skin keeps one material across skin frames', () => {

	const oldTime = cl.time;
	try {

		const tex = { id: 1 };
		const lit = materialsOverTime( [ tex, tex, tex, tex ], true );
		for ( let i = 1; i < 4; i ++ )
			assertEqual( lit[ i ], lit[ 0 ], `lit material at frame ${i}` );
		assertEqual( lit[ 0 ].map, tex, 'material uses the skin' );

	} finally {

		cl.time = oldTime;

	}

} );

Deno.test( 'an animated alias skin cycles its materials and keeps lit and unlit apart', () => {

	const oldTime = cl.time;
	try {

		const texs = [ { id: 1 }, { id: 2 }, { id: 3 }, { id: 4 } ];
		const paliashdr = { gl_texturenum: [ texs ] };
		const entity = new entity_t();
		entity.model = { flags: 0 };

		const seen = new Set();
		for ( let i = 0; i < 4; i ++ ) {

			cl.time = 1 + i * 0.1 + 0.01;
			const m = gl_mesh.R_GetAliasMaterial( paliashdr, entity, true, null );
			assertEqual( m.map, texs[ ( Math.floor( cl.time * 10 ) & 3 ) ], `frame ${i} skin` );
			seen.add( m );

		}

		assertEqual( seen.size, 4, 'one material per skin frame' );

		const unlit = gl_mesh.R_GetAliasMaterial( paliashdr, entity, false, null );
		assertEqual( seen.has( unlit ), false, 'unlit material is separate' );

	} finally {

		cl.time = oldTime;

	}

} );
