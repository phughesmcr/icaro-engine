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

Deno.test( 'r_fullbright rebuild uploads whole lightmap blocks', async () => {

	const { r_fullbright } = await import( '../src/glquake.js' );
	const textures = gl_rsurf.lightmapTextures;
	const tex = makeLightmapTexture();
	const oldPrecache = cl.model_precache[ 1 ];
	const oldPrecache2 = cl.model_precache[ 2 ];
	const oldFullbright = r_fullbright.value;
	const surf = {
		flags: 0,
		lightmaptexturenum: 0,
		light_s: 0,
		light_t: 0,
		extents: [ 0, 0 ],
		samples: null,
		styles: [ 255, 255, 255, 255 ],
		cached_light: [ 0, 0, 0, 0 ],
		dlightframe: - 1
	};

	try {

		textures.length = 0;
		textures.push( tex );
		cl.model_precache[ 1 ] = { name: 'maps/test.bsp', surfaces: [ surf ], numsurfaces: 1 };
		cl.model_precache[ 2 ] = null;

		r_fullbright.value = 1;
		gl_rsurf.R_BlendLightmaps();

		// One 1x1 surface was rebuilt, but every row of its block is re-sent.
		assertEqual( tex.needsUpdate, true, 'block re-uploaded' );
		assertEqual( rowTouched( tex, 0 ), true, 'first row converted' );
		assertEqual( rowTouched( tex, gl_rsurf.BLOCK_HEIGHT - 1 ), true, 'last row converted' );

	} finally {

		r_fullbright.value = oldFullbright;
		gl_rsurf.R_BlendLightmaps(); // restore the module's r_fullbright state
		textures.length = 0;
		cl.model_precache[ 1 ] = oldPrecache;
		cl.model_precache[ 2 ] = oldPrecache2;

	}

} );
