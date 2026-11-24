// Mirror surfaces (port review C-5). The shareware pak has no mirror texture,
// so these cover the maths, the cvar gate and the chain bookkeeping only. The
// render pass itself has not been seen on e2m3 (registered data).

// Bootstrap the renderer's existing circular module graph in its safe order.
const gl_rsurf = await import( '../src/gl_rsurf.js' );
const gl_rmain = await import( '../src/gl_rmain.js' );
const gl_rmirror = await import( '../src/gl_rmirror.js' );
const { cl } = await import( '../src/client.js' );

function assertNear( actual, expected, message, epsilon = 1e-5 ) {

	if ( Number.isFinite( actual ) === false || Math.abs( actual - expected ) > epsilon )
		throw new Error( `${message}: expected ${expected}, got ${actual}` );

}

function assertEqual( actual, expected, message ) {

	if ( actual !== expected )
		throw new Error( `${message}: expected ${expected}, got ${actual}` );

}

function norm( v ) {

	const l = Math.hypot( v[ 0 ], v[ 1 ], v[ 2 ] );
	return [ v[ 0 ] / l, v[ 1 ] / l, v[ 2 ] / l ];

}

// column-major 4x4 times [x,y,z,w]
function mul( m, v ) {

	return [
		m[ 0 ] * v[ 0 ] + m[ 4 ] * v[ 1 ] + m[ 8 ] * v[ 2 ] + m[ 12 ] * v[ 3 ],
		m[ 1 ] * v[ 0 ] + m[ 5 ] * v[ 1 ] + m[ 9 ] * v[ 2 ] + m[ 13 ] * v[ 3 ],
		m[ 2 ] * v[ 0 ] + m[ 6 ] * v[ 1 ] + m[ 10 ] * v[ 2 ] + m[ 14 ] * v[ 3 ],
		m[ 3 ] * v[ 0 ] + m[ 7 ] * v[ 1 ] + m[ 11 ] * v[ 2 ] + m[ 15 ] * v[ 3 ]
	];

}

function perspective( fovY, aspect, near, far ) {

	const f = 1 / Math.tan( fovY / 2 );
	const m = new Array( 16 ).fill( 0 );
	m[ 0 ] = f / aspect;
	m[ 5 ] = f;
	m[ 10 ] = ( far + near ) / ( near - far );
	m[ 11 ] = - 1;
	m[ 14 ] = 2 * far * near / ( near - far );
	return m;

}

// camera world matrix like R_SetupGL builds: x = right, y = up, z = -forward
function cameraWorld( pos, fwd, up ) {

	const r = [
		fwd[ 1 ] * up[ 2 ] - fwd[ 2 ] * up[ 1 ],
		fwd[ 2 ] * up[ 0 ] - fwd[ 0 ] * up[ 2 ],
		fwd[ 0 ] * up[ 1 ] - fwd[ 1 ] * up[ 0 ]
	];
	return [ ...r, 0, ...up, 0, - fwd[ 0 ], - fwd[ 1 ], - fwd[ 2 ], 0, ...pos, 1 ];

}

Deno.test( 'R_MirrorGate only opens below r_mirroralpha 1 and never under XR', () => {

	assertEqual( gl_rmirror.R_MirrorGate( 1, false ), false, 'default alpha 1' );
	assertEqual( gl_rmirror.R_MirrorGate( 1.5, false ), false, 'alpha above 1' );
	assertEqual( gl_rmirror.R_MirrorGate( 0.999, false ), true, 'alpha just under 1' );
	assertEqual( gl_rmirror.R_MirrorGate( 0, false ), true, 'alpha 0' );
	assertEqual( gl_rmirror.R_MirrorGate( 0.5, true ), false, 'XR active' );

} );

Deno.test( 'R_ReflectPoint and R_ReflectVector reflect through the plane', () => {

	const n = norm( [ 1, 2, 2 ] );
	const dist = 7;
	const p = [ 3, - 4, 10 ];
	const q = gl_rmirror.R_ReflectPoint( [ 0, 0, 0 ], p, n, dist );

	// the midpoint lies on the plane
	const mid = [ ( p[ 0 ] + q[ 0 ] ) / 2, ( p[ 1 ] + q[ 1 ] ) / 2, ( p[ 2 ] + q[ 2 ] ) / 2 ];
	assertNear( n[ 0 ] * mid[ 0 ] + n[ 1 ] * mid[ 1 ] + n[ 2 ] * mid[ 2 ], dist, 'midpoint on plane' );

	// the segment is along the normal
	const seg = norm( [ q[ 0 ] - p[ 0 ], q[ 1 ] - p[ 1 ], q[ 2 ] - p[ 2 ] ] );
	assertNear( Math.abs( seg[ 0 ] * n[ 0 ] + seg[ 1 ] * n[ 1 ] + seg[ 2 ] * n[ 2 ] ), 1, 'segment along normal' );

	// reflecting twice is the identity
	const back = gl_rmirror.R_ReflectPoint( [ 0, 0, 0 ], q, n, dist );
	for ( let i = 0; i < 3; i ++ ) assertNear( back[ i ], p[ i ], 'involution' );

	// a point on the plane stays put
	const on = gl_rmirror.R_ReflectPoint( [ 0, 0, 0 ], [ n[ 0 ] * dist, n[ 1 ] * dist, n[ 2 ] * dist ], n, dist );
	for ( let i = 0; i < 3; i ++ ) assertNear( on[ i ], n[ i ] * dist, 'on-plane point fixed' );

	// vectors: the normal flips, in-plane vectors stay
	const flipped = gl_rmirror.R_ReflectVector( [ 0, 0, 0 ], n, n );
	for ( let i = 0; i < 3; i ++ ) assertNear( flipped[ i ], - n[ i ], 'normal flips' );
	const inPlane = norm( [ 2, - 1, 0 ] ); // 1*2 + 2*-1 + 0 = 0, perpendicular to n
	const same = gl_rmirror.R_ReflectVector( [ 0, 0, 0 ], inPlane, n );
	for ( let i = 0; i < 3; i ++ ) assertNear( same[ i ], inPlane[ i ], 'in-plane vector fixed' );

} );

Deno.test( 'R_MirrorCameraWorld is a proper rotation placed at the reflected eye', () => {

	const n = [ 0, 1, 0 ];
	const dist = 100; // mirror plane y = 100
	const f = norm( [ 1, 1, 0 ] );
	const cam = cameraWorld( [ 10, 40, 20 ], f, [ 0, 0, 1 ] );
	const out = gl_rmirror.R_MirrorCameraWorld( new Array( 16 ), cam, n, dist );

	assertNear( out[ 12 ], 10, 'eye x' );
	assertNear( out[ 13 ], 160, 'eye y reflected' );
	assertNear( out[ 14 ], 20, 'eye z' );

	// forward (-z column) is reflected
	assertNear( - out[ 8 ], f[ 0 ], 'forward x' );
	assertNear( - out[ 9 ], - f[ 1 ], 'forward y flipped' );

	// orthonormal with determinant +1 (right = forward x up)
	const r = [ out[ 0 ], out[ 1 ], out[ 2 ] ];
	const u = [ out[ 4 ], out[ 5 ], out[ 6 ] ];
	const b = [ out[ 8 ], out[ 9 ], out[ 10 ] ];
	assertNear( Math.hypot( ...r ), 1, 'right unit' );
	assertNear( r[ 0 ] * u[ 0 ] + r[ 1 ] * u[ 1 ] + r[ 2 ] * u[ 2 ], 0, 'right . up' );
	const det = r[ 0 ] * ( u[ 1 ] * b[ 2 ] - u[ 2 ] * b[ 1 ] ) -
		r[ 1 ] * ( u[ 0 ] * b[ 2 ] - u[ 2 ] * b[ 0 ] ) +
		r[ 2 ] * ( u[ 0 ] * b[ 1 ] - u[ 1 ] * b[ 0 ] );
	assertNear( det, 1, 'determinant' );

	// the real eye's line of sight and the virtual camera's meet at one mirror point
	const t = ( dist - 40 ) / f[ 1 ];
	const hitX = 10 + f[ 0 ] * t;
	const vf = [ - out[ 8 ], - out[ 9 ], - out[ 10 ] ];
	const t2 = ( dist - out[ 13 ] ) / vf[ 1 ];
	assertNear( out[ 12 ] + vf[ 0 ] * t2, hitX, 'virtual camera hits the same mirror point' );

} );

Deno.test( 'R_ObliqueProjection puts the near plane on the mirror plane', () => {

	const n = norm( [ 1, 1, 0 ] );
	const dist = 50;
	const eye = [ 120, 90, 30 ]; // n . eye = 148.5 > dist: viewer side is positive
	const cam = cameraWorld( eye, norm( [ - 1, - 0.7, 0 ] ), [ 0, 0, 1 ] ); // up must be perpendicular to forward
	const world = gl_rmirror.R_MirrorCameraWorld( new Array( 16 ), cam, n, dist );
	const view = gl_rmirror.R_RigidInverse( new Array( 16 ), world );
	const proj = perspective( 1.5, 4 / 3, 4, 4096 );

	const clip = gl_rmirror.R_PlaneToCameraSpace( [ 0, 0, 0, 0 ], n, dist, view );
	gl_rmirror.R_ObliqueProjection( proj, clip );

	function clipOf( p ) {

		return mul( proj, mul( view, [ p[ 0 ], p[ 1 ], p[ 2 ], 1 ] ) );

	}

	// points on the plane land on the near plane (ndc z = -1)
	const tangent = norm( [ 1, - 1, 0 ] );
	for ( const s of [ 0, 20, - 35 ] ) {

		const c = clipOf( [
			n[ 0 ] * dist + tangent[ 0 ] * s,
			n[ 1 ] * dist + tangent[ 1 ] * s,
			15 + s / 2
		] );
		assertNear( c[ 2 ] / c[ 3 ], - 1, 'plane point on near plane', 1e-4 );

	}

	// a point on the viewer's side is kept, one behind the mirror is clipped
	const kept = clipOf( [ n[ 0 ] * 300, n[ 1 ] * 300, 20 ] );
	if ( kept[ 3 ] <= 0 || kept[ 2 ] / kept[ 3 ] <= - 1 )
		throw new Error( 'point on the kept side was clipped' );

	const behind = clipOf( [ n[ 0 ] * 10, n[ 1 ] * 10, 20 ] );
	if ( behind[ 3 ] > 0 && behind[ 2 ] / behind[ 3 ] > - 1 )
		throw new Error( 'point behind the mirror was not clipped' );

} );

function mirrorWorld() {

	const plane = { normal: [ 0, 1, 0 ], dist: 10 };
	const make = ( p ) => ( { flags: 0, plane: p, styles: [ 255 ], dlightframe: - 1, cached_dlight: false, texturechain: null } );
	const surfA = make( plane );
	const surfB = make( plane );
	const other = make( { normal: [ 1, 0, 0 ], dist: 0 } );
	const tex = { name: 'window02_1', anim_total: 0, texturechain: null };
	for ( const s of [ surfA, surfB, other ] ) s.texinfo = { texture: tex };
	surfA.texturechain = other;
	other.texturechain = surfB;
	tex.texturechain = surfA;
	return { plane, tex };

}

function withWorld( alpha, fn ) {

	const w = mirrorWorld();
	const oldWorld = cl.worldmodel;
	const oldNum = gl_rmain.mirrortexturenum;
	const oldAlpha = gl_rmain.r_mirroralpha.value;
	const oldTexsort = gl_rmain.gl_texsort.value;

	cl.worldmodel = { numtextures: 1, textures: [ w.tex ] };
	gl_rmain.set_mirrortexturenum( 0 );
	gl_rmain.set_mirror( false );
	gl_rmain.set_mirror_plane( null );
	gl_rmain.r_mirroralpha.value = alpha;
	gl_rmain.gl_texsort.value = 1;

	try {

		fn( w );

	} finally {

		cl.worldmodel = oldWorld;
		gl_rmain.set_mirrortexturenum( oldNum );
		gl_rmain.set_mirror( false );
		gl_rmain.set_mirror_plane( null );
		gl_rmain.r_mirroralpha.value = oldAlpha;
		gl_rmain.gl_texsort.value = oldTexsort;

	}

}

Deno.test( 'default r_mirroralpha 1 never starts a mirror pass', () => {

	withWorld( 1, ( w ) => {

		gl_rsurf.DrawTextureChains();

		assertEqual( gl_rmain.mirror, false, 'mirror flag stays clear' );
		assertEqual( gl_rmain.mirror_plane, null, 'no mirror plane' );
		assertEqual( gl_rsurf.R_GetMirrorItems().length, 0, 'no mirror items' );
		assertEqual( w.tex.texturechain, null, 'chain consumed as an ordinary texture' );

	} );

} );

Deno.test( 'r_mirroralpha below 1 flags the mirror and clears the chain', () => {

	withWorld( 0.5, ( w ) => {

		gl_rsurf.DrawTextureChains();

		assertEqual( gl_rmain.mirror, true, 'mirror flag set' );
		assertEqual( gl_rmain.mirror_plane, w.plane, 'plane of the first chain surface' );
		assertEqual( w.tex.texturechain, null, 'chain cleared so the next frame cannot loop on it' );

	} );

} );

Deno.test( 'mirror texture is recognised by name, independent of mirrortexturenum', () => {

	assertEqual( gl_rsurf.R_IsMirrorTexture( { name: 'window02_1' } ), true, 'window02_1' );
	assertEqual( gl_rsurf.R_IsMirrorTexture( { name: 'window02_2' } ), false, 'other window' );
	assertEqual( gl_rsurf.R_IsMirrorTexture( null ), false, 'null' );

} );
