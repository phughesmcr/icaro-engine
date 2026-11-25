// Icaro Engine Lobby Server for Deno
// Lightweight server that only handles room management
// Spawns separate game server processes for each room
//
// Usage: see server/README.md ("Run the Lobby Server") for the scoped
// permission flags, or `deno task lobby` from the repository root.

import { Sys_Printf } from './sys_server.ts';
import { QUIC_CloseEndpoints, QUIC_OpenEndpoints } from './quic_listen.ts';
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
	RoomManager_SanitizeGameOptions,
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
	const parsed = {
		map,
		maxPlayers: config.maxPlayers == null ? undefined : RoomManager_ClampMaxPlayers( config.maxPlayers ),
		hostName: RoomManager_SanitizeHostName( config.hostName ),
	};
	// Game Options menu rows: whitelisted and clamped; absent when not sent
	const gameOptions = RoomManager_SanitizeGameOptions( config.options );
	if ( gameOptions !== undefined ) parsed.gameOptions = gameOptions;
	return parsed;
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

async function sendError( writer, message ) {
	await sendFramedMessage( writer, LOBBY_ERROR, new TextEncoder().encode( message ) );
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

async function sendRoomInfo( writer, room ) {
	const data = new TextEncoder().encode( JSON.stringify( roomInfoFor( room ) ) );
	await sendFramedMessage( writer, LOBBY_ROOMS, data );
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

		if ( msg.data.length > LIMITS.maxRequestBytes ) {
			Sys_Printf( 'Oversized lobby request (%d bytes) from %s\n', msg.data.length, address );
			await sendError( writer, 'Request too large' );
			msg = null;
		}

		switch ( msg?.type ) {
			case undefined:
				break;

			case LOBBY_LIST: {
				// Send room list
				const rooms = RoomManager_ListRooms();
				const data = new TextEncoder().encode( JSON.stringify( rooms ) );
				await sendFramedMessage( writer, LOBBY_ROOMS, data );
				Sys_Printf( 'LIST from %s: %d rooms\n', address, rooms.length );
				break;
			}

			case LOBBY_CREATE: {
				let config;
				try {
					config = parseCreateConfig( msg.data );
				} catch ( e ) {
					await sendError( writer, e.message );
					Sys_Printf( 'CREATE from %s rejected: %s\n', address, e.message );
					break;
				}

				const denied = checkCreateAllowed( ip );
				if ( denied !== null ) {
					await sendError( writer, denied );
					Sys_Printf( 'CREATE from %s rejected: %s\n', address, denied );
					break;
				}

				const result = await RoomManager_CreateRoom( { ...config, owner: ip } );
				const room = result === null ? null : RoomManager_GetRoom( result.id );
				if ( room === null ) {
					await sendError( writer, 'Unable to create room right now. Please try again.' );
					Sys_Printf( 'CREATE from %s failed\n', address );
				} else {
					await sendRoomInfo( writer, room );
					Sys_Printf( 'Room %s created on port %d for %s\n', room.id, room.port, address );
				}
				break;
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
					await sendError( writer, errorMsg );
					Sys_Printf( 'JOIN %s from %s failed: %s\n', JSON.stringify( roomId.slice( 0, 16 ) ), address, errorMsg );
				} else if ( room.playerCount >= room.maxPlayers ) {
					const fullMsg = 'Room is full (' + room.playerCount + '/' + room.maxPlayers + ' players)';
					await sendError( writer, fullMsg );
					Sys_Printf( 'JOIN %s from %s rejected: full (%d/%d)\n', roomId, address, room.playerCount, room.maxPlayers );
				} else {
					await sendRoomInfo( writer, room );
					Sys_Printf( 'JOIN %s from %s: port %d\n', room.id, address, room.port );
				}
				break;
			}

			default:
				Sys_Printf( 'Unknown lobby message type %d from %s\n', msg.type, address );
		}

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

// Concurrent session tracking (for LIMITS.maxSessions / maxSessionsPerIp)
let activeSessions = 0;
const activeSessionsByIp = new Map();

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

			const ipSessions = activeSessionsByIp.get( ip ) ?? 0;
			if ( activeSessions >= LIMITS.maxSessions || ipSessions >= LIMITS.maxSessionsPerIp ) {
				Sys_Printf( 'Rejecting lobby connection from %s: too many sessions (%d total, %d from this IP)\n', address, activeSessions, ipSessions );
				try { conn.close(); } catch { /* ignore */ }
				continue;
			}
			activeSessions++;
			activeSessionsByIp.set( ip, ipSessions + 1 );

			// Handle in background
			( async () => {
				try {
					const wt = await Deno.upgradeWebTransport( conn );
					await handleSession( wt, address, ip );
				} catch ( error ) {
					Sys_Printf( 'Connection error from %s: %s\n', address, error.message );
					try { conn.close(); } catch { /* ignore */ }
				} finally {
					activeSessions--;
					const n = ( activeSessionsByIp.get( ip ) ?? 1 ) - 1;
					if ( n <= 0 ) activeSessionsByIp.delete( ip );
					else activeSessionsByIp.set( ip, n );
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
