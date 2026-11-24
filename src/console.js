// Ported from: WinQuake/console.c, WinQuake/console.h -- developer console

import { Cmd_AddCommand, Cmd_TokenizeString, Cmd_Argc, Cmd_Argv, cmd_functions, cmd_alias } from './cmd.js';
import { Cvar_RegisterVariable, Cvar_FindVar, cvar_vars } from './cvar.js';
import { key_dest, set_key_dest, key_game, key_console, key_message,
	key_lines, edit_line, key_linepos, set_key_linepos, chat_buffer,
	set_team_message, MAXCMDLINE, key_insert, shift_down, set_history_line,
	keybindings, Key_KeynumToString, Key_LineString } from './keys.js';
import { COM_ListFiles } from './pak.js';
import { Draw_GetVirtualWidth, Draw_GetVirtualHeight } from './gl_draw.js';

/*
==============================================================================

			CONSOLE CONSTANTS

==============================================================================
*/

const CON_TEXTSIZE = 16384;
const NUM_CON_TIMES = 4;

/*
==============================================================================

			CONSOLE STATE

==============================================================================
*/

export let con_linewidth = 0;

const con_cursorspeed = 4;

export let con_forcedup = false; // because no entities to refresh

export let con_totallines = 0; // total lines in console scrollback
export let con_backscroll = 0; // lines up from bottom to display
let con_current = 0; // where next message will be printed
let con_x = 0; // offset in current line for next print
let con_text = null;

const con_notifytime = { name: 'con_notifytime', string: '3', value: 3 }; // seconds

const con_times = new Float32Array( NUM_CON_TIMES ); // realtime time the line was generated

export let con_vislines = 0;

export let con_initialized = false;

export let con_notifylines = 0; // scan lines to clear for notify lines

// Cross-reference to other systems (set via Con_SetExternals to avoid circular imports)
let _cls = { state: 0, signon: 0 };
let _realVid = { width: 640, height: 480 };
const _vid = {
	get width() { return Draw_GetVirtualWidth(); },
	get height() { return Draw_GetVirtualHeight(); }
};
let _getRealtime = () => 0;
let _scr_disabled_for_loading = false;
let _developer = { value: 0 };
let _Draw_Character = null;
let _Draw_String = null;
let _Draw_ConsoleBackground = null;
let _SCR_UpdateScreen = null;
let _SCR_EndLoadingPlaque = null;
let _M_Menu_Main_f = null;
let _S_LocalSound = null;

// Static variable for Con_Print
let cr = false;

export function Con_SetExternals( externals ) {

	if ( externals.cls ) _cls = externals.cls;
	if ( externals.vid ) _realVid = externals.vid;
	if ( externals.getRealtime ) _getRealtime = externals.getRealtime;
	if ( externals.developer ) _developer = externals.developer;
	if ( externals.Draw_Character ) _Draw_Character = externals.Draw_Character;
	if ( externals.Draw_String ) _Draw_String = externals.Draw_String;
	if ( externals.Draw_ConsoleBackground ) _Draw_ConsoleBackground = externals.Draw_ConsoleBackground;
	if ( externals.SCR_UpdateScreen ) _SCR_UpdateScreen = externals.SCR_UpdateScreen;
	if ( externals.SCR_EndLoadingPlaque ) _SCR_EndLoadingPlaque = externals.SCR_EndLoadingPlaque;
	if ( externals.M_Menu_Main_f ) _M_Menu_Main_f = externals.M_Menu_Main_f;
	if ( externals.S_LocalSound ) _S_LocalSound = externals.S_LocalSound;
	if ( externals.scr_disabled_for_loading !== undefined ) _scr_disabled_for_loading = externals.scr_disabled_for_loading;

}

// Accessor functions for mutable exports
export function Con_SetBackscroll( val ) { con_backscroll = val; }
export function Con_GetBackscroll() { return con_backscroll; }
export function Con_SetForcedup( val ) { con_forcedup = val; }

/*
================
Con_ToggleConsole_f
================
*/
export function Con_ToggleConsole_f() {

	if ( key_dest === key_console ) {

		if ( _cls.state === 2 ) { // ca_connected

			set_key_dest( key_game );

			key_lines[ edit_line ][ 1 ] = 0; // clear any typing
			set_key_linepos( 1 );
			set_history_line( edit_line ); // johnfitz -- it should also return you to the bottom of the command history
			Con_ResetTabComplete();

		} else {

			if ( _M_Menu_Main_f ) _M_Menu_Main_f();

		}

	} else {

		set_key_dest( key_console );

	}

	if ( _SCR_EndLoadingPlaque ) _SCR_EndLoadingPlaque();
	con_times.fill( 0 );

}

/*
================
Con_Clear_f
================
*/
export function Con_Clear_f() {

	if ( con_text ) {

		for ( let i = 0; i < CON_TEXTSIZE; i ++ )
			con_text[ i ] = 32; // ' '

	}

}

/*
================
Con_ClearNotify
================
*/
export function Con_ClearNotify() {

	for ( let i = 0; i < NUM_CON_TIMES; i ++ )
		con_times[ i ] = 0;

}

/*
================
Con_MessageMode_f
================
*/
export function Con_MessageMode_f() {

	set_key_dest( key_message );
	set_team_message( false );

}

/*
================
Con_MessageMode2_f
================
*/
export function Con_MessageMode2_f() {

	set_key_dest( key_message );
	set_team_message( true );

}

/*
================
Con_CheckResize

If the line width has changed, reformat the buffer.
================
*/
export function Con_CheckResize() {

	let width = ( _vid.width >> 3 ) - 2;

	if ( width === con_linewidth )
		return;

	if ( width < 1 ) {

		// video hasn't been initialized yet
		width = 38;
		con_linewidth = width;
		con_totallines = Math.floor( CON_TEXTSIZE / con_linewidth );

		if ( con_text ) {

			for ( let i = 0; i < CON_TEXTSIZE; i ++ )
				con_text[ i ] = 32; // ' '

		}

	} else {

		const oldwidth = con_linewidth;
		con_linewidth = width;
		const oldtotallines = con_totallines;
		con_totallines = Math.floor( CON_TEXTSIZE / con_linewidth );
		let numlines = oldtotallines;

		if ( con_totallines < numlines )
			numlines = con_totallines;

		let numchars = oldwidth;

		if ( con_linewidth < numchars )
			numchars = con_linewidth;

		const tbuf = new Array( CON_TEXTSIZE );
		for ( let i = 0; i < CON_TEXTSIZE; i ++ )
			tbuf[ i ] = con_text[ i ];

		for ( let i = 0; i < CON_TEXTSIZE; i ++ )
			con_text[ i ] = 32; // ' '

		for ( let i = 0; i < numlines; i ++ ) {

			for ( let j = 0; j < numchars; j ++ ) {

				con_text[ ( con_totallines - 1 - i ) * con_linewidth + j ] =
						tbuf[ ( ( con_current - i + oldtotallines ) %
							  oldtotallines ) * oldwidth + j ];

			}

		}

		Con_ClearNotify();

	}

	con_backscroll = 0;
	con_current = con_totallines - 1;

}

/*
================
Con_Init
================
*/
export function Con_Init() {

	con_text = new Array( CON_TEXTSIZE );
	for ( let i = 0; i < CON_TEXTSIZE; i ++ )
		con_text[ i ] = 32; // ' '

	con_linewidth = - 1;
	Con_CheckResize();

	Con_Printf( 'Console initialized.\n' );

	//
	// register our commands
	//
	Cvar_RegisterVariable( con_notifytime );

	Cmd_AddCommand( 'toggleconsole', Con_ToggleConsole_f );
	Cmd_AddCommand( 'messagemode', Con_MessageMode_f );
	Cmd_AddCommand( 'messagemode2', Con_MessageMode2_f );
	Cmd_AddCommand( 'clear', Con_Clear_f );
	con_initialized = true;

}

/*
===============
Con_Linefeed
===============
*/
function Con_Linefeed() {

	con_x = 0;
	con_current ++;

	const start = ( con_current % con_totallines ) * con_linewidth;
	for ( let i = 0; i < con_linewidth; i ++ )
		con_text[ start + i ] = 32; // ' '

}

/*
================
Con_Print

Handles cursor positioning, line wrapping, etc
All console printing must go through this in order to be logged to disk
If no console is visible, the notify window will pop up.
================
*/
export function Con_Print( txt ) {

	con_backscroll = 0;

	let pos = 0;
	let mask = 0;

	if ( txt.charCodeAt( 0 ) === 1 ) {

		mask = 128; // go to colored text
		// play talk wav
		if ( _S_LocalSound ) _S_LocalSound( 'misc/talk.wav' );
		pos ++;

	} else if ( txt.charCodeAt( 0 ) === 2 ) {

		mask = 128; // go to colored text
		pos ++;

	}

	while ( pos < txt.length ) {

		const c = txt.charCodeAt( pos );

		// count word length
		let l;
		for ( l = 0; l < con_linewidth; l ++ ) {

			if ( pos + l >= txt.length || txt.charCodeAt( pos + l ) <= 32 )
				break;

		}

		// word wrap
		if ( l !== con_linewidth && ( con_x + l > con_linewidth ) )
			con_x = 0;

		pos ++;

		if ( cr ) {

			con_current --;
			cr = false;

		}

		if ( con_x === 0 ) {

			Con_Linefeed();
			// mark time for transparent overlay
			if ( con_current >= 0 ) {
				const rt = _getRealtime();
				con_times[ con_current % NUM_CON_TIMES ] = rt;
			}

		}

		if ( c === 10 ) { // '\n'

			// Also set timestamp when newline is processed (ensures notify works even with unusual message flow)
			if ( con_current >= 0 ) {
				const rt = _getRealtime();
				if ( rt > 0 ) {
					con_times[ con_current % NUM_CON_TIMES ] = rt;
				}
			}
			con_x = 0;

		} else if ( c === 13 ) { // '\r'

			con_x = 0;
			cr = true;

		} else {

			// display character and advance
			const y = con_current % con_totallines;
			con_text[ y * con_linewidth + con_x ] = c | mask;
			con_x ++;
			if ( con_x >= con_linewidth )
				con_x = 0;

		}

	}

}

/*
================
Con_Printf

Handles cursor positioning, line wrapping, etc
================
*/
let inupdate = false;

export function Con_Printf( ...args ) {

	// Format the message - simple concatenation since JS doesn't have vsprintf
	let msg = '';
	if ( args.length === 1 ) {

		msg = String( args[ 0 ] );

	} else {

		// Simple printf-style formatting
		msg = _sprintf( args[ 0 ], ...args.slice( 1 ) );

	}

	if ( ! con_initialized )
		return;

	// write it to the scrollable buffer
	Con_Print( msg );

	// update the screen if the console is displayed
	if ( _cls.signon !== 4 && ! _scr_disabled_for_loading ) { // SIGNONS = 4

		// protect against infinite loop if something in SCR_UpdateScreen calls Con_Printf
		if ( ! inupdate ) {

			inupdate = true;
			if ( _SCR_UpdateScreen ) _SCR_UpdateScreen();
			inupdate = false;

		}

	}

}

/*
================
Con_DPrintf

A Con_Printf that only shows up if the "developer" cvar is set
================
*/
export function Con_DPrintf( ...args ) {

	if ( ! _developer.value )
		return; // don't confuse non-developers with techie stuff...

	Con_Printf( ...args );

}

/*
==================
Con_SafePrintf

Okay to call even when the screen can't be updated
==================
*/
export function Con_SafePrintf( ...args ) {

	const temp = _scr_disabled_for_loading;
	_scr_disabled_for_loading = true;
	Con_Printf( ...args );
	_scr_disabled_for_loading = temp;

}

/*
==============================================================================

TAB COMPLETION

johnfitz/QuakeSpasm, with Ironwail's argument completion. Not in id's
console.c, whose Tab only completed a command or cvar name. Names match by
prefix, ignoring case (QS compares case, Ironwail ignores it and matches
anywhere in the name).

==============================================================================
*/

let key_tabpartial = ''; // the word being cycled through; empty on the first Tab
let tab_start = 0; // QS's static c: where that word starts in the edit line
let tab_argc = 0; // arguments up to the cursor, counting an empty one after a space

// tablist is kept sorted by name
const tablist = [];

// bash_partial is the string that can be expanded,
// aka Linux Bash shell. -- S.A.
let bash_partial = '';
let bash_singlematch = true;

export function Con_ResetTabComplete() {

	key_tabpartial = '';

}

function Con_Match( str, partial ) {

	return str.length >= partial.length &&
		str.substring( 0, partial.length ).toLowerCase() === partial.toLowerCase();

}

/*
============
Con_AddToTabList -- johnfitz

Adds name to the matches if it starts with partial. type is shown after it in
the list ('cvar', 'command', a key's binding), or null for none.
============
*/
export function Con_AddToTabList( name, partial, type ) {

	if ( ! Con_Match( name, partial ) )
		return;

	let insert = 0;
	for ( ; insert < tablist.length; insert ++ ) {

		if ( tablist[ insert ].name === name )
			return; // avoid duplicates (Ironwail)
		if ( name < tablist[ insert ].name )
			break;

	}

	if ( tablist.length === 0 ) {

		bash_partial = name;

	} else {

		bash_singlematch = false;
		// find max common between bash_partial and name
		let n = 0;
		while ( n < bash_partial.length && n < name.length &&
			bash_partial.charAt( n ).toLowerCase() === name.charAt( n ).toLowerCase() )
			n ++;
		bash_partial = bash_partial.substring( 0, n );

	}

	tablist.splice( insert, 0, { name: name, type: type } );

}

/*
============
ParseCommand -- Ironwail

Tokenizes the command the cursor is in, from the last ';' or quote, so the
argument completions below know which command and argument they are in
============
*/
function ParseCommand() {

	const str = Key_LineString( key_lines[ edit_line ], 1 ).substring( 0, key_linepos - 1 );
	let ret = 0;
	let quote = - 1;

	for ( let i = 0; i < str.length; i ++ ) {

		const c = str.charAt( i );
		if ( c === '"' ) {

			if ( quote === - 1 ) {

				quote = ret; // save previous command boundary
				ret = i + 1; // new command

			} else {

				ret = quote; // restore saved cursor
				quote = - 1;

			}

		} else if ( c === ';' ) {

			ret = i + 1;

		} else if ( quote === - 1 && c === '/' && str.charAt( i + 1 ) === '/' ) {

			break;

		}

	}

	while ( str.charAt( ret ) === ' ' )
		ret ++;

	const buf = str.substring( ret );
	Cmd_TokenizeString( buf );
	tab_argc = Cmd_Argc();
	// last arg should always be the one we're trying to complete,
	// so we add a new empty one if the command ends with a space
	if ( buf.length > 0 && buf.charAt( buf.length - 1 ) === ' ' )
		tab_argc ++;

}

function CompleteFileList( partial, dir, ext, minsize ) {

	const names = COM_ListFiles( dir, ext, minsize );
	for ( let i = 0; i < names.length; i ++ )
		Con_AddToTabList( names[ i ], partial, null );

}

// maps over 32k, so not the b_*.bsp item models (Ironwail ExtraMaps_Init)
function CompleteMaps( partial ) {

	if ( tab_argc < 3 )
		CompleteFileList( partial, 'maps', 'bsp', 32 * 1024 );
	return true;

}

function CompleteDemos( partial ) {

	if ( tab_argc < 3 )
		CompleteFileList( partial, '', 'dem', 0 );
	return true;

}

function CompleteBindKeys( partial ) {

	// fall back to default tab completion after 1st arg (key name)
	if ( tab_argc > 2 )
		return false;

	for ( let i = 0; i < 256; i ++ ) {

		const name = Key_KeynumToString( i );
		if ( name !== '<UNKNOWN KEYNUM>' )
			Con_AddToTabList( name, partial, keybindings[ i ] ? keybindings[ i ] : null );

	}

	return true;

}

function CompleteUnbindKeys( partial ) {

	// disable completion after 1st arg (key name)
	if ( tab_argc > 2 )
		return true;

	for ( let i = 0; i < 256; i ++ ) {

		if ( keybindings[ i ] ) {

			const name = Key_KeynumToString( i );
			if ( name !== '<UNKNOWN KEYNUM>' )
				Con_AddToTabList( name, partial, keybindings[ i ] );

		}

	}

	return true;

}

// Ironwail's table, less game (no mod list here), load and save (the saves
// are in localStorage) and sky
const arg_completion_types = [
	{ command: 'map', fn: CompleteMaps },
	{ command: 'changelevel', fn: CompleteMaps },
	{ command: 'record', fn: CompleteDemos },
	{ command: 'playdemo', fn: CompleteDemos },
	{ command: 'timedemo', fn: CompleteDemos },
	{ command: 'bind', fn: CompleteBindKeys },
	{ command: 'unbind', fn: CompleteUnbindKeys },
];

/*
============
BuildTabList -- johnfitz
============
*/
function BuildTabList( partial ) {

	tablist.length = 0;
	bash_partial = '';
	bash_singlematch = true;

	ParseCommand();

	if ( tab_argc >= 2 ) {

		const name = Cmd_Argv( 0 );
		const cvar = Cvar_FindVar( name );
		if ( cvar !== null ) {

			// cvars can only have one argument
			if ( tab_argc === 2 && typeof cvar.completion === 'function' )
				cvar.completion( cvar, partial );
			return;

		}

		for ( let i = 0; i < arg_completion_types.length; i ++ ) {

			// arg_completion contains a command we can complete the arguments
			// for (like "map") and a list of all the maps.
			if ( name.toLowerCase() === arg_completion_types[ i ].command ) {

				if ( arg_completion_types[ i ].fn( partial ) )
					return;
				break;

			}

		}

	}

	if ( partial.length === 0 )
		return;

	for ( let cvar = cvar_vars; cvar !== null; cvar = cvar.next )
		Con_AddToTabList( cvar.name, partial, 'cvar' );

	for ( let cmd = cmd_functions; cmd !== null; cmd = cmd.next )
		Con_AddToTabList( cmd.name, partial, 'command' );

	for ( let alias = cmd_alias; alias !== null; alias = alias.next )
		Con_AddToTabList( alias.name, partial, 'alias' );

}

function Con_PrintTabList() {

	Con_SafePrintf( '\n' );
	for ( let i = 0; i < tablist.length; i ++ ) {

		const t = tablist[ i ];
		Con_SafePrintf( '   ' + t.name + ( t.type !== null ? ' (' + t.type + ')' : '' ) + '\n' );

	}

	Con_SafePrintf( '\n' );

}

/*
============
Con_TabComplete -- johnfitz

The first Tab lists every match and extends the word to their longest common
prefix; further Tabs cycle through the matches (Shift+Tab backwards).
============
*/
export function Con_TabComplete() {

	const line = key_lines[ edit_line ];

	// if editline is empty, return
	if ( line[ 1 ] === 0 )
		return;

	// get partial string (space -> cursor)
	if ( key_tabpartial.length === 0 || tab_start > key_linepos ) {

		// first time through, find new insert point. (Otherwise, use previous.)
		// work back from cursor until you find a space, quote, semicolon, or prompt
		let c = key_linepos - 1;
		while ( c > 0 && line[ c ] !== 32 && line[ c ] !== 34 && line[ c ] !== 59 )
			c --;
		tab_start = c + 1;

	}

	let partial = '';
	for ( let i = tab_start; i < key_linepos; i ++ )
		partial += String.fromCharCode( line[ i ] );

	// trim trailing space becuase it screws up string comparisons
	if ( partial.length > 0 && partial.charAt( partial.length - 1 ) === ' ' )
		partial = partial.substring( 0, partial.length - 1 );

	// find a match
	let match;
	if ( key_tabpartial.length === 0 ) {

		// first time through
		key_tabpartial = partial;
		BuildTabList( key_tabpartial );

		if ( tablist.length === 0 )
			return;

		// print list if length > 1
		if ( tablist.length > 1 )
			Con_PrintTabList();

		// First time, just show maximum matching chars -- S.A.
		match = bash_singlematch ? tablist[ 0 ].name : bash_partial;

	} else {

		BuildTabList( key_tabpartial );

		if ( tablist.length === 0 )
			return;

		// find current match -- can't save a pointer because the list will be rebuilt each time
		const n = tablist.length;
		match = shift_down ? tablist[ n - 1 ].name : tablist[ 0 ].name;
		for ( let i = 0; i < n; i ++ ) {

			if ( tablist[ i ].name.toLowerCase() === partial.toLowerCase() ) {

				match = shift_down ? tablist[ ( i + n - 1 ) % n ].name : tablist[ ( i + 1 ) % n ].name;
				break;

			}

		}

	}

	// insert new match into edit line, then the chars after the cursor
	const rest = match + Key_LineString( line, key_linepos );
	let end = tab_start;
	for ( let i = 0; i < rest.length && end < MAXCMDLINE - 1; i ++ )
		line[ end ++ ] = rest.charCodeAt( i );
	line[ end ] = 0;

	let linepos = Math.min( tab_start + match.length, end ); // set new cursor position

	// if cursor is at end of string, let's append a space to make life easier
	if ( linepos < MAXCMDLINE - 1 && line[ linepos ] === 0 && bash_singlematch ) {

		line[ linepos ] = 32; // ' '
		linepos ++;
		line[ linepos ] = 0;
		key_tabpartial = ''; // restart cycle (Ironwail)
		tab_start = linepos;

	}

	set_key_linepos( linepos );

}

/*
==============================================================================

DRAWING

==============================================================================
*/

/*
================
Con_DrawInput

The input line scrolls horizontally if typing goes beyond the right edge.
QuakeSpasm draws the text and then the cursor over it, so the cursor can sit
inside the line; id's version wrote the cursor into key_lines. At the end of
the line in insert mode the cursor blinks as in id's; elsewhere it is drawn
over the character on alternate frames, a block in insert mode and an
underscore in overwrite mode (QS has pictures for these).
================
*/
function Con_DrawInput() {

	if ( key_dest !== key_console && ! con_forcedup )
		return; // don't draw anything

	if ( ! _Draw_Character ) return;

	const text = key_lines[ edit_line ];
	const y = con_vislines - 16;

	// prestep if horizontally scrolling
	let ofs = 0;
	if ( key_linepos >= con_linewidth )
		ofs = 1 + key_linepos - con_linewidth;

	// draw input string
	for ( let i = 0; i < con_linewidth && ofs + i < MAXCMDLINE && text[ ofs + i ] !== 0; i ++ )
		_Draw_Character( ( i + 1 ) << 3, y, text[ ofs + i ] );

	// draw the cursor
	const blink = Math.floor( _getRealtime() * con_cursorspeed ) & 1;
	const x = ( key_linepos - ofs + 1 ) << 3;
	if ( key_insert && text[ key_linepos ] === 0 )
		_Draw_Character( x, y, 10 + blink );
	else if ( blink !== 0 )
		_Draw_Character( x, y, key_insert ? 11 : 95 ); // '_'

}

/*
================
Con_Scroll

QuakeSpasm: scrolls the console back (lines > 0) or forward
================
*/
export function Con_Scroll( lines ) {

	let bs = con_backscroll + lines;
	const maxscroll = con_totallines - ( _vid.height >> 3 ) - 1;
	if ( bs > maxscroll )
		bs = maxscroll;
	if ( bs < 0 )
		bs = 0;
	con_backscroll = bs;

}

/*
================
Con_DrawNotify

Draws the last few lines of output transparently over the game top
================
*/
export function Con_DrawNotify() {

	if ( ! _Draw_Character ) return;

	let v = 0;
	const realtime = _getRealtime();

	for ( let i = con_current - NUM_CON_TIMES + 1; i <= con_current; i ++ ) {

		if ( i < 0 )
			continue;

		const time = con_times[ i % NUM_CON_TIMES ];
		if ( time === 0 )
			continue;

		const age = realtime - time;
		if ( age > con_notifytime.value )
			continue;

		const textStart = ( i % con_totallines ) * con_linewidth;

		for ( let x = 0; x < con_linewidth; x ++ )
			_Draw_Character( ( x + 1 ) << 3, v, con_text[ textStart + x ] );

		v += 8;

	}

	if ( key_dest === key_message ) {

		if ( _Draw_String ) _Draw_String( 8, v, 'say:' );

		if ( _Draw_Character ) {

			let x = 0;
			for ( ; x < chat_buffer.length; x ++ ) {

				_Draw_Character( ( x + 5 ) << 3, v, chat_buffer.charCodeAt( x ) );

			}

			_Draw_Character( ( x + 5 ) << 3, v, 10 + ( Math.floor( realtime * con_cursorspeed ) & 1 ) );

		}

		v += 8;

	}

	if ( v > con_notifylines )
		con_notifylines = v;

}

/*
================
Con_DrawConsole

Draws the console with the solid background
The typing input line at the bottom should only be drawn if typing is allowed
================
*/
export function Con_DrawConsole( lines, drawinput ) {

	if ( lines <= 0 )
		return;

	// draw the background
	if ( _Draw_ConsoleBackground ) _Draw_ConsoleBackground( lines );

	// draw the text
	con_vislines = lines;

	const rows = ( lines - 16 ) >> 3; // rows of text to draw
	let y = lines - 16 - ( rows << 3 ); // may start slightly negative

	for ( let i = con_current - rows + 1; i <= con_current; i ++, y += 8 ) {

		let j = i - con_backscroll;
		if ( j < 0 )
			j = 0;

		const textStart = ( j % con_totallines ) * con_linewidth;

		if ( _Draw_Character ) {

			for ( let x = 0; x < con_linewidth; x ++ )
				_Draw_Character( ( x + 1 ) << 3, y, con_text[ textStart + x ] );

		}

	}

	// draw the input prompt, user text, and cursor if desired
	if ( drawinput )
		Con_DrawInput();

}

/*
==================
Con_NotifyBox
==================
*/
export function Con_NotifyBox( text ) {

	// during startup for sound / cd warnings
	Con_Printf( '\n\n\x1d\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1f\n' );
	Con_Printf( text );
	Con_Printf( 'Press a key.\n' );
	Con_Printf( '\x1d\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1f\n' );

	// In browser, we can't block. This would need to be async.
	// For now, just print the notification.

}

/*
==============================================================================

			INTERNAL HELPERS

==============================================================================
*/

// sprintf implementation supporting width, precision, and flags for Quake format strings
export function _sprintf( fmt, ...args ) {

	if ( typeof fmt !== 'string' ) return String( fmt );

	let result = '';
	let argIdx = 0;
	let i = 0;

	while ( i < fmt.length ) {

		if ( fmt[ i ] === '%' && i + 1 < fmt.length ) {

			i ++;

			// Parse flags: -, +, 0, space, #
			let leftAlign = false;
			let zeroPad = false;
			let plusSign = false;
			let spaceSign = false;

			let parsing = true;
			while ( i < fmt.length && parsing ) {

				switch ( fmt[ i ] ) {

					case '-': leftAlign = true; i ++; break;
					case '0': zeroPad = true; i ++; break;
					case '+': plusSign = true; i ++; break;
					case ' ': spaceSign = true; i ++; break;
					case '#': i ++; break; // ignore # flag
					default: parsing = false; break;

				}

			}

			// Parse width
			let width = 0;
			while ( i < fmt.length && fmt[ i ] >= '0' && fmt[ i ] <= '9' ) {

				width = width * 10 + ( fmt.charCodeAt( i ) - 48 );
				i ++;

			}

			// Parse precision
			let precision = - 1;
			if ( i < fmt.length && fmt[ i ] === '.' ) {

				i ++;
				precision = 0;
				while ( i < fmt.length && fmt[ i ] >= '0' && fmt[ i ] <= '9' ) {

					precision = precision * 10 + ( fmt.charCodeAt( i ) - 48 );
					i ++;

				}

			}

			// Parse conversion specifier
			let str = '';
			if ( i < fmt.length ) {

				switch ( fmt[ i ] ) {

					case 's': {

						const val = args[ argIdx ++ ];
						str = val != null ? String( val ) : '';
						if ( precision >= 0 && str.length > precision )
							str = str.substring( 0, precision );
						break;

					}
					case 'd':
					case 'i': {

						// C converts to int, which truncates toward zero
						const val = args[ argIdx ++ ];
						const num = Math.trunc( Number( val ) );
						const n = isNaN( num ) ? 0 : num;
						str = String( Math.abs( n ) );
						if ( n < 0 ) str = '-' + str;
						else if ( plusSign ) str = '+' + str;
						else if ( spaceSign ) str = ' ' + str;
						break;

					}
					case 'f': {

						const val = args[ argIdx ++ ];
						const num = Number( val );
						const n = isNaN( num ) ? 0.0 : num;
						const prec = precision >= 0 ? precision : 6;
						str = n.toFixed( prec );
						if ( plusSign && n >= 0 ) str = '+' + str;
						else if ( spaceSign && n >= 0 ) str = ' ' + str;
						break;

					}
					case 'u':
					case 'x':
					case 'X': {

						// unsigned 32-bit, as the C int argument is reinterpreted
						const val = args[ argIdx ++ ];
						const num = Math.trunc( Number( val ) );
						const n = isNaN( num ) ? 0 : ( num >>> 0 );
						if ( fmt[ i ] === 'u' )
							str = String( n );
						else if ( fmt[ i ] === 'x' )
							str = n.toString( 16 );
						else
							str = n.toString( 16 ).toUpperCase();
						break;

					}
					case 'c': {

						const val = args[ argIdx ++ ];
						str = String.fromCharCode( val != null ? val : 0 );
						break;

					}
					case '%':
						str = '%';
						break;
					default:
						str = fmt[ i ];
						break;

				}

			}

			// Apply width padding
			if ( width > 0 && str.length < width ) {

				const padChar = ( zeroPad && ! leftAlign ) ? '0' : ' ';
				const padLen = width - str.length;
				const padding = padChar.repeat( padLen );
				if ( leftAlign ) {

					str = str + padding;

				} else {

					// For zero-padded negative numbers, put '-' before zeros
					if ( zeroPad && str.length > 0 && str[ 0 ] === '-' ) {

						str = '-' + padding + str.substring( 1 );

					} else {

						str = padding + str;

					}

				}

			}

			result += str;
			i ++;

		} else {

			result += fmt[ i ];
			i ++;

		}

	}

	return result;

}
