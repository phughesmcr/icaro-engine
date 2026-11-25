// Ported from: WinQuake/gl_rmain.c -- main GL renderer
// + WinQuake/glquake.h -- GL definitions

import * as THREE from 'three';
import { Sys_FloatTime } from './sys.js';
import { Con_Printf } from './common.js';
import { vid, renderer, vid_renderscale } from './vid.js';
import { r_refdef, r_origin, vpn, vright, vup, entity_t, r_lerpmodels, r_lerpmove, r_nolerp_list } from './render.js';
import { Cvar_RegisterVariable } from './cvar.js';
import {
	M_PI, DotProduct, VectorCopy, VectorAdd, VectorSubtract, VectorNormalize,
	AngleVectors, Length, RotatePointAroundVector, BoxOnPlaneSide
} from './mathlib.js';
import { R_DrawWorld as R_DrawWorld_impl, R_MarkLeaves as R_MarkLeaves_impl, GL_BuildLightmaps as GL_BuildLightmaps_rsurf, R_DrawBrushModel as R_DrawBrushModel_rsurf, R_DrawWaterSurfaces as R_DrawWaterSurfaces_rsurf, R_CleanupWaterMeshes as R_CleanupWaterMeshes_rsurf, R_GetMirrorItems } from './gl_rsurf.js';
import { R_MirrorGate, R_MirrorPass, R_MirrorCleanup } from './gl_rmirror.js';
import {
	Mod_PointInLeaf, SPR_SINGLE, SPR_VP_PARALLEL_UPRIGHT, SPR_FACING_UPRIGHT,
	SPR_VP_PARALLEL, SPR_ORIENTED, SPR_VP_PARALLEL_ORIENTED
} from './gl_model.js';
import { R_AnimateLight as R_AnimateLight_impl, R_RenderDlights as R_RenderDlights_impl, R_DlightDistance, R_LightPoint, lightspot } from './gl_rlight.js';
import { R_DrawAliasModel as R_DrawAliasModel_mesh, GL_DrawAliasShadow, alias_lerpdata } from './gl_mesh.js';
import { r_avertexnormal_dots } from './anorm_dots.js';
import { V_SetContentsColor as V_SetContentsColor_view, V_CalcBlend as V_CalcBlend_view } from './view.js';
import { chase_active } from './chase.js';
import {
	R_InitParticles, R_SetParticleExternals, R_ClearParticles,
	R_DrawParticles as R_DrawParticles_impl
} from './r_part.js';
import { isXRActive, getXRRig, XR_SetCamera, XR_SCALE, XR_GetControllerWorldPose, XR_RenderHUD } from './webxr.js';
import {
	cl, cl_visedicts, cl_numvisedicts, cl_dlights, cl_entities,
	cl_static_entities, cl_temp_entities, cl_lightstyle,
	MAX_DLIGHTS, MAX_VISEDICTS
} from './client.js';
import { d_lightstylevalue, r_framecount, set_r_framecount, inc_r_framecount,
	v_blend, mirrortexturenum, set_mirrortexturenum,
	r_norefresh, r_drawentities, r_drawviewmodel, r_speeds,
	r_fullbright, r_lightmap, r_shadows, r_mirroralpha,
	r_wateralpha, r_dynamic, r_novis, r_drawworld, r_waterwarp,
	gl_clear, gl_cull, gl_texsort, gl_smoothmodels, gl_affinemodels,
	gl_polyblend, gl_flashblend, gl_playermip, gl_nocolors,
	gl_keeptjunctions, gl_reporttjunctions,
	gl_doubleeyes, gl_max_size, gl_finish, GL_UpdateCull, GL_RegisterCullMaterial
} from './glquake.js';
export { GL_BuildLightmaps_rsurf as GL_BuildLightmaps };
export { r_norefresh, r_drawentities, r_drawviewmodel, r_speeds,
	v_blend, mirrortexturenum, set_mirrortexturenum,
	r_fullbright, r_lightmap, r_shadows, r_mirroralpha,
	r_wateralpha, r_dynamic, r_novis, r_drawworld, r_waterwarp,
	gl_clear, gl_cull, gl_texsort, gl_smoothmodels, gl_affinemodels,
	gl_polyblend, gl_flashblend, gl_playermip, gl_nocolors,
	gl_keeptjunctions, gl_reporttjunctions,
	gl_doubleeyes, gl_max_size };

//============================================================================
// glquake.h constants
//============================================================================

export const ALIAS_BASE_SIZE_RATIO = ( 1.0 / 11.0 );
export const MAX_LBM_HEIGHT = 480;

export const TILE_SIZE = 128;

/*
gl_farclip, from QuakeSpasm and Ironwail (gl_rmain.c): the far clip
distance. id's R_SetupGL hard-codes 4096, so that is the default here;
QuakeSpasm and Ironwail default to 65536 for large custom maps. With
zNear 4 the far plane barely changes depth precision: a 24-bit depth step
at distance z is about z * z / ( 4 * 2^24 ) units whatever the far plane.
*/
export const gl_farclip = { name: 'gl_farclip', string: '4096', value: 4096, archive: true };
export const SKYSHIFT = 7;
export const SKYSIZE = ( 1 << SKYSHIFT );
export const SKYMASK = ( SKYSIZE - 1 );

export const BACKFACE_EPSILON = 0.01;

export const VERTEXSIZE = 7; // x, y, z, s, t, lightmap_s, lightmap_t

// plane types for fast side tests
export const PLANE_X = 0;
export const PLANE_Y = 1;
export const PLANE_Z = 2;
export const PLANE_ANYZ = 3;

// model types
export const mod_brush = 0;
export const mod_sprite = 1;
export const mod_alias = 2;

// surface flags
export const SURF_PLANEBACK = 2;
export const SURF_DRAWSKY = 4;
export const SURF_DRAWSPRITE = 8;
export const SURF_DRAWTURB = 0x10;
export const SURF_DRAWTILED = 0x20;
export const SURF_DRAWBACKGROUND = 0x40;
export const SURF_UNDERWATER = 0x80;

// max dlights; MAX_DLIGHTS and MAX_VISEDICTS are defined in client.js
export { MAX_DLIGHTS, MAX_VISEDICTS };
export const MAXLIGHTMAPS = 4;

//============================================================================
// Globals from gl_rmain.c
//============================================================================

// Deferred initialization — entity_t may not be available at module load time
// due to circular imports (gl_rmain -> gl_model -> gl_mesh -> gl_rmisc -> gl_rmain).
// Initialized in R_Init().
export let r_worldentity = null;

export let r_cache_thrash = false; // compatability

export const modelorg = new Float32Array( 3 );
export const r_entorigin = new Float32Array( 3 );
export let currententity = null; // entity_t pointer

export let r_visframecount = 0; // bumped when going to a new PVS

// frustum planes (4 planes for view frustum)
export class mplane_t {

	constructor() {

		this.normal = new Float32Array( 3 );
		this.dist = 0;
		this.type = 0; // for texture axis selection and fast side tests
		this.signbits = 0; // signx + signy<<1 + signz<<2

	}

}

export const frustum = [
	new mplane_t(), new mplane_t(), new mplane_t(), new mplane_t()
];

export let c_brush_polys = 0;
export let c_alias_polys = 0;


export let currenttexture = - 1; // to avoid unnecessary texture sets
export const cnttextures = [ - 1, - 1 ]; // cached

export const particletexture = 0; // little dot for particles
export const playertextures = 0; // up to 16 color translated skins

export let mirror = false;
export let mirror_plane = null; // mplane_t pointer

export const r_world_matrix = new Float32Array( 16 );

export let r_viewleaf = null; // mleaf_t
export let r_oldviewleaf = null; // mleaf_t

export const r_notexture_mip = null;

// Shared renderer state is imported from glquake.js and re-exported here so
// gl_rsurf.js keeps its existing dependency without adding a gl_rlight cycle.
export { d_lightstylevalue, r_framecount, set_r_framecount, inc_r_framecount };
export { chase_active };

export let gldepthmin = 0;
export let gldepthmax = 1;

// Setter functions for mutable state (ES module imports are read-only)
export function set_r_visframecount( v ) { r_visframecount = v; }
export function inc_r_visframecount() { return ++ r_visframecount; }
export function set_r_worldentity( value ) { r_worldentity = value; }
export function set_currententity( value ) { currententity = value; }
export function set_c_brush_polys( v ) { c_brush_polys = v; }
export function inc_c_brush_polys() { return ++ c_brush_polys; }
export function set_currenttexture( v ) { currenttexture = v; }
export function set_r_oldviewleaf( v ) { r_oldviewleaf = v; }
export function set_r_viewleaf( v ) { r_viewleaf = v; }
export function set_mirror( v ) { mirror = v; }
export function set_mirror_plane( v ) { mirror_plane = v; }

export let glx = 0, gly = 0, glwidth = 0, glheight = 0;

//============================================================================
// Three.js scene and camera (replace raw GL state)
//============================================================================

export let scene = null; // THREE.Scene
export let camera = null; // THREE.PerspectiveCamera

//============================================================================
// Cvars
//============================================================================

// Most cvars are defined in glquake.js and imported+re-exported above.
// They are registered in gl_rmisc.js R_Init().

//============================================================================
// R_CullBox
//
// Returns true if the box is completely outside the frustum
//============================================================================

export function R_CullBox( mins, maxs ) {

	for ( let i = 0; i < 4; i ++ ) {

		if ( BoxOnPlaneSide( mins, maxs, frustum[ i ] ) === 2 )
			return true;

	}

	return false;

}

//============================================================================
// SignbitsForPlane
//============================================================================

function SignbitsForPlane( out ) {

	// for fast box on planeside test
	let bits = 0;
	for ( let j = 0; j < 3; j ++ ) {

		if ( out.normal[ j ] < 0 )
			bits |= 1 << j;

	}

	return bits;

}

//============================================================================
// R_SetFrustum
//============================================================================

export function R_SetFrustum() {

	if ( r_refdef.fov_x === 90 ) {

		// front side is visible
		VectorAdd( vpn, vright, frustum[ 0 ].normal );
		VectorSubtract( vpn, vright, frustum[ 1 ].normal );

		VectorAdd( vpn, vup, frustum[ 2 ].normal );
		VectorSubtract( vpn, vup, frustum[ 3 ].normal );

	} else {

		// rotate VPN right by FOV_X/2 degrees
		RotatePointAroundVector( frustum[ 0 ].normal, vup, vpn, - ( 90 - r_refdef.fov_x / 2 ) );
		// rotate VPN left by FOV_X/2 degrees
		RotatePointAroundVector( frustum[ 1 ].normal, vup, vpn, 90 - r_refdef.fov_x / 2 );
		// rotate VPN up by FOV_Y/2 degrees
		RotatePointAroundVector( frustum[ 2 ].normal, vright, vpn, 90 - r_refdef.fov_y / 2 );
		// rotate VPN down by FOV_Y/2 degrees
		RotatePointAroundVector( frustum[ 3 ].normal, vright, vpn, - ( 90 - r_refdef.fov_y / 2 ) );

	}

	for ( let i = 0; i < 4; i ++ ) {

		frustum[ i ].type = PLANE_ANYZ;
		frustum[ i ].dist = DotProduct( r_origin, frustum[ i ].normal );
		frustum[ i ].signbits = SignbitsForPlane( frustum[ i ] );

	}

}

//============================================================================
// R_SetupFrame
//============================================================================

export function R_SetupFrame() {

	// don't allow cheats in multiplayer
	if ( cl && cl.maxclients > 1 ) {

		r_fullbright.value = 0;
		r_fullbright.string = '0';

	}

	R_AnimateLight();

	inc_r_framecount();

	// build the transformation matrix for the given view angles
	VectorCopy( r_refdef.vieworg, r_origin );

	AngleVectors( r_refdef.viewangles, vpn, vright, vup );

	// current viewleaf
	r_oldviewleaf = r_viewleaf;
	if ( cl && cl.worldmodel ) {

		r_viewleaf = Mod_PointInLeaf( r_origin, cl.worldmodel );

	}

	V_SetContentsColor( r_viewleaf ? r_viewleaf.contents : 0 );
	V_CalcBlend();

	r_cache_thrash = false;

	c_brush_polys = 0;
	c_alias_polys = 0;

}

//============================================================================
// R_SetupGL
//
// Instead of raw GL matrix setup, we configure the Three.js camera
// to match Quake's projection and modelview matrices.
//============================================================================

export function R_SetupGL() {

	const screenaspect = r_refdef.vrect.width / r_refdef.vrect.height;

	// set drawing parms: glEnable/glDisable(GL_CULL_FACE) from gl_cull
	GL_UpdateCull();

	// set up Three.js camera to match Quake's perspective
	if ( camera == null ) {

		camera = new THREE.PerspectiveCamera(
			r_refdef.fov_y,
			screenaspect,
			4, // zNear
			gl_farclip.value // zFar
		);

		// Parent camera to XR rig (if available).
		// In non-XR: parent doesn't matter (matrixAutoUpdate = false).
		// In XR: Three.js composes rig.matrixWorld × camera.matrix (headset pose).
		XR_SetCamera( camera );

	} else {

		camera.fov = r_refdef.fov_y;
		camera.aspect = screenaspect;

		// In XR mode, scene is in meters (1/XR_SCALE). Three.js XR uses
		// camera.near/far for clipping, so convert to meters.
		if ( isXRActive() ) {

			camera.near = 4 / XR_SCALE;
			camera.far = gl_farclip.value / XR_SCALE;

		} else {

			camera.near = 4;
			camera.far = gl_farclip.value;

		}

		camera.updateProjectionMatrix();

	}

	//
	// Quake's coordinate system:
	//   X = forward, Y = left, Z = up
	//
	// Three.js coordinate system:
	//   X = right, Y = up, Z = backward (out of screen)
	//
	// The original GL code does:
	//   glRotatef(-90, 1, 0, 0) -- put Z going up
	//   glRotatef(90, 0, 0, 1)  -- put Z going up
	//   glRotatef(-viewangles[ROLL], 1, 0, 0)
	//   glRotatef(-viewangles[PITCH], 0, 1, 0)
	//   glRotatef(-viewangles[YAW], 0, 0, 1)
	//   glTranslatef(-vieworg[0], -vieworg[1], -vieworg[2])
	//
	// We replicate this with Three.js by setting camera position and rotation.

	//
	// Position the camera in Quake world coordinates.
	// Geometry vertices are in Quake coords (X=forward, Y=left, Z=up).
	// Three.js camera looks down -Z with Y=up.
	//
	// We keep all geometry in Quake coordinate space and set up the camera
	// to match, using the same modelview matrix as the original GL code:
	//
	//   glRotatef(-90, 1, 0, 0)   -- maps Quake Z-up to GL Y-up
	//   glRotatef(90, 0, 0, 1)    -- maps Quake X-forward to GL -Z-forward
	//   glRotatef(-roll, 1, 0, 0)
	//   glRotatef(-pitch, 0, 1, 0)
	//   glRotatef(-yaw, 0, 0, 1)
	//   glTranslatef(-vieworg)
	//

	// Set camera position directly in Quake coordinates
	camera.position.set(
		r_refdef.vieworg[ 0 ],
		r_refdef.vieworg[ 1 ],
		r_refdef.vieworg[ 2 ]
	);

	// Build orientation using AngleVectors to get forward/right/up
	AngleVectors( r_refdef.viewangles, _setupgl_forward, _setupgl_right, _setupgl_up );

	// Build a rotation matrix from the Quake basis vectors.
	// In Quake: forward = where camera looks, right = camera right, up = camera up.
	// Three.js camera looks down -Z, X=right, Y=up.
	// GLQuake culls with glCullFace(GL_FRONT) because its polygons wind the
	// other way; the port's meshes face the camera under Three's default
	// FrontSide. gl_cull 0 turns culling off (glDisable(GL_CULL_FACE)) by
	// switching registered materials to DoubleSide in GL_UpdateCull.
	const forward = _setupgl_forward, right = _setupgl_right, up = _setupgl_up;
	const m = _setupgl_matrix;

	if ( isXRActive() ) {

		// In XR mode: scene.scale = 1/XR_SCALE puts everything in meters.
		// The rig is NOT in the scene, so it operates in meter space directly.
		// Three.js XR composes: rig.matrixWorld × camera.matrix (headset pose).
		//
		// Position the rig at vieworg (player eye level).
		// With 'local' reference space, the XR origin is at the headset's
		// starting position (no floor offset), so the rig position directly
		// corresponds to where the user sees from in the Quake world.
		const rig = getXRRig();
		if ( rig != null ) {

			const s = 1 / XR_SCALE;
			rig.position.set(
				r_refdef.vieworg[ 0 ] * s,
				r_refdef.vieworg[ 1 ] * s,
				r_refdef.vieworg[ 2 ] * s
			);

			// Build rotation-only matrix (coord conversion + viewangles)
			m.set(
				right[ 0 ], up[ 0 ], - forward[ 0 ], 0,
				right[ 1 ], up[ 1 ], - forward[ 1 ], 0,
				right[ 2 ], up[ 2 ], - forward[ 2 ], 0,
				0, 0, 0, 1
			);
			rig.quaternion.setFromRotationMatrix( m );

			// Rig is not in the scene graph, so manually update its matrixWorld
			rig.updateMatrixWorld( true );

		}

		// Let Three.js compose matrixWorld from rig × headset pose
		camera.matrixWorldAutoUpdate = true;

	} else {

		// Non-XR mode: set camera matrixWorld directly (existing behavior).
		// matrixWorldAutoUpdate must be false so Three.js doesn't overwrite
		// our manually-set matrixWorld from the parent rig's transform.
		m.set(
			right[ 0 ], up[ 0 ], - forward[ 0 ], r_refdef.vieworg[ 0 ],
			right[ 1 ], up[ 1 ], - forward[ 1 ], r_refdef.vieworg[ 1 ],
			right[ 2 ], up[ 2 ], - forward[ 2 ], r_refdef.vieworg[ 2 ],
			0, 0, 0, 1
		);

		camera.matrixAutoUpdate = false;
		camera.matrixWorldAutoUpdate = false;
		camera.matrixWorld.copy( m );
		camera.matrixWorldInverse.copy( m ).invert();
		camera.matrixWorld.decompose( camera.position, camera.quaternion, camera.scale );

	}

	// Store world matrix for later use (mirror rendering, etc.)
	const elements = camera.matrixWorldInverse.elements;
	for ( let i = 0; i < 16; i ++ ) {

		r_world_matrix[ i ] = elements[ i ];

	}

	// The view rectangle uses virtual 2D coordinates with a top-left origin.
	// Recreate Quake's physical-pixel viewport, then convert back to the logical
	// coordinates Three.js expects before it reapplies the renderer pixel ratio.
	if ( isXRActive() === false && renderer !== null ) {

		renderer.getDrawingBufferSize( _setupgl_drawingBufferSize );
		R_VrectToViewport( _setupgl_viewport, r_refdef.vrect, r_refdef.vrectScale, vid_renderscale,
			_setupgl_drawingBufferSize.x, _setupgl_drawingBufferSize.y, renderer.getPixelRatio() );
		renderer.setViewport( _setupgl_viewport[ 0 ], _setupgl_viewport[ 1 ],
			_setupgl_viewport[ 2 ], _setupgl_viewport[ 3 ] );

	}

	// Update viewport dimensions
	glx = 0;
	gly = 0;
	glwidth = vid.width;
	glheight = vid.height;

}

//============================================================================
// R_Clear
//============================================================================

// Scene background while XR is presenting (see R_RenderView)
const _xrBackground = new THREE.Color( 0x000000 );

export function R_Clear() {

	if ( ! renderer ) return;

	// In Three.js, clearing is handled by renderer.clear()
	// We configure the clear behavior based on cvars

	if ( gl_clear.value ) {

		renderer.setClearColor( 0x000000, 1 );
		renderer.clear( true, true, false );

	} else {

		renderer.clear( false, true, false ); // depth only

	}

	gldepthmin = 0;
	gldepthmax = 1;

}

//============================================================================
// R_DrawEntitiesOnList
//============================================================================

export function R_DrawEntitiesOnList() {

	if ( ! r_drawentities.value )
		return;

	// first pass: draw alias and brush models
	for ( let i = 0; i < cl_numvisedicts; i ++ ) {

		currententity = cl_visedicts[ i ];

		if ( ! currententity || ! currententity.model )
			continue;

		switch ( currententity.model.type ) {

			case mod_alias:
				R_DrawAliasModel( currententity );
				break;

			case mod_brush:
				R_DrawBrushModel( currententity );
				break;

			default:
				break;

		}

	}

	// second pass: draw sprites separately because of alpha blending
	for ( let i = 0; i < cl_numvisedicts; i ++ ) {

		currententity = cl_visedicts[ i ];

		if ( ! currententity || ! currententity.model )
			continue;

		switch ( currententity.model.type ) {

			case mod_sprite:
				R_DrawSpriteModel( currententity );
				break;

		}

	}

}

//============================================================================
// R_DrawViewModel
//============================================================================

const SHADEDOT_QUANT = 16;

// Cached callbacks for viewmodel depthRange hack (no closures in render loop)
function _viewmodelBeforeRender( r ) {

	r.getContext().depthRange( 0, 0.3 );

}

function _viewmodelAfterRender( r ) {

	r.getContext().depthRange( 0, 1 );

}

// No-op callback (Three.js requires onBeforeRender/onAfterRender to be functions, never null)
function _noop() {}

// Cached objects for XR weapon positioning (Golden Rule #4: no allocations in render loop)
const _xrControllerWorldPos = new THREE.Vector3();
const _xrControllerQuat = new THREE.Quaternion();

// Alignment quaternion: maps Quake model axes to XR controller axes.
// Quake model: +X = barrel forward, +Y = left, +Z = up
// XR pointer:  -Z = forward,       -X = left,  +Y = up
// Rotation matrix: model→controller = [[0,-1,0],[0,0,1],[-1,0,0]]
const _xrWeaponAlignQuat = new THREE.Quaternion().setFromRotationMatrix(
	new THREE.Matrix4().set(
		0, - 1, 0, 0,
		0, 0, 1, 0,
		- 1, 0, 0, 0,
		0, 0, 0, 1
	)
);

export function R_DrawViewModel() {

	if ( r_drawviewmodel.value === 0 )
		return;

	if ( chase_active.value !== 0 )
		return;

	if ( r_drawentities.value === 0 )
		return;

	if ( cl == null )
		return;

	if ( cl.items & 524288 ) // IT_INVISIBILITY
		return;

	if ( cl.stats != null && cl.stats[ 0 ] <= 0 ) // STAT_HEALTH
		return;

	currententity = cl.viewent;
	if ( currententity == null || currententity.model == null )
		return;

	// Draw normally — stays in main scene with all lights
	R_DrawAliasModel( currententity );

	const mesh = currententity._aliasMesh;
	if ( mesh == null )
		return;

	// In XR mode: position weapon at controller.
	// Scene is scaled 1/XR_SCALE (meters). Controller world pos is in meters.
	// Weapon mesh is a child of scene, so its position is in scene-local Quake units.
	// Convert: controller meters * XR_SCALE = Quake units.
	if ( isXRActive() ) {

		// Ensure weapon mesh is in the scene
		if ( mesh.parent !== scene && scene != null ) {

			scene.add( mesh );
			_entityMeshesInScene.add( mesh );

		}

		if ( XR_GetControllerWorldPose( _xrControllerWorldPos, _xrControllerQuat ) ) {

			// Controller world pos is in meters → multiply by XR_SCALE for scene-local Quake units
			mesh.position.copy( _xrControllerWorldPos ).multiplyScalar( XR_SCALE );

			// Rotation: controller world quat * alignment to orient Quake model axes
			mesh.quaternion.copy( _xrControllerQuat ).multiply( _xrWeaponAlignQuat );

			// Scale 1: geometry is in Quake units, scene.scale handles the rest
			mesh.scale.setScalar( 1 );

		}

		// No depthRange hack in XR — weapon renders at actual world position
		mesh.renderOrder = 0;
		mesh.onBeforeRender = _noop;
		mesh.onAfterRender = _noop;

	} else {

		// Non-XR: ensure mesh is in scene (handles returning from XR too)
		if ( mesh.parent !== scene && scene != null ) {

			scene.add( mesh );
			mesh.scale.setScalar( 1 );
			_entityMeshesInScene.add( mesh );

		}

		// Non-XR: apply depthRange hack so weapon renders on top of world
		const baseMaterial = mesh.material;
		if ( baseMaterial === currententity._aliasLerpMaterial ) {

			// r_lerpmodels: the gun's own lerp material (gl_mesh.js), not
			// shared, so mark it directly. A clone would lose its
			// onBeforeCompile and the blend.
			baseMaterial.transparent = true;

		} else {

			// One transparent clone per base material, kept until the map
			// changes: an animated skin or a weapon change switches the base,
			// and replacing a single clone made a new one each switch and
			// leaked the old. Registered so gl_cull reaches the clones.
			let clones = currententity._viewmodelMaterials;
			if ( clones == null ) {

				clones = new Map();
				currententity._viewmodelMaterials = clones;

			}

			let clone = clones.get( baseMaterial );
			if ( clone === undefined ) {

				clone = GL_RegisterCullMaterial( baseMaterial.clone() );
				clone.transparent = true;
				clones.set( baseMaterial, clone );

			}

			mesh.material = clone;

		}
		mesh.renderOrder = 999;

		mesh.onBeforeRender = _viewmodelBeforeRender;
		mesh.onAfterRender = _viewmodelAfterRender;

	}

}

//============================================================================
// R_DrawAliasModel (stub -- full implementation requires gl_mesh.js)
//============================================================================

// Track entity meshes currently in the scene for efficient add/remove
const _entityMeshesInScene = new Set();
const _entityMeshesThisFrame = new Set();
const _entityMeshCacheOwners = new Set();

function _disposeEntityGeometry( geometry, geometries ) {

	if ( geometry == null || geometries.has( geometry ) ) return;
	geometries.add( geometry );
	geometry.dispose();

}

function _disposeEntityMaterial( material, materials ) {

	if ( material == null || materials.has( material ) ) return;
	materials.add( material );
	material.dispose();

}

function _detachEntityMesh( mesh ) {

	if ( mesh == null ) return;
	if ( mesh.parent != null ) mesh.parent.remove( mesh );
	mesh._quakeOwner = null;

}

function _clearEntityMeshCache( entity, geometries, materials ) {

	if ( entity == null ) return;

	const spriteMesh = entity._spriteMesh;
	const aliasMesh = entity._aliasMesh;
	const shadowMesh = entity._aliasShadowMesh;
	const aliasGeometry = entity._aliasGeo;
	const shadowGeometry = entity._aliasShadowGeo;
	const viewmodelMaterials = entity._viewmodelMaterials;
	const playerMaterial = entity._playerMaterial;
	const lerpMaterial = entity._aliasLerpMaterial;
	if ( spriteMesh == null && aliasMesh == null && shadowMesh == null &&
		aliasGeometry == null && shadowGeometry == null &&
		viewmodelMaterials == null && playerMaterial == null && lerpMaterial == null ) return;

	_detachEntityMesh( spriteMesh );
	_detachEntityMesh( aliasMesh );
	_detachEntityMesh( shadowMesh );

	_disposeEntityGeometry( spriteMesh != null ? spriteMesh.geometry : null, geometries );
	_disposeEntityGeometry( aliasGeometry, geometries );
	_disposeEntityGeometry( shadowGeometry, geometries );
	if ( viewmodelMaterials != null ) {

		for ( const clone of viewmodelMaterials.values() )
			_disposeEntityMaterial( clone, materials );

	}

	_disposeEntityMaterial( playerMaterial, materials );
	_disposeEntityMaterial( lerpMaterial, materials );

	entity._spriteMesh = null;
	entity._aliasMesh = null;
	entity._aliasGeo = null;
	entity._aliasColorArray = null;
	entity._aliasPaliashdr = null;
	entity._aliasPosenum = undefined;
	entity._aliasPose1 = undefined;
	entity._aliasShadowMesh = null;
	entity._aliasShadowGeo = null;
	entity._aliasShadowPosArray = null;
	entity._aliasShadowVertCount = undefined;
	entity._viewmodelMaterials = null;
	entity._playerMaterial = null;
	entity._playerSkinTexture = null;
	entity._aliasLerpMaterial = null;

}

// Pre-allocated vector for dynamic light distance calculation (avoid per-frame allocation)
const _dlightDist = [ 0, 0, 0 ];
const _shadevector = new Float32Array( 3 );

// Cached buffers for R_SetupGL (Golden Rule #4)
const _setupgl_forward = new Float32Array( 3 );
const _setupgl_right = new Float32Array( 3 );
const _setupgl_up = new Float32Array( 3 );
const _setupgl_matrix = new THREE.Matrix4();
const _setupgl_drawingBufferSize = new THREE.Vector2();
const _setupgl_viewport = new Float64Array( 4 );

/*
=============
R_VrectToViewport

Port-only helper for R_SetupGL's glViewport. Writes the Three.js viewport
(x, y, width, height in CSS pixels, bottom-left origin) for a view rectangle
in virtual 2D coordinates. vrectScale maps those to 2D overlay pixels;
renderScale (vid_renderscale, from ?scale=) is the WebGL buffer's size
relative to the overlay, so the result is the same at every render scale.
=============
*/
export function R_VrectToViewport( out, vrect, vrectScale, renderScale, bufferWidth, bufferHeight, pixelRatio ) {

	const scale = vrectScale * renderScale;
	let x = vrect.x * scale;
	let x2 = ( vrect.x + vrect.width ) * scale;
	let y = bufferHeight - vrect.y * scale;
	let y2 = bufferHeight - ( vrect.y + vrect.height ) * scale;

	// Match GLQuake's one-pixel expansion around fractional view boundaries.
	if ( x > 0 ) x --;
	if ( x2 < bufferWidth ) x2 ++;
	if ( y2 < 0 ) y2 --;
	if ( y < bufferHeight ) y ++;

	out[ 0 ] = x / pixelRatio;
	out[ 1 ] = y2 / pixelRatio;
	out[ 2 ] = ( x2 - x ) / pixelRatio;
	out[ 3 ] = ( y - y2 ) / pixelRatio;
	return out;

}

/*
=================
R_AliasLightPoint

Deliberate deviation (Ironwail R_SetupAliasLighting): if the trace from the
model's origin finds no light at all, try again from half the model's height
above it. This helps models whose origin is slightly below the floor (e.g. the
candles on some mod start maps), which id's C draws pitch black. Ironwail
computes alias bounds from the vertices; this port keeps id's fixed +/-16
bounds (Mod_LoadAliasModel), so the retry starts 8 units up.
=================
*/
export function R_AliasLightPoint( e ) {

	const light = R_LightPoint( e.origin, cl );
	if ( light !== 0 ) return light;
	return R_LightPoint( e.origin, cl, e.model.maxs[ 2 ] * 0.5 );

}

function R_DrawAliasModel( e ) {

	if ( ! e || ! e.model ) return;
	const paliashdr = e.model.cache ? e.model.cache.data : null;
	if ( ! paliashdr || ! paliashdr.posedata ) return;

	//
	// get lighting information
	//
	let ambientlight = 0;
	let shadelight = 0;
	let shadedots = null;

	if ( cl && e.origin ) {

		ambientlight = shadelight = R_AliasLightPoint( e );

		// always give the gun some light
		if ( e === cl.viewent && ambientlight < 24 )
			ambientlight = shadelight = 24;

		// add dynamic lights to ambient/shade (gl_rmain.c:482-497)
		for ( let lnum = 0; lnum < MAX_DLIGHTS; lnum ++ ) {

			if ( cl_dlights[ lnum ].die >= cl.time ) {

				VectorSubtract( e.origin, cl_dlights[ lnum ].origin, _dlightDist );
				const add = cl_dlights[ lnum ].radius - Length( _dlightDist );

				if ( add > 0 ) {

					ambientlight += add;
					shadelight += add;

				}

			}

		}

		// clamp lighting so it doesn't overbright as much
		if ( ambientlight > 128 )
			ambientlight = 128;
		if ( ambientlight + shadelight > 192 )
			shadelight = 192 - ambientlight;

		// ZOID: never allow players to go totally black
		if ( cl_entities != null && cl.maxclients > 0 ) {

			const idx = e._entityIndex;
			if ( idx !== undefined && idx >= 1 && idx <= cl.maxclients ) {

				if ( ambientlight < 8 )
					ambientlight = shadelight = 8;

			}

		}

		// HACK HACK HACK -- no fullbright colors, so make torches full light
		const clmodel = e.model;
		if ( clmodel.name === 'progs/flame2.mdl' || clmodel.name === 'progs/flame.mdl' )
			ambientlight = shadelight = 256;

		// select shadedots row based on yaw angle
		const yaw = e.angles ? e.angles[ 1 ] : 0;
		shadedots = r_avertexnormal_dots[ ( ( yaw * ( SHADEDOT_QUANT / 360.0 ) ) | 0 ) & ( SHADEDOT_QUANT - 1 ) ];
		shadelight = shadelight / 200.0;

	}

	// Compute shadevector from entity yaw (for shadows, computed before mesh call)
	// Ported from WinQuake/gl_rmain.c:519-523
	const an = ( e.angles ? e.angles[ 1 ] : 0 ) / 180 * M_PI;
	_shadevector[ 0 ] = Math.cos( - an );
	_shadevector[ 1 ] = Math.sin( - an );
	_shadevector[ 2 ] = 1;
	const svLen = Math.sqrt( _shadevector[ 0 ] * _shadevector[ 0 ] + _shadevector[ 1 ] * _shadevector[ 1 ] + _shadevector[ 2 ] * _shadevector[ 2 ] );
	if ( svLen > 0 ) {

		_shadevector[ 0 ] /= svLen;
		_shadevector[ 1 ] /= svLen;
		_shadevector[ 2 ] /= svLen;

	}

	const mesh = R_DrawAliasModel_mesh( e, paliashdr, shadedots, shadelight );
	if ( mesh != null ) {

		mesh._quakeOwner = e;
		_entityMeshCacheOwners.add( e );

	}
	if ( mesh && scene ) {

		if ( ! _entityMeshesInScene.has( mesh ) ) {

			scene.add( mesh );
			_entityMeshesInScene.add( mesh );

		}

		_entityMeshesThisFrame.add( mesh );

	}

	// Draw shadow (Ported from WinQuake/gl_rmain.c:579-591)
	if ( r_shadows.value !== 0 && e !== cl.viewent && mesh != null && scene != null ) {

		const shadowMesh = GL_DrawAliasShadow( e, paliashdr, alias_lerpdata, lightspot, _shadevector );
		if ( shadowMesh != null ) {

			shadowMesh._quakeOwner = e;
			_entityMeshCacheOwners.add( e );

			if ( ! _entityMeshesInScene.has( shadowMesh ) ) {

				scene.add( shadowMesh );
				_entityMeshesInScene.add( shadowMesh );

			}

			_entityMeshesThisFrame.add( shadowMesh );

		}

	}

	c_alias_polys ++;

}

//============================================================================
// R_DrawBrushModel (stub -- full implementation in gl_rsurf.js)
//============================================================================

function R_DrawBrushModel( e ) {

	R_DrawBrushModel_rsurf( e );

}

//============================================================================
// R_DrawSpriteModel
// Ported from: WinQuake/gl_rmain.c
//============================================================================

/*
================
R_GetSpriteFrame
Ported from: WinQuake/gl_rmain.c:144-188
================
*/
function R_GetSpriteFrame( e ) {

	const psprite = e.model.cache.data;
	let frame = e.frame;

	if ( frame >= psprite.numframes || frame < 0 ) {

		Con_Printf( 'R_DrawSprite: no such frame ' + frame + '\n' );
		frame = 0;

	}

	if ( psprite.frames[ frame ].type === SPR_SINGLE ) {

		return psprite.frames[ frame ].frameptr;

	} else {

		const pspritegroup = psprite.frames[ frame ].frameptr;
		const pintervals = pspritegroup.intervals;
		const numframes = pspritegroup.numframes;
		const fullinterval = pintervals[ numframes - 1 ];

		const time = cl.time + e.syncbase;

		// when loading in Mod_LoadSpriteGroup, we guaranteed all interval values
		// are positive, so we don't have to worry about division by 0
		const targettime = time - ( ( time / fullinterval ) | 0 ) * fullinterval;

		let i;
		for ( i = 0; i < ( numframes - 1 ); i ++ ) {

			if ( pintervals[ i ] > targettime )
				break;

		}

		return pspritegroup.frames[ i ];

	}

}

// Sprite material caches: texture -> material. Decals (SPR_ORIENTED) get
// their own materials with a polygon offset.
const _spriteMaterialCache = new Map();
const _spriteDecalMaterialCache = new Map();
// Scratch axes for R_SpriteAxes
const _sprite_v_forward = new Float32Array( 3 );
const _sprite_v_right = new Float32Array( 3 );
const _sprite_v_up = new Float32Array( 3 );

/*
================
R_SpriteAxes

Sets up and right for a sprite of the given type and returns true, or
returns false if the sprite isn't drawn this frame.

id's GLQuake R_DrawSpriteModel handles only SPR_ORIENTED and draws every
other type parallel to the view plane. The five types below are id's own,
from WinQuake/r_sprite.c R_DrawSprite (the software renderer), which
QuakeSpasm and Ironwail also port. Like the software renderer, the two
upright types aren't drawn when the view is within 1 degree of straight up
or down. Deliberate deviation: an unknown type is skipped, as in QuakeSpasm,
rather than a Sys_Error.
================
*/
export function R_SpriteAxes( type, e, up, right ) {

	switch ( type ) {

		case SPR_FACING_UPRIGHT: {

			// vup straight up in worldspace, vright perpendicular to the
			// line from the viewer to the sprite
			const tvec = _sprite_v_forward;
			VectorSubtract( e.origin, r_origin, tvec );
			VectorNormalize( tvec );
			const dot = tvec[ 2 ];
			if ( ( dot > 0.999848 ) || ( dot < - 0.999848 ) ) // cos(1 degree) = 0.999848
				return false;
			up[ 0 ] = 0;
			up[ 1 ] = 0;
			up[ 2 ] = 1;
			right[ 0 ] = tvec[ 1 ];
			right[ 1 ] = - tvec[ 0 ];
			right[ 2 ] = 0;
			VectorNormalize( right );
			return true;

		}

		case SPR_VP_PARALLEL:
			VectorCopy( vup, up );
			VectorCopy( vright, right );
			return true;

		case SPR_VP_PARALLEL_UPRIGHT: {

			// vup straight up in worldspace, vright parallel to the viewplane
			const dot = vpn[ 2 ];
			if ( ( dot > 0.999848 ) || ( dot < - 0.999848 ) ) // cos(1 degree) = 0.999848
				return false;
			up[ 0 ] = 0;
			up[ 1 ] = 0;
			up[ 2 ] = 1;
			right[ 0 ] = vpn[ 1 ];
			right[ 1 ] = - vpn[ 0 ];
			right[ 2 ] = 0;
			VectorNormalize( right );
			return true;

		}

		case SPR_ORIENTED:
			// the sprite's world orientation (bullet marks on walls)
			AngleVectors( e.angles, _sprite_v_forward, right, up );
			return true;

		case SPR_VP_PARALLEL_ORIENTED: {

			// parallel to the viewplane, rotated by the entity's roll
			const angle = e.angles[ 2 ] * ( M_PI * 2 / 360 ); // ROLL
			const sr = Math.sin( angle );
			const cr = Math.cos( angle );
			for ( let i = 0; i < 3; i ++ ) {

				right[ i ] = vright[ i ] * cr + vup[ i ] * sr;
				up[ i ] = vright[ i ] * - sr + vup[ i ] * cr;

			}

			return true;

		}

		default:
			return false;

	}

}

export function R_SpriteMaterial( texture, decal ) {

	const cache = decal ? _spriteDecalMaterialCache : _spriteMaterialCache;
	let material = cache.get( texture );
	if ( material === undefined ) {

		material = new THREE.MeshBasicMaterial( {
			map: texture,
			transparent: true,
			alphaTest: 0.5,
			depthWrite: false,
			side: THREE.DoubleSide
		} );

		if ( decal ) {

			// Deliberate deviation, from QuakeSpasm (r_sprite.c,
			// GL_PolygonOffset( OFFSET_DECAL )): pull decals towards the
			// viewer so they don't z-fight with the wall they're on.
			material.polygonOffset = true;
			material.polygonOffsetFactor = - 1;
			material.polygonOffsetUnits = - 1;

		}

		cache.set( texture, material );

	}

	return material;

}

function R_DrawSpriteModel( e ) {

	if ( e == null || e.model == null ) return;
	const psprite = e.model.cache ? e.model.cache.data : null;
	if ( psprite == null || psprite.frames == null || psprite.frames.length === 0 ) return;

	const frame = R_GetSpriteFrame( e );
	if ( frame == null ) return;

	const texture = frame.gl_texturenum;
	if ( texture == null ) return;

	if ( R_SpriteAxes( psprite.type, e, _sprite_v_up, _sprite_v_right ) === false ) return;

	const material = R_SpriteMaterial( texture, psprite.type === SPR_ORIENTED );

	// Get or create cached geometry for this entity
	let mesh = e._spriteMesh;
	let positions;

	if ( ! mesh ) {

		// First time: create geometry with pre-allocated buffers
		positions = new Float32Array( 12 ); // 4 vertices * 3
		const uvs = new Float32Array( [ 0, 1, 1, 1, 1, 0, 0, 0 ] );

		const geometry = new THREE.BufferGeometry();
		geometry.setAttribute( 'position', new THREE.BufferAttribute( positions, 3 ) );
		geometry.setAttribute( 'uv', new THREE.BufferAttribute( uvs, 2 ) );
		geometry.setIndex( [ 0, 1, 2, 0, 2, 3 ] );

		mesh = new THREE.Mesh( geometry, material );
		// The four positions are rewritten in world space every frame, but
		// Three.js computes the bounding sphere only once, so frustum culling
		// would test a moving sprite (or a reused entity slot) against where
		// it was first drawn. C submits sprites without culling them.
		mesh.frustumCulled = false;
		e._spriteMesh = mesh;

	} else if ( mesh.material !== material ) {

		mesh.material = material;

	}

	mesh._quakeOwner = e;
	_entityMeshCacheOwners.add( e );

	// Update billboard vertex positions every frame
	const posAttr = mesh.geometry.attributes.position;
	positions = posAttr.array;

	const ox = e.origin[ 0 ];
	const oy = e.origin[ 1 ];
	const oz = e.origin[ 2 ];

	const ux = _sprite_v_up[ 0 ], uy = _sprite_v_up[ 1 ], uz = _sprite_v_up[ 2 ];
	const rx = _sprite_v_right[ 0 ], ry = _sprite_v_right[ 1 ], rz = _sprite_v_right[ 2 ];
	const l = frame.left, r = frame.right, u = frame.up, d = frame.down;

	positions[ 0 ] = ox + ux * d + rx * l;
	positions[ 1 ] = oy + uy * d + ry * l;
	positions[ 2 ] = oz + uz * d + rz * l;

	positions[ 3 ] = ox + ux * d + rx * r;
	positions[ 4 ] = oy + uy * d + ry * r;
	positions[ 5 ] = oz + uz * d + rz * r;

	positions[ 6 ] = ox + ux * u + rx * r;
	positions[ 7 ] = oy + uy * u + ry * r;
	positions[ 8 ] = oz + uz * u + rz * r;

	positions[ 9 ] = ox + ux * u + rx * l;
	positions[ 10 ] = oy + uy * u + ry * l;
	positions[ 11 ] = oz + uz * u + rz * l;

	posAttr.needsUpdate = true;

	if ( scene ) {

		if ( ! _entityMeshesInScene.has( mesh ) ) {

			scene.add( mesh );
			_entityMeshesInScene.add( mesh );

		}

		_entityMeshesThisFrame.add( mesh );

	}

}

//============================================================================
// R_PolyBlend
//
// Draws a full-screen color blend for damage flashes, powerups, etc.
// In Three.js, we use a screen-space overlay.
//============================================================================

let polyBlendMesh = null;
let polyBlendScene = null;
let polyBlendCamera = null;

export function R_PolyBlend() {

	if ( gl_polyblend.value === 0 )
		return;

	if ( v_blend[ 3 ] === 0 )
		return;

	if ( renderer == null )
		return;

	// create overlay geometry on first use
	if ( polyBlendScene == null ) {

		polyBlendScene = new THREE.Scene();
		polyBlendCamera = new THREE.OrthographicCamera( - 1, 1, 1, - 1, 0, 1 );

		const geometry = new THREE.PlaneGeometry( 2, 2 );
		// toneMapped: false keeps the blend out of the gamma exposure, like
		// GLQuake, where gamma is baked into textures and R_PolyBlend's
		// glColor4fv( v_blend ) is drawn as is.
		const material = new THREE.MeshBasicMaterial( {
			transparent: true,
			depthTest: false,
			depthWrite: false,
			toneMapped: false
		} );
		polyBlendMesh = new THREE.Mesh( geometry, material );
		polyBlendScene.add( polyBlendMesh );

	}

	// update blend color (values are sRGB from Quake's palette, tell Three.js to convert)
	polyBlendMesh.material.color.setRGB( v_blend[ 0 ], v_blend[ 1 ], v_blend[ 2 ], THREE.SRGBColorSpace );
	polyBlendMesh.material.opacity = v_blend[ 3 ];

	renderer.render( polyBlendScene, polyBlendCamera );

}

//============================================================================
// R_RenderScene
//
// r_refdef must be set before the first call
//============================================================================

export function R_RenderScene() {

	// Begin new frame: clear the "this frame" set
	_entityMeshesThisFrame.clear();

	// Dynamic lights are managed by R_RenderDlights - it updates intensity
	// each frame and removes expired lights from scene

	R_SetupFrame();

	R_SetFrustum();

	R_SetupGL();

	R_MarkLeaves(); // done here so we know if we're in water

	R_DrawWorld(); // adds static entities to the list

	S_ExtraUpdate(); // don't let sound get messed up if going slow

	R_DrawEntitiesOnList();

	// Remove entity meshes that were in the scene last frame but not this frame
	for ( const mesh of _entityMeshesInScene ) {

		if ( ! _entityMeshesThisFrame.has( mesh ) ) {

			if ( scene ) scene.remove( mesh );
			_entityMeshesInScene.delete( mesh );

		}

	}

	R_RenderDlights();

	R_DrawParticles();

}

//============================================================================
// R_RenderView
//
// r_refdef must be set before the first call
//============================================================================

export function R_RenderView() {

	let time1, time2;

	if ( r_norefresh.value )
		return;

	if ( ! r_worldentity.model || ( cl && ! cl.worldmodel ) )
		return; // worldmodel not loaded yet

	if ( r_speeds.value ) {

		time1 = Sys_FloatTime();
		c_brush_polys = 0;
		c_alias_polys = 0;

	}

	mirror = false;

	// glFinish blocks until the GPU is done; WebGL's finish() is the same call
	// (R_TimeRefresh_f uses it too). Only useful for timing, as in GLQuake.
	if ( gl_finish.value && renderer !== null )
		renderer.getContext().finish();

	R_Clear();

	// render normal view
	R_RenderScene();
	R_DrawViewModel();
	R_DrawWaterSurfaces();

	// render mirror view
	R_Mirror();

	// Present the frame via Three.js
	if ( renderer && scene && camera ) {

		// GL_BeginRendering and R_Clear have already cleared the canvas, so
		// the scene has no background, which would make render() clear it a
		// third time. In XR those clears don't reach the headset's eye
		// buffers, so the background does that.
		scene.background = isXRActive() ? _xrBackground : null;
		renderer.render( scene, camera );

	}

	R_MirrorCleanup();
	mirror = false;

	// Draw screen blend overlay AFTER main scene (damage flash, powerups, underwater tint)
	// Skip in XR mode — the 2D ortho overlay doesn't work with stereo rendering
	if ( isXRActive() === false ) {

		R_PolyBlend();

	} else if ( camera ) {

		// The 2D overlay quad, on top of the world and particles
		XR_RenderHUD( camera );

	}

	// Clean up water meshes AFTER rendering (they need to exist during render)
	R_CleanupWaterMeshes_rsurf();

	if ( r_speeds.value ) {

		time2 = Sys_FloatTime();
		Con_Printf( ( ( ( time2 - time1 ) * 1000 ) | 0 ) + ' ms  ' + c_brush_polys + ' wpoly ' + c_alias_polys + ' epoly' );

	}

}

//============================================================================
// R_Mirror
//
// The mirror texture is window02_1. It is used in start and e1m5
// (shareware) and e4m3 (registered). GLQuake reflects it only when r_mirroralpha is not 1
// (gl_rsurf.c DrawTextureChains), and r_mirroralpha defaults to 1, so with
// the default nothing here runs: DrawTextureChains never calls R_MirrorChain,
// `mirror` stays false and this returns at the first test.
//
// Otherwise the scene is rendered again from the reflected viewpoint into a
// render target and the mirror surface is redrawn mixing that image with its
// texture at r_mirroralpha (see gl_rmirror.js). Not done under WebXR.
//============================================================================

function R_Mirror() {

	if ( mirror === false )
		return;

	if ( renderer == null || scene == null || camera == null )
		return;

	if ( R_MirrorGate( r_mirroralpha.value, isXRActive() ) === false )
		return;

	const alpha = Math.max( 0, r_mirroralpha.value );
	_mirrorHide[ 0 ] = cl && cl.viewent ? cl.viewent._aliasMesh : null;

	// gl_rmain.c: the player is added to the entity list for the reflected
	// view (cl_visedicts[cl_numvisedicts++] = &cl_entities[cl.viewentity]).
	// Here its mesh joins the scene for the reflection pass only, unless the
	// chase camera has already drawn it this frame. It is drawn at the view
	// entity's origin, the server's (CL_LinkPlayers): with client prediction
	// the reflection trails the predicted camera by about one round trip.
	const ent = cl != null ? cl_entities[ cl.viewentity ] : null;
	let playerMesh = null;
	let shadowMesh = null;
	if ( r_drawentities.value && ent != null && ent.model != null && ent.model.type === mod_alias &&
		( ent._aliasMesh == null || _entityMeshesThisFrame.has( ent._aliasMesh ) === false ) ) {

		currententity = ent;
		R_DrawAliasModel( ent );
		playerMesh = ent._aliasMesh;
		shadowMesh = ent._aliasShadowMesh;

	}

	R_MirrorPass( renderer, scene, camera, mirror_plane, R_GetMirrorItems(), alpha, _mirrorHide );

	_mirrorHide[ 0 ] = null;
	_R_MirrorRemovePlayerMesh( playerMesh );
	_R_MirrorRemovePlayerMesh( shadowMesh );

}

const _mirrorHide = [ null ];

// Take a mesh R_Mirror drew for the reflection out of the main view.
function _R_MirrorRemovePlayerMesh( mesh ) {

	if ( mesh == null || _entityMeshesThisFrame.has( mesh ) === false )
		return;

	if ( mesh.parent !== null ) mesh.parent.remove( mesh );
	_entityMeshesInScene.delete( mesh );
	_entityMeshesThisFrame.delete( mesh );

}

//============================================================================
// R_Init
//
// Called at startup to initialize the renderer
//============================================================================

export function R_Init() {

	Con_Printf( 'R_Init' );

	// Initialize r_worldentity here (deferred from module scope to avoid circular dep crash)
	r_worldentity = new entity_t();

	// johnfitz -- lerping; QS registers these in gl_rmisc.c R_Init
	Cvar_RegisterVariable( r_lerpmodels );
	Cvar_RegisterVariable( r_lerpmove );
	Cvar_RegisterVariable( r_nolerp_list );
	// QuakeSpasm and Ironwail register this in gl_rmisc.c R_Init
	Cvar_RegisterVariable( gl_farclip );

	// create the Three.js scene
	scene = new THREE.Scene();

	// initialize light style values to default
	for ( let i = 0; i < 256; i ++ ) {

		d_lightstylevalue[ i ] = 264; // 'm' is normal light (char 109, 109-'a' = 12, 12*22 = 264)

	}

	R_InitParticles();
	R_SetParticleExternals( { scene: scene } );

	Con_Printf( 'R_Init: Three.js renderer ready' );

}

//============================================================================
// R_NewMap
//
// Called when a new map is loaded
//============================================================================

export function R_NewMap() {

	// clear old data
	r_viewleaf = null;
	r_oldviewleaf = null;
	const resetWorldEntity = new entity_t();
	if ( r_worldentity == null ) {

		r_worldentity = resetWorldEntity;

	} else {

		// WinQuake memsets one static entity, so preserve its published identity.
		for ( const key of Object.keys( r_worldentity ) )
			delete r_worldentity[ key ];
		Object.assign( r_worldentity, resetWorldEntity );

	}
	r_worldentity.model = cl != null ? cl.worldmodel : null;

	// reset framecount
	set_r_framecount( 1 );
	r_visframecount = 0;

	R_ClearParticles();

	// Clean up all cached entity resources from the previous map. Static
	// entities keep their JS identity across CL_ClearState, so invalidate the
	// owner-side caches as well as the scene tracking sets.
	const geometries = new Set();
	const materials = new Set();
	for ( const owner of _entityMeshCacheOwners )
		_clearEntityMeshCache( owner, geometries, materials );
	_entityMeshCacheOwners.clear();

	for ( let i = 0; i < cl_entities.length; i ++ )
		_clearEntityMeshCache( cl_entities[ i ], geometries, materials );
	for ( let i = 0; i < cl_static_entities.length; i ++ )
		_clearEntityMeshCache( cl_static_entities[ i ], geometries, materials );
	for ( let i = 0; i < cl_temp_entities.length; i ++ )
		_clearEntityMeshCache( cl_temp_entities[ i ], geometries, materials );
	if ( cl != null ) _clearEntityMeshCache( cl.viewent, geometries, materials );

	for ( const mesh of _entityMeshesInScene ) {

		if ( mesh.parent != null ) mesh.parent.remove( mesh );
		if ( mesh.geometry != null && geometries.has( mesh.geometry ) === false ) {

			geometries.add( mesh.geometry );
			mesh.geometry.dispose();

		}

	}

	_entityMeshesInScene.clear();
	_entityMeshesThisFrame.clear();
	for ( const cache of [ _spriteMaterialCache, _spriteDecalMaterialCache ] ) {

		for ( const material of cache.values() ) {

			if ( materials.has( material ) === false ) {

				materials.add( material );
				material.dispose();

			}

		}

		cache.clear();

	}

	// rebuild lightmaps
	GL_BuildLightmaps_rsurf();

}

//============================================================================
// Stub functions for external dependencies
// These will be connected to real implementations later
//============================================================================

function R_AnimateLight() {

	if ( cl ) R_AnimateLight_impl( cl, cl_lightstyle );

}

// Mod_PointInLeaf: imported from gl_model.js

function V_SetContentsColor( contents ) {

	V_SetContentsColor_view( contents );

}

function V_CalcBlend() {

	V_CalcBlend_view();

}

function R_MarkLeaves() {

	R_MarkLeaves_impl();

}

function R_DrawWorld() {

	R_DrawWorld_impl();

}

function R_DrawWaterSurfaces() {

	R_DrawWaterSurfaces_rsurf();

}

function S_ExtraUpdate() {

	// Sound system updates independently via S_Update() in the frame loop

}

function R_RenderDlights() {

	if ( cl != null ) {

		R_RenderDlights_impl( cl, scene );
		R_PadDlights( scene );

	}

}

/*
=============
R_PadDlights

Not in C. gl_flashblend draws dlights as PointLights (gl_rlight.js), and
Three.js compiles a new shader program for every lit material each time the
number of lights in the scene changes. Measured in Chrome on the start map:
each light count seen for the first time added about 7 programs and a
20-250 ms frame. Keeping all MAX_DLIGHTS lights in the scene avoids that but
makes every lit fragment loop over them: 64 zero-intensity lights took a
frame from about 3 ms to 12-18 ms (2048x1536, render plus a 1-pixel
readPixels). So pad the count with zero-intensity lights up to the next of
4, 8, 16, 32 or 64: at most five program sets per material, and the per-pixel
cost stays near what the frame actually uses.
=============
*/
const _dlightFillers = [];

export function R_CountRenderedDlights() {

	if ( gl_flashblend.value === 0 || cl == null )
		return 0;

	// Same test as R_RenderDlights in gl_rlight.js
	let count = 0;
	for ( let i = 0; i < MAX_DLIGHTS; i ++ ) {

		const l = cl_dlights[ i ];
		if ( l != null && l.die >= cl.time && l.radius > 0 && R_DlightDistance( l ) > 0 )
			count ++;

	}

	return count;

}

export function R_DlightBucket( count ) {

	if ( count === 0 ) return 0;
	let bucket = 4;
	while ( bucket < count ) bucket *= 2;
	return bucket;

}

export function R_PadDlights( targetScene ) {

	const active = R_CountRenderedDlights();
	const fillers = active === 0 ? 0 : R_DlightBucket( active ) - active;

	for ( let i = 0; i < fillers; i ++ ) {

		let light = _dlightFillers[ i ];
		if ( light === undefined ) {

			light = new THREE.PointLight( 0xffffff, 0, 1, 0 );
			_dlightFillers[ i ] = light;

		}

		if ( light.parent !== targetScene && targetScene !== null ) targetScene.add( light );

	}

	for ( let i = fillers; i < _dlightFillers.length; i ++ ) {

		const light = _dlightFillers[ i ];
		if ( light.parent !== null ) light.parent.remove( light );

	}

}

function R_DrawParticles() {

	R_DrawParticles_impl();

}
