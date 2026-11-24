// MP-1: packet entities and player info stop gracefully on a full datagram,
// and the server's stored frame matches what the client rebuilds.

import { sizebuf_t } from '../src/common.js';
import { entity_state_t, packet_entities_t, MAX_EDICTS } from '../src/quakedef.js';
import {
	MAX_PACKET_ENTITIES, PE_ENT_MASK, PE_MOREBITS, PE_REMOVE,
	PE_ORIGIN1, PE_ORIGIN2, PE_ORIGIN3, PE_ANGLE1, PE_ANGLE2, PE_ANGLE3,
	PE_MODEL, PE_FRAME, PE_COLORMAP, PE_SKIN, PE_EFFECTS, PE_SOLID, PS_BSP, PS_BOX, PS_NOLERP,
	svc_packetentities, svc_deltapacketentities, svc_playerinfo, PF_TELEPORT,
} from '../src/protocol.js';
import { PR_SetSV, sv as progs_sv } from '../src/progs.js';
import { PR_AllocEdicts } from '../src/pr_edict.js';
import { sv, svs, SOLID_BSP, SOLID_SLIDEBOX, SOLID_BBOX, SOLID_NOT, MOVETYPE_STEP } from '../src/server.js';
import { SV_EmitPacketEntities, SV_WritePlayersToClient, SV_SetStateSolid } from '../src/sv_main.js';

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

	return new packet_entities_t();

}

// fill a packet with fully changed entities numbered by `numbers`
function fillPacket( p, numbers, seed ) {

	p.num_entities = numbers.length;
	for ( let i = 0; i < numbers.length; i ++ ) {

		const s = p.state( i );
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
		if ( bits & PE_SOLID ) {

			to.solid = byte();
			if ( to.solid & PS_BOX ) {

				for ( let i = 0; i < 3; i ++ ) to.mins[ i ] = ( ( short() << 16 ) >> 16 ) / 8;
				for ( let i = 0; i < 3; i ++ ) to.maxs[ i ] = ( ( short() << 16 ) >> 16 ) / 8;

			}

		}

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
		const client = { delta_sequence: 5, outgoing_sequence: 6, frames };
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

Deno.test( 'MAX_PACKET_ENTITIES never binds (MP-2)', () => {

	// entity numbers are below MAX_EDICTS, so no frame, and no mix of an old
	// and a new frame, can hold more than MAX_PACKET_ENTITIES entities
	assert( MAX_PACKET_ENTITIES >= MAX_EDICTS, `cap ${MAX_PACKET_ENTITIES} < MAX_EDICTS ${MAX_EDICTS}` );
	assert( MAX_EDICTS - 1 <= PE_ENT_MASK, 'entity numbers must fit the PE entity bits' );

} );

Deno.test( 'SV_EmitPacketEntities: 300 entities reach the client over a few datagrams (MP-2)', () => {

	withServer( ( baselines ) => {

		const want = new packet_entities_t();
		fillPacket( want, range( 20, 300 ), 3 );

		const frames = [];
		for ( let i = 0; i < 64; i ++ ) frames.push( { entities: makePacket() } );
		const client = { delta_sequence: - 1, frames };
		let clientFrame = { num_entities: 0, entities: [] };

		for ( let seq = 0; seq < 20; seq ++ ) {

			const to = frames[ seq & 63 ].entities;
			to.num_entities = 0;
			for ( let i = 0; i < want.num_entities; i ++ )
				to.state( to.num_entities ++ ).copyFrom( want.entities[ i ] );

			client.outgoing_sequence = seq;
			const msg = makeMsg( 1024 );
			SV_EmitPacketEntities( client, to, msg );
			const got = decode( msg, clientFrame, baselines );
			assert( got.length === to.num_entities, `client has ${got.length}, server stored ${to.num_entities}` );
			clientFrame = { num_entities: got.length, entities: got };
			client.delta_sequence = seq; // the client acks every frame
			if ( got.length === 300 )
				return;

		}

		throw new Error( 'never sent all 300 entities' );

	} );

} );

Deno.test( 'SV_EmitPacketEntities sends everything when it fits', () => {

	withServer( ( baselines ) => {

		const to = makePacket();
		fillPacket( to, range( 20, 100 ), 3 );
		const msg = makeMsg( 4096 );

		SV_EmitPacketEntities( { delta_sequence: - 1, frames: [] }, to, msg );

		assert( to.num_entities === 100, 'frame was truncated' );
		assert( decode( msg, { num_entities: 0, entities: [] }, baselines ).length === 100, 'client missed entities' );

	} );

} );

// delta_sequence age check (QW SV_EmitPacketEntities)

function emitWithAge( outgoing, delta ) {

	let header = - 1;
	withServer( ( baselines ) => {

		const old = makePacket();
		fillPacket( old, range( 20, 4 ), 1 );
		const to = makePacket();
		fillPacket( to, range( 20, 4 ), 2 );
		const frames = [];
		for ( let i = 0; i < 64; i ++ ) frames.push( { entities: makePacket() } );
		if ( delta !== - 1 ) frames[ delta & 63 ].entities = old;
		const msg = makeMsg( 1024 );
		SV_EmitPacketEntities( { delta_sequence: delta, outgoing_sequence: outgoing, frames }, to, msg );
		header = msg.data[ 0 ];
		// whichever was chosen must decode against what the client holds
		const got = decode( msg, header === svc_deltapacketentities ? old : { num_entities: 0, entities: [] }, baselines );
		assert( got.length === 4, 'client lost entities' );

	} );
	return header;

}

Deno.test( 'SV_EmitPacketEntities sends a full update when delta_sequence is too old', () => {

	// age < PE_UPDATE_BACKUP - 1: still a delta
	assert( emitWithAge( 70, 8 ) === svc_deltapacketentities, 'age 62 should be a delta' );
	// age == PE_UPDATE_BACKUP - 1: the client would drop a delta, so send a full update
	assert( emitWithAge( 71, 8 ) === svc_packetentities, 'age 63 should be a full update' );
	assert( emitWithAge( 200, 8 ) === svc_packetentities, 'a very old ack should be a full update' );
	// the sequence is one byte on the wire: 11 frames old across the wrap
	assert( emitWithAge( 261, 250 ) === svc_deltapacketentities, 'age across the 256 wrap should be a delta' );
	// no delta requested
	assert( emitWithAge( 3, - 1 ) === svc_packetentities, 'delta_sequence -1 is a full update' );

} );

// Entities past the datagram capacity must still be refreshed within a
// bounded number of frames: every entity changes every frame, the datagram
// holds about a fifth of them, and the client acks each frame.
Deno.test( 'SV_EmitPacketEntities sweeps all entities across frames when they overflow', () => {

	withServer( ( baselines ) => {

		const count = 300;
		const numbers = range( 20, count );
		const frames = [];
		for ( let i = 0; i < 64; i ++ ) frames.push( { entities: makePacket() } );
		const client = { delta_sequence: - 1, outgoing_sequence: 0, frames, pe_cursor: 0 };
		let clientFrame = { num_entities: 0, entities: [] };
		const lastUpdated = new Map(); // entity number -> frame it last changed on the client
		let overflowed = 0;
		let worstGap = 0;
		const originalPrintf = console.log;

		for ( let seq = 0; seq < 40; seq ++ ) {

			const to = frames[ seq & 63 ].entities;
			fillPacket( to, numbers, seq * 3 ); // everything moved
			client.outgoing_sequence = seq;

			const msg = makeMsg( 1024 );
			console.log = () => {};
			try {

				SV_EmitPacketEntities( client, to, msg );

			} finally {

				console.log = originalPrintf;

			}

			if ( client.pe_cursor !== 0 ) overflowed ++;
			const got = decode( msg, clientFrame, baselines );
			assert( got.length === to.num_entities, `frame ${seq}: client has ${got.length}, server stored ${to.num_entities}` );

			// which entities changed on the client this frame
			const before = new Map();
			for ( let i = 0; i < clientFrame.num_entities; i ++ ) before.set( clientFrame.entities[ i ].number, clientFrame.entities[ i ] );
			for ( const e of got ) {

				const b = before.get( e.number );
				if ( b == null || b.origin[ 0 ] !== e.origin[ 0 ] ) lastUpdated.set( e.number, seq );

			}

			clientFrame = { num_entities: got.length, entities: got.map( ( e ) => {

				const c = new entity_state_t();
				c.copyFrom( e );
				return c;

			} ) };
			client.delta_sequence = seq;

			if ( seq >= 10 ) {

				for ( const n of numbers ) worstGap = Math.max( worstGap, seq - ( lastUpdated.get( n ) ?? - 1 ) );

			}

		}

		assert( overflowed > 3, 'the test must overflow the datagram, overflowed ' + overflowed + ' frames' );
		for ( const n of numbers )
			assert( lastUpdated.has( n ), `entity ${n} was never sent` );
		assert( worstGap <= 8, `an entity went ${worstGap} frames without an update` );

	} );

} );

// teleport_time reaches the client through svc_playerinfo PF_TELEPORT

Deno.test( 'SV_WritePlayersToClient sends the view player teleport_time left (PF_TELEPORT)', () => {

	const oldClients = svs.clients;
	const oldMaxclients = svs.maxclients;
	const oldPrecache = sv.model_precache;
	const oldTime = sv.time;
	const edicts = PR_AllocEdicts( 3, 105 );

	try {

		sv.model_precache = [ '', 'progs/player.mdl' ];
		sv.time = 5;
		svs.maxclients = 1;
		const ent = edicts[ 1 ];
		ent.v.modelindex = 1;
		ent.v.health = 100;
		ent.v.mins[ 2 ] = - 24;
		svs.clients = [ { active: true, spawned: true, edict: ent, localtime: 0 } ];

		const write = () => {

			const msg = makeMsg( 200 );
			SV_WritePlayersToClient( svs.clients[ 0 ], ent, new Uint8Array( [ 1 ] ), msg );
			return msg;

		};

		// the teleporter's QC: teleport_time = time + 0.7, read after sv.time advanced by a frame
		ent.v.teleport_time = 5.7;
		sv.time = 5.0125;
		let msg = write();
		const flags = msg.data[ 2 ] | ( msg.data[ 3 ] << 8 );
		assert( ( flags & PF_TELEPORT ) !== 0, 'PF_TELEPORT set' );
		assert( msg.data[ msg.cursize - 1 ] === 69, `expected 69 (10 ms units, rounded up), got ${msg.data[ msg.cursize - 1 ]}` );

		// expired
		sv.time = 5.7;
		msg = write();
		assert( ( ( msg.data[ 2 ] | ( msg.data[ 3 ] << 8 ) ) & PF_TELEPORT ) === 0, 'no PF_TELEPORT once it expires' );

		// waterjump keeps teleport_time = time + 2: the longest value, still one byte
		ent.v.teleport_time = 7;
		sv.time = 5;
		msg = write();
		assert( msg.data[ msg.cursize - 1 ] === 200, 'two seconds is 200' );

	} finally {

		svs.clients = oldClients;
		svs.maxclients = oldMaxclients;
		sv.model_precache = oldPrecache;
		sv.time = oldTime;

	}

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

// PRED-5 / MP-5: prediction solidity and no-lerp travel in the PE_SOLID byte

function solidEdict( edicts, n, solid, mins, maxs ) {

	const ent = edicts[ n ];
	ent.v.solid = solid;
	for ( let i = 0; i < 3; i ++ ) {

		ent.v.mins[ i ] = mins[ i ];
		ent.v.maxs[ i ] = maxs[ i ];
		ent.v.size[ i ] = maxs[ i ] - mins[ i ];

	}

	return ent;

}

Deno.test( 'SV_SetStateSolid follows v.solid and the SV_ClipToLinks filters', () => {

	withServer( () => {

		const edicts = progs_sv.edicts;
		const player = edicts[ 1 ];
		const s = new entity_state_t();

		const door = solidEdict( edicts, 20, SOLID_BSP, [ 0, 0, 0 ], [ 64, 8, 128 ] );
		SV_SetStateSolid( s, door, player );
		assert( s.solid === PS_BSP, `door: ${s.solid}` );

		const ogre = solidEdict( edicts, 21, SOLID_SLIDEBOX, [ - 32, - 32, - 24 ], [ 32, 32, 64 ] );
		ogre.v.movetype = MOVETYPE_STEP;
		SV_SetStateSolid( s, ogre, player );
		assert( s.solid === ( PS_BOX | PS_NOLERP ), `monster: ${s.solid}` );
		assert( s.mins[ 0 ] === - 32 && s.mins[ 2 ] === - 24 && s.maxs[ 2 ] === 64, 'monster box' );

		// a corpse keeps its model but is SOLID_NOT
		ogre.v.solid = SOLID_NOT;
		SV_SetStateSolid( s, ogre, player );
		assert( s.solid === PS_NOLERP && s.mins[ 0 ] === 0, `corpse: ${s.solid}` );

		// the player's own missile, and a point-sized one, don't block
		const missile = solidEdict( edicts, 22, SOLID_BBOX, [ - 4, - 4, - 4 ], [ 4, 4, 4 ] );
		missile.v.owner = 1;
		SV_SetStateSolid( s, missile, player );
		assert( s.solid === 0, `own missile: ${s.solid}` );
		missile.v.owner = 2;
		SV_SetStateSolid( s, missile, player );
		assert( s.solid === PS_BOX, `someone else's missile: ${s.solid}` );
		const nail = solidEdict( edicts, 23, SOLID_BBOX, [ 0, 0, 0 ], [ 0, 0, 0 ] );
		nail.v.owner = 2;
		SV_SetStateSolid( s, nail, player );
		assert( s.solid === 0, `point entity: ${s.solid}` );

	} );

} );

Deno.test( 'PE_SOLID is sent only on change, carries the box, and clears', () => {

	withServer( ( baselines ) => {

		const edicts = progs_sv.edicts;
		const player = edicts[ 1 ];
		// Chthon (boss.qc): a box too big for byte encoding
		const boss = solidEdict( edicts, 30, SOLID_SLIDEBOX, [ - 128, - 128, - 24 ], [ 128, 128, 256 ] );
		const box = solidEdict( edicts, 31, SOLID_BBOX, [ 0, 0, 0 ], [ 32, 32, 64 ] ); // misc_explobox

		const frame = ( n ) => {

			const p = new packet_entities_t();
			fillPacket( p, [ 30, 31 ], 1 );
			SV_SetStateSolid( p.state( 0 ), boss, player );
			SV_SetStateSolid( p.state( 1 ), box, player );
			p.num_entities = n;
			return p;

		};

		const frames = [];
		for ( let i = 0; i < 64; i ++ ) frames.push( { entities: makePacket() } );

		// full update: both boxes arrive
		const f0 = frame( 2 );
		let msg = makeMsg( 1024 );
		SV_EmitPacketEntities( { delta_sequence: - 1, frames }, f0, msg );
		const got0 = decode( msg, { num_entities: 0, entities: [] }, baselines );
		assert( got0[ 0 ].solid === PS_BOX && got0[ 0 ].mins[ 0 ] === - 128 && got0[ 0 ].maxs[ 2 ] === 256, 'boss box' );
		assert( got0[ 1 ].solid === PS_BOX && got0[ 1 ].mins[ 0 ] === 0 && got0[ 1 ].maxs[ 2 ] === 64, 'explobox box' );
		frames[ 0 ].entities = f0;

		// nothing changed: nothing but the header and terminator is sent
		const f1 = frame( 2 );
		msg = makeMsg( 1024 );
		SV_EmitPacketEntities( { delta_sequence: 0, outgoing_sequence: 1, frames }, f1, msg );
		assert( msg.cursize === 4, `unchanged frame took ${msg.cursize} bytes` );
		frames[ 1 ].entities = f1;

		// the boss dies: only its solidity changes, and that must still reach the client
		boss.v.solid = SOLID_NOT;
		const f2 = frame( 2 );
		msg = makeMsg( 1024 );
		SV_EmitPacketEntities( { delta_sequence: 1, outgoing_sequence: 2, frames }, f2, msg );
		const got2 = decode( msg, { num_entities: 2, entities: got0 }, baselines );
		assert( got2[ 0 ].solid === 0, 'corpse is still solid on the client' );
		assert( got2[ 1 ].solid === PS_BOX && got2[ 1 ].maxs[ 2 ] === 64, 'explobox lost its box' );

	} );

} );
