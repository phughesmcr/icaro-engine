// Ported from: WinQuake/cd_audio.c -- CD audio playback
// In browser port: uses Web Audio API (HTML5 Audio element) for music tracks

import { Con_DPrintf, Con_Printf } from "./console.js";
import { Cmd_AddCommand, Cmd_Argc, Cmd_Argv } from "./cmd.js";
import { Cvar_SetValue } from "./cvar.js";
import { COM_CheckParm } from "./common.js";
import { bgmvolume } from "./sound.js";
import {
  S_GetAudioContext,
  S_GetMasterGain,
  S_SetCallbacks,
} from "./snd_dma.js";

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

// Web Audio / HTML5 Audio for music
let musicElement = null; // HTMLAudioElement for music playback
let musicGainNode = null;
let musicSource = null; // MediaElementAudioSourceNode

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

// QuakeSpasm/Ironwail bgmusic.c music_handlers order, limited to the codecs
// browsers play
const MUSIC_DIRNAME = "music";
const MUSIC_EXTENSIONS = ["ogg", "mp3"];

// EXTERNAL INTERFACE

/**
 * Set a function that maps a track number to the URL of its music file, or to
 * an ordered list of candidate URLs: CDAudio_Play tries each in turn until one
 * loads (see CDAudio_TrackURLs).
 */
export function CDAudio_SetTrackURLProvider(fn) {
  _getTrackURL = fn;
}

/**
 * Candidate URLs for a track's CD rip, as QuakeSpasm/Ironwail's BGM_PlayCDtrack
 * looks for music/trackNN.<ext>: game directories in search-path priority
 * (the mission pack's before id1's), and within a directory ogg before mp3.
 * gamedirs lists the directories highest priority first.
 */
export function CDAudio_TrackURLs(track, gamedirs) {
  const name = "track" + String(track).padStart(2, "0");
  const urls = [];

  for (const dir of gamedirs) {
    for (const ext of MUSIC_EXTENSIONS) {
      urls.push(dir + "/" + MUSIC_DIRNAME + "/" + name + "." + ext);
    }
  }

  return urls;
}

/**
 * Exactly one control sets the level. Routed through the gain node, that node
 * does and the element stays at 1.0, so the two aren't multiplied and the
 * element doesn't hold the volume from when it started. Unrouted (no
 * AudioContext, or createMediaElementSource threw), the element volume does.
 */
function CDAudio_ApplyVolume() {
  if (musicGainNode !== null) {
    musicGainNode.gain.value = bgmvolume.value;
    if (musicElement !== null) {
      musicElement.volume = 1.0;
    }
  } else if (musicElement !== null) {
    musicElement.volume = bgmvolume.value;
  }
}

// CDAudio_BlockSound / CDAudio_UnblockSound
//
// Web only; cd_win.c has no focus handling for CD. Hidden tabs suspend the
// AudioContext (S_BlockSound), which silences a routed element. An element
// that isn't routed would keep playing aloud, so it pauses and resumes with
// the same block and unblock.
function CDAudio_BlockSound() {
  soundBlocked = true;

  if (
    !initialized || !playing || musicElement === null || musicGainNode !== null
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

  if (!initialized || !playing || musicElement === null) {
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
  if (soundBlocked === true && musicGainNode === null) {
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

/**
 * Loads the first candidate URL not already known to be missing, and falls
 * through to the next one when the element reports a load error.
 */
function CDAudio_PlayURL(urls, index, attempt) {
  while (index < urls.length && missingURLs.has(urls[index])) {
    index++;
  }

  if (index >= urls.length) {
    // Ironwail prints this with Con_Printf. Most players of the web build
    // have no music files, so keep it to developer mode, as WinQuake is
    // quiet about a missing CD.
    Con_DPrintf("Couldn't find a cdrip for track %d\n", playTrack);
    playing = false;
    wasPlaying = false; // nothing for CDAudio_Resume to restart
    gestureRetry = false;
    return;
  }

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
    CDAudio_PlayURL(urls, index + 1, attempt);
  };

  musicElement.src = url;

  // paused while an earlier candidate was failing: CDAudio_Resume plays it
  if (playing) {
    CDAudio_StartElement(attempt);
  }
}

/**
 * Registered as the S_UnlockAudio callback, so it runs inside the user's
 * gesture handler, where the browser allows play().
 */
function CDAudio_GestureRetry() {
  if (!gestureRetry || !playing || musicElement === null) {
    return;
  }

  CDAudio_StartElement(playAttempt);
}

/**
 * As in cd_win.c, a bad or missing track is rejected before the current track
 * is stopped, so a map without a CD track (svc_cdtrack 0) keeps the music.
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
    if (playTrack === track) {
      return;
    }
    CDAudio_Stop();
  }

  playLooping = looping;
  playTrack = track;

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

    // Try to connect through Web Audio for unified volume control
    const audioContext = S_GetAudioContext();
    const masterGain = S_GetMasterGain();

    if (audioContext && masterGain && !musicSource) {
      try {
        // Build both nodes before keeping either: once
        // createMediaElementSource succeeds the element's output only
        // reaches the speakers through the graph.
        const gain = audioContext.createGain();
        const source = audioContext.createMediaElementSource(musicElement);
        source.connect(gain);
        gain.connect(audioContext.destination);
        musicSource = source;
        musicGainNode = gain;
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
    CDAudio_PlayURL(urls, 0, playAttempt);
  } catch (e) {
    Con_DPrintf("CDAudio_Play: track %d failed: %s\n", track, e.message);
    playing = false;
  }
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

  if (musicElement) {
    try {
      musicElement.pause();
      musicElement.currentTime = 0;
    } catch { /* ignore */ }
  }

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
      CDAudio_StartElement(playAttempt);
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

  Cmd_AddCommand("cd", CD_f);

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
  playAttempt++;
  gestureRetry = false;
  playing = false;
  wasPlaying = false;

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
    if (playing) {
      Con_Printf(
        "Currently %s track %d\n",
        playLooping ? "looping" : "playing",
        playTrack,
      );
    } else if (wasPlaying) {
      Con_Printf(
        "Paused %s track %d\n",
        playLooping ? "looping" : "playing",
        playTrack,
      );
    } else {
      Con_Printf("Not playing\n");
    }

    Con_Printf("Volume is %d\n", cdvolume);
    return;
  }
}
