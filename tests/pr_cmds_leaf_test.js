import { PF_LeafIndexForPoint } from '../src/pr_cmds.js';
import { Mod_PointInLeaf } from '../src/gl_model.js';
import { SV_LeafTree, SV_FindTouchedLeafs, SV_FindTouchedLeafs_flat } from '../src/world.js';

// A random BSP of the shape Mod_PointInLeaf walks: node objects with a plane
// and two children, leaf objects with negative contents and a _leafIndex.
// About a third of the planes are axial ( type 0-2 ), the rest general with
// every signbits value; leaf 0 is solid, as in a real map, and so are a few more.
function make_model( seed, depth ) {

	let state = seed;
	const rnd = () => ( state = ( state * 1664525 + 1013904223 ) >>> 0 ) / 4294967296;
	let leafs = 0;

	function make_plane() {

		const dist = ( rnd() - 0.5 ) * 1000;
		if ( rnd() < 0.33 ) {

			const type = Math.floor( rnd() * 3 );
			const normal = new Float32Array( 3 );
			normal[ type ] = 1;
			return { normal, dist, type, signbits: 0 };

		}

		const normal = new Float32Array( [ rnd() - 0.5, rnd() - 0.5, rnd() - 0.5 ] );
		let signbits = 0;
		for ( let i = 0; i < 3; i ++ )
			if ( normal[ i ] < 0 ) signbits |= 1 << i;
		return { normal, dist, type: 3, signbits };

	}

	function build( d ) {

		if ( d === 0 || ( d < depth - 1 && rnd() < 0.15 ) ) {

			const index = leafs ++;
			return { contents: index === 0 || rnd() < 0.1 ? - 2 : - 1, _leafIndex: index };

		}

		return { contents: 0, plane: make_plane(), children: [ build( d - 1 ), build( d - 1 ) ] };

	}

	const root = build( depth );
	return { nodes: [ root ], numleafs: leafs };

}

Deno.test( 'PF_LeafIndexForPoint picks the leaf Mod_PointInLeaf picks', () => {

	for ( let seed = 1; seed <= 6; seed ++ ) {

		const model = make_model( seed, 10 );
		const p = new Float32Array( 3 );
		for ( let i = 0; i < 4000; i ++ ) {

			p[ 0 ] = ( Math.random() - 0.5 ) * 2000;
			p[ 1 ] = ( Math.random() - 0.5 ) * 2000;
			p[ 2 ] = ( Math.random() - 0.5 ) * 2000;
			const want = Mod_PointInLeaf( p, model )._leafIndex;
			const got = PF_LeafIndexForPoint( p, model, i & 7 );
			if ( got !== want )
				throw new Error( `seed ${seed}: leaf ${got}, want ${want}` );

		}

	}

} );

Deno.test( 'PF_LeafIndexForPoint remembers a point per entity, not across entities or models', () => {

	const a = make_model( 11, 8 );
	const b = make_model( 12, 8 );
	const p = new Float32Array( [ 10, 20, 30 ] );
	const q = new Float32Array( [ - 400, 300, - 50 ] );

	for ( let round = 0; round < 3; round ++ ) {

		for ( const model of [ a, b ] ) {

			for ( const ent of [ 1, 2, 300 ] ) {

				for ( const point of [ p, q, p ] ) {

					const want = Mod_PointInLeaf( point, model )._leafIndex;
					const got = PF_LeafIndexForPoint( point, model, ent );
					if ( got !== want )
						throw new Error( `round ${round} ent ${ent}: leaf ${got}, want ${want}` );

				}

			}

		}

	}

} );

// SV_LinkEdict's flat walk collects the same leaves, in the same order, as the
// object-tree SV_FindTouchedLeafs, including the cap of 16 leaves per entity.
Deno.test( 'SV_FindTouchedLeafs_flat matches the object-tree walk', () => {

	const make_ent = () => ( {
		num_leafs: 0,
		leafnums: new Int32Array( 16 ),
		v: { absmin: new Float32Array( 3 ), absmax: new Float32Array( 3 ) },
	} );

	for ( let seed = 21; seed <= 26; seed ++ ) {

		const model = make_model( seed, 9 );
		const tree = SV_LeafTree( model );
		let capped = 0;
		for ( let i = 0; i < 3000; i ++ ) {

			const a = make_ent();
			const b = make_ent();
			const size = i % 3 === 0 ? 3000 : 1 + Math.random() * 300; // some boxes touch many leaves
			for ( let k = 0; k < 3; k ++ ) {

				const lo = ( Math.random() - 0.5 ) * 2000;
				a.v.absmin[ k ] = b.v.absmin[ k ] = lo;
				a.v.absmax[ k ] = b.v.absmax[ k ] = lo + size;

			}

			SV_FindTouchedLeafs( a, model.nodes[ 0 ] );
			SV_FindTouchedLeafs_flat( b, tree, 0, b.v.absmin, b.v.absmax );
			if ( a.num_leafs === 16 ) capped ++;
			if ( a.num_leafs !== b.num_leafs || a.leafnums.some( ( v, j ) => v !== b.leafnums[ j ] ) )
				throw new Error( `seed ${seed} box ${i}: ${Array.from( b.leafnums )} vs ${Array.from( a.leafnums )}` );

		}

		if ( capped === 0 )
			throw new Error( `seed ${seed}: no box reached the 16 leaf cap` );

	}

} );
