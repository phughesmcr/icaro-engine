// sv_freezenonclients (Ironwail): SV_Physics runs only the world and the
// client slots, and sv.time stands still. Default 0 keeps id's behaviour.

import { OFS_RETURN, OP_CALL0, OP_DONE } from "../src/pr_comp.js";
import { PR_AllocEdicts } from "../src/pr_edict.js";
import { PR_ExecuteProgram } from "../src/pr_exec.js";
import {
  EDICT_TO_PROG,
  NEXT_EDICT,
  pr_builtins,
  pr_functions,
  pr_global_struct,
  pr_globals_float,
  pr_globals_int,
  pr_numbuiltins,
  PR_SetBuiltins,
  PR_SetFunctions,
  PR_SetGlobalsFloat,
  PR_SetGlobalsInt,
  PR_SetProgs,
  PR_SetStatements,
  PR_SetSV,
  PR_SetSVS,
  pr_statements,
  PROG_TO_EDICT,
  progs,
  sv as progs_sv,
  svs as progs_svs,
} from "../src/progs.js";
import { MOVETYPE_NONE } from "../src/server.js";
import {
  host_frametime,
  sv_freezenonclients,
  SV_Physics,
  SV_SetCallbacks,
  SV_SetFrametime,
  SV_SetState,
} from "../src/sv_phys.js";

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${
        JSON.stringify(actual)
      }`,
    );
  }
}

const G_RECORD = 30; // global holding the recorder builtin's function number

// Runs two frames: the first with the cvar off, the second with it on.
// Returns what each frame ran and the server time after it.
function runFrames() {
  const saved = {
    progs,
    pr_builtins,
    pr_numbuiltins,
    pr_functions,
    pr_globals_float,
    pr_globals_int,
    pr_statements,
    progs_sv,
    progs_svs,
    host_frametime,
    cvar: [sv_freezenonclients.string, sv_freezenonclients.value],
  };

  const ran = [];
  const gs = {
    self: 0,
    other: 0,
    time: 0,
    StartFrame: 1,
    PlayerPreThink: 1,
    PlayerPostThink: 1,
    force_retouch: 0,
  };

  try {
    const buffer = new ArrayBuffer(64 * 4);
    PR_SetGlobalsFloat(new Float32Array(buffer));
    PR_SetGlobalsInt(new Int32Array(buffer));
    pr_globals_int[G_RECORD] = 2;
    PR_SetBuiltins([null, () => ran.push(gs.self)], 2);

    // function 1 calls builtin #1 (function 2), which records self
    const fn = (first_statement) => ({
      first_statement,
      parm_start: 0,
      locals: 0,
      profile: 0,
      s_name: 0,
      numparms: 0,
      parm_size: [],
    });
    PR_SetFunctions([null, fn(0), fn(-1)]);
    PR_SetStatements([
      { op: OP_CALL0, a: G_RECORD, b: 0, c: 0 },
      { op: OP_DONE, a: OFS_RETURN, b: 0, c: 0 },
    ]);
    PR_SetProgs({ numfunctions: 3 });

    const sv = { edicts: PR_AllocEdicts(3, 105), num_edicts: 3, time: 1 };
    const svs = { maxclients: 1, clients: [{ active: true }] };
    PR_SetSV(sv);
    PR_SetSVS(svs);
    SV_SetState(sv, svs, gs);
    // as SV_SpawnServer wires them; nothing else in this file uses sv_phys
    // SV_LinkEdict is stubbed: there is no world to link into
    SV_SetCallbacks({
      PR_ExecuteProgram,
      EDICT_TO_PROG,
      PROG_TO_EDICT,
      NEXT_EDICT,
      SV_LinkEdict: () => {},
    });
    SV_SetFrametime(0.1);

    // world (0) and a non-client (2) both think this frame; 1 is a live
    // client, whose PlayerPreThink and PlayerPostThink record it
    for (const e of [0, 1, 2]) {
      sv.edicts[e].v.movetype = MOVETYPE_NONE;
    }
    const frames = [];

    for (const freeze of [0, 1]) {
      sv_freezenonclients.string = String(freeze);
      sv_freezenonclients.value = freeze;
      for (const e of [0, 2]) {
        sv.edicts[e].v.think = 1;
        sv.edicts[e].v.nextthink = sv.time + 0.05;
      }

      ran.length = 0;
      SV_Physics();
      frames.push({
        ran: ran.join(" "),
        time: Math.round(sv.time * 1000) / 1000,
      });
    }

    return frames;
  } finally {
    PR_SetProgs(saved.progs);
    PR_SetBuiltins(saved.pr_builtins, saved.pr_numbuiltins);
    PR_SetFunctions(saved.pr_functions);
    PR_SetGlobalsFloat(saved.pr_globals_float);
    PR_SetGlobalsInt(saved.pr_globals_int);
    PR_SetStatements(saved.pr_statements);
    PR_SetSV(saved.progs_sv);
    PR_SetSVS(saved.progs_svs);
    SV_SetState(saved.progs_sv, saved.progs_svs, pr_global_struct);
    SV_SetFrametime(saved.host_frametime);
    sv_freezenonclients.string = saved.cvar[0];
    sv_freezenonclients.value = saved.cvar[1];
  }
}

Deno.test("sv_freezenonclients defaults to 0", () => {
  assertEqual(sv_freezenonclients.name, "sv_freezenonclients", "cvar name");
  assertEqual(sv_freezenonclients.string, "0", "default");
});

Deno.test("SV_Physics freezes non-clients and time when sv_freezenonclients is set", () => {
  const [normal, frozen] = runFrames();

  // StartFrame (self 0), the world's think (0), client 1's pre- and
  // post-think, then entity 2's think
  assertEqual(normal.ran, "0 0 1 1 2", "cvar off: everything thinks");
  assertEqual(normal.time, 1.1, "cvar off: time advances");

  // StartFrame, the world and the client still run; entity 2 is past the cap
  assertEqual(frozen.ran, "0 0 1 1", "cvar on: only the world and clients");
  assertEqual(frozen.time, 1.1, "cvar on: time stands still");
});
