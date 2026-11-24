// QuakeC VM and builtin fixes taken from Ironwail: PF_lightstyle bounds check,
// PF_traceline NaN guard, rotating ftos/vtos temp strings, Host_Error for
// edict errors

import { CONTENTS_EMPTY } from '../src/bspfile.js';
import { SZ_Alloc, sizebuf_t } from '../src/common.js';
import { PR_InitBuiltins } from '../src/pr_cmds.js';
import { OFS_PARM0, OFS_PARM1, OFS_PARM2, OFS_PARM3, OFS_PARM4, OFS_RETURN } from '../src/pr_comp.js';
import { PR_AllocEdicts } from '../src/pr_edict.js';
import {
	pr_builtins, pr_numbuiltins, pr_global_struct,
	pr_globals_float, pr_globals_int, pr_strings_data, pr_string_temp_ofs, sv as progs_sv,
	PR_SetBuiltins, PR_SetGlobalStruct, PR_SetGlobalsFloat, PR_SetGlobalsInt, PR_SetSV,
	PR_SetStringsData, PR_SetStringTempOfs, PR_GetString,
	STRINGTEMP_BUFFERS, STRINGTEMP_LENGTH,
	EDICT_NUM, NUM_FOR_EDICT,
} from '../src/progs.js';
import { PR_SetHostError } from '../src/pr_exec.js';
import { MAX_LIGHTSTYLES } from '../src/quakedef.js';
import { MOVETYPE_PUSH, SOLID_BSP, ss_active, sv, svs } from '../src/server.js';
import { SV_ClearWorld } from '../src/world.js';

const PF_SOUND = 8;
const PF_TRACELINE = 16;
const PF_FTOS = 26;
const PF_VTOS = 27;
const PF_LIGHTSTYLE = 35;

function assertEqual( actual, expected, message ) {

	if ( actual !== expected )
		throw new Error( `${message}: expected ${JSON.stringify( expected )}, got ${JSON.stringify( actual )}` );

}

// Install fresh globals and builtins for one test; returns a restore function.
function setupGlobals( qcGlobals ) {

	const oldBuiltins = pr_builtins;
	const oldNumBuiltins = pr_numbuiltins;
	const oldGlobalStruct = pr_global_struct;
	const oldGlobalsFloat = pr_globals_float;
	const oldGlobalsInt = pr_globals_int;
	const oldStrings = pr_strings_data;
	const oldTempOfs = pr_string_temp_ofs;
	const oldProgsSV = progs_sv;

	const buffer = new ArrayBuffer( 64 * 4 );
	PR_SetGlobalStruct( qcGlobals );
	PR_SetGlobalsFloat( new Float32Array( buffer ) );
	PR_SetGlobalsInt( new Int32Array( buffer ) );
	PR_InitBuiltins();

	return () => {

		PR_SetBuiltins( oldBuiltins, oldNumBuiltins );
		PR_SetGlobalStruct( oldGlobalStruct );
		PR_SetGlobalsFloat( oldGlobalsFloat );
		PR_SetGlobalsInt( oldGlobalsInt );
		PR_SetStringsData( oldStrings );
		PR_SetStringTempOfs( oldTempOfs );
		PR_SetSV( oldProgsSV );

	};

}

Deno.test( 'PF_lightstyle ignores out-of-range styles', () => {

	const restore = setupGlobals( {} );
	const oldState = sv.state;
	const oldLightstyles = sv.lightstyles;
	const oldClients = svs.clients;
	const oldMaxclients = svs.maxclients;

	try {

		const message = new sizebuf_t();
		SZ_Alloc( message, 64 );
		PR_SetSV( sv );
		sv.state = ss_active;
		sv.lightstyles = new Array( MAX_LIGHTSTYLES ).fill( null );
		svs.clients = [ { active: true, spawned: true, message } ];
		svs.maxclients = 1;
		PR_SetStringsData( new TextEncoder().encode( '\0mmnmmommommnonmmonqnmmo\0' ) );

		for ( const style of [ - 1, MAX_LIGHTSTYLES, 1000 ] ) {

			pr_globals_float[ OFS_PARM0 ] = style;
			pr_globals_int[ OFS_PARM1 ] = 1;
			pr_builtins[ PF_LIGHTSTYLE ]();
			assertEqual( message.cursize, 0, 'no svc_lightstyle for style ' + style );

		}

		assertEqual( sv.lightstyles.length, MAX_LIGHTSTYLES, 'sv.lightstyles not grown' );
		assertEqual( sv.lightstyles.every( ( v ) => v === null ), true, 'sv.lightstyles untouched' );

		pr_globals_float[ OFS_PARM0 ] = MAX_LIGHTSTYLES - 1;
		pr_builtins[ PF_LIGHTSTYLE ]();
		assertEqual( sv.lightstyles[ MAX_LIGHTSTYLES - 1 ], 'mmnmmommommnonmmonqnmmo', 'last style set' );
		assertEqual( message.cursize > 0, true, 'last style sent' );

	} finally {

		sv.state = oldState;
		sv.lightstyles = oldLightstyles;
		svs.clients = oldClients;
		svs.maxclients = oldMaxclients;
		restore();

	}

} );

Deno.test( 'PF_traceline zeroes NaN start and end vectors', () => {

	const qcGlobals = {
		trace_endpos: new Float32Array( 3 ),
		trace_plane_normal: new Float32Array( 3 ),
	};
	const restore = setupGlobals( qcGlobals );
	const oldEdicts = sv.edicts;
	const oldNumEdicts = sv.num_edicts;
	const oldMaxEdicts = sv.max_edicts;
	const oldModels = sv.models;
	const oldWorldmodel = sv.worldmodel;

	const emptyHull = {
		firstclipnode: CONTENTS_EMPTY,
		lastclipnode: CONTENTS_EMPTY,
		clipnodes: [],
		planes: [],
		clip_mins: new Float32Array( 3 ),
	};
	const worldmodel = {
		type: 0,
		hulls: [ emptyHull, emptyHull, emptyHull ],
		mins: new Float32Array( [ - 4096, - 4096, - 4096 ] ),
		maxs: new Float32Array( [ 4096, 4096, 4096 ] ),
	};

	try {

		sv.edicts = PR_AllocEdicts( 2, 105 );
		sv.num_edicts = 2;
		sv.max_edicts = 2;
		sv.models = new Array( 256 ).fill( null );
		sv.models[ 1 ] = worldmodel;
		sv.worldmodel = worldmodel;
		PR_SetSV( sv );
		sv.edicts[ 0 ].v.solid = SOLID_BSP;
		sv.edicts[ 0 ].v.movetype = MOVETYPE_PUSH;
		sv.edicts[ 0 ].v.modelindex = 1;
		SV_ClearWorld();

		const gf = pr_globals_float;

		// NaN start: traced from the origin instead
		gf.set( [ NaN, 0, 0 ], OFS_PARM0 );
		gf.set( [ 100, 20, 30 ], OFS_PARM1 );
		gf[ OFS_PARM2 ] = 0;
		pr_globals_int[ OFS_PARM3 ] = 1;
		pr_builtins[ PF_TRACELINE ]();
		assertEqual( Array.from( gf.subarray( OFS_PARM0, OFS_PARM0 + 3 ) ).join( ',' ), '0,0,0', 'v1 zeroed in place' );
		assertEqual( qcGlobals.trace_fraction, 1, 'fraction' );
		assertEqual( Array.from( qcGlobals.trace_endpos ).join( ',' ), '100,20,30', 'endpos' );

		// NaN end: traced to the origin instead
		gf.set( [ 10, 20, 30 ], OFS_PARM0 );
		gf.set( [ 1, NaN, 3 ], OFS_PARM1 );
		pr_builtins[ PF_TRACELINE ]();
		assertEqual( Array.from( gf.subarray( OFS_PARM1, OFS_PARM1 + 3 ) ).join( ',' ), '0,0,0', 'v2 zeroed in place' );
		assertEqual( Array.from( qcGlobals.trace_endpos ).join( ',' ), '0,0,0', 'endpos at origin' );

	} finally {

		sv.edicts = oldEdicts;
		sv.num_edicts = oldNumEdicts;
		sv.max_edicts = oldMaxEdicts;
		sv.models = oldModels;
		sv.worldmodel = oldWorldmodel;
		SV_ClearWorld();
		restore();

	}

} );

Deno.test( 'ftos and vtos results survive later temp strings until the ring wraps', () => {

	const restore = setupGlobals( {} );

	try {

		PR_SetStringsData( new Uint8Array( 1 + STRINGTEMP_BUFFERS * STRINGTEMP_LENGTH ) );
		PR_SetStringTempOfs( 1 );

		// bprint( ftos( a ), ftos( b ) ): both strings must still be intact
		pr_globals_float[ OFS_PARM0 ] = 12;
		pr_builtins[ PF_FTOS ]();
		const a = pr_globals_int[ OFS_RETURN ];
		pr_globals_float[ OFS_PARM0 ] = 3.5;
		pr_builtins[ PF_FTOS ]();
		const b = pr_globals_int[ OFS_RETURN ];
		pr_globals_float.set( [ 1, - 2, 3.5 ], OFS_PARM0 );
		pr_builtins[ PF_VTOS ]();
		const c = pr_globals_int[ OFS_RETURN ];

		assertEqual( PR_GetString( a ), '12', 'first ftos' );
		assertEqual( PR_GetString( b ), '  3.5', 'second ftos' );
		assertEqual( PR_GetString( c ), '\'  1.0  -2.0   3.5\'', 'vtos' );

		// STRINGTEMP_BUFFERS calls later the first buffer is reused
		for ( let i = 0; i < STRINGTEMP_BUFFERS - 3; i ++ )
			pr_builtins[ PF_FTOS ]();
		pr_globals_float[ OFS_PARM0 ] = 7;
		pr_builtins[ PF_FTOS ]();
		assertEqual( pr_globals_int[ OFS_RETURN ], a, 'ring wrapped to the first buffer' );
		assertEqual( PR_GetString( a ), '7', 'wrapped buffer rewritten' );
		assertEqual( PR_GetString( b ), '  3.5', 'next buffer still intact' );

		const offsets = new Set();
		for ( let i = 0; i < STRINGTEMP_BUFFERS; i ++ ) {

			pr_builtins[ PF_FTOS ]();
			const ofs = pr_globals_int[ OFS_RETURN ];
			assertEqual( ofs >= 1 && ofs + STRINGTEMP_LENGTH <= pr_strings_data.length, true, 'buffer in range' );
			offsets.add( ofs );

		}

		assertEqual( offsets.size, STRINGTEMP_BUFFERS, 'every buffer used once per lap' );

	} finally {

		restore();

	}

} );

Deno.test( 'EDICT_NUM and NUM_FOR_EDICT raise Host_Error', () => {

	const oldProgsSV = progs_sv;
	const errors = [];
	const oldHostError = PR_SetHostError( ( message ) => {

		errors.push( message );
		throw new Error( 'Host_Error: ' + message );

	} );

	try {

		const edicts = PR_AllocEdicts( 2, 105 );
		PR_SetSV( { num_edicts: 1, max_edicts: 2, edicts } );

		let threw = false;
		try {

			EDICT_NUM( 2 );

		} catch {

			threw = true;

		}

		assertEqual( threw, true, 'EDICT_NUM threw' );
		assertEqual( errors[ 0 ], 'EDICT_NUM: bad number 2', 'EDICT_NUM message' );

		threw = false;
		try {

			NUM_FOR_EDICT( edicts[ 1 ] );

		} catch {

			threw = true;

		}

		assertEqual( threw, true, 'NUM_FOR_EDICT threw' );
		assertEqual( errors[ 1 ], 'NUM_FOR_EDICT: bad pointer', 'NUM_FOR_EDICT message' );

	} finally {

		PR_SetHostError( oldHostError );
		PR_SetSV( oldProgsSV );

	}

} );

Deno.test( 'PF_sound raises Host_Error for a bad volume, attenuation or channel', () => {

	const restore = setupGlobals( {} );
	const errors = [];
	const oldHostError = PR_SetHostError( ( message ) => {

		errors.push( message );
		throw new Error( 'Host_Error: ' + message );

	} );

	try {

		PR_SetSV( { num_edicts: 1, max_edicts: 1, edicts: PR_AllocEdicts( 1, 105 ) } );
		PR_SetStringsData( new TextEncoder().encode( '\0misc/null.wav\0' ) );
		const cases = [
			[ 0, 2, 1, 'SV_StartSound: volume = 510' ],
			[ 0, 1, 5, 'SV_StartSound: attenuation = 5.000000' ],
			[ 8, 1, 1, 'SV_StartSound: channel = 8' ],
		];

		for ( const [ channel, volume, attenuation, expected ] of cases ) {

			pr_globals_int[ OFS_PARM0 ] = 0;
			pr_globals_float[ OFS_PARM1 ] = channel;
			pr_globals_int[ OFS_PARM2 ] = 1;
			pr_globals_float[ OFS_PARM3 ] = volume;
			pr_globals_float[ OFS_PARM4 ] = attenuation;

			let threw = false;
			try {

				pr_builtins[ PF_SOUND ]();

			} catch {

				threw = true;

			}

			assertEqual( threw, true, expected + ' threw' );
			assertEqual( errors.at( - 1 ), expected, 'message' );

		}

	} finally {

		PR_SetHostError( oldHostError );
		restore();

	}

} );
