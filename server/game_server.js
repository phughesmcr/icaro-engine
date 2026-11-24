// Icaro Engine Game Server for Deno
// Uses the existing JavaScript game modules from src/
//
// Local dev:  deno task game   (from the repository root; see server/README.md)
// Rooms are normally spawned by lobby_server.js via room_process_manager.ts,
// which passes scoped --allow-net/--allow-read flags.

import { Sys_Printf, Sys_FloatTime } from '../src/sys.js';
import { COM_AddPakSequence, COM_AddGameDirectory, COM_SetLooseFileBasePath, COM_EnsureFile } from '../src/pak.js';
import { COM_InitArgv, rogue, hipnotic } from '../src/common.js';
import { Cbuf_Init, Cbuf_Execute, Cmd_Init } from '../src/cmd.js';
import { Host_InitCommands } from '../src/host_cmd.js';
import { deathmatch, samelevel, noexit, sys_ticrate } from '../src/host.js';
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
} from './net_webtransport_server.ts';
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
		gameFlags: [],       // -rogue and/or -hipnotic: load <pak dir>/rogue or hipnotic too
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
		}
	}
	return config;
}

/**
 * common.c COM_InitFilesystem: <basedir>/rogue, then <basedir>/hipnotic, after
 * id1. basedir is the directory holding the -pak file; either separator is
 * accepted so a Windows-style path works too.
 */
export function gameDirectories(pakPath, isRogue, isHipnotic) {
	const cut = Math.max(pakPath.lastIndexOf('/'), pakPath.lastIndexOf('\\'));
	const basedir = cut >= 0 ? pakPath.slice(0, cut) : '.';
	const dirs = [];
	if (isRogue) dirs.push(basedir + '/rogue');
	if (isHipnotic) dirs.push(basedir + '/hipnotic');
	return dirs;
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

	// Pass the socket allocator and freer to the WebTransport driver so it uses the shared pool
	WT_SetSocketAllocator(NET_NewQSocket);
	WT_SetSocketFreer(NET_FreeQSocket);

	// Initialize server systems
	PR_Init();
	Mod_Init();
	R_InitTextures();
	SV_Init();

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

	for (const dir of gameDirectories(CONFIG.pakPath, rogue, hipnotic)) {
		if (await COM_AddGameDirectory(dir) === 0) {
			throw new Error('-' + dir.slice(dir.lastIndexOf('/') + 1) + ' needs ' + dir + '/pak0.pak');
		}
	}

	// Set base path for on-demand loose file loading (custom maps not in PAK)
	COM_SetLooseFileBasePath(decodeURIComponent(new URL('../static/', import.meta.url).pathname));

	// Start listening for connections
	// WT_Listen resolves false when the listener can't bind or load its cert.
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

		const wasActive = sv.active === true;
		try {
			Host_ServerFrame();
		} catch (error) {
			Sys_Printf('Host_ServerFrame error: %s\n', String(error));
		}

		// Host_Error (or a failed level change) shuts the server down and
		// nothing restarts it. Exit rather than linger as a dead room; the
		// lobby frees the port and id when the process exits.
		if (wasActive && sv.active !== true) {
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
