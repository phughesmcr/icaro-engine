// COM_AddPakSequence: pak0.pak, pak1.pak, ... as COM_AddGameDirectory loads them

import { COM_SetModified, com_modified } from '../src/common.js';
import { COM_AddPakSequence, COM_EnsureFile, COM_FindFile, COM_SetLooseFileBasePath, COM_SetLooseFileBasePaths } from '../src/pak.js';

function assertEqual( actual, expected, message ) {

	if ( actual !== expected )
		throw new Error( `${message}: expected ${JSON.stringify( expected )}, got ${JSON.stringify( actual )}` );

}

// A pack with one file: 12-byte header, the file's bytes, then a 64-byte
// directory entry (56-byte name, filepos, filelen).
function makePak( name, text ) {

	const body = new TextEncoder().encode( text );
	const dirofs = 12 + body.length;
	const bytes = new Uint8Array( dirofs + 64 );
	const view = new DataView( bytes.buffer );
	bytes.set( [ 0x50, 0x41, 0x43, 0x4B ], 0 ); // 'PACK'
	view.setInt32( 4, dirofs, true );
	view.setInt32( 8, 64, true );
	bytes.set( body, 12 );
	bytes.set( new TextEncoder().encode( name ), dirofs );
	view.setInt32( dirofs + 56, 12, true );
	view.setInt32( dirofs + 60, body.length, true );
	return bytes;

}

function readText( name ) {

	const file = COM_FindFile( name );
	return file === null ? null : new TextDecoder().decode( file.data );

}

Deno.test( 'COM_AddPakSequence loads pak0 then pak1, pak1 first in the search path, and stops at a gap', async () => {

	const dir = await Deno.makeTempDir();
	const wasModified = com_modified;
	try {

		await Deno.writeFile( dir + '/pak0.pak', makePak( 'pakseq/a.txt', 'shareware' ) );
		await Deno.writeFile( dir + '/pak1.pak', makePak( 'pakseq/a.txt', 'registered' ) );
		await Deno.writeFile( dir + '/pak3.pak', makePak( 'pakseq/b.txt', 'after a gap' ) );

		const count = await COM_AddPakSequence( dir + '/pak0.pak' );
		assertEqual( count, 2, 'pak0 and pak1 added, pak3 skipped after missing pak2' );
		assertEqual( readText( 'pakseq/a.txt' ), 'registered', 'pak1 overrides pak0' );
		assertEqual( readText( 'pakseq/b.txt' ), null, 'pak3 not loaded' );

	} finally {

		COM_SetModified( wasModified ); // test paks are not the original pak0
		await Deno.remove( dir, { recursive: true } );

	}

} );

Deno.test( 'COM_AddPakSequence treats a pak1 that is not a PACK (e.g. an index.html fallback) as missing', async () => {

	const dir = await Deno.makeTempDir();
	const wasModified = com_modified;
	try {

		await Deno.writeFile( dir + '/pak0.pak', makePak( 'pakseq/d.txt', 'pak0' ) );
		await Deno.writeFile( dir + '/pak1.pak', new TextEncoder().encode( '<!doctype html><html></html>' ) );
		assertEqual( await COM_AddPakSequence( dir + '/pak0.pak' ), 1, 'only pak0 added, no Sys_Error' );
		assertEqual( readText( 'pakseq/d.txt' ), 'pak0', 'pak0 loaded' );

	} finally {

		COM_SetModified( wasModified );
		await Deno.remove( dir, { recursive: true } );

	}

} );

Deno.test( 'COM_AddPakSequence loads a URL not named pak0.pak on its own', async () => {

	const dir = await Deno.makeTempDir();
	const wasModified = com_modified;
	try {

		await Deno.writeFile( dir + '/quake.pak', makePak( 'pakseq/e.txt', 'other name' ) );
		await Deno.writeFile( dir + '/pak1.pak', makePak( 'pakseq/f.txt', 'not probed' ) );
		assertEqual( await COM_AddPakSequence( dir + '/quake.pak' ), 1, 'one pak added' );
		assertEqual( readText( 'pakseq/e.txt' ), 'other name', 'quake.pak loaded' );
		assertEqual( readText( 'pakseq/f.txt' ), null, 'no sequence probe' );

	} finally {

		COM_SetModified( wasModified );
		await Deno.remove( dir, { recursive: true } );

	}

} );

Deno.test( 'COM_AddPakSequence returns 0 when pak0 is missing', async () => {

	const dir = await Deno.makeTempDir();
	try {

		await Deno.writeFile( dir + '/pak1.pak', makePak( 'pakseq/c.txt', 'orphan' ) );
		assertEqual( await COM_AddPakSequence( dir + '/pak0.pak' ), 0, 'nothing added' );
		assertEqual( readText( 'pakseq/c.txt' ), null, 'pak1 not loaded without pak0' );

	} finally {

		await Deno.remove( dir, { recursive: true } );

	}

} );

Deno.test( 'COM_AddPakSequence finds upper-case PAK0.PAK and PAK1.PAK, as copied from a Windows install', async () => {

	const dir = await Deno.makeTempDir();
	const wasModified = com_modified;
	try {

		await Deno.writeFile( dir + '/PAK0.PAK', makePak( 'pakseq/upper0.txt', 'upper pak0' ) );
		await Deno.writeFile( dir + '/PAK1.PAK', makePak( 'pakseq/upper1.txt', 'upper pak1' ) );
		assertEqual( await COM_AddPakSequence( dir + '/pak0.pak' ), 2, 'both paks added' );
		assertEqual( readText( 'pakseq/upper1.txt' ), 'upper pak1', 'pak1 loaded' );

	} finally {

		COM_SetModified( wasModified );
		await Deno.remove( dir, { recursive: true } );

	}

} );

Deno.test( 'COM_AddPakSequence: a pak0.pak that is not a PACK is an error, not a PAK0.PAK probe', async () => {

	const dir = await Deno.makeTempDir();
	try {

		await Deno.writeFile( dir + '/pak0.pak', new TextEncoder().encode( '<!doctype html><html></html>' ) );
		let error = null;
		try {

			await COM_AddPakSequence( dir + '/pak0.pak' );

		} catch ( e ) {

			error = e.message;

		}

		assertEqual( error !== null && error.includes( 'is not a packfile' ), true, 'Sys_Error: ' + error );

	} finally {

		await Deno.remove( dir, { recursive: true } );

	}

} );

Deno.test( 'COM_EnsureFile looks for loose files in each base path in order', async () => {

	const dir = await Deno.makeTempDir();
	try {

		await Deno.mkdir( dir + '/game/maps', { recursive: true } );
		await Deno.mkdir( dir + '/id1/maps', { recursive: true } );
		await Deno.writeTextFile( dir + '/game/maps/loosea.bsp', 'game' );
		await Deno.writeTextFile( dir + '/id1/maps/loosea.bsp', 'id1' );
		await Deno.writeTextFile( dir + '/id1/maps/looseb.bsp', 'id1 only' );
		COM_SetLooseFileBasePaths( [ dir + '/game/', dir + '/id1/' ] );
		assertEqual( await COM_EnsureFile( 'maps/loosea.bsp' ), true, 'a found' );
		assertEqual( readText( 'maps/loosea.bsp' ), 'game', 'game dir first' );
		assertEqual( await COM_EnsureFile( 'maps/looseb.bsp' ), true, 'b found' );
		assertEqual( readText( 'maps/looseb.bsp' ), 'id1 only', 'falls through to id1' );
		assertEqual( await COM_EnsureFile( 'maps/loosec.bsp' ), false, 'missing everywhere' );

	} finally {

		COM_SetLooseFileBasePath( 'static/' );
		await Deno.remove( dir, { recursive: true } );

	}

} );
