// Ported from: WinQuake/glquake.h -- GL definitions and state variables

import * as THREE from 'three';

/*
===============================================================================

GL DEFINITIONS AND STATE

===============================================================================
*/

export const ALIAS_BASE_SIZE_RATIO = ( 1.0 / 11.0 );
export const MAX_LBM_HEIGHT = 480;

export const TILE_SIZE = 128;

export const SKYSHIFT = 7;
export const SKYSIZE = ( 1 << SKYSHIFT );
export const SKYMASK = ( SKYSIZE - 1 );

export const BACKFACE_EPSILON = 0.01;

// GLQuake modulates texture by lightmap in display space (glBlendFunc on the
// gamma-corrected palette colours). Three's Lambert path multiplies in linear
// space and divides indirect light by PI. Decoding the lightmap as sRGB and
// reading it at intensity PI gives back texture * lightmap / 255 in display
// space, within a few levels of GLQuake across the range.
export const LIGHTMAP_INTENSITY = Math.PI;

// Multitexture
export const TEXTURE0_SGIS = 0x835E;
export const TEXTURE1_SGIS = 0x835F;

//
// VERTEXSIZE for glpoly_t verts: x y z s t (lightmap s) (lightmap t)
//
export const VERTEXSIZE = 7;

export const MAXLIGHTMAPS = 4;

/*
===============================================================================

TEXTURE MANAGEMENT

===============================================================================
*/

export const MAX_GLTEXTURES = 1024;

export class gltexture_t {

	constructor() {

		this.identifier = '';
		this.texnum = 0;
		this.width = 0;
		this.height = 0;
		this.mipmap = false;
		// Three.js texture reference
		this.texture = null;

	}

}

export let texture_extension_number = 1;
export const texture_mode = 0; // GL_LINEAR_MIPMAP_NEAREST equivalent

export const gldepthmin = 0;
export const gldepthmax = 0;

export let currenttexture = - 1;
export const cnttextures = [ - 1, - 1 ];
export const particletexture = 0;
export const playertextures = 0;

export const gltextures = [];
export const numgltextures = 0;

export function setTextureExtensionNumber( n ) {

	texture_extension_number = n;

}

export function getTextureExtensionNumber() {

	return texture_extension_number ++;

}

/*
===============================================================================

POLYGON STRUCTURE

===============================================================================
*/

export class glpoly_t {

	constructor() {

		this.next = null;
		this.chain = null;
		this.numverts = 0;
		this.flags = 0;
		this.verts = []; // array of arrays, each [x,y,z,s,t,ls,lt]

	}

}

/*
===============================================================================

GL VERTEX TYPE

===============================================================================
*/

export class glvert_t {

	constructor() {

		this.x = 0;
		this.y = 0;
		this.z = 0;
		this.s = 0;
		this.t = 0;
		this.r = 0;
		this.g = 0;
		this.b = 0;

	}

}

export const glv = new glvert_t();

export const glx = 0;
export const gly = 0;
export const glwidth = 640;
export const glheight = 480;

/*
===============================================================================

PARTICLE TYPE

===============================================================================
*/

export const pt_static = 0;
export const pt_grav = 1;
export const pt_slowgrav = 2;
export const pt_fire = 3;
export const pt_explode = 4;
export const pt_explode2 = 5;
export const pt_blob = 6;
export const pt_blob2 = 7;

export class particle_t {

	constructor() {

		// driver-usable fields
		this.org = new Float32Array( 3 );
		this.color = 0;
		// drivers never touch the following fields
		this.next = null;
		this.vel = new Float32Array( 3 );
		this.ramp = 0;
		this.die = 0;
		this.type = pt_static;

	}

}

/*
===============================================================================

RENDER STATE VARIABLES

===============================================================================
*/

export const r_worldentity = null; // entity_t
export const r_cache_thrash = false;
export const modelorg = new Float32Array( 3 );
export const r_entorigin = new Float32Array( 3 );
export const currententity = null;
export const r_visframecount = 0;
export let r_framecount = 0;
export function set_r_framecount( value ) { r_framecount = value; }
export function inc_r_framecount() { return ++ r_framecount; }
export const frustum = []; // mplane_t[4]
export const c_brush_polys = 0;
export const c_alias_polys = 0;

// view origin
export const vup = new Float32Array( 3 );
export const vpn = new Float32Array( 3 );
export const vright = new Float32Array( 3 );
export const r_origin = new Float32Array( 3 );

// screen size info
export const r_refdef = null; // refdef_t
export const r_viewleaf = null;
export const r_oldviewleaf = null;
export const r_notexture_mip = null;
export const d_lightstylevalue = new Int32Array( 256 );


export const skytexturenum = - 1;
export let mirrortexturenum = - 1;
export function set_mirrortexturenum( value ) { mirrortexturenum = value; }
export const mirror = false;
export const mirror_plane = null;

export const r_world_matrix = new Float32Array( 16 );

// GL format constants (mapped to WebGL equivalents conceptually)
export const gl_lightmap_format = 4; // GL_RGBA
export const gl_solid_format = 3; // GL_RGB
export const gl_alpha_format = 4; // GL_RGBA

export const gl_mtexable = false;

/*
===============================================================================

CVARS (placeholder objects matching cvar_t structure)

===============================================================================
*/

export const r_norefresh = { name: 'r_norefresh', string: '0', value: 0 };
export const r_drawentities = { name: 'r_drawentities', string: '1', value: 1 };
export const r_drawworld = { name: 'r_drawworld', string: '1', value: 1 };
export const r_drawviewmodel = { name: 'r_drawviewmodel', string: '1', value: 1 };
export const r_speeds = { name: 'r_speeds', string: '0', value: 0 };
// Registered by gl_screenwarp.js (GLQuake never registered it). Fitz, QS and
// Ironwail default to 1 and archive it; 0 keeps GLQuake's unwarped view.
export const r_waterwarp = { name: 'r_waterwarp', string: '0', value: 0, archive: true };
export const r_fullbright = { name: 'r_fullbright', string: '0', value: 0 };
export const r_lightmap = { name: 'r_lightmap', string: '0', value: 0 };
export const r_shadows = { name: 'r_shadows', string: '0', value: 0 };
export const r_mirroralpha = { name: 'r_mirroralpha', string: '1', value: 1 };
export const r_wateralpha = { name: 'r_wateralpha', string: '1', value: 1 };
export const r_dynamic = { name: 'r_dynamic', string: '1', value: 1 };
export const r_novis = { name: 'r_novis', string: '0', value: 0 };

export const gl_clear = { name: 'gl_clear', string: '0', value: 0 };
export const gl_cull = { name: 'gl_cull', string: '1', value: 1 };
export const gl_texsort = { name: 'gl_texsort', string: '1', value: 1 };
export const gl_smoothmodels = { name: 'gl_smoothmodels', string: '1', value: 1 };
export const gl_affinemodels = { name: 'gl_affinemodels', string: '0', value: 0 };
export const gl_polyblend = { name: 'gl_polyblend', string: '1', value: 1 };
export const gl_keeptjunctions = { name: 'gl_keeptjunctions', string: '0', value: 0 };
export const gl_reporttjunctions = { name: 'gl_reporttjunctions', string: '0', value: 0 };
export const gl_flashblend = { name: 'gl_flashblend', string: '1', value: 1 };
export const gl_nocolors = { name: 'gl_nocolors', string: '0', value: 0 };
export const gl_doubleeyes = { name: 'gl_doubleeys', string: '1', value: 1 };
export const gl_max_size = { name: 'gl_max_size', string: '1024', value: 1024 };
export const gl_picmip = { name: 'gl_picmip', string: '0', value: 0 };
export const gl_playermip = { name: 'gl_playermip', string: '0', value: 0 };
export const gl_finish = { name: 'gl_finish', string: '0', value: 0 };
// gl_vidnt.c registers gl_ztrick in VID_Init. It alternates the depth range
// each frame to skip glClear(GL_DEPTH_BUFFER_BIT) on 1990s cards. Obsolete
// under WebGL/Three.js: the renderer clears depth itself. Kept registered for
// config compatibility.
export const gl_ztrick = { name: 'gl_ztrick', string: '1', value: 1 };
export const gl_subdivide_size = { name: 'gl_subdivide_size', string: '128', value: 128, archive: true };

// gl_draw.c gl_filter_min / gl_filter_max (extern in glquake.h). The
// gl_texturemode command (Draw_TextureMode_f in gl_draw.js) sets them.
export const GL_NEAREST = 0x2600;
export const GL_LINEAR = 0x2601;
export const GL_NEAREST_MIPMAP_NEAREST = 0x2700;
export const GL_LINEAR_MIPMAP_NEAREST = 0x2701;
export const GL_NEAREST_MIPMAP_LINEAR = 0x2702;
export const GL_LINEAR_MIPMAP_LINEAR = 0x2703;

export let gl_filter_min = GL_LINEAR_MIPMAP_NEAREST;
export let gl_filter_max = GL_LINEAR;

export function set_gl_filter( min, max ) {

	gl_filter_min = min;
	gl_filter_max = max;

}

// The GL filter enum as the matching Three.js filter constant.
export function GL_ThreeFilter( filter ) {

	switch ( filter ) {

		case GL_NEAREST: return THREE.NearestFilter;
		case GL_LINEAR: return THREE.LinearFilter;
		case GL_NEAREST_MIPMAP_NEAREST: return THREE.NearestMipmapNearestFilter;
		case GL_LINEAR_MIPMAP_NEAREST: return THREE.LinearMipmapNearestFilter;
		case GL_NEAREST_MIPMAP_LINEAR: return THREE.NearestMipmapLinearFilter;
		case GL_LINEAR_MIPMAP_LINEAR: return THREE.LinearMipmapLinearFilter;

	}

	return THREE.LinearFilter;

}

/*
gl_draw.c GL_Upload32: a mipmapped texture gets gl_filter_min / gl_filter_max,
any other texture gets gl_filter_max both ways.
*/
export function GL_SetTextureFilter( texture, mipmap ) {

	texture.minFilter = GL_ThreeFilter( mipmap ? gl_filter_min : gl_filter_max );
	texture.magFilter = GL_ThreeFilter( gl_filter_max );

}

// Track all game textures for filter updates
export const _allGameTextures = [];

export function GL_RegisterTexture( texture ) {

	if ( texture != null && _allGameTextures.includes( texture ) === false ) {

		_allGameTextures.push( texture );

	}

}

/*
================
GL_ScaledTextureSize

The size GL_Upload32 (gl_draw.c) uploads a texture at: shifted down by
gl_picmip, then clamped to gl_max_size. GLQuake first rounds up to a power of
two; WebGL2 takes any size, so the port skips that and only ever shrinks.
Never below 1 texel (C has no floor; a huge picmip would upload 0x0).
Returns the shared _scaledSize scratch object.
================
*/
const _scaledSize = { width: 0, height: 0 };

export function GL_ScaledTextureSize( width, height, mip = gl_picmip.value ) {

	// JS shifts wrap at 32; past 30 every size floors to 1 anyway.
	const shift = Math.min( 30, Math.max( 0, mip | 0 ) );
	let scaled_width = width >> shift;
	let scaled_height = height >> shift;

	if ( scaled_width > gl_max_size.value )
		scaled_width = gl_max_size.value | 0;
	if ( scaled_height > gl_max_size.value )
		scaled_height = gl_max_size.value | 0;

	_scaledSize.width = Math.max( 1, scaled_width );
	_scaledSize.height = Math.max( 1, scaled_height );
	return _scaledSize;

}

/*
================
GL_ResampleTexture8

GL_ResampleTexture (gl_draw.c) point-samples 32-bit texels; doing the same on
8-bit palette indices picks the same source texels, so the base and fullbright
textures split from the result keep matching sizes.
================
*/
export function GL_ResampleTexture8( data, inwidth, inheight, outwidth, outheight ) {

	const out = new Uint8Array( outwidth * outheight );
	const fracstep = ( inwidth * 0x10000 / outwidth ) | 0;

	for ( let i = 0; i < outheight; i ++ ) {

		const inrow = inwidth * ( ( i * inheight / outheight ) | 0 );
		let frac = fracstep >> 1;

		for ( let j = 0; j < outwidth; j ++ ) {

			out[ i * outwidth + j ] = data[ inrow + ( frac >> 16 ) ];
			frac += fracstep;

		}

	}

	return out;

}

/*
================
gl_cull

R_SetupGL (gl_rmain.c) enables GL_CULL_FACE only while gl_cull is set. Three.js
culls per material, so materials that are culled by default register here and
flip between FrontSide and DoubleSide when the cvar changes. Materials that are
intrinsically DoubleSide (sky, particles) never register.
================
*/
// Weak references: alias material caches live on model headers that can be
// dropped without disposing their materials, so the registry must not keep
// them alive.
const _cullMaterials = new Set();
const _cullMaterialRefs = new WeakMap();
let _cullValue = 1;
// Materials replaced without dispose() leave dead refs behind; sweep them
// whenever the set doubles, so it stays proportional to live materials.
let _cullPruneAt = 256;

function _pruneCullMaterials() {

	for ( const ref of _cullMaterials ) {

		if ( ref.deref() === undefined ) _cullMaterials.delete( ref );

	}

	_cullPruneAt = Math.max( 256, _cullMaterials.size * 2 );

}

function _onCullMaterialDispose( event ) {

	const ref = _cullMaterialRefs.get( event.target );
	if ( ref !== undefined ) _cullMaterials.delete( ref );
	_cullMaterialRefs.delete( event.target );
	event.target.removeEventListener( 'dispose', _onCullMaterialDispose );

}

export function GL_CullSide() {

	return gl_cull.value !== 0 ? THREE.FrontSide : THREE.DoubleSide;

}

export function GL_RegisterCullMaterial( material ) {

	if ( material == null || _cullMaterialRefs.has( material ) ) return material;
	material.side = GL_CullSide();
	const ref = new WeakRef( material );
	_cullMaterialRefs.set( material, ref );
	_cullMaterials.add( ref );
	material.addEventListener( 'dispose', _onCullMaterialDispose );
	if ( _cullMaterials.size >= _cullPruneAt ) _pruneCullMaterials();
	return material;

}

// Called once per frame from R_SetupGL; only walks the set when gl_cull changes.
export function GL_UpdateCull() {

	if ( gl_cull.value === _cullValue ) return;
	_cullValue = gl_cull.value;

	const side = GL_CullSide();
	for ( const ref of _cullMaterials ) {

		const material = ref.deref();
		if ( material === undefined ) {

			_cullMaterials.delete( ref );
			continue;

		}

		material.side = side;
		material.needsUpdate = true;

	}

}

export function GL_UnregisterTexture( texture ) {

	if ( texture == null ) return;
	const index = _allGameTextures.indexOf( texture );
	if ( index !== - 1 ) _allGameTextures.splice( index, 1 );

}

/*
The loop at the end of gl_draw.c Draw_TextureMode_f: "change all the existing
mipmap texture objects". As in C, textures without mipmaps keep the filter
they were loaded with.
*/
export function GL_UpdateTextureFiltering() {

	for ( const texture of _allGameTextures ) {

		if ( texture != null && texture.generateMipmaps === true ) {

			GL_SetTextureFilter( texture, true );
			texture.needsUpdate = true;

		}

	}

}

/*
===============================================================================

THREE.JS HELPER FUNCTIONS
(Replacing raw GL_Bind / GL_BeginRendering / etc.)

===============================================================================
*/

export function GL_Bind( texnum ) {

	currenttexture = texnum;

}

export function GL_DisableMultitexture() {

	// no-op in Three.js

}

export function GL_EnableMultitexture() {

	// no-op in Three.js

}

export function GL_BeginRendering( _x, _y, _width, _height ) {

	// In Three.js, rendering is handled by the renderer
	// These values are set by the video initialization

}

export function GL_EndRendering() {

	// no-op in Three.js

}

// v_blend for dynamic light blend effects
export const v_blend = new Float32Array( 4 );
