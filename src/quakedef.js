// Ported from: WinQuake/quakedef.h -- primary header for client

export const VERSION = 1.09;
export const GLQUAKE_VERSION = 1.00;

export const GAMENAME = "id1"; // directory to look in by default

// angles
export const PITCH = 0; // up / down
export const YAW = 1; // left / right
export const ROLL = 2; // fall over

export const MAX_QPATH = 64; // max length of a quake game pathname
export const MAX_OSPATH = 128; // max length of a filesystem pathname

export const ON_EPSILON = 0.1; // point on plane side epsilon

/**
 * Deliberate deviation, QuakeSpasm's and Ironwail's size (id: 8000). Big
 * mods need it: an Arcane Dimensions map's serverinfo (the precache lists)
 * is over 8000 bytes, and so are some messages in LibreQuake's demos.
 */
export const MAX_MSGLEN = 64000; // max length of a reliable message
// Deliberate deviation, after FitzQuake/QuakeSpasm: MAX_DATAGRAM (id: 1024)
// sizes the server's buffers and the local client's datagram, and a nonlocal
// client gets at most DATAGRAM_MTU, so its datagrams aren't fragmented (see
// SV_ClientDatagramSize). The big 2021 rerelease maps need more than 1024
// bytes on the first frame after a teleport. It is 4096, not QuakeSpasm's
// 64000: only the local client ever gets more than DATAGRAM_MTU, and a frame
// whose packet entities don't fit sends the rest on later frames
// (SV_WritePacketEntities), so a bigger one buys little.
export const MAX_DATAGRAM = 4096; // max length of unreliable message
export const DATAGRAM_MTU = 1400; // FitzQuake: actual limit for unreliable messages to nonlocal clients
// id's MAX_DATAGRAM: the limit for a nonlocal client whose path MTU is
// unknown, and the size of sv.reliable_datagram, which is appended to every
// client's MAX_MSGLEN reliable message (an overflow there drops the client)
export const MAX_DATAGRAM_ID = 1024;

// per-level limits
//
// Deliberate deviations, Ironwail's limits for the 2021 rerelease maps. C
// has 600 edicts (with "FIXME: ouch! ouch! ouch!") and 256 models and
// sounds, sent as bytes. PROTOCOL_ICARO (protocol.js) carries the larger
// numbers: 15-bit packet entity numbers and short model and sound indexes.
// Ironwail's max_edicts cvar (sv_main.js) caps the server's edicts; its
// edict array and the client's grow on demand up to that cap.
export const MIN_EDICTS = 256; // johnfitz -- lowest allowed value for max_edicts cvar
export const MAX_EDICTS = 32000; // johnfitz -- highest allowed value for max_edicts cvar
export const MAX_LIGHTSTYLES = 64;
export const MAX_MODELS = 4096; // johnfitz -- was 256
export const MAX_SOUNDS = 2048; // johnfitz -- was 256

export const SAVEGAME_COMMENT_LENGTH = 39;

export const MAX_STYLESTRING = 64;

// stats are integers communicated to the client by the server
export const MAX_CL_STATS = 32;
export const STAT_HEALTH = 0;
export const STAT_FRAGS = 1;
export const STAT_WEAPON = 2;
export const STAT_AMMO = 3;
export const STAT_ARMOR = 4;
export const STAT_WEAPONFRAME = 5;
export const STAT_SHELLS = 6;
export const STAT_NAILS = 7;
export const STAT_ROCKETS = 8;
export const STAT_CELLS = 9;
export const STAT_ACTIVEWEAPON = 10;
export const STAT_TOTALSECRETS = 11;
export const STAT_TOTALMONSTERS = 12;
export const STAT_SECRETS = 13; // bumped on client side by svc_foundsecret
export const STAT_MONSTERS = 14; // bumped by svc_killedmonster
export const STAT_PING = 15; // client round-trip time in milliseconds

// stock defines

export const IT_SHOTGUN = 1;
export const IT_SUPER_SHOTGUN = 2;
export const IT_NAILGUN = 4;
export const IT_SUPER_NAILGUN = 8;
export const IT_GRENADE_LAUNCHER = 16;
export const IT_ROCKET_LAUNCHER = 32;
export const IT_LIGHTNING = 64;
export const IT_SUPER_LIGHTNING = 128;
export const IT_SHELLS = 256;
export const IT_NAILS = 512;
export const IT_ROCKETS = 1024;
export const IT_CELLS = 2048;
export const IT_AXE = 4096;
export const IT_ARMOR1 = 8192;
export const IT_ARMOR2 = 16384;
export const IT_ARMOR3 = 32768;
export const IT_SUPERHEALTH = 65536;
export const IT_KEY1 = 131072;
export const IT_KEY2 = 262144;
export const IT_INVISIBILITY = 524288;
export const IT_INVULNERABILITY = 1048576;
export const IT_SUIT = 2097152;
export const IT_QUAD = 4194304;
export const IT_SIGIL1 = 1 << 28;
export const IT_SIGIL2 = 1 << 29;
export const IT_SIGIL3 = 1 << 30;
export const IT_SIGIL4 = 1 << 31;

//rogue changed and added defines

export const RIT_SHELLS = 128;
export const RIT_NAILS = 256;
export const RIT_ROCKETS = 512;
export const RIT_CELLS = 1024;
export const RIT_AXE = 2048;
export const RIT_LAVA_NAILGUN = 4096;
export const RIT_LAVA_SUPER_NAILGUN = 8192;
export const RIT_MULTI_GRENADE = 16384;
export const RIT_MULTI_ROCKET = 32768;
export const RIT_PLASMA_GUN = 65536;
export const RIT_ARMOR1 = 8388608;
export const RIT_ARMOR2 = 16777216;
export const RIT_ARMOR3 = 33554432;
export const RIT_LAVA_NAILS = 67108864;
export const RIT_PLASMA_AMMO = 134217728;
export const RIT_MULTI_ROCKETS = 268435456;
export const RIT_SHIELD = 536870912;
export const RIT_ANTIGRAV = 1073741824;
export const RIT_SUPERHEALTH = 2147483648;

//MED 01/04/97 added hipnotic defines
//hipnotic added defines
export const HIT_PROXIMITY_GUN_BIT = 16;
export const HIT_MJOLNIR_BIT = 7;
export const HIT_LASER_CANNON_BIT = 23;
export const HIT_PROXIMITY_GUN = 1 << HIT_PROXIMITY_GUN_BIT;
export const HIT_MJOLNIR = 1 << HIT_MJOLNIR_BIT;
export const HIT_LASER_CANNON = 1 << HIT_LASER_CANNON_BIT;
export const HIT_WETSUIT = 1 << (23 + 2);
export const HIT_EMPATHY_SHIELDS = 1 << (23 + 3);

export const MAX_SCOREBOARD = 16;
export const MAX_SCOREBOARDNAME = 32;

export const SOUND_CHANNELS = 8;

// entity_state_t - baseline state for entity
export class entity_state_t {
  constructor() {
    this.number = 0; // entity number (QW delta compression)
    this.flags = 0; // PE_* delta bits (QW delta compression); PE_SOLID is carried by solid
    this.origin = new Float32Array(3);
    this.angles = new Float32Array(3);
    this.modelindex = 0;
    this.frame = 0;
    this.colormap = 0;
    this.skin = 0;
    this.effects = 0;
    this.solid = 0; // PS_* bits, sent with PE_SOLID
    this.mins = new Float32Array(3); // box for PS_BOX
    this.maxs = new Float32Array(3);
    this.alpha = 0; // ENTALPHA_* byte (Ironwail entity_state_t), sent with PE_ALPHA
    // ENTSCALE_* byte (QuakeSpasm entity_state_t), 16 is ENTSCALE_DEFAULT
    // (protocol.js; not imported here). Only the 666 and 999 baselines
    // (B_SCALE) set it; Icaro sends scale in svc_icaro_ext (protocol.js).
    this.scale = 16;
  }

  copyFrom(other) {
    this.number = other.number;
    this.flags = other.flags;
    this.origin[0] = other.origin[0];
    this.origin[1] = other.origin[1];
    this.origin[2] = other.origin[2];
    this.angles[0] = other.angles[0];
    this.angles[1] = other.angles[1];
    this.angles[2] = other.angles[2];
    this.modelindex = other.modelindex;
    this.frame = other.frame;
    this.colormap = other.colormap;
    this.skin = other.skin;
    this.effects = other.effects;
    this.solid = other.solid;
    this.mins[0] = other.mins[0];
    this.mins[1] = other.mins[1];
    this.mins[2] = other.mins[2];
    this.maxs[0] = other.maxs[0];
    this.maxs[1] = other.maxs[1];
    this.maxs[2] = other.maxs[2];
    this.alpha = other.alpha;
    this.scale = other.scale;
  }
}

// packet_entities_t - QW-style delta compressed entity snapshot
// Ported from: QW/client/protocol.h. QW preallocates MAX_PACKET_ENTITIES
// states; this grows on demand, since the cap is the edict limit and each
// client keeps PE_UPDATE_BACKUP of these on the server.
export class packet_entities_t {
  constructor() {
    this.num_entities = 0;
    this.entities = [];
  }

  // entities[ i ], allocating the states up to it on first use
  state(i) {
    const entities = this.entities;
    while (entities.length <= i) {
      entities.push(new entity_state_t());
    }
    return entities[i];
  }
}

// the host system specifies the base of the directory tree, the
// command line parms passed to the program, and the amount of memory
// available for the program to use

export class quakeparms_t {
  constructor() {
    this.basedir = "";
    this.cachedir = "";
    this.argc = 0;
    this.argv = [];
  }
}
