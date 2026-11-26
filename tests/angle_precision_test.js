// Angle quantisation on the wire.
//
// MSG_WriteAngle rounds to the nearest 1/256 of a turn (FitzQuake's Q_rint)
// instead of dropping the fraction of a degree first. MSG_WriteAngle16
// quantises the angle itself, as QW's common.c does. clc_move carries its
// view angles as angle16, and CL_QuantizeAngle (the angle client prediction
// uses) must equal what SV_ReadClientMove stores in v_angle. The sweep of
// CL_QuantizeAngle against the angle16 round trip is in cl_pred_nq_test.js.

import {
  COM_SetNetMessage,
  msg_badread,
  MSG_BeginReading,
  MSG_ReadAngle,
  MSG_ReadAngle16,
  MSG_ReadByte,
  MSG_WriteAngle,
  MSG_WriteAngle16,
  net_message,
  SZ_Clear,
} from "../src/common.js";
import { CL_QuantizeAngle, CL_SendMove } from "../src/cl_input.js";
import { cl, cls } from "../src/client.js";
import { net_drivers } from "../src/net.js";
import { clc_move } from "../src/protocol.js";
import { SV_SetState } from "../src/sv_phys.js";
import { SV_ReadClientMove, SV_User_SetCallbacks } from "../src/sv_user.js";

function assertNear(actual, expected, epsilon, message) {
  if (
    Number.isFinite(actual) !== true || Math.abs(actual - expected) > epsilon
  ) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

// Difference between two angles, wrapped into [-180, 180)
function angleDiff(a, b) {
  let d = (a - b) % 360;
  if (d >= 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

const _buf = {
  maxsize: 8,
  cursize: 0,
  data: new Uint8Array(8),
  allowoverflow: false,
  overflowed: false,
};

function roundTrip(write, read, f) {
  const old = net_message;
  COM_SetNetMessage(_buf);
  try {
    SZ_Clear(_buf);
    write(_buf, f);
    MSG_BeginReading();
    return read();
  } finally {
    COM_SetNetMessage(old);
  }
}

const angle8 = (f) => roundTrip(MSG_WriteAngle, MSG_ReadAngle, f);
const angle16 = (f) => roundTrip(MSG_WriteAngle16, MSG_ReadAngle16, f);

Deno.test("MSG_WriteAngle rounds to the nearest 1/256 of a turn", () => {
  const step = 360 / 256;
  for (let f = -720; f <= 720; f += 0.173) {
    const err = angleDiff(angle8(f), f);
    assertNear(err, 0, step / 2 + 1e-9, `angle ${f}`);
  }

  // the old code dropped the fraction first: 45.9 went out as step 32
  // (45 deg, 0.9 short); 45.9 * 256 / 360 = 32.64 rounds to step 33
  assertNear(angle8(45.9), 33 * step, 0, "45.9");
  assertNear(angle8(1.3), step, 0, "1.3 (was 0)");
  // Q_rint rounds halves away from zero, on both sides
  assertNear(angle8(step / 2), step, 0, "positive half step");
  assertNear(angle8(-step / 2), -step, 0, "negative half step");
  assertNear(angle8(-1.3), -step, 0, "-1.3");
  assertNear(angle8(179.9), -180, 0, "179.9 wraps to -180");
});

Deno.test("MSG_WriteAngle16 keeps the fraction of a degree", () => {
  const step = 360 / 65536;
  for (let f = -720; f <= 720; f += 0.173) {
    const err = angleDiff(angle16(f), f);
    // (int) truncates towards zero: under one step either way
    assertNear(err, 0, step, `angle ${f}`);
  }

  // the old code truncated to a whole degree first: 45.9 came back as 45
  assertNear(angle16(45.9), Math.trunc(45.9 * 65536 / 360) * step, 0, "45.9");
  assertNear(angle16(45.9), 45.9, step, "45.9 within one step");
  assertNear(angle16(-0.5), -0.5, step, "-0.5");
  assertNear(angle16(270.25), 270.25 - 360, step, "270.25 wraps");
});

Deno.test("SV_ReadClientMove reads the angles CL_SendMove predicts with", () => {
  // Capture what CL_SendMove sends through a stub net driver
  const DRIVER = net_drivers.length - 1;
  const driver = net_drivers[DRIVER];
  const sent = {
    maxsize: 128,
    cursize: 0,
    data: new Uint8Array(128),
    allowoverflow: false,
    overflowed: false,
  };
  const oldSend = driver.SendUnreliableMessage;
  const oldNetcon = cls.netcon;
  const oldDemo = cls.demoplayback;
  const oldMoves = cl.movemessages;
  const oldView = Float32Array.from(cl.viewangles);
  const oldNetMessage = net_message;

  const edict = {
    v: { v_angle: new Float32Array(3), button0: 0, button2: 0, impulse: 0 },
  };
  const client = {
    ping_times: new Float32Array(16),
    num_pings: 0,
    edict: edict,
    lastcmd: null,
  };
  SV_SetState({ time: 0 }, {}, {});
  SV_User_SetCallbacks({ host_client: client });

  const views = [
    [12.34, 45.9, 0.7],
    [-33.3, 179.99, -2.2],
    [80, 359.6, 0],
    [-0.01, -90.123, 1.3],
  ];

  try {
    driver.SendUnreliableMessage = (_sock, data) => {
      sent.data.set(data.data.subarray(0, data.cursize));
      sent.cursize = data.cursize;
      return 1;
    };
    cls.netcon = { driver: DRIVER, disconnected: false, sendSequence: 0 };
    cls.demoplayback = false;

    for (const view of views) {
      cl.movemessages = 10;
      cl.viewangles.set(view);
      sent.cursize = 0;
      CL_SendMove({ forwardmove: 200, sidemove: -100, upmove: 0 });
      if (sent.cursize === 0) {
        throw new Error("CL_SendMove sent nothing");
      }

      COM_SetNetMessage(sent);
      MSG_BeginReading();
      if (MSG_ReadByte() !== clc_move) {
        throw new Error("expected clc_move");
      }
      const move = { forwardmove: 0, sidemove: 0, upmove: 0 };
      SV_ReadClientMove(move);
      if (msg_badread) {
        throw new Error("clc_move read past the end");
      }

      for (let i = 0; i < 3; i++) {
        assertNear(
          edict.v.v_angle[i],
          CL_QuantizeAngle(cl.viewangles[i]),
          0,
          `v_angle[${i}] for ${view}`,
        );
        assertNear(
          angleDiff(edict.v.v_angle[i], view[i]),
          0,
          360 / 65536 + 1e-4,
          `v_angle[${i}] precision for ${view}`,
        );
      }

      // the fields after the angles are still aligned
      assertNear(move.forwardmove, 200, 0, "forwardmove");
      assertNear(move.sidemove, -100, 0, "sidemove");
    }
  } finally {
    driver.SendUnreliableMessage = oldSend;
    cls.netcon = oldNetcon;
    cls.demoplayback = oldDemo;
    cl.movemessages = oldMoves;
    cl.viewangles.set(oldView);
    COM_SetNetMessage(oldNetMessage);
  }
});
