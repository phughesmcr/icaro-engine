// Ported from: WinQuake/cl_tent.c -- client side temporary entities

import { Con_Printf } from "./common.js";
import { Host_Error } from "./host.js";
import { MSG_ReadByte, MSG_ReadCoord, MSG_ReadShort } from "./common.js";
import {
  TE_BEAM,
  TE_EXPLOSION,
  TE_EXPLOSION2,
  TE_GUNSHOT,
  TE_KNIGHTSPIKE,
  TE_LAVASPLASH,
  TE_LIGHTNING1,
  TE_LIGHTNING2,
  TE_LIGHTNING3,
  TE_SPIKE,
  TE_SUPERSPIKE,
  TE_TAREXPLOSION,
  TE_TELEPORT,
  TE_WIZSPIKE,
} from "./protocol.js";
import {
  cl,
  cl_beams,
  cl_entities,
  cl_numvisedicts,
  cl_temp_entities,
  cl_visedicts,
  MAX_BEAMS,
  MAX_TEMP_ENTITIES,
  MAX_VISEDICTS,
  set_cl_numvisedicts,
} from "./client.js";
import { CL_AllocDlight } from "./cl_main.js";
import {
  M_PI,
  vec3_origin,
  VectorCopy,
  VectorNormalize,
  VectorSubtract,
} from "./mathlib.js";
import { S_PrecacheSound, S_StartSound } from "./snd_dma.js";
import {
  R_BlobExplosion,
  R_LavaSplash,
  R_ParticleExplosion,
  R_ParticleExplosion2,
  R_RunParticleEffect,
  R_TeleportSplash,
} from "./render.js";
import { Mod_ForName } from "./gl_model.js";

let num_temp_entities = 0;

let cl_sfx_wizhit = null;
let cl_sfx_knighthit = null;
let cl_sfx_tink1 = null;
let cl_sfx_ric1 = null;
let cl_sfx_ric2 = null;
let cl_sfx_ric3 = null;
let cl_sfx_r_exp3 = null;

export function CL_InitTEnts() {
  cl_sfx_wizhit = S_PrecacheSound("wizard/hit.wav");
  cl_sfx_knighthit = S_PrecacheSound("hknight/hit.wav");
  cl_sfx_tink1 = S_PrecacheSound("weapons/tink1.wav");
  cl_sfx_ric1 = S_PrecacheSound("weapons/ric1.wav");
  cl_sfx_ric2 = S_PrecacheSound("weapons/ric2.wav");
  cl_sfx_ric3 = S_PrecacheSound("weapons/ric3.wav");
  cl_sfx_r_exp3 = S_PrecacheSound("weapons/r_exp3.wav");
}

function CL_ParseBeam(m) {
  const start = new Float32Array(3);
  const end = new Float32Array(3);

  const ent = MSG_ReadShort();

  start[0] = MSG_ReadCoord();
  start[1] = MSG_ReadCoord();
  start[2] = MSG_ReadCoord();

  end[0] = MSG_ReadCoord();
  end[1] = MSG_ReadCoord();
  end[2] = MSG_ReadCoord();

  // cl_tent.c CL_ParseBeam: b->endtime = cl.time + 0.2. Prediction runs
  // on its own clock and leaves cl.time alone, so the C timing works.
  const beamTime = cl.time;

  // override any beam with the same entity
  for (let i = 0; i < MAX_BEAMS; i++) {
    const b = cl_beams[i];
    if (b.entity === ent) {
      b.entity = ent;
      b.model = m;
      b.endtime = beamTime + 0.2;
      VectorCopy(start, b.start);
      VectorCopy(end, b.end);
      return;
    }
  }

  // find a free beam (fix Golden Rule #2: use explicit null check)
  for (let i = 0; i < MAX_BEAMS; i++) {
    const b = cl_beams[i];
    if (b.model == null || b.endtime < beamTime) {
      b.entity = ent;
      b.model = m;
      b.endtime = beamTime + 0.2;
      VectorCopy(start, b.start);
      VectorCopy(end, b.end);
      return;
    }
  }

  Con_Printf("beam list overflow!\n");
}

export function CL_ParseTEnt() {
  const pos = new Float32Array(3);

  const type = MSG_ReadByte();
  switch (type) {
    case TE_WIZSPIKE: // spike hitting wall
      pos[0] = MSG_ReadCoord();
      pos[1] = MSG_ReadCoord();
      pos[2] = MSG_ReadCoord();
      R_RunParticleEffect(pos, vec3_origin, 20, 30);
      S_StartSound(-1, 0, cl_sfx_wizhit, pos, 1, 1);
      break;

    case TE_KNIGHTSPIKE: // spike hitting wall
      pos[0] = MSG_ReadCoord();
      pos[1] = MSG_ReadCoord();
      pos[2] = MSG_ReadCoord();
      R_RunParticleEffect(pos, vec3_origin, 226, 20);
      S_StartSound(-1, 0, cl_sfx_knighthit, pos, 1, 1);
      break;

    case TE_SPIKE: // spike hitting wall
      pos[0] = MSG_ReadCoord();
      pos[1] = MSG_ReadCoord();
      pos[2] = MSG_ReadCoord();
      R_RunParticleEffect(pos, vec3_origin, 0, 10);
      if (Math.random() * 5 | 0) {
        S_StartSound(-1, 0, cl_sfx_tink1, pos, 1, 1);
      } else {
        const rnd = Math.random() * 4 | 0; // rand() & 3: ric3 on 0 and 3
        if (rnd === 1) {
          S_StartSound(-1, 0, cl_sfx_ric1, pos, 1, 1);
        } else if (rnd === 2) {
          S_StartSound(-1, 0, cl_sfx_ric2, pos, 1, 1);
        } else {
          S_StartSound(-1, 0, cl_sfx_ric3, pos, 1, 1);
        }
      }

      break;

    case TE_SUPERSPIKE: // super spike hitting wall
      pos[0] = MSG_ReadCoord();
      pos[1] = MSG_ReadCoord();
      pos[2] = MSG_ReadCoord();
      R_RunParticleEffect(pos, vec3_origin, 0, 20);
      if (Math.random() * 5 | 0) {
        S_StartSound(-1, 0, cl_sfx_tink1, pos, 1, 1);
      } else {
        const rnd = Math.random() * 4 | 0; // rand() & 3: ric3 on 0 and 3
        if (rnd === 1) {
          S_StartSound(-1, 0, cl_sfx_ric1, pos, 1, 1);
        } else if (rnd === 2) {
          S_StartSound(-1, 0, cl_sfx_ric2, pos, 1, 1);
        } else {
          S_StartSound(-1, 0, cl_sfx_ric3, pos, 1, 1);
        }
      }

      break;

    case TE_GUNSHOT: // bullet hitting wall
      pos[0] = MSG_ReadCoord();
      pos[1] = MSG_ReadCoord();
      pos[2] = MSG_ReadCoord();
      R_RunParticleEffect(pos, vec3_origin, 0, 20);
      break;

    case TE_EXPLOSION: { // rocket explosion
      pos[0] = MSG_ReadCoord();
      pos[1] = MSG_ReadCoord();
      pos[2] = MSG_ReadCoord();
      R_ParticleExplosion(pos);
      const dl = CL_AllocDlight(0);
      VectorCopy(pos, dl.origin);
      dl.radius = 350;
      dl.die = cl.time + 0.5;
      dl.decay = 300;
      S_StartSound(-1, 0, cl_sfx_r_exp3, pos, 1, 1);
      break;
    }

    case TE_TAREXPLOSION: // tarbaby explosion
      pos[0] = MSG_ReadCoord();
      pos[1] = MSG_ReadCoord();
      pos[2] = MSG_ReadCoord();
      R_BlobExplosion(pos);
      S_StartSound(-1, 0, cl_sfx_r_exp3, pos, 1, 1);
      break;

    case TE_LIGHTNING1: // lightning bolts
      CL_ParseBeam(Mod_ForName("progs/bolt.mdl", true));
      break;

    case TE_LIGHTNING2: // lightning bolts
      CL_ParseBeam(Mod_ForName("progs/bolt2.mdl", true));
      break;

    case TE_LIGHTNING3: // lightning bolts
      CL_ParseBeam(Mod_ForName("progs/bolt3.mdl", true));
      break;

    // PGM 01/21/97
    case TE_BEAM: // grappling hook beam
      CL_ParseBeam(Mod_ForName("progs/beam.mdl", true));
      break;
    // PGM 01/21/97

    case TE_LAVASPLASH:
      pos[0] = MSG_ReadCoord();
      pos[1] = MSG_ReadCoord();
      pos[2] = MSG_ReadCoord();
      R_LavaSplash(pos);
      break;

    case TE_TELEPORT:
      pos[0] = MSG_ReadCoord();
      pos[1] = MSG_ReadCoord();
      pos[2] = MSG_ReadCoord();
      R_TeleportSplash(pos);
      break;

    case TE_EXPLOSION2: { // color mapped explosion
      pos[0] = MSG_ReadCoord();
      pos[1] = MSG_ReadCoord();
      pos[2] = MSG_ReadCoord();
      const colorStart = MSG_ReadByte();
      const colorLength = MSG_ReadByte();
      R_ParticleExplosion2(pos, colorStart, colorLength);
      const dl2 = CL_AllocDlight(0);
      VectorCopy(pos, dl2.origin);
      dl2.radius = 350;
      dl2.die = cl.time + 0.5;
      dl2.decay = 300;
      S_StartSound(-1, 0, cl_sfx_r_exp3, pos, 1, 1);
      break;
    }

    default:
      // Deviation: Sys_Error in id's C and Ironwail, which in the browser
      // replaces the page. Bad server data drops to the console instead.
      Host_Error("CL_ParseTEnt: bad type");
  }
}

function CL_NewTempEntity() {
  if (cl_numvisedicts === MAX_VISEDICTS) {
    return null;
  }
  if (num_temp_entities === MAX_TEMP_ENTITIES) {
    return null;
  }

  const ent = cl_temp_entities[num_temp_entities];

  // clear entity
  ent.forcelink = false;
  ent.model = null;
  ent.frame = 0;
  ent.colormap = null;
  ent.skinnum = 0;
  ent.effects = 0;
  ent.origin.fill(0);
  ent.angles.fill(0);

  num_temp_entities++;
  cl_visedicts[cl_numvisedicts] = ent;
  set_cl_numvisedicts(cl_numvisedicts + 1);

  ent.colormap = null; // vid.colormap
  return ent;
}

// CL_TEntRand
//
// Stands in for C's srand/rand in CL_UpdateTEnts (mulberry32). The seed is
// mixed, so neighbouring seeds give unrelated rolls, as rand() does.
let _tent_seed = 0;

export function CL_TEntSRand(seed) {
  _tent_seed = seed | 0;
}

export function CL_TEntRand() {
  _tent_seed = (_tent_seed + 0x6D2B79F5) | 0;
  let t = _tent_seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) & 0x7fffffff;
}

// Golden Rule #4: scratch vectors for CL_UpdateTEnts
const _beam_dist = new Float32Array(3);
const _beam_org = new Float32Array(3);

export function CL_UpdateTEnts() {
  num_temp_entities = 0;

  CL_TEntSRand(Math.floor(cl.time * 1000)); //johnfitz -- freeze beams when paused

  // cl_tent.c: beams expire against cl.time, as set in CL_ParseBeam
  const beamTime = cl.time;

  // update lightning
  for (let i = 0; i < MAX_BEAMS; i++) {
    const b = cl_beams[i];
    // Fix Golden Rule #2: use explicit null check instead of falsy check
    if (b.model == null || b.endtime < beamTime) {
      continue;
    }

    // if coming from the player, update the start position
    if (b.entity === cl.viewentity) {
      VectorCopy(cl_entities[cl.viewentity].origin, b.start);
    }

    // calculate pitch and yaw
    const dist = _beam_dist;
    VectorSubtract(b.end, b.start, dist);

    let yaw, pitch;
    if (dist[1] === 0 && dist[0] === 0) {
      yaw = 0;
      if (dist[2] > 0) {
        pitch = 90;
      } else {
        pitch = 270;
      }
    } else {
      yaw = (Math.atan2(dist[1], dist[0]) * 180 / M_PI) | 0;
      if (yaw < 0) {
        yaw += 360;
      }

      const forward = Math.sqrt(dist[0] * dist[0] + dist[1] * dist[1]);
      pitch = (Math.atan2(dist[2], forward) * 180 / M_PI) | 0;
      if (pitch < 0) {
        pitch += 360;
      }
    }

    // add new entities for the lightning
    const org = _beam_org;
    VectorCopy(b.start, org);
    let d = VectorNormalize(dist);
    while (d > 0) {
      const ent = CL_NewTempEntity();
      if (!ent) {
        return;
      }
      VectorCopy(org, ent.origin);
      ent.model = b.model;
      ent.angles[0] = pitch;
      ent.angles[1] = yaw;
      ent.angles[2] = CL_TEntRand() % 360;

      for (let j = 0; j < 3; j++) {
        org[j] += dist[j] * 30;
      }
      d -= 30;
    }
  }
}
