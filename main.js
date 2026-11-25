// Icaro Engine entry point
// Equivalent to WinQuake/sys_win.c WinMain() + main()

import { Sys_Init, Sys_Printf, Sys_Error } from './src/sys.js';
import { COM_InitArgv, rogue, hipnotic } from './src/common.js';
import { Host_Init, Host_Frame } from './src/host.js';
import { COM_AddPakSequence, COM_AddGameDirectory, COM_SetLooseFileBasePaths } from './src/pak.js';
import { Cbuf_AddText } from './src/cmd.js';
import { cls, cl } from './src/client.js';
import { sv } from './src/server.js';
import { scene, camera } from './src/gl_rmain.js';
import { renderer } from './src/vid.js';
import { Draw_CachePicFromPNG } from './src/gl_draw.js';
import { XR_Init } from './src/webxr.js';
import { CDAudio_SetTrackURLProvider, CDAudio_TrackURLs } from './src/cd_audio.js';

const parms = {
	basedir: '.',
	argc: 0,
	argv: []
};

// ?game=rogue or ?game=hipnotic stands in for WinQuake's -rogue and
// -hipnotic: the flag is passed to COM_InitArgv, and static/<game>/pak*.pak
// load after id1's. ?game=mg1 (and the other names in GAME_DIRS) stands in
// for -game mg1: only the directory's paks load. Other values are ignored,
// so the parameter never reaches a fetch path.
const MISSION_PACKS = [ 'rogue', 'hipnotic' ];
const GAME_DIRS = [ 'mg1', 'mg3', 'dopa', 'ctf' ]; // the 2021 rerelease's add-ons

// ?base=rerelease stands in for -basedir: the 2021 rerelease's directories,
// static/rerelease/id1 and static/rerelease/<game>. Without it, id1's paks
// are static/pak*.pak and game directories are static/<game>.
const BASE_DIRS = { rerelease: 'static/rerelease' };

// ?particles=<n> stands in for -particles <n> (r_part.c R_InitParticles
// sizes the particle pool from it). Only whole numbers are passed on. C has
// no maximum, but a URL can come from a shared link, so values above
// PARTICLES_URL_MAX (16 times Ironwail's default) are ignored rather than
// allocated.
const PARTICLES_ARG = /^[0-9]+$/;
const PARTICLES_URL_MAX = 262144;

async function main() {

	try {

		Sys_Init();

		const urlParams = new URLSearchParams( window.location.search );
		const game = urlParams.get( 'game' );
		let gamedir = null; // -game <dir>
		if ( MISSION_PACKS.includes( game ) ) {

			parms.argv = [ 'quake', '-' + game ];
			parms.argc = parms.argv.length;

		} else if ( GAME_DIRS.includes( game ) ) {

			gamedir = game;
			parms.argv = [ 'quake', '-game', game ];
			parms.argc = parms.argv.length;

		} else if ( game !== null ) {

			Sys_Printf( 'Ignoring unknown game "%s" (expected %s)\n', game, [ ...MISSION_PACKS, ...GAME_DIRS ].join( ', ' ) );

		}

		const base = urlParams.get( 'base' );
		let basedir = 'static';
		let id1dir = 'static';
		if ( Object.hasOwn( BASE_DIRS, base ) ) {

			basedir = BASE_DIRS[ base ];
			id1dir = basedir + '/id1';

		} else if ( base !== null ) {

			Sys_Printf( 'Ignoring unknown base "%s" (expected %s)\n', base, Object.keys( BASE_DIRS ).join( ', ' ) );

		}

		const particles = urlParams.get( 'particles' );
		if ( particles !== null && PARTICLES_ARG.test( particles ) && Number( particles ) <= PARTICLES_URL_MAX ) {

			if ( parms.argv.length === 0 ) parms.argv = [ 'quake' ];
			parms.argv = [ ...parms.argv, '-particles', particles ];
			parms.argc = parms.argv.length;

		} else if ( particles !== null ) {

			Sys_Printf( 'Ignoring particles "%s" (expected a whole number up to %d)\n', particles, PARTICLES_URL_MAX );

		}

		COM_InitArgv( parms.argv );

		// Loading bar
		const loadingProgress = document.getElementById( 'loading-progress' );
		const loadingOverlay = document.getElementById( 'loading' );

		const setProgress = ( value ) => {

			if ( loadingProgress ) {

				loadingProgress.style.width = ( value * 100 ) + '%';

			}

		};

		// Load id1's pak0.pak, then pak1.pak (registered) and so on if present
		Sys_Printf( 'Loading pak files...\\n' );
		const pakCount = await COM_AddPakSequence( id1dir + '/pak0.pak', setProgress );
		if ( pakCount > 0 ) {

			Sys_Printf( pakCount + ' pak file(s) loaded\\n' );

		} else {

			Sys_Printf( 'Warning: pak0.pak not found - game data will be missing\\n' );

		}

		// common.c COM_InitFilesystem: the mission pack's or -game directory
		// after id1, so its progs.dat, gfx.wad and maps are found first
		const gameDirs = [];
		for ( const dir of [ rogue ? 'rogue' : null, hipnotic ? 'hipnotic' : null, gamedir ] ) {

			if ( dir === null ) continue;
			if ( await COM_AddGameDirectory( basedir + '/' + dir, setProgress ) === 0 )
				Sys_Error( basedir + '/' + dir + '/pak0.pak not found. -' + dir + ' needs the pack\'s pak0.pak there.' );
			gameDirs.push( basedir + '/' + dir );

		}

		// Loose files (custom maps) from the game directory, then id1's, then
		// static/ where this port has always kept them
		const looseDirs = [ ...gameDirs, id1dir ];
		if ( id1dir !== 'static' ) looseDirs.push( 'static' );
		COM_SetLooseFileBasePaths( looseDirs.map( ( dir ) => dir + '/' ) );

		// CD tracks play from music/trackNN.ogg or .mp3 (QuakeSpasm/Ironwail
		// BGM_PlayCDtrack), looked up in the game directory first, then in
		// id1's (static/, or static/rerelease/id1)
		const musicDirs = [ ...gameDirs, id1dir ];
		CDAudio_SetTrackURLProvider( ( track ) => CDAudio_TrackURLs( track, musicDirs ) );

		await Host_Init( parms );

		// Remove loading overlay
		if ( loadingOverlay ) {

			loadingOverlay.remove();

		}

		// Preload custom menu images
		try {

			await Draw_CachePicFromPNG( 'gfx/mainmenu_ext.lmp', 'static/mainmenu.png' );
			Sys_Printf( 'Loaded custom menu images\\n' );

		} catch {

			Sys_Printf( 'Warning: Could not load custom menu images\\n' );

		}

		// Check URL parameters for auto-join
		const roomId = urlParams.get( 'room' );

		if ( roomId ) {

			const serverUrl = urlParams.get( 'server' ) || 'https://localhost:4433';
			const connectUrl = serverUrl + '?room=' + encodeURIComponent( roomId );
			Sys_Printf( 'Auto-joining room: %s\\n', roomId );
			Cbuf_AddText( 'connect "' + connectUrl + '"\n' );

		}

		// Initialize WebXR (creates rig, offers VR session — must be after Host_Init)
		XR_Init( scene );

		// Expose for debugging
		window.Cbuf_AddText = Cbuf_AddText;
		window.cls = cls;
		window.cl = cl;
		window.sv = sv;
		window.scene = scene;
		Object.defineProperty( window, 'camera', { get: () => camera } );
		Object.defineProperty( window, 'renderer', { get: () => renderer } );

		let oldtime = performance.now() / 1000;

		// Use renderer.setAnimationLoop instead of requestAnimationFrame.
		// This is required for WebXR — Three.js automatically switches to
		// xrSession.requestAnimationFrame when a VR session is active.
		// In non-XR mode, behavior is identical to regular rAF.
		renderer.setAnimationLoop( function ( timestamp ) {

			const newtime = timestamp / 1000;
			const time = newtime - oldtime;
			oldtime = newtime;

			Host_Frame( time );

		} );

	} catch ( e ) {

		console.error( 'Icaro Engine Fatal Error:', e );
		Sys_Error( e.message );

	}

}

main();
