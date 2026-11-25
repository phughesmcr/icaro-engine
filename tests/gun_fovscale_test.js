// cl_gun_fovscale (Ironwail r_alias.c R_DrawAliasModel_Real): above a 90
// degree fov the view model's y and z are scaled by
// 1 + ( tan( fov / 2 ) - 1 ) * cl_gun_fovscale.

// Bootstrap the renderer's circular module graph in its safe order.
await import( '../src/gl_rsurf.js' );

const { cl_gun_fovscale, R_GunFovScale } = await import( '../src/gl_mesh.js' );
const { r_refdef } = await import( '../src/render.js' );
const { Mod_Init } = await import( '../src/gl_model.js' );
const { Cvar_FindVar } = await import( '../src/cvar.js' );

function assertClose( actual, expected, message, epsilon = 1e-6 ) {

	if ( Math.abs( actual - expected ) > epsilon )
		throw new Error( `${message}: expected ${expected}, got ${actual}` );

}

// gl_screen.js SCR_CalcRefdef: fov_y = CalcFov( fov, 4, 3 ).
function fovYFor( fov ) {

	return Math.atan( 3 / ( 4 / Math.tan( fov / 360 * Math.PI ) ) ) * 360 / Math.PI;

}

Deno.test( 'R_GunFovScale follows Ironwail for fov above 90 only', () => {

	const oldString = cl_gun_fovscale.string;
	const oldValue = cl_gun_fovscale.value;
	const oldFovY = r_refdef.fov_y;

	try {

		if ( cl_gun_fovscale.string !== '0' )
			throw new Error( `default: expected '0' (GLQuake), got '${cl_gun_fovscale.string}'` );

		r_refdef.fov_y = fovYFor( 120 );
		cl_gun_fovscale.value = 0;
		assertClose( R_GunFovScale(), 1, 'cvar 0 leaves the gun unscaled' );

		cl_gun_fovscale.value = 1;
		assertClose( R_GunFovScale(), Math.tan( Math.PI / 3 ), 'fov 120, full correction' );

		cl_gun_fovscale.value = 0.5;
		assertClose( R_GunFovScale(), 1 + ( Math.tan( Math.PI / 3 ) - 1 ) * 0.5, 'fov 120, half correction' );

		cl_gun_fovscale.value = 1;
		r_refdef.fov_y = fovYFor( 90 );
		assertClose( R_GunFovScale(), 1, 'fov 90' );

		r_refdef.fov_y = fovYFor( 75 );
		assertClose( R_GunFovScale(), 1, 'fov below 90' );

	} finally {

		cl_gun_fovscale.string = oldString;
		cl_gun_fovscale.value = oldValue;
		r_refdef.fov_y = oldFovY;

	}

} );

Deno.test( 'Mod_Init registers cl_gun_fovscale', () => {

	Mod_Init();
	if ( Cvar_FindVar( 'cl_gun_fovscale' ) !== cl_gun_fovscale )
		throw new Error( 'cl_gun_fovscale is not registered' );

} );
