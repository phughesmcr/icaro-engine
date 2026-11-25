// Tests for src/agent.js, the web-only agent API (docs/agent-interface.md):
// console and centerprint events, held buttons, lockstep cvars, call
// ordering, menu text and the egocentric entity list.

await import( '../src/gl_rsurf.js' );
const cmd = await import( '../src/cmd.js' );
const cvar = await import( '../src/cvar.js' );
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

Deno.test( 'agent: held buttons press and release the client buttons', async () => {

	agent.Agent_Attach( 'realtime' );
	try {

		await agent.Agent_Step( { buttons: 'forward,attack', hold: true }, 0, { ents: 0 } );
		assert( ( input.in_forward.state & 1 ) === 1 && ( input.in_attack.state & 1 ) === 1, 'forward and attack down' );
		await agent.Agent_Step( { buttons: [ 'attack' ], hold: true }, 0, { ents: 0 } );
		assert( ( input.in_forward.state & 1 ) === 0, 'forward released' );
		assert( ( input.in_attack.state & 1 ) === 1, 'attack still down' );
		let threw = false;
		try {

			await agent.Agent_Step( { buttons: 'fly' }, 0, { ents: 0 } );

		} catch {

			threw = true;

		}

		assert( threw, 'unknown button rejected' );
		await agent.Agent_Step( {}, 0, { ents: 0 } ); // not held: released after the step
		assert( ( input.in_attack.state & 1 ) === 0, 'released when not held' );
		await agent.Agent_Step( { buttons: 'jump', hold: true }, 0, { ents: 0 } );

	} finally {

		agent.Agent_Detach();

	}

	assert( ( input.in_jump.state & 1 ) === 0, 'detach releases held buttons' );

} );

Deno.test( 'agent: lockstep pins the frame cvars without saving them, detach restores them', () => {

	const saved_storage = globalThis.localStorage;
	let writes = 0;
	globalThis.localStorage = { getItem: () => null, setItem: () => { writes ++; } };
	const values = [ [ 'host_framerate', '0' ], [ 'host_timescale', '0.5' ], [ 'host_maxfps', '250' ] ];
	const vars = values.map( ( [ name, value ] ) => {

		let v = cvar.Cvar_FindVar( name );
		if ( v === null ) {

			v = new cvar.cvar_t( name, value, name === 'host_maxfps' );
			cvar.Cvar_RegisterVariable( v );

		}

		const old = v.string;
		v.string = value;
		v.value = Number.parseFloat( value );
		return { v, old };

	} );

	try {

		agent.Agent_Attach( 'lockstep' );
		assert( agent.Agent_Lockstep() === true, 'lockstep on' );
		assert( Math.abs( vars[ 0 ].v.value - 1 / 72 ) < 1e-9, 'host_framerate pinned to one tic: ' + vars[ 0 ].v.value );
		assert( vars[ 1 ].v.value === 0, 'host_timescale pinned off' );
		assert( vars[ 2 ].v.value === 72 && vars[ 2 ].v.string === '72', 'host_maxfps pinned to 72' );
		agent.Agent_Attach( 'realtime' );
		assert( agent.Agent_Lockstep() === false, 'lockstep off' );
		for ( let i = 0; i < values.length; i ++ )
			assert( vars[ i ].v.string === values[ i ][ 1 ], values[ i ][ 0 ] + ' restored: ' + vars[ i ].v.string );
		assert( vars[ 2 ].v.value === 250, 'host_maxfps value restored' );
		assert( writes === 0, 'archived cvars not written to storage: ' + writes );

	} finally {

		agent.Agent_Detach();
		for ( const { v, old } of vars ) {

			v.string = old;
			v.value = Number.parseFloat( old ) || 0;

		}

		globalThis.localStorage = saved_storage;

	}

} );

Deno.test( 'agent: commands that load a map are recognised', () => {

	for ( const text of [ 'map e1m1', 'restart', 'reconnect', 'god; changelevel e1m2', 'skill 1\nmap start', 'load s0' ] )
		assert( agent.Agent_StartsLoad( text ) === true, 'loads: ' + JSON.stringify( text ) );
	for ( const text of [ 'god', 'mapname', 'give s 100', 'impulse 9', 'restarted' ] )
		assert( agent.Agent_StartsLoad( text ) === false, 'does not load: ' + JSON.stringify( text ) );

} );

Deno.test( 'agent: async calls run one at a time in call order', async () => {

	const order = [];
	const a = agent.Agent_Serial( async () => {

		await new Promise( ( r ) => setTimeout( r, 20 ) );
		order.push( 'a' );

	} );
	const b = agent.Agent_Serial( () => {

		order.push( 'b' );
		throw new Error( 'b failed' );

	} );
	const c = agent.Agent_Serial( () => {

		order.push( 'c' );
		return 'c';

	} );

	await a;
	let failed = false;
	try {

		await b;

	} catch {

		failed = true;

	}

	assert( failed, 'a failed call rejects its own promise' );
	assert( await c === 'c', 'later calls still run after a failure' );
	assert( order.join( '' ) === 'abc', 'order ' + order.join( '' ) );

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
