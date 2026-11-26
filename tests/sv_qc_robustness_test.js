// QuakeC VM and server fixes from the second Ironwail review: objerror is not
// fatal, empty float keys parse as 0, bad edict numbers in the interpreter
// become a PR_RunError, ED_FieldAtOfs finds .modelindex, unknown map keys go
// to Con_DPrintf, and SV_Move keeps C's by-value trace semantics.

import * as common from "../src/common.js";
import { CONTENTS_EMPTY } from "../src/bspfile.js";
import { PR_InitBuiltins } from "../src/pr_cmds.js";
import {
  ev_float,
  ev_string,
  OFS_PARM0,
  OP_ADDRESS,
  OP_CALL0,
  OP_DONE,
  OP_LOAD_F,
  OP_LOAD_V,
  OP_STATE,
  OP_STOREP_F,
} from "../src/pr_comp.js";
import {
  ED_FieldAtOfs,
  ED_ParseEdict,
  ED_ParseEpair,
  PR_AllocEdicts,
} from "../src/pr_edict.js";
import { PR_ExecuteProgram, PR_SetHostError } from "../src/pr_exec.js";
import {
  pr_builtins,
  pr_fielddefs,
  pr_functions,
  pr_global_struct,
  pr_globals_float,
  pr_globals_int,
  pr_numbuiltins,
  PR_SetBuiltins,
  PR_SetFieldDefs,
  PR_SetFunctions,
  PR_SetGlobalsFloat,
  PR_SetGlobalsInt,
  PR_SetGlobalStruct,
  PR_SetProgs,
  PR_SetStatements,
  PR_SetStringsData,
  PR_SetSV,
  PR_SetXFunction,
  PR_SetXStatement,
  pr_statements,
  pr_strings_data,
  pr_xfunction,
  pr_xstatement,
  progs,
  sv as progs_sv,
} from "../src/progs.js";
import { SOLID_BBOX, ss_active, sv } from "../src/server.js";
import {
  MOVE_NORMAL,
  SV_ClearWorld,
  SV_LinkEdict,
  SV_Move,
} from "../src/world.js";

const PF_OBJERROR = 11;

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${
        JSON.stringify(actual)
      }`,
    );
  }
}

const printed = [];
const dprinted = [];
common.Con_SetPrintFunctions(
  (fmt, ...args) => printed.push([fmt, ...args].join(" ")),
  (fmt, ...args) => dprinted.push([fmt, ...args].join(" ")),
);

// Saves the VM and server state a test changes; returns a restore function.
function saveVM() {
  const saved = {
    progs,
    pr_builtins,
    pr_numbuiltins,
    pr_fielddefs,
    pr_functions,
    pr_global_struct,
    pr_globals_float,
    pr_globals_int,
    pr_statements,
    pr_strings_data,
    pr_xfunction,
    pr_xstatement,
    progs_sv,
    svFields: Object.assign({}, sv),
  };

  return () => {
    PR_SetProgs(saved.progs);
    PR_SetBuiltins(saved.pr_builtins, saved.pr_numbuiltins);
    PR_SetFieldDefs(saved.pr_fielddefs);
    PR_SetFunctions(saved.pr_functions);
    PR_SetGlobalStruct(saved.pr_global_struct);
    PR_SetGlobalsFloat(saved.pr_globals_float);
    PR_SetGlobalsInt(saved.pr_globals_int);
    PR_SetStatements(saved.pr_statements);
    PR_SetStringsData(saved.pr_strings_data);
    PR_SetXFunction(saved.pr_xfunction);
    PR_SetXStatement(saved.pr_xstatement);
    Object.assign(sv, saved.svFields);
    PR_SetSV(saved.progs_sv);
  };
}

// A world with no brushes and numEdicts edicts
function setupWorld(numEdicts) {
  const emptyHull = {
    firstclipnode: CONTENTS_EMPTY,
    lastclipnode: CONTENTS_EMPTY,
    clipnodes: [],
    planes: [],
    clip_mins: new Float32Array(3),
  };
  const worldmodel = {
    type: 0,
    hulls: [emptyHull, emptyHull, emptyHull],
    mins: new Float32Array([-4096, -4096, -4096]),
    maxs: new Float32Array([4096, 4096, 4096]),
  };

  sv.edicts = PR_AllocEdicts(numEdicts, 105);
  sv.num_edicts = numEdicts;
  sv.max_edicts = numEdicts;
  sv.models = new Array(256).fill(null);
  sv.models[1] = worldmodel;
  sv.worldmodel = worldmodel;
  sv.time = 1;
  PR_SetSV(sv);
  SV_ClearWorld();
}

function setupGlobals() {
  const buffer = new ArrayBuffer(128 * 4);
  PR_SetGlobalsFloat(new Float32Array(buffer));
  PR_SetGlobalsInt(new Int32Array(buffer));
  PR_SetStringsData(new TextEncoder().encode("\0test_fn\0"));
}

// Runs action and returns the Host_Error message it raised, or null
function hostErrorOf(action) {
  const sentinel = new Error("Host_Error sentinel");
  let message = null;
  const old = PR_SetHostError((m) => {
    message = m;
    throw sentinel;
  });

  try {
    action();
  } catch (e) {
    if (e !== sentinel) {
      throw e;
    }
  } finally {
    PR_SetHostError(old);
  }

  return message;
}

function makeFunction(first_statement) {
  return {
    first_statement,
    parm_start: 0,
    locals: 0,
    profile: 0,
    s_name: 1,
    s_file: 0,
    numparms: 0,
    parm_size: [],
  };
}

Deno.test("PF_objerror frees self without ending the level", () => {
  const restore = saveVM();

  try {
    setupWorld(4);
    setupGlobals();
    PR_SetProgs({ numfielddefs: 0, numfunctions: 2 });
    PR_SetFieldDefs([]);
    PR_SetGlobalStruct({ self: 2 });
    PR_SetXFunction(makeFunction(0));
    PR_InitBuiltins();
    pr_globals_int[OFS_PARM0] = 1; // "test_fn"

    const message = hostErrorOf(() => pr_builtins[PF_OBJERROR]());
    assertEqual(message, null, "objerror raised Host_Error");
    assertEqual(sv.edicts[2].free, true, "self freed");
  } finally {
    restore();
  }
});

Deno.test("ED_ParseEpair stores 0 for an empty or non-numeric float, as atof does", () => {
  const restore = saveVM();

  try {
    setupWorld(2);
    const ent = sv.edicts[1];
    const key = { type: ev_float, ofs: 30, s_name: 0 };

    for (
      const [text, want] of [["", 0], ["abc", 0], ["2.5", 2.5], [" 7xyz", 7]]
    ) {
      ent._fieldAccessor.setFloat(30, 99);
      ED_ParseEpair(ent._fieldAccessor, key, text);
      assertEqual(ent._fieldAccessor.getFloat(30), want, `"${text}"`);
    }
  } finally {
    restore();
  }
});

Deno.test("ED_FieldAtOfs skips the null fielddef and finds .modelindex at offset 0", () => {
  const restore = saveVM();

  try {
    const nullDef = { type: 0, ofs: 0, s_name: 0 };
    const modelindex = { type: ev_float, ofs: 0, s_name: 1 };
    const origin = { type: ev_float, ofs: 1, s_name: 2 };
    PR_SetProgs({ numfielddefs: 3 });
    PR_SetFieldDefs([nullDef, modelindex, origin]);

    assertEqual(ED_FieldAtOfs(0), modelindex, "offset 0");
    assertEqual(ED_FieldAtOfs(1), origin, "offset 1");
    assertEqual(ED_FieldAtOfs(5), null, "unknown offset");
  } finally {
    restore();
  }
});

Deno.test("ED_ParseEdict reports unknown keys only to developers, and never sky, fog or alpha", () => {
  const restore = saveVM();

  try {
    setupWorld(2);
    PR_SetStringsData(new TextEncoder().encode("\0classname\0"));
    PR_SetProgs({ numfielddefs: 2 });
    PR_SetFieldDefs([{ type: 0, ofs: 0, s_name: 0 }, {
      type: ev_string,
      ofs: 3,
      s_name: 1,
    }]);

    printed.length = 0;
    dprinted.length = 0;
    ED_ParseEdict(
      '"classname" "x" "bogus" "1" "sky" "s" "skyfog" "1" "fog" "f" "alpha" "0.5" }',
      sv.edicts[1],
    );

    assertEqual(printed.length, 0, "nothing printed without developer");
    assertEqual(dprinted.length, 1, "one developer message");
    assertEqual(
      dprinted[0].includes("bogus"),
      true,
      "the unknown key is named",
    );
  } finally {
    restore();
  }
});

Deno.test("A bad edict number in an edict opcode is a PR_RunError, not a TypeError", () => {
  const restore = saveVM();

  try {
    setupWorld(4);
    setupGlobals();
    PR_SetGlobalStruct({ self: 0, time: 0 });
    sv.state = ss_active;
    PR_SetFunctions([null, makeFunction(0)]);
    PR_SetProgs({ numfunctions: 2 });

    const ENT = 40, FLD = 41, OUT = 42;
    const programs = [
      [OP_LOAD_F, ENT, FLD, OUT],
      [OP_LOAD_V, ENT, FLD, OUT],
      [OP_ADDRESS, ENT, FLD, OUT],
      [OP_STOREP_F, OUT, ENT, 0],
    ];

    for (const [op, a, b, c] of programs) {
      PR_SetStatements([{ op, a, b, c }, { op: OP_DONE, a: 0, b: 0, c: 0 }]);
      pr_globals_int[ENT] = op === OP_STOREP_F ? (99 << 16) | 5 : 99;
      pr_globals_int[FLD] = 5;
      assertEqual(
        hostErrorOf(() => PR_ExecuteProgram(1)),
        "Program error",
        "op " + op,
      );

      pr_globals_int[ENT] = op === OP_STOREP_F ? (2 << 16) | 5 : 2;
      assertEqual(
        hostErrorOf(() => PR_ExecuteProgram(1)),
        null,
        "op " + op + " in range",
      );
    }

    PR_SetStatements([{ op: OP_STATE, a: OUT, b: 0, c: 0 }, {
      op: OP_DONE,
      a: 0,
      b: 0,
      c: 0,
    }]);
    pr_global_struct.self = 99;
    assertEqual(
      hostErrorOf(() => PR_ExecuteProgram(1)),
      "Program error",
      "OP_STATE",
    );

    // A TypeError thrown by a builtin is not an edict opcode error: rethrown as is
    const builtins = [null, () => {
      throw new TypeError("from a builtin");
    }];
    PR_SetBuiltins(builtins, 2);
    PR_SetFunctions([null, makeFunction(0), makeFunction(-1)]);
    PR_SetProgs({ numfunctions: 3 });
    PR_SetStatements([{ op: OP_CALL0, a: ENT, b: 0, c: 0 }, {
      op: OP_DONE,
      a: 0,
      b: 0,
      c: 0,
    }]);
    pr_globals_int[ENT] = 2;
    let caught = null;
    try {
      hostErrorOf(() => PR_ExecuteProgram(1));
    } catch (e) {
      caught = e;
    }

    assertEqual(
      caught instanceof TypeError,
      true,
      "builtin TypeError rethrown",
    );
  } finally {
    restore();
  }
});

Deno.test("An edict past the allocated ones but below max_edicts reads as zeroed, as in C", () => {
  const restore = saveVM();

  try {
    setupWorld(4);
    sv.max_edicts = 64; // C allocates all 64; sv.edicts holds 4
    setupGlobals();
    PR_SetGlobalStruct({ self: 0, time: 0 });
    sv.state = ss_active;
    PR_SetFunctions([null, makeFunction(0)]);
    PR_SetProgs({ numfunctions: 2 });

    const ENT = 40, FLD = 41, OUT = 42;
    for (const op of [OP_LOAD_F, OP_LOAD_V, OP_ADDRESS]) {
      PR_SetStatements([{ op, a: ENT, b: FLD, c: OUT }, {
        op: OP_DONE,
        a: 0,
        b: 0,
        c: 0,
      }]);
      pr_globals_int[FLD] = 5;
      pr_globals_float.fill(7, OUT, OUT + 3);

      pr_globals_int[ENT] = 20;
      assertEqual(
        hostErrorOf(() => PR_ExecuteProgram(1)),
        null,
        "op " + op + " below max_edicts",
      );
      if (op === OP_ADDRESS) {
        assertEqual(pr_globals_int[OUT], (20 << 16) | 5, "address of edict 20");
      } else {
        assertEqual(
          pr_globals_float[OUT],
          0,
          "op " + op + " reads a zeroed field",
        );
      }
      if (op === OP_LOAD_V) {
        assertEqual(pr_globals_float[OUT + 2], 0, "vector reads zeroed");
      }
      assertEqual(sv.edicts[20].index, 20, "edict 20 allocated");

      pr_globals_int[ENT] = 64;
      assertEqual(
        hostErrorOf(() => PR_ExecuteProgram(1)),
        "Program error",
        "op " + op + " at max_edicts",
      );
      pr_globals_int[ENT] = -1;
      assertEqual(
        hostErrorOf(() => PR_ExecuteProgram(1)),
        "Program error",
        "op " + op + " negative",
      );
    }

    // OP_STOREP_F through an OP_ADDRESS of a grown edict writes it
    PR_SetStatements([
      { op: OP_ADDRESS, a: ENT, b: FLD, c: OUT },
      { op: OP_STOREP_F, a: 43, b: OUT, c: 0 },
      { op: OP_DONE, a: 0, b: 0, c: 0 },
    ]);
    pr_globals_int[ENT] = 30;
    pr_globals_float[43] = 12.5;
    assertEqual(
      hostErrorOf(() => PR_ExecuteProgram(1)),
      null,
      "store to edict 30",
    );
    assertEqual(sv.edicts[30]._fieldAccessor.getFloat(5), 12.5, "stored");

    // OP_STATE on a self past the allocated edicts
    PR_SetStatements([{ op: OP_STATE, a: OUT, b: FLD, c: 0 }, {
      op: OP_DONE,
      a: 0,
      b: 0,
      c: 0,
    }]);
    pr_global_struct.self = 50;
    assertEqual(
      hostErrorOf(() => PR_ExecuteProgram(1)),
      null,
      "OP_STATE below max_edicts",
    );
    pr_global_struct.self = 64;
    assertEqual(
      hostErrorOf(() => PR_ExecuteProgram(1)),
      "Program error",
      "OP_STATE at max_edicts",
    );

    assertEqual(sv.num_edicts, 4, "num_edicts unchanged");
  } finally {
    restore();
  }
});

Deno.test("SV_Move returns its own trace, clipped to the nearest entity", () => {
  const restore = saveVM();

  try {
    setupWorld(4);
    const near = sv.edicts[1];
    const far = sv.edicts[2];
    for (const [ent, x] of [[near, 100], [far, 200]]) {
      ent.free = false;
      ent.v.solid = SOLID_BBOX;
      ent.v.origin[0] = x;
      ent.v.mins.fill(-8);
      ent.v.maxs.fill(8);
      SV_LinkEdict(ent, false);
    }

    const zero = new Float32Array(3);
    const start = new Float32Array([0, 0, 0]);
    const end = new Float32Array([300, 0, 0]);
    const first = SV_Move(start, zero, zero, end, MOVE_NORMAL, null);
    assertEqual(first.ent, near, "hit the near box");
    assertEqual(first.endpos[0] < 100, true, "stopped before the near box");
    assertEqual(first.plane.normal[0], -1, "plane normal");

    const back = new Float32Array([150, 0, 0]);
    const second = SV_Move(back, zero, zero, end, MOVE_NORMAL, null);
    assertEqual(second.ent, far, "second trace hit the far box");
    assertEqual(second !== first, true, "new trace object");
    assertEqual(first.ent, near, "first trace unchanged");
    assertEqual(first.endpos[0] < 100, true, "first endpos unchanged");

    const clear = SV_Move(
      start,
      zero,
      zero,
      new Float32Array([0, 50, 0]),
      MOVE_NORMAL,
      null,
    );
    assertEqual(clear.fraction, 1, "unobstructed");
    assertEqual(clear.ent, null, "no entity");
  } finally {
    restore();
  }
});
