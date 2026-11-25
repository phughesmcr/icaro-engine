// host_timescale (johnfitz, Ironwail host.c Host_AdvanceTime and _Host_Frame):
// scales the frame time, and in the isolated loop each tick's length

import {
	_Host_FilterTime, _Host_NetFrame, HOST_NETINTERVAL,
	host_maxfps, host_timescale, host_frametime, host_netframetime, host_netaccum, host_netinterval
} from '../src/host.js';

function assertNear( actual, expected, epsilon, message ) {

	if ( Number.isFinite( actual ) !== true || Math.abs( actual - expected ) > epsilon )
		throw new Error( `${message}: expected ${expected}, got ${actual}` );

}

function withCvars( maxfps, timescale, fn ) {

	const old = [ host_maxfps.string, host_maxfps.value, host_timescale.string, host_timescale.value ];
	try {

		host_maxfps.string = String( maxfps );
		host_maxfps.value = maxfps;
		host_timescale.string = String( timescale );
		host_timescale.value = timescale;
		fn();

	} finally {

		[ host_maxfps.string, host_maxfps.value, host_timescale.string, host_timescale.value ] = old;
		_Host_FilterTime( 1 ); // back to the single loop

	}

}

Deno.test( 'host_timescale defaults to 0, which leaves frame times alone', () => {

	if ( host_timescale.name !== 'host_timescale' || host_timescale.string !== '0' )
		throw new Error( 'cvar name or default' );
	withCvars( 72, 0, () => {

		_Host_FilterTime( 1 );
		_Host_FilterTime( 0.02 );
		assertNear( host_frametime, 0.02, 1e-12, 'unscaled' );

	} );

} );

Deno.test( 'host_timescale scales the frame time and skips the clamp', () => {

	withCvars( 72, 0.5, () => {

		_Host_FilterTime( 1 );
		_Host_FilterTime( 0.02 );
		assertNear( host_frametime, 0.01, 1e-12, 'half speed' );

	} );

	withCvars( 72, 10, () => {

		_Host_FilterTime( 1 );
		_Host_FilterTime( 0.02 );
		assertNear( host_frametime, 0.2, 1e-12, 'ten times, past the 0.1 clamp as in Ironwail' );

	} );

} );

Deno.test( 'host_timescale scales each tick in the isolated loop, not the tick rate', () => {

	withCvars( 0, 2, () => {

		_Host_FilterTime( 1 );
		if ( host_netinterval !== HOST_NETINTERVAL )
			throw new Error( 'host_maxfps 0 did not isolate' );
		_Host_NetFrame(); // drain the 1 s frame
		let ticks = 0;
		for ( let i = 0; i < 144; i ++ ) {

			_Host_FilterTime( 1 / 144 );
			const before = host_netaccum;
			_Host_NetFrame();
			if ( host_netaccum < before ) {

				ticks ++;
				assertNear( host_netframetime, HOST_NETINTERVAL * 2, 1e-9, 'tick length' );

			}

		}

		if ( Math.abs( ticks - 72 ) > 1 )
			throw new Error( `${ticks} ticks in a second at 144 Hz` );

	} );

} );
