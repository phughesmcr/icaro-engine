// host_maxfps: renderer/network isolation timing (host.js) and the partial
// command prediction runs between ticks (cl_pred.js)

import { CONTENTS_EMPTY, CONTENTS_SOLID } from '../src/bspfile.js';
import { cl } from '../src/client.js';
import {
	Host_NetTickTime, HOST_NETINTERVAL, HOST_NETTICK_SLACK, _Host_FilterTime,
	host_maxfps, host_netinterval, set_host_netinterval, set_host_netaccum
} from '../src/host.js';
import {
	CL_PredictMove, CL_StoreCommand, CL_SetServerState, CL_ResetPrediction,
	CL_InitPrediction, cl_simorg
} from '../src/cl_pred.js';

const I = HOST_NETINTERVAL;

function assertNear( actual, expected, epsilon, message ) {

	if ( Number.isFinite( actual ) !== true || Math.abs( actual - expected ) > epsilon )
		throw new Error( `${message}: expected ${expected}, got ${actual}` );

}

// Deterministic frame times: 1/hz, plus or minus up to jitter seconds
function frameTimes( hz, jitter, seconds ) {

	let seed = 12345;
	const out = [];
	const frames = Math.round( hz * seconds );
	for ( let f = 0; f < frames; f ++ ) {

		seed = ( seed * 16807 ) % 2147483647;
		out.push( 1 / hz + ( seed / 2147483647 * 2 - 1 ) * jitter );

	}

	return out;

}

// Runs the network tick the way host.js _Host_NetFrame does
function runTicks( times ) {

	let accum = 0;
	let total = 0;
	let ticked = 0;
	const ticks = [];
	for ( const dt of times ) {

		total += dt;
		accum += dt;
		const tick = Host_NetTickTime( accum, I );
		if ( tick > 0 ) {

			accum -= tick;
			ticked += tick;

		}

		ticks.push( tick );
		if ( accum < - HOST_NETTICK_SLACK - 1e-12 || accum > I + 1e-12 )
			throw new Error( `carry ${accum} outside [-slack, interval]` );

	}

	return { ticks, accum, total, ticked };

}

Deno.test( 'Host_NetTickTime keeps a 72 Hz tick without drift at common display rates', () => {

	const cases = [
		[ 72, 0 ], [ 72, 0.0002 ], [ 75, 0 ], [ 90, 0 ], [ 90, 0.0005 ],
		[ 120, 0 ], [ 144, 0 ], [ 144, 0.0005 ], [ 160, 0 ], [ 240, 0 ]
	];
	for ( const [ hz, jitter ] of cases ) {

		const seconds = 10;
		const r = runTicks( frameTimes( hz, jitter, seconds ) );
		const label = `${hz} Hz +-${jitter * 1000} ms`;

		// no drift: every bit of frame time is ticked or still carried
		assertNear( r.ticked + r.accum, r.total, 1e-9, `${label} time` );

		// 72 ticks a second, at most one per frame
		const count = r.ticks.filter( ( t ) => t > 0 ).length;
		if ( Math.abs( count - 72 * seconds ) > 1 )
			throw new Error( `${label}: ${count} ticks in ${seconds} s` );

		// each tick is one interval, apart from a catch-up after jitter
		for ( const t of r.ticks ) {

			if ( t > 0 && ( t < I || t > I + 2 * jitter + 1e-12 ) )
				throw new Error( `${label}: tick of ${t * 1000} ms` );

		}

	}

} );

Deno.test( 'Host_NetTickTime ticks every frame below 72 Hz, one frame time each', () => {

	const r = runTicks( frameTimes( 60, 0, 10 ) );
	if ( r.ticks.some( ( t ) => t === 0 ) )
		throw new Error( 'a 60 Hz frame ran no tick' );
	assertNear( r.ticked + r.accum, r.total, 1e-9, '60 Hz time' );
	// after the carry fills up, each tick is the whole frame
	for ( const t of r.ticks.slice( 10 ) )
		assertNear( t, 1 / 60, 1e-9, '60 Hz tick' );

} );

Deno.test( 'Host_NetTickTime takes a hitch in one tick, then goes back to the interval', () => {

	const times = frameTimes( 144, 0, 1 );
	times[ 50 ] = 0.2; // the most _Host_NetFrame adds in one frame
	const r = runTicks( times );
	assertNear( r.ticked + r.accum, r.total, 1e-9, 'hitch time' );
	// all but one interval of the time so far runs in the hitch's tick
	const carried = runTicks( times.slice( 0, 50 ) ).accum;
	assertNear( r.ticks[ 50 ], carried + 0.2 - I, 1e-9, 'hitch tick' );
	for ( const t of r.ticks.slice( 52 ) )
		if ( t !== 0 && Math.abs( t - I ) > 1e-12 )
			throw new Error( `tick of ${t * 1000} ms after the hitch` );

} );

function withMaxfps( value, fn ) {

	const oldString = host_maxfps.string;
	const oldValue = host_maxfps.value;
	try {

		host_maxfps.string = String( value );
		host_maxfps.value = value;
		fn();

	} finally {

		host_maxfps.string = oldString;
		host_maxfps.value = oldValue;
		_Host_FilterTime( 1 ); // back to the single loop

	}

}

Deno.test( '_Host_FilterTime with the default host_maxfps matches WinQuake frame for frame', () => {

	withMaxfps( 72, () => {

		_Host_FilterTime( 1 ); // a frame always runs: realtime and oldrealtime agree
		let realtime = 0;
		let oldrealtime = 0;
		for ( const hz of [ 60, 72, 90, 120, 144 ] ) {

			for ( const dt of frameTimes( hz, 0.0003, 2 ) ) {

				realtime += dt;
				const expected = realtime - oldrealtime >= 1.0 / 72.0;
				if ( expected )
					oldrealtime = realtime;
				const ran = _Host_FilterTime( dt );
				if ( ran !== expected )
					throw new Error( `${hz} Hz: frame ran ${ran}, WinQuake ${expected}` );
				if ( host_netinterval !== 0 )
					throw new Error( 'isolation turned on at host_maxfps 72' );

			}

		}

	} );

} );

Deno.test( '_Host_FilterTime renders up to host_maxfps once isolated', () => {

	for ( const [ maxfps, hz, expected ] of [ [ 0, 144, 144 ], [ 250, 144, 144 ], [ 144, 144, 144 ], [ 100, 144, 100 ], [ 120, 240, 120 ] ] ) {

		withMaxfps( maxfps, () => {

			_Host_FilterTime( 1 );
			if ( host_netinterval !== I )
				throw new Error( `host_maxfps ${maxfps} did not isolate` );
			let frames = 0;
			for ( const dt of frameTimes( hz, 0.0003, 10 ) )
				if ( _Host_FilterTime( dt ) )
					frames ++;
			if ( Math.abs( frames / 10 - expected ) > 1 )
				throw new Error( `host_maxfps ${maxfps} at ${hz} Hz: ${frames / 10} fps, expected ${expected}` );

		} );

	}

} );

// Floor with its top at z = 0 (hull 1: origin z >= 24)
function floorHull( z ) {

	return {
		firstclipnode: 0,
		lastclipnode: 0,
		clipnodes: [ { planenum: 0, children: new Int16Array( [ CONTENTS_EMPTY, CONTENTS_SOLID ] ) } ],
		planes: [ { type: 2, dist: z, normal: new Float32Array( [ 0, 0, 1 ] ), signbits: 0 } ],
	};

}

function forwardCmd( msec ) {

	return { msec, angles: new Float32Array( 3 ), forwardmove: 200, sidemove: 0, upmove: 0, buttons: 0, impulse: 0 };

}

let initialised = false;

function withIsolatedPrediction( fn ) {

	if ( initialised === false ) {

		initialised = true;
		try {

			CL_InitPrediction();

		} catch ( e ) {

			// cvar / command registration may already have happened in this isolate
			void e;

		}

	}

	const oldWorld = cl.worldmodel;
	const oldView = cl.viewentity;
	const oldHealth = cl.stats[ 0 ];
	const oldAngles = cl.viewangles.slice();
	try {

		CL_ResetPrediction();
		cl.worldmodel = { name: 'maps/test.bsp', hulls: [ floorHull( 0 ), floorHull( 24 ) ] };
		cl.viewentity = 1;
		cl.stats[ 0 ] = 100; // STAT_HEALTH
		cl.viewangles.fill( 0 );
		set_host_netinterval( I );
		fn();

	} finally {

		set_host_netinterval( 0 );
		set_host_netaccum( 0 );
		CL_ResetPrediction();
		cl.worldmodel = oldWorld;
		cl.viewentity = oldView;
		cl.stats[ 0 ] = oldHealth;
		cl.viewangles.set( oldAngles );

	}

}

// Acknowledged state on the floor, then n commands moving forward
function setupCommands( n ) {

	CL_SetServerState( new Float32Array( [ 0, 0, 24 ] ), new Float32Array( 3 ), true );
	CL_StoreCommand( forwardCmd( 0 ), - 2 ); // sequence 0, the acknowledged one
	for ( let i = 0; i < n; i ++ )
		CL_StoreCommand( forwardCmd( I * 1000 ), - 1 + i * 0.001 );

}

function predictAt( accum ) {

	set_host_netaccum( accum );
	CL_PredictMove();
	return cl_simorg[ 0 ];

}

Deno.test( 'isolated prediction moves the view between ticks and runs on into the next command', () => {

	withIsolatedPrediction( () => {

		setupCommands( 4 );

		// between ticks the view moves forward with the untimed time
		let last = - Infinity;
		for ( let k = 0; k <= 8; k ++ ) {

			const x = predictAt( I * k / 8 );
			if ( x <= last && k > 0 )
				throw new Error( `view went back between ticks: ${last} then ${x}` );
			last = x;

		}

		// no time to predict: the newest command's state
		const atTick = predictAt( 0 );
		const fullTick = predictAt( I );
		if ( ! ( fullTick > atTick ) )
			throw new Error( `partial move did not move: ${atTick} -> ${fullTick}` );

		// the next tick sends one interval with the same input; the view right
		// after it is where the partial move had it just before
		CL_StoreCommand( forwardCmd( I * 1000 ), 0.5 );
		const afterTick = predictAt( 0 );
		assertNear( afterTick, fullTick, 1e-3, 'view across the tick' );

	} );

} );

Deno.test( 'prediction ignores host_netaccum while isolation is off', () => {

	withIsolatedPrediction( () => {

		setupCommands( 4 );
		set_host_netinterval( 0 );
		const a = predictAt( 0 );
		const b = predictAt( I / 2 );
		assertNear( b, a, 0, 'single loop view' );

	} );

} );
