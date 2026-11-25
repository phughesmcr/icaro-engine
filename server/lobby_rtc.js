// Lobby for browser-hosted rooms: the state machine shared by the Deno lobby
// (server/lobby_server.js) and the Cloudflare lobby Worker
// (cloudflare/lobby/). The design is docs/browser-hosted-rooms.md,
// "Signalling and the lobby". New module, with no C counterpart.
//
// A browser tab hosts a room by sending LOBBY_HOST on a lobby socket it keeps
// open; the room lasts as long as that socket and its heartbeats. A joiner
// sends LOBBY_JOIN with the room code and keeps its socket open while it
// connects. Both then trade WebRTC offers, answers and ICE candidates through
// LOBBY_SIGNAL, which the lobby relays without reading the SDP. The lobby
// sets `from` on every relayed signal, and only relays a joiner's signals to
// the room it joined and a host's signals to peers that joined its room.
//
// Nothing here uses Deno, Worker or socket APIs, and nothing keeps a timer:
// the caller passes `now`, sends the frames each call returns, and calls
// prune() now and then. A Durable Object loses its memory when it
// hibernates, so each session's state is a plain record (record()) that the
// caller can store with its socket and hand back to restore().
//
// Frames are [type u8][len u16le][payload], as in server/lobby_server.js.
// JSON payloads:
//   LOBBY_HOST       { map, maxPlayers, hostName, options, public }
//   LOBBY_HEARTBEAT  { players }                 host only, every 30 s
//   LOBBY_SIGNAL     { to, kind, data }          kind: offer | answer | candidate
//   LOBBY_LIST       { rtc: true }               to list public rooms hosted in
//                                                browsers; an empty LIST doesn't
//   LOBBY_JOIN       the room code as text
// Replies:
//   LOBBY_ROOMS          the room record, after LOBBY_HOST or LOBBY_JOIN
//   LOBBY_ICE            RTCIceServer[] for this client, after LOBBY_ROOMS
//   LOBBY_SIGNAL_RELAY   { from, kind, data }
//   LOBBY_ERROR          text
// A joiner sees signals from the room under the code it addressed them to; a
// host sees each joiner under a peer id the lobby made up.

import {
	DEFAULT_MAP,
	Room_ClampMaxPlayers,
	Room_SanitizeGameOptions,
	Room_SanitizeHostName,
	Room_SanitizeMapName,
} from './room_config.js';

export const LOBBY_LIST = 0x01;
export const LOBBY_JOIN = 0x02;
export const LOBBY_CREATE = 0x03;
export const LOBBY_HOST = 0x04;
export const LOBBY_SIGNAL = 0x05;
export const LOBBY_HEARTBEAT = 0x06;
export const LOBBY_ROOMS = 0x81;
export const LOBBY_ERROR = 0x82;
export const LOBBY_ICE = 0x84;
export const LOBBY_SIGNAL_RELAY = 0x85;

export const MAX_FRAME_PAYLOAD = 0xffff;

// Codes of rooms hosted in browsers: 8 characters, without the easily
// confused 0, O, 1 and I. Lobby rooms run by Deno have 6-character codes,
// so the two never collide, and a code from a browser room that has ended
// doesn't make the Deno lobby start a room under it (its JOIN re-creates
// unknown 6-character codes). A private room's code is all that keeps it
// private: 32^8 is about 10^12.
export const RTC_ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const RTC_ROOM_CODE_LENGTH = 8;
export const RTC_ROOM_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{8}$/;

// STUN only: what a lobby without TURN credentials gives its clients
export const RTC_DEFAULT_ICE_SERVERS = [ { urls: [ 'stun:stun.cloudflare.com:3478' ] } ];

export const RTC_LOBBY_LIMITS = {
	maxSessions: 1000,                // Open lobby sockets, all clients
	maxSessionsPerIp: 16,             // Open lobby sockets per client IP
	maxRooms: 500,                    // Browser-hosted rooms, all clients
	maxHostsPerIp: 2,                 // Rooms hosted from one client IP
	maxJoinersPerIp: 8,               // Joiners still signalling, per client IP
	hostsPerIpPerWindow: 5,           // LOBBY_HOST per IP per window
	hostWindowMs: 60 * 1000,
	joinMissesPerIpPerWindow: 20,     // JOINs for unknown room codes per IP per window
	joinMissWindowMs: 60 * 1000,
	messagesPerSessionPerWindow: 400, // Signals and heartbeats per socket per window
	messageWindowMs: 10 * 1000,
	maxRequestBytes: 4096,            // Any request but LOBBY_SIGNAL
	maxSignalBytes: 16 * 1024,        // LOBBY_SIGNAL (an offer's SDP)
	heartbeatTimeoutMs: 90 * 1000,    // A host silent this long has gone
	joinerLifetimeMs: 2 * 60 * 1000,  // A joiner has this long to connect
	requestTimeoutMs: 10 * 1000,      // A socket that hasn't hosted or joined
};

const SIGNAL_KINDS = new Set( [ 'offer', 'answer', 'candidate' ] );
const PEER_ID_PATTERN = /^p[A-HJ-NP-Z2-9]{12}$/;

const _encoder = new TextEncoder();
const _decoder = new TextDecoder();

/**
 * [type u8][len u16le][payload]. Throws if the payload is too large.
 */
export function Lobby_EncodeFrame( type, data ) {
	if ( data.length > MAX_FRAME_PAYLOAD ) throw new Error( 'Lobby frame too large' );
	const frame = new Uint8Array( 3 + data.length );
	frame[ 0 ] = type;
	frame[ 1 ] = data.length & 0xff;
	frame[ 2 ] = ( data.length >> 8 ) & 0xff;
	frame.set( data, 3 );
	return frame;
}

/**
 * One whole frame (one WebSocket message) as { type, data }, or null if
 * malformed.
 */
export function Lobby_DecodeFrame( bytes ) {
	if ( !( bytes instanceof Uint8Array ) || bytes.length < 3 ) return null;
	const length = bytes[ 1 ] | ( bytes[ 2 ] << 8 );
	if ( bytes.length !== 3 + length ) return null;
	return { type: bytes[ 0 ], data: bytes.subarray( 3 ) };
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

/**
 * True if a LOBBY_LIST payload asks for rooms hosted in browsers too. Older
 * clients send an empty LIST and would try to reach a listed room on a port.
 */
export function Lobby_WantsRtcRooms( data ) {
	if ( data.length === 0 ) return false;
	const request = _parseJson( data );
	return request !== null && request.rtc === true;
}

/**
 * Keep the iceServers entries a browser can use: Cloudflare's TURN service
 * also offers port 53, which browsers block, so a TURN URL on it only times
 * out (developers.cloudflare.com/realtime/turn/generate-credentials/).
 */
export function Lobby_FilterIceServers( servers ) {
	if ( Array.isArray( servers ) === false ) return [];
	const out = [];
	for ( const server of servers ) {
		if ( server === null || typeof server !== 'object' ) continue;
		const list = Array.isArray( server.urls ) ? server.urls : typeof server.urls === 'string' ? [ server.urls ] : [];
		const urls = list.filter( ( url ) => typeof url === 'string' && /:53(\?|$)/.test( url ) === false );
		if ( urls.length === 0 ) continue;
		const entry = { urls };
		if ( typeof server.username === 'string' ) entry.username = server.username;
		if ( typeof server.credential === 'string' ) entry.credential = server.credential;
		out.push( entry );
	}
	return out;
}

function _parseJson( data ) {
	try {
		const value = JSON.parse( _decoder.decode( data ) );
		return value !== null && typeof value === 'object' && Array.isArray( value ) === false ? value : null;
	} catch {
		return null;
	}
}

function _frame( to, type, value ) {
	const data = typeof value === 'string' ? _encoder.encode( value ) : _encoder.encode( JSON.stringify( value ) );
	return { to, type, data };
}

function _error( to, message ) {
	return _frame( to, LOBBY_ERROR, message );
}

function _roomRecord( room ) {
	const record = {
		id: room.id,
		transport: 'rtc',
		map: room.map,
		maxPlayers: room.maxPlayers,
		players: room.players,
		hostName: room.hostName,
		public: room.public,
	};
	if ( room.options !== undefined ) record.options = room.options;
	return record;
}

export class RtcLobby {

	/**
	 * iceServers( ip, role ): RTCIceServer[] (or a Promise of one) for a
	 * client that has just hosted or joined. isCodeTaken( code ): true if the
	 * caller already uses a room code. randomBytes( n ): n random bytes.
	 */
	constructor( {
		iceServers = () => RTC_DEFAULT_ICE_SERVERS,
		isCodeTaken = () => false,
		randomBytes = ( n ) => crypto.getRandomValues( new Uint8Array( n ) ),
		limits = RTC_LOBBY_LIMITS,
	} = {} ) {
		this.iceServers = iceServers;
		this.isCodeTaken = isCodeTaken;
		this.randomBytes = randomBytes;
		this.limits = limits;
		this.sessions = new Map(); // session id -> session
		this.rooms = new Map();    // room code -> host session
		this.peers = new Map();    // peer id -> joiner session
		this.hostLimiter = createRateLimiter( limits.hostsPerIpPerWindow, limits.hostWindowMs );
		this.joinMissLimiter = createRateLimiter( limits.joinMissesPerIpPerWindow, limits.joinMissWindowMs );
		this.messageLimiter = createRateLimiter( limits.messagesPerSessionPerWindow, limits.messageWindowMs );
	}

	/** True if client `ip` may open another lobby socket. */
	canOpen( ip ) {
		if ( this.sessions.size >= this.limits.maxSessions ) return false;
		return this._count( ( s ) => s.ip === ip ) < this.limits.maxSessionsPerIp;
	}

	/** A new lobby socket. */
	open( sid, ip, now ) {
		this.sessions.set( sid, { sid, ip, role: null, openedAt: now, room: null, joined: null, peerId: null, alias: null } );
	}

	/**
	 * Bring back a session from its record(), after the caller lost this
	 * object's memory (a Durable Object waking from hibernation).
	 */
	restore( sid, record ) {
		if ( record === null || typeof record !== 'object' || typeof record.ip !== 'string' ) return;
		const session = {
			sid,
			ip: record.ip,
			role: record.role === 'host' || record.role === 'joiner' ? record.role : null,
			openedAt: Number.isFinite( record.openedAt ) ? record.openedAt : 0,
			room: null,
			joined: null,
			peerId: null,
			alias: null,
		};
		if ( session.role === 'host' && record.room !== null && typeof record.room === 'object' &&
			RTC_ROOM_CODE_PATTERN.test( record.room.id ) && this.rooms.has( record.room.id ) === false ) {
			session.room = { ...record.room };
			this.rooms.set( session.room.id, session );
		} else if ( session.role === 'joiner' && RTC_ROOM_CODE_PATTERN.test( record.joined ) &&
			PEER_ID_PATTERN.test( record.peerId ) && this.peers.has( record.peerId ) === false ) {
			session.joined = record.joined;
			session.peerId = record.peerId;
			session.alias = typeof record.alias === 'string' ? record.alias : record.joined;
			this.peers.set( session.peerId, session );
		} else {
			session.role = null;
		}
		this.sessions.set( sid, session );
	}

	/** What restore() needs for session `sid`: a plain object, or null. */
	record( sid ) {
		const s = this.sessions.get( sid );
		if ( s === undefined ) return null;
		return {
			ip: s.ip,
			role: s.role,
			openedAt: s.openedAt,
			room: s.room === null ? null : { ...s.room },
			joined: s.joined,
			peerId: s.peerId,
			alias: s.alias,
		};
	}

	/** The socket closed: a host's room ends, a joiner stops signalling. */
	close( sid ) {
		const s = this.sessions.get( sid );
		if ( s === undefined ) return;
		this.sessions.delete( sid );
		if ( s.room !== null && this.rooms.get( s.room.id ) === s ) this.rooms.delete( s.room.id );
		if ( s.peerId !== null && this.peers.get( s.peerId ) === s ) this.peers.delete( s.peerId );
	}

	/** True once session `sid` hosts or has joined a room: keep its socket open. */
	isLongLived( sid ) {
		const s = this.sessions.get( sid );
		return s !== undefined && s.role !== null;
	}

	/** True if a browser-hosted room has this code. */
	hasRoom( code ) {
		return this.rooms.has( code );
	}

	/** The largest request payload accepted for this request type. */
	maxRequestBytes( type ) {
		return type === LOBBY_SIGNAL ? this.limits.maxSignalBytes : this.limits.maxRequestBytes;
	}

	/**
	 * Drop hosts whose heartbeat is too old, joiners that have had their
	 * time, and sockets that never hosted or joined. Returns their session
	 * ids: the caller closes those sockets.
	 */
	prune( now ) {
		const gone = [];
		for ( const s of this.sessions.values() ) {
			const stale = s.role === 'host' ? now - s.room.lastHeartbeat > this.limits.heartbeatTimeoutMs
				: s.role === 'joiner' ? now - s.openedAt > this.limits.joinerLifetimeMs
				: now - s.openedAt > this.limits.requestTimeoutMs;
			if ( stale ) gone.push( s.sid );
		}
		for ( const sid of gone ) this.close( sid );
		return gone;
	}

	/** Public rooms hosted in browsers, as LOBBY_LIST shows them. */
	listRooms( now ) {
		this.prune( now );
		const rooms = [];
		for ( const host of this.rooms.values() ) {
			if ( host.room.public === true ) rooms.push( _roomRecord( host.room ) );
		}
		return rooms;
	}

	/**
	 * One request on session `sid`. Resolves to the frames to send, each
	 * { to: session id, type, data }, or null if the request isn't one this
	 * lobby handles (LOBBY_LIST, LOBBY_CREATE, and LOBBY_JOIN for a code that
	 * isn't a browser-hosted room's): the caller answers those itself.
	 */
	async handle( sid, type, data, now ) {
		const s = this.sessions.get( sid );
		if ( s === undefined ) return [];
		if ( data.length > this.maxRequestBytes( type ) ) return [ _error( sid, 'Request too large' ) ];

		switch ( type ) {
			case LOBBY_HOST:
				return await this._host( s, data, now );
			case LOBBY_JOIN:
				return await this._join( s, data, now );
			case LOBBY_SIGNAL:
				return this._signal( s, data, now );
			case LOBBY_HEARTBEAT:
				return this._heartbeat( s, data, now );
			default:
				return null;
		}
	}

	_count( predicate ) {
		let n = 0;
		for ( const s of this.sessions.values() ) if ( predicate( s ) ) n++;
		return n;
	}

	_randomCode( length, alphabet ) {
		const bytes = this.randomBytes( length );
		let code = '';
		// 256 is a multiple of 32, so this has no modulo bias
		for ( let i = 0; i < length; i++ ) code += alphabet[ bytes[ i ] % alphabet.length ];
		return code;
	}

	_newRoomCode() {
		for ( let attempt = 0; attempt < 10; attempt++ ) {
			const code = this._randomCode( RTC_ROOM_CODE_LENGTH, RTC_ROOM_CODE_ALPHABET );
			if ( this.rooms.has( code ) === false && this.isCodeTaken( code ) !== true ) return code;
		}
		return null;
	}

	_newPeerId() {
		for ( let attempt = 0; attempt < 10; attempt++ ) {
			const id = 'p' + this._randomCode( 12, RTC_ROOM_CODE_ALPHABET );
			if ( this.peers.has( id ) === false ) return id;
		}
		return null;
	}

	async _iceFrame( s, role ) {
		let servers;
		try {
			servers = Lobby_FilterIceServers( await this.iceServers( s.ip, role ) );
		} catch {
			servers = [];
		}
		if ( servers.length === 0 ) servers = RTC_DEFAULT_ICE_SERVERS;
		return _frame( s.sid, LOBBY_ICE, servers );
	}

	async _host( s, data, now ) {
		if ( s.role !== null ) return [ _error( s.sid, 'This connection already has a room' ) ];
		this.prune( now );
		const config = _parseJson( data );
		if ( config === null ) return [ _error( s.sid, 'Invalid room config' ) ];

		let map = DEFAULT_MAP;
		if ( config.map != null && config.map !== '' ) {
			map = Room_SanitizeMapName( config.map );
			if ( map === null ) return [ _error( s.sid, 'Invalid map name' ) ];
		}

		if ( this.rooms.size >= this.limits.maxRooms ) {
			return [ _error( s.sid, 'Room limit reached (' + this.limits.maxRooms + ' rooms). Try again later.' ) ];
		}
		if ( this._count( ( o ) => o.ip === s.ip && o.role === 'host' ) >= this.limits.maxHostsPerIp ) {
			return [ _error( s.sid, 'You already host ' + this.limits.maxHostsPerIp + ' rooms. Close one first.' ) ];
		}
		if ( this.hostLimiter.tryTake( s.ip, now ) === false ) {
			return [ _error( s.sid, 'Too many rooms created. Wait a minute and try again.' ) ];
		}
		const code = this._newRoomCode();
		if ( code === null ) return [ _error( s.sid, 'Unable to create room right now. Please try again.' ) ];

		const room = {
			id: code,
			map,
			maxPlayers: Room_ClampMaxPlayers( config.maxPlayers ),
			players: 1,
			hostName: Room_SanitizeHostName( config.hostName ),
			public: config.public === true,
			lastHeartbeat: now,
		};
		const options = Room_SanitizeGameOptions( config.options );
		if ( options !== undefined ) room.options = options;

		s.role = 'host';
		s.room = room;
		this.rooms.set( code, s );
		return [ _frame( s.sid, LOBBY_ROOMS, _roomRecord( room ) ), await this._iceFrame( s, 'host' ) ];
	}

	async _join( s, data, now ) {
		const text = _decoder.decode( data ).trim();
		const code = text.toUpperCase();
		if ( RTC_ROOM_CODE_PATTERN.test( code ) === false ) return null;

		if ( this.joinMissLimiter.canTake( s.ip, now ) === false ) {
			return [ _error( s.sid, 'Too many attempts. Wait a minute and try again.' ) ];
		}
		this.prune( now );
		const host = this.rooms.get( code );
		if ( host === undefined ) {
			this.joinMissLimiter.tryTake( s.ip, now );
			return [ _error( s.sid, 'Room not found. The game may have ended.' ) ];
		}
		if ( s.role !== null ) return [ _error( s.sid, 'This connection already has a room' ) ];
		if ( host.room.players >= host.room.maxPlayers ) {
			return [ _error( s.sid, 'Room is full (' + host.room.players + '/' + host.room.maxPlayers + ' players)' ) ];
		}
		if ( this._count( ( o ) => o.ip === s.ip && o.role === 'joiner' ) >= this.limits.maxJoinersPerIp ) {
			return [ _error( s.sid, 'Too many joins in progress. Try again shortly.' ) ];
		}
		const peerId = this._newPeerId();
		if ( peerId === null ) return [ _error( s.sid, 'Unable to join right now. Please try again.' ) ];

		s.role = 'joiner';
		s.joined = code;
		s.peerId = peerId;
		s.alias = text;
		s.openedAt = now; // joinerLifetimeMs counts from the join
		this.peers.set( peerId, s );
		return [ _frame( s.sid, LOBBY_ROOMS, _roomRecord( host.room ) ), await this._iceFrame( s, 'joiner' ) ];
	}

	_signal( s, data, now ) {
		if ( s.role === null ) return [ _error( s.sid, 'Host or join a room first' ) ];
		if ( this.messageLimiter.tryTake( s.sid, now ) === false ) return [];
		const signal = _parseJson( data );
		if ( signal === null || typeof signal.to !== 'string' || SIGNAL_KINDS.has( signal.kind ) === false ) return [];
		const payload = signal.data === undefined ? null : signal.data;

		if ( s.role === 'joiner' ) {
			if ( signal.to.toUpperCase() !== s.joined ) return [];
			const host = this.rooms.get( s.joined );
			if ( host === undefined ) return [ _error( s.sid, 'Room not found. The game may have ended.' ) ];
			// The joiner's driver matches replies against the code it used
			s.alias = signal.to;
			return [ _frame( host.sid, LOBBY_SIGNAL_RELAY, { from: s.peerId, kind: signal.kind, data: payload } ) ];
		}

		const joiner = this.peers.get( signal.to );
		if ( joiner === undefined || joiner.joined !== s.room.id ) return [];
		return [ _frame( joiner.sid, LOBBY_SIGNAL_RELAY, { from: joiner.alias, kind: signal.kind, data: payload } ) ];
	}

	_heartbeat( s, data, now ) {
		if ( s.role !== 'host' ) return [];
		if ( this.messageLimiter.tryTake( s.sid, now ) === false ) return [];
		const beat = _parseJson( data );
		s.room.lastHeartbeat = now;
		if ( beat !== null && typeof beat.players === 'number' && Number.isFinite( beat.players ) ) {
			s.room.players = Math.max( 0, Math.min( s.room.maxPlayers, Math.trunc( beat.players ) ) ) + 0;
		}
		return [];
	}

}
