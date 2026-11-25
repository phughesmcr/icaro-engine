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
