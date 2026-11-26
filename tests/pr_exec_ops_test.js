import { PR_ExecuteProgram } from '../src/pr_exec.js';
import * as pr_comp from '../src/pr_comp.js';
import { OP_DONE, OP_EQ_S, OP_NE_S } from '../src/pr_comp.js';
import {
	progs, pr_functions, pr_strings_data, pr_statements, pr_code,
	pr_globals_float, pr_globals_int, pr_trace, pr_xfunction, pr_xstatement,
	PR_SetProgs, PR_SetFunctions, PR_SetStringsData, PR_SetStatements,
	PR_SetGlobalsFloat, PR_SetGlobalsInt, PR_SetTrace,
	PR_SetXFunction, PR_SetXStatement,
} from '../src/progs.js';

// The interpreter switch uses integer literals for its case labels (V8 only
// builds a jump table for those), each with its OP_ name in a comment. Check
// every label against pr_comp.js, so a renumbered opcode can't go unnoticed.
Deno.test( 'pr_exec.js case labels match the OP_ constants in pr_comp.js', () => {

	const source = Deno.readTextFileSync( new URL( '../src/pr_exec.js', import.meta.url ) );

	// the body of the interpreter switch, by brace matching. The patterns
	// allow any spacing, so they hold with or without deno fmt's layout
	const at = source.search( /switch\s*\(\s*code\[\s*o\s*\]\s*\)/ );
	if ( at < 0 )
		throw new Error( 'interpreter switch not found' );
	const open = source.indexOf( '{', at );
	let depth = 0, close = open;
	for ( ; close < source.length; close ++ ) {

		if ( source[ close ] === '{' ) depth ++;
		else if ( source[ close ] === '}' && -- depth === 0 ) break;

	}

	const body = source.slice( open, close );

	// every case must be an integer literal labelled with its OP_ name
	const cases = ( body.match( /^\s*case\b[^\n]*/gm ) ?? [] ).map( ( l ) => l.trim() );
	const seen = new Set();
	for ( const line of cases ) {

		const m = /^case (\d+):\s*\{?\s*\/\/ (OP_\w+)/.exec( line );
		if ( m === null )
			throw new Error( `case without an OP_ label: ${line}` );
		const want = pr_comp[ m[ 2 ] ];
		if ( want !== Number( m[ 1 ] ) )
			throw new Error( `case ${m[ 1 ]} is labelled ${m[ 2 ]}, which is ${want}` );
		if ( seen.has( m[ 2 ] ) )
			throw new Error( `${m[ 2 ]} has two cases` );
		seen.add( m[ 2 ] );

	}

	// and every opcode pr_comp.js defines must have one
	for ( const name of Object.keys( pr_comp ) )
		if ( name.startsWith( 'OP_' ) && ! seen.has( name ) )
			throw new Error( `${name} has no case in the interpreter switch` );

} );

Deno.test( 'PR_SetStatements keeps pr_code in step with pr_statements', () => {

	const old = pr_statements;
	try {

		PR_SetStatements( [ { op: 5, a: - 3, b: 7, c: 9 }, { op: OP_DONE, a: 1, b: 2, c: 3 } ] );
		const want = [ 5, - 3, 7, 9, OP_DONE, 1, 2, 3 ];
		if ( pr_code.length !== want.length || want.some( ( v, i ) => pr_code[ i ] !== v ) )
			throw new Error( 'pr_code does not mirror the statements: ' + Array.from( pr_code ) );

		PR_SetStatements( null );
		if ( pr_code !== null )
			throw new Error( 'pr_code should be null when the statements are' );

	} finally {

		PR_SetStatements( old );

	}

} );

// OP_EQ_S and OP_NE_S compare the table bytes. PR_strcmp over PR_GetString
// gives the reference result for every pair, including offsets outside the table.
Deno.test( 'OP_EQ_S and OP_NE_S compare strings in the table', () => {

	const saved = {
		progs, pr_functions, pr_strings_data, pr_statements, pr_globals_float, pr_globals_int,
		pr_trace, pr_xfunction, pr_xstatement,
	};
	const text = [ '', 'a', 'ab', 'abc', 'abd', 'b', '\xe9', 'e', 'abc' ];
	const bytes = [];
	const offsets = [];
	for ( const s of text ) {

		offsets.push( bytes.length );
		for ( let i = 0; i < s.length; i ++ )
			bytes.push( s.charCodeAt( i ) );
		bytes.push( 0 );

	}

	// a string running to the end of the table with no NUL, and bad offsets
	const unterminated = bytes.length;
	bytes.push( 0x61, 0x62 );
	offsets.push( unterminated, - 4, bytes.length, bytes.length + 50 );

	const globalsBuffer = new ArrayBuffer( 64 * 4 );
	const gf = new Float32Array( globalsBuffer );
	const gi = new Int32Array( globalsBuffer );
	const fn = {
		first_statement: 0, parm_start: 0, locals: 0, profile: 0, s_name: 0, s_file: 0,
		numparms: 0, parm_size: [],
	};

	try {

		PR_SetProgs( { numfunctions: 2 } );
		PR_SetFunctions( [ null, fn ] );
		PR_SetStringsData( new Uint8Array( bytes ) );
		PR_SetGlobalsFloat( gf );
		PR_SetGlobalsInt( gi );
		PR_SetTrace( false );
		PR_SetStatements( [
			{ op: OP_EQ_S, a: 30, b: 31, c: 32 },
			{ op: OP_NE_S, a: 30, b: 31, c: 33 },
			{ op: OP_DONE, a: 0, b: 0, c: 0 },
		] );

		const str = ( o ) => {

			let r = '';
			if ( o < 0 || o >= bytes.length ) return r;
			for ( let i = o; i < bytes.length && bytes[ i ] !== 0; i ++ )
				r += String.fromCharCode( bytes[ i ] );
			return r;

		};

		const cmp = ( a, b ) => {

			const n = Math.min( a.length, b.length );
			for ( let i = 0; i < n; i ++ ) {

				const d = a.charCodeAt( i ) - b.charCodeAt( i );
				if ( d !== 0 ) return d < 0 ? - 1 : 1;

			}

			return a.length === b.length ? 0 : ( a.length < b.length ? - 1 : 1 );

		};

		for ( const a of offsets ) {

			for ( const b of offsets ) {

				gi[ 30 ] = a;
				gi[ 31 ] = b;
				PR_ExecuteProgram( 1 );
				const c = cmp( str( a ), str( b ) );
				if ( gf[ 32 ] !== ( c === 0 ? 1 : 0 ) )
					throw new Error( `EQ_S ${a} ${b}: got ${gf[ 32 ]}` );
				if ( gf[ 33 ] !== c )
					throw new Error( `NE_S ${a} ${b}: got ${gf[ 33 ]}, want ${c}` );

			}

		}

	} finally {

		PR_SetProgs( saved.progs );
		PR_SetFunctions( saved.pr_functions );
		PR_SetStringsData( saved.pr_strings_data );
		PR_SetStatements( saved.pr_statements );
		PR_SetGlobalsFloat( saved.pr_globals_float );
		PR_SetGlobalsInt( saved.pr_globals_int );
		PR_SetTrace( saved.pr_trace );
		PR_SetXFunction( saved.pr_xfunction );
		PR_SetXStatement( saved.pr_xstatement );

	}

} );
