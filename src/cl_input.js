// Ported from: WinQuake/cl_input.c -- builds an intended movement command to send to the server

import { PITCH, ROLL, YAW } from "./quakedef.js";
import {
  Con_Printf,
  MSG_WriteAngle16,
  MSG_WriteByte,
  MSG_WriteFloat,
  MSG_WriteShort,
  Q_atoi,
} from "./common.js";
import { Cmd_AddCommand, Cmd_Argv } from "./cmd.js";
import { Cvar_RegisterVariable, cvar_t } from "./cvar.js";
import { clc_delta, clc_move, PE_UPDATE_BACKUP } from "./protocol.js";
import { ca_connected, cl, cls, kbutton_t, SIGNONS } from "./client.js";
import { anglemod } from "./mathlib.js";
import { host_frametime, host_netframetime, realtime } from "./host.js";
import { V_StartPitchDrift, V_StopPitchDrift } from "./view.js";
import { CL_Disconnect, lookspring, lookstrafe } from "./cl_main.js";
import { IN_Move } from "./in_web.js";
import { NET_SendUnreliableMessage } from "./net_main.js";
import {
  CL_GetServerSequence,
  CL_GetValidSequence,
  CL_StoreCommand,
} from "./cl_pred.js";
import { isXRActive, XR_GetAimAngles } from "./webxr.js";

// Pre-allocated array for XR aim angles (Golden Rule #4)
const _xrAimAngles = new Float32Array(3);

// Cached buffers for CL_SendMove (Golden Rule #4)
const _sendmove_data = new Uint8Array(128);
const _sendmove_buf = {
  maxsize: 128,
  cursize: 0,
  data: _sendmove_data,
  allowoverflow: false,
  overflowed: false,
};
const _sendmove_predAngles = new Float32Array(3);
const _sendmove_predCmd = {
  msec: 0,
  angles: _sendmove_predAngles,
  forwardmove: 0,
  sidemove: 0,
  upmove: 0,
  buttons: 0,
};

// Scratch command for CL_AccumulateCmd; its moves are thrown away
const _accumulate_cmd = {
  viewangles: new Float32Array(3),
  forwardmove: 0,
  sidemove: 0,
  upmove: 0,
};

// WebTransport game servers parse QuakeWorld-style clc_delta requests.
const USE_QW_COMMAND_EXTENSIONS = true;

/*
===============================================================================

KEY BUTTONS

Continuous button event tracking is complicated by the fact that two different
input sources (say, mouse button 1 and the control key) can both press the
same button, but the button should only be released when both of the
pressing key have been released.

When a key event issues a button command (+forward, +attack, etc), it appends
its key number as a parameter to the command so it can be matched up with
the release.

state bit 0 is the current state of the key
state bit 1 is edge triggered on the up to down transition
state bit 2 is edge triggered on the down to up transition

===============================================================================
*/

export const in_mlook = new kbutton_t();
export const in_klook = new kbutton_t();
export const in_left = new kbutton_t();
export const in_right = new kbutton_t();
export const in_forward = new kbutton_t();
export const in_back = new kbutton_t();
export const in_lookup = new kbutton_t();
export const in_lookdown = new kbutton_t();
export const in_moveleft = new kbutton_t();
export const in_moveright = new kbutton_t();
export const in_strafe = new kbutton_t();
export const in_speed = new kbutton_t();
export const in_use = new kbutton_t();
export const in_jump = new kbutton_t();
export const in_attack = new kbutton_t();
export const in_up = new kbutton_t();
export const in_down = new kbutton_t();

let in_impulse = 0;

function KeyDown(b) {
  const c = Cmd_Argv(1);
  let k;
  if (c.length) {
    k = parseInt(c);
  } else {
    k = -1; // typed manually at the console for continuous down
  }

  if (k === b.down[0] || k === b.down[1]) {
    return; // repeating key
  }

  if (b.down[0] === 0) {
    b.down[0] = k;
  } else if (b.down[1] === 0) {
    b.down[1] = k;
  } else {
    Con_Printf("Three keys down for a button!\n");
    return;
  }

  if (b.state & 1) {
    return; // still down
  }
  b.state |= 1 + 2; // down + impulse down
}

function KeyUp(b) {
  const c = Cmd_Argv(1);
  let k;
  if (c.length) {
    k = parseInt(c);
  } else {
    // typed manually at the console, assume for unsticking, so clear all
    b.down[0] = b.down[1] = 0;
    b.state = 4; // impulse up
    return;
  }

  if (b.down[0] === k) {
    b.down[0] = 0;
  } else if (b.down[1] === k) {
    b.down[1] = 0;
  } else {
    return; // key up without coresponding down (menu pass through)
  }
  if (b.down[0] || b.down[1]) {
    return; // some other key is still holding it down
  }

  if (!(b.state & 1)) {
    return; // still up (this should not happen)
  }
  b.state &= ~1; // now up
  b.state |= 4; // impulse up
}

function IN_KLookDown() {
  KeyDown(in_klook);
}
function IN_KLookUp() {
  KeyUp(in_klook);
}
function IN_MLookDown() {
  KeyDown(in_mlook);
}
function IN_MLookUp() {
  KeyUp(in_mlook);
  if (!(in_mlook.state & 1) && lookspring.value) {
    V_StartPitchDrift();
  }
}

function IN_UpDown() {
  KeyDown(in_up);
}
function IN_UpUp() {
  KeyUp(in_up);
}
function IN_DownDown() {
  KeyDown(in_down);
}
function IN_DownUp() {
  KeyUp(in_down);
}
function IN_LeftDown() {
  KeyDown(in_left);
}
function IN_LeftUp() {
  KeyUp(in_left);
}
function IN_RightDown() {
  KeyDown(in_right);
}
function IN_RightUp() {
  KeyUp(in_right);
}
function IN_ForwardDown() {
  KeyDown(in_forward);
}
function IN_ForwardUp() {
  KeyUp(in_forward);
}
function IN_BackDown() {
  KeyDown(in_back);
}
function IN_BackUp() {
  KeyUp(in_back);
}
function IN_LookupDown() {
  KeyDown(in_lookup);
}
function IN_LookupUp() {
  KeyUp(in_lookup);
}
function IN_LookdownDown() {
  KeyDown(in_lookdown);
}
function IN_LookdownUp() {
  KeyUp(in_lookdown);
}
function IN_MoveleftDown() {
  KeyDown(in_moveleft);
}
function IN_MoveleftUp() {
  KeyUp(in_moveleft);
}
function IN_MoverightDown() {
  KeyDown(in_moveright);
}
function IN_MoverightUp() {
  KeyUp(in_moveright);
}

function IN_SpeedDown() {
  KeyDown(in_speed);
}
function IN_SpeedUp() {
  KeyUp(in_speed);
}
function IN_StrafeDown() {
  KeyDown(in_strafe);
}
function IN_StrafeUp() {
  KeyUp(in_strafe);
}

function IN_AttackDown() {
  KeyDown(in_attack);
}
function IN_AttackUp() {
  KeyUp(in_attack);
}

function IN_UseDown() {
  KeyDown(in_use);
}
function IN_UseUp() {
  KeyUp(in_use);
}
function IN_JumpDown() {
  KeyDown(in_jump);
}
function IN_JumpUp() {
  KeyUp(in_jump);
}

function IN_Impulse() {
  in_impulse = Q_atoi(Cmd_Argv(1));
}

/*
===============
CL_KeyState

Returns 0.25 if a key was pressed and released during the frame,
0.5 if it was pressed and held
0 if held then released, and
1.0 if held for the entire time
===============
*/
export function CL_KeyState(key) {
  let val;
  const impulsedown = key.state & 2;
  const impulseup = key.state & 4;
  const down = key.state & 1;
  val = 0;

  if (impulsedown && !impulseup) {
    if (down) {
      val = 0.5; // pressed and held this frame
    } else {
      val = 0; // I_Error ();
    }
  }
  if (impulseup && !impulsedown) {
    if (down) {
      val = 0; // I_Error ();
    } else {
      val = 0; // released this frame
    }
  }
  if (!impulsedown && !impulseup) {
    if (down) {
      val = 1.0; // held the entire frame
    } else {
      val = 0; // up the entire frame
    }
  }
  if (impulsedown && impulseup) {
    if (down) {
      val = 0.75; // released and re-pressed this frame
    } else {
      val = 0.25; // pressed and released this frame
    }
  }

  key.state &= 1; // clear impulses

  return val;
}

//==========================================================================

export const cl_upspeed = new cvar_t("cl_upspeed", "200");
export const cl_forwardspeed = new cvar_t("cl_forwardspeed", "200", true);
export const cl_backspeed = new cvar_t("cl_backspeed", "200", true);
export const cl_sidespeed = new cvar_t("cl_sidespeed", "350");

export const cl_movespeedkey = new cvar_t("cl_movespeedkey", "2.0");
// johnfitz -- variable pitch clamping (FitzQuake/QuakeSpasm/Ironwail cl_main.c).
// Defaults are id's hard-coded 80 / -70; FitzQuake's are 90 / -90.
export const cl_maxpitch = new cvar_t("cl_maxpitch", "80", true);
export const cl_minpitch = new cvar_t("cl_minpitch", "-70", true);

export const cl_yawspeed = new cvar_t("cl_yawspeed", "140");
export const cl_pitchspeed = new cvar_t("cl_pitchspeed", "150");

export const cl_anglespeedkey = new cvar_t("cl_anglespeedkey", "1.5");

/*
================
CL_AdjustAngles

Moves the local angle positions
================
*/
export function CL_AdjustAngles() {
  let speed;

  if (in_speed.state & 1) {
    speed = host_frametime * cl_anglespeedkey.value;
  } else {
    speed = host_frametime;
  }

  if (!(in_strafe.state & 1)) {
    cl.viewangles[YAW] -= speed * cl_yawspeed.value * CL_KeyState(in_right);
    cl.viewangles[YAW] += speed * cl_yawspeed.value * CL_KeyState(in_left);
    cl.viewangles[YAW] = anglemod(cl.viewangles[YAW]);
  }

  if (in_klook.state & 1) {
    V_StopPitchDrift();
    cl.viewangles[PITCH] -= speed * cl_pitchspeed.value *
      CL_KeyState(in_forward);
    cl.viewangles[PITCH] += speed * cl_pitchspeed.value * CL_KeyState(in_back);
  }

  const up = CL_KeyState(in_lookup);
  const down = CL_KeyState(in_lookdown);

  cl.viewangles[PITCH] -= speed * cl_pitchspeed.value * up;
  cl.viewangles[PITCH] += speed * cl_pitchspeed.value * down;

  if (up || down) {
    V_StopPitchDrift();
  }

  CL_ClampPitch();

  if (cl.viewangles[ROLL] > 50) {
    cl.viewangles[ROLL] = 50;
  }
  if (cl.viewangles[ROLL] < -50) {
    cl.viewangles[ROLL] = -50;
  }
}

/*
================
CL_BaseMove

Send the intended movement message to the server
================
*/
export function CL_BaseMove(cmd) {
  if (cls.signon !== SIGNONS) {
    return;
  }

  CL_AdjustAngles();

  cmd.viewangles.fill(0);
  cmd.forwardmove = 0;
  cmd.sidemove = 0;
  cmd.upmove = 0;

  if (in_strafe.state & 1) {
    cmd.sidemove += cl_sidespeed.value * CL_KeyState(in_right);
    cmd.sidemove -= cl_sidespeed.value * CL_KeyState(in_left);
  }

  cmd.sidemove += cl_sidespeed.value * CL_KeyState(in_moveright);
  cmd.sidemove -= cl_sidespeed.value * CL_KeyState(in_moveleft);

  cmd.upmove += cl_upspeed.value * CL_KeyState(in_up);
  cmd.upmove -= cl_upspeed.value * CL_KeyState(in_down);

  if (!(in_klook.state & 1)) {
    cmd.forwardmove += cl_forwardspeed.value * CL_KeyState(in_forward);
    cmd.forwardmove -= cl_backspeed.value * CL_KeyState(in_back);
  }

  //
  // adjust for speed key
  //
  if (in_speed.state & 1) {
    cmd.forwardmove *= cl_movespeedkey.value;
    cmd.sidemove *= cl_movespeedkey.value;
    cmd.upmove *= cl_movespeedkey.value;
  }
}

/*
==============
CL_QuantizeAngle

The angle the server gets back from MSG_WriteAngle16 / MSG_ReadAngle16
in clc_move: truncated to 1/65536 of a turn, as a signed short.
==============
*/
export function CL_QuantizeAngle(f) {
  let s = ((f * 65536 / 360) | 0) & 65535;
  if (s > 32767) {
    s -= 65536;
  }
  return s * (360.0 / 65536);
}

/*
=================
CL_AccumulateCmd

Ironwail CL_AccumulateCmd (Spike: split from CL_SendCmd): turns the view
on a render frame that runs no network tick, so mouse look follows every
frame (host.js _Host_NetFrame). A tick frame turns it in CL_SendCmd.

Ironwail adds IN_Move's moves to cl.pendingcmd, which CL_SendCmd sends.
Here CL_SendCmd is unchanged and samples the sticks and touch joystick
itself, so the scratch command's moves are dropped; summing them as
Ironwail does would multiply stick speed by the frames per tick. Mouse
motion that moves rather than turns (+strafe, lookstrafe, or no +mlook)
can't be told apart from those, so then nothing turns until the tick:
CL_SendCmd gets the whole mouse delta, as in WinQuake, and host.js gives
it the time since the view last turned for keyboard and stick turning.

Returns true if the view turned.
=================
*/
export function CL_AccumulateCmd() {
  if (cls.state !== ca_connected || cls.signon !== SIGNONS) {
    return false;
  }

  if (
    (in_strafe.state & 1) || (in_mlook.state & 1) === 0 ||
    lookstrafe.value !== 0
  ) {
    return false;
  }

  // basic keyboard looking
  CL_AdjustAngles();

  // mouse, touch, gamepad and XR stick looking
  const cmd = _accumulate_cmd;
  cmd.forwardmove = 0;
  cmd.sidemove = 0;
  cmd.upmove = 0;
  IN_Move(cmd);
  return true;
}

/*
==============
CL_MoveAngles

The angles CL_SendMove sends: the view angles, or in XR the controller's
aim, so weapons fire where it points. The server also moves the player
along them, so prediction must use the same ones (IN-3).
==============
*/
export function CL_MoveAngles() {
  if (isXRActive() && XR_GetAimAngles(_xrAimAngles)) {
    return _xrAimAngles;
  }
  return cl.viewangles;
}

/*
==============
CL_SendMove
==============
*/
export function CL_SendMove(cmd) {
  const buf = _sendmove_buf;
  buf.cursize = 0;
  buf.overflowed = false;

  cl.cmd = cmd;

  //
  // send the movement message
  //
  MSG_WriteByte(buf, clc_move);

  MSG_WriteFloat(buf, cl.mtime[0]); // so server can get ping times

  // In XR mode, the controller's aim rather than the head's direction
  const angles = CL_MoveAngles();

  // Deliberate deviation from WinQuake's MSG_WriteAngle (8 bits, ~1.4 deg
  // steps): 16-bit angles, as FitzQuake's protocol sends them
  // (johnfitz -- 16-bit angles for PROTOCOL_FITZQUAKE). SV_ReadClientMove
  // reads them with MSG_ReadAngle16.
  for (let i = 0; i < 3; i++) {
    MSG_WriteAngle16(buf, angles[i]);
    // what the server's MSG_ReadAngle16 will get back
    _sendmove_predAngles[i] = CL_QuantizeAngle(angles[i]);
  }

  MSG_WriteShort(buf, cmd.forwardmove);
  MSG_WriteShort(buf, cmd.sidemove);
  MSG_WriteShort(buf, cmd.upmove);

  //
  // send button bits
  //
  let bits = 0;

  if (in_attack.state & 3) {
    bits |= 1;
  }
  in_attack.state &= ~2;

  if (in_jump.state & 3) {
    bits |= 2;
  }
  in_jump.state &= ~2;

  MSG_WriteByte(buf, bits);

  MSG_WriteByte(buf, in_impulse);
  in_impulse = 0;

  //
  // Store command for client-side prediction (QuakeWorld style)
  // Build a prediction command structure
  //
  // clc_move has no msec: the server moves the player by its own
  // host_frametime, which isn't floored to whole milliseconds. Keep the
  // fraction so prediction doesn't fall 4-6% short (PRED-3). With
  // renderer/network isolation this is the tick's length, not the
  // render frame's (host_netframetime equals host_frametime without it).
  // No 255 cap either: QW's msec is a byte, but this one never goes on
  // the wire, and host_timescale (or host_framerate) can make the tick
  // the server runs longer than 255 ms, e.g. a 0.2 s hitch at
  // host_timescale 4. CL_PredictUsercmd splits long moves.
  _sendmove_predCmd.msec = host_netframetime * 1000;
  _sendmove_predCmd.forwardmove = cmd.forwardmove;
  _sendmove_predCmd.sidemove = cmd.sidemove;
  _sendmove_predCmd.upmove = cmd.upmove;
  _sendmove_predCmd.buttons = bits;
  const netSequence = cls.netcon != null ? (cls.netcon.sendSequence | 0) : -1;
  CL_StoreCommand(_sendmove_predCmd, realtime, netSequence);

  if (USE_QW_COMMAND_EXTENSIONS === true) {
    // Request delta compression of entities (QW-style).
    const validseq = CL_GetValidSequence();
    const serverseq = CL_GetServerSequence();
    let frameDiff = (serverseq & 255) - (validseq & 255);
    if (frameDiff < 0) frameDiff += 256;
    if (validseq !== 0 && frameDiff < PE_UPDATE_BACKUP - 1) {
      MSG_WriteByte(buf, clc_delta);
      MSG_WriteByte(buf, validseq & 255);
    }
  }

  //
  // deliver the message
  //
  if (cls.demoplayback) {
    return;
  }

  //
  // allways dump the first two message, because it may contain leftover inputs
  // from the last level
  //
  if (++cl.movemessages <= 2) {
    return;
  }

  if (NET_SendUnreliableMessage(cls.netcon, buf) === -1) {
    Con_Printf("CL_SendMove: lost server connection\n");
    CL_Disconnect();
  }
}

/*
============
CL_ClampPitch

johnfitz -- variable pitch clamping: cl_maxpitch / cl_minpitch replace
id's hard-coded 80 / -70 in CL_AdjustAngles and the mouse look (in_win.c
IN_MouseMove, here IN_Move), plus the port's gamepad and touch look
============
*/
export function CL_ClampPitch() {
  if (cl.viewangles[PITCH] > cl_maxpitch.value) {
    cl.viewangles[PITCH] = cl_maxpitch.value;
  }
  if (cl.viewangles[PITCH] < cl_minpitch.value) {
    cl.viewangles[PITCH] = cl_minpitch.value;
  }
}

/*
============
CL_InitInput
============
*/
export function CL_InitInput() {
  Cvar_RegisterVariable(cl_maxpitch);
  Cvar_RegisterVariable(cl_minpitch);

  Cmd_AddCommand("+moveup", IN_UpDown);
  Cmd_AddCommand("-moveup", IN_UpUp);
  Cmd_AddCommand("+movedown", IN_DownDown);
  Cmd_AddCommand("-movedown", IN_DownUp);
  Cmd_AddCommand("+left", IN_LeftDown);
  Cmd_AddCommand("-left", IN_LeftUp);
  Cmd_AddCommand("+right", IN_RightDown);
  Cmd_AddCommand("-right", IN_RightUp);
  Cmd_AddCommand("+forward", IN_ForwardDown);
  Cmd_AddCommand("-forward", IN_ForwardUp);
  Cmd_AddCommand("+back", IN_BackDown);
  Cmd_AddCommand("-back", IN_BackUp);
  Cmd_AddCommand("+lookup", IN_LookupDown);
  Cmd_AddCommand("-lookup", IN_LookupUp);
  Cmd_AddCommand("+lookdown", IN_LookdownDown);
  Cmd_AddCommand("-lookdown", IN_LookdownUp);
  Cmd_AddCommand("+strafe", IN_StrafeDown);
  Cmd_AddCommand("-strafe", IN_StrafeUp);
  Cmd_AddCommand("+moveleft", IN_MoveleftDown);
  Cmd_AddCommand("-moveleft", IN_MoveleftUp);
  Cmd_AddCommand("+moveright", IN_MoverightDown);
  Cmd_AddCommand("-moveright", IN_MoverightUp);
  Cmd_AddCommand("+speed", IN_SpeedDown);
  Cmd_AddCommand("-speed", IN_SpeedUp);
  Cmd_AddCommand("+attack", IN_AttackDown);
  Cmd_AddCommand("-attack", IN_AttackUp);
  Cmd_AddCommand("+use", IN_UseDown);
  Cmd_AddCommand("-use", IN_UseUp);
  Cmd_AddCommand("+jump", IN_JumpDown);
  Cmd_AddCommand("-jump", IN_JumpUp);
  Cmd_AddCommand("impulse", IN_Impulse);
  Cmd_AddCommand("+klook", IN_KLookDown);
  Cmd_AddCommand("-klook", IN_KLookUp);
  Cmd_AddCommand("+mlook", IN_MLookDown);
  Cmd_AddCommand("-mlook", IN_MLookUp);

  // Enable mouse look by default for the web port
  // (original Quake required manually binding +mlook)
  in_mlook.state = 1;
}
