// Ported from: WinQuake/gl_mesh.c -- triangle model functions (alias models)

import * as THREE from 'three';
import { Con_Printf, Con_DPrintf } from './common.js';
import { cl } from './client.js';
import { R_GetPlayerSkinTexture } from './gl_rmisc.js';
import { gl_nocolors, gl_doubleeyes, GL_RegisterCullMaterial } from './glquake.js';
import { r_avertexnormals } from './anorm_dots.js';
import { VectorCopy, VectorCompare } from './mathlib.js';
import { r_lerpmodels, r_lerpmove, r_nolerp_list,
	LERP_MOVESTEP, LERP_RESETANIM, LERP_RESETANIM2, LERP_RESETMOVE, LERP_FINISH } from './render.js';
import { MOD_NOLERP, MF_HOLEY, Mod_SetExtraFlags } from './gl_model.js';

/*
=================================================================

ALIAS MODEL DISPLAY LIST GENERATION

=================================================================
*/

let paliashdr = null; // aliashdr_t *

// Copy of gl_model.js MAXALIASTRIS: gl_model.js imports this module, so it
// can't be imported here at load time. Keep the two equal.
export const MAXALIASTRIS = 4096;

// Deliberate deviation (QuakeSpasm): the buffers below are sized from
// MAXALIASTRIS. GLQuake's fixed 8192 commands and 128-long strips overflow
// for big models (one strip per triangle takes 7 commands each), and a typed
// array drops the writes past its end.
const used = new Uint8Array( MAXALIASTRIS );

// the command list holds counts and s/t values that are valid for
// every frame
const commands = new Int32Array( MAXALIASTRIS * 7 + 1 );
let numcommands = 0;

// all frames will have their vertexes rearranged and expanded
// so they are in the order expected by the command list
const vertexorder = new Int32Array( MAXALIASTRIS * 3 );
let numorder = 0;

let allverts = 0;
let alltris = 0;

const stripverts = new Int32Array( MAXALIASTRIS + 2 );
const striptris = new Int32Array( MAXALIASTRIS );
let stripcount = 0;

// References to model data set during BuildTris
let triangles = null; // mtriangle_t[]
let stverts = null; // stvert_t[]
let pheader = null; // aliashdr_t (same as paliashdr)
let poseverts = null; // trivertx_t[][]

// r_avertexnormals is imported from anorm_dots.js to avoid circular dependency

/*
================
StripLength
================
*/
function StripLength( starttri, startv ) {

	used[ starttri ] = 2;

	const last = triangles[ starttri ];

	stripverts[ 0 ] = last.vertindex[ ( startv ) % 3 ];
	stripverts[ 1 ] = last.vertindex[ ( startv + 1 ) % 3 ];
	stripverts[ 2 ] = last.vertindex[ ( startv + 2 ) % 3 ];

	striptris[ 0 ] = starttri;
	stripcount = 1;

	let m1 = last.vertindex[ ( startv + 2 ) % 3 ];
	let m2 = last.vertindex[ ( startv + 1 ) % 3 ];

	// look for a matching triangle
	let found = true;
	while ( found ) {

		found = false;
		search: for ( let j = starttri + 1; j < pheader.numtris; j ++ ) {

			const check = triangles[ j ];

			if ( check.facesfront !== last.facesfront )
				continue;
			for ( let k = 0; k < 3; k ++ ) {

				if ( check.vertindex[ k ] !== m1 )
					continue;
				if ( check.vertindex[ ( k + 1 ) % 3 ] !== m2 )
					continue;

				// this is the next part of the fan

				// if we can't use this triangle, this tristrip is done
				// (C: goto done, which leaves the j loop too)
				if ( used[ j ] )
					break search;

				// the new edge
				if ( stripcount & 1 )
					m2 = check.vertindex[ ( k + 2 ) % 3 ];
				else
					m1 = check.vertindex[ ( k + 2 ) % 3 ];

				stripverts[ stripcount + 2 ] = check.vertindex[ ( k + 2 ) % 3 ];
				striptris[ stripcount ] = j;
				stripcount ++;

				used[ j ] = 2;
				found = true;
				break;

			}

			if ( found ) break;

		}

	}

	// clear the temp used flags
	for ( let j = starttri + 1; j < pheader.numtris; j ++ )
		if ( used[ j ] === 2 )
			used[ j ] = 0;

	return stripcount;

}

/*
===========
FanLength
===========
*/
function FanLength( starttri, startv ) {

	used[ starttri ] = 2;

	const last = triangles[ starttri ];

	stripverts[ 0 ] = last.vertindex[ ( startv ) % 3 ];
	stripverts[ 1 ] = last.vertindex[ ( startv + 1 ) % 3 ];
	stripverts[ 2 ] = last.vertindex[ ( startv + 2 ) % 3 ];

	striptris[ 0 ] = starttri;
	stripcount = 1;

	const m1 = last.vertindex[ ( startv + 0 ) % 3 ];
	let m2 = last.vertindex[ ( startv + 2 ) % 3 ];

	// look for a matching triangle
	let found = true;
	while ( found ) {

		found = false;
		search: for ( let j = starttri + 1; j < pheader.numtris; j ++ ) {

			const check = triangles[ j ];

			if ( check.facesfront !== last.facesfront )
				continue;
			for ( let k = 0; k < 3; k ++ ) {

				if ( check.vertindex[ k ] !== m1 )
					continue;
				if ( check.vertindex[ ( k + 1 ) % 3 ] !== m2 )
					continue;

				// this is the next part of the fan

				// if we can't use this triangle, this tristrip is done
				// (C: goto done, which leaves the j loop too)
				if ( used[ j ] )
					break search;

				// the new edge
				m2 = check.vertindex[ ( k + 2 ) % 3 ];

				stripverts[ stripcount + 2 ] = m2;
				striptris[ stripcount ] = j;
				stripcount ++;

				used[ j ] = 2;
				found = true;
				break;

			}

			if ( found ) break;

		}

	}

	// clear the temp used flags
	for ( let j = starttri + 1; j < pheader.numtris; j ++ )
		if ( used[ j ] === 2 )
			used[ j ] = 0;

	return stripcount;

}

/*
================
BuildTris

Generate a list of trifans or strips
for the model, which holds for all frames
================
*/
export function BuildTris() {

	const bestverts = new Int32Array( MAXALIASTRIS + 2 );
	const besttris = new Int32Array( MAXALIASTRIS );

	//
	// build tristrips
	//
	numorder = 0;
	numcommands = 0;
	used.fill( 0 );

	for ( let i = 0; i < pheader.numtris; i ++ ) {

		// pick an unused triangle and start the trifan
		if ( used[ i ] )
			continue;

		let bestlen = 0;
		let besttype = 0;

		for ( let type = 0; type < 2; type ++ ) {

			for ( let startv = 0; startv < 3; startv ++ ) {

				let len;
				if ( type === 1 )
					len = StripLength( i, startv );
				else
					len = FanLength( i, startv );
				if ( len > bestlen ) {

					besttype = type;
					bestlen = len;
					for ( let j = 0; j < bestlen + 2; j ++ )
						bestverts[ j ] = stripverts[ j ];
					for ( let j = 0; j < bestlen; j ++ )
						besttris[ j ] = striptris[ j ];

				}

			}

		}

		// mark the tris on the best strip as used
		for ( let j = 0; j < bestlen; j ++ )
			used[ besttris[ j ] ] = 1;

		if ( besttype === 1 )
			commands[ numcommands ++ ] = ( bestlen + 2 );
		else
			commands[ numcommands ++ ] = - ( bestlen + 2 );

		for ( let j = 0; j < bestlen + 2; j ++ ) {

			// emit a vertex into the reorder buffer
			const k = bestverts[ j ];
			vertexorder[ numorder ++ ] = k;

			// emit s/t coords into the commands stream
			let s = stverts[ k ].s;
			let t = stverts[ k ].t;
			if ( ! triangles[ besttris[ 0 ] ].facesfront && stverts[ k ].onseam )
				s += ( pheader.skinwidth / 2 ) | 0; // on back side (C int division)
			s = ( s + 0.5 ) / pheader.skinwidth;
			t = ( t + 0.5 ) / pheader.skinheight;

			// Store float as int bits (mimicking *(float *)&commands)
			const floatBuf = new Float32Array( 1 );
			floatBuf[ 0 ] = s;
			const intView = new Int32Array( floatBuf.buffer );
			commands[ numcommands ++ ] = intView[ 0 ];
			floatBuf[ 0 ] = t;
			commands[ numcommands ++ ] = intView[ 0 ];

		}

	}

	commands[ numcommands ++ ] = 0; // end of list marker

	Con_DPrintf( '%d tri %d vert %d cmd\n', pheader.numtris, numorder, numcommands );

	allverts += numorder;
	alltris += pheader.numtris;

}

/*
================
GL_MakeAliasModelDisplayLists

In Three.js, we build a BufferGeometry from the alias model vertex/triangle data.
The original code generates GL command lists (triangle strips/fans);
we instead build indexed triangle geometry.
================
*/
export function GL_MakeAliasModelDisplayLists( m, hdr ) {

	paliashdr = hdr;
	pheader = hdr;
	triangles = hdr.triangles;
	stverts = hdr.stverts;
	poseverts = hdr.poseverts;

	// Build command lists from scratch
	Con_Printf( 'meshing %s...\n', m.name );
	BuildTris();

	// save the data out
	paliashdr.poseverts_count = numorder;

	// Copy commands
	paliashdr.commands = new Int32Array( numcommands );
	paliashdr.commands.set( commands.subarray( 0, numcommands ) );

	// Copy reordered pose vertices
	paliashdr.posedata = [];
	for ( let i = 0; i < paliashdr.numposes; i ++ ) {

		const frameVerts = [];
		for ( let j = 0; j < numorder; j ++ ) {

			frameVerts.push( poseverts[ i ][ vertexorder[ j ] ] );

		}

		paliashdr.posedata.push( frameVerts );

	}

	GL_AliasCullSphere( paliashdr );

}

/*
================
GL_AliasCullSphere

Not in the C: GL draws every alias model it is given and lets the hardware
clip it. Three.js frustum-culls a mesh by its geometry's bounding sphere,
which it computes once from the first pose it sees, so a later pose that
reaches outside it (an arm swing, a death fall) could be culled at the
screen edge. Work out one sphere, in model space, that holds every vertex
of every pose; R_DrawAliasModel gives it to the entity's geometry.
================
*/
function GL_AliasCullSphere( hdr ) {

	const scale = hdr.scale;
	const origin = hdr.scale_origin;
	let minx = Infinity, miny = Infinity, minz = Infinity;
	let maxx = - Infinity, maxy = - Infinity, maxz = - Infinity;

	for ( let i = 0; i < hdr.posedata.length; i ++ ) {

		const verts = hdr.posedata[ i ];
		for ( let j = 0; j < verts.length; j ++ ) {

			// GL_DrawAliasFrame places a missing vertex at the model origin
			const vert = verts[ j ];
			const x = vert != null ? vert.v[ 0 ] * scale[ 0 ] + origin[ 0 ] : 0;
			const y = vert != null ? vert.v[ 1 ] * scale[ 1 ] + origin[ 1 ] : 0;
			const z = vert != null ? vert.v[ 2 ] * scale[ 2 ] + origin[ 2 ] : 0;
			if ( x < minx ) minx = x;
			if ( x > maxx ) maxx = x;
			if ( y < miny ) miny = y;
			if ( y > maxy ) maxy = y;
			if ( z < minz ) minz = z;
			if ( z > maxz ) maxz = z;

		}

	}

	if ( minx > maxx ) {

		// no vertices: an empty sphere at the model origin
		hdr._cullCenter = [ 0, 0, 0 ];
		hdr._cullRadius = 0;
		return;

	}

	const cx = ( minx + maxx ) * 0.5;
	const cy = ( miny + maxy ) * 0.5;
	const cz = ( minz + maxz ) * 0.5;
	let radiusSq = 0;

	for ( let i = 0; i < hdr.posedata.length; i ++ ) {

		const verts = hdr.posedata[ i ];
		for ( let j = 0; j < verts.length; j ++ ) {

			const vert = verts[ j ];
			const dx = ( vert != null ? vert.v[ 0 ] * scale[ 0 ] + origin[ 0 ] : 0 ) - cx;
			const dy = ( vert != null ? vert.v[ 1 ] * scale[ 1 ] + origin[ 1 ] : 0 ) - cy;
			const dz = ( vert != null ? vert.v[ 2 ] * scale[ 2 ] + origin[ 2 ] : 0 ) - cz;
			const d = dx * dx + dy * dy + dz * dz;
			if ( d > radiusSq ) radiusSq = d;

		}

	}

	hdr._cullCenter = [ cx, cy, cz ];
	hdr._cullRadius = Math.sqrt( radiusSq );

}

/*
================
GL_DrawAliasFrame

Build a Three.js BufferGeometry from a single pose of an alias model.
Uses the command list to reconstruct triangle strips/fans into indexed triangles.

Caches geometry template (positions, UVs, indices, normals, lightnormalindices)
per (paliashdr, posenum) to avoid recomputation every frame. Vertex colors
are updated in place from a pre-allocated buffer.
================
*/

// Shared buffers for int-to-float bit casting
const _castIntBuf = new Int32Array( 1 );
const _castFloatView = new Float32Array( _castIntBuf.buffer );

export function GL_DrawAliasFrame( paliashdr, posenum ) {

	const verts = paliashdr.posedata[ posenum ];
	if ( ! verts ) return null;

	// Check geometry template cache
	if ( ! paliashdr._geoCache ) paliashdr._geoCache = new Map();

	let cached = paliashdr._geoCache.get( posenum );

	if ( cached == null ) {

		// Build geometry template for this pose (done once, cached)
		const cmds = paliashdr.commands;
		const positions = [];
		const normals = [];
		const uvs = [];
		const indices = [];
		const lightnormalindices = [];

		let cmdIndex = 0;
		let vertexCount = 0;

		while ( true ) {

			let count = cmds[ cmdIndex ++ ];
			if ( count === 0 )
				break;

			const isStrip = count > 0;
			if ( count < 0 )
				count = - count;

			const firstVertex = vertexCount;

			// Read all vertices for this strip/fan
			for ( let i = 0; i < count; i ++ ) {

				// Read s/t from command stream (stored as int bits of float)
				_castIntBuf[ 0 ] = cmds[ cmdIndex ++ ];
				const s = _castFloatView[ 0 ];
				_castIntBuf[ 0 ] = cmds[ cmdIndex ++ ];
				const t = _castFloatView[ 0 ];

				const vert = verts[ vertexCount - firstVertex + firstVertex ];
				if ( vert ) {

					const x = vert.v[ 0 ] * paliashdr.scale[ 0 ] + paliashdr.scale_origin[ 0 ];
					const y = vert.v[ 1 ] * paliashdr.scale[ 1 ] + paliashdr.scale_origin[ 1 ];
					const z = vert.v[ 2 ] * paliashdr.scale[ 2 ] + paliashdr.scale_origin[ 2 ];

					positions.push( x, y, z );
					uvs.push( s, t );
					lightnormalindices.push( vert.lightnormalindex );

					// Look up pre-baked normal from MDL file's normal table
					const normalIndex = vert.lightnormalindex;
					const n = r_avertexnormals[ normalIndex ] || r_avertexnormals[ 0 ];
					normals.push( n[ 0 ], n[ 1 ], n[ 2 ] );

				} else {

					positions.push( 0, 0, 0 );
					uvs.push( s, t );
					lightnormalindices.push( 0 );
					normals.push( 0, 0, 1 ); // Default normal

				}

				vertexCount ++;

			}

			// Generate triangle indices from strip or fan (inverted winding for correct backface culling)
			if ( isStrip ) {

				for ( let i = 2; i < count; i ++ ) {

					if ( i & 1 ) {

						indices.push( firstVertex + i - 1, firstVertex + i, firstVertex + i - 2 );

					} else {

						indices.push( firstVertex + i - 2, firstVertex + i, firstVertex + i - 1 );

					}

				}

			} else {

				for ( let i = 2; i < count; i ++ ) {

					indices.push( firstVertex, firstVertex + i, firstVertex + i - 1 );

				}

			}

		}

		// Build shared BufferAttributes for the template (no color — color is per-entity)
		const posAttr = new THREE.BufferAttribute( new Float32Array( positions ), 3 );
		const normalAttr = new THREE.BufferAttribute( new Float32Array( normals ), 3 );
		const uvAttr = new THREE.BufferAttribute( new Float32Array( uvs ), 2 );

		cached = {
			posAttr,
			normalAttr,
			uvAttr,
			indices,
			lightnormalindices,
			vertexCount
		};
		paliashdr._geoCache.set( posenum, cached );

	}

	return cached;

}

/*
================
GL_ClearAliasCache

Clears all cached alias model geometries. Called on map change.
================
*/
export function GL_ClearAliasCache() {

	// Caches are stored on paliashdr objects which are replaced on map load,
	// so they are garbage collected automatically. This function exists
	// as a hook if explicit cleanup is ever needed.

}

/*
=================
lerpdata_t

FitzQuake/QuakeSpasm (r_alias.c): what R_SetupAliasFrame and
R_SetupEntityTransform work out for one draw of one entity.
=================
*/
export class lerpdata_t {

	constructor() {

		this.pose1 = 0;
		this.pose2 = 0;
		this.blend = 0;
		this.origin = new Float32Array( 3 );
		this.angles = new Float32Array( 3 );

	}

}

// The lerpdata of the entity R_DrawAliasModel drew last; gl_rmain.js hands
// it to GL_DrawAliasShadow for the same entity (QS passes it on the stack).
export const alias_lerpdata = new lerpdata_t();

function CLAMP( min, x, max ) {

	return x < min ? min : ( x > max ? max : x );

}

/*
=================
R_SetupAliasFrame -- johnfitz -- rewritten to support lerping

Ported from: QuakeSpasm r_alias.c. Deliberate deviation for r_lerpmodels
(id's R_SetupAliasFrame picks one pose and draws it): blend from the
previous pose to the new one over the frame's interval, 0.1 s for a
single-pose frame. With r_lerpmodels 0, pose1 = pose2 = id's pose.
QS takes currententity; this takes the entity as its first argument.
=================
*/
export function R_SetupAliasFrame( e, paliashdr, frame, lerpdata ) {

	const time = cl != null ? cl.time : 0;

	if ( frame >= paliashdr.numframes || frame < 0 ) {

		Con_DPrintf( 'R_AliasSetupFrame: no such frame ' + frame + ' for \'' + ( e.model != null ? e.model.name : '' ) + '\'\n' );
		frame = 0;

	}

	let posenum;
	let numposes;
	const frameInfo = paliashdr.frames != null ? paliashdr.frames[ frame ] : undefined;
	if ( frameInfo != null ) {

		posenum = frameInfo.firstpose;
		numposes = frameInfo.numposes;

	} else {

		posenum = frame;
		numposes = 1;

	}

	if ( numposes > 1 ) {

		e.lerptime = frameInfo.interval;
		posenum += ( ( time / e.lerptime ) | 0 ) % numposes;

	} else
		e.lerptime = 0.1;

	if ( posenum >= paliashdr.numposes )
		posenum = 0;

	// Not in QS: something that sets e.model directly (view.js, cl_tent.js)
	// doesn't set LERP_RESETANIM, and the stored poses would index the old
	// model. Don't lerp across a model change, as QS's model-change sites do.
	if ( e._lerphdr !== paliashdr ) {

		e._lerphdr = paliashdr;
		e.lerpflags |= LERP_RESETANIM;

	}

	if ( ( e.lerpflags & LERP_RESETANIM ) !== 0 ) {

		//kill any lerp in progress
		e.lerpstart = 0;
		e.previouspose = posenum;
		e.currentpose = posenum;
		e.lerpflags &= ~ LERP_RESETANIM;

	} else if ( e.currentpose !== posenum ) {

		// pose changed, start new lerp
		if ( ( e.lerpflags & LERP_RESETANIM2 ) !== 0 ) {

			//defer lerping one more time
			e.lerpstart = 0;
			e.previouspose = posenum;
			e.currentpose = posenum;
			e.lerpflags &= ~ LERP_RESETANIM2;

		} else {

			e.lerpstart = time;
			e.previouspose = e.currentpose;
			e.currentpose = posenum;

		}

	}

	// QS sets MOD_NOLERP from a cvar callback when r_nolerp_list changes
	if ( e.model.extraflags_list !== r_nolerp_list.string )
		Mod_SetExtraFlags( e.model );

	//set up values
	if ( r_lerpmodels.value !== 0 && ! ( ( e.model.flags & MOD_NOLERP ) !== 0 && r_lerpmodels.value !== 2 ) ) {

		if ( ( e.lerpflags & LERP_FINISH ) !== 0 && numposes === 1 )
			lerpdata.blend = CLAMP( 0.0, ( time - e.lerpstart ) / ( e.lerpfinish - e.lerpstart ), 1.0 );
		else
			lerpdata.blend = CLAMP( 0.0, ( time - e.lerpstart ) / e.lerptime, 1.0 );
		if ( lerpdata.blend === 1.0 )
			e.previouspose = e.currentpose;
		lerpdata.pose1 = e.previouspose;
		lerpdata.pose2 = e.currentpose;

	} else {

		//don't lerp
		lerpdata.blend = 1;
		lerpdata.pose1 = posenum;
		lerpdata.pose2 = posenum;

	}

}

/*
=================
R_SetupEntityTransform -- johnfitz -- set up transform part of lerpdata

Ported from: QuakeSpasm r_alias.c. Deliberate deviation for r_lerpmove:
a MOVETYPE_STEP entity (LERP_MOVESTEP) slides from its last position to
the new one over 0.1 s instead of jumping at each think. The client
receives no lerpfinish (no U_LERPFINISH), so LERP_FINISH is never set
and QS's 0.1 s fallback applies.
=================
*/
export function R_SetupEntityTransform( e, lerpdata ) {

	// if LERP_RESETMOVE, kill any lerps in progress
	if ( ( e.lerpflags & LERP_RESETMOVE ) !== 0 ) {

		e.movelerpstart = 0;
		VectorCopy( e.origin, e.previousorigin );
		VectorCopy( e.origin, e.currentorigin );
		VectorCopy( e.angles, e.previousangles );
		VectorCopy( e.angles, e.currentangles );
		e.lerpflags &= ~ LERP_RESETMOVE;

	} else if ( ! VectorCompare( e.origin, e.currentorigin ) || ! VectorCompare( e.angles, e.currentangles ) ) {

		// origin/angles changed, start new lerp
		e.movelerpstart = cl != null ? cl.time : 0;
		VectorCopy( e.currentorigin, e.previousorigin );
		VectorCopy( e.origin, e.currentorigin );
		VectorCopy( e.currentangles, e.previousangles );
		VectorCopy( e.angles, e.currentangles );

	}

	//set up values
	if ( r_lerpmove.value !== 0 && ( cl == null || e !== cl.viewent ) && ( e.lerpflags & LERP_MOVESTEP ) !== 0 ) {

		const time = cl != null ? cl.time : 0;
		let blend;
		if ( ( e.lerpflags & LERP_FINISH ) !== 0 )
			blend = CLAMP( 0.0, ( time - e.movelerpstart ) / ( e.lerpfinish - e.movelerpstart ), 1.0 );
		else
			blend = CLAMP( 0.0, ( time - e.movelerpstart ) / 0.1, 1.0 );

		//translation
		for ( let i = 0; i < 3; i ++ )
			lerpdata.origin[ i ] = e.previousorigin[ i ] + ( e.currentorigin[ i ] - e.previousorigin[ i ] ) * blend;

		//rotation
		for ( let i = 0; i < 3; i ++ ) {

			let d = e.currentangles[ i ] - e.previousangles[ i ];
			if ( d > 180 ) d -= 360;
			if ( d < - 180 ) d += 360;
			lerpdata.angles[ i ] = e.previousangles[ i ] + d * blend;

		}

	} else {

		//don't lerp
		VectorCopy( e.origin, lerpdata.origin );
		VectorCopy( e.angles, lerpdata.angles );

	}

}

/*
=================
AliasMaterial

Not in the C. QuakeSpasm draws an alias model's fullbright pixels in a
second pass that ignores the light; here the fragment shader does it.
fullbrightMap is the skin's fullbright mask (GL_LoadTexture's
_fullbright): alpha 1 on fullbright pixels, which then show the skin (map)
colour unlit. Only the mask's alpha is read: its colour is black off the
fullbright pixels and would darken the filtered edges. The hooks live on the class, not the instance, so a clone (the view
model's depth-hack copy in gl_rmain.js) keeps them; copy() carries the map
and the r_lerpmodels blend.
=================
*/
export class AliasMaterial extends THREE.MeshBasicMaterial {

	constructor( parameters ) {

		super( parameters );
		// one uniform object per material, so a new fullbrightMap reaches
		// the compiled program without a recompile
		this._fullbrightUniform = { value: null };
		this._lerpblend = null;	// { value } when r_lerpmodels blends poses

	}

	get fullbrightMap() {

		return this._fullbrightUniform.value;

	}

	set fullbrightMap( texture ) {

		this._fullbrightUniform.value = texture;

	}

	onBeforeCompile( shader ) {

		if ( this._lerpblend !== null ) {

			// r_lerpmodels: see R_GetAliasLerpMaterial
			shader.uniforms.r_lerpblend = this._lerpblend;
			shader.vertexShader = 'attribute vec3 pose1;\nuniform float r_lerpblend;\n' +
				shader.vertexShader.replace( '#include <begin_vertex>',
					'#include <begin_vertex>\n\ttransformed = mix( pose1, position, r_lerpblend );' );

		}

		if ( this.fullbrightMap !== null && this.map !== null ) {

			shader.uniforms.fullbrightMap = this._fullbrightUniform;
			shader.fragmentShader = 'uniform sampler2D fullbrightMap;\n' +
				shader.fragmentShader.replace( '#include <opaque_fragment>',
					'outgoingLight = mix( outgoingLight, texture2D( map, vMapUv ).rgb,\n' +
					'\t\ttexture2D( fullbrightMap, vMapUv ).a );\n' +
					'\t#include <opaque_fragment>' );

		}

	}

	customProgramCacheKey() {

		return 'alias' + ( this._lerpblend !== null ? '-lerp' : '' ) +
			( this.fullbrightMap !== null && this.map !== null ? '-fullbright' : '' );

	}

	copy( source ) {

		super.copy( source );
		this.fullbrightMap = source.fullbrightMap;
		this._lerpblend = source._lerpblend;
		return this;

	}

}

// MF_HOLEY skins: Ironwail's alias shader discards texels with alpha
// below 0.666 (QuakeSpasm: glAlphaFunc GL_GREATER 0.666)
const HOLEY_ALPHATEST = 0.666;

function _skinAlphaTest( entity ) {

	return entity !== null && entity.model !== null && ( entity.model.flags & MF_HOLEY ) !== 0
		? HOLEY_ALPHATEST : 0;

}

// A skin's fullbright mask, or null. Unloaded gl_texturenum slots hold 0.
function _skinFullbright( texture ) {

	if ( texture === null || texture === 0 || texture._fullbright === undefined ) return null;
	return texture._fullbright;

}

// The skin texture for an entity's skinnum and animation frame. Unloaded
// gl_texturenum slots hold 0 (as in the C), hence the falsy fallbacks.
function R_GetAliasSkinTexture( paliashdr, entity, anim ) {

	if ( ! paliashdr.gl_texturenum ) return null;
	const skinnum = entity && entity.skinnum ? entity.skinnum : 0;
	const skinGroup = paliashdr.gl_texturenum[ skinnum ] || paliashdr.gl_texturenum[ 0 ];
	if ( ! skinGroup ) return null;
	// Select animated frame if skin group is an array
	return Array.isArray( skinGroup ) ? ( skinGroup[ anim ] || skinGroup[ 0 ] ) : skinGroup;

}

/*
=================
R_GetAliasMaterial

Get or create a cached material for the given alias model skin.
Materials are cached per (paliashdr, skinnum, hasLighting) to avoid
per-frame material creation and shader compilation.
=================
*/
export function R_GetAliasMaterial( paliashdr, entity, hasLighting, playerSkinTexture ) {

	// Player skin textures are per-entity, not cached on the model
	if ( playerSkinTexture != null ) {

		// Cache the player material on the entity to avoid per-frame creation
		if ( entity._playerMaterial == null || entity._playerSkinTexture !== playerSkinTexture ) {

			if ( entity._playerMaterial != null ) {

				entity._playerMaterial.dispose();

			}

			entity._playerMaterial = GL_RegisterCullMaterial( new AliasMaterial( {
				map: playerSkinTexture,
				vertexColors: hasLighting
			} ) );
			// the translated skin has the model skin's layout, so its
			// fullbright mask lines up
			entity._playerMaterial.fullbrightMap = _skinFullbright( R_GetAliasSkinTexture( paliashdr, entity, 0 ) );
			// MF_HOLEY isn't applied here: R_TranslatePlayerSkin (gl_rmisc.js)
			// builds the translated skin fully opaque
			entity._playerSkinTexture = playerSkinTexture;

		}

		return entity._playerMaterial;

	}

	if ( ! paliashdr._materialCache ) paliashdr._materialCache = new Map();

	const skinnum = entity && entity.skinnum ? entity.skinnum : 0;

	// Animated skins cycle through frames 0-3 every 0.1 seconds
	// Original: anim = (int)(cl.time*10) & 3
	const anim = cl && cl.time ? ( Math.floor( cl.time * 10 ) & 3 ) : 0;

	// Cache key includes animation frame for animated skins
	const cacheKey = skinnum * 8 + anim * 2 + ( hasLighting ? 1 : 0 );

	let material = paliashdr._materialCache.get( cacheKey );
	if ( material ) return material;

	const texture = R_GetAliasSkinTexture( paliashdr, entity, anim );

	if ( texture ) {

		material = new AliasMaterial( {
			map: texture,
			vertexColors: hasLighting
		} );
		material.fullbrightMap = _skinFullbright( texture );
		material.alphaTest = _skinAlphaTest( entity );

	} else {

		material = new AliasMaterial( {
			color: 0xcccccc,
			vertexColors: hasLighting
		} );

	}

	GL_RegisterCullMaterial( material );
	paliashdr._materialCache.set( cacheKey, material );
	return material;

}

/*
=================
R_GetAliasLerpMaterial

Not in the C. For r_lerpmodels, GL_DrawAliasFrame (QS r_alias.c) blends
two poses per vertex; here the vertex shader does it: the geometry carries
the previous pose as a second attribute, pose1, next to position (pose2),
and a uniform holds the blend. Three uploads a material's uniforms only
when the material changes between draws, so two entities sharing one
cached material would draw with one blend: each entity gets its own
material, kept in step with the cached one R_GetAliasMaterial picked.
With r_lerpmodels 0 the cached materials are used, as before.
=================
*/
export function R_GetAliasLerpMaterial( entity, base, blend ) {

	let material = entity._aliasLerpMaterial;
	if ( material == null ) {

		// AliasMaterial.onBeforeCompile adds the blend; every lerp material
		// shares one program per fullbright on/off (customProgramCacheKey)
		material = GL_RegisterCullMaterial( new AliasMaterial() );
		material._lerpblend = { value: 1 };
		material._lerpbase = null;
		entity._aliasLerpMaterial = material;

	}

	if ( material._lerpbase !== base ) {

		// map on/off, the fullbright pass and vertexColors are compiled into
		// the program
		if ( ( material.map === null ) !== ( base.map === null ) ||
			( material.fullbrightMap === null ) !== ( base.fullbrightMap === null ) ||
			material.vertexColors !== base.vertexColors )
			material.needsUpdate = true;
		material.map = base.map;
		material.fullbrightMap = base.fullbrightMap;
		material.alphaTest = base.alphaTest;	// Three recompiles when it turns on or off
		material.color.copy( base.color );
		material.vertexColors = base.vertexColors;
		material._lerpbase = base;

	}

	material._lerpblend.value = blend;
	return material;

}

// Reusable matrix objects for R_DrawAliasModel transform computation
const _aliasMat = new THREE.Matrix4();
const _aliasRZ = new THREE.Matrix4();
const _aliasRY = new THREE.Matrix4();
const _aliasRX = new THREE.Matrix4();
const _eyesOffset = new THREE.Vector3();
const _DEG2RAD = Math.PI / 180;

/*
=================
R_DrawAliasModel

Builds and returns a Three.js Mesh for the given alias model entity.
Caches geometry per (model, pose), materials per (model, skin),
and reuses mesh objects per entity to minimize per-frame allocations.
=================
*/
// sRGB decode of a display-space light level, clamped as glColor3f clamps.
// GL keeps vertex colours at 8 bits per channel, so a 256-entry table is
// exact enough and keeps Math.pow out of the per-vertex loop.
const _linearLight = new Float32Array( 256 );
for ( let i = 0; i < 256; i ++ ) {

	const l = i / 255;
	_linearLight[ i ] = l <= 0.04045 ? l / 12.92 : Math.pow( ( l + 0.055 ) / 1.055, 2.4 );

}

export function GL_LinearLight( l ) {

	if ( ! ( l > 0 ) ) return 0;
	if ( l >= 1 ) return 1;
	return _linearLight[ ( l * 255 + 0.5 ) | 0 ];

}

export function R_DrawAliasModel( entity, paliashdr, shadedots, shadelight ) {

	if ( ! paliashdr || ! paliashdr.posedata )
		return null;

	const lerpdata = alias_lerpdata;
	R_SetupAliasFrame( entity, paliashdr, entity.frame, lerpdata );
	R_SetupEntityTransform( entity, lerpdata );
	const posenum = lerpdata.pose2;
	const pose1 = lerpdata.pose1;
	const hasLighting = shadedots && shadelight !== undefined;

	// Get cached template (shared positions/normals/uvs/indices per model+pose)
	const template = GL_DrawAliasFrame( paliashdr, posenum );
	if ( ! template )
		return null;
	// the pose r_lerpmodels blends from; the same template when not lerping
	const template1 = pose1 === posenum ? template : GL_DrawAliasFrame( paliashdr, pose1 );
	if ( ! template1 )
		return null;

	// Build or update per-entity geometry (shares template attributes, owns color buffer)
	let geometry = entity ? entity._aliasGeo : null;
	if ( geometry == null ) {

		geometry = new THREE.BufferGeometry();
		// Allocate per-entity color buffer (will be resized if needed)
		entity._aliasColorArray = new Float32Array( template.vertexCount * 3 );
		geometry.setAttribute( 'color', new THREE.BufferAttribute( entity._aliasColorArray, 3 ) );
		if ( entity != null ) entity._aliasGeo = geometry;

	}

	// When pose or model changes, swap to the new template's shared attributes
	if ( entity._aliasPosenum !== posenum || entity._aliasPose1 !== pose1 || entity._aliasPaliashdr !== paliashdr ) {

		// Cull by a sphere that holds every pose (GL_AliasCullSphere), not
		// the one Three would compute from whichever pose came first. A
		// blend of two poses stays inside it too.
		if ( entity._aliasPaliashdr !== paliashdr && paliashdr._cullCenter !== undefined ) {

			if ( geometry.boundingSphere === null )
				geometry.boundingSphere = new THREE.Sphere();
			const c = paliashdr._cullCenter;
			geometry.boundingSphere.center.set( c[ 0 ], c[ 1 ], c[ 2 ] );
			geometry.boundingSphere.radius = paliashdr._cullRadius;

		}

		geometry.setAttribute( 'position', template.posAttr );
		// r_lerpmodels: the previous pose, read only by the lerp material
		geometry.setAttribute( 'pose1', template1.posAttr );
		geometry.setAttribute( 'normal', template.normalAttr );
		geometry.setAttribute( 'uv', template.uvAttr );
		geometry.setIndex( template.indices );

		// Resize color buffer if vertex count changed between poses
		if ( entity._aliasColorArray.length < template.vertexCount * 3 ) {

			entity._aliasColorArray = new Float32Array( template.vertexCount * 3 );
			geometry.setAttribute( 'color', new THREE.BufferAttribute( entity._aliasColorArray, 3 ) );

		}

		entity._aliasPosenum = posenum;
		entity._aliasPose1 = pose1;
		entity._aliasPaliashdr = paliashdr;

	}

	// Update per-entity vertex colors from lighting data
	if ( hasLighting ) {

		const colorArr = entity._aliasColorArray;
		const lni = template.lightnormalindices;
		if ( template1 === template || lerpdata.blend >= 1 ) {

			for ( let i = 0; i < template.vertexCount; i ++ ) {

				// glColor3f clamps to [0, 1], and GL modulates in display space;
				// Three multiplies vertex colours in linear space, so decode.
				const l = GL_LinearLight( shadedots[ lni[ i ] ] * shadelight );
				colorArr[ i * 3 ] = l;
				colorArr[ i * 3 + 1 ] = l;
				colorArr[ i * 3 + 2 ] = l;

			}

		} else {

			// QS r_alias.c GL_DrawAliasFrame: lerp the shading of the two poses
			const lni1 = template1.lightnormalindices;
			const blend = lerpdata.blend;
			const iblend = 1.0 - blend;
			for ( let i = 0; i < template.vertexCount; i ++ ) {

				const l = GL_LinearLight( ( shadedots[ lni1[ i ] ] * iblend + shadedots[ lni[ i ] ] * blend ) * shadelight );
				colorArr[ i * 3 ] = l;
				colorArr[ i * 3 + 1 ] = l;
				colorArr[ i * 3 + 2 ] = l;

			}

		}

		geometry.attributes.color.needsUpdate = true;

	}

	// Check if this is a player entity with custom colors
	let playerSkinTexture = null;
	if ( entity != null && entity.colormap != null && gl_nocolors.value === 0 ) {

		// Use stored entity index (equivalent to C pointer arithmetic: i = currententity - cl_entities)
		const entIdx = entity._entityIndex;
		if ( entIdx !== undefined && entIdx >= 1 && cl != null && entIdx <= cl.maxclients ) {

			playerSkinTexture = R_GetPlayerSkinTexture( entIdx - 1 );

		}

	}

	// Get cached material
	let material = R_GetAliasMaterial( paliashdr, entity, hasLighting, playerSkinTexture );
	if ( r_lerpmodels.value !== 0 )
		material = R_GetAliasLerpMaterial( entity, material, lerpdata.blend );

	// Get or create mesh for this entity
	let mesh = entity ? entity._aliasMesh : null;
	if ( mesh == null ) {

		mesh = new THREE.Mesh( geometry, material );
		if ( entity != null ) entity._aliasMesh = mesh;

	} else {

		// Reuse existing mesh, update geometry and material if changed
		if ( mesh.geometry !== geometry ) mesh.geometry = geometry;
		if ( mesh.material !== material ) mesh.material = material;

	}

	// Apply entity transform — R_RotateForEntity equivalent
	if ( entity ) {

		// QS R_DrawAliasModel: R_RotateForEntity( lerpdata.origin, lerpdata.angles )
		mesh.position.set(
			lerpdata.origin[ 0 ],
			lerpdata.origin[ 1 ],
			lerpdata.origin[ 2 ]
		);

		{

			const yaw = lerpdata.angles[ 1 ] * _DEG2RAD;
			const pitch = - lerpdata.angles[ 0 ] * _DEG2RAD;
			const roll = lerpdata.angles[ 2 ] * _DEG2RAD;

			_aliasMat.identity();
			_aliasRZ.makeRotationZ( yaw );
			_aliasRY.makeRotationY( pitch );
			_aliasRX.makeRotationX( roll );
			_aliasMat.multiply( _aliasRZ ).multiply( _aliasRY ).multiply( _aliasRX );
			mesh.setRotationFromMatrix( _aliasMat );

		}

		// gl_rmain.c R_DrawAliasModel: eyes are drawn at double size, moved
		// down 30 units ("they are really hard to see in gl"). C translates to
		// scale_origin - ( 0, 0, 30 ) and scales by scale * 2. The template
		// already holds scale * v + scale_origin, so scale it by 2 and move
		// it by -scale_origin - ( 0, 0, 30 ) in the entity's frame.
		if ( gl_doubleeyes.value !== 0 && entity.model != null &&
			entity.model.name === 'progs/eyes.mdl' ) {

			mesh.scale.setScalar( 2 );
			_eyesOffset.set(
				- paliashdr.scale_origin[ 0 ],
				- paliashdr.scale_origin[ 1 ],
				- paliashdr.scale_origin[ 2 ] - ( 22 + 8 )
			).applyQuaternion( mesh.quaternion );
			mesh.position.add( _eyesOffset );

		} else {

			mesh.scale.setScalar( 1 );

		}

	}

	// Reset render overrides (viewmodel sets these)
	mesh.renderOrder = 0;
	if ( mesh.material.depthTest === false ) {

		// Clone material for weapon so it doesn't affect shared material
		// (Only needed when transitioning away from weapon rendering)
		mesh.material.depthTest = true;

	}

	return mesh;

}

/*
=============
GL_DrawAliasShadow

Projects alias model vertices onto the ground plane to create a shadow.
Ported from WinQuake/gl_rmain.c:347-405
=============
*/

// Shared shadow material (Golden Rule #4 — one for all entities)
const _shadowMaterial = new THREE.MeshBasicMaterial( {
	color: 0x000000,
	transparent: true,
	opacity: 0.5,
	depthWrite: false,
	side: THREE.DoubleSide
} );

// Cached matrix objects for shadow transform (Golden Rule #4)
const _shadowMat = new THREE.Matrix4();
const _shadowRZ = new THREE.Matrix4();
const _shadowRY = new THREE.Matrix4();
const _shadowRX = new THREE.Matrix4();

// lerpdata is what R_DrawAliasModel worked out for this entity this frame
// (alias_lerpdata): QS r_alias.c GL_DrawAliasShadow lerps the pose and the
// transform as the model does.
export function GL_DrawAliasShadow( entity, paliashdr, lerpdata, lightspot, shadevector ) {

	if ( paliashdr == null || paliashdr.posedata == null ) return null;

	const template = GL_DrawAliasFrame( paliashdr, lerpdata.pose2 );
	if ( template == null ) return null;
	const template1 = lerpdata.pose1 === lerpdata.pose2 ? template : GL_DrawAliasFrame( paliashdr, lerpdata.pose1 );
	if ( template1 == null ) return null;

	const lheight = entity.origin[ 2 ] - lightspot[ 2 ];
	const height = - lheight + 1.0;

	// Get or create shadow geometry for this entity
	let shadowGeo = entity._aliasShadowGeo;
	let shadowPosArray = entity._aliasShadowPosArray;

	if ( shadowGeo == null || entity._aliasShadowVertCount !== template.vertexCount ) {

		shadowPosArray = new Float32Array( template.vertexCount * 3 );
		shadowGeo = new THREE.BufferGeometry();
		shadowGeo.setAttribute( 'position', new THREE.BufferAttribute( shadowPosArray, 3 ) );
		shadowGeo.setIndex( template.indices );
		entity._aliasShadowGeo = shadowGeo;
		entity._aliasShadowPosArray = shadowPosArray;
		entity._aliasShadowVertCount = template.vertexCount;

	}

	// Project vertices onto ground plane (same as C code)
	const srcPos = template.posAttr.array;
	const srcPos1 = template1.posAttr.array;
	const blend = lerpdata.blend;
	for ( let i = 0; i < template.vertexCount; i ++ ) {

		// pose1 + ( pose2 - pose1 ) * blend; pose2 itself when not lerping
		const px = srcPos1[ i * 3 ] + ( srcPos[ i * 3 ] - srcPos1[ i * 3 ] ) * blend;
		const py = srcPos1[ i * 3 + 1 ] + ( srcPos[ i * 3 + 1 ] - srcPos1[ i * 3 + 1 ] ) * blend;
		const pz = srcPos1[ i * 3 + 2 ] + ( srcPos[ i * 3 + 2 ] - srcPos1[ i * 3 + 2 ] ) * blend;

		shadowPosArray[ i * 3 ] = px - shadevector[ 0 ] * ( pz + lheight );
		shadowPosArray[ i * 3 + 1 ] = py - shadevector[ 1 ] * ( pz + lheight );
		shadowPosArray[ i * 3 + 2 ] = height;

	}

	shadowGeo.attributes.position.needsUpdate = true;

	// Get or create shadow mesh
	let shadowMesh = entity._aliasShadowMesh;
	if ( shadowMesh == null ) {

		shadowMesh = new THREE.Mesh( shadowGeo, _shadowMaterial );
		// Its vertices move every frame with the light and the ground, and
		// Three would cull it by the sphere of the first frame's shadow.
		shadowMesh.frustumCulled = false;
		entity._aliasShadowMesh = shadowMesh;

	} else {

		if ( shadowMesh.geometry !== shadowGeo ) shadowMesh.geometry = shadowGeo;

	}

	// Apply same transform as entity (R_RotateForEntity equivalent)
	shadowMesh.position.set(
		lerpdata.origin[ 0 ],
		lerpdata.origin[ 1 ],
		lerpdata.origin[ 2 ]
	);

	{

		const yaw = lerpdata.angles[ 1 ] * _DEG2RAD;
		const pitch = - lerpdata.angles[ 0 ] * _DEG2RAD;
		const roll = lerpdata.angles[ 2 ] * _DEG2RAD;

		_shadowMat.identity();
		_shadowRZ.makeRotationZ( yaw );
		_shadowRY.makeRotationY( pitch );
		_shadowRX.makeRotationX( roll );
		_shadowMat.multiply( _shadowRZ ).multiply( _shadowRY ).multiply( _shadowRX );
		shadowMesh.setRotationFromMatrix( _shadowMat );

	}

	return shadowMesh;

}
