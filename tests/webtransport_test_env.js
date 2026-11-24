// Shared setup for the WebTransport driver lifecycle tests: the server
// driver wired to the real net_main socket pool, plus raw-client helpers.

// Bootstrap the renderer's existing circular module graph in its safe order.
await import( '../src/gl_rsurf.js' );

export const server = await import( '../server/net_webtransport_server.ts' );
export const netMain = await import( '../src/net_main.js' );
export const net = await import( '../src/net.js' );
export const { svs } = await import( '../src/server.js' );
const { createFakeWebTransportPair, delay, waitFor } = await import( './fake_webtransport.js' );

export const { net_message } = net;

export function assertEqual( actual, expected, message ) {

	if ( actual !== expected )
		throw new Error( `${message}: expected ${expected}, got ${actual}` );

}

export function assert( condition, message ) {

	if ( condition !== true )
		throw new Error( message );

}

// Reads [len:u16le][payload] frames from a raw stream reader.
export class FrameReader {

	constructor( reader ) {

		this.reader = reader;
		this.buffer = new Uint8Array( 0 );
		this.ended = false;

	}

	// Resolves to the next payload, or null once the stream ends.
	async read( timeoutMs = 2000 ) {

		const deadline = performance.now() + timeoutMs;
		while ( true ) {

			if ( this.buffer.length >= 2 ) {

				const length = this.buffer[ 0 ] | ( this.buffer[ 1 ] << 8 );
				if ( this.buffer.length >= 2 + length ) {

					const payload = this.buffer.slice( 2, 2 + length );
					this.buffer = this.buffer.slice( 2 + length );
					return payload;

				}

			}

			if ( this.ended ) return null;

			let timer = null;
			const timeout = new Promise( ( _, reject ) => {

				timer = setTimeout( () => reject( new Error( 'FrameReader timed out' ) ),
					Math.max( 1, deadline - performance.now() ) );

			} );

			let result;
			try {

				result = await Promise.race( [ this.reader.read(), timeout ] );

			} catch ( error ) {

				if ( error.message === 'FrameReader timed out' ) throw error;
				this.ended = true;
				return null;

			} finally {

				clearTimeout( timer );

			}

			if ( result.done ) {

				this.ended = true;
				continue;

			}

			const merged = new Uint8Array( this.buffer.length + result.value.length );
			merged.set( this.buffer, 0 );
			merged.set( result.value, this.buffer.length );
			this.buffer = merged;

		}

	}

}

// A bare client: opens the reliable stream and optionally sends the hello.
export async function rawClient( pair, { hello = true } = {} ) {

	const stream = await pair.client.createBidirectionalStream();
	const writer = stream.writable.getWriter();
	const frames = new FrameReader( stream.readable.getReader() );
	if ( hello ) await writer.write( net.WT_BuildHelloFrame() );
	return { pair, writer, frames };

}

let nextAddress = 1;

// Start a session on the server driver; returns the pair and the accept promise.
export function openSession( ip = null, options = {} ) {

	const pair = createFakeWebTransportPair( options );
	const n = nextAddress ++;
	const host = ip ?? '10.0.0.' + n;
	const accepted = server.WT_AcceptSessionForTest( pair.server, host + ':' + ( 40000 + n ), host );
	return { pair, accepted };

}

export async function connectRaw( ip = null ) {

	const { pair, accepted } = openSession( ip );
	const client = await rawClient( pair );
	await accepted;
	const reply = net.WT_ParseHandshakeReply( await client.frames.read() );
	return { ...client, reply };

}

// What SV_CheckForNewClients does, minus SV_ConnectClient. Throws where the
// real one would call Sys_Error.
export function svCheckForNewClients() {

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

const DEFAULT_CONFIG = {
	maxSessionsPerIp: 8,
	maxHandshakingSessions: 16,
	handshakeTimeoutMs: 10000,
	pendingAcceptTimeoutMs: 30000,
	closeFlushMs: 1000
};

export function setupServer( { maxclients = 2, sockets = 8, config = {} } = {} ) {

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
	net.net_drivers[ 1 ] = { initialized: true, CheckNewConnections: server.WT_CheckNewConnections };
	netMain.set_listening( true );

	server.WT_SetSocketAllocator( netMain.NET_NewQSocket );
	server.WT_SetSocketFreer( netMain.NET_FreeQSocket );
	server.WT_SetConfig( {
		...DEFAULT_CONFIG,
		handshakeTimeoutMs: 300,
		closeFlushMs: 300,
		...config
	} );

	return async function teardown() {

		server.WT_Shutdown();
		// Free sockets still queued for acceptance (their connections are dead now).
		while ( server.WT_CheckNewConnections() !== null ) { /* drain */ }
		await waitFor( () => {

			const stats = server.WT_GetSessionStatsForTest();
			return stats.handshaking === 0 && stats.live === 0 && stats.pending === 0;

		}, 3000, 'server sessions to close' );
		await delay( 10 );

		server.WT_SetConfig( DEFAULT_CONFIG );
		server.WT_SetSocketAllocator( null );
		server.WT_SetSocketFreer( null );
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

export function drainMessages( sock ) {

	const results = [];
	while ( true ) {

		const ret = server.WT_QGetMessage( sock );
		if ( ret <= 0 ) {

			results.push( ret );
			return results;

		}

		results.push( { ret, payload: net_message.data.slice( 0, net_message.cursize ) } );

	}

}

export function message( bytes ) {

	return { data: new Uint8Array( bytes ), cursize: bytes.length };

}

export function packetAck( packet ) {

	return new DataView( packet.buffer, packet.byteOffset, packet.byteLength ).getUint32( 5, true ) | 0;

}

export function packetSequence( packet ) {

	return new DataView( packet.buffer, packet.byteOffset, packet.byteLength ).getUint32( 1, true ) | 0;

}

