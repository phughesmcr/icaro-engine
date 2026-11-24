// Tests for the Deno lobby/room server (server/lobby_server.js,
// server/room_process_manager.ts, server/sys_server.ts) and the quiet-log
// filter in src/sys.js.

import assert from 'node:assert/strict';
import {
	encodeFrame,
	parseCreateConfig,
	createRateLimiter,
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
// --allow-run and --allow-write (not in the default `deno task test`
// permissions; it is skipped there). Run with:
//   deno test --allow-read --allow-net --allow-env --allow-run --allow-write tests/server_lobby_test.js
const canRun = ( await Deno.permissions.query( { name: 'run' } ) ).state === 'granted' &&
	( await Deno.permissions.query( { name: 'write' } ) ).state === 'granted';

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
		const fake = new URL( './fixtures/fake_room_server.sh', import.meta.url ).pathname;
		const playersFile = await Deno.makeTempFile();
		Deno.env.set( 'FAKE_ROOM_PLAYERS_FILE', playersFile );
		RoomManager_SetConfig( { denoPath: fake } );
		const silence = console.log;
		console.log = () => {};
		try {
			await Deno.writeTextFile( playersFile, '2' );
			const a = await RoomManager_CreateRoom( { map: 'e1m1', maxPlayers: 99, hostName: 'host', specificId: 'TEST01' } );
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
