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
} from '../server/lobby_server.js';
import {
	createLineSplitter,
	parseRoomStatusLine,
	formatRoomStatusLine,
	RoomManager_ClampMaxPlayers,
	RoomManager_SanitizeHostName,
	RoomManager_SanitizeMapName,
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
