// MP-5: MOVETYPE_STEP entities (PS_NOLERP) snap to each packet instead of
// lerping, like NQ's U_NOLERP.

// Bootstrap the client renderer graph in its established safe import order.
await import( '../src/gl_rsurf.js' );

const { CL_RelinkEntities } = await import( '../src/cl_main.js' );
const { cl, cls, cl_entities } = await import( '../src/client.js' );
const { sv } = await import( '../src/server.js' );
const { PS_NOLERP, PS_BOX } = await import( '../src/protocol.js' );
const { CL_ResetPrediction, CL_SetValidSequence, CL_SetServerSequence, CL_GetEntityFrame } =
	await import( '../src/cl_pred.js' );

function assertNear( actual, expected, message ) {

	if ( Math.abs( actual - expected ) > 1e-4 )
		throw new Error( `${message}: expected ${expected}, got ${actual}` );

}

function sendPacket( seq, x ) {

	CL_SetServerSequence( seq );
	CL_SetValidSequence( seq );
	const pak = CL_GetEntityFrame( seq ).packet_entities;
	pak.num_entities = 2;
	for ( let i = 0; i < 2; i ++ ) {

		const s = pak.state( i );
		s.number = 2 + i;
		s.modelindex = 1;
		s.origin[ 0 ] = x;
		s.angles[ 1 ] = x;
		// entity 2 is a walking monster, entity 3 isn't
		s.solid = i === 0 ? PS_BOX | PS_NOLERP : PS_BOX;

	}

}

Deno.test( 'CL_LinkPacketEntities snaps PS_NOLERP entities', () => {

	const old = {
		active: sv.active, maxclients: cl.maxclients, num: cl.num_entities,
		model: cl.model_precache[ 1 ], time: cl.time, m0: cl.mtime[ 0 ], m1: cl.mtime[ 1 ],
		demo: cls.demoplayback, timedemo: cls.timedemo
	};

	try {

		CL_ResetPrediction();
		sv.active = false;
		cls.demoplayback = false;
		cls.timedemo = false;
		cl.maxclients = 1;
		cl.num_entities = 4;
		cl.model_precache[ 1 ] = { name: 'progs/ogre.mdl', flags: 0, synctype: 0 };

		cl.mtime[ 1 ] = 0.9;
		cl.mtime[ 0 ] = 1.0;
		cl.time = 0.95;
		sendPacket( 1, 0 );
		CL_RelinkEntities();

		cl.mtime[ 1 ] = 1.0;
		cl.mtime[ 0 ] = 1.1;
		cl.time = 1.05; // halfway between the two packets
		sendPacket( 2, 10 );
		CL_RelinkEntities();

		assertNear( cl_entities[ 2 ].origin[ 0 ], 10, 'nolerp origin' );
		assertNear( cl_entities[ 2 ].angles[ 1 ], 10, 'nolerp angles' );
		assertNear( cl_entities[ 3 ].origin[ 0 ], 5, 'lerped origin' );
		assertNear( cl_entities[ 3 ].angles[ 1 ], 5, 'lerped angles' );

	} finally {

		CL_ResetPrediction();
		sv.active = old.active;
		cl.maxclients = old.maxclients;
		cl.num_entities = old.num;
		cl.model_precache[ 1 ] = old.model;
		cl.time = old.time;
		cl.mtime[ 0 ] = old.m0;
		cl.mtime[ 1 ] = old.m1;
		cls.demoplayback = old.demo;
		cls.timedemo = old.timedemo;

	}

} );
