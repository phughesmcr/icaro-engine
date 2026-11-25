// Headless benchmark of alias and MD5 model loading: Mod_ForName on every
// progs/*.mdl in a pak (with its .md5mesh/.md5anim when the pak has them, as
// in the rerelease), forcing a reload each run. Hashes the built pose data
// and cull spheres so a change can be checked byte for byte.
//
//   deno run --allow-read tools/bench/model_bench.js [-base rerelease] [-runs N] [-json]
//
// Not part of the engine or the test suite.

import { COM_AddPakSequence, COM_SetLooseFileBasePaths } from '../../src/pak.js';
import { COM_InitArgv, LOC_Init } from '../../src/common.js';
import { Cbuf_Init, Cmd_Init } from '../../src/cmd.js';
import { Memory_Init } from '../../src/zone.js';
import { Mod_Init, R_InitTextures, Mod_ForName, Mod_FindName } from '../../src/gl_model.js';

const args = Deno.args;
function arg( name, def ) {

	const i = args.indexOf( name );
	return i >= 0 && i + 1 < args.length ? args[ i + 1 ] : def;

}

const RUNS = Number( arg( '-runs', '5' ) );
const BASE = arg( '-base', null );
const JSON_OUT = args.includes( '-json' );
const root = decodeURIComponent( new URL( '../../static/', import.meta.url ).pathname );
const basedir = BASE !== null ? root + BASE + '/' : root;
const pakPath = BASE !== null ? basedir + 'id1/pak0.pak' : root + 'pak0.pak';

const realLog = console.log;
globalThis.__ICARO_QUIET_LOGS = true;
console.log = () => {};
globalThis.window = globalThis.window ?? { devicePixelRatio: 1 };
await import( '../../src/gl_rsurf.js' ); // bootstraps the import cycle
const { MD5_SkinPose } = await import( '../../src/gl_md5.js' );

COM_InitArgv( [ 'bench' ] );
Memory_Init(); Cbuf_Init(); Cmd_Init(); Mod_Init(); R_InitTextures();
if ( await COM_AddPakSequence( pakPath ) === 0 ) throw new Error( pakPath + ' missing' );
LOC_Init();
COM_SetLooseFileBasePaths( [ ...( BASE !== null ? [ basedir + 'id1/' ] : [] ), root ] );

// model names from the pak directory
const pak = await Deno.readFile( pakPath );
const dv = new DataView( pak.buffer );
const dirofs = dv.getInt32( 4, true ), dirlen = dv.getInt32( 8, true );
const names = [];
for ( let o = dirofs; o < dirofs + dirlen; o += 64 ) {

	let n = '';
	for ( let k = 0; k < 56 && pak[ o + k ] !== 0; k ++ ) n += String.fromCharCode( pak[ o + k ] );
	if ( n.startsWith( 'progs/' ) && n.endsWith( '.mdl' ) ) names.push( n );

}

function median( a ) {

	const s = [ ...a ].sort( ( x, y ) => x - y );
	return s[ s.length >> 1 ];

}

function hashNum( h, v ) {

	const f = new Float64Array( [ v ] );
	const u = new Uint8Array( f.buffer );
	for ( let i = 0; i < 8; i ++ ) h = Math.imul( h ^ u[ i ], 16777619 ) >>> 0;
	return h;

}

function hashBytes( h, u8 ) {

	for ( let i = 0; i < u8.length; i ++ ) h = Math.imul( h ^ u8[ i ], 16777619 ) >>> 0;
	return h;

}

function hashModel( h, mod ) {

	if ( mod.md5hdr !== undefined && mod.md5hdr !== null ) h = hashHdr( h, mod.md5hdr );
	return hashHdr( h, mod.cache !== undefined && mod.cache !== null ? mod.cache.data : null );

}

function hashHdr( h, hdr ) {

	if ( hdr === null || hdr === undefined ) return h;
	for ( const c of hdr._cullCenter ?? [] ) h = hashNum( h, c );
	h = hashNum( h, hdr._cullRadius ?? - 1 );
	h = hashNum( h, hdr.numposes ?? - 1 );
	h = hashNum( h, hdr.poseverts_count ?? - 1 );
	if ( hdr.md5 !== undefined && hdr.md5 !== null ) {

		// every pose skinned with normals and light normal indices
		const n = hdr.md5.numverts;
		const pos = new Float32Array( n * 3 ), nrm = new Float32Array( n * 3 ), ln = new Int32Array( n );
		for ( let p = 0; p < hdr.md5.numposes; p ++ ) {

			MD5_SkinPose( hdr.md5, p, pos, nrm, ln );
			h = hashBytes( hashBytes( hashBytes( h, new Uint8Array( pos.buffer ) ), new Uint8Array( nrm.buffer ) ), new Uint8Array( ln.buffer ) );

		}

	}

	if ( hdr.commands != null ) for ( let i = 0; i < hdr.commands.length; i ++ ) h = hashNum( h, hdr.commands[ i ] );
	return h;

}

const times = [];
let hash = 0, count = 0;
for ( let r = 0; r < RUNS + 1; r ++ ) {

	let h = 2166136261;
	count = 0;
	let dt = 0;
	for ( const n of names ) {

		const mod = Mod_FindName( n );
		mod.needload = true;
		if ( mod.cache !== undefined && mod.cache !== null ) mod.cache.data = null;
		const t0 = performance.now();
		const m = Mod_ForName( n, false );
		dt += performance.now() - t0;
		if ( m !== null ) { count ++; h = hashModel( h, m ); }

	}

	if ( r > 0 ) times.push( dt );
	hash = h;

}

console.log = realLog;
const out = { models: count, total_ms: + median( times ).toFixed( 2 ), hash: hash.toString( 16 ) };
console.log( JSON_OUT ? JSON.stringify( out ) : out );
