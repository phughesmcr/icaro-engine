// Tests for external music formats: QuakeSpasm bgmusic.c's extension search
// order, the music command and its music_* companions, snd_umx.c's container
// parsing, and the tracker player (with a stand-in for libopenmpt).

const cmd = await import("../src/cmd.js");
const cd_audio = await import("../src/cd_audio.js");
const bgm_tracker = await import("../src/bgm_tracker.js");
const snd_dma = await import("../src/snd_dma.js");
const sound = await import("../src/sound.js");
const pak = await import("../src/pak.js");
const { UMX_FindMusic, UMX_GetFCI } = await import("../src/snd_umx.js");
const { fci, makeMOD, makeUMX, makeWAV } = await import("./music_fixtures.js");

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

cmd.Cbuf_Init();
cmd.Cmd_Init();

const ALL = [
  "ogg",
  "opus",
  "mp3",
  "flac",
  "wav",
  "it",
  "s3m",
  "xm",
  "mod",
  "umx",
];

Deno.test("the music handlers keep bgmusic.c's order", () => {
  assertEqual(
    cd_audio.MUSIC_HANDLERS.map((h) => h.ext).join(" "),
    ALL.join(" "),
    "wanted_handlers order",
  );
  assertEqual(
    cd_audio.CDAudio_DetectMusicExtensions(() => "maybe", true).join(" "),
    ALL.join(" "),
    "everything available",
  );
});

Deno.test("a format the browser can't play is skipped for the next one", () => {
  // Safari without Ogg: no ogg or opus
  const safari = (mime) => mime.startsWith("audio/ogg") ? "" : "maybe";
  assertEqual(
    cd_audio.CDAudio_DetectMusicExtensions(safari, true).join(" "),
    "mp3 flac wav it s3m xm mod umx",
    "no Ogg",
  );
  const noOpus = (mime) => mime.includes("opus") ? "" : "probably";
  assertEqual(
    cd_audio.CDAudio_DetectMusicExtensions(noOpus, false).join(" "),
    "ogg mp3 flac wav",
    "no Opus, no Web Audio for trackers",
  );
  assertEqual(
    cd_audio.CDAudio_DetectMusicExtensions(null, false).join(" "),
    "ogg opus mp3 flac wav",
    "no canPlayType: every streamed format is tried",
  );
});

Deno.test("CD tracks search each game directory in extension order", () => {
  try {
    cd_audio.CDAudio_SetMusicExtensions(ALL);
    const urls = cd_audio.CDAudio_TrackURLs(7, ["static/hipnotic", "static"]);
    assertEqual(urls.length, 20, "count");
    assertEqual(urls[0], "static/hipnotic/music/track07.ogg", "first");
    assertEqual(urls[1], "static/hipnotic/music/track07.opus", "opus second");
    assertEqual(urls[3], "static/hipnotic/music/track07.flac", "flac fourth");
    assertEqual(urls[9], "static/hipnotic/music/track07.umx", "umx last");
    assertEqual(urls[10], "static/music/track07.ogg", "then id1's");
  } finally {
    cd_audio.CDAudio_SetMusicExtensions(null);
  }
});

Deno.test("music <name> URLs: with an extension, without one, and unhandled", () => {
  try {
    cd_audio.CDAudio_SetMusicExtensions(["ogg", "mp3", "it"]);
    const dirs = ["static/mod", "static"];
    assertEqual(
      cd_audio.CDAudio_MusicURLs("boss.IT", dirs).join(" "),
      "static/mod/music/boss.IT static/music/boss.IT",
      "an extension is matched in any case",
    );
    // BGM_Play_noext: each extension, each in every directory
    assertEqual(
      cd_audio.CDAudio_MusicURLs("boss", dirs).join(" "),
      "static/mod/music/boss.ogg static/music/boss.ogg " +
        "static/mod/music/boss.mp3 static/music/boss.mp3 " +
        "static/mod/music/boss.it static/music/boss.it",
      "no extension",
    );
    assertEqual(
      cd_audio.CDAudio_MusicURLs("boss.flac", dirs),
      null,
      "an unavailable handler is unhandled",
    );
    assertEqual(
      cd_audio.CDAudio_MusicURLs("boss.mid", dirs),
      null,
      "an unknown extension is unhandled",
    );
  } finally {
    cd_audio.CDAudio_SetMusicExtensions(null);
  }
});

Deno.test("COM_FileGetExtension: the last component's extension only", () => {
  assertEqual(cd_audio.CDAudio_FileExtension("a/b.OGG"), "ogg", "ext");
  assertEqual(cd_audio.CDAudio_FileExtension("a.d/b"), "", "dotted dir");
  assertEqual(cd_audio.CDAudio_FileExtension("track02"), "", "none");
  assertEqual(cd_audio.CDAudio_FileExtension("x.tar.umx"), "umx", "last dot");
});

Deno.test("FCompactIndex decodes signs and multi-byte values", () => {
  for (const v of [0, 1, 63, 64, -2, 8191, 8192, -100000, 123456789]) {
    const bytes = new Uint8Array(fci(v));
    const cursor = { pos: 0 };
    assertEqual(UMX_GetFCI(bytes, cursor), v, "value " + v);
    assertEqual(cursor.pos, bytes.length, "length for " + v);
  }
});

Deno.test("UMX: the module inside an Unreal and a UT package is found", () => {
  const mod = makeMOD();
  for (const version of [61, 68]) {
    const umx = makeUMX(mod, "Mod", version);
    const music = UMX_FindMusic(umx.bytes);
    if (music === null) throw new Error("no music in v" + version);
    assertEqual(music.type, "mod", "type v" + version);
    assertEqual(music.offset, umx.offset, "offset v" + version);
    assertEqual(music.size, mod.length, "size v" + version);
    const inner = umx.bytes.subarray(music.offset, music.offset + music.size);
    assertEqual(inner[1080], 0x4d, "M.K. at 1080 v" + version);
  }
});

Deno.test("UMX: an s3m that is really an it, and WAV payloads", () => {
  // SpaceMarines.umx and Starseek.umx report s3m but hold an it
  const it = new Uint8Array(200);
  it.set([0x49, 0x4d, 0x50, 0x4d]); // "IMPM"
  const s3m = UMX_FindMusic(makeUMX(it, "S3M").bytes);
  assertEqual(s3m?.type, "it", "s3m retried as it");

  const wav = UMX_FindMusic(makeUMX(makeWAV(), "WAV", 68).bytes);
  assertEqual(wav?.type, "wav", "wav");
});

Deno.test("UMX: what isn't a umx with music is refused", () => {
  const mod = makeMOD();
  assertEqual(UMX_FindMusic(mod), null, "a bare module");
  assertEqual(UMX_FindMusic(new Uint8Array(10)), null, "too short");

  const wrongClass = makeUMX(mod, "Texture").bytes;
  assertEqual(UMX_FindMusic(wrongClass), null, "not a music class");

  const lying = makeUMX(makeWAV(), "XM").bytes;
  assertEqual(UMX_FindMusic(lying), null, "class doesn't match data");

  const umx = makeUMX(mod, "MOD").bytes;
  assertEqual(
    UMX_FindMusic(umx.subarray(0, umx.length - 20)),
    null,
    "export table cut off",
  );
  const badSize = makeUMX(mod, "MOD", 61, mod.length + 100).bytes;
  assertEqual(UMX_FindMusic(badSize), null, "size past the end");
  const fits = makeUMX(mod, "MOD", 61, mod.length - 100).bytes;
  assertEqual(UMX_FindMusic(fits)?.size, mod.length - 100, "size taken as is");
});

// A stand-in for libopenmpt: a song lengthFrames long; bytes starting with 0
// don't open.
function fakeLibopenmpt(lengthFrames) {
  const memory = new ArrayBuffer(1 << 20);
  let top = 16;
  const lib = {
    HEAPU8: new Uint8Array(memory),
    HEAPF32: new Float32Array(memory),
    modules: 0,
    destroyed: 0,
    repeat: null,
    played: 0,
    seeks: [],
    jumps: [],
    _malloc(n) {
      const p = top;
      top += (n + 7) & ~7;
      return p;
    },
    _free() {},
    _openmpt_module_create_from_memory2(ptr) {
      if (lib.HEAPU8[ptr] === 0) return 0;
      lib.modules++;
      return 99;
    },
    _openmpt_module_destroy() {
      lib.destroyed++;
    },
    _openmpt_module_set_repeat_count(_mod, n) {
      lib.repeat = n;
    },
    _openmpt_module_get_position_seconds() {
      return lib.played / 48000;
    },
    _openmpt_module_set_position_seconds(_mod, s) {
      lib.seeks.push(s);
      lib.played = Math.round(s * 48000);
    },
    _openmpt_module_set_position_order_row(_mod, order, row) {
      lib.jumps.push([order, row]);
      lib.played = 0;
    },
    _openmpt_module_read_float_stereo(_mod, _rate, count) {
      if (lib.repeat === -1) {
        lib.played += count;
        return count;
      }
      const n = Math.max(0, Math.min(count, lengthFrames - lib.played));
      lib.played += n;
      return n;
    },
  };
  return lib;
}

class FakeSource {
  constructor(ctx) {
    this.ctx = ctx;
    this.onended = null;
    this.stopped = false;
    ctx.sources.push(this);
  }
  connect(node) {
    this.output = node;
  }
  disconnect() {}
  start(when, _offset, duration) {
    this.when = when;
    this.duration = duration;
  }
  stop() {
    this.stopped = true;
  }
}

class FakeContext {
  constructor() {
    this.state = "running";
    this.sampleRate = 48000;
    this.currentTime = 0;
    this.destination = {};
    this.sources = [];
    this.gains = [];
  }
  createGain() {
    const g = { gain: { value: 1 }, connect() {}, disconnect() {} };
    this.gains.push(g);
    return g;
  }
  createMediaElementSource() {
    return { connect() {}, disconnect() {} };
  }
  createBuffer(channels, length) {
    return { channels, length, copyToChannel() {} };
  }
  createBufferSource() {
    return new FakeSource(this);
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

/** Ends every source the audio clock has passed, as the browser would */
function advance(ctx, seconds) {
  ctx.currentTime += seconds;
  for (const s of ctx.sources) {
    if (
      !s.stopped && s.onended !== null && s.when + s.duration <= ctx.currentTime
    ) {
      const f = s.onended;
      s.onended = null;
      f();
    }
  }
}

Deno.test("tracker player: renders ahead, ends once after the last chunk", () => {
  const ctx = new FakeContext();
  const lib = fakeLibopenmpt(48000); // a one-second song
  let ended = 0;
  const player = bgm_tracker.BGM_TrackerPlayer.create(
    lib,
    ctx,
    {},
    new Uint8Array([1, 2, 3]),
    false,
    () => ended++,
  );
  if (player === null) throw new Error("no player");
  assertEqual(lib.repeat, 0, "no repeat");
  assertEqual(ctx.sources.length, 0, "starts paused");

  player.resume();
  assertEqual(ctx.sources.length > 0, true, "chunks scheduled");
  const first = ctx.sources[0];
  assertEqual(first.when, 0.05, "first chunk just after now");
  assertEqual(
    ctx.sources[1].when,
    first.when + first.duration,
    "chunks back to back",
  );

  for (let i = 0; i < 20; i++) {
    player.pump();
    advance(ctx, 0.25);
  }
  assertEqual(lib.played, 48000, "whole song rendered");
  assertEqual(ended, 1, "ended once");
  player.destroy();
  assertEqual(lib.destroyed, 1, "module destroyed");
});

Deno.test("tracker player: pause winds back to what was heard", () => {
  const ctx = new FakeContext();
  const lib = fakeLibopenmpt(48000 * 60);
  const player = bgm_tracker.BGM_TrackerPlayer.create(
    lib,
    ctx,
    {},
    new Uint8Array([1]),
    true,
    null,
  );
  assertEqual(lib.repeat, -1, "repeats forever");
  player.resume();
  for (let i = 0; i < 4; i++) player.pump();
  advance(ctx, 1.0);
  const rendered = lib.played / 48000;
  assertEqual(rendered > 1.5, true, "rendered ahead of the clock");

  player.pause();
  assertEqual(
    ctx.sources.every((s) => s.stopped || s.onended === null),
    true,
    "sources stopped",
  );
  const pos = lib.seeks[lib.seeks.length - 1];
  assertEqual(Math.abs(pos - 0.95) < 1e-6, true, "position heard: " + pos);

  const before = ctx.sources.length;
  player.resume();
  assertEqual(ctx.sources.length > before, true, "carries on");

  player.setLoop(false);
  assertEqual(lib.repeat, 0, "music_loop off");
  player.jump(3);
  assertEqual(lib.jumps[0].join(","), "3,0", "music_jump");
  player.destroy();
});

Deno.test("an unreadable module gives no player", () => {
  const ctx = new FakeContext();
  const lib = fakeLibopenmpt(100);
  const player = bgm_tracker.BGM_TrackerPlayer.create(
    lib,
    ctx,
    {},
    new Uint8Array([0]),
    false,
    null,
  );
  assertEqual(player, null, "refused");
});

// A stand-in for HTMLAudioElement; play() always succeeds
class FakeAudio {
  constructor() {
    this.src = "";
    this.loop = false;
    this.volume = 1;
    this.currentTime = 0;
    this.onerror = null;
    this.onended = null;
    this.error = null;
    this.plays = [];
    FakeAudio.last = this;
  }
  play() {
    this.plays.push(this.src);
    return Promise.resolve();
  }
  pause() {}
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Runs fn with stand-ins for the element, Web Audio, fetch (files maps a
 * URL to its bytes; anything else is a 404) and libopenmpt.
 */
async function withMusic(files, fn) {
  const saved = {
    Audio: globalThis.Audio,
    window: globalThis.window,
    fetch: globalThis.fetch,
    createObjectURL: URL.createObjectURL,
    revokeObjectURL: URL.revokeObjectURL,
  };
  const ctx = new FakeContext();
  const lib = fakeLibopenmpt(48000 * 30);
  const loads = { count: 0 };
  const fetched = [];
  globalThis.Audio = FakeAudio;
  FakeAudio.last = null;
  globalThis.window = {
    AudioContext: function () {
      return ctx;
    },
  };
  globalThis.fetch = (url) => {
    fetched.push(url);
    const bytes = files[url];
    return Promise.resolve(
      bytes !== undefined ?
        new Response(bytes) :
        new Response("", { status: 404 }),
    );
  };
  let blobs = 0;
  URL.createObjectURL = () => "blob:music/" + (++blobs);
  URL.revokeObjectURL = () => {};
  bgm_tracker.BGM_SetTrackerLoader(() => {
    loads.count++;
    return Promise.resolve(lib);
  });
  const oldDirs = pak.COM_GetLooseFileBasePaths();

  try {
    cd_audio.CDAudio_SetMusicExtensions(ALL);
    snd_dma.S_Init();
    cd_audio.CDAudio_Init();
    pak.COM_SetLooseFileBasePaths(["g/mod/", "g/id1/"]);
    cd_audio.CDAudio_SetTrackURLProvider((track) =>
      cd_audio.CDAudio_TrackURLs(track, ["g/mod", "g/id1"])
    );
    await fn({ ctx, lib, loads, fetched });
  } finally {
    cd_audio.CDAudio_Shutdown();
    snd_dma.S_Shutdown();
    sound.Sound_SetBlocked(0);
    cd_audio.CDAudio_SetTrackURLProvider(null);
    cd_audio.CDAudio_SetMusicExtensions(null);
    bgm_tracker.BGM_SetTrackerLoader(null);
    pak.COM_SetLooseFileBasePaths(oldDirs);
    globalThis.Audio = saved.Audio;
    if (saved.window === undefined) delete globalThis.window;
    else globalThis.window = saved.window;
    globalThis.fetch = saved.fetch;
    URL.createObjectURL = saved.createObjectURL;
    URL.revokeObjectURL = saved.revokeObjectURL;
  }
}

/** Fails the element's current candidate as a missing file */
function failElement(el) {
  el.error = { code: 4 };
  el.onerror();
}

Deno.test("a CD track falls through streamed formats to a tracker module", async () => {
  await withMusic({ "g/mod/music/track02.xm": makeMOD() }, async (t) => {
    cd_audio.CDAudio_Play(2, true);
    const el = FakeAudio.last;
    for (const ext of ["ogg", "opus", "mp3", "flac", "wav"]) {
      assertEqual(el.src, "g/mod/music/track02." + ext, ext + " tried");
      failElement(el);
    }
    assertEqual(t.loads.count, 0, "libopenmpt not loaded for a 404");
    await settle();
    await settle();
    assertEqual(
      t.fetched.join(" "),
      "g/mod/music/track02.it g/mod/music/track02.s3m g/mod/music/track02.xm",
      "tracker candidates fetched in order",
    );
    assertEqual(t.loads.count, 1, "libopenmpt loaded once found");
    assertEqual(t.lib.repeat, -1, "loops");
    assertEqual(t.ctx.sources.length > 0, true, "playing through Web Audio");
    const gain = t.ctx.gains[t.ctx.gains.length - 1];
    assertEqual(t.ctx.sources[0].output, gain, "through the music gain");

    // pause and resume reach the tracker; a resume doesn't replay the element
    const plays = el.plays.length;
    cd_audio.CDAudio_Pause();
    assertEqual(t.lib.seeks.length, 1, "paused");
    cd_audio.CDAudio_Resume();
    assertEqual(el.plays.length, plays, "element left alone");

    // music_loop reaches the playing module
    cmd.Cmd_ExecuteString("music_loop 0", 0);
    assertEqual(t.lib.repeat, 0, "music_loop 0");
    cmd.Cmd_ExecuteString("music_loop 1", 0);

    // a new track destroys the module
    cd_audio.CDAudio_Play(3, true);
    assertEqual(t.lib.destroyed, 1, "destroyed on the next track");
  });
});

Deno.test("music <name> plays a umx's module; music_stop stops it", async () => {
  const umx = makeUMX(makeMOD(), "MOD", 68).bytes;
  await withMusic({ "g/id1/music/tune.umx": umx }, async (t) => {
    cmd.Cmd_ExecuteString("music tune.umx", 0);
    await settle();
    await settle();
    assertEqual(
      t.fetched.join(" "),
      "g/mod/music/tune.umx g/id1/music/tune.umx",
      "game directory first",
    );
    assertEqual(t.lib.modules, 1, "the module inside opened");
    cmd.Cmd_ExecuteString("music_stop", 0);
    assertEqual(t.lib.destroyed, 1, "stopped");
  });
});

Deno.test("a WAV inside a umx plays in the element", async () => {
  const umx = makeUMX(makeWAV(), "WAV").bytes;
  await withMusic({ "g/mod/music/track04.umx": umx }, async (t) => {
    cd_audio.CDAudio_SetMusicExtensions(["umx"]);
    cd_audio.CDAudio_Play(4, true);
    await settle();
    await settle();
    const el = FakeAudio.last;
    assertEqual(el.src, "blob:music/1", "the WAV as a blob");
    assertEqual(el.plays.length, 1, "played");
    assertEqual(t.loads.count, 0, "no libopenmpt for a WAV");
  });
});

Deno.test("bgm_extmusic 0 plays no CD track; music_stop stops a paused one", async () => {
  await withMusic({}, () => {
    cd_audio.bgm_extmusic.value = 0;
    try {
      cd_audio.CDAudio_Play(2, true);
      assertEqual(
        FakeAudio.last === null || FakeAudio.last.src === "",
        true,
        "nothing loaded",
      );
    } finally {
      cd_audio.bgm_extmusic.value = 1;
    }

    cd_audio.CDAudio_Play(5, true);
    const el = FakeAudio.last;
    cd_audio.CDAudio_Pause();
    cmd.Cmd_ExecuteString("music_stop", 0);
    const plays = el.plays.length;
    cd_audio.CDAudio_Resume();
    assertEqual(el.plays.length, plays, "nothing to resume after music_stop");
  });
});

Deno.test("music with an unhandled extension stops the music and says so", async () => {
  await withMusic({}, () => {
    cd_audio.CDAudio_Play(2, true);
    const el = FakeAudio.last;
    cmd.Cmd_ExecuteString("music boss.mid", 0);
    const plays = el.plays.length;
    cd_audio.CDAudio_Resume();
    assertEqual(el.plays.length, plays, "stopped first, as BGM_Play");
  });
});

Deno.test("a tracker library that won't load moves on to the next candidate", async () => {
  await withMusic({ "g/mod/music/track02.mod": makeMOD() }, async (t) => {
    // as under a CSP without 'wasm-unsafe-eval', or offline
    let loads = 0;
    bgm_tracker.BGM_SetTrackerLoader(() => {
      loads++;
      return Promise.reject(new Error("blocked"));
    });
    cd_audio.CDAudio_Play(2, true);
    const el = FakeAudio.last;
    for (const ext of ["ogg", "opus", "mp3", "flac", "wav"]) {
      assertEqual(el.src, "g/mod/music/track02." + ext, ext + " tried");
      failElement(el);
    }
    for (let i = 0; i < 8; i++) await settle();
    assertEqual(loads, 1, "load tried once");
    assertEqual(
      t.fetched.slice(-2).join(" "),
      "g/mod/music/track02.mod g/mod/music/track02.umx",
      "the next candidate after the module",
    );
    assertEqual(el.src, "g/id1/music/track02.ogg", "then the next directory");
    assertEqual(t.ctx.sources.length, 0, "nothing scheduled");

    // a later streamed track still plays
    cd_audio.CDAudio_Play(3, true);
    assertEqual(
      FakeAudio.last.plays[FakeAudio.last.plays.length - 1],
      "g/mod/music/track03.ogg",
      "streamed track plays",
    );
  });
});
