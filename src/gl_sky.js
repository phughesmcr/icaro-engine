// Ported from: Ironwail Quake/gl_sky.c -- skyboxes (Sky_LoadSkyBox,
// Sky_NewMap, Sky_SkyCommand_f, Sky_ClearAll)
//
// Not in WinQuake: id's GLQuake draws only the scrolling sky (gl_warp.c).
// The skyfog part of Sky_NewMap is Sky_ParseSkyfog in gl_fog.js, and the
// scrolling sky is drawn by R_DrawSkyChain in gl_rsurf.js, which also draws
// the box: Ironwail's cubemap path (R_DrawBrushModels_SkyCubemap) samples the
// box on the sky surfaces themselves.
//
// Deliberate deviations from Ironwail:
// - The faces are fetched on demand (pak.js defers .tga files), so the box
//   appears once they arrive; the scrolling sky shows until then.
// - Ironwail draws faces that aren't all square and the same size as six
//   separate box sides. The rerelease add-ons ship only square, same-size
//   faces, so such a set warns and keeps the scrolling sky.
// - Ironwail keeps every box loaded since the last map unload; this keeps
//   only the current one, and drops it on a map that doesn't use it.
// - r_fastsky, r_skyalpha and the skywind commands are not ported.

import * as THREE from 'three';
import { Con_Printf, COM_Parse, com_token } from './common.js';
import { Cmd_AddCommand, Cmd_Argc, Cmd_Argv } from './cmd.js';
import { COM_EnsureFile } from './pak.js';
import { Image_LoadImage } from './image.js';

const suf = [ 'rt', 'bk', 'lf', 'ft', 'up', 'dn' ];

// The GL cubemap faces (+X, -X, +Y, -Y, +Z, -Z) as indices into suf:
// ft/bk/up/dn/rt/lf. R_DrawSkyChain's shader looks the box up with
// ( -dir.y, dir.z, dir.x ) for the Quake-space direction dir, as Ironwail's.
export const cubemap_order = [ 3, 1, 4, 5, 0, 2 ];

// The loaded box, { name, cubemap }, or null for the scrolling sky
let skybox = null;
// The box asked for, loaded or still being fetched ('' for none)
let skybox_name = '';
// Bumped by every change of skybox_name, so a fetch that completes after the
// map or the sky changed is dropped
let skybox_serial = 0;
// The last loaded box, reused when a map asks for it again
let skybox_cache = null;

/*
==================
Sky_SkyBoxFilename
==================
*/
export function Sky_SkyBoxFilename( name, i ) {

	return 'gfx/env/' + name + suf[ i ];

}

/*
==================
Sky_LoadSkyBoxFaces

The image part of Sky_LoadSkyBox, from files already fetched. Returns
{ size, faces } with faces the six RGBA faces in cubemap_order (null for a
missing one, which is drawn black), or null when no face loaded or they
aren't all square and the same size.
==================
*/
export function Sky_LoadSkyBoxFaces( name ) {

	const data = new Array( 6 );
	let numloaded = 0;
	let samesize = 0;

	for ( let i = 0; i < 6; i ++ ) {

		const filename = Sky_SkyBoxFilename( name, i );
		const image = Image_LoadImage( filename );
		data[ i ] = image;
		if ( image !== null ) {

			numloaded ++;
			if ( image.width !== image.height )
				samesize = - 1;
			else if ( samesize === 0 )
				samesize = image.width;
			else if ( samesize !== image.width )
				samesize = - 1;

		} else {

			Con_Printf( 'Couldn\'t load ' + filename + '\n' );

		}

	}

	if ( numloaded === 0 ) // go back to scrolling sky if skybox is totally missing
		return null;

	if ( samesize <= 0 ) {

		Con_Printf( 'Skybox ' + name + ': the faces are not all square and the same size\n' );
		return null;

	}

	const faces = new Array( 6 );
	for ( let i = 0; i < 6; i ++ ) {

		const image = data[ cubemap_order[ i ] ];
		faces[ i ] = image !== null ? image.data : null;

	}

	return { size: samesize, faces };

}

/*
==================
Sky_CreateCubemap
==================
*/
function Sky_CreateCubemap( size, faces ) {

	const images = new Array( 6 );
	for ( let i = 0; i < 6; i ++ ) {

		const pixels = faces[ i ] !== null ? faces[ i ] : new Uint8Array( size * size * 4 );
		images[ i ] = new THREE.DataTexture( pixels, size, size, THREE.RGBAFormat );

	}

	// flipY stays false: the rows go up top first, as Ironwail's TexMgr does
	const cubemap = new THREE.CubeTexture( images );
	cubemap.format = THREE.RGBAFormat;
	cubemap.colorSpace = THREE.SRGBColorSpace;
	cubemap.magFilter = THREE.LinearFilter;
	cubemap.minFilter = THREE.LinearMipmapLinearFilter; // TEXPREF_MIPMAP
	cubemap.generateMipmaps = true;
	cubemap.needsUpdate = true;
	return cubemap;

}

/*
==================
Sky_FreeSkyBox
==================
*/
function Sky_FreeSkyBox( sky ) {

	if ( sky !== null )
		sky.cubemap.dispose();

}

/*
==================
Sky_InstallSkyBox

The end of Sky_LoadSkyBox, once the faces are available
==================
*/
function Sky_InstallSkyBox( name ) {

	const loaded = Sky_LoadSkyBoxFaces( name );
	if ( loaded === null ) {

		skybox = null;
		skybox_name = ''; // so asking again retries, as Ironwail does
		return;

	}

	// skybox is null while a fetch is pending, so the cache is not in use
	Sky_FreeSkyBox( skybox_cache );

	skybox = { name, cubemap: Sky_CreateCubemap( loaded.size, loaded.faces ) };
	skybox_cache = skybox;

}

/*
==================
Sky_LoadSkyBox

Returns a Promise that settles when the box is in place (or failed), for
the tests; callers don't need to wait for it.
==================
*/
export function Sky_LoadSkyBox( name ) {

	if ( skybox_name === name )
		return Promise.resolve(); // no change

	skybox_serial ++;
	skybox_name = name;

	// turn off skybox if sky is set to ""
	if ( name === '' ) {

		skybox = null;
		return Promise.resolve();

	}

	// check if already loaded
	if ( skybox_cache !== null && skybox_cache.name === name ) {

		skybox = skybox_cache;
		return Promise.resolve();

	}

	// the scrolling sky until the faces arrive
	skybox = null;

	const serial = skybox_serial;
	const fetches = new Array( 6 );
	for ( let i = 0; i < 6; i ++ )
		fetches[ i ] = COM_EnsureFile( Sky_SkyBoxFilename( name, i ) + '.tga' );

	return Promise.all( fetches ).then( () => {

		if ( serial === skybox_serial )
			Sky_InstallSkyBox( name );

	} );

}

/*
=================
Sky_ClearAll

Called on map unload/game change. Ironwail frees every box here; this
keeps the last one for a map that asks for it again (Sky_NewMap frees it
otherwise).
=================
*/
export function Sky_ClearAll() {

	skybox_serial ++;
	skybox = null;
	skybox_name = '';

}

/*
=================
Sky_NewMap

The skybox part. Ironwail reads the worldspawn's "sky" key (with or without
the leading '_' mappers use), and also accepts Half-Life's "skyname" and
Quake Live's "qlsky". Returns the Promise from Sky_LoadSkyBox.
=================
*/
export function Sky_NewMap( entities ) {

	Sky_ClearAll();

	let name = '';
	Sky_ParseWorldspawn( entities, ( key, value ) => {

		if ( key === 'sky' || key === 'skyname' || key === 'qlsky' )
			name = value;

	} );

	if ( skybox_cache !== null && skybox_cache.name !== name ) {

		Sky_FreeSkyBox( skybox_cache );
		skybox_cache = null;

	}

	return Sky_LoadSkyBox( name );

}

/*
=================
Sky_ParseWorldspawn

The worldspawn loop of Sky_NewMap: calls fn( key, value ) for each pair,
the key without a leading '_' and trailing spaces
=================
*/
function Sky_ParseWorldspawn( entities, fn ) {

	if ( entities === null || entities === undefined )
		return;

	let data = COM_Parse( entities );
	if ( data === null ) // should never happen
		return; // error
	if ( com_token.charAt( 0 ) !== '{' ) // should never happen
		return; // error
	while ( true ) {

		data = COM_Parse( data );
		if ( data === null )
			return; // error
		if ( com_token.charAt( 0 ) === '}' )
			break; // end of worldspawn
		const key = ( com_token.charAt( 0 ) === '_' ? com_token.substring( 1 ) : com_token ).replace( / +$/, '' );
		data = COM_Parse( data );
		if ( data === null )
			return; // error
		fn( key, com_token );

	}

}

/*
=================
Sky_SkyCommand_f
=================
*/
export function Sky_SkyCommand_f() {

	switch ( Cmd_Argc() ) {

		case 1:
			Con_Printf( '"sky" is "' + skybox_name + '"\n' );
			break;
		case 2:
			Sky_LoadSkyBox( Cmd_Argv( 1 ) );
			break;
		default:
			Con_Printf( 'usage: sky <skyname>\n' );

	}

}

/*
=============
Sky_Init

The skybox part: r_skyfog is registered by Fog_Init (gl_fog.js)
=============
*/
export function Sky_Init() {

	Cmd_AddCommand( 'sky', Sky_SkyCommand_f );

}

/*
=============
Sky_GetSkyBox

The box R_DrawSkyChain draws, { name, cubemap }, or null for the scrolling
sky
=============
*/
export function Sky_GetSkyBox() {

	return skybox;

}
