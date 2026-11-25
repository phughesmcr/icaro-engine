// Icaro Engine Lobby Server for Deno
// Lightweight server that only handles room management
// Spawns separate game server processes for each room
//
// Usage: see server/README.md ("Run the Lobby Server") for the scoped
// permission flags, or `deno task lobby` from the repository root.

import { Sys_Printf } from './sys_server.ts';
import { QUIC_CloseEndpoints, QUIC_OpenEndpoints } from './quic_listen.ts';
import { WS_ClientAddress } from './client_address.ts';
import { WT_BuildHandshakeReplyFrame, WT_HANDSHAKE_REJECT, WS_CHANNEL_UNRELIABLE } from '../src/net.js';
import {
	RoomManager_SetConfig,
	RoomManager_CreateRoom,
	RoomManager_GetRoom,
	RoomManager_ListRooms,
	RoomManager_CleanupIdleRooms,
	RoomManager_CleanupUnhealthyRooms,
	RoomManager_ShutdownAll,
	RoomManager_CountRoomsByOwner,
	RoomManager_GetRoomCount,
	RoomManager_HasRoom,
	RoomManager_ClampMaxPlayers,
	RoomManager_SanitizeHostName,
	RoomManager_SanitizeMapName,
	MAX_ROOMS,
	BASE_PORT,
	DEFAULT_MAP,
} from './room_process_manager.ts';

// Server configuration
const CONFIG = {
	port: 4433,
	certFile: 'cert.pem',
	keyFile: 'key.pem',
	pakPath: '../static/pak0.pak',
	denoPath: null, // null = Deno.execPath()
	gameFlags: [],  // -rogue and/or -hipnotic, passed on to every room
	gameDir: null,  // -game <dir>, passed on to every room
	wsPort: null,   // -wsport <port>: WebSocket lobby and room proxy (TCP)
	wsHost: '127.0.0.1', // -wshost <addr>: WebSocket listen address
	wsTls: false,   // -wstls: wss:// with -cert/-key instead of plain ws://
};

// Abuse limits. Room creation (LOBBY_CREATE, and LOBBY_JOIN on an unknown
// but well-formed six-character id, which re-creates the room) is rate limited per client IP and
// globally, and each IP may own a few live rooms at most.
export const LIMITS = {
	maxSessions: 64,            // Concurrent lobby sessions, all clients
	maxSessionsPerIp: 8,        // Concurrent lobby sessions per client IP
	maxRoomsPerIp: 3,           // Live rooms created by one client IP
	createsPerIpPerWindow: 3,   // Room creations per IP per window
	createsGlobalPerWindow: 10, // Room creations per window, all clients
	createWindowMs: 60 * 1000,
	maxRequestBytes: 4096,      // Largest accepted lobby request payload
	maxProxies: 160,            // WebSocket room connections proxied, all clients
	maxProxiesPerIp: 16,        // WebSocket room connections proxied per client IP
};

export const MAX_FRAME_PAYLOAD = 0xffff;

// Parse command line arguments
function parseArgs() {
	const args = Deno.args;
	for ( let i = 0; i < args.length; i++ ) {
		const arg = args[ i ];
		if ( arg === '-port' && args[ i + 1 ] ) {
			CONFIG.port = parseInt( args[ ++i ], 10 );
		} else if ( arg === '-cert' && args[ i + 1 ] ) {
			CONFIG.certFile = args[ ++i ];
		} else if ( arg === '-key' && args[ i + 1 ] ) {
			CONFIG.keyFile = args[ ++i ];
		} else if ( arg === '-pak' && args[ i + 1 ] ) {
			CONFIG.pakPath = args[ ++i ];
		} else if ( arg === '-deno' && args[ i + 1 ] ) {
			CONFIG.denoPath = args[ ++i ];
		} else if ( arg === '-rogue' || arg === '-hipnotic' ) {
			CONFIG.gameFlags.push( arg );
		} else if ( arg === '-game' && args[ i + 1 ] ) {
			CONFIG.gameDir = args[ ++i ];
		} else if ( arg === '-wsport' && args[ i + 1 ] ) {
			const port = parseInt( args[ ++i ], 10 );
			if ( Number.isInteger( port ) && port > 0 && port < 65536 ) CONFIG.wsPort = port;
		} else if ( arg === '-wshost' && args[ i + 1 ] ) {
			CONFIG.wsHost = args[ ++i ];
		} else if ( arg === '-wstls' ) {
			CONFIG.wsTls = true;
		}
	}
}

/**
 * Sliding-window rate limiter keyed by string (client IP, or '*' for global).
 */
export function createRateLimiter( limit, windowMs ) {
	const hits = new Map();

	function prune( now ) {
		for ( const [ key, times ] of hits ) {
			while ( times.length > 0 && now - times[ 0 ] >= windowMs ) times.shift();
			if ( times.length === 0 ) hits.delete( key );
		}
	}

	return {
		// True if `key` may act now (does not record a hit)
		canTake( key, now = Date.now() ) {
			prune( now );
			const times = hits.get( key );
			return times === undefined || times.length < limit;
		},
		// True if `key` may act now (and records the hit)
		tryTake( key, now = Date.now() ) {
			if ( this.canTake( key, now ) === false ) return false;
			let times = hits.get( key );
			if ( times === undefined ) {
				times = [];
				hits.set( key, times );
			}
			times.push( now );
			return true;
		},
		size() {
			return hits.size;
		},
	};
}

const perIpCreateLimiter = createRateLimiter( LIMITS.createsPerIpPerWindow, LIMITS.createWindowMs );
const globalCreateLimiter = createRateLimiter( LIMITS.createsGlobalPerWindow, LIMITS.createWindowMs );

/**
 * Check every room-creation limit for client `ip`. Returns null if allowed
 * (and consumes rate-limit budget), else an error message for the client.
 * Budget is spent on every allowed attempt, including ones whose room then
 * fails to start: the spawn cost is paid either way.
 */
export function checkCreateAllowed( ip, now = Date.now() ) {
	if ( RoomManager_GetRoomCount() >= MAX_ROOMS ) {
		return 'Server room limit reached (' + MAX_ROOMS + ' rooms). Try again later.';
	}
	if ( RoomManager_CountRoomsByOwner( ip ) >= LIMITS.maxRoomsPerIp ) {
		return 'You already have ' + LIMITS.maxRoomsPerIp + ' rooms open. Close one first.';
	}
	if ( perIpCreateLimiter.canTake( ip, now ) === false ) {
		return 'Too many rooms created. Wait a minute and try again.';
	}
	if ( globalCreateLimiter.canTake( '*', now ) === false ) {
		return 'Server is busy creating rooms. Try again shortly.';
	}
	perIpCreateLimiter.tryTake( ip, now );
	globalCreateLimiter.tryTake( '*', now );
	return null;
}

/**
 * Validate a LOBBY_CREATE payload. Returns the room config to use, or
 * throws an Error whose message is safe to send to the client.
 */
export function parseCreateConfig( data ) {
	let config;
	try {
		config = JSON.parse( new TextDecoder().decode( data ) );
	} catch {
		throw new Error( 'Invalid room config' );
	}
	if ( config === null || typeof config !== 'object' || Array.isArray( config ) ) {
		throw new Error( 'Invalid room config' );
	}
	let map = DEFAULT_MAP;
	if ( config.map != null && config.map !== '' ) {
		map = RoomManager_SanitizeMapName( config.map );
		if ( map === null ) throw new Error( 'Invalid map name' );
	}
	return {
		map,
		maxPlayers: config.maxPlayers == null ? undefined : RoomManager_ClampMaxPlayers( config.maxPlayers ),
		hostName: RoomManager_SanitizeHostName( config.hostName ),
	};
}

// Lobby message types
const LOBBY_LIST = 0x01;
const LOBBY_JOIN = 0x02;
const LOBBY_CREATE = 0x03;
const LOBBY_ROOMS = 0x81;
const LOBBY_ERROR = 0x82;
const ROOM_ID_PATTERN = /^[A-Z0-9]{6}$/;

// QUIC endpoints (IPv6 and/or IPv4, see quic_listen.ts)
let quicEndpoints = null;

// Per-reader buffer storage for leftover bytes
const _readerBuffers = new WeakMap();

function _getReaderBuffer( reader ) {
	let buf = _readerBuffers.get( reader );
	if ( buf == null ) {
		buf = { data: null, offset: 0 };
		_readerBuffers.set( reader, buf );
	}
	return buf;
}

/**
 * Read exactly n bytes from a reader, with proper buffering
 */
async function readExact( reader, n ) {
	const result = new Uint8Array( n );
	let offset = 0;
	const buf = _getReaderBuffer( reader );

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
		if ( done ) return null;

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

/**
 * Read a framed message: [type:1][length:2][data:N]
 */
async function readFramedMessage( reader ) {
	const header = await readExact( reader, 3 );
	if ( header === null ) return null;

	const type = header[ 0 ];
	const length = header[ 1 ] | ( header[ 2 ] << 8 );

	if ( length === 0 ) {
		return { type, data: new Uint8Array( 0 ) };
	}

	const data = await readExact( reader, length );
	if ( data === null ) return null;

	return { type, data };
}

/**
 * Build a [type:1][length:2][data:N] frame. Throws if the payload does not
 * fit the 16-bit length field.
 */
export function encodeFrame( type, data ) {
	if ( data.length > MAX_FRAME_PAYLOAD ) {
		throw new RangeError( 'Lobby frame payload too large (' + data.length + ' > ' + MAX_FRAME_PAYLOAD + ' bytes)' );
	}
	const frame = new Uint8Array( 3 + data.length );
	frame[ 0 ] = type;
	frame[ 1 ] = data.length & 0xff;
	frame[ 2 ] = ( data.length >> 8 ) & 0xff;
	frame.set( data, 3 );
	return frame;
}

/**
 * Send a framed message
 */
async function sendFramedMessage( writer, type, data ) {
	await writer.write( encodeFrame( type, data ) );
}


/**
 * Await `promise`, rejecting after `ms` with `message`. Clears its timer.
 */
async function withTimeout( promise, ms, message ) {
	let timer;
	const timeout = new Promise( ( _, reject ) => {
		timer = setTimeout( () => reject( new Error( message ) ), ms );
	} );
	try {
		return await Promise.race( [ promise, timeout ] );
	} finally {
		clearTimeout( timer );
	}
}

function roomInfoFor( room ) {
	return {
		id: room.id,
		port: room.port,
		map: room.map,
		maxPlayers: room.maxPlayers,
		hostName: room.hostName,
	};
}


function errorReply( message ) {
	return { type: LOBBY_ERROR, data: new TextEncoder().encode( message ) };
}

function roomInfoReply( room ) {
	return { type: LOBBY_ROOMS, data: new TextEncoder().encode( JSON.stringify( roomInfoFor( room ) ) ) };
}

/**
 * Answer one lobby request ({ type, data }) from client `ip`, whichever
 * transport it came on. Resolves to the reply frame's { type, data }, or
 * null for an unknown request type (no reply).
 */
export async function handleLobbyRequest( msg, ip, address ) {
	if ( msg.data.length > LIMITS.maxRequestBytes ) {
		Sys_Printf( 'Oversized lobby request (%d bytes) from %s\n', msg.data.length, address );
		return errorReply( 'Request too large' );
	}

	switch ( msg.type ) {
		case LOBBY_LIST: {
			// Send room list
			const rooms = RoomManager_ListRooms();
			Sys_Printf( 'LIST from %s: %d rooms\n', address, rooms.length );
			return { type: LOBBY_ROOMS, data: new TextEncoder().encode( JSON.stringify( rooms ) ) };
		}

		case LOBBY_CREATE: {
			let config;
			try {
				config = parseCreateConfig( msg.data );
			} catch ( e ) {
				Sys_Printf( 'CREATE from %s rejected: %s\n', address, e.message );
				return errorReply( e.message );
			}

			const denied = checkCreateAllowed( ip );
			if ( denied !== null ) {
				Sys_Printf( 'CREATE from %s rejected: %s\n', address, denied );
				return errorReply( denied );
			}

			const result = await RoomManager_CreateRoom( { ...config, owner: ip } );
			const room = result === null ? null : RoomManager_GetRoom( result.id );
			if ( room === null ) {
				Sys_Printf( 'CREATE from %s failed\n', address );
				return errorReply( 'Unable to create room right now. Please try again.' );
			}
			Sys_Printf( 'Room %s created on port %d for %s\n', room.id, room.port, address );
			return roomInfoReply( room );
		}

		case LOBBY_JOIN: {
			// Get room info so client knows which port to connect to
			const roomId = new TextDecoder().decode( msg.data ).trim().toUpperCase();
			let room = ROOM_ID_PATTERN.test( roomId ) ? RoomManager_GetRoom( roomId ) : null;
			let errorMsg = 'Room not found. The game may have ended.';

			// A valid room id link to an expired room re-creates it, under
			// the same limits as LOBBY_CREATE.
			if ( room === null && ROOM_ID_PATTERN.test( roomId ) && RoomManager_HasRoom( roomId ) ) {
				// Another join is re-creating this room right now
				errorMsg = 'Room is starting. Try again in a moment.';
			} else if ( room === null && ROOM_ID_PATTERN.test( roomId ) ) {
				const denied = checkCreateAllowed( ip );
				if ( denied !== null ) {
					errorMsg = denied;
				} else {
					Sys_Printf( 'Auto-creating room for link ID %s (from %s)\n', roomId, address );
					const created = await RoomManager_CreateRoom( {
						map: DEFAULT_MAP,
						maxPlayers: 4,
						hostName: 'Shared',
						owner: ip,
						specificId: roomId,
					} );
					// Re-check room either way: create may have raced with
					// another join that created it first.
					room = RoomManager_GetRoom( roomId );
					if ( room === null ) {
						errorMsg = created === null && RoomManager_HasRoom( roomId )
							? 'Room is starting. Try again in a moment.'
							: 'Unable to create room right now. Please try again.';
					}
				}
			}

			if ( room === null ) {
				Sys_Printf( 'JOIN %s from %s failed: %s\n', JSON.stringify( roomId.slice( 0, 16 ) ), address, errorMsg );
				return errorReply( errorMsg );
			}
			if ( room.playerCount >= room.maxPlayers ) {
				Sys_Printf( 'JOIN %s from %s rejected: full (%d/%d)\n', roomId, address, room.playerCount, room.maxPlayers );
				return errorReply( 'Room is full (' + room.playerCount + '/' + room.maxPlayers + ' players)' );
			}
			Sys_Printf( 'JOIN %s from %s: port %d\n', room.id, address, room.port );
			return roomInfoReply( room );
		}

		default:
			Sys_Printf( 'Unknown lobby message type %d from %s\n', msg.type, address );
			return null;
	}
}

/**
 * Handle a WebTransport session
 */
async function handleSession( wt, address, ip ) {
	try {
		await wt.ready;

		// Accept bidirectional stream with timeout
		const streamReader = wt.incomingBidirectionalStreams.getReader();
		let result;
		try {
			result = await withTimeout( streamReader.read(), 30000, 'Stream accept timeout' );
		} finally {
			streamReader.releaseLock();
		}

		const stream = result.value;
		if ( result.done || stream == null ) {
			Sys_Printf( 'No stream received from %s\n', address );
			wt.close();
			return;
		}

		const writer = stream.writable.getWriter();
		const reader = stream.readable.getReader();

		// Read lobby message with timeout
		let msg;
		try {
			msg = await withTimeout( readFramedMessage( reader ), 10000, 'Message read timeout' );
		} catch ( e ) {
			Sys_Printf( 'Message read error from %s: %s\n', address, e.message );
			wt.close();
			return;
		}

		if ( msg === null ) {
			Sys_Printf( 'Empty message from %s\n', address );
			wt.close();
			return;
		}

		const reply = await handleLobbyRequest( msg, ip, address );
		if ( reply !== null ) await sendFramedMessage( writer, reply.type, reply.data );

		// Close connection after handling lobby request
		try {
			await writer.close();
		} catch { /* ignore */ }
		await new Promise( resolve => setTimeout( resolve, 100 ) );
		wt.close();

	} catch ( error ) {
		Sys_Printf( 'Session error from %s: %s\n', address, error.message );
		try { wt.close(); } catch { /* ignore */ }
	}
}

// Concurrent session tracking (for LIMITS.maxSessions / maxSessionsPerIp),
// over WebTransport and WebSocket together
let activeSessions = 0;
const activeSessionsByIp = new Map();

/**
 * Count a lobby session from `ip`. Returns its release function, or null
 * (and logs) when a session limit is reached.
 */
function reserveLobbySession( ip, address ) {
	const ipSessions = activeSessionsByIp.get( ip ) ?? 0;
	if ( activeSessions >= LIMITS.maxSessions || ipSessions >= LIMITS.maxSessionsPerIp ) {
		Sys_Printf( 'Rejecting lobby connection from %s: too many sessions (%d total, %d from this IP)\n', address, activeSessions, ipSessions );
		return null;
	}
	activeSessions++;
	activeSessionsByIp.set( ip, ipSessions + 1 );
	let released = false;
	return () => {
		if ( released ) return;
		released = true;
		activeSessions--;
		const n = ( activeSessionsByIp.get( ip ) ?? 1 ) - 1;
		if ( n <= 0 ) activeSessionsByIp.delete( ip );
		else activeSessionsByIp.set( ip, n );
	};
}

/**
 * Accept connections
 */
async function acceptConnections( listener ) {
	while ( quicEndpoints !== null ) {
		try {
			const conn = await listener.accept();
			const remoteAddr = conn.remoteAddr;
			const ip = remoteAddr.hostname;
			const address = ip + ':' + remoteAddr.port;

			const release = reserveLobbySession( ip, address );
			if ( release === null ) {
				try { conn.close(); } catch { /* ignore */ }
				continue;
			}

			// Handle in background
			( async () => {
				try {
					const wt = await Deno.upgradeWebTransport( conn );
					await handleSession( wt, address, ip );
				} catch ( error ) {
					Sys_Printf( 'Connection error from %s: %s\n', address, error.message );
					try { conn.close(); } catch { /* ignore */ }
				} finally {
					release();
				}
			} )();

		} catch ( error ) {
			if ( quicEndpoints !== null ) {
				Sys_Printf( 'Accept error: %s\n', error.message );
				// Delay before retrying to prevent 100% CPU spin if accept() fails repeatedly
				await new Promise( resolve => setTimeout( resolve, 100 ) );
			}
		}
	}
}

//============================================================================
// WebSocket listener (-wsport)
//
// For browsers without WebTransport and for HTTP-only proxies such as a
// Cloudflare Tunnel, everything goes through this one TCP port:
//   <prefix>/lobby       one lobby request per socket: a [type][len][data]
//                        frame each way, one WebSocket message each
//   <prefix>/room/<ID>   a game connection, proxied to the room's own
//                        WebSocket listener on 127.0.0.1:<room port>
// Any prefix works (the tunnel's /mp, or none), since only the path's tail
// is matched. src/net_websocket.js is the client side.
//============================================================================

const WS_OPEN = 1;
const WS_CONNECTING = 0;
const WS_LOBBY_REQUEST_TIMEOUT_MS = 10000;
const WS_PROXY_CONNECT_TIMEOUT_MS = 10000;
const WS_CLOSE_FLUSH_MS = 1000;
// Messages from the client held while the room connection opens (the hello)
const WS_PROXY_MAX_QUEUED = 16;
// Bytes queued towards the client: past the first, unreliable game messages
// are dropped (the room's own gate normally acts first); past the second,
// the client is too far behind and both sides are closed.
const WS_PROXY_UNRELIABLE_BUFFERED = 64 * 1024;
const WS_PROXY_HARD_BUFFERED = 4 * 1024 * 1024;

let wsAbort = null;

// Proxied room connections (LIMITS.maxProxies / maxProxiesPerIp)
let activeProxies = 0;
const activeProxiesByIp = new Map();

/**
 * Which endpoint a request path asks for: { kind: 'lobby' },
 * { kind: 'room', roomId }, or { kind: 'other' }.
 */
export function routeLobbyRequest( pathname ) {
	const room = /\/room\/([A-Za-z0-9]{1,16})\/?$/.exec( pathname );
	if ( room !== null ) return { kind: 'room', roomId: room[ 1 ].toUpperCase() };
	if ( /\/lobby\/?$/.test( pathname ) ) return { kind: 'lobby' };
	return { kind: 'other' };
}

/**
 * Close `socket` once its queued messages have gone (or after
 * WS_CLOSE_FLUSH_MS), so a final reply or disconnect reason is not cut off.
 */
function closeWhenDrained( socket, code = 1000, reason = '' ) {
	const deadline = Date.now() + WS_CLOSE_FLUSH_MS;
	const poll = () => {
		if ( socket.readyState !== WS_OPEN ) return;
		if ( socket.bufferedAmount > 0 && Date.now() < deadline ) {
			setTimeout( poll, 20 );
			return;
		}
		try { socket.close( code, reason ); } catch { /* ignore */ }
	};
	poll();
}

/**
 * One lobby request over WebSocket: read a frame, answer it, close.
 */
export function serveLobbySocket( socket, ip, address, release ) {
	socket.binaryType = 'arraybuffer';
	let done = false;
	const finish = () => {
		if ( done ) return;
		done = true;
		clearTimeout( timer );
		release();
	};
	const timer = setTimeout( () => {
		Sys_Printf( 'Message read error from %s: Message read timeout\n', address );
		finish();
		try { socket.close( 1000 ); } catch { /* ignore */ }
	}, WS_LOBBY_REQUEST_TIMEOUT_MS );

	socket.onclose = finish;
	socket.onerror = finish;
	socket.onmessage = async ( event ) => {
		socket.onmessage = null;
		clearTimeout( timer );
		const raw = event.data;
		const bytes = raw instanceof ArrayBuffer ? new Uint8Array( raw ) : null;
		const length = bytes !== null && bytes.length >= 3 ? bytes[ 1 ] | ( bytes[ 2 ] << 8 ) : -1;
		if ( bytes === null || length < 0 || bytes.length !== 3 + length ) {
			Sys_Printf( 'Message read error from %s: malformed lobby frame\n', address );
			finish();
			try { socket.close( 1002 ); } catch { /* ignore */ }
			return;
		}
		try {
			const reply = await handleLobbyRequest( { type: bytes[ 0 ], data: bytes.subarray( 3 ) }, ip, address );
			if ( reply !== null && socket.readyState === WS_OPEN ) socket.send( encodeFrame( reply.type, reply.data ) );
		} catch ( error ) {
			Sys_Printf( 'Session error from %s: %s\n', address, error.message );
		}
		finish();
		closeWhenDrained( socket );
	};
}

/**
 * Answer a game connection's hello with a handshake reject, then close.
 * Used when the room asked for is not running.
 */
function rejectGameSocket( socket, reason, release ) {
	socket.binaryType = 'arraybuffer';
	const timer = setTimeout( () => {
		try { socket.close( 1000 ); } catch { /* ignore */ }
	}, WS_LOBBY_REQUEST_TIMEOUT_MS );
	socket.onclose = () => {
		clearTimeout( timer );
		release();
	};
	socket.onerror = socket.onclose;
	socket.onmessage = () => {
		socket.onmessage = null;
		clearTimeout( timer );
		try {
			socket.send( WT_BuildHandshakeReplyFrame( WT_HANDSHAKE_REJECT, reason ).subarray( 2 ) );
		} catch { /* ignore */ }
		closeWhenDrained( socket );
	};
}

function reserveProxy( ip, address ) {
	const n = activeProxiesByIp.get( ip ) ?? 0;
	if ( activeProxies >= LIMITS.maxProxies || n >= LIMITS.maxProxiesPerIp ) {
		Sys_Printf( 'Rejecting room connection from %s: too many connections (%d total, %d from this IP)\n', address, activeProxies, n );
		return null;
	}
	activeProxies++;
	activeProxiesByIp.set( ip, n + 1 );
	let released = false;
	return () => {
		if ( released ) return;
		released = true;
		activeProxies--;
		const left = ( activeProxiesByIp.get( ip ) ?? 1 ) - 1;
		if ( left <= 0 ) activeProxiesByIp.delete( ip );
		else activeProxiesByIp.set( ip, left );
	};
}

/**
 * Relay one game connection between `client` and the room's WebSocket
 * listener at `upstreamUrl`, message for message. Whichever side closes
 * first closes the other, after its queued messages have gone.
 * `openUpstream` makes the room socket (tests pass a fake).
 */
export function proxyGameSocket( client, upstreamUrl, address, release, openUpstream = ( url ) => new WebSocket( url ) ) {
	client.binaryType = 'arraybuffer';
	const queued = [];
	let closed = false;
	let upstream = null;

	const closeBoth = () => {
		if ( closed ) return;
		closed = true;
		clearTimeout( connectTimer );
		queued.length = 0;
		for ( const socket of [ client, upstream ] ) {
			if ( socket === null ) continue;
			socket.onmessage = null;
			socket.onopen = null;
			if ( socket.readyState === WS_CONNECTING ) {
				try { socket.close(); } catch { /* ignore */ }
			} else {
				closeWhenDrained( socket );
			}
		}
		release();
	};

	const connectTimer = setTimeout( () => {
		Sys_Printf( 'Room connection for %s timed out\n', address );
		closeBoth();
	}, WS_PROXY_CONNECT_TIMEOUT_MS );

	try {
		upstream = openUpstream( upstreamUrl );
	} catch ( error ) {
		Sys_Printf( 'Room connection for %s failed: %s\n', address, error.message );
		closeBoth();
		return;
	}
	upstream.binaryType = 'arraybuffer';

	client.onmessage = ( event ) => {
		if ( !( event.data instanceof ArrayBuffer ) ) {
			closeBoth();
			return;
		}
		if ( upstream.readyState === WS_OPEN ) {
			upstream.send( event.data );
		} else if ( upstream.readyState === WS_CONNECTING && queued.length < WS_PROXY_MAX_QUEUED ) {
			queued.push( event.data );
		} else {
			closeBoth();
		}
	};

	upstream.onopen = () => {
		clearTimeout( connectTimer );
		for ( const data of queued ) upstream.send( data );
		queued.length = 0;
	};

	upstream.onmessage = ( event ) => {
		const data = event.data;
		if ( !( data instanceof ArrayBuffer ) ) {
			closeBoth();
			return;
		}
		const buffered = client.bufferedAmount;
		if ( buffered >= WS_PROXY_HARD_BUFFERED ) {
			Sys_Printf( 'Room connection for %s: client not reading, closing\n', address );
			closeBoth();
			return;
		}
		// The first byte of a game message is its channel (src/net.js)
		if ( buffered >= WS_PROXY_UNRELIABLE_BUFFERED && data.byteLength > 0 &&
			new Uint8Array( data, 0, 1 )[ 0 ] === WS_CHANNEL_UNRELIABLE ) {
			return;
		}
		client.send( data );
	};

	client.onclose = closeBoth;
	client.onerror = closeBoth;
	upstream.onclose = closeBoth;
	upstream.onerror = closeBoth;
}

/**
 * HTTP handler for the WebSocket listener.
 */
export function handleLobbyHttpRequest( req, info ) {
	const url = new URL( req.url );
	const route = routeLobbyRequest( url.pathname );
	const isUpgrade = ( req.headers.get( 'upgrade' ) ?? '' ).toLowerCase() === 'websocket';

	if ( route.kind === 'other' || isUpgrade === false ) {
		if ( route.kind === 'other' ) {
			return new Response( 'Icaro Engine lobby: WebSocket endpoints are /lobby and /room/<id>\n', { status: 200 } );
		}
		return new Response( 'WebSocket only\n', { status: 426, headers: { upgrade: 'websocket' } } );
	}

	const remote = info.remoteAddr;
	const ip = WS_ClientAddress( url, req.headers, remote.hostname, false );
	const address = ip + ':' + remote.port;

	if ( route.kind === 'lobby' ) {
		const release = reserveLobbySession( ip, address );
		if ( release === null ) return new Response( 'Too many sessions\n', { status: 503 } );
		let upgraded;
		try {
			upgraded = Deno.upgradeWebSocket( req );
		} catch {
			release();
			return new Response( 'Bad Request\n', { status: 400 } );
		}
		serveLobbySocket( upgraded.socket, ip, address, release );
		return upgraded.response;
	}

	const release = reserveProxy( ip, address );
	if ( release === null ) return new Response( 'Too many connections\n', { status: 503 } );
	let upgraded;
	try {
		upgraded = Deno.upgradeWebSocket( req );
	} catch {
		release();
		return new Response( 'Bad Request\n', { status: 400 } );
	}

	const room = ROOM_ID_PATTERN.test( route.roomId ) ? RoomManager_GetRoom( route.roomId ) : null;
	if ( room === null ) {
		Sys_Printf( 'Room connection %s from %s: room not found\n', JSON.stringify( route.roomId ), address );
		rejectGameSocket( upgraded.socket, 'Room not found. The game may have ended.', release );
	} else {
		Sys_Printf( 'Room connection %s from %s: port %d\n', room.id, address, room.port );
		// The room trusts ?ip= because only the lobby reaches its listener
		proxyGameSocket( upgraded.socket, 'ws://127.0.0.1:' + room.port + '/?ip=' + encodeURIComponent( ip ), address, release );
	}
	return upgraded.response;
}

async function startWebSocketListener() {
	const options = {
		port: CONFIG.wsPort,
		hostname: CONFIG.wsHost,
		onListen: ( { hostname, port } ) => {
			Sys_Printf( 'Lobby WebSocket listening on %s://%s:%d\n', CONFIG.wsTls ? 'wss' : 'ws',
				hostname.includes( ':' ) ? '[' + hostname + ']' : hostname, port );
		},
		onError: ( error ) => {
			Sys_Printf( 'WebSocket request error: %s\n', error.message );
			return new Response( 'Internal Server Error\n', { status: 500 } );
		},
	};
	if ( CONFIG.wsTls ) {
		options.cert = await Deno.readTextFile( CONFIG.certFile );
		options.key = await Deno.readTextFile( CONFIG.keyFile );
	}
	wsAbort = new AbortController();
	options.signal = wsAbort.signal;
	Deno.serve( options, handleLobbyHttpRequest );
}

/**
 * Start the lobby server
 */
async function startServer() {
	Sys_Printf( '========================================\n' );
	Sys_Printf( 'Icaro Lobby Server v1.0\n' );
	Sys_Printf( '========================================\n\n' );

	// Configure room manager
	const roomConfig = {
		certFile: CONFIG.certFile,
		keyFile: CONFIG.keyFile,
		pakPath: CONFIG.pakPath,
		gameFlags: CONFIG.gameFlags,
		gameDir: CONFIG.gameDir,
		wsEnabled: CONFIG.wsPort !== null, // rooms listen for the proxy on 127.0.0.1
	};
	if ( CONFIG.denoPath !== null ) roomConfig.denoPath = CONFIG.denoPath;
	RoomManager_SetConfig( roomConfig );

	// Read TLS certificates
	const cert = await Deno.readTextFile( CONFIG.certFile );
	const key = await Deno.readTextFile( CONFIG.keyFile );

	// Create QUIC endpoints. Browsers may resolve localhost to ::1, so listen
	// on IPv6 as well as IPv4.
	const bound = QUIC_OpenEndpoints( CONFIG.port );
	quicEndpoints = bound.endpoints;

	const listeners = quicEndpoints.map( ( endpoint ) => endpoint.listen( {
		cert,
		key,
		alpnProtocols: [ 'h3' ],
	} ) );

	Sys_Printf( 'Lobby server listening on port %d on %s\n', CONFIG.port, bound.description );
	Sys_Printf( 'Rooms will spawn on ports %d-%d (up to %d rooms)\n\n', BASE_PORT, BASE_PORT + MAX_ROOMS - 1, MAX_ROOMS );

	if ( CONFIG.wsPort !== null ) await startWebSocketListener();

	// Start cleanup timer (every minute; rooms idle for 5 minutes are reaped)
	setInterval( () => {
		const unhealthy = RoomManager_CleanupUnhealthyRooms();
		if ( unhealthy > 0 ) {
			Sys_Printf( 'Cleaned up %d unhealthy rooms\n', unhealthy );
		}

		const cleaned = RoomManager_CleanupIdleRooms();
		if ( cleaned > 0 ) {
			Sys_Printf( 'Cleaned up %d idle rooms\n', cleaned );
		}
	}, 60 * 1000 );

	// Accept connections
	await Promise.all( listeners.map( ( listener ) => acceptConnections( listener ) ) );
}

function shutdown( reason, code ) {
	Sys_Printf( '%s, shutting down...\n', reason );
	RoomManager_ShutdownAll();
	if ( quicEndpoints !== null ) {
		const endpoints = quicEndpoints;
		quicEndpoints = null;
		QUIC_CloseEndpoints( endpoints );
	}
	if ( wsAbort !== null ) {
		wsAbort.abort();
		wsAbort = null;
	}
	Deno.exit( code );
}

/**
 * Main entry point
 */
async function main() {
	// Global unhandled rejection handler - prevent server crashes from async errors
	globalThis.addEventListener( 'unhandledrejection', ( event ) => {
		Sys_Printf( 'Unhandled promise rejection: %s\n', String( event.reason ) );
		event.preventDefault(); // Prevent default crash behavior
	} );

	parseArgs();

	// Kill room processes on shutdown. Room servers also exit by themselves
	// when the lobby dies (their stdin pipe closes), which covers SIGKILL
	// and crashes.
	for ( const signal of [ 'SIGINT', 'SIGTERM', 'SIGHUP' ] ) {
		try {
			Deno.addSignalListener( signal, () => shutdown( 'Received ' + signal, 0 ) );
		} catch { /* signal not supported on this platform */ }
	}

	try {
		await startServer();
	} catch ( error ) {
		console.error( 'Fatal error:', error );
		shutdown( 'Fatal error', 1 );
	}
}

if ( import.meta.main ) {
	main();
}
