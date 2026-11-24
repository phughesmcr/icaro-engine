// Client prediction against the NetQuake server's player physics.
//
// The differential tests run the server's own SV_ClientThink / SV_WalkMove
// (sv_user.js, sv_phys.js) and the client's CL_PredictUsercmd in
// NetQuake-physics mode over the same synthetic map, frame by frame, and
// require the same origin and velocity.

import { CONTENTS_EMPTY, CONTENTS_SOLID } from '../src/bspfile.js';
import { MSG_WriteAngle, MSG_ReadAngle, MSG_BeginReading, SZ_Clear, net_message,
	COM_SetNetMessage } from '../src/common.js';
import { AngleVectors, DotProduct } from '../src/mathlib.js';
import { edict_t } from '../src/progs.js';
import { SV_RecursiveHullCheck, trace_t } from '../src/world.js';
import {
	SV_SetState, SV_SetFrametime, SV_SetPlayer, SV_SetCallbacks,
	SV_CheckVelocity, SV_CheckWater, SV_AddGravity, SV_WalkMove,
	MOVETYPE_WALK, SOLID_BSP, SOLID_SLIDEBOX, FL_ONGROUND, FL_JUMPRELEASED,
	sv_edgefriction
} from '../src/sv_phys.js';
import { SV_ClientThink, SV_User_SetCallbacks } from '../src/sv_user.js';
import { pmove, movevars, PM_NQ_InSolid } from '../src/pmove.js';
import { CL_PredictUsercmd, player_state_t, cl_nqpmove } from '../src/cl_pred.js';
import { CL_QuantizeAngle } from '../src/cl_input.js';

function assertNear( actual, expected, epsilon, message ) {

	if ( Number.isFinite( actual ) !== true || Math.abs( actual - expected ) > epsilon )
		throw new Error( `${message}: expected ${expected}, got ${actual}` );

}

//
// Synthetic map, in world units:
//   - floor top at z = 0 for x < 64, lower floor at z = -200 beyond (a ledge)
//   - wall face at y = 100 (solid for y >= 100)
// Hull 1 is the same brushes expanded by the player box (-16 -16 -24, 16 16 32).
//
function axisPlane( type, dist ) {

	const normal = new Float32Array( 3 );
	normal[ type ] = 1;
	return { type: type, dist: dist, normal: normal, signbits: 0 };

}

function makeHull( wallY, ledgeX, floorZ, lowFloorZ ) {

	// node 0: y >= wallY solid, else node 1
	// node 1: x >= ledgeX -> node 3 (low floor), else node 2 (high floor)
	// node 2: z >= floorZ empty, else solid
	// node 3: z >= lowFloorZ empty, else solid
	return {
		firstclipnode: 0,
		lastclipnode: 3,
		clipnodes: [
			{ planenum: 0, children: new Int16Array( [ CONTENTS_SOLID, 1 ] ) },
			{ planenum: 1, children: new Int16Array( [ 3, 2 ] ) },
			{ planenum: 2, children: new Int16Array( [ CONTENTS_EMPTY, CONTENTS_SOLID ] ) },
			{ planenum: 3, children: new Int16Array( [ CONTENTS_EMPTY, CONTENTS_SOLID ] ) },
		],
		planes: [
			axisPlane( 1, wallY ),
			axisPlane( 0, ledgeX ),
			axisPlane( 2, floorZ ),
			axisPlane( 2, lowFloorZ ),
		],
		clip_mins: new Float32Array( 3 ),
		clip_maxs: new Float32Array( 3 ),
	};

}

const dryWorld = {
	name: 'test',
	hulls: [ makeHull( 100, 64, 0, - 200 ), makeHull( 100 - 16, 64 + 16, 0 + 24, - 200 + 24 ) ]
};

// A pool: water below z = 0 down to a floor at z = -500. Water only
// exists in hull 0; the clip hulls only know solid and empty.
const CONTENTS_WATER = - 3;
const poolWorld = {
	name: 'pool',
	hulls: [ {
		firstclipnode: 0,
		lastclipnode: 1,
		clipnodes: [
			{ planenum: 0, children: new Int16Array( [ CONTENTS_EMPTY, 1 ] ) },
			{ planenum: 1, children: new Int16Array( [ CONTENTS_WATER, CONTENTS_SOLID ] ) },
		],
		planes: [ axisPlane( 2, 0 ), axisPlane( 2, - 500 ) ],
	}, {
		firstclipnode: 0,
		lastclipnode: 0,
		clipnodes: [ { planenum: 0, children: new Int16Array( [ CONTENTS_EMPTY, CONTENTS_SOLID ] ) } ],
		planes: [ axisPlane( 2, - 500 + 24 ) ],
	} ]
};

// A 16-unit step up at x = 0 (floor z = 0 before it, z = 16 after)
function stepHull( stepX, lowZ, highZ ) {

	return {
		firstclipnode: 0,
		lastclipnode: 2,
		clipnodes: [
			{ planenum: 0, children: new Int16Array( [ 2, 1 ] ) },
			{ planenum: 1, children: new Int16Array( [ CONTENTS_EMPTY, CONTENTS_SOLID ] ) },
			{ planenum: 2, children: new Int16Array( [ CONTENTS_EMPTY, CONTENTS_SOLID ] ) },
		],
		planes: [ axisPlane( 0, stepX ), axisPlane( 2, lowZ ), axisPlane( 2, highZ ) ],
	};

}
const stepWorld = {
	name: 'step',
	hulls: [ stepHull( 0, 0, 16 ), stepHull( - 16, 24, 40 ) ]
};

let worldmodel = dryWorld;

//
// Server side: the real sv_user / sv_phys code with SV_Move over the hulls
//
const worldEdict = new edict_t( 0, 106 );
worldEdict.v.solid = SOLID_BSP;

function testSV_Move( start, mins, maxs, end ) {

	const point = mins[ 0 ] === 0 && mins[ 1 ] === 0 && mins[ 2 ] === 0
		&& maxs[ 0 ] === 0 && maxs[ 1 ] === 0 && maxs[ 2 ] === 0;
	const hull = worldmodel.hulls[ point ? 0 : 1 ];

	const trace = new trace_t();
	trace.fraction = 1;
	trace.allsolid = true;
	trace.endpos.set( end );
	SV_RecursiveHullCheck( hull, hull.firstclipnode, 0, 1, start, end, trace );
	if ( trace.fraction !== 1 || trace.startsolid )
		trace.ent = worldEdict;
	return trace;

}

function testSV_PointContents( p ) {

	let num = 0;
	while ( num >= 0 ) {

		const hull = worldmodel.hulls[ 0 ];
		const node = hull.clipnodes[ num ];
		const plane = hull.planes[ node.planenum ];
		const d = p[ plane.type ] - plane.dist;
		num = d < 0 ? node.children[ 1 ] : node.children[ 0 ];

	}
	return num;

}

// WinQuake V_CalcRoll with the default cl_rollangle 2 / cl_rollspeed 200
const _roll_f = new Float32Array( 3 );
const _roll_r = new Float32Array( 3 );
const _roll_u = new Float32Array( 3 );
function testV_CalcRoll( angles, velocity ) {

	AngleVectors( angles, _roll_f, _roll_r, _roll_u );
	let side = DotProduct( velocity, _roll_r );
	const sign = side < 0 ? - 1 : 1;
	side = Math.abs( side );
	side = side < 200 ? side * 2 / 200 : 2;
	return side * sign;

}

const svState = { time: 0, edicts: [ worldEdict ], num_edicts: 1 };
const hostClient = { cmd: { forwardmove: 0, sidemove: 0, upmove: 0 } };

SV_SetState( svState, {}, { self: 0, other: 0, time: 0 } );
SV_SetCallbacks( {
	SV_Move: testSV_Move,
	SV_PointContents: testSV_PointContents,
	SV_LinkEdict: () => {},
	GetEdictFieldValue: () => null,
	EDICT_TO_PROG: () => 0,
} );
SV_User_SetCallbacks( { V_CalcRoll: testV_CalcRoll, host_client: hostClient } );

// Read an angle back the way SV_ReadClientMove does
const _anglebuf = { maxsize: 4, cursize: 0, data: new Uint8Array( 4 ), allowoverflow: false, overflowed: false };
function netAngle( f ) {

	const old = net_message;
	COM_SetNetMessage( _anglebuf );
	try {

		SZ_Clear( _anglebuf );
		MSG_WriteAngle( _anglebuf, f );
		MSG_BeginReading();
		return MSG_ReadAngle();

	} finally {

		COM_SetNetMessage( old );

	}

}

function makePlayer( origin, velocity, viewangles, onground ) {

	const ent = new edict_t( 1, 106 );
	ent.v.origin.set( origin );
	ent.v.velocity.set( velocity );
	ent.v.mins.set( [ - 16, - 16, - 24 ] );
	ent.v.maxs.set( [ 16, 16, 32 ] );
	ent.v.view_ofs.set( [ 0, 0, 22 ] );
	ent.v.solid = SOLID_SLIDEBOX;
	ent.v.movetype = MOVETYPE_WALK;
	ent.v.health = 100;
	ent.v.flags = FL_JUMPRELEASED | ( onground ? FL_ONGROUND : 0 );
	ent.v.angles[ 0 ] = - netAngle( viewangles[ 0 ] ) / 3;
	ent.v.angles[ 1 ] = netAngle( viewangles[ 1 ] );
	return ent;

}

// One server frame for a client: SV_RunClients, then SV_Physics_Client
// with id1's PlayerPreThink reduced to the jump (no water in this map).
function serverFrame( ent, viewangles, move, buttons, dt ) {

	SV_SetFrametime( dt );
	SV_SetPlayer( ent );

	for ( let i = 0; i < 3; i ++ )
		ent.v.v_angle[ i ] = netAngle( viewangles[ i ] );
	hostClient.cmd.forwardmove = move[ 0 ];
	hostClient.cmd.sidemove = move[ 1 ];
	hostClient.cmd.upmove = move[ 2 ];

	SV_ClientThink();

	// QC WaterMove drag (CheckWaterJump is left out: the pool has no edge)
	if ( ent.v.waterlevel !== 0 ) {

		const scale = 1 - 0.8 * ent.v.waterlevel * dt;
		for ( let i = 0; i < 3; i ++ )
			ent.v.velocity[ i ] *= scale;

	}

	// QC PlayerJump
	if ( buttons & 2 ) {

		if ( ( ent.v.flags & FL_ONGROUND ) && ( ent.v.flags & FL_JUMPRELEASED ) ) {

			ent.v.flags &= ~ ( FL_JUMPRELEASED | FL_ONGROUND );
			ent.v.velocity[ 2 ] += 270;

		}

	} else {

		ent.v.flags |= FL_JUMPRELEASED;

	}

	SV_CheckVelocity( ent );
	if ( ! SV_CheckWater( ent ) )
		SV_AddGravity( ent );
	SV_WalkMove( ent );

}

//
// Client side: CL_PredictUsercmd in NetQuake mode over the same hulls
//
function setupClientWorld( world ) {

	pmove.numphysent = 1;
	pmove.physents[ 0 ].model = world;
	pmove.physents[ 0 ].origin.fill( 0 );
	pmove.physents[ 0 ].info = 0;

}

function runDifferential( name, opts ) {

	const dt = opts.dt;
	worldmodel = opts.world || dryWorld;
	const ent = makePlayer( opts.origin, opts.velocity, opts.viewangles, opts.onground );
	SV_CheckWater( ent ); // last frame's waterlevel

	let from = new player_state_t();
	let to = new player_state_t();
	from.origin.set( opts.origin );
	from.velocity.set( opts.velocity );
	from.onground = opts.onground;

	const cmd = {
		msec: dt * 1000,
		angles: new Float32Array( 3 ),
		forwardmove: opts.move[ 0 ],
		sidemove: opts.move[ 1 ],
		upmove: opts.move[ 2 ],
		buttons: 0,
	};
	for ( let i = 0; i < 3; i ++ )
		cmd.angles[ i ] = CL_QuantizeAngle( opts.viewangles[ i ] );

	setupClientWorld( worldmodel );

	for ( let frame = 0; frame < opts.frames; frame ++ ) {

		const buttons = opts.buttons ? opts.buttons( frame ) : 0;
		cmd.buttons = buttons;

		serverFrame( ent, opts.viewangles, opts.move, buttons, dt );
		CL_PredictUsercmd( from, to, cmd, false, false );

		for ( let i = 0; i < 3; i ++ ) {

			assertNear( to.origin[ i ], ent.v.origin[ i ], 0.01, `${name} frame ${frame} origin[${i}]` );
			assertNear( to.velocity[ i ], ent.v.velocity[ i ], 0.01, `${name} frame ${frame} velocity[${i}]` );

		}
		if ( to.onground !== ( ( ent.v.flags & FL_ONGROUND ) !== 0 ) )
			throw new Error( `${name} frame ${frame}: onground ${to.onground}, server ${ent.v.flags & FL_ONGROUND}` );

		const t = from; from = to; to = t;

	}

	return ent;

}

function withNQ( fn ) {

	const oldNQ = cl_nqpmove.value;
	const oldEdge = sv_edgefriction.value;
	const oldNumPhysent = pmove.numphysent;
	try {

		cl_nqpmove.value = 1;
		sv_edgefriction.value = movevars.edgefriction;
		fn();

	} finally {

		cl_nqpmove.value = oldNQ;
		sv_edgefriction.value = oldEdge;
		pmove.numphysent = oldNumPhysent;

	}

}

Deno.test( 'NQ prediction: walking while looking down matches the server (pitch/3, no renormalise)', () => {

	withNQ( () => {

		const ent = runDifferential( 'pitch 80', {
			dt: 1 / 72, frames: 60, onground: true,
			origin: [ - 400, - 200, 24 ], velocity: [ 0, 0, 0 ],
			viewangles: [ 80, 33.7, 0 ], move: [ 320, 0, 0 ],
		} );
		// sanity: looking down really does slow the server's player
		// to cos( 80 / 3 ) * 320 = 286 (QW pmove would reach 320)
		const speed = Math.hypot( ent.v.velocity[ 0 ], ent.v.velocity[ 1 ] );
		if ( Math.abs( speed - 286 ) > 1 )
			throw new Error( `expected pitch to slow the player, got ${speed}` );

	} );

} );

Deno.test( 'NQ prediction: running off a ledge matches the server (edge friction, fall)', () => {

	withNQ( () => {

		runDifferential( 'ledge', {
			dt: 0.0137, frames: 50, onground: true,
			origin: [ 20, 0, 24 ], velocity: [ 150, 0, 0 ],
			viewangles: [ 0, 0, 0 ], move: [ 0, 0, 0 ],
		} );
		runDifferential( 'ledge run', {
			dt: 0.0137, frames: 50, onground: true,
			origin: [ - 100, 0, 24 ], velocity: [ 0, 0, 0 ],
			viewangles: [ 0, 0, 0 ], move: [ 400, 120, 0 ],
		} );

	} );

} );

Deno.test( 'NQ prediction: sliding along a wall matches the server (SV_WallFriction)', () => {

	withNQ( () => {

		runDifferential( 'wall', {
			dt: 1 / 60, frames: 40, onground: true,
			origin: [ - 300, 70, 24 ], velocity: [ 0, 0, 0 ],
			viewangles: [ 0, 80, 0 ], move: [ 400, 0, 0 ],
		} );

	} );

} );

Deno.test( 'NQ prediction: climbing a step matches the server (SV_WalkMove step-up)', () => {

	withNQ( () => {

		const ent = runDifferential( 'step', {
			dt: 1 / 72, frames: 60, onground: true, world: stepWorld,
			origin: [ - 100, 0, 24 ], velocity: [ 0, 0, 0 ],
			viewangles: [ 0, 20, 0 ], move: [ 320, 0, 0 ],
		} );
		if ( ent.v.origin[ 0 ] < 0 || ent.v.origin[ 2 ] < 39.9 )
			throw new Error( `expected the server's player on the step, at ${ent.v.origin}` );

	} );

} );

Deno.test( 'NQ prediction: jumping matches the server (friction and accel before +270)', () => {

	withNQ( () => {

		runDifferential( 'jump', {
			dt: 0.02, frames: 60, onground: true,
			origin: [ - 400, 0, 24 ], velocity: [ 200, 0, 0 ],
			viewangles: [ 0, 10, 0 ], move: [ 400, - 200, 0 ],
			buttons: ( frame ) => ( frame < 3 || ( frame > 40 && frame < 45 ) ) ? 2 : 0,
		} );

	} );

} );

Deno.test( 'NQ prediction: sv_maxvelocity clamp matches the server', () => {

	withNQ( () => {

		runDifferential( 'maxvelocity', {
			dt: 0.05, frames: 4, onground: false,
			origin: [ - 400, 0, 1000 ], velocity: [ 2500, - 3000, - 2500 ],
			viewangles: [ 0, 0, 0 ], move: [ 0, 0, 0 ],
		} );

	} );

} );

Deno.test( 'NQ prediction: swimming matches the server (SV_WaterMove, QC drag)', () => {

	withNQ( () => {

		runDifferential( 'swim', {
			dt: 1 / 72, frames: 60, onground: false, world: poolWorld,
			origin: [ 0, 0, - 200 ], velocity: [ 0, 0, 0 ],
			viewangles: [ 30, 45, 0 ], move: [ 400, 100, 0 ],
		} );
		runDifferential( 'sink', {
			dt: 1 / 72, frames: 60, onground: false, world: poolWorld,
			origin: [ 0, 0, - 200 ], velocity: [ 100, 0, 0 ],
			viewangles: [ 0, 0, 0 ], move: [ 0, 0, 0 ],
		} );
		runDifferential( 'dive in', {
			dt: 0.02, frames: 40, onground: false, world: poolWorld,
			origin: [ 0, 0, 60 ], velocity: [ 0, 0, - 300 ],
			viewangles: [ 60, 0, 0 ], move: [ 300, 0, 0 ],
		} );

	} );

} );

Deno.test( 'CL_QuantizeAngle matches the MSG_WriteAngle / MSG_ReadAngle round trip', () => {

	for ( let f = - 400; f <= 400; f += 0.37 ) {

		assertNear( CL_QuantizeAngle( f ), netAngle( f ), 0, `angle ${f}` );

	}

} );

Deno.test( 'QW-mode split runs a 255 ms command as 8 steps of 31 ms', () => {

	const oldNQ = cl_nqpmove.value;
	const oldNumPhysent = pmove.numphysent;
	try {

		cl_nqpmove.value = 0;
		pmove.numphysent = 0; // open space: no collisions

		const from = new player_state_t();
		const to = new player_state_t();
		from.velocity.set( [ 100, 0, 0 ] );
		const cmd = { msec: 255, angles: new Float32Array( 3 ), forwardmove: 0, sidemove: 0, upmove: 0, buttons: 0 };

		CL_PredictUsercmd( from, to, cmd, false, false );

		// 8 x 31 ms of free fall: x = 100 * 0.248; vz = -800 * 0.248
		assertNear( to.origin[ 0 ], 100 * 0.248, 0.001, 'distance covered' );
		assertNear( to.velocity[ 2 ], - 800 * 0.248, 0.001, 'gravity applied' );
		if ( cmd.msec !== 255 )
			throw new Error( 'command msec was modified' );

	} finally {

		cl_nqpmove.value = oldNQ;
		pmove.numphysent = oldNumPhysent;

	}

} );

Deno.test( 'NQ-mode split keeps fractional msec over the 100 ms limit', () => {

	withNQ( () => {

		pmove.numphysent = 0;
		const from = new player_state_t();
		const to = new player_state_t();
		from.origin.set( [ 0, 0, 1000 ] );
		from.velocity.set( [ 100, 0, 0 ] );
		const cmd = { msec: 250.5, angles: new Float32Array( 3 ), forwardmove: 0, sidemove: 0, upmove: 0, buttons: 0 };

		CL_PredictUsercmd( from, to, cmd, false, false );
		assertNear( to.origin[ 0 ], 100 * 0.2505, 0.001, 'distance covered' );

	} );

} );

Deno.test( 'PM_NQ_InSolid detects a player inside the world', () => {

	const oldNumPhysent = pmove.numphysent;
	try {

		setupClientWorld( dryWorld );
		if ( PM_NQ_InSolid( new Float32Array( [ 0, 0, 24 ] ) ) !== false )
			throw new Error( 'standing on the floor is not in solid' );
		if ( PM_NQ_InSolid( new Float32Array( [ 0, 0, 23.9 ] ) ) !== false )
			throw new Error( 'coordinate rounding into the floor is not in solid' );
		if ( PM_NQ_InSolid( new Float32Array( [ 0, 0, - 50 ] ) ) !== true )
			throw new Error( 'deep in the floor is in solid' );

	} finally {

		pmove.numphysent = oldNumPhysent;

	}

} );
