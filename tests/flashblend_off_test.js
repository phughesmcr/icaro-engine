// Switching gl_flashblend from 1 to 0 must take the PointLights that
// R_RenderDlights added out of the scene; C draws nothing at 0.

// Bootstrap the renderer's existing circular module graph in its safe order.
await import( '../src/gl_rsurf.js' );

const glquake = await import( '../src/glquake.js' );
const gl_rlight = await import( '../src/gl_rlight.js' );
const THREE = await import( 'three' );
const { cl, cl_dlights } = await import( '../src/client.js' );

function assertEqual( actual, expected, message ) {

	if ( actual !== expected )
		throw new Error( `${message}: expected ${expected}, got ${actual}` );

}

function pointLights( scene ) {

	return scene.children.filter( ( child ) => child instanceof THREE.PointLight ).length;

}

Deno.test( 'gl_flashblend 0 removes the PointLights left by gl_flashblend 1', () => {

	const oldFlashblend = glquake.gl_flashblend.value;
	const oldTime = cl.time;
	const oldLights = cl_dlights.map( ( light ) => ( {
		die: light.die,
		radius: light.radius,
		minlight: light.minlight,
		origin: new Float32Array( light.origin )
	} ) );
	const scene = new THREE.Scene();

	try {

		cl.time = 10;
		for ( let i = 0; i < cl_dlights.length; i ++ ) {

			const light = cl_dlights[ i ];
			light.die = i < 3 ? 11 : 0;
			light.radius = i < 3 ? 200 : 0;
			light.minlight = 0;
			light.origin.set( [ 1000, 1000, 1000 ] );

		}

		glquake.gl_flashblend.value = 1;
		gl_rlight.R_RenderDlights( cl, scene );
		assertEqual( pointLights( scene ), 3, 'lights drawn with gl_flashblend 1' );

		glquake.gl_flashblend.value = 0;
		gl_rlight.R_RenderDlights( cl, scene );
		assertEqual( pointLights( scene ), 0, 'lights removed with gl_flashblend 0' );

		glquake.gl_flashblend.value = 1;
		gl_rlight.R_RenderDlights( cl, scene );
		assertEqual( pointLights( scene ), 3, 'lights back with gl_flashblend 1' );

	} finally {

		for ( const light of cl_dlights ) {

			light.die = 0;
			light.radius = 0;

		}

		gl_rlight.R_RenderDlights( cl, scene );
		glquake.gl_flashblend.value = oldFlashblend;
		cl.time = oldTime;
		cl_dlights.forEach( ( light, i ) => {

			light.die = oldLights[ i ].die;
			light.radius = oldLights[ i ].radius;
			light.minlight = oldLights[ i ].minlight;
			light.origin.set( oldLights[ i ].origin );

		} );

	}

} );
