// Ported from: WinQuake/bspfile.h -- BSP file format definitions

// upper design bounds

export const MAX_MAP_HULLS = 4;

export const MAX_MAP_MODELS = 256;
export const MAX_MAP_BRUSHES = 4096;
export const MAX_MAP_ENTITIES = 1024;
export const MAX_MAP_ENTSTRING = 65536;

export const MAX_MAP_PLANES = 32767;
export const MAX_MAP_NODES = 32767; // because negative shorts are contents
export const MAX_MAP_CLIPNODES = 32767;
// Deliberate deviation: QuakeSpasm's BSP29 leaf limit (Mod_ProcessLeafs_S),
// was 8192. Leafs past 8192 are reachable because node children are read
// unsigned (Mod_LoadNodes); PVS buffers are sized from the loaded model.
export const MAX_MAP_LEAFS = 32767;
export const MAX_MAP_VERTS = 65535;
export const MAX_MAP_FACES = 65535;
export const MAX_MAP_MARKSURFACES = 65535;
export const MAX_MAP_TEXINFO = 4096;
export const MAX_MAP_EDGES = 256000;
export const MAX_MAP_SURFEDGES = 512000;
export const MAX_MAP_TEXTURES = 512;
export const MAX_MAP_MIPTEX = 0x200000;
export const MAX_MAP_LIGHTING = 0x100000;
export const MAX_MAP_VISIBILITY = 0x100000;

export const MAX_MAP_PORTALS = 65536;

// key / value pair sizes
export const MAX_KEY = 32;
export const MAX_VALUE = 1024;

//=============================================================================

export const BSPVERSION = 29;

// Deliberate addition (Ironwail bspfile.h BSP2VERSION_BSP2): the BSP2 format,
// with 32-bit fields where BSP29 has shorts and float bounding boxes. The 2021
// rerelease's dopa, mg1 and mg3 maps and two id1 vault maps use it. Ironwail's older RMQ "2PSB"
// variant isn't supported: nothing in the rerelease uses it.
export const BSP2VERSION_BSP2 = 0x32505342; // ('B' << 0) | ('S' << 8) | ('P' << 16) | ('2' << 24)

export const TOOLVERSION = 2;

// Lump types
export const LUMP_ENTITIES = 0;
export const LUMP_PLANES = 1;
export const LUMP_TEXTURES = 2;
export const LUMP_VERTEXES = 3;
export const LUMP_VISIBILITY = 4;
export const LUMP_NODES = 5;
export const LUMP_TEXINFO = 6;
export const LUMP_FACES = 7;
export const LUMP_LIGHTING = 8;
export const LUMP_CLIPNODES = 9;
export const LUMP_LEAFS = 10;
export const LUMP_MARKSURFACES = 11;
export const LUMP_EDGES = 12;
export const LUMP_SURFEDGES = 13;
export const LUMP_MODELS = 14;

export const HEADER_LUMPS = 15;

// Plane types
// 0-2 are axial planes
export const PLANE_X = 0;
export const PLANE_Y = 1;
export const PLANE_Z = 2;
// 3-5 are non-axial planes snapped to the nearest
export const PLANE_ANYX = 3;
export const PLANE_ANYY = 4;
export const PLANE_ANYZ = 5;

// Contents
export const CONTENTS_EMPTY = -1;
export const CONTENTS_SOLID = -2;
export const CONTENTS_WATER = -3;
export const CONTENTS_SLIME = -4;
export const CONTENTS_LAVA = -5;
export const CONTENTS_SKY = -6;
export const CONTENTS_ORIGIN = -7; // removed at csg time
export const CONTENTS_CLIP = -8; // changed to contents_solid

export const CONTENTS_CURRENT_0 = -9;
export const CONTENTS_CURRENT_90 = -10;
export const CONTENTS_CURRENT_180 = -11;
export const CONTENTS_CURRENT_270 = -12;
export const CONTENTS_CURRENT_UP = -13;
export const CONTENTS_CURRENT_DOWN = -14;

// Texture flags
export const TEX_SPECIAL = 1; // sky or slime, no lightmap or 256 subdivision

export const MIPLEVELS = 4;
export const MAXLIGHTMAPS = 4;

// Ambient sounds
export const AMBIENT_WATER = 0;
export const AMBIENT_SKY = 1;
export const AMBIENT_SLIME = 2;
export const AMBIENT_LAVA = 3;
export const NUM_AMBIENTS = 4;

export const ANGLE_UP = -1;
export const ANGLE_DOWN = -2;
