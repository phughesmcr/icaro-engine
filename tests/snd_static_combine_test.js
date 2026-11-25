// Tests for S_Update's static sound combining, ported from id's snd_dma.c:
// audible static channels of the same sfx add their volumes into one
// channel "so we don't mix five torches every frame".

const cmd = await import( '../src/cmd.js' );
const sound = await import( '../src/sound.js' );
const snd_dma = await import( '../src/snd_dma.js' );
const pak = await import( '../src/pak.js' );
const { cl } = await import( '../src/client.js' );

function assertEqual( actual, expected, message ) {

	if ( actual !== expected )
		throw new Error( `${message}: expected ${expected}, got ${actual}` );

}

cmd.Cbuf_Init();
cmd.Cmd_Init();

const created = { buffers: [], sources: [] };

class FakeAudioContext {

	constructor() {

		this.state = 'running';
		this.sampleRate = 48000;
		this.destination = {};
		this.currentTime = 0;

	}

	createGain() { return { gain: { value: 1 }, connect() {} }; }
	createChannelMerger() { return { connect() {} }; }
	createBuffer( channels, length, rate ) {

		const data = new Float32Array( length );
		const buffer = { numberOfChannels: channels, length, sampleRate: rate, getChannelData: () => data };
		created.buffers.push( buffer );
		return buffer;

	}

	createBufferSource() {

		const source = {
			buffer: null, loop: false, loopStart: 0, loopEnd: 0, stopped: false,
			connect() {}, start() {}, stop() { this.stopped = true; }
		};
		created.sources.push( source );
		return source;

	}

	suspend() { this.state = 'suspended'; return Promise.resolve(); }
	resume() { this.state = 'running'; return Promise.resolve(); }
	close() { return Promise.resolve(); }

}

// 8-bit mono PCM WAV; loopstart >= 0 adds the cue chunk GetWavinfo reads
function makeWav( rate, samples, loopstart ) {

	const cue = loopstart >= 0 ? 8 + 28 : 0;
	const bytes = new Uint8Array( 12 + 8 + 16 + cue + 8 + samples + ( samples & 1 ) );
	const view = new DataView( bytes.buffer );
	const tag = ( ofs, s ) => { for ( let i = 0; i < 4; i ++ ) bytes[ ofs + i ] = s.charCodeAt( i ); };

	tag( 0, 'RIFF' ); view.setUint32( 4, bytes.length - 8, true ); tag( 8, 'WAVE' );
	let p = 12;
	tag( p, 'fmt ' ); view.setUint32( p + 4, 16, true );
	view.setUint16( p + 8, 1, true ); // PCM
	view.setUint16( p + 10, 1, true ); // mono
	view.setUint32( p + 12, rate, true );
	view.setUint32( p + 16, rate, true );
	view.setUint16( p + 20, 1, true );
	view.setUint16( p + 22, 8, true );
	p += 24;
	if ( cue ) {

		tag( p, 'cue ' ); view.setUint32( p + 4, 28, true );
		view.setUint32( p + 8, 1, true );
		view.setUint32( p + 32, loopstart, true ); // sampleOffset, read at chunk + 32
		p += cue;

	}

	tag( p, 'data' ); view.setUint32( p + 4, samples, true );
	for ( let i = 0; i < samples; i ++ )
		bytes[ p + 8 + i ] = i & 0xff;

	return bytes;

}

// A pak in memory holding the given files
function addFakePack( files ) {

	let size = 0;
	for ( const f of files ) size += f.data.length;
	const data = new Uint8Array( size );
	const entries = [];
	let pos = 0;
	for ( const f of files ) {

		data.set( f.data, pos );
		entries.push( { name: f.name, filepos: pos, filelen: f.data.length } );
		pos += f.data.length;

	}

	pak.COM_AddPack( { filename: 'test.pak', files: entries, data: data.buffer } );

}

addFakePack( [
	{ name: 'sound/combine/torch.wav', data: makeWav( 11025, 400, 0 ) },
	{ name: 'sound/combine/hum.wav', data: makeWav( 11025, 400, 0 ) },
	{ name: 'sound/combine/shot.wav', data: makeWav( 11025, 400, - 1 ) }
] );

function withSound( fn ) {

	const hadWindow = 'window' in globalThis;
	const oldWindow = globalThis.window;
	globalThis.window = { AudioContext: FakeAudioContext };

	try {

		snd_dma.S_Init();
		fn();

	} finally {

		snd_dma.S_StopAllSounds( true );
		snd_dma.S_Shutdown();
		if ( hadWindow ) globalThis.window = oldWindow;
		else delete globalThis.window;

	}

}

const zero = new Float32Array( 3 );

function staticChannel( n ) {

	return sound.channels[ sound.NUM_AMBIENTS + sound.MAX_DYNAMIC_CHANNELS + n ];

}

function hasSource( ch ) {

	return ch._audioSource !== null && ch._audioSource !== undefined;

}

Deno.test( 'static sounds of one sfx combine into the first channel', () => {

	withSound( () => {

		const torch = snd_dma.S_PrecacheSound( 'combine/torch.wav' );
		for ( let i = 0; i < 3; i ++ )
			snd_dma.S_StaticSound( torch, zero, 255, 1 );

		snd_dma.S_Update( zero, zero, zero, zero );

		assertEqual( staticChannel( 0 ).leftvol, 765, 'first channel has all three volumes' );
		assertEqual( staticChannel( 0 ).rightvol, 765, 'right too' );
		for ( let i = 1; i < 3; i ++ ) {

			assertEqual( staticChannel( i ).leftvol + staticChannel( i ).rightvol, 0, `channel ${i} muted` );
			assertEqual( hasSource( staticChannel( i ) ), false, `channel ${i} not started` );

		}

		assertEqual( hasSource( staticChannel( 0 ) ), true, 'first channel plays' );
		assertEqual( staticChannel( 0 )._leftGain.gain.value, 1, 'summed volume clamped to 255 as the C mixer does' );

	} );

} );

Deno.test( 'combining searches back past other sfx, and leaves dynamic channels alone', () => {

	withSound( () => {

		const torch = snd_dma.S_PrecacheSound( 'combine/torch.wav' );
		const hum = snd_dma.S_PrecacheSound( 'combine/hum.wav' );
		snd_dma.S_StaticSound( torch, zero, 100, 1 );
		snd_dma.S_StaticSound( hum, zero, 100, 1 );
		snd_dma.S_StaticSound( torch, zero, 100, 1 );
		snd_dma.S_StaticSound( hum, zero, 100, 1 );

		const shot = snd_dma.S_PrecacheSound( 'combine/shot.wav' );
		snd_dma.S_StartSound( 101, 1, shot, zero, 1, 1 );
		snd_dma.S_StartSound( 102, 1, shot, zero, 1, 1 );

		snd_dma.S_Update( zero, zero, zero, zero );

		assertEqual( staticChannel( 0 ).leftvol, 200, 'torch: first and third' );
		assertEqual( staticChannel( 1 ).leftvol, 200, 'hum: second and fourth' );
		assertEqual( staticChannel( 2 ).leftvol, 0, 'third muted' );
		assertEqual( staticChannel( 3 ).leftvol, 0, 'fourth muted' );

		let dynamic = 0;
		for ( let i = sound.NUM_AMBIENTS; i < sound.NUM_AMBIENTS + sound.MAX_DYNAMIC_CHANNELS; i ++ ) {

			const ch = sound.channels[ i ];
			if ( ch.sfx === shot ) {

				dynamic ++;
				assertEqual( ch.leftvol, 255, 'dynamic channel keeps its own volume' );

			}

		}

		assertEqual( dynamic, 2, 'two dynamic channels of the same sfx' );

	} );

} );

Deno.test( 'the search matches an earlier channel by sfx alone, even out of range, as in C', () => {

	// statics are entnum -1: keep them off the full-volume view entity path
	const oldView = cl.viewentity;
	cl.viewentity = 1;

	try {

		withSound( () => {

			// attenuation 1 fades out at 64000 units
			const torch = snd_dma.S_PrecacheSound( 'combine/torch.wav' );
			const far = new Float32Array( [ 96000, 0, 0 ] );
			snd_dma.S_StaticSound( torch, zero, 255, 1 );
			snd_dma.S_StaticSound( torch, far, 255, 1 );

			// at the second torch the first is out of range, but the second
			// still combines into it: C's search tests sfx, not volume
			snd_dma.S_Update( far, zero, zero, zero );
			assertEqual( staticChannel( 0 ).leftvol, 255, 'first channel carries the second torch' );
			assertEqual( staticChannel( 1 ).leftvol, 0, 'second channel muted' );
			assertEqual( hasSource( staticChannel( 0 ) ), true, 'first channel plays' );
			assertEqual( hasSource( staticChannel( 1 ) ), false, 'second channel not started' );

			// halfway, both are audible and add up
			snd_dma.S_Update( new Float32Array( [ 48000, 0, 0 ] ), zero, zero, zero );
			assertEqual( staticChannel( 0 ).leftvol, 2 * 63, 'first channel carries both' );
			assertEqual( staticChannel( 1 ).leftvol, 0, 'second channel still muted' );

			// out of range of both: nothing combines and the nodes go silent
			snd_dma.S_Update( new Float32Array( [ 0, 200000, 0 ] ), zero, zero, zero );
			assertEqual( staticChannel( 0 ).leftvol, 0, 'silent' );
			assertEqual( staticChannel( 0 )._leftGain.gain.value, 0, 'nodes kept, muted' );

		} );

	} finally {

		cl.viewentity = oldView;

	}

} );
