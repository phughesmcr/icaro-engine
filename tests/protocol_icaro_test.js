// PROTOCOL_ICARO (1015, protocol.js): the wider fields the 2021 rerelease
// maps need, written by the server and read back by the real client parser.
// - coords are int32 eighths, so maps past +-4096 survive;
// - model indexes are shorts (MAX_MODELS 4096) in packet entities,
//   baselines, statics, clientdata and playerinfo;
// - sound indexes and entity numbers use Ironwail's SND_LARGE* flags;
// - packet entity numbers are 15 bits (MAX_EDICTS 32000);
// - entity alpha rides on packet entities, baselines and statics.
// NetQuake 15 (the shareware attract demos) must still parse.

// Bootstrap the client renderer graph in its established safe import order.
await import( '../src/gl_rsurf.js' );

const common = await import( '../src/common.js' );
const net = await import( '../src/net.js' );
const pak = await import( '../src/pak.js' );
const { MAX_EDICTS, MAX_MODELS, STAT_WEAPON, packet_entities_t } = await import( '../src/quakedef.js' );
const {
	PROTOCOL_VERSION, PROTOCOL_ICARO, svc_version, svc_spawnbaseline, svc_spawnstatic,
	svc_spawnstaticsound, svc_serversequence, svc_sound, svc_clientdata,
	SND_LARGEENTITY, SND_LARGESOUND, SU_WEAPON, SU_ITEMS,
	ENTALPHA_DEFAULT, ENTALPHA_ZERO, ENTALPHA_ONE, ENTALPHA_ENCODE, ENTALPHA_DECODE, ENTALPHA_TOSAVE,
} = await import( '../src/protocol.js' );
const { cl, cls, cl_entities, cl_static_entities, scoreboard_t, SIGNONS } = await import( '../src/client.js' );
const { CL_ParseServerMessage } = await import( '../src/cl_parse.js' );
const { CL_GetEntityFrame, CL_GetPredictedPlayer, CL_ResetPrediction } = await import( '../src/cl_pred.js' );
const { cl_shownet } = await import( '../src/cl_main.js' );
const { PR_SetSV, PR_SetSVS, sv: progs_sv, svs: progs_svs, edict_t } = await import( '../src/progs.js' );
const { PR_AllocEdicts, ED_Alloc, ED_Free } = await import( '../src/pr_edict.js' );
const { sv, svs } = await import( '../src/server.js' );
const { SV_EmitPacketEntities, SV_WritePlayersToClient, SV_StartSound } = await import( '../src/sv_main.js' );
const consolejs = await import( '../src/console.js' );

function assertEqual( actual, expected, message ) {

	if ( actual !== expected )
		throw new Error( `${message}: expected ${expected}, got ${actual}` );

}

const printed = [];
common.Con_SetPrintFunctions(
	( fmt, ...args ) => printed.push( args.length === 0 ? String( fmt ) : consolejs._sprintf( fmt, ...args ) ),
	() => {}
);

function makeMsg( size ) {

	const msg = new common.sizebuf_t();
	common.SZ_Alloc( msg, size );
	return msg;

}

// Run the client parser over one message: svc_version `protocol`, then
// whatever `write` puts in. Restores the client state it touches.
function clientParse( protocol, write, check ) {

	const saved = {
		data: net.net_message.data, maxsize: net.net_message.maxsize, cursize: net.net_message.cursize,
		common: common.net_message, protocol: cl.protocol, signon: cls.signon,
		num_entities: cl.num_entities, entities: cl_entities.length, num_statics: cl.num_statics,
		maxclients: cl.maxclients, scores: cl.scores,
	};

	try {

		common.COM_SetNetMessage( net.net_message );
		net.net_message.data = new Uint8Array( 8192 );
		net.net_message.maxsize = 8192;
		common.SZ_Clear( net.net_message );
		common.MSG_WriteByte( net.net_message, svc_version );
		common.MSG_WriteLong( net.net_message, protocol );
		write( net.net_message );
		CL_ParseServerMessage();
		assertEqual( common.msg_readcount, net.net_message.cursize, 'client read the whole message' );
		check();

	} finally {

		net.net_message.data = saved.data;
		net.net_message.maxsize = saved.maxsize;
		net.net_message.cursize = saved.cursize;
		common.COM_SetNetMessage( saved.common );
		cl.protocol = saved.protocol;
		common.MSG_SetCoord32( true );
		cls.signon = saved.signon;
		cl.num_entities = saved.num_entities;
		cl_entities.length = saved.entities;
		cl.num_statics = saved.num_statics;
		cl.maxclients = saved.maxclients;
		cl.scores = saved.scores;
		CL_ResetPrediction();

	}

}

function copyInto( dst, src ) {

	common.SZ_Write( dst, src.data.subarray( 0, src.cursize ), src.cursize );

}

//=============================================================================

Deno.test( 'MSG_WriteCoord sends int32 eighths that read back past +-4096', () => {

	const cases = [ 0, 4095.875, - 4096, 4096.125, 5000.5, - 12000.25, 32767.875, - 30000, 100000 ];
	const msg = makeMsg( 256 );
	for ( const f of cases ) common.MSG_WriteCoord( msg, f );
	assertEqual( msg.cursize, cases.length * 4, 'four bytes per coord' );

	const saved = common.net_message;
	try {

		common.COM_SetNetMessage( msg );
		common.MSG_BeginReading();
		for ( const f of cases )
			assertEqual( common.MSG_ReadCoord(), f, `coord ${f}` );

		// NetQuake 15: shorts
		common.SZ_Clear( msg );
		common.MSG_WriteCoord16( msg, - 4096 );
		common.MSG_WriteCoord16( msg, 4095.875 );
		common.MSG_SetCoord32( false );
		common.MSG_BeginReading();
		assertEqual( common.MSG_ReadCoord(), - 4096, 'short coord' );
		assertEqual( common.MSG_ReadCoord(), 4095.875, 'short coord' );
		assertEqual( common.msg_readcount, 4, 'two bytes per short coord' );

	} finally {

		common.MSG_SetCoord32( true );
		common.COM_SetNetMessage( saved );

	}

} );

Deno.test( 'svc_version switches the client between NetQuake 15 and PROTOCOL_ICARO', () => {

	clientParse( PROTOCOL_VERSION, ( m ) => {

		// an id baseline: byte model, short coords, no alpha
		common.MSG_WriteByte( m, svc_spawnbaseline );
		common.MSG_WriteShort( m, 7 );
		common.MSG_WriteByte( m, 200 ); // model
		common.MSG_WriteByte( m, 3 ); // frame
		common.MSG_WriteByte( m, 0 ); // colormap
		common.MSG_WriteByte( m, 1 ); // skin
		for ( let i = 0; i < 3; i ++ ) {

			common.MSG_WriteCoord16( m, - 4000 + i );
			common.MSG_WriteAngle( m, 90 );

		}

		// and back to PROTOCOL_ICARO in the same message
		common.MSG_WriteByte( m, svc_version );
		common.MSG_WriteLong( m, PROTOCOL_ICARO );
		common.MSG_WriteByte( m, svc_spawnbaseline );
		common.MSG_WriteShort( m, 9999 );
		common.MSG_WriteShort( m, 3000 ); // model
		common.MSG_WriteByte( m, 4 );
		common.MSG_WriteByte( m, 0 );
		common.MSG_WriteByte( m, 2 );
		for ( let i = 0; i < 3; i ++ ) {

			common.MSG_WriteCoord( m, 5000.5 * ( i - 1 ) );
			common.MSG_WriteAngle( m, 180 );

		}
		common.MSG_WriteByte( m, ENTALPHA_ENCODE( 0.5 ) );

	}, () => {

		assertEqual( cl.protocol, PROTOCOL_ICARO, 'protocol after the second svc_version' );
		const b7 = cl_entities[ 7 ].baseline;
		assertEqual( b7.modelindex, 200, 'NQ baseline model' );
		assertEqual( b7.origin[ 2 ], - 3998, 'NQ baseline coord' );
		assertEqual( b7.alpha, ENTALPHA_DEFAULT, 'NQ baseline alpha' );
		const b = cl_entities[ 9999 ].baseline;
		assertEqual( b.modelindex, 3000, 'baseline model' );
		assertEqual( b.origin[ 0 ], - 5000.5, 'baseline coord' );
		assertEqual( b.origin[ 2 ], 5000.5, 'baseline coord' );
		assertEqual( b.alpha, 128, 'baseline alpha' );
		assertEqual( cl.num_entities, 10000, 'cl.num_entities' );

	} );

} );

Deno.test( 'an unknown protocol is refused', () => {

	let error = null;
	try {

		clientParse( 666, () => {}, () => {} );

	} catch ( e ) {

		error = e;

	}

	if ( error === null || ! String( error.message ).includes( 'protocol 666' ) )
		throw new Error( 'expected a Host_Error for protocol 666, got ' + error );

} );

Deno.test( 'svc_spawnstatic and svc_spawnstaticsound read short indexes and alpha', () => {

	clientParse( PROTOCOL_ICARO, ( m ) => {

		// PF_makestatic's layout
		common.MSG_WriteByte( m, svc_spawnstatic );
		common.MSG_WriteShort( m, MAX_MODELS - 1 );
		common.MSG_WriteByte( m, 5 );
		common.MSG_WriteByte( m, 0 );
		common.MSG_WriteByte( m, 1 );
		for ( let i = 0; i < 3; i ++ ) {

			common.MSG_WriteCoord( m, - 6000 );
			common.MSG_WriteAngle( m, 0 );

		}
		common.MSG_WriteByte( m, ENTALPHA_ENCODE( 0.25 ) );

		// PF_ambientsound's layout
		common.MSG_WriteByte( m, svc_spawnstaticsound );
		for ( let i = 0; i < 3; i ++ ) common.MSG_WriteCoord( m, 7000 );
		common.MSG_WriteShort( m, 1500 );
		common.MSG_WriteByte( m, 255 );
		common.MSG_WriteByte( m, 64 );

	}, () => {

		const ent = cl_static_entities[ cl.num_statics - 1 ];
		assertEqual( ent.baseline.modelindex, MAX_MODELS - 1, 'static model' );
		assertEqual( ent.origin[ 1 ], - 6000, 'static origin' );
		assertEqual( ent.alpha, ENTALPHA_ENCODE( 0.25 ), 'static alpha' );

	} );

} );

//=============================================================================
// packet entities

const NUMBERS = [ 1023, 1024, 8191, 9999, MAX_EDICTS - 1 ];

function fillPacket( p, alpha ) {

	p.num_entities = NUMBERS.length;
	for ( let i = 0; i < NUMBERS.length; i ++ ) {

		const s = p.state( i );
		s.number = NUMBERS[ i ];
		s.modelindex = 256 + i * 900;
		s.frame = 7;
		s.origin[ 0 ] = 5000.5 + i;
		s.origin[ 1 ] = - 12000.25;
		s.origin[ 2 ] = 30000 - i * 0.125;
		s.angles[ 1 ] = 90;
		s.alpha = alpha[ i ];

	}

}

function withServerEdicts( fn ) {

	const oldSV = progs_sv;
	try {

		PR_SetSV( { max_edicts: MAX_EDICTS, num_edicts: MAX_EDICTS, edicts: PR_AllocEdicts( 64, 105 ) } );
		fn();

	} finally {

		PR_SetSV( oldSV );

	}

}

Deno.test( 'packet entities carry 15-bit numbers, short models, wide coords and alpha', () => {

	withServerEdicts( () => {

		const first = new packet_entities_t();
		fillPacket( first, [ 0, 128, ENTALPHA_ZERO, ENTALPHA_ONE, 2 ] );
		const full = makeMsg( 2048 );
		SV_EmitPacketEntities( { delta_sequence: - 1, frames: [] }, first, full );
		assertEqual( first.num_entities, NUMBERS.length, 'server sent every entity' );

		// the next frame deltas from the first: alpha changes alone on one
		// entity, another is removed
		const second = new packet_entities_t();
		fillPacket( second, [ 0, 200, ENTALPHA_ZERO, ENTALPHA_ONE, 2 ] );
		second.state( 2 ).copyFrom( second.state( 3 ) );
		second.state( 3 ).copyFrom( second.state( 4 ) );
		second.num_entities = 4; // 8191 is gone
		const frames = [];
		for ( let i = 0; i < 64; i ++ ) frames.push( { entities: new packet_entities_t() } );
		frames[ 10 ].entities = first;
		const delta = makeMsg( 2048 );
		SV_EmitPacketEntities( { delta_sequence: 10, outgoing_sequence: 11, frames }, second, delta );

		clientParse( PROTOCOL_ICARO, ( m ) => {

			cls.signon = SIGNONS;
			common.MSG_WriteByte( m, svc_serversequence );
			common.MSG_WriteLong( m, 10 );
			copyInto( m, full );
			common.MSG_WriteByte( m, svc_serversequence );
			common.MSG_WriteLong( m, 11 );
			copyInto( m, delta );

		}, () => {

			const a = CL_GetEntityFrame( 10 ).packet_entities;
			assertEqual( a.num_entities, NUMBERS.length, 'full update entity count' );
			for ( let i = 0; i < NUMBERS.length; i ++ ) {

				const s = a.entities[ i ], w = first.entities[ i ];
				assertEqual( s.number, w.number, `number ${i}` );
				assertEqual( s.modelindex, w.modelindex, `model ${i}` );
				assertEqual( s.origin[ 0 ], w.origin[ 0 ], `origin x ${i}` );
				assertEqual( s.origin[ 1 ], w.origin[ 1 ], `origin y ${i}` );
				assertEqual( s.origin[ 2 ], w.origin[ 2 ], `origin z ${i}` );
				assertEqual( s.alpha, w.alpha, `alpha ${i}` );

			}

			const b = CL_GetEntityFrame( 11 ).packet_entities;
			assertEqual( b.num_entities, 4, 'delta entity count' );
			assertEqual( [ ...Array( 4 ).keys() ].map( ( i ) => b.entities[ i ].number ).join( ',' ),
				[ 1023, 1024, 9999, MAX_EDICTS - 1 ].join( ',' ), 'delta numbers' );
			assertEqual( b.entities[ 1 ].alpha, 200, 'alpha-only change' );
			assertEqual( b.entities[ 1 ].origin[ 0 ], 5001.5, 'unchanged origin kept' );
			assertEqual( b.entities[ 3 ].modelindex, 256 + 4 * 900, 'unchanged model kept' );
			if ( cl_entities.length < MAX_EDICTS )
				throw new Error( `cl_entities did not grow to ${MAX_EDICTS}: ${cl_entities.length}` );

		} );

	} );

} );

Deno.test( 'ED_Alloc grows sv.edicts past its initial size and ED_Free resets alpha', () => {

	const oldSV = progs_sv;
	const oldSVS = progs_svs;
	try {

		const s = { max_edicts: 2000, num_edicts: 2, time: 0, edicts: PR_AllocEdicts( 8, 105 ) };
		PR_SetSV( s );
		PR_SetSVS( { maxclients: 1 } );
		let last = null;
		for ( let i = 0; i < 1030; i ++ ) last = ED_Alloc();
		assertEqual( s.num_edicts, 1032, 'num_edicts after 1030 allocations' );
		assertEqual( last.index, 1031, 'last allocated edict number' );
		assertEqual( s.edicts[ 1031 ], last, 'edict stored at its number' );
		// C's fixed array always has the edict after the last one
		if ( s.edicts.length < 1033 )
			throw new Error( `NEXT_EDICT of the last edict is missing: ${s.edicts.length}` );

		last.alpha = 128;
		ED_Free( last );
		assertEqual( last.alpha, ENTALPHA_DEFAULT, 'ED_Free resets alpha' );

	} finally {

		PR_SetSV( oldSV );
		PR_SetSVS( oldSVS );

	}

} );

//=============================================================================
// sounds, clientdata and playerinfo

Deno.test( 'svc_sound uses SND_LARGEENTITY and SND_LARGESOUND past 8191 and 255', () => {

	const oldProgsSV = progs_sv;
	const oldPrecache = sv.sound_precache;
	const oldNum = sv.num_edicts;
	const oldMax = sv.max_edicts;
	const savedDatagram = { data: sv.datagram.data, maxsize: sv.datagram.maxsize, cursize: sv.datagram.cursize };
	const savedShownet = cl_shownet.value;
	const savedClPrecache = cl.sound_precache[ 1300 ];

	try {

		PR_SetSV( sv );
		sv.num_edicts = 9001;
		sv.max_edicts = MAX_EDICTS;
		// SV_StartSound's lookup stops at the first empty slot
		sv.sound_precache = new Array( 2048 ).fill( null );
		for ( let i = 1; i < 1300; i ++ ) sv.sound_precache[ i ] = 'test/s' + i + '.wav';
		sv.sound_precache[ 1300 ] = 'test/large.wav';
		sv.datagram.data = new Uint8Array( 256 );
		sv.datagram.maxsize = 256;
		sv.datagram.cursize = 0;

		const entity = new edict_t( 9000, 105 );
		entity.v.origin[ 0 ] = 6000;
		SV_StartSound( entity, 5, 'test/large.wav', 255, 1 );
		assertEqual( sv.datagram.data[ 0 ], svc_sound, 'svc_sound written' );
		assertEqual( sv.datagram.data[ 1 ], SND_LARGEENTITY | SND_LARGESOUND, 'field mask' );

		cl.sound_precache[ 1300 ] = { name: 'test/large.wav' };
		cl_shownet.value = 2; // CL_ParseStartSoundPacket prints what it parsed
		printed.length = 0;
		clientParse( PROTOCOL_ICARO, ( m ) => copyInto( m, sv.datagram ), () => {} );
		const line = printed.find( ( s ) => s.startsWith( 'svc_sound:' ) );
		assertEqual( line, 'svc_sound: test/large.wav (num=1300 ent=9000 ch=5)\n', 'parsed sound' );

	} finally {

		PR_SetSV( oldProgsSV );
		sv.sound_precache = oldPrecache;
		sv.num_edicts = oldNum;
		sv.max_edicts = oldMax;
		sv.datagram.data = savedDatagram.data;
		sv.datagram.maxsize = savedDatagram.maxsize;
		sv.datagram.cursize = savedDatagram.cursize;
		cl_shownet.value = savedShownet;
		cl.sound_precache[ 1300 ] = savedClPrecache;

	}

} );

// The server side (a short weapon field) is in sv_main_test.js
Deno.test( 'clientdata SU_WEAPON is a short under PROTOCOL_ICARO and a byte under 15', () => {

	const savedWeapon = cl.stats[ STAT_WEAPON ];
	const write = ( m, short, model ) => {

		common.MSG_WriteByte( m, svc_clientdata );
		common.MSG_WriteShort( m, SU_ITEMS | SU_WEAPON );
		common.MSG_WriteLong( m, 1 ); // items
		if ( short ) common.MSG_WriteShort( m, model );
		else common.MSG_WriteByte( m, model );
		common.MSG_WriteShort( m, 100 ); // health
		for ( let i = 0; i < 6; i ++ ) common.MSG_WriteByte( m, 0 ); // ammo, 4 ammo counts, activeweapon

	};

	try {

		clientParse( PROTOCOL_ICARO, ( m ) => write( m, true, 3000 ),
			() => assertEqual( cl.stats[ STAT_WEAPON ], 3000, 'ICARO weapon model' ) );
		clientParse( PROTOCOL_VERSION, ( m ) => write( m, false, 200 ),
			() => assertEqual( cl.stats[ STAT_WEAPON ], 200, 'NQ weapon model' ) );

	} finally {

		cl.stats[ STAT_WEAPON ] = savedWeapon;

	}

} );

Deno.test( 'svc_playerinfo carries a short model index and wide coords', () => {

	const oldClients = svs.clients;
	const oldMaxclients = svs.maxclients;
	const oldPrecache = sv.model_precache;
	const oldTime = sv.time;
	const edicts = PR_AllocEdicts( 3, 105 );

	try {

		sv.model_precache = [ '', 'progs/player.mdl' ];
		sv.time = 1;
		svs.maxclients = 1;
		const ent = edicts[ 1 ];
		ent.v.modelindex = 3001;
		ent.v.health = 100;
		ent.v.origin[ 0 ] = - 7000.5;
		ent.v.origin[ 1 ] = 9000;
		svs.clients = [ { active: true, spawned: true, edict: ent, localtime: 0 } ];
		const msg = makeMsg( 200 );
		SV_WritePlayersToClient( svs.clients[ 0 ], ent, new Uint8Array( [ 1 ] ), msg );

		clientParse( PROTOCOL_ICARO, ( m ) => {

			cl.maxclients = 1;
			copyInto( m, msg );

		}, () => {

			const p = CL_GetPredictedPlayer( 0 );
			assertEqual( p.modelindex, 3001, 'player model' );
			assertEqual( p.origin[ 0 ], - 7000.5, 'player origin x' );
			assertEqual( p.origin[ 1 ], 9000, 'player origin y' );

		} );

	} finally {

		svs.clients = oldClients;
		svs.maxclients = oldMaxclients;
		sv.model_precache = oldPrecache;
		sv.time = oldTime;

	}

} );

//=============================================================================

Deno.test( 'ENTALPHA_ENCODE / DECODE / TOSAVE match Ironwail', () => {

	assertEqual( ENTALPHA_ENCODE( 0 ), ENTALPHA_DEFAULT, 'encode 0' );
	assertEqual( ENTALPHA_ENCODE( 1 ), ENTALPHA_ONE, 'encode 1' );
	assertEqual( ENTALPHA_ENCODE( 0.5 ), 128, 'encode 0.5' );
	assertEqual( ENTALPHA_ENCODE( - 1 ), ENTALPHA_ZERO, 'encode -1 (a saved ENTALPHA_ZERO)' );
	assertEqual( ENTALPHA_ENCODE( 2 ), ENTALPHA_ONE, 'encode clamps' );
	assertEqual( ENTALPHA_DECODE( ENTALPHA_DEFAULT ), 1, 'decode default' );
	assertEqual( ENTALPHA_DECODE( ENTALPHA_ZERO ), 0, 'decode zero' );
	assertEqual( ENTALPHA_TOSAVE( ENTALPHA_ZERO ), - 1, 'tosave zero' );
	assertEqual( ENTALPHA_ENCODE( ENTALPHA_TOSAVE( 128 ) ), 128, 'save round trip' );

} );

//=============================================================================
// The shareware attract demo, recorded with NetQuake 15

Deno.test( 'demo1.dem (protocol 15) parses message by message', async () => {

	await pak.COM_AddPakSequence( new URL( '../static/pak0.pak', import.meta.url ).pathname );
	const file = pak.COM_FindFile( 'demo1.dem' );
	const data = file.data.subarray( 0, file.size );
	const view = new DataView( data.buffer, data.byteOffset, data.byteLength );

	// the cd track line
	let pos = 0;
	while ( data[ pos ] !== 10 ) pos ++;
	pos ++;

	const saved = {
		data: net.net_message.data, maxsize: net.net_message.maxsize, cursize: net.net_message.cursize,
		common: common.net_message, demoplayback: cls.demoplayback, demonum: cls.demonum,
		message: { data: cls.message.data, maxsize: cls.message.maxsize, cursize: cls.message.cursize,
			allowoverflow: cls.message.allowoverflow },
		signon: cls.signon, protocol: cl.protocol, maxclients: cl.maxclients, scores: cl.scores,
		num_entities: cl.num_entities, num_statics: cl.num_statics,
	};

	let messages = 0;
	let ended = null;
	try {

		common.COM_SetNetMessage( net.net_message );
		net.net_message.data = new Uint8Array( 65536 );
		net.net_message.maxsize = 65536;
		cls.demoplayback = true;
		cls.demonum = - 1;
		common.SZ_Alloc( cls.message, 8192 );
		cls.message.allowoverflow = true;

		while ( pos + 16 <= data.length ) {

			const len = view.getInt32( pos, true );
			pos += 16; // length and view angles
			let msg = data.subarray( pos, pos + len );
			pos += len;

			// CL_ParseServerInfo loads the map and builds the renderer's
			// world, which the headless shim can't. Read the serverinfo here
			// and hand the parser svc_version 15 in its place.
			if ( messages === 0 ) msg = replaceServerinfo( msg );

			net.net_message.data.set( msg, 0 );
			net.net_message.cursize = msg.length;
			try {

				CL_ParseServerMessage();

			} catch ( e ) {

				ended = e;
				break;

			}

			assertEqual( common.msg_readcount, msg.length, `message ${messages} read length` );
			assertEqual( cl.protocol, PROTOCOL_VERSION, 'protocol' );
			messages ++;

		}

	} finally {

		net.net_message.data = saved.data;
		net.net_message.maxsize = saved.maxsize;
		net.net_message.cursize = saved.cursize;
		common.COM_SetNetMessage( saved.common );
		cls.demoplayback = saved.demoplayback;
		cls.demonum = saved.demonum;
		Object.assign( cls.message, saved.message );
		cls.signon = saved.signon;
		cl.protocol = saved.protocol;
		cl.maxclients = saved.maxclients;
		cl.scores = saved.scores;
		cl.num_entities = saved.num_entities;
		cl.num_statics = saved.num_statics;
		common.MSG_SetCoord32( true );
		CL_ResetPrediction();

	}

	// the demo ends with svc_disconnect
	if ( ended === null || ! String( ended.message ).includes( 'Server disconnected' ) )
		throw new Error( `demo stopped at message ${messages}: ${ended}` );
	if ( messages < 100 ) throw new Error( `only ${messages} messages` );
	assertEqual( pos, data.length, 'every message was read' );

} );

// The first demo message is svc_serverinfo and the signon that follows it.
// Returns svc_version 15 plus the rest, and sets what CL_ParseServerInfo would.
function replaceServerinfo( msg ) {

	let p = 0;
	if ( msg[ p ++ ] !== 11 ) throw new Error( 'demo1 does not start with svc_serverinfo' );
	const version = msg[ p ] | ( msg[ p + 1 ] << 8 ) | ( msg[ p + 2 ] << 16 ) | ( msg[ p + 3 ] << 24 );
	assertEqual( version, PROTOCOL_VERSION, 'demo protocol' );
	p += 4;
	cl.maxclients = msg[ p ++ ];
	cl.scores = [];
	for ( let i = 0; i < cl.maxclients; i ++ ) cl.scores.push( new scoreboard_t() );
	p ++; // gametype
	while ( msg[ p ] !== 0 ) p ++; // level name
	p ++;
	for ( let list = 0; list < 2; list ++ ) { // model, then sound precaches

		while ( msg[ p ] !== 0 ) {

			while ( msg[ p ] !== 0 ) p ++;
			p ++;

		}
		p ++;

	}

	const out = new Uint8Array( 5 + msg.length - p );
	out[ 0 ] = svc_version;
	new DataView( out.buffer ).setInt32( 1, PROTOCOL_VERSION, true );
	out.set( msg.subarray( p ), 5 );
	return out;

}
