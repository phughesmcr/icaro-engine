// QuakeSpasm/Ironwail fixes to cmd.c, common.c, host.c, host_cmd.c and
// cl_demo.c: the command buffer, COM_Parse, SZ_GetSpace, savegames, chat,
// map, reconnect and demo message sizes.

await import( '../src/gl_rsurf.js' );
const common = await import( '../src/common.js' );
const pak = await import( '../src/pak.js' );
const cmd = await import( '../src/cmd.js' );
const zone = await import( '../src/zone.js' );
const host = await import( '../src/host.js' );
const host_cmd = await import( '../src/host_cmd.js' );
const pr_edict = await import( '../src/pr_edict.js' );
const progs = await import( '../src/progs.js' );
const sv_main = await import( '../src/sv_main.js' );
const sv_phys = await import( '../src/sv_phys.js' );
const gl_model = await import( '../src/gl_model.js' );
const server = await import( '../src/server.js' );
const client = await import( '../src/client.js' );
const demo = await import( '../src/cl_demo.js' );
const { svc_setangle } = await import( '../src/protocol.js' );
const consolejs = await import( '../src/console.js' );

function assertEqual( actual, expected, message ) {

	if ( actual !== expected )
		throw new Error( `${message}: expected ${JSON.stringify( expected )}, got ${JSON.stringify( actual )}` );

}

function assertThrows( fn, prefix, message ) {

	try {

		fn();

	} catch ( e ) {

		if ( String( e.message ).startsWith( prefix ) !== true )
			throw new Error( `${message}: expected an error starting ${JSON.stringify( prefix )}, got ${JSON.stringify( e.message )}` );
		return;

	}

	throw new Error( `${message}: nothing thrown` );

}

const printed = [];
common.Con_SetPrintFunctions(
	( fmt, ...args ) => printed.push( args.length === 0 ? String( fmt ) : consolejs._sprintf( fmt, ...args ) ),
	() => {}
);

function output( fn ) {

	printed.length = 0;
	fn();
	return printed.join( '' );

}

zone.Memory_Init();
cmd.Cbuf_Init();
cmd.Cmd_Init();
host_cmd.Host_InitCommands();

// a command that records its arguments
const ran = [];
cmd.Cmd_AddCommand( 'zz_record', () => ran.push( cmd.Cmd_Args() === null ? '' : cmd.Cmd_Args() ) );

function execute( text ) {

	ran.length = 0;
	cmd.Cbuf_AddText( text );
	cmd.Cbuf_Execute();
	return ran.slice();

}

Deno.test( 'Cbuf_InsertText adds a newline, so a file without one ends its last command (QuakeSpasm)', () => {

	ran.length = 0;
	cmd.Cbuf_AddText( 'zz_record b\n' );
	cmd.Cbuf_InsertText( 'zz_record a' );
	cmd.Cbuf_Execute();
	assertEqual( ran.join( '|' ), 'a|b', 'two commands' );

} );

Deno.test( 'Cbuf_Execute: a ; after a // comment does not split (Ironwail)', () => {

	assertEqual( execute( 'zz_record a // note; zz_record b\n' ).join( '|' ), 'a // note; zz_record b', 'commented ;' );
	assertEqual( execute( 'zz_record a; zz_record b\n' ).join( '|' ), 'a|b', 'plain ;' );
	assertEqual( execute( 'zz_record "x//y"; zz_record b\n' ).join( '|' ), '"x//y"|b', '// inside quotes' );
	assertEqual( execute( 'zz_record wts://h:1/x;zz_record b\n' ).join( '|' ), 'wts://h:1/x|b', '// inside a word' );

} );

Deno.test( 'the command buffer holds 1<<18 bytes (QuakeSpasm/Ironwail)', () => {

	const long = 'zz_record ' + 'a'.repeat( 100000 ) + '\n';
	const out = output( () => execute( long ) );
	assertEqual( out.includes( 'overflow' ), false, 'no overflow' );
	assertEqual( ran.length, 1, 'ran' );
	assertEqual( ran[ 0 ].length, 100000, 'whole argument' );

} );

Deno.test( 'COM_Parse: a colon splits only at the start of a token, and /* */ is a comment (QuakeSpasm)', () => {

	const tokens = [];
	let data = 'connect wts://host:4433/x : a:b /* skip\nthis */ c // rest\n"d e"';
	while ( true ) {

		data = common.COM_Parse( data );
		if ( data === null ) break;
		tokens.push( common.com_token );

	}

	assertEqual( tokens.join( '|' ), 'connect|wts://host:4433/x|:|a:b|c|d e', 'tokens' );

	cmd.Cmd_TokenizeString( 'connect wts://host:4433/room' );
	assertEqual( cmd.Cmd_Argc(), 2, 'argc' );
	assertEqual( cmd.Cmd_Argv( 1 ), 'wts://host:4433/room', 'unquoted URL is one argument' );

} );

Deno.test( 'Q_atof and Q_atoi skip leading whitespace (QuakeSpasm/Ironwail)', () => {

	assertEqual( common.Q_atof( ' \t1.5' ), 1.5, 'Q_atof' );
	assertEqual( common.Q_atof( '  -2' ), - 2, 'Q_atof sign' );
	assertEqual( common.Q_atoi( ' 0x10' ), 16, 'Q_atoi' );

} );

Deno.test( 'SZ_GetSpace overflow without allowoverflow is a Host_Error and Host_Error clears cl.intermission (Ironwail)', () => {

	const buf = new common.sizebuf_t();
	common.SZ_Alloc( buf, 256 );
	buf.cursize = 255;
	client.cl.intermission = 1;
	output( () => assertThrows( () => common.SZ_GetSpace( buf, 2 ), 'Host_Error: SZ_GetSpace: overflow', 'Host_Error' ) );
	assertEqual( client.cl.intermission, 0, 'cl.intermission' );

	// with allowoverflow the message ends in a newline
	buf.allowoverflow = true;
	buf.cursize = 255;
	assertEqual( output( () => common.SZ_GetSpace( buf, 2 ) ), 'SZ_GetSpace: overflow\n', 'message' );
	assertEqual( buf.overflowed, true, 'overflowed' );

} );

Deno.test( 'Host_ChatLine keeps MAXCMDLINE and strips the quote only when there is one (Ironwail)', () => {

	assertEqual( host_cmd.Host_ChatLine( 'me: "hello"', true ), 'me: "hello\n', 'closing quote of a quoted message' );
	assertEqual( host_cmd.Host_ChatLine( 'me: hello', true ), 'me: hello\n', 'no closing quote: last character kept' );
	assertEqual( host_cmd.Host_ChatLine( 'me: a"', false ), 'me: a"\n', 'unquoted message keeps its quote' );
	assertEqual( host_cmd.Host_ChatLine( 'me: hi\r\n', false ), 'me: hi\n', 'CR and LF' );
	const long = 'me: ' + 'x'.repeat( 100 );
	assertEqual( host_cmd.Host_ChatLine( long, false ), long + '\n', 'no 64-byte cut' );
	const tooLong = host_cmd.Host_ChatLine( 'x'.repeat( 400 ), false );
	assertEqual( tooLong.length, 255, 'MAXCMDLINE - 1' );
	assertEqual( tooLong.endsWith( '\n' ), true, 'newline' );

} );

Deno.test( 'Host_SkipGlobals walks key/value pairs to the closing brace', () => {

	const rest = host_cmd.Host_SkipGlobals( '"a" "}"\n"b" "x } y"\n}\n{ "c" "d" }' );
	assertEqual( rest.trim(), '{ "c" "d" }', 'rest' );

} );

Deno.test( 'reconnect does nothing during demo playback (Baker, QuakeSpasm/Ironwail)', () => {

	const old = { demoplayback: client.cls.demoplayback, signon: client.cls.signon };
	try {

		client.cls.demoplayback = true;
		client.cls.signon = 2;
		cmd.Cmd_ExecuteString( 'reconnect', cmd.src_command );
		assertEqual( client.cls.signon, 2, 'signon kept' );

	} finally {

		client.cls.demoplayback = old.demoplayback;
		client.cls.signon = old.signon;

	}

} );

Deno.test( 'map with no argument prints usage instead of starting a server (Ironwail)', () => {

	const oldState = client.cls.state;
	try {

		client.cls.state = client.ca_disconnected;
		assertEqual( output( () => cmd.Cmd_ExecuteString( 'map', cmd.src_command ) ), 'map <levelname>: start a new server\n', 'usage' );

	} finally {

		client.cls.state = oldState;

	}

} );

Deno.test( 'a demo message with a negative or oversized length is a Host_Error, not a Sys_Error', () => {

	const oldMessage = common.net_message;
	const message = new common.sizebuf_t();
	message.data = new Uint8Array( 16 );
	message.maxsize = 16;
	common.COM_SetNetMessage( message );
	try {

		for ( const size of [ - 1, 0x7fffffff ] ) {

			const data = new Uint8Array( 32 );
			new DataView( data.buffer ).setInt32( 0, size, true );
			client.cls.demoplayback = true;
			client.cls.demodata = data;
			client.cls.demopos = 0;
			client.cls.signon = 0;
			client.cls.state = client.ca_connected;
			output( () => assertThrows( () => demo.CL_GetMessage(), 'Host_Error: Demo message', 'size ' + size ) );
			assertEqual( client.cls.demoplayback, false, 'playback stopped' );

		}

	} finally {

		common.COM_SetNetMessage( oldMessage );
		client.cls.demoplayback = false;
		client.cls.demodata = null;
		client.cls.state = client.ca_disconnected;

	}


} );

Deno.test( 'savegame: map strips .bsp, the comment has no newlines, a } in a string loads, and spawn sends v_angle', () => {

	const oldStorage = Object.getOwnPropertyDescriptor( globalThis, 'localStorage' );
	const oldState = client.cls.state;
	const store = new Map();
	Object.defineProperty( globalThis, 'localStorage', {
		configurable: true,
		value: {
			getItem( key ) { return store.has( key ) ? store.get( key ) : null; },
			setItem( key, value ) { store.set( key, String( value ) ); }
		}
	} );

	try {

		pak.COM_AddPack( pak.COM_LoadPackFile( 'pak0.pak', Deno.readFileSync( 'static/pak0.pak' ).buffer ) );
		client.cls.state = client.ca_dedicated; // no local client connects
		server.svs.maxclients = 1;
		server.svs.maxclientslimit = 1;
		server.svs.clients = [ new server.client_t() ];
		output( () => {

			pr_edict.PR_Init();
			gl_model.Mod_Init();
			sv_main.SV_Init();
			cmd.Cmd_ExecuteString( 'map start.bsp', cmd.src_command );

		} );
		assertEqual( server.sv.active, true, 'map start.bsp ran' );
		assertEqual( server.sv.name, 'start', 'sv.name' );

		// a level name with a newline, and a } inside an edict's string
		client.cl.levelname = 'two\nlines';
		const player = progs.EDICT_NUM( 1 );
		player.v.netname = pr_edict.ED_NewString( 'a } b' );
		player.v.v_angle[ 0 ] = 30;
		player.v.v_angle[ 1 ] = 90;
		player.v.angles[ 0 ] = - 10;
		player.v.angles[ 1 ] = 90;
		const before = server.sv.num_edicts;

		output( () => cmd.Cmd_ExecuteString( 'save t1', cmd.src_command ) );
		const lines = store.get( 'quake_save_t1' ).split( '\n' );
		assertEqual( lines[ 1 ].startsWith( 'two_lines' ), true, 'comment: ' + lines[ 1 ] );
		assertEqual( lines[ 2 ].length > 0, true, 'spawn parms on the next line' );

		client.cl.levelname = '';
		output( () => cmd.Cmd_ExecuteString( 'save t2', cmd.src_command ) );
		assertEqual( store.get( 'quake_save_t2' ).split( '\n' )[ 1 ].startsWith( 'start_' ), true, 'map name fallback' );

		output( () => cmd.Cmd_ExecuteString( 'load t1', cmd.src_command ) );
		assertEqual( server.sv.loadgame, true, 'loaded' );
		assertEqual( server.sv.num_edicts, before, 'every edict loaded' );
		assertEqual( progs.PR_GetString( progs.EDICT_NUM( 1 ).v.netname ), 'a } b', 'netname' );

		// a broken file is a Host_Error, not a Sys_Error
		store.set( 'quake_save_bad', store.get( 'quake_save_t1' ).replace( /\n\{\n/, '\nx\n' ) );
		output( () => assertThrows( () => cmd.Cmd_ExecuteString( 'load bad', cmd.src_command ), 'Host_Error: First token isn\'t a brace', 'bad file' ) );

		// spawn after a load sends the view angles, not the model's
		output( () => cmd.Cmd_ExecuteString( 'load t1', cmd.src_command ) );
		const c = server.svs.clients[ 0 ];
		c.message.data = c.msgbuf;
		c.message.maxsize = c.msgbuf.length;
		c.message.allowoverflow = true;
		c.edict = progs.EDICT_NUM( 1 );
		c.netconnection = { connecttime: 0 };
		server.set_host_client( c );
		sv_phys.SV_SetPlayer( c.edict );
		cmd.Cmd_ExecuteString( 'spawn', cmd.src_client );
		const bytes = Array.from( c.message.data.subarray( 0, c.message.cursize ) ).join( ',' );
		const want = [ svc_setangle, 21, 64, 0 ].join( ',' ); // 30 and 90 degrees
		assertEqual( bytes.includes( want ), true, 'svc_setangle from v_angle' );

	} finally {

		server.set_host_client( null );
		host.Host_ShutdownServer( false );
		client.cls.state = oldState;
		if ( oldStorage === undefined )
			delete globalThis.localStorage;
		else
			Object.defineProperty( globalThis, 'localStorage', oldStorage );

	}

} );
