// QuakeC extension builtins ported from Ironwail: maths, strings, tokenize,
// sprintf, clientstat, checkcommand, clientcommand, checkextension, the
// "= #0" name remap, and the table's "unimplemented builtin" for numbers past
// id's #78.

import * as cmd from "../src/cmd.js";
import * as common from "../src/common.js";
import { Cvar_RegisterVariable, cvar_t } from "../src/cvar.js";
import {
  pr_checkextension,
  pr_extbuiltins,
  pr_extnames,
  PR_InitBuiltins,
  PR_InitProgsBuiltins,
  sv_customstats,
} from "../src/pr_cmds.js";
import * as server from "../src/server.js";
import {
  OFS_PARM0,
  OFS_PARM1,
  OFS_PARM2,
  OFS_RETURN,
  OP_CALL1,
  OP_CALL3,
  OP_DONE,
} from "../src/pr_comp.js";
import { PR_ExecuteProgram, PR_SetHostError } from "../src/pr_exec.js";
import {
  PR_AppendString,
  pr_argc,
  pr_builtins,
  PR_ClearZoneStrings,
  pr_functions,
  PR_GetString,
  pr_global_struct,
  pr_globals_float,
  pr_globals_int,
  pr_numbuiltins,
  PR_SetArgc,
  PR_SetBuiltins,
  PR_SetFunctions,
  PR_SetGlobalsFloat,
  PR_SetGlobalsInt,
  PR_SetGlobalStruct,
  PR_SetProgs,
  PR_SetStatements,
  PR_SetStringsData,
  PR_SetStringTempOfs,
  PR_SetSV,
  PR_SetXFunction,
  PR_SetXStatement,
  pr_statements,
  pr_string_temp_ofs,
  pr_strings_data,
  pr_xfunction,
  pr_xstatement,
  progs,
  STRINGTEMP_BUFFERS,
  STRINGTEMP_LENGTH,
  sv,
} from "../src/progs.js";

const printed = [];
const dprinted = [];
common.Con_SetPrintFunctions(
  (fmt, ...args) =>
    printed.push(args.length > 0 ? String(args[0]) : String(fmt)),
  (fmt, ...args) => dprinted.push([fmt, ...args].join("|")),
);

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${
        JSON.stringify(actual)
      }`,
    );
  }
}

// Fresh globals, string table and builtins for one test; returns a restore function
function setup() {
  const saved = {
    progs,
    pr_builtins,
    pr_numbuiltins,
    pr_functions,
    pr_globals_float,
    pr_globals_int,
    pr_statements,
    pr_strings_data,
    pr_string_temp_ofs,
    pr_argc,
    pr_xfunction,
    pr_xstatement,
  };

  const buffer = new ArrayBuffer(64 * 4);
  PR_SetGlobalsFloat(new Float32Array(buffer));
  PR_SetGlobalsInt(new Int32Array(buffer));
  PR_SetStringsData(new Uint8Array(1 + STRINGTEMP_BUFFERS * STRINGTEMP_LENGTH));
  PR_SetStringTempOfs(1);
  PR_ClearZoneStrings();
  PR_InitBuiltins();
  printed.length = 0;

  return () => {
    PR_SetProgs(saved.progs);
    PR_SetBuiltins(saved.pr_builtins, saved.pr_numbuiltins);
    PR_SetFunctions(saved.pr_functions);
    PR_SetGlobalsFloat(saved.pr_globals_float);
    PR_SetGlobalsInt(saved.pr_globals_int);
    PR_SetStatements(saved.pr_statements);
    PR_SetStringsData(saved.pr_strings_data);
    PR_SetStringTempOfs(saved.pr_string_temp_ofs);
    PR_SetArgc(saved.pr_argc);
    PR_SetXFunction(saved.pr_xfunction);
    PR_SetXStatement(saved.pr_xstatement);
    PR_ClearZoneStrings();
  };
}

const str = (s) => PR_AppendString(s);

// Calls builtin n directly with the given argument count and parameters.
// Each parameter is a number (float), a string, [ x, y, z ], or { int: n }
// for an entity or field offset.
function call(n, ...parms) {
  PR_SetArgc(parms.length);
  parms.forEach((p, i) => {
    const o = OFS_PARM0 + i * 3;
    if (typeof p === "string") {
      pr_globals_int[o] = str(p);
    } else if (Array.isArray(p)) {
      pr_globals_float.set(p, o);
    } else if (typeof p === "object") {
      pr_globals_int[o] = p.int; // an entity or a field offset
    } else {
      pr_globals_float[o] = p;
    }
  });
  pr_builtins[n]();
}

const retF = () => pr_globals_float[OFS_RETURN];
const retS = () => PR_GetString(pr_globals_int[OFS_RETURN]);

function makeFunction(first_statement, s_name = 0) {
  return {
    first_statement,
    parm_start: 0,
    locals: 0,
    profile: 0,
    s_name,
    s_file: 0,
    numparms: 0,
    parm_size: [],
  };
}

Deno.test("Maths builtins use Ironwail's numbers", () => {
  const restore = setup();

  try {
    call(60, Math.PI / 2);
    assertEqual(retF(), 1, "sin");
    call(61, 0);
    assertEqual(retF(), 1, "cos");
    call(62, 16);
    assertEqual(retF(), 4, "sqrt");
    call(97, 2, 10);
    assertEqual(retF(), 1024, "pow");
    call(94, 5, -2, 3);
    assertEqual(retF(), -2, "min of three");
    call(95, 5, -2, 9, 1);
    assertEqual(retF(), 9, "max of four");
    call(96, 0, 15, 10);
    assertEqual(retF(), 10, "bound high");
    call(96, 0, -5, 10);
    assertEqual(retF(), 0, "bound low");
    call(245, 7, 3);
    assertEqual(retF(), 1, "mod");
    call(245, -7, 3);
    assertEqual(retF(), -1, "mod truncates toward zero");
    call(245, 7.5, 2);
    assertEqual(retF(), 1.5, "mod of a fraction");
    call(245, 5, 0);
    assertEqual(retF(), 0, "mod by zero");
  } finally {
    restore();
  }
});

Deno.test("Conversion builtins: stof, stov, etos", () => {
  const restore = setup();

  try {
    call(81, "  -12.5abc");
    assertEqual(retF(), -12.5, "stof");
    call(81, "xyz");
    assertEqual(retF(), 0, "stof of junk");
    call(117, "'1 -2.5 3'");
    assertEqual(
      Array.from(pr_globals_float.subarray(OFS_RETURN, OFS_RETURN + 3)).join(
        " ",
      ),
      "0 1 -2.5",
      "stov: COM_Parse makes the quote its own token",
    );
    call(117, "1 2");
    assertEqual(
      Array.from(pr_globals_float.subarray(OFS_RETURN, OFS_RETURN + 3)).join(
        " ",
      ),
      "1 2 0",
      "stov with two tokens",
    );
    const oldSv = sv;
    try {
      PR_SetSV({
        edicts: [0, 1, 2, 3].map((index) => ({ index })),
        num_edicts: 4,
      });
      pr_globals_int[OFS_PARM0] = 3;
      PR_SetArgc(1);
      pr_builtins[65]();
      assertEqual(retS(), "entity 3", "etos");
    } finally {
      PR_SetSV(oldSv);
    }
  } finally {
    restore();
  }
});

Deno.test("String builtins: strlen, strcat, substring", () => {
  const restore = setup();

  try {
    call(114, "hello");
    assertEqual(retF(), 5, "strlen");
    call(115, "a", "bc", "def");
    assertEqual(retS(), "abcdef", "strcat");
    call(115);
    assertEqual(retS(), "", "strcat of nothing");

    call(115, "x".repeat(800), "y".repeat(800));
    assertEqual(retS().length, STRINGTEMP_LENGTH - 1, "strcat truncates");
    assertEqual(
      printed.some((m) => m.includes("PF_strcat: overflow")),
      true,
      "strcat warns",
    );

    for (
      const [start, length, want] of [
        [1, 3, "ell"],
        [-3, 2, "ll"],
        [1, -1, "ello"],
        [1, -2, "ell"],
        [10, 1, ""],
        [0, 0, ""],
        [-10, 2, "he"],
        [3, 100, "lo"],
      ]
    ) {
      call(116, "hello", start, length);
      assertEqual(retS(), want, `substring( "hello", ${start}, ${length} )`);
    }
  } finally {
    restore();
  }
});

Deno.test("strzone keeps a string until strunzone, which recycles its block", () => {
  const restore = setup();

  try {
    call(118, "abc", "de");
    const a = pr_globals_int[OFS_RETURN];
    assertEqual(PR_GetString(a), "abcde", "strzone joins its arguments");

    // temp strings don't touch it
    for (let i = 0; i < STRINGTEMP_BUFFERS + 1; i++) {
      call(115, "tmp");
    }
    assertEqual(
      PR_GetString(a),
      "abcde",
      "zoned string survives the temp ring",
    );

    pr_globals_int[OFS_PARM0] = a;
    PR_SetArgc(1);
    pr_builtins[119]();
    assertEqual(printed.length, 0, "no warning for a zoned string");

    call(118, "xyz");
    assertEqual(pr_globals_int[OFS_RETURN], a, "freed block reused");
    assertEqual(PR_GetString(a), "xyz", "reused block holds the new string");

    call(118, "a much longer string than before");
    const b = pr_globals_int[OFS_RETURN];
    assertEqual(b !== a, true, "a block too small is not reused");

    pr_globals_int[OFS_PARM0] = 0;
    pr_builtins[119]();
    assertEqual(printed.length, 0, "strunzone of the null string is silent");

    pr_globals_int[OFS_PARM0] = str("never zoned");
    pr_builtins[119]();
    assertEqual(
      printed.some((m) => m.includes("wasn't strzoned")),
      true,
      "warns for a string that was not zoned",
    );

    // growing the string table keeps zoned strings
    str("z".repeat(pr_strings_data.length + 10));
    assertEqual(PR_GetString(a), "xyz", "zoned string survives table growth");
    assertEqual(
      PR_GetString(b),
      "a much longer string than before",
      "appended zone block survives table growth",
    );

    printed.length = 0;
    pr_globals_int[OFS_PARM0] = b;
    pr_builtins[119]();
    pr_builtins[119]();
    assertEqual(
      printed.length,
      1,
      "a second strunzone of the same string warns",
    );
  } finally {
    restore();
  }
});

Deno.test("tokenize, argv and argc", () => {
  const restore = setup();
  const argcNumber = 1268; // Ironwail's eleventh numberless builtin

  try {
    call(441, '  say "hello there" 42 ');
    assertEqual(retF(), 3, "tokenize count");
    pr_builtins[argcNumber]();
    assertEqual(retF(), 3, "argc");
    call(442, 1);
    assertEqual(retS(), "hello there", "argv 1");
    call(442, -1);
    assertEqual(retS(), "42", "argv -1 counts from the end");
    call(442, 3);
    assertEqual(
      pr_globals_int[OFS_RETURN],
      0,
      "argv past the end is the null string",
    );

    call(441, "x ".repeat(70));
    assertEqual(retF(), 64, "at most MAXQCTOKENS tokens");
  } finally {
    restore();
  }
});

Deno.test("ftoi and itof convert between float and int bits", () => {
  const restore = setup();

  try {
    call(1271, -7.9); // ftoi
    assertEqual(pr_globals_int[OFS_RETURN], -7, "ftoi truncates");
    pr_globals_int[OFS_PARM0] = 12;
    pr_builtins[1270](); // itof
    assertEqual(retF(), 12, "itof");
  } finally {
    restore();
  }
});

Deno.test("sprintf formats as C printf", () => {
  const restore = setup();

  // Expected strings are from the system C library's snprintf
  const floats = [
    ["%f", 3.14159, "3.141590"],
    ["%.2f", -1.5, "-1.50"],
    ["%e", 123.456, "1.234560e+02"],
    ["%.3E", 0.0001234, "1.234E-04"],
    ["%g", 100000, "100000"],
    ["%g", 1234567, "1.23457e+06"],
    ["%g", 0.0001234, "0.0001234"],
    ["%g", 1e-5, "1e-05"],
    ["%G", 1e-5, "1E-05"],
    ["%#g", 1, "1.00000"],
    ["%10.3f", 3.14159, "     3.142"],
    ["%-10.1f|", -1.5, "-1.5      |"],
    ["%+g", 1, "+1"],
    ["% g", 1, " 1"],
    ["%010.2f", -1.5, "-000001.50"],
    ["%#.0f", 1, "1."],
    ["%.0e", 123.456, "1e+02"],
    ["%g", -0, "-0"],
    ["%f", 1e30, "1000000015047466219876688855040.000000"],
    ["%d", -7.9, "-7"],
    ["%x", 255, "ff"],
    ["%#X", 255, "0XFF"],
    ["%#o", 8, "010"],
    ["%05d", -42, "-0042"],
    ["%.3d", 7, "007"],
    ["%08.3d", 7, "     007"],
    ["%.0d", 0, ""],
    ["%c", 65, "A"],
    ["%v", [1, -2.5, 0.125], "1 -2.5 0.125"],
    ["%s|%5s|%-5s|%.2s", null, null],
  ];

  try {
    for (const [fmt, value, want] of floats) {
      if (value === null) {
        continue;
      }
      call(627, fmt, value);
      assertEqual(retS(), want, `sprintf( "${fmt}", ${value} )`);
    }

    call(627, "%s|%5s|%-5s|%.2s|%S", "ab", "ab", "ab", "abc", "q");
    assertEqual(retS(), 'ab|   ab|ab   |ab|"q"', "strings");
    call(627, "%ld %li %lx", 0, 0, 0);
    pr_globals_int[OFS_PARM0 + 3] = -5;
    pr_globals_int[OFS_PARM0 + 6] = 7;
    pr_globals_int[OFS_PARM0 + 9] = -1;
    pr_builtins[627]();
    assertEqual(retS(), "-5 7 ffffffff", "l reads int arguments");
    call(627, "%5i|%hi", 0, 42);
    pr_globals_int[OFS_PARM0 + 3] = 42;
    pr_builtins[627]();
    assertEqual(
      retS(),
      "   42|42",
      "%i defaults to an int argument, %hi reads a float",
    );
    call(627, "%2$s %1$s %%", "world", "hello");
    assertEqual(retS(), "hello world %", "positional arguments");
    call(627, "%*d|%-*d|%.*f", 4, 7, 3, 8, 2, 3.14159);
    assertEqual(retS(), "   7|8  |3.14", "star width and precision");
    call(627, "%d %d", 1);
    assertEqual(retS(), "1 0", "missing arguments read as 0");
    call(627, "a%qb", 1);
    assertEqual(retS(), "a", "bad directive stops the output");
    call(627, "%s", "x".repeat(2000));
    assertEqual(
      retS().length,
      STRINGTEMP_LENGTH - 1,
      "output cut to the temp buffer",
    );
    call(627, "%*d|", 2000000000, 5);
    assertEqual(
      retS(),
      " ".repeat(STRINGTEMP_LENGTH - 1),
      "huge width is cut, not thrown",
    );
    call(627, "%-2000000000d|", 5);
    assertEqual(
      retS(),
      "5" + " ".repeat(STRINGTEMP_LENGTH - 2),
      "huge left-justified width",
    );
    call(627, "%.2000000000f", 5.5);
    assertEqual(
      retS(),
      "5.5" + "0".repeat(STRINGTEMP_LENGTH - 4),
      "huge precision",
    );
    call(627, "%.2000000000e", 5.5);
    assertEqual(
      retS(),
      "5.5" + "0".repeat(STRINGTEMP_LENGTH - 4),
      "huge %e precision",
    );
  } finally {
    restore();
  }
});

Deno.test("finaleFinished returns false", () => {
  const restore = setup();

  try {
    pr_globals_float[OFS_RETURN] = 5;
    call(79);
    assertEqual(retF(), 0, "finaleFinished");
  } finally {
    restore();
  }
});

Deno.test("Builtins are reached through OP_CALL with its argument count, and unported numbers are unimplemented", () => {
  const restore = setup();

  try {
    // function 1: min( 4, -3, 2 ); function 2 is builtin #94 (min)
    const fn = 30;
    PR_SetFunctions([
      null,
      makeFunction(0),
      makeFunction(-94),
      makeFunction(-316),
      makeFunction(-1279),
    ]);
    PR_SetProgs({ numfunctions: 5 });
    PR_SetStatements([{ op: OP_CALL3, a: fn, b: 0, c: 0 }, {
      op: OP_DONE,
      a: OFS_RETURN,
      b: 0,
      c: 0,
    }]);
    pr_globals_int[fn] = 2;
    pr_globals_float[OFS_PARM0] = 4;
    pr_globals_float[OFS_PARM1] = -3;
    pr_globals_float[OFS_PARM2] = 2;
    PR_ExecuteProgram(1);
    assertEqual(retF(), -3, "min through OP_CALL3");

    for (const target of [3, 4]) {
      PR_SetStatements([{ op: OP_CALL1, a: fn, b: 0, c: 0 }, {
        op: OP_DONE,
        a: OFS_RETURN,
        b: 0,
        c: 0,
      }]);
      pr_globals_int[fn] = target;
      let message = null;
      const sentinel = new Error("sentinel");
      const old = PR_SetHostError((m) => {
        message = m;
        throw sentinel;
      });
      printed.length = 0;
      try {
        PR_ExecuteProgram(1);
      } catch (e) {
        if (e !== sentinel) {
          throw e;
        }
      } finally {
        PR_SetHostError(old);
      }

      assertEqual(message, "Program error", "function " + target + " errors");
      assertEqual(
        printed.some((m) => m.includes("unimplemented builtin")),
        true,
        "unimplemented builtin for function " + target,
      );
    }
  } finally {
    restore();
  }
});

Deno.test('PR_InitProgsBuiltins binds "= #0" functions by name', () => {
  const restore = setup();

  try {
    const names = [
      "ftoi",
      "sin",
      "makevectors",
      "not_a_builtin",
      "strlen",
      "localsound",
      "ex_bprint",
      "ex_localsound",
    ];
    const functions = [makeFunction(0)];
    for (const name of names) {
      functions.push(makeFunction(0, str(name)));
    }
    functions[5].locals = 1; // has locals: a real QuakeC function, left alone
    PR_SetFunctions(functions);

    PR_InitProgsBuiltins();

    assertEqual(functions[1].first_statement, -1271, "ftoi");
    assertEqual(functions[2].first_statement, -60, "sin");
    assertEqual(functions[3].first_statement, -1, "makevectors");
    assertEqual(functions[4].first_statement, 0, "unknown name");
    assertEqual(functions[5].first_statement, 0, "function with locals");
    assertEqual(
      functions[6].first_statement,
      -80,
      "localsound is bound to its slot",
    );
    assertEqual(
      pr_builtins[80] !== pr_builtins[0],
      true,
      "localsound slot is not PF_Fixme",
    );
    assertEqual(functions[7].first_statement, -1277, "ex_bprint");
    assertEqual(pr_builtins[1277], pr_builtins[23], "ex_bprint is bprint");
    assertEqual(
      pr_builtins[-functions[8].first_statement],
      pr_builtins[80],
      "ex_localsound is localsound",
    );
  } finally {
    restore();
  }
});

// The 2021 re-release builtins that Ironwail stubs to 0. Without them the
// first weapon or ammo pickup (W_WantsToChangeWeapon) stops the server with
// "unimplemented builtin", and mg1's chasing monsters do the same.
Deno.test("Re-release ex_ builtins bind by name and return 0 as in Ironwail", () => {
  const restore = setup();

  try {
    const names = [
      "ex_CheckPlayerEXFlags",
      "ex_walkpathtogoal",
      "ex_finaleFinished",
      "ex_finalefinished",
    ];
    const functions = [makeFunction(0), makeFunction(0)];
    for (const name of names) {
      functions.push(makeFunction(0, str(name)));
    }
    PR_SetFunctions(functions);
    PR_SetProgs({ numfunctions: functions.length });

    PR_InitProgsBuiltins();

    for (let i = 0; i < names.length; i++) {
      assertEqual(
        functions[2 + i].first_statement < 0,
        true,
        names[i] + " is bound",
      );
    }
    assertEqual(
      functions[4].first_statement,
      functions[5].first_statement,
      "ex_finaleFinished shares ex_finalefinished's slot",
    );

    // function 1: return target( entity 1 ) (or ( 64, goal ) for walkpathtogoal)
    const fn = 30;
    for (let i = 0; i < names.length; i++) {
      PR_SetStatements([{ op: OP_CALL3, a: fn, b: 0, c: 0 }, {
        op: OP_DONE,
        a: OFS_RETURN,
        b: 0,
        c: 0,
      }]);
      pr_globals_int[fn] = 2 + i;
      pr_globals_int[OFS_PARM0] = 1;
      pr_globals_float[OFS_PARM1] = 64;
      pr_globals_float[OFS_RETURN] = 5;
      printed.length = 0;
      PR_ExecuteProgram(1);
      assertEqual(retF(), 0, names[i] + " returns 0");
      assertEqual(printed.length, 0, names[i] + " prints nothing");
    }
  } finally {
    restore();
  }
});

const f32 = (x) => Math.fround(x);

Deno.test("Inverse trig and tan: asin, acos, atan, atan2, tan (#471-#475)", () => {
  const restore = setup();

  try {
    call(471, 1);
    assertEqual(retF(), f32(Math.PI / 2), "asin(1)");
    call(471, -0.5);
    assertEqual(retF(), f32(-Math.PI / 6), "asin(-0.5)");
    call(472, 1);
    assertEqual(retF(), 0, "acos(1)");
    call(472, 0);
    assertEqual(retF(), f32(Math.PI / 2), "acos(0)");
    call(473, 1);
    assertEqual(retF(), f32(Math.PI / 4), "atan(1)");
    // atan2(y, x): the first parameter is y, as C's atan2
    call(474, 1, 0);
    assertEqual(retF(), f32(Math.PI / 2), "atan2(1, 0)");
    call(474, 0, -1);
    assertEqual(retF(), f32(Math.PI), "atan2(0, -1)");
    call(474, -1, -1);
    assertEqual(retF(), f32(-3 * Math.PI / 4), "atan2(-1, -1)");
    call(475, 0);
    assertEqual(retF(), 0, "tan(0)");
    call(475, f32(Math.PI / 4));
    assertEqual(retF(), f32(Math.tan(f32(Math.PI / 4))), "tan(pi/4)");
    call(471, 2);
    assertEqual(Number.isNaN(retF()), true, "asin out of range is NaN");
  } finally {
    restore();
  }
});

Deno.test("vectorvectors sets v_forward, v_right and v_up from a direction (#432)", () => {
  const restore = setup();
  const savedGlobals = pr_global_struct;
  PR_SetGlobalStruct({
    v_forward: new Float32Array(3),
    v_right: new Float32Array(3),
    v_up: new Float32Array(3),
  });
  const vec = (v) => Array.from(v).join(" ");

  try {
    // facing +x: right is -y, up is +z (as makevectors '0 0 0')
    call(432, [3, 0, 0]);
    assertEqual(vec(pr_global_struct.v_forward), "1 0 0", "forward of +x");
    assertEqual(vec(pr_global_struct.v_right), "0 -1 0", "right of +x");
    assertEqual(vec(pr_global_struct.v_up), "0 0 1", "up of +x");

    // straight up: right is -y, up = right x forward = -x
    call(432, [0, 0, 5]);
    assertEqual(vec(pr_global_struct.v_forward), "0 0 1", "forward of +z");
    assertEqual(vec(pr_global_struct.v_right), "0 -1 0", "right of +z");
    assertEqual(vec(pr_global_struct.v_up), "-1 0 0", "up of +z");

    // diagonal: right is normalized
    call(432, [1, 1, 0]);
    const h = f32(Math.SQRT1_2);
    assertEqual(vec(pr_global_struct.v_forward), `${h} ${h} 0`, "forward");
    assertEqual(vec(pr_global_struct.v_right), `${h} ${-h} 0`, "right");

    // zero: everything zero, and v_right[1] is 0, not -1
    pr_global_struct.v_right.set([9, 9, 9]);
    call(432, [0, 0, 0]);
    assertEqual(vec(pr_global_struct.v_forward), "0 0 0", "forward of 0");
    assertEqual(vec(pr_global_struct.v_right), "0 0 0", "right of 0");
    assertEqual(vec(pr_global_struct.v_up), "0 0 0", "up of 0");
  } finally {
    PR_SetGlobalStruct(savedGlobals);
    restore();
  }
});

Deno.test("str2chr reads one byte, from the end for a negative index (#222)", () => {
  const restore = setup();

  try {
    call(222, "abc", 1);
    assertEqual(retF(), 98, "str2chr(abc, 1)");
    call(222, "abc", -1);
    assertEqual(retF(), 99, "negative counts from the end");
    call(222, "abc", -3);
    assertEqual(retF(), 97, "-length is the first byte");
    call(222, "abc", 3);
    assertEqual(retF(), 0, "the length is the NUL");
    call(222, "abc", 4);
    assertEqual(retF(), 0, "past the end");
    call(222, "abc", -4);
    assertEqual(retF(), 0, "before the start");
    call(222, "", 0);
    assertEqual(retF(), 0, "empty string");
    call(222, "\xe1z", 0);
    assertEqual(retF(), 225, "a high byte is unsigned");
    call(222, "xyz");
    assertEqual(retF(), 120, "the index defaults to 0");
    call(222, "abc", 1.9);
    assertEqual(retF(), 98, "the index truncates");
  } finally {
    restore();
  }
});

Deno.test("chr2str joins bytes, maps U+E0xx to Quake chars and others to ? (#223)", () => {
  const restore = setup();

  try {
    call(223, 104, 105);
    assertEqual(retS(), "hi", "two chars");
    call(223, 0xe0c1, 0xe041);
    assertEqual(retS(), "\xc1A", "U+E0xx is the Quake char xx");
    call(223, 255);
    assertEqual(retS(), "\xff", "255 is kept");
    call(223, 256, 0x263a, -1, 65);
    assertEqual(retS(), "???A", "anything else is ?");
    call(223, 72, 0, 73);
    assertEqual(retS(), "H", "a 0 ends the string");
  } finally {
    restore();
  }
});

Deno.test("strconv changes case and colour as FTE_STRINGS does (#224)", () => {
  const restore = setup();
  const bytes = () => Array.from(retS(), (c) => c.charCodeAt(0)).join(",");

  try {
    call(224, 1, 0, 0, "HeLLo 12!");
    assertEqual(retS(), "hello 12!", "lower case");
    call(224, 2, 0, 0, "ab", "cd");
    assertEqual(retS(), "ABCD", "upper case of all the string arguments");

    // red: letters + 128, digits to the red digits (+128), punctuation + 128
    call(224, 0, 2, 2, "a1!");
    assertEqual(bytes(), "225,177,161", "to red");
    call(224, 0, 1, 1, "\xe1\xb1\xa1");
    assertEqual(retS(), "a1!", "red back to white");
    call(224, 2, 1, 0, "\xe1");
    assertEqual(retS(), "A", "white and upper case of a red letter");

    // alternate: 5 makes even characters red, 6 odd ones
    call(224, 0, 5, 0, "aaaa");
    assertEqual(bytes(), "225,97,225,97", "alternate");
    call(224, 0, 6, 0, "aaaa");
    assertEqual(bytes(), "97,225,97,225", "alternate-alternate");

    // the special digits: 3 is '0' - 30, 4 is '0' + 128 - 30
    call(224, 0, 0, 3, "09");
    assertEqual(bytes(), "18,27", "redspecial digits");
    call(224, 0, 0, 4, "0");
    assertEqual(bytes(), "146", "whitespecial digit");
    call(224, 0, 0, 1, "\x12\x92\xb0");
    assertEqual(retS(), "000", "every digit set back to plain");

    // control characters (low 4 bits of 7) keep their value
    call(224, 0, 2, 0, "\n\x8a");
    assertEqual(bytes(), "10,138", "special chars unchanged");
    call(224, 0, 0, 0, "a\xa1");
    assertEqual(bytes(), "97,161", "0 0 0 changes nothing");
  } finally {
    restore();
  }
});

Deno.test("tokenize_console splits as tokenize does (#514)", () => {
  const restore = setup();

  try {
    call(514, 'say "hello there" 3');
    assertEqual(retF(), 3, "token count");
    call(442, 1);
    assertEqual(retS(), "hello there", "a quoted token");
    call(442, -1);
    assertEqual(retS(), "3", "the last token");
    call(1268); // argc, Ironwail's eleventh numberless builtin
    assertEqual(retF(), 3, "argc");
  } finally {
    restore();
  }
});

Deno.test("clientstat registers numeric stats, replacing one by index, and progs load clears them (#232)", () => {
  const restore = setup();
  PR_SetFunctions([]);
  PR_InitProgsBuiltins();

  try {
    call(232, 40, 2, { int: 10 }); // ev_float
    call(232, 41, 3, { int: 12 }); // ev_vector
    call(232, 42, 8, { int: 14 }); // ev_ext_integer
    call(232, 43, 4, { int: 15 }); // ev_entity
    call(232, 40, 3, { int: 20 }); // replaces 40
    call(232, 44, 1, { int: 21 }); // ev_string: ignored
    call(232, 45, 6, { int: 22 }); // ev_function: ignored
    call(232, 256, 2, { int: 23 }); // out of range
    call(232, -1, 2, { int: 24 }); // out of range
    call(232, 255, 2, { int: 25 }); // the last index

    assertEqual(
      JSON.stringify(sv_customstats),
      JSON.stringify([
        { idx: 40, type: 3, fld: 20 },
        { idx: 41, type: 3, fld: 12 },
        { idx: 42, type: 8, fld: 14 },
        { idx: 43, type: 4, fld: 15 },
        { idx: 255, type: 2, fld: 25 },
      ]),
      "registered stats",
    );

    PR_InitProgsBuiltins();
    assertEqual(sv_customstats.length, 0, "cleared when progs load");
  } finally {
    sv_customstats.length = 0;
    restore();
  }
});

cmd.Cmd_Init();
const ran = [];
cmd.Cmd_AddCommand("zz_qc_command", () => {});
// starts with "say", so a client may send it
cmd.Cmd_AddCommand(
  "sayzz_qc",
  () => ran.push([server.host_client, cmd.Cmd_Argv(1)]),
);
cmd.Cmd_ExecuteString("alias zz_qc_alias echo", cmd.src_command);
Cvar_RegisterVariable(new cvar_t("zz_qc_cvar", "1"));

Deno.test("checkcommand: 1 command, 2 alias, 3 cvar, 0 none, ignoring case for commands and aliases (#294)", () => {
  const restore = setup();

  try {
    call(294, "zz_qc_command");
    assertEqual(retF(), 1, "command");
    call(294, "ZZ_QC_Command");
    assertEqual(retF(), 1, "command in another case");
    call(294, "zz_qc_alias");
    assertEqual(retF(), 2, "alias");
    call(294, "ZZ_QC_ALIAS");
    assertEqual(retF(), 2, "alias in another case");
    call(294, "zz_qc_cvar");
    assertEqual(retF(), 3, "cvar");
    call(294, "zz_qc_nothing");
    assertEqual(retF(), 0, "nothing");
  } finally {
    restore();
  }
});

Deno.test("clientcommand runs a client's command as that client, and refuses others (#440)", () => {
  const restore = setup();
  const savedSV = sv;
  const savedClients = server.svs.clients;
  const savedMax = server.svs.maxclients;
  const savedHost = server.host_client;
  const client = { active: true, name: "Ranger" };
  PR_SetSV({
    edicts: [{ index: 0 }, { index: 1 }, { index: 2 }],
    num_edicts: 3,
    max_edicts: 3,
  });
  server.svs.clients = [client];
  server.svs.maxclients = 1;
  const other = { name: "other" };
  server.set_host_client(other);

  try {
    ran.length = 0;
    call(440, { int: 1 }, "sayzz_qc hello");
    assertEqual(ran.length, 1, "the command ran");
    assertEqual(ran[0][0], client, "as the client");
    assertEqual(ran[0][1], "hello", "with its arguments");
    assertEqual(server.host_client, other, "host_client restored");

    ran.length = 0;
    dprinted.length = 0;
    call(440, { int: 1 }, "zz_qc_command");
    assertEqual(
      dprinted.join("\n"),
      "%s tried to %s\n|Ranger|zz_qc_command",
      "a command a client may not send",
    );
    assertEqual(server.host_client, other, "host_client restored");

    for (const ent of [0, 2]) {
      printed.length = 0;
      call(440, { int: ent }, "sayzz_qc x");
      assertEqual(
        printed.join(""),
        "PF_clientcommand: not a client\n",
        "entity " + ent,
      );
    }
    client.active = false;
    printed.length = 0;
    call(440, { int: 1 }, "sayzz_qc x");
    assertEqual(
      printed.join(""),
      "PF_clientcommand: not a client\n",
      "inactive client",
    );
    assertEqual(ran.length, 0, "none of those ran");
  } finally {
    PR_SetSV(savedSV);
    server.svs.clients = savedClients;
    server.svs.maxclients = savedMax;
    server.set_host_client(savedHost);
    restore();
  }
});

// The names mods probe that Ironwail doesn't know
const PROBED_NAMES = [
  "DP_SV_POINTPARTICLES",
  "FTE_SV_POINTPARTICLES",
  "DP_GFX_FOG",
  "DP_QC_GETSURFACE",
  "DP_TE_PARTICLERAIN",
  "DP_TE_PARTICLESNOW",
  "DP_SV_ROTATINGBMODEL",
  "FTE_ENT_SKIN_CONTENTS",
  "DP_QC_RANDOMVEC",
  "EXT_BITSHIFT",
  "FTE_PART_NAMESPACE_EFFECTINFO",
  "DP_SV_SETCOLOR",
  "EX_EXTENDED_EF",
  "EX_MOVETYPE_GIB",
  "EX_PROMPT",
  "QUAKE_EX",
  "EXT_CSQC",
  "",
  "fte_qc_checkcommand",
];

Deno.test("checkextension answers true for exactly Ironwail's FTE_QC_CHECKCOMMAND, whose builtins all exist", () => {
  const restore = setup();

  try {
    // Ironwail's QCEXTENSIONS_ALL, in order
    assertEqual(
      pr_extnames.join(" "),
      "STD_QC FRIK_FILE FTE_STRINGS FTE_QC_CHECKCOMMAND DP_QC_ETOS " +
        "DP_QC_MINMAXBOUND DP_QC_SINCOSSQRTPOW DP_QC_ASINACOSATANATAN2TAN " +
        "DP_QC_VECTORVECTORS DP_QC_STRING_CASE_FUNCTIONS DP_QC_SPRINTF " +
        "DP_QC_TOKENIZE_CONSOLE DP_QC_STRFTIME KRIMZON_SV_PARSECLIENTCOMMAND",
      "extension names",
    );

    const claimed = [];
    for (const name of [...pr_extnames, ...PROBED_NAMES]) {
      pr_globals_float[OFS_RETURN] = 5;
      call(99, name);
      if (retF() !== 0) {
        assertEqual(retF(), 1, name + " answers 1");
        claimed.push(name);
      }
    }
    assertEqual(claimed.join(" "), "FTE_QC_CHECKCOMMAND", "claimed");

    // never claims more: every builtin of a claimed extension is implemented
    const fixme = pr_builtins[0];
    for (const ext of claimed) {
      const rows = pr_extbuiltins.filter((r) => r[3] === ext);
      assertEqual(rows.length > 0, true, ext + " has builtins");
      for (const [name, func, number] of rows) {
        assertEqual(func !== fixme, true, name + " is implemented");
        assertEqual(pr_builtins[number], func, name + " is in its slot");
      }
    }

    // every tag is a known extension
    for (const [name, , , ext] of pr_extbuiltins) {
      assertEqual(
        ext === null || pr_extnames.includes(ext),
        true,
        name + "'s tag " + ext,
      );
    }
  } finally {
    restore();
  }
});

Deno.test("Only Ironwail's CSQC-only builtins stay unimplemented, and pr_checkextension is 1", () => {
  const restore = setup();

  try {
    const fixme = pr_builtins[0];
    const unported = pr_extbuiltins.filter((r) => r[1] === fixme).map((r) =>
      r[0]
    );
    assertEqual(
      unported.join(" "),
      "iscachedpic precache_pic drawgetimagesize drawcharacter " +
        "drawrawstring drawpic drawfill drawsetcliparea drawresetcliparea " +
        "drawstring stringwidth drawsubpic getstati getstatf getstats " +
        "getplayerkeyvalue getplayerkeyfloat registercommand",
      "unported builtins",
    );
    for (const [name, func, number] of pr_extbuiltins) {
      if (number !== 0) {
        assertEqual(pr_builtins[number], func, name + " is #" + number);
      }
    }

    assertEqual(pr_checkextension.name, "pr_checkextension", "cvar name");
    assertEqual(pr_checkextension.string, "1", "cvar default");
  } finally {
    restore();
  }
});
