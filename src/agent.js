// Icaro Engine: agent interface
// Web-only addition with no C counterpart. It lets an LLM agent or an RL
// harness play: compact text observations, an event log, held buttons and
// look deltas, and a lockstep clock so the game only advances when the agent
// steps it. The design is in docs/agent-interface.md. main.js exposes it as
// window.icaro. Nothing here touches window or document at import time.

import { cl, cls, cl_entities, SIGNONS, ca_connected } from './client.js';
import { STAT_HEALTH, STAT_ARMOR, STAT_AMMO, STAT_SHELLS, STAT_NAILS, STAT_ROCKETS, STAT_CELLS,
	STAT_ACTIVEWEAPON, STAT_TOTALSECRETS, STAT_TOTALMONSTERS, STAT_SECRETS, STAT_MONSTERS,
	IT_SHOTGUN, IT_SUPER_SHOTGUN, IT_NAILGUN, IT_SUPER_NAILGUN, IT_GRENADE_LAUNCHER,
	IT_ROCKET_LAUNCHER, IT_LIGHTNING, IT_AXE, IT_ARMOR1, IT_ARMOR2, IT_ARMOR3, IT_KEY1, IT_KEY2,
	IT_INVISIBILITY, IT_INVULNERABILITY, IT_SUIT, IT_QUAD, PITCH, YAW } from './quakedef.js';
import { Cbuf_AddText, Cbuf_Execute, Cmd_ExecuteString, src_command } from './cmd.js';
import { Cvar_FindVar } from './cvar.js';
import { IN_SetAgentDriven } from './in_web.js';
import { Host_Frame } from './host.js';
import { Con_SetAgentHook } from './console.js';
import { SCR_SetAgentHook, SCR_UpdateScreen } from './gl_screen.js';
import { M_AgentState, m_none, m_main, m_singleplayer, m_multiplayer, m_quit, m_load, m_save,
	m_options, m_keys, m_setup, m_net, m_gameoptions, m_slist, m_help, m_credits, m_lanconfig,
	m_video, m_touch, m_advanced, m_advpage, m_search } from './menu.js';
import { Key_Event, key_dest, key_console, key_menu, key_message,
	K_ENTER, K_ESCAPE, K_UPARROW, K_DOWNARROW, K_LEFTARROW, K_RIGHTARROW, K_TAB, K_BACKSPACE } from './keys.js';
import { sv } from './server.js';
import { PR_GetString, pr_globals_int } from './progs.js';
import { SV_RecursiveHullCheck, trace_t } from './world.js';
import { CL_ClampPitch } from './cl_input.js';

export const AGENT_TIC = 1 / 72; // one step tic: host_maxfps's default frame

/*
==============================================================================

	STATE

==============================================================================
*/

let agent_mode = 'off'; // 'off' | 'realtime' | 'lockstep'
let agent_tics = 0; // tics stepped in lockstep since attach

// Event log: a ring of short text lines with sequence numbers
const EVENT_MAX = 256;
const agent_events = new Array( EVENT_MAX ).fill( '' );
let event_seq = 0; // number of events ever pushed
let event_read = 0; // first event not yet returned by Agent_Observe
let con_partial = ''; // console text since the last newline

// Previous values, for the stat-change events
const prev_stats = new Int32Array( 32 );
let prev_items = 0;
let prev_map = '';
let prev_intermission = 0;
let prev_valid = false;

// Buttons held for the current step (names from AGENT_BUTTONS)
const held_buttons = new Set();
const AGENT_KEYNUM = '4095'; // a key number no real key uses, so KeyUp matches our KeyDown

// cvars that lockstep pins, with the values to restore on detach
const LOCKSTEP_CVARS = [ [ 'host_framerate', String( AGENT_TIC ) ], [ 'host_timescale', '0' ], [ 'host_maxfps', '72' ] ];
const saved_cvars = new Map();

/*
==============================================================================

	TABLES

==============================================================================
*/

// Action button names to the client's +/- commands
export const AGENT_BUTTONS = {
	forward: 'forward', back: 'back', moveleft: 'moveleft', moveright: 'moveright',
	left: 'left', right: 'right', lookup: 'lookup', lookdown: 'lookdown',
	jump: 'jump', attack: 'attack', speed: 'speed', up: 'moveup', down: 'movedown',
	strafe: 'strafe', use: 'use'
};

// Model names (without progs/ or maps/ and the extension) to short kinds.
// id1 only; anything else reports its file name.
const MODEL_KINDS = {
	soldier: 'grunt', dog: 'dog', ogre: 'ogre', knight: 'knight', hknight: 'death_knight',
	demon: 'fiend', shambler: 'shambler', zombie: 'zombie', wizard: 'scrag', fish: 'fish',
	shalrath: 'vore', enforcer: 'enforcer', tarbaby: 'spawn', oldone: 'shub', boss: 'chthon',
	player: 'player',
	backpack: 'backpack', g_shot: 'super_shotgun', g_nail: 'nailgun', g_nail2: 'super_nailgun',
	g_rock: 'grenade_launcher', g_rock2: 'rocket_launcher', g_light: 'thunderbolt',
	quaddama: 'quad', invulner: 'pentagram', suit: 'biosuit', invisibl: 'ring',
	w_g_key: 'gold_key', m_g_key: 'gold_key', b_g_key: 'gold_key',
	w_s_key: 'silver_key', m_s_key: 'silver_key', b_s_key: 'silver_key',
	end1: 'rune', end2: 'rune', end3: 'rune', end4: 'rune',
	b_shell0: 'shells', b_shell1: 'shells_big', b_nail0: 'nails', b_nail1: 'nails_big',
	b_rock0: 'rockets', b_rock1: 'rockets_big', b_batt0: 'cells', b_batt1: 'cells_big',
	b_bh10: 'health_small', b_bh25: 'health', b_bh100: 'megahealth',
	b_explob: 'explobox', b_exbox2: 'explobox',
	missile: 'rocket_proj', grenade: 'grenade_proj', spike: 'nail_proj', s_spike: 'nail_proj',
	laser: 'laser_proj', k_spike: 'knight_proj', w_spike: 'scrag_proj', v_spike: 'vore_proj',
	zom_gib: 'zombie_gib_proj', lavaball: 'lavaball'
};
const FL_MONSTER = 32; // server.h

const ARMOR_SKINS = [ 'green_armor', 'yellow_armor', 'red_armor' ];

// Models never worth listing: gibs, heads, sprites, the view model
const SKIP_MODEL = /^(gib[0-9]|h_|v_|s_|bubble|flame|lavaball_sm)/;

// Brush entity classnames (server truth) to kinds; others are skipped
const BRUSH_KINDS = {
	func_door: 'door', func_door_secret: 'secret_door', func_button: 'button',
	func_plat: 'lift', func_train: 'train', func_episodegate: 'gate', func_bossgate: 'gate'
};

// Invisible triggers worth reporting from server truth
const TRIGGER_KINDS = { trigger_changelevel: 'exit', trigger_teleport: 'teleport' };

const WEAPON_NAMES = [
	[ IT_AXE, 'axe' ], [ IT_SHOTGUN, 'shotgun' ], [ IT_SUPER_SHOTGUN, 'super_shotgun' ],
	[ IT_NAILGUN, 'nailgun' ], [ IT_SUPER_NAILGUN, 'super_nailgun' ],
	[ IT_GRENADE_LAUNCHER, 'grenade_launcher' ], [ IT_ROCKET_LAUNCHER, 'rocket_launcher' ],
	[ IT_LIGHTNING, 'thunderbolt' ]
];

// Text labels for menus drawn as pictures (rows in draw order)
const MENU_NAMES = {
	[ m_none ]: 'none', [ m_main ]: 'main', [ m_singleplayer ]: 'singleplayer', [ m_load ]: 'load',
	[ m_save ]: 'save', [ m_multiplayer ]: 'multiplayer', [ m_setup ]: 'setup', [ m_net ]: 'net',
	[ m_options ]: 'options', [ m_video ]: 'video', [ m_keys ]: 'keys', [ m_help ]: 'help',
	[ m_quit ]: 'quit', [ m_lanconfig ]: 'lanconfig', [ m_gameoptions ]: 'gameoptions',
	[ m_search ]: 'search', [ m_slist ]: 'serverlist', [ m_credits ]: 'credits', [ m_touch ]: 'touch',
	[ m_advanced ]: 'advanced', [ m_advpage ]: 'advanced_page'
};
const MENU_ITEMS = {
	[ m_singleplayer ]: [ 'New Game', 'Load', 'Save' ],
	[ m_multiplayer ]: [ 'Join a Game', 'New Game', 'Setup' ],
	[ m_quit ]: [ 'y = quit', 'n = stay' ]
};
const MAIN_ITEMS = [ 'Single Player', 'Multiplayer', 'Options', 'Help', 'Quit' ];

export const AGENT_KEYS = {
	enter: K_ENTER, escape: K_ESCAPE, up: K_UPARROW, down: K_DOWNARROW, left: K_LEFTARROW,
	right: K_RIGHTARROW, tab: K_TAB, backspace: K_BACKSPACE, '`': 96, '~': 126, space: 32
};

/*
==============================================================================

	EVENTS

==============================================================================
*/

function Agent_PushEvent( text ) {

	agent_events[ event_seq % EVENT_MAX ] = text;
	event_seq ++;

}

// Quake text: bit 7 picks the gold font, 1 and 2 lead colored lines, 10 is
// newline. Keep printable ASCII.
export function Agent_CleanText( txt ) {

	let out = '';
	for ( let i = 0; i < txt.length; i ++ ) {

		let c = txt.charCodeAt( i ) & 127;
		if ( c === 10 ) { out += '\n'; continue; }
		if ( c < 32 ) { if ( c === 1 || c === 2 ) continue; c = 32; }
		out += String.fromCharCode( c );

	}

	return out;

}

// Console lines that are loading chatter, not game events
const AGENT_NOISE = /^(meshing |Connecting to local|VERSION [0-9.]+ SERVER|Loading |execing |Unknown command "?(startdemos|demos)|couldn't exec|Client .* removed$|[0-9]+ demo\(s\) in loop$|CL_ParseStartSoundPacket: sound_num [0-9]+ not precached$)/;

function Agent_ConsoleHook( txt ) {

	con_partial += Agent_CleanText( txt );
	let nl;
	while ( ( nl = con_partial.indexOf( '\n' ) ) >= 0 ) {

		const line = con_partial.substring( 0, nl ).trim();
		con_partial = con_partial.substring( nl + 1 );
		// Skip blank lines and the console's ruler lines (Agent_CleanText
		// turned its bar characters into spaces)
		if ( line.length > 0 && /^[- ]+$/.test( line ) === false && AGENT_NOISE.test( line ) === false )
			Agent_PushEvent( 'msg: ' + line );

	}

}

function Agent_CenterHook( str ) {

	const text = Agent_CleanText( str ).split( '\n' ).map( ( s ) => s.trim() ).filter( ( s ) => s.length > 0 ).join( ' / ' );
	if ( text.length > 0 )
		Agent_PushEvent( 'center: ' + text );

}

let mapname_model = null;
let mapname = '';
function Agent_MapName() {

	if ( cl.worldmodel === null || cls.state !== ca_connected )
		return '';
	if ( cl.worldmodel !== mapname_model ) {

		mapname_model = cl.worldmodel;
		mapname = cl.worldmodel.name.replace( /^maps\//, '' ).replace( /\.bsp$/, '' );

	}

	return mapname;

}

// Events from stat changes since the last check
function Agent_StatEvents() {

	const map = Agent_MapName();
	if ( map === '' || cls.signon !== SIGNONS ) {

		prev_valid = false;
		return;

	}

	const st = cl.stats;
	if ( prev_valid === false || map !== prev_map ) {

		// A new level, or the same one reloaded after a disconnect
		Agent_PushEvent( 'level: ' + map + ( cl.levelname !== '' ? ' "' + cl.levelname + '"' : '' ) );
		prev_map = map;

	} else {

		const dh = st[ STAT_HEALTH ] - prev_stats[ STAT_HEALTH ];
		if ( dh < 0 ) Agent_PushEvent( 'hurt: ' + dh + ' hp (now ' + st[ STAT_HEALTH ] + ')' );
		if ( st[ STAT_HEALTH ] <= 0 && prev_stats[ STAT_HEALTH ] > 0 ) Agent_PushEvent( 'died: press attack or jump to respawn' );
		if ( st[ STAT_MONSTERS ] > prev_stats[ STAT_MONSTERS ] ) Agent_PushEvent( 'kill: ' + st[ STAT_MONSTERS ] + '/' + st[ STAT_TOTALMONSTERS ] );
		if ( st[ STAT_SECRETS ] > prev_stats[ STAT_SECRETS ] ) Agent_PushEvent( 'secret: ' + st[ STAT_SECRETS ] + '/' + st[ STAT_TOTALSECRETS ] );
		const gained = cl.items & ~ prev_items;
		if ( gained & ( IT_KEY1 | IT_KEY2 ) ) Agent_PushEvent( 'key: ' + Agent_Keys( gained ) );

	}

	if ( cl.intermission !== 0 && prev_intermission === 0 )
		Agent_PushEvent( 'intermission: level done; press attack to continue' );
	prev_intermission = cl.intermission;

	for ( let i = 0; i < 32; i ++ ) prev_stats[ i ] = st[ i ];
	prev_items = cl.items;
	prev_valid = true;

}

/*
==============================================================================

	ATTACH AND CLOCK

==============================================================================
*/

/*
==================
Agent_Attach

mode 'realtime' leaves the game running; 'lockstep' freezes it between
Agent_Step calls (main.js stops calling Host_Frame) and pins the frame time
to one tic, so each step tic is exactly 1/72 s of game time.
==================
*/
export function Agent_Attach( mode = 'realtime' ) {

	if ( mode !== 'realtime' && mode !== 'lockstep' )
		throw new Error( 'mode must be "realtime" or "lockstep"' );

	Con_SetAgentHook( Agent_ConsoleHook );
	SCR_SetAgentHook( Agent_CenterHook );

	if ( mode === 'lockstep' && agent_mode !== 'lockstep' ) {

		// Set the fields directly: Cvar_Set would save the archived
		// host_maxfps to localStorage, losing the player's value if the page
		// closes before detach
		for ( const [ name, value ] of LOCKSTEP_CVARS ) {

			const v = Cvar_FindVar( name );
			if ( v === null ) continue;
			saved_cvars.set( name, v.string );
			Agent_PinCvar( v, value );

		}

	} else if ( mode === 'realtime' && agent_mode === 'lockstep' ) {

		Agent_RestoreCvars();

	}

	agent_mode = mode;
	IN_SetAgentDriven( true );
	return agent_mode;

}

function Agent_PinCvar( v, value ) {

	v.string = value;
	v.value = Number.parseFloat( value ) || 0;

}

function Agent_RestoreCvars() {

	for ( const [ name, value ] of saved_cvars ) {

		const v = Cvar_FindVar( name );
		if ( v !== null ) Agent_PinCvar( v, value );

	}

	saved_cvars.clear();

}

export function Agent_Detach() {

	Agent_ReleaseButtons();
	if ( agent_mode === 'lockstep' ) Agent_RestoreCvars();
	Con_SetAgentHook( null );
	SCR_SetAgentHook( null );
	agent_mode = 'off';
	IN_SetAgentDriven( false );
	con_partial = '';

}

export function Agent_Mode() { return agent_mode; }

// Tics stepped in lockstep since the first attach (map loads included). A
// virtual clock built on it (server/agent_mcp.ts) advances exactly with the
// game.
export function Agent_Tics() { return agent_tics; }

// main.js skips its own Host_Frame while this is true
export function Agent_Lockstep() { return agent_mode === 'lockstep'; }

function Agent_Ready() {

	return cls.state === ca_connected && cls.signon === SIGNONS && cl.worldmodel !== null;

}

// One lockstep tic. The extra microsecond keeps the frame above
// _Host_FilterTime's host_maxfps gate; host_framerate makes the game time
// exactly one tic regardless.
function Agent_Tic() {

	Host_Frame( AGENT_TIC + 1e-6 );
	agent_tics ++;
	Agent_StatEvents();

}

// Let promises and fetches (map loads) settle. A MessageChannel task is not
// throttled in background tabs the way setTimeout is.
let yield_channel = null;
const yield_waiting = []; // one resolver per posted message, in order
function Agent_Yield() {

	if ( typeof MessageChannel === 'undefined' )
		return new Promise( ( resolve ) => setTimeout( resolve, 0 ) );

	if ( yield_channel === null ) {

		yield_channel = new MessageChannel();
		yield_channel.port1.onmessage = () => {

			const resolve = yield_waiting.shift();
			if ( resolve !== undefined ) resolve();

		};

	}

	return new Promise( ( resolve ) => {

		yield_waiting.push( resolve );
		yield_channel.port2.postMessage( 0 );

	} );

}

// The async calls run one at a time, in call order, so two never step the
// game together (which would break "exactly N tics")
let agent_queue = Promise.resolve();
export function Agent_Serial( fn ) {

	const run = agent_queue.then( fn, fn );
	agent_queue = run.catch( () => {} );
	return run;

}

// Runs frames (lockstep) or waits (realtime) until done() is true, letting
// fetches settle between frames. Returns done().
async function Agent_WaitFor( done, timeout_ms = 15000 ) {

	const start = performance.now();
	while ( done() === false && performance.now() - start < timeout_ms ) {

		if ( agent_mode === 'lockstep' ) Agent_Tic();
		await Agent_Yield();
		if ( agent_mode !== 'lockstep' ) await new Promise( ( r ) => setTimeout( r, 1000 / 72 ) );

	}

	return done();

}

// Wait until a connection or map load in progress has finished
function Agent_Settle( timeout_ms = 15000 ) {

	return Agent_WaitFor( () => Agent_Loading() === false, timeout_ms );

}

// True while a connection or map load is in progress
function Agent_Loading() {

	if ( cls.state === ca_connected && cls.signon !== SIGNONS ) return true;
	return cls.state !== ca_connected && sv.active === true;

}

/*
==============================================================================

	ACTIONS

==============================================================================
*/

function Agent_SetButtons( names ) {

	for ( const name of held_buttons ) {

		if ( names.has( name ) ) continue;
		Cmd_ExecuteString( '-' + AGENT_BUTTONS[ name ] + ' ' + AGENT_KEYNUM, src_command );
		held_buttons.delete( name );

	}

	for ( const name of names ) {

		if ( held_buttons.has( name ) ) continue;
		Cmd_ExecuteString( '+' + AGENT_BUTTONS[ name ] + ' ' + AGENT_KEYNUM, src_command );
		held_buttons.add( name );

	}

}

function Agent_ReleaseButtons() {

	Agent_SetButtons( new Set() );

}

// Parses 'forward,attack' or [ 'forward', 'attack' ] into a set of names
function Agent_ParseButtons( buttons ) {

	const names = new Set();
	if ( buttons === undefined || buttons === null || buttons === '' ) return names;
	const list = Array.isArray( buttons ) ? buttons : String( buttons ).split( /[\s,+]+/ );
	for ( const raw of list ) {

		const name = String( raw ).trim().toLowerCase();
		if ( name === '' ) continue;
		if ( Object.hasOwn( AGENT_BUTTONS, name ) === false )
			throw new Error( 'unknown button "' + name + '" (expected ' + Object.keys( AGENT_BUTTONS ).join( ', ' ) + ')' );
		names.add( name );

	}

	return names;

}

function Agent_ApplyLook( action ) {

	if ( typeof action.yaw === 'number' && Number.isFinite( action.yaw ) )
		cl.viewangles[ YAW ] = Agent_AngleMod( cl.viewangles[ YAW ] + action.yaw );
	if ( typeof action.pitch === 'number' && Number.isFinite( action.pitch ) ) {

		cl.viewangles[ PITCH ] += action.pitch;
		CL_ClampPitch();

	}

	if ( typeof action.face === 'number' && Number.isFinite( action.face ) )
		cl.viewangles[ YAW ] = Agent_AngleMod( action.face );

}

function Agent_AngleMod( a ) {

	a %= 360;
	return a < 0 ? a + 360 : a;

}

/*
==================
Agent_Step

action: { buttons: 'forward,attack', yaw: deg (+ turns left), pitch: deg
(+ looks down), face: absolute yaw, impulse: n }. The buttons are held for
`tics` tics (1/72 s each) and released after. Look changes apply at once.
Returns the observation text (with the events since the last observation).
==================
*/
export function Agent_Step( action = {}, tics = 1, opts = {} ) {

	return Agent_Serial( () => Agent_StepNow( action, tics, opts ) );

}

async function Agent_StepNow( action, tics, opts ) {

	if ( agent_mode === 'off' ) Agent_Attach( 'realtime' );
	tics = Math.max( 0, Math.min( 72 * 60, Math.floor( Number( tics ) || 0 ) ) );

	if ( Agent_Loading() ) await Agent_Settle();

	const names = Agent_ParseButtons( action.buttons );
	Agent_ApplyLook( action );
	if ( Number.isInteger( action.impulse ) && action.impulse > 0 && action.impulse < 256 )
		Cmd_ExecuteString( 'impulse ' + action.impulse, src_command );
	Agent_SetButtons( names );

	if ( agent_mode === 'lockstep' ) {

		for ( let i = 0; i < tics; i ++ ) {

			Agent_Tic();
			// A level change mid-step: finish loading before counting on
			if ( Agent_Loading() ) await Agent_Settle();

		}

	} else {

		const end = cl.time + tics * AGENT_TIC;
		const start = performance.now();
		while ( cl.time < end && performance.now() - start < tics * 1000 / 72 + 1000 ) {

			await new Promise( ( r ) => setTimeout( r, 1000 / 72 ) );
			Agent_StatEvents();

		}

	}

	if ( action.hold !== true ) Agent_ReleaseButtons();
	return Agent_Observe( opts );

}

const AGENT_LOAD_CMDS = /(^|[\s;])(map|changelevel|restart|load|connect|reconnect)(\s|;|$)/;

// True if console text starts a map load or connection
export function Agent_StartsLoad( text ) {

	return AGENT_LOAD_CMDS.test( text );

}

/*
==================
Agent_Command

Runs console text (e.g. 'map e1m2' or 'god'), lets it take effect, and
returns the console lines it printed.
==================
*/
export function Agent_Command( text ) {

	return Agent_Serial( () => Agent_CommandNow( text ) );

}

async function Agent_CommandNow( text ) {

	if ( agent_mode === 'off' ) Agent_Attach( 'realtime' );
	const first = event_seq;
	text = String( text );
	Cbuf_AddText( text + '\n' );
	if ( agent_mode === 'lockstep' ) {

		Cbuf_Execute();
		// Commands the server runs (god, give, kill) go over the connection
		// and print their reply there: one tic carries it back
		if ( Agent_Ready() ) Agent_Tic();

	} else await new Promise( ( r ) => setTimeout( r, 2000 / 72 ) ); // the next frame runs it

	// Map loads fetch files before the server spawns: let those settle
	// (without tics) until the load shows, then run it to signon
	if ( Agent_StartsLoad( text ) ) {

		const start = performance.now();
		while ( Agent_Loading() === false && performance.now() - start < 2000 ) await Agent_Yield();

	}

	await Agent_Settle();
	// Return the unread events too, and mark them read, so the next
	// observation doesn't repeat them
	const lines = Agent_EventsSince( Math.min( first, event_read ) );
	event_read = event_seq;
	return lines.join( '\n' );

}

/*
==================
Agent_NewGame

Starts a single-player map at a skill (0 easy to 3 nightmare). Host_Map_f
closes the console and menu, as in C.
==================
*/
export function Agent_NewGame( map = 'start', skill = 1 ) {

	return Agent_Serial( () => Agent_NewGameNow( map, skill ) );

}

async function Agent_NewGameNow( map, skill ) {

	if ( /^[A-Za-z0-9_]+$/.test( map ) === false ) throw new Error( 'bad map name' );
	skill = Math.max( 0, Math.min( 3, Math.floor( Number( skill ) || 0 ) ) );
	if ( agent_mode === 'off' ) Agent_Attach( 'realtime' );
	const first = Math.min( event_seq, event_read );
	// Disconnect first, so the level counts as loaded only once the new one is
	// (the same map reloaded keeps its cached world model)
	Cmd_ExecuteString( 'disconnect', src_command );
	await Agent_CommandNow( 'skill ' + skill + '\nmaxplayers 1\ndeathmatch 0\ncoop 0\nmap ' + map );
	const ok = await Agent_WaitFor( () => Agent_Ready() && Agent_MapName() === map.toLowerCase() );
	event_read = first; // the load's events (level, intro text) come with the observation
	if ( ok === false ) return 'failed to load ' + map + '\n' + Agent_Observe();
	return Agent_Observe();

}

/*
==================
Agent_Key

Presses and releases one key, for menus and the console: a name from
AGENT_KEYS or a single character.
==================
*/
export function Agent_Key( name, count = 1 ) {

	if ( agent_mode === 'off' ) Agent_Attach( 'realtime' );
	let k;
	if ( Object.hasOwn( AGENT_KEYS, name ) ) k = AGENT_KEYS[ name ];
	else if ( typeof name === 'string' && name.length === 1 ) k = name.toLowerCase().charCodeAt( 0 );
	else throw new Error( 'unknown key "' + name + '" (expected one character or ' + Object.keys( AGENT_KEYS ).join( ', ' ) + ')' );

	count = Math.max( 1, Math.min( 64, Math.floor( Number( count ) || 1 ) ) );
	for ( let i = 0; i < count; i ++ ) {

		Key_Event( k, true );
		Key_Event( k, false );

	}

	return Agent_UIText();

}

/*
==================
Agent_MenuSelect

Moves the menu cursor to the row whose label contains `label` and presses
enter. Only menus with labels (main, single player, multiplayer).
==================
*/
export function Agent_MenuSelect( label ) {

	const items = Agent_MenuItems();
	if ( items === null ) throw new Error( 'no labelled menu is open (' + Agent_UIText() + ')' );
	const want = String( label ).toLowerCase();
	const target = items.findIndex( ( s ) => s.toLowerCase().includes( want ) );
	if ( target < 0 ) throw new Error( 'no item "' + label + '" in ' + items.join( ', ' ) );

	for ( let guard = 0; guard < items.length && M_AgentState().cursor !== target; guard ++ ) {

		Key_Event( K_DOWNARROW, true );
		Key_Event( K_DOWNARROW, false );

	}

	Key_Event( K_ENTER, true );
	Key_Event( K_ENTER, false );
	return Agent_UIText();

}

/*
==============================================================================

	OBSERVATIONS

==============================================================================
*/

function Agent_MenuItems() {

	if ( key_dest !== key_menu ) return null;
	const ms = M_AgentState();
	if ( ms.state === m_main ) return ms.in_game ? [ 'Continue', ...MAIN_ITEMS ] : MAIN_ITEMS;
	return Object.hasOwn( MENU_ITEMS, ms.state ) ? MENU_ITEMS[ ms.state ] : null;

}

// One line describing what has keyboard focus
export function Agent_UIText() {

	if ( key_dest === key_menu ) {

		const ms = M_AgentState();
		const items = Agent_MenuItems();
		let s = 'ui=menu:' + ( MENU_NAMES[ ms.state ] ?? ms.state );
		if ( items !== null ) s += ' items=[' + items.map( ( it, i ) => ( i === ms.cursor ? '>' : '' ) + it ).join( '|' ) + ']';
		else if ( ms.cursor >= 0 ) s += ' cursor=' + ms.cursor;
		return s + ' (keys: up/down/enter/escape)';

	}

	if ( key_dest === key_console ) return 'ui=console (escape closes; or use icaro.cmd)';
	if ( key_dest === key_message ) return 'ui=chat';
	return 'ui=game';

}

function Agent_Weapon() {

	const w = cl.stats[ STAT_ACTIVEWEAPON ];
	// The server sends the weapon as a byte (SV_WriteClientdataToMessage),
	// so the axe (4096) arrives as 0
	if ( w === 0 && ( cl.items & IT_AXE ) !== 0 ) return 'axe';
	for ( const [ bit, name ] of WEAPON_NAMES )
		if ( w === bit ) return name;
	return String( w );

}

function Agent_Keys( items ) {

	const k = [];
	if ( items & IT_KEY1 ) k.push( 'silver' );
	if ( items & IT_KEY2 ) k.push( 'gold' );
	return k.length > 0 ? k.join( '+' ) : '-';

}

function Agent_Powerups( items ) {

	const p = [];
	if ( items & IT_QUAD ) p.push( 'quad' );
	if ( items & IT_INVULNERABILITY ) p.push( 'pent' );
	if ( items & IT_INVISIBILITY ) p.push( 'ring' );
	if ( items & IT_SUIT ) p.push( 'suit' );
	return p.join( '+' );

}

function Agent_ArmorType( items ) {

	if ( items & IT_ARMOR3 ) return 'red';
	if ( items & IT_ARMOR2 ) return 'yellow';
	if ( items & IT_ARMOR1 ) return 'green';
	return '';

}

// Status line: one line of numbers that matter every turn
export function Agent_StatusText() {

	if ( cls.demoplayback ) return 'state=demo (start a game: icaro.new_game("e1m1", 1))';
	if ( cls.state !== ca_connected ) return 'state=disconnected (start a game: icaro.new_game("e1m1", 1))';
	if ( cls.signon !== SIGNONS || cl.worldmodel === null ) return 'state=loading';

	const st = cl.stats;
	const me = cl_entities[ cl.viewentity ];
	const org = me !== undefined && me !== null ? me.origin : null;
	const armor = Agent_ArmorType( cl.items );
	const pu = Agent_Powerups( cl.items );
	let s = Agent_MapName() + ' t=' + cl.time.toFixed( 1 );
	if ( cl.intermission !== 0 ) s += ' INTERMISSION';
	else if ( st[ STAT_HEALTH ] <= 0 ) s += ' DEAD';
	s += ' hp=' + st[ STAT_HEALTH ] + ' armor=' + st[ STAT_ARMOR ] + ( armor !== '' ? '(' + armor + ')' : '' );
	s += ' weapon=' + Agent_Weapon() + ' ammo=' + st[ STAT_AMMO ];
	s += ' [sh' + st[ STAT_SHELLS ] + ' nl' + st[ STAT_NAILS ] + ' rk' + st[ STAT_ROCKETS ] + ' ce' + st[ STAT_CELLS ] + ']';
	s += ' keys=' + Agent_Keys( cl.items ) + ( pu !== '' ? ' powerups=' + pu : '' );
	s += ' kills=' + st[ STAT_MONSTERS ] + '/' + st[ STAT_TOTALMONSTERS ] + ' secrets=' + st[ STAT_SECRETS ] + '/' + st[ STAT_TOTALSECRETS ];
	if ( org !== null ) s += ' pos=' + Math.round( org[ 0 ] ) + ',' + Math.round( org[ 1 ] ) + ',' + Math.round( org[ 2 ] );
	s += ' yaw=' + Math.round( cl.viewangles[ YAW ] ) + ' pitch=' + Math.round( cl.viewangles[ PITCH ] );
	s += cl.onground ? ' ground' : ' air';
	if ( cl.inwater ) s += ' water';
	return s;

}

// Scratch for the line-of-sight trace (Golden Rule #4)
const los_trace = new trace_t();
const los_start = new Float32Array( 3 );
const los_end = new Float32Array( 3 );

function Agent_LineOfSight( from, to ) {

	if ( cl.worldmodel === null || cl.worldmodel.hulls === undefined ) return true;
	los_trace.allsolid = false;
	los_trace.startsolid = false;
	los_trace.inopen = false;
	los_trace.inwater = false;
	los_trace.fraction = 1;
	los_trace.ent = null;
	los_trace.endpos[ 0 ] = to[ 0 ]; los_trace.endpos[ 1 ] = to[ 1 ]; los_trace.endpos[ 2 ] = to[ 2 ];
	SV_RecursiveHullCheck( cl.worldmodel.hulls[ 0 ], 0, 0, 1, from, to, los_trace );
	return los_trace.fraction === 1 && los_trace.allsolid === false;

}

function Agent_ModelKind( ent ) {

	const name = ent.model.name;
	if ( name.charCodeAt( 0 ) === 42 ) return null; // '*': brush entity, kind from the server
	const base = name.replace( /^(progs|maps)\//, '' ).replace( /\.(mdl|spr|bsp)$/, '' );
	if ( SKIP_MODEL.test( base ) ) return '';
	if ( base === 'armor' ) return ARMOR_SKINS[ ent.skinnum ] ?? 'armor';
	return MODEL_KINDS[ base ] ?? base;

}

// The server's edict for a client entity, when this game runs a local server
function Agent_Edict( num ) {

	if ( sv.active !== true || num >= sv.num_edicts ) return null;
	const ed = sv.edicts[ num ];
	return ed === undefined || ed === null || ed.free === true ? null : ed;

}

/*
==================
Agent_Entities

The nearest entities the client knows about, with the yaw and pitch change
that would face each one (so `yaw` can be passed straight to Agent_Step).
With a local server, `truth` adds monster health, brush entity kinds and
the level's exits and teleporters.
==================
*/
export function Agent_Entities( max = 10, truth = true ) {

	if ( Agent_Ready() === false ) return [];
	const me = cl_entities[ cl.viewentity ];
	if ( me === undefined || me === null ) return [];
	const useTruth = truth === true && sv.active === true;

	los_start[ 0 ] = me.origin[ 0 ];
	los_start[ 1 ] = me.origin[ 1 ];
	los_start[ 2 ] = me.origin[ 2 ] + 22; // DEFAULT_VIEWHEIGHT

	const list = [];
	for ( let i = 1; i < cl.num_entities; i ++ ) {

		if ( i === cl.viewentity ) continue;
		const ent = cl_entities[ i ];
		if ( ent === undefined || ent === null || ent.model === null ) continue;
		if ( ent.msgtime !== cl.mtime[ 0 ] ) continue; // not in the latest update: out of view
		let kind = Agent_ModelKind( ent );
		if ( kind === '' ) continue;

		const ed = useTruth ? Agent_Edict( i ) : null;
		let hp = null;
		if ( kind === null ) {

			// Brush entity: report doors, buttons and lifts at their centre
			if ( ed === null ) continue;
			kind = BRUSH_KINDS[ PR_GetString( ed.v.classname ) ];
			if ( kind === undefined ) continue;
			los_end[ 0 ] = ( ed.v.absmin[ 0 ] + ed.v.absmax[ 0 ] ) / 2;
			los_end[ 1 ] = ( ed.v.absmin[ 1 ] + ed.v.absmax[ 1 ] ) / 2;
			los_end[ 2 ] = ( ed.v.absmin[ 2 ] + ed.v.absmax[ 2 ] ) / 2;

		} else {

			// The model's centre: item origins sit on the floor
			const m = ent.model;
			los_end[ 0 ] = ent.origin[ 0 ] + ( m.mins[ 0 ] + m.maxs[ 0 ] ) / 2;
			los_end[ 1 ] = ent.origin[ 1 ] + ( m.mins[ 1 ] + m.maxs[ 1 ] ) / 2;
			los_end[ 2 ] = ent.origin[ 2 ] + ( m.mins[ 2 ] + m.maxs[ 2 ] ) / 2;
			if ( ed !== null && ( ed.v.flags & FL_MONSTER ) !== 0 ) {

				if ( ed.v.health <= 0 ) continue; // corpse
				hp = Math.round( ed.v.health );

			}

		}

		list.push( Agent_Describe( i, kind, los_end, hp, true ) );

	}

	if ( useTruth ) {

		for ( let i = 1; i < sv.num_edicts; i ++ ) {

			const ed = Agent_Edict( i );
			if ( ed === null ) continue;
			const kind = TRIGGER_KINDS[ PR_GetString( ed.v.classname ) ];
			if ( kind === undefined ) continue;
			los_end[ 0 ] = ( ed.v.absmin[ 0 ] + ed.v.absmax[ 0 ] ) / 2;
			los_end[ 1 ] = ( ed.v.absmin[ 1 ] + ed.v.absmax[ 1 ] ) / 2;
			los_end[ 2 ] = ( ed.v.absmin[ 2 ] + ed.v.absmax[ 2 ] ) / 2;
			list.push( Agent_Describe( i, kind, los_end, null, false ) );

		}

	}

	list.sort( ( a, b ) => a.dist - b.dist );
	list.more = Math.max( 0, list.length - max );
	if ( list.length > max ) list.length = max;
	return list;

}

function Agent_Describe( num, kind, pos, hp, check_los ) {

	const dx = pos[ 0 ] - los_start[ 0 ];
	const dy = pos[ 1 ] - los_start[ 1 ];
	const dz = pos[ 2 ] - los_start[ 2 ];
	const flat = Math.hypot( dx, dy );
	let yaw = Math.atan2( dy, dx ) * 180 / Math.PI - cl.viewangles[ YAW ];
	yaw = ( ( yaw % 360 ) + 540 ) % 360 - 180;
	// Quake pitch is positive looking down
	const pitch = - Math.atan2( dz, flat ) * 180 / Math.PI - cl.viewangles[ PITCH ];
	return {
		id: num, kind: kind, dist: Math.round( Math.hypot( flat, dz ) ),
		yaw: Math.round( yaw ), pitch: Math.round( pitch ), dz: Math.round( dz ),
		visible: check_los ? Agent_LineOfSight( los_start, pos ) : null, hp: hp,
		x: Math.round( pos[ 0 ] ), y: Math.round( pos[ 1 ] ), z: Math.round( pos[ 2 ] )
	};

}

function Agent_EntityLine( e ) {

	let s = '#' + e.id + ' ' + e.kind + ' ' + e.dist + 'u yaw' + ( e.yaw >= 0 ? '+' : '' ) + e.yaw;
	if ( Math.abs( e.pitch ) >= 5 ) s += ' pitch' + ( e.pitch >= 0 ? '+' : '' ) + e.pitch;
	if ( e.visible === false ) s += ' hidden';
	if ( e.hp !== null ) s += ' hp' + e.hp;
	return s;

}

export function Agent_EventsSince( seq ) {

	const out = [];
	for ( let i = Math.max( seq, event_seq - EVENT_MAX ); i < event_seq; i ++ )
		out.push( agent_events[ i % EVENT_MAX ] );
	return out;

}

/*
==================
Agent_Observe

opts: { ents: max entities (default 10, 0 for none), events: true,
truth: true, format: 'text' | 'json' }. Text is the compact default; json
returns an object for programs.
==================
*/
export function Agent_Observe( opts = {} ) {

	Agent_StatEvents();
	const max = opts.ents ?? 10;
	const ents = max > 0 ? Agent_Entities( max, opts.truth !== false ) : [];
	const events = opts.events === false ? [] : Agent_EventsSince( event_read );
	if ( opts.events !== false ) event_read = event_seq;
	const status = Agent_StatusText();
	const ui = Agent_UIText();

	if ( opts.format === 'json' )
		return { status, ui, mode: agent_mode, tics: agent_tics, entities: ents, more: ents.more ?? 0, events };

	let s = status;
	if ( ui !== 'ui=game' ) s += '\n' + ui;
	for ( const e of ents ) s += '\n' + Agent_EntityLine( e );
	if ( ( ents.more ?? 0 ) > 0 ) s += '\n(+' + ents.more + ' farther)';
	for ( const ev of events ) s += '\n' + ev;
	return s;

}

const fnv = ( h, x ) => Math.imul( h ^ x, 16777619 ) >>> 0;
const hash_time = new Float64Array( 1 );
const hash_time_bits = new Int32Array( hash_time.buffer );

/*
==================
Agent_StateHash

FNV-1a over the local server's gameplay state (sv.time, the QuakeC globals
and every field of every edict) and the client's stats, as 8 hex digits.
Two runs from the same seed and actions give the same hash. '' without a
local server.
==================
*/
export function Agent_StateHash() {

	if ( sv.active !== true ) return '';
	hash_time[ 0 ] = sv.time;
	let h = fnv( fnv( 0x811c9dc5, hash_time_bits[ 0 ] ), hash_time_bits[ 1 ] );
	for ( let i = 0; i < pr_globals_int.length; i ++ )
		h = fnv( h, pr_globals_int[ i ] );
	for ( let e = 0; e < sv.num_edicts; e ++ ) {

		const ent = sv.edicts[ e ];
		h = fnv( h, ent.free === true ? 1 : 0 );
		if ( ent.free === true ) continue;
		const fields = ent._intView;
		for ( let i = 0; i < fields.length; i ++ )
			h = fnv( h, fields[ i ] );

	}

	for ( let i = 0; i < 32; i ++ )
		h = fnv( h, cl.stats[ i ] );
	return h.toString( 16 ).padStart( 8, '0' );

}

/*
==================
Agent_Screenshot

Draws the current view (3D canvas and 2D overlay) into a small image and
returns a data URL. In a browser with its own screenshot tool, that tool is
cheaper: a data URL comes back as text, which costs far more tokens than an
image. This is for adapters (MCP) that return it as an image.
==================
*/
export function Agent_Screenshot( gl_canvas, overlay_canvas, width = 320, type = 'image/jpeg', quality = 0.7 ) {

	SCR_UpdateScreen(); // draw now, so the WebGL buffer is still readable
	const w = Number.isFinite( width ) ? Math.max( 32, Math.min( 1920, Math.floor( width ) ) ) : 320;
	const h = Math.round( w * gl_canvas.height / gl_canvas.width );
	const c = gl_canvas.ownerDocument.createElement( 'canvas' );
	c.width = w;
	c.height = h;
	const ctx = c.getContext( '2d' );
	ctx.drawImage( gl_canvas, 0, 0, w, h );
	if ( overlay_canvas !== null ) ctx.drawImage( overlay_canvas, 0, 0, w, h );
	return c.toDataURL( type, quality );

}

export const AGENT_HELP = `Icaro Engine (Quake) agent API: window.icaro
Start:  await icaro.new_game('e1m1', 1)   // map, skill 0-3; returns an observation
Clock:  icaro.attach('lockstep')  // game frozen between steps (best for agents)
        icaro.attach('realtime')  // game runs; steps wait in real time
        icaro.mode(), icaro.detach()  // current mode; stop (game runs again)
Act:    await icaro.step({ buttons: 'forward,attack', yaw: 30, pitch: 0, impulse: 2 }, 18)
        buttons held for N tics (72 tics = 1 s), then released.
        buttons: ${ Object.keys( AGENT_BUTTONS ).join( ' ' ) }
        yaw: degrees, + turns left. pitch: + looks down. face: absolute yaw.
        impulse: 1-8 weapon select (1 axe, 2 shotgun, 3 super shotgun, 4 nailgun, ...).
        Quake has no use key: walk into buttons and doors; shoot some buttons.
Look:   icaro.observe()   // status line, ui, nearest entities, events since last call
        entity line: #id kind distance yawN [pitchN] [hidden] [hpN]
        yawN is the yaw change that faces it: step({ yaw: N }).
        exit = level exit trigger (walk into it).
Menus:  icaro.key('down'|'up'|'enter'|'escape'|'y'|...), icaro.menu('Single Player')
Console: await icaro.cmd('god')   // returns what it printed (lockstep, in game: runs one tic)
Image:  use your browser's own screenshot tool (icaro.screenshot() returns a data URL)
Options: icaro.observe({ ents: 20, format: 'json', truth: false })`;
