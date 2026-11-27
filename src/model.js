// Ported from: WinQuake/gl_model.c (the model cache: Mod_Init, Mod_ClearAll,
// Mod_FindName, Mod_LoadModel, Mod_ForName, the PVS helpers, Mod_Print)
// models.c -- model loading and caching
// models are the only shared resource between a client and server running
// on the same machine.
// Split out of gl_model.js, which re-exports it. The loaders live in
// mod_brush.js, mod_alias.js and mod_sprite.js; texture and GPU work in
// gl_model_upload.js.

import {
  IDPOLYHEADER,
  IDSPRITEHEADER,
  mod_alias,
  mod_brush,
  mod_sprite,
  model_t,
  r_lavaalpha,
  r_slimealpha,
  r_telealpha,
} from "./mod_types.js";
import { Sys_Error } from "./sys.js";
import { Host_Error } from "./host.js";
import { Con_Printf } from "./common.js";
import { COM_LoadFile } from "./pak.js";
import { Cvar_RegisterVariable } from "./cvar.js";
import { cl_gun_fovscale } from "./gl_mesh.js";
import { gl_subdivide_size, GL_UnregisterTexture } from "./glquake.js";
import { Mod_LoadBrushModel } from "./mod_brush.js";
import { Mod_LoadAliasModel, r_enhancedmodels } from "./mod_alias.js";
import { Mod_LoadSpriteModel } from "./mod_sprite.js";
import { gl_texture_anisotropy, set_skytextures } from "./gl_model_upload.js";

// Module-level state (mirrors C globals)

export let loadmodel = null;

/** Sets loadmodel; the loaders (mod_brush.js, mod_alias.js) switch it. */
export function set_loadmodel(m) {
  loadmodel = m;
}

// Deliberate deviation (QuakeSpasm Mod_NoVisPVS / Mod_DecompressVis): the C
// sizes both PVS rows at MAX_MAP_LEAFS/8. Here they grow to fit the loaded
// model's leaf count in Mod_LoadLeafs (Mod_AllocVisBuffers), never per frame.
let mod_novis = new Uint8Array(0);

// Deliberate deviation: 2048 (id: 512; Ironwail's is 4096). mg3/secret2 alone has
// 525 brush submodels. Only the first 512 are allocated up front; Mod_FindName
// adds the rest on demand.
const MAX_MOD_KNOWN = 2048;
const mod_known = [];
let mod_numknown = 0;

// Initialize mod_known array
for (let i = 0; i < 512; i++) {
  mod_known[i] = new model_t();
}

// Decompressed visibility buffer (reused; sized by Mod_AllocVisBuffers)
let decompressed = new Uint8Array(0);

// Mod_Init

export function Mod_Init() {
  Cvar_RegisterVariable(gl_subdivide_size);
  Cvar_RegisterVariable(cl_gun_fovscale); // Ironwail: SCR_Init
  Cvar_RegisterVariable(gl_texture_anisotropy);
  Cvar_RegisterVariable(r_lavaalpha);
  Cvar_RegisterVariable(r_slimealpha);
  Cvar_RegisterVariable(r_telealpha);
  Cvar_RegisterVariable(r_enhancedmodels);
  mod_novis.fill(0xff);
}

// Mod_AllocVisBuffers
//
// Grows mod_novis and decompressed to hold one PVS row for numleafs leafs.
// The rows only grow, so a row handed out for an earlier model stays valid
// in length. Called at load time from Mod_LoadLeafs.

export function Mod_AllocVisBuffers(numleafs) {
  const row = (numleafs + 7) >> 3;
  if (row > decompressed.length) {
    decompressed = new Uint8Array(row);
  }
  if (row > mod_novis.length) {
    mod_novis = new Uint8Array(row);
    mod_novis.fill(0xff);
  }
}

// Mod_Extradata
//
// Caches the data if needed

export function Mod_Extradata(mod) {
  const r = mod.cache.data;
  if (r) {
    return r;
  }

  Mod_LoadModel(mod, true);

  if (!mod.cache.data) {
    Sys_Error("Mod_Extradata: caching failed");
  }
  return mod.cache.data;
}

// Mod_PointInLeaf

export function Mod_PointInLeaf(p, model) {
  if (!model || !model.nodes) {
    Sys_Error("Mod_PointInLeaf: bad model");
  }

  let node = model.nodes[0];

  while (true) {
    if (node.contents < 0) {
      // This is actually a leaf
      // In C: return (mleaf_t *)node
      // In JS: nodes and leafs are separate arrays, so leafs
      // are pointed to via children as negative indices
      return node;
    }

    const plane = node.plane;
    const n = plane.normal;
    const d = p[0] * n[0] + p[1] * n[1] + p[2] * n[2] - plane.dist;
    if (d > 0) {
      node = node.children[0];
    } else {
      node = node.children[1];
    }
  }
}

// Mod_DecompressVis
//
// numleafs sizes the row. It defaults to model.numleafs as in the C;
// Mod_CheckWaterVis passes the visleafs count (see there).

export function Mod_DecompressVis(
  _in,
  inOffset,
  model,
  numleafs = model.numleafs,
) {
  const row = (numleafs + 7) >> 3;
  let outIdx = 0;

  if (row > decompressed.length) {
    Mod_AllocVisBuffers(numleafs); // model built without Mod_LoadLeafs
  }

  if (_in === null) {
    // no vis info, so make all visible
    for (let i = 0; i < row; i++) {
      decompressed[i] = 0xff;
    }
    return decompressed;
  }

  let pos = inOffset;
  const inend = _in.length;

  while (outIdx < row) {
    // Deliberate deviation: C reads on past the end of the vis lump. A
    // typed array returns undefined there and this loop never advanced,
    // so truncated vis data hung the client and server. Stop at the end
    // of the data and leave the rest of the row not visible.
    if (pos >= inend) {
      if (model.viswarn !== true) {
        model.viswarn = true;
        Con_Printf(
          'Mod_DecompressVis: input underrun on model "' + model.name + '"\n',
        );
      }

      decompressed.fill(0, outIdx, row);
      break;
    }

    if (_in[pos]) {
      decompressed[outIdx] = _in[pos];
      outIdx++;
      pos++;
      continue;
    }

    // a zero run past the end of the data counts as an empty run
    let c = pos + 1 < inend ? _in[pos + 1] : 0;
    pos += 2;

    // QuakeSpasm clamps a run past the end of the row so it can't write
    // past the buffer. Deliberate deviation: QuakeSpasm and Ironwail
    // clamp silently (their overrun warning can't be reached after the
    // clamp); the port warns once, as the vis data is bad.
    if (c > row - outIdx) {
      if (model.viswarn !== true) {
        model.viswarn = true;
        Con_Printf(
          'Mod_DecompressVis: output overrun on model "' + model.name + '"\n',
        );
      }

      c = row - outIdx;
    }

    for (let j = 0; j < c; j++) {
      decompressed[outIdx] = 0;
      outIdx++;
    }
  }

  return decompressed;
}

// Mod_LeafPVS

export function Mod_LeafPVS(leaf, model) {
  if (leaf === model.leafs[0]) {
    if (((model.numleafs + 7) >> 3) > mod_novis.length) {
      Mod_AllocVisBuffers(model.numleafs); // model built without Mod_LoadLeafs
    }
    return mod_novis;
  }
  return Mod_DecompressVis(
    leaf.compressed_vis,
    leaf.compressed_vis_offset,
    model,
  );
}

// Mod_ClearAll

export function Mod_ClearAll() {
  const disposedTextures = new Set();
  for (let i = 0; i < mod_numknown; i++) {
    const mod = mod_known[i];
    if (mod.type === mod_alias) continue;

    for (const texture of mod._threeTextures) {
      GL_UnregisterTexture(texture);
      if (disposedTextures.has(texture) === false) {
        disposedTextures.add(texture);
        texture.dispose();
      }
    }
    mod._threeTextures.clear();

    if (mod.type === mod_brush && mod.textures != null) {
      for (let j = 0; j < mod.textures.length; j++) {
        const modelTexture = mod.textures[j];
        if (modelTexture == null || modelTexture.gl_texture == null) continue;
        modelTexture.gl_texture._fullbright = null;
        modelTexture.gl_texture = null;
      }
    } else if (mod.type === mod_sprite) {
      mod.cache.data = null;
    }

    mod.needload = true;
  }

  set_skytextures(null, null);
}

// Mod_FindName

export function Mod_FindName(name) {
  if (!name || name.length === 0) {
    Sys_Error("Mod_ForName: NULL name");
  }

  // search the currently loaded models
  let i;
  for (i = 0; i < mod_numknown; i++) {
    if (mod_known[i].name === name) {
      break;
    }
  }

  if (i === mod_numknown) {
    if (mod_numknown === MAX_MOD_KNOWN) {
      Sys_Error("mod_numknown == MAX_MOD_KNOWN");
    }
    if (i === mod_known.length) {
      mod_known.push(new model_t());
    }
    mod_known[i].name = name;
    mod_known[i].needload = true;
    mod_numknown++;
  }

  return mod_known[i];
}

// Mod_TouchModel

export function Mod_TouchModel(name) {
  const mod = Mod_FindName(name);

  if (!mod.needload) {
    if (mod.type === mod_alias) {
      // Cache_Check equivalent - just check if data exists
      // (JS has GC, so we just check the reference)
    }
  }
}

// Mod_LoadModel
//
// Loads a model into the cache

export function Mod_LoadModel(mod, crash) {
  if (!mod.needload) {
    if (mod.type === mod_alias) {
      const d = mod.cache.data;
      if (d) {
        return mod;
      }
    } else {
      return mod; // not cached at all
    }
  }

  // load the file
  const buf = COM_LoadFile(mod.name);
  if (!buf) {
    // Deliberate deviation (QuakeSpasm/Ironwail): Host_Error, not
    // Sys_Error, so a missing model (QuakeC precache_model, a bolt
    // model absent from the pak) drops to the console instead of
    // wiping the page or killing the room's game server.
    if (crash) {
      Host_Error("Mod_LoadModel: " + mod.name + " not found");
    }
    return null;
  }

  // allocate a new model

  loadmodel = mod;

  // fill it in

  // call the appropriate loader
  mod.needload = false;

  const view = new DataView(buf);
  const magic = view.getInt32(0, true);

  if (magic === IDPOLYHEADER) {
    Mod_LoadAliasModel(mod, buf);
  } else if (magic === IDSPRITEHEADER) {
    Mod_LoadSpriteModel(mod, buf);
  } else {
    Mod_LoadBrushModel(mod, buf);
  }

  return mod;
}

// Mod_ForName
//
// Loads in a model for the given name

export function Mod_ForName(name, crash) {
  const mod = Mod_FindName(name);

  return Mod_LoadModel(mod, crash);
}

// Helper: read a null-terminated string from Uint8Array

export function readString(bytes, offset, maxLen) {
  let s = "";
  for (let i = 0; i < maxLen; i++) {
    const c = bytes[offset + i];
    if (c === 0) break;
    s += String.fromCharCode(c);
  }

  return s;
}

// Mod_Print

export function Mod_Print() {
  Con_Printf("Cached models:\n");
  for (let i = 0; i < mod_numknown; i++) {
    const mod = mod_known[i];
    Con_Printf(
      "  " + (mod.cache.data ? "[cached]" : "[empty]") + " : " + mod.name +
        "\n",
    );
  }
}
