// Tests for the browser-hosted room lobby (server/lobby_rtc.js): hosting,
// listing, joining, the signal relay and who may use it, limits, pruning,
// and restoring sessions after a Durable Object hibernates.

import {
	RtcLobby,
	RTC_LOBBY_LIMITS,
	RTC_ROOM_CODE_PATTERN,
	RTC_DEFAULT_ICE_SERVERS,
	LOBBY_HOST,
	LOBBY_JOIN,
	LOBBY_LIST,
	LOBBY_SIGNAL,
	LOBBY_HEARTBEAT,
	LOBBY_ROOMS,
	LOBBY_ERROR,
	LOBBY_ICE,
	LOBBY_SIGNAL_RELAY,
	LOBBY_VERIFY,
	Lobby_EncodeFrame,
	Lobby_DecodeFrame,
	Lobby_WantsRtcRooms,
	Lobby_FilterIceServers,
} from '../server/lobby_rtc.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function assert( condition, message ) {

	if ( condition !== true ) throw new Error( message );

}

function assertEqual( actual, expected, message ) {

	if ( actual !== expected ) throw new Error( `${message}: expected ${JSON.stringify( expected )}, got ${JSON.stringify( actual )}` );

}

function json( value ) {

	return encoder.encode( JSON.stringify( value ) );

}

function body( frame ) {

	const text = decoder.decode( frame.data );
	return frame.type === LOBBY_ERROR ? text : JSON.parse( text );

}

// A lobby with a hand-set clock and the given limits
function makeLobby( options = {} ) {

	return new RtcLobby( { ...options, limits: { ...RTC_LOBBY_LIMITS, ...( options.limits ?? {} ) } } );

}

async function host( lobby, sid, ip, config = {}, now = 0 ) {

	lobby.open( sid, ip, now );
	const frames = await lobby.handle( sid, LOBBY_HOST, json( config ), now );
	assertEqual( frames[ 0 ].type, LOBBY_ROOMS, 'host reply: ' + JSON.stringify( frames.map( body ) ) );
	return { frames, room: body( frames[ 0 ] ) };

}

async function join( lobby, sid, ip, code, now = 0 ) {

	lobby.open( sid, ip, now );
	return await lobby.handle( sid, LOBBY_JOIN, encoder.encode( code ), now );

}

function signal( lobby, sid, to, kind, data, now = 0 ) {

	return lobby.handle( sid, LOBBY_SIGNAL, json( { to, kind, data } ), now );

}

Deno.test( 'lobby frames: encode, decode, and reject malformed ones', () => {

	const frame = Lobby_EncodeFrame( 0x81, encoder.encode( 'hi' ) );
	assertEqual( Array.from( frame ).join( ',' ), '129,2,0,104,105', 'encoded' );
	const decoded = Lobby_DecodeFrame( frame );
	assertEqual( decoded.type, 0x81, 'type' );
	assertEqual( decoder.decode( decoded.data ), 'hi', 'payload' );
	assertEqual( Lobby_DecodeFrame( new Uint8Array( [ 1, 5, 0 ] ) ), null, 'short' );
	assertEqual( Lobby_DecodeFrame( new Uint8Array( [ 1 ] ) ), null, 'no header' );
	let threw = false;
	try {

		Lobby_EncodeFrame( 1, new Uint8Array( 0x10000 ) );

	} catch {

		threw = true;

	}

	assert( threw, 'oversized payload throws' );

} );

Deno.test( 'LOBBY_HOST registers a private room by default and replies with its record and ICE servers', async () => {

	const lobby = makeLobby();
	const { frames, room } = await host( lobby, 'h1', '10.0.0.1', {
		map: 'e1m1', maxPlayers: 99, hostName: ' Ann\u0007 ', options: { coop: 1, skill: 9, bogus: 1 }
	} );
	assert( RTC_ROOM_CODE_PATTERN.test( room.id ), '8-character code: ' + room.id );
	assertEqual( room.transport, 'rtc', 'transport' );
	assertEqual( room.map, 'e1m1', 'map' );
	assertEqual( room.maxPlayers, 16, 'maxPlayers clamped' );
	assertEqual( room.players, 1, 'the host' );
	assertEqual( room.hostName, 'Ann', 'name sanitized' );
	assertEqual( room.public, false, 'private by default' );
	assertEqual( JSON.stringify( room.options ), '{"coop":1,"skill":3}', 'options sanitized' );
	assertEqual( 'ip' in room, false, 'no IP in the record' );
	assertEqual( frames[ 1 ].type, LOBBY_ICE, 'ICE after the record' );
	assertEqual( JSON.stringify( body( frames[ 1 ] ) ), JSON.stringify( RTC_DEFAULT_ICE_SERVERS ), 'STUN by default' );
	assert( lobby.isLongLived( 'h1' ), 'host socket stays open' );
	assert( lobby.hasRoom( room.id ), 'room exists' );

	// One room per socket
	const again = await lobby.handle( 'h1', LOBBY_HOST, json( {} ), 0 );
	assertEqual( again[ 0 ].type, LOBBY_ERROR, 'second HOST refused' );

	// A bad map is refused before anything is registered
	lobby.open( 'h2', '10.0.0.2', 0 );
	const bad = await lobby.handle( 'h2', LOBBY_HOST, json( { map: '../x' } ), 0 );
	assertEqual( body( bad[ 0 ] ), 'Invalid map name', 'bad map' );
	assertEqual( lobby.isLongLived( 'h2' ), false, 'not a host' );

} );

Deno.test( 'LOBBY_LIST shows public browser-hosted rooms only to clients that ask', async () => {

	const lobby = makeLobby();
	const pub = ( await host( lobby, 'h1', '10.0.0.1', { public: true, hostName: 'Pub' } ) ).room;
	await host( lobby, 'h2', '10.0.0.2', { hostName: 'Secret' } );
	const rooms = lobby.listRooms( 0 );
	assertEqual( rooms.length, 1, 'one listed' );
	assertEqual( rooms[ 0 ].id, pub.id, 'the public one' );
	assertEqual( Lobby_WantsRtcRooms( new Uint8Array( 0 ) ), false, 'empty LIST' );
	assertEqual( Lobby_WantsRtcRooms( json( { rtc: true } ) ), true, '{ rtc: true }' );
	assertEqual( Lobby_WantsRtcRooms( encoder.encode( 'nope' ) ), false, 'garbage' );
	lobby.open( 'x', '10.0.0.3', 0 );
	assertEqual( await lobby.handle( 'x', LOBBY_LIST, new Uint8Array( 0 ), 0 ), null, 'LIST is the caller\'s' );

} );

Deno.test( 'signals are relayed between a room\'s host and its joiners, and nowhere else', async () => {

	const lobby = makeLobby();
	const room = ( await host( lobby, 'h1', '10.0.0.1', { maxPlayers: 4 } ) ).room;
	const other = ( await host( lobby, 'h2', '10.0.0.2', {} ) ).room;

	// The joiner uses a lower-case code; replies come back under it
	const alias = room.id.toLowerCase();
	const joined = await join( lobby, 'j1', '10.0.0.9', alias );
	assertEqual( joined[ 0 ].type, LOBBY_ROOMS, 'join reply' );
	assertEqual( body( joined[ 0 ] ).id, room.id, 'the room' );
	assertEqual( joined[ 1 ].type, LOBBY_ICE, 'ICE for the joiner' );
	assert( lobby.isLongLived( 'j1' ), 'joiner socket stays open' );

	const offer = await signal( lobby, 'j1', alias, 'offer', { type: 'offer', sdp: 'v=0' } );
	assertEqual( offer.length, 1, 'one frame' );
	assertEqual( offer[ 0 ].to, 'h1', 'to the host' );
	assertEqual( offer[ 0 ].type, LOBBY_SIGNAL_RELAY, 'relay' );
	const atHost = body( offer[ 0 ] );
	assert( /^p[A-Z2-9]{12}$/.test( atHost.from ), 'peer id: ' + atHost.from );
	assertEqual( atHost.kind, 'offer', 'kind' );
	assertEqual( atHost.data.sdp, 'v=0', 'data passed through' );

	const answer = await signal( lobby, 'h1', atHost.from, 'answer', { type: 'answer', sdp: 'v=0' } );
	assertEqual( answer[ 0 ].to, 'j1', 'to the joiner' );
	assertEqual( body( answer[ 0 ] ).from, alias, 'from the code the joiner used' );

	// Not relayed: another room, a peer of another room, an unknown kind,
	// a socket that hasn't joined
	assertEqual( ( await signal( lobby, 'j1', other.id, 'offer', {} ) ).length, 0, 'joiner to another room' );
	assertEqual( ( await signal( lobby, 'h2', atHost.from, 'answer', {} ) ).length, 0, 'host to another room\'s peer' );
	assertEqual( ( await signal( lobby, 'h1', 'pAAAAAAAAAAAA', 'answer', {} ) ).length, 0, 'unknown peer' );
	assertEqual( ( await signal( lobby, 'j1', alias, 'hello', {} ) ).length, 0, 'unknown kind' );
	lobby.open( 'nobody', '10.0.0.7', 0 );
	const stray = await signal( lobby, 'nobody', room.id, 'offer', {} );
	assertEqual( stray[ 0 ].type, LOBBY_ERROR, 'must join first' );

	// The host leaves: the joiner is told when it next signals
	lobby.close( 'h1' );
	assertEqual( lobby.hasRoom( room.id ), false, 'room gone with its host' );
	const late = await signal( lobby, 'j1', alias, 'candidate', { candidate: 'x', sdpMid: '0' } );
	assertEqual( body( late[ 0 ] ), 'Room not found. The game may have ended.', 'room gone' );

} );

Deno.test( 'LOBBY_JOIN: unknown and full rooms, other codes, and guessing', async () => {

	const lobby = makeLobby();
	const room = ( await host( lobby, 'h1', '10.0.0.1', { maxPlayers: 2 } ) ).room;

	assertEqual( await join( lobby, 'd1', '10.0.0.5', 'ABC123' ), null, 'a Deno room code is the caller\'s' );
	const missing = await join( lobby, 'm1', '10.0.0.5', 'ZZZZZZZZ' );
	assertEqual( body( missing[ 0 ] ), 'Room not found. The game may have ended.', 'unknown code' );
	assertEqual( lobby.isLongLived( 'm1' ), false, 'not kept open' );

	await lobby.handle( 'h1', LOBBY_HEARTBEAT, json( { players: 2 } ), 0 );
	const full = await join( lobby, 'f1', '10.0.0.5', room.id );
	assertEqual( body( full[ 0 ] ), 'Room is full (2/2 players)', 'full' );

	// Guessing private codes: misses are rate limited per IP
	const small = makeLobby( { limits: { joinMissesPerIpPerWindow: 3 } } );
	const guessed = ( await host( small, 'h', '10.0.0.1' ) ).room;
	for ( let i = 0; i < 3; i++ ) await join( small, 'g' + i, '10.0.0.6', 'ZZZZZZZ' + ( i + 2 ) );
	const blocked = await join( small, 'g9', '10.0.0.6', guessed.id );
	assertEqual( body( blocked[ 0 ] ), 'Too many attempts. Wait a minute and try again.', 'blocked even for a real code' );
	const later = await join( small, 'g10', '10.0.0.6', guessed.id, RTC_LOBBY_LIMITS.joinMissWindowMs );
	assertEqual( later[ 0 ].type, LOBBY_ROOMS, 'allowed after the window' );
	const elsewhere = await join( small, 'g11', '10.0.0.7', guessed.id );
	assertEqual( elsewhere[ 0 ].type, LOBBY_ROOMS, 'other IPs unaffected' );

} );

Deno.test( 'hosting limits: rooms per IP, creations per window, and the room cap', async () => {

	const lobby = makeLobby( { limits: { maxHostsPerIp: 2, hostsPerIpPerWindow: 3, maxRooms: 3 } } );
	await host( lobby, 'a', '10.0.0.1' );
	await host( lobby, 'b', '10.0.0.1' );
	lobby.open( 'c', '10.0.0.1', 0 );
	assertEqual( body( ( await lobby.handle( 'c', LOBBY_HOST, json( {} ), 0 ) )[ 0 ] ), 'You already host 2 rooms. Close one first.', 'per IP' );

	lobby.close( 'a' );
	await host( lobby, 'd', '10.0.0.1' );
	lobby.close( 'd' );
	lobby.open( 'e', '10.0.0.1', 0 );
	assertEqual( body( ( await lobby.handle( 'e', LOBBY_HOST, json( {} ), 0 ) )[ 0 ] ), 'Too many rooms created. Wait a minute and try again.', 'per window' );

	await host( lobby, 'f', '10.0.0.2' );
	await host( lobby, 'g', '10.0.0.3' );
	lobby.open( 'h', '10.0.0.4', 0 );
	assertEqual( body( ( await lobby.handle( 'h', LOBBY_HOST, json( {} ), 0 ) )[ 0 ] ), 'Room limit reached (3 rooms). Try again later.', 'room cap' );

	// Sockets per IP
	const few = makeLobby( { limits: { maxSessionsPerIp: 2 } } );
	few.open( 's1', '10.0.0.1', 0 );
	few.open( 's2', '10.0.0.1', 0 );
	assertEqual( few.canOpen( '10.0.0.1' ), false, 'per-IP socket cap' );
	assertEqual( few.canOpen( '10.0.0.2' ), true, 'another IP' );

} );

Deno.test( 'requests over their size cap are refused; signals may be larger', async () => {

	const lobby = makeLobby();
	const room = ( await host( lobby, 'h1', '10.0.0.1' ) ).room;
	await join( lobby, 'j1', '10.0.0.2', room.id );
	const sdp = 'a'.repeat( 8000 ); // a large offer: past maxRequestBytes, under maxSignalBytes
	const relayed = await signal( lobby, 'j1', room.id, 'offer', { type: 'offer', sdp } );
	assertEqual( relayed[ 0 ].type, LOBBY_SIGNAL_RELAY, 'large offer relayed' );
	const huge = await signal( lobby, 'j1', room.id, 'offer', { type: 'offer', sdp: 'a'.repeat( RTC_LOBBY_LIMITS.maxSignalBytes ) } );
	assertEqual( body( huge[ 0 ] ), 'Request too large', 'over the signal cap' );
	lobby.open( 'h2', '10.0.0.3', 0 );
	const bigHost = await lobby.handle( 'h2', LOBBY_HOST, json( { hostName: 'x'.repeat( 5000 ) } ), 0 );
	assertEqual( body( bigHost[ 0 ] ), 'Request too large', 'over the request cap' );

} );

Deno.test( 'prune drops silent hosts, joiners past their time and idle sockets; heartbeats keep a host', async () => {

	const lobby = makeLobby();
	const { heartbeatTimeoutMs, joinerLifetimeMs, requestTimeoutMs } = RTC_LOBBY_LIMITS;
	const kept = ( await host( lobby, 'kept', '10.0.0.1', { maxPlayers: 4 } ) ).room;
	const silent = ( await host( lobby, 'silent', '10.0.0.2' ) ).room;
	await join( lobby, 'j1', '10.0.0.3', kept.id );
	lobby.open( 'idle', '10.0.0.4', 0 );

	assertEqual( lobby.prune( requestTimeoutMs ).length, 0, 'nothing yet' );
	assertEqual( lobby.prune( requestTimeoutMs + 1 ).join(), 'idle', 'idle socket' );

	await lobby.handle( 'kept', LOBBY_HEARTBEAT, json( { players: 3 } ), heartbeatTimeoutMs - 1000 );
	assertEqual( lobby.listRooms( 0 ).length, 0, 'private rooms unlisted' );
	assertEqual( lobby.record( 'kept' ).room.players, 3, 'player count from the heartbeat' );

	const gone = lobby.prune( Math.max( heartbeatTimeoutMs, joinerLifetimeMs ) + 1 );
	assertEqual( gone.sort().join(), [ 'j1', 'silent' ].sort().join(), 'silent host and old joiner' );
	assertEqual( lobby.hasRoom( silent.id ), false, 'silent room gone' );
	assertEqual( lobby.hasRoom( kept.id ), true, 'kept room stays' );

	await lobby.handle( 'kept', LOBBY_HEARTBEAT, json( { players: 99 } ), 0 );
	assertEqual( lobby.record( 'kept' ).room.players, 4, 'players clamped to maxPlayers' );

} );

Deno.test( 'restore rebuilds hosts and joiners from their records', async () => {

	const before = makeLobby();
	const room = ( await host( before, 'h1', '10.0.0.1', { public: true } ) ).room;
	await join( before, 'j1', '10.0.0.2', room.id.toLowerCase() );
	before.open( 'idle', '10.0.0.3', 0 );
	const offer = await signal( before, 'j1', room.id.toLowerCase(), 'offer', { type: 'offer', sdp: 'v=0' } );
	const peerId = body( offer[ 0 ] ).from;

	// Records survive a JSON round trip (a Durable Object attachment)
	const records = [ 'h1', 'j1', 'idle' ].map( ( sid ) => [ sid, JSON.parse( JSON.stringify( before.record( sid ) ) ) ] );
	const after = makeLobby();
	for ( const [ sid, record ] of records ) after.restore( sid, record );

	assertEqual( after.listRooms( 0 ).length, 1, 'room listed again' );
	assert( after.isLongLived( 'h1' ) && after.isLongLived( 'j1' ), 'host and joiner' );
	assertEqual( after.isLongLived( 'idle' ), false, 'idle socket' );
	const answer = await signal( after, 'h1', peerId, 'answer', { type: 'answer', sdp: 'v=0' } );
	assertEqual( answer[ 0 ].to, 'j1', 'relayed after restore' );
	assertEqual( body( answer[ 0 ] ).from, room.id.toLowerCase(), 'alias kept' );

	after.restore( 'bad', { ip: 5 } );
	after.restore( 'bad2', null );
	assertEqual( after.sessions.has( 'bad' ) || after.sessions.has( 'bad2' ), false, 'malformed records ignored' );

} );

Deno.test( 'ICE servers: the caller\'s list, without port 53 TURN URLs; STUN when it fails', async () => {

	const filtered = Lobby_FilterIceServers( [
		{ urls: [ 'stun:stun.cloudflare.com:3478', 'stun:stun.cloudflare.com:53' ] },
		{ urls: [ 'turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:53?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp' ], username: 'u', credential: 'c', extra: 1 },
		{ urls: 'turn:turn.cloudflare.com:53' },
		null,
	] );
	assertEqual( JSON.stringify( filtered ), JSON.stringify( [
		{ urls: [ 'stun:stun.cloudflare.com:3478' ] },
		{ urls: [ 'turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp' ], username: 'u', credential: 'c' },
	] ), 'filtered' );

	const asked = [];
	const lobby = makeLobby( { iceServers: ( ip, role ) => {

		asked.push( ip + ' ' + role );
		return [ { urls: 'turn:t:3478', username: 'u', credential: 'c' } ];

	} } );
	const { frames, room } = await host( lobby, 'h1', '10.0.0.1' );
	assertEqual( body( frames[ 1 ] )[ 0 ].credential, 'c', 'host gets the credentials' );
	await join( lobby, 'j1', '10.0.0.2', room.id );
	assertEqual( asked.join( '|' ), '10.0.0.1 host|10.0.0.2 joiner', 'asked once per host and joiner' );

	// Nothing minted for a failed join or a bare socket
	await join( lobby, 'm1', '10.0.0.3', 'ZZZZZZZZ' );
	assertEqual( asked.length, 2, 'not for a failed join' );

	const failing = makeLobby( { iceServers: () => Promise.reject( new Error( 'down' ) ) } );
	const fallback = ( await host( failing, 'h1', '10.0.0.1' ) ).frames[ 1 ];
	assertEqual( JSON.stringify( body( fallback ) ), JSON.stringify( RTC_DEFAULT_ICE_SERVERS ), 'STUN on failure' );

} );

Deno.test( 'signals and heartbeats are rate limited per socket', async () => {

	const lobby = makeLobby( { limits: { messagesPerSessionPerWindow: 3 } } );
	const room = ( await host( lobby, 'h1', '10.0.0.1' ) ).room;
	await join( lobby, 'j1', '10.0.0.2', room.id );
	let relayed = 0;
	for ( let i = 0; i < 5; i++ ) relayed += ( await signal( lobby, 'j1', room.id, 'candidate', { candidate: 'c', sdpMid: '0' } ) ).length;
	assertEqual( relayed, 3, 'three relayed, the rest dropped' );
	const next = await signal( lobby, 'j1', room.id, 'candidate', { candidate: 'c', sdpMid: '0' }, RTC_LOBBY_LIMITS.messageWindowMs );
	assertEqual( next.length, 1, 'relayed again after the window' );

} );

Deno.test( 'LOBBY_JOIN: joiners still signalling count toward a full room, and joins are rate limited per IP', async () => {

	const lobby = makeLobby();
	const room = ( await host( lobby, 'h1', '10.0.0.1', { maxPlayers: 3 } ) ).room;
	assertEqual( ( await join( lobby, 'j1', '10.0.0.2', room.id ) )[ 0 ].type, LOBBY_ROOMS, 'first joiner' );
	assertEqual( ( await join( lobby, 'j2', '10.0.0.3', room.id ) )[ 0 ].type, LOBBY_ROOMS, 'second joiner' );
	const full = await join( lobby, 'j3', '10.0.0.4', room.id );
	assertEqual( body( full[ 0 ] ), 'Room is full (1/3 players)', 'host plus two pending joiners fill it' );
	lobby.close( 'j1' );
	assertEqual( ( await join( lobby, 'j4', '10.0.0.4', room.id ) )[ 0 ].type, LOBBY_ROOMS, 'a slot again once a joiner goes' );

	// Each successful JOIN may mint TURN credentials, so they are limited too
	const minted = [];
	const small = makeLobby( {
		limits: { joinsPerIpPerWindow: 2 },
		iceServers: ( _ip, role ) => {

			minted.push( role );
			return RTC_DEFAULT_ICE_SERVERS;

		},
	} );
	const code = ( await host( small, 'h', '10.0.0.1' ) ).room.id;
	for ( let i = 0; i < 2; i++ ) {

		assertEqual( ( await join( small, 'k' + i, '10.0.0.9', code ) )[ 0 ].type, LOBBY_ROOMS, 'join ' + i );
		small.close( 'k' + i );

	}
	const blocked = await join( small, 'k9', '10.0.0.9', code );
	assertEqual( body( blocked[ 0 ] ), 'Too many joins. Wait a minute and try again.', 'third join in the window' );
	assertEqual( minted.join( ',' ), 'host,joiner,joiner', 'no credentials for the refused join' );
	const later = await join( small, 'k10', '10.0.0.9', code, RTC_LOBBY_LIMITS.joinWindowMs );
	assertEqual( later[ 0 ].type, LOBBY_ROOMS, 'allowed after the window' );

} );

Deno.test( 'every frame on a host\'s socket is rate limited, and LOBBY_LIST is capped', async () => {

	const lobby = makeLobby( { limits: { messagesPerSessionPerWindow: 2, maxListedRooms: 2 } } );
	await host( lobby, 'h1', '10.0.0.1', { public: true } );
	assertEqual( await lobby.handle( 'h1', LOBBY_LIST, new Uint8Array( 0 ), 0 ), null, 'LIST is the caller\'s' );
	assertEqual( await lobby.handle( 'h1', 0x7f, new Uint8Array( 0 ), 0 ), null, 'unknown type is the caller\'s' );
	assertEqual( ( await lobby.handle( 'h1', LOBBY_LIST, new Uint8Array( 0 ), 0 ) ).length, 0, 'over the limit: no reply' );

	await host( lobby, 'h2', '10.0.0.2', { public: true } );
	await host( lobby, 'h3', '10.0.0.3', { public: true } );
	assertEqual( lobby.listRooms( 0 ).length, 2, 'at most maxListedRooms' );

} );

// A turnstile hook that records its calls and answers from verdict( token )
function fakeTurnstile( verdict ) {

	const calls = [];
	const turnstile = ( token, ip, action ) => {

		calls.push( { token, ip, action } );
		return Promise.resolve( verdict( token ) );

	};
	return { turnstile, calls };

}

const CHALLENGE = { sitekey: 'sitekey', action: 'create_room' };

function turnstileVerdict( token ) {

	if ( token === undefined ) return { challenge: CHALLENGE };
	return token === 'good' ? null : { error: 'Verification failed. Try again.' };

}

Deno.test( 'LOBBY_HOST with Turnstile: no token gets LOBBY_VERIFY, a good token hosts, a bad one is refused', async () => {

	const { turnstile, calls } = fakeTurnstile( turnstileVerdict );
	const lobby = makeLobby( { turnstile } );

	lobby.open( 'h1', '10.0.0.1', 0 );
	const asked = await lobby.handle( 'h1', LOBBY_HOST, json( { map: 'e1m1' } ), 0 );
	assertEqual( asked.length, 1, 'one frame' );
	assertEqual( asked[ 0 ].type, LOBBY_VERIFY, 'LOBBY_VERIFY' );
	assertEqual( JSON.stringify( body( asked[ 0 ] ) ), JSON.stringify( CHALLENGE ), 'challenge' );
	assertEqual( lobby.rooms.size, 0, 'no room yet' );
	assertEqual( lobby.sessions.get( 'h1' ).role, null, 'still no role' );

	lobby.open( 'h2', '10.0.0.1', 0 );
	const refused = await lobby.handle( 'h2', LOBBY_HOST, json( { turnstile: 'bad' } ), 0 );
	assertEqual( refused[ 0 ].type, LOBBY_ERROR, 'refused' );
	assertEqual( body( refused[ 0 ] ), 'Verification failed. Try again.', 'refusal text' );
	assertEqual( lobby.rooms.size, 0, 'no room' );

	const { room } = await host( lobby, 'h3', '10.0.0.1', { map: 'e1m1', turnstile: 'good' } );
	assert( RTC_ROOM_CODE_PATTERN.test( room.id ), 'hosted' );
	assertEqual( room.turnstile, undefined, 'token not in the room record' );
	assertEqual( calls.map( ( c ) => c.token ?? '-' ).join( ',' ), '-,bad,good', 'tokens checked' );
	assertEqual( calls[ 2 ].ip, '10.0.0.1', 'client IP' );
	assertEqual( calls[ 2 ].action, 'create_room', 'action' );

} );

Deno.test( 'LOBBY_HOST with Turnstile: each token spends host budget once, and a token-less request spends none', async () => {

	const { turnstile, calls } = fakeTurnstile( turnstileVerdict );
	const lobby = makeLobby( { turnstile, limits: { hostsPerIpPerWindow: 2, maxHostsPerIp: 5 } } );

	for ( let i = 0; i < 5; i++ ) {

		lobby.open( 'ask' + i, '10.0.0.2', 0 );
		assertEqual( ( await lobby.handle( 'ask' + i, LOBBY_HOST, json( {} ), 0 ) )[ 0 ].type, LOBBY_VERIFY, 'challenge ' + i );

	}

	lobby.open( 'bad', '10.0.0.2', 0 );
	await lobby.handle( 'bad', LOBBY_HOST, json( { turnstile: 'bad' } ), 0 );
	await host( lobby, 'good', '10.0.0.2', { turnstile: 'good' } );

	// One bad and one good token spent the budget of 2: the next is
	// refused before Siteverify
	lobby.open( 'over', '10.0.0.2', 0 );
	const over = await lobby.handle( 'over', LOBBY_HOST, json( { turnstile: 'good' } ), 0 );
	assertEqual( body( over[ 0 ] ), 'Too many rooms created. Wait a minute and try again.', 'rate limited' );
	assertEqual( calls.length, 7, 'no Siteverify call over the limit' );

} );

Deno.test( 'LOBBY_HOST with Turnstile: a socket that closes while Siteverify answers gets no room', async () => {

	let release = null;
	const lobby = makeLobby( { turnstile: () => new Promise( ( resolve ) => {

		release = resolve;

	} ) } );

	lobby.open( 'h1', '10.0.0.3', 0 );
	const pending = lobby.handle( 'h1', LOBBY_HOST, json( { turnstile: 'good' } ), 0 );
	lobby.close( 'h1' );
	release( null );
	assertEqual( ( await pending ).length, 0, 'no frames' );
	assertEqual( lobby.rooms.size, 0, 'no room' );

} );
