// Bootstrap the renderer's existing circular module graph in its safe order.
await import( '../src/gl_rsurf.js' );

const gl_rmisc = await import( '../src/gl_rmisc.js' );
const gl_rmain = await import( '../src/gl_rmain.js' );
const { r_refdef } = await import( '../src/render.js' );
const { Cvar_FindVar, Cvar_Set } = await import( '../src/cvar.js' );

function assertEqual( actual, expected, message ) {

	if ( actual !== expected )
		throw new Error( `${message}: expected ${expected}, got ${actual}` );

}

Deno.test( 'gl_farclip is registered, archived and defaults to id\'s 4096', () => {

	gl_rmisc.R_Init();
	assertEqual( Cvar_FindVar( 'gl_farclip' ), gl_rmain.gl_farclip, 'cvar identity' );
	assertEqual( gl_rmain.gl_farclip.archive, true, 'archived' );
	assertEqual( gl_rmain.gl_farclip.string, '4096', 'default' );

} );

Deno.test( 'R_SetupGL takes the far plane from gl_farclip', () => {

	gl_rmisc.R_Init();
	const oldString = gl_rmain.gl_farclip.string;
	r_refdef.vrect.x = 0;
	r_refdef.vrect.y = 0;
	r_refdef.vrect.width = 320;
	r_refdef.vrect.height = 200;
	r_refdef.fov_y = 70;

	try {

		gl_rmain.R_SetupGL();
		assertEqual( gl_rmain.camera.near, 4, 'near on creation' );
		assertEqual( gl_rmain.camera.far, 4096, 'far on creation' );

		Cvar_Set( 'gl_farclip', '65536' );
		gl_rmain.R_SetupGL();
		assertEqual( gl_rmain.camera.far, 65536, 'far after gl_farclip 65536' );

	} finally {

		Cvar_Set( 'gl_farclip', oldString );

	}

} );
