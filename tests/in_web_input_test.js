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

// Installs fake document/window, runs fn, restores globals.
// fn may be async: the globals are restored once its promise settles.
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

	const cleanup = () => {

		input.IN_Shutdown();
		for ( const name in saved ) {

			if ( saved[ name ] === undefined ) delete globalThis[ name ];
			else Object.defineProperty( globalThis, name, saved[ name ] );

		}

	};

	let result;
	try {

		result = fn( { document: documentTarget, window: windowTarget, body: body } );

	} catch ( e ) {

		cleanup();
		throw e;

	}

	if ( result != null && typeof result.then === 'function' ) return result.finally( cleanup );
	cleanup();
	return result;

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
			[ { code: 'KeyS', key: 's', ctrlKey: true }, false, 'Ctrl+S without pointer lock' ],
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

		// In game with pointer lock the game owns Ctrl/Alt chords
		keys.set_key_dest( keys.key_game );
		dom.document.pointerLockElement = dom.body;
		dom.document.fire( 'pointerlockchange', {} );
		const owned = [
			[ { code: 'KeyS', key: 's', ctrlKey: true }, true, 'Ctrl+S in game' ],
			[ { code: 'KeyF', key: 'f', ctrlKey: true }, true, 'Ctrl+F in game' ],
			[ { code: 'KeyW', key: 'w', ctrlKey: true }, true, 'Ctrl+W in game' ],
			[ { code: 'KeyD', key: 'd', altKey: true }, true, 'Alt+D in game' ],
			[ { code: 'AltLeft', key: 'Alt' }, true, 'Alt alone (Firefox menu bar)' ],
			[ { code: 'F13', key: 'F13', ctrlKey: true }, false, 'Ctrl chord on an unmapped key' ],
			[ { code: 'KeyI', key: 'I', ctrlKey: true, shiftKey: true }, false, 'Ctrl+Shift+I in game' ]
		];
		for ( const [ props, expected, label ] of owned ) {

			const down = makeEvent( props );
			dom.document.fire( 'keydown', down );
			dom.document.fire( 'keyup', makeEvent( props ) );
			assertEqual( down.defaultPrevented, expected, label );

		}

		// In the menu or console the browser keeps its Ctrl/Alt shortcuts
		keys.set_key_dest( keys.key_console );
		for ( const props of [ { code: 'KeyR', key: 'r', ctrlKey: true }, { code: 'ArrowLeft', key: 'ArrowLeft', altKey: true } ] ) {

			const down = makeEvent( props );
			dom.document.fire( 'keydown', down );
			dom.document.fire( 'keyup', makeEvent( props ) );
			assertEqual( down.defaultPrevented, false, 'chord outside the game: ' + props.code );

		}

		// ...but the game still receives the chord when the key is bound
		keys.set_key_dest( keys.key_game );
		bind( 'w', '+ta' );
		run();
		dom.document.fire( 'keydown', makeEvent( { code: 'KeyW', key: 'w', ctrlKey: true } ) );
		dom.document.fire( 'keyup', makeEvent( { code: 'KeyW', key: 'w', ctrlKey: true } ) );
		assertEqual( run().join( ',' ), '+ta,-ta', 'Ctrl+W reaches the game' );
		unbindAll();

		keys.set_key_dest( keys.key_console );
		dom.document.pointerLockElement = null;
		dom.document.fire( 'pointerlockchange', {} );
		keys.set_key_dest( keys.key_game );
		run();

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

Deno.test( 'IN-1: keyboard lock is requested in game and released in the menu', async () => {

	await withFakeDom( async ( dom ) => {

		const calls = [];
		let rejectNext = false;
		Object.defineProperty( globalThis, 'navigator', {
			configurable: true,
			value: {
				keyboard: {
					lock( codes ) {

						calls.push( [ 'lock', codes ] );
						const r = rejectNext ? Promise.reject( new Error( 'no' ) ) : Promise.resolve();
						rejectNext = false;
						return r;

					},
					unlock() { calls.push( [ 'unlock' ] ); }
				}
			}
		} );

		try {

			unbindAll();
			keys.set_key_dest( keys.key_game );
			dom.document.pointerLockElement = dom.body;
			dom.document.fire( 'pointerlockchange', {} );
			assertEqual( calls.length, 1, 'locked once' );
			assertEqual( calls[ 0 ][ 0 ], 'lock', 'lock' );
			assertEqual( calls[ 0 ][ 1 ].includes( 'KeyW' ), true, 'W is locked (Ctrl+W)' );
			assertEqual( calls[ 0 ][ 1 ].includes( 'Escape' ), false, 'Escape stays the way out' );
			assertEqual( calls[ 0 ][ 1 ].includes( 'F12' ), false, 'F12 stays free' );

			dom.document.fire( 'keydown', makeEvent( { code: 'KeyA', key: 'a' } ) );
			dom.document.fire( 'keyup', makeEvent( { code: 'KeyA', key: 'a' } ) );
			assertEqual( calls.length, 1, 'no repeated lock' );

			// Menu opened: released
			keys.set_key_dest( keys.key_menu );
			dom.document.fire( 'keydown', makeEvent( { code: 'KeyA', key: 'a' } ) );
			dom.document.fire( 'keyup', makeEvent( { code: 'KeyA', key: 'a' } ) );
			assertEqual( calls.length, 2, 'unlocked in the menu' );
			assertEqual( calls[ 1 ][ 0 ], 'unlock', 'unlock' );

			// Fullscreen without pointer lock also counts as owning the keyboard
			dom.document.pointerLockElement = null;
			dom.document.fire( 'pointerlockchange', {} );
			keys.set_key_dest( keys.key_game );
			dom.document.fullscreenElement = dom.body;
			dom.document.fire( 'fullscreenchange', {} );
			assertEqual( calls.length, 3, 'locked in fullscreen' );
			dom.document.fullscreenElement = null;
			dom.document.fire( 'fullscreenchange', {} );
			assertEqual( calls.length, 4, 'unlocked on leaving fullscreen' );

			// A rejected lock is retried on the next change
			rejectNext = true;
			dom.document.fullscreenElement = dom.body;
			dom.document.fire( 'fullscreenchange', {} );
			await flush();
			assertEqual( calls.length, 5, 'lock attempted' );
			dom.document.fire( 'fullscreenchange', {} );
			assertEqual( calls.length, 6, 'retried after the rejection' );

		} finally {

			delete globalThis.navigator;
			dom.document.fullscreenElement = null;
			dom.document.pointerLockElement = null;
			unbindAll();

		}

	} );

} );

Deno.test( 'IN-5: every numpad code maps as WinQuake scantokey does', () => {

	withFakeDom( ( dom ) => {

		unbindAll();
		const expected = {
			Numpad7: keys.K_HOME, Numpad8: keys.K_UPARROW, Numpad9: keys.K_PGUP,
			Numpad4: keys.K_LEFTARROW, Numpad6: keys.K_RIGHTARROW,
			Numpad1: keys.K_END, Numpad2: keys.K_DOWNARROW, Numpad3: keys.K_PGDN,
			Numpad0: keys.K_INS, NumpadDecimal: keys.K_DEL, NumpadEnter: keys.K_ENTER,
			Numpad5: 53, NumpadAdd: 43, NumpadSubtract: 45, NumpadDivide: 47, NumpadMultiply: 42
		};
		for ( const code in expected ) {

			bind( expected[ code ], '+ta' );
			// NumLock state must not matter: key is a digit or a navigation name
			for ( const key of [ '5', 'Home' ] ) {

				dom.document.fire( 'keydown', makeEvent( { code, key } ) );
				dom.document.fire( 'keyup', makeEvent( { code, key } ) );
				assertEqual( run().join( ',' ), '+ta,-ta', code + ' with key ' + key );

			}
			bind( expected[ code ], '' );

		}

		unbindAll();

	} );

} );

//============================================================================
// Residual coverage: XR, touch menu, fullscreen race, touch run speed
//============================================================================

const host = await import( '../src/host.js' );
const cvarModule = await import( '../src/cvar.js' );
const client = await import( '../src/client.js' );

function deferred() {

	let resolve, reject;
	const promise = new Promise( ( res, rej ) => { resolve = res; reject = rej; } );
	return { promise, resolve, reject };

}

const flush = () => new Promise( ( r ) => setTimeout( r, 0 ) );

// Fake THREE objects (browser_shim.js has no PlaneGeometry or WebGLRenderer)
function makeFakeThree() {

	const created = { textures: [] };
	class Group {

		constructor() {

			this.children = [];
			this.parent = null;
			this.userData = {};
			this.position = { x: 0, y: 0, z: 0, set( x, y, z ) { this.x = x; this.y = y; this.z = z; } };
			this.scale = { value: 1, setScalar( v ) { this.value = v; } };

		}
		add( o ) { this.children.push( o ); o.parent = this; }
		remove( o ) { this.children.splice( this.children.indexOf( o ), 1 ); o.parent = null; }

	}
	class Matrix4 {

		makeScale( x, y, z ) { this.scaled = [ x, y, z ]; return this; }
		setPosition( x, y, z ) { this.moved = [ x, y, z ]; return this; }
		multiplyMatrices() { return this; }

	}
	class Mesh {

		constructor( geometry, material ) { this.geometry = geometry; this.material = material; this.visible = true; this.parent = null; }

	}
	class MeshBasicMaterial {

		constructor( params ) { Object.assign( this, params ); this.map = null; }

	}
	class PlaneGeometry {}
	class CanvasTexture {

		constructor( image ) { this.image = image; this.disposed = false; created.textures.push( this ); }
		dispose() { this.disposed = true; }

	}
	return { THREE: { Group, Matrix4, Mesh, MeshBasicMaterial, PlaneGeometry, CanvasTexture, SRGBColorSpace: 'srgb', LinearFilter: 1006 }, created };

}

function makeFakeController( name ) {

	const listeners = {};
	return {
		name,
		userData: {},
		addEventListener( type, l ) { ( listeners[ type ] ||= [] ).push( l ); },
		dispatch( type, data ) { for ( const l of listeners[ type ] || [] ) l( { type, data } ); },
		getWorldPosition( out ) { out.from = name; },
		getWorldQuaternion( out ) { out.from = name; }
	};

}

function makeFakeXRRenderer() {

	const listeners = {};
	const controllers = [ makeFakeController( 'slot0' ), makeFakeController( 'slot1' ) ];
	const fire = ( type ) => { for ( const l of listeners[ type ] || [] ) l( { type } ); };
	const xr = {
		enabled: false,
		referenceSpaceTypes: [],
		session: null,
		setReferenceSpaceType( t ) { this.referenceSpaceTypes.push( t ); },
		getController( i ) { return controllers[ i ]; },
		addEventListener( type, l ) { ( listeners[ type ] ||= [] ).push( l ); },
		getSession() { return this.session; },
		getCamera() { return { matrixWorld: {} }; },
		setSession( session ) { this.session = session; fire( 'sessionstart' ); return Promise.resolve(); }
	};
	return { renderer: { xr, initTexture() { this.initialized ++; }, initialized: 0 }, controllers, fire };

}

// Runs fn with fake renderer/THREE (and navigator.xr), then ends any session and restores everything
async function withFakeXR( fn, navigatorXR ) {

	const fakeThree = makeFakeThree();
	const fake = makeFakeXRRenderer();
	const scene = new fakeThree.THREE.Group();
	const savedNav = Object.getOwnPropertyDescriptor( globalThis, 'navigator' );
	Object.defineProperty( globalThis, 'navigator', { configurable: true, value: navigatorXR ? { xr: navigatorXR } : {} } );
	webxr.XR_SetTestOverrides( { renderer: fake.renderer, THREE: fakeThree.THREE } );

	try {

		await fn( { fake, scene, three: fakeThree } );

	} finally {

		if ( webxr.isXRActive() ) fake.fire( 'sessionend' );
		webxr.XR_SetTestOverrides();
		if ( savedNav ) Object.defineProperty( globalThis, 'navigator', savedNav );
		else delete globalThis.navigator;

	}

}

Deno.test( 'IN-3: XR handedness decides the aim controller, not the slot order', async () => {

	await withFakeXR( ( { fake, scene } ) => {

		webxr.XR_Init( scene );
		fake.fire( 'sessionstart' );

		const pos = {};
		const quat = {};
		assertEqual( webxr.XR_GetControllerWorldPose( pos, quat ), false, 'no controller connected' );

		// Left hand sits in slot 1, right hand in slot 0
		fake.controllers[ 1 ].dispatch( 'connected', { handedness: 'left' } );
		assertEqual( webxr.XR_GetControllerWorldPose( pos, quat ), true, 'a lone left controller aims' );
		assertEqual( pos.from, 'slot1', 'lone left controller' );

		fake.controllers[ 0 ].dispatch( 'connected', { handedness: 'right' } );
		webxr.XR_GetControllerWorldPose( pos, quat );
		assertEqual( pos.from, 'slot0', 'the right hand wins whatever its slot' );
		assertEqual( quat.from, 'slot0', 'quaternion from the same controller' );

		fake.controllers[ 0 ].dispatch( 'disconnected' );
		webxr.XR_GetControllerWorldPose( pos, quat );
		assertEqual( pos.from, 'slot1', 'falls back to the remaining controller' );

		fake.controllers[ 1 ].dispatch( 'connected', null );
		assertEqual( webxr.XR_GetControllerWorldPose( pos, quat ), true, 'connected without data still aims' );
		fake.controllers[ 1 ].dispatch( 'disconnected' );
		assertEqual( webxr.XR_GetControllerWorldPose( pos, quat ), false, 'both gone' );

	} );

} );

Deno.test( 'IN-3: XR session uses local-floor, falling back to local', async () => {

	for ( const floorGranted of [ true, false ] ) {

		let offers = 0;
		const session = {
			requestReferenceSpace( type ) {

				if ( type === 'local-floor' && ! floorGranted ) return Promise.reject( new Error( 'unsupported' ) );
				return Promise.resolve( {} );

			},
			end() { return Promise.resolve(); }
		};
		let init = null;

		await withFakeXR( async ( { fake, scene } ) => {

			webxr.XR_Init( scene );
			await flush();
			assertEqual( offers, 1, 'session offered' );
			assertEqual( init.requiredFeatures.join(), 'local', 'local is required' );
			assertEqual( init.optionalFeatures.join(), 'local-floor', 'local-floor is optional' );

			const types = fake.renderer.xr.referenceSpaceTypes;
			assertEqual( types[ types.length - 1 ], floorGranted ? 'local-floor' : 'local', 'reference space type' );
			assertEqual( webxr.isXRActive(), true, 'session started' );

			const offset = webxr.getXRRig().children[ 0 ];
			const expectedY = floorGranted ? - 46 / webxr.XR_SCALE : 0;
			assertEqual( Math.abs( offset.position.y - expectedY ) < 1e-9, true, 'rig lowered to the floor only with local-floor' );
			assertEqual( scene.scale.value, 1 / webxr.XR_SCALE, 'scene scaled to meters' );

		}, {
			offerSession( _mode, i ) { offers ++; init = i; return Promise.resolve( session ); }
		} );

	}

} );

Deno.test( 'IN-3: HUD quad texture is re-created on resize and released with the session', async () => {

	let ended = 0;
	let offers = 0;

	await withFakeXR( ( { fake, scene, three } ) => {

		const canvas = { width: 640, height: 480, getContext() { return {}; } };
		webxr.XR_SetTestOverrides( { renderer: fake.renderer, THREE: three.THREE, overlayCanvas: canvas } );
		webxr.XR_SetSessionEndCallback( () => { ended ++; } );
		webxr.XR_Init( scene );
		const hud = () => scene.children.find( ( c ) => c.material != null );

		// Not in a session: nothing happens
		webxr.XR_UpdateHUD();
		assertEqual( three.created.textures.length, 0, 'no texture outside a session' );

		fake.fire( 'sessionstart' );
		assertEqual( hud() != null, true, 'quad added to the scene' );
		assertEqual( hud().visible, false, 'hidden until the first upload' );

		webxr.XR_UpdateHUD();
		assertEqual( three.created.textures.length, 1, 'texture created' );
		assertEqual( hud().visible, true, 'visible after upload' );
		assertEqual( hud().material.map, three.created.textures[ 0 ], 'texture on the material' );
		assertEqual( fake.renderer.initialized, 1, 'uploaded to the GPU' );

		webxr.XR_UpdateHUD();
		assertEqual( three.created.textures.length, 1, 'same size keeps the texture' );
		assertEqual( fake.renderer.initialized, 2, 'but still re-uploads each frame' );

		canvas.width = 1280;
		webxr.XR_UpdateHUD();
		assertEqual( three.created.textures.length, 2, 'resized canvas gets a new texture' );
		assertEqual( three.created.textures[ 0 ].disposed, true, 'old texture disposed' );
		assertEqual( hud().material.map, three.created.textures[ 1 ], 'new texture on the material' );

		fake.fire( 'sessionend' );
		assertEqual( hud(), undefined, 'quad removed' );
		assertEqual( three.created.textures[ 1 ].disposed, true, 'texture disposed with the session' );
		assertEqual( ended, 1, 'session end callback called' );
		assertEqual( scene.scale.value, 1, 'scene scale restored' );
		assertEqual( webxr.isXRActive(), false, 'inactive' );

		webxr.XR_UpdateHUD();
		assertEqual( three.created.textures.length, 2, 'no upload after the session' );
		webxr.XR_SetSessionEndCallback( null );

	}, { offerSession() { offers ++; return new Promise( () => {} ); } } );

	assertEqual( offers, 2, 'a new session is offered at init and again after the session' );

} );

Deno.test( 'IN-3: Enter VR button appears only when immersive VR is supported', async () => {

	const savedDoc = Object.getOwnPropertyDescriptor( globalThis, 'document' );
	Object.defineProperty( globalThis, 'document', { configurable: true, value: documentTarget } );
	const before = body.children.length;
	const requests = [];
	let supported = false;
	const session = { requestReferenceSpace: () => Promise.resolve( {} ), end: () => Promise.resolve() };

	try {

		// Unsupported: no button
		await withFakeXR( async ( { scene } ) => {

			webxr.XR_Init( scene );
			await flush();
			assertEqual( body.children.length, before, 'no button without support' );

		}, { isSessionSupported: () => Promise.resolve( supported ) } );

		supported = true;
		await withFakeXR( async ( { fake, scene } ) => {

			webxr.XR_Init( scene );
			await flush();
			const button = body.children.find( ( c ) => c.tagName === 'BUTTON' );
			assertEqual( button != null, true, 'button added' );
			assertEqual( button.textContent, 'ENTER VR', 'label' );

			button.fire( 'click', {} );
			assertEqual( requests.length, 1, 'click requests a session' );
			assertEqual( requests[ 0 ][ 0 ], 'immersive-vr', 'immersive-vr' );
			await flush();
			assertEqual( webxr.isXRActive(), true, 'session started from the click' );
			assertEqual( button.style.display, 'none', 'button hidden in the session' );

			button.fire( 'click', {} );
			assertEqual( requests.length, 1, 'no second request while in a session' );

			fake.fire( 'sessionend' );
			assertEqual( button.style.display, '', 'button back after the session' );

			// Only one button however many times XR is initialised
			webxr.XR_Init( scene );
			await flush();
			assertEqual( body.children.filter( ( c ) => c.tagName === 'BUTTON' ).length, 1, 'one button' );

		}, {
			isSessionSupported: () => Promise.resolve( supported ),
			requestSession( mode, init ) { requests.push( [ mode, init ] ); return Promise.resolve( session ); }
		} );

	} finally {

		if ( savedDoc ) Object.defineProperty( globalThis, 'document', savedDoc );
		else delete globalThis.document;

	}

} );

Deno.test( 'IN-3: XR snap turn needs the stick back near centre; smooth turn follows xr_turnspeed', async () => {

	await withFakeXR( ( { fake, scene } ) => {

		webxr.XR_Init( scene );
		fake.fire( 'sessionstart' );

		withFakeDom( () => {

			keys.set_key_dest( keys.key_game );
			const xr = webxr.xrInput;
			const move = () => input.IN_Move( { forwardmove: 0, sidemove: 0, upmove: 0 } );
			const yaw = () => client.cl.viewangles[ 1 ];
			const savedYaw = yaw();
			const savedFrametime = host.host_frametime;
			client.cl.viewangles[ 1 ] = 0;

			try {

				cvarModule.Cvar_Set( 'xr_snapturn', '45' );
				xr.lookX = 0;
				move();
				xr.lookX = 0.8;
				move();
				assertEqual( yaw(), - 45, 'first push snaps right' );
				move();
				assertEqual( yaw(), - 45, 'held stick does not repeat' );
				xr.lookX = 0.5;
				move();
				xr.lookX = 0.8;
				move();
				assertEqual( yaw(), - 45, 'mid-range stick does not re-arm' );
				xr.lookX = 0.2;
				move();
				xr.lookX = - 0.8;
				move();
				assertEqual( yaw(), 0, 'below 0.3 re-arms; left push snaps back' );
				xr.lookX = 0.7;
				move();
				assertEqual( yaw(), 0, 'exactly 0.7 does not trigger' );

				// Smooth turn: 280 deg/s by default
				cvarModule.Cvar_Set( 'xr_snapturn', '0' );
				host.set_host_frametime( 0.01 );
				xr.lookX = 1;
				client.cl.viewangles[ 1 ] = 0;
				move();
				assertEqual( Math.abs( yaw() + 2.8 ) < 1e-5, true, 'default turn rate 280 deg/s' );

				cvarModule.Cvar_Set( 'xr_turnspeed', '100' );
				client.cl.viewangles[ 1 ] = 0;
				move();
				assertEqual( Math.abs( yaw() + 1 ) < 1e-5, true, 'xr_turnspeed 100' );

				xr.lookX = 0.1;
				client.cl.viewangles[ 1 ] = 0;
				move();
				assertEqual( yaw(), 0, 'inside the deadzone' );

			} finally {

				cvarModule.Cvar_Set( 'xr_snapturn', '0' );
				cvarModule.Cvar_Set( 'xr_turnspeed', '280' );
				host.set_host_frametime( savedFrametime );
				client.cl.viewangles[ 1 ] = savedYaw;
				xr.lookX = 0;

			}

		} );

	} );

} );

Deno.test( 'IN-4: menu overlay taps select; drags send arrow keys and never tap', () => {

	withFakeDom( () => {

		touch.Touch_Init( document.body );
		const menu = document.body.children.find( ( c ) => c.id === 'touch-menu-controls' );
		assertEqual( menu != null, true, 'menu overlay exists' );

		touch.Touch_ShowMenu();
		assertEqual( menu.style.display, 'block', 'shown' );

		unbindAll();
		bind( keys.K_RIGHTARROW, '+ta' );
		bind( keys.K_LEFTARROW, '+tb' );
		bind( keys.K_DOWNARROW, '+tc' );
		bind( keys.K_UPARROW, '+ta' );
		keys.set_key_dest( keys.key_game );

		const taps = [];
		const surface = { getBoundingClientRect() { return { left: 10, top: 20, width: 300, height: 200 }; } };
		touch.Touch_SetMenuCallback( ( ...args ) => taps.push( args ), () => surface );

		let prevented = 0;
		const ev = ( type, touches ) => ( {
			type, changedTouches: touches.map( ( [ id, x, y ] ) => ( { identifier: id, clientX: x, clientY: y } ) ),
			preventDefault() { prevented ++; }
		} );

		// Tap: coordinates relative to the surface, on touchend
		menu.fire( 'touchstart', ev( 'touchstart', [ [ 1, 110, 70 ] ] ) );
		assertEqual( taps.length, 0, 'nothing on touchstart' );
		menu.fire( 'touchend', ev( 'touchend', [ [ 1, 110, 70 ] ] ) );
		assertEqual( JSON.stringify( taps ), '[[100,50,300,200]]', 'tap relative to the surface rect' );
		assertEqual( prevented, 2, 'default prevented' );

		// A small wobble is still a tap
		menu.fire( 'touchstart', ev( 'touchstart', [ [ 2, 50, 50 ] ] ) );
		menu.fire( 'touchmove', ev( 'touchmove', [ [ 2, 60, 55 ] ] ) );
		menu.fire( 'touchend', ev( 'touchend', [ [ 2, 60, 55 ] ] ) );
		assertEqual( taps.length, 2, 'wobble under the drag step taps' );

		// Second finger and foreign ids are ignored
		menu.fire( 'touchstart', ev( 'touchstart', [ [ 3, 0, 0 ] ] ) );
		menu.fire( 'touchstart', ev( 'touchstart', [ [ 4, 200, 200 ] ] ) );
		menu.fire( 'touchend', ev( 'touchend', [ [ 4, 200, 200 ] ] ) );
		assertEqual( taps.length, 2, 'other finger does not tap' );
		menu.fire( 'touchend', ev( 'touchend', [ [ 3, 0, 0 ] ] ) );
		assertEqual( taps.length, 3, 'first finger taps' );

		// Cancel does not tap
		menu.fire( 'touchstart', ev( 'touchstart', [ [ 5, 0, 0 ] ] ) );
		menu.fire( 'touchcancel', ev( 'touchcancel', [ [ 5, 0, 0 ] ] ) );
		assertEqual( taps.length, 3, 'cancel does not tap' );

		run();

		// Horizontal drag: one key per 24 px, locked to the first axis
		menu.fire( 'touchstart', ev( 'touchstart', [ [ 6, 0, 0 ] ] ) );
		menu.fire( 'touchmove', ev( 'touchmove', [ [ 6, 30, 2 ] ] ) );
		assertEqual( run().join( ',' ), '+ta,-ta', 'drag right: one key' );
		menu.fire( 'touchmove', ev( 'touchmove', [ [ 6, 30, 90 ] ] ) );
		assertEqual( run().join( ',' ), '', 'vertical movement ignored once horizontal' );
		menu.fire( 'touchmove', ev( 'touchmove', [ [ 6, - 30, 90 ] ] ) );
		assertEqual( run().join( ',' ), '+tb,-tb,+tb,-tb', 'drag back left: two keys' );
		menu.fire( 'touchend', ev( 'touchend', [ [ 6, - 30, 90 ] ] ) );
		assertEqual( taps.length, 3, 'a drag does not tap' );

		// Vertical drag
		menu.fire( 'touchstart', ev( 'touchstart', [ [ 7, 0, 0 ] ] ) );
		menu.fire( 'touchmove', ev( 'touchmove', [ [ 7, 3, 50 ] ] ) );
		assertEqual( run().join( ',' ), '+tc,-tc,+tc,-tc', 'drag down: two keys' );
		menu.fire( 'touchmove', ev( 'touchmove', [ [ 7, 3, 0 ] ] ) );
		assertEqual( run().join( ',' ), '+ta,-ta,+ta,-ta', 'drag up: two keys' );
		menu.fire( 'touchend', ev( 'touchend', [ [ 7, 3, 0 ] ] ) );

		// Without a surface the window size is used
		touch.Touch_SetMenuCallback( ( ...args ) => taps.push( args ) );
		menu.fire( 'touchstart', ev( 'touchstart', [ [ 8, 5, 6 ] ] ) );
		menu.fire( 'touchend', ev( 'touchend', [ [ 8, 5, 6 ] ] ) );
		assertEqual( JSON.stringify( taps[ 3 ] ), '[5,6,640,480]', 'window-relative fallback' );

		touch.Touch_SetMenuCallback( null );
		menu.fire( 'touchstart', ev( 'touchstart', [ [ 9, 5, 6 ] ] ) );
		menu.fire( 'touchend', ev( 'touchend', [ [ 9, 5, 6 ] ] ) );
		assertEqual( taps.length, 4, 'no callback, no tap' );

		touch.Touch_HideMenu();
		assertEqual( menu.style.display, 'none', 'hidden' );
		unbindAll();
		run();

	} );

} );

Deno.test( 'IN-4: fullscreen request has a pending guard and does not latch after a mid-request exit', async () => {

	const savedScreen = Object.getOwnPropertyDescriptor( globalThis, 'screen' );
	const orientation = deferred();
	Object.defineProperty( globalThis, 'screen', {
		configurable: true,
		value: { orientation: { lock: () => orientation.promise } }
	} );

	await withFakeDom( async ( dom ) => {

		touch.Touch_Init( document.body );
		dom.document.fullscreenElement = null;
		dom.document.fire( 'fullscreenchange', {} ); // reset state left by other tests

		let requests = 0;
		let entered = deferred();
		const root = { requestFullscreen() { requests ++; return entered.promise; } };
		dom.document.documentElement = root;
		dom.document.fullscreenElement = null;

		try {

			// Two taps while the first request is pending: one request
			const first = touch.Touch_RequestFullscreen();
			await touch.Touch_RequestFullscreen();
			assertEqual( requests, 1, 'pending guard' );

			// Fullscreen is granted, the orientation lock is still pending, and the
			// user leaves fullscreen: the state must not stay latched as activated
			dom.document.fullscreenElement = root;
			entered.resolve();
			await flush();
			dom.document.fullscreenElement = null;
			dom.document.fire( 'fullscreenchange', {} );
			orientation.resolve();
			await first;

			entered = deferred();
			entered.resolve();
			await touch.Touch_RequestFullscreen();
			assertEqual( requests, 2, 'a later tap can enter fullscreen again' );

			// Now stay in fullscreen: no more requests
			dom.document.fullscreenElement = root;
			await touch.Touch_RequestFullscreen();
			await touch.Touch_RequestFullscreen();
			assertEqual( requests, 2, 'already fullscreen' );

			// Leaving resets the guard
			dom.document.fullscreenElement = null;
			dom.document.fire( 'fullscreenchange', {} );
			await touch.Touch_RequestFullscreen();
			assertEqual( requests, 3, 'requestable again after leaving fullscreen' );

		} finally {

			dom.document.fullscreenElement = null;
			dom.document.fire( 'fullscreenchange', {} );
			delete dom.document.documentElement;
			if ( savedScreen ) Object.defineProperty( globalThis, 'screen', savedScreen );
			else delete globalThis.screen;

		}

	} );

} );

Deno.test( 'IN-4: touch joystick run speed in IN_Move', () => {

	withFakeDom( () => {

		touch.Touch_Init( document.body );
		touch.Touch_Enable();
		const overlay = document.body.children.find( ( c ) => c.id === 'touch-controls' );
		const joystick = overlay.children[ 0 ];
		const ev = ( type, y ) => ( {
			currentTarget: joystick, type,
			changedTouches: [ { identifier: 11, clientX: 100, clientY: y } ],
			targetTouches: [], preventDefault() {}
		} );
		const fwd = cl_input.cl_forwardspeed.value;
		const back = cl_input.cl_backspeed.value;
		const key = cl_input.cl_movespeedkey.value;
		const near = ( a, b, m ) => assertEqual( Math.abs( a - b ) < 1e-6, true, m + ': ' + a + ' vs ' + b );
		const move = () => {

			const cmd = { forwardmove: 0, sidemove: 0, upmove: 0 };
			input.IN_Move( cmd );
			return cmd;

		};

		documentTarget.documentElement = {}; // touchend asks for fullscreen
		cl_input.in_speed.state = 0;
		joystick.fire( 'touchstart', ev( 'touchstart', 100 ) );

		joystick.fire( 'touchmove', ev( 'touchmove', 75 ) );
		near( move().forwardmove, fwd * ( 0.5 - 0.15 ) / 0.75, 'half deflection walks' );

		joystick.fire( 'touchmove', ev( 'touchmove', 40 ) );
		near( move().forwardmove, fwd * key, 'full deflection forward runs' );

		joystick.fire( 'touchmove', ev( 'touchmove', 160 ) );
		near( move().forwardmove, - back * key, 'full deflection backward runs at cl_backspeed' );

		joystick.fire( 'touchmove', ev( 'touchmove', 75 ) );
		cl_input.in_speed.state = 1;
		near( move().forwardmove, fwd * ( 0.5 - 0.15 ) / 0.75 * key, '+speed held scales a walk' );
		cl_input.in_speed.state = 0;

		joystick.fire( 'touchend', ev( 'touchend', 75 ) );
		near( move().forwardmove, 0, 'released' );

		delete documentTarget.documentElement;
		touch.Touch_Disable();

	} );

} );
