// The lazy map fetch in CL_ParseServerInfo (web-only) during demo playback:
// the demo holds at its serverinfo message until the map is fetched, then
// reads that message again. The map can be a loose file or an entry of a
// lazily opened pak (LibreQuake's paks are over com_lazypaksize).
//
// Also id's vid.recalc_refdef at svc_intermission, svc_finale, svc_cutscene
// and svc_serverinfo (WinQuake cl_parse.c CL_ParseServerMessage), which takes
// the view full screen.

await import("../src/gl_rsurf.js");
const common = await import("../src/common.js");
const consolejs = await import("../src/console.js");
const { CL_ParseServerMessage } = await import("../src/cl_parse.js");
const demo = await import("../src/cl_demo.js");
const { cls } = await import("../src/client.js");
const { vid } = await import("../src/vid.js");
const {
  COM_AddPakSequence,
  COM_FindFile,
  COM_LAZY_PAK_SIZE,
  COM_SetLazyPakSize,
  COM_SetLooseFileBasePath,
} = await import("../src/pak.js");
const {
  PROTOCOL_VERSION,
  GAME_COOP,
  svc_serverinfo,
  svc_signonnum,
  svc_intermission,
  svc_finale,
  svc_cutscene,
} = await import("../src/protocol.js");

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${
        JSON.stringify(actual)
      }`,
    );
  }
}

const printed = [];
common.Con_SetPrintFunctions(
  (fmt, ...args) => {
    const s = args.length === 0 ?
      String(fmt) :
      consolejs._sprintf(fmt, ...args);
    printed.push(s);
    return s;
  },
  () => {},
);

const enc = new TextEncoder();

/** A message: svc_serverinfo for map, then svc_signonnum 1 */
function serverinfo(map) {
  const bytes = [svc_serverinfo];
  const long = new Uint8Array(4);
  new DataView(long.buffer).setInt32(0, PROTOCOL_VERSION, true);
  bytes.push(...long, 1, GAME_COOP);
  for (const s of ["Demo fetch test", map, "progs/player.mdl", ""]) {
    bytes.push(...enc.encode(s), 0);
  }
  bytes.push(...enc.encode("misc/null.wav"), 0, 0); // sounds
  bytes.push(svc_signonnum, 1);
  return bytes;
}

const TRACK = "-1\n";

/** Demo data: the track line, then each message with its angles */
function demoData(messages) {
  let size = TRACK.length;
  for (const m of messages) size += 16 + m.length;
  const data = new Uint8Array(size);
  const view = new DataView(data.buffer);
  data.set(enc.encode(TRACK));
  let at = TRACK.length;
  for (const m of messages) {
    view.setInt32(at, m.length, true);
    data.set(m, at + 16);
    at += 16 + m.length;
  }
  return data.buffer;
}

// A pack of entries [ name, Uint8Array ]: header, bodies, then the directory
function makePak(entries) {
  let dirofs = 12;
  for (const [, body] of entries) dirofs += body.length;
  const bytes = new Uint8Array(dirofs + 64 * entries.length);
  const view = new DataView(bytes.buffer);
  bytes.set([0x50, 0x41, 0x43, 0x4B], 0); // 'PACK'
  view.setInt32(4, dirofs, true);
  view.setInt32(8, 64 * entries.length, true);
  let pos = 12;
  entries.forEach(([name, body], i) => {
    bytes.set(body, pos);
    const e = dirofs + i * 64;
    bytes.set(enc.encode(name), e);
    view.setInt32(e + 56, pos, true);
    view.setInt32(e + 60, body.length, true);
    pos += body.length;
  });
  return bytes;
}

// Stub fetch serving one pak by URL, with HTTP Range
function stubFetch(url, body) {
  return (u, init) => {
    if (u !== url) {
      return Promise.resolve(new Response("missing", { status: 404 }));
    }
    const range = init !== undefined && init.headers !== undefined ?
      init.headers.Range :
      undefined;
    if (range === undefined) {
      return Promise.resolve(new Response(body, { status: 200 }));
    }
    const m = /^bytes=(\d+)-(\d+)$/.exec(range);
    const start = parseInt(m[1], 10);
    const end = Math.min(parseInt(m[2], 10), body.length - 1);
    return Promise.resolve(
      new Response(body.slice(start, end + 1), {
        status: 206,
        headers: { "content-range": `bytes ${start}-${end}/${body.length}` },
      }),
    );
  };
}

/** Waits until the demo stops holding (CL_GetMessage reads again) */
async function untilRead(timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    const r = demo.CL_GetMessage();
    if (r !== 0 || cls.demoplayback !== true) {
      return r;
    }
  }
  return 0;
}

/**
 * Plays a demo whose first message needs map, and parses that message.
 * Returns where the message starts.
 */
function startDemo(map, second) {
  const messages = [serverinfo(map)];
  if (second !== undefined) messages.push(second);
  demo.CL_PlayDemoFromData(demoData(messages));
  cls.signon = 0; // always grab until fully connected
  cls.demonum = 0; // in the attract loop
  printed.length = 0;

  const start = cls.demopos;
  assertEqual(demo.CL_GetMessage(), 1, "serverinfo message read");
  vid.recalc_refdef = 0;
  CL_ParseServerMessage();
  return start;
}

/** The checks after CL_ParseServerMessage for a map that isn't there yet */
function assertHolding(start, map) {
  assertEqual(cls.demoplayback, true, "still playing");
  assertEqual(cls.demopos, start, "rewound to the serverinfo message");
  assertEqual(cls.signon, 0, "rest of the message (svc_signonnum) discarded");
  assertEqual(Boolean(vid.recalc_refdef), true, "serverinfo recalcs refdef");
  assertEqual(
    printed.includes("Fetching " + map + "...\n"),
    true,
    "fetch announced: " + printed.join(""),
  );
  assertEqual(demo.CL_GetMessage(), 0, "no message while the map is fetched");
  assertEqual(cls.demopos, start, "nothing read while holding");
}

async function withDemo(fn) {
  const oldMessage = common.net_message;
  const message = new common.sizebuf_t();
  message.data = new Uint8Array(1024);
  message.maxsize = 1024;
  common.COM_SetNetMessage(message);
  const saved = { demonum: cls.demonum, signon: cls.signon };
  const tempDir = await Deno.makeTempDir();
  try {
    await fn(tempDir);
  } finally {
    demo.CL_StopPlayback();
    cls.demonum = saved.demonum;
    cls.signon = saved.signon;
    common.COM_SetNetMessage(oldMessage);
    COM_SetLooseFileBasePath("static/");
    await Deno.remove(tempDir, { recursive: true });
  }
}

Deno.test("a demo holds for a loose map, then reads its serverinfo again", async () => {
  await withDemo(async (dir) => {
    const map = "maps/__demofetch_loose.bsp";
    await Deno.mkdir(dir + "/maps");
    await Deno.writeFile(dir + "/" + map, new Uint8Array([1, 2, 3]));
    COM_SetLooseFileBasePath(dir + "/");

    const start = startDemo(map);
    assertHolding(start, map);

    assertEqual(await untilRead(2000), 1, "serverinfo read again");
    assertEqual(cls.demoplayback, true, "still playing");
    assertEqual(COM_FindFile(map) !== null, true, "map fetched");
    assertEqual(
      common.net_message.data[0],
      svc_serverinfo,
      "the same message",
    );
    assertEqual(
      printed.some((s) => s.startsWith("Couldn't fetch")),
      false,
      "no failure printed: " + printed.join(""),
    );
  });
});

Deno.test("a demo holds for a map in a lazily opened pak", async () => {
  const realFetch = globalThis.fetch;
  COM_SetLazyPakSize(0);
  try {
    await withDemo(async () => {
      const map = "maps/__demofetch_pak.bsp";
      const url = "http://demofetch.test/id1/pak0.pak";
      globalThis.fetch = stubFetch(
        url,
        makePak([[map, new Uint8Array(40000).fill(7)]]),
      );
      assertEqual(await COM_AddPakSequence(url), 1, "pak added");
      assertEqual(COM_FindFile(map), null, "map entry deferred");

      const start = startDemo(map);
      assertHolding(start, map);

      assertEqual(await untilRead(2000), 1, "serverinfo read again");
      assertEqual(COM_FindFile(map) !== null, true, "map fetched");
      assertEqual(
        printed.some((s) => s.startsWith("Couldn't fetch")),
        false,
        "no failure printed: " + printed.join(""),
      );
    });
  } finally {
    COM_SetLazyPakSize(COM_LAZY_PAK_SIZE);
    globalThis.fetch = realFetch;
  }
});

Deno.test("a map that can't be fetched ends the demo and the demo loop", async () => {
  await withDemo(async (dir) => {
    const map = "maps/__demofetch_missing.bsp";
    COM_SetLooseFileBasePath(dir + "/");

    const start = startDemo(map);
    assertHolding(start, map);

    await untilRead(2000);
    assertEqual(cls.demoplayback, false, "playback ended");
    assertEqual(cls.demonum, -1, "demo loop stopped");
    assertEqual(
      printed.includes("Couldn't fetch " + map + "\n"),
      true,
      "failure printed: " + printed.join(""),
    );
  });
});

Deno.test("a fetch that ends after the demo was replaced leaves the new demo alone", async () => {
  await withDemo(async (dir) => {
    const map = "maps/__demofetch_replaced.bsp";
    COM_SetLooseFileBasePath(dir + "/");

    const start = startDemo(map);
    assertHolding(start, map);

    // Another demo starts before the (failing) fetch ends
    demo.CL_PlayDemoFromData(demoData([[1]])); // svc_nop
    cls.demonum = 0;
    cls.signon = 0;
    await new Promise((resolve) => setTimeout(resolve, 100));
    assertEqual(cls.demoplayback, true, "new demo still playing");
    assertEqual(cls.demonum, 0, "demo loop untouched");
    assertEqual(demo.CL_GetMessage(), 1, "new demo reads");
  });
});

Deno.test("intermission, finale, cutscene and serverinfo recalc the refdef", () => {
  const oldMessage = common.net_message;
  const message = new common.sizebuf_t();
  message.data = new Uint8Array(64);
  message.maxsize = 64;
  common.COM_SetNetMessage(message);
  try {
    for (
      const [name, bytes] of [
        ["svc_intermission", [svc_intermission]],
        ["svc_finale", [svc_finale, ...enc.encode("The end"), 0]],
        ["svc_cutscene", [svc_cutscene, 0]],
      ]
    ) {
      vid.recalc_refdef = 0;
      message.data.set(bytes);
      message.cursize = bytes.length;
      CL_ParseServerMessage();
      assertEqual(Boolean(vid.recalc_refdef), true, name);
    }
  } finally {
    common.COM_SetNetMessage(oldMessage);
    vid.recalc_refdef = 0;
  }
});
