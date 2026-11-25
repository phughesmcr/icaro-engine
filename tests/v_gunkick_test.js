// v_gunkick (FitzQuake/Ironwail): 0 no weapon kick, 1 id's kick, 2 the kick
// lerped over 0.1 s from the previous server punchangle.

// Bootstrap the client renderer graph in its established safe import order.
await import( '../src/gl_rsurf.js' );

const { V_AddPunchAngles, V_UpdatePunchAngles, V_ResetPunchAngles, v_gunkick } = await import( '../src/view.js' );
const { cl } = await import( '../src/client.js' );
const { Cvar_RegisterVariable, Cvar_SetValue } = await import( '../src/cvar.js' );
const { CL_ParseClientdata } = await import( '../src/cl_parse.js' );
const net = await import( '../src/net.js' );
const common = await import( '../src/common.js' );
const { SU_PUNCH1 } = await import( '../src/protocol.js' );

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

Deno.test( 'svc_clientdata feeds the lerped kick and V_ResetPunchAngles clears it', () => {

	const saved = {
		time: cl.time, items: cl.items, stats: Int32Array.from( cl.stats ),
		punch: Float32Array.from( cl.punchangle ),
		mvel0: Float32Array.from( cl.mvelocity[ 0 ] ), mvel1: Float32Array.from( cl.mvelocity[ 1 ] ),
		viewheight: cl.viewheight, idealpitch: cl.idealpitch, onground: cl.onground, inwater: cl.inwater,
		message: { data: net.net_message.data, maxsize: net.net_message.maxsize, cursize: net.net_message.cursize },
		commonMessage: common.net_message
	};
	try {

		V_ResetPunchAngles();
		common.COM_SetNetMessage( net.net_message );
		net.net_message.data = new Uint8Array( 64 );
		net.net_message.maxsize = 64;
		// punchangle[0] = -4, then items, health, ammo, four ammo counts, weapon
		net.net_message.cursize = 17;
		net.net_message.data[ 0 ] = 256 - 4;
		common.MSG_BeginReading();
		cl.time = 7;
		CL_ParseClientdata( SU_PUNCH1 );

		cl.time = 7.1;
		assertNear( kick( 2 ), - 4, 'parsed punch reaches v_gunkick 2' );

		V_ResetPunchAngles(); // CL_ClearState
		assertNear( kick( 2 ), 0, 'reset clears the previous and current punch' );

	} finally {

		Cvar_SetValue( 'v_gunkick', 1 );
		cl.time = saved.time;
		cl.items = saved.items;
		cl.stats.set( saved.stats );
		cl.punchangle.set( saved.punch );
		cl.mvelocity[ 0 ].set( saved.mvel0 );
		cl.mvelocity[ 1 ].set( saved.mvel1 );
		cl.viewheight = saved.viewheight;
		cl.idealpitch = saved.idealpitch;
		cl.onground = saved.onground;
		cl.inwater = saved.inwater;
		net.net_message.data = saved.message.data;
		net.net_message.maxsize = saved.message.maxsize;
		net.net_message.cursize = saved.message.cursize;
		common.COM_SetNetMessage( saved.commonMessage );
		V_ResetPunchAngles();

	}

} );
