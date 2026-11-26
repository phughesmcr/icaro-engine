// Tests for src/gl_warmup.js with a fake renderer: plaque holding, the wait
// cap, cancelling and superseding. R_WarmupSetTest swaps in the fake renderer
// and scene (the real ones need a browser).

// gl_rsurf.js first, as in gl_rmain_dlight_pad_test.js
await import( '../src/gl_rsurf.js' );
const { R_WarmupStart, R_WarmupWhenReady, R_WarmupPending, R_WarmupCancel, R_WarmupSetTest, R_WARMUP_MAX_WAIT_MS } =
	await import( '../src/gl_warmup.js' );
const THREE = await import( 'three' );

function check( cond, msg ) {

	if ( cond !== true ) throw new Error( msg );

}

// A renderer whose compileAsync promises the test settles by hand
function fakeRenderer() {

	const r = { info: { programs: [] }, calls: [], resolvers: [] };
	r.compileAsync = () => new Promise( ( resolve ) => {

		r.calls.push( 1 );
		r.resolvers.push( resolve );

	} );
	return r;

}

const tick = () => new Promise( ( resolve ) => setTimeout( resolve, 0 ) );
const level = { worldmodel: {} };

async function withFake( fn ) {

	const r = fakeRenderer();
	R_WarmupSetTest( { renderer: r, scene: new THREE.Scene() } );
	try {

		await fn( r );

	} finally {

		R_WarmupCancel(); // stop timers and drop state
		R_WarmupSetTest( null );

	}

}

// settles every compile the fake has been asked for, bucket by bucket
// (R_WarmupStart waits for each before starting the next)
async function settleAll( r ) {

	for ( let i = 0; i < 20; i ++ ) {

		while ( r.resolvers.length > 0 ) r.resolvers.shift()();
		await tick();

	}

}

Deno.test( 'R_WarmupWhenReady defers while compiling and runs when they finish', async () => {

	await withFake( async ( r ) => {

		R_WarmupStart( level );
		check( R_WarmupPending() === true, 'should be pending' );
		let called = 0;
		R_WarmupWhenReady( () => called ++ );
		await tick();
		check( called === 0, 'ran before the compiles finished' );
		await settleAll( r );
		check( called === 1, 'should run once, ran ' + called );
		check( R_WarmupPending() === false, 'still pending' );

	} );

} );

Deno.test( 'buckets compile one after another', async () => {

	await withFake( async ( r ) => {

		R_WarmupStart( level );
		await tick();
		check( r.calls.length === 2, 'first bucket: scene and group, got ' + r.calls.length );
		r.resolvers.shift()();
		await tick();
		check( r.calls.length === 2, 'next bucket started before the first finished' );
		r.resolvers.shift()();
		await tick();
		check( r.calls.length === 4, 'next bucket should start, got ' + r.calls.length );

	} );

} );

Deno.test( 'R_WarmupCancel runs the held plaque callback once', async () => {

	await withFake( async () => {

		R_WarmupStart( level );
		let called = 0;
		R_WarmupWhenReady( () => called ++ );
		R_WarmupCancel();
		check( called === 1, 'cancel should end the plaque, ran ' + called );
		check( R_WarmupPending() === false, 'still pending' );
		R_WarmupCancel();
		await tick();
		check( called === 1, 'ran twice' );

	} );

} );

Deno.test( 'a second R_WarmupStart supersedes the first', async () => {

	await withFake( async ( r ) => {

		R_WarmupStart( level );
		let first = 0;
		R_WarmupWhenReady( () => first ++ );
		R_WarmupStart( level );
		let second = 0;
		R_WarmupWhenReady( () => second ++ );
		await settleAll( r ); // also settles the first run's compiles
		check( first === 0, 'the superseded callback must not run' );
		check( second === 1, 'the new callback should run once, ran ' + second );

	} );

} );

Deno.test( 'the wait is capped at R_WARMUP_MAX_WAIT_MS', async () => {

	await withFake( async ( r ) => {

		R_WarmupStart( level );
		let called = 0;
		R_WarmupWhenReady( () => called ++ );
		await new Promise( ( resolve ) => setTimeout( resolve, R_WARMUP_MAX_WAIT_MS + 100 ) );
		check( called === 1, 'cap should end the wait, ran ' + called );
		check( R_WarmupPending() === false, 'still pending after the cap' );
		await settleAll( r ); // late compiles change nothing
		check( called === 1, 'ran again after the late compiles' );

	} );

} );
