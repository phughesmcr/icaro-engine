// pointfile (r_part.c R_ReadPointFile_f) and focus-loss sound blocking
// (snd_win.c S_BlockSound / S_UnblockSound, gl_vidnt.c AppActivate).

// Bootstrap the renderer's circular module graph in its safe order.
await import( '../src/gl_rsurf.js' );

const r_part = await import( '../src/r_part.js' );
const sound = await import( '../src/sound.js' );
const snd_dma = await import( '../src/snd_dma.js' );
const cmd = await import( '../src/cmd.js' );

function assertEqual( actual, expected, message ) {

	if ( actual !== expected )
		throw new Error( `${message}: expected ${expected}, got ${actual}` );

}

Deno.test( 'R_ParsePointFile reads triples until one fails, like the fscanf loop', () => {

	const coords = r_part.R_ParsePointFile( '1 2 3\n-4.5 5e1 6\n7 8 oops\n9 10 11\n' );
	assertEqual( coords.length, 6, 'two points' );
	assertEqual( coords[ 3 ], - 4.5, 'negative' );
	assertEqual( coords[ 4 ], 50, 'exponent' );

	assertEqual( r_part.R_ParsePointFile( '' ).length, 0, 'empty file' );
	assertEqual( r_part.R_ParsePointFile( '1 2 3\n4 5' ).length, 3, 'partial triple dropped' );

} );

Deno.test( 'R_LoadPointFile stops at the particle limit and counts like C', () => {

	r_part.R_InitParticles();
	try {

		assertEqual( r_part.R_LoadPointFile( [ 0, 0, 0, 1, 1, 1 ] ), 2, 'two points' );

		// 16384 particles (MAX_PARTICLES), two used: C bumps c before
		// finding the pool empty.
		const many = new Array( 3 * 16500 ).fill( 0 );
		assertEqual( r_part.R_LoadPointFile( many ), 16383, 'pool exhausted' );

	} finally {

		r_part.R_ClearParticles();

	}

} );

Deno.test( 'S_BlockSound suspends on the first block and resumes on the last unblock', () => {

	const hadWindow = 'window' in globalThis;
	const oldWindow = globalThis.window;
	const calls = [];
	class FakeAudioContext {

		constructor() {

			this.state = 'running';
			this.sampleRate = 44100;
			this.destination = {};

		}

		createGain() { return { gain: { value: 1 }, connect() {} }; }
		suspend() { calls.push( 'suspend' ); if ( ! FakeAudioContext.lazy ) this.state = 'suspended'; return Promise.resolve(); }
		resume() { calls.push( 'resume' ); this.state = 'running'; return Promise.resolve(); }
		close() { return Promise.resolve(); }

	}

	globalThis.window = { AudioContext: FakeAudioContext };
	cmd.Cmd_Init();

	try {

		snd_dma.S_Init();

		snd_dma.S_BlockSound();
		snd_dma.S_BlockSound();
		assertEqual( sound.snd_blocked, 2, 'counted' );
		assertEqual( calls.join( ',' ), 'suspend', 'suspended once' );

		snd_dma.S_UnlockAudio();
		assertEqual( calls.join( ',' ), 'suspend', 'a key press does not unblock' );

		snd_dma.S_UnblockSound();
		assertEqual( calls.join( ',' ), 'suspend', 'still blocked once' );
		snd_dma.S_UnblockSound();
		assertEqual( sound.snd_blocked, 0, 'unblocked' );
		assertEqual( calls.join( ',' ), 'suspend,resume', 'resumed' );

		// a context created while blocked starts suspended
		snd_dma.S_Shutdown();
		snd_dma.S_BlockSound();
		calls.length = 0;
		snd_dma.S_Init();
		assertEqual( calls.join( ',' ), 'suspend', 'new context suspended' );
		snd_dma.S_UnblockSound();
		assertEqual( calls.join( ',' ), 'suspend,resume', 'new context resumed' );

		// suspend() settles later than it returns: a quick hide/show, while
		// the state still reads 'running', must still resume
		snd_dma.S_Shutdown();
		FakeAudioContext.lazy = true;
		snd_dma.S_Init();
		calls.length = 0;
		snd_dma.S_BlockSound();
		snd_dma.S_UnblockSound();
		assertEqual( calls.join( ',' ), 'suspend,resume', 'resumed while suspend was pending' );

	} finally {

		FakeAudioContext.lazy = false;

		snd_dma.S_Shutdown();
		sound.Sound_SetBlocked( 0 );
		if ( hadWindow ) globalThis.window = oldWindow;
		else delete globalThis.window;

	}

} );
