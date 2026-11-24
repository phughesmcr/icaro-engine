// Ported from: WinQuake/world.c + world.h -- world query functions

/*

entities never clip against themselves, or their owner

line of sight checks trace->crosscontent, but bullets don't

*/

import { Sys_Error } from './sys.js';
import { Host_Error } from './host.js';
import { Con_DPrintf, link_t, ClearLink, RemoveLink, InsertLinkBefore } from './common.js';
import { VectorCopy, VectorAdd, VectorSubtract, DotProduct, vec3_origin, BoxOnPlaneSide } from './mathlib.js';
import {
	sv,
	SOLID_NOT, SOLID_TRIGGER, SOLID_BSP,
	MOVETYPE_PUSH,
	FL_ITEM, FL_MONSTER
} from './server.js';
import {
	CONTENTS_EMPTY, CONTENTS_SOLID, CONTENTS_WATER,
	CONTENTS_CURRENT_0, CONTENTS_CURRENT_DOWN
} from './bspfile.js';
import { MAX_EDICTS } from './quakedef.js';
import { PR_ExecuteProgram } from './pr_exec.js';
import { EDICT_TO_PROG, PROG_TO_EDICT, pr_global_struct } from './progs.js';

// Pre-allocated scratch vectors for SV_RecursiveHullCheck (indexed by recursion depth).
// Grow this pool on demand because valid BSP hulls can be deeper than the common case.
const _hullMidPool = [];
for ( let i = 0; i < 32; i ++ ) _hullMidPool[ i ] = new Float32Array( 3 );

//============================================================================
// world.h types
//============================================================================

export class plane_t {

	constructor() {

		this.normal = new Float32Array( 3 );
		this.dist = 0;

	}

}

export class trace_t {

	constructor() {

		this.allsolid = false; // if true, plane is not valid
		this.startsolid = false; // if true, the initial point was in a solid area
		this.inopen = false;
		this.inwater = false;
		this.fraction = 1.0; // time completed, 1.0 = didn't hit anything
		this.endpos = new Float32Array( 3 ); // final position
		this.plane = new plane_t(); // surface normal at impact
		this.ent = null; // entity the surface is on

	}

}

// Move types for SV_Move
export const MOVE_NORMAL = 0;
export const MOVE_NOMONSTERS = 1;
export const MOVE_MISSILE = 2;

//============================================================================
// moveclip_t - internal structure for SV_Move
//============================================================================

class moveclip_t {

	constructor() {

		this.boxmins = new Float32Array( 3 ); // enclose the test object along entire move
		this.boxmaxs = new Float32Array( 3 );
		this.mins = null; // size of the moving object
		this.maxs = null;
		this.mins2 = new Float32Array( 3 ); // size when clipping against monsters
		this.maxs2 = new Float32Array( 3 );
		this.start = null;
		this.end = null;
		this.trace = new trace_t();
		this.type = 0;
		this.passedict = null;

	}

}

/*
===============================================================================

HULL BOXES

===============================================================================
*/

// box_hull and supporting structures for SV_HullForBox
const box_hull = {
	clipnodes: null,
	planes: null,
	firstclipnode: 0,
	lastclipnode: 5,
	clip_mins: new Float32Array( 3 ),
	clip_maxs: new Float32Array( 3 )
};

const box_clipnodes = new Array( 6 );
for ( let i = 0; i < 6; i ++ ) {

	box_clipnodes[ i ] = {
		planenum: 0,
		children: [ 0, 0 ]
	};

}

const box_planes = new Array( 6 );
for ( let i = 0; i < 6; i ++ ) {

	box_planes[ i ] = {
		normal: new Float32Array( 3 ),
		dist: 0,
		type: 0
	};

}

/*
===================
SV_InitBoxHull

Set up the planes and clipnodes so that the six floats of a bounding box
can just be stored out and get a proper hull_t structure.
===================
*/
export function SV_InitBoxHull() {

	box_hull.clipnodes = box_clipnodes;
	box_hull.planes = box_planes;
	box_hull.firstclipnode = 0;
	box_hull.lastclipnode = 5;

	for ( let i = 0; i < 6; i ++ ) {

		box_clipnodes[ i ].planenum = i;

		const side = i & 1;

		box_clipnodes[ i ].children[ side ] = CONTENTS_EMPTY;
		if ( i !== 5 )
			box_clipnodes[ i ].children[ side ^ 1 ] = i + 1;
		else
			box_clipnodes[ i ].children[ side ^ 1 ] = CONTENTS_SOLID;

		box_planes[ i ].type = i >> 1;
		box_planes[ i ].normal[ 0 ] = 0;
		box_planes[ i ].normal[ 1 ] = 0;
		box_planes[ i ].normal[ 2 ] = 0;
		box_planes[ i ].normal[ i >> 1 ] = 1;

	}

}

/*
===================
SV_HullForBox

To keep everything totally uniform, bounding boxes are turned into small
BSP trees instead of being compared directly.
===================
*/
export function SV_HullForBox( mins, maxs ) {

	box_planes[ 0 ].dist = maxs[ 0 ];
	box_planes[ 1 ].dist = mins[ 0 ];
	box_planes[ 2 ].dist = maxs[ 1 ];
	box_planes[ 3 ].dist = mins[ 1 ];
	box_planes[ 4 ].dist = maxs[ 2 ];
	box_planes[ 5 ].dist = mins[ 2 ];

	return box_hull;

}

/*
================
SV_HullForEntity

Returns a hull that can be used for testing or clipping an object of mins/maxs
size.
Offset is filled in to contain the adjustment that must be added to the
testing object's origin to get a point to use with the returned hull.
================
*/
// Scratch vectors for SV_HullForEntity (Golden Rule #4). SV_HullForBox
// copies the bounds into box_planes, so reusing them across calls is safe.
const hull_size = new Float32Array( 3 );
const hull_hullmins = new Float32Array( 3 );
const hull_hullmaxs = new Float32Array( 3 );

export function SV_HullForEntity( ent, mins, maxs, offset ) {

	let hull;

	// decide which clipping hull to use, based on the size
	if ( ent.v.solid === SOLID_BSP ) {

		// explicit hulls in the BSP model
		// C calls Sys_Error for both of these. Like Ironwail, Host_Error:
		// they are QuakeC or map errors, so end the map, not the program.
		if ( ent.v.movetype !== MOVETYPE_PUSH )
			Host_Error( 'SOLID_BSP without MOVETYPE_PUSH' );

		const model = sv.models[ ent.v.modelindex | 0 ];

		if ( ! model || model.type !== 0 ) // mod_brush = 0
			Host_Error( 'MOVETYPE_PUSH with a non bsp model' );

		const size = hull_size;
		VectorSubtract( maxs, mins, size );
		if ( size[ 0 ] < 3 )
			hull = model.hulls[ 0 ];
		else if ( size[ 0 ] <= 32 )
			hull = model.hulls[ 1 ];
		else
			hull = model.hulls[ 2 ];

		// calculate an offset value to center the origin
		VectorSubtract( hull.clip_mins, mins, offset );
		VectorAdd( offset, ent.v.origin, offset );

	} else {

		// create a temp hull from bounding box sizes
		const hullmins = hull_hullmins;
		const hullmaxs = hull_hullmaxs;
		VectorSubtract( ent.v.mins, maxs, hullmins );
		VectorSubtract( ent.v.maxs, mins, hullmaxs );
		hull = SV_HullForBox( hullmins, hullmaxs );

		VectorCopy( ent.v.origin, offset );

	}

	return hull;

}

/*
===============================================================================

ENTITY AREA CHECKING

===============================================================================
*/

const AREA_DEPTH = 4;
const AREA_NODES = 32;

class areanode_t {

	constructor() {

		this.axis = - 1; // -1 = leaf node
		this.dist = 0;
		this.children = [ null, null ];
		this.trigger_edicts = new link_t();
		this.solid_edicts = new link_t();

	}

}

const sv_areanodes = new Array( AREA_NODES );
for ( let i = 0; i < AREA_NODES; i ++ )
	sv_areanodes[ i ] = new areanode_t();

let sv_numareanodes = 0;

/*
===============
SV_CreateAreaNode
===============
*/
function SV_CreateAreaNode( depth, mins, maxs ) {

	const anode = sv_areanodes[ sv_numareanodes ];
	sv_numareanodes ++;

	ClearLink( anode.trigger_edicts );
	ClearLink( anode.solid_edicts );

	if ( depth === AREA_DEPTH ) {

		anode.axis = - 1;
		anode.children[ 0 ] = null;
		anode.children[ 1 ] = null;
		return anode;

	}

	const size = new Float32Array( 3 );
	VectorSubtract( maxs, mins, size );
	if ( size[ 0 ] > size[ 1 ] )
		anode.axis = 0;
	else
		anode.axis = 1;

	anode.dist = 0.5 * ( maxs[ anode.axis ] + mins[ anode.axis ] );

	const mins1 = new Float32Array( 3 );
	const mins2 = new Float32Array( 3 );
	const maxs1 = new Float32Array( 3 );
	const maxs2 = new Float32Array( 3 );
	VectorCopy( mins, mins1 );
	VectorCopy( mins, mins2 );
	VectorCopy( maxs, maxs1 );
	VectorCopy( maxs, maxs2 );

	maxs1[ anode.axis ] = anode.dist;
	mins2[ anode.axis ] = anode.dist;

	anode.children[ 0 ] = SV_CreateAreaNode( depth + 1, mins2, maxs2 );
	anode.children[ 1 ] = SV_CreateAreaNode( depth + 1, mins1, maxs1 );

	return anode;

}

/*
===============
SV_ClearWorld
===============
*/
export function SV_ClearWorld() {

	SV_InitBoxHull();

	for ( let i = 0; i < AREA_NODES; i ++ ) {

		sv_areanodes[ i ] = new areanode_t();

	}

	sv_numareanodes = 0;

	if ( sv.worldmodel && sv.worldmodel.mins && sv.worldmodel.maxs ) {

		SV_CreateAreaNode( 0, sv.worldmodel.mins, sv.worldmodel.maxs );

	} else {

		// fallback: create with large bounds
		const mins = new Float32Array( [ - 4096, - 4096, - 4096 ] );
		const maxs = new Float32Array( [ 4096, 4096, 4096 ] );
		SV_CreateAreaNode( 0, mins, maxs );

	}

}

/*
===============
SV_UnlinkEdict
===============
*/
export function SV_UnlinkEdict( ent ) {

	if ( ! ent.area.prev || ent.area.prev === ent.area )
		return; // not linked in anywhere
	RemoveLink( ent.area );
	ent.area.prev = ent.area;
	ent.area.next = ent.area;

}

/*
====================
SV_AreaTriggerEdicts

Not in C: Ironwail's (from Spike). Appends to touch_list the triggers at or
below node that touch ent, without running QuakeC, so the area lists can't
change under the walk. Mirrors the tests of C's SV_TouchLinks.
====================
*/
function SV_AreaTriggerEdicts( ent, node, listspace ) {

	// touch linked edicts
	for ( let l = node.trigger_edicts.next; l !== node.trigger_edicts; l = l.next ) {

		const touch = l._owner; // EDICT_FROM_AREA(l)
		if ( ! touch || touch === ent )
			continue;
		if ( ! touch.v.touch || touch.v.solid !== SOLID_TRIGGER )
			continue;
		if ( ent.v.absmin[ 0 ] > touch.v.absmax[ 0 ]
			|| ent.v.absmin[ 1 ] > touch.v.absmax[ 1 ]
			|| ent.v.absmin[ 2 ] > touch.v.absmax[ 2 ]
			|| ent.v.absmax[ 0 ] < touch.v.absmin[ 0 ]
			|| ent.v.absmax[ 1 ] < touch.v.absmin[ 1 ]
			|| ent.v.absmax[ 2 ] < touch.v.absmin[ 2 ] )
			continue;

		if ( touch_count - touch_base === listspace )
			return; // should never happen

		touch_list[ touch_count ++ ] = touch;

	}

	// recurse down both sides
	if ( node.axis === - 1 )
		return;

	if ( ent.v.absmax[ node.axis ] > node.dist )
		SV_AreaTriggerEdicts( ent, node.children[ 0 ], listspace );
	if ( ent.v.absmin[ node.axis ] < node.dist )
		SV_AreaTriggerEdicts( ent, node.children[ 1 ], listspace );

}

// SV_TouchLinks' list of triggers to touch. A touch function can relink an
// entity and so reenter SV_TouchLinks; each call uses the slots from
// touch_count up (Ironwail takes a fresh hunk block per call). Sized for
// one full call, it grows only if nested calls need more.
const touch_list = new Array( MAX_EDICTS ).fill( null );
let touch_count = 0;
let touch_base = 0;

/*
====================
SV_TouchLinks

C walks the area node's trigger list while it runs QuakeC touch functions,
which can unlink or relink triggers and corrupt the walk. Like Ironwail
(ericw, from Spike), collect the touching triggers first, then check each one
again before calling its touch function, since an earlier touch may have
removed or moved it.
====================
*/
export function SV_TouchLinks( ent ) {

	const old_base = touch_base;
	const start = touch_count;
	touch_base = start;

	try {

		SV_AreaTriggerEdicts( ent, sv_areanodes[ 0 ], sv.num_edicts );
		const end = touch_count;

		for ( let i = start; i < end; i ++ ) {

			const touch = touch_list[ i ];

			// re-validate in case a touch function had side effects that
			// make edicts later in the list no longer touch
			if ( touch === ent )
				continue;
			if ( ! touch.v.touch || touch.v.solid !== SOLID_TRIGGER )
				continue;
			if ( ent.v.absmin[ 0 ] > touch.v.absmax[ 0 ]
				|| ent.v.absmin[ 1 ] > touch.v.absmax[ 1 ]
				|| ent.v.absmin[ 2 ] > touch.v.absmax[ 2 ]
				|| ent.v.absmax[ 0 ] < touch.v.absmin[ 0 ]
				|| ent.v.absmax[ 1 ] < touch.v.absmin[ 1 ]
				|| ent.v.absmax[ 2 ] < touch.v.absmin[ 2 ] )
				continue;

			const old_self = pr_global_struct.self;
			const old_other = pr_global_struct.other;
			pr_global_struct.self = EDICT_TO_PROG( touch );
			pr_global_struct.other = EDICT_TO_PROG( ent );
			pr_global_struct.time = sv.time;
			PR_ExecuteProgram( touch.v.touch );
			pr_global_struct.self = old_self;
			pr_global_struct.other = old_other;

		}

	} finally {

		// free this call's slots (Hunk_FreeToLowMark)
		touch_list.fill( null, start, touch_count );
		touch_count = start;
		touch_base = old_base;

	}

}

/*
===============
SV_FindTouchedLeafs
===============
*/
export function SV_FindTouchedLeafs( ent, node ) {

	if ( ! node )
		return;

	if ( node.contents === CONTENTS_SOLID )
		return;

	// add an efrag if the node is a leaf
	if ( node.contents < 0 ) {

		if ( ent.num_leafs === 16 ) // MAX_ENT_LEAFS
			return;

		// leaf = (mleaf_t *)node
		// C: leafnum = leaf - sv.worldmodel->leafs - 1
		// The -1 is because leafs[0] is the solid leaf and PVS bit 0 = leafs[1]
		const leafnum = ( node._leafIndex !== undefined ? node._leafIndex : 0 ) - 1;

		ent.leafnums[ ent.num_leafs ] = leafnum;
		ent.num_leafs ++;
		return;

	}

	// NODE_MIXED
	const splitplane = node.plane;
	const sides = BoxOnPlaneSide( ent.v.absmin, ent.v.absmax, splitplane );

	// recurse down the contacted sides
	if ( sides & 1 )
		SV_FindTouchedLeafs( ent, node.children[ 0 ] );

	if ( sides & 2 )
		SV_FindTouchedLeafs( ent, node.children[ 1 ] );

}

/*
===============
SV_LinkEdict
===============
*/
export function SV_LinkEdict( ent, touch_triggers ) {

	if ( ent.area.prev && ent.area.prev !== ent.area )
		SV_UnlinkEdict( ent ); // unlink from old position

	if ( ent === sv.edicts[ 0 ] )
		return; // don't add the world

	if ( ent.free )
		return;

	// set the abs box
	VectorAdd( ent.v.origin, ent.v.mins, ent.v.absmin );
	VectorAdd( ent.v.origin, ent.v.maxs, ent.v.absmax );

	//
	// to make items easier to pick up and allow them to be grabbed off
	// of shelves, the abs sizes are expanded
	//
	if ( ( ent.v.flags | 0 ) & FL_ITEM ) {

		ent.v.absmin[ 0 ] -= 15;
		ent.v.absmin[ 1 ] -= 15;
		ent.v.absmax[ 0 ] += 15;
		ent.v.absmax[ 1 ] += 15;

	} else {

		// because movement is clipped an epsilon away from an actual edge,
		// we must fully check even when bounding boxes don't quite touch
		ent.v.absmin[ 0 ] -= 1;
		ent.v.absmin[ 1 ] -= 1;
		ent.v.absmin[ 2 ] -= 1;
		ent.v.absmax[ 0 ] += 1;
		ent.v.absmax[ 1 ] += 1;
		ent.v.absmax[ 2 ] += 1;

	}

	// link to PVS leafs
	ent.num_leafs = 0;
	if ( ent.v.modelindex && sv.worldmodel && sv.worldmodel.nodes )
		SV_FindTouchedLeafs( ent, sv.worldmodel.nodes[ 0 ] );

	if ( ent.v.solid === SOLID_NOT )
		return;

	// find the first node that the ent's box crosses
	let node = sv_areanodes[ 0 ];
	while ( true ) {

		if ( node.axis === - 1 )
			break;
		if ( ent.v.absmin[ node.axis ] > node.dist )
			node = node.children[ 0 ];
		else if ( ent.v.absmax[ node.axis ] < node.dist )
			node = node.children[ 1 ];
		else
			break; // crosses the node

	}

	// link it in
	// We use _owner on the link to reference back to the edict (EDICT_FROM_AREA)
	ent.area._owner = ent;
	if ( ent.v.solid === SOLID_TRIGGER )
		InsertLinkBefore( ent.area, node.trigger_edicts );
	else
		InsertLinkBefore( ent.area, node.solid_edicts );

	// if touch_triggers, touch all entities at this node and descend for more
	if ( touch_triggers )
		SV_TouchLinks( ent );

}

/*
===============================================================================

POINT TESTING IN HULLS

===============================================================================
*/

/*
==================
SV_HullPointContents
==================
*/
export function SV_HullPointContents( hull, num, p ) {

	while ( num >= 0 ) {

		if ( num < hull.firstclipnode || num > hull.lastclipnode )
			Sys_Error( 'SV_HullPointContents: bad node number' );

		const node = hull.clipnodes[ num ];
		const plane = hull.planes[ node.planenum ];

		let d;
		if ( plane.type < 3 )
			d = p[ plane.type ] - plane.dist;
		else
			d = DotProduct( plane.normal, p ) - plane.dist;
		if ( d < 0 )
			num = node.children[ 1 ];
		else
			num = node.children[ 0 ];

	}

	return num;

}

/*
==================
SV_PointContents
==================
*/
export function SV_PointContents( p ) {

	if ( ! sv.worldmodel || ! sv.worldmodel.hulls )
		return CONTENTS_EMPTY;

	let cont = SV_HullPointContents( sv.worldmodel.hulls[ 0 ], 0, p );
	if ( cont <= CONTENTS_CURRENT_0 && cont >= CONTENTS_CURRENT_DOWN )
		cont = CONTENTS_WATER;
	return cont;

}

/*
==================
SV_TruePointContents
==================
*/
export function SV_TruePointContents( p ) {

	if ( ! sv.worldmodel || ! sv.worldmodel.hulls )
		return CONTENTS_EMPTY;

	return SV_HullPointContents( sv.worldmodel.hulls[ 0 ], 0, p );

}

/*
============
SV_TestEntityPosition

This could be a lot more efficient...
============
*/
export function SV_TestEntityPosition( ent ) {

	const trace = SV_Move( ent.v.origin, ent.v.mins, ent.v.maxs, ent.v.origin, 0, ent );

	if ( trace.startsolid )
		return sv.edicts[ 0 ];

	return null;

}

/*
===============================================================================

LINE TESTING IN HULLS

===============================================================================
*/

// 1/32 epsilon to keep floating point happy
const DIST_EPSILON = 0.03125;

/*
==================
SV_RecursiveHullCheck
==================
*/
export function SV_RecursiveHullCheck( hull, num, p1f, p2f, p1, p2, trace, depth = 0 ) {

	// check for empty
	if ( num < 0 ) {

		if ( num !== CONTENTS_SOLID ) {

			trace.allsolid = false;
			if ( num === CONTENTS_EMPTY )
				trace.inopen = true;
			else
				trace.inwater = true;

		} else {

			trace.startsolid = true;

		}

		return true; // empty

	}

	if ( num < hull.firstclipnode || num > hull.lastclipnode )
		Sys_Error( 'SV_RecursiveHullCheck: bad node number' );

	//
	// find the point distances
	//
	const node = hull.clipnodes[ num ];
	const plane = hull.planes[ node.planenum ];

	let t1, t2;
	if ( plane.type < 3 ) {

		t1 = p1[ plane.type ] - plane.dist;
		t2 = p2[ plane.type ] - plane.dist;

	} else {

		t1 = DotProduct( plane.normal, p1 ) - plane.dist;
		t2 = DotProduct( plane.normal, p2 ) - plane.dist;

	}

	if ( t1 >= 0 && t2 >= 0 )
		return SV_RecursiveHullCheck( hull, node.children[ 0 ], p1f, p2f, p1, p2, trace, depth );
	if ( t1 < 0 && t2 < 0 )
		return SV_RecursiveHullCheck( hull, node.children[ 1 ], p1f, p2f, p1, p2, trace, depth );

	// put the crosspoint DIST_EPSILON pixels on the near side
	let frac;
	if ( t1 < 0 )
		frac = ( t1 + DIST_EPSILON ) / ( t1 - t2 );
	else
		frac = ( t1 - DIST_EPSILON ) / ( t1 - t2 );
	if ( frac < 0 )
		frac = 0;
	if ( frac > 1 )
		frac = 1;

	let midf = p1f + ( p2f - p1f ) * frac;
	// Use pre-allocated scratch vector from pool (indexed by recursion depth)
	let mid = _hullMidPool[ depth ];
	if ( mid == null ) {

		mid = new Float32Array( 3 );
		_hullMidPool[ depth ] = mid;

	}
	mid[ 0 ] = p1[ 0 ] + frac * ( p2[ 0 ] - p1[ 0 ] );
	mid[ 1 ] = p1[ 1 ] + frac * ( p2[ 1 ] - p1[ 1 ] );
	mid[ 2 ] = p1[ 2 ] + frac * ( p2[ 2 ] - p1[ 2 ] );

	const side = ( t1 < 0 ) ? 1 : 0;

	// move up to the node
	if ( ! SV_RecursiveHullCheck( hull, node.children[ side ], p1f, midf, p1, mid, trace, depth + 1 ) )
		return false;

	if ( SV_HullPointContents( hull, node.children[ side ^ 1 ], mid ) !== CONTENTS_SOLID )
		// go past the node
		return SV_RecursiveHullCheck( hull, node.children[ side ^ 1 ], midf, p2f, mid, p2, trace, depth + 1 );

	if ( trace.allsolid )
		return false; // never got out of the solid area

	//==================
	// the other side of the node is solid, this is the impact point
	//==================
	if ( ! side ) {

		VectorCopy( plane.normal, trace.plane.normal );
		trace.plane.dist = plane.dist;

	} else {

		VectorSubtract( vec3_origin, plane.normal, trace.plane.normal );
		trace.plane.dist = - plane.dist;

	}

	while ( SV_HullPointContents( hull, hull.firstclipnode, mid ) === CONTENTS_SOLID ) {

		// shouldn't really happen, but does occasionally
		frac -= 0.1;
		if ( frac < 0 ) {

			trace.fraction = midf;
			VectorCopy( mid, trace.endpos );
			Con_DPrintf( 'backup past 0\n' );
			return false;

		}

		midf = p1f + ( p2f - p1f ) * frac;
		for ( let i = 0; i < 3; i ++ )
			mid[ i ] = p1[ i ] + frac * ( p2[ i ] - p1[ i ] );

	}

	trace.fraction = midf;
	VectorCopy( mid, trace.endpos );

	return false;

}

/*
==================
SV_ClipMoveToEntity

Handles selection or creation of a clipping hull, and offseting (and
eventually rotation) of the end points

C returns the trace_t by value. Here the caller passes the trace to fill
in, so no trace_t is allocated per entity clipped (Golden Rule #4).
==================
*/
const clip_offset = new Float32Array( 3 );
const clip_start_l = new Float32Array( 3 );
const clip_end_l = new Float32Array( 3 );

export function SV_ClipMoveToEntity( ent, start, mins, maxs, end, trace ) {

	// fill in a default trace (C: memset to 0, then these)
	trace.allsolid = true;
	trace.startsolid = false;
	trace.inopen = false;
	trace.inwater = false;
	trace.fraction = 1;
	VectorCopy( end, trace.endpos );
	trace.plane.normal[ 0 ] = 0;
	trace.plane.normal[ 1 ] = 0;
	trace.plane.normal[ 2 ] = 0;
	trace.plane.dist = 0;
	trace.ent = null;

	// get the clipping hull
	const offset = clip_offset;
	const hull = SV_HullForEntity( ent, mins, maxs, offset );

	const start_l = clip_start_l;
	const end_l = clip_end_l;
	VectorSubtract( start, offset, start_l );
	VectorSubtract( end, offset, end_l );

	// trace a line through the apropriate clipping hull
	SV_RecursiveHullCheck( hull, hull.firstclipnode, 0, 1, start_l, end_l, trace );

	// fix trace up by the offset
	if ( trace.fraction !== 1 )
		VectorAdd( trace.endpos, offset, trace.endpos );

	// did we clip the move?
	if ( trace.fraction < 1 || trace.startsolid )
		trace.ent = ent;

	return trace;

}

// Scratch trace for SV_ClipToLinks. SV_Move never runs QuakeC, so it is not
// re-entered while this is in use.
const clip_touch_trace = new trace_t();

// C's struct assignment ( a = b ) for trace_t
function TraceCopy( src, dst ) {

	dst.allsolid = src.allsolid;
	dst.startsolid = src.startsolid;
	dst.inopen = src.inopen;
	dst.inwater = src.inwater;
	dst.fraction = src.fraction;
	VectorCopy( src.endpos, dst.endpos );
	VectorCopy( src.plane.normal, dst.plane.normal );
	dst.plane.dist = src.plane.dist;
	dst.ent = src.ent;

}

/*
====================
SV_ClipToLinks

Mins and maxs enclose the entire area swept by the move
====================
*/
function SV_ClipToLinks( node, clip ) {

	// touch linked edicts
	let l = node.solid_edicts.next;
	while ( l !== node.solid_edicts ) {

		const next = l.next;
		const touch = l._owner; // EDICT_FROM_AREA(l)
		if ( ! touch ) {

			l = next;
			continue;

		}

		if ( touch.v.solid === SOLID_NOT ) {

			l = next;
			continue;

		}

		if ( touch === clip.passedict ) {

			l = next;
			continue;

		}

		if ( touch.v.solid === SOLID_TRIGGER )
			Sys_Error( 'Trigger in clipping list' );

		if ( clip.type === MOVE_NOMONSTERS && touch.v.solid !== SOLID_BSP ) {

			l = next;
			continue;

		}

		if ( clip.boxmins[ 0 ] > touch.v.absmax[ 0 ]
			|| clip.boxmins[ 1 ] > touch.v.absmax[ 1 ]
			|| clip.boxmins[ 2 ] > touch.v.absmax[ 2 ]
			|| clip.boxmaxs[ 0 ] < touch.v.absmin[ 0 ]
			|| clip.boxmaxs[ 1 ] < touch.v.absmin[ 1 ]
			|| clip.boxmaxs[ 2 ] < touch.v.absmin[ 2 ] ) {

			l = next;
			continue;

		}

		if ( clip.passedict && clip.passedict.v.size && clip.passedict.v.size[ 0 ] && ! touch.v.size[ 0 ] ) {

			l = next;
			continue; // points never interact

		}

		// might intersect, so do an exact clip
		if ( clip.trace.allsolid ) {

			return;

		}

		if ( clip.passedict ) {

			// don't clip against own missiles
			// owner field is an entity index, need PROG_TO_EDICT to get entity reference
			if ( touch.v.owner !== 0 && PROG_TO_EDICT( touch.v.owner ) === clip.passedict ) {

				l = next;
				continue;

			}

			// don't clip against owner
			if ( clip.passedict.v.owner !== 0 && PROG_TO_EDICT( clip.passedict.v.owner ) === touch ) {

				l = next;
				continue;

			}

		}

		const trace = clip_touch_trace;
		if ( ( touch.v.flags | 0 ) & FL_MONSTER )
			SV_ClipMoveToEntity( touch, clip.start, clip.mins2, clip.maxs2, clip.end, trace );
		else
			SV_ClipMoveToEntity( touch, clip.start, clip.mins, clip.maxs, clip.end, trace );

		if ( trace.allsolid || trace.startsolid || trace.fraction < clip.trace.fraction ) {

			trace.ent = touch;
			// C assigns the struct by value; copy out of the scratch trace
			if ( clip.trace.startsolid ) {

				TraceCopy( trace, clip.trace );
				clip.trace.startsolid = true;

			} else {

				TraceCopy( trace, clip.trace );

			}

		// Unreachable, as in world.c SV_ClipToLinks; kept to mirror the C.
		// deno-lint-ignore no-dupe-else-if
		} else if ( trace.startsolid ) {

			clip.trace.startsolid = true;

		}

		l = next;

	}

	// recurse down both sides
	if ( node.axis === - 1 )
		return;

	if ( clip.boxmaxs[ node.axis ] > node.dist )
		SV_ClipToLinks( node.children[ 0 ], clip );
	if ( clip.boxmins[ node.axis ] < node.dist )
		SV_ClipToLinks( node.children[ 1 ], clip );

}

/*
==================
SV_MoveBounds
==================
*/
function SV_MoveBounds( start, mins, maxs, end, boxmins, boxmaxs ) {

	for ( let i = 0; i < 3; i ++ ) {

		if ( end[ i ] > start[ i ] ) {

			boxmins[ i ] = start[ i ] + mins[ i ] - 1;
			boxmaxs[ i ] = end[ i ] + maxs[ i ] + 1;

		} else {

			boxmins[ i ] = end[ i ] + mins[ i ] - 1;
			boxmaxs[ i ] = start[ i ] + maxs[ i ] + 1;

		}

	}

}

/*
==================
SV_Move
==================
*/
// SV_Move never runs QuakeC, so one moveclip_t serves every call
const sv_move_clip = new moveclip_t();

export function SV_Move( start, mins, maxs, end, type, passedict ) {

	const clip = sv_move_clip;

	// clip to world. C returns the trace by value, and callers keep it
	// across later SV_Move calls, so this one trace_t is still new each call.
	clip.trace = SV_ClipMoveToEntity( sv.edicts[ 0 ], start, mins, maxs, end, new trace_t() );

	clip.start = start;
	clip.end = end;
	clip.mins = mins;
	clip.maxs = maxs;
	clip.type = type;
	clip.passedict = passedict;

	if ( type === MOVE_MISSILE ) {

		for ( let i = 0; i < 3; i ++ ) {

			clip.mins2[ i ] = - 15;
			clip.maxs2[ i ] = 15;

		}

	} else {

		VectorCopy( mins, clip.mins2 );
		VectorCopy( maxs, clip.maxs2 );

	}

	// create the bounding box of the entire move
	SV_MoveBounds( start, clip.mins2, clip.maxs2, end, clip.boxmins, clip.boxmaxs );

	// clip to entities
	SV_ClipToLinks( sv_areanodes[ 0 ], clip );

	return clip.trace;

}
