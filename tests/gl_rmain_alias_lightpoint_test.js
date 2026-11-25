// R_AliasLightPoint: Ironwail's retry from half the model's height when the
// first R_LightPoint trace from an alias model's origin is pitch black.

// Bootstrap the renderer's existing circular module graph in its safe order.
await import( '../src/gl_rsurf.js' );

const gl_rmain = await import( '../src/gl_rmain.js' );
const glquake = await import( '../src/glquake.js' );
const { cl } = await import( '../src/client.js' );

function assertEqual( actual, expected, message ) {

	if ( actual !== expected )
		throw new Error( `${message}: expected ${expected}, got ${actual}` );

}

const LEAF = { contents: - 1 };

// One lightmapped floor at height `dist`, 128x128 units around the origin,
// every luxel `value` in light style 0.
function floorAt( dist, value ) {

	const plane = { type: 2, normal: new Float32Array( [ 0, 0, 1 ] ), dist: dist };
	const surface = {
		flags: 0,
		plane: plane,
		texinfo: { vecs: [ [ 1, 0, 0, 0 ], [ 0, 1, 0, 0 ] ] },
		texturemins: [ - 64, - 64 ],
		extents: [ 128, 128 ],
		samples: new Uint8Array( 9 * 9 ).fill( value ),
		sampleOffset: 0,
		styles: [ 0, 255, 255, 255 ]
	};
	const node = { contents: 0, plane: plane, children: [ LEAF, LEAF ], firstsurface: 0, numsurfaces: 1 };
	return { lightdata: new Uint8Array( 1 ), nodes: [ node ], surfaces: [ surface ] };

}

function withWorld( worldmodel, fn ) {

	const oldWorld = cl.worldmodel;
	const oldStyle = glquake.d_lightstylevalue[ 0 ];
	try {

		cl.worldmodel = worldmodel;
		glquake.d_lightstylevalue[ 0 ] = 256;
		fn();

	} finally {

		cl.worldmodel = oldWorld;
		glquake.d_lightstylevalue[ 0 ] = oldStyle;

	}

}

function aliasEntity( z ) {

	// Mod_LoadAliasModel gives every alias model maxs of 16
	return { origin: new Float32Array( [ 0, 0, z ] ), model: { maxs: new Float32Array( [ 16, 16, 16 ] ) } };

}

Deno.test( 'R_AliasLightPoint retries from half the model height when the origin is black', () => {

	// origin 5 units under a floor at 0: the first trace finds nothing,
	// the retry from 8 units up (3 above the floor) lands on it
	withWorld( floorAt( 0, 60 ), () => {

		assertEqual( gl_rmain.R_AliasLightPoint( aliasEntity( - 5 ) ), 60, 'retry lights the model' );

	} );

} );

Deno.test( 'R_AliasLightPoint keeps the first sample when it is lit', () => {

	// floors at 0 (60) and 14 (90). From the origin at 10 the trace hits the
	// floor at 0; a retry from 18 would hit the one at 14 instead.
	const world = floorAt( 0, 60 );
	const upper = floorAt( 14, 90 );
	upper.nodes[ 0 ].children[ 1 ] = world.nodes[ 0 ];
	world.nodes[ 0 ].firstsurface = 1;
	withWorld( { lightdata: world.lightdata, nodes: [ upper.nodes[ 0 ], world.nodes[ 0 ] ], surfaces: [ upper.surfaces[ 0 ], world.surfaces[ 0 ] ] }, () => {

		assertEqual( gl_rmain.R_AliasLightPoint( aliasEntity( 10 ) ), 60, 'first sample kept' );
		assertEqual( gl_rmain.R_AliasLightPoint( aliasEntity( 18 ) ), 90, 'upper floor reachable' );

	} );

} );

Deno.test( 'R_AliasLightPoint stays black when the retry finds nothing either', () => {

	// origin 20 under a floor at 4: the retry starts at -12, still under it
	withWorld( floorAt( 4, 60 ), () => {

		assertEqual( gl_rmain.R_AliasLightPoint( aliasEntity( - 20 ) ), 0, 'black' );

	} );

} );
