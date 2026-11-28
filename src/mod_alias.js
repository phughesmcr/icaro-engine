// Ported from: WinQuake/gl_model.c (ALIAS MODELS), with Mod_SetExtraFlags
// and the MD5 replacement lookup from QuakeSpasm/Ironwail gl_model.c
// Parses a .mdl into an aliashdr_t. Skins, display lists and MD5 meshes are
// made through gl_model_upload.js; this module does not import three.
// Split out of gl_model.js, which re-exports its public names.

import {
  ALIAS_BASE_SIZE_RATIO,
  ALIAS_SINGLE,
  ALIAS_SKIN_SINGLE,
  ALIAS_VERSION,
  aliashdr_t,
  maliasframedesc_t,
  MAX_LBM_HEIGHT,
  MAX_SKINS,
  MAXALIASFRAMES,
  MAXALIASTRIS,
  MAXALIASVERTS,
  MF_HOLEY,
  mod_alias,
  MOD_NOLERP,
  mtriangle_t,
  stvert_t,
} from "./mod_types.js";
import { loadmodel, readString, set_loadmodel } from "./model.js";
import {
  GL_LoadExternalSkin,
  GL_LoadTexture,
  GL_MakeAliasModelDisplayLists,
  Mod_LoadMD5MeshModel,
} from "./gl_model_upload.js";
import { Sys_Error } from "./sys.js";
import { COM_StripExtension, Con_DPrintf, Con_Printf } from "./common.js";
import { vid } from "./vid.js";
import { COM_EnsureFile, COM_FileExists, COM_FindFile } from "./pak.js";
import { r_nolerp_list } from "./render.js";
import { ca_dedicated, cls } from "./client.js";

// Alias model globals
export let pheader = null;
export const stverts = [];
export const triangles = [];
export const poseverts = [];
let posenum = 0;

// Initialize alias arrays
for (let i = 0; i < MAXALIASVERTS; i++) {
  stverts[i] = new stvert_t();
}
for (let i = 0; i < MAXALIASTRIS; i++) {
  triangles[i] = new mtriangle_t();
}

//                        ALIAS MODELS

// Mod_LoadAliasFrame

function Mod_LoadAliasFrame(buf, offset, frame) {
  // daliasframe_t: bboxmin (4 bytes), bboxmax (4 bytes), name (16 bytes) = 24 bytes
  const bytes = new Uint8Array(buf, offset);
  frame.bboxmin.v[0] = bytes[0];
  frame.bboxmin.v[1] = bytes[1];
  frame.bboxmin.v[2] = bytes[2];
  frame.bboxmax.v[0] = bytes[4];
  frame.bboxmax.v[1] = bytes[5];
  frame.bboxmax.v[2] = bytes[6];

  frame.name = readString(new Uint8Array(buf), offset + 8, 16);

  frame.firstpose = posenum;
  frame.numposes = 1;

  // Deliberate deviation (QuakeSpasm): the C has no check
  if (posenum >= MAXALIASFRAMES) {
    Sys_Error("posenum >= MAXALIASFRAMES");
  }

  // trivertx_t data follows the header
  const SIZEOF_DALIASFRAME = 24; // bboxmin(4) + bboxmax(4) + name(16)
  const pinframe = offset + SIZEOF_DALIASFRAME;

  poseverts[posenum] = { buffer: buf, offset: pinframe };
  posenum++;

  const SIZEOF_TRIVERTX = 4; // v[3] + lightnormalindex
  return pinframe + pheader.numverts * SIZEOF_TRIVERTX;
}

// Mod_LoadAliasGroup

function Mod_LoadAliasGroup(buf, offset, frame) {
  const view = new DataView(buf, offset);

  // daliasgroup_t: int numframes, trivertx_t bboxmin, trivertx_t bboxmax = 12 bytes
  const numframes = view.getInt32(0, true);

  frame.firstpose = posenum;
  frame.numposes = numframes;

  const bytes = new Uint8Array(buf, offset);
  frame.bboxmin.v[0] = bytes[4];
  frame.bboxmin.v[1] = bytes[5];
  frame.bboxmin.v[2] = bytes[6];
  frame.bboxmax.v[0] = bytes[8];
  frame.bboxmax.v[1] = bytes[9];
  frame.bboxmax.v[2] = bytes[10];

  const SIZEOF_DALIASGROUP = 12;
  const SIZEOF_DALIASINTERVAL = 4; // float interval

  // Read interval from first interval
  const intervalView = new DataView(buf, offset + SIZEOF_DALIASGROUP);
  frame.interval = intervalView.getFloat32(0, true);

  // Skip past all intervals
  let ptemp = offset + SIZEOF_DALIASGROUP + numframes * SIZEOF_DALIASINTERVAL;

  const SIZEOF_DALIASFRAME = 24;
  const SIZEOF_TRIVERTX = 4;

  for (let i = 0; i < numframes; i++) {
    // Deliberate deviation (QuakeSpasm): the C has no check
    if (posenum >= MAXALIASFRAMES) {
      Sys_Error("posenum >= MAXALIASFRAMES");
    }

    poseverts[posenum] = { buffer: buf, offset: ptemp + SIZEOF_DALIASFRAME };
    posenum++;

    ptemp = ptemp + SIZEOF_DALIASFRAME + pheader.numverts * SIZEOF_TRIVERTX;
  }

  return ptemp;
}

// Mod_FloodFillSkin
//
// Fill background pixels so mipmapping doesn't have haloes - Ed

function Mod_FloodFillSkin(skin, skinwidth, skinheight) {
  const fillcolor = skin[0];
  const FLOODFILL_FIFO_SIZE = 0x1000;
  const FLOODFILL_FIFO_MASK = FLOODFILL_FIFO_SIZE - 1;

  const fifo_x = new Int16Array(FLOODFILL_FIFO_SIZE);
  const fifo_y = new Int16Array(FLOODFILL_FIFO_SIZE);
  let inpt = 0, outpt = 0;

  const filledcolor = 0;
  // attempt to find opaque black (simplified; Quake uses d_8to24table)
  // For now just use 0

  if (fillcolor === filledcolor || fillcolor === 255) {
    return;
  }

  fifo_x[inpt] = 0;
  fifo_y[inpt] = 0;
  inpt = (inpt + 1) & FLOODFILL_FIFO_MASK;

  while (outpt !== inpt) {
    const x = fifo_x[outpt];
    const y = fifo_y[outpt];
    let fdc = filledcolor;
    const posOfs = x + skinwidth * y;

    outpt = (outpt + 1) & FLOODFILL_FIFO_MASK;

    // FLOODFILL_STEP macro equivalent for each direction
    if (x > 0) {
      if (skin[posOfs - 1] === fillcolor) {
        skin[posOfs - 1] = 255;
        fifo_x[inpt] = x - 1;
        fifo_y[inpt] = y;
        inpt = (inpt + 1) & FLOODFILL_FIFO_MASK;
      } else if (skin[posOfs - 1] !== 255) {
        fdc = skin[posOfs - 1];
      }
    }

    if (x < skinwidth - 1) {
      if (skin[posOfs + 1] === fillcolor) {
        skin[posOfs + 1] = 255;
        fifo_x[inpt] = x + 1;
        fifo_y[inpt] = y;
        inpt = (inpt + 1) & FLOODFILL_FIFO_MASK;
      } else if (skin[posOfs + 1] !== 255) {
        fdc = skin[posOfs + 1];
      }
    }

    if (y > 0) {
      if (skin[posOfs - skinwidth] === fillcolor) {
        skin[posOfs - skinwidth] = 255;
        fifo_x[inpt] = x;
        fifo_y[inpt] = y - 1;
        inpt = (inpt + 1) & FLOODFILL_FIFO_MASK;
      } else if (skin[posOfs - skinwidth] !== 255) {
        fdc = skin[posOfs - skinwidth];
      }
    }

    if (y < skinheight - 1) {
      if (skin[posOfs + skinwidth] === fillcolor) {
        skin[posOfs + skinwidth] = 255;
        fifo_x[inpt] = x;
        fifo_y[inpt] = y + 1;
        inpt = (inpt + 1) & FLOODFILL_FIFO_MASK;
      } else if (skin[posOfs + skinwidth] !== 255) {
        fdc = skin[posOfs + skinwidth];
      }
    }

    skin[x + skinwidth * y] = fdc;
  }
}

// Mod_LoadAllSkins

// Deliberate deviation (QuakeSpasm, gl_fullbrights 1): GLQuake has no
// fullbright pass on alias models, so glowing eyes and lights went dark in
// shade. Each skin also gets a fullbright mask (gl_mesh.js AliasMaterial).
function Mod_LoadAllSkins(buf, numskins, offset) {
  if (numskins < 1 || numskins > MAX_SKINS) {
    Sys_Error("Mod_LoadAliasModel: Invalid # of skins: " + numskins);
  }

  const s = pheader.skinwidth * pheader.skinheight;
  const SIZEOF_DALIASSKINTYPE = 4; // int type
  // no palette (the Deno server never runs VID_Init): no masks to make
  const splitFullbright = vid.fullbright > 0;
  // MF_HOLEY (QuakeSpasm/Ironwail TEXPREF_ALPHA): index 255 is transparent;
  // gl_mesh.js alpha-tests these skins
  const holey = (loadmodel.flags & MF_HOLEY) !== 0;

  let pos = offset;

  for (let i = 0; i < numskins; i++) {
    const view = new DataView(buf, pos);
    const skintype = view.getInt32(0, true);

    if (skintype === ALIAS_SKIN_SINGLE) {
      // Skin data starts after the type int
      const skinDataOfs = pos + SIZEOF_DALIASSKINTYPE;
      const skin = new Uint8Array(buf, skinDataOfs, s);

      // a dedicated server never draws or remaps a skin
      if (cls.state !== ca_dedicated) {
        Mod_FloodFillSkin(skin, pheader.skinwidth, pheader.skinheight);

        // Save 8 bit texels for player model remapping
        pheader.texels[i] = new Uint8Array(s);
        pheader.texels[i].set(skin);
      }

      const name = loadmodel.name + "_" + i;
      pheader.gl_texturenum[i][0] =
        pheader.gl_texturenum[i][1] =
        pheader.gl_texturenum[i][2] =
        pheader.gl_texturenum[i][3] =
          GL_LoadTexture(
            name,
            pheader.skinwidth,
            pheader.skinheight,
            skin,
            true,
            holey,
            splitFullbright,
            true,
          );
      if (cls.state !== ca_dedicated) { // QSS external skins
        GL_LoadExternalSkin(pheader.gl_texturenum[i][0], name);
      }

      pos = skinDataOfs + s;
    } else {
      // animating skin group
      pos += SIZEOF_DALIASSKINTYPE;
      const groupView = new DataView(buf, pos);
      const groupskins = groupView.getInt32(0, true); // daliasskingroup_t.numskins
      const SIZEOF_DALIASSKINGROUP = 4;
      const SIZEOF_DALIASSKININTERVAL = 4;

      pos += SIZEOF_DALIASSKINGROUP + groupskins * SIZEOF_DALIASSKININTERVAL;

      for (let j = 0; j < groupskins; j++) {
        const skin = new Uint8Array(buf, pos, s);
        if (cls.state !== ca_dedicated) {
          Mod_FloodFillSkin(skin, pheader.skinwidth, pheader.skinheight);
        }

        if (j === 0 && cls.state !== ca_dedicated) {
          pheader.texels[i] = new Uint8Array(s);
          pheader.texels[i].set(skin);
        }

        const name = loadmodel.name + "_" + i + "_" + j;
        pheader.gl_texturenum[i][j & 3] = GL_LoadTexture(
          name,
          pheader.skinwidth,
          pheader.skinheight,
          skin,
          true,
          holey,
          splitFullbright,
          true,
        );

        pos += s;
      }

      // fill remaining texture slots
      for (let j = groupskins; j < 4; j++) {
        pheader.gl_texturenum[i][j & 3] =
          pheader.gl_texturenum[i][j - groupskins];
      }
    }
  }

  return pos;
}

// Mod_LoadAliasModel

export function Mod_LoadAliasModel(mod, buffer) {
  const view = new DataView(buffer);

  // mdl_t header
  const version = view.getInt32(4, true);
  if (version !== ALIAS_VERSION) {
    Sys_Error(
      mod.name + " has wrong version number (" + version + " should be " +
        ALIAS_VERSION + ")",
    );
  }

  const numframes = view.getInt32(68, true); // offset of numframes in mdl_t

  // Allocate header
  pheader = new aliashdr_t();
  pheader.frames = [];

  for (let i = 0; i < numframes; i++) {
    pheader.frames[i] = new maliasframedesc_t();
  }

  mod.flags = view.getInt32(72, true);

  // Copy header data from mdl_t
  // mdl_t layout: ident(4), version(4), scale(12), scale_origin(12), boundingradius(4),
  // eyeposition(12), numskins(4), skinwidth(4), skinheight(4), numverts(4), numtris(4),
  // numframes(4), synctype(4), flags(4), size(4) = total 84 bytes
  pheader.boundingradius = view.getFloat32(32, true);

  // mdl_t offsets:
  // int ident = 0
  // int version = 4
  // vec3_t scale = 8, 12, 16
  // vec3_t scale_origin = 20, 24, 28
  // float boundingradius = 32
  // vec3_t eyeposition = 36, 40, 44
  // int numskins = 48
  // int skinwidth = 52
  // int skinheight = 56
  // int numverts = 60
  // int numtris = 64
  // int numframes = 68
  // synctype_t synctype = 72
  // int flags = 76
  // float size = 80
  // total = 84

  pheader.numskins = view.getInt32(48, true);
  pheader.skinwidth = view.getInt32(52, true);
  pheader.skinheight = view.getInt32(56, true);
  pheader.numverts = view.getInt32(60, true);
  pheader.numtris = view.getInt32(64, true);
  pheader.numframes = view.getInt32(68, true);

  // Deliberate deviation (QuakeSpasm): a developer warning, not Sys_Error.
  // No buffer in the port is sized by MAX_LBM_HEIGHT.
  if (pheader.skinheight > MAX_LBM_HEIGHT) {
    Con_DPrintf(
      "model " + mod.name + " has a skin taller than " + MAX_LBM_HEIGHT + "\n",
    );
  }
  if (pheader.numverts <= 0) {
    Sys_Error("model " + mod.name + " has no vertices");
  }
  if (pheader.numverts > MAXALIASVERTS) {
    Sys_Error("model " + mod.name + " has too many vertices");
  }
  if (pheader.numtris <= 0) {
    Sys_Error("model " + mod.name + " has no triangles");
  }
  // Deliberate deviation (QuakeSpasm): the C has no check, and the
  // triangles array (and gl_mesh.js's BuildTris buffers) hold MAXALIASTRIS
  if (pheader.numtris > MAXALIASTRIS) {
    Sys_Error("model " + mod.name + " has too many triangles");
  }
  if (pheader.numframes < 1) {
    Sys_Error("Mod_LoadAliasModel: Invalid # of frames: " + pheader.numframes);
  }

  pheader.size = view.getFloat32(80, true) * ALIAS_BASE_SIZE_RATIO;
  mod.synctype = view.getInt32(72, true);
  mod.numframes = pheader.numframes;
  mod.flags = view.getInt32(76, true);

  for (let i = 0; i < 3; i++) {
    pheader.scale[i] = view.getFloat32(8 + i * 4, true);
    pheader.scale_origin[i] = view.getFloat32(20 + i * 4, true);
    pheader.eyeposition[i] = view.getFloat32(36 + i * 4, true);
  }

  pheader.boundingradius = view.getFloat32(32, true);

  // Initialize frames array
  pheader.frames = [];
  for (let i = 0; i < pheader.numframes; i++) {
    pheader.frames[i] = new maliasframedesc_t();
  }

  // load the skins
  const SIZEOF_MDL = 84;
  let pos = Mod_LoadAllSkins(buffer, pheader.numskins, SIZEOF_MDL);

  // load base s and t vertices
  // stvert_t: int onseam, int s, int t = 12 bytes
  const SIZEOF_STVERT = 12;
  for (let i = 0; i < pheader.numverts; i++) {
    const o = pos + i * SIZEOF_STVERT;
    stverts[i].onseam = view.getInt32(o, true);
    stverts[i].s = view.getInt32(o + 4, true);
    stverts[i].t = view.getInt32(o + 8, true);
  }

  pos += pheader.numverts * SIZEOF_STVERT;

  // load triangle lists
  // dtriangle_t: int facesfront, int vertindex[3] = 16 bytes
  const SIZEOF_DTRIANGLE = 16;
  for (let i = 0; i < pheader.numtris; i++) {
    const o = pos + i * SIZEOF_DTRIANGLE;
    triangles[i].facesfront = view.getInt32(o, true);
    for (let j = 0; j < 3; j++) {
      triangles[i].vertindex[j] = view.getInt32(o + 4 + j * 4, true);
    }
  }

  pos += pheader.numtris * SIZEOF_DTRIANGLE;

  // load the frames
  posenum = 0;
  const SIZEOF_DALIASFRAMETYPE = 4; // int type

  for (let i = 0; i < pheader.numframes; i++) {
    const ftView = new DataView(buffer, pos);
    const frametype = ftView.getInt32(0, true);

    if (frametype === ALIAS_SINGLE) {
      pos = Mod_LoadAliasFrame(
        buffer,
        pos + SIZEOF_DALIASFRAMETYPE,
        pheader.frames[i],
      );
    } else {
      pos = Mod_LoadAliasGroup(
        buffer,
        pos + SIZEOF_DALIASFRAMETYPE,
        pheader.frames[i],
      );
    }
  }

  pheader.numposes = posenum;

  mod.type = mod_alias;

  // FIXME: do this right
  mod.mins[0] = mod.mins[1] = mod.mins[2] = -16;
  mod.maxs[0] = mod.maxs[1] = mod.maxs[2] = 16;

  // Not in the C: a dedicated server never draws, and nothing else reads
  // the decoded vertices or the display lists (posedata, commands and the
  // cull sphere are renderer data), so it skips building them
  if (cls.state !== ca_dedicated) {
    // Decode poseverts from raw {buffer, offset} into arrays of trivertx_t objects
    // so that GL_MakeAliasModelDisplayLists can index them
    const decodedPoseverts = [];
    for (let i = 0; i < pheader.numposes; i++) {
      const pv = poseverts[i];
      const verts = [];
      const data = new Uint8Array(pv.buffer);
      for (let j = 0; j < pheader.numverts; j++) {
        const off = pv.offset + j * 4; // trivertx_t = 4 bytes: v[3] + lightnormalindex
        verts.push({
          v: [data[off], data[off + 1], data[off + 2]],
          lightnormalindex: data[off + 3],
        });
      }

      decodedPoseverts.push(verts);
    }

    // Wire up data needed by GL_MakeAliasModelDisplayLists
    pheader.triangles = triangles;
    pheader.stverts = stverts;
    pheader.poseverts = decodedPoseverts;

    // build the draw lists
    GL_MakeAliasModelDisplayLists(mod, pheader);
  }

  // move the complete, relocatable alias model to the cache
  mod.cache.data = pheader;

  Mod_SetExtraFlags(mod); //johnfitz

  // Ironwail: an .md5mesh beside the .mdl replaces it (see
  // Mod_LoadMD5Replacement for what the .mdl still does)
  mod.md5state = MD5_UNTRIED;
  mod.md5hdr = null;
  if (r_enhancedmodels.value !== 0) {
    Mod_LoadMD5Replacement(mod);
  }
}

/**
 * Deliberate deviation, from Ironwail (gl_model.c): draw the 2021 rerelease's
 * MD5 replacement models (gl_md5.js) where there is one. Ironwail defaults it
 * to 1, and so does this port: only rerelease data has .md5mesh files, so it
 * changes nothing for the original game. Ironwail reloads every alias model
 * when it changes; here the .mdl is always loaded and the choice is made when
 * an entity is drawn (Mod_EnhancedAliasHeader). Ironwail's
 * r_enhancedmodels_priority picks between MD3 and MD5; the port has no MD3
 * loader, so it is not ported.
 */
export const r_enhancedmodels = {
  name: "r_enhancedmodels",
  string: "1",
  value: 1,
  archive: true,
};

// model_t.md5state
export const MD5_UNTRIED = 0; // not looked for yet (r_enhancedmodels was 0)
export const MD5_PENDING = 1; // its files are being fetched
export const MD5_DONE = 2; // looked for: md5hdr is the model, or null

const md5decoder = new TextDecoder("latin1");

/**
 * Ironwail loadMd5Replacement: use progs/<name>.md5mesh, with its .md5anim,
 * when it is in the same game directory as the .mdl or a later one. Unlike
 * Ironwail, which loads the MD5 instead of the .mdl, the .mdl is loaded as
 * before and stays the model's cache data: the server (setmodel, the bounds),
 * the frame names and the flags read it, and the renderer draws md5hdr in
 * its place (Mod_EnhancedAliasHeader). A dedicated server never draws, so it
 * does not look.
 *
 * A lazily opened pak (pak.js) defers .md5mesh and .md5anim entries; they
 * are fetched here with COM_EnsureFile, and the .mdl is drawn until they
 * arrive. The skins (.lmp) are fetched with the pak.
 */
export function Mod_LoadMD5Replacement(mod) {
  if (mod.md5state !== MD5_UNTRIED) {
    return;
  }
  mod.md5state = MD5_DONE;
  mod.md5hdr = null;
  if (cls.state === ca_dedicated) {
    return;
  }

  const base = COM_StripExtension(mod.name);
  const meshname = base + ".md5mesh";
  const animname = base + ".md5anim";
  const md5_path_id = COM_FileExists(meshname);
  if (md5_path_id < 0 || md5_path_id < COM_FileExists(mod.name)) {
    return;
  }

  const animExists = COM_FileExists(animname) >= 0;
  if (
    COM_FindFile(meshname) === null ||
    (animExists && COM_FindFile(animname) === null)
  ) {
    mod.md5state = MD5_PENDING;
    Promise.all([
      COM_EnsureFile(meshname),
      animExists ? COM_EnsureFile(animname) : true,
    ]).then(() => {
      mod.md5state = MD5_DONE;
      Mod_LoadMD5Files(mod, meshname, animname);
    }).catch((e) => Con_Printf("Warning: %s: %s\n", meshname, e.message));
    return;
  }

  Mod_LoadMD5Files(mod, meshname, animname);
}

// Mod_LoadMD5Replacement once the files are in the search path. A missing
// .md5anim fails the load as in Ironwail ("has no poses").
function Mod_LoadMD5Files(mod, meshname, animname) {
  const mesh = COM_FindFile(meshname);
  if (mesh === null) {
    return;
  }
  const anim = COM_FindFile(animname);

  // GL_LoadTexture gives the skins to loadmodel, which a fetch may have
  // left on another model
  const oldloadmodel = loadmodel;
  set_loadmodel(mod);
  try {
    mod.md5hdr = Mod_LoadMD5MeshModel(
      mod,
      md5decoder.decode(mesh.data),
      anim !== null ? md5decoder.decode(anim.data) : null,
    );
  } finally {
    set_loadmodel(oldloadmodel);
  }

  if (mod.md5hdr !== null) {
    Con_DPrintf("%s replaced by %s\n", mod.name, meshname);
  }
}

/**
 * Not in the C. The alias header to draw mod with: its MD5 replacement when
 * r_enhancedmodels is on and it has one, else the .mdl's. Turning
 * r_enhancedmodels on looks for replacements the first time each model is
 * drawn.
 */
export function Mod_EnhancedAliasHeader(mod) {
  const hdr = mod.cache.data;
  if (r_enhancedmodels.value === 0 || mod.type !== mod_alias) {
    return hdr;
  }
  if (mod.md5state === MD5_UNTRIED) {
    Mod_LoadMD5Replacement(mod);
  }
  return mod.md5hdr != null ? mod.md5hdr : hdr;
}

/**
 * Ported from: QuakeSpasm gl_model.c. Is name one of the comma-separated
 * entries in list?
 */
export function nameInList(list, name) {
  let s = 0;
  while (s < list.length) {
    // make a copy until the next comma or end of string
    let e = list.indexOf(",", s);
    if (e === -1) {
      e = list.length;
    }
    //compare it to the model name
    if (e - s === name.length && list.startsWith(name, s)) {
      return true;
    }
    //search forwards to the next comma or end of string
    s = e;
    while (s < list.length && list.charCodeAt(s) === 44) { // ','
      s++;
    }
  }

  return false;
}

// Mod_SetExtraFlags -- johnfitz -- set up extra flags that aren't in the mdl
//
// Ported from: QuakeSpasm gl_model.c (only MOD_NOLERP: r_noshadow_list and
// the fullbright hack are not ported). QS reruns it from a cvar callback when
// r_nolerp_list changes; this port's cvars have no callbacks, so gl_mesh.js
// R_SetupAliasFrame reruns it when the list string differs from the one the
// flags were built from.
export function Mod_SetExtraFlags(mod) {
  if (mod == null || mod.type !== mod_alias) {
    return;
  }

  mod.flags &= ~MOD_NOLERP; // QS keeps the mdl's first byte (plus MF_HOLEY)

  // nolerp flag
  if (nameInList(r_nolerp_list.string, mod.name)) {
    mod.flags |= MOD_NOLERP;
  }

  mod.extraflags_list = r_nolerp_list.string;
}
