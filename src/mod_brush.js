// Ported from: WinQuake/gl_model.c (BRUSHMODEL LOADING), with BSP2 from
// Ironwail gl_model.c
// Parses a .bsp into model_t data. Textures, sky layers and warp polygons
// are made through gl_model_upload.js; this module does not import three.
// Split out of gl_model.js, which re-exports Mod_LiquidFlagFromName and
// RadiusFromBounds.

import {
  dclipnode_t,
  dmodel_t,
  MAX_SURFACE_EXTENTS,
  medge_t,
  MLEAF_SLAB_BYTES,
  mleaf_t,
  mnode_t,
  mod_brush,
  mplane_t,
  MSURFACE_SLAB_BYTES,
  msurface_t,
  mtexinfo_t,
  mvertex_t,
  SURF_DRAWLAVA,
  SURF_DRAWSKY,
  SURF_DRAWSLIME,
  SURF_DRAWTELE,
  SURF_DRAWTILED,
  SURF_DRAWTURB,
  SURF_DRAWWATER,
  SURF_PLANEBACK,
  SURF_UNDERWATER,
  texture_t,
} from "./mod_types.js";
import {
  loadmodel,
  Mod_AllocVisBuffers,
  Mod_DecompressVis,
  Mod_FindName,
  readString,
  set_loadmodel,
} from "./model.js";
import {
  GL_LoadTexture,
  GL_SubdivideSurface,
  R_InitSky,
  r_notexture_mip,
} from "./gl_model_upload.js";
import { Sys_Error } from "./sys.js";
import { Host_Error } from "./host.js";
import { COM_StripExtension, Con_DPrintf, Con_Printf } from "./common.js";
import { COM_FindFile } from "./pak.js";
import { Length, VectorCopy } from "./mathlib.js";
import { ca_dedicated, cls } from "./client.js";
import { r_novis } from "./glquake.js";
import {
  BSP2VERSION_2PSB,
  BSP2VERSION_BSP2,
  BSPVERSION,
  CONTENTS_EMPTY,
  CONTENTS_LAVA,
  CONTENTS_SLIME,
  CONTENTS_WATER,
  HEADER_LUMPS,
  LUMP_CLIPNODES,
  LUMP_EDGES,
  LUMP_ENTITIES,
  LUMP_FACES,
  LUMP_LEAFS,
  LUMP_LIGHTING,
  LUMP_MARKSURFACES,
  LUMP_MODELS,
  LUMP_NODES,
  LUMP_PLANES,
  LUMP_SURFEDGES,
  LUMP_TEXINFO,
  LUMP_TEXTURES,
  LUMP_VERTEXES,
  LUMP_VISIBILITY,
  MAX_MAP_HULLS,
  MAX_MAP_LEAFS,
  MAXLIGHTMAPS,
  MIPLEVELS,
  TEX_SPECIAL,
} from "./bspfile.js";

// mod_base: Uint8Array - the raw file bytes of the BSP currently being loaded
let mod_base = null;

// Q1BSPX_Setup / Q1BSPX_FindLump (Quakespasm-Spiked gl_model.c)

// Deliberate addition: the BSPX extension lump table. Ironwail and QuakeSpasm
// do not read it; this follows Quakespasm-Spiked, the community fallback
// (AGENTS.md). Compilers such as ericw-tools append "BSPX", a lump count and
// { char name[24], int fileofs, int filelen } entries after the last standard
// lump. Only RGBLIGHTING is used (Mod_LoadLighting); every other lump
// (LIGHTING_E5BGR9, LMSHIFT, LMOFFSET, LMSTYLE, DECOUPLED_LM, LIGHTINGDIR,
// BRUSHLIST, LIGHTGRID_OCTREE, ...) is ignored.
const SIZEOF_BSPX_LUMP = 32;

// bspx_lumps: Map of lump name to { fileofs, filelen }, or null when the BSP
// being loaded has no valid table
let bspx_lumps = null;

function Q1BSPX_Setup(lumps, filelen) {
  bspx_lumps = null;

  let misaligned = false;
  let offs = 0;
  for (let i = 0; i < HEADER_LUMPS; i++) {
    if ((lumps[i].fileofs & 3) !== 0 && i !== LUMP_ENTITIES) {
      misaligned = true;
    }
    if (offs < lumps[i].fileofs + lumps[i].filelen) {
      offs = lumps[i].fileofs + lumps[i].filelen;
    }
  }
  if (misaligned) {
    Con_DPrintf("%s contains misaligned lumps\n", loadmodel.name);
  }
  offs = (offs + 3) & ~3;
  if (offs + 8 > filelen) {
    return; // no space for it
  }

  // verify the header
  if (
    mod_base[offs] !== 0x42 || mod_base[offs + 1] !== 0x53 ||
    mod_base[offs + 2] !== 0x50 || mod_base[offs + 3] !== 0x58
  ) { // "BSPX"
    return;
  }
  const view = new DataView(mod_base.buffer, mod_base.byteOffset);
  const numlumps = view.getInt32(offs + 4, true);
  if (numlumps < 0 || offs + 8 + SIZEOF_BSPX_LUMP * numlumps > filelen) {
    return;
  }

  const table = new Map();
  for (let i = 0; i < numlumps; i++) {
    const e = offs + 8 + i * SIZEOF_BSPX_LUMP;
    let name = "";
    for (let j = 0; j < 24 && mod_base[e + j] !== 0; j++) {
      name += String.fromCharCode(mod_base[e + j]);
    }
    const fileofs = view.getInt32(e + 24, true);
    const len = view.getInt32(e + 28, true);
    if ((fileofs & 3) !== 0) {
      Con_DPrintf(
        "%s contains misaligned bspx lump %s\n",
        loadmodel.name,
        name,
      );
    }
    // C: unsigned, so a negative offset or length is out of range too
    if ((fileofs >>> 0) + (len >>> 0) > filelen) {
      return;
    }
    // C: the first entry with a name wins (strncmp from lump 0)
    if (!table.has(name)) {
      table.set(name, { fileofs: fileofs, filelen: len });
    }
  }

  bspx_lumps = table;
}

/** @returns {{fileofs: number, filelen: number} | null} */
function Q1BSPX_FindLump(lumpname) {
  if (bspx_lumps === null) {
    return null;
  }
  const l = bspx_lumps.get(lumpname);
  return l !== undefined ? l : null;
}

//                     BRUSHMODEL LOADING

// On-disk structure sizes (must match the BSP file layout)
const SIZEOF_DVERTEX = 12; // 3 floats
const SIZEOF_DEDGE = 4; // 2 unsigned shorts
const SIZEOF_DFACE = 20; // short planenum, short side, int firstedge, short numedges, short texinfo, byte styles[4], int lightofs
const SIZEOF_DNODE = 24; // int planenum, short children[2], short mins[3], short maxs[3], unsigned short firstface, unsigned short numfaces
const SIZEOF_DLEAF = 28; // int contents, int visofs, short mins[3], short maxs[3], unsigned short firstmarksurface, unsigned short nummarksurfaces, byte ambient_level[4]
const SIZEOF_DCLIPNODE = 8; // int planenum, short children[2]
// BSP2 (Ironwail bspfile.h dledge_t, dlface_t, dl2node_t, dl2leaf_t, dlclipnode_t)
const SIZEOF_DLEDGE = 8; // 2 unsigned ints
const SIZEOF_DLFACE = 28; // int planenum, int side, int firstedge, int numedges, int texinfo, byte styles[4], int lightofs
const SIZEOF_DL2NODE = 44; // int planenum, int children[2], float mins[3], float maxs[3], unsigned int firstface, unsigned int numfaces
const SIZEOF_DL2LEAF = 44; // int contents, int visofs, float mins[3], float maxs[3], unsigned int firstmarksurface, unsigned int nummarksurfaces, byte ambient_level[4]
const SIZEOF_DLCLIPNODE = 12; // int planenum, int children[2]
// 2PSB (Ironwail bspfile.h dl1node_t, dl1leaf_t): BSP2's int fields with short bounds
const SIZEOF_DL1NODE = 32; // int planenum, int children[2], short mins[3], short maxs[3], unsigned int firstface, unsigned int numfaces
const SIZEOF_DL1LEAF = 32; // int contents, int visofs, short mins[3], short maxs[3], unsigned int firstmarksurface, unsigned int nummarksurfaces, byte ambient_level[4]

// Ironwail Mod_LoadBrushModel's bsp2 levels: 0 for BSP29, 1 for 2PSB ("first
// iteration") and 2 for BSP2 ("sanitised revision")
const BSP2_2PSB = 1;
const BSP2_BSP2 = 2;
const SIZEOF_TEXINFO = 40; // float vecs[2][4], int miptex, int flags
const SIZEOF_DPLANE = 20; // float normal[3], float dist, int type
const SIZEOF_DMODEL = 64; // float mins[3], maxs[3], origin[3], int headnode[4], int visleafs, int firstface, int numfaces

// Mod_LoadTextures

function Mod_LoadTextures(fileofs, filelen) {
  if (filelen === 0) {
    loadmodel.textures = null;
    return;
  }

  const view = new DataView(
    mod_base.buffer,
    mod_base.byteOffset + fileofs,
    filelen,
  );

  // miptex header size is 16 (name) + 4 (width) + 4 (height) + 4*4 (offsets) = 40
  const SIZEOF_MIPTEX = 40;

  // Deliberate deviation: the C trusts the counts and offsets in the lump
  // and reads past it on a bad map. A typed array throws a RangeError or
  // reads undefined instead, so reject a lump too short for its own
  // directory and drop miptexes whose header lies outside the lump.
  if (filelen < 4) {
    Sys_Error("Mod_LoadTextures: funny lump size in " + loadmodel.name);
  }
  const nummiptex = view.getInt32(0, true);
  if (nummiptex < 0 || 4 + nummiptex * 4 > filelen) {
    Sys_Error(
      "Mod_LoadTextures: bad miptex count " + nummiptex + " in " +
        loadmodel.name,
    );
  }

  loadmodel.numtextures = nummiptex;
  loadmodel.textures = new Array(nummiptex);

  for (let i = 0; i < nummiptex; i++) {
    const dataofs = view.getInt32(4 + i * 4, true);
    if (dataofs === -1) {
      loadmodel.textures[i] = null;
      continue;
    }

    if (dataofs < 0 || dataofs + SIZEOF_MIPTEX > filelen) {
      Con_Printf(
        "Mod_LoadTextures: miptex " + i + " offset " + dataofs +
          " outside lump in " + loadmodel.name + "\n",
      );
      loadmodel.textures[i] = null; // drawn as r_notexture_mip
      continue;
    }

    // miptex_t at mod_base + fileofs + dataofs
    const mtOfs = fileofs + dataofs;
    const mtView = new DataView(
      mod_base.buffer,
      mod_base.byteOffset + mtOfs,
      SIZEOF_MIPTEX,
    );

    const name = readString(mod_base, mtOfs, 16);
    const width = mtView.getUint32(16, true);
    const height = mtView.getUint32(20, true);
    const offsets = [];
    for (let j = 0; j < MIPLEVELS; j++) {
      offsets[j] = mtView.getUint32(24 + j * 4, true);
    }

    // Deliberate deviation (QuakeSpasm): a warning, not Sys_Error. Nothing
    // here depends on the alignment; the mip offsets come from the file.
    if ((width & 15) || (height & 15)) {
      Con_Printf(
        "Texture " + name + " (" + width + " x " + height +
          ") is not 16 aligned\n",
      );
    }

    // Deliberate deviation (QuakeSpasm): a zero sized texture is skipped
    // with a warning.
    if (width === 0 || height === 0) {
      Con_Printf(
        "Zero sized texture " + name + " in " + loadmodel.name + "!\n",
      );
      loadmodel.textures[i] = null; // drawn as r_notexture_mip
      continue;
    }

    const pixels = (width * height / 64) * 85;

    const tx = new texture_t();
    loadmodel.textures[i] = tx;

    tx.name = name;
    tx.width = width;
    tx.height = height;
    for (let j = 0; j < MIPLEVELS; j++) {
      tx.offsets[j] = offsets[j];
    }

    // Copy the pixel data (follows the miptex header in the file)
    tx.pixels = new Uint8Array(pixels);

    // Deliberate deviation (QuakeSpasm, ericw): pixels running past the
    // end of the lump are copied up to the lump's end; the rest stay 0.
    let copy = pixels;
    if (dataofs + SIZEOF_MIPTEX + pixels > filelen) {
      Con_DPrintf("Texture " + name + " extends past end of lump\n");
      copy = Math.max(0, filelen - (dataofs + SIZEOF_MIPTEX));
    }

    for (let j = 0; j < copy; j++) {
      tx.pixels[j] = mod_base[mtOfs + SIZEOF_MIPTEX + j];
    }

    if (name.substring(0, 3) === "sky") {
      R_InitSky(tx);
    } else {
      // Turbulent ('*') textures are drawn unlit with no emissive map, so
      // splitting out fullbright pixels would black them out (*lava1 is
      // entirely fullbright).
      const splitFullbright = name[0] !== "*";
      // QuakeSpasm/Ironwail (ericw): '{' textures are fences, TEXPREF_ALPHA,
      // drawn alpha-tested (Ironwail TEXTYPE_CUTOUT, SURF_DRAWFENCE)
      const fence = name[0] === "{";
      tx.gl_texture = GL_LoadTexture(
        name,
        tx.width,
        tx.height,
        tx.pixels,
        true,
        fence,
        splitFullbright,
        false,
        fence,
      );
    }
  }

  // sequence the animations
  const ANIM_CYCLE = 2;

  for (let i = 0; i < nummiptex; i++) {
    const tx = loadmodel.textures[i];
    if (!tx || tx.name.charAt(0) !== "+") {
      continue;
    }
    if (tx.anim_next) {
      continue; // already sequenced
    }

    // find the number of frames in the animation
    const anims = new Array(10).fill(null);
    const altanims = new Array(10).fill(null);

    let max = tx.name.charCodeAt(1);
    let altmax = 0;

    if (max >= "a".charCodeAt(0) && max <= "z".charCodeAt(0)) {
      max -= "a".charCodeAt(0) - "A".charCodeAt(0);
    }
    if (max >= "0".charCodeAt(0) && max <= "9".charCodeAt(0)) {
      max -= "0".charCodeAt(0);
      altmax = 0;
      anims[max] = tx;
      max++;
    } else if (max >= "A".charCodeAt(0) && max <= "J".charCodeAt(0)) {
      altmax = max - "A".charCodeAt(0);
      max = 0;
      altanims[altmax] = tx;
      altmax++;
    } else {
      Sys_Error("Bad animating texture " + tx.name);
    }

    for (let j = i + 1; j < nummiptex; j++) {
      const tx2 = loadmodel.textures[j];
      if (!tx2 || tx2.name.charAt(0) !== "+") {
        continue;
      }
      if (tx2.name.substring(2) !== tx.name.substring(2)) {
        continue;
      }

      let num = tx2.name.charCodeAt(1);
      if (num >= "a".charCodeAt(0) && num <= "z".charCodeAt(0)) {
        num -= "a".charCodeAt(0) - "A".charCodeAt(0);
      }
      if (num >= "0".charCodeAt(0) && num <= "9".charCodeAt(0)) {
        num -= "0".charCodeAt(0);
        anims[num] = tx2;
        if (num + 1 > max) {
          max = num + 1;
        }
      } else if (num >= "A".charCodeAt(0) && num <= "J".charCodeAt(0)) {
        num = num - "A".charCodeAt(0);
        altanims[num] = tx2;
        if (num + 1 > altmax) {
          altmax = num + 1;
        }
      } else {
        Sys_Error("Bad animating texture " + tx.name);
      }
    }

    // link them all together
    for (let j = 0; j < max; j++) {
      const tx2 = anims[j];
      if (!tx2) {
        Sys_Error("Missing frame " + j + " of " + tx.name);
      }
      tx2.anim_total = max * ANIM_CYCLE;
      tx2.anim_min = j * ANIM_CYCLE;
      tx2.anim_max = (j + 1) * ANIM_CYCLE;
      tx2.anim_next = anims[(j + 1) % max];
      if (altmax) {
        tx2.alternate_anims = altanims[0];
      }
    }

    for (let j = 0; j < altmax; j++) {
      const tx2 = altanims[j];
      if (!tx2) {
        Sys_Error("Missing frame " + j + " of " + tx.name);
      }
      tx2.anim_total = altmax * ANIM_CYCLE;
      tx2.anim_min = j * ANIM_CYCLE;
      tx2.anim_max = (j + 1) * ANIM_CYCLE;
      tx2.anim_next = altanims[(j + 1) % altmax];
      if (max) {
        tx2.alternate_anims = anims[0];
      }
    }
  }
}

// Mod_LoadLighting

// Deliberate deviation (Ironwail Mod_LoadLighting, "lit support via
// lordhavoc"): use maps/<name>.lit coloured lighting when there is a good
// one, else the BSP's mono light data. Unlike Ironwail, mono data is not
// expanded to RGB: it stays one byte a sample and litfile tells the
// renderer which it is, so maps without a .lit cost nothing extra. A
// dedicated server, which never draws, does not read the .lit.
// COM_EnsureFile fetches the .lit with its map (pak.js COM_EnsureLitFile).
// Without a good .lit, a BSPX RGBLIGHTING lump is the RGB data, as in
// Quakespasm-Spiked (litfile then means "lightdata is RGB", whichever
// source it came from).
function Mod_LoadLighting(fileofs, filelen) {
  loadmodel.lightdata = null;
  loadmodel.litfile = false;

  // LordHavoc: check for a .lit file
  const litfilename = COM_StripExtension(loadmodel.name) + ".lit";
  const lit = cls.state !== ca_dedicated ? COM_FindFile(litfilename) : null;
  if (lit !== null) {
    // use lit file only from the same gamedir as the map
    // itself or from a searchpath with higher priority.
    const map = COM_FindFile(loadmodel.name);
    const data = lit.data;
    if (map !== null && lit.path_id < map.path_id) {
      Con_DPrintf(
        "ignored %s from a gamedir with lower priority\n",
        litfilename,
      );
    } else if (
      lit.size >= 8 && data[0] === 0x51 && data[1] === 0x4c &&
      data[2] === 0x49 && data[3] === 0x54
    ) { // "QLIT"
      const i = data[4] | (data[5] << 8) | (data[6] << 16) | (data[7] << 24);
      if (i === 1) {
        if (8 + filelen * 3 === lit.size) {
          Con_DPrintf("%s loaded\n", litfilename);
          // a view of the pak data: nothing writes lightdata
          loadmodel.lightdata = data.subarray(8, lit.size);
          loadmodel.litfile = true;
          return;
        }

        Con_Printf(
          "Outdated .lit file (%s should be %d bytes, not %d)\n",
          litfilename,
          8 + filelen * 3,
          lit.size,
        );
      } else {
        Con_Printf("Unknown .lit file version (%d)\n", i);
      }
    } else {
      Con_Printf("Corrupt .lit file (old version?), ignoring\n");
    }
  }

  const rgb = cls.state !== ca_dedicated ?
    Q1BSPX_FindLump("RGBLIGHTING") :
    null;
  if (
    rgb !== null &&
    (filelen === 0 || (rgb.filelen !== 0 && rgb.filelen === filelen * 3))
  ) {
    loadmodel.lightdata = mod_base.slice(
      rgb.fileofs,
      rgb.fileofs + rgb.filelen,
    );
    loadmodel.litfile = true;
    Con_DPrintf("bspx ldr lighting loaded\n");
    return;
  }

  if (filelen === 0) {
    return;
  }

  loadmodel.lightdata = new Uint8Array(filelen);
  loadmodel.lightdata.set(mod_base.subarray(fileofs, fileofs + filelen));
}

// Mod_LoadVisibility

function Mod_LoadVisibility(fileofs, filelen) {
  if (filelen === 0) {
    loadmodel.visdata = null;
    return;
  }

  loadmodel.visdata = new Uint8Array(filelen);
  loadmodel.visdata.set(mod_base.subarray(fileofs, fileofs + filelen));
}

// Mod_LoadEntities

function Mod_LoadEntities(fileofs, filelen) {
  if (filelen === 0) {
    loadmodel.entities = null;
    return;
  }

  // Read as string
  let s = "";
  for (let i = 0; i < filelen; i++) {
    const c = mod_base[fileofs + i];
    if (c === 0) break;
    s += String.fromCharCode(c);
  }

  loadmodel.entities = s;
}

// Mod_LoadVertexes

function Mod_LoadVertexes(fileofs, filelen) {
  if (filelen % SIZEOF_DVERTEX) {
    Sys_Error("MOD_LoadBmodel: funny lump size in " + loadmodel.name);
  }

  const count = filelen / SIZEOF_DVERTEX;
  const view = new DataView(
    mod_base.buffer,
    mod_base.byteOffset + fileofs,
    filelen,
  );
  const out = new Array(count);

  loadmodel.vertexes = out;
  loadmodel.numvertexes = count;

  const slab = new ArrayBuffer(count * SIZEOF_DVERTEX);
  for (let i = 0; i < count; i++) {
    const v = new mvertex_t(slab, i * SIZEOF_DVERTEX);
    const base = i * SIZEOF_DVERTEX;
    v.position[0] = view.getFloat32(base, true);
    v.position[1] = view.getFloat32(base + 4, true);
    v.position[2] = view.getFloat32(base + 8, true);
    out[i] = v;
  }
}

// Mod_LoadEdges

// bsp2 (Ironwail): read dledge_t, with unsigned int vertex numbers

function Mod_LoadEdges(fileofs, filelen, bsp2 = false) {
  const size = bsp2 ? SIZEOF_DLEDGE : SIZEOF_DEDGE;
  if (filelen % size) {
    Sys_Error("MOD_LoadBmodel: funny lump size in " + loadmodel.name);
  }

  const count = filelen / size;
  const view = new DataView(
    mod_base.buffer,
    mod_base.byteOffset + fileofs,
    filelen,
  );
  const out = new Array(count + 1);

  loadmodel.edges = out;
  loadmodel.numedges = count;

  const slab = new ArrayBuffer((count + 1) * 8);
  for (let i = 0; i < count; i++) {
    const e = new medge_t(slab, i * 8);
    const base = i * size;
    if (bsp2) {
      e.v[0] = view.getUint32(base, true);
      e.v[1] = view.getUint32(base + 4, true);
    } else {
      e.v[0] = view.getUint16(base, true);
      e.v[1] = view.getUint16(base + 2, true);
    }

    out[i] = e;
  }

  // +1 slot (matches C allocation)
  out[count] = new medge_t(slab, count * 8);
}

// Mod_LoadSurfedges

function Mod_LoadSurfedges(fileofs, filelen) {
  if (filelen % 4) {
    Sys_Error("MOD_LoadBmodel: funny lump size in " + loadmodel.name);
  }

  const count = filelen / 4;
  const view = new DataView(
    mod_base.buffer,
    mod_base.byteOffset + fileofs,
    filelen,
  );
  const out = new Int32Array(count);

  loadmodel.surfedges = out;
  loadmodel.numsurfedges = count;

  for (let i = 0; i < count; i++) {
    out[i] = view.getInt32(i * 4, true);
  }
}

// Mod_LoadPlanes

function Mod_LoadPlanes(fileofs, filelen) {
  if (filelen % SIZEOF_DPLANE) {
    Sys_Error("MOD_LoadBmodel: funny lump size in " + loadmodel.name);
  }

  const count = filelen / SIZEOF_DPLANE;
  const view = new DataView(
    mod_base.buffer,
    mod_base.byteOffset + fileofs,
    filelen,
  );
  const out = new Array(count * 2); // allocate 2x like C code

  loadmodel.planes = out;
  loadmodel.numplanes = count;

  const slab = new ArrayBuffer(count * 2 * 12);
  for (let i = 0; i < count; i++) {
    const p = new mplane_t(slab, i * 12);
    const base = i * SIZEOF_DPLANE;
    let bits = 0;

    for (let j = 0; j < 3; j++) {
      p.normal[j] = view.getFloat32(base + j * 4, true);
      if (p.normal[j] < 0) {
        bits |= 1 << j;
      }
    }

    p.dist = view.getFloat32(base + 12, true);
    p.type = view.getInt32(base + 16, true);
    p.signbits = bits;

    out[i] = p;
  }

  // Fill remaining slots (C allocates count*2)
  for (let i = count; i < count * 2; i++) {
    out[i] = new mplane_t(slab, i * 12);
  }
}

// Mod_LoadTexinfo

function Mod_LoadTexinfo(fileofs, filelen) {
  if (filelen % SIZEOF_TEXINFO) {
    Sys_Error("MOD_LoadBmodel: funny lump size in " + loadmodel.name);
  }

  const count = filelen / SIZEOF_TEXINFO;
  const view = new DataView(
    mod_base.buffer,
    mod_base.byteOffset + fileofs,
    filelen,
  );
  const out = new Array(count);

  loadmodel.texinfo = out;
  loadmodel.numtexinfo = count;

  for (let i = 0; i < count; i++) {
    const ti = new mtexinfo_t();
    const base = i * SIZEOF_TEXINFO;

    // Read vecs[2][4] = 8 floats
    for (let j = 0; j < 4; j++) {
      ti.vecs[0][j] = view.getFloat32(base + j * 4, true);
    }
    for (let j = 0; j < 4; j++) {
      ti.vecs[1][j] = view.getFloat32(base + 16 + j * 4, true);
    }

    // Compute mipadjust from vector lengths
    const len1 = Length(ti.vecs[0]); // only first 3 components matter but Length uses all 3
    const len2 = Length(ti.vecs[1]);
    const lenAvg = (len1 + len2) / 2;
    if (lenAvg < 0.32) {
      ti.mipadjust = 4;
    } else if (lenAvg < 0.49) {
      ti.mipadjust = 3;
    } else if (lenAvg < 0.99) {
      ti.mipadjust = 2;
    } else {
      ti.mipadjust = 1;
    }

    const miptex = view.getInt32(base + 32, true);
    ti.flags = view.getInt32(base + 36, true);

    if (!loadmodel.textures) {
      ti.texture = r_notexture_mip; // checkerboard texture
      ti.flags = 0;
    } else {
      if (miptex >= loadmodel.numtextures) {
        Sys_Error("miptex >= loadmodel->numtextures");
      }
      ti.texture = loadmodel.textures[miptex];
      if (!ti.texture) {
        ti.texture = r_notexture_mip; // texture not found
        ti.flags = 0;
      }
    }

    out[i] = ti;
  }
}

// CalcSurfaceExtents
//
// Fills in s->texturemins[] and s->extents[]

const FLT_MAX = 3.4028234663852886e+38;

function CalcSurfaceExtents(s) {
  // id seeds 999999 / -99999. Ironwail (gl_model.c CalcSurfaceExtents) uses
  // +/-FLT_MAX. Both give the same result for any face inside the old seeds
  // (any BSP29 map id could build, and every shipped map); only a face
  // entirely beyond them (possible in BSP2) differs, where id's is wrong.
  let mins0 = FLT_MAX, mins1 = FLT_MAX;
  let maxs0 = -FLT_MAX, maxs1 = -FLT_MAX;

  const tex = s.texinfo;
  const vec0 = tex.vecs[0], vec1 = tex.vecs[1];
  const surfedges = loadmodel.surfedges,
    edges = loadmodel.edges,
    vertexes = loadmodel.vertexes;

  for (let i = 0; i < s.numedges; i++) {
    const e = surfedges[s.firstedge + i];
    let v;
    if (e >= 0) {
      v = vertexes[edges[e].v[0]];
    } else {
      v = vertexes[edges[-e].v[1]];
    }

    const p = v.position;
    const val0 = p[0] * vec0[0] + p[1] * vec0[1] + p[2] * vec0[2] + vec0[3];
    const val1 = p[0] * vec1[0] + p[1] * vec1[1] + p[2] * vec1[2] + vec1[3];
    if (val0 < mins0) mins0 = val0;
    if (val0 > maxs0) maxs0 = val0;
    if (val1 < mins1) mins1 = val1;
    if (val1 > maxs1) maxs1 = val1;
  }

  for (let i = 0; i < 2; i++) {
    const bmins = Math.floor((i === 0 ? mins0 : mins1) / 16);
    const bmaxs = Math.ceil((i === 0 ? maxs0 : maxs1) / 16);

    s.texturemins[i] = bmins * 16;
    s.extents[i] = (bmaxs - bmins) * 16;
    // Deliberate deviation (QuakeSpasm/Ironwail): was 512 in GLQuake.
    // 2000 gives at most 126 luxels a side, which still fits one
    // BLOCK_WIDTH x BLOCK_HEIGHT lightmap and blocklights (gl_rsurf.js).
    if (!(tex.flags & TEX_SPECIAL) && s.extents[i] > MAX_SURFACE_EXTENTS) {
      Sys_Error("Bad surface extents");
    }
  }
}

// Mod_LiquidFlagFromName
//
// Deliberate deviation, from Ironwail (gl_model.c Mod_TextureTypeFromName,
// liquids only): which SURF_DRAW* liquid flag a '*' texture gets.

export function Mod_LiquidFlagFromName(texname) {
  if (texname.startsWith("lava", 1)) return SURF_DRAWLAVA;
  if (texname.startsWith("slime", 1)) return SURF_DRAWSLIME;
  if (texname.startsWith("tele", 1)) return SURF_DRAWTELE;
  return SURF_DRAWWATER;
}

// Mod_CheckWaterVis
//
// Deliberate deviation, from QuakeSpasm-Spiked and Ironwail (gl_model.c, by
// Spike): finds which liquids the map's vis lets you see through (a liquid
// leaf whose PVS holds a leaf of other contents), for the worldspawn
// _wateralpha keys (gl_rsurf.js). Liquids the map doesn't have count as
// see-through, so submodel liquids work.

const SURF_DRAWLIQUIDS = SURF_DRAWWATER | SURF_DRAWTELE | SURF_DRAWSLIME |
  SURF_DRAWLAVA;

function Mod_CheckWaterVis() {
  // clamped to the loaded leafs, so a bad visleafs count can't read past them
  const numclusters = loadmodel.numsubmodels > 0 ?
    Math.min(loadmodel.submodels[0].visleafs, loadmodel.numleafs - 1) :
    0;
  let contentfound = 0;
  let contenttransparent = 0;
  let hascontents = 0;

  if (r_novis.value) {
    // all can be
    loadmodel.contentstransparent = SURF_DRAWLIQUIDS;
    return;
  }

  // pvs is 1-based. leaf 0 sees all (the solid leaf).
  // leaf 0 has no pvs, and does not appear in other leafs either.
  for (let i = 0; i < numclusters; i++) {
    const leaf = loadmodel.leafs[i + 1];
    let contenttype = 0;
    if (leaf.contents < 0) {
      hascontents |= 1 << -leaf.contents;
    }
    if (leaf.contents === CONTENTS_WATER) {
      if (
        (contenttransparent & (SURF_DRAWWATER | SURF_DRAWTELE)) ===
          (SURF_DRAWWATER | SURF_DRAWTELE)
      ) {
        continue;
      }
      for (let j = 0; j < leaf.nummarksurfaces; j++) {
        const surf = leaf.firstmarksurface[j];
        if (surf.flags & (SURF_DRAWWATER | SURF_DRAWTELE)) {
          contenttype = surf.flags & (SURF_DRAWWATER | SURF_DRAWTELE);
          break;
        }
      }

      // it's possible that this leaf has no surfaces in it, turb or otherwise
      if (contenttype === 0) {
        continue;
      }
    } else if (leaf.contents === CONTENTS_SLIME) {
      contenttype = SURF_DRAWSLIME;
    } else if (leaf.contents === CONTENTS_LAVA) {
      contenttype = SURF_DRAWLAVA;
    } else {
      continue;
    }

    if (contenttransparent & contenttype) {
      continue; // found one of this type already
    }

    contentfound |= contenttype;
    // Deliberate deviation: Ironwail runs this before the submodel loop
    // sets numleafs to visleafs, so its rows are sized from every leaf
    // and decoding runs on into the next leaf's data, clamped silently.
    // Size the row from the vis clusters, as Mod_LeafPVS later does. The
    // bytes read below are the same either way.
    const vis = Mod_DecompressVis(
      leaf.compressed_vis,
      leaf.compressed_vis_offset,
      loadmodel,
      numclusters,
    );
    search: for (let j = 0; j < (numclusters + 7) >> 3; j++) {
      if (vis[j] === 0) continue;
      for (let k = 0; k < 8; k++) {
        if ((vis[j] & (1 << k)) === 0) continue;
        const other = loadmodel.leafs[(j << 3) + k + 1];
        if (other !== undefined && leaf.contents !== other.contents) {
          contenttransparent |= contenttype;
          break search;
        }
      }
    }
  }

  if (contenttransparent === 0) {
    // no liquid leaf saw a non-liquid leaf; only say so if there is liquid
    if (
      hascontents &
      ((1 << -CONTENTS_WATER) | (1 << -CONTENTS_SLIME) | (1 << -CONTENTS_LAVA))
    ) {
      Con_DPrintf(loadmodel.name + " is not watervised\n");
    }
  }

  // any types that we didn't find are assumed to be transparent
  loadmodel.contentstransparent = contenttransparent |
    (~contentfound & SURF_DRAWLIQUIDS);
}

// Mod_LoadFaces

// bsp2 (Ironwail): read dlface_t, with int fields where dface_t has shorts

function Mod_LoadFaces(fileofs, filelen, bsp2 = false) {
  const size = bsp2 ? SIZEOF_DLFACE : SIZEOF_DFACE;
  if (filelen % size) {
    Sys_Error("MOD_LoadBmodel: funny lump size in " + loadmodel.name);
  }

  const count = filelen / size;
  const view = new DataView(
    mod_base.buffer,
    mod_base.byteOffset + fileofs,
    filelen,
  );
  const out = new Array(count);

  loadmodel.surfaces = out;
  loadmodel.numsurfaces = count;

  const slabBytes = MSURFACE_SLAB_BYTES();
  const slab = new ArrayBuffer(count * slabBytes);
  for (let surfnum = 0; surfnum < count; surfnum++) {
    const s = new msurface_t(slab, surfnum * slabBytes);
    const base = surfnum * size;

    let planenum, side, texinfon, stylesofs, lightofs;
    if (bsp2) {
      s.firstedge = view.getInt32(base + 8, true);
      s.numedges = view.getInt32(base + 12, true);
      planenum = view.getInt32(base, true);
      side = view.getInt32(base + 4, true);
      texinfon = view.getInt32(base + 16, true);
      stylesofs = 20;
      lightofs = view.getInt32(base + 24, true);
    } else {
      s.firstedge = view.getInt32(base + 4, true);
      s.numedges = view.getInt16(base + 8, true);
      planenum = view.getInt16(base, true); // dface_t planenum is a short
      side = view.getInt16(base + 2, true);
      texinfon = view.getInt16(base + 10, true);
      stylesofs = 12;
      lightofs = view.getInt32(base + 16, true);
    }

    s.flags = 0;

    if (side) {
      s.flags |= SURF_PLANEBACK;
    }

    s.plane = loadmodel.planes[planenum];

    s.texinfo = loadmodel.texinfo[texinfon];

    CalcSurfaceExtents(s);

    // lighting info
    for (let i = 0; i < MAXLIGHTMAPS; i++) {
      s.styles[i] = mod_base[fileofs + base + stylesofs + i];
    }

    if (lightofs === -1) {
      s.samples = null;
    } else {
      // Ironwail: lightofs * 3 into RGB data from a .lit
      s.samples = loadmodel.lightdata;
      s.sampleOffset = loadmodel.litfile ? lightofs * 3 : lightofs;
      s.rgbsamples = loadmodel.litfile;
    }

    // set the drawing flags
    if (s.texinfo.texture && s.texinfo.texture.name.substring(0, 3) === "sky") {
      s.flags |= SURF_DRAWSKY | SURF_DRAWTILED;
      GL_SubdivideSurface(s);
      out[surfnum] = s;
      continue;
    }

    if (s.texinfo.texture && s.texinfo.texture.name.charAt(0) === "*") {
      s.flags |= SURF_DRAWTURB | SURF_DRAWTILED;
      s.flags |= Mod_LiquidFlagFromName(s.texinfo.texture.name);
      for (let i = 0; i < 2; i++) {
        s.extents[i] = 16384;
        s.texturemins[i] = -8192;
      }

      GL_SubdivideSurface(s);
      out[surfnum] = s;
      continue;
    }

    out[surfnum] = s;
  }
}

// Mod_SetParent

function Mod_SetParent(node, parent) {
  node.parent = parent;
  if (node.contents < 0) {
    return;
  }
  Mod_SetParent(node.children[0], node);
  Mod_SetParent(node.children[1], node);
}

// Mod_LoadNodes

// bsp2 (Ironwail Mod_LoadNodes_L2): read dl2node_t, with int children, float
// bounds and unsigned int face numbers. 2PSB (Mod_LoadNodes_L1) reads
// dl1node_t, the same with short bounds. Ironwail splits the three layouts
// into Mod_LoadNodes_S, _L1 and _L2; one function with branches here.

function Mod_LoadNodes(fileofs, filelen, bsp2 = 0) {
  const size = bsp2 === BSP2_BSP2 ?
    SIZEOF_DL2NODE :
    (bsp2 === BSP2_2PSB ? SIZEOF_DL1NODE : SIZEOF_DNODE);
  if (filelen % size) {
    Sys_Error(
      (bsp2 ? "Mod_LoadNodes" : "MOD_LoadBmodel") + ": funny lump size in " +
        loadmodel.name,
    );
  }

  const count = filelen / size;
  const view = new DataView(
    mod_base.buffer,
    mod_base.byteOffset + fileofs,
    filelen,
  );
  const out = new Array(count);

  loadmodel.nodes = out;
  loadmodel.numnodes = count;

  // Child numbers, resolved once every node and leaf exists: nodeChild[ 2 * i + j ]
  // is the node index, or -1 for a leaf, whose index is in leafChild[ 2 * i + j ].
  // (A property added then deleted per node would put every node in slow
  // dictionary mode, which the BSP walks in physics and rendering pay for.)
  const nodeChild = new Int32Array(count * 2);
  const leafChild = new Int32Array(count * 2);
  const slab = new ArrayBuffer(count * 24);

  for (let i = 0; i < count; i++) {
    const node = new mnode_t(slab, i * 24);
    const base = i * size;

    const p = view.getInt32(base, true);
    node.plane = loadmodel.planes[p];

    if (bsp2 !== 0) {
      if (bsp2 === BSP2_BSP2) {
        for (let j = 0; j < 3; j++) {
          node.minmaxs[j] = view.getFloat32(base + 12 + j * 4, true);
          node.minmaxs[3 + j] = view.getFloat32(base + 24 + j * 4, true);
        }

        node.firstsurface = view.getUint32(base + 36, true);
        node.numsurfaces = view.getUint32(base + 40, true);
      } else {
        for (let j = 0; j < 3; j++) {
          node.minmaxs[j] = view.getInt16(base + 12 + j * 2, true);
          node.minmaxs[3 + j] = view.getInt16(base + 18 + j * 2, true);
        }

        node.firstsurface = view.getUint32(base + 24, true);
        node.numsurfaces = view.getUint32(base + 28, true);
      }

      // Ironwail: _L1 takes child 0 as a node, _L2 as leaf -1 - 0 (leaf 0)
      const firstnode = bsp2 === BSP2_2PSB ? 0 : 1;
      for (let j = 0; j < 2; j++) {
        let c = view.getInt32(base + 4 + j * 4, true);
        if (c >= firstnode && c < count) {
          nodeChild[i * 2 + j] = c;
        } else {
          c = -1 - c; // C: 0xffffffff - p; -1 is leaf 0
          if (c < 0 || c >= loadmodel.numleafs) {
            Con_Printf(
              "Mod_LoadNodes: invalid leaf index " + c + " (file has only " +
                loadmodel.numleafs + " leafs)\n",
            );
            c = 0; // map it to the solid leaf
          }

          nodeChild[i * 2 + j] = -1;
          leafChild[i * 2 + j] = c;
        }
      }

      out[i] = node;
      continue;
    }

    for (let j = 0; j < 3; j++) {
      node.minmaxs[j] = view.getInt16(base + 8 + j * 2, true);
      node.minmaxs[3 + j] = view.getInt16(base + 14 + j * 2, true);
    }

    node.firstsurface = view.getUint16(base + 20, true);
    node.numsurfaces = view.getUint16(base + 22, true);

    for (let j = 0; j < 2; j++) {
      // Deliberate deviation (QuakeSpasm Mod_LoadNodes_S): read the child
      // unsigned so maps with more than 32767 nodes, or leafs past
      // 32767, load. The C reads a signed short.
      let p = view.getUint16(base + 4 + j * 2, true);
      if (p < count) {
        nodeChild[i * 2 + j] = p; // children[ j ] is resolved after all nodes are created
      } else {
        p = 65535 - p; // note this uses 65535 intentionally, -1 is leaf 0
        if (p >= loadmodel.numleafs) {
          Con_Printf(
            "Mod_LoadNodes: invalid leaf index " + p + " (file has only " +
              loadmodel.numleafs + " leafs)\n",
          );
          p = 0; // map it to the solid leaf
        }

        nodeChild[i * 2 + j] = -1;
        leafChild[i * 2 + j] = p;
      }
    }

    out[i] = node;
  }

  // Resolve children references now that all nodes and leafs exist
  for (let i = 0; i < count; i++) {
    const node = out[i];
    for (let j = 0; j < 2; j++) {
      const ci = nodeChild[i * 2 + j];
      node.children[j] = ci >= 0 ?
        out[ci] :
        loadmodel.leafs[leafChild[i * 2 + j]];
    }
  }

  Mod_SetParent(loadmodel.nodes[0], null);
}

// Mod_LoadLeafs

// bsp2 (Ironwail Mod_ProcessLeafs_L2): read dl2leaf_t, with float bounds and
// unsigned int marksurface numbers, and no leaf limit. 2PSB
// (Mod_ProcessLeafs_L1) reads dl1leaf_t, the same with short bounds.

function Mod_LoadLeafs(fileofs, filelen, bsp2 = 0) {
  const size = bsp2 === BSP2_BSP2 ?
    SIZEOF_DL2LEAF :
    (bsp2 === BSP2_2PSB ? SIZEOF_DL1LEAF : SIZEOF_DLEAF);
  if (filelen % size) {
    Sys_Error(
      (bsp2 ? "Mod_ProcessLeafs" : "MOD_LoadBmodel") + ": funny lump size in " +
        loadmodel.name,
    );
  }

  const count = filelen / size;
  const view = new DataView(
    mod_base.buffer,
    mod_base.byteOffset + fileofs,
    filelen,
  );
  const out = new Array(count);

  // Deliberate deviation: QuakeSpasm's BSP29 limit check (the C has none),
  // raised with Host_Error as Ironwail does so a bad map isn't fatal.
  // BSP2 and 2PSB leafs have none, as in Ironwail.
  if (bsp2 === 0 && count > MAX_MAP_LEAFS) {
    Host_Error(
      "Mod_LoadLeafs: " + count + " leafs exceeds limit of " + MAX_MAP_LEAFS +
        ".",
    );
  }

  loadmodel.leafs = out;
  loadmodel.numleafs = count;

  // size the PVS rows now so Mod_LeafPVS never allocates per frame
  Mod_AllocVisBuffers(count);

  const slabBytes = MLEAF_SLAB_BYTES();
  const slab = new ArrayBuffer(count * slabBytes);
  for (let i = 0; i < count; i++) {
    const leaf = new mleaf_t(slab, i * slabBytes);
    leaf._leafIndex = i; // store index for PVS checks (C uses pointer arithmetic: leaf - sv.worldmodel->leafs)
    const base = i * size;

    let firstmarksurfaceIdx, ambientofs;
    if (bsp2 === BSP2_BSP2) {
      for (let j = 0; j < 3; j++) {
        leaf.minmaxs[j] = view.getFloat32(base + 8 + j * 4, true);
        leaf.minmaxs[3 + j] = view.getFloat32(base + 20 + j * 4, true);
      }

      firstmarksurfaceIdx = view.getUint32(base + 32, true);
      leaf.nummarksurfaces = view.getUint32(base + 36, true);
      ambientofs = 40;
    } else if (bsp2 === BSP2_2PSB) {
      for (let j = 0; j < 3; j++) {
        leaf.minmaxs[j] = view.getInt16(base + 8 + j * 2, true);
        leaf.minmaxs[3 + j] = view.getInt16(base + 14 + j * 2, true);
      }

      firstmarksurfaceIdx = view.getUint32(base + 20, true);
      leaf.nummarksurfaces = view.getUint32(base + 24, true);
      ambientofs = 28;
    } else {
      for (let j = 0; j < 3; j++) {
        leaf.minmaxs[j] = view.getInt16(base + 8 + j * 2, true);
        leaf.minmaxs[3 + j] = view.getInt16(base + 14 + j * 2, true);
      }

      firstmarksurfaceIdx = view.getUint16(base + 20, true);
      leaf.nummarksurfaces = view.getUint16(base + 22, true);
      ambientofs = 24;
    }

    leaf.contents = view.getInt32(base, true);

    // In C: leaf->firstmarksurface = loadmodel->marksurfaces + firstmarksurface;
    // This is a pointer into the marksurfaces array (which is an array of msurface_t*)
    // In JS we store the sub-array so leaf.firstmarksurface[j] works like C
    leaf.firstmarksurface = loadmodel.marksurfaces.slice(
      firstmarksurfaceIdx,
      firstmarksurfaceIdx + leaf.nummarksurfaces,
    );

    const visofs = view.getInt32(base + 4, true);
    if (visofs === -1) {
      leaf.compressed_vis = null;
    } else {
      leaf.compressed_vis = loadmodel.visdata;
      leaf.compressed_vis_offset = visofs;
    }

    leaf.efrags = null;

    for (let j = 0; j < 4; j++) {
      leaf.ambient_sound_level[j] = mod_base[fileofs + base + ambientofs + j];
    }

    // gl underwater warp
    if (leaf.contents !== CONTENTS_EMPTY) {
      for (let j = 0; j < leaf.nummarksurfaces; j++) {
        leaf.firstmarksurface[j].flags |= SURF_UNDERWATER;
      }
    }

    out[i] = leaf;
  }
}

// Mod_LoadClipnodes

// bsp2 (Ironwail Mod_LoadClipnodes): read dlclipnode_t, with int children

function Mod_LoadClipnodes(fileofs, filelen, bsp2 = false) {
  const size = bsp2 ? SIZEOF_DLCLIPNODE : SIZEOF_DCLIPNODE;
  if (filelen % size) {
    Sys_Error(
      (bsp2 ? "Mod_LoadClipnodes" : "MOD_LoadBmodel") +
        ": funny lump size in " + loadmodel.name,
    );
  }

  const count = filelen / size;
  const view = new DataView(
    mod_base.buffer,
    mod_base.byteOffset + fileofs,
    filelen,
  );
  const out = new Array(count);

  loadmodel.clipnodes = out;
  loadmodel.numclipnodes = count;

  // hull 1 - player standing
  const hull1 = loadmodel.hulls[1];
  hull1.clipnodes = out;
  hull1.firstclipnode = 0;
  hull1.lastclipnode = count - 1;
  hull1.planes = loadmodel.planes;
  hull1.clip_mins[0] = -16;
  hull1.clip_mins[1] = -16;
  hull1.clip_mins[2] = -24;
  hull1.clip_maxs[0] = 16;
  hull1.clip_maxs[1] = 16;
  hull1.clip_maxs[2] = 32;

  // hull 2 - shambler
  const hull2 = loadmodel.hulls[2];
  hull2.clipnodes = out;
  hull2.firstclipnode = 0;
  hull2.lastclipnode = count - 1;
  hull2.planes = loadmodel.planes;
  hull2.clip_mins[0] = -32;
  hull2.clip_mins[1] = -32;
  hull2.clip_mins[2] = -24;
  hull2.clip_maxs[0] = 32;
  hull2.clip_maxs[1] = 32;
  hull2.clip_maxs[2] = 64;

  const slab = new ArrayBuffer(count * 8);
  for (let i = 0; i < count; i++) {
    const cn = new dclipnode_t(slab, i * 8);
    const base = i * size;

    cn.planenum = view.getInt32(base, true);

    // Deliberate deviation (QuakeSpasm Mod_LoadClipnodes): bounds check,
    // with Host_Error as Ironwail has it
    if (cn.planenum < 0 || cn.planenum >= loadmodel.numplanes) {
      Host_Error("Mod_LoadClipnodes: planenum out of bounds");
    }

    if (bsp2) {
      // Ironwail has no bounds check here either ("Spike: FIXME")
      cn.children[0] = view.getInt32(base + 4, true);
      cn.children[1] = view.getInt32(base + 8, true);
      out[i] = cn;
      continue;
    }

    // Deliberate deviation (QuakeSpasm): read the children unsigned so
    // maps with more than 32767 clipnodes load; values at or past count
    // are contents (-1 to -15) once 65536 is taken off.
    cn.children[0] = view.getUint16(base + 4, true);
    cn.children[1] = view.getUint16(base + 6, true);
    if (cn.children[0] >= count) {
      cn.children[0] -= 65536;
    }
    if (cn.children[1] >= count) {
      cn.children[1] -= 65536;
    }

    out[i] = cn;
  }
}

// Mod_MakeHull0
//
// Duplicate the drawing hull structure as a clipping hull

function Mod_MakeHull0() {
  const hull = loadmodel.hulls[0];

  const _in = loadmodel.nodes;
  const count = loadmodel.numnodes;
  const out = new Array(count);

  hull.clipnodes = out;
  hull.firstclipnode = 0;
  hull.lastclipnode = count - 1;
  hull.planes = loadmodel.planes;

  // C gets these indices by pointer subtraction (in->plane - planes,
  // child - nodes). indexOf per node is quadratic, which a map near the
  // raised limits makes slow, so look them up from maps built once.
  const planenums = new Map();
  for (let i = 0; i < loadmodel.planes.length; i++) {
    planenums.set(loadmodel.planes[i], i);
  }
  const nodenums = new Map();
  for (let i = 0; i < count; i++) {
    nodenums.set(_in[i], i);
  }

  const slab = new ArrayBuffer(count * 8);
  for (let i = 0; i < count; i++) {
    const cn = new dclipnode_t(slab, i * 8);
    const node = _in[i];

    const planenum = planenums.get(node.plane);
    cn.planenum = planenum !== undefined ? planenum : -1;

    for (let j = 0; j < 2; j++) {
      const child = node.children[j];
      if (child.contents < 0) {
        cn.children[j] = child.contents;
      } else {
        const nodenum = nodenums.get(child);
        cn.children[j] = nodenum !== undefined ? nodenum : -1;
      }
    }

    out[i] = cn;
  }
}

// Mod_LoadMarksurfaces

// bsp2 (Ironwail): unsigned int surface numbers

function Mod_LoadMarksurfaces(fileofs, filelen, bsp2 = false) {
  const size = bsp2 ? 4 : 2;

  // Deliberate deviation (Ironwail Mod_LoadMarksurfaces): Host_Error, not
  // Sys_Error, for both checks
  if (filelen % size) {
    Host_Error("MOD_LoadBmodel: funny lump size in " + loadmodel.name);
  }

  const count = filelen / size;
  const view = new DataView(
    mod_base.buffer,
    mod_base.byteOffset + fileofs,
    filelen,
  );
  const out = new Array(count);

  loadmodel.marksurfaces = out;
  loadmodel.nummarksurfaces = count;

  for (let i = 0; i < count; i++) {
    const j = bsp2 ? view.getUint32(i * 4, true) : view.getUint16(i * 2, true);
    if (j >= loadmodel.numsurfaces) {
      Host_Error("Mod_ParseMarksurfaces: bad surface number");
    }
    out[i] = loadmodel.surfaces[j];
  }
}

// Mod_LoadSubmodels

function Mod_LoadSubmodels(fileofs, filelen) {
  if (filelen % SIZEOF_DMODEL) {
    Sys_Error("MOD_LoadBmodel: funny lump size in " + loadmodel.name);
  }

  const count = filelen / SIZEOF_DMODEL;
  const view = new DataView(
    mod_base.buffer,
    mod_base.byteOffset + fileofs,
    filelen,
  );
  const out = new Array(count);

  loadmodel.submodels = out;
  loadmodel.numsubmodels = count;

  for (let i = 0; i < count; i++) {
    const sm = new dmodel_t();
    const base = i * SIZEOF_DMODEL;

    for (let j = 0; j < 3; j++) {
      // spread the mins / maxs by a pixel
      sm.mins[j] = view.getFloat32(base + j * 4, true) - 1;
      sm.maxs[j] = view.getFloat32(base + 12 + j * 4, true) + 1;
      sm.origin[j] = view.getFloat32(base + 24 + j * 4, true);
    }

    for (let j = 0; j < MAX_MAP_HULLS; j++) {
      sm.headnode[j] = view.getInt32(base + 36 + j * 4, true);
    }

    sm.visleafs = view.getInt32(base + 52, true);
    sm.firstface = view.getInt32(base + 56, true);
    sm.numfaces = view.getInt32(base + 60, true);

    out[i] = sm;
  }
}

// RadiusFromBounds

export function RadiusFromBounds(mins, maxs) {
  const corner = new Float32Array(3);

  for (let i = 0; i < 3; i++) {
    corner[i] = Math.abs(mins[i]) > Math.abs(maxs[i]) ?
      Math.abs(mins[i]) :
      Math.abs(maxs[i]);
  }

  return Length(corner);
}

// Mod_LoadBrushModel

export function Mod_LoadBrushModel(mod, buffer) {
  loadmodel.type = mod_brush;
  loadmodel.viswarn = false;

  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);

  // Deliberate deviation (Ironwail Mod_LoadBrushModel): BSP2 and 2PSB load
  // as well as BSP29 (see BSP2VERSION_BSP2 and BSP2VERSION_2PSB in
  // bspfile.js). Edges, faces, marksurfaces and clipnodes are the same in
  // both; nodes and leafs differ.
  const version = view.getInt32(0, true);
  let bsp2;
  if (version === BSPVERSION) {
    bsp2 = 0;
  } else if (version === BSP2VERSION_2PSB) {
    bsp2 = BSP2_2PSB;
  } else if (version === BSP2VERSION_BSP2) {
    bsp2 = BSP2_BSP2;
  } else {
    Sys_Error(
      "Mod_LoadBrushModel: " + mod.name + " has unsupported version number (" +
        version + ")",
    );
  }

  // swap all the lumps
  mod_base = bytes;

  // Read lump directory: version (4 bytes) + HEADER_LUMPS * 2 ints (fileofs, filelen)
  const lumps = [];
  for (let i = 0; i < HEADER_LUMPS; i++) {
    lumps[i] = {
      fileofs: view.getInt32(4 + i * 8, true),
      filelen: view.getInt32(4 + i * 8 + 4, true),
    };
  }
  Q1BSPX_Setup(lumps, bytes.length);
  const wide = bsp2 !== 0; // 32-bit edges, faces, marksurfaces, clipnodes

  // load into heap (order matters! same as original C code)
  Mod_LoadVertexes(lumps[LUMP_VERTEXES].fileofs, lumps[LUMP_VERTEXES].filelen);
  Mod_LoadEdges(lumps[LUMP_EDGES].fileofs, lumps[LUMP_EDGES].filelen, wide);
  Mod_LoadSurfedges(
    lumps[LUMP_SURFEDGES].fileofs,
    lumps[LUMP_SURFEDGES].filelen,
  );
  Mod_LoadTextures(lumps[LUMP_TEXTURES].fileofs, lumps[LUMP_TEXTURES].filelen);
  Mod_LoadLighting(lumps[LUMP_LIGHTING].fileofs, lumps[LUMP_LIGHTING].filelen);
  Mod_LoadPlanes(lumps[LUMP_PLANES].fileofs, lumps[LUMP_PLANES].filelen);
  Mod_LoadTexinfo(lumps[LUMP_TEXINFO].fileofs, lumps[LUMP_TEXINFO].filelen);
  Mod_LoadFaces(lumps[LUMP_FACES].fileofs, lumps[LUMP_FACES].filelen, wide);
  Mod_LoadMarksurfaces(
    lumps[LUMP_MARKSURFACES].fileofs,
    lumps[LUMP_MARKSURFACES].filelen,
    wide,
  );
  Mod_LoadVisibility(
    lumps[LUMP_VISIBILITY].fileofs,
    lumps[LUMP_VISIBILITY].filelen,
  );
  Mod_LoadLeafs(lumps[LUMP_LEAFS].fileofs, lumps[LUMP_LEAFS].filelen, bsp2);
  Mod_LoadNodes(lumps[LUMP_NODES].fileofs, lumps[LUMP_NODES].filelen, bsp2);
  Mod_LoadClipnodes(
    lumps[LUMP_CLIPNODES].fileofs,
    lumps[LUMP_CLIPNODES].filelen,
    wide,
  );
  Mod_LoadEntities(lumps[LUMP_ENTITIES].fileofs, lumps[LUMP_ENTITIES].filelen);
  Mod_LoadSubmodels(lumps[LUMP_MODELS].fileofs, lumps[LUMP_MODELS].filelen);

  bspx_lumps = null; // the table is only valid while mod_base is

  Mod_MakeHull0();

  mod.numframes = 2; // regular and alternate animation

  Mod_CheckWaterVis();

  // set up the submodels (FIXME: this is confusing)
  for (let i = 0; i < mod.numsubmodels; i++) {
    const bm = mod.submodels[i];

    mod.hulls[0].firstclipnode = bm.headnode[0];
    for (let j = 1; j < MAX_MAP_HULLS; j++) {
      mod.hulls[j].firstclipnode = bm.headnode[j];
      mod.hulls[j].lastclipnode = mod.numclipnodes - 1;
    }

    mod.firstmodelsurface = bm.firstface;
    mod.nummodelsurfaces = bm.numfaces;

    VectorCopy(bm.maxs, mod.maxs);
    VectorCopy(bm.mins, mod.mins);

    mod.radius = RadiusFromBounds(mod.mins, mod.maxs);

    mod.numleafs = bm.visleafs;

    if (i < mod.numsubmodels - 1) {
      // duplicate the basic information
      const name = "*" + (i + 1);
      const nextmodel = Mod_FindName(name);

      // Copy all properties
      nextmodel.type = mod.type;
      nextmodel.contentstransparent = mod.contentstransparent; // C copies the whole struct
      nextmodel.numframes = mod.numframes;
      nextmodel.synctype = mod.synctype;
      nextmodel.flags = mod.flags;
      VectorCopy(mod.mins, nextmodel.mins);
      VectorCopy(mod.maxs, nextmodel.maxs);
      nextmodel.radius = mod.radius;
      nextmodel.clipbox = mod.clipbox;
      VectorCopy(mod.clipmins, nextmodel.clipmins);
      VectorCopy(mod.clipmaxs, nextmodel.clipmaxs);
      nextmodel.firstmodelsurface = mod.firstmodelsurface;
      nextmodel.nummodelsurfaces = mod.nummodelsurfaces;
      nextmodel.numsubmodels = mod.numsubmodels;
      nextmodel.submodels = mod.submodels;
      nextmodel.numplanes = mod.numplanes;
      nextmodel.planes = mod.planes;
      nextmodel.numleafs = mod.numleafs;
      nextmodel.leafs = mod.leafs;
      nextmodel.numvertexes = mod.numvertexes;
      nextmodel.vertexes = mod.vertexes;
      nextmodel.numedges = mod.numedges;
      nextmodel.edges = mod.edges;
      nextmodel.numnodes = mod.numnodes;
      nextmodel.nodes = mod.nodes;
      nextmodel.numtexinfo = mod.numtexinfo;
      nextmodel.texinfo = mod.texinfo;
      nextmodel.numsurfaces = mod.numsurfaces;
      nextmodel.surfaces = mod.surfaces;
      nextmodel.numsurfedges = mod.numsurfedges;
      nextmodel.surfedges = mod.surfedges;
      nextmodel.numclipnodes = mod.numclipnodes;
      nextmodel.clipnodes = mod.clipnodes;
      nextmodel.nummarksurfaces = mod.nummarksurfaces;
      nextmodel.marksurfaces = mod.marksurfaces;
      for (let h = 0; h < MAX_MAP_HULLS; h++) {
        nextmodel.hulls[h].clipnodes = mod.hulls[h].clipnodes;
        nextmodel.hulls[h].planes = mod.hulls[h].planes;
        nextmodel.hulls[h].firstclipnode = mod.hulls[h].firstclipnode;
        nextmodel.hulls[h].lastclipnode = mod.hulls[h].lastclipnode;
        VectorCopy(mod.hulls[h].clip_mins, nextmodel.hulls[h].clip_mins);
        VectorCopy(mod.hulls[h].clip_maxs, nextmodel.hulls[h].clip_maxs);
      }

      nextmodel.numtextures = mod.numtextures;
      nextmodel.textures = mod.textures;
      nextmodel.visdata = mod.visdata;
      nextmodel.lightdata = mod.lightdata;
      nextmodel.litfile = mod.litfile;
      nextmodel.entities = mod.entities;
      nextmodel.needload = false;

      nextmodel.name = name;
      set_loadmodel(nextmodel);
      mod = nextmodel;
    }
  }
}
