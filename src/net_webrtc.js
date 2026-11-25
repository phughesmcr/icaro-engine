// WebRTC network driver for browser-hosted rooms
// New module (no C counterpart): a player's tab hosts a listen server and
// other players join it peer to peer over RTCDataChannels. The design is
// docs/browser-hosted-rooms.md (added with the design PR, #195).
//
// One driver serves both roles:
//   - client: RTC_Connect( 'rtc:<ROOMCODE>' ) offers a peer connection to the
//     room's host and runs the usual ICARO hello on it.
//   - host: while listening, each offer from a joiner gets a peer connection;
//     a valid hello gets a qsocket, which RTC_CheckNewConnections hands to
//     SV_CheckForNewClients like any network client.
//
// Each peer connection carries two data channels, as WebTransport has a
// stream and datagrams:
//   'reliable'    ordered, reliable: the hello, its reply, and QSendMessage
//   'unreliable'  ordered: false, maxRetransmits: 0: SendUnreliableMessage
// The joiner creates both. One channel message is one packet, with no length
// prefix since SCTP keeps message boundaries: the hello and reply are the
// WebTransport handshake payloads without their length prefix (as in
// net_websocket.js), and every later message is
// [magic:u8][sequence:u32le][ack:u32le][quake payload] (see src/net.js).
//
// Signalling is injected, so this driver knows nothing of the lobby:
//   RTC_SetSignaller( {
//     send( to, kind, data ),   // kind: 'offer' | 'answer' | 'candidate'
//     iceServers()              // optional: RTCIceServer[] or a Promise of one
//   } )
//   RTC_HandleSignal( from, kind, data )  // every signal the lobby relays here
// A joiner addresses the host by room code, and the lobby presents the host's
// signals to the joiner with from = that room code. The host addresses each
// joiner by the id the lobby gives it. offer and answer data is
// { type, sdp }; candidate data is an RTCIceCandidateInit.
//
// Peers are untrusted: offers are ignored unless listening, handshaking peers
// are capped, a peer that sends no hello in time is dropped, and channel
// messages and queues are capped as in the server drivers.
//
// The host's own tab-close handling and the listen-server rules are not here
// (design, "Listen-server rules").

import { Con_Printf, Con_DPrintf, SZ_Clear, SZ_Write } from './common.js';
import { NET_NewQSocket, NET_FreeQSocket } from './net_main.js';
import {
	net_message,
	NET_MAXMESSAGE,
	WT_PACKET_MAGIC,
	WT_PACKET_HEADER_BYTES,
	WT_MAX_FRAME_PAYLOAD,
	WT_PROTOCOL_VERSION,
	WT_HANDSHAKE_ACCEPT,
	WT_HANDSHAKE_REJECT,
	WT_BuildHelloFrame,
	WT_ParseHello,
	WT_BuildHandshakeReplyFrame,
	WT_ParseHandshakeReply
} from './net.js';
import { clc_disconnect } from './protocol.js';
import { M_ClearReturnOnError, M_ConnectionError } from './menu.js';
import { set_key_dest, key_menu } from './keys.js';

let rtc_initialized = false;
let rtc_listening = false;

// This driver's index in net_drivers, set by NET_Init. A hello arrives in an
// event callback, when net_driverlevel is whatever the last driver loop left.
let rtc_driverlevel = - 1;

let rtc_signaller = null;

export const RTC_CHANNEL_RELIABLE = 'reliable';
export const RTC_CHANNEL_UNRELIABLE = 'unreliable';

// Timeouts, as in the WebSocket drivers. The connect deadline is shorter than
// CL_Connect's 30 s so a connect never completes after its caller gave up.
let RTC_CONNECT_TIMEOUT_MS = 25000;
let RTC_HANDSHAKE_TIMEOUT_MS = 10000;
let RTC_PENDING_ACCEPT_TIMEOUT_MS = 30000;
let RTC_CLOSE_FLUSH_MS = 1000;
const RTC_CLOSE_POLL_MS = 20;

// Host: peer connections that have offered but not yet sent a valid hello.
// Each offer costs a peer connection, so a flood of them is refused.
const RTC_MAX_HANDSHAKING = 8;

// Remote candidates accepted per peer connection, queued (before the remote
// description is set) or added. A real browser trickles a handful.
const RTC_MAX_CANDIDATES = 64;
const RTC_MAX_SDP_BYTES = 64 * 1024;
const RTC_MAX_CANDIDATE_BYTES = 1024;

// Inbound queue. A data channel can't be paused, so a peer that stops reading
// (a hidden tab) can only coalesce unreliable messages; past this many queued
// reliable messages the connection is dropped. Host and client values follow
// the WebSocket server and client drivers.
const RTC_MAX_PENDING_MESSAGES_HOST = 1024;
const RTC_MAX_PENDING_MESSAGES_CLIENT = 4096;

// Outbound backpressure, in bytes a channel has queued but not yet handed to
// SCTP. Unreliable messages are dropped past the first limit,
// RTC_CanSendMessage reports false past the second, and past the third the
// connection is treated as dead.
const RTC_MAX_UNRELIABLE_BUFFERED = 16 * 1024;
const RTC_MAX_RELIABLE_BUFFERED = 256 * 1024;
const RTC_HARD_BUFFERED = 1024 * 1024;

// Largest unreliable packet, header included. A data-channel message bigger
// than the path MTU (about 1,200 bytes of payload after DTLS and SCTP) is
// fragmented, and losing one fragment loses it all, so larger ones go on the
// reliable channel instead, as WebTransport does past its datagram limit.
const RTC_MAX_UNRELIABLE_BYTES = 1200;

// What the host tells SV_ClientDatagramSize a joiner can take: the largest
// payload that still fits RTC_MAX_UNRELIABLE_BYTES with its header.
// SV_ClientDatagramSize clamps it to MAX_DATAGRAM_ID (1024) at least.
const RTC_HOST_MAXDATAGRAM = RTC_MAX_UNRELIABLE_BYTES - WT_PACKET_HEADER_BYTES;

// Room codes the client accepts in rtc:<code>
const RTC_ROOM_CODE = /^[A-Za-z0-9_-]{1,32}$/;

// Host: every peer by the lobby's id for it (handshaking or connected)
const rtc_peers = new Map();
// Host: sockets that passed the hello, waiting for RTC_CheckNewConnections
const rtc_pending = [];
// Every connection that has a qsocket, both roles
const rtc_connections = new Map(); // qsocket_t -> RTCConnection
// Client: the connection being made or in use (one at a time)
let rtc_client = null;
let rtc_attempt = null;

// Closed client connections whose close has not finished, and the
// RTC_Connect calls waiting for them (see _RTC_WaitForClosingConnections)
const rtc_closing = new Set();
let rtc_closeWaiters = [];

let rtc_nextPeer = 1;

// Outgoing packet scratch: [header:9][payload]. RTCDataChannel.send copies an
// ArrayBufferView's bytes before it returns, so one buffer serves every send.
const rtc_sendbuf = new Uint8Array( WT_PACKET_HEADER_BYTES + NET_MAXMESSAGE );
const rtc_sendview = new DataView( rtc_sendbuf.buffer );

class RTCConnection {

	constructor( role, remoteId, address ) {

		this.role = role; // 'host' or 'client'
		this.remoteId = remoteId; // signalling id of the other end
		this.address = address;
		this.pc = null;
		this.reliable = null;
		this.unreliable = null;

		// Signalling
		this.remoteDescriptionSet = false;
		this.earlyCandidates = [];
		this.candidateCount = 0;

		// Handshake
		this.accepted = false; // hello and reply done
		this.answerWaiter = null; // client: waiting for the host's answer
		this.openWaiter = null; // client: waiting for the reliable channel
		this.replyResolve = null; // client: waiting for the handshake reply

		this.connected = false;
		this.error = null;
		this.sock = null;
		this.pendingMessages = []; // { reliable: boolean, data: Uint8Array }

		// Close
		this.closing = false;
		this.closeFinished = false;
		this.dead = false; // the transport is gone
		this.closeDeadline = 0;
		this.closeTimer = null;
		this.handshakeTimer = null;
		this.pendingAcceptTimer = null;

		// Sequencing state, as in net_websocket.js
		this.peerSequenced = false;
		this.reliableSequenceValid = false;
		this.unreliableSequenceValid = false;
		this.hasReceivedSequence = false;
		this.highestReceivedSequence = - 1;

		this.oversizedLogged = false;
		this.oversizedSendLogged = false;

	}

}

function _isNewerSequence( sequence, current ) {

	return ( ( sequence - current ) | 0 ) > 0;

}

/*
=============
Configuration
=============
*/
export function RTC_SetTimeouts( { connectMs, handshakeMs, pendingAcceptMs, closeFlushMs } = {} ) {

	if ( connectMs > 0 ) RTC_CONNECT_TIMEOUT_MS = connectMs;
	if ( handshakeMs > 0 ) RTC_HANDSHAKE_TIMEOUT_MS = handshakeMs;
	if ( pendingAcceptMs > 0 ) RTC_PENDING_ACCEPT_TIMEOUT_MS = pendingAcceptMs;
	if ( closeFlushMs > 0 ) RTC_CLOSE_FLUSH_MS = closeFlushMs;

}

export function RTC_SetDriverLevel( level ) {

	rtc_driverlevel = level;

}

export function RTC_SetSignaller( signaller ) {

	rtc_signaller = signaller !== null && signaller !== undefined ? signaller : null;

}

/*
=============
RTC_IsRoomAddress

True for an rtc:<code> address, which NET_Connect hands to this driver.
=============
*/
export function RTC_IsRoomAddress( host ) {

	return typeof host === 'string' && host.length > 4 && host.slice( 0, 4 ).toLowerCase() === 'rtc:';

}

/*
=============
RTC_Init
=============
*/
export function RTC_Init() {

	if ( typeof RTCPeerConnection === 'undefined' ) {

		Con_Printf( 'WebRTC not available in this browser\n' );
		return - 1;

	}

	if ( rtc_initialized === false && typeof window !== 'undefined' ) {

		// Send a clean disconnect when the page unloads (browser only)
		window.addEventListener( 'pagehide', _onPageHide );
		window.addEventListener( 'beforeunload', _onPageHide );

	}

	rtc_initialized = true;
	Con_Printf( 'WebRTC driver initialized\n' );

	return 0;

}

// Reused for the page-hide clc_disconnect
const _pageHideMessage = { data: new Uint8Array( [ clc_disconnect ] ), cursize: 1 };

// The client's connection only: closing the host's peers when its tab goes
// is part of the listen-server rules.
function _onPageHide() {

	const conn = rtc_client;
	if ( conn === null ) return;

	try {

		if ( conn.connected === true && conn.sock !== null )
			RTC_QSendMessage( conn.sock, _pageHideMessage );

		_RTC_FinishClose( conn );

	} catch {

		// Ignore errors during shutdown

	}

}

/*
=============
RTC_Shutdown
=============
*/
export function RTC_Shutdown() {

	if ( rtc_attempt !== null )
		rtc_attempt.abort( new Error( 'WebRTC shut down' ) );

	for ( const conn of rtc_peers.values() ) _RTC_FinishClose( conn );
	for ( const conn of rtc_connections.values() ) _RTC_FinishClose( conn );
	if ( rtc_client !== null ) _RTC_FinishClose( rtc_client );

	for ( const sock of rtc_pending ) {

		sock.driverdata = null;
		NET_FreeQSocket( sock );

	}

	rtc_pending.length = 0;
	rtc_peers.clear();
	rtc_connections.clear();
	rtc_client = null;
	rtc_listening = false;
	rtc_initialized = false;

}

/*
=============
RTC_Listen

Host: accept offers while listening. Stopping drops the peers that have not
been handed to the server yet; connected players stay.
=============
*/
export function RTC_Listen( state ) {

	rtc_listening = state === true;
	if ( rtc_listening === true ) return;

	for ( const conn of [ ...rtc_peers.values() ] ) {

		if ( conn.sock === null || rtc_pending.includes( conn.sock ) === true )
			_RTC_DropUnaccepted( conn );

	}

}

/*
=============
RTC_SearchForHosts

No broadcast discovery: rooms are listed by the lobby
=============
*/
export function RTC_SearchForHosts( _xmit ) {

}

/*
=============
RTC_GetStatsForTest
=============
*/
export function RTC_GetStatsForTest() {

	let handshaking = 0;
	for ( const conn of rtc_peers.values() ) {

		if ( conn.accepted === false ) handshaking ++;

	}

	return {
		peers: rtc_peers.size,
		handshaking,
		pending: rtc_pending.length,
		connections: rtc_connections.size,
		closing: rtc_closing.size,
		client: rtc_client !== null
	};

}

/*
=============
Signalling
=============
*/
function _RTC_Signal( to, kind, data ) {

	if ( rtc_signaller === null ) return;

	try {

		rtc_signaller.send( to, kind, data );

	} catch ( error ) {

		Con_DPrintf( 'WebRTC: signal to ' + to + ' failed: ' + error.message + '\n' );

	}

}

async function _RTC_IceServers() {

	if ( rtc_signaller === null || typeof rtc_signaller.iceServers !== 'function' )
		return [];

	try {

		const servers = await rtc_signaller.iceServers();
		return Array.isArray( servers ) ? servers : [];

	} catch {

		return [];

	}

}

function _RTC_ValidDescription( data, type ) {

	return data !== null && typeof data === 'object' && data.type === type &&
		typeof data.sdp === 'string' && data.sdp.length <= RTC_MAX_SDP_BYTES;

}

// A copy holding only the RTCIceCandidateInit fields, or null if malformed
function _RTC_ValidCandidate( data ) {

	if ( data === null || typeof data !== 'object' ) return null;
	if ( typeof data.candidate !== 'string' || data.candidate.length > RTC_MAX_CANDIDATE_BYTES ) return null;

	const sdpMid = typeof data.sdpMid === 'string' ? data.sdpMid : null;
	const sdpMLineIndex = Number.isInteger( data.sdpMLineIndex ) ? data.sdpMLineIndex : null;
	if ( sdpMid === null && sdpMLineIndex === null ) return null;

	return { candidate: data.candidate, sdpMid, sdpMLineIndex };

}

function _RTC_CandidateInit( candidate ) {

	if ( typeof candidate.toJSON === 'function' ) return candidate.toJSON();
	return {
		candidate: candidate.candidate,
		sdpMid: candidate.sdpMid,
		sdpMLineIndex: candidate.sdpMLineIndex
	};

}

/*
=============
RTC_HandleSignal

Every signal the lobby relays to this tab. Offers are for the host role;
answers, and candidates from the room code, are for the client's connection.
=============
*/
export function RTC_HandleSignal( from, kind, data ) {

	if ( rtc_initialized === false || typeof from !== 'string' ) return;

	if ( kind === 'offer' ) {

		_RTC_OnOffer( from, data );
		return;

	}

	const client = rtc_client;

	if ( kind === 'answer' ) {

		if ( client !== null && client.remoteId === from )
			_RTC_OnAnswer( client, data );
		return;

	}

	if ( kind === 'candidate' ) {

		const peer = rtc_peers.get( from );
		if ( peer !== undefined ) {

			_RTC_AddCandidate( peer, data );
			return;

		}

		if ( client !== null && client.remoteId === from )
			_RTC_AddCandidate( client, data );

	}

}

function _RTC_AddCandidate( conn, data ) {

	if ( conn.closing === true || conn.dead === true ) return;

	const candidate = _RTC_ValidCandidate( data );
	if ( candidate === null ) return;
	if ( conn.candidateCount >= RTC_MAX_CANDIDATES ) return;
	conn.candidateCount ++;

	if ( conn.remoteDescriptionSet !== true ) {

		// addIceCandidate before setRemoteDescription is an error
		conn.earlyCandidates.push( candidate );
		return;

	}

	conn.pc.addIceCandidate( candidate ).catch( () => {} );

}

function _RTC_FlushCandidates( conn ) {

	conn.remoteDescriptionSet = true;
	const candidates = conn.earlyCandidates;
	conn.earlyCandidates = [];
	for ( const candidate of candidates )
		conn.pc.addIceCandidate( candidate ).catch( () => {} );

}

/*
=============
Peer connection wiring, both roles
=============
*/
function _RTC_CreatePeerConnection( conn, iceServers ) {

	const pc = new RTCPeerConnection( { iceServers } );
	conn.pc = pc;

	pc.onicecandidate = ( event ) => {

		if ( event.candidate === null || event.candidate === undefined || conn.closing === true ) return;
		_RTC_Signal( conn.remoteId, 'candidate', _RTC_CandidateInit( event.candidate ) );

	};

	// 'disconnected' can recover by itself; only 'failed' and 'closed' end it
	pc.onconnectionstatechange = () => {

		const state = pc.connectionState;
		if ( state === 'failed' || state === 'closed' )
			_RTC_OnTransportClosed( conn );

	};

	return pc;

}

function _RTC_AttachChannel( conn, channel ) {

	channel.binaryType = 'arraybuffer';

	if ( channel.label === RTC_CHANNEL_RELIABLE ) {

		conn.reliable = channel;
		channel.onmessage = ( event ) => _RTC_OnReliable( conn, event.data );

	} else {

		conn.unreliable = channel;
		channel.onmessage = ( event ) => {

			if ( conn.accepted === true ) _RTC_OnMessage( conn, event.data, false );

		};

	}

	// Either channel closing ends the connection. A closed unreliable channel
	// can't be reopened, and the reliable one carries everything else.
	channel.onclose = () => _RTC_OnTransportClosed( conn );
	channel.onerror = () => {

		if ( conn.closing !== true && conn.connected === true ) {

			Con_Printf( 'WebRTC connection error\n' );
			conn.error = new Error( 'WebRTC data channel error' );

		}

	};

}

/*
=============
_RTC_OnOffer

Host: a joiner offers a peer connection. It gets RTC_HANDSHAKE_TIMEOUT_MS from
now to open the reliable channel and send a valid hello.
=============
*/
function _RTC_OnOffer( from, data ) {

	if ( rtc_listening !== true ) return;
	if ( _RTC_ValidDescription( data, 'offer' ) === false ) return;

	// A new offer from a lobby id we already have is that joiner starting
	// over (its old connection may not have failed here yet): the new one
	// replaces it. A socket the server holds reports the loss through
	// RTC_QGetMessage, as any other dropped connection.
	const old = rtc_peers.get( from );
	if ( old !== undefined ) {

		rtc_peers.delete( from );
		if ( old.sock !== null ) _RTC_ProtocolError( old, 'replaced by a new connection' );
		else _RTC_FinishClose( old );

	}

	let handshaking = 0;
	for ( const peer of rtc_peers.values() ) {

		if ( peer.accepted === false ) handshaking ++;

	}

	if ( handshaking >= RTC_MAX_HANDSHAKING ) {

		Con_DPrintf( 'WebRTC: too many joiners handshaking, ignoring an offer\n' );
		return;

	}

	const conn = new RTCConnection( 'host', from, 'rtc:peer' + ( rtc_nextPeer ++ ) );
	rtc_peers.set( from, conn );

	conn.handshakeTimer = setTimeout( () => {

		conn.handshakeTimer = null;
		if ( conn.accepted === true || conn.closing === true ) return;
		Con_Printf( 'WebRTC %s: handshake timed out\n', conn.address );
		_RTC_FinishClose( conn );

	}, RTC_HANDSHAKE_TIMEOUT_MS );

	_RTC_AnswerOffer( conn, data ).catch( ( error ) => {

		if ( conn.closing === true ) return;
		Con_Printf( 'WebRTC %s: could not answer: %s\n', conn.address, error.message );
		_RTC_FinishClose( conn );

	} );

}

async function _RTC_AnswerOffer( conn, offer ) {

	const iceServers = await _RTC_IceServers();
	if ( conn.closing === true ) return;

	const pc = _RTC_CreatePeerConnection( conn, iceServers );
	pc.ondatachannel = ( event ) => {

		const channel = event.channel;
		const label = channel.label;
		const taken = label === RTC_CHANNEL_RELIABLE ? conn.reliable : label === RTC_CHANNEL_UNRELIABLE ? conn.unreliable : undefined;
		if ( taken !== null ) {

			// Unknown label, or a second channel with the same one
			try { channel.close(); } catch { /* ignore */ }
			_RTC_ProtocolError( conn, 'unexpected data channel' );
			return;

		}

		_RTC_AttachChannel( conn, channel );

	};

	await pc.setRemoteDescription( { type: offer.type, sdp: offer.sdp } );
	if ( conn.closing === true ) return;
	_RTC_FlushCandidates( conn );

	const answer = await pc.createAnswer();
	if ( conn.closing === true ) return;
	await pc.setLocalDescription( answer );
	if ( conn.closing === true ) return;

	_RTC_Signal( conn.remoteId, 'answer', { type: answer.type, sdp: answer.sdp } );

}

/*
=============
_RTC_OnReliable

The first reliable message is the handshake: the hello on the host, the reply
on the client. Every later one is a game packet.
=============
*/
function _RTC_OnReliable( conn, raw ) {

	if ( conn.accepted === true ) {

		_RTC_OnMessage( conn, raw, true );
		return;

	}

	if ( conn.role === 'host' ) {

		_RTC_OnHello( conn, raw );
		return;

	}

	// Client: the reply. Mark the handshake done at once, so packets the host
	// sends straight after it queue before RTC_Connect resumes.
	const resolve = conn.replyResolve;
	if ( resolve === null ) return;
	conn.replyResolve = null;
	conn.accepted = true;
	resolve( raw instanceof ArrayBuffer ? new Uint8Array( raw ) : new Uint8Array( 0 ) );

}

function _RTC_SendHandshakeReply( conn, status, reason ) {

	try {

		conn.reliable.send( WT_BuildHandshakeReplyFrame( status, reason ).subarray( 2 ) );

	} catch {

		// The channel's close event reports a dead connection

	}

}

/*
=============
_RTC_OnHello

Host: reply with an accept and queue the socket for RTC_CheckNewConnections,
or with a reject and close. Ported from _onHello in
server/net_websocket_server.ts.
=============
*/
function _RTC_OnHello( conn, raw ) {

	if ( conn.closing === true ) return;

	if ( conn.handshakeTimer !== null ) {

		clearTimeout( conn.handshakeTimer );
		conn.handshakeTimer = null;

	}

	const version = raw instanceof ArrayBuffer ? WT_ParseHello( new Uint8Array( raw ) ) : - 1;
	if ( version !== WT_PROTOCOL_VERSION ) {

		Con_Printf( 'Rejecting %s: %s\n', conn.address, version < 0 ? 'no handshake' : 'protocol version ' + version );
		_RTC_Reject( conn, version < 0
			? 'Protocol mismatch: update your client'
			: 'Protocol version ' + version + ' not supported (server uses ' + WT_PROTOCOL_VERSION + ')' );
		return;

	}

	// Count the sockets still waiting to be accepted, so offers in one frame
	// can't claim more sockets than there are free client slots
	const sock = NET_NewQSocket( rtc_pending.length );
	if ( sock === null ) {

		Con_Printf( 'No free client slots for %s\n', conn.address );
		_RTC_Reject( conn, 'Server is full' );
		return;

	}

	conn.accepted = true;
	conn.connected = true;

	const now = performance.now() / 1000;
	sock.driver = rtc_driverlevel;
	sock.address = conn.address;
	sock.driverdata = conn;
	sock.connecttime = now;
	sock.lastMessageTime = now;
	sock.sendSequence = 0;
	sock.receiveSequence = - 1;
	sock.unreliableReceiveSequence = - 1;
	sock.ackSequence = - 1;
	sock.hasAck = false;
	sock.maxdatagram = RTC_HOST_MAXDATAGRAM;
	conn.sock = sock;

	_RTC_SendHandshakeReply( conn, WT_HANDSHAKE_ACCEPT, '' );

	rtc_pending.push( sock );
	conn.pendingAcceptTimer = setTimeout( () => {

		conn.pendingAcceptTimer = null;
		if ( rtc_pending.includes( sock ) === false || sock.driverdata !== conn ) return;
		Con_Printf( 'Connection %s was never accepted, closing\n', conn.address );
		_RTC_DropUnaccepted( conn );

	}, RTC_PENDING_ACCEPT_TIMEOUT_MS );

	Con_Printf( 'Connection from %s\n', conn.address );

}

function _RTC_Reject( conn, reason ) {

	_RTC_SendHandshakeReply( conn, WT_HANDSHAKE_REJECT, reason );
	_RTC_CloseConnection( conn );

}

/*
=============
_RTC_DropUnaccepted

Host: close a peer the server never took, freeing its socket if it has one.
=============
*/
function _RTC_DropUnaccepted( conn ) {

	const sock = conn.sock;
	if ( sock !== null ) {

		const idx = rtc_pending.indexOf( sock );
		if ( idx !== - 1 ) rtc_pending.splice( idx, 1 );
		sock.driverdata = null;
		conn.sock = null;
		NET_FreeQSocket( sock );

	}

	_RTC_CloseConnection( conn );

}

/*
=============
RTC_CheckNewConnections
=============
*/
export function RTC_CheckNewConnections() {

	while ( rtc_pending.length > 0 ) {

		const sock = rtc_pending.shift();
		const conn = sock.driverdata;
		if ( sock.disconnected === true ) continue;

		if ( conn === null || conn.connected !== true ) {

			Con_Printf( 'Skipped disconnected socket in pending queue\n' );
			sock.driverdata = null;
			if ( conn !== null ) {

				conn.sock = null;
				_RTC_CloseConnection( conn );

			}

			NET_FreeQSocket( sock );
			continue;

		}

		if ( conn.pendingAcceptTimer !== null ) {

			clearTimeout( conn.pendingAcceptTimer );
			conn.pendingAcceptTimer = null;

		}

		rtc_connections.set( sock, conn );
		return sock;

	}

	return null;

}

/*
=============
Connect attempt

One whole connect: its deadline closes the peer connection and rejects
whatever the connect is waiting on, as WSConnectAttempt does.
=============
*/
class RTCConnectAttempt {

	constructor( timeoutMs ) {

		this.aborted = false;
		this.conn = null;
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
		this._reject( error );

	}

	wait( promise ) {

		if ( promise !== null && promise !== undefined && typeof promise.catch === 'function' )
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

function _RTC_WithTimeout( promise, timeoutMs, timeoutValue ) {

	let timer = null;
	const timeout = new Promise( ( resolve ) => {

		timer = setTimeout( () => resolve( timeoutValue ), timeoutMs );

	} );

	promise.catch( () => {} );
	return Promise.race( [ promise, timeout ] ).finally( () => clearTimeout( timer ) );

}

// Client: resolves when the reliable channel opens; _RTC_FinishClose rejects
function _RTC_WaitOpen( conn ) {

	const channel = conn.reliable;
	if ( channel.readyState === 'open' ) return Promise.resolve();

	return new Promise( ( resolve, reject ) => {

		conn.openWaiter = { resolve, reject };
		channel.onopen = () => {

			channel.onopen = null;
			conn.openWaiter = null;
			resolve();

		};

	} );

}

function _RTC_FailConnect( reason ) {

	set_key_dest( key_menu );
	M_ConnectionError( reason );
	return null;

}

/*
=============
RTC_Connect

Join a browser-hosted room: host is "rtc:<ROOMCODE>".
=============
*/
export async function RTC_Connect( host ) {

	if ( rtc_initialized === false ) {

		Con_Printf( 'WebRTC not initialized\n' );
		return null;

	}

	const code = RTC_IsRoomAddress( host ) ? host.slice( 4 ) : '';
	if ( RTC_ROOM_CODE.test( code ) === false ) {

		Con_Printf( 'WebRTC: bad room address ' + host + '\n' );
		return _RTC_FailConnect( 'Bad room address' );

	}

	if ( rtc_signaller === null ) {

		Con_Printf( 'WebRTC: no lobby to reach room ' + code + '\n' );
		return _RTC_FailConnect( 'Not connected to the lobby' );

	}

	// CL_EstablishConnection has just closed the previous connection.
	await _RTC_WaitForClosingConnections();

	if ( rtc_attempt !== null ) rtc_attempt.abort( new Error( 'superseded by a new connect' ) );

	Con_Printf( 'WebRTC connecting to room ' + code + '\n' );

	const attempt = new RTCConnectAttempt( RTC_CONNECT_TIMEOUT_MS );
	rtc_attempt = attempt;

	try {

		return await _RTC_ConnectAttempt( attempt, code, host );

	} finally {

		attempt.finish();
		if ( rtc_attempt === attempt ) rtc_attempt = null;

	}

}

async function _RTC_ConnectAttempt( attempt, code, host ) {

	const conn = new RTCConnection( 'client', code, host );
	attempt.conn = conn;

	try {

		const iceServers = await attempt.wait( _RTC_IceServers() );

		if ( rtc_client !== null ) _RTC_FinishClose( rtc_client );
		rtc_client = conn;

		const pc = _RTC_CreatePeerConnection( conn, iceServers );
		_RTC_AttachChannel( conn, pc.createDataChannel( RTC_CHANNEL_RELIABLE, { ordered: true } ) );
		_RTC_AttachChannel( conn, pc.createDataChannel( RTC_CHANNEL_UNRELIABLE, { ordered: false, maxRetransmits: 0 } ) );

		const offer = await attempt.wait( pc.createOffer() );
		await attempt.wait( pc.setLocalDescription( offer ) );
		const answered = new Promise( ( resolve, reject ) => {

			conn.answerWaiter = { resolve, reject, received: false };

		} );
		_RTC_Signal( code, 'offer', { type: offer.type, sdp: offer.sdp } );

		await attempt.wait( answered );
		await attempt.wait( _RTC_WaitOpen( conn ) );

		Con_Printf( 'WebRTC connection established\n' );

		// Connect handshake: the host assigns a client slot or says why not
		const replyPromise = new Promise( ( resolve ) => {

			conn.replyResolve = resolve;

		} );
		conn.reliable.send( WT_BuildHelloFrame().subarray( 2 ) );
		const payload = await attempt.wait( _RTC_WithTimeout( replyPromise, RTC_HANDSHAKE_TIMEOUT_MS, null ) );

		if ( payload === null )
			throw new Error( 'no handshake reply from host' );

		const reply = WT_ParseHandshakeReply( payload );
		if ( reply === null )
			throw new Error( 'invalid handshake reply' );

		if ( reply.version !== WT_PROTOCOL_VERSION )
			Con_DPrintf( 'Host protocol version ' + reply.version + ', client ' + WT_PROTOCOL_VERSION + '\n' );

		if ( reply.status === WT_HANDSHAKE_REJECT ) {

			const reason = reply.reason.length > 0 ? reply.reason : 'Connection refused';
			Con_Printf( 'Host refused connection: ' + reason + '\n' );
			_RTC_FinishClose( conn );
			return _RTC_FailConnect( reason );

		}

		if ( attempt.aborted === true || conn.dead === true )
			throw new Error( 'connection lost during the handshake' );

		// No await from here on: the socket is either handed to the caller or
		// never allocated, so a failed connect cannot leak it.
		const sock = NET_NewQSocket();
		if ( sock === null )
			throw new Error( 'no free sockets' );

		sock.address = host;
		sock.driver = rtc_driverlevel;
		sock.sendSequence = 0;
		sock.receiveSequence = - 1;
		sock.unreliableReceiveSequence = - 1;
		sock.ackSequence = - 1;
		sock.hasAck = false;

		conn.accepted = true;
		conn.connected = true;
		conn.sock = sock;
		sock.driverdata = conn;
		rtc_connections.set( sock, conn );

		// Connected: a later failure no longer returns to the Join menu
		M_ClearReturnOnError();
		return sock;

	} catch ( error ) {

		_RTC_FinishClose( conn );

		// A newer RTC_Connect took over; its own result is what the menu shows
		if ( rtc_attempt !== attempt && attempt.aborted === true ) {

			Con_DPrintf( 'WebRTC connect to ' + code + ' superseded\n' );
			return null;

		}

		if ( attempt.aborted === true && error.message === 'Connection timed out' ) {

			Con_Printf( 'WebRTC connect timed out after %d seconds\n', RTC_CONNECT_TIMEOUT_MS / 1000 );
			return _RTC_FailConnect( 'Connection timed out - the host may have left' );

		}

		Con_Printf( 'WebRTC connect failed: ' + error.message + '\n' );
		return _RTC_FailConnect( 'Could not connect to the room' );

	}

}

function _RTC_OnAnswer( conn, data ) {

	const waiter = conn.answerWaiter;
	if ( waiter === null || waiter.received === true || conn.closing === true ) return;
	if ( _RTC_ValidDescription( data, 'answer' ) === false ) return;
	waiter.received = true;

	conn.pc.setRemoteDescription( { type: data.type, sdp: data.sdp } ).then( () => {

		if ( conn.closing === true ) return;
		conn.answerWaiter = null;
		_RTC_FlushCandidates( conn );
		waiter.resolve();

	}, ( error ) => {

		Con_Printf( 'WebRTC: bad answer from host: ' + error.message + '\n' );
		_RTC_OnTransportClosed( conn );

	} );

}

/*
=============
_RTC_OnMessage

Queue one received game packet for RTC_QGetMessage.
=============
*/
function _RTC_OnMessage( conn, raw, reliable ) {

	if ( conn.connected !== true && conn.accepted !== true ) return;
	if ( conn.closing === true || conn.dead === true || conn.error !== null ) return;

	if ( ! ( raw instanceof ArrayBuffer ) || raw.byteLength < 1 ) {

		_RTC_ProtocolError( conn, 'malformed message' );
		return;

	}

	if ( raw.byteLength > WT_MAX_FRAME_PAYLOAD ) {

		if ( reliable === false ) {

			if ( conn.oversizedLogged !== true ) {

				conn.oversizedLogged = true;
				Con_Printf( 'Dropping oversized message from %s (%d bytes)\n', conn.address, raw.byteLength );

			}
			return;

		}

		_RTC_ProtocolError( conn, 'oversized reliable message (' + raw.byteLength + ' bytes)' );
		return;

	}

	const queue = conn.pendingMessages;
	const data = new Uint8Array( raw );

	// Only the newest of consecutive unreliable messages is ever delivered
	// (see RTC_QGetMessage), so replace instead of growing the queue.
	if ( reliable === false && queue.length > 0 && queue[ queue.length - 1 ].reliable === false ) {

		queue[ queue.length - 1 ].data = data;
		return;

	}

	const limit = conn.role === 'host' ? RTC_MAX_PENDING_MESSAGES_HOST : RTC_MAX_PENDING_MESSAGES_CLIENT;
	if ( queue.length >= limit ) {

		_RTC_ProtocolError( conn, 'receive queue overflow' );
		return;

	}

	queue.push( { reliable, data } );

}

function _RTC_ProtocolError( conn, reason ) {

	Con_Printf( 'WebRTC %s: %s, disconnecting\n', conn.address, reason );
	conn.connected = false;
	conn.error = new Error( reason );
	conn.pendingMessages.length = 0;

	// A peer that never got a socket has nothing to report to
	if ( conn.sock === null ) _RTC_FinishClose( conn );

}

/*
=============
_RTC_OnTransportClosed

A channel closed or the peer connection failed. A socket the server or
client is using is left for RTC_QGetMessage to report: it delivers what is
queued, then -1 (leading to SV_DropClient or Host_Error, then NET_Close). A
host socket still pending is freed here.
=============
*/
function _RTC_OnTransportClosed( conn ) {

	if ( conn.dead === true ) return;
	conn.dead = true;

	if ( conn.closing !== true && conn.connected === true )
		Con_Printf( 'WebRTC connection %s closed\n', conn.address );
	conn.connected = false;

	// Client: wake a connect still waiting for the reply
	if ( conn.replyResolve !== null ) {

		const resolve = conn.replyResolve;
		conn.replyResolve = null;
		resolve( null );

	}

	const sock = conn.sock;
	if ( sock !== null && rtc_pending.includes( sock ) === true ) {

		_RTC_DropUnaccepted( conn );
		return;

	}

	_RTC_FinishClose( conn );

}

/*
=============
RTC_QGetMessage

Returns 0 = no message, 1 = reliable, 2 = unreliable, -1 = error
=============
*/
export function RTC_QGetMessage( sock ) {

	const conn = sock.driverdata;
	if ( conn === null ) return - 1;

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

		const payload = _RTC_ParseSequencedPacket( sock, conn, msg.data, msg.reliable );
		if ( payload === null )
			continue;

		// Never let a peer-sized payload overflow net_message (SZ_Write
		// would call Sys_Error and kill the tab)
		if ( payload.length > net_message.maxsize ) {

			if ( msg.reliable === false ) {

				if ( conn.oversizedLogged !== true ) {

					conn.oversizedLogged = true;
					Con_Printf( 'Dropping oversized message from %s (%d bytes)\n', conn.address, payload.length );

				}
				continue;

			}

			_RTC_ProtocolError( conn, 'oversized reliable message (' + payload.length + ' bytes)' );
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

/*
=============
_RTC_ParseSequencedPacket

Strip the sequencing header and update the socket's sequence and ack state,
as _WS_ParseSequencedPacket does. Returns null for a stale or reordered
packet.
=============
*/
function _RTC_ParseSequencedPacket( sock, conn, packet, reliable ) {

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

function _RTC_Buffered( channel ) {

	const amount = channel.bufferedAmount;
	return typeof amount === 'number' ? amount : 0;

}

function _RTC_ChannelOpen( channel ) {

	return channel !== null && channel.readyState === 'open';

}

/*
=============
_RTC_SendPacket

[magic][sequence][ack][payload] from the send scratch buffer. The ack is the
highest sequence received on either channel, so a joiner's moves are
acknowledged whichever channel they came on.
=============
*/
function _RTC_SendPacket( sock, conn, channel, data ) {

	const length = data.cursize;
	const sequence = sock.sendSequence | 0;
	const acknowledged = conn.hasReceivedSequence === true ? conn.highestReceivedSequence | 0 : sock.receiveSequence | 0;

	rtc_sendbuf[ 0 ] = WT_PACKET_MAGIC;
	rtc_sendview.setUint32( 1, sequence >>> 0, true );
	rtc_sendview.setUint32( 5, acknowledged >>> 0, true );
	rtc_sendbuf.set( data.data.subarray( 0, length ), WT_PACKET_HEADER_BYTES );

	sock.sendSequence = ( sequence + 1 ) | 0;

	channel.send( rtc_sendbuf.subarray( 0, WT_PACKET_HEADER_BYTES + length ) );

}

// Common checks before a send; returns false if the connection can't send.
function _RTC_CheckSendable( conn ) {

	if ( conn.error !== null || conn.connected !== true ) {

		conn.connected = false;
		return false;

	}

	if ( _RTC_ChannelOpen( conn.reliable ) === false ) {

		conn.connected = false;
		return false;

	}

	if ( _RTC_Buffered( conn.reliable ) >= RTC_HARD_BUFFERED ) {

		Con_Printf( 'WebRTC %s: send buffer stalled, disconnecting\n', conn.address );
		conn.connected = false;
		conn.error = new Error( 'send buffer stalled' );
		return false;

	}

	return true;

}

/*
=============
RTC_QSendMessage

Send a reliable message. SCTP handles ordering and retransmission.
=============
*/
export function RTC_QSendMessage( sock, data ) {

	const conn = sock.driverdata;
	if ( conn === null || conn.connected !== true ) return - 1;
	if ( _RTC_CheckSendable( conn ) === false ) return - 1;

	if ( data.cursize > NET_MAXMESSAGE ) {

		Con_Printf( 'RTC_QSendMessage: message too large (%d bytes)\n', data.cursize );
		return - 1;

	}

	try {

		_RTC_SendPacket( sock, conn, conn.reliable, data );

	} catch ( error ) {

		Con_Printf( 'RTC_QSendMessage error: ' + error.message + '\n' );
		conn.connected = false;
		conn.error = error;
		return - 1;

	}

	return 1;

}

// A dropped unreliable message. The client still uses up a sequence number,
// so commands stored for prediction keep distinct sequences (as
// net_websocket.js); the host uses none (as server/net_websocket_server.ts).
function _RTC_DropUnreliable( sock, conn ) {

	if ( conn.role === 'client' )
		sock.sendSequence = ( sock.sendSequence + 1 ) | 0;
	return 1;

}

/*
=============
RTC_SendUnreliableMessage

Send on the unreliable channel. A message too large for one unfragmented
packet goes on the reliable channel instead; one that can't go out now
(channel not open yet, or backed up) is dropped.
=============
*/
export function RTC_SendUnreliableMessage( sock, data ) {

	const conn = sock.driverdata;
	if ( conn === null || conn.connected !== true ) {

		Con_DPrintf( 'RTC_SendUnreliableMessage: no connection\n' );
		return - 1;

	}

	if ( _RTC_CheckSendable( conn ) === false ) return - 1;

	if ( data.cursize > NET_MAXMESSAGE ) return _RTC_DropUnreliable( sock, conn );

	if ( WT_PACKET_HEADER_BYTES + data.cursize > RTC_MAX_UNRELIABLE_BYTES ) {

		if ( conn.oversizedSendLogged !== true ) {

			conn.oversizedSendLogged = true;
			Con_Printf( 'RTC_SendUnreliableMessage: %d-byte message to %s exceeds %d; using the reliable channel\n',
				WT_PACKET_HEADER_BYTES + data.cursize, conn.address, RTC_MAX_UNRELIABLE_BYTES );

		}

		if ( _RTC_Buffered( conn.reliable ) >= RTC_MAX_RELIABLE_BUFFERED )
			return _RTC_DropUnreliable( sock, conn );
		return RTC_QSendMessage( sock, data );

	}

	const channel = conn.unreliable;
	if ( _RTC_ChannelOpen( channel ) === false || _RTC_Buffered( channel ) >= RTC_MAX_UNRELIABLE_BUFFERED )
		return _RTC_DropUnreliable( sock, conn );

	try {

		_RTC_SendPacket( sock, conn, channel, data );

	} catch {

		// Unreliable: a failed send is a dropped message; the next reliable
		// send or the close event reports a dead connection.

	}

	return 1;

}

/*
=============
RTC_CanSendMessage
=============
*/
export function RTC_CanSendMessage( sock ) {

	const conn = sock.driverdata;
	if ( conn === null ) return false;

	return conn.connected === true && _RTC_ChannelOpen( conn.reliable ) &&
		_RTC_Buffered( conn.reliable ) < RTC_MAX_RELIABLE_BUFFERED;

}

/*
=============
RTC_CanSendUnreliableMessage

Client: true while connected, as WS_CanSendUnreliableMessage: a message that
can't go out is dropped and still uses its sequence number. Host: false while
the unreliable channel can't take a message, so SV_SendClientDatagram skips
building it (QW-style gating, as the server drivers do).
=============
*/
export function RTC_CanSendUnreliableMessage( sock ) {

	const conn = sock.driverdata;
	if ( conn === null ) return false;

	if ( conn.connected !== true || _RTC_ChannelOpen( conn.reliable ) === false ) return false;
	if ( conn.role === 'client' ) return true;

	return _RTC_ChannelOpen( conn.unreliable ) && _RTC_Buffered( conn.unreliable ) < RTC_MAX_UNRELIABLE_BUFFERED;

}

/*
=============
_RTC_CloseConnection

Graceful close: stop delivering messages, let the reliable channel drain
what is queued (svc_disconnect, a kick or reject reason, clc_disconnect),
then close the channel, which SCTP does after the data already sent. The
peer connection closes once the channel has, or after RTC_CLOSE_FLUSH_MS.
=============
*/
function _RTC_CloseConnection( conn ) {

	if ( conn.closing === true ) return;
	conn.closing = true;
	conn.connected = false;
	_RTC_ClearTimers( conn );
	if ( conn.role === 'client' && conn.closeFinished !== true ) rtc_closing.add( conn );

	if ( conn.dead === true || _RTC_ChannelOpen( conn.reliable ) === false ) {

		_RTC_FinishClose( conn );
		return;

	}

	conn.closeDeadline = performance.now() + RTC_CLOSE_FLUSH_MS;
	_RTC_PollClose( conn );

}

function _RTC_PollClose( conn ) {

	conn.closeTimer = null;
	if ( conn.closeFinished === true ) return;

	if ( conn.dead === true || performance.now() >= conn.closeDeadline ) {

		_RTC_FinishClose( conn );
		return;

	}

	const channel = conn.reliable;
	if ( channel.readyState === 'open' && _RTC_Buffered( channel ) === 0 ) {

		// The channel's close event (_RTC_OnTransportClosed) finishes
		try { channel.close(); } catch { _RTC_FinishClose( conn ); return; }

	}

	conn.closeTimer = setTimeout( () => _RTC_PollClose( conn ), RTC_CLOSE_POLL_MS );

}

function _RTC_ClearTimers( conn ) {

	if ( conn.handshakeTimer !== null ) {

		clearTimeout( conn.handshakeTimer );
		conn.handshakeTimer = null;

	}

	if ( conn.pendingAcceptTimer !== null ) {

		clearTimeout( conn.pendingAcceptTimer );
		conn.pendingAcceptTimer = null;

	}

	if ( conn.closeTimer !== null ) {

		clearTimeout( conn.closeTimer );
		conn.closeTimer = null;

	}

}

/*
=============
_RTC_FinishClose

Release the peer connection. Messages already queued stay for
RTC_QGetMessage while a socket still points here.
=============
*/
function _RTC_FinishClose( conn ) {

	if ( conn.closeFinished === true ) return;
	conn.closeFinished = true;
	conn.closing = true;
	conn.connected = false;
	conn.dead = true;
	_RTC_ClearTimers( conn );

	if ( conn.replyResolve !== null ) {

		const resolve = conn.replyResolve;
		conn.replyResolve = null;
		resolve( null );

	}

	if ( conn.openWaiter !== null ) {

		const waiter = conn.openWaiter;
		conn.openWaiter = null;
		waiter.reject( new Error( 'data channel closed' ) );

	}

	if ( conn.answerWaiter !== null ) {

		const waiter = conn.answerWaiter;
		conn.answerWaiter = null;
		waiter.reject( new Error( 'peer connection closed before the answer applied' ) );

	}

	for ( const channel of [ conn.reliable, conn.unreliable ] ) {

		if ( channel === null ) continue;
		channel.onopen = null;
		channel.onmessage = null;
		channel.onclose = null;
		channel.onerror = null;
		try { channel.close(); } catch { /* ignore */ }

	}

	const pc = conn.pc;
	if ( pc !== null ) {

		pc.onicecandidate = null;
		pc.onconnectionstatechange = null;
		pc.ondatachannel = null;
		try { pc.close(); } catch { /* ignore */ }

	}

	if ( conn.role === 'host' ) {

		if ( rtc_peers.get( conn.remoteId ) === conn ) rtc_peers.delete( conn.remoteId );
		Con_DPrintf( 'Connection closed: ' + conn.address + '\n' );

	} else if ( rtc_client === conn && conn.sock === null ) {

		rtc_client = null;

	}

	if ( rtc_closing.delete( conn ) === true ) _RTC_WakeCloseWaiters();

}

/*
=============
_RTC_WaitForClosingConnections

Resolves once every closing client connection has finished, so a reconnect
reaches the host after it has seen the old connection go (as
_WS_WaitForClosingConnections).
=============
*/
function _RTC_WaitForClosingConnections() {

	if ( rtc_closing.size === 0 ) return Promise.resolve();
	return new Promise( ( resolve ) => {

		rtc_closeWaiters.push( resolve );

	} );

}

function _RTC_WakeCloseWaiters() {

	if ( rtc_closing.size !== 0 ) return;
	const waiters = rtc_closeWaiters;
	rtc_closeWaiters = [];
	for ( const resolve of waiters ) resolve();

}

/*
=============
RTC_Close

Close a connection. The socket is detached at once (NET_Close frees it
straight after); the close finishes in the background.
=============
*/
export function RTC_Close( sock ) {

	const conn = sock.driverdata;
	if ( conn === null ) return;

	rtc_connections.delete( sock );
	const idx = rtc_pending.indexOf( sock );
	if ( idx !== - 1 ) rtc_pending.splice( idx, 1 );

	conn.sock = null;
	sock.driverdata = null;
	conn.pendingMessages.length = 0;
	if ( rtc_client === conn ) rtc_client = null;

	_RTC_CloseConnection( conn );

}
