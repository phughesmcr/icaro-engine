// Water turbulence and the sky scroll run in the vertex shader. CI can't
// compile GLSL, so these check that each patch finds its anchors and wires
// the shared uniforms, and that drawing a water surface sets the clock.

// Bootstrap the renderer's existing circular module graph in its safe order.
const gl_rsurf = await import( '../src/gl_rsurf.js' );

const gl_rmain = await import( '../src/gl_rmain.js' );
const { cl } = await import( '../src/client.js' );

function assertEqual( actual, expected, message ) {

	if ( actual !== expected )
		throw new Error( `${message}: expected ${expected}, got ${actual}` );

}

function assertIncludes( text, part, message ) {

	if ( text.includes( part ) === false )
		throw new Error( `${message}: missing ${part}` );

}

// The anchors as they appear in Three r183's meshbasic vertex shader.
function makeShader() {

	return {
		uniforms: {},
		vertexShader: '#include <common>\nvoid main() {\n#include <uv_vertex>\n#include <begin_vertex>\n}\n'
	};

}

Deno.test( 'turbulence patch injects the warped vMapUv after uv_vertex', () => {

	const shader = makeShader();
	gl_rsurf.R_PatchTurbVertexShader( shader );

	assertIncludes( shader.vertexShader, 'uniform float quakeTurbTime;', 'uniform declared' );
	assertIncludes( shader.vertexShader, '#include <uv_vertex>\n#ifdef USE_MAP\n\tvMapUv = ( uv + 8.0 * sin( trunc(', 'warp injected' );
	if ( shader.uniforms.quakeTurbTime === undefined || typeof shader.uniforms.quakeTurbTime.value !== 'number' )
		throw new Error( 'quakeTurbTime uniform not set' );

	const other = makeShader();
	gl_rsurf.R_PatchTurbVertexShader( other );
	assertEqual( other.uniforms.quakeTurbTime, shader.uniforms.quakeTurbTime, 'one shared clock' );

} );

// The injected GLSL expression for s, written in JS: trunc and sin of the
// same index give gl_warp.c's 256-entry turbsin table.
const TURB_GLSL = 'vMapUv = ( uv + 8.0 * sin( trunc( ( uv.yx * 0.125 + quakeTurbTime ) * ( 128.0 / PI ) ) * ( PI / 128.0 ) ) ) * ( 1.0 / 64.0 );';

function turbGlslS( os, ot, time ) {

	return ( os + 8.0 * Math.sin( Math.trunc( ( ot * 0.125 + time ) * ( 128.0 / Math.PI ) ) * ( Math.PI / 128.0 ) ) ) * ( 1.0 / 64.0 );

}

Deno.test( 'the turbulence expression matches EmitWaterPolys and turbsin', async () => {

	const { turbsin } = await import( '../src/gl_warp.js' );
	const TURBSCALE = 256.0 / ( 2 * Math.PI );

	const shader = makeShader();
	gl_rsurf.R_PatchTurbVertexShader( shader );
	assertIncludes( shader.vertexShader, TURB_GLSL, 'the expression mirrored below' );

	for ( const os of [ 0, 13.5, - 200, 1024.25 ] ) {

		for ( const ot of [ 0, 7.25, - 64.5, 900 ] ) {

			for ( const time of [ 0, 0.3, 1.7, 4.4, 6.2 ] ) {

				// gl_warp.c EmitWaterPolys
				const c = ( os + turbsin[ ( ( ot * 0.125 + time ) * TURBSCALE | 0 ) & 255 ] ) * ( 1.0 / 64 );
				const glsl = turbGlslS( os, ot, time );
				if ( Math.abs( glsl - c ) > 1e-5 )
					throw new Error( `os ${os} ot ${ot} time ${time}: shader ${glsl}, C ${c}` );

			}

		}

	}

} );

Deno.test( 'sky patches share the origin and keep one speed per layer', () => {

	const solid = makeShader();
	const alpha = makeShader();
	gl_rsurf.R_PatchSolidSkyVertexShader( solid );
	gl_rsurf.R_PatchAlphaSkyVertexShader( alpha );

	for ( const shader of [ solid, alpha ] ) {

		assertIncludes( shader.vertexShader, 'uniform vec3 quakeSkyOrigin;', 'origin declared' );
		assertIncludes( shader.vertexShader, 'uniform float quakeSkySpeed;', 'speed declared' );
		assertIncludes( shader.vertexShader, '\tquakeSkyDir.z *= 3.0;\n', 'sphere flattened' );
		assertIncludes( shader.vertexShader, '6.0 * 63.0 / length( quakeSkyDir )', 'length scale' );

	}

	assertEqual( solid.uniforms.quakeSkyOrigin, alpha.uniforms.quakeSkyOrigin, 'one shared origin' );
	if ( solid.uniforms.quakeSkySpeed === alpha.uniforms.quakeSkySpeed )
		throw new Error( 'the two sky layers share one speed uniform' );

} );

Deno.test( 'drawing a water surface sets the wrapped turbulence clock', () => {

	const oldTime = cl.time;
	const oldWorldmodel = cl.worldmodel;
	const oldModels = cl.model_precache.slice();
	const oldFrame = gl_rmain.r_framecount;
	const geometry = { attributes: { uv: { needsUpdate: false } }, dispose() {} };
	const surface = {
		flags: gl_rmain.SURF_DRAWTURB,
		polys: {},
		texinfo: { texture: { anim_total: 0, gl_texture: { id: 987655 } } },
		_waterGeoCache: { geometry: geometry, vertexCount: 0 }
	};
	const shader = makeShader();
	gl_rsurf.R_PatchTurbVertexShader( shader );

	try {

		cl.worldmodel = {
			numleafs: 0,
			leafs: [],
			firstmodelsurface: 0,
			nummodelsurfaces: 0,
			numsurfaces: 0,
			surfaces: []
		};
		cl.model_precache.fill( null );
		gl_rsurf.GL_BuildLightmaps();

		cl.time = 10;
		gl_rsurf.R_DrawSequentialPoly( surface );
		const material = surface._waterMesh.material;
		assertEqual( material.onBeforeCompile, gl_rsurf.R_PatchTurbVertexShader, 'water material patched' );
		if ( Math.abs( shader.uniforms.quakeTurbTime.value - ( 10 - 2 * Math.PI ) ) > 1e-9 )
			throw new Error( `clock: expected ${10 - 2 * Math.PI}, got ${shader.uniforms.quakeTurbTime.value}` );
		assertEqual( geometry.attributes.uv.needsUpdate, false, 'no per-frame UV upload' );

	} finally {

		gl_rsurf.GL_BuildLightmaps();
		cl.time = oldTime;
		cl.worldmodel = oldWorldmodel;
		cl.model_precache.splice( 0, cl.model_precache.length, ...oldModels );
		gl_rmain.set_r_framecount( oldFrame );

	}

} );
