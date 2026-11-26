// Ported from: QuakeWorld/client/pmove.c and pmovetst.c
// Shared player movement physics for client-side prediction
// This code runs identically on both client and server

import {
  AngleVectors,
  CrossProduct,
  DotProduct,
  Length,
  VectorAdd,
  VectorCopy,
  VectorMA,
  VectorNormalize,
  VectorScale,
  VectorSubtract,
} from "./mathlib.js";
import {
  CONTENTS_CURRENT_0,
  CONTENTS_CURRENT_DOWN,
  CONTENTS_EMPTY,
  CONTENTS_SLIME,
  CONTENTS_SOLID,
  CONTENTS_WATER,
} from "./bspfile.js";

// Movement constants
const STEPSIZE = 18;
const BUTTON_JUMP = 2;
const STOP_EPSILON = 0.1;
const MAX_CLIP_PLANES = 5;
const DIST_EPSILON = 0.03125; // 1/32 epsilon for floating point

// Player bounds
export const player_mins = new Float32Array([-16, -16, -24]);
export const player_maxs = new Float32Array([16, 16, 32]);

// Cached buffers to avoid per-call allocations (Golden Rule #4)
const _pm_flymove_original_velocity = new Float32Array(3);
const _pm_flymove_primal_velocity = new Float32Array(3);
const _pm_flymove_end = new Float32Array(3);
const _pm_flymove_dir = new Float32Array(3);
const _pm_flymove_planes = [];
for (let i = 0; i < MAX_CLIP_PLANES; i++) {
  _pm_flymove_planes[i] = new Float32Array(3);
}

// PM_RecursiveHullCheck's `mid` is recursive: one scratch vector per depth
const _pm_hullmid_pool = [];
const _pm_testpos_mins = new Float32Array(3);
const _pm_testpos_maxs = new Float32Array(3);
const _pm_testpos_test = new Float32Array(3);
const _pm_move_mins = new Float32Array(3);
const _pm_move_maxs = new Float32Array(3);
const _pm_move_offset = new Float32Array(3);
const _pm_move_start_l = new Float32Array(3);
const _pm_move_end_l = new Float32Array(3);
const _pm_friction_start = new Float32Array(3);
const _pm_friction_stop = new Float32Array(3);
const _pm_watermove_wishvel = new Float32Array(3);
const _pm_watermove_wishdir = new Float32Array(3);
const _pm_watermove_dest = new Float32Array(3);
const _pm_watermove_start = new Float32Array(3);
const _pm_groundmove_dest = new Float32Array(3);
const _pm_groundmove_original = new Float32Array(3);
const _pm_groundmove_originalvel = new Float32Array(3);
const _pm_groundmove_down = new Float32Array(3);
const _pm_groundmove_downvel = new Float32Array(3);
const _pm_groundmove_up = new Float32Array(3);
const _pm_airmove_wishvel = new Float32Array(3);
const _pm_airmove_wishdir = new Float32Array(3);
const _pm_catpos_point = new Float32Array(3);
const _pm_waterjump_flatforward = new Float32Array(3);
const _pm_waterjump_spot = new Float32Array(3);
const _pm_nudge_base = new Float32Array(3);
const _pm_spectator_wishvel = new Float32Array(3);
const _pm_spectator_wishdir = new Float32Array(3);

// Movement variables (sent from server, used for physics)
export const movevars = {
  gravity: 800,
  stopspeed: 100,
  maxspeed: 320,
  spectatormaxspeed: 500,
  accelerate: 10,
  airaccelerate: 0.7,
  wateraccelerate: 10,
  friction: 4,
  waterfriction: 1,
  entgravity: 1.0,

  // NetQuake server values used only by the NetQuake-physics mode
  // (pmove.nqphysics). The NQ server never sends these, so they hold the
  // WinQuake cvar defaults unless _movevars carries them as optional
  // extra arguments (see CL_Movevars_f).
  edgefriction: 2, // edgefriction (sv_phys.c)
  maxvelocity: 2000, // sv_maxvelocity (sv_phys.c)
  altnoclip: 0, // sv_altnoclip (johnfitz, sv_user.c); 0 is id's noclip
  rollangle: 2, // cl_rollangle (view.c), read by V_CalcRoll in SV_ClientThink
  rollspeed: 200, // cl_rollspeed (view.c)
};

// Movetypes understood by the NetQuake-physics mode (server.h values)
export const PM_MOVETYPE_WALK = 3;
export const PM_MOVETYPE_FLY = 5;
export const PM_MOVETYPE_NOCLIP = 8;

// Trace result structure
export class pmtrace_t {
  constructor() {
    this.allsolid = false;
    this.startsolid = false;
    this.inopen = false;
    this.inwater = false;
    this.fraction = 1;
    this.endpos = new Float32Array(3);
    this.plane = {
      normal: new Float32Array(3),
      dist: 0,
    };
    this.ent = -1;
  }
}

// Cached pmtrace_t buffers (must be after class definition)
const _pm_move_total = new pmtrace_t();
const _pm_move_trace = new pmtrace_t();
const _pm_point_total = new pmtrace_t();
const _pm_point_trace = new pmtrace_t();
const _pm_point_start_l = new Float32Array(3);
const _pm_point_end_l = new Float32Array(3);

// Physics entity (world + other players/entities to collide with)
export class physent_t {
  constructor() {
    this.origin = new Float32Array(3);
    this.model = null; // BSP model for collision
    this.mins = new Float32Array(3);
    this.maxs = new Float32Array(3);
    this.info = 0;
  }
}

// Main player move state
export const pmove = {
  sequence: 0,

  // Player state
  origin: new Float32Array(3),
  angles: new Float32Array(3),
  velocity: new Float32Array(3),
  oldbuttons: 0,
  waterjumptime: 0,
  dead: false,
  spectator: false,

  // NetQuake-physics mode (see PM_NQ_PlayerMove). When true, PlayerMove
  // runs one NetQuake server frame for the player instead of QW pmove.
  // These fields carry the edict state NQ keeps between frames:
  nqphysics: false,
  movetype: PM_MOVETYPE_WALK,
  onground: false, // FL_ONGROUND, in and out
  waterlevel: -1, // ent->v.waterlevel from the last SV_CheckWater; -1 = unknown
  watertype: CONTENTS_EMPTY,
  roll: 0, // ent->v.angles[ROLL] from the last SV_ClientThink
  movedir: new Float32Array(3), // ent->v.movedir, set by QC CheckWaterJump
  teleporttime: 0, // seconds left of ent->v.teleport_time (teleport back-move lock)
  punchangle: new Float32Array(3), // ent->v.punchangle

  // World state - physics entities to collide with
  numphysent: 0,
  physents: [], // Array of physent_t, [0] is world

  // Input command
  cmd: {
    msec: 0,
    angles: new Float32Array(3),
    forwardmove: 0,
    sidemove: 0,
    upmove: 0,
    buttons: 0,
  },

  // Results
  numtouch: 0,
  touchindex: [],
};

// Initialize physents array. QW has 32; NQ maps put far more solid
// entities (monsters) in view, and CL_SetSolidEntities adds them all.
export const MAX_PHYSENTS = 128;
for (let i = 0; i < MAX_PHYSENTS; i++) {
  pmove.physents.push(new physent_t());
  pmove.touchindex.push(0);
}

// Module-level state
let onground = -1; // -1 = in air, >= 0 = entity index we're standing on
let waterlevel = 0; // 0 = not in water, 1 = feet, 2 = waist, 3 = eyes
let watertype = CONTENTS_EMPTY;
let frametime = 0;

const forward = new Float32Array(3);
const right = new Float32Array(3);
const up = new Float32Array(3);

// Export state accessors
export function PM_GetOnGround() {
  return onground;
}
export function PM_GetWaterLevel() {
  return waterlevel;
}
export function PM_GetWaterType() {
  return watertype;
}

// Box hull for non-BSP collision (other players)
const box_hull = {
  clipnodes: [],
  planes: [],
  firstclipnode: 0,
  lastclipnode: 5,
};

for (let i = 0; i < 6; i++) {
  box_hull.clipnodes.push({ planenum: i, children: [0, 0] });
  box_hull.planes.push({ type: i >> 1, normal: new Float32Array(3), dist: 0 });
  box_hull.planes[i].normal[i >> 1] = 1;
}

/*
===================
PM_InitBoxHull

Set up the planes and clipnodes so that the six floats of a bounding box
can just be stored out and get a proper hull_t structure.
===================
*/
export function PM_InitBoxHull() {
  for (let i = 0; i < 6; i++) {
    box_hull.clipnodes[i].planenum = i;

    const side = i & 1;

    box_hull.clipnodes[i].children[side] = CONTENTS_EMPTY;
    if (i !== 5) {
      box_hull.clipnodes[i].children[side ^ 1] = i + 1;
    } else {
      box_hull.clipnodes[i].children[side ^ 1] = CONTENTS_SOLID;
    }

    box_hull.planes[i].type = i >> 1;
    box_hull.planes[i].normal.fill(0);
    box_hull.planes[i].normal[i >> 1] = 1;
  }
}

/*
===================
PM_HullForBox

To keep everything totally uniform, bounding boxes are turned into small
BSP trees instead of being compared directly.
===================
*/
export function PM_HullForBox(mins, maxs) {
  box_hull.planes[0].dist = maxs[0];
  box_hull.planes[1].dist = mins[0];
  box_hull.planes[2].dist = maxs[1];
  box_hull.planes[3].dist = mins[1];
  box_hull.planes[4].dist = maxs[2];
  box_hull.planes[5].dist = mins[2];
  box_flat.dist[0] = maxs[0];
  box_flat.dist[1] = mins[0];
  box_flat.dist[2] = maxs[1];
  box_flat.dist[3] = mins[1];
  box_flat.dist[4] = maxs[2];
  box_flat.dist[5] = mins[2];

  return box_hull;
}

/*
==================
Flattened hulls

Not in QW. hull.clipnodes is an array of {planenum, children} objects and
hull.planes an array of {normal, dist, type} objects, so walking a hull
chases two pointers per node. The first time a hull is traced through, its
tree is copied into typed arrays indexed by node number, with the plane
resolved. The values are the same ones, so every distance comes out bit for
bit as before. Brush models' clipnodes and planes are not changed once
loaded; the box hull is the exception, and PM_HullForBox writes its
distances into box_flat directly. (world.js does the same for the server's
traces; pmove.js can't import it, as the cycle it is in with cl_pred.js
fails with a TDZ error.)
==================
*/
class pm_hull_flat_t {
  constructor(count) {
    this.planes = null;
    this.child0 = new Int32Array(count);
    this.child1 = new Int32Array(count);
    this.type = new Int8Array(count);
    this.normal = new Float32Array(count * 3);
    this.dist = new Float64Array(count);
  }
}

const pm_hull_flats = new WeakMap(); // clipnodes array -> pm_hull_flat_t
const box_flat = new pm_hull_flat_t(6);
for (let i = 0; i < 6; i++) {
  box_flat.normal[i * 3 + (i >> 1)] = 1;
  box_flat.type[i] = i >> 1;
}

function pm_hull_flat(hull) {
  if (hull === box_hull) {
    // PM_InitBoxHull may have been run since: take its tree
    for (let i = 0; i < 6; i++) {
      box_flat.child0[i] = box_hull.clipnodes[i].children[0];
      box_flat.child1[i] = box_hull.clipnodes[i].children[1];
    }
    return box_flat;
  }

  const clipnodes = hull.clipnodes;
  let f = pm_hull_flats.get(clipnodes);
  if (
    f !== undefined && f.planes === hull.planes &&
    f.child0.length === clipnodes.length
  ) {
    return f;
  }

  const count = clipnodes.length;
  f = new pm_hull_flat_t(count);
  f.planes = hull.planes;
  for (let i = 0; i < count; i++) {
    const node = clipnodes[i];
    if (node === undefined || node === null) {
      continue; // not a node (unfilled slot); the bounds check rejects it
    }
    const plane = hull.planes[node.planenum];
    f.child0[i] = node.children[0];
    f.child1[i] = node.children[1];
    f.type[i] = plane.type;
    f.normal[i * 3] = plane.normal[0];
    f.normal[i * 3 + 1] = plane.normal[1];
    f.normal[i * 3 + 2] = plane.normal[2];
    f.dist[i] = plane.dist;
  }

  pm_hull_flats.set(clipnodes, f);
  return f;
}

/*
==================
PM_HullPointContents
==================
*/
function pm_hull_point_contents(f, firstclipnode, lastclipnode, num, p) {
  const p0 = p[0], p1 = p[1], p2 = p[2];
  const type = f.type, dist = f.dist, normal = f.normal;

  while (num >= 0) {
    if (num < firstclipnode || num > lastclipnode) {
      console.error("PM_HullPointContents: bad node number");
      return CONTENTS_SOLID;
    }

    const t = type[num];
    let d;
    if (t === 0) {
      d = p0 - dist[num];
    } else if (t === 1) {
      d = p1 - dist[num];
    } else if (t === 2) {
      d = p2 - dist[num];
    } else {
      d = normal[num * 3] * p0 + normal[num * 3 + 1] * p1 +
        normal[num * 3 + 2] * p2 - dist[num];
    }

    if (d < 0) {
      num = f.child1[num];
    } else {
      num = f.child0[num];
    }
  }

  return num;
}

export function PM_HullPointContents(hull, num, p) {
  return pm_hull_point_contents(
    pm_hull_flat(hull),
    hull.firstclipnode,
    hull.lastclipnode,
    num,
    p,
  );
}

/*
==================
PM_PointContents
==================
*/
export function PM_PointContents(p) {
  if (pmove.numphysent === 0 || pmove.physents[0].model == null) {
    return CONTENTS_EMPTY;
  }

  const hull = pmove.physents[0].model.hulls[0];
  return PM_HullPointContents(hull, hull.firstclipnode, p);
}

/*
==================
PM_RecursiveHullCheck

The C recurses for every branch; the cases that end in a tail call (both
points on one side, passing the node) loop here instead.
==================
*/
function pm_recursive_hull_check(
  f,
  firstclipnode,
  lastclipnode,
  num,
  p1f,
  p2f,
  p1,
  p2,
  trace,
  depth,
) {
  const type = f.type, dist = f.dist, normal = f.normal;

  while (true) {
    // check for empty
    if (num < 0) {
      if (num !== CONTENTS_SOLID) {
        trace.allsolid = false;
        if (num === CONTENTS_EMPTY) {
          trace.inopen = true;
        } else {
          trace.inwater = true;
        }
      } else {
        trace.startsolid = true;
      }
      return true; // empty
    }

    if (num < firstclipnode || num > lastclipnode) {
      console.error("PM_RecursiveHullCheck: bad node number");
      return true;
    }

    // find the point distances
    const ty = type[num];
    const pd = dist[num];
    let t1, t2;
    if (ty < 3) {
      t1 = p1[ty] - pd;
      t2 = p2[ty] - pd;
    } else {
      const n0 = normal[num * 3],
        n1 = normal[num * 3 + 1],
        n2 = normal[num * 3 + 2];
      t1 = n0 * p1[0] + n1 * p1[1] + n2 * p1[2] - pd;
      t2 = n0 * p2[0] + n1 * p2[1] + n2 * p2[2] - pd;
    }

    if (t1 >= 0 && t2 >= 0) {
      num = f.child0[num];
      continue;
    }
    if (t1 < 0 && t2 < 0) {
      num = f.child1[num];
      continue;
    }

    // put the crosspoint DIST_EPSILON pixels on the near side
    let frac;
    if (t1 < 0) {
      frac = (t1 + DIST_EPSILON) / (t1 - t2);
    } else {
      frac = (t1 - DIST_EPSILON) / (t1 - t2);
    }

    if (frac < 0) frac = 0;
    if (frac > 1) frac = 1;

    let midf = p1f + (p2f - p1f) * frac;
    // recursive: one scratch vector per depth
    let mid = _pm_hullmid_pool[depth];
    if (mid === undefined) {
      mid = _pm_hullmid_pool[depth] = new Float32Array(3);
    }
    mid[0] = p1[0] + frac * (p2[0] - p1[0]);
    mid[1] = p1[1] + frac * (p2[1] - p1[1]);
    mid[2] = p1[2] + frac * (p2[2] - p1[2]);

    const side = (t1 < 0) ? 1 : 0;
    const near = side === 0 ? f.child0[num] : f.child1[num];
    const far = side === 0 ? f.child1[num] : f.child0[num];

    // move up to the node
    if (
      !pm_recursive_hull_check(
        f,
        firstclipnode,
        lastclipnode,
        near,
        p1f,
        midf,
        p1,
        mid,
        trace,
        depth + 1,
      )
    ) {
      return false;
    }

    if (
      pm_hull_point_contents(f, firstclipnode, lastclipnode, far, mid) !==
        CONTENTS_SOLID
    ) {
      // go past the node
      num = far;
      p1f = midf;
      p1 = mid;
      depth++;
      continue;
    }

    if (trace.allsolid) {
      return false; // never got out of the solid area
    }

    // the other side of the node is solid, this is the impact point
    if (side === 0) {
      trace.plane.normal[0] = normal[num * 3];
      trace.plane.normal[1] = normal[num * 3 + 1];
      trace.plane.normal[2] = normal[num * 3 + 2];
      trace.plane.dist = pd;
    } else {
      // VectorSubtract( vec3_origin, plane.normal, trace.plane.normal )
      trace.plane.normal[0] = 0 - normal[num * 3];
      trace.plane.normal[1] = 0 - normal[num * 3 + 1];
      trace.plane.normal[2] = 0 - normal[num * 3 + 2];
      trace.plane.dist = -pd;
    }

    while (
      pm_hull_point_contents(
        f,
        firstclipnode,
        lastclipnode,
        firstclipnode,
        mid,
      ) === CONTENTS_SOLID
    ) {
      // shouldn't really happen, but does occasionally
      frac -= 0.1;
      if (frac < 0) {
        trace.fraction = midf;
        VectorCopy(mid, trace.endpos);
        return false;
      }
      midf = p1f + (p2f - p1f) * frac;
      for (let i = 0; i < 3; i++) {
        mid[i] = p1[i] + frac * (p2[i] - p1[i]);
      }
    }

    trace.fraction = midf;
    VectorCopy(mid, trace.endpos);

    return false;
  }
}

export function PM_RecursiveHullCheck(hull, num, p1f, p2f, p1, p2, trace) {
  return pm_recursive_hull_check(
    pm_hull_flat(hull),
    hull.firstclipnode,
    hull.lastclipnode,
    num,
    p1f,
    p2f,
    p1,
    p2,
    trace,
    0,
  );
}

/*
================
PM_TestPlayerPosition

Returns false if the given player position is not valid (in solid)
================
*/
export function PM_TestPlayerPosition(pos) {
  for (let i = 0; i < pmove.numphysent; i++) {
    const pe = pmove.physents[i];

    // get the clipping hull
    let hull;
    if (pe.model != null) {
      hull = pe.model.hulls[1]; // hull 1 is player-sized
    } else {
      VectorSubtract(pe.mins, player_maxs, _pm_testpos_mins);
      VectorSubtract(pe.maxs, player_mins, _pm_testpos_maxs);
      hull = PM_HullForBox(_pm_testpos_mins, _pm_testpos_maxs);
    }

    VectorSubtract(pos, pe.origin, _pm_testpos_test);

    if (
      PM_HullPointContents(hull, hull.firstclipnode, _pm_testpos_test) ===
        CONTENTS_SOLID
    ) {
      return false;
    }
  }

  return true;
}

/*
================
PM_PlayerMove

Trace player from start to end, returns trace result
================
*/
export function PM_PlayerMove(start, end) {
  const total = _pm_move_total;
  total.allsolid = false;
  total.startsolid = false;
  total.inopen = false;
  total.inwater = false;
  total.fraction = 1;
  total.ent = -1;
  total.plane.dist = 0;
  total.plane.normal[0] = 0;
  total.plane.normal[1] = 0;
  total.plane.normal[2] = 0;
  VectorCopy(end, total.endpos);

  for (let i = 0; i < pmove.numphysent; i++) {
    const pe = pmove.physents[i];

    // get the clipping hull
    let hull;
    if (pe.model != null) {
      hull = pe.model.hulls[1];
    } else {
      VectorSubtract(pe.mins, player_maxs, _pm_move_mins);
      VectorSubtract(pe.maxs, player_mins, _pm_move_maxs);
      hull = PM_HullForBox(_pm_move_mins, _pm_move_maxs);
    }

    const offset = _pm_move_offset;
    VectorCopy(pe.origin, offset);

    const start_l = _pm_move_start_l;
    const end_l = _pm_move_end_l;
    VectorSubtract(start, offset, start_l);
    VectorSubtract(end, offset, end_l);

    // fill in a default trace
    const trace = _pm_move_trace;
    trace.allsolid = true;
    trace.startsolid = false;
    trace.inopen = false;
    trace.inwater = false;
    trace.fraction = 1;
    trace.ent = -1;
    trace.plane.dist = 0;
    trace.plane.normal[0] = 0;
    trace.plane.normal[1] = 0;
    trace.plane.normal[2] = 0;
    VectorCopy(end, trace.endpos);

    // trace a line through the apropriate clipping hull
    PM_RecursiveHullCheck(
      hull,
      hull.firstclipnode,
      0,
      1,
      start_l,
      end_l,
      trace,
    );

    if (trace.allsolid) {
      trace.startsolid = true;
    }
    if (trace.startsolid) {
      trace.fraction = 0;
    }

    // did we clip the move?
    if (trace.fraction < total.fraction) {
      // fix trace up by the offset
      VectorAdd(trace.endpos, offset, trace.endpos);
      total.allsolid = trace.allsolid;
      total.startsolid = trace.startsolid;
      total.inopen = trace.inopen;
      total.inwater = trace.inwater;
      total.fraction = trace.fraction;
      VectorCopy(trace.endpos, total.endpos);
      VectorCopy(trace.plane.normal, total.plane.normal);
      total.plane.dist = trace.plane.dist;
      total.ent = i;
    }
  }

  return total;
}

/*
================
PM_NQ_PointMove

Point trace (zero-size box) through hull 0 of the BSP physents only.
Client-side stand-in for NetQuake's SV_Move ( start, vec3_origin,
vec3_origin, end, MOVE_NOMONSTERS, ent ) (WinQuake/world.c), which the
server uses for the edge-friction probe in SV_UserFriction and for
QuakeC traceline ( ..., TRUE, ... ) in CheckWaterJump. Non-BSP physents
(player boxes) are skipped, as MOVE_NOMONSTERS skips non-SOLID_BSP edicts.
================
*/
export function PM_NQ_PointMove(start, end) {
  const total = _pm_point_total;
  total.allsolid = false;
  total.startsolid = false;
  total.inopen = false;
  total.inwater = false;
  total.fraction = 1;
  total.ent = -1;
  total.plane.dist = 0;
  total.plane.normal.fill(0);
  VectorCopy(end, total.endpos);

  for (let i = 0; i < pmove.numphysent; i++) {
    const pe = pmove.physents[i];
    if (pe.model == null) {
      continue;
    }

    const hull = pe.model.hulls[0];
    if (hull == null) {
      continue;
    }

    VectorSubtract(start, pe.origin, _pm_point_start_l);
    VectorSubtract(end, pe.origin, _pm_point_end_l);

    const trace = _pm_point_trace;
    trace.allsolid = true;
    trace.startsolid = false;
    trace.inopen = false;
    trace.inwater = false;
    trace.fraction = 1;
    trace.ent = -1;
    trace.plane.dist = 0;
    trace.plane.normal.fill(0);
    VectorCopy(_pm_point_end_l, trace.endpos);

    PM_RecursiveHullCheck(
      hull,
      hull.firstclipnode,
      0,
      1,
      _pm_point_start_l,
      _pm_point_end_l,
      trace,
    );

    if (trace.allsolid) {
      trace.startsolid = true;
    }
    if (trace.startsolid) {
      trace.fraction = 0;
    }

    if (trace.fraction < total.fraction) {
      VectorAdd(trace.endpos, pe.origin, total.endpos);
      total.allsolid = trace.allsolid;
      total.startsolid = trace.startsolid;
      total.inopen = trace.inopen;
      total.inwater = trace.inwater;
      total.fraction = trace.fraction;
      VectorCopy(trace.plane.normal, total.plane.normal);
      total.plane.dist = trace.plane.dist;
      total.ent = i;
    }
  }

  return total;
}

/*
==================
PM_ClipVelocity

Slide off of the impacting object
returns the blocked flags (1 = floor, 2 = step / wall)
==================
*/
function PM_ClipVelocity(inv, normal, out, overbounce) {
  let blocked = 0;
  if (normal[2] > 0) {
    blocked |= 1; // floor
  }
  if (normal[2] === 0) {
    blocked |= 2; // step
  }

  const backoff = DotProduct(inv, normal) * overbounce;

  for (let i = 0; i < 3; i++) {
    const change = normal[i] * backoff;
    out[i] = inv[i] - change;
    if (out[i] > -STOP_EPSILON && out[i] < STOP_EPSILON) {
      out[i] = 0;
    }
  }

  return blocked;
}

/*
============
PM_FlyMove

The basic solid body movement clip that slides along multiple planes
============
*/
function PM_FlyMove() {
  const numbumps = 4;
  let blocked = 0;

  // Use cached buffers instead of allocating per-call
  const original_velocity = _pm_flymove_original_velocity;
  const primal_velocity = _pm_flymove_primal_velocity;
  VectorCopy(pmove.velocity, original_velocity);
  VectorCopy(pmove.velocity, primal_velocity);

  const planes = _pm_flymove_planes;
  let numplanes = 0;

  let time_left = frametime;

  for (let bumpcount = 0; bumpcount < numbumps; bumpcount++) {
    const end = _pm_flymove_end;
    for (let i = 0; i < 3; i++) {
      end[i] = pmove.origin[i] + time_left * pmove.velocity[i];
    }

    const trace = PM_PlayerMove(pmove.origin, end);

    if (trace.startsolid || trace.allsolid) {
      // entity is trapped in another solid
      pmove.velocity.fill(0);
      return 3;
    }

    if (trace.fraction > 0) {
      // actually covered some distance
      VectorCopy(trace.endpos, pmove.origin);
      numplanes = 0;
    }

    if (trace.fraction === 1) {
      break; // moved the entire distance
    }

    // save entity for contact
    if (pmove.numtouch < pmove.touchindex.length) {
      pmove.touchindex[pmove.numtouch] = trace.ent;
      pmove.numtouch++;
    }

    if (trace.plane.normal[2] > 0.7) {
      blocked |= 1; // floor
    }
    if (trace.plane.normal[2] === 0) {
      blocked |= 2; // step
    }

    time_left -= time_left * trace.fraction;

    // clipped to another plane
    if (numplanes >= MAX_CLIP_PLANES) {
      // this shouldn't really happen
      pmove.velocity.fill(0);
      break;
    }

    VectorCopy(trace.plane.normal, planes[numplanes]);
    numplanes++;

    // modify original_velocity so it parallels all of the clip planes
    let i;
    for (i = 0; i < numplanes; i++) {
      PM_ClipVelocity(original_velocity, planes[i], pmove.velocity, 1);
      let j;
      for (j = 0; j < numplanes; j++) {
        if (j !== i) {
          if (DotProduct(pmove.velocity, planes[j]) < 0) {
            break; // not ok
          }
        }
      }
      if (j === numplanes) {
        break;
      }
    }

    if (i !== numplanes) {
      // go along this plane
    } else {
      // go along the crease
      if (numplanes !== 2) {
        pmove.velocity.fill(0);
        break;
      }
      const dir = _pm_flymove_dir;
      CrossProduct(planes[0], planes[1], dir);
      const d = DotProduct(dir, pmove.velocity);
      VectorScale(dir, d, pmove.velocity);
    }

    // if original velocity is against the original velocity, stop dead
    // to avoid tiny oscillations in sloping corners
    if (DotProduct(pmove.velocity, primal_velocity) <= 0) {
      pmove.velocity.fill(0);
      break;
    }
  }

  if (pmove.waterjumptime > 0) {
    VectorCopy(primal_velocity, pmove.velocity);
  }

  return blocked;
}

/*
==================
PM_Friction

Handles both ground friction and water friction
==================
*/
function PM_Friction() {
  if (pmove.waterjumptime > 0) {
    return;
  }

  const vel = pmove.velocity;

  const speed = Math.sqrt(vel[0] * vel[0] + vel[1] * vel[1] + vel[2] * vel[2]);
  if (speed < 1) {
    vel[0] = 0;
    vel[1] = 0;
    return;
  }

  let friction = movevars.friction;

  // if the leading edge is over a dropoff, increase friction
  if (onground !== -1) {
    const start = _pm_friction_start;
    const stop = _pm_friction_stop;
    start[0] = stop[0] = pmove.origin[0] + vel[0] / speed * 16;
    start[1] = stop[1] = pmove.origin[1] + vel[1] / speed * 16;
    start[2] = pmove.origin[2] + player_mins[2];
    stop[2] = start[2] - 34;

    const trace = PM_PlayerMove(start, stop);

    if (trace.fraction === 1) {
      friction *= 2;
    }
  }

  let drop = 0;

  if (waterlevel >= 2) {
    // apply water friction
    drop += speed * movevars.waterfriction * waterlevel * frametime;
  } else if (onground !== -1) {
    // apply ground friction
    const control = speed < movevars.stopspeed ? movevars.stopspeed : speed;
    drop += control * friction * frametime;
  }

  // scale the velocity
  let newspeed = speed - drop;
  if (newspeed < 0) {
    newspeed = 0;
  }
  newspeed /= speed;

  vel[0] = vel[0] * newspeed;
  vel[1] = vel[1] * newspeed;
  vel[2] = vel[2] * newspeed;
}

/*
==============
PM_Accelerate
==============
*/
function PM_Accelerate(wishdir, wishspeed, accel) {
  if (pmove.dead) {
    return;
  }
  if (pmove.waterjumptime > 0) {
    return;
  }

  const currentspeed = DotProduct(pmove.velocity, wishdir);
  const addspeed = wishspeed - currentspeed;
  if (addspeed <= 0) {
    return;
  }

  let accelspeed = accel * frametime * wishspeed;
  if (accelspeed > addspeed) {
    accelspeed = addspeed;
  }

  for (let i = 0; i < 3; i++) {
    pmove.velocity[i] += accelspeed * wishdir[i];
  }
}

/*
==============
PM_AirAccelerate
==============
*/
function PM_AirAccelerate(wishdir, wishspeed, accel) {
  if (pmove.dead) {
    return;
  }
  if (pmove.waterjumptime > 0) {
    return;
  }

  let wishspd = wishspeed;
  if (wishspd > 30) {
    wishspd = 30;
  }

  const currentspeed = DotProduct(pmove.velocity, wishdir);
  const addspeed = wishspd - currentspeed;
  if (addspeed <= 0) {
    return;
  }

  let accelspeed = accel * wishspeed * frametime;
  if (accelspeed > addspeed) {
    accelspeed = addspeed;
  }

  for (let i = 0; i < 3; i++) {
    pmove.velocity[i] += accelspeed * wishdir[i];
  }
}

/*
===================
PM_WaterMove
===================
*/
function PM_WaterMove() {
  const wishvel = _pm_watermove_wishvel;

  // user intentions
  for (let i = 0; i < 3; i++) {
    wishvel[i] = forward[i] * pmove.cmd.forwardmove +
      right[i] * pmove.cmd.sidemove;
  }

  if (
    pmove.cmd.forwardmove === 0 && pmove.cmd.sidemove === 0 &&
    pmove.cmd.upmove === 0
  ) {
    wishvel[2] -= 60; // drift towards bottom
  } else {
    wishvel[2] += pmove.cmd.upmove;
  }

  const wishdir = _pm_watermove_wishdir;
  VectorCopy(wishvel, wishdir);
  let wishspeed = VectorNormalize(wishdir);

  if (wishspeed > movevars.maxspeed) {
    VectorScale(wishvel, movevars.maxspeed / wishspeed, wishvel);
    wishspeed = movevars.maxspeed;
  }
  wishspeed *= 0.7;

  // water acceleration
  PM_Accelerate(wishdir, wishspeed, movevars.wateraccelerate);

  // assume it is a stair or a slope, so press down from stepheight above
  const dest = _pm_watermove_dest;
  VectorMA(pmove.origin, frametime, pmove.velocity, dest);
  const start = _pm_watermove_start;
  VectorCopy(dest, start);
  start[2] += STEPSIZE + 1;

  const trace = PM_PlayerMove(start, dest);
  if (!trace.startsolid && !trace.allsolid) {
    // walked up the step
    VectorCopy(trace.endpos, pmove.origin);
    return;
  }

  PM_FlyMove();
}

/*
===================
PM_GroundMove

Player is on ground, with no upwards velocity
===================
*/
function PM_GroundMove() {
  pmove.velocity[2] = 0;
  if (
    pmove.velocity[0] === 0 && pmove.velocity[1] === 0 &&
    pmove.velocity[2] === 0
  ) {
    return;
  }

  // first try just moving to the destination
  const dest = _pm_groundmove_dest;
  dest[0] = pmove.origin[0] + pmove.velocity[0] * frametime;
  dest[1] = pmove.origin[1] + pmove.velocity[1] * frametime;
  dest[2] = pmove.origin[2];

  // first try moving directly to the next spot
  let trace = PM_PlayerMove(pmove.origin, dest);
  if (trace.fraction === 1) {
    VectorCopy(trace.endpos, pmove.origin);
    return;
  }

  // try sliding forward both on ground and up 16 pixels
  // take the move that goes farthest
  const original = _pm_groundmove_original;
  const originalvel = _pm_groundmove_originalvel;
  VectorCopy(pmove.origin, original);
  VectorCopy(pmove.velocity, originalvel);

  // slide move
  PM_FlyMove();

  const down = _pm_groundmove_down;
  const downvel = _pm_groundmove_downvel;
  VectorCopy(pmove.origin, down);
  VectorCopy(pmove.velocity, downvel);

  VectorCopy(original, pmove.origin);
  VectorCopy(originalvel, pmove.velocity);

  // move up a stair height
  VectorCopy(pmove.origin, dest);
  dest[2] += STEPSIZE;
  trace = PM_PlayerMove(pmove.origin, dest);
  if (!trace.startsolid && !trace.allsolid) {
    VectorCopy(trace.endpos, pmove.origin);
  }

  // slide move
  PM_FlyMove();

  // press down the stepheight
  VectorCopy(pmove.origin, dest);
  dest[2] -= STEPSIZE;
  trace = PM_PlayerMove(pmove.origin, dest);
  if (trace.plane.normal[2] < 0.7) {
    // use down move
    VectorCopy(down, pmove.origin);
    VectorCopy(downvel, pmove.velocity);
    return;
  }

  if (!trace.startsolid && !trace.allsolid) {
    VectorCopy(trace.endpos, pmove.origin);
  }

  const upMove = _pm_groundmove_up;
  VectorCopy(pmove.origin, upMove);

  // decide which one went farther
  const downdist = (down[0] - original[0]) * (down[0] - original[0]) +
    (down[1] - original[1]) * (down[1] - original[1]);
  const updist = (upMove[0] - original[0]) * (upMove[0] - original[0]) +
    (upMove[1] - original[1]) * (upMove[1] - original[1]);

  if (downdist > updist) {
    VectorCopy(down, pmove.origin);
    VectorCopy(downvel, pmove.velocity);
  } else {
    // copy z value from slide move
    pmove.velocity[2] = downvel[2];
  }
}

/*
===================
PM_AirMove
===================
*/
function PM_AirMove() {
  const fmove = pmove.cmd.forwardmove;
  const smove = pmove.cmd.sidemove;

  forward[2] = 0;
  right[2] = 0;
  VectorNormalize(forward);
  VectorNormalize(right);

  const wishvel = _pm_airmove_wishvel;
  for (let i = 0; i < 2; i++) {
    wishvel[i] = forward[i] * fmove + right[i] * smove;
  }
  wishvel[2] = 0;

  const wishdir = _pm_airmove_wishdir;
  VectorCopy(wishvel, wishdir);
  let wishspeed = VectorNormalize(wishdir);

  // clamp to server defined max speed
  if (wishspeed > movevars.maxspeed) {
    VectorScale(wishvel, movevars.maxspeed / wishspeed, wishvel);
    wishspeed = movevars.maxspeed;
  }

  if (onground !== -1) {
    pmove.velocity[2] = 0;
    PM_Accelerate(wishdir, wishspeed, movevars.accelerate);
    pmove.velocity[2] -= movevars.entgravity * movevars.gravity * frametime;
    PM_GroundMove();
  } else {
    // not on ground, so little effect on velocity
    PM_AirAccelerate(wishdir, wishspeed, movevars.accelerate);

    // add gravity
    pmove.velocity[2] -= movevars.entgravity * movevars.gravity * frametime;

    PM_FlyMove();
  }
}

/*
=============
PM_CatagorizePosition
=============
*/
function PM_CatagorizePosition() {
  const point = _pm_catpos_point;

  // if the player hull point one unit down is solid, the player is on ground

  // see if standing on something solid
  point[0] = pmove.origin[0];
  point[1] = pmove.origin[1];
  point[2] = pmove.origin[2] - 1;

  if (pmove.velocity[2] > 180) {
    onground = -1;
  } else {
    const tr = PM_PlayerMove(pmove.origin, point);
    if (tr.plane.normal[2] < 0.7) {
      onground = -1; // too steep
    } else {
      onground = tr.ent;
    }

    if (onground !== -1) {
      pmove.waterjumptime = 0;
      if (!tr.startsolid && !tr.allsolid) {
        VectorCopy(tr.endpos, pmove.origin);
      }
    }

    // standing on an entity other than the world
    if (tr.ent > 0) {
      if (pmove.numtouch < pmove.touchindex.length) {
        pmove.touchindex[pmove.numtouch] = tr.ent;
        pmove.numtouch++;
      }
    }
  }

  // get waterlevel
  waterlevel = 0;
  watertype = CONTENTS_EMPTY;

  point[2] = pmove.origin[2] + player_mins[2] + 1;
  let cont = PM_PointContents(point);

  if (cont <= CONTENTS_WATER) {
    watertype = cont;
    waterlevel = 1;
    point[2] = pmove.origin[2] + (player_mins[2] + player_maxs[2]) * 0.5;
    cont = PM_PointContents(point);
    if (cont <= CONTENTS_WATER) {
      waterlevel = 2;
      point[2] = pmove.origin[2] + 22;
      cont = PM_PointContents(point);
      if (cont <= CONTENTS_WATER) {
        waterlevel = 3;
      }
    }
  }
}

/*
=============
JumpButton
=============
*/
function JumpButton() {
  if (pmove.dead) {
    pmove.oldbuttons |= BUTTON_JUMP; // don't jump again until released
    return;
  }

  if (pmove.waterjumptime > 0) {
    pmove.waterjumptime -= frametime;
    if (pmove.waterjumptime < 0) {
      pmove.waterjumptime = 0;
    }
    return;
  }

  if (waterlevel >= 2) {
    // swimming, not jumping
    onground = -1;

    if (watertype === CONTENTS_WATER) {
      pmove.velocity[2] = 100;
    } else if (watertype === CONTENTS_SLIME) {
      pmove.velocity[2] = 80;
    } else {
      pmove.velocity[2] = 50;
    }
    return;
  }

  if (onground === -1) {
    return; // in air, so no effect
  }

  if (pmove.oldbuttons & BUTTON_JUMP) {
    return; // don't pogo stick
  }

  onground = -1;
  pmove.velocity[2] += 270;

  pmove.oldbuttons |= BUTTON_JUMP; // don't jump again until released
}

/*
=============
CheckWaterJump
=============
*/
function CheckWaterJump() {
  if (pmove.waterjumptime > 0) {
    return;
  }

  // don't hop out if we just jumped in
  if (pmove.velocity[2] < -180) {
    return;
  }

  // see if near an edge
  const flatforward = _pm_waterjump_flatforward;
  flatforward[0] = forward[0];
  flatforward[1] = forward[1];
  flatforward[2] = 0;
  VectorNormalize(flatforward);

  const spot = _pm_waterjump_spot;
  VectorMA(pmove.origin, 24, flatforward, spot);
  spot[2] += 8;
  let cont = PM_PointContents(spot);
  if (cont !== CONTENTS_SOLID) {
    return;
  }

  spot[2] += 24;
  cont = PM_PointContents(spot);
  if (cont !== CONTENTS_EMPTY) {
    return;
  }

  // jump out of water
  VectorScale(flatforward, 50, pmove.velocity);
  pmove.velocity[2] = 310;
  pmove.waterjumptime = 2; // safety net
  pmove.oldbuttons |= BUTTON_JUMP; // don't jump again until released
}

/*
=================
NudgePosition

If pmove.origin is in a solid position,
try nudging slightly on all axis to
allow for the cut precision of the net coordinates
=================
*/
function NudgePosition() {
  const base = _pm_nudge_base;
  VectorCopy(pmove.origin, base);

  for (let i = 0; i < 3; i++) {
    pmove.origin[i] = Math.floor(pmove.origin[i] * 8) * 0.125;
  }

  const sign = [0, -1, 1];

  for (let z = 0; z <= 2; z++) {
    for (let x = 0; x <= 2; x++) {
      for (let y = 0; y <= 2; y++) {
        pmove.origin[0] = base[0] + (sign[x] * 1.0 / 8);
        pmove.origin[1] = base[1] + (sign[y] * 1.0 / 8);
        pmove.origin[2] = base[2] + (sign[z] * 1.0 / 8);
        if (PM_TestPlayerPosition(pmove.origin)) {
          return;
        }
      }
    }
  }

  VectorCopy(base, pmove.origin);
}

/*
=============
SpectatorMove
=============
*/
function SpectatorMove() {
  // friction
  const speed = Length(pmove.velocity);
  if (speed < 1) {
    pmove.velocity.fill(0);
  } else {
    const friction = movevars.friction * 1.5; // extra friction
    const control = speed < movevars.stopspeed ? movevars.stopspeed : speed;
    const drop = control * friction * frametime;

    // scale the velocity
    let newspeed = speed - drop;
    if (newspeed < 0) {
      newspeed = 0;
    }
    newspeed /= speed;

    VectorScale(pmove.velocity, newspeed, pmove.velocity);
  }

  // accelerate
  const fmove = pmove.cmd.forwardmove;
  const smove = pmove.cmd.sidemove;

  VectorNormalize(forward);
  VectorNormalize(right);

  const wishvel = _pm_spectator_wishvel;
  for (let i = 0; i < 3; i++) {
    wishvel[i] = forward[i] * fmove + right[i] * smove;
  }
  wishvel[2] += pmove.cmd.upmove;

  const wishdir = _pm_spectator_wishdir;
  VectorCopy(wishvel, wishdir);
  let wishspeed = VectorNormalize(wishdir);

  // clamp to server defined max speed
  if (wishspeed > movevars.spectatormaxspeed) {
    VectorScale(wishvel, movevars.spectatormaxspeed / wishspeed, wishvel);
    wishspeed = movevars.spectatormaxspeed;
  }

  const currentspeed = DotProduct(pmove.velocity, wishdir);
  const addspeed = wishspeed - currentspeed;
  if (addspeed <= 0) {
    return;
  }

  let accelspeed = movevars.accelerate * frametime * wishspeed;
  if (accelspeed > addspeed) {
    accelspeed = addspeed;
  }

  for (let i = 0; i < 3; i++) {
    pmove.velocity[i] += accelspeed * wishdir[i];
  }

  // move
  VectorMA(pmove.origin, frametime, pmove.velocity, pmove.origin);
}

/*
==============================================================================

NETQUAKE PHYSICS MODE

The Icaro server simulates players with NetQuake physics (sv_user.js /
sv_phys.js, ported from WinQuake sv_user.c / sv_phys.c) plus the id1
QuakeC PlayerPreThink, not with QuakeWorld pmove. When pmove.nqphysics is
set, PlayerMove runs this client-side copy of one NetQuake server frame
for the player, so prediction agrees with the server:

	SV_ClientThink    friction / acceleration, using last frame's
	                  FL_ONGROUND and waterlevel
	PlayerPreThink    QC WaterMove damping, CheckWaterJump, PlayerJump
	SV_Physics_Client SV_CheckVelocity, SV_CheckWater, SV_AddGravity,
	                  SV_WalkMove (or fly / noclip)

What still cannot match client-side is listed in PM_NQ_PlayerMove.

==============================================================================
*/

const PITCH = 0;
const YAW = 1;
const ROLL = 2;

const _nq_angles = new Float32Array(3); // ent->v.angles
const _nq_wishvel = new Float32Array(3);
const _nq_wishdir = new Float32Array(3);
const _nq_start = new Float32Array(3);
const _nq_stop = new Float32Array(3);
const _nq_point = new Float32Array(3);
const _nq_flatforward = new Float32Array(3);
const _nq_planes = [];
for (let i = 0; i < MAX_CLIP_PLANES; i++) {
  _nq_planes[i] = new Float32Array(3);
}
const _nq_original_velocity = new Float32Array(3);
const _nq_primal_velocity = new Float32Array(3);
const _nq_new_velocity = new Float32Array(3);
const _nq_end = new Float32Array(3);
const _nq_dir = new Float32Array(3);
const _nq_steptrace_normal = new Float32Array(3); // steptrace.plane.normal in SV_WalkMove
const _nq_oldorg = new Float32Array(3);
const _nq_oldvel = new Float32Array(3);
const _nq_nosteporg = new Float32Array(3);
const _nq_nostepvel = new Float32Array(3);
const _nq_upmove = new Float32Array(3);
const _nq_downmove = new Float32Array(3);
const _nq_unstick_oldorg = new Float32Array(3);
const _nq_unstick_dir = new Float32Array(3);
const _nq_into = new Float32Array(3);
const _nq_side = new Float32Array(3);

/*
===============
PM_NQ_CalcRoll

V_CalcRoll (WinQuake view.c), which SV_ClientThink uses to roll the
player's angles by up to 4 * cl_rollangle while strafing. The roll
tilts the right vector, so it changes strafe acceleration slightly.
===============
*/
function PM_NQ_CalcRoll(angles, velocity) {
  AngleVectors(angles, forward, right, up);
  let side = DotProduct(velocity, right);
  const sign = side < 0 ? -1 : 1;
  side = Math.abs(side);

  const value = movevars.rollangle;
  if (side < movevars.rollspeed) {
    side = side * value / movevars.rollspeed;
  } else {
    side = value;
  }

  return side * sign;
}

/*
==================
PM_NQ_UserFriction

SV_UserFriction (WinQuake sv_user.c). Unlike PM_Friction: 2D speed,
edge probe is a point trace through hull 0, edge factor is the
edgefriction cvar, no water branch (SV_WaterMove has its own).
==================
*/
function PM_NQ_UserFriction() {
  const vel = pmove.velocity;

  const speed = Math.sqrt(vel[0] * vel[0] + vel[1] * vel[1]);
  if (speed === 0) {
    return;
  }

  // if the leading edge is over a dropoff, increase friction
  const start = _nq_start;
  const stop = _nq_stop;
  start[0] = stop[0] = pmove.origin[0] + vel[0] / speed * 16;
  start[1] = stop[1] = pmove.origin[1] + vel[1] / speed * 16;
  start[2] = pmove.origin[2] + player_mins[2];
  stop[2] = start[2] - 34;

  const trace = PM_NQ_PointMove(start, stop);

  let friction;
  if (trace.fraction === 1) {
    friction = movevars.friction * movevars.edgefriction;
  } else {
    friction = movevars.friction;
  }

  // apply friction
  const control = speed < movevars.stopspeed ? movevars.stopspeed : speed;
  let newspeed = speed - frametime * control * friction;

  if (newspeed < 0) {
    newspeed = 0;
  }
  newspeed /= speed;

  vel[0] = vel[0] * newspeed;
  vel[1] = vel[1] * newspeed;
  vel[2] = vel[2] * newspeed;
}

/*
===================
PM_NQ_WaterMove

SV_WaterMove (WinQuake sv_user.c): full-pitch v_angle, sv_friction
water drag, sv_accelerate. No step press-down (that is QW pmove only).
===================
*/
function PM_NQ_WaterMove() {
  const wishvel = _nq_wishvel;

  // user intentions
  AngleVectors(pmove.angles, forward, right, up);

  for (let i = 0; i < 3; i++) {
    wishvel[i] = forward[i] * pmove.cmd.forwardmove +
      right[i] * pmove.cmd.sidemove;
  }

  if (
    pmove.cmd.forwardmove === 0 && pmove.cmd.sidemove === 0 &&
    pmove.cmd.upmove === 0
  ) {
    wishvel[2] -= 60; // drift towards bottom
  } else {
    wishvel[2] += pmove.cmd.upmove;
  }

  let wishspeed = Length(wishvel);
  if (wishspeed > movevars.maxspeed) {
    VectorScale(wishvel, movevars.maxspeed / wishspeed, wishvel);
    wishspeed = movevars.maxspeed;
  }
  wishspeed *= 0.7;

  // water friction
  const vel = pmove.velocity;
  const speed = Length(vel);
  let newspeed;
  if (speed !== 0) {
    newspeed = speed - frametime * speed * movevars.friction;
    if (newspeed < 0) {
      newspeed = 0;
    }
    VectorScale(vel, newspeed / speed, vel);
  } else {
    newspeed = 0;
  }

  // water acceleration
  if (wishspeed === 0) {
    return;
  }

  const addspeed = wishspeed - newspeed;
  if (addspeed <= 0) {
    return;
  }

  VectorNormalize(wishvel);
  let accelspeed = movevars.accelerate * wishspeed * frametime;
  if (accelspeed > addspeed) {
    accelspeed = addspeed;
  }

  for (let i = 0; i < 3; i++) {
    vel[i] += accelspeed * wishvel[i];
  }
}

/*
===================
PM_NQ_AirMove

SV_AirMove (WinQuake sv_user.c). The wish direction comes from
ent->v.angles, whose pitch is -v_angle/3. Z is zeroed afterwards and the
vector is not renormalised, so looking up or down slows the player.
===================
*/
function PM_NQ_AirMove() {
  AngleVectors(_nq_angles, forward, right, up);

  let fmove = pmove.cmd.forwardmove;
  const smove = pmove.cmd.sidemove;

  // hack to not let you back into teleporter (sv.time < teleport_time)
  if (pmove.teleporttime > 0 && fmove < 0) {
    fmove = 0;
  }

  const wishvel = _nq_wishvel;
  for (let i = 0; i < 3; i++) {
    wishvel[i] = forward[i] * fmove + right[i] * smove;
  }

  if (pmove.movetype !== PM_MOVETYPE_WALK) {
    wishvel[2] = pmove.cmd.upmove;
  } else {
    wishvel[2] = 0;
  }

  const wishdir = _nq_wishdir;
  VectorCopy(wishvel, wishdir);
  let wishspeed = VectorNormalize(wishdir);
  if (wishspeed > movevars.maxspeed) {
    VectorScale(wishvel, movevars.maxspeed / wishspeed, wishvel);
    wishspeed = movevars.maxspeed;
  }

  if (pmove.movetype === PM_MOVETYPE_NOCLIP) {
    // noclip
    VectorCopy(wishvel, pmove.velocity);
  } else if (pmove.onground) {
    PM_NQ_UserFriction();
    PM_Accelerate(wishdir, wishspeed, movevars.accelerate); // SV_Accelerate
  } else {
    // not on ground, so little effect on velocity.
    // SV_AirAccelerate: same maths as PM_AirAccelerate (cap 30,
    // sv_accelerate, scaled by the full wishspeed).
    PM_AirAccelerate(wishdir, wishspeed, movevars.accelerate);
  }
}

/*
===================
PM_NQ_NoclipMove

SV_NoclipMove (johnfitz, FitzQuake/Ironwail sv_user.c), used when the
server's sv_altnoclip is set: fly where v_angle points, upmove doubled,
capped at sv_maxspeed.
===================
*/
function PM_NQ_NoclipMove() {
  AngleVectors(pmove.angles, forward, right, up);

  const velocity = pmove.velocity;
  const fmove = pmove.cmd.forwardmove;
  const smove = pmove.cmd.sidemove;
  velocity[0] = forward[0] * fmove + right[0] * smove;
  velocity[1] = forward[1] * fmove + right[1] * smove;
  velocity[2] = forward[2] * fmove + right[2] * smove;
  velocity[2] += pmove.cmd.upmove * 2; // doubled to match running speed

  if (Length(velocity) > movevars.maxspeed) {
    VectorNormalize(velocity);
    VectorScale(velocity, movevars.maxspeed, velocity);
  }
}

/*
===================
PM_NQ_ClientThink

SV_ClientThink (WinQuake sv_user.c). pmove.angles is v_angle (the
quantised angles the server read from clc_move).
===================
*/
function PM_NQ_ClientThink() {
  // DropPunchAngle. The start value is the punchangle of the last
  // svc_clientdata; the QC may set a new one later, which is not predicted.
  const punch = pmove.punchangle;
  let punchlen = VectorNormalize(punch);
  punchlen -= 10 * frametime;
  if (punchlen < 0) {
    punchlen = 0;
  }
  VectorScale(punch, punchlen, punch);

  // show 1/3 the pitch angle and all the roll angle.
  // V_CalcRoll reads last frame's ent->v.angles; the previous pitch and
  // yaw are not kept, so this frame's are used with last frame's roll.
  // v_angle + punchangle, as SV_ClientThink adds it.
  _nq_angles[PITCH] = -(pmove.angles[PITCH] + punch[PITCH]) / 3;
  _nq_angles[YAW] = pmove.angles[YAW] + punch[YAW];
  _nq_angles[ROLL] = pmove.roll;
  pmove.roll = PM_NQ_CalcRoll(_nq_angles, pmove.velocity) * 4;
  _nq_angles[ROLL] = pmove.roll;

  // FL_WATERJUMP is pmove.waterjumptime > 0; it counts down the two
  // seconds the QC sets in ent->v.teleport_time.
  if (pmove.waterjumptime > 0) {
    // SV_WaterJump
    pmove.waterjumptime -= frametime;
    if (pmove.waterjumptime <= 0 || waterlevel === 0) {
      pmove.waterjumptime = 0;
      pmove.teleporttime = 0; // SV_WaterJump clears teleport_time
    }
    pmove.velocity[0] = pmove.movedir[0];
    pmove.velocity[1] = pmove.movedir[1];
    return;
  }

  // walk
  // johnfitz -- alternate noclip
  if (pmove.movetype === PM_MOVETYPE_NOCLIP && movevars.altnoclip !== 0) {
    PM_NQ_NoclipMove();
    return;
  }

  if (waterlevel >= 2 && pmove.movetype !== PM_MOVETYPE_NOCLIP) {
    PM_NQ_WaterMove();
    return;
  }

  PM_NQ_AirMove();
}

/*
=============
PM_NQ_CheckWaterJump

id1 QuakeC CheckWaterJump (client.qc), called from PlayerPreThink when
waterlevel == 2. Uses two traceline ( ..., TRUE, ... ) point traces where
QW pmove uses point contents.
=============
*/
function PM_NQ_CheckWaterJump() {
  // makevectors ( self.angles ); v_forward_z = 0; normalize
  AngleVectors(_nq_angles, forward, right, up);
  const flat = _nq_flatforward;
  flat[0] = forward[0];
  flat[1] = forward[1];
  flat[2] = 0;
  VectorNormalize(flat);

  const start = _nq_start;
  const end = _nq_stop;
  VectorCopy(pmove.origin, start);
  start[2] += 8;
  VectorMA(start, 24, flat, end);

  let trace = PM_NQ_PointMove(start, end);
  if (trace.fraction < 1) {
    // solid at waist
    start[2] += player_maxs[2] - 8;
    VectorMA(start, 24, flat, end);
    VectorScale(trace.plane.normal, -50, pmove.movedir);
    trace = PM_NQ_PointMove(start, end);
    if (trace.fraction === 1) {
      // open at eye level
      pmove.waterjumptime = 2; // FL_WATERJUMP
      pmove.teleporttime = 2; // teleport_time = time + 2
      pmove.velocity[2] = 225;
      pmove.oldbuttons |= BUTTON_JUMP; // clear FL_JUMPRELEASED
    }
  }
}

/*
=============
PM_NQ_PlayerJump

id1 QuakeC PlayerJump (client.qc). Runs after SV_ClientThink, so the jump
frame gets ground friction and acceleration before the +270.
FL_JUMPRELEASED is !( pmove.oldbuttons & BUTTON_JUMP ).
=============
*/
function PM_NQ_PlayerJump() {
  if (pmove.waterjumptime > 0) {
    return;
  }

  if (waterlevel >= 2) {
    if (watertype === CONTENTS_WATER) {
      pmove.velocity[2] = 100;
    } else if (watertype === CONTENTS_SLIME) {
      pmove.velocity[2] = 80;
    } else {
      pmove.velocity[2] = 50;
    }
    return;
  }

  if (!pmove.onground) {
    return;
  }

  if (pmove.oldbuttons & BUTTON_JUMP) {
    return; // don't pogo stick
  }

  pmove.oldbuttons |= BUTTON_JUMP;
  pmove.onground = false; // don't stairwalk
  pmove.velocity[2] += 270;
}

/*
=============
PM_NQ_CheckWater

SV_CheckWater (WinQuake sv_phys.c). Currents count as water, as in
SV_PointContents. Returns true when waterlevel > 1.
=============
*/
function PM_NQ_CheckWater() {
  const point = _nq_point;
  point[0] = pmove.origin[0];
  point[1] = pmove.origin[1];
  point[2] = pmove.origin[2] + player_mins[2] + 1;

  waterlevel = 0;
  watertype = CONTENTS_EMPTY;

  let cont = PM_NQ_PointContents(point);
  if (cont <= CONTENTS_WATER) {
    watertype = cont;
    waterlevel = 1;
    point[2] = pmove.origin[2] + (player_mins[2] + player_maxs[2]) * 0.5;
    cont = PM_NQ_PointContents(point);
    if (cont <= CONTENTS_WATER) {
      waterlevel = 2;
      point[2] = pmove.origin[2] + 22; // view_ofs
      cont = PM_NQ_PointContents(point);
      if (cont <= CONTENTS_WATER) {
        waterlevel = 3;
      }
    }
  }

  return waterlevel > 1;
}

// SV_PointContents (WinQuake world.c): world hull 0, currents become water
function PM_NQ_PointContents(p) {
  const cont = PM_PointContents(p);
  if (cont <= CONTENTS_CURRENT_0 && cont >= CONTENTS_CURRENT_DOWN) {
    return CONTENTS_WATER;
  }
  return cont;
}

/*
============
PM_NQ_FlyMove

SV_FlyMove (WinQuake sv_phys.c). Differs from PM_FlyMove: only allsolid
traps, original_velocity is refreshed after progress, a floor hit on a BSP
physent sets FL_ONGROUND, and the last vertical-plane hit is saved for
SV_WallFriction when savestep is true.
============
*/
function PM_NQ_FlyMove(time, savestep) {
  const numbumps = 4;
  let blocked = 0;

  const original_velocity = _nq_original_velocity;
  const primal_velocity = _nq_primal_velocity;
  const new_velocity = _nq_new_velocity;
  const planes = _nq_planes;
  const end = _nq_end;
  VectorCopy(pmove.velocity, original_velocity);
  VectorCopy(pmove.velocity, primal_velocity);
  let numplanes = 0;

  let time_left = time;

  for (let bumpcount = 0; bumpcount < numbumps; bumpcount++) {
    if (
      pmove.velocity[0] === 0 && pmove.velocity[1] === 0 &&
      pmove.velocity[2] === 0
    ) {
      break;
    }

    for (let i = 0; i < 3; i++) {
      end[i] = pmove.origin[i] + time_left * pmove.velocity[i];
    }

    const trace = PM_PlayerMove(pmove.origin, end);

    if (trace.allsolid) {
      // entity is trapped in another solid
      pmove.velocity.fill(0);
      return 3;
    }

    if (trace.fraction > 0) {
      // actually covered some distance
      VectorCopy(trace.endpos, pmove.origin);
      VectorCopy(pmove.velocity, original_velocity);
      numplanes = 0;
    }

    if (trace.fraction === 1) {
      break; // moved the entire distance
    }

    if (trace.plane.normal[2] > 0.7) {
      blocked |= 1; // floor
      // only SOLID_BSP ground counts: world and brush physents,
      // not other players (SOLID_SLIDEBOX) or box physents
      if (trace.ent >= 0 && pmove.physents[trace.ent].model != null) {
        pmove.onground = true;
      }
    }
    if (trace.plane.normal[2] === 0) {
      blocked |= 2; // step
      if (savestep) {
        VectorCopy(trace.plane.normal, _nq_steptrace_normal);
      }
    }

    time_left -= time_left * trace.fraction;

    // cliped to another plane
    if (numplanes >= MAX_CLIP_PLANES) {
      // this shouldn't really happen
      pmove.velocity.fill(0);
      return 3;
    }

    VectorCopy(trace.plane.normal, planes[numplanes]);
    numplanes++;

    // modify original_velocity so it parallels all of the clip planes
    let i;
    for (i = 0; i < numplanes; i++) {
      PM_ClipVelocity(original_velocity, planes[i], new_velocity, 1);
      let j;
      for (j = 0; j < numplanes; j++) {
        if (j !== i) {
          if (DotProduct(new_velocity, planes[j]) < 0) {
            break; // not ok
          }
        }
      }
      if (j === numplanes) {
        break;
      }
    }

    if (i !== numplanes) {
      // go along this plane
      VectorCopy(new_velocity, pmove.velocity);
    } else {
      // go along the crease
      if (numplanes !== 2) {
        pmove.velocity.fill(0);
        return 7;
      }
      CrossProduct(planes[0], planes[1], _nq_dir);
      const d = DotProduct(_nq_dir, pmove.velocity);
      VectorScale(_nq_dir, d, pmove.velocity);
    }

    // if original velocity is against the original velocity, stop dead
    // to avoid tiny occilations in sloping corners
    if (DotProduct(pmove.velocity, primal_velocity) <= 0) {
      pmove.velocity.fill(0);
      return blocked;
    }
  }

  return blocked;
}

/*
============
PM_NQ_PushEntity

SV_PushEntity (WinQuake sv_phys.c) for the player: trace the hull by
push and take the end position, even when the trace starts in solid.
============
*/
function PM_NQ_PushEntity(push) {
  VectorAdd(pmove.origin, push, _nq_end);
  const trace = PM_PlayerMove(pmove.origin, _nq_end);
  VectorCopy(trace.endpos, pmove.origin);
  return trace;
}

/*
============
PM_NQ_WallFriction

SV_WallFriction (WinQuake sv_phys.c): extra friction when running into
a wall, based on the full-pitch view angle.
============
*/
function PM_NQ_WallFriction() {
  AngleVectors(pmove.angles, forward, right, up);
  let d = DotProduct(_nq_steptrace_normal, forward);

  d += 0.5;
  if (d >= 0) {
    return;
  }

  // cut the tangential velocity
  const i = DotProduct(_nq_steptrace_normal, pmove.velocity);
  VectorScale(_nq_steptrace_normal, i, _nq_into);
  VectorSubtract(pmove.velocity, _nq_into, _nq_side);

  pmove.velocity[0] = _nq_side[0] * (1 + d);
  pmove.velocity[1] = _nq_side[1] * (1 + d);
}

/*
=====================
PM_NQ_TryUnstick

SV_TryUnstick (WinQuake sv_phys.c)
=====================
*/
function PM_NQ_TryUnstick(oldvel) {
  const oldorg = _nq_unstick_oldorg;
  const dir = _nq_unstick_dir;
  VectorCopy(pmove.origin, oldorg);
  dir.fill(0);

  for (let i = 0; i < 8; i++) {
    // try pushing a little in an axial direction
    switch (i) {
      case 0:
        dir[0] = 2;
        dir[1] = 0;
        break;
      case 1:
        dir[0] = 0;
        dir[1] = 2;
        break;
      case 2:
        dir[0] = -2;
        dir[1] = 0;
        break;
      case 3:
        dir[0] = 0;
        dir[1] = -2;
        break;
      case 4:
        dir[0] = 2;
        dir[1] = 2;
        break;
      case 5:
        dir[0] = -2;
        dir[1] = 2;
        break;
      case 6:
        dir[0] = 2;
        dir[1] = -2;
        break;
      case 7:
        dir[0] = -2;
        dir[1] = -2;
        break;
    }

    PM_NQ_PushEntity(dir);

    // retry the original move
    pmove.velocity[0] = oldvel[0];
    pmove.velocity[1] = oldvel[1];
    pmove.velocity[2] = 0;
    const clip = PM_NQ_FlyMove(0.1, false); // C passes its own steptrace

    if (
      Math.abs(oldorg[1] - pmove.origin[1]) > 4 ||
      Math.abs(oldorg[0] - pmove.origin[0]) > 4
    ) {
      return clip;
    }

    // go back to the original pos and try again
    VectorCopy(oldorg, pmove.origin);
  }

  pmove.velocity.fill(0);
  return 7; // still not moving
}

/*
=====================
PM_NQ_WalkMove

SV_WalkMove (WinQuake sv_phys.c)
=====================
*/
function PM_NQ_WalkMove() {
  const oldorg = _nq_oldorg;
  const oldvel = _nq_oldvel;

  // do a regular slide move unless it looks like you ran into a step
  const oldonground = pmove.onground;
  pmove.onground = false;

  VectorCopy(pmove.origin, oldorg);
  VectorCopy(pmove.velocity, oldvel);

  let clip = PM_NQ_FlyMove(frametime, true);

  if (!(clip & 2)) {
    return; // move didn't block on a step
  }

  if (!oldonground && waterlevel === 0) {
    return; // don't stair up while jumping
  }

  if (pmove.movetype !== PM_MOVETYPE_WALK) {
    return; // gibbed by a trigger
  }

  // sv_nostep is not known client-side; it defaults to 0

  if (pmove.waterjumptime > 0) {
    return; // FL_WATERJUMP
  }

  VectorCopy(pmove.origin, _nq_nosteporg);
  VectorCopy(pmove.velocity, _nq_nostepvel);

  // try moving up and forward to go up a step
  VectorCopy(oldorg, pmove.origin); // back to start pos

  _nq_upmove.fill(0);
  _nq_downmove.fill(0);
  _nq_upmove[2] = STEPSIZE;
  _nq_downmove[2] = -STEPSIZE + oldvel[2] * frametime;

  // move up
  PM_NQ_PushEntity(_nq_upmove);

  // move forward
  pmove.velocity[0] = oldvel[0];
  pmove.velocity[1] = oldvel[1];
  pmove.velocity[2] = 0;
  clip = PM_NQ_FlyMove(frametime, true);

  // check for stuckness, possibly due to the limited precision of floats
  // in the clipping hulls
  if (clip) {
    if (
      Math.abs(oldorg[1] - pmove.origin[1]) < 0.03125 &&
      Math.abs(oldorg[0] - pmove.origin[0]) < 0.03125
    ) {
      // stepping up didn't make any progress
      clip = PM_NQ_TryUnstick(oldvel);
    }
  }

  // extra friction based on view angle
  if (clip & 2) {
    PM_NQ_WallFriction();
  }

  // move down
  const downtrace = PM_NQ_PushEntity(_nq_downmove);

  if (downtrace.plane.normal[2] > 0.7) {
    // The C sets FL_ONGROUND here only if the *player* is SOLID_BSP,
    // which a player never is, so a step-up leaves the flag as the
    // fly moves left it.
  } else {
    // if the push down didn't end up on good ground, use the move without
    // the step up.  This happens near wall / slope combinations, and can
    // cause the player to hop up higher on a slope too steep to climb
    VectorCopy(_nq_nosteporg, pmove.origin);
    VectorCopy(_nq_nostepvel, pmove.velocity);
  }
}

/*
=============
PM_NQ_PlayerMove

One NetQuake server frame for the player, in server order (Host_ServerFrame:
SV_RunClients, then SV_Physics). In: pmove.origin, velocity, angles (v_angle),
cmd, onground, waterlevel / watertype (-1 = recompute), roll, movedir,
waterjumptime, oldbuttons, movetype. Out: the same fields.

Also in/out: teleporttime (seconds of teleport_time left) and punchangle.
They come from svc_playerinfo PF_TELEPORT and svc_clientdata, and tick down
here as they do on the server.

Not modelled, because the client is never told the inputs:
	- QC changes to punchangle or teleport_time made after the last update
	- fixangle: the server sends it as svc_setangle, which sets the view
	  angles the next commands carry; nothing is predicted for it
	- SV_CheckStuck (NudgePosition handles coordinate rounding instead)
	- touch / impact functions, triggers
	- dead players: CL_PredictMove does not predict them
=============
*/
function PM_NQ_PlayerMove() {
  if (pmove.movetype === PM_MOVETYPE_NOCLIP) {
    // SV_AirMove sets velocity to wishvel; SV_Physics_Client then
    // moves without clipping
    VectorCopy(pmove.cmd.angles, pmove.angles);
    if (pmove.waterlevel < 0) {
      waterlevel = 0;
      watertype = CONTENTS_EMPTY;
    } else {
      waterlevel = pmove.waterlevel;
      watertype = pmove.watertype;
    }
    PM_NQ_ClientThink();
    VectorMA(pmove.origin, frametime, pmove.velocity, pmove.origin);
    onground = pmove.onground ? 0 : -1;
    return;
  }

  NudgePosition();

  // v_angle is the command's angles
  VectorCopy(pmove.cmd.angles, pmove.angles);

  // last frame's SV_CheckWater result
  if (pmove.waterlevel < 0) {
    PM_NQ_CheckWater();
  } else {
    waterlevel = pmove.waterlevel;
    watertype = pmove.watertype;
  }

  //
  // SV_RunClients -> SV_ClientThink
  //
  PM_NQ_ClientThink();

  //
  // SV_Physics_Client -> QC PlayerPreThink
  //

  // QC WaterMove: extra water drag
  if (waterlevel !== 0 && !(pmove.waterjumptime > 0)) {
    const scale = 1 - 0.8 * waterlevel * frametime;
    VectorScale(pmove.velocity, scale, pmove.velocity);
  }

  if (waterlevel === 2) {
    PM_NQ_CheckWaterJump();
  }

  if (pmove.cmd.buttons & BUTTON_JUMP) {
    PM_NQ_PlayerJump();
  } else {
    pmove.oldbuttons &= ~BUTTON_JUMP; // FL_JUMPRELEASED
  }

  //
  // SV_Physics_Client
  //

  // SV_CheckVelocity
  for (let i = 0; i < 3; i++) {
    if (pmove.velocity[i] > movevars.maxvelocity) {
      pmove.velocity[i] = movevars.maxvelocity;
    } else if (pmove.velocity[i] < -movevars.maxvelocity) {
      pmove.velocity[i] = -movevars.maxvelocity;
    }
  }

  if (pmove.movetype === PM_MOVETYPE_FLY) {
    PM_NQ_FlyMove(frametime, false);
  } else {
    // MOVETYPE_WALK
    if (!PM_NQ_CheckWater() && !(pmove.waterjumptime > 0)) {
      pmove.velocity[2] -= movevars.entgravity * movevars.gravity * frametime; // SV_AddGravity
    }

    PM_NQ_WalkMove();
  }

  pmove.waterlevel = waterlevel;
  pmove.watertype = watertype;
  onground = pmove.onground ? 0 : -1;
}

/*
=============
PM_NQ_CheckGround

Best guess at FL_ONGROUND for a state the server did not report it for
(other players): standing on a BSP physent within one unit, and not
moving up fast (the PM_CatagorizePosition test).
=============
*/
export function PM_NQ_CheckGround(origin, velocity) {
  if (velocity[2] > 180) {
    return false;
  }

  _nq_point[0] = origin[0];
  _nq_point[1] = origin[1];
  _nq_point[2] = origin[2] - 1;

  const tr = PM_PlayerMove(origin, _nq_point);
  if (tr.fraction === 1 || tr.plane.normal[2] < 0.7) {
    return false;
  }

  return tr.ent >= 0 && pmove.physents[tr.ent].model != null;
}

/*
=============
PlayerMove

Returns with origin, angles, and velocity modified in place.

Numtouch and touchindex[] will be set if any of the physents
were contacted during the move.
=============
*/
export function PlayerMove() {
  frametime = pmove.cmd.msec * 0.001;
  pmove.numtouch = 0;

  if (pmove.nqphysics === true && pmove.spectator !== true) {
    PM_NQ_PlayerMove();
    // sv.time advances by one frame; teleport_time stays put
    if (pmove.teleporttime > 0) {
      pmove.teleporttime -= frametime;
      if (pmove.teleporttime < 0) {
        pmove.teleporttime = 0;
      }
    }
    return;
  }

  AngleVectors(pmove.angles, forward, right, up);

  if (pmove.spectator) {
    SpectatorMove();
    return;
  }

  NudgePosition();

  // take angles directly from command
  VectorCopy(pmove.cmd.angles, pmove.angles);

  // set onground, watertype, and waterlevel
  PM_CatagorizePosition();

  if (waterlevel === 2) {
    CheckWaterJump();
  }

  if (pmove.velocity[2] < 0) {
    pmove.waterjumptime = 0;
  }

  if (pmove.cmd.buttons & BUTTON_JUMP) {
    JumpButton();
  } else {
    pmove.oldbuttons &= ~BUTTON_JUMP;
  }

  PM_Friction();

  if (waterlevel >= 2) {
    PM_WaterMove();
  } else {
    PM_AirMove();
  }

  // set onground, watertype, and waterlevel for final spot
  PM_CatagorizePosition();
}

/*
==============
Pmove_Init
==============
*/
export function Pmove_Init() {
  PM_InitBoxHull();
}
