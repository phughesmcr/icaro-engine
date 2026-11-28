// Tests for the hidden-host frame driver (src/host_hidden.js): which driver
// runs, the wake lock it holds while hosting, the flush on hide and the
// fallback to the page's timer.

import {
  HOSTHIDDEN_BACK_MESSAGE,
  HostHidden_ChooseDriver,
  HostHidden_Driver,
  HostHidden_Init,
  HostHidden_IsHosting,
  HostHidden_ReturnMessage,
  HostHidden_SetHidden,
  HostHidden_SetHosting,
  HostHidden_TellJoiners,
  HOSTHIDDEN_TICK_MS,
  HOSTHIDDEN_WAKE_REASON,
} from "../src/host_hidden.js";
import { sizebuf_t, SZ_Alloc } from "../src/common.js";
import { svc_print } from "../src/protocol.js";
import { svs } from "../src/server.js";
import { WakeLock_IsHeldFor, WakeLock_SetPlatform } from "../src/wake_lock.js";

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

Deno.test("HostHidden_ChooseDriver: only a hidden host needs one", () => {
  assertEqual(
    HostHidden_ChooseDriver(false, true, true, false),
    "raf",
    "shown",
  );
  assertEqual(
    HostHidden_ChooseDriver(true, false, true, false),
    "raf",
    "not hosting",
  );
  assertEqual(HostHidden_ChooseDriver(true, true, true, true), "raf", "WebXR");
  assertEqual(
    HostHidden_ChooseDriver(true, true, true, false),
    "worker",
    "hidden host",
  );
  assertEqual(
    HostHidden_ChooseDriver(true, true, false, false),
    "timer",
    "no Worker",
  );
});

Deno.test("HostHidden_ReturnMessage: seconds away, and the slow fallback", () => {
  assertEqual(
    HostHidden_ReturnMessage(12400, "worker"),
    "This tab was in the background for 12 s\n",
    "worker",
  );
  const slow = HostHidden_ReturnMessage(3000, "timer");
  if (!slow.includes("one frame a second")) {
    throw new Error("timer fallback is named: " + slow);
  }
  assertEqual(
    HostHidden_ReturnMessage(-5, "raf"),
    "This tab was in the background for 0 s\n",
    "clamped",
  );
});

Deno.test("HostHidden: hosting holds the wake lock and drives hidden frames", async () => {
  WakeLock_SetPlatform(null, null);
  const frames = [];
  HostHidden_Init((t) => frames.push(t));

  // Deno has no classic Worker, so the hidden driver falls back to the
  // page's timer here (the browser path is checked by hand)
  const log = console.log;
  console.log = () => {};
  try {
    HostHidden_SetHidden(true);
    assertEqual(HostHidden_Driver(), "raf", "hidden, not hosting");
    assertEqual(frames.length, 0, "no flush without a room");
    HostHidden_SetHidden(false);

    HostHidden_SetHosting(true);
    assertEqual(HostHidden_IsHosting(), true, "hosting");
    assertEqual(
      WakeLock_IsHeldFor(HOSTHIDDEN_WAKE_REASON),
      true,
      "wake lock reason",
    );
    assertEqual(HostHidden_Driver(), "raf", "shown: the animation loop");

    HostHidden_SetHidden(true);
    assertEqual(frames.length, 1, "one frame at once, to send the notice");
    const driver = HostHidden_Driver();
    if (driver !== "worker" && driver !== "timer") {
      throw new Error("hidden host has a driver: " + driver);
    }

    await new Promise((r) => setTimeout(r, HOSTHIDDEN_TICK_MS * 3));
    if (frames.length < 2) {
      throw new Error("ticks ran frames: " + frames.length);
    }
    for (let i = 1; i < frames.length; i++) {
      if (frames[i] < frames[i - 1]) throw new Error("timestamps go back");
    }

    HostHidden_SetHidden(false);
    assertEqual(HostHidden_Driver(), "raf", "shown again");
    const n = frames.length;
    await new Promise((r) => setTimeout(r, HOSTHIDDEN_TICK_MS * 2));
    assertEqual(frames.length, n, "no ticks once shown");

    // a room that ends while hidden stops the driver and the lock
    HostHidden_SetHidden(true);
    HostHidden_SetHosting(false);
    assertEqual(HostHidden_Driver(), "raf", "room ended");
    assertEqual(
      WakeLock_IsHeldFor(HOSTHIDDEN_WAKE_REASON),
      false,
      "lock released",
    );

    // a room listed while hidden starts the driver, and the return is told
    // to the joiners as for a hide while hosting
    const joiner = {
      active: true,
      spawned: true,
      netconnection: { driver: 2 },
    };
    joiner.message = new sizebuf_t();
    SZ_Alloc(joiner.message, 64);
    const saved = { maxclients: svs.maxclients, clients: svs.clients };
    svs.maxclients = 1;
    svs.clients = [joiner];
    try {
      HostHidden_SetHosting(true);
      const late = HostHidden_Driver();
      if (late !== "worker" && late !== "timer") {
        throw new Error("room listed while hidden has a driver: " + late);
      }
      HostHidden_SetHidden(false);
      const told = new TextDecoder().decode(
        joiner.message.data.subarray(1, joiner.message.cursize - 1),
      );
      assertEqual(told, HOSTHIDDEN_BACK_MESSAGE, "joiner told of the return");
    } finally {
      svs.maxclients = saved.maxclients;
      svs.clients = saved.clients;
    }
  } finally {
    HostHidden_SetHosting(false);
    HostHidden_SetHidden(false);
    console.log = log;
  }
});

Deno.test("HostHidden_TellJoiners: spawned remote clients only", () => {
  const make = (active, spawned, driver) => {
    const message = new sizebuf_t();
    SZ_Alloc(message, 64);
    return {
      active,
      spawned,
      netconnection: driver === null ? null : { driver },
      message,
    };
  };
  const clients = [
    make(true, true, 0), // the host's own player (loopback)
    make(true, true, 2), // a joiner
    make(true, false, 2), // still connecting
    make(false, false, null),
  ];
  const saved = { maxclients: svs.maxclients, clients: svs.clients };
  svs.maxclients = clients.length;
  svs.clients = clients;
  try {
    assertEqual(HostHidden_TellJoiners("away\n"), 1, "one told");
    assertEqual(clients[0].message.cursize, 0, "not the host");
    assertEqual(clients[1].message.data[0], svc_print, "svc_print");
    assertEqual(
      new TextDecoder().decode(
        clients[1].message.data.subarray(1, clients[1].message.cursize - 1),
      ),
      "away\n",
      "the text",
    );
    assertEqual(clients[2].message.cursize, 0, "not before spawn");
  } finally {
    svs.maxclients = saved.maxclients;
    svs.clients = saved.clients;
  }
});
