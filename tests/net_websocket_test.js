// WebSocket transport tests: the browser driver (src/net_websocket.js) and
// the server driver (server/net_websocket_server.ts), connected through
// in-memory WebSocket pairs (tests/fake_websocket.js).

// Bootstrap the renderer's existing circular module graph in its safe order.
await import( '../src/gl_rsurf.js' );

const server = await import( '../server/net_websocket_server.ts' );
const client = await import( '../src/net_websocket.js' );
const netMain = await import( '../src/net_main.js' );
const net = await import( '../src/net.js' );
const { svs } = await import( '../src/server.js' );
const keys = await import( '../src/keys.js' );
const { svc_disconnect, clc_disconnect, clc_nop } = await import( '../src/protocol.js' );
const {
	createFakeWebSocketPair,
	gameMessage,
	messageSequence,
	messageAck,
	OPEN,
	CLOSED
} = await import( './fake_websocket.js' );

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

function message( bytes ) {

	return { data: new Uint8Array( bytes ), cursize: bytes.length };

}

// Capture console output (Con_Printf, Sys_Printf) while fn runs.
async function captureOutput( fn ) {

	const lines = [];
	const original = console.log;
	console.log = ( ...args ) => lines.push( args.join( ' ' ) );
	try {

		const result = await fn();
		return { result, output: lines.join( '\n' ) };

	} finally {

		console.log = original;

	}

}

// The client driver registers its page-hide handler on window; capture it.
const pageHandlers = {};
globalThis.window = {
	addEventListener( type, handler ) {

		pageHandlers[ type ] = handler;

	}
};

// new WebSocket( url ) returns whatever the current test's factory makes.
let socketFactory = null;
globalThis.WebSocket = function ( url ) {

	return socketFactory( url );

};

assertEqual( client.WS_Init(), 0, 'WS_Init' );
delete globalThis.window;
assert( typeof pageHandlers.pagehide === 'function', 'pagehide handler registered' );

client.WS_SetTimeouts( { connectMs: 2000, handshakeMs: 1000, closeFlushMs: 300 } );

/*
=============
Server setup, as setupServer in webtransport_test_env.js but with the
WebSocket server driver in slot 1.
=============
*/
const DEFAULT_CONFIG = {
	maxSessionsPerIp: 8,
	maxHandshakingSessions: 16,
	handshakeTimeoutMs: 10000,
	pendingAcceptTimeoutMs: 30000,
	closeFlushMs: 1000
};

function setupServer( { maxclients = 2, sockets = 8, config = {} } = {} ) {

	const saved = {
		maxclients: svs.maxclients,
		clients: svs.clients,
		data: net_message.data,
		maxsize: net_message.maxsize,
		cursize: net_message.cursize,
		numdrivers: net.net_numdrivers,
		drivers: net.net_drivers.slice( 0, 2 ),
		activeconnections: net.net_activeconnections
	};

	net.set_net_activeSockets( null );
	let free = null;
	for ( let i = 0; i < sockets; i ++ ) {

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

	net_message.data = new Uint8Array( net.NET_MAXMESSAGE );
	net_message.maxsize = net.NET_MAXMESSAGE;
	net_message.cursize = 0;

	net.set_net_numdrivers( 2 );
	net.net_drivers[ 0 ] = { initialized: false };
	net.net_drivers[ 1 ] = { initialized: true, CheckNewConnections: server.WS_CheckNewConnections };
	server.WS_SetDriverLevel( 1 );
	netMain.set_listening( true );

	server.WS_SetSocketAllocator( netMain.NET_NewQSocket );
	server.WS_SetSocketFreer( netMain.NET_FreeQSocket );
	server.WS_SetConfig( {
		...DEFAULT_CONFIG,
		handshakeTimeoutMs: 300,
		closeFlushMs: 300,
		...config
	} );

	return async function teardown() {

		server.WS_Shutdown();
		while ( server.WS_CheckNewConnections() !== null ) { /* drain */ }
		await waitFor( () => {

			const stats = server.WS_GetSessionStatsForTest();
			return stats.handshaking === 0 && stats.live === 0 && stats.pending === 0 && stats.sessionsByIp === 0;

		}, 3000, 'server sessions to close' );
		await delay( 10 );

		server.WS_SetConfig( DEFAULT_CONFIG );
		server.WS_SetSocketAllocator( null );
		server.WS_SetSocketFreer( null );
		server.WS_SetDriverLevel( 0 );
		netMain.set_listening( false );
		net.set_net_numdrivers( saved.numdrivers );
		net.net_drivers[ 0 ] = saved.drivers[ 0 ];
		net.net_drivers[ 1 ] = saved.drivers[ 1 ];
		net.set_net_activeconnections( saved.activeconnections );
		net.set_net_activeSockets( null );
		net.set_net_freeSockets( null );
		svs.maxclients = saved.maxclients;
		svs.clients = saved.clients;
		net_message.data = saved.data;
		net_message.maxsize = saved.maxsize;
		net_message.cursize = saved.cursize;

	};

}

// What SV_CheckForNewClients does, minus SV_ConnectClient.
function svCheckForNewClients() {

	const accepted = [];
	while ( true ) {

		const ret = netMain.NET_CheckNewConnections();
		if ( ret == null ) break;

		let i;
		for ( i = 0; i < svs.maxclients; i ++ ) {

			if ( ! svs.clients[ i ].active ) break;

		}

		if ( i === svs.maxclients )
			throw new Error( 'Host_CheckForNewClients: no free clients' );

		svs.clients[ i ].active = true;
		svs.clients[ i ].netconnection = ret;
		net.set_net_activeconnections( net.net_activeconnections + 1 );
		accepted.push( ret );

	}

	return accepted;

}

function freeSocketCount() {

	let n = 0;
	for ( let s = net.net_freeSockets; s != null; s = s.next ) n ++;
	return n;

}

let nextAddress = 1;

// A fake pair whose server end goes straight to the server driver.
function openServerSession( url = 'ws://127.0.0.1:4433/' ) {

	const pair = createFakeWebSocketPair( url );
	const n = nextAddress ++;
	const ip = '10.1.0.' + n;
	const accepted = server.WS_AcceptSocketForTest( pair.server, ip + ':' + ( 40000 + n ), ip );
	return { pair, accepted };

}

// Each new WebSocket the client opens is served by the server driver.
function useServerDriver() {

	const pairs = [];
	socketFactory = ( url ) => {

		const { pair } = openServerSession( url );
		pairs.push( pair );
		pair.client.open();
		return pair.client;

	};
	return pairs;

}

async function connectClient( host = 'ws://127.0.0.1:4433' ) {

	const pairs = useServerDriver();
	const sock = await client.WS_Connect( host );
	assert( sock != null, 'client connected' );
	const [ serverSock ] = svCheckForNewClients();
	assert( serverSock != null, 'server accepted the client' );
	return { sock, serverSock, pair: pairs[ 0 ] };

}

function drainServer( sock ) {

	const results = [];
	while ( true ) {

		const ret = server.WS_QGetMessage( sock );
		if ( ret <= 0 ) {

			results.push( ret );
			return results;

		}

		results.push( { ret, payload: net_message.data.slice( 0, net_message.cursize ) } );

	}

}

function drainClient( sock ) {

	const results = [];
	while ( true ) {

		const ret = client.WS_QGetMessage( sock );
		if ( ret <= 0 ) {

			results.push( ret );
			return results;

		}

		results.push( { ret, payload: net_message.data.slice( 0, net_message.cursize ) } );

	}

}

// Messages the server wrote after the handshake reply
function serverGameMessages( pair ) {

	return pair.server.sent.slice( 1 );

}

/*
=============
Tests
=============
*/

Deno.test( 'WS: client and server handshake and exchange reliable and unreliable messages with acks', async () => {

	const teardown = setupServer( { maxclients: 4, sockets: 10 } );
	try {

		const { sock, serverSock, pair } = await connectClient();
		assertEqual( pair.client.binaryType, 'arraybuffer', 'client binaryType' );
		assertEqual( pair.server.binaryType, 'arraybuffer', 'server binaryType' );
		assertEqual( serverSock.maxdatagram, net.NET_MAXMESSAGE, 'server maxdatagram' );
		assertEqual( client.WS_QGetMessage( sock ), 0, 'client idle' );

		// Wire format: the hello is the WebTransport hello without its length
		assertEqual( pair.client.sent[ 0 ].length, net.WT_BuildHelloFrame().length - 2, 'hello size' );
		assertEqual( net.WT_ParseHello( pair.client.sent[ 0 ] ), net.WT_PROTOCOL_VERSION, 'hello version' );

		// Server -> client, reliable then unreliable
		server.WS_QSendMessage( serverSock, message( [ svc_disconnect - 1, 7 ] ) );
		server.WS_SendUnreliableMessage( serverSock, message( [ 42 ] ) );
		await waitFor( () => sock.driverdata.pendingMessages.length === 2, 1000, 'server messages' );
		let results = drainClient( sock );
		assertEqual( results[ 0 ].ret, 1, 'reliable first' );
		assertEqual( results[ 0 ].payload[ 1 ], 7, 'reliable payload' );
		assertEqual( results[ 1 ].ret, 2, 'then unreliable' );
		assertEqual( results[ 1 ].payload[ 0 ], 42, 'unreliable payload' );
		assertEqual( results[ 2 ], 0, 'then idle' );

		const sent = serverGameMessages( pair );
		assertEqual( sent[ 0 ][ 0 ], net.WS_CHANNEL_RELIABLE, 'reliable channel byte' );
		assertEqual( sent[ 1 ][ 0 ], net.WS_CHANNEL_UNRELIABLE, 'unreliable channel byte' );
		assertEqual( sent[ 0 ][ 1 ], net.WT_PACKET_MAGIC, 'magic' );
		assertEqual( messageSequence( sent[ 0 ] ), 0, 'first sequence' );
		assertEqual( messageSequence( sent[ 1 ] ), 1, 'second sequence' );

		// Client -> server: acknowledges the newest sequence on either channel
		client.WS_QSendMessage( sock, message( [ clc_nop ] ) );
		client.WS_SendUnreliableMessage( sock, message( [ 9, 9 ] ) );
		await waitFor( () => serverSock.driverdata.pendingMessages.length === 2, 1000, 'client messages' );
		assertEqual( messageAck( pair.client.sent[ 1 ] ), 1, 'client acks sequence 1' );
		results = drainServer( serverSock );
		assertEqual( results[ 0 ].ret, 1, 'server gets reliable' );
		assertEqual( results[ 0 ].payload[ 0 ], clc_nop, 'reliable payload' );
		assertEqual( results[ 1 ].ret, 2, 'server gets unreliable' );
		assertEqual( results[ 1 ].payload.length, 2, 'unreliable payload' );
		assertEqual( serverSock.ackSequence, 1, 'server sees the ack' );
		assertEqual( serverSock.receiveSequence, 0, 'reliable sequence' );
		assertEqual( serverSock.unreliableReceiveSequence, 1, 'unreliable sequence' );

		client.WS_Close( sock );

	} finally {

		await teardown();

	}

} );

Deno.test( 'WS: consecutive unreliable messages are coalesced and stale ones dropped', async () => {

	const teardown = setupServer( { maxclients: 4, sockets: 10 } );
	try {

		const { sock, serverSock, pair } = await connectClient();

		server.WS_SendUnreliableMessage( serverSock, message( [ 1 ] ) );
		server.WS_SendUnreliableMessage( serverSock, message( [ 2 ] ) );
		server.WS_QSendMessage( serverSock, message( [ 3 ] ) );
		server.WS_SendUnreliableMessage( serverSock, message( [ 4 ] ) );
		server.WS_SendUnreliableMessage( serverSock, message( [ 5 ] ) );
		await waitFor( () => sock.driverdata.pendingMessages.length === 3, 1000, 'messages queued' );
		const results = drainClient( sock );
		assertEqual( results.length, 4, 'three deliveries then idle' );
		assertEqual( results[ 0 ].payload[ 0 ], 2, 'newest unreliable before the reliable' );
		assertEqual( results[ 1 ].payload[ 0 ], 3, 'reliable' );
		assertEqual( results[ 2 ].payload[ 0 ], 5, 'newest unreliable after it' );

		// A replayed (stale) unreliable message from the peer is ignored
		pair.server.send( gameMessage( net.WS_CHANNEL_UNRELIABLE, 1, - 1, new Uint8Array( [ 99 ] ) ) );
		await waitFor( () => sock.driverdata.pendingMessages.length === 1, 1000, 'stale message queued' );
		assertEqual( client.WS_QGetMessage( sock ), 0, 'stale unreliable dropped' );

		client.WS_Close( sock );

	} finally {

		await teardown();

	}

} );

Deno.test( 'WS: a full server rejects with a reason and the client frees everything', async () => {

	const teardown = setupServer( { maxclients: 1, sockets: 10 } );
	try {

		const first = await connectClient();
		const free = freeSocketCount();
		keys.set_key_dest( keys.key_game );

		const pairs = useServerDriver();
		const { result, output } = await captureOutput( () => client.WS_Connect( 'ws://127.0.0.1:4433' ) );
		assertEqual( result, null, 'connect result' );
		assert( output.includes( 'Server is full' ), 'reason shown: ' + output );
		assertEqual( freeSocketCount(), free, 'no socket leaked' );
		assertEqual( keys.key_dest, keys.key_menu, 'back in the menu' );
		await waitFor( () => pairs[ 0 ].client.readyState === CLOSED, 2000, 'rejected socket closed' );

		client.WS_Close( first.sock );

	} finally {

		await teardown();

	}

} );

Deno.test( 'WS: the server rejects a bad hello and an old protocol version', async () => {

	const teardown = setupServer( { maxclients: 4, sockets: 10 } );
	try {

		await captureOutput( async () => {

			// Not a hello at all
			const bad = openServerSession();
			assert( bad.accepted, 'session reserved' );
			bad.pair.client.readyState = OPEN;
			bad.pair.client.send( new Uint8Array( [ 1, 2, 3 ] ) );
			await waitFor( () => bad.pair.server.sent.length === 1, 1000, 'reject reply' );
			let reply = net.WT_ParseHandshakeReply( bad.pair.server.sent[ 0 ] );
			assertEqual( reply.status, net.WT_HANDSHAKE_REJECT, 'rejected' );
			assert( reply.reason.includes( 'Protocol mismatch' ), 'reason: ' + reply.reason );
			await waitFor( () => bad.pair.client.readyState === CLOSED, 1000, 'closed after reject' );

			// A hello with another version
			const old = openServerSession();
			old.pair.client.readyState = OPEN;
			const hello = net.WT_BuildHelloFrame().slice( 2 );
			hello[ hello.length - 1 ] = net.WT_PROTOCOL_VERSION + 1;
			old.pair.client.send( hello );
			await waitFor( () => old.pair.server.sent.length === 1, 1000, 'version reply' );
			reply = net.WT_ParseHandshakeReply( old.pair.server.sent[ 0 ] );
			assertEqual( reply.status, net.WT_HANDSHAKE_REJECT, 'rejected' );
			assert( reply.reason.includes( 'not supported' ), 'reason: ' + reply.reason );

			// Silence until the handshake timeout
			const silent = openServerSession();
			silent.pair.client.readyState = OPEN;
			await waitFor( () => silent.pair.client.readyState === CLOSED, 2000, 'handshake timeout' );
			assertEqual( silent.pair.server.sent.length, 0, 'nothing sent' );

		} );

		assertEqual( server.WS_GetSessionStatsForTest().pending, 0, 'nothing pending' );

	} finally {

		await teardown();

	}

} );

Deno.test( 'WS: per-IP session limit', async () => {

	const teardown = setupServer( { maxclients: 4, sockets: 10, config: { maxSessionsPerIp: 2 } } );
	try {

		await captureOutput( () => {

			const a = createFakeWebSocketPair();
			const b = createFakeWebSocketPair();
			const c = createFakeWebSocketPair();
			assertEqual( server.WS_AcceptSocketForTest( a.server, '10.9.9.9:1', '10.9.9.9' ), true, 'first' );
			assertEqual( server.WS_AcceptSocketForTest( b.server, '10.9.9.9:2', '10.9.9.9' ), true, 'second' );
			assertEqual( server.WS_AcceptSocketForTest( c.server, '10.9.9.9:3', '10.9.9.9' ), false, 'third refused' );
			assertEqual( server.WS_GetSessionStatsForTest().handshaking, 2, 'two handshaking' );

		} );

	} finally {

		await captureOutput( () => teardown() );

	}

} );

Deno.test( 'WS: the server drops unreliable sends while the client is far behind on acks', async () => {

	const teardown = setupServer( { maxclients: 4, sockets: 10 } );
	try {

		const { sock, serverSock, pair } = await connectClient();

		// Before the client has sent anything the gate is open
		assertEqual( server.WS_CanSendUnreliableMessage( serverSock ), true, 'open before the client is sequenced' );

		client.WS_QSendMessage( sock, message( [ clc_nop ] ) );
		await waitFor( () => serverSock.driverdata.pendingMessages.length === 1, 1000, 'client message' );
		drainServer( serverSock );
		assertEqual( serverSock.ackSequence, - 1, 'client has acknowledged nothing' );

		for ( let i = 0; i <= 20; i ++ ) server.WS_QSendMessage( serverSock, message( [ i ] ) );
		assertEqual( server.WS_CanSendUnreliableMessage( serverSock ), false, 'gate closed after 21 unacked packets' );
		const before = serverSock.sendSequence;
		const written = pair.server.sent.length;
		assertEqual( server.WS_SendUnreliableMessage( serverSock, message( [ 77 ] ) ), 1, 'dropped quietly' );
		assertEqual( serverSock.sendSequence, before, 'a dropped server send uses no sequence' );
		assertEqual( pair.server.sent.length, written, 'nothing written' );
		assertEqual( server.WS_CanSendMessage( serverSock ), true, 'reliable still allowed' );

		// The client catches up and acknowledges
		await waitFor( () => sock.driverdata.pendingMessages.length === 21, 1000, 'server messages' );
		drainClient( sock );
		client.WS_SendUnreliableMessage( sock, message( [ 1 ] ) );
		await waitFor( () => serverSock.driverdata.pendingMessages.length === 1, 1000, 'ack' );
		drainServer( serverSock );
		assertEqual( serverSock.ackSequence, 20, 'server sees the ack' );
		assertEqual( server.WS_CanSendUnreliableMessage( serverSock ), true, 'gate open again' );

		client.WS_Close( sock );

	} finally {

		await teardown();

	}

} );

Deno.test( 'WS: send buffer thresholds on both sides', async () => {

	const teardown = setupServer( { maxclients: 4, sockets: 10 } );
	try {

		const { sock, serverSock, pair } = await connectClient();
		const serverSocket = pair.server;
		const clientSocket = pair.client;

		// Server: drop unreliable at 64 KB, refuse reliable at 1 MB, drop the client at 4 MB
		serverSocket.bufferedAmount = 64 * 1024;
		assertEqual( server.WS_CanSendUnreliableMessage( serverSock ), false, 'server unreliable gated' );
		const before = serverSock.sendSequence;
		server.WS_SendUnreliableMessage( serverSock, message( [ 1 ] ) );
		assertEqual( serverSock.sendSequence, before, 'server drop uses no sequence' );
		assertEqual( server.WS_CanSendMessage( serverSock ), true, 'server reliable allowed' );
		serverSocket.bufferedAmount = 1024 * 1024;
		assertEqual( server.WS_CanSendMessage( serverSock ), false, 'server reliable gated' );
		serverSocket.bufferedAmount = 4 * 1024 * 1024;
		const { result } = await captureOutput( () => server.WS_QSendMessage( serverSock, message( [ 1 ] ) ) );
		assertEqual( result, - 1, 'stalled server socket fails' );
		assertEqual( server.WS_QGetMessage( serverSock ), - 1, 'and reads as dead' );
		serverSocket.bufferedAmount = 0;

		// Client: drop unreliable at 16 KB (the sequence is still used up),
		// refuse reliable at 256 KB, give up at 1 MB
		clientSocket.bufferedAmount = 16 * 1024;
		const seq = sock.sendSequence;
		const sentBefore = clientSocket.sent.length;
		assertEqual( client.WS_SendUnreliableMessage( sock, message( [ 1 ] ) ), 1, 'client drop' );
		assertEqual( sock.sendSequence, seq + 1, 'client drop uses a sequence' );
		assertEqual( clientSocket.sent.length, sentBefore, 'nothing written' );
		assertEqual( client.WS_CanSendMessage( sock ), true, 'client reliable allowed' );
		clientSocket.bufferedAmount = 256 * 1024;
		assertEqual( client.WS_CanSendMessage( sock ), false, 'client reliable gated' );
		clientSocket.bufferedAmount = 1024 * 1024;
		const stalled = await captureOutput( () => client.WS_QSendMessage( sock, message( [ 1 ] ) ) );
		assertEqual( stalled.result, - 1, 'stalled client socket fails' );
		assertEqual( client.WS_QGetMessage( sock ), - 1, 'client reads as dead' );
		clientSocket.bufferedAmount = 0;

		client.WS_Close( sock );
		server.WS_Close( serverSock );

	} finally {

		await teardown();

	}

} );

Deno.test( 'WS: a server close delivers the queued disconnect before the socket closes', async () => {

	const teardown = setupServer( { maxclients: 4, sockets: 10 } );
	try {

		const { sock, serverSock, pair } = await connectClient();

		server.WS_QSendMessage( serverSock, message( [ svc_disconnect ] ) );
		await captureOutput( () => server.WS_Close( serverSock ) );
		await waitFor( () => pair.client.readyState === CLOSED, 1000, 'client socket closed' );

		const results = drainClient( sock );
		assertEqual( results[ 0 ].ret, 1, 'disconnect delivered' );
		assertEqual( results[ 0 ].payload[ 0 ], svc_disconnect, 'payload' );
		assertEqual( results[ 1 ], - 1, 'then the connection reads as closed' );
		assert( pair.server.closeCalls.includes( 1000 ), 'server closed normally' );

		client.WS_Close( sock );

	} finally {

		await teardown();

	}

} );

Deno.test( 'WS: a client close lets the server see the disconnect, and a reconnect waits for it', async () => {

	const teardown = setupServer( { maxclients: 4, sockets: 10 } );
	try {

		const { sock, serverSock, pair } = await connectClient();

		client.WS_QSendMessage( sock, message( [ clc_disconnect ] ) );
		client.WS_Close( sock );
		assertEqual( sock.driverdata, null, 'client socket detached at once' );

		// The server reads the clc_disconnect, then drops the client
		await waitFor( () => serverSock.driverdata.pendingMessages.length === 1, 1000, 'clc_disconnect' );
		const results = drainServer( serverSock );
		assertEqual( results[ 0 ].payload[ 0 ], clc_disconnect, 'payload' );

		// A reconnect started now waits until the old socket has closed
		let reconnected = null;
		const pairs = useServerDriver();
		const pending = client.WS_Connect( 'ws://127.0.0.1:4433' ).then( ( s ) => {

			reconnected = s;

		} );
		await delay( 20 );
		assertEqual( pairs.length, 0, 'reconnect waits for the close' );

		await captureOutput( () => server.WS_Close( serverSock ) );
		await waitFor( () => pair.client.readyState === CLOSED, 1000, 'old socket closed' );
		await pending;
		assert( reconnected !== null, 'reconnected' );
		assertEqual( pairs.length, 1, 'one new socket' );

		svCheckForNewClients();
		client.WS_Close( reconnected );

	} finally {

		await teardown();

	}

} );

Deno.test( 'WS: page hide sends clc_disconnect and closes', async () => {

	const teardown = setupServer( { maxclients: 4, sockets: 10 } );
	try {

		const { serverSock, pair } = await connectClient();

		pageHandlers.pagehide();

		await waitFor( () => serverSock.driverdata.pendingMessages.length === 1, 1000, 'clc_disconnect' );
		const results = drainServer( serverSock );
		assertEqual( results[ 0 ].ret, 1, 'reliable' );
		assertEqual( results[ 0 ].payload[ 0 ], clc_disconnect, 'payload' );
		assertEqual( results[ 1 ], - 1, 'then closed' );
		assertEqual( pair.client.readyState, CLOSED, 'client socket closed' );

	} finally {

		await teardown();

	}

} );

Deno.test( 'WS: protocol errors from the server disconnect the client', async () => {

	const teardown = setupServer( { maxclients: 4, sockets: 10 } );
	try {

		const { sock, pair } = await connectClient();

		pair.server.send( new Uint8Array( [ 5, 0x71, 0, 0, 0, 0, 0, 0, 0, 0 ] ) );
		await waitFor( () => sock.driverdata.connected === false, 1000, 'protocol error' );
		const { result } = await captureOutput( () => client.WS_QGetMessage( sock ) );
		assertEqual( result, - 1, 'unknown channel is fatal' );

		client.WS_Close( sock );

	} finally {

		await captureOutput( () => teardown() );

	}

} );

Deno.test( 'WS: a room address joins through the lobby, then connects to /room/<id>', async () => {

	const teardown = setupServer( { maxclients: 4, sockets: 10 } );
	try {

		const urls = [];
		let joinRequest = null;
		const pairs = [];
		socketFactory = ( url ) => {

			urls.push( url );
			if ( url.endsWith( '/lobby' ) ) {

				// A lobby that answers one JOIN
				const pair = createFakeWebSocketPair( url );
				pair.server.onmessage = ( event ) => {

					joinRequest = new Uint8Array( event.data );
					const body = new TextEncoder().encode( JSON.stringify( { id: 'ABC123', port: 4500 } ) );
					const reply = new Uint8Array( 3 + body.length );
					reply[ 0 ] = 0x81;
					reply[ 1 ] = body.length & 0xff;
					reply[ 2 ] = body.length >> 8;
					reply.set( body, 3 );
					pair.server.send( reply );

				};
				pair.client.open();
				return pair.client;

			}

			const { pair } = openServerSession( url );
			pairs.push( pair );
			pair.client.open();
			return pair.client;

		};

		const sock = await client.WS_Connect( 'wss://quake.example/mp?room=ABC123' );
		assert( sock !== null, 'connected' );
		assertEqual( urls[ 0 ], 'wss://quake.example/mp/lobby', 'lobby URL' );
		assertEqual( urls[ 1 ], 'wss://quake.example/mp/room/ABC123', 'room URL' );
		assertEqual( joinRequest[ 0 ], 0x02, 'LOBBY_JOIN' );
		assertEqual( new TextDecoder().decode( joinRequest.subarray( 3 ) ), 'ABC123', 'room id' );
		assertEqual( sock.address, 'wss://quake.example/mp?room=ABC123', 'address kept' );
		svCheckForNewClients();

		client.WS_Close( sock );

	} finally {

		await teardown();

	}

} );

Deno.test( 'WS: a lobby error is shown to the player', async () => {

	keys.set_key_dest( keys.key_game );
	socketFactory = ( url ) => {

		const pair = createFakeWebSocketPair( url );
		pair.server.onmessage = () => {

			const body = new TextEncoder().encode( 'Room not found' );
			const reply = new Uint8Array( 3 + body.length );
			reply[ 0 ] = 0x82;
			reply[ 1 ] = body.length;
			reply.set( body, 3 );
			pair.server.send( reply );

		};
		pair.client.open();
		return pair.client;

	};

	const { result, output } = await captureOutput( () => client.WS_Connect( 'ws://127.0.0.1:4433?room=NOPE' ) );
	assertEqual( result, null, 'no connection' );
	assert( output.includes( 'Join failed: Room not found' ), 'reason shown: ' + output );
	assertEqual( keys.key_dest, keys.key_menu, 'back in the menu' );

} );

Deno.test( 'WS: room list over the lobby socket', async () => {

	let request = null;
	socketFactory = ( url ) => {

		const pair = createFakeWebSocketPair( url );
		pair.server.onmessage = ( event ) => {

			request = { url, bytes: new Uint8Array( event.data ) };
			const body = new TextEncoder().encode( JSON.stringify( [ { id: 'R1', name: 'x', map: 'e1m1', playerCount: 1, maxPlayers: 4 } ] ) );
			const reply = new Uint8Array( 3 + body.length );
			reply[ 0 ] = 0x81;
			reply[ 1 ] = body.length & 0xff;
			reply[ 2 ] = body.length >> 8;
			reply.set( body, 3 );
			pair.server.send( reply );

		};
		pair.client.open();
		return pair.client;

	};

	const { result: rooms } = await captureOutput( () => client.WS_QueryRooms( 'https://quake.example/mp/' ) );
	assertEqual( request.url, 'wss://quake.example/mp/lobby', 'lobby URL' );
	assertEqual( request.bytes[ 0 ], 0x01, 'LOBBY_LIST' );
	assertEqual( request.bytes.length, 3, 'empty body' );
	assertEqual( rooms.length, 1, 'one room' );
	assertEqual( rooms[ 0 ].id, 'R1', 'room id' );

} );

Deno.test( 'WS: the connect deadline closes a socket that never opens', async () => {

	client.WS_SetTimeouts( { connectMs: 150 } );
	try {

		let pair = null;
		socketFactory = ( url ) => {

			pair = createFakeWebSocketPair( url );
			return pair.client; // never opens

		};

		const { result, output } = await captureOutput( () => client.WS_Connect( 'ws://127.0.0.1:4433' ) );
		assertEqual( result, null, 'connect result' );
		assert( output.includes( 'timed out' ), 'timeout reported: ' + output );
		assert( pair.client.closeCalls.length > 0, 'socket closed by the deadline' );

	} finally {

		client.WS_SetTimeouts( { connectMs: 2000 } );

	}

} );

Deno.test( 'WS: URL helpers', () => {

	assertEqual( client.WS_ToWebSocketURL( 'https://a.example/mp' ), 'wss://a.example/mp', 'https' );
	assertEqual( client.WS_ToWebSocketURL( 'http://a.example:8080' ), 'ws://a.example:8080', 'http' );
	assertEqual( client.WS_ToWebSocketURL( 'wts://a.example:4433?room=X' ), 'wss://a.example:4433?room=X', 'wts' );
	assertEqual( client.WS_ToWebSocketURL( 'wt://a.example' ), 'wss://a.example', 'wt' );
	assertEqual( client.WS_ToWebSocketURL( 'a.example:4433' ), 'wss://a.example:4433', 'bare host' );
	assertEqual( client.WS_ToWebSocketURL( 'ws://127.0.0.1:4433' ), 'ws://127.0.0.1:4433', 'ws kept' );
	assertEqual( client.WS_IsWebSocketURL( 'WSS://x' ), true, 'case-insensitive' );
	assertEqual( client.WS_IsWebSocketURL( 'https://x' ), false, 'https is not ws' );

	assertEqual( client.WS_ServerBase( 'wss://a.example/mp/?room=X#y' ), 'wss://a.example/mp', 'base strips query and slash' );
	assertEqual( client.WS_LobbyURL( 'wss://a.example' ), 'wss://a.example/lobby', 'lobby at root' );
	assertEqual( client.WS_RoomURL( 'wss://a.example/mp', 'A B' ), 'wss://a.example/mp/room/A%20B', 'room id encoded' );

	// NET_* with no remote driver initialized falls back to WebSocket
	assertEqual( netMain.NET_LobbyJoinURL( 'wss://a.example/mp/', 'R1' ), 'wss://a.example/mp?room=R1', 'join URL' );
	assertEqual( netMain.NET_RoomURL( 'wss://a.example/mp', { id: 'R1', port: 4500 } ), 'wss://a.example/mp/room/R1', 'room URL ignores the port' );

	// What reaches `connect "..."` can't end the quoted argument
	assertEqual( netMain.NET_LobbyJoinURL( null, 'R1' ), null, 'no lobby' );
	assertEqual( netMain.NET_RoomURL( null, { id: 'R1' } ), null, 'no lobby (room)' );
	assertEqual( netMain.NET_LobbyJoinURL( 'wss://a.example/mp";quit;"', 'R1' ), null, 'crafted lobby' );
	assertEqual( netMain.NET_LobbyJoinURL( 'wss://a.example/mp', '";bind w quit;"' ),
		'wss://a.example/mp?room=%22%3Bbind+w+quit%3B%22', 'room id encoded' );
	assertEqual( netMain.NET_LobbyJoinURL( 'wss://a.example/mp', "it's" ), 'wss://a.example/mp?room=it%27s', 'quote encoded' );
	assertEqual( netMain.NET_RoomURL( 'wss://a.example/mp', { id: "it's" } ), null, 'room path with a quote refused' );
	assertEqual( netMain.NET_RoomURL( 'wss://a.example/mp', { id: '";quit' } ), 'wss://a.example/mp/room/%22%3Bquit', 'room path encoded' );

	const savedLocation = globalThis.location;
	try {

		globalThis.location = { hostname: 'localhost', host: 'localhost:8000', protocol: 'http:', search: '' };
		assertEqual( client.WS_DefaultServer(), 'ws://127.0.0.1:4433', 'local page uses the local lobby' );
		globalThis.location = { hostname: 'quake.example', host: 'quake.example', protocol: 'https:', search: '' };
		assertEqual( client.WS_DefaultServer(), 'wss://quake.example/mp', 'hosted page uses /mp on the same host' );
		assertEqual( netMain.NET_LobbyServer(), 'wss://quake.example/mp', 'lobby server default' );
		globalThis.location = { hostname: 'quake.example', host: 'quake.example', protocol: 'https:', search: '?server=wss://other.example/mp' };
		assertEqual( netMain.NET_LobbyServer(), 'wss://other.example/mp', '?server= wins' );
		globalThis.location = { hostname: 'quake.example', host: 'quake.example', protocol: 'https:', search: '?server=wss://a.example/mp%22;bind%20w%20quit;%22' };
		assertEqual( netMain.NET_LobbyServer(), null, 'crafted ?server= is refused, not replaced by the default' );

	} finally {

		globalThis.location = savedLocation;

	}

} );

Deno.test( 'WS: WS_Init fails without WebSocket', async () => {

	const saved = globalThis.WebSocket;
	try {

		delete globalThis.WebSocket;
		const original = console.log;
		console.log = () => {};
		try {

			assertEqual( client.WS_Init(), - 1, 'no WebSocket' );

		} finally {

			console.log = original;

		}

	} finally {

		globalThis.WebSocket = saved;
		await captureOutput( () => client.WS_Init() );

	}

} );
