// Check_Gamma (gl_vidnt.c) bakes pow( ( c + 1 ) / 256, vid_gamma ) into the
// palette; the gamma cvar only drives the port's tone-mapping exposure.

// vid.js alone hits a pre-existing import cycle (render.js vrect_t TDZ);
// load the renderer graph in its safe order first.
await import( '../src/gl_rsurf.js' );

const { Check_Gamma, Check_Gamma_Palette, VID_GammaExposure } = await import( '../src/vid.js' );

function assertEqual( actual, expected, message ) {

	if ( actual !== expected )
		throw new Error( `${message}: expected ${expected}, got ${actual}` );

}

// Straight transcription of the C loop, float maths and (unsigned char) cast.
function cCheckGamma( c, gamma ) {

	const f = Math.pow( ( c + 1 ) / 256.0, gamma );
	let inf = f * 255 + 0.5;
	if ( inf < 0 ) inf = 0;
	if ( inf > 255 ) inf = 255;
	return Math.trunc( inf );

}

Deno.test( 'Check_Gamma_Palette matches the C formula at vid_gamma 0.7', () => {

	const pal = new Uint8Array( 768 );
	for ( let i = 0; i < 768; i ++ ) pal[ i ] = i & 255;
	Check_Gamma_Palette( pal, 0.7 );

	for ( let i = 0; i < 768; i ++ )
		assertEqual( pal[ i ], cCheckGamma( i & 255, 0.7 ), `entry ${i}` );

	// spot checks: black lifts, mid-grey brightens, white stays white
	assertEqual( cCheckGamma( 0, 0.7 ), 5, 'black' );
	assertEqual( cCheckGamma( 128, 0.7 ), 158, 'mid-grey' );
	assertEqual( cCheckGamma( 255, 0.7 ), 255, 'white' );

} );

Deno.test( 'Check_Gamma_Palette at vid_gamma 1 is the 3Dfx near-identity', () => {

	const pal = new Uint8Array( 768 );
	for ( let i = 0; i < 768; i ++ ) pal[ i ] = i & 255;
	Check_Gamma_Palette( pal, 1.0 );
	for ( let i = 0; i < 768; i ++ )
		assertEqual( pal[ i ], cCheckGamma( i & 255, 1.0 ), `entry ${i}` );

} );

Deno.test( 'VID_GammaExposure: gamma 1 renders at exposure 1', () => {

	assertEqual( VID_GammaExposure( 1.0 ), 1.0, 'default' );
	assertEqual( VID_GammaExposure( 0.5 ), 2.0, 'gamma 0.5' );
	assertEqual( VID_GammaExposure( 0 ), 1.0, 'gamma 0 guarded' );
	assertEqual( VID_GammaExposure( - 1 ), 1.0, 'negative gamma guarded' );

} );

Deno.test( 'Check_Gamma defaults to 0.7, honours -gamma, and corrects each palette once', () => {

	const pal = new Uint8Array( [ 0, 128, 255 ] );
	Check_Gamma( pal );
	assertEqual( pal[ 1 ], cCheckGamma( 128, 0.7 ), 'default 0.7' );
	Check_Gamma( pal );
	assertEqual( pal[ 1 ], cCheckGamma( 128, 0.7 ), 'not applied twice' );

	const pal2 = new Uint8Array( [ 0, 128, 255 ] );
	Check_Gamma( pal2, 1.0 );
	assertEqual( pal2[ 1 ], cCheckGamma( 128, 1.0 ), '-gamma 1 on a fresh palette' );

} );
