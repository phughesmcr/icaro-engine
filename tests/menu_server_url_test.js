// The web multiplayer menus and the page's ?server= link: the lobby address
// is checked before it reaches the command buffer, it is kept in the page
// URL, and Start Game sends one room request at a time.

const cmd = await import( '../src/cmd.js' );
const common = await import( '../src/common.js' );
const keys = await import( '../src/keys.js' );
const menu = await import( '../src/menu.js' );
const sys = await import( '../src/sys.js' );

function assertEqual( actual, expected, message ) {

	if ( actual !== expected )
		throw new Error( `${message}: expected ${expected}, got ${actual}` );

}

// Replace a global for the length of fn, then put it back.
async function withGlobals( globals, fn ) {

	const saved = {};
	for ( const name of Object.keys( globals ) ) {

		saved[ name ] = Object.getOwnPropertyDescriptor( globalThis, name );
		Object.defineProperty( globalThis, name, { value: globals[ name ], configurable: true, writable: true } );

	}

	try {

		await fn();

	} finally {

		for ( const name of Object.keys( globals ) ) {

			if ( saved[ name ] !== undefined ) Object.defineProperty( globalThis, name, saved[ name ] );
			else delete globalThis[ name ];

		}

	}

}

function fakeLocation( search ) {

	return { origin: 'https://example.test', pathname: '/play/', search: search };

}

// Fake `connect` and `bind` commands that record what reaches them.
const executed = { connect: [], bind: [] };
let commandsReady = false;

function initCommands() {

	cmd.Cbuf_Init();
	if ( commandsReady === true ) return;
	cmd.Cmd_Init();
	cmd.Cmd_AddCommand( 'connect', () => {

		const args = [];
		for ( let i = 1; i < cmd.Cmd_Argc(); i ++ ) args.push( cmd.Cmd_Argv( i ) );
		executed.connect.push( args );

	} );
	cmd.Cmd_AddCommand( 'bind', () => executed.bind.push( cmd.Cmd_Args() ) );
	commandsReady = true;

}

function resetExecuted() {

	executed.connect.length = 0;
	executed.bind.length = 0;

}

/*
==============================================================================

MENU-2: the lobby address can't inject commands

==============================================================================
*/

Deno.test( 'Sys_ParseLobbyURL accepts wts://, https:// and wt:// hosts with an optional port', () => {

	assertEqual( sys.Sys_ParseLobbyURL( 'wts://lobby.example:4433' ), 'https://lobby.example:4433', 'wts' );
	assertEqual( sys.Sys_ParseLobbyURL( 'https://lobby.example:4433/' ), 'https://lobby.example:4433', 'https, trailing slash' );
	assertEqual( sys.Sys_ParseLobbyURL( 'wt://Lobby.Example' ), 'https://lobby.example', 'wt, no port' );
	assertEqual( sys.Sys_ParseLobbyURL( 'lobby.example:4433' ), 'https://lobby.example:4433', 'bare host' );
	assertEqual( sys.Sys_ParseLobbyURL( 'https://[::1]:4433' ), 'https://[::1]:4433', 'IPv6' );
	assertEqual( sys.Sys_ParseLobbyURL( 'https://127.0.0.1:4433' ), 'https://127.0.0.1:4433', 'IPv4' );
	assertEqual( sys.Sys_ParseLobbyURL( 'wts://my_lobby.example' ), 'https://my_lobby.example', 'underscore' );

} );

Deno.test( 'Sys_ParseLobbyURL refuses anything that is not a plain lobby host', () => {

	const bad = [
		'"', '";bind w quit;"', 'https://a";bind w quit;"', 'https://a%22;bind',
		'wts://lobby.example:4433\nbind w quit', 'wts://lobby.example\rquit',
		'wts://lobby.example;quit', 'wts://lobby .example',
		'http://lobby.example', 'javascript:alert(1)', 'file:///etc/passwd', 'ftp://lobby.example',
		'https://user:pw@lobby.example', 'https://lobby.example/path', 'https://lobby.example?room=x',
		'https://lobby.example#x', 'https://lobby.example:99999', 'https://', '',
	];
	for ( const raw of bad )
		assertEqual( sys.Sys_ParseLobbyURL( raw ), null, JSON.stringify( raw ) );

} );

Deno.test( 'Sys_ParseLobbyURL accepts a WebSocket lobby with a plain path, and nothing unsafe', () => {

	assertEqual( sys.Sys_ParseLobbyURL( 'wss://quake.example/mp' ), 'wss://quake.example/mp', 'tunnel prefix' );
	assertEqual( sys.Sys_ParseLobbyURL( 'wss://quake.example/mp/' ), 'wss://quake.example/mp', 'trailing slash' );
	assertEqual( sys.Sys_ParseLobbyURL( 'WS://127.0.0.1:4433' ), 'ws://127.0.0.1:4433', 'ws, no path' );
	const bad = [
		'wss://a.example/mp";bind w quit;"', 'wss://a.example/m p', 'wss://a.example/mp?room=x',
		'wss://a.example/mp#x', 'wss://u:p@a.example/mp', 'wss://a.example/%22', "wss://a.example/it's",
		'wss://a.example/mp\nquit', 'wss://a.example\\mp',
	];
	for ( const raw of bad )
		assertEqual( sys.Sys_ParseLobbyURL( raw ), null, JSON.stringify( raw ) );

} );

Deno.test( 'Sys_LobbyURL falls back to localhost only when ?server= is absent', async () => {

	await withGlobals( { location: fakeLocation( '?room=AB12' ) }, () => {

		assertEqual( sys.Sys_LobbyURL(), sys.SYS_DEFAULT_LOBBY, 'no server' );

	} );
	await withGlobals( { location: fakeLocation( '?room=x&server=%22;bind%20w%20quit;%22' ) }, () => {

		assertEqual( sys.Sys_LobbyURL(), null, 'crafted server' );

	} );
	await withGlobals( { location: fakeLocation( '?server=wts%3A%2F%2Flobby.example%3A4433' ) }, () => {

		assertEqual( sys.Sys_LobbyURL(), 'https://lobby.example:4433', 'encoded wts server' );

	} );

} );

Deno.test( 'Sys_ConnectURL output stays one connect argument through the command buffer', () => {

	initCommands();
	resetExecuted();

	const lobby = 'https://lobby.example:4433';
	const room = 'x";bind w quit;"\nbind a quit';
	const connectUrl = sys.Sys_ConnectURL( lobby, room, null );
	cmd.Cbuf_AddText( 'connect "' + connectUrl + '"\n' );
	cmd.Cbuf_Execute();

	assertEqual( executed.bind.length, 0, 'no bind ran' );
	assertEqual( executed.connect.length, 1, 'one connect' );
	assertEqual( executed.connect[ 0 ].length, 1, 'connect has one argument' );
	const parsed = new URL( executed.connect[ 0 ][ 0 ].replace( /^wts:/, 'https:' ) );
	assertEqual( parsed.host, 'lobby.example:4433', 'host' );
	assertEqual( parsed.searchParams.get( 'room' ), room, 'room id survives encoding' );

	assertEqual( sys.Sys_ConnectURL( lobby, 'AB12CD', null ), 'wts://lobby.example:4433?room=AB12CD', 'lobby join' );
	assertEqual( sys.Sys_ConnectURL( lobby, null, 4434 ), 'wts://lobby.example:4434', 'room server port' );
	assertEqual( sys.Sys_ConnectURL( lobby, null, 0 ), null, 'port 0' );
	assertEqual( sys.Sys_ConnectURL( lobby, null, NaN ), null, 'port NaN' );
	assertEqual( sys.Sys_ConnectURL( 'https://a";bind w quit;"', 'AB12CD', null ), null, 'crafted lobby' );

} );

Deno.test( 'Sys_PageURL keeps a valid server= and drops an invalid one', async () => {

	await withGlobals( { location: fakeLocation( '?server=wts%3A%2F%2Flobby.example%3A4433&game=rogue&room=OLD1&foo=1' ) }, () => {

		assertEqual( sys.Sys_PageURL( 'AB12' ),
			'https://example.test/play/?room=AB12&game=rogue&server=wts%3A%2F%2Flobby.example%3A4433', 'room, game and server' );
		assertEqual( sys.Sys_PageURL( null ),
			'https://example.test/play/?game=rogue&server=wts%3A%2F%2Flobby.example%3A4433', 'cleared room keeps server' );

	} );
	await withGlobals( { location: fakeLocation( '?server=%22;bind%20w%20quit;%22&room=OLD1' ) }, () => {

		assertEqual( sys.Sys_PageURL( 'AB12' ), 'https://example.test/play/?room=AB12', 'invalid server dropped' );

	} );

} );

/*
==============================================================================

MENU-3: Start Game sends one room request at a time

==============================================================================
*/

function deferred() {

	let resolve, reject;
	const promise = new Promise( ( res, rej ) => {

		resolve = res;
		reject = rej;

	} );
	return { promise, resolve, reject };

}

// Wait for the menu's .then/.catch handlers to run.
function settle() {

	return new Promise( ( resolve ) => setTimeout( resolve, 0 ) );

}

const createCalls = [];
const pageUrls = [];

function fakeCreateRoom( serverUrl, config ) {

	const d = deferred();
	createCalls.push( { serverUrl, config, d } );
	return d.promise;

}

let menuReady = false;

function initMenu() {

	initCommands();
	if ( menuReady === false ) {

		common.COM_Init(); // registered cvar, read by the episode list
		keys.Key_Init();
		menu.M_Init();
		// The lobby helpers net_main.js injects, as they behave over WebTransport
		menu.M_SetExternals( {
			NET_CreateRoom: fakeCreateRoom,
			NET_MultiplayerAvailable: () => true,
			NET_LobbyServer: () => sys.Sys_LobbyURL(),
			NET_RoomURL: ( lobby, room ) => room.port != null
				? sys.Sys_ConnectURL( lobby, null, Number( room.port ) )
				: sys.Sys_ConnectURL( lobby, room.id, null ),
			key_dest_set: keys.set_key_dest,
			key_dest_get: () => keys.key_dest,
		} );
		menuReady = true;

	}

	createCalls.length = 0;
	pageUrls.length = 0;
	resetExecuted();
	cmd.Cmd_ExecuteString( 'menu_gameoptions' );

}

const startGameGlobals = () => ( {
	location: fakeLocation( '?server=wts%3A%2F%2Flobby.example%3A4433' ),
	history: { replaceState: ( _state, _title, url ) => pageUrls.push( url ) },
	WebTransport: class {},
} );

Deno.test( 'Start Game ignores a second Enter while the room request is in flight', async () => {

	await withGlobals( startGameGlobals(), async () => {

		try {

			initMenu();
			menu.M_Keydown( keys.K_ENTER );
			menu.M_Keydown( keys.K_ENTER );
			assertEqual( createCalls.length, 1, 'one create request' );
			assertEqual( createCalls[ 0 ].serverUrl, 'https://lobby.example:4433', 'lobby from ?server=' );

			createCalls[ 0 ].d.resolve( { id: 'AB12CD', port: 4434 } );
			await settle();
			cmd.Cbuf_Execute();

			assertEqual( executed.connect.length, 1, 'one connect' );
			assertEqual( executed.connect[ 0 ][ 0 ], 'wts://lobby.example:4434', 'connect to the room server' );
			assertEqual( menu.m_state, menu.m_none, 'menu closed' );
			assertEqual( keys.key_dest, keys.key_game, 'in game' );
			assertEqual( pageUrls[ 0 ],
				'https://example.test/play/?room=AB12CD&server=wts%3A%2F%2Flobby.example%3A4433', 'share link keeps server' );

		} finally {

			keys.set_key_dest( keys.key_game );

		}

	} );

} );

Deno.test( 'Start Game drops a room reply that arrives after Escape', async () => {

	await withGlobals( startGameGlobals(), async () => {

		try {

			initMenu();
			menu.M_Keydown( keys.K_ENTER );
			menu.M_Keydown( keys.K_ESCAPE );
			assertEqual( menu.m_state, menu.m_multiplayer, 'back on the multiplayer menu' );

			createCalls[ 0 ].d.resolve( { id: 'AB12CD', port: 4434 } );
			await settle();
			cmd.Cbuf_Execute();

			assertEqual( executed.connect.length, 0, 'no connect' );
			assertEqual( pageUrls.length, 0, 'page URL untouched' );
			assertEqual( menu.m_state, menu.m_multiplayer, 'still on the multiplayer menu' );
			assertEqual( keys.key_dest, keys.key_menu, 'still in the menu' );

			// Back on Start Game, Enter sends a new request.
			cmd.Cmd_ExecuteString( 'menu_gameoptions' );
			menu.M_Keydown( keys.K_ENTER );
			assertEqual( createCalls.length, 2, 'new request after returning' );

		} finally {

			keys.set_key_dest( keys.key_game );

		}

	} );

} );

Deno.test( 'a failed Start Game stays on the menu and lets Enter try again', async () => {

	await withGlobals( startGameGlobals(), async () => {

		try {

			initMenu();
			menu.M_Keydown( keys.K_ENTER );
			createCalls[ 0 ].d.reject( new Error( 'Room creation timed out' ) );
			await settle();
			cmd.Cbuf_Execute();

			assertEqual( executed.connect.length, 0, 'no connect' );
			assertEqual( menu.m_state, menu.m_gameoptions, 'still on Start Game' );
			assertEqual( keys.key_dest, keys.key_menu, 'still in the menu' );

			menu.M_Keydown( keys.K_ENTER );
			assertEqual( createCalls.length, 2, 'Enter works again' );

		} finally {

			keys.set_key_dest( keys.key_game );

		}

	} );

} );

Deno.test( 'Start Game sends the Game Options rows in the room request', async () => {

	const cvar = await import( '../src/cvar.js' );
	const host = await import( '../src/host.js' );
	const names = [ 'coop', 'teamplay', 'skill', 'fraglimit', 'timelimit' ];
	// The client registers these in Host_InitLocal, which this test doesn't run
	for ( const n of names ) if ( cvar.Cvar_FindVar( n ) === null ) cvar.Cvar_RegisterVariable( host[ n ] );
	const saved = names.map( ( n ) => [ n, cvar.Cvar_VariableString( n ) ] );

	await withGlobals( startGameGlobals(), () => {

		try {

			initMenu();
			cvar.Cvar_Set( 'coop', '1' );
			cvar.Cvar_Set( 'teamplay', '2' );
			cvar.Cvar_Set( 'skill', '3' );
			cvar.Cvar_Set( 'fraglimit', '40' );
			cvar.Cvar_Set( 'timelimit', '15' );
			menu.M_Keydown( keys.K_ENTER );
			assertEqual( createCalls.length, 1, 'one create request' );
			assertEqual( JSON.stringify( createCalls[ 0 ].config.options ),
				JSON.stringify( { coop: 1, teamplay: 2, skill: 3, fraglimit: 40, timelimit: 15 } ), 'options' );

		} finally {

			for ( const [ n, v ] of saved ) cvar.Cvar_Set( n, v );
			keys.set_key_dest( keys.key_game );

		}

	} );

} );

Deno.test( 'Start Game refuses an invalid ?server= without sending a request', async () => {

	const globals = startGameGlobals();
	globals.location = fakeLocation( '?server=%22;bind%20w%20quit;%22' );
	await withGlobals( globals, async () => {

		try {

			initMenu();
			menu.M_Keydown( keys.K_ENTER );
			await settle();
			cmd.Cbuf_Execute();

			assertEqual( createCalls.length, 0, 'no request' );
			assertEqual( executed.connect.length + executed.bind.length, 0, 'no commands' );
			assertEqual( menu.m_state, menu.m_gameoptions, 'still on Start Game' );

		} finally {

			keys.set_key_dest( keys.key_game );

		}

	} );

} );
