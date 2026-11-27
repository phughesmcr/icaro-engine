// Ported from: WinQuake/gl_model.c (SPRITE MODELS)
// Parses a .spr into an msprite_t. Frame textures are made through
// gl_model_upload.js; this module does not import three.
// Split out of gl_model.js.

import {
  mod_sprite,
  msprite_t,
  mspriteframe_t,
  mspriteframedesc_t,
  mspritegroup_t,
  SPR_SINGLE,
  SPRITE_VERSION,
} from "./mod_types.js";
import { loadmodel } from "./model.js";
import { GL_LoadTexture } from "./gl_model_upload.js";
import { Sys_Error } from "./sys.js";

//                        SPRITE MODELS

// Mod_LoadSpriteFrame

function Mod_LoadSpriteFrame(buf, offset, framenum) {
  const view = new DataView(buf, offset);

  // dspriteframe_t: int origin[2], int width, int height = 16 bytes
  const width = view.getInt32(8, true);
  const height = view.getInt32(12, true);
  const size = width * height;

  const pspriteframe = new mspriteframe_t();

  pspriteframe.width = width;
  pspriteframe.height = height;

  const origin0 = view.getInt32(0, true);
  const origin1 = view.getInt32(4, true);

  pspriteframe.up = origin1;
  pspriteframe.down = origin1 - height;
  pspriteframe.left = origin0;
  pspriteframe.right = width + origin0;

  const SIZEOF_DSPRITEFRAME = 16;
  const name = loadmodel.name + "_" + framenum;
  const pixelData = new Uint8Array(buf, offset + SIZEOF_DSPRITEFRAME, size);
  pspriteframe.gl_texturenum = GL_LoadTexture(
    name,
    width,
    height,
    pixelData,
    true,
    true,
  );

  return {
    frame: pspriteframe,
    nextOffset: offset + SIZEOF_DSPRITEFRAME + size,
  };
}

// Mod_LoadSpriteGroup

function Mod_LoadSpriteGroup(buf, offset, framenum) {
  const view = new DataView(buf, offset);

  // dspritegroup_t: int numframes = 4 bytes
  const numframes = view.getInt32(0, true);

  const pspritegroup = new mspritegroup_t();
  pspritegroup.numframes = numframes;

  const SIZEOF_DSPRITEGROUP = 4;
  const SIZEOF_DSPRITEINTERVAL = 4;

  // Read intervals
  pspritegroup.intervals = new Float32Array(numframes);
  let intervalOfs = offset + SIZEOF_DSPRITEGROUP;

  for (let i = 0; i < numframes; i++) {
    const iv = new DataView(buf, intervalOfs);
    pspritegroup.intervals[i] = iv.getFloat32(0, true);
    if (pspritegroup.intervals[i] <= 0.0) {
      Sys_Error("Mod_LoadSpriteGroup: interval<=0");
    }
    intervalOfs += SIZEOF_DSPRITEINTERVAL;
  }

  // Load frames
  pspritegroup.frames = new Array(numframes);
  let ptemp = intervalOfs;

  for (let i = 0; i < numframes; i++) {
    const result = Mod_LoadSpriteFrame(buf, ptemp, framenum * 100 + i);
    pspritegroup.frames[i] = result.frame;
    ptemp = result.nextOffset;
  }

  return {
    frame: pspritegroup,
    nextOffset: ptemp,
  };
}

// Mod_LoadSpriteModel

export function Mod_LoadSpriteModel(mod, buffer) {
  const view = new DataView(buffer);

  // dsprite_t: int ident, int version, int type, float boundingradius,
  //            int width, int height, int numframes, float beamlength, synctype_t synctype
  //            = 36 bytes
  const version = view.getInt32(4, true);
  if (version !== SPRITE_VERSION) {
    Sys_Error(
      mod.name + " has wrong version number (" + version + " should be " +
        SPRITE_VERSION + ")",
    );
  }

  const numframes = view.getInt32(24, true);

  const psprite = new msprite_t();
  mod.cache.data = psprite;

  psprite.type = view.getInt32(8, true);
  psprite.maxwidth = view.getInt32(16, true);
  psprite.maxheight = view.getInt32(20, true);
  psprite.beamlength = view.getFloat32(28, true);
  mod.synctype = view.getInt32(32, true);
  psprite.numframes = numframes;

  // C int division (maxwidth and maxheight are ints)
  mod.mins[0] = mod.mins[1] = (-psprite.maxwidth / 2) | 0;
  mod.maxs[0] = mod.maxs[1] = (psprite.maxwidth / 2) | 0;
  mod.mins[2] = (-psprite.maxheight / 2) | 0;
  mod.maxs[2] = (psprite.maxheight / 2) | 0;

  // load the frames
  if (numframes < 1) {
    Sys_Error("Mod_LoadSpriteModel: Invalid # of frames: " + numframes);
  }

  mod.numframes = numframes;

  psprite.frames = new Array(numframes);

  const SIZEOF_DSPRITE = 36;
  const SIZEOF_DSPRITEFRAMETYPE = 4;
  let pos = SIZEOF_DSPRITE;

  for (let i = 0; i < numframes; i++) {
    const ftView = new DataView(buffer, pos);
    const frametype = ftView.getInt32(0, true);

    const fdesc = new mspriteframedesc_t();
    fdesc.type = frametype;

    if (frametype === SPR_SINGLE) {
      const result = Mod_LoadSpriteFrame(
        buffer,
        pos + SIZEOF_DSPRITEFRAMETYPE,
        i,
      );
      fdesc.frameptr = result.frame;
      pos = result.nextOffset;
    } else {
      const result = Mod_LoadSpriteGroup(
        buffer,
        pos + SIZEOF_DSPRITEFRAMETYPE,
        i,
      );
      fdesc.frameptr = result.frame;
      pos = result.nextOffset;
    }

    psprite.frames[i] = fdesc;
  }

  mod.type = mod_sprite;
}
