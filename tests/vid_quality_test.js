// vid_quality presets (web-only), the vid_dprcap pixel-ratio cap, the
// dlight bucket cap and the particle limit.

await import( '../src/gl_rsurf.js' ); // load the renderer graph first (import cycle)
const { VID_ComputePixelRatio, vid_dprcap, VID_CheckPixelRatio } = await import( '../src/vid.js' );
const gl_rmain = await import( '../src/gl_rmain.js' );
const { Cvar_RegisterVariable, Cvar_FindVar, Cvar_Set } = await import( '../src/cvar.js' );
const { R_SetParticleLimit, R_GetParticleLimit, r_numparticles } = await import( '../src/r_part.js' );
const { advancedPages } = await import( '../src/menu_cvars.js' );

function assertEqual( actual, expected, message ) {

	if ( actual !== expected )
		throw new Error( `${message}: expected ${expected}, got ${actual}` );

}

// The cvars a preset writes: the real objects (R_Init isn't run here), and
// stand-ins for host_maxfps and gl_texture_anisotropy.
for ( const name of [ 'vid_dprcap', 'vid_quality', 'r_particlecap', 'gl_dlightcap', 'host_maxfps', 'gl_texture_anisotropy' ] ) {

	if ( Cvar_FindVar( name ) === null ) {

		const real = { vid_dprcap, vid_quality: gl_rmain.vid_quality, r_particlecap: gl_rmain.r_particlecap, gl_dlightcap: gl_rmain.gl_dlightcap }[ name ];
		const cvar = real !== undefined ? real : { name, string: '0', value: 0, archive: false };
		cvar.archive = false; // keep the test out of localStorage
		Cvar_RegisterVariable( cvar );

	}

}

const names = [ 'vid_dprcap', 'vid_quality', 'r_particlecap', 'gl_dlightcap', 'host_maxfps', 'gl_texture_anisotropy' ];

function withSavedCvars( fn ) {

	const saved = names.map( ( n ) => [ n, Cvar_FindVar( n ).string ] );
	try {

		fn();

	} finally {

		for ( const [ n, v ] of saved ) Cvar_Set( n, v );
		gl_rmain.R_ResetQuality();

	}

}

Deno.test( 'VID_ComputePixelRatio applies the vid_dprcap cap', () => {

	assertEqual( VID_ComputePixelRatio( 3, null, true, 0 ), 2, 'cap 0 keeps the touch rule' );
	assertEqual( VID_ComputePixelRatio( 3, null, false, 0 ), 3, 'cap 0 leaves desktop alone' );
	assertEqual( VID_ComputePixelRatio( 3, null, true, 1 ), 1, 'cap 1 on a phone' );
	assertEqual( VID_ComputePixelRatio( 3, null, false, 1.5 ), 1.5, 'cap applies on desktop' );
	assertEqual( VID_ComputePixelRatio( 1, null, true, 2 ), 1, 'cap does not raise the ratio' );
	assertEqual( VID_ComputePixelRatio( 3, null, true, 3 ), 3, 'cap above 2 lifts the touch cap' );
	assertEqual( VID_ComputePixelRatio( 3, 2.5, true, 1 ), 2.5, '?dpr= number beats the cap' );
	assertEqual( VID_ComputePixelRatio( 3, 'native', true, 1 ), 3, '?dpr=native beats the cap' );

} );

Deno.test( 'VID_CheckPixelRatio fires a resize when vid_dprcap changes', () => {

	const oldWindow = globalThis.window;
	const oldValue = vid_dprcap.value;
	let events = 0;
	globalThis.window = { dispatchEvent: ( e ) => { if ( e.type === 'resize' ) events ++; return true; } };
	try {

		VID_CheckPixelRatio();
		const base = events;
		VID_CheckPixelRatio();
		assertEqual( events, base, 'no change, no event' );
		vid_dprcap.value = 1;
		VID_CheckPixelRatio();
		assertEqual( events, base + 1, 'changed' );
		VID_CheckPixelRatio();
		assertEqual( events, base + 1, 'once per change' );

	} finally {

		vid_dprcap.value = oldValue;
		VID_CheckPixelRatio();
		if ( oldWindow === undefined ) delete globalThis.window; else globalThis.window = oldWindow;

	}

} );

Deno.test( 'vid_quality presets write the underlying cvars', () => {

	withSavedCvars( () => {

		gl_rmain.R_ApplyQualityPreset( 0 );
		assertEqual( Cvar_FindVar( 'vid_dprcap' ).value, 1, 'battery dprcap' );
		assertEqual( Cvar_FindVar( 'host_maxfps' ).value, 30, 'battery maxfps' );
		assertEqual( Cvar_FindVar( 'gl_dlightcap' ).value, 4, 'battery dlights' );
		assertEqual( Cvar_FindVar( 'r_particlecap' ).value, 2048, 'battery particles' );
		assertEqual( Cvar_FindVar( 'gl_texture_anisotropy' ).value, 1, 'battery anisotropy' );

		gl_rmain.R_ApplyQualityPreset( 1 );
		assertEqual( Cvar_FindVar( 'host_maxfps' ).value, 60, 'balanced maxfps' );
		assertEqual( Cvar_FindVar( 'vid_dprcap' ).value, 1.5, 'balanced dprcap' );

		gl_rmain.R_ApplyQualityPreset( 2 );
		assertEqual( Cvar_FindVar( 'vid_dprcap' ).value, 0, 'high dprcap' );
		assertEqual( Cvar_FindVar( 'gl_dlightcap' ).value, 64, 'high dlights' );
		assertEqual( Cvar_FindVar( 'r_particlecap' ).value, 0, 'high particles' );

		Cvar_Set( 'host_maxfps', '45' );
		gl_rmain.R_ApplyQualityPreset( 3 );
		assertEqual( Cvar_FindVar( 'host_maxfps' ).value, 45, 'custom writes nothing' );

	} );

} );

Deno.test( 'R_CheckQuality applies a change once and leaves later hand edits alone', () => {

	withSavedCvars( () => {

		const oldWindow = globalThis.window;
		globalThis.window = { dispatchEvent: () => true };
		try {

			Cvar_Set( 'vid_quality', '3' );
			Cvar_Set( 'host_maxfps', '72' );
			gl_rmain.R_ResetQuality();
			gl_rmain.R_CheckQuality(); // first frame: records, applies nothing
			assertEqual( Cvar_FindVar( 'host_maxfps' ).value, 72, 'first check applies nothing' );

			Cvar_Set( 'vid_quality', '0' );
			gl_rmain.R_CheckQuality();
			assertEqual( Cvar_FindVar( 'host_maxfps' ).value, 30, 'preset applied' );

			Cvar_Set( 'host_maxfps', '60' );
			gl_rmain.R_CheckQuality();
			gl_rmain.R_CheckQuality();
			assertEqual( Cvar_FindVar( 'host_maxfps' ).value, 60, 'hand edit kept' );

			// a saved preset at startup does not overwrite hand-tuned cvars
			gl_rmain.R_ResetQuality();
			gl_rmain.R_CheckQuality();
			assertEqual( Cvar_FindVar( 'host_maxfps' ).value, 60, 'startup keeps the saved value' );

		} finally {

			if ( oldWindow === undefined ) delete globalThis.window; else globalThis.window = oldWindow;

		}

	} );

} );

Deno.test( 'gl_dlightcap caps the dlight bucket', () => {

	withSavedCvars( () => {

		Cvar_Set( 'gl_dlightcap', '64' );
		assertEqual( gl_rmain.R_DlightBucketCap(), 64, 'default cap' );
		assertEqual( gl_rmain.R_DlightBucket( 40 ), 64, 'unchanged below the cap' );
		Cvar_Set( 'gl_dlightcap', '8' );
		assertEqual( gl_rmain.R_DlightBucketCap(), 8, 'cap 8' );
		assertEqual( gl_rmain.R_DlightBucket( 3 ), 4, 'small count' );
		assertEqual( gl_rmain.R_DlightBucket( 40 ), 8, 'capped' );
		Cvar_Set( 'gl_dlightcap', '10' );
		assertEqual( gl_rmain.R_DlightBucketCap(), 16, 'rounds up to a bucket' );
		Cvar_Set( 'gl_dlightcap', '1' );
		assertEqual( gl_rmain.R_DlightBucketCap(), 4, 'floor' );
		Cvar_Set( 'gl_dlightcap', '500' );
		assertEqual( gl_rmain.R_DlightBucketCap(), 64, 'ceiling' );

	} );

} );

Deno.test( 'R_SetParticleLimit bounds the limit by the pool', () => {

	try {

		R_SetParticleLimit( 0 );
		assertEqual( R_GetParticleLimit(), r_numparticles, 'zero = whole pool' );
		R_SetParticleLimit( 2048 );
		assertEqual( R_GetParticleLimit(), 2048, 'set' );
		R_SetParticleLimit( 10 );
		assertEqual( R_GetParticleLimit(), 512, 'floor is the C minimum' );
		R_SetParticleLimit( 1e9 );
		assertEqual( R_GetParticleLimit(), r_numparticles, 'capped at the pool' );

	} finally {

		R_SetParticleLimit( 0 );

	}

} );

Deno.test( 'the Graphics menu page lists the preset and the resolution cap', () => {

	const graphics = advancedPages.find( ( p ) => p.title === 'Graphics' );
	for ( const cvar of [ 'vid_quality', 'vid_dprcap' ] )
		if ( graphics.items.find( ( i ) => i.cvar === cvar ) === undefined )
			throw new Error( 'missing ' + cvar );

} );
