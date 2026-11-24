// CL_PredictMove / CL_SetUpPlayerPrediction state handling (PRED-1, -4, -5)

import { CONTENTS_EMPTY, CONTENTS_SOLID } from '../src/bspfile.js';
import { cl } from '../src/client.js';
import { pmove } from '../src/pmove.js';
import { PS_BSP, PS_BOX, PS_NOLERP, PF_FLY, PF_NOCLIP } from '../src/protocol.js';
import {
	CL_PredictMove, CL_SetUpPlayerPrediction, CL_SetPlayerInfo, CL_GetPredictedPlayer,
	CL_StoreCommand, CL_SetServerState, CL_SetValidSequence, CL_GetEntityFrame,
	CL_ResetPrediction, CL_InitPrediction, CL_GetFrame,
	cl_simorg
} from '../src/cl_pred.js';

function assertNear( actual, expected, epsilon, message ) {

	if ( Number.isFinite( actual ) !== true || Math.abs( actual - expected ) > epsilon )
		throw new Error( `${message}: expected ${expected}, got ${actual}` );

}

// Floor with its top at z = 0 (hull 1: origin z >= 24)
function floorHull( z ) {

	return {
		firstclipnode: 0,
		lastclipnode: 0,
		clipnodes: [ { planenum: 0, children: new Int16Array( [ CONTENTS_EMPTY, CONTENTS_SOLID ] ) } ],
		planes: [ { type: 2, dist: z, normal: new Float32Array( [ 0, 0, 1 ] ), signbits: 0 } ],
	};

}

const worldmodel = { name: 'maps/test.bsp', hulls: [ floorHull( 0 ), floorHull( 24 ) ] };

function idleCmd() {

	return { msec: 0, angles: new Float32Array( 3 ), forwardmove: 0, sidemove: 0, upmove: 0, buttons: 0, impulse: 0 };

}

function withClient( fn ) {

	const oldWorld = cl.worldmodel;
	const oldPrecache = cl.model_precache.slice();
	const oldTime = cl.time;
	const oldView = cl.viewentity;
	const oldHealth = cl.stats[ 0 ];
	try {

		CL_ResetPrediction();
		cl.worldmodel = worldmodel;
		cl.viewentity = 1;
		fn();

	} finally {

		CL_ResetPrediction();
		cl.worldmodel = oldWorld;
		for ( let i = 0; i < oldPrecache.length; i ++ )
			cl.model_precache[ i ] = oldPrecache[ i ];
		cl.time = oldTime;
		cl.viewentity = oldView;
		cl.stats[ 0 ] = oldHealth;

	}

}

let initialised = false;
function init() {

	if ( initialised )
		return;
	initialised = true;
	try {

		CL_InitPrediction();

	} catch ( e ) {

		// cvar / command registration may already have happened in this isolate
		void e;

	}

}

Deno.test( 'CL_SetUpPlayerPrediction extrapolates from the server state every call', () => {

	init();
	withClient( () => {

		const cmd = idleCmd();
		cmd.forwardmove = 0;
		// player 2, in the air moving +x, last update 100 ms ago
		CL_SetPlayerInfo( 1, new Float32Array( [ 0, 0, 500 ] ), new Float32Array( [ 300, 0, 0 ] ),
			0, 0, 0, 0, 0, 100, cmd, 1 );

		CL_SetUpPlayerPrediction( true );
		const first = CL_GetPredictedPlayer( 1 ).origin.slice();
		CL_SetUpPlayerPrediction( true );
		CL_SetUpPlayerPrediction( true );
		const third = CL_GetPredictedPlayer( 1 ).origin;

		if ( first[ 0 ] <= 0 )
			throw new Error( `expected forward extrapolation, got x ${first[ 0 ]}` );
		for ( let i = 0; i < 3; i ++ )
			assertNear( third[ i ], first[ i ], 0, `repeat call axis ${i}` );

		// dopred = false gives back the server position
		CL_SetUpPlayerPrediction( false );
		assertNear( CL_GetPredictedPlayer( 1 ).origin[ 0 ], 0, 0, 'unpredicted x' );

	} );

} );

Deno.test( 'CL_PredictMove leaves cl.time alone and survives a full physents list', () => {

	init();
	withClient( () => {

		// solid brush entities: more than pmove.physents can hold
		const brush = { name: '*1', hulls: [ floorHull( - 1000 ), floorHull( - 1000 ) ] };
		cl.model_precache[ 1 ] = brush;
		CL_SetValidSequence( 1 );
		const pak = CL_GetEntityFrame( 1 ).packet_entities;
		const count = pmove.physents.length + 10;
		pak.num_entities = count;
		for ( let i = 0; i < count; i ++ ) {

			const s = pak.state( i );
			s.number = i + 2;
			s.modelindex = 1;
			s.solid = PS_BSP;
			s.origin.fill( 0 );

		}

		// other players, so CL_SetSolidPlayers runs with the list full
		for ( let p = 1; p < 6; p ++ )
			CL_SetPlayerInfo( p, new Float32Array( [ p * 100, 0, 24 ] ), new Float32Array( 3 ),
				0, 0, 0, 0, 0, 0, null, 1 );

		cl.stats[ 0 ] = 100; // STAT_HEALTH
		CL_SetServerState( new Float32Array( [ 0, 0, 24 ] ), new Float32Array( 3 ), true );
		// sequence 0 is the acknowledged frame; sequence 1 gets predicted
		const cmd = idleCmd();
		cmd.msec = 13;
		cmd.forwardmove = 200;
		CL_StoreCommand( cmd, - 1 );
		CL_StoreCommand( cmd, - 0.5 );

		cl.time = 1234.5;
		CL_PredictMove();

		if ( cl.time !== 1234.5 )
			throw new Error( `cl.time changed to ${cl.time}` );
		if ( pmove.numphysent > pmove.physents.length )
			throw new Error( `numphysent ${pmove.numphysent} past the array` );
		if ( cl_simorg[ 0 ] <= 0 )
			throw new Error( `expected the player to move forward, got ${cl_simorg[ 0 ]}` );

	} );

} );

Deno.test( 'CL_ResetPrediction clears carried player state', () => {

	init();
	withClient( () => {

		const ps = CL_GetFrame( 0 ).playerstate;
		ps.oldbuttons = 2;
		ps.onground = true;
		ps.waterjumptime = 1;
		ps.waterlevel = 3;
		CL_SetPlayerInfo( 1, new Float32Array( [ 1, 2, 3 ] ), new Float32Array( 3 ),
			0, 0, 0, 0, 0, 0, null, 1 );

		CL_ResetPrediction();

		if ( ps.oldbuttons !== 0 || ps.onground !== false || ps.waterjumptime !== 0 || ps.waterlevel !== - 1 )
			throw new Error( 'frame player state survived the reset' );

		// server_sequence is 0 again; the old player must not match it
		CL_SetUpPlayerPrediction( false );
		if ( CL_GetPredictedPlayer( 1 ) !== null )
			throw new Error( 'predicted player survived the reset' );

	} );

} );

Deno.test( 'CL_SetSolidEntities uses the PE_SOLID info, brush entities first (PRED-5)', () => {

	init();
	withClient( () => {

		// an inline submodel: hull 1 has a non-zero headnode
		const doorHull = floorHull( - 1000 );
		doorHull.clipnodes.unshift( doorHull.clipnodes[ 0 ] );
		doorHull.firstclipnode = doorHull.lastclipnode = 1;
		const door = { name: '*1', hulls: [ floorHull( - 1000 ), doorHull ] };
		const monster = { name: 'progs/ogre.mdl' }; // alias model: no hulls
		cl.model_precache[ 1 ] = monster;
		cl.model_precache[ 2 ] = door;
		CL_SetValidSequence( 1 );
		const pak = CL_GetEntityFrame( 1 ).packet_entities;

		// a corpse, then more live monsters than physents, then a door last
		const monsters = pmove.physents.length + 5;
		pak.num_entities = 0;
		const add = ( number, modelindex, solid ) => {

			const s = pak.state( pak.num_entities ++ );
			s.number = number;
			s.modelindex = modelindex;
			s.solid = solid;
			s.origin.fill( 0 );
			s.origin[ 0 ] = number * 100;
			s.mins.fill( - 32 );
			s.mins[ 2 ] = - 24;
			s.maxs.fill( 32 );
			s.maxs[ 2 ] = 64;
			return s;

		};

		add( 10, 1, PS_NOLERP ); // corpse: model, but not solid
		for ( let i = 0; i < monsters; i ++ )
			add( 11 + i, 1, PS_BOX | PS_NOLERP );
		add( 11 + monsters, 2, PS_BSP );

		cl.stats[ 0 ] = 100; // STAT_HEALTH
		CL_SetServerState( new Float32Array( [ 0, 0, 24 ] ), new Float32Array( 3 ), true );
		const cmd = idleCmd();
		cmd.msec = 13;
		CL_StoreCommand( cmd, - 1 );
		CL_StoreCommand( cmd, - 0.5 );
		CL_PredictMove();

		const ents = pmove.physents.slice( 1, pmove.numphysent );
		if ( ents[ 0 ].info !== 11 + monsters || ents[ 0 ].model !== door )
			throw new Error( `expected the door first, got entity ${ents[ 0 ].info}` );
		if ( ents.some( ( pe ) => pe.info === 10 ) )
			throw new Error( 'the corpse is solid' );
		const ogre = ents.find( ( pe ) => pe.info === 11 );
		if ( ogre === undefined || ogre.model !== null || ogre.mins[ 0 ] !== - 32 || ogre.maxs[ 2 ] !== 64
			|| ogre.origin[ 0 ] !== 1100 )
			throw new Error( 'monster box missing or wrong' );
		if ( pmove.numphysent !== pmove.physents.length )
			throw new Error( `expected a full physents list, got ${pmove.numphysent}` );

	} );

} );

Deno.test( 'the view player\'s PF_FLY / PF_NOCLIP select the predicted movetype', () => {

	init();
	const predictFrom = ( origin, flags, move ) => {

		CL_ResetPrediction();
		cl.worldmodel = worldmodel;
		cl.stats[ 0 ] = 100; // STAT_HEALTH
		// the view player is player 0 (cl.viewentity 1)
		CL_SetPlayerInfo( 0, new Float32Array( origin ), new Float32Array( 3 ), 0, flags, 0, 0, 0, 0, null, 1 );
		const cmd = idleCmd();
		cmd.msec = 50;
		cmd.forwardmove = move[ 0 ];
		cmd.upmove = move[ 2 ];
		for ( let i = 0; i < 4; i ++ )
			CL_StoreCommand( cmd, - 1 + i * 0.05 );
		CL_PredictMove();
		return cl_simorg.slice();

	};

	withClient( () => {

		const fly = predictFrom( [ 0, 0, 500 ], PF_FLY, [ 0, 0, 200 ] );
		if ( fly[ 2 ] <= 500 )
			throw new Error( `flying player should rise, z ${fly[ 2 ]}` );

		const walk = predictFrom( [ 0, 0, 500 ], 0, [ 0, 0, 200 ] );
		if ( walk[ 2 ] >= 500 )
			throw new Error( `walking player should fall, z ${walk[ 2 ]}` );

		// noclip moves through the floor
		const noclip = predictFrom( [ 0, 0, - 50 ], PF_NOCLIP, [ 200, 0, 0 ] );
		if ( noclip[ 0 ] <= 0 )
			throw new Error( `noclip player should move inside the floor, x ${noclip[ 0 ]}` );

	} );

} );
