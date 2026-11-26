// PROTO-1: SV_CopyServerDatagram copies sv.datagram into a client's datagram
// whole when it fits, as id does (sv_main.c:738-739), and otherwise copies
// whole sound and particle messages from its start while they fit, where id
// copies nothing. QuakeC MSG_BROADCAST bytes between them are never split.

import * as common from "../src/common.js";
import { MSG_WriteByte, sizebuf_t, SZ_Alloc } from "../src/common.js";
import { edict_t, PR_SetSV, sv as progs_sv } from "../src/progs.js";
import { svc_particle, svc_sound } from "../src/protocol.js";
import { MAX_DATAGRAM } from "../src/quakedef.js";
import { sv } from "../src/server.js";
import {
  SV_ClearDatagram,
  SV_CopyServerDatagram,
  SV_StartParticle,
  SV_StartSound,
} from "../src/sv_main.js";

const SOUND_SIZE = 17; // svc_sound, mask, ent/channel, sound, 3 int32 coords
const PARTICLE_SIZE = 18; // svc_particle, 3 int32 coords, dir, count, color

const _org = new Float32Array(3);
const _dir = new Float32Array(3);

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

// Runs body with sv.datagram, the sound precache and the edict count set up
// for SV_StartSound and SV_StartParticle, then restores them.
function withServer(body) {
  const printed = [];
  common.Con_SetPrintFunctions((fmt) => printed.push(fmt), () => {});

  const saved = {
    progs_sv,
    num_edicts: sv.num_edicts,
    max_edicts: sv.max_edicts,
    sound1: sv.sound_precache[1],
    sound2: sv.sound_precache[2],
    data: sv.datagram.data,
    maxsize: sv.datagram.maxsize,
    cursize: sv.datagram.cursize,
    allowoverflow: sv.datagram.allowoverflow,
    overflowed: sv.datagram.overflowed,
  };

  try {
    PR_SetSV(sv);
    sv.num_edicts = 8;
    sv.max_edicts = 600;
    sv.sound_precache[1] = "test/a.wav";
    sv.sound_precache[2] = null;
    sv.datagram.data = new Uint8Array(MAX_DATAGRAM);
    sv.datagram.maxsize = MAX_DATAGRAM;
    sv.datagram.allowoverflow = true;
    SV_ClearDatagram();

    body(new edict_t(7, 105), printed);
  } finally {
    SV_ClearDatagram();
    PR_SetSV(saved.progs_sv);
    sv.num_edicts = saved.num_edicts;
    sv.max_edicts = saved.max_edicts;
    sv.sound_precache[1] = saved.sound1;
    sv.sound_precache[2] = saved.sound2;
    sv.datagram.data = saved.data;
    sv.datagram.maxsize = saved.maxsize;
    sv.datagram.cursize = saved.cursize;
    sv.datagram.allowoverflow = saved.allowoverflow;
    sv.datagram.overflowed = saved.overflowed;
    common.Con_SetPrintFunctions(null, null);
  }
}

function sound(entity) {
  SV_StartSound(entity, 1, "test/a.wav", 255, 1);
}

function particle() {
  SV_StartParticle(_org, _dir, 73, 20);
}

// a QuakeC MSG_BROADCAST message, written a byte at a time
function qcBytes(n) {
  for (let i = 0; i < n; i++) {
    MSG_WriteByte(sv.datagram, 200 + i);
  }
}

// a client datagram with `room` bytes free after `used` bytes of its own
function clientMsg(used, room) {
  const msg = new sizebuf_t();
  SZ_Alloc(msg, used + room);
  msg.maxsize = used + room; // SZ_Alloc rounds small sizes up to 256
  msg.allowoverflow = false; // as _scdMsg: a bad length check is a Host_Error
  msg.cursize = used;
  return msg;
}

function assertPrefix(msg, used, length, label) {
  assertEqual(msg.cursize, used + length, label + ": bytes copied");
  for (let i = 0; i < length; i++) {
    assertEqual(msg.data[used + i], sv.datagram.data[i], label + ": byte " + i);
  }
}

Deno.test("a server datagram that fits is copied whole, as in id", () => {
  withServer((entity) => {
    particle();
    qcBytes(5);
    sound(entity);
    qcBytes(3); // trailing QuakeC bytes, after the last mark
    const size = sv.datagram.cursize;
    assertEqual(size, PARTICLE_SIZE + 5 + SOUND_SIZE + 3, "datagram size");

    const msg = clientMsg(40, size + 1);
    SV_CopyServerDatagram(msg);
    assertPrefix(msg, 40, size, "whole");
  });
});

Deno.test("a server datagram that does not fit keeps its first whole messages", () => {
  withServer((entity) => {
    particle();
    sound(entity);
    particle();
    sound(entity);
    assertEqual(sv.datagram.data[0], svc_particle, "first message");
    assertEqual(sv.datagram.data[PARTICLE_SIZE], svc_sound, "second message");

    // room for the first two and part of the third
    const two = PARTICLE_SIZE + SOUND_SIZE;
    const msg = clientMsg(100, two + 10);
    SV_CopyServerDatagram(msg);
    assertPrefix(msg, 100, two, "first two");

    // id's strict <: a message that would fill the datagram exactly is left out
    const exact = clientMsg(100, two);
    SV_CopyServerDatagram(exact);
    assertPrefix(exact, 100, PARTICLE_SIZE, "strict <");

    const one = clientMsg(100, two + 1);
    SV_CopyServerDatagram(one);
    assertPrefix(one, 100, two, "one byte more");

    // the whole-copy check is strict too
    const whole = sv.datagram.cursize;
    const full = clientMsg(0, whole);
    SV_CopyServerDatagram(full);
    assertPrefix(full, 0, whole - SOUND_SIZE, "whole size: partial");

    const none = clientMsg(0, PARTICLE_SIZE);
    SV_CopyServerDatagram(none);
    assertEqual(none.cursize, 0, "not even the first message fits");
  });
});

Deno.test("QuakeC broadcast bytes between messages are copied whole or not at all", () => {
  withServer((entity) => {
    sound(entity);
    qcBytes(10);
    sound(entity);

    // the first sound and half the QuakeC bytes fit: only the sound
    const msg = clientMsg(0, SOUND_SIZE + 6);
    SV_CopyServerDatagram(msg);
    assertPrefix(msg, 0, SOUND_SIZE, "QuakeC chunk left out");

    const more = clientMsg(0, SOUND_SIZE + 11);
    SV_CopyServerDatagram(more);
    assertPrefix(more, 0, SOUND_SIZE + 10, "QuakeC chunk copied whole");
  });
});

Deno.test("a full frame still sends a network client its first particles", () => {
  withServer(() => {
    // SV_StartParticle stops at MAX_DATAGRAM - 18
    for (let i = 0; i < 300; i++) {
      particle();
    }
    const count = Math.floor(sv.datagram.cursize / PARTICLE_SIZE);
    assertEqual(sv.datagram.cursize, count * PARTICLE_SIZE, "whole particles");
    if (sv.datagram.cursize <= MAX_DATAGRAM - 2 * PARTICLE_SIZE) {
      throw new Error("sv.datagram not full: " + sv.datagram.cursize);
    }

    // a 1400-byte client datagram with the entity writers' 54 bytes left
    const msg = clientMsg(1346, 54);
    SV_CopyServerDatagram(msg);
    assertPrefix(msg, 1346, 2 * PARTICLE_SIZE, "two particles");
  });
});

Deno.test("stale marks fall back to id's all-or-nothing copy", () => {
  withServer((entity, printed) => {
    // SV_ClearDatagram forgets the last frame's marks
    sound(entity);
    sound(entity);
    SV_ClearDatagram();
    qcBytes(3 * SOUND_SIZE);
    const cleared = clientMsg(0, SOUND_SIZE + 5);
    SV_CopyServerDatagram(cleared);
    assertEqual(cleared.cursize, 0, "no marks after SV_ClearDatagram");

    // an overflow clears sv.datagram mid-frame: its marks no longer apply
    SV_ClearDatagram();
    sv.datagram.maxsize = 3 * SOUND_SIZE;
    sound(entity);
    sound(entity);
    qcBytes(SOUND_SIZE + 10); // overflows and clears, then the rest
    assertEqual(sv.datagram.overflowed, true, "overflowed");
    assertEqual(
      printed.some((s) => s.includes("SZ_GetSpace: overflow")),
      true,
      "overflow printed",
    );
    sound(entity);
    const overflowed = clientMsg(0, sv.datagram.cursize - 1);
    SV_CopyServerDatagram(overflowed);
    assertEqual(overflowed.cursize, 0, "nothing copied after an overflow");

    // cursize reset without SV_ClearDatagram (as SV_SpawnServer and other
    // tests do): marks past cursize are ignored
    sv.datagram.maxsize = MAX_DATAGRAM;
    sv.datagram.overflowed = false;
    SV_ClearDatagram();
    sound(entity);
    sound(entity);
    sound(entity);
    sv.datagram.cursize = 0;
    qcBytes(2 * SOUND_SIZE);
    const reset = clientMsg(0, SOUND_SIZE + 5);
    SV_CopyServerDatagram(reset);
    assertEqual(reset.cursize, 0, "marks past cursize ignored");

    // the next mark after such a reset starts a fresh table
    SV_ClearDatagram();
    sound(entity);
    sound(entity);
    sv.datagram.cursize = 0;
    sound(entity);
    qcBytes(2 * SOUND_SIZE);
    const fresh = clientMsg(0, SOUND_SIZE + 5);
    SV_CopyServerDatagram(fresh);
    assertPrefix(fresh, 0, SOUND_SIZE, "fresh marks");
  });
});
