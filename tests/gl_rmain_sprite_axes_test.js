// Bootstrap the renderer's existing circular module graph in its safe order.
await import( '../src/gl_rsurf.js' );

const gl_rmain = await import( '../src/gl_rmain.js' );
const gl_model = await import( '../src/gl_model.js' );
const { r_origin, vpn, vright, vup } = await import( '../src/render.js' );

function assertNear( actual, expected, message, epsilon = 1e-5 ) {

	if ( Number.isFinite( actual ) === false || Math.abs( actual - expected ) > epsilon )
		throw new Error( `${message}: expected ${expected}, got ${actual}` );

}

function assertVec( actual, expected, message ) {

	for ( let i = 0; i < 3; i ++ ) assertNear( actual[ i ], expected[ i ], message + '[' + i + ']' );

}

function assertEqual( actual, expected, message ) {

	if ( actual !== expected )
		throw new Error( `${message}: expected ${expected}, got ${actual}` );

}

// Runs fn with the view looking along +x (forward), right = -y, up = +z,
// or with the given vectors, and restores the view afterwards.
function withView( forward, right, up, origin, fn ) {

	const saved = [ vpn, vright, vup, r_origin ].map( ( v ) => new Float32Array( v ) );
	vpn.set( forward );
	vright.set( right );
	vup.set( up );
	r_origin.set( origin );
	try {

		fn();

	} finally {

		vpn.set( saved[ 0 ] );
		vright.set( saved[ 1 ] );
		vup.set( saved[ 2 ] );
		r_origin.set( saved[ 3 ] );

	}

}

function entity( origin, angles ) {

	return { origin: new Float32Array( origin ), angles: new Float32Array( angles ) };

}

const up = new Float32Array( 3 );
const right = new Float32Array( 3 );

Deno.test( 'SPR_VP_PARALLEL uses the view axes', () => {

	withView( [ 0.6, 0, - 0.8 ], [ 0, - 1, 0 ], [ 0.8, 0, 0.6 ], [ 0, 0, 0 ], () => {

		assertEqual( gl_rmain.R_SpriteAxes( gl_model.SPR_VP_PARALLEL, entity( [ 0, 0, 0 ], [ 0, 0, 0 ] ), up, right ), true, 'drawn' );
		assertVec( up, [ 0.8, 0, 0.6 ], 'up' );
		assertVec( right, [ 0, - 1, 0 ], 'right' );

	} );

} );

Deno.test( 'SPR_VP_PARALLEL_UPRIGHT keeps up vertical and right in the view plane', () => {

	// looking along +x and down 36.87 degrees
	withView( [ 0.8, 0, - 0.6 ], [ 0, - 1, 0 ], [ 0.6, 0, 0.8 ], [ 0, 0, 0 ], () => {

		assertEqual( gl_rmain.R_SpriteAxes( gl_model.SPR_VP_PARALLEL_UPRIGHT, entity( [ 0, 0, 0 ], [ 0, 0, 0 ] ), up, right ), true, 'drawn' );
		assertVec( up, [ 0, 0, 1 ], 'up' );
		assertVec( right, [ 0, - 1, 0 ], 'right' );

	} );

	// within 1 degree of straight down: not drawn, as in WinQuake r_sprite.c
	withView( [ 0, 0, - 1 ], [ 0, - 1, 0 ], [ 1, 0, 0 ], [ 0, 0, 0 ], () => {

		assertEqual( gl_rmain.R_SpriteAxes( gl_model.SPR_VP_PARALLEL_UPRIGHT, entity( [ 0, 0, 0 ], [ 0, 0, 0 ] ), up, right ), false, 'skipped looking down' );

	} );

} );

Deno.test( 'SPR_FACING_UPRIGHT faces the viewer, whatever the view direction', () => {

	// sprite at +y of the viewer; the view direction doesn't matter
	withView( [ 1, 0, 0 ], [ 0, - 1, 0 ], [ 0, 0, 1 ], [ 0, 0, 0 ], () => {

		assertEqual( gl_rmain.R_SpriteAxes( gl_model.SPR_FACING_UPRIGHT, entity( [ 0, 100, 50 ], [ 0, 0, 0 ] ), up, right ), true, 'drawn' );
		assertVec( up, [ 0, 0, 1 ], 'up' );
		// perpendicular to the viewer->sprite line, horizontal
		assertVec( right, [ 1, 0, 0 ], 'right' );

		// directly above the viewer: not drawn
		assertEqual( gl_rmain.R_SpriteAxes( gl_model.SPR_FACING_UPRIGHT, entity( [ 0, 0, 100 ], [ 0, 0, 0 ] ), up, right ), false, 'skipped overhead' );

	} );

} );

Deno.test( 'SPR_ORIENTED takes its axes from the entity angles', () => {

	withView( [ 1, 0, 0 ], [ 0, - 1, 0 ], [ 0, 0, 1 ], [ 0, 0, 0 ], () => {

		// yaw 90: forward +y, right +x
		assertEqual( gl_rmain.R_SpriteAxes( gl_model.SPR_ORIENTED, entity( [ 0, 0, 0 ], [ 0, 90, 0 ] ), up, right ), true, 'drawn' );
		assertVec( up, [ 0, 0, 1 ], 'up' );
		assertVec( right, [ 1, 0, 0 ], 'right' );

	} );

} );

Deno.test( 'SPR_VP_PARALLEL_ORIENTED rotates the view axes by the roll', () => {

	withView( [ 1, 0, 0 ], [ 0, - 1, 0 ], [ 0, 0, 1 ], [ 0, 0, 0 ], () => {

		assertEqual( gl_rmain.R_SpriteAxes( gl_model.SPR_VP_PARALLEL_ORIENTED, entity( [ 0, 0, 0 ], [ 0, 0, 90 ] ), up, right ), true, 'drawn' );
		// right = vright * cos + vup * sin, up = -vright * sin + vup * cos
		assertVec( right, [ 0, 0, 1 ], 'right' );
		assertVec( up, [ 0, 1, 0 ], 'up' );

	} );

} );

Deno.test( 'an unknown sprite type is not drawn', () => {

	assertEqual( gl_rmain.R_SpriteAxes( 99, entity( [ 0, 0, 0 ], [ 0, 0, 0 ] ), up, right ), false, 'unknown type' );

} );

Deno.test( 'oriented sprites get their own material with a decal polygon offset', () => {

	const texture = {};
	const normal = gl_rmain.R_SpriteMaterial( texture, false );
	const decal = gl_rmain.R_SpriteMaterial( texture, true );
	assertEqual( normal === decal, false, 'separate materials' );
	assertEqual( gl_rmain.R_SpriteMaterial( texture, true ), decal, 'decal material cached' );
	assertEqual( decal.polygonOffset, true, 'decal polygon offset' );
	assertEqual( decal.polygonOffsetFactor, - 1, 'decal offset factor' );
	assertEqual( decal.polygonOffsetUnits, - 1, 'decal offset units' );
	assertEqual( normal.polygonOffset === true, false, 'no offset on normal sprites' );

} );
