// NET_GetMessage and NET_Send* flag a socket whose connection died with
// sock.lost, which CL_Disconnect uses to tell a lost connection (reconnect)
// from a deliberate disconnect (src/cl_reconnect.js).

await import( '../src/gl_rsurf.js' ); // bootstrap the renderer's module graph
const net = await import( '../src/net.js' );
const { NET_GetMessage, NET_SendUnreliableMessage, NET_SendMessage } = await import( '../src/net_main.js' );

function assertEqual( actual, expected, message ) {

	if ( actual !== expected )
		throw new Error( `${message}: expected ${expected}, got ${actual}` );

}

Deno.test( 'a dead connection flags the socket lost', () => {

	const FAKE_DRIVER = net.MAX_NET_DRIVERS - 1;
	const savedDriver = net.net_drivers[ FAKE_DRIVER ];
	let alive = true;
	net.net_drivers[ FAKE_DRIVER ] = {
		initialized: true,
		QGetMessage: () => alive ? 0 : - 1,
		QSendMessage: () => alive ? 1 : - 1,
		SendUnreliableMessage: () => alive ? 1 : - 1
	};

	const sock = new net.qsocket_t();
	sock.lost = false;
	try {

		sock.driver = FAKE_DRIVER;
		sock.lastMessageTime = Number.MAX_SAFE_INTEGER; // no timeout

		assertEqual( NET_GetMessage( sock ), 0, 'quiet' );
		assertEqual( sock.lost, false, 'alive' );

		alive = false;
		assertEqual( NET_GetMessage( sock ), - 1, 'read fails' );
		assertEqual( sock.lost, true, 'read marks lost' );

		// A send that fails while the driver still holds the connection open
		// (a message too large) is not a lost connection
		const conn = { connected: true, error: null };
		sock.driverdata = conn;
		sock.lost = false;
		assertEqual( NET_SendMessage( sock, net.net_message ), - 1, 'oversize send fails' );
		assertEqual( sock.lost, false, 'a failed send on a live connection is not lost' );

		conn.connected = false;
		assertEqual( NET_SendUnreliableMessage( sock, net.net_message ), - 1, 'unreliable send fails' );
		assertEqual( sock.lost, true, 'unreliable send marks lost' );

		sock.lost = false;
		conn.connected = true;
		conn.error = new Error( 'reset' );
		assertEqual( NET_SendMessage( sock, net.net_message ), - 1, 'send fails' );
		assertEqual( sock.lost, true, 'send after a driver error marks lost' );

	} finally {

		net.net_drivers[ FAKE_DRIVER ] = savedDriver;

	}

} );
