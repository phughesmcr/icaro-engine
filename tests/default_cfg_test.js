// exec default.cfg falls back to the embedded QuakeSpasm default.cfg, as in
// Ironwail, when no pak has one (the 2021 re-release's id1). A default.cfg
// in a pak (shareware or registered id1) still runs as before.

// Bootstrap the client graph in its established safe import order.
await import( '../src/gl_rsurf.js' );

const common = await import( '../src/common.js' );
const cmd = await import( '../src/cmd.js' );
const cvar = await import( '../src/cvar.js' );
const consolejs = await import( '../src/console.js' );
const keys = await import( '../src/keys.js' );
const { CL_InitInput } = await import( '../src/cl_input.js' );
const { COM_AddPack } = await import( '../src/pak.js' );

function assertEqual( actual, expected, message ) {

	if ( actual !== expected )
		throw new Error( `${message}: expected ${JSON.stringify( expected )}, got ${JSON.stringify( actual )}` );

}

const printed = [];
common.Con_SetPrintFunctions(
	( fmt, ...args ) => printed.push( args.length === 0 ? String( fmt ) : consolejs._sprintf( fmt, ...args ) ),
	() => {}
);

cmd.Cbuf_Init();
cmd.Cmd_Init();
keys.Key_Init();
CL_InitInput();

// The cvars the config sets, registered by modules this test doesn't load
for ( const [ name, value ] of [ [ 'gamma', '1' ], [ 'volume', '0.7' ], [ 'sensitivity', '3' ], [ 'viewsize', '100' ] ] ) {

	if ( cvar.Cvar_FindVar( name ) === null )
		cvar.Cvar_RegisterVariable( new cvar.cvar_t( name, value ) );

}

function exec( text ) {

	printed.length = 0;
	cmd.Cbuf_AddText( text );
	cmd.Cbuf_Execute();
	return printed.join( '' );

}

Deno.test( 'exec default.cfg with no default.cfg runs the embedded one without errors', () => {

	const out = exec( 'exec default.cfg\n' );

	assertEqual( out, 'execing default.cfg\n', 'console output' );
	assertEqual( cvar.Cvar_VariableString( 'gamma' ), '0.95', 'gamma' );
	assertEqual( cvar.Cvar_VariableString( 'viewsize' ), '110', 'viewsize' );
	assertEqual( keys.keybindings[ keys.Key_StringToKeynum( '1' ) ], 'impulse 1', 'weapon key' );
	assertEqual( keys.keybindings[ keys.Key_StringToKeynum( 'F6' ) ], 'echo Quicksaving...; wait; save quick', 'quicksave key' );
	assertEqual( keys.keybindings[ keys.Key_StringToKeynum( '\\' ) ], '+mlook', 'backslash key' );

} );

Deno.test( 'exec default.cfg runs a pak\'s default.cfg, and other names don\'t fall back', () => {

	try {

		assertEqual( exec( 'exec zz_missing.cfg\n' ), 'couldn\'t exec zz_missing.cfg\n', 'other names' );

		const text = new TextEncoder().encode( 'gamma 0.5\n' );
		COM_AddPack( { filename: 'zz.pak', files: [ { name: 'default.cfg', filepos: 0, filelen: text.length } ], data: text.buffer } );
		cvar.Cvar_Set( 'viewsize', '100' );

		exec( 'exec default.cfg\n' );

		assertEqual( cvar.Cvar_VariableString( 'gamma' ), '0.5', 'gamma from the pak' );
		assertEqual( cvar.Cvar_VariableString( 'viewsize' ), '100', 'embedded config not run' );

	} finally {

		cvar.Cvar_Set( 'gamma', '1' );
		cvar.Cvar_Set( 'viewsize', '100' );

	}

} );
