// NET_MultiplayerAvailable (src/net_main.js) after a real NET_Init: the menus
// ask it before the room list and Start Game, so a browser whose only remote
// transport is WebRTC (rooms hosted in browsers) must count. Its own file
// because NET_Init registers the drivers once per process, and
// tests/net_webrtc_test.js relies on it not having run.

// Bootstrap the renderer's existing circular module graph in its safe order.
await import("../src/gl_rsurf.js");

const netMain = await import("../src/net_main.js");
const { FakeRTCPeerConnection } = await import("./fake_webrtc.js");

// NET_Init and the drivers print through Con_Printf; keep the output quiet.
async function quietly(fn) {
  const original = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = original;
  }
}

// Deno has WebSocket, and may have WebTransport; take them away so NET_Init
// sees only the transports a test gives it. Restored afterwards.
const TRANSPORTS = ["WebTransport", "WebSocket", "RTCPeerConnection"];

async function withTransports(given, fn) {
  const saved = {};
  for (const name of TRANSPORTS) {
    saved[name] = Object.getOwnPropertyDescriptor(globalThis, name);
    delete globalThis[name];
  }
  // The WebRTC driver registers its page-hide handler on window.
  const hadWindow = "window" in globalThis;
  if (hadWindow === false) {
    globalThis.window = { addEventListener() {} };
  }
  Object.assign(globalThis, given);
  try {
    return await fn();
  } finally {
    for (const name of TRANSPORTS) {
      delete globalThis[name];
      if (saved[name] !== undefined) {
        Object.defineProperty(globalThis, name, saved[name]);
      }
    }
    if (hadWindow === false) delete globalThis.window;
  }
}

// One test, in order: NET_Init keeps a driver level once it has set it, so
// the case with no transports has to run first.
Deno.test("NET_MultiplayerAvailable counts the WebRTC driver", async () => {
  await withTransports({}, async () => {
    await quietly(() => netMain.NET_Init());
    if (netMain.NET_MultiplayerAvailable() !== false) {
      throw new Error("no remote transport: expected false");
    }
  });

  await withTransports(
    { RTCPeerConnection: FakeRTCPeerConnection },
    async () => {
      await quietly(() => netMain.NET_Init());
      if (netMain.NET_MultiplayerAvailable() !== true) {
        throw new Error("WebRTC only: expected true");
      }
    },
  );
});
