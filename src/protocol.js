// Ported from: WinQuake/protocol.h -- communications protocols

export const PROTOCOL_VERSION = 15;

// Not in id's C: the version Icaro's server sends. Client and server ship
// together, so instead of Ironwail's 666/999 formats it has its own, chosen
// for the 2021 rerelease limits:
// - coordinates are int32 in 1/8 units (MSG_WriteCoord), not shorts, so
//   positions past +-4096 don't wrap; the 1/8 grid prediction snaps to is
//   unchanged;
// - model indexes are shorts in svc_spawnbaseline, svc_spawnstatic, the
//   svc_clientdata weapon model and svc_playerinfo (MAX_MODELS 4096), and
//   svc_spawnstaticsound sends a short sound index (MAX_SOUNDS 2048);
// - svc_spawnbaseline and svc_spawnstatic send the frame as a short (Ironwail
//   B_LARGEFRAME) and end with an alpha byte (ENTALPHA_ENCODE);
// - svc_clientdata sends Ironwail's SU_EXTEND1/SU_EXTEND2 bytes, with
//   SU_WEAPONFRAME2 and SU_WEAPONALPHA;
// - svc_playerinfo sends the frame and weaponframe as shorts and the
//   player's alpha with PF_ALPHA;
// - packet entities use the PE_* layout below (15-bit entity numbers).
// svc_sound and svc_localsound use Ironwail's SND_LARGEENTITY and
// SND_LARGESOUND bits, which protocol 15 never sets. The client still
// accepts protocol 15 for NetQuake demos (the attract demos), and reads
// those messages in their NetQuake form. Demos recorded by Icaro builds
// before this protocol (15 plus packet entities) no longer play.
export const PROTOCOL_ICARO = 1015;

// Ironwail protocol.h: FitzQuake's and RMQ's protocols. The client reads
// them for demos (cl_parse.js); the server never writes them.
export const PROTOCOL_FITZQUAKE = 666; //johnfitz -- added new protocol for fitzquake 0.85
export const PROTOCOL_RMQ = 999;

// PROTOCOL_RMQ protocol flags: a long after the version in svc_serverinfo
export const PRFL_SHORTANGLE = 1 << 1;
export const PRFL_FLOATANGLE = 1 << 2;
export const PRFL_24BITCOORD = 1 << 3;
export const PRFL_FLOATCOORD = 1 << 4;
export const PRFL_EDICTSCALE = 1 << 5;
export const PRFL_ALPHASANITY = 1 << 6; // cleanup insanity with alpha
export const PRFL_INT32COORD = 1 << 7;
export const PRFL_MOREFLAGS = 1 << 31; // not supported

// if the high bit of the servercmd is set, the low bits are fast update flags:
export const U_MOREBITS = 1 << 0;
export const U_ORIGIN1 = 1 << 1;
export const U_ORIGIN2 = 1 << 2;
export const U_ORIGIN3 = 1 << 3;
export const U_ANGLE2 = 1 << 4;
export const U_NOLERP = 1 << 5; // don't interpolate movement
export const U_FRAME = 1 << 6;
export const U_SIGNAL = 1 << 7; // just differentiates from other updates

// svc_update can pass all of the fast update bits, plus more
export const U_ANGLE1 = 1 << 8;
export const U_ANGLE3 = 1 << 9;
export const U_MODEL = 1 << 10;
export const U_COLORMAP = 1 << 11;
export const U_SKIN = 1 << 12;
export const U_EFFECTS = 1 << 13;
export const U_LONGENTITY = 1 << 14;
//johnfitz -- PROTOCOL_FITZQUAKE -- new bits (Ironwail protocol.h). Read only
// under 666 and 999; Icaro's server sends no fast updates.
export const U_EXTEND1 = 1 << 15;
export const U_ALPHA = 1 << 16; // 1 byte, uses ENTALPHA_ENCODE, not sent if equal to baseline
export const U_FRAME2 = 1 << 17; // 1 byte, this is .frame & 0xFF00 (second byte)
export const U_MODEL2 = 1 << 18; // 1 byte, this is .modelindex & 0xFF00 (second byte)
export const U_LERPFINISH = 1 << 19; // 1 byte, 0.0-1.0 maps to 0-255, not sent if exactly 0.1, this is ent->v.nextthink - sv.time, used for lerping
export const U_SCALE = 1 << 20; // 1 byte, for PROTOCOL_RMQ PRFL_EDICTSCALE
export const U_EXTEND2 = 1 << 23; // another byte to follow, future expansion

export const SU_VIEWHEIGHT = 1 << 0;
export const SU_IDEALPITCH = 1 << 1;
export const SU_PUNCH1 = 1 << 2;
export const SU_PUNCH2 = 1 << 3;
export const SU_PUNCH3 = 1 << 4;
export const SU_VELOCITY1 = 1 << 5;
export const SU_VELOCITY2 = 1 << 6;
export const SU_VELOCITY3 = 1 << 7;
// SU_AIMENT (1<<8) AVAILABLE BIT
export const SU_ITEMS = 1 << 9;
export const SU_ONGROUND = 1 << 10; // no data follows, the bit is it
export const SU_INWATER = 1 << 11; // no data follows, the bit is it
export const SU_WEAPONFRAME = 1 << 12;
export const SU_ARMOR = 1 << 13;
export const SU_WEAPON = 1 << 14;
// Ironwail (FitzQuake) protocol.h. Icaro sends only SU_EXTEND1, SU_EXTEND2,
// SU_WEAPONFRAME2 and SU_WEAPONALPHA: its weapon model is already a short (no
// SU_WEAPON2), and armor and ammo stay bytes (SU_ARMOR2 to SU_CELLS2, bits 16
// to 22, come only from 666 and 999 demos).
export const SU_EXTEND1 = 1 << 15; // another byte to follow
export const SU_WEAPON2 = 1 << 16; // 1 byte, this is .weaponmodel & 0xFF00 (second byte)
export const SU_ARMOR2 = 1 << 17; // 1 byte, this is .armorvalue & 0xFF00 (second byte)
export const SU_AMMO2 = 1 << 18; // 1 byte, this is .currentammo & 0xFF00 (second byte)
export const SU_SHELLS2 = 1 << 19; // 1 byte, this is .ammo_shells & 0xFF00 (second byte)
export const SU_NAILS2 = 1 << 20; // 1 byte, this is .ammo_nails & 0xFF00 (second byte)
export const SU_ROCKETS2 = 1 << 21; // 1 byte, this is .ammo_rockets & 0xFF00 (second byte)
export const SU_CELLS2 = 1 << 22; // 1 byte, this is .ammo_cells & 0xFF00 (second byte)
export const SU_EXTEND2 = 1 << 23; // another byte to follow
export const SU_WEAPONFRAME2 = 1 << 24; // 1 byte, this is .weaponframe & 0xFF00 (second byte)
export const SU_WEAPONALPHA = 1 << 25; // 1 byte, this is alpha for weaponmodel, uses ENTALPHA_ENCODE, not sent if ENTALPHA_DEFAULT

// a sound with no channel is a local only sound
export const SND_VOLUME = 1 << 0; // a byte
export const SND_ATTENUATION = 1 << 1; // a byte
export const SND_LOOPING = 1 << 2; // a long
// Ironwail (FitzQuake) protocol.h
export const SND_LARGEENTITY = 1 << 3; // a short + byte (instead of just a short)
export const SND_LARGESOUND = 1 << 4; // a short soundindex (instead of a byte)

//johnfitz -- PROTOCOL_FITZQUAKE -- flags for entity baseline messages
// (svc_spawnbaseline2 and svc_spawnstatic2)
export const B_LARGEMODEL = 1 << 0; // modelindex is short instead of byte
export const B_LARGEFRAME = 1 << 1; // frame is short instead of byte
export const B_ALPHA = 1 << 2; // 1 byte, uses ENTALPHA_ENCODE, not sent if ENTALPHA_DEFAULT
export const B_SCALE = 1 << 3;

// defaults for clientinfo messages
export const DEFAULT_VIEWHEIGHT = 22;

export const DEFAULT_SOUND_PACKET_VOLUME = 255;
export const DEFAULT_SOUND_PACKET_ATTENUATION = 1.0;

// game types sent by serverinfo
// these determine which intermission screen plays
export const GAME_COOP = 0;
export const GAME_DEATHMATCH = 1;

// note that there are some defs.qc that mirror to these numbers
// also related to svc_strings[] in cl_parse

// server to client
export const svc_bad = 0;
export const svc_nop = 1;
export const svc_disconnect = 2;
export const svc_updatestat = 3; // [byte] [long]
export const svc_version = 4; // [long] server version
export const svc_setview = 5; // [short] entity number
export const svc_sound = 6; // <see code>
export const svc_time = 7; // [float] server time
export const svc_print = 8; // [string] null terminated string
export const svc_stufftext = 9; // [string] stuffed into client's console buffer
export const svc_setangle = 10; // [angle3] set the view angle to this absolute value
export const svc_serverinfo = 11; // [long] version ... [string]..[0]model cache [string]...[0]sounds cache
export const svc_lightstyle = 12; // [byte] [string]
export const svc_updatename = 13; // [byte] [string]
export const svc_updatefrags = 14; // [byte] [short]
export const svc_clientdata = 15; // <shortbits + data>
export const svc_stopsound = 16; // <see code>
export const svc_updatecolors = 17; // [byte] [byte]
export const svc_particle = 18; // [vec3] <variable>
export const svc_damage = 19;
export const svc_spawnstatic = 20;
// svc_spawnbinary = 21
export const svc_spawnbaseline = 22;
export const svc_temp_entity = 23;
export const svc_setpause = 24; // [byte] on / off
export const svc_signonnum = 25; // [byte] used for the signon sequence
export const svc_centerprint = 26; // [string] to put in center of the screen
export const svc_killedmonster = 27;
export const svc_foundsecret = 28;
export const svc_spawnstaticsound = 29; // [coord3] [byte] samp [byte] vol [byte] aten
export const svc_intermission = 30; // [string] music
export const svc_finale = 31; // [string] music [string] text
export const svc_cdtrack = 32; // [byte] track [byte] looptrack
export const svc_sellscreen = 33;
export const svc_cutscene = 34;
//johnfitz -- PROTOCOL_FITZQUAKE -- new server messages (Ironwail
// protocol.h). The client reads them under 666 and 999 only: 42 is Icaro's
// svc_playerinfo under PROTOCOL_ICARO.
export const svc_skybox = 37; // [string] name
export const svc_bf = 40; // no data
export const svc_fog = 41; // [byte] density [byte] red [byte] green [byte] blue [short] time (hundredths)
export const svc_spawnbaseline2 = 42; // support for large modelindex, large framenum, alpha, using flags
export const svc_spawnstatic2 = 43; // support for large modelindex, large framenum, alpha, using flags
export const svc_spawnstaticsound2 = 44; // [coord3] [short] samp [byte] vol [byte] aten
// 2021 re-release: [string] id. The re-release QuakeC writes it with
// WriteByte/WriteString (on every secret, at intermissions and on some
// kills), so the server only passes it through. Ironwail protocol.h; it
// shares its number with DP's svcdp_effect.
export const svc_achievement = 52;
// Ironwail (2021 re-release): [byte] field_mask [byte] sound_num. 56 is the
// number Ironwail and the re-release use; it is free in this protocol.
export const svc_localsound = 56;

// client to server
export const clc_bad = 0;
export const clc_nop = 1;
export const clc_disconnect = 2;
export const clc_move = 3; // [usercmd_t]
export const clc_stringcmd = 4; // [string] message

// temp entity events
export const TE_SPIKE = 0;
export const TE_SUPERSPIKE = 1;
export const TE_GUNSHOT = 2;
export const TE_EXPLOSION = 3;
export const TE_TAREXPLOSION = 4;
export const TE_LIGHTNING1 = 5;
export const TE_LIGHTNING2 = 6;
export const TE_WIZSPIKE = 7;
export const TE_KNIGHTSPIKE = 8;
export const TE_LIGHTNING3 = 9;
export const TE_LAVASPLASH = 10;
export const TE_TELEPORT = 11;
export const TE_EXPLOSION2 = 12;
export const TE_BEAM = 13;

// QuakeWorld-style player info (svc_playerinfo)
// Used for client-side prediction of other players
export const svc_playerinfo = 42;

// playerinfo flags from server
// playerinfo always sends: playernum, flags, origin[] and frame (a short
// here, QW: a byte; PF_WEAPONFRAME is a short too)
export const PF_MSEC = 1 << 0;
export const PF_COMMAND = 1 << 1;
export const PF_VELOCITY1 = 1 << 2;
export const PF_VELOCITY2 = 1 << 3;
export const PF_VELOCITY3 = 1 << 4;
export const PF_MODEL = 1 << 5;
export const PF_SKINNUM = 1 << 6;
export const PF_EFFECTS = 1 << 7;
export const PF_WEAPONFRAME = 1 << 8; // only sent for view player
export const PF_DEAD = 1 << 9; // don't block movement any more
export const PF_GIB = 1 << 10; // offset the view height differently
// Not in QW: the view player's NQ movetype, for prediction (view player only)
export const PF_FLY = 1 << 11; // MOVETYPE_FLY
export const PF_NOCLIP = 1 << 12; // MOVETYPE_NOCLIP
// Not in QW: [byte] ent->v.teleport_time - sv.time in 10 ms units (view player
// only), for the teleporter back-move lock and waterjump in prediction
export const PF_TELEPORT = 1 << 13;
// Not in QW: [byte] the player's alpha (ENTALPHA_ENCODE), not sent if
// ENTALPHA_DEFAULT. Ironwail sends player entities with U_ALPHA.
export const PF_ALPHA = 1 << 14;

// command move bits (for delta compression of usercmd_t)
export const CM_ANGLE1 = 1 << 0;
export const CM_ANGLE3 = 1 << 1;
export const CM_FORWARD = 1 << 2;
export const CM_SIDE = 1 << 3;
export const CM_UP = 1 << 4;
export const CM_BUTTONS = 1 << 5;
export const CM_IMPULSE = 1 << 6;
export const CM_ANGLE2 = 1 << 7;

// QW-style delta compression for packet entities
// Ported from: QW/client/protocol.h
//
// Deliberate deviation from QW's layout (and from this port's earlier one,
// which packed a 10-bit entity number and 6 flags into the first short):
// each entry starts with a short holding the entity number in its low 15
// bits (MAX_EDICTS 32000) and PE_REMOVE in bit 15. 0 ends the list. Unless
// PE_REMOVE is set, a byte of PE_* bits follows, and a second byte when
// PE_MOREBITS is set in the first.

export const svc_packetentities = 47; // [...]
export const svc_deltapacketentities = 48; // [...]
export const svc_serversequence = 49; // [long] server frame sequence number

export const clc_delta = 5; // [byte] sequence number, requests delta compression

// Entity number: the low 15 bits of the first short
export const PE_ENT_BITS = 15;
export const PE_ENT_MASK = (1 << PE_ENT_BITS) - 1; // 0x7FFF
export const PE_REMOVE = 1 << 15; // REMOVE this entity, don't add it

// The first byte of bits
export const PE_ORIGIN1 = 1 << 0;
export const PE_ORIGIN2 = 1 << 1;
export const PE_ORIGIN3 = 1 << 2;
export const PE_ANGLE1 = 1 << 3;
export const PE_ANGLE2 = 1 << 4;
export const PE_ANGLE3 = 1 << 5;
export const PE_FRAME = 1 << 6;
export const PE_MOREBITS = 1 << 7;

// The second byte, read when PE_MOREBITS is set
export const PE_MODEL = 1 << 8; // [short] modelindex
export const PE_COLORMAP = 1 << 9;
export const PE_SKIN = 1 << 10;
export const PE_EFFECTS = 1 << 11;
// PE_SOLID: the entity's prediction info changed. QW sends it, without a
// payload, on every update of a solid entity. Here it is delta'd like the
// other fields: it is set only when the PS_* byte or the box differs from
// the state being delta'd from, and it is followed, after the angles, by
// the PS_* byte and, if PS_BOX is set, the box as 6 coords (mins, maxs).
export const PE_SOLID = 1 << 12;
// [byte] entity alpha, ENTALPHA_ENCODE (Ironwail's U_ALPHA), sent last
export const PE_ALPHA = 1 << 13;
// [byte] frame & 0xFF00 (Ironwail's U_FRAME2), sent after PE_ALPHA. Only
// with PE_FRAME, which carries the low byte.
export const PE_FRAME2 = 1 << 14;

// PS_* bits: the byte that follows PE_SOLID (entity_state_t.solid)
export const PS_BSP = 1 << 0; // collide with the entity's brush model hull
export const PS_BOX = 1 << 1; // collide with the box that follows
export const PS_NOLERP = 1 << 2; // MOVETYPE_STEP: don't interpolate (NQ U_NOLERP)

// Packet entities constants
// NetQuake has no entity count cap, only the datagram size, so the cap is
// the edict limit (MAX_EDICTS in quakedef.js) and never binds: entity
// numbers are below it and the world and players are not in the packet.
// The frame arrays grow on demand (packet_entities_t.state).
export const MAX_PACKET_ENTITIES = 32000; // MAX_EDICTS
export const PE_UPDATE_BACKUP = 64; // must be power of 2
export const PE_UPDATE_MASK = PE_UPDATE_BACKUP - 1;

// Entity alpha
// Ported from: Ironwail Quake/protocol.h (johnfitz)

export const ENTALPHA_DEFAULT = 0; // entity's alpha is "default" (i.e. water obeys r_wateralpha) -- must be zero so zeroed out memory works
export const ENTALPHA_ZERO = 1; // entity is invisible (lowest possible alpha)
export const ENTALPHA_ONE = 255; // entity is fully opaque (highest possible alpha)

// server convert to byte to send to client
export function ENTALPHA_ENCODE(a) {
  if (a === 0) return ENTALPHA_DEFAULT;
  const x = Math.min(255, Math.max(1, a * 254 + 1));
  return (x > 0 ? x + 0.5 : x - 0.5) | 0; // Q_rint
}

// client convert to float for rendering
export function ENTALPHA_DECODE(a) {
  return a === ENTALPHA_DEFAULT ? 1.0 : (a - 1) / 254;
}

// server convert to float for savegame
export function ENTALPHA_TOSAVE(a) {
  return a === ENTALPHA_DEFAULT ?
    0.0 :
    (a === ENTALPHA_ZERO ? -1.0 : (a - 1) / 254);
}
