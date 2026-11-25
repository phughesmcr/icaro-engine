// R_DrawAliasModel rewrites and re-uploads an entity's vertex colours only
// when its lighting inputs change, not on every frame.

// Bootstrap the renderer's existing circular module graph in its safe order.
await import( '../src/gl_rsurf.js' );

const gl_mesh = await import( '../src/gl_mesh.js' );

function assertEqual( actual, expected, message ) {

	if ( actual !== expected )
		throw new Error( `${message}: expected ${expected}, got ${actual}` );

}

function floatBits( f ) {

	const v = new DataView( new ArrayBuffer( 4 ) );
	v.setFloat32( 0, f, true );
	return v.getInt32( 0, true );

}

// One frame, one pose of a 4-vertex strip, lit through normals 0 and 1.
function buildHeader() {

	const pose = [ 0, 1, 2, 3 ].map( ( i ) => ( { v: [ i, i, i ], lightnormalindex: i & 1 } ) );
	const commands = [ 4 ];
	for ( let i = 0; i < 4; i ++ ) commands.push( floatBits( i / 4 ), floatBits( 0 ) );
	commands.push( 0 );
	return {
		commands,
		posedata: [ pose ],
		numframes: 1,
		numposes: 1,
		numskins: 0,
		scale: [ 1, 1, 1 ],
		scale_origin: [ 0, 0, 0 ]
	};

}

function buildEntity() {

	return {
		frame: 0,
		lerpflags: 0,
		colormap: null,
		model: { name: 'progs/test.mdl', type: 2, flags: 0 },
		origin: new Float32Array( 3 ),
		angles: new Float32Array( 3 ),
		currentorigin: new Float32Array( 3 ),
		currentangles: new Float32Array( 3 ),
		previousorigin: new Float32Array( 3 ),
		previousangles: new Float32Array( 3 )
	};

}

Deno.test( 'R_DrawAliasModel updates vertex colours only when the lighting changes', () => {

	const paliashdr = buildHeader();
	const entity = buildEntity();
	const dotsA = new Float32Array( [ 0.5, 1.0 ] );
	const dotsB = new Float32Array( [ 1.0, 0.5 ] );

	const draw = ( dots, light ) => {

		gl_mesh.R_DrawAliasModel( entity, paliashdr, dots, light );
		const color = entity._aliasGeo.attributes.color;
		const updated = color.needsUpdate;
		color.needsUpdate = false;
		return updated;

	};

	assertEqual( draw( dotsA, 0.5 ), true, 'first draw writes the colours' );
	const colors = entity._aliasGeo.attributes.color.array;
	assertEqual( colors[ 0 ], gl_mesh.GL_LinearLight( 0.25 ), 'vertex 0 lit by normal 0' );
	assertEqual( colors[ 3 ], gl_mesh.GL_LinearLight( 0.5 ), 'vertex 1 lit by normal 1' );

	assertEqual( draw( dotsA, 0.5 ), false, 'same lighting: no rewrite' );

	assertEqual( draw( dotsA, 0.8 ), true, 'new shadelight rewrites' );
	assertEqual( colors[ 0 ], gl_mesh.GL_LinearLight( 0.4 ), 'vertex 0 at the new shadelight' );

	assertEqual( draw( dotsB, 0.8 ), true, 'new shade table rewrites' );
	assertEqual( colors[ 0 ], gl_mesh.GL_LinearLight( 0.8 ), 'vertex 0 from the new table' );

	// A cleared entity cache (_clearEntityMeshCache) must relight the new buffer.
	entity._aliasGeo = null;
	entity._aliasColorArray = null;
	entity._aliasMesh = null;
	assertEqual( draw( dotsB, 0.8 ), true, 'rebuilt geometry is relit' );

} );
