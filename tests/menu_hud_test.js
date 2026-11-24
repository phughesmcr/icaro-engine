// Menu mouse support, the scrolling key-binding menu, scr_showfps/scr_clock
// formatting and the r_waterwarp contents test

const cmd = await import( '../src/cmd.js' );
const keys = await import( '../src/keys.js' );
const menu = await import( '../src/menu.js' );
const draw = await import( '../src/gl_draw.js' );
const screen = await import( '../src/gl_screen.js' );
const screenwarp = await import( '../src/gl_screenwarp.js' );
const bspfile = await import( '../src/bspfile.js' );

function assertEqual( actual, expected, message ) {

	if ( actual !== expected )
		throw new Error( `${message}: expected ${expected}, got ${actual}` );

}

// Runs fn with the menu set up and a window stub for gl_draw's virtual size
function withMenu( fn ) {

	const hadWindow = 'window' in globalThis;
	if ( ! hadWindow ) globalThis.window = { devicePixelRatio: 1 };
	const oldBindings = keys.keybindings.slice();
	const oldMouse = menu.ui_mouse.value;

	try {

		cmd.Cbuf_Init();
		cmd.Cmd_Init();
		keys.Key_Init();
		menu.M_Init();

		const w = draw.Draw_GetVirtualWidth();
		const h = draw.Draw_GetVirtualHeight();
		// Move the mouse to a point in the 320x200 menu space
		const move = ( vx, vy ) => menu.M_Mousemove( vx + ( w - 320 ) / 2, vy + ( h - 200 ) / 2, w, h );
		fn( move );

	} finally {

		menu.ui_mouse.value = oldMouse;
		menu.ui_mouse.string = String( oldMouse );
		keys.keybindings.splice( 0, keys.keybindings.length, ...oldBindings );
		if ( ! hadWindow ) delete globalThis.window;

	}

}

// The keys menu shows 18 rows from y 48; its first visible row is the scroll
function keysScroll() {

	return menu.M_MenuRowAt( 100, 48 + 4 );

}

// Scrolls the keys menu to the top and puts the cursor on row
function keysSelect( move, row ) {

	for ( let i = 0; i < 20; i ++ ) menu.M_Keydown( keys.K_MWHEELUP );
	assertEqual( keysScroll(), 0, 'keys menu scrolled to the top' );
	move( 100, 48 + row * 8 + 4 );

}

Deno.test( 'menu hit test maps rows and rejects points outside the menu', () => {

	withMenu( () => {

		cmd.Cmd_ExecuteString( 'menu_main' );
		assertEqual( menu.M_MenuRowAt( 100, 32 + 4 ), 0, 'first main menu row' );
		assertEqual( menu.M_MenuRowAt( 100, 32 + 2 * 20 + 19 ), 2, 'bottom edge of the third row' );
		assertEqual( menu.M_MenuRowAt( 100, 31 ), - 1, 'above the list' );
		assertEqual( menu.M_MenuRowAt( 100, 32 + 5 * 20 ), - 1, 'below the list' );
		assertEqual( menu.M_MenuRowAt( - 1, 40 ), - 1, 'left of the menu' );
		assertEqual( menu.M_MenuRowAt( 321, 40 ), - 1, 'right of the menu' );

		cmd.Cmd_ExecuteString( 'menu_options' );
		assertEqual( menu.M_MenuRowAt( 100, 32 + 14 * 8 + 4 ), 14, 'options rows are 8 pixels' );

		cmd.Cmd_ExecuteString( 'menu_setup' );
		assertEqual( menu.M_MenuRowAt( 100, 124 ), 3, 'setup uses its cursor table' );
		assertEqual( menu.M_MenuRowAt( 100, 100 ), - 1, 'between setup rows' );

	} );

} );

Deno.test( 'hovering moves the cursor and MOUSE1 selects the hovered row', () => {

	withMenu( ( move ) => {

		cmd.Cmd_ExecuteString( 'menu_main' );
		move( 100, 32 + 1 * 20 + 10 ); // Multiplayer
		menu.M_Keydown( keys.K_ENTER );
		assertEqual( menu.m_state, menu.m_multiplayer, 'Enter after hovering Multiplayer' );

		menu.M_Keydown( keys.K_MOUSE2 );
		assertEqual( menu.m_state, menu.m_main, 'MOUSE2 goes back' );

		move( 100, 32 + 2 * 20 + 10 ); // Options
		menu.M_Keydown( keys.K_MOUSE1 );
		assertEqual( menu.m_state, menu.m_options, 'MOUSE1 selects the row under the mouse' );

		// A click away from any row does nothing; outside the menu goes back
		move( 100, 196 );
		menu.M_Keydown( keys.K_MOUSE1 );
		assertEqual( menu.m_state, menu.m_options, 'click between rows' );
		move( 330, 100 );
		menu.M_Keydown( keys.K_MOUSE1 );
		assertEqual( menu.m_state, menu.m_main, 'click outside the menu goes back' );

		// The wheel moves the cursor in menus without a list to scroll
		move( 100, 32 + 2 * 20 + 10 ); // Options
		menu.M_Keydown( keys.K_MWHEELUP );
		menu.M_Keydown( keys.K_ENTER );
		assertEqual( menu.m_state, menu.m_multiplayer, 'wheel up moves the cursor up' );

	} );

} );

Deno.test( 'ui_mouse 0 ignores the mouse in menus', () => {

	withMenu( ( move ) => {

		cmd.Cmd_ExecuteString( 'menu_main' );
		move( 100, 32 + 10 ); // cursor on Single Player
		menu.ui_mouse.value = 0;
		move( 100, 32 + 2 * 20 + 10 ); // Options
		menu.M_Keydown( keys.K_MOUSE1 );
		menu.M_Keydown( keys.K_MOUSE2 );
		menu.M_Keydown( keys.K_MWHEELDOWN );
		assertEqual( menu.m_state, menu.m_main, 'mouse keys do nothing' );
		menu.M_Keydown( keys.K_ENTER );
		assertEqual( menu.m_state, menu.m_singleplayer, 'hover did not move the cursor' );

	} );

} );

Deno.test( 'the mouse does not move the cursor behind a modal dialog', () => {

	withMenu( ( move ) => {

		cmd.Cmd_ExecuteString( 'menu_main' );
		move( 100, 32 + 10 ); // cursor on Single Player
		let answer = null;
		keys.Key_BeginModal( ( yes ) => { answer = yes; } );
		try {

			move( 100, 32 + 2 * 20 + 10 ); // Options

		} finally {

			keys.Key_Event( 110, true ); // 'n' ends the dialog
			keys.Key_Event( 110, false );

		}

		assertEqual( answer, false, 'dialog answered no' );
		menu.M_Keydown( keys.K_ENTER );
		assertEqual( menu.m_state, menu.m_singleplayer, 'hover during the dialog was ignored' );

	} );

} );

Deno.test( 'key binding menu scrolls and has the weapon rows', () => {

	withMenu( ( move ) => {

		cmd.Cmd_ExecuteString( 'menu_keys' );
		keysSelect( move, 0 );

		// The wheel scrolls the list three rows at a time, up to the last page
		menu.M_Keydown( keys.K_MWHEELDOWN );
		assertEqual( keysScroll(), 3, 'one wheel step' );
		for ( let i = 0; i < 10; i ++ ) menu.M_Keydown( keys.K_MWHEELDOWN );
		const last = keysScroll();
		assertEqual( last > 0, true, 'the list scrolls' );
		assertEqual( menu.M_MenuRowAt( 100, 48 + 18 * 8 + 4 ), - 1, 'nothing below the last row' );

		// Moving the cursor off the top of the view scrolls the list
		keysSelect( move, 0 );
		for ( let i = 0; i < 18; i ++ ) menu.M_Keydown( keys.K_DOWNARROW );
		assertEqual( keysScroll(), 1, 'cursor row 18 scrolls one row' );
		menu.M_Keydown( keys.K_UPARROW );
		assertEqual( keysScroll(), 1, 'no scroll while the cursor is visible' );

		// Tapping the "more" row below the list scrolls a page
		keysSelect( move, 0 );
		const w = draw.Draw_GetVirtualWidth();
		const h = draw.Draw_GetVirtualHeight();
		menu.M_TouchInput( 100 + ( w - 320 ) / 2, 48 + 18 * 8 + 4 + ( h - 200 ) / 2, w, h );
		assertEqual( keysScroll(), last, 'tap below the list scrolls to the end' );
		menu.M_TouchInput( 100 + ( w - 320 ) / 2, 48 - 4 + ( h - 200 ) / 2, w, h );
		assertEqual( keysScroll(), 0, 'tap above the list scrolls back' );

		// Row 3 is the axe. Binding it leaves impulse 10 and 12 keys alone:
		// id's prefix match took them for impulse 1 keys and unbound them.
		keys.keybindings.fill( null );
		keys.keybindings[ 50 ] = 'impulse 10';
		keys.keybindings[ 51 ] = 'impulse 12';
		keysSelect( move, 3 );
		menu.M_Keydown( keys.K_ENTER );
		menu.M_Keydown( 52 );
		cmd.Cbuf_Execute();
		assertEqual( keys.keybindings[ 52 ], 'impulse 1', 'axe bound' );
		assertEqual( keys.keybindings[ 50 ], 'impulse 10', 'next weapon kept' );
		assertEqual( keys.keybindings[ 51 ], 'impulse 12', 'prev weapon kept' );

		// Row 2 is Ironwail's previous weapon
		keysSelect( move, 2 );
		menu.M_Keydown( keys.K_ENTER );
		menu.M_Keydown( 53 );
		cmd.Cbuf_Execute();
		assertEqual( keys.keybindings[ 53 ], 'impulse 12', 'prev weapon bound' );

		// Mouse buttons and the wheel can still be bound while grabbing
		keysSelect( move, 0 );
		menu.M_Keydown( keys.K_ENTER );
		menu.M_Keydown( keys.K_MWHEELUP );
		cmd.Cbuf_Execute();
		assertEqual( keys.keybindings[ keys.K_MWHEELUP ], '+attack', 'wheel bound' );
		keysSelect( move, 0 ); // leave the cursor on row 0 for other tests

	} );

} );

Deno.test( 'scr_showfps and scr_clock format as QuakeSpasm does', () => {

	assertEqual( screen.SCR_FormatFPS( 59.6 ), '  60 fps', '%4.0f pads to four columns' );
	assertEqual( screen.SCR_FormatFPS( 0 ), '   0 fps', 'zero' );
	assertEqual( screen.SCR_FormatFPS( 12345.2 ), '12345 fps', 'wider than four columns' );

	assertEqual( screen.SCR_FormatClock( 0 ), '0:00', 'start of the level' );
	assertEqual( screen.SCR_FormatClock( 65.9 ), '1:05', 'seconds are truncated' );
	assertEqual( screen.SCR_FormatClock( 3600 ), '60:00', 'minutes keep counting' );

} );

Deno.test( 'r_waterwarp 1 warps in water, slime and lava only', () => {

	const active = screenwarp.R_WaterWarpActive;
	assertEqual( active( 1, bspfile.CONTENTS_WATER ), true, 'water' );
	assertEqual( active( 1, bspfile.CONTENTS_SLIME ), true, 'slime' );
	assertEqual( active( 1, bspfile.CONTENTS_LAVA ), true, 'lava' );
	assertEqual( active( 1, bspfile.CONTENTS_EMPTY ), false, 'air' );
	assertEqual( active( 0, bspfile.CONTENTS_WATER ), false, 'off' );
	assertEqual( active( 2, bspfile.CONTENTS_WATER ), false, '2 is the FOV warp, not ported' );

} );
