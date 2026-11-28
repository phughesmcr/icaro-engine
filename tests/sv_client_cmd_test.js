// A client's usercmd_t is a struct inside client_t in C (server.h), zeroed by
// SV_ConnectClient's memset, so SV_ClientThink can always read it. A client
// that spawns before its first clc_move (a browser-hosted room whose host was
// paused while the joiner's signon queued up) used to reach SV_AirMove with
// a null cmd and throw, which stopped the host's frame loop.

import { client_t } from "../src/server.js";
import { edict_t } from "../src/progs.js";
import {
  MOVETYPE_WALK,
  SV_SetCallbacks,
  SV_SetFrametime,
  SV_SetPlayer,
  SV_SetState,
} from "../src/sv_phys.js";
import { SV_ClientThink, SV_User_SetCallbacks } from "../src/sv_user.js";

function assert(cond, message) {
  if (!cond) {
    throw new Error(message);
  }
}

function makeAirbornePlayer() {
  const ent = new edict_t(1, 106);
  ent.v.mins.set([-16, -16, -24]);
  ent.v.maxs.set([16, 16, 32]);
  ent.v.movetype = MOVETYPE_WALK;
  ent.v.health = 100;
  ent.v.flags = 0; // not on ground: SV_AirMove's air branch
  ent.v.velocity.set([30, -20, 0]);
  return ent;
}

function think(client) {
  SV_SetState({ time: 10, edicts: [], num_edicts: 1 }, {}, {
    self: 0,
    other: 0,
    time: 0,
  });
  SV_SetCallbacks({ SV_LinkEdict: () => {}, EDICT_TO_PROG: () => 0 });
  SV_User_SetCallbacks({ V_CalcRoll: () => 0, host_client: client });
  SV_SetFrametime(1 / 72);
  const ent = makeAirbornePlayer();
  SV_SetPlayer(ent);
  SV_ClientThink();
  return ent;
}

Deno.test("client_t starts with a zeroed usercmd, as C's memset leaves it", () => {
  const client = new client_t();
  assert(client.cmd !== null, "cmd is null");
  assert(client.cmd.forwardmove === 0, "forwardmove");
  assert(client.cmd.sidemove === 0, "sidemove");
  assert(client.cmd.upmove === 0, "upmove");
  assert(new client_t().cmd !== client.cmd, "clients share one cmd");
});

Deno.test("SV_ClientThink runs a spawned client that has sent no clc_move", () => {
  const ent = think(new client_t());
  // no movement asked for: the air branch leaves the velocity alone
  assert(ent.v.velocity[0] === 30, "velocity x " + ent.v.velocity[0]);
  assert(ent.v.velocity[1] === -20, "velocity y " + ent.v.velocity[1]);
});

Deno.test("SV_ClientThink runs a hand-built client whose cmd is null", () => {
  const client = { cmd: null };
  think(client);
  assert(client.cmd !== null, "cmd still null");
  assert(client.cmd.forwardmove === 0, "forwardmove");
});
