// Ported from: WinQuake/cl_main.c -- client main loop

import { MAX_LIGHTSTYLES } from "./quakedef.js";
import {
  Con_DPrintf,
  Con_Printf,
  MSG_WriteByte,
  MSG_WriteString,
  SZ_Alloc,
  SZ_Clear,
} from "./common.js";
import {
  NET_CanSendMessage,
  NET_Close,
  NET_Connect,
  NET_SendMessage,
  NET_SendUnreliableMessage,
  NET_SetQuietConnect,
} from "./net_main.js";
import {
  CLR_Cancel,
  CLR_CanReconnect,
  CLR_Connected,
  CLR_ConnectionLost,
  CLR_Init,
} from "./cl_reconnect.js";
import {
  Cvar_RegisterVariable,
  Cvar_RestoreServerChanges,
  cvar_t,
  Cvar_VariableValue,
} from "./cvar.js";
import { Cmd_AddCommand } from "./cmd.js";
import { Cbuf_InsertText } from "./cmd.js";
import { clc_disconnect, clc_stringcmd, PS_NOLERP } from "./protocol.js";
import {
  CL_GetMessage,
  CL_PlayDemo_f,
  CL_Record_f,
  CL_Stop_f,
  CL_StopPlayback,
  CL_TimeDemo_f,
} from "./cl_demo.js";
import { CL_ClearStuffText, CL_ParseServerMessage } from "./cl_parse.js";
import {
  beam_t,
  ca_connected,
  ca_dedicated,
  ca_disconnected,
  cl,
  cl_beams,
  cl_dlights,
  cl_efrags,
  CL_EnsureEntities,
  cl_entities,
  CL_INITIAL_ENTITIES,
  cl_lightstyle,
  cl_numvisedicts,
  cl_temp_entities,
  cl_visedicts,
  cls,
  dlight_t,
  entity_t,
  lightstyle_t,
  MAX_BEAMS,
  MAX_DEMOS,
  MAX_DLIGHTS,
  MAX_EFRAGS,
  MAX_TEMP_ENTITIES,
  MAX_VISEDICTS,
  NUM_CSHIFTS,
  set_cl_numvisedicts,
  SIGNONS,
  usercmd_t,
} from "./client.js";
import { anglemod, AngleVectors, VectorCopy, VectorMA } from "./mathlib.js";
import {
  LERP_MOVESTEP,
  LERP_RESETANIM,
  LERP_RESETANIM2,
  LERP_RESETMOVE,
  R_EntityParticles,
  r_lerpmodels,
  r_lerpmove,
  R_RemoveEfrags,
  R_RocketTrail,
} from "./render.js";
import { CL_InitTEnts, CL_UpdateTEnts } from "./cl_tent.js";
import {
  Host_ClearMemory,
  Host_Error,
  host_frametime,
  host_netinterval,
  Host_ShutdownServer,
  realtime,
  sv,
} from "./host.js";
import {
  SCR_BeginLoadingPlaque,
  SCR_CenterPrint,
  SCR_EndLoadingPlaque,
} from "./gl_screen.js";
import { R_WarmupCancel, R_WarmupWhenReady } from "./gl_warmup.js";
import { S_StopAllSounds } from "./snd_dma.js";
import { M_ConnectionError, M_ShouldReturnOnError } from "./menu.js";
import { key_menu, set_key_dest } from "./keys.js";
import { V_ResetEffects, V_ResetPunchAngles, V_UsePrediction } from "./view.js";
import { Sys_PageURL } from "./sys.js";
import {
  CL_GetEntityFrame,
  CL_GetPredictedPlayer,
  CL_GetServerSequence,
  CL_GetValidSequence,
  CL_InitPrediction,
  cl_nopred,
  CL_PredictMove,
  CL_ResetPrediction,
  CL_SetUpPlayerPrediction,
  cl_simangles,
  cl_simorg,
  cl_simvel,
  set_cl_simonground,
} from "./cl_pred.js";

// Re-export prediction state for view.js to use
export { cl_nopred, cl_simangles, cl_simorg, cl_simvel };

// we need to declare some mouse variables here, because the menu system
// references them even when on a unix system.

// these two are not intended to be set directly
export const cl_name = new cvar_t("_cl_name", "player", true);
export const cl_color = new cvar_t("_cl_color", "0", true);

export const cl_shownet = new cvar_t("cl_shownet", "0"); // can be 0, 1, or 2
export const cl_nolerp = new cvar_t("cl_nolerp", "0");

export const lookspring = new cvar_t("lookspring", "0", true);
export const lookstrafe = new cvar_t("lookstrafe", "0", true);
export const sensitivity = new cvar_t("sensitivity", "3", true);

export const m_pitch = new cvar_t("m_pitch", "0.022", true);
export const m_yaw = new cvar_t("m_yaw", "0.022", true);
export const m_forward = new cvar_t("m_forward", "1", true);
export const m_side = new cvar_t("m_side", "0.8", true);

export function CL_ClearState() {
  if (sv.active === false) {
    Host_ClearMemory();
  }

  // Reset client-side prediction state
  CL_ResetPrediction();
  _peCurSeq = 0;
  _pePrevSeq = 0;

  // wipe the entire cl structure
  // In JS we reset the fields instead of memset
  cl.movemessages = 0;
  CL_ClearStuffText(); // cl.stuffcmdbuf (QuakeSpasm/Ironwail)
  cl.cmd = new usercmd_t();
  cl.stats.fill(0);
  cl.items = 0;
  cl.item_gettime.fill(0);
  cl.faceanimtime = 0;

  for (let i = 0; i < NUM_CSHIFTS; i++) {
    cl.cshifts[i].destcolor[0] = 0;
    cl.cshifts[i].destcolor[1] = 0;
    cl.cshifts[i].destcolor[2] = 0;
    cl.cshifts[i].percent = 0;
    cl.prev_cshifts[i].destcolor[0] = 0;
    cl.prev_cshifts[i].destcolor[1] = 0;
    cl.prev_cshifts[i].destcolor[2] = 0;
    cl.prev_cshifts[i].percent = 0;
  }

  cl.mviewangles[0].fill(0);
  cl.mviewangles[1].fill(0);
  cl.viewangles.fill(0);
  cl.setangles.fill(0);
  cl.mvelocity[0].fill(0);
  cl.mvelocity[1].fill(0);
  cl.velocity.fill(0);
  cl.punchangle.fill(0);
  V_ResetPunchAngles(); //johnfitz -- v_punchangles
  cl.idealpitch = 0;
  cl.pitchvel = 0;
  cl.nodrift = false;
  cl.driftmove = 0;
  cl.laststop = 0;
  cl.viewheight = 0;
  cl.crouch = 0;
  cl.paused = false;
  cl.onground = false;
  cl.inwater = false;
  cl.intermission = 0;
  cl.completed_time = 0;
  cl.mtime[0] = 0;
  cl.mtime[1] = 0;
  cl.time = 0;
  cl.oldtime = 0;
  cl.last_received_message = 0;
  cl.model_precache.fill(null);
  cl.sound_precache.fill(null);
  cl.levelname = "";
  cl.viewentity = 0;
  cl.maxclients = 0;
  cl.gametype = 0;
  cl.protocol = 0;
  cl.worldmodel = null;
  cl.free_efrags = null;
  cl.num_entities = 0;
  cl.num_statics = 0;
  cl.viewent = new entity_t();
  cl.cdtrack = 0;
  cl.looptrack = 0;
  cl.scores = null;

  SZ_Clear(cls.message);

  // clear other arrays
  for (let i = 0; i < MAX_EFRAGS; i++) {
    cl_efrags[i].leaf = null;
    cl_efrags[i].leafnext = null;
    cl_efrags[i].entity = null;
    cl_efrags[i].entnext = null;
  }

  // C clears all MAX_EDICTS; here the array drops back to its initial size
  // and grows again on demand (client.js CL_EnsureEntities)
  cl_entities.length = 0;
  CL_EnsureEntities(CL_INITIAL_ENTITIES);

  for (let i = 0; i < MAX_DLIGHTS; i++) {
    cl_dlights[i] = new dlight_t();
  }

  for (let i = 0; i < MAX_LIGHTSTYLES; i++) {
    cl_lightstyle[i] = new lightstyle_t();
  }

  for (let i = 0; i < MAX_TEMP_ENTITIES; i++) {
    cl_temp_entities[i] = new entity_t();
  }

  for (let i = 0; i < MAX_BEAMS; i++) {
    cl_beams[i] = new beam_t();
  }

  // allocate the efrags and chain together into a free list
  cl.free_efrags = cl_efrags[0];
  for (let i = 0; i < MAX_EFRAGS - 1; i++) {
    cl_efrags[i].entnext = cl_efrags[i + 1];
  }
  cl_efrags[MAX_EFRAGS - 1].entnext = null;
}

/**
 * Sends a disconnect message to the server
 * This is also called on Host_Error, so it shouldn't cause any errors
 */
export function CL_Disconnect() {
  R_WarmupCancel(); // web-only: no held plaque callback outlives the connection
  Cvar_RestoreServerChanges(); // web-only: a remote server's cvars don't stay

  // Deviation (web-only, no C equivalent; see cl_reconnect.js): tell a lost
  // connection (the transport died, NET_GetMessage/NET_Send* flagged the
  // socket) from a deliberate disconnect. A lost one is retried; anything
  // else (the disconnect command, a kick, a new connect, Host_Error on a live
  // connection) forgets the session so nothing reconnects behind the player.
  const lost = cls.state === ca_connected && cls.demoplayback === false &&
    cls.netcon != null && cls.netcon.lost === true;
  const wasConnected = cls.state === ca_connected;

  // stop sounds (especially looping!)
  S_StopAllSounds(true);

  // bring the console down and fade the colors back to normal
  // SCR_BringDownConsole();

  // if running a local server, shut it down
  if (cls.demoplayback) {
    CL_StopPlayback();
  } else if (cls.state === ca_connected) {
    if (cls.demorecording) {
      CL_Stop_f();
    }

    Con_DPrintf("Sending clc_disconnect\n");
    SZ_Clear(cls.message);
    MSG_WriteByte(cls.message, clc_disconnect);
    NET_SendUnreliableMessage(cls.netcon, cls.message);
    SZ_Clear(cls.message);

    if (cls.netcon != null) {
      NET_Close(cls.netcon);
      cls.netcon = null;
    }

    cls.state = ca_disconnected;
    if (sv.active) {
      Host_ShutdownServer(false);
    }
  }

  if (lost === true) {
    // Host_Error, which a lost connection used to reach, did this: a drop
    // during a map change would otherwise hide the retries behind the
    // loading plaque
    SCR_EndLoadingPlaque();
    CLR_ConnectionLost();
  } else if (wasConnected === true) {
    CLR_Cancel();
  }

  cls.demoplayback = cls.timedemo = false;
  cls.signon = 0;
  // Deliberate deviation, from QuakeSpasm/Ironwail (cl_main.c
  // CL_Disconnect): drop the intermission and the colour shifts, so the
  // console and menu aren't drawn under a stale intermission or tint.
  cl.intermission = 0;
  V_ResetEffects();
}

export function CL_Disconnect_f() {
  CL_Disconnect();
  CLR_Cancel(); // web-only: also covers a retry waiting after a lost connection
  if (sv.active) {
    Host_ShutdownServer(false);
  }

  // Clear room from browser URL on explicit disconnect
  if (
    typeof window !== "undefined" && window.location.search.includes("room=")
  ) {
    history.replaceState(null, "", Sys_PageURL(null));
  }
}

// CL_EstablishConnection
//
// Host should be either "local" or a net address to be passed on
// For remote connections, this handles async WebTransport connections.
let cl_connect_id = 0; // web-only: generation of the latest CL_EstablishConnection

export async function CL_EstablishConnection(host, quiet = false) {
  if (cls.state === ca_dedicated) {
    return false;
  }

  if (cls.demoplayback) {
    return false;
  }

  CL_Disconnect();

  // Web-only: a connect the player asked for replaces any reconnect in
  // progress. quiet is the reconnect's own retry (cl_reconnect.js): the
  // drivers and this function then skip the menu pages shown on failure.
  if (quiet === false) {
    CLR_Cancel();
  }
  const connect_id = ++cl_connect_id;
  NET_SetQuietConnect(quiet);

  // Clear room from browser URL when connecting to single player (local)
  if (
    host === "local" && typeof window !== "undefined" &&
    window.location.search.includes("room=")
  ) {
    history.replaceState(null, "", Sys_PageURL(null));
  }

  let connected_sock = null;

  try {
    // NET_Connect may return a Promise for async connections (WebTransport)
    const result = NET_Connect(host);
    if (result instanceof Promise) {
      // Async connection (WebTransport) with timeout
      Con_Printf("Connecting to %s...\n", host);

      // 60-second timeout for connection attempts: the drivers' own timeouts
      // are 25 s each, and a WebTransport that can't open is retried over
      // WebSocket (NET_WebSocketFallback), so both must fit.
      const CONNECTION_TIMEOUT_MS = 60000;
      let timer = null;
      let timedOut = false;
      const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new Error("Connection timed out after 60 seconds"));
        }, CONNECTION_TIMEOUT_MS);
      });

      // Web-only: a driver connect that finishes after the timeout gave up
      // on it would leave an open socket nobody reads; close it
      result.then((sock) => {
        if (timedOut === true && sock != null) NET_Close(sock);
      }, () => {});

      try {
        connected_sock = await Promise.race([result, timeoutPromise]);
      } finally {
        clearTimeout(timer);
      }
    } else {
      // Sync connection (loopback)
      connected_sock = result;
    }
  } catch (error) {
    NET_SetQuietConnect(false);

    // Connection failed with error
    Con_Printf("CL_Connect: %s\n", error.message || "connection failed");

    if (quiet === true) {
      return false;
    }

    // Return to menu if we should
    if (M_ShouldReturnOnError()) {
      M_ConnectionError(error.message || "Connection failed");
      set_key_dest(key_menu);
    }

    return false;
  }

  // Web-only: a newer connect started while this one waited; drop this one
  if (connect_id !== cl_connect_id) {
    if (connected_sock != null) NET_Close(connected_sock);
    return false;
  }

  cls.netcon = connected_sock;

  NET_SetQuietConnect(false);

  if (!cls.netcon) {
    Con_Printf("CL_Connect: connect failed\n");

    if (quiet === true) {
      return false;
    }

    // Return to menu if we should
    if (M_ShouldReturnOnError()) {
      M_ConnectionError("Connection refused");
      set_key_dest(key_menu);
    }

    return false;
  }

  Con_DPrintf("CL_EstablishConnection: connected to %s\n", host);

  // Update browser URL with room ID for sharing
  if (typeof window !== "undefined" && host.includes("?room=")) {
    try {
      const url = new URL(host);
      const roomId = url.searchParams.get("room");
      if (roomId) {
        history.replaceState(null, "", Sys_PageURL(roomId));
      }
    } catch {
      // Ignore URL parsing errors
    }
  }

  cls.demonum = -1; // not in the demo loop now
  cls.state = ca_connected;
  cls.signon = 0; // need all the signon messages before playing

  // Web-only: remember the address for cl_reconnect.js (remote servers only)
  CLR_Connected(host);
  return true;
}

/** An svc_signonnum has been received, perform a client side setup */
export function CL_SignonReply() {
  Con_DPrintf("CL_SignonReply: %i\n", cls.signon);

  switch (cls.signon) {
    case 1:
      MSG_WriteByte(cls.message, clc_stringcmd);
      MSG_WriteString(cls.message, "prespawn");
      break;

    case 2:
      MSG_WriteByte(cls.message, clc_stringcmd);
      MSG_WriteString(cls.message, 'name "' + cl_name.string + '"\n');

      MSG_WriteByte(cls.message, clc_stringcmd);
      MSG_WriteString(
        cls.message,
        "color " + ((cl_color.value | 0) >> 4) + " " +
          ((cl_color.value | 0) & 15) + "\n",
      );

      MSG_WriteByte(cls.message, clc_stringcmd);
      MSG_WriteString(cls.message, "spawn " + cls.spawnparms);
      break;

    case 3:
      MSG_WriteByte(cls.message, clc_stringcmd);
      MSG_WriteString(cls.message, "begin");
      // Cache_Report();  // print remaining memory
      break;

    case 4:
      // web-only: wait (briefly) for the level's shaders to compile
      R_WarmupWhenReady(SCR_EndLoadingPlaque); // allow normal screen updates
      break;
  }
}

/** Called to play the next demo in the demo loop */
export function CL_NextDemo() {
  if (cls.demonum === -1) {
    return; // don't play demos
  }

  SCR_BeginLoadingPlaque();

  if (!cls.demos[cls.demonum] || cls.demonum === MAX_DEMOS) {
    cls.demonum = 0;
    if (!cls.demos[cls.demonum]) {
      Con_Printf("No demos listed with startdemos\n");
      cls.demonum = -1;
      return;
    }
  }

  Cbuf_InsertText("playdemo " + cls.demos[cls.demonum] + "\n");
  cls.demonum++;
}

function CL_PrintEntities_f() {
  for (let i = 0; i < cl.num_entities; i++) {
    const ent = cl_entities[i];
    Con_Printf("%3i:", i);
    if (!ent.model) {
      Con_Printf("EMPTY\n");
      continue;
    }

    Con_Printf(
      "%s:%2i  (%5.1f,%5.1f,%5.1f) [%5.1f %5.1f %5.1f]\n",
      ent.model.name,
      ent.frame,
      ent.origin[0],
      ent.origin[1],
      ent.origin[2],
      ent.angles[0],
      ent.angles[1],
      ent.angles[2],
    );
  }
}

export function CL_AllocDlight(key) {
  // first look for an exact key match
  if (key) {
    for (let i = 0; i < MAX_DLIGHTS; i++) {
      if (cl_dlights[i].key === key) {
        const dl = cl_dlights[i];
        dl.origin.fill(0);
        dl.radius = 0;
        dl.die = 0;
        dl.decay = 0;
        dl.minlight = 0;
        dl.key = key;
        dl.color.fill(1); //johnfitz -- lit support via lordhavoc
        return dl;
      }
    }
  }

  // then look for anything else
  for (let i = 0; i < MAX_DLIGHTS; i++) {
    if (cl_dlights[i].die < cl.time) {
      const dl = cl_dlights[i];
      dl.origin.fill(0);
      dl.radius = 0;
      dl.die = 0;
      dl.decay = 0;
      dl.minlight = 0;
      dl.key = key;
      dl.color.fill(1); //johnfitz -- lit support via lordhavoc
      return dl;
    }
  }

  const dl = cl_dlights[0];
  dl.origin.fill(0);
  dl.radius = 0;
  dl.die = 0;
  dl.decay = 0;
  dl.minlight = 0;
  dl.key = key;
  dl.color.fill(1); //johnfitz -- lit support via lordhavoc
  return dl;
}

/**
 * The 2021 rerelease's coloured powerup glows, from Ironwail's
 * CL_RelinkEntities (cl_main.c), shared by the three places this port links
 * entities. The server sends these bits only for a progs that defines them
 * (PR_FindSupportedEffects). EF_QEX_CANDLELIGHT gets no light, as in Ironwail.
 */
export function CL_QexEffectLights(effects, key, origin) {
  if (effects & 0x0010) { // EF_QEX_QUADLIGHT
    const dl = CL_AllocDlight(key);
    VectorCopy(origin, dl.origin);
    dl.radius = 200 + (Math.random() * 32 | 0);
    dl.die = cl.time + 0.001;
    dl.color[0] = 0.25;
    dl.color[1] = 0.25;
    dl.color[2] = 1.0;
  }

  if (effects & 0x0020) { // EF_QEX_PENTALIGHT
    const dl = CL_AllocDlight(key);
    VectorCopy(origin, dl.origin);
    dl.radius = 200 + (Math.random() * 32 | 0);
    dl.die = cl.time + 0.001;
    dl.color[0] = 1.0;
    dl.color[1] = 0.25;
    dl.color[2] = 0.25;
  }
}

export function CL_DecayLights() {
  const time = cl.time - cl.oldtime;

  for (let i = 0; i < MAX_DLIGHTS; i++) {
    const dl = cl_dlights[i];
    if (dl.die < cl.time || dl.radius <= 0) {
      continue;
    }

    dl.radius -= time * dl.decay;
    if (dl.radius < 0) {
      dl.radius = 0;
    }
  }
}

/**
 * Determines the fraction between the last two messages that the objects
 * should be put at.
 */
export function CL_LerpPoint() {
  let f = cl.mtime[0] - cl.mtime[1];

  // QuakeSpasm/Ironwail: a local server's entities lerp too while
  // renderer/network isolation draws frames between its ticks
  if (
    f === 0 || cl_nolerp.value !== 0 || cls.timedemo ||
    (sv.active && host_netinterval === 0)
  ) {
    cl.time = cl.mtime[0];
    return 1;
  }

  if (f > 0.1) {
    // dropped packet, or start of demo
    cl.mtime[1] = cl.mtime[0] - 0.1;
    f = 0.1;
  }

  let frac = (cl.time - cl.mtime[1]) / f;

  if (frac < 0) {
    if (frac < -0.01) {
      cl.time = cl.mtime[1];
    }

    frac = 0;
  } else if (frac > 1) {
    if (frac > 1.01) {
      cl.time = cl.mtime[0];
    }

    frac = 1;
  }

  return frac;
}

/**
 * QS cl_main.c CL_RelinkEntities (EF_MUZZLEFLASH): no lerping for two
 * frames, on the gun when it is the view entity's flash. Shared by the NQ
 * relink and the QW player and packet-entity paths.
 */
export function CL_NoLerpMuzzleFlash(num) {
  if (num === cl.viewentity) {
    cl.viewent.lerpflags |= LERP_RESETANIM | LERP_RESETANIM2; //no lerping for two frames
  } else {
    cl_entities[num].lerpflags |= LERP_RESETANIM | LERP_RESETANIM2; //no lerping for two frames
  }
}

// CL_LinkPacketEntities
//
// Links non-player entities from QW-style packet_entities into the
// visible entity list. Handles effects, dynamic lights, and particle trails.
// Ported from: QW/client/cl_ents.c

// Cached vectors for CL_LinkPacketEntities (avoid per-frame allocations)
const _peOldorg = new Float32Array(3);
const _peDelta = new Float32Array(3);
const _peFv = new Float32Array(3);
const _peRv = new Float32Array(3);
const _peUv = new Float32Array(3);

// Server sequence of the packet linked last, and of the one before it
let _peCurSeq = 0;
let _pePrevSeq = 0;

function CL_LinkPacketEntities(frac) {
  const seq = CL_GetServerSequence();
  if (CL_GetValidSequence() === 0) {
    return;
  }

  const eframe = CL_GetEntityFrame(seq);
  if (eframe.invalid) {
    return;
  }

  const pack = eframe.packet_entities;
  const autorotate = anglemod(100 * cl.time);

  // remember which packet came before this one (for CL_LinkPacketEntities'
  // "was it in the last packet" check)
  if (seq !== _peCurSeq) {
    _pePrevSeq = _peCurSeq;
    _peCurSeq = seq;
  }

  for (let pnum = 0; pnum < pack.num_entities; pnum++) {
    const s1 = pack.entities[pnum];

    // if set to invisible, skip
    if (s1.modelindex === 0) {
      continue;
    }

    // spawn light flashes, even ones coming from invisible objects
    if (s1.effects & 0x0001) { // EF_BRIGHTFIELD
      // Need entity origin — use cl_entities entry which has previous frame's origin
      const bfEnt = cl_entities[s1.number];
      R_EntityParticles(bfEnt);
    }

    if (s1.effects & 0x0004) { // EF_BRIGHTLIGHT
      const dl = CL_AllocDlight(s1.number);
      dl.origin[0] = s1.origin[0];
      dl.origin[1] = s1.origin[1];
      dl.origin[2] = s1.origin[2] + 16;
      dl.radius = 400 + (Math.random() * 32 | 0);
      dl.die = cl.time + 0.001;
    }

    if (s1.effects & 0x0008) { // EF_DIMLIGHT
      const dl = CL_AllocDlight(s1.number);
      dl.origin[0] = s1.origin[0];
      dl.origin[1] = s1.origin[1];
      dl.origin[2] = s1.origin[2];
      dl.radius = 200 + (Math.random() * 32 | 0);
      dl.die = cl.time + 0.001;
    }

    if (s1.effects & 0x0002) { // EF_MUZZLEFLASH
      const dl = CL_AllocDlight(s1.number);
      dl.origin[0] = s1.origin[0];
      dl.origin[1] = s1.origin[1];
      dl.origin[2] = s1.origin[2] + 16;
      AngleVectors(s1.angles, _peFv, _peRv, _peUv);
      VectorMA(dl.origin, 18, _peFv, dl.origin);
      dl.radius = 200 + (Math.random() * 32 | 0);
      dl.minlight = 32;
      dl.die = cl.time + 0.1;

      //johnfitz -- assume muzzle flash accompanied by muzzle flare, which looks bad when lerped
      if (r_lerpmodels.value !== 2) {
        CL_NoLerpMuzzleFlash(s1.number);
      }
    }

    // after the muzzle flash, which would take the slot (Ironwail's order)
    CL_QexEffectLights(s1.effects, s1.number, s1.origin);

    // create a new entity
    if (cl_numvisedicts >= MAX_VISEDICTS) {
      break; // object list is full
    }

    // Use the cl_entities entry directly for rendering (it has the Three.js mesh cache)
    const ent = cl_entities[s1.number];

    // Update entity fields from packet entity state
    const model = cl.model_precache[s1.modelindex];

    if (model !== ent.model) {
      ent.model = model;
      if (model != null) {
        if (model.synctype === 1) { // ST_RAND
          ent.syncbase = (Math.random() * 0x7fff | 0) / 0x7fff;
        } else {
          ent.syncbase = 0.0;
        }
      }

      // No LERP_RESETANIM here (QS sets it at a model change): the
      // loop in CL_RelinkEntities clears ent.model whenever a packet
      // arrives, so this runs for every packet. gl_mesh.js
      // R_SetupAliasFrame resets the lerp when the model really changes.
    }

    ent.frame = s1.frame;
    ent.skinnum = s1.skin;
    ent.effects = s1.effects;
    ent.alpha = s1.alpha; //johnfitz -- alpha

    // set colormap
    if (s1.colormap === 0) {
      ent.colormap = null;
    } else if (
      s1.colormap > 0 && s1.colormap <= cl.maxclients && cl.scores != null
    ) {
      ent.colormap = cl.scores[s1.colormap - 1].translations;
    }

    // Save previous origin for trails
    VectorCopy(ent.origin, _peOldorg);

    // Interpolation: track per-entity server positions using msg_origins
    // similar to the NQ-style entity interpolation in CL_RelinkEntities.
    // Update msg_origins only when new server data arrives (sequence changed).
    //
    // An entity that was not in the previous packet has nothing to lerp
    // from (cl_parse.c CL_ParseUpdate: ent->msgtime != cl.mtime[1] means
    // forcelink), so snap it: this covers slots re-entering the PVS and
    // slots reused by a new entity.
    if (
      ent._lastPESeq !== seq &&
      (ent._lastPESeq === 0 || ent._lastPESeq !== _pePrevSeq)
    ) {
      // First appearance or absent from the previous packet — snap to current
      VectorCopy(s1.origin, ent.msg_origins[0]);
      VectorCopy(s1.origin, ent.msg_origins[1]);
      VectorCopy(s1.angles, ent.msg_angles[0]);
      VectorCopy(s1.angles, ent.msg_angles[1]);
      ent._lastPESeq = seq;

      // no trail from the stale position either
      VectorCopy(s1.origin, _peOldorg);

      // nor a lerp (QS cl_main.c CL_RelinkEntities: an entity that
      // leaves the packet gets LERP_RESETMOVE|LERP_RESETANIM)
      ent.lerpflags |= LERP_RESETMOVE | LERP_RESETANIM;
    } else if (ent._lastPESeq !== seq) {
      // QS cl_parse.c CL_ParseUpdate: more than 0.2 seconds since the
      // last update (most entities think every 0.1 sec), so a lerp
      // would start from the wrong frame. ent.msgtime is the time of
      // the last packet this entity was linked from.
      if (ent.msgtime + 0.2 < cl.mtime[0]) {
        ent.lerpflags |= LERP_RESETANIM;
      }

      // New server data — shift old position and store new
      VectorCopy(ent.msg_origins[0], ent.msg_origins[1]);
      VectorCopy(s1.origin, ent.msg_origins[0]);
      VectorCopy(ent.msg_angles[0], ent.msg_angles[1]);
      VectorCopy(s1.angles, ent.msg_angles[0]);
      ent._lastPESeq = seq;
    }

    // MOVETYPE_STEP monsters snap to each update, as NQ's U_NOLERP
    // (cl_parse.c sets forcelink) does: "don't mess up the step animation".
    // r_lerpmove then slides them there (QS's U_STEP sets LERP_MOVESTEP).
    let lerp = frac;
    if ((s1.solid & PS_NOLERP) !== 0) {
      lerp = 1;
      ent.lerpflags |= LERP_MOVESTEP;
    } else {
      ent.lerpflags &= ~LERP_MOVESTEP;
    }

    // rotate binary objects locally
    if (model != null && (model.flags & 0x0008)) { // EF_ROTATE
      ent.angles[0] = 0;
      ent.angles[1] = autorotate;
      ent.angles[2] = 0;
    } else {
      // Interpolate angles with short-path wrapping
      const f = lerp;
      for (let i = 0; i < 3; i++) {
        let d = ent.msg_angles[0][i] - ent.msg_angles[1][i];
        if (d > 180) {
          d -= 360;
        } else if (d < -180) {
          d += 360;
        }
        ent.angles[i] = ent.msg_angles[1][i] + f * d;
      }
    }

    // Interpolate origin with teleport detection
    {
      let f = lerp;
      for (let i = 0; i < 3; i++) {
        _peDelta[i] = ent.msg_origins[0][i] - ent.msg_origins[1][i];
        if (_peDelta[i] > 100 || _peDelta[i] < -100) {
          f = 1; // assume a teleportation, not a motion
          ent.lerpflags |= LERP_RESETMOVE; //johnfitz -- don't lerp teleports
        }
      }

      for (let i = 0; i < 3; i++) {
        ent.origin[i] = ent.msg_origins[1][i] + f * _peDelta[i];
      }
    }

    // Mark as updated this frame
    ent.msgtime = cl.mtime[0];

    // particle trails
    if (model != null && model.flags !== 0) {
      // Check for large position delta (teleport)
      let skipTrail = false;
      for (let i = 0; i < 3; i++) {
        if (Math.abs(_peOldorg[i] - ent.origin[i]) > 128) {
          VectorCopy(ent.origin, _peOldorg);
          skipTrail = true;
          break;
        }
      }

      if (!skipTrail) {
        if (model.flags & 0x01) { // EF_ROCKET
          R_RocketTrail(_peOldorg, ent.origin, 0);
          const dl = CL_AllocDlight(s1.number);
          VectorCopy(ent.origin, dl.origin);
          dl.radius = 200;
          dl.die = cl.time + 0.01;
        } else if (model.flags & 0x02) { // EF_GRENADE
          R_RocketTrail(_peOldorg, ent.origin, 1);
        } else if (model.flags & 0x04) { // EF_GIB
          R_RocketTrail(_peOldorg, ent.origin, 2);
        } else if (model.flags & 0x10) { // EF_TRACER
          R_RocketTrail(_peOldorg, ent.origin, 3);
        } else if (model.flags & 0x20) { // EF_ZOMGIB
          R_RocketTrail(_peOldorg, ent.origin, 4);
        } else if (model.flags & 0x40) { // EF_TRACER2
          R_RocketTrail(_peOldorg, ent.origin, 5);
        } else if (model.flags & 0x80) { // EF_TRACER3
          R_RocketTrail(_peOldorg, ent.origin, 6);
        }
      }
    }

    ent.forcelink = false;

    cl_visedicts[cl_numvisedicts] = ent;
    set_cl_numvisedicts(cl_numvisedicts + 1);
  }
}

// CL_LinkPlayers
//
// Create visible entities in the correct position
// for all current players. Ported from QW cl_ents.c.

// Cached vectors for CL_LinkPlayers (avoid per-frame allocations)
const _lpAngles = new Float32Array(3);
const _lpFv = new Float32Array(3);
const _lpRv = new Float32Array(3);
const _lpUv = new Float32Array(3);

/**
 * WinQuake/Ironwail CL_RelinkEntities lerp the view entity like any other
 * (this port's local server and demos send players in svc_playerinfo, so it
 * is done here): with a local server under renderer/network isolation, or in
 * a demo, frames drawn between two messages move the camera between their
 * origins. A local server's frac is 1 in WinQuake's single loop, which leaves
 * the newest server origin. A move over 100 units on an axis is a teleport,
 * as in CL_RelinkEntities.
 */
function CL_LerpViewOrigin(ent, frac) {
  let f = frac;
  for (let j = 0; j < 3; j++) {
    const d = ent.msg_origins[0][j] - ent.msg_origins[1][j];
    if (d > 100 || d < -100) f = 1;
  }
  for (let j = 0; j < 3; j++) {
    ent.origin[j] = ent.msg_origins[1][j] +
      f * (ent.msg_origins[0][j] - ent.msg_origins[1][j]);
  }
}

function CL_LinkPlayers(frac) {
  const usePrediction = V_UsePrediction();
  const chase = Cvar_VariableValue("chase_active") !== 0;

  for (let j = 0; j < cl.maxclients; j++) {
    const isView = j + 1 === cl.viewentity;

    // Use the cl_entities entry for this player slot so Three.js mesh caching works
    const ent = cl_entities[j + 1];

    const pplayer = CL_GetPredictedPlayer(j);
    if (pplayer == null) {
      if (isView) {
        ent.model = null; // nothing for R_Mirror to draw
      }
      ent.lerpflags |= LERP_RESETMOVE | LERP_RESETANIM; //johnfitz -- reset the lerp when it comes back
      continue;
    }

    // CL_SetUpPlayerPrediction gives the local player cl_simorg, which is
    // only valid while CL_PredictMove runs. Otherwise (local server, demo
    // playback) CL_SetPlayerInfo has already put the server origin on the
    // view entity, which is what V_CalcRefdef uses too.
    if (isView && usePrediction === false) {
      CL_LerpViewOrigin(ent, frac);
    }
    const origin = (isView && usePrediction === false) ?
      ent.origin :
      pplayer.origin;

    // entity angles, as the NQ server sends them for players
    // (SV_ClientThink: pitch is 1/3 of the view pitch).
    // The local player's command is never sent back, so use the view angles.
    if (isView) {
      _lpAngles[0] = -cl.viewangles[0] / 3;
      _lpAngles[1] = cl.viewangles[1];
      _lpAngles[2] = 0;
    } else if (pplayer.cmd != null) {
      _lpAngles[0] = -pplayer.cmd.angles[0] / 3;
      _lpAngles[1] = pplayer.cmd.angles[1];
      _lpAngles[2] = 0;
    } else {
      VectorCopy(ent.angles, _lpAngles);
    }

    // spawn light flashes, even ones coming from invisible objects
    // (WinQuake cl_main.c CL_RelinkEntities, which does this for every
    // entity including cl.viewentity)
    if ((pplayer.effects & 0x0002) !== 0) { // EF_MUZZLEFLASH
      const dl = CL_AllocDlight(j + 1);
      VectorCopy(origin, dl.origin);
      dl.origin[2] += 16;
      AngleVectors(_lpAngles, _lpFv, _lpRv, _lpUv);
      VectorMA(dl.origin, 18, _lpFv, dl.origin);
      dl.radius = 200 + (Math.random() * 32 | 0);
      dl.minlight = 32;
      dl.die = cl.time + 0.1;

      //johnfitz -- assume muzzle flash accompanied by muzzle flare, which looks bad when lerped
      if (r_lerpmodels.value !== 2) {
        CL_NoLerpMuzzleFlash(j + 1);
      }
    }

    if ((pplayer.effects & 0x0004) !== 0) { // EF_BRIGHTLIGHT
      const dl = CL_AllocDlight(j + 1);
      dl.origin[0] = origin[0];
      dl.origin[1] = origin[1];
      dl.origin[2] = origin[2] + 16;
      dl.radius = 400 + (Math.random() * 32 | 0);
      dl.die = cl.time + 0.001;
    }

    if ((pplayer.effects & 0x0008) !== 0) { // EF_DIMLIGHT
      const dl = CL_AllocDlight(j + 1);
      dl.origin[0] = origin[0];
      dl.origin[1] = origin[1];
      dl.origin[2] = origin[2];
      dl.radius = 200 + (Math.random() * 32 | 0);
      dl.die = cl.time + 0.001;
    }

    CL_QexEffectLights(pplayer.effects, j + 1, origin);

    if (pplayer.modelindex <= 0) {
      if (isView) {
        ent.model = null;
      }
      ent.lerpflags |= LERP_RESETMOVE | LERP_RESETANIM; //johnfitz
      continue;
    }

    const model = cl.model_precache[pplayer.modelindex];
    if (model !== ent.model) {
      ent.lerpflags |= LERP_RESETANIM; //johnfitz -- don't lerp animation across model changes
    }
    ent.model = model;
    if (ent.model == null) {
      continue;
    }

    ent.skinnum = pplayer.skin;
    ent.frame = pplayer.frame;
    ent.effects = pplayer.effects;
    ent.alpha = pplayer.alpha; //johnfitz -- alpha (svc_playerinfo PF_ALPHA)

    // QW cl_ents.c: ent->colormap = info->translations
    // (NQ cl_parse.c: ent->colormap = cl.scores[i-1].translations)
    ent.colormap = cl.scores != null ? cl.scores[j].translations : null;

    // Set origin from predicted/server position. Unless it is drawn here
    // (chase camera), the view entity keeps the server origin that
    // CL_SetPlayerInfo gave it: V_CalcIntermissionRefdef and the beams in
    // cl_tent.js read it.
    if (origin !== ent.origin && (isView === false || chase)) {
      VectorCopy(origin, ent.origin);
    }

    // Set angles from movement command (like QW CL_LinkPlayers).
    // The view entity's angles are set by V_CalcRefdef, as in WinQuake.
    if (isView === false && pplayer.cmd != null) {
      VectorCopy(_lpAngles, ent.angles);
    }

    // Mark as updated
    ent.msgtime = cl.mtime[0];

    // the player object never gets added (the local player is the camera),
    // unless the chase camera is on (cl_main.c: i == cl.viewentity && !chase_active.value).
    // As in cl_main.c CL_RelinkEntities, the view entity is filled in
    // first: R_Mirror (gl_rmain.c) draws it in the reflection.
    if (isView && chase === false) {
      continue;
    }

    // object list is full. QW breaks here; continue so a view entity in
    // a later slot is still filled in for R_Mirror.
    if (cl_numvisedicts >= MAX_VISEDICTS) {
      continue;
    }

    cl_visedicts[cl_numvisedicts] = ent;
    set_cl_numvisedicts(cl_numvisedicts + 1);
  }
}

// Cached vectors for CL_RelinkEntities (avoid per-frame allocations)
const _relinkOldorg = new Float32Array(3);
const _relinkDelta = new Float32Array(3);
const _relinkFv = new Float32Array(3);
const _relinkRv = new Float32Array(3);
const _relinkUv = new Float32Array(3);

export function CL_RelinkEntities() {
  // determine partial update time
  const frac = CL_LerpPoint();

  set_cl_numvisedicts(0);

  // interpolate player info
  for (let i = 0; i < 3; i++) {
    cl.velocity[i] = cl.mvelocity[1][i] +
      frac * (cl.mvelocity[0][i] - cl.mvelocity[1][i]);
  }

  if (cls.demoplayback) {
    // interpolate the angles
    for (let j = 0; j < 3; j++) {
      let d = cl.mviewangles[0][j] - cl.mviewangles[1][j];
      if (d > 180) {
        d -= 360;
      } else if (d < -180) {
        d += 360;
      }
      cl.viewangles[j] = cl.mviewangles[1][j] + frac * d;
    }
  }

  const bobjrotate = anglemod(100 * cl.time);

  // When using QW-style delta compression, players are handled by
  // CL_LinkPlayers and non-players by CL_LinkPacketEntities.
  // When no valid packet entity data exists (original NetQuake demos and
  // servers), relink ALL entities using the NQ-style path. Demos recorded
  // by this port contain svc_packetentities/svc_playerinfo, so they use the
  // QW path during playback too (validsequence is reset by CL_ClearState).
  const usePacketEntities = CL_GetValidSequence() !== 0;

  if (usePacketEntities) {
    // QW path: predict player positions and add them to visedicts.
    // Don't extrapolate other players during demo playback: the demo
    // already holds every frame the server sent.
    CL_SetUpPlayerPrediction(cls.demoplayback === false);
    CL_LinkPlayers(frac);
  }

  // For QW path, skip player entity slots (they're handled above).
  // For NQ path, process all entities including players.
  const firstRelinkEntity = usePacketEntities ? cl.maxclients + 1 : 1;
  for (let i = firstRelinkEntity; i < cl.num_entities; i++) {
    const ent = cl_entities[i];
    if (ent.model == null) {
      // empty slot
      if (ent.forcelink) {
        R_RemoveEfrags(ent); // just became empty
      }

      continue;
    }

    // if the object wasn't included in the last packet, remove it
    if (ent.msgtime !== cl.mtime[0]) {
      ent.model = null;
      // johnfitz -- next time this entity slot is reused, the lerp
      // will need to be reset. Not on the QW path: there this runs for
      // every packet entity each time a packet arrives (msgtime is the
      // last packet's) and CL_LinkPacketEntities links it again, so it
      // would reset every lerp; that path resets its own.
      if (usePacketEntities === false) {
        ent.lerpflags |= LERP_RESETMOVE | LERP_RESETANIM;
      }
      continue;
    }

    VectorCopy(ent.origin, _relinkOldorg);
    let teleported = false;

    if (ent.forcelink) {
      // the entity was not updated in the last message
      // so move to the final spot
      VectorCopy(ent.msg_origins[0], ent.origin);
      VectorCopy(ent.msg_angles[0], ent.angles);
    } else {
      // if the delta is large, assume a teleport and don't lerp
      let f = frac;
      for (let j = 0; j < 3; j++) {
        _relinkDelta[j] = ent.msg_origins[0][j] - ent.msg_origins[1][j];
        if (_relinkDelta[j] > 100 || _relinkDelta[j] < -100) {
          f = 1; // assume a teleportation, not a motion
          teleported = true;
          ent.lerpflags |= LERP_RESETMOVE; //johnfitz -- don't lerp teleports
        }
      }

      //johnfitz -- don't cl_lerp entities that will be r_lerped
      if (r_lerpmove.value !== 0 && (ent.lerpflags & LERP_MOVESTEP) !== 0) {
        f = 1;
      }
      //johnfitz

      // interpolate the origin and angles
      for (let j = 0; j < 3; j++) {
        ent.origin[j] = ent.msg_origins[1][j] + f * _relinkDelta[j];

        let d = ent.msg_angles[0][j] - ent.msg_angles[1][j];
        if (d > 180) {
          d -= 360;
        } else if (d < -180) {
          d += 360;
        }
        ent.angles[j] = ent.msg_angles[1][j] + f * d;
      }
    }

    // rotate binary objects locally
    if (ent.model != null && (ent.model.flags & 0x0008)) { // EF_ROTATE
      ent.angles[1] = bobjrotate;
    }

    if (ent.effects & 0x0001) { // EF_BRIGHTFIELD
      R_EntityParticles(ent);
    }

    if (ent.effects & 0x0002) { // EF_MUZZLEFLASH
      const dl = CL_AllocDlight(i);
      VectorCopy(ent.origin, dl.origin);
      dl.origin[2] += 16;
      AngleVectors(ent.angles, _relinkFv, _relinkRv, _relinkUv);

      VectorMA(dl.origin, 18, _relinkFv, dl.origin);
      dl.radius = 200 + (Math.random() * 32 | 0);
      dl.minlight = 32;
      dl.die = cl.time + 0.1;

      //johnfitz -- assume muzzle flash accompanied by muzzle flare, which looks bad when lerped
      if (r_lerpmodels.value !== 2) {
        CL_NoLerpMuzzleFlash(i);
      }
    }

    if (ent.effects & 0x0004) { // EF_BRIGHTLIGHT
      const dl = CL_AllocDlight(i);
      VectorCopy(ent.origin, dl.origin);
      dl.origin[2] += 16;
      dl.radius = 400 + (Math.random() * 32 | 0);
      dl.die = cl.time + 0.001;
    }

    if (ent.effects & 0x0008) { // EF_DIMLIGHT
      const dl = CL_AllocDlight(i);
      VectorCopy(ent.origin, dl.origin);
      dl.radius = 200 + (Math.random() * 32 | 0);
      dl.die = cl.time + 0.001;
    }

    CL_QexEffectLights(ent.effects, i, ent.origin);

    // Deliberate deviation, from QuakeSpasm/Ironwail (cl_main.c
    // CL_RelinkEntities, LERP_RESETMOVE resets the trail): no trail from
    // the old spot after a teleport or a forcelink, which id drew as a
    // streak across the map.
    if (ent.forcelink || teleported) {
      VectorCopy(ent.origin, _relinkOldorg);
    }

    // Particle trails based on model flags
    // Ported from WinQuake/cl_main.c:587-606
    if (ent.model != null) {
      if (ent.model.flags & 0x04) { // EF_GIB
        R_RocketTrail(_relinkOldorg, ent.origin, 2);
      } else if (ent.model.flags & 0x20) { // EF_ZOMGIB
        R_RocketTrail(_relinkOldorg, ent.origin, 4);
      } else if (ent.model.flags & 0x10) { // EF_TRACER
        R_RocketTrail(_relinkOldorg, ent.origin, 3);
      } else if (ent.model.flags & 0x40) { // EF_TRACER2
        R_RocketTrail(_relinkOldorg, ent.origin, 5);
      } else if (ent.model.flags & 0x01) { // EF_ROCKET
        R_RocketTrail(_relinkOldorg, ent.origin, 0);
        const dl = CL_AllocDlight(i);
        VectorCopy(ent.origin, dl.origin);
        dl.radius = 200;
        dl.die = cl.time + 0.01;
      } else if (ent.model.flags & 0x02) { // EF_GRENADE
        R_RocketTrail(_relinkOldorg, ent.origin, 1);
      } else if (ent.model.flags & 0x80) { // EF_TRACER3
        R_RocketTrail(_relinkOldorg, ent.origin, 6);
      }
    }

    ent.forcelink = false;

    if (i === cl.viewentity && Cvar_VariableValue("chase_active") === 0) {
      continue;
    }

    if (cl_numvisedicts < MAX_VISEDICTS) {
      cl_visedicts[cl_numvisedicts] = ent;
      set_cl_numvisedicts(cl_numvisedicts + 1);
    }
  }

  // Link non-player entities from QW-style packet_entities
  if (usePacketEntities) {
    CL_LinkPacketEntities(frac);
  }
}

/** Read all incoming data from the server */
export function CL_ReadFromServer() {
  cl.oldtime = cl.time;
  cl.time += host_frametime;

  let ret;
  do {
    ret = CL_GetMessage();

    if (ret === -1) {
      // Deviation (web-only, see cl_reconnect.js): a connection lost to a
      // remote server (iOS froze the page, Wi-Fi to cellular) is retried
      // instead of ending in Host_Error. CL_Disconnect starts the retries.
      if (
        cls.netcon != null && cls.netcon.lost === true && !sv.active &&
        !cls.demoplayback && CLR_CanReconnect() === true
      ) {
        CL_Disconnect();
        return;
      }

      Host_Error("CL_ReadFromServer: lost server connection");
    }

    if (!ret) {
      break;
    }

    cl.last_received_message = realtime;
    CL_ParseServerMessage();
  } while (ret && cls.state === ca_connected);

  if (cl_shownet.value) {
    Con_Printf("\n");
  }

  CL_RelinkEntities();
  CL_UpdateTEnts();

  // Client-side prediction (QuakeWorld style)
  // Predicts local player position for responsive movement with low server tick rates
  // Skip during demo playback: the commands CL_SendMove stores then are
  // the viewer's own input, never sent or acknowledged, and the demo's
  // playerinfo already places the recorded player every frame.
  if (!sv.active && !cls.demoplayback) {
    CL_PredictMove();
  } else {
    // When prediction is not running, copy NQ velocity to cl_simvel
    // so V_CalcBob and V_CalcRoll still work for weapon view bobbing
    VectorCopy(cl.velocity, cl_simvel);
    set_cl_simonground(cl.onground ? 0 : -1);
  }

  return 0;
}

export function CL_SendCmd() {
  if (cls.state !== ca_connected) {
    return;
  }

  if (cls.signon === SIGNONS) {
    // get basic movement from keyboard
    const cmd = new usercmd_t();
    CL_BaseMove(cmd);

    // allow mice or other external controllers to add to the move
    IN_Move(cmd);

    // send the unreliable message
    CL_SendMove(cmd);
  }

  if (cls.demoplayback) {
    SZ_Clear(cls.message);
    return;
  }

  // send the reliable message
  if (!cls.message.cursize) {
    return; // no message at all
  }

  if (!NET_CanSendMessage(cls.netcon)) {
    Con_DPrintf("CL_WriteToServer: can't send\n");
    return;
  }

  if (NET_SendMessage(cls.netcon, cls.message) === -1) {
    Host_Error("CL_WriteToServer: lost server connection");
  }

  SZ_Clear(cls.message);
}

export function CL_Init() {
  SZ_Alloc(cls.message, 1024);

  // Web-only: reconnect after a lost connection (cl_reconnect.js)
  CLR_Init({
    connect: async (host) => {
      const ok = await CL_EstablishConnection(host, true);
      if (ok === true) {
        SCR_BeginLoadingPlaque(); // as Host_Reconnect_f does after a connect
      }
      return ok;
    },
    canReconnect: () =>
      !sv.active && !cls.demoplayback && cls.state !== ca_dedicated,
    isHidden: () =>
      typeof document !== "undefined" && document.visibilityState === "hidden",
    print: (str) => Con_Printf("%s", str),
    notify: (str) => SCR_CenterPrint(str),
    giveUp: (reason) => {
      Con_Printf("%s\n", reason);
      M_ConnectionError(reason);
      set_key_dest(key_menu);
    },
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (id) => clearTimeout(id),
  });

  CL_InitInput();
  CL_InitTEnts();
  CL_InitPrediction();

  // register our commands
  Cvar_RegisterVariable(cl_name);
  Cvar_RegisterVariable(cl_color);
  Cvar_RegisterVariable(cl_upspeed);
  Cvar_RegisterVariable(cl_forwardspeed);
  Cvar_RegisterVariable(cl_backspeed);
  Cvar_RegisterVariable(cl_sidespeed);
  Cvar_RegisterVariable(cl_movespeedkey);
  Cvar_RegisterVariable(cl_yawspeed);
  Cvar_RegisterVariable(cl_pitchspeed);
  Cvar_RegisterVariable(cl_anglespeedkey);
  Cvar_RegisterVariable(cl_alwaysrun); // QuakeSpasm
  Cvar_RegisterVariable(cl_shownet);
  Cvar_RegisterVariable(cl_nolerp);
  Cvar_RegisterVariable(lookspring);
  Cvar_RegisterVariable(lookstrafe);
  Cvar_RegisterVariable(sensitivity);

  Cvar_RegisterVariable(m_pitch);
  Cvar_RegisterVariable(m_yaw);
  Cvar_RegisterVariable(m_forward);
  Cvar_RegisterVariable(m_side);

  Cmd_AddCommand("entities", CL_PrintEntities_f);
  Cmd_AddCommand("disconnect", CL_Disconnect_f);
  Cmd_AddCommand("record", CL_Record_f);
  Cmd_AddCommand("stop", CL_Stop_f);
  Cmd_AddCommand("playdemo", CL_PlayDemo_f);
  Cmd_AddCommand("timedemo", CL_TimeDemo_f);
}

// These are imported from cl_input.js -- declared as stubs for now
// to avoid circular dependency issues. They will be replaced when cl_input.js is loaded.
function CL_InitInput() {
  CL_InitInput_impl();
}

// CL_InitTEnts: imported from cl_tent.js

// CL_StopPlayback and CL_Stop_f: imported from cl_demo.js

// Forward declarations for cvars and functions defined in cl_input.js
import {
  cl_alwaysrun,
  cl_anglespeedkey,
  cl_backspeed,
  CL_BaseMove,
  cl_forwardspeed,
  CL_InitInput as CL_InitInput_impl,
  cl_movespeedkey,
  cl_pitchspeed,
  CL_SendMove,
  cl_sidespeed,
  cl_upspeed,
  cl_yawspeed,
} from "./cl_input.js";
import { IN_Move } from "./in_web.js";
