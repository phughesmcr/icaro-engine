// Ported from: WinQuake/snd_dma.c -- main sound system using Web Audio API

import { Cvar_RegisterVariable } from "./cvar.js";
import { Cmd_AddCommand, Cmd_Argc, Cmd_Argv } from "./cmd.js";
import { Con_DPrintf, Con_Printf } from "./console.js";
import { Q_atof } from "./common.js";
import {
  AMBIENT_SKY,
  AMBIENT_WATER,
  bgmvolume,
  channels,
  listener_forward,
  listener_origin,
  listener_right,
  listener_up,
  loadas8bit,
  MAX_CHANNELS,
  MAX_DYNAMIC_CHANNELS,
  NUM_AMBIENTS,
  paintedtime,
  sfx_t,
  shm,
  sn,
  snd_blocked,
  snd_initialized,
  sound_nominal_clip_dist,
  Sound_SetBlocked,
  Sound_SetInitialized,
  Sound_SetPaintedtime,
  Sound_SetShm,
  Sound_SetTotalChannels,
  total_channels,
  volume,
} from "./sound.js";
import { S_LoadSound } from "./snd_mem.js";
import { cl } from "./client.js";
import { Mod_PointInLeaf } from "./gl_model.js";

/*
==============================================================================

			WEB AUDIO STATE

==============================================================================
*/

let audioContext = null;
let masterGain = null;

// Known sounds cache
const known_sfx = [];
let num_sfx = 0;
const MAX_SFX = 1024; // QuakeSpasm/Ironwail; WinQuake has 512

for (let i = 0; i < MAX_SFX; i++) {
  known_sfx[i] = new sfx_t();
}

// vec3_origin for S_LocalSound (avoids allocating per call)
const _vec3_origin = new Float32Array(3);

// Ambient sounds
const ambient_sfx = new Array(NUM_AMBIENTS).fill(null);
let s_updateframe = 0; // counts S_Update calls, stands in for C's unmixed ch->pos == 0
let sound_started = false;
const snd_ambient = true; // whether ambient sounds are enabled

// Callback for host_frametime (to avoid circular dependency)
let _getHostFrametime = () => 0;
// Callback run by S_UnlockAudio inside a user gesture (cd_audio's autoplay retry)
let _onUnlockAudio = () => {};
// Callbacks run when sound is blocked or unblocked (cd_audio pauses an element
// the AudioContext doesn't carry). Web-only: C has no focus handling for CD.
let _onBlockSound = () => {};
let _onUnblockSound = () => {};

// Rate sounds are cached and played at: WinQuake's snd_win.c sets
// shm->speed = 11025, and QuakeSpasm/Ironwail cache sounds at sndspeed 11025
// too. Each AudioBuffer is created at this rate and Web Audio resamples it to
// the device rate (often 48000), so pitch is exact. Caching at the device rate
// instead made ResampleSfx's 8.8 fixed-point step inexact (11025/48000) and
// played 11 kHz sounds about 1.4% slow and flat.
const SND_SPEED = 11025;

// nosound cvar
const nosound = { name: "nosound", string: "0", value: 0 };
const precache = { name: "precache", string: "1", value: 1 };
const ambient_level = { name: "ambient_level", string: "0.3", value: 0.3 };
const ambient_fade = { name: "ambient_fade", string: "100", value: 100 };
const snd_noextraupdate = { name: "snd_noextraupdate", string: "0", value: 0 };
const snd_show = { name: "snd_show", string: "0", value: 0 };

/*
================
S_Init
================
*/
export function S_Init() {
  Con_Printf("\nSound Initialization\n");

  Cvar_RegisterVariable(nosound);
  Cvar_RegisterVariable(volume);
  Cvar_RegisterVariable(precache);
  Cvar_RegisterVariable(loadas8bit);
  Cvar_RegisterVariable(bgmvolume);
  Cvar_RegisterVariable(ambient_level);
  Cvar_RegisterVariable(ambient_fade);
  Cvar_RegisterVariable(snd_noextraupdate);
  Cvar_RegisterVariable(snd_show);

  Cmd_AddCommand("play", S_Play);
  Cmd_AddCommand("playvol", S_PlayVol);
  Cmd_AddCommand("stopsound", S_StopAllSoundsC);
  Cmd_AddCommand("soundlist", S_SoundList);
  Cmd_AddCommand("soundinfo", S_SoundInfo_f);

  if (nosound.value) {
    Con_Printf("Sound disabled via nosound cvar\n");
    return;
  }

  // Initialize Web Audio API
  try {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    // old webkitAudioContext is not an EventTarget
    if (typeof audioContext.addEventListener === "function") {
      audioContext.addEventListener("statechange", S_OnContextStateChange);
    }
    masterGain = audioContext.createGain();
    masterGain.connect(audioContext.destination);
    masterGain.gain.value = volume.value;

    // started while the page is hidden: stay blocked (S_BlockSound)
    if (snd_blocked > 0) audioContext.suspend();

    sound_started = true;
    Sound_SetInitialized(true);

    Con_Printf("Web Audio API initialized (%d Hz)\n", audioContext.sampleRate);
  } catch (e) {
    Con_Printf("Failed to initialize Web Audio API: %s\n", e.message);
    return;
  }

  // Set up DMA-equivalent state
  sn.speed = SND_SPEED;
  sn.samplebits = 16;
  sn.channels = 2;
  sn.samples = 16384;
  sn.samplepos = 0;
  sn.soundalive = true;
  sn.gamealive = true;
  sn.submission_chunk = 1;
  sn.buffer = new Uint8Array(sn.samples * (sn.samplebits / 8));
  Sound_SetShm(sn);

  Sound_SetTotalChannels(MAX_DYNAMIC_CHANNELS + NUM_AMBIENTS);

  Con_Printf("Sound sampling rate: %d\n", sn.speed);

  // The end of C's S_Init. This was in S_Startup, which nothing calls, so the
  // water and wind ambients were never loaded.
  ambient_sfx[AMBIENT_WATER] = S_PrecacheSound("ambience/water1.wav");
  ambient_sfx[AMBIENT_SKY] = S_PrecacheSound("ambience/wind2.wav");
}

/*
================
S_Shutdown
================
*/
export function S_Shutdown() {
  if (!sound_started) {
    return;
  }

  sound_started = false;
  Sound_SetInitialized(false);

  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }

  masterGain = null;
  num_sfx = 0;
}

/*
================
S_Startup
================
*/
export function S_Startup() {
  if (!snd_initialized) {
    return;
  }

  S_ResumeContext();

  sound_started = true;
}

/*
================
S_SetCallbacks

Set callbacks for host_frametime access (to avoid circular dependency)
================
*/
export function S_SetCallbacks(callbacks) {
  if (callbacks.getHostFrametime) {
    _getHostFrametime = callbacks.getHostFrametime;
  }

  if (callbacks.onUnlockAudio) {
    _onUnlockAudio = callbacks.onUnlockAudio;
  }

  if (callbacks.onBlockSound) {
    _onBlockSound = callbacks.onBlockSound;
  }

  if (callbacks.onUnblockSound) {
    _onUnblockSound = callbacks.onUnblockSound;
  }
}

/*
================
S_ResumeContext

Web-only (no C equivalent). iOS leaves the context 'interrupted' after a
call, Siri or an alarm without hiding the page, so resume from any state
but 'running' or 'closed'. May reject without a user gesture; the next
gesture's S_UnlockAudio retries.
================
*/
function S_ResumeContext() {
  if (audioContext === null || snd_blocked > 0) return;
  if (audioContext.state === "running" || audioContext.state === "closed") {
    return;
  }

  audioContext.resume().catch(() => {});
}

// Web-only: try to recover when the context leaves 'running' unblocked.
function S_OnContextStateChange() {
  S_ResumeContext();
}

/*
================
S_UnlockAudio

Called from user gesture handlers (mouse/keyboard/touch) to unlock the AudioContext.
Web Audio API requires a user gesture before audio can play.
================
*/
export function S_UnlockAudio() {
  // A blocked (hidden) page stays silent until S_UnblockSound.
  S_ResumeContext();

  if (snd_blocked <= 0) {
    _onUnlockAudio();
  }
}

/*
==================
S_BlockSound

Ported from snd_win.c. The wave-out path counts blocks and silences the
device on the first (waveOutReset); suspending the AudioContext is the
Web Audio equivalent. Nothing is mixed while hidden anyway: the frame
loop runs on requestAnimationFrame, which the browser pauses.
==================
*/
export function S_BlockSound() {
  Sound_SetBlocked(snd_blocked + 1);

  if (
    snd_blocked === 1 && audioContext !== null &&
    audioContext.state !== "closed"
  ) {
    audioContext.suspend().catch(() => {});
  }

  if (snd_blocked === 1) {
    _onBlockSound();
  }
}

/*
==================
S_UnblockSound
==================
*/
export function S_UnblockSound() {
  Sound_SetBlocked(snd_blocked - 1);

  // Resume whatever the reported state: suspend() is async, so a page hidden
  // and shown again quickly can still read 'running' here and then go
  // suspended, and iOS reports 'interrupted' after a call or backgrounding.
  if (
    snd_blocked <= 0 && audioContext !== null && audioContext.state !== "closed"
  ) {
    audioContext.resume().catch(() => {});
  }

  if (snd_blocked <= 0) {
    _onUnblockSound();
  }
}

/*
==================
S_FindName
==================
*/
function S_FindName(name) {
  if (!name || name.length === 0) {
    Con_Printf("S_FindName: NULL name\n");
    return null;
  }

  if (name.length >= 64) { // MAX_QPATH
    Con_Printf("Sound name too long: %s\n", name);
    return null;
  }

  // see if already loaded
  for (let i = 0; i < num_sfx; i++) {
    if (known_sfx[i].name === name) {
      return known_sfx[i];
    }
  }

  if (num_sfx >= MAX_SFX) {
    Con_Printf("S_FindName: out of sfx_t\n");
    return null;
  }

  const sfx = known_sfx[num_sfx];
  sfx.name = name;
  sfx.cache = null;
  num_sfx++;

  return sfx;
}

/*
==================
S_PrecacheSound
==================
*/
export function S_PrecacheSound(name) {
  if (!sound_started || nosound.value) {
    return null;
  }

  const sfx = S_FindName(name);

  // cache it in
  if (precache.value) {
    S_LoadSound(sfx);
  }

  return sfx;
}

/*
==================
S_TouchSound
==================
*/
export function S_TouchSound(name) {
  if (!sound_started || nosound.value) {
    return;
  }

  S_FindName(name);
}

/*
==================
SND_PickChannel

Picks a channel based on priorities, empty slots, number of channels
==================
*/
export function SND_PickChannel(entnum, entchannel) {
  // Check for replacement sound, or find the best one to replace
  let first_to_die = -1;
  let life_left = 0x7fffffff;

  for (
    let ch_idx = NUM_AMBIENTS;
    ch_idx < NUM_AMBIENTS + MAX_DYNAMIC_CHANNELS;
    ch_idx++
  ) {
    const ch = channels[ch_idx];

    // channel 0 never overrides
    if (
      entchannel !== 0 &&
      ch.entnum === entnum &&
      (ch.entchannel === entchannel || entchannel === -1)
    ) {
      // allways override sound from same entity
      first_to_die = ch_idx;
      break;
    }

    // In C the mixer clears sfx when a sound runs out. Here a channel whose
    // Web Audio source never started (or has gone) is silent, so treat it
    // as finished: not protected, and end = 0 so it wins like an empty one.
    const playing = ch.sfx != null && ch._audioSource != null;

    // don't let monster sounds override player sounds
    if (ch.entnum === cl.viewentity && entnum !== cl.viewentity && playing) {
      continue;
    }

    const end = playing ? ch.end : 0;
    if (end - paintedtime < life_left) {
      life_left = end - paintedtime;
      first_to_die = ch_idx;
    }
  }

  if (first_to_die === -1) {
    if (snd_show.value) {
      console.log("SND_PickChannel: no free channel!");
    }

    return null;
  }

  if (channels[first_to_die].sfx) {
    channels[first_to_die].sfx = null;
  }

  // Stop any existing Web Audio source on this channel
  _stopWebAudio(channels[first_to_die]);

  return channels[first_to_die];
}

/*
=================
SND_Spatialize
=================
*/
export function SND_Spatialize(ch) {
  // anything coming from the view entity will always be full volume
  if (ch.entnum === cl.viewentity) {
    ch.leftvol = ch.master_vol;
    ch.rightvol = ch.master_vol;
    return;
  }

  // calculate stereo separation and distance attenuation
  const source = ch.origin;
  let source_vec_0 = source[0] - listener_origin[0];
  let source_vec_1 = source[1] - listener_origin[1];
  let source_vec_2 = source[2] - listener_origin[2];

  // VectorNormalize: get length then normalize
  let dist = Math.sqrt(
    source_vec_0 * source_vec_0 + source_vec_1 * source_vec_1 +
      source_vec_2 * source_vec_2,
  );
  if (dist > 0) {
    source_vec_0 /= dist;
    source_vec_1 /= dist;
    source_vec_2 /= dist;
  }

  dist *= ch.dist_mult;

  // dot product with normalized source vector gives [-1, 1]
  const dot = listener_right[0] * source_vec_0 +
    listener_right[1] * source_vec_1 + listener_right[2] * source_vec_2;

  const rscale = 1.0 + dot;
  const lscale = 1.0 - dot;

  // add in distance effect
  let scale = (1.0 - dist) * rscale;
  ch.rightvol = Math.floor(ch.master_vol * scale);
  if (ch.rightvol < 0) ch.rightvol = 0;

  scale = (1.0 - dist) * lscale;
  ch.leftvol = Math.floor(ch.master_vol * scale);
  if (ch.leftvol < 0) ch.leftvol = 0;
}

/*
=================
S_StartSound
=================
*/
export function S_StartSound(
  entnum,
  entchannel,
  sfx,
  origin,
  fvol,
  attenuation,
) {
  if (!sound_started || !sfx) {
    return;
  }

  if (nosound.value) {
    return;
  }

  const vol = Math.floor(fvol * 255);

  // pick a channel to play on
  const target_chan = SND_PickChannel(entnum, entchannel);
  if (!target_chan) {
    return;
  }

  // spatialize
  target_chan.origin[0] = origin[0];
  target_chan.origin[1] = origin[1];
  target_chan.origin[2] = origin[2];
  target_chan.dist_mult = attenuation / sound_nominal_clip_dist;
  target_chan.master_vol = vol;
  target_chan.entnum = entnum;
  target_chan.entchannel = entchannel;

  SND_Spatialize(target_chan);

  if (target_chan.leftvol === 0 && target_chan.rightvol === 0) {
    return; // not audible at all
  }

  // new channel
  const sc = S_LoadSound(sfx);
  if (sc == null) {
    target_chan.sfx = null;
    return; // couldn't load the sound's data
  }

  // Verify the sound data is valid
  if (sc.data == null || sc.length === 0) {
    target_chan.sfx = null;
    return;
  }

  target_chan.sfx = sfx;
  target_chan.pos = 0;
  target_chan.end = paintedtime + sc.length;
  target_chan.startframe = s_updateframe;

  // if an identical sound has also been started this frame, offset the pos
  // a bit to keep it from just making the first one louder.
  // C tests !check->pos (not mixed yet); with no mixer, startframe says
  // the channel was started since the last S_Update.
  for (
    let ch_idx = NUM_AMBIENTS;
    ch_idx < NUM_AMBIENTS + MAX_DYNAMIC_CHANNELS;
    ch_idx++
  ) {
    const check = channels[ch_idx];
    if (check === target_chan) {
      continue;
    }

    if (check.sfx === sfx && check.startframe === s_updateframe) {
      // QuakeSpasm/Ironwail (LordHavoc) skip: id's clamp against
      // target_chan->end let the skip run past the end of short sounds
      let skip = Math.floor(0.1 * shm.speed);
      if (skip > sc.length) {
        skip = sc.length;
      }
      if (skip > 0) {
        skip = Math.floor(Math.random() * skip); // rand() % skip
      }
      target_chan.pos += skip;
      target_chan.end -= skip;
      break;
    }
  }

  // Play using Web Audio API
  _playWebAudio(sc, target_chan);
}

/*
=================
S_StopSound
=================
*/
export function S_StopSound(entnum, entchannel) {
  for (let i = 0; i < MAX_DYNAMIC_CHANNELS; i++) {
    if (
      channels[i].entnum === entnum &&
      channels[i].entchannel === entchannel
    ) {
      channels[i].end = 0;
      channels[i].sfx = null;
      _stopWebAudio(channels[i]);

      return;
    }
  }
}

/*
=================
S_StopAllSounds
=================
*/
export function S_StopAllSounds(clear) {
  if (!sound_started) {
    return;
  }

  Sound_SetTotalChannels(MAX_DYNAMIC_CHANNELS + NUM_AMBIENTS);

  for (let i = 0; i < MAX_CHANNELS; i++) {
    // Stop any playing Web Audio source before zeroing
    _stopWebAudio(channels[i]);

    // Q_memset(channels, 0, MAX_CHANNELS * sizeof(channel_t)) -- zero ALL fields
    channels[i].sfx = null;
    channels[i].leftvol = 0;
    channels[i].rightvol = 0;
    channels[i].end = 0;
    channels[i].pos = 0;
    channels[i].looping = 0;
    channels[i].entnum = 0;
    channels[i].entchannel = 0;
    channels[i].origin[0] = 0;
    channels[i].origin[1] = 0;
    channels[i].origin[2] = 0;
    channels[i].dist_mult = 0;
    channels[i].master_vol = 0;
    channels[i].startframe = -1;
  }

  if (clear) {
    S_ClearBuffer();
  }
}

function S_StopAllSoundsC() {
  S_StopAllSounds(true);
}

/*
=================
S_ClearBuffer
=================
*/
export function S_ClearBuffer() {
  if (!sound_started || !shm) {
    return;
  }

  if (shm.buffer) {
    shm.buffer.fill(0);
  }
}

/*
===================
S_UpdateAmbientSounds

Updates the volumes of ambient sounds (water, wind, etc.) based on the
leaf the listener is in.
===================
*/
function S_UpdateAmbientSounds() {
  if (!snd_ambient) {
    return;
  }

  // calc ambient sound levels
  if (cl.worldmodel == null) {
    return;
  }

  const leaf = Mod_PointInLeaf(listener_origin, cl.worldmodel);
  if (leaf == null || ambient_level.value === 0) {
    // Clear all ambient channels. The C mixer skips a channel without sfx;
    // here the looping Web Audio source has to be stopped as well, or it
    // keeps playing at its last gain. master_vol is kept, as in C, so the
    // fade carries on from it, and the loop below restarts the source.
    for (
      let ambient_channel = 0;
      ambient_channel < NUM_AMBIENTS;
      ambient_channel++
    ) {
      channels[ambient_channel].sfx = null;
      _stopWebAudio(channels[ambient_channel]);
    }

    return;
  }

  const host_frametime = _getHostFrametime();

  for (
    let ambient_channel = 0;
    ambient_channel < NUM_AMBIENTS;
    ambient_channel++
  ) {
    const chan = channels[ambient_channel];
    chan.sfx = ambient_sfx[ambient_channel];

    // Skip if no sound precached for this ambient type
    if (chan.sfx == null) {
      continue;
    }

    // Calculate target volume from leaf's ambient level
    let vol = ambient_level.value * leaf.ambient_sound_level[ambient_channel];
    if (vol < 8) {
      vol = 0;
    }

    // don't adjust volume too fast - smooth fade in/out
    if (chan.master_vol < vol) {
      chan.master_vol += host_frametime * ambient_fade.value;
      if (chan.master_vol > vol) {
        chan.master_vol = vol;
      }
    } else if (chan.master_vol > vol) {
      chan.master_vol -= host_frametime * ambient_fade.value;
      if (chan.master_vol < vol) {
        chan.master_vol = vol;
      }
    }

    // Ambient sounds are omnidirectional - same volume in both ears
    chan.leftvol = chan.master_vol;
    chan.rightvol = chan.master_vol;

    // Handle Web Audio playback for ambient sounds.
    // Keep audio nodes alive and just update gain to avoid
    // creating new nodes every time volume crosses zero.
    if (chan.sfx) {
      if (!chan._audioSource) {
        // No audio nodes yet - start playing if audible
        if (chan.leftvol > 0 || chan.rightvol > 0) {
          const sc = S_LoadSound(chan.sfx);
          if (sc) {
            _playWebAudio(sc, chan);
          }
        }
      } else {
        // Audio nodes exist - just update volume (will go to 0 when inaudible)
        _updateWebAudioSpatial(chan);
      }
    }
  }
}

/*
=================
S_Update
=================
*/
export function S_Update(origin, forward, right, up) {
  if (!sound_started || nosound.value) {
    return;
  }

  // Sounds started before this point count as mixed (see S_StartSound)
  s_updateframe++;

  listener_origin[0] = origin[0];
  listener_origin[1] = origin[1];
  listener_origin[2] = origin[2];

  listener_forward[0] = forward[0];
  listener_forward[1] = forward[1];
  listener_forward[2] = forward[2];

  listener_right[0] = right[0];
  listener_right[1] = right[1];
  listener_right[2] = right[2];

  listener_up[0] = up[0];
  listener_up[1] = up[1];
  listener_up[2] = up[2];

  // Update general area ambient sound sources
  S_UpdateAmbientSounds();

  // advance the play clock (S_Update_ -> GetSoundtime / S_PaintChannels)
  S_UpdatePaintedtime();

  // Update master volume
  if (masterGain) {
    masterGain.gain.value = volume.value;
  }

  let combine = null;

  // update spatialization for static and dynamic sounds
  // (ambients are handled by S_UpdateAmbientSounds)
  for (let i = NUM_AMBIENTS; i < total_channels; i++) {
    const ch = channels[i];

    if (!ch.sfx) {
      continue;
    }
    SND_Spatialize(ch); // respatialize channel
    if (ch.leftvol === 0 && ch.rightvol === 0) {
      continue;
    }

    // try to combine static sounds with a previous channel of the same
    // sound effect so we don't mix five torches every frame

    if (i >= MAX_DYNAMIC_CHANNELS + NUM_AMBIENTS) {
      // see if it can just use the last one
      if (combine !== null && combine.sfx === ch.sfx) {
        combine.leftvol += ch.leftvol;
        combine.rightvol += ch.rightvol;
        ch.leftvol = ch.rightvol = 0;
        continue;
      }

      // search for one
      let j;
      for (j = MAX_DYNAMIC_CHANNELS + NUM_AMBIENTS; j < i; j++) {
        if (channels[j].sfx === ch.sfx) {
          break;
        }
      }
      combine = channels[j];

      // mirrors the C: j stops at i, so it never reaches total_channels
      // and an unmatched channel becomes the next combine target itself
      if (j === total_channels) {
        combine = null;
      } else {
        if (combine !== ch) {
          combine.leftvol += ch.leftvol;
          combine.rightvol += ch.rightvol;
          ch.leftvol = ch.rightvol = 0;
        }

        continue;
      }
    }
  }

  // Web-only: the port has no mixer (S_Update_ / S_PaintChannels), so
  // start or update each channel's WebAudio nodes from the volumes above,
  // after combining has moved volume onto earlier channels. Summed volumes
  // over 255 are clamped by SND_ChannelGain, as the C mixer clamps them.
  for (let i = NUM_AMBIENTS; i < total_channels; i++) {
    const ch = channels[i];

    if (!ch.sfx) {
      continue;
    }

    const isStatic = i >= NUM_AMBIENTS + MAX_DYNAMIC_CHANNELS;
    const isAudible = ch.leftvol > 0 || ch.rightvol > 0;

    if (isStatic) {
      // Static/ambient sounds: keep audio nodes alive, just mute/unmute via gain.
      // This avoids creating new AudioBufferSourceNode + GainNode + StereoPannerNode
      // every time a sound crosses the audibility boundary (which causes memory leaks
      // and event listener accumulation).
      if (!ch._audioSource) {
        // No audio nodes yet - start playing if audible
        if (isAudible) {
          const sc = S_LoadSound(ch.sfx);
          if (sc) {
            _playWebAudio(sc, ch);
          }
        }
      } else {
        // Audio nodes exist - just update volume/panning
        _updateWebAudioSpatial(ch);
      }
    } else if (ch._audioSource) {
      // Dynamic sounds: just update volume/panning
      _updateWebAudioSpatial(ch);
    }
  }
}

/*
=================
S_UpdatePaintedtime

The port has no mixer, so paintedtime (in shm->speed sample frames, the same
units as sfxcache_t.length after ResampleSfx) is taken from the AudioContext
clock. Looping channels get their end pushed on, as S_PaintChannels does when
it wraps a sound back to loopstart.
=================
*/
function S_UpdatePaintedtime() {
  if (!audioContext || !shm) {
    return;
  }

  Sound_SetPaintedtime(Math.floor(audioContext.currentTime * shm.speed));

  for (let i = NUM_AMBIENTS; i < NUM_AMBIENTS + MAX_DYNAMIC_CHANNELS; i++) {
    const ch = channels[i];
    if (!ch.sfx || !ch._audioSource || ch.end > paintedtime) {
      continue;
    }

    const sc = ch.sfx.cache;
    if (sc == null || sc.loopstart < 0 || sc.length - sc.loopstart <= 0) {
      continue;
    }

    // ch->pos = sc->loopstart; ch->end = ltime + sc->length - ch->pos;
    const looplen = sc.length - sc.loopstart;
    ch.end += Math.ceil((paintedtime - ch.end + 1) / looplen) * looplen;
  }
}

/*
=================
S_ExtraUpdate

Called from other places to update sound while loading, etc.
=================
*/
export function S_ExtraUpdate() {
  if (snd_noextraupdate.value) {
    return;
  }

  // In Web Audio, nothing special needed
}

/*
=================
S_LocalSound

Play a sound at full volume, no attenuation
=================
*/
export function S_LocalSound(name) {
  if (!sound_started || nosound.value) {
    return;
  }

  const sfx = S_PrecacheSound(name);
  if (!sfx) {
    Con_Printf("S_LocalSound: can't cache %s\n", name);
    return;
  }

  S_StartSound(cl.viewentity, -1, sfx, _vec3_origin, 1, 1);
}

/*
==================
S_StaticSound
==================
*/
export function S_StaticSound(sfx, origin, vol, attenuation) {
  if (sfx == null || !sound_started) {
    return;
  }

  if (total_channels >= MAX_CHANNELS) {
    Con_Printf("total_channels == MAX_CHANNELS\n");
    return;
  }

  const ss = channels[total_channels];
  Sound_SetTotalChannels(total_channels + 1);

  const sc = S_LoadSound(sfx);
  if (sc == null) {
    return;
  }

  if (sc.loopstart < 0) {
    Con_Printf("Sound %s not looped\n", sfx.name);
    return;
  }

  ss.sfx = sfx;
  ss.origin[0] = origin[0];
  ss.origin[1] = origin[1];
  ss.origin[2] = origin[2];
  ss.master_vol = vol;
  ss.dist_mult = (attenuation / 64) / sound_nominal_clip_dist;
  ss.entnum = -1; // -1 = static world sound, not from any entity
  ss.entchannel = 0;

  ss.end = paintedtime + sc.length;

  SND_Spatialize(ss);

  // Static sounds are not played immediately here. S_Update() manages them
  // each frame, starting/stopping playback based on player distance.
}

/*
=================
S_ClearPrecache
=================
*/
export function S_ClearPrecache() {
  // nothing to do in web audio
}

/*
=================
S_BeginPrecaching
=================
*/
export function S_BeginPrecaching() {
  // nothing to do
}

/*
=================
S_EndPrecaching
=================
*/
export function S_EndPrecaching() {
  // nothing to do
}

/*
=================
S_AmbientOff / S_AmbientOn
=================
*/
export function S_AmbientOff() {
  // stub
}

export function S_AmbientOn() {
  // stub
}

/*
==============================================================================

			COMMANDS

==============================================================================
*/

let s_play_hash = 345; // static int hash=345; in S_Play
let s_playvol_hash = 543; // static int hash=543; in S_PlayVol

function S_Play() {
  for (let i = 1; i < Cmd_Argc(); i++) {
    let name = Cmd_Argv(i);
    if (name.indexOf(".") === -1) {
      name += ".wav";
    }

    const sfx = S_PrecacheSound(name);
    S_StartSound(s_play_hash++, 0, sfx, listener_origin, 1.0, 1.0);
  }
}

function S_PlayVol() {
  for (let i = 1; i < Cmd_Argc(); i += 2) {
    let name = Cmd_Argv(i);
    if (name.indexOf(".") === -1) {
      name += ".wav";
    }

    const sfx = S_PrecacheSound(name);
    const vol = Q_atof(Cmd_Argv(i + 1));
    S_StartSound(s_playvol_hash++, 0, sfx, listener_origin, vol, 1.0);
  }
}

function S_SoundList() {
  let total = 0;

  for (let i = 0; i < num_sfx; i++) {
    const sfx = known_sfx[i];
    const sc = sfx.cache;
    if (!sc) continue;

    const size = sc.length * sc.width * (sc.stereo + 1);
    total += size;

    let info = "";
    if (sc.loopstart >= 0) info += "L";
    else info += " ";

    Con_Printf("%s : %d (%s)\n", sfx.name, size, info);
  }

  Con_Printf("Total resident: %d\n", total);
}

function S_SoundInfo_f() {
  if (!sound_started || !shm) {
    Con_Printf("sound system not started\n");
    return;
  }

  Con_Printf(
    "%d bit, %s, %d Hz\n",
    shm.samplebits,
    (shm.channels === 2) ? "stereo" : "mono",
    shm.speed,
  );
}

/*
==============================================================================

			WEB AUDIO PLAYBACK HELPER

==============================================================================
*/

function _playWebAudio(sc, chan) {
  if (!audioContext || !sc || !sc.data) {
    return;
  }

  // Don't play sounds until AudioContext is running (unlocked by user interaction)
  if (audioContext.state !== "running") {
    return;
  }

  try {
    // Cache AudioBuffer on the sfxcache to avoid recreating it every play
    let audioBuffer = sc._audioBuffer;

    const sampleRate = sc.speed || 11025;
    const numSamples = sc.length;

    if (!audioBuffer) {
      const numChannels = (sc.stereo !== 0) ? 2 : 1;

      audioBuffer = audioContext.createBuffer(
        numChannels,
        numSamples,
        sampleRate,
      );

      const channelData = audioBuffer.getChannelData(0);

      if (sc.width === 1) {
        // 8-bit unsigned
        for (let i = 0; i < numSamples; i++) {
          channelData[i] = (sc.data[i] - 128) / 128.0;
        }
      } else {
        // 16-bit signed
        const view = new DataView(sc.data.buffer, sc.data.byteOffset);
        for (let i = 0; i < numSamples; i++) {
          channelData[i] = view.getInt16(i * 2, true) / 32768.0;
        }
      }

      sc._audioBuffer = audioBuffer;
    }

    const source = audioContext.createBufferSource();
    source.buffer = audioBuffer;

    // Looping
    if (sc.loopstart >= 0) {
      source.loop = true;
      source.loopStart = sc.loopstart / sampleRate;
      source.loopEnd = numSamples / sampleRate;
    }

    // Volume (master gain already applies volume.value, so only use channel volume here).
    // One gain per side into a merger, as the C mixer scales each side on its own.
    const leftGain = audioContext.createGain();
    const rightGain = audioContext.createGain();
    const merger = audioContext.createChannelMerger(2);
    leftGain.gain.value = SND_ChannelGain(chan.leftvol);
    rightGain.gain.value = SND_ChannelGain(chan.rightvol);

    // Connect: source -> left/right gain -> merger -> master
    source.connect(leftGain);
    source.connect(rightGain);
    leftGain.connect(merger, 0, 0);
    rightGain.connect(merger, 0, 1);
    merger.connect(masterGain);

    // Store references for updating and stopping
    chan._audioSource = source;
    chan._leftGain = leftGain;
    chan._rightGain = rightGain;

    // Handle sound completion for non-looping sounds
    if (!source.loop) {
      source.onended = function () {
        // Mark channel as finished
        if (chan._audioSource === source) {
          chan._audioSource = null;
          chan._leftGain = null;
          chan._rightGain = null;
          chan.sfx = null;
          chan.end = 0;
        }
      };
    }

    // S_StartSound may have offset the start (identical sounds this frame)
    if (chan.pos > 0 && chan.pos < numSamples) {
      source.start(0, chan.pos / sampleRate);
    } else {
      source.start();
    }
  } catch (e) {
    Con_DPrintf("Web Audio playback error: %s\n", e.message);
  }
}

/*
=================
SND_ChannelGain

Per-side channel gain. SND_PaintChannelFrom8/16 clamp leftvol and rightvol
to 255 independently before scaling the sample.
=================
*/
export function SND_ChannelGain(vol) {
  if (vol > 255) {
    vol = 255;
  }
  if (vol < 0) {
    vol = 0;
  }

  return vol / 255.0;
}

/*
=================
_updateWebAudioSpatial

Updates the per-side volumes of a playing sound from its current spatialization
=================
*/
function _updateWebAudioSpatial(chan) {
  if (!chan._leftGain) {
    return;
  }

  chan._leftGain.gain.value = SND_ChannelGain(chan.leftvol);
  chan._rightGain.gain.value = SND_ChannelGain(chan.rightvol);
}

/*
=================
_stopWebAudio

Stops and drops the Web Audio nodes of a channel
=================
*/
function _stopWebAudio(chan) {
  if (chan._audioSource) {
    try {
      chan._audioSource.stop();
    } catch { /* ignore */ }
  }

  chan._audioSource = null;
  chan._leftGain = null;
  chan._rightGain = null;
}

/*
================
S_GetAudioContext

Returns the Web Audio AudioContext for use by other modules (e.g. cd_audio)
================
*/
export function S_GetAudioContext() {
  return audioContext;
}

export function S_GetMasterGain() {
  return masterGain;
}
