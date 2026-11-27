// Ported from: WinQuake/cd_audio.c -- CD audio playback
// In browser port: uses Web Audio API (HTML5 Audio element) for music tracks
// Also: QuakeSpasm/Ironwail bgmusic.c -- external music (music/trackNN.<ext>
// for CD tracks, the music command and its music_* companions, and the
// bgm_extmusic cvar). The browser decodes ogg, opus, mp3, flac and wav;
// tracker modules (it, s3m, xm, mod, and umx containers) go through
// libopenmpt (bgm_tracker.js, snd_umx.js).

import { Con_DPrintf, Con_Printf } from "./console.js";
import { Cmd_AddCommand, Cmd_Argc, Cmd_Argv, Cmd_Exists } from "./cmd.js";
import { Cvar_FindVar, Cvar_RegisterVariable, Cvar_SetValue } from "./cvar.js";
import { COM_CheckParm } from "./common.js";
import { COM_GetLooseFileBasePaths } from "./pak.js";
import { bgmvolume } from "./sound.js";
import {
  S_GetAudioContext,
  S_GetMasterGain,
  S_SetCallbacks,
} from "./snd_dma.js";
import { BGM_LoadTracker, BGM_TrackerPlayer } from "./bgm_tracker.js";
import { UMX_FindMusic } from "./snd_umx.js";

// CD AUDIO STATE

const MAXIMUM_TRACKS = 100;

let playing = false;
let wasPlaying = false;
let initialized = false;
let enabled = true;
let playLooping = false;
let playTrack = 0;
let cdvolume = 0;

const remap = new Uint8Array(256);

/** bgmusic.c: whether CD tracks play from music files */
export const bgm_extmusic = {
  name: "bgm_extmusic",
  string: "1",
  value: 1,
  archive: true,
};

// bgmusic.c bgmloop: music_loop sets it; CD tracks and the music command
// loop only while it is set
let bgmloop = true;

// The music command's file name while it plays; "" for a CD track
let playName = "";

// Web Audio / HTML5 Audio for music
let musicElement = null; // HTMLAudioElement for music playback
let musicGainNode = null; // bgmvolume for the element (when routed) and trackers
let musicSource = null; // MediaElementAudioSourceNode
// The element holds this attempt's file (not a tracker), so resuming,
// unblocking or a gesture retry may play() it
let elementActive = false;
// A tracker module playing through libopenmpt, or null
let trackerPlayer = null;
// blob: URL of a WAV or MP2 taken out of a umx, revoked when the next
// attempt starts
let umxBlobURL = null;

// The unrouted element was paused because sound was blocked (tab hidden)
let hiddenPaused = false;
// Sound is blocked (tab hidden)
let soundBlocked = false;

// Track URL provider (set externally)
let _getTrackURL = null;

// Bumped by CDAudio_Play and CDAudio_Stop, so a load error or gesture retry
// left over from an earlier track does nothing.
let playAttempt = 0;
// play() was refused by the browser's autoplay policy: retry it on the next
// user gesture (S_UnlockAudio)
let gestureRetry = false;
// URLs that failed to load (missing file or a codec the browser can't play),
// so a track isn't fetched again on every level change. Network errors aren't
// recorded, so a track that exists is retried next time.
const missingURLs = new Set();

const MUSIC_DIRNAME = "music";

/**
 * QuakeSpasm/Ironwail bgmusic.c wanted_handlers, in their order. mime is what
 * canPlayType is asked; null marks a tracker format, played by libopenmpt
 * through Web Audio.
 */
export const MUSIC_HANDLERS = [
  { ext: "ogg", mime: 'audio/ogg; codecs="vorbis"' },
  { ext: "opus", mime: 'audio/ogg; codecs="opus"' },
  { ext: "mp3", mime: "audio/mpeg" },
  { ext: "flac", mime: "audio/flac" },
  { ext: "wav", mime: "audio/wav" },
  { ext: "it", mime: null },
  { ext: "s3m", mime: null },
  { ext: "xm", mime: null },
  { ext: "mod", mime: null },
  { ext: "umx", mime: null },
];

const TRACKER_EXTENSIONS = new Set(["it", "s3m", "xm", "mod", "umx"]);

/**
 * The handlers this browser can play, as BGM_Init keeps the available
 * ones: a format canPlayType answers "" for is left out (Safari and Ogg
 * Opus, for one), so the next extension is looked for instead. With no
 * canPlayType to ask, every streamed format is tried. Tracker formats need
 * Web Audio.
 */
export function CDAudio_DetectMusicExtensions(canPlayType, hasWebAudio) {
  const exts = [];
  for (const handler of MUSIC_HANDLERS) {
    const available = handler.mime === null ?
      hasWebAudio :
      canPlayType === null || canPlayType(handler.mime) !== "";
    if (available) {
      exts.push(handler.ext);
    }
  }
  return exts;
}

// The available extensions, worked out on first use (no DOM at import)
let musicExtensions = null;

/**
 * Sets the extensions searched, in order (tests), or null to ask the
 * browser again.
 */
export function CDAudio_SetMusicExtensions(exts) {
  musicExtensions = exts;
}

/** The music extensions this browser plays, in bgmusic.c order */
export function CDAudio_MusicExtensions() {
  if (musicExtensions !== null) {
    return musicExtensions;
  }

  let canPlayType = null;
  if (typeof globalThis.Audio === "function") {
    try {
      const probe = new Audio();
      if (typeof probe.canPlayType === "function") {
        canPlayType = (mime) => probe.canPlayType(mime);
      }
    } catch { /* no element: try every format */ }
  }

  const win = globalThis.window;
  const hasWebAudio = typeof WebAssembly === "object" &&
    win !== undefined && win !== null &&
    (typeof win.AudioContext === "function" ||
      typeof win.webkitAudioContext === "function");

  musicExtensions = CDAudio_DetectMusicExtensions(canPlayType, hasWebAudio);
  return musicExtensions;
}

/**
 * COM_FileGetExtension, lower-cased: the text after the last dot of the
 * last path component, or "".
 */
export function CDAudio_FileExtension(path) {
  const dot = path.lastIndexOf(".");
  if (
    dot < 0 || dot < path.lastIndexOf("/") || dot < path.lastIndexOf("\\")
  ) {
    return ""; // no extension, or a parent directory has a dot
  }
  return path.slice(dot + 1).toLowerCase();
}

// EXTERNAL INTERFACE

/**
 * Set a function that maps a track number to the URL of its music file, or to
 * an ordered list of candidate URLs: CDAudio_Play tries each in turn until one
 * loads (see CDAudio_TrackURLs).
 */
export function CDAudio_SetTrackURLProvider(fn) {
  _getTrackURL = fn;
}

// Tracks kept in the browser's storage (src/userdata.js UD_MountPaks): the
// lower-case URL CDAudio_TrackURLs would give, to a blob: URL of the file
let storedTracks = new Map();
// Each stored track's blob: URL to its file's extension, which the blob:
// URL doesn't carry
let storedExtensions = new Map();

/** Web-only: sets the stored tracks, which play in place of their URLs. */
export function CDAudio_SetStoredTracks(tracks) {
  storedTracks = tracks;
  storedExtensions = new Map();
  for (const [url, blobURL] of tracks) {
    storedExtensions.set(blobURL, CDAudio_FileExtension(url));
  }
}

/** The format of a candidate URL: its extension, or a stored file's */
function CDAudio_URLExtension(url) {
  return storedExtensions.get(url) ?? CDAudio_FileExtension(url);
}

function CDAudio_StoredOr(url) {
  return storedTracks.get(url.toLowerCase()) ?? url;
}

/**
 * Candidate URLs for a track's CD rip, as QuakeSpasm/Ironwail's BGM_PlayCDtrack
 * looks for music/trackNN.<ext>: game directories in search-path priority
 * (the mission pack's before id1's), and within a directory the extensions
 * in bgmusic.c order (ogg, opus, mp3, flac, wav, it, s3m, xm, mod, umx),
 * leaving out what this browser can't play. gamedirs lists the directories
 * highest priority first.
 */
export function CDAudio_TrackURLs(track, gamedirs) {
  const name = "track" + String(track).padStart(2, "0");
  const urls = [];

  for (const dir of gamedirs) {
    for (const ext of CDAudio_MusicExtensions()) {
      urls.push(
        CDAudio_StoredOr(dir + "/" + MUSIC_DIRNAME + "/" + name + "." + ext),
      );
    }
  }

  return urls;
}

/**
 * Candidate URLs for the music command, as bgmusic.c BGM_Play opens
 * music/<filename>: with an extension, that file from each game directory;
 * without one, BGM_Play_noext tries each extension in handler order, each in
 * every game directory. null for an extension no available handler plays.
 */
export function CDAudio_MusicURLs(filename, gamedirs) {
  const exts = CDAudio_MusicExtensions();
  const ext = CDAudio_FileExtension(filename);
  const urls = [];

  if (ext === "") {
    for (const e of exts) {
      for (const dir of gamedirs) {
        urls.push(
          CDAudio_StoredOr(
            dir + "/" + MUSIC_DIRNAME + "/" + filename + "." + e,
          ),
        );
      }
    }
    return urls;
  }

  if (!exts.includes(ext)) {
    return null;
  }

  for (const dir of gamedirs) {
    urls.push(CDAudio_StoredOr(dir + "/" + MUSIC_DIRNAME + "/" + filename));
  }
  return urls;
}

/** The game directories, highest priority first, from the loose-file paths */
function CDAudio_GameDirs() {
  return COM_GetLooseFileBasePaths().map((path) =>
    path.endsWith("/") ? path.slice(0, -1) : path
  );
}

/**
/**
 * Exactly one control sets the element's level. Routed through the gain
 * node, that node does and the element stays at 1.0, so the two aren't
 * multiplied and the element doesn't hold the volume from when it started.
 * Unrouted (no AudioContext, or createMediaElementSource threw), the element
 * volume does. Tracker music always plays through the gain node.
 */
function CDAudio_ApplyVolume() {
  if (musicGainNode !== null) {
    musicGainNode.gain.value = bgmvolume.value;
  }

  if (musicElement !== null) {
    musicElement.volume = musicSource !== null ? 1.0 : bgmvolume.value;
  }
}

// CDAudio_BlockSound / CDAudio_UnblockSound
//
// Web only; cd_win.c has no focus handling for CD. Hidden tabs suspend the
// AudioContext (S_BlockSound), which silences a routed element and tracker
// music. An element that isn't routed would keep playing aloud, so it pauses
// and resumes with the same block and unblock.
function CDAudio_BlockSound() {
  soundBlocked = true;

  if (
    !initialized || !playing || musicElement === null ||
    musicSource !== null || !elementActive
  ) {
    return;
  }

  try {
    musicElement.pause();
    hiddenPaused = true;
  } catch { /* ignore */ }
}

function CDAudio_UnblockSound() {
  soundBlocked = false;

  if (!hiddenPaused) {
    return;
  }

  hiddenPaused = false;

  if (!initialized || !playing || musicElement === null || !elementActive) {
    return;
  }

  try {
    CDAudio_StartElement(playAttempt);
  } catch { /* ignore */ }
}

/**
 * Calls play() on the music element. A refusal by the autoplay policy
 * (NotAllowedError) arms a retry on the next user gesture. Other rejections
 * (AbortError when src changes, NotSupportedError for a missing file) are left
 * to the element's error event.
 */
function CDAudio_StartElement(attempt) {
  // An unrouted element would play aloud in a hidden tab: wait for unblock
  if (soundBlocked === true && musicSource === null) {
    hiddenPaused = true;
    return;
  }

  const promise = musicElement.play();

  // HTMLMediaElement.play() returns undefined in old browsers
  if (promise === undefined) {
    return;
  }

  promise.then(function () {
    if (attempt === playAttempt) {
      gestureRetry = false;
    }
  }, function (e) {
    if (attempt !== playAttempt) {
      return;
    }

    // a DOMException from the browser
    const err = (e !== null && typeof e === "object") ?
      e :
      { name: "", message: "" };
    if (err.name === "NotAllowedError") {
      gestureRetry = true;
      Con_DPrintf("CDAudio: music waits for a click or key press\n");
    } else {
      Con_DPrintf("CDAudio_Play: playback failed: %s\n", err.message);
    }
  });
}

/** Starts or resumes whichever player holds this attempt's music. */
function CDAudio_StartPlayer() {
  if (trackerPlayer !== null) {
    trackerPlayer.resume();
  } else if (elementActive) {
    CDAudio_StartElement(playAttempt);
  }
}

/** Revokes the blob: URL of a WAV or MP2 taken out of a umx */
function CDAudio_ReleaseUMXBlob() {
  if (umxBlobURL !== null) {
    URL.revokeObjectURL(umxBlobURL);
    umxBlobURL = null;
  }
}

/** Stops both players; the element can be given a new file after this. */
function CDAudio_HaltPlayers() {
  if (musicElement) {
    try {
      musicElement.pause();
      musicElement.currentTime = 0;
    } catch { /* ignore */ }
  }

  if (trackerPlayer !== null) {
    trackerPlayer.destroy();
    trackerPlayer = null;
  }

  elementActive = false;
}

/**
 * Loads the first candidate URL not already known to be missing, and falls
 * through to the next one when it fails to load: the element's error event
 * for streamed formats, a failed fetch or a module libopenmpt can't open for
 * tracker formats.
 */
function CDAudio_PlayURL(urls, index, attempt) {
  while (index < urls.length && missingURLs.has(urls[index])) {
    index++;
  }

  if (index >= urls.length) {
    if (playName !== "") {
      Con_Printf("Couldn't handle music file %s\n", playName);
    } else {
      // Ironwail prints this with Con_Printf. Most players of the web build
      // have no music files, so keep it to developer mode, as WinQuake is
      // quiet about a missing CD.
      Con_DPrintf("Couldn't find a cdrip for track %d\n", playTrack);
    }
    playing = false;
    wasPlaying = false; // nothing for CDAudio_Resume to restart
    gestureRetry = false;
    return;
  }

  const url = urls[index];

  if (TRACKER_EXTENSIONS.has(CDAudio_URLExtension(url))) {
    elementActive = false;
    CDAudio_PlayTracker(urls, index, attempt);
    return;
  }

  CDAudio_PlayElement(urls, index, attempt, url);
}

/** Plays src (urls[index], or a blob: URL of what is in it) in the element */
function CDAudio_PlayElement(urls, index, attempt, src) {
  const url = urls[index];

  musicElement.onerror = function () {
    if (attempt !== playAttempt) {
      return;
    }

    // MEDIA_ERR_NETWORK may be transient; anything else is the file
    const error = musicElement.error;
    if (error === null || error === undefined || error.code !== 2) {
      missingURLs.add(url);
    }
    elementActive = false;
    CDAudio_PlayURL(urls, index + 1, attempt);
  };

  musicElement.src = src;
  elementActive = true;

  // paused while an earlier candidate was failing: CDAudio_Resume plays it
  if (playing) {
    CDAudio_StartElement(attempt);
  }
}

/**
 * A tracker module, or a umx (snd_umx.c S_UMX_CodecOpenStream: the module
 * inside goes to the tracker decoder, a WAV or MP2 inside to the browser's
 * decoder, as the reference forwards those to its WAV and MP3 codecs).
 * libopenmpt loads only once a tracker file is found.
 */
async function CDAudio_PlayTracker(urls, index, attempt) {
  const url = urls[index];
  const next = function (missing) {
    if (missing) {
      missingURLs.add(url);
    }
    CDAudio_PlayURL(urls, index + 1, attempt);
  };

  let bytes;
  try {
    const response = await fetch(url);
    if (attempt !== playAttempt) {
      return;
    }
    if (!response.ok) {
      // a server error may be transient; anything else is the file
      next(response.status < 500);
      return;
    }
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch (e) {
    if (attempt !== playAttempt) {
      return;
    }
    Con_DPrintf("CDAudio: %s failed: %s\n", url, String(e));
    next(false); // a network error may be transient
    return;
  }

  if (attempt !== playAttempt) {
    return;
  }

  if (CDAudio_URLExtension(url) === "umx") {
    const music = UMX_FindMusic(bytes);
    if (music === null) {
      Con_DPrintf("%s: unrecognized umx\n", url);
      next(true);
      return;
    }

    Con_DPrintf(
      "%s: %s data @ 0x%s, %d bytes\n",
      url,
      music.type.toUpperCase(),
      music.offset.toString(16),
      music.size,
    );
    bytes = bytes.subarray(music.offset, music.offset + music.size);

    if (music.type === "wav" || music.type === "mp2") {
      CDAudio_ReleaseUMXBlob();
      umxBlobURL = URL.createObjectURL(
        new Blob([bytes], {
          type: music.type === "wav" ? "audio/wav" : "audio/mpeg",
        }),
      );
      CDAudio_PlayElement(urls, index, attempt, umxBlobURL);
      return;
    }
  }

  const ctx = S_GetAudioContext();
  if (ctx === null || musicGainNode === null) {
    Con_DPrintf("CDAudio: tracker music needs Web Audio\n");
    next(false);
    return;
  }

  let lib;
  try {
    lib = await BGM_LoadTracker();
  } catch (e) {
    if (attempt !== playAttempt) {
      return;
    }
    Con_Printf("Couldn't load the tracker music decoder: %s\n", String(e));
    next(false);
    return;
  }

  if (attempt !== playAttempt) {
    return;
  }

  const player = BGM_TrackerPlayer.create(
    lib,
    ctx,
    musicGainNode,
    bytes,
    playLooping,
    function () {
      // the song ended without repeating, as the element's ended event
      if (attempt === playAttempt && !playLooping) {
        playing = false;
      }
    },
  );

  if (player === null) {
    Con_DPrintf("%s: libopenmpt couldn't open it\n", url);
    next(true);
    return;
  }

  trackerPlayer = player;

  // paused while it loaded: CDAudio_Resume plays it
  if (playing) {
    player.resume();
  }
}

/**
 * Registered as the S_UnlockAudio callback, so it runs inside the user's
 * gesture handler, where the browser allows play().
 */
function CDAudio_GestureRetry() {
  if (!gestureRetry || !playing || musicElement === null || !elementActive) {
    return;
  }

  CDAudio_StartElement(playAttempt);
}

/**
 * Starts a new attempt at urls: routes the element and the music gain node,
 * sets the volume, and loads the first candidate that plays.
 */
function CDAudio_StartAttempt(urls, looping) {
  playLooping = looping;

  let vol = Math.floor(bgmvolume.value * 255.0);
  if (vol < 0) {
    Cvar_SetValue("bgmvolume", 0.0);
    vol = 0;
  } else if (vol > 255) {
    Cvar_SetValue("bgmvolume", 1.0);
    vol = 255;
  }

  cdvolume = vol;

  try {
    // Create or reuse HTMLAudioElement
    if (!musicElement) {
      musicElement = new Audio();
    }

    musicElement.loop = looping;

    // Route through Web Audio for unified volume control: a gain node for
    // the element and tracker music
    const audioContext = S_GetAudioContext();
    const masterGain = S_GetMasterGain();

    if (audioContext && masterGain && musicGainNode === null) {
      try {
        const gain = audioContext.createGain();
        gain.connect(audioContext.destination);
        musicGainNode = gain;
      } catch {
        Con_DPrintf("CDAudio: no gain node for music\n");
      }
    }

    if (musicGainNode !== null && !musicSource) {
      try {
        // once createMediaElementSource succeeds the element's output only
        // reaches the speakers through the graph
        const source = audioContext.createMediaElementSource(musicElement);
        source.connect(musicGainNode);
        musicSource = source;
      } catch {
        // Fallback: direct playback without Web Audio routing
        Con_DPrintf(
          "CDAudio: Web Audio routing failed, using direct playback\n",
        );
      }
    }

    CDAudio_ApplyVolume();

    // Handle looping via ended event for non-loop mode
    musicElement.onended = function () {
      if (!playLooping) {
        playing = false;
      }
    };

    playing = true;
    gestureRetry = false;
    playAttempt++;
    CDAudio_ReleaseUMXBlob();
    CDAudio_PlayURL(urls, 0, playAttempt);
  } catch (e) {
    Con_DPrintf("CDAudio_Play: start failed: %s\n", e.message);
    playing = false;
  }
}

/**
 * As in cd_win.c, a bad or missing track is rejected before the current track
 * is stopped, so a map without a CD track (svc_cdtrack 0) keeps the music.
 * The track plays from a music file (bgmusic.c BGM_PlayCDtrack) unless
 * bgm_extmusic is 0, and loops only while music_loop allows.
 */
export function CDAudio_Play(track, looping) {
  if (!initialized || !enabled) {
    return;
  }

  // C takes the track as a byte
  track = remap[track & 0xff];

  if (track < 1 || track >= MAXIMUM_TRACKS) {
    Con_DPrintf("CDAudio_Play: Bad track number %d.\n", track);
    return;
  }

  // Get the track's candidate URLs. A track with none is rejected here, as
  // cd_win.c rejects a track MCI_STATUS can't read before it stops the CD.
  let urls = null;
  if (_getTrackURL !== null) {
    urls = _getTrackURL(track);
  }
  if (typeof urls === "string") {
    urls = [urls];
  }

  if (urls === null || urls === undefined || urls.length === 0) {
    Con_DPrintf("CDAudio_Play: no URL for track %d\n", track);
    return;
  }

  if (playing) {
    if (playTrack === track && playName === "") {
      return;
    }
    CDAudio_Stop();
  }

  // bgmusic.c: no external music, and there is no CD to fall back on
  if (bgm_extmusic.value === 0) {
    return;
  }

  playTrack = track;
  playName = "";
  CDAudio_StartAttempt(urls, looping && bgmloop);
}

export function CDAudio_Stop() {
  if (!initialized || !enabled) {
    return;
  }

  // As in C, stopping while paused does nothing, so CDAudio_Resume still
  // restarts the paused track. A load still falling through its candidates
  // while paused keeps going.
  if (!playing) {
    return;
  }

  CDAudio_HaltPlayers();

  // drop any pending candidate fallthrough or gesture retry
  playAttempt++;
  gestureRetry = false;

  // only CDAudio_Pause sets wasPlaying (cd_win.c CDAudio_Stop clears it)
  wasPlaying = false;
  playing = false;
}

export function CDAudio_Pause() {
  if (!initialized || !enabled) {
    return;
  }

  if (!playing) {
    return;
  }

  if (musicElement) {
    try {
      musicElement.pause();
    } catch { /* ignore */ }
  }

  if (trackerPlayer !== null) {
    trackerPlayer.pause();
  }

  wasPlaying = playing;
  playing = false;
}

export function CDAudio_Resume() {
  if (!initialized || !enabled) {
    return;
  }

  if (!wasPlaying) {
    return;
  }

  playing = true;

  if (musicElement) {
    try {
      CDAudio_StartPlayer();
    } catch { /* ignore */ }
  }
}

export function CDAudio_Update() {
  if (!initialized || !enabled) {
    return;
  }

  let newVolume = Math.floor(bgmvolume.value * 255.0);
  if (newVolume !== cdvolume) {
    if (newVolume < 0) {
      Cvar_SetValue("bgmvolume", 0.0);
      newVolume = 0;
    } else if (newVolume > 255) {
      Cvar_SetValue("bgmvolume", 1.0);
      newVolume = 255;
    }

    cdvolume = newVolume;

    CDAudio_ApplyVolume();
  }

  // bgmusic.c BGM_Update streams the music each frame; tracker music
  // renders ahead of the audio clock here
  if (trackerPlayer !== null) {
    trackerPlayer.pump();
  }
}

/**
 * bgmusic.c BGM_Stop: stops the music whatever its state, a paused track
 * included (CDAudio_Stop keeps a paused track, as cd_win.c does).
 */
function BGM_Stop() {
  if (!initialized) {
    return;
  }

  CDAudio_HaltPlayers();
  playAttempt++;
  gestureRetry = false;
  wasPlaying = false;
  playing = false;
}

/** bgmusic.c BGM_Play: the music command */
export function BGM_Play(filename) {
  BGM_Stop();

  if (!initialized) {
    return;
  }

  if (filename === "") {
    Con_DPrintf("null music file name\n");
    return;
  }

  const urls = CDAudio_MusicURLs(filename, CDAudio_GameDirs());
  if (urls === null) {
    Con_Printf("Unhandled extension for %s\n", filename);
    return;
  }

  if (urls.length === 0) {
    Con_Printf("Couldn't handle music file %s\n", filename);
    return;
  }

  playTrack = 0;
  playName = filename;
  CDAudio_StartAttempt(urls, bgmloop);
}

function BGM_Play_f() {
  if (Cmd_Argc() === 2) {
    BGM_Play(Cmd_Argv(1));
  } else {
    Con_Printf("music <musicfile>\n");
  }
}

// BGM_Pause / BGM_Resume act on the music whether a CD track or the music
// command started it; this port has one player for both
function BGM_Pause_f() {
  if (playing) {
    if (musicElement) {
      try {
        musicElement.pause();
      } catch { /* ignore */ }
    }
    if (trackerPlayer !== null) {
      trackerPlayer.pause();
    }
    wasPlaying = true;
    playing = false;
  }
}

function BGM_Resume_f() {
  if (!playing && wasPlaying) {
    playing = true;
    if (musicElement) {
      try {
        CDAudio_StartPlayer();
      } catch { /* ignore */ }
    }
  }
}

function BGM_Loop_f() {
  if (Cmd_Argc() === 2) {
    const arg = Cmd_Argv(1).toLowerCase(); // q_strcasecmp
    if (arg === "0" || arg === "off") {
      bgmloop = false;
    } else if (arg === "1" || arg === "on") {
      bgmloop = true;
    } else if (arg === "toggle") {
      bgmloop = !bgmloop;
    }

    // bgmstream->loop = bgmloop
    if (playing || wasPlaying) {
      playLooping = bgmloop;
      if (musicElement) {
        musicElement.loop = bgmloop;
      }
      if (trackerPlayer !== null) {
        trackerPlayer.setLoop(bgmloop);
      }
    }
  }

  if (bgmloop) {
    Con_Printf("Music will be looped\n");
  } else {
    Con_Printf("Music will not be looped\n");
  }
}

function BGM_Stop_f() {
  BGM_Stop();
}

function BGM_Jump_f() {
  if (Cmd_Argc() !== 2) {
    Con_Printf("music_jump <ordernum>\n");
  } else if (trackerPlayer !== null) {
    // S_CodecJumpToOrder: only tracker codecs jump
    trackerPlayer.jump(parseInt(Cmd_Argv(1)) || 0);
  }
}

export function CDAudio_Init() {
  if (COM_CheckParm("-nocdaudio")) {
    return -1;
  }

  for (let n = 0; n < 256; n++) {
    remap[n] = n;
  }

  initialized = true;
  enabled = true;

  // Web-only guard: CDAudio_Init can run again after a shutdown
  if (Cvar_FindVar(bgm_extmusic.name) !== bgm_extmusic) {
    Cvar_RegisterVariable(bgm_extmusic);
  }

  const commands = [
    ["cd", CD_f],
    ["music", BGM_Play_f],
    ["music_pause", BGM_Pause_f],
    ["music_resume", BGM_Resume_f],
    ["music_loop", BGM_Loop_f],
    ["music_stop", BGM_Stop_f],
    ["music_jump", BGM_Jump_f],
  ];
  for (const [name, fn] of commands) {
    if (!Cmd_Exists(name)) {
      Cmd_AddCommand(name, fn);
    }
  }

  // retry music the autoplay policy refused on the next click or key press
  S_SetCallbacks({
    onUnlockAudio: CDAudio_GestureRetry,
    onBlockSound: CDAudio_BlockSound,
    onUnblockSound: CDAudio_UnblockSound,
  });

  Con_Printf("CD Audio Initialized (Web Audio)\n");

  return 0;
}

export function CDAudio_Shutdown() {
  if (!initialized) {
    return;
  }

  CDAudio_Stop();

  // CDAudio_Stop does nothing while paused. Web-only: drop a pending
  // candidate fallthrough or gesture retry on the element being released,
  // and forget the paused track, so a later CDAudio_Init starts clean.
  if (trackerPlayer !== null) {
    trackerPlayer.destroy();
    trackerPlayer = null;
  }
  elementActive = false;
  playAttempt++;
  gestureRetry = false;
  playing = false;
  wasPlaying = false;
  playName = "";
  CDAudio_ReleaseUMXBlob();

  if (musicSource) {
    try {
      musicSource.disconnect();
    } catch { /* ignore */ }

    musicSource = null;
  }

  if (musicGainNode) {
    try {
      musicGainNode.disconnect();
    } catch { /* ignore */ }

    musicGainNode = null;
  }

  musicElement = null;
  hiddenPaused = false;
  missingURLs.clear();
  initialized = false;
}

/** Console command handler for "cd" command */
function CD_f() {
  if (Cmd_Argc() < 2) {
    return;
  }

  const command = Cmd_Argv(1).toLowerCase(); // Q_strcasecmp

  if (command === "on") {
    enabled = true;
    return;
  }

  if (command === "off") {
    if (playing) {
      CDAudio_Stop();
    }
    enabled = false;
    return;
  }

  if (command === "reset") {
    enabled = true;
    if (playing) {
      CDAudio_Stop();
    }
    for (let n = 0; n < 256; n++) {
      remap[n] = n;
    }
    return;
  }

  if (command === "remap") {
    const ret = Cmd_Argc() - 2;
    if (ret <= 0) {
      for (let n = 1; n < 256; n++) {
        if (remap[n] !== n) {
          Con_Printf("  %d -> %d\n", n, remap[n]);
        }
      }

      return;
    }

    for (let n = 1; n <= ret; n++) {
      remap[n] = parseInt(Cmd_Argv(n + 1)) || 0;
    }

    return;
  }

  if (command === "play") {
    CDAudio_Play(parseInt(Cmd_Argv(2)) || 0, false);
    return;
  }

  if (command === "loop") {
    CDAudio_Play(parseInt(Cmd_Argv(2)) || 0, true);
    return;
  }

  if (command === "stop") {
    CDAudio_Stop();
    return;
  }

  if (command === "pause") {
    CDAudio_Pause();
    return;
  }

  if (command === "resume") {
    CDAudio_Resume();
    return;
  }

  // cd_win.c: eject also stops the playing track. There is no tray, so
  // CDAudio_Eject and cdValid = false have no counterpart; close
  // (CDAudio_CloseDoor) is tray-only and does nothing here.
  if (command === "eject") {
    if (playing) {
      CDAudio_Stop();
    }
    return;
  }

  if (command === "info") {
    // Web-only: music the music command started is named
    const what = playName !== "" ? playName : "track " + playTrack;
    if (playing) {
      Con_Printf(
        "Currently %s %s\n",
        playLooping ? "looping" : "playing",
        what,
      );
    } else if (wasPlaying) {
      Con_Printf(
        "Paused %s %s\n",
        playLooping ? "looping" : "playing",
        what,
      );
    } else {
      Con_Printf("Not playing\n");
    }

    Con_Printf("Volume is %d\n", cdvolume);
    return;
  }
}
