// _movevars carries edgefriction and sv_maxvelocity as args 11 and 12, and
// SV_CheckMovevars re-sends it when either changes.

import { sizebuf_t, SZ_Clear } from '../src/common.js';
import { svc_stufftext } from '../src/protocol.js';
import { sv } from '../src/server.js';
import { sv_edgefriction, sv_maxvelocity } from '../src/sv_phys.js';
import { SV_WriteMovevars, SV_CheckMovevars } from '../src/sv_main.js';

function assert( cond, message ) {

	if ( ! cond )
		throw new Error( message );

}

function stufftextOf( msg ) {

	assert( msg.cursize > 0 && msg.data[ 0 ] === svc_stufftext, 'expected a stufftext' );
	return new TextDecoder().decode( msg.data.subarray( 1, msg.cursize - 1 ) );

}

Deno.test( 'SV_WriteMovevars sends edgefriction and sv_maxvelocity as args 11 and 12', () => {

	const oldEdge = sv_edgefriction.value;
	const oldMaxvel = sv_maxvelocity.value;
	try {

		sv_edgefriction.value = 3;
		sv_maxvelocity.value = 1500;
		const msg = new sizebuf_t();
		msg.data = new Uint8Array( 256 );
		msg.maxsize = 256;
		SV_WriteMovevars( msg );
		const args = stufftextOf( msg ).trim().split( ' ' );
		assert( args[ 0 ] === '_movevars' && args.length === 14, `got ${args.join( ' ' )}` );
		assert( args[ 11 ] === '3' && args[ 12 ] === '1500', `got ${args.slice( 11 ).join( ' ' )}` );

	} finally {

		sv_edgefriction.value = oldEdge;
		sv_maxvelocity.value = oldMaxvel;

	}

} );

Deno.test( 'SV_CheckMovevars re-sends on an edgefriction or sv_maxvelocity change', () => {

	const msg = sv.reliable_datagram;
	const oldData = msg.data, oldMax = msg.maxsize;
	const oldEdge = sv_edgefriction.value;
	const oldMaxvel = sv_maxvelocity.value;
	try {

		msg.data = new Uint8Array( 1024 );
		msg.maxsize = 1024;
		SV_CheckMovevars(); // sync the snapshot
		SZ_Clear( msg );
		SV_CheckMovevars();
		assert( msg.cursize === 0, 'nothing changed, nothing to send' );

		sv_edgefriction.value = oldEdge + 1;
		SV_CheckMovevars();
		assert( stufftextOf( msg ).startsWith( '_movevars' ), 'edgefriction change not sent' );
		SZ_Clear( msg );

		sv_maxvelocity.value = oldMaxvel + 1;
		SV_CheckMovevars();
		assert( stufftextOf( msg ).includes( ' ' + ( oldMaxvel + 1 ) ), 'sv_maxvelocity change not sent' );

	} finally {

		SZ_Clear( msg );
		msg.data = oldData;
		msg.maxsize = oldMax;
		sv_edgefriction.value = oldEdge;
		sv_maxvelocity.value = oldMaxvel;

	}

} );
