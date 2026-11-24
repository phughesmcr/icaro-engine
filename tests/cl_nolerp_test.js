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

// R_Mirror draws cl_entities[cl.viewentity] in reflections, so CL_LinkPlayers
// fills it in from svc_playerinfo even though it doesn't add it to the
// visedicts list (cl_main.c CL_RelinkEntities does the same).
Deno.test( 'CL_LinkPlayers fills in the view entity without drawing it', async () => {

	const client = await import( '../src/client.js' );
	const { CL_SetPlayerInfo } = await import( '../src/cl_pred.js' );
	const old = {
		active: sv.active, maxclients: cl.maxclients, num: cl.num_entities, view: cl.viewentity,
		model: cl.model_precache[ 1 ], m0: cl.mtime[ 0 ], demo: cls.demoplayback
	};
	const ent = cl_entities[ 1 ];
	const oldEnt = { model: ent.model, frame: ent.frame, origin: Array.from( ent.origin ) };

	try {

		CL_ResetPrediction();
		sv.active = false;
		cls.demoplayback = false;
		cl.maxclients = 1;
		cl.viewentity = 1;
		cl.num_entities = 2;
		cl.mtime[ 0 ] = 1.0;
		const player = { name: 'progs/player.mdl', flags: 0, synctype: 0 };
		cl.model_precache[ 1 ] = player;

		CL_SetServerSequence( 1 );
		CL_SetValidSequence( 1 );
		CL_GetEntityFrame( 1 ).packet_entities.num_entities = 0;
		CL_SetPlayerInfo( 0, [ 100, 0, 0 ], [ 0, 0, 0 ], 3, 0, 0, 0, 0, 0, null, 1, 0 );
		CL_RelinkEntities();

		if ( ent.model !== player ) throw new Error( 'view entity model not set' );
		if ( ent.frame !== 3 ) throw new Error( `view entity frame: expected 3, got ${ent.frame}` );
		if ( client.cl_numvisedicts !== 0 ) throw new Error( 'view entity added to cl_visedicts' );

		CL_SetServerSequence( 2 );
		CL_SetValidSequence( 2 );
		CL_GetEntityFrame( 2 ).packet_entities.num_entities = 0;
		CL_SetPlayerInfo( 0, [ 100, 0, 0 ], [ 0, 0, 0 ], 3, 0, 0, 0, 0, 0, null, 0, 0 );
		CL_RelinkEntities();

		if ( ent.model !== null ) throw new Error( 'view entity model kept after modelindex 0' );

	} finally {

		CL_ResetPrediction();
		sv.active = old.active;
		cl.maxclients = old.maxclients;
		cl.num_entities = old.num;
		cl.viewentity = old.view;
		cl.model_precache[ 1 ] = old.model;
		cl.mtime[ 0 ] = old.m0;
		cls.demoplayback = old.demo;
		ent.model = oldEnt.model;
		ent.frame = oldEnt.frame;
		ent.origin.set( oldEnt.origin );

	}

} );
