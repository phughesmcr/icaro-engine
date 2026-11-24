// Ported from: WinQuake/net.h -- quake's interface to the networking layer

import { MAX_DATAGRAM } from './quakedef.js';
import { sizebuf_t } from './common.js';

//============================================================================
// Network constants
//============================================================================

export const NET_NAMELEN = 64;

export const NET_MAXMESSAGE = 8192;
export const NET_HEADERSIZE = ( 2 * 4 ); // 2 * sizeof(unsigned int)
export const NET_DATAGRAMSIZE = ( MAX_DATAGRAM + NET_HEADERSIZE );

// NetHeader flags
export const NETFLAG_LENGTH_MASK = 0x0000ffff;
export const NETFLAG_DATA = 0x00010000;
export const NETFLAG_ACK = 0x00020000;
export const NETFLAG_NAK = 0x00040000;
export const NETFLAG_EOM = 0x00080000;
export const NETFLAG_UNRELIABLE = 0x00100000;
export const NETFLAG_CTL = 0x80000000;

export const NET_PROTOCOL_VERSION = 3;

// Connection request types
export const CCREQ_CONNECT = 0x01;
export const CCREQ_SERVER_INFO = 0x02;
export const CCREQ_PLAYER_INFO = 0x03;
export const CCREQ_RULE_INFO = 0x04;

// Connection reply types
export const CCREP_ACCEPT = 0x81;
export const CCREP_REJECT = 0x82;
export const CCREP_SERVER_INFO = 0x83;
export const CCREP_PLAYER_INFO = 0x84;
export const CCREP_RULE_INFO = 0x85;

export const HOSTCACHESIZE = 8;

export const MAX_NET_DRIVERS = 8;

//============================================================================
// qsocket_t - network socket structure
//============================================================================

export class qsocket_t {

	constructor() {

		this.next = null;
		this.connecttime = 0;
		this.lastMessageTime = 0;
		this.lastSendTime = 0;

		this.disconnected = false;
		this.canSend = false;
		this.sendNext = false;

		this.driver = 0;
		this.landriver = 0;
		this.socket = 0;
		this.driverdata = null;

		this.ackSequence = 0;
		this.sendSequence = 0;
		this.unreliableSendSequence = 0;
		this.sendMessageLength = 0;
		this.sendMessage = new Uint8Array( NET_MAXMESSAGE );

		this.receiveSequence = 0;
		this.unreliableReceiveSequence = 0;
		this.receiveMessageLength = 0;
		this.receiveMessage = new Uint8Array( NET_MAXMESSAGE );

		this.addr = null;
		this.address = '';

	}

}

//============================================================================
// net_landriver_t - low-level network driver interface
//============================================================================

export class net_landriver_t {

	constructor() {

		this.name = '';
		this.initialized = false;
		this.controlSock = 0;
		this.Init = null;
		this.Shutdown = null;
		this.Listen = null;
		this.OpenSocket = null;
		this.CloseSocket = null;
		this.Connect = null;
		this.CheckNewConnections = null;
		this.Read = null;
		this.Write = null;
		this.Broadcast = null;
		this.AddrToString = null;
		this.StringToAddr = null;
		this.GetSocketAddr = null;
		this.GetNameFromAddr = null;
		this.GetAddrFromName = null;
		this.AddrCompare = null;
		this.GetSocketPort = null;
		this.SetSocketPort = null;

	}

}

//============================================================================
// net_driver_t - high-level network driver interface
//============================================================================

export class net_driver_t {

	constructor() {

		this.name = '';
		this.initialized = false;
		this.Init = null;
		this.Listen = null;
		this.SearchForHosts = null;
		this.Connect = null;
		this.CheckNewConnections = null;
		this.QGetMessage = null;
		this.QSendMessage = null;
		this.SendUnreliableMessage = null;
		this.CanSendMessage = null;
		this.CanSendUnreliableMessage = null;
		this.Close = null;
		this.Shutdown = null;
		this.controlSock = 0;

	}

}

//============================================================================
// hostcache_t - server browser cache entry
//============================================================================

export class hostcache_t {

	constructor() {

		this.name = '';
		this.map = '';
		this.cname = '';
		this.users = 0;
		this.maxusers = 0;
		this.driver = 0;
		this.ldriver = 0;
		this.addr = null;

	}

}

//============================================================================
// PollProcedure - for scheduled network polling
//============================================================================

export class PollProcedure {

	constructor( next, nextTime, procedure, arg ) {

		this.next = next || null;
		this.nextTime = nextTime || 0;
		this.procedure = procedure || null;
		this.arg = arg || null;

	}

}

//============================================================================
// Network globals
//============================================================================

export let net_activeSockets = null;
export let net_freeSockets = null;
export let net_numsockets = 0;

export function set_net_activeSockets( v ) { net_activeSockets = v; }
export function set_net_freeSockets( v ) { net_freeSockets = v; }
export function set_net_numsockets( v ) { net_numsockets = v; }

export let net_numdrivers = 0;
export const net_drivers = new Array( MAX_NET_DRIVERS );
for ( let i = 0; i < MAX_NET_DRIVERS; i ++ )
	net_drivers[ i ] = new net_driver_t();

export let net_numlandrivers = 0;
export const net_landrivers = new Array( MAX_NET_DRIVERS );
for ( let i = 0; i < MAX_NET_DRIVERS; i ++ )
	net_landrivers[ i ] = new net_landriver_t();

export let DEFAULTnet_hostport = 26000;
export let net_hostport = 26000;

export function set_DEFAULTnet_hostport( v ) { DEFAULTnet_hostport = v; }
export function set_net_hostport( v ) { net_hostport = v; }

export let net_driverlevel = 0;
export function set_net_driverlevel( v ) { net_driverlevel = v; }

export function set_net_numdrivers( v ) { net_numdrivers = v; }

export let serialAvailable = false;
export let ipxAvailable = false;
export let tcpipAvailable = false;

export let my_ipx_address = '';
export let my_tcpip_address = '';

export let net_time = 0;
export function set_net_time( v ) { net_time = v; }

export const net_message = new sizebuf_t();
export let net_activeconnections = 0;
export function set_net_activeconnections( v ) { net_activeconnections = v; }

export let messagesSent = 0;
export let messagesReceived = 0;
export let unreliableMessagesSent = 0;
export let unreliableMessagesReceived = 0;

export let hostCacheCount = 0;
export function set_hostCacheCount( v ) { hostCacheCount = v; }

export const hostcache = new Array( HOSTCACHESIZE );
for ( let i = 0; i < HOSTCACHESIZE; i ++ )
	hostcache[ i ] = new hostcache_t();

export let slistInProgress = false;
export let slistSilent = false;
export let slistLocal = true;

export function set_slistInProgress( v ) { slistInProgress = v; }
export function set_slistSilent( v ) { slistSilent = v; }
export function set_slistLocal( v ) { slistLocal = v; }

//============================================================================
// WebTransport wire protocol (shared by src/net_webtransport.js and
// server/net_webtransport_server.ts)
//
// Reliable stream frames: [length:u16le][payload]
// Game packets:           [magic:u8][sequence:u32le][ack:u32le][quake payload]
//
// Connect handshake: the first reliable frame in each direction.
//   client -> server: "ICARO" [version:u8]
//   server -> client: "ICARO" [version:u8] [status:u8] [reason: utf-8]
// The server allocates a client slot only after a valid hello, and rejects
// with a reason (for example "Server is full") instead of dropping the session.
//============================================================================

export const WT_PACKET_MAGIC = 0x71;
export const WT_PACKET_HEADER_BYTES = 9; // [magic:u8][sequence:u32][acknowledged:u32]

// Largest reliable frame payload either side accepts: one full game message
// plus the sequencing header. Anything larger is a protocol violation.
export const WT_MAX_FRAME_PAYLOAD = NET_MAXMESSAGE + WT_PACKET_HEADER_BYTES;

export const WT_PROTOCOL_VERSION = 1;
export const WT_HANDSHAKE_ACCEPT = 0;
export const WT_HANDSHAKE_REJECT = 1;
const WT_HANDSHAKE_MAGIC = [ 0x49, 0x43, 0x41, 0x52, 0x4f ]; // "ICARO"
const WT_HANDSHAKE_MAGIC_BYTES = 5;
const WT_HANDSHAKE_MAX_REASON = 200;

function _WT_FrameBytes( payload ) {

	const frame = new Uint8Array( 2 + payload.length );
	frame[ 0 ] = payload.length & 0xff;
	frame[ 1 ] = ( payload.length >> 8 ) & 0xff;
	frame.set( payload, 2 );
	return frame;

}

function _WT_HasHandshakeMagic( payload ) {

	if ( payload == null || payload.length < WT_HANDSHAKE_MAGIC_BYTES + 1 )
		return false;

	for ( let i = 0; i < WT_HANDSHAKE_MAGIC_BYTES; i ++ ) {

		if ( payload[ i ] !== WT_HANDSHAKE_MAGIC[ i ] )
			return false;

	}

	return true;

}

/**
 * Client hello, already framed for the reliable stream.
 * @returns {Uint8Array}
 */
export function WT_BuildHelloFrame() {

	const payload = new Uint8Array( WT_HANDSHAKE_MAGIC_BYTES + 1 );
	payload.set( WT_HANDSHAKE_MAGIC, 0 );
	payload[ WT_HANDSHAKE_MAGIC_BYTES ] = WT_PROTOCOL_VERSION;
	return _WT_FrameBytes( payload );

}

/**
 * Parse a client hello payload (the frame body, without the length prefix).
 * @param {Uint8Array} payload
 * @returns {number} the client's protocol version, or -1 if it is not a hello
 */
export function WT_ParseHello( payload ) {

	if ( _WT_HasHandshakeMagic( payload ) === false )
		return - 1;

	return payload[ WT_HANDSHAKE_MAGIC_BYTES ];

}

/**
 * Server reply to a hello, already framed for the reliable stream.
 * @param {number} status WT_HANDSHAKE_ACCEPT or WT_HANDSHAKE_REJECT
 * @param {string} reason shown to the player on reject
 * @returns {Uint8Array}
 */
export function WT_BuildHandshakeReplyFrame( status, reason = '' ) {

	let reasonBytes = new TextEncoder().encode( reason );
	if ( reasonBytes.length > WT_HANDSHAKE_MAX_REASON )
		reasonBytes = reasonBytes.subarray( 0, WT_HANDSHAKE_MAX_REASON );

	const payload = new Uint8Array( WT_HANDSHAKE_MAGIC_BYTES + 2 + reasonBytes.length );
	payload.set( WT_HANDSHAKE_MAGIC, 0 );
	payload[ WT_HANDSHAKE_MAGIC_BYTES ] = WT_PROTOCOL_VERSION;
	payload[ WT_HANDSHAKE_MAGIC_BYTES + 1 ] = status;
	payload.set( reasonBytes, WT_HANDSHAKE_MAGIC_BYTES + 2 );
	return _WT_FrameBytes( payload );

}

/**
 * Parse a server handshake reply payload (the frame body).
 * @param {Uint8Array} payload
 * @returns {{ version: number, status: number, reason: string } | null}
 */
export function WT_ParseHandshakeReply( payload ) {

	if ( _WT_HasHandshakeMagic( payload ) === false || payload.length < WT_HANDSHAKE_MAGIC_BYTES + 2 )
		return null;

	return {
		version: payload[ WT_HANDSHAKE_MAGIC_BYTES ],
		status: payload[ WT_HANDSHAKE_MAGIC_BYTES + 1 ],
		reason: new TextDecoder().decode( payload.subarray( WT_HANDSHAKE_MAGIC_BYTES + 2 ) )
	};

}
