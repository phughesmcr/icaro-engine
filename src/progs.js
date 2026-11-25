// Ported from: WinQuake/progs.h -- program execution definitions

import { link_t } from './common.js';
import { Sys_Error } from './sys.js';
import { entity_state_t } from './quakedef.js';
import {
	OFS_RETURN,
} from './pr_comp.js';
import { entvars_t } from './progdefs.js';

export const MAX_ENT_LEAFS = 16;

//
// eval_t - union type for accessing progs data as different types
// In C this is a union of string, float, vector[3], function, int, edict.
// In JS we provide accessor helpers on the backing ArrayBuffer.
//

//
// EdictFieldAccessor - provides typed access to an ArrayBuffer region
// Used for both pr_globals and per-edict field data.
//
export class EdictFieldAccessor {

	constructor( buffer, byteOffset, length ) {

		// buffer: ArrayBuffer
		// byteOffset: starting byte offset
		// length: number of 32-bit slots
		this._buffer = buffer;
		this._byteOffset = byteOffset;
		this._length = length;
		this._floatView = new Float32Array( buffer, byteOffset, length );
		this._intView = new Int32Array( buffer, byteOffset, length );

	}

	getFloat( ofs ) {

		return this._floatView[ ofs ];

	}

	setFloat( ofs, v ) {

		this._floatView[ ofs ] = v;

	}

	getInt32( ofs ) {

		return this._intView[ ofs ];

	}

	setInt32( ofs, v ) {

		this._intView[ ofs ] = v;

	}

	getVector( ofs ) {

		return new Float32Array( this._buffer, this._byteOffset + ofs * 4, 3 );

	}

	setVector( ofs, v ) {

		this._floatView[ ofs ] = v[ 0 ];
		this._floatView[ ofs + 1 ] = v[ 1 ];
		this._floatView[ ofs + 2 ] = v[ 2 ];

	}

	// Clear a range of slots to zero
	clear( startOfs, count ) {

		for ( let i = 0; i < count; i ++ ) {

			this._intView[ startOfs + i ] = 0;

		}

	}

	// Clear all slots
	clearAll() {

		this._intView.fill( 0 );

	}

}

//
// edict_t - entity dictionary entry
//
export class edict_t {

	constructor( index, entityfields ) {

		this.index = index; // entity number (replaces pointer arithmetic)
		this.free = false;

		this.area = new link_t(); // linked to a division node or leaf

		this.num_leafs = 0;
		// Deliberate deviation (Ironwail edict_t): int leaf numbers, since
		// BSP2 maps may have more than 32767 leafs. The C holds shorts.
		this.leafnums = new Int32Array( MAX_ENT_LEAFS );

		this.baseline = new entity_state_t();

		this.freetime = 0.0; // sv.time when the object was freed

		this.alpha = 0; // johnfitz -- ENTALPHA_* byte, from the "alpha" key or field (Ironwail edict_t)

		// Allocate field data backing buffer
		// entityfields is the number of int/float slots for the v (entvars) fields
		// Additional fields from progs come immediately after
		this._fieldBuffer = new ArrayBuffer( entityfields * 4 );
		this._fieldAccessor = new EdictFieldAccessor( this._fieldBuffer, 0, entityfields );

		// C exported fields from progs (entvars_t)
		this.v = new entvars_t( this._fieldAccessor );

		// Store entityfields count for clearing
		this._entityfields = entityfields;

	}

	// Clear entity variable fields (memset &e->v to 0)
	clearFields() {

		this._fieldAccessor.clearAll();

	}

}

//============================================================================
// Progs module state
//============================================================================

export let progs = null; // dprograms_t
export let pr_functions = null; // dfunction_t[]
export let pr_strings = ''; // string table (raw string data)
export let pr_strings_data = null; // Uint8Array of raw string bytes
export let pr_strings_size = 0; // bytes in use; pr_strings_data may have zeroed spare capacity past this
export let pr_globaldefs = null; // ddef_t[]
export let pr_fielddefs = null; // ddef_t[]
export let pr_statements = null; // dstatement_t[]
export let pr_global_struct = null; // globalvars_t
export let pr_globals = null; // EdictFieldAccessor (same memory as pr_global_struct)
export let pr_globals_float = null; // Float32Array view on globals
export let pr_globals_int = null; // Int32Array view on globals

export let pr_edict_size = 0; // in bytes (C: sizeof edict_t fields portion)

export let pr_crc = 0;

// Temp string buffers for PF_ftos/PF_vtos, at the end of pr_strings_data.
// Deliberate deviation from id (pr_cmds.c pr_string_temp[128], one shared
// buffer), taken from Ironwail/QuakeSpasm (pr_cmds.c PR_GetTempString): a
// ring of buffers, so bprint( ftos( a ), ftos( b ) ) prints both values rather
// than b twice. Ironwail declares 1024 buffers but indexes them with a byte,
// so only 256 are ever used; we reserve those 256. Each is Ironwail's 1024
// bytes, which the string extension builtins (strcat, substring, sprintf,
// argv) need; id's 128 was only ever filled by ftos and vtos.
export const STRINGTEMP_BUFFERS = 256;
export const STRINGTEMP_LENGTH = 1024;
export let pr_string_temp_ofs = - 1;
let pr_string_tempindex = 0; // C: static byte pr_string_tempindex

// type_size[etype] - number of int/float slots per type
export const type_size = [ 1, 1, 1, 3, 1, 1, 1, 1 ];

//============================================================================
// Setter functions for module state (since we use export let)
//============================================================================

export function PR_SetProgs( p ) { progs = p; }
export function PR_SetFunctions( f ) { pr_functions = f; }
export function PR_SetStrings( s ) { pr_strings = s; }
export function PR_SetStringsData( d ) {

	pr_strings_data = d;
	pr_strings_size = d != null ? d.length : 0;

}
export function PR_SetGlobalDefs( g ) { pr_globaldefs = g; }
export function PR_SetFieldDefs( f ) { pr_fielddefs = f; }
export function PR_SetStatements( s ) { pr_statements = s; }
export function PR_SetGlobalStruct( g ) { pr_global_struct = g; }
export function PR_SetGlobals( g ) { pr_globals = g; }
export function PR_SetGlobalsFloat( f ) { pr_globals_float = f; }
export function PR_SetGlobalsInt( i ) { pr_globals_int = i; }
export function PR_SetEdictSize( s ) { pr_edict_size = s; }
export function PR_SetCRC( c ) { pr_crc = c; }
export function PR_SetStringTempOfs( o ) { pr_string_temp_ofs = o; }

// Host_Error lives in host.js, which imports the server and client; the
// server installs it here (SV_Init) so the QuakeC VM can raise it without an
// import cycle. Kept in progs.js so EDICT_NUM and NUM_FOR_EDICT can use it.
let Host_Error = null;

export function PR_SetHostError( callback ) {

	const previous = Host_Error;
	Host_Error = callback;
	return previous;

}

export function PR_HostError( error ) {

	if ( Host_Error === null )
		Sys_Error( 'PR_HostError: Host_Error callback not set' );

	Host_Error( error );
	Sys_Error( 'PR_HostError: Host_Error returned' );

}

// Write a string into the next pr_string_temp buffer (STRINGTEMP_LENGTH bytes
// with its NUL) and return its offset into pr_strings_data. Mirrors Ironwail's
// PR_GetTempString: pre-increment a byte index, so the first buffer used is 1.
export function PR_SetTempString( str ) {

	pr_string_tempindex = ( pr_string_tempindex + 1 ) & 0xff;
	const ofs = pr_string_temp_ofs + ( ( STRINGTEMP_BUFFERS - 1 ) & pr_string_tempindex ) * STRINGTEMP_LENGTH;

	const len = Math.min( str.length, STRINGTEMP_LENGTH - 1 ); // leave room for the NUL
	for ( let i = 0; i < len; i ++ ) {

		pr_strings_data[ ofs + i ] = str.charCodeAt( i );

	}

	pr_strings_data[ ofs + len ] = 0; // null terminator
	return ofs;

}

// Zoned strings for the strzone/strunzone builtins. Ironwail Z_Mallocs each
// one and tracks it in qcvm->knownzone; here each is a block in
// pr_strings_data, and strunzone puts the block on a free list that later
// strzone calls reuse, so a mod that zones strings every frame doesn't grow
// the string table without bound. PR_LoadProgs clears both lists, because it
// replaces the string table.
const pr_zone_live = new Map(); // offset -> block size in bytes, with the NUL
const pr_zone_free = []; // { ofs, size }

export function PR_ZoneString( str ) {

	const need = str.length + 1;

	// best fit among the freed blocks
	let best = - 1;
	for ( let i = 0; i < pr_zone_free.length; i ++ ) {

		const size = pr_zone_free[ i ].size;
		if ( size >= need && ( best < 0 || size < pr_zone_free[ best ].size ) )
			best = i;

	}

	if ( best < 0 ) {

		const ofs = PR_AppendString( str );
		pr_zone_live.set( ofs, need );
		return ofs;

	}

	const block = pr_zone_free[ best ];
	pr_zone_free.splice( best, 1 );
	for ( let i = 0; i < str.length; i ++ )
		pr_strings_data[ block.ofs + i ] = str.charCodeAt( i ) & 0xff;
	pr_strings_data[ block.ofs + str.length ] = 0;
	pr_zone_live.set( block.ofs, block.size );
	return block.ofs;

}

// Returns false if ofs is not a live zoned string
export function PR_UnzoneString( ofs ) {

	const size = pr_zone_live.get( ofs );
	if ( size === undefined )
		return false;

	pr_zone_live.delete( ofs );
	pr_zone_free.push( { ofs, size } );
	pr_strings_data[ ofs ] = 0; // a stale reference now reads as ""
	return true;

}

export function PR_ClearZoneStrings() {

	pr_zone_live.clear();
	pr_zone_free.length = 0;

}

// Append a NUL-terminated string (one byte per character, Latin-1, as
// PR_GetString decodes it) and return its offset. This stands in for C's
// Hunk_Alloc in ED_NewString. Capacity doubles, so spawning a map's entities
// reallocates the table a few times rather than once per string.
export function PR_AppendString( str ) {

	const ofs = pr_strings_size;
	const end = ofs + str.length + 1;

	if ( end > pr_strings_data.length ) {

		const grown = new Uint8Array( Math.max( end, pr_strings_data.length * 2 ) );
		grown.set( pr_strings_data.subarray( 0, pr_strings_size ) );
		pr_strings_data = grown;

	}

	for ( let i = 0; i < str.length; i ++ )
		pr_strings_data[ ofs + i ] = str.charCodeAt( i ) & 0xff;
	pr_strings_data[ end - 1 ] = 0;

	pr_strings_size = end;
	return ofs;

}

//============================================================================
// Global access helper macros (ported as functions)
// These match the C macros: G_FLOAT, G_INT, G_VECTOR, G_STRING, etc.
//============================================================================

export function G_FLOAT( o ) {

	return pr_globals_float[ o ];

}

export function G_FLOAT_SET( o, v ) {

	pr_globals_float[ o ] = v;

}

export function G_INT( o ) {

	return pr_globals_int[ o ];

}

export function G_INT_SET( o, v ) {

	pr_globals_int[ o ] = v;

}

export function G_VECTOR( o ) {

	return new Float32Array( pr_globals_float.buffer, pr_globals_float.byteOffset + o * 4, 3 );

}

export function G_STRING( o ) {

	return PR_GetString( pr_globals_int[ o ] );

}

export function G_FUNCTION( o ) {

	return pr_globals_int[ o ];

}

//============================================================================
// String table helpers
//============================================================================

export function PR_GetString( ofs ) {

	// Bound by the bytes in use, not the buffer: PR_AppendString leaves zeroed
	// spare capacity past pr_strings_size.
	if ( ofs < 0 || ofs >= pr_strings_size ) return '';

	let s = '';
	for ( let i = ofs; i < pr_strings_size; i ++ ) {

		if ( pr_strings_data[ i ] === 0 ) break;
		s += String.fromCharCode( pr_strings_data[ i ] );

	}

	return s;

}

//============================================================================
// Edict number <-> pointer helpers
// In C these use byte pointer arithmetic on sv.edicts.
// In JS we use an array of edict_t objects.
//============================================================================

// These are set by the server module
export let sv = null; // will reference the server state
export let svs = null; // will reference the persistent server state

export function PR_SetSV( s ) { sv = s; }
export function PR_SetSVS( s ) { svs = s; }

export function EDICT_NUM( n ) {

	// id has Sys_Error; Host_Error is Ironwail's (deliberate deviation)
	if ( n < 0 || n >= sv.max_edicts )
		PR_HostError( 'EDICT_NUM: bad number ' + n );

	if ( n >= sv.edicts.length )
		ED_GrowEdicts( n + 1 );

	return sv.edicts[ n ];

}

/*
=================
ED_GrowEdicts

Not in C, which allocates all sv.max_edicts edicts at map load. With
MAX_EDICTS at 32000 (quakedef.js) that would cost tens of megabytes per
map, so sv.edicts starts smaller (SV_SpawnServer) and grows here, up to
sv.max_edicts. ED_Alloc keeps one edict past sv.num_edicts, so NEXT_EDICT
of the last edict is a free one, as with C's fixed array.
=================
*/
export function ED_GrowEdicts( count ) {

	const edicts = sv.edicts;
	if ( count > sv.max_edicts )
		count = sv.max_edicts;
	const entityfields = edicts[ 0 ]._entityfields;
	for ( let i = edicts.length; i < count; i ++ )
		edicts.push( new edict_t( i, entityfields ) );

}

export function NUM_FOR_EDICT( e ) {

	const n = e.index;

	// id has Sys_Error; Host_Error is Ironwail's (deliberate deviation)
	if ( n < 0 || n >= sv.num_edicts )
		PR_HostError( 'NUM_FOR_EDICT: bad pointer' );

	return n;

}

export function NEXT_EDICT( e ) {

	return sv.edicts[ e.index + 1 ];

}

export function EDICT_TO_PROG( e ) {

	return e.index;

}

export function PROG_TO_EDICT( e ) {

	return sv.edicts[ e ];

}

//============================================================================
// Edict field access helpers (match C macros)
// E_FLOAT, E_INT, E_VECTOR, E_STRING
//============================================================================

export function E_FLOAT( e, o ) {

	return e._fieldAccessor.getFloat( o );

}

export function E_FLOAT_SET( e, o, v ) {

	e._fieldAccessor.setFloat( o, v );

}

export function E_INT( e, o ) {

	return e._fieldAccessor.getInt32( o );

}

export function E_INT_SET( e, o, v ) {

	e._fieldAccessor.setInt32( o, v );

}

export function E_VECTOR( e, o ) {

	return e._fieldAccessor.getVector( o );

}

export function E_STRING( e, o ) {

	return PR_GetString( e._fieldAccessor.getInt32( o ) );

}

//============================================================================
// G_EDICT, G_EDICTNUM - read edict from globals
//============================================================================

export function G_EDICT( o ) {

	return PROG_TO_EDICT( pr_globals_int[ o ] );

}

export function G_EDICTNUM( o ) {

	return NUM_FOR_EDICT( G_EDICT( o ) );

}

export function RETURN_EDICT( e ) {

	pr_globals_int[ OFS_RETURN ] = EDICT_TO_PROG( e );

}

//============================================================================
// Builtin function types
//============================================================================

export let pr_builtins = null; // Function[]
export let pr_numbuiltins = 0;

export function PR_SetBuiltins( b, n ) {

	pr_builtins = b;
	pr_numbuiltins = n;

}

export let pr_argc = 0;

export function PR_SetArgc( n ) { pr_argc = n; }

export let pr_trace = false;
export let pr_xfunction = null; // dfunction_t
export let pr_xstatement = 0;

export function PR_SetTrace( t ) { pr_trace = t; }
export function PR_SetXFunction( f ) { pr_xfunction = f; }
export function PR_SetXStatement( s ) { pr_xstatement = s; }
