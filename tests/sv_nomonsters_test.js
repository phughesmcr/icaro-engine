// The nomonsters cvar (Ironwail): latched into sv.nomonsters when a map
// spawns, and ED_LoadFromFile then frees every monster_* entity as inhibited.

import * as common from "../src/common.js";
import { ev_string, OFS_RETURN, OP_DONE } from "../src/pr_comp.js";
import {
  ED_LoadFromFile,
  nomonsters,
  PR_AllocEdicts,
} from "../src/pr_edict.js";
import {
  pr_fielddefs,
  pr_functions,
  pr_global_struct,
  pr_globals_float,
  pr_globals_int,
  PR_SetFieldDefs,
  PR_SetFunctions,
  PR_SetGlobalsFloat,
  PR_SetGlobalsInt,
  PR_SetGlobalStruct,
  PR_SetProgs,
  PR_SetStatements,
  PR_SetStringsData,
  PR_SetSV,
  PR_SetSVS,
  pr_statements,
  pr_strings_data,
  progs,
  sv as progs_sv,
  svs as progs_svs,
} from "../src/progs.js";
import { sv, svs } from "../src/server.js";

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${
        JSON.stringify(actual)
      }`,
    );
  }
}

const dprinted = [];
common.Con_SetPrintFunctions(
  () => {},
  (fmt, ...args) => dprinted.push(fmt.replace("%i", String(args[0]))),
);

const ENTITIES = `
{ "classname" "worldspawn" }
{ "classname" "monster_army" }
{ "classname" "info_player_start" }
{ "classname" "monster_dog" }
`;

// Loads ENTITIES into a stub progs whose spawn functions do nothing, and
// returns the classnames of the edicts that survived
function loadEntities(nomonstersSet) {
  const saved = {
    progs,
    pr_fielddefs,
    pr_functions,
    pr_global_struct,
    pr_globals_float,
    pr_globals_int,
    pr_statements,
    pr_strings_data,
    progs_sv,
    progs_svs,
    svFields: Object.assign({}, sv),
    maxclients: svs.maxclients,
  };

  const names = [
    "",
    "classname",
    "worldspawn",
    "monster_army",
    "info_player_start",
    "monster_dog",
  ];
  const ofs = {};
  let text = "";
  for (const name of names) {
    ofs[name] = text.length;
    text += name + "\0";
  }

  try {
    PR_SetStringsData(new TextEncoder().encode(text));
    const buffer = new ArrayBuffer(64 * 4);
    PR_SetGlobalsFloat(new Float32Array(buffer));
    PR_SetGlobalsInt(new Int32Array(buffer));
    PR_SetGlobalStruct({ self: 0, other: 0, time: 0 });
    PR_SetFieldDefs([{ type: ev_string, ofs: 28, s_name: ofs.classname }]);
    const spawnFunctions = [
      "worldspawn",
      "monster_army",
      "info_player_start",
      "monster_dog",
    ];
    PR_SetFunctions(
      [{ first_statement: 0, s_name: 0 }].concat(spawnFunctions.map((name) => ({
        first_statement: 0,
        parm_start: 0,
        locals: 0,
        profile: 0,
        s_name: ofs[name],
        numparms: 0,
        parm_size: [],
      }))),
    );
    PR_SetStatements([{ op: OP_DONE, a: OFS_RETURN, b: 0, c: 0 }]);
    PR_SetProgs({ numfielddefs: 1, numfunctions: 1 + spawnFunctions.length });

    svs.maxclients = 1;
    sv.edicts = PR_AllocEdicts(16, 105);
    sv.num_edicts = 2;
    sv.max_edicts = 16;
    sv.time = 1;
    sv.nomonsters = nomonstersSet;
    // ED_LoadFromFile reserves signon space before each spawn function
    const signon = new common.sizebuf_t();
    common.SZ_Alloc(signon, 4000);
    sv.signon = signon;
    sv.signon_buffers = [signon];
    sv.num_signon_buffers = 1;
    PR_SetSV(sv);
    PR_SetSVS(svs);

    dprinted.length = 0;
    ED_LoadFromFile(ENTITIES);

    const alive = [];
    for (let i = 0; i < sv.num_edicts; i++) {
      if (i === 1 || sv.edicts[i].free) {
        continue;
      }
      alive.push(
        new TextDecoder().decode(
          pr_strings_data.subarray(sv.edicts[i].v.classname),
        ).split("\0")[0],
      );
    }

    return alive.join(" ");
  } finally {
    PR_SetProgs(saved.progs);
    PR_SetFieldDefs(saved.pr_fielddefs);
    PR_SetFunctions(saved.pr_functions);
    PR_SetGlobalStruct(saved.pr_global_struct);
    PR_SetGlobalsFloat(saved.pr_globals_float);
    PR_SetGlobalsInt(saved.pr_globals_int);
    PR_SetStatements(saved.pr_statements);
    PR_SetStringsData(saved.pr_strings_data);
    Object.assign(sv, saved.svFields);
    PR_SetSV(saved.progs_sv);
    PR_SetSVS(saved.progs_svs);
    svs.maxclients = saved.maxclients;
  }
}

Deno.test("nomonsters is registered and defaults to 0 (id behaviour)", () => {
  assertEqual(nomonsters.name, "nomonsters", "cvar name");
  assertEqual(nomonsters.string, "0", "default");
});

Deno.test("ED_LoadFromFile spawns monsters when sv.nomonsters is off", () => {
  assertEqual(
    loadEntities(false),
    "worldspawn monster_army info_player_start monster_dog",
    "all spawned",
  );
  assertEqual(
    dprinted.some((m) => m.includes("0 entities inhibited")),
    true,
    "none inhibited",
  );
});

Deno.test("ED_LoadFromFile frees monster_* entities as inhibited when sv.nomonsters is on", () => {
  assertEqual(
    loadEntities(true),
    "worldspawn info_player_start",
    "monsters removed",
  );
  assertEqual(
    dprinted.some((m) => m.includes("2 entities inhibited")),
    true,
    "monsters counted as inhibited",
  );
});
