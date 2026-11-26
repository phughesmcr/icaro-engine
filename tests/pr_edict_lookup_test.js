// Assertions on pr_edict.c's null results and the locals around them: names
// the lookups and parsers find or miss, the "angle" key hack, when ED_Alloc
// reuses a freed edict, and a missing progs.dat.

import * as common from "../src/common.js";
import { ev_field, ev_float, ev_function, ev_vector } from "../src/pr_comp.js";
import {
  ED_Alloc,
  ED_ParseEdict,
  ED_ParseEpair,
  ED_ParseGlobals,
  GetEdictFieldValue,
  PR_AllocEdicts,
  PR_GlobalString,
  PR_GlobalStringNoContents,
  PR_LoadProgs,
} from "../src/pr_edict.js";
import {
  pr_fielddefs,
  pr_functions,
  pr_globaldefs,
  pr_globals,
  pr_globals_int,
  PR_SetFieldDefs,
  PR_SetFunctions,
  PR_SetGlobalDefs,
  PR_SetGlobals,
  PR_SetGlobalsInt,
  PR_SetHostError,
  PR_SetProgs,
  PR_SetStringsData,
  PR_SetSV,
  PR_SetSVS,
  pr_strings_data,
  progs,
  sv,
  svs,
} from "../src/progs.js";

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${
        JSON.stringify(actual)
      }`,
    );
  }
}

// string table offsets
const STRINGS = "\0angles\0origin\0g\0fn\0";
const S_ANGLES = 1;
const S_ORIGIN = 8;
const S_G = 15;
const S_FN = 17;

// Runs fn on a progs with two vector fields, one float global and one
// function, then restores the VM. fn gets what was printed.
function withVM(fn) {
  const saved = {
    progs,
    pr_fielddefs,
    pr_functions,
    pr_globaldefs,
    pr_globals,
    pr_globals_int,
    pr_strings_data,
    sv,
  };
  const printed = [];
  common.Con_SetPrintFunctions(
    (fmt, ...args) => printed.push([fmt, ...args].join(" ")),
    () => {},
  );
  try {
    PR_SetStringsData(new TextEncoder().encode(STRINGS));
    PR_SetProgs({ numfielddefs: 3, numglobaldefs: 1, numfunctions: 2 });
    PR_SetFieldDefs([
      { type: 0, ofs: 0, s_name: 0 },
      { type: ev_vector, ofs: 1, s_name: S_ANGLES },
      { type: ev_vector, ofs: 4, s_name: S_ORIGIN },
    ]);
    PR_SetGlobalDefs([{ type: ev_float, ofs: 28, s_name: S_G }]);
    PR_SetFunctions([{ s_name: 0 }, { s_name: S_FN }]);
    PR_SetGlobals({ getFloat: () => 2 });
    fn(printed);
  } finally {
    PR_SetStringsData(saved.pr_strings_data);
    PR_SetProgs(saved.progs);
    PR_SetFieldDefs(saved.pr_fielddefs);
    PR_SetFunctions(saved.pr_functions);
    PR_SetGlobalDefs(saved.pr_globaldefs);
    PR_SetGlobals(saved.pr_globals);
    PR_SetGlobalsInt(saved.pr_globals_int);
    PR_SetSV(saved.sv);
    common.Con_SetPrintFunctions(null, null);
  }
}

Deno.test("GetEdictFieldValue returns null for a missing field, cached or not", () => {
  withVM(() => {
    const ed = PR_AllocEdicts(1, 8)[0];
    for (const pass of ["looked up", "cached"]) {
      assertEqual(GetEdictFieldValue(ed, "nope_field"), null, pass);
      assertEqual(GetEdictFieldValue(ed, "origin").ofs, 4, pass);
    }
  });
});

Deno.test("PR_GlobalString and PR_GlobalStringNoContents mark an unknown offset", () => {
  withVM(() => {
    assertEqual(PR_GlobalString(5), "5(???)".padEnd(20) + " ", "unknown");
    assertEqual(
      PR_GlobalStringNoContents(5),
      "5(???)".padEnd(20) + " ",
      "unknown, no contents",
    );
    assertEqual(
      PR_GlobalString(28),
      "28(g)  2.0".padEnd(20) + " ",
      "known",
    );
    assertEqual(
      PR_GlobalStringNoContents(28),
      "28(g)".padEnd(20) + " ",
      "known, no contents",
    );
  });
});

Deno.test("ED_ParseEpair finds field and function names or returns false", () => {
  withVM((printed) => {
    const ed = PR_AllocEdicts(1, 8)[0];
    assertEqual(
      ED_ParseEpair(ed._fieldAccessor, { type: ev_field, ofs: 0 }, "nope"),
      false,
      "field",
    );
    assertEqual(
      ED_ParseEpair(ed._fieldAccessor, { type: ev_function, ofs: 0 }, "nope"),
      false,
      "function",
    );
    assertEqual(
      ED_ParseEpair(ed._fieldAccessor, { type: ev_function, ofs: 0 }, "fn"),
      true,
      "known function",
    );
    assertEqual(ed._fieldAccessor.getInt32(0), 1, "function number");
    // a field value is the global that holds the field's offset
    PR_SetGlobalsInt(new Int32Array([0, 0, 0, 0, 123]));
    assertEqual(
      ED_ParseEpair(ed._fieldAccessor, { type: ev_field, ofs: 1 }, "origin"),
      true,
      "known field",
    );
    assertEqual(ed._fieldAccessor.getInt32(1), 123, "field value");
    assertEqual(
      printed.join("|"),
      "Can't find field %s\n nope|Can't find function %s\n nope",
      "messages",
    );
  });
});

Deno.test("ED_ParseGlobals raises a Host_Error when a known global fails to parse", () => {
  withVM(() => {
    PR_SetGlobalDefs([{ type: ev_function, ofs: 0, s_name: S_G }]);
    const errors = [];
    const oldHostError = PR_SetHostError((message) => {
      errors.push(message);
      throw new Error("host error");
    });
    try {
      try {
        ED_ParseGlobals('"g" "nope" }');
      } catch (e) {
        if (e.message !== "host error") throw e;
      }
      assertEqual(errors.join("|"), "ED_ParseGlobals: parse error", "error");
    } finally {
      PR_SetHostError(oldHostError);
    }
  });
});

Deno.test('ED_ParseEdict turns "angle" into a yaw and leaves the next key alone', () => {
  withVM(() => {
    const edicts = PR_AllocEdicts(2, 8);
    PR_SetSV({ edicts });
    const ent = edicts[1];
    ED_ParseEdict('"angle" "90" "origin" "1 2 3" }', ent);
    const f = (ofs) => ent._fieldAccessor.getFloat(ofs);
    assertEqual([f(1), f(2), f(3)].join(" "), "0 90 0", "angles");
    assertEqual([f(4), f(5), f(6)].join(" "), "1 2 3", "origin");
    assertEqual(ent.free, false, "in use");

    ED_ParseEdict("}", ent);
    assertEqual(ent.free, true, "an empty dictionary frees the edict");
  });
});

Deno.test("ED_Alloc reuses a freed edict only after half a second", () => {
  withVM(() => {
    const edicts = PR_AllocEdicts(8, 8);
    const fake = { edicts, num_edicts: 4, max_edicts: 8, time: 10 };
    PR_SetSV(fake);
    const oldSvs = svs;
    PR_SetSVS({ maxclients: 1 });
    try {
      edicts[2].free = true;
      edicts[2].freetime = 9.8; // too recent
      edicts[3].free = true;
      edicts[3].freetime = 9;
      assertEqual(ED_Alloc(), edicts[3], "reused");
      assertEqual(edicts[3].free, false, "cleared");
      assertEqual(fake.num_edicts, 4, "no growth");
      assertEqual(ED_Alloc(), edicts[4], "appended");
      assertEqual(fake.num_edicts, 5, "grown");
    } finally {
      PR_SetSVS(oldSvs);
    }
  });
});

Deno.test("PR_LoadProgs raises a Sys_Error when progs.dat is missing", () => {
  const consoleError = console.error;
  console.error = () => {};
  try {
    let message = null;
    try {
      PR_LoadProgs(null);
    } catch (e) {
      message = e.message;
    }
    assertEqual(message, "PR_LoadProgs: couldn't load progs.dat", "error");
  } finally {
    console.error = consoleError;
  }
});
