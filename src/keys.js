// Ported from: WinQuake/keys.c, WinQuake/keys.h -- keyboard input handling

import { Cbuf_AddText } from './cmd.js';
import { Cmd_AddCommand, Cmd_Argc, Cmd_Argv } from './cmd.js';
import { Con_Printf, con_forcedup, Con_SetBackscroll, con_totallines, con_vislines,
	Con_Scroll, Con_TabComplete, Con_ResetTabComplete } from './console.js';
import { M_Keydown, M_ToggleMenu_f } from './menu.js';
import { SCR_UpdateScreen } from './gl_screen.js';
import { Sys_Error } from './sys.js';
import { Draw_GetVirtualWidth, Draw_GetVirtualHeight } from './gl_draw.js';

/*
==============================================================================

			KEY CONSTANTS

==============================================================================
*/

// these are the key numbers that should be passed to Key_Event
export const K_TAB = 9;
export const K_ENTER = 13;
export const K_ESCAPE = 27;
export const K_SPACE = 32;

// normal keys should be passed as lowercased ascii

export const K_BACKSPACE = 127;
export const K_UPARROW = 128;
export const K_DOWNARROW = 129;
export const K_LEFTARROW = 130;
export const K_RIGHTARROW = 131;

export const K_ALT = 132;
export const K_CTRL = 133;
export const K_SHIFT = 134;
export const K_F1 = 135;
export const K_F2 = 136;
export const K_F3 = 137;
export const K_F4 = 138;
export const K_F5 = 139;
export const K_F6 = 140;
export const K_F7 = 141;
export const K_F8 = 142;
export const K_F9 = 143;
export const K_F10 = 144;
export const K_F11 = 145;
export const K_F12 = 146;
export const K_INS = 147;
export const K_DEL = 148;
export const K_PGDN = 149;
export const K_PGUP = 150;
export const K_HOME = 151;
export const K_END = 152;

export const K_PAUSE = 255;

// mouse buttons generate virtual keys
export const K_MOUSE1 = 200;
export const K_MOUSE2 = 201;
export const K_MOUSE3 = 202;

// joystick buttons
export const K_JOY1 = 203;
export const K_JOY2 = 204;
export const K_JOY3 = 205;
export const K_JOY4 = 206;

// aux keys are for multi-buttoned joysticks
export const K_AUX1 = 207;
export const K_AUX2 = 208;
export const K_AUX3 = 209;
export const K_AUX4 = 210;
export const K_AUX5 = 211;
export const K_AUX6 = 212;
export const K_AUX7 = 213;
export const K_AUX8 = 214;
export const K_AUX9 = 215;
export const K_AUX10 = 216;
export const K_AUX11 = 217;
export const K_AUX12 = 218;
export const K_AUX13 = 219;
export const K_AUX14 = 220;
export const K_AUX15 = 221;
export const K_AUX16 = 222;
export const K_AUX17 = 223;
export const K_AUX18 = 224;
export const K_AUX19 = 225;
export const K_AUX20 = 226;
export const K_AUX21 = 227;
export const K_AUX22 = 228;
export const K_AUX23 = 229;
export const K_AUX24 = 230;
export const K_AUX25 = 231;
export const K_AUX26 = 232;
export const K_AUX27 = 233;
export const K_AUX28 = 234;
export const K_AUX29 = 235;
export const K_AUX30 = 236;
export const K_AUX31 = 237;
export const K_AUX32 = 238;

// JACK: Intellimouse(c) Mouse Wheel Support
export const K_MWHEELUP = 239;
export const K_MWHEELDOWN = 240;

/*
==============================================================================

			KEY DESTINATION MODES

==============================================================================
*/

export const key_game = 0;
export const key_console = 1;
export const key_message = 2;
export const key_menu = 3;

/*
==============================================================================

			KEY STATE

==============================================================================
*/

export const MAXCMDLINE = 256;
const CMDLINES = 32;

// key_lines[CMDLINES][MAXCMDLINE]
export const key_lines = [];
for ( let i = 0; i < CMDLINES; i ++ ) {

	key_lines[ i ] = new Array( MAXCMDLINE ).fill( 0 );

}

export let key_linepos = 1;
export let shift_down = false;
export let key_lastpress = 0;
export let key_insert = 1; // johnfitz -- insert key toggle (for editing)

export let edit_line = 0;
export let history_line = 0;

export let key_dest = key_game;
export function set_key_dest( v ) { key_dest = v; }
export function set_key_linepos( v ) { key_linepos = v; }
export function set_history_line( v ) { history_line = v; }

export let key_count = 0; // incremented every key event

// SCR_ModalMessage spins on Sys_SendKeyEvents with key_count = -1 until
// key_lastpress is 'y', 'n' or escape. A browser can't block, so the dialog
// registers a callback here and Key_Event finishes the loop for it.
let key_modal_callback = null;

export function Key_BeginModal( callback ) {

	key_modal_callback = callback;
	key_count = - 1; // wait for a key down and up

}

export function Key_ModalActive() {

	return key_modal_callback !== null;

}

export const keybindings = new Array( 256 ).fill( null );
const consolekeys = new Array( 256 ).fill( false );
const menubound = new Array( 256 ).fill( false );
const keyshift = new Array( 256 ).fill( 0 );
export const key_repeats = new Array( 256 ).fill( 0 );
const keydown = new Array( 256 ).fill( false );

/*
==============================================================================

			KEYNAME TABLE

==============================================================================
*/

const keynames = [
	{ name: 'TAB', keynum: K_TAB },
	{ name: 'ENTER', keynum: K_ENTER },
	{ name: 'ESCAPE', keynum: K_ESCAPE },
	{ name: 'SPACE', keynum: K_SPACE },
	{ name: 'BACKSPACE', keynum: K_BACKSPACE },
	{ name: 'UPARROW', keynum: K_UPARROW },
	{ name: 'DOWNARROW', keynum: K_DOWNARROW },
	{ name: 'LEFTARROW', keynum: K_LEFTARROW },
	{ name: 'RIGHTARROW', keynum: K_RIGHTARROW },

	{ name: 'ALT', keynum: K_ALT },
	{ name: 'CTRL', keynum: K_CTRL },
	{ name: 'SHIFT', keynum: K_SHIFT },

	{ name: 'F1', keynum: K_F1 },
	{ name: 'F2', keynum: K_F2 },
	{ name: 'F3', keynum: K_F3 },
	{ name: 'F4', keynum: K_F4 },
	{ name: 'F5', keynum: K_F5 },
	{ name: 'F6', keynum: K_F6 },
	{ name: 'F7', keynum: K_F7 },
	{ name: 'F8', keynum: K_F8 },
	{ name: 'F9', keynum: K_F9 },
	{ name: 'F10', keynum: K_F10 },
	{ name: 'F11', keynum: K_F11 },
	{ name: 'F12', keynum: K_F12 },

	{ name: 'INS', keynum: K_INS },
	{ name: 'DEL', keynum: K_DEL },
	{ name: 'PGDN', keynum: K_PGDN },
	{ name: 'PGUP', keynum: K_PGUP },
	{ name: 'HOME', keynum: K_HOME },
	{ name: 'END', keynum: K_END },

	{ name: 'MOUSE1', keynum: K_MOUSE1 },
	{ name: 'MOUSE2', keynum: K_MOUSE2 },
	{ name: 'MOUSE3', keynum: K_MOUSE3 },

	{ name: 'JOY1', keynum: K_JOY1 },
	{ name: 'JOY2', keynum: K_JOY2 },
	{ name: 'JOY3', keynum: K_JOY3 },
	{ name: 'JOY4', keynum: K_JOY4 },

	{ name: 'AUX1', keynum: K_AUX1 },
	{ name: 'AUX2', keynum: K_AUX2 },
	{ name: 'AUX3', keynum: K_AUX3 },
	{ name: 'AUX4', keynum: K_AUX4 },
	{ name: 'AUX5', keynum: K_AUX5 },
	{ name: 'AUX6', keynum: K_AUX6 },
	{ name: 'AUX7', keynum: K_AUX7 },
	{ name: 'AUX8', keynum: K_AUX8 },
	{ name: 'AUX9', keynum: K_AUX9 },
	{ name: 'AUX10', keynum: K_AUX10 },
	{ name: 'AUX11', keynum: K_AUX11 },
	{ name: 'AUX12', keynum: K_AUX12 },
	{ name: 'AUX13', keynum: K_AUX13 },
	{ name: 'AUX14', keynum: K_AUX14 },
	{ name: 'AUX15', keynum: K_AUX15 },
	{ name: 'AUX16', keynum: K_AUX16 },
	{ name: 'AUX17', keynum: K_AUX17 },
	{ name: 'AUX18', keynum: K_AUX18 },
	{ name: 'AUX19', keynum: K_AUX19 },
	{ name: 'AUX20', keynum: K_AUX20 },
	{ name: 'AUX21', keynum: K_AUX21 },
	{ name: 'AUX22', keynum: K_AUX22 },
	{ name: 'AUX23', keynum: K_AUX23 },
	{ name: 'AUX24', keynum: K_AUX24 },
	{ name: 'AUX25', keynum: K_AUX25 },
	{ name: 'AUX26', keynum: K_AUX26 },
	{ name: 'AUX27', keynum: K_AUX27 },
	{ name: 'AUX28', keynum: K_AUX28 },
	{ name: 'AUX29', keynum: K_AUX29 },
	{ name: 'AUX30', keynum: K_AUX30 },
	{ name: 'AUX31', keynum: K_AUX31 },
	{ name: 'AUX32', keynum: K_AUX32 },

	{ name: 'PAUSE', keynum: K_PAUSE },

	{ name: 'MWHEELUP', keynum: K_MWHEELUP },
	{ name: 'MWHEELDOWN', keynum: K_MWHEELDOWN },

	{ name: 'SEMICOLON', keynum: 59 }, // ';' - because a raw semicolon separates commands
];

/*
==============================================================================

			LINE TYPING INTO THE CONSOLE

==============================================================================
*/

// External references we need
// These are set by other modules to avoid circular imports
let _cls = { state: 0, demoplayback: false, signon: 0 };
let _realVid = { height: 480, width: 640 };
const _vid = {
	get width() { return Draw_GetVirtualWidth(); },
	get height() { return Draw_GetVirtualHeight(); }
};

export function Key_SetExternals( externals ) {

	if ( externals.cls ) _cls = externals.cls;
	if ( externals.vid ) _realVid = externals.vid;

}

// Chat buffer
export let chat_buffer = '';
export let team_message = false;
export function set_team_message( v ) { team_message = v; }

/*
==============================================================================

			CONSOLE LINE EDITING

QuakeSpasm/Ironwail additions, not in id's keys.c: a cursor within the line,
insert mode, word jumps, history that survives a reload, and clipboard paste.

==============================================================================
*/

// strlen() of a key_lines entry
function Key_LineLength( line ) {

	let len = 0;
	while ( len < MAXCMDLINE && line[ len ] !== 0 )
		len ++;
	return len;

}

// The characters of line from start up to its terminator
export function Key_LineString( line, start ) {

	let s = '';
	for ( let i = start; i < MAXCMDLINE && line[ i ] !== 0; i ++ )
		s += String.fromCharCode( line[ i ] );
	return s;

}

// strcpy() between key_lines entries; returns the length copied
function Key_CopyLine( dst, src ) {

	const len = Key_LineLength( src );
	for ( let i = 0; i < len; i ++ )
		dst[ i ] = src[ i ];
	if ( len < MAXCMDLINE )
		dst[ len ] = 0;
	return len;

}

function Key_LinesEqual( a, b ) {

	for ( let i = 0; i < MAXCMDLINE; i ++ ) {

		if ( a[ i ] !== b[ i ] ) return false;
		if ( a[ i ] === 0 ) return true;

	}

	return true;

}

// QuakeSpasm's static "current" in Key_Console: the line being typed before
// Up recalled history, restored by Down
const key_current = new Array( MAXCMDLINE ).fill( 0 );

/*
====================
Key_IsWordSeparator, Key_FindWordBoundary

QuakeSpasm: Ctrl+Left/Right and Ctrl+Backspace/Delete jump over words
====================
*/
function Key_IsWordSeparator( c ) {

	return c === 32 || c === 95 || c === 9 || c === 59; // ' ', '_', '\t', ';'

}

function Key_FindWordBoundary( dir ) {

	const workline = key_lines[ edit_line ];
	const len = Key_LineLength( workline );
	let pos = key_linepos;

	if ( dir < 0 ) {

		while ( pos > 1 && Key_IsWordSeparator( workline[ pos - 1 ] ) )
			pos --;
		while ( pos > 1 && ! Key_IsWordSeparator( workline[ pos - 1 ] ) )
			pos --;

	} else {

		while ( pos < len && ! Key_IsWordSeparator( workline[ pos ] ) )
			pos ++;
		while ( pos < len && Key_IsWordSeparator( workline[ pos ] ) )
			pos ++;

	}

	return pos;

}

/*
====================
History_Init, History_Save

QuakeSpasm keeps the command history in history.txt; the browser keeps it in
localStorage. QS writes the file at shutdown, which a page never gets
reliably, so it is saved after every command instead.
====================
*/
const HISTORY_STORAGE_KEY = 'quake_history';

// undefined means the default store
let key_history_storage = undefined;

// Tests pass a fake store; null turns persistence off, undefined restores the default
export function Key_SetHistoryStorage( storage ) {

	key_history_storage = storage;

}

function Key_GetHistoryStorage() {

	if ( key_history_storage !== undefined )
		return key_history_storage;

	// Deno has a localStorage too: the server and the tests must not keep a
	// history on disk
	if ( typeof Deno !== 'undefined' )
		return null;

	try {

		return typeof localStorage !== 'undefined' ? localStorage : null;

	} catch {

		return null; // storage blocked by the browser's privacy settings

	}

}

export function History_Init() {

	for ( let i = 0; i < CMDLINES; i ++ ) {

		key_lines[ i ][ 0 ] = 93; // ']'
		key_lines[ i ][ 1 ] = 0;

	}

	key_linepos = 1;
	edit_line = 0;
	history_line = 0;
	key_current[ 0 ] = 93;
	key_current[ 1 ] = 0;

	const storage = Key_GetHistoryStorage();
	if ( storage === null )
		return;

	let text = null;
	try {

		text = storage.getItem( HISTORY_STORAGE_KEY );

	} catch {

		return;

	}

	if ( typeof text !== 'string' )
		return;

	// one command per line; the last slot is left for the edit line
	const lines = text.split( /[\r\n]+/ );
	for ( let l = 0; l < lines.length && edit_line < CMDLINES - 1; l ++ ) {

		const src = lines[ l ];
		const line = key_lines[ edit_line ];
		let i = 1;
		for ( let j = 0; j < src.length && i < MAXCMDLINE - 1; j ++ ) {

			const c = src.charCodeAt( j );
			if ( c >= 32 && c <= 126 )
				line[ i ++ ] = c;

		}

		line[ i ] = 0;
		if ( i > 1 )
			edit_line ++;

	}

	history_line = edit_line;
	key_lines[ edit_line ][ 0 ] = 93; // ']'
	key_lines[ edit_line ][ 1 ] = 0;

}

// QuakeSpasm History_Shutdown. QS stops at the first empty line, which drops
// every command typed after an empty Enter; this skips empty lines instead.
function History_Save() {

	const storage = Key_GetHistoryStorage();
	if ( storage === null )
		return;

	let text = '';
	for ( let i = ( edit_line + 1 ) & ( CMDLINES - 1 ); i !== edit_line; i = ( i + 1 ) & ( CMDLINES - 1 ) ) {

		if ( key_lines[ i ][ 1 ] !== 0 )
			text += Key_LineString( key_lines[ i ], 1 ) + '\n';

	}

	try {

		storage.setItem( HISTORY_STORAGE_KEY, text );

	} catch {

		// storage full or blocked: the history just isn't kept

	}

}

/*
====================
PasteToConsole

QuakeSpasm: inserts text at the cursor, up to the first line break and cut to
the line length. Tabs become spaces, and characters the Quake charset has no
glyph for (other control characters, non-ASCII) are dropped, where QS copies
the clipboard bytes as they are.
====================
*/
export function PasteToConsole( text ) {

	if ( key_linepos === MAXCMDLINE - 1 )
		return;

	if ( typeof text !== 'string' )
		return;

	let cbd = '';
	for ( let i = 0; i < text.length; i ++ ) {

		const c = text.charCodeAt( i );
		if ( c === 10 || c === 13 || c === 8 ) // '\n', '\r', '\b'
			break;
		if ( c === 9 )
			cbd += ' ';
		else if ( c >= 32 && c <= 126 )
			cbd += text.charAt( i );

	}

	let inslen = cbd.length;
	if ( inslen + key_linepos > MAXCMDLINE - 1 )
		inslen = MAXCMDLINE - 1 - key_linepos;
	if ( inslen <= 0 )
		return;

	const workline = key_lines[ edit_line ];
	let mvlen = Key_LineLength( workline ) - key_linepos;
	if ( mvlen + inslen + key_linepos > MAXCMDLINE - 1 ) {

		mvlen = MAXCMDLINE - 1 - key_linepos - inslen;
		if ( mvlen < 0 ) mvlen = 0;

	}

	// insert the string
	if ( mvlen !== 0 )
		workline.copyWithin( key_linepos + inslen, key_linepos, key_linepos + mvlen );
	for ( let i = 0; i < inslen; i ++ )
		workline[ key_linepos + i ] = cbd.charCodeAt( i );
	workline[ key_linepos + inslen + mvlen ] = 0;
	key_linepos += inslen;

	Con_ResetTabComplete();

}

/*
Clipboard paste in the browser.

Ctrl+V and Shift+Ins reach Key_Console, but Cmd+V never does: in_web.js leaves
Cmd shortcuts to the browser. Both make the browser fire a paste event (the
console doesn't prevent the default action), and that event carries the text
without asking for permission, so it is the main route. It is listened for
from Key_Init, never at import time.

navigator.clipboard.readText() is the fallback for a Ctrl+V or Shift+Ins that
brings no paste event. It runs after the key event has finished, when the
paste event would already have arrived, and only if none did, because Firefox
and Safari show a "Paste" prompt for every readText(). A refused permission
or an empty clipboard is ignored.
*/
let key_paste_events = 0;
let key_paste_document = null;

function Key_ConsoleActive() {

	return key_dest === key_console || ( key_dest === key_game && con_forcedup );

}

function Key_PasteEvent( event ) {

	if ( ! Key_ConsoleActive() )
		return;

	// text fields (the touch keyboard's input) take their own pastes
	const target = event.target;
	if ( target !== null && target !== undefined &&
		( target.isContentEditable === true || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' ) )
		return;

	const data = event.clipboardData;
	if ( data === null || data === undefined )
		return;

	key_paste_events ++;
	event.preventDefault();
	PasteToConsole( data.getData( 'text/plain' ) );

}

function Key_InitPaste() {

	if ( typeof document === 'undefined' || document === null || typeof document.addEventListener !== 'function' )
		return;
	if ( key_paste_document === document )
		return;

	key_paste_document = document;
	document.addEventListener( 'paste', Key_PasteEvent );

}

function Key_PasteFromClipboard() {

	const events = key_paste_events;

	setTimeout( () => {

		if ( key_paste_events !== events )
			return; // the paste event brought it

		if ( typeof navigator === 'undefined' || navigator === null )
			return;
		const clipboard = navigator.clipboard;
		if ( clipboard === null || clipboard === undefined || typeof clipboard.readText !== 'function' )
			return;

		let request = null;
		try {

			request = clipboard.readText();

		} catch {

			return;

		}

		Promise.resolve( request ).then( ( text ) => {

			if ( key_paste_events !== events || ! Key_ConsoleActive() )
				return;
			PasteToConsole( text );

		}, () => {} ); // permission denied: paste nothing

	}, 0 );

}

/*
====================
Key_Console -- johnfitz -- heavy revision

Interactive line editing and console scrollback. Follows QuakeSpasm, which
moved Home/End to the cursor: Ctrl+Home/End now scroll the console to the
top and bottom, where vanilla used plain Home/End.
====================
*/
function Key_Console( key ) {

	const workline = key_lines[ edit_line ];
	const ctrl = keydown[ K_CTRL ];

	switch ( key ) {

		case K_ENTER: {

			Con_ResetTabComplete();
			Cbuf_AddText( Key_LineString( workline, 1 ) ); // skip the prompt
			Cbuf_AddText( '\n' );
			Con_Printf( Key_LineString( workline, 0 ) + '\n' );

			// If the last two lines are identical, skip storing this line in history
			// by not incrementing edit_line
			if ( ! Key_LinesEqual( workline, key_lines[ ( edit_line - 1 ) & ( CMDLINES - 1 ) ] ) )
				edit_line = ( edit_line + 1 ) & ( CMDLINES - 1 );

			history_line = edit_line;
			key_lines[ edit_line ][ 0 ] = 93; // ']'
			key_lines[ edit_line ][ 1 ] = 0; // johnfitz -- otherwise old history items show up in the new edit line
			key_linepos = 1;
			History_Save();

			// force an update, because the command may take some time
			if ( _cls.state === 0 ) // ca_disconnected
				SCR_UpdateScreen();
			return;

		}

		case K_TAB:
			Con_TabComplete();
			return;

		case K_BACKSPACE:
			Con_ResetTabComplete();
			if ( key_linepos > 1 ) {

				const numchars = ctrl ? key_linepos - Key_FindWordBoundary( - 1 ) : 1;
				const len = Key_LineLength( workline );
				workline.copyWithin( key_linepos - numchars, key_linepos, len + 1 );
				key_linepos -= numchars;

			}

			return;

		case K_DEL:
			Con_ResetTabComplete();
			if ( workline[ key_linepos ] !== 0 ) {

				const numchars = ctrl ? Key_FindWordBoundary( 1 ) - key_linepos : 1;
				const len = Key_LineLength( workline );
				workline.copyWithin( key_linepos, key_linepos + numchars, len + 1 );

			}

			return;

		case K_HOME:
			if ( ctrl )
				Con_SetBackscroll( Math.max( 0, con_totallines - ( _vid.height >> 3 ) - 1 ) );
			else
				key_linepos = 1;
			Con_ResetTabComplete();
			return;

		case K_END:
			if ( ctrl )
				Con_SetBackscroll( 0 );
			else
				key_linepos = Key_LineLength( workline );
			Con_ResetTabComplete();
			return;

		case K_PGUP:
		case K_MWHEELUP:
			Con_Scroll( ctrl ? ( con_vislines >> 3 ) - 4 : 2 );
			return;

		case K_PGDN:
		case K_MWHEELDOWN:
			Con_Scroll( ctrl ? - ( ( con_vislines >> 3 ) - 4 ) : - 2 );
			return;

		case K_LEFTARROW:
			if ( key_linepos > 1 ) {

				if ( ctrl )
					key_linepos = Key_FindWordBoundary( - 1 );
				else
					key_linepos --;
				Con_ResetTabComplete();

			}

			return;

		case K_RIGHTARROW: {

			const len = Key_LineLength( workline );
			if ( len === key_linepos ) {

				// at the end, take the next character of the previous command
				const prev = key_lines[ ( edit_line + ( CMDLINES - 1 ) ) & ( CMDLINES - 1 ) ];
				if ( Key_LineLength( prev ) <= key_linepos )
					return; // no character to get
				workline[ key_linepos ] = prev[ key_linepos ];
				workline[ key_linepos + 1 ] = 0;
				key_linepos ++;

			} else {

				if ( ctrl )
					key_linepos = Key_FindWordBoundary( 1 );
				else
					key_linepos ++;

			}

			Con_ResetTabComplete();
			return;

		}

		case K_UPARROW: {

			if ( history_line === edit_line )
				Key_CopyLine( key_current, workline );

			const history_line_last = history_line;
			do {

				history_line = ( history_line - 1 ) & ( CMDLINES - 1 );

			} while ( history_line !== edit_line && key_lines[ history_line ][ 1 ] === 0 );

			if ( history_line === edit_line ) {

				history_line = history_line_last;
				return;

			}

			Con_ResetTabComplete();
			key_linepos = Key_CopyLine( workline, key_lines[ history_line ] );
			return;

		}

		case K_DOWNARROW:
			if ( history_line === edit_line )
				return;

			Con_ResetTabComplete();

			do {

				history_line = ( history_line + 1 ) & ( CMDLINES - 1 );

			} while ( history_line !== edit_line && key_lines[ history_line ][ 1 ] === 0 );

			// vanilla only reset the prompt here and left the recalled
			// command in the buffer; QS brings back what was being typed
			if ( history_line === edit_line )
				key_linepos = Key_CopyLine( workline, key_current );
			else
				key_linepos = Key_CopyLine( workline, key_lines[ history_line ] );
			return;

		case K_INS:
			if ( keydown[ K_SHIFT ] ) // Shift+Ins paste
				Key_PasteFromClipboard();
			else if ( ! ctrl ) // Ctrl+Ins copies a mouse selection in Ironwail; there is none here
				key_insert ^= 1;
			Con_ResetTabComplete();
			return;

		case 118: // 'v'
		case 86: // 'V'
			if ( ctrl ) { // Ctrl+V paste

				Key_PasteFromClipboard();
				return;

			}

			break;

		case 99: // 'c'
		case 67: // 'C'
			if ( ctrl ) { // Ctrl+C: abort the line -- S.A

				Con_Printf( Key_LineString( workline, 0 ) + '\n' );
				workline[ 0 ] = 93; // ']'
				workline[ 1 ] = 0;
				key_linepos = 1;
				history_line = edit_line;
				Con_ResetTabComplete();
				return;

			}

			break;

	}

	// QuakeSpasm types from text input events, which Ctrl chords don't send
	if ( ctrl )
		return;

	if ( key < 32 || key > 126 )
		return; // non printable

	Char_Console( key );

}

/*
====================
Char_Console

QuakeSpasm: types a character at the cursor, pushing the rest of the line
right in insert mode or replacing the character under the cursor otherwise
====================
*/
function Char_Console( key ) {

	if ( key_linepos >= MAXCMDLINE - 1 )
		return;

	const workline = key_lines[ edit_line ];
	const endpos = workline[ key_linepos ] === 0;

	Con_ResetTabComplete(); // johnfitz

	if ( key_insert && ! endpos ) {

		// if inserting, move the text to the right
		workline[ MAXCMDLINE - 2 ] = 0;
		const len = Key_LineLength( workline );
		workline.copyWithin( key_linepos + 1, key_linepos, len + 1 );
		workline[ key_linepos ] = key;

	} else {

		workline[ key_linepos ] = key;
		// null terminate if at the end
		if ( endpos )
			workline[ key_linepos + 1 ] = 0;

	}

	key_linepos ++;

}

/*
====================
Key_Message
====================
*/
function Key_Message( key ) {

	if ( key === K_ENTER ) {

		if ( team_message )
			Cbuf_AddText( 'say_team "' );
		else
			Cbuf_AddText( 'say "' );

		Cbuf_AddText( chat_buffer );
		Cbuf_AddText( '"\n' );

		key_dest = key_game;
		chat_buffer = '';
		return;

	}

	if ( key === K_ESCAPE ) {

		key_dest = key_game;
		chat_buffer = '';
		return;

	}

	if ( key < 32 || key > 127 )
		return; // non printable

	if ( key === K_BACKSPACE ) {

		if ( chat_buffer.length ) {

			chat_buffer = chat_buffer.substring( 0, chat_buffer.length - 1 );

		}

		return;

	}

	if ( chat_buffer.length === 31 )
		return; // all full

	chat_buffer += String.fromCharCode( key );

}

/*
===================
Key_StringToKeynum

Returns a key number to be used to index keybindings[] by looking at
the given string. Single ascii characters return themselves, while
the K_* names are matched up.
===================
*/
export function Key_StringToKeynum( str ) {

	if ( ! str || str.length === 0 )
		return - 1;

	if ( str.length === 1 )
		return str.charCodeAt( 0 );

	for ( let i = 0; i < keynames.length; i ++ ) {

		if ( str.toLowerCase() === keynames[ i ].name.toLowerCase() )
			return keynames[ i ].keynum;

	}

	return - 1;

}

/*
===================
Key_KeynumToString

Returns a string (either a single ascii char, or a K_* name) for the
given keynum.
===================
*/
export function Key_KeynumToString( keynum ) {

	if ( keynum === - 1 )
		return '<KEY NOT FOUND>';

	if ( keynum > 32 && keynum < 127 )
		return String.fromCharCode( keynum );

	for ( let i = 0; i < keynames.length; i ++ ) {

		if ( keynum === keynames[ i ].keynum )
			return keynames[ i ].name;

	}

	return '<UNKNOWN KEYNUM>';

}

/*
===================
Key_SetBinding
===================
*/
export function Key_SetBinding( keynum, binding ) {

	if ( keynum === - 1 )
		return;

	keybindings[ keynum ] = binding;

}

/*
===================
Key_Unbind_f
===================
*/
function Key_Unbind_f() {

	if ( Cmd_Argc() !== 2 ) {

		Con_Printf( 'unbind <key> : remove commands from a key\n' );
		return;

	}

	const b = Key_StringToKeynum( Cmd_Argv( 1 ) );
	if ( b === - 1 ) {

		Con_Printf( '"' + Cmd_Argv( 1 ) + '" isn\'t a valid key\n' );
		return;

	}

	Key_SetBinding( b, '' );

}

function Key_Unbindall_f() {

	for ( let i = 0; i < 256; i ++ )
		if ( keybindings[ i ] )
			Key_SetBinding( i, '' );

}

/*
===================
Key_Bind_f
===================
*/
function Key_Bind_f() {

	const c = Cmd_Argc();

	if ( c !== 2 && c !== 3 ) {

		Con_Printf( 'bind <key> [command] : attach a command to a key\n' );
		return;

	}

	const b = Key_StringToKeynum( Cmd_Argv( 1 ) );
	if ( b === - 1 ) {

		Con_Printf( '"' + Cmd_Argv( 1 ) + '" isn\'t a valid key\n' );
		return;

	}

	if ( c === 2 ) {

		if ( keybindings[ b ] )
			Con_Printf( '"' + Cmd_Argv( 1 ) + '" = "' + keybindings[ b ] + '"\n' );
		else
			Con_Printf( '"' + Cmd_Argv( 1 ) + '" is not bound\n' );
		return;

	}

	// copy the rest of the command line
	let cmd = '';
	for ( let i = 2; i < c; i ++ ) {

		if ( i > 2 )
			cmd += ' ';
		cmd += Cmd_Argv( i );

	}

	Key_SetBinding( b, cmd );

}

/*
============
Key_WriteBindings

Writes lines containing "bind key value"
============
*/
export function Key_WriteBindings() {

	let result = '';
	for ( let i = 0; i < 256; i ++ ) {

		if ( keybindings[ i ] && keybindings[ i ].length > 0 ) {

			result += 'bind "' + Key_KeynumToString( i ) + '" "' + keybindings[ i ] + '"\n';

		}

	}

	return result;

}

/*
===================
Key_Init
===================
*/
export function Key_Init() {

	History_Init();
	Key_InitPaste();

	//
	// init ascii characters in console mode
	//
	for ( let i = 32; i < 128; i ++ )
		consolekeys[ i ] = true;

	consolekeys[ K_ENTER ] = true;
	consolekeys[ K_TAB ] = true;
	consolekeys[ K_LEFTARROW ] = true;
	consolekeys[ K_RIGHTARROW ] = true;
	consolekeys[ K_UPARROW ] = true;
	consolekeys[ K_DOWNARROW ] = true;
	consolekeys[ K_BACKSPACE ] = true;
	consolekeys[ K_CTRL ] = true; // QuakeSpasm: Ctrl, Ins, Del, Home and End edit the line
	consolekeys[ K_INS ] = true;
	consolekeys[ K_DEL ] = true;
	consolekeys[ K_HOME ] = true;
	consolekeys[ K_END ] = true;
	consolekeys[ K_PGUP ] = true;
	consolekeys[ K_PGDN ] = true;
	consolekeys[ K_SHIFT ] = true;
	consolekeys[ K_MWHEELUP ] = true;
	consolekeys[ K_MWHEELDOWN ] = true;
	consolekeys[ 96 ] = false; // '`'
	consolekeys[ 126 ] = false; // '~'

	for ( let i = 0; i < 256; i ++ )
		keyshift[ i ] = i;

	for ( let i = 97; i <= 122; i ++ ) // 'a' to 'z'
		keyshift[ i ] = i - 32; // to uppercase

	keyshift[ 49 ] = 33; // '1' -> '!'
	keyshift[ 50 ] = 64; // '2' -> '@'
	keyshift[ 51 ] = 35; // '3' -> '#'
	keyshift[ 52 ] = 36; // '4' -> '$'
	keyshift[ 53 ] = 37; // '5' -> '%'
	keyshift[ 54 ] = 94; // '6' -> '^'
	keyshift[ 55 ] = 38; // '7' -> '&'
	keyshift[ 56 ] = 42; // '8' -> '*'
	keyshift[ 57 ] = 40; // '9' -> '('
	keyshift[ 48 ] = 41; // '0' -> ')'
	keyshift[ 45 ] = 95; // '-' -> '_'
	keyshift[ 61 ] = 43; // '=' -> '+'
	keyshift[ 44 ] = 60; // ',' -> '<'
	keyshift[ 46 ] = 62; // '.' -> '>'
	keyshift[ 47 ] = 63; // '/' -> '?'
	keyshift[ 59 ] = 58; // ';' -> ':'
	keyshift[ 39 ] = 34; // '\'' -> '"'
	keyshift[ 91 ] = 123; // '[' -> '{'
	keyshift[ 93 ] = 125; // ']' -> '}'
	keyshift[ 96 ] = 126; // '`' -> '~'
	keyshift[ 92 ] = 124; // '\\' -> '|'

	menubound[ K_ESCAPE ] = true;
	for ( let i = 0; i < 12; i ++ )
		menubound[ K_F1 + i ] = true;

	//
	// register our functions
	//
	Cmd_AddCommand( 'bind', Key_Bind_f );
	Cmd_AddCommand( 'unbind', Key_Unbind_f );
	Cmd_AddCommand( 'unbindall', Key_Unbindall_f );

}

/*
===================
Key_Event

Called by the system between frames for both key up and key down events
Should NOT be called during an interrupt!
===================
*/
export function Key_Event( key, down ) {

	keydown[ key ] = down;

	if ( ! down )
		key_repeats[ key ] = 0;

	key_lastpress = key;
	key_count ++;

	if ( key_count <= 0 ) {

		// SCR_ModalMessage's wait loop
		if ( key_modal_callback !== null ) {

			if ( key_lastpress === 121 || key_lastpress === 110 || key_lastpress === K_ESCAPE ) { // 'y', 'n'

				const callback = key_modal_callback;
				key_modal_callback = null;
				callback( key_lastpress === 121 );

			} else {

				key_count = - 1;

			}

		}

		return; // just catching keys for Con_NotifyBox

	}

	// update auto-repeat status
	if ( down ) {

		key_repeats[ key ] ++;
		if ( key !== K_BACKSPACE && key !== K_PAUSE && key_repeats[ key ] > 1 ) {

			// QuakeSpasm lets keys repeat outside the game; here only the
			// console's own keys do, so held arrows and Delete repeat
			if ( ! ( consolekeys[ key ] && Key_ConsoleActive() ) )
				return; // ignore most autorepeats

		}

		if ( key >= 200 && ! keybindings[ key ] )
			Con_Printf( Key_KeynumToString( key ) + ' is unbound, hit F4 to set.\n' );

	}

	if ( key === K_SHIFT )
		shift_down = down;

	//
	// handle escape specially, so the user can never unbind it
	//
	if ( key === K_ESCAPE ) {

		if ( ! down )
			return;

		switch ( key_dest ) {

			case key_message:
				Key_Message( key );
				break;
			case key_menu:
				M_Keydown( key );
				break;
			case key_game:
			case key_console:
				M_ToggleMenu_f();
				break;
			default:
				Sys_Error( 'Bad key_dest' );

		}

		return;

	}

	//
	// key up events only generate commands if the game key binding is
	// a button command (leading + sign). These will occur even in console mode,
	// to keep the character from continuing an action started before a console
	// switch. Button commands include the keynum as a parameter, so multiple
	// downs can be matched with ups
	//
	if ( ! down ) {

		const kb = keybindings[ key ];
		if ( kb && kb.charAt( 0 ) === '+' ) {

			Cbuf_AddText( '-' + kb.substring( 1 ) + ' ' + key + '\n' );

		}

		if ( keyshift[ key ] !== key ) {

			const kb2 = keybindings[ keyshift[ key ] ];
			if ( kb2 && kb2.charAt( 0 ) === '+' ) {

				Cbuf_AddText( '-' + kb2.substring( 1 ) + ' ' + key + '\n' );

			}

		}

		return;

	}

	//
	// during demo playback, most keys bring up the main menu
	//
	if ( _cls.demoplayback && down && consolekeys[ key ] && key_dest === key_game ) {

		M_ToggleMenu_f();
		return;

	}

	//
	// if not a consolekey, send to the interpreter no matter what mode is
	//
	if ( ( key_dest === key_menu && menubound[ key ] )
	|| ( key_dest === key_console && ! consolekeys[ key ] )
	|| ( key_dest === key_game && ( ! con_forcedup || ! consolekeys[ key ] ) ) ) {

		const kb = keybindings[ key ];
		if ( kb ) {

			if ( kb.charAt( 0 ) === '+' ) {

				// button commands add keynum as a parm
				Cbuf_AddText( kb + ' ' + key + '\n' );

			} else {

				Cbuf_AddText( kb );
				Cbuf_AddText( '\n' );

			}

		}

		return;

	}

	if ( ! down )
		return; // other systems only care about key down events

	if ( shift_down ) {

		key = keyshift[ key ];

	}

	switch ( key_dest ) {

		case key_message:
			Key_Message( key );
			break;
		case key_menu:
			M_Keydown( key );
			break;
		case key_game:
		case key_console:
			Key_Console( key );
			break;
		default:
			Sys_Error( 'Bad key_dest' );

	}

}

/*
===================
Key_ClearStates
===================
*/
export function Key_ClearStates() {

	for ( let i = 0; i < 256; i ++ ) {

		keydown[ i ] = false;
		key_repeats[ i ] = 0;

	}

}
