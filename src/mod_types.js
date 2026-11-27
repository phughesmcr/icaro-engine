// Ported from: WinQuake/gl_model.h + modelgen.h + spritegn.h
// Model constants and the in-memory model structures (m*_t, aliashdr_t,
// msprite_t, model_t), split out of gl_model.js, which re-exports them.
// Imports nothing from the loaders or the model cache: model.js and
// mod_alias.js build these structs at module load, so this module has to
// evaluate before them.

import { MAX_DLIGHTS } from "./client.js";
import {
  MAX_MAP_HULLS,
  MAXLIGHTMAPS,
  MIPLEVELS,
  NUM_AMBIENTS,
} from "./bspfile.js";

// modelgen.h constants

export const ALIAS_VERSION = 6;
export const ALIAS_ONSEAM = 0x0020;

// synctype_t
export const ST_SYNC = 0;
export const ST_RAND = 1;

// aliasframetype_t
export const ALIAS_SINGLE = 0;
export const ALIAS_GROUP = 1;

// aliasskintype_t
export const ALIAS_SKIN_SINGLE = 0;
export const ALIAS_SKIN_GROUP = 1;

export const DT_FACES_FRONT = 0x0010;

// little-endian "IDPO"
export const IDPOLYHEADER = ("O".charCodeAt(0) << 24) +
  ("P".charCodeAt(0) << 16) + ("D".charCodeAt(0) << 8) + "I".charCodeAt(0);

export const ALIAS_BASE_SIZE_RATIO = 1.0 / 11.0;
export const MAX_LBM_HEIGHT = 480;

// spritegn.h constants

export const SPRITE_VERSION = 1;

export const SPR_VP_PARALLEL_UPRIGHT = 0;
export const SPR_FACING_UPRIGHT = 1;
export const SPR_VP_PARALLEL = 2;
export const SPR_ORIENTED = 3;
export const SPR_VP_PARALLEL_ORIENTED = 4;

// spriteframetype_t
export const SPR_SINGLE = 0;
export const SPR_GROUP = 1;

// little-endian "IDSP"
export const IDSPRITEHEADER = ("P".charCodeAt(0) << 24) +
  ("S".charCodeAt(0) << 16) + ("D".charCodeAt(0) << 8) + "I".charCodeAt(0);

// gl_model.h -- entity effects

export const EF_BRIGHTFIELD = 1;
export const EF_MUZZLEFLASH = 2;
export const EF_BRIGHTLIGHT = 4;
export const EF_DIMLIGHT = 8;

// Surface flags

export const SURF_PLANEBACK = 2;
export const SURF_DRAWSKY = 4;
export const SURF_DRAWSPRITE = 8;
export const SURF_DRAWTURB = 0x10;
export const SURF_DRAWTILED = 0x20;
export const SURF_DRAWBACKGROUND = 0x40;
export const SURF_UNDERWATER = 0x80;
// Deliberate deviation, from QuakeSpasm (gl_model.h): which liquid a
// SURF_DRAWTURB surface is, so gl_rsurf.js can give lava, slime and
// teleporters their own alpha (r_lavaalpha, r_slimealpha, r_telealpha)
export const SURF_DRAWLAVA = 0x400;
export const SURF_DRAWSLIME = 0x800;
export const SURF_DRAWTELE = 0x1000;
export const SURF_DRAWWATER = 0x2000;

// Deliberate deviation, from QuakeSpasm (gl_rmain.c): per-liquid alpha.
// 0 means "use r_wateralpha", so the defaults keep GLQuake's look. QS
// registers them in R_Init (gl_rmisc.c); here Mod_Init does.
export const r_lavaalpha = { name: "r_lavaalpha", string: "0", value: 0 };
export const r_slimealpha = { name: "r_slimealpha", string: "0", value: 0 };
export const r_telealpha = { name: "r_telealpha", string: "0", value: 0 };

// Plane sides

export const SIDE_FRONT = 0;
export const SIDE_BACK = 1;
export const SIDE_ON = 2;

// GL poly vertex size

export const VERTEXSIZE = 7;

// Model types

export const mod_brush = 0;
export const mod_sprite = 1;
export const mod_alias = 2;

// Entity effect flags (model flags from MDL header)

export const EF_ROCKET = 1; // leave a trail
export const EF_GRENADE = 2; // leave a trail
export const EF_GIB = 4; // leave a trail
export const EF_ROTATE = 8; // rotate (bonus items)
export const EF_TRACER = 16; // green split trail
export const EF_ZOMGIB = 32; // small blood trail
export const EF_TRACER2 = 64; // orange split trail + rotate
export const EF_TRACER3 = 128; // purple trail

// Deliberate deviation, from FitzQuake/QuakeSpasm (gl_model.h): flags that
// aren't in the mdl, set by Mod_SetExtraFlags.
export const MOD_NOLERP = 256; // don't lerp when animating

// Deliberate deviation, from MarkV/QSS via QuakeSpasm and Ironwail
// (gl_model.h): a model flag that makes palette index 255 transparent in
// the mdl's skins. Mods set it in the mdl header; id's models don't.
export const MF_HOLEY = 1 << 14;

// Alias model limits

export const MAX_SKINS = 32;
// Deliberate deviation: QuakeSpasm's limits, were 1024, 256 and 2048 in
// GLQuake. gl_mesh.js sizes its BuildTris buffers from MAXALIASTRIS and keeps
// its own copy of it (import cycle), so change both together.
export const MAXALIASVERTS = 2400;
export const MAXALIASFRAMES = 1024;
export const MAXALIASTRIS = 4096;

// Deliberate deviation: QuakeSpasm's surface extents limit, 512 in GLQuake
export const MAX_SURFACE_EXTENTS = 2000;

// In-memory model structures (m*_t)

// Typed-array fields can be views into a caller's slab: `new Float32Array( 3 )`
// per struct costs ~6x a view over a shared buffer in V8 (a BSP has tens of
// thousands of structs), and each backing store adds GC work. A struct built
// without a slab allocates its own, as before. Slab offsets are 4-aligned.
export class mvertex_t {
  constructor(buffer = null, byteOffset = 0) {
    this.position = buffer !== null ?
      new Float32Array(buffer, byteOffset, 3) :
      new Float32Array(3);
  }
}

export class mplane_t {
  constructor(buffer = null, byteOffset = 0) {
    this.normal = buffer !== null ?
      new Float32Array(buffer, byteOffset, 3) :
      new Float32Array(3);
    this.dist = 0;
    this.type = 0; // for texture axis selection and fast side tests
    this.signbits = 0; // signx + signy<<1 + signz<<2
  }
}

export class texture_t {
  constructor() {
    this.name = "";
    this.width = 0;
    this.height = 0;
    this.gl_texturenum = 0;
    this.texturechain = null; // for gl_texsort drawing
    this.anim_total = 0; // total tenths in sequence ( 0 = no)
    this.anim_min = 0;
    this.anim_max = 0;
    this.anim_next = null; // in the animation sequence
    this.alternate_anims = null; // bmodels in frame 1 use these
    this.offsets = new Uint32Array(MIPLEVELS); // four mip maps stored
    this.pixels = null; // Uint8Array of raw pixel data
  }
}

export class medge_t {
  constructor(buffer = null, byteOffset = 0) {
    // Deliberate deviation (Ironwail medge_t): unsigned int vertex
    // numbers, so BSP2 maps with more than 65535 vertexes load. The C
    // holds unsigned shorts.
    this.v = buffer !== null ?
      new Uint32Array(buffer, byteOffset, 2) :
      new Uint32Array(2);
    this.cachededgeoffset = 0;
  }
}

export class mtexinfo_t {
  constructor() {
    this.vecs = [
      new Float32Array(4),
      new Float32Array(4),
    ];
    this.mipadjust = 0;
    this.texture = null;
    this.flags = 0;
  }
}

export class glpoly_t {
  constructor() {
    this.next = null;
    this.chain = null;
    this.numverts = 0;
    this.flags = 0; // for SURF_UNDERWATER
    this.verts = []; // array of Float32Array(VERTEXSIZE) -- variable sized (xyz s1t1 s2t2)
  }
}

// Bytes of typed-array storage per msurface_t slab slot, in the order
// texturemins (Int32 x2), cached_light (Int32 x MAXLIGHTMAPS), dlightbits
// (Uint32 words), extents (Int16 x2), styles (Uint8 x MAXLIGHTMAPS)
// (a function: MAX_DLIGHTS comes from client.js, which is in an import cycle)
export function MSURFACE_SLAB_BYTES() {
  return 8 + MAXLIGHTMAPS * 4 + ((MAX_DLIGHTS + 31) >> 5) * 4 + 4 +
    ((MAXLIGHTMAPS + 3) & ~3);
}

export class msurface_t {
  constructor(buffer = null, byteOffset = 0) {
    this.visframe = 0; // should be drawn when node is crossed

    this.plane = null;
    this.flags = 0;

    this.firstedge = 0; // look up in model->surfedges[], negative numbers
    this.numedges = 0; // are backwards edges

    // Deliberate deviation (Ironwail, gl_model.h): texturemins is
    // `int`, not id's `short`. Large BSP2 maps (the rerelease's mg3
    // map7) have texture-space minimums beyond +-32768, which wrap in
    // 16 bits and move the lightmap origin. Values that fit in a short
    // (all of id's maps) are unchanged. extents stays `short`, as in
    // Ironwail: lightmapped faces are capped at MAX_SURFACE_EXTENTS.
    const dlightwords = (MAX_DLIGHTS + 31) >> 5;
    if (buffer !== null) {
      this.texturemins = new Int32Array(buffer, byteOffset, 2);
      this.cached_light = new Int32Array(buffer, byteOffset + 8, MAXLIGHTMAPS); // values currently used in lightmap
      this.dlightbits = new Uint32Array(
        buffer,
        byteOffset + 8 + MAXLIGHTMAPS * 4,
        dlightwords,
      );
      this.extents = new Int16Array(
        buffer,
        byteOffset + 8 + MAXLIGHTMAPS * 4 + dlightwords * 4,
        2,
      );
      this.styles = new Uint8Array(
        buffer,
        byteOffset + 12 + MAXLIGHTMAPS * 4 + dlightwords * 4,
        MAXLIGHTMAPS,
      );
    } else {
      this.texturemins = new Int32Array(2);
      this.cached_light = new Int32Array(MAXLIGHTMAPS);
      this.dlightbits = new Uint32Array(dlightwords);
      this.extents = new Int16Array(2);
      this.styles = new Uint8Array(MAXLIGHTMAPS);
    }

    this.light_s = 0;
    this.light_t = 0; // gl lightmap coordinates

    this.polys = null; // multiple if warped
    this.texturechain = null;

    this.texinfo = null;

    // lighting info
    this.dlightframe = 0;
    // QuakeSpasm: one bit per dynamic light, in 32-bit words (dlightbits, above)

    this.lightmaptexturenum = 0;
    this.cached_dlight = false; // true if dynamic light in cache
    this.samples = null; // Uint8Array -- [numstyles*surfsize]
    this.sampleOffset = 0; // offset into lightdata
    // Not in C: samples are RGB triplets from a .lit (see Mod_LoadLighting)
    this.rgbsamples = false;
  }
}

export class mnode_t {
  constructor(buffer = null, byteOffset = 0) {
    // common with leaf
    this.contents = 0; // 0, to differentiate from leafs
    this.visframe = 0; // node needs to be traversed if current

    this.minmaxs = buffer !== null ?
      new Float32Array(buffer, byteOffset, 6) :
      new Float32Array(6); // for bounding box culling

    this.parent = null;

    // node specific
    this.plane = null;
    this.children = [null, null];

    this.firstsurface = 0;
    this.numsurfaces = 0;
  }
}

// minmaxs (Float32 x6) then ambient_sound_level (Uint8 x NUM_AMBIENTS)
export function MLEAF_SLAB_BYTES() {
  return 24 + ((NUM_AMBIENTS + 3) & ~3);
}

export class mleaf_t {
  constructor(buffer = null, byteOffset = 0) {
    // common with node
    this.contents = 0; // will be a negative contents number
    this.visframe = 0; // node needs to be traversed if current

    this.minmaxs = buffer !== null ?
      new Float32Array(buffer, byteOffset, 6) :
      new Float32Array(6); // for bounding box culling

    this.parent = null;
    this._leafIndex = 0; // set by Mod_LoadLeafs; declared here so the shape doesn't change

    // leaf specific
    this.compressed_vis = null; // Uint8Array slice
    this.compressed_vis_offset = 0;
    this.efrags = null;

    this.firstmarksurface = 0; // index into marksurfaces array
    this.nummarksurfaces = 0;
    this.key = 0; // BSP sequence number for leaf's contents
    this.ambient_sound_level = buffer !== null ?
      new Uint8Array(buffer, byteOffset + 24, NUM_AMBIENTS) :
      new Uint8Array(NUM_AMBIENTS);
  }
}

export class dclipnode_t {
  constructor(buffer = null, byteOffset = 0) {
    this.planenum = 0;
    // Deliberate deviation (QuakeSpasm mclipnode_t): int children, so
    // clipnode and hull 0 node indices past 32767 don't wrap. dclipnode_t
    // holds short children.
    this.children = buffer !== null ?
      new Int32Array(buffer, byteOffset, 2) :
      new Int32Array(2);
  }
}

export class hull_t {
  constructor() {
    this.clipnodes = null; // array of dclipnode_t
    this.planes = null; // array of mplane_t
    this.firstclipnode = 0;
    this.lastclipnode = 0;
    this.clip_mins = new Float32Array(3);
    this.clip_maxs = new Float32Array(3);
  }
}

// Sprite model structures

export class mspriteframe_t {
  constructor() {
    this.width = 0;
    this.height = 0;
    this.up = 0;
    this.down = 0;
    this.left = 0;
    this.right = 0;
    this.gl_texturenum = 0;
  }
}

export class mspritegroup_t {
  constructor() {
    this.numframes = 0;
    this.intervals = null; // Float32Array
    this.frames = []; // array of mspriteframe_t
  }
}

export class mspriteframedesc_t {
  constructor() {
    this.type = 0; // spriteframetype_t
    this.frameptr = null; // mspriteframe_t or mspritegroup_t
  }
}

export class msprite_t {
  constructor() {
    this.type = 0;
    this.maxwidth = 0;
    this.maxheight = 0;
    this.numframes = 0;
    this.beamlength = 0;
    this.cachespot = null;
    this.frames = []; // array of mspriteframedesc_t
  }
}

// Alias model structures

export class trivertx_t {
  constructor() {
    this.v = new Uint8Array(3);
    this.lightnormalindex = 0;
  }
}

export class stvert_t {
  constructor() {
    this.onseam = 0;
    this.s = 0;
    this.t = 0;
  }
}

export class dtriangle_t {
  constructor() {
    this.facesfront = 0;
    this.vertindex = new Int32Array(3);
  }
}

export class mtriangle_t {
  constructor() {
    this.facesfront = 0;
    this.vertindex = new Int32Array(3);
  }
}

export class maliasframedesc_t {
  constructor() {
    this.firstpose = 0;
    this.numposes = 0;
    this.interval = 0;
    this.bboxmin = new trivertx_t();
    this.bboxmax = new trivertx_t();
    this.frame = 0;
    this.name = "";
  }
}

export class aliashdr_t {
  constructor() {
    this.ident = 0;
    this.version = 0;
    this.scale = new Float32Array(3);
    this.scale_origin = new Float32Array(3);
    this.boundingradius = 0;
    this.eyeposition = new Float32Array(3);
    this.numskins = 0;
    this.skinwidth = 0;
    this.skinheight = 0;
    this.numverts = 0;
    this.numtris = 0;
    this.numframes = 0;
    this.synctype = 0;
    this.flags = 0;
    this.size = 0;

    this.numposes = 0;
    this.poseverts = 0;
    this.posedata = null; // array of trivertx_t arrays
    this.commands = null; // gl command list with embedded s/t
    this.gl_texturenum = []; // [MAX_SKINS][4]
    this.texels = []; // [MAX_SKINS] - only for player skins
    this.frames = []; // array of maliasframedesc_t

    // Initialize gl_texturenum as 2D array
    for (let i = 0; i < MAX_SKINS; i++) {
      this.gl_texturenum[i] = [0, 0, 0, 0];
      this.texels[i] = 0;
    }
  }
}

// dmodel_t -- on-disk submodel structure

export class dmodel_t {
  constructor() {
    this.mins = new Float32Array(3);
    this.maxs = new Float32Array(3);
    this.origin = new Float32Array(3);
    this.headnode = new Int32Array(MAX_MAP_HULLS);
    this.visleafs = 0;
    this.firstface = 0;
    this.numfaces = 0;
  }
}

// Whole model

export class model_t {
  constructor() {
    this.name = "";
    this.needload = false; // bmodels and sprites don't cache normally

    this.type = 0; // modtype_t
    this.numframes = 0;
    this.synctype = 0;

    this.flags = 0;
    this.extraflags_list = null; // r_nolerp_list the MOD_ flags were built from (Mod_SetExtraFlags)

    // alias model: the .md5mesh replacement (Mod_LoadMD5Replacement)
    this.md5state = 0; // MD5_UNTRIED, MD5_PENDING or MD5_DONE
    this.md5hdr = null; // its aliashdr_t, or null when there is none

    // volume occupied by the model graphics
    this.mins = new Float32Array(3);
    this.maxs = new Float32Array(3);
    this.radius = 0;

    // solid volume for clipping
    this.clipbox = false;
    this.clipmins = new Float32Array(3);
    this.clipmaxs = new Float32Array(3);

    // brush model
    this.firstmodelsurface = 0;
    this.nummodelsurfaces = 0;

    this.numsubmodels = 0;
    this.submodels = null; // array of dmodel_t

    this.numplanes = 0;
    this.planes = null; // array of mplane_t

    this.numleafs = 0; // number of visible leafs, not counting 0
    this.leafs = null; // array of mleaf_t

    this.numvertexes = 0;
    this.vertexes = null; // array of mvertex_t

    this.numedges = 0;
    this.edges = null; // array of medge_t

    this.numnodes = 0;
    this.nodes = null; // array of mnode_t

    this.numtexinfo = 0;
    this.texinfo = null; // array of mtexinfo_t

    this.numsurfaces = 0;
    this.surfaces = null; // array of msurface_t

    this.numsurfedges = 0;
    this.surfedges = null; // Int32Array

    this.numclipnodes = 0;
    this.clipnodes = null; // array of dclipnode_t

    this.nummarksurfaces = 0;
    this.marksurfaces = null; // array of indices into surfaces

    this.hulls = [];
    for (let i = 0; i < MAX_MAP_HULLS; i++) {
      this.hulls[i] = new hull_t();
    }

    this.numtextures = 0;
    this.textures = null; // array of texture_t

    this.visdata = null; // Uint8Array
    this.viswarn = false; // QuakeSpasm: Mod_DecompressVis warned once
    this.lightdata = null; // Uint8Array
    this.litfile = false; // Ironwail: lightdata is RGB from a .lit
    this.entities = null; // string
    this.contentstransparent = 0; // SURF_DRAW* liquids the vis sees through (Mod_CheckWaterVis)

    // additional model data
    this.cache = { data: null }; // cache_user_t equivalent
    this._threeTextures = new Set();
  }
}
