// Ported from: WinQuake/in_win.c, WinQuake/input.h -- browser input system
// Adapted for web: uses Pointer Lock API for mouse, DOM keyboard events

import {
	K_TAB, K_ENTER, K_ESCAPE, K_SPACE, K_BACKSPACE,
	K_UPARROW, K_DOWNARROW, K_LEFTARROW, K_RIGHTARROW,
	K_ALT, K_CTRL, K_SHIFT,
	K_F1, K_F2, K_F3, K_F4, K_F5, K_F6, K_F7, K_F8, K_F9, K_F10, K_F11, K_F12,
	K_INS, K_DEL, K_PGDN, K_PGUP, K_HOME, K_END, K_PAUSE,
	K_MOUSE1, K_MOUSE2, K_MOUSE3,
	K_MWHEELUP, K_MWHEELDOWN,
	Key_Event, Key_ClearStates,
	key_game, key_menu, key_dest
} from './keys.js';
import { Cvar_RegisterVariable } from './cvar.js';
import { Cmd_AddCommand, Cbuf_AddText } from './cmd.js';
import { Con_Printf } from './console.js';
import { cl, cls, ca_connected } from './client.js';
import { sensitivity, m_pitch, m_yaw, m_forward, m_side, lookstrafe } from './cl_main.js';
import {
	in_mlook, in_strafe, in_speed,
	cl_forwardspeed, cl_backspeed, cl_sidespeed, cl_yawspeed, cl_pitchspeed, cl_movespeedkey
} from './cl_input.js';
import { V_StopPitchDrift } from './view.js';
import { host_frametime } from './host.js';
import { PITCH, YAW } from './quakedef.js';
import {
	Touch_IsMobile, Touch_IsTouchCapable, Touch_Init, Touch_Enable, Touch_Disable, Touch_IsEnabled,
	Touch_GetMoveInput, Touch_GetLookDelta, Touch_ReleaseButtons,
	Touch_ShowMenu, Touch_HideMenu, Touch_SetMenuCallback, Touch_RequestFullscreen,
	Touch_RegisterCvars, Touch_Frame, Touch_ShowSysBar, Touch_HideSysBar
} from './touch.js';
import { M_TouchInput } from './menu.js';
import { Draw_GetOverlayCanvas } from './gl_draw.js';
import { S_UnlockAudio, S_BlockSound, S_UnblockSound } from './snd_dma.js';
import { isXRActive, XR_PollInput, XR_UpdateHUD, XR_SetSessionEndCallback, xrInput } from './webxr.js';

/*
===========================================================================

			BROWSER KEY MAPPING

Maps DOM event.code / event.key values to Quake K_* constants.
===========================================================================
*/

let codeToQuakeKey = {}; // built in IN_Init to avoid circular dep in Deno

// US-layout characters for the physical punctuation keys. Used when the
// layout produces a character outside printable ASCII (e.g. 'ö', '²' or a
// dead key) so the key still maps to a bindable Quake key.
const codeToUSChar = {
	'Backquote': '`',
	'Minus': '-',
	'Equal': '=',
	'BracketLeft': '[',
	'BracketRight': ']',
	'Backslash': '\\',
	'IntlBackslash': '\\',
	'Semicolon': ';',
	'Quote': '\'',
	'Comma': ',',
	'Period': '.',
	'Slash': '/'
};

/*
===========================================================================

			INPUT STATE

===========================================================================
*/

// Mouse state (replaces DirectInput mouse in in_win.c)
let mouse_x = 0;
let mouse_y = 0;
let old_mouse_x = 0;
let old_mouse_y = 0;
let mx_accum = 0;
let my_accum = 0;
const _mouseMove = { mx: 0, my: 0 }; // returned by IN_MouseMove (no per-frame allocation)

let mouseactive = false;

// Mouse buttons we have sent down (bit 0 = K_MOUSE1, 1 = K_MOUSE2, 2 = K_MOUSE3).
// Replaces mouse_oldbuttonstate from in_win.c.
let mouse_buttonstate = 0;

// Pointer lock state
let pointerLocked = false;
let targetElement = null;
let eventWindow = null; // window, or targetElement when there is no window (Deno tests)

// Set when we drop pointer lock ourselves (switching to touch), so the
// pointerlockchange handler does not open the menu.
let suppressLockEscape = false;

// Web-only: some browsers with a mouse-like pointer never grant pointer lock
// (Samsung TV browsers fire pointerlockerror for every request). Once two
// requests in a row are refused before any lock has worked, clicks ask for
// fullscreen instead, which those browsers do allow. One refusal may be
// transient (an unfocused page), and a refusal after a lock has worked
// (e.g. Chrome's cooldown after Escape) changes nothing.
let pointerLockWorked = false;
let pointerLockRefusals = 0;
let pointerLockUnavailable = false;

// Quake key sent down for each physical key (event.code), so keyup releases
// the same Quake key even if Shift or the layout changed event.key meanwhile.
const keyForCode = new Map();

// Touch state. touchMode follows the last pointer used: a touch or pen
// pointerdown switches to touch controls, mouse movement switches back to
// pointer lock and mouse look. Touchscreen laptops start in mouse mode.
let touchMode = false;

// Meta Quest — disables pointer lock and fullscreen
let isQuest = false;

// XR controller state. Each button slot holds the Quake key it sent down
// (0 = up, -1 = held but mapped to nothing), so a held button keeps its key
// even if key_dest changes, and sends nothing new until it is pressed again.
// Buttons that send the same key share it: it goes up when the last is released.
const _xrKeys = {
	leftTrigger: 0,
	rightTrigger: 0,
	a: 0,
	b: 0,
	y: 0,
	up: 0,
	down: 0,
	left: 0,
	right: 0
};
let _xrUseHeld = false;
let _xrWeaponNext = false;
let _xrWeaponPrev = false;
let _xrSnapArmed = true;

// Gamepad button edge detection (standard mapping)
let _gpPrev = null;

function GP_ReleaseAll() {

	// If a controller disconnects mid-press, make sure nothing gets "stuck" down.
	Key_Event( K_SPACE, false );
	Key_Event( K_ENTER, false );
	Key_Event( K_ESCAPE, false );
	Key_Event( K_TAB, false );
	Key_Event( K_SHIFT, false );
	Key_Event( K_CTRL, false );
	Key_Event( K_MOUSE1, false );
	Key_Event( 'r'.charCodeAt( 0 ), false );
	Key_Event( K_UPARROW, false );
	Key_Event( K_DOWNARROW, false );
	Key_Event( K_LEFTARROW, false );
	Key_Event( K_RIGHTARROW, false );

}

function requestPointerLock() {

	if ( pointerLocked || isQuest || touchMode || targetElement == null ) return;

	if ( pointerLockUnavailable ) {

		// Only reached from a user gesture, which fullscreen also needs
		requestFullscreen();
		return;

	}

	if ( targetElement.requestPointerLock == null ) return;

	// Chrome returns a promise that rejects if the request is refused
	// (e.g. no user activation, or the user just pressed Escape).
	const result = targetElement.requestPointerLock();
	if ( result != null && typeof result.catch === 'function' ) result.catch( () => {} );

}

function requestFullscreen() {

	if ( isQuest ) return;

	Touch_RequestFullscreen();

}

function GP_GetPrimary() {

	if ( typeof navigator === 'undefined' || navigator.getGamepads == null ) return null;

	const gamepads = navigator.getGamepads();
	if ( ! gamepads ) return null;

	for ( const gp of gamepads ) {

		if ( gp && gp.connected ) return gp;

	}

	return null;

}

function GP_ApplyDeadzone( v, deadzone ) {

	if ( Math.abs( v ) < deadzone ) return 0;

	// Rescale so movement starts smoothly at the edge of the deadzone
	return ( v - Math.sign( v ) * deadzone ) / ( 1 - deadzone );

}

function GP_ButtonDown( gp, index ) {

	const b = gp.buttons?.[ index ];
	if ( ! b ) return false;
	return typeof b === 'object' ? !! b.pressed : !! b;

}

function GP_ButtonValue( gp, index ) {

	const b = gp.buttons?.[ index ];
	if ( ! b ) return 0;
	return typeof b === 'object' ? ( b.value ?? ( b.pressed ? 1 : 0 ) ) : ( b ? 1 : 0 );

}

function GP_KeyEdge( quakeKey, isDown, prev, storeKey ) {

	if ( quakeKey === 0 ) return;

	const wasDown = prev[ storeKey ];
	if ( isDown !== wasDown ) {

		Key_Event( quakeKey, isDown );
		prev[ storeKey ] = isDown;

	}

}

function GP_Poll( cmd ) {

	const gp = GP_GetPrimary();
	if ( ! gp ) {

		if ( _gpPrev != null ) GP_ReleaseAll();
		_gpPrev = null;
		return;

	}

	if ( _gpPrev == null || _gpPrev.index !== gp.index ) {

		_gpPrev = {
			index: gp.index,
			a: false,
			b: false,
			x: false,
			y: false,
			lb: false,
			rb: false,
			lt: false,
			rt: false,
			back: false,
			start: false,
			du: false,
			dd: false,
			dl: false,
			dr: false,
		};

	}

	// Menu navigation / global buttons
	// Standard mapping: 0 A, 1 B, 2 X, 3 Y, 4 LB, 5 RB, 6 LT, 7 RT, 8 Back, 9 Start,
	// 10 LS, 11 RS, 12-15 D-pad.
	const inMenu = key_dest === key_menu;

	// A: Enter in menu, Jump in game
	GP_KeyEdge( inMenu ? K_ENTER : K_SPACE, GP_ButtonDown( gp, 0 ), _gpPrev, 'a' );
	// B: Escape
	GP_KeyEdge( K_ESCAPE, GP_ButtonDown( gp, 1 ), _gpPrev, 'b' );
	// X: Reload (default 'r')
	GP_KeyEdge( 'r'.charCodeAt( 0 ), GP_ButtonDown( gp, 2 ), _gpPrev, 'x' );
	// Y: Toggle score (default Tab)
	GP_KeyEdge( K_TAB, GP_ButtonDown( gp, 3 ), _gpPrev, 'y' );

	// LB/RB: Shift/Ctrl (often bound to run/crouch in configs; harmless if unbound)
	GP_KeyEdge( K_SHIFT, GP_ButtonDown( gp, 4 ), _gpPrev, 'lb' );
	GP_KeyEdge( K_CTRL, GP_ButtonDown( gp, 5 ), _gpPrev, 'rb' );

	// Triggers: jump/attack (in-game), Enter/attack (menu)
	const ltDown = GP_ButtonValue( gp, 6 ) > 0.5;
	const rtDown = GP_ButtonValue( gp, 7 ) > 0.5;
	GP_KeyEdge( inMenu ? K_ENTER : K_SPACE, ltDown, _gpPrev, 'lt' );
	GP_KeyEdge( K_MOUSE1, rtDown, _gpPrev, 'rt' );

	// Back/Start: Escape
	GP_KeyEdge( K_ESCAPE, GP_ButtonDown( gp, 8 ), _gpPrev, 'back' );
	GP_KeyEdge( K_ESCAPE, GP_ButtonDown( gp, 9 ), _gpPrev, 'start' );

	// D-pad: arrow keys
	GP_KeyEdge( K_UPARROW, GP_ButtonDown( gp, 12 ), _gpPrev, 'du' );
	GP_KeyEdge( K_DOWNARROW, GP_ButtonDown( gp, 13 ), _gpPrev, 'dd' );
	GP_KeyEdge( K_LEFTARROW, GP_ButtonDown( gp, 14 ), _gpPrev, 'dl' );
	GP_KeyEdge( K_RIGHTARROW, GP_ButtonDown( gp, 15 ), _gpPrev, 'dr' );

	// Gameplay movement/look (skip in menus; skip when cmd is missing)
	if ( ! cmd || key_dest !== key_game || cls.demoplayback ) return;

	const moveDeadzone = 0.15;
	const lookDeadzone = 0.12;

	const lx = GP_ApplyDeadzone( gp.axes?.[ 0 ] ?? 0, moveDeadzone );
	const ly = GP_ApplyDeadzone( gp.axes?.[ 1 ] ?? 0, moveDeadzone );
	const rx = GP_ApplyDeadzone( gp.axes?.[ 2 ] ?? 0, lookDeadzone );
	const ry = GP_ApplyDeadzone( gp.axes?.[ 3 ] ?? 0, lookDeadzone );

	// Left stick → movement
	cmd.forwardmove -= cl_forwardspeed.value * ly;
	cmd.sidemove += cl_sidespeed.value * lx;

	// Right stick → look (yaw + pitch), always active (no pointer lock required)
	if ( rx !== 0 ) {

		cl.viewangles[ YAW ] -= rx * cl_yawspeed.value * host_frametime * gp_look_yaw.value;

	}

	if ( ry !== 0 ) {

		V_StopPitchDrift();
		cl.viewangles[ PITCH ] += ry * cl_pitchspeed.value * host_frametime * gp_look_pitch.value;
		if ( cl.viewangles[ PITCH ] > 80 )
			cl.viewangles[ PITCH ] = 80;
		if ( cl.viewangles[ PITCH ] < - 70 )
			cl.viewangles[ PITCH ] = - 70;

	}

}

// cvars (matching in_win.c)
const m_filter = { name: 'm_filter', string: '0', value: 0 };
// Gamepad look tuning (standard mapping right stick).
// Defaults keep yaw/pitch even and slower than the prior hardcoded multiplier.
const gp_look_yaw = { name: 'gp_look_yaw', string: '1', value: 1 };
const gp_look_pitch = { name: 'gp_look_pitch', string: '1', value: 1 };
// XR turning: 0 = smooth turn with the right stick, otherwise snap by this many degrees
const xr_snapturn = { name: 'xr_snapturn', string: '0', value: 0, archive: true };
// XR smooth-turn rate at full stick deflection, degrees per second (was a fixed 2 * cl_yawspeed, 280 at its default of 140)
const xr_turnspeed = { name: 'xr_turnspeed', string: '280', value: 280, archive: true };

let in_initialized = false;

/*
===========================================================================

			STATE CLEARING (vid_win.c ClearAllStates / in_win.c IN_ClearStates)

===========================================================================
*/

/*
===================
IN_ClearStates
===================
*/
function IN_ClearStates() {

	mx_accum = 0;
	my_accum = 0;
	old_mouse_x = 0;
	old_mouse_y = 0;
	mouse_buttonstate = 0;

}

/*
================
IN_ClearAllStates

Called when the page loses focus, is hidden, or loses pointer lock.
vid_win.c ClearAllStates: send an up event for each key, to make sure
the server clears them all, then clear key and mouse state.
================
*/
export function IN_ClearAllStates() {

	for ( let i = 0; i < 256; i ++ ) {

		Key_Event( i, false );

	}

	Key_ClearStates();
	IN_ClearStates();

	keyForCode.clear();

	// Touch buttons and XR commands bypass Key_Event, release them too.
	// The loop above already sent the XR keys up.
	Touch_ReleaseButtons();
	IN_XR_ReleaseAll( false );

	// The gamepad edge state now matches "everything up"
	_gpPrev = null;

}

/*
===========================================================================

			BROWSER EVENT HANDLERS

===========================================================================
*/

function mapBrowserKeyToQuake( event ) {

	// First check code-based mapping (physical key location)
	if ( codeToQuakeKey[ event.code ] !== undefined ) {

		return codeToQuakeKey[ event.code ];

	}

	// For letter keys, map by code (e.g. 'KeyA' -> 97 'a')
	if ( event.code && event.code.startsWith( 'Key' ) && event.code.length === 4 ) {

		return event.code.charCodeAt( 3 ) + 32; // 'A'(65) + 32 = 'a'(97)

	}

	// For digit keys
	if ( event.code && event.code.startsWith( 'Digit' ) && event.code.length === 6 ) {

		return event.code.charCodeAt( 5 ); // '0'-'9' ascii

	}

	// Punctuation and other keys - use the key value, but only printable
	// ASCII: 128-255 are Quake's special keys (arrows, F-keys, K_PAUSE...)
	if ( event.key && event.key.length === 1 ) {

		const code = event.key.charCodeAt( 0 );
		if ( code >= 32 && code <= 126 ) {

			// Lowercase letters for quake
			if ( code >= 65 && code <= 90 )
				return code + 32;
			return code;

		}

	}

	// Non-ASCII character or dead key on a punctuation key: fall back to
	// the US character for that physical key
	const usChar = codeToUSChar[ event.code ];
	if ( usChar !== undefined ) {

		return usChar.charCodeAt( 0 );

	}

	return 0;

}

function isEditableTarget( target ) {

	if ( target == null ) return false;
	if ( target.isContentEditable ) return true;
	const tag = target.tagName;
	return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

}

function isMetaKey( event ) {

	return event.code === 'MetaLeft' || event.code === 'MetaRight' ||
		event.code === 'OSLeft' || event.code === 'OSRight' || event.key === 'Meta';

}

// Ctrl+Shift+I/J/C and Cmd+Opt+I/J/C open the developer tools: keep them working
function isDevToolsShortcut( event ) {

	const c = event.code;
	if ( c !== 'KeyI' && c !== 'KeyJ' && c !== 'KeyC' ) return false;
	return ( event.ctrlKey && event.shiftKey ) || ( event.metaKey && event.altKey );

}

/*
Which keys keep their browser behaviour.

Always the browser's:
- Escape (leaves pointer lock and fullscreen), F12 and the developer tools
  shortcuts (Ctrl+Shift+I/J/C, Cmd+Opt+I/J/C).
- Cmd/Meta shortcuts, except while pointer lock is held in game.
- Ctrl/Alt chords on keys that map to nothing in Quake.

Ctrl is +attack and Alt is +strafe by default, so a chord such as Ctrl+W, Ctrl+R
or Alt+D is also a game key. Every chord is sent to the game. The browser's own
action is suppressed only while the game owns the keyboard (key_dest is
key_game and we hold pointer lock or fullscreen), so Ctrl+R or Ctrl+S cannot
reload the page or open a dialog in the middle of a fight. In the menu, the
console and with the mouse released the browser keeps its shortcuts (Ctrl+R,
Ctrl+-, Ctrl+F, Alt+Left...). Plain mapped keys (F1-F11, Tab, Space, Backspace,
arrows, '/' and '\'' for Firefox quick find) are always the game's.

Cannot be overridden by any page: Ctrl+W, Ctrl+T, Ctrl+N, Ctrl+Tab, Ctrl+Shift+W/T/N
and Cmd+Q/W/T/N (reserved by Chrome, Firefox and Safari, and no keydown is
delivered or preventDefault is ignored), Cmd+Tab, Alt+Tab, Alt+F4 and the OS
shortcuts. Only the Keyboard Lock API can capture the first group, and Chrome
and Edge allow it only while the page is fullscreen (Firefox and Safari have no
keyboard lock). We request it for the keys we map, except Escape, when we hold
pointer lock or fullscreen. Elsewhere a reserved shortcut takes focus away
and the blur and visibility handlers release every key.
*/
function gameOwnsKeyboard() {

	if ( key_dest !== key_game ) return false;
	if ( pointerLocked ) return true;
	return typeof document !== 'undefined' &&
		( document.fullscreenElement != null || document.webkitFullscreenElement != null );

}

function shouldPreventDefault( event, qkey ) {

	if ( event.code === 'Escape' || event.code === 'F12' ) return false;
	if ( isDevToolsShortcut( event ) ) return false;
	if ( event.metaKey ) return pointerLocked;
	if ( event.ctrlKey || event.altKey ) return qkey !== 0 && gameOwnsKeyboard();
	return qkey !== 0;

}

// Every physical key the game maps, except Escape (the way out of a lock) and
// F11/F12 (fullscreen toggle, developer tools)
function lockableCodes() {

	const codes = new Set( Object.keys( codeToQuakeKey ) );
	for ( let c = 65; c <= 90; c ++ ) codes.add( 'Key' + String.fromCharCode( c ) );
	for ( let c = 0; c <= 9; c ++ ) codes.add( 'Digit' + c );
	for ( const code in codeToUSChar ) codes.add( code );
	codes.delete( 'Escape' );
	codes.delete( 'F11' );
	codes.delete( 'F12' );
	return [ ...codes ];

}

// Best effort: Chrome and Edge only honour this in fullscreen
let keyboardLocked = false;

function updateKeyboardLock() {

	if ( typeof navigator === 'undefined' || navigator.keyboard == null ) return;

	const want = in_initialized && ! isQuest && key_dest === key_game && gameOwnsKeyboard();
	if ( want === keyboardLocked ) return;
	keyboardLocked = want;

	try {

		let result = null;
		if ( want ) {

			result = navigator.keyboard.lock( lockableCodes() );

		} else {

			navigator.keyboard.unlock();

		}

		// A refused lock (Chrome outside fullscreen) must be retried on the next change
		if ( want && result != null && typeof result.catch === 'function' ) {

			result.catch( () => { if ( keyboardLocked ) keyboardLocked = false; } );

		}

	} catch {

		// Unsupported or refused: shortcuts keep their browser behaviour
		keyboardLocked = false;

	}

}

function handleKeyDown( event ) {

	if ( ! in_initialized ) return;
	if ( isEditableTarget( event.target ) ) return;

	// Unlock audio on first user gesture
	S_UnlockAudio();

	// macOS does not send keyup for keys released while Cmd is held, so
	// anything down when Cmd goes down could stick. Cmd is not a Quake key.
	if ( isMetaKey( event ) ) {

		IN_ClearAllStates();
		return;

	}

	// Cmd+key is a browser/OS shortcut: don't press the key in the game
	if ( event.metaKey ) {

		if ( shouldPreventDefault( event, 0 ) ) event.preventDefault();
		return;

	}

	const prevKeyDest = key_dest;

	// Autorepeat keeps sending the key that went down; a fresh press of a key
	// we think is still down (lost keyup) releases the old mapping first
	let qkey = 0;
	const held = keyForCode.get( event.code );
	if ( held !== undefined && event.repeat ) {

		qkey = held;

	} else {

		qkey = mapBrowserKeyToQuake( event );
		if ( held !== undefined && held !== qkey ) Key_Event( held, false );
		if ( event.code ) {

			if ( qkey ) keyForCode.set( event.code, qkey );
			else keyForCode.delete( event.code );

		}

	}

	if ( qkey ) {

		Key_Event( qkey, true );

	}

	// Request pointer lock when transitioning into game (e.g. selecting "New Game")
	// This works because we're inside a user gesture (keydown event)
	// Only do this when actually playing, not during demo playback
	if ( key_dest === key_game && prevKeyDest !== key_game && ! cls.demoplayback ) {

		if ( touchMode ) {

			Touch_Enable();
			mouseactive = true;

		} else {

			requestPointerLock();

		}

	}

	if ( shouldPreventDefault( event, qkey ) ) {

		event.preventDefault();

	}

	// The menu may have opened or closed
	updateKeyboardLock();

}

function handleKeyUp( event ) {

	if ( ! in_initialized ) return;
	if ( isEditableTarget( event.target ) ) return;
	if ( isMetaKey( event ) ) return;

	let qkey = keyForCode.get( event.code );
	if ( qkey !== undefined ) {

		keyForCode.delete( event.code );

	} else {

		// Pressed with Cmd held, or before we were listening
		if ( event.metaKey ) return;
		qkey = mapBrowserKeyToQuake( event );

	}

	if ( qkey ) {

		Key_Event( qkey, false );

	}

	// Alt keyup shows the menu bar in Firefox on Windows
	if ( shouldPreventDefault( event, qkey ) ) {

		event.preventDefault();

	}

}

function handleMouseMove( event ) {

	if ( ! in_initialized || ! mouseactive ) return;

	// Pointer Lock API gives us movementX/Y directly
	mx_accum += event.movementX || 0;
	my_accum += event.movementY || 0;

}

function mouseButtonToKey( button ) {

	switch ( button ) {

		case 0: return K_MOUSE1;
		case 2: return K_MOUSE2;
		case 1: return K_MOUSE3;
		default: return 0;

	}

}

// Element whose box the 2D menu is drawn into
function IN_GetMenuSurface() {

	return Draw_GetOverlayCanvas() || targetElement;

}

function handleMouseDown( event ) {

	if ( ! in_initialized ) return;

	// Back/forward buttons would navigate away from the game
	if ( event.button === 3 || event.button === 4 ) {

		event.preventDefault();
		return;

	}

	// Unlock audio on first user gesture
	S_UnlockAudio();

	const qkey = mouseButtonToKey( event.button );
	if ( qkey === 0 ) return;

	// Handle mouse clicks in the menu
	if ( key_dest === key_menu && event.button === 0 ) {

		// Get click position relative to the menu surface
		const rect = IN_GetMenuSurface().getBoundingClientRect();
		const x = event.clientX - rect.left;
		const y = event.clientY - rect.top;

		M_TouchInput( x, y, rect.width, rect.height );
		return;

	}

	// During demo playback, click to show menu
	if ( key_dest === key_game && cls.demoplayback && event.button === 0 ) {

		M_TouchInput( 0, 0, 1, 1 ); // Coordinates don't matter, just triggers menu toggle
		return;

	}

	// In touch mode this is the compatibility mousedown that follows a tap:
	// request fullscreen + landscape and enable touch controls.
	// Only when actually playing, not during demo playback
	if ( touchMode ) {

		// Request fullscreen only when actually playing a map (not menu, demo, or idle state)
		if ( key_dest === key_game && cls.state === ca_connected && ! cls.demoplayback ) {

			requestFullscreen();

		}

		if ( key_dest === key_game && ! cls.demoplayback && ! Touch_IsEnabled() ) {

			Touch_Enable();
			mouseactive = true;

		}

	} else {

		// Request pointer lock only when in-game (not menu/console or demos)
		if ( key_dest === key_game && ! cls.demoplayback ) {

			requestPointerLock();

		}

	}

	mouse_buttonstate |= 1 << ( qkey - K_MOUSE1 );
	Key_Event( qkey, true );

}

// Bound on window so a button released outside the canvas is still seen
function handleMouseUp( event ) {

	if ( ! in_initialized ) return;

	if ( event.button === 3 || event.button === 4 ) {

		event.preventDefault();
		return;

	}

	const qkey = mouseButtonToKey( event.button );
	if ( qkey === 0 ) return;

	const bit = 1 << ( qkey - K_MOUSE1 );
	if ( ( mouse_buttonstate & bit ) === 0 ) return; // went down in a menu, or before a clear

	mouse_buttonstate &= ~ bit;
	Key_Event( qkey, false );

}

function handleWheel( event ) {

	if ( ! in_initialized ) return;

	// Stop page scrolling and Ctrl+wheel page zoom
	event.preventDefault();

	if ( event.deltaY < 0 ) {

		Key_Event( K_MWHEELUP, true );
		Key_Event( K_MWHEELUP, false );

	} else if ( event.deltaY > 0 ) {

		Key_Event( K_MWHEELDOWN, true );
		Key_Event( K_MWHEELDOWN, false );

	}

}

function handlePointerLockChange() {

	const wasLocked = pointerLocked;
	pointerLocked = document.pointerLockElement === targetElement;

	if ( pointerLocked ) {

		pointerLockWorked = true;
		mouseactive = true;

	} else {

		mouseactive = touchMode && Touch_IsEnabled();

		// Unless we dropped the lock ourselves to switch to touch controls
		// (IN_SetTouchMode has already cleared the keys)
		if ( wasLocked && ! suppressLockEscape ) {

			// Focus moved away from the game (Escape, alt-tab, a browser
			// dialog): nothing may stay held, as on Win32 focus loss
			IN_ClearAllStates();

			// Show the menu when pointer lock is lost while in-game
			if ( key_dest === key_game ) {

				Key_Event( K_ESCAPE, true );
				Key_Event( K_ESCAPE, false );

			}

		}

		suppressLockEscape = false;

	}

	updateKeyboardLock();

}

// See pointerLockUnavailable. The error follows the request within the
// click's user activation, so fullscreen can still be requested here.
function handlePointerLockError() {

	if ( pointerLockWorked || touchMode ) return;

	pointerLockRefusals ++;
	if ( pointerLockRefusals < 2 ) return;

	pointerLockUnavailable = true;
	requestFullscreen();

}

function handleContextMenu( event ) {

	event.preventDefault();

}

function handleBlur() {

	if ( ! in_initialized ) return;

	IN_ClearAllStates();

}

// gl_vidnt.c AppActivate: enable/disable sound on focus gain/loss. The port
// uses page visibility rather than window focus, so sound keeps playing while
// another window is in front but stops when the tab is hidden. C starts
// sound_active false and unblocks on the first activation, which drives the
// wave-out snd_blocked to -1; the port starts it true instead.
let sound_active = true;

export function IN_SoundActivate( active ) {

	if ( active === false && sound_active === true ) {

		S_BlockSound();
		sound_active = false;

	} else if ( active === true && sound_active === false ) {

		S_UnblockSound();
		sound_active = true;

	}

}

function handleVisibilityChange() {

	if ( ! in_initialized ) return;

	if ( document.visibilityState === 'hidden' ) {

		IN_ClearAllStates();

	}

	IN_SoundActivate( document.visibilityState !== 'hidden' );

}

function IN_InitTouch() {

	// Always append touch UI to document.body for consistent positioning
	Touch_Init( document.body );
	Touch_SetMenuCallback( M_TouchInput, IN_GetMenuSurface );

}

/*
===========
IN_SetTouchMode

Switch between touch controls and mouse/pointer-lock controls.
===========
*/
function IN_SetTouchMode( on ) {

	if ( on === touchMode ) return;

	touchMode = on;

	if ( on ) {

		// Leaving pointer lock to use the touchscreen is not a pause. Clear
		// what the mouse held now: the lock change arrives later, when a
		// finger may already be on the touch controls.
		if ( pointerLocked && document.exitPointerLock ) {

			IN_ClearAllStates();
			suppressLockEscape = true;
			document.exitPointerLock();

		}

		IN_InitTouch();

		// IN_UpdateTouch shows the right overlay on the next frame

	} else {

		if ( Touch_IsEnabled() ) Touch_Disable();
		Touch_HideMenu();
		Touch_HideSysBar();
		mouseactive = pointerLocked;

	}

}

// Decide touch vs mouse per input event (IN-2)
function handlePointerDown( event ) {

	if ( ! in_initialized ) return;

	if ( event.pointerType === 'touch' || event.pointerType === 'pen' ) {

		IN_SetTouchMode( true );

	} else if ( event.pointerType === 'mouse' ) {

		IN_SetTouchMode( false );

	}

}

function handlePointerMove( event ) {

	if ( ! in_initialized || ! touchMode ) return;

	if ( event.pointerType === 'mouse' && ( event.movementX || event.movementY ) ) {

		IN_SetTouchMode( false );

	}

}

function handleTouchStart( event ) {

	if ( ! in_initialized ) return;

	// Unlock audio on first user gesture
	S_UnlockAudio();

	// During demo playback, tap to show menu
	if ( key_dest === key_game && cls.demoplayback ) {

		event.preventDefault();
		M_TouchInput( 0, 0, 1, 1 ); // Coordinates don't matter, just triggers menu toggle

	}

}

// touchend is a user activation (touchstart is not in Chrome), so request
// fullscreen here. Only when actually playing a map.
function handleTouchEnd() {

	if ( ! in_initialized ) return;

	if ( touchMode && key_dest === key_game && cls.state === ca_connected && ! cls.demoplayback ) {

		requestFullscreen();

	}

}

/*
===========================================================================

			PUBLIC API (matching in_win.c interface)

===========================================================================
*/

/*
===========
IN_Init
===========
*/
export function IN_Init( element ) {

	targetElement = element || document.body;
	eventWindow = typeof window !== 'undefined' ? window : targetElement;

	// Build key mapping (deferred from module scope to avoid circular dep in Deno)
	codeToQuakeKey = {
		'Tab': K_TAB,
		'Enter': K_ENTER,
		'Escape': K_ESCAPE,
		'Space': K_SPACE,
		'Backspace': K_BACKSPACE,
		'ArrowUp': K_UPARROW,
		'ArrowDown': K_DOWNARROW,
		'ArrowLeft': K_LEFTARROW,
		'ArrowRight': K_RIGHTARROW,
		'AltLeft': K_ALT,
		'AltRight': K_ALT,
		'ControlLeft': K_CTRL,
		'ControlRight': K_CTRL,
		'ShiftLeft': K_SHIFT,
		'ShiftRight': K_SHIFT,
		'F1': K_F1,
		'F2': K_F2,
		'F3': K_F3,
		'F4': K_F4,
		'F5': K_F5,
		'F6': K_F6,
		'F7': K_F7,
		'F8': K_F8,
		'F9': K_F9,
		'F10': K_F10,
		'F11': K_F11,
		'F12': K_F12,
		'Insert': K_INS,
		'Delete': K_DEL,
		'PageDown': K_PGDN,
		'PageUp': K_PGUP,
		'Home': K_HOME,
		'End': K_END,
		'Pause': K_PAUSE,
		// Numpad, exactly as WinQuake vid_win.c scantokey[] maps scancodes 0x47-0x53
		// (7/8/9 Home/Up/PgUp, 4/6 Left/Right, 1/2/3 End/Down/PgDn, 0 Ins, . Del),
		// 0x4A/0x4E/0x4C as '-', '+', '5', extended 0x1C as Enter, 0x35/0x37 as '/', '*'.
		// NumLock state is ignored, as in WinQuake. keys.h has no K_KP_* codes, so
		// the numpad shares keys and bind names with the arrows and nav cluster.
		'Numpad7': K_HOME,
		'Numpad8': K_UPARROW,
		'Numpad9': K_PGUP,
		'NumpadSubtract': 45, // '-'
		'Numpad4': K_LEFTARROW,
		'Numpad5': 53, // '5'
		'Numpad6': K_RIGHTARROW,
		'NumpadAdd': 43, // '+'
		'Numpad1': K_END,
		'Numpad2': K_DOWNARROW,
		'Numpad3': K_PGDN,
		'Numpad0': K_INS,
		'NumpadDecimal': K_DEL,
		'NumpadEnter': K_ENTER,
		'NumpadDivide': 47, // '/'
		'NumpadMultiply': 42, // '*'
	};

	// Register cvars
	Cvar_RegisterVariable( m_filter );
	Cvar_RegisterVariable( gp_look_yaw );
	Cvar_RegisterVariable( gp_look_pitch );
	Cvar_RegisterVariable( xr_snapturn );
	Cvar_RegisterVariable( xr_turnspeed );
	Touch_RegisterCvars();

	// Register commands
	Cmd_AddCommand( 'force_centerview', IN_ForceCenterView );

	// Set up event listeners
	document.addEventListener( 'keydown', handleKeyDown );
	document.addEventListener( 'keyup', handleKeyUp );

	targetElement.addEventListener( 'mousemove', handleMouseMove );
	targetElement.addEventListener( 'mousedown', handleMouseDown );
	eventWindow.addEventListener( 'mouseup', handleMouseUp );
	targetElement.addEventListener( 'wheel', handleWheel, { passive: false } );
	targetElement.addEventListener( 'contextmenu', handleContextMenu );

	pointerLockWorked = false;
	pointerLockRefusals = 0;
	pointerLockUnavailable = false;
	document.addEventListener( 'pointerlockchange', handlePointerLockChange );
	document.addEventListener( 'pointerlockerror', handlePointerLockError );
	document.addEventListener( 'fullscreenchange', updateKeyboardLock );
	document.addEventListener( 'webkitfullscreenchange', updateKeyboardLock );

	// Pointer type decides touch vs mouse controls; capture so overlays can't hide it
	document.addEventListener( 'pointerdown', handlePointerDown, true );
	document.addEventListener( 'pointermove', handlePointerMove, true );

	// Add global touch handler for showing menu during demos
	targetElement.addEventListener( 'touchstart', handleTouchStart, { passive: false } );
	targetElement.addEventListener( 'touchend', handleTouchEnd );

	// Focus loss: release everything (vid_win.c AppActivate -> ClearAllStates)
	eventWindow.addEventListener( 'blur', handleBlur );
	document.addEventListener( 'visibilitychange', handleVisibilityChange );

	// Initialize touch controls. Start in touch mode only on touch-first
	// devices; touchscreen laptops start with the mouse and switch on touch.
	const ua = typeof navigator !== 'undefined' ? ( navigator.userAgent || '' ) : '';
	isQuest = /OculusBrowser|Quest/i.test( ua );
	const touchCapable = Touch_IsTouchCapable();
	touchMode = Touch_IsMobile();

	if ( touchCapable || touchMode ) {

		IN_InitTouch();
		if ( touchMode ) Con_Printf( 'Mobile device detected - touch controls available\n' );

	}

	XR_SetSessionEndCallback( IN_XR_ReleaseAll );

	in_initialized = true;

	// a page opened in a background tab starts blocked
	if ( document.visibilityState === 'hidden' )
		IN_SoundActivate( false );

	Con_Printf( 'Browser input initialized\n' );

}

/*
===========
IN_Shutdown
===========
*/
export function IN_Shutdown() {

	if ( ! in_initialized ) return;

	document.removeEventListener( 'keydown', handleKeyDown );
	document.removeEventListener( 'keyup', handleKeyUp );

	if ( targetElement ) {

		targetElement.removeEventListener( 'mousemove', handleMouseMove );
		targetElement.removeEventListener( 'mousedown', handleMouseDown );
		targetElement.removeEventListener( 'wheel', handleWheel, { passive: false } );
		targetElement.removeEventListener( 'contextmenu', handleContextMenu );
		targetElement.removeEventListener( 'touchstart', handleTouchStart, { passive: false } );
		targetElement.removeEventListener( 'touchend', handleTouchEnd );

	}

	if ( eventWindow ) {

		eventWindow.removeEventListener( 'mouseup', handleMouseUp );
		eventWindow.removeEventListener( 'blur', handleBlur );

	}

	document.removeEventListener( 'pointerlockchange', handlePointerLockChange );
	document.removeEventListener( 'pointerlockerror', handlePointerLockError );
	document.removeEventListener( 'fullscreenchange', updateKeyboardLock );
	document.removeEventListener( 'webkitfullscreenchange', updateKeyboardLock );
	document.removeEventListener( 'pointerdown', handlePointerDown, true );
	document.removeEventListener( 'pointermove', handlePointerMove, true );
	document.removeEventListener( 'visibilitychange', handleVisibilityChange );

	if ( pointerLocked && document.exitPointerLock ) {

		document.exitPointerLock();

	}

	XR_SetSessionEndCallback( null );

	mouseactive = false;
	in_initialized = false;
	updateKeyboardLock();

}

/*
===========
IN_Commands

in_win.c reads joystick buttons here. The browser port polls XR controller
buttons, which must work in menus too (IN_Move only runs once signed on).
===========
*/
export function IN_Commands() {

	if ( ! in_initialized ) return;

	if ( isXRActive() ) {

		XR_PollInput();
		XR_UpdateHUD();
		IN_XR_Buttons();

	}

}

/*
===========
IN_XR_KeyEdge

Press quakeKey when the button goes down; release the key that was pressed
when it goes up.
===========
*/
function IN_XR_KeyHeldByOther( slot, quakeKey ) {

	for ( const other in _xrKeys ) {

		if ( other !== slot && _xrKeys[ other ] === quakeKey ) return true;

	}

	return false;

}

function IN_XR_KeyEdge( slot, isDown, quakeKey ) {

	const held = _xrKeys[ slot ];

	if ( isDown && held === 0 ) {

		_xrKeys[ slot ] = quakeKey !== 0 ? quakeKey : - 1;
		if ( quakeKey !== 0 && ! IN_XR_KeyHeldByOther( slot, quakeKey ) ) Key_Event( quakeKey, true );

	} else if ( ! isDown && held !== 0 ) {

		_xrKeys[ slot ] = 0;
		if ( held > 0 && ! IN_XR_KeyHeldByOther( slot, held ) ) Key_Event( held, false );

	}

}

// Stick direction as a button, with hysteresis
function IN_XR_StickDown( slot, value ) {

	return _xrKeys[ slot ] !== 0 ? value > 0.3 : value > 0.6;

}

/*
===========
IN_XR_Buttons

Game:    right trigger attack, left trigger / A jump, B next weapon,
         X previous weapon, either grip +use, Y menu.
Menu:    either stick navigates, trigger / A select, B / Y back.
Demo:    trigger, A, B or Y opens the menu.
Console: B / Y opens the menu.
Exported for tests; IN_Commands calls it while XR is active.
===========
*/
export function IN_XR_Buttons() {

	const inGame = key_dest === key_game && ! cls.demoplayback;
	const inMenu = key_dest === key_menu;
	const inDemo = key_dest === key_game && cls.demoplayback;

	const leftDown = xrInput.leftTrigger > 0.5;
	const rightDown = xrInput.rightTrigger > 0.5;

	let selectKey = 0;
	if ( inMenu ) selectKey = K_ENTER;
	else if ( inDemo ) selectKey = K_ESCAPE;

	IN_XR_KeyEdge( 'rightTrigger', rightDown, inGame ? K_MOUSE1 : selectKey );
	IN_XR_KeyEdge( 'leftTrigger', leftDown, inGame ? K_SPACE : selectKey );
	IN_XR_KeyEdge( 'a', xrInput.buttonA, inGame ? K_SPACE : selectKey );
	IN_XR_KeyEdge( 'b', xrInput.buttonB, inGame ? 0 : K_ESCAPE );
	IN_XR_KeyEdge( 'y', xrInput.buttonY, K_ESCAPE );

	// Weapon switch: impulse 10 / 12 (cycle next / previous)
	if ( inGame && xrInput.buttonB && ! _xrWeaponNext ) Cbuf_AddText( 'impulse 10\n' );
	_xrWeaponNext = xrInput.buttonB;
	if ( inGame && xrInput.buttonX && ! _xrWeaponPrev ) Cbuf_AddText( 'impulse 12\n' );
	_xrWeaponPrev = xrInput.buttonX;

	// +use on either grip
	const useDown = inGame && ( xrInput.leftSqueeze || xrInput.rightSqueeze );
	if ( useDown !== _xrUseHeld ) {

		Cbuf_AddText( useDown ? '+use\n' : '-use\n' );
		_xrUseHeld = useDown;

	}

	// Menu navigation with either stick (stick Y is negative when pushed forward)
	const sx = Math.abs( xrInput.moveX ) > Math.abs( xrInput.lookX ) ? xrInput.moveX : xrInput.lookX;
	const sy = Math.abs( xrInput.moveY ) > Math.abs( xrInput.lookY ) ? xrInput.moveY : xrInput.lookY;
	IN_XR_KeyEdge( 'up', inMenu && IN_XR_StickDown( 'up', - sy ), K_UPARROW );
	IN_XR_KeyEdge( 'down', inMenu && IN_XR_StickDown( 'down', sy ), K_DOWNARROW );
	IN_XR_KeyEdge( 'left', inMenu && IN_XR_StickDown( 'left', - sx ), K_LEFTARROW );
	IN_XR_KeyEdge( 'right', inMenu && IN_XR_StickDown( 'right', sx ), K_RIGHTARROW );

}

/*
===========
IN_XR_ReleaseAll

Release everything the XR controllers hold. Called when the XR session ends
(webxr.js) and on focus loss.
===========
*/
function IN_XR_ReleaseAll( sendKeyUps = true ) {

	for ( const slot in _xrKeys ) {

		const held = _xrKeys[ slot ];
		if ( held !== 0 ) {

			_xrKeys[ slot ] = 0;
			if ( sendKeyUps && held > 0 && ! IN_XR_KeyHeldByOther( slot, held ) ) Key_Event( held, false );

		}

	}

	if ( _xrUseHeld ) {

		Cbuf_AddText( '-use\n' );
		_xrUseHeld = false;

	}

	_xrWeaponNext = false;
	_xrWeaponPrev = false;
	_xrSnapArmed = true;

}

/*
===========
IN_ForceCenterView
===========
*/
function IN_ForceCenterView() {

	// cl.viewangles[PITCH] = 0 -- set by the caller
	// In browser, we just need to reset accumulated mouse

}

/*
===========
IN_MouseMove

Called every frame to get mouse movement.
Returns accumulated movement since last call.
===========
*/
export function IN_MouseMove() {

	if ( ! mouseactive ) {

		_mouseMove.mx = 0;
		_mouseMove.my = 0;
		return _mouseMove;

	}

	const currentMx = mx_accum;
	const currentMy = my_accum;

	mx_accum = 0;
	my_accum = 0;

	if ( m_filter.value ) {

		// average with last frame for smoothing
		mouse_x = ( currentMx + old_mouse_x ) * 0.5;
		mouse_y = ( currentMy + old_mouse_y ) * 0.5;

	} else {

		mouse_x = currentMx;
		mouse_y = currentMy;

	}

	old_mouse_x = currentMx;
	old_mouse_y = currentMy;

	mouse_x *= sensitivity.value;
	mouse_y *= sensitivity.value;

	_mouseMove.mx = mouse_x;
	_mouseMove.my = mouse_y;
	return _mouseMove;

}

/*
===========
IN_Move

Process all input movement for the current frame.
In the original, this called IN_MouseMove and IN_JoyMove.
===========
*/
export function IN_Move( cmd ) {

	const mouseMove = IN_MouseMove();
	const mx = mouseMove.mx;
	const my = mouseMove.my;

	if ( ! cmd ) return;

	// Add touch input - touch look (drag and gyro, in degrees) directly
	// controls view angles (bypasses mlook checks). Its speed is
	// touch_sensitivity / touch_gyro_sensitivity; a negative m_pitch
	// ("Invert Mouse") inverts it too.
	if ( Touch_IsEnabled() ) {

		const touchLook = Touch_GetLookDelta();

		if ( touchLook.yaw !== 0 || touchLook.pitch !== 0 ) {

			cl.viewangles[ YAW ] += touchLook.yaw;

			cl.viewangles[ PITCH ] += m_pitch.value < 0 ? - touchLook.pitch : touchLook.pitch;
			if ( touchLook.pitch !== 0 ) V_StopPitchDrift();
			if ( cl.viewangles[ PITCH ] > 80 )
				cl.viewangles[ PITCH ] = 80;
			if ( cl.viewangles[ PITCH ] < - 70 )
				cl.viewangles[ PITCH ] = - 70;

		}

		// Add touch joystick movement. Past the run threshold the stick
		// acts like +speed (cl_movespeedkey), unless +speed is already held
		// (CL_BaseMove has then scaled the keyboard part, not ours).
		const touchMove = Touch_GetMoveInput();
		const speed = ( touchMove.run || ( in_speed.state & 1 ) ) ? cl_movespeedkey.value : 1;
		const forwardspeed = touchMove.forward >= 0 ? cl_forwardspeed.value : cl_backspeed.value;

		cmd.forwardmove += forwardspeed * touchMove.forward * speed;
		cmd.sidemove += cl_sidespeed.value * touchMove.right * speed;

	}

	// add mouse X/Y movement to cmd (from in_win.c IN_MouseMove)
	if ( ( in_strafe.state & 1 ) || ( lookstrafe.value && ( in_mlook.state & 1 ) ) )
		cmd.sidemove += m_side.value * mx;
	else
		cl.viewangles[ YAW ] -= m_yaw.value * mx;

	if ( in_mlook.state & 1 )
		V_StopPitchDrift();

	if ( ( in_mlook.state & 1 ) && ! ( in_strafe.state & 1 ) ) {

		cl.viewangles[ PITCH ] += m_pitch.value * my;
		if ( cl.viewangles[ PITCH ] > 80 )
			cl.viewangles[ PITCH ] = 80;
		if ( cl.viewangles[ PITCH ] < - 70 )
			cl.viewangles[ PITCH ] = - 70;

	} else {

		cmd.forwardmove -= m_forward.value * my;

	}

	// XR controller movement (polled in IN_Commands this frame; buttons are
	// handled there). Only while actually playing.
	if ( isXRActive() ) {

		if ( key_dest === key_game && ! cls.demoplayback ) IN_XR_Move( cmd );

	} else {

		// Standard Gamepad API input (non-XR)
		GP_Poll( cmd );

	}

}

function IN_XR_Move( cmd ) {

	// Left thumbstick → movement
	// Apply deadzone to avoid drift
	const deadzone = 0.15;
	const stickX = Math.abs( xrInput.moveX ) > deadzone ? xrInput.moveX : 0;
	const stickY = Math.abs( xrInput.moveY ) > deadzone ? xrInput.moveY : 0;

	// Stick Y is negative when pushed forward
	cmd.forwardmove -= ( stickY <= 0 ? cl_forwardspeed.value : cl_backspeed.value ) * stickY;
	cmd.sidemove += cl_sidespeed.value * stickX;

	// Right thumbstick → horizontal look (yaw), smooth or snap
	const lookX = xrInput.lookX;

	if ( xr_snapturn.value > 0 ) {

		if ( Math.abs( lookX ) > 0.7 ) {

			if ( _xrSnapArmed ) {

				cl.viewangles[ YAW ] -= Math.sign( lookX ) * xr_snapturn.value;
				_xrSnapArmed = false;

			}

		} else if ( Math.abs( lookX ) < 0.3 ) {

			_xrSnapArmed = true;

		}

	} else if ( Math.abs( lookX ) > deadzone ) {

		cl.viewangles[ YAW ] -= lookX * xr_turnspeed.value * host_frametime;

	}

}

/*
===========
IN_IsPointerLocked

Helper for browser-specific pointer lock state check
===========
*/
export function IN_IsPointerLocked() {

	return pointerLocked;

}

/*
===========
IN_RequestPointerLock

Request pointer lock from a user gesture context (e.g. menu selection).
Only applies with mouse controls; touch mode uses fullscreen instead.
===========
*/
export function IN_RequestPointerLock() {

	if ( ! touchMode ) {

		requestPointerLock();

	}

}

/*
===========
IN_IsMobile

Returns true while touch controls are in use
===========
*/
export function IN_IsMobile() {

	return touchMode;

}

/*
===========
IN_UpdateTouch

Update touch control state based on key_dest.
Should be called each frame.
===========
*/
export function IN_UpdateTouch() {

	if ( ! touchMode ) return;

	Touch_Frame();

	if ( key_dest === key_game && cls.state === ca_connected && ! cls.demoplayback ) {

		// In game (not demo, actually connected) - show game controls, hide menu controls
		if ( ! Touch_IsEnabled() ) {

			Touch_Enable();
			mouseactive = true;

		}

		Touch_HideMenu();

	} else if ( key_dest === key_game && cls.demoplayback ) {

		// Demo playback - hide game controls, show menu overlay
		// Tapping calls M_TouchInput, which toggles the menu directly
		if ( Touch_IsEnabled() ) {

			Touch_Disable();
			mouseactive = false;

		}

		Touch_ShowMenu();

	} else if ( key_dest === key_menu ) {

		// In menu - hide game controls, show menu controls
		if ( Touch_IsEnabled() ) {

			Touch_Disable();
			mouseactive = false;

		}

		Touch_ShowMenu();

	} else {

		// Console or chat - hide the game controls, keep Back and the
		// on-screen keyboard button (there is no other way out or to type)
		if ( Touch_IsEnabled() ) {

			Touch_Disable();
			mouseactive = false;

		}

		Touch_HideMenu();
		Touch_ShowSysBar();

	}

}
