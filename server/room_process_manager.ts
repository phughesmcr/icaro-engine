// Room Process Manager for Icaro Engine
// Spawns and manages isolated Deno processes for each game room
// This matches how original Quake handled multiple games: separate server processes

import { basename, dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath as fromFileUrl } from "node:url";
import { Sys_Printf } from "./sys_server.ts";
import {
  GAME_OPTION_RANGES,
  Room_ClampMaxPlayers,
  Room_SanitizeGameOptions,
  Room_SanitizeHostName,
  Room_SanitizeMapName,
} from "./room_config.js";
import { GD_PAK } from "./game_data.js";
import { COM_GameDirIsValid } from "../src/common.js";

// Port range for room servers (main lobby is on 4433)
export const BASE_PORT = 4434;
export const MAX_ROOMS = 10;

// Room config limits, in room_config.js so the Cloudflare lobby shares them
export {
  DEFAULT_HOST_NAME,
  DEFAULT_MAP,
  DEFAULT_MAX_PLAYERS,
  GAME_OPTION_RANGES,
  MAX_HOST_NAME_BYTES,
  MAX_MAP_NAME_LENGTH,
  MAX_PLAYERS_LIMIT,
} from "./room_config.js";

// Structured status channel: game_server.js writes one line per status update
// to stdout, bypassing the quiet-log filter:
//   @@ICARO_STATUS <nonce> {"players":N,"active":true|false}
// The nonce is a per-room random token passed via -statusnonce, so text that
// some other code path prints can't forge a status line.
export const STATUS_PREFIX = "@@ICARO_STATUS";

const ROOM_STARTUP_TIMEOUT_MS = 15 * 1000;
const ROOM_STARTUP_GRACE_MS = 30 * 1000;
const ROOM_WATCHDOG_TIMEOUT_MS = 30 * 1000;
const ROOM_JOIN_STALE_MS = 12 * 1000;
const ROOM_KILL_ESCALATION_MS = 5 * 1000;

interface RoomProcess {
  id: string;
  map: string;
  port: number;
  maxPlayers: number;
  hostName: string;
  owner: string; // Creator key (client IP) for per-owner limits
  nonce: string; // Status-line token
  process: Deno.ChildProcess;
  createdAt: number;
  playerCount: number;
  statusActive: boolean; // Last `active` value reported on the status channel
  lastActiveTime: number; // Last time room had players (for idle cleanup)
  lastOutputTime: number; // Last stdout/stderr line seen from room process
  lastWatchdogTime: number; // Last watchdog tick seen from room stderr
  ready: boolean; // Startup finished; only ready rooms are listed or joinable
  exited: boolean;
  killTimer: ReturnType<typeof setTimeout> | null;
}

function isRoomResponsive(room: RoomProcess, now: number): boolean {
  // Give freshly-created rooms time to boot before enforcing watchdog freshness.
  if (now - room.createdAt < ROOM_STARTUP_GRACE_MS) {
    return true;
  }

  return (now - room.lastWatchdogTime) <= ROOM_JOIN_STALE_MS;
}

// Active (listed) room processes
const roomProcesses = new Map<string, RoomProcess>();

// Every spawned process that has not exited yet, including rooms that were
// terminated but are still shutting down. Used by RoomManager_ShutdownAll.
const liveRooms = new Set<RoomProcess>();

// Ports held by a live process. A port is released only when its process
// exits, so a new room can't be handed a port the old one still has bound.
const usedPorts = new Set<number>();

// Configuration (set by main server)
let certFile = "cert.pem";
let keyFile = "key.pem";
let pakPath = "../" + GD_PAK;
let denoPath = Deno.execPath();
let gameFlags: string[] = []; // -rogue, -hipnotic, -quoth: passed to every room
let gameDir: string | null = null; // -game <dir>, passed to every room
// Rooms also take WebSocket connections from the lobby's proxy (-wsport on
// the lobby): -wsport <room port> on 127.0.0.1, over TCP
let wsEnabled = false;

/**
 * Configure paths for room servers
 */
export function RoomManager_SetConfig(config: {
  certFile?: string;
  keyFile?: string;
  pakPath?: string;
  denoPath?: string;
  gameFlags?: string[];
  gameDir?: string | null;
  wsEnabled?: boolean;
}): void {
  if (config.certFile != null) certFile = config.certFile;
  if (config.keyFile != null) keyFile = config.keyFile;
  if (config.pakPath != null) pakPath = config.pakPath;
  if (config.denoPath != null) denoPath = config.denoPath;
  if (config.gameFlags != null) {
    gameFlags = config.gameFlags.filter((f) =>
      f === "-rogue" || f === "-hipnotic" || f === "-quoth"
    );
  }
  if (config.wsEnabled !== undefined) wsEnabled = config.wsEnabled === true;
  if (config.gameDir !== undefined) {
    gameDir = config.gameDir !== null && COM_GameDirIsValid(config.gameDir) ?
      config.gameDir :
      null;
  }
}

// ROOM CONFIG VALIDATION

/**
 * Game options a client may request for a new room: the Game Options menu's
 * rows (WinQuake/menu.c M_GameOptions_Key). Each field maps to the cvar of
 * the same name; GAME_OPTION_RANGES (room_config.js) has the ranges.
 */
export interface GameOptions {
  coop?: number;
  teamplay?: number;
  skill?: number;
  fraglimit?: number;
  timelimit?: number;
}

/** Room_ClampMaxPlayers in room_config.js. */
export function RoomManager_ClampMaxPlayers(value: unknown): number {
  return Room_ClampMaxPlayers(value);
}

/**
 * Room_SanitizeGameOptions in room_config.js, with teamplay's range widened
 * when the lobby serves Rogue.
 */
export function RoomManager_SanitizeGameOptions(
  value: unknown,
): GameOptions | undefined {
  // -game rogue runs Rogue too (game_server.js configIsRogue)
  const isRogue = gameFlags.includes("-rogue") ||
    (gameDir !== null && gameDir.toLowerCase() === "rogue");
  return Room_SanitizeGameOptions(value, isRogue);
}

/** -coop N -skill N ... for sanitized options (integers only). */
function gameOptionArgs(options: GameOptions | undefined): string[] {
  const args: string[] = [];
  if (options === undefined) return args;
  for (const key of Object.keys(GAME_OPTION_RANGES) as (keyof GameOptions)[]) {
    const n = options[key];
    if (n !== undefined) args.push("-" + key, String(n));
  }
  return args;
}

/** Room_SanitizeHostName in room_config.js. */
export function RoomManager_SanitizeHostName(value: unknown): string {
  return Room_SanitizeHostName(value);
}

/** Room_SanitizeMapName in room_config.js. */
export function RoomManager_SanitizeMapName(value: unknown): string | null {
  return Room_SanitizeMapName(value);
}

// CHILD STDOUT PARSING

/**
 * Split a byte stream into lines. Uses a streaming TextDecoder so multi-byte
 * characters split across chunks decode correctly, and buffers the partial
 * last line until its newline arrives.
 */
export function createLineSplitter(
  onLine: (line: string) => void,
  maxLineLength = 64 * 1024,
): {
  push: (chunk: Uint8Array) => void;
  flush: () => void;
} {
  const decoder = new TextDecoder();
  let pending = "";

  function emitLines(text: string): void {
    pending += text;
    let nl = pending.indexOf("\n");
    while (nl !== -1) {
      const line = pending.slice(0, nl).replace(/\r$/, "");
      pending = pending.slice(nl + 1);
      onLine(line);
      nl = pending.indexOf("\n");
    }
    // Guard against a child that never writes a newline
    if (pending.length > maxLineLength) {
      onLine(pending);
      pending = "";
    }
  }

  return {
    push(chunk: Uint8Array): void {
      emitLines(decoder.decode(chunk, { stream: true }));
    },
    flush(): void {
      emitLines(decoder.decode());
      if (pending.length > 0) {
        onLine(pending.replace(/\r$/, ""));
        pending = "";
      }
    },
  };
}

export interface RoomStatus {
  players: number;
  active: boolean;
}

/**
 * Parse a status line. Returns null unless the line starts with
 * STATUS_PREFIX, carries the expected nonce and has a valid payload.
 */
export function parseRoomStatusLine(
  line: string,
  nonce: string,
): RoomStatus | null {
  const head = STATUS_PREFIX + " " + nonce + " ";
  if (line.startsWith(head) === false) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(line.slice(head.length));
  } catch {
    return null;
  }
  if (payload === null || typeof payload !== "object") return null;
  const { players, active } = payload as {
    players?: unknown;
    active?: unknown;
  };
  if (
    typeof players !== "number" || Number.isInteger(players) === false ||
    players < 0
  ) return null;
  if (typeof active !== "boolean") return null;
  return { players, active };
}

/**
 * Format a status line (used by game_server.js; exported so the two ends
 * share one definition).
 */
export function formatRoomStatusLine(
  nonce: string,
  status: RoomStatus,
): string {
  return STATUS_PREFIX + " " + nonce + " " +
    JSON.stringify({ players: status.players, active: status.active });
}

// ROOM LIFECYCLE

/**
 * Generate a short room ID
 */
function generateRoomId(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let id = "";
  for (let i = 0; i < 6; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

function generateNonce(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Find an available port
 */
function findAvailablePort(): number | null {
  for (let i = 0; i < MAX_ROOMS; i++) {
    const port = BASE_PORT + i;
    if (!usedPorts.has(port)) {
      return port;
    }
  }
  return null;
}

/**
 * Apply a status update to a room record.
 */
function applyRoomStatus(
  room: RoomProcess,
  status: RoomStatus,
  now: number,
): void {
  const players = Math.min(status.players, room.maxPlayers);
  if (players !== room.playerCount) {
    Sys_Printf(
      "Room %s players: %d -> %d\n",
      room.id,
      room.playerCount,
      players,
    );
  }
  room.playerCount = players;
  room.statusActive = status.active;
  if (players > 0) {
    room.lastActiveTime = now;
  }
}

/**
 * Send SIGTERM, then SIGKILL if the process hasn't exited after a grace period.
 */
function killRoomProcess(room: RoomProcess): void {
  if (room.exited) return;
  try {
    room.process.kill("SIGTERM");
  } catch {
    // Process may have already exited
  }
  if (room.killTimer === null) {
    room.killTimer = setTimeout(() => {
      room.killTimer = null;
      if (room.exited) return;
      Sys_Printf(
        "Room %s did not exit after SIGTERM, sending SIGKILL\n",
        room.id,
      );
      try {
        room.process.kill("SIGKILL");
      } catch { /* already gone */ }
    }, ROOM_KILL_ESCALATION_MS);
  }
}

function absolutePath(p: string): string {
  return resolvePath(p);
}

/**
 * Create a new room by spawning a dedicated server process
 * If specificId is provided, use that ID instead of generating a random one
 */
export async function RoomManager_CreateRoom(config: {
  map: string;
  maxPlayers: number;
  hostName: string;
  gameOptions?: GameOptions;
  owner?: string;
  specificId?: string;
}): Promise<{ id: string; port: number } | null> {
  // Reclaim any frozen rooms before enforcing limits/port availability.
  RoomManager_CleanupUnhealthyRooms();

  // Check room limit
  if (roomProcesses.size >= MAX_ROOMS) {
    Sys_Printf("Room limit reached (%d), rejecting room creation\n", MAX_ROOMS);
    return null;
  }

  // Validate config (callers should already have done this; this is the
  // last line of defence before the values reach a child's argv)
  const safeMap = RoomManager_SanitizeMapName(config.map);
  if (safeMap === null) {
    Sys_Printf(
      "Invalid map name: %s\n",
      JSON.stringify(String(config.map).slice(0, 64)),
    );
    return null;
  }
  const maxPlayers = RoomManager_ClampMaxPlayers(config.maxPlayers);
  const hostName = RoomManager_SanitizeHostName(config.hostName);
  // Re-validated here too: only whitelisted integers reach the child's argv
  const gameOptions = RoomManager_SanitizeGameOptions(config.gameOptions);

  // Find available port
  const port = findAvailablePort();
  if (port === null) {
    Sys_Printf("No available ports for new room\n");
    return null;
  }

  // Generate unique room ID (or use specificId if provided)
  let id: string;
  if (config.specificId != null && config.specificId.length > 0) {
    // Check if specific ID is already in use
    if (roomProcesses.has(config.specificId.toUpperCase())) {
      Sys_Printf("Room ID %s already exists\n", config.specificId);
      return null;
    }
    id = config.specificId.toUpperCase();
  } else {
    id = generateRoomId();
    while (roomProcesses.has(id)) {
      id = generateRoomId();
    }
  }

  // Mark port as used (released by the exit handler, or below if spawn fails)
  usedPorts.add(port);

  Sys_Printf(
    "Creating room %s on port %d (map: %s, maxPlayers: %d)\n",
    id,
    port,
    safeMap,
    maxPlayers,
  );

  const nonce = generateNonce();
  let process: Deno.ChildProcess;
  try {
    const gameServerPath = fromFileUrl(
      new URL("./game_server.js", import.meta.url),
    );
    const denoJsonPath = fromFileUrl(new URL("../deno.json", import.meta.url));
    const staticDir = fromFileUrl(new URL("../static/", import.meta.url));

    const absPak = absolutePath(pakPath);
    const absCert = absolutePath(certFile);
    const absKey = absolutePath(keyFile);
    // game_server.js gameDirectories loads <basedir>/rogue, hipnotic, quoth
    // or the -game dir, where basedir is the pak's directory, or its parent when
    // that directory is id1
    const pakDir = dirname(absPak);
    const basedir = basename(pakDir).toLowerCase() === "id1" ?
      dirname(pakDir) :
      pakDir;
    const gameNames = gameFlags.map((f) => f.slice(1));
    if (gameDir !== null) gameNames.push(gameDir);
    const gameDirs = gameNames.map((name) => basedir + "/" + name);
    // The pak's own directory too: the pak sequence (pak1.pak...) and loose
    // maps, .lit files and the like (game_server.js's loose-file base path).
    const readPaths = [staticDir, pakDir, absPak, absCert, absKey, ...gameDirs];
    if (readPaths.some((p) => p.includes(","))) {
      throw new Error("paths passed to --allow-read must not contain commas");
    }

    // Spawn dedicated server process for this room. Permissions are
    // scoped to what the room needs: listen on its own UDP port (IPv6 and
    // IPv4, see quic_listen.ts), and on the same TCP port on 127.0.0.1
    // for the lobby's WebSocket proxy, read the pak and its directory, the
    // TLS files, loose files under static/ and the game directories (in the
    // pak's basedir, which may be outside static/).
    const command = new Deno.Command(denoPath, {
      args: [
        "run",
        "--allow-net=[::]:" + port + ",0.0.0.0:" + port +
        (wsEnabled ? ",127.0.0.1:" + port : ""),
        "--allow-read=" + readPaths.join(","),
        "--unstable-net",
        "--config",
        denoJsonPath,
        gameServerPath,
        "-port",
        String(port),
        "-maxclients",
        String(maxPlayers),
        "-map",
        safeMap,
        "-pak",
        absPak,
        "-cert",
        absCert,
        "-key",
        absKey,
        "-room",
        id, // Pass room ID so process can identify itself
        "-statusnonce",
        nonce,
        "-parentwatch", // Exit when our stdin closes (lobby died)
        ...gameFlags,
        ...gameOptionArgs(gameOptions),
        ...(gameDir !== null ? ["-game", gameDir] : []),
        ...(wsEnabled ? ["-wsport", String(port)] : []),
      ],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    });

    process = command.spawn();
  } catch (error) {
    Sys_Printf("Failed to create room: %s\n", (error as Error).message);
    usedPorts.delete(port);
    return null;
  }

  // Store room info
  const now = Date.now();
  const roomInfo: RoomProcess = {
    id,
    map: safeMap,
    port,
    maxPlayers,
    hostName,
    owner: config.owner ?? "",
    nonce,
    process,
    createdAt: now,
    playerCount: 0,
    statusActive: false,
    lastActiveTime: now, // Initialize to creation time
    lastOutputTime: now,
    lastWatchdogTime: now,
    ready: false,
    exited: false,
    killTimer: null,
  };
  roomProcesses.set(id, roomInfo);
  liveRooms.add(roomInfo);

  // Startup completes when the room has bound its port ("WebTransport server
  // listening") and reported an active server on the status channel.
  let sawListening = false;
  let settled = false;
  let resolveReady: () => void = () => {};
  let rejectReady: (e: Error) => void = () => {};
  const readyPromise = new Promise<void>((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });
  const failStartup = (message: string) => {
    if (settled) return;
    settled = true;
    rejectReady(new Error(message));
  };
  const checkReady = () => {
    if (settled) return;
    if (sawListening && roomInfo.statusActive) {
      settled = true;
      resolveReady();
    }
  };

  // Parse stdout: status lines update the room; everything else is relayed.
  const stdoutSplitter = createLineSplitter((line) => {
    if (line.trim() === "") return;
    const t = Date.now();
    roomInfo.lastOutputTime = t;

    const status = parseRoomStatusLine(line, nonce);
    if (status !== null) {
      applyRoomStatus(roomInfo, status, t);
      if (status.active === false && settled === false) {
        failStartup("Room reported an inactive server");
      }
      checkReady();
      return; // Don't relay status lines to the lobby log
    }

    Sys_Printf("[Room %s] %s\n", id, line);

    if (line.startsWith("WebTransport server listening")) {
      sawListening = true;
      checkReady();
    } else if (line.startsWith("Failed to start WebTransport listener")) {
      failStartup(line);
    }
  });

  const stderrSplitter = createLineSplitter((line) => {
    if (line.trim() === "") return;
    const t = Date.now();
    roomInfo.lastOutputTime = t;
    if (line.startsWith("[WATCHDOG]")) {
      roomInfo.lastWatchdogTime = t;
      return; // One every 5s per room: too noisy to relay
    }
    Sys_Printf("[Room %s ERR] %s\n", id, line);
  });

  const pump = async (
    stream: ReadableStream<Uint8Array>,
    splitter: ReturnType<typeof createLineSplitter>,
  ) => {
    try {
      for await (const chunk of stream) {
        splitter.push(chunk);
      }
    } catch { /* stream closed */ }
    splitter.flush();
  };

  pump(process.stdout, stdoutSplitter).then(() => {
    failStartup("Process stdout closed before server was ready");
  });
  pump(process.stderr, stderrSplitter);

  // Monitor process exit
  process.status.then((status) => {
    Sys_Printf("Room %s process exited with code %d\n", id, status.code);
    roomInfo.exited = true;
    if (roomInfo.killTimer !== null) {
      clearTimeout(roomInfo.killTimer);
      roomInfo.killTimer = null;
    }
    liveRooms.delete(roomInfo);
    // The port was held by this process until now, so it is ours to free.
    usedPorts.delete(port);
    // The id may already belong to a newer room (terminated + recreated).
    if (roomProcesses.get(id) === roomInfo) {
      roomProcesses.delete(id);
    }
    failStartup("Process exited with code " + status.code);
  });

  // Wait for the server to signal it's ready (or timeout)
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error("Server startup timeout")),
      ROOM_STARTUP_TIMEOUT_MS,
    );
  });

  try {
    await Promise.race([readyPromise, timeoutPromise]);
  } catch (startupError) {
    settled = true;
    Sys_Printf(
      "Room %s failed to start: %s\n",
      id,
      (startupError as Error).message,
    );
    if (roomProcesses.get(id) === roomInfo) {
      roomProcesses.delete(id);
    }
    killRoomProcess(roomInfo);
    return null;
  } finally {
    clearTimeout(timeoutId);
  }

  roomInfo.ready = true;
  Sys_Printf("Room %s created successfully on port %d\n", id, port);

  return { id, port };
}

/**
 * Get info about a room
 */
export function RoomManager_GetRoom(id: string): {
  id: string;
  map: string;
  port: number;
  maxPlayers: number;
  hostName: string;
  playerCount: number;
  createdAt: number;
} | null {
  RoomManager_CleanupUnhealthyRooms();

  const room = roomProcesses.get(id.toUpperCase());
  if (room == null || room.ready === false) return null;
  if (isRoomResponsive(room, Date.now()) === false) return null;

  return {
    id: room.id,
    map: room.map,
    port: room.port,
    maxPlayers: room.maxPlayers,
    hostName: room.hostName,
    playerCount: room.playerCount,
    createdAt: room.createdAt,
  };
}

/**
 * List all active rooms
 */
export function RoomManager_ListRooms(): Array<{
  id: string;
  name: string;
  map: string;
  port: number;
  maxPlayers: number;
  playerCount: number;
}> {
  RoomManager_CleanupUnhealthyRooms();
  const now = Date.now();

  const rooms: Array<{
    id: string;
    name: string;
    map: string;
    port: number;
    maxPlayers: number;
    playerCount: number;
  }> = [];

  for (const room of roomProcesses.values()) {
    if (room.ready === false || isRoomResponsive(room, now) === false) {
      continue;
    }

    rooms.push({
      id: room.id,
      name: room.hostName + "'s Game",
      map: room.map,
      port: room.port,
      maxPlayers: room.maxPlayers,
      playerCount: room.playerCount,
    });
  }

  return rooms;
}

/**
 * Number of listed rooms created by `owner`.
 */
export function RoomManager_CountRoomsByOwner(owner: string): number {
  let count = 0;
  for (const room of roomProcesses.values()) {
    if (room.owner === owner) count++;
  }
  return count;
}

/**
 * Clean up unhealthy rooms (event loop freeze / no watchdog output).
 * Room servers emit watchdog lines every 5s. If we stop receiving watchdog
 * ticks for too long after startup, the process is considered wedged.
 */
export function RoomManager_CleanupUnhealthyRooms(): number {
  const now = Date.now();
  let cleaned = 0;

  for (const [id, room] of roomProcesses) {
    // Allow time for startup before enforcing watchdog checks.
    if (now - room.createdAt < ROOM_STARTUP_GRACE_MS) {
      continue;
    }

    const watchdogGapMs = now - room.lastWatchdogTime;
    if (watchdogGapMs > ROOM_WATCHDOG_TIMEOUT_MS) {
      Sys_Printf(
        "Room %s has no watchdog output for %ds, terminating stuck process\n",
        id,
        Math.floor(watchdogGapMs / 1000),
      );
      RoomManager_TerminateRoom(id);
      cleaned++;
    }
  }

  return cleaned;
}

/**
 * Update player count for a room (called via IPC or health check)
 */
export function RoomManager_UpdatePlayerCount(id: string, count: number): void {
  const room = roomProcesses.get(id);
  if (room != null) {
    applyRoomStatus(room, {
      players: Math.max(0, Math.floor(count)),
      active: room.statusActive,
    }, Date.now());
  }
}

/**
 * Terminate a room. The room is unlisted immediately; its port is released
 * once the process has actually exited.
 */
export function RoomManager_TerminateRoom(id: string): boolean {
  const room = roomProcesses.get(id);
  if (room == null) return false;

  Sys_Printf("Terminating room %s\n", id);

  roomProcesses.delete(id);
  killRoomProcess(room);

  return true;
}

/**
 * Clean up idle rooms (rooms with 0 players for too long). A room that
 * reports players is never reaped here.
 */
export function RoomManager_CleanupIdleRooms(
  maxIdleMs: number = 5 * 60 * 1000,
): number {
  RoomManager_CleanupUnhealthyRooms();

  const now = Date.now();
  let cleaned = 0;

  for (const [id, room] of roomProcesses) {
    // Check if room has been idle (0 players) for too long
    // Uses lastActiveTime which tracks when room last had players
    const idleTime = now - room.lastActiveTime;
    if (room.playerCount === 0 && idleTime > maxIdleMs) {
      Sys_Printf(
        "Room %s idle for %ds, terminating\n",
        id,
        Math.floor(idleTime / 1000),
      );
      RoomManager_TerminateRoom(id);
      cleaned++;
    }
  }

  return cleaned;
}

/**
 * Whether a room with this id exists, including one that is still starting.
 */
export function RoomManager_HasRoom(id: string): boolean {
  return roomProcesses.has(id.toUpperCase());
}

/**
 * Get room count (including rooms that are still starting)
 */
export function RoomManager_GetRoomCount(): number {
  return roomProcesses.size;
}

/**
 * Shutdown all rooms, including ones already terminating.
 * Sends SIGTERM to each; children also exit on their own when the lobby's
 * end of their stdin pipe closes.
 */
export function RoomManager_ShutdownAll(): void {
  Sys_Printf("Shutting down all room processes...\n");

  roomProcesses.clear();
  for (const room of liveRooms) {
    try {
      room.process.kill("SIGTERM");
    } catch { /* already gone */ }
  }
}
