// Tests for the sound fixes taken from the Ironwail review: CD music lookup
// and autoplay retry, ambient silencing, cache rate (pitch) and channel limits.

const cmd = await import("../src/cmd.js");
const cvar = await import("../src/cvar.js");
const sound = await import("../src/sound.js");
const snd_dma = await import("../src/snd_dma.js");
const snd_mem = await import("../src/snd_mem.js");
const cd_audio = await import("../src/cd_audio.js");
const pak = await import("../src/pak.js");
const { cl } = await import("../src/client.js");

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

cmd.Cbuf_Init();
cmd.Cmd_Init();

// FAKE WEB AUDIO

const created = { buffers: [], sources: [] };

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
    const buffer = {
      numberOfChannels: channels,
      length,
      sampleRate: rate,
      getChannelData: () => data,
    };
    created.buffers.push(buffer);
    return buffer;
  }

  createBufferSource() {
    const source = {
      buffer: null,
      loop: false,
      loopStart: 0,
      loopEnd: 0,
      stopped: false,
      connect() {},
      start() {},
      stop() {
        this.stopped = true;
      },
    };
    created.sources.push(source);
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

// 8-bit mono PCM WAV; loopstart >= 0 adds the cue chunk GetWavinfo reads
function makeWav(rate, samples, loopstart) {
  const cue = loopstart >= 0 ? 8 + 28 : 0;
  const bytes = new Uint8Array(12 + 8 + 16 + cue + 8 + samples + (samples & 1));
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
  view.setUint32(p + 12, rate, true);
  view.setUint32(p + 16, rate, true);
  view.setUint16(p + 20, 1, true);
  view.setUint16(p + 22, 8, true);
  p += 24;
  if (cue) {
    tag(p, "cue ");
    view.setUint32(p + 4, 28, true);
    view.setUint32(p + 8, 1, true);
    view.setUint32(p + 32, loopstart, true); // sampleOffset, read at chunk + 32
    p += cue;
  }

  tag(p, "data");
  view.setUint32(p + 4, samples, true);
  for (let i = 0; i < samples; i++) {
    bytes[p + 8 + i] = i & 0xff;
  }

  return bytes;
}

// A pak in memory holding the given files
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

  pak.COM_AddPack({ filename: "test.pak", files: entries, data: data.buffer });
}

addFakePack([
  { name: "sound/test/tone11.wav", data: makeWav(11025, 1000, -1) },
  { name: "sound/test/tone22.wav", data: makeWav(22050, 1000, -1) },
  { name: "sound/ambience/water1.wav", data: makeWav(11025, 400, 0) },
  { name: "sound/ambience/wind2.wav", data: makeWav(11025, 400, 0) },
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

// PITCH AND LIMITS

Deno.test("sounds are cached at 11025 Hz whatever the device rate, so pitch is exact", () => {
  withSound(() => {
    assertEqual(
      sound.shm.speed,
      11025,
      "shm->speed is WinQuake's 11025, not the 48000 device rate",
    );

    // 11 kHz source: kept sample for sample
    const sfx11 = snd_dma.S_PrecacheSound("test/tone11.wav");
    const sc11 = snd_mem.S_LoadSound(sfx11);
    assertEqual(sc11.length, 1000, "11 kHz length");
    assertEqual(sc11.speed, 11025, "11 kHz rate");
    for (let i = 0; i < 1000; i++) {
      if (sc11.data[i] !== (i & 0xff)) {
        throw new Error(`11 kHz sample ${i} changed: ${sc11.data[i]}`);
      }
    }

    // 22 kHz source: C decimates by exactly 2
    const sc22 = snd_mem.S_LoadSound(
      snd_dma.S_PrecacheSound("test/tone22.wav"),
    );
    assertEqual(sc22.length, 500, "22 kHz decimated length");
    assertEqual(sc22.data[1], 2, "22 kHz takes every other sample");

    // the AudioBuffer is built at the cache rate; Web Audio resamples it,
    // so 1000 samples last 1000 / 11025 s on a 48 kHz device
    created.buffers.length = 0;
    snd_dma.S_StartSound(cl.viewentity, 1, sfx11, new Float32Array(3), 1, 1);
    assertEqual(created.buffers.length, 1, "buffer created");
    assertEqual(created.buffers[0].sampleRate, 11025, "buffer rate");
    assertEqual(created.buffers[0].length, 1000, "buffer length");
  });
});

Deno.test("channel limits: 8 dynamic channels as in WinQuake, 1024 in all as in QuakeSpasm", () => {
  assertEqual(sound.MAX_DYNAMIC_CHANNELS, 8, "MAX_DYNAMIC_CHANNELS");
  assertEqual(sound.MAX_CHANNELS, 1024, "MAX_CHANNELS");

  withSound(() => {
    assertEqual(
      sound.total_channels,
      sound.NUM_AMBIENTS + 8,
      "statics start after 8 dynamic channels",
    );

    // more static sounds than WinQuake's 116 slots all get a channel
    const sfx = snd_dma.S_PrecacheSound("ambience/water1.wav");
    const origin = new Float32Array(3);
    for (let i = 0; i < 200; i++) {
      snd_dma.S_StaticSound(sfx, origin, 255, 1);
    }
    assertEqual(
      sound.total_channels,
      sound.NUM_AMBIENTS + 8 + 200,
      "statics kept",
    );

    // a ninth entity's sound steals a channel
    const tone = snd_dma.S_PrecacheSound("test/tone11.wav");
    for (let e = 1; e <= 9; e++) {
      snd_dma.S_StartSound(100 + e, 1, tone, origin, 1, 0);
    }
    let busy = 0;
    for (let i = sound.NUM_AMBIENTS; i < sound.NUM_AMBIENTS + 8; i++) {
      if (sound.channels[i].sfx !== null) busy++;
    }
    assertEqual(busy, 8, "eight dynamic channels in use");
  });
});

// AMBIENTS

Deno.test("ambient_level 0 stops the ambient loops, and they come back at their old level", () => {
  const oldWorld = cl.worldmodel;
  const oldLevel = cvar.Cvar_VariableString("ambient_level");
  const leaf = {
    contents: -1,
    ambient_sound_level: new Uint8Array([255, 0, 0, 0]),
  };
  cl.worldmodel = { nodes: [leaf] };
  snd_dma.S_SetCallbacks({ getHostFrametime: () => 1 });
  const v = new Float32Array(3);

  try {
    withSound(() => {
      // S_Init precached ambience/water1.wav and wind2.wav
      const water = sound.channels[sound.AMBIENT_WATER];

      snd_dma.S_Update(v, v, v, v);
      const first = water._audioSource;
      if (first === null || first === undefined) {
        throw new Error("water ambient did not start");
      }
      assertEqual(
        first.loopEnd,
        400 / 11025,
        "loop end in seconds at the cache rate",
      );
      const level = water.master_vol;
      assertEqual(Math.round(level), 77, "faded up to ambient_level * 255");

      cvar.Cvar_Set("ambient_level", "0");
      snd_dma.S_Update(v, v, v, v);
      assertEqual(first.stopped, true, "looping source stopped");
      assertEqual(water._audioSource, null, "channel has no source");
      assertEqual(water.sfx, null, "sfx cleared as in C");
      assertEqual(water.master_vol, level, "master_vol kept as in C");

      cvar.Cvar_Set("ambient_level", "0.3");
      snd_dma.S_Update(v, v, v, v);
      const again = water._audioSource;
      if (again === null || again === undefined || again === first) {
        throw new Error("water ambient did not restart");
      }
      assertEqual(
        water._leftGain.gain.value,
        snd_dma.SND_ChannelGain(level),
        "restarts at its old level",
      );
    });
  } finally {
    cvar.Cvar_Set("ambient_level", oldLevel);
    cl.worldmodel = oldWorld;
    snd_dma.S_SetCallbacks({ getHostFrametime: () => 0 });
  }
});

// CD MUSIC

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
    this.pauses = 0;
    // what the next play() does: 'ok', 'blocked' or 'missing'
    this.next = "ok";
    FakeAudio.last = this;
  }

  play() {
    this.plays.push(this.src);
    const outcome = this.next;
    if (outcome === "blocked") {
      const e = new Error("autoplay");
      e.name = "NotAllowedError";
      return Promise.reject(e);
    }

    if (outcome === "missing") {
      const e = new Error("no source");
      e.name = "NotSupportedError";
      return Promise.reject(e);
    }

    return Promise.resolve();
  }

  pause() {
    this.pauses++;
  }
}

// let promise callbacks run
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

Deno.test("CDAudio_TrackURLs searches the mission pack before id1, ogg before mp3", () => {
  const urls = cd_audio.CDAudio_TrackURLs(2, ["static/rogue", "static"]);
  assertEqual(
    urls.join(" "),
    "static/rogue/music/track02.ogg static/rogue/music/track02.mp3 static/music/track02.ogg static/music/track02.mp3",
    "candidates",
  );
});

Deno.test("CD tracks fall through missing files and retry autoplay on a user gesture", async () => {
  const hadAudio = "Audio" in globalThis;
  const oldAudio = globalThis.Audio;
  globalThis.Audio = FakeAudio;

  try {
    cd_audio.CDAudio_Init();
    cd_audio.CDAudio_SetTrackURLProvider((track) =>
      cd_audio.CDAudio_TrackURLs(track, ["static/rogue", "static"])
    );

    // the rogue ogg is missing: the mp3 next to it plays
    cd_audio.CDAudio_Play(2, true);
    const el = FakeAudio.last;
    assertEqual(el.src, "static/rogue/music/track02.ogg", "first candidate");
    el.onerror();
    assertEqual(el.src, "static/rogue/music/track02.mp3", "second candidate");
    assertEqual(el.plays.length, 2, "play per candidate");
    await settle();

    // a missing URL isn't fetched again
    cd_audio.CDAudio_Stop();
    cd_audio.CDAudio_Play(2, true);
    assertEqual(
      el.src,
      "static/rogue/music/track02.mp3",
      "known-missing ogg skipped",
    );

    // autoplay refused: the next gesture (S_UnlockAudio) plays it, once
    el.next = "blocked";
    cd_audio.CDAudio_Play(3, true);
    await settle();
    el.next = "ok";
    const before = el.plays.length;
    snd_dma.S_UnlockAudio();
    assertEqual(el.plays.length, before + 1, "retried on the gesture");
    await settle();
    snd_dma.S_UnlockAudio();
    assertEqual(el.plays.length, before + 1, "no retry once playing");

    // a load error from an earlier track does nothing
    cd_audio.CDAudio_Play(4, true);
    const stale = el.onerror;
    cd_audio.CDAudio_Play(5, true);
    stale();
    assertEqual(
      el.src,
      "static/rogue/music/track05.ogg",
      "stale error ignored",
    );

    // every candidate missing: the track stops counting as playing
    el.next = "missing";
    for (let i = 0; i < 4; i++) {
      el.onerror();
    }
    await settle();
    const pauses = el.pauses;
    cd_audio.CDAudio_Pause();
    assertEqual(
      el.pauses,
      pauses,
      "not playing after the last candidate failed",
    );

    // paused while the candidates fail: Resume has nothing to restart, and
    // the same track can be asked for again
    el.next = "ok";
    cd_audio.CDAudio_Play(8, true);
    cd_audio.CDAudio_Pause();
    const plays = el.plays.length;
    for (let i = 0; i < 4; i++) {
      el.onerror();
    }
    assertEqual(el.plays.length, plays, "no play() while paused");
    cd_audio.CDAudio_Resume();
    assertEqual(
      el.plays.length,
      plays,
      "Resume after every candidate failed does nothing",
    );
    cd_audio.CDAudio_Pause();
    assertEqual(el.pauses, pauses + 1, "still not playing");

    // Stop drops a pending gesture retry
    el.next = "blocked";
    cd_audio.CDAudio_Play(9, true);
    await settle();
    cd_audio.CDAudio_Stop();
    el.next = "ok";
    const stopped = el.plays.length;
    snd_dma.S_UnlockAudio();
    assertEqual(el.plays.length, stopped, "no retry after Stop");

    // a network error isn't remembered as a missing file
    cd_audio.CDAudio_Play(10, true);
    el.error = { code: 2 };
    el.onerror();
    el.error = null;
    cd_audio.CDAudio_Stop();
    cd_audio.CDAudio_Play(10, true);
    assertEqual(
      el.src,
      "static/rogue/music/track10.ogg",
      "retried after a network error",
    );
  } finally {
    cd_audio.CDAudio_Shutdown();
    if (hadAudio) globalThis.Audio = oldAudio;
    else delete globalThis.Audio;
  }
});
