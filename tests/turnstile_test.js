// Tests for the lobby's Turnstile check (server/turnstile.js): settings,
// the challenge for a request without a token, and Siteverify's answer,
// with a fake fetch (the test task has no network).

import {
	Turnstile_Check,
	Turnstile_ConfigFrom,
	Turnstile_Verify,
	TURNSTILE_ACTION_CREATE_ROOM,
	TURNSTILE_MAX_TOKEN_LENGTH,
	TURNSTILE_SITEVERIFY_URL,
} from '../server/turnstile.js';

function assert( condition, message ) {

	if ( condition !== true ) throw new Error( message );

}

function assertEqual( actual, expected, message ) {

	if ( actual !== expected ) throw new Error( `${message}: expected ${JSON.stringify( expected )}, got ${JSON.stringify( actual )}` );

}

const CONFIG = Turnstile_ConfigFrom( ( name ) => ( {
	TURNSTILE_SITEKEY: 'sitekey',
	TURNSTILE_SECRET: 'secret',
	TURNSTILE_HOSTNAMES: 'anglezarke.games, Play.Example ',
} )[ name ] );

// A fetch that records its requests and answers with `result` as JSON
function fakeSiteverify( result, { status = 200 } = {} ) {

	const requests = [];
	const fetch = ( url, init ) => {

		requests.push( { url, init, body: new URLSearchParams( init.body ) } );
		return Promise.resolve( new Response( JSON.stringify( result ), { status } ) );

	};
	return { fetch, requests };

}

const PASS = { success: true, action: TURNSTILE_ACTION_CREATE_ROOM, hostname: 'anglezarke.games' };

Deno.test( 'Turnstile_ConfigFrom: off without a sitekey; hostnames trimmed and lower-cased', () => {

	assertEqual( Turnstile_ConfigFrom( () => undefined ), null, 'unset' );
	assertEqual( Turnstile_ConfigFrom( () => '  ' ), null, 'blank' );
	assertEqual( CONFIG.sitekey, 'sitekey', 'sitekey' );
	assertEqual( CONFIG.secret, 'secret', 'secret' );
	assertEqual( [ ...CONFIG.hostnames ].join( '|' ), 'anglezarke.games|play.example', 'hostnames' );

	const partial = Turnstile_ConfigFrom( ( name ) => name === 'TURNSTILE_SITEKEY' ? 'k' : undefined );
	assertEqual( partial.secret, '', 'no secret' );
	assertEqual( partial.hostnames.size, 0, 'no hostnames' );

} );

Deno.test( 'Turnstile_Check: off passes, no token gets the challenge without calling Siteverify', async () => {

	const { fetch, requests } = fakeSiteverify( PASS );
	assertEqual( await Turnstile_Check( null, undefined, '1.2.3.4', 'create_room', fetch ), null, 'off' );
	for ( const token of [ undefined, null, '' ] ) {

		const gate = await Turnstile_Check( CONFIG, token, '1.2.3.4', 'create_room', fetch );
		assertEqual( JSON.stringify( gate ), JSON.stringify( { challenge: { sitekey: 'sitekey', action: 'create_room' } } ), 'challenge for ' + token );

	}

	assertEqual( requests.length, 0, 'no Siteverify call' );

} );

Deno.test( 'Turnstile_Check: a verified token passes; Siteverify gets the secret, token and client IP', async () => {

	const { fetch, requests } = fakeSiteverify( PASS );
	assertEqual( await Turnstile_Check( CONFIG, 'tok', '1.2.3.4', 'create_room', fetch ), null, 'passes' );
	assertEqual( requests.length, 1, 'one call' );
	assertEqual( requests[ 0 ].url, TURNSTILE_SITEVERIFY_URL, 'URL' );
	assertEqual( requests[ 0 ].init.method, 'POST', 'POST' );
	assertEqual( requests[ 0 ].body.get( 'secret' ), 'secret', 'secret' );
	assertEqual( requests[ 0 ].body.get( 'response' ), 'tok', 'token' );
	assertEqual( requests[ 0 ].body.get( 'remoteip' ), '1.2.3.4', 'client IP' );

	// The lobby's placeholder for a missing address isn't sent
	await Turnstile_Check( CONFIG, 'tok', 'unknown', 'create_room', fetch );
	assertEqual( requests[ 1 ].body.has( 'remoteip' ), false, 'no remoteip for unknown' );

	// Hostnames compare without case
	const upper = fakeSiteverify( { ...PASS, hostname: 'PLAY.example' } );
	assertEqual( await Turnstile_Verify( CONFIG, 'tok', '', 'create_room', upper.fetch ), true, 'case-insensitive hostname' );

} );

Deno.test( 'Turnstile_Verify: refuses every answer but success for the action and a listed hostname', async () => {

	const cases = [
		[ 'failure', { ...PASS, success: false, 'error-codes': [ 'timeout-or-duplicate' ] } ],
		[ 'wrong action', { ...PASS, action: 'login' } ],
		[ 'no action (test keys)', { success: true, hostname: 'anglezarke.games' } ],
		[ 'wrong hostname', { ...PASS, hostname: 'evil.example' } ],
		[ 'localhost not listed', { ...PASS, hostname: 'localhost' } ],
		[ 'no hostname', { success: true, action: TURNSTILE_ACTION_CREATE_ROOM } ],
		[ 'success not true', { ...PASS, success: 'true' } ],
		[ 'null body', null ],
	];
	for ( const [ label, result ] of cases ) {

		const { fetch } = fakeSiteverify( result );
		assertEqual( await Turnstile_Verify( CONFIG, 'tok', '1.2.3.4', 'create_room', fetch ), false, label );

	}

	const gate = await Turnstile_Check( CONFIG, 'tok', '1.2.3.4', 'create_room', fakeSiteverify( { success: false } ).fetch );
	assertEqual( gate.error, 'Verification failed. Try again.', 'refusal text' );

} );

Deno.test( 'Turnstile_Verify: fails closed on HTTP errors, bad JSON, network errors and missing settings', async () => {

	assertEqual( await Turnstile_Verify( CONFIG, 'tok', '', 'create_room', fakeSiteverify( PASS, { status: 500 } ).fetch ), false, 'HTTP 500' );
	assertEqual( await Turnstile_Verify( CONFIG, 'tok', '', 'create_room', () => Promise.resolve( new Response( 'not json' ) ) ), false, 'bad JSON' );
	assertEqual( await Turnstile_Verify( CONFIG, 'tok', '', 'create_room', () => Promise.reject( new TypeError( 'network down' ) ) ), false, 'network error' );

	// With a sitekey but no secret or hostnames, nothing passes, and
	// Siteverify isn't asked
	const { fetch, requests } = fakeSiteverify( PASS );
	assertEqual( await Turnstile_Verify( { ...CONFIG, secret: '' }, 'tok', '', 'create_room', fetch ), false, 'no secret' );
	assertEqual( await Turnstile_Verify( { ...CONFIG, hostnames: new Set() }, 'tok', '', 'create_room', fetch ), false, 'no hostnames' );

	// Malformed tokens never reach Siteverify
	assertEqual( await Turnstile_Verify( CONFIG, 'x'.repeat( TURNSTILE_MAX_TOKEN_LENGTH + 1 ), '', 'create_room', fetch ), false, 'too long' );
	assertEqual( await Turnstile_Verify( CONFIG, 42, '', 'create_room', fetch ), false, 'not a string' );
	assert( requests.length === 0, 'no Siteverify calls' );

} );
