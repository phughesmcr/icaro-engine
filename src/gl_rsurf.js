// Ported from: WinQuake/gl_rsurf.c -- surface-related refresh code

import * as THREE from 'three';
import { GL_RegisterCullMaterial } from './glquake.js';
import { Sys_Error } from './sys.js';

/*
r_lightmap: GLQuake's R_BlendLightmaps draws the lightmaps without blending
them over the textures, so only the lighting shows. Every lightmapped material
shares this uniform; the fragment shader swaps the diffuse texture for white
and drops the fullbright emissive while it is 1.
*/
const _lightmapOnly = { value: 0 };

export function R_PatchLightmapShader( shader ) {

	shader.uniforms.quakeLightmapOnly = _lightmapOnly;
	shader.fragmentShader = shader.fragmentShader
		.replace( 'uniform vec3 emissive;', 'uniform vec3 emissive;\nuniform float quakeLightmapOnly;' )
		.replace( '#include <map_fragment>',
			'#include <map_fragment>\n\tdiffuseColor.rgb = mix( diffuseColor.rgb, vec3( 1.0 ), quakeLightmapOnly );' )
		.replace( '#include <emissivemap_fragment>',
			'#include <emissivemap_fragment>\n\ttotalEmissiveRadiance *= 1.0 - quakeLightmapOnly;' );

}

function R_LightmapProgramKey() {

	return 'quake-lightmap';

}

/*
SURF_UNDERWATER: GLQuake draws surfaces in water, slime or lava leaves with
DrawGLWaterPoly / DrawGLWaterPolyLightmap (gl_rsurf.c), which move each vertex
every frame:
	nv[0] = v[0] + 8*sin(v[1]*0.05+realtime)*sin(v[2]*0.05+realtime);
	nv[1] = v[1] + 8*sin(v[0]*0.05+realtime)*sin(v[2]*0.05+realtime);
	nv[2] = v[2];
The port's world is static BatchedMesh geometry, so the same sum runs in the
vertex shader on the unmoved Quake-space position. The texture and lightmap
share one pass here, so both move together as C's two passes do.
_waterWarpTime holds realtime wrapped to [0, 2*PI): sin(a + t) is unchanged,
and the small value keeps float32 precision after hours of play.
*/
const _waterWarpTime = { value: 0 };

/*
R_WarpTime: the clock for water turbulence and the sky scroll. id uses
realtime, so both keep moving while the game is paused. Deliberate deviation
(QuakeSpasm/Ironwail): use cl.time, which stops with the game. The underwater
vertex warp above stays on realtime as in id; QuakeSpasm and Ironwail don't
have it.
*/
function R_WarpTime() {

	return cl.time;

}

export function R_WaterWarpTime( time ) {

	const period = Math.PI * 2;
	const t = time % period;
	return t < 0 ? t + period : t;

}

export function R_PatchWaterWarpVertexShader( shader ) {

	shader.uniforms.quakeWarpTime = _waterWarpTime;
	shader.vertexShader = shader.vertexShader
		.replace( '#include <common>', '#include <common>\nuniform float quakeWarpTime;' )
		.replace( '#include <begin_vertex>', '#include <begin_vertex>\n' +
			'\tfloat quakeWarpZ = sin( position.z * 0.05 + quakeWarpTime );\n' +
			'\ttransformed.x += 8.0 * sin( position.y * 0.05 + quakeWarpTime ) * quakeWarpZ;\n' +
			'\ttransformed.y += 8.0 * sin( position.x * 0.05 + quakeWarpTime ) * quakeWarpZ;' );

}

/*
Turbulent (SURF_DRAWTURB) surfaces: gl_warp.c EmitWaterPolys, per vertex:
	s = os + turbsin[(int)((ot*0.125+realtime) * TURBSCALE) & 255];
	s *= (1.0/64);
	t = ot + turbsin[(int)((os*0.125+realtime) * TURBSCALE) & 255];
	t *= (1.0/64);
The port used to redo this on the CPU for every vertex each frame and upload
the UVs. It now runs in the vertex shader: the geometry keeps the unwarped
s/t in its uv attribute and _turbTime is the clock. turbsin[i] is
8 * sin( i * 2 * PI / 256 ), so trunc() of the same index and a sin() give
C's 256-step table, and & 255 is the sine's period. _turbTime is R_WarpTime
(cl.time, see above) wrapped to [0, 2*PI), the period of the index.
*/
const _turbTime = { value: 0 };

export function R_PatchTurbVertexShader( shader ) {

	shader.uniforms.quakeTurbTime = _turbTime;
	shader.vertexShader = shader.vertexShader
		.replace( '#include <common>', '#include <common>\nuniform float quakeTurbTime;' )
		.replace( '#include <uv_vertex>', '#include <uv_vertex>\n' +
			'#ifdef USE_MAP\n' +
			'\tvMapUv = ( uv + 8.0 * sin( trunc( ( uv.yx * 0.125 + quakeTurbTime ) * ( 128.0 / PI ) ) * ( PI / 128.0 ) ) ) * ( 1.0 / 64.0 );\n' +
			'#endif' );

}

function R_TurbProgramKey() {

	return 'quake-turb';

}

/*
Sky: gl_warp.c EmitSkyPolys, per vertex:
	VectorSubtract (v, r_origin, dir);
	dir[2] *= 3;	// flatten the sphere
	length = 6*63/Length (dir);
	s = (speedscale + dir[0]*length) * (1.0/128);
	t = (speedscale + dir[1]*length) * (1.0/128);
Also moved from a per-frame CPU loop into the vertex shader. _skyOrigin is
r_origin, set by R_DrawSkyChain; each layer has its own speedscale uniform.
position is the unmoved Quake-space vertex, as the CPU loop read it.
*/
const _skyOrigin = { value: new THREE.Vector3() };
const _solidSkySpeed = { value: 0 };
const _alphaSkySpeed = { value: 0 };

function R_PatchSkyVertexShader( shader, speedUniform ) {

	shader.uniforms.quakeSkyOrigin = _skyOrigin;
	shader.uniforms.quakeSkySpeed = speedUniform;
	shader.vertexShader = shader.vertexShader
		.replace( '#include <common>', '#include <common>\nuniform vec3 quakeSkyOrigin;\nuniform float quakeSkySpeed;' )
		.replace( '#include <uv_vertex>', '#include <uv_vertex>\n' +
			'#ifdef USE_MAP\n' +
			'\tvec3 quakeSkyDir = position - quakeSkyOrigin;\n' +
			'\tquakeSkyDir.z *= 3.0;\n' +
			'\tvMapUv = ( quakeSkySpeed + quakeSkyDir.xy * ( 6.0 * 63.0 / length( quakeSkyDir ) ) ) * ( 1.0 / 128.0 );\n' +
			'#endif' );

}

export function R_PatchSolidSkyVertexShader( shader ) {

	R_PatchSkyVertexShader( shader, _solidSkySpeed );

}

export function R_PatchAlphaSkyVertexShader( shader ) {

	R_PatchSkyVertexShader( shader, _alphaSkySpeed );

}

function R_SolidSkyProgramKey() {

	return 'quake-sky-solid';

}

function R_AlphaSkyProgramKey() {

	return 'quake-sky-alpha';

}

function R_PatchUnderwaterLightmapShader( shader ) {

	R_PatchLightmapShader( shader );
	R_PatchWaterWarpVertexShader( shader );

}

function R_UnderwaterLightmapProgramKey() {

	return 'quake-lightmap-underwater';

}

function R_UnderwaterProgramKey() {

	return 'quake-underwater';

}

function createQuakeLightmapMaterial( diffuseMap, lightmapTex, underwater = false ) {

	lightmapTex.channel = 1; // Use uv1 for lightmap coordinates

	// Use MeshLambertMaterial so surfaces respond to Three.js PointLights
	// for dynamic lighting effects (explosions, muzzle flashes, etc.)
	const matOptions = {
		map: diffuseMap,
		lightMap: lightmapTex,
		lightMapIntensity: LIGHTMAP_INTENSITY
	};

	// Fullbright pixel support: palette indices 224-255 should render at full
	// intensity regardless of lighting (glowing buttons, lava, etc.).
	// The base diffuse texture has these pixels set to BLACK so the lightmap
	// darkens them to nothing. The fullbright texture contains only those pixels
	// and is applied as an emissiveMap which bypasses all lighting.
	if ( diffuseMap._fullbright != null ) {

		matOptions.emissiveMap = diffuseMap._fullbright;
		matOptions.emissive = new THREE.Color( 1, 1, 1 );

	}

	const material = new THREE.MeshLambertMaterial( matOptions );
	material.onBeforeCompile = underwater ? R_PatchUnderwaterLightmapShader : R_PatchLightmapShader;
	material.customProgramCacheKey = underwater ? R_UnderwaterLightmapProgramKey : R_LightmapProgramKey;
	return GL_RegisterCullMaterial( material );

}
import { cl, cl_dlights, MAX_DLIGHTS, MAX_VISEDICTS, cl_visedicts, cl_numvisedicts, set_cl_numvisedicts } from './client.js';
import { R_StoreEfrags } from './gl_refrag.js';
import { R_MarkLights } from './gl_rlight.js';
import {
	r_refdef, r_origin
} from './render.js';
import {
	VERTEXSIZE, PLANE_X, PLANE_Y, PLANE_Z,
	SURF_PLANEBACK, SURF_DRAWSKY, SURF_DRAWTURB, SURF_UNDERWATER,
	MAXLIGHTMAPS,
	modelorg, currententity, r_worldentity,
	r_visframecount, r_framecount,
	mirror, mirrortexturenum, mirror_plane,
	d_lightstylevalue,
	r_fullbright,
	r_lightmap, r_dynamic, r_wateralpha, r_mirroralpha, r_novis,
	gl_texsort, gl_flashblend, gl_keeptjunctions,
	R_CullBox, scene,
	r_viewleaf, r_oldviewleaf,
	inc_r_visframecount, set_r_framecount, set_currententity,
	inc_c_brush_polys, set_currenttexture,
	set_r_oldviewleaf, set_mirror, set_mirror_plane
} from './gl_rmain.js';
import {
	DotProduct, VectorCopy, VectorAdd, VectorNormalize
} from './mathlib.js';
import { Mod_LeafPVS, solidskytexture, alphaskytexture, GL_CheckAnisotropy,
	SURF_DRAWLAVA, SURF_DRAWSLIME, SURF_DRAWTELE, SURF_DRAWWATER,
	r_lavaalpha, r_slimealpha, r_telealpha } from './gl_model.js';
import { COM_Parse, com_token } from './common.js';
import { realtime } from './host.js';
import { LIGHTMAP_INTENSITY } from './glquake.js';
import { MAX_MODELS } from './quakedef.js';
import { R_MirrorGate } from './gl_rmirror.js';
import { isXRActive } from './webxr.js';
import { renderer } from './vid.js';

//============================================================================
// Constants
//============================================================================

export const BLOCK_WIDTH = 128;
export const BLOCK_HEIGHT = 128;
// Deliberate deviation, from QuakeSpasm r_brush.c: GLQuake had a fixed 64
// blocks and Sys_Error'd "AllocBlock: full" past them, which maps with many
// large surfaces hit now that extents go to 2000 (gl_model.js). AllocBlock
// adds blocks on demand up to MAX_SANITY_LIGHTMAPS. MAX_LIGHTMAPS is only how
// many blocks are allocated at start-up, so id-sized maps allocate none.
export const MAX_LIGHTMAPS = 64;
const MAX_SANITY_LIGHTMAPS = 1 << 20;

const GL_LUMINANCE = 0x1909;

//============================================================================
// Module-level state
//============================================================================

export let skytexturenum = - 1; // index in cl.loadmodel, not gl texture object
export function set_skytexturenum( v ) { skytexturenum = v; }

let lightmap_bytes = 1; // 1, 2, or 4

// Deliberate deviation: GLQuake's 18*18 only fits 256-unit extents (WinQuake's
// limit), not GLQuake's own 512, and writes past it were dropped. Size it for
// one whole lightmap block as QuakeSpasm does: 2000-unit extents (gl_model.js
// MAX_SURFACE_EXTENTS) give at most 126x126 luxels.
const blocklights = new Uint32Array( BLOCK_WIDTH * BLOCK_HEIGHT );

// Cached buffers for R_AddDynamicLights (Golden Rule #4)
const _dlight_impact = new Float32Array( 3 );
const _dlight_local = new Float32Array( 2 );

// Cached buffers for BuildSurfaceDisplayList colinear elimination (Golden Rule #4)
const _colinear_v1 = new Float32Array( 3 );
const _colinear_v2 = new Float32Array( 3 );

// Flag to track if PVS changed and visibility needs update
let _visibilityNeedsUpdate = true;


// glRect_t equivalent
class glRect_t {

	constructor() {

		this.l = 0;
		this.t = 0;
		this.w = 0;
		this.h = 0;

	}

}

// Per-block state, indexed by lightmap block number. Each array holds at
// least lightmap_count blocks; GL_GrowLightmaps adds more (QuakeSpasm's
// realloc of lightmaps[] in AllocBlock).
const lightmap_polys = [];
const lightmap_modified = [];
const lightmap_rectchange = [];

// the lightmap texture data needs to be kept in main memory
// so texsubimage can update properly. One array per block, as QuakeSpasm's
// lightmaps[i].data, so adding a block never moves the others.
const lightmaps = [];

// Blocks in use by the current map (QuakeSpasm lightmap_count).
export let lightmap_count = 0;

// QuakeSpasm: AllocBlock only fills the newest block, so one column-height
// array is enough (allocated[column] = height used so far).
const allocated = new Int32Array( BLOCK_WIDTH );
let last_lightmap_allocated = 0;

/*
================
GL_GrowLightmaps

Makes sure the per-block arrays hold at least count blocks. Runs at start-up
for MAX_LIGHTMAPS blocks and again from AllocBlock at map load if a map
needs more, never per frame.
================
*/
function GL_GrowLightmaps( count ) {

	while ( lightmaps.length < count ) {

		lightmap_polys.push( null );
		lightmap_modified.push( false );
		lightmap_rectchange.push( new glRect_t() );
		lightmaps.push( new Uint8Array( 4 * BLOCK_WIDTH * BLOCK_HEIGHT ) );

	}

}

GL_GrowLightmaps( MAX_LIGHTMAPS );

// For gl_texsort 0
let skychain = null; // msurface_t
let waterchain = null; // msurface_t

// The turbsin table (gl_warp.c) is computed in R_PatchTurbVertexShader.

export let gl_lightmap_format = GL_LUMINANCE;
export const gl_solid_format = 3;
export const gl_alpha_format = 4;

export const gl_mtexable = false;

// external references
let r_pcurrentvertbase = null;
let currentmodel = null;
let nColinElim = 0;

// Three.js geometry cache for BSP surfaces
let worldGroup = null; // THREE.Group for world BSP

// PVS visibility using BatchedMesh for efficient rendering
// instanceVisInfo: Array<{batch: BatchedMesh, instanceId: number, leaves: leaf[]}>
// Each instance tracks all leaves that contain its surface - visible if ANY leaf is visible
const instanceVisInfo = [];

// Mirror surfaces of the world: surf -> { surf, geom, texture, batch, instanceId }.
// Rebuilt with the world meshes. mirrorItems is the visible subset on the
// mirror plane, filled by R_MirrorChain each frame.
const worldMirrors = new Map();
const mirrorItems = [];

// All BatchedMesh objects for the world (one per texture/lightmap combo)
const worldBatchedMeshes = [];

// Animated materials within the cached world batches.
const worldAnimatedMeshes = [];

// Pre-allocated scratch arrays to avoid per-frame allocations
const _cullBoxMaxs = new Float32Array( 3 ); // for R_CullBox in R_RecursiveWorldNode

// Water/sky mesh tracking: Set-based approach to add/remove from scene
// without creating/disposing meshes every frame
let _waterMeshesInScene = new Set();
const _waterMeshesThisFrame = new Set();

// Surfaces holding a cached water or sky geometry (EmitWaterPolysQuake,
// EmitSkyPolysQuake). The renderer keeps a geometry's GL buffers until
// dispose(), so GL_BuildLightmaps disposes them all, not just the meshes
// still in the scene at the map change.
const _turbSkySurfaces = new Set();

// Water/sky material caches: texture -> material (avoid per-frame material creation)
const _waterMaterialCache = new Map();

// Brush entity rendering support
// currentRenderGroup is the THREE.Group that surface renderers add meshes to.
// Defaults to worldGroup, but temporarily swapped to a brush entity group
// during R_DrawBrushModel (equivalent of glPushMatrix/glPopMatrix).
let currentRenderGroup = null;
const brushEntityGroups = []; // per-frame brush entity groups to dispose next frame

// Material cache for brush entities - keyed by "diffuseId_lightmapId"
// Materials are reused across frames to avoid shader recompilation
const _brushMaterialCache = new Map();

// Track all brush entity groups for disposal on map change
const _allBrushEntityGroups = new Set();

// Pre-allocated scratch arrays for R_DrawBrushModel (avoid per-call allocations)
const _brushMins = new Float32Array( 3 );
const _brushMaxs = new Float32Array( 3 );
const _brushTemp = new Float32Array( 3 );
const _brushForward = new Float32Array( 3 );
const _brushRight = new Float32Array( 3 );
const _brushUp = new Float32Array( 3 );
const _brushPlaneNormal = new Float32Array( 3 );

/*
================
Liquid alpha

Deliberate deviation, from QuakeSpasm (gl_rmisc.c, by ericw): lava, slime
and teleporters can have their own alpha (r_lavaalpha, r_slimealpha,
r_telealpha; 0 falls back to r_wateralpha), and a map's worldspawn can set
_wateralpha, _lavaalpha, _slimealpha and _telealpha. GLQuake applies
r_wateralpha to every liquid, which the defaults keep.

QS reparses the worldspawn in R_NewMap and its cvar callbacks override the
map's values when a cvar is set. This port's cvars have no callbacks and
R_NewMap is in gl_rmisc.js, so the values are parsed lazily after
GL_BuildLightmaps (which R_NewMap calls) and a cvar is applied once its value
changes.

QS also keeps a liquid opaque, whatever the cvars say, when the map's vis
can't see through it (contentstransparent, from Mod_CheckWaterVis). Here
that check only gates the worldspawn keys: the cvars act on every liquid as
r_wateralpha does in GLQuake, so the look of id's (unvised) maps with
r_wateralpha set is unchanged.
================
*/
let map_wateralpha = 1;
let map_lavaalpha = 0;
let map_slimealpha = 0;
let map_telealpha = 0;
let map_fallbackalpha = 1;
let _liquidAlphaWorld = null;	// the worldmodel the map_*alpha values are for
// the cvar values last applied, standing in for QS's cvar callbacks
let _seenWaterAlpha = 1;
let _seenLavaAlpha = 0;
let _seenSlimeAlpha = 0;
let _seenTeleAlpha = 0;

// R_ParseWorldspawn (QS gl_rmisc.c)
function R_ParseWorldspawn( worldmodel ) {

	map_fallbackalpha = r_wateralpha.value;
	map_wateralpha = r_wateralpha.value;
	map_lavaalpha = r_lavaalpha.value;
	map_slimealpha = r_slimealpha.value;
	map_telealpha = r_telealpha.value;

	if ( worldmodel === null || worldmodel.entities === null )
		return;
	const vised = worldmodel.contentstransparent;

	let data = COM_Parse( worldmodel.entities );
	if ( data === null || com_token !== '{' )
		return; // error

	while ( true ) {

		data = COM_Parse( data );
		if ( data === null )
			return; // error
		if ( com_token === '}' )
			break; // end of worldspawn
		const key = ( com_token.charAt( 0 ) === '_' ? com_token.substring( 1 ) : com_token ).replace( / +$/, '' );
		data = COM_Parse( data );
		if ( data === null )
			return; // error
		let value = parseFloat( com_token );
		if ( Number.isNaN( value ) ) value = 0;	// atof

		// only for liquids the vis can see through (see above)
		if ( key === 'wateralpha' && ( vised & SURF_DRAWWATER ) !== 0 )
			map_wateralpha = value;
		else if ( key === 'lavaalpha' && ( vised & SURF_DRAWLAVA ) !== 0 )
			map_lavaalpha = value;
		else if ( key === 'telealpha' && ( vised & SURF_DRAWTELE ) !== 0 )
			map_telealpha = value;
		else if ( key === 'slimealpha' && ( vised & SURF_DRAWSLIME ) !== 0 )
			map_slimealpha = value;

	}

}

function R_UpdateLiquidAlpha() {

	const worldmodel = cl != null ? cl.worldmodel : null;
	if ( worldmodel !== _liquidAlphaWorld ) {

		_liquidAlphaWorld = worldmodel;
		R_ParseWorldspawn( worldmodel );
		_seenWaterAlpha = r_wateralpha.value;
		_seenLavaAlpha = r_lavaalpha.value;
		_seenSlimeAlpha = r_slimealpha.value;
		_seenTeleAlpha = r_telealpha.value;

	}

	// R_SetWateralpha_f and its siblings
	if ( r_wateralpha.value !== _seenWaterAlpha ) {

		_seenWaterAlpha = r_wateralpha.value;
		map_wateralpha = _seenWaterAlpha;
		map_fallbackalpha = _seenWaterAlpha;

	}

	if ( r_lavaalpha.value !== _seenLavaAlpha ) {

		_seenLavaAlpha = r_lavaalpha.value;
		map_lavaalpha = _seenLavaAlpha;

	}

	if ( r_slimealpha.value !== _seenSlimeAlpha ) {

		_seenSlimeAlpha = r_slimealpha.value;
		map_slimealpha = _seenSlimeAlpha;

	}

	if ( r_telealpha.value !== _seenTeleAlpha ) {

		_seenTeleAlpha = r_telealpha.value;
		map_telealpha = _seenTeleAlpha;

	}

}

// GL_WaterAlphaForSurface (QS gl_rmisc.c GL_WaterAlphaForTextureType)
export function GL_WaterAlphaForSurface( fa ) {

	R_UpdateLiquidAlpha();
	if ( fa.flags & SURF_DRAWLAVA )
		return map_lavaalpha > 0 ? map_lavaalpha : map_fallbackalpha;
	else if ( fa.flags & SURF_DRAWTELE )
		return map_telealpha > 0 ? map_telealpha : map_fallbackalpha;
	else if ( fa.flags & SURF_DRAWSLIME )
		return map_slimealpha > 0 ? map_slimealpha : map_fallbackalpha;
	else
		return map_wateralpha;

}

// Whether any liquid is translucent (R_DrawWaterSurfaces' early out)
function R_AnyLiquidTranslucent() {

	R_UpdateLiquidAlpha();
	return map_wateralpha !== 1 ||
		( map_lavaalpha > 0 ? map_lavaalpha : map_fallbackalpha ) !== 1 ||
		( map_telealpha > 0 ? map_telealpha : map_fallbackalpha ) !== 1 ||
		( map_slimealpha > 0 ? map_slimealpha : map_fallbackalpha ) !== 1;

}

/*
================
_getWaterMaterial

Returns a cached material for water/turb surfaces. Keyed by texture object.
================
*/
function _getWaterMaterial( t, opacity ) {

	// Use texture + opacity bucket as key
	const opKey = opacity < 1.0 ? 0 : 1;
	const key = ( t && t.gl_texture ) ? t.gl_texture : null;
	const cacheKey = key ? key.id * 2 + opKey : opKey;

	let material = _waterMaterialCache.get( cacheKey );
	if ( ! material ) {

		material = new THREE.MeshBasicMaterial( {
			map: ( t && t.gl_texture ) ? t.gl_texture : null,
			color: ( t && t.gl_texture ) ? 0xffffff : 0x406080,
			// GLQuake R_DrawWaterSurfaces enables GL_BLEND only when
			// r_wateralpha < 1, so the opaque bucket draws without blending.
			transparent: opKey === 0,
			opacity: opacity,
			side: THREE.DoubleSide
		} );
		material.onBeforeCompile = R_PatchTurbVertexShader;
		material.customProgramCacheKey = R_TurbProgramKey;
		_waterMaterialCache.set( cacheKey, material );

	}
	if ( material.opacity !== opacity ) material.opacity = opacity;

	return material;

}

/*
================
_getWaterMesh

Returns a cached Mesh for a water/turb surface. Cached on the surface object.
================
*/
function _getWaterMesh( s, geometry, material, renderGroup ) {

	let mesh = s._waterMesh;
	if ( ! mesh ) {

		mesh = new THREE.Mesh( geometry, material );
		s._waterMesh = mesh;

	} else {

		if ( mesh.geometry !== geometry ) mesh.geometry = geometry;
		if ( mesh.material !== material ) mesh.material = material;

	}

	// Ensure mesh is in the correct parent group
	if ( mesh.parent !== renderGroup ) {

		if ( mesh.parent ) mesh.parent.remove( mesh );
		renderGroup.add( mesh );

	}

	_waterMeshesThisFrame.add( mesh );
	_waterMeshesInScene.add( mesh );

	return mesh;

}

//============================================================================
// R_TextureAnimation
//
// Returns the proper texture for a given time and base texture
//============================================================================

export function R_TextureAnimation( base, entityFrame = currententity != null ? currententity.frame : 0 ) {

	let count;

	if ( entityFrame != null && entityFrame !== 0 ) {

		if ( base.alternate_anims != null )
			base = base.alternate_anims;

	}

	if ( base.anim_total === 0 )
		return base;

	// cl.time needs to be connected
	const time = cl != null ? cl.time : 0;
	const reletive = ( ( time * 10 ) | 0 ) % base.anim_total;

	count = 0;
	while ( base.anim_min > reletive || base.anim_max <= reletive ) {

		base = base.anim_next;
		if ( base == null )
			Sys_Error( 'R_TextureAnimation: broken cycle' );
		if ( ++ count > 100 )
			Sys_Error( 'R_TextureAnimation: infinite cycle' );

	}

	return base;

}

export function R_UpdateAnimatedMaterial( material, baseTexture, entityFrame = 0 ) {

	const animatedTexture = R_TextureAnimation( baseTexture, entityFrame );
	const diffuse = animatedTexture != null && animatedTexture.gl_texture != null
		? animatedTexture.gl_texture
		: baseTexture.gl_texture;
	const hadMap = material.map != null;
	const hasMap = diffuse != null;
	const supportsEmissive = material.emissive != null;
	const fullbright = supportsEmissive && diffuse != null && diffuse._fullbright != null
		? diffuse._fullbright
		: null;
	const oldFullbright = supportsEmissive && material.emissiveMap != null
		? material.emissiveMap
		: null;

	if ( material.map === diffuse && oldFullbright === fullbright )
		return false;

	material.map = diffuse;
	if ( hadMap !== hasMap )
		material.needsUpdate = true;

	if ( supportsEmissive ) {

		const hadFullbright = oldFullbright != null;
		const hasFullbright = fullbright != null;
		material.emissiveMap = fullbright;
		if ( hasFullbright )
			material.emissive.setRGB( 1, 1, 1 );
		else
			material.emissive.setRGB( 0, 0, 0 );

		if ( hadFullbright !== hasFullbright )
			material.needsUpdate = true;

	}

	return true;

}

//============================================================================
// DrawGLPoly
//
// Draws a polygon. In Three.js, we build BufferGeometry from the glpoly_t
// vertex data and add it to the scene.
//============================================================================

export function DrawGLPoly( p, planeNormal ) {

	if ( ! p || p.numverts < 3 ) return;

	// Build triangle fan from polygon vertices
	// glpoly_t stores verts as flat array: [x,y,z,s,t,ls,lt] per vertex
	const numverts = p.numverts;
	const verts = p.verts;
	const numTriangles = numverts - 2;

	const positions = new Float32Array( numTriangles * 3 * 3 );
	const normals = new Float32Array( numTriangles * 3 * 3 );
	const uvs = new Float32Array( numTriangles * 3 * 2 );
	const lmUvs = new Float32Array( numTriangles * 3 * 2 );

	// Use plane normal for flat shading (BSP surfaces are planar)
	const nx = planeNormal ? planeNormal[ 0 ] : 0;
	const ny = planeNormal ? planeNormal[ 1 ] : 0;
	const nz = planeNormal ? planeNormal[ 2 ] : 1;

	for ( let i = 0; i < numTriangles; i ++ ) {

		// triangle fan: vertex 0, i+2, i+1 (reversed winding for Three.js CCW front faces)
		const i0 = 0;
		const i1 = i + 2;
		const i2 = i + 1;

		// position (x, y, z)
		positions[ i * 9 + 0 ] = verts[ i0 * VERTEXSIZE + 0 ];
		positions[ i * 9 + 1 ] = verts[ i0 * VERTEXSIZE + 1 ];
		positions[ i * 9 + 2 ] = verts[ i0 * VERTEXSIZE + 2 ];

		positions[ i * 9 + 3 ] = verts[ i1 * VERTEXSIZE + 0 ];
		positions[ i * 9 + 4 ] = verts[ i1 * VERTEXSIZE + 1 ];
		positions[ i * 9 + 5 ] = verts[ i1 * VERTEXSIZE + 2 ];

		positions[ i * 9 + 6 ] = verts[ i2 * VERTEXSIZE + 0 ];
		positions[ i * 9 + 7 ] = verts[ i2 * VERTEXSIZE + 1 ];
		positions[ i * 9 + 8 ] = verts[ i2 * VERTEXSIZE + 2 ];

		// normals (same for all vertices - flat shading)
		normals[ i * 9 + 0 ] = nx;
		normals[ i * 9 + 1 ] = ny;
		normals[ i * 9 + 2 ] = nz;

		normals[ i * 9 + 3 ] = nx;
		normals[ i * 9 + 4 ] = ny;
		normals[ i * 9 + 5 ] = nz;

		normals[ i * 9 + 6 ] = nx;
		normals[ i * 9 + 7 ] = ny;
		normals[ i * 9 + 8 ] = nz;

		// texture UVs (s, t) at offsets 3, 4
		uvs[ i * 6 + 0 ] = verts[ i0 * VERTEXSIZE + 3 ];
		uvs[ i * 6 + 1 ] = verts[ i0 * VERTEXSIZE + 4 ];

		uvs[ i * 6 + 2 ] = verts[ i1 * VERTEXSIZE + 3 ];
		uvs[ i * 6 + 3 ] = verts[ i1 * VERTEXSIZE + 4 ];

		uvs[ i * 6 + 4 ] = verts[ i2 * VERTEXSIZE + 3 ];
		uvs[ i * 6 + 5 ] = verts[ i2 * VERTEXSIZE + 4 ];

		// lightmap UVs (ls, lt) at offsets 5, 6
		lmUvs[ i * 6 + 0 ] = verts[ i0 * VERTEXSIZE + 5 ];
		lmUvs[ i * 6 + 1 ] = verts[ i0 * VERTEXSIZE + 6 ];

		lmUvs[ i * 6 + 2 ] = verts[ i1 * VERTEXSIZE + 5 ];
		lmUvs[ i * 6 + 3 ] = verts[ i1 * VERTEXSIZE + 6 ];

		lmUvs[ i * 6 + 4 ] = verts[ i2 * VERTEXSIZE + 5 ];
		lmUvs[ i * 6 + 5 ] = verts[ i2 * VERTEXSIZE + 6 ];

	}

	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute( 'position', new THREE.BufferAttribute( positions, 3 ) );
	geometry.setAttribute( 'normal', new THREE.BufferAttribute( normals, 3 ) );
	geometry.setAttribute( 'uv', new THREE.BufferAttribute( uvs, 2 ) );
	geometry.setAttribute( 'uv1', new THREE.BufferAttribute( lmUvs, 2 ) );

	return geometry;

}

//============================================================================
// _mergeGLPolys
//
// Merges multiple glpoly_t into a single BufferGeometry. Used to batch
// brush entity surfaces that share the same material into one draw call.
//============================================================================

function _mergeGLPolys( polys, planeNormals ) {

	// Count total triangles across all polys
	let totalTriangles = 0;
	for ( let p = 0; p < polys.length; p ++ ) {

		const poly = polys[ p ];
		if ( poly != null && poly.numverts >= 3 ) {

			totalTriangles += poly.numverts - 2;

		}

	}

	if ( totalTriangles === 0 ) return null;

	const positions = new Float32Array( totalTriangles * 9 );
	const normals = new Float32Array( totalTriangles * 9 );
	const uvs = new Float32Array( totalTriangles * 6 );
	const lmUvs = new Float32Array( totalTriangles * 6 );

	let triOffset = 0;

	for ( let p = 0; p < polys.length; p ++ ) {

		const poly = polys[ p ];
		if ( poly == null || poly.numverts < 3 ) continue;

		const planeNormal = planeNormals[ p ];
		const nx = planeNormal != null ? planeNormal[ 0 ] : 0;
		const ny = planeNormal != null ? planeNormal[ 1 ] : 0;
		const nz = planeNormal != null ? planeNormal[ 2 ] : 1;

		const numverts = poly.numverts;
		const verts = poly.verts;
		const numTriangles = numverts - 2;

		for ( let i = 0; i < numTriangles; i ++ ) {

			const i0 = 0;
			const i1 = i + 2;
			const i2 = i + 1;

			const posBase = ( triOffset + i ) * 9;
			const uvBase = ( triOffset + i ) * 6;

			positions[ posBase + 0 ] = verts[ i0 * VERTEXSIZE + 0 ];
			positions[ posBase + 1 ] = verts[ i0 * VERTEXSIZE + 1 ];
			positions[ posBase + 2 ] = verts[ i0 * VERTEXSIZE + 2 ];

			positions[ posBase + 3 ] = verts[ i1 * VERTEXSIZE + 0 ];
			positions[ posBase + 4 ] = verts[ i1 * VERTEXSIZE + 1 ];
			positions[ posBase + 5 ] = verts[ i1 * VERTEXSIZE + 2 ];

			positions[ posBase + 6 ] = verts[ i2 * VERTEXSIZE + 0 ];
			positions[ posBase + 7 ] = verts[ i2 * VERTEXSIZE + 1 ];
			positions[ posBase + 8 ] = verts[ i2 * VERTEXSIZE + 2 ];

			normals[ posBase + 0 ] = nx;
			normals[ posBase + 1 ] = ny;
			normals[ posBase + 2 ] = nz;

			normals[ posBase + 3 ] = nx;
			normals[ posBase + 4 ] = ny;
			normals[ posBase + 5 ] = nz;

			normals[ posBase + 6 ] = nx;
			normals[ posBase + 7 ] = ny;
			normals[ posBase + 8 ] = nz;

			uvs[ uvBase + 0 ] = verts[ i0 * VERTEXSIZE + 3 ];
			uvs[ uvBase + 1 ] = verts[ i0 * VERTEXSIZE + 4 ];

			uvs[ uvBase + 2 ] = verts[ i1 * VERTEXSIZE + 3 ];
			uvs[ uvBase + 3 ] = verts[ i1 * VERTEXSIZE + 4 ];

			uvs[ uvBase + 4 ] = verts[ i2 * VERTEXSIZE + 3 ];
			uvs[ uvBase + 5 ] = verts[ i2 * VERTEXSIZE + 4 ];

			lmUvs[ uvBase + 0 ] = verts[ i0 * VERTEXSIZE + 5 ];
			lmUvs[ uvBase + 1 ] = verts[ i0 * VERTEXSIZE + 6 ];

			lmUvs[ uvBase + 2 ] = verts[ i1 * VERTEXSIZE + 5 ];
			lmUvs[ uvBase + 3 ] = verts[ i1 * VERTEXSIZE + 6 ];

			lmUvs[ uvBase + 4 ] = verts[ i2 * VERTEXSIZE + 5 ];
			lmUvs[ uvBase + 5 ] = verts[ i2 * VERTEXSIZE + 6 ];

		}

		triOffset += numTriangles;

	}

	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute( 'position', new THREE.BufferAttribute( positions, 3 ) );
	geometry.setAttribute( 'normal', new THREE.BufferAttribute( normals, 3 ) );
	geometry.setAttribute( 'uv', new THREE.BufferAttribute( uvs, 2 ) );
	geometry.setAttribute( 'uv1', new THREE.BufferAttribute( lmUvs, 2 ) );

	return geometry;

}

//============================================================================
// DrawGLWaterPoly
//
// Warp the vertex coordinates. GLQuake recomputes the moved vertices on the
// CPU every frame. The port builds the world once, so this returns the same
// static geometry as DrawGLPoly, and R_BuildWorldMeshes gives it a material
// that does the warp in its vertex shader (R_PatchWaterWarpVertexShader). The lightmap UVs ride
// along, which covers DrawGLWaterPolyLightmap too.
//============================================================================

export function DrawGLWaterPoly( p, planeNormal ) {

	return DrawGLPoly( p, planeNormal );

}

//============================================================================
// EmitWaterPolysQuake
//
// Builds water geometry with warped UVs in Quake coordinate space.
// Unlike gl_warp.js version, keeps coordinates in Quake space to match
// the world geometry and camera setup.
//============================================================================

function EmitWaterPolysQuake( fa, time ) {

	// The turbulence runs in the vertex shader (R_PatchTurbVertexShader), so
	// the geometry is built once per surface and only the clock changes.
	_turbTime.value = R_WaterWarpTime( time );

	let cached = fa._waterGeoCache;

	if ( ! cached ) {

		// First time: build positions, UVs, indices and cache them
		const posArr = [];
		const uvArr = [];
		const idxArr = [];
		let vertexCount = 0;

		for ( let p = fa.polys; p; p = p.next ) {

			const startVert = vertexCount;
			const numverts = p.numverts;

			for ( let i = 0; i < numverts; i ++ ) {

				let vx, vy, vz, os, ot;

				if ( p.verts instanceof Float32Array ) {

					const vi = i * VERTEXSIZE;
					vx = p.verts[ vi + 0 ];
					vy = p.verts[ vi + 1 ];
					vz = p.verts[ vi + 2 ];
					os = p.verts[ vi + 3 ];
					ot = p.verts[ vi + 4 ];

				} else {

					const v = p.verts[ i ];
					vx = v[ 0 ];
					vy = v[ 1 ];
					vz = v[ 2 ];
					os = v[ 3 ];
					ot = v[ 4 ];

				}

				posArr.push( vx, vy, vz );
				uvArr.push( os, ot ); // unwarped s/t; the shader adds the turbulence
				vertexCount ++;

			}

			for ( let i = 2; i < numverts; i ++ ) {

				idxArr.push( startVert, startVert + i - 1, startVert + i );

			}

		}

		if ( posArr.length === 0 )
			return null;

		const positions = new Float32Array( posArr );
		const uvs = new Float32Array( uvArr );

		const geometry = new THREE.BufferGeometry();
		geometry.setAttribute( 'position', new THREE.BufferAttribute( positions, 3 ) );
		geometry.setAttribute( 'uv', new THREE.BufferAttribute( uvs, 2 ) );
		geometry.setIndex( idxArr );
		geometry.computeVertexNormals();

		cached = { geometry, vertexCount };
		fa._waterGeoCache = cached;
		_turbSkySurfaces.add( fa );

	}

	return cached.geometry;

}

/*
================
R_DisposeTurbSkyGeometry

Disposes every cached water and sky geometry and drops the caches, so a
surface that is drawn again rebuilds its geometry.
================
*/
function R_DisposeTurbSkyGeometry() {

	for ( const fa of _turbSkySurfaces ) {

		if ( fa._waterGeoCache ) fa._waterGeoCache.geometry.dispose();
		if ( fa._skyGeoCache ) fa._skyGeoCache.geometry.dispose();
		if ( fa._skyGeoCache2 ) fa._skyGeoCache2.geometry.dispose();
		fa._waterGeoCache = null;
		fa._skyGeoCache = null;
		fa._skyGeoCache2 = null;

	}

	_turbSkySurfaces.clear();

}

//============================================================================
// EmitSkyPolysQuake
//
// Builds sky geometry in Quake coordinate space.
// layer: 0 = solid layer, 1 = alpha layer
//============================================================================

function EmitSkyPolysQuake( fa, layer ) {

	// The UVs are computed in the vertex shader (R_PatchSkyVertexShader) from
	// r_origin and speedscale, so the geometry is static and built once.

	// We use two caches per surface: _skyGeoCache (solid layer) and _skyGeoCache2 (alpha layer)
	const cacheKey = layer === 1 ? '_skyGeoCache2' : '_skyGeoCache';
	let cached = fa[ cacheKey ];

	if ( ! cached ) {

		// First time: build positions and indices
		const posArr = [];
		const idxArr = [];
		let vertexCount = 0;

		for ( let p = fa.polys; p; p = p.next ) {

			const startVert = vertexCount;
			const numverts = p.numverts;

			for ( let i = 0; i < numverts; i ++ ) {

				let vx, vy, vz;

				if ( p.verts instanceof Float32Array ) {

					const vi = i * VERTEXSIZE;
					vx = p.verts[ vi + 0 ];
					vy = p.verts[ vi + 1 ];
					vz = p.verts[ vi + 2 ];

				} else {

					const v = p.verts[ i ];
					vx = v[ 0 ];
					vy = v[ 1 ];
					vz = v[ 2 ];

				}

				posArr.push( vx, vy, vz );
				vertexCount ++;

			}

			for ( let i = 2; i < numverts; i ++ ) {

				idxArr.push( startVert, startVert + i - 1, startVert + i );

			}

		}

		if ( posArr.length === 0 )
			return null;

		const positions = new Float32Array( posArr );
		const uvs = new Float32Array( vertexCount * 2 ); // unused: the shader sets vMapUv

		const geometry = new THREE.BufferGeometry();
		geometry.setAttribute( 'position', new THREE.BufferAttribute( positions, 3 ) );
		geometry.setAttribute( 'uv', new THREE.BufferAttribute( uvs, 2 ) );
		geometry.setIndex( idxArr );

		cached = { geometry, vertexCount };
		fa[ cacheKey ] = cached;
		_turbSkySurfaces.add( fa );

	}

	return cached.geometry;

}

//============================================================================
// R_DrawSequentialPoly
//
// Systems that have fast state and texture changes can just do everything
// as it passes with no need to sort
//============================================================================

export function R_DrawSequentialPoly( s ) {

	//
	// normal lightmaped poly
	//
	if ( ! ( s.flags & ( SURF_DRAWSKY | SURF_DRAWTURB | SURF_UNDERWATER ) ) ) {

		R_RenderDynamicLightmaps( s );
		return;

	}

	//
	// subdivided water surface warp
	//
	if ( s.flags & SURF_DRAWTURB ) {

		const renderGroup = currentRenderGroup || worldGroup;
		if ( s.polys && renderGroup ) {

			const geometry = EmitWaterPolysQuake( s, R_WarpTime() );
			if ( geometry ) {

				const t = R_TextureAnimation( s.texinfo.texture );
				const material = _getWaterMaterial( t, GL_WaterAlphaForSurface( s ) );
				_getWaterMesh( s, geometry, material, renderGroup );

			}

		}

		return;

	}

	//
	// subdivided sky warp
	//
	if ( s.flags & SURF_DRAWSKY ) {

		// Sky rendering -- skip for now (needs sky texture setup)
		return;

	}

	//
	// underwater warped with lightmap
	// (the warp itself is in the world material: see DrawGLWaterPoly)
	//
	R_RenderDynamicLightmaps( s );

}

//============================================================================
// R_RenderBrushPoly
//============================================================================

export function R_RenderBrushPoly( fa ) {

	let maps;

	inc_c_brush_polys();

	if ( fa.flags & SURF_DRAWSKY ) {

		// Sky surfaces are rendered via skychain in R_DrawSkyChain, not here
		return;

	}

	const t = R_TextureAnimation( fa.texinfo.texture );

	if ( fa.flags & SURF_DRAWTURB ) {

		const renderGroup = currentRenderGroup || worldGroup;
		if ( fa.polys && renderGroup ) {

			const geometry = EmitWaterPolysQuake( fa, R_WarpTime() );
			if ( geometry ) {

				const material = _getWaterMaterial( t, GL_WaterAlphaForSurface( fa ) );
				_getWaterMesh( fa, geometry, material, renderGroup );

			}

		}

		return;

	}

	// C draws the texture pass here: DrawGLWaterPoly for SURF_UNDERWATER,
	// else DrawGLPoly. The port's world geometry is built once in
	// R_BuildWorldMeshes, which makes that choice per surface.

	// add the poly to the proper lightmap chain
	if ( fa.polys ) {

		fa.polys.chain = lightmap_polys[ fa.lightmaptexturenum ];
		lightmap_polys[ fa.lightmaptexturenum ] = fa.polys;

	}

	// check for lightmap modification
	for ( maps = 0; maps < MAXLIGHTMAPS && fa.styles[ maps ] !== 255; maps ++ ) {

		if ( d_lightstylevalue[ fa.styles[ maps ] ] !== fa.cached_light[ maps ] ) {

			// dynamic -- need to rebuild lightmap
			if ( r_dynamic.value ) {

				lightmap_modified[ fa.lightmaptexturenum ] = true;
				const theRect = lightmap_rectchange[ fa.lightmaptexturenum ];
				if ( fa.light_t < theRect.t ) {

					if ( theRect.h )
						theRect.h += theRect.t - fa.light_t;
					theRect.t = fa.light_t;

				}

				if ( fa.light_s < theRect.l ) {

					if ( theRect.w )
						theRect.w += theRect.l - fa.light_s;
					theRect.l = fa.light_s;

				}

				const smax = ( fa.extents[ 0 ] >> 4 ) + 1;
				const tmax = ( fa.extents[ 1 ] >> 4 ) + 1;
				if ( ( theRect.w + theRect.l ) < ( fa.light_s + smax ) )
					theRect.w = ( fa.light_s - theRect.l ) + smax;
				if ( ( theRect.h + theRect.t ) < ( fa.light_t + tmax ) )
					theRect.h = ( fa.light_t - theRect.t ) + tmax;

				const offset = fa.light_t * BLOCK_WIDTH * lightmap_bytes + fa.light_s * lightmap_bytes;
				R_BuildLightMap( fa, lightmaps[ fa.lightmaptexturenum ], offset, BLOCK_WIDTH * lightmap_bytes );

			}

			break;

		}

	}

	// Also check if dynamic this frame or dynamic previously
	if ( fa.dlightframe === r_framecount || fa.cached_dlight ) {

		if ( r_dynamic.value ) {

			lightmap_modified[ fa.lightmaptexturenum ] = true;
			const theRect = lightmap_rectchange[ fa.lightmaptexturenum ];
			if ( fa.light_t < theRect.t ) {

				if ( theRect.h )
					theRect.h += theRect.t - fa.light_t;
				theRect.t = fa.light_t;

			}

			if ( fa.light_s < theRect.l ) {

				if ( theRect.w )
					theRect.w += theRect.l - fa.light_s;
				theRect.l = fa.light_s;

			}

			const smax = ( fa.extents[ 0 ] >> 4 ) + 1;
			const tmax = ( fa.extents[ 1 ] >> 4 ) + 1;
			if ( ( theRect.w + theRect.l ) < ( fa.light_s + smax ) )
				theRect.w = ( fa.light_s - theRect.l ) + smax;
			if ( ( theRect.h + theRect.t ) < ( fa.light_t + tmax ) )
				theRect.h = ( fa.light_t - theRect.t ) + tmax;

			const offset = fa.light_t * BLOCK_WIDTH * lightmap_bytes + fa.light_s * lightmap_bytes;
			R_BuildLightMap( fa, lightmaps[ fa.lightmaptexturenum ], offset, BLOCK_WIDTH * lightmap_bytes );

		}

	}

}

//============================================================================
// R_RenderDynamicLightmaps (multitexture path)
//============================================================================

export function R_RenderDynamicLightmaps( fa ) {

	let maps;

	inc_c_brush_polys();

	if ( fa.flags & ( SURF_DRAWSKY | SURF_DRAWTURB ) )
		return;

	if ( fa.polys ) {

		fa.polys.chain = lightmap_polys[ fa.lightmaptexturenum ];
		lightmap_polys[ fa.lightmaptexturenum ] = fa.polys;

	}

	// check for lightmap modification
	for ( maps = 0; maps < MAXLIGHTMAPS && fa.styles[ maps ] !== 255; maps ++ ) {

		if ( d_lightstylevalue[ fa.styles[ maps ] ] !== fa.cached_light[ maps ] ) {

			if ( r_dynamic.value ) {

				lightmap_modified[ fa.lightmaptexturenum ] = true;
				const theRect = lightmap_rectchange[ fa.lightmaptexturenum ];
				if ( fa.light_t < theRect.t ) {

					if ( theRect.h )
						theRect.h += theRect.t - fa.light_t;
					theRect.t = fa.light_t;

				}

				if ( fa.light_s < theRect.l ) {

					if ( theRect.w )
						theRect.w += theRect.l - fa.light_s;
					theRect.l = fa.light_s;

				}

				const smax = ( fa.extents[ 0 ] >> 4 ) + 1;
				const tmax = ( fa.extents[ 1 ] >> 4 ) + 1;
				if ( ( theRect.w + theRect.l ) < ( fa.light_s + smax ) )
					theRect.w = ( fa.light_s - theRect.l ) + smax;
				if ( ( theRect.h + theRect.t ) < ( fa.light_t + tmax ) )
					theRect.h = ( fa.light_t - theRect.t ) + tmax;

				const offset = fa.light_t * BLOCK_WIDTH * lightmap_bytes + fa.light_s * lightmap_bytes;
				R_BuildLightMap( fa, lightmaps[ fa.lightmaptexturenum ], offset, BLOCK_WIDTH * lightmap_bytes );

			}

			break;

		}

	}

	if ( fa.dlightframe === r_framecount || fa.cached_dlight ) {

		if ( r_dynamic.value ) {

			lightmap_modified[ fa.lightmaptexturenum ] = true;
			const theRect = lightmap_rectchange[ fa.lightmaptexturenum ];
			if ( fa.light_t < theRect.t ) {

				if ( theRect.h )
					theRect.h += theRect.t - fa.light_t;
				theRect.t = fa.light_t;

			}

			if ( fa.light_s < theRect.l ) {

				if ( theRect.w )
					theRect.w += theRect.l - fa.light_s;
				theRect.l = fa.light_s;

			}

			const smax = ( fa.extents[ 0 ] >> 4 ) + 1;
			const tmax = ( fa.extents[ 1 ] >> 4 ) + 1;
			if ( ( theRect.w + theRect.l ) < ( fa.light_s + smax ) )
				theRect.w = ( fa.light_s - theRect.l ) + smax;
			if ( ( theRect.h + theRect.t ) < ( fa.light_t + tmax ) )
				theRect.h = ( fa.light_t - theRect.t ) + tmax;

			const offset = fa.light_t * BLOCK_WIDTH * lightmap_bytes + fa.light_s * lightmap_bytes;
			R_BuildLightMap( fa, lightmaps[ fa.lightmaptexturenum ], offset, BLOCK_WIDTH * lightmap_bytes );

		}

	}

}

//============================================================================
// R_AddDynamicLights
//============================================================================

export function R_AddDynamicLights( surf ) {

	if ( ! cl_dlights ) return;

	const smax = ( surf.extents[ 0 ] >> 4 ) + 1;
	const tmax = ( surf.extents[ 1 ] >> 4 ) + 1;
	const tex = surf.texinfo;

	for ( let lnum = 0; lnum < MAX_DLIGHTS; lnum ++ ) {

		if ( ! ( surf.dlightbits[ lnum >> 5 ] & ( 1 << ( lnum & 31 ) ) ) )
			continue; // not lit by this light

		const dl = cl_dlights[ lnum ];
		let rad = dl.radius;
		let dist = DotProduct( dl.origin, surf.plane.normal ) - surf.plane.dist;
		rad -= Math.abs( dist );
		let minlight = dl.minlight;
		if ( rad < minlight )
			continue;
		minlight = rad - minlight;

		// Use cached buffers to avoid per-call allocations (Golden Rule #4)
		const impact = _dlight_impact;
		for ( let i = 0; i < 3; i ++ ) {

			impact[ i ] = dl.origin[ i ] - surf.plane.normal[ i ] * dist;

		}

		const local = _dlight_local;
		local[ 0 ] = DotProduct( impact, tex.vecs[ 0 ] ) + tex.vecs[ 0 ][ 3 ];
		local[ 1 ] = DotProduct( impact, tex.vecs[ 1 ] ) + tex.vecs[ 1 ][ 3 ];

		local[ 0 ] -= surf.texturemins[ 0 ];
		local[ 1 ] -= surf.texturemins[ 1 ];

		for ( let t = 0; t < tmax; t ++ ) {

			let td = local[ 1 ] - t * 16;
			if ( td < 0 ) td = - td;

			for ( let s = 0; s < smax; s ++ ) {

				let sd = local[ 0 ] - s * 16;
				if ( sd < 0 ) sd = - sd;

				if ( sd > td )
					dist = sd + ( td >> 1 );
				else
					dist = td + ( sd >> 1 );

				if ( dist < minlight )
					blocklights[ t * smax + s ] += ( ( rad - dist ) * 256 ) | 0;

			}

		}

	}

}

//============================================================================
// R_BuildLightMap
//
// Combine and scale multiple lightmaps into the 8.8 format in blocklights
//============================================================================

export function R_BuildLightMap( surf, dest, destOffset, stride ) {

	const smax = ( surf.extents[ 0 ] >> 4 ) + 1;
	const tmax = ( surf.extents[ 1 ] >> 4 ) + 1;
	const size = smax * tmax;
	const lightmap = surf.samples;
	let lightmapOffset = surf.sampleOffset || 0;

	surf.cached_dlight = ( surf.dlightframe === r_framecount );

	// set to full bright if no light data
	// C code: r_fullbright.value || !cl.worldmodel->lightdata
	// This checks the WORLD's lightdata, not the individual surface's samples.
	// Surfaces with no samples but in a lit world should be dark, not fullbright.
	if ( r_fullbright.value || ( cl.worldmodel != null && cl.worldmodel.lightdata == null ) ) {

		for ( let i = 0; i < size; i ++ )
			blocklights[ i ] = 255 * 256;

	} else {

		// clear to no light
		for ( let i = 0; i < size; i ++ )
			blocklights[ i ] = 0;

		// add all the lightmaps
		if ( lightmap != null ) {

			for ( let maps = 0; maps < MAXLIGHTMAPS && surf.styles[ maps ] !== 255; maps ++ ) {

				const scale = d_lightstylevalue[ surf.styles[ maps ] ];
				surf.cached_light[ maps ] = scale; // 8.8 fraction
				for ( let i = 0; i < size; i ++ )
					blocklights[ i ] += lightmap[ lightmapOffset + i ] * scale;
				lightmapOffset += size; // skip to next lightmap

			}

		}

		// add all the dynamic lights
		if ( surf.dlightframe === r_framecount )
			R_AddDynamicLights( surf );

	}

	// bound, invert, and shift
	// store as luminance (single byte per texel)
	stride -= smax;
	let bl = 0; // index into blocklights
	let di = destOffset;

	for ( let i = 0; i < tmax; i ++, di += stride ) {

		for ( let j = 0; j < smax; j ++ ) {

			let t = blocklights[ bl ++ ];
			t >>= 7;
			if ( t > 255 ) t = 255;
			dest[ di ] = 255 - t;
			di ++;

		}

	}

}

//============================================================================
// R_DrawBrushModel
//============================================================================

// Euler object reused for brush entity rotation (avoid per-frame allocation)
const _brushEuler = new THREE.Euler( 0, 0, 0, 'ZYX' );

export function R_DrawBrushModel( e ) {

	// Use pre-allocated scratch arrays to avoid per-call allocations
	const mins = _brushMins;
	const maxs = _brushMaxs;
	let rotated;

	const clmodel = e.model;
	if ( ! clmodel ) return;

	if ( e.angles[ 0 ] || e.angles[ 1 ] || e.angles[ 2 ] ) {

		rotated = true;
		for ( let i = 0; i < 3; i ++ ) {

			mins[ i ] = e.origin[ i ] - clmodel.radius;
			maxs[ i ] = e.origin[ i ] + clmodel.radius;

		}

	} else {

		rotated = false;
		VectorAdd( e.origin, clmodel.mins, mins );
		VectorAdd( e.origin, clmodel.maxs, maxs );

	}

	if ( R_CullBox( mins, maxs ) )
		return;

	// Calculate dynamic lighting for non-instanced brush models.
	if ( clmodel.firstmodelsurface !== 0 && gl_flashblend.value === 0 ) {

		const root = clmodel.nodes[ clmodel.hulls[ 0 ].firstclipnode ];
		for ( let k = 0; k < MAX_DLIGHTS; k ++ ) {

			const light = cl_dlights[ k ];
			if ( light.die < cl.time || light.radius === 0 )
				continue;

			R_MarkLights( light, k, root, clmodel.surfaces );

		}

	}

	// Update dynamic lightmaps for brush entity surfaces (flickering lights, etc.)
	// This must happen every frame, even when using cached geometry, because
	// the lightmap textures are shared with world surfaces and need updating.
	if ( clmodel.surfaces && clmodel.nummodelsurfaces ) {

		const startSurf = clmodel.firstmodelsurface;
		for ( let i = 0; i < clmodel.nummodelsurfaces; i ++ ) {

			const psurf = clmodel.surfaces[ startSurf + i ];
			if ( psurf ) R_RenderDynamicLightmaps( psurf );

		}

	}

	// Check if we have a cached brush group for this entity
	// Invalidate cache if entity.frame changed (for texture animation, e.g. buttons)
	let brushGroup = e._brushGroup;
	if ( brushGroup && e._brushGroupFrame !== e.frame ) {

		// Frame changed - dispose old group and rebuild
		_allBrushEntityGroups.delete( brushGroup );
		brushGroup._quakeOwner = null;
		if ( brushGroup.parent ) brushGroup.parent.remove( brushGroup );
		for ( const child of brushGroup.children ) {

			if ( child.geometry ) child.geometry.dispose();
			// Don't dispose materials - they're cached in _brushMaterialCache

		}
		brushGroup = null;
		e._brushGroup = null;
		e._brushAnimSurfaces = null;

	}

	if ( brushGroup == null ) {

		// First time drawing this entity - build and cache the group.
		// Surfaces sharing the same base texture + lightmap are merged into
		// a single BufferGeometry so a 6-face box becomes 1 draw call.
		brushGroup = new THREE.Group();
		let animSurfaces = null;

		if ( clmodel.surfaces && clmodel.nummodelsurfaces ) {

			// First pass: collect surfaces grouped by (baseTex, lightmap)
			const surfaceGroups = [];
			const startSurf = clmodel.firstmodelsurface;

			for ( let i = 0; i < clmodel.nummodelsurfaces; i ++ ) {

				const psurf = clmodel.surfaces[ startSurf + i ];
				if ( psurf == null ) continue;
				if ( psurf.flags & ( SURF_DRAWSKY | SURF_DRAWTURB ) ) continue;
				if ( psurf.polys == null ) continue;

				// Get plane normal, flip if SURF_PLANEBACK
				let planeNormal = null;
				if ( psurf.plane != null ) {

					const pn = psurf.plane.normal;
					if ( psurf.flags & SURF_PLANEBACK ) {

						planeNormal = new Float32Array( [ - pn[ 0 ], - pn[ 1 ], - pn[ 2 ] ] );

					} else {

						planeNormal = pn;

					}

				}

				const baseTex = psurf.texinfo.texture;
				const lmTex = lightmapTextures[ psurf.lightmaptexturenum ];

				// Find existing group with same baseTex and lightmap (object reference match)
				let group = null;
				for ( let g = 0; g < surfaceGroups.length; g ++ ) {

					if ( surfaceGroups[ g ].baseTex === baseTex && surfaceGroups[ g ].lmTex === lmTex ) {

						group = surfaceGroups[ g ];
						break;

					}

				}

				if ( group === null ) {

					group = { polys: [], normals: [], baseTex, lmTex };
					surfaceGroups.push( group );

				}

				group.polys.push( psurf.polys );
				group.normals.push( planeNormal );

			}

			// Second pass: create one merged mesh per group
			let childIdx = 0;
			for ( let g = 0; g < surfaceGroups.length; g ++ ) {

				const group = surfaceGroups[ g ];
				const geom = _mergeGLPolys( group.polys, group.normals );
				if ( geom == null ) continue;

				const t = R_TextureAnimation( group.baseTex );
				const diffuse = ( t != null && t.gl_texture != null ) ? t.gl_texture : null;
				const lmTex = group.lmTex;

				// Use cached material to avoid shader recompilation
				const diffuseId = diffuse != null ? diffuse.id : 0;
				const lmId = lmTex != null ? lmTex.id : 0;
				const matKey = `${diffuseId}_${lmId}`;
				let material = _brushMaterialCache.get( matKey );
				if ( material == null ) {

					material = ( diffuse != null && lmTex != null )
						? createQuakeLightmapMaterial( diffuse, lmTex )
						: GL_RegisterCullMaterial( new THREE.MeshBasicMaterial( { map: diffuse } ) );
					_brushMaterialCache.set( matKey, material );

				}

				const mesh = new THREE.Mesh( geom, material );
				brushGroup.add( mesh );

				// Track surfaces with time-based animation for per-frame material updates
				if ( group.baseTex != null && ( group.baseTex.anim_total > 0 || group.baseTex.alternate_anims != null ) ) {

					if ( animSurfaces == null ) animSurfaces = [];
					animSurfaces.push( { childIdx, baseTex: group.baseTex, lmTex } );

				}

				childIdx ++;

			}

		}

		// Cache on entity and track for disposal on map change
		e._brushGroup = brushGroup;
		e._brushGroupFrame = e.frame;
		e._brushAnimSurfaces = animSurfaces;
		brushGroup._quakeOwner = e;
		_allBrushEntityGroups.add( brushGroup );

	}

	// Update materials for surfaces with time-based texture animation
	// Geometry stays cached — only materials are swapped each frame
	if ( e._brushAnimSurfaces != null ) {

		const children = brushGroup.children;
		for ( let a = 0; a < e._brushAnimSurfaces.length; a ++ ) {

			const anim = e._brushAnimSurfaces[ a ];
			const t = R_TextureAnimation( anim.baseTex );
			const diffuse = ( t && t.gl_texture ) ? t.gl_texture : null;
			const child = children[ anim.childIdx ];
			if ( child == null ) continue;

			// Check if texture actually changed
			const currentMap = child.material.map;
			if ( currentMap === diffuse ) continue;

			// Swap to the correct material (reuse from cache)
			const diffuseId = diffuse ? diffuse.id : 0;
			const lmId = anim.lmTex ? anim.lmTex.id : 0;
			const matKey = `${diffuseId}_${lmId}`;
			let material = _brushMaterialCache.get( matKey );
			if ( ! material ) {

				material = ( diffuse && anim.lmTex )
					? createQuakeLightmapMaterial( diffuse, anim.lmTex )
					: GL_RegisterCullMaterial( new THREE.MeshBasicMaterial( { map: diffuse } ) );
				_brushMaterialCache.set( matKey, material );

			}

			child.material = material;

		}

	}

	// Update transform (position/rotation may change each frame for doors, etc.)
	brushGroup.position.set( e.origin[ 0 ], e.origin[ 1 ], e.origin[ 2 ] );

	if ( rotated ) {

		// "stupid quake bug" — negate pitch before R_RotateForEntity
		const pitch = - e.angles[ 0 ];
		const yaw = e.angles[ 1 ];
		const roll = e.angles[ 2 ];

		_brushEuler.set(
			roll * ( Math.PI / 180 ),
			- pitch * ( Math.PI / 180 ),
			yaw * ( Math.PI / 180 )
		);
		brushGroup.quaternion.setFromEuler( _brushEuler );

	} else {

		brushGroup.quaternion.identity();

	}

	// Add to scene (will be removed next frame by R_DrawWorld cleanup)
	if ( scene && ! brushGroup.parent ) scene.add( brushGroup );
	brushEntityGroups.push( brushGroup );

	// Upload any modified lightmaps (matches original C: R_BlendLightmaps called
	// at end of R_DrawBrushModel to ensure brush entity lightmap changes are applied)
	R_BlendLightmaps();

}

//============================================================================
// R_RecursiveWorldNode
//============================================================================

export function R_RecursiveWorldNode( node ) {

	if ( ! node ) return;

	if ( node.contents === - 2 ) // CONTENTS_SOLID
		return;

	if ( node.visframe !== r_visframecount )
		return;

	// Use pre-allocated scratch array for maxs to avoid per-call allocation
	_cullBoxMaxs[ 0 ] = node.minmaxs[ 3 ];
	_cullBoxMaxs[ 1 ] = node.minmaxs[ 4 ];
	_cullBoxMaxs[ 2 ] = node.minmaxs[ 5 ];
	if ( R_CullBox( node.minmaxs, _cullBoxMaxs ) )
		return;

	// if a leaf node, draw stuff
	if ( node.contents < 0 ) {

		const pleaf = node; // mleaf_t is a subtype of mnode_t

		if ( pleaf.firstmarksurface && pleaf.nummarksurfaces ) {

			for ( let c = 0; c < pleaf.nummarksurfaces; c ++ ) {

				pleaf.firstmarksurface[ c ].visframe = r_framecount;

			}

		}

		// deal with model fragments in this leaf
		if ( pleaf.efrags ) {

			set_cl_numvisedicts( R_StoreEfrags( pleaf.efrags, cl_visedicts, cl_numvisedicts, MAX_VISEDICTS, r_framecount ) );

		}

		return;

	}

	// node is just a decision point, so go down the appropriate sides

	// find which side of the node we are on
	const plane = node.plane;
	let dot;

	switch ( plane.type ) {

		case PLANE_X:
			dot = modelorg[ 0 ] - plane.dist;
			break;
		case PLANE_Y:
			dot = modelorg[ 1 ] - plane.dist;
			break;
		case PLANE_Z:
			dot = modelorg[ 2 ] - plane.dist;
			break;
		default:
			dot = DotProduct( modelorg, plane.normal ) - plane.dist;
			break;

	}

	const side = dot >= 0 ? 0 : 1;

	// recurse down the children, front side first
	R_RecursiveWorldNode( node.children[ side ] );

	// draw stuff
	const c = node.numsurfaces;

	if ( c ) {

		const cl_ref = cl;
		const worldmodel = cl_ref ? cl_ref.worldmodel : null;

		if ( worldmodel && worldmodel.surfaces ) {

			// Only render surfaces within the world model's surface range.
			// Submodel surfaces (triggers, doors, etc.) share the global
			// surfaces array but must not be drawn during world traversal.
			const worldSurfEnd = worldmodel.firstmodelsurface + worldmodel.nummodelsurfaces;

			for ( let ci = 0; ci < c; ci ++ ) {

				const surfIdx = node.firstsurface + ci;
				if ( surfIdx < worldmodel.firstmodelsurface || surfIdx >= worldSurfEnd )
					continue;

				const surf = worldmodel.surfaces[ surfIdx ];
				if ( ! surf ) continue;

				if ( surf.visframe !== r_framecount )
					continue;

				// don't backface underwater surfaces, because they warp
				if ( ! ( surf.flags & SURF_UNDERWATER ) &&
					( ( dot < 0 ) ^ ! ! ( surf.flags & SURF_PLANEBACK ) ) )
					continue; // wrong side

				// if sorting by texture, just store it out
				if ( gl_texsort.value ) {

					if ( ! mirror ||
						surf.texinfo.texture !== worldmodel.textures[ mirrortexturenum ] ) {

						surf.texturechain = surf.texinfo.texture.texturechain;
						surf.texinfo.texture.texturechain = surf;

					}

				} else if ( surf.flags & SURF_DRAWSKY ) {

					surf.texturechain = skychain;
					skychain = surf;

				} else if ( surf.flags & SURF_DRAWTURB ) {

					surf.texturechain = waterchain;
					waterchain = surf;

				} else {

					R_DrawSequentialPoly( surf );

				}

			}

		}

	}

	// recurse down the back side
	R_RecursiveWorldNode( node.children[ side ? 0 : 1 ] );

}

//============================================================================
// R_DrawWorld
//============================================================================

export function R_DrawWorld() {

	const cl_ref = cl;
	if ( ! cl_ref || ! cl_ref.worldmodel ) return;
	r_worldentity.model = cl_ref.worldmodel;
	r_worldentity.frame = 0;
	set_currententity( r_worldentity );

	VectorCopy( r_refdef.vieworg, modelorg );
	GL_CheckAnisotropy();
	R_UpdateWorldTextureAnimations();
	_waterWarpTime.value = R_WaterWarpTime( realtime );

	set_currenttexture( - 1 );

	// clear lightmap polys
	for ( let i = 0; i < lightmap_count; i ++ )
		lightmap_polys[ i ] = null;

	// create world group if needed
	if ( ! worldGroup ) {

		worldGroup = new THREE.Group();
		worldGroup.name = 'quake_world';
		if ( scene ) scene.add( worldGroup );

	}

	// Begin new water/sky frame: clear "this frame" set
	_waterMeshesThisFrame.clear();

	// Remove brush entity groups from scene (don't dispose - they're cached on entities)
	for ( let i = 0; i < brushEntityGroups.length; i ++ ) {

		const group = brushEntityGroups[ i ];
		if ( group.parent ) group.parent.remove( group );

	}

	brushEntityGroups.length = 0;

	// Set currentRenderGroup to worldGroup for world surface rendering
	currentRenderGroup = worldGroup;

	R_RecursiveWorldNode( cl_ref.worldmodel.nodes[ 0 ] );

	// Update mesh visibility based on PVS (leaf visframe set by R_MarkLeaves)
	R_UpdateWorldVisibility();

	DrawTextureChains();

	R_BlendLightmaps();

}

/*
================
R_CleanupWaterMeshes

Remove water/sky meshes that were in the scene last frame but not rendered
this frame. Called from R_RenderView after all water rendering is done.
================
*/
export function R_CleanupWaterMeshes() {

	for ( const mesh of _waterMeshesInScene ) {

		if ( ! _waterMeshesThisFrame.has( mesh ) ) {

			if ( mesh.parent ) mesh.parent.remove( mesh );
			_waterMeshesInScene.delete( mesh );

		}

	}

}

//============================================================================
// DrawTextureChains
//============================================================================

export function DrawTextureChains() {

	const cl_ref = cl;
	if ( ! cl_ref || ! cl_ref.worldmodel ) return;

	if ( ! gl_texsort.value ) {

		if ( skychain ) {

			R_DrawSkyChain( skychain );
			skychain = null;

		}

		return;

	}

	const worldmodel = cl_ref.worldmodel;
	for ( let i = 0; i < worldmodel.numtextures; i ++ ) {

		const t = worldmodel.textures[ i ];
		if ( ! t ) continue;

		let s = t.texturechain;
		if ( ! s ) continue;

		if ( i === skytexturenum ) {

			R_DrawSkyChain( s );

		} else if ( i === mirrortexturenum && R_MirrorGate( r_mirroralpha.value, isXRActive() ) ) {

			R_MirrorChain( s );

		} else {

			if ( ( s.flags & SURF_DRAWTURB ) && GL_WaterAlphaForSurface( s ) !== 1.0 )
				continue; // draw translucent water later

			for ( ; s; s = s.texturechain )
				R_RenderBrushPoly( s );

		}

		t.texturechain = null;

	}

}

//============================================================================
// R_BlendLightmaps
//============================================================================

/*
R_CheckLightmapCvars

GLQuake reads r_fullbright in R_BuildLightMap (fill with full light) and
r_lightmap in R_BlendLightmaps. Here the lightmaps are textures on the
materials, so a change of r_fullbright rebuilds every lightmap block and
r_lightmap flips the shared shader uniform.
*/
let _oldFullbright = 0;

function R_CheckLightmapCvars() {

	_lightmapOnly.value = r_lightmap.value ? 1 : 0;

	const fullbright = r_fullbright.value ? 1 : 0;
	if ( fullbright === _oldFullbright )
		return;
	_oldFullbright = fullbright;

	// Same models as GL_BuildLightmaps; inline submodels ('*n') share the
	// world's surface array.
	for ( let j = 1; j < MAX_MODELS; j ++ ) {

		const m = cl.model_precache[ j ];
		if ( m == null )
			break;
		if ( m.surfaces == null || ( m.name && m.name.charAt( 0 ) === '*' ) )
			continue;

		for ( let i = 0; i < m.numsurfaces; i ++ ) {

			const surf = m.surfaces[ i ];
			if ( surf.flags & ( SURF_DRAWSKY | SURF_DRAWTURB ) )
				continue;

			const offset = ( surf.light_t * BLOCK_WIDTH + surf.light_s ) * lightmap_bytes;
			R_BuildLightMap( surf, lightmaps[ surf.lightmaptexturenum ], offset, BLOCK_WIDTH * lightmap_bytes );
			lightmap_modified[ surf.lightmaptexturenum ] = true;

			// R_BlendLightmaps uploads only lightmap_rectchange, so mark the
			// whole block.
			const theRect = lightmap_rectchange[ surf.lightmaptexturenum ];
			theRect.l = 0;
			theRect.t = 0;
			theRect.w = BLOCK_WIDTH;
			theRect.h = BLOCK_HEIGHT;

		}

	}

}

/*
R_UploadLightmapRect

The upload half of R_BlendLightmaps for lightmap block i. GLQuake sends only
the changed rows:
	glTexSubImage2D (GL_TEXTURE_2D, 0, 0, theRect->t, BLOCK_WIDTH, theRect->h, ...)
Three.js has no sub-image upload on the texture itself, so convert those rows
of the GL_LUMINANCE block (255 - light) to the texture's RGBA brightness and
hand them to renderer.copyTextureToTexture. For CPU data that is one
texSubImage2D, and it uploads the destination first if it is still pending.

The source must be a texture the renderer has never seen: once a texture has
GPU state, copyTextureToTexture copies through a framebuffer instead. Without
a renderer (tests, server) fall back to a full re-upload.
*/
let _lightmapUploadSrc = null; // THREE.DataTexture sharing the block's image
const _lightmapSrcRegion = { min: { x: 0, y: 0 }, max: { x: BLOCK_WIDTH, y: 0 } };
const _lightmapDstPosition = { x: 0, y: 0, z: 0 };

export function R_UploadLightmapRect( i, theRect, r ) {

	const tex = lightmapTextures[ i ];
	if ( tex == null || tex.image == null || tex.image.data == null )
		return;
	if ( theRect.h <= 0 )
		return;

	const src = lightmaps[ i ];
	const dstData = tex.image.data;
	const end = ( theRect.t + theRect.h ) * BLOCK_WIDTH;

	for ( let p = theRect.t * BLOCK_WIDTH; p < end; p ++ ) {

		const val = 255 - src[ p ];
		dstData[ p * 4 ] = val;
		dstData[ p * 4 + 1 ] = val;
		dstData[ p * 4 + 2 ] = val;
		dstData[ p * 4 + 3 ] = 255;

	}

	if ( r == null ) {

		tex.needsUpdate = true;
		return;

	}

	if ( _lightmapUploadSrc === null )
		_lightmapUploadSrc = new THREE.DataTexture();
	_lightmapUploadSrc.image = tex.image;

	_lightmapSrcRegion.min.y = theRect.t;
	_lightmapSrcRegion.max.y = theRect.t + theRect.h;
	_lightmapDstPosition.y = theRect.t;
	r.copyTextureToTexture( _lightmapUploadSrc, tex, _lightmapSrcRegion, _lightmapDstPosition );

}

export function R_BlendLightmaps() {

	R_CheckLightmapCvars();

	if ( ! gl_texsort.value )
		return;

	// In Three.js, lightmaps are applied as texture maps on materials
	// rather than blended separately. This function handles the
	// lightmap texture updates.

	for ( let i = 0; i < lightmap_count; i ++ ) {

		// Check if this lightmap was modified (by world or brush entity surfaces)
		// Don't require lightmap_polys[i] to be set - brush entities may use
		// lightmap atlases that have no visible world surfaces this frame.
		if ( lightmap_modified[ i ] ) {

			lightmap_modified[ i ] = false;
			const theRect = lightmap_rectchange[ i ];

			R_UploadLightmapRect( i, theRect, renderer );
			theRect.l = BLOCK_WIDTH;
			theRect.t = BLOCK_HEIGHT;
			theRect.h = 0;
			theRect.w = 0;

		}

		// Lightmap polys are blended via material in Three.js path
		// No need for explicit GL blend state

	}

}

//============================================================================
// R_DrawWaterSurfaces
//============================================================================

export function R_DrawWaterSurfaces() {

	const cl_ref = cl;

	if ( ! R_AnyLiquidTranslucent() && gl_texsort.value )
		return;

	if ( ! gl_texsort.value ) {

		if ( ! waterchain )
			return;

		for ( let s = waterchain; s; s = s.texturechain ) {

			if ( s.polys && worldGroup ) {

				const geometry = EmitWaterPolysQuake( s, R_WarpTime() );
				if ( geometry ) {

					const material = _getWaterMaterial( s.texinfo.texture, GL_WaterAlphaForSurface( s ) );
					_getWaterMesh( s, geometry, material, worldGroup );

				}

			}

		}

		waterchain = null;

	} else {

		if ( ! cl_ref || ! cl_ref.worldmodel ) return;

		for ( let i = 0; i < cl_ref.worldmodel.numtextures; i ++ ) {

			const t = cl_ref.worldmodel.textures[ i ];
			if ( ! t ) continue;

			let s = t.texturechain;
			if ( ! s ) continue;

			if ( ! ( s.flags & SURF_DRAWTURB ) )
				continue;

			for ( ; s; s = s.texturechain ) {

				if ( s.polys && worldGroup ) {

					const geometry = EmitWaterPolysQuake( s, R_WarpTime() );
					if ( geometry ) {

						const material = _getWaterMaterial( t, GL_WaterAlphaForSurface( s ) );
						_getWaterMesh( s, geometry, material, worldGroup );

					}

				}

			}

			t.texturechain = null;

		}

	}

}

//============================================================================
// R_MarkLeaves
//============================================================================

// Cached buffer for r_novis solid visibility (matches C's static byte solid[4096])
let _markleaves_solid = new Uint8Array( 4096 );

export function R_MarkLeaves() {

	const cl_ref = cl;
	if ( ! cl_ref || ! cl_ref.worldmodel ) return;

	if ( r_oldviewleaf === r_viewleaf && ! r_novis.value ) {

		_visibilityNeedsUpdate = false;
		return;

	}

	if ( mirror ) {

		// Mirror rendering - keep visibility from main view, don't update
		_visibilityNeedsUpdate = false;
		return;

	}

	_visibilityNeedsUpdate = true;
	inc_r_visframecount();
	set_r_oldviewleaf( r_viewleaf );

	let vis;
	if ( r_novis.value || r_viewleaf == null ) {

		// mark everything visible (also when r_viewleaf is null - player outside map)
		const numBytes = ( cl_ref.worldmodel.numleafs + 7 ) >> 3;
		if ( _markleaves_solid.length < numBytes ) {

			_markleaves_solid = new Uint8Array( numBytes );

		}

		_markleaves_solid.fill( 0xff, 0, numBytes );
		vis = _markleaves_solid;

	} else {

		vis = Mod_LeafPVS( r_viewleaf, cl_ref.worldmodel );

	}

	if ( ! vis ) return;

	for ( let i = 0; i < cl_ref.worldmodel.numleafs; i ++ ) {

		if ( vis[ i >> 3 ] & ( 1 << ( i & 7 ) ) ) {

			let node = cl_ref.worldmodel.leafs[ i + 1 ];
			if ( ! node ) continue;

			while ( node ) {

				if ( node.visframe === r_visframecount )
					break;
				node.visframe = r_visframecount;
				node = node.parent;

			}

		}

	}

}

//============================================================================
// R_MirrorChain
//============================================================================

// GLQuake's R_NewMap picks the mirror texture by this name prefix.
export function R_IsMirrorTexture( t ) {

	return t != null && typeof t.name === 'string' && t.name.substring( 0, 10 ) === 'window02_1';

}

export function R_MirrorChain( s ) {

	if ( mirror )
		return;

	set_mirror( true );
	set_mirror_plane( s.plane );

	// GLQuake draws every surface in the chain with the first one's plane.
	// Only the coplanar ones are mirrored here; any others stay as ordinary
	// world surfaces.
	mirrorItems.length = 0;
	for ( ; s; s = s.texturechain ) {

		if ( s.plane !== mirror_plane )
			continue;

		const item = worldMirrors.get( s );
		if ( item !== undefined )
			mirrorItems.push( item );

	}

}

// The mirror surfaces on mirror_plane that R_MirrorChain found this frame.
export function R_GetMirrorItems() {

	return mirrorItems;

}

function R_ClearMirrors() {

	for ( const item of worldMirrors.values() )
		item.geom.dispose();
	worldMirrors.clear();
	mirrorItems.length = 0;

}

//============================================================================
// R_DrawSkyChain
//============================================================================

let solidSkyMaterial = null;
let alphaSkyMaterial = null;

function R_DrawSkyChain( s ) {

	if ( ! worldGroup ) return;

	// Create or update sky materials from the sky textures
	if ( solidskytexture && ! solidSkyMaterial ) {

		solidSkyMaterial = new THREE.MeshBasicMaterial( {
			map: solidskytexture,
			side: THREE.DoubleSide
		} );
		solidSkyMaterial.onBeforeCompile = R_PatchSolidSkyVertexShader;
		solidSkyMaterial.customProgramCacheKey = R_SolidSkyProgramKey;

	}

	if ( alphaskytexture && ! alphaSkyMaterial ) {

		alphaSkyMaterial = new THREE.MeshBasicMaterial( {
			map: alphaskytexture,
			side: THREE.DoubleSide,
			transparent: true,
			alphaTest: 0.05
		} );
		alphaSkyMaterial.onBeforeCompile = R_PatchAlphaSkyVertexShader;
		alphaSkyMaterial.customProgramCacheKey = R_AlphaSkyProgramKey;

	}

	// Fallback if sky textures not loaded
	if ( ! solidSkyMaterial ) {

		solidSkyMaterial = new THREE.MeshBasicMaterial( {
			color: 0x3366aa,
			side: THREE.DoubleSide
		} );

	}

	// Solid sky layer (background, speed = time*8)
	const time = R_WarpTime();
	let solidSpeed = time * 8;
	solidSpeed -= ( solidSpeed | 0 ) & ~127;
	_solidSkySpeed.value = solidSpeed;
	_skyOrigin.value.set( r_origin[ 0 ], r_origin[ 1 ], r_origin[ 2 ] );

	for ( let fa = s; fa; fa = fa.texturechain ) {

		if ( ! fa.polys ) continue;

		const geometry = EmitSkyPolysQuake( fa, 0 );
		if ( geometry ) {

			// Cache sky mesh on surface, keyed by layer
			let mesh = fa._skyMesh;
			if ( ! mesh ) {

				mesh = new THREE.Mesh( geometry, solidSkyMaterial );
				fa._skyMesh = mesh;

			} else {

				if ( mesh.geometry !== geometry ) mesh.geometry = geometry;
				mesh.material = solidSkyMaterial;

			}

			if ( mesh.parent !== worldGroup ) {

				if ( mesh.parent ) mesh.parent.remove( mesh );
				worldGroup.add( mesh );

			}

			_waterMeshesThisFrame.add( mesh );
			_waterMeshesInScene.add( mesh );

		}

	}

	// Alpha sky layer (overlay, speed = time*16)
	if ( alphaSkyMaterial ) {

		let alphaSpeed = time * 16;
		alphaSpeed -= ( alphaSpeed | 0 ) & ~127;
		_alphaSkySpeed.value = alphaSpeed;

		for ( let fa = s; fa; fa = fa.texturechain ) {

			if ( ! fa.polys ) continue;

			const geometry = EmitSkyPolysQuake( fa, 1 );
			if ( geometry ) {

				let mesh = fa._skyMesh2;
				if ( ! mesh ) {

					mesh = new THREE.Mesh( geometry, alphaSkyMaterial );
					fa._skyMesh2 = mesh;

				} else {

					if ( mesh.geometry !== geometry ) mesh.geometry = geometry;
					mesh.material = alphaSkyMaterial;

				}

				if ( mesh.parent !== worldGroup ) {

					if ( mesh.parent ) mesh.parent.remove( mesh );
					worldGroup.add( mesh );

				}

				_waterMeshesThisFrame.add( mesh );
				_waterMeshesInScene.add( mesh );

			}

		}

	}

}

//============================================================================
// AllocBlock
//
// Returns a texture number and the position inside it
//============================================================================

export function AllocBlock( w, h, outX, outY ) {

	// ericw (QuakeSpasm) -- rather than searching starting at lightmap 0 every
	// time, start at the last lightmap we allocated a surface in. This makes
	// AllocBlock much faster on large levels, at a cost of not quite packing
	// lightmaps as tightly (uses ~5% more lightmaps).
	for ( let texnum = last_lightmap_allocated; texnum < MAX_SANITY_LIGHTMAPS; texnum ++ ) {

		if ( texnum === lightmap_count ) {

			lightmap_count ++;
			GL_GrowLightmaps( lightmap_count );
			// QuakeSpasm callocs each new block; blocks here are reused
			// across maps, so clear the old map's state instead.
			lightmaps[ texnum ].fill( 0 );
			lightmap_polys[ texnum ] = null;
			lightmap_modified[ texnum ] = false;
			// as we're only tracking one texture, we don't need multiple
			// copies of allocated any more.
			allocated.fill( 0 );

		}

		let best = BLOCK_HEIGHT;

		for ( let i = 0; i < BLOCK_WIDTH - w; i ++ ) {

			let best2 = 0;
			let j;

			for ( j = 0; j < w; j ++ ) {

				if ( allocated[ i + j ] >= best )
					break;
				if ( allocated[ i + j ] > best2 )
					best2 = allocated[ i + j ];

			}

			if ( j === w ) {

				// this is a valid spot
				outX.value = i;
				outY.value = best = best2;

			}

		}

		if ( best + h > BLOCK_HEIGHT )
			continue;

		for ( let i = 0; i < w; i ++ )
			allocated[ outX.value + i ] = best + h;

		last_lightmap_allocated = texnum;
		return texnum;

	}

	Sys_Error( 'AllocBlock: full' );

}

//============================================================================
// BuildSurfaceDisplayList
//
// Reconstructs polygon from BSP edges and computes texture coordinates.
// In Three.js, we build BufferGeometry instead of glpoly_t display lists.
//============================================================================

export function BuildSurfaceDisplayList( fa ) {

	if ( ! currentmodel ) return;

	const pedges = currentmodel.edges;
	const lnumverts = fa.numedges;

	// create glpoly_t equivalent
	const poly = {
		next: fa.polys,
		flags: fa.flags,
		numverts: lnumverts,
		verts: new Float32Array( lnumverts * VERTEXSIZE ),
		chain: null
	};

	fa.polys = poly;

	for ( let i = 0; i < lnumverts; i ++ ) {

		const lindex = currentmodel.surfedges[ fa.firstedge + i ];
		let vec;

		if ( lindex > 0 ) {

			const r_pedge = pedges[ lindex ];
			vec = r_pcurrentvertbase[ r_pedge.v[ 0 ] ].position;

		} else {

			const r_pedge = pedges[ - lindex ];
			vec = r_pcurrentvertbase[ r_pedge.v[ 1 ] ].position;

		}

		// texture coordinates
		let s = DotProduct( vec, fa.texinfo.vecs[ 0 ] ) + fa.texinfo.vecs[ 0 ][ 3 ];
		s /= fa.texinfo.texture.width;

		let t = DotProduct( vec, fa.texinfo.vecs[ 1 ] ) + fa.texinfo.vecs[ 1 ][ 3 ];
		t /= fa.texinfo.texture.height;

		const vi = i * VERTEXSIZE;
		poly.verts[ vi + 0 ] = vec[ 0 ];
		poly.verts[ vi + 1 ] = vec[ 1 ];
		poly.verts[ vi + 2 ] = vec[ 2 ];
		poly.verts[ vi + 3 ] = s;
		poly.verts[ vi + 4 ] = t;

		// lightmap texture coordinates
		s = DotProduct( vec, fa.texinfo.vecs[ 0 ] ) + fa.texinfo.vecs[ 0 ][ 3 ];
		s -= fa.texturemins[ 0 ];
		s += fa.light_s * 16;
		s += 8;
		s /= BLOCK_WIDTH * 16;

		t = DotProduct( vec, fa.texinfo.vecs[ 1 ] ) + fa.texinfo.vecs[ 1 ][ 3 ];
		t -= fa.texturemins[ 1 ];
		t += fa.light_t * 16;
		t += 8;
		t /= BLOCK_HEIGHT * 16;

		poly.verts[ vi + 5 ] = s;
		poly.verts[ vi + 6 ] = t;

	}

	// remove co-linear points
	if ( ! gl_keeptjunctions.value && ! ( fa.flags & SURF_UNDERWATER ) ) {

		let numverts = poly.numverts;
		for ( let i = 0; i < numverts; i ++ ) {

			const prevIdx = ( ( i + numverts - 1 ) % numverts ) * VERTEXSIZE;
			const thisIdx = i * VERTEXSIZE;
			const nextIdx = ( ( i + 1 ) % numverts ) * VERTEXSIZE;

			// Use cached buffers to avoid per-iteration allocations (Golden Rule #4)
			const v1 = _colinear_v1;
			const v2 = _colinear_v2;

			v1[ 0 ] = poly.verts[ thisIdx + 0 ] - poly.verts[ prevIdx + 0 ];
			v1[ 1 ] = poly.verts[ thisIdx + 1 ] - poly.verts[ prevIdx + 1 ];
			v1[ 2 ] = poly.verts[ thisIdx + 2 ] - poly.verts[ prevIdx + 2 ];
			VectorNormalize( v1 );

			v2[ 0 ] = poly.verts[ nextIdx + 0 ] - poly.verts[ prevIdx + 0 ];
			v2[ 1 ] = poly.verts[ nextIdx + 1 ] - poly.verts[ prevIdx + 1 ];
			v2[ 2 ] = poly.verts[ nextIdx + 2 ] - poly.verts[ prevIdx + 2 ];
			VectorNormalize( v2 );

			const COLINEAR_EPSILON = 0.001;
			if ( ( Math.abs( v1[ 0 ] - v2[ 0 ] ) <= COLINEAR_EPSILON ) &&
				( Math.abs( v1[ 1 ] - v2[ 1 ] ) <= COLINEAR_EPSILON ) &&
				( Math.abs( v1[ 2 ] - v2[ 2 ] ) <= COLINEAR_EPSILON ) ) {

				// remove this vertex by shifting subsequent vertices
				for ( let j = i + 1; j < numverts; j ++ ) {

					for ( let k = 0; k < VERTEXSIZE; k ++ )
						poly.verts[ ( j - 1 ) * VERTEXSIZE + k ] = poly.verts[ j * VERTEXSIZE + k ];

				}

				numverts --;
				nColinElim ++;
				i --;

			}

		}

		poly.numverts = numverts;

	}

}

//============================================================================
// GL_CreateSurfaceLightmap
//============================================================================

export function GL_CreateSurfaceLightmap( surf ) {

	if ( surf.flags & ( SURF_DRAWSKY | SURF_DRAWTURB ) )
		return;

	const smax = ( surf.extents[ 0 ] >> 4 ) + 1;
	const tmax = ( surf.extents[ 1 ] >> 4 ) + 1;

	const outX = { value: 0 };
	const outY = { value: 0 };
	surf.lightmaptexturenum = AllocBlock( smax, tmax, outX, outY );
	surf.light_s = outX.value;
	surf.light_t = outY.value;

	const offset = ( surf.light_t * BLOCK_WIDTH + surf.light_s ) * lightmap_bytes;
	R_BuildLightMap( surf, lightmaps[ surf.lightmaptexturenum ], offset, BLOCK_WIDTH * lightmap_bytes );

}

//============================================================================
// GL_BuildLightmaps
//
// Builds the lightmap texture with all the surfaces from all brush models.
// In Three.js, we create THREE.DataTexture objects for each lightmap atlas.
//============================================================================

export const lightmapTextures = []; // THREE.DataTexture array

//============================================================================
// R_BuildWorldMeshes
//
// Builds world geometry using BatchedMesh for efficient PVS culling.
// One BatchedMesh per (texture, lightmap) combo, with each leaf's geometry
// added as a separate instance. Visibility is toggled via setVisibleAt().
//============================================================================

// Batch key for each texture_t, assigned on first use (was Math.random())
let _batchBuildId = 0;

function R_BuildWorldMeshes() {

	const cl_ref = cl;
	if ( ! cl_ref || ! cl_ref.worldmodel ) return;

	if ( ! worldGroup ) {

		worldGroup = new THREE.Group();
		worldGroup.name = 'quake_world';
		if ( scene ) scene.add( worldGroup );

	}

	const worldmodel = cl_ref.worldmodel;

	// Clear previous batch data
	instanceVisInfo.length = 0;
	R_ClearMirrors();
	worldBatchedMeshes.length = 0;
	worldAnimatedMeshes.length = 0;

	// Build a mapping from surface to ALL leaves that contain it.
	// A surface is visible if ANY of its containing leaves is visible (PVS).
	const surfaceToLeaves = new Map();

	for ( let leafIdx = 1; leafIdx <= worldmodel.numleafs; leafIdx ++ ) {

		const leaf = worldmodel.leafs[ leafIdx ];
		if ( ! leaf ) continue;
		if ( leaf.contents === - 2 ) continue; // CONTENTS_SOLID

		if ( leaf.firstmarksurface && leaf.nummarksurfaces > 0 ) {

			for ( let j = 0; j < leaf.nummarksurfaces; j ++ ) {

				const surf = leaf.firstmarksurface[ j ];
				if ( ! surf ) continue;

				if ( ! surfaceToLeaves.has( surf ) ) {

					surfaceToLeaves.set( surf, [] );

				}

				surfaceToLeaves.get( surf ).push( leaf );

			}

		}

	}

	// First pass: collect geometry data per (texture, lightmap)
	const batchGroups = R_CollectWorldBatchGroups( worldmodel, surfaceToLeaves );

	// Identity matrix for all geometries (already in world space)
	const identityMatrix = new THREE.Matrix4();

	// Second pass: create BatchedMesh for each (texture, lightmap) group
	for ( const group of batchGroups.values() ) {

		const t = group.texture;
		const animTex = R_TextureAnimation( t, 0 );
		const diffuse = animTex != null && animTex.gl_texture != null ? animTex.gl_texture : t.gl_texture;
		const lmTex = lightmapTextures[ group.lmNum ];
		const material = R_CreateWorldMaterial( diffuse, lmTex, group.underwater );

		// Create BatchedMesh with capacity for all geometries in this group
		const batchedMesh = new THREE.BatchedMesh(
			group.totalGeoms,
			group.totalVerts,
			0, // no indices (non-indexed geometry)
			material
		);

		// Name for debugging (texture name + lightmap number); underwater
		// batches skip frustum culling
		R_InitWorldBatch( batchedMesh, group );

		// Add each surface's geometry to the batch
		for ( const surfData of group.surfaceData ) {

			// Add geometry, then create an instance of it
			const geoId = batchedMesh.addGeometry( surfData.geom );
			const instanceId = batchedMesh.addInstance( geoId );
			batchedMesh.setMatrixAt( instanceId, identityMatrix );

			// Store instance with ALL its leaves for visibility updates
			// Surface is visible if ANY of its leaves is visible
			instanceVisInfo.push( {
				batch: batchedMesh,
				instanceId: instanceId,
				leaves: surfData.leaves
			} );

			if ( surfData.mirrorGeom != null ) {

				worldMirrors.set( surfData.surf, {
					surf: surfData.surf,
					geom: surfData.mirrorGeom,
					texture: t.gl_texture,
					batch: batchedMesh,
					instanceId: instanceId
				} );

			}

			// Dispose the temporary geometry (data copied to batch)
			surfData.geom.dispose();

		}

		worldGroup.add( batchedMesh );
		worldBatchedMeshes.push( batchedMesh );
		if ( t.anim_total > 0 )
			worldAnimatedMeshes.push( { mesh: batchedMesh, baseTexture: t } );

	}

}

/*
First pass of R_BuildWorldMeshes: group the world's drawn surfaces by
(texture, lightmap). SURF_UNDERWATER surfaces get their own groups, because
gl_rsurf.c draws them with DrawGLWaterPoly and here their batch takes the
warping material.
*/
export function R_CollectWorldBatchGroups( worldmodel, surfaceToLeaves ) {

	// Each surface stores its geometry and ALL leaves that contain it
	// Structure: batchGroups: Map<texKey, { texture, lmNum, totalVerts, totalGeoms, surfaceData: Array<{geom, leaves}> }>
	const batchGroups = new Map();

	const surfStart = worldmodel.firstmodelsurface || 0;
	const surfEnd = surfStart + ( worldmodel.nummodelsurfaces || worldmodel.numsurfaces );

	for ( let k = surfStart; k < surfEnd; k ++ ) {

		const surf = worldmodel.surfaces[ k ];
		if ( ! surf ) continue;
		if ( surf.flags & ( SURF_DRAWSKY | SURF_DRAWTURB ) ) continue;
		if ( ! surf.polys ) continue;
		if ( ! surf.texinfo || ! surf.texinfo.texture ) continue;

		const t = surf.texinfo.texture;
		if ( ! t.gl_texture ) continue;

		// Get all leaves that contain this surface
		const leaves = surfaceToLeaves.get( surf );
		if ( ! leaves || leaves.length === 0 ) continue;

		// Get plane normal, flip if SURF_PLANEBACK (surface faces opposite of plane)
		let planeNormal = null;
		if ( surf.plane ) {

			const pn = surf.plane.normal;
			if ( surf.flags & SURF_PLANEBACK ) {

				planeNormal = new Float32Array( [ - pn[ 0 ], - pn[ 1 ], - pn[ 2 ] ] );

			} else {

				planeNormal = pn;

			}

		}

		// gl_rsurf.c R_RenderBrushPoly: SURF_UNDERWATER surfaces take
		// DrawGLWaterPoly, and their batch gets the warping material
		const underwater = ( surf.flags & SURF_UNDERWATER ) !== 0;
		const geom = underwater
			? DrawGLWaterPoly( surf.polys, planeNormal )
			: DrawGLPoly( surf.polys, planeNormal );
		if ( ! geom ) continue;

		// by name: mirrortexturenum is only set after the world meshes are built
		const isMirrorTexture = R_IsMirrorTexture( t );

		const lmNum = surf.lightmaptexturenum;
		const texKey = ( t._buildId || ( t._buildId = ++ _batchBuildId ) ) + '_' + lmNum +
			( underwater ? '_underwater' : '' );

		if ( ! batchGroups.has( texKey ) ) {

			batchGroups.set( texKey, {
				texture: t,
				lmNum: lmNum,
				underwater: underwater,
				totalVerts: 0,
				totalGeoms: 0,
				surfaceData: []
			} );

		}

		const group = batchGroups.get( texKey );
		const vertCount = geom.getAttribute( 'position' ).count;

		group.totalVerts += vertCount;
		group.totalGeoms ++;
		group.surfaceData.push( {
			geom: geom,
			leaves: leaves,
			surf: surf,
			mirrorGeom: isMirrorTexture ? geom.clone() : null
		} );

	}

	return batchGroups;

}

/*
Names a world batch and sets how Three.js culls and sorts it.

Every batch skips the per-instance work BatchedMesh does by default: sorting
instances by depth and testing each one against the frustum. Both run on
every frame for every batch while either is on, and re-upload the batch's
indirect texture. The world is static and the PVS (setVisibleAt) already picks
the surfaces, so with both off BatchedMesh does that work only when visibility
changes. In E1M1 this halved the frame time of a busy view (GPU included).
C culls BSP nodes, not single surfaces, against the frustum (R_CullBox in
R_RecursiveWorldNode); the whole-batch bounding-sphere test stays on.

An underwater group also turns that off: the warp moves vertices up to 8
units past the static bounds Three.js culls with, so culling could drop a
surface still on screen.
*/
export function R_InitWorldBatch( batchedMesh, group ) {

	const texName = group.texture.name || '';
	batchedMesh.name = `world_${texName}_lm${group.lmNum}` + ( group.underwater ? '_underwater' : '' );

	batchedMesh.sortObjects = false;
	batchedMesh.perObjectFrustumCulled = false;
	if ( group.underwater ) batchedMesh.frustumCulled = false;

}

export function R_CreateWorldMaterial( diffuse, lmTex, underwater ) {

	if ( lmTex )
		return createQuakeLightmapMaterial( diffuse, lmTex, underwater );

	const material = new THREE.MeshBasicMaterial( { map: diffuse } );
	if ( underwater ) {

		material.onBeforeCompile = R_PatchWaterWarpVertexShader;
		material.customProgramCacheKey = R_UnderwaterProgramKey;

	}

	return GL_RegisterCullMaterial( material );

}

function R_UpdateWorldTextureAnimations() {

	for ( let i = 0; i < worldAnimatedMeshes.length; i ++ ) {

		const animated = worldAnimatedMeshes[ i ];
		R_UpdateAnimatedMaterial( animated.mesh.material, animated.baseTexture, 0 );

	}

}

//============================================================================
// R_UpdateWorldVisibility
//
// Called each frame after R_MarkLeaves. Uses BatchedMesh.setVisibleAt() to
// toggle visibility. A surface is visible if ANY of its containing leaves
// is in the PVS (has visframe === r_visframecount).
//============================================================================

function R_UpdateWorldVisibility() {

	// Skip update if viewleaf hasn't changed (PVS is the same)
	if ( ! _visibilityNeedsUpdate ) return;

	for ( let i = 0; i < instanceVisInfo.length; i ++ ) {

		const info = instanceVisInfo[ i ];
		const leaves = info.leaves;

		// Surface is visible if ANY of its leaves is visible
		let visible = false;
		for ( let j = 0; j < leaves.length; j ++ ) {

			if ( leaves[ j ].visframe === r_visframecount ) {

				visible = true;
				break;

			}

		}

		info.batch.setVisibleAt( info.instanceId, visible );

	}

}

export function GL_BuildLightmaps() {

	// a new map: reparse its worldspawn's liquid alpha (QS R_NewMap)
	_liquidAlphaWorld = null;

	const cl_ref = cl;
	if ( ! cl_ref ) return;

	// Dispose old BatchedMesh objects
	for ( const batchedMesh of worldBatchedMeshes ) {

		if ( batchedMesh.parent ) batchedMesh.parent.remove( batchedMesh );
		batchedMesh.dispose();
		if ( batchedMesh.material ) batchedMesh.material.dispose();

	}

	worldBatchedMeshes.length = 0;
	worldAnimatedMeshes.length = 0;

	// Dispose any other children in worldGroup (water/sky meshes added dynamically)
	if ( worldGroup ) {

		while ( worldGroup.children.length > 0 ) {

			const child = worldGroup.children[ 0 ];
			worldGroup.remove( child );
			if ( child.geometry ) child.geometry.dispose();
			if ( child.material ) child.material.dispose();

		}

	}

	// Clear PVS instance visibility info
	instanceVisInfo.length = 0;
	R_ClearMirrors();

	// Force visibility update on first frame after map load
	_visibilityNeedsUpdate = true;

	// Clear water/sky mesh caches
	for ( const mesh of _waterMeshesInScene ) {

		if ( mesh.parent ) mesh.parent.remove( mesh );

	}

	_waterMeshesInScene = new Set();
	_waterMeshesThisFrame.clear();
	R_DisposeTurbSkyGeometry();
	for ( const mat of _waterMaterialCache.values() ) mat.dispose();
	_waterMaterialCache.clear();

	// Clear brush entity material cache (dispose old materials first)
	for ( const mat of _brushMaterialCache.values() ) mat.dispose();
	_brushMaterialCache.clear();

	// Dispose all cached brush entity groups (geometry disposal)
	for ( const group of _allBrushEntityGroups ) {

		const owner = group._quakeOwner;
		if ( owner != null && owner._brushGroup === group ) {

			owner._brushGroup = null;
			owner._brushGroupFrame = undefined;
			owner._brushAnimSurfaces = null;

		}
		group._quakeOwner = null;
		if ( group.parent ) group.parent.remove( group );
		for ( const child of group.children ) {

			if ( child.geometry ) child.geometry.dispose();

		}

	}

	_allBrushEntityGroups.clear();
	brushEntityGroups.length = 0;

	// Reset sky materials so they pick up new sky textures
	if ( solidSkyMaterial ) { solidSkyMaterial.dispose(); solidSkyMaterial = null; }
	if ( alphaSkyMaterial ) { alphaSkyMaterial.dispose(); alphaSkyMaterial = null; }

	// Three.js materials do not own or dispose the textures they reference.
	for ( let i = 0; i < lightmapTextures.length; i ++ ) {

		const texture = lightmapTextures[ i ];
		if ( texture != null ) texture.dispose();

	}

	lightmapTextures.length = 0;

	// clear allocation (QuakeSpasm: blocks are added again by AllocBlock)
	last_lightmap_allocated = 0;
	lightmap_count = 0;

	set_r_framecount( 1 ); // no dlightcache

	// set lightmap format -- use luminance (1 byte per texel)
	gl_lightmap_format = GL_LUMINANCE;
	lightmap_bytes = 1;

	// build lightmaps for all brush models
	for ( let j = 1; j < MAX_MODELS; j ++ ) {

		const m = cl_ref.model_precache ? cl_ref.model_precache[ j ] : null;
		if ( ! m ) break;
		if ( m.name && m.name.charAt( 0 ) === '*' )
			continue;

		r_pcurrentvertbase = m.vertexes;
		currentmodel = m;

		if ( m.surfaces ) {

			// Iterate ALL surfaces (m->numsurfaces), not just the world model's
			// own range. The world model's surfaces array includes submodel
			// surfaces (doors, platforms, buttons) which also need polys built.
			// This matches the original C: for (i=0; i<m->numsurfaces; i++)
			for ( let i = 0; i < m.numsurfaces; i ++ ) {

				GL_CreateSurfaceLightmap( m.surfaces[ i ] );

				if ( m.surfaces[ i ].flags & SURF_DRAWTURB )
					continue;
				if ( m.surfaces[ i ].flags & SURF_DRAWSKY )
					continue;

				BuildSurfaceDisplayList( m.surfaces[ i ] );

			}

		}

	}

	// upload all lightmaps that were filled as Three.js DataTextures
	for ( let i = 0; i < lightmap_count; i ++ ) {

		lightmap_modified[ i ] = false;
		lightmap_rectchange[ i ].l = BLOCK_WIDTH;
		lightmap_rectchange[ i ].t = BLOCK_HEIGHT;
		lightmap_rectchange[ i ].w = 0;
		lightmap_rectchange[ i ].h = 0;

		// Create Three.js DataTexture from lightmap data
		// R_BuildLightMap stores 255-brightness (Quake subtractive format).
		// Three.js lightMap is multiplicative, so invert to get brightness.
		// Use RGBA format — LuminanceFormat is not supported in WebGL 2.
		const src = lightmaps[ i ];
		const pixelCount = BLOCK_WIDTH * BLOCK_HEIGHT;
		const data = new Uint8Array( pixelCount * 4 );
		for ( let p = 0; p < pixelCount; p ++ ) {

			const val = 255 - src[ p ];
			data[ p * 4 ] = val;
			data[ p * 4 + 1 ] = val;
			data[ p * 4 + 2 ] = val;
			data[ p * 4 + 3 ] = 255;

		}

		const texture = new THREE.DataTexture(
			data,
			BLOCK_WIDTH,
			BLOCK_HEIGHT,
			THREE.RGBAFormat,
			THREE.UnsignedByteType
		);
		texture.minFilter = THREE.LinearFilter;
		texture.magFilter = THREE.LinearFilter;
		texture.flipY = false;
		// GLQuake's lightmap scales display-space colour; see LIGHTMAP_INTENSITY.
		texture.colorSpace = THREE.SRGBColorSpace;
		texture.needsUpdate = true;

		lightmapTextures[ i ] = texture;

	}

	// Build cached meshes for all world surfaces (after lightmap textures are ready)
	R_BuildWorldMeshes();

}

//============================================================================
// Stub for external dependency
//============================================================================

// Mod_LeafPVS: imported from gl_model.js at top of file

// cl is imported from client.js at the top of this file
