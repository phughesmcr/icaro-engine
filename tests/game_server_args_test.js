// game_server.js command line: -rogue / -hipnotic parsing and the game
// directories they add (common.c COM_InitFilesystem).

const { createConfig, parseArgs, gameDirectories } = await import( '../server/game_server.js' );
const common = await import( '../src/common.js' );

function assertEqual( actual, expected, message ) {

	if ( actual !== expected )
		throw new Error( `${message}: expected ${JSON.stringify( expected )}, got ${JSON.stringify( actual )}` );

}

Deno.test( 'parseArgs collects -rogue and -hipnotic alongside other flags', () => {

	const config = parseArgs( [ '-port', '4500', '-rogue', '-pak', 'data/pak0.pak', '-hipnotic', '-map', 'start' ], createConfig() );
	assertEqual( config.gameFlags.join(), '-rogue,-hipnotic', 'game flags in order' );
	assertEqual( config.port, 4500, '-port still parsed' );
	assertEqual( config.pakPath, 'data/pak0.pak', '-pak still parsed' );
	assertEqual( config.defaultMap, 'start', '-map still parsed' );

	assertEqual( parseArgs( [ '-port', '4500' ], createConfig() ).gameFlags.length, 0, 'no game flags by default' );
	assertEqual( parseArgs( [ '-game', 'rogue', '-ROGUE' ], createConfig() ).gameFlags.length, 0, 'only the exact flags count' );

} );

Deno.test( 'parsed game flags reach COM_InitArgv as in Host_Init_Server', () => {

	try {

		const config = parseArgs( [ '-hipnotic', '-port', '4500' ], createConfig() );
		common.COM_InitArgv( [ 'game_server', ...config.gameFlags ] );
		assertEqual( [ common.rogue, common.hipnotic, common.standard_quake ].join(), 'false,true,false', 'hipnotic set' );

	} finally {

		common.COM_InitArgv( [] );

	}

} );

Deno.test( 'gameDirectories resolves rogue then hipnotic next to the -pak file', () => {

	assertEqual( gameDirectories( '../static/pak0.pak', true, false ).join(), '../static/rogue', 'rogue' );
	assertEqual( gameDirectories( '/srv/quake/id1/pak0.pak', false, true ).join(), '/srv/quake/hipnotic', 'hipnotic beside id1, as in common.c' );
	assertEqual( gameDirectories( 'data/pak0.pak', true, true ).join(), 'data/rogue,data/hipnotic', 'rogue before hipnotic, as in common.c' );
	assertEqual( gameDirectories( 'pak0.pak', true, false ).join(), './rogue', 'bare file name uses the current directory' );
	assertEqual( gameDirectories( 'C:\\quake\\id1\\pak0.pak', true, false ).join(), 'C:\\quake/rogue', 'Windows separators' );
	assertEqual( gameDirectories( 'data/pak0.pak', false, false ).length, 0, 'standard Quake adds nothing' );

} );

Deno.test( '-game adds one game directory after the mission packs; the rerelease layout resolves beside id1', () => {

	assertEqual( parseArgs( [ '-game', 'mg1' ], createConfig() ).gameDir, 'mg1', '-game parsed' );
	assertEqual( parseArgs( [ '-game', '../etc' ], createConfig() ).gameDir, null, 'a path is refused' );
	assertEqual( gameDirectories( '../static/rerelease/id1/pak0.pak', false, true, 'mg1' ).join(), '../static/rerelease/hipnotic,../static/rerelease/mg1', 'rerelease dirs' );
	assertEqual( gameDirectories( 'static/ID1/PAK0.PAK', false, false, 'dopa' ).join(), 'static/dopa', 'id1 matched in any case' );
	assertEqual( gameDirectories( '../static/pak0.pak', false, false, 'mg1' ).join(), '../static/mg1', 'static/pak0.pak layout' );

} );

Deno.test( 'parseArgs reads the WebSocket listener flags', () => {

	const defaults = createConfig();
	assertEqual( defaults.wsPort, null, 'no WebSocket listener by default' );
	assertEqual( defaults.wsHost, '127.0.0.1', 'loopback by default' );
	assertEqual( defaults.wsTls, false, 'plain ws by default' );

	const config = parseArgs( [ '-port', '4500', '-wsport', '4501', '-wshost', '0.0.0.0', '-wstls' ], createConfig() );
	assertEqual( config.wsPort, 4501, '-wsport' );
	assertEqual( config.wsHost, '0.0.0.0', '-wshost' );
	assertEqual( config.wsTls, true, '-wstls' );
	assertEqual( config.port, 4500, '-port still parsed' );

	assertEqual( parseArgs( [ '-wsport', '0' ], createConfig() ).wsPort, null, 'port 0 refused' );
	assertEqual( parseArgs( [ '-wsport', '70000' ], createConfig() ).wsPort, null, 'out of range refused' );
	assertEqual( parseArgs( [ '-wsport', 'abc' ], createConfig() ).wsPort, null, 'not a number refused' );

} );

Deno.test( 'room options are parsed as clamped integers and applied as cvars before the map spawns (MENU-4)', async () => {

	const { applyGameOptions } = await import( '../server/game_server.js' );
	const host = await import( '../src/host.js' );
	const cvar = await import( '../src/cvar.js' );
	const names = [ 'coop', 'teamplay', 'skill', 'fraglimit', 'timelimit' ];

	const none = parseArgs( [ '-port', '4500' ], createConfig() );
	assertEqual( JSON.stringify( none.gameOptions ), '{}', 'no options by default' );

	const config = parseArgs( [ '-coop', '1', '-teamplay', '9', '-skill', '2', '-fraglimit', '40', '-timelimit', '1e9', '-map', 'e1m1' ], createConfig() );
	assertEqual( JSON.stringify( config.gameOptions ), JSON.stringify( { coop: 1, teamplay: 2, skill: 2, fraglimit: 40 } ), 'clamped; non-integer dropped' );
	assertEqual( config.defaultMap, 'e1m1', 'other args still parsed' );
	assertEqual( JSON.stringify( parseArgs( [ '-skill', '-3', '-fraglimit', ';quit', '-coop' ], createConfig() ).gameOptions ), '{}', 'hostile values ignored' );
	assertEqual( parseArgs( [ '-rogue', '-teamplay', '9' ], createConfig() ).gameOptions.teamplay, 6, 'rogue teamplay modes' );

	const savedDeathmatch = [ host.deathmatch.value, host.deathmatch.string ];
	const saved = names.map( ( n ) => [ n, cvar.Cvar_FindVar( n ) === null ? null : cvar.Cvar_VariableString( n ) ] );
	try {

		applyGameOptions( {} );
		assertEqual( host.deathmatch.value, savedDeathmatch[ 0 ], 'no options: deathmatch untouched' );

		applyGameOptions( config.gameOptions );
		assertEqual( host.coop.value, 1, 'coop' );
		assertEqual( host.teamplay.value, 2, 'teamplay' );
		assertEqual( host.skill.value, 2, 'skill' );
		assertEqual( host.fraglimit.value, 40, 'fraglimit' );
		assertEqual( host.timelimit.value, 0, 'timelimit untouched' );
		assertEqual( host.deathmatch.value, 0, 'coop clears deathmatch' );

	} finally {

		for ( const [ n, v ] of saved ) if ( v !== null ) cvar.Cvar_Set( n, v );
		host.deathmatch.value = savedDeathmatch[ 0 ];
		host.deathmatch.string = savedDeathmatch[ 1 ];

	}

} );
