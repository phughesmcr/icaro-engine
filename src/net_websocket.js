// WebSocket network driver for multiplayer support
// New module (no C counterpart): browser WebSocket client connections, for
// browsers without WebTransport and for HTTP-only proxies such as a
// Cloudflare Tunnel. It sits beside src/net_webtransport.js in net_drivers and
// speaks the same handshake and sequencing header (see src/net.js).
//
// Trade-off: WebSocket runs over one TCP stream, so there are no unreliable
// datagrams. "Unreliable" messages are sent on the same ordered stream with a
// channel byte. A lost TCP segment holds back every later message until it is
// retransmitted (head-of-line blocking), so a lossy link stutters instead of
// dropping the odd update. To limit how much stale data can pile up, senders
// drop unreliable messages while the socket is backed up, and the receiver
// only ever delivers the newest of consecutive queued unreliable messages.
//
// Sources: the driver interface follows Ironwail's Quake/net_dgrm.c and
// Quake/net_main.c (https://github.com/andrei-drexler/ironwail) as
// net_webtransport.js does; the server side is server/net_websocket_server.ts.
// Cloudflare proxies WebSockets on every plan, closes idle ones and may drop
// them on restarts (https://developers.cloudflare.com/network/websockets/);
// a dropped connection ends like any lost connection.

import { Con_Printf, Con_DPrintf, SZ_Clear, SZ_Write } from './common.js';
import { NET_NewQSocket } from './net_main.js';
import { Sys_PageURL } from './sys.js';
import {
	net_message,
	net_driverlevel,
	NET_MAXMESSAGE,
	WT_PACKET_MAGIC,
	WT_PACKET_HEADER_BYTES,
	WT_PROTOCOL_VERSION,
	WT_HANDSHAKE_REJECT,
	WT_BuildHelloFrame,
	WT_ParseHandshakeReply,
	WS_CHANNEL_RELIABLE,
	WS_CHANNEL_UNRELIABLE,
	WS_CHANNEL_BYTES,
	WS_MAX_MESSAGE_BYTES
} from './net.js';
import { clc_disconnect } from './protocol.js';
import { M_ClearReturnOnError, M_ConnectionError, M_Menu_Main_f } from './menu.js';
import { set_key_dest, key_menu } from './keys.js';

let ws_initialized = false;

// WebSocket.readyState values (the constants are not on every stub)
const WS_OPEN = 1;

// Timeouts, as in net_webtransport.js. The connect deadline is shorter than
// CL_Connect's 30 s so a connect never completes after its caller gave up.
let WS_CONNECT_TIMEOUT_MS = 25000;
let WS_HANDSHAKE_TIMEOUT_MS = 10000;
let WS_CLOSE_FLUSH_MS = 1000;
const WS_LOBBY_TIMEOUT_MS = 10000;

// Inbound queue. WebSocket has no way to pause reading, so a client that stops
// running frames (a hidden tab) can only coalesce unreliable messages; past
// this many queued reliable messages the connection is dropped.
const WS_MAX_PENDING_MESSAGES = 4096;

// Outbound backpressure, in bytes the browser has queued but not yet handed
// to TCP. Unreliable messages are dropped past the first limit (each drop
// still uses up a sequence number, so commands stored for prediction keep
// distinct sequences), WS_CanSendMessage reports false past the second, and
// past the third the socket is treated as dead.
const WS_MAX_UNRELIABLE_BUFFERED = 16 * 1024;
const WS_MAX_RELIABLE_BUFFERED = 256 * 1024;
const WS_HARD_BUFFERED = 1024 * 1024;

// Default lobby for the WebSocket transport, used without ?server=. A page on
// localhost talks to a local `deno task lobby` (plain ws://, see
// server/README.md); any other page expects the lobby behind the same host at
// /mp, as with a Cloudflare Tunnel ingress rule.
const WS_DEFAULT_LOCAL_LOBBY = 'ws://127.0.0.1:4433';
const WS_DEFAULT_LOBBY_PATH = '/mp';

// Lobby message types (must match server/lobby_server.js)
const LOBBY_LIST = 0x01;
const LOBBY_JOIN = 0x02;
const LOBBY_CREATE = 0x03;
const LOBBY_ROOMS = 0x81;
const LOBBY_ERROR = 0x82;

// Active connections
const ws_connections = new Map(); // qsocket_t -> WebSocketConnection

// Closed connections whose close has not finished, and the WS_Connect calls
// waiting for them (see _WS_WaitForClosingConnections)
const ws_closing = new Set();
let ws_closeWaiters = [];

// Outgoing message scratch: [channel:1][header:9][payload]. WebSocket.send
// copies the bytes before it returns, so one buffer serves every send.
const ws_sendbuf = new Uint8Array( WS_CHANNEL_BYTES + WT_PACKET_HEADER_BYTES + NET_MAXMESSAGE );
const ws_sendview = new DataView( ws_sendbuf.buffer );

class WebSocketConnection {

	constructor( socket ) {

		this.socket = socket;

		this.pendingMessages = []; // { reliable: boolean, data: Uint8Array }
		this.connected = false;
		this.error = null;
		this.sock = null;

		// Graceful close
		this.closing = false;
		this.closeFinished = false;
		this.closeTimer = null;

		// Sequencing state, as in net_webtransport.js
		this.peerSequenced = false;
		this.reliableSequenceValid = false;
		this.unreliableSequenceValid = false;
		this.hasReceivedSequence = false;
		this.highestReceivedSequence = - 1;

		this.oversizedLogged = false;

	}

}

function _isNewerSequence( sequence, current ) {

	return ( ( sequence - current ) | 0 ) > 0;

}

/*
=============
URL helpers

The WebTransport URLs this port has always used (https://, wts://, wt://,
or a bare host:port) become WebSocket URLs with the same host, port, path and
query: https/wts/wt and no scheme give wss://, http gives ws://.
=============
*/
export function WS_IsWebSocketURL( url ) {

	return typeof url === 'string' && /^wss?:\/\//i.test( url );

}

export function WS_ToWebSocketURL( url ) {

	if ( WS_IsWebSocketURL( url ) ) return url;
	if ( /^http:\/\//i.test( url ) ) return 'ws://' + url.substring( 7 );
	if ( /^https:\/\//i.test( url ) ) return 'wss://' + url.substring( 8 );
	if ( /^wts:\/\//i.test( url ) ) return 'wss://' + url.substring( 6 );
	if ( /^wt:\/\//i.test( url ) ) return 'wss://' + url.substring( 5 );
	if ( url.includes( '://' ) === false ) return 'wss://' + url;
	return url;

}

/*
=============
WS_ServerBase

The lobby's base URL: scheme, host, port and path, without query, fragment
or trailing slash. The lobby is at <base>/lobby and room <id> at
<base>/room/<id>.
=============
*/
export function WS_ServerBase( serverUrl ) {

	const url = new URL( WS_ToWebSocketURL( serverUrl ) );
	url.search = '';
	url.hash = '';
	return url.toString().replace( /\/+$/, '' );

}

export function WS_LobbyURL( serverUrl ) {

	return WS_ServerBase( serverUrl ) + '/lobby';

}

export function WS_RoomURL( serverUrl, roomId ) {

	return WS_ServerBase( serverUrl ) + '/room/' + encodeURIComponent( roomId );

}

/*
=============
WS_DefaultServer

The lobby to use when the page has no ?server=: see WS_DEFAULT_LOBBY_PATH.
=============
*/
export function WS_DefaultServer() {

	const loc = globalThis.location;
	if ( loc == null || typeof loc.hostname !== 'string' || loc.hostname.length === 0 )
		return WS_DEFAULT_LOCAL_LOBBY;

	const host = loc.hostname.toLowerCase();
	if ( host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1' )
		return WS_DEFAULT_LOCAL_LOBBY;

	return ( loc.protocol === 'https:' ? 'wss://' : 'ws://' ) + loc.host + WS_DEFAULT_LOBBY_PATH;

}

/*
=============
WS_SetTimeouts

Shorten the connect, handshake and close-flush timeouts (tests use this).
Values that are not positive numbers leave the current setting.
=============
*/
export function WS_SetTimeouts( { connectMs, handshakeMs, closeFlushMs } = {} ) {

	if ( connectMs > 0 ) WS_CONNECT_TIMEOUT_MS = connectMs;
	if ( handshakeMs > 0 ) WS_HANDSHAKE_TIMEOUT_MS = handshakeMs;
	if ( closeFlushMs > 0 ) WS_CLOSE_FLUSH_MS = closeFlushMs;

}

/*
=============
WS_Init
=============
*/
export function WS_Init() {

	if ( typeof WebSocket === 'undefined' ) {

		Con_Printf( 'WebSocket not available in this browser\n' );
		return - 1;

	}

	if ( ws_initialized === false && typeof window !== 'undefined' ) {

		// Send a clean disconnect when the page unloads (browser only)
		window.addEventListener( 'pagehide', _onPageHide );
		window.addEventListener( 'beforeunload', _onPageHide );

	}

	ws_initialized = true;
	Con_Printf( 'WebSocket driver initialized\n' );

	return 0;

}

// Reused for the page-hide clc_disconnect
const _pageHideMessage = { data: new Uint8Array( [ clc_disconnect ] ), cursize: 1 };

function _onPageHide() {

	for ( const [ sock, conn ] of ws_connections ) {

		try {

			if ( conn.connected === true )
				WS_QSendMessage( sock, _pageHideMessage );

			// The page is going away: close now. WebSocket sends the close
			// frame after the messages already queued.
			_WS_CloseConnection( conn );
			_WS_FinishClose( conn );

		} catch {

			// Ignore errors during shutdown

		}

	}

	ws_connections.clear();

}

/*
=============
WS_Shutdown
=============
*/
export function WS_Shutdown() {

	for ( const conn of ws_connections.values() ) {

		try {

			_WS_CloseConnection( conn );

		} catch {

			// Ignore errors during shutdown

		}

	}

	ws_connections.clear();
	ws_initialized = false;

}

/*
=============
WS_Listen

Browser clients don't listen for connections
=============
*/
export function WS_Listen( _state ) {

}

/*
=============
WS_SearchForHosts

No broadcast discovery: the menu asks the lobby (WS_QueryRooms)
=============
*/
export function WS_SearchForHosts( _xmit ) {

}

/*
=============
WS_CheckNewConnections

Browser clients don't accept connections
=============
*/
export function WS_CheckNewConnections() {

	return null;

}

/*
=============
WS_GetAnyMessage
=============
*/
export function WS_GetAnyMessage() {

	return 0;

}

/*
=============
Socket helpers

Every socket is opened with binaryType 'arraybuffer': the default 'blob'
would make each message an asynchronous read.
=============
*/
function _WS_OpenSocket( url, attempt ) {

	const socket = new WebSocket( url );
	socket.binaryType = 'arraybuffer';
	if ( attempt !== null ) attempt.sockets.add( socket );
	return socket;

}

function _WS_CloseSocket( socket, attempt ) {

	if ( attempt !== null ) attempt.sockets.delete( socket );
	socket.onopen = null;
	socket.onmessage = null;
	socket.onerror = null;
	socket.onclose = null;
	try { socket.close(); } catch { /* ignore */ }

}

// Resolves when the socket opens; rejects if it closes or errors first.
function _WS_WaitOpen( socket ) {

	return new Promise( ( resolve, reject ) => {

		socket.onopen = () => resolve();
		socket.onerror = () => reject( new Error( 'WebSocket error' ) );
		socket.onclose = ( event ) => reject( new Error( 'WebSocket closed' +
			( event != null && typeof event.reason === 'string' && event.reason.length > 0 ? ': ' + event.reason : '' ) ) );

	} );

}

// Resolves to the next message as a Uint8Array, or null if the socket closes
// first. A text message is a protocol error.
function _WS_NextMessage( socket ) {

	return new Promise( ( resolve, reject ) => {

		socket.onmessage = ( event ) => {

			socket.onmessage = null;
			if ( ! ( event.data instanceof ArrayBuffer ) ) {

				reject( new Error( 'unexpected text message from server' ) );
				return;

			}

			resolve( new Uint8Array( event.data ) );

		};
		socket.onerror = () => resolve( null );
		socket.onclose = () => resolve( null );

	} );

}

// Resolves to timeoutValue if promise has not settled within timeoutMs.
function _WS_WithTimeout( promise, timeoutMs, timeoutValue ) {

	let timer = null;
	const timeout = new Promise( ( resolve ) => {

		timer = setTimeout( () => resolve( timeoutValue ), timeoutMs );

	} );

	promise.catch( () => {} );
	return Promise.race( [ promise, timeout ] ).finally( () => clearTimeout( timer ) );

}

/*
=============
WSConnectAttempt

One whole connect, lobby join included, as WTConnectAttempt in
net_webtransport.js: its deadline closes every socket it opened and rejects
whatever the connect is waiting on.
=============
*/
class WSConnectAttempt {

	constructor( timeoutMs ) {

		this.aborted = false;
		this.sockets = new Set();
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

		for ( const socket of this.sockets ) {

			try { socket.close(); } catch { /* ignore */ }

		}

		this.sockets.clear();
		this._reject( error );

	}

	wait( promise ) {

		if ( promise != null && typeof promise.catch === 'function' )
			promise.catch( () => {} );

		return Promise.race( [ promise, this.abortPromise ] );

	}

	finish() {

		if ( this._timer !== null ) {

			clearTimeout( this._timer );
			this._timer = null;

		}

	}

}

/*
=============
Lobby requests

One request per socket to <base>/lobby, in the lobby's framed format
[type:1][length:2][data], one frame per WebSocket message each way.
=============
*/
function _WS_EncodeLobbyFrame( type, data ) {

	const frame = new Uint8Array( 3 + data.length );
	frame[ 0 ] = type;
	frame[ 1 ] = data.length & 0xff;
	frame[ 2 ] = ( data.length >> 8 ) & 0xff;
	frame.set( data, 3 );
	return frame;

}

async function _WS_LobbyRequest( serverUrl, type, data, attempt ) {

	const socket = _WS_OpenSocket( WS_LobbyURL( serverUrl ), attempt );
	const guard = ( promise ) => attempt !== null ? attempt.wait( promise ) : promise;

	try {

		const opened = await guard( _WS_WithTimeout( _WS_WaitOpen( socket ).then( () => true ), WS_LOBBY_TIMEOUT_MS, false ) );
		if ( opened === false ) throw new Error( 'Lobby connection timed out' );

		const reply = _WS_NextMessage( socket );
		socket.send( _WS_EncodeLobbyFrame( type, data ) );
		const message = await guard( _WS_WithTimeout( reply, WS_LOBBY_TIMEOUT_MS, undefined ) );
		if ( message === undefined ) throw new Error( 'Lobby request timed out' );
		if ( message === null ) throw new Error( 'Connection closed' );
		if ( message.length < 3 ) throw new Error( 'Invalid lobby reply' );

		const length = message[ 1 ] | ( message[ 2 ] << 8 );
		if ( message.length !== 3 + length ) throw new Error( 'Invalid lobby reply' );

		return { type: message[ 0 ], data: message.subarray( 3 ) };

	} finally {

		_WS_CloseSocket( socket, attempt );

	}

}

function _WS_LobbyErrorText( data ) {

	const text = new TextDecoder().decode( data ).trim();
	return text.length > 0 ? text : 'Lobby request failed';

}

/*
=============
WS_QueryRooms

Room list from the lobby. Resolves to an array of room objects.
=============
*/
export async function WS_QueryRooms( serverUrl ) {

	if ( ws_initialized === false ) throw new Error( 'WebSocket not initialized' );

	Con_DPrintf( 'Querying rooms from ' + WS_LobbyURL( serverUrl ) + '\n' );

	try {

		const reply = await _WS_LobbyRequest( serverUrl, LOBBY_LIST, new Uint8Array( 0 ), null );
		if ( reply.type === LOBBY_ERROR ) throw new Error( _WS_LobbyErrorText( reply.data ) );
		if ( reply.type !== LOBBY_ROOMS ) throw new Error( 'Unexpected response type: ' + reply.type );

		let rooms;
		try {

			rooms = reply.data.length > 0 ? JSON.parse( new TextDecoder().decode( reply.data ) ) : [];

		} catch ( e ) {

			throw new Error( 'Failed to parse room list: ' + e.message );

		}

		if ( Array.isArray( rooms ) === false ) throw new Error( 'Invalid room list response' );

		Con_DPrintf( 'Got ' + rooms.length + ' rooms\n' );
		return rooms;

	} catch ( e ) {

		Con_Printf( 'WS_QueryRooms error: ' + e.message + '\n' );
		throw e;

	}

}

/*
=============
WS_CreateRoom

Ask the lobby for a new room. Resolves to the room object.
=============
*/
export async function WS_CreateRoom( serverUrl, config ) {

	if ( ws_initialized === false ) throw new Error( 'WebSocket not initialized' );

	Con_DPrintf( 'Creating room on ' + WS_LobbyURL( serverUrl ) + '\n' );

	try {

		const configData = new TextEncoder().encode( JSON.stringify( config ) );
		const reply = await _WS_LobbyRequest( serverUrl, LOBBY_CREATE, configData, null );
		if ( reply.type === LOBBY_ERROR ) throw new Error( _WS_LobbyErrorText( reply.data ) );
		if ( reply.type !== LOBBY_ROOMS ) throw new Error( 'Unexpected response type: ' + reply.type );
		if ( reply.data.length === 0 ) throw new Error( 'Server returned empty room response' );

		let room;
		try {

			room = JSON.parse( new TextDecoder().decode( reply.data ) );

		} catch ( e ) {

			throw new Error( 'Failed to parse room create response: ' + e.message );

		}

		if ( room === null || typeof room !== 'object' || typeof room.id !== 'string' || room.id.length === 0 )
			throw new Error( 'Invalid room response from server' );

		Con_Printf( 'Created room: ' + room.id + '\n' );
		return room;

	} catch ( e ) {

		Con_Printf( 'WS_CreateRoom error: ' + e.message + '\n' );
		throw e;

	}

}

/*
=============
Connect failure helpers, as in net_webtransport.js
=============
*/
function _WS_ClearRoomFromUrl() {

	// Clear room from URL so refresh doesn't retry; keep the transport choice
	if ( typeof history !== 'undefined' && typeof window !== 'undefined' )
		history.replaceState( null, '', Sys_PageURL( null ) );

}

function _WS_FailConnect( reason ) {

	_WS_ClearRoomFromUrl();
	set_key_dest( key_menu );
	M_ConnectionError( reason );
	return null;

}

function _WS_FailConnectToMainMenu() {

	_WS_ClearRoomFromUrl();
	M_Menu_Main_f();
	set_key_dest( key_menu );
	return null;

}

/*
=============
WS_Connect

Connect to a game server over WebSocket. host can be:
  - "wss://host/mp?room=ROOMID": ask the lobby at wss://host/mp for the room
    (it may re-create an expired room), then connect to wss://host/mp/room/ROOMID
  - "wss://host/mp/room/ROOMID": connect to the room through the lobby's proxy
  - "ws://127.0.0.1:4433": a standalone game server
Any WebTransport-style URL is converted first (WS_ToWebSocketURL).
=============
*/
export async function WS_Connect( host ) {

	if ( ws_initialized === false ) {

		Con_Printf( 'WebSocket not initialized\n' );
		return null;

	}

	// CL_EstablishConnection has just closed the previous connection.
	await _WS_WaitForClosingConnections();

	let url = WS_ToWebSocketURL( host );
	let roomId = null;

	try {

		const urlObj = new URL( url );
		roomId = urlObj.searchParams.get( 'room' );
		if ( roomId !== null && roomId.length === 0 ) roomId = null;
		if ( roomId !== null ) {

			urlObj.searchParams.delete( 'room' );
			url = urlObj.toString();

		}

	} catch {

		Con_Printf( 'WebSocket: bad address ' + host + '\n' );
		return _WS_FailConnectToMainMenu();

	}

	Con_Printf( 'WebSocket connecting to ' + url + ( roomId !== null ? ' (room: ' + roomId + ')' : '' ) + '\n' );

	const attempt = new WSConnectAttempt( WS_CONNECT_TIMEOUT_MS );

	try {

		if ( roomId === null )
			return await _WS_ConnectDirect( url, host, null, attempt );

		return await _WS_ConnectViaLobby( url, host, roomId, attempt );

	} finally {

		attempt.finish();

	}

}

/*
=============
_WS_ConnectViaLobby

Ask the lobby for roomId, then connect to the room's proxy path.
=============
*/
async function _WS_ConnectViaLobby( url, host, roomId, attempt ) {

	let reply;

	try {

		Con_Printf( 'Sending LOBBY_JOIN for room: ' + roomId + '\n' );
		reply = await _WS_LobbyRequest( url, LOBBY_JOIN, new TextEncoder().encode( roomId ), attempt );

	} catch ( error ) {

		if ( attempt.aborted === true || error.message === 'Lobby request timed out' || error.message === 'Lobby connection timed out' ) {

			Con_Printf( 'WebSocket connect timed out\n' );
			return _WS_FailConnect( 'Connection timed out - server may be offline' );

		}

		Con_Printf( 'WebSocket lobby join failed: ' + error.message + '\n' );
		return _WS_FailConnectToMainMenu();

	}

	if ( reply.type === LOBBY_ERROR ) {

		const errMsg = _WS_LobbyErrorText( reply.data );
		Con_Printf( 'Join failed: ' + errMsg + '\n' );
		return _WS_FailConnect( errMsg );

	}

	let room = null;
	if ( reply.type === LOBBY_ROOMS && reply.data.length > 0 ) {

		try {

			room = JSON.parse( new TextDecoder().decode( reply.data ) );

		} catch ( e ) {

			Con_Printf( 'Failed to parse room reply: ' + e.message + '\n' );

		}

	}

	if ( room === null || typeof room !== 'object' || typeof room.id !== 'string' || room.id.length === 0 ) {

		Con_Printf( 'Lobby reply had no room\n' );
		return _WS_FailConnect( 'Server sent an invalid room reply' );

	}

	// The lobby's reply carries the room's port, which only WebTransport uses:
	// a WebSocket client reaches the room through the lobby's /room/<id> path.
	Con_Printf( 'Joining room ' + room.id + ' through the lobby\n' );
	return await _WS_ConnectDirect( WS_RoomURL( url, room.id ), host, roomId, attempt );

}

/*
=============
_WS_ConnectDirect

Open the game socket, send the hello and wait for the server's reply.
=============
*/
async function _WS_ConnectDirect( url, originalHost, roomId, attempt ) {

	Con_Printf( 'WebSocket connecting directly to ' + url + '\n' );

	let socket = null;

	try {

		socket = _WS_OpenSocket( url, attempt );
		await attempt.wait( _WS_WaitOpen( socket ) );

		Con_Printf( 'WebSocket connection established\n' );

		// Connect handshake: the server assigns a client slot or says why not
		const replyPromise = _WS_NextMessage( socket );
		socket.send( WT_BuildHelloFrame().subarray( 2 ) );
		const payload = await attempt.wait( _WS_WithTimeout( replyPromise, WS_HANDSHAKE_TIMEOUT_MS, undefined ) );

		if ( payload === undefined )
			throw new Error( 'no handshake reply from server' );
		if ( payload === null )
			throw new Error( 'server closed the connection during the handshake' );

		const reply = WT_ParseHandshakeReply( payload );
		if ( reply === null )
			throw new Error( 'invalid handshake reply (server may be running an older version)' );

		if ( reply.version !== WT_PROTOCOL_VERSION )
			Con_DPrintf( 'Server protocol version ' + reply.version + ', client ' + WT_PROTOCOL_VERSION + '\n' );

		if ( reply.status === WT_HANDSHAKE_REJECT ) {

			const reason = reply.reason.length > 0 ? reply.reason : 'Connection refused';
			Con_Printf( 'Server refused connection: ' + reason + '\n' );
			_WS_CloseSocket( socket, attempt );
			socket = null;
			return _WS_FailConnect( reason );

		}

		if ( attempt.aborted === true )
			throw new Error( 'Connection timed out' );

		// No await from here on: the socket is either handed to the caller or
		// never allocated, so a failed connect cannot leak it.
		const sock = NET_NewQSocket();
		if ( sock === null )
			throw new Error( 'no free sockets' );

		attempt.sockets.delete( socket );

		sock.address = originalHost;
		sock.driver = net_driverlevel;
		sock.sendSequence = 0;
		sock.receiveSequence = - 1;
		sock.unreliableReceiveSequence = - 1;
		sock.ackSequence = - 1;
		sock.hasAck = false;

		const conn = new WebSocketConnection( socket );
		conn.connected = true;
		conn.sock = sock;
		sock.driverdata = conn;
		ws_connections.set( sock, conn );

		socket.onopen = null;
		socket.onmessage = ( event ) => _WS_OnMessage( conn, event.data );
		socket.onerror = () => {

			if ( conn.closing !== true && conn.connected === true ) {

				Con_Printf( 'WebSocket connection error\n' );
				conn.error = new Error( 'WebSocket error' );

			}

		};
		// Per original Quake design: don't set sock.disconnected here. A
		// closed connection makes WS_QGetMessage return -1, which leads to
		// Host_Error -> CL_Disconnect -> NET_Close.
		socket.onclose = () => {

			if ( conn.closing !== true && conn.connected === true )
				Con_Printf( 'WebSocket connection closed\n' );
			conn.connected = false;
			_WS_FinishClose( conn );

		};

		// Update URL with room parameter for easy sharing
		if ( roomId !== null && typeof window !== 'undefined' )
			history.replaceState( null, '', Sys_PageURL( roomId ) );

		// Connected: a later failure no longer returns to the Join menu
		// (_Datagram_Connect clears m_return_onerror here), as in
		// net_webtransport.js.
		M_ClearReturnOnError();
		return sock;

	} catch ( error ) {

		if ( socket !== null )
			_WS_CloseSocket( socket, attempt );

		if ( attempt.aborted === true ) {

			Con_Printf( 'WebSocket connect timed out after %d seconds\n', WS_CONNECT_TIMEOUT_MS / 1000 );
			return _WS_FailConnect( 'Connection timed out - server may be offline' );

		}

		Con_Printf( 'WebSocket direct connect failed: ' + error.message + '\n' );
		return _WS_FailConnectToMainMenu();

	}

}

/*
=============
_WS_OnMessage

Queue one received message for WS_QGetMessage.
=============
*/
function _WS_OnMessage( conn, raw ) {

	if ( conn.connected !== true ) return;

	if ( ! ( raw instanceof ArrayBuffer ) || raw.byteLength < WS_CHANNEL_BYTES + 1 ) {

		_WS_ProtocolError( conn, 'malformed message from server' );
		return;

	}

	const bytes = new Uint8Array( raw );
	const channel = bytes[ 0 ];
	if ( channel !== WS_CHANNEL_RELIABLE && channel !== WS_CHANNEL_UNRELIABLE ) {

		_WS_ProtocolError( conn, 'unknown channel ' + channel + ' from server' );
		return;

	}

	if ( bytes.length > WS_MAX_MESSAGE_BYTES ) {

		if ( channel === WS_CHANNEL_UNRELIABLE ) {

			if ( conn.oversizedLogged !== true ) {

				conn.oversizedLogged = true;
				Con_Printf( 'Dropping oversized message from server (' + bytes.length + ' bytes)\n' );

			}
			return;

		}

		_WS_ProtocolError( conn, 'oversized reliable message (' + bytes.length + ' bytes)' );
		return;

	}

	const queue = conn.pendingMessages;
	const data = bytes.subarray( WS_CHANNEL_BYTES );

	// Only the newest of consecutive unreliable messages is ever delivered
	// (see WS_QGetMessage), so replace instead of growing the queue.
	if ( channel === WS_CHANNEL_UNRELIABLE && queue.length > 0 && queue[ queue.length - 1 ].reliable === false ) {

		queue[ queue.length - 1 ].data = data;
		return;

	}

	if ( queue.length >= WS_MAX_PENDING_MESSAGES ) {

		_WS_ProtocolError( conn, 'receive queue overflow' );
		return;

	}

	queue.push( { reliable: channel === WS_CHANNEL_RELIABLE, data } );

}

function _WS_ProtocolError( conn, reason ) {

	Con_Printf( 'WebSocket: ' + reason + ', disconnecting\n' );
	conn.connected = false;
	conn.error = new Error( reason );
	conn.pendingMessages.length = 0;

}

/*
=============
_WS_ParseSequencedPacket

Strip the sequencing header and update the socket's sequence and ack state,
as _WT_ParseSequencedPacket does. Returns null for a stale packet.
=============
*/
function _WS_ParseSequencedPacket( sock, conn, packet, reliable ) {

	if ( packet.length < WT_PACKET_HEADER_BYTES || packet[ 0 ] !== WT_PACKET_MAGIC )
		return packet;

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
WS_QGetMessage

Returns 0 = no message, 1 = reliable, 2 = unreliable, -1 = error
=============
*/
export function WS_QGetMessage( sock ) {

	const conn = sock.driverdata;
	if ( conn == null ) return - 1;

	if ( conn.connected !== true && conn.pendingMessages.length === 0 )
		return - 1;

	while ( conn.pendingMessages.length > 0 ) {

		let msg = conn.pendingMessages.shift();

		// For unreliable messages, skip to the most recent one before the
		// next reliable message: in original Quake, unreliable messages are
		// overwritten by newer ones.
		if ( msg.reliable === false ) {

			while ( conn.pendingMessages.length > 0 ) {

				const next = conn.pendingMessages[ 0 ];
				if ( next.reliable === true ) break;
				conn.pendingMessages.shift();
				msg = next;

			}

		}

		const payload = _WS_ParseSequencedPacket( sock, conn, msg.data, msg.reliable );
		if ( payload === null )
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

			_WS_ProtocolError( conn, 'oversized reliable message from server (' + payload.length + ' bytes)' );
			return - 1;

		}

		SZ_Clear( net_message );
		SZ_Write( net_message, payload, payload.length );

		sock.lastMessageTime = performance.now() / 1000;

		return msg.reliable === true ? 1 : 2;

	}

	if ( conn.connected === true )
		return 0;

	return - 1;

}

function _WS_BufferedAmount( conn ) {

	const amount = conn.socket.bufferedAmount;
	return typeof amount === 'number' ? amount : 0;

}

/*
=============
_WS_SendPacket

[channel][magic][sequence][ack][payload] from the send scratch buffer.
=============
*/
function _WS_SendPacket( sock, conn, channel, data ) {

	const length = data.cursize;
	const sequence = sock.sendSequence | 0;
	const acknowledged = conn.hasReceivedSequence === true ? conn.highestReceivedSequence | 0 : sock.receiveSequence | 0;

	ws_sendbuf[ 0 ] = channel;
	ws_sendbuf[ 1 ] = WT_PACKET_MAGIC;
	ws_sendview.setUint32( 2, sequence >>> 0, true );
	ws_sendview.setUint32( 6, acknowledged >>> 0, true );
	ws_sendbuf.set( data.data.subarray( 0, length ), WS_CHANNEL_BYTES + WT_PACKET_HEADER_BYTES );

	sock.sendSequence = ( sequence + 1 ) | 0;

	conn.socket.send( ws_sendbuf.subarray( 0, WS_CHANNEL_BYTES + WT_PACKET_HEADER_BYTES + length ) );

}

// Common checks before a send; returns false if the connection can't send.
function _WS_CheckSendable( conn ) {

	if ( conn.error !== null ) {

		conn.connected = false;
		return false;

	}

	if ( conn.socket.readyState !== WS_OPEN ) {

		conn.connected = false;
		return false;

	}

	if ( _WS_BufferedAmount( conn ) >= WS_HARD_BUFFERED ) {

		Con_Printf( 'WebSocket: send buffer stalled, disconnecting\n' );
		conn.connected = false;
		conn.error = new Error( 'send buffer stalled' );
		return false;

	}

	return true;

}

/*
=============
WS_QSendMessage

Send a reliable message. TCP handles ordering and retransmission.
=============
*/
export function WS_QSendMessage( sock, data ) {

	const conn = sock.driverdata;
	if ( conn == null || conn.connected !== true ) return - 1;
	if ( _WS_CheckSendable( conn ) === false ) return - 1;

	if ( data.cursize > NET_MAXMESSAGE ) {

		Con_Printf( 'WS_QSendMessage: message too large (' + data.cursize + ' bytes)\n' );
		return - 1;

	}

	try {

		_WS_SendPacket( sock, conn, WS_CHANNEL_RELIABLE, data );

	} catch ( error ) {

		Con_Printf( 'WS_QSendMessage error: ' + error.message + '\n' );
		conn.connected = false;
		conn.error = error;
		return - 1;

	}

	return 1;

}

/*
=============
WS_SendUnreliableMessage

Send an unreliable message on the same stream, or drop it while the socket is
backed up (see WS_MAX_UNRELIABLE_BUFFERED).
=============
*/
export function WS_SendUnreliableMessage( sock, data ) {

	const conn = sock.driverdata;
	if ( conn == null || conn.connected !== true ) {

		Con_DPrintf( 'WS_SendUnreliableMessage: no connection\n' );
		return - 1;

	}

	if ( _WS_CheckSendable( conn ) === false ) return - 1;

	if ( data.cursize > NET_MAXMESSAGE || _WS_BufferedAmount( conn ) >= WS_MAX_UNRELIABLE_BUFFERED ) {

		sock.sendSequence = ( sock.sendSequence + 1 ) | 0;
		return 1;

	}

	try {

		_WS_SendPacket( sock, conn, WS_CHANNEL_UNRELIABLE, data );

	} catch {

		// Unreliable: a failed send is a dropped message; the next reliable
		// send or the close event reports a dead socket.

	}

	return 1;

}

/*
=============
WS_CanSendMessage
=============
*/
export function WS_CanSendMessage( sock ) {

	const conn = sock.driverdata;
	if ( conn == null ) return false;

	return conn.connected === true && conn.socket.readyState === WS_OPEN &&
		_WS_BufferedAmount( conn ) < WS_MAX_RELIABLE_BUFFERED;

}

/*
=============
WS_CanSendUnreliableMessage

True while connected: a message that can't go out now is dropped by
WS_SendUnreliableMessage, which still uses up its sequence number.
=============
*/
export function WS_CanSendUnreliableMessage( sock ) {

	const conn = sock.driverdata;
	if ( conn == null ) return false;

	return conn.connected === true && conn.socket.readyState === WS_OPEN;

}

/*
=============
_WS_CloseConnection

Graceful close: stop delivering messages and give the server
WS_CLOSE_FLUSH_MS to act on the clc_disconnect already sent and close the
socket itself (its close is what _WS_WaitForClosingConnections waits for);
then close from this end.
=============
*/
function _WS_CloseConnection( conn ) {

	if ( conn.closing === true ) return;
	conn.closing = true;
	conn.connected = false;
	if ( conn.closeFinished !== true ) ws_closing.add( conn );

	if ( conn.error !== null || conn.socket.readyState !== WS_OPEN ) {

		_WS_FinishClose( conn );
		return;

	}

	conn.closeTimer = setTimeout( () => {

		conn.closeTimer = null;
		_WS_FinishClose( conn );

	}, WS_CLOSE_FLUSH_MS );

}

function _WS_FinishClose( conn ) {

	if ( conn.closeFinished === true ) return;
	conn.closeFinished = true;
	conn.connected = false;

	if ( conn.closeTimer !== null ) {

		clearTimeout( conn.closeTimer );
		conn.closeTimer = null;

	}

	const socket = conn.socket;
	socket.onopen = null;
	socket.onmessage = null;
	socket.onerror = null;
	socket.onclose = null;
	try { socket.close( 1000 ); } catch { /* ignore */ }

	if ( ws_closing.delete( conn ) === true ) _WS_WakeCloseWaiters();

}

/*
=============
_WS_WaitForClosingConnections

Resolves once every closing connection has finished. Deliberate deviation,
as _WT_WaitForClosingConnections in net_webtransport.js: the C server frees
the old slot of a reconnecting IP itself, which would also drop other
players behind the same NAT, so the client waits for the server instead.
=============
*/
function _WS_WaitForClosingConnections() {

	if ( ws_closing.size === 0 ) return Promise.resolve();
	return new Promise( ( resolve ) => {

		ws_closeWaiters.push( resolve );

	} );

}

function _WS_WakeCloseWaiters() {

	if ( ws_closing.size !== 0 ) return;
	const waiters = ws_closeWaiters;
	ws_closeWaiters = [];
	for ( const resolve of waiters ) resolve();

}

/*
=============
WS_Close

Close a connection. The socket is detached at once (NET_Close frees it
straight after); the close finishes in the background.
=============
*/
export function WS_Close( sock ) {

	const conn = sock.driverdata;
	if ( conn == null ) return;

	_WS_CloseConnection( conn );

	ws_connections.delete( sock );
	conn.sock = null;
	sock.driverdata = null;

}
