// Port-review fixes in the server engine: SP-5, SP-9, MOD-1, MOD-2, MOD-3, MOD-4

import {
  ClearLink,
  cmdline,
  COM_Init,
  COM_InitArgv,
  com_modified,
  COM_SetModified,
  InsertLinkBefore,
  link_t,
  registered,
} from "../src/common.js";
import { COM_AddPack, COM_LoadPackFile } from "../src/pak.js";
import { GD_PAK_PATH } from "../server/game_data.js";
import { CRC_Init, CRC_ProcessByte } from "../src/crc.js";
import { OFS_PARM0, OFS_PARM1, OFS_PARM2, OFS_RETURN } from "../src/pr_comp.js";
import {
  pr_builtins,
  PR_GetString,
  pr_globals_int,
  PR_SetGlobalsInt,
  PR_SetStringsData,
  PR_SetSV,
  pr_strings_data,
  pr_strings_size,
  sv as progs_sv,
} from "../src/progs.js";
import { PF_Format5_1f, PR_InitBuiltins } from "../src/pr_cmds.js";
import { ED_Free, ED_NewString, PR_AllocEdicts } from "../src/pr_edict.js";
import { PR_strcmp } from "../src/pr_exec.js";
import { host_frametime as sv_phys_frametime } from "../src/sv_phys.js";
import { set_host_frametime } from "../src/host.js";

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${
        JSON.stringify(actual)
      }`,
    );
  }
}

Deno.test("SP-5: set_host_frametime reaches the physics time step", () => {
  set_host_frametime(0.1);
  assertEqual(sv_phys_frametime, 0.1, "sv_phys host_frametime");
  set_host_frametime(0);
});

Deno.test("SP-9: ED_Free unlinks the edict from the area node list", () => {
  const oldSV = progs_sv;
  const edicts = PR_AllocEdicts(4, 105);
  const head = new link_t();
  ClearLink(head);

  try {
    PR_SetSV({ time: 5, num_edicts: 4, max_edicts: 4, edicts });
    InsertLinkBefore(edicts[2].area, head);
    assertEqual(head.next, edicts[2].area, "linked before free");

    ED_Free(edicts[2]);

    assertEqual(head.next, head, "list empty after free");
    assertEqual(edicts[2].free, true, "edict freed");
    ED_Free(edicts[3]); // never linked: must not throw
  } finally {
    PR_SetSV(oldSV);
  }
});

Deno.test("MOD-1: find() with an empty string matches an empty field", () => {
  const oldSV = progs_sv;
  const oldStrings = pr_strings_data;
  const oldGlobals = pr_globals_int;
  const field = 100;
  const edicts = PR_AllocEdicts(4, 105);

  try {
    PR_InitBuiltins();
    PR_SetSV({ time: 0, num_edicts: 4, max_edicts: 4, edicts });
    PR_SetStringsData(new TextEncoder().encode("\0targ\0"));
    PR_SetGlobalsInt(new Int32Array(32));
    edicts[1]._fieldAccessor.setInt32(field, 1); // "targ"
    edicts[2]._fieldAccessor.setInt32(field, 0); // ""

    pr_globals_int[OFS_PARM0] = 0; // world
    pr_globals_int[OFS_PARM1] = field;
    pr_globals_int[OFS_PARM2] = 0; // ""
    pr_builtins[18](); // PF_Find
    assertEqual(pr_globals_int[OFS_RETURN], 2, "empty search");

    pr_globals_int[OFS_PARM2] = 1; // "targ"
    pr_builtins[18]();
    assertEqual(pr_globals_int[OFS_RETURN], 1, "named search");
  } finally {
    PR_SetSV(oldSV);
    PR_SetStringsData(oldStrings);
    PR_SetGlobalsInt(oldGlobals);
  }
});

Deno.test("MOD-3: ED_NewString keeps bytes >= 0x80 as single bytes", () => {
  const oldStrings = pr_strings_data;

  try {
    PR_SetStringsData(new Uint8Array([0]));
    const gold = "\xc7\xef\xec\xe4\\nx";
    const ofs = ED_NewString(gold);
    assertEqual(PR_GetString(ofs), "\xc7\xef\xec\xe4\nx", "round trip");
    assertEqual(pr_strings_size, 1 + 6 + 1, "one byte per character");
  } finally {
    PR_SetStringsData(oldStrings);
  }
});

Deno.test("ED_NewString grows the string table geometrically and keeps earlier offsets", () => {
  const oldStrings = pr_strings_data;

  try {
    PR_SetStringsData(new Uint8Array([0, 0x41, 0]));
    const offsets = [];
    let reallocations = 0;
    let buffer = pr_strings_data;
    for (let i = 0; i < 1000; i++) {
      offsets.push(ED_NewString("str" + i));
      if (pr_strings_data !== buffer) {
        reallocations++;
        buffer = pr_strings_data;
      }
    }

    assertEqual(PR_GetString(1), "A", "original strings survive growth");
    for (let i = 0; i < offsets.length; i++) {
      assertEqual(PR_GetString(offsets[i]), "str" + i, "string " + i);
    }
    assertEqual(
      offsets[1],
      offsets[0] + "str0".length + 1,
      "strings are packed",
    );
    assertEqual(
      reallocations <= 14,
      true,
      "reallocations are logarithmic, got " + reallocations,
    );
    assertEqual(
      PR_GetString(pr_strings_size),
      "",
      "spare capacity reads as empty",
    );
  } finally {
    PR_SetStringsData(oldStrings);
  }
});

Deno.test("MOD-4: ftos/vtos padding and OP_NE_S strcmp", () => {
  assertEqual(PF_Format5_1f(1.5), "  1.5", "%5.1f pads");
  assertEqual(PF_Format5_1f(-12.34), "-12.3", "%5.1f negative");
  assertEqual(PF_Format5_1f(12345.5), "12345.5", "%5.1f wider than field");
  assertEqual(PR_strcmp("a", "a"), 0, "equal");
  assertEqual(PR_strcmp("a", "b"), -1, "less");
  assertEqual(PR_strcmp("b", "a"), 1, "greater");
  assertEqual(PR_strcmp("ab", "a"), 1, "longer");
  assertEqual(PR_strcmp("", "a"), -1, "empty");
});

Deno.test("MOD-2: COM_CheckRegistered sets registered from gfx/pop.lmp", () => {
  // big-endian dump of the pop[] table from common.c, as stored in pak1
  // A table kept in rows: deno fmt would give each entry its own line
  // deno-fmt-ignore
  const popShorts = [
		0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000,
		0x0000, 0x0000, 0x6600, 0x0000, 0x0000, 0x0000, 0x6600, 0x0000,
		0x0000, 0x0066, 0x0000, 0x0000, 0x0000, 0x0000, 0x0067, 0x0000,
		0x0000, 0x6665, 0x0000, 0x0000, 0x0000, 0x0000, 0x0065, 0x6600,
		0x0063, 0x6561, 0x0000, 0x0000, 0x0000, 0x0000, 0x0061, 0x6563,
		0x0064, 0x6561, 0x0000, 0x0000, 0x0000, 0x0000, 0x0061, 0x6564,
		0x0064, 0x6564, 0x0000, 0x6469, 0x6969, 0x6400, 0x0064, 0x6564,
		0x0063, 0x6568, 0x6200, 0x0064, 0x6864, 0x0000, 0x6268, 0x6563,
		0x0000, 0x6567, 0x6963, 0x0064, 0x6764, 0x0063, 0x6967, 0x6500,
		0x0000, 0x6266, 0x6769, 0x6a68, 0x6768, 0x6a69, 0x6766, 0x6200,
		0x0000, 0x0062, 0x6566, 0x6666, 0x6666, 0x6666, 0x6562, 0x0000,
		0x0000, 0x0000, 0x0062, 0x6364, 0x6664, 0x6362, 0x0000, 0x0000,
		0x0000, 0x0000, 0x0000, 0x0062, 0x6662, 0x0000, 0x0000, 0x0000,
		0x0000, 0x0000, 0x0000, 0x0061, 0x6661, 0x0000, 0x0000, 0x0000,
		0x0000, 0x0000, 0x0000, 0x0000, 0x6500, 0x0000, 0x0000, 0x0000,
		0x0000, 0x0000, 0x0000, 0x0000, 0x6400, 0x0000, 0x0000, 0x0000
	];
  const data = new Uint8Array(256);
  for (let i = 0; i < 128; i++) {
    data[2 * i] = popShorts[i] >> 8;
    data[2 * i + 1] = popShorts[i] & 0xff;
  }

  const pack = { files: [], data: data.buffer };

  try {
    COM_Init(); // shareware: no pop.lmp
    assertEqual(registered.value, 0, "shareware");

    COM_AddPack(pack);
    pack.files = [{ name: "gfx/pop.lmp", filepos: 0, filelen: 256 }];
    COM_InitArgv(["quake", "-game", "x"]);
    COM_Init();
    assertEqual(registered.value, 1, "registered");
    assertEqual(cmdline.string, "quake -game x ", "cmdline cvar");

    data[21] ^= 1;
    let threw = false;
    try {
      COM_Init();
    } catch (_e) {
      threw = true;
    }

    assertEqual(threw, true, "corrupted pop.lmp is a Sys_Error");
  } finally {
    pack.files = [];
    COM_InitArgv([]);
  }
});

Deno.test("MOD-2: a modified pak is a Sys_Error on shareware (common.c com_modified)", () => {
  try {
    COM_SetModified(false);
    COM_Init(); // shareware (no gfx/pop.lmp), unmodified: fine

    // any pak that isn't the id1 pak0.pak sets com_modified
    const buf = new ArrayBuffer(12 + 64);
    const view = new DataView(buf);
    view.setUint32(0, 0x5041434b); // "PACK"
    view.setInt32(4, 12, true);
    view.setInt32(8, 64, true);
    COM_LoadPackFile("mod.pak", buf);
    assertEqual(com_modified, true, "mod pak sets com_modified");

    let threw = false;
    try {
      COM_Init();
    } catch (_e) {
      threw = true;
    }

    assertEqual(threw, true, "shareware + modified is a Sys_Error");
  } finally {
    COM_SetModified(false);
  }
});

// id1's pak0.pak isn't in the repository, so build a directory with its file
// count and directory CRC (pak.js PAK0_COUNT 339 and PAK0_CRC 32981, from
// common.c). Two name bytes of the last entry are chosen to reach the CRC;
// the names are otherwise empty. A player's own id1 pak0 must not count as
// modified, or the registered check refuses it.
Deno.test("MOD-2: a pak with id1 pak0's directory is not modified", () => {
  const count = 339;
  const dirlen = count * 64;
  const buf = new Uint8Array(12 + dirlen);
  const view = new DataView(buf.buffer);
  buf.set([0x50, 0x41, 0x43, 0x4b], 0); // "PACK"
  view.setInt32(4, 12, true);
  view.setInt32(8, dirlen, true);
  const at = buf.length - 64 + 54; // the last entry's name bytes 54 and 55
  let prefix = CRC_Init();
  for (let i = 12; i < at; i++) prefix = CRC_ProcessByte(prefix, buf[i]);
  let found = false;
  for (let v = 0; v < 65536 && found === false; v++) {
    let crc = CRC_ProcessByte(CRC_ProcessByte(prefix, v >> 8), v & 255);
    for (let i = at + 2; i < buf.length; i++) {
      crc = CRC_ProcessByte(crc, buf[i]);
    }
    if (crc === 32981) {
      buf[at] = v >> 8;
      buf[at + 1] = v & 255;
      found = true;
    }
  }
  assertEqual(found, true, "a directory with the CRC exists");
  COM_SetModified(false);
  try {
    COM_LoadPackFile("pak0.pak", buf.buffer);
    assertEqual(com_modified, false, "pak0.pak count and directory CRC");
  } finally {
    COM_SetModified(false);
  }
});

// The repository has no id1 pak, so the pak0 count and directory CRC check
// is shown from the other side: the data's pak0.pak (LibreQuake) has its
// own directory, so it counts as modified, as in Quake.
Deno.test("MOD-2: LibreQuake's pak0.pak is not id1's (com_modified)", () => {
  COM_SetModified(false);
  try {
    COM_LoadPackFile("pak0.pak", Deno.readFileSync(GD_PAK_PATH).buffer);
    assertEqual(com_modified, true, "pak0.pak count and directory CRC");
  } finally {
    COM_SetModified(false);
  }
});
