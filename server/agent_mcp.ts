// MCP server for agents: plays Quake headless (server/headless_host.js) and
// exposes the agent API of src/agent.js (window.icaro in the browser) as MCP
// tools, so Claude Code and other MCP clients can play without a browser.
// Web-only addition: no C counterpart. The design is
// docs/agent-interface.md ("MCP server on Deno").
//
//   deno task agent-mcp          (stdio)
//   claude mcp add icaro -- deno run --no-prompt --allow-read=static server/agent_mcp.ts
//
// Both run from the repository root: --allow-read=static is relative to the
// working directory. Only static/pak0.pak (shareware) is mounted.
//
// Transport: stdio, one JSON-RPC message per line. The legacy MCP
// lifecycle (initialize, then tools/list and tools/call) is implemented for
// the versions in MCP_VERSIONS. A request that names a newer version in its
// _meta gets the UnsupportedProtocolVersion error with that list, so the
// client can fall back to initialize.
//
// The game runs in lockstep: it advances only inside start and step, one
// tic (1/72 s) at a time, so thinking time costs nothing. Tool calls run one
// at a time, in order.
//
// Determinism: start with a seed seeds the server's gameplay randomness
// (Sys_SetRandomSeed) and replaces the clock with a virtual one that
// advances one tic per frame (Sys_SetClockOverride). The same seed, map,
// skill and calls then give the same state: every result ends with the tic
// count and a hash of the server's state (Agent_StateHash) to compare.
//
// The engine prints to console.log, and stdout belongs to the protocol, so
// the stdio entry point sends console output to stderr before it loads the
// engine. Engine modules are loaded on the first tool call.

// deno-lint-ignore no-explicit-any
type Engine = { agent: any; sys: any; cmd: any; pak: any };

type JsonRpcId = string | number | null;
type JsonRpcMessage = {
	jsonrpc?: string;
	id?: JsonRpcId;
	method?: string;
	params?: Record<string, unknown>;
};

// Newest first. 2026-07-28 drops the initialize handshake; it isn't
// implemented.
export const MCP_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const MCP_UNSUPPORTED_VERSION = -32022;
const META_VERSION = 'io.modelcontextprotocol/protocolVersion';

const SERVER_INFO = { name: 'icaro-engine', version: '0.1.0' };

// Virtual clock origin, seconds (any constant works; it only has to be the
// same on every seeded start)
const CLOCK_BASE = 1;

const INSTRUCTIONS = `Plays Quake (id1 shareware episode 1) headless. The game is frozen between calls and advances only in start and step (72 tics = 1 s of game time).
Start with start {map: "e1m1", skill: 1}. Each result is an observation:
- a status line (map, time, hp, armor, weapon, ammo, keys, kills, secrets, pos, yaw, pitch);
- entity lines "#id kind distance yawN [pitchN] [hidden] [hpN]": step with {yaw: N} to face one;
- events since the last call (pickups, damage, messages, level changes);
- "tic=N hash=H": tics since start and a hash of the game state.
step holds buttons for N tics, then releases them: buttons forward back moveleft moveright left right lookup lookdown jump attack speed up down strafe use. yaw: degrees, + turns left. pitch: + looks down. face: absolute yaw. impulse 1-8 selects a weapon.
Quake has no use key: walk into buttons and doors; shoot some buttons. "exit" entities are level exits: walk into them.
cmd runs console commands (god, give, map e1m2, ...). key and menu drive the menus.`;

const BUTTONS_DESC = 'Buttons held for the step, comma separated: forward back moveleft moveright left right lookup lookdown jump attack speed up down strafe use';

export const MCP_TOOLS = [
	{
		name: 'start',
		description: 'Starts a new single-player game and returns the first observation. A seed makes the run reproducible.',
		inputSchema: {
			type: 'object',
			properties: {
				map: { type: 'string', description: 'Map name, e.g. e1m1 (default) or start', pattern: '^[A-Za-z0-9_]+$' },
				skill: { type: 'integer', minimum: 0, maximum: 3, description: '0 easy, 1 normal (default), 2 hard, 3 nightmare' },
				seed: { type: 'integer', description: 'Seeds the gameplay randomness and the clock. Omit for an unseeded game' },
			},
			additionalProperties: false,
		},
		annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false },
	},
	{
		name: 'step',
		description: 'Holds buttons and turns for a number of tics (1/72 s each), then returns the observation.',
		inputSchema: {
			type: 'object',
			properties: {
				buttons: { type: 'string', description: BUTTONS_DESC },
				yaw: { type: 'number', description: 'Turn by this many degrees first; + turns left' },
				pitch: { type: 'number', description: 'Look by this many degrees first; + looks down' },
				face: { type: 'number', description: 'Face this absolute yaw first' },
				impulse: { type: 'integer', minimum: 1, maximum: 255, description: '1-8 select a weapon (1 axe, 2 shotgun, ...)' },
				tics: { type: 'integer', minimum: 0, maximum: 4320, description: 'Tics to run (default 1; 72 = 1 s)' },
				hold: { type: 'boolean', description: 'Keep the buttons held after the step' },
				ents: { type: 'integer', minimum: 0, maximum: 64, description: 'Entities to list (default 10)' },
			},
			additionalProperties: false,
		},
		annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false },
	},
	{
		name: 'observe',
		description: 'Returns the observation without advancing the game. Events are returned once.',
		inputSchema: {
			type: 'object',
			properties: {
				ents: { type: 'integer', minimum: 0, maximum: 64, description: 'Entities to list (default 10)' },
				truth: { type: 'boolean', description: 'Add server-side facts (monster hp, doors, exits). Default true' },
			},
			additionalProperties: false,
		},
		annotations: { readOnlyHint: true, openWorldHint: false },
	},
	{
		name: 'cmd',
		description: 'Runs Quake console text (e.g. "god", "give s 50", "map e1m2") and returns what it printed. In a game it runs one tic.',
		inputSchema: {
			type: 'object',
			properties: { text: { type: 'string' } },
			required: ['text'],
			additionalProperties: false,
		},
		annotations: { destructiveHint: false, openWorldHint: false },
	},
	{
		name: 'key',
		description: 'Presses a key for the menus or console: one character, or enter escape up down left right tab backspace space ` ~',
		inputSchema: {
			type: 'object',
			properties: {
				name: { type: 'string' },
				count: { type: 'integer', minimum: 1, maximum: 64, description: 'Presses (default 1)' },
			},
			required: ['name'],
			additionalProperties: false,
		},
		annotations: { destructiveHint: false, openWorldHint: false },
	},
	{
		name: 'menu',
		description: 'Selects the open menu row whose label contains the text (main, single player and multiplayer menus).',
		inputSchema: {
			type: 'object',
			properties: { label: { type: 'string' } },
			required: ['label'],
			additionalProperties: false,
		},
		annotations: { destructiveHint: false, openWorldHint: false },
	},
];

/*
==============================================================================

	ENGINE

==============================================================================
*/

let engine: Promise<Engine> | null = null;
let game_origin = 0; // Agent_Tics() when the current game started

// Loads the engine and starts the headless host in lockstep (once)
export function agent_mcp_engine(): Promise<Engine> {
	if (engine !== null) return engine;
	engine = (async () => {
		const headless = await import('./headless_host.js');
		await headless.headless_init();
		const e: Engine = {
			agent: await import('../src/agent.js'),
			pak: await import('../src/pak.js'),
			sys: await import('../src/sys.js'),
			cmd: await import('../src/cmd.js'),
		};
		e.agent.Agent_Attach('lockstep');
		return e;
	})();
	return engine;
}

// The browser hints in agent.js's text name window.icaro calls
function mcp_text(text: string): string {
	return text.replaceAll('icaro.new_game("e1m1", 1)', 'the start tool').replaceAll('icaro.cmd', 'the cmd tool');
}

function footer(e: Engine): string {
	const hash = e.agent.Agent_StateHash();
	return 'tic=' + (e.agent.Agent_Tics() - game_origin) + (hash !== '' ? ' hash=' + hash : '');
}

// Out-of-range values are errors, not clamped, so a logged call replays as
// it was written
function opt_int(args: Record<string, unknown>, name: string, def: number, min: number, max: number): number {
	const v = args[name];
	if (v === undefined) return def;
	if (typeof v !== 'number' || Number.isInteger(v) !== true || v < min || v > max) {
		throw new Error(name + ' must be an integer from ' + min + ' to ' + max);
	}
	return v;
}

function opt_num(args: Record<string, unknown>, name: string): number | undefined {
	const v = args[name];
	if (v === undefined) return undefined;
	if (typeof v !== 'number' || Number.isFinite(v) !== true) throw new Error(name + ' must be a number');
	return v;
}

function opt_str(args: Record<string, unknown>, name: string, def: string | null): string {
	const v = args[name];
	if (v === undefined && def !== null) return def;
	if (typeof v !== 'string') throw new Error(name + ' must be a string');
	return v;
}

/*
==================
agent_mcp_start

Seeds before the map loads, after the old game is gone, so the load and
everything after it draw from the seeded generator and the virtual clock.
Without a seed, both go back to the engine's defaults.
==================
*/
async function agent_mcp_start(e: Engine, args: Record<string, unknown>): Promise<string> {
	const map = opt_str(args, 'map', 'e1m1');
	const skill = opt_int(args, 'skill', 1, 0, 3);
	const seed = args.seed;
	if (seed !== undefined && (typeof seed !== 'number' || Number.isInteger(seed) !== true)) throw new Error('seed must be an integer');
	// Check the map before ending the running game
	if (/^[A-Za-z0-9_]+$/.test(map) !== true) throw new Error('bad map name ' + JSON.stringify(map));
	if (await e.pak.COM_EnsureFile('maps/' + map + '.bsp') !== true) throw new Error('no map "' + map + '"');

	e.cmd.Cmd_ExecuteString('disconnect', e.cmd.src_command);
	game_origin = e.agent.Agent_Tics();
	if (seed !== undefined) {
		e.sys.Sys_SetRandomSeed(seed);
		const origin = game_origin;
		e.sys.Sys_SetClockOverride(() => CLOCK_BASE + (e.agent.Agent_Tics() - origin) * e.agent.AGENT_TIC);
	} else {
		e.sys.Sys_SetRandomSeed(null);
		e.sys.Sys_SetClockOverride(null);
	}

	return await e.agent.Agent_NewGame(map, skill);
}

async function agent_mcp_call(name: string, args: Record<string, unknown>): Promise<string> {
	const e = await agent_mcp_engine();
	let text: string;
	switch (name) {
		case 'start':
			text = await agent_mcp_start(e, args);
			break;
		case 'step': {
			const action: Record<string, unknown> = {};
			if (args.buttons !== undefined) action.buttons = opt_str(args, 'buttons', null);
			for (const k of ['yaw', 'pitch', 'face']) {
				const v = opt_num(args, k);
				if (v !== undefined) action[k] = v;
			}
			if (args.impulse !== undefined) action.impulse = opt_int(args, 'impulse', 0, 1, 255);
			if (args.hold !== undefined) action.hold = args.hold === true;
			const tics = opt_int(args, 'tics', 1, 0, 72 * 60);
			text = await e.agent.Agent_Step(action, tics, { ents: opt_int(args, 'ents', 10, 0, 64) });
			break;
		}
		case 'observe':
			text = e.agent.Agent_Observe({ ents: opt_int(args, 'ents', 10, 0, 64), truth: args.truth !== false });
			break;
		case 'cmd': {
			const out = await e.agent.Agent_Command(opt_str(args, 'text', null));
			text = out !== '' ? out : '(no output)';
			break;
		}
		case 'key':
			text = e.agent.Agent_Key(opt_str(args, 'name', null), opt_int(args, 'count', 1, 1, 64));
			break;
		case 'menu':
			text = e.agent.Agent_MenuSelect(opt_str(args, 'label', null));
			break;
		default:
			throw new Error('unknown tool ' + name);
	}
	return mcp_text(text) + '\n' + footer(e);
}

/*
==============================================================================

	JSON-RPC

==============================================================================
*/

function rpc_result(id: JsonRpcId, result: unknown) {
	return { jsonrpc: '2.0', id, result };
}

function rpc_error(id: JsonRpcId, code: number, message: string, data?: unknown) {
	return { jsonrpc: '2.0', id, error: data !== undefined ? { code, message, data } : { code, message } };
}

// Calls run one at a time, in arrival order
let call_queue: Promise<unknown> = Promise.resolve();

/*
==================
agent_mcp_handle

Handles one JSON-RPC message and resolves with the response, or null for a
notification. Tool failures come back as results with isError, as MCP asks.
==================
*/
export function agent_mcp_handle(msg: unknown): Promise<unknown> {
	const run = call_queue.then(() => handle_now(msg));
	call_queue = run.catch(() => {});
	return run;
}

async function handle_now(raw: unknown): Promise<unknown> {
	if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
		return rpc_error(null, -32600, 'Invalid Request: expected one JSON-RPC object per line');
	}
	const msg = raw as JsonRpcMessage;
	const id = msg.id !== undefined ? msg.id : null;
	const is_request = msg.id !== undefined && msg.id !== null;
	if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
		// A response, or junk: nothing to reply to unless it has an id
		return is_request ? rpc_error(id, -32600, 'Invalid Request') : null;
	}
	if (is_request === false) return null; // notifications (initialized, cancelled)

	const params = msg.params !== undefined && msg.params !== null && typeof msg.params === 'object' ? msg.params : {};
	const meta = params._meta as Record<string, unknown> | undefined;
	const requested = meta !== undefined && meta !== null ? meta[META_VERSION] : undefined;
	if (typeof requested === 'string' && MCP_VERSIONS.includes(requested) === false) {
		return rpc_error(id, MCP_UNSUPPORTED_VERSION, 'Unsupported protocol version', { supported: MCP_VERSIONS, requested });
	}

	switch (msg.method) {
		case 'initialize': {
			const want = params.protocolVersion;
			const version = typeof want === 'string' && MCP_VERSIONS.includes(want) ? want : MCP_VERSIONS[0];
			return rpc_result(id, {
				protocolVersion: version,
				capabilities: { tools: { listChanged: false } },
				serverInfo: SERVER_INFO,
				instructions: INSTRUCTIONS,
			});
		}
		case 'ping':
			return rpc_result(id, {});
		case 'tools/list':
			return rpc_result(id, { tools: MCP_TOOLS });
		case 'tools/call': {
			const name = params.name;
			if (typeof name !== 'string' || MCP_TOOLS.some((t) => t.name === name) === false) {
				return rpc_error(id, -32602, 'Unknown tool: ' + String(name));
			}
			const args = params.arguments !== undefined && params.arguments !== null && typeof params.arguments === 'object'
				? params.arguments as Record<string, unknown>
				: {};
			try {
				const text = await agent_mcp_call(name, args);
				return rpc_result(id, { content: [{ type: 'text', text }], isError: false });
			} catch (err) {
				const text = 'error: ' + (err instanceof Error ? err.message : String(err));
				return rpc_result(id, { content: [{ type: 'text', text }], isError: true });
			}
		}
		default:
			return rpc_error(id, -32601, 'Method not found: ' + msg.method);
	}
}

/*
==================
agent_mcp_serve

Reads newline-delimited JSON-RPC from input and writes each response as one
line through write. Resolves when input ends.
==================
*/
export async function agent_mcp_serve(input: ReadableStream<Uint8Array>, write: (line: string) => Promise<void>) {
	let buf = '';
	const lines = input.pipeThrough(new TextDecoderStream());
	for await (const chunk of lines) {
		buf += chunk;
		let nl;
		while ((nl = buf.indexOf('\n')) >= 0) {
			const line = buf.slice(0, nl).trim();
			buf = buf.slice(nl + 1);
			if (line === '') continue;
			let msg: unknown;
			try {
				msg = JSON.parse(line);
			} catch {
				await write(JSON.stringify(rpc_error(null, -32700, 'Parse error')));
				continue;
			}
			const reply = await agent_mcp_handle(msg);
			if (reply !== null) await write(JSON.stringify(reply));
		}
	}
}

if (import.meta.main) {
	// stdout carries only protocol messages: engine output goes to stderr
	console.log = console.error;
	console.info = console.error;
	console.debug = console.error;
	const encoder = new TextEncoder();
	const out = Deno.stdout.writable.getWriter();
	await agent_mcp_serve(Deno.stdin.readable, (line) => out.write(encoder.encode(line + '\n')));
	// agent.js's MessageChannel keeps the event loop alive
	Deno.exit(0);
}
