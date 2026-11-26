// Tests for the input and sound fixes from the second Ironwail review:
// stray key-ups, menu key repeat, GetWavinfo checks and the offset for an
// identical sound started twice in one frame.

const cmd = await import("../src/cmd.js");
const keys = await import("../src/keys.js");
const menu = await import("../src/menu.js");
const sound = await import("../src/sound.js");
const snd_dma = await import("../src/snd_dma.js");
const snd_mem = await import("../src/snd_mem.js");
const pak = await import("../src/pak.js");

const { K_DOWNARROW, K_UPARROW, K_ENTER, K_ESCAPE } = keys;

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${
        JSON.stringify(actual)
      }`,
    );
  }
}

cmd.Cbuf_Init();
cmd.Cmd_Init();
keys.Key_Init();
menu.M_Init();

const fakeCls = { state: 0, demonum: -1, demoplayback: false, signon: 0 };
keys.Key_SetExternals({ cls: fakeCls });

let localSounds = 0;
menu.M_SetExternals({
  key_dest_set: keys.set_key_dest,
  key_dest_get: () => keys.key_dest,
  cls: fakeCls,
  S_LocalSound: () => {
    localSounds++;
  },
});

// Runs the command buffer and returns what the bound commands did
let traced = [];
cmd.Cmd_AddCommand("+trace", () => {
  traced.push("+trace " + cmd.Cmd_Argv(1));
});
cmd.Cmd_AddCommand("-trace", () => {
  traced.push("-trace " + cmd.Cmd_Argv(1));
});

function runBuffer() {
  traced = [];
  cmd.Cbuf_Execute();
  return traced.join(",");
}

/*
==============================================================================

			KEYS

==============================================================================
*/

Deno.test("Key_Event drops key-ups for keys that were never down", () => {
  const oldBindings = keys.keybindings.slice();

  try {
    keys.Key_ClearStates();
    keys.set_key_dest(keys.key_game);
    keys.Key_SetBinding(119, "+trace"); // 'w'
    runBuffer();

    const count = keys.key_count;
    keys.Key_Event(119, false); // stray: e.g. released after alt-tabbing back
    assertEqual(runBuffer(), "", "a stray key-up sends no -command");
    assertEqual(keys.key_count, count, "a stray key-up is not a keypress");

    keys.Key_Event(119, true);
    keys.Key_Event(119, false);
    assertEqual(
      runBuffer(),
      "+trace 119,-trace 119",
      "a real press and release still work",
    );

    keys.Key_Event(119, false);
    assertEqual(runBuffer(), "", "a second key-up is stray too");
  } finally {
    keys.keybindings.splice(0, keys.keybindings.length, ...oldBindings);
    keys.Key_ClearStates();
  }
});

Deno.test("a stray key-up does not answer a modal prompt", () => {
  keys.Key_ClearStates();
  let answer = null;
  keys.Key_BeginModal((yes) => {
    answer = yes;
  });

  try {
    keys.Key_Event(121, false); // stray 'y' up
    assertEqual(keys.Key_ModalActive(), true, "the prompt is still waiting");
    keys.Key_Event(110, true); // 'n'
    keys.Key_Event(110, false);
    assertEqual(answer, false, "the next real key answers it");
  } finally {
    if (keys.Key_ModalActive()) {
      keys.Key_Event(K_ESCAPE, true);
      keys.Key_Event(K_ESCAPE, false);
    }

    keys.Key_ClearStates();
  }
});

Deno.test("menus let held arrow keys repeat but not Enter", () => {
  keys.Key_ClearStates();
  menu.M_Menu_Main_f();
  assertEqual(keys.key_dest, keys.key_menu, "main menu open");

  try {
    localSounds = 0;
    keys.Key_Event(K_DOWNARROW, true);
    keys.Key_Event(K_DOWNARROW, true); // browser autorepeat
    keys.Key_Event(K_DOWNARROW, true);
    keys.Key_Event(K_DOWNARROW, false);
    assertEqual(localSounds, 3, "each arrow repeat moves the cursor");

    // Back up to Single Player, then hold Enter: one press only, so the
    // repeat doesn't also pick the single player menu's first item
    for (let i = 0; i < 3; i++) {
      keys.Key_Event(K_UPARROW, true);
      keys.Key_Event(K_UPARROW, false);
    }

    keys.Key_Event(K_ENTER, true);
    keys.Key_Event(K_ENTER, true); // repeat, ignored
    keys.Key_Event(K_ENTER, false);
    assertEqual(menu.m_state, menu.m_singleplayer, "Enter did not repeat");
  } finally {
    keys.Key_ClearStates();
    keys.set_key_dest(keys.key_game);
  }
});

Deno.test("a held arrow just bound in the keys menu does not repeat into the list", () => {
  const oldBindings = keys.keybindings.slice();
  keys.Key_ClearStates();
  cmd.Cmd_ExecuteString("menu_keys");
  assertEqual(menu.m_state, menu.m_keys, "keys menu open");

  try {
    keys.Key_Event(K_ENTER, true); // start the grab
    keys.Key_Event(K_ENTER, false);

    localSounds = 0;
    keys.Key_Event(K_UPARROW, true); // bound
    keys.Key_Event(K_UPARROW, true); // held past the repeat delay
    keys.Key_Event(K_UPARROW, true);
    assertEqual(localSounds, 1, "only the grab itself");
    keys.Key_Event(K_UPARROW, false);
    cmd.Cbuf_Execute();
    assertEqual(
      keys.keybindings[K_UPARROW],
      "+attack",
      "Up bound to the first action",
    );

    // A fresh press of the same key navigates and repeats again
    localSounds = 0;
    keys.Key_Event(K_UPARROW, true);
    keys.Key_Event(K_UPARROW, true);
    keys.Key_Event(K_UPARROW, false);
    assertEqual(localSounds, 2, "press and repeat both move the cursor");
  } finally {
    keys.keybindings.splice(0, keys.keybindings.length, ...oldBindings);
    keys.Key_ClearStates();
    keys.set_key_dest(keys.key_game);
  }
});

/*
==============================================================================

			SOUND

==============================================================================
*/

const started = [];

class FakeAudioContext {
  constructor() {
    this.state = "running";
    this.sampleRate = 48000;
    this.destination = {};
    this.currentTime = 0;
  }

  createGain() {
    return { gain: { value: 1 }, connect() {} };
  }
  createChannelMerger() {
    return { connect() {} };
  }
  createBuffer(channels, length, rate) {
    const data = new Float32Array(length);
    return {
      numberOfChannels: channels,
      length,
      sampleRate: rate,
      getChannelData: () => data,
    };
  }

  createBufferSource() {
    const source = {
      buffer: null,
      loop: false,
      loopStart: 0,
      loopEnd: 0,
      offset: 0,
      connect() {},
      start(_when, offset) {
        this.offset = offset ?? 0;
        started.push(this);
      },
      stop() {},
    };
    return source;
  }

  suspend() {
    this.state = "suspended";
    return Promise.resolve();
  }
  resume() {
    this.state = "running";
    return Promise.resolve();
  }
  close() {
    return Promise.resolve();
  }
}

// Mono PCM WAV. opts: bits (8), loopstart (-1 = no cue chunk), mark (loop
// length in a LIST/mark chunk, needs a cue)
function makeWav(samples, opts = {}) {
  const bits = opts.bits ?? 8;
  const loopstart = opts.loopstart ?? -1;
  const width = bits === 16 ? 2 : 1;
  const cue = loopstart >= 0 ? 8 + 28 : 0;
  const list = opts.mark !== undefined ? 8 + 28 : 0;
  const datalen = samples * width;
  const bytes = new Uint8Array(
    12 + 8 + 16 + cue + list + 8 + datalen + (datalen & 1),
  );
  const view = new DataView(bytes.buffer);
  const tag = (ofs, s) => {
    for (let i = 0; i < 4; i++) bytes[ofs + i] = s.charCodeAt(i);
  };

  tag(0, "RIFF");
  view.setUint32(4, bytes.length - 8, true);
  tag(8, "WAVE");
  let p = 12;
  tag(p, "fmt ");
  view.setUint32(p + 4, 16, true);
  view.setUint16(p + 8, 1, true); // PCM
  view.setUint16(p + 10, 1, true); // mono
  view.setUint32(p + 12, 11025, true);
  view.setUint32(p + 16, 11025 * width, true);
  view.setUint16(p + 20, width, true);
  view.setUint16(p + 22, bits, true);
  p += 24;
  if (cue) {
    tag(p, "cue ");
    view.setUint32(p + 4, 28, true);
    view.setUint32(p + 8, 1, true);
    view.setUint32(p + 32, loopstart, true); // sampleOffset, read at chunk + 32
    p += cue;
  }

  if (list) {
    tag(p, "LIST");
    view.setUint32(p + 4, 28, true);
    view.setUint32(p + 24, opts.mark, true); // samples in loop, read at chunk + 24
    tag(p + 28, "mark");
    p += list;
  }

  tag(p, "data");
  view.setUint32(p + 4, datalen, true);
  for (let i = 0; i < datalen; i++) {
    bytes[p + 8 + i] = i & 0xff;
  }

  return bytes;
}

function addFakePack(files) {
  let size = 0;
  for (const f of files) size += f.data.length;
  const data = new Uint8Array(size);
  const entries = [];
  let pos = 0;
  for (const f of files) {
    data.set(f.data, pos);
    entries.push({ name: f.name, filepos: pos, filelen: f.data.length });
    pos += f.data.length;
  }

  pak.COM_AddPack({
    filename: "review.pak",
    files: entries,
    data: data.buffer,
  });
}

addFakePack([
  { name: "sound/review/ok.wav", data: makeWav(2000) },
  { name: "sound/review/ok16.wav", data: makeWav(500, { bits: 16 }) },
  { name: "sound/review/bits12.wav", data: makeWav(500, { bits: 12 }) },
  { name: "sound/review/empty.wav", data: makeWav(0) },
]);

function withSound(fn) {
  const hadWindow = "window" in globalThis;
  const oldWindow = globalThis.window;
  globalThis.window = { AudioContext: FakeAudioContext };

  try {
    snd_dma.S_Init();
    fn();
  } finally {
    snd_dma.S_StopAllSounds(true);
    snd_dma.S_Shutdown();
    if (hadWindow) globalThis.window = oldWindow;
    else delete globalThis.window;
  }
}

Deno.test("S_LoadSound refuses widths other than 8 or 16 bit and empty sounds", () => {
  withSound(() => {
    assertEqual(
      snd_mem.S_LoadSound(snd_dma.S_PrecacheSound("review/bits12.wav")),
      null,
      "12-bit refused",
    );
    assertEqual(
      snd_mem.S_LoadSound(snd_dma.S_PrecacheSound("review/empty.wav")),
      null,
      "zero samples refused",
    );

    const sc16 = snd_mem.S_LoadSound(
      snd_dma.S_PrecacheSound("review/ok16.wav"),
    );
    assertEqual(sc16 !== null && sc16.length, 500, "16-bit still loads");
  });
});

Deno.test("GetWavinfo drops a loop that starts at or past the end", () => {
  const lateWav = makeWav(400, { loopstart: 400 });
  const late = snd_mem.GetWavinfo("latecue", lateWav, lateWav.length);
  assertEqual(late.loopstart, -1, "loop start >= end: not looped");
  assertEqual(late.samples, 400, "all samples kept");

  const markedWav = makeWav(400, { loopstart: 100, mark: 200 });
  const marked = snd_mem.GetWavinfo("marked", markedWav, markedWav.length);
  assertEqual(marked.loopstart, 100, "a good cue is kept");
  assertEqual(marked.samples, 300, "the mark chunk sets the loop end");
});

Deno.test("an identical sound started twice in one frame starts the second one offset", () => {
  withSound(() => {
    const sfx = snd_dma.S_PrecacheSound("review/ok.wav");
    const origin = new Float32Array(3);
    const zero = new Float32Array(3);
    const fwd = new Float32Array([1, 0, 0]);
    const right = new Float32Array([0, -1, 0]);
    const up = new Float32Array([0, 0, 1]);
    snd_dma.S_Update(zero, fwd, right, up);

    // Math.random is the C rand(); pin it so the skip is known
    const oldRandom = Math.random;
    Math.random = () => 0.5;

    try {
      started.length = 0;
      snd_dma.S_StartSound(1, 1, sfx, origin, 1, 0);
      snd_dma.S_StartSound(2, 1, sfx, origin, 1, 0);
      assertEqual(started.length, 2, "both play");
      assertEqual(started[0].offset, 0, "the first starts at 0");

      // skip = rand() % (0.1 * 11025) = 551 samples at 11025 Hz
      const skip = Math.floor(0.5 * Math.floor(0.1 * sound.shm.speed));
      assertEqual(started[1].offset, skip / 11025, "the second is offset");

      const ch = sound.channels.find((c) => c.entnum === 2 && c.sfx === sfx);
      assertEqual(ch.pos, skip, "pos holds the skip");
      assertEqual(
        ch.end,
        sound.paintedtime + 2000 - skip,
        "end moves in by the skip",
      );

      // A different sound in the same frame is not offset
      snd_dma.S_StartSound(
        4,
        1,
        snd_dma.S_PrecacheSound("review/ok16.wav"),
        origin,
        1,
        0,
      );
      assertEqual(started[2].offset, 0, "another sfx starts at 0");

      // Next frame: the earlier ones count as mixed, no offset
      snd_dma.S_Update(zero, fwd, right, up);
      snd_dma.S_StartSound(3, 1, sfx, origin, 1, 0);
      assertEqual(started[3].offset, 0, "a later frame starts at 0");
    } finally {
      Math.random = oldRandom;
    }
  });
});
