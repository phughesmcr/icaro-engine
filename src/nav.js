// Navigation graph for agents: walkable points sampled from a map's BSP,
// linked where the player can walk or drop between them, with A* queries.
//
// Web-only addition: not in id's C. Quake has no navigation mesh (the 2021
// rerelease's bot .nav files are commercial data and cover only id1), so
// the graph is generated here from the loaded world model. It runs offline
// (tools/nav/nav_build.js, under Deno) and at map load in agent games
// (src/agent.js builds it on the level event, and its goto follows it).
// Nothing here touches window or document.
//
// How the graph is built (Nav_Build):
//   1. Floor faces (plane normal z > 0.7, not sky or liquid) of the world,
//      and the tops of doors and plats in their map positions, are sampled
//      on a grid (opts.grid, default 32 units). Each sample is settled onto
//      the floor with a hull 1 (player box) trace, and dropped if the player
//      box doesn't fit there. Samples nudged up to 16 units from the grid
//      point keep narrow places connected.
//   2. Each node is linked to the nodes in the 8 neighbouring grid cells
//      that the player can walk to: the move is simulated in steps of at
//      most 16 units (step up 18, move, settle down), as SV_StepMove does,
//      so stairs work and gaps in the floor break the link. A walk that
//      falls more than 18 units is a drop: a one-way link. From a node in
//      liquid, a higher neighbour near the surface is a swim link. A
//      neighbour the walk can't reach may be a jump link: up a ledge of up
//      to opts.jump (40) units, or over a short gap.
//   3. Entities from the entity lump mark nodes and links: func_door and
//      func_door_secret (links through a closed door's position), func_plat
//      (ride links between the plat's top and bottom positions),
//      trigger_teleport (links to the destination), trigger_changelevel
//      (exit nodes) and func_button (nodes that touch one).
//
// Brush entities are not in the world's clipping hull, so traces check
// their submodel hulls too: func_wall always blocks; doors and plats are
// only floors (a closed door doesn't block a link through it, but a bridge
// can be walked on), and a lowered plat also blocks nodes inside it.
//
// Coordinates are player origins (feet + 24), as the server stores them.
//
// Queries (Nav_FindPath, Nav_NearestNode) allocate nothing: they use
// scratch arrays owned by the graph, and the path they return is
// overwritten by the next query on the same graph.

import {
  SV_HullPointContents,
  SV_RecursiveHullCheck,
  trace_t,
} from "./world.js";
import {
  CONTENTS_LAVA,
  CONTENTS_SLIME,
  CONTENTS_SOLID,
  CONTENTS_WATER,
} from "./bspfile.js";

// Node flags
export const NAV_NODE_WATER = 1; // origin is in liquid
export const NAV_NODE_SLIME = 2; // feet are in slime
export const NAV_NODE_DOOR = 4; // player box touches a door's closed position
export const NAV_NODE_PLAT = 8; // stands on a plat (top or bottom position)
export const NAV_NODE_TELEPORT = 16; // inside a trigger_teleport
export const NAV_NODE_EXIT = 32; // inside a trigger_changelevel
export const NAV_NODE_BUTTON = 64; // player box touches a func_button
export const NAV_NODE_MOVER = 128; // stands on a door or plat, not the world

// Link flags
export const NAV_LINK_DROP = 1; // falls more than a step: one-way
export const NAV_LINK_DOOR = 2; // passes through a door's closed position
export const NAV_LINK_PLAT = 4; // rides a plat up or down
export const NAV_LINK_TELEPORT = 8; // through a teleporter
export const NAV_LINK_MOVER = 16; // walks on a door or plat (a bridge)
export const NAV_LINK_SLIME = 32; // touches slime
export const NAV_LINK_WATER = 64; // touches water
export const NAV_LINK_SWIM = 128; // swims up out of liquid
export const NAV_LINK_EXIT = 256; // passes through a trigger_changelevel
export const NAV_LINK_JUMP = 512; // needs a jump (up a ledge or over a gap)

const STEPSIZE = 18; // sv_phys.c
const PLAYER_MINS = [-16, -16, -24]; // VEC_HULL_MIN
const PLAYER_MAXS = [16, 16, 32]; // VEC_HULL_MAX
const SUBSTEP = 16; // longest walk simulation step
const FLOOR_Z = 0.7; // steepest walkable plane, as in SV_FlyMove
const MAX_WATER_DROP = 4096; // longest fall or sink into liquid linked

// Spawnflags ED_LoadFromFile filters on (pr_edict.c)
const SPAWNFLAG_NOT_EASY = 256;
const SPAWNFLAG_NOT_MEDIUM = 512;
const SPAWNFLAG_NOT_HARD = 1024;
const SPAWNFLAG_NOT_DEATHMATCH = 2048;

// doors.qc
const DOOR_GOLD_KEY = 8;
const DOOR_SILVER_KEY = 16;
const SECRET_YES_SHOOT = 16;

// gl_model.h (copied so this module needn't import the renderer)
const SURF_PLANEBACK = 2;
const SURF_DRAWSKY = 4;
const SURF_DRAWTURB = 0x10;

// Clip kinds
const CLIP_STATIC = 0; // blocks moves and fits (func_wall)
const CLIP_MOVER = 1; // a floor only: ignored when a trace starts inside it

const DEFAULT_OPTS = {
  grid: 32, // sample spacing, units
  maxdrop: 256, // longest drop linked (fall damage starts near 270)
  jump: 40, // highest jump linked (a standing jump peaks near 45); 0 for none
  skill: 1, // entity lump filter, as ED_LoadFromFile
  deathmatch: false,
};

/*
==============================================================================

TRACES (build time)

==============================================================================
*/

const tr = new trace_t();
const tr_sub = new trace_t();
const t_start = new Float32Array(3);
const t_end = new Float32Array(3);
const t_start_l = new Float32Array(3);
const t_end_l = new Float32Array(3);
const t_point = new Float32Array(3);

// Build context: set by Nav_Build for the traces below
let b_hull1 = null;
let b_hull0 = null;
let b_clips = [];
let trace_hit_clip = -1; // clip the last trace stopped on, -1 for the world

function trace_reset(t, end) {
  t.allsolid = true;
  t.startsolid = false;
  t.inopen = false;
  t.inwater = false;
  t.fraction = 1;
  t.endpos[0] = end[0];
  t.endpos[1] = end[1];
  t.endpos[2] = end[2];
  t.plane.normal[0] = 0;
  t.plane.normal[1] = 0;
  t.plane.normal[2] = 0;
  t.plane.dist = 0;
  t.ent = null;
}

// Player-box trace from t_start to t_end against the world and the clips
// (movers too when movers is true). The result is in tr; trace_hit_clip
// says what it stopped on. Like SV_Move with MOVE_NOMONSTERS, but on
// submodel hulls straight from the world model, so no server is needed.
function nav_trace(movers) {
  trace_reset(tr, t_end);
  trace_hit_clip = -1;
  SV_RecursiveHullCheck(
    b_hull1,
    b_hull1.firstclipnode,
    0,
    1,
    t_start,
    t_end,
    tr,
  );
  if (tr.allsolid === true || tr.startsolid === true) {
    return;
  }

  const lo0 = Math.min(t_start[0], t_end[0]),
    hi0 = Math.max(t_start[0], t_end[0]);
  const lo1 = Math.min(t_start[1], t_end[1]),
    hi1 = Math.max(t_start[1], t_end[1]);
  const lo2 = Math.min(t_start[2], t_end[2]),
    hi2 = Math.max(t_start[2], t_end[2]);
  for (let i = 0; i < b_clips.length; i++) {
    const c = b_clips[i];
    if (c.kind === CLIP_MOVER && movers !== true) {
      continue;
    }
    if (
      hi0 < c.emins[0] || lo0 > c.emaxs[0] || hi1 < c.emins[1] ||
      lo1 > c.emaxs[1] || hi2 < c.emins[2] || lo2 > c.emaxs[2]
    ) {
      continue;
    }

    for (let k = 0; k < 3; k++) {
      t_start_l[k] = t_start[k] - c.offset[k];
      t_end_l[k] = t_end[k] - c.offset[k];
    }

    trace_reset(tr_sub, t_end_l);
    SV_RecursiveHullCheck(
      b_hull1,
      c.headnode,
      0,
      1,
      t_start_l,
      t_end_l,
      tr_sub,
    );
    if (tr_sub.startsolid === true) {
      if (c.kind === CLIP_MOVER) {
        continue; // inside a door: it will open (or is the floor of another)
      }
      tr.startsolid = true;
      tr.fraction = 0;
      tr.endpos[0] = t_start[0];
      tr.endpos[1] = t_start[1];
      tr.endpos[2] = t_start[2];
      trace_hit_clip = i;
      return;
    }

    if (tr_sub.fraction < tr.fraction) {
      tr.fraction = tr_sub.fraction;
      tr.endpos[0] = tr_sub.endpos[0] + c.offset[0];
      tr.endpos[1] = tr_sub.endpos[1] + c.offset[1];
      tr.endpos[2] = tr_sub.endpos[2] + c.offset[2];
      tr.plane.normal[0] = tr_sub.plane.normal[0];
      tr.plane.normal[1] = tr_sub.plane.normal[1];
      tr.plane.normal[2] = tr_sub.plane.normal[2];
      trace_hit_clip = i;
    }
  }
}

// True if the player box fits at p: not in the world, a func_wall or a
// lowered plat
function nav_fits(p) {
  if (
    SV_HullPointContents(b_hull1, b_hull1.firstclipnode, p) === CONTENTS_SOLID
  ) {
    return false;
  }

  for (let i = 0; i < b_clips.length; i++) {
    const c = b_clips[i];
    if (c.blocks_fit !== true) {
      continue;
    }
    if (
      p[0] < c.emins[0] || p[0] > c.emaxs[0] || p[1] < c.emins[1] ||
      p[1] > c.emaxs[1] || p[2] < c.emins[2] || p[2] > c.emaxs[2]
    ) {
      continue;
    }
    t_point[0] = p[0] - c.offset[0];
    t_point[1] = p[1] - c.offset[1];
    t_point[2] = p[2] - c.offset[2];
    if (SV_HullPointContents(b_hull1, c.headnode, t_point) === CONTENTS_SOLID) {
      return false;
    }
  }

  return true;
}

function point_contents0(x, y, z) {
  t_point[0] = x;
  t_point[1] = y;
  t_point[2] = z;
  return SV_HullPointContents(b_hull0, b_hull0.firstclipnode, t_point);
}

function is_liquid(c) {
  return c <= CONTENTS_WATER && c !== CONTENTS_SOLID;
}

/*
==============================================================================

ENTITY LUMP

==============================================================================
*/

// The entity lump as a list of key/value objects (ED_ParseEdict's input)
function parse_entities(text) {
  const out = [];
  if (text === null || text === undefined) {
    return out;
  }

  const re = /"([^"]*)"|([{}])/g;
  let cur = null, key = null, m;
  while ((m = re.exec(text)) !== null) {
    if (m[2] === "{") {
      cur = {};
      key = null;
    } else if (m[2] === "}") {
      if (cur !== null) {
        out.push(cur);
      }
      cur = null;
    } else if (cur !== null) {
      if (key === null) {
        key = m[1];
      } else {
        cur[key] = m[1];
        key = null;
      }
    }
  }

  return out;
}

// ED_LoadFromFile's skill and deathmatch filter
function entity_spawns(e, opts) {
  const sf = e.spawnflags !== undefined ? (parseInt(e.spawnflags) | 0) : 0;
  if (opts.deathmatch === true) {
    return (sf & SPAWNFLAG_NOT_DEATHMATCH) === 0;
  }
  if (opts.skill === 0) {
    return (sf & SPAWNFLAG_NOT_EASY) === 0;
  }
  if (opts.skill === 1) {
    return (sf & SPAWNFLAG_NOT_MEDIUM) === 0;
  }
  return (sf & SPAWNFLAG_NOT_HARD) === 0;
}

function parse_vec(s) {
  const v = [0, 0, 0];
  if (s === undefined) {
    return v;
  }
  const p = s.trim().split(/\s+/);
  for (let i = 0; i < 3 && i < p.length; i++) {
    v[i] = Number(p[i]) || 0;
  }
  return v;
}

// How a door or plat is opened, from doors.qc and plats.qc spawn functions
function door_opens(e) {
  const sf = e.spawnflags !== undefined ? (parseInt(e.spawnflags) | 0) : 0;
  if (e.classname === "func_door_secret") {
    if (e.targetname !== undefined) {
      return (sf & SECRET_YES_SHOOT) !== 0 ? "trigger_or_shoot" : "trigger";
    }
    return "shoot";
  }

  if (e.classname === "func_door") {
    if ((sf & DOOR_GOLD_KEY) !== 0) {
      return "gold_key";
    }
    if ((sf & DOOR_SILVER_KEY) !== 0) {
      return "silver_key";
    }
    if (e.health !== undefined && Number(e.health) > 0) {
      return "shoot";
    }
  }

  return e.targetname !== undefined ? "trigger" : "touch";
}

const NAV_CLASSES = new Set([
  "func_door",
  "func_door_secret",
  "func_plat",
  "func_button",
  "func_wall",
  "trigger_teleport",
  "info_teleport_destination",
  "trigger_changelevel",
]);

/*
==============================================================================

BUILD

==============================================================================
*/

// Vertices of surface s in the xy plane, into xs/ys; returns the count
function surface_polygon(model, s, xs, ys) {
  const n = s.numedges;
  for (let i = 0; i < n; i++) {
    const lindex = model.surfedges[s.firstedge + i];
    const v = lindex > 0 ?
      model.vertexes[model.edges[lindex].v[0]] :
      model.vertexes[model.edges[-lindex].v[1]];
    xs[i] = v.position[0];
    ys[i] = v.position[1];
  }

  return n;
}

// Point in a convex polygon (either winding), edges included
function in_polygon(xs, ys, n, x, y) {
  let pos = false, neg = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const c = (xs[i] - xs[j]) * (y - ys[j]) - (ys[i] - ys[j]) * (x - xs[j]);
    if (c > 0.01) pos = true;
    else if (c < -0.01) neg = true;
    if (pos === true && neg === true) {
      return false;
    }
  }

  return true;
}

// Nudges tried when the player doesn't fit at a grid point
const NUDGES = [
  0,
  0,
  8,
  0,
  -8,
  0,
  0,
  8,
  0,
  -8,
  8,
  8,
  -8,
  8,
  8,
  -8,
  -8,
  -8,
  16,
  0,
  -16,
  0,
  0,
  16,
  0,
  -16,
];

/*
==================
Nav_Build

Builds the walk graph for a loaded brush model (sv.worldmodel or
cl.worldmodel). opts: grid (32), maxdrop (256), jump (40), skill (1),
deathmatch (false).
==================
*/
export function Nav_Build(worldmodel, opts = {}) {
  const t0 = performance.now();
  const o = { ...DEFAULT_OPTS, ...opts };
  const G = o.grid;

  b_hull1 = worldmodel.hulls[1];
  b_hull0 = worldmodel.hulls[0];
  b_clips = [];

  //
  // entities
  //
  const lump = parse_entities(worldmodel.entities);
  const ents = [];
  const by_targetname = new Map();
  const lump_to_ent = new Map();
  for (let i = 0; i < lump.length; i++) {
    const e = lump[i];
    if (NAV_CLASSES.has(e.classname) !== true || entity_spawns(e, o) !== true) {
      continue;
    }

    const rec = {
      classname: e.classname,
      targetname: e.targetname !== undefined ? e.targetname : null,
      target: e.target !== undefined ? e.target : null,
      model: -1,
      origin: parse_vec(e.origin),
      mins: null,
      maxs: null,
      opens: null,
      activators: [],
      map: e.map !== undefined ? e.map : null,
      message: e.message !== undefined ? e.message : null,
    };

    if (e.model !== undefined && e.model.charAt(0) === "*") {
      const n = parseInt(e.model.slice(1));
      const sm = worldmodel.submodels[n];
      if (n > 0 && sm !== undefined) {
        rec.model = n;
        rec.mins = [
          sm.mins[0] + rec.origin[0],
          sm.mins[1] + rec.origin[1],
          sm.mins[2] + rec.origin[2],
        ];
        rec.maxs = [
          sm.maxs[0] + rec.origin[0],
          sm.maxs[1] + rec.origin[1],
          sm.maxs[2] + rec.origin[2],
        ];
      }
    }

    if (rec.mins === null && rec.classname !== "info_teleport_destination") {
      continue;
    }

    if (
      rec.classname === "func_door" || rec.classname === "func_door_secret" ||
      rec.classname === "func_plat"
    ) {
      rec.opens = door_opens(e);
    }

    if (rec.classname === "func_plat") {
      // plats.qc: pos2_z = origin_z - height, or size_z - 8
      // (a height of 0 counts as unset, as in the QuakeC's if ( self.height ))
      const h = e.height !== undefined && Number(e.height) !== 0 ?
        Number(e.height) :
        (rec.maxs[2] - rec.mins[2]) - 8;
      rec.drop = h;
    }

    if (rec.classname === "info_teleport_destination") {
      // misc.qc / triggers.qc: origin + '0 0 27', then the player is
      // put 32 units forward along mangle
      const yaw = e.angle !== undefined ?
        Number(e.angle) :
        (e.mangle !== undefined ?
          parse_vec(e.mangle)[1] :
          parse_vec(e.angles)[1]);
      const a = yaw * Math.PI / 180;
      rec.dest = [
        rec.origin[0] + 32 * Math.cos(a),
        rec.origin[1] + 32 * Math.sin(a),
        rec.origin[2] + 27,
      ];
    }

    lump_to_ent.set(i, ents.length);
    if (rec.targetname !== null) {
      if (by_targetname.has(rec.targetname) !== true) {
        by_targetname.set(rec.targetname, []);
      }
      by_targetname.get(rec.targetname).push(ents.length);
    }

    ents.push(rec);
  }

  // Who fires each door or plat: any lump entity that targets it
  for (let i = 0; i < lump.length; i++) {
    const e = lump[i];
    if (entity_spawns(e, o) !== true) {
      continue;
    }
    for (const key of ["target", "killtarget"]) {
      const list = e[key] !== undefined ? by_targetname.get(e[key]) : undefined;
      if (list === undefined) {
        continue;
      }
      const me = lump_to_ent.get(i);
      for (const j of list) {
        const rec = ents[j];
        if (rec.opens === null) {
          continue;
        }
        rec.activators.push({
          classname: e.classname,
          ent: me !== undefined ? me : -1,
          message: e.message !== undefined ? e.message : null,
          model: e.model !== undefined && e.model.charAt(0) === "*" ?
            parseInt(e.model.slice(1)) :
            -1,
        });
      }
    }
  }

  //
  // clipping hulls of brush entities
  //
  function add_clip(ent, kind, dz, blocks_fit) {
    const rec = ents[ent];
    const sm = worldmodel.submodels[rec.model];
    const offset = new Float32Array([
      rec.origin[0],
      rec.origin[1],
      rec.origin[2] + dz,
    ]);
    // hull 1 solids grow by the player box: mins - VEC_HULL_MAX, maxs - VEC_HULL_MIN
    const emins = new Float32Array(3), emaxs = new Float32Array(3);
    for (let k = 0; k < 3; k++) {
      emins[k] = sm.mins[k] + offset[k] - PLAYER_MAXS[k] - 1;
      emaxs[k] = sm.maxs[k] + offset[k] - PLAYER_MINS[k] + 1;
    }

    b_clips.push({
      ent,
      kind,
      headnode: sm.headnode[1],
      offset,
      emins,
      emaxs,
      blocks_fit,
      plat_low: dz !== 0,
    });
  }

  for (let i = 0; i < ents.length; i++) {
    const c = ents[i].classname;
    if (c === "func_wall") {
      add_clip(i, CLIP_STATIC, 0, true);
    } else if (c === "func_door" || c === "func_door_secret") {
      add_clip(i, CLIP_MOVER, 0, false);
    } else if (c === "func_plat") {
      add_clip(i, CLIP_MOVER, 0, false);
      add_clip(i, CLIP_MOVER, -ents[i].drop, true);
    }
  }

  //
  // sample floors
  //
  const wmins = worldmodel.mins, wmaxs = worldmodel.maxs;
  const gx0 = Math.floor(wmins[0] / G) - 1, gy0 = Math.floor(wmins[1] / G) - 1;
  const gw = Math.floor(wmaxs[0] / G) + 2 - gx0,
    gh = Math.floor(wmaxs[1] / G) + 2 - gy0;
  const cells = new Map(); // cell -> node indices
  const px = [], py = [], pz = [], pcell = [], pclip = [];
  const xs = new Float64Array(64), ys = new Float64Array(64);

  function sample_surface(s, clip) {
    const plane = s.plane;
    let nz = plane.normal[2];
    if ((s.flags & SURF_PLANEBACK) !== 0) {
      nz = -nz;
    }
    if (nz <= FLOOR_Z || (s.flags & (SURF_DRAWSKY | SURF_DRAWTURB)) !== 0) {
      return;
    }
    if (s.numedges > xs.length) {
      return;
    }

    const n = surface_polygon(worldmodel, s, xs, ys);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < n; i++) {
      if (xs[i] < x0) x0 = xs[i];
      if (xs[i] > x1) x1 = xs[i];
      if (ys[i] < y0) y0 = ys[i];
      if (ys[i] > y1) y1 = ys[i];
    }

    const pn = plane.normal, pd = plane.dist;
    const dz = clip !== null ? clip.offset[2] : 0;
    for (let gx = Math.ceil(x0 / G); gx * G <= x1; gx++) {
      for (let gy = Math.ceil(y0 / G); gy * G <= y1; gy++) {
        const x = gx * G, y = gy * G;
        if (in_polygon(xs, ys, n, x, y) !== true) {
          continue;
        }
        const cell = (gx - gx0) + (gy - gy0) * gw;
        const fz = (pd - pn[0] * x - pn[1] * y) / pn[2] + dz;

        let list = cells.get(cell);
        if (list !== undefined) {
          let dup = false;
          for (const j of list) {
            if (Math.abs(pz[j] - (fz + 24)) < 20) dup = true;
          }
          if (dup === true) {
            continue;
          }
        }

        for (let k = 0; k < NUDGES.length; k += 2) {
          const sx = x + NUDGES[k], sy = y + NUDGES[k + 1];
          const sz = (pd - pn[0] * sx - pn[1] * sy) / pn[2] + dz + 24;
          // The box rests up to a step above the face where it
          // overlaps a ledge, so start a step up; under a low
          // ceiling, start just above the face instead
          t_start[0] = sx;
          t_start[1] = sy;
          t_start[2] = sz + STEPSIZE + 1;
          t_end[0] = sx;
          t_end[1] = sy;
          t_end[2] = sz - 16;
          nav_trace(true);
          if (tr.startsolid === true || tr.allsolid === true) {
            t_start[2] = sz + 1;
            nav_trace(true);
          }

          if (
            tr.startsolid === true || tr.allsolid === true ||
            tr.fraction === 1 || tr.plane.normal[2] <= FLOOR_Z
          ) {
            continue;
          }
          if (nav_fits(tr.endpos) !== true) {
            continue;
          }
          const ez = tr.endpos[2];
          const fc = point_contents0(sx, sy, ez - 23);
          if (fc === CONTENTS_LAVA) {
            break;
          }

          if (list === undefined) {
            list = [];
            cells.set(cell, list);
          }

          let dup = false;
          for (const j of list) {
            if (Math.abs(pz[j] - ez) < 20) dup = true;
          }
          if (dup === true) {
            break;
          }

          list.push(px.length);
          px.push(sx);
          py.push(sy);
          pz.push(ez);
          pcell.push(cell);
          // the floor actually reached: next to another door's top,
          // that door may be the one stood on
          pclip.push(
            trace_hit_clip !== -1 &&
              b_clips[trace_hit_clip].kind === CLIP_MOVER ?
              trace_hit_clip :
              -1,
          );
          break;
        }
      }
    }
  }

  for (let i = 0; i < worldmodel.nummodelsurfaces; i++) {
    sample_surface(worldmodel.surfaces[worldmodel.firstmodelsurface + i], null);
  }

  for (const c of b_clips) {
    if (c.kind !== CLIP_MOVER) {
      continue;
    }
    const sm = worldmodel.submodels[ents[c.ent].model];
    for (let i = 0; i < sm.numfaces; i++) {
      sample_surface(worldmodel.surfaces[sm.firstface + i], c);
    }
  }

  const N = px.length;
  const node_pos = new Float32Array(N * 3);
  const node_flags = new Uint8Array(N);
  const node_ent = new Int16Array(N).fill(-1);
  for (let i = 0; i < N; i++) {
    node_pos[i * 3] = px[i];
    node_pos[i * 3 + 1] = py[i];
    node_pos[i * 3 + 2] = pz[i];
    let f = 0;
    if (is_liquid(point_contents0(px[i], py[i], pz[i]))) {
      f |= NAV_NODE_WATER;
    }
    if (point_contents0(px[i], py[i], pz[i] - 23) === CONTENTS_SLIME) {
      f |= NAV_NODE_SLIME;
    }
    if (pclip[i] !== -1) {
      const c = b_clips[pclip[i]];
      f |= NAV_NODE_MOVER;
      node_ent[i] = c.ent;
      if (ents[c.ent].classname === "func_plat") {
        f |= NAV_NODE_PLAT;
      }
    }

    node_flags[i] = f;
  }

  //
  // entity marks on nodes
  //
  function box_touches(i, mins, maxs, grow) {
    for (let k = 0; k < 3; k++) {
      const p = node_pos[i * 3 + k];
      if (
        p + PLAYER_MAXS[k] + grow < mins[k] ||
        p + PLAYER_MINS[k] - grow > maxs[k]
      ) {
        return false;
      }
    }

    return true;
  }

  // True if node i stands on the top of brush entity e
  function stands_on(i, e) {
    return pclip[i] !== -1 && b_clips[pclip[i]].ent === e;
  }

  // True if the player can walk from node i into the box (within reach):
  // a clear trace to the nearest origin where the player box touches it
  function can_reach(i, mins, maxs) {
    for (let k = 0; k < 3; k++) {
      const p = node_pos[i * 3 + k];
      const lo = mins[k] - PLAYER_MAXS[k], hi = maxs[k] - PLAYER_MINS[k];
      t_start[k] = p;
      t_end[k] = k === 2 ? p : Math.min(Math.max(p, lo), hi);
    }

    if (
      node_pos[i * 3 + 2] < mins[2] - PLAYER_MAXS[2] ||
      node_pos[i * 3 + 2] > maxs[2] - PLAYER_MINS[2]
    ) {
      return false;
    }
    nav_trace(false);
    return tr.startsolid !== true && tr.fraction === 1;
  }

  // [ classname, flag, reach ]: reach also marks nodes a grid step away
  // that can walk into it (slipgates and buttons sit in wall openings)
  const node_tele = new Int16Array(N); // the teleporter a TELEPORT node is in
  const mark_order = [
    ["func_button", NAV_NODE_BUTTON, true],
    ["func_door", NAV_NODE_DOOR, false],
    ["func_door_secret", NAV_NODE_DOOR, false],
    ["trigger_changelevel", NAV_NODE_EXIT, true],
    ["trigger_teleport", NAV_NODE_TELEPORT, true],
  ];
  for (const [cls, flag, reach] of mark_order) {
    for (let e = 0; e < ents.length; e++) {
      const rec = ents[e];
      if (rec.classname !== cls) {
        continue;
      }
      rec.nodes = 0;
      // triggers.qc teleport_touch: a teleporter with a targetname
      // works only just after it is fired (monster spawns)
      if (cls === "trigger_teleport" && rec.targetname !== null) {
        continue;
      }
      for (let i = 0; i < N; i++) {
        if (
          box_touches(i, rec.mins, rec.maxs, 0) !== true &&
          (reach !== true || box_touches(i, rec.mins, rec.maxs, G) !== true ||
            can_reach(i, rec.mins, rec.maxs) !== true)
        ) {
          continue;
        }
        // a door's own top isn't "at" the door
        if (flag === NAV_NODE_DOOR && stands_on(i, e) === true) {
          continue;
        }
        node_flags[i] |= flag;
        node_ent[i] = e;
        if (flag === NAV_NODE_TELEPORT) {
          node_tele[i] = e;
        }
        rec.nodes++;
      }
    }
  }

  // The graph without links, so Nav_NearestNode can place teleport
  // destinations
  const graph = {
    name: worldmodel.name,
    grid: G,
    opts: o,
    node_count: N,
    node_pos,
    node_flags,
    node_ent,
    link_count: 0,
    link_start: null,
    link_to: null,
    link_flags: null,
    link_ent: null,
    link_cost: null,
    ents,
    cell_x0: gx0,
    cell_y0: gy0,
    cell_w: gw,
    cell_h: gh,
    cell_start: null,
    cell_nodes: null,
    worldmodel,
    build_ms: 0,
    traces: 0,
    _g: new Float32Array(N),
    _parent: new Int32Array(N),
    _plink: new Int32Array(N),
    _stamp: new Uint32Array(N),
    _closed: new Uint32Array(N),
    _gen: 0,
    _heap_node: null,
    _heap_f: null,
    path: {
      count: 0,
      cost: 0,
      node: new Int32Array(N),
      pos: new Float32Array(N * 3),
      flags: new Uint16Array(N),
    },
  };
  build_cells(graph, pcell);

  // Teleport destinations, and the triggers a walk can pass through
  const sweep_trig = [];
  for (let e = 0; e < ents.length; e++) {
    const rec = ents[e];
    if (rec.classname === "trigger_changelevel") {
      sweep_trig.push(e);
      continue;
    }

    if (
      rec.classname !== "trigger_teleport" || rec.targetname !== null ||
      rec.target === null
    ) {
      continue;
    }
    rec.dest_node = -1;
    const dl = by_targetname.get(rec.target);
    if (dl === undefined || ents[dl[0]].dest === undefined) {
      continue;
    }
    rec.dest_node = Nav_NearestNode(graph, ents[dl[0]].dest, 128);
    if (rec.dest_node >= 0) {
      sweep_trig.push(e);
    }
  }

  //
  // links
  //
  const lfrom = [], lto = [], lflags = [], lent = [], lcost = [];
  const pa = new Float32Array(3);
  let traces = 0;
  let walk_ent = -1; // the trigger walk() last touched

  // Simulated walk from node a to node b: link flags, -1 if it fails, or
  // -2 if it touches a teleporter (walk_ent) on the way. movers false
  // walks as if every door and plat had moved away; maxdrop is the
  // longest fall allowed.
  function walk(a, b, movers, maxdrop) {
    const ax = node_pos[a * 3],
      ay = node_pos[a * 3 + 1],
      az = node_pos[a * 3 + 2];
    const bx = node_pos[b * 3],
      by = node_pos[b * 3 + 1],
      bz = node_pos[b * 3 + 2];
    const dx = bx - ax, dy = by - ay;
    const steps = Math.ceil(Math.sqrt(dx * dx + dy * dy) / SUBSTEP);
    let flags = 0;
    walk_ent = -1;
    pa[0] = ax;
    pa[1] = ay;
    pa[2] = az;
    for (let s = 1; s <= steps; s++) {
      const tx = ax + dx * s / steps, ty = ay + dy * s / steps;

      // step up
      t_start[0] = pa[0];
      t_start[1] = pa[1];
      t_start[2] = pa[2];
      t_end[0] = pa[0];
      t_end[1] = pa[1];
      t_end[2] = pa[2] + STEPSIZE;
      nav_trace(false);
      traces++;
      if (tr.startsolid === true) {
        return -1;
      }
      const uz = tr.endpos[2];

      // move
      t_start[2] = uz;
      t_end[0] = tx;
      t_end[1] = ty;
      t_end[2] = uz;
      nav_trace(false);
      traces++;
      if (tr.startsolid === true || tr.fraction < 1) {
        return -1;
      }

      // settle down, as far as a drop allows
      t_start[0] = tx;
      t_start[1] = ty;
      t_end[2] = uz - STEPSIZE - maxdrop;
      nav_trace(movers);
      traces++;
      if (
        tr.startsolid === true || tr.fraction === 1 ||
        tr.plane.normal[2] <= FLOOR_Z
      ) {
        return -1;
      }

      const nz = tr.endpos[2];

      // triggers touched on the way (falling through one, too)
      const x0 = Math.min(pa[0], tx) + PLAYER_MINS[0],
        x1 = Math.max(pa[0], tx) + PLAYER_MAXS[0];
      const y0 = Math.min(pa[1], ty) + PLAYER_MINS[1],
        y1 = Math.max(pa[1], ty) + PLAYER_MAXS[1];
      for (const e of sweep_trig) {
        const r = ents[e];
        if (
          x1 < r.mins[0] || x0 > r.maxs[0] || y1 < r.mins[1] ||
          y0 > r.maxs[1] || uz + PLAYER_MAXS[2] < r.mins[2] ||
          nz + PLAYER_MINS[2] > r.maxs[2]
        ) {
          continue;
        }
        walk_ent = e;
        if (r.classname === "trigger_teleport") {
          return -2; // teleported here: the caller links to the destination
        }
        flags |= NAV_LINK_EXIT;
      }

      if (pa[2] - nz > STEPSIZE) {
        flags |= NAV_LINK_DROP;
      }
      if (
        trace_hit_clip !== -1 && b_clips[trace_hit_clip].kind === CLIP_MOVER
      ) {
        flags |= NAV_LINK_MOVER;
      }
      const fc = point_contents0(tx, ty, nz - 23);
      if (fc === CONTENTS_LAVA) {
        return -1;
      }
      if (fc === CONTENTS_SLIME) {
        flags |= NAV_LINK_SLIME;
      }
      pa[0] = tx;
      pa[1] = ty;
      pa[2] = nz;
    }

    if (Math.abs(pa[2] - bz) > 1) {
      return -1;
    }
    return flags;
  }

  // Swim up from node a (origin in liquid) to the higher node b: the
  // column above a is open and liquid up to near b's floor, so the player
  // can swim up and climb out (a water jump, sv_user.c / CheckWaterJump);
  // then the move across at b's height is clear. Link flags, or -1
  function swim(a, b) {
    const ax = node_pos[a * 3],
      ay = node_pos[a * 3 + 1],
      az = node_pos[a * 3 + 2];
    const bx = node_pos[b * 3],
      by = node_pos[b * 3 + 1],
      bz = node_pos[b * 3 + 2];
    if (bz <= az || is_liquid(point_contents0(ax, ay, bz - 24 - 16)) !== true) {
      return -1;
    }
    t_start[0] = ax;
    t_start[1] = ay;
    t_start[2] = az;
    t_end[0] = ax;
    t_end[1] = ay;
    t_end[2] = bz;
    nav_trace(false);
    traces++;
    if (tr.startsolid === true || tr.fraction < 1) {
      return -1;
    }
    t_start[2] = bz;
    t_end[0] = bx;
    t_end[1] = by;
    nav_trace(false);
    traces++;
    if (tr.startsolid === true || tr.fraction < 1) {
      return -1;
    }
    return NAV_LINK_SWIM;
  }

  // Jump from node a to neighbour b: straight up o.jump units, across at
  // that height, then down onto b (sv_user.c jump velocity 270 with
  // sv_gravity 800 peaks near 45). Covers ledges and short gaps. Where
  // the ceiling is low, crossing just above b's height is tried too.
  // Link flags, or -1
  function jump(a, b) {
    const az = node_pos[a * 3 + 2], bz = node_pos[b * 3 + 2];
    if (bz > az + o.jump - 2) {
      return -1;
    }
    if (jump_at(a, b, az + o.jump) === true) {
      return jump_trig(a, b, az + o.jump) === true ? -1 : NAV_LINK_JUMP;
    }
    if (bz + 1 > az && jump_at(a, b, bz + 1) === true) {
      return jump_trig(a, b, bz + 1) === true ? -1 : NAV_LINK_JUMP;
    }
    return -1;
  }

  // Whether a jump's box (up to top) touches a teleporter or exit trigger:
  // such jumps aren't linked, as walk() alone handles those triggers
  function jump_trig(a, b, top) {
    const ax = node_pos[a * 3], ay = node_pos[a * 3 + 1];
    const bx = node_pos[b * 3], by = node_pos[b * 3 + 1];
    const z0 = Math.min(node_pos[a * 3 + 2], node_pos[b * 3 + 2]) +
      PLAYER_MINS[2];
    const z1 = top + PLAYER_MAXS[2];
    const x0 = Math.min(ax, bx) + PLAYER_MINS[0],
      x1 = Math.max(ax, bx) + PLAYER_MAXS[0];
    const y0 = Math.min(ay, by) + PLAYER_MINS[1],
      y1 = Math.max(ay, by) + PLAYER_MAXS[1];
    for (const e of sweep_trig) {
      const r = ents[e];
      if (
        x1 < r.mins[0] || x0 > r.maxs[0] || y1 < r.mins[1] || y0 > r.maxs[1] ||
        z1 < r.mins[2] || z0 > r.maxs[2]
      ) {
        continue;
      }
      return true;
    }

    return false;
  }

  function jump_at(a, b, top) {
    const ax = node_pos[a * 3],
      ay = node_pos[a * 3 + 1],
      az = node_pos[a * 3 + 2];
    const bx = node_pos[b * 3],
      by = node_pos[b * 3 + 1],
      bz = node_pos[b * 3 + 2];
    t_start[0] = ax;
    t_start[1] = ay;
    t_start[2] = az;
    t_end[0] = ax;
    t_end[1] = ay;
    t_end[2] = top;
    nav_trace(false);
    traces++;
    if (tr.startsolid === true || tr.fraction < 1) {
      return false;
    }
    t_start[2] = top;
    t_end[0] = bx;
    t_end[1] = by;
    nav_trace(false);
    traces++;
    if (tr.startsolid === true || tr.fraction < 1) {
      return false;
    }
    t_start[0] = bx;
    t_start[1] = by;
    t_end[2] = bz - 1;
    nav_trace(true);
    traces++;
    return tr.startsolid !== true && tr.fraction < 1 &&
      Math.abs(tr.endpos[2] - bz) <= 1;
  }

  function add_link(a, b, flags, ent, cost) {
    lfrom.push(a);
    lto.push(b);
    lflags.push(flags);
    lent.push(ent);
    lcost.push(cost);
  }

  function dist(a, b) {
    const dx = node_pos[b * 3] - node_pos[a * 3];
    const dy = node_pos[b * 3 + 1] - node_pos[a * 3 + 1];
    const dz = node_pos[b * 3 + 2] - node_pos[a * 3 + 2];
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  const doors = [];
  for (let e = 0; e < ents.length; e++) {
    if (
      ents[e].classname === "func_door" ||
      ents[e].classname === "func_door_secret"
    ) {
      doors.push(e);
    }
  }

  const tele_seen = new Set();
  for (let a = 0; a < N; a++) {
    // a node in a teleporter leads only to its destination
    // (one whose destination has no node walks on as usual)
    if (
      (node_flags[a] & NAV_NODE_TELEPORT) !== 0 &&
      ents[node_tele[a]].dest_node >= 0
    ) {
      const te = node_tele[a];
      add_link(a, ents[te].dest_node, NAV_LINK_TELEPORT, te, 16);
      continue;
    }

    tele_seen.clear();
    const cell = pcell[a];
    const cx = cell % gw, cy = (cell - cx) / gw;
    const az = node_pos[a * 3 + 2];
    // stairs climb a few steps per link; swimming up can climb more
    const maxrise = (node_flags[a] & NAV_NODE_WATER) !== 0 ?
      1024 :
      STEPSIZE * 2.5;
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        if (ox === 0 && oy === 0) {
          continue;
        }
        const list = cells.get((cx + ox) + (cy + oy) * gw);
        if (list === undefined) {
          continue;
        }

        for (const b of list) {
          const dz = node_pos[b * 3 + 2] - az;
          // liquid breaks a fall (and swimming down is no fall)
          const maxdrop = (node_flags[b] & NAV_NODE_WATER) !== 0 ?
            MAX_WATER_DROP :
            o.maxdrop;
          if (dz > maxrise || dz < -(maxdrop + STEPSIZE)) {
            continue;
          }
          let flags = walk(a, b, true, maxdrop);
          // floor under a door's closed position (e1m3's sinking
          // floor): reachable once the door has opened
          if (
            flags === -1 &&
            ((node_flags[a] | node_flags[b]) & NAV_NODE_DOOR) !== 0
          ) {
            flags = walk(a, b, false, maxdrop);
            if (flags >= 0) {
              flags |= NAV_LINK_DOOR;
            }
          }

          if (flags === -2) {
            // walked or fell into a teleporter
            if (
              tele_seen.has(walk_ent) !== true && ents[walk_ent].dest_node >= 0
            ) {
              tele_seen.add(walk_ent);
              add_link(
                a,
                ents[walk_ent].dest_node,
                NAV_LINK_TELEPORT,
                walk_ent,
                16,
              );
            }

            continue;
          }

          const exit_ent = walk_ent;
          if (flags < 0 && (node_flags[a] & NAV_NODE_WATER) !== 0) {
            flags = swim(a, b);
          }
          if (
            flags < 0 && o.jump > 0 && (node_flags[a] & NAV_NODE_WATER) === 0
          ) {
            flags = jump(a, b);
          }
          if (flags < 0) {
            continue;
          }

          let ent = -1;
          let cost = dist(a, b);
          if ((flags & NAV_LINK_JUMP) !== 0) {
            cost += 32;
          }
          // through a door's closed position (either end's box touches it)
          for (const d of doors) {
            const r = ents[d];
            if (
              box_touches(a, r.mins, r.maxs, 0) === true ||
              box_touches(b, r.mins, r.maxs, 0) === true
            ) {
              if (stands_on(a, d) === true || stands_on(b, d) === true) {
                continue;
              }
              flags |= NAV_LINK_DOOR;
              ent = d;
              cost += 32;
              break;
            }
          }

          // the mover is what b (or a) stands on: node_ent may name a
          // button or trigger instead
          if ((flags & NAV_LINK_MOVER) !== 0 && ent === -1) {
            ent = pclip[b] !== -1 ?
              b_clips[pclip[b]].ent :
              (pclip[a] !== -1 ? b_clips[pclip[a]].ent : -1);
          }
          if ((flags & NAV_LINK_EXIT) !== 0) {
            // reaching b this way changes level (e1m6 falls into it)
            ent = exit_ent;
            node_flags[b] |= NAV_NODE_EXIT;
            node_ent[b] = exit_ent;
          }
          if (((node_flags[a] | node_flags[b]) & NAV_NODE_WATER) !== 0) {
            flags |= NAV_LINK_WATER;
            cost *= 1.5;
          }

          if (((node_flags[a] | node_flags[b]) & NAV_NODE_SLIME) !== 0) {
            flags |= NAV_LINK_SLIME;
          }
          if ((flags & NAV_LINK_SLIME) !== 0) {
            cost = cost * 4 + 64;
          }
          add_link(a, b, flags, ent, cost);
        }
      }
    }
  }

  // Plat rides: each top-position node to the bottom-position node in the
  // same cell, both ways
  for (let a = 0; a < N; a++) {
    if (
      pclip[a] === -1 || b_clips[pclip[a]].plat_low === true ||
      ents[b_clips[pclip[a]].ent].classname !== "func_plat"
    ) {
      continue;
    }
    const e = b_clips[pclip[a]].ent;
    for (const b of cells.get(pcell[a])) {
      if (
        b === a || pclip[b] === -1 || b_clips[pclip[b]].ent !== e ||
        b_clips[pclip[b]].plat_low !== true
      ) {
        continue;
      }
      const cost = Math.abs(node_pos[a * 3 + 2] - node_pos[b * 3 + 2]) + 64;
      add_link(a, b, NAV_LINK_PLAT | NAV_LINK_MOVER, e, cost);
      add_link(b, a, NAV_LINK_PLAT | NAV_LINK_MOVER, e, cost);
    }
  }

  //
  // compact the links (CSR, sorted by from node, stable)
  //
  const L = lfrom.length;
  const link_start = new Int32Array(N + 1);
  for (let i = 0; i < L; i++) {
    link_start[lfrom[i] + 1]++;
  }
  for (let i = 0; i < N; i++) {
    link_start[i + 1] += link_start[i];
  }
  const fill = link_start.slice(0, N);
  const link_to = new Int32Array(L);
  const link_flags = new Uint16Array(L);
  const link_ent = new Int16Array(L);
  const link_cost = new Float32Array(L);
  for (let i = 0; i < L; i++) {
    const j = fill[lfrom[i]]++;
    link_to[j] = lto[i];
    link_flags[j] = lflags[i];
    link_ent[j] = lent[i];
    link_cost[j] = lcost[i];
  }

  graph.link_count = L;
  graph.link_start = link_start;
  graph.link_to = link_to;
  graph.link_flags = link_flags;
  graph.link_ent = link_ent;
  graph.link_cost = link_cost;
  graph._heap_node = new Int32Array(L + 2);
  graph._heap_f = new Float32Array(L + 2);
  graph.traces = traces;

  b_clips = [];
  b_hull0 = null;
  b_hull1 = null;
  graph.build_ms = performance.now() - t0;
  return graph;
}

// Spatial index: nodes by grid cell (CSR)
function build_cells(graph, pcell) {
  const ncells = graph.cell_w * graph.cell_h;
  const start = new Int32Array(ncells + 1);
  for (let i = 0; i < pcell.length; i++) {
    start[pcell[i] + 1]++;
  }
  for (let i = 0; i < ncells; i++) {
    start[i + 1] += start[i];
  }
  const fill = start.slice(0, ncells);
  const nodes = new Int32Array(pcell.length);
  for (let i = 0; i < pcell.length; i++) {
    nodes[fill[pcell[i]]++] = i;
  }
  graph.cell_start = start;
  graph.cell_nodes = nodes;
}

/*
==============================================================================

QUERIES

==============================================================================
*/

const NEAREST_K = 8;
const near_node = new Int32Array(NEAREST_K);
const near_score = new Float64Array(NEAREST_K);
const los_trace = new trace_t();
const los_start = new Float32Array(3);
const los_end = new Float32Array(3);

// Line of sight (hull 0) from p to node i in graph's world
function node_visible(graph, p, i) {
  const hull = graph.worldmodel.hulls[0];
  los_start[0] = p[0];
  los_start[1] = p[1];
  los_start[2] = p[2];
  if (
    SV_HullPointContents(hull, hull.firstclipnode, los_start) === CONTENTS_SOLID
  ) {
    los_start[2] += 16; // an item origin on the floor
  }
  los_end[0] = graph.node_pos[i * 3];
  los_end[1] = graph.node_pos[i * 3 + 1];
  los_end[2] = graph.node_pos[i * 3 + 2];
  trace_reset(los_trace, los_end);
  SV_RecursiveHullCheck(
    hull,
    hull.firstclipnode,
    0,
    1,
    los_start,
    los_end,
    los_trace,
  );
  return los_trace.startsolid !== true && los_trace.allsolid !== true &&
    los_trace.fraction === 1;
}

/*
==================
Nav_NearestNode

The node closest to p (a player origin; an item origin on the floor works
too) within maxdist units, preferring nodes in line of sight and at the
same height. -1 if there is none.
==================
*/
export function Nav_NearestNode(graph, p, maxdist = 256) {
  const G = graph.grid;
  const cx = Math.round(p[0] / G) - graph.cell_x0;
  const cy = Math.round(p[1] / G) - graph.cell_y0;
  // a node can sit 16 units off its cell's sample point (NUDGES)
  const r = Math.ceil((maxdist + 16) / G) + 1;
  const pos = graph.node_pos;
  let count = 0;
  const max2 = maxdist * maxdist;

  for (
    let y = Math.max(0, cy - r);
    y <= Math.min(graph.cell_h - 1, cy + r);
    y++
  ) {
    for (
      let x = Math.max(0, cx - r);
      x <= Math.min(graph.cell_w - 1, cx + r);
      x++
    ) {
      const c = x + y * graph.cell_w;
      for (let j = graph.cell_start[c]; j < graph.cell_start[c + 1]; j++) {
        const i = graph.cell_nodes[j];
        const dx = pos[i * 3] - p[0],
          dy = pos[i * 3 + 1] - p[1],
          dz = pos[i * 3 + 2] - p[2];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > max2) {
          continue;
        }
        // height differences count double: prefer this floor
        const score = d2 + 3 * dz * dz;
        if (count === NEAREST_K && score >= near_score[NEAREST_K - 1]) {
          continue;
        }

        let k = count < NEAREST_K ? count++ : NEAREST_K - 1;
        while (k > 0 && near_score[k - 1] > score) {
          near_score[k] = near_score[k - 1];
          near_node[k] = near_node[k - 1];
          k--;
        }

        near_score[k] = score;
        near_node[k] = i;
      }
    }
  }

  if (count === 0) {
    return -1;
  }
  for (let k = 0; k < count; k++) {
    if (node_visible(graph, p, near_node[k]) === true) {
      return near_node[k];
    }
  }
  return near_node[0];
}

// Straight-line distance. Teleport links (cost 16) make it overestimate,
// so a path that could use a teleporter may not be the shortest
function heuristic(graph, a, b) {
  const pos = graph.node_pos;
  const dx = pos[b * 3] - pos[a * 3],
    dy = pos[b * 3 + 1] - pos[a * 3 + 1],
    dz = pos[b * 3 + 2] - pos[a * 3 + 2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/*
==================
Nav_FindPathNodes

A* from node start to node goal. Returns graph.path (count, cost, node,
pos as xyz triples, and flags: the link flags used to reach each waypoint)
or null. graph.path is overwritten by the next query: copy what you keep.
==================
*/
export function Nav_FindPathNodes(graph, start, goal) {
  if (
    start < 0 || goal < 0 || start >= graph.node_count ||
    goal >= graph.node_count
  ) {
    return null;
  }

  const g = graph._g, parent = graph._parent, plink = graph._plink;
  const stamp = graph._stamp, closed = graph._closed;
  const hn = graph._heap_node, hf = graph._heap_f;
  const ls = graph.link_start, lt = graph.link_to, lc = graph.link_cost;
  const gen = ++graph._gen;

  stamp[start] = gen;
  g[start] = 0;
  parent[start] = -1;
  plink[start] = -1;
  let size = 0;
  // push
  hn[0] = start;
  hf[0] = heuristic(graph, start, goal);
  size = 1;

  let found = false;
  while (size > 0) {
    // pop
    const n = hn[0];
    size--;
    if (size > 0) {
      const ln = hn[size], lf = hf[size];
      let i = 0;
      while (true) {
        let c = i * 2 + 1;
        if (c >= size) break;
        if (c + 1 < size && hf[c + 1] < hf[c]) c++;
        if (hf[c] >= lf) break;
        hn[i] = hn[c];
        hf[i] = hf[c];
        i = c;
      }

      hn[i] = ln;
      hf[i] = lf;
    }

    if (closed[n] === gen) {
      continue;
    }
    closed[n] = gen;
    if (n === goal) {
      found = true;
      break;
    }

    const gn = g[n];
    for (let l = ls[n]; l < ls[n + 1]; l++) {
      const m = lt[l];
      if (closed[m] === gen) {
        continue;
      }
      const ng = gn + lc[l];
      if (stamp[m] === gen && ng >= g[m]) {
        continue;
      }
      stamp[m] = gen;
      g[m] = ng;
      parent[m] = n;
      plink[m] = l;

      // push (lazy: stale entries are skipped by closed[])
      const f = ng + heuristic(graph, m, goal);
      let i = size++;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (hf[p] <= f) break;
        hn[i] = hn[p];
        hf[i] = hf[p];
        i = p;
      }

      hn[i] = m;
      hf[i] = f;
    }
  }

  if (found !== true) {
    return null;
  }

  const path = graph.path;
  let count = 0;
  for (let n = goal; n !== -1; n = parent[n]) {
    count++;
  }
  path.count = count;
  path.cost = g[goal];
  let k = count - 1;
  for (let n = goal; n !== -1; n = parent[n], k--) {
    path.node[k] = n;
    path.pos[k * 3] = graph.node_pos[n * 3];
    path.pos[k * 3 + 1] = graph.node_pos[n * 3 + 1];
    path.pos[k * 3 + 2] = graph.node_pos[n * 3 + 2];
    path.flags[k] = plink[n] >= 0 ? graph.link_flags[plink[n]] : 0;
  }

  return path;
}

/*
==================
Nav_FindPath

A path from point from to point to (player origins), through the nodes
nearest each. Returns graph.path (see Nav_FindPathNodes) or null.
==================
*/
export function Nav_FindPath(graph, from, to) {
  const a = Nav_NearestNode(graph, from);
  if (a < 0) {
    return null;
  }
  const b = Nav_NearestNode(graph, to);
  if (b < 0) {
    return null;
  }
  return Nav_FindPathNodes(graph, a, b);
}

/*
==================
Nav_Components

Connected components with links taken as two-way; for diagnostics. Returns
an Int32Array of component ids (allocates).
==================
*/
export function Nav_Components(graph) {
  const N = graph.node_count;
  const parent = new Int32Array(N);
  for (let i = 0; i < N; i++) {
    parent[i] = i;
  }
  const find = (i) => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }

    return i;
  };

  for (let a = 0; a < N; a++) {
    for (let l = graph.link_start[a]; l < graph.link_start[a + 1]; l++) {
      const ra = find(a), rb = find(graph.link_to[l]);
      if (ra !== rb) {
        parent[ra] = rb;
      }
    }
  }

  for (let i = 0; i < N; i++) {
    parent[i] = find(i);
  }
  return parent;
}
