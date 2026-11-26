// Ported from: WinQuake/pr_exec.c -- QuakeC bytecode interpreter

import { Con_Printf } from "./common.js";
import { PR_GlobalString, PR_GlobalStringNoContents } from "./pr_edict.js";
import {
  pr_builtins,
  pr_code,
  pr_functions,
  PR_GetString,
  pr_global_struct,
  pr_globals_float,
  pr_globals_int,
  PR_HostError,
  pr_numbuiltins,
  PR_SetArgc,
  PR_SetHostError,
  PR_SetTrace,
  PR_SetXFunction,
  PR_SetXStatement,
  pr_statements,
  PR_strcmp_ofs,
  pr_strings_data,
  pr_trace,
  pr_xfunction,
  pr_xstatement,
  PROG_TO_EDICT,
  progs,
  sv,
} from "./progs.js";
import {
  OFS_PARM0,
  OFS_RETURN,
  OP_CALL0,
  OP_GOTO,
  OP_IF,
  OP_IFNOT,
  OP_STORE_F,
  OP_STORE_FNC,
} from "./pr_comp.js";
import { ED_Print } from "./pr_edict.js";
import { ss_active } from "./server.js";

/*
*/

// Deliberate deviation from id (32 and 2048): Ironwail/QuakeSpasm's limits
// (progs.h), so deeply recursive mods don't hit "stack overflow"
const MAX_STACK_DEPTH = 1024;
const LOCALSTACK_SIZE = 16384;

const pr_stack = new Array(MAX_STACK_DEPTH);
for (let i = 0; i < MAX_STACK_DEPTH; i++) {
  pr_stack[i] = { s: 0, f: null };
}

let pr_depth = 0;

const localstack = new Int32Array(LOCALSTACK_SIZE);
let localstack_used = 0;

// PR_HostError and PR_SetHostError live in progs.js; re-exported for callers
// that import them from here.
export { PR_HostError, PR_SetHostError };

const pr_opnames = [
  "DONE",
  "MUL_F",
  "MUL_V",
  "MUL_FV",
  "MUL_VF",
  "DIV",
  "ADD_F",
  "ADD_V",
  "SUB_F",
  "SUB_V",
  "EQ_F",
  "EQ_V",
  "EQ_S",
  "EQ_E",
  "EQ_FNC",
  "NE_F",
  "NE_V",
  "NE_S",
  "NE_E",
  "NE_FNC",
  "LE",
  "GE",
  "LT",
  "GT",
  "INDIRECT",
  "INDIRECT",
  "INDIRECT",
  "INDIRECT",
  "INDIRECT",
  "INDIRECT",
  "ADDRESS",
  "STORE_F",
  "STORE_V",
  "STORE_S",
  "STORE_ENT",
  "STORE_FLD",
  "STORE_FNC",
  "STOREP_F",
  "STOREP_V",
  "STOREP_S",
  "STOREP_ENT",
  "STOREP_FLD",
  "STOREP_FNC",
  "RETURN",
  "NOT_F",
  "NOT_V",
  "NOT_S",
  "NOT_ENT",
  "NOT_FNC",
  "IF",
  "IFNOT",
  "CALL0",
  "CALL1",
  "CALL2",
  "CALL3",
  "CALL4",
  "CALL5",
  "CALL6",
  "CALL7",
  "CALL8",
  "STATE",
  "GOTO",
  "AND",
  "OR",
  "BITAND",
  "BITOR",
];

//=============================================================================

/*
=================
PR_PrintStatement
=================
*/
export function PR_PrintStatement(s) {
  let line = "";

  if (s.op < pr_opnames.length) {
    line += pr_opnames[s.op];
    while (line.length < 10) {
      line += " ";
    }
  }

  if (s.op === OP_IF || s.op === OP_IFNOT) {
    line += PR_GlobalString(s.a) + "branch " + s.b;
  } else if (s.op === OP_GOTO) {
    line += "branch " + s.a;
  } else if (s.op >= OP_STORE_F && s.op <= OP_STORE_FNC) {
    line += PR_GlobalString(s.a);
    line += PR_GlobalStringNoContents(s.b);
  } else {
    if (s.a !== 0) {
      line += PR_GlobalString(s.a);
    }
    if (s.b !== 0) {
      line += PR_GlobalString(s.b);
    }
    if (s.c !== 0) {
      line += PR_GlobalStringNoContents(s.c);
    }
  }

  Con_Printf("%s\n", line);
}

/*
============
PR_strcmp

strcmp() for OP_NE_S. C only guarantees the sign of the result, so this
returns -1, 0 or 1 from the first differing byte.
============
*/
export function PR_strcmp(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = a.charCodeAt(i) - b.charCodeAt(i);
    if (d !== 0) {
      return d < 0 ? -1 : 1;
    }
  }

  if (a.length === b.length) {
    return 0;
  }
  return a.length < b.length ? -1 : 1;
}

/*
============
PR_StackTrace
============
*/
export function PR_StackTrace() {
  if (pr_depth === 0) {
    Con_Printf("<NO STACK>\n");
    return;
  }

  pr_stack[pr_depth].f = pr_xfunction;

  for (let i = pr_depth; i >= 0; i--) {
    const f = pr_stack[i].f;

    if (!f) {
      Con_Printf("<NO FUNCTION>\n");
    } else {
      Con_Printf("%12s : %s\n", PR_GetString(f.s_file), PR_GetString(f.s_name));
    }
  }
}

/*
============
PR_RunError

Aborts the currently executing function
============
*/
export function PR_RunError(error, ...args) {
  let message = error;
  // Simple sprintf-like formatting
  for (const arg of args) {
    message = message.replace(/%[disf]/, String(arg));
  }

  PR_PrintStatement(pr_statements[pr_xstatement]);
  PR_StackTrace();
  Con_Printf("%s\n", message);

  pr_depth = 0; // dump the stack so host_error can shutdown functions

  PR_HostError("Program error");
}

/*
============================================================================
PR_ExecuteProgram

The interpretation main loop
============================================================================
*/

/*
====================
PR_EnterFunction

Returns the new program statement counter
====================
*/
export function PR_EnterFunction(f) {
  pr_stack[pr_depth].s = pr_xstatement;
  pr_stack[pr_depth].f = pr_xfunction;
  pr_depth++;

  if (pr_depth >= MAX_STACK_DEPTH) {
    PR_RunError("stack overflow");
  }

  // save off any locals that the new function steps on
  const c = f.locals;
  if (localstack_used + c > LOCALSTACK_SIZE) {
    PR_RunError("PR_ExecuteProgram: locals stack overflow\n");
  }

  for (let i = 0; i < c; i++) {
    localstack[localstack_used + i] = pr_globals_int[f.parm_start + i];
  }
  localstack_used += c;

  // copy parameters
  let o = f.parm_start;
  for (let i = 0; i < f.numparms; i++) {
    for (let j = 0; j < f.parm_size[i]; j++) {
      pr_globals_int[o] = pr_globals_int[OFS_PARM0 + i * 3 + j];
      o++;
    }
  }

  PR_SetXFunction(f);
  return f.first_statement - 1; // offset the s++
}

/*
====================
PR_LeaveFunction
====================
*/
export function PR_LeaveFunction() {
  // id has Sys_Error; Host_Error is Ironwail's (deliberate deviation)
  if (pr_depth <= 0) {
    PR_HostError("prog stack underflow");
  }

  // restore locals from the stack
  const c = pr_xfunction.locals;
  localstack_used -= c;
  if (localstack_used < 0) {
    PR_RunError("PR_ExecuteProgram: locals stack underflow\n");
  }

  for (let i = 0; i < c; i++) {
    pr_globals_int[pr_xfunction.parm_start + i] =
      localstack[localstack_used + i];
  }

  // up stack
  pr_depth--;
  PR_SetXFunction(pr_stack[pr_depth].f);
  return pr_stack[pr_depth].s;
}

/*
====================
PR_ExecuteProgram

Port addition: in C a bad edict number in OP_LOAD_*, OP_STOREP_*,
OP_ADDRESS or OP_STATE reads or writes stray memory (Ironwail range-checks
only under PARANOID). A number below sv.max_edicts is not bad: as in C it
reads a zeroed edict (PROG_TO_EDICT grows sv.edicts). For a negative one,
or one at or past sv.max_edicts, sv.edicts[ n ] is undefined and the opcode
throws a TypeError, which Host_Frame rethrows and the room dies. Turn that
into a PR_RunError (a Host_Error, as Ironwail's PARANOID NUM_FOR_EDICT
check does). The check runs only after a throw, so the interpreter loop
pays nothing for it. The loop keeps its statement counter in a local and
writes pr_xstatement only where something reads it (a call, an error, this
check), so its catch block stores the counter before running the check.
====================
*/
export function PR_ExecuteProgram(fnum) {
  PR_ExecuteProgram_Loop(fnum);
}

/*
====================
PR_CheckBadEdict

Cold path for PR_ExecuteProgram. If the statement that threw is an edict
opcode with an edict number outside sv.edicts, abort it with PR_RunError.
Any other TypeError (from a builtin, say) is left for the caller to rethrow.
====================
*/
function PR_CheckBadEdict() {
  const st = pr_statements[pr_xstatement];
  if (st === undefined) {
    return;
  }

  let n;
  switch (st.op) {
    case 30: // OP_ADDRESS
    case 24: // OP_LOAD_F
    case 25: // OP_LOAD_V
    case 28: // OP_LOAD_FLD
    case 27: // OP_LOAD_ENT
    case 26: // OP_LOAD_S
    case 29: // OP_LOAD_FNC
      n = pr_globals_int[st.a];
      break;

    case 37: // OP_STOREP_F
    case 38: // OP_STOREP_V
    case 40: // OP_STOREP_ENT
    case 41: // OP_STOREP_FLD
    case 39: // OP_STOREP_S
    case 42: // OP_STOREP_FNC
      n = (pr_globals_int[st.b] >> 16) & 0xFFFF;
      break;

    case 60: // OP_STATE
      n = pr_global_struct.self;
      break;

    default:
      return;
  }

  if (sv.edicts[n] === undefined) {
    PR_RunError("bad edict number %i", n);
  }
}

function PR_ExecuteProgram_Loop(fnum) {
  let s;
  let runaway;

  if (fnum === 0 || fnum >= progs.numfunctions) {
    if (pr_global_struct.self !== 0) {
      ED_Print(PROG_TO_EDICT(pr_global_struct.self));
    }
    PR_HostError("PR_ExecuteProgram: NULL function");
  }

  const f = pr_functions[fnum];

  // Deliberate deviation from id (100000): Ironwail/QuakeSpasm's 0x1000000
  // statements before "runaway loop error", for mods with big loops
  runaway = 0x1000000;
  PR_SetTrace(false);

  // make a stack frame
  const exitdepth = pr_depth;

  s = PR_EnterFunction(f);

  // Cached references to typed views for performance
  const gf = pr_globals_float;
  const gi = pr_globals_int;
  const code = pr_code;
  let xf = pr_xfunction; // pr_xfunction, which only PR_EnterFunction and PR_LeaveFunction change

  // pr_xstatement is only read by PR_EnterFunction, PR_RunError, a builtin
  // and the catch below, so it is stored at those points, not per statement.
  try {
    while (true) {
      s++; // next statement

      const o = s << 2;
      const stA = code[o + 1];
      const stB = code[o + 2];
      const stC = code[o + 3];

      if (!--runaway) {
        PR_SetXStatement(s);
        PR_RunError("runaway loop error");
      }

      xf.profile++;

      if (pr_trace) {
        PR_SetXStatement(s);
        PR_PrintStatement(pr_statements[s]);
      }

      // The case labels are integer literals, not the OP_ constants, so V8
      // compiles the switch to a jump table. An imported constant is not a
      // literal to it and turns the switch into a chain of comparisons.
      // tests/pr_exec_ops_test.js checks each label against pr_comp.js.
      switch (code[o]) {
        case 6: // OP_ADD_F
          gf[stC] = gf[stA] + gf[stB];
          break;
        case 7: // OP_ADD_V
          gf[stC] = gf[stA] + gf[stB];
          gf[stC + 1] = gf[stA + 1] + gf[stB + 1];
          gf[stC + 2] = gf[stA + 2] + gf[stB + 2];
          break;

        case 8: // OP_SUB_F
          gf[stC] = gf[stA] - gf[stB];
          break;
        case 9: // OP_SUB_V
          gf[stC] = gf[stA] - gf[stB];
          gf[stC + 1] = gf[stA + 1] - gf[stB + 1];
          gf[stC + 2] = gf[stA + 2] - gf[stB + 2];
          break;

        case 1: // OP_MUL_F
          gf[stC] = gf[stA] * gf[stB];
          break;
        case 2: // OP_MUL_V
          gf[stC] = gf[stA] * gf[stB] +
            gf[stA + 1] * gf[stB + 1] +
            gf[stA + 2] * gf[stB + 2];
          break;
        case 3: // OP_MUL_FV
          gf[stC] = gf[stA] * gf[stB];
          gf[stC + 1] = gf[stA] * gf[stB + 1];
          gf[stC + 2] = gf[stA] * gf[stB + 2];
          break;
        case 4: // OP_MUL_VF
          gf[stC] = gf[stB] * gf[stA];
          gf[stC + 1] = gf[stB] * gf[stA + 1];
          gf[stC + 2] = gf[stB] * gf[stA + 2];
          break;

        case 5: // OP_DIV_F
          gf[stC] = gf[stA] / gf[stB];
          break;

        case 64: // OP_BITAND
          gf[stC] = (gf[stA] | 0) & (gf[stB] | 0);
          break;

        case 65: // OP_BITOR
          gf[stC] = (gf[stA] | 0) | (gf[stB] | 0);
          break;

        case 21: // OP_GE
          gf[stC] = gf[stA] >= gf[stB] ? 1 : 0;
          break;
        case 20: // OP_LE
          gf[stC] = gf[stA] <= gf[stB] ? 1 : 0;
          break;
        case 23: // OP_GT
          gf[stC] = gf[stA] > gf[stB] ? 1 : 0;
          break;
        case 22: // OP_LT
          gf[stC] = gf[stA] < gf[stB] ? 1 : 0;
          break;
        case 62: // OP_AND
          gf[stC] = (gf[stA] !== 0 && gf[stB] !== 0) ? 1 : 0;
          break;
        case 63: // OP_OR
          gf[stC] = (gf[stA] !== 0 || gf[stB] !== 0) ? 1 : 0;
          break;

        case 44: // OP_NOT_F
          gf[stC] = (gf[stA] === 0) ? 1 : 0;
          break;
        case 45: // OP_NOT_V
          gf[stC] = (gf[stA] === 0 && gf[stA + 1] === 0 && gf[stA + 2] === 0) ?
            1 :
            0;
          break;
        case 46: // OP_NOT_S
          gf[stC] = (gi[stA] === 0 || pr_strings_data[gi[stA]] === 0) ? 1 : 0;
          break;
        case 48: // OP_NOT_FNC
          gf[stC] = (gi[stA] === 0) ? 1 : 0;
          break;
        case 47: // OP_NOT_ENT
          gf[stC] = (gi[stA] === 0) ? 1 : 0;
          // C: (PROG_TO_EDICT(a->edict) == sv.edicts)
          // edict index 0 is the world entity
          break;

        case 10: // OP_EQ_F
          gf[stC] = (gf[stA] === gf[stB]) ? 1 : 0;
          break;
        case 11: // OP_EQ_V
          gf[stC] = (gf[stA] === gf[stB] &&
              gf[stA + 1] === gf[stB + 1] &&
              gf[stA + 2] === gf[stB + 2]) ?
            1 :
            0;
          break;
        case 12: // OP_EQ_S
          gf[stC] = PR_strcmp_ofs(gi[stA], gi[stB]) === 0 ? 1 : 0;
          break;
        case 13: // OP_EQ_E
          gf[stC] = (gi[stA] === gi[stB]) ? 1 : 0;
          break;
        case 14: // OP_EQ_FNC
          gf[stC] = (gi[stA] === gi[stB]) ? 1 : 0;
          break;

        case 15: // OP_NE_F
          gf[stC] = (gf[stA] !== gf[stB]) ? 1 : 0;
          break;
        case 16: // OP_NE_V
          gf[stC] = (gf[stA] !== gf[stB] ||
              gf[stA + 1] !== gf[stB + 1] ||
              gf[stA + 2] !== gf[stB + 2]) ?
            1 :
            0;
          break;
        case 17: // OP_NE_S
          // C stores strcmp()'s raw result here, not a boolean
          gf[stC] = PR_strcmp_ofs(gi[stA], gi[stB]);
          break;
        case 18: // OP_NE_E
          gf[stC] = (gi[stA] !== gi[stB]) ? 1 : 0;
          break;
        case 19: // OP_NE_FNC
          gf[stC] = (gi[stA] !== gi[stB]) ? 1 : 0;
          break;

        //==================
        case 31: // OP_STORE_F
        case 34: // OP_STORE_ENT
        case 35: // OP_STORE_FLD integers
        case 33: // OP_STORE_S
        case 36: // OP_STORE_FNC pointers
          gi[stB] = gi[stA];
          break;
        case 32: // OP_STORE_V
          gi[stB] = gi[stA];
          gi[stB + 1] = gi[stA + 1];
          gi[stB + 2] = gi[stA + 2];
          break;

        case 37: // OP_STOREP_F
        case 40: // OP_STOREP_ENT
        case 41: // OP_STOREP_FLD integers
        case 39: // OP_STOREP_S
        case 42: { // OP_STOREP_FNC pointers
          // b->_int is an edict index + field offset encoded
          // In C: ptr = (eval_t *)((byte *)sv.edicts + b->_int);
          // In JS: we encode as { edictIndex, fieldOfs }
          const addr = gi[stB];
          const edictIndex = (addr >> 16) & 0xFFFF;
          const fieldOfs = addr & 0xFFFF;
          sv.edicts[edictIndex]._intView[fieldOfs] = gi[stA];
          break;
        }

        case 38: { // OP_STOREP_V
          const addr = gi[stB];
          const edictIndex = (addr >> 16) & 0xFFFF;
          const fieldOfs = addr & 0xFFFF;
          const iv = sv.edicts[edictIndex]._intView;
          iv[fieldOfs] = gi[stA];
          iv[fieldOfs + 1] = gi[stA + 1];
          iv[fieldOfs + 2] = gi[stA + 2];
          break;
        }

        case 30: { // OP_ADDRESS
          const ed = PROG_TO_EDICT(gi[stA]);
          if (ed === sv.edicts[0] && sv.state === ss_active) {
            PR_SetXStatement(s);
            PR_RunError("assignment to world entity");
          }

          // Encode edict index and field offset into a single int
          // b->_int is the field offset within the edict
          gi[stC] = (ed.index << 16) | (gi[stB] & 0xFFFF);
          break;
        }

        case 24: // OP_LOAD_F
        case 28: // OP_LOAD_FLD
        case 27: // OP_LOAD_ENT
        case 26: // OP_LOAD_S
        case 29: { // OP_LOAD_FNC
          let ed = sv.edicts[gi[stA]];
          if (ed === undefined) ed = PROG_TO_EDICT(gi[stA]);
          gi[stC] = ed._intView[gi[stB]];
          break;
        }

        case 25: { // OP_LOAD_V
          let ed = sv.edicts[gi[stA]];
          if (ed === undefined) ed = PROG_TO_EDICT(gi[stA]);
          const fieldOfs = gi[stB];
          const fv = ed._floatView;
          gf[stC] = fv[fieldOfs];
          gf[stC + 1] = fv[fieldOfs + 1];
          gf[stC + 2] = fv[fieldOfs + 2];
          break;
        }

        //==================

        case 50: // OP_IFNOT
          if (gi[stA] === 0) {
            s += stB - 1; // offset the s++
          }
          break;

        case 49: // OP_IF
          if (gi[stA] !== 0) {
            s += stB - 1; // offset the s++
          }
          break;

        case 61: // OP_GOTO
          s += stA - 1; // offset the s++
          break;

        case 51: // OP_CALL0
        case 52: // OP_CALL1
        case 53: // OP_CALL2
        case 54: // OP_CALL3
        case 55: // OP_CALL4
        case 56: // OP_CALL5
        case 57: // OP_CALL6
        case 58: // OP_CALL7
        case 59: { // OP_CALL8
          PR_SetXStatement(s);
          PR_SetArgc(code[o] - OP_CALL0);

          if (!gi[stA]) {
            PR_RunError("NULL function");
          }

          const newf = pr_functions[gi[stA]];

          if (newf.first_statement < 0) {
            // negative statements are built in functions
            const i = -newf.first_statement;
            if (i >= pr_numbuiltins) {
              PR_RunError("Bad builtin call number");
            }
            pr_builtins[i]();
            break;
          }

          s = PR_EnterFunction(newf);
          xf = pr_xfunction;
          break;
        }

        case 0: // OP_DONE
        case 43: // OP_RETURN
          gi[OFS_RETURN] = gi[stA];
          gi[OFS_RETURN + 1] = gi[stA + 1];
          gi[OFS_RETURN + 2] = gi[stA + 2];

          s = PR_LeaveFunction();
          if (pr_depth === exitdepth) {
            return; // all done
          }
          xf = pr_xfunction;
          break;

        case 60: { // OP_STATE
          const ed = PROG_TO_EDICT(pr_global_struct.self);
          ed.v.nextthink = pr_global_struct.time + 0.1;
          if (gf[stA] !== ed.v.frame) {
            ed.v.frame = gf[stA];
          }

          ed.v.think = gi[stB];
          break;
        }

        default:
          PR_SetXStatement(s);
          PR_RunError("Bad opcode %i", code[o]);
      }
    }
  } catch (e) {
    // the statement that threw is s, whatever pr_xstatement last held
    PR_SetXStatement(s);
    if (e instanceof TypeError) {
      PR_CheckBadEdict();
    }
    throw e;
  }
}
