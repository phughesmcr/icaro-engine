// Ported from: WinQuake/vid.h -- video driver defs (browser/Three.js)

import * as THREE from "three";
import { Sys_Printf } from "./sys.js";
import { Con_Printf } from "./console.js";
import { Cvar_RegisterVariable } from "./cvar.js";

// vid.h constants
export const VID_CBITS = 6;
export const VID_GRADES = 1 << VID_CBITS;

// vrect_t

export class vrect_t {
  constructor() {
    this.x = 0;
    this.y = 0;
    this.width = 0;
    this.height = 0;
    this.pnext = null;
  }
}

// viddef_t -- global video state

export class viddef_t {
  constructor() {
    this.buffer = null; // Uint8Array -- invisible buffer
    this.colormap = null; // Uint8Array -- 256 * VID_GRADES size
    this.colormap16 = null; // Uint16Array -- 256 * VID_GRADES size
    this.fullbright = 0; // index of first fullbright color
    this.rowbytes = 0; // may be > width if displayed in a window
    this.width = 0;
    this.height = 0;
    this.aspect = 0; // width / height -- < 0 is taller than wide
    this.numpages = 0;
    this.recalc_refdef = 0; // if true, recalc vid-based stuff
    this.conbuffer = null;
    this.conrowbytes = 0;
    this.conwidth = 0;
    this.conheight = 0;
    this.maxwarpwidth = 0;
    this.maxwarpheight = 0;
    this.direct = null; // direct drawing to framebuffer, if not NULL
  }
}

// Globals

export const vid = new viddef_t();

// palette lookup tables
export const d_8to16table = new Uint16Array(256);
export const d_8to24table = new Uint32Array(256);

// menu callback function pointers (stubs for browser)
export const vid_menudrawfn = null;
export const vid_menukeyfn = null;

// Three.js renderer state (replaces raw GL context)

export let renderer = null; // THREE.WebGLRenderer
export let canvas = null; // HTMLCanvasElement

// VID_SetPalette
//
// Called at startup and after any gamma correction.
// Takes 256 entries of RGB byte triplets (768 bytes total).

export function VID_SetPalette(palette) {
  // palette is a Uint8Array of 768 bytes (256 * 3 RGB)
  if (!palette) return;

  for (let i = 0; i < 256; i++) {
    const r = palette[i * 3 + 0];
    const g = palette[i * 3 + 1];
    const b = palette[i * 3 + 2];

    // d_8to24table: RGBA packed as 32-bit unsigned
    // Quake uses ABGR byte order on little-endian (0xAABBGGRR)
    d_8to24table[i] = (255 << 24) | (b << 16) | (g << 8) | r;

    // d_8to16table: RGB565 format
    d_8to16table[i] = ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
  }

  // index 255 is transparent (used for sprites, etc.). C clears only the
  // alpha and keeps the palette colour (gl_vidnt.c VID_SetPalette:
  // d_8to24table[255] &= 0xffffff), so filtered alpha textures fringe
  // towards that colour, not black.
  d_8to24table[255] &= 0xffffff;
}

// VID_ShiftPalette
//
// Called for bonus and pain flashes, and for underwater color changes.

export function VID_ShiftPalette(palette) {
  // In the browser, palette shifts are handled by post-processing
  // or by a screen-space color overlay (see R_PolyBlend in gl_rmain.js).
  // For now, just update the lookup tables.
  VID_SetPalette(palette);
}

// VID_GetPixelRatio
//
// Web-only deviation, no C equivalent. The device pixel ratio that every
// canvas size and UI scale is derived from. On touch-primary devices (see
// VID_IsTouchPrimary) it is capped at VID_TOUCH_DPR_CAP: a DPR-3
// phone would otherwise fill about 3M pixels per frame, the biggest battery
// and thermal cost. ?dpr=<number> sets it explicitly (clamped to 0.5..4) and
// ?dpr=native removes the cap on any device. Taps are mapped in CSS pixels,
// so they are unaffected. Desktop is not capped; DPR 2 displays are common.

export const VID_TOUCH_DPR_CAP = 2;

/**
 * True on touch-first devices: the primary pointer is coarse, and no mouse or
 * trackpad is attached. A fine pointer alone doesn't count as one: a phone
 * with a stylus (Galaxy S25 Ultra) reports one, but nothing there can hover.
 * match(query) is window.matchMedia(query).
 */
export function VID_IsTouchPrimary(match) {
  return match("(pointer: coarse)").matches === true &&
    !(match("(any-pointer: fine)").matches === true &&
      match("(any-hover: hover)").matches === true);
}

// Returns the ?dpr= override: a number, 'native', or null when absent/invalid.
export function VID_ParsePixelRatio(search) {
  const raw = new URLSearchParams(search).get("dpr");
  if (raw === null) return null;
  if (raw.toLowerCase() === "native") return "native";
  if (raw.trim() === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.min(4, Math.max(0.5, value));
}

// vid_dprcap (web-only, no Quake counterpart; set by the vid_quality presets
// in gl_rmain.js): an upper bound for the pixel ratio on any device. 0, the
// default, leaves the rules above alone (touch capped at VID_TOUCH_DPR_CAP,
// desktop uncapped). Above 0 it replaces VID_TOUCH_DPR_CAP, so a player can
// also raise a touch device's cap. ?dpr= still overrides it. It is applied
// live: VID_CheckPixelRatio resizes the renderer when the value changes.
export const vid_dprcap = {
  name: "vid_dprcap",
  string: "0",
  value: 0,
  archive: true,
};
let _appliedDprCap = 0;

// Pure part of VID_GetPixelRatio. override is VID_ParsePixelRatio's result;
// cap is vid_dprcap's value (0 = none).
export function VID_ComputePixelRatio(dpr, override, touchPrimary, cap = 0) {
  if (typeof override === "number") return override;
  if (!(dpr > 0)) dpr = 1;
  if (override === "native") return dpr;
  if (cap > 0) return Math.min(dpr, Math.max(cap, 0.5));
  return touchPrimary === true ? Math.min(dpr, VID_TOUCH_DPR_CAP) : dpr;
}

// Applies a changed vid_dprcap: a 'resize' event reaches VID_Resize and
// gl_draw's overlay canvas, which both re-read VID_GetPixelRatio. Called
// once a frame; it only compares numbers.
export function VID_CheckPixelRatio() {
  if (vid_dprcap.value === _appliedDprCap) return;
  _appliedDprCap = vid_dprcap.value;
  if (
    typeof window !== "undefined" &&
    typeof window.dispatchEvent === "function" && typeof Event === "function"
  ) {
    window.dispatchEvent(new Event("resize"));
  }
}

let _dprOverride = undefined; // undefined = not read yet
let _dprTouchPrimary = false;

// The override and pointer type are fixed for the page's lifetime, so read
// them once; this runs several times a frame (gl_draw's virtual size getters).
export function VID_GetPixelRatio() {
  if (_dprOverride === undefined) {
    _dprOverride = VID_ParsePixelRatio(
      window.location !== undefined && window.location !== null ?
        window.location.search :
        "",
    );
    _dprTouchPrimary = typeof window.matchMedia === "function" &&
      VID_IsTouchPrimary((query) => window.matchMedia(query));
  }

  return VID_ComputePixelRatio(
    window.devicePixelRatio,
    _dprOverride,
    _dprTouchPrimary,
    vid_dprcap.value,
  );
}

// Forget the cached override and pointer check (tests).
export function VID_ResetPixelRatio() {
  _dprOverride = undefined;
  _dprTouchPrimary = false;
}

// VID_ParseRenderScale
//
// Web-only, no C equivalent. Reads ?scale= from a URL query string: the
// fraction of the screen's pixels the 3D view is rendered at, which the
// browser then stretches to fill the page. 0.5 renders a quarter of the
// pixels, for weak GPUs such as smart-TV browsers. Clamped to 0.25..1;
// missing or invalid values give 1 (full resolution).

// WebGL drawing-buffer pixels per 2D overlay pixel; set once by VID_Init.
// R_SetupGL scales the view rectangle by it.
export let vid_renderscale = 1;

export function VID_ParseRenderScale(search) {
  const value = parseFloat(new URLSearchParams(search).get("scale"));
  if (!Number.isFinite(value)) return 1;
  return Math.min(1, Math.max(0.25, value));
}

// VID_Init
//
// Called at startup to set up translation tables.
// Takes 256 8-bit RGB values. The palette data will go away after the call,
// so it must be copied off if the video driver will need it again.
//
// For browser: creates a canvas and initializes Three.js WebGLRenderer.

export function VID_Init(palette, gammaparm = null) {
  Sys_Printf("VID_Init");

  Cvar_RegisterVariable(vid_dprcap);
  _appliedDprCap = vid_dprcap.value;

  // default video dimensions
  vid.width = 640; // was 320 in software Quake
  vid.height = 480; // was 200 in software Quake
  vid.aspect = vid.width / vid.height;
  vid.numpages = 1;
  vid.rowbytes = vid.width;
  vid.conwidth = vid.width;
  vid.conheight = vid.height;
  vid.maxwarpwidth = 320;
  vid.maxwarpheight = 200;
  vid.fullbright = 256 - 32; // last 32 colors are fullbright in Quake palette
  vid.recalc_refdef = 1;

  // allocate buffers
  vid.buffer = new Uint8Array(vid.width * vid.height);
  vid.conbuffer = vid.buffer;
  vid.conrowbytes = vid.rowbytes;
  vid.colormap = new Uint8Array(256 * VID_GRADES);

  // build palette lookup
  if (palette) {
    Check_Gamma(palette, gammaparm);
    VID_SetPalette(palette);
  }

  // create canvas element
  canvas = document.createElement("canvas");
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  canvas.style.display = "block";
  document.body.appendChild(canvas);

  // update vid dimensions to match actual canvas
  vid.width = canvas.width;
  vid.height = canvas.height;
  vid.aspect = vid.width / vid.height;
  vid.rowbytes = vid.width;
  vid.conwidth = vid.width;
  vid.conheight = vid.height;

  // create Three.js WebGLRenderer (replaces raw GL context)
  renderer = new THREE.WebGLRenderer({
    canvas: canvas,
    antialias: false, // Quake didn't have AA
    alpha: false,
    depth: true,
    stencil: false,
  });

  // Web-only: ?scale= renders the 3D view below screen resolution (see
  // VID_ParseRenderScale). The 2D overlay canvas in gl_draw.js keeps the
  // same VID_GetPixelRatio, so menus and the HUD stay sharp.
  vid_renderscale = VID_ParseRenderScale(window.location.search);
  renderer.setSize(canvas.width, canvas.height);
  renderer.setPixelRatio(VID_GetPixelRatio() * vid_renderscale);
  if (vid_renderscale < 1) canvas.style.imageRendering = "pixelated";
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.autoClear = false; // we manage clearing ourselves, like Quake did
  renderer.sortObjects = false; // we sort manually via BSP front-to-back

  // Enable tone mapping for brightness control
  // LinearToneMapping applies exposure without additional curve
  renderer.toneMapping = THREE.LinearToneMapping;
  renderer.toneMappingExposure = 1.0;

  // listen for window resize
  window.addEventListener("resize", function () {
    VID_Resize();
  });

  // Web-only: Three.js restores the size it saved when the session began,
  // and any resize during the session was skipped (see VID_Resize), so
  // resync canvas, vid and renderer once it ends.
  if (
    renderer.xr != null && typeof renderer.xr.addEventListener === "function"
  ) {
    renderer.xr.addEventListener("sessionend", function () {
      VID_Resize();
    });
  }

  Con_Printf(
    "WebGLRenderer initialized (" + vid.width + "x" + vid.height + ")\n",
  );
}

// VID_Resize
//
// Web-only, no C equivalent: the window 'resize' handler. While an XR
// session is presenting, the headset owns the drawing buffer size, so
// setSize/setPixelRatio are skipped; the sessionend listener calls this
// again so canvas, vid and renderer agree afterwards.

export function VID_Resize(r = renderer, c = canvas) {
  if (r === null || c === null) return;
  if (r.xr != null && r.xr.isPresenting === true) return;

  c.width = window.innerWidth;
  c.height = window.innerHeight;
  vid.width = c.width;
  vid.height = c.height;
  vid.aspect = vid.width / vid.height;
  vid.rowbytes = vid.width;
  vid.conwidth = vid.width;
  vid.conheight = vid.height;
  vid.recalc_refdef = 1;

  // Re-read the pixel ratio: browser zoom and moving the window to a
  // screen with another DPI change it and fire 'resize'.
  r.setSize(c.width, c.height);
  r.setPixelRatio(VID_GetPixelRatio() * vid_renderscale);
}

// VID_Shutdown
//
// Called at shutdown.

export function VID_Shutdown() {
  Sys_Printf("VID_Shutdown");

  if (renderer) {
    renderer.dispose();
    renderer = null;
  }

  if (canvas && canvas.parentNode) {
    canvas.parentNode.removeChild(canvas);
    canvas = null;
  }
}

// VID_Update
//
// Flushes the given rectangles from the view buffer to the screen.
// In Three.js, the actual rendering is handled by renderer.render() in
// gl_rmain.js, so this is largely a no-op.

export function VID_Update(_rects) {
  // Three.js handles buffer swaps internally via renderer.render()
}

// VID_SetMode
//
// Sets the mode; only used by the Quake engine for resetting to mode 0
// (the base mode) on memory allocation failures.

export function VID_SetMode(_modenum, palette) {
  // In browser, we only have one "mode" - the canvas size
  if (palette) {
    VID_SetPalette(palette);
  }

  vid.recalc_refdef = 1;

  return 1; // success
}

// VID_HandlePause
//
// Called only on Win32, when pause happens, so the mouse can be released.
// In browser, we use Pointer Lock API instead.

export function VID_HandlePause(_pause) {
  // Browser: Pointer Lock API handles this naturally
  // When paused, we can exit pointer lock if desired
}

// Check_Gamma (gl_vidnt.c)
//
// GLQuake bakes a gamma curve into the palette once, at VID_Init:
// pow( ( c + 1 ) / 256, vid_gamma ). vid_gamma is 1 on 3Dfx cards and 0.7 on
// everything else, or the -gamma command-line value (read by Host_Init and
// passed in, so vid.js needn't import common.js). The port takes the non-3Dfx
// path. Like the C it rewrites the palette in place, so host_basepal
// (Draw_Fill, 2D pics) sees the corrected colours too.

let vid_gamma = 1.0;
const _gamma_checked = new WeakSet(); // palettes already corrected

export function Check_Gamma_Palette(pal, gamma) {
  for (let i = 0; i < 768; i++) {
    const f = Math.pow((pal[i] + 1) / 256.0, gamma);
    let inf = Math.floor(f * 255 + 0.5);
    if (inf < 0) {
      inf = 0;
    }
    if (inf > 255) {
      inf = 255;
    }
    pal[i] = inf;
  }

  return pal;
}

export function Check_Gamma(pal, gammaparm = null) {
  // C runs this once per VID_Init on a freshly loaded palette; guard so a
  // second call can't apply the curve twice to the same array.
  if (_gamma_checked.has(pal)) return;
  _gamma_checked.add(pal);

  if (gammaparm === null) {
    vid_gamma = 0.7; // default to 0.7 on non-3dfx hardware
  } else {
    vid_gamma = gammaparm;
  }

  Check_Gamma_Palette(pal, vid_gamma);
}

// VID_UpdateGamma
//
// In GLQuake the gamma cvar does nothing: VID_ShiftPalette (gl_vidnt.c) is an
// empty stub, so the only gamma is Check_Gamma's. Deviation: the port keeps
// the cvar working as a brightness control, as a tone-mapping exposure of
// 1 / gamma. At the default gamma 1 the exposure is 1, which with
// Check_Gamma and LIGHTMAP_INTENSITY (glquake.js) matches GLQuake's output.

export function VID_GammaExposure(gamma) {
  if (!(gamma > 0)) gamma = 1.0;
  return 1.0 / gamma;
}

export function VID_UpdateGamma(gamma) {
  if (!renderer) return;

  renderer.toneMappingExposure = VID_GammaExposure(gamma);
}
