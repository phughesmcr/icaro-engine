// Icaro Engine entry point
// Equivalent to WinQuake/sys_win.c WinMain() + main()

import { Sys_Init, Sys_Printf, Sys_Error } from './src/sys.js';
import { COM_InitArgv, rogue, hipnotic } from './src/common.js';
import { Host_Init, Host_Frame, Host_Shutdown } from './src/host.js';
import { COM_AddPakSequence, COM_AddGameDirectory } from './src/pak.js';
import { Cbuf_AddText } from './src/cmd.js';
import { cls, cl } from './src/client.js';
import { sv } from './src/server.js';
import { scene, camera } from './src/gl_rmain.js';
import { renderer } from './src/vid.js';
import { Draw_CachePicFromPNG } from './src/gl_draw.js';
import { XR_Init } from './src/webxr.js';

const parms = {
	basedir: '.',
	argc: 0,
	argv: []
};

// ?game=rogue or ?game=hipnotic stands in for WinQuake's -rogue and
// -hipnotic: the flag is passed to COM_InitArgv, and static/<game>/pak*.pak
// load after id1's. Other values are ignored, so the parameter never
// reaches a fetch path.
const MISSION_PACKS = [ 'rogue', 'hipnotic' ];

async function main() {

	try {

		Sys_Init();

		const urlParams = new URLSearchParams( window.location.search );
		const game = urlParams.get( 'game' );
		if ( MISSION_PACKS.includes( game ) ) {

			parms.argv = [ 'quake', '-' + game ];
			parms.argc = parms.argv.length;

		} else if ( game !== null ) {

			Sys_Printf( 'Ignoring unknown game "%s" (expected rogue or hipnotic)\n', game );

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

		// Load static/pak0.pak, then pak1.pak (registered) and so on if present
		Sys_Printf( 'Loading pak files...\\n' );
		const pakCount = await COM_AddPakSequence( 'static/pak0.pak', setProgress );
		if ( pakCount > 0 ) {

			Sys_Printf( pakCount + ' pak file(s) loaded\\n' );

		} else {

			Sys_Printf( 'Warning: pak0.pak not found - game data will be missing\\n' );

		}

		// common.c COM_InitFilesystem: the mission pack's directory after id1,
		// so its progs.dat, gfx.wad and maps are found first
		for ( const dir of [ rogue ? 'rogue' : null, hipnotic ? 'hipnotic' : null ] ) {

			if ( dir === null ) continue;
			if ( await COM_AddGameDirectory( 'static/' + dir, setProgress ) === 0 )
				Sys_Error( 'static/' + dir + '/pak0.pak not found. -' + dir + ' needs the mission pack\'s pak0.pak there.' );

		}

		await Host_Init( parms );

		// Remove loading overlay
		if ( loadingOverlay ) {

			loadingOverlay.remove();

		}

		// Preload custom menu images
		try {

			await Draw_CachePicFromPNG( 'gfx/mainmenu_ext.lmp', 'static/mainmenu.png' );
			Sys_Printf( 'Loaded custom menu images\\n' );

		} catch ( e ) {

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
