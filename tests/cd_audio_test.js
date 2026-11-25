// Tests for the CD music fixes from the second port review (CD-1, CD-2 and
// part of CD-3), against WinQuake/cd_win.c.

const cmd = await import( '../src/cmd.js' );
const cd_audio = await import( '../src/cd_audio.js' );

function assertEqual( actual, expected, message ) {

	if ( actual !== expected )
		throw new Error( `${message}: expected ${expected}, got ${actual}` );

}

cmd.Cbuf_Init();
cmd.Cmd_Init();

// a stand-in for HTMLAudioElement; play() always succeeds
class FakeAudio {

	constructor() {

		this.src = '';
		this.loop = false;
		this.volume = 1;
		this.currentTime = 0;
		this.onerror = null;
		this.onended = null;
		this.error = null;
		this.plays = [];
		this.pauses = 0;
		FakeAudio.last = this;

	}

	play() {

		this.plays.push( this.src );
		return Promise.resolve();

	}

	pause() { this.pauses ++; }

}

// two candidates per track, so a load error falls through to the second
function trackURLs( track ) {

	const name = 'track' + String( track ).padStart( 2, '0' );
	return [ 'a/' + name + '.ogg', 'b/' + name + '.ogg' ];

}

// Runs fn with Audio stubbed and the CD system initialized, then shuts it down
async function withCD( fn ) {

	const hadAudio = 'Audio' in globalThis;
	const oldAudio = globalThis.Audio;
	globalThis.Audio = FakeAudio;
	FakeAudio.last = null;

	try {

		cd_audio.CDAudio_Init();
		cd_audio.CDAudio_SetTrackURLProvider( trackURLs );
		await fn();

	} finally {

		cd_audio.CDAudio_Shutdown();
		cd_audio.CDAudio_SetTrackURLProvider( null );
		if ( hadAudio ) globalThis.Audio = oldAudio;
		else delete globalThis.Audio;

	}

}

function cdCommand( args ) {

	cmd.Cmd_ExecuteString( 'cd ' + args, cmd.src_command );

}

Deno.test( 'CD-1: a stopped track does not come back on unpause', async () => {

	await withCD( () => {

		cd_audio.CDAudio_Play( 2, true );
		const el = FakeAudio.last;
		const plays = el.plays.length;
		cd_audio.CDAudio_Stop();
		cd_audio.CDAudio_Pause();
		cd_audio.CDAudio_Resume();
		assertEqual( el.plays.length, plays, 'no play() after Stop' );

	} );

} );

Deno.test( 'CD-1: stopping while paused keeps the paused track for Resume', async () => {

	await withCD( () => {

		cd_audio.CDAudio_Play( 2, true );
		const el = FakeAudio.last;
		cd_audio.CDAudio_Pause();
		const pauses = el.pauses;
		const plays = el.plays.length;
		cd_audio.CDAudio_Stop();
		assertEqual( el.pauses, pauses, 'Stop while paused leaves the element alone' );
		cd_audio.CDAudio_Resume();
		assertEqual( el.plays.length, plays + 1, 'Resume plays the paused track' );
		assertEqual( el.plays[ el.plays.length - 1 ], 'a/track02.ogg', 'same track' );

	} );

} );

Deno.test( 'CD-1: a load falling through its candidates while paused survives Stop', async () => {

	await withCD( () => {

		cd_audio.CDAudio_Play( 2, true );
		const el = FakeAudio.last;
		cd_audio.CDAudio_Pause();
		cd_audio.CDAudio_Stop();
		el.onerror();
		assertEqual( el.src, 'b/track02.ogg', 'next candidate loaded' );
		cd_audio.CDAudio_Resume();
		assertEqual( el.plays[ el.plays.length - 1 ], 'b/track02.ogg', 'Resume plays it' );

	} );

} );

Deno.test( 'CD-2: a bad track keeps the current music playing', async () => {

	await withCD( () => {

		cd_audio.CDAudio_Play( 2, true );
		const el = FakeAudio.last;
		const pauses = el.pauses;

		// a map with sounds 0 sends svc_cdtrack 0
		cd_audio.CDAudio_Play( 0, false );
		cd_audio.CDAudio_Play( 100, false );
		assertEqual( el.pauses, pauses, 'not stopped' );
		assertEqual( el.src, 'a/track02.ogg', 'source unchanged' );

		// looping wasn't cleared, so the end of the track doesn't stop it
		el.onended();
		cd_audio.CDAudio_Pause();
		assertEqual( el.pauses, pauses + 1, 'still playing after onended' );

	} );

} );

Deno.test( 'CD-2: a track with no URL keeps the current music playing', async () => {

	await withCD( () => {

		cd_audio.CDAudio_Play( 2, true );
		const el = FakeAudio.last;
		const pauses = el.pauses;
		cd_audio.CDAudio_SetTrackURLProvider( ( track ) => track === 2 ? trackURLs( track ) : [] );
		cd_audio.CDAudio_Play( 3, false );
		assertEqual( el.pauses, pauses, 'not stopped' );
		assertEqual( el.src, 'a/track02.ogg', 'source unchanged' );

	} );

} );

Deno.test( 'CD-3: the track number wraps to a byte, as in C', async () => {

	await withCD( () => {

		cd_audio.CDAudio_Play( 258, true );
		const el = FakeAudio.last;
		assertEqual( el.src, 'a/track02.ogg', '258 plays track 2' );

		// 256 wraps to 0: a bad track
		cd_audio.CDAudio_Play( 256, true );
		assertEqual( el.src, 'a/track02.ogg', '256 rejected' );

		// -1 wraps to 255: past the last track
		cd_audio.CDAudio_Play( - 1, true );
		assertEqual( el.src, 'a/track02.ogg', '-1 rejected' );

	} );

} );

Deno.test( 'CD-3: cd subcommands ignore case, as Q_strcasecmp does', async () => {

	await withCD( () => {

		cdCommand( 'LOOP 3' );
		const el = FakeAudio.last;
		assertEqual( el !== null && el.src, 'a/track03.ogg', 'LOOP plays' );
		const pauses = el.pauses;
		cdCommand( 'Pause' );
		assertEqual( el.pauses, pauses + 1, 'Pause pauses' );

	} );

} );

Deno.test( 'Shutdown while paused forgets the paused track', async () => {

	await withCD( () => {

		cd_audio.CDAudio_Play( 2, true );
		cd_audio.CDAudio_Pause();

	} );

	await withCD( () => {

		// Resume has nothing to restart, so the same track loads afresh
		cd_audio.CDAudio_Resume();
		assertEqual( FakeAudio.last, null, 'no element from Resume' );
		cd_audio.CDAudio_Play( 2, true );
		const el = FakeAudio.last;
		assertEqual( el !== null && el.src, 'a/track02.ogg', 'same track loads after re-init' );

	} );

} );
