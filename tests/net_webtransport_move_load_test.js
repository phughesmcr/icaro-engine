// Load test for client moves over datagrams (USE_CLIENT_OUTBOUND_DATAGRAMS):
// many simulated clients, each driven through the real client driver, send
// clc_move at tick rate to the real server driver over in-memory WebTransport
// pairs. Checks that no client is starved, moves arrive in order, and the
// transport acks the client sees (the PRED-2 reconciliation baseline) track
// its newest delivered move.

const {
	server,
	assert,
	assertEqual,
	openSession,
	svCheckForNewClients,
	setupServer,
	drainMessages,
	message
} = await import( './webtransport_test_env.js' );
const client = await import( '../src/net_webtransport.js' );
const { clc_nop, clc_move } = await import( '../src/protocol.js' );
const { delay, waitFor } = await import( './fake_webtransport.js' );

globalThis.window = { addEventListener() {} };
let transportFactory = null;
globalThis.WebTransport = function ( url ) {

	return transportFactory( url );

};

client.WT_Init();
delete globalThis.window;
client.WT_SetTimeouts( { connectMs: 3000, handshakeMs: 2000, closeFlushMs: 100 } );

transportFactory = () => openSession( null ).pair.client;

// clc_move stand-in: [clc_move, client number, tick lo, tick hi]
function movePayload( n, tick ) {

	return message( [ clc_move, n, tick & 0xff, ( tick >> 8 ) & 0xff ] );

}

async function runLoad( { clients: count, ticks, datagrams } ) {

	const teardown = setupServer( {
		maxclients: count,
		sockets: count * 2 + 2,
		config: { maxSessionsPerIp: count + 1, maxHandshakingSessions: count + 1 }
	} );
	client.WT_SetClientOutboundDatagrams( datagrams );

	try {

		// connect everyone
		const peers = [];
		for ( let i = 0; i < count; i ++ ) {

			const sock = await client.WT_Connect( 'localhost:4433' );
			assert( sock != null, 'client ' + i + ' connected' );
			peers.push( { n: i, sock, serverSock: null, sentSeq: [], lastTick: - 1, ackSeen: [], got: 0 } );

		}

		const accepted = svCheckForNewClients();
		assertEqual( accepted.length, count, 'server accepted every client' );
		// the server accepts in connection order
		for ( let i = 0; i < count; i ++ ) peers[ i ].serverSock = accepted[ i ];

		// the server's first sequenced message tells each client it speaks the header
		for ( const p of peers ) server.WT_QSendMessage( p.serverSock, message( [ clc_nop ] ) );
		await waitFor( () => peers.every( ( p ) => p.sock.driverdata.pendingMessages.length > 0 ), 5000, 'hello replies' );
		for ( const p of peers ) client.WT_QGetMessage( p.sock );

		const start = performance.now();
		let lost = 0;

		for ( let tick = 0; tick < ticks; tick ++ ) {

			// every client sends one move per tick
			for ( const p of peers ) {

				p.sentSeq[ tick ] = p.sock.sendSequence | 0;
				assertEqual( client.WT_SendUnreliableMessage( p.sock, movePayload( p.n, tick ) ), 1, 'move sent' );

			}

			// the server frame: read every move, then send each client its
			// per-frame message (which carries the ack)
			await waitFor( () => peers.every( ( p ) => p.serverSock.driverdata.pendingMessages.length > 0 ), 5000,
				`tick ${tick}: moves delivered` );

			for ( const p of peers ) {

				const got = drainMessages( p.serverSock ).filter( ( r ) => typeof r === 'object' );
				// a move may be coalesced with an older one that was never read
				for ( const r of got ) {

					assertEqual( r.payload[ 0 ], clc_move, 'move payload' );
					assertEqual( r.payload[ 1 ], p.n, 'move arrived on the right client' );
					const t = r.payload[ 2 ] | ( r.payload[ 3 ] << 8 );
					assert( t > p.lastTick, `client ${p.n}: move ${t} after ${p.lastTick}` );
					lost += t - p.lastTick - 1;
					p.lastTick = t;
					p.got ++;

				}

				assert( got.length >= 1, `client ${p.n} starved at tick ${tick}` );
				server.WT_QSendMessage( p.serverSock, message( [ clc_nop ] ) );

			}

			await waitFor( () => peers.every( ( p ) => p.sock.driverdata.pendingMessages.length > 0 ), 5000,
				`tick ${tick}: replies delivered` );

			for ( const p of peers ) {

				while ( client.WT_QGetMessage( p.sock ) > 0 ) { /* drain */ }
				// the ack is the transport sequence of the newest move the server read
				assert( p.sock.hasAck === true, 'hasAck is set once a packet arrived' );
				assertEqual( p.sock.ackSequence, p.sentSeq[ p.lastTick ], `client ${p.n}: ack after tick ${tick}` );
				p.ackSeen.push( p.sock.ackSequence );

			}

		}

		const elapsed = performance.now() - start;
		let moves = 0;
		for ( const p of peers ) {

			assertEqual( p.lastTick, ticks - 1, `client ${p.n} saw the last move` );
			moves += p.got;

			for ( let i = 1; i < p.ackSeen.length; i ++ )
				assert( ( ( p.ackSeen[ i ] - p.ackSeen[ i - 1 ] ) | 0 ) > 0, `client ${p.n}: ack went backwards` );

		}

		for ( const p of peers ) client.WT_Close( p.sock );
		return { moves, lost, elapsed };

	} finally {

		client.WT_SetClientOutboundDatagrams( true ); // the default
		await teardown();

	}

}

Deno.test( 'datagram moves: 32 clients x 100 ticks, in order, acked, none starved', async () => {

	const dg = await runLoad( { clients: 32, ticks: 100, datagrams: true } );
	assertEqual( dg.moves, 32 * 100, 'every move delivered' );
	assertEqual( dg.lost, 0, 'no move lost' );

	const rel = await runLoad( { clients: 32, ticks: 100, datagrams: false } );
	assertEqual( rel.moves, 32 * 100, 'every move delivered on the reliable stream' );

	// the numbers recorded in the PR
	console.log( `move load, 32 clients x 100 ticks: datagrams ${dg.moves} moves in ${dg.elapsed.toFixed( 0 )} ms, ` +
		`reliable ${rel.moves} moves in ${rel.elapsed.toFixed( 0 )} ms` );
	await delay( 20 );

} );
