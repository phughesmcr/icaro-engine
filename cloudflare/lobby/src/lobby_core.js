// The lobby Durable Object's logic, without the Workers-only parts
// (worker.js holds those), so Deno tests can drive it with a fake ctx.
// The room table and the signal relay are server/lobby_rtc.js, which the
// Deno lobby shares. Design: docs/browser-hosted-rooms.md, "Signalling and
// the lobby".
//
// The object hibernates between messages and loses its memory, so each
// socket's session state lives in its attachment ({ sid, record }) and the
// constructor rebuilds the lobby from ctx.getWebSockets(). An alarm, set
// only while sockets are open, closes hosts that stopped sending heartbeats
// and joiners that ran out of time: webSocketClose doesn't always come when
// a connection drops.
//
// This lobby only knows rooms hosted in browsers. LOBBY_CREATE is refused,
// since nothing here can start a Deno room.

import {
	RtcLobby,
	LOBBY_LIST,
	LOBBY_CREATE,
	LOBBY_ROOMS,
	LOBBY_ERROR,
	Lobby_EncodeFrame,
	Lobby_DecodeFrame,
	Lobby_WantsRtcRooms,
} from '../../../server/lobby_rtc.js';

export const ALARM_INTERVAL_MS = 30 * 1000;

// TURN credentials outlive a game: a relay can't be refreshed once they
// expire. TURN_TTL_SECONDS overrides this.
export const TURN_TTL_SECONDS = 6 * 60 * 60;
const TURN_TIMEOUT_MS = 5000;

const _encoder = new TextEncoder();

export class LobbyCore {

	/**
	 * ctx and env as a Durable Object gets them. fetch is for TURN
	 * credentials (tests pass a fake); now is the clock.
	 */
	constructor( ctx, env, { fetch = ( ...args ) => globalThis.fetch( ...args ), now = () => Date.now() } = {} ) {
		this.ctx = ctx;
		this.env = env;
		this.fetch = fetch;
		this.now = now;
		this.lobby = new RtcLobby( { iceServers: ( ip, role ) => this.iceServers( ip, role ) } );
		this.sockets = new Map(); // session id -> WebSocket

		for ( const ws of ctx.getWebSockets() ) {
			const attachment = ws.deserializeAttachment();
			if ( attachment === null || typeof attachment !== 'object' || typeof attachment.sid !== 'string' ) continue;
			this.lobby.restore( attachment.sid, attachment.record );
			if ( this.lobby.sessions.has( attachment.sid ) ) this.sockets.set( attachment.sid, ws );
		}
	}

	/** True if client `ip` may open another lobby socket. */
	canAccept( ip ) {
		return this.lobby.canOpen( ip );
	}

	/** Take the server end of a new lobby socket. */
	async accept( ws, ip ) {
		const sid = 's' + crypto.randomUUID();
		this.ctx.acceptWebSocket( ws );
		this.lobby.open( sid, ip, this.now() );
		this.sockets.set( sid, ws );
		this._save( ws, sid );
		await this._ensureAlarm();
	}

	async message( ws, message ) {
		const sid = this._sid( ws );
		if ( sid === null ) {
			this._close( ws, 1011, 'Unknown session' );
			return;
		}
		const frame = typeof message === 'string' ? null : Lobby_DecodeFrame( new Uint8Array( message ) );
		if ( frame === null ) {
			this._end( sid, 1002, 'Malformed lobby frame' );
			return;
		}

		const now = this.now();
		// A host's or joiner's socket sends everything through handle(),
		// which rate limits it; LIST and CREATE belong to one-request sockets
		const longLived = this.lobby.isLongLived( sid );
		if ( frame.type === LOBBY_LIST && longLived === false ) {
			const rooms = Lobby_WantsRtcRooms( frame.data ) ? this.lobby.listRooms( now ) : [];
			this._send( sid, LOBBY_ROOMS, _encoder.encode( JSON.stringify( rooms ) ) );
		} else if ( frame.type === LOBBY_CREATE && longLived === false ) {
			this._send( sid, LOBBY_ERROR, _encoder.encode( 'This lobby can\'t start rooms. Host one in your browser instead.' ) );
		} else {
			const frames = await this.lobby.handle( sid, frame.type, frame.data, now );
			if ( frames === null ) {
				// LOBBY_JOIN for a code that isn't a browser-hosted room's,
				// or LIST or CREATE on a host's or joiner's socket
				const message = longLived ? 'Not available on this connection' : 'Room not found. The game may have ended.';
				this._send( sid, LOBBY_ERROR, _encoder.encode( message ) );
			} else {
				for ( const out of frames ) this._send( out.to, out.type, out.data );
			}
		}

		if ( this.lobby.sessions.has( sid ) === false ) return;
		if ( this.lobby.isLongLived( sid ) ) {
			this._save( ws, sid );
			await this._ensureAlarm();
		} else {
			// One request per socket, as the Deno lobby does
			this._end( sid, 1000, '' );
		}
	}

	/** webSocketClose and webSocketError. */
	closed( ws, code ) {
		const sid = this._sid( ws );
		if ( sid !== null ) {
			this.lobby.close( sid );
			this.sockets.delete( sid );
		}
		// 1005 and 1006 are not codes a close() may send
		this._close( ws, code === 1005 || code === 1006 || code === undefined ? 1000 : code, '' );
	}

	async alarm() {
		for ( const sid of this.lobby.prune( this.now() ) ) {
			const ws = this.sockets.get( sid );
			this.sockets.delete( sid );
			if ( ws !== undefined ) this._close( ws, 1000, 'Timed out' );
		}
		if ( this.lobby.sessions.size > 0 ) await this.ctx.storage.setAlarm( this.now() + ALARM_INTERVAL_MS );
	}

	/**
	 * ICE servers for a client that has just hosted or joined: Cloudflare
	 * TURN credentials when TURN_KEY_ID and TURN_KEY_API_TOKEN are set (as
	 * secrets), else STUN only (lobby_rtc.js falls back to it on any
	 * failure). The lobby only asks after a LOBBY_HOST or LOBBY_JOIN passes
	 * its limits, so a client can't mint credentials by connecting alone.
	 */
	async iceServers( _ip, _role ) {
		const keyId = this.env.TURN_KEY_ID;
		const token = this.env.TURN_KEY_API_TOKEN;
		if ( typeof keyId !== 'string' || keyId === '' || typeof token !== 'string' || token === '' ) return [];

		const ttl = Number.parseInt( this.env.TURN_TTL_SECONDS ?? '', 10 );
		const response = await this.fetch(
			'https://rtc.live.cloudflare.com/v1/turn/keys/' + encodeURIComponent( keyId ) + '/credentials/generate-ice-servers',
			{
				method: 'POST',
				headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
				body: JSON.stringify( { ttl: Number.isInteger( ttl ) && ttl > 0 ? ttl : TURN_TTL_SECONDS } ),
				signal: AbortSignal.timeout( TURN_TIMEOUT_MS ),
			},
		);
		if ( response.ok === false ) throw new Error( 'TURN credentials: HTTP ' + response.status );
		const body = await response.json();
		return body !== null && typeof body === 'object' ? body.iceServers : [];
	}

	_sid( ws ) {
		const attachment = ws.deserializeAttachment();
		if ( attachment === null || typeof attachment !== 'object' || typeof attachment.sid !== 'string' ) return null;
		if ( this.lobby.sessions.has( attachment.sid ) === false ) return null;
		// The handler's ws is the one to send on, whichever object
		// getWebSockets() gave the constructor
		this.sockets.set( attachment.sid, ws );
		return attachment.sid;
	}

	_save( ws, sid ) {
		ws.serializeAttachment( { sid, record: this.lobby.record( sid ) } );
	}

	_send( sid, type, data ) {
		const ws = this.sockets.get( sid );
		if ( ws === undefined ) return;
		try {
			ws.send( Lobby_EncodeFrame( type, data ) );
		} catch { /* closing */ }
	}

	_end( sid, code, reason ) {
		const ws = this.sockets.get( sid );
		this.lobby.close( sid );
		this.sockets.delete( sid );
		if ( ws !== undefined ) this._close( ws, code, reason );
	}

	_close( ws, code, reason ) {
		try {
			ws.close( code, reason );
		} catch { /* already closed */ }
	}

	async _ensureAlarm() {
		if ( this.lobby.sessions.size === 0 ) return;
		if ( await this.ctx.storage.getAlarm() === null ) await this.ctx.storage.setAlarm( this.now() + ALARM_INTERVAL_MS );
	}

}
