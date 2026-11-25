// Tests for src/agent.js, the web-only agent API (docs/agent-interface.md):
// console and centerprint events, held buttons, menu text and the
// egocentric entity list.

await import( '../src/gl_rsurf.js' );
const cmd = await import( '../src/cmd.js' );
const con = await import( '../src/console.js' );
const scr = await import( '../src/gl_screen.js' );
const keys = await import( '../src/keys.js' );
const menu = await import( '../src/menu.js' );
const input = await import( '../src/cl_input.js' );
const client = await import( '../src/client.js' );
const agent = await import( '../src/agent.js' );

globalThis.window = { devicePixelRatio: 1 }; // gl_draw.js sizes the console from it
cmd.Cbuf_Init();
cmd.Cmd_Init();
con.Con_Init();
input.CL_InitInput();

function assert( cond, msg ) {

	if ( ! cond ) throw new Error( msg );

}

Deno.test( 'agent: console lines and centerprints become events', () => {

	agent.Agent_Attach( 'realtime' );
	try {

		agent.Agent_Observe( { ents: 0 } ); // drain
		con.Con_Printf( 'You got the %s\n', 'Shotgun' );
		con.Con_Printf( 'meshing progs/soldier.mdl...\n' ); // loading chatter: dropped
		con.Con_Printf( 'half a ' );
		con.Con_Printf( 'line\n' );
		scr.SCR_CenterPrint( 'This hall selects\nEASY skill' );
		const events = agent.Agent_Observe( { ents: 0, format: 'json' } ).events;
		assert( JSON.stringify( events ) === JSON.stringify( [ 'msg: You got the Shotgun', 'msg: half a line', 'center: This hall selects / EASY skill' ] ),
			'events: ' + JSON.stringify( events ) );
		assert( agent.Agent_Observe( { ents: 0, format: 'json' } ).events.length === 0, 'events are returned once' );

	} finally {

		agent.Agent_Detach();

	}

	con.Con_Printf( 'after detach\n' );
	agent.Agent_Attach( 'realtime' );
	try {

		assert( agent.Agent_Observe( { ents: 0, format: 'json' } ).events.every( ( e ) => e.includes( 'after detach' ) === false ),
			'no events while detached' );

	} finally {

		agent.Agent_Detach();

	}

} );

Deno.test( 'agent: Quake text is cleaned to ASCII', () => {

	const gold = String.fromCharCode( 'H'.charCodeAt( 0 ) | 128, 'i'.charCodeAt( 0 ) | 128 );
	assert( agent.Agent_CleanText( '\x01' + gold + '\tthere\n' ) === 'Hi there\n', 'got ' + JSON.stringify( agent.Agent_CleanText( '\x01' + gold + '\tthere\n' ) ) );

} );

Deno.test( 'agent: held buttons press and release the client buttons', () => {

	try {

		agent.Agent_HoldButtons( 'forward,attack' );
		assert( ( input.in_forward.state & 1 ) === 1 && ( input.in_attack.state & 1 ) === 1, 'forward and attack down' );
		agent.Agent_HoldButtons( [ 'attack' ] );
		assert( ( input.in_forward.state & 1 ) === 0, 'forward released' );
		assert( ( input.in_attack.state & 1 ) === 1, 'attack still down' );
		let threw = false;
		try {

			agent.Agent_HoldButtons( 'fly' );

		} catch {

			threw = true;

		}

		assert( threw, 'unknown button rejected' );

	} finally {

		agent.Agent_HoldButtons( '' );

	}

	assert( ( input.in_attack.state & 1 ) === 0, 'all released' );

} );

Deno.test( 'agent: menus are described as text', () => {

	let dest = keys.key_game;
	menu.M_SetExternals( { key_dest_get: () => dest, key_dest_set: ( v ) => {

		dest = v;
		keys.set_key_dest( v );

	}, cls: client.cls, sv: { active: false } } );
	try {

		menu.M_Menu_Main_f();
		assert( agent.Agent_UIText().startsWith( 'ui=menu:main items=[>Single Player|Multiplayer|' ), agent.Agent_UIText() );
		menu.M_Keydown( keys.K_DOWNARROW );
		assert( agent.Agent_UIText().includes( '[Single Player|>Multiplayer|' ), agent.Agent_UIText() );
		menu.M_Keydown( keys.K_UPARROW );
		menu.M_Keydown( keys.K_ENTER );
		assert( agent.Agent_UIText().startsWith( 'ui=menu:singleplayer items=[>New Game|Load|Save]' ), agent.Agent_UIText() );

	} finally {

		keys.set_key_dest( keys.key_game );

	}

	assert( agent.Agent_UIText() === 'ui=game', 'back in game' );

} );

Deno.test( 'agent: entities are listed nearest first with the yaw that faces them', () => {

	const { cl, cls, cl_entities } = client;
	const saved = { state: cls.state, signon: cls.signon, demo: cls.demoplayback, world: cl.worldmodel, view: cl.viewentity,
		num: cl.num_entities, mtime: cl.mtime[ 0 ], yaw: cl.viewangles[ 1 ], pitch: cl.viewangles[ 0 ] };
	const ents = cl_entities.slice( 0, 4 );
	const model = ( name ) => ( { name, mins: new Float32Array( [ - 16, - 16, - 24 ] ), maxs: new Float32Array( [ 16, 16, 40 ] ) } );
	const ent = ( mdl, x, y, z ) => {

		const e = new client.entity_t();
		e.model = mdl === null ? null : model( mdl );
		e.origin.set( [ x, y, z ] );
		e.msgtime = 5;
		return e;

	};

	try {

		cls.state = client.ca_connected;
		cls.signon = client.SIGNONS;
		cls.demoplayback = false;
		cl.worldmodel = { name: 'maps/test.bsp' }; // no hulls: everything counts as visible
		cl.viewentity = 1;
		cl.num_entities = 4;
		cl.mtime[ 0 ] = 5;
		cl.viewangles[ 1 ] = 90; // facing +y
		cl.viewangles[ 0 ] = 0;
		cl_entities[ 1 ] = ent( 'progs/player.mdl', 0, 0, 0 );
		cl_entities[ 2 ] = ent( 'progs/soldier.mdl', 300, 0, 0 ); // to the right: turn -90
		cl_entities[ 3 ] = ent( 'maps/b_shell0.bsp', 0, 100, 0 ); // straight ahead

		const list = agent.Agent_Entities( 10, false );
		assert( list.length === 2, 'two entities, got ' + list.length );
		assert( list[ 0 ].kind === 'shells' && list[ 0 ].yaw === 0, 'shells ahead: ' + JSON.stringify( list[ 0 ] ) );
		assert( list[ 1 ].kind === 'grunt' && list[ 1 ].yaw === - 90, 'grunt to the right: ' + JSON.stringify( list[ 1 ] ) );

		cl_entities[ 3 ].msgtime = 4; // not in the latest update
		assert( agent.Agent_Entities( 10, false ).length === 1, 'stale entity dropped' );

		const text = agent.Agent_Observe( { events: false } );
		assert( text.includes( '#2 grunt 300u yaw-90' ), text );

	} finally {

		cls.state = saved.state;
		cls.signon = saved.signon;
		cls.demoplayback = saved.demo;
		cl.worldmodel = saved.world;
		cl.viewentity = saved.view;
		cl.num_entities = saved.num;
		cl.mtime[ 0 ] = saved.mtime;
		cl.viewangles[ 1 ] = saved.yaw;
		cl.viewangles[ 0 ] = saved.pitch;
		for ( let i = 0; i < 4; i ++ ) cl_entities[ i ] = ents[ i ];

	}

} );
