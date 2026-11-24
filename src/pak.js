// PAK file loader -- new module for browser-based asset loading
// Quake stores all game data in pak0.pak (and optionally pak1.pak)
// PAK format: 4-byte magic "PACK", 4-byte directory offset, 4-byte directory length
// Directory entries: 56-byte filename + 4-byte offset + 4-byte length

import { Sys_Printf, Sys_Error } from './sys.js';
import { Con_Printf, COM_SetModified } from './common.js';
import { CRC_Init, CRC_ProcessByte } from './crc.js';

const MAX_FILES_IN_PACK = 2048;

// the shareware/registered id1 pak0.pak (common.c)
const PAK0_COUNT = 339;
const PAK0_CRC = 32981;

class packfile_t {

	constructor() {

		this.name = '';
		this.filepos = 0;
		this.filelen = 0;

	}

}

class pack_t {

	constructor() {

		this.filename = '';
		this.files = []; // array of packfile_t
		this.data = null; // ArrayBuffer of the entire pak

	}

}

// Search paths
const com_searchpaths = []; // array of { pack, path }

// Loaded packs
const loadedPacks = [];

// Virtual files (for loose files not in pak)
const virtualFiles = new Map();

// Base path for on-demand loose file fetching
// Browser: 'static/' (relative URLs like 'static/maps/foo.bsp')
// Deno: '/opt/icaro-engine/static/' (absolute filesystem path)
let looseFileBasePath = 'static/';

/*
=================
COM_LoadPackFile

Takes an ArrayBuffer of the .pak file contents
Returns a pack_t or null
=================
*/
export function COM_LoadPackFile( filename, buffer ) {

	const view = new DataView( buffer );

	// Check header
	const id0 = view.getUint8( 0 );
	const id1 = view.getUint8( 1 );
	const id2 = view.getUint8( 2 );
	const id3 = view.getUint8( 3 );

	if ( id0 !== 0x50 || id1 !== 0x41 || id2 !== 0x43 || id3 !== 0x4B ) { // 'PACK'

		Sys_Error( filename + ' is not a packfile' );
		return null;

	}

	const dirofs = view.getInt32( 4, true );
	const dirlen = view.getInt32( 8, true );

	const numpackfiles = Math.floor( dirlen / 64 ); // each dir entry is 64 bytes

	if ( numpackfiles > MAX_FILES_IN_PACK )
		Sys_Error( filename + ' has too many files (' + numpackfiles + ')' );

	const bytes = new Uint8Array( buffer );

	if ( numpackfiles !== PAK0_COUNT )
		COM_SetModified( true ); // not the original file

	// crc the directory to check for modifications
	let crc = CRC_Init();
	for ( let i = 0; i < dirlen; i ++ )
		crc = CRC_ProcessByte( crc, bytes[ dirofs + i ] );
	if ( crc !== PAK0_CRC )
		COM_SetModified( true );

	const pack = new pack_t();
	pack.filename = filename;
	pack.data = buffer;

	for ( let i = 0; i < numpackfiles; i ++ ) {

		const entryOffset = dirofs + i * 64;
		const file = new packfile_t();

		// Read filename (56 bytes, null terminated)
		let name = '';
		for ( let j = 0; j < 56; j ++ ) {

			const c = bytes[ entryOffset + j ];
			if ( c === 0 ) break;
			name += String.fromCharCode( c );

		}

		file.name = name.toLowerCase();
		file.filepos = view.getInt32( entryOffset + 56, true );
		file.filelen = view.getInt32( entryOffset + 60, true );

		pack.files.push( file );

	}

	Con_Printf( 'Added packfile ' + filename + ' (' + numpackfiles + ' files)\\n' );

	loadedPacks.push( pack );

	return pack;

}

/*
=================
COM_AddGameDirectory

Adds pak0.pak, pak1.pak... from dir (a URL or path, without a trailing
slash), searched before everything added so far, as common.c does for
<basedir>/rogue or hipnotic. Unlike C, loose files are not looked up in
dir: COM_EnsureFile still fetches them from the static/ base path only.
Returns the number of paks added.
=================
*/
export function COM_AddGameDirectory( dir, onProgress ) {

	return COM_AddPakSequence( dir + '/pak0.pak', onProgress );

}

/*
=================
COM_AddPack

Adds a loaded pack to the search path
=================
*/
export function COM_AddPack( pack ) {

	com_searchpaths.unshift( { pack: pack, path: null } );

}

/*
=================
COM_FindFile

Searches through the path looking for a file.
Returns { data: Uint8Array, size: number } or null

Deliberately not ported: common.c refuses loose files whose name has a
'/' or '\\' when !static_registered ("don't ever go beyond base"). This
port ships the shareware pak0.pak with its deathmatch maps as loose
static/maps/*.bsp files, so that check would refuse every one of them.
=================
*/
export function COM_FindFile( filename ) {

	const search = filename.toLowerCase();

	// Search through loaded packs (reverse order - last added has priority)
	for ( let i = 0; i < com_searchpaths.length; i ++ ) {

		const sp = com_searchpaths[ i ];
		if ( ! sp.pack ) continue;

		const pack = sp.pack;
		for ( let j = 0; j < pack.files.length; j ++ ) {

			if ( pack.files[ j ].name === search ) {

				const file = pack.files[ j ];
				const data = new Uint8Array( pack.data, file.filepos, file.filelen );
				return { data: data, size: file.filelen };

			}

		}

	}

	// Check virtual files (preloaded loose files)
	if ( virtualFiles.has( search ) ) {

		const data = virtualFiles.get( search );
		return { data: data, size: data.length };

	}

	return null;

}

/*
=================
COM_SetLooseFileBasePath

Sets the base path for on-demand loose file fetching.
Browser: 'static/' (default, uses relative URLs like 'static/maps/foo.bsp')
Deno: '/opt/icaro-engine/static/' (absolute filesystem path)
=================
*/
export function COM_SetLooseFileBasePath( basePath ) {

	looseFileBasePath = basePath;

}

/*
=================
COM_EnsureFile

Checks if a file is available in pak or virtualFiles.
If not, attempts to fetch it on demand and cache it.
Returns a Promise<boolean>.
=================
*/
export async function COM_EnsureFile( filename ) {

	// Already available in pak or virtualFiles?
	if ( COM_FindFile( filename ) !== null ) {

		return true;

	}

	// Construct URL from base path + filename
	const url = looseFileBasePath + filename;

	return await COM_PreloadLooseFile( filename, url );

}

/*
=================
COM_PreloadLooseFile

Fetches a loose file from URL/path and adds it to virtualFiles.
Used for custom maps not included in pak files.
In Deno, reads from filesystem. In browser, uses fetch().
=================
*/
export async function COM_PreloadLooseFile( filename, url ) {

	try {

		let data;

		// Check if running in Deno
		if ( typeof Deno !== 'undefined' ) {

			// Load from filesystem in Deno
			try {

				data = await Deno.readFile( url );

			} catch {

				return false;

			}

		} else {

			// Browser: use fetch
			const response = await fetch( url );
			if ( ! response.ok ) {

				return false;

			}

			const buffer = await response.arrayBuffer();
			data = new Uint8Array( buffer );

		}

		virtualFiles.set( filename.toLowerCase(), data );
		return true;

	} catch {

		return false;

	}

}

/*
=================
COM_PreloadMaps

Preloads loose map files from the static/maps/ directory.
basePath is optional - used by Deno server to specify absolute path.
=================
*/
export async function COM_PreloadMaps( mapList, basePath ) {

	let loaded = 0;

	// Default base path, or use provided one (for Deno server)
	const base = basePath || 'static/maps/';

	for ( const mapName of mapList ) {

		const filename = 'maps/' + mapName + '.bsp';
		const url = base + mapName + '.bsp';

		if ( await COM_PreloadLooseFile( filename, url ) ) {

			loaded ++;

		}

	}

	if ( loaded > 0 ) {

		Sys_Printf( 'Preloaded %d custom maps\\n', loaded );

	}

	return loaded;

}

/*
=================
COM_LoadFile

Loads a file from the pack system.
Returns an ArrayBuffer of the file contents, or null if not found.
=================
*/
export function COM_LoadFile( filename ) {

	const result = COM_FindFile( filename );
	if ( ! result ) return null;

	// Return a copy of the data as an ArrayBuffer
	const buf = new ArrayBuffer( result.size );
	const dest = new Uint8Array( buf );
	dest.set( result.data );
	return buf;

}

/*
=================
COM_LoadFileAsString

Convenience: load a file and return it as a string
=================
*/
export function COM_LoadFileAsString( filename ) {

	const result = COM_FindFile( filename );
	if ( ! result ) return null;

	let str = '';
	for ( let i = 0; i < result.size; i ++ ) {

		str += String.fromCharCode( result.data[ i ] );

	}

	return str;

}

// True when buffer starts with the 'PACK' magic
function isPack( buffer ) {

	if ( buffer.byteLength < 12 ) return false;
	const b = new Uint8Array( buffer, 0, 4 );
	return b[ 0 ] === 0x50 && b[ 1 ] === 0x41 && b[ 2 ] === 0x43 && b[ 3 ] === 0x4B;

}

/*
=================
COM_FetchPak

Fetches a .pak file from a URL using fetch(), returns a Promise<pack_t>
In Deno, loads from filesystem. In browser, uses fetch().
With optional set, a missing file (Deno NotFound, HTTP 404, or a body that
is not a PACK, such as a web host's index.html fallback) returns null
without a message, as COM_AddGameDirectory stops quietly at the first
missing pakN.pak.
=================
*/
export async function COM_FetchPak( url, filename, onProgress, optional = false ) {

	if ( ! optional ) Sys_Printf( 'Fetching ' + url + '...\\n' );

	// Check if running in Deno
	if ( typeof Deno !== 'undefined' ) {

		// Load from filesystem in Deno
		try {

			const data = await Deno.readFile( url );
			if ( optional && ! isPack( data.buffer ) ) return null;
			if ( onProgress ) onProgress( 1 );
			return COM_LoadPackFile( filename, data.buffer );

		} catch ( e ) {

			if ( ! ( optional && e instanceof Deno.errors.NotFound ) )
				Con_Printf( 'Failed to load ' + url + ': ' + e.message + '\\n' );
			return null;

		}

	}

	// Browser: use fetch
	const response = await fetch( url );
	if ( ! response.ok ) {

		if ( ! ( optional && response.status === 404 ) )
			Con_Printf( 'Failed to fetch ' + url + ': ' + response.statusText + '\\n' );
		return null;

	}

	let buffer;
	const contentLength = response.headers.get( 'content-length' );

	if ( onProgress && contentLength && response.body ) {

		const total = parseInt( contentLength, 10 );
		const reader = response.body.getReader();
		const chunks = [];
		let received = 0;

		while ( true ) {

			const { done, value } = await reader.read();
			if ( done ) break;

			chunks.push( value );
			received += value.length;
			onProgress( Math.min( 1, received / total ) );

		}

		buffer = new ArrayBuffer( received );
		const dest = new Uint8Array( buffer );
		let offset = 0;
		for ( const chunk of chunks ) {

			dest.set( chunk, offset );
			offset += chunk.length;

		}

	} else {

		buffer = await response.arrayBuffer();
		if ( onProgress ) onProgress( 1 );

	}

	if ( optional && ! isPack( buffer ) ) return null;

	Sys_Printf( 'Loaded ' + url + ' (' + buffer.byteLength + ' bytes)\\n' );

	return COM_LoadPackFile( filename || url, buffer );

}

/*
=================
COM_AddPakSequence

Loads pak0.pak, pak1.pak, ... from the directory of pak0Url and adds each
one, stopping at the first missing file, as common.c COM_AddGameDirectory
does. Later paks are searched first, so pak1 (registered) overrides pak0.
pak0 is required; the rest are optional. Returns the number of paks added.
Names are lower case: a PAK1.PAK copied from a Windows install must be
renamed on case-sensitive file systems and web servers. A URL that does
not end in lower-case pak0.pak is loaded on its own. onProgress runs from
0 to 1 for each pak in turn, since the total size is not known in advance.
=================
*/
export async function COM_AddPakSequence( pak0Url, onProgress ) {

	const match = /^(.*?)pak0\.pak$/.exec( pak0Url );
	if ( match === null ) {

		const pak = await COM_FetchPak( pak0Url, 'pak0.pak', onProgress );
		if ( pak === null ) return 0;
		COM_AddPack( pak );
		return 1;

	}

	const dir = match[ 1 ];
	let count = 0;
	for ( let i = 0; ; i ++ ) {

		const name = 'pak' + i + '.pak';
		const pak = await COM_FetchPak( dir + name, name, onProgress, i > 0 );
		if ( pak === null ) break;
		COM_AddPack( pak );
		count ++;

	}

	return count;

}
