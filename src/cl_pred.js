// Ported from: QuakeWorld/client/cl_pred.c
// Client-side prediction for smooth movement with low server tick rates

import { VectorCopy } from "./mathlib.js";
import { Q_atof } from "./common.js";
import { Cvar_RegisterVariable, cvar_t } from "./cvar.js";
import { Cmd_AddCommand, Cmd_Argc, Cmd_Argv } from "./cmd.js";
import {
  movevars,
  player_maxs,
  player_mins,
  PlayerMove,
  PM_GetOnGround,
  PM_GetWaterType,
  PM_MOVETYPE_FLY,
  PM_MOVETYPE_NOCLIP,
  PM_MOVETYPE_WALK,
  PM_NQ_CheckGround,
  pmove,
  Pmove_Init,
} from "./pmove.js";
import { CONTENTS_EMPTY } from "./bspfile.js";
import { cl, cl_entities, packet_entities_t } from "./client.js";
import { STAT_HEALTH } from "./quakedef.js";
import { PF_FLY, PF_NOCLIP, PF_TELEPORT, PS_BOX, PS_BSP } from "./protocol.js";
import { host_netaccum, host_netinterval, realtime, sv } from "./host.js";
import { CL_MoveAngles, CL_QuantizeAngle } from "./cl_input.js";

// CVars
export const cl_nopred = new cvar_t("cl_nopred", "0");
export const cl_pushlatency = new cvar_t("pushlatency", "-999");
export const cl_solid_players = new cvar_t("cl_solid_players", "1");
export const cl_predict_players = new cvar_t("cl_predict_players", "1");
// 1 = predict with pmove's NetQuake-physics mode, which mirrors what the
// server runs (sv_user.js / sv_phys.js). 0 = original QuakeWorld pmove.
export const cl_nqpmove = new cvar_t("cl_nqpmove", "1");

// Player flags from QuakeWorld protocol
export const PF_DEAD = 1 << 9; // Don't block movement any more
export const PF_GIB = 1 << 10; // Offset the view height differently

// Predicted player structure (for other players)
class predicted_player_t {
  constructor() {
    this.active = false;
    this.origin = new Float32Array(3); // Predicted origin (output, for rendering)
    this.velocity = new Float32Array(3); // Last known velocity
    // Server state from svc_playerinfo. Prediction always starts from
    // here (QW keeps it in frame->playerstate), never from .origin.
    this.state_origin = new Float32Array(3);
    this.state_velocity = new Float32Array(3);
    this.angles = new Float32Array(3);
    this.modelindex = 0;
    this.msgtime = 0; // Last update time
    this.frame = 0;
    this.flags = 0; // PF_DEAD, PF_GIB, etc.
    this.skin = 0;
    this.effects = 0;
    this.weaponframe = 0;
    this.alpha = 0; // ENTALPHA_* byte, PF_ALPHA (0 is ENTALPHA_DEFAULT)
    this.msec = 0; // Time since last server frame
    this.serverSequence = 0; // Last svc_serversequence this player was updated in
    // Movement command for physics prediction
    this.cmd = {
      msec: 0,
      angles: new Float32Array(3),
      forwardmove: 0,
      sidemove: 0,
      upmove: 0,
      buttons: 0,
      impulse: 0,
    };
  }
}

// Array of predicted players (indices 1-maxclients are players)
const MAX_CLIENTS = 16;
const predicted_players = [];
for (let i = 0; i < MAX_CLIENTS; i++) {
  predicted_players.push(new predicted_player_t());
}

// Command buffer for prediction
const UPDATE_BACKUP = 64; // Must be power of 2
const UPDATE_MASK = UPDATE_BACKUP - 1;

// Player state for prediction
export class player_state_t {
  constructor() {
    this.origin = new Float32Array(3);
    this.velocity = new Float32Array(3);
    this.viewangles = new Float32Array(3);
    this.onground = false;
    this.oldbuttons = 0;
    this.waterjumptime = 0;
    this.weaponframe = 0;
    // NetQuake-physics edict state (see pmove.js PM_NQ_PlayerMove)
    this.waterlevel = -1; // -1 = unknown, recomputed from origin
    this.watertype = CONTENTS_EMPTY;
    this.roll = 0;
    this.movedir = new Float32Array(3);
    this.teleporttime = 0; // seconds of ent->v.teleport_time left
    this.punchangle = new Float32Array(3);
  }

  copyFrom(other) {
    VectorCopy(other.origin, this.origin);
    VectorCopy(other.velocity, this.velocity);
    VectorCopy(other.viewangles, this.viewangles);
    this.onground = other.onground;
    this.oldbuttons = other.oldbuttons;
    this.waterjumptime = other.waterjumptime;
    this.weaponframe = other.weaponframe;
    this.waterlevel = other.waterlevel;
    this.watertype = other.watertype;
    this.roll = other.roll;
    VectorCopy(other.movedir, this.movedir);
    this.teleporttime = other.teleporttime;
    VectorCopy(other.punchangle, this.punchangle);
  }

  clear() {
    this.origin.fill(0);
    this.velocity.fill(0);
    this.viewangles.fill(0);
    this.onground = false;
    this.oldbuttons = 0;
    this.waterjumptime = 0;
    this.weaponframe = 0;
    this.waterlevel = -1;
    this.watertype = CONTENTS_EMPTY;
    this.roll = 0;
    this.movedir.fill(0);
    this.teleporttime = 0;
    this.punchangle.fill(0);
  }
}

// Frame structure - stores command and resulting state for prediction
export class frame_t {
  constructor() {
    this.cmd = {
      msec: 0,
      angles: new Float32Array(3),
      forwardmove: 0,
      sidemove: 0,
      upmove: 0,
      buttons: 0,
    };
    this.sequence = -1; // Absolute client command sequence stored in this slot
    this.netsequence = -1; // Transport-level packet sequence used to send this command
    this.senttime = 0; // Time command was sent
    this.receivedtime = -1; // time the ack for this command arrived, or -1 (QW frame_t)
    this.playerstate = new player_state_t();
  }
}

// Entity frame structure - stores packet entity snapshots from server
// Separate from prediction frames because they use different sequence namespaces
class entity_frame_t {
  constructor() {
    this.packet_entities = new packet_entities_t();
    this.invalid = false; // set if parse error
    this.server_sequence = 0; // server's outgoing sequence for this frame
  }
}

// Prediction frame buffer (indexed by client outgoing_sequence)
const frames = [];
for (let i = 0; i < UPDATE_BACKUP; i++) {
  frames.push(new frame_t());
}

// Entity frame buffer (indexed by server_sequence)
const entity_frames = [];
for (let i = 0; i < UPDATE_BACKUP; i++) {
  entity_frames.push(new entity_frame_t());
}

// Sequence tracking
let outgoing_sequence = 0; // Next command to send
let incoming_sequence = 0; // Last acknowledged command from server
let validsequence = 0; // Last valid packet-entity server sequence (0 = no valid data yet)
let server_sequence = 0; // Latest server frame sequence received (from svc_serversequence)
let has_server_state = false; // Have authoritative local player state for prediction baseline

// Predicted position (used for rendering)
export const cl_simorg = new Float32Array(3); // Simulated/predicted origin
export const cl_simvel = new Float32Array(3); // Simulated/predicted velocity
export const cl_simangles = new Float32Array(3); // Simulated angles
export let cl_simonground = -1; // Predicted onground state: -1 = in air, >= 0 = on ground
export function set_cl_simonground(v) {
  cl_simonground = v;
}
export let cl_prediction_active = false; // true once CL_PredictMove has produced valid output

// Estimated latency for timing
let cls_latency = 0;

// HUD ping readout (Sbar_DrawPing): the last CL_CalcPing result, in ms or
// -1, and when it was taken. QW's scoreboard asks for new ping times every
// two seconds (QW/client/sbar.c Sbar_DeathmatchOverlay, cl.last_ping_request).
let cl_displayping = -1;
let cl_last_ping_request = 0;

// Prediction target time, in the realtime / senttime clock. QW stores this
// in cl.time, but here cl.time stays in server time for CL_LerpPoint,
// dlights and the rest of the NQ client (PRED-1).
let cl_predtime = 0;

/*
=================
CL_SetLatency

Called when we receive server updates to estimate latency
=================
*/
export function CL_SetLatency(latency) {
  cls_latency = latency;
}

/*
=================
CL_GetLatency

Returns the current estimated latency in seconds
=================
*/
export function CL_GetLatency() {
  return cls_latency;
}

/*
=================
CL_GetOutgoingSequence / CL_GetIncomingSequence
=================
*/
export function CL_GetOutgoingSequence() {
  return outgoing_sequence;
}
export function CL_GetIncomingSequence() {
  return incoming_sequence;
}

/*
=================
CL_SetValidSequence

Called when we receive valid entity/player data from server.
Set to 0 to invalidate (e.g., on error or disconnect).
=================
*/
export function CL_SetValidSequence(seq) {
  validsequence = seq;
}

/*
=================
CL_GetValidSequence

Returns the current validsequence value.
=================
*/
export function CL_GetValidSequence() {
  return validsequence;
}

/*
=================
CL_GetFrame

Access the prediction frame buffer (indexed by client outgoing_sequence).
=================
*/
export function CL_GetFrame(seq) {
  return frames[seq & UPDATE_MASK];
}

/*
=================
CL_GetEntityFrame

Access the entity frame buffer (indexed by server_sequence).
Separate from prediction frames to avoid namespace conflicts.
=================
*/
export function CL_GetEntityFrame(seq) {
  return entity_frames[seq & UPDATE_MASK];
}

/*
=================
CL_GetServerSequence / CL_SetServerSequence

Server frame sequence tracking for delta compression.
=================
*/
export function CL_GetServerSequence() {
  return server_sequence;
}
export function CL_SetServerSequence(seq) {
  server_sequence = seq;
}

/*
=================
CL_AcknowledgeCommand

Called when server acknowledges a command
=================
*/
export function CL_AcknowledgeCommand(sequence) {
  const newestSent = outgoing_sequence - 1;
  if (newestSent < 0) {
    return;
  }

  if (sequence > newestSent) {
    sequence = newestSent;
  }

  if (sequence <= incoming_sequence) {
    return;
  }

  const frame = frames[sequence & UPDATE_MASK];
  if (frame.sequence !== sequence) {
    return;
  }

  incoming_sequence = sequence;

  if (frame.senttime > 0) {
    const observedRTT = realtime - frame.senttime;
    if (observedRTT >= 0 && observedRTT < 2.0) {
      if (cls_latency <= 0) {
        cls_latency = observedRTT;
      } else {
        cls_latency = cls_latency * 0.75 + observedRTT * 0.25;
      }
    }
  }
}

/*
=================
CL_CalcPing

QW/server/sv_main.c SV_CalcPing, measured on the client: the average round
trip, in ms, of the commands in the frame window that the server
acknowledged (receivedtime - senttime, as QW's CL_ParseClientdata computes
latency). Our server only acks inside its sys_ticrate tick, so a sample
includes the wait for that tick (up to one client send interval, since the
ack names the newest command that arrived) and up to a client frame before
the reply is read: input-to-response time, as QW's ping also counts the
client's reply delay.

The HUD can't use the server's NQ sample (SV_ReadClientMove's sv.time minus
the echoed svc_time): on a dedicated server both are tick times, so every
sample is 0 or 50 ms.

Deviation: returns -1, not QW's 9999, when there is no sample, so the caller
can fall back to STAT_PING (loopback and the guessed-ack path have none).
=================
*/
export function CL_CalcPing() {
  let ping = 0;
  let count = 0;
  for (let i = 0; i < UPDATE_BACKUP; i++) {
    const frame = frames[i];
    if (frame.receivedtime === -1) {
      continue;
    }

    // QW's "Odd latency" bounds (CL_ParseClientdata)
    const latency = frame.receivedtime - frame.senttime;
    if (latency < 0 || latency > 1.0) {
      continue;
    }

    ping += latency;
    count++;
  }

  if (count === 0) {
    return -1;
  }

  return Math.round((ping / count) * 1000);
}

/*
=================
CL_GetDisplayPing

The ping the HUD shows, in ms, or -1 if there is no client measurement.
Refreshed from CL_CalcPing every two seconds, as QW's scoreboard refreshes
its ping times (QW/client/sbar.c). Until the first sample it keeps trying
every call.
=================
*/
export function CL_GetDisplayPing(now) {
  if (cl_displayping === -1 || now - cl_last_ping_request > 2) {
    cl_last_ping_request = now;
    cl_displayping = CL_CalcPing();
  }

  return cl_displayping;
}

function _CL_SequenceGTE(sequence, baseline) {
  return ((sequence - baseline) | 0) >= 0;
}

/*
=================
CL_AcknowledgeTransportSequence

Map a transport-level packet ack to the newest predicted command sent
in a packet with sequence <= transport ack. `now` is the ack's arrival
time (realtime; tests pass their own clock).
=================
*/
export function CL_AcknowledgeTransportSequence(
  transportAckSequence,
  now = realtime,
) {
  const newestSent = outgoing_sequence - 1;
  if (newestSent < 0) {
    return;
  }

  const searchEnd = Math.max(
    incoming_sequence + 1,
    outgoing_sequence - UPDATE_BACKUP + 1,
  );
  for (let seq = newestSent; seq >= searchEnd; seq--) {
    const frame = frames[seq & UPDATE_MASK];
    if (frame.sequence !== seq || frame.netsequence < 0) {
      continue;
    }

    if (_CL_SequenceGTE(transportAckSequence, frame.netsequence)) {
      CL_AcknowledgeCommand(seq);

      // QW/client/cl_parse.c CL_ParseClientdata: frame->receivedtime =
      // realtime for the acknowledged command. Only the first ack is
      // stamped: unlike QW's server, which replies once per client
      // packet, ours sends every tick, so later datagrams can ack it again.
      if (incoming_sequence === seq && frame.receivedtime === -1) {
        frame.receivedtime = now;
      }

      return;
    }
  }
}

/*
=================
CL_FindAcknowledgedSequence

Find which command sequence corresponds to the server update.
When we receive a server update at `currentTime`, we acknowledge commands
that were sent more than RTT ago.
Returns the sequence number, or -1 if not found.
=================
*/
export function CL_FindAcknowledgedSequence(currentTime) {
  // Conservative ack estimate:
  // 1) only consider commands old enough to have likely completed a round trip
  // 2) never regress
  // 3) never jump past the newest command we have sent
  const newestSent = outgoing_sequence - 1;
  if (newestSent <= incoming_sequence) {
    return -1;
  }

  // Require a minimum age before assuming the server has processed a command.
  // Without this guard, high send rates can incorrectly "ack" the newest command
  // every frame, collapsing prediction.
  let minAckAge = cls_latency > 0 ? cls_latency : 0.1;
  if (minAckAge < 0.02) minAckAge = 0.02;
  if (minAckAge > 1.0) minAckAge = 1.0;
  const ackCutoffTime = currentTime - minAckAge;

  let bestSeq = -1;
  const searchStart = newestSent;
  const searchEnd = Math.max(
    incoming_sequence + 1,
    outgoing_sequence - UPDATE_BACKUP + 1,
  );
  for (let seq = searchStart; seq >= searchEnd; seq--) {
    const frame = frames[seq & UPDATE_MASK];
    if (
      frame.sequence === seq && frame.senttime > 0 &&
      frame.senttime <= ackCutoffTime
    ) {
      bestSeq = seq;
      break;
    }
  }

  // Startup fallback: if latency estimate is still settling, advance by at most one
  // command that has at least been sent before now.
  if (bestSeq < 0) {
    const nextSeq = incoming_sequence + 1;
    if (nextSeq <= newestSent) {
      const nextFrame = frames[nextSeq & UPDATE_MASK];
      if (
        nextFrame.sequence === nextSeq && nextFrame.senttime > 0 &&
        nextFrame.senttime <= currentTime
      ) {
        bestSeq = nextSeq;
      }
    }
  }

  if (bestSeq <= incoming_sequence) {
    return -1;
  }

  const ackFrame = frames[bestSeq & UPDATE_MASK];
  if (ackFrame.sequence === bestSeq && ackFrame.senttime > 0) {
    const observedRTT = currentTime - ackFrame.senttime;
    if (observedRTT >= 0 && observedRTT < 2.0) {
      // Exponential moving average
      if (cls_latency <= 0) {
        cls_latency = observedRTT;
      } else {
        cls_latency = cls_latency * 0.75 + observedRTT * 0.25;
      }
    }
  }

  return bestSeq;
}

/*
=================
CL_StoreCommand

Store a command for prediction replay
=================
*/
export function CL_StoreCommand(cmd, senttime, netsequence = -1) {
  const sequence = outgoing_sequence;
  const framenum = outgoing_sequence & UPDATE_MASK;
  const frame = frames[framenum];

  // Copy command
  frame.cmd.msec = cmd.msec;
  VectorCopy(cmd.angles, frame.cmd.angles);
  frame.cmd.forwardmove = cmd.forwardmove;
  frame.cmd.sidemove = cmd.sidemove;
  frame.cmd.upmove = cmd.upmove;
  frame.cmd.buttons = cmd.buttons;
  frame.sequence = sequence;
  frame.netsequence = netsequence;
  frame.senttime = senttime;
  frame.receivedtime = -1; // we haven't gotten a reply yet (QW CL_SendCmd)

  outgoing_sequence++;

  return sequence;
}

// Movetype for the local prediction run: the view player's movetype from its
// last playerinfo (PF_NOCLIP / PF_FLY)
let _cl_predmovetype = PM_MOVETYPE_WALK;
// The view player's movetype from its last playerinfo (PF_NOCLIP / PF_FLY)
let _cl_servermovetype = PM_MOVETYPE_WALK;
// Seconds of the view player's teleport_time left, from its last playerinfo
let _cl_serverteleport = 0;

// Temporary player state for other-player prediction
const _predFrom = new player_state_t();
const _predTo = new player_state_t();

// Cached buffers for CL_PredictUsercmd split-command path (Golden Rule #4)
const _splitTemp = [new player_state_t(), new player_state_t()];

/*
=================
CL_SetUpPlayerPrediction

Calculate predicted positions for all other players.
Uses full physics prediction (CL_PredictUsercmd) when movement commands
are available from svc_playerinfo, otherwise the server position.
Ported from QuakeWorld cl_ents.c

Every call starts from the server state (state_origin / state_velocity),
so calling this more than once per frame doesn't compound the
extrapolation. Other players are traced against the world and brush
entities only, as in QW, where CL_PredictMove has restored numphysent
before CL_SetUpPlayerPrediction(true) runs. The physents are built here,
so the result does not depend on whatever the last CL_PredictMove left in
pmove (it also includes the player being predicted), and it also works on
a listen server, where CL_PredictMove never runs.
=================
*/
export function CL_SetUpPlayerPrediction(dopred) {
  // Calculate player time - slightly ahead to compensate for latency
  let playertime = realtime - cls_latency + 0.02;
  if (playertime > realtime) {
    playertime = realtime;
  }

  let physentsReady = false;
  const nq = cl_nqpmove.value !== 0;

  // Process all potential player slots
  // Ported from QW cl_ents.c - reads from predicted_players[] data
  // (populated by CL_SetPlayerInfo from svc_playerinfo messages)
  for (let j = 0; j < MAX_CLIENTS; j++) {
    const pplayer = predicted_players[j];

    // QuakeWorld behavior: only consider players updated in the current
    // server frame. This avoids stale players lingering as active.
    if (pplayer.serverSequence !== server_sequence) {
      pplayer.active = false;
      continue;
    }

    // Skip if no model
    if (pplayer.modelindex <= 0) {
      pplayer.active = false;
      continue;
    }

    pplayer.active = true;

    // For the local player, use our predicted position
    if (j + 1 === cl.viewentity) {
      if (cl_prediction_active) {
        VectorCopy(cl_simorg, pplayer.origin);
        VectorCopy(cl_simvel, pplayer.velocity);
      } else {
        VectorCopy(pplayer.state_origin, pplayer.origin);
        VectorCopy(pplayer.state_velocity, pplayer.velocity);
      }
      continue;
    }

    VectorCopy(pplayer.state_origin, pplayer.origin);
    VectorCopy(pplayer.state_velocity, pplayer.velocity);

    // Only predict half the move to minimize overruns (QW: msec = 500 * dt)
    let msec = (500 * (playertime - pplayer.msgtime)) | 0;

    if (msec <= 0 || cl_predict_players.value === 0 || dopred === false) {
      continue; // No prediction - keep svc_playerinfo origin as-is
    }

    // Dead players get no user control on the NQ server
    // (SV_ClientThink) and the QC tosses the body; keep them where
    // the server put them.
    if ((pplayer.flags & PF_DEAD) !== 0) {
      continue;
    }

    if (msec > 255) {
      msec = 255;
    }

    if (physentsReady === false) {
      CL_SetPhysentsWorld();
      physentsReady = true;
    }

    // Build player state from svc_playerinfo data
    _predFrom.clear();
    VectorCopy(pplayer.state_origin, _predFrom.origin);
    VectorCopy(pplayer.state_velocity, _predFrom.velocity);
    VectorCopy(pplayer.cmd.angles, _predFrom.viewangles);
    _predFrom.weaponframe = pplayer.weaponframe;
    // FL_ONGROUND is not sent for other players; estimate it
    if (nq) {
      _predFrom.onground = PM_NQ_CheckGround(
        _predFrom.origin,
        _predFrom.velocity,
      );
    }

    // Set the prediction time on the command
    pplayer.cmd.msec = msec;

    // Run full physics prediction
    CL_PredictUsercmd(_predFrom, _predTo, pplayer.cmd, false, false);

    // Use the predicted result
    VectorCopy(_predTo.origin, pplayer.origin);
  }
}

/*
=================
CL_SetPhysentsWorld

physents[0] = world, then the solid brush entities. QW does this in
CL_SetSolidEntities, called once per parsed packet; the port rebuilds it
for each user so stale player boxes are never left behind.
=================
*/
function CL_SetPhysentsWorld() {
  pmove.numphysent = 0;

  if (cl.worldmodel != null) {
    pmove.physents[0].model = cl.worldmodel;
    pmove.physents[0].origin.fill(0);
    pmove.physents[0].info = 0;
    pmove.numphysent = 1;
  }

  // Add brush entities (doors, platforms) as collision objects
  CL_SetSolidEntities();
}

/*
=================
CL_SetSolidEntities

Add solid entities (doors, platforms, lifts, monsters) as collision
objects for prediction.
Ported from QuakeWorld cl_ents.c

QW guesses from the model (hull 1 has a non-zero headnode) because its
server never sets U_SOLID. Here the server sends each entity's solidity
with PE_SOLID (sv_main.js SV_SetStateSolid): PS_BSP for SOLID_BSP brush
entities, which collide with the model's hulls as in QW, and PS_BOX with
the entity's v.mins/v.maxs for SOLID_BBOX and SOLID_SLIDEBOX (monsters,
exploding boxes). Corpses are SOLID_NOT, so they are not sent as solid.

Brush entities go in first, so a crowd of monsters can't push a door or
lift out of a full physents list.
=================
*/
function CL_SetSolidEntities() {
  if (validsequence === 0) {
    return;
  }

  const eframe = entity_frames[validsequence & UPDATE_MASK];
  if (eframe.invalid) {
    return;
  }

  const pak = eframe.packet_entities;

  // Build solid physents from the current packet-entity snapshot.
  // This mirrors QuakeWorld's CL_SetSolidEntities, which uses the
  // authoritative frame data rather than potentially stale cl_entities.
  for (let i = 0; i < pak.num_entities; i++) {
    const state = pak.entities[i];
    if ((state.solid & PS_BSP) === 0 || state.modelindex === 0) {
      continue;
    }

    const model = cl.model_precache[state.modelindex];
    if (model == null || model.hulls == null) {
      continue;
    }

    const hull = model.hulls[1];
    if (hull == null) {
      continue;
    }

    if (!hull.firstclipnode && !model.clipbox) {
      continue;
    }

    if (pmove.numphysent >= pmove.physents.length) {
      return;
    }

    const pent = pmove.physents[pmove.numphysent];
    pent.model = model;
    VectorCopy(state.origin, pent.origin);
    pent.info = state.number;
    pmove.numphysent++;
  }

  for (let i = 0; i < pak.num_entities; i++) {
    const state = pak.entities[i];
    if ((state.solid & PS_BOX) === 0) {
      continue;
    }

    if (pmove.numphysent >= pmove.physents.length) {
      return;
    }

    const pent = pmove.physents[pmove.numphysent];
    pent.model = null; // SOLID_BBOX / SOLID_SLIDEBOX: box collision
    VectorCopy(state.origin, pent.origin);
    VectorCopy(state.mins, pent.mins);
    VectorCopy(state.maxs, pent.maxs);
    pent.info = state.number;
    pmove.numphysent++;
  }
}

/*
=================
CL_SetupPMove

Set up pmove state for prediction of the local player: world, brush
entities, then other players at their server positions.
=================
*/
function CL_SetupPMove() {
  CL_SetPhysentsWorld();
}

/*
=================
CL_SetSolidPlayers

Add other players as collision entities for prediction.
Ported from QuakeWorld cl_ents.c. QW uses the positions from
CL_SetUpPlayerPrediction(false), i.e. the server positions.
=================
*/
function CL_SetSolidPlayers(playernum) {
  if (cl_solid_players.value === 0) {
    return;
  }

  for (let j = 0; j < MAX_CLIENTS; j++) {
    // Don't overflow the physents array
    if (pmove.numphysent >= pmove.physents.length) {
      break;
    }

    const pplayer = predicted_players[j];

    // not present this frame
    if (pplayer.serverSequence !== server_sequence || pplayer.modelindex <= 0) {
      continue;
    }

    // Don't add ourselves
    if (j === playernum) {
      continue;
    }

    // Skip dead players - they don't block movement (PF_DEAD flag)
    if ((pplayer.flags & PF_DEAD) !== 0) {
      continue;
    }

    // Add as a solid physics entity using the server position
    const pent = pmove.physents[pmove.numphysent];
    pent.model = null; // Use box collision, not BSP
    VectorCopy(pplayer.state_origin, pent.origin);
    VectorCopy(player_mins, pent.mins);
    VectorCopy(player_maxs, pent.maxs);
    pent.info = j; // Store player number

    pmove.numphysent++;
  }
}

/*
=================
CL_GetPredictedPlayer

Get the predicted position for a player (for rendering).
Returns null if player is not active.
=================
*/
export function CL_GetPredictedPlayer(playernum) {
  if (playernum < 0 || playernum >= MAX_CLIENTS) {
    return null;
  }

  const pplayer = predicted_players[playernum];
  if (!pplayer.active) {
    return null;
  }

  return pplayer;
}

/*
=================
CL_SetPlayerInfo

Called from CL_ParsePlayerInfo to set player state from server.
This stores the QuakeWorld-style player info for prediction.
=================
*/
export function CL_SetPlayerInfo(
  playernum,
  origin,
  velocity,
  frame,
  flags,
  skin,
  effects,
  weaponframe,
  msec,
  cmd,
  modelindex,
  teleport,
  alpha = 0,
) {
  if (playernum < 0 || playernum >= MAX_CLIENTS) {
    return;
  }

  const pplayer = predicted_players[playernum];
  pplayer.active = true;
  pplayer.msgtime = realtime - msec * 0.001;
  pplayer.serverSequence = server_sequence;

  if (playernum + 1 === cl.viewentity) {
    _cl_servermovetype = (flags & PF_NOCLIP) !== 0 ?
      PM_MOVETYPE_NOCLIP :
      (flags & PF_FLY) !== 0 ?
      PM_MOVETYPE_FLY :
      PM_MOVETYPE_WALK;
    _cl_serverteleport = (flags & PF_TELEPORT) !== 0 ?
      (teleport || 0) * 0.01 :
      0;
  }

  VectorCopy(origin, pplayer.state_origin);
  VectorCopy(velocity, pplayer.state_velocity);
  VectorCopy(origin, pplayer.origin);
  VectorCopy(velocity, pplayer.velocity);
  pplayer.frame = frame;
  pplayer.flags = flags;
  pplayer.skin = skin;
  pplayer.effects = effects;
  pplayer.weaponframe = weaponframe;
  pplayer.alpha = alpha;
  pplayer.msec = msec;
  if (modelindex != null) {
    pplayer.modelindex = modelindex;
  }

  // Copy movement command if provided
  if (cmd != null) {
    pplayer.cmd.msec = cmd.msec;
    VectorCopy(cmd.angles, pplayer.cmd.angles);
    pplayer.cmd.forwardmove = cmd.forwardmove;
    pplayer.cmd.sidemove = cmd.sidemove;
    pplayer.cmd.upmove = cmd.upmove;
    pplayer.cmd.buttons = cmd.buttons;
    pplayer.cmd.impulse = cmd.impulse;
  }

  // If this is the local player, bridge QW-style svc_playerinfo data
  // into the NQ-style entity system. Players are excluded from
  // svc_packetentities, so cl_entities[viewentity] is never updated
  // by entity updates. Without this, the NQ camera (V_CalcRefdef)
  // reads stale [0,0,0] from the entity.
  if (playernum + 1 === cl.viewentity) {
    const ent = cl_entities[cl.viewentity];

    // Update entity origin directly — V_CalcRefdef reads ent.origin
    // for the camera position in single player (sv.active).
    // CL_RelinkEntities may skip this entity (null model), so we
    // can't rely on it to interpolate msg_origins into ent.origin.
    VectorCopy(origin, ent.origin);

    // Also update msg_origins for interpolation if CL_RelinkEntities
    // does process the entity (e.g., after model is set)
    VectorCopy(ent.msg_origins[0], ent.msg_origins[1]);
    VectorCopy(origin, ent.msg_origins[0]);

    // Update msgtime so CL_RelinkEntities doesn't cull the entity
    ent.msgtime = cl.mtime[0];

    // Update prediction frame for CL_PredictMove (multiplayer path)
    CL_SetServerState(origin, velocity, cl.onground);
  }
}

/*
==============
CL_PredictUsercmd

Predict the result of a single user command

QW splits moves over 50 ms by recursing on halves (integer msec, so 255 ms
runs as 8 x 31 ms). The port's recursion shared one split command and
one temp state across levels, so deeper levels overwrote the outer
level's msec. This runs the same steps iteratively with two scratch
states. NetQuake mode splits only above 100 ms, the server's longest
frame (Host_FilterTime clamps host_frametime to 0.1), and keeps
fractional msec.

dead defaults to the local player's health, as in QW.
==============
*/
export function CL_PredictUsercmd(from, to, cmd, spectator, dead) {
  if (dead === undefined) {
    dead = cl.stats[STAT_HEALTH] <= 0;
  }

  const nq = cl_nqpmove.value !== 0 && spectator !== true;
  const limit = nq ? 100 : 50;

  let msec = cmd.msec;
  let steps = 1;
  while (msec > limit) {
    msec = nq ? msec / 2 : Math.floor(msec / 2);
    steps *= 2;
  }

  let src = from;
  for (let i = 0; i < steps; i++) {
    const dst = (i === steps - 1) ? to : _splitTemp[i & 1];
    CL_PredictUsercmdStep(src, dst, cmd, msec, spectator, dead, nq);
    src = dst;
  }
}

function CL_PredictUsercmdStep(from, to, cmd, msec, spectator, dead, nq) {
  VectorCopy(from.origin, pmove.origin);
  VectorCopy(cmd.angles, pmove.angles);
  VectorCopy(from.velocity, pmove.velocity);

  pmove.oldbuttons = from.oldbuttons;
  pmove.waterjumptime = from.waterjumptime;
  pmove.dead = dead;
  pmove.spectator = spectator;

  pmove.nqphysics = nq;
  pmove.movetype = _cl_predmovetype;
  pmove.onground = from.onground;
  pmove.waterlevel = from.waterlevel;
  pmove.watertype = from.watertype;
  pmove.roll = from.roll;
  VectorCopy(from.movedir, pmove.movedir);
  pmove.teleporttime = from.teleporttime;
  VectorCopy(from.punchangle, pmove.punchangle);

  pmove.cmd.msec = msec;
  VectorCopy(cmd.angles, pmove.cmd.angles);
  pmove.cmd.forwardmove = cmd.forwardmove;
  pmove.cmd.sidemove = cmd.sidemove;
  pmove.cmd.upmove = cmd.upmove;
  pmove.cmd.buttons = cmd.buttons;

  PlayerMove();

  to.waterjumptime = pmove.waterjumptime;
  VectorCopy(pmove.origin, to.origin);
  VectorCopy(pmove.angles, to.viewangles);
  VectorCopy(pmove.velocity, to.velocity);
  to.weaponframe = from.weaponframe;

  if (nq) {
    // FL_JUMPRELEASED is only re-set when the button is up, so keep
    // pmove's flag rather than QW's "last buttons"
    to.oldbuttons = pmove.oldbuttons;
    to.onground = pmove.onground;
    to.waterlevel = pmove.waterlevel;
    to.watertype = pmove.watertype;
    to.roll = pmove.roll;
    VectorCopy(pmove.movedir, to.movedir);
    to.teleporttime = pmove.teleporttime;
    VectorCopy(pmove.punchangle, to.punchangle);
  } else {
    to.oldbuttons = pmove.cmd.buttons;
    to.onground = PM_GetOnGround() !== -1; // Use proper onground from pmove
    to.waterlevel = -1; // QW levels mean something else; recompute if switched
    to.watertype = PM_GetWaterType();
    to.roll = 0;
    VectorCopy(from.movedir, to.movedir);
    to.teleporttime = from.teleporttime;
    VectorCopy(from.punchangle, to.punchangle);
  }
}

/*
==============
CL_Movevars_f

Console command handler for _movevars. The server sends this via svc_stufftext
during signon to sync physics parameters for client-side prediction.
Matches original QuakeWorld's movevars protocol (QW/server/sv_user.c:98-108).

Optional extra arguments 11, 12 and 13 carry the NetQuake edgefriction,
sv_maxvelocity and sv_altnoclip cvars for the NetQuake-physics mode;
servers that don't send them leave the WinQuake defaults.
==============
*/
function CL_Movevars_f() {
  if (Cmd_Argc() < 11) {
    return;
  }

  movevars.gravity = Q_atof(Cmd_Argv(1));
  movevars.stopspeed = Q_atof(Cmd_Argv(2));
  movevars.maxspeed = Q_atof(Cmd_Argv(3));
  movevars.spectatormaxspeed = Q_atof(Cmd_Argv(4));
  movevars.accelerate = Q_atof(Cmd_Argv(5));
  movevars.airaccelerate = Q_atof(Cmd_Argv(6));
  movevars.wateraccelerate = Q_atof(Cmd_Argv(7));
  movevars.friction = Q_atof(Cmd_Argv(8));
  movevars.waterfriction = Q_atof(Cmd_Argv(9));
  movevars.entgravity = Q_atof(Cmd_Argv(10));
  if (Cmd_Argc() >= 12) {
    movevars.edgefriction = Q_atof(Cmd_Argv(11));
  }
  if (Cmd_Argc() >= 13) {
    movevars.maxvelocity = Q_atof(Cmd_Argv(12));
  }
  if (Cmd_Argc() >= 14) {
    movevars.altnoclip = Q_atof(Cmd_Argv(13));
  }
}

// Renderer/network isolation: the partial command CL_PredictMove runs
// between ticks, and the state it predicts
const _partialcmd = {
  msec: 0,
  angles: new Float32Array(3),
  forwardmove: 0,
  sidemove: 0,
  upmove: 0,
  buttons: 0,
};
const _partialstate = new player_state_t();

/*
==============
CL_PredictPartialMove

Renderer/network isolation (host.js): render frames run between the 72 Hz
commands, and without this the view would stay on the last command's
state until the next one. Not in QW, which sends a command every frame.

Predicts from the newest command's state (last) for the game time that
hasn't been sent yet (host_netaccum), with the newest command's moves and
buttons and the angles the next command will send. The next command
covers that same time, so the view runs on into it rather than snapping.
With no time to predict, the state is the newest command's.
==============
*/
function CL_PredictPartialMove(last) {
  const msec = host_netaccum * 1000;
  if (msec <= 0) {
    _partialstate.copyFrom(last.playerstate);
    return;
  }

  const cmd = _partialcmd;
  cmd.msec = msec < 255 ? msec : 255;
  const angles = CL_MoveAngles();
  for (let i = 0; i < 3; i++) {
    cmd.angles[i] = CL_QuantizeAngle(angles[i]);
  }
  cmd.forwardmove = last.cmd.forwardmove;
  cmd.sidemove = last.cmd.sidemove;
  cmd.upmove = last.cmd.upmove;
  cmd.buttons = last.cmd.buttons;

  CL_PredictUsercmd(last.playerstate, _partialstate, cmd, false);
}

/*
==============
CL_PredictMove

Main prediction function - called each frame to predict local player position
==============
*/
export function CL_PredictMove() {
  if (cl_pushlatency.value > 0) {
    cl_pushlatency.value = 0;
  }

  if (cl.paused) {
    return;
  }

  // Calculate the time we want to be at. QW writes this to cl.time; the
  // port keeps it separate so cl.time stays in server time (PRED-1).
  cl_predtime = realtime - cls_latency - cl_pushlatency.value * 0.001;
  if (cl_predtime > realtime) {
    cl_predtime = realtime;
  }

  if (cl.intermission !== 0) {
    return;
  }

  // Check if we have authoritative local-player state to predict from
  if (has_server_state === false) {
    return;
  }

  // Check if we have valid frames to predict from
  if (outgoing_sequence - incoming_sequence >= UPDATE_BACKUP - 1) {
    return;
  }

  VectorCopy(cl.viewangles, cl_simangles);

  // Get the last acknowledged frame from server
  const from = frames[incoming_sequence & UPDATE_MASK];

  const nq = cl_nqpmove.value !== 0;

  // If prediction is disabled, just use server position. A dead player
  // gets no user control on the NQ server (SV_ClientThink returns early)
  // and the QC tosses the body, so use the server position then too.
  if (
    cl_nopred.value !== 0 || sv.active || (nq && cl.stats[STAT_HEALTH] <= 0)
  ) {
    VectorCopy(from.playerstate.velocity, cl_simvel);
    VectorCopy(from.playerstate.origin, cl_simorg);
    cl_simonground = from.playerstate.onground ? 0 : -1;
    cl_prediction_active = true;
    return;
  }

  // Set up pmove for collision: world and brush entities, then the
  // other players, which are dropped again afterwards (QW oldphysent)
  CL_SetupPMove();
  const oldphysent = pmove.numphysent;
  CL_SetSolidPlayers(cl.viewentity - 1);

  // The server sends the view player's movetype with its playerinfo
  _cl_predmovetype = _cl_servermovetype;

  // Predict forward from acknowledged state
  let to = null;
  let lastFrom = from;
  let i;

  for (
    i = 1;
    i < UPDATE_BACKUP - 1 && incoming_sequence + i < outgoing_sequence;
    i++
  ) {
    to = frames[(incoming_sequence + i) & UPDATE_MASK];
    CL_PredictUsercmd(lastFrom.playerstate, to.playerstate, to.cmd, false);

    if (to.senttime >= cl_predtime) {
      break;
    }

    lastFrom = to;
  }

  // Between isolated ticks, run on from the newest command. If the server
  // has acknowledged it already (no command to predict), from the
  // acknowledged state, whose command is the newest.
  let partial = false;
  if (host_netinterval > 0 && i !== UPDATE_BACKUP - 1) {
    const last = to !== null ? to : from;
    // sequence is -1 in a slot no command has used (after a reset)
    if (last.sequence >= 0 && last.sequence === outgoing_sequence - 1) {
      CL_PredictPartialMove(last);
      partial = true;
    }
  }

  pmove.numphysent = oldphysent;
  _cl_predmovetype = PM_MOVETYPE_WALK;

  if (partial) {
    VectorCopy(_partialstate.velocity, cl_simvel);
    VectorCopy(_partialstate.origin, cl_simorg);
    cl_simonground = _partialstate.onground ? 0 : -1;
    cl_prediction_active = true;
    return;
  }

  // net hasn't delivered packets in a long time...
  if (i === UPDATE_BACKUP - 1 || to == null) {
    return;
  }

  // Interpolate some fraction of the final frame
  let f;
  if (to.senttime === lastFrom.senttime) {
    f = 0;
  } else {
    f = (cl_predtime - lastFrom.senttime) / (to.senttime - lastFrom.senttime);
    if (f < 0) f = 0;
    if (f > 1) f = 1;
  }

  // Check for teleport (large position change)
  for (let i = 0; i < 3; i++) {
    if (
      Math.abs(lastFrom.playerstate.origin[i] - to.playerstate.origin[i]) > 128
    ) {
      // Teleported, so don't lerp
      VectorCopy(to.playerstate.velocity, cl_simvel);
      VectorCopy(to.playerstate.origin, cl_simorg);
      cl_simonground = to.playerstate.onground ? 0 : -1;
      cl_prediction_active = true;
      return;
    }
  }

  // Interpolate position and velocity
  for (let i = 0; i < 3; i++) {
    cl_simorg[i] = lastFrom.playerstate.origin[i] +
      f * (to.playerstate.origin[i] - lastFrom.playerstate.origin[i]);
    cl_simvel[i] = lastFrom.playerstate.velocity[i] +
      f * (to.playerstate.velocity[i] - lastFrom.playerstate.velocity[i]);
  }

  // Set predicted onground state (use the latest predicted frame)
  cl_simonground = to.playerstate.onground ? 0 : -1;
  cl_prediction_active = true;
}

/*
==============
CL_SetServerState

Called when we receive authoritative state from server
Updates the acknowledged frame's player state
==============
*/
export function CL_SetServerState(origin, velocity, onground) {
  const frame = frames[incoming_sequence & UPDATE_MASK];
  VectorCopy(origin, frame.playerstate.origin);
  VectorCopy(velocity, frame.playerstate.velocity);
  frame.playerstate.onground = onground;
  // waterlevel belongs to the predicted origin, not the server's
  frame.playerstate.waterlevel = -1;
  // the server's teleport_time and punchangle for the acknowledged move
  frame.playerstate.teleporttime = _cl_serverteleport;
  VectorCopy(cl.punchangle, frame.playerstate.punchangle);
  has_server_state = true;
}

/*
==============
CL_InitPrediction
==============
*/
export function CL_InitPrediction() {
  Cvar_RegisterVariable(cl_pushlatency);
  Cvar_RegisterVariable(cl_nopred);
  Cvar_RegisterVariable(cl_solid_players);
  Cvar_RegisterVariable(cl_predict_players);
  Cvar_RegisterVariable(cl_nqpmove);
  Cmd_AddCommand("_movevars", CL_Movevars_f);
  Pmove_Init();
}

/*
==============
CL_ResetPrediction

Called on level change or disconnect
==============
*/
export function CL_ResetPrediction() {
  outgoing_sequence = 0;
  incoming_sequence = 0;
  validsequence = 0;
  server_sequence = 0;
  has_server_state = false;
  cls_latency = 0;
  cl_displayping = -1;
  cl_last_ping_request = 0;
  cl_predtime = 0;
  _cl_predmovetype = PM_MOVETYPE_WALK;
  _cl_servermovetype = PM_MOVETYPE_WALK;
  _cl_serverteleport = 0;

  cl_simorg.fill(0);
  cl_simvel.fill(0);
  cl_simangles.fill(0);
  cl_simonground = -1;
  cl_prediction_active = false;

  for (let i = 0; i < UPDATE_BACKUP; i++) {
    frames[i].sequence = -1;
    frames[i].netsequence = -1;
    frames[i].senttime = 0;
    frames[i].receivedtime = -1;
    frames[i].playerstate.clear(); // incl. waterjumptime, oldbuttons, onground
    entity_frames[i].packet_entities.num_entities = 0;
    entity_frames[i].invalid = false;
    entity_frames[i].server_sequence = 0;
  }

  // Players from the previous map must not match server_sequence 0
  for (let i = 0; i < MAX_CLIENTS; i++) {
    const pplayer = predicted_players[i];
    pplayer.active = false;
    pplayer.serverSequence = -1;
    pplayer.modelindex = 0;
    pplayer.flags = 0;
    pplayer.alpha = 0;
    pplayer.origin.fill(0);
    pplayer.velocity.fill(0);
    pplayer.state_origin.fill(0);
    pplayer.state_velocity.fill(0);
  }
}
