// Ported from: WinQuake/sys.h + sys_win.c -- system interface (browser)

/*
===============================================================================

SYSTEM IO

===============================================================================
*/

export function Sys_Init() {

	console.log( 'Icaro Engine initializing...' );

}

export function Sys_Error( error ) {

	console.error( 'Sys_Error: ' + error );

	// Display error on screen (browser only)
	if ( typeof document !== 'undefined' ) {

		document.body.innerHTML = '<pre style="color:red;padding:20px;font-size:16px;">Sys_Error: ' + error + '</pre>';

	}

	throw new Error( error );

}

/*
===============================================================================

LOBBY ADDRESS (web only, no C counterpart)

The page's ?server= parameter names the multiplayer lobby. It comes from a
link anyone can craft, and the menus and the auto-join turn it into a
`connect "..."` line for the command buffer, so it is checked here: a `"`
would end the quoted argument, and a `;` or newline would start a new
command.

===============================================================================
*/

export const SYS_DEFAULT_LOBBY = 'https://localhost:4433';

// A hostname after URL parsing (lowercase, IDN as punycode), or an IPv6 literal.
const _lobbyHostPattern = /^(?:[a-z0-9-]+\.)*[a-z0-9-]+$|^\[[0-9a-f:.]+\]$/;
// Anything that could end a quoted argument or a command line.
const _unsafeCommandChars = /["';\\\s\p{Cc}]/u;

/*
================
Sys_ParseLobbyURL

Returns raw as 'https://host[:port]' if it names a lobby: an https://, wts://
or wt:// URL (or a bare host[:port]) with no user info, path, query or
fragment. Returns null for anything else.
================
*/
export function Sys_ParseLobbyURL( raw ) {

	if ( typeof raw !== 'string' || raw.length === 0 || _unsafeCommandChars.test( raw ) )
		return null;

	let url = raw;
	const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec( url );
	if ( scheme === null )
		url = 'https://' + url;
	else if ( /^(?:https|wts?)$/i.test( scheme[ 1 ] ) )
		url = 'https://' + url.substring( scheme[ 0 ].length );
	else
		return null;

	let u;
	try {

		u = new URL( url );

	} catch {

		return null;

	}

	if ( u.protocol !== 'https:' || u.username !== '' || u.password !== '' )
		return null;
	if ( u.pathname !== '/' || u.search !== '' || u.hash !== '' )
		return null;
	if ( _lobbyHostPattern.test( u.hostname ) === false )
		return null;

	return 'https://' + u.host;

}

/*
================
Sys_LobbyURL

The lobby named by the page's ?server= parameter, as 'https://host[:port]'.
SYS_DEFAULT_LOBBY when there is none, and null when it is not a valid lobby
address (callers refuse to connect rather than fall back to localhost).
================
*/
export function Sys_LobbyURL() {

	const server = new URLSearchParams( globalThis.location.search ).get( 'server' );
	if ( server === null || server === '' )
		return SYS_DEFAULT_LOBBY;
	return Sys_ParseLobbyURL( server );

}

/*
================
Sys_ConnectURL

The argument for a `connect` command: 'wts://host[:port]' for lobby (a
Sys_LobbyURL result), with the port replaced by port when it is not null and
'?room=<id>' added when roomId is not null. The room id is percent-encoded.
Returns null if lobby or port is invalid, so the caller never quotes an
unchecked string into the command buffer.
================
*/
export function Sys_ConnectURL( lobby, roomId, port ) {

	const host = Sys_ParseLobbyURL( lobby );
	if ( host === null )
		return null;

	const u = new URL( host );
	if ( port !== null ) {

		if ( Number.isInteger( port ) === false || port < 1 || port > 65535 )
			return null;
		u.port = String( port );

	}

	let connectUrl = 'wts://' + u.host;
	if ( roomId !== null ) {

		const params = new URLSearchParams();
		params.set( 'room', String( roomId ) );
		connectUrl += '?' + params.toString();

	}

	// URLSearchParams percent-encodes every character that matters here; this
	// is a last check that nothing can end the quoted argument.
	if ( _unsafeCommandChars.test( connectUrl ) )
		return null;
	return connectUrl;

}

/*
================
Sys_PageURL

The page URL to put in the address bar: room= when roomId is given, and
game= and server= kept from the current URL, since whoever opens a shared
link needs the same mission pack and lobby. server= is kept only when it is a
valid lobby address. Other parameters are dropped.
================
*/
export function Sys_PageURL( roomId ) {

	const params = new URLSearchParams();
	if ( roomId ) params.set( 'room', roomId );
	const current = new URLSearchParams( globalThis.location.search );
	const game = current.get( 'game' );
	if ( game !== null ) params.set( 'game', game );
	const server = current.get( 'server' );
	if ( server !== null && Sys_ParseLobbyURL( server ) !== null ) params.set( 'server', server );
	const query = params.toString();
	return globalThis.location.origin + globalThis.location.pathname + ( query.length > 0 ? '?' + query : '' );

}

const _quietLogAllowPatterns = [
	/^Connection from /,
	/^Connection closed:/,
	/^Client .*(connected|removed)\b/,
	/^Spawning server for map:/,
	/^SpawnServer:/,
	/^Server initialized!/,
	/^Room .* idle for /,
	/^Host_ServerFrame error:/,
	/^SV_ReadClientMessage:/,
	/^Unhandled promise rejection:/,
	/^WebTransport server listening /,
	/^WebTransport server driver initialized/,
	/^NET_Init complete/,
	/^\[Heartbeat\]/,
	/^Host_Error/,
	/^Room .* (shutting down|exiting)/
];

function _isDenoRuntime() {

	return typeof Deno !== 'undefined' && Deno.version != null;

}

function _formatPrintf( fmt, args ) {

	if ( args.length === 0 ) return String( fmt );

	let result = String( fmt );
	let index = 0;
	result = result.replace( /%[sdif]/g, () => {

		if ( index >= args.length ) return '';
		return String( args[ index ++ ] );

	} );

	if ( index < args.length ) {

		result += ' ' + args.slice( index ).map( String ).join( ' ' );

	}

	return result;

}

function _shouldPrintLine( line ) {

	if ( _isDenoRuntime() !== true ) return true;

	const quietLogs = globalThis.__ICARO_QUIET_LOGS === true;
	if ( quietLogs !== true ) return true;

	const trimmed = line.trim();
	if ( trimmed.length === 0 ) return false;

	for ( const pattern of _quietLogAllowPatterns ) {

		if ( pattern.test( trimmed ) ) return true;

	}

	return false;

}

export function Sys_Printf( fmt, ...args ) {

	const line = _formatPrintf( fmt, args );
	if ( _shouldPrintLine( line ) !== true ) return;
	console.log( line );

}

export function Sys_Quit() {

	console.log( 'Sys_Quit' );

}

export function Sys_FloatTime() {

	return performance.now() / 1000.0;

}

export function Sys_DoubleTime() {

	return performance.now() / 1000.0;

}
