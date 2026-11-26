// Web-only: S_UnlockAudio must resume an iOS 'interrupted' AudioContext.

const snd_dma = await import( '../src/snd_dma.js' );
const cmd = await import( '../src/cmd.js' );

function assertEqual( actual, expected, message ) {

	if ( actual !== expected )
		throw new Error( `${message}: expected ${expected}, got ${actual}` );

}

class FakeContext {

	static last = null;

	constructor() {

		this.state = 'running';
		this.resumes = 0;
		this.listeners = [];
		this.sampleRate = 44100;
		this.destination = {};
		FakeContext.last = this;

	}

	createGain() {

		return { gain: { value: 1 }, connect() {} };

	}

	addEventListener( type, fn ) {

		if ( type === 'statechange' ) this.listeners.push( fn );

	}

	resume() {

		this.resumes ++;
		return Promise.resolve();

	}

	suspend() {

		this.state = 'suspended';
		return Promise.resolve();

	}

	close() {

		this.state = 'closed';
		return Promise.resolve();

	}

	setState( state ) {

		this.state = state;
		for ( const fn of this.listeners ) fn();

	}

}

async function withContext( fn ) {

	const hadWindow = 'window' in globalThis;
	const old = globalThis.window;
	globalThis.window = { AudioContext: FakeContext, devicePixelRatio: 1 };
	cmd.Cbuf_Init();
	cmd.Cmd_Init();
	try {

		snd_dma.S_Init();
		await fn( FakeContext.last );

	} finally {

		snd_dma.S_Shutdown();
		if ( hadWindow ) globalThis.window = old; else delete globalThis.window;

	}

}

Deno.test( 'S_UnlockAudio resumes an interrupted or suspended context', async () => {

	await withContext( ( ctx ) => {

		for ( const state of [ 'interrupted', 'suspended' ] ) {

			ctx.state = state;
			ctx.resumes = 0;
			snd_dma.S_UnlockAudio();
			assertEqual( ctx.resumes, 1, `resume count in ${state}` );

		}

		ctx.state = 'running';
		ctx.resumes = 0;
		snd_dma.S_UnlockAudio();
		assertEqual( ctx.resumes, 0, 'no resume while running' );

	} );

} );

Deno.test( 'S_UnlockAudio does not resume a closed or blocked context', async () => {

	await withContext( ( ctx ) => {

		ctx.state = 'closed';
		snd_dma.S_UnlockAudio();
		assertEqual( ctx.resumes, 0, 'no resume when closed' );

		snd_dma.S_BlockSound();
		try {

			ctx.state = 'interrupted';
			snd_dma.S_UnlockAudio();
			assertEqual( ctx.resumes, 0, 'no resume while blocked' );

		} finally {

			snd_dma.S_UnblockSound();

		}

	} );

} );

Deno.test( 'statechange away from running tries to resume unless blocked', async () => {

	await withContext( ( ctx ) => {

		assertEqual( ctx.listeners.length, 1, 'statechange listener registered once' );

		ctx.setState( 'interrupted' );
		assertEqual( ctx.resumes, 1, 'resume on interrupted' );

		ctx.setState( 'running' );
		assertEqual( ctx.resumes, 1, 'no resume on running' );

		snd_dma.S_BlockSound();
		try {

			const before = ctx.resumes;
			ctx.setState( 'suspended' );
			assertEqual( ctx.resumes, before, 'no resume while blocked' );

		} finally {

			snd_dma.S_UnblockSound();

		}

	} );

} );
