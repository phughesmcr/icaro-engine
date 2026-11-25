// WebTransport network driver for multiplayer support
// New module for browser-based WebTransport client connections

import { Con_Printf, Con_DPrintf, SZ_Clear, SZ_Write } from './common.js';
import { NET_NewQSocket } from './net_main.js';
import { Sys_PageURL } from './sys.js';
import {
	net_message,
	net_driverlevel,
	WT_PACKET_MAGIC,
	WT_PACKET_HEADER_BYTES,
	WT_MAX_FRAME_PAYLOAD,
	WT_PROTOCOL_VERSION,
	WT_HANDSHAKE_REJECT,
	WT_BuildHelloFrame,
	WT_ParseHandshakeReply
} from './net.js';
import { clc_disconnect } from './protocol.js';
import { M_ClearReturnOnError, M_ConnectionError, M_Menu_Main_f } from './menu.js';
import { set_key_dest, key_menu } from './keys.js';

// WebTransport connection state
let wt_initialized = false;

// Timeout for lobby room join operations (in milliseconds)
// This should be long enough for slow connections but short enough to not hang indefinitely
const ROOM_JOIN_TIMEOUT_MS = 10000; // 10 seconds
const LOBBY_IO_TIMEOUT_MS = 10000; // 10 seconds

// Whole-connect deadline enforced by the driver. It is shorter than the 30 s
// CL_Connect timeout, so a connect never completes after its caller has given
// up on it (which would leave an unowned socket and a ghost server client).
let WT_CONNECT_TIMEOUT_MS = 25000;
// Wait for the server's handshake reply after sending the hello.
let WT_HANDSHAKE_TIMEOUT_MS = 10000;
// Bounded wait for the final reliable frames (clc_disconnect) on close.
let WT_CLOSE_FLUSH_MS = 1000;

// Inbound queue: the reliable reader pauses at this many queued messages (QUIC
// flow control then throttles the server) and resumes below the lower mark.
// Consecutive unreliable messages are coalesced, so a hidden tab cannot grow
// the queue without bound.
const WT_MAX_PENDING_MESSAGES = 1024;
const WT_RESUME_PENDING_MESSAGES = 512;

// Outbound reliable backpressure. WT_CanSendMessage reports false at the soft
// limit; unreliable traffic sent on the reliable stream is dropped past its
// own lower limit; the hard limit means the stream is stuck and the
// connection is treated as dead.
const WT_MAX_PENDING_RELIABLE_WRITES = 64;
const WT_MAX_UNRELIABLE_ON_RELIABLE = 16;
const WT_HARD_PENDING_RELIABLE_WRITES = 256;

// Client moves go out as datagrams, like QW's unreliable usercmds: a lost move
// is replaced by the next one instead of stalling behind a retransmit. Load
// test (tests/net_webtransport_move_load_test.js, and 300 real Deno 2.9.8
// loopback sessions at 60 moves/s): no starvation, no reordering, acks correct.
// The reliable stream is the fallback: for sessions without datagram support or
// moves larger than the datagram, and for everyone through
// WT_SetClientOutboundDatagrams( false ).
let USE_CLIENT_OUTBOUND_DATAGRAMS = true;

// Active connections
const wt_connections = new Map(); // qsocket_t -> WebTransportConnection

// Closed connections whose graceful close has not finished, and the
// WT_Connect calls waiting for them (see _WT_WaitForClosingConnections).
const wt_closing = new Set();
let wt_closeWaiters = [];

// Connection data structure
class WebTransportConnection {

	constructor( transport ) {

		this.transport = transport;

		// Transport protocol:
		// - Reliable bidirectional stream: signon messages, stringcmds
		// - Unreliable datagrams: entity updates, movement
		// - The first reliable frame in each direction is the connect
		//   handshake (WT_BuildHelloFrame in src/net.js)
		this.reliableStream = null;
		this.reliableWriter = null;
		this.reliableReader = null;
		this.datagramWriter = null;
		this.datagramReader = null;
		this.maxDatagramSize = 0;

		this.pendingMessages = []; // { reliable: boolean, data: Uint8Array }
		this.connected = false;
		this.error = null;
		this.sock = null;

		// Inbound backpressure
		this.readResume = null;

		// Outbound backpressure
		this.pendingReliableWrites = 0;

		// Graceful close
		this.closing = false;
		this.closeFinished = false;
		this.closeFlushed = false;
		this.reliableReaderEnded = false;
		this.closeTimer = null;

		// Sequencing state (explicit flags instead of negative-sequence sentinels)
		this.peerSequenced = false;
		this.reliableSequenceValid = false;
		this.unreliableSequenceValid = false;
		this.hasReceivedSequence = false;
		this.highestReceivedSequence = - 1;

		this.oversizedLogged = false;
		this.oversizedDatagramLogged = false;

	}

}

function _isNewerSequence( sequence, current ) {

	return ( ( sequence - current ) | 0 ) > 0;

}

// Highest sequence received on either lane. Both lanes share the peer's
// sendSequence counter, so the ack covers datagrams as well as the reliable
// stream (PRED-2).
function _WT_AckSequence( sock, conn ) {

	if ( conn != null && conn.hasReceivedSequence === true )
		return conn.highestReceivedSequence | 0;

	return sock.receiveSequence | 0;

}

function _WT_BuildSequencedPacket( sock, data, dataLength, forceHeader = false ) {

	const conn = sock.driverdata;
	if ( forceHeader !== true && ( conn == null || conn.peerSequenced !== true ) ) {

		const legacyPacket = new Uint8Array( dataLength );
		legacyPacket.set( data.subarray( 0, dataLength ), 0 );
		return legacyPacket;

	}

	const packet = new Uint8Array( WT_PACKET_HEADER_BYTES + dataLength );
	const view = new DataView( packet.buffer, packet.byteOffset, packet.byteLength );

	const sequence = sock.sendSequence | 0;
	const acknowledged = _WT_AckSequence( sock, conn );

	packet[ 0 ] = WT_PACKET_MAGIC;
	view.setUint32( 1, sequence >>> 0, true );
	view.setUint32( 5, acknowledged >>> 0, true );
	packet.set( data.subarray( 0, dataLength ), WT_PACKET_HEADER_BYTES );

	sock.sendSequence = ( sequence + 1 ) | 0;

	return packet;

}

function _WT_ParseSequencedPacket( sock, packet, reliable ) {

	if ( packet.length < WT_PACKET_HEADER_BYTES || packet[ 0 ] !== WT_PACKET_MAGIC )
		return packet;

	const conn = sock.driverdata;
	const view = new DataView( packet.buffer, packet.byteOffset, packet.byteLength );
	const sequence = view.getUint32( 1, true ) | 0;
	const acknowledged = view.getUint32( 5, true ) | 0;

	if ( conn.peerSequenced !== true || _isNewerSequence( acknowledged, sock.ackSequence | 0 ) )
		sock.ackSequence = acknowledged;
	sock.hasAck = true;
	conn.peerSequenced = true;

	if ( reliable === true ) {

		if ( conn.reliableSequenceValid === true && _isNewerSequence( sequence, sock.receiveSequence | 0 ) === false )
			return null;
		sock.receiveSequence = sequence;
		conn.reliableSequenceValid = true;

	} else {

		if ( conn.unreliableSequenceValid === true && _isNewerSequence( sequence, sock.unreliableReceiveSequence | 0 ) === false )
			return null;
		sock.unreliableReceiveSequence = sequence;
		conn.unreliableSequenceValid = true;

	}

	if ( conn.hasReceivedSequence !== true || _isNewerSequence( sequence, conn.highestReceivedSequence | 0 ) )
		conn.highestReceivedSequence = sequence;
	conn.hasReceivedSequence = true;

	return packet.subarray( WT_PACKET_HEADER_BYTES );

}

/*
=============
WT_SetClientOutboundDatagrams

Send client moves as datagrams (the default) or, with false, on the reliable
stream. See USE_CLIENT_OUTBOUND_DATAGRAMS.
=============
*/
export function WT_SetClientOutboundDatagrams( enabled ) {

	USE_CLIENT_OUTBOUND_DATAGRAMS = enabled === true;

}

/*
=============
WT_SetTimeouts

Shorten the connect, handshake and close-flush timeouts (tests use this).
Values that are not positive numbers leave the current setting.
=============
*/
export function WT_SetTimeouts( { connectMs, handshakeMs, closeFlushMs } = {} ) {

	if ( connectMs > 0 ) WT_CONNECT_TIMEOUT_MS = connectMs;
	if ( handshakeMs > 0 ) WT_HANDSHAKE_TIMEOUT_MS = handshakeMs;
	if ( closeFlushMs > 0 ) WT_CLOSE_FLUSH_MS = closeFlushMs;

}

/*
=============
WT_Init

Initialize the WebTransport driver
=============
*/
export function WT_Init() {

	// Check if WebTransport is available in this browser
	if ( typeof WebTransport === 'undefined' ) {

		Con_Printf( 'WebTransport not available in this browser\n' );
		return - 1;

	}

	if ( wt_initialized === false && typeof window !== 'undefined' ) {

		// Send clean disconnect when page unloads (browser only)
		window.addEventListener( 'pagehide', _onPageHide );
		window.addEventListener( 'beforeunload', _onPageHide );

	}

	wt_initialized = true;
	Con_Printf( 'WebTransport driver initialized\n' );

	return 0;

}

// Reused for the page-hide clc_disconnect
const _pageHideMessage = { data: new Uint8Array( [ clc_disconnect ] ), cursize: 1 };

/**
 * Handle page unload - send clean disconnect to server
 */
function _onPageHide() {

	for ( const [ sock, conn ] of wt_connections ) {

		try {

			// Same framing and sequencing as every other reliable message
			if ( conn.connected === true && conn.reliableWriter != null )
				WT_QSendMessage( sock, _pageHideMessage );

			// Flush, send FIN, then close the transport
			_WT_CloseConnection( conn );

		} catch {

			// Ignore errors during shutdown

		}

	}

	wt_connections.clear();

}

/*
=============
WT_Shutdown

Shutdown the WebTransport driver
=============
*/
export function WT_Shutdown() {

	// Close all active connections
	for ( const conn of wt_connections.values() ) {

		try {

			_WT_CloseConnection( conn );

		} catch {

			// Ignore errors during shutdown

		}

	}

	wt_connections.clear();
	wt_initialized = false;

}

/*
=============
WT_Listen

Enable/disable listening for new connections
Browser clients don't listen, only servers do
=============
*/
export function WT_Listen( _state ) {

	// Browser clients don't listen for connections
	// This is a no-op on the client side

}

/*
=============
WT_SearchForHosts

Search for available servers
=============
*/
export function WT_SearchForHosts( _xmit ) {

	// WebTransport doesn't have broadcast discovery
	// Use WT_QueryRooms instead for server list

}

// Lobby message types (must match server)
const LOBBY_LIST = 0x01;
const LOBBY_JOIN = 0x02;
const LOBBY_CREATE = 0x03;
const LOBBY_ROOMS = 0x81;
const LOBBY_ERROR = 0x82;

/*
=============
WT_QueryRooms

Query available rooms from a WebTransport server
Returns a Promise that resolves to an array of room objects
=============
*/
export async function WT_QueryRooms( serverUrl ) {

	if ( ! wt_initialized ) {

		throw new Error( 'WebTransport not initialized' );

	}

	// Parse the server URL
	let url = serverUrl;

	if ( ! url.includes( '://' ) ) {

		url = 'https://' + url;

	} else if ( url.startsWith( 'wt://' ) ) {

		url = 'https://' + url.substring( 5 );

	} else if ( url.startsWith( 'wts://' ) ) {

		url = 'https://' + url.substring( 6 );

	}

	Con_DPrintf( 'Querying rooms from ' + url + '\n' );

	let transport = null;

	try {

		// Create the WebTransport connection
		transport = new WebTransport( url );
		await transport.ready;

		// Create bidirectional stream
		const stream = await transport.createBidirectionalStream();
		const writer = stream.writable.getWriter();
		const reader = stream.readable.getReader();

		// Send LOBBY_LIST request: [type:1][length:2][data:0]
		const request = new Uint8Array( 3 );
		request[ 0 ] = LOBBY_LIST;
		request[ 1 ] = 0; // length low byte
		request[ 2 ] = 0; // length high byte
		await writer.write( request );

		// Read response header
		const headerResult = await _readExactWithTimeout(
			reader,
			3,
			LOBBY_IO_TIMEOUT_MS,
			'Room list request timed out'
		);
		if ( headerResult === null ) {

			throw new Error( 'Connection closed' );

		}

		const msgType = headerResult[ 0 ];
		const msgLen = headerResult[ 1 ] | ( headerResult[ 2 ] << 8 );

		if ( msgType === LOBBY_ERROR ) {

			const errorMsg = await _readLobbyErrorMessage( reader, msgLen, 'Room list error payload timed out' );
			throw new Error( errorMsg );

		}

		if ( msgType !== LOBBY_ROOMS ) {

			throw new Error( 'Unexpected response type: ' + msgType );

		}

		// Read room data
		let rooms = [];
		if ( msgLen > 0 ) {

			const data = await _readExactWithTimeout(
				reader,
				msgLen,
				LOBBY_IO_TIMEOUT_MS,
				'Room list response timed out'
			);
			if ( data === null ) {

				throw new Error( 'Connection closed' );

			}

			try {

				const json = new TextDecoder().decode( data );
				const parsedRooms = JSON.parse( json );
				if ( Array.isArray( parsedRooms ) === false ) {

					throw new Error( 'Invalid room list response' );

				}
				rooms = parsedRooms;

			} catch ( e ) {

				const parseError = e instanceof Error ? e.message : String( e );
				throw new Error( 'Failed to parse room list: ' + parseError );

			}

		}

		// Clean up
		writer.close().catch( () => {} );
		transport.close();

		Con_DPrintf( 'Got ' + rooms.length + ' rooms\n' );
		return rooms;

	} catch ( e ) {

		Con_Printf( 'WT_QueryRooms error: ' + e.message + '\n' );
		if ( transport ) {

			try { transport.close(); } catch { /* ignore */ }

		}

		throw e;

	}

}

/*
=============
WT_CreateRoom

Create a new room on the WebTransport server
Returns a Promise that resolves to the room object with ID
=============
*/
export async function WT_CreateRoom( serverUrl, config ) {

	if ( ! wt_initialized ) {

		throw new Error( 'WebTransport not initialized' );

	}

	// Parse the server URL
	let url = serverUrl;

	if ( ! url.includes( '://' ) ) {

		url = 'https://' + url;

	} else if ( url.startsWith( 'wt://' ) ) {

		url = 'https://' + url.substring( 5 );

	} else if ( url.startsWith( 'wts://' ) ) {

		url = 'https://' + url.substring( 6 );

	}

	Con_DPrintf( 'Creating room on ' + url + '\n' );

	let transport = null;

	try {

		// Create the WebTransport connection. transport.ready has no timeout
		// of its own, and Start Game waits on this promise (menu.js).
		transport = new WebTransport( url );
		const ready = await _WT_WithTimeout( transport.ready.then( () => true ), WT_CONNECT_TIMEOUT_MS, false );
		if ( ready !== true ) {

			throw new Error( 'Room creation timed out' );

		}

		// Create bidirectional stream
		const stream = await transport.createBidirectionalStream();
		const writer = stream.writable.getWriter();
		const reader = stream.readable.getReader();

		// Send LOBBY_CREATE request: [type:1][length:2][json config]
		const configJson = JSON.stringify( config );
		const configData = new TextEncoder().encode( configJson );
		const request = new Uint8Array( 3 + configData.length );
		request[ 0 ] = LOBBY_CREATE;
		request[ 1 ] = configData.length & 0xff;
		request[ 2 ] = ( configData.length >> 8 ) & 0xff;
		request.set( configData, 3 );
		await writer.write( request );

		// Read response header
		const headerResult = await _readExactWithTimeout(
			reader,
			3,
			LOBBY_IO_TIMEOUT_MS,
			'Room creation timed out'
		);
		if ( headerResult === null ) {

			throw new Error( 'Connection closed' );

		}

		const msgType = headerResult[ 0 ];
		const msgLen = headerResult[ 1 ] | ( headerResult[ 2 ] << 8 );

		if ( msgType === LOBBY_ERROR ) {

			const errorMsg = await _readLobbyErrorMessage( reader, msgLen, 'Room create error payload timed out' );
			throw new Error( errorMsg );

		}

		// Expect LOBBY_ROOMS response with the created room
		if ( msgType !== LOBBY_ROOMS ) {

			throw new Error( 'Unexpected response type: ' + msgType );

		}

		// Read room data
		let room = null;
		if ( msgLen <= 0 ) {

			throw new Error( 'Server returned empty room response' );

		}

		const data = await _readExactWithTimeout(
			reader,
			msgLen,
			LOBBY_IO_TIMEOUT_MS,
			'Room create response timed out'
		);
		if ( data === null ) {

			throw new Error( 'Connection closed' );

		}

		try {

			const json = new TextDecoder().decode( data );
			const parsed = JSON.parse( json );

			// Legacy server compatibility: older builds returned a room list
			// instead of the created room object.
			if ( Array.isArray( parsed ) === true ) {

				if ( parsed.length <= 0 ) {

					throw new Error( 'Server returned an empty room list' );

				}

				const newestRoom = parsed[ parsed.length - 1 ];
				room = newestRoom;

			} else {

				room = parsed;

			}

		} catch ( e ) {

			const parseError = e instanceof Error ? e.message : String( e );
			throw new Error( 'Failed to parse room create response: ' + parseError );

		}

		if ( room == null || typeof room !== 'object' || typeof room.id !== 'string' || room.id.length <= 0 ) {

			throw new Error( 'Invalid room response from server' );

		}

		// Clean up
		writer.close().catch( () => {} );
		transport.close();

		Con_Printf( 'Created room: ' + room.id + '\n' );
		return room;

	} catch ( e ) {

		Con_Printf( 'WT_CreateRoom error: ' + e.message + '\n' );
		if ( transport ) {

			try { transport.close(); } catch { /* ignore */ }

		}

		throw e;

	}

}

/*
=============
_readExact

Read exactly n bytes from a stream reader
=============
*/
// Per-reader buffer state (shared global buffer breaks concurrent lobby requests)
const _lobbyReaderBuffers = new WeakMap();

function _getLobbyReaderBuffer( reader ) {

	let buf = _lobbyReaderBuffers.get( reader );
	if ( buf == null ) {

		buf = { data: null, offset: 0 };
		_lobbyReaderBuffers.set( reader, buf );

	}

	return buf;

}

function _timeoutAfter( timeoutMs, timeoutMessage ) {

	return new Promise( ( _, reject ) => {

		setTimeout( () => reject( new Error( timeoutMessage ) ), timeoutMs );

	} );

}

async function _readExactWithTimeout( reader, n, timeoutMs, timeoutMessage ) {

	return await Promise.race( [
		_readExact( reader, n ),
		_timeoutAfter( timeoutMs, timeoutMessage )
	] );

}

async function _readLobbyErrorMessage( reader, msgLen, timeoutMessage ) {

	if ( msgLen <= 0 ) {

		return 'Lobby request failed';

	}

	const errorData = await _readExactWithTimeout( reader, msgLen, LOBBY_IO_TIMEOUT_MS, timeoutMessage );
	if ( errorData === null ) {

		return 'Lobby request failed';

	}

	const errorMsg = new TextDecoder().decode( errorData ).trim();
	if ( errorMsg.length <= 0 ) {

		return 'Lobby request failed';

	}

	return errorMsg;

}

async function _readExact( reader, n ) {

	const result = new Uint8Array( n );
	let offset = 0;
	const buf = _getLobbyReaderBuffer( reader );

	// First, use any leftover bytes from previous read
	if ( buf.data !== null && buf.offset < buf.data.length ) {

		const available = buf.data.length - buf.offset;
		const bytesToCopy = Math.min( available, n );
		result.set( buf.data.subarray( buf.offset, buf.offset + bytesToCopy ), 0 );
		offset = bytesToCopy;
		buf.offset += bytesToCopy;

		// Clear buffer if fully consumed
		if ( buf.offset >= buf.data.length ) {

			buf.data = null;
			buf.offset = 0;

		}

	}

	// Read more if needed
	while ( offset < n ) {

		const { value, done } = await reader.read();
		if ( done ) {

			return null;

		}
		if ( value == null ) {

			return null;

		}

		const bytesToCopy = Math.min( value.length, n - offset );
		result.set( value.subarray( 0, bytesToCopy ), offset );
		offset += bytesToCopy;

		// Save leftover bytes for next read
		if ( bytesToCopy < value.length ) {

			buf.data = value;
			buf.offset = bytesToCopy;

		}

	}

	return result;

}


/*
=============
Connect helpers

One WTConnectAttempt covers a whole connect, lobby redirect included. Its
deadline closes every transport the attempt opened and rejects whatever the
connect is waiting on, so the connect always settles (with null) before the
caller's own timeout and never hands back a socket nobody owns.
=============
*/
class WTConnectAttempt {

	constructor( timeoutMs ) {

		this.aborted = false;
		this.transports = new Set();
		this._reject = null;
		this.abortPromise = new Promise( ( _, reject ) => {

			this._reject = reject;

		} );
		this.abortPromise.catch( () => {} );
		this._timer = setTimeout( () => {

			this._timer = null;
			this.abort( new Error( 'Connection timed out' ) );

		}, timeoutMs );

	}

	abort( error ) {

		if ( this.aborted === true ) return;
		this.aborted = true;

		for ( const transport of this.transports ) {

			try { transport.close(); } catch { /* ignore */ }

		}

		this.transports.clear();
		this._reject( error );

	}

	wait( promise ) {

		if ( promise != null && typeof promise.catch === 'function' )
			promise.catch( () => {} );

		return Promise.race( [ promise, this.abortPromise ] );

	}

	untrack( transport ) {

		this.transports.delete( transport );

	}

	finish() {

		if ( this._timer !== null ) {

			clearTimeout( this._timer );
			this._timer = null;

		}

	}

}

function _WT_OpenTransport( url, attempt ) {

	const transport = new WebTransport( url );
	// Rejections are handled by the code that owns the transport.
	transport.ready.catch( () => {} );
	transport.closed.catch( () => {} );
	attempt.transports.add( transport );
	return transport;

}

function _WT_CloseTransport( transport, attempt ) {

	attempt.untrack( transport );
	try { transport.close(); } catch { /* ignore */ }

}

// Resolves to timeoutValue if promise has not settled within timeoutMs.
function _WT_WithTimeout( promise, timeoutMs, timeoutValue ) {

	let timer = null;
	const timeout = new Promise( ( resolve ) => {

		timer = setTimeout( () => resolve( timeoutValue ), timeoutMs );

	} );

	promise.catch( () => {} );
	return Promise.race( [ promise, timeout ] ).finally( () => clearTimeout( timer ) );

}

function _WT_ClearRoomFromUrl() {

	// Clear room from URL so refresh doesn't retry. Sys_PageURL keeps game=
	// and server=, so the menus still reach the same lobby afterwards.
	if ( typeof history !== 'undefined' && typeof window !== 'undefined' ) {

		history.replaceState( null, '', Sys_PageURL( null ) );

	}

}

// Return to the Join Game menu with a reason the player can read.
function _WT_FailConnect( reason ) {

	_WT_ClearRoomFromUrl();
	set_key_dest( key_menu );
	M_ConnectionError( reason );
	return null;

}

// Generic failure: back to the main menu, as before.
function _WT_FailConnectToMainMenu() {

	_WT_ClearRoomFromUrl();
	M_Menu_Main_f();
	set_key_dest( key_menu );
	return null;

}

/*
=============
WT_Connect

Connect to a remote server via WebTransport
host can be:
  - "wt://hostname:port" or "wts://hostname:port"
  - "hostname:port" (defaults to wts://)
  - Full URL like "https://hostname:port/quake"
  - URL with room parameter: "https://hostname:port?room=ROOMID"
=============
*/
export async function WT_Connect( host ) {

	if ( ! wt_initialized ) {

		Con_Printf( 'WebTransport not initialized\n' );
		return null;

	}

	// CL_EstablishConnection has just closed the previous connection.
	await _WT_WaitForClosingConnections();

	// Parse the host string to build the WebTransport URL
	let url = host;

	if ( ! url.includes( '://' ) ) {

		// Default to HTTPS (required for WebTransport)
		url = 'https://' + url;

	} else if ( url.startsWith( 'wt://' ) ) {

		// Convert wt:// to https://
		url = 'https://' + url.substring( 5 );

	} else if ( url.startsWith( 'wts://' ) ) {

		// Convert wts:// to https://
		url = 'https://' + url.substring( 6 );

	}

	// Extract room ID from URL if present
	let roomId = null;
	try {

		const urlObj = new URL( url );
		roomId = urlObj.searchParams.get( 'room' );
		// Remove room param from URL for the actual connection
		// (we send it via the lobby protocol instead)
		if ( roomId ) {

			urlObj.searchParams.delete( 'room' );
			url = urlObj.toString();

		}

	} catch {

		// URL parsing failed, continue without room extraction

	}

	Con_Printf( 'WebTransport connecting to ' + url + ( roomId ? ' (room: ' + roomId + ')' : '' ) + '\n' );

	const attempt = new WTConnectAttempt( WT_CONNECT_TIMEOUT_MS );

	try {

		// Direct room server connection (no lobby join parameter) should not
		// open an initial throwaway transport. Doing so creates a ghost server
		// client that times out later and can wedge unreliable datagram sends.
		if ( roomId == null ) {

			Con_Printf( 'No room ID, using direct connection\n' );
			return await _WT_ConnectDirect( url, host, null, attempt );

		}

		return await _WT_ConnectViaLobby( url, host, roomId, attempt );

	} finally {

		attempt.finish();

	}

}

/*
=============
_WT_ConnectViaLobby

Ask the lobby which room server hosts roomId, then connect to it directly.
The lobby exchange needs no qsocket.
=============
*/
async function _WT_ConnectViaLobby( url, host, roomId, attempt ) {

	let transport = null;

	try {

		transport = _WT_OpenTransport( url, attempt );
		await attempt.wait( transport.ready );

		Con_Printf( 'WebTransport connection established\n' );

		// Create bidirectional stream for lobby protocol
		const stream = await attempt.wait( transport.createBidirectionalStream() );
		const writer = stream.writable.getWriter();
		const reader = stream.readable.getReader();

		Con_Printf( 'Sending LOBBY_JOIN for room: ' + roomId + '\n' );
		const roomData = new TextEncoder().encode( roomId );
		const request = new Uint8Array( 3 + roomData.length );
		request[ 0 ] = LOBBY_JOIN;
		request[ 1 ] = roomData.length & 0xff;
		request[ 2 ] = ( roomData.length >> 8 ) & 0xff;
		request.set( roomData, 3 );
		await attempt.wait( writer.write( request ) );
		Con_Printf( 'LOBBY_JOIN sent\n' );

		// Read first framed message - could be LOBBY_ERROR, LOBBY_ROOMS (redirect), or game data
		// Use a race with timeout in case server is slow
		const firstMsg = await attempt.wait( _WT_WithTimeout(
			_WT_ReadFramedMessageWithType( reader ), ROOM_JOIN_TIMEOUT_MS, null ) );

		// The lobby connection is finished with in every case below
		_WT_CloseTransport( transport, attempt );
		transport = null;

		// Handle timeout - server didn't respond in time
		if ( firstMsg === null ) {

			Con_Printf( 'Room join timed out after %d seconds\n', ROOM_JOIN_TIMEOUT_MS / 1000 );
			return _WT_FailConnect( 'Connection timed out - server may be offline' );

		}

		if ( firstMsg.type === LOBBY_ERROR ) {

			const errMsg = new TextDecoder().decode( firstMsg.data );
			Con_Printf( 'Join failed: ' + errMsg + '\n' );
			return _WT_FailConnect( errMsg );

		}

		// Check if lobby is redirecting us to a room server
		let roomPort = null;
		if ( firstMsg.type === LOBBY_ROOMS && firstMsg.data && firstMsg.data.length > 0 ) {

			try {

				const roomInfo = JSON.parse( new TextDecoder().decode( firstMsg.data ) );
				if ( roomInfo.port )
					roomPort = roomInfo.port;

			} catch ( e ) {

				Con_Printf( 'Failed to parse room redirect: ' + e.message + '\n' );

			}

		}

		if ( roomPort != null ) {

			// Build new URL with room's port (no room parameter - direct connection)
			Con_Printf( 'Redirecting to room server on port ' + roomPort + '\n' );
			const urlObj = new URL( url );
			urlObj.port = String( roomPort );
			return await _WT_ConnectDirect( urlObj.toString(), host, roomId, attempt );

		}

		// The lobby answers every join with LOBBY_ERROR or a LOBBY_ROOMS reply
		// carrying the room's port. Anything else is a malformed reply; the lobby
		// port speaks the lobby protocol, so reconnecting there as a game client
		// can't work.
		Con_Printf( 'Lobby reply had no room port\n' );
		return _WT_FailConnect( 'Server sent an invalid room reply' );

	} catch ( error ) {

		if ( transport !== null )
			_WT_CloseTransport( transport, attempt );

		if ( attempt.aborted === true ) {

			Con_Printf( 'WebTransport connect timed out after %d seconds\n', WT_CONNECT_TIMEOUT_MS / 1000 );
			return _WT_FailConnect( 'Connection timed out - server may be offline' );

		}

		Con_Printf( 'WebTransport connect failed: ' + error.message + '\n' );
		return _WT_FailConnectToMainMenu();

	}

}

/*
=============
_WT_ConnectDirect

Connect directly to a room server (no lobby protocol)
Used when redirected from lobby to a room server on a different port

Transport protocol:
- Reliable stream: [length:2][transport_packet]
- Unreliable datagrams: transport_packet
  transport_packet: [magic:1][sequence:4][ack:4][quake_payload...]
- The first reliable frame each way is the connect handshake
  (WT_BuildHelloFrame / WT_BuildHandshakeReplyFrame in net.js)
=============
*/
async function _WT_ConnectDirect( url, originalHost, roomId, attempt ) {

	Con_Printf( 'WebTransport connecting directly to ' + url + '\n' );

	let transport = null;
	let conn = null;

	try {

		transport = _WT_OpenTransport( url, attempt );
		await attempt.wait( transport.ready );

		Con_Printf( 'WebTransport direct connection established\n' );

		conn = new WebTransportConnection( transport );

		// Reliable stream: signon messages, stringcmds
		conn.reliableStream = await attempt.wait( transport.createBidirectionalStream() );
		conn.reliableWriter = conn.reliableStream.writable.getWriter();
		conn.reliableReader = conn.reliableStream.readable.getReader();
		Con_Printf( 'Reliable stream ready\n' );

		// Unreliable channel: WebTransport datagrams
		if ( transport.datagrams == null ) {

			throw new Error( 'WebTransport datagrams unavailable' );

		}
		conn.datagramWriter = transport.datagrams.writable.getWriter();
		conn.datagramReader = transport.datagrams.readable.getReader();
		const maxDatagramSize = transport.datagrams.maxDatagramSize;
		if ( typeof maxDatagramSize === 'number' ) {

			conn.maxDatagramSize = maxDatagramSize;

		}
		Con_Printf( 'Datagram channel ready\n' );

		// Connect handshake: the server assigns a client slot or says why not
		await attempt.wait( conn.reliableWriter.write( WT_BuildHelloFrame() ) );
		const reply = await attempt.wait( _WT_WithTimeout(
			_WT_ReadHandshakeReply( conn.reliableReader ), WT_HANDSHAKE_TIMEOUT_MS, null ) );

		if ( reply === null )
			throw new Error( 'no handshake reply from server' );

		if ( reply.status === WT_HANDSHAKE_REJECT ) {

			const reason = reply.reason.length > 0 ? reply.reason : 'Connection refused';
			Con_Printf( 'Server refused connection: ' + reason + '\n' );
			attempt.untrack( transport );
			_WT_CloseConnection( conn );
			return _WT_FailConnect( reason );

		}

		if ( attempt.aborted === true )
			throw new Error( 'Connection timed out' );

		// No await from here on: the socket is either handed to the caller or
		// never allocated, so a failed connect cannot leak it.
		const sock = NET_NewQSocket();
		if ( ! sock )
			throw new Error( 'no free sockets' );

		sock.address = originalHost;
		sock.driver = net_driverlevel;
		sock.sendSequence = 0;
		sock.receiveSequence = - 1;
		sock.unreliableReceiveSequence = - 1;
		sock.ackSequence = - 1;
		sock.hasAck = false;

		conn.connected = true;
		conn.sock = sock;
		sock.driverdata = conn;
		wt_connections.set( sock, conn );
		attempt.untrack( transport );

		// Start background stream readers
		_WT_StartBackgroundReaders( sock, conn );

		// Handle connection close
		// Per original Quake design: don't set sock.disconnected here
		// Only set conn.connected = false, which makes WT_QGetMessage return -1
		// This triggers proper cleanup via Host_Error -> CL_Disconnect -> NET_Close
		// The handler only touches this connection object, never the (pooled) socket.
		transport.closed.then( () => {

			if ( conn.closing !== true )
				Con_Printf( 'WebTransport connection closed\n' );
			conn.connected = false;
			if ( conn.closing === true )
				_WT_FinishClose( conn );

		} ).catch( ( error ) => {

			if ( conn.closing !== true )
				Con_Printf( 'WebTransport connection error: ' + error.message + '\n' );
			conn.connected = false;
			conn.error = error;
			if ( conn.closing === true )
				_WT_FinishClose( conn );

		} );

		// Update URL with room parameter for easy sharing
		if ( roomId != null && typeof window !== 'undefined' ) {

			history.replaceState( null, '', Sys_PageURL( roomId ) );

		}

		// Connected: a later failure no longer returns to the Join menu
		// (_Datagram_Connect clears m_return_onerror here).
		M_ClearReturnOnError();
		return sock;

	} catch ( error ) {

		if ( transport !== null )
			attempt.untrack( transport );

		if ( conn !== null )
			_WT_CloseConnection( conn );
		else if ( transport !== null )
			_WT_CloseTransport( transport, attempt );

		if ( attempt.aborted === true ) {

			Con_Printf( 'WebTransport connect timed out after %d seconds\n', WT_CONNECT_TIMEOUT_MS / 1000 );
			return _WT_FailConnect( 'Connection timed out - server may be offline' );

		}

		Con_Printf( 'WebTransport direct connect failed: ' + error.message + '\n' );
		return _WT_FailConnectToMainMenu();

	}

}

/*
=============
_WT_ReadHandshakeReply

Read the server's first reliable frame and parse it as a handshake reply
=============
*/
async function _WT_ReadHandshakeReply( reader ) {

	const header = await _WT_ReadExact( reader, 2 );
	if ( header === null )
		throw new Error( 'server closed the connection during the handshake' );

	const length = header[ 0 ] | ( header[ 1 ] << 8 );
	if ( length > 1024 )
		throw new Error( 'invalid handshake reply (server may be running an older version)' );

	const payload = await _WT_ReadExact( reader, length );
	if ( payload === null )
		throw new Error( 'server closed the connection during the handshake' );

	const reply = WT_ParseHandshakeReply( payload );
	if ( reply === null )
		throw new Error( 'invalid handshake reply (server may be running an older version)' );

	if ( reply.version !== WT_PROTOCOL_VERSION )
		Con_DPrintf( 'Server protocol version ' + reply.version + ', client ' + WT_PROTOCOL_VERSION + '\n' );

	return reply;

}

function _WT_WakeReader( conn ) {

	const resume = conn.readResume;
	if ( resume != null ) {

		conn.readResume = null;
		resume();

	}

}

function _WT_PushPendingMessage( conn, reliable, data ) {

	const queue = conn.pendingMessages;
	// Only the newest of consecutive unreliable messages is ever delivered
	// (see WT_QGetMessage), so replace instead of growing the queue.
	if ( reliable === false && queue.length > 0 && queue[ queue.length - 1 ].reliable === false ) {

		queue[ queue.length - 1 ].data = data;
		return;

	}

	queue.push( { reliable, data } );

}

/*
=============
_WT_StartBackgroundReaders

Start background readers for reliable stream + unreliable datagrams
=============
*/
function _WT_StartBackgroundReaders( _sock, conn ) {

	Con_Printf( 'Starting reliable stream and datagram readers...\n' );
	conn.readersStarted = true;

	// Reliable stream reader
	( async () => {

		const reader = conn.reliableReader;

		// Growable receive buffer; [start, end) holds unparsed bytes.
		let buffer = new Uint8Array( 16384 );
		let start = 0;
		let end = 0;

		const append = ( bytes ) => {

			if ( end + bytes.length > buffer.length ) {

				const used = end - start;
				if ( used + bytes.length > buffer.length ) {

					let size = buffer.length * 2;
					while ( size < used + bytes.length ) size *= 2;
					const grown = new Uint8Array( size );
					grown.set( buffer.subarray( start, end ), 0 );
					buffer = grown;

				} else {

					buffer.copyWithin( 0, start, end );

				}

				start = 0;
				end = used;

			}

			buffer.set( bytes, end );
			end += bytes.length;

		};

		// Bytes the handshake read already pulled off the stream
		const leftover = _getWTReaderBuffer( reader );
		if ( leftover.data !== null && leftover.offset < leftover.data.length )
			append( leftover.data.subarray( leftover.offset ) );
		leftover.data = null;
		leftover.offset = 0;

		let cleanEnd = false;

		try {

			while ( conn.connected && conn.reliableReader === reader ) {

				// Process complete frames: [length:2][data...]
				while ( end - start >= 2 ) {

					const length = buffer[ start ] | ( buffer[ start + 1 ] << 8 );
					if ( length > WT_MAX_FRAME_PAYLOAD )
						throw new Error( 'oversized reliable frame (' + length + ' bytes)' );
					if ( end - start < 2 + length ) break;

					_WT_PushPendingMessage( conn, true, buffer.slice( start + 2, start + 2 + length ) );
					start += 2 + length;

				}

				if ( start === end ) {

					start = 0;
					end = 0;

				}

				// Backpressure: stop reading until the game loop catches up
				if ( conn.pendingMessages.length >= WT_MAX_PENDING_MESSAGES ) {

					await new Promise( ( resolve ) => {

						conn.readResume = resolve;

					} );
					continue;

				}

				const { value, done } = await reader.read();
				if ( done || value == null ) {

					cleanEnd = true;
					break;

				}

				if ( value.length > 0 )
					append( value );

			}

		} catch ( error ) {

			if ( conn.connected ) {

				Con_Printf( 'Reliable reader error: ' + error.message + '\n' );
				conn.error = error;

			}

		}

		if ( conn.connected ) {

			if ( cleanEnd )
				Con_DPrintf( 'Server closed the reliable stream\n' );
			conn.connected = false;

		}

		conn.reliableReaderEnded = true;
		_WT_MaybeFinishClose( conn );

	} )();

	// Unreliable datagram reader
	( async () => {

		const reader = conn.datagramReader;

		try {

			while ( conn.connected && conn.datagramReader === reader ) {

				const { value, done } = await reader.read();
				if ( done ) break;
				if ( value == null || value.length === 0 ) continue;

				if ( value.length > WT_MAX_FRAME_PAYLOAD ) {

					if ( conn.oversizedLogged !== true ) {

						conn.oversizedLogged = true;
						Con_Printf( 'Dropping oversized datagram (' + value.length + ' bytes)\n' );

					}
					continue;

				}

				_WT_PushPendingMessage( conn, false, new Uint8Array( value ) );

			}

		} catch ( error ) {

			if ( conn.connected ) {

				Con_DPrintf( 'Datagram reader error: ' + error.message + '\n' );

			}

		}

	} )();

}

/*
=============
_WT_ReadFramedMessageWithType

Read a lobby framed message and return both type and data
Frame format: [type:1][length:2][data:N]
=============
*/
async function _WT_ReadFramedMessageWithType( reader ) {

	// Read header (3 bytes: type + length)
	const header = await _WT_ReadExact( reader, 3 );
	if ( ! header ) return null;

	const type = header[ 0 ];
	const length = header[ 1 ] | ( header[ 2 ] << 8 );

	if ( length === 0 ) return { type, data: new Uint8Array( 0 ) };

	// Read message data
	const data = await _WT_ReadExact( reader, length );
	if ( ! data ) return null;

	return { type, data };

}

/*
=============
_WT_ReadExact

Read exactly n bytes from a reader, with buffering for leftover bytes
=============
*/
// Per-reader buffer storage (WeakMap to avoid memory leaks)
const _wtReaderBuffers = new WeakMap();

function _getWTReaderBuffer( reader ) {

	let buf = _wtReaderBuffers.get( reader );
	if ( ! buf ) {

		buf = { data: null, offset: 0 };
		_wtReaderBuffers.set( reader, buf );

	}
	return buf;

}

async function _WT_ReadExact( reader, n ) {

	const result = new Uint8Array( n );
	let offset = 0;
	const buf = _getWTReaderBuffer( reader );

	// First, use any leftover bytes from previous read
	if ( buf.data && buf.offset < buf.data.length ) {

		const available = buf.data.length - buf.offset;
		const bytesToCopy = Math.min( available, n );
		result.set( buf.data.subarray( buf.offset, buf.offset + bytesToCopy ), 0 );
		offset = bytesToCopy;
		buf.offset += bytesToCopy;

		// Clear buffer if fully consumed
		if ( buf.offset >= buf.data.length ) {

			buf.data = null;
			buf.offset = 0;

		}

	}

	// Read more if needed
	while ( offset < n ) {

		const { value, done } = await reader.read();
		if ( done || value == null ) return null;

		const bytesToCopy = Math.min( value.length, n - offset );
		result.set( value.subarray( 0, bytesToCopy ), offset );
		offset += bytesToCopy;

		// Save leftover bytes for next read
		if ( bytesToCopy < value.length ) {

			buf.data = value;
			buf.offset = bytesToCopy;

		}

	}

	return result;

}

/*
=============
WT_CheckNewConnections

Check for new incoming connections (server-side only)
=============
*/
export function WT_CheckNewConnections() {

	// Browser clients don't accept connections
	return null;

}

/*
=============
WT_QGetMessage

Get a message from the connection
Returns:
  0 = no message
  1 = reliable message
  2 = unreliable message
  -1 = error
=============
*/
export function WT_QGetMessage( sock ) {

	const conn = sock.driverdata;
	if ( ! conn ) {

		return - 1;

	}

	if ( ! conn.connected && conn.pendingMessages.length === 0 ) {

		return - 1;

	}

	while ( conn.pendingMessages.length > 0 ) {

		// Get next message
		let msg = conn.pendingMessages.shift();

		// For unreliable messages, skip to the most recent one.
		// In original Quake, unreliable messages are overwritten by newer ones.
		// The WebTransport datagram reader queues all datagrams, so if the
		// sender is faster than the reader, stale messages pile up.
		if ( msg.reliable === false ) {

			while ( conn.pendingMessages.length > 0 ) {

				const next = conn.pendingMessages[ 0 ];
				if ( next.reliable ) break; // Stop at next reliable message
				conn.pendingMessages.shift();
				msg = next; // Use newer unreliable message

			}

		}

		if ( conn.readResume != null && conn.pendingMessages.length <= WT_RESUME_PENDING_MESSAGES )
			_WT_WakeReader( conn );

		const payload = _WT_ParseSequencedPacket( sock, msg.data, msg.reliable );
		if ( payload == null )
			continue;

		// Never let a server-sized payload overflow net_message (SZ_Write
		// would call Sys_Error and kill the tab).
		if ( payload.length > net_message.maxsize ) {

			if ( msg.reliable === false ) {

				if ( conn.oversizedLogged !== true ) {

					conn.oversizedLogged = true;
					Con_Printf( 'Dropping oversized message from server (' + payload.length + ' bytes)\n' );

				}
				continue;

			}

			Con_Printf( 'Oversized reliable message from server (' + payload.length + ' bytes), disconnecting\n' );
			conn.connected = false;
			conn.pendingMessages.length = 0;
			return - 1;

		}

		// Copy to net_message
		SZ_Clear( net_message );
		SZ_Write( net_message, payload, payload.length );

		sock.lastMessageTime = performance.now() / 1000;

		return msg.reliable ? 1 : 2;

	}

	if ( conn.connected )
		return 0;

	return - 1;

}

function _WT_WriteReliableFrame( conn, frame ) {

	conn.pendingReliableWrites ++;
	conn.reliableWriter.write( frame ).then( () => {

		conn.pendingReliableWrites --;

	}, ( error ) => {

		conn.pendingReliableWrites --;
		if ( conn.closing !== true ) {

			Con_Printf( 'WT_QSendMessage error: ' + error.message + '\n' );
			conn.connected = false;
			conn.error = error;

		}

	} );

}

/*
=============
WT_QSendMessage

Send a reliable message via the reliable stream.
Frame format: [length:2][data...]
QUIC streams handle ordering and retransmission.
=============
*/
export function WT_QSendMessage( sock, data ) {

	const conn = sock.driverdata;
	if ( conn == null || ! conn.connected ) return - 1;

	// Check for previous async error (detected on last call)
	if ( conn.error != null ) {

		Con_DPrintf( 'WT_QSendMessage: previous error detected, connection dead\n' );
		conn.connected = false;
		return - 1;

	}

	if ( conn.reliableWriter == null ) {

		Con_DPrintf( 'WT_QSendMessage: no reliableWriter\n' );
		return - 1;

	}

	// The stream has not accepted anything for a long time: treat it as dead
	// rather than buffering without limit.
	if ( conn.pendingReliableWrites >= WT_HARD_PENDING_RELIABLE_WRITES ) {

		Con_Printf( 'WT_QSendMessage: reliable stream stalled, disconnecting\n' );
		conn.connected = false;
		conn.error = new Error( 'reliable stream stalled' );
		return - 1;

	}

	// Frame the message: [length:2][data...]
	const packet = _WT_BuildSequencedPacket( sock, data.data, data.cursize, true );
	const frame = new Uint8Array( 2 + packet.length );
	frame[ 0 ] = packet.length & 0xff;
	frame[ 1 ] = ( packet.length >> 8 ) & 0xff;
	frame.set( packet, 2 );

	// Send asynchronously - QUIC handles reliability
	_WT_WriteReliableFrame( conn, frame );

	return 1;

}

// Send unreliable data on the reliable stream, or drop it when the stream is
// backed up. A dropped message still uses up a sequence number, so commands
// stored for prediction keep distinct sequences.
function _WT_SendUnreliableOnReliable( sock, conn, data ) {

	if ( conn.pendingReliableWrites >= WT_MAX_UNRELIABLE_ON_RELIABLE ) {

		sock.sendSequence = ( sock.sendSequence + 1 ) | 0;
		return 1;

	}

	return WT_QSendMessage( sock, data );

}

/*
=============
WT_SendUnreliableMessage

Send an unreliable message via WebTransport datagrams.
=============
*/
export function WT_SendUnreliableMessage( sock, data ) {

	const conn = sock.driverdata;
	if ( conn == null || ! conn.connected ) {

		Con_DPrintf( 'WT_SendUnreliableMessage: no connection\n' );
		return - 1;

	}

	// Check for previous async error
	if ( conn.error != null ) {

		Con_DPrintf( 'WT_SendUnreliableMessage: previous error detected\n' );
		return - 1;

	}

	// Reliable-stream fallback: disabled, or a session without datagrams
	if ( USE_CLIENT_OUTBOUND_DATAGRAMS !== true || conn.datagramWriter == null ) {

		return _WT_SendUnreliableOnReliable( sock, conn, data );

	}

	if ( conn.maxDatagramSize > 0 && WT_PACKET_HEADER_BYTES + data.cursize > conn.maxDatagramSize ) {

		// Too large for the current path MTU: use the reliable stream instead.
		if ( conn.oversizedDatagramLogged !== true ) {

			conn.oversizedDatagramLogged = true;
			Con_Printf( 'WT_SendUnreliableMessage: ' + ( WT_PACKET_HEADER_BYTES + data.cursize ) +
				'-byte message exceeds max datagram size ' + conn.maxDatagramSize + '; using reliable stream\n' );

		}
		return _WT_SendUnreliableOnReliable( sock, conn, data );

	}

	const packet = _WT_BuildSequencedPacket( sock, data.data, data.cursize, true );

	// Send via unreliable datagrams
	conn.datagramWriter.write( packet ).catch( () => {

		// Unreliable — silently fail

	} );

	return 1;

}

/*
=============
WT_CanSendMessage

Check if we can send a reliable message
=============
*/
export function WT_CanSendMessage( sock ) {

	const conn = sock.driverdata;
	if ( ! conn ) return false;

	return conn.connected && conn.reliableWriter != null &&
		conn.pendingReliableWrites < WT_MAX_PENDING_RELIABLE_WRITES;

}

/*
=============
WT_CanSendUnreliableMessage

Check if we can send an unreliable message
=============
*/
export function WT_CanSendUnreliableMessage( sock ) {

	const conn = sock.driverdata;
	if ( ! conn ) return false;

	if ( USE_CLIENT_OUTBOUND_DATAGRAMS !== true || conn.datagramWriter == null ) {

		return conn.connected && conn.reliableWriter != null &&
			conn.pendingReliableWrites < WT_MAX_UNRELIABLE_ON_RELIABLE;

	}

	return conn.connected && conn.datagramWriter != null;

}

/*
=============
_WT_CloseConnection

Graceful close: stop delivering messages, let the writes already queued on
the reliable stream (clc_disconnect) go out, send FIN, then close the
transport once the server has reacted or WT_CLOSE_FLUSH_MS has passed.
=============
*/
function _WT_CloseConnection( conn ) {

	if ( conn.closing === true ) return;
	conn.closing = true;
	conn.connected = false;
	if ( conn.closeFinished !== true ) wt_closing.add( conn );
	_WT_WakeReader( conn );

	try {

		if ( conn.datagramReader ) {

			conn.datagramReader.cancel().catch( () => {} );
			conn.datagramReader = null;

		}

		if ( conn.datagramWriter ) {

			conn.datagramWriter.releaseLock();
			conn.datagramWriter = null;

		}

	} catch {

		// Ignore errors during close

	}

	const writer = conn.reliableWriter;
	conn.reliableWriter = null;

	if ( writer == null || conn.error != null ) {

		_WT_FinishClose( conn );
		return;

	}

	conn.closeTimer = setTimeout( () => {

		conn.closeTimer = null;
		_WT_FinishClose( conn );

	}, WT_CLOSE_FLUSH_MS );

	// close() completes after every write queued before it, then sends FIN
	writer.close().then( () => {

		conn.closeFlushed = true;
		_WT_MaybeFinishClose( conn );

	}, () => {

		_WT_FinishClose( conn );

	} );

}

function _WT_MaybeFinishClose( conn ) {

	if ( conn.closing === true && conn.closeFlushed === true &&
		( conn.reliableReaderEnded === true || conn.readersStarted !== true ) )
		_WT_FinishClose( conn );

}

/*
=============
_WT_WaitForClosingConnections

Resolves once every connection that is still closing has finished: the server
dropped the client and sent FIN, or WT_CLOSE_FLUSH_MS passed.

Deliberate deviation: the C client reconnects at once, and the C server frees
the old slot itself, because _Datagram_CheckNewConnections (net_dgrm.c) closes
any qsocket from the connecting IP. That rule would also drop other players
behind the same NAT or in another tab, so the port waits here instead.
Without the wait, the room server (20 Hz, SV_CheckForNewClients before
SV_RunClients) can accept the reconnect into a new slot in the same tick that
it drops the old one.
=============
*/
function _WT_WaitForClosingConnections() {

	if ( wt_closing.size === 0 ) return Promise.resolve();
	return new Promise( ( resolve ) => {

		wt_closeWaiters.push( resolve );

	} );

}

function _WT_WakeCloseWaiters() {

	if ( wt_closing.size !== 0 ) return;
	const waiters = wt_closeWaiters;
	wt_closeWaiters = [];
	for ( const resolve of waiters ) resolve();

}

function _WT_FinishClose( conn ) {

	if ( conn.closeFinished === true ) return;
	conn.closeFinished = true;
	conn.connected = false;
	if ( wt_closing.delete( conn ) === true ) _WT_WakeCloseWaiters();

	if ( conn.closeTimer !== null ) {

		clearTimeout( conn.closeTimer );
		conn.closeTimer = null;

	}

	_WT_WakeReader( conn );

	try {

		if ( conn.reliableReader ) {

			conn.reliableReader.cancel().catch( () => {} );
			conn.reliableReader = null;

		}

		conn.transport.close();

	} catch {

		// Ignore errors during close

	}

}

/*
=============
WT_Close

Close a connection. The socket is detached at once (NET_Close frees it
straight after); the final reliable frames are flushed in the background.
=============
*/
export function WT_Close( sock ) {

	const conn = sock.driverdata;
	if ( ! conn ) return;

	_WT_CloseConnection( conn );

	wt_connections.delete( sock );
	conn.sock = null;
	sock.driverdata = null;

}

/*
=============
WT_GetAnyMessage

Used for control messages during connection
=============
*/
export function WT_GetAnyMessage() {

	// Not used for WebTransport
	return 0;

}
