// ED_ParseGlobals returns the text after the globals block (Ironwail), so
// Host_Loadgame_f can go on to parse the edicts from there.

import * as common from '../src/common.js';
import { ED_ParseGlobals } from '../src/pr_edict.js';
import { progs, PR_SetProgs } from '../src/progs.js';

function assertEqual( actual, expected, message ) {

	if ( actual !== expected )
		throw new Error( `${message}: expected ${JSON.stringify( expected )}, got ${JSON.stringify( actual )}` );

}

Deno.test( 'ED_ParseGlobals returns the text after the closing brace', () => {

	const printed = [];
	const oldProgs = progs;
	common.Con_SetPrintFunctions( ( fmt, ...args ) => printed.push( fmt.replace( '%s', String( args[ 0 ] ) ) ), () => {} );
	try {

		// no global defs: every key is reported and skipped
		PR_SetProgs( { numglobaldefs: 0 } );
		const rest = ED_ParseGlobals( '"a" "1"\n"b" "x } y"\n}\n{ "c" "d" }' );
		assertEqual( rest.trim(), '{ "c" "d" }', 'rest' );
		assertEqual( printed.join( '' ), '\'a\' is not a global\n\'b\' is not a global\n', 'unknown keys' );

	} finally {

		PR_SetProgs( oldProgs );
		common.Con_SetPrintFunctions( null, null );

	}

} );
