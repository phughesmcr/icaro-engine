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
// working directory. Only the repository's data (game_data.js) is mounted. The SDK
// and zod are npm packages mapped in deno.json and server/deno.json (keep
// the two in step) and pinned in the root deno.lock.
//
// Protocol: the official MCP TypeScript SDK (@modelcontextprotocol/server)
// over stdio. serveStdio serves both protocol eras from one factory: clients
// that open with initialize (2024-11-05 to 2025-11-25) and 2026-07-28
// clients (server/discover, and a _meta envelope on each request). The SDK checks tool arguments against the
// zod schemas below before a handler runs. A bad argument comes back as a
// tool result with isError, and so does an error a handler throws.
//
// The game runs in lockstep: it advances only inside start, step, goto,
// attack and rl_step, one tic (1/72 s) at a time, so thinking time costs
// nothing. The SDK runs requests concurrently, so tool calls are queued here
// and run one at a time, in arrival order.
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

import { McpServer } from "@modelcontextprotocol/server";
import {
  serveStdio,
  StdioServerTransport,
} from "@modelcontextprotocol/server/stdio";
import type { StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import type { Readable, Writable } from "node:stream";
import * as z from "zod";
import { GD_MAPS, GD_TITLE } from "./game_data.js";

// deno-lint-ignore no-explicit-any
type Engine = { agent: any; sys: any; cmd: any; pak: any };

export const SERVER_INFO = { name: "icaro-engine", version: "0.2.0" };

// Virtual clock origin, seconds (any constant works; it only has to be the
// same on every seeded start)
const CLOCK_BASE = 1;

// Highest goto max_tics: GOTO_MAX_TICS in src/agent.js. The engine loads on
// the first call, so it can't be read here; tests/agent_goto_test.js checks
// that the two agree.
const GOTO_MAX_TICS = 8640;
const GOTO_DEFAULT_TICS = 72 * 30;

// attack's max_tics: ATTACK_MAX_TICS and ATTACK_DEFAULT_TICS in src/agent.js
// (tests/agent_attack_test.js checks that they agree)
const ATTACK_MAX_TICS = 4320;
const ATTACK_DEFAULT_TICS = 72 * 10;

// Largest map tier: MAP_MAX_SIZE in src/agent.js (tests/agent_map_test.js
// checks that the two agree)
const MAP_MAX_SIZE = 41;

const INSTRUCTIONS =
  `Plays Quake (${GD_TITLE}) headless. The game is frozen between calls and advances only in start, step, goto and attack (72 tics = 1 s of game time).
Start with start {map: "${GD_MAPS.level}", skill: 1}. Each result is an observation:
- a status line (map, time, hp, armor, weapon, ammo, keys, kills, secrets, pos, yaw, pitch);
- entity lines "#id kind distance yawN [pitchN] [hidden] [hpN]": step with {yaw: N} to face one;
- events since the last call (pickups, damage, messages, level changes);
- with map: N (step, goto, turn_to, attack, observe), an N x N ASCII map of 32-unit cells around you, turned so you are "^" at the centre facing up (left is left): . floor at your height, + higher (a ledge or stairs up), - lower (a drop), # wall, ~ water, ! slime or lava, blank nothing to stand on or not in view; D door, L lift, B button, E exit, T teleporter, M monster, P player, w weapon, k key, i other item, x explosive box, * projectile;
- "tic=N hash=H": tics since start and a hash of the game state.
step holds buttons for N tics, then releases them: buttons forward back moveleft moveright left right lookup lookdown jump attack speed up down strafe use. yaw: degrees, + turns left. pitch: + looks down. face: absolute yaw. impulse 1-8 selects a weapon.
Quake has no use key: walk into buttons and doors; shoot some buttons. "exit" entities are level exits: walk into them.
goto {id} or goto {pos: [x, y, z]} walks there along the level's walk graph (doors, lifts, teleporters, drops and jumps included) and stops early when hurt; when blocked it names what blocks the way and how it opens (a key, a button #id, shoot it).
turn_to {id} faces an entity (or {yaw} an absolute yaw) without advancing the game. attack {id} aims at it every tic and fires while it is in sight, until it is killed, gone, out of sight, you are out of ammo (or have only the axe and are out of reach), hurt to death, or max_tics; it doesn't move.
goto and attack also stop when a monster comes into sight ("new enemy #id kind ..."): attack it, or call again with stop_on_enemy: false. Each monster stops only one call.
cmd runs console commands (god, give, map ${GD_MAPS.next}, ...). key and menu drive the menus.
rl_spec and rl_step are for RL programs, not for reading: a fixed-size numeric observation (JSON), a MultiDiscrete action and a reward.
screenshot has no pixels here (no renderer headless): it says so. Read the observation's text instead.`;

const BUTTONS_DESC =
  "Buttons held for the step, comma separated: forward back moveleft moveright left right lookup lookdown jump attack speed up down strafe use";

// Out-of-range values are errors, not clamped, so a logged call replays as
// it was written
const int = (min: number, max: number) => z.number().int().min(min).max(max);
const ents = int(0, 64).optional().describe("Entities to list (default 10)");
const stop_on_enemy = z.boolean().optional().describe(
  "Stop when a monster comes into sight that no goto or attack has reported yet (default true)",
);
const map = int(0, MAP_MAX_SIZE).optional().describe(
  "Add an ASCII map this many 32-unit cells across (odd; 21 is a good size; default 0, none)",
);

// Tool argument schemas. Strict: an unknown argument is an error.

// The screen tier needs WebGL, which the headless host doesn't have
const SCREENSHOT_HEADLESS =
  "screenshot: not available headless: this server has no renderer, so no pixels. Play in a browser (?agent=lockstep) for icaro.screenshot(width), a JPEG data URL, and icaro.screen_rgba(width, height), RGBA bytes; here, the observation's text, entity lines and map describe the view.";

const SCREENSHOT_ARGS = z.strictObject({
  width: int(32, 1920).optional().describe("Image width in pixels"),
});
const START_ARGS = z.strictObject({
  map: z.string().regex(/^[A-Za-z0-9_]+$/).optional().describe(
    "Map name, e.g. " + GD_MAPS.level + " (default) or " + GD_MAPS.hub,
  ),
  skill: int(0, 3).optional().describe(
    "0 easy, 1 normal (default), 2 hard, 3 nightmare",
  ),
  seed: z.number().int().optional().describe(
    "Seeds the gameplay randomness and the clock. Omit for an unseeded game",
  ),
});

const STEP_ARGS = z.strictObject({
  buttons: z.string().optional().describe(BUTTONS_DESC),
  yaw: z.number().optional().describe(
    "Turn by this many degrees first; + turns left",
  ),
  pitch: z.number().optional().describe(
    "Look by this many degrees first; + looks down",
  ),
  face: z.number().optional().describe("Face this absolute yaw first"),
  impulse: int(1, 255).optional().describe(
    "1-8 select a weapon (1 axe, 2 shotgun, ...)",
  ),
  tics: int(0, 72 * 60).optional().describe(
    "Tics to run (default 1; 72 = 1 s)",
  ),
  hold: z.boolean().optional().describe("Keep the buttons held after the step"),
  ents,
  map,
});

const GOTO_ARGS = z.strictObject({
  id: int(1, 65535).optional().describe(
    "Entity number, as #id in the observation",
  ),
  pos: z.array(z.number()).length(3).optional().describe(
    "A point [x, y, z] instead of an entity",
  ),
  max_tics: int(1, GOTO_MAX_TICS).optional().describe(
    "Give up after this many tics (default " + GOTO_DEFAULT_TICS +
      " = 30 s; at most " + GOTO_MAX_TICS + ")",
  ),
  stop_on_damage: z.boolean().optional().describe(
    "Stop when hurt (default true)",
  ),
  stop_on_enemy,
  ents,
  map,
});

const TURN_TO_ARGS = z.strictObject({
  id: int(1, 65535).optional().describe(
    "Entity number to face, as #id in the observation",
  ),
  yaw: z.number().optional().describe("An absolute yaw to face instead"),
  ents,
  map,
});

const ATTACK_ARGS = z.strictObject({
  id: int(1, 65535).describe("Entity number, as #id in the observation"),
  max_tics: int(1, ATTACK_MAX_TICS).optional().describe(
    "Give up after this many tics (default " + ATTACK_DEFAULT_TICS +
      " = 10 s; at most " + ATTACK_MAX_TICS + ")",
  ),
  stop_on_enemy,
  ents,
  map,
});

// rl limits: RL_MAX_ENTS, RL_MAX_RAYS, RL_MAX_TICS and RL_DEFAULT_TICS in
// src/agent.js (tests/agent_rl_test.js checks that they agree)
const RL_MAX_ENTS = 64;
const RL_MAX_RAYS = 128;
const RL_MAX_TICS = 72 * 60;
const RL_DEFAULT_TICS = 4;

const RL_LAYOUT = {
  ents: int(0, RL_MAX_ENTS).optional().describe(
    "Entity slots, nearest first (default 16)",
  ),
  rays: int(0, RL_MAX_RAYS).optional().describe(
    "Wall-distance rays at eye height, evenly round from straight ahead (default 32)",
  ),
  map: int(0, MAP_MAX_SIZE).optional().describe(
    "Map tier cells across as codes (0 none, the default; else odd, 5 or more)",
  ),
  truth: z.boolean().optional().describe(
    "Server-side facts (monster hp, doors, exits). Default true",
  ),
};

const RL_SPEC_ARGS = z.strictObject(RL_LAYOUT);

const RL_STEP_ARGS = z.strictObject({
  action: z.array(z.number().int().min(0)).length(8).describe(
    "move strafe turn look attack jump speed weapon: one index each (rl_spec's action.values)",
  ),
  tics: int(0, RL_MAX_TICS).optional().describe(
    "Tics to run (default " + RL_DEFAULT_TICS + "); fewer if the episode ends",
  ),
  reward: z.strictObject({
    kill: z.number().optional(),
    secret: z.number().optional(),
    hurt: z.number().optional(),
    death: z.number().optional(),
    exit: z.number().optional(),
    tic: z.number().optional(),
  }).optional().describe("Reward weights over the defaults in rl_spec"),
  ...RL_LAYOUT,
});

const OBSERVE_ARGS = z.strictObject({
  ents,
  truth: z.boolean().optional().describe(
    "Add server-side facts (monster hp, doors, exits). Default true",
  ),
  map,
});

const CMD_ARGS = z.strictObject({ text: z.string() });

const KEY_ARGS = z.strictObject({
  name: z.string(),
  count: int(1, 64).optional().describe("Presses (default 1)"),
});

const MENU_ARGS = z.strictObject({ label: z.string() });

// ENGINE

let engine: Promise<Engine> | null = null;
let game_origin = 0; // Agent_Tics() when the current game started

// Loads the engine and starts the headless host in lockstep (once)
export function agent_mcp_engine(): Promise<Engine> {
  if (engine !== null) return engine;
  engine = (async () => {
    const headless = await import("./headless_host.js");
    await headless.headless_init();
    const e: Engine = {
      agent: await import("../src/agent.js"),
      pak: await import("../src/pak.js"),
      sys: await import("../src/sys.js"),
      cmd: await import("../src/cmd.js"),
    };
    e.agent.Agent_Attach("lockstep");
    return e;
  })();
  return engine;
}

// The browser hints in agent.js's text name window.icaro calls
function mcp_text(text: string): string {
  return text.replaceAll('icaro.new_game("lq_e1m1", 1)', "the start tool")
    .replaceAll("icaro.cmd", "the cmd tool");
}

function footer(e: Engine): string {
  const hash = e.agent.Agent_StateHash();
  return "tic=" + (e.agent.Agent_Tics() - game_origin) +
    (hash !== "" ? " hash=" + hash : "");
}

/**
 * Seeds before the map loads, after the old game is gone, so the load and
 * everything after it draw from the seeded generator and the virtual clock.
 * Without a seed, both go back to the engine's defaults.
 */
async function agent_mcp_start(
  e: Engine,
  args: z.infer<typeof START_ARGS>,
): Promise<string> {
  const map = args.map ?? GD_MAPS.level;
  // Check the map before ending the running game
  if (await e.pak.COM_EnsureFile("maps/" + map + ".bsp") !== true) {
    throw new Error('no map "' + map + '"');
  }

  e.cmd.Cmd_ExecuteString("disconnect", e.cmd.src_command);
  game_origin = e.agent.Agent_Tics();
  if (args.seed !== undefined) {
    e.sys.Sys_SetRandomSeed(args.seed);
    const origin = game_origin;
    e.sys.Sys_SetClockOverride(() =>
      CLOCK_BASE + (e.agent.Agent_Tics() - origin) * e.agent.AGENT_TIC
    );
  } else {
    e.sys.Sys_SetRandomSeed(null);
    e.sys.Sys_SetClockOverride(null);
  }

  return await e.agent.Agent_NewGame(map, args.skill ?? 1);
}

// TOOLS

// Calls run one at a time, in arrival order
let call_queue: Promise<unknown> = Promise.resolve();

// Wraps a tool body: queues it, loads the engine, and adds the footer
function tool<A>(body: (e: Engine, args: A) => Promise<string> | string) {
  return (args: A) => {
    const run = call_queue.then(async () => {
      try {
        const e = await agent_mcp_engine();
        const text = await body(e, args);
        return {
          content: [{
            type: "text" as const,
            text: mcp_text(text) + "\n" + footer(e),
          }],
        };
      } catch (err) {
        const text = "error: " +
          (err instanceof Error ? err.message : String(err));
        return { content: [{ type: "text" as const, text }], isError: true };
      }
    });
    call_queue = run.catch(() => {});
    return run;
  };
}

// Resolves once every queued call has finished and its reply has had a turn
// to be written
export async function agent_mcp_drain(): Promise<void> {
  let q;
  do {
    q = call_queue;
    await q;
    await new Promise((r) => setTimeout(r, 0));
  } while (q !== call_queue);
}

const LOCAL = { destructiveHint: false, openWorldHint: false };

/**
 * Builds the server with the tools. serveStdio calls it once per connection.
 */
export function agent_mcp_server(): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });

  server.registerTool("start", {
    description:
      "Starts a new single-player game and returns the first observation. A seed makes the run reproducible.",
    inputSchema: START_ARGS,
    annotations: { ...LOCAL, idempotentHint: false },
  }, tool(agent_mcp_start));

  server.registerTool(
    "step",
    {
      description:
        "Holds buttons and turns for a number of tics (1/72 s each), then returns the observation.",
      inputSchema: STEP_ARGS,
      annotations: { ...LOCAL, idempotentHint: false },
    },
    tool((e, args: z.infer<typeof STEP_ARGS>) => {
      const action: Record<string, unknown> = {};
      for (
        const k of [
          "buttons",
          "yaw",
          "pitch",
          "face",
          "impulse",
          "hold",
        ] as const
      ) {
        if (args[k] !== undefined) action[k] = args[k];
      }
      return e.agent.Agent_Step(action, args.tics ?? 1, {
        ents: args.ents ?? 10,
        map: args.map ?? 0,
      });
    }),
  );

  server.registerTool(
    "goto",
    {
      description:
        "Walks to an entity (#id from the observation) or a point along the level's walk graph, then returns the observation. The first line says how it ended: arrived, blocked (and by what), took damage, new enemy, died, level changed, no path, or timeout.",
      inputSchema: GOTO_ARGS,
      annotations: { ...LOCAL, idempotentHint: false },
    },
    tool((e, args: z.infer<typeof GOTO_ARGS>) => {
      if (
        (args.id === undefined) === (args.pos === undefined)
      ) throw new Error("goto takes id or pos (one of them)");
      return e.agent.Agent_Goto(args.id ?? args.pos, {
        max_tics: args.max_tics ?? GOTO_DEFAULT_TICS,
        stop_on_damage: args.stop_on_damage !== false,
        stop_on_enemy: args.stop_on_enemy !== false,
        ents: args.ents ?? 10,
        map: args.map ?? 0,
      });
    }),
  );

  server.registerTool(
    "turn_to",
    {
      description:
        "Faces an entity (#id, aiming at its centre) or an absolute yaw at once, without advancing the game, then returns the observation.",
      inputSchema: TURN_TO_ARGS,
      annotations: { ...LOCAL, idempotentHint: true },
    },
    tool((e, args: z.infer<typeof TURN_TO_ARGS>) => {
      if (
        (args.id === undefined) === (args.yaw === undefined)
      ) throw new Error("turn_to takes id or yaw (one of them)");
      return e.agent.Agent_TurnTo(args.id ?? { yaw: args.yaw }, {
        ents: args.ents ?? 10,
        map: args.map ?? 0,
      });
    }),
  );

  server.registerTool(
    "attack",
    {
      description:
        "Aims at an entity (#id) every tic and fires while it is in sight, without moving, then returns the observation. The first line says how it ended: killed, gone, out of sight, out of ammo, out of reach (axe), new enemy, died, level changed, or timeout.",
      inputSchema: ATTACK_ARGS,
      annotations: { ...LOCAL, idempotentHint: false },
    },
    tool((e, args: z.infer<typeof ATTACK_ARGS>) =>
      e.agent.Agent_Attack(args.id, {
        max_tics: args.max_tics ?? ATTACK_DEFAULT_TICS,
        stop_on_enemy: args.stop_on_enemy !== false,
        ents: args.ents ?? 10,
        map: args.map ?? 0,
      })
    ),
  );

  server.registerTool(
    "observe",
    {
      description:
        "Returns the observation without advancing the game. Events are returned once.",
      inputSchema: OBSERVE_ARGS,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tool((e, args: z.infer<typeof OBSERVE_ARGS>) =>
      e.agent.Agent_Observe({
        ents: args.ents ?? 10,
        truth: args.truth !== false,
        map: args.map ?? 0,
      })
    ),
  );

  server.registerTool(
    "rl_spec",
    {
      description:
        "For RL programs: the layout of rl_step's numeric observation (size, field offsets, per-element low and high), its action components, and the default reward weights, as JSON.",
      inputSchema: RL_SPEC_ARGS,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tool((e, args: z.infer<typeof RL_SPEC_ARGS>) =>
      JSON.stringify(e.agent.Agent_RLSpec(args))
    ),
  );

  server.registerTool(
    "rl_step",
    {
      description:
        "For RL programs: applies an action vector for some tics and returns one line of JSON {obs, reward, terminated, why, tics} (layout from rl_spec, values to 3 decimals). Start a game with start first; after terminated, start again.",
      inputSchema: RL_STEP_ARGS,
      annotations: { ...LOCAL, idempotentHint: false },
    },
    tool(async (e, args: z.infer<typeof RL_STEP_ARGS>) => {
      const { action, tics, ...opts } = args;
      const r = await e.agent.Agent_RLStep(
        action,
        tics ?? RL_DEFAULT_TICS,
        opts,
      );
      return JSON.stringify({
        obs: Array.from(r.obs, (v: number) => Math.round(v * 1000) / 1000),
        reward: Math.round(r.reward * 1e6) / 1e6,
        terminated: r.terminated,
        why: r.why,
        tics: r.tics,
      });
    }),
  );

  server.registerTool(
    "cmd",
    {
      description:
        `Runs Quake console text (e.g. "god", "give s 50", "map ${GD_MAPS.next}") and returns what it printed. In a game it runs one tic, or two for commands the server runs (god, give, kill).`,
      inputSchema: CMD_ARGS,
      annotations: LOCAL,
    },
    tool(async (e, args: z.infer<typeof CMD_ARGS>) => {
      const out = await e.agent.Agent_Command(args.text);
      return out !== "" ? out : "(no output)";
    }),
  );

  server.registerTool(
    "key",
    {
      description:
        "Presses a key for the menus or console: one character, or enter escape up down left right tab backspace space ` ~",
      inputSchema: KEY_ARGS,
      annotations: LOCAL,
    },
    tool((e, args: z.infer<typeof KEY_ARGS>) =>
      e.agent.Agent_Key(args.name, args.count ?? 1)
    ),
  );

  server.registerTool(
    "menu",
    {
      description:
        "Selects the open menu row whose label contains the text (main, single player and multiplayer menus).",
      inputSchema: MENU_ARGS,
      annotations: LOCAL,
    },
    tool((e, args: z.infer<typeof MENU_ARGS>) =>
      e.agent.Agent_MenuSelect(args.label)
    ),
  );

  server.registerTool(
    "screenshot",
    {
      description:
        "An image of the view. Not available here: this server plays headless, with no renderer, so it always returns an error. In a browser, icaro.screenshot() and icaro.screen_rgba() give the pixels.",
      inputSchema: SCREENSHOT_ARGS,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tool(() => {
      throw new Error(SCREENSHOT_HEADLESS);
    }),
  );

  return server;
}

/**
 * Serves MCP over a pair of streams (the process's stdin and stdout, or a
 * test's), one JSON-RPC message per line.
 */
export function agent_mcp_serve(
  input: Readable,
  output: Writable,
  onclose?: () => void,
): StdioServerHandle {
  return serveStdio(() => {
    const server = agent_mcp_server();
    if (onclose !== undefined) server.server.onclose = onclose;
    return server;
  }, {
    transport: new StdioServerTransport(input, output),
    onerror: (err: Error) => console.error("agent_mcp: " + err.message),
  });
}

if (import.meta.main) {
  // stdout carries only protocol messages: engine output goes to stderr
  console.log = console.error;
  console.info = console.error;
  console.debug = console.error;
  const process = (await import("node:process")).default;
  const { PassThrough } = await import("node:stream");
  // At end of input the SDK closes the connection and drops replies still
  // owed, so input ends here only after the queued calls have answered
  // (a client may pipe a script of calls and close stdin).
  const input = new PassThrough();
  process.stdin.pipe(input, { end: false });
  process.stdin.on("end", () => {
    agent_mcp_drain().then(() => input.end());
  });
  // agent.js's MessageChannel keeps the event loop alive: exit once the
  // connection is closed and stdout has flushed
  agent_mcp_serve(input, process.stdout, () => {
    process.stdout.write("", () => Deno.exit(0));
  });
}
