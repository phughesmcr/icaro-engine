// Ported from: Ironwail gl_rmain.c / r_brush.c / r_alias.c -- entity alpha
//
// FitzQuake added an alpha field to entities (protocol.js ENTALPHA_*);
// Ironwail's R_DrawBrushModel draws an entity whose ENTALPHA_DECODE( alpha )
// is below 1 blended and without depth writes. The 2021 rerelease maps use it
// on func_illusionary, func_wall and similar brush entities.
//
// The port draws a brush entity as a cached THREE.Group whose meshes share
// materials from gl_rsurf.js's material cache. R_EntAlpha_Apply runs after
// gl_rsurf.js R_DrawBrushModel and swaps each mesh's material for a
// transparent clone keyed by (base material, alpha byte), and swaps the base
// back when the entity turns opaque again. gl_rsurf.js is left untouched.
//
// Alias models (Ironwail r_alias.c R_DrawAliasModel, ENTALPHA_DECODE into
// the instance alpha): R_EntAlpha_ApplyMesh swaps the one mesh's material
// the same way, after gl_mesh.js R_DrawAliasModel has set it. Ironwail
// draws a translucent alias model without depth writes and without back
// face culling (GLS_NO_ZWRITE, ~GLS_CULL_BACK), so those clones are double
// sided. The view model gets the alpha svc_clientdata's SU_WEAPONALPHA
// gives cl.viewent, and players the alpha svc_playerinfo's PF_ALPHA gives.
//
// Sprites ignore alpha, as in Ironwail: r_sprite.c draws every sprite in the
// opaque pass (GLS_BLEND_OPAQUE) whatever its alpha. Like every other entity,
// a sprite at ENTALPHA_ZERO is not drawn (gl_rmain.js R_DrawEntitiesOnList,
// as Ironwail's R_SortEntities drops it).

import * as THREE from 'three';
import { ENTALPHA_DEFAULT, ENTALPHA_ONE, ENTALPHA_DECODE } from './protocol.js';
import { GL_RegisterCullMaterial } from './glquake.js';

// base material -> Map( alpha byte -> transparent clone )
const _clonesByBase = new WeakMap();
// transparent clone -> base material
const _baseByClone = new WeakMap();

function _onBaseDispose( event ) {

	const base = event.target;
	base.removeEventListener( 'dispose', _onBaseDispose );
	const clones = _clonesByBase.get( base );
	if ( clones === undefined ) return;
	_clonesByBase.delete( base );
	for ( const clone of clones.values() )
		clone.dispose();

}

// double: Ironwail's translucent alias state drops GLS_CULL_BACK; brush
// clones keep gl_cull's side
function _alphaClone( base, alpha, double ) {

	let clones = _clonesByBase.get( base );
	if ( clones === undefined ) {

		clones = new Map();
		_clonesByBase.set( base, clones );
		base.addEventListener( 'dispose', _onBaseDispose );

	}

	let clone = clones.get( alpha );
	if ( clone === undefined ) {

		clone = base.clone();
		// Material.copy leaves out the shader patch hooks
		clone.onBeforeCompile = base.onBeforeCompile;
		clone.customProgramCacheKey = base.customProgramCacheKey;
		clone.transparent = true;
		clone.opacity = ENTALPHA_DECODE( alpha );
		clone.depthWrite = false; // Ironwail: glDepthMask( GL_FALSE )
		if ( double === true )
			clone.side = THREE.DoubleSide;
		else
			GL_RegisterCullMaterial( clone );
		clones.set( alpha, clone );
		_baseByClone.set( clone, base );

	}

	return clone;

}

/*
=================
R_EntAlpha_Apply

Called once per drawn brush entity, after gl_rsurf.js R_DrawBrushModel.
=================
*/
export function R_EntAlpha_Apply( e ) {

	const group = e._brushGroup;
	if ( group == null ) return;

	const alpha = e.alpha;
	const blended = alpha !== ENTALPHA_DEFAULT && alpha !== ENTALPHA_ONE;

	// opaque and never blended: nothing to do (the common case)
	if ( blended === false && e._entalphaApplied !== true ) return;

	const children = group.children;
	for ( let i = 0; i < children.length; i ++ ) {

		const mesh = children[ i ];
		const current = mesh.material;
		if ( current == null ) continue;
		const base = _baseByClone.get( current );

		if ( blended ) {

			const from = base !== undefined ? base : current;
			const want = _alphaClone( from, alpha, false );
			if ( current !== want ) mesh.material = want;

		} else if ( base !== undefined ) {

			mesh.material = base;

		}

	}

	e._entalphaApplied = blended;

}

// gl_mesh.js changes some alias materials in place: an entity's
// r_lerpmodels material (R_GetAliasLerpMaterial) takes the map, fullbright
// mask, alphaTest and vertexColors of whichever cached skin it follows. A
// clone made earlier would keep the old skin, so copy them across when they
// differ. The lerp blend is one shared uniform object (AliasMaterial.copy).
function _syncClone( clone, base ) {

	if ( clone.map === base.map && clone.alphaTest === base.alphaTest &&
		clone.vertexColors === base.vertexColors && clone.fullbrightMap === base.fullbrightMap )
		return;

	clone.map = base.map;
	clone.alphaTest = base.alphaTest;
	clone.vertexColors = base.vertexColors;
	if ( base.fullbrightMap !== undefined )
		clone.fullbrightMap = base.fullbrightMap;
	clone.needsUpdate = true; // the map, fullbright and vertex colour paths are compiled in

}

/*
=================
R_EntAlpha_ApplyMesh

Called once per drawn alias entity (the view model included), after
gl_mesh.js R_DrawAliasModel has set the mesh's material for this frame.
=================
*/
export function R_EntAlpha_ApplyMesh( e, mesh ) {

	const alpha = e.alpha;
	const blended = alpha !== ENTALPHA_DEFAULT && alpha !== ENTALPHA_ONE;

	// opaque and never blended: nothing to do (the common case)
	if ( blended === false && e._entalphaApplied !== true ) return;

	const current = mesh.material;
	if ( current == null ) return;
	const base = _baseByClone.get( current );

	if ( blended ) {

		const from = base !== undefined ? base : current;
		const want = _alphaClone( from, alpha, true );
		_syncClone( want, from );
		if ( current !== want ) mesh.material = want;

	} else if ( base !== undefined ) {

		mesh.material = base;

	}

	e._entalphaApplied = blended;

}

// True for a transparent clone made here (gl_rmain.js R_DrawViewModel uses
// it as is instead of cloning it again for the depth range hack).
export function R_EntAlpha_IsClone( material ) {

	return _baseByClone.has( material );

}
