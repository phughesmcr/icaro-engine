// Ported from: WinQuake/menu.c, WinQuake/menu.h -- menu system

import { Cbuf_AddText } from './cmd.js';
import { Cmd_AddCommand } from './cmd.js';
import { Con_Printf, Con_ToggleConsole_f } from './console.js';
import {
	K_ESCAPE, K_ENTER, K_UPARROW, K_DOWNARROW, K_LEFTARROW, K_RIGHTARROW,
	K_BACKSPACE, K_DEL,
	key_game, key_console, key_menu, key_dest,
	keybindings, Key_SetBinding, Key_KeynumToString, Key_Event, Key_ModalActive
} from './keys.js';
import { cl_forwardspeed } from './cl_input.js';
import { sensitivity, m_pitch, lookspring, lookstrafe, cl_color } from './cl_main.js';
import { volume, bgmvolume } from './sound.js';
import { Cvar_SetValue, Cvar_VariableValue } from './cvar.js';
import { scr_viewsize, scr_con_current, SCR_ModalMessage } from './gl_screen.js';
import { v_gamma } from './view.js';
import { gl_texturemode, GL_UpdateTextureFiltering } from './glquake.js';
import { skill, coop, teamplay, svs } from './server.js';
import { Touch_ExitFullscreen } from './touch.js';
import { Draw_GetVirtualWidth, Draw_GetVirtualHeight } from './gl_draw.js';
import { SAVEGAME_COMMENT_LENGTH } from './quakedef.js';
import { registered, standard_quake, rogue, hipnotic } from './common.js';
import { Sys_PageURL } from './sys.js';

/*
==============================================================================

			MENU STATES

==============================================================================
*/

export const m_none = 0;
export const m_main = 1;
export const m_singleplayer = 2;
export const m_load = 3;
export const m_save = 4;
export const m_multiplayer = 5;
export const m_setup = 6;
export const m_net = 7;
export const m_options = 8;
export const m_video = 9;
export const m_keys = 10;
export const m_help = 11;
export const m_quit = 12;
export const m_serialconfig = 13;
export const m_modemconfig = 14;
export const m_lanconfig = 15;
export const m_gameoptions = 16;
export const m_search = 17;
export const m_slist = 18;
export const m_credits = 19;
export const m_touch = 20;

export let m_state = m_none;
export let m_entersound = false;
let m_recursiveDraw = false;

let m_return_state = 0;
let m_return_onerror = false;
let m_return_reason = '';

let m_save_demonum = 0;

/*
==============================================================================

			LAN CONFIG MENU (Join Game)

==============================================================================
*/

// Default WebTransport server (can be overridden by URL param)
const DEFAULT_WT_SERVER = 'https://localhost:4433';

// Room list state
let slist_rooms = []; // Array of {id, name, map, playerCount, maxPlayers}
let slist_cursor = 0;
let slist_fetching = false;
let slist_error = '';

// WT_QueryRooms and WT_CreateRoom will be injected via M_SetExternals
let _WT_QueryRooms = null;
let _WT_CreateRoom = null;
let _cl_name = null;

/**
 * Fetch room list from server via WebTransport
 */
async function M_FetchRooms() {

	slist_fetching = true;
	slist_error = '';
	slist_rooms = [];

	// Check if WebTransport is available before attempting
	if ( typeof WebTransport === 'undefined' ) {

		alert( 'Multiplayer requires a browser with WebTransport support (Chrome 97+, Edge 97+, Firefox 114+, or Opera 83+).' );
		M_Menu_Main_f();
		return;

	}

	try {

		const params = new URLSearchParams( window.location.search );
		const serverUrl = params.get( 'server' ) || DEFAULT_WT_SERVER;

		if ( ! _WT_QueryRooms ) {

			throw new Error( 'WebTransport not available' );

		}

		slist_rooms = await _WT_QueryRooms( serverUrl );

	} catch ( e ) {

		slist_error = e.message || 'Failed to fetch rooms';
		Con_Printf( 'Room fetch error: %s\n', slist_error );

	}

	slist_fetching = false;

}

/*
==============================================================================

			GAME OPTIONS MENU (New Game)

==============================================================================
*/

let gameoptions_cursor = 0;
const gameoptions_cursor_table = [ 40, 56, 64, 72, 80, 104, 112 ];
const NUM_GAMEOPTIONS = 7;

let maxplayers = 4;
let startepisode = 2; // Default to Deathmatch Arena
let startlevel = 1;   // Default to rapture1

// Level data - shareware Episode 1 + community deathmatch maps
const levels = [
	{ name: 'start', description: 'Entrance' }, // 0

	{ name: 'e1m1', description: 'Slipgate Complex' }, // 1
	{ name: 'e1m2', description: 'Castle of the Damned' },
	{ name: 'e1m3', description: 'The Necropolis' },
	{ name: 'e1m4', description: 'The Grisly Grotto' },
	{ name: 'e1m5', description: 'Gloom Keep' },
	{ name: 'e1m6', description: 'The Door To Chthon' },
	{ name: 'e1m7', description: 'The House of Chthon' },
	{ name: 'e1m8', description: 'Ziggurat Vertigo' },

	// Community deathmatch maps (freely distributable)
	{ name: 'spinev2', description: 'Spine v2 (Headshot)' }, // 9
	{ name: 'rapture1', description: 'Imminent Boom (Danimal)' },
	{ name: 'naked5', description: 'Kinky Afro (Gandhi)' },
	{ name: 'zed', description: 'Zed (Vondur)' },
	{ name: 'efdm9', description: 'Tangerine Dream (Mr Fribbles)' },
	{ name: 'baldm6', description: 'Scrap Metal (Bal)' },
	{ name: 'edc', description: 'Eternal Dismemberment (Tyrann)' },
	{ name: 'ultrav', description: 'UltraViolence (Escher)' },

	// Registered id1 levels (menu.c levels[]), offered when registered
	{ name: 'e2m1', description: 'The Installation' }, // 17
	{ name: 'e2m2', description: 'Ogre Citadel' },
	{ name: 'e2m3', description: 'Crypt of Decay' },
	{ name: 'e2m4', description: 'The Ebon Fortress' },
	{ name: 'e2m5', description: 'The Wizard\'s Manse' },
	{ name: 'e2m6', description: 'The Dismal Oubliette' },
	{ name: 'e2m7', description: 'Underearth' },

	{ name: 'e3m1', description: 'Termination Central' }, // 24
	{ name: 'e3m2', description: 'The Vaults of Zin' },
	{ name: 'e3m3', description: 'The Tomb of Terror' },
	{ name: 'e3m4', description: 'Satan\'s Dark Delight' },
	{ name: 'e3m5', description: 'Wind Tunnels' },
	{ name: 'e3m6', description: 'Chambers of Torment' },
	{ name: 'e3m7', description: 'The Haunted Halls' },

	{ name: 'e4m1', description: 'The Sewage System' }, // 31
	{ name: 'e4m2', description: 'The Tower of Despair' },
	{ name: 'e4m3', description: 'The Elder God Shrine' },
	{ name: 'e4m4', description: 'The Palace of Hate' },
	{ name: 'e4m5', description: 'Hell\'s Atrium' },
	{ name: 'e4m6', description: 'The Pain Maze' },
	{ name: 'e4m7', description: 'Azure Agony' },
	{ name: 'e4m8', description: 'The Nameless City' },

	{ name: 'end', description: 'Shub-Niggurath\'s Pit' }, // 39

	{ name: 'dm1', description: 'Place of Two Deaths' }, // 40
	{ name: 'dm2', description: 'Claustrophobopolis' },
	{ name: 'dm3', description: 'The Abandoned Base' },
	{ name: 'dm4', description: 'The Bad Place' },
	{ name: 'dm5', description: 'The Cistern' },
	{ name: 'dm6', description: 'The Dark Zone' },
];

const episodes = [
	{ description: 'Welcome to Quake', firstLevel: 0, levels: 1 },
	{ description: 'Doomed Dimension', firstLevel: 1, levels: 8 },
	{ description: 'Deathmatch Arena', firstLevel: 9, levels: 8 },

	// registered only (menu.c episodes[]); see M_NumEpisodes
	{ description: 'Realm of Black Magic', firstLevel: 17, levels: 7 },
	{ description: 'Netherworld', firstLevel: 24, levels: 7 },
	{ description: 'The Elder World', firstLevel: 31, levels: 8 },
	{ description: 'Final Level', firstLevel: 39, levels: 1 },
	{ description: 'id1 Deathmatch', firstLevel: 40, levels: 6 }
];

// The episodes before these are in the shareware pak or shipped loose
const SHAREWARE_EPISODES = 3;

//MED 01/06/97 added hipnotic levels
const hipnoticlevels = [
	{ name: 'start', description: 'Command HQ' }, // 0

	{ name: 'hip1m1', description: 'The Pumping Station' }, // 1
	{ name: 'hip1m2', description: 'Storage Facility' },
	{ name: 'hip1m3', description: 'The Lost Mine' },
	{ name: 'hip1m4', description: 'Research Facility' },
	{ name: 'hip1m5', description: 'Military Complex' },

	{ name: 'hip2m1', description: 'Ancient Realms' }, // 6
	{ name: 'hip2m2', description: 'The Black Cathedral' },
	{ name: 'hip2m3', description: 'The Catacombs' },
	{ name: 'hip2m4', description: 'The Crypt' },
	{ name: 'hip2m5', description: 'Mortum\'s Keep' },
	{ name: 'hip2m6', description: 'The Gremlin\'s Domain' },

	{ name: 'hip3m1', description: 'Tur Torment' }, // 12
	{ name: 'hip3m2', description: 'Pandemonium' },
	{ name: 'hip3m3', description: 'Limbo' },
	{ name: 'hip3m4', description: 'The Gauntlet' },

	{ name: 'hipend', description: 'Armagon\'s Lair' }, // 16

	{ name: 'hipdm1', description: 'The Edge of Oblivion' } // 17
];

//PGM 01/07/97 added rogue levels
//PGM 03/02/97 added dmatch level
const roguelevels = [
	{ name: 'start', description: 'Split Decision' },
	{ name: 'r1m1', description: 'Deviant\'s Domain' },
	{ name: 'r1m2', description: 'Dread Portal' },
	{ name: 'r1m3', description: 'Judgement Call' },
	{ name: 'r1m4', description: 'Cave of Death' },
	{ name: 'r1m5', description: 'Towers of Wrath' },
	{ name: 'r1m6', description: 'Temple of Pain' },
	{ name: 'r1m7', description: 'Tomb of the Overlord' },
	{ name: 'r2m1', description: 'Tempus Fugit' },
	{ name: 'r2m2', description: 'Elemental Fury I' },
	{ name: 'r2m3', description: 'Elemental Fury II' },
	{ name: 'r2m4', description: 'Curse of Osiris' },
	{ name: 'r2m5', description: 'Wizard\'s Keep' },
	{ name: 'r2m6', description: 'Blood Sacrifice' },
	{ name: 'r2m7', description: 'Last Bastion' },
	{ name: 'r2m8', description: 'Source of Evil' },
	{ name: 'ctf1', description: 'Division of Change' }
];

//MED 01/06/97  added hipnotic episodes
const hipnoticepisodes = [
	{ description: 'Scourge of Armagon', firstLevel: 0, levels: 1 },
	{ description: 'Fortress of the Dead', firstLevel: 1, levels: 5 },
	{ description: 'Dominion of Darkness', firstLevel: 6, levels: 6 },
	{ description: 'The Rift', firstLevel: 12, levels: 4 },
	{ description: 'Final Level', firstLevel: 16, levels: 1 },
	{ description: 'Deathmatch Arena', firstLevel: 17, levels: 1 }
];

//PGM 01/07/97 added rogue episodes
//PGM 03/02/97 added dmatch episode
const rogueepisodes = [
	{ description: 'Introduction', firstLevel: 0, levels: 1 },
	{ description: 'Hell\'s Fortress', firstLevel: 1, levels: 7 },
	{ description: 'Corridors of Time', firstLevel: 8, levels: 8 },
	{ description: 'Deathmatch Arena', firstLevel: 16, levels: 1 }
];

/*
==============
M_GameEpisodes / M_StartLevel

The episode list for the running game (menu.c picks hipnotic, then rogue,
then id1 at each use), and the level the game options menu points at.
==============
*/
function M_GameEpisodes() {

	if ( hipnotic ) return hipnoticepisodes;
	if ( rogue ) return rogueepisodes;
	return episodes;

}

export function M_StartLevel() {

	const list = hipnotic ? hipnoticlevels : rogue ? roguelevels : levels;
	return list[ M_GameEpisodes()[ startepisode ].firstLevel + startlevel ];

}

/*
==============
M_NumEpisodes

menu.c M_NetStart_Change: 6 for hipnotic, 4 for rogue, 7 when registered
and 2 for shareware. This port adds its loose-file deathmatch episode to
the last two.
==============
*/
export function M_NumEpisodes() {

	if ( hipnotic || rogue ) return M_GameEpisodes().length;
	return registered !== null && registered.value !== 0 ? episodes.length : SHAREWARE_EPISODES;

}

/*
==============================================================================

			CONNECTION ERROR HANDLING

==============================================================================
*/

/**
 * Called when a connection attempt fails.
 * If m_return_onerror is set, returns to the saved menu state with error message.
 * Otherwise falls back to the Multiplayer menu (e.g., for URL-based joins).
 */
export function M_ConnectionError( reason ) {

	m_return_reason = reason || 'Connection failed';

	if ( m_return_onerror ) {

		// Return to the menu we came from
		m_state = m_return_state;
		m_return_onerror = false;

	} else {

		// Fall back to Multiplayer menu (for URL-based joins that bypass menu)
		m_state = m_multiplayer;

	}

}

/**
 * Check if we should return to menu on connection error.
 */
export function M_ShouldReturnOnError() {

	return m_return_onerror;

}

/*
==============================================================================

			EXTERNAL REFERENCES

==============================================================================
*/

// Set by external modules to avoid circular dependencies
let _key_dest_set = null; // function to set key_dest
let _key_dest_get = null; // function to get key_dest
let _cls = { state: 0, demonum: - 1, demoplayback: false };
let _sv = { active: false };
let _svs = { maxclients: 1 };
let _cl = { intermission: 0, gametype: 0 };
let _realVid = { width: 640, height: 480 };
const _vid = {
	get width() { return Draw_GetVirtualWidth(); },
	get height() { return Draw_GetVirtualHeight(); }
};
let _host_time_get = () => 0;
let _realtime_get = () => 0;
let _Draw_CachePic = null;
let _Draw_TransPic = null;
let _Draw_Pic = null;
let _Draw_Character = null;
let _Draw_Fill = null;
let _Draw_FadeScreen = null;
let _Draw_ConsoleBackground = null;
let _Draw_String = null;
let _Draw_TransPicTranslate = null;
let _Draw_SubPic = null;
let _S_LocalSound = null;
let _SCR_BeginLoadingPlaque = null;
let _SCR_EndLoadingPlaque = null;
let _IN_RequestPointerLock = null;
let _CL_NextDemo = null;

export function M_SetExternals( externals ) {

	if ( externals.key_dest_set ) _key_dest_set = externals.key_dest_set;
	if ( externals.key_dest_get ) _key_dest_get = externals.key_dest_get;
	if ( externals.cls ) _cls = externals.cls;
	if ( externals.sv ) _sv = externals.sv;
	if ( externals.svs ) _svs = externals.svs;
	if ( externals.cl ) _cl = externals.cl;
	if ( externals.vid ) _realVid = externals.vid;
	if ( externals.Draw_CachePic ) _Draw_CachePic = externals.Draw_CachePic;
	if ( externals.Draw_TransPic ) _Draw_TransPic = externals.Draw_TransPic;
	if ( externals.Draw_Pic ) _Draw_Pic = externals.Draw_Pic;
	if ( externals.Draw_Character ) _Draw_Character = externals.Draw_Character;
	if ( externals.Draw_Fill ) _Draw_Fill = externals.Draw_Fill;
	if ( externals.Draw_FadeScreen ) _Draw_FadeScreen = externals.Draw_FadeScreen;
	if ( externals.Draw_ConsoleBackground ) _Draw_ConsoleBackground = externals.Draw_ConsoleBackground;
	if ( externals.Draw_String ) _Draw_String = externals.Draw_String;
	if ( externals.S_LocalSound ) _S_LocalSound = externals.S_LocalSound;
	if ( externals.SCR_BeginLoadingPlaque ) _SCR_BeginLoadingPlaque = externals.SCR_BeginLoadingPlaque;
	if ( externals.SCR_EndLoadingPlaque ) _SCR_EndLoadingPlaque = externals.SCR_EndLoadingPlaque;
	if ( externals.IN_RequestPointerLock ) _IN_RequestPointerLock = externals.IN_RequestPointerLock;
	if ( externals.host_time_get ) _host_time_get = externals.host_time_get;
	if ( externals.realtime_get ) _realtime_get = externals.realtime_get;
	if ( externals.CL_NextDemo ) _CL_NextDemo = externals.CL_NextDemo;
	if ( externals.WT_QueryRooms ) _WT_QueryRooms = externals.WT_QueryRooms;
	if ( externals.WT_CreateRoom ) _WT_CreateRoom = externals.WT_CreateRoom;
	if ( externals.cl_name ) _cl_name = externals.cl_name;
	if ( externals.Draw_TransPicTranslate ) _Draw_TransPicTranslate = externals.Draw_TransPicTranslate;
	if ( externals.Draw_SubPic ) _Draw_SubPic = externals.Draw_SubPic;

}

function getKeyDest() {

	return _key_dest_get ? _key_dest_get() : key_dest;

}

function setKeyDest( val ) {

	if ( _key_dest_set ) _key_dest_set( val );

}

/*
==============================================================================

			DRAWING HELPERS

==============================================================================
*/

/*
================
M_DrawCharacter

Draws one solid graphics character
================
*/
function M_DrawCharacter( cx, line, num ) {

	if ( _Draw_Character )
		_Draw_Character( cx + ( ( _vid.width - 320 ) >> 1 ), line + ( ( _vid.height - 200 ) >> 1 ), num );

}

function M_Print( cx, cy, str ) {

	for ( let i = 0; i < str.length; i ++ ) {

		M_DrawCharacter( cx, cy, str.charCodeAt( i ) + 128 );
		cx += 8;

	}

}

function M_PrintWhite( cx, cy, str ) {

	for ( let i = 0; i < str.length; i ++ ) {

		M_DrawCharacter( cx, cy, str.charCodeAt( i ) );
		cx += 8;

	}

}

function M_DrawTransPic( x, y, pic ) {

	if ( _Draw_TransPic && pic )
		_Draw_TransPic( x + ( ( _vid.width - 320 ) >> 1 ), y + ( ( _vid.height - 200 ) >> 1 ), pic );

}

function M_DrawSubPic( x, y, pic, srcY, srcH ) {

	if ( _Draw_SubPic && pic )
		_Draw_SubPic( x + ( ( _vid.width - 320 ) >> 1 ), y + ( ( _vid.height - 200 ) >> 1 ), pic, srcY, srcH );

}

function M_DrawPic( x, y, pic ) {

	if ( _Draw_Pic && pic )
		_Draw_Pic( x + ( ( _vid.width - 320 ) >> 1 ), y + ( ( _vid.height - 200 ) >> 1 ), pic );

}

export { M_DrawPic as M_DrawPic_export };

function M_DrawTransPicTranslate( x, y, pic ) {

	if ( _Draw_TransPicTranslate != null && pic != null )
		_Draw_TransPicTranslate( x + ( ( _vid.width - 320 ) >> 1 ), y + ( ( _vid.height - 200 ) >> 1 ), pic, translationTable );

}

function M_DrawTextBox( x, y, width, lines ) {

	if ( ! _Draw_CachePic ) return;

	let cx, cy, n;
	let p;

	// draw left side
	cx = x;
	cy = y;
	p = _Draw_CachePic( 'gfx/box_tl.lmp' );
	M_DrawTransPic( cx, cy, p );
	p = _Draw_CachePic( 'gfx/box_ml.lmp' );
	for ( n = 0; n < lines; n ++ ) {

		cy += 8;
		M_DrawTransPic( cx, cy, p );

	}

	p = _Draw_CachePic( 'gfx/box_bl.lmp' );
	M_DrawTransPic( cx, cy + 8, p );

	// draw middle
	cx += 8;
	while ( width > 0 ) {

		cy = y;
		p = _Draw_CachePic( 'gfx/box_tm.lmp' );
		M_DrawTransPic( cx, cy, p );
		p = _Draw_CachePic( 'gfx/box_mm.lmp' );
		for ( n = 0; n < lines; n ++ ) {

			cy += 8;
			if ( n === 1 )
				p = _Draw_CachePic( 'gfx/box_mm2.lmp' );
			M_DrawTransPic( cx, cy, p );

		}

		p = _Draw_CachePic( 'gfx/box_bm.lmp' );
		M_DrawTransPic( cx, cy + 8, p );
		width -= 2;
		cx += 16;

	}

	// draw right side
	cy = y;
	p = _Draw_CachePic( 'gfx/box_tr.lmp' );
	M_DrawTransPic( cx, cy, p );
	p = _Draw_CachePic( 'gfx/box_mr.lmp' );
	for ( n = 0; n < lines; n ++ ) {

		cy += 8;
		M_DrawTransPic( cx, cy, p );

	}

	p = _Draw_CachePic( 'gfx/box_br.lmp' );
	M_DrawTransPic( cx, cy + 8, p );

}

/*
==============================================================================

			TRANSLATION TABLE (for player color)

==============================================================================
*/

const TOP_RANGE = 16;
const BOTTOM_RANGE = 96;

const identityTable = new Uint8Array( 256 );
const translationTable = new Uint8Array( 256 );

function M_BuildTranslationTable( top, bottom ) {

	for ( let j = 0; j < 256; j ++ )
		identityTable[ j ] = j;

	translationTable.set( identityTable );

	if ( top < 128 ) {

		for ( let j = 0; j < 16; j ++ )
			translationTable[ TOP_RANGE + j ] = identityTable[ top + j ];

	} else {

		for ( let j = 0; j < 16; j ++ )
			translationTable[ TOP_RANGE + j ] = identityTable[ top + 15 - j ];

	}

	if ( bottom < 128 ) {

		for ( let j = 0; j < 16; j ++ )
			translationTable[ BOTTOM_RANGE + j ] = identityTable[ bottom + j ];

	} else {

		for ( let j = 0; j < 16; j ++ )
			translationTable[ BOTTOM_RANGE + j ] = identityTable[ bottom + 15 - j ];

	}

}

/*
================
M_ToggleMenu_f
================
*/
export function M_ToggleMenu_f() {

	m_entersound = true;

	if ( getKeyDest() === key_menu ) {

		if ( m_state !== m_main ) {

			M_Menu_Main_f();
			return;

		}

		setKeyDest( key_game );
		m_state = m_none;
		return;

	}

	if ( getKeyDest() === key_console ) {

		Con_ToggleConsole_f();

	} else {

		M_Menu_Main_f();

	}

}

/*
==============================================================================

			MAIN MENU

==============================================================================
*/

let m_main_cursor = 0;
const MAIN_ITEMS = 5;

// Check if we're currently playing (not watching demos)
function M_InGame() {

	// ca_connected = 2 in client.js
	// Don't show Continue during demo playback - only when actually playing
	if ( _cls.demoplayback )
		return false;

	return _sv.active || _cls.state === 2;

}

export function M_Menu_Main_f() {

	if ( getKeyDest() !== key_menu ) {

		m_save_demonum = _cls.demonum;
		_cls.demonum = - 1;

	}

	setKeyDest( key_menu );
	m_state = m_main;
	m_entersound = true;

}

function M_Main_Draw() {

	if ( ! _Draw_CachePic ) return;

	const inGame = M_InGame();

	M_DrawTransPic( 16, 4, _Draw_CachePic( 'gfx/qplaque.lmp' ) );
	const p = _Draw_CachePic( 'gfx/ttl_main.lmp' );
	M_DrawPic( ( 320 - ( p ? p.width : 0 ) ) / 2, 4, p );

	// Use the extended menu image (Continue + 5 items) if available, otherwise fall back to PAK images
	const extPic = _Draw_CachePic( 'gfx/mainmenu_ext.lmp' );

	if ( extPic != null ) {

		if ( inGame ) {

			// Draw full image (Continue + 5 items)
			M_DrawTransPic( 72, 32, extPic );

		} else {

			// Skip the Continue row (first 21px), draw only the 5 regular items
			M_DrawSubPic( 72, 32, extPic, 21, 112 );

		}

	} else {

		// Fallback to original PAK images
		if ( inGame ) {

			M_DrawTransPic( 72, 32, _Draw_CachePic( 'gfx/continue.lmp' ) );
			M_DrawTransPic( 72, 52, _Draw_CachePic( 'gfx/mainmenu.lmp' ) );

		} else {

			M_DrawTransPic( 72, 32, _Draw_CachePic( 'gfx/mainmenu.lmp' ) );

		}

	}

	const f = Math.floor( _host_time_get() * 10 ) % 6;
	M_DrawTransPic( 54, 32 + m_main_cursor * 20, _Draw_CachePic( 'gfx/menudot' + ( f + 1 ) + '.lmp' ) );

}

function M_Main_Key( key ) {

	const inGame = M_InGame();
	const itemCount = inGame ? MAIN_ITEMS + 1 : MAIN_ITEMS;

	switch ( key ) {

		case K_ESCAPE:
			setKeyDest( key_game );
			m_state = m_none;
			_cls.demonum = m_save_demonum;
			if ( _cls.demonum !== - 1 && ! _cls.demoplayback && _cls.state !== 2 ) // ca_connected
				if ( _CL_NextDemo ) _CL_NextDemo();
			break;

		case K_DOWNARROW:
			if ( _S_LocalSound ) _S_LocalSound( 'misc/menu1.wav' );
			if ( ++ m_main_cursor >= itemCount )
				m_main_cursor = 0;
			break;

		case K_UPARROW:
			if ( _S_LocalSound ) _S_LocalSound( 'misc/menu1.wav' );
			if ( -- m_main_cursor < 0 )
				m_main_cursor = itemCount - 1;
			break;

		case K_ENTER: {
			m_entersound = true;

			// Adjust cursor for menu action - if in-game, cursor 0 is Continue
			const actionCursor = inGame ? m_main_cursor - 1 : m_main_cursor;

			if ( inGame && m_main_cursor === 0 ) {

				// Continue - return to game
				setKeyDest( key_game );
				m_state = m_none;
				break;

			}

			switch ( actionCursor ) {

				case 0:
					M_Menu_SinglePlayer_f();
					break;
				case 1:
					M_Menu_MultiPlayer_f();
					break;
				case 2:
					M_Menu_Options_f();
					break;
				case 3:
					M_Menu_Credits_f();
					break;
				case 4:
					// Exit fullscreen when entering quit menu
					Touch_ExitFullscreen();
					M_Menu_Quit_f();
					break;

			}

			break;
		}

	}

}

/*
==============================================================================

			SINGLE PLAYER MENU

==============================================================================
*/

let m_singleplayer_cursor = 0;
const SINGLEPLAYER_ITEMS = 3;

function M_Menu_SinglePlayer_f() {

	setKeyDest( key_menu );
	m_state = m_singleplayer;
	m_entersound = true;

}

function M_SinglePlayer_Draw() {

	if ( ! _Draw_CachePic ) return;

	M_DrawTransPic( 16, 4, _Draw_CachePic( 'gfx/qplaque.lmp' ) );
	const p = _Draw_CachePic( 'gfx/ttl_sgl.lmp' );
	M_DrawPic( ( 320 - ( p ? p.width : 0 ) ) / 2, 4, p );
	M_DrawTransPic( 72, 32, _Draw_CachePic( 'gfx/sp_menu.lmp' ) );

	const f = Math.floor( _host_time_get() * 10 ) % 6;
	M_DrawTransPic( 54, 32 + m_singleplayer_cursor * 20, _Draw_CachePic( 'gfx/menudot' + ( f + 1 ) + '.lmp' ) );

}

// when the last SCR_ModalMessage opened, for M_TouchInput
let m_modal_time = 0;
const MODAL_TOUCH_DELAY = 0.5; // seconds

function M_SinglePlayer_NewGame() {

	setKeyDest( key_game );
	if ( _IN_RequestPointerLock ) _IN_RequestPointerLock();
	if ( _sv.active )
		Cbuf_AddText( 'disconnect\n' );
	Cbuf_AddText( 'maxplayers 1\n' );
	Cbuf_AddText( 'map start\n' );

}

function M_SinglePlayer_Key( key ) {

	switch ( key ) {

		case K_ESCAPE:
			M_Menu_Main_f();
			break;

		case K_DOWNARROW:
			if ( _S_LocalSound ) _S_LocalSound( 'misc/menu1.wav' );
			if ( ++ m_singleplayer_cursor >= SINGLEPLAYER_ITEMS )
				m_singleplayer_cursor = 0;
			break;

		case K_UPARROW:
			if ( _S_LocalSound ) _S_LocalSound( 'misc/menu1.wav' );
			if ( -- m_singleplayer_cursor < 0 )
				m_singleplayer_cursor = SINGLEPLAYER_ITEMS - 1;
			break;

		case K_ENTER:
			m_entersound = true;

			switch ( m_singleplayer_cursor ) {

				case 0:
					if ( _sv.active ) {

						m_modal_time = _realtime_get();
						SCR_ModalMessage( 'Are you sure you want to\nstart a new game?\n', function ( yes ) {

							if ( yes )
								M_SinglePlayer_NewGame();

						} );
						break;

					}

					M_SinglePlayer_NewGame();
					break;
				case 1:
					M_Menu_Load_f();
					break;
				case 2:
					M_Menu_Save_f();
					break;

			}

			break;

	}

}

/*
==============================================================================

			LOAD/SAVE MENU

==============================================================================
*/

let load_cursor = 0;
const MAX_SAVEGAMES = 12;
const SAVE_STORAGE_PREFIX = 'quake_save_';

const m_filenames = [];
const loadable = [];
for ( let i = 0; i < MAX_SAVEGAMES; i ++ ) {

	m_filenames[ i ] = '--- UNUSED SLOT ---';
	loadable[ i ] = false;

}

function M_ScanSaves() {

	for ( let i = 0; i < MAX_SAVEGAMES; i ++ ) {

		m_filenames[ i ] = '--- UNUSED SLOT ---';
		loadable[ i ] = false;

	}
	let storage;
	try {

		if ( typeof localStorage === 'undefined' ) return;
		storage = localStorage;

	} catch {

		return;

	}

	for ( let i = 0; i < MAX_SAVEGAMES; i ++ ) {

		let saveData;
		try {

			saveData = storage.getItem( SAVE_STORAGE_PREFIX + 's' + i );

		} catch {

			return;

		}
		if ( saveData === null ) continue;

		const lines = saveData.split( '\n', 2 );
		if ( lines.length < 2 ) continue;

		m_filenames[ i ] = lines[ 1 ].substring( 0, SAVEGAME_COMMENT_LENGTH ).replace( /_/g, ' ' );
		loadable[ i ] = true;

	}

}

function M_Menu_Load_f() {

	m_entersound = true;
	m_state = m_load;
	setKeyDest( key_menu );
	M_ScanSaves();

}

function M_Menu_Save_f() {

	if ( ! _sv.active )
		return;
	if ( _cl.intermission )
		return;
	if ( _svs.maxclients !== 1 )
		return;

	m_entersound = true;
	m_state = m_save;
	setKeyDest( key_menu );
	M_ScanSaves();

}

function M_Load_Draw() {

	if ( ! _Draw_CachePic ) return;

	const p = _Draw_CachePic( 'gfx/p_load.lmp' );
	M_DrawPic( ( 320 - ( p ? p.width : 0 ) ) / 2, 4, p );

	for ( let i = 0; i < MAX_SAVEGAMES; i ++ )
		M_Print( 16, 32 + 8 * i, m_filenames[ i ] );

	// line cursor
	M_DrawCharacter( 8, 32 + load_cursor * 8, 12 + ( ( Math.floor( _realtime_get() * 4 ) ) & 1 ) );

}

function M_Save_Draw() {

	if ( ! _Draw_CachePic ) return;

	const p = _Draw_CachePic( 'gfx/p_save.lmp' );
	M_DrawPic( ( 320 - ( p ? p.width : 0 ) ) / 2, 4, p );

	for ( let i = 0; i < MAX_SAVEGAMES; i ++ )
		M_Print( 16, 32 + 8 * i, m_filenames[ i ] );

	M_DrawCharacter( 8, 32 + load_cursor * 8, 12 + ( ( Math.floor( _realtime_get() * 4 ) ) & 1 ) );

}

function M_Load_Key( k ) {

	switch ( k ) {

		case K_ESCAPE:
			M_Menu_SinglePlayer_f();
			break;
		case K_ENTER:
			if ( _S_LocalSound ) _S_LocalSound( 'misc/menu2.wav' );
			if ( ! loadable[ load_cursor ] )
				return;
			m_state = m_none;
			setKeyDest( key_game );
			if ( _IN_RequestPointerLock ) _IN_RequestPointerLock();
			if ( _SCR_BeginLoadingPlaque ) _SCR_BeginLoadingPlaque();
			Cbuf_AddText( 'load s' + load_cursor + '\n' );
			return;
		case K_UPARROW:
		case K_LEFTARROW:
			if ( _S_LocalSound ) _S_LocalSound( 'misc/menu1.wav' );
			load_cursor --;
			if ( load_cursor < 0 )
				load_cursor = MAX_SAVEGAMES - 1;
			break;
		case K_DOWNARROW:
		case K_RIGHTARROW:
			if ( _S_LocalSound ) _S_LocalSound( 'misc/menu1.wav' );
			load_cursor ++;
			if ( load_cursor >= MAX_SAVEGAMES )
				load_cursor = 0;
			break;

	}

}

function M_Save_Key( k ) {

	switch ( k ) {

		case K_ESCAPE:
			M_Menu_SinglePlayer_f();
			break;
		case K_ENTER:
			m_state = m_none;
			setKeyDest( key_game );
			Cbuf_AddText( 'save s' + load_cursor + '\n' );
			return;
		case K_UPARROW:
		case K_LEFTARROW:
			if ( _S_LocalSound ) _S_LocalSound( 'misc/menu1.wav' );
			load_cursor --;
			if ( load_cursor < 0 )
				load_cursor = MAX_SAVEGAMES - 1;
			break;
		case K_DOWNARROW:
		case K_RIGHTARROW:
			if ( _S_LocalSound ) _S_LocalSound( 'misc/menu1.wav' );
			load_cursor ++;
			if ( load_cursor >= MAX_SAVEGAMES )
				load_cursor = 0;
			break;

	}

}

/*
==============================================================================

			MULTIPLAYER MENU

==============================================================================
*/

let m_multiplayer_cursor = 0;
const MULTIPLAYER_ITEMS = 3;

function M_Menu_MultiPlayer_f() {

	setKeyDest( key_menu );
	m_state = m_multiplayer;
	m_entersound = true;
	m_return_reason = '';

}

function M_MultiPlayer_Draw() {

	if ( ! _Draw_CachePic ) return;

	M_DrawTransPic( 16, 4, _Draw_CachePic( 'gfx/qplaque.lmp' ) );
	const p = _Draw_CachePic( 'gfx/p_multi.lmp' );
	M_DrawPic( ( 320 - ( p ? p.width : 0 ) ) / 2, 4, p );
	M_DrawTransPic( 72, 32, _Draw_CachePic( 'gfx/mp_menu.lmp' ) );

	const f = Math.floor( _host_time_get() * 10 ) % 6;
	M_DrawTransPic( 54, 32 + m_multiplayer_cursor * 20, _Draw_CachePic( 'gfx/menudot' + ( f + 1 ) + '.lmp' ) );

	// Error message from connection attempt
	if ( m_return_reason ) {

		M_PrintWhite( 72, 97, m_return_reason );

	}

}

function M_MultiPlayer_Key( key ) {

	switch ( key ) {

		case K_ESCAPE:
			M_Menu_Main_f();
			break;
		case K_DOWNARROW:
			if ( _S_LocalSound ) _S_LocalSound( 'misc/menu1.wav' );
			if ( ++ m_multiplayer_cursor >= MULTIPLAYER_ITEMS )
				m_multiplayer_cursor = 0;
			break;
		case K_UPARROW:
			if ( _S_LocalSound ) _S_LocalSound( 'misc/menu1.wav' );
			if ( -- m_multiplayer_cursor < 0 )
				m_multiplayer_cursor = MULTIPLAYER_ITEMS - 1;
			break;
		case K_ENTER:
			m_entersound = true;
			switch ( m_multiplayer_cursor ) {

				case 0:
					// Join Game -> LAN Config (room list)
					M_Menu_LanConfig_f();
					break;
				case 1:
					// New Game -> Game Options
					M_Menu_GameOptions_f();
					break;
				case 2:
					M_Menu_Setup_f();
					break;

			}

			break;

	}

}

/*
==============================================================================

			LAN CONFIG MENU (Join Game via WebTransport)

==============================================================================
*/

function M_Menu_LanConfig_f() {

	setKeyDest( key_menu );
	m_state = m_lanconfig;
	m_entersound = true;

	slist_cursor = 0;
	m_return_onerror = false;
	m_return_reason = '';

	// Fetch room list
	M_FetchRooms();

}

function M_LanConfig_Draw() {

	if ( ! _Draw_CachePic ) return;

	M_DrawTransPic( 16, 4, _Draw_CachePic( 'gfx/qplaque.lmp' ) );
	const p = _Draw_CachePic( 'gfx/p_multi.lmp' );
	const basex = ( 320 - ( p ? p.width : 0 ) ) / 2;
	M_DrawPic( basex, 4, p );

	M_Print( basex, 32, 'Join Game' );

	if ( slist_fetching ) {

		M_Print( basex, 52, 'Searching for games...' );

	} else if ( slist_error ) {

		M_Print( basex, 52, 'Error: ' + slist_error.substring( 0, 30 ) );
		M_Print( basex, 68, 'Press SPACE to retry' );

	} else if ( slist_rooms.length === 0 ) {

		M_Print( basex, 52, 'No games found' );
		M_Print( basex, 68, 'Press SPACE to refresh' );

	} else {

		// Draw room list
		const maxVisible = 8;
		const startIdx = Math.max( 0, slist_cursor - maxVisible + 1 );

		for ( let i = 0; i < maxVisible && ( startIdx + i ) < slist_rooms.length; i ++ ) {

			const room = slist_rooms[ startIdx + i ];
			const y = 52 + i * 12;

			// Room name and map
			const info = room.map + ' (' + room.playerCount + '/' + room.maxPlayers + ')';
			M_Print( basex, y, info );

			// Room ID
			M_PrintWhite( basex + 180, y, room.id );

		}

		// Draw cursor
		const cursorY = 52 + ( slist_cursor - startIdx ) * 12;
		M_DrawCharacter( basex - 8, cursorY, 12 + ( ( Math.floor( _realtime_get() * 4 ) ) & 1 ) );

	}

	// Error message from connection attempt
	if ( m_return_reason ) {

		M_PrintWhite( basex, 170, m_return_reason );

	}

}

function M_LanConfig_Key( key ) {

	switch ( key ) {

		case K_ESCAPE:
			M_Menu_MultiPlayer_f();
			break;

		case K_UPARROW:
			if ( slist_rooms.length > 0 ) {

				if ( _S_LocalSound ) _S_LocalSound( 'misc/menu1.wav' );
				slist_cursor --;
				if ( slist_cursor < 0 )
					slist_cursor = slist_rooms.length - 1;

			}

			break;

		case K_DOWNARROW:
			if ( slist_rooms.length > 0 ) {

				if ( _S_LocalSound ) _S_LocalSound( 'misc/menu1.wav' );
				slist_cursor ++;
				if ( slist_cursor >= slist_rooms.length )
					slist_cursor = 0;

			}

			break;

		case K_ENTER:
			if ( slist_rooms.length > 0 && slist_cursor < slist_rooms.length ) {

				const room = slist_rooms[ slist_cursor ];

				// Don't allow joining full rooms
				if ( room.playerCount >= room.maxPlayers ) {

					if ( _S_LocalSound ) _S_LocalSound( 'misc/menu2.wav' );
					m_return_reason = 'Room is full (' + room.playerCount + '/' + room.maxPlayers + ' players)';
					break;

				}

				// Join selected room
				m_entersound = true;

				const params = new URLSearchParams( window.location.search );
				const serverUrl = params.get( 'server' ) || DEFAULT_WT_SERVER;

				// Always join through the lobby using room ID.
				// This avoids connecting to stale room-port data from an old room list.
				const urlObj = new URL( serverUrl.replace( /^wt(s)?:\/\//, 'https://' ) );
				urlObj.searchParams.set( 'room', room.id );
				const connectUrl = urlObj.toString().replace( /\/$/, '' ).replace( /^https:\/\//, 'wts://' );

				// Update browser URL so user can share it
				history.replaceState( null, '', Sys_PageURL( room.id ) );

				// Set up error return
				m_return_state = m_state;
				m_return_onerror = true;

				// Close menu and connect
				setKeyDest( key_game );
				m_state = m_none;
				Cbuf_AddText( 'connect "' + connectUrl + '"\n' );

			}

			break;

		case 32: // SPACE - refresh
			M_FetchRooms();
			break;

	}

}

/*
==============================================================================

			GAME OPTIONS MENU (New Game / Host)

==============================================================================
*/

function M_Menu_GameOptions_f() {

	setKeyDest( key_menu );
	m_state = m_gameoptions;
	m_entersound = true;

	if ( maxplayers === 0 )
		maxplayers = svs.maxclients || 4;
	if ( maxplayers < 2 )
		maxplayers = 4;

}

function M_GameOptions_Draw() {

	if ( ! _Draw_CachePic ) return;

	M_DrawTransPic( 16, 4, _Draw_CachePic( 'gfx/qplaque.lmp' ) );
	const p = _Draw_CachePic( 'gfx/p_multi.lmp' );
	M_DrawPic( ( 320 - ( p ? p.width : 0 ) ) / 2, 4, p );

	// Begin game button
	M_DrawTextBox( 152, 32, 10, 1 );
	M_Print( 160, 40, 'begin game' );

	// Max players
	M_Print( 0, 56, '      Max players' );
	M_Print( 160, 56, String( maxplayers ) );

	// Game type
	M_Print( 0, 64, '        Game Type' );
	if ( coop.value )
		M_Print( 160, 64, 'Cooperative' );
	else
		M_Print( 160, 64, 'Deathmatch' );

	// Teamplay
	M_Print( 0, 72, '         Teamplay' );
	let teamplayMsg;
	switch ( Math.floor( teamplay.value ) ) {

		case 1: teamplayMsg = 'No Friendly Fire'; break;
		case 2: teamplayMsg = 'Friendly Fire'; break;
		default: teamplayMsg = 'Off'; break;

	}

	if ( rogue ) {

		switch ( Math.floor( teamplay.value ) ) {

			case 3: teamplayMsg = 'Tag'; break;
			case 4: teamplayMsg = 'Capture the Flag'; break;
			case 5: teamplayMsg = 'One Flag CTF'; break;
			case 6: teamplayMsg = 'Three Team CTF'; break;

		}

	}

	M_Print( 160, 72, teamplayMsg );

	// Skill
	M_Print( 0, 80, '            Skill' );
	let skillMsg;
	if ( skill.value === 0 )
		skillMsg = 'Easy difficulty';
	else if ( skill.value === 1 )
		skillMsg = 'Normal difficulty';
	else if ( skill.value === 2 )
		skillMsg = 'Hard difficulty';
	else
		skillMsg = 'Nightmare difficulty';
	M_Print( 160, 80, skillMsg );

	// Episode
	M_Print( 0, 104, '         Episode' );
	M_Print( 160, 104, M_GameEpisodes()[ startepisode ].description );

	// Level
	M_Print( 0, 112, '           Level' );
	const level = M_StartLevel();
	M_Print( 160, 112, level.description );
	M_Print( 160, 120, level.name );

	// Cursor
	M_DrawCharacter( 144, gameoptions_cursor_table[ gameoptions_cursor ], 12 + ( ( Math.floor( _realtime_get() * 4 ) ) & 1 ) );

}

function M_NetStart_Change( dir ) {

	switch ( gameoptions_cursor ) {

		case 1: // Max players
			maxplayers += dir;
			if ( maxplayers > 4 )
				maxplayers = 4;
			if ( maxplayers < 2 )
				maxplayers = 2;
			break;

		case 2: // Game type (coop/deathmatch)
			Cvar_SetValue( 'coop', coop.value ? 0 : 1 );
			break;

		case 3: { // Teamplay

			const count = rogue ? 6 : 2;

			Cvar_SetValue( 'teamplay', teamplay.value + dir );
			if ( teamplay.value > count )
				Cvar_SetValue( 'teamplay', 0 );
			else if ( teamplay.value < 0 )
				Cvar_SetValue( 'teamplay', count );
			break;

		}

		case 4: // Skill
			Cvar_SetValue( 'skill', skill.value + dir );
			if ( skill.value > 3 )
				Cvar_SetValue( 'skill', 0 );
			if ( skill.value < 0 )
				Cvar_SetValue( 'skill', 3 );
			break;

		case 5: { // Episode
			startepisode += dir;

			const numEpisodes = M_NumEpisodes();
			if ( startepisode < 0 )
				startepisode = numEpisodes - 1;
			if ( startepisode >= numEpisodes )
				startepisode = 0;

			startlevel = 0;
			break;
		}

		case 6: { // Level
			startlevel += dir;
			const count = M_GameEpisodes()[ startepisode ].levels;
			if ( startlevel < 0 )
				startlevel = count - 1;
			if ( startlevel >= count )
				startlevel = 0;
			break;
		}

	}

}

function M_GameOptions_Key( key ) {

	switch ( key ) {

		case K_ESCAPE:
			M_Menu_MultiPlayer_f();
			break;

		case K_UPARROW:
			if ( _S_LocalSound ) _S_LocalSound( 'misc/menu1.wav' );
			gameoptions_cursor --;
			if ( gameoptions_cursor < 0 )
				gameoptions_cursor = NUM_GAMEOPTIONS - 1;
			break;

		case K_DOWNARROW:
			if ( _S_LocalSound ) _S_LocalSound( 'misc/menu1.wav' );
			gameoptions_cursor ++;
			if ( gameoptions_cursor >= NUM_GAMEOPTIONS )
				gameoptions_cursor = 0;
			break;

		case K_LEFTARROW:
			if ( gameoptions_cursor === 0 )
				break;
			if ( _S_LocalSound ) _S_LocalSound( 'misc/menu3.wav' );
			M_NetStart_Change( - 1 );
			break;

		case K_RIGHTARROW:
			if ( gameoptions_cursor === 0 )
				break;
			if ( _S_LocalSound ) _S_LocalSound( 'misc/menu3.wav' );
			M_NetStart_Change( 1 );
			break;

		case K_ENTER:
			if ( _S_LocalSound ) _S_LocalSound( 'misc/menu2.wav' );
			if ( gameoptions_cursor === 0 ) {

				// Begin game - create room on server first
				const mapName = M_StartLevel().name;

				// Create room on WebTransport server and connect as client
				if ( _WT_CreateRoom ) {

					// Check if WebTransport is available before attempting
					if ( typeof WebTransport === 'undefined' ) {

						alert( 'Multiplayer requires a browser with WebTransport support (Chrome 97+, Edge 97+, Firefox 114+, or Opera 83+).' );
						M_Menu_Main_f();
						return;

					}

					const params = new URLSearchParams( window.location.search );
					const serverUrl = params.get( 'server' ) || DEFAULT_WT_SERVER;

					if ( _SCR_BeginLoadingPlaque ) _SCR_BeginLoadingPlaque();

					_WT_CreateRoom( serverUrl, {
						map: mapName,
						maxPlayers: maxplayers,
						hostName: _cl_name ? _cl_name.string : 'Player'
					} ).then( ( room ) => {

						if ( room != null && typeof room.id === 'string' && room.id.length > 0 ) {

							let roomInfo = room.id;
							if ( room.port != null ) {

								roomInfo += ' on port ' + room.port;

							}

							Con_Printf( 'Room created: ' + roomInfo + '\n' );
							// Update browser URL so user can share it
							history.replaceState( null, '', Sys_PageURL( room.id ) );

							// Dismiss the menu before connecting (like original Quake)
							setKeyDest( key_game );
							m_state = m_none;

							// Connect to the remote server as a client (not local game)
							// The remote server is the authoritative game server
							let connectUrl;
							if ( room.port != null ) {

								// Connect directly to room server on its port
								const urlObj = new URL( serverUrl.replace( /^wt(s)?:\/\//, 'https://' ) );
								urlObj.port = String( room.port );
								// Remove trailing slash - URL.toString() adds one which breaks wts:// URLs
								connectUrl = urlObj.toString().replace( /\/$/, '' ).replace( /^https:\/\//, 'wts://' );

							} else {

								// Fallback: connect through lobby
								connectUrl = serverUrl + '?room=' + room.id;

							}

							Cbuf_AddText( 'connect "' + connectUrl + '"\n' );
							return;

						}

						Con_Printf( 'Failed to create room: Invalid room response from server\n' );
						if ( _SCR_EndLoadingPlaque ) _SCR_EndLoadingPlaque();

					} ).catch( ( e ) => {

						Con_Printf( 'Failed to create room: ' + e.message + '\n' );
						if ( _SCR_EndLoadingPlaque ) _SCR_EndLoadingPlaque();

					} );

					return;

				}

				// Fallback: no WebTransport - start local game
				if ( _sv.active )
					Cbuf_AddText( 'disconnect\n' );

				Cbuf_AddText( 'listen 0\n' );
				Cbuf_AddText( 'maxplayers ' + maxplayers + '\n' );

				if ( _SCR_BeginLoadingPlaque ) _SCR_BeginLoadingPlaque();

				Cbuf_AddText( 'map ' + mapName + '\n' );
				return;

			}

			M_NetStart_Change( 1 );
			break;

	}

}

/*
==============================================================================

			OPTIONS MENU HELPERS

==============================================================================
*/

const SLIDER_RANGE = 10;

function M_DrawSlider( x, y, range ) {

	if ( range < 0 )
		range = 0;
	if ( range > 1 )
		range = 1;

	M_DrawCharacter( x - 8, y, 128 );
	for ( let i = 0; i < SLIDER_RANGE; i ++ )
		M_DrawCharacter( x + i * 8, y, 129 );
	M_DrawCharacter( x + SLIDER_RANGE * 8, y, 130 );
	M_DrawCharacter( x + Math.floor( ( SLIDER_RANGE - 1 ) * 8 * range ), y, 131 );

}

function M_DrawCheckbox( x, y, on ) {

	if ( on )
		M_Print( x, y, 'on' );
	else
		M_Print( x, y, 'off' );

}

function M_AdjustSliders( dir ) {

	if ( _S_LocalSound ) _S_LocalSound( 'misc/menu3.wav' );

	switch ( m_options_cursor ) {

		case 3: // texture filtering
			Cvar_SetValue( 'gl_texturemode', ! gl_texturemode.value ? 1 : 0 );
			GL_UpdateTextureFiltering();
			break;

		case 4: // screen size
			Cvar_SetValue( 'viewsize', scr_viewsize.value + dir * 10 );
			if ( scr_viewsize.value < 30 )
				Cvar_SetValue( 'viewsize', 30 );
			if ( scr_viewsize.value > 120 )
				Cvar_SetValue( 'viewsize', 120 );
			break;

		case 5: // gamma
			Cvar_SetValue( 'gamma', v_gamma.value - dir * 0.05 );
			if ( v_gamma.value < 0.5 )
				Cvar_SetValue( 'gamma', 0.5 );
			if ( v_gamma.value > 1 )
				Cvar_SetValue( 'gamma', 1 );
			break;

		case 6: // mouse speed
			Cvar_SetValue( 'sensitivity', sensitivity.value + dir * 0.5 );
			if ( sensitivity.value < 1 )
				Cvar_SetValue( 'sensitivity', 1 );
			if ( sensitivity.value > 11 )
				Cvar_SetValue( 'sensitivity', 11 );
			break;

		case 7: // music volume
			Cvar_SetValue( 'bgmvolume', bgmvolume.value + dir * 0.1 );
			if ( bgmvolume.value < 0 )
				Cvar_SetValue( 'bgmvolume', 0 );
			if ( bgmvolume.value > 1 )
				Cvar_SetValue( 'bgmvolume', 1 );
			break;

		case 8: // sfx volume
			Cvar_SetValue( 'volume', volume.value + dir * 0.1 );
			if ( volume.value < 0 )
				Cvar_SetValue( 'volume', 0 );
			if ( volume.value > 1 )
				Cvar_SetValue( 'volume', 1 );
			break;

		case 9: // always run
			if ( cl_forwardspeed.value > 200 ) {

				Cvar_SetValue( 'cl_forwardspeed', 200 );
				Cvar_SetValue( 'cl_backspeed', 200 );

			} else {

				Cvar_SetValue( 'cl_forwardspeed', 400 );
				Cvar_SetValue( 'cl_backspeed', 400 );

			}

			break;

		case 10: // invert mouse
			Cvar_SetValue( 'm_pitch', - m_pitch.value );
			break;

		case 11: // lookspring
			Cvar_SetValue( 'lookspring', ! lookspring.value ? 1 : 0 );
			break;

		case 12: // lookstrafe
			Cvar_SetValue( 'lookstrafe', ! lookstrafe.value ? 1 : 0 );
			break;

		case 13: // crosshair
			Cvar_SetValue( 'crosshair', Cvar_VariableValue( 'crosshair' ) !== 0 ? 0 : 1 );
			break;

	}

}

/*
==============================================================================

			OPTIONS MENU

==============================================================================
*/

const OPTIONS_ITEMS = 15;
let m_options_cursor = 0;

function M_Menu_Options_f() {

	setKeyDest( key_menu );
	m_state = m_options;
	m_entersound = true;

}

function M_Options_Draw() {

	if ( ! _Draw_CachePic ) return;

	M_DrawTransPic( 16, 4, _Draw_CachePic( 'gfx/qplaque.lmp' ) );
	const p = _Draw_CachePic( 'gfx/p_option.lmp' );
	M_DrawPic( ( 320 - ( p ? p.width : 0 ) ) / 2, 4, p );

	M_Print( 16, 32, '    Customize controls' );
	M_Print( 16, 40, '         Go to console' );
	M_Print( 16, 48, '     Reset to defaults' );

	M_Print( 16, 56, '     Texture Filtering' );
	M_DrawCheckbox( 220, 56, gl_texturemode.value );

	M_Print( 16, 64, '           Screen size' );
	let r = ( scr_viewsize.value - 30 ) / ( 120 - 30 );
	M_DrawSlider( 220, 64, r );

	M_Print( 16, 72, '            Brightness' );
	r = ( 1.0 - v_gamma.value ) / 0.5;
	M_DrawSlider( 220, 72, r );

	M_Print( 16, 80, '           Mouse Speed' );
	r = ( sensitivity.value - 1 ) / 10;
	M_DrawSlider( 220, 80, r );

	M_Print( 16, 88, '       CD Music Volume' );
	r = bgmvolume.value;
	M_DrawSlider( 220, 88, r );

	M_Print( 16, 96, '          Sound Volume' );
	r = volume.value;
	M_DrawSlider( 220, 96, r );

	M_Print( 16, 104, '            Always Run' );
	M_DrawCheckbox( 220, 104, cl_forwardspeed.value > 200 );

	M_Print( 16, 112, '          Invert Mouse' );
	M_DrawCheckbox( 220, 112, m_pitch.value < 0 );

	M_Print( 16, 120, '            Lookspring' );
	M_DrawCheckbox( 220, 120, lookspring.value );

	M_Print( 16, 128, '            Lookstrafe' );
	M_DrawCheckbox( 220, 128, lookstrafe.value );

	M_Print( 16, 136, '             Crosshair' );
	M_DrawCheckbox( 220, 136, Cvar_VariableValue( 'crosshair' ) );

	M_Print( 16, 144, '        Touch controls' );

	// cursor
	M_DrawCharacter( 200, 32 + m_options_cursor * 8, 12 + ( ( Math.floor( _realtime_get() * 4 ) ) & 1 ) );

}

function M_Options_Key( key ) {

	switch ( key ) {

		case K_ESCAPE:
			M_Menu_Main_f();
			break;
		case K_ENTER:
			m_entersound = true;
			switch ( m_options_cursor ) {

				case 0:
					M_Menu_Keys_f();
					break;
				case 1:
					m_state = m_none;
					Con_ToggleConsole_f();
					break;
				case 14:
					M_Menu_Touch_f();
					break;
				case 2:
					Cbuf_AddText( 'exec default.cfg\n' );
					// Re-apply WASD bindings for the web port
					Cbuf_AddText( 'bind w +forward\n' );
					Cbuf_AddText( 'bind s +back\n' );
					Cbuf_AddText( 'bind a +moveleft\n' );
					Cbuf_AddText( 'bind d +moveright\n' );
					Cbuf_AddText( 'bind SPACE +jump\n' );
					Cbuf_AddText( 'bind MOUSE1 +attack\n' );
					Cbuf_AddText( 'cl_forwardspeed 400\n' );
					Cbuf_AddText( 'cl_backspeed 400\n' );
					Cbuf_AddText( 'gamma 1\n' );
					Cbuf_AddText( 'volume 0.7\n' );
					break;
				default:
					M_AdjustSliders( 1 );
					break;

			}

			break;
		case K_UPARROW:
			if ( _S_LocalSound ) _S_LocalSound( 'misc/menu1.wav' );
			m_options_cursor --;
			if ( m_options_cursor < 0 )
				m_options_cursor = OPTIONS_ITEMS - 1;
			break;
		case K_DOWNARROW:
			if ( _S_LocalSound ) _S_LocalSound( 'misc/menu1.wav' );
			m_options_cursor ++;
			if ( m_options_cursor >= OPTIONS_ITEMS )
				m_options_cursor = 0;
			break;
		case K_LEFTARROW:
			M_AdjustSliders( - 1 );
			break;
		case K_RIGHTARROW:
			M_AdjustSliders( 1 );
			break;

	}

}

/*
==============================================================================

			TOUCH CONTROLS MENU

==============================================================================
*/

// Sliders: cvar, range and step. Toggles: cvar flipped between 0 and 1, or
// get/set for settings stored another way.
const touchItems = [
	{ label: '            Look Speed', cvar: 'touch_sensitivity', min: 0.25, max: 3, step: 0.25 },
	{ label: '           Gyro Aiming', cvar: 'touch_gyro' },
	{ label: '            Gyro Speed', cvar: 'touch_gyro_sensitivity', min: 0.25, max: 3, step: 0.25 },
	{ label: '           Invert Look', get: () => m_pitch.value < 0, set: () => Cvar_SetValue( 'm_pitch', - m_pitch.value ) },
	{ label: '           Left-Handed', cvar: 'touch_lefthanded' },
	{ label: '           Button Size', cvar: 'touch_size', min: 0.6, max: 1.6, step: 0.1 },
	{ label: '        Button Opacity', cvar: 'touch_opacity', min: 0.2, max: 1, step: 0.1 },
	{ label: '             Vibration', cvar: 'touch_haptics' }
];
const TOUCH_ITEMS = touchItems.length;
const TOUCH_TOP = 48;
let m_touch_cursor = 0;

function M_Menu_Touch_f() {

	setKeyDest( key_menu );
	m_state = m_touch;
	m_entersound = true;

}

function M_TouchItem_IsSlider( item ) {

	return item.min !== undefined;

}

function M_TouchItem_Fraction( item ) {

	return ( Cvar_VariableValue( item.cvar ) - item.min ) / ( item.max - item.min );

}

// Set a slider to a fraction of its range, snapped to its step
function M_TouchItem_SetFraction( item, r ) {

	r = Math.min( Math.max( r, 0 ), 1 );
	const steps = Math.round( r * ( item.max - item.min ) / item.step );
	const v = item.min + steps * item.step;
	Cvar_SetValue( item.cvar, Math.round( v * 100 ) / 100 );

}

function M_TouchItem_Adjust( item, dir ) {

	if ( _S_LocalSound ) _S_LocalSound( 'misc/menu3.wav' );

	if ( M_TouchItem_IsSlider( item ) ) {

		const v = Cvar_VariableValue( item.cvar ) + dir * item.step;
		M_TouchItem_SetFraction( item, ( v - item.min ) / ( item.max - item.min ) );

	} else if ( item.set ) {

		item.set();

	} else {

		Cvar_SetValue( item.cvar, Cvar_VariableValue( item.cvar ) ? 0 : 1 );

	}

}

function M_Touch_Draw() {

	if ( ! _Draw_CachePic ) return;

	M_DrawTransPic( 16, 4, _Draw_CachePic( 'gfx/qplaque.lmp' ) );
	const p = _Draw_CachePic( 'gfx/p_option.lmp' );
	M_DrawPic( ( 320 - ( p ? p.width : 0 ) ) / 2, 4, p );

	M_PrintWhite( 112, 32, 'Touch Controls' );

	for ( let i = 0; i < TOUCH_ITEMS; i ++ ) {

		const item = touchItems[ i ];
		const y = TOUCH_TOP + i * 8;
		M_Print( 16, y, item.label );

		if ( M_TouchItem_IsSlider( item ) )
			M_DrawSlider( 220, y, M_TouchItem_Fraction( item ) );
		else
			M_DrawCheckbox( 220, y, item.get ? item.get() : Cvar_VariableValue( item.cvar ) );

	}

	M_DrawCharacter( 200, TOUCH_TOP + m_touch_cursor * 8, 12 + ( ( Math.floor( _realtime_get() * 4 ) ) & 1 ) );

}

function M_Touch_Key( key ) {

	switch ( key ) {

		case K_ESCAPE:
			M_Menu_Options_f();
			break;
		case K_ENTER:
			m_entersound = true;
			M_TouchItem_Adjust( touchItems[ m_touch_cursor ], 1 );
			break;
		case K_UPARROW:
			if ( _S_LocalSound ) _S_LocalSound( 'misc/menu1.wav' );
			m_touch_cursor = ( m_touch_cursor + TOUCH_ITEMS - 1 ) % TOUCH_ITEMS;
			break;
		case K_DOWNARROW:
			if ( _S_LocalSound ) _S_LocalSound( 'misc/menu1.wav' );
			m_touch_cursor = ( m_touch_cursor + 1 ) % TOUCH_ITEMS;
			break;
		case K_LEFTARROW:
			M_TouchItem_Adjust( touchItems[ m_touch_cursor ], - 1 );
			break;
		case K_RIGHTARROW:
			M_TouchItem_Adjust( touchItems[ m_touch_cursor ], 1 );
			break;

	}

}

/*
==============================================================================

			KEYS MENU (key binding)

==============================================================================
*/

let m_keys_cursor = 0;
let bind_grab = false;

const bindnames = [
	[ '+attack', 'attack' ],
	[ 'impulse 10', 'change weapon' ],
	[ '+jump', 'jump / swim up' ],
	[ '+forward', 'walk forward' ],
	[ '+back', 'backpedal' ],
	[ '+left', 'turn left' ],
	[ '+right', 'turn right' ],
	[ '+speed', 'run' ],
	[ '+moveleft', 'step left' ],
	[ '+moveright', 'step right' ],
	[ '+strafe', 'sidestep' ],
	[ '+lookup', 'look up' ],
	[ '+lookdown', 'look down' ],
	[ 'centerview', 'center view' ],
	[ '+mlook', 'mouse look' ],
	[ '+klook', 'keyboard look' ],
	[ '+moveup', 'swim up' ],
	[ '+movedown', 'swim down' ],
];

const NUMCOMMANDS = bindnames.length;

/*
===============
M_FindKeysForCommand

Finds up to two keys bound to a command
===============
*/
function M_FindKeysForCommand( command ) {

	const twokeys = [ - 1, - 1 ];
	const l = command.length;
	let count = 0;

	for ( let j = 0; j < 256; j ++ ) {

		const b = keybindings[ j ];
		if ( b == null )
			continue;
		if ( b.substring( 0, l ) === command ) {

			twokeys[ count ] = j;
			count ++;
			if ( count === 2 )
				break;

		}

	}

	return twokeys;

}

/*
===============
M_UnbindCommand

Unbinds all keys for a command
===============
*/
function M_UnbindCommand( command ) {

	const l = command.length;

	for ( let j = 0; j < 256; j ++ ) {

		const b = keybindings[ j ];
		if ( b == null )
			continue;
		if ( b.substring( 0, l ) === command )
			Key_SetBinding( j, '' );

	}

}

function M_Menu_Keys_f() {

	setKeyDest( key_menu );
	m_state = m_keys;
	m_entersound = true;

}

function M_Keys_Draw() {

	if ( ! _Draw_CachePic ) return;

	const p = _Draw_CachePic( 'gfx/ttl_cstm.lmp' );
	M_DrawPic( ( 320 - ( p ? p.width : 0 ) ) / 2, 4, p );

	if ( bind_grab )
		M_Print( 12, 32, 'Press a key or button for this action' );
	else
		M_Print( 18, 32, 'Enter to change, backspace to clear' );

	for ( let i = 0; i < NUMCOMMANDS; i ++ ) {

		const y = 48 + 8 * i;
		M_Print( 16, y, bindnames[ i ][ 1 ] );

		// Find keys bound to this command
		const keys = M_FindKeysForCommand( bindnames[ i ][ 0 ] );

		if ( keys[ 0 ] === - 1 ) {

			M_Print( 140, y, '???' );

		} else {

			const name = Key_KeynumToString( keys[ 0 ] );
			M_Print( 140, y, name );
			const x = name.length * 8;
			if ( keys[ 1 ] !== - 1 ) {

				M_Print( 140 + x + 8, y, 'or' );
				M_Print( 140 + x + 32, y, Key_KeynumToString( keys[ 1 ] ) );

			}

		}

	}

	// cursor
	if ( bind_grab ) {

		M_DrawCharacter( 130, 48 + m_keys_cursor * 8, 61 ); // '='

	} else {

		M_DrawCharacter( 130, 48 + m_keys_cursor * 8, 12 + ( ( Math.floor( _realtime_get() * 4 ) ) & 1 ) );

	}

}

function M_Keys_Key( key ) {

	if ( bind_grab ) {

		// Grabbed a key
		if ( _S_LocalSound ) _S_LocalSound( 'misc/menu1.wav' );
		if ( key === K_ESCAPE ) {

			bind_grab = false;

		} else if ( key !== 96 ) { // '`'

			// Set the binding via Cbuf
			Cbuf_AddText( 'bind "' + Key_KeynumToString( key ) + '" "' + bindnames[ m_keys_cursor ][ 0 ] + '"\n' );

		}

		bind_grab = false;
		return;

	}

	switch ( key ) {

		case K_ESCAPE:
			M_Menu_Options_f();
			break;
		case K_LEFTARROW:
		case K_UPARROW:
			if ( _S_LocalSound ) _S_LocalSound( 'misc/menu1.wav' );
			m_keys_cursor --;
			if ( m_keys_cursor < 0 )
				m_keys_cursor = NUMCOMMANDS - 1;
			break;
		case K_DOWNARROW:
		case K_RIGHTARROW:
			if ( _S_LocalSound ) _S_LocalSound( 'misc/menu1.wav' );
			m_keys_cursor ++;
			if ( m_keys_cursor >= NUMCOMMANDS )
				m_keys_cursor = 0;
			break;
		case K_ENTER: {

			const keys = M_FindKeysForCommand( bindnames[ m_keys_cursor ][ 0 ] );
			if ( _S_LocalSound ) _S_LocalSound( 'misc/menu2.wav' );
			if ( keys[ 1 ] !== - 1 )
				M_UnbindCommand( bindnames[ m_keys_cursor ][ 0 ] );
			bind_grab = true;
			break;

		}
		case K_BACKSPACE:
		case K_DEL:
			if ( _S_LocalSound ) _S_LocalSound( 'misc/menu2.wav' );
			M_UnbindCommand( bindnames[ m_keys_cursor ][ 0 ] );
			break;

	}

}

/*
==============================================================================

			SETUP MENU

==============================================================================
*/

let setup_cursor = 3;
const setup_cursor_table = [ 40, 64, 88, 124 ];
let setup_myname = 'player';
let setup_oldtop = 0;
let setup_oldbottom = 0;
let setup_top = 0;
let setup_bottom = 0;
const NUM_SETUP_CMDS = 4;

function M_Menu_Setup_f() {

	setKeyDest( key_menu );
	m_state = m_setup;
	m_entersound = true;

	// Initialize from current values
	setup_myname = _cl_name ? _cl_name.string : 'player';
	setup_top = setup_oldtop = ( cl_color.value | 0 ) >> 4;
	setup_bottom = setup_oldbottom = ( cl_color.value | 0 ) & 15;

}

function M_Setup_Draw() {

	if ( ! _Draw_CachePic ) return;

	M_DrawTransPic( 16, 4, _Draw_CachePic( 'gfx/qplaque.lmp' ) );
	const p = _Draw_CachePic( 'gfx/p_multi.lmp' );
	M_DrawPic( ( 320 - ( p ? p.width : 0 ) ) / 2, 4, p );

	M_Print( 64, 40, 'Your name' );
	M_DrawTextBox( 160, 32, 16, 1 );
	M_Print( 168, 40, setup_myname );

	M_Print( 64, 64, 'Shirt color' );
	M_Print( 64, 88, 'Pants color' );

	M_DrawTextBox( 64, 116, 14, 1 );
	M_Print( 72, 124, 'Accept Changes' );

	// Draw player color preview (bigbox + menuplyr with color translation)
	const bigbox = _Draw_CachePic( 'gfx/bigbox.lmp' );
	M_DrawTransPic( 160, 48, bigbox );
	const menuplyr = _Draw_CachePic( 'gfx/menuplyr.lmp' );
	M_BuildTranslationTable( setup_top * 16, setup_bottom * 16 );
	M_DrawTransPicTranslate( 172, 56, menuplyr );

	M_DrawCharacter( 56, setup_cursor_table[ setup_cursor ], 12 + ( ( Math.floor( _realtime_get() * 4 ) ) & 1 ) );

	// Draw blinking cursor on text field
	if ( setup_cursor === 0 )
		M_DrawCharacter( 168 + 8 * setup_myname.length, setup_cursor_table[ setup_cursor ], 10 + ( ( Math.floor( _realtime_get() * 4 ) ) & 1 ) );

}

function M_Setup_Key( key ) {

	switch ( key ) {

		case K_ESCAPE:
			M_Menu_MultiPlayer_f();
			break;
		case K_UPARROW:
			if ( _S_LocalSound ) _S_LocalSound( 'misc/menu1.wav' );
			setup_cursor --;
			if ( setup_cursor < 0 )
				setup_cursor = NUM_SETUP_CMDS - 1;
			break;
		case K_DOWNARROW:
			if ( _S_LocalSound ) _S_LocalSound( 'misc/menu1.wav' );
			setup_cursor ++;
			if ( setup_cursor >= NUM_SETUP_CMDS )
				setup_cursor = 0;
			break;
		case K_LEFTARROW:
			if ( setup_cursor < 1 )
				return;
			if ( _S_LocalSound ) _S_LocalSound( 'misc/menu3.wav' );
			if ( setup_cursor === 1 )
				setup_top = setup_top - 1;
			if ( setup_cursor === 2 )
				setup_bottom = setup_bottom - 1;
			break;
		case K_RIGHTARROW:
			if ( setup_cursor < 1 )
				return;
			if ( _S_LocalSound ) _S_LocalSound( 'misc/menu3.wav' );
			if ( setup_cursor === 1 )
				setup_top = setup_top + 1;
			if ( setup_cursor === 2 )
				setup_bottom = setup_bottom + 1;
			break;
		case K_ENTER:
			if ( setup_cursor === 0 )
				return;

			if ( setup_cursor === 1 || setup_cursor === 2 ) {

				// ENTER on color items acts as RIGHT arrow (goto forward in C)
				if ( _S_LocalSound ) _S_LocalSound( 'misc/menu3.wav' );
				if ( setup_cursor === 1 )
					setup_top = setup_top + 1;
				if ( setup_cursor === 2 )
					setup_bottom = setup_bottom + 1;
				break;

			}

			// setup_cursor == 3 (Accept)
			Cbuf_AddText( 'name "' + setup_myname + '"\n' );
			if ( setup_top !== setup_oldtop || setup_bottom !== setup_oldbottom )
				Cbuf_AddText( 'color ' + setup_top + ' ' + setup_bottom + '\n' );
			m_entersound = true;
			M_Menu_MultiPlayer_f();

			break;

		case K_BACKSPACE:
			if ( setup_cursor === 0 ) {

				if ( setup_myname.length > 0 )
					setup_myname = setup_myname.substring( 0, setup_myname.length - 1 );

			}

			break;

		default:
			// Character input for text fields
			if ( key < 32 || key > 127 )
				break;

			if ( setup_cursor === 0 ) {

				if ( setup_myname.length < 15 )
					setup_myname = setup_myname + String.fromCharCode( key );

			}

			break;

	}

	if ( setup_top > 13 )
		setup_top = 0;
	if ( setup_top < 0 )
		setup_top = 13;
	if ( setup_bottom > 13 )
		setup_bottom = 0;
	if ( setup_bottom < 0 )
		setup_bottom = 13;

}

/*
==============================================================================

			CREDITS MENU

==============================================================================
*/

const CREDITS_SOURCE_URL = 'https://github.com/phughesmcr/icaro-engine';

function M_OpenCreditsSource() {

	if ( typeof window !== 'undefined' )
		window.open( CREDITS_SOURCE_URL, '_blank' );

}

function M_Menu_Credits_f() {

	setKeyDest( key_menu );
	m_state = m_credits;
	m_entersound = true;

}

function M_Credits_Draw() {

	M_DrawTextBox( 0, 0, 38, 23 );
	M_PrintWhite( 16, 12, '  Quake version 1.09 by id Software\n' );
	M_PrintWhite( 16, 28, 'Programming        Art \n' );
	M_Print( 16, 36, ' John Carmack       Adrian Carmack\n' );
	M_Print( 16, 44, ' Michael Abrash     Kevin Cloud\n' );
	M_Print( 16, 52, ' John Cash          Paul Steed\n' );
	M_Print( 16, 60, ' Dave \'Zoid\' Kirsch\n' );
	M_PrintWhite( 16, 76, 'Design             Biz\n' );
	M_Print( 16, 84, ' John Romero        Jay Wilbur\n' );
	M_Print( 16, 92, ' Sandy Petersen     Mike Wilson\n' );
	M_Print( 16, 100, ' American McGee     Donna Jackson\n' );
	M_Print( 16, 108, ' Tim Willits        Todd Hollenshead\n' );
	M_PrintWhite( 16, 124, 'Support            Id Mom\n' );
	M_Print( 16, 132, ' Barrett Alexander  Shawn Green\n' );
	M_PrintWhite( 16, 148, 'Icaro Engine (Three.js port)\n' );
	M_Print( 16, 156, ' Based on three-quake by mrdoob\n' );
	M_PrintWhite( 16, 172, 'Source code\n' );
	M_Print( 16, 180, ' github.com/phughesmcr/icaro-engine\n' );

}

function M_Credits_Key( key ) {

	switch ( key ) {

		case K_ESCAPE:
			M_Menu_Main_f();
			break;
		case K_ENTER:
			M_OpenCreditsSource();
			break;

	}

}

function M_Credits_Touch( vx, vy ) {

	if ( vy >= 172 ) {

		M_OpenCreditsSource();
		return;

	}

	M_Credits_Key( K_ESCAPE );

}

/*
==============================================================================

			QUIT MENU

==============================================================================
*/

function M_Menu_Quit_f() {

	setKeyDest( key_menu );
	m_state = m_quit;
	m_entersound = true;

}

function M_Quit_Draw() {

	M_DrawTextBox( 56, 76, 24, 4 );
	M_Print( 64, 84, '  Are you sure you want' );
	M_Print( 64, 92, '  to quit? (Y/N)' );

}

function M_Quit_Key( key ) {

	switch ( key ) {

		case K_ESCAPE:
		case 110: // 'n'
		case 78: // 'N'
			M_Menu_Main_f();
			break;

		case 121: // 'y'
		case 89: // 'Y'
			M_Menu_Main_f();
			break;

	}

}

/*
==============================================================================

			VIDEO MENU (stub)

==============================================================================
*/

function M_Menu_Video_f() {

	setKeyDest( key_menu );
	m_state = m_video;
	m_entersound = true;

}

function M_Video_Draw() {

	M_Print( 16, 32, 'Video settings not available in browser' );

}

function M_Video_Key( key ) {

	if ( key === K_ESCAPE )
		M_Menu_Options_f();

}

/*
==============================================================================

			PUBLIC API

==============================================================================
*/

/*
================
M_Init
================
*/
export function M_Init() {

	// menu.c starts at the first episode; this port's own default (the
	// community deathmatch maps) is in the id1 list only
	if ( standard_quake === false ) {

		startepisode = 0;
		startlevel = 0;

	}

	Cmd_AddCommand( 'togglemenu', M_ToggleMenu_f );
	Cmd_AddCommand( 'menu_main', M_Menu_Main_f );
	Cmd_AddCommand( 'menu_singleplayer', M_Menu_SinglePlayer_f );
	Cmd_AddCommand( 'menu_load', M_Menu_Load_f );
	Cmd_AddCommand( 'menu_save', M_Menu_Save_f );
	Cmd_AddCommand( 'menu_multiplayer', M_Menu_MultiPlayer_f );
	Cmd_AddCommand( 'menu_setup', M_Menu_Setup_f );
	Cmd_AddCommand( 'menu_options', M_Menu_Options_f );
	Cmd_AddCommand( 'menu_keys', M_Menu_Keys_f );
	Cmd_AddCommand( 'menu_video', M_Menu_Video_f );
	Cmd_AddCommand( 'help', M_Menu_Credits_f );
	Cmd_AddCommand( 'menu_credits', M_Menu_Credits_f );
	Cmd_AddCommand( 'menu_quit', M_Menu_Quit_f );
	Cmd_AddCommand( 'menu_lanconfig', M_Menu_LanConfig_f );
	Cmd_AddCommand( 'menu_gameoptions', M_Menu_GameOptions_f );

}

/*
================
M_Keydown
================
*/
export function M_Keydown( key ) {

	switch ( m_state ) {

		case m_none: return;
		case m_main: M_Main_Key( key ); return;
		case m_singleplayer: M_SinglePlayer_Key( key ); return;
		case m_load: M_Load_Key( key ); return;
		case m_save: M_Save_Key( key ); return;
		case m_multiplayer: M_MultiPlayer_Key( key ); return;
		case m_setup: M_Setup_Key( key ); return;
		case m_options: M_Options_Key( key ); return;
		case m_keys: M_Keys_Key( key ); return;
		case m_video: M_Video_Key( key ); return;
		case m_credits: M_Credits_Key( key ); return;
		case m_quit: M_Quit_Key( key ); return;
		case m_lanconfig: M_LanConfig_Key( key ); return;
		case m_gameoptions: M_GameOptions_Key( key ); return;
		case m_touch: M_Touch_Key( key ); return;
		default: return;

	}

}

/*
================
M_Draw
================
*/
export function M_Draw() {

	if ( m_state === m_none || getKeyDest() !== key_menu )
		return;

	if ( ! m_recursiveDraw ) {

		if ( scr_con_current ) {

			if ( _Draw_ConsoleBackground ) _Draw_ConsoleBackground( _vid.height );

		} else {

			if ( _Draw_FadeScreen ) _Draw_FadeScreen();

		}

	} else {

		m_recursiveDraw = false;

	}

	switch ( m_state ) {

		case m_main: M_Main_Draw(); break;
		case m_singleplayer: M_SinglePlayer_Draw(); break;
		case m_load: M_Load_Draw(); break;
		case m_save: M_Save_Draw(); break;
		case m_multiplayer: M_MultiPlayer_Draw(); break;
		case m_setup: M_Setup_Draw(); break;
		case m_options: M_Options_Draw(); break;
		case m_keys: M_Keys_Draw(); break;
		case m_video: M_Video_Draw(); break;
		case m_credits: M_Credits_Draw(); break;
		case m_quit: M_Quit_Draw(); break;
		case m_lanconfig: M_LanConfig_Draw(); break;
		case m_gameoptions: M_GameOptions_Draw(); break;
		case m_touch: M_Touch_Draw(); break;

	}

	if ( m_entersound ) {

		if ( _S_LocalSound ) _S_LocalSound( 'misc/menu2.wav' );
		m_entersound = false;

	}

}

/*
================
M_TouchInput

Handle touch input for menu selection.
Converts screen coordinates to virtual 320x200 space and selects menu items.
================
*/
export function M_TouchInput( touchX, touchY, screenWidth, screenHeight ) {

	// If no menu is shown (e.g. during demo playback), show the menu
	if ( m_state === m_none ) {

		M_ToggleMenu_f();
		return;

	}

	// Convert screen/element coordinates to _vid space (menu drawing coordinates)
	// screenWidth/Height are the CSS dimensions of the element clicked on
	// _vid is the logical rendering size the menu uses

	// Map click position proportionally from element space to _vid space
	const vidX = ( touchX / screenWidth ) * _vid.width;
	const vidY = ( touchY / screenHeight ) * _vid.height;

	// Menu is drawn centered: drawing X = menuX + (_vid.width - 320) / 2
	//                         drawing Y = menuY + (_vid.height - 200) / 2
	// So to convert click to menu space: menuX = vidX - offsetX, menuY = vidY - offsetY
	const offsetX = ( _vid.width - 320 ) / 2;
	const offsetY = ( _vid.height - 200 ) / 2;
	const vx = vidX - offsetX;
	const vy = vidY - offsetY;

	// SCR_ModalMessage is up: no Y key on touch, so tap top half for yes and
	// bottom half for no, as the quit menu does. Taps right after the dialog
	// opens are ignored, so a double click on "New Game" can't confirm it.
	if ( Key_ModalActive() ) {

		if ( _realtime_get() - m_modal_time < MODAL_TOUCH_DELAY )
			return;

		const k = vy < 100 ? 121 : 110; // 'y' : 'n'
		Key_Event( k, true );
		Key_Event( k, false );
		return;

	}

	// Click outside menu area acts like pressing escape (go back)
	if ( vx < 0 || vx > 320 || vy < 0 || vy > 200 ) {

		M_Keydown( K_ESCAPE );
		return;

	}

	// Handle based on current menu state
	switch ( m_state ) {

		case m_main:
			M_Main_Touch( vx, vy );
			break;

		case m_singleplayer:
			M_SinglePlayer_Touch( vx, vy );
			break;

		case m_load:
		case m_save:
			M_LoadSave_Touch( vx, vy );
			break;

		case m_multiplayer:
			M_MultiPlayer_Touch( vx, vy );
			break;

		case m_options:
			M_Options_Touch( vx, vy );
			break;

		case m_keys:
			M_Keys_Touch( vx, vy );
			break;

		case m_credits:
			M_Credits_Touch( vx, vy );
			break;

		case m_quit:
			M_Quit_Touch( vx, vy );
			break;

		case m_lanconfig:
			M_LanConfig_Touch( vx, vy );
			break;

		case m_gameoptions:
			M_GameOptions_Touch( vx, vy );
			break;

		case m_setup:
			M_Setup_Touch( vx, vy );
			break;

		case m_touch:
			M_Touch_Touch( vx, vy );
			break;

	}

}

// Main menu touch - items at y=32, 20px spacing
function M_Main_Touch( vx, vy ) {

	const inGame = M_InGame();
	const itemCount = inGame ? MAIN_ITEMS + 1 : MAIN_ITEMS;

	// Menu items start at y=32, each item is ~20px tall
	if ( vy >= 32 && vy < 32 + itemCount * 20 ) {

		const item = Math.floor( ( vy - 32 ) / 20 );
		if ( item >= 0 && item < itemCount ) {

			m_main_cursor = item;
			M_Main_Key( K_ENTER );

		}

	}

}

// Single player menu touch
function M_SinglePlayer_Touch( vx, vy ) {

	if ( vy >= 32 && vy < 32 + SINGLEPLAYER_ITEMS * 20 ) {

		const item = Math.floor( ( vy - 32 ) / 20 );
		if ( item >= 0 && item < SINGLEPLAYER_ITEMS ) {

			m_singleplayer_cursor = item;
			M_SinglePlayer_Key( K_ENTER );

		}

	}

}

// Load/Save menu touch - items at y=32, 8px spacing
function M_LoadSave_Touch( vx, vy ) {

	if ( vy >= 32 && vy < 32 + MAX_SAVEGAMES * 8 ) {

		const item = Math.floor( ( vy - 32 ) / 8 );
		if ( item >= 0 && item < MAX_SAVEGAMES ) {

			load_cursor = item;
			if ( m_state === m_load )
				M_Load_Key( K_ENTER );
			else
				M_Save_Key( K_ENTER );

		}

	}

}

// Multiplayer menu touch
function M_MultiPlayer_Touch( vx, vy ) {

	if ( vy >= 32 && vy < 32 + MULTIPLAYER_ITEMS * 20 ) {

		const item = Math.floor( ( vy - 32 ) / 20 );
		if ( item >= 0 && item < MULTIPLAYER_ITEMS ) {

			m_multiplayer_cursor = item;
			M_MultiPlayer_Key( K_ENTER );

		}

	}

}

// Options menu touch - items at y=32, 8px spacing
function M_Options_Touch( vx, vy ) {

	if ( vy >= 32 && vy < 32 + OPTIONS_ITEMS * 8 ) {

		const item = Math.floor( ( vy - 32 ) / 8 );
		if ( item >= 0 && item < OPTIONS_ITEMS ) {

			m_options_cursor = item;

			// Tapping on a slider sets it there (Enter only ever raises it)
			if ( item >= 4 && item <= 8 && vx >= SLIDER_TAP_LEFT ) {

				M_Options_SetSlider( item, M_SliderTapFraction( vx ) );
				return;

			}

			M_Options_Key( K_ENTER );

		}

	}

}

// Sliders are drawn at x=220 (end caps at 212 and 300); the thumb moves over
// 72px. Taps from the left cap on map to a position along it.
const SLIDER_TAP_LEFT = 208;

function M_SliderTapFraction( vx ) {

	return Math.min( Math.max( ( vx - 220 ) / ( ( SLIDER_RANGE - 1 ) * 8 ), 0 ), 1 );

}

// Set an Options slider (rows 4 to 8) from a fraction of its range
function M_Options_SetSlider( item, r ) {

	if ( _S_LocalSound ) _S_LocalSound( 'misc/menu3.wav' );

	switch ( item ) {

		case 4: // screen size, 30 to 120 in steps of 10
			Cvar_SetValue( 'viewsize', 30 + Math.round( r * 9 ) * 10 );
			break;
		case 5: // gamma, 1 (dark) to 0.5 (bright)
			Cvar_SetValue( 'gamma', Math.round( ( 1 - r * 0.5 ) * 20 ) / 20 );
			break;
		case 6: // mouse speed, 1 to 11 in steps of 0.5
			Cvar_SetValue( 'sensitivity', 1 + Math.round( r * 20 ) / 2 );
			break;
		case 7: // music volume
			Cvar_SetValue( 'bgmvolume', Math.round( r * 10 ) / 10 );
			break;
		case 8: // sound volume
			Cvar_SetValue( 'volume', Math.round( r * 10 ) / 10 );
			break;

	}

}

// Touch Controls menu touch - items at TOUCH_TOP, 8px spacing
function M_Touch_Touch( vx, vy ) {

	if ( vy < TOUCH_TOP || vy >= TOUCH_TOP + TOUCH_ITEMS * 8 ) return;

	const i = Math.floor( ( vy - TOUCH_TOP ) / 8 );
	const item = touchItems[ i ];
	m_touch_cursor = i;

	if ( M_TouchItem_IsSlider( item ) && vx >= SLIDER_TAP_LEFT ) {

		if ( _S_LocalSound ) _S_LocalSound( 'misc/menu3.wav' );
		M_TouchItem_SetFraction( item, M_SliderTapFraction( vx ) );

	} else {

		M_Touch_Key( K_ENTER );

	}

}

// Setup menu touch - rows from setup_cursor_table. The name row only takes
// the cursor: type with the on-screen keyboard button.
function M_Setup_Touch( vx, vy ) {

	for ( let i = 0; i < NUM_SETUP_CMDS; i ++ ) {

		if ( vy >= setup_cursor_table[ i ] - 4 && vy < setup_cursor_table[ i ] + 12 ) {

			setup_cursor = i;
			M_Setup_Key( K_ENTER );
			return;

		}

	}

}

// Keys menu touch - items at y=48, 8px spacing
function M_Keys_Touch( vx, vy ) {

	if ( vy >= 48 && vy < 48 + NUMCOMMANDS * 8 ) {

		const item = Math.floor( ( vy - 48 ) / 8 );
		if ( item >= 0 && item < NUMCOMMANDS ) {

			m_keys_cursor = item;
			M_Keys_Key( K_ENTER );

		}

	}

}

// Quit menu touch - tap top half for yes, bottom half for no
function M_Quit_Touch( vx, vy ) {

	if ( vy < 100 ) {

		M_Quit_Key( 121 ); // 'y'

	} else {

		M_Quit_Key( 110 ); // 'n'

	}

}

// LAN Config touch - handle room list selection
function M_LanConfig_Touch( vx, vy ) {

	// Room list starts at y=52 with 12px spacing
	if ( slist_rooms.length > 0 && vy >= 52 && vy < 52 + slist_rooms.length * 12 ) {

		const item = Math.floor( ( vy - 52 ) / 12 );
		if ( item >= 0 && item < slist_rooms.length ) {

			slist_cursor = item;
			M_LanConfig_Key( K_ENTER );

		}

	}

}

// Game Options touch - handle all options
function M_GameOptions_Touch( vx, vy ) {

	// Find which row was touched based on cursor table
	for ( let i = 0; i < NUM_GAMEOPTIONS; i ++ ) {

		if ( vy >= gameoptions_cursor_table[ i ] - 4 && vy < gameoptions_cursor_table[ i ] + 12 ) {

			gameoptions_cursor = i;
			M_GameOptions_Key( K_ENTER );
			return;

		}

	}

}
