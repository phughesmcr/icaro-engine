// GL_DrawAliasFrame: every pose of an alias model shares one index attribute,
// so a pose change doesn't make a new attribute and GL buffer.

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

// Two poses of one 4-vertex strip (two triangles).
function buildHeader() {

	const pose = () => [ 0, 1, 2, 3 ].map( ( i ) => ( { v: [ i, i, i ], lightnormalindex: 0 } ) );
	const commands = [ 4 ];
	for ( let i = 0; i < 4; i ++ ) commands.push( floatBits( i / 4 ), floatBits( 0 ) );
	commands.push( 0 );
	return {
		commands,
		posedata: [ pose(), pose() ],
		scale: [ 1, 1, 1 ],
		scale_origin: [ 0, 0, 0 ]
	};

}

Deno.test( 'GL_DrawAliasFrame shares one index attribute across poses', () => {

	const paliashdr = buildHeader();
	const t0 = gl_mesh.GL_DrawAliasFrame( paliashdr, 0 );
	const t1 = gl_mesh.GL_DrawAliasFrame( paliashdr, 1 );

	assertEqual( t0.indexAttr !== undefined && t0.indexAttr !== null, true, 'index attribute built' );
	assertEqual( t1.indexAttr, t0.indexAttr, 'same attribute for both poses' );
	assertEqual( t0.indexAttr.array instanceof Uint16Array, true, 'Uint16 for a small model' );

	// Strip winding as built by GL_DrawAliasFrame
	const expected = [ 0, 2, 1, 2, 3, 1 ];
	assertEqual( t0.indexAttr.count, expected.length, 'index count' );
	for ( let i = 0; i < expected.length; i ++ )
		assertEqual( t0.indexAttr.array[ i ], expected[ i ], `index ${i}` );

} );
