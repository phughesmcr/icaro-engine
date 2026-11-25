// Tests for the gamepad stick response: Ironwail's radial deadzone with an
// outer threshold and easing exponent (joy_deadzone_*, joy_outer_threshold_*,
// joy_exponent, joy_exponent_move), driven through IN_Move.

// Bootstrap the renderer's existing circular module graph in its safe order.
await import( '../src/gl_rsurf.js' );

const cmd = await import( '../src/cmd.js' );
const cvar = await import( '../src/cvar.js' );
const keys = await import( '../src/keys.js' );
const host = await import( '../src/host.js' );
const input = await import( '../src/in_web.js' );
const { cl } = await import( '../src/client.js' );
const { YAW } = await import( '../src/quakedef.js' );

function assertNear( actual, expected, message ) {

	if ( Math.abs( actual - expected ) > 1e-4 )
		throw new Error( `${message}: expected ${expected}, got ${actual}` );

}

cmd.Cbuf_Init();
cmd.Cmd_Init();

const JOY_CVARS = {
	joy_deadzone_look: '0.12',
	joy_deadzone_move: '0.15',
	joy_outer_threshold_look: '0',
	joy_outer_threshold_move: '0',
	joy_exponent: '1',
	joy_exponent_move: '1',
};

const pad = {
	index: 0, connected: true,
	axes: [ 0, 0, 0, 0 ],
	buttons: Array.from( { length: 16 }, () => ( { pressed: false, value: 0 } ) ),
};

// Runs one IN_Move with the sticks at the given axes; returns the move and
// the yaw change (cl_yawspeed 140, host_frametime 1, gp_look_yaw 1)
function poll( axes ) {

	pad.axes = axes;
	const move = { forwardmove: 0, sidemove: 0, upmove: 0 };
	cl.viewangles[ YAW ] = 0;
	input.IN_Move( move );
	return { forward: move.forwardmove, side: move.sidemove, yaw: cl.viewangles[ YAW ] };

}

function withPad( settings, fn ) {

	const hadGetGamepads = Object.getOwnPropertyDescriptor( navigator, 'getGamepads' );
	Object.defineProperty( navigator, 'getGamepads', { value: () => [ pad ], configurable: true } );
	const oldFrametime = host.host_frametime;
	const oldDest = keys.key_dest;
	const oldYaw = cl.viewangles[ YAW ];
	const saved = {};

	try {

		keys.set_key_dest( keys.key_game );
		host.set_host_frametime( 1 );
		for ( const name of Object.keys( JOY_CVARS ) ) {

			saved[ name ] = cvar.Cvar_FindVar( name ).string;
			cvar.Cvar_Set( name, settings[ name ] ?? JOY_CVARS[ name ] );

		}

		fn();

	} finally {

		for ( const name of Object.keys( saved ) ) cvar.Cvar_Set( name, saved[ name ] );
		host.set_host_frametime( oldFrametime );
		keys.set_key_dest( oldDest );
		cl.viewangles[ YAW ] = oldYaw;
		if ( hadGetGamepads ) Object.defineProperty( navigator, 'getGamepads', hadGetGamepads );
		else delete navigator.getGamepads;

	}

}

// IN_Init registers in_web.js's cvars. Run it once against a minimal fake
// DOM (as in in_web_input_test.js), then put the globals back.
function makeElement( tag ) {

	return {
		tagName: tag, style: {}, children: [], textContent: '',
		appendChild( child ) { this.children.push( child ); return child; },
		addEventListener() {}, removeEventListener() {},
		getBoundingClientRect() { return { left: 0, top: 0, width: 640, height: 480 }; },
	};

}

{

	const saved = {};
	for ( const name of [ 'document', 'window', 'matchMedia' ] )
		saved[ name ] = Object.getOwnPropertyDescriptor( globalThis, name );

	const doc = makeElement( 'DOCUMENT' );
	const body = makeElement( 'BODY' );
	doc.body = body;
	doc.pointerLockElement = null;
	doc.visibilityState = 'visible';
	doc.fullscreenElement = null;
	doc.createElement = ( tag ) => makeElement( tag.toUpperCase() );
	const win = makeElement( 'WINDOW' );
	win.innerWidth = 640;
	win.innerHeight = 480;

	Object.defineProperty( globalThis, 'document', { configurable: true, value: doc } );
	Object.defineProperty( globalThis, 'window', { configurable: true, value: win } );
	Object.defineProperty( globalThis, 'matchMedia', { configurable: true, value: ( q ) => ( { matches: q === '(any-pointer: fine)' } ) } );

	try {

		input.IN_Init( body );
		input.IN_Shutdown();

	} finally {

		for ( const name in saved ) {

			if ( saved[ name ] === undefined ) delete globalThis[ name ];
			else Object.defineProperty( globalThis, name, saved[ name ] );

		}

	}

}

Deno.test( 'gamepad cvars are registered with Ironwail\'s names and the old feel as default', () => {

	for ( const [ name, value ] of Object.entries( JOY_CVARS ) ) {

		const v = cvar.Cvar_FindVar( name );
		if ( v === null ) throw new Error( `${name} not registered` );
		if ( v.string !== value ) throw new Error( `${name} default: expected ${value}, got ${v.string}` );
		if ( v.archive !== true ) throw new Error( `${name} not archived` );

	}

} );

Deno.test( 'the default deadzone matches the old per-axis response on a single axis', () => {

	withPad( {}, () => {

		assertNear( poll( [ 0, - 0.1, 0, 0 ] ).forward, 0, 'inside the move deadzone' );
		// old: ( 0.5 - 0.15 ) / 0.85 of cl_forwardspeed 200
		assertNear( poll( [ 0, - 0.5, 0, 0 ] ).forward, 200 * 0.35 / 0.85, 'half forward' );
		assertNear( poll( [ 0, - 1, 0, 0 ] ).forward, 200, 'full forward' );
		// look: ( 0.5 - 0.12 ) / 0.88 of cl_yawspeed 140 per second
		assertNear( poll( [ 0, 0, 0.5, 0 ] ).yaw, - 140 * 0.38 / 0.88, 'half right look' );

	} );

} );

Deno.test( 'the deadzone is radial: a diagonal inside it is ignored, a full diagonal is clamped to 1', () => {

	withPad( {}, () => {

		// each axis 0.1 (inside 0.15) and the magnitude 0.141 too
		const small = poll( [ 0.1, - 0.1, 0, 0 ] );
		assertNear( small.forward, 0, 'small diagonal: no forward' );
		assertNear( small.side, 0, 'small diagonal: no side' );

		// a square-gate corner (1, 1) has magnitude 1.41: clamped to 1
		const corner = poll( [ 1, - 1, 0, 0 ] );
		assertNear( corner.forward, 200 * Math.SQRT1_2, 'corner forward' );
		assertNear( corner.side, 350 * Math.SQRT1_2, 'corner side' );

	} );

} );

Deno.test( 'joy_outer_threshold and joy_exponent shape the response', () => {

	withPad( { joy_deadzone_move: '0.2', joy_outer_threshold_move: '0.2', joy_exponent_move: '2' }, () => {

		// ( 0.5 - 0.2 ) / ( 1 - 0.2 - 0.2 ) = 0.5, squared = 0.25
		assertNear( poll( [ 0, - 0.5, 0, 0 ] ).forward, 200 * 0.25, 'eased half push' );
		// 0.8 reaches the outer threshold: full scale
		assertNear( poll( [ 0, - 0.8, 0, 0 ] ).forward, 200, 'outer threshold' );

	} );

	withPad( { joy_deadzone_look: '0.5', joy_outer_threshold_look: '0.5' }, () => {

		// no room between the two: past the deadzone is full scale, not NaN
		assertNear( poll( [ 0, 0, 0.6, 0 ] ).yaw, - 140, 'deadzone meets outer threshold' );

	} );

} );
