// Headless benchmark of the client's map build: GL_BuildLightmaps (lightmap
// blocks, surface display lists, .lit lightmaps, and R_BuildWorldMeshes into
// the shim's BatchedMesh stub). Also hashes the produced buffers (lightmap
// texels, per-batch vertex arrays) so a change can be checked byte for byte.
//
//   deno run --allow-read tools/bench/build_bench.js [-runs N] [-maps a,b] [-base rerelease]
//       [-hipnotic | -rogue | -game <dir>] [-json] [-nohash]
//
// Not part of the engine or the test suite. Needs the gitignored game data
// for the rerelease, mission packs and -game dirs (see server_bench.js).

import { COM_AddPakSequence, COM_AddGameDirectory, COM_SetLooseFileBasePaths, COM_EnsureFile } from '../../src/pak.js';
import { COM_InitArgv, LOC_Init } from '../../src/common.js';
import { Cbuf_Init, Cmd_Init } from '../../src/cmd.js';
import { Memory_Init } from '../../src/zone.js';
import { Mod_Init, R_InitTextures, Mod_ForName } from '../../src/gl_model.js';

const args = Deno.args;
function arg( name, def ) {

	const i = args.indexOf( name );
	return i >= 0 && i + 1 < args.length ? args[ i + 1 ] : def;

}

const RUNS = Number( arg( '-runs', '5' ) );
const MAPS = arg( '-maps', 'start,e1m1,e1m3,e1m6,e2m3' ).split( ',' );
const NOHASH = args.includes( '-nohash' ); // skip hashing in the timed loop (for profiling)
const JSON_OUT = args.includes( '-json' );
const BASE = arg( '-base', null );
const GAME = arg( '-game', null );

const root = decodeURIComponent( new URL( '../../static/', import.meta.url ).pathname );
const basedir = BASE !== null ? root + BASE + '/' : root;
const pak0 = BASE !== null ? basedir + 'id1/pak0.pak' : root + 'pak0.pak';
const gameFlags = [];
const gameDirs = [];
for ( const flag of [ '-rogue', '-hipnotic' ] ) {

	if ( args.includes( flag ) ) {

		gameFlags.push( flag );
		gameDirs.push( basedir + flag.slice( 1 ) );

	}

}

if ( GAME !== null ) {

	gameFlags.push( '-game', GAME );
	gameDirs.push( basedir + GAME );

}

const realLog = console.log;
globalThis.__ICARO_QUIET_LOGS = true;
console.log = () => {};
globalThis.window = globalThis.window ?? { devicePixelRatio: 1 };

const gl_rsurf = await import( '../../src/gl_rsurf.js' ); // bootstraps the renderer's import cycle
const { cl } = await import( '../../src/client.js' );
const gl_rmain = await import( '../../src/gl_rmain.js' );

COM_InitArgv( [ 'bench', ...gameFlags ] );
Memory_Init();
Cbuf_Init();
Cmd_Init();
Mod_Init();
R_InitTextures();
if ( await COM_AddPakSequence( pak0 ) === 0 )
	throw new Error( pak0 + ' missing' );
for ( const dir of gameDirs )
	if ( await COM_AddGameDirectory( dir ) === 0 )
		throw new Error( dir + '/pak0.pak missing' );
LOC_Init();
gl_rmain.R_Init();
COM_SetLooseFileBasePaths( [ ...gameDirs.toReversed().map( ( d ) => d + '/' ), ...( BASE !== null ? [ basedir + 'id1/' ] : [] ), root ] );

function median( a ) {

	const s = [ ...a ].sort( ( x, y ) => x - y );
	return s[ s.length >> 1 ];

}

// FNV-1a over bytes
function hashBytes( h, u8 ) {

	for ( let i = 0; i < u8.length; i ++ ) h = Math.imul( h ^ u8[ i ], 16777619 ) >>> 0;
	return h;

}

function hashArray( h, a ) {

	return hashBytes( h, new Uint8Array( a.buffer, a.byteOffset, a.byteLength ) );

}

const enc = new TextEncoder();

function hashBuild() {

	let h = 2166136261;
	for ( const t of gl_rsurf.lightmapTextures ) h = hashArray( h, t.image.data );
	let verts = 0;
	for ( const b of gl_rmain.scene.children.find( ( c ) => c.name === 'quake_world' ).children ) {

		h = hashBytes( h, enc.encode( b.name ) );
		for ( const g of b.geometries ) {

			for ( const name of Object.keys( g.attributes ).sort() ) {

				h = hashBytes( h, enc.encode( name ) );
				h = hashArray( h, g.attributes[ name ].array );

			}

			if ( g.index !== null ) h = hashArray( h, g.index.array );
			verts += g.attributes.position.count;

		}

	}

	return { hash: h.toString( 16 ), verts };

}

const results = {};
for ( const map of MAPS ) {

	if ( await COM_EnsureFile( 'maps/' + map + '.bsp' ) !== true ) {

		realLog( 'skip ' + map + ' (not found)' );
		continue;

	}

	const world = Mod_ForName( 'maps/' + map + '.bsp', true );
	cl.worldmodel = world;
	cl.model_precache = [ null, world ];
	for ( let i = 1; i < world.numsubmodels; i ++ ) cl.model_precache.push( Mod_ForName( '*' + i, true ) );

	const times = [];
	let res = null, cold = 0;
	for ( let r = 0; r < RUNS + 1; r ++ ) {

		const t0 = performance.now();
		gl_rsurf.GL_BuildLightmaps();
		const dt = performance.now() - t0;
		if ( r === 0 ) cold = dt; else times.push( dt ); // the first run is cold (JIT, first allocations)
		if ( r === RUNS || ! NOHASH ) res = hashBuild();

	}

	results[ map ] = { cold_ms: + cold.toFixed( 2 ), build_ms: times.length > 0 ? + median( times ).toFixed( 2 ) : 0, lightmaps: gl_rsurf.lightmapTextures.length, lit: world.litfile === true, ...( res ?? {} ) };

}

console.log = realLog;
if ( JSON_OUT ) {

	console.log( JSON.stringify( results, null, '\t' ) );

} else {

	console.log( 'map'.padEnd( 12 ) + 'cold_ms'.padStart( 9 ) + 'build_ms'.padStart( 10 ) + 'lms'.padStart( 5 ) + ' lit' + 'verts'.padStart( 9 ) + '  hash' );
	for ( const [ map, r ] of Object.entries( results ) )
		console.log( map.padEnd( 12 ) + String( r.cold_ms ).padStart( 9 ) + String( r.build_ms ).padStart( 10 ) + String( r.lightmaps ).padStart( 5 ) + ' ' + ( r.lit ? 'y  ' : 'n  ' ) + String( r.verts ).padStart( 9 ) + '  ' + r.hash );

}
