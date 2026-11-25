// Ported from: WinQuake/gl_screen.c -- GL screen management
// Master for refresh, status bar, console, chat, notify, etc

import { Con_Printf, Con_CheckResize, Con_DrawConsole, Con_DrawNotify, Con_ClearNotify,
	Con_SetForcedup, con_initialized } from './console.js';
import { Sbar_Draw, Sbar_Changed, Sbar_IntermissionOverlay, Sbar_FinaleOverlay, set_sb_lines as Sbar_set_sb_lines } from './sbar.js';
import { M_Draw } from './menu.js';
import { Draw_Character, Draw_CachePic, Draw_Pic, Draw_FadeScreen, Draw_BeginFrame,
	GL_Set2D, Draw_TileClear, Draw_PicFromWad, Draw_GetUIScale,
	Draw_GetVirtualWidth, Draw_GetVirtualHeight, Draw_GetCanvasScale, Draw_SetCanvasScale } from './gl_draw.js';
import { Cvar_RegisterVariable, Cvar_Set, Cvar_SetValue, Cvar_VariableValue } from './cvar.js';
import { Cmd_AddCommand } from './cmd.js';
import { key_dest, key_game, key_console, key_message, Key_BeginModal, Key_ModalYes } from './keys.js';
import { realtime, host_frametime } from './host.js';
import { renderer } from './vid.js';
import { r_refdef as _r_refdef_canonical } from './render.js';
import { r_framecount } from './glquake.js';
import { R_WaterWarp_Init, R_WarpScreen } from './gl_screenwarp.js';

/*
==============================================================================

			GL SCREEN STATE

==============================================================================
*/


export let scr_con_current = 0;
let scr_conlines = 0; // lines of console to display

let oldfov = 0;
let oldscreensize = 0;
let oldsbaralpha = 1;
let oldsbarscale = 0;

export const scr_viewsize = { name: 'viewsize', string: '100', value: 100, archive: true };
const scr_fov = { name: 'fov', string: '90', value: 90 };
const scr_conspeed = { name: 'scr_conspeed', string: '300', value: 300 };
const scr_centertime = { name: 'scr_centertime', string: '2', value: 2 };
const scr_showram = { name: 'showram', string: '1', value: 1 };
const scr_showturtle = { name: 'showturtle', string: '0', value: 0 };
const scr_showpause = { name: 'showpause', string: '1', value: 1 };
const scr_printspeed = { name: 'scr_printspeed', string: '8', value: 8 };
const gl_triplebuffer = { name: 'gl_triplebuffer', string: '1', value: 1, archive: true };
// FitzQuake/QuakeSpasm cvars (QS gl_screen.c)
export const scr_showfps = { name: 'scr_showfps', string: '0', value: 0 };
export const scr_clock = { name: 'scr_clock', string: '0', value: 0 };
// QS defaults scr_sbaralpha to 0.75; 1 keeps the opaque WinQuake status bar
export const scr_sbaralpha = { name: 'scr_sbaralpha', string: '1', value: 1, archive: true };
// FitzQuake/Ironwail HUD scales, in physical pixels per 320x200 pixel.
// Deviation: Ironwail defaults them to 1; 0 here keeps the automatic UI scale.
export const scr_sbarscale = { name: 'scr_sbarscale', string: '0', value: 0, archive: true };
export const scr_conscale = { name: 'scr_conscale', string: '0', value: 0, archive: true };

export let scr_initialized = false;

let scr_net = null;
let scr_turtle = null;


let clearconsole = 0;
let clearnotify = 0;

let sb_lines = 0;

const scr_vrect = { x: 0, y: 0, width: 0, height: 0 };

export let scr_disabled_for_loading = false;
export let scr_drawloading = false;
let scr_disabled_time = 0;

const block_drawing = false;

// Center print
let scr_centerstring = '';
let scr_centertime_start = 0;
let scr_centertime_off = 0;
let scr_center_lines = 0;
let scr_erase_lines = 0;

// Modal dialog
let scr_notifystring = '';
let scr_drawdialog = false;

// SIGNONS constant
const SIGNONS = 4;

/*
==============================================================================

			EXTERNAL REFERENCES

==============================================================================
*/

let _realVid = { width: 640, height: 480, numpages: 2, recalc_refdef: false };
const _vid = {
	get width() { return Draw_GetVirtualWidth(); },
	get height() { return Draw_GetVirtualHeight(); },
	get numpages() { return _realVid.numpages; },
	set numpages( v ) { _realVid.numpages = v; },
	get recalc_refdef() { return _realVid.recalc_refdef; },
	set recalc_refdef( v ) { _realVid.recalc_refdef = v; }
};
let _cls = { state: 0, signon: 0, demoplayback: false };
let _cl = { intermission: 0, paused: false, worldmodel: null, time: 0,
	last_received_message: 0 };
let _r_refdef = null; // deferred: set in SCR_Init to avoid circular dep in Deno
let _V_RenderView = null;
let _V_UpdatePalette = null;
let _GL_BeginRendering = null;
let _GL_EndRendering = null;
let _S_StopAllSounds = null;
const _r_cache_thrash = false;

export function SCR_SetExternals( externals ) {

	if ( externals.vid ) _realVid = externals.vid;
	if ( externals.cls ) _cls = externals.cls;
	if ( externals.cl ) _cl = externals.cl;
	if ( externals.r_refdef ) _r_refdef = externals.r_refdef;
	if ( externals.V_RenderView ) _V_RenderView = externals.V_RenderView;
	if ( externals.V_UpdatePalette ) _V_UpdatePalette = externals.V_UpdatePalette;
	if ( externals.GL_BeginRendering ) _GL_BeginRendering = externals.GL_BeginRendering;
	if ( externals.GL_EndRendering ) _GL_EndRendering = externals.GL_EndRendering;
	if ( externals.S_StopAllSounds ) _S_StopAllSounds = externals.S_StopAllSounds;

}

/*
==============
SCR_CenterPrint

Called for important messages that should stay in the center of the screen
for a few moments
==============
*/
export function SCR_CenterPrint( str ) {

	scr_centerstring = str.substring( 0, 1023 );
	scr_centertime_off = scr_centertime.value;
	scr_centertime_start = _cl.time;

	// count the number of lines for centering
	scr_center_lines = 1;
	for ( let i = 0; i < str.length; i ++ ) {

		if ( str[ i ] === '\n' )
			scr_center_lines ++;

	}

}

/*
==============
SCR_DrawCenterString
==============
*/
function SCR_DrawCenterString() {

	let remaining;

	// the finale prints the characters one at a time
	if ( _cl.intermission )
		remaining = Math.floor( scr_printspeed.value * ( _cl.time - scr_centertime_start ) );
	else
		remaining = 9999;


	let start = 0;
	let y;

	if ( scr_center_lines <= 4 )
		y = Math.floor( _vid.height * 0.35 );
	else
		y = 48;

	while ( start < scr_centerstring.length ) {

		// scan the width of the line
		let l;
		for ( l = 0; l < 40; l ++ ) {

			if ( start + l >= scr_centerstring.length || scr_centerstring[ start + l ] === '\n' )
				break;

		}

		const x = Math.floor( ( _vid.width - l * 8 ) / 2 );

		for ( let j = 0; j < l; j ++ ) {

			Draw_Character( x + j * 8, y, scr_centerstring.charCodeAt( start + j ) );
			if ( remaining -- === 0 )
				return;

		}

		y += 8;

		// skip past the line
		while ( start < scr_centerstring.length && scr_centerstring[ start ] !== '\n' )
			start ++;

		if ( start >= scr_centerstring.length )
			break;

		start ++; // skip the \n

	}

}

function SCR_CheckDrawCenterString() {


	if ( scr_center_lines > scr_erase_lines )
		scr_erase_lines = scr_center_lines;

	scr_centertime_off -= host_frametime;

	if ( scr_centertime_off <= 0 && ! _cl.intermission )
		return;
	if ( key_dest !== key_game )
		return;

	SCR_DrawCenterString();

}

/*
====================
CalcFov
====================
*/
function CalcFov( fov_x, width, height ) {

	if ( fov_x < 1 || fov_x > 179 )
		fov_x = 90;

	const x = width / Math.tan( fov_x / 360 * Math.PI );
	let a = Math.atan( height / x );
	a = a * 360 / Math.PI;
	return a;

}

/*
====================
CalcFovX

Inverse of CalcFov - given vertical FOV, calculate horizontal FOV
====================
*/
function CalcFovX( fov_y, width, height ) {

	if ( fov_y < 1 || fov_y > 179 )
		fov_y = 90;

	const y = height / Math.tan( fov_y / 360 * Math.PI );
	let a = Math.atan( width / y );
	a = a * 360 / Math.PI;
	return a;

}

/*
=================
SCR_CalcRefdef

Must be called whenever vid changes
Internal use only (exported for tests)
=================
*/
export function SCR_CalcRefdef() {

	_vid.recalc_refdef = false;
	_r_refdef.vrectScale = Draw_GetUIScale();

	// force the status bar to redraw
	Sbar_Changed();

	// bound viewsize
	if ( scr_viewsize.value < 30 )
		Cvar_Set( 'viewsize', '30' );
	if ( scr_viewsize.value > 120 )
		Cvar_Set( 'viewsize', '120' );

	// bound field of view
	if ( scr_fov.value < 10 )
		Cvar_Set( 'fov', '10' );
	if ( scr_fov.value > 170 )
		Cvar_Set( 'fov', '170' );

	// intermission is always full screen
	let size;
	if ( _cl.intermission )
		size = 120;
	else
		size = scr_viewsize.value;

	if ( size >= 120 )
		sb_lines = 0; // no status bar at all
	else if ( size >= 110 )
		sb_lines = 24; // no inventory
	else
		sb_lines = 24 + 16 + 8;
	Sbar_set_sb_lines( sb_lines );

	// QS SCR_CalcRefdef: a translucent status bar takes no lines from the
	// view, which extends under it. The status bar keeps its own lines
	// (sbar.js still needs them to choose what to draw); this copy sizes the
	// view and SCR_TileClear.
	if ( scr_sbaralpha.value < 1 )
		sb_lines = 0;

	// Ironwail SCR_CalcRefdef: the status bar is sb_lines * scr_sbarscale
	// physical pixels tall; convert that to the UI-scale units used here
	sb_lines = Math.floor( sb_lines * Draw_GetCanvasScale( scr_sbarscale.value ) / _r_refdef.vrectScale );

	let full = false;
	if ( scr_viewsize.value >= 100.0 ) {

		full = true;
		size = 100.0;

	} else {

		size = scr_viewsize.value;

	}

	if ( _cl.intermission ) {

		full = true;
		size = 100;
		sb_lines = 0;
		Sbar_set_sb_lines( sb_lines );

	}

	size /= 100.0;

	const h = _vid.height - sb_lines;

	_r_refdef.vrect.width = Math.floor( _vid.width * size );
	if ( _r_refdef.vrect.width < 96 ) {

		size = 96.0 / _r_refdef.vrect.width;
		_r_refdef.vrect.width = 96; // min for icons

	}

	_r_refdef.vrect.height = Math.floor( _vid.height * size );
	if ( _r_refdef.vrect.height > _vid.height - sb_lines )
		_r_refdef.vrect.height = _vid.height - sb_lines;
	if ( _r_refdef.vrect.height > _vid.height )
		_r_refdef.vrect.height = _vid.height;

	_r_refdef.vrect.x = Math.floor( ( _vid.width - _r_refdef.vrect.width ) / 2 );

	if ( full )
		_r_refdef.vrect.y = 0;
	else
		_r_refdef.vrect.y = Math.floor( ( h - _r_refdef.vrect.height ) / 2 );

	// Hor+ FOV: lock vertical FOV to what fov cvar gives at 4:3,
	// then expand horizontal FOV for the actual aspect ratio.
	_r_refdef.fov_y = CalcFov( scr_fov.value, 4, 3 );
	_r_refdef.fov_x = CalcFovX( _r_refdef.fov_y, _r_refdef.vrect.width, _r_refdef.vrect.height );

	scr_vrect.x = _r_refdef.vrect.x;
	scr_vrect.y = _r_refdef.vrect.y;
	scr_vrect.width = _r_refdef.vrect.width;
	scr_vrect.height = _r_refdef.vrect.height;

}

/*
=================
SCR_SizeUp_f

Keybinding command
=================
*/
function SCR_SizeUp_f() {

	Cvar_SetValue( 'viewsize', scr_viewsize.value + 10 );
	_vid.recalc_refdef = true;

}

/*
=================
SCR_SizeDown_f

Keybinding command
=================
*/
function SCR_SizeDown_f() {

	Cvar_SetValue( 'viewsize', scr_viewsize.value - 10 );
	_vid.recalc_refdef = true;

}

/*
==================
SCR_Init
==================
*/
export function SCR_Init() {

	if ( _r_refdef === null ) _r_refdef = _r_refdef_canonical;

	Cvar_RegisterVariable( scr_fov );
	Cvar_RegisterVariable( scr_viewsize );
	Cvar_RegisterVariable( scr_conspeed );
	Cvar_RegisterVariable( scr_showram );
	Cvar_RegisterVariable( scr_showturtle );
	Cvar_RegisterVariable( scr_showpause );
	Cvar_RegisterVariable( scr_centertime );
	Cvar_RegisterVariable( scr_printspeed );
	Cvar_RegisterVariable( gl_triplebuffer );
	Cvar_RegisterVariable( scr_showfps );
	Cvar_RegisterVariable( scr_clock );
	Cvar_RegisterVariable( scr_sbaralpha );
	Cvar_RegisterVariable( scr_sbarscale );
	Cvar_RegisterVariable( scr_conscale );
	R_WaterWarp_Init();

	//
	// register our commands
	//
	Cmd_AddCommand( 'screenshot', SCR_ScreenShot_f );
	Cmd_AddCommand( 'sizeup', SCR_SizeUp_f );
	Cmd_AddCommand( 'sizedown', SCR_SizeDown_f );

	scr_net = Draw_PicFromWad( 'net' );
	scr_turtle = Draw_PicFromWad( 'turtle' );

	scr_initialized = true;

}

/*
==============
SCR_DrawRam
==============
*/
function SCR_DrawRam() {

	if ( ! scr_showram.value )
		return;

	// r_cache_thrash is not applicable in Three.js port

}

/*
==============
SCR_DrawTurtle
==============
*/
let turtle_count = 0;

function SCR_DrawTurtle() {

	if ( ! scr_showturtle.value )
		return;

	if ( host_frametime < 0.1 ) {

		turtle_count = 0;
		return;

	}

	turtle_count ++;
	if ( turtle_count < 3 )
		return;

	Draw_Pic( scr_vrect.x, scr_vrect.y, scr_turtle );

}

/*
==============
SCR_DrawNet
==============
*/
function SCR_DrawNet() {

	if ( realtime - _cl.last_received_message < 0.3 )
		return;
	if ( _cls.demoplayback )
		return;

	Draw_Pic( scr_vrect.x + 64, scr_vrect.y, scr_net );

}

/*
==============
SCR_DrawPause
==============
*/
function SCR_DrawPause() {

	if ( ! scr_showpause.value )
		return;

	if ( ! _cl.paused )
		return;

	const pic = Draw_CachePic( 'gfx/pause.lmp' );
	if ( pic )
		Draw_Pic( ( _vid.width - ( pic.width || 0 ) ) / 2,
			( _vid.height - 48 - ( pic.height || 0 ) ) / 2, pic );

}

/*
==============
SCR_DrawLoading
==============
*/
export function SCR_DrawLoading() {

	if ( ! scr_drawloading )
		return;

	const pic = Draw_CachePic( 'gfx/loading.lmp' );
	if ( pic )
		Draw_Pic( ( _vid.width - ( pic.width || 0 ) ) / 2,
			( _vid.height - 48 - ( pic.height || 0 ) ) / 2, pic );

}

/*
==================
SCR_SetUpToDrawConsole
==================
*/
function SCR_SetUpToDrawConsole() {

	Con_CheckResize();

	if ( scr_drawloading )
		return; // never a console with loading plaque

	// decide on the height of the console
	const forcedup = ! _cl.worldmodel || _cls.signon !== SIGNONS;
	Con_SetForcedup( forcedup );

	if ( forcedup ) {

		scr_conlines = _vid.height; // full screen
		scr_con_current = scr_conlines;

	} else if ( key_dest === key_console ) {

		scr_conlines = _vid.height / 2; // half screen

	} else {

		scr_conlines = 0; // none visible

	}

	if ( scr_conlines < scr_con_current ) {

		scr_con_current -= scr_conspeed.value * host_frametime;
		if ( scr_conlines > scr_con_current )
			scr_con_current = scr_conlines;

	} else if ( scr_conlines > scr_con_current ) {

		scr_con_current += scr_conspeed.value * host_frametime;
		if ( scr_conlines < scr_con_current )
			scr_con_current = scr_conlines;

	}

	if ( clearconsole ++ < _vid.numpages ) {

		Sbar_Changed();

	} else if ( clearnotify ++ < _vid.numpages ) {

		// nothing

	} else {

		// con_notifylines = 0; -- handled via console module

	}

}

/*
==================
SCR_DrawSbar

Sbar_Draw on the status bar canvas (Ironwail CANVAS_SBAR, scr_sbarscale)
==================
*/
function SCR_DrawSbar() {

	Draw_SetCanvasScale( scr_sbarscale.value );
	Sbar_Draw();
	Draw_SetCanvasScale( 0 );

}

/*
==================
SCR_DrawConsole
==================
*/
function SCR_DrawConsole() {

	if ( scr_con_current ) {

		Con_DrawConsole( scr_con_current, true );
		clearconsole = 0;

	} else {

		if ( key_dest === key_game || key_dest === key_message )
			Con_DrawNotify(); // only draw notify in game

	}

}

/*
==================
SCR_ModalMessage

Displays a text string in the center of the screen and waits for a Y or N
keypress. C blocks and returns the answer; here the answer goes to callback
once Key_Event sees 'y', 'n' or escape.
==================
*/
export function SCR_ModalMessage( text, callback ) {

	if ( _cls.state === 0 ) { // ca_dedicated

		callback( true );
		return;

	}

	scr_notifystring = text;

	// draw a fresh screen
	scr_drawdialog = true;

	Key_BeginModal( function ( yes ) {

		scr_drawdialog = false;
		callback( yes );

	} );

}

/*
==================
SCR_DrawNotifyString
==================
*/
function SCR_DrawNotifyString() {

	let start = 0;
	let y = Math.floor( _vid.height * 0.35 );

	while ( start < scr_notifystring.length ) {

		let l;
		for ( l = 0; l < 40; l ++ ) {

			if ( start + l >= scr_notifystring.length || scr_notifystring[ start + l ] === '\n' )
				break;

		}

		const x = Math.floor( ( _vid.width - l * 8 ) / 2 );
		for ( let j = 0; j < l; j ++ )
			Draw_Character( x + j * 8, y, scr_notifystring.charCodeAt( start + j ) );

		y += 8;

		while ( start < scr_notifystring.length && scr_notifystring[ start ] !== '\n' )
			start ++;

		if ( start >= scr_notifystring.length )
			break;

		start ++; // skip the \n

	}

	SCR_DrawYesNo( _vid.width >> 1, SCR_ModalYesNoTop(), Key_ModalYes() );

}

// Top of SCR_DrawNotifyString's YES / NO row: a blank line under the text
function SCR_ModalYesNoTop() {

	const text = scr_notifystring;
	let lines = 0;
	for ( let i = 0; i < text.length; i ++ )
		if ( text.charCodeAt( i ) === 10 ) lines ++; // '\n'
	if ( text.length > 0 && text.charCodeAt( text.length - 1 ) !== 10 )
		lines ++;

	return Math.floor( _vid.height * 0.35 ) + lines * 8 + 8;

}

/*
==================
SCR_ModalYesNoAt

Which choice of SCR_ModalMessage's YES / NO row is at a point in _vid
pixels: 1 for YES, 0 for NO, -1 for neither
==================
*/
export function SCR_ModalYesNoAt( x, y ) {

	return SCR_YesNoHit( x, y, _vid.width >> 1, SCR_ModalYesNoTop() );

}

const YESNO_HIT_WIDTH = 64; // each choice's tap box, either side of x

function SCR_DrawYesNoLabel( x, y, label, selected ) {

	if ( selected )
		Draw_Character( x - 12, y, 12 + ( Math.floor( realtime * 4 ) & 1 ) );

	for ( let i = 0; i < label.length; i ++ )
		Draw_Character( x + i * 8, y, label.charCodeAt( i ) + ( selected ? 0 : 128 ) );

}

/*
==================
SCR_DrawYesNo

Deliberate deviation (web-only input): draws the YES / NO choice under a
yes/no prompt (SCR_ModalMessage, the quit menu), with the blinking menu
cursor and white text on the selected one. x is the centre of the row and
y its top, in _vid pixels.
==================
*/
export function SCR_DrawYesNo( x, y, yes ) {

	SCR_DrawYesNoLabel( x - 44, y, 'YES', yes );
	SCR_DrawYesNoLabel( x + 24, y, 'NO', ! yes );

}

/*
==================
SCR_YesNoHit

Which choice of a YES / NO row drawn by SCR_DrawYesNo( rowx, rowy ) is at
the point x, y (same units): 1 for YES, 0 for NO, -1 for neither. Each
choice's tap box is a little larger than its text.
==================
*/
export function SCR_YesNoHit( x, y, rowx, rowy ) {

	if ( y < rowy - 8 || y >= rowy + 16 )
		return - 1;
	if ( x >= rowx - YESNO_HIT_WIDTH && x < rowx )
		return 1;
	if ( x >= rowx && x < rowx + YESNO_HIT_WIDTH )
		return 0;
	return - 1;

}

/*
==============
SCR_FormatFPS, SCR_FormatClock

The strings QS's SCR_DrawFPS ("%4.0f fps") and SCR_DrawClock ("%i:%i%i")
print
==============
*/
export function SCR_FormatFPS( fps ) {

	return String( Math.round( fps ) ).padStart( 4, ' ' ) + ' fps';

}

export function SCR_FormatClock( time ) {

	const minutes = Math.trunc( time / 60 );
	const seconds = Math.trunc( time ) % 60;
	return minutes + ':' + Math.trunc( seconds / 10 ) + ( seconds % 10 );

}

// Draws str right-aligned against the bottom-right corner of the screen,
// line lines up from the bottom (QS draws on CANVAS_BOTTOMRIGHT)
function SCR_DrawBottomRight( str, line ) {

	const x = _vid.width - str.length * 8;
	const y = _vid.height - 8 - line * 8;
	for ( let i = 0; i < str.length; i ++ )
		Draw_Character( x + i * 8, y, str.charCodeAt( i ) );

}

/*
==============
SCR_DrawFPS -- johnfitz

Ported from QuakeSpasm Quake/gl_screen.c. Frames are counted with
r_framecount, so the rate is of 3D frames, as in QS.
==============
*/
let fps_oldtime = 0;
let fps_lastfps = 0;
let fps_oldframecount = 0;
let fps_string = '';
let fps_string_value = - 1;

function SCR_DrawFPS() {

	const elapsed_time = realtime - fps_oldtime;
	const frames = r_framecount - fps_oldframecount;

	if ( elapsed_time < 0 || frames < 0 ) {

		fps_oldtime = realtime;
		fps_oldframecount = r_framecount;
		return;

	}

	// update value every 3/4 second
	if ( elapsed_time > 0.75 ) {

		fps_lastfps = frames / elapsed_time;
		fps_oldtime = realtime;
		fps_oldframecount = r_framecount;

	}

	if ( scr_showfps.value !== 0 ) {

		// The string only changes every 0.75 s: build it then
		if ( fps_string_value !== fps_lastfps ) {

			fps_string_value = fps_lastfps;
			fps_string = SCR_FormatFPS( fps_lastfps );

		}

		SCR_DrawBottomRight( fps_string, scr_clock.value !== 0 ? 1 : 0 ); // make room for clock

	}

}

/*
==============
SCR_DrawClock -- johnfitz

Ported from QuakeSpasm Quake/gl_screen.c
==============
*/
let clock_string = '';
let clock_seconds = - 1;

function SCR_DrawClock() {

	if ( scr_clock.value !== 1 )
		return;

	const seconds = Math.trunc( _cl.time );
	if ( seconds !== clock_seconds ) {

		clock_seconds = seconds;
		clock_string = SCR_FormatClock( _cl.time );

	}

	SCR_DrawBottomRight( clock_string, 0 );

}

/*
==================
SCR_TileClear
==================
*/
function SCR_TileClear() {

	if ( _r_refdef.vrect.x > 0 ) {

		// left
		Draw_TileClear( 0, 0, _r_refdef.vrect.x, _vid.height - sb_lines );
		// right
		Draw_TileClear( _r_refdef.vrect.x + _r_refdef.vrect.width, 0,
			_vid.width - _r_refdef.vrect.x + _r_refdef.vrect.width,
			_vid.height - sb_lines );

	}

	if ( _r_refdef.vrect.y > 0 ) {

		// top
		Draw_TileClear( _r_refdef.vrect.x, 0,
			_r_refdef.vrect.x + _r_refdef.vrect.width,
			_r_refdef.vrect.y );
		// bottom
		Draw_TileClear( _r_refdef.vrect.x,
			_r_refdef.vrect.y + _r_refdef.vrect.height,
			_r_refdef.vrect.width,
			_vid.height - sb_lines -
			( _r_refdef.vrect.height + _r_refdef.vrect.y ) );

	}

}

/*
==============
SCR_ScreenShot_f
==============
*/
let _screenshotPending = false;

function SCR_ScreenShot_f() {

	_screenshotPending = true;
	Con_Printf( 'Capturing screenshot...\n' );

}

function SCR_DoScreenShot() {

	if ( renderer == null ) {

		Con_Printf( 'Screenshot: renderer not initialized\n' );
		return;

	}

	const canvas = renderer.domElement;

	try {

		// toDataURL is synchronous — reads the buffer before it's cleared
		const dataURL = canvas.toDataURL( 'image/png' );

		const link = document.createElement( 'a' );
		link.download = 'quake_screenshot.png';
		link.href = dataURL;
		link.click();

		Con_Printf( 'Screenshot saved\n' );

	} catch ( e ) {

		Con_Printf( 'Screenshot failed: ' + e.message + '\n' );

	}

}

/*
===============
SCR_BeginLoadingPlaque
================
*/
export function SCR_BeginLoadingPlaque() {

	if ( _S_StopAllSounds ) _S_StopAllSounds( true );

	if ( _cls.state !== 2 ) // ca_connected
		return;
	if ( _cls.signon !== SIGNONS )
		return;

	// redraw with no console and the loading plaque
	Con_ClearNotify();
	scr_centertime_off = 0;
	scr_con_current = 0;

	scr_drawloading = true;
	Sbar_Changed();
	SCR_UpdateScreen();
	scr_drawloading = false;

	scr_disabled_for_loading = true;
	scr_disabled_time = realtime;

}

/*
===============
SCR_EndLoadingPlaque
================
*/
export function SCR_EndLoadingPlaque() {

	scr_disabled_for_loading = false;
	Con_ClearNotify();

}

/*
==================
SCR_UpdateScreen

This is called every frame, and can also be called explicitly to flush
text to the screen.

WARNING: be very careful calling this from elsewhere, because the refresh
needs almost the entire 256k of stack space!
==================
*/
export function SCR_UpdateScreen() {

	if ( block_drawing )
		return;

	_vid.numpages = 2 + gl_triplebuffer.value;


	if ( scr_disabled_for_loading ) {

		if ( realtime - scr_disabled_time > 60 ) {

			scr_disabled_for_loading = false;
			Con_Printf( 'load failed.\n' );

		} else {

			return;

		}

	}

	if ( ! scr_initialized || ! con_initialized )
		return; // not initialized yet

	// GL_BeginRendering
	if ( _GL_BeginRendering ) _GL_BeginRendering();

	// Clear 2D overlay
	Draw_BeginFrame();

	//
	// determine size of refresh window
	//
	if ( oldfov !== scr_fov.value ) {

		oldfov = scr_fov.value;
		_vid.recalc_refdef = true;

	}

	if ( oldscreensize !== scr_viewsize.value ) {

		oldscreensize = scr_viewsize.value;
		_vid.recalc_refdef = true;

	}

	// QS: scr_sbaralpha has a callback that recalculates the refdef
	if ( oldsbaralpha !== scr_sbaralpha.value ) {

		oldsbaralpha = scr_sbaralpha.value;
		_vid.recalc_refdef = true;

	}

	if ( oldsbarscale !== scr_sbarscale.value ) {

		oldsbarscale = scr_sbarscale.value;
		_vid.recalc_refdef = true;

	}

	if ( _vid.recalc_refdef )
		SCR_CalcRefdef();

	//
	// do 3D refresh drawing, and then update the screen
	//
	Draw_SetCanvasScale( scr_conscale.value ); // console layout uses the console canvas
	SCR_SetUpToDrawConsole();
	Draw_SetCanvasScale( 0 );

	if ( _V_RenderView ) _V_RenderView();

	// Fitz/QS r_waterwarp 1: warp the 3D view while underwater
	R_WarpScreen( _cl.time );

	GL_Set2D();

	//
	// draw any areas not covered by the refresh
	//
	SCR_TileClear();

	if ( scr_drawdialog ) {

		SCR_DrawSbar();
		Draw_FadeScreen();
		SCR_DrawNotifyString();

	} else if ( scr_drawloading ) {

		SCR_DrawLoading();
		SCR_DrawSbar();

	} else if ( _cl.intermission === 1 && key_dest === key_game ) {

		Sbar_IntermissionOverlay();

	} else if ( _cl.intermission === 2 && key_dest === key_game ) {

		Sbar_FinaleOverlay();
		SCR_CheckDrawCenterString();

	} else {

		if ( Cvar_VariableValue( 'crosshair' ) !== 0 && _cls.demoplayback === false )
			Draw_Character( Math.floor( _vid.width / 2 + Cvar_VariableValue( 'cl_crossx' ) ) - 4,
				Math.floor( _vid.height / 2 + Cvar_VariableValue( 'cl_crossy' ) ) - 4, 43 ); // '+' crosshair

		SCR_DrawRam();
		SCR_DrawNet();
		SCR_DrawTurtle();
		SCR_DrawPause();
		SCR_CheckDrawCenterString();
		SCR_DrawSbar();
		SCR_DrawFPS(); //johnfitz
		SCR_DrawClock(); //johnfitz
		Draw_SetCanvasScale( scr_conscale.value );
		SCR_DrawConsole();
		Draw_SetCanvasScale( 0 );
		M_Draw();

	}

	if ( _V_UpdatePalette ) _V_UpdatePalette();

	// GL_EndRendering
	if ( _GL_EndRendering ) _GL_EndRendering();

	// Capture screenshot after render, while draw buffer is still valid
	if ( _screenshotPending ) {

		_screenshotPending = false;
		SCR_DoScreenShot();

	}

}
