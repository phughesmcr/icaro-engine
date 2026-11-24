// Tests for the QuakeSpasm/Ironwail console input: line editing, history,
// clipboard paste and tab completion (keys.js, console.js).

const cmd = await import( '../src/cmd.js' );
const cvar = await import( '../src/cvar.js' );
const keys = await import( '../src/keys.js' );
const con = await import( '../src/console.js' );
const { COM_AddPack } = await import( '../src/pak.js' );

const { K_ENTER, K_TAB, K_BACKSPACE, K_DEL, K_INS, K_HOME, K_END, K_LEFTARROW, K_RIGHTARROW,
	K_UPARROW, K_DOWNARROW, K_CTRL, K_SHIFT } = keys;

function assertEqual( actual, expected, message ) {

	if ( actual !== expected )
		throw new Error( `${message}: expected ${JSON.stringify( expected )}, got ${JSON.stringify( actual )}` );

}

cmd.Cbuf_Init();
cmd.Cmd_Init();
keys.Key_SetHistoryStorage( null );
keys.Key_Init();
keys.Key_SetExternals( { cls: { state: 2, demoplayback: false, signon: 0 } } ); // no SCR_UpdateScreen on Enter
globalThis.window = { devicePixelRatio: 1 }; // gl_draw.js sizes the console from it
con.Con_Init();

// Console output, read back by drawing the console
const drawn = new Map();
con.Con_SetExternals( {
	Draw_Character: ( x, y, c ) => {

		const row = drawn.get( y ) ?? [];
		row[ ( x >> 3 ) - 1 ] = c;
		drawn.set( y, row );

	},
	getRealtime: () => 0,
} );

function consoleText() {

	drawn.clear();
	con.Con_DrawConsole( 8 * 200, false );
	const rows = [ ...drawn.keys() ].sort( ( a, b ) => a - b );
	return rows.map( ( y ) => String.fromCharCode( ...drawn.get( y ).map( ( c ) => c ?? 32 ) ).trimEnd() ).join( '\n' );

}

function press( key ) {

	keys.Key_Event( key, true );
	keys.Key_Event( key, false );

}

function withKey( mod, key ) {

	keys.Key_Event( mod, true );
	press( key );
	keys.Key_Event( mod, false );

}

function type( text ) {

	for ( let i = 0; i < text.length; i ++ )
		press( text.charCodeAt( i ) );

}

// the edit line without the prompt
function line() {

	return keys.Key_LineString( keys.key_lines[ keys.edit_line ], 1 );

}

// the edit line with '|' at the cursor
function lineWithCursor() {

	const s = line();
	const pos = keys.key_linepos - 1;
	return s.substring( 0, pos ) + '|' + s.substring( pos );

}

function reset() {

	keys.Key_SetHistoryStorage( null );
	keys.History_Init();
	keys.set_key_dest( keys.key_console );
	cmd.Cbuf_Init();
	if ( keys.key_insert === 0 ) press( K_INS );

}

function submit( text ) {

	type( text );
	press( K_ENTER );

}

Deno.test( 'console: typing in the middle of the line inserts at the cursor', () => {

	reset();
	type( 'conect' );
	assertEqual( lineWithCursor(), 'conect|', 'typed' );
	press( K_LEFTARROW );
	press( K_LEFTARROW );
	press( K_LEFTARROW );
	assertEqual( lineWithCursor(), 'con|ect', 'left' );
	type( 'n' );
	assertEqual( lineWithCursor(), 'conn|ect', 'inserted' );
	press( K_RIGHTARROW );
	assertEqual( lineWithCursor(), 'conne|ct', 'right' );
	press( K_HOME );
	assertEqual( lineWithCursor(), '|connect', 'home' );
	press( K_END );
	assertEqual( lineWithCursor(), 'connect|', 'end' );

} );

Deno.test( 'console: Backspace and Delete edit at the cursor', () => {

	reset();
	type( 'mapp e1m1' );
	press( K_HOME );
	press( K_RIGHTARROW );
	press( K_RIGHTARROW );
	press( K_RIGHTARROW );
	press( K_DEL );
	assertEqual( lineWithCursor(), 'map| e1m1', 'delete' );
	press( K_BACKSPACE );
	assertEqual( lineWithCursor(), 'ma| e1m1', 'backspace' );
	press( K_HOME );
	press( K_BACKSPACE );
	assertEqual( lineWithCursor(), '|ma e1m1', 'backspace at the start does nothing' );
	press( K_END );
	press( K_DEL );
	assertEqual( lineWithCursor(), 'ma e1m1|', 'delete at the end does nothing' );

} );

Deno.test( 'console: Ctrl+arrows jump words, Ctrl+Backspace and Ctrl+Delete delete them', () => {

	reset();
	type( 'bind x "say hi"' );
	withKey( K_CTRL, K_LEFTARROW );
	assertEqual( lineWithCursor(), 'bind x "say |hi"', 'ctrl+left' );
	withKey( K_CTRL, K_LEFTARROW );
	assertEqual( lineWithCursor(), 'bind x |"say hi"', 'ctrl+left again' );
	withKey( K_CTRL, K_RIGHTARROW );
	assertEqual( lineWithCursor(), 'bind x "say |hi"', 'ctrl+right' );
	withKey( K_CTRL, K_BACKSPACE );
	assertEqual( lineWithCursor(), 'bind x |hi"', 'ctrl+backspace' );
	press( K_HOME );
	withKey( K_CTRL, K_DEL );
	assertEqual( lineWithCursor(), '|x hi"', 'ctrl+delete' );

} );

Deno.test( 'console: Insert toggles overwrite mode', () => {

	reset();
	type( 'fov 90' );
	press( K_LEFTARROW );
	press( K_LEFTARROW );
	press( K_INS );
	assertEqual( keys.key_insert, 0, 'overwrite mode' );
	type( '11' );
	assertEqual( lineWithCursor(), 'fov 11|', 'overwritten' );
	type( '0' );
	assertEqual( lineWithCursor(), 'fov 110|', 'appends at the end' );
	press( K_INS );
	assertEqual( keys.key_insert, 1, 'insert mode' );

} );

Deno.test( 'console: Ctrl chords type nothing, Ctrl+C clears the line', () => {

	reset();
	type( 'say hi' );
	withKey( K_CTRL, 97 ); // Ctrl+A
	assertEqual( line(), 'say hi', 'ctrl+a typed nothing' );
	withKey( K_CTRL, 99 ); // Ctrl+C
	assertEqual( lineWithCursor(), '|', 'ctrl+c cleared the line' );

} );

Deno.test( 'console: held editing keys autorepeat, other keys do not', () => {

	reset();
	type( 'abcd' );
	keys.Key_Event( K_LEFTARROW, true );
	keys.Key_Event( K_LEFTARROW, true ); // browser autorepeat
	keys.Key_Event( K_LEFTARROW, true );
	keys.Key_Event( K_LEFTARROW, false );
	assertEqual( lineWithCursor(), 'a|bcd', 'left repeated' );

	// in the game, repeats are still dropped
	keys.set_key_dest( keys.key_game );
	let runs = 0;
	cmd.Cmd_AddCommand( 'repeat_probe', () => runs ++ );
	keys.Key_SetBinding( 113, 'repeat_probe' ); // 'q'
	keys.Key_Event( 113, true );
	keys.Key_Event( 113, true );
	keys.Key_Event( 113, false );
	cmd.Cbuf_Execute();
	assertEqual( runs, 1, 'game key ran once' );
	keys.Key_SetBinding( 113, '' );

	// a forced-up console (no map loaded) still edits with key_game
	reset();
	type( 'abcd' );
	keys.set_key_dest( keys.key_game );
	con.Con_SetForcedup( true );
	try {

		keys.Key_Event( K_LEFTARROW, true );
		keys.Key_Event( K_LEFTARROW, true );
		keys.Key_Event( K_LEFTARROW, false );
		assertEqual( lineWithCursor(), 'ab|cd', 'left repeated with con_forcedup' );

	} finally {

		con.Con_SetForcedup( false );

	}

} );

Deno.test( 'console: Enter runs the line and Up/Down walk the history', () => {

	reset();
	submit( 'first' );
	submit( 'second' );
	submit( 'second' ); // repeated: stored once
	type( 'draft' );

	press( K_UPARROW );
	assertEqual( lineWithCursor(), 'second|', 'up 1' );
	press( K_UPARROW );
	assertEqual( lineWithCursor(), 'first|', 'up 2' );
	press( K_UPARROW );
	assertEqual( lineWithCursor(), 'first|', 'up stops at the oldest' );
	press( K_DOWNARROW );
	assertEqual( lineWithCursor(), 'second|', 'down 1' );
	// vanilla left the recalled command in the buffer here
	press( K_DOWNARROW );
	assertEqual( lineWithCursor(), 'draft|', 'down back to the line being typed' );
	press( K_DOWNARROW );
	assertEqual( lineWithCursor(), 'draft|', 'down at the bottom does nothing' );

	// Right at the end of the line copies from the previous command
	press( K_ENTER );
	type( 'dr' );
	press( K_RIGHTARROW );
	assertEqual( lineWithCursor(), 'dra|', 'right copies a character' );

} );

Deno.test( 'console: Enter adds the line to the command buffer', () => {

	reset();
	const ran = [];
	cmd.Cmd_AddCommand( 'enter_probe', () => ran.push( cmd.Cmd_Argv( 1 ) ) );
	type( 'enter_probe ok' );
	press( K_LEFTARROW ); // the whole line runs, wherever the cursor is
	press( K_ENTER );
	cmd.Cbuf_Execute();
	assertEqual( ran.join(), 'ok', 'ran' );
	assertEqual( lineWithCursor(), '|', 'new empty line' );

} );

Deno.test( 'console: history is saved to storage and loaded back', () => {

	const store = new Map();
	const storage = {
		getItem: ( k ) => store.has( k ) ? store.get( k ) : null,
		setItem: ( k, v ) => store.set( k, v ),
	};

	reset();
	keys.Key_SetHistoryStorage( storage );
	submit( 'connect https://example.com:4433' );
	press( K_ENTER ); // empty lines aren't saved, nor do they hide later ones
	submit( 'map e1m1' );
	assertEqual( store.get( 'quake_history' ), 'connect https://example.com:4433\nmap e1m1\n', 'saved' );

	keys.History_Init();
	assertEqual( lineWithCursor(), '|', 'fresh line after load' );
	press( K_UPARROW );
	assertEqual( line(), 'map e1m1', 'newest' );
	press( K_UPARROW );
	assertEqual( line(), 'connect https://example.com:4433', 'oldest' );

	// a broken store is ignored
	keys.Key_SetHistoryStorage( { getItem() { throw new Error( 'blocked' ); }, setItem() { throw new Error( 'blocked' ); } } );
	keys.History_Init();
	submit( 'echo still works' );
	assertEqual( lineWithCursor(), '|', 'enter with a failing store' );

} );

Deno.test( 'console: history storage is off under Deno unless a store is set', () => {

	const original = globalThis.localStorage;
	let touched = false;
	const fake = { getItem() { touched = true; return null; }, setItem() { touched = true; } };
	Object.defineProperty( globalThis, 'localStorage', { value: fake, configurable: true, writable: true } );

	try {

		reset();
		keys.Key_SetHistoryStorage( undefined ); // the default: localStorage, but not under Deno
		keys.History_Init();
		submit( 'echo not saved' );

	} finally {

		Object.defineProperty( globalThis, 'localStorage', { value: original, configurable: true, writable: true } );
		keys.Key_SetHistoryStorage( null );

	}

	assertEqual( touched, false, 'localStorage untouched' );

} );

Deno.test( 'console: pasted text goes in at the cursor, up to the first line break', () => {

	reset();
	type( 'connect ' );
	keys.PasteToConsole( 'https://example.com:4433/room\nquit\n' );
	assertEqual( lineWithCursor(), 'connect https://example.com:4433/room|', 'pasted first line' );

	press( K_HOME );
	keys.PasteToConsole( '\tsayé ' );
	assertEqual( lineWithCursor(), ' say |connect https://example.com:4433/room', 'tab to space, non-ASCII dropped' );

	// cut to the line length
	reset();
	keys.PasteToConsole( 'x'.repeat( 400 ) );
	assertEqual( line().length, keys.MAXCMDLINE - 2, 'filled to the limit' );
	keys.PasteToConsole( 'y' );
	assertEqual( line().length, keys.MAXCMDLINE - 2, 'full line takes no more' );

	reset();
	type( 'ab' );
	press( K_LEFTARROW );
	keys.PasteToConsole( 'z'.repeat( 300 ) );
	assertEqual( line().length, keys.MAXCMDLINE - 2, 'mid-line paste cut to the limit' );
	assertEqual( line().substring( 0, 2 ), 'az', 'inserted after the cursor' );

} );

function tick() {

	return new Promise( ( resolve ) => setTimeout( resolve, 5 ) );

}

async function withNavigator( clipboard, fn ) {

	const desc = Object.getOwnPropertyDescriptor( globalThis, 'navigator' );
	Object.defineProperty( globalThis, 'navigator', { value: { clipboard: clipboard }, configurable: true, writable: true } );
	try {

		await fn();

	} finally {

		if ( desc ) Object.defineProperty( globalThis, 'navigator', desc );
		else delete globalThis.navigator;

	}

}

Deno.test( 'console: Ctrl+V reads the clipboard when no paste event comes', async () => {

	reset();
	let reads = 0;
	await withNavigator( { readText: () => { reads ++; return Promise.resolve( 'connect wt://host\r\n' ); } }, async () => {

		type( 'x' );
		press( K_LEFTARROW );
		withKey( K_CTRL, 118 ); // Ctrl+V
		assertEqual( line(), 'x', 'no v typed' );
		await tick();
		assertEqual( reads, 1, 'readText called' );
		assertEqual( lineWithCursor(), 'connect wt://host|x', 'pasted at the cursor' );

		// Shift+Ins too
		keys.Key_Event( K_SHIFT, true );
		press( K_INS );
		keys.Key_Event( K_SHIFT, false );
		await tick();
		assertEqual( reads, 2, 'shift+ins read the clipboard' );
		assertEqual( keys.key_insert, 1, 'shift+ins did not toggle insert' );

	} );

} );

Deno.test( 'console: a refused clipboard read pastes nothing and throws nothing', async () => {

	reset();
	await withNavigator( { readText: () => Promise.reject( new DOMException( 'denied', 'NotAllowedError' ) ) }, async () => {

		withKey( K_CTRL, 118 );
		await tick();
		assertEqual( lineWithCursor(), '|', 'nothing pasted' );

	} );

	await withNavigator( { readText: () => { throw new Error( 'no' ); } }, async () => {

		withKey( K_CTRL, 118 );
		await tick();
		assertEqual( lineWithCursor(), '|', 'nothing pasted on a throw' );

	} );

	await withNavigator( undefined, async () => {

		withKey( K_CTRL, 118 );
		await tick();
		assertEqual( lineWithCursor(), '|', 'no clipboard API' );

	} );

} );

Deno.test( 'console: the browser paste event pastes, and Ctrl+V then skips readText', async () => {

	const listeners = {};
	const fakeDocument = { addEventListener: ( type, fn ) => { listeners[ type ] = fn; } };
	const hadDocument = 'document' in globalThis;
	const oldDocument = globalThis.document;
	globalThis.document = fakeDocument;

	function pasteEvent( text, target ) {

		let prevented = false;
		listeners.paste( {
			target: target,
			clipboardData: { getData: ( kind ) => kind === 'text/plain' ? text : '' },
			preventDefault: () => { prevented = true; },
		} );
		return prevented;

	}

	try {

		keys.Key_Init(); // installs the listener on this document
		reset();
		if ( typeof listeners.paste !== 'function' ) throw new Error( 'no paste listener' );

		// Cmd+V: in_web.js doesn't pass it on, only the paste event arrives
		assertEqual( pasteEvent( 'connect a', { tagName: 'CANVAS' } ), true, 'default prevented' );
		assertEqual( line(), 'connect a', 'pasted from the event' );

		// Ctrl+V: the key and then the event; readText isn't needed
		let reads = 0;
		await withNavigator( { readText: () => { reads ++; return Promise.resolve( 'WRONG' ); } }, async () => {

			withKey( K_CTRL, 118 );
			pasteEvent( 'b', { tagName: 'BODY' } );
			await tick();

		} );
		assertEqual( reads, 0, 'readText skipped' );
		assertEqual( line(), 'connect ab', 'pasted once' );

		// text fields and other key destinations are left alone
		assertEqual( pasteEvent( 'c', { tagName: 'INPUT' } ), false, 'input field' );
		keys.set_key_dest( keys.key_menu );
		assertEqual( pasteEvent( 'c', { tagName: 'BODY' } ), false, 'menu' );
		keys.set_key_dest( keys.key_console );
		assertEqual( line(), 'connect ab', 'unchanged' );

	} finally {

		if ( hadDocument ) globalThis.document = oldDocument;
		else delete globalThis.document;

	}

} );

// Tab completion

let completionSetup = false;
function setupCompletion() {

	if ( completionSetup ) return;
	completionSetup = true;

	for ( const name of [ 'map', 'changelevel', 'playdemo', 'zzcmd_alpha', 'zzcmd_beta' ] )
		cmd.Cmd_AddCommand( name, () => {} );
	cvar.Cvar_RegisterVariable( { name: 'zzcmd_gamma', string: '1', value: 1 } );
	const mode = { name: 'zzmode', string: 'a', value: 0 };
	cvar.Cvar_RegisterVariable( mode );
	cvar.Cvar_SetCompletion( mode, ( _var, partial ) => {

		for ( const v of [ 'linear', 'nearest', 'next' ] )
			con.Con_AddToTabList( v, partial, null );

	} );
	cmd.Cbuf_AddText( 'alias zzcmd_delta "echo hi"\n' );
	cmd.Cbuf_Execute();

	// a pack with two maps, an item model and a demo
	const files = [
		{ name: 'maps/zze1m1.bsp', filepos: 0, filelen: 40000 },
		{ name: 'maps/zze1m2.bsp', filepos: 0, filelen: 40000 },
		{ name: 'maps/zzb_bh10.bsp', filepos: 0, filelen: 2000 },
		{ name: 'maps/sub/zze1m9.bsp', filepos: 0, filelen: 40000 },
		{ name: 'zzdemo1.dem', filepos: 0, filelen: 100 },
	];
	COM_AddPack( { files: files, data: new ArrayBuffer( 0 ) } );

}

Deno.test( 'console: Tab lists commands, cvars and aliases and extends to the common prefix', () => {

	setupCompletion();
	reset();
	type( 'zzc' );
	press( K_TAB );
	assertEqual( lineWithCursor(), 'zzcmd_|', 'extended to the common prefix' );
	const listed = consoleText();
	for ( const expected of [ 'zzcmd_alpha (command)', 'zzcmd_beta (command)', 'zzcmd_gamma (cvar)', 'zzcmd_delta (alias)' ] )
		if ( ! listed.includes( '   ' + expected ) ) throw new Error( 'missing from the list: ' + expected + '\n' + listed );
	if ( listed.indexOf( 'zzcmd_alpha' ) > listed.indexOf( 'zzcmd_beta' ) ) throw new Error( 'list not sorted' );

	// further Tabs cycle, Shift+Tab goes back
	press( K_TAB );
	assertEqual( lineWithCursor(), 'zzcmd_alpha|', 'cycle 1' );
	press( K_TAB );
	assertEqual( lineWithCursor(), 'zzcmd_beta|', 'cycle 2' );
	withKey( K_SHIFT, K_TAB );
	assertEqual( lineWithCursor(), 'zzcmd_alpha|', 'shift+tab' );

	// a single match is completed with a space
	reset();
	type( 'zzcmd_g' );
	press( K_TAB );
	assertEqual( lineWithCursor(), 'zzcmd_gamma |', 'single match' );

	// matching ignores case
	reset();
	type( 'ZZCMD_B' );
	press( K_TAB );
	assertEqual( lineWithCursor(), 'zzcmd_beta |', 'case-insensitive' );

	// completes the word at the cursor, keeping the rest of the line
	reset();
	type( 'echo; zzcmd_g x' );
	press( K_LEFTARROW );
	press( K_LEFTARROW );
	press( K_TAB );
	assertEqual( lineWithCursor(), 'echo; zzcmd_gamma| x', 'mid-line' );

} );

Deno.test( 'console: Tab completes map, demo and key names, and cvar values', () => {

	setupCompletion();

	reset();
	type( 'map zze' );
	press( K_TAB );
	assertEqual( lineWithCursor(), 'map zze1m|', 'maps: common prefix, no item models or subdirectories' );
	press( K_TAB );
	assertEqual( lineWithCursor(), 'map zze1m1|', 'cycled' );

	reset();
	type( 'changelevel zze1m2' );
	press( K_TAB );
	assertEqual( lineWithCursor(), 'changelevel zze1m2 |', 'single map' );
	press( K_TAB );
	assertEqual( lineWithCursor(), 'changelevel zze1m2 |', 'no second argument' );

	reset();
	type( 'playdemo zzd' );
	press( K_TAB );
	assertEqual( lineWithCursor(), 'playdemo zzdemo1 |', 'demo' );

	reset();
	type( 'bind uparr' );
	press( K_TAB );
	assertEqual( lineWithCursor(), 'bind UPARROW |', 'key name' );

	reset();
	type( 'zzmode ne' );
	press( K_TAB );
	assertEqual( lineWithCursor(), 'zzmode ne|', 'cvar values: common prefix' );
	press( K_TAB );
	assertEqual( lineWithCursor(), 'zzmode nearest|', 'cvar values: cycled' );

	reset();
	type( 'zzcmd_gamma ' );
	press( K_TAB );
	assertEqual( lineWithCursor(), 'zzcmd_gamma |', 'cvar without completion' );

} );

Deno.test( 'console: drawing the input line leaves the line intact', () => {

	reset();
	type( 'abcdef' );
	press( K_LEFTARROW );
	press( K_LEFTARROW );
	const copy = keys.key_lines[ keys.edit_line ].slice();
	drawn.clear();
	con.Con_DrawConsole( 8 * 10, true );
	const inputRow = drawn.get( 8 * 10 - 16 );
	assertEqual( String.fromCharCode( ...inputRow.slice( 0, 7 ) ), ']abcdef', 'drawn' );
	for ( let i = 0; i < copy.length; i ++ )
		if ( keys.key_lines[ keys.edit_line ][ i ] !== copy[ i ] ) throw new Error( 'line changed at ' + i );
	assertEqual( lineWithCursor(), 'abcd|ef', 'cursor kept' );

} );
