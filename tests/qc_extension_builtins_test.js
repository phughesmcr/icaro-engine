// QuakeC extension builtins ported from Ironwail: maths, strings, tokenize,
// sprintf, checkextension, the "= #0" name remap, and the table's
// "unimplemented builtin" for numbers past id's #78.

import * as common from "../src/common.js";
import { PR_InitBuiltins, PR_InitProgsBuiltins } from "../src/pr_cmds.js";
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
  pr_globals_float,
  pr_globals_int,
  pr_numbuiltins,
  PR_SetArgc,
  PR_SetBuiltins,
  PR_SetFunctions,
  PR_SetGlobalsFloat,
  PR_SetGlobalsInt,
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
common.Con_SetPrintFunctions(
  (fmt, ...args) =>
    printed.push(args.length > 0 ? String(args[0]) : String(fmt)),
  () => {},
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
// Each parameter is a number (float), a string, or [ x, y, z ].
function call(n, ...parms) {
  PR_SetArgc(parms.length);
  parms.forEach((p, i) => {
    const o = OFS_PARM0 + i * 3;
    if (typeof p === "string") {
      pr_globals_int[o] = str(p);
    } else if (Array.isArray(p)) {
      pr_globals_float.set(p, o);
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

Deno.test("checkextension and finaleFinished return false", () => {
  const restore = setup();

  try {
    call(99, "FTE_QC_CHECKCOMMAND");
    assertEqual(retF(), 0, "checkextension");
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
      makeFunction(-294),
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
