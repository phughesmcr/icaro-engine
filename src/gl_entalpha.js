// Ported from: Ironwail gl_rmain.c / r_brush.c -- entity alpha for brush models
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
// Deviation: alias models and sprites ignore alpha. Ironwail blends them too,
// but no rerelease content relies on it.

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

function _alphaClone( base, alpha ) {

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
			const want = _alphaClone( from, alpha );
			if ( current !== want ) mesh.material = want;

		} else if ( base !== undefined ) {

			mesh.material = base;

		}

	}

	e._entalphaApplied = blended;

}
