import { CONTENTS_EMPTY, CONTENTS_SOLID, CONTENTS_WATER } from '../src/bspfile.js';
import { PM_HullPointContents, PM_RecursiveHullCheck, PM_HullForBox, PM_InitBoxHull, pmtrace_t } from '../src/pmove.js';

// the object-tree walk PM_HullPointContents flattened
function ref_contents( hull, num, p ) {

	while ( num >= 0 ) {

		const node = hull.clipnodes[ num ];
		const plane = hull.planes[ node.planenum ];
		let d;
		if ( plane.type < 3 )
			d = p[ plane.type ] - plane.dist;
		else
			d = plane.normal[ 0 ] * p[ 0 ] + plane.normal[ 1 ] * p[ 1 ] + plane.normal[ 2 ] * p[ 2 ] - plane.dist;
		num = node.children[ d < 0 ? 1 : 0 ];

	}
	return num;

}

function make_hull( rnd ) {

	const nplanes = 12;
	const planes = [];
	for ( let i = 0; i < nplanes; i ++ ) {

		const type = i % 6;
		const normal = new Float32Array( 3 );
		if ( type < 3 ) normal[ type ] = 1;
		else for ( let k = 0; k < 3; k ++ ) normal[ k ] = rnd() * 2 - 1;
		planes.push( { normal, dist: ( rnd() - 0.5 ) * 400, type } );

	}
	const count = 40;
	const leaves = [ CONTENTS_EMPTY, CONTENTS_SOLID, CONTENTS_WATER ];
	const clipnodes = [];
	for ( let i = 0; i < count; i ++ ) {

		const kid = () => i * 2 + 2 < count && rnd() < 0.7 ? i + 1 + Math.floor( rnd() * ( count - i - 1 ) ) : leaves[ Math.floor( rnd() * 3 ) ];
		clipnodes.push( { planenum: Math.floor( rnd() * nplanes ), children: new Int16Array( [ kid(), kid() ] ) } );

	}
	return { firstclipnode: 0, lastclipnode: count - 1, clipnodes, planes };

}

Deno.test( 'PM_HullPointContents matches the object-tree walk on random hulls', () => {

	let seed = 12345;
	const rnd = () => ( ( seed = ( seed * 1664525 + 1013904223 ) >>> 0 ) / 4294967296 );
	const p = new Float32Array( 3 );

	for ( let h = 0; h < 20; h ++ ) {

		const hull = make_hull( rnd );
		for ( let n = 0; n < 300; n ++ ) {

			for ( let k = 0; k < 3; k ++ ) p[ k ] = ( rnd() - 0.5 ) * 600;
			const a = PM_HullPointContents( hull, 0, p );
			const b = ref_contents( hull, 0, p );
			if ( a !== b )
				throw new Error( `hull ${h} point ${n}: expected ${b}, got ${a}` );

		}

		// a changed plane set for the same clipnodes must be seen
		const planes = hull.planes.map( ( q ) => ( { normal: q.normal, dist: q.dist + 37, type: q.type } ) );
		const moved = { ...hull, planes };
		for ( let n = 0; n < 100; n ++ ) {

			for ( let k = 0; k < 3; k ++ ) p[ k ] = ( rnd() - 0.5 ) * 600;
			if ( PM_HullPointContents( moved, 0, p ) !== ref_contents( moved, 0, p ) )
				throw new Error( `moved hull ${h} point ${n} differs` );

		}

	}

} );

// the object-tree PM_RecursiveHullCheck the flat walk replaced
const DIST_EPSILON = 0.03125;
function ref_hull_check( hull, num, p1f, p2f, p1, p2, trace ) {

	if ( num < 0 ) {

		if ( num !== CONTENTS_SOLID ) {

			trace.allsolid = false;
			if ( num === CONTENTS_EMPTY )
				trace.inopen = true;
			else
				trace.inwater = true;

		} else {

			trace.startsolid = true;

		}
		return true;

	}

	const node = hull.clipnodes[ num ];
	const plane = hull.planes[ node.planenum ];
	let t1, t2;
	if ( plane.type < 3 ) {

		t1 = p1[ plane.type ] - plane.dist;
		t2 = p2[ plane.type ] - plane.dist;

	} else {

		const n = plane.normal;
		t1 = n[ 0 ] * p1[ 0 ] + n[ 1 ] * p1[ 1 ] + n[ 2 ] * p1[ 2 ] - plane.dist;
		t2 = n[ 0 ] * p2[ 0 ] + n[ 1 ] * p2[ 1 ] + n[ 2 ] * p2[ 2 ] - plane.dist;

	}

	if ( t1 >= 0 && t2 >= 0 )
		return ref_hull_check( hull, node.children[ 0 ], p1f, p2f, p1, p2, trace );
	if ( t1 < 0 && t2 < 0 )
		return ref_hull_check( hull, node.children[ 1 ], p1f, p2f, p1, p2, trace );

	let frac = t1 < 0 ? ( t1 + DIST_EPSILON ) / ( t1 - t2 ) : ( t1 - DIST_EPSILON ) / ( t1 - t2 );
	if ( frac < 0 ) frac = 0;
	if ( frac > 1 ) frac = 1;

	let midf = p1f + ( p2f - p1f ) * frac;
	const mid = new Float32Array( 3 );
	for ( let i = 0; i < 3; i ++ )
		mid[ i ] = p1[ i ] + frac * ( p2[ i ] - p1[ i ] );

	const side = t1 < 0 ? 1 : 0;
	if ( ! ref_hull_check( hull, node.children[ side ], p1f, midf, p1, mid, trace ) )
		return false;

	if ( ref_contents( hull, node.children[ side ^ 1 ], mid ) !== CONTENTS_SOLID )
		return ref_hull_check( hull, node.children[ side ^ 1 ], midf, p2f, mid, p2, trace );

	if ( trace.allsolid )
		return false;

	for ( let i = 0; i < 3; i ++ )
		trace.plane.normal[ i ] = side === 0 ? plane.normal[ i ] : 0 - plane.normal[ i ];
	trace.plane.dist = side === 0 ? plane.dist : - plane.dist;

	while ( ref_contents( hull, hull.firstclipnode, mid ) === CONTENTS_SOLID ) {

		frac -= 0.1;
		if ( frac < 0 ) {

			trace.fraction = midf;
			trace.endpos.set( mid );
			return false;

		}
		midf = p1f + ( p2f - p1f ) * frac;
		for ( let i = 0; i < 3; i ++ )
			mid[ i ] = p1[ i ] + frac * ( p2[ i ] - p1[ i ] );

	}

	trace.fraction = midf;
	trace.endpos.set( mid );
	return false;

}

function fresh_trace( end ) {

	const t = new pmtrace_t();
	t.allsolid = true;
	t.endpos.set( end );
	return t;

}

function same_trace( a, b, what ) {

	const fields = [ 'allsolid', 'startsolid', 'inopen', 'inwater', 'fraction' ];
	for ( const k of fields )
		if ( ! Object.is( a[ k ], b[ k ] ) )
			throw new Error( `${what}: ${k} ${a[ k ]} != ${b[ k ]}` );
	for ( let i = 0; i < 3; i ++ ) {

		if ( ! Object.is( a.endpos[ i ], b.endpos[ i ] ) )
			throw new Error( `${what}: endpos[${i}] ${a.endpos[ i ]} != ${b.endpos[ i ]}` );
		if ( ! Object.is( a.plane.normal[ i ], b.plane.normal[ i ] ) )
			throw new Error( `${what}: normal[${i}] ${a.plane.normal[ i ]} != ${b.plane.normal[ i ]}` );

	}
	if ( ! Object.is( a.plane.dist, b.plane.dist ) )
		throw new Error( `${what}: plane dist ${a.plane.dist} != ${b.plane.dist}` );

}

Deno.test( 'PM_RecursiveHullCheck matches the object-tree walk on random hulls', () => {

	let seed = 777;
	const rnd = () => ( ( seed = ( seed * 1664525 + 1013904223 ) >>> 0 ) / 4294967296 );
	const p1 = new Float32Array( 3 ), p2 = new Float32Array( 3 );
	let hits = 0;

	for ( let h = 0; h < 30; h ++ ) {

		const hull = make_hull( rnd );
		for ( let n = 0; n < 300; n ++ ) {

			for ( let k = 0; k < 3; k ++ ) {

				p1[ k ] = ( rnd() - 0.5 ) * 600;
				p2[ k ] = ( rnd() - 0.5 ) * 600;

			}
			const a = fresh_trace( p2 ), b = fresh_trace( p2 );
			PM_RecursiveHullCheck( hull, 0, 0, 1, p1, p2, a );
			ref_hull_check( hull, 0, 0, 1, p1, p2, b );
			same_trace( a, b, `hull ${h} trace ${n}` );
			if ( b.fraction < 1 ) hits ++;

		}

	}

	// make sure the impact and side-1 plane paths were exercised
	if ( hits < 500 )
		throw new Error( `only ${hits} traces hit something` );

} );

// a box hull built the way PM_InitBoxHull builds it, as plain objects
function ref_box( mins, maxs ) {

	const clipnodes = [], planes = [];
	for ( let i = 0; i < 6; i ++ ) {

		const side = i & 1;
		const children = [ 0, 0 ];
		children[ side ] = CONTENTS_EMPTY;
		children[ side ^ 1 ] = i !== 5 ? i + 1 : CONTENTS_SOLID;
		clipnodes.push( { planenum: i, children } );
		const normal = new Float32Array( 3 );
		normal[ i >> 1 ] = 1;
		planes.push( { type: i >> 1, normal, dist: ( i & 1 ) === 0 ? maxs[ i >> 1 ] : mins[ i >> 1 ] } );

	}
	return { firstclipnode: 0, lastclipnode: 5, clipnodes, planes };

}

Deno.test( 'PM_HullForBox traces match a freshly built box after the bounds change', () => {

	PM_InitBoxHull();
	let seed = 4242;
	const rnd = () => ( ( seed = ( seed * 1664525 + 1013904223 ) >>> 0 ) / 4294967296 );
	const mins = new Float32Array( 3 ), maxs = new Float32Array( 3 );
	const p1 = new Float32Array( 3 ), p2 = new Float32Array( 3 );
	let hits = 0;

	for ( let b = 0; b < 50; b ++ ) {

		// new bounds every box, so a stale distance would show
		for ( let k = 0; k < 3; k ++ ) {

			mins[ k ] = - 10 - rnd() * 40;
			maxs[ k ] = 10 + rnd() * 40;

		}
		const box = PM_HullForBox( mins, maxs );
		const ref = ref_box( mins, maxs );

		for ( let n = 0; n < 40; n ++ ) {

			for ( let k = 0; k < 3; k ++ ) {

				p1[ k ] = ( rnd() - 0.5 ) * 200;
				p2[ k ] = ( rnd() - 0.5 ) * 200;

			}
			const a = fresh_trace( p2 ), r = fresh_trace( p2 );
			PM_RecursiveHullCheck( box, 0, 0, 1, p1, p2, a );
			ref_hull_check( ref, 0, 0, 1, p1, p2, r );
			same_trace( a, r, `box ${b} trace ${n}` );
			if ( r.fraction < 1 ) hits ++;
			if ( PM_HullPointContents( box, 0, p1 ) !== ref_contents( ref, 0, p1 ) )
				throw new Error( `box ${b} point ${n}: contents differ` );

		}

	}

	if ( hits < 200 )
		throw new Error( `only ${hits} box traces hit` );

} );
