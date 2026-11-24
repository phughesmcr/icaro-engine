// Tests for the sound, console, menu and status-bar fixes
// (port review SP-7, MP-3, C-8 .. C-14, C-20 .. C-22).

const cmd = await import( '../src/cmd.js' );
const cvar = await import( '../src/cvar.js' );
const keys = await import( '../src/keys.js' );
const sound = await import( '../src/sound.js' );
const snd_dma = await import( '../src/snd_dma.js' );
const console_ = await import( '../src/console.js' );
const sbar = await import( '../src/sbar.js' );
const gl_screen = await import( '../src/gl_screen.js' );
const menu = await import( '../src/menu.js' );
const draw = await import( '../src/gl_draw.js' );
const { cl } = await import( '../src/client.js' );

function assertEqual( actual, expected, message ) {

	if ( actual !== expected )
		throw new Error( `${message}: expected ${expected}, got ${actual}` );

}

cmd.Cbuf_Init();
cmd.Cmd_Init();
keys.Key_Init();

// stand-ins for the host commands a new game issues
const issued = [];
for ( const name of [ 'disconnect', 'maxplayers', 'map' ] )
	cmd.Cmd_AddCommand( name, () => issued.push( name ) );

const { channels, NUM_AMBIENTS, MAX_DYNAMIC_CHANNELS } = sound;
const FIRST = NUM_AMBIENTS;
const LAST = NUM_AMBIENTS + MAX_DYNAMIC_CHANNELS;
const fakeSfx = { name: 'test.wav', cache: null };
const fakeSource = { stop() {} };

function resetChannels() {

	for ( let i = 0; i < sound.MAX_CHANNELS; i ++ ) {

		const ch = channels[ i ];
		ch.sfx = null;
		ch.end = 0;
		ch.entnum = 0;
		ch.entchannel = 0;
		ch._audioSource = null;

	}

}

// every dynamic channel busy with a playing sound on its own entity
function fillChannels( paintedtime ) {

	resetChannels();
	sound.Sound_SetPaintedtime( paintedtime );
	for ( let i = FIRST; i < LAST; i ++ ) {

		channels[ i ].sfx = fakeSfx;
		channels[ i ]._audioSource = fakeSource;
		channels[ i ].entnum = 100 + i;
		channels[ i ].entchannel = 1;
		channels[ i ].end = paintedtime + 10000 + i;

	}

}

Deno.test( 'SP-7: SND_PickChannel picks the channel nearest completion', () => {

	cl.viewentity = 1;
	fillChannels( 50000 );
	channels[ FIRST + 5 ].end = 50000 + 5; // about to finish
	channels[ FIRST + 3 ].end = 50000 + 400000; // long sound, still playing
	assertEqual( snd_dma.SND_PickChannel( 2, 1 ), channels[ FIRST + 5 ], 'least time remaining' );
	resetChannels();

} );

Deno.test( 'SP-7: SND_PickChannel takes an empty channel even when it is the only one', () => {

	cl.viewentity = 1;
	fillChannels( 50000 );
	channels[ FIRST + 7 ].sfx = null;
	channels[ FIRST + 7 ]._audioSource = null;
	channels[ FIRST + 7 ].end = 0;
	assertEqual( snd_dma.SND_PickChannel( 2, 1 ), channels[ FIRST + 7 ], 'single free channel' );
	resetChannels();

} );

Deno.test( 'SP-7: SND_PickChannel treats a channel with no live source as finished', () => {

	cl.viewentity = 1;
	fillChannels( 50000 );
	// player sound whose playback never started: not protected, end counts as 0
	channels[ FIRST + 2 ].entnum = cl.viewentity;
	channels[ FIRST + 2 ]._audioSource = null;
	assertEqual( snd_dma.SND_PickChannel( 2, 1 ), channels[ FIRST + 2 ], 'finished channel' );
	resetChannels();

} );

Deno.test( 'SP-7: SND_PickChannel keeps player sounds from monsters', () => {

	cl.viewentity = 1;
	fillChannels( 50000 );
	channels[ FIRST + 4 ].entnum = cl.viewentity;
	channels[ FIRST + 4 ].end = 50000 + 1; // would win if not protected
	channels[ FIRST + 6 ].end = 50000 + 2;
	assertEqual( snd_dma.SND_PickChannel( 2, 1 ), channels[ FIRST + 6 ], 'monster sound' );
	resetChannels();

} );

Deno.test( 'SP-7: SND_PickChannel overrides the same entity and channel', () => {

	cl.viewentity = 1;
	fillChannels( 50000 );
	channels[ FIRST + 6 ].entnum = 7;
	channels[ FIRST + 6 ].entchannel = 3;
	assertEqual( snd_dma.SND_PickChannel( 7, 3 ), channels[ FIRST + 6 ], 'same entity override' );
	resetChannels();

} );

Deno.test( 'C-20: per-side channel gain clamps at 255', () => {

	assertEqual( snd_dma.SND_ChannelGain( 510 ), 1, 'hard-panned side' );
	assertEqual( snd_dma.SND_ChannelGain( 255 ), 1, 'full volume' );
	assertEqual( snd_dma.SND_ChannelGain( 0 ), 0, 'silent side' );
	assertEqual( snd_dma.SND_ChannelGain( - 3 ), 0, 'negative' );

} );

Deno.test( 'C-21: volume defaults to 0.7', () => {

	assertEqual( sound.volume.string, '0.7', 'volume string' );
	assertEqual( sound.volume.value, 0.7, 'volume value' );

} );

Deno.test( 'C-22: _sprintf truncates %i/%d and supports %x', () => {

	assertEqual( console_._sprintf( '%i', - 2.7 ), '-2', '%i negative' );
	assertEqual( console_._sprintf( '%d', 2.7 ), '2', '%d positive' );
	assertEqual( console_._sprintf( '%i', - 0.5 ), '0', '%i toward zero' );
	assertEqual( console_._sprintf( '%x', 255 ), 'ff', '%x' );
	assertEqual( console_._sprintf( '%X', 48879 ), 'BEEF', '%X' );
	assertEqual( console_._sprintf( '%04x', 10 ), '000a', '%04x' );
	assertEqual( console_._sprintf( '%x', - 1 ), 'ffffffff', '%x negative' );

} );

Deno.test( 'MP-3: messagemode2 sets team_message, messagemode clears it', () => {

	console_.Con_MessageMode2_f();
	assertEqual( keys.key_dest, keys.key_message, 'messagemode2 key_dest' );
	assertEqual( keys.team_message, true, 'messagemode2 team_message' );

	console_.Con_MessageMode_f();
	assertEqual( keys.team_message, false, 'messagemode team_message' );

	keys.set_key_dest( keys.key_game );

} );

Deno.test( 'C-14: Con_ToggleConsole_f resets key_linepos', () => {

	console_.Con_SetExternals( { cls: { state: 2, signon: 0 } } ); // ca_connected
	keys.set_key_dest( keys.key_console );
	keys.key_lines[ keys.edit_line ][ 1 ] = 104;
	keys.key_lines[ keys.edit_line ][ 2 ] = 105;
	keys.set_key_linepos( 3 );

	console_.Con_ToggleConsole_f();

	assertEqual( keys.key_dest, keys.key_game, 'key_dest' );
	assertEqual( keys.key_lines[ keys.edit_line ][ 1 ], 0, 'line cleared' );
	assertEqual( keys.key_linepos, 1, 'key_linepos' );

} );

Deno.test( 'C-13: chat input draws a blinking cursor', () => {

	const drawn = [];
	console_.Con_SetExternals( {
		getRealtime: () => 0,
		Draw_Character: ( x, _y, num ) => drawn.push( [ x, num ] ),
		Draw_String: () => {}
	} );
	keys.set_key_dest( keys.key_message );

	console_.Con_DrawNotify();

	keys.set_key_dest( keys.key_game );
	// empty chat buffer: cursor right after "say:" at column 5
	const cursor = drawn.find( ( [ x ] ) => x === 5 << 3 );
	if ( ! cursor ) throw new Error( 'no cursor drawn' );
	assertEqual( cursor[ 1 ], 10, 'cursor glyph' );

} );

function sbarDraws( num, digits ) {

	const pics = [];
	for ( let i = 0; i < 11; i ++ ) pics.push( { frame: i } );

	const drawn = [];
	sbar.Sbar_SetExternals( {
		cl: { gametype: 1 }, // GAME_DEATHMATCH: no centring offset
		Draw_PicFromWad: ( name ) => {

			const m = /^num_(\d|minus)$/.exec( name );
			if ( ! m ) return { name };
			return m[ 1 ] === 'minus' ? pics[ 10 ] : pics[ Number( m[ 1 ] ) ];

		},
		Draw_Pic: ( x, _y, pic ) => drawn.push( [ x, pic.frame ] )
	} );
	sbar.Sbar_Init();

	// Sbar_DrawPic reads the virtual screen size, which reads devicePixelRatio
	const hadWindow = 'window' in globalThis;
	if ( ! hadWindow ) globalThis.window = { devicePixelRatio: 1 };

	try {

		sbar.Sbar_DrawNum( 24, 0, num, digits, 0 );

	} finally {

		if ( ! hadWindow ) delete globalThis.window;

	}

	return drawn;

}

Deno.test( 'C-10: Sbar_DrawNum keeps the rightmost digits', () => {

	const drawn = sbarDraws( 1234, 3 );
	assertEqual( JSON.stringify( drawn ), JSON.stringify( [ [ 24, 2 ], [ 48, 3 ], [ 72, 4 ] ] ), '1234 in 3 digits' );

} );

Deno.test( 'C-10: Sbar_DrawNum draws the minus sign inside the digit cells', () => {

	const drawn = sbarDraws( - 5, 3 );
	assertEqual( JSON.stringify( drawn ), JSON.stringify( [ [ 48, 10 ], [ 72, 5 ] ] ), '-5 in 3 digits' );

} );

Deno.test( 'C-8: sizeup/sizedown go through Cvar_SetValue', () => {

	gl_screen.SCR_Init();
	cvar.Cvar_Set( 'viewsize', '100' );

	cmd.Cmd_ExecuteString( 'sizeup' );
	assertEqual( gl_screen.scr_viewsize.value, 110, 'sizeup value' );
	assertEqual( Number( gl_screen.scr_viewsize.string ), 110, 'sizeup string' );

	cmd.Cmd_ExecuteString( 'sizedown' );
	cmd.Cmd_ExecuteString( 'sizedown' );
	assertEqual( Number( gl_screen.scr_viewsize.string ), 90, 'sizedown string' );

	cvar.Cvar_Set( 'viewsize', '100' );

} );

Deno.test( 'C-11: New Game asks for confirmation while a server is active', () => {

	issued.length = 0;
	menu.M_Init();
	gl_screen.SCR_SetExternals( { cls: { state: 2, signon: 0, demoplayback: false } } );
	menu.M_SetExternals( {
		sv: { active: true },
		key_dest_set: keys.set_key_dest,
		key_dest_get: () => keys.key_dest
	} );

	// answer no: nothing happens, menu stays up
	cmd.Cmd_ExecuteString( 'menu_singleplayer' );
	menu.M_Keydown( keys.K_ENTER );
	assertEqual( keys.Key_ModalActive(), true, 'dialog shown' );
	keys.Key_Event( 97, true ); // 'a' is ignored
	keys.Key_Event( 97, false );
	assertEqual( keys.Key_ModalActive(), true, 'still waiting' );
	keys.Key_Event( 110, true ); // 'n'
	keys.Key_Event( 110, false );
	assertEqual( keys.Key_ModalActive(), false, 'dialog closed' );
	cmd.Cbuf_Execute();
	assertEqual( issued.length, 0, 'no new game on n' );
	assertEqual( keys.key_dest, keys.key_menu, 'menu still up' );

	// answer yes: the new game starts
	menu.M_Keydown( keys.K_ENTER );
	keys.Key_Event( 121, true ); // 'y'
	keys.Key_Event( 121, false );
	cmd.Cbuf_Execute();
	assertEqual( issued.join( ',' ), 'disconnect,maxplayers,map', 'new game on y' );
	assertEqual( keys.key_dest, keys.key_game, 'back in game' );

	menu.M_SetExternals( { sv: { active: false } } );

} );

Deno.test( 'C-11: Escape cancels the New Game confirmation', () => {

	issued.length = 0;

	menu.M_Init();
	gl_screen.SCR_SetExternals( { cls: { state: 2, signon: 0, demoplayback: false } } );
	menu.M_SetExternals( {
		sv: { active: true },
		key_dest_set: keys.set_key_dest,
		key_dest_get: () => keys.key_dest
	} );

	cmd.Cmd_ExecuteString( 'menu_singleplayer' );
	menu.M_Keydown( keys.K_ENTER );
	keys.Key_Event( keys.K_ESCAPE, true );
	keys.Key_Event( keys.K_ESCAPE, false );
	cmd.Cbuf_Execute();
	assertEqual( keys.Key_ModalActive(), false, 'dialog closed' );
	assertEqual( issued.length, 0, 'no new game on escape' );
	assertEqual( keys.key_dest, keys.key_menu, 'menu still up' );

	menu.M_SetExternals( { sv: { active: false } } );

} );

// Taps at the YES / NO choices, on an element the size of _vid. The New Game
// text is two lines, so its choice row starts a blank line under them.
function modalChoiceY() {

	return Math.floor( draw.Draw_GetVirtualHeight() * 0.35 ) + 2 * 8 + 8 + 4;

}

function tapModal( dx ) {

	const w = draw.Draw_GetVirtualWidth();
	const h = draw.Draw_GetVirtualHeight();
	menu.M_TouchInput( ( w >> 1 ) + dx, modalChoiceY(), w, h );

}

function tapQuit( vx, vy ) {

	const w = draw.Draw_GetVirtualWidth();
	const h = draw.Draw_GetVirtualHeight();
	menu.M_TouchInput( vx + ( w - 320 ) / 2, vy + ( h - 200 ) / 2, w, h );

}

function withNewGameMenu( fn ) {

	issued.length = 0;

	const clock = { now: 10 };
	menu.M_Init();
	gl_screen.SCR_SetExternals( { cls: { state: 2, signon: 0, demoplayback: false } } );
	menu.M_SetExternals( {
		sv: { active: true },
		key_dest_set: keys.set_key_dest,
		key_dest_get: () => keys.key_dest,
		realtime_get: () => clock.now
	} );

	const hadWindow = 'window' in globalThis;
	if ( ! hadWindow ) globalThis.window = { devicePixelRatio: 1 };

	try {

		fn( clock );

	} finally {

		if ( keys.Key_ModalActive() ) {

			keys.Key_Event( keys.K_ESCAPE, true );
			keys.Key_Event( keys.K_ESCAPE, false );

		}

		if ( ! hadWindow ) delete globalThis.window;
		menu.M_SetExternals( { sv: { active: false }, realtime_get: () => 0 } );

	}

}

Deno.test( 'C-11: touch answers the dialog on YES or NO, but not straight after it opens', () => {

	withNewGameMenu( ( clock ) => {

		cmd.Cmd_ExecuteString( 'menu_singleplayer' );
		menu.M_Keydown( keys.K_ENTER );

		clock.now += 0.1; // second click of a double click
		tapModal( - 30 );
		assertEqual( keys.Key_ModalActive(), true, 'early tap ignored' );

		clock.now += 1;
		const w = draw.Draw_GetVirtualWidth();
		const h = draw.Draw_GetVirtualHeight();
		menu.M_TouchInput( w >> 1, 2, w, h ); // top of the screen
		menu.M_TouchInput( w >> 1, h - 2, w, h ); // bottom
		tapModal( - 100 ); // left of YES
		assertEqual( keys.Key_ModalActive(), true, 'taps away from the choices ignored' );

		tapModal( 20 ); // NO
		cmd.Cbuf_Execute();
		assertEqual( keys.Key_ModalActive(), false, 'NO tap answers' );
		assertEqual( issued.length, 0, 'no new game on NO' );

		menu.M_Keydown( keys.K_ENTER );
		clock.now += 1;
		tapModal( - 30 ); // YES
		cmd.Cbuf_Execute();
		assertEqual( keys.Key_ModalActive(), false, 'YES tap answers' );
		assertEqual( issued.join( ',' ), 'disconnect,maxplayers,map', 'new game on YES' );

	} );

} );

Deno.test( 'C-11: arrows and Enter (gamepad d-pad and A) answer the dialog', () => {

	withNewGameMenu( () => {

		cmd.Cmd_ExecuteString( 'menu_singleplayer' );

		// The Enter that opens it, its autorepeat and its key-up don't answer;
		// a fresh Enter takes the choice, which starts on NO
		keys.Key_Event( keys.K_ENTER, true );
		assertEqual( keys.Key_ModalActive(), true, 'dialog shown' );
		assertEqual( keys.Key_ModalYes(), false, 'starts on NO' );
		keys.Key_Event( keys.K_ENTER, true ); // autorepeat
		keys.Key_Event( keys.K_ENTER, false );
		assertEqual( keys.Key_ModalActive(), true, 'opening Enter did not answer' );
		keys.Key_Event( keys.K_ENTER, true );
		keys.Key_Event( keys.K_ENTER, false );
		cmd.Cbuf_Execute();
		assertEqual( keys.Key_ModalActive(), false, 'Enter answers' );
		assertEqual( issued.length, 0, 'NO by default' );
		assertEqual( keys.key_dest, keys.key_menu, 'menu still up' );

		// An arrow moves the choice to YES, Enter takes it
		keys.Key_Event( keys.K_ENTER, true );
		keys.Key_Event( keys.K_ENTER, false );
		assertEqual( keys.Key_ModalYes(), false, 'NO again on reopening' );
		keys.Key_Event( keys.K_RIGHTARROW, true );
		keys.Key_Event( keys.K_RIGHTARROW, true ); // autorepeat: no second move
		keys.Key_Event( keys.K_RIGHTARROW, false );
		assertEqual( keys.Key_ModalYes(), true, 'arrow selects YES' );
		assertEqual( keys.Key_ModalActive(), true, 'arrows do not answer' );
		keys.Key_Event( keys.K_ENTER, true );
		keys.Key_Event( keys.K_ENTER, false );
		cmd.Cbuf_Execute();
		assertEqual( keys.Key_ModalActive(), false, 'Enter answers YES' );
		assertEqual( issued.join( ',' ), 'disconnect,maxplayers,map', 'new game on YES' );

	} );

} );

Deno.test( 'quit menu: NO by default, arrows and Enter, y disconnects, touch on YES/NO', () => {

	withNewGameMenu( ( clock ) => {

		// Enter on the default NO: back to the main menu, nothing issued
		cmd.Cmd_ExecuteString( 'menu_quit' );
		assertEqual( menu.m_state, menu.m_quit, 'quit menu up' );
		menu.M_Keydown( keys.K_ENTER );
		cmd.Cbuf_Execute();
		assertEqual( menu.m_state, menu.m_main, 'NO: main menu' );
		assertEqual( issued.length, 0, 'NO: no disconnect' );

		// An arrow selects YES: Enter disconnects and shows the main menu
		cmd.Cmd_ExecuteString( 'menu_quit' );
		menu.M_Keydown( keys.K_DOWNARROW );
		menu.M_Keydown( keys.K_ENTER );
		cmd.Cbuf_Execute();
		assertEqual( issued.join( ',' ), 'disconnect', 'YES disconnects' );
		assertEqual( menu.m_state, menu.m_main, 'YES: main menu' );
		assertEqual( keys.key_dest, keys.key_menu, 'menu still up' );

		// 'y' answers yes and 'n' no, as in C
		issued.length = 0;
		cmd.Cmd_ExecuteString( 'menu_quit' );
		menu.M_Keydown( 110 );
		cmd.Cbuf_Execute();
		assertEqual( issued.length, 0, 'n: no disconnect' );
		cmd.Cmd_ExecuteString( 'menu_quit' );
		menu.M_Keydown( 89 ); // 'Y'
		cmd.Cbuf_Execute();
		assertEqual( issued.join( ',' ), 'disconnect', 'Y disconnects' );

		// Touch: early taps and taps away from the choices do nothing
		issued.length = 0;
		cmd.Cmd_ExecuteString( 'menu_quit' );
		clock.now += 0.1;
		tapQuit( 130, 112 ); // YES, too soon
		assertEqual( menu.m_state, menu.m_quit, 'early tap ignored' );
		clock.now += 1;
		tapQuit( 160, 20 ); // top half
		tapQuit( 160, 180 ); // bottom half
		assertEqual( menu.m_state, menu.m_quit, 'taps away from the choices ignored' );
		tapQuit( 180, 112 ); // NO
		cmd.Cbuf_Execute();
		assertEqual( menu.m_state, menu.m_main, 'NO tap: main menu' );
		assertEqual( issued.length, 0, 'NO tap: no disconnect' );

		cmd.Cmd_ExecuteString( 'menu_quit' );
		clock.now += 1;
		tapQuit( 130, 112 ); // YES
		cmd.Cbuf_Execute();
		assertEqual( issued.join( ',' ), 'disconnect', 'YES tap disconnects' );

	} );

} );

Deno.test( 'yes/no prompts: the mouse selects YES or NO, the wheel does not', () => {

	const oldMouse = menu.ui_mouse.value;
	menu.ui_mouse.value = 1;

	try {

		withNewGameMenu( ( clock ) => {

			const w = draw.Draw_GetVirtualWidth();
			const h = draw.Draw_GetVirtualHeight();
			const moveQuit = ( vx, vy ) => menu.M_Mousemove( vx + ( w - 320 ) / 2, vy + ( h - 200 ) / 2, w, h );

			// Quit menu: hovering YES selects it, the wheel doesn't toggle it
			cmd.Cmd_ExecuteString( 'menu_quit' );
			menu.M_Keydown( keys.K_MWHEELDOWN );
			menu.M_Keydown( keys.K_ENTER );
			cmd.Cbuf_Execute();
			assertEqual( issued.length, 0, 'wheel left NO selected' );

			cmd.Cmd_ExecuteString( 'menu_quit' );
			moveQuit( 130, 112 ); // YES
			menu.M_Keydown( keys.K_ENTER );
			cmd.Cbuf_Execute();
			assertEqual( issued.join( ',' ), 'disconnect', 'hovered YES taken' );

			// SCR_ModalMessage: hovering moves the choice both ways
			issued.length = 0;
			cmd.Cmd_ExecuteString( 'menu_singleplayer' );
			menu.M_Keydown( keys.K_ENTER );
			clock.now += 1;
			menu.M_Mousemove( ( w >> 1 ) - 30, modalChoiceY(), w, h );
			assertEqual( keys.Key_ModalYes(), true, 'hover YES' );
			menu.M_Mousemove( ( w >> 1 ) + 20, modalChoiceY(), w, h );
			assertEqual( keys.Key_ModalYes(), false, 'hover NO' );
			menu.M_Mousemove( ( w >> 1 ) - 30, 2, w, h );
			assertEqual( keys.Key_ModalYes(), false, 'hover elsewhere keeps the choice' );

		} );

	} finally {

		menu.ui_mouse.value = oldMouse;

	}

} );

Deno.test( 'quit YES on the title screen leaves the demo loop alone', () => {

	withNewGameMenu( () => {

		const cls = { state: 2, demonum: - 1, demoplayback: true }; // ca_connected
		menu.M_SetExternals( { sv: { active: false }, cls } );
		try {

			cmd.Cmd_ExecuteString( 'menu_quit' );
			menu.M_Keydown( 121 ); // 'y'
			cmd.Cbuf_Execute();
			assertEqual( issued.length, 0, 'no disconnect during the demo' );
			assertEqual( menu.m_state, menu.m_main, 'main menu' );

			cls.demoplayback = false; // a client in a remote game
			cmd.Cmd_ExecuteString( 'menu_quit' );
			menu.M_Keydown( 121 );
			cmd.Cbuf_Execute();
			assertEqual( issued.join( ',' ), 'disconnect', 'remote game: disconnect' );

		} finally {

			menu.M_SetExternals( { cls: { state: 0, demonum: - 1, demoplayback: false } } );

		}

	} );

} );

Deno.test( 'C-12: the Options menu has a CD Music Volume slider', () => {

	menu.M_Init();
	cvar.Cvar_RegisterVariable( sound.bgmvolume );
	cvar.Cvar_Set( 'bgmvolume', '0.5' );

	cmd.Cmd_ExecuteString( 'menu_options' );
	for ( let i = 0; i < 7; i ++ )
		menu.M_Keydown( keys.K_DOWNARROW );
	menu.M_Keydown( keys.K_RIGHTARROW );
	assertEqual( Math.round( sound.bgmvolume.value * 10 ), 6, 'bgmvolume up' );
	menu.M_Keydown( keys.K_LEFTARROW );
	menu.M_Keydown( keys.K_LEFTARROW );
	assertEqual( Math.round( sound.bgmvolume.value * 10 ), 4, 'bgmvolume down' );

	menu.M_Keydown( keys.K_ESCAPE );

} );

Deno.test( 'C-12: the Keys menu refuses to bind backtick', () => {

	const oldBindings = keys.keybindings.slice();

	try {

		menu.M_Init();
		keys.keybindings.fill( null );

		cmd.Cmd_ExecuteString( 'menu_keys' );
		menu.M_Keydown( keys.K_ENTER );
		menu.M_Keydown( 96 ); // '`'
		cmd.Cbuf_Execute();
		assertEqual( keys.keybindings[ 96 ], null, 'backtick unbound' );

	} finally {

		keys.keybindings.splice( 0, keys.keybindings.length, ...oldBindings );

	}

} );
