// WebRTC driver tests (src/net_webrtc.js): a joiner and a host, both roles of
// the one driver in this process, connected through in-memory peer
// connections (tests/fake_webrtc.js) and a fake lobby that relays signals.
// Nothing here runs a real RTCPeerConnection.

// Bootstrap the renderer's existing circular module graph in its safe order.
await import( '../src/gl_rsurf.js' );

const rtc = await import( '../src/net_webrtc.js' );
const netMain = await import( '../src/net_main.js' );
const net = await import( '../src/net.js' );
const { svs } = await import( '../src/server.js' );
const { svc_disconnect, clc_disconnect } = await import( '../src/protocol.js' );
const {
	FakeRTCPeerConnection,
	gamePacket,
	packetSequence,
	packetAck
} = await import( './fake_webrtc.js' );

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

// Capture console output (Con_Printf) while fn runs.
async function captureOutput( fn ) {

	const lines = [];
	const original = console.log;
	console.log = ( fmt, ...args ) => {

		// Con_Printf's printf-style arguments, as the console formats them
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

// The driver registers its page-hide handler on window; capture it.
const pageHandlers = {};
globalThis.window = {
	addEventListener( type, handler ) {

		pageHandlers[ type ] = handler;

	}
};
globalThis.RTCPeerConnection = FakeRTCPeerConnection;

assertEqual( rtc.RTC_Init(), 0, 'RTC_Init' );
delete globalThis.window;
assert( typeof pageHandlers.pagehide === 'function', 'pagehide handler registered' );

const TIMEOUTS = { connectMs: 1500, handshakeMs: 300, pendingAcceptMs: 400, closeFlushMs: 300 };
rtc.RTC_SetTimeouts( TIMEOUTS );

const ROOM = 'ROOM1';
const RTC_LEVEL = 1;

/*
=============
Fake lobby

Relays signals between the joiner (this tab's client role, id joinerId) and
the host (this tab's host role, addressed by the room code), as the lobby
will. With relay off it only records them, for tests that play the joiner
by hand.
=============
*/
function makeLobby( { joinerId = 'joiner1', relay = true } = {} ) {

	const lobby = {
		log: [],
		relay,
		send( to, kind, data ) {

			lobby.log.push( { to, kind, data } );
			if ( lobby.relay !== true ) return;
			const from = to === ROOM ? joinerId : ROOM;
			setTimeout( () => rtc.RTC_HandleSignal( from, kind, data ), 1 );

		},
		iceServers() {

			return Promise.resolve( [ { urls: 'stun:stun.example.test' } ] );

		}
	};
	return lobby;

}

/*
=============
Host setup, as setupServer in net_websocket_test.js with the WebRTC driver
in slot 1
=============
*/
function setup( { maxclients = 2, sockets = 8 } = {} ) {

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
	net.net_drivers[ 1 ] = { initialized: true, CheckNewConnections: rtc.RTC_CheckNewConnections };
	rtc.RTC_SetDriverLevel( RTC_LEVEL );
	netMain.set_listening( true );
	rtc.RTC_Listen( true );
	FakeRTCPeerConnection.instances.length = 0;

	return async function teardown() {

		rtc.RTC_Shutdown();
		assertEqual( rtc.RTC_Init(), 0, 'RTC_Init again' );
		rtc.RTC_SetSignaller( null );
		rtc.RTC_SetTimeouts( TIMEOUTS );
		// Let the fakes' delivery and close timers run out
		await delay( 30 );

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

function drain( sock ) {

	const results = [];
	while ( true ) {

		const ret = rtc.RTC_QGetMessage( sock );
		if ( ret <= 0 ) {

			results.push( ret );
			return results;

		}

		results.push( { ret, payload: Array.from( net_message.data.slice( 0, net_message.cursize ) ) } );

	}

}

async function connect( lobby = makeLobby() ) {

	rtc.RTC_SetSignaller( lobby );
	const sock = await rtc.RTC_Connect( 'rtc:' + ROOM );
	assert( sock != null, 'client connected' );
	const [ serverSock ] = svCheckForNewClients();
	assert( serverSock != null, 'host accepted the joiner' );
	return { sock, serverSock, lobby };

}

/*
=============
A joiner played by hand: its own peer connection, offering through
RTC_HandleSignal as the lobby would. The lobby must not relay.
=============
*/
async function rawJoiner( id, lobby ) {

	const pc = new FakeRTCPeerConnection();
	const reliable = pc.createDataChannel( 'reliable', { ordered: true } );
	const unreliable = pc.createDataChannel( 'unreliable', { ordered: false, maxRetransmits: 0 } );
	const received = [];
	reliable.onmessage = ( event ) => received.push( new Uint8Array( event.data ) );

	const offer = await pc.createOffer();
	await pc.setLocalDescription( offer );
	const from = lobby.log.length; // only an answer to this offer
	const isAnswer = ( m, i ) => i >= from && m.to === id && m.kind === 'answer';
	rtc.RTC_HandleSignal( id, 'offer', offer );

	await waitFor( () => lobby.log.some( isAnswer ), 1000, 'answer to ' + id );
	const answer = lobby.log.find( isAnswer ).data;
	await pc.setRemoteDescription( answer );
	await waitFor( () => reliable.readyState === 'open', 1000, 'reliable channel open' );

	return { pc, reliable, unreliable, received };

}

function helloBytes( version = net.WT_PROTOCOL_VERSION ) {

	const hello = net.WT_BuildHelloFrame().subarray( 2 ).slice();
	hello[ hello.length - 1 ] = version;
	return hello;

}

/*
=============
Tests
=============
*/

Deno.test( 'RTC: joiner and host handshake, signal, and exchange reliable and unreliable messages with acks', async () => {

	const teardown = setup();
	try {

		// A hello arrives in an event callback: the socket must still get
		// this driver's level, not whatever the last driver loop left
		net.set_net_driverlevel( 0 );

		const { sock, serverSock, lobby } = await connect();

		assertEqual( sock.driver, RTC_LEVEL, 'client socket driver level' );
		assertEqual( serverSock.driver, RTC_LEVEL, 'host socket driver level' );
		assertEqual( sock.address, 'rtc:' + ROOM, 'client socket address' );
		assert( /^rtc:peer\d+$/.test( serverSock.address ), 'host socket address is a peer id: ' + serverSock.address );
		assertEqual( serverSock.maxdatagram, 1200 - 9, 'host maxdatagram' );

		// Signalling: offer to the room, answer to the joiner, candidates both ways
		const kinds = lobby.log.map( ( m ) => m.to + ':' + m.kind );
		assert( kinds.includes( ROOM + ':offer' ), 'offer sent to the room' );
		assert( kinds.includes( 'joiner1:answer' ), 'answer sent to the joiner' );
		assert( kinds.includes( ROOM + ':candidate' ) && kinds.includes( 'joiner1:candidate' ), 'candidates both ways' );

		const [ clientPc, hostPc ] = FakeRTCPeerConnection.instances;
		assertEqual( clientPc.config.iceServers[ 0 ].urls, 'stun:stun.example.test', 'client ICE servers from the lobby' );
		assertEqual( hostPc.config.iceServers[ 0 ].urls, 'stun:stun.example.test', 'host ICE servers from the lobby' );
		await waitFor( () => clientPc.candidatesAdded.length > 0 && hostPc.candidatesAdded.length > 0, 1000, 'candidates added' );

		const [ reliable, unreliable ] = clientPc.channels;
		assertEqual( reliable.label, 'reliable', 'first channel' );
		assertEqual( reliable.ordered, true, 'reliable channel ordered' );
		assertEqual( unreliable.label, 'unreliable', 'second channel' );
		assertEqual( unreliable.ordered, false, 'unreliable channel unordered' );
		assertEqual( unreliable.maxRetransmits, 0, 'unreliable channel never retransmits' );

		// Host to joiner
		assertEqual( rtc.RTC_CanSendMessage( serverSock ), true, 'host can send reliable' );
		assertEqual( rtc.RTC_CanSendUnreliableMessage( serverSock ), true, 'host can send unreliable' );
		assertEqual( rtc.RTC_QSendMessage( serverSock, message( [ 1, 2, 3 ] ) ), 1, 'host reliable send' );
		assertEqual( rtc.RTC_SendUnreliableMessage( serverSock, message( [ 4, 5 ] ) ), 1, 'host unreliable send' );
		await delay( 10 );

		const fromHost = drain( sock );
		assertEqual( fromHost.length, 3, 'joiner got two messages' );
		assertEqual( fromHost[ 0 ].ret, 1, 'reliable first' );
		assertEqual( fromHost[ 0 ].payload.join(), '1,2,3', 'reliable payload' );
		assertEqual( fromHost[ 1 ].ret, 2, 'then unreliable' );
		assertEqual( fromHost[ 1 ].payload.join(), '4,5', 'unreliable payload' );
		assertEqual( fromHost[ 2 ], 0, 'then nothing' );
		assertEqual( sock.receiveSequence, 0, 'joiner saw reliable sequence 0' );
		assertEqual( sock.unreliableReceiveSequence, 1, 'joiner saw unreliable sequence 1' );

		// Joiner to host, acknowledging the highest sequence received
		rtc.RTC_SendUnreliableMessage( sock, message( [ 6 ] ) );
		rtc.RTC_QSendMessage( sock, message( [ 7 ] ) );
		const sent = unreliable.sent[ 0 ];
		assertEqual( packetSequence( sent ), 0, 'joiner first packet sequence' );
		assertEqual( packetAck( sent ), 1, 'joiner acks the host\'s highest sequence' );
		await delay( 10 );

		const fromJoiner = drain( serverSock );
		assertEqual( fromJoiner.map( ( m ) => m.ret === undefined ? m : m.ret + ':' + m.payload.join() ).join( ' ' ), '2:6 1:7 0', 'host got both' );
		assertEqual( serverSock.ackSequence, 1, 'host saw the ack' );
		assertEqual( serverSock.hasAck, true, 'host has an ack' );

	} finally {

		await teardown();

	}

} );

Deno.test( 'RTC: a full host rejects with a reason and the joiner frees everything', async () => {

	const teardown = setup( { maxclients: 1 } );
	try {

		await connect( makeLobby( { joinerId: 'joiner1' } ) );
		const freeBefore = freeSocketCount();

		rtc.RTC_SetSignaller( makeLobby( { joinerId: 'joiner2' } ) );
		const { result, output } = await captureOutput( () => rtc.RTC_Connect( 'rtc:' + ROOM ) );

		assertEqual( result, null, 'second joiner refused' );
		assert( output.includes( 'Server is full' ), 'reason shown: ' + output );
		assertEqual( freeSocketCount(), freeBefore, 'no socket leaked' );
		await waitFor( () => rtc.RTC_GetStatsForTest().peers === 1, 1000, 'rejected peer closed' );
		assertEqual( rtc.RTC_GetStatsForTest().client, false, 'no client connection left' );

	} finally {

		await teardown();

	}

} );

Deno.test( 'RTC: the host rejects a bad hello and an old protocol version', async () => {

	const teardown = setup();
	try {

		const lobby = makeLobby( { relay: false } );
		rtc.RTC_SetSignaller( lobby );

		const bad = await rawJoiner( 'bad', lobby );
		bad.reliable.send( new Uint8Array( [ 1, 2, 3 ] ) );
		await waitFor( () => bad.received.length === 1, 1000, 'reject reply' );
		let reply = net.WT_ParseHandshakeReply( bad.received[ 0 ] );
		assertEqual( reply.status, net.WT_HANDSHAKE_REJECT, 'bad hello rejected' );
		assert( reply.reason.includes( 'Protocol mismatch' ), 'reason: ' + reply.reason );

		const old = await rawJoiner( 'old', lobby );
		old.reliable.send( helloBytes( 0 ) );
		await waitFor( () => old.received.length === 1, 1000, 'reject reply' );
		reply = net.WT_ParseHandshakeReply( old.received[ 0 ] );
		assertEqual( reply.status, net.WT_HANDSHAKE_REJECT, 'old version rejected' );
		assert( reply.reason.includes( 'Protocol version 0' ), 'reason: ' + reply.reason );

		await waitFor( () => rtc.RTC_GetStatsForTest().peers === 0, 1000, 'rejected peers closed' );
		assertEqual( bad.reliable.readyState, 'closed', 'bad joiner\'s channel closed' );
		assertEqual( svCheckForNewClients().length, 0, 'nothing for the server' );

	} finally {

		await teardown();

	}

} );

Deno.test( 'RTC: the host ignores offers while not listening, malformed and repeated ones, and past the handshaking cap', async () => {

	const teardown = setup();
	try {

		const lobby = makeLobby( { relay: false } );
		rtc.RTC_SetSignaller( lobby );
		const offer = { type: 'offer', sdp: 'v=0 fake-offer-x' };

		rtc.RTC_Listen( false );
		rtc.RTC_HandleSignal( 'a', 'offer', offer );
		assertEqual( rtc.RTC_GetStatsForTest().peers, 0, 'no peer while not listening' );
		rtc.RTC_Listen( true );

		rtc.RTC_HandleSignal( 'a', 'offer', { type: 'answer', sdp: 'v=0' } );
		rtc.RTC_HandleSignal( 'a', 'offer', { type: 'offer', sdp: 42 } );
		rtc.RTC_HandleSignal( 'a', 'offer', null );
		rtc.RTC_HandleSignal( 'a', 'offer', { type: 'offer', sdp: 'v=0 ' + 'x'.repeat( 70000 ) } );
		rtc.RTC_HandleSignal( 42, 'offer', offer );
		assertEqual( rtc.RTC_GetStatsForTest().peers, 0, 'malformed offers ignored' );

		for ( let i = 0; i < 8; i ++ ) rtc.RTC_HandleSignal( 'p' + i, 'offer', offer );
		rtc.RTC_HandleSignal( 'p0', 'offer', offer );
		rtc.RTC_HandleSignal( 'p8', 'offer', offer );
		assertEqual( rtc.RTC_GetStatsForTest().peers, 8, 'eight handshaking peers at most, one per id' );

		// Stopping drops the handshaking peers
		rtc.RTC_Listen( false );
		assertEqual( rtc.RTC_GetStatsForTest().peers, 0, 'handshaking peers dropped' );

	} finally {

		await teardown();

	}

} );

Deno.test( 'RTC: candidates before the remote description are queued, malformed ones dropped', async () => {

	const teardown = setup();
	try {

		const lobby = makeLobby( { relay: false } );
		rtc.RTC_SetSignaller( lobby );

		const pc = new FakeRTCPeerConnection();
		pc.createDataChannel( 'reliable' );
		const offer = await pc.createOffer();
		await pc.setLocalDescription( offer );

		rtc.RTC_HandleSignal( 'j', 'offer', offer );
		rtc.RTC_HandleSignal( 'j', 'candidate', { candidate: 'candidate:early', sdpMid: '0', sdpMLineIndex: 0 } );
		rtc.RTC_HandleSignal( 'j', 'candidate', { candidate: 7, sdpMid: '0' } );
		rtc.RTC_HandleSignal( 'j', 'candidate', { candidate: 'candidate:nomid' } );
		rtc.RTC_HandleSignal( 'j', 'candidate', { candidate: 'x'.repeat( 2000 ), sdpMid: '0' } );
		rtc.RTC_HandleSignal( 'nobody', 'candidate', { candidate: 'candidate:stray', sdpMid: '0' } );

		await waitFor( () => lobby.log.some( ( m ) => m.kind === 'answer' ), 1000, 'answer' );
		rtc.RTC_HandleSignal( 'j', 'candidate', { candidate: 'candidate:late', sdpMid: '0', sdpMLineIndex: 0, extra: 'dropped' } );
		await delay( 5 );

		const hostPc = FakeRTCPeerConnection.instances.find( ( p ) => p !== pc );
		const added = hostPc.candidatesAdded.map( ( c ) => c.candidate ).join( ' ' );
		assertEqual( added, 'candidate:early candidate:late', 'early candidate flushed after the offer, malformed ones dropped' );
		assertEqual( Object.keys( hostPc.candidatesAdded[ 1 ] ).sort().join(), 'candidate,sdpMLineIndex,sdpMid', 'only the init fields passed on' );

	} finally {

		await teardown();

	}

} );

Deno.test( 'RTC: a joiner that never says hello is dropped at the handshake timeout', async () => {

	const teardown = setup();
	try {

		const lobby = makeLobby( { relay: false } );
		rtc.RTC_SetSignaller( lobby );

		const { output } = await captureOutput( async () => {

			const silent = await rawJoiner( 'silent', lobby );
			await waitFor( () => rtc.RTC_GetStatsForTest().peers === 0, 1000, 'silent peer dropped' );
			await waitFor( () => silent.reliable.readyState === 'closed', 1000, 'silent joiner\'s channel closed' );

		} );
		assert( output.includes( 'handshake timed out' ), 'timeout logged: ' + output );

	} finally {

		await teardown();

	}

} );

Deno.test( 'RTC: a hello the server never accepts is freed after the pending timeout', async () => {

	const teardown = setup();
	try {

		const lobby = makeLobby( { relay: false } );
		rtc.RTC_SetSignaller( lobby );
		const freeBefore = freeSocketCount();

		const joiner = await rawJoiner( 'late', lobby );
		joiner.reliable.send( helloBytes() );
		await waitFor( () => rtc.RTC_GetStatsForTest().pending === 1, 1000, 'pending socket' );
		assertEqual( freeSocketCount(), freeBefore - 1, 'socket allocated' );

		await waitFor( () => rtc.RTC_GetStatsForTest().pending === 0, 1500, 'pending timeout' );
		assertEqual( freeSocketCount(), freeBefore, 'socket freed' );
		await waitFor( () => rtc.RTC_GetStatsForTest().peers === 0, 1000, 'peer closed' );

	} finally {

		await teardown();

	}

} );

Deno.test( 'RTC: oversized unreliable messages go reliable; backed-up ones are dropped by role', async () => {

	const teardown = setup();
	try {

		const { sock, serverSock } = await connect();
		const hostConn = serverSock.driverdata;
		const clientConn = sock.driverdata;

		// Too big for one unfragmented packet: sent on the reliable channel
		const big = new Uint8Array( 1200 ).fill( 9 );
		const { output } = await captureOutput( () => rtc.RTC_SendUnreliableMessage( serverSock, message( big ) ) );
		assert( output.includes( 'using the reliable channel' ), 'logged once: ' + output );
		await delay( 10 );
		const got = drain( sock );
		assertEqual( got[ 0 ].ret, 1, 'arrived as reliable' );
		assertEqual( got[ 0 ].payload.length, 1200, 'whole payload' );

		// Host: a backed-up unreliable channel stops datagrams, using no sequence
		hostConn.unreliable.bufferedAmount = 64 * 1024;
		assertEqual( rtc.RTC_CanSendUnreliableMessage( serverSock ), false, 'host gates datagrams' );
		const hostSeq = serverSock.sendSequence;
		const hostSent = hostConn.unreliable.sent.length;
		assertEqual( rtc.RTC_SendUnreliableMessage( serverSock, message( [ 1 ] ) ), 1, 'host drop reports success' );
		assertEqual( serverSock.sendSequence, hostSeq, 'host drop uses no sequence' );
		assertEqual( hostConn.unreliable.sent.length, hostSent, 'nothing sent' );
		hostConn.unreliable.bufferedAmount = 0;

		// Joiner: a dropped move still uses its sequence
		clientConn.unreliable.bufferedAmount = 64 * 1024;
		assertEqual( rtc.RTC_CanSendUnreliableMessage( sock ), true, 'joiner always may send' );
		const clientSeq = sock.sendSequence;
		rtc.RTC_SendUnreliableMessage( sock, message( [ 2 ] ) );
		assertEqual( sock.sendSequence, clientSeq + 1, 'joiner drop uses a sequence' );
		assertEqual( clientConn.unreliable.sent.length, 0, 'nothing sent' );
		clientConn.unreliable.bufferedAmount = 0;

		// Reliable backpressure
		hostConn.reliable.bufferedAmount = 256 * 1024;
		assertEqual( rtc.RTC_CanSendMessage( serverSock ), false, 'reliable backpressure' );
		hostConn.reliable.bufferedAmount = 1024 * 1024;
		const stalled = await captureOutput( () => rtc.RTC_QSendMessage( serverSock, message( [ 3 ] ) ) );
		assertEqual( stalled.result, - 1, 'stalled channel fails the send' );
		assertEqual( rtc.RTC_QGetMessage( serverSock ), - 1, 'and the connection' );

	} finally {

		await teardown();

	}

} );

Deno.test( 'RTC: lost and reordered unreliable packets', async () => {

	const teardown = setup();
	try {

		const { sock, serverSock } = await connect();
		const channel = serverSock.driverdata.unreliable;

		channel.dropNext = 1;
		rtc.RTC_SendUnreliableMessage( serverSock, message( [ 1 ] ) ); // lost
		channel.extraDelayMs = 30;
		rtc.RTC_SendUnreliableMessage( serverSock, message( [ 2 ] ) ); // late
		channel.extraDelayMs = 0;
		rtc.RTC_SendUnreliableMessage( serverSock, message( [ 3 ] ) );

		await delay( 10 );
		const first = drain( sock );
		assertEqual( first[ 0 ].payload.join(), '3', 'newest arrives first' );

		await delay( 40 );
		assertEqual( drain( sock ).join(), '0', 'the late, older packet is dropped as stale' );
		assertEqual( sock.unreliableReceiveSequence, 2, 'sequence stays at the newest' );

	} finally {

		await teardown();

	}

} );

Deno.test( 'RTC: malformed and oversized messages from an accepted joiner', async () => {

	const teardown = setup();
	try {

		const lobby = makeLobby( { relay: false } );
		rtc.RTC_SetSignaller( lobby );

		const joiner = await rawJoiner( 'j1', lobby );
		joiner.reliable.send( helloBytes() );
		await waitFor( () => joiner.received.length === 1, 1000, 'accept' );
		assertEqual( net.WT_ParseHandshakeReply( joiner.received[ 0 ] ).status, net.WT_HANDSHAKE_ACCEPT, 'accepted' );
		await waitFor( () => joiner.unreliable.readyState === 'open', 1000, 'unreliable open' );
		const [ serverSock ] = svCheckForNewClients();

		// An oversized unreliable message is dropped; the connection lives
		joiner.unreliable.send( new Uint8Array( net.WT_MAX_FRAME_PAYLOAD + 1 ) );
		// A full-size reliable message is fine
		joiner.reliable.send( gamePacket( 0, 0, new Uint8Array( net.NET_MAXMESSAGE ) ) );
		await delay( 10 );
		const { result } = await captureOutput( () => drain( serverSock ) );
		assertEqual( result.length, 2, 'one message then nothing' );
		assertEqual( result[ 0 ].payload.length, net.NET_MAXMESSAGE, 'full-size reliable message delivered' );

		// Text is a protocol error
		const { output } = await captureOutput( async () => {

			joiner.reliable.send( 'hello' );
			// Nothing after the error is delivered
			joiner.reliable.send( gamePacket( 1, 0, new Uint8Array( [ 5 ] ) ) );
			await delay( 10 );
			assertEqual( rtc.RTC_QGetMessage( serverSock ), - 1, 'text kills the connection' );

		} );
		assert( output.includes( 'malformed message' ), 'logged: ' + output );

	} finally {

		await teardown();

	}

} );

Deno.test( 'RTC: a new offer from a known lobby id replaces the old connection', async () => {

	const teardown = setup();
	try {

		const { serverSock, lobby } = await connect();
		lobby.relay = false;

		const { output } = await captureOutput( async () => {

			const again = await rawJoiner( 'joiner1', lobby );
			again.reliable.send( helloBytes() );
			await waitFor( () => again.received.length === 1, 1000, 'accept' );
			assertEqual( net.WT_ParseHandshakeReply( again.received[ 0 ] ).status, net.WT_HANDSHAKE_ACCEPT, 'new connection accepted' );

		} );
		assert( output.includes( 'replaced by a new connection' ), 'logged: ' + output );
		assertEqual( rtc.RTC_QGetMessage( serverSock ), - 1, 'the old socket reports the loss' );

	} finally {

		await teardown();

	}

} );

Deno.test( 'RTC: remote candidates are capped per peer connection', async () => {

	const teardown = setup();
	try {

		const { serverSock } = await connect();
		const hostPc = serverSock.driverdata.pc;
		for ( let i = 0; i < 200; i ++ )
			rtc.RTC_HandleSignal( 'joiner1', 'candidate', { candidate: 'candidate:flood' + i, sdpMid: '0' } );
		await delay( 5 );
		assertEqual( hostPc.candidatesAdded.length, 64, 'no more than the cap added' );

	} finally {

		await teardown();

	}

} );

Deno.test( 'RTC: an answer that fails to apply ends the connect at once', async () => {

	const teardown = setup();
	try {

		const lobby = makeLobby();
		const relay = lobby.send;
		lobby.send = ( to, kind, data ) => relay( to, kind, kind === 'answer' ? { type: 'answer', sdp: 'not sdp' } : data );
		rtc.RTC_SetSignaller( lobby );

		const start = performance.now();
		const { result, output } = await captureOutput( () => rtc.RTC_Connect( 'rtc:' + ROOM ) );
		assertEqual( result, null, 'connect failed' );
		assert( output.includes( 'bad answer' ), 'logged: ' + output );
		assert( output.includes( 'timed out' ) === false, 'not a timeout: ' + output );
		assert( performance.now() - start < TIMEOUTS.connectMs, 'before the connect deadline' );
		assertEqual( rtc.RTC_GetStatsForTest().client, false, 'no client connection left' );

	} finally {

		await teardown();

	}

} );

Deno.test( 'RTC: a second connect supersedes the first without an error for it', async () => {

	const teardown = setup();
	try {

		const lobby = makeLobby( { relay: false } );
		rtc.RTC_SetSignaller( lobby );

		const first = captureOutput( () => rtc.RTC_Connect( 'rtc:' + ROOM ) );
		await waitFor( () => lobby.log.some( ( m ) => m.kind === 'offer' ), 1000, 'first offer' );
		lobby.relay = true;

		const sock = await rtc.RTC_Connect( 'rtc:' + ROOM );
		const { result, output } = await first;
		assertEqual( result, null, 'first connect gave up' );
		assert( output.includes( 'connect failed' ) === false && output.includes( 'timed out' ) === false, 'no error for the first: ' + output );
		assert( sock !== null, 'second connect succeeded' );
		assertEqual( svCheckForNewClients().length, 1, 'host accepted the second' );
		assertEqual( FakeRTCPeerConnection.instances[ 0 ].closed, true, 'first peer connection closed' );

	} finally {

		await teardown();

	}

} );

Deno.test( 'RTC: stopping listening drops handshaking peers but keeps connected ones', async () => {

	const teardown = setup();
	try {

		const { serverSock, lobby } = await connect();
		lobby.relay = false;
		await rawJoiner( 'other', lobby );
		assertEqual( rtc.RTC_GetStatsForTest().peers, 2, 'one connected, one handshaking' );

		rtc.RTC_Listen( false );
		await waitFor( () => rtc.RTC_GetStatsForTest().peers === 1, 1000, 'handshaking peer dropped' );
		assertEqual( rtc.RTC_QGetMessage( serverSock ), 0, 'connected peer kept' );
		assertEqual( rtc.RTC_CanSendMessage( serverSock ), true, 'and usable' );

	} finally {

		await teardown();

	}

} );

Deno.test( 'RTC: a host close delivers the queued disconnect before the channels close', async () => {

	const teardown = setup();
	try {

		const { sock, serverSock } = await connect();

		rtc.RTC_QSendMessage( serverSock, message( [ svc_disconnect ] ) );
		rtc.RTC_Close( serverSock );
		netMain.NET_FreeQSocket( serverSock );

		await waitFor( () => sock.driverdata.dead === true, 1000, 'joiner sees the close' );
		const got = drain( sock );
		assertEqual( got[ 0 ].payload.join(), String( svc_disconnect ), 'disconnect delivered first' );
		assertEqual( got[ 1 ], - 1, 'then the connection ends' );
		await waitFor( () => rtc.RTC_GetStatsForTest().peers === 0, 1000, 'host peer closed' );

	} finally {

		await teardown();

	}

} );

Deno.test( 'RTC: a joiner close lets the host see the disconnect, and a reconnect waits for it', async () => {

	const teardown = setup();
	try {

		const { sock, serverSock, lobby } = await connect();

		rtc.RTC_QSendMessage( sock, message( [ clc_disconnect ] ) );
		rtc.RTC_Close( sock );
		netMain.NET_FreeQSocket( sock );
		assertEqual( rtc.RTC_GetStatsForTest().closing, 1, 'close in progress' );

		// A new connect starts only after the old close finishes
		const reconnect = rtc.RTC_Connect( 'rtc:' + ROOM );
		await waitFor( () => serverSock.driverdata.dead === true, 1000, 'host sees the close' );
		const got = drain( serverSock );
		assertEqual( got[ 0 ].payload.join(), String( clc_disconnect ), 'disconnect delivered' );
		assertEqual( got[ 1 ], - 1, 'then the connection ends' );
		assertEqual( rtc.RTC_GetStatsForTest().closing, 0, 'close finished' );

		// Let the server drop the old client, as SV_DropClient would
		rtc.RTC_Close( serverSock );
		netMain.NET_FreeQSocket( serverSock );
		svs.clients[ 0 ].active = false;
		net.set_net_activeconnections( 0 );

		lobby.log.length = 0;
		const sock2 = await reconnect;
		assert( sock2 != null, 'reconnected' );
		assertEqual( svCheckForNewClients().length, 1, 'host accepted the reconnect' );

	} finally {

		await teardown();

	}

} );

Deno.test( 'RTC: page hide sends clc_disconnect and closes', async () => {

	const teardown = setup();
	try {

		const { serverSock } = await connect();
		pageHandlers.pagehide();
		await waitFor( () => serverSock.driverdata.dead === true, 1000, 'host sees the close' );
		const got = drain( serverSock );
		assertEqual( got[ 0 ].payload.join(), String( clc_disconnect ), 'disconnect delivered' );
		assertEqual( got[ 1 ], - 1, 'then the connection ends' );

	} finally {

		await teardown();

	}

} );

Deno.test( 'RTC: a failed peer connection ends the socket; disconnected does not', async () => {

	const teardown = setup();
	try {

		const { serverSock } = await connect();
		const hostPc = serverSock.driverdata.pc;

		hostPc.connectionState = 'disconnected';
		hostPc.onconnectionstatechange();
		assertEqual( rtc.RTC_QGetMessage( serverSock ), 0, 'disconnected is transient' );

		await captureOutput( () => hostPc.fail() );
		assertEqual( rtc.RTC_QGetMessage( serverSock ), - 1, 'failed ends it' );

	} finally {

		await teardown();

	}

} );

Deno.test( 'RTC: the connect deadline gives up when no answer comes', async () => {

	const teardown = setup();
	try {

		rtc.RTC_SetTimeouts( { connectMs: 150 } );
		const lobby = makeLobby( { relay: false } );
		rtc.RTC_SetSignaller( lobby );
		const freeBefore = freeSocketCount();

		const { result, output } = await captureOutput( () => rtc.RTC_Connect( 'rtc:' + ROOM ) );
		assertEqual( result, null, 'connect failed' );
		assert( output.includes( 'timed out' ), 'timeout logged: ' + output );
		assertEqual( freeSocketCount(), freeBefore, 'no socket allocated' );
		assertEqual( FakeRTCPeerConnection.instances[ 0 ].closed, true, 'peer connection closed' );
		assertEqual( rtc.RTC_GetStatsForTest().client, false, 'no client connection left' );

	} finally {

		await teardown();

	}

} );

Deno.test( 'RTC: bad addresses, no lobby, and NET_Connect routing', async () => {

	const teardown = setup();
	try {

		assertEqual( rtc.RTC_IsRoomAddress( 'rtc:ABC' ), true, 'rtc: address' );
		assertEqual( rtc.RTC_IsRoomAddress( 'RTC:ABC' ), true, 'any case' );
		assertEqual( rtc.RTC_IsRoomAddress( 'rtc:' ), false, 'no code' );
		assertEqual( rtc.RTC_IsRoomAddress( 'wss://host/mp' ), false, 'websocket address' );

		rtc.RTC_SetSignaller( makeLobby() );
		let r = await captureOutput( () => rtc.RTC_Connect( 'rtc:bad code!' ) );
		assertEqual( r.result, null, 'bad code refused' );
		assert( r.output.includes( 'bad room address' ), 'logged: ' + r.output );

		rtc.RTC_SetSignaller( null );
		r = await captureOutput( () => rtc.RTC_Connect( 'rtc:' + ROOM ) );
		assertEqual( r.result, null, 'no lobby refused' );
		assert( r.output.includes( 'no lobby' ), 'logged: ' + r.output );
		assertEqual( FakeRTCPeerConnection.instances.length, 0, 'no peer connection made' );

		// NET_Init did not register the driver here, so an rtc: address must
		// fail instead of falling through to WebTransport or WebSocket
		r = await captureOutput( () => netMain.NET_Connect( 'rtc:' + ROOM ) );
		assertEqual( r.result, null, 'NET_Connect refused' );
		assert( r.output.includes( 'WebRTC not available' ), 'logged: ' + r.output );

	} finally {

		await teardown();

	}

} );

Deno.test( 'RTC: RTC_Init fails without RTCPeerConnection', async () => {

	const saved = globalThis.RTCPeerConnection;
	delete globalThis.RTCPeerConnection;
	try {

		const { result } = await captureOutput( () => rtc.RTC_Init() );
		assertEqual( result, - 1, 'RTC_Init without RTCPeerConnection' );

	} finally {

		globalThis.RTCPeerConnection = saved;

	}

} );
