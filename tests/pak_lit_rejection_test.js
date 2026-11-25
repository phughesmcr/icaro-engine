// COM_EnsureFile starts maps/<name>.lit's fetch before the map's. A failure of
// the .lit fetch must never surface as an unhandled rejection, even when the
// map's own load throws first (not in id's C; web-only fetch).

import { COM_SetModified, com_modified } from '../src/common.js';
import { COM_LAZY_PAK_SIZE, COM_AddPakSequence, COM_EnsureFile, COM_SetLazyPakSize } from '../src/pak.js';

const MAP_SIZE = 40000;
const LIT_SIZE = 1000;
const MAP_START = 12;
const LIT_START = 12 + MAP_SIZE;

function assertEqual( actual, expected, message ) {

	if ( actual !== expected )
		throw new Error( `${message}: expected ${JSON.stringify( expected )}, got ${JSON.stringify( actual )}` );

}

// A pack of [ name, Uint8Array ]: header, bodies, then the directory
function makePak( entries ) {

	let dirofs = 12;
	for ( const [ , body ] of entries ) dirofs += body.length;
	const bytes = new Uint8Array( dirofs + 64 * entries.length );
	const view = new DataView( bytes.buffer );
	bytes.set( [ 0x50, 0x41, 0x43, 0x4B ], 0 ); // 'PACK'
	view.setInt32( 4, dirofs, true );
	view.setInt32( 8, 64 * entries.length, true );
	let pos = 12;
	entries.forEach( ( [ name, body ], i ) => {

		bytes.set( body, pos );
		const e = dirofs + i * 64;
		bytes.set( new TextEncoder().encode( name ), e );
		view.setInt32( e + 56, pos, true );
		view.setInt32( e + 60, body.length, true );
		pos += body.length;

	} );
	return bytes;

}

// Serves the pak with Range support. A Range starting at an offset in
// `failing` rejects with null after that many ms. A null rejection value makes
// COM_EnsureOneFile's `e.message` throw inside its catch, so the rejection
// escapes it.
function stubFetch( pakurl, body, failing ) {

	return ( url, init ) => {

		// only pak0.pak exists; the pak1.pak probes get a 404
		if ( url !== pakurl ) return Promise.resolve( new Response( 'missing', { status: 404 } ) );

		const range = init !== undefined && init.headers !== undefined ? init.headers.Range : undefined;
		const m = range === undefined ? null : /^bytes=(\d+)-(\d+)$/.exec( range );
		if ( m === null )
			return Promise.resolve( new Response( body, { status: 200, headers: { 'content-length': String( body.length ) } } ) );
		const start = parseInt( m[ 1 ], 10 );
		const end = Math.min( parseInt( m[ 2 ], 10 ), body.length - 1 );
		const delay = failing.get( start );
		if ( delay !== undefined )
			return new Promise( ( _res, rej ) => setTimeout( () => rej( null ), delay ) );
		return Promise.resolve( new Response( body.slice( start, end + 1 ), {
			status: 206,
			headers: { 'content-range': `bytes ${start}-${end}/${body.length}` },
		} ) );

	};

}

async function run( name, failing, check ) {

	const wasModified = com_modified;
	const realFetch = globalThis.fetch;
	const unhandled = [];
	const onUnhandled = ( ev ) => {

		ev.preventDefault();
		unhandled.push( ev.reason );

	};
	globalThis.addEventListener( 'unhandledrejection', onUnhandled );
	COM_SetLazyPakSize( 0 );
	try {

		const body = makePak( [
			[ 'maps/' + name + '.bsp', new Uint8Array( MAP_SIZE ) ],
			[ 'maps/' + name + '.lit', new Uint8Array( LIT_SIZE ) ],
		] );
		const pakurl = 'http://pak.test/' + name + '/pak0.pak';
		globalThis.fetch = stubFetch( pakurl, body, new Map() );
		assertEqual( await COM_AddPakSequence( pakurl ), 1, 'pak added' );
		globalThis.fetch = stubFetch( pakurl, body, failing );
		await check();
		// let a late rejection settle
		await new Promise( ( r ) => setTimeout( r, 100 ) );
		assertEqual( unhandled.length, 0, 'unhandled rejections' );

	} finally {

		globalThis.removeEventListener( 'unhandledrejection', onUnhandled );
		COM_SetLazyPakSize( COM_LAZY_PAK_SIZE );
		globalThis.fetch = realFetch;
		COM_SetModified( wasModified );

	}

}

Deno.test( 'A .lit fetch that rejects after the map load threw is not an unhandled rejection', async () => {

	await run( 'litrej1', new Map( [ [ MAP_START, 0 ], [ LIT_START, 30 ] ] ), async () => {

		let threw = false;
		try {

			await COM_EnsureFile( 'maps/litrej1.bsp' );

		} catch {

			threw = true;

		}
		assertEqual( threw, true, 'the map load failure reaches the caller' );

	} );

} );

Deno.test( 'A .lit fetch that rejects does not fail a map that loaded', async () => {

	await run( 'litrej2', new Map( [ [ LIT_START, 0 ] ] ), async () => {

		assertEqual( await COM_EnsureFile( 'maps/litrej2.bsp' ), true, 'map fetched' );

	} );

} );
