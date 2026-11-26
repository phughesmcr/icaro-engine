// Autosave on hide (src/autosave.js, host_cmd.js Host_AutoSave and
// Host_MaybeOfferContinue): when to save, when to offer Continue, and the
// save slot round trip on the headless host.

import { headless_init, headless_map, headless_wait_signon, headless_frame } from '../server/headless_host.js';
import { cls, cl } from '../src/client.js';
import { sv, svs } from '../src/server.js';
import { Cbuf_AddText } from '../src/cmd.js';
import { Cvar_SetValue, Cvar_FindVar } from '../src/cvar.js';
import { Host_AutoSave, Host_AutosaveVisible, Host_MaybeOfferContinue } from '../src/host_cmd.js';
import { Key_ModalActive, Key_Event } from '../src/keys.js';
import { Autosave_UrlBlocksOffer, Autosave_ParseMeta, Autosave_EncodeMeta, Autosave_OfferDecision,
	AUTOSAVE_META_KEY, AUTOSAVE_MAX_AGE_MS } from '../src/autosave.js';

function assert( cond, message ) {

	if ( cond !== true )
		throw new Error( message );

}

// --- pure rules ---

Deno.test( 'autosave: the offer is skipped for ?room=, ?map= and ?agent=', () => {

	assert( Autosave_UrlBlocksOffer( '' ) === false, 'empty' );
	assert( Autosave_UrlBlocksOffer( '?game=rogue&skill=2' ) === false, 'other params' );
	assert( Autosave_UrlBlocksOffer( '?room=abc' ) === true, 'room' );
	assert( Autosave_UrlBlocksOffer( '?map=e1m1&skill=1' ) === true, 'map' );
	assert( Autosave_UrlBlocksOffer( '?agent=lockstep' ) === true, 'agent' );

} );

Deno.test( 'autosave: meta records expire, and bad ones are ignored', () => {

	const now = 1_000_000_000_000;
	assert( Autosave_ParseMeta( Autosave_EncodeMeta( now - 1000, 'e1m1' ), now ).map === 'e1m1', 'fresh' );
	assert( Autosave_ParseMeta( Autosave_EncodeMeta( now - AUTOSAVE_MAX_AGE_MS - 1, 'e1m1' ), now ) === null, 'stale' );
	assert( Autosave_ParseMeta( Autosave_EncodeMeta( now + 5000, 'e1m1' ), now ) === null, 'from the future' );
	assert( Autosave_ParseMeta( null, now ) === null, 'missing' );
	assert( Autosave_ParseMeta( 'not json', now ) === null, 'malformed' );
	assert( Autosave_ParseMeta( '{"t":"x","map":1}', now ) === null, 'wrong types' );

} );

Deno.test( 'autosave: offer decision', () => {

	const now = 1_000_000_000_000;
	const base = {
		search: '', now, metaText: Autosave_EncodeMeta( now - 1000, 'e1m1' ), saveExists: true,
		connected: false, dedicated: false, modalActive: false, ready: true
	};
	const decide = ( over ) => Autosave_OfferDecision( { ...base, ...over } );

	assert( decide( {} ) === 'offer', 'offer' );
	assert( decide( { ready: false } ) === 'wait', 'not ready' );
	assert( decide( { modalActive: true } ) === 'wait', 'modal up' );
	assert( decide( { search: '?room=x' } ) === 'skip', 'room' );
	assert( decide( { search: '?map=e1m1' } ) === 'skip', 'map' );
	assert( decide( { search: '?agent=realtime' } ) === 'skip', 'agent' );
	assert( decide( { connected: true } ) === 'skip', 'game already started' );
	assert( decide( { dedicated: true } ) === 'skip', 'dedicated' );
	assert( decide( { metaText: null } ) === 'skip', 'consumed' );
	assert( decide( { metaText: Autosave_EncodeMeta( now - AUTOSAVE_MAX_AGE_MS - 1, 'e1m1' ) } ) === 'skip', 'stale' );
	assert( decide( { saveExists: false } ) === 'skip', 'save gone' );

} );

// --- the save slot on the headless host (shares one host, runs in order) ---

await headless_init();

const SLOT_KEY = 'quake_save_autosave';

Deno.test( 'autosave: hiding a running game writes the reserved slot only', async () => {

	await headless_map( 'e1m1' );
	for ( let i = 0; i < 30; i ++ ) headless_frame();

	localStorage.setItem( 'quake_save_s0', 'player save' );
	localStorage.removeItem( SLOT_KEY );
	localStorage.removeItem( AUTOSAVE_META_KEY );

	assert( Host_AutoSave() === true, 'saved' );
	assert( localStorage.getItem( 'quake_save_s0' ) === 'player save', 's0 was overwritten' );
	const text = localStorage.getItem( SLOT_KEY );
	assert( text !== null && text.split( '\n' ).length > 100, 'no save in the slot' );
	assert( text.split( '\n' )[ 0 ] === '5', 'save version line: ' + text.split( '\n' )[ 0 ] );
	assert( text.split( '\n' )[ 19 ] === 'e1m1', 'map line: ' + text.split( '\n' )[ 19 ] );
	assert( Autosave_ParseMeta( localStorage.getItem( AUTOSAVE_META_KEY ), Date.now() ).map === 'e1m1', 'meta' );

	// pagehide after visibilitychange: same moment, no second write
	assert( Host_AutoSave() === false, 'saved the same moment twice' );

	// the player came back: the live game is the one to keep
	Host_AutosaveVisible();
	assert( localStorage.getItem( AUTOSAVE_META_KEY ) === null, 'meta not consumed on visible' );

} );

Deno.test( 'autosave: refusals match save, without printing', () => {

	const check = ( what, setup ) => {

		localStorage.removeItem( SLOT_KEY );
		localStorage.removeItem( AUTOSAVE_META_KEY );
		Host_AutosaveVisible();
		const restore = setup();
		try {

			assert( Host_AutoSave() === false, what + ': saved' );
			assert( localStorage.getItem( SLOT_KEY ) === null, what + ': wrote the slot' );

		} finally {

			restore();

		}

	};

	check( 'intermission', () => {

		const old = cl.intermission;
		cl.intermission = 1;
		return () => {

			cl.intermission = old;

		};

	} );
	check( 'multiplayer', () => {

		const old = svs.maxclients;
		svs.maxclients = 2;
		return () => {

			svs.maxclients = old;

		};

	} );
	check( 'nomonsters', () => {

		const old = sv.nomonsters;
		sv.nomonsters = true;
		return () => {

			sv.nomonsters = old;

		};

	} );
	check( 'demo playback', () => {

		const old = cls.demoplayback;
		cls.demoplayback = true;
		return () => {

			cls.demoplayback = old;

		};

	} );
	check( 'dead player', () => {

		const v = svs.clients[ 0 ].edict.v;
		const old = v.health;
		v.health = 0;
		return () => {

			v.health = old;

		};

	} );
	check( 'not spawned', () => {

		const old = svs.clients[ 0 ].spawned;
		svs.clients[ 0 ].spawned = false;
		return () => {

			svs.clients[ 0 ].spawned = old;

		};

	} );
	check( 'no local game', () => {

		const old = sv.active;
		sv.active = false;
		return () => {

			sv.active = old;

		};

	} );
	check( 'web_autosave 0', () => {

		const old = Cvar_FindVar( 'web_autosave' ).value;
		Cvar_SetValue( 'web_autosave', 0 );
		return () => {

			Cvar_SetValue( 'web_autosave', old );

		};

	} );

} );

Deno.test( 'autosave: the offer loads the autosave on yes and consumes it', async () => {

	await headless_map( 'e1m1' );
	for ( let i = 0; i < 30; i ++ ) headless_frame();
	assert( Host_AutoSave() === true, 'saved' );

	// a fresh page load: no game running
	cbufRun( 'disconnect' );
	assert( sv.active === false, 'server still active' );

	let offered = false;
	for ( let i = 0; i < 10 && offered === false; i ++ ) {

		offered = Host_MaybeOfferContinue();

	}

	assert( offered === true && Key_ModalActive() === true, 'no prompt' );

	Key_Event( 'y'.charCodeAt( 0 ), true );
	Key_Event( 'y'.charCodeAt( 0 ), false );
	assert( Key_ModalActive() === false, 'prompt still up' );
	assert( localStorage.getItem( AUTOSAVE_META_KEY ) === null, 'not consumed' );

	await headless_wait_signon();
	assert( sv.active === true && sv.name === 'e1m1', 'autosave not loaded: ' + sv.name );

} );

Deno.test( 'autosave: no on declines and map consumes', () => {

	localStorage.setItem( AUTOSAVE_META_KEY, Autosave_EncodeMeta( Date.now(), 'e1m1' ) );
	cbufRun( 'disconnect' );
	let offered = false;
	for ( let i = 0; i < 10 && offered === false; i ++ ) offered = Host_MaybeOfferContinue();
	assert( Key_ModalActive() === true, 'no prompt' );
	Key_Event( 'n'.charCodeAt( 0 ), true );
	Key_Event( 'n'.charCodeAt( 0 ), false );
	assert( sv.active === false, 'a decline started a game' );
	assert( localStorage.getItem( AUTOSAVE_META_KEY ) === null, 'decline did not consume' );

	localStorage.setItem( AUTOSAVE_META_KEY, Autosave_EncodeMeta( Date.now(), 'e1m1' ) );
	cbufRun( 'map e1m1' );
	assert( localStorage.getItem( AUTOSAVE_META_KEY ) === null, 'map did not consume' );

} );

function cbufRun( text ) {

	Cbuf_AddText( text + '\n' );
	headless_frame();

}
