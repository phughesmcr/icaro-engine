// Lobby signaller tests (src/net_rtclobby.js): this tab hosts a room and joins
// it, through the real lobby (server/lobby_rtc.js) behind in-memory
// WebSockets (tests/fake_websocket.js) and the WebRTC driver over in-memory
// peer connections (tests/fake_webrtc.js).

// Bootstrap the renderer's existing circular module graph in its safe order.
await import( '../src/gl_rsurf.js' );

const rtc = await import( '../src/net_webrtc.js' );
const netMain = await import( '../src/net_main.js' );
const net = await import( '../src/net.js' );
const { sv, svs } = await import( '../src/server.js' );
const { cvar_t, Cvar_FindVar, Cvar_RegisterVariable, Cvar_Set } = await import( '../src/cvar.js' );
const {
	RTCLobby_Init, RTCLobby_CanHost, RTCLobby_HostRoom, RTCLobby_ServerShutdown,
	RTCLobby_SetTimeouts, RTCLobby_GetStateForTest, RTCLOBBY_ROOM_CODE
} = await import( '../src/net_rtclobby.js' );
const { RtcLobby, Lobby_DecodeFrame, Lobby_EncodeFrame } = await import( '../server/lobby_rtc.js' );
const { FakeRTCPeerConnection } = await import( './fake_webrtc.js' );
const { createFakeWebSocketPair, OPEN } = await import( './fake_websocket.js' );

const { net_message } = net;

function assertEqual( actual, expected, message ) {

	if ( actual !== expected )
		throw new Error( `${message}: expected ${expected}, got ${actual}` );

}

function assert( condition, message ) {

	if ( condition !== true )
		throw new Error( message );

}

function delay( ms ) {

	return new Promise( ( resolve ) => setTimeout( resolve, ms ) );

}

async function waitFor( predicate, timeoutMs = 2000, label = 'condition' ) {

	const start = performance.now();
	while ( predicate() !== true ) {

		if ( performance.now() - start > timeoutMs )
			throw new Error( 'Timed out waiting for ' + label );
		await delay( 2 );

	}

}

// Capture console output (Con_Printf) while fn runs.
async function captureOutput( fn ) {

	const lines = [];
	const original = console.log;
	console.log = ( fmt, ...args ) => {

		let i = 0;
		lines.push( String( fmt ).replace( /%[sd]/g, () => String( args[ i ++ ] ) ) );

	};
	try {

		const result = await fn();
		return { result, output: lines.join( '\n' ) };

	} finally {

		console.log = original;

	}

}

globalThis.RTCPeerConnection = FakeRTCPeerConnection;
assertEqual( rtc.RTC_Init(), 0, 'RTC_Init' );
rtc.RTC_SetTimeouts( { connectMs: 1500, handshakeMs: 300, pendingAcceptMs: 400, closeFlushMs: 300 } );
RTCLobby_SetTimeouts( { requestMs: 1000, spawnMs: 1000, pollMs: 5, heartbeatMs: 60000 } );

const LOBBY_URL = 'ws://lobby.test/lobby';

// The exit rules RTCLobby_HostRoom resets; host.js registers them in a page
for ( const name of [ 'noexit', 'samelevel' ] ) {

	if ( Cvar_FindVar( name ) === null ) Cvar_RegisterVariable( new cvar_t( name, '0' ) );

}

/*
=============
The lobby, behind a WebSocket stub: each new WebSocket( url ) is the client
end of a fake pair whose server end runs RtcLobby, as lobby_server.js does
=============
*/
function makeLobbyServer() {

	const lobby = new RtcLobby( { iceServers: () => [ { urls: 'stun:stun.example.test' } ] } );
	const sockets = new Map(); // session id -> server end
	const server = { lobby, sockets, opened: 0 };

	globalThis.WebSocket = function ( url ) {

		const { client, server: end } = createFakeWebSocketPair( url );
		const sid = 's' + ( ++ server.opened );
		sockets.set( sid, end );
		lobby.open( sid, '10.0.0.' + server.opened, Date.now() );

		end.onmessage = async ( event ) => {

			const msg = Lobby_DecodeFrame( new Uint8Array( event.data ) );
			if ( msg === null ) return;
			const frames = await lobby.handle( sid, msg.type, msg.data, Date.now() );
			for ( const frame of frames ?? [] ) {

				const to = sockets.get( frame.to );
				if ( to !== undefined && to.readyState === OPEN ) to.send( Lobby_EncodeFrame( frame.type, frame.data ) );

			}

		};
		end.onclose = () => {

			lobby.close( sid );
			sockets.delete( sid );

		};

		client.open();
		return client;

	};

	return server;

}

function roles( lobby ) {

	return [ ...lobby.sessions.values() ].map( ( s ) => s.role );

}

/*
=============
Host setup, as in net_webrtc_test.js: the WebRTC driver in slot 1, a
listening server with free client slots
=============
*/
function setup( { maxclients = 2 } = {} ) {

	const saved = {
		maxclients: svs.maxclients,
		clients: svs.clients,
		spawncount: svs.spawncount,
		active: sv.active,
		name: sv.name,
		data: net_message.data,
		maxsize: net_message.maxsize,
		cursize: net_message.cursize,
		numdrivers: net.net_numdrivers,
		drivers: net.net_drivers.slice( 0, 2 ),
		activeconnections: net.net_activeconnections
	};

	net.set_net_activeSockets( null );
	let free = null;
	for ( let i = 0; i < 8; i ++ ) {

		const s = new net.qsocket_t();
		s.next = free;
		s.disconnected = true;
		free = s;

	}

	net.set_net_freeSockets( free );
	net.set_net_activeconnections( 0 );

	svs.maxclients = maxclients;
	svs.clients = [];
	for ( let i = 0; i < maxclients; i ++ ) svs.clients.push( { active: false, netconnection: null } );
	sv.active = false;

	net_message.data = new Uint8Array( net.NET_MAXMESSAGE );
	net_message.maxsize = net.NET_MAXMESSAGE;
	net_message.cursize = 0;

	net.set_net_numdrivers( 2 );
	net.net_drivers[ 0 ] = { initialized: false };
	net.net_drivers[ 1 ] = { initialized: true, CheckNewConnections: rtc.RTC_CheckNewConnections };
	rtc.RTC_SetDriverLevel( 1 );
	netMain.set_listening( true );
	rtc.RTC_Listen( true );
	FakeRTCPeerConnection.instances.length = 0;

	const lobbyServer = makeLobbyServer();
	RTCLobby_Init( () => LOBBY_URL, () => true ); // net_main.js passes its "listening"
	Cvar_Set( 'noexit', '0' );
	Cvar_Set( 'samelevel', '0' );

	const teardown = async function () {

		rtc.RTC_Shutdown();
		assertEqual( rtc.RTC_Init(), 0, 'RTC_Init again' );
		rtc.RTC_SetSignaller( null );
		// Let the fakes' delivery and close timers run out
		await delay( 30 );
		delete globalThis.WebSocket;
		Cvar_Set( 'noexit', '0' );
		Cvar_Set( 'samelevel', '0' );

		netMain.set_listening( false );
		net.set_net_driverlevel( 0 );
		net.set_net_numdrivers( saved.numdrivers );
		net.net_drivers[ 0 ] = saved.drivers[ 0 ];
		net.net_drivers[ 1 ] = saved.drivers[ 1 ];
		net.set_net_activeconnections( saved.activeconnections );
		net.set_net_activeSockets( null );
		net.set_net_freeSockets( null );
		svs.maxclients = saved.maxclients;
		svs.clients = saved.clients;
		svs.spawncount = saved.spawncount;
		sv.active = saved.active;
		sv.name = saved.name;
		net_message.data = saved.data;
		net_message.maxsize = saved.maxsize;
		net_message.cursize = saved.cursize;

	};

	return { lobbyServer, teardown };

}

// SV_SpawnServer, as far as RTCLobby_HostRoom looks
function spawn( map = 'e1m2' ) {

	sv.name = map;
	sv.active = true;
	svs.spawncount ++;

}

// What SV_CheckForNewClients does, minus SV_ConnectClient.
function svCheckForNewClients() {

	const accepted = [];
	while ( true ) {

		const ret = netMain.NET_CheckNewConnections();
		if ( ret == null ) break;
		const i = svs.clients.findIndex( ( c ) => c.active !== true );
		if ( i < 0 ) throw new Error( 'no free clients' );
		svs.clients[ i ].active = true;
		svs.clients[ i ].netconnection = ret;
		net.set_net_activeconnections( net.net_activeconnections + 1 );
		accepted.push( ret );

	}

	return accepted;

}

/*
=============
Tests
=============
*/

Deno.test( 'RTC lobby: host a room once the map is up, join it by code, heartbeat and end it', async () => {

	const { lobbyServer, teardown } = setup();
	try {

		assertEqual( RTCLobby_CanHost(), true, 'a WebSocket lobby can host' );

		const hosting = RTCLobby_HostRoom( { hostName: 'Tester', public: true, options: { coop: 0 } }, svs.spawncount, false );
		await delay( 20 );
		assertEqual( lobbyServer.opened, 0, 'no lobby socket before the map spawns' );

		spawn( 'e1m2' );
		const room = await hosting;
		assert( RTCLOBBY_ROOM_CODE.test( room.id ), 'an 8-character code: ' + room.id );
		assertEqual( room.map, 'e1m2', 'the map that spawned' );
		assertEqual( room.maxPlayers, 2, 'max players from svs.maxclients' );
		assertEqual( room.public, true, 'listed' );
		const listed = lobbyServer.lobby.listRooms( Date.now() ).find( ( r ) => r.id === room.id );
		assert( listed !== undefined && listed.hostName === 'Tester', 'in the room list' );

		// Join it from this tab: the driver asks the lobby, signals through it,
		// then drops its lobby socket
		const sock = await rtc.RTC_Connect( 'rtc:' + room.id );
		assert( sock !== null, 'joiner connected' );
		assertEqual( svCheckForNewClients().length, 1, 'host accepted the joiner' );
		await waitFor( () => RTCLobby_GetStateForTest().join === null && roles( lobbyServer.lobby ).length === 1,
			1000, 'the joiner leaves the lobby' );
		assertEqual( roles( lobbyServer.lobby )[ 0 ], 'host', 'the host stays' );

		// The player count reaches the lobby at once
		svs.clients[ 1 ].active = true;
		await waitFor( () => lobbyServer.lobby.rooms.get( room.id ).room.players === 2, 1000, 'heartbeat with 2 players' );

		// The server shuts down: the room goes
		RTCLobby_ServerShutdown();
		assertEqual( RTCLobby_GetStateForTest().host, null, 'host session ended' );
		await waitFor( () => lobbyServer.lobby.hasRoom( room.id ) === false, 1000, 'room removed' );

	} finally {

		await teardown();

	}

} );

Deno.test( 'RTC lobby: a lobby error ends the join and closes its socket', async () => {

	const { lobbyServer, teardown } = setup();
	try {

		const { result, output } = await captureOutput( () => rtc.RTC_Connect( 'rtc:ABCDEFGH' ) );
		assertEqual( result, null, 'connect failed' );
		assert( output.includes( 'Room not found' ), 'the lobby\'s reason shown: ' + output );
		assertEqual( FakeRTCPeerConnection.instances.length, 0, 'no peer connection made' );
		await waitFor( () => lobbyServer.lobby.sessions.size === 0, 1000, 'the joiner\'s socket closed' );
		assertEqual( RTCLobby_GetStateForTest().join, null, 'no join session' );

	} finally {

		await teardown();

	}

} );

Deno.test( 'RTC lobby: without a WebSocket lobby, joining and hosting fail and the exit rules reset', async () => {

	const { lobbyServer, teardown } = setup();
	try {

		RTCLobby_Init( () => null, () => true );
		assertEqual( RTCLobby_CanHost(), false, 'can\'t host' );

		const { result, output } = await captureOutput( () => rtc.RTC_Connect( 'rtc:ABCDEFGH' ) );
		assertEqual( result, null, 'connect failed' );
		assert( output.includes( 'need a WebSocket lobby' ), 'reason shown: ' + output );

		Cvar_Set( 'noexit', '1' );
		Cvar_Set( 'samelevel', '2' );
		let error = null;
		await RTCLobby_HostRoom( { hostName: 'Tester' }, svs.spawncount, true ).catch( ( e ) => error = e );
		assert( error !== null && error.message.includes( 'WebSocket lobby' ), 'hosting refused' );
		assertEqual( Cvar_FindVar( 'noexit' ).value, 0, 'noexit reset' );
		assertEqual( Cvar_FindVar( 'samelevel' ).value, 0, 'samelevel reset' );
		assertEqual( lobbyServer.opened, 0, 'no lobby socket' );

	} finally {

		await teardown();

	}

} );

Deno.test( 'RTC lobby: the room\'s own disconnect doesn\'t end it, a new room replaces it, and its end resets the rules', async () => {

	const { lobbyServer, teardown } = setup();
	try {

		Cvar_Set( 'noexit', '1' );
		Cvar_Set( 'samelevel', '2' );
		const spawnCount = svs.spawncount;

		let firstError = null;
		const first = RTCLobby_HostRoom( { hostName: 'Tester' }, spawnCount, true ).catch( ( e ) => firstError = e );

		// The "disconnect" queued ahead of the room's "map"
		RTCLobby_ServerShutdown();
		await delay( 20 );
		assertEqual( firstError, null, 'still waiting for the map' );
		assertEqual( Cvar_FindVar( 'noexit' ).value, 1, 'rules kept' );

		// Start Game again before the map is up: the first gives way
		const second = RTCLobby_HostRoom( { hostName: 'Tester' }, spawnCount, true );
		await first;
		assert( firstError !== null && firstError.message === 'Hosting was cancelled', 'first cancelled' );

		spawn();
		const room = await second;
		assertEqual( lobbyServer.lobby.rooms.size, 1, 'one room' );
		assertEqual( Cvar_FindVar( 'noexit' ).value, 1, 'rules kept while the room runs' );

		RTCLobby_ServerShutdown();
		assertEqual( Cvar_FindVar( 'noexit' ).value, 0, 'noexit reset' );
		assertEqual( Cvar_FindVar( 'samelevel' ).value, 0, 'samelevel reset' );
		await waitFor( () => lobbyServer.lobby.hasRoom( room.id ) === false, 1000, 'room removed' );

	} finally {

		await teardown();

	}

} );

Deno.test( 'RTC lobby: the host is told when the lobby drops it', async () => {

	const { lobbyServer, teardown } = setup();
	try {

		const hosting = RTCLobby_HostRoom( { hostName: 'Tester' }, svs.spawncount, false );
		spawn();
		const room = await hosting;

		const { output } = await captureOutput( async () => {

			lobbyServer.sockets.get( 's1' ).close( 1001 );
			await waitFor( () => RTCLobby_GetStateForTest().host === null, 1000, 'host session ended' );

		} );
		assert( output.includes( 'Lost the lobby' ) && output.includes( room.id ), 'told: ' + output );

		// The server still runs; its shutdown later is quiet
		RTCLobby_ServerShutdown();

	} finally {

		await teardown();

	}

} );

Deno.test( 'RTC lobby: a map that never spawns gives up and resets the rules', async () => {

	const { teardown } = setup();
	try {

		RTCLobby_SetTimeouts( { spawnMs: 50 } );
		Cvar_Set( 'noexit', '1' );
		let error = null;
		await RTCLobby_HostRoom( { hostName: 'Tester' }, svs.spawncount, true ).catch( ( e ) => error = e );
		assert( error !== null && error.message === 'The game did not start', 'gave up: ' + error );
		assertEqual( Cvar_FindVar( 'noexit' ).value, 0, 'noexit reset' );

	} finally {

		RTCLobby_SetTimeouts( { spawnMs: 1000 } );
		await teardown();

	}

} );

Deno.test( 'RTC lobby: an 8-character code joins over WebRTC, a 6-character one through the lobby', () => {

	assertEqual( netMain.NET_LobbyJoinURL( 'wss://lobby.test', 'ABCDEFGH' ), 'rtc:ABCDEFGH', 'browser room' );
	const lobbyRoom = netMain.NET_LobbyJoinURL( 'wss://lobby.test', 'ABC234' );
	assert( lobbyRoom !== null && lobbyRoom.startsWith( 'rtc:' ) === false, 'lobby room: ' + lobbyRoom );
	// I and O are never in a browser room's code
	const notRtc = netMain.NET_LobbyJoinURL( 'wss://lobby.test', 'ABCDEFGI' );
	assert( notRtc === null || notRtc.startsWith( 'rtc:' ) === false, 'not a browser room: ' + notRtc );
	assertEqual( netMain.NET_LobbyJoinURL( null, 'ABCDEFGH' ), null, 'no lobby' );

} );
