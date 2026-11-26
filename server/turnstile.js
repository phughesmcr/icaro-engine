// Cloudflare Turnstile checks for lobby room creation, shared by the Deno
// lobby (server/lobby_server.js) and the Cloudflare lobby Worker
// (cloudflare/lobby/). New module, with no C counterpart.
//
// A lobby with a sitekey answers a room request that carries no token with
// LOBBY_VERIFY { sitekey, action }; the client shows the widget
// (src/turnstile.js) and sends the request again with the token in its
// `turnstile` field. The lobby redeems the token at Siteverify and goes on
// only if Cloudflare reports success for the expected action and for one of
// the page hostnames it serves. Tokens are single-use.
//
// Configuration (environment variables for Deno, vars and secrets for the
// Worker):
//   TURNSTILE_SITEKEY    public sitekey; unset or empty turns the check off
//   TURNSTILE_SECRET     the widget's secret; never commit it
//   TURNSTILE_HOSTNAMES  comma-separated page hostnames whose tokens count
// With a sitekey but no secret or no hostnames, every token is refused:
// the check fails closed rather than open.
//
// Nothing here touches Deno or Worker APIs, so both runtimes and the tests
// can use it; callers pass fetch.

export const TURNSTILE_SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
export const TURNSTILE_ACTION_CREATE_ROOM = 'create_room';
export const TURNSTILE_MAX_TOKEN_LENGTH = 2048;
export const TURNSTILE_TIMEOUT_MS = 10 * 1000;

/**
 * The check's settings from get( name ), which returns a variable's value
 * or undefined. Resolves to null (no check) when there is no sitekey.
 */
export function Turnstile_ConfigFrom( get ) {
	const read = ( name ) => {
		const value = get( name );
		return typeof value === 'string' ? value.trim() : '';
	};
	const sitekey = read( 'TURNSTILE_SITEKEY' );
	if ( sitekey === '' ) return null;
	const hostnames = new Set( read( 'TURNSTILE_HOSTNAMES' ).split( ',' ).map( ( h ) => h.trim().toLowerCase() ).filter( ( h ) => h !== '' ) );
	return { sitekey, secret: read( 'TURNSTILE_SECRET' ), hostnames };
}

/**
 * Check a room request's token. Resolves to null if the request may go on,
 * { challenge: { sitekey, action } } if it carried no token, or
 * { error: text } if the token was refused. Never rejects.
 */
export async function Turnstile_Check( config, token, ip, action, fetchFn ) {
	if ( config === null ) return null;
	if ( token === undefined || token === null || token === '' ) {
		return { challenge: { sitekey: config.sitekey, action } };
	}
	if ( await Turnstile_Verify( config, token, ip, action, fetchFn ) === true ) return null;
	return { error: 'Verification failed. Try again.' };
}

/**
 * Redeem token at Siteverify. True only if Cloudflare reports success for
 * `action` and for one of config.hostnames; any other answer, a network
 * error or a timeout is false.
 */
export async function Turnstile_Verify( config, token, ip, action, fetchFn ) {
	if ( typeof token !== 'string' || token.length === 0 || token.length > TURNSTILE_MAX_TOKEN_LENGTH ) return false;
	if ( config.secret === '' || config.hostnames.size === 0 ) return false;

	const body = new URLSearchParams( { secret: config.secret, response: token } );
	if ( typeof ip === 'string' && ip !== '' && ip !== 'unknown' ) body.set( 'remoteip', ip );

	let result;
	try {
		const response = await fetchFn( TURNSTILE_SITEVERIFY_URL, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body,
			signal: AbortSignal.timeout( TURNSTILE_TIMEOUT_MS ),
		} );
		if ( response.ok !== true ) return false;
		result = await response.json();
	} catch {
		return false;
	}

	return result !== null && typeof result === 'object' &&
		result.success === true &&
		result.action === action &&
		typeof result.hostname === 'string' &&
		config.hostnames.has( result.hostname.toLowerCase() );
}
