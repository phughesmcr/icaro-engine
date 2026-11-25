// WebXR support for Icaro Engine
// Provides VR rendering via Three.js WebXR integration

import * as THREE from 'three';
import { renderer } from './vid.js';
import { Draw_GetOverlayCanvas } from './gl_draw.js';

//============================================================================
// Constants
//============================================================================

// Quake units per meter. Tuned so that a 1.7m-tall user maps to ~56 Quake
// units (the player collision hull height), making enemies, doorways, and
// hallways feel correctly proportioned in VR.
export const XR_SCALE = 30;

// Floor to eye height of a standing Quake player: hull mins[2] (-24) to the
// default view height (+22). With a 'local-floor' reference space the XR
// origin is on the floor, so the camera and controllers are lowered by this
// much and the rig position (vieworg, set by gl_rmain.js) stays at eye level.
const XR_FLOOR_TO_EYE = 46;

// 2D overlay (menu, console, HUD) quad in front of the headset, in meters
const XR_HUD_DISTANCE = 1.5;
const XR_HUD_WIDTH = 1.6;

// Shortest time between HUD texture uploads, in seconds. The overlay canvas is
// window size times DPR and is redrawn every frame, so uploading it at the
// headset's 72-120 Hz costs far more than the 2D view needs. A resized
// canvas, a new texture and the first frame after the HUD is shown always
// upload at once.
const XR_HUD_UPLOAD_INTERVAL = 1 / 30;

//============================================================================
// Pre-allocated temp objects (Golden Rule #4)
//============================================================================

const _controllerWorldQuat = new THREE.Quaternion();
const _aimForward = new THREE.Vector3();

//============================================================================
// State
//============================================================================

let _rendererOverride = null;
let _overlayCanvasOverride = null;
let _nowOverride = null; // test clock, in seconds
let T = THREE; // THREE, or a test stub
function R() {

	return _rendererOverride != null ? _rendererOverride : renderer;

}

let xrSessionActive = false;
let xrRig = null; // THREE.Group — NOT in scene, positioned at vieworg/XR_SCALE each frame
let xrOffset = null; // child of xrRig holding camera and controllers (floor offset)
const controllers = [ null, null ]; // targetRay (pointer) spaces for input slots 0 and 1
let aimController = null; // controller used for aiming: the right hand if present
let _scene = null; // scene reference for scale toggling
let _onSessionEnd = null; // in_web.js releases held XR buttons
let _enterButton = null; // "Enter VR" button for browsers without offerSession

// 2D overlay quad. It lives in its own scene, drawn after the world by
// XR_RenderHUD (see there).
let hudScene = null;
let hudMesh = null;
let hudTexture = null;
let hudCanvasWidth = 0;
let hudCanvasHeight = 0;
let hudOffset = null; // THREE.Matrix4: head space → quad
let hudUploadTime = - Infinity; // seconds; -Infinity forces the next upload

// Input state — polled each frame by XR_PollInput(), consumed by in_web.js
export const xrInput = {
	moveX: 0,       // left thumbstick X (-1 to 1)
	moveY: 0,       // left thumbstick Y (-1 to 1, negative = forward)
	lookX: 0,       // right thumbstick X (-1 to 1)
	lookY: 0,       // right thumbstick Y (-1 to 1)
	leftTrigger: 0, // left trigger (0 to 1)
	rightTrigger: 0, // right trigger (0 to 1)
	leftSqueeze: false,
	rightSqueeze: false,
	buttonA: false, // right controller lower face button
	buttonB: false, // right controller upper face button
	buttonX: false, // left controller lower face button
	buttonY: false  // left controller upper face button
};

//============================================================================
// Public API
//============================================================================

export function isXRActive() {

	return xrSessionActive;

}

export function getXRRig() {

	return xrRig;

}

// Test seam: lets tests supply a fake renderer, THREE, overlay canvas and
// clock (browser_shim.js has no WebGLRenderer or PlaneGeometry). Call with
// no argument to restore.
export function XR_SetTestOverrides( overrides ) {

	_rendererOverride = overrides != null && overrides.renderer != null ? overrides.renderer : null;
	T = overrides != null && overrides.THREE != null ? overrides.THREE : THREE;
	_overlayCanvasOverride = overrides != null && overrides.overlayCanvas != null ? overrides.overlayCanvas : null;
	_nowOverride = overrides != null && overrides.now != null ? overrides.now : null;

	// The HUD objects belong to the THREE they were made with
	hudScene = null;
	hudMesh = null;
	hudTexture = null;
	hudCanvasWidth = 0;
	hudCanvasHeight = 0;

}

function _now() {

	return _nowOverride != null ? _nowOverride() : performance.now() / 1000;

}

// Called with no arguments when the XR session ends
export function XR_SetSessionEndCallback( callback ) {

	_onSessionEnd = callback;

}

//============================================================================
// XR_Init
//
// Called after Host_Init when renderer and scene are ready.
// Creates the camera rig, sets up controllers, and offers VR session.
//
// The rig is NOT added to the scene. Instead, the scene is scaled down
// by 1/XR_SCALE when XR is active, putting everything in meter space.
// The rig (also in meter space) is positioned at vieworg / XR_SCALE.
// This way the XR camera and scene content are in the same units.
//============================================================================

export function XR_Init( scene ) {

	if ( R() == null ) return;

	_scene = scene;

	// Enable XR on the renderer. The reference space type is chosen per
	// session in _onSessionStarted ('local-floor', falling back to 'local').
	R().xr.enabled = true;
	R().xr.setReferenceSpaceType( 'local' );

	// Create camera rig — NOT a child of scene.
	// Positioned at vieworg / XR_SCALE (meters) each frame.
	// Three.js XR composes: rig.matrixWorld × offset × camera.matrix (headset pose).
	xrRig = new T.Group();
	xrOffset = new T.Group();
	xrRig.add( xrOffset );

	// Controller targetRay (pointer) spaces. Slot order is not handedness
	// order, so record each slot's hand when it connects.
	for ( let i = 0; i < 2; i ++ ) {

		const controller = R().xr.getController( i );
		controller.userData.handedness = '';

		controller.addEventListener( 'connected', function ( event ) {

			controller.userData.handedness = event.data != null ? event.data.handedness : 'none';
			_pickAimController();

		} );

		controller.addEventListener( 'disconnected', function () {

			controller.userData.handedness = '';
			_pickAimController();

		} );

		controllers[ i ] = controller;
		xrOffset.add( controller );

	}

	// Session lifecycle
	R().xr.addEventListener( 'sessionstart', function () {

		xrSessionActive = true;

		// Scale scene to meters so it matches XR coordinate space
		if ( _scene != null ) _scene.scale.setScalar( 1 / XR_SCALE );

		_showHUD();
		if ( _enterButton != null ) _enterButton.style.display = 'none';

	} );

	R().xr.addEventListener( 'sessionend', function () {

		xrSessionActive = false;

		// Restore scene scale for non-XR rendering
		if ( _scene != null ) _scene.scale.setScalar( 1 );

		_hideHUD();

		// Release triggers and buttons held when the session ended
		if ( _onSessionEnd != null ) _onSessionEnd();

		_resetInput();

		if ( _enterButton != null ) _enterButton.style.display = '';
		_offerSession();

	} );

	_offerSession();

}

//============================================================================
// XR_SetCamera
//
// Parents the camera to the XR rig. Called once when the camera is first
// created in R_SetupGL. In non-XR mode the parent doesn't matter because
// camera.matrixAutoUpdate is false and matrixWorld is set directly.
// In XR mode, Three.js composes: rig.matrixWorld × camera.matrix (headset pose).
//============================================================================

export function XR_SetCamera( camera ) {

	if ( xrOffset != null && camera != null && camera.parent !== xrOffset ) {

		xrOffset.add( camera );

	}

}

//============================================================================
// XR_PollInput
//
// Reads controller gamepad state each frame. Called from IN_Commands().
// Left controller: thumbstick → movement, trigger, squeeze, X, Y
// Right controller: thumbstick → turn, trigger, squeeze, A, B
// (xr-standard mapping: buttons 0 trigger, 1 squeeze, 4/5 face buttons)
//============================================================================

function _resetInput() {

	xrInput.moveX = 0;
	xrInput.moveY = 0;
	xrInput.lookX = 0;
	xrInput.lookY = 0;
	xrInput.leftTrigger = 0;
	xrInput.rightTrigger = 0;
	xrInput.leftSqueeze = false;
	xrInput.rightSqueeze = false;
	xrInput.buttonA = false;
	xrInput.buttonB = false;
	xrInput.buttonX = false;
	xrInput.buttonY = false;

}

function _buttonValue( gp, index ) {

	const b = gp.buttons[ index ];
	return b != null ? b.value : 0;

}

function _buttonPressed( gp, index ) {

	const b = gp.buttons[ index ];
	return b != null && b.pressed === true;

}

export function XR_PollInput() {

	_resetInput();

	if ( xrSessionActive === false ) return;

	const session = R().xr.getSession();
	if ( session == null ) return;

	for ( const source of session.inputSources ) {

		if ( source.gamepad == null ) continue;

		const gp = source.gamepad;

		// Thumbstick axes (xr-standard: axes[2]=X, axes[3]=Y)
		// Some controllers use axes[0]/[1] instead
		let sx = 0;
		let sy = 0;

		if ( gp.axes.length >= 4 ) {

			sx = gp.axes[ 2 ];
			sy = gp.axes[ 3 ];

		} else if ( gp.axes.length >= 2 ) {

			sx = gp.axes[ 0 ];
			sy = gp.axes[ 1 ];

		}

		if ( source.handedness === 'left' ) {

			xrInput.moveX = sx;
			xrInput.moveY = sy;
			xrInput.leftTrigger = _buttonValue( gp, 0 );
			xrInput.leftSqueeze = _buttonPressed( gp, 1 );
			xrInput.buttonX = _buttonPressed( gp, 4 );
			xrInput.buttonY = _buttonPressed( gp, 5 );

		} else if ( source.handedness === 'right' ) {

			xrInput.lookX = sx;
			xrInput.lookY = sy;
			xrInput.rightTrigger = _buttonValue( gp, 0 );
			xrInput.rightSqueeze = _buttonPressed( gp, 1 );
			xrInput.buttonA = _buttonPressed( gp, 4 );
			xrInput.buttonB = _buttonPressed( gp, 5 );

		}

	}

}

//============================================================================
// XR_UpdateHUD
//
// Uploads the 2D overlay canvas (menu, console, HUD) to the headset quad.
// Called from IN_Commands(), before SCR_UpdateScreen clears the canvas, so
// the canvas holds the previous frame's complete 2D drawing.
//============================================================================

export function XR_UpdateHUD() {

	if ( xrSessionActive === false || hudMesh == null ) return;

	const canvas = _overlayCanvasOverride != null ? _overlayCanvasOverride : Draw_GetOverlayCanvas();
	if ( canvas == null || canvas.width === 0 || canvas.height === 0 ) return;

	// A resized canvas needs a new GPU texture
	if ( hudTexture == null || canvas !== hudTexture.image ||
		canvas.width !== hudCanvasWidth || canvas.height !== hudCanvasHeight ) {

		if ( hudTexture != null ) hudTexture.dispose();

		hudTexture = new T.CanvasTexture( canvas );
		hudTexture.colorSpace = T.SRGBColorSpace;
		hudTexture.minFilter = T.LinearFilter;
		hudTexture.generateMipmaps = false;

		// Only going from no map to a map changes the shader program. Swapping
		// one map for another needs no recompile.
		if ( hudMesh.material.map == null ) hudMesh.material.needsUpdate = true;
		hudMesh.material.map = hudTexture;
		hudUploadTime = - Infinity;

		hudCanvasWidth = canvas.width;
		hudCanvasHeight = canvas.height;

		const height = XR_HUD_WIDTH * canvas.height / canvas.width;
		hudOffset.makeScale( XR_HUD_WIDTH, height, 1 ).setPosition( 0, 0, - XR_HUD_DISTANCE );

	}

	// The canvas is redrawn every frame, but upload it at a capped rate
	const now = _now();
	if ( now - hudUploadTime >= XR_HUD_UPLOAD_INTERVAL ) {

		hudUploadTime = now;
		hudTexture.needsUpdate = true;
		R().initTexture( hudTexture );

	}

	hudMesh.visible = true;

}

//============================================================================
// XR_RenderHUD
//
// Called by R_RenderView after the world render, while XR is presenting.
// The renderer has sortObjects = false (the BSP order is kept), so a
// renderOrder on a quad in the world scene is ignored, and particles or
// entity meshes added after it draw over it. A second render of a scene
// that holds only the quad puts it on top.
//
// Rendering twice into the XR framebuffer in one frame is safe here because
// vid.js creates the renderer with antialias: false. The XR render target
// then has no samples, so r183's multisample resolve at the end of render()
// (which invalidates the colour attachment) does not run. The HUD scene has
// no background and autoClear is false, so the second render clears nothing.
//============================================================================

export function XR_RenderHUD( camera ) {

	if ( xrSessionActive === false || hudMesh == null || hudMesh.visible === false ) return;

	R().render( hudScene, camera );

}

// Head-locked: pose the quad from this frame's XR camera, just before it
// is drawn. matrixWorld is set directly, in meters like the XR camera (the
// HUD scene is not scaled by 1/XR_SCALE as the world scene is).
function _poseHUD() {

	const xrCamera = R().xr.getCamera();
	hudMesh.matrixWorld.multiplyMatrices( xrCamera.matrixWorld, hudOffset );

}

function _showHUD() {

	if ( _scene == null ) return;

	if ( hudMesh == null ) {

		hudScene = new T.Scene();
		hudOffset = new T.Matrix4();

		const material = new T.MeshBasicMaterial( {
			transparent: true,
			depthTest: false,
			depthWrite: false,
			toneMapped: false
		} );

		hudMesh = new T.Mesh( new T.PlaneGeometry( 1, 1 ), material );
		hudMesh.frustumCulled = false;
		hudMesh.matrixAutoUpdate = false;
		hudMesh.matrixWorldAutoUpdate = false;
		hudMesh.onBeforeRender = _poseHUD;

	}

	// Hidden until the first upload, which happens at once
	hudMesh.visible = false;
	hudUploadTime = - Infinity;
	hudScene.add( hudMesh );

}

function _hideHUD() {

	if ( hudMesh == null ) return;

	if ( hudMesh.parent != null ) hudMesh.parent.remove( hudMesh );

	if ( hudTexture != null ) {

		hudTexture.dispose();
		hudTexture = null;
		hudMesh.material.map = null;

	}

}

//============================================================================
// Aim controller
//============================================================================

function _pickAimController() {

	aimController = null;

	// Prefer the right hand; otherwise any connected controller
	for ( const controller of controllers ) {

		if ( controller != null && controller.userData.handedness === 'right' ) {

			aimController = controller;
			return;

		}

	}

	for ( const controller of controllers ) {

		if ( controller != null && controller.userData.handedness !== '' ) {

			aimController = controller;
			return;

		}

	}

}

//============================================================================
// XR_GetControllerWorldPose
//
// Returns the aim controller's world-space position and quaternion.
// With scene.scale = 1/XR_SCALE, the position is in meters.
// The caller converts to scene-local Quake units by multiplying by XR_SCALE.
//
// Returns false if controller or XR is not available.
//============================================================================

export function XR_GetControllerWorldPose( outPos, outQuat ) {

	if ( xrSessionActive === false ) return false;
	if ( aimController == null ) return false;
	if ( xrRig == null ) return false;

	// getWorldPosition/getWorldQuaternion call updateWorldMatrix internally
	aimController.getWorldPosition( outPos );
	aimController.getWorldQuaternion( outQuat );

	return true;

}

//============================================================================
// XR_GetAimAngles
//
// Computes Quake pitch/yaw angles from the controller's aiming direction.
// The controller's world quaternion (which includes the rig's XR→Quake
// rotation) gives us the forward direction in Quake world space.
// We then reverse AngleVectors to get pitch and yaw.
//
// Used by CL_SendMove to send aim direction to the server so weapons
// fire where the controller points, not where the head looks.
//
// Returns false if XR is not active.
//============================================================================

export function XR_GetAimAngles( outAngles ) {

	if ( xrSessionActive === false ) return false;
	if ( aimController == null ) return false;
	if ( xrRig == null ) return false;

	// Get controller world quaternion (includes rig rotation = Quake space)
	aimController.getWorldQuaternion( _controllerWorldQuat );

	// Forward direction = quaternion applied to targetRay forward [0, 0, -1]
	_aimForward.set( 0, 0, - 1 ).applyQuaternion( _controllerWorldQuat );

	const fx = _aimForward.x;
	const fy = _aimForward.y;
	const fz = _aimForward.z;

	// Reverse of AngleVectors:
	//   forward[0] = cos(pitch) * cos(yaw)
	//   forward[1] = cos(pitch) * sin(yaw)
	//   forward[2] = -sin(pitch)
	outAngles[ 1 ] = Math.atan2( fy, fx ) * 180 / Math.PI; // YAW
	outAngles[ 0 ] = Math.atan2( - fz, Math.sqrt( fx * fx + fy * fy ) ) * 180 / Math.PI; // PITCH
	outAngles[ 2 ] = 0; // ROLL

	return true;

}

//============================================================================
// Internal: start a VR session
//
// Browsers with navigator.xr.offerSession (Quest Browser) show their own
// "Enter VR" UI. Elsewhere, if immersive VR is supported, a button calls
// requestSession from its click (a user activation).
//============================================================================

const _sessionInit = {
	requiredFeatures: [ 'local' ],
	optionalFeatures: [ 'local-floor' ]
};

function _offerSession() {

	if ( typeof navigator === 'undefined' || ! ( 'xr' in navigator ) || navigator.xr == null ) return;

	if ( navigator.xr.offerSession == null ) {

		_createEnterButton();
		return;

	}

	navigator.xr.offerSession( 'immersive-vr', _sessionInit )
		.then( _onSessionStarted )
		.catch( function ( err ) {

			// Rejected when the user dismisses the offer or another session is active
			console.log( 'WebXR offerSession failed:', err && err.message );

		} );

}

function _createEnterButton() {

	if ( _enterButton != null || typeof document === 'undefined' ) return;
	if ( navigator.xr.isSessionSupported == null ) return;

	navigator.xr.isSessionSupported( 'immersive-vr' ).then( function ( supported ) {

		if ( ! supported || _enterButton != null ) return;

		_enterButton = document.createElement( 'button' );
		_enterButton.textContent = 'ENTER VR';
		_enterButton.style.cssText = `
			position: fixed;
			left: 20px;
			bottom: 20px;
			z-index: 150;
			padding: 8px 14px;
			font-family: sans-serif;
			font-size: 13px;
			color: #fff;
			background: rgba(0, 0, 0, 0.6);
			border: 1px solid rgba(255, 255, 255, 0.6);
			border-radius: 4px;
			cursor: pointer;
		`;

		_enterButton.addEventListener( 'click', function () {

			if ( xrSessionActive ) return;

			navigator.xr.requestSession( 'immersive-vr', _sessionInit )
				.then( _onSessionStarted )
				.catch( function ( err ) {

					console.log( 'WebXR requestSession failed:', err && err.message );

				} );

		} );

		document.body.appendChild( _enterButton );

	} ).catch( function () {} );

}

async function _onSessionStarted( session ) {

	// Prefer a floor-level origin so the real floor matches the Quake floor
	let floor = false;

	try {

		await session.requestReferenceSpace( 'local-floor' );
		floor = true;

	} catch {

		// 'local-floor' not granted: use 'local' (origin at the starting head position)

	}

	try {

		R().xr.setReferenceSpaceType( floor ? 'local-floor' : 'local' );
		xrOffset.position.set( 0, floor ? - XR_FLOOR_TO_EYE / XR_SCALE : 0, 0 );
		await R().xr.setSession( session );

	} catch ( err ) {

		console.log( 'WebXR session setup failed:', err && err.message );
		session.end().catch( function () {} );
		if ( ! xrSessionActive ) _offerSession();

	}

}
