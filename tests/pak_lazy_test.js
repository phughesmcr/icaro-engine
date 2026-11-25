// Lazily opened paks: COM_FetchPak reads only the directory of a pak bigger
// than com_lazypaksize, then reads entries from disk (Deno) or with HTTP
// Range requests (browser).

import { COM_SetModified, com_modified } from '../src/common.js';
import { COM_LAZY_PAK_SIZE, COM_AddPakSequence, COM_AddGameDirectory, COM_EnsureFile, COM_FindFile, COM_PakEntryIsDeferred, COM_SetLazyPakSize } from '../src/pak.js';

function assertEqual( actual, expected, message ) {

	if ( actual !== expected )
		throw new Error( `${message}: expected ${JSON.stringify( expected )}, got ${JSON.stringify( actual )}` );

}

const MAP_SIZE = 40000; // over the 32k that keeps b_*.bsp item models eager

// A pack of entries [ name, Uint8Array ]: header, bodies, then the directory
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

function testEntries( prefix ) {

	const map = new Uint8Array( MAP_SIZE ).fill( 7 );
	return [
		[ prefix + '/progs.dat', new TextEncoder().encode( 'progs' ) ],
		[ 'maps/' + prefix + '.bsp', map ],
		[ 'maps/b_' + prefix + '.bsp', new TextEncoder().encode( 'item' ) ],
		[ prefix + '/sound/a.wav', new TextEncoder().encode( 'wav' ) ],
	];

}

function text( name ) {

	const file = COM_FindFile( name );
	return file === null ? null : new TextDecoder().decode( file.data );

}

// Stub fetch serving files by URL; honourRange false acts like
// python3 -m http.server, which ignores Range.
function stubFetch( files, honourRange, log ) {

	return ( url, init ) => {

		const body = files.get( url );
		const range = init !== undefined && init.headers !== undefined ? init.headers.Range : undefined;
		log.push( range === undefined ? 'GET' : range );
		if ( body === undefined ) return Promise.resolve( new Response( 'missing', { status: 404 } ) );
		if ( range === undefined || ! honourRange )
			return Promise.resolve( new Response( body, { status: 200, headers: { 'content-length': String( body.length ) } } ) );
		const m = /^bytes=(\d+)-(\d+)$/.exec( range );
		const start = parseInt( m[ 1 ], 10 );
		const end = Math.min( parseInt( m[ 2 ], 10 ), body.length - 1 );
		return Promise.resolve( new Response( body.slice( start, end + 1 ), {
			status: 206,
			headers: { 'content-range': `bytes ${start}-${end}/${body.length}` },
		} ) );

	};

}

async function withLazyPaks( fn ) {

	const wasModified = com_modified;
	const realFetch = globalThis.fetch;
	COM_SetLazyPakSize( 0 );
	try {

		await fn();

	} finally {

		COM_SetLazyPakSize( COM_LAZY_PAK_SIZE );
		globalThis.fetch = realFetch;
		COM_SetModified( wasModified ); // test paks are not the original pak0

	}

}

Deno.test( 'COM_PakEntryIsDeferred: maps and unread rerelease files are deferred, engine files are not', () => {

	assertEqual( COM_PakEntryIsDeferred( 'maps/e1m1.bsp', 500000 ), true, 'map' );
	assertEqual( COM_PakEntryIsDeferred( 'maps/b_shell0.bsp', 2000 ), false, 'item model' );
	assertEqual( COM_PakEntryIsDeferred( 'maps/e1m1.lit', 100 ), true, '.lit' );
	assertEqual( COM_PakEntryIsDeferred( 'gfx/medieval.wad', 100 ), true, 'texture wad' );
	assertEqual( COM_PakEntryIsDeferred( 'gfx.wad', 100 ), false, 'gfx.wad' );
	assertEqual( COM_PakEntryIsDeferred( 'gfx/palette.lmp', 768 ), false, 'palette' );
	assertEqual( COM_PakEntryIsDeferred( 'sound/misc/menu1.wav', 100 ), false, 'sound' );
	assertEqual( COM_PakEntryIsDeferred( 'progs/player.mdl', 100 ), false, 'model' );
	assertEqual( COM_PakEntryIsDeferred( 'progs/player.md5mesh', 100 ), true, 'md5' );
	assertEqual( COM_PakEntryIsDeferred( 'vault/x.png', 100 ), true, 'vault' );

} );

Deno.test( 'COM_FetchPak in Deno reads a big pak\'s entries from disk on demand', async () => {

	const dir = await Deno.makeTempDir();
	try {

		await withLazyPaks( async () => {

			await Deno.writeFile( dir + '/pak0.pak', makePak( testEntries( 'lazyfs' ) ) );
			assertEqual( await COM_AddPakSequence( dir + '/pak0.pak' ), 1, 'pak added' );
			assertEqual( text( 'lazyfs/progs.dat' ), 'progs', 'progs read synchronously' );
			assertEqual( COM_FindFile( 'maps/lazyfs.bsp' ).size, MAP_SIZE, 'map read synchronously too' );
			assertEqual( COM_FindFile( 'maps/lazyfs.bsp' ).data[ MAP_SIZE - 1 ], 7, 'map bytes' );

		} );

	} finally {

		await Deno.remove( dir, { recursive: true } );

	}

} );

Deno.test( 'COM_FetchPak over HTTP with Range: directory and engine files at load, maps on COM_EnsureFile', async () => {

	await withLazyPaks( async () => {

		const log = [];
		const files = new Map( [ [ 'http://pak.test/a/pak0.pak', makePak( testEntries( 'lazyhttp' ) ) ] ] );
		globalThis.fetch = stubFetch( files, true, log );

		assertEqual( await COM_AddPakSequence( 'http://pak.test/a/pak0.pak' ), 1, 'pak added' );
		assertEqual( text( 'lazyhttp/progs.dat' ), 'progs', 'progs fetched at load' );
		assertEqual( text( 'maps/b_lazyhttp.bsp' ), 'item', 'item model fetched at load' );
		assertEqual( text( 'lazyhttp/sound/a.wav' ), 'wav', 'sound fetched at load' );
		assertEqual( COM_FindFile( 'maps/lazyhttp.bsp' ), null, 'map not fetched yet; requests: ' + log.join( ', ' ) );
		// header, directory, one coalesced range for the three engine files (the
		// 40000-byte map between them is under RANGE_GAP), then the 404s for
		// pak1.pak and PAK1.PAK
		assertEqual( log.length, 5, 'requests at load: ' + log.join( ', ' ) );
		assertEqual( log[ 0 ], 'bytes=0-11', 'header first' );

		assertEqual( await COM_EnsureFile( 'maps/lazyhttp.bsp' ), true, 'map fetched' );
		assertEqual( COM_FindFile( 'maps/lazyhttp.bsp' ).size, MAP_SIZE, 'map available' );

	} );

} );

Deno.test( 'COM_FetchPak over HTTP falls back to the whole pak when Range is ignored', async () => {

	await withLazyPaks( async () => {

		const log = [];
		const files = new Map( [ [ 'http://pak.test/b/pak0.pak', makePak( testEntries( 'norange' ) ) ] ] );
		globalThis.fetch = stubFetch( files, false, log );

		assertEqual( await COM_AddPakSequence( 'http://pak.test/b/pak0.pak' ), 1, 'pak added' );
		assertEqual( COM_FindFile( 'maps/norange.bsp' ).size, MAP_SIZE, 'whole pak loaded, map included' );
		assertEqual( log.length, 3, 'one request for pak0, two for pak1 (both cases): ' + log.join( ', ' ) );

	} );

} );

Deno.test( 'COM_FetchPak over HTTP treats an optional non-PACK 206 body as missing', async () => {

	await withLazyPaks( async () => {

		const log = [];
		const files = new Map( [
			[ 'http://pak.test/c/pak0.pak', makePak( testEntries( 'html' ) ) ],
			[ 'http://pak.test/c/pak1.pak', new TextEncoder().encode( '<!doctype html><html></html>' ) ],
		] );
		globalThis.fetch = stubFetch( files, true, log );

		assertEqual( await COM_AddPakSequence( 'http://pak.test/c/pak0.pak' ), 1, 'only pak0 added' );

	} );

} );

Deno.test( 'A deferred map in a later lazy pak shadows an earlier copy until COM_EnsureFile fetches it', async () => {

	await withLazyPaks( async () => {

		const log = [];
		const id1 = new Uint8Array( MAP_SIZE ).fill( 1 );
		const game = new Uint8Array( MAP_SIZE ).fill( 2 );
		const files = new Map( [
			[ 'http://pak.test/d/pak0.pak', makePak( [ [ 'maps/shadow.bsp', id1 ] ] ) ],
			[ 'http://pak.test/d/game/pak0.pak', makePak( [ [ 'maps/shadow.bsp', game ] ] ) ],
		] );
		globalThis.fetch = stubFetch( files, true, log );

		assertEqual( await COM_AddPakSequence( 'http://pak.test/d/pak0.pak' ), 1, 'id1' );
		assertEqual( await COM_EnsureFile( 'maps/shadow.bsp' ), true, 'id1 copy fetched' );
		assertEqual( await COM_AddGameDirectory( 'http://pak.test/d/game' ), 1, 'game dir' );
		assertEqual( COM_FindFile( 'maps/shadow.bsp' ), null, 'game copy not fetched: no fall-through to id1' );
		const [ a, b ] = await Promise.all( [ COM_EnsureFile( 'maps/shadow.bsp' ), COM_EnsureFile( 'maps/shadow.bsp' ) ] );
		assertEqual( a && b, true, 'both callers succeed' );
		assertEqual( log.filter( ( r ) => r === 'bytes=12-' + ( 11 + MAP_SIZE ) ).length, 2, 'one fetch per pak, not per caller' );
		assertEqual( COM_FindFile( 'maps/shadow.bsp' ).data[ 0 ], 2, 'game copy wins' );

	} );

} );

Deno.test( 'COM_EnsureFile returns false when the Range fetch fails', async () => {

	await withLazyPaks( async () => {

		const log = [];
		const files = new Map( [ [ 'http://pak.test/e/pak0.pak', makePak( [ [ 'maps/gone.bsp', new Uint8Array( MAP_SIZE ) ] ] ) ] ] );
		globalThis.fetch = stubFetch( files, true, log );
		assertEqual( await COM_AddPakSequence( 'http://pak.test/e/pak0.pak' ), 1, 'pak added' );
		globalThis.fetch = stubFetch( new Map(), true, log ); // the server lost the pak
		assertEqual( await COM_EnsureFile( 'maps/gone.bsp' ), false, 'fetch failed' );
		assertEqual( COM_FindFile( 'maps/gone.bsp' ), null, 'still not available' );

	} );

} );

Deno.test( 'COM_FetchPak splits eager entries farther apart than RANGE_GAP and reports progress to 1', async () => {

	await withLazyPaks( async () => {

		const log = [];
		const progress = [];
		const files = new Map( [ [ 'http://pak.test/f/pak0.pak', makePak( [
			[ 'gapa/progs.dat', new Uint8Array( 10 ) ],
			[ 'maps/gap.bsp', new Uint8Array( 300 * 1024 ) ], // deferred, wider than RANGE_GAP
			[ 'gapa/b.wav', new Uint8Array( 10 ) ],
			[ 'gapa/empty.cfg', new Uint8Array( 0 ) ],
		] ) ] ] );
		globalThis.fetch = stubFetch( files, true, log );

		assertEqual( await COM_AddPakSequence( 'http://pak.test/f/pak0.pak', ( v ) => progress.push( v ) ), 1, 'pak added' );
		// header, directory, two entry ranges, pak1.pak and PAK1.PAK probes
		assertEqual( log.length, 6, 'requests: ' + log.join( ', ' ) );
		assertEqual( COM_FindFile( 'gapa/b.wav' ).size, 10, 'second range' );
		assertEqual( COM_FindFile( 'gapa/empty.cfg' ).size, 0, 'empty entry found' );
		assertEqual( progress[ progress.length - 1 ], 1, 'progress ends at 1' );

	} );

} );
