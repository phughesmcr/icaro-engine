// Tests for the Deno lobby/room server (server/lobby_server.js,
// server/room_process_manager.ts, server/sys_server.ts) and the quiet-log
// filter in src/sys.js.

import assert from 'node:assert/strict';
import {
	encodeFrame,
	parseCreateConfig,
	createRateLimiter,
	checkCreateAllowed,
	LIMITS,
	MAX_FRAME_PAYLOAD,
	routeLobbyRequest,
	serveLobbySocket,
	proxyGameSocket,
} from '../server/lobby_server.js';
import { WS_ClientAddress } from '../server/client_address.ts';
import { createFakeWebSocketPair, OPEN as WS_OPEN, CLOSED as WS_CLOSED } from './fake_websocket.js';
import {
	createLineSplitter,
	parseRoomStatusLine,
	formatRoomStatusLine,
	RoomManager_ClampMaxPlayers,
	RoomManager_SanitizeHostName,
	RoomManager_SanitizeMapName,
	RoomManager_SanitizeGameOptions,
	RoomManager_SetConfig,
	RoomManager_CreateRoom,
	RoomManager_GetRoom,
	RoomManager_HasRoom,
	RoomManager_CleanupIdleRooms,
	RoomManager_TerminateRoom,
	RoomManager_ShutdownAll,
	MAX_HOST_NAME_BYTES,
	MAX_PLAYERS_LIMIT,
} from '../server/room_process_manager.ts';
import { Sys_Printf as Sys_Printf_Server } from '../server/sys_server.ts';
import { Sys_Printf as Sys_Printf_Engine } from '../src/sys.js';

const encoder = new TextEncoder();

function captureConsoleLog( fn ) {
	const lines = [];
	const original = console.log;
	console.log = ( ...args ) => lines.push( args.join( ' ' ) );
	try {
		fn();
	} finally {
		console.log = original;
	}
	return lines;
}

async function captureConsoleLogAsync( fn ) {
	const lines = [];
	const original = console.log;
	console.log = ( ...args ) => lines.push( args.join( ' ' ) );
	try {
		await fn();
	} finally {
		console.log = original;
	}
	return lines;
}

Deno.test( 'encodeFrame rejects payloads over 65535 bytes (SRV-3)', () => {
	const ok = encodeFrame( 0x81, new Uint8Array( MAX_FRAME_PAYLOAD ) );
	assert.equal( ok.length, MAX_FRAME_PAYLOAD + 3 );
	assert.equal( ok[ 1 ] | ( ok[ 2 ] << 8 ), MAX_FRAME_PAYLOAD );
	assert.throws( () => encodeFrame( 0x81, new Uint8Array( MAX_FRAME_PAYLOAD + 1 ) ), RangeError );
} );

Deno.test( 'maxPlayers is clamped to an integer in 1..16 (SRV-2)', () => {
	assert.equal( RoomManager_ClampMaxPlayers( 1e9 ), MAX_PLAYERS_LIMIT );
	assert.equal( RoomManager_ClampMaxPlayers( -5 ), 1 );
	assert.equal( RoomManager_ClampMaxPlayers( 0 ), 1 );
	assert.equal( RoomManager_ClampMaxPlayers( 2.7 ), 2 );
	assert.equal( RoomManager_ClampMaxPlayers( '8' ), 8 );
	assert.equal( RoomManager_ClampMaxPlayers( NaN ), 4 );
	assert.equal( RoomManager_ClampMaxPlayers( Infinity ), 4 );
	assert.equal( RoomManager_ClampMaxPlayers( 'abc' ), 4 );
	assert.equal( RoomManager_ClampMaxPlayers( { valueOf: () => 1e9 } ), 4 );
} );

Deno.test( 'hostName is sanitised and capped by UTF-8 bytes (SRV-3)', () => {
	assert.equal( RoomManager_SanitizeHostName( 'x'.repeat( 60000 ) ), 'x'.repeat( MAX_HOST_NAME_BYTES ) );
	assert.equal( RoomManager_SanitizeHostName( 'a\u0000b\nc\u001bd e' ), 'abcde' );
	assert.equal( RoomManager_SanitizeHostName( '  two   words ' ), 'two words' );
	assert.equal( RoomManager_SanitizeHostName( '' ), 'Player' );
	assert.equal( RoomManager_SanitizeHostName( 42 ), 'Player' );
	// 4-byte code points must not be split
	const emoji = '\u{1F600}'.repeat( 20 );
	const out = RoomManager_SanitizeHostName( emoji );
	assert.ok( encoder.encode( out ).length <= MAX_HOST_NAME_BYTES );
	assert.equal( out, '\u{1F600}'.repeat( MAX_HOST_NAME_BYTES / 4 ) );
} );

Deno.test( 'map names are validated', () => {
	assert.equal( RoomManager_SanitizeMapName( 'e1m1' ), 'e1m1' );
	assert.equal( RoomManager_SanitizeMapName( '../e1m1' ), null );
	assert.equal( RoomManager_SanitizeMapName( '-flag' ), null );
	assert.equal( RoomManager_SanitizeMapName( 'a'.repeat( 33 ) ), null );
	assert.equal( RoomManager_SanitizeMapName( '' ), null );
	assert.equal( RoomManager_SanitizeMapName( 7 ), null );
} );

Deno.test( 'parseCreateConfig validates LOBBY_CREATE payloads (SRV-2, SRV-3)', () => {
	const parse = ( obj ) => parseCreateConfig( encoder.encode( JSON.stringify( obj ) ) );
	assert.deepEqual( parse( { map: 'e1m1', maxPlayers: 1e9, hostName: 'h'.repeat( 70000 ) } ), {
		map: 'e1m1', maxPlayers: 16, hostName: 'h'.repeat( MAX_HOST_NAME_BYTES ),
	} );
	assert.deepEqual( parse( {} ), { map: 'rapture1', maxPlayers: undefined, hostName: 'Player' } );
	assert.throws( () => parse( { map: 'bad/map' } ), /Invalid map name/ );
	assert.throws( () => parse( [ 1 ] ), /Invalid room config/ );
	assert.throws( () => parse( null ), /Invalid room config/ );
	assert.throws( () => parseCreateConfig( encoder.encode( '{' ) ), /Invalid room config/ );
} );

Deno.test( 'game options are whitelisted and clamped to the Game Options menu ranges (MENU-4)', () => {
	const parse = ( options ) => parseCreateConfig( encoder.encode( JSON.stringify( { map: 'e1m1', options } ) ) ).gameOptions;
	const all = { coop: 1, teamplay: 2, skill: 3, fraglimit: 100, timelimit: 60 };
	assert.deepEqual( parse( all ), all );
	assert.deepEqual( parse( { coop: 0, teamplay: 0, skill: 0, fraglimit: 0, timelimit: 0 } ),
		{ coop: 0, teamplay: 0, skill: 0, fraglimit: 0, timelimit: 0 } );

	// Out of range clamps; fractions truncate; -0 becomes 0
	assert.deepEqual( parse( { coop: 7, teamplay: 99, skill: -4, fraglimit: 1e300, timelimit: -1e300 } ),
		{ coop: 1, teamplay: 2, skill: 0, fraglimit: 100, timelimit: 0 } );
	assert.deepEqual( parse( { skill: 2.9, fraglimit: -0.5 } ), { skill: 2, fraglimit: 0 } );
	assert.ok( Object.is( parse( { fraglimit: -0.5 } ).fraglimit, 0 ) );

	// Anything that is not a finite number is dropped, field by field
	const hostile = {
		coop: '1; quit', teamplay: '"; map e1m1 "', skill: 'x\nquit', fraglimit: null,
		timelimit: NaN, extra: 'rm -rf', '__proto__': { skill: 3 }, 'constructor': 1,
	};
	assert.equal( parse( hostile ), undefined );
	assert.deepEqual( parse( { ...hostile, skill: 2 } ), { skill: 2 } );
	assert.deepEqual( parse( { skill: Infinity, timelimit: -Infinity, coop: [ 1 ], teamplay: { a: 1 }, fraglimit: true } ), undefined );
	assert.deepEqual( parse( { skill: 1, bogus: 5 } ), { skill: 1 } );

	// Missing, empty or non-object options: no gameOptions key at all
	for ( const options of [ undefined, null, {}, [], [ 1, 2 ], 'skill=3', 7, true ] ) {
		const config = parseCreateConfig( encoder.encode( JSON.stringify( { map: 'e1m1', options } ) ) );
		assert.equal( 'gameOptions' in config, false );
	}
	assert.deepEqual( parse( { skill: 3 } ), { skill: 3 } );

	// The same function guards RoomManager_CreateRoom, whatever the caller passes
	assert.deepEqual( RoomManager_SanitizeGameOptions( { skill: 9 } ), { skill: 3 } );
	assert.equal( RoomManager_SanitizeGameOptions( 'skill' ), undefined );

	// Teamplay 3..6 are Rogue modes (menu.c: count = rogue ? 6 : 2)
	RoomManager_SetConfig( { gameFlags: [ '-rogue' ] } );
	try {
		assert.deepEqual( parse( { teamplay: 99 } ), { teamplay: 6 } );
	} finally {
		RoomManager_SetConfig( { gameFlags: [] } );
	}
	assert.deepEqual( parse( { teamplay: 99 } ), { teamplay: 2 } );
} );

Deno.test( 'rate limiter enforces a sliding window per key (SRV-2)', () => {
	const limiter = createRateLimiter( 2, 1000 );
	assert.equal( limiter.tryTake( 'a', 0 ), true );
	assert.equal( limiter.tryTake( 'a', 10 ), true );
	assert.equal( limiter.tryTake( 'a', 20 ), false );
	assert.equal( limiter.tryTake( 'b', 20 ), true );
	assert.equal( limiter.tryTake( 'a', 1000 ), true ); // first hit expired
	assert.equal( limiter.tryTake( 'a', 1005 ), false );
	limiter.tryTake( 'c', 5000 ); // prunes expired keys
	assert.equal( limiter.size(), 1 );
	assert.equal( limiter.canTake( 'c', 5000 ), true );
	assert.equal( limiter.canTake( 'c', 5000 ), true ); // canTake records nothing
} );

Deno.test( 'room creation is limited per IP and globally (SRV-2)', () => {
	const t = 1e12; // fixed clock, far from other tests' hits
	for ( let i = 0; i < LIMITS.createsPerIpPerWindow; i++ ) {
		assert.equal( checkCreateAllowed( '10.0.0.1', t ), null );
	}
	assert.match( checkCreateAllowed( '10.0.0.1', t ), /Too many rooms created/ );
	// Fill the global budget from other IPs
	let n = LIMITS.createsPerIpPerWindow;
	for ( let ip = 2; n < LIMITS.createsGlobalPerWindow; ip++ ) {
		assert.equal( checkCreateAllowed( '10.0.0.' + ip, t ), null );
		n++;
	}
	assert.match( checkCreateAllowed( '10.0.0.99', t ), /busy/ );
	// A global rejection must not spend the IP's own budget
	const later = t + LIMITS.createWindowMs;
	for ( let i = 0; i < LIMITS.createsPerIpPerWindow; i++ ) {
		assert.equal( checkCreateAllowed( '10.0.0.99', later ), null );
	}
} );

Deno.test( 'line splitter handles split lines and split UTF-8 (SRV-5)', () => {
	const lines = [];
	const splitter = createLineSplitter( ( line ) => lines.push( line ) );
	const bytes = encoder.encode( 'first line\r\nsecond é\u{1F600} line\nthird' );
	// Feed one byte at a time so every multi-byte character is split
	for ( const b of bytes ) splitter.push( new Uint8Array( [ b ] ) );
	assert.deepEqual( lines, [ 'first line', 'second é\u{1F600} line' ] );
	splitter.flush();
	assert.deepEqual( lines, [ 'first line', 'second é\u{1F600} line', 'third' ] );
} );

Deno.test( 'status lines need the prefix at line start and the right nonce (SRV-1)', () => {
	const nonce = 'abc123';
	const line = formatRoomStatusLine( nonce, { players: 3, active: true } );
	assert.deepEqual( parseRoomStatusLine( line, nonce ), { players: 3, active: true } );
	assert.equal( parseRoomStatusLine( line, 'other' ), null );
	assert.equal( parseRoomStatusLine( 'Client x ' + line, nonce ), null );
	assert.equal( parseRoomStatusLine( '@@ICARO_STATUS abc123 {"players":-1,"active":true}', nonce ), null );
	assert.equal( parseRoomStatusLine( '@@ICARO_STATUS abc123 {"players":1.5,"active":true}', nonce ), null );
	assert.equal( parseRoomStatusLine( '@@ICARO_STATUS abc123 {"players":1}', nonce ), null );
	assert.equal( parseRoomStatusLine( '@@ICARO_STATUS abc123 not json', nonce ), null );
} );

Deno.test( 'server Sys_Printf does not expand $& in arguments (SRV-5)', () => {
	const lines = captureConsoleLog( () => Sys_Printf_Server( 'Room %s for %s', '$&$1$$', "$'" ) );
	assert.deepEqual( lines, [ "Room $&$1$$ for $'" ] );
} );

Deno.test( 'quiet logs keep [Heartbeat] lines (SRV-1)', () => {
	const previous = globalThis.__ICARO_QUIET_LOGS;
	globalThis.__ICARO_QUIET_LOGS = true;
	try {
		const lines = captureConsoleLog( () => {
			Sys_Printf_Engine( '[Heartbeat] time=30 frames=600 players=2\n' );
			Sys_Printf_Engine( '[GameLoop] Call #1\n' );
		} );
		assert.equal( lines.length, 1 );
		assert.match( lines[ 0 ], /^\[Heartbeat\]/ );
	} finally {
		globalThis.__ICARO_QUIET_LOGS = previous;
	}
} );

// Spawns a fake room server and drives it through a temp file, so it needs
// run access to the fixture, write access and the FAKE_ROOM_* env vars
// (`deno task test` grants them; it is skipped when they are missing).
const fake = new URL( './fixtures/fake_room_server.sh', import.meta.url ).pathname;
const canRun = ( await Deno.permissions.query( { name: 'run', command: fake } ) ).state === 'granted' &&
	( await Deno.permissions.query( { name: 'write' } ) ).state === 'granted' &&
	( await Deno.permissions.query( { name: 'env', variable: 'FAKE_ROOM_PLAYERS_FILE' } ) ).state === 'granted' &&
	( await Deno.permissions.query( { name: 'env', variable: 'FAKE_ROOM_ARGS_FILE' } ) ).state === 'granted';

async function waitFor( predicate, timeoutMs = 5000 ) {
	const start = Date.now();
	while ( predicate() !== true ) {
		if ( Date.now() - start > timeoutMs ) throw new Error( 'waitFor timed out' );
		await new Promise( ( r ) => setTimeout( r, 25 ) );
	}
}

Deno.test( {
	name: 'room manager tracks player counts and guards the exit handler (SRV-1, SRV-5)',
	ignore: canRun === false,
	sanitizeOps: false,
	sanitizeResources: false,
	async fn() {
		const playersFile = await Deno.makeTempFile();
		Deno.env.set( 'FAKE_ROOM_PLAYERS_FILE', playersFile );
		RoomManager_SetConfig( { denoPath: fake } );
		const silence = console.log;
		console.log = () => {};
		try {
			await Deno.writeTextFile( playersFile, '2' );
			const pending = RoomManager_CreateRoom( { map: 'e1m1', maxPlayers: 99, hostName: 'host', specificId: 'TEST01' } );
			// Not joinable or listed until it has started
			assert.equal( RoomManager_HasRoom( 'TEST01' ), true );
			assert.equal( RoomManager_GetRoom( 'TEST01' ), null );
			const a = await pending;
			assert.ok( a !== null, 'room should start' );
			assert.equal( RoomManager_GetRoom( 'TEST01' ).maxPlayers, 16 );
			await waitFor( () => RoomManager_GetRoom( 'TEST01' ).playerCount === 2 );

			// A room with players is never reaped, however old
			assert.equal( RoomManager_CleanupIdleRooms( 0 ), 0 );
			assert.ok( RoomManager_GetRoom( 'TEST01' ) !== null );

			// Terminate and immediately recreate the same id. The old process
			// exits ~300ms after SIGTERM; its exit handler must not remove
			// the new room, and its port stays reserved until it exits.
			assert.equal( RoomManager_TerminateRoom( 'TEST01' ), true );
			const b = await RoomManager_CreateRoom( { map: 'e1m1', maxPlayers: 4, hostName: 'host', specificId: 'TEST01' } );
			assert.ok( b !== null );
			assert.notEqual( b.port, a.port );
			await new Promise( ( r ) => setTimeout( r, 600 ) );
			assert.ok( RoomManager_GetRoom( 'TEST01' ) !== null, 'new room survives old exit handler' );

			// The old room's port is free again once its process has exited
			const c = await RoomManager_CreateRoom( { map: 'e1m1', maxPlayers: 4, hostName: 'host', specificId: 'TEST02' } );
			assert.ok( c !== null );
			assert.equal( c.port, a.port );
			assert.equal( RoomManager_TerminateRoom( 'TEST02' ), true );

			// With zero players the room is reaped
			await Deno.writeTextFile( playersFile, '0' );
			await waitFor( () => RoomManager_GetRoom( 'TEST01' ).playerCount === 0 );
			assert.equal( RoomManager_CleanupIdleRooms( 0 ), 1 );
			assert.equal( RoomManager_GetRoom( 'TEST01' ), null );
		} finally {
			RoomManager_ShutdownAll();
			console.log = silence;
			Deno.env.delete( 'FAKE_ROOM_PLAYERS_FILE' );
			await new Promise( ( r ) => setTimeout( r, 600 ) );
			await Deno.remove( playersFile );
		}
	},
} );

Deno.test( {
	name: 'room manager passes validated game options to the room process (MENU-4)',
	ignore: canRun === false,
	sanitizeOps: false,
	sanitizeResources: false,
	async fn() {
		const argsFile = await Deno.makeTempFile();
		Deno.env.set( 'FAKE_ROOM_ARGS_FILE', argsFile );
		RoomManager_SetConfig( { denoPath: fake } );
		const silence = console.log;
		console.log = () => {};
		try {
			// Through the lobby's parser, as LOBBY_CREATE does
			const payload = { map: 'e1m1', maxPlayers: 4, hostName: 'host', options: {
				coop: 1, teamplay: '1; quit', skill: 99, fraglimit: -5, timelimit: 15.9, evil: '-exec',
			} };
			const config = parseCreateConfig( encoder.encode( JSON.stringify( payload ) ) );
			const room = await RoomManager_CreateRoom( { ...config, owner: '1.2.3.4', specificId: 'OPT001' } );
			assert.ok( room !== null, 'room should start' );
			let args = ( await Deno.readTextFile( argsFile ) ).split( '\n' );
			const i = args.indexOf( '-coop' );
			assert.deepEqual( args.slice( i, i + 8 ), [ '-coop', '1', '-skill', '3', '-fraglimit', '0', '-timelimit', '15' ] );
			assert.equal( args.includes( '-teamplay' ), false, 'invalid field dropped' );
			assert.equal( args.some( ( a ) => a.includes( 'quit' ) || a.includes( 'evil' ) || a === '-exec' ), false );
			RoomManager_TerminateRoom( 'OPT001' );

			// RoomManager_CreateRoom re-validates what its caller hands it
			await new Promise( ( r ) => setTimeout( r, 600 ) );
			const raw = { skill: '3; quit', coop: 5, teamplay: 'x\n-exec' };
			const room2 = await RoomManager_CreateRoom( { map: 'e1m1', maxPlayers: 4, hostName: 'host', gameOptions: raw, specificId: 'OPT002' } );
			assert.ok( room2 !== null );
			args = ( await Deno.readTextFile( argsFile ) ).split( '\n' );
			const j = args.indexOf( '-coop' );
			assert.equal( args[ j + 1 ], '1' );
			assert.equal( args.includes( '-skill' ), false );
			assert.equal( args.includes( '-teamplay' ), false );
			RoomManager_TerminateRoom( 'OPT002' );

			// No options: nothing extra on the command line, as before
			await new Promise( ( r ) => setTimeout( r, 600 ) );
			const room3 = await RoomManager_CreateRoom( { map: 'e1m1', maxPlayers: 4, hostName: 'host', specificId: 'OPT003' } );
			assert.ok( room3 !== null );
			args = ( await Deno.readTextFile( argsFile ) ).split( '\n' );
			for ( const name of [ '-coop', '-teamplay', '-skill', '-fraglimit', '-timelimit' ] ) {
				assert.equal( args.includes( name ), false, name );
			}
		} finally {
			RoomManager_ShutdownAll();
			console.log = silence;
			Deno.env.delete( 'FAKE_ROOM_ARGS_FILE' );
			await new Promise( ( r ) => setTimeout( r, 600 ) );
			await Deno.remove( argsFile );
		}
	},
} );

Deno.test( {
	name: 'room manager passes -rogue/-hipnotic and the game dir read grant to rooms',
	ignore: canRun === false,
	sanitizeOps: false,
	sanitizeResources: false,
	async fn() {
		const argsFile = await Deno.makeTempFile();
		Deno.env.set( 'FAKE_ROOM_ARGS_FILE', argsFile );
		RoomManager_SetConfig( { denoPath: fake, pakPath: '/data/quake/pak0.pak', gameFlags: [ '-rogue', '-evil' ] } );
		const silence = console.log;
		console.log = () => {};
		try {
			const room = await RoomManager_CreateRoom( { map: 'e1m1', maxPlayers: 4, hostName: 'host', specificId: 'GAME01' } );
			assert.ok( room !== null, 'room should start' );
			const args = ( await Deno.readTextFile( argsFile ) ).split( '\n' );
			assert.ok( args.includes( '-rogue' ), 'flag forwarded' );
			assert.ok( args.includes( '-evil' ) === false, 'unknown flags filtered out' );
			const allowRead = args.find( ( a ) => a.startsWith( '--allow-read=' ) ).split( ',' );
			assert.ok( allowRead.includes( '/data/quake/rogue' ), 'game dir next to the pak is readable' );
			// quic_listen.ts binds [::] and 0.0.0.0 on the room's port
			assert.ok(
				args.some( ( a ) => /^--allow-net=\[::\]:(\d+),0\.0\.0\.0:\1$/.test( a ) ),
				'room may listen on IPv6 and IPv4',
			);
		} finally {
			RoomManager_ShutdownAll();
			RoomManager_SetConfig( { pakPath: '../static/pak0.pak', gameFlags: [] } );
			console.log = silence;
			Deno.env.delete( 'FAKE_ROOM_ARGS_FILE' );
			await new Promise( ( r ) => setTimeout( r, 600 ) );
			await Deno.remove( argsFile );
		}
	},
} );

Deno.test( {
	name: 'room manager gives rooms a loopback WebSocket listener when the lobby has one',
	ignore: canRun === false,
	sanitizeOps: false,
	sanitizeResources: false,
	async fn() {
		const argsFile = await Deno.makeTempFile();
		Deno.env.set( 'FAKE_ROOM_ARGS_FILE', argsFile );
		RoomManager_SetConfig( { denoPath: fake, wsEnabled: true } );
		const silence = console.log;
		console.log = () => {};
		try {
			const room = await RoomManager_CreateRoom( { map: 'e1m1', maxPlayers: 4, hostName: 'host', specificId: 'WSRM01' } );
			assert.ok( room !== null, 'room should start' );
			const args = ( await Deno.readTextFile( argsFile ) ).split( '\n' );
			const wsport = args.indexOf( '-wsport' );
			assert.ok( wsport !== -1, '-wsport passed' );
			assert.equal( args[ wsport + 1 ], String( room.port ), 'on the room port' );
			assert.ok(
				args.includes( '--allow-net=[::]:' + room.port + ',0.0.0.0:' + room.port + ',127.0.0.1:' + room.port ),
				'room may listen on loopback too',
			);
		} finally {
			RoomManager_ShutdownAll();
			RoomManager_SetConfig( { wsEnabled: false } );
			console.log = silence;
			Deno.env.delete( 'FAKE_ROOM_ARGS_FILE' );
			await new Promise( ( r ) => setTimeout( r, 600 ) );
			await Deno.remove( argsFile );
		}
	},
} );

Deno.test( 'routeLobbyRequest matches the path tail under any prefix', () => {
	assert.deepEqual( routeLobbyRequest( '/lobby' ), { kind: 'lobby' } );
	assert.deepEqual( routeLobbyRequest( '/mp/lobby/' ), { kind: 'lobby' } );
	assert.deepEqual( routeLobbyRequest( '/mp/room/abc123' ), { kind: 'room', roomId: 'ABC123' } );
	assert.deepEqual( routeLobbyRequest( '/room/ABC123/' ), { kind: 'room', roomId: 'ABC123' } );
	assert.deepEqual( routeLobbyRequest( '/room/' ), { kind: 'other' } );
	assert.deepEqual( routeLobbyRequest( '/room/ABC-123' ), { kind: 'other' } );
	assert.deepEqual( routeLobbyRequest( '/' ), { kind: 'other' } );
	assert.deepEqual( routeLobbyRequest( '/mp/lobbyx' ), { kind: 'other' } );
} );

Deno.test( 'WS_ClientAddress trusts forwarded addresses only from loopback', () => {
	const url = new URL( 'ws://127.0.0.1:4500/?ip=203.0.113.9' );
	const cf = new Headers( { 'cf-connecting-ip': '198.51.100.7' } );
	const none = new Headers();
	assert.equal( WS_ClientAddress( url, none, '127.0.0.1', true ), '203.0.113.9', '?ip= from the lobby proxy' );
	assert.equal( WS_ClientAddress( url, cf, '127.0.0.1', false ), '198.51.100.7', 'CF-Connecting-IP when ?ip= is not trusted' );
	assert.equal( WS_ClientAddress( url, none, '127.0.0.1', false ), '127.0.0.1', 'loopback with nothing forwarded' );
	assert.equal( WS_ClientAddress( url, cf, '192.0.2.4', true ), '192.0.2.4', 'a remote peer cannot forward' );
	assert.equal( WS_ClientAddress( url, cf, '::1', false ), '198.51.100.7', 'IPv6 loopback' );
	assert.equal( WS_ClientAddress( new URL( 'ws://x/?ip=evil%20value' ), none, '127.0.0.1', true ), '127.0.0.1', 'malformed ?ip= ignored' );
	assert.equal( WS_ClientAddress( url, new Headers( { 'cf-connecting-ip': 'not an ip' } ), '127.0.0.1', false ), '127.0.0.1', 'malformed header ignored' );
} );

function waitUntil( predicate, label ) {
	return waitFor( predicate, 2000 ).catch( () => {
		throw new Error( 'timed out waiting for ' + label );
	} );
}

Deno.test( 'serveLobbySocket answers one LIST frame and closes', async () => {
	const pair = createFakeWebSocketPair( 'ws://127.0.0.1:4433/lobby' );
	let released = 0;
	const replies = [];
	pair.client.readyState = WS_OPEN;
	pair.client.onmessage = ( event ) => replies.push( new Uint8Array( event.data ) );
	await captureConsoleLogAsync( async () => {
		serveLobbySocket( pair.server, '10.0.0.1', '10.0.0.1:1', () => released++ );
		pair.client.send( encodeFrame( 0x01, new Uint8Array( 0 ) ) );
		await waitUntil( () => pair.client.readyState === WS_CLOSED, 'lobby socket close' );
	} );
	assert.equal( replies.length, 1, 'one reply' );
	assert.equal( replies[ 0 ][ 0 ], 0x81, 'LOBBY_ROOMS' );
	const length = replies[ 0 ][ 1 ] | ( replies[ 0 ][ 2 ] << 8 );
	assert.ok( Array.isArray( JSON.parse( new TextDecoder().decode( replies[ 0 ].subarray( 3, 3 + length ) ) ) ), 'room list' );
	assert.equal( released, 1, 'session released once' );
} );

Deno.test( 'serveLobbySocket closes on a malformed frame', async () => {
	const pair = createFakeWebSocketPair();
	let released = 0;
	pair.client.readyState = WS_OPEN;
	await captureConsoleLogAsync( async () => {
		serveLobbySocket( pair.server, '10.0.0.1', '10.0.0.1:1', () => released++ );
		pair.client.send( new Uint8Array( [ 0x01, 5, 0 ] ) );
		await waitUntil( () => pair.client.readyState === WS_CLOSED, 'close' );
	} );
	assert.deepEqual( pair.server.closeCalls, [ 1002 ], 'protocol error close' );
	assert.equal( released, 1, 'released' );
} );

// A browser <-> lobby pair and a lobby <-> room pair, joined by proxyGameSocket
function startProxy() {
	const browser = createFakeWebSocketPair( 'wss://lobby/mp/room/ABC123' );
	browser.client.readyState = WS_OPEN;
	const room = createFakeWebSocketPair( 'ws://127.0.0.1:4500/?ip=10.0.0.1' );
	const state = { released: 0, upstreamUrl: null, toBrowser: [], toRoom: [] };
	browser.client.onmessage = ( event ) => state.toBrowser.push( new Uint8Array( event.data ) );
	room.server.onmessage = ( event ) => state.toRoom.push( new Uint8Array( event.data ) );
	proxyGameSocket( browser.server, 'ws://127.0.0.1:4500/?ip=10.0.0.1', '10.0.0.1:1', () => state.released++, ( url ) => {
		state.upstreamUrl = url;
		return room.client;
	} );
	return { browser, room, state };
}

Deno.test( 'proxyGameSocket holds messages until the room opens, then relays both ways', async () => {
	const { browser, room, state } = startProxy();
	assert.equal( state.upstreamUrl, 'ws://127.0.0.1:4500/?ip=10.0.0.1', 'room URL' );
	browser.client.send( new Uint8Array( [ 0x51, 0x01 ] ) );
	await new Promise( ( r ) => setTimeout( r, 10 ) );
	assert.equal( state.toRoom.length, 0, 'held while the room connects' );

	room.client.open();
	await waitUntil( () => state.toRoom.length === 1, 'hello relayed' );
	assert.deepEqual( [ ...state.toRoom[ 0 ] ], [ 0x51, 0x01 ], 'hello bytes' );

	room.server.send( new Uint8Array( [ 0, 0x71, 1 ] ) );
	browser.client.send( new Uint8Array( [ 1, 0x71, 2 ] ) );
	await waitUntil( () => state.toBrowser.length === 1 && state.toRoom.length === 2, 'game messages relayed' );

	// While the browser is backed up, unreliable messages are dropped
	browser.server.bufferedAmount = 64 * 1024;
	room.server.send( new Uint8Array( [ 1, 0x71, 3 ] ) );
	room.server.send( new Uint8Array( [ 0, 0x71, 4 ] ) );
	await waitUntil( () => state.toBrowser.length === 2, 'reliable relayed' );
	await new Promise( ( r ) => setTimeout( r, 10 ) );
	assert.equal( state.toBrowser.length, 2, 'unreliable dropped' );
	assert.equal( state.toBrowser[ 1 ][ 2 ], 4, 'the reliable one got through' );
	browser.server.bufferedAmount = 0;

	// The room closes: the browser side closes too, once
	room.server.close( 1000 );
	await waitUntil( () => browser.client.readyState === WS_CLOSED, 'browser closed' );
	assert.equal( state.released, 1, 'released once' );
} );

Deno.test( 'proxyGameSocket closes both sides when the browser stops reading or leaves', async () => {
	const stalled = startProxy();
	stalled.room.client.open();
	await new Promise( ( r ) => setTimeout( r, 5 ) );
	stalled.browser.server.bufferedAmount = 4 * 1024 * 1024;
	await captureConsoleLogAsync( async () => {
		stalled.room.server.send( new Uint8Array( [ 0, 0x71, 1 ] ) );
		await waitUntil( () => stalled.room.server.readyState === WS_CLOSED, 'room closed' );
	} );
	assert.equal( stalled.state.toBrowser.length, 0, 'nothing more sent' );
	assert.equal( stalled.state.released, 1, 'released' );

	const left = startProxy();
	left.room.client.open();
	await new Promise( ( r ) => setTimeout( r, 5 ) );
	left.browser.client.close( 1001 );
	await waitUntil( () => left.room.server.readyState === WS_CLOSED, 'room closed after the browser left' );
	assert.equal( left.state.released, 1, 'released' );

	// A room that never opens is closed by the connect timeout (not waited for
	// here); a text message from the browser closes both at once.
	const text = startProxy();
	text.browser.client.send( 'hello' );
	await waitUntil( () => text.room.client.closeCalls.length === 1, 'connecting room socket closed' );
	assert.equal( text.state.released, 1, 'released' );
} );
