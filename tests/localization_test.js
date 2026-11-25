// 2021 rerelease localisation, ported from Ironwail: LOC_LoadFile parses
// localization/loc_<language>.txt, and PF_VarString and PF_WriteString
// resolve "$key" strings (with "{}"/"{N}" placeholders) on the server. The
// fixture is hand-written, not the commercial file.

import * as common from '../src/common.js';
import { Cvar_Set } from '../src/cvar.js';
import { COM_AddPack } from '../src/pak.js';
import { PR_InitBuiltins } from '../src/pr_cmds.js';
import { OFS_PARM0 } from '../src/pr_comp.js';
import {
	pr_builtins, pr_numbuiltins, pr_globals_float, pr_globals_int, pr_strings_data,
	pr_string_temp_ofs, pr_argc, sv,
	PR_SetBuiltins, PR_SetSV, PR_SetGlobalsFloat, PR_SetGlobalsInt, PR_SetStringsData,
	PR_SetStringTempOfs, PR_SetArgc, PR_AppendString, PR_ClearZoneStrings,
	STRINGTEMP_BUFFERS, STRINGTEMP_LENGTH,
} from '../src/progs.js';
import { svs } from '../src/server.js';
import { svc_print, svc_centerprint } from '../src/protocol.js';

// %s and %d are the only conversions these messages use
const format = ( fmt, args ) => String( fmt ).replace( /%[sd]/g, () => String( args.shift() ) );
const printed = [];
const dprinted = [];
common.Con_SetPrintFunctions(
	( fmt, ...args ) => printed.push( format( fmt, args ) ),
	( fmt, ...args ) => dprinted.push( format( fmt, args ) )
);

function assertEqual( actual, expected, message ) {

	if ( actual !== expected )
		throw new Error( `${message}: expected ${JSON.stringify( expected )}, got ${JSON.stringify( actual )}` );

}

// UTF-8 with a BOM and CRLF line ends, as the rerelease files are
const FIXTURE_LINES = [
	'// generic menu',
	'qc_item_health = "You receive {0} health\\n"',
	'qc_exited = "{} exited the level\\n" // trailing comment',
	'qc_swap = "{1} then {0}{2}"',
	'qc_quote = "Say \\"hi\\""',
	'  qc_spaced   =   "spaced"  ',
	'qc_unquoted = plain value   ',
	'qc_accent = "Café ’quoted’ Quake™"',
	'qc_dup = "first"',
	'qc_dup = "second"',
	'qc_name = "Ranger"',
	'qc_finale_end = "Congratulations\\nwell done"',
	'/ malformed comment = "skipped"',
	'qc_braces = "{x} {"',
];

function fixtureBytes( lines ) {

	const body = new TextEncoder().encode( lines.join( '\r\n' ) + '\r\n' );
	const bytes = new Uint8Array( body.length + 3 );
	bytes.set( [ 0xEF, 0xBB, 0xBF ] );
	bytes.set( body, 3 );
	return bytes;

}

// Mounts the files once; a pak can't be removed from the search path again
let mounted = false;
function mountFixtures() {

	if ( mounted ) return;
	mounted = true;

	const files = [
		[ 'localization/loc_zztest.txt', fixtureBytes( FIXTURE_LINES ) ],
		[ 'localization/loc_zzother.txt', fixtureBytes( [ 'qc_item_health = "Other {0}"' ] ) ],
		[ 'localization/loc_zzempty.txt', fixtureBytes( [ '// nothing here' ] ) ],
	];
	let size = 0;
	for ( const [ , data ] of files ) size += data.length;
	const data = new Uint8Array( size );
	const dir = [];
	let pos = 0;
	for ( const [ name, bytes ] of files ) {

		data.set( bytes, pos );
		dir.push( { name, filepos: pos, filelen: bytes.length } );
		pos += bytes.length;

	}

	COM_AddPack( { filename: 'zz_loc.pak', files: dir, data: data.buffer } );

}

// Loads the fixture through LOC_Init; returns a restore function
function useLanguage( lang ) {

	mountFixtures();
	common.LOC_Init();
	const saved = common.language.string;
	Cvar_Set( 'language', lang );
	printed.length = 0;
	dprinted.length = 0;
	common.LOC_GetRawString( '$' ); // loads the new language now

	return () => {

		Cvar_Set( 'language', saved );
		common.LOC_Shutdown();

	};

}

// Fresh globals, string table and builtins; returns a restore function
function setupProgs() {

	const saved = {
		pr_builtins, pr_numbuiltins, pr_globals_float, pr_globals_int, pr_strings_data,
		pr_string_temp_ofs, pr_argc, sv,
	};

	const buffer = new ArrayBuffer( 64 * 4 );
	PR_SetGlobalsFloat( new Float32Array( buffer ) );
	PR_SetGlobalsInt( new Int32Array( buffer ) );
	PR_SetStringsData( new Uint8Array( 1 + STRINGTEMP_BUFFERS * STRINGTEMP_LENGTH ) );
	PR_SetStringTempOfs( 1 );
	PR_ClearZoneStrings();
	PR_InitBuiltins();

	return () => {

		PR_SetBuiltins( saved.pr_builtins, saved.pr_numbuiltins );
		PR_SetGlobalsFloat( saved.pr_globals_float );
		PR_SetGlobalsInt( saved.pr_globals_int );
		PR_SetStringsData( saved.pr_strings_data );
		PR_SetStringTempOfs( saved.pr_string_temp_ofs );
		PR_SetArgc( saved.pr_argc );
		PR_SetSV( saved.sv );
		PR_ClearZoneStrings();

	};

}

// Calls builtin n with numbers (floats), strings or { ent } as parameters
function call( n, ...parms ) {

	PR_SetArgc( parms.length );
	parms.forEach( ( p, i ) => {

		const o = OFS_PARM0 + i * 3;
		if ( typeof p === 'string' )
			pr_globals_int[ o ] = PR_AppendString( p );
		else if ( typeof p === 'object' )
			pr_globals_int[ o ] = p.ent;
		else
			pr_globals_float[ o ] = p;

	} );
	pr_builtins[ n ]();

}

// dprint (#25) runs PF_VarString( 0 ) and hands the result to Con_DPrintf
function dprint( ...strings ) {

	dprinted.length = 0;
	call( 25, ...strings );
	return dprinted.join( '' );

}

// The strings a sizebuf holds after a one-byte svc
function readSvcString( buf, svc ) {

	assertEqual( buf.data[ 0 ], svc, 'svc byte' );
	let s = '';
	for ( let i = 1; i < buf.cursize && buf.data[ i ] !== 0; i ++ ) s += String.fromCharCode( buf.data[ i ] );
	return s;

}

Deno.test( 'LOC_LoadFile parses quotes, escapes, comments, BOM and CRLF as Ironwail does', () => {

	const restore = useLanguage( 'zztest' );

	try {

		const get = common.LOC_GetRawString;
		assertEqual( get( '$qc_item_health' ), 'You receive {0} health\n', '\\n escape, BOM skipped on the first key' );
		assertEqual( get( '$qc_exited' ), '{} exited the level\n', 'text after the closing quote ignored' );
		assertEqual( get( '$qc_quote' ), 'Say "hi"', '\\" escape' );
		assertEqual( get( '$qc_spaced' ), 'spaced', 'blanks around key and value' );
		assertEqual( get( '$qc_unquoted' ), 'plain value', 'unquoted value trimmed, \\r included' );
		assertEqual( get( '$qc_accent' ), 'Cafe \'quoted\' Quake' + String.fromCharCode( 11 ), 'transliterated, unknown is QCHAR_BOX' );
		assertEqual( get( '$qc_dup' ), 'first', 'first duplicate wins' );
		assertEqual( get( '$' ), null, 'empty key' );
		assertEqual( get( '$qc_missing' ), null, 'unknown key' );
		assertEqual( get( 'qc_name' ), null, 'needs the $' );
		assertEqual( get( '$QC_NAME' ), null, 'case-sensitive' );
		assertEqual( get( '/ malformed comment' ), null, 'malformed comment skipped' );
		assertEqual( common.LOC_GetString( '$qc_missing' ), '$qc_missing', 'GetString passes unknown keys through' );
		assertEqual( common.LOC_GetString( 'You got $qc_name' ), 'You got $qc_name', 'only whole strings are keys' );
		assertEqual( printed.some( ( s ) => s.includes( 'Loaded 12 strings from \'localization/loc_zztest.txt\'' ) ), true, 'load message counts every entry' );
		assertEqual( dprinted.some( ( s ) => s.includes( 'malformed comment on line 13' ) ), true, 'malformed comment reported' );

	} finally {

		restore();

	}

} );

Deno.test( 'UTF8_ToQuake maps Quake glyphs, two-character transliterations and astral code points', () => {

	assertEqual( common.UTF8_ToQuake( 'abc' ), 'abc', 'ASCII' );
	assertEqual( common.UTF8_ToQuake( 'Æ' ), 'AE', 'two characters' );
	assertEqual( common.UTF8_ToQuake( '←' ), String.fromCharCode( 127 ), 'Quake glyph, uncoloured copy wins' );
	assertEqual( common.UTF8_ToQuake( '•' ), String.fromCharCode( 133 ), 'coloured-only Quake glyph' );
	assertEqual( common.UTF8_ToQuake( '\u{1F600}' ), String.fromCharCode( 11 ), 'outside the BMP' );
	assertEqual( common.UTF8_ToQuake( 'Ж' ), 'Zh', 'Cyrillic' );

} );

Deno.test( 'PF_VarString resolves keys, fills placeholders and localises the arguments', () => {

	const restoreLoc = useLanguage( 'zztest' );
	const restore = setupProgs();

	try {

		assertEqual( dprint( '$qc_item_health', '25' ), 'You receive 25 health\n', '{0}' );
		assertEqual( dprint( '$qc_exited', '$qc_name' ), 'Ranger exited the level\n', '{} is argument 0, localised' );
		assertEqual( dprint( '$qc_swap', 'a', 'b' ), 'b then a', '{N} order, missing argument is empty' );
		assertEqual( dprint( '$qc_name', ' and ', '$qc_dup' ), 'Ranger and first', 'no placeholders: concatenate, each localised' );
		assertEqual( dprint( '$qc_braces', 'x' ), '{x} {x', 'malformed braces are not placeholders, so arguments concatenate' );
		assertEqual( dprint( 'plain {} text', 'arg' ), 'plain arg text', 'Ironwail formats any string with placeholders once loaded' );
		assertEqual( dprint( '$qc_missing', '!' ), '$qc_missing!', 'unknown key passes through' );
		assertEqual( dprint(), '', 'no arguments' );

	} finally {

		restore();
		restoreLoc();

	}

} );

Deno.test( 'sprint, centerprint and WriteString send the resolved text', () => {

	const restoreLoc = useLanguage( 'zztest' );
	const restore = setupProgs();
	const savedMax = svs.maxclients;
	const savedClients = svs.clients;

	try {

		const message = new common.sizebuf_t();
		common.SZ_Alloc( message, 256 );
		const datagram = new common.sizebuf_t();
		common.SZ_Alloc( datagram, 256 );
		svs.maxclients = 1;
		svs.clients = [ { message } ];
		PR_SetSV( { edicts: [ 0, 1 ].map( ( index ) => ( { index } ) ), num_edicts: 2, datagram } );

		// sprint(client, s, ...): PF_VarString( 1 ) takes its arguments after the format
		call( 24, { ent: 1 }, '$qc_item_health', '15' );
		assertEqual( readSvcString( message, svc_print ), 'You receive 15 health\n', 'sprint' );

		message.cursize = 0;
		call( 73, { ent: 1 }, '$qc_exited', '$qc_name' );
		assertEqual( readSvcString( message, svc_centerprint ), 'Ranger exited the level\n', 'centerprint' );

		// WriteString(MSG_BROADCAST, "$qc_finale_end"), as svc_finale is sent
		call( 58, 0, '$qc_finale_end' );
		let s = '';
		for ( let i = 0; i < datagram.cursize && datagram.data[ i ] !== 0; i ++ ) s += String.fromCharCode( datagram.data[ i ] );
		assertEqual( s, 'Congratulations\nwell done', 'WriteString' );

	} finally {

		svs.maxclients = savedMax;
		svs.clients = savedClients;
		restore();
		restoreLoc();

	}

} );

Deno.test( 'With no strings loaded, prints are unchanged (shareware)', () => {

	const restoreLoc = useLanguage( 'zzmissing' ); // no such file, nor loc_english.txt
	const restore = setupProgs();

	try {

		assertEqual( common.LOC_GetRawString( '$qc_item_health' ), null, 'nothing loaded' );
		assertEqual( common.LOC_HasPlaceholders( 'a{}b' ), false, 'no placeholders without strings' );
		assertEqual( dprint( '$qc_item_health', '25' ), '$qc_item_health25', 'key and argument concatenated' );
		assertEqual( dprint( 'a{}b', 'c' ), 'a{}bc', 'braces left alone' );
		assertEqual( printed.length, 0, 'no console line for the missing file' );

	} finally {

		restore();
		restoreLoc();

	}

} );

Deno.test( 'Changing "language" reloads the strings at the next lookup', () => {

	const restore = useLanguage( 'zztest' );

	try {

		assertEqual( common.LOC_GetString( '$qc_item_health' ), 'You receive {0} health\n', 'first language' );
		Cvar_Set( 'language', 'zzother' );
		assertEqual( common.LOC_GetString( '$qc_item_health' ), 'Other {0}', 'second language' );
		assertEqual( common.LOC_GetString( '$qc_name' ), '$qc_name', 'old strings dropped' );
		Cvar_Set( 'language', 'zzempty' );
		assertEqual( common.LOC_GetString( '$qc_item_health' ), '$qc_item_health', 'a file with no entries loads nothing' );
		assertEqual( printed.some( ( s ) => s.includes( 'No localized strings in file' ) ), true, 'empty file reported' );

	} finally {

		restore();

	}

} );
