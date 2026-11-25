// The 2021 re-release's `vibrate` command (docs/rerelease-gaps.md 6i). It is
// a no-op: run from the command buffer with its argument, it prints nothing.

const common = await import( '../src/common.js' );
const cmd = await import( '../src/cmd.js' );
const consolejs = await import( '../src/console.js' );
const zone = await import( '../src/zone.js' );
const host_cmd = await import( '../src/host_cmd.js' );

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
zone.Memory_Init();
host_cmd.Host_InitCommands();

function exec( text ) {

	printed.length = 0;
	cmd.Cbuf_AddText( text );
	cmd.Cbuf_Execute();
	return printed.join( '' );

}

Deno.test( '6i: vibrate is a registered command', () => {

	assertEqual( cmd.Cmd_Exists( 'vibrate' ), true, 'Cmd_Exists' );

} );

Deno.test( '6i: vibrate with or without arguments prints nothing', () => {

	// Control: the capture sees an unregistered command's error
	assertEqual( exec( 'vibrate_not_a_command\n' ), 'Unknown command "vibrate_not_a_command"\n', 'control' );

	// The form the re-release QuakeC uses (commented out in weapons.qc)
	assertEqual( exec( 'vibrate tactile/weapons/guncock.bnvib\n' ), '', 'with a .bnvib path' );
	assertEqual( exec( 'vibrate\n' ), '', 'without arguments' );
	assertEqual( exec( 'vibrate 0.5 0.5 200\n' ), '', 'with numeric arguments' );

} );
