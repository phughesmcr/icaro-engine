// MP-1: packet entities and player info stop gracefully on a full datagram,
// and the server's stored frame matches what the client rebuilds.

import { sizebuf_t } from '../src/common.js';
import { entity_state_t } from '../src/quakedef.js';
import {
	MAX_PACKET_ENTITIES, PE_ENT_MASK, PE_MOREBITS, PE_REMOVE,
	PE_ORIGIN1, PE_ORIGIN2, PE_ORIGIN3, PE_ANGLE1, PE_ANGLE2, PE_ANGLE3,
	PE_MODEL, PE_FRAME, PE_COLORMAP, PE_SKIN, PE_EFFECTS,
	svc_packetentities, svc_deltapacketentities, svc_playerinfo,
} from '../src/protocol.js';
import { PR_SetSV, sv as progs_sv } from '../src/progs.js';
import { PR_AllocEdicts } from '../src/pr_edict.js';
import { sv, svs } from '../src/server.js';
import { SV_EmitPacketEntities, SV_WritePlayersToClient } from '../src/sv_main.js';

function assert( cond, message ) {

	if ( ! cond )
		throw new Error( message );

}

function makeMsg( size ) {

	const msg = new sizebuf_t();
	msg.data = new Uint8Array( size );
	msg.maxsize = size;
	return msg;

}

function makePacket() {

	const p = { num_entities: 0, entities: [] };
	for ( let i = 0; i < MAX_PACKET_ENTITIES; i ++ )
		p.entities.push( new entity_state_t() );
	return p;

}

// fill a packet with fully changed entities numbered by `numbers`
function fillPacket( p, numbers, seed ) {

	p.num_entities = numbers.length;
	for ( let i = 0; i < numbers.length; i ++ ) {

		const s = p.entities[ i ];
		s.number = numbers[ i ];
		s.flags = 0;
		s.origin[ 0 ] = 8 * ( seed + i );
		s.origin[ 1 ] = - 8 * ( seed + i );
		s.origin[ 2 ] = 16 * ( seed + i );
		s.angles[ 0 ] = seed + 1;
		s.angles[ 1 ] = seed + 2;
		s.angles[ 2 ] = seed + 3;
		s.modelindex = 1 + ( ( seed + i ) % 200 );
		s.frame = 1 + ( seed % 100 );
		s.colormap = 1 + ( seed % 7 );
		s.skin = 1 + ( seed % 3 );
		s.effects = 1 + ( seed % 5 );

	}

}

// Mirror of cl_parse.js CL_ParsePacketEntities / CL_ParseDelta
function decode( msg, oldp, baselines ) {

	let pos = 0;
	const byte = () => msg.data[ pos ++ ];
	const short = () => {

		const v = msg.data[ pos ] | ( msg.data[ pos + 1 ] << 8 );
		pos += 2;
		return v;

	};

	const cmd = byte();
	if ( cmd === svc_deltapacketentities )
		byte();
	else
		assert( cmd === svc_packetentities, 'bad header ' + cmd );

	const out = [];
	let oldindex = 0;
	const oldnum = () => ( oldindex >= oldp.num_entities ? 9999 : oldp.entities[ oldindex ].number );
	const readDelta = ( from, word ) => {

		const to = new entity_state_t();
		to.copyFrom( from );
		to.number = word & PE_ENT_MASK;
		let bits = word & ~PE_ENT_MASK;
		if ( bits & PE_MOREBITS )
			bits |= byte();
		to.flags = bits;
		if ( bits & PE_MODEL ) to.modelindex = byte();
		if ( bits & PE_FRAME ) to.frame = byte();
		if ( bits & PE_COLORMAP ) to.colormap = byte();
		if ( bits & PE_SKIN ) to.skin = byte();
		if ( bits & PE_EFFECTS ) to.effects = byte();
		if ( bits & PE_ORIGIN1 ) to.origin[ 0 ] = ( ( short() << 16 ) >> 16 ) / 8;
		if ( bits & PE_ANGLE1 ) to.angles[ 0 ] = byte();
		if ( bits & PE_ORIGIN2 ) to.origin[ 1 ] = ( ( short() << 16 ) >> 16 ) / 8;
		if ( bits & PE_ANGLE2 ) to.angles[ 1 ] = byte();
		if ( bits & PE_ORIGIN3 ) to.origin[ 2 ] = ( ( short() << 16 ) >> 16 ) / 8;
		if ( bits & PE_ANGLE3 ) to.angles[ 2 ] = byte();
		return to;

	};

	while ( true ) {

		assert( pos + 2 <= msg.cursize, 'read past end of message' );
		const word = short();
		if ( word === 0 ) {

			while ( oldindex < oldp.num_entities )
				out.push( oldp.entities[ oldindex ++ ] );
			break;

		}

		const newnum = word & PE_ENT_MASK;
		while ( newnum > oldnum() )
			out.push( oldp.entities[ oldindex ++ ] );

		if ( newnum < oldnum() ) {

			assert( ! ( word & PE_REMOVE ), 'remove of unknown entity' );
			out.push( readDelta( baselines[ newnum ], word ) );

		} else if ( word & PE_REMOVE ) {

			oldindex ++;

		} else {

			out.push( readDelta( oldp.entities[ oldindex ++ ], word ) );

		}

		assert( out.length <= MAX_PACKET_ENTITIES, 'client would hit MAX_PACKET_ENTITIES' );

	}

	assert( pos === msg.cursize, `decoded ${pos} of ${msg.cursize} bytes` );
	return out;

}

function numbersOf( list, count ) {

	const n = [];
	for ( let i = 0; i < count; i ++ ) n.push( list[ i ].number );
	return n.join( ',' );

}

function range( start, count ) {

	const r = [];
	for ( let i = 0; i < count; i ++ ) r.push( start + i );
	return r;

}

function withServer( fn ) {

	const oldSV = progs_sv;
	const server = { max_edicts: 1024, num_edicts: 1024, edicts: PR_AllocEdicts( 1024, 105 ) };

	try {

		PR_SetSV( server );
		fn( server.edicts.map( ( e ) => e.baseline ) );

	} finally {

		PR_SetSV( oldSV );

	}

}

Deno.test( 'SV_EmitPacketEntities stops a full update before the datagram overflows', () => {

	withServer( ( baselines ) => {

		const to = makePacket();
		fillPacket( to, range( 20, 64 ), 3 );
		const msg = makeMsg( 300 );
		const client = { delta_sequence: - 1, frames: [] };

		SV_EmitPacketEntities( client, to, msg );

		assert( msg.cursize <= msg.maxsize, 'message overflowed' );
		assert( to.num_entities > 0 && to.num_entities < 64, `expected a truncated frame, got ${to.num_entities}` );
		const got = decode( msg, { num_entities: 0, entities: [] }, baselines );
		assert( got.length === to.num_entities, `client has ${got.length}, server stored ${to.num_entities}` );
		assert( numbersOf( got, got.length ) === numbersOf( to.entities, to.num_entities ), 'entity lists differ' );

	} );

} );

Deno.test( 'SV_EmitPacketEntities keeps a delta frame in step with the client on overflow', () => {

	withServer( ( baselines ) => {

		const old = makePacket();
		fillPacket( old, range( 100, 40 ), 1 );
		const to = makePacket();
		fillPacket( to, range( 90, 64 ), 7 ); // 10 new, 40 changed, 14 new after
		const frames = [];
		for ( let i = 0; i < 64; i ++ ) frames.push( { entities: makePacket() } );
		frames[ 5 ].entities = old;
		const client = { delta_sequence: 5, frames };
		const msg = makeMsg( 400 );

		SV_EmitPacketEntities( client, to, msg );

		assert( msg.cursize <= msg.maxsize, 'message overflowed' );
		const got = decode( msg, old, baselines );
		assert( got.length === to.num_entities, `client has ${got.length}, server stored ${to.num_entities}` );
		for ( let i = 0; i < got.length; i ++ ) {

			const a = got[ i ], b = to.entities[ i ];
			assert( a.number === b.number && a.modelindex === b.modelindex && a.frame === b.frame
				&& a.origin[ 0 ] === b.origin[ 0 ] && a.origin[ 2 ] === b.origin[ 2 ],
			`entry ${i} differs: client ${a.number}, server ${b.number}` );

		}

	} );

} );

Deno.test( 'SV_EmitPacketEntities never leaves the client over MAX_PACKET_ENTITIES', () => {

	withServer( ( baselines ) => {

		// old frame is full with high numbers; the new frame adds low-numbered
		// entities first and drops the old ones, so stopping early in the
		// middle would leave the client with more than 64
		const old = makePacket();
		fillPacket( old, range( 500, 64 ), 1 );
		const to = makePacket();
		fillPacket( to, range( 20, 64 ), 9 );
		const frames = [];
		for ( let i = 0; i < 64; i ++ ) frames.push( { entities: makePacket() } );
		frames[ 3 ].entities = old;
		const client = { delta_sequence: 3, frames };
		const msg = makeMsg( 600 );

		SV_EmitPacketEntities( client, to, msg );

		assert( msg.cursize <= msg.maxsize, 'message overflowed' );
		const got = decode( msg, old, baselines );
		assert( got.length <= MAX_PACKET_ENTITIES, 'too many entities' );
		assert( got.length === to.num_entities, `client has ${got.length}, server stored ${to.num_entities}` );
		assert( numbersOf( got, got.length ) === numbersOf( to.entities, to.num_entities ), 'entity lists differ' );

	} );

} );

Deno.test( 'SV_EmitPacketEntities sends everything when it fits', () => {

	withServer( ( baselines ) => {

		const to = makePacket();
		fillPacket( to, range( 20, 64 ), 3 );
		const msg = makeMsg( 2048 );

		SV_EmitPacketEntities( { delta_sequence: - 1, frames: [] }, to, msg );

		assert( to.num_entities === 64, 'frame was truncated' );
		assert( decode( msg, { num_entities: 0, entities: [] }, baselines ).length === 64, 'client missed entities' );

	} );

} );

Deno.test( 'SV_WritePlayersToClient leaves room for packet entities', () => {

	const oldClients = svs.clients;
	const oldMaxclients = svs.maxclients;
	const oldPrecache = sv.model_precache;
	const oldTime = sv.time;
	const edicts = PR_AllocEdicts( 17, 105 );

	try {

		sv.model_precache = [ '', 'progs/player.mdl' ];
		sv.time = 1;
		svs.maxclients = 16;
		svs.clients = [];
		for ( let i = 0; i < 16; i ++ ) {

			const ent = edicts[ i + 1 ];
			ent.v.modelindex = 2;
			ent.v.velocity[ 0 ] = 100;
			ent.v.velocity[ 1 ] = 100;
			ent.v.velocity[ 2 ] = 100;
			ent.v.effects = 1;
			ent.v.skin = 1;
			ent.v.health = 100;
			ent.v.mins[ 2 ] = - 24;
			svs.clients.push( {
				active: true, spawned: true, edict: ent, localtime: 0,
				lastcmd: { forwardmove: 400, sidemove: 350, upmove: 200, angles: [ 10, 20, 30 ] }
			} );

		}

		// every player visible: 16 full playerinfos (~37 bytes each) cannot fit
		// in 200 bytes, and the message does not allow overflow, so writing
		// past the end would throw
		for ( let i = 0; i < 16; i ++ ) {

			edicts[ i + 1 ].num_leafs = 1;
			edicts[ i + 1 ].leafnums[ 0 ] = 0;

		}

		const pvs = new Uint8Array( [ 1 ] );
		const msg = makeMsg( 200 );
		SV_WritePlayersToClient( svs.clients[ 0 ], edicts[ 1 ], pvs, msg );

		assert( msg.data[ 0 ] === svc_playerinfo, 'expected some players written' );
		assert( msg.maxsize - msg.cursize >= 4, `only ${msg.maxsize - msg.cursize} bytes left for packet entities` );

	} finally {

		svs.clients = oldClients;
		svs.maxclients = oldMaxclients;
		sv.model_precache = oldPrecache;
		sv.time = oldTime;

	}

} );
