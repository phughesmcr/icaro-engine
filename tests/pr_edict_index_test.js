import { ED_FindField, ED_FindGlobal, ED_FindFunction } from '../src/pr_edict.js';
import * as pr from '../src/progs.js';
import { dprograms_t, ddef_t, dfunction_t } from '../src/pr_comp.js';

// String table: "\0alpha\0beta\0alpha\0"
const strings = new TextEncoder().encode( '\0alpha\0beta\0alpha\0' );
const ALPHA = 1, BETA = 7, ALPHA2 = 12;

function def( s_name, ofs ) {

	const d = new ddef_t();
	d.s_name = s_name;
	d.ofs = ofs;
	return d;

}

function func( s_name ) {

	const f = new dfunction_t();
	f.s_name = s_name;
	return f;

}

Deno.test( 'ED_Find* give the first def of a name and follow a reloaded progs', () => {

	const old = {
		progs: pr.progs, fields: pr.pr_fielddefs, globals: pr.pr_globaldefs,
		functions: pr.pr_functions, strings: pr.pr_strings_data,
	};

	try {

		const header = new dprograms_t();
		header.numfielddefs = 3;
		header.numglobaldefs = 3;
		header.numfunctions = 3;
		pr.PR_SetProgs( header );
		pr.PR_SetStringsData( strings );
		pr.PR_SetFieldDefs( [ def( BETA, 10 ), def( ALPHA, 20 ), def( ALPHA2, 30 ) ] );
		pr.PR_SetGlobalDefs( [ def( BETA, 10 ), def( ALPHA, 20 ), def( ALPHA2, 30 ) ] );
		const functions = [ func( BETA ), func( ALPHA ), func( ALPHA2 ) ];
		pr.PR_SetFunctions( functions );

		if ( ED_FindField( 'alpha' ).ofs !== 20 ) throw new Error( 'field: first duplicate must win' );
		if ( ED_FindField( 'beta' ).ofs !== 10 ) throw new Error( 'field beta' );
		if ( ED_FindField( 'gamma' ) !== null ) throw new Error( 'field: a missing name gives null' );
		if ( ED_FindGlobal( 'alpha' ).ofs !== 20 ) throw new Error( 'global: first duplicate must win' );
		if ( ED_FindGlobal( 'gamma' ) !== null ) throw new Error( 'global: a missing name gives null' );
		if ( ED_FindFunction( 'alpha' ) !== functions[ 1 ] ) throw new Error( 'function: first duplicate must win' );
		if ( ED_FindFunction( 'gamma' ) !== null ) throw new Error( 'function: a missing name gives null' );

		// a new progs replaces the tables
		header.numfielddefs = 1;
		pr.PR_SetFieldDefs( [ def( ALPHA, 99 ) ] );
		if ( ED_FindField( 'alpha' ).ofs !== 99 ) throw new Error( 'field index went stale after a reload' );
		if ( ED_FindField( 'beta' ) !== null ) throw new Error( 'stale field index still finds beta' );

	} finally {

		pr.PR_SetProgs( old.progs );
		pr.PR_SetStringsData( old.strings );
		pr.PR_SetFieldDefs( old.fields );
		pr.PR_SetGlobalDefs( old.globals );
		pr.PR_SetFunctions( old.functions );

	}

} );
