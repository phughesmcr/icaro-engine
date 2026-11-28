// Tracker music (mod, s3m, xm, it, and the modules inside a umx) for the
// background music player in cd_audio.js. QuakeSpasm streams these through
// libxmp, mikmod or modplug (snd_xmp.c, snd_mikmod.c, snd_modplug.c) into its
// raw sample buffer; this port decodes them with libopenmpt and plays the
// rendered chunks through Web Audio.
//
// libopenmpt is an Emscripten build (the wasm inlined in one ES module) that
// is imported only when a tracker file is found, so the page load doesn't
// pay for it. The import map pins it with an integrity hash (index.html).
//
// Rendering runs on the main thread and is scheduled a few seconds ahead of
// the audio clock, so music keeps going while a map loads and the main
// thread is busy. BGM_TrackerPlayer.pump runs every host frame from
// CDAudio_Update and does nothing until the lookahead runs low.

/** Seconds rendered ahead of the audio clock */
const LOOKAHEAD = 4.0;
/** Frames per rendered chunk (about 0.17 s at 48 kHz) */
const CHUNK_FRAMES = 8192;
/** Seconds between asking for a start and the first chunk */
const START_DELAY = 0.05;
/** Chunks rendered per pump at most, so filling the lookahead is spread out */
const MAX_CHUNKS_PER_PUMP = 4;

// the module's own ID for the import map entry
const LIBOPENMPT_SPECIFIER = "libopenmpt";

let loadLibrary = defaultLoader;
let libraryPromise = null;

function defaultLoader() {
  return import(LIBOPENMPT_SPECIFIER).then((m) => m.default());
}

/**
 * Tests: sets the function that loads libopenmpt (returns a promise of the
 * Emscripten module), or null for the import map's.
 */
export function BGM_SetTrackerLoader(fn) {
  loadLibrary = fn !== null ? fn : defaultLoader;
  libraryPromise = null;
}

/**
 * Loads libopenmpt once. A failed load (offline, blocked) is forgotten, so a
 * later tracker track tries again.
 */
export function BGM_LoadTracker() {
  if (libraryPromise === null) {
    libraryPromise = loadLibrary().catch((e) => {
      libraryPromise = null;
      throw e;
    });
  }
  return libraryPromise;
}

/**
 * Writes a NUL-terminated ASCII string on the Emscripten stack; call between
 * stackSave and stackRestore.
 */
function stackString(lib, str) {
  const ptr = lib.stackAlloc(str.length + 1);
  for (let i = 0; i < str.length; i++) {
    lib.HEAPU8[ptr + i] = str.charCodeAt(i) & 0x7f;
  }
  lib.HEAPU8[ptr + str.length] = 0;
  return ptr;
}

/** libopenmpt's version string, e.g. "0.8.3+release" */
export function BGM_TrackerVersion(lib) {
  const sp = lib.stackSave();
  try {
    const ptr = lib._openmpt_get_string(stackString(lib, "library_version"));
    const version = lib.UTF8ToString(ptr);
    lib._openmpt_free_string(ptr);
    return version;
  } finally {
    lib.stackRestore(sp);
  }
}

/** One rendered chunk and the source playing it */
class Slot {
  constructor(buffer) {
    this.buffer = buffer;
    this.source = null;
    this.start = 0; // audio clock time the chunk starts
    this.duration = 0; // seconds
    this.modPos = 0; // module position (seconds) at the chunk's start
  }
}

/**
 * A playing tracker module. Create with BGM_TrackerPlayer.create; the
 * player starts paused, and resume() starts it.
 */
export class BGM_TrackerPlayer {
  constructor(lib, ctx, output, mod, loop, onEnded) {
    this.lib = lib;
    this.ctx = ctx;
    this.output = output;
    this.mod = mod;
    this.onEnded = onEnded;
    this.rate = ctx.sampleRate;
    this.paused = true;
    this.finished = false; // libopenmpt returned 0 frames: the song ended
    this.scheduledUntil = 0;

    this.leftPtr = lib._malloc(CHUNK_FRAMES * 4);
    this.rightPtr = lib._malloc(CHUNK_FRAMES * 4);
    this.heap = null;
    this.leftView = null;
    this.rightView = null;

    const count = Math.ceil(LOOKAHEAD * this.rate / CHUNK_FRAMES) +
      MAX_CHUNKS_PER_PUMP;
    this.slots = [];
    for (let i = 0; i < count; i++) {
      this.slots.push(new Slot(ctx.createBuffer(2, CHUNK_FRAMES, this.rate)));
    }

    this.setLoop(loop);
  }

  /**
   * Opens a module from its bytes; null if libopenmpt can't read it.
   * output is the node the music plays through.
   */
  static create(lib, ctx, output, bytes, loop, onEnded) {
    const ptr = lib._malloc(bytes.length);
    if (ptr === 0) return null;
    lib.HEAPU8.set(bytes, ptr);
    // libopenmpt copies the file; the default log and error handlers
    const mod = lib._openmpt_module_create_from_memory2(
      ptr,
      bytes.length,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
    );
    lib._free(ptr);
    if (mod === 0) return null;
    return new BGM_TrackerPlayer(lib, ctx, output, mod, loop, onEnded);
  }

  /** music_loop: -1 repeats forever (from the module's restart position) */
  setLoop(loop) {
    if (this.mod === 0) return;
    this.lib._openmpt_module_set_repeat_count(this.mod, loop ? -1 : 0);
  }

  /** Renders and schedules chunks until the lookahead is full. */
  pump() {
    if (this.paused || this.finished || this.mod === 0) return;

    const now = this.ctx.currentTime;
    if (this.scheduledUntil - now >= LOOKAHEAD) return;

    // an underrun (or the first chunk) starts again from now
    if (this.scheduledUntil < now + START_DELAY) {
      this.scheduledUntil = now + START_DELAY;
    }

    const lib = this.lib;
    for (let n = 0; n < MAX_CHUNKS_PER_PUMP; n++) {
      if (this.scheduledUntil - now >= LOOKAHEAD) break;

      const slot = this.freeSlot();
      if (slot === null) break;

      const modPos = lib._openmpt_module_get_position_seconds(this.mod);
      const frames = lib._openmpt_module_read_float_stereo(
        this.mod,
        this.rate,
        CHUNK_FRAMES,
        this.leftPtr,
        this.rightPtr,
      );

      if (frames <= 0) {
        this.finished = true;
        this.checkEnded();
        break;
      }

      // memory growth replaces the heap: views are made again only then
      if (lib.HEAPF32 !== this.heap) {
        this.heap = lib.HEAPF32;
        this.leftView = this.heap.subarray(
          this.leftPtr >> 2,
          (this.leftPtr >> 2) + CHUNK_FRAMES,
        );
        this.rightView = this.heap.subarray(
          this.rightPtr >> 2,
          (this.rightPtr >> 2) + CHUNK_FRAMES,
        );
      }
      slot.buffer.copyToChannel(this.leftView, 0);
      slot.buffer.copyToChannel(this.rightView, 1);

      const source = this.ctx.createBufferSource();
      source.buffer = slot.buffer;
      source.connect(this.output);
      source.onended = () => this.sourceEnded(slot, source);
      slot.source = source;
      slot.start = this.scheduledUntil;
      slot.duration = frames / this.rate;
      slot.modPos = modPos;
      source.start(slot.start, 0, slot.duration);
      this.scheduledUntil += slot.duration;
    }
  }

  freeSlot() {
    for (let i = 0; i < this.slots.length; i++) {
      if (this.slots[i].source === null) return this.slots[i];
    }
    return null;
  }

  sourceEnded(slot, source) {
    if (slot.source !== source) return; // stopped and reused
    slot.source = null;
    source.disconnect();
    if (this.finished) this.checkEnded();
  }

  /** The song ended (no repeat) and its last chunk has played */
  checkEnded() {
    for (let i = 0; i < this.slots.length; i++) {
      if (this.slots[i].source !== null) return;
    }
    if (this.onEnded !== null) {
      const onEnded = this.onEnded;
      this.onEnded = null;
      onEnded();
    }
  }

  stopSources() {
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i];
      const source = slot.source;
      if (source === null) continue;
      slot.source = null;
      try {
        source.stop();
        source.disconnect();
      } catch { /* ignore */ }
    }
  }

  /**
   * The module position being heard now: the chunk the audio clock is in,
   * or the first one not yet started.
   */
  heardPosition() {
    const now = this.ctx.currentTime;
    let first = null;
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i];
      if (slot.source === null) continue;
      if (now >= slot.start && now < slot.start + slot.duration) {
        return slot.modPos + (now - slot.start);
      }
      if (now < slot.start && (first === null || slot.start < first.start)) {
        first = slot;
      }
    }
    return first !== null ? first.modPos : -1;
  }

  /**
   * Stops what is scheduled and winds the module back to what was heard, so
   * resume() carries on from there.
   */
  pause() {
    if (this.paused || this.mod === 0) return;
    this.paused = true;
    const pos = this.heardPosition();
    this.stopSources();
    if (pos >= 0) {
      this.lib._openmpt_module_set_position_seconds(this.mod, pos);
      this.finished = false;
    }
  }

  resume() {
    if (!this.paused || this.mod === 0) return;
    this.paused = false;
    this.scheduledUntil = 0;
    this.pump();
  }

  /** music_jump: carries on from the start of order */
  jump(order) {
    if (this.mod === 0) return;
    this.stopSources();
    this.lib._openmpt_module_set_position_order_row(this.mod, order, 0);
    this.finished = false;
    this.scheduledUntil = 0;
    this.pump();
  }

  destroy() {
    if (this.mod === 0) return;
    this.onEnded = null;
    this.stopSources();
    this.lib._openmpt_module_destroy(this.mod);
    this.lib._free(this.leftPtr);
    this.lib._free(this.rightPtr);
    this.mod = 0;
  }
}
