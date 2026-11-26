// server/agent_mcp.ts: the MCP server over the headless host. Checks the
// JSON-RPC handling, and that a seeded game replayed from an action log ends
// in the same state (Agent_StateHash), even against the process's first game.

import { Sys_FloatTime, Sys_Random } from '../src/sys.js';
import { agent_mcp_handle, agent_mcp_serve, MCP_TOOLS, MCP_VERSIONS } from '../server/agent_mcp.ts';

function assert( cond, message ) {

	if ( cond !== true )
		throw new Error( message );

}

// agent.js keeps a MessageChannel open for its yields, and the host runs
// once per process, so the engine tests share it and skip the sanitizers
const ENGINE_TEST = { sanitizeResources: false, sanitizeOps: false };

let next_id = 1;
async function call( name, args = {} ) {

	const reply = await agent_mcp_handle( { jsonrpc: '2.0', id: next_id ++, method: 'tools/call', params: { name, arguments: args } } );
	assert( reply.result !== undefined, name + ': ' + JSON.stringify( reply ) );
	const text = reply.result.content[ 0 ].text;
	assert( reply.result.isError === false, name + ' failed: ' + text );
	return text;

}

function footer( text ) {

	const m = /\ntic=([0-9]+) hash=([0-9a-f]{8})$/.exec( text );
	assert( m !== null, 'no tic/hash footer in: ' + text );
	return { tic: Number( m[ 1 ] ), hash: m[ 2 ] };

}

Deno.test( 'agent_mcp: initialize negotiates the protocol version', async () => {

	const r = await agent_mcp_handle( { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } } );
	assert( r.result.protocolVersion === '2025-06-18', 'a supported version is echoed: ' + JSON.stringify( r ) );
	assert( r.result.capabilities.tools !== undefined, 'tools capability' );
	assert( typeof r.result.instructions === 'string' && r.result.instructions.length > 0, 'instructions' );

	const old = await agent_mcp_handle( { jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2000-01-01' } } );
	assert( old.result.protocolVersion === MCP_VERSIONS[ 0 ], 'an unknown version gets the newest supported one' );

	const modern = await agent_mcp_handle( { jsonrpc: '2.0', id: 3, method: 'server/discover', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } } } );
	assert( modern.error !== undefined && modern.error.code === - 32022, 'unsupported version error: ' + JSON.stringify( modern ) );
	assert( JSON.stringify( modern.error.data.supported ) === JSON.stringify( MCP_VERSIONS ), 'the error lists the supported versions' );

} );

Deno.test( 'agent_mcp: lists tools, ignores notifications, rejects unknown methods', async () => {

	const list = await agent_mcp_handle( { jsonrpc: '2.0', id: 'a', method: 'tools/list' } );
	assert( list.id === 'a', 'string ids are echoed' );
	const names = list.result.tools.map( ( t ) => t.name );
	assert( JSON.stringify( names ) === JSON.stringify( MCP_TOOLS.map( ( t ) => t.name ) ), 'tools: ' + names );
	for ( const t of list.result.tools )
		assert( t.inputSchema.type === 'object' && typeof t.description === 'string', t.name + ' schema' );

	assert( await agent_mcp_handle( { jsonrpc: '2.0', method: 'notifications/initialized' } ) === null, 'no reply to a notification' );
	const ping = await agent_mcp_handle( { jsonrpc: '2.0', id: 4, method: 'ping' } );
	assert( JSON.stringify( ping.result ) === '{}', 'ping' );
	const bad = await agent_mcp_handle( { jsonrpc: '2.0', id: 5, method: 'resources/list' } );
	assert( bad.error.code === - 32601, 'method not found' );
	const unknown = await agent_mcp_handle( { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'fly' } } );
	assert( unknown.error.code === - 32602, 'unknown tool' );
	const batch = await agent_mcp_handle( [ { jsonrpc: '2.0', id: 7, method: 'ping' } ] );
	assert( batch.error.code === - 32600, 'batches are rejected' );

} );

Deno.test( 'agent_mcp: stdio framing, one JSON reply per line', async () => {

	const input = [
		'{"jsonrpc":"2.0","id":1,"method":"ping"}',
		'',
		'not json',
		'{"jsonrpc":"2.0","method":"notifications/initialized"}',
		'{"jsonrpc":"2.0","id":2,"method":"tools/list"}',
	].join( '\n' ) + '\n';
	const bytes = new TextEncoder().encode( input );
	// Split mid-line, as a pipe may
	const stream = new ReadableStream( {
		start( c ) {

			c.enqueue( bytes.slice( 0, 17 ) );
			c.enqueue( bytes.slice( 17 ) );
			c.close();

		}
	} );
	const out = [];
	await agent_mcp_serve( stream, ( line ) => {

		out.push( line );
		return Promise.resolve();

	} );
	assert( out.length === 3, 'replies: ' + out.length );
	const parsed = out.map( ( l ) => JSON.parse( l ) );
	assert( parsed[ 0 ].id === 1 && parsed[ 0 ].result !== undefined, 'ping reply' );
	assert( parsed[ 1 ].error.code === - 32700 && parsed[ 1 ].id === null, 'parse error' );
	assert( parsed[ 2 ].id === 2 && Array.isArray( parsed[ 2 ].result.tools ), 'tools/list reply' );

} );

Deno.test( { name: 'agent_mcp: bad tool arguments come back as tool errors', ...ENGINE_TEST, fn: async () => {

	const bad = [
		[ 'start', { map: 'e1m1;quit' } ], [ 'start', { seed: 1.5 } ], [ 'start', { map: 'nope' } ], [ 'start', { skill: 4 } ],
		[ 'cmd', {} ], [ 'step', { tics: 'many' } ], [ 'step', { tics: 99999 } ], [ 'step', { impulse: 0 } ],
	];
	for ( const [ name, args ] of bad ) {

		const r = await agent_mcp_handle( { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name, arguments: args } } );
		assert( r.result !== undefined && r.result.isError === true, name + ' ' + JSON.stringify( args ) + ': ' + JSON.stringify( r ) );

	}

} } );

Deno.test( { name: 'agent_mcp: a missing map fails at once and keeps the game', ...ENGINE_TEST, fn: async () => {

	const before = footer( await call( 'start', { map: 'e1m1', skill: 1 } ) );
	const t0 = performance.now();
	const r = await agent_mcp_handle( { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'start', arguments: { map: 'e1m9x' } } } );
	assert( r.result.isError === true && r.result.content[ 0 ].text.includes( 'no map' ), JSON.stringify( r ) );
	assert( performance.now() - t0 < 1000, 'took ' + Math.round( performance.now() - t0 ) + ' ms' );
	const after = await call( 'observe', { ents: 0 } );
	assert( after.startsWith( 'e1m1 ' ), 'the game ended: ' + after );
	assert( footer( after ).tic === before.tic, 'tics ran' );

} } );

// Moves, turns, switches weapon, fires, jumps: player physics, QuakeC
// weapon code and (with the noise) the monsters' reactions. It starts with
// buttons held from the game before, which start must release.
const ACTION_LOG = [
	[ 'step', { buttons: 'forward', tics: 72 } ],
	[ 'step', { yaw: 90, tics: 1 } ],
	[ 'step', { buttons: 'forward,moveleft', tics: 36 } ],
	[ 'step', { impulse: 1, tics: 10 } ],
	[ 'step', { impulse: 2, buttons: 'attack', tics: 40 } ],
	[ 'step', { yaw: - 135, buttons: 'forward,jump', tics: 60 } ],
	[ 'cmd', { text: 'give h 10' } ],
	[ 'step', { buttons: 'attack', tics: 72 } ],
	[ 'step', { tics: 144 } ],
	[ 'cmd', { text: 'impulse 1' } ],
	[ 'step', { tics: 10 } ],
];

async function playLog( seed ) {

	// Leave buttons held in whatever game is running
	await call( 'step', { buttons: 'moveright,attack', hold: true, tics: 0 } );
	const start = footer( await call( 'start', { map: 'e1m1', skill: 1, seed } ) );
	let last = '';
	for ( const [ name, args ] of ACTION_LOG )
		last = await call( name, args );
	return { start, end: footer( last ), text: last };

}

Deno.test( { name: 'agent_mcp: a seeded action log replays to the same state hash', ...ENGINE_TEST, fn: async () => {

	// The process's first game, then a restart: the strict case, since the
	// first load also fills the model and sound caches
	const a = await playLog( 1234 );
	const b = await playLog( 1234 );
	assert( a.start.tic === b.start.tic && a.start.hash === b.start.hash,
		'after start: ' + JSON.stringify( a.start ) + ' vs ' + JSON.stringify( b.start ) );
	assert( a.end.tic === b.end.tic, 'tics ' + a.end.tic + ' vs ' + b.end.tic );
	assert( a.end.hash === b.end.hash, 'replay diverged:\n' + a.text + '\n---\n' + b.text );
	assert( a.end.tic > a.start.tic + 400, 'the log ran ' + ( a.end.tic - a.start.tic ) + ' tics' );
	// The axe arrives as weapon 0 (a byte): Agent_Weapon names it
	assert( / weapon=axe /.test( a.text ), 'weapon after impulse 1: ' + a.text.split( '\n' )[ 0 ] );

	// A different seed is a different game (monsters' first thinks are random)
	const c = await playLog( 99 );
	assert( c.start.hash !== a.start.hash, 'seed 99 matches seed 1234 at start' );
	assert( c.end.hash !== a.end.hash, 'seed 99 matches seed 1234 at the end' );

	// Unseeded: both hooks are off again
	await call( 'start', { map: 'e1m1', skill: 1 } );
	// The virtual clock only moves with tics; the wall clock moves while we wait
	const c0 = Sys_FloatTime();
	await new Promise( ( r ) => setTimeout( r, 20 ) );
	assert( Sys_FloatTime() - c0 > 0.01, 'the virtual clock is still on' );
	const realRandom = Math.random;
	Math.random = () => 0.125;
	try {

		assert( Sys_Random() === 0.125, 'Sys_Random is still seeded' );

	} finally {

		Math.random = realRandom;

	}

} } );
