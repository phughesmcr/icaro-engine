// Ironwail's (johnfitz's) cheat command changes in host_cmd.c: "god" and
// "notarget" take an optional 0 or 1, "give a <n>" sets armour, and give
// updates currentammo so the status bar shows the new count.

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
const q = await import( '../src/quakedef.js' );
const consolejs = await import( '../src/console.js' );

function assertEqual( actual, expected, message ) {

	if ( actual !== expected )
		throw new Error( `${message}: expected ${JSON.stringify( expected )}, got ${JSON.stringify( actual )}` );

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

Deno.test( 'god, notarget and give follow Ironwail on shareware start', () => {

	const oldState = client.cls.state;
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
			cmd.Cmd_ExecuteString( 'map start', cmd.src_command );

		} );
		assertEqual( server.sv.active, true, 'map start ran' );

		const c = server.svs.clients[ 0 ];
		c.message.data = c.msgbuf;
		c.message.maxsize = c.msgbuf.length;
		c.message.allowoverflow = true;
		c.edict = progs.EDICT_NUM( 1 );
		server.set_host_client( c );
		sv_phys.SV_SetPlayer( c.edict );
		const v = c.edict.v;
		const run = ( text ) => output( () => cmd.Cmd_ExecuteString( text, cmd.src_client ) );
		const has = ( flag ) => ( ( v.flags | 0 ) & flag ) !== 0;

		v.flags = 0;
		run( 'god' );
		assertEqual( has( sv_phys.FL_GODMODE ), true, 'god toggles on' );
		run( 'god' );
		assertEqual( has( sv_phys.FL_GODMODE ), false, 'god toggles off' );
		run( 'god 1' );
		run( 'god 1' );
		assertEqual( has( sv_phys.FL_GODMODE ), true, 'god 1 stays on' );
		run( 'god 0' );
		assertEqual( has( sv_phys.FL_GODMODE ), false, 'god 0' );
		assertEqual( run( 'god 1 2' ), 'god [value] : toggle god mode. values: 0 = off, 1 = on\n', 'god usage' );

		run( 'notarget 1' );
		run( 'notarget 1' );
		assertEqual( has( sv_phys.FL_NOTARGET ), true, 'notarget 1' );
		run( 'notarget' );
		assertEqual( has( sv_phys.FL_NOTARGET ), false, 'notarget toggles' );
		run( 'notarget 0' );
		assertEqual( has( sv_phys.FL_NOTARGET ), false, 'notarget 0 stays off' );

		// give a: armour type follows the amount, replacing the old armour bit
		const armor = q.IT_ARMOR1 | q.IT_ARMOR2 | q.IT_ARMOR3;
		v.items = q.IT_SHOTGUN | q.IT_ARMOR3;
		run( 'give a 50' );
		assertEqual( v.armorvalue, 50, 'armour 50' );
		assertEqual( Math.fround( v.armortype ), Math.fround( 0.3 ), 'green' );
		assertEqual( v.items & armor, q.IT_ARMOR1, 'green bit only' );
		assertEqual( v.items & q.IT_SHOTGUN, q.IT_SHOTGUN, 'weapons kept' );
		run( 'give a 150' );
		assertEqual( v.items & armor, q.IT_ARMOR2, 'yellow' );
		assertEqual( Math.fround( v.armortype ), Math.fround( 0.6 ), 'yellow type' );
		run( 'give a 200' );
		assertEqual( v.items & armor, q.IT_ARMOR3, 'red' );
		assertEqual( Math.fround( v.armortype ), Math.fround( 0.8 ), 'red type' );
		run( 'give a -1' );
		assertEqual( v.armorvalue, 200, 'negative is ignored' );

		// give updates currentammo for the weapon in hand
		v.weapon = q.IT_SHOTGUN;
		run( 'give s 42' );
		assertEqual( v.currentammo, 42, 'shells' );
		v.weapon = q.IT_ROCKET_LAUNCHER;
		run( 'give r 7' );
		assertEqual( v.currentammo, 7, 'rockets' );
		v.weapon = q.IT_LIGHTNING;
		run( 'give c 9' );
		assertEqual( v.currentammo, 9, 'cells' );
		run( 'give n 11' );
		assertEqual( v.currentammo, 9, 'other ammo leaves currentammo' );

	} finally {

		server.set_host_client( null );
		host.Host_ShutdownServer( false );
		client.cls.state = oldState;

	}

} );
