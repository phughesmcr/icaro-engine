// Tests for in_rawmouse: pointer lock with unadjustedMovement, the retry
// without it where the browser rejects the option, and that the rejection
// doesn't count towards the fullscreen fallback (pointerLockUnavailable).

// Bootstrap the renderer's existing circular module graph in its safe order.
await import( '../src/gl_rsurf.js' );

const cmd = await import( '../src/cmd.js' );
const cvar = await import( '../src/cvar.js' );
const keys = await import( '../src/keys.js' );
const input = await import( '../src/in_web.js' );

function assertEqual( actual, expected, message ) {

	if ( actual !== expected )
		throw new Error( `${message}: expected ${JSON.stringify( expected )}, got ${JSON.stringify( actual )}` );

}

function makeElement( tag ) {

	const listeners = new Map();
	return {
		tagName: tag, style: {}, children: [], textContent: '',
		appendChild( child ) { this.children.push( child ); return child; },
		addEventListener( type, listener ) {

			if ( ! listeners.has( type ) ) listeners.set( type, [] );
			listeners.get( type ).push( listener );

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

	return Object.assign( {
		button: 0, clientX: 0, clientY: 0, target: null,
		preventDefault() {}, stopPropagation() {}
	}, props );

}

const flush = () => new Promise( ( resolve ) => setTimeout( resolve, 0 ) );

cmd.Cbuf_Init();
cmd.Cmd_Init();

// Installs a fake DOM, runs IN_Init, then fn( dom, requests ); requests
// records the options of each requestPointerLock call. lockResult( options )
// returns what requestPointerLock returns.
async function withFakeDom( lockResult, fn ) {

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
	let fullscreenRequests = 0;
	doc.documentElement = { requestFullscreen() { fullscreenRequests ++; return Promise.resolve(); } };
	const win = makeElement( 'WINDOW' );
	win.innerWidth = 640;
	win.innerHeight = 480;

	const requests = [];
	body.requestPointerLock = ( options ) => {

		requests.push( options === undefined ? 'plain' : JSON.stringify( options ) );
		return lockResult( options );

	};

	Object.defineProperty( globalThis, 'document', { configurable: true, value: doc } );
	Object.defineProperty( globalThis, 'window', { configurable: true, value: win } );
	Object.defineProperty( globalThis, 'matchMedia', { configurable: true, value: ( q ) => ( { matches: q === '(any-pointer: fine)' } ) } );

	const oldRaw = cvar.Cvar_FindVar( 'in_rawmouse' )?.string ?? null;

	try {

		input.IN_Init( body );
		keys.set_key_dest( keys.key_game );
		await fn( { doc, body, win, requests, fullscreen: () => fullscreenRequests } );

	} finally {

		if ( oldRaw !== null ) cvar.Cvar_Set( 'in_rawmouse', oldRaw );
		input.IN_Shutdown();
		cmd.Cbuf_Execute();
		for ( const name in saved ) {

			if ( saved[ name ] === undefined ) delete globalThis[ name ];
			else Object.defineProperty( globalThis, name, saved[ name ] );

		}

	}

}

function click( dom ) {

	dom.body.fire( 'mousedown', makeEvent( { button: 0 } ) );
	dom.win.fire( 'mouseup', makeEvent( { button: 0 } ) );

}

const RAW = JSON.stringify( { unadjustedMovement: true } );

function notSupported() {

	const error = new Error( 'unadjustedMovement not supported' );
	error.name = 'NotSupportedError';
	return error;

}

Deno.test( 'in_rawmouse is registered, archived and off by default', async () => {

	await withFakeDom( () => Promise.resolve(), ( dom ) => {

		const v = cvar.Cvar_FindVar( 'in_rawmouse' );
		assertEqual( v !== null && v.string, '0', 'default 0' );
		assertEqual( v.archive, true, 'archived' );

		click( dom );
		assertEqual( dom.requests.join( ',' ), 'plain', 'off: a normal pointer lock request' );

	} );

} );

Deno.test( 'in_rawmouse 1 asks for unadjustedMovement', async () => {

	await withFakeDom( () => Promise.resolve(), async ( dom ) => {

		cvar.Cvar_Set( 'in_rawmouse', '1' );
		click( dom );
		await flush();
		assertEqual( dom.requests.join( ',' ), RAW, 'raw request' );

	} );

} );

Deno.test( 'a rejected unadjustedMovement retries without it and is not a refusal', async () => {

	await withFakeDom( ( options ) => options === undefined ? Promise.resolve() : Promise.reject( notSupported() ), async ( dom ) => {

		cvar.Cvar_Set( 'in_rawmouse', '1' );

		// Chrome fires pointerlockerror and rejects the promise
		click( dom );
		dom.doc.fire( 'pointerlockerror', {} );
		await flush();
		assertEqual( dom.requests.join( ',' ), RAW + ',plain', 'retried without the option' );

		// A second click: no raw request again, and the first rejection
		// didn't count towards the fullscreen fallback
		click( dom );
		dom.doc.fire( 'pointerlockerror', {} );
		await flush();
		assertEqual( dom.requests.join( ',' ), RAW + ',plain,plain', 'later locks skip the option' );
		assertEqual( dom.fullscreen(), 0, 'one real refusal: no fullscreen fallback yet' );

	} );

} );

Deno.test( 'a raw request refused for another reason still counts as a refusal', async () => {

	await withFakeDom( () => Promise.reject( new DOMException( 'no user activation', 'NotAllowedError' ) ), async ( dom ) => {

		cvar.Cvar_Set( 'in_rawmouse', '1' );

		for ( let i = 0; i < 2; i ++ ) {

			click( dom );
			dom.doc.fire( 'pointerlockerror', {} );
			await flush();

		}

		assertEqual( dom.requests.join( ',' ), RAW + ',' + RAW, 'option kept: it was not the problem' );
		assertEqual( dom.fullscreen(), 1, 'two refusals fall back to fullscreen' );

	} );

} );
