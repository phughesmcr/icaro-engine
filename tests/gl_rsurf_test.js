// Bootstrap the renderer's existing circular module graph in its safe order.
const gl_rsurf = await import( '../src/gl_rsurf.js' );

const gl_rmain = await import( '../src/gl_rmain.js' );
const { cl } = await import( '../src/client.js' );

function assertEqual( actual, expected, message ) {

	if ( actual !== expected )
		throw new Error( `${message}: expected ${expected}, got ${actual}` );

}

function makeFrame( name, animMin, animMax, diffuse ) {

	return {
		name: name,
		anim_total: 2,
		anim_min: animMin,
		anim_max: animMax,
		anim_next: null,
		alternate_anims: null,
		gl_texture: diffuse
	};

}

Deno.test( 'cached world materials advance animated textures', () => {

	const oldTime = cl.time;
	const oldCurrentEntity = gl_rmain.currententity;
	const fullbright = { name: 'fullbright' };
	const diffuse0 = { name: 'primary 0', _fullbright: null };
	const diffuse1 = { name: 'primary 1', _fullbright: fullbright };
	const diffuseA = { name: 'alternate 0', _fullbright: null };
	const diffuseB = { name: 'alternate 1', _fullbright: null };
	const primary0 = makeFrame( '+0', 0, 1, diffuse0 );
	const primary1 = makeFrame( '+1', 1, 2, diffuse1 );
	const alternate0 = makeFrame( '+A', 0, 1, diffuseA );
	const alternate1 = makeFrame( '+B', 1, 2, diffuseB );

	primary0.anim_next = primary1;
	primary1.anim_next = primary0;
	alternate0.anim_next = alternate1;
	alternate1.anim_next = alternate0;
	primary0.alternate_anims = alternate0;

	const emissive = {
		r: 0,
		g: 0,
		b: 0,
		setRGB( r, g, b ) {

			this.r = r;
			this.g = g;
			this.b = b;

		}
	};
	const material = {
		map: diffuse0,
		emissiveMap: null,
		emissive: emissive,
		needsUpdate: false
	};

	try {

		cl.time = 0.11;
		assertEqual( gl_rsurf.R_TextureAnimation( primary0, 0 ), primary1,
			'primary animation frame' );
		assertEqual( gl_rsurf.R_TextureAnimation( primary0, 1 ), alternate1,
			'alternate animation frame' );

		gl_rmain.set_currententity( { frame: 1 } );
		assertEqual( gl_rsurf.R_TextureAnimation( primary0 ), alternate1,
			'current entity alternate frame' );
		assertEqual( gl_rsurf.R_TextureAnimation( primary0, 0 ), primary1,
			'explicit world frame override' );

		assertEqual( gl_rsurf.R_UpdateAnimatedMaterial( material, primary0, 0 ), true,
			'primary material update' );
		assertEqual( material.map, diffuse1, 'advanced diffuse map' );
		assertEqual( material.emissiveMap, fullbright, 'advanced fullbright map' );
		assertEqual( material.emissive.r, 1, 'fullbright emissive red' );
		assertEqual( material.emissive.g, 1, 'fullbright emissive green' );
		assertEqual( material.emissive.b, 1, 'fullbright emissive blue' );
		assertEqual( material.needsUpdate, true, 'fullbright shader update' );

		material.needsUpdate = false;
		assertEqual( gl_rsurf.R_UpdateAnimatedMaterial( material, primary0, 0 ), false,
			'unchanged material update' );
		assertEqual( material.needsUpdate, false, 'unchanged shader state' );

		cl.time = 0.01;
		assertEqual( gl_rsurf.R_UpdateAnimatedMaterial( material, primary0, 0 ), true,
			'wrapped material update' );
		assertEqual( material.map, diffuse0, 'wrapped diffuse map' );
		assertEqual( material.emissiveMap, null, 'cleared fullbright map' );
		assertEqual( material.emissive.r, 0, 'cleared emissive red' );
		assertEqual( material.emissive.g, 0, 'cleared emissive green' );
		assertEqual( material.emissive.b, 0, 'cleared emissive blue' );
		assertEqual( material.needsUpdate, true, 'cleared fullbright shader update' );

	} finally {

		cl.time = oldTime;
		gl_rmain.set_currententity( oldCurrentEntity );

	}

} );

Deno.test( 'rebuilding lightmaps disposes old Three textures', () => {

	const oldFrame = gl_rmain.r_framecount;
	const textures = gl_rsurf.lightmapTextures;
	let firstDisposals = 0;
	let secondDisposals = 0;

	try {

		assertEqual( textures.length, 0, 'initial lightmap texture count' );
		textures.push(
			{ dispose() { firstDisposals ++; } },
			null,
			{ dispose() { secondDisposals ++; } }
		);

		gl_rsurf.GL_BuildLightmaps();
		assertEqual( gl_rsurf.lightmapTextures, textures, 'lightmap array identity' );
		assertEqual( textures.length, 0, 'cleared lightmap textures' );
		assertEqual( firstDisposals, 1, 'first texture disposal count' );
		assertEqual( secondDisposals, 1, 'second texture disposal count' );

		gl_rsurf.GL_BuildLightmaps();
		assertEqual( firstDisposals, 1, 'idempotent first texture disposal' );
		assertEqual( secondDisposals, 1, 'idempotent second texture disposal' );

	} finally {

		textures.length = 0;
		gl_rmain.set_r_framecount( oldFrame );

	}

} );

Deno.test( 'cached water materials track fractional opacity changes', () => {

	const oldWorldmodel = cl.worldmodel;
	const oldModels = cl.model_precache.slice();
	const oldWaterAlpha = gl_rmain.r_wateralpha.value;
	const oldFrame = gl_rmain.r_framecount;
	const geometry = {
		attributes: { uv: { needsUpdate: false } },
		dispose() {}
	};
	const surface = {
		flags: gl_rmain.SURF_DRAWTURB,
		polys: {},
		texinfo: {
			texture: { anim_total: 0, gl_texture: { id: 987654 } }
		},
		_waterGeoCache: {
			geometry: geometry,
			origUvs: new Float32Array( 0 ),
			turbUvs: new Float32Array( 0 ),
			vertexCount: 0
		}
	};

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

		gl_rmain.r_wateralpha.value = 0.25;
		gl_rsurf.R_DrawSequentialPoly( surface );
		const material = surface._waterMesh.material;
		assertEqual( material.opacity, 0.25, 'initial fractional opacity' );

		gl_rmain.r_wateralpha.value = 0.65;
		gl_rsurf.R_DrawSequentialPoly( surface );
		assertEqual( surface._waterMesh.material, material, 'cached material identity' );
		assertEqual( material.opacity, 0.65, 'updated fractional opacity' );

	} finally {

		gl_rsurf.GL_BuildLightmaps();
		cl.worldmodel = oldWorldmodel;
		cl.model_precache.splice( 0, cl.model_precache.length, ...oldModels );
		gl_rmain.r_wateralpha.value = oldWaterAlpha;
		gl_rmain.set_r_framecount( oldFrame );

	}

} );

function makeLightmapTexture() {

	const w = gl_rsurf.BLOCK_WIDTH;
	const h = gl_rsurf.BLOCK_HEIGHT;
	return {
		image: { data: new Uint8Array( w * h * 4 ).fill( 7 ), width: w, height: h },
		needsUpdate: false
	};

}

function rowTouched( tex, row ) {

	const w = gl_rsurf.BLOCK_WIDTH;
	for ( let p = row * w * 4; p < ( row + 1 ) * w * 4; p ++ )
		if ( tex.image.data[ p ] !== 7 ) return true;
	return false;

}

Deno.test( 'lightmap upload sends only the changed rows', () => {

	const textures = gl_rsurf.lightmapTextures;
	const tex = makeLightmapTexture();
	const calls = [];
	const fakeRenderer = {
		copyTextureToTexture( src, dst, region, position ) {

			calls.push( {
				src, dst,
				minX: region.min.x, minY: region.min.y, maxX: region.max.x, maxY: region.max.y,
				x: position.x, y: position.y
			} );

		}
	};

	try {

		textures.length = 0;
		textures.push( tex );

		gl_rsurf.R_UploadLightmapRect( 0, { l: 5, t: 10, w: 3, h: 3 }, fakeRenderer );

		// GLQuake uploads full-width rows t..t+h (glTexSubImage2D in R_BlendLightmaps)
		assertEqual( calls.length, 1, 'copy calls' );
		const c = calls[ 0 ];
		assertEqual( c.dst, tex, 'destination texture' );
		assertEqual( c.src === tex, false, 'source is not the destination texture' );
		assertEqual( c.src.image, tex.image, 'source shares the block image' );
		assertEqual( c.minX, 0, 'region min x' );
		assertEqual( c.maxX, gl_rsurf.BLOCK_WIDTH, 'region max x' );
		assertEqual( c.minY, 10, 'region min y' );
		assertEqual( c.maxY, 13, 'region max y' );
		assertEqual( c.x, 0, 'destination x' );
		assertEqual( c.y, 10, 'destination y' );
		assertEqual( tex.needsUpdate, false, 'no full re-upload' );

		assertEqual( rowTouched( tex, 9 ), false, 'row above the rect untouched' );
		for ( let row = 10; row < 13; row ++ )
			assertEqual( rowTouched( tex, row ), true, `row ${row} converted` );
		assertEqual( rowTouched( tex, 13 ), false, 'row below the rect untouched' );
		assertEqual( tex.image.data[ 10 * gl_rsurf.BLOCK_WIDTH * 4 + 3 ], 255, 'opaque alpha' );

		gl_rsurf.R_UploadLightmapRect( 0, { l: gl_rsurf.BLOCK_WIDTH, t: gl_rsurf.BLOCK_HEIGHT, w: 0, h: 0 }, fakeRenderer );
		assertEqual( calls.length, 1, 'empty rect uploads nothing' );

	} finally {

		textures.length = 0;

	}

} );

Deno.test( 'lightmap upload without a renderer falls back to a full update', () => {

	const textures = gl_rsurf.lightmapTextures;
	const tex = makeLightmapTexture();

	try {

		textures.length = 0;
		textures.push( tex );

		gl_rsurf.R_UploadLightmapRect( 0, { l: 0, t: 4, w: 1, h: 1 }, null );
		assertEqual( tex.needsUpdate, true, 'needsUpdate set' );
		assertEqual( rowTouched( tex, 4 ), true, 'changed row converted' );
		assertEqual( rowTouched( tex, 5 ), false, 'other rows untouched' );

	} finally {

		textures.length = 0;

	}

} );

// A surface whose lightmap fills a whole 128x128 block (2000-unit extents give
// 126x126 luxels), so each one needs a block of its own.
function makeBlockSizedSurface() {

	return {
		flags: 0,
		numedges: 0,
		firstedge: 0,
		polys: null,
		extents: new Int16Array( [ 2000, 2000 ] ),
		styles: new Uint8Array( [ 255, 255, 255, 255 ] ),
		cached_light: new Int32Array( 4 ),
		cached_dlight: false,
		dlightframe: - 1,
		dlightbits: new Uint32Array( 2 ),
		samples: null,
		lightmaptexturenum: 0,
		light_s: 0,
		light_t: 0
	};

}

Deno.test( 'lightmap blocks grow past MAX_LIGHTMAPS at map load', () => {

	const oldFrame = gl_rmain.r_framecount;
	const oldModel = cl.model_precache[ 1 ];
	const oldNext = cl.model_precache[ 2 ];
	const oldWorldmodel = cl.worldmodel;
	const count = gl_rsurf.MAX_LIGHTMAPS + 6;

	try {

		const surfaces = [];
		for ( let i = 0; i < count; i ++ ) surfaces.push( makeBlockSizedSurface() );
		cl.worldmodel = null;
		cl.model_precache[ 1 ] = {
			name: 'maps/big.bsp',
			numsurfaces: count,
			surfaces: surfaces,
			vertexes: [],
			edges: [],
			surfedges: []
		};
		cl.model_precache[ 2 ] = null;

		gl_rsurf.GL_BuildLightmaps();

		assertEqual( gl_rsurf.lightmap_count, count, 'blocks in use' );
		assertEqual( gl_rsurf.lightmapTextures.length, count, 'one texture per block' );
		const last = surfaces[ count - 1 ];
		assertEqual( last.lightmaptexturenum, count - 1, 'last surface block' );
		assertEqual( last.light_s, 0, 'last surface s' );
		assertEqual( last.light_t, 0, 'last surface t' );

		// The unlit surface writes 255 (no light) into its own 126x126 rect;
		// the upload inverts that to 0. Texels outside it stay cleared (255).
		const data = gl_rsurf.lightmapTextures[ count - 1 ].image.data;
		const BW = gl_rsurf.BLOCK_WIDTH;
		assertEqual( data[ 0 ], 0, 'surface texel in the grown block' );
		assertEqual( data[ ( 125 * BW + 125 ) * 4 ], 0, 'last surface texel' );
		assertEqual( data[ 126 * 4 ], 255, 'texel right of the surface' );
		assertEqual( data[ ( 126 * BW ) * 4 ], 255, 'texel below the surface' );

		// The next map starts again from block 0 and reuses the grown blocks.
		cl.model_precache[ 1 ].numsurfaces = 1;
		cl.model_precache[ 1 ].surfaces = [ makeBlockSizedSurface() ];
		gl_rsurf.GL_BuildLightmaps();
		assertEqual( gl_rsurf.lightmap_count, 1, 'blocks in use on the next map' );
		assertEqual( gl_rsurf.lightmapTextures.length, 1, 'textures on the next map' );

	} finally {

		cl.model_precache[ 1 ] = oldModel;
		cl.model_precache[ 2 ] = oldNext;
		cl.worldmodel = oldWorldmodel;
		gl_rsurf.GL_BuildLightmaps();
		gl_rmain.set_r_framecount( oldFrame );

	}

} );

Deno.test( 'grown lightmap blocks upload changed rows and r_fullbright rebuilds', async () => {

	const { r_fullbright } = await import( '../src/glquake.js' );
	const oldFrame = gl_rmain.r_framecount;
	const oldModel = cl.model_precache[ 1 ];
	const oldNext = cl.model_precache[ 2 ];
	const oldWorldmodel = cl.worldmodel;
	const oldFullbright = r_fullbright.value;
	const count = gl_rsurf.MAX_LIGHTMAPS + 2;
	const last = count - 1;
	const BW = gl_rsurf.BLOCK_WIDTH;
	const calls = [];
	const fakeRenderer = {
		copyTextureToTexture( src, dst, region, position ) {

			calls.push( { src, dst, minY: region.min.y, maxY: region.max.y, y: position.y } );

		}
	};

	try {

		const surfaces = [];
		for ( let i = 0; i < count; i ++ ) surfaces.push( makeBlockSizedSurface() );
		cl.worldmodel = null;
		cl.model_precache[ 1 ] = {
			name: 'maps/big.bsp',
			numsurfaces: count,
			surfaces: surfaces,
			vertexes: [],
			edges: [],
			surfedges: []
		};
		cl.model_precache[ 2 ] = null;

		gl_rsurf.GL_BuildLightmaps();
		assertEqual( gl_rsurf.lightmap_count, count, 'blocks in use' );
		const tex = gl_rsurf.lightmapTextures[ last ];

		// Row upload from a block added after start-up reads that block's own
		// buffer: the unlit surface stores 255 (no light), which converts to 0.
		tex.image.data.fill( 7 );
		gl_rsurf.R_UploadLightmapRect( last, { l: 0, t: 120, w: BW, h: 8 }, fakeRenderer );
		assertEqual( calls.length, 1, 'copy calls' );
		assertEqual( calls[ 0 ].dst, tex, 'grown block texture' );
		assertEqual( calls[ 0 ].src.image, tex.image, 'source shares the grown block image' );
		assertEqual( calls[ 0 ].minY, 120, 'region min y' );
		assertEqual( calls[ 0 ].maxY, 128, 'region max y' );
		assertEqual( calls[ 0 ].y, 120, 'destination y' );
		assertEqual( rowTouched( tex, 119 ), false, 'row above the rect untouched' );
		assertEqual( tex.image.data[ ( 120 * BW ) * 4 ], 0, 'surface texel converted' );
		assertEqual( tex.image.data[ ( 127 * BW ) * 4 ], 255, 'cleared texel converted' );

		// r_fullbright rebuilds every surface and must re-send whole blocks,
		// including grown ones (no renderer here, so a full update).
		tex.image.data.fill( 7 );
		tex.needsUpdate = false;
		r_fullbright.value = 1;
		gl_rsurf.R_BlendLightmaps();
		assertEqual( tex.needsUpdate, true, 'grown block re-uploaded' );
		assertEqual( rowTouched( tex, 0 ), true, 'first row converted' );
		assertEqual( rowTouched( tex, gl_rsurf.BLOCK_HEIGHT - 1 ), true,
			'last row converted (outside the rebuilt surface)' );

	} finally {

		r_fullbright.value = oldFullbright;
		gl_rsurf.R_BlendLightmaps(); // restore the module's r_fullbright state
		cl.model_precache[ 1 ] = oldModel;
		cl.model_precache[ 2 ] = oldNext;
		cl.worldmodel = oldWorldmodel;
		gl_rsurf.GL_BuildLightmaps();
		gl_rmain.set_r_framecount( oldFrame );

	}

} );

// gl_rsurf.c DrawGLWaterPoly: SURF_UNDERWATER vertices move by
// 8*sin(other*0.05+realtime)*sin(z*0.05+realtime) in x and y, z unchanged.
Deno.test( 'underwater world materials warp vertices like DrawGLWaterPoly', () => {

	const vertexShader = '#include <common>\nvoid main() {\n#include <begin_vertex>\n}';
	const fragmentShader = 'uniform vec3 emissive;\n#include <map_fragment>\n#include <emissivemap_fragment>';
	const lmTex = { channel: 0 };

	const underwater = gl_rsurf.R_CreateWorldMaterial( { _fullbright: null }, lmTex, true );
	const dry = gl_rsurf.R_CreateWorldMaterial( { _fullbright: null }, lmTex, false );
	if ( underwater.customProgramCacheKey() === dry.customProgramCacheKey() )
		throw new Error( 'underwater and dry lightmap materials share a program key' );

	const shader = { uniforms: {}, vertexShader, fragmentShader };
	underwater.onBeforeCompile( shader );
	assertEqual( 'quakeWarpTime' in shader.uniforms, true, 'warp uniform' );
	assertEqual( 'quakeLightmapOnly' in shader.uniforms, true, 'lightmap uniform kept' );
	for ( const line of [
		'uniform float quakeWarpTime;',
		'float quakeWarpZ = sin( position.z * 0.05 + quakeWarpTime );',
		'transformed.x += 8.0 * sin( position.y * 0.05 + quakeWarpTime ) * quakeWarpZ;',
		'transformed.y += 8.0 * sin( position.x * 0.05 + quakeWarpTime ) * quakeWarpZ;'
	] ) {

		assertEqual( shader.vertexShader.includes( line ), true, line );

	}

	assertEqual( shader.vertexShader.includes( 'transformed.z' ), false, 'z is not warped' );

	const dryShader = { uniforms: {}, vertexShader, fragmentShader };
	dry.onBeforeCompile( dryShader );
	assertEqual( dryShader.vertexShader, vertexShader, 'dry surfaces do not warp' );

	// no lightmap block: the plain material still warps
	const basic = gl_rsurf.R_CreateWorldMaterial( {}, null, true );
	const basicShader = { uniforms: {}, vertexShader, fragmentShader };
	basic.onBeforeCompile( basicShader );
	assertEqual( 'quakeWarpTime' in basicShader.uniforms, true, 'unlit warp uniform' );

} );

Deno.test( 'R_WaterWarpTime wraps realtime without changing the sines', () => {

	const period = Math.PI * 2;
	for ( const t of [ 0, 1.25, period, 1000.5, 86400.123 ] ) {

		const wrapped = gl_rsurf.R_WaterWarpTime( t );
		if ( wrapped < 0 || wrapped >= period )
			throw new Error( `R_WaterWarpTime(${t}) = ${wrapped} is outside [0, 2*PI)` );
		const diff = Math.abs( Math.sin( 3.7 + wrapped ) - Math.sin( 3.7 + t ) );
		if ( diff > 1e-9 )
			throw new Error( `sin differs by ${diff} at realtime ${t}` );

	}

} );

Deno.test( 'DrawGLWaterPoly keeps DrawGLPoly\'s geometry for the shader warp', () => {

	const p = {
		numverts: 4,
		verts: new Float32Array( [
			0, 0, 0, 0, 0, 0.1, 0.1,
			64, 0, 0, 1, 0, 0.9, 0.1,
			64, 64, 0, 1, 1, 0.9, 0.9,
			0, 64, 0, 0, 1, 0.1, 0.9
		] )
	};
	const normal = [ 0, 0, 1 ];
	const water = gl_rsurf.DrawGLWaterPoly( p, normal );
	const plain = gl_rsurf.DrawGLPoly( p, normal );
	for ( const name of [ 'position', 'normal', 'uv', 'uv1' ] ) {

		const a = water.getAttribute( name ).array;
		const b = plain.getAttribute( name ).array;
		assertEqual( a.length, b.length, `${name} length` );
		for ( let i = 0; i < a.length; i ++ )
			assertEqual( a[ i ], b[ i ], `${name}[${i}]` );

	}

	assertEqual( gl_rsurf.DrawGLWaterPoly( null, normal ), undefined, 'no poly' );

} );
