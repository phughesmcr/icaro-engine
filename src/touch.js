// Touch controls for mobile devices
//
// In game: a floating move stick on the left (nipplejs), drag-to-look on the
// right, FIRE and JUMP buttons that also aim while held, weapon next/prev and
// a menu button. Optional gyro aiming. Mirrored with touch_lefthanded.
// In menus and the console: tap-to-select, drag for arrow keys, and a small
// bar with Back and an on-screen keyboard button.

import { K_ESCAPE, K_UPARROW, K_DOWNARROW, K_LEFTARROW, K_RIGHTARROW, K_ENTER, K_BACKSPACE, Key_Event } from './keys.js';
import { in_attack, in_jump } from './cl_input.js';
import { S_UnlockAudio } from './snd_dma.js';
import { cvar_t, Cvar_RegisterVariable } from './cvar.js';
import { Cbuf_AddText } from './cmd.js';

/*
==============================================================================

			CVARS (archived, set from the Touch Controls menu)

==============================================================================
*/

export const touch_sensitivity = new cvar_t( 'touch_sensitivity', '1', true ); // drag look speed
export const touch_gyro = new cvar_t( 'touch_gyro', '0', true ); // gyro aiming on/off
export const touch_gyro_sensitivity = new cvar_t( 'touch_gyro_sensitivity', '1', true ); // 1 = real-world degrees
export const touch_size = new cvar_t( 'touch_size', '1', true ); // button scale
export const touch_opacity = new cvar_t( 'touch_opacity', '0.6', true );
export const touch_lefthanded = new cvar_t( 'touch_lefthanded', '0', true ); // mirror the layout
export const touch_haptics = new cvar_t( 'touch_haptics', '1', true ); // vibrate on button press (Android)

export function Touch_RegisterCvars() {

	Cvar_RegisterVariable( touch_sensitivity );
	Cvar_RegisterVariable( touch_gyro );
	Cvar_RegisterVariable( touch_gyro_sensitivity );
	Cvar_RegisterVariable( touch_size );
	Cvar_RegisterVariable( touch_opacity );
	Cvar_RegisterVariable( touch_lefthanded );
	Cvar_RegisterVariable( touch_haptics );

}

// Degrees of view rotation per CSS pixel of drag at touch_sensitivity 1
// (the same speed as before touch_sensitivity existed)
const LOOK_DEGREES_PER_PX = 0.4;

/*
==============================================================================

			STATE

==============================================================================
*/

let enabled = false;
let initialized = false;
let menuOverlay = null;
let menuTouchCallback = null;
let menuSurfaceGetter = null; // returns the element the menu is drawn into
let fullscreenActivated = false;
let fullscreenPending = false;
let wakeLock = null;
let wakeLockPending = false;

// Movement stick (nipplejs, loaded on demand from the import map)
const JOYSTICK_SIZE = 120; // px, at touch_size 1
const JOYSTICK_DEADZONE = 0.15; // fraction of the radius
const JOYSTICK_FULL = 0.9; // deflection that gives full speed (the thumb rarely reaches the rim)
let nipplejs = null;
let nippleLoad = null;
let stickManager = null;

// Look area (drag to look)
let lookTouch = null;
const lastLookPos = { x: 0, y: 0 };

// Menu touch (tap to select, drag to send arrow keys)
const MENU_DRAG_STEP = 24; // px of drag per arrow key
let menuTouch = null;
let menuDragging = false;
let menuDragAxis = 0; // 0 = undecided, 1 = horizontal, 2 = vertical
const menuTouchStart = { x: 0, y: 0 };
const menuTouchStep = { x: 0, y: 0 };

// "Rotate your device" prompt (portrait, in game). Dismissed for the session.
let portraitPrompt = null;
let portraitDismissed = false;

// Accumulated values for IN_Move
let moveForward = 0;
let moveRight = 0;
let moveRun = false;
let lookYaw = 0; // degrees, + = turn left
let lookPitch = 0; // degrees, + = look down

// Returned by the getters (no per-frame allocation)
const _moveInput = { forward: 0, right: 0, run: false };
const _lookDelta = { yaw: 0, pitch: 0 };

// Gyroscope state
let gyroListening = false;
let gyroPermission = 'unknown'; // 'unknown' | 'pending' | 'granted' | 'denied'
let gyroLastTime = - 1;

// Layout inputs last applied (re-laid out when a cvar changes)
let layoutKey = '';

// UI elements
let overlay = null;
let moveZone = null;
let lookArea = null;
let pauseButton = null;
let sysBar = null;
let backButton = null;
let keyboardButton = null;
let keyboardInput = null;

/*
Hold buttons write kbutton state directly (not via Key_Event) and aim while
held: dragging a finger that started on FIRE or JUMP turns the view, so the
player can shoot and look with one thumb. Each tracks the touches on it.
*/
const holdButtons = [];

// Tap buttons send a console command
const tapButtons = [];

// getButton returns the kbutton: cl_input.js is part of an import cycle with
// this module, so its exports can't be read while this module loads
function makeHoldButton( id, label, getButton, color ) {

	const b = { id, label, getButton, color, el: null, touches: new Set(), lastPos: new Map() };
	holdButtons.push( b );
	return b;

}

const fireButton = makeHoldButton( 'touch-fire', 'FIRE', () => in_attack, '255, 90, 90' );
const jumpButton = makeHoldButton( 'touch-jump', 'JUMP', () => in_jump, '110, 160, 255' );
const weaponNextButton = { id: 'touch-weapon-next', label: 'WPN▶', command: 'impulse 10\n', el: null };
const weaponPrevButton = { id: 'touch-weapon-prev', label: '◀', command: 'impulse 12\n', el: null };
tapButtons.push( weaponNextButton, weaponPrevButton );

/*
=================
Touch_IsMobile

True on touch-first devices: the primary pointer is coarse and there is no
fine pointer (mouse, trackpad) at all. Touchscreen laptops and tablets with a
trackpad return false; in_web.js switches to touch controls when they are
actually touched.
=================
*/
export function Touch_IsMobile() {

	if ( typeof matchMedia === 'function' ) {

		return matchMedia( '(pointer: coarse)' ).matches &&
			! matchMedia( '(any-pointer: fine)' ).matches;

	}

	if ( typeof navigator === 'undefined' ) return false;
	return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test( navigator.userAgent || '' );

}

/*
=================
Touch_IsTouchCapable

True if the device has a touchscreen at all
=================
*/
export function Touch_IsTouchCapable() {

	if ( typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0 ) return true;
	return typeof window !== 'undefined' && 'ontouchstart' in window;

}

/*
==============================================================================

			UI CREATION

==============================================================================
*/

function makeDiv( id, css ) {

	const el = document.createElement( 'div' );
	if ( id ) el.id = id;
	el.style.cssText = css;
	return el;

}

const BUTTON_CSS = `
	position: absolute;
	border-radius: 50%;
	pointer-events: auto;
	touch-action: none;
	user-select: none;
	-webkit-user-select: none;
	-webkit-touch-callout: none;
	display: flex;
	align-items: center;
	justify-content: center;
	font-family: sans-serif;
	font-weight: bold;
	color: rgba(255, 255, 255, 0.85);
	box-sizing: border-box;
`;

const SYS_BUTTON_CSS = `
	pointer-events: auto;
	touch-action: manipulation;
	user-select: none;
	-webkit-user-select: none;
	min-width: 48px;
	height: 40px;
	padding: 0 12px;
	border-radius: 8px;
	background: rgba(0, 0, 0, 0.45);
	border: 1px solid rgba(255, 255, 255, 0.35);
	color: rgba(255, 255, 255, 0.85);
	font-family: sans-serif;
	font-size: 15px;
	display: flex;
	align-items: center;
	justify-content: center;
`;

function Touch_CreateUI( container ) {

	overlay = makeDiv( 'touch-controls', `
		position: fixed;
		inset: 0;
		pointer-events: none;
		z-index: 200;
		display: none;
		touch-action: none;
		user-select: none;
		-webkit-user-select: none;
	` );

	// Move stick zone (the stick appears where the thumb lands)
	moveZone = makeDiv( 'touch-move', `
		position: absolute;
		top: 0;
		width: 45%;
		height: 100%;
		pointer-events: auto;
		touch-action: none;
	` );

	// Look area (the rest of the screen, under the buttons)
	lookArea = makeDiv( 'touch-look', `
		position: absolute;
		top: 0;
		width: 55%;
		height: 100%;
		pointer-events: auto;
		touch-action: none;
	` );

	overlay.appendChild( moveZone );
	overlay.appendChild( lookArea );

	for ( const b of holdButtons ) {

		b.el = makeDiv( b.id, BUTTON_CSS );
		b.el.textContent = b.label;
		overlay.appendChild( b.el );

	}

	for ( const b of tapButtons ) {

		b.el = makeDiv( b.id, BUTTON_CSS );
		b.el.textContent = b.label;
		overlay.appendChild( b.el );

	}

	pauseButton = makeDiv( 'touch-pause', BUTTON_CSS + `
		border-radius: 8px;
	` );
	pauseButton.textContent = '❙❙';
	overlay.appendChild( pauseButton );

	container.appendChild( overlay );

	Touch_CreateMenuUI( container );
	Touch_CreateSysBar( container );
	Touch_CreatePortraitPrompt( container );

	Touch_Layout();

}

/*
=================
Touch_Layout

Size and place the game controls from touch_size, touch_opacity and
touch_lefthanded. Positions keep clear of notches and the home indicator
(safe-area insets) and sit where the thumbs rest in landscape.
=================
*/
function Touch_Layout() {

	if ( overlay === null ) return;

	const scale = Math.min( Math.max( touch_size.value || 1, 0.5 ), 2 );
	const opacity = Math.min( Math.max( touch_opacity.value, 0.1 ), 1 );
	const mirror = touch_lefthanded.value !== 0;
	layoutKey = touch_size.string + '|' + touch_opacity.string + '|' + touch_lefthanded.string;

	// The action side is the right side unless mirrored
	const near = mirror ? 'left' : 'right';
	const far = mirror ? 'right' : 'left';
	const inset = ( side ) => `env(safe-area-inset-${side}, 0px)`;

	moveZone.style[ far ] = '0';
	moveZone.style[ near ] = '';
	lookArea.style[ near ] = '0';
	lookArea.style[ far ] = '';

	// Circle centred (cx, cy) px from the near and bottom edges
	const place = ( el, cx, cy, size ) => {

		const s = size * scale;
		el.style.width = s + 'px';
		el.style.height = s + 'px';
		el.style[ near ] = `calc(${inset( near )} + ${cx * scale - s / 2}px)`;
		el.style[ far ] = '';
		el.style.bottom = `calc(${inset( 'bottom' )} + ${cy * scale - s / 2}px)`;
		el.style.fontSize = Math.round( 13 * scale ) + 'px';
		el.style.opacity = String( opacity );

	};

	place( fireButton.el, 100, 112, 88 );
	place( jumpButton.el, 48, 48, 64 );
	place( weaponNextButton.el, 96, 206, 56 );
	place( weaponPrevButton.el, 168, 176, 44 );

	for ( const b of holdButtons ) {

		b.el.style.border = `2px solid rgba(${b.color}, 0.8)`;
		Touch_SetButtonPressed( b, b.touches.size > 0 );

	}

	for ( const b of tapButtons ) {

		b.el.style.border = '2px solid rgba(255, 255, 255, 0.5)';
		b.el.style.background = 'rgba(0, 0, 0, 0.25)';

	}

	// Menu button: top corner on the stick side, small
	const p = 40 * scale;
	pauseButton.style.width = p + 'px';
	pauseButton.style.height = p + 'px';
	pauseButton.style[ far ] = `calc(${inset( far )} + 12px)`;
	pauseButton.style[ near ] = '';
	pauseButton.style.top = `calc(${inset( 'top' )} + 12px)`;
	pauseButton.style.fontSize = Math.round( 12 * scale ) + 'px';
	pauseButton.style.background = 'rgba(0, 0, 0, 0.3)';
	pauseButton.style.border = '1px solid rgba(255, 255, 255, 0.5)';
	pauseButton.style.opacity = String( opacity );

	// The stick size is a nipplejs option: rebuild it
	if ( stickManager !== null ) {

		Stick_Destroy();
		Stick_Create();

	}

}

function Touch_SetButtonPressed( b, pressed ) {

	if ( b.el === null ) return;
	b.el.style.background = pressed ? `rgba(${b.color}, 0.35)` : 'rgba(0, 0, 0, 0.2)';

}

/*
=================
Touch_CreateMenuUI

Create fullscreen touch area for menu tap-to-select
=================
*/
function Touch_CreateMenuUI( container ) {

	menuOverlay = makeDiv( 'touch-menu-controls', `
		position: fixed;
		inset: 0;
		display: none;
		z-index: 199;
		pointer-events: auto;
		touch-action: none;
	` );

	menuOverlay.addEventListener( 'touchstart', onMenuTouchStart, { passive: false } );
	menuOverlay.addEventListener( 'touchmove', onMenuTouchMove, { passive: false } );
	menuOverlay.addEventListener( 'touchend', onMenuTouchEnd, { passive: false } );
	menuOverlay.addEventListener( 'touchcancel', onMenuTouchEnd, { passive: false } );

	container.appendChild( menuOverlay );

}

/*
=================
Touch_CreatePortraitPrompt

A full-screen "Rotate your device" card for portrait. The view keeps the
vertical FOV of the 4:3 default (fov 90 at 4:3 is about 74 degrees
vertically), so a portrait screen shows only about 38 degrees across. Tap to
dismiss; it stays dismissed for the session, since foldables and tablets
near square may never leave "portrait" by the innerHeight > innerWidth test.
=================
*/
function Touch_CreatePortraitPrompt( container ) {

	portraitPrompt = makeDiv( 'touch-portrait', `
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		bottom: 0;
		display: none;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		box-sizing: border-box;
		padding: env(safe-area-inset-top, 0px) env(safe-area-inset-right, 0px) env(safe-area-inset-bottom, 0px) env(safe-area-inset-left, 0px);
		background: rgba(0, 0, 0, 0.8);
		color: rgba(255, 255, 255, 0.9);
		font-family: sans-serif;
		text-align: center;
		z-index: 202;
		pointer-events: auto;
		touch-action: manipulation;
		user-select: none;
		-webkit-user-select: none;
		cursor: pointer;
	` );

	const icon = makeDiv( null, 'font-size: 56px; line-height: 1.2;' );
	icon.textContent = '\u21BB';
	const title = makeDiv( null, 'font-size: 22px; font-weight: bold; margin: 8px 16px;' );
	title.textContent = 'Rotate your device';
	const hint = makeDiv( null, 'font-size: 14px; opacity: 0.7; margin: 0 16px;' );
	hint.textContent = 'Landscape gives a wider view. Tap to continue.';
	portraitPrompt.appendChild( icon );
	portraitPrompt.appendChild( title );
	portraitPrompt.appendChild( hint );

	portraitPrompt.addEventListener( 'click', () => {

		portraitDismissed = true;
		Touch_UpdatePortraitPrompt();

	} );

	container.appendChild( portraitPrompt );

}

/*
=================
Touch_UpdatePortraitPrompt

Show the prompt while the game controls are up (touch mode, in game),
the window is portrait and it has not been dismissed. Menus, the console
and landscape hide it. Called on enable, disable, resize and rotation.
=================
*/
function Touch_UpdatePortraitPrompt() {

	if ( portraitPrompt === null ) return;

	const portrait = typeof window !== 'undefined' && window.innerHeight > window.innerWidth;
	portraitPrompt.style.display = ( enabled === true && portrait === true && portraitDismissed === false ) ? 'flex' : 'none';

}

/*
=================
Touch_CreateSysBar

Back (Escape) and keyboard buttons, shown in menus, the console and chat,
where there is no keyboard to press Escape or type with. The keyboard button
focuses an off-screen text field, whose input is forwarded as Quake keys.
=================
*/
function Touch_CreateSysBar( container ) {

	sysBar = makeDiv( 'touch-sysbar', `
		position: fixed;
		top: calc(env(safe-area-inset-top, 0px) + 10px);
		left: calc(env(safe-area-inset-left, 0px) + 10px);
		display: none;
		gap: 8px;
		z-index: 201;
		pointer-events: none;
	` );

	backButton = makeDiv( 'touch-back', SYS_BUTTON_CSS );
	backButton.textContent = '← Back';
	keyboardButton = makeDiv( 'touch-keyboard', SYS_BUTTON_CSS );
	keyboardButton.textContent = '⌨';
	sysBar.appendChild( backButton );
	sysBar.appendChild( keyboardButton );

	// No preventDefault: the tap must stay a click, which is what lets
	// focus() open the soft keyboard on iOS
	backButton.addEventListener( 'click', () => {

		S_UnlockAudio();
		Touch_HideKeyboard();
		pressKey( K_ESCAPE );

	} );
	keyboardButton.addEventListener( 'click', Touch_ToggleKeyboard );

	keyboardInput = document.createElement( 'input' );
	keyboardInput.id = 'touch-keyboard-input';
	keyboardInput.type = 'text';
	keyboardInput.setAttribute && keyboardInput.setAttribute( 'autocapitalize', 'off' );
	keyboardInput.setAttribute && keyboardInput.setAttribute( 'autocomplete', 'off' );
	keyboardInput.setAttribute && keyboardInput.setAttribute( 'autocorrect', 'off' );
	keyboardInput.setAttribute && keyboardInput.setAttribute( 'spellcheck', 'false' );
	keyboardInput.setAttribute && keyboardInput.setAttribute( 'enterkeyhint', 'send' );
	// 16px stops iOS zooming in on focus; off-screen but focusable
	keyboardInput.style.cssText = `
		position: fixed;
		left: -1000px;
		top: 0;
		width: 10px;
		height: 10px;
		font-size: 16px;
		opacity: 0;
	`;
	keyboardInput.addEventListener( 'input', onKeyboardInput );
	keyboardInput.addEventListener( 'keydown', onKeyboardKeyDown );

	container.appendChild( sysBar );
	container.appendChild( keyboardInput );

}

/*
==============================================================================

			ON-SCREEN KEYBOARD

Mobile keyboards often send keydown with key "Unidentified", so text comes
from the input event and the field is emptied after each one. Enter and
Backspace on an empty field only arrive as keydown.

==============================================================================
*/

function onKeyboardInput( e ) {

	const type = e.inputType || '';
	if ( type.startsWith( 'delete' ) ) {

		pressKey( K_BACKSPACE );

	} else if ( type === 'insertLineBreak' ) {

		pressKey( K_ENTER );

	} else {

		const text = e.data != null ? e.data : keyboardInput.value;
		for ( const ch of text ) {

			const code = ch.charCodeAt( 0 );
			if ( code >= 32 && code < 127 ) pressKey( code );

		}

	}

	keyboardInput.value = '';

}

function onKeyboardKeyDown( e ) {

	if ( e.key === 'Enter' ) {

		e.preventDefault();
		pressKey( K_ENTER );

	} else if ( e.key === 'Backspace' && keyboardInput.value === '' ) {

		e.preventDefault();
		pressKey( K_BACKSPACE );

	} else if ( e.key === 'Escape' ) {

		e.preventDefault();
		Touch_HideKeyboard();
		pressKey( K_ESCAPE );

	}

}

function Touch_ToggleKeyboard() {

	if ( keyboardInput === null ) return;
	S_UnlockAudio();

	if ( typeof document !== 'undefined' && document.activeElement === keyboardInput ) {

		keyboardInput.blur();

	} else {

		keyboardInput.value = '';
		keyboardInput.focus();

	}

}

function Touch_HideKeyboard() {

	if ( keyboardInput !== null && typeof document !== 'undefined' &&
		document.activeElement === keyboardInput ) keyboardInput.blur();

}

/*
=================
Menu touch handlers

A tap (released without dragging) selects the menu item under the finger.
Dragging sends arrow keys, one per MENU_DRAG_STEP pixels along the first
axis moved: up/down moves the cursor, left/right adjusts sliders and
options. menu.js only takes taps, so drags go through Key_Event.
=================
*/

function findTouch( list, id ) {

	for ( let i = 0; i < list.length; i ++ ) {

		if ( list[ i ].identifier === id ) return list[ i ];

	}

	return null;

}

function pressKey( key ) {

	Key_Event( key, true );
	Key_Event( key, false );

}

function onMenuTouchStart( e ) {

	e.preventDefault();

	// Unlock audio on first user gesture
	S_UnlockAudio();

	if ( menuTouch !== null || e.changedTouches.length === 0 ) return;

	const touch = e.changedTouches[ 0 ];
	menuTouch = touch.identifier;
	menuDragging = false;
	menuDragAxis = 0;
	menuTouchStart.x = touch.clientX;
	menuTouchStart.y = touch.clientY;
	menuTouchStep.x = touch.clientX;
	menuTouchStep.y = touch.clientY;

}

function onMenuTouchMove( e ) {

	e.preventDefault();

	if ( menuTouch === null ) return;
	const touch = findTouch( e.changedTouches, menuTouch );
	if ( touch === null ) return;

	if ( menuDragAxis === 0 ) {

		const dx = Math.abs( touch.clientX - menuTouchStart.x );
		const dy = Math.abs( touch.clientY - menuTouchStart.y );
		if ( dx < MENU_DRAG_STEP && dy < MENU_DRAG_STEP ) return;
		menuDragAxis = dx >= dy ? 1 : 2;
		menuDragging = true;

	}

	if ( menuDragAxis === 1 ) {

		while ( touch.clientX - menuTouchStep.x >= MENU_DRAG_STEP ) {

			pressKey( K_RIGHTARROW );
			menuTouchStep.x += MENU_DRAG_STEP;

		}

		while ( menuTouchStep.x - touch.clientX >= MENU_DRAG_STEP ) {

			pressKey( K_LEFTARROW );
			menuTouchStep.x -= MENU_DRAG_STEP;

		}

	} else {

		while ( touch.clientY - menuTouchStep.y >= MENU_DRAG_STEP ) {

			pressKey( K_DOWNARROW );
			menuTouchStep.y += MENU_DRAG_STEP;

		}

		while ( menuTouchStep.y - touch.clientY >= MENU_DRAG_STEP ) {

			pressKey( K_UPARROW );
			menuTouchStep.y -= MENU_DRAG_STEP;

		}

	}

}

function onMenuTouchEnd( e ) {

	e.preventDefault();

	Menu_HandleTouchEnd( e );

	// touchend is a user activation: if the tap just switched gyro aiming on,
	// iOS can show its motion permission prompt now
	if ( e.type === 'touchend' ) Gyro_RequestPermission();

}

function Menu_HandleTouchEnd( e ) {

	if ( menuTouch === null ) return;
	const touch = findTouch( e.changedTouches, menuTouch );
	if ( touch === null ) return;

	menuTouch = null;

	if ( menuDragging || e.type === 'touchcancel' || menuTouchCallback == null ) return;

	// Tap: pass coordinates relative to the surface the menu is drawn into
	const surface = menuSurfaceGetter ? menuSurfaceGetter() : null;
	if ( surface != null && surface.getBoundingClientRect ) {

		const rect = surface.getBoundingClientRect();
		menuTouchCallback( touch.clientX - rect.left, touch.clientY - rect.top, rect.width, rect.height );

	} else {

		menuTouchCallback( touch.clientX, touch.clientY, window.innerWidth, window.innerHeight );

	}

}

/*
==============================================================================

			GAME TOUCH HANDLERS

==============================================================================
*/

function haptic( ms ) {

	if ( ! touch_haptics.value || typeof navigator === 'undefined' ) return;
	if ( typeof navigator.vibrate !== 'function' ) return; // iOS has none
	// Chrome logs an error for vibrate before the first real tap
	if ( navigator.userActivation && ! navigator.userActivation.hasBeenActive ) return;
	navigator.vibrate( ms );

}

function addLook( dx, dy ) {

	const k = LOOK_DEGREES_PER_PX * touch_sensitivity.value;
	lookYaw -= dx * k;
	lookPitch += dy * k;

}

function onLookTouchStart( e ) {

	e.preventDefault();
	S_UnlockAudio();

	for ( const touch of e.changedTouches ) {

		if ( lookTouch !== null ) break;
		lookTouch = touch.identifier;
		lastLookPos.x = touch.clientX;
		lastLookPos.y = touch.clientY;

	}

}

function onLookTouchMove( e ) {

	e.preventDefault();

	const touch = lookTouch !== null ? findTouch( e.changedTouches, lookTouch ) : null;
	if ( touch === null ) return;

	addLook( touch.clientX - lastLookPos.x, touch.clientY - lastLookPos.y );
	lastLookPos.x = touch.clientX;
	lastLookPos.y = touch.clientY;

}

function onLookTouchEnd( e ) {

	e.preventDefault();

	if ( lookTouch !== null && findTouch( e.changedTouches, lookTouch ) !== null ) lookTouch = null;
	onGameTouchEnd( e );

}

// touchend is a user activation (touchstart is not in Chrome): fullscreen
// and the iOS motion permission prompt can only be requested from it
function onGameTouchEnd( e ) {

	if ( e.type !== 'touchend' ) return;
	Touch_RequestFullscreen();
	Gyro_Update( true );

}

function onHoldTouchStart( b, e ) {

	e.preventDefault();
	S_UnlockAudio();

	for ( const touch of e.changedTouches ) {

		if ( b.touches.size === 0 ) {

			b.getButton().state |= 1 + 2; // down + impulse down
			Touch_SetButtonPressed( b, true );
			haptic( 12 );

		}

		b.touches.add( touch.identifier );
		b.lastPos.set( touch.identifier, { x: touch.clientX, y: touch.clientY } );

	}

}

function onHoldTouchMove( b, e ) {

	e.preventDefault();

	for ( const touch of e.changedTouches ) {

		const last = b.lastPos.get( touch.identifier );
		if ( last === undefined ) continue;
		addLook( touch.clientX - last.x, touch.clientY - last.y );
		last.x = touch.clientX;
		last.y = touch.clientY;

	}

}

function onHoldTouchEnd( b, e ) {

	e.preventDefault();

	for ( const touch of e.changedTouches ) {

		b.touches.delete( touch.identifier );
		b.lastPos.delete( touch.identifier );

	}

	if ( b.touches.size === 0 ) Touch_ReleaseHold( b );
	onGameTouchEnd( e );

}

function Touch_ReleaseHold( b ) {

	const kbutton = b.getButton();
	if ( kbutton.state & 1 ) {

		kbutton.state &= ~ 1; // up
		kbutton.state |= 4; // impulse up

	}

	b.touches.clear();
	b.lastPos.clear();
	Touch_SetButtonPressed( b, false );

}

function onTapTouchStart( b, e ) {

	e.preventDefault();
	S_UnlockAudio();
	Cbuf_AddText( b.command );
	haptic( 8 );
	b.el.style.background = 'rgba(255, 255, 255, 0.3)';

}

function onTapTouchEnd( b, e ) {

	e.preventDefault();
	if ( ! e.targetTouches || e.targetTouches.length === 0 ) b.el.style.background = 'rgba(0, 0, 0, 0.25)';
	onGameTouchEnd( e );

}

function onPauseTouchStart( e ) {

	e.preventDefault();
	pressKey( K_ESCAPE );

}

// Listener table, so Enable/Disable add and remove the same functions
const gameListeners = [];

function Touch_BuildListeners() {

	const add = ( el, type, fn ) => gameListeners.push( { el, type, fn } );

	add( lookArea, 'touchstart', onLookTouchStart );
	add( lookArea, 'touchmove', onLookTouchMove );
	add( lookArea, 'touchend', onLookTouchEnd );
	add( lookArea, 'touchcancel', onLookTouchEnd );

	// The stick itself uses pointer events (nipplejs). Its touch events are
	// cancelled so no compatibility mousedown reaches the canvas (that would
	// be +attack), and touchend asks for fullscreen and the gyro permission.
	const cancel = ( e ) => e.preventDefault();
	add( moveZone, 'touchstart', ( e ) => {

		cancel( e );
		S_UnlockAudio();

	} );
	add( moveZone, 'touchmove', cancel );
	add( moveZone, 'touchend', ( e ) => {

		cancel( e );
		onGameTouchEnd( e );

	} );
	add( moveZone, 'touchcancel', cancel );

	for ( const b of holdButtons ) {

		add( b.el, 'touchstart', ( e ) => onHoldTouchStart( b, e ) );
		add( b.el, 'touchmove', ( e ) => onHoldTouchMove( b, e ) );
		add( b.el, 'touchend', ( e ) => onHoldTouchEnd( b, e ) );
		add( b.el, 'touchcancel', ( e ) => onHoldTouchEnd( b, e ) );

	}

	for ( const b of tapButtons ) {

		add( b.el, 'touchstart', ( e ) => onTapTouchStart( b, e ) );
		add( b.el, 'touchend', ( e ) => onTapTouchEnd( b, e ) );
		add( b.el, 'touchcancel', ( e ) => onTapTouchEnd( b, e ) );

	}

	add( pauseButton, 'touchstart', onPauseTouchStart );

}

/*
==============================================================================

			MOVE STICK (nipplejs)

==============================================================================
*/

// Load nipplejs through the page's import map. The specifier is a variable
// so tools that resolve imports up front (Deno tests) don't fail on it.
function Stick_Load() {

	if ( nippleLoad !== null ) return nippleLoad;

	const specifier = 'nipplejs';
	nippleLoad = import( specifier ).then( ( mod ) => {

		nipplejs = mod.default || mod;
		if ( enabled && stickManager === null ) Stick_Create();

	} ).catch( ( err ) => {

		// Try again on the next Touch_Enable (e.g. back online)
		nippleLoad = null;
		console.warn( 'Touch: could not load the move stick (nipplejs):', err.message );

	} );

	return nippleLoad;

}

function Stick_Create() {

	if ( nipplejs === null || moveZone === null || stickManager !== null ) return;

	const scale = Math.min( Math.max( touch_size.value || 1, 0.5 ), 2 );
	stickManager = nipplejs.create( {
		zone: moveZone,
		mode: 'dynamic',
		size: Math.round( JOYSTICK_SIZE * scale ),
		color: 'white',
		fadeTime: 120,
		multitouch: false,
		restOpacity: Math.min( Math.max( touch_opacity.value, 0.1 ), 1 )
	} );

	// nipplejs 1.x passes one event object; 0.x passed ( event, data )
	stickManager.on( 'start', () => {

		S_UnlockAudio();

	} );
	stickManager.on( 'move', ( evt, data ) => {

		const d = data || ( evt && evt.data );
		if ( d && d.vector ) Touch_SetJoystick( d.vector.x, - d.vector.y );

	} );
	stickManager.on( 'end', () => {

		Touch_ResetJoystick();

	} );

}

function Stick_Destroy() {

	if ( stickManager === null ) return;
	stickManager.destroy(); // emits no 'end' for a stick still held
	stickManager = null;
	Touch_ResetJoystick();

}

/*
=================
Touch_SetJoystick

x, y: knob offset as a fraction of the radius (screen axes, y down).
Applies the deadzone, then ramps the magnitude linearly from 0 at the
deadzone edge to 1 at JOYSTICK_FULL. IN_Move multiplies it by
cl_movespeedkey, so the response is continuous: walk speed (1x
cl_forwardspeed) lands mid-throw and run speed (cl_movespeedkey x) at full
deflection, with no jump between them. `run` only flags full deflection.
=================
*/
export function Touch_SetJoystick( x, y ) {

	const mag = Math.sqrt( x * x + y * y );

	if ( mag < JOYSTICK_DEADZONE ) {

		moveRight = 0;
		moveForward = 0;
		moveRun = false;
		return;

	}

	const t = Math.min( ( mag - JOYSTICK_DEADZONE ) / ( JOYSTICK_FULL - JOYSTICK_DEADZONE ), 1 );
	moveRun = t >= 1;
	const scale = t / mag;

	// Note: Y is inverted (up = forward = positive)
	moveRight = x * scale;
	moveForward = - y * scale;

}

function Touch_ResetJoystick() {

	moveForward = 0;
	moveRight = 0;
	moveRun = false;

}

/*
=================
Touch_ReleaseButtons

Release FIRE/JUMP if touch is holding them, reset the stick and look
tracking. Called by Touch_Disable and on focus loss.
=================
*/
export function Touch_ReleaseButtons() {

	for ( const b of holdButtons ) Touch_ReleaseHold( b );
	Touch_ResetJoystick();
	lookTouch = null;
	lookYaw = 0;
	lookPitch = 0;
	menuTouch = null;

}

/*
==============================================================================

			GYRO AIMING

devicemotion rotationRate is angular velocity in degrees per second about the
device axes (beta: x, short edge; gamma: y, long edge; alpha: z, out of the
screen). It is rotated into screen axes for the current orientation, then
integrated over the time between events: rotation about the screen's
vertical axis turns, about its horizontal axis pitches. Rotation about the
screen normal (roll) is added to yaw ("local space" gyro), so turning while
the phone is tilted back still turns. touch_gyro_sensitivity 1 maps a real
degree to a view degree.

==============================================================================
*/

function onDeviceMotion( e ) {

	if ( ! enabled ) return;

	const r = e.rotationRate;
	const t = typeof e.timeStamp === 'number' ? e.timeStamp : performance.now();
	const last = gyroLastTime;
	gyroLastTime = t;

	if ( r == null || r.alpha == null || r.beta == null || r.gamma == null || last < 0 ) return;

	// Skip the first event after a pause instead of integrating the gap
	const dt = ( t - last ) / 1000;
	if ( dt <= 0 || dt > 0.25 ) return;

	const angle = Gyro_ScreenAngle() * Math.PI / 180;
	const c = Math.cos( angle );
	const s = Math.sin( angle );

	// Device axes to screen axes (x right, y up, z towards the viewer)
	const wx = r.beta * c - r.gamma * s;
	const wy = r.beta * s + r.gamma * c;
	const wz = r.alpha;

	const k = touch_gyro_sensitivity.value * dt;
	lookYaw += ( wy + wz ) * k; // counter-clockwise from above = turn left
	lookPitch -= wx * k; // top edge towards the viewer (camera tilts up) = look up

}

function Gyro_ScreenAngle() {

	if ( typeof screen !== 'undefined' && screen.orientation && typeof screen.orientation.angle === 'number' )
		return screen.orientation.angle;
	if ( typeof window !== 'undefined' && typeof window.orientation === 'number' )
		return ( window.orientation + 360 ) % 360;
	return 0;

}

/*
=================
Gyro_Update

Start or stop listening to match touch_gyro while the game controls are up.
fromGesture: we are inside a user activation, so iOS may show its motion
permission prompt now (it refuses outside one).
=================
*/
function Gyro_Update( fromGesture ) {

	const want = enabled && touch_gyro.value !== 0;

	if ( ! want ) {

		Gyro_Stop();
		return;

	}

	if ( gyroListening || typeof window === 'undefined' ) return;

	const DME = typeof DeviceMotionEvent !== 'undefined' ? DeviceMotionEvent : null;
	if ( DME === null ) return;

	if ( typeof DME.requestPermission !== 'function' || gyroPermission === 'granted' ) {

		Gyro_Start();
		return;

	}

	if ( fromGesture ) Gyro_RequestPermission();

}

/*
=================
Gyro_RequestPermission

iOS only: ask for motion sensor access while touch_gyro is on. Must run
inside a user activation (touchend). Gyro_Update starts listening once it is
granted and the game controls are up.
=================
*/
function Gyro_RequestPermission() {

	if ( touch_gyro.value === 0 || gyroPermission !== 'unknown' ) return;

	const DME = typeof DeviceMotionEvent !== 'undefined' ? DeviceMotionEvent : null;
	if ( DME === null || typeof DME.requestPermission !== 'function' ) return;

	gyroPermission = 'pending';
	DME.requestPermission().then( ( result ) => {

		gyroPermission = result === 'granted' ? 'granted' : 'denied';
		if ( gyroPermission === 'granted' ) Gyro_Update( false );
		else console.log( 'Touch: motion sensor permission denied, gyro aiming is off' );

	} ).catch( ( err ) => {

		// Not from a gesture after all: ask again on the next tap
		gyroPermission = 'unknown';
		console.log( 'Touch: motion sensor permission error:', err.message );

	} );

}

function Gyro_Start() {

	if ( gyroListening ) return;
	gyroListening = true;
	gyroLastTime = - 1;
	window.addEventListener( 'devicemotion', onDeviceMotion );

}

function Gyro_Stop() {

	if ( ! gyroListening ) return;
	gyroListening = false;
	window.removeEventListener( 'devicemotion', onDeviceMotion );

}

/*
=================
Touch_Frame

Called every frame: re-lays out the controls and starts or stops the gyro
when the touch cvars change (from the menu or the console)
=================
*/
export function Touch_Frame() {

	if ( ! initialized ) return;

	const key = touch_size.string + '|' + touch_opacity.string + '|' + touch_lefthanded.string;
	if ( key !== layoutKey ) Touch_Layout();

	if ( ( touch_gyro.value !== 0 ) !== gyroListening ) Gyro_Update( false );

}

/*
=================
Wake Lock - prevents screen from dimming while playing
=================
*/

async function Touch_RequestWakeLock() {

	if ( wakeLock !== null || wakeLockPending ) return;
	if ( typeof navigator === 'undefined' || ! ( 'wakeLock' in navigator ) ) return;

	// The request is refused while the page is hidden; the visibilitychange
	// handler retries when it comes back
	if ( document.visibilityState !== 'visible' ) return;

	wakeLockPending = true;

	try {

		const lock = await navigator.wakeLock.request( 'screen' );

		// Controls were disabled while the request was pending
		if ( ! enabled ) {

			lock.release().catch( () => {} );
			return;

		}

		wakeLock = lock;
		lock.addEventListener( 'release', () => {

			if ( wakeLock === lock ) wakeLock = null;

		} );

	} catch ( err ) {

		console.log( 'Wake Lock request failed:', err.message );

	} finally {

		wakeLockPending = false;

	}

}

function Touch_ReleaseWakeLock() {

	if ( wakeLock !== null ) {

		const lock = wakeLock;
		wakeLock = null;
		lock.release().catch( () => {} );

	}

}

// The browser releases the wake lock when the page is hidden: take it back
function onVisibilityChange() {

	if ( enabled && document.visibilityState === 'visible' ) {

		Touch_RequestWakeLock();

	}

}

// Reset when the user leaves fullscreen, so the next tap can enter it again
function onFullscreenChange() {

	if ( ! document.fullscreenElement && ! document.webkitFullscreenElement ) {

		fullscreenActivated = false;

	}

}

/*
=================
Touch_RequestFullscreen

Request fullscreen and lock to landscape orientation on mobile
=================
*/
export async function Touch_RequestFullscreen() {

	if ( fullscreenActivated || fullscreenPending ) return;

	// Meta Quest browser has no page fullscreen (as in in_web.js)
	if ( typeof navigator !== 'undefined' && /OculusBrowser|Quest/i.test( navigator.userAgent || '' ) ) return;

	if ( document.fullscreenElement || document.webkitFullscreenElement ) {

		fullscreenActivated = true;
		return;

	}

	fullscreenPending = true;

	try {

		// Request fullscreen
		const container = document.documentElement;
		if ( container.requestFullscreen ) {

			await container.requestFullscreen();

		} else if ( container.webkitRequestFullscreen ) {

			await container.webkitRequestFullscreen();

		}

		// Lock to landscape orientation
		if ( screen.orientation && screen.orientation.lock ) {

			try {

				await screen.orientation.lock( 'landscape' );

			} catch ( e ) {

				// Orientation lock may not be supported or allowed
				console.log( 'Could not lock orientation:', e.message );

			}

		}

		// The user may have left fullscreen while the awaits above were pending
		// (fullscreenchange already ran): only latch the state that is true now
		fullscreenActivated = ! container.requestFullscreen && ! container.webkitRequestFullscreen ||
			!! ( document.fullscreenElement || document.webkitFullscreenElement );

	} catch ( e ) {

		console.log( 'Could not enter fullscreen:', e.message );

	} finally {

		fullscreenPending = false;

	}

}

/*
=================
Touch_ExitFullscreen

Exit fullscreen mode
=================
*/
export async function Touch_ExitFullscreen() {

	if ( ! document.fullscreenElement && ! document.webkitFullscreenElement ) return;

	try {

		if ( document.exitFullscreen ) {

			await document.exitFullscreen();

		} else if ( document.webkitExitFullscreen ) {

			await document.webkitExitFullscreen();

		}

		// Unlock orientation
		if ( screen.orientation && screen.orientation.unlock ) {

			screen.orientation.unlock();

		}

		fullscreenActivated = false;

	} catch ( e ) {

		console.log( 'Could not exit fullscreen:', e.message );

	}

}

/*
=================
Touch_Init

Initialize touch controls
=================
*/
export function Touch_Init( container ) {

	if ( initialized ) return;

	Touch_CreateUI( container || document.body );
	Touch_BuildListeners();

	document.addEventListener( 'visibilitychange', onVisibilityChange );
	document.addEventListener( 'fullscreenchange', onFullscreenChange );
	document.addEventListener( 'webkitfullscreenchange', onFullscreenChange );

	if ( typeof window !== 'undefined' ) {

		window.addEventListener( 'resize', Touch_UpdatePortraitPrompt );
		window.addEventListener( 'orientationchange', Touch_UpdatePortraitPrompt );

	}

	initialized = true;

	// Fetch the stick library now, so it is ready by the first map
	Stick_Load();

}

/*
=================
Touch_Enable

Enable touch controls (show UI, add listeners)
=================
*/
export function Touch_Enable() {

	if ( ! initialized ) return;
	if ( enabled ) return;

	enabled = true;
	overlay.style.display = 'block';
	Touch_HideSysBar();
	Touch_UpdatePortraitPrompt();

	for ( const l of gameListeners ) l.el.addEventListener( l.type, l.fn, { passive: false } );

	if ( nipplejs === null ) Stick_Load();
	Stick_Create();

	// Gyro if switched on and already allowed (the iOS prompt waits for a tap)
	Gyro_Update( false );

	// Keep screen on while playing
	Touch_RequestWakeLock();

}

/*
=================
Touch_Disable

Disable touch controls (hide UI, remove listeners)
=================
*/
export function Touch_Disable() {

	if ( ! initialized || ! enabled ) return;

	enabled = false;
	overlay.style.display = 'none';
	Touch_UpdatePortraitPrompt();

	for ( const l of gameListeners ) l.el.removeEventListener( l.type, l.fn );

	// A stick held now would never see its pointerup
	Stick_Destroy();

	Gyro_Stop();

	// Release wake lock when not playing
	Touch_ReleaseWakeLock();

	// Release FIRE/JUMP (their touchend will never arrive), reset the stick
	Touch_ReleaseButtons();

}

/*
=================
Touch_IsEnabled
=================
*/
export function Touch_IsEnabled() {

	return enabled;

}

/*
=================
Touch_GetMoveInput

Returns normalized movement input from joystick
=================
*/
export function Touch_GetMoveInput() {

	_moveInput.forward = moveForward;
	_moveInput.right = moveRight;
	_moveInput.run = moveRun;
	return _moveInput;

}

/*
=================
Touch_GetLookDelta

Returns the view change from drag look and gyro since the last call, in
degrees (yaw: + turns left, pitch: + looks down), and clears it
=================
*/
export function Touch_GetLookDelta() {

	_lookDelta.yaw = lookYaw;
	_lookDelta.pitch = lookPitch;
	lookYaw = 0;
	lookPitch = 0;
	return _lookDelta;

}

/*
=================
Touch_ShowMenu

Show menu touch overlay (and the Back / keyboard bar)
=================
*/
export function Touch_ShowMenu() {

	if ( ! initialized || ! menuOverlay ) return;

	menuOverlay.style.display = 'block';
	Touch_ShowSysBar();

}

/*
=================
Touch_HideMenu

Hide menu touch overlay
=================
*/
export function Touch_HideMenu() {

	if ( ! initialized || ! menuOverlay ) return;

	menuOverlay.style.display = 'none';

}

/*
=================
Touch_ShowSysBar / Touch_HideSysBar

The Back / keyboard bar on its own, for the console and chat
=================
*/
export function Touch_ShowSysBar() {

	if ( ! initialized || ! sysBar ) return;
	sysBar.style.display = 'flex';

}

export function Touch_HideSysBar() {

	if ( ! initialized || ! sysBar ) return;
	sysBar.style.display = 'none';
	Touch_HideKeyboard();

}

/*
=================
Touch_SetMenuCallback

Set the callback function for menu touch events
Callback receives (touchX, touchY, surfaceWidth, surfaceHeight), relative to
the element returned by getSurface (the canvas the menu is drawn into)
=================
*/
export function Touch_SetMenuCallback( callback, getSurface ) {

	menuTouchCallback = callback;
	menuSurfaceGetter = getSurface || null;

}
