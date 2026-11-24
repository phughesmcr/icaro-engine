// Touch controls for mobile devices
// Provides virtual joystick on left, look area on right, FIRE/JUMP/pause buttons

import { K_ESCAPE, K_UPARROW, K_DOWNARROW, K_LEFTARROW, K_RIGHTARROW, Key_Event } from './keys.js';
import { in_attack, in_jump } from './cl_input.js';
import { S_UnlockAudio } from './snd_dma.js';

// Touch state
let enabled = false;
let initialized = false;
let menuOverlay = null;
let menuTouchCallback = null;
let menuSurfaceGetter = null; // returns the element the menu is drawn into
let fullscreenActivated = false;
let fullscreenPending = false;
let wakeLock = null;
let wakeLockPending = false;

// Buttons held by touch (they write kbutton state directly, not via Key_Event)
let fireHeld = false;
let jumpHeld = false;

// Movement joystick (left side)
let moveTouch = null;
const joystickOrigin = { x: 0, y: 0 };
const joystickCurrent = { x: 0, y: 0 };
const JOYSTICK_RADIUS = 50; // px
const JOYSTICK_DEADZONE = 0.15; // fraction of the radius
const JOYSTICK_RUN_THRESHOLD = 0.9; // past this the stick runs (+speed)

// Look area (right side)
let lookTouch = null;
const lastLookPos = { x: 0, y: 0 };

// Menu touch (tap to select, drag to send arrow keys)
const MENU_DRAG_STEP = 24; // px of drag per arrow key
let menuTouch = null;
let menuDragging = false;
let menuDragAxis = 0; // 0 = undecided, 1 = horizontal, 2 = vertical
const menuTouchStart = { x: 0, y: 0 };
const menuTouchStep = { x: 0, y: 0 };

// Accumulated values for IN_Move
let moveForward = 0;
let moveRight = 0;
let moveRun = false;
let lookDeltaX = 0;
let lookDeltaY = 0;

// Returned by the getters (no per-frame allocation)
const _moveInput = { forward: 0, right: 0, run: false };
const _lookDelta = { x: 0, y: 0 };

// Gyroscope state
let gyroEnabled = false;
let gyroPermissionRequested = false;
let prevBeta = null;
let prevGamma = null;
const GYRO_SENSITIVITY = 8.0;
const LOOK_SENSITIVITY = 3.0;

// UI elements
let overlay = null;
let joystickArea = null;
let joystickBase = null;
let joystickKnob = null;
let lookArea = null;
let fireButton = null;
let jumpButton = null;
let pauseButton = null;

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
=================
Touch_CreateUI

Create the touch control UI elements
=================
*/
function Touch_CreateUI( container ) {

	// Main overlay
	overlay = document.createElement( 'div' );
	overlay.id = 'touch-controls';
	overlay.style.cssText = `
		position: fixed;
		top: 0;
		left: 0;
		width: 100%;
		height: 100%;
		pointer-events: none;
		z-index: 200;
		display: none;
		touch-action: none;
	`;

	// Left side - movement joystick area
	joystickArea = document.createElement( 'div' );
	joystickArea.style.cssText = `
		position: absolute;
		left: 0;
		top: 0;
		width: 40%;
		height: 100%;
		pointer-events: auto;
		touch-action: none;
	`;

	// Joystick base (appears when touching)
	joystickBase = document.createElement( 'div' );
	joystickBase.style.cssText = `
		position: fixed;
		width: 120px;
		height: 120px;
		border-radius: 50%;
		background: rgba(255, 255, 255, 0.15);
		border: 2px solid rgba(255, 255, 255, 0.3);
		display: none;
		transform: translate(-50%, -50%);
		pointer-events: none;
	`;

	// Joystick knob
	joystickKnob = document.createElement( 'div' );
	joystickKnob.style.cssText = `
		position: absolute;
		width: 50px;
		height: 50px;
		border-radius: 50%;
		background: rgba(255, 255, 255, 0.4);
		border: 2px solid rgba(255, 255, 255, 0.6);
		left: 50%;
		top: 50%;
		transform: translate(-50%, -50%);
	`;
	joystickBase.appendChild( joystickKnob );
	joystickArea.appendChild( joystickBase );

	// Right side - look area (drag to look)
	lookArea = document.createElement( 'div' );
	lookArea.style.cssText = `
		position: absolute;
		right: 0;
		top: 0;
		width: 60%;
		height: 100%;
		pointer-events: auto;
		touch-action: none;
	`;

	// Fire button (top right)
	fireButton = document.createElement( 'div' );
	fireButton.style.cssText = `
		position: absolute;
		right: 60px;
		top: 50px;
		width: 100px;
		height: 100px;
		border-radius: 50%;
		background: transparent;
		border: 2px solid rgba(255, 100, 100, 0.5);
		pointer-events: auto;
		touch-action: none;
		display: flex;
		align-items: center;
		justify-content: center;
		font-family: sans-serif;
		font-size: 14px;
		color: rgba(255, 255, 255, 0.7);
	`;
	fireButton.textContent = 'FIRE';

	// Jump button (below fire button)
	jumpButton = document.createElement( 'div' );
	jumpButton.style.cssText = `
		position: absolute;
		right: 60px;
		top: 170px;
		width: 100px;
		height: 100px;
		border-radius: 50%;
		background: transparent;
		border: 2px solid rgba(100, 150, 255, 0.5);
		pointer-events: auto;
		touch-action: none;
		display: flex;
		align-items: center;
		justify-content: center;
		font-family: sans-serif;
		font-size: 14px;
		color: rgba(255, 255, 255, 0.7);
	`;
	jumpButton.textContent = 'JUMP';

	// Pause button (bottom right corner)
	pauseButton = document.createElement( 'div' );
	pauseButton.style.cssText = `
		position: absolute;
		right: 20px;
		bottom: 20px;
		width: 40px;
		height: 40px;
		border-radius: 5px;
		background: rgba(255, 255, 255, 0.15);
		border: 1px solid rgba(255, 255, 255, 0.3);
		pointer-events: auto;
		touch-action: none;
		display: flex;
		align-items: center;
		justify-content: center;
		font-family: sans-serif;
		font-size: 16px;
		color: rgba(255, 255, 255, 0.7);
	`;
	pauseButton.textContent = '| |';

	// Assemble UI
	overlay.appendChild( joystickArea );
	overlay.appendChild( lookArea );
	overlay.appendChild( fireButton );
	overlay.appendChild( jumpButton );
	overlay.appendChild( pauseButton );

	container.appendChild( overlay );

	// Create menu navigation overlay
	Touch_CreateMenuUI( container );

}

/*
=================
Touch_CreateMenuUI

Create fullscreen touch area for menu tap-to-select
=================
*/
function Touch_CreateMenuUI( container ) {

	menuOverlay = document.createElement( 'div' );
	menuOverlay.id = 'touch-menu-controls';
	menuOverlay.style.cssText = `
		position: fixed;
		top: 0;
		left: 0;
		width: 100%;
		height: 100%;
		display: none;
		z-index: 199;
		pointer-events: auto;
		touch-action: none;
	`;

	menuOverlay.addEventListener( 'touchstart', onMenuTouchStart, { passive: false } );
	menuOverlay.addEventListener( 'touchmove', onMenuTouchMove, { passive: false } );
	menuOverlay.addEventListener( 'touchend', onMenuTouchEnd, { passive: false } );
	menuOverlay.addEventListener( 'touchcancel', onMenuTouchEnd, { passive: false } );

	container.appendChild( menuOverlay );

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
=================
Touch event handlers
=================
*/

function onTouchStart( e ) {

	e.preventDefault();

	// Unlock audio on first user gesture
	S_UnlockAudio();

	// Request gyroscope permission on first touch (needs user gesture)
	if ( ! gyroPermissionRequested ) {

		Gyro_RequestPermission();

	}

	for ( const touch of e.changedTouches ) {

		const target = e.currentTarget;

		if ( target === joystickArea && moveTouch === null ) {

			// Start joystick
			moveTouch = touch.identifier;
			joystickOrigin.x = touch.clientX;
			joystickOrigin.y = touch.clientY;
			joystickCurrent.x = touch.clientX;
			joystickCurrent.y = touch.clientY;

			// Show joystick at touch position
			joystickBase.style.display = 'block';
			joystickBase.style.left = touch.clientX + 'px';
			joystickBase.style.top = touch.clientY + 'px';

		} else if ( target === lookArea && lookTouch === null ) {

			// Start look
			lookTouch = touch.identifier;
			lastLookPos.x = touch.clientX;
			lastLookPos.y = touch.clientY;

		} else if ( target === fireButton ) {

			if ( ! fireHeld ) in_attack.state |= 1 + 2; // down + impulse down
			fireHeld = true;
			fireButton.style.background = 'rgba(255, 100, 100, 0.2)';
			if ( typeof navigator.vibrate === 'function' ) navigator.vibrate( 100 );

		} else if ( target === jumpButton ) {

			if ( ! jumpHeld ) in_jump.state |= 1 + 2; // down + impulse down
			jumpHeld = true;
			jumpButton.style.background = 'rgba(100, 150, 255, 0.2)';
			if ( typeof navigator.vibrate === 'function' ) navigator.vibrate( 100 );

		} else if ( target === pauseButton ) {

			// Trigger escape key
			Key_Event( K_ESCAPE, true );
			Key_Event( K_ESCAPE, false );

		}

	}

}

function onTouchMove( e ) {

	e.preventDefault();

	for ( const touch of e.changedTouches ) {

		if ( touch.identifier === moveTouch ) {

			// Update joystick
			joystickCurrent.x = touch.clientX;
			joystickCurrent.y = touch.clientY;

			// Calculate offset from origin
			const dx = joystickCurrent.x - joystickOrigin.x;
			const dy = joystickCurrent.y - joystickOrigin.y;

			// Clamp to max radius
			const dist = Math.sqrt( dx * dx + dy * dy );
			let clampedX = dx;
			let clampedY = dy;

			if ( dist > JOYSTICK_RADIUS ) {

				clampedX = ( dx / dist ) * JOYSTICK_RADIUS;
				clampedY = ( dy / dist ) * JOYSTICK_RADIUS;

			}

			// Update knob position
			joystickKnob.style.left = `calc(50% + ${clampedX}px)`;
			joystickKnob.style.top = `calc(50% + ${clampedY}px)`;

			Touch_SetJoystick( clampedX / JOYSTICK_RADIUS, clampedY / JOYSTICK_RADIUS );

		} else if ( touch.identifier === lookTouch ) {

			// Calculate look delta
			const dx = touch.clientX - lastLookPos.x;
			const dy = touch.clientY - lastLookPos.y;

			lookDeltaX += dx * LOOK_SENSITIVITY;
			lookDeltaY += dy * LOOK_SENSITIVITY;

			lastLookPos.x = touch.clientX;
			lastLookPos.y = touch.clientY;

		}

	}

}

function onTouchEnd( e ) {

	e.preventDefault();

	for ( const touch of e.changedTouches ) {

		const target = e.currentTarget;

		if ( touch.identifier === moveTouch ) {

			Touch_ResetJoystick();

		} else if ( touch.identifier === lookTouch ) {

			lookTouch = null;

		} else if ( target === fireButton || target === jumpButton ) {

			// Another finger may still be on the button
			if ( e.targetTouches && e.targetTouches.length > 0 ) continue;
			if ( target === fireButton ) Touch_ReleaseFire();
			else Touch_ReleaseJump();

		}

	}

	// touchend is a user activation (touchstart is not in Chrome), and these
	// controls are only shown while playing a map
	if ( e.type === 'touchend' ) Touch_RequestFullscreen();

}

/*
=================
Touch_SetJoystick

x, y: knob offset as a fraction of the radius (screen axes, y down).
Applies the deadzone (rescaled so movement starts at zero) and the run
threshold (full deflection in that direction, flagged as running).
=================
*/
function Touch_SetJoystick( x, y ) {

	const mag = Math.sqrt( x * x + y * y );

	if ( mag < JOYSTICK_DEADZONE ) {

		moveRight = 0;
		moveForward = 0;
		moveRun = false;
		return;

	}

	// Rescale so speed rises from 0 past the deadzone to 1 at the run
	// threshold, then stays at full deflection while running
	moveRun = mag >= JOYSTICK_RUN_THRESHOLD;
	const scale = moveRun ? 1 / mag : ( mag - JOYSTICK_DEADZONE ) / ( JOYSTICK_RUN_THRESHOLD - JOYSTICK_DEADZONE ) / mag;

	// Note: Y is inverted (up = forward = positive)
	moveRight = x * scale;
	moveForward = - y * scale;

}

function Touch_ResetJoystick() {

	moveTouch = null;
	moveForward = 0;
	moveRight = 0;
	moveRun = false;

	if ( joystickBase !== null ) {

		joystickBase.style.display = 'none';
		joystickKnob.style.left = '50%';
		joystickKnob.style.top = '50%';

	}

}

function Touch_ReleaseFire() {

	if ( fireHeld ) {

		in_attack.state &= ~ 1; // up
		in_attack.state |= 4; // impulse up
		fireHeld = false;

	}

	if ( fireButton !== null ) fireButton.style.background = 'transparent';

}

function Touch_ReleaseJump() {

	if ( jumpHeld ) {

		in_jump.state &= ~ 1; // up
		in_jump.state |= 4; // impulse up
		jumpHeld = false;

	}

	if ( jumpButton !== null ) jumpButton.style.background = 'transparent';

}

/*
=================
Touch_ReleaseButtons

Release FIRE/JUMP if touch is holding them, reset the joystick and look
tracking. Called by Touch_Disable and on focus loss.
=================
*/
export function Touch_ReleaseButtons() {

	Touch_ReleaseFire();
	Touch_ReleaseJump();
	Touch_ResetJoystick();
	lookTouch = null;
	lookDeltaX = 0;
	lookDeltaY = 0;
	menuTouch = null;

}

/*
=================
Gyroscope support

Uses deviceorientation with delta tracking. In fullscreen landscape:
- beta changes when tilting left/right = yaw
- gamma changes when tilting up/down = pitch
=================
*/

function onDeviceOrientation( e ) {

	if ( ! enabled ) return;

	const beta = e.beta;   // X-axis tilt: -180 to 180
	const gamma = e.gamma; // Y-axis tilt: -90 to 90

	if ( beta === null || gamma === null ) return;

	if ( prevBeta !== null && prevGamma !== null ) {

		let dBeta = beta - prevBeta;
		let dGamma = gamma - prevGamma;

		// Clamp deltas - ignore large jumps from gimbal lock or axis flips
		if ( dBeta > 10 || dBeta < - 10 ) dBeta = 0;
		if ( dGamma > 10 || dGamma < - 10 ) dGamma = 0;

		// deviceorientation reports values relative to the device's physical
		// axes, NOT the screen orientation. We must check the actual screen
		// angle and remap accordingly.
		const angle = ( screen.orientation && screen.orientation.angle !== undefined )
			? screen.orientation.angle
			: ( window.orientation || 0 );

		let dYaw, dPitch;

		if ( angle === 90 ) {

			// Landscape: top of phone is on the left
			dYaw = dBeta;
			dPitch = - dGamma;

		} else if ( angle === - 90 || angle === 270 ) {

			// Landscape: top of phone is on the right
			dYaw = - dBeta;
			dPitch = dGamma;

		} else {

			// Portrait (0) or upside-down (180)
			dYaw = dGamma;
			dPitch = dBeta;

		}

		lookDeltaX -= dYaw * GYRO_SENSITIVITY;
		lookDeltaY -= dPitch * GYRO_SENSITIVITY;

	}

	prevBeta = beta;
	prevGamma = gamma;

}

async function Gyro_RequestPermission() {

	if ( gyroPermissionRequested ) return;
	gyroPermissionRequested = true;

	// iOS 13+ requires explicit permission request from a user gesture
	if ( typeof DeviceOrientationEvent !== 'undefined' &&
		typeof DeviceOrientationEvent.requestPermission === 'function' ) {

		try {

			const permission = await DeviceOrientationEvent.requestPermission();
			if ( permission === 'granted' ) {

				Gyro_Enable();

			} else {

				console.log( 'Gyroscope permission denied' );

			}

		} catch ( err ) {

			console.log( 'Gyroscope permission error:', err.message );

		}

	} else {

		// Android and older iOS - no permission needed
		Gyro_Enable();

	}

}

function Gyro_Enable() {

	if ( gyroEnabled ) return;
	gyroEnabled = true;
	prevBeta = null;
	prevGamma = null;
	window.addEventListener( 'deviceorientation', onDeviceOrientation );

}

function Gyro_Disable() {

	if ( ! gyroEnabled ) return;
	gyroEnabled = false;
	prevBeta = null;
	prevGamma = null;
	window.removeEventListener( 'deviceorientation', onDeviceOrientation );

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

	document.addEventListener( 'visibilitychange', onVisibilityChange );
	document.addEventListener( 'fullscreenchange', onFullscreenChange );
	document.addEventListener( 'webkitfullscreenchange', onFullscreenChange );

	initialized = true;

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

	// Add touch listeners
	joystickArea.addEventListener( 'touchstart', onTouchStart, { passive: false } );
	joystickArea.addEventListener( 'touchmove', onTouchMove, { passive: false } );
	joystickArea.addEventListener( 'touchend', onTouchEnd, { passive: false } );
	joystickArea.addEventListener( 'touchcancel', onTouchEnd, { passive: false } );

	lookArea.addEventListener( 'touchstart', onTouchStart, { passive: false } );
	lookArea.addEventListener( 'touchmove', onTouchMove, { passive: false } );
	lookArea.addEventListener( 'touchend', onTouchEnd, { passive: false } );
	lookArea.addEventListener( 'touchcancel', onTouchEnd, { passive: false } );

	fireButton.addEventListener( 'touchstart', onTouchStart, { passive: false } );
	fireButton.addEventListener( 'touchend', onTouchEnd, { passive: false } );
	fireButton.addEventListener( 'touchcancel', onTouchEnd, { passive: false } );

	jumpButton.addEventListener( 'touchstart', onTouchStart, { passive: false } );
	jumpButton.addEventListener( 'touchend', onTouchEnd, { passive: false } );
	jumpButton.addEventListener( 'touchcancel', onTouchEnd, { passive: false } );

	pauseButton.addEventListener( 'touchstart', onTouchStart, { passive: false } );

	// Enable gyroscope if permission was already granted
	if ( gyroPermissionRequested ) {

		Gyro_Enable();

	}

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

	// Remove touch listeners
	joystickArea.removeEventListener( 'touchstart', onTouchStart );
	joystickArea.removeEventListener( 'touchmove', onTouchMove );
	joystickArea.removeEventListener( 'touchend', onTouchEnd );
	joystickArea.removeEventListener( 'touchcancel', onTouchEnd );

	lookArea.removeEventListener( 'touchstart', onTouchStart );
	lookArea.removeEventListener( 'touchmove', onTouchMove );
	lookArea.removeEventListener( 'touchend', onTouchEnd );
	lookArea.removeEventListener( 'touchcancel', onTouchEnd );

	fireButton.removeEventListener( 'touchstart', onTouchStart );
	fireButton.removeEventListener( 'touchend', onTouchEnd );
	fireButton.removeEventListener( 'touchcancel', onTouchEnd );

	jumpButton.removeEventListener( 'touchstart', onTouchStart );
	jumpButton.removeEventListener( 'touchend', onTouchEnd );
	jumpButton.removeEventListener( 'touchcancel', onTouchEnd );

	pauseButton.removeEventListener( 'touchstart', onTouchStart );

	// Disable gyroscope while controls are off
	Gyro_Disable();

	// Release wake lock when not playing
	Touch_ReleaseWakeLock();

	// Release FIRE/JUMP (their touchend will never arrive), reset joystick UI
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

Returns accumulated look delta and clears it
=================
*/
export function Touch_GetLookDelta() {

	_lookDelta.x = lookDeltaX;
	_lookDelta.y = lookDeltaY;
	lookDeltaX = 0;
	lookDeltaY = 0;
	return _lookDelta;

}

/*
=================
Touch_ShowMenu

Show menu touch overlay
=================
*/
export function Touch_ShowMenu() {

	if ( ! initialized || ! menuOverlay ) return;

	menuOverlay.style.display = 'block';

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
