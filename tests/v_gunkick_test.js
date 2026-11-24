// v_gunkick (FitzQuake/Ironwail): 0 no weapon kick, 1 id's kick, 2 the kick
// lerped over 0.1 s from the previous server punchangle.

// Bootstrap the client renderer graph in its established safe import order.
await import( '../src/gl_rsurf.js' );

const { V_AddPunchAngles, V_UpdatePunchAngles, V_ResetPunchAngles, v_gunkick } = await import( '../src/view.js' );
const { cl } = await import( '../src/client.js' );
const { Cvar_RegisterVariable, Cvar_SetValue } = await import( '../src/cvar.js' );

function assertNear( actual, expected, message ) {

	if ( Math.abs( actual - expected ) > 1e-4 )
		throw new Error( `${message}: expected ${expected}, got ${actual}` );

}

Cvar_RegisterVariable( v_gunkick );

function kick( mode ) {

	Cvar_SetValue( 'v_gunkick', mode );
	const angles = new Float32Array( 3 );
	V_AddPunchAngles( angles );
	return angles[ 0 ];

}

Deno.test( 'v_gunkick 0, 1 and 2', () => {

	const saved = { time: cl.time, punch: Float32Array.from( cl.punchangle ) };
	try {

		V_ResetPunchAngles();
		cl.time = 5;
		cl.punchangle.set( [ - 4, 0, 0 ] );
		V_UpdatePunchAngles(); // a shot arrives at t = 5

		assertNear( kick( 0 ), 0, 'v_gunkick 0 has no kick' );
		assertNear( kick( 1 ), - 4, 'v_gunkick 1 adds the server punchangle' );
		assertNear( kick( 2 ), 0, 'v_gunkick 2 starts from the previous punch' );
		cl.time = 5.05;
		assertNear( kick( 2 ), - 2, 'halfway through the lerp' );
		cl.time = 5.2;
		assertNear( kick( 2 ), - 4, 'lerp complete' );

		cl.punchangle.set( [ - 2, 0, 0 ] );
		V_UpdatePunchAngles(); // decaying punch at t = 5.2
		assertNear( kick( 2 ), - 4, 'next update starts from the last one' );

		V_UpdatePunchAngles(); // unchanged: the lerp time is kept
		cl.time = 5.3;
		assertNear( kick( 2 ), - 2, 'unchanged punch does not restart the lerp' );

	} finally {

		Cvar_SetValue( 'v_gunkick', 1 );
		cl.time = saved.time;
		cl.punchangle.set( saved.punch );
		V_ResetPunchAngles();

	}

} );
