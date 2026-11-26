// Test helper: a connection to server/agent_mcp.ts over in-memory stdio
// streams, speaking raw JSON-RPC lines, so the tests see the SDK's real
// framing and replies.

import { PassThrough } from 'node:stream';
import { agent_mcp_serve } from '../server/agent_mcp.ts';

export const MODERN_VERSION = '2026-07-28';

// The _meta envelope a 2026-07-28 request carries
export const MODERN_META = {
	'io.modelcontextprotocol/protocolVersion': MODERN_VERSION,
	'io.modelcontextprotocol/clientCapabilities': {},
	'io.modelcontextprotocol/clientInfo': { name: 'icaro-test', version: '1' },
};

export function mcp_connect() {

	const input = new PassThrough();
	const output = new PassThrough();
	const handle = agent_mcp_serve( input, output );
	const waiting = new Map();
	const unmatched = [];
	let buf = '';
	let next_id = 1;
	output.setEncoding( 'utf8' );
	output.on( 'data', ( chunk ) => {

		buf += chunk;
		let nl;
		while ( ( nl = buf.indexOf( '\n' ) ) >= 0 ) {

			const msg = JSON.parse( buf.slice( 0, nl ) );
			buf = buf.slice( nl + 1 );
			const resolve = waiting.get( msg.id );
			if ( resolve !== undefined ) {

				waiting.delete( msg.id );
				resolve( msg );

			} else {

				unmatched.push( msg );

			}

		}

	} );

	return {
		unmatched,
		write( text ) {

			input.write( text );

		},
		notify( method, params ) {

			input.write( JSON.stringify( { jsonrpc: '2.0', method, params } ) + '\n' );

		},
		// Resolves with the whole response (result or error)
		request( method, params, id = next_id ++ ) {

			return new Promise( ( resolve ) => {

				waiting.set( id, resolve );
				input.write( JSON.stringify( { jsonrpc: '2.0', id, method, params } ) + '\n' );

			} );

		},
		close() {

			input.end();
			return handle.close();

		},
	};

}

// A connection opened with the initialize handshake, and tool call helpers
export async function mcp_session() {

	const c = mcp_connect();
	const init = await c.request( 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'icaro-test', version: '1' } } );
	if ( init.result === undefined )
		throw new Error( 'initialize: ' + JSON.stringify( init ) );
	c.notify( 'notifications/initialized' );

	// The tools/call result: { content, isError? }
	async function raw( name, args = {} ) {

		const r = await c.request( 'tools/call', { name, arguments: args } );
		if ( r.result === undefined )
			throw new Error( name + ': ' + JSON.stringify( r ) );
		return r.result;

	}

	// The result's text; a tool error throws
	async function call( name, args = {} ) {

		const r = await raw( name, args );
		if ( r.isError === true )
			throw new Error( name + ' failed: ' + r.content[ 0 ].text );
		return r.content[ 0 ].text;

	}

	return { ...c, init: init.result, raw, call };

}
