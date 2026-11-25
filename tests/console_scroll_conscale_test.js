// Ctrl+Home and PgUp limit the console backscroll by the console's height
// on its own canvas (scr_conscale), not the automatic UI scale's screen.

await import( '../src/gl_rsurf.js' );
globalThis.window = { devicePixelRatio: 1 }; // gl_draw.js sizes the virtual screen from it

const cmd = await import( '../src/cmd.js' );
const keys = await import( '../src/keys.js' );
const con = await import( '../src/console.js' );
const scr = await import( '../src/gl_screen.js' );

function assertEqual( actual, expected, message ) {

	if ( actual !== expected )
		throw new Error( `${message}: expected ${expected}, got ${actual}` );

}

cmd.Cbuf_Init();
cmd.Cmd_Init();
keys.Key_Init();
con.Con_Init();

// gl_draw's default video is 640x480: the automatic UI scale is 2 (a
// 240-line screen, 30 text rows); scr_conscale 1 gives 480 lines, 60 rows.
function withConsole( conscale, fn ) {

	const oldScale = scr.scr_conscale.value;
	const oldDest = keys.key_dest;
	try {

		scr.scr_conscale.value = conscale;
		keys.set_key_dest( keys.key_console );
		con.Con_SetBackscroll( 0 );
		fn();

	} finally {

		scr.scr_conscale.value = oldScale;
		keys.set_key_dest( oldDest );
		con.Con_SetBackscroll( 0 );
		keys.Key_Event( keys.K_CTRL, false );

	}

}

function ctrlHome() {

	keys.Key_Event( keys.K_CTRL, true );
	keys.Key_Event( keys.K_HOME, true );
	keys.Key_Event( keys.K_HOME, false );
	keys.Key_Event( keys.K_CTRL, false );

}

Deno.test( 'Ctrl+Home stops at the top on the automatic scale', () => {

	withConsole( 0, () => {

		ctrlHome();
		assertEqual( con.Con_GetBackscroll(), con.con_totallines - 30 - 1, 'top' );

	} );

} );

Deno.test( 'Ctrl+Home and PgUp stop at the top on the console canvas', () => {

	withConsole( 1, () => {

		ctrlHome();
		assertEqual( con.Con_GetBackscroll(), con.con_totallines - 60 - 1, 'Ctrl+Home: 60 rows fit' );

		keys.Key_Event( keys.K_PGUP, true );
		keys.Key_Event( keys.K_PGUP, false );
		assertEqual( con.Con_GetBackscroll(), con.con_totallines - 60 - 1, 'PgUp clamps to the same top' );

	} );

} );
