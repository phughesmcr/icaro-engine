// src/agent.js goto over the headless host (through server/agent_mcp.ts):
// the walk graph built at map load, and goto's outcomes on e1m1 from pak0.
// A seeded start makes each run the same game.

import { mcp_session } from './agent_mcp_client.js';
import { Agent_Goto, Agent_NavGraph, GOTO_DEFAULT_TICS, GOTO_MAX_TICS } from '../src/agent.js';
import { NAV_NODE_EXIT } from '../src/nav.js';

function assert( cond, message ) {

	if ( cond !== true )
		throw new Error( message );

}

// One host per process, kept across tests (see agent_mcp_test.js)
const ENGINE_TEST = { sanitizeResources: false, sanitizeOps: false };

// One connection, opened on first use
let session = null;
async function raw( name, args ) {

	if ( session === null )
		session = await mcp_session();
	return await session.raw( name, args );

}

async function call( name, args = {} ) {

	const r = await raw( name, args );
	assert( r.isError !== true, name + ' failed: ' + r.content[ 0 ].text );
	return r.content[ 0 ].text;

}

const first = ( text ) => text.split( '\n' )[ 0 ];
const ARMOR = [ 688, 480, 80 ]; // item_armor1, across the bridge (tests/nav_test.js)

async function start( seed, cheats ) {

	await call( 'start', { map: 'e1m1', skill: 1, seed } );
	if ( cheats ) {

		await call( 'cmd', { text: 'god' } );
		await call( 'cmd', { text: 'notarget' } );

	}

}

Deno.test( { name: 'agent goto: a walk graph is built at map load, and again on a new map', ...ENGINE_TEST, fn: async () => {

	await start( 1, false );
	const g = Agent_NavGraph();
	assert( g !== null && g.node_flags.length > 1000, 'e1m1 graph: ' + ( g === null ? null : g.node_flags.length ) );
	assert( g.node_flags.some( ( f ) => ( f & NAV_NODE_EXIT ) !== 0 ), 'the exit is in the graph' );

	await call( 'start', { map: 'e1m2', skill: 1, seed: 1 } );
	const g2 = Agent_NavGraph();
	assert( g2 !== null && g2 !== g && g2.node_flags.length !== g.node_flags.length, 'e1m2 has its own graph' );

} } );

Deno.test( { name: 'agent goto: a closed bridge is blocked and names its button; after it, goto arrives', ...ENGINE_TEST, fn: async () => {

	await start( 1, true );
	const blocked = first( await call( 'goto', { pos: ARMOR, ents: 0 } ) );
	assert( /^goto 688,480,80: blocked by #12 door .*opened by button #13/.test( blocked ), blocked );
	// It avoids the bridge now, until the bridge moves
	assert( Agent_NavGraph().link_cost.some( ( c ) => c >= 1e6 ), 'no links avoided' );

	const button = first( await call( 'goto', { id: 13, ents: 0 } ) );
	assert( /^goto #13: arrived/.test( button ), button );
	const armor = await call( 'goto', { pos: ARMOR, ents: 0 } );
	assert( /^goto 688,480,80: arrived/.test( first( armor ) ), first( armor ) );
	assert( / armor=100\(green\) /.test( armor ), 'picked up the armor: ' + armor.split( '\n' )[ 1 ] );
	// The next goto sees the bridge has moved, and stops avoiding it
	assert( /: arrived \(0 tics\)/.test( first( await call( 'goto', { pos: ARMOR, ents: 0 } ) ) ), 'already there' );
	assert( Agent_NavGraph().link_cost.every( ( c ) => c < 1e6 ), 'the bridge moved: nothing is avoided' );

} } );

Deno.test( { name: 'agent goto: an item by id arrives when it is picked up', ...ENGINE_TEST, fn: async () => {

	await start( 1, true );
	await call( 'goto', { id: 13, ents: 0 } ); // the bridge button: the shells are across it
	const t = await call( 'goto', { id: 108, ents: 0 } );
	assert( /^goto #108: arrived \(#108 is gone/.test( first( t ) ), first( t ) );
	assert( / ammo=45 /.test( t ), 'picked up the shells: ' + t.split( '\n' )[ 1 ] );

} } );

Deno.test( { name: 'agent goto: timeout, no path, damage', ...ENGINE_TEST, fn: async () => {

	await start( 1, false );
	const slow = first( await call( 'goto', { pos: ARMOR, max_tics: 10, ents: 0 } ) );
	assert( /^goto 688,480,80: timeout \(10 tics\)/.test( slow ), slow );
	const nowhere = first( await call( 'goto', { pos: [ 99999, 99999, 0 ], ents: 0 } ) );
	assert( /: no path/.test( nowhere ), nowhere );

	// Seed 1, no god: a grunt by the bridge shoots on the way
	const hurt = first( await call( 'goto', { pos: ARMOR, ents: 0 } ) );
	assert( /: took damage \(-[0-9]+ hp\), stopped/.test( hurt ), hurt );
	const on = first( await call( 'goto', { pos: ARMOR, ents: 0, max_tics: 144, stop_on_damage: false } ) );
	assert( /: took damage/.test( on ) === false, 'stop_on_damage: false still stopped: ' + on );

} } );

Deno.test( { name: 'agent goto: bad targets are errors', ...ENGINE_TEST, fn: async () => {

	await start( 1, false );
	const list = await session.request( 'tools/list', {} );
	const schema = list.result.tools.find( ( t ) => t.name === 'goto' ).inputSchema.properties.max_tics;
	assert( schema.maximum === GOTO_MAX_TICS, 'the goto schema and GOTO_MAX_TICS disagree' );
	assert( schema.description.includes( '(default ' + GOTO_DEFAULT_TICS + ' ' ), 'the goto schema and GOTO_DEFAULT_TICS disagree: ' + schema.description );
	for ( const args of [ {}, { id: 13, pos: ARMOR }, { pos: [ 1, 2 ] }, { id: 0 }, { id: 9999 }, { pos: ARMOR, max_tics: 0 } ] ) {

		const r = await raw( 'goto', args );
		assert( r.isError === true, JSON.stringify( args ) + ': ' + r.content[ 0 ].text );

	}

	let threw = false;
	try {

		await Agent_Goto( 'abc' );

	} catch ( e ) {

		threw = e instanceof Error && /goto: target/.test( e.message );

	}

	assert( threw, 'Agent_Goto( "abc" ) throws' );
	const typed = first( await Agent_Goto( new Float32Array( [ 99999, 99999, 0 ] ) ) );
	assert( /: no path/.test( typed ), 'a Float32Array point: ' + typed );

} } );
