// CL_PredictMove / CL_SetUpPlayerPrediction state handling (PRED-1, -4, -5)

import { CONTENTS_EMPTY, CONTENTS_SOLID } from '../src/bspfile.js';
import { cl } from '../src/client.js';
import { pmove } from '../src/pmove.js';
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

		// 40 solid brush entities: more than pmove.physents can hold
		const brush = { name: '*1', hulls: [ floorHull( - 1000 ), floorHull( - 1000 ) ] };
		cl.model_precache[ 1 ] = brush;
		CL_SetValidSequence( 1 );
		const pak = CL_GetEntityFrame( 1 ).packet_entities;
		pak.num_entities = 40;
		for ( let i = 0; i < 40; i ++ ) {

			pak.entities[ i ].number = i + 2;
			pak.entities[ i ].modelindex = 1;
			pak.entities[ i ].origin.fill( 0 );

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
