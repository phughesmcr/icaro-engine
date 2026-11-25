// Ironwail's (johnfitz's) cvar and alias commands: toggle, cycle, cycleback,
// inc, reset, resetall, resetcfg, cvarlist, cmdlist, apropos/find, unalias,
// unaliasall, "alias name", and the default in a cvar query.

const common = await import( '../src/common.js' );
const cmd = await import( '../src/cmd.js' );
const cvar = await import( '../src/cvar.js' );
const consolejs = await import( '../src/console.js' );

function assertEqual( actual, expected, message ) {

	if ( actual !== expected )
		throw new Error( `${message}: expected ${JSON.stringify( expected )}, got ${JSON.stringify( actual )}` );

}

function assert( cond, message ) {

	if ( cond !== true )
		throw new Error( message );

}

// Collects Con_Printf output, formatted the way console.js does
const printed = [];
common.Con_SetPrintFunctions(
	( fmt, ...args ) => printed.push( args.length === 0 ? String( fmt ) : consolejs._sprintf( fmt, ...args ) ),
	() => {}
);

function run( text ) {

	printed.length = 0;
	cmd.Cmd_ExecuteString( text, cmd.src_command );
	return printed.join( '' );

}

cmd.Cbuf_Init();
cmd.Cmd_Init();

const t_num = new cvar.cvar_t( 'test_cac_num', '1' );
const t_str = new cvar.cvar_t( 'test_cac_str', 'abc' );
const t_arch = new cvar.cvar_t( 'test_cac_arch', '5', true );
cvar.Cvar_RegisterVariable( t_num );
cvar.Cvar_RegisterVariable( t_str );
cvar.Cvar_RegisterVariable( t_arch );

function restore() {

	cvar.Cvar_Set( 'test_cac_num', '1' );
	cvar.Cvar_Set( 'test_cac_str', 'abc' );
	cvar.Cvar_Set( 'test_cac_arch', '5' );

}

Deno.test( 'Cvar_FindVar returns the cvar, or null when missing', () => {

	assertEqual( cvar.Cvar_FindVar( 'test_cac_num' ), t_num, 'found' );
	assertEqual( cvar.Cvar_FindVar( 'test_cac_missing' ), null, 'missing' );

} );

Deno.test( 'a cvar query prints its default', () => {

	try {

		assertEqual( run( 'test_cac_num' ), '"test_cac_num" is "1" (default)\n', 'at default' );
		cvar.Cvar_Set( 'test_cac_num', '7' );
		assertEqual( run( 'test_cac_num' ), '"test_cac_num" is "7" (default: "1")\n', 'changed' );

	} finally {

		restore();

	}

} );

Deno.test( 'the default is the registered value, not a saved one', () => {

	const saved = Object.getOwnPropertyDescriptor( globalThis, 'localStorage' );
	Object.defineProperty( globalThis, 'localStorage', {
		configurable: true,
		value: { getItem: ( k ) => ( k === 'quake_cvar_test_cac_saved' ? '9' : null ), setItem: () => {} }
	} );
	try {

		const v = new cvar.cvar_t( 'test_cac_saved', '3', true );
		cvar.Cvar_RegisterVariable( v );
		assertEqual( v.string, '9', 'saved value loaded' );
		assertEqual( v.default_string, '3', 'default kept' );
		run( 'reset test_cac_saved' );
		assertEqual( v.string, '3', 'reset' );

	} finally {

		if ( saved !== undefined ) Object.defineProperty( globalThis, 'localStorage', saved );
		else delete globalThis.localStorage;

	}

} );

Deno.test( 'toggle flips between 0 and 1', () => {

	try {

		run( 'toggle test_cac_num' );
		assertEqual( t_num.string, '0', 'off' );
		run( 'toggle test_cac_num' );
		assertEqual( t_num.string, '1', 'on' );
		cvar.Cvar_Set( 'test_cac_num', '0.5' );
		run( 'toggle test_cac_num' );
		assertEqual( t_num.string, '0', 'nonzero toggles off' );
		assertEqual( run( 'toggle' ), 'toggle <cvar> : toggle cvar\n', 'usage' );
		assertEqual( run( 'toggle test_cac_missing' ), 'Cvar_Set: variable test_cac_missing not found\n', 'missing' );

	} finally {

		restore();

	}

} );

Deno.test( 'inc adds 1 or the given amount', () => {

	try {

		run( 'inc test_cac_num' );
		assertEqual( t_num.value, 2, 'by one' );
		run( 'inc test_cac_num -0.5' );
		assertEqual( t_num.value, 1.5, 'by amount' );
		assertEqual( run( 'inc' ), 'inc <cvar> [amount] : increment cvar\n', 'usage' );

	} finally {

		restore();

	}

} );

Deno.test( 'cycle and cycleback step through the list and wrap', () => {

	try {

		run( 'cycle test_cac_num 1 2 3' );
		assertEqual( t_num.string, '2', 'forward' );
		run( 'cycle test_cac_num 1 2 3' );
		run( 'cycle test_cac_num 1 2 3' );
		assertEqual( t_num.string, '1', 'wraps forward' );
		run( 'cycleback test_cac_num 1 2 3' );
		assertEqual( t_num.string, '3', 'wraps back' );
		// numbers compare as numbers: "1.0" matches 1
		cvar.Cvar_Set( 'test_cac_num', '1.0' );
		run( 'cycle test_cac_num 1 2' );
		assertEqual( t_num.string, '2', 'numeric match' );
		// a value not in the list starts at the first
		cvar.Cvar_Set( 'test_cac_num', '9' );
		run( 'cycle test_cac_num 1 2' );
		assertEqual( t_num.string, '1', 'no match' );

		cvar.Cvar_Set( 'test_cac_num', '2' );
		run( 'cycleback test_cac_num 1 2 3' );
		assertEqual( t_num.string, '1', 'back from the middle' );

		run( 'cycle test_cac_str abc def' );
		assertEqual( t_str.string, 'def', 'strings' );

		assert( run( 'cycle test_cac_missing 1 2' ).includes( 'not found' ), 'missing cvar' );
		assert( run( 'cycle test_cac_num' ).startsWith( 'cycle <cvar> <value list>' ), 'usage' );

	} finally {

		restore();

	}

} );

Deno.test( 'reset, resetall and resetcfg restore defaults', () => {

	try {

		cvar.Cvar_Set( 'test_cac_num', '8' );
		run( 'reset test_cac_num' );
		assertEqual( t_num.string, '1', 'reset' );
		assertEqual( run( 'reset test_cac_missing' ), 'variable "test_cac_missing" not found\n', 'missing' );

		cvar.Cvar_Set( 'test_cac_num', '8' );
		cvar.Cvar_Set( 'test_cac_arch', '8' );
		run( 'resetcfg' );
		assertEqual( t_num.string, '8', 'resetcfg leaves unarchived cvars' );
		assertEqual( t_arch.string, '5', 'resetcfg resets archived cvars' );

		cvar.Cvar_Set( 'test_cac_arch', '8' );
		cvar.Cvar_Set( 'test_cac_str', 'zzz' );
		run( 'resetall' );
		assertEqual( t_num.string, '1', 'resetall num' );
		assertEqual( t_str.string, 'abc', 'resetall str' );
		assertEqual( t_arch.string, '5', 'resetall arch' );

	} finally {

		restore();

	}

} );

Deno.test( 'cvarlist lists matching cvars, sorted, with flags', () => {

	const out = run( 'cvarlist test_cac_' );
	const lines = out.split( '\n' );
	const i_arch = lines.indexOf( '*  test_cac_arch "5"' );
	const i_num = lines.indexOf( '   test_cac_num "1"' );
	assert( i_arch !== - 1 && i_num !== - 1 && i_arch < i_num, 'sorted with flags: ' + out );
	assert( out.endsWith( ' cvars beginning with "test_cac_"\n' ), 'count line: ' + out );

} );

Deno.test( 'cmdlist lists matching commands, sorted', () => {

	assert( /\n\d+ commands\n$/.test( run( 'cmdlist' ) ), 'no argument' );
	assertEqual( run( 'cmdlist unal' ), '   unalias\n   unaliasall\n2 commands beginning with "unal"\n', 'unal' );

} );

Deno.test( 'apropos and find search commands and cvars, ignoring case', () => {

	const out = run( 'apropos TEST_CAC_N' );
	assertEqual( out, '   test_cac_num (current value: "1")\n1 cvar/command containing \'TEST_CAC_N\'\n', 'apropos' );
	assert( run( 'find unalias' ).includes( '   unaliasall\n' ), 'find' );
	assertEqual( run( 'find zzz_nothing' ), 'no cvars/commands contain \'zzz_nothing\'\n', 'none' );
	assert( run( 'apropos' ).startsWith( 'apropos <substring>' ), 'usage' );

} );

Deno.test( 'alias with one argument prints it; unalias and unaliasall remove aliases', () => {

	try {

		run( 'alias cac_a echo hi' );
		run( 'alias cac_b echo bye' );
		assertEqual( run( 'alias cac_a' ), '   cac_a: echo hi \n', 'print' );
		assertEqual( run( 'alias cac_missing' ), '', 'missing prints nothing' );

		run( 'unalias cac_a' );
		assertEqual( run( 'alias cac_a' ), '', 'removed' );
		assertEqual( run( 'alias cac_b' ), '   cac_b: echo bye \n', 'other kept' );
		assertEqual( run( 'unalias cac_a' ), 'No alias named cac_a\n', 'already gone' );
		assertEqual( run( 'unalias' ), 'unalias <name> : delete alias\n', 'usage' );

		run( 'unaliasall' );
		assertEqual( cmd.cmd_alias, null, 'all removed' );

	} finally {

		run( 'unaliasall' );

	}

} );
