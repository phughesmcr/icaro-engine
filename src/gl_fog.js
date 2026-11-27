// Ported from: Ironwail Quake/gl_fog.c (FitzQuake's global fog), with the
// skyfog parts of Quake/gl_sky.c
//
// Deliberate deviation: WinQuake and GLQuake have no fog. The 2021 rerelease
// maps set it with the worldspawn "fog" key and (mg1, mg3, dopa) with
// stuffcmd( "fog ..." ) from QuakeC, so this follows FitzQuake/Ironwail.
// See docs/port-review.md section 7.
//
// Three.js draws the fog: Fog_SetupFrame sets scene.fog to a THREE.FogExp2
// while the fog is on, and to null while it is off, so a map without fog
// keeps the shaders it had before. Every world, alias, sprite, particle and
// water material is a MeshBasic/MeshLambert/Points material and picks it up.
// The sky materials opt out (fog: false) and use Fog_PatchSkyShader instead,
// a flat mix towards the fog colour as in Ironwail's sky shaders.
// The rerelease QuakeC sets fog with stuffcmd, which reaches the client's
// command buffer. svc_fog (Fog_ParseServerMessage) comes only from FitzQuake
// 666 and RMQ 999 demos.
// Volumetric fog (r_vfog) is a stub in Ironwail and is left out.

import * as THREE from "three";
import {
  COM_Parse,
  com_token,
  Con_Printf,
  MSG_ReadByte,
  MSG_ReadShort,
  Q_atof,
} from "./common.js";
import { Cmd_AddCommand, Cmd_Argc, Cmd_Argv } from "./cmd.js";
import { Cvar_RegisterVariable, cvar_t } from "./cvar.js";
import { cl } from "./client.js";
import { Q_FormatFloat } from "./pr_sprintf.js";

//  GLOBAL FOG

const DEFAULT_DENSITY = 0.0;
const DEFAULT_GRAY = 0.3;

let fog_density = DEFAULT_DENSITY;
let fog_red = DEFAULT_GRAY;
let fog_green = DEFAULT_GRAY;
let fog_blue = DEFAULT_GRAY;

let old_density = DEFAULT_DENSITY;
let old_red = DEFAULT_GRAY;
let old_green = DEFAULT_GRAY;
let old_blue = DEFAULT_GRAY;

let fade_time = 0; // duration of fade
let fade_done = 0; // time when fade will be done

// gl_sky.c
export const r_skyfog = new cvar_t("r_skyfog", "0.5");
let skyfog = 0.5; // ericw
// r_skyfog's value when it last applied. Ironwail's cvar callback
// (R_SetSkyfog_f) overrides the worldspawn's skyfog when the cvar is set;
// this port's cvars have no callbacks, so Fog_SetupFrame applies a change.
let _seenSkyFog = 0.5;

export function Fog_GetState() {
  return {
    density: fog_density,
    red: fog_red,
    green: fog_green,
    blue: fog_blue,
    old_density,
    old_red,
    old_green,
    old_blue,
    fade_time,
    fade_done,
    skyfog,
  };
}

/** update internal variables */
export function Fog_Update(density, red, green, blue, time) {
  // save previous settings for fade
  if (time > 0) {
    // check for a fade in progress
    if (fade_done > cl.time) {
      const f = (fade_done - cl.time) / fade_time;
      old_density = f * old_density + (1.0 - f) * fog_density;
      old_red = f * old_red + (1.0 - f) * fog_red;
      old_green = f * old_green + (1.0 - f) * fog_green;
      old_blue = f * old_blue + (1.0 - f) * fog_blue;
    } else {
      old_density = fog_density;
      old_red = fog_red;
      old_green = fog_green;
      old_blue = fog_blue;
    }
  }

  fog_density = density;
  fog_red = red;
  fog_green = green;
  fog_blue = blue;
  fade_time = time;
  fade_done = cl.time + time;
}

/** handle an SVC_FOG message from server */
export function Fog_ParseServerMessage() {
  const density = MSG_ReadByte() / 255.0;
  const red = MSG_ReadByte() / 255.0;
  const green = MSG_ReadByte() / 255.0;
  const blue = MSG_ReadByte() / 255.0;
  let time = MSG_ReadShort() / 100.0;
  if (time < 0.0) time = 0.0;

  Fog_Update(density, red, green, blue, time);
}

function _g(v) {
  return Q_FormatFloat("g", 0, -1, -1, v);
}

/** handle the 'fog' console command */
export function Fog_FogCommand_f() {
  let d, r, g, b, t;

  switch (Cmd_Argc()) {
    default:
    case 1:
      Con_Printf("usage:\n");
      Con_Printf("   fog <density>\n");
      Con_Printf("   fog <red> <green> <blue>\n");
      Con_Printf("   fog <density> <red> <green> <blue>\n");
      Con_Printf("current values:\n");
      Con_Printf('   "density" is "' + _g(fog_density) + '"\n');
      Con_Printf('   "red"     is "' + _g(fog_red) + '"\n');
      Con_Printf('   "green"   is "' + _g(fog_green) + '"\n');
      Con_Printf('   "blue"    is "' + _g(fog_blue) + '"\n');
      return;
    case 2:
      d = Q_atof(Cmd_Argv(1));
      t = 0.0;
      r = fog_red;
      g = fog_green;
      b = fog_blue;
      break;
    case 3: // TEST
      d = Q_atof(Cmd_Argv(1));
      t = Q_atof(Cmd_Argv(2));
      r = fog_red;
      g = fog_green;
      b = fog_blue;
      break;
    case 4:
      d = fog_density;
      t = 0.0;
      r = Q_atof(Cmd_Argv(1));
      g = Q_atof(Cmd_Argv(2));
      b = Q_atof(Cmd_Argv(3));
      break;
    case 5:
      d = Q_atof(Cmd_Argv(1));
      r = Q_atof(Cmd_Argv(2));
      g = Q_atof(Cmd_Argv(3));
      b = Q_atof(Cmd_Argv(4));
      t = 0.0;
      break;
    case 6: // TEST
      d = Q_atof(Cmd_Argv(1));
      r = Q_atof(Cmd_Argv(2));
      g = Q_atof(Cmd_Argv(3));
      b = Q_atof(Cmd_Argv(4));
      t = Q_atof(Cmd_Argv(5));
      break;
  }

  if (d < 0.0) d = 0.0;
  if (r < 0.0) r = 0.0;
  else if (r > 1.0) r = 1.0;
  if (g < 0.0) g = 0.0;
  else if (g > 1.0) g = 1.0;
  if (b < 0.0) b = 0.0;
  else if (b > 1.0) b = 1.0;
  Fog_Update(d, r, g, b, t);
}

/**
 * sscanf( value, "%f %f %f %f", ... ): fills the outputs left to right and stops
 * at the first field that isn't a number, so later fields keep their values.
 */
const _scanFloat = /\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/y;

export function Fog_ScanFloats(value, out) {
  _scanFloat.lastIndex = 0;
  let n = 0;
  while (n < out.length) {
    const m = _scanFloat.exec(value);
    if (m === null) {
      break;
    }
    out[n++] = parseFloat(m[1]);
  }

  return n;
}

const _fogScan = [0, 0, 0, 0];

// worldspawn key: a leading '_' and trailing spaces removed
function _worldspawnKey(token) {
  return (token.charAt(0) === "_" ? token.substring(1) : token).replace(
    / +$/,
    "",
  );
}

/** called at map load */
export function Fog_ParseWorldspawn(entities) {
  // initially no fog
  fog_density = DEFAULT_DENSITY;
  fog_red = DEFAULT_GRAY;
  fog_green = DEFAULT_GRAY;
  fog_blue = DEFAULT_GRAY;

  old_density = DEFAULT_DENSITY;
  old_red = DEFAULT_GRAY;
  old_green = DEFAULT_GRAY;
  old_blue = DEFAULT_GRAY;

  fade_time = 0.0;
  fade_done = 0.0;

  if (entities === null || entities === undefined) {
    return;
  }

  let data = COM_Parse(entities);
  if (data === null) {
    return; // error
  }
  if (com_token.charAt(0) !== "{") {
    return; // error
  }
  while (true) {
    data = COM_Parse(data);
    if (data === null) {
      return; // error
    }
    if (com_token.charAt(0) === "}") {
      break; // end of worldspawn
    }
    const key = _worldspawnKey(com_token);
    data = COM_Parse(data);
    if (data === null) {
      return; // error
    }

    if (key === "fog") {
      _fogScan[0] = fog_density;
      _fogScan[1] = fog_red;
      _fogScan[2] = fog_green;
      _fogScan[3] = fog_blue;
      Fog_ScanFloats(com_token, _fogScan);
      fog_density = _fogScan[0];
      fog_red = _fogScan[1];
      fog_green = _fogScan[2];
      fog_blue = _fogScan[3];
    }
  }
}

// Sky_NewMap (gl_sky.c), the skyfog part
//
// The worldspawn "skyfog" key overrides r_skyfog for this map. The skybox
// part ("sky") is Sky_NewMap in gl_sky.js.
export function Sky_ParseSkyfog(entities) {
  skyfog = r_skyfog.value;
  _seenSkyFog = r_skyfog.value;

  if (entities === null || entities === undefined) {
    return;
  }

  let data = COM_Parse(entities);
  if (data === null) {
    return; // error
  }
  if (com_token.charAt(0) !== "{") {
    return; // error
  }
  while (true) {
    data = COM_Parse(data);
    if (data === null) {
      return; // error
    }
    if (com_token.charAt(0) === "}") {
      break; // end of worldspawn
    }
    const key = _worldspawnKey(com_token);
    data = COM_Parse(data);
    if (data === null) {
      return; // error
    }

    if (key === "skyfog") {
      const v = parseFloat(com_token); // atof
      skyfog = Number.isNaN(v) ? 0 : v;
    }
  }
}

// Fog_GetColor
//
// calculates fog color for this frame, taking into account fade times
const _fogColor = new Float32Array(4);

export function Fog_GetColor() {
  const c = _fogColor;

  if (fade_done > cl.time) {
    const f = (fade_done - cl.time) / fade_time;
    c[0] = f * old_red + (1.0 - f) * fog_red;
    c[1] = f * old_green + (1.0 - f) * fog_green;
    c[2] = f * old_blue + (1.0 - f) * fog_blue;
    c[3] = 1.0;
  } else {
    c[0] = fog_red;
    c[1] = fog_green;
    c[2] = fog_blue;
    c[3] = 1.0;
  }

  for (let i = 0; i < 3; i++) {
    c[i] = Math.min(Math.max(c[i], 0), 1);
  }

  // find closest 24-bit RGB value, so solid-colored sky can match the fog perfectly
  for (let i = 0; i < 3; i++) {
    c[i] = Math.round(c[i] * 255) / 255;
  }

  return c;
}

/** returns current density of fog */
export function Fog_GetDensity() {
  if (fade_done > cl.time) {
    const f = (fade_done - cl.time) / fade_time;
    return f * old_density + (1.0 - f) * fog_density;
  }

  return fog_density;
}

/**
 * Sky: Ironwail's sky shaders end with
 * 	result.rgb = mix( result.rgb, SkyFog.rgb, SkyFog.a );
 * where SkyFog is the fog colour and skyfog (r_skyfog, default 0.5) while the
 * fog is on, and alpha 0 while it is off. Both of the port's sky layers get the
 * same mix, which composes to the same colour as Ironwail's single pass. The
 * mix runs after colorspace_fragment, in the output's gamma space as in
 * Ironwail; the alpha is 0 for a map without fog, which leaves the colour as it
 * was.
 */
const _skyFog = { value: new THREE.Vector4(0, 0, 0, 0) };

export function Fog_PatchSkyShader(shader) {
  shader.uniforms.quakeSkyFog = _skyFog;
  shader.fragmentShader = "uniform vec4 quakeSkyFog;\n" +
    shader.fragmentShader.replace(
      "#include <colorspace_fragment>",
      "#include <colorspace_fragment>\n\tgl_FragColor.rgb = mix( gl_FragColor.rgb, quakeSkyFog.rgb, quakeSkyFog.a );",
    );
}

// Fog_SetupFrame
//
// called at the beginning of each frame
//
// Ironwail's shaders compute exp2( -Fog.w * dist * dist ) with
// Fog.w = ( density * DensityScale )^2, DensityScale = sqrt( log2( e ) ) * 0.85 / 64,
// which is exp( -( density * 0.85 / 64 )^2 * dist^2 ) over the radial distance.
// The 0.85 compensates for that distance being radial. Three.js's FogExp2 is
// exp( -( fog.density * depth )^2 ) over the planar view depth. Deliberate
// deviation from Ironwail: the fog density here is density / 64, FitzQuake's
// GL_EXP2 fog (GL_FOG_DENSITY = density / 64) over the planar depth, so the
// centre of the view is about 1 / 0.85 denser than Ironwail's and the edges
// of a wide view a little thinner. Ironwail's radial fog would need a patched
// fog_vertex chunk in every material. In WebXR the scene is scaled to metres (scene.scale is
// 1 / XR_SCALE), so the density is divided by that scale.
let _threeFog = null;

export function Fog_SetupFrame(scene) {
  if (r_skyfog.value !== _seenSkyFog) {
    _seenSkyFog = r_skyfog.value;
    skyfog = r_skyfog.value; // R_SetSkyfog_f
  }

  const density = Fog_GetDensity();
  const c = Fog_GetColor();

  _skyFog.value.set(
    c[0],
    c[1],
    c[2],
    density > 0 ? Math.min(Math.max(skyfog, 0), 1) : 0,
  );

  if (scene === null) {
    return;
  }

  if (density > 0) {
    if (_threeFog === null) {
      _threeFog = new THREE.FogExp2(0x000000, 0);
    }
    // the output is sRGB, and three.js mixes the fog after colorspace_fragment
    _threeFog.color.setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace);
    _threeFog.density = density / 64 / scene.scale.x;
    if (scene.fog !== _threeFog) {
      scene.fog = _threeFog;
    }
  } else if (scene.fog !== null) {
    scene.fog = null;
  }
}

export function Fog_GetSkyFog() {
  return _skyFog.value;
}

//  INIT

/** called whenever a map is loaded */
export function Fog_NewMap(worldmodel) {
  const entities = worldmodel !== null && worldmodel !== undefined ?
    worldmodel.entities :
    null;
  Sky_ParseSkyfog(entities); // gl_sky.c Sky_NewMap
  Fog_ParseWorldspawn(entities); // for global fog
}

/** called when quake initializes */
export function Fog_Init() {
  Cmd_AddCommand("fog", Fog_FogCommand_f);
  Cvar_RegisterVariable(r_skyfog); // gl_sky.c Sky_Init

  // set up global fog
  fog_density = DEFAULT_DENSITY;
  fog_red = DEFAULT_GRAY;
  fog_green = DEFAULT_GRAY;
  fog_blue = DEFAULT_GRAY;
}
