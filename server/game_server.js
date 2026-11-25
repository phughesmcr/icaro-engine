// Icaro Engine Game Server for Deno
// Uses the existing JavaScript game modules from src/
//
// Local dev:  deno task game   (from the repository root; see server/README.md)
// Rooms are normally spawned by lobby_server.js via room_process_manager.ts,
// which passes scoped --allow-net/--allow-read flags.

import { Sys_Printf, Sys_FloatTime } from '../src/sys.js';
import { COM_AddPakSequence, COM_AddGameDirectory, COM_SetLooseFileBasePaths, COM_EnsureFile } from '../src/pak.js';
import { COM_InitArgv, LOC_Init, rogue, hipnotic } from '../src/common.js';
import { Cbuf_Init, Cbuf_Execute, Cmd_Init } from '../src/cmd.js';
import { Host_InitCommands } from '../src/host_cmd.js';
import { deathmatch, samelevel, noexit, sys_ticrate, campaign, horde, sv_cheats, Host_ShutdownServer } from '../src/host.js';
import { Cvar_RegisterVariable } from '../src/cvar.js';
import { cls, ca_dedicated } from '../src/client.js';
import { Memory_Init } from '../src/zone.js';
import { PR_Init } from '../src/pr_edict.js';
import { SV_Init, SV_SpawnServer, SV_CheckForNewClients, SV_SendClientMessages, SV_ClearDatagram } from '../src/sv_main.js';
import { SV_Physics, SV_SetFrametime } from '../src/sv_phys.js';
import { SV_RunClients } from '../src/sv_user.js';
import { svs, sv, client_t } from '../src/server.js';
import { Mod_Init, R_InitTextures } from '../src/gl_model.js';
import { NET_Init, set_listening } from '../src/net_main.js';
import { net_drivers, set_net_numdrivers, set_net_driverlevel } from '../src/net.js';

// Import WebTransport server driver
import {
	WT_Init as WT_Server_Init,
	WT_Listen,
	WT_CheckNewConnections,
	WT_QGetMessage,
	WT_QSendMessage,
	WT_SendUnreliableMessage,
	WT_CanSendMessage,
	WT_CanSendUnreliableMessage,
	WT_Close,
	WT_Shutdown,
	WT_SetConfig,
	WT_SearchForHosts,
	WT_SetDriverLevel,
	WT_SetSocketAllocator,
	WT_SetSocketFreer,
	WT_GetMaxPendingWrites,
	WT_GetPendingConnectionCount,
} from './net_webtransport_server.ts';
// WebSocket server driver (-wsport), for browsers without WebTransport and
// HTTP-only proxies such as a Cloudflare Tunnel
import {
	WS_Init as WS_Server_Init,
	WS_Listen,
	WS_CheckNewConnections,
	WS_QGetMessage,
	WS_QSendMessage,
	WS_SendUnreliableMessage,
	WS_CanSendMessage,
	WS_CanSendUnreliableMessage,
	WS_Close,
	WS_Shutdown,
	WS_SetConfig,
	WS_SearchForHosts,
	WS_SetDriverLevel,
	WS_SetSocketAllocator,
	WS_SetSocketFreer,
	WS_GetPendingConnectionCount,
} from './net_websocket_server.ts';
import { NET_NewQSocket, NET_FreeQSocket } from '../src/net_main.js';
import { formatRoomStatusLine, MAX_PLAYERS_LIMIT, DEFAULT_MAX_PLAYERS } from './room_process_manager.ts';

// Server configuration
export function createConfig() {
	return {
		pakPath: '../static/pak0.pak',
		port: 4433,
		certFile: 'cert.pem',
		keyFile: 'key.pem',
		maxClients: 4,
		defaultMap: 'start',
		roomId: null,        // Room ID if spawned by lobby server
		directMode: false,   // Skip lobby protocol, accept connections directly
		idleTimeout: 300,    // Seconds to wait before exiting when empty (room mode)
		statusNonce: null,   // Token for structured status lines to the lobby (room mode)
		parentWatch: false,  // Exit when stdin closes (the lobby holds the other end)
		gameFlags: [],       // -rogue and/or -hipnotic: load <basedir>/rogue or hipnotic too
		gameDir: null,       // -game <dir>: load <basedir>/<dir> too (e.g. the rerelease's mg1)
		wsPort: null,        // -wsport <port>: also accept WebSocket clients (TCP)
		wsHost: '127.0.0.1', // -wshost <addr>: WebSocket listen address
		wsTls: false,        // -wstls: wss:// with -cert/-key instead of plain ws://
	};
}
const CONFIG = createConfig();

/**
 * Clamp -maxclients to 1..MAX_PLAYERS_LIMIT (MAX_SCOREBOARD), like
 * Host_Maxplayers_f / NET_Init do in the original engine.
 */
function clampMaxClients(value) {
	const n = parseInt(value, 10);
	if (Number.isFinite(n) === false) return DEFAULT_MAX_PLAYERS;
	return Math.max(1, Math.min(MAX_PLAYERS_LIMIT, n));
}

// Parse command line arguments into config (exported for tests)
export function parseArgs(args = Deno.args, config = CONFIG) {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === '-port' && args[i + 1]) {
			config.port = parseInt(args[++i], 10);
		} else if (arg === '-maxclients' && args[i + 1]) {
			config.maxClients = clampMaxClients(args[++i]);
		} else if (arg === '-map' && args[i + 1]) {
			config.defaultMap = args[++i];
		} else if (arg === '-pak' && args[i + 1]) {
			config.pakPath = args[++i];
		} else if (arg === '-cert' && args[i + 1]) {
			config.certFile = args[++i];
		} else if (arg === '-key' && args[i + 1]) {
			config.keyFile = args[++i];
		} else if (arg === '-room' && args[i + 1]) {
			config.roomId = args[++i];
			config.directMode = true; // Room servers use direct mode
		} else if (arg === '-direct') {
			config.directMode = true;
		} else if (arg === '-idletimeout' && args[i + 1]) {
			const t = parseInt(args[++i], 10);
			if (Number.isFinite(t)) config.idleTimeout = t;
		} else if (arg === '-statusnonce' && args[i + 1]) {
			config.statusNonce = args[++i];
		} else if (arg === '-parentwatch') {
			config.parentWatch = true;
		} else if (arg === '-rogue' || arg === '-hipnotic') {
			config.gameFlags.push(arg);
		} else if (arg === '-game' && args[i + 1]) {
			const dir = args[++i];
			if (isGameDirName(dir)) config.gameDir = dir;
		} else if (arg === '-wsport' && args[i + 1]) {
			const port = parseInt(args[++i], 10);
			if (Number.isInteger(port) && port > 0 && port < 65536) config.wsPort = port;
		} else if (arg === '-wshost' && args[i + 1]) {
			config.wsHost = args[++i];
		} else if (arg === '-wstls') {
			config.wsTls = true;
		}
	}
	return config;
}

/**
 * A -game directory name: one path component, no '..' (common.c takes any).
 */
export function isGameDirName(dir) {
	return /^[A-Za-z0-9_-]+$/.test(dir);
}

/**
 * common.c COM_InitFilesystem: <basedir>/rogue, then <basedir>/hipnotic, then
 * <basedir>/<-game dir>, after id1. When the -pak file is in a directory named
 * id1 (as in C, and the rerelease's rerelease/id1/pak0.pak), basedir is its
 * parent; otherwise it is the directory holding the -pak file, as for this
 * port's static/pak0.pak. Either separator is accepted so a Windows-style
 * path works too.
 */
export function gameDirectories(pakPath, isRogue, isHipnotic, gameDir = null) {
	const basedir = gameBaseDirectory(pakPath);
	const dirs = [];
	if (isRogue) dirs.push(basedir + '/rogue');
	if (isHipnotic) dirs.push(basedir + '/hipnotic');
	if (gameDir !== null) dirs.push(basedir + '/' + gameDir);
	return dirs;
}

/**
 * The basedir that gameDirectories resolves game directories in.
 */
export function gameBaseDirectory(pakPath) {
	const dir = pakDirectory(pakPath);
	const name = dir.slice(Math.max(dir.lastIndexOf('/'), dir.lastIndexOf('\\')) + 1);
	return name.toLowerCase() === 'id1' ? pakDirectory(dir) : dir;
}

/**
 * The directory holding path (a file), or '.'.
 */
function pakDirectory(path) {
	const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
	return cut >= 0 ? path.slice(0, cut) : '.';
}

// Globals for game loop
let host_frametime = 0;
let realtime = 0;
let oldrealtime = 0;

// Idle tracking for room servers
let lastActiveTime = 0;

// Structured status reporting to the lobby (room mode)
const STATUS_INTERVAL = 5; // Seconds between unchanged status lines
let lastStatusPlayers = -1;
let lastStatusActive = null;
let lastStatusTime = 0;

/**
 * Write a status line for the lobby. Bypasses Sys_Printf (and so the quiet
 * log filter): the lobby relies on these to know player counts.
 */
function Room_ReportStatus(force) {
	if (CONFIG.statusNonce === null) return;
	const players = countActivePlayers();
	const active = sv.active === true;
	if (force !== true && players === lastStatusPlayers && active === lastStatusActive &&
		realtime - lastStatusTime < STATUS_INTERVAL) {
		return;
	}
	lastStatusPlayers = players;
	lastStatusActive = active;
	lastStatusTime = realtime;
	console.log(formatRoomStatusLine(CONFIG.statusNonce, { players, active }));
}

/**
 * Exit when stdin reaches EOF. The lobby spawns rooms with a piped stdin and
 * never writes to it, so EOF means the lobby process has gone away.
 */
async function Room_WatchParent() {
	const buf = new Uint8Array(256);
	try {
		while ((await Deno.stdin.read(buf)) !== null) { /* discard */ }
	} catch { /* treat errors as EOF */ }
	Sys_Printf('Room %s exiting: lobby stdin closed\n', CONFIG.roomId ?? '-');
	Deno.exit(0);
}

// Heartbeat tracking
let frameCount = 0;
let lastHeartbeat = 0;
const HEARTBEAT_INTERVAL = 30; // Log every 30 seconds

// Watchdog: logs to stderr every 5 seconds to detect event loop freezes
// If this stops printing, the event loop is completely blocked
let watchdogCount = 0;
function startWatchdog() {
	setInterval(() => {
		watchdogCount++;
		console.error('[WATCHDOG] tick=' + watchdogCount + ' time=' + Math.floor(performance.now() / 1000));
	}, 5000);
}


/**
 * Initialize the game server
 */
async function Host_Init_Server() {
	Sys_Printf('========================================\n');
	if (CONFIG.roomId !== null) {
		Sys_Printf('Icaro Room Server [%s]\n', CONFIG.roomId);
	} else {
		Sys_Printf('Icaro Game Server v1.0\n');
	}
	Sys_Printf('========================================\n\n');

	// Only the mission-pack flags go to COM_InitArgv: the rest are this
	// server's own, and NET_Init would read -port from com_argv
	COM_InitArgv(['game_server', ...CONFIG.gameFlags]);

	// Initialize subsystems in order (from host.js)
	Memory_Init();
	Cbuf_Init();
	Cmd_Init();
	Host_InitCommands(); // Register prespawn, spawn, begin commands

	// Set dedicated server mode - this prevents Host_Map_f from connecting a local client
	cls.state = ca_dedicated;

	// Set max clients BEFORE NET_Init so socket pool is properly sized
	svs.maxclients = CONFIG.maxClients;
	svs.maxclientslimit = CONFIG.maxClients;
	svs.clients = [];
	for (let i = 0; i < svs.maxclientslimit; i++) {
		svs.clients[i] = new client_t();
	}

	// Initialize network
	Sys_Printf('Configuring network...\n');
	WT_SetConfig({
		port: CONFIG.port,
		certFile: CONFIG.certFile,
		keyFile: CONFIG.keyFile,
	});

	// Room servers accept connections directly (no lobby protocol); the
	// driver has no separate mode for it.
	if (CONFIG.directMode) {
		Sys_Printf('Direct mode enabled (room server)\n');
	}

	// Initialize base networking (sets up loopback driver 0)
	NET_Init();

	// Enable listening mode (dedicated server accepts connections)
	set_listening(true);

	// Register server WebTransport driver (driver 1)
	set_net_numdrivers(2);
	net_drivers[1] = {
		name: 'WebTransport Server',
		initialized: false,
		controlSock: null,
		Init: WT_Server_Init,
		Listen: WT_Listen,
		SearchForHosts: WT_SearchForHosts,
		Connect: () => null, // Server doesn't connect out
		CheckNewConnections: WT_CheckNewConnections,
		QGetMessage: WT_QGetMessage,
		QSendMessage: WT_QSendMessage,
		SendUnreliableMessage: WT_SendUnreliableMessage,
		CanSendMessage: WT_CanSendMessage,
		CanSendUnreliableMessage: WT_CanSendUnreliableMessage,
		Close: WT_Close,
		Shutdown: WT_Shutdown,
	};

	// Initialize the server driver
	const controlSocket = net_drivers[1].Init();
	if (controlSocket !== -1) {
		net_drivers[1].initialized = true;
		net_drivers[1].controlSock = controlSocket;
	}

	// Set driver level to 1 (WebTransport) for server operations
	set_net_driverlevel(1);
	WT_SetDriverLevel(1);

	// Pass the socket allocator and freer to the WebTransport driver so it uses
	// the shared pool. Each driver's allocator also counts the other's sockets
	// still waiting to be accepted (NET-1).
	WT_SetSocketAllocator((pending = 0) => NET_NewQSocket(pending + WS_GetPendingConnectionCount()));
	WT_SetSocketFreer(NET_FreeQSocket);

	// Register the WebSocket server driver (driver 2) when -wsport is given
	if (CONFIG.wsPort !== null) {
		WS_SetConfig({
			port: CONFIG.wsPort,
			hostname: CONFIG.wsHost,
			tls: CONFIG.wsTls,
			certFile: CONFIG.certFile,
			keyFile: CONFIG.keyFile,
			// A lobby-spawned room is reached only through the lobby's proxy,
			// which passes the client's address as ?ip=
			trustQueryIp: CONFIG.roomId !== null,
		});
		set_net_numdrivers(3);
		net_drivers[2] = {
			name: 'WebSocket Server',
			initialized: false,
			controlSock: null,
			Init: WS_Server_Init,
			Listen: WS_Listen,
			SearchForHosts: WS_SearchForHosts,
			Connect: () => null, // Server doesn't connect out
			CheckNewConnections: WS_CheckNewConnections,
			QGetMessage: WS_QGetMessage,
			QSendMessage: WS_QSendMessage,
			SendUnreliableMessage: WS_SendUnreliableMessage,
			CanSendMessage: WS_CanSendMessage,
			CanSendUnreliableMessage: WS_CanSendUnreliableMessage,
			Close: WS_Close,
			Shutdown: WS_Shutdown,
		};
		if (net_drivers[2].Init() !== -1) {
			net_drivers[2].initialized = true;
		}
		WS_SetDriverLevel(2);
		WS_SetSocketAllocator((pending = 0) => NET_NewQSocket(pending + WT_GetPendingConnectionCount()));
		WS_SetSocketFreer(NET_FreeQSocket);
	}

	// Initialize server systems
	PR_Init();
	Mod_Init();
	R_InitTextures();
	SV_Init();

	// The 2021 re-release QuakeC reads and writes these every frame. Host_InitLocal
	// registers them on the client; this process never calls it.
	Cvar_RegisterVariable(campaign);
	Cvar_RegisterVariable(horde);
	Cvar_RegisterVariable(sv_cheats);

	// Set deathmatch mode - this ensures respawn() doesn't restart the entire server
	// We set the value directly on the imported cvar object (same object that sv_main.js uses)
	deathmatch.value = 1;
	deathmatch.string = '1';
	Sys_Printf('Deathmatch mode enabled (deathmatch=%d)\n', deathmatch.value);

	// Set samelevel to prevent level exits from changing maps (QuakeWorld progs)
	// 0 = normal (allow exit), 1 = same map, 2 = kill on exit, 3 = kill if not on "start" map
	samelevel.value = 2;
	samelevel.string = '2';
	Sys_Printf('Samelevel mode enabled (samelevel=%d - kills players trying to exit)\n', samelevel.value);

	// Set noexit to prevent level exits from changing maps (standard Quake progs)
	// 0 = normal (allow exit), 1 = kill on exit, 2 = kill if not on "start" map
	noexit.value = 1;
	noexit.string = '1';
	Sys_Printf('Noexit mode enabled (noexit=%d - kills players trying to exit)\n', noexit.value);

	// Load PAK file
	Sys_Printf('Loading game data...\n');
	// pak0.pak plus any pak1.pak, pak2.pak... next to it (registered data)
	if (await COM_AddPakSequence(CONFIG.pakPath) === 0) {
		throw new Error('Failed to load ' + CONFIG.pakPath);
	}

	const gameDirs = gameDirectories(CONFIG.pakPath, rogue, hipnotic, CONFIG.gameDir);
	for (const dir of gameDirs) {
		if (await COM_AddGameDirectory(dir) === 0) {
			throw new Error('-' + dir.slice(dir.lastIndexOf('/') + 1) + ' needs ' + dir + '/pak0.pak');
		}
	}

	// Ironwail host.c Host_Init: LOC_Init, once the game data is mounted. The
	// server resolves the 2021 rerelease's "$key" strings, so this process
	// needs the strings rather than the client.
	LOC_Init();

	// Base paths for on-demand loose file loading (custom maps not in PAK):
	// the game directories, then id1's when it is not static/ itself, then static/
	COM_SetLooseFileBasePaths([
		...gameDirs.reverse().map((dir) => dir + '/'),
		...(gameBaseDirectory(CONFIG.pakPath) !== pakDirectory(CONFIG.pakPath) ? [pakDirectory(CONFIG.pakPath) + '/'] : []),
		decodeURIComponent(new URL('../static/', import.meta.url).pathname),
	]);

	// Start listening for connections. The WebSocket listener starts first, so
	// "WebTransport server listening" (what the lobby waits for) still means
	// every listener is up. Each resolves false when it can't bind or load its
	// cert.
	if (CONFIG.wsPort !== null && await net_drivers[2].Listen(true) === false) {
		throw new Error('WebSocket listener failed to start on port ' + CONFIG.wsPort);
	}
	if (await net_drivers[1].Listen(true) === false) {
		throw new Error('WebTransport listener failed to start on port ' + CONFIG.port);
	}

	// Ensure the default map file is available, then spawn. maxclients comes
	// from -maxclients (set on svs above, before SV_SpawnServer, so clients
	// receive it in svc_serverinfo).
	Sys_Printf('Spawning server for map: ' + CONFIG.defaultMap + '\n');
	if (await COM_EnsureFile('maps/' + CONFIG.defaultMap + '.bsp') !== true) {
		throw new Error('Map not found: maps/' + CONFIG.defaultMap + '.bsp');
	}
	SV_SpawnServer(CONFIG.defaultMap);
	if (sv.active !== true) {
		throw new Error('Could not spawn map ' + CONFIG.defaultMap);
	}

	Sys_Printf('\nServer initialized!\n');
	Sys_Printf('  Port: ' + CONFIG.port + '\n');
	Sys_Printf('  Max clients: ' + CONFIG.maxClients + '\n');
	Sys_Printf('  Map: ' + CONFIG.defaultMap + '\n\n');
}

/**
 * Count active players
 */
function countActivePlayers() {
	let count = 0;
	for (let i = 0; i < svs.maxclients; i++) {
		if (svs.clients[i].active) {
			count++;
		}
	}
	return count;
}

/**
 * Run a single server frame
 */
function Host_ServerFrame() {
	// Update time
	const newtime = Sys_FloatTime();
	host_frametime = newtime - oldrealtime;
	oldrealtime = newtime;

	// Clamp frametime
	if (host_frametime > 0.1) host_frametime = 0.1;
	if (host_frametime < 0.001) host_frametime = 0.001;

	realtime += host_frametime;

	// Set frametime for physics modules
	SV_SetFrametime(host_frametime);

	// Heartbeat logging — runs before sv.active check so we can detect
	// whether the game loop is alive even when the server is inactive
	frameCount++;
	if (realtime - lastHeartbeat >= HEARTBEAT_INTERVAL) {
		const playerCount = countActivePlayers();
		const maxPW = WT_GetMaxPendingWrites();
		Sys_Printf('[Heartbeat] time=' + Math.floor(realtime) + ' frames=' + frameCount + ' players=' + playerCount + ' sv.active=' + sv.active + ' maxPendingWrites=' + maxPW + '\n');
		lastHeartbeat = realtime;
	}

	// Track activity for room servers (idle timeout). Rooms nobody joins
	// exit too: lastActiveTime starts at the first frame.
	if (CONFIG.roomId !== null && CONFIG.idleTimeout > 0) {
		if (countActivePlayers() > 0) {
			lastActiveTime = realtime;
		} else if (realtime - lastActiveTime > CONFIG.idleTimeout) {
			Sys_Printf('Room %s idle for %d seconds, shutting down\n', CONFIG.roomId, Math.floor(realtime - lastActiveTime));
			Deno.exit(0);
		}
	}

	if (!sv.active) return;

	// Set the time and clear the general datagram
	SV_ClearDatagram();

	// Run command buffer
	Cbuf_Execute();

	// Check for new connections
	SV_CheckForNewClients();

	// Read client messages and run client commands
	const t0 = performance.now();
	SV_RunClients();
	const t1 = performance.now();

	// Run physics
	SV_Physics();
	const t2 = performance.now();

	// Send messages to all clients
	SV_SendClientMessages();
	const t3 = performance.now();

	// Debug: log slow frames
	const total = t3 - t0;
	if (total > 20 || frameCount <= 5) {
		Sys_Printf('[FrameTiming] RunClients=' + (t1 - t0).toFixed(1) + 'ms Physics=' + (t2 - t1).toFixed(1) + 'ms Send=' + (t3 - t2).toFixed(1) + 'ms total=' + total.toFixed(1) + 'ms\n');
	}

}

/**
 * Run one server frame and say whether the room must exit.
 *
 * Host_Error (or a failed level change) shuts the server down and nothing
 * restarts it, so the room exits rather than linger as a dead room.
 *
 * Any other throw (Sys_Error, a JavaScript error) leaves sv.active set
 * after a half-run frame: QuakeC may have stopped mid-function and edicts
 * may be half-updated. Running more frames on that state is not
 * deterministic, and restarting the map would carry it into the next level
 * through the spawn parms. In C, Sys_Error quits the program, so the room
 * does the same: it shuts the server down (svc_disconnect to every client)
 * and exits. Host_ShutdownServer( true ) skips each client's own final
 * message; the port's SV_DropClient still runs QuakeC's ClientDisconnect,
 * and if that throws on the broken state the server is marked inactive
 * anyway.
 *
 * frame is injectable for tests.
 */
export function Room_RunFrame(frame = Host_ServerFrame) {
	const wasActive = sv.active === true;
	try {
		frame();
	} catch (error) {
		Sys_Printf('Host_ServerFrame error: %s\n', String(error));
		if (sv.active === true) {
			try {
				Host_ShutdownServer(true);
			} catch (shutdownError) {
				Sys_Printf('Host_ServerFrame error: Host_ShutdownServer: %s\n', String(shutdownError));
				sv.active = false;
			}
		}
		return true;
	}
	return wasActive && sv.active !== true;
}

/**
 * Main server loop
 */
async function runServerLoop() {
	oldrealtime = Sys_FloatTime();

	const ticrate = sys_ticrate.value; // default 0.05 = 20Hz
	const tickInterval = ticrate * 1000;
	Sys_Printf('Starting server loop at ' + ( 1 / ticrate ) + ' Hz (sys_ticrate ' + ticrate + ')...\n');

	let gameLoopCallCount = 0;

	setInterval(() => {
		gameLoopCallCount++;

		// Log every call to detect when game loop stops
		if (gameLoopCallCount <= 10 || gameLoopCallCount % 100 === 0) {
			Sys_Printf('[GameLoop] Call #%d\n', gameLoopCallCount);
		}

		// The lobby frees the port and id when the process exits.
		if (Room_RunFrame()) {
			Room_ReportStatus(true);
			Sys_Printf('Host_Error: server is no longer active, exiting\n');
			Deno.exit(1);
		}

		Room_ReportStatus(false);
	}, tickInterval);

	// Keep process running
	await new Promise(() => {});
}

/**
 * Entry point
 */
async function main() {
	// Reduce log write volume in production. Keep only allowlisted lines.
	globalThis.__ICARO_QUIET_LOGS = true;

	// Global unhandled rejection handler - prevent server crashes from async errors
	globalThis.addEventListener('unhandledrejection', (event) => {
		Sys_Printf('Unhandled promise rejection: %s\n', String(event.reason));
		event.preventDefault(); // Prevent default crash behavior
	});

	parseArgs();
	startWatchdog();

	if (CONFIG.parentWatch) {
		Room_WatchParent();
	}

	try {
		await Host_Init_Server();
		Room_ReportStatus(true);
		await runServerLoop();
	} catch (error) {
		console.error('Fatal error:', error);
		Deno.exit(1);
	}
}

if (import.meta.main) {
	main();
}
