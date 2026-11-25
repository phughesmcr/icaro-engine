// SV_ClientDatagramSize: FitzQuake/QuakeSpasm give the local client
// MAX_DATAGRAM and network clients DATAGRAM_MTU; here a network client gets
// its driver's datagram limit (sock.maxdatagram), clamped.

import '../src/common.js'; // load order, as sv_signon_test.js: avoids an import-cycle TDZ
import { MAX_DATAGRAM, MAX_DATAGRAM_ID, DATAGRAM_MTU, MAX_MSGLEN } from '../src/quakedef.js';
import { NET_MAXMESSAGE, qsocket_t } from '../src/net.js';
import '../src/server.js';
import { SV_ClientDatagramSize } from '../src/sv_main.js';

function assertEqual( actual, expected, message ) {

	if ( actual !== expected )
		throw new Error( `${message}: expected ${expected}, got ${actual}` );

}

Deno.test( 'the loopback client gets MAX_DATAGRAM, more than id\'s 1024', () => {

	const sock = new qsocket_t();
	sock.address = 'LOCAL'; // net_loop.js's server-side socket
	assertEqual( SV_ClientDatagramSize( sock ), MAX_DATAGRAM, 'local limit' );
	if ( ! ( MAX_DATAGRAM > MAX_DATAGRAM_ID ) )
		throw new Error( 'MAX_DATAGRAM must exceed id\'s 1024' );
	// a sock.maxdatagram on the loopback socket doesn't shrink it
	sock.maxdatagram = 1150;
	assertEqual( SV_ClientDatagramSize( sock ), MAX_DATAGRAM, 'local limit ignores maxdatagram' );

} );

Deno.test( 'MAX_DATAGRAM leaves room in the loopback buffer and fits a demo message', () => {

	// Loop_SendMessage calls Sys_Error when the frame's datagram and a
	// reliable message don't fit in one NET_MAXMESSAGE buffer (4-byte header each)
	if ( ! ( NET_MAXMESSAGE - ( MAX_DATAGRAM + 4 ) - 4 >= 4000 ) )
		throw new Error( 'MAX_DATAGRAM leaves less than 4000 bytes for a reliable message' );
	// CL_GetMessage rejects demo messages over MAX_MSGLEN
	if ( ! ( MAX_DATAGRAM <= MAX_MSGLEN ) )
		throw new Error( 'MAX_DATAGRAM exceeds MAX_MSGLEN' );

} );

Deno.test( 'a WebTransport client gets its datagram limit, capped at DATAGRAM_MTU', () => {

	const sock = new qsocket_t();
	sock.address = '10.0.0.1:40001';

	// a typical maxDatagramSize less the 9-byte transport header
	sock.maxdatagram = 1150;
	assertEqual( SV_ClientDatagramSize( sock ), 1150, 'path limit' );

	sock.maxdatagram = 1404; // localhost after path MTU discovery
	assertEqual( SV_ClientDatagramSize( sock ), DATAGRAM_MTU, 'capped at DATAGRAM_MTU' );

	sock.maxdatagram = 65527;
	assertEqual( SV_ClientDatagramSize( sock ), DATAGRAM_MTU, 'a huge value is capped' );

	sock.maxdatagram = 1150.7;
	assertEqual( SV_ClientDatagramSize( sock ), 1150, 'whole bytes' );

	// below id's 1024 the floor keeps room for the fixed prefix; the driver
	// sends the rare larger message on its reliable fallback
	sock.maxdatagram = 300;
	assertEqual( SV_ClientDatagramSize( sock ), MAX_DATAGRAM_ID, 'floor' );

} );

Deno.test( 'an unknown datagram limit falls back to id\'s MAX_DATAGRAM', () => {

	const sock = new qsocket_t();
	sock.address = '10.0.0.1:40001';
	assertEqual( sock.maxdatagram, 0, 'a new qsocket_t has no limit' );
	assertEqual( SV_ClientDatagramSize( sock ), MAX_DATAGRAM_ID, 'zero' );

	for ( const v of [ - 1, NaN, Infinity, undefined, null, '1200' ] ) {

		sock.maxdatagram = v;
		assertEqual( SV_ClientDatagramSize( sock ), MAX_DATAGRAM_ID, 'maxdatagram ' + String( v ) );

	}

	// a driver that never sets the field (as the fakes in sv_signon_test.js)
	assertEqual( SV_ClientDatagramSize( { driver: 0, disconnected: false } ), MAX_DATAGRAM_ID, 'no field' );

} );
