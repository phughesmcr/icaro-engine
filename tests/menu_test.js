const cmd = await import( '../src/cmd.js' );
const keys = await import( '../src/keys.js' );
const menu = await import( '../src/menu.js' );

function assertEqual( actual, expected, message ) {

	if ( actual !== expected )
		throw new Error( `${message}: expected ${expected}, got ${actual}` );

}

Deno.test( 'customize controls binds printable and named keys', () => {

	const oldBindings = keys.keybindings.slice();

	try {

		cmd.Cbuf_Init();
		cmd.Cmd_Init();
		keys.Key_Init();
		menu.M_Init();
		keys.keybindings.fill( null );

		cmd.Cmd_ExecuteString( 'menu_keys' );
		menu.M_Keydown( keys.K_ENTER );
		menu.M_Keydown( 49 );
		cmd.Cbuf_Execute();
		assertEqual( keys.keybindings[ 49 ], '+attack', 'printable key binding' );

		menu.M_Keydown( keys.K_ENTER );
		menu.M_Keydown( keys.K_MOUSE1 );
		cmd.Cbuf_Execute();
		assertEqual( keys.keybindings[ keys.K_MOUSE1 ], '+attack', 'mouse key binding' );

	} finally {

		keys.keybindings.splice( 0, keys.keybindings.length, ...oldBindings );

	}

} );

Deno.test( 'the game options menu offers the registered episodes only when registered', async () => {

	const common = await import( '../src/common.js' );
	common.COM_Init(); // creates the registered cvar
	const old = common.registered.value;
	try {

		common.registered.value = 0;
		assertEqual( menu.M_NumEpisodes(), 3, 'shareware: Welcome, Doomed Dimension, Deathmatch Arena' );
		common.registered.value = 1;
		assertEqual( menu.M_NumEpisodes(), 8, 'registered adds E2-E4, the end and the id1 DM maps' );

	} finally {

		common.registered.value = old;

	}

} );
