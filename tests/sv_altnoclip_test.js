// sv_altnoclip (johnfitz, FitzQuake/Ironwail sv_user.c): noclip flies where
// v_angle points, with upmove doubled and the speed capped at sv_maxspeed.
// The server sends the cvar to the client as _movevars argument 13 so that
// NetQuake-physics prediction (pmove.js) does the same.

import { sizebuf_t, SZ_Clear } from "../src/common.js";
import { Cmd_ExecuteString, src_command } from "../src/cmd.js";
import { svc_stufftext } from "../src/protocol.js";
import { sv } from "../src/server.js";
import { edict_t } from "../src/progs.js";
import {
  MOVETYPE_NOCLIP,
  sv_maxspeed,
  SV_Physics_Noclip,
  SV_SetCallbacks,
  SV_SetFrametime,
  SV_SetPlayer,
  SV_SetState,
} from "../src/sv_phys.js";
import {
  sv_altnoclip,
  SV_ClientThink,
  SV_User_SetCallbacks,
} from "../src/sv_user.js";
import { SV_CheckMovevars, SV_WriteMovevars } from "../src/sv_main.js";
import {
  movevars,
  PlayerMove,
  PM_MOVETYPE_NOCLIP,
  pmove,
} from "../src/pmove.js";
import { CL_InitPrediction } from "../src/cl_pred.js";

function assert(cond, message) {
  if (!cond) {
    throw new Error(message);
  }
}

function assertNear(actual, expected, epsilon, message) {
  if (
    Number.isFinite(actual) !== true || Math.abs(actual - expected) > epsilon
  ) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

// Server side: SV_ClientThink then SV_Physics_Client's MOVETYPE_NOCLIP case
const svState = { time: 10, edicts: [], num_edicts: 1 };
const hostClient = { cmd: { forwardmove: 0, sidemove: 0, upmove: 0 } };

function setupServer() {
  SV_SetState(svState, {}, { self: 0, other: 0, time: 0 });
  SV_SetCallbacks({
    SV_LinkEdict: () => {},
    EDICT_TO_PROG: () => 0,
  });
  SV_User_SetCallbacks({ V_CalcRoll: () => 0, host_client: hostClient });
}

function makeNoclipPlayer(origin) {
  const ent = new edict_t(1, 106);
  ent.v.origin.set(origin);
  ent.v.mins.set([-16, -16, -24]);
  ent.v.maxs.set([16, 16, 32]);
  ent.v.movetype = MOVETYPE_NOCLIP;
  ent.v.health = 100;
  return ent;
}

// The view angles used below are multiples of 360 / 65536 degrees, so the
// MSG_WriteAngle16 round trip and CL_QuantizeAngle leave them unchanged.
function serverFrame(ent, viewangles, move, dt) {
  SV_SetFrametime(dt);
  SV_SetPlayer(ent);
  ent.v.v_angle.set(viewangles);
  hostClient.cmd.forwardmove = move[0];
  hostClient.cmd.sidemove = move[1];
  hostClient.cmd.upmove = move[2];
  SV_ClientThink();
  SV_Physics_Noclip(ent);
}

// Client side: the same PlayerMove that CL_PredictUsercmd runs, in NetQuake mode
function clientFrame(origin, velocity, viewangles, move, dt) {
  pmove.origin.set(origin);
  pmove.velocity.set(velocity);
  pmove.angles.set(viewangles);
  pmove.nqphysics = true;
  pmove.spectator = false;
  pmove.dead = false;
  pmove.movetype = PM_MOVETYPE_NOCLIP;
  pmove.onground = false;
  pmove.waterlevel = 0;
  pmove.watertype = -1;
  pmove.teleporttime = 0;
  pmove.punchangle.fill(0);
  pmove.cmd.msec = dt * 1000;
  pmove.cmd.angles.set(viewangles);
  pmove.cmd.forwardmove = move[0];
  pmove.cmd.sidemove = move[1];
  pmove.cmd.upmove = move[2];
  pmove.cmd.buttons = 0;
  PlayerMove();
  origin.set(pmove.origin);
  velocity.set(pmove.velocity);
}

function withAltnoclip(value, fn) {
  const oldCvar = sv_altnoclip.value;
  const oldMovevar = movevars.altnoclip;
  try {
    sv_altnoclip.value = value;
    movevars.altnoclip = value;
    setupServer();
    fn();
  } finally {
    sv_altnoclip.value = oldCvar;
    movevars.altnoclip = oldMovevar;
  }
}

// Run the server and the client side by side and require the same origin
// and velocity every frame
function runDifferential(name, viewangles, move) {
  const dt = 1 / 72;
  const ent = makeNoclipPlayer([0, 0, 0]);
  const origin = new Float32Array(3);
  const velocity = new Float32Array(3);

  for (let frame = 0; frame < 20; frame++) {
    serverFrame(ent, viewangles, move, dt);
    clientFrame(origin, velocity, viewangles, move, dt);
    for (let i = 0; i < 3; i++) {
      assertNear(
        origin[i],
        ent.v.origin[i],
        0.01,
        `${name} frame ${frame} origin[${i}]`,
      );
      assertNear(
        velocity[i],
        ent.v.velocity[i],
        0.01,
        `${name} frame ${frame} velocity[${i}]`,
      );
    }
  }

  return ent;
}

Deno.test("sv_altnoclip 1: noclip flies along v_angle, capped at sv_maxspeed", () => {
  withAltnoclip(1, () => {
    // pitch 45 looks down: forward is ( cos 45, 0, -sin 45 ) at yaw 0
    const ent = runDifferential("alt pitch 45", [45, 0, 0], [400, 0, 0]);
    const max = sv_maxspeed.value;
    assertNear(ent.v.velocity[0], max * Math.SQRT1_2, 0.01, "velocity x");
    assertNear(ent.v.velocity[1], 0, 0.01, "velocity y");
    assertNear(ent.v.velocity[2], -max * Math.SQRT1_2, 0.01, "velocity z");
  });
});

Deno.test("sv_altnoclip 1: upmove is doubled and speeds below sv_maxspeed are kept", () => {
  withAltnoclip(1, () => {
    const ent = runDifferential("alt upmove", [0, 90, 0], [0, 0, 100]);
    assertNear(ent.v.velocity[0], 0, 0.01, "velocity x");
    assertNear(ent.v.velocity[1], 0, 0.01, "velocity y");
    assertNear(ent.v.velocity[2], 200, 0.01, "velocity z");
  });
});

Deno.test("sv_altnoclip 0: noclip keeps id's SV_AirMove (pitch ignored, upmove not doubled)", () => {
  withAltnoclip(0, () => {
    const ent = runDifferential("id pitch 45", [45, 0, 0], [200, 0, 100]);
    // SV_AirMove moves on v.angles, whose pitch is -v_angle / 3, and
    // sets wishvel[ 2 ] to upmove for any movetype other than walk
    const pitch = 45 / 3 * Math.PI / 180;
    assertNear(ent.v.velocity[0], 200 * Math.cos(pitch), 0.01, "velocity x");
    assertNear(ent.v.velocity[2], 100, 0.01, "velocity z");
  });
});

function stufftextOf(msg) {
  assert(
    msg.cursize > 0 && msg.data[0] === svc_stufftext,
    "expected a stufftext",
  );
  return new TextDecoder().decode(msg.data.subarray(1, msg.cursize - 1));
}

let initialised = false;
function initPrediction() {
  if (initialised) {
    return;
  }
  initialised = true;
  try {
    CL_InitPrediction();
  } catch (e) {
    // cvar / command registration may already have happened in this isolate
    void e;
  }
}

Deno.test("_movevars carries sv_altnoclip as argument 13 to the client", () => {
  initPrediction();
  const oldCvar = sv_altnoclip.value;
  const oldMovevar = movevars.altnoclip;
  try {
    const msg = new sizebuf_t();
    msg.data = new Uint8Array(256);
    msg.maxsize = 256;

    sv_altnoclip.value = 1;
    movevars.altnoclip = 0;
    SV_WriteMovevars(msg);
    const text = stufftextOf(msg);
    const args = text.trim().split(" ");
    assert(args.length === 14 && args[13] === "1", `got ${text}`);
    Cmd_ExecuteString(text, src_command);
    assert(movevars.altnoclip === 1, `client altnoclip ${movevars.altnoclip}`);

    // a 13-argument _movevars from an older server leaves it alone
    Cmd_ExecuteString(args.slice(0, 13).join(" "), src_command);
    assert(movevars.altnoclip === 1, "short _movevars changed altnoclip");

    SZ_Clear(msg);
    sv_altnoclip.value = 0;
    SV_WriteMovevars(msg);
    Cmd_ExecuteString(stufftextOf(msg), src_command);
    assert(movevars.altnoclip === 0, `client altnoclip ${movevars.altnoclip}`);
  } finally {
    sv_altnoclip.value = oldCvar;
    movevars.altnoclip = oldMovevar;
  }
});

Deno.test("SV_CheckMovevars re-sends on an sv_altnoclip change", () => {
  const msg = sv.reliable_datagram;
  const oldData = msg.data, oldMax = msg.maxsize;
  const oldCvar = sv_altnoclip.value;
  try {
    msg.data = new Uint8Array(1024);
    msg.maxsize = 1024;
    SV_CheckMovevars(); // sync the snapshot
    SZ_Clear(msg);

    sv_altnoclip.value = oldCvar !== 0 ? 0 : 1;
    SV_CheckMovevars();
    const args = stufftextOf(msg).trim().split(" ");
    assert(
      args[0] === "_movevars" && args[13] === String(sv_altnoclip.value),
      `got ${args.join(" ")}`,
    );
  } finally {
    sv_altnoclip.value = oldCvar;
    SV_CheckMovevars(); // leave the snapshot matching the cvars
    SZ_Clear(msg);
    msg.data = oldData;
    msg.maxsize = oldMax;
  }
});
