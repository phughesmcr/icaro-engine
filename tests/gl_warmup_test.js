// Tests for src/gl_warmup.js: the logic that needs no GPU.

// gl_rsurf.js first, as in gl_rmain_dlight_pad_test.js: the engine's import
// cycles only resolve from there
await import( '../src/gl_rsurf.js' );
const { R_WarmupBuckets, R_WarmupFillerCount, R_WarmupStart, R_WarmupWhenReady, R_WarmupPending, R_WarmupCamera } =
	await import( '../src/gl_warmup.js' );
const { R_DlightBucket } = await import( '../src/gl_rmain.js' );
const { MAX_DLIGHTS } = await import( '../src/client.js' );

function check( cond, msg ) {

	if ( cond !== true ) throw new Error( msg );

}

Deno.test( 'R_WarmupBuckets lists every light count R_PadDlights can reach', () => {

	const buckets = R_WarmupBuckets( 1 );
	check( buckets.join( ',' ) === '0,4,8,16,32,64', 'buckets: ' + buckets.join( ',' ) );

	// every reachable count maps into the list
	for ( let n = 0; n <= MAX_DLIGHTS; n ++ )
		check( buckets.includes( R_DlightBucket( n ) ), 'count ' + n + ' not covered' );

} );

Deno.test( 'R_WarmupBuckets with gl_flashblend 0 warms only the empty scene', () => {

	check( R_WarmupBuckets( 0 ).join( ',' ) === '0', 'flashblend 0 should warm bucket 0 only' );

} );

Deno.test( 'R_WarmupBuckets follows a smaller light limit', () => {

	check( R_WarmupBuckets( 1, 10 ).join( ',' ) === '0,4,8,16', 'max 10' );

} );

Deno.test( 'R_WarmupFillerCount counts lights already in the scene', () => {

	check( R_WarmupFillerCount( 0, 0 ) === 0, 'bucket 0, empty scene' );
	check( R_WarmupFillerCount( 8, 0 ) === 8, 'bucket 8, empty scene' );
	check( R_WarmupFillerCount( 8, 3 ) === 5, 'bucket 8, 3 in scene' );
	check( R_WarmupFillerCount( 4, 4 ) === 0, 'bucket 4, 4 in scene' );
	check( R_WarmupFillerCount( 0, 2 ) === - 1, 'bucket 0 cannot be reached with 2 lights' );

} );

Deno.test( 'without a renderer nothing is pending and the plaque callback runs at once', () => {

	R_WarmupStart( { worldmodel: {} } );
	check( R_WarmupPending() === false, 'pending without a renderer' );

	let called = 0;
	R_WarmupWhenReady( () => {

		called ++;

	} );
	check( called === 1, 'callback should run synchronously, ran ' + called );

} );

Deno.test( 'R_WarmupCamera stands in before R_SetupGL has made the real camera', () => {

	// the first frame creates the camera, so a page's first map has none
	const cam = R_WarmupCamera();
	check( cam !== null && cam !== undefined, 'no camera' );
	check( R_WarmupCamera() === cam, 'stand-in should be reused' );

} );
