// Bootstrap the renderer's existing circular module graph in its safe order.
await import( '../src/gl_rsurf.js' );

const THREE = await import( 'three' );
const { cl } = await import( '../src/client.js' );
const glquake = await import( '../src/glquake.js' );
const {
	R_InitParticles, R_SetParticleExternals, R_ClearParticles,
	R_ParticleExplosion, R_DrawParticles, R_MarkParticleUpload
} = await import( '../src/r_part.js' );

function assertEqual( actual, expected, message ) {

	if ( actual !== expected )
		throw new Error( `${message}: expected ${expected}, got ${actual}` );

}

Deno.test( 'the particle pool holds Ironwail\'s 16384 particles', () => {

	const oldTime = cl.time;
	const oldOldtime = cl.oldtime;
	const oldTextures = glquake._allGameTextures.slice();
	const scene = new THREE.Scene();

	try {

		R_InitParticles();
		R_SetParticleExternals( { scene: scene } );
		cl.time = 10;
		cl.oldtime = 10;

		// Each explosion takes 1024 particles; id's 2048 held only two
		const org = new Float32Array( 3 );
		for ( let i = 0; i < 17; i ++ ) R_ParticleExplosion( org );

		R_DrawParticles();
		const geometry = scene.children[ 0 ].geometry;
		assertEqual( geometry.drawRange.count, 16384, 'live particles after 17 explosions' );

	} finally {

		R_ClearParticles();
		R_DrawParticles();
		cl.time = oldTime;
		cl.oldtime = oldOldtime;
		glquake._allGameTextures.splice(
			0, glquake._allGameTextures.length, ...oldTextures
		);

	}

} );

Deno.test( 'R_MarkParticleUpload uploads only the live particles', () => {

	const ranges = [];
	const attribute = {
		itemSize: 3,
		needsUpdate: false,
		clearUpdateRanges() {

			ranges.length = 0;

		},
		addUpdateRange( start, count ) {

			ranges.push( [ start, count ] );

		}
	};

	R_MarkParticleUpload( attribute, 10 );
	R_MarkParticleUpload( attribute, 25 );
	assertEqual( ranges.length, 1, 'one range' );
	assertEqual( ranges[ 0 ][ 0 ], 0, 'range start' );
	assertEqual( ranges[ 0 ][ 1 ], 75, 'range length in floats' );
	assertEqual( attribute.needsUpdate, true, 'needsUpdate' );

	// The server shim has no update ranges
	const plain = { itemSize: 3, needsUpdate: false };
	R_MarkParticleUpload( plain, 5 );
	assertEqual( plain.needsUpdate, true, 'plain attribute needsUpdate' );

} );
