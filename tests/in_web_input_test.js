// Input handling tests for in_web.js / touch.js (port-review IN-1, IN-2, IN-4, IN-5)

// Bootstrap the renderer's existing circular module graph in its safe order.
await import( '../src/gl_rsurf.js' );

const cmd = await import( '../src/cmd.js' );
const keys = await import( '../src/keys.js' );
const cl_input = await import( '../src/cl_input.js' );
const input = await import( '../src/in_web.js' );
const touch = await import( '../src/touch.js' );
const webxr = await import( '../src/webxr.js' );

function assertEqual( actual, expected, message ) {

	if ( actual !== expected )
		throw new Error( `${message}: expected ${JSON.stringify( expected )}, got ${JSON.stringify( actual )}` );

}

// Minimal DOM element / event target
function makeElement( tag ) {

	const listeners = new Map();
	return {
		tagName: tag || 'DIV',
		style: {},
		children: [],
		listeners: listeners,
		textContent: '',
		appendChild( child ) { this.children.push( child ); return child; },
		addEventListener( type, listener ) {

			if ( ! listeners.has( type ) ) listeners.set( type, [] );
			const list = listeners.get( type );
			if ( ! list.includes( listener ) ) list.push( listener );

		},
		removeEventListener( type, listener ) {

			const list = listeners.get( type );
			if ( list && list.includes( listener ) ) list.splice( list.indexOf( listener ), 1 );

		},
		getBoundingClientRect() { return { left: 0, top: 0, width: 640, height: 480 }; },
		fire( type, event ) {

			for ( const l of ( listeners.get( type ) || [] ).slice() ) l( event );

		}
	};

}

function makeEvent( props ) {

	const event = {
		code: '',
		key: '',
		repeat: false,
		ctrlKey: false,
		altKey: false,
		shiftKey: false,
		metaKey: false,
		target: null,
		defaultPrevented: false,
		preventDefault() { this.defaultPrevented = true; }
	};
	return Object.assign( event, props );

}

// Records +test/-test button commands executed through the command buffer
const executed = [];
let commandsRegistered = false;

function registerTestCommands() {

	if ( commandsRegistered ) return;
	commandsRegistered = true;
	cmd.Cbuf_Init();
	for ( const name of [ 'ta', 'tb', 'tc' ] ) {

		cmd.Cmd_AddCommand( '+' + name, () => executed.push( '+' + name ) );
		cmd.Cmd_AddCommand( '-' + name, () => executed.push( '-' + name ) );

	}

}

function run() {

	cmd.Cbuf_Execute();
	const out = executed.slice();
	executed.length = 0;
	return out;

}

// One fake DOM for the whole file: touch.js creates its UI only once per module
const documentTarget = makeElement( 'DOCUMENT' );
const body = makeElement( 'BODY' );
documentTarget.body = body;
documentTarget.pointerLockElement = null;
documentTarget.visibilityState = 'visible';
documentTarget.fullscreenElement = null;
documentTarget.createElement = ( tag ) => makeElement( tag.toUpperCase() );
const windowTarget = makeElement( 'WINDOW' );
windowTarget.innerWidth = 640;
windowTarget.innerHeight = 480;

// Installs fake document/window, runs fn, restores globals
function withFakeDom( fn ) {

	const saved = {};
	for ( const name of [ 'document', 'window', 'matchMedia' ] )
		saved[ name ] = Object.getOwnPropertyDescriptor( globalThis, name );

	Object.defineProperty( globalThis, 'document', { configurable: true, value: documentTarget } );
	Object.defineProperty( globalThis, 'window', { configurable: true, value: windowTarget } );
	// Desktop with a mouse (touchscreen laptop: any-pointer: fine)
	Object.defineProperty( globalThis, 'matchMedia', {
		configurable: true,
		value: ( q ) => ( { matches: q === '(any-pointer: fine)' } )
	} );

	registerTestCommands();
	input.IN_Init( body );
	run();

	try {

		fn( { document: documentTarget, window: windowTarget, body: body } );

	} finally {

		input.IN_Shutdown();
		for ( const name in saved ) {

			if ( saved[ name ] === undefined ) delete globalThis[ name ];
			else Object.defineProperty( globalThis, name, saved[ name ] );

		}

	}

}

function bind( key, binding ) {

	keys.Key_SetBinding( typeof key === 'string' ? key.charCodeAt( 0 ) : key, binding );

}

function unbindAll() {

	for ( let i = 0; i < 256; i ++ ) keys.Key_SetBinding( i, '' );

}

Deno.test( 'IN-5: keyup releases the Quake key pressed on keydown (shifted punctuation)', () => {

	withFakeDom( ( dom ) => {

		unbindAll();
		bind( ':', '+ta' );
		bind( ';', '+tb' );

		dom.document.fire( 'keydown', makeEvent( { code: 'Semicolon', key: ':', shiftKey: true } ) );
		dom.document.fire( 'keyup', makeEvent( { code: 'Semicolon', key: ';' } ) );
		const out = run();
		assertEqual( out.join( ',' ), '+ta,-ta', 'press and release the shifted key' );

		unbindAll();

	} );

} );

Deno.test( 'IN-5: numpad and non-ASCII keys map without aliasing special keys', () => {

	withFakeDom( ( dom ) => {

		unbindAll();
		bind( keys.K_UPARROW, '+ta' );
		bind( keys.K_PAUSE, '+tb' );
		bind( ';', '+tc' );

		// Numpad 8 is the up arrow (vid_win.c scantokey)
		dom.document.fire( 'keydown', makeEvent( { code: 'Numpad8', key: '8' } ) );
		dom.document.fire( 'keyup', makeEvent( { code: 'Numpad8', key: '8' } ) );
		assertEqual( run().join( ',' ), '+ta,-ta', 'numpad 8' );

		// 'ÿ' is 255 = K_PAUSE; it must not press pause
		dom.document.fire( 'keydown', makeEvent( { code: 'IntlRo', key: 'ÿ' } ) );
		dom.document.fire( 'keyup', makeEvent( { code: 'IntlRo', key: 'ÿ' } ) );
		assertEqual( run().join( ',' ), '', 'non-ASCII key without a US fallback' );

		// German 'ö' sits on the Semicolon key: falls back to ';'
		dom.document.fire( 'keydown', makeEvent( { code: 'Semicolon', key: 'ö' } ) );
		dom.document.fire( 'keyup', makeEvent( { code: 'Semicolon', key: 'ö' } ) );
		assertEqual( run().join( ',' ), '+tc,-tc', 'non-ASCII key on a punctuation key' );

		unbindAll();

	} );

} );

Deno.test( 'IN-1: blur, hidden page and Meta release held keys and mouse buttons', () => {

	withFakeDom( ( dom ) => {

		unbindAll();
		bind( 'w', '+ta' );
		bind( keys.K_MOUSE1, '+tb' );

		// blur
		dom.document.fire( 'keydown', makeEvent( { code: 'KeyW', key: 'w' } ) );
		dom.window.fire( 'blur', {} );
		// vid_win.c ClearAllStates sends an up event for every key
		assertEqual( run().join( ',' ), '+ta,-ta,-tb', 'blur releases W' );

		// visibilitychange to hidden
		dom.document.fire( 'keydown', makeEvent( { code: 'KeyW', key: 'w' } ) );
		dom.document.visibilityState = 'hidden';
		dom.document.fire( 'visibilitychange', {} );
		dom.document.visibilityState = 'visible';
		assertEqual( run().join( ',' ), '+ta,-ta,-tb', 'hidden page releases W' );

		// Meta down (macOS drops keyups while Cmd is held)
		dom.document.fire( 'keydown', makeEvent( { code: 'KeyW', key: 'w' } ) );
		dom.document.fire( 'keydown', makeEvent( { code: 'MetaLeft', key: 'Meta', metaKey: true } ) );
		dom.document.fire( 'keydown', makeEvent( { code: 'KeyS', key: 's', metaKey: true } ) );
		assertEqual( run().join( ',' ), '+ta,-ta,-tb', 'Meta releases W, Cmd+S does not reach the game' );

		// Mouse button released outside the canvas (mouseup on window)
		dom.body.fire( 'mousedown', makeEvent( { button: 0 } ) );
		dom.window.fire( 'mouseup', makeEvent( { button: 0 } ) );
		assertEqual( run().join( ',' ), '+tb,-tb', 'mouseup on window' );

		unbindAll();

	} );

} );

Deno.test( 'IN-1: pointer lock loss releases held keys', () => {

	withFakeDom( ( dom ) => {

		unbindAll();
		bind( 'w', '+ta' );

		dom.document.pointerLockElement = dom.body;
		dom.document.fire( 'pointerlockchange', {} );
		// pointer lock loss in game sends Escape (opens the menu); keep it out of the menu code
		keys.set_key_dest( keys.key_console );
		dom.document.fire( 'keydown', makeEvent( { code: 'KeyW', key: 'w' } ) );
		dom.document.pointerLockElement = null;
		dom.document.fire( 'pointerlockchange', {} );
		keys.set_key_dest( keys.key_game );
		assertEqual( run().join( ',' ), '+ta,-ta', 'lock loss releases W' );

		unbindAll();

	} );

} );

Deno.test( 'IN-1/IN-5: browser default actions', () => {

	withFakeDom( ( dom ) => {

		unbindAll();

		const cases = [
			[ { code: 'KeyS', key: 's', ctrlKey: true }, true, 'Ctrl+S' ],
			[ { code: 'KeyF', key: 'f', ctrlKey: true }, true, 'Ctrl+F' ],
			[ { code: 'KeyD', key: 'd', altKey: true }, true, 'Alt+D' ],
			[ { code: 'F5', key: 'F5' }, true, 'F5' ],
			[ { code: 'Slash', key: '/' }, true, '/ (Firefox quick find)' ],
			[ { code: 'Escape', key: 'Escape' }, false, 'Escape' ],
			[ { code: 'F12', key: 'F12' }, false, 'F12' ],
			[ { code: 'KeyI', key: 'I', ctrlKey: true, shiftKey: true }, false, 'Ctrl+Shift+I' ],
			[ { code: 'KeyI', key: 'i', metaKey: true, altKey: true }, false, 'Cmd+Opt+I' ],
			[ { code: 'KeyR', key: 'r', metaKey: true }, false, 'Cmd+R without pointer lock' ]
		];

		for ( const [ props, expected, label ] of cases ) {

			const down = makeEvent( props );
			dom.document.fire( 'keydown', down );
			dom.document.fire( 'keyup', makeEvent( props ) );
			assertEqual( down.defaultPrevented, expected, label );

		}

		const wheel = makeEvent( { deltaY: 1 } );
		dom.body.fire( 'wheel', wheel );
		assertEqual( wheel.defaultPrevented, true, 'wheel' );

		const back = makeEvent( { button: 3 } );
		dom.body.fire( 'mousedown', back );
		assertEqual( back.defaultPrevented, true, 'mouse back button down' );
		const backUp = makeEvent( { button: 3 } );
		dom.window.fire( 'mouseup', backUp );
		assertEqual( backUp.defaultPrevented, true, 'mouse back button up' );

		run();

	} );

} );

Deno.test( 'IN-2: touchscreen laptop starts with the mouse and switches per pointer', () => {

	withFakeDom( ( dom ) => {

		assertEqual( touch.Touch_IsMobile(), false, 'coarse + fine pointer is not mobile' );
		assertEqual( input.IN_IsMobile(), false, 'starts in mouse mode' );

		dom.document.fire( 'pointerdown', { pointerType: 'touch' } );
		assertEqual( input.IN_IsMobile(), true, 'touch switches to touch controls' );

		dom.document.fire( 'pointermove', { pointerType: 'mouse', movementX: 0, movementY: 0 } );
		assertEqual( input.IN_IsMobile(), true, 'a mouse event without movement does not switch' );

		dom.document.fire( 'pointermove', { pointerType: 'mouse', movementX: 3, movementY: 0 } );
		assertEqual( input.IN_IsMobile(), false, 'mouse movement switches back' );

	} );

} );

Deno.test( 'IN-4: Touch_Disable releases FIRE/JUMP; joystick deadzone and run threshold', () => {

	withFakeDom( () => {

		touch.Touch_Init( document.body );
		touch.Touch_Enable();

		const overlay = document.body.children.find( ( c ) => c.id === 'touch-controls' );
		const [ joystickArea, , fireButton, jumpButton ] = overlay.children;

		const touchEvent = ( target, id, x, y ) => ( {
			currentTarget: target,
			type: 'touchstart',
			changedTouches: [ { identifier: id, clientX: x, clientY: y } ],
			preventDefault() {}
		} );

		cl_input.in_attack.state = 0;
		cl_input.in_jump.state = 0;
		fireButton.fire( 'touchstart', touchEvent( fireButton, 1, 0, 0 ) );
		jumpButton.fire( 'touchstart', touchEvent( jumpButton, 2, 0, 0 ) );
		assertEqual( cl_input.in_attack.state & 1, 1, 'FIRE held' );
		assertEqual( cl_input.in_jump.state & 1, 1, 'JUMP held' );

		// Joystick: inside the deadzone
		joystickArea.fire( 'touchstart', touchEvent( joystickArea, 3, 100, 100 ) );
		joystickArea.fire( 'touchmove', touchEvent( joystickArea, 3, 100, 95 ) );
		let move = touch.Touch_GetMoveInput();
		assertEqual( move.forward, 0, 'deadzone forward' );
		assertEqual( move.run, false, 'deadzone run' );

		// Half deflection: walking, rescaled past the deadzone
		joystickArea.fire( 'touchmove', touchEvent( joystickArea, 3, 100, 75 ) );
		move = touch.Touch_GetMoveInput();
		assertEqual( Math.abs( move.forward - ( 0.5 - 0.15 ) / 0.75 ) < 1e-9, true, 'half deflection' );
		assertEqual( move.run, false, 'half deflection walks' );

		// Full deflection backwards: running
		joystickArea.fire( 'touchmove', touchEvent( joystickArea, 3, 100, 160 ) );
		move = touch.Touch_GetMoveInput();
		assertEqual( move.forward, - 1, 'full deflection backwards' );
		assertEqual( move.run, true, 'full deflection runs' );

		touch.Touch_Disable();
		assertEqual( cl_input.in_attack.state & 1, 0, 'FIRE released' );
		assertEqual( cl_input.in_jump.state & 1, 0, 'JUMP released' );
		assertEqual( touch.Touch_GetMoveInput().forward, 0, 'joystick reset' );
		assertEqual( joystickArea.children[ 0 ].style.display, 'none', 'joystick UI hidden' );

		cl_input.in_attack.state = 0;
		cl_input.in_jump.state = 0;

	} );

} );

Deno.test( 'IN-4: wake lock is released if disabled while pending, and re-acquired on visibility', async () => {

	const requests = [];
	const makeLock = () => {

		const lock = makeElement( 'LOCK' );
		lock.released = false;
		lock.release = () => {

			lock.released = true;
			lock.fire( 'release', {} );
			return Promise.resolve();

		};
		return lock;

	};

	Object.defineProperty( navigator, 'wakeLock', {
		configurable: true,
		value: {
			request() {

				let resolve;
				const p = new Promise( ( r ) => { resolve = r; } );
				const lock = makeLock();
				requests.push( { lock, resolve: () => resolve( lock ) } );
				return p;

			}
		}
	} );

	const flush = () => new Promise( ( r ) => setTimeout( r, 0 ) );
	let pending = null;

	try {

		withFakeDom( () => {

			touch.Touch_Init( document.body );
			touch.Touch_Enable();
			assertEqual( requests.length, 1, 'requested on enable' );
			touch.Touch_Disable();
			pending = requests[ 0 ];

		} );

		// The disabled-while-pending lock is released when it arrives
		Object.defineProperty( globalThis, 'document', { configurable: true, value: documentTarget } );
		pending.resolve();
		await flush();
		assertEqual( pending.lock.released, true, 'late lock released' );

		withFakeDom( () => {

			touch.Touch_Enable();

		} );
		Object.defineProperty( globalThis, 'document', { configurable: true, value: documentTarget } );
		requests[ 1 ].resolve();
		await flush();
		assertEqual( requests[ 1 ].lock.released, false, 'lock kept while enabled' );

		// Page hidden: the browser releases the lock; visible again: re-request
		requests[ 1 ].lock.release();
		documentTarget.fire( 'visibilitychange', {} );
		assertEqual( requests.length, 3, 're-requested when visible' );
		requests[ 2 ].resolve();
		await flush();

		withFakeDom( () => {

			touch.Touch_Disable();

		} );
		assertEqual( requests[ 2 ].lock.released, true, 'released on disable' );

	} finally {

		delete navigator.wakeLock;
		delete globalThis.document;

	}

} );

Deno.test( 'IN-3: XR buttons sharing a Quake key keep it held until all are released', () => {

	withFakeDom( () => {

		unbindAll();
		bind( keys.K_SPACE, '+ta' );
		bind( keys.K_MOUSE1, '+tb' );
		keys.set_key_dest( keys.key_game );
		const xr = webxr.xrInput;

		// Hold A, tap the left trigger: jump stays down while A is held
		xr.buttonA = true;
		input.IN_XR_Buttons();
		xr.leftTrigger = 1;
		input.IN_XR_Buttons();
		xr.leftTrigger = 0;
		input.IN_XR_Buttons();
		assertEqual( run().join( ',' ), '+ta', 'jump held while A is down' );
		xr.buttonA = false;
		input.IN_XR_Buttons();
		assertEqual( run().join( ',' ), '-ta', 'jump released with A' );

		// Attack held when the session ends is released
		xr.rightTrigger = 1;
		input.IN_XR_Buttons();
		input.IN_ClearAllStates();
		assertEqual( run().join( ',' ), '+tb,-ta,-tb', 'attack released once on clear (every key gets an up)' );
		xr.rightTrigger = 0;
		input.IN_XR_Buttons();
		assertEqual( run().join( ',' ), '', 'no second release' );

		// A button held across a key_dest change sends nothing new until
		// it is pressed again (no key in the console, attack in game)
		keys.set_key_dest( keys.key_console );
		xr.rightTrigger = 1;
		input.IN_XR_Buttons();
		keys.set_key_dest( keys.key_game );
		input.IN_XR_Buttons();
		assertEqual( run().join( ',' ), '', 'held trigger does not fire after leaving the console' );
		xr.rightTrigger = 0;
		input.IN_XR_Buttons();
		xr.rightTrigger = 1;
		input.IN_XR_Buttons();
		xr.rightTrigger = 0;
		input.IN_XR_Buttons();
		assertEqual( run().join( ',' ), '+tb,-tb', 'a new press fires' );

		unbindAll();

	} );

} );

Deno.test( 'IN-2: switching to touch under pointer lock clears keys now, not on the later lock change', () => {

	withFakeDom( ( dom ) => {

		unbindAll();
		bind( 'w', '+ta' );
		keys.set_key_dest( keys.key_game );

		let exited = false;
		dom.document.exitPointerLock = () => { exited = true; };
		dom.document.pointerLockElement = dom.body;
		dom.document.fire( 'pointerlockchange', {} );
		dom.document.fire( 'keydown', makeEvent( { code: 'KeyW', key: 'w' } ) );

		dom.document.fire( 'pointerdown', { pointerType: 'touch' } );
		assertEqual( exited, true, 'pointer lock dropped' );
		assertEqual( run().join( ',' ), '+ta,-ta', 'W released at the switch' );

		// A finger lands on JUMP before the lock change arrives
		touch.Touch_Enable();
		const overlay = document.body.children.find( ( c ) => c.id === 'touch-controls' );
		const jumpButton = overlay.children[ 3 ];
		cl_input.in_jump.state = 0;
		jumpButton.fire( 'touchstart', {
			currentTarget: jumpButton, type: 'touchstart',
			changedTouches: [ { identifier: 7, clientX: 0, clientY: 0 } ], preventDefault() {}
		} );

		dom.document.pointerLockElement = null;
		dom.document.fire( 'pointerlockchange', {} );
		assertEqual( cl_input.in_jump.state & 1, 1, 'JUMP still held after the lock change' );
		assertEqual( keys.key_dest, keys.key_game, 'no menu opened' );

		touch.Touch_Disable();
		delete dom.document.exitPointerLock;
		dom.document.fire( 'pointermove', { pointerType: 'mouse', movementX: 3, movementY: 0 } );
		cl_input.in_jump.state = 0;
		run();
		unbindAll();

	} );

} );

Deno.test( 'IN-4: FIRE stays held while another finger is still on it', () => {

	withFakeDom( () => {

		touch.Touch_Init( document.body );
		touch.Touch_Enable();
		const overlay = document.body.children.find( ( c ) => c.id === 'touch-controls' );
		const fireButton = overlay.children[ 2 ];

		const ev = ( type, id, still ) => ( {
			currentTarget: fireButton, type: type,
			changedTouches: [ { identifier: id, clientX: 0, clientY: 0 } ],
			targetTouches: still.map( ( i ) => ( { identifier: i } ) ),
			preventDefault() {}
		} );

		cl_input.in_attack.state = 0;
		fireButton.fire( 'touchstart', ev( 'touchstart', 1, [ 1 ] ) );
		fireButton.fire( 'touchstart', ev( 'touchstart', 2, [ 1, 2 ] ) );
		fireButton.fire( 'touchcancel', ev( 'touchcancel', 1, [ 2 ] ) );
		assertEqual( cl_input.in_attack.state & 1, 1, 'still firing with one finger left' );
		fireButton.fire( 'touchcancel', ev( 'touchcancel', 2, [] ) );
		assertEqual( cl_input.in_attack.state & 1, 0, 'released with the last finger' );

		touch.Touch_Disable();
		cl_input.in_attack.state = 0;

	} );

} );

Deno.test( 'IN-5: autorepeat keeps one key; keyup of a Cmd-held key still releases', () => {

	withFakeDom( ( dom ) => {

		unbindAll();
		bind( 'w', '+ta' );
		keys.set_key_dest( keys.key_game );

		dom.document.fire( 'keydown', makeEvent( { code: 'KeyW', key: 'w' } ) );
		dom.document.fire( 'keydown', makeEvent( { code: 'KeyW', key: 'W', repeat: true, shiftKey: true } ) );
		dom.document.fire( 'keyup', makeEvent( { code: 'KeyW', key: 'W', shiftKey: true } ) );
		assertEqual( run().join( ',' ), '+ta,-ta', 'repeat with a different key value releases W once' );

		dom.document.fire( 'keydown', makeEvent( { code: 'KeyW', key: 'w', metaKey: true } ) );
		dom.document.fire( 'keyup', makeEvent( { code: 'KeyW', key: 'w', metaKey: true } ) );
		assertEqual( run().join( ',' ), '', 'Cmd+W is not passed to the game' );

		unbindAll();

	} );

} );
