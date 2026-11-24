// Port-inventory gaps G2 (Help screen) and G4 (Game Options frag and time
// limit rows) against WinQuake/menu.c.

const cmd = await import( '../src/cmd.js' );
const cvar = await import( '../src/cvar.js' );
const keys = await import( '../src/keys.js' );
const menu = await import( '../src/menu.js' );
const host = await import( '../src/host.js' );

function assertEqual( actual, expected, message ) {

	if ( actual !== expected )
		throw new Error( `${message}: expected ${expected}, got ${actual}` );

}

cmd.Cbuf_Init();
cmd.Cmd_Init();
keys.Key_Init();
for ( const v of [ host.fraglimit, host.timelimit, host.teamplay ] )
	if ( cvar.Cvar_FindVar( v.name ) === null ) cvar.Cvar_RegisterVariable( v );
menu.M_Init();

// Draw stubs: record every pic the menu draws as "name@x,y"
const drawn = [];
const pic = ( name ) => ( { name: name, width: 320, height: 200 } );
// as menu.c coordinates: undo the port's centring of the 320x200 menu
const gl_draw = await import( '../src/gl_draw.js' );
const mx = ( x ) => x - ( ( gl_draw.Draw_GetVirtualWidth() - 320 ) >> 1 );
const my = ( y ) => y - ( ( gl_draw.Draw_GetVirtualHeight() - 200 ) >> 1 );
const record = ( x, y, p ) => drawn.push( p.name + '@' + mx( x ) + ',' + my( y ) );
menu.M_SetExternals( {
	key_dest_set: keys.set_key_dest,
	key_dest_get: () => keys.key_dest,
	cls: { state: 0, demoplayback: false, demonum: - 1 },
	sv: { active: false },
	vid: { width: 320, height: 200 },
	Draw_CachePic: pic,
	Draw_Pic: record,
	Draw_TransPic: record,
	Draw_SubPic: ( x, y, p, srcY, srcH ) => drawn.push( p.name + '@' + mx( x ) + ',' + my( y ) + '[' + srcY + '+' + srcH + ']' ),
	Draw_Character: () => {},
	Draw_FadeScreen: () => {},
	host_time_get: () => 0,
	realtime_get: () => 0,
} );

function draw() {

	drawn.length = 0;
	menu.M_Draw();
	return drawn.slice();

}

// The main menu draws the cursor dot at 32 + cursor * 20 (menu.c M_Main_Draw)
function mainCursor() {

	const dot = draw().find( ( d ) => d.startsWith( 'gfx/menudot' ) );
	return ( Number( dot.split( ',' )[ 1 ] ) - 32 ) / 20;

}

Deno.test( 'G2: the main menu fourth item and the help command open the Help pages', () => {

	const hadWindow = 'window' in globalThis;
	if ( ! hadWindow ) globalThis.window = { devicePixelRatio: 1 }; // gl_draw.js sizes the 2D screen from it
	try {

		cmd.Cmd_ExecuteString( 'menu_main' );
		const rows = draw();
		if ( rows.includes( 'gfx/mainmenu.lmp@72,32' ) === false )
			throw new Error( 'main menu draws the PAK item strip, which reads HELP: ' + rows.join( ' ' ) );

		while ( mainCursor() !== 3 ) menu.M_Keydown( keys.K_DOWNARROW );
		menu.M_Keydown( keys.K_ENTER );
		assertEqual( menu.m_state, menu.m_help, 'Help item opens M_Menu_Help_f' );
		assertEqual( draw().join( ' ' ), 'gfx/help0.lmp@0,0', 'page 0 at the origin' );

		// menu.c M_Help_Key: up/right go forward, down/left back, both wrap
		menu.M_Keydown( keys.K_RIGHTARROW );
		menu.M_Keydown( keys.K_UPARROW );
		assertEqual( draw()[ 0 ], 'gfx/help2.lmp@0,0', 'two pages on' );
		menu.M_Keydown( keys.K_LEFTARROW );
		menu.M_Keydown( keys.K_DOWNARROW );
		menu.M_Keydown( keys.K_DOWNARROW );
		assertEqual( draw()[ 0 ], 'gfx/help5.lmp@0,0', 'wraps back to the last page' );
		menu.M_Keydown( keys.K_RIGHTARROW );
		assertEqual( draw()[ 0 ], 'gfx/help0.lmp@0,0', 'wraps forward to the first page' );

		menu.M_Keydown( keys.K_ESCAPE );
		assertEqual( menu.m_state, menu.m_main, 'Escape returns to the main menu' );

		cmd.Cmd_ExecuteString( 'help' );
		assertEqual( menu.m_state, menu.m_help, 'help command' );
		menu.M_Keydown( keys.K_RIGHTARROW );
		cmd.Cmd_ExecuteString( 'help' );
		assertEqual( draw()[ 0 ], 'gfx/help0.lmp@0,0', 'reopening starts at page 0' );

		// In a game the port adds Continue above the C rows: only that row
		// comes from the custom image
		menu.M_SetExternals( { sv: { active: true } } );
		cmd.Cmd_ExecuteString( 'menu_main' );
		const inGame = draw();
		for ( const want of [ 'gfx/mainmenu_ext.lmp@72,32[0+21]', 'gfx/mainmenu.lmp@72,52' ] )
			if ( inGame.includes( want ) === false )
				throw new Error( 'in-game main menu lacks ' + want + ': ' + inGame.join( ' ' ) );
		while ( mainCursor() !== 4 ) menu.M_Keydown( keys.K_DOWNARROW );
		menu.M_Keydown( keys.K_ENTER );
		assertEqual( menu.m_state, menu.m_help, 'in game, Help is the fifth row' );
		menu.M_SetExternals( { sv: { active: false } } );

		cmd.Cmd_ExecuteString( 'menu_credits' );
		assertEqual( menu.m_state, menu.m_credits, 'the credits screen stays on menu_credits' );

	} finally {

		menu.M_SetExternals( { sv: { active: false } } );
		keys.set_key_dest( keys.key_game );
		if ( ! hadWindow ) delete globalThis.window;

	}

} );

Deno.test( 'G4: Game Options has frag limit and time limit rows that step and wrap as in C', () => {

	const oldFrag = host.fraglimit.string;
	const oldTime = host.timelimit.string;
	try {

		cvar.Cvar_Set( 'fraglimit', '0' );
		cvar.Cvar_Set( 'timelimit', '0' );
		cmd.Cmd_ExecuteString( 'menu_gameoptions' );

		// cursor row 5 is Frag Limit (cursor table y 88), row 6 Time Limit (96)
		for ( let i = 0; i < 5; i ++ ) menu.M_Keydown( keys.K_DOWNARROW );
		menu.M_Keydown( keys.K_RIGHTARROW );
		assertEqual( host.fraglimit.value, 10, 'frag limit steps by 10' );
		menu.M_Keydown( keys.K_LEFTARROW );
		menu.M_Keydown( keys.K_LEFTARROW );
		assertEqual( host.fraglimit.value, 100, 'below 0 wraps to 100' );
		menu.M_Keydown( keys.K_RIGHTARROW );
		assertEqual( host.fraglimit.value, 0, 'above 100 wraps to 0' );

		menu.M_Keydown( keys.K_DOWNARROW );
		menu.M_Keydown( keys.K_RIGHTARROW );
		assertEqual( host.timelimit.value, 5, 'time limit steps by 5' );
		menu.M_Keydown( keys.K_LEFTARROW );
		menu.M_Keydown( keys.K_LEFTARROW );
		assertEqual( host.timelimit.value, 60, 'below 0 wraps to 60' );
		menu.M_Keydown( keys.K_RIGHTARROW );
		assertEqual( host.timelimit.value, 0, 'above 60 wraps to 0' );

		// nine rows: down three more times wraps back to Begin Game (row 0)
		menu.M_Keydown( keys.K_DOWNARROW );
		menu.M_Keydown( keys.K_DOWNARROW );
		menu.M_Keydown( keys.K_DOWNARROW );
		const oldFragValue = host.fraglimit.value;
		menu.M_Keydown( keys.K_RIGHTARROW ); // no-op on Begin Game
		assertEqual( host.fraglimit.value, oldFragValue, 'row 0 ignores arrows' );

	} finally {

		cvar.Cvar_Set( 'fraglimit', oldFrag );
		cvar.Cvar_Set( 'timelimit', oldTime );
		keys.set_key_dest( keys.key_game );

	}

} );
