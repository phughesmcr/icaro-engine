// CL_SendMove stores the tick's full length for prediction, past QW's
// 255 ms byte, so prediction runs the same time host_timescale gives the
// server after a hitch.

import { cl, cls, ca_connected, SIGNONS } from '../src/client.js';
import {
	_Host_FilterTime, _Host_NetFrame, host_maxfps, host_netframetime, host_timescale
} from '../src/host.js';
import { CL_GetFrame, CL_GetOutgoingSequence } from '../src/cl_pred.js';

function assertNear( actual, expected, epsilon, message ) {

	if ( Number.isFinite( actual ) !== true || Math.abs( actual - expected ) > epsilon )
		throw new Error( `${message}: expected ${expected}, got ${actual}` );

}

function setCvar( v, value ) {

	v.string = String( value );
	v.value = value;

}

// Runs one network frame of dt real seconds and returns the stored msec
function sendFrame( dt ) {

	_Host_FilterTime( dt );
	cl.movemessages = 0; // CL_SendMove drops the first two: nothing is sent
	const before = CL_GetOutgoingSequence();
	_Host_NetFrame();
	if ( CL_GetOutgoingSequence() === before )
		throw new Error( 'no command stored' );
	return CL_GetFrame( CL_GetOutgoingSequence() - 1 ).cmd.msec;

}

function withConnected( fn ) {

	const old = {
		state: cls.state, signon: cls.signon, moves: cl.movemessages, cmd: cl.cmd,
		maxfps: host_maxfps.string, timescale: host_timescale.string
	};
	try {

		cls.state = ca_connected;
		cls.signon = SIGNONS;
		setCvar( host_maxfps, 0 );
		_Host_FilterTime( 1 );
		fn();

	} finally {

		cls.state = old.state;
		cls.signon = old.signon;
		cl.movemessages = old.moves;
		cl.cmd = old.cmd;
		setCvar( host_maxfps, Number( old.maxfps ) );
		setCvar( host_timescale, Number( old.timescale ) );
		_Host_FilterTime( 1 );

	}

}

Deno.test( 'a timescaled hitch is predicted for its whole length, past 255 ms', () => {

	withConnected( () => {

		setCvar( host_timescale, 4 );
		const msec = sendFrame( 0.25 ); // Ironwail adds at most 0.2 real seconds
		if ( host_netframetime <= 0.5 )
			throw new Error( `tick ${host_netframetime}: expected a long scaled tick` );
		assertNear( msec, host_netframetime * 1000, 1e-6, 'prediction runs the tick the server runs' );

	} );

} );

Deno.test( 'unscaled ticks still cap at 100 ms', () => {

	withConnected( () => {

		assertNear( sendFrame( 0.25 ), 100, 1e-6, 'msec' );

	} );

} );
