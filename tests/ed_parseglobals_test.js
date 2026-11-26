// ED_ParseGlobals returns the text after the globals block (Ironwail), so
// Host_Loadgame_f can go on to parse the edicts from there.

import * as common from "../src/common.js";
import { ED_ParseGlobals } from "../src/pr_edict.js";
import { PR_SetHostError, PR_SetProgs, progs } from "../src/progs.js";

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${
        JSON.stringify(actual)
      }`,
    );
  }
}

Deno.test("ED_ParseGlobals returns the text after the closing brace", () => {
  const printed = [];
  const oldProgs = progs;
  common.Con_SetPrintFunctions(
    (fmt, ...args) => printed.push(fmt.replace("%s", String(args[0]))),
    () => {},
  );
  try {
    // no global defs: every key is reported and skipped
    PR_SetProgs({ numglobaldefs: 0 });
    const rest = ED_ParseGlobals('"a" "1"\n"b" "x } y"\n}\n{ "c" "d" }');
    assertEqual(rest.trim(), '{ "c" "d" }', "rest");
    assertEqual(
      printed.join(""),
      "'a' is not a global\n'b' is not a global\n",
      "unknown keys",
    );
  } finally {
    PR_SetProgs(oldProgs);
    common.Con_SetPrintFunctions(null, null);
  }
});

Deno.test("ED_ParseGlobals raises a Host_Error on EOF or a } in the value position", () => {
  const oldProgs = progs;
  const errors = [];
  const oldHostError = PR_SetHostError((message) => {
    errors.push(message);
    throw new Error("host error");
  });
  common.Con_SetPrintFunctions(() => {}, () => {});
  try {
    PR_SetProgs({ numglobaldefs: 0 });
    for (const text of ['"a" "1"\n', '"a"\n', '"a" }\n']) {
      let threw = false;
      try {
        ED_ParseGlobals(text);
      } catch (_e) {
        threw = true;
      }

      assertEqual(threw, true, `threw for ${JSON.stringify(text)}`);
    }

    assertEqual(
      errors.join("|"),
      "ED_ParseEntity: EOF without closing brace|ED_ParseEntity: EOF without closing brace|ED_ParseEntity: closing brace without data",
      "errors",
    );
  } finally {
    PR_SetHostError(oldHostError);
    PR_SetProgs(oldProgs);
    common.Con_SetPrintFunctions(null, null);
  }
});
