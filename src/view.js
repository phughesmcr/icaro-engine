// Ported from: WinQuake/view.c -- player eye positioning

import {
  IT_INVISIBILITY,
  IT_INVULNERABILITY,
  IT_QUAD,
  IT_SUIT,
  PITCH,
  ROLL,
  STAT_HEALTH,
  STAT_WEAPON,
  STAT_WEAPONFRAME,
  YAW,
} from "./quakedef.js";
import { MSG_ReadByte, MSG_ReadCoord } from "./common.js";
import { Cmd_AddCommand, Cmd_Argv } from "./cmd.js";
import {
  Cvar_RegisterVariable,
  Cvar_Set,
  cvar_t,
  Cvar_VariableValue,
} from "./cvar.js";
import {
  anglemod,
  AngleVectors,
  DotProduct,
  M_PI,
  VectorAdd,
  VectorCopy,
  VectorNormalize,
  VectorSubtract,
} from "./mathlib.js";
import { host_frametime, sv } from "./host.js";
import { noclip_anglehack } from "./host_cmd.js";
import { r_refdef } from "./render.js";
import {
  cl,
  cl_entities,
  cls,
  CSHIFT_BONUS,
  CSHIFT_CONTENTS,
  CSHIFT_DAMAGE,
  CSHIFT_POWERUP,
  NUM_CSHIFTS,
} from "./client.js";
import { cl_forwardspeed } from "./cl_input.js";
import { R_RenderView } from "./gl_rmain.js";
import { R_PushDlights } from "./gl_rlight.js";
import { con_forcedup } from "./console.js";
import { VID_UpdateGamma } from "./vid.js";
import { scr_viewsize } from "./gl_screen.js";
import {
  CL_GetPredictedPlayer,
  CL_GetValidSequence,
  cl_nopred,
  cl_prediction_active,
  cl_simangles,
  cl_simonground,
  cl_simorg,
  cl_simvel,
} from "./cl_pred.js";
import { PF_NOCLIP } from "./protocol.js";
import { isXRActive } from "./webxr.js";
import { v_blend } from "./glquake.js";

export { v_blend };

// Lazy-loaded Chase_Update (avoids circular dependency: in_web.js → view.js → chase.js → client.js)
let _Chase_Update = null;

/*

The view is allowed to move slightly from it's true position for bobbing,
but if it exceeds 8 pixels linear distance (spherical, not box), the list of
entities sent from the server may not include everything in the pvs, especially
when crossing a water boudnary.

*/

const lcd_x = new cvar_t("lcd_x", "0");
const lcd_yaw = new cvar_t("lcd_yaw", "0");

const scr_ofsx = new cvar_t("scr_ofsx", "0", false);
const scr_ofsy = new cvar_t("scr_ofsy", "0", false);
const scr_ofsz = new cvar_t("scr_ofsz", "0", false);

export const cl_rollspeed = new cvar_t("cl_rollspeed", "200");
export const cl_rollangle = new cvar_t("cl_rollangle", "2.0");

const cl_bob = new cvar_t("cl_bob", "0.02", false);
const cl_bobcycle = new cvar_t("cl_bobcycle", "0.6", false);
const cl_bobup = new cvar_t("cl_bobup", "0.5", false);

const v_kicktime = new cvar_t("v_kicktime", "0.5", false);
const v_kickroll = new cvar_t("v_kickroll", "0.6", false);
const v_kickpitch = new cvar_t("v_kickpitch", "0.6", false);

const v_iyaw_cycle = new cvar_t("v_iyaw_cycle", "2", false);
const v_iroll_cycle = new cvar_t("v_iroll_cycle", "0.5", false);
const v_ipitch_cycle = new cvar_t("v_ipitch_cycle", "1", false);
const v_iyaw_level = new cvar_t("v_iyaw_level", "0.3", false);
const v_iroll_level = new cvar_t("v_iroll_level", "0.1", false);
const v_ipitch_level = new cvar_t("v_ipitch_level", "0.3", false);

const v_idlescale = new cvar_t("v_idlescale", "0", false);

export const crosshair = new cvar_t("crosshair", "0", true); // view.c: "0", archived
export const cl_crossx = new cvar_t("cl_crossx", "0", false);
export const cl_crossy = new cvar_t("cl_crossy", "0", false);

const gl_cshiftpercent = new cvar_t("gl_cshiftpercent", "100", false);
// QuakeSpasm: per-type percentages, applied on top of gl_cshiftpercent
const gl_cshiftpercent_contents = new cvar_t(
  "gl_cshiftpercent_contents",
  "100",
  false,
);
const gl_cshiftpercent_damage = new cvar_t(
  "gl_cshiftpercent_damage",
  "100",
  false,
);
const gl_cshiftpercent_bonus = new cvar_t(
  "gl_cshiftpercent_bonus",
  "100",
  false,
);
const gl_cshiftpercent_powerup = new cvar_t(
  "gl_cshiftpercent_powerup",
  "100",
  false,
);
// indexed by CSHIFT_CONTENTS, CSHIFT_DAMAGE, CSHIFT_BONUS, CSHIFT_POWERUP
const cshiftpercent_cvars = [
  gl_cshiftpercent_contents,
  gl_cshiftpercent_damage,
  gl_cshiftpercent_bonus,
  gl_cshiftpercent_powerup,
];

// FitzQuake/Ironwail v_gunkick: 0 no kick, 1 id's kick, 2 kick lerped
// between server updates. Ironwail defaults to 2; 1 keeps id's behaviour.
export const v_gunkick = new cvar_t("v_gunkick", "1", true); //johnfitz

//johnfitz -- copied from cl.punchangle. 0 is current, 1 is previous value.
// Never the same unless the map just loaded. v_punchtime is Ironwail's
// cl.punchtime, kept here because client_state_t lives in client.js.
const v_punchangles = [new Float32Array(3), new Float32Array(3)];
let v_punchtime = 0;

let v_dmg_time = 0;
let v_dmg_roll = 0;
let v_dmg_pitch = 0;

// r_refdef is imported from render.js (the canonical source)
// Re-export for backwards compat with modules that import from view.js
export { r_refdef };

/*
===============
V_CalcRoll

Used by view and sv_user
===============
*/
const _forward = new Float32Array(3);
const _right = new Float32Array(3);
const _up = new Float32Array(3);

// Cached buffers for V_ParseDamage (Golden Rule #4)
const _damage_from = new Float32Array(3);
const _damage_forward = new Float32Array(3);
const _damage_right = new Float32Array(3);
const _damage_up = new Float32Array(3);

// Cached buffers for V_CalcRefdef (Golden Rule #4)
const _calcrefdef_forward = new Float32Array(3);
const _calcrefdef_right = new Float32Array(3);
const _calcrefdef_up = new Float32Array(3);
const _calcrefdef_angles = new Float32Array(3);

export function V_CalcRoll(angles, velocity) {
  AngleVectors(angles, _forward, _right, _up);
  let side = DotProduct(velocity, _right);
  const sign = side < 0 ? -1 : 1;
  side = Math.abs(side);

  const value = cl_rollangle.value;

  if (side < cl_rollspeed.value) {
    side = side * value / cl_rollspeed.value;
  } else {
    side = value;
  }

  return side * sign;
}

/*
===============
V_UsePrediction

True when the view should follow the QuakeWorld-style predicted state
(cl_simorg/cl_simangles/cl_simvel). Those are only written by
CL_PredictMove, which doesn't run with a local server or during demo
playback; there the view uses cl_entities[cl.viewentity] and cl state,
as WinQuake's view.c does.
===============
*/
export function V_UsePrediction() {
  return (sv.active === false) && (cls.demoplayback === false) &&
    (cl_nopred.value === 0) && cl_prediction_active;
}

/*
===============
V_CalcBob

===============
*/
let _bobtime = 0;
let _bob = 0;

export function V_CalcBob() {
  // Deliberate deviation, from Ironwail (view.c V_CalcBob): id divides by
  // cl_bobcycle, so "cl_bobcycle 0" made the view NaN.
  if (cl_bobcycle.value === 0) { // Avoid divide-by-zero, don't bob
    return 0;
  }

  if (V_UsePrediction() === false) {
    // WinQuake view.c V_CalcBob: phase from cl.time, server velocity,
    // keeps bobbing while airborne
    let cycle = cl.time -
      ((cl.time / cl_bobcycle.value) | 0) * cl_bobcycle.value;
    cycle /= cl_bobcycle.value;
    if (cycle < cl_bobup.value) {
      cycle = M_PI * cycle / cl_bobup.value;
    } else {
      cycle = M_PI + M_PI * (cycle - cl_bobup.value) / (1.0 - cl_bobup.value);
    }

    // bob is proportional to velocity in the xy plane
    // (don't count Z, or jumping messes it up)
    let bob = Math.sqrt(
      cl.velocity[0] * cl.velocity[0] + cl.velocity[1] * cl.velocity[1],
    ) * cl_bob.value;
    bob = bob * 0.3 + bob * 0.7 * Math.sin(cycle);
    if (bob > 4) {
      bob = 4;
    } else if (bob < -7) {
      bob = -7;
    }
    return bob;
  }

  // QuakeWorld: return 0 if spectator
  if (cl.spectator) {
    return 0;
  }

  // QuakeWorld: when in air, keep returning old bob value
  if (cl_simonground === -1) {
    return _bob;
  }

  _bobtime += host_frametime;
  let cycle = _bobtime -
    ((_bobtime / cl_bobcycle.value) | 0) * cl_bobcycle.value;
  cycle /= cl_bobcycle.value;
  if (cycle < cl_bobup.value) {
    cycle = M_PI * cycle / cl_bobup.value;
  } else {
    cycle = M_PI + M_PI * (cycle - cl_bobup.value) / (1.0 - cl_bobup.value);
  }

  // bob is proportional to SIMULATED velocity in the xy plane
  // (don't count Z, or jumping messes it up)
  // QuakeWorld uses cl.simvel for predicted velocity
  _bob = Math.sqrt(cl_simvel[0] * cl_simvel[0] + cl_simvel[1] * cl_simvel[1]) *
    cl_bob.value;
  _bob = _bob * 0.3 + _bob * 0.7 * Math.sin(cycle);
  if (_bob > 4) {
    _bob = 4;
  } else if (_bob < -7) {
    _bob = -7;
  }
  return _bob;
}

//=============================================================================

const v_centermove = new cvar_t("v_centermove", "0.15", false);
const v_centerspeed = new cvar_t("v_centerspeed", "500");

export function V_StartPitchDrift() {
  if (cl.laststop === cl.time) {
    return; // something else is keeping it from drifting
  }

  if (cl.nodrift || !cl.pitchvel) {
    cl.pitchvel = v_centerspeed.value;
    cl.nodrift = false;
    cl.driftmove = 0;
  }
}

/*
===============
V_UpdatePunchAngles

From Ironwail (cl_parse.c CL_ParseClientdata): remember the previous
punchangle and when it changed, for v_gunkick 2.
===============
*/
export function V_UpdatePunchAngles() {
  const cur = v_punchangles[0];
  if (
    cur[0] !== cl.punchangle[0] || cur[1] !== cl.punchangle[1] ||
    cur[2] !== cl.punchangle[2]
  ) {
    v_punchangles[1].set(cur);
    cur.set(cl.punchangle);
    v_punchtime = cl.time;
  }
}

/*
===============
V_AddPunchAngles

The weapon kick from Ironwail's V_CalcRefdef (johnfitz v_gunkick)
===============
*/
export function V_AddPunchAngles(angles) {
  if (v_gunkick.value === 1) { // original quake kick
    VectorAdd(angles, cl.punchangle, angles);
  } else if (v_gunkick.value === 2) { // lerped kick
    let punchblend = (cl.time - v_punchtime) / 0.1;
    if (punchblend < 0) punchblend = 0;
    if (punchblend > 1) punchblend = 1;

    const prev = v_punchangles[1];
    const cur = v_punchangles[0];
    for (let i = 0; i < 3; i++) {
      angles[i] += prev[i] + (cur[i] - prev[i]) * punchblend;
    }
  }
}

// Ironwail clears these with client_state_t in CL_ClearState
export function V_ResetPunchAngles() {
  v_punchangles[0].fill(0);
  v_punchangles[1].fill(0);
  v_punchtime = 0;
}

/*
===============
V_ResetEffects

From Ironwail (view.c), called by CL_Disconnect: clear the screen blend and
damage kick so they don't linger after a disconnect.
===============
*/
export function V_ResetEffects() {
  cshift_empty.percent = 0;
  v_blend.fill(0);
  v_dmg_time = 0;
  v_dmg_roll = 0;
  v_dmg_pitch = 0;
}

export function V_StopPitchDrift() {
  cl.laststop = cl.time;
  cl.nodrift = true;
  cl.pitchvel = 0;
}

/*
===============
V_DriftPitch

Moves the client pitch angle towards cl.idealpitch sent by the server.

If the user is adjusting pitch manually, either with lookup/lookdown,
mlook and mouse, or klook and keyboard, pitch drifting is constantly stopped.

Drifting is enabled when the center view key is hit, mlook is released and
lookspring is non 0, or when
===============
*/
function V_DriftPitch() {
  if (noclip_anglehack || !cl.onground || cls.demoplayback) {
    cl.driftmove = 0;
    cl.pitchvel = 0;
    return;
  }

  // don't count small mouse motion
  if (cl.nodrift) {
    if (Math.abs(cl.cmd.forwardmove) < cl_forwardspeed.value) {
      cl.driftmove = 0;
    } else {
      cl.driftmove += host_frametime;
    }

    if (cl.driftmove > v_centermove.value) {
      V_StartPitchDrift();
    }

    return;
  }

  const delta = cl.idealpitch - cl.viewangles[PITCH];

  if (!delta) {
    cl.pitchvel = 0;
    return;
  }

  let move = host_frametime * cl.pitchvel;
  cl.pitchvel += host_frametime * v_centerspeed.value;

  if (delta > 0) {
    if (move > delta) {
      cl.pitchvel = 0;
      move = delta;
    }

    cl.viewangles[PITCH] += move;
  } else if (delta < 0) {
    if (move > -delta) {
      cl.pitchvel = 0;
      move = -delta;
    }

    cl.viewangles[PITCH] -= move;
  }
}

/*
==============================================================================

						PALETTE FLASHES

==============================================================================
*/

export const cshift_empty = { destcolor: [130, 80, 50], percent: 0 };
export const cshift_water = { destcolor: [130, 80, 50], percent: 128 };
export const cshift_slime = { destcolor: [0, 25, 5], percent: 150 };
export const cshift_lava = { destcolor: [255, 80, 0], percent: 150 };

export const v_gamma = new cvar_t("gamma", "1", true);

const gammatable = new Uint8Array(256);

function BuildGammaTable(g) {
  if (g === 1.0) {
    for (let i = 0; i < 256; i++) {
      gammatable[i] = i;
    }
    return;
  }

  for (let i = 0; i < 256; i++) {
    let inf = (255 * Math.pow((i + 0.5) / 255.5, g) + 0.5) | 0;
    if (inf < 0) {
      inf = 0;
    }
    if (inf > 255) {
      inf = 255;
    }
    gammatable[i] = inf;
  }
}

/*
=================
V_CheckGamma
=================
*/
let _oldgammavalue = 0;

function V_CheckGamma() {
  if (v_gamma.value === _oldgammavalue) {
    return false;
  }
  _oldgammavalue = v_gamma.value;

  BuildGammaTable(v_gamma.value);
  VID_UpdateGamma(v_gamma.value);
  // vid.recalc_refdef = 1;  // force a surface cache flush

  return true;
}

/*
===============
V_ParseDamage
===============
*/
export function V_ParseDamage() {
  const armor = MSG_ReadByte();
  const blood = MSG_ReadByte();
  // Use cached buffer to avoid per-call allocations (Golden Rule #4)
  const from = _damage_from;
  for (let i = 0; i < 3; i++) {
    from[i] = MSG_ReadCoord();
  }

  let count = blood * 0.5 + armor * 0.5;
  if (count < 10) {
    count = 10;
  }

  cl.faceanimtime = cl.time + 0.2; // put sbar face into pain frame

  cl.cshifts[CSHIFT_DAMAGE].percent += 3 * count;
  if (cl.cshifts[CSHIFT_DAMAGE].percent < 0) {
    cl.cshifts[CSHIFT_DAMAGE].percent = 0;
  }
  if (cl.cshifts[CSHIFT_DAMAGE].percent > 150) {
    cl.cshifts[CSHIFT_DAMAGE].percent = 150;
  }

  if (armor > blood) {
    cl.cshifts[CSHIFT_DAMAGE].destcolor[0] = 200;
    cl.cshifts[CSHIFT_DAMAGE].destcolor[1] = 100;
    cl.cshifts[CSHIFT_DAMAGE].destcolor[2] = 100;
  } else if (armor) {
    cl.cshifts[CSHIFT_DAMAGE].destcolor[0] = 220;
    cl.cshifts[CSHIFT_DAMAGE].destcolor[1] = 50;
    cl.cshifts[CSHIFT_DAMAGE].destcolor[2] = 50;
  } else {
    cl.cshifts[CSHIFT_DAMAGE].destcolor[0] = 255;
    cl.cshifts[CSHIFT_DAMAGE].destcolor[1] = 0;
    cl.cshifts[CSHIFT_DAMAGE].destcolor[2] = 0;
  }

  //
  // calculate view angle kicks
  // QuakeWorld uses predicted origin and angles; WinQuake uses
  // cl_entities[cl.viewentity] (the only valid state without prediction)
  //
  const usePrediction = V_UsePrediction();
  const ent = cl_entities[cl.viewentity];

  VectorSubtract(from, usePrediction ? cl_simorg : ent.origin, from);
  VectorNormalize(from);

  // Use cached buffers to avoid per-call allocations (Golden Rule #4)
  const forward = _damage_forward;
  const right = _damage_right;
  const up = _damage_up;
  AngleVectors(usePrediction ? cl_simangles : ent.angles, forward, right, up);

  let side = DotProduct(from, right);
  v_dmg_roll = count * side * v_kickroll.value;

  side = DotProduct(from, forward);
  v_dmg_pitch = count * side * v_kickpitch.value;

  v_dmg_time = v_kicktime.value;
}

/*
==================
V_cshift_f
==================
*/
function V_cshift_f() {
  cshift_empty.destcolor[0] = parseInt(Cmd_Argv(1)) || 0;
  cshift_empty.destcolor[1] = parseInt(Cmd_Argv(2)) || 0;
  cshift_empty.destcolor[2] = parseInt(Cmd_Argv(3)) || 0;
  cshift_empty.percent = parseInt(Cmd_Argv(4)) || 0;
}

/*
==================
V_BonusFlash_f

When you run over an item, the server sends this command
==================
*/
function V_BonusFlash_f() {
  cl.cshifts[CSHIFT_BONUS].destcolor[0] = 215;
  cl.cshifts[CSHIFT_BONUS].destcolor[1] = 186;
  cl.cshifts[CSHIFT_BONUS].destcolor[2] = 69;
  cl.cshifts[CSHIFT_BONUS].percent = 50;
}

/*
=============
V_SetContentsColor

Underwater, lava, etc each has a color shift
=============
*/
const CONTENTS_EMPTY = -1;
const CONTENTS_SOLID = -2;
const CONTENTS_SLIME = -4;
const CONTENTS_LAVA = -5;
const CONTENTS_SKY = -6;

export function V_SetContentsColor(contents) {
  switch (contents) {
    case CONTENTS_EMPTY:
    case CONTENTS_SOLID:
    // Deviation (FitzQuake/QuakeSpasm): id's C falls to the default case
    // and gives the water tint inside sky brushes. No blend in sky.
    case CONTENTS_SKY: //johnfitz -- no blend in sky
      cl.cshifts[CSHIFT_CONTENTS].destcolor[0] = cshift_empty.destcolor[0];
      cl.cshifts[CSHIFT_CONTENTS].destcolor[1] = cshift_empty.destcolor[1];
      cl.cshifts[CSHIFT_CONTENTS].destcolor[2] = cshift_empty.destcolor[2];
      cl.cshifts[CSHIFT_CONTENTS].percent = cshift_empty.percent;
      break;
    case CONTENTS_LAVA:
      cl.cshifts[CSHIFT_CONTENTS].destcolor[0] = cshift_lava.destcolor[0];
      cl.cshifts[CSHIFT_CONTENTS].destcolor[1] = cshift_lava.destcolor[1];
      cl.cshifts[CSHIFT_CONTENTS].destcolor[2] = cshift_lava.destcolor[2];
      cl.cshifts[CSHIFT_CONTENTS].percent = cshift_lava.percent;
      break;
    case CONTENTS_SLIME:
      cl.cshifts[CSHIFT_CONTENTS].destcolor[0] = cshift_slime.destcolor[0];
      cl.cshifts[CSHIFT_CONTENTS].destcolor[1] = cshift_slime.destcolor[1];
      cl.cshifts[CSHIFT_CONTENTS].destcolor[2] = cshift_slime.destcolor[2];
      cl.cshifts[CSHIFT_CONTENTS].percent = cshift_slime.percent;
      break;
    default:
      cl.cshifts[CSHIFT_CONTENTS].destcolor[0] = cshift_water.destcolor[0];
      cl.cshifts[CSHIFT_CONTENTS].destcolor[1] = cshift_water.destcolor[1];
      cl.cshifts[CSHIFT_CONTENTS].destcolor[2] = cshift_water.destcolor[2];
      cl.cshifts[CSHIFT_CONTENTS].percent = cshift_water.percent;
  }
}

/*
=============
V_CalcPowerupCshift
=============
*/
function V_CalcPowerupCshift() {
  if (cl.items & IT_QUAD) {
    cl.cshifts[CSHIFT_POWERUP].destcolor[0] = 0;
    cl.cshifts[CSHIFT_POWERUP].destcolor[1] = 0;
    cl.cshifts[CSHIFT_POWERUP].destcolor[2] = 255;
    cl.cshifts[CSHIFT_POWERUP].percent = 30;
  } else if (cl.items & IT_SUIT) {
    cl.cshifts[CSHIFT_POWERUP].destcolor[0] = 0;
    cl.cshifts[CSHIFT_POWERUP].destcolor[1] = 255;
    cl.cshifts[CSHIFT_POWERUP].destcolor[2] = 0;
    cl.cshifts[CSHIFT_POWERUP].percent = 20;
  } else if (cl.items & IT_INVISIBILITY) {
    cl.cshifts[CSHIFT_POWERUP].destcolor[0] = 100;
    cl.cshifts[CSHIFT_POWERUP].destcolor[1] = 100;
    cl.cshifts[CSHIFT_POWERUP].destcolor[2] = 100;
    cl.cshifts[CSHIFT_POWERUP].percent = 100;
  } else if (cl.items & IT_INVULNERABILITY) {
    cl.cshifts[CSHIFT_POWERUP].destcolor[0] = 255;
    cl.cshifts[CSHIFT_POWERUP].destcolor[1] = 255;
    cl.cshifts[CSHIFT_POWERUP].destcolor[2] = 0;
    cl.cshifts[CSHIFT_POWERUP].percent = 30;
  } else {
    cl.cshifts[CSHIFT_POWERUP].percent = 0;
  }
}

/*
=============
V_CalcBlend
=============
*/
export function V_CalcBlend() {
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;

  for (let j = 0; j < NUM_CSHIFTS; j++) {
    if (gl_cshiftpercent.value === 0) {
      continue;
    }

    let a2 = ((cl.cshifts[j].percent * gl_cshiftpercent.value) / 100.0) / 255.0;
    // QuakeSpasm -- also scale by the specific gl_cshiftpercent_* cvar
    a2 *= cshiftpercent_cvars[j].value / 100.0;

    if (a2 === 0) {
      continue;
    }
    a = a + a2 * (1 - a);
    a2 = a2 / a;
    r = r * (1 - a2) + cl.cshifts[j].destcolor[0] * a2;
    g = g * (1 - a2) + cl.cshifts[j].destcolor[1] * a2;
    b = b * (1 - a2) + cl.cshifts[j].destcolor[2] * a2;
  }

  v_blend[0] = r / 255.0;
  v_blend[1] = g / 255.0;
  v_blend[2] = b / 255.0;
  v_blend[3] = a;
  if (v_blend[3] > 1) {
    v_blend[3] = 1;
  }
  if (v_blend[3] < 0) {
    v_blend[3] = 0;
  }
}

/*
=============
V_UpdatePalette
=============
*/
export function V_UpdatePalette() {
  V_CalcPowerupCshift();

  let _new = false;

  for (let i = 0; i < NUM_CSHIFTS; i++) {
    if (cl.cshifts[i].percent !== cl.prev_cshifts[i].percent) {
      _new = true;
      cl.prev_cshifts[i].percent = cl.cshifts[i].percent;
    }

    for (let j = 0; j < 3; j++) {
      if (cl.cshifts[i].destcolor[j] !== cl.prev_cshifts[i].destcolor[j]) {
        _new = true;
        cl.prev_cshifts[i].destcolor[j] = cl.cshifts[i].destcolor[j];
      }
    }
  }

  // drop the damage value
  cl.cshifts[CSHIFT_DAMAGE].percent -= host_frametime * 150;
  if (cl.cshifts[CSHIFT_DAMAGE].percent <= 0) {
    cl.cshifts[CSHIFT_DAMAGE].percent = 0;
  }

  // drop the bonus value
  cl.cshifts[CSHIFT_BONUS].percent -= host_frametime * 100;
  if (cl.cshifts[CSHIFT_BONUS].percent <= 0) {
    cl.cshifts[CSHIFT_BONUS].percent = 0;
  }

  const force = V_CheckGamma();
  if (!_new && !force) {
    return;
  }

  V_CalcBlend();
}

/*
==============================================================================

						VIEW RENDERING

==============================================================================
*/

function angledelta(a) {
  let result = anglemod(a);
  if (result > 180) {
    result -= 360;
  }
  return result;
}

/*
==================
CalcGunAngle
==================
*/
let _gun_oldyaw = 0;
let _gun_oldpitch = 0;

function CalcGunAngle() {
  let yaw = r_refdef.viewangles[YAW];
  let pitch = -r_refdef.viewangles[PITCH];

  yaw = angledelta(yaw - r_refdef.viewangles[YAW]) * 0.4;
  if (yaw > 10) {
    yaw = 10;
  }
  if (yaw < -10) {
    yaw = -10;
  }
  pitch = angledelta(-pitch - r_refdef.viewangles[PITCH]) * 0.4;
  if (pitch > 10) {
    pitch = 10;
  }
  if (pitch < -10) {
    pitch = -10;
  }
  const move = host_frametime * 20;
  if (yaw > _gun_oldyaw) {
    if (_gun_oldyaw + move < yaw) {
      yaw = _gun_oldyaw + move;
    }
  } else {
    if (_gun_oldyaw - move > yaw) {
      yaw = _gun_oldyaw - move;
    }
  }

  if (pitch > _gun_oldpitch) {
    if (_gun_oldpitch + move < pitch) {
      pitch = _gun_oldpitch + move;
    }
  } else {
    if (_gun_oldpitch - move > pitch) {
      pitch = _gun_oldpitch - move;
    }
  }

  _gun_oldyaw = yaw;
  _gun_oldpitch = pitch;

  cl.viewent.angles[YAW] = r_refdef.viewangles[YAW] + yaw;
  cl.viewent.angles[PITCH] = -(r_refdef.viewangles[PITCH] + pitch);

  cl.viewent.angles[ROLL] -= v_idlescale.value *
    Math.sin(cl.time * v_iroll_cycle.value) * v_iroll_level.value;
  cl.viewent.angles[PITCH] -= v_idlescale.value *
    Math.sin(cl.time * v_ipitch_cycle.value) * v_ipitch_level.value;
  cl.viewent.angles[YAW] -= v_idlescale.value *
    Math.sin(cl.time * v_iyaw_cycle.value) * v_iyaw_level.value;
}

/*
==============
V_BoundOffsets
==============
*/
function V_BoundOffsets(playerorg) {
  // absolutely bound refresh reletive to entity clipping hull
  // so the view can never be inside a solid wall

  if (r_refdef.vieworg[0] < playerorg[0] - 14) {
    r_refdef.vieworg[0] = playerorg[0] - 14;
  } else if (r_refdef.vieworg[0] > playerorg[0] + 14) {
    r_refdef.vieworg[0] = playerorg[0] + 14;
  }
  if (r_refdef.vieworg[1] < playerorg[1] - 14) {
    r_refdef.vieworg[1] = playerorg[1] - 14;
  } else if (r_refdef.vieworg[1] > playerorg[1] + 14) {
    r_refdef.vieworg[1] = playerorg[1] + 14;
  }
  if (r_refdef.vieworg[2] < playerorg[2] - 22) {
    r_refdef.vieworg[2] = playerorg[2] - 22;
  } else if (r_refdef.vieworg[2] > playerorg[2] + 30) {
    r_refdef.vieworg[2] = playerorg[2] + 30;
  }
}

/*
==============
V_AddIdle

Idle swaying
==============
*/
function V_AddIdle() {
  r_refdef.viewangles[ROLL] += v_idlescale.value *
    Math.sin(cl.time * v_iroll_cycle.value) * v_iroll_level.value;
  r_refdef.viewangles[PITCH] += v_idlescale.value *
    Math.sin(cl.time * v_ipitch_cycle.value) * v_ipitch_level.value;
  r_refdef.viewangles[YAW] += v_idlescale.value *
    Math.sin(cl.time * v_iyaw_cycle.value) * v_iyaw_level.value;
}

/*
==============
V_CalcViewRoll

Roll is induced by movement and damage
==============
*/
export function V_CalcViewRoll() {
  // In WebXR the headset owns the view orientation: rolling or kicking the
  // rig is a comfort problem, so skip strafe roll, damage kick and the dead
  // roll (the kick timer still runs down).
  const xr = isXRActive();

  // QuakeWorld uses predicted angles and velocity for roll calculation;
  // WinQuake uses cl_entities[cl.viewentity].angles and cl.velocity
  if (xr === false) {
    const side = V_UsePrediction() ?
      V_CalcRoll(cl_simangles, cl_simvel) :
      V_CalcRoll(cl_entities[cl.viewentity].angles, cl.velocity);
    r_refdef.viewangles[ROLL] += side;
  }

  if (v_dmg_time > 0) {
    if (xr === false) {
      r_refdef.viewangles[ROLL] += v_dmg_time / v_kicktime.value * v_dmg_roll;
      r_refdef.viewangles[PITCH] += v_dmg_time / v_kicktime.value * v_dmg_pitch;
    }

    v_dmg_time -= host_frametime;
  }

  if (xr === false && cl.stats[STAT_HEALTH] <= 0) {
    r_refdef.viewangles[ROLL] = 80; // dead view angle
    return;
  }
}

/*
==================
V_CalcIntermissionRefdef

==================
*/
export function V_CalcIntermissionRefdef() {
  // ent is the player model (visible when out of body)
  // During intermission, the player entity is moved to info_intermission position
  const ent = cl_entities[cl.viewentity];
  // view is the weapon model (only visible from inside body)
  const view = cl.viewent;

  // Use entity origin (server moves player to intermission camera position)
  VectorCopy(ent.origin, r_refdef.vieworg);
  // C uses ent->angles: the server's player angles, which QuakeC sets to the
  // intermission camera's mangle (MOVETYPE_NONE keeps them there).
  // cl.viewangles can't be used: the mouse still moves them.
  // On the NQ entity path ent.angles holds those server angles. On the
  // packet-entity path players carry no angles and V_CalcRefdef rewrites
  // ent.angles from cl.viewangles, so use the angles of the last
  // svc_setangle, which QuakeC sends with the same mangle (fixangle).
  VectorCopy(
    CL_GetValidSequence() === 0 ? ent.angles : cl.setangles,
    r_refdef.viewangles,
  );
  view.model = null;

  // allways idle in intermission (not in WebXR: no swaying the headset view)
  if (isXRActive() === false) {
    const old = v_idlescale.value;
    v_idlescale.value = 1;
    V_AddIdle();
    v_idlescale.value = old;
  }
}

/*
==================
V_CalcRefdef

==================
*/
let _oldz = 0;

/*
==================
V_InNoclip

True when the view player is in noclip: noclip_anglehack where this
process runs the server, else PF_NOCLIP from its last svc_playerinfo.
==================
*/
function V_InNoclip() {
  if (noclip_anglehack) {
    return true;
  }

  const pplayer = CL_GetPredictedPlayer(cl.viewentity - 1);
  return pplayer !== null && (pplayer.flags & PF_NOCLIP) !== 0;
}

export function V_CalcRefdef() {
  V_DriftPitch();

  // ent is the player model (visible when out of body)
  const ent = cl_entities[cl.viewentity];
  // view is the weapon model (only visible from inside body)
  const view = cl.viewent;

  // Use predicted position for local player when running remotely (QuakeWorld-style prediction)
  // Use server-interpolated position when running locally, during demos, or if prediction is disabled
  const usePrediction = V_UsePrediction();
  const playerorg = usePrediction ? cl_simorg : ent.origin;
  const xr = isXRActive();

  // transform the view offset by the model's matrix to get the offset from
  // model origin for the view
  ent.angles[YAW] = cl.viewangles[YAW]; // the model should face the view dir
  ent.angles[PITCH] = -cl.viewangles[PITCH]; // the model should face the view dir

  // no view bob in WebXR (comfort)
  const bob = xr ? 0 : V_CalcBob();

  // refresh position
  VectorCopy(playerorg, r_refdef.vieworg);
  r_refdef.vieworg[2] += cl.viewheight + bob;

  // never let it sit exactly on a node line, because a water plane can
  // dissapear when viewed with the eye exactly on it.
  // the server protocol only specifies to 1/16 pixel, so add 1/32 in each axis
  r_refdef.vieworg[0] += 1.0 / 32;
  r_refdef.vieworg[1] += 1.0 / 32;
  r_refdef.vieworg[2] += 1.0 / 32;

  VectorCopy(cl.viewangles, r_refdef.viewangles);
  V_CalcViewRoll();
  if (xr === false) {
    V_AddIdle();
  }

  // offsets - QuakeWorld uses simangles for prediction
  const forward = _calcrefdef_forward;
  const right = _calcrefdef_right;
  const up = _calcrefdef_up;
  if (usePrediction) {
    AngleVectors(cl_simangles, forward, right, up);
  } else {
    // Use entity angles like WinQuake for local play
    const angles = _calcrefdef_angles;
    angles[PITCH] = -ent.angles[PITCH]; // because entity pitches are actually backward
    angles[YAW] = ent.angles[YAW];
    angles[ROLL] = ent.angles[ROLL];
    AngleVectors(angles, forward, right, up);
  }

  for (let i = 0; i < 3; i++) {
    r_refdef.vieworg[i] += scr_ofsx.value * forward[i] +
      scr_ofsy.value * right[i] +
      scr_ofsz.value * up[i];
  }

  V_BoundOffsets(playerorg);

  // set up gun position - QuakeWorld uses simangles for prediction
  if (usePrediction) {
    VectorCopy(cl_simangles, view.angles);
  } else {
    VectorCopy(cl.viewangles, view.angles);
  }

  CalcGunAngle();

  VectorCopy(playerorg, view.origin);
  view.origin[2] += cl.viewheight;

  for (let i = 0; i < 3; i++) {
    view.origin[i] += forward[i] * bob * 0.4;
  }

  view.origin[2] += bob;

  // fudge position around to keep amount of weapon visible
  // roughly equal with different FOV
  if (scr_viewsize.value === 110) {
    view.origin[2] += 1;
  } else if (scr_viewsize.value === 100) {
    view.origin[2] += 2;
  } else if (scr_viewsize.value === 90) {
    view.origin[2] += 1;
  } else if (scr_viewsize.value === 80) {
    view.origin[2] += 0.5;
  }

  view.model = cl.model_precache[cl.stats[STAT_WEAPON]];
  view.frame = cl.stats[STAT_WEAPONFRAME];
  view.colormap = null; // vid.colormap

  // set up the refresh position (no weapon kick in WebXR)
  if (xr === false) {
    V_AddPunchAngles(r_refdef.viewangles);
  }

  // smooth out stair step ups
  // QuakeWorld uses predicted onground state
  // Deliberate deviation, from FitzQuake/Ironwail (view.c V_CalcRefdef):
  // no smoothing in noclip, where FL_ONGROUND stays set and flying up
  // lagged the view. Ironwail tests noclip_anglehack, which is only set
  // where the server runs, so also check the view player's PF_NOCLIP.
  const onGround = usePrediction ? (cl_simonground !== -1) : cl.onground;
  if (V_InNoclip() === false && onGround && playerorg[2] - _oldz > 0) {
    let steptime = cl.time - cl.oldtime;
    if (steptime < 0) {
      steptime = 0;
    }

    _oldz += steptime * 80;
    if (_oldz > playerorg[2]) {
      _oldz = playerorg[2];
    }
    if (playerorg[2] - _oldz > 12) {
      _oldz = playerorg[2] - 12;
    }
    r_refdef.vieworg[2] += _oldz - playerorg[2];
    view.origin[2] += _oldz - playerorg[2];
  } else {
    _oldz = playerorg[2];
  }

  if (Cvar_VariableValue("chase_active") !== 0 && _Chase_Update != null) {
    _Chase_Update();
  }
}

/*
==================
V_RenderView

The player's clipping box goes from (-16 -16 -24) to (16 16 32) from
the entity origin, so any view position inside that will be valid
==================
*/
export function V_RenderView() {
  if (con_forcedup) {
    return;
  }

  // don't allow cheats in multiplayer
  if (cl.maxclients > 1) {
    Cvar_Set("scr_ofsx", "0");
    Cvar_Set("scr_ofsy", "0");
    Cvar_Set("scr_ofsz", "0");
  }

  if (cl.intermission) {
    // intermission / finale rendering
    V_CalcIntermissionRefdef();
  } else {
    if (!cl.paused) {
      V_CalcRefdef();
    }
  }

  R_PushDlights(cl);
  R_RenderView();
}

//============================================================================

/*
=============
V_Init
=============
*/
export function V_Init() {
  Cmd_AddCommand("v_cshift", V_cshift_f);
  Cmd_AddCommand("bf", V_BonusFlash_f);
  Cmd_AddCommand("centerview", V_StartPitchDrift);

  Cvar_RegisterVariable(lcd_x);
  Cvar_RegisterVariable(lcd_yaw);

  Cvar_RegisterVariable(v_centermove);
  Cvar_RegisterVariable(v_centerspeed);

  Cvar_RegisterVariable(v_iyaw_cycle);
  Cvar_RegisterVariable(v_iroll_cycle);
  Cvar_RegisterVariable(v_ipitch_cycle);
  Cvar_RegisterVariable(v_iyaw_level);
  Cvar_RegisterVariable(v_iroll_level);
  Cvar_RegisterVariable(v_ipitch_level);

  Cvar_RegisterVariable(v_idlescale);
  Cvar_RegisterVariable(gl_cshiftpercent);
  Cvar_RegisterVariable(gl_cshiftpercent_contents); // QuakeSpasm
  Cvar_RegisterVariable(gl_cshiftpercent_damage); // QuakeSpasm
  Cvar_RegisterVariable(gl_cshiftpercent_bonus); // QuakeSpasm
  Cvar_RegisterVariable(gl_cshiftpercent_powerup); // QuakeSpasm

  Cvar_RegisterVariable(scr_ofsx);
  Cvar_RegisterVariable(scr_ofsy);
  Cvar_RegisterVariable(scr_ofsz);
  Cvar_RegisterVariable(cl_rollspeed);
  Cvar_RegisterVariable(cl_rollangle);
  Cvar_RegisterVariable(cl_bob);
  Cvar_RegisterVariable(cl_bobcycle);
  Cvar_RegisterVariable(cl_bobup);

  Cvar_RegisterVariable(v_kicktime);
  Cvar_RegisterVariable(v_kickroll);
  Cvar_RegisterVariable(v_kickpitch);

  Cvar_RegisterVariable(crosshair);
  Cvar_RegisterVariable(v_gunkick); //johnfitz
  Cvar_RegisterVariable(cl_crossx);
  Cvar_RegisterVariable(cl_crossy);

  BuildGammaTable(1.0); // no gamma yet
  Cvar_RegisterVariable(v_gamma);
  VID_UpdateGamma(v_gamma.value);

  // Lazy-load Chase_Update to avoid circular dependency
  import("./chase.js").then((mod) => {
    _Chase_Update = mod.Chase_Update;
  });
}
