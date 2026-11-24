// Server fixes taken from Ironwail: the MAX_ENT_LEAFS PVS exception, fatpvs
// sized from the map, SV_TouchLinks surviving touch functions that change the
// trigger lists, pushers keeping their own solid, recoverable Host_Errors and
// the room's handling of a frame that throws.

import { sizebuf_t } from '../src/common.js';
import { CONTENTS_EMPTY } from '../src/bspfile.js';
import { OP_CALL0, OP_DONE } from '../src/pr_comp.js';
import { PR_AllocEdicts, ED_Free } from '../src/pr_edict.js';
import {
	MAX_ENT_LEAFS, EDICT_TO_PROG, PROG_TO_EDICT, NEXT_EDICT,
	progs, pr_functions, pr_statements, pr_global_struct, pr_globals_float, pr_globals_int,
	pr_builtins, pr_numbuiltins, pr_strings_data, sv as progs_sv,
	PR_SetStringsData, PR_SetProgs, PR_SetFunctions, PR_SetStatements, PR_SetGlobalStruct,
	PR_SetGlobalsFloat, PR_SetGlobalsInt, PR_SetBuiltins, PR_SetSV,
} from '../src/progs.js';
import {
	sv, svs, client_t,
	SOLID_NOT, SOLID_TRIGGER, SOLID_BBOX, SOLID_BSP, SOLID_SLIDEBOX,
	MOVETYPE_STEP, MOVETYPE_WALK, MOVETYPE_NONE, FL_ONGROUND,
} from '../src/server.js';
import { SV_WriteEntitiesToClient, SV_WritePlayersToClient, SV_FatPVS, SV_StartSound } from '../src/sv_main.js';
import { SV_ClearWorld, SV_LinkEdict, SV_HullForEntity, SV_Move, SV_TestEntityPosition } from '../src/world.js';
import { SV_PushMove, SV_PushRotate, SV_SetState, SV_SetCallbacks } from '../src/sv_phys.js';
import { MAX_EDICTS } from '../src/quakedef.js';
import { MAX_PACKET_ENTITIES, PE_ENT_MASK } from '../src/protocol.js';

const { Room_RunFrame } = await import( '../server/game_server.js' );

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

// Save and restore every sv field a test may change (Host_ShutdownServer
// replaces them all).
function withSavedServer( fn ) {

	const saved = Object.assign( {}, sv );
	const oldProgsSV = progs_sv;
	const oldClients = svs.clients;
	const oldMaxclients = svs.maxclients;

	try {

		return fn();

	} finally {

		Object.assign( sv, saved );
		PR_SetSV( oldProgsSV );
		svs.clients = oldClients;
		svs.maxclients = oldMaxclients;

	}

}

// A world with no brushes, big enough to split into area nodes
function setupWorld( numEdicts ) {

	const emptyHull = {
		firstclipnode: CONTENTS_EMPTY,
		lastclipnode: CONTENTS_EMPTY,
		clipnodes: [],
		planes: [],
		clip_mins: new Float32Array( 3 ),
	};
	const worldmodel = {
		type: 0,
		hulls: [ emptyHull, emptyHull, emptyHull ],
		mins: new Float32Array( [ - 4096, - 4096, - 4096 ] ),
		maxs: new Float32Array( [ 4096, 4096, 4096 ] ),
	};

	sv.edicts = PR_AllocEdicts( numEdicts, 105 );
	sv.num_edicts = numEdicts;
	sv.max_edicts = numEdicts;
	sv.models = new Array( 256 ).fill( null );
	sv.models[ 1 ] = worldmodel;
	sv.worldmodel = worldmodel;
	sv.time = 1;
	PR_SetSV( sv );
	SV_ClearWorld();
	return sv.edicts;

}

function setBox( ent, origin, size ) {

	for ( let i = 0; i < 3; i ++ ) {

		ent.v.origin[ i ] = origin[ i ];
		ent.v.mins[ i ] = - size;
		ent.v.maxs[ i ] = size;

	}

}

// QuakeC functions 1..n that each call JS callback i, through a builtin:
// function i is "builtin_i(); done", function n + i is builtin #i.
function withTouchFunctions( callbacks, fn ) {

	const oldProgs = progs;
	const oldFunctions = pr_functions;
	const oldStatements = pr_statements;
	const oldGlobalStruct = pr_global_struct;
	const oldGlobalsFloat = pr_globals_float;
	const oldGlobalsInt = pr_globals_int;
	const oldBuiltins = pr_builtins;
	const oldNumBuiltins = pr_numbuiltins;

	const n = callbacks.length;
	const buffer = new ArrayBuffer( 128 * 4 );
	const globalsInt = new Int32Array( buffer );
	const functions = [ { first_statement: 0, parm_start: 0, locals: 0, numparms: 0, parm_size: [] } ];
	const statements = [ { op: OP_DONE, a: 0, b: 0, c: 0 } ];
	const builtins = [ null ];

	for ( let i = 1; i <= n; i ++ ) {

		const global = 64 + i;
		globalsInt[ global ] = n + i;
		functions[ i ] = { first_statement: statements.length, parm_start: 0, locals: 0, numparms: 0, parm_size: [] };
		statements.push( { op: OP_CALL0, a: global, b: 0, c: 0 } );
		statements.push( { op: OP_DONE, a: 0, b: 0, c: 0 } );
		builtins[ i ] = callbacks[ i - 1 ];

	}

	for ( let i = 1; i <= n; i ++ )
		functions[ n + i ] = { first_statement: - i, parm_start: 0, locals: 0, numparms: 0, parm_size: [] };

	try {

		PR_SetProgs( { numfunctions: functions.length } );
		PR_SetFunctions( functions );
		PR_SetStatements( statements );
		PR_SetGlobalStruct( { self: 0, other: 0, time: 0 } );
		PR_SetGlobalsFloat( new Float32Array( buffer ) );
		PR_SetGlobalsInt( globalsInt );
		PR_SetBuiltins( builtins, builtins.length );
		fn();

	} finally {

		PR_SetProgs( oldProgs );
		PR_SetFunctions( oldFunctions );
		PR_SetStatements( oldStatements );
		PR_SetGlobalStruct( oldGlobalStruct );
		PR_SetGlobalsFloat( oldGlobalsFloat );
		PR_SetGlobalsInt( oldGlobalsInt );
		PR_SetBuiltins( oldBuiltins, oldNumBuiltins );

	}

}

function makeTrigger( ent, origin, size, touchFunction ) {

	setBox( ent, origin, size );
	ent.v.solid = SOLID_TRIGGER;
	ent.v.touch = touchFunction;
	SV_LinkEdict( ent, false );

}

Deno.test( 'SV_WriteEntitiesToClient sends an entity in MAX_ENT_LEAFS leafs even if none is visible', () => {

	withSavedServer( () => {

		const edicts = PR_AllocEdicts( 8, 105 );
		PR_SetSV( { max_edicts: 8, num_edicts: 8, edicts } );
		sv.num_edicts = 8;
		sv.model_precache = [ '', 'maps/x.bsp', 'progs/a.mdl' ];
		svs.maxclients = 1;

		const client = new client_t();
		const pvs = new Uint8Array( [ 1 ] ); // only leaf 0 visible
		for ( const e of [ 2, 3 ] ) {

			edicts[ e ].v.modelindex = 2;
			edicts[ e ].v.model = 0;

		}

		return withStrings( () => {

			for ( const [ e, count ] of [ [ 2, MAX_ENT_LEAFS ], [ 3, MAX_ENT_LEAFS - 1 ] ] ) {

				edicts[ e ].num_leafs = count;
				for ( let i = 0; i < count; i ++ )
					edicts[ e ].leafnums[ i ] = 8 + i; // none of them visible

			}

			SV_WriteEntitiesToClient( client, edicts[ 1 ], pvs, makeMsg( 1024 ) );
			const pack = client.frames[ 0 ].entities;
			assert( pack.num_entities === 1, `expected 1 entity, got ${pack.num_entities}` );
			assert( pack.state( 0 ).number === 2, `sent entity ${pack.state( 0 ).number}, expected the 16-leaf one` );

		} );

	} );

} );

// PR_GetString reads pr_strings_data: give offset 0 a one-letter string, so
// v.model = 0 is a non-empty model name
function withStrings( fn ) {

	const oldData = pr_strings_data;
	try {

		PR_SetStringsData( new Uint8Array( [ 0x61, 0 ] ) );
		return fn();

	} finally {

		PR_SetStringsData( oldData );

	}

}

Deno.test( 'SV_WritePlayersToClient sends a player in MAX_ENT_LEAFS leafs even if none is visible', () => {

	withSavedServer( () => {

		const edicts = PR_AllocEdicts( 4, 105 );
		sv.model_precache = [ '', 'progs/player.mdl' ];
		sv.time = 1;
		svs.maxclients = 2;
		svs.clients = [];
		for ( let i = 0; i < 2; i ++ ) {

			edicts[ i + 1 ].v.modelindex = 1;
			svs.clients.push( {
				active: true, spawned: true, edict: edicts[ i + 1 ], localtime: 0,
				lastcmd: { forwardmove: 0, sidemove: 0, upmove: 0, angles: [ 0, 0, 0 ] }
			} );

		}

		const pvs = new Uint8Array( [ 1 ] ); // only leaf 0 visible
		const other = edicts[ 2 ];

		for ( const [ count, expectSent ] of [ [ MAX_ENT_LEAFS, true ], [ MAX_ENT_LEAFS - 1, false ] ] ) {

			other.num_leafs = count;
			for ( let i = 0; i < count; i ++ )
				other.leafnums[ i ] = 8 + i;

			// the viewer is skipped by the PVS test, so only `other` can be sent
			const msg = makeMsg( 1024 );
			SV_WritePlayersToClient( svs.clients[ 0 ], edicts[ 1 ], pvs, msg );
			const before = msg.cursize;

			svs.clients[ 1 ].active = false;
			const alone = makeMsg( 1024 );
			SV_WritePlayersToClient( svs.clients[ 0 ], edicts[ 1 ], pvs, alone );
			svs.clients[ 1 ].active = true;

			assert( ( before > alone.cursize ) === expectSent,
				`${count} leafs: sent ${before} bytes, ${alone.cursize} without the other player` );

		}

	} );

} );

Deno.test( 'SV_FatPVS is sized from the world model, not a fixed MAX_MAP_LEAFS', () => {

	withSavedServer( () => {

		const leaf = { contents: CONTENTS_EMPTY, compressed_vis: null, compressed_vis_offset: 0 };
		for ( const numleafs of [ 8192, 20000 ] ) {

			sv.worldmodel = { numleafs, leafs: [ {} ], nodes: [ leaf ] };
			const pvs = SV_FatPVS( new Float32Array( 3 ) );
			const fatbytes = ( numleafs + 31 ) >> 3;
			// The bits come from Mod_LeafPVS, whose buffer gl_model.js still
			// sizes from MAX_MAP_LEAFS, so only check fatpvs' own size here.
			assert( pvs.length >= fatbytes, `${numleafs} leafs: fatpvs has ${pvs.length} bytes, needs ${fatbytes}` );
			assert( pvs[ 0 ] === 0xff, `${numleafs} leafs: no-vis leaf should see everything` );

		}

	} );

} );

Deno.test( 'SV_TouchLinks skips a trigger that an earlier touch removed', () => {

	withSavedServer( () => {

		const edicts = setupWorld( 8 );
		const player = edicts[ 1 ];
		const a = edicts[ 2 ];
		const b = edicts[ 3 ];
		const touched = [];

		withTouchFunctions( [
			() => {

				touched.push( 'a' );
				ED_Free( b );

			},
			() => touched.push( 'b' ),
		], () => {

			makeTrigger( a, [ 0, 0, 0 ], 32, 1 );
			makeTrigger( b, [ 0, 0, 0 ], 32, 2 );
			setBox( player, [ 0, 0, 0 ], 16 );
			player.v.solid = SOLID_SLIDEBOX;
			SV_LinkEdict( player, true );

		} );

		// the trigger list holds b before a (InsertLinkBefore appends), so
		// check whichever ran first removed the other
		assert( touched.length === 1, `touched ${touched.join()}` );

	} );

} );

Deno.test( 'SV_TouchLinks survives a touch that moves the next trigger to another area node', () => {

	withSavedServer( () => {

		const edicts = setupWorld( 8 );
		const player = edicts[ 1 ];
		const a = edicts[ 2 ];
		const b = edicts[ 3 ];
		const touched = [];

		// whichever trigger runs first moves the other far away, into a
		// child area node's list. C's walk would follow it into that list
		// and never get back to this node's head.
		const moveAway = ( ent ) => {

			setBox( ent, [ 3000, 3000, 3000 ], 32 );
			SV_LinkEdict( ent, false );

		};

		withTouchFunctions( [
			() => {

				touched.push( 'a' );
				moveAway( b );

			},
			() => {

				touched.push( 'b' );
				moveAway( a );

			},
		], () => {

			makeTrigger( a, [ 0, 0, 0 ], 32, 1 );
			makeTrigger( b, [ 0, 0, 0 ], 32, 2 );
			setBox( player, [ 0, 0, 0 ], 16 );
			player.v.solid = SOLID_SLIDEBOX;
			SV_LinkEdict( player, true );

		} );

		assert( touched.length === 1, `touched ${touched.join()}` );

	} );

} );

Deno.test( 'SV_TouchLinks keeps its list across a nested SV_TouchLinks', () => {

	withSavedServer( () => {

		const edicts = setupWorld( 8 );
		const player = edicts[ 1 ];
		const a = edicts[ 2 ];
		const b = edicts[ 3 ];
		const far = edicts[ 4 ];
		const monster = edicts[ 5 ];
		const touched = [];

		withTouchFunctions( [
			// a's or b's touch relinks a monster onto the far trigger, which
			// runs a nested SV_TouchLinks with its own list
			() => {

				touched.push( 'near:' + pr_global_struct.self );
				if ( touched.length === 1 )
					SV_LinkEdict( monster, true );

			},
			() => touched.push( 'far' ),
		], () => {

			makeTrigger( a, [ 0, 0, 0 ], 32, 1 );
			makeTrigger( b, [ 0, 0, 0 ], 32, 1 );
			makeTrigger( far, [ 3000, 3000, 3000 ], 32, 2 );
			setBox( monster, [ 3000, 3000, 3000 ], 16 );
			monster.v.solid = SOLID_SLIDEBOX;
			setBox( player, [ 0, 0, 0 ], 16 );
			player.v.solid = SOLID_SLIDEBOX;
			SV_LinkEdict( player, true );

		} );

		assert( touched.length === 3, `touched ${touched.join()}` );
		assert( touched[ 1 ] === 'far', `nested touch missing: ${touched.join()}` );
		assert( touched[ 0 ] !== touched[ 2 ], `both near triggers should run once: ${touched.join()}` );

	} );

} );

Deno.test( 'SV_PushMove and SV_PushRotate leave a pusher with its own solid', () => {

	withSavedServer( () => {

		const edicts = setupWorld( 8 );
		// wire sv_phys.js to the world as SV_SpawnServer does
		SV_SetState( sv, svs, { self: 0, other: 0, time: 0 } );
		SV_SetCallbacks( { SV_Move, SV_TestEntityPosition, SV_LinkEdict, EDICT_TO_PROG, PROG_TO_EDICT, NEXT_EDICT } );
		const pusher = edicts[ 1 ];
		const rider = edicts[ 2 ];

		for ( const [ name, push ] of [ [ 'SV_PushMove', SV_PushMove ], [ 'SV_PushRotate', SV_PushRotate ] ] ) {

			for ( const [ solid, expectPushed ] of [ [ SOLID_TRIGGER, false ], [ SOLID_NOT, false ], [ SOLID_BBOX, true ] ] ) {

				setBox( pusher, [ 0, 0, 0 ], 8 );
				pusher.v.angles.fill( 0 );
				pusher.v.solid = solid;
				pusher.v.movetype = MOVETYPE_NONE; // not skipped as a pusher is
				pusher.v.velocity.fill( 0 );
				pusher.v.avelocity.fill( 0 );
				if ( push === SV_PushMove )
					pusher.v.velocity[ 0 ] = 100; // 10 units in x
				else
					pusher.v.avelocity[ 1 ] = 900; // 90 degrees of yaw
				pusher.v.ltime = 0;
				SV_LinkEdict( pusher, false );

				// off the rotation axis, so a rotation moves it too
				setBox( rider, [ 20, 0, 40 ], 8 );
				rider.v.solid = SOLID_SLIDEBOX;
				rider.v.movetype = MOVETYPE_WALK;
				rider.v.flags = FL_ONGROUND;
				rider.v.groundentity = pusher.index;
				SV_LinkEdict( rider, false );

				push( pusher, 0.1 );

				const moved = Math.abs( rider.v.origin[ 0 ] - 20 ) > 1 || Math.abs( rider.v.origin[ 1 ] ) > 1;
				assert( pusher.v.solid === solid, `${name}: pusher solid ${solid} became ${pusher.v.solid}` );
				assert( moved === expectPushed,
					`${name} solid ${solid}: rider at ${rider.v.origin[ 0 ]} ${rider.v.origin[ 1 ]}` );

			}

		}

	} );

} );

function expectHostError( action, message ) {

	let caught = null;
	try {

		action();

	} catch ( error ) {

		caught = error;

	}

	assert( caught !== null && caught.message === 'Host_Error: ' + message, `expected Host_Error ${message}, got ${caught}` );

}

Deno.test( 'map and QuakeC errors that Ironwail made recoverable use Host_Error', () => {

	withSavedServer( () => {

		sv.active = false; // no server to shut down
		expectHostError( () => SV_StartSound( null, 0, 'x.wav', 300, 1 ), 'SV_StartSound: volume = 300' );
		expectHostError( () => SV_StartSound( null, 0, 'x.wav', 255, 5 ), 'SV_StartSound: attenuation = 5' );
		expectHostError( () => SV_StartSound( null, 8, 'x.wav', 255, 1 ), 'SV_StartSound: channel = 8' );

		const edicts = setupWorld( 4 );
		const ent = edicts[ 1 ];
		const v3 = new Float32Array( 3 );
		ent.v.solid = SOLID_BSP;
		ent.v.movetype = MOVETYPE_STEP;
		expectHostError( () => SV_HullForEntity( ent, v3, v3, v3 ), 'SOLID_BSP without MOVETYPE_PUSH' );

	} );

} );

Deno.test( 'Room_RunFrame ends the room on any error, shutting the server down', () => {

	withSavedServer( () => {

		svs.maxclients = 0;
		svs.clients = [];

		sv.active = true;
		assert( Room_RunFrame( () => {} ) === false, 'a clean frame keeps the room' );

		// Sys_Error or a JavaScript error mid-frame leaves sv.active set
		sv.active = true;
		assert( Room_RunFrame( () => {

			throw new Error( 'Sys_Error: test' );

		} ) === true, 'a throw ends the room' );
		assert( sv.active === false, 'the server was shut down' );

		// Host_Error has already shut the server down before throwing
		sv.active = true;
		assert( Room_RunFrame( () => {

			sv.active = false;
			throw new Error( 'Host_Error: test' );

		} ) === true, 'a Host_Error ends the room' );

		// a level change that fails leaves the server inactive without a throw
		sv.active = true;
		assert( Room_RunFrame( () => {

			sv.active = false;

		} ) === true, 'an inactive server ends the room' );

	} );

} );

Deno.test( 'MAX_EDICTS fits the packet entities protocol', () => {

	assert( MAX_EDICTS > 600, `MAX_EDICTS is ${MAX_EDICTS}` );
	assert( MAX_EDICTS - 1 <= PE_ENT_MASK, 'entity numbers must fit PE_ENT_BITS' );
	assert( MAX_PACKET_ENTITIES >= MAX_EDICTS, 'packet cap must not bind before the edict limit' );

} );
