// Ported from: WinQuake/gl_model.c and gl_draw.c (GL_LoadTexture,
// R_InitTextures), QuakeSpasm/Ironwail gl_texmgr.c (TexMgr_AlphaEdgeFix,
// gl_texture_anisotropy) and gl_sky.c (Sky_LoadTexture, via R_InitSky)
// The renderer side of model loading, split out of gl_model.js so the
// loaders (mod_brush.js, mod_alias.js, mod_sprite.js) don't import three:
// Three.js textures, the sky layers, warp polygons (gl_warp.js), alias
// display lists (gl_mesh.js) and MD5 meshes (gl_md5.js). gl_model.js
// re-exports the names its importers use.

import * as THREE from "three";
import { texture_t } from "./mod_types.js";
import { loadmodel } from "./model.js";
import { d_8to24table, renderer, vid } from "./vid.js";
import { Cvar_SetValue } from "./cvar.js";
import { ca_dedicated, cls } from "./client.js";
import {
  GL_SubdivideSurface as GL_SubdivideSurface_warp,
  GL_Warp_SetLoadmodel,
  R_InitSky as R_InitSky_warp,
} from "./gl_warp.js";
import {
  GL_MakeAliasModelDisplayLists as GL_MakeAliasModelDisplayLists_mesh,
} from "./gl_mesh.js";
import { Mod_LoadMD5MeshModel as Mod_LoadMD5MeshModel_md5 } from "./gl_md5.js";
import { MIPLEVELS } from "./bspfile.js";
import { Con_Printf } from "./common.js";
import { Image_FindExternal, Image_LoadExternal } from "./image.js";
import {
  _allGameTextures,
  GL_RegisterTexture,
  GL_ResampleTexture8,
  GL_ScaledTextureSize,
  GL_SetTextureFilter,
} from "./glquake.js";

// Sky textures (set by R_InitSky during level load)
export let solidskytexture = null;
export let alphaskytexture = null;

/** Sets both sky layers (Mod_ClearAll clears them for the next map). */
export function set_skytextures(solid, alpha) {
  solidskytexture = solid;
  alphaskytexture = alpha;
}

// GL texture placeholder
export let r_notexture_mip = null;

// GL_LoadTexture: 8-bit paletted pixels -> THREE.DataTexture. Unlike GLQuake it
// doesn't dedupe by name: textures are owned per model and disposed in
// Mod_ClearAll; `name` only labels them for GPU debuggers.
// gl_picmip and gl_max_size shrink the upload as GL_Upload32 does; like
// GLQuake they take effect on the next map load. Texture coordinates are
// normalised by the miptex size, not the upload size, so they are unaffected.
// splitFullbright puts the fullbright pixels (palette 224-255) in a second
// texture, texture._fullbright. keepBase leaves them in the base texture too
// (alias skins: the fullbright texture's alpha is the mask the alias shader
// mixes by); without it they are blacked out of the base (world textures,
// drawn with the fullbright texture as an emissive map).
// fence marks a world cutout ('{') texture, passed with alpha set (Ironwail's
// TEXPREF_ALPHA): index 255 is transparent, TexMgr_AlphaEdgeFix recolours
// those texels, and texture._cutout tells gl_rsurf.js to alpha-test it. As in
// TexMgr_LoadImage8's "detect false alpha cases", a fence texture with no
// index 255 texel loads opaque.

export function GL_LoadTexture(
  name,
  width,
  height,
  data,
  mipmap,
  alpha,
  splitFullbright,
  keepBase = false,
  fence = false,
) {
  // Not in the C: a dedicated server never uploads or draws, so it keeps
  // the texture object (models still own and dispose one per texture) but
  // skips the resample, the 8-bit to RGBA conversion and the filter-update
  // registry (glquake.js scans it linearly per texture)
  if (cls.state === ca_dedicated) {
    const texture = new THREE.DataTexture(
      null,
      width,
      height,
      THREE.RGBAFormat,
    );
    texture.name = name;
    if (loadmodel != null) loadmodel._threeTextures.add(texture);
    return texture;
  }

  const scaled = GL_ScaledTextureSize(width, height);
  if (scaled.width !== width || scaled.height !== height) {
    data = GL_ResampleTexture8(
      data,
      width,
      height,
      scaled.width,
      scaled.height,
    );
    width = scaled.width;
    height = scaled.height;
  }

  // Convert 8-bit palette-indexed pixels to RGBA and create a THREE.DataTexture
  const rgba = new Uint8Array(width * height * 4);
  const fullbrightStart = vid.fullbright; // palette index 224+
  let hasFullbright = false;
  let hasTransparent = false;
  let fullbrightTexture = null;

  for (let i = 0; i < width * height; i++) {
    const palIdx = data[i];

    // gl_draw.c GL_Upload8 copies d_8to24table[ p ] for every texel; the
    // table's entry 255 has alpha 0 (VID_SetPalette), so a transparent
    // texel (MF_HOLEY skins, sprites) keeps the palette RGB for the filter
    // and mipmaps to blend, not black. Fence textures replace it below
    // (TexMgr_AlphaEdgeFix).
    const color = d_8to24table[palIdx];
    rgba[i * 4] = color & 0xff;
    rgba[i * 4 + 1] = (color >> 8) & 0xff;
    rgba[i * 4 + 2] = (color >> 16) & 0xff;

    if (alpha && palIdx === 255) {
      rgba[i * 4 + 3] = 0;
      hasTransparent = true;
    } else {
      rgba[i * 4 + 3] = 255;
      if (palIdx >= fullbrightStart) hasFullbright = true;
    }
  }

  // If texture has fullbright pixels (palette 224-255), create a separate
  // fullbright texture for use as emissiveMap. Fullbright pixels should render
  // at full intensity regardless of lighting (e.g. glowing buttons, lava).
  // Set fullbright pixels to BLACK in the base texture so they don't get
  // darkened by the lightmap, and put them in the fullbright texture instead.
  if (hasFullbright === true && splitFullbright === true) {
    const fbRgba = new Uint8Array(width * height * 4);

    for (let i = 0; i < width * height; i++) {
      const palIdx = data[i];

      if (palIdx >= fullbrightStart && !(alpha && palIdx === 255)) {
        // Copy to fullbright texture
        fbRgba[i * 4] = rgba[i * 4];
        fbRgba[i * 4 + 1] = rgba[i * 4 + 1];
        fbRgba[i * 4 + 2] = rgba[i * 4 + 2];
        fbRgba[i * 4 + 3] = 255;

        // Black out in base texture
        if (keepBase === false) {
          rgba[i * 4] = 0;
          rgba[i * 4 + 1] = 0;
          rgba[i * 4 + 2] = 0;
        }
      } else if (fence === true && palIdx !== 255) {
        // Ironwail's d_8to24table_fbright_fence: only index 255 is
        // transparent; the other non-fullbright texels are opaque black, so
        // TexMgr_AlphaEdgeFix averages them in. The emissive map reads RGB
        // only, so their alpha changes nothing else.
        fbRgba[i * 4 + 3] = 255;
      }
    }

    if (fence === true && hasTransparent === true) {
      TexMgr_AlphaEdgeFix(fbRgba, width, height);
    }

    fullbrightTexture = new THREE.DataTexture(
      fbRgba,
      width,
      height,
      THREE.RGBAFormat,
    );
    fullbrightTexture.name = name + ":fullbright";
    GL_SetTextureFilter(fullbrightTexture, mipmap);
    fullbrightTexture.wrapS = THREE.RepeatWrapping;
    fullbrightTexture.wrapT = THREE.RepeatWrapping;
    fullbrightTexture.generateMipmaps = mipmap;
    if (mipmap) fullbrightTexture.anisotropy = GL_TextureAnisotropy();
    fullbrightTexture.colorSpace = THREE.SRGBColorSpace;
    fullbrightTexture.needsUpdate = true;
    GL_RegisterTexture(fullbrightTexture);
    if (loadmodel != null) loadmodel._threeTextures.add(fullbrightTexture);
  }

  // Ironwail runs it on the 32-bit base level only (after the fullbright
  // black-out: the NOBRIGHT fence palette); its mipmaps are plain 2x2 RGBA
  // averages, as WebGL's generateMipmap makes.
  if (fence === true && hasTransparent === true) {
    TexMgr_AlphaEdgeFix(rgba, width, height);
  }

  const texture = new THREE.DataTexture(rgba, width, height, THREE.RGBAFormat);
  texture.name = name;
  if (fence === true && hasTransparent === true) texture._cutout = true;
  // gl_draw.c GL_Upload32: filters from gl_texturemode
  GL_SetTextureFilter(texture, mipmap);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.generateMipmaps = mipmap;
  if (mipmap) texture.anisotropy = GL_TextureAnisotropy();
  texture.colorSpace = THREE.SRGBColorSpace;
  // Note: flipY defaults to false for DataTexture, which is correct for Quake
  // Quake's UV T=0 at top + texture row 0 at V=0 means no flip is needed
  texture.needsUpdate = true;

  // Attach fullbright texture if one was created
  if (fullbrightTexture != null) {
    texture._fullbright = fullbrightTexture;
  }

  // Register for filter updates when setting changes
  GL_RegisterTexture(texture);
  if (loadmodel != null) loadmodel._threeTextures.add(texture);

  return texture;
}

/**
 * TexMgr_AlphaEdgeFix (Ironwail/QuakeSpasm gl_texmgr.c): "eliminate pink
 * edges". Each transparent texel takes the average RGB of its opaque
 * neighbours (all eight, wrapping at the edges), so filtering and mipmaps
 * blend towards the surrounding colour rather than palette entry 255. Works in
 * place on RGBA data, and reads texels it has already fixed, as the C does.
 */
export function TexMgr_AlphaEdgeFix(data, width, height) {
  let n = 0;
  let c0 = 0;
  let c1 = 0;
  let c2 = 0;
  let dest = 0;

  for (let i = 0; i < height; i++) {
    const lastrow = width * 4 * ((i === 0) ? height - 1 : i - 1);
    const thisrow = width * 4 * i;
    const nextrow = width * 4 * ((i === height - 1) ? 0 : i + 1);

    for (let j = 0; j < width; j++, dest += 4) {
      if (data[dest + 3] !== 0) continue; // not transparent

      const lastpix = 4 * ((j === 0) ? width - 1 : j - 1);
      const thispix = 4 * j;
      const nextpix = 4 * ((j === width - 1) ? 0 : j + 1);

      // the eight neighbours: three rows by three columns, less this texel
      for (let r = 0; r < 3; r++) {
        const row = r === 0 ? lastrow : (r === 1 ? thisrow : nextrow);
        for (let p = 0; p < 3; p++) {
          if (r === 1 && p === 1) continue;
          const b = row + (p === 0 ? lastpix : (p === 1 ? thispix : nextpix));
          if (data[b + 3] !== 0) {
            c0 += data[b];
            c1 += data[b + 1];
            c2 += data[b + 2];
            n++;
          }
        }
      }

      // average all non-transparent neighbors
      if (n !== 0) {
        data[dest] = (c0 / n) | 0;
        data[dest + 1] = (c1 / n) | 0;
        data[dest + 2] = (c2 / n) | 0;
        n =
          c0 =
          c1 =
          c2 =
            0;
      }
    }
  }
}

export function GL_SubdivideSurface(s) {
  // Not in the C: the warp polygons are drawing data a dedicated server
  // never reads
  if (cls.state === ca_dedicated) {
    return;
  }

  GL_Warp_SetLoadmodel(loadmodel);
  GL_SubdivideSurface_warp(s);
}

export function GL_MakeAliasModelDisplayLists(mod, hdr) {
  GL_MakeAliasModelDisplayLists_mesh(mod, hdr);
}

// gl_md5.js parses the rerelease's MD5 replacement and builds its GPU data
export function Mod_LoadMD5MeshModel(mod, meshText, animText) {
  return Mod_LoadMD5MeshModel_md5(mod, meshText, animText);
}

export function R_InitSky(tx) {
  // QuakeSpasm Sky_LoadTexture: the solid layer is the right half and the
  // alpha layer the left half, at whatever size the texture is (id assumed
  // 256x128). gl_warp.js R_InitSky warns for other sizes and returns null
  // when the texture is too small to split (width < 2 or height < 1).
  // tx.pixels starts at the mip level 0 data, so the offset is 0.
  const mt = {
    data: tx.pixels,
    offsets: [0],
    width: tx.width,
    height: tx.height,
    name: tx.name,
  };
  const result = R_InitSky_warp(mt, d_8to24table);
  if (result === null) {
    return; // as QuakeSpasm: no sky (Mod_ClearAll already cleared the last map's)
  }

  if (loadmodel != null) {
    loadmodel._threeTextures.add(result.solidTexture);
    loadmodel._threeTextures.add(result.alphaTexture);
  }
  solidskytexture = result.solidTexture;
  alphaskytexture = result.alphaTexture;
}

// gl_texture_anisotropy
//
// Deliberate deviation, from QuakeSpasm (gl_texmgr.c): anisotropic filtering
// for mipmapped textures. The default, 1, is off, as in GLQuake. QS clamps the
// cvar to [1, the driver's maximum] in a callback (TexMgr_Anisotropy_f) and
// re-filters every mipmapped texture; this port's cvars have no callbacks,
// so GL_CheckAnisotropy does it when the value changes (gl_rsurf.js
// R_DrawWorld calls it each frame). Three.js only applies anisotropy to
// textures whose min filter is *_MIPMAP_LINEAR and mag filter isn't
// GL_NEAREST, so it shows only with such a gl_texturemode.

export const gl_texture_anisotropy = {
  name: "gl_texture_anisotropy",
  string: "1",
  value: 1,
  archive: true,
};
let _appliedAnisotropy = 1;

function GL_MaxAnisotropy() {
  // Three returns 0 without EXT_texture_filter_anisotropic; QS's floor is 1.
  return renderer !== null ?
    Math.max(renderer.capabilities.getMaxAnisotropy(), 1) :
    1;
}

function GL_TextureAnisotropy(maxAnisotropy = GL_MaxAnisotropy()) {
  return Math.min(Math.max(gl_texture_anisotropy.value, 1), maxAnisotropy);
}

// TexMgr_Anisotropy_f. maxAnisotropy is the driver limit; tests pass it in.
export function GL_CheckAnisotropy(maxAnisotropy = GL_MaxAnisotropy()) {
  if (gl_texture_anisotropy.value === _appliedAnisotropy) {
    return;
  }

  if (gl_texture_anisotropy.value < 1) {
    Cvar_SetValue("gl_texture_anisotropy", 1);
  } else if (gl_texture_anisotropy.value > maxAnisotropy) {
    Cvar_SetValue("gl_texture_anisotropy", maxAnisotropy);
  }

  _appliedAnisotropy = gl_texture_anisotropy.value;
  const anisotropy = GL_TextureAnisotropy(maxAnisotropy);
  for (const texture of _allGameTextures) {
    if (
      texture !== null && texture.generateMipmaps === true &&
      texture.anisotropy !== anisotropy
    ) {
      texture.anisotropy = anisotropy;
      texture.needsUpdate = true;
    }
  }
}

// External textures: QuakeSpasm gl_model.c Mod_LoadTextures loads the found
// image with TexMgr_LoadImage in place of the 8-bit one, and its _glow or
// _luma image as the fullbright layer (tx->fullbright). mod_brush.js chooses
// the files for world textures, mod_alias.js for skins (QSS naming).

// The installs still running (GL_WaitExternalTextures)
const pendingExternal = new Set();

// The fullbright layer's pixel for "no fullbrights": black for a world
// texture's emissive map, transparent for an alias skin's mask
const NO_GLOW = new Uint8Array([0, 0, 0, 255]);
const NO_GLOW_MASK = new Uint8Array([0, 0, 0, 0]);

/**
 * Replaces texture, made by GL_LoadTexture from the 8-bit pixels, with the
 * image file base (Image_FindExternal), and its fullbright layer with the
 * image file glow (base's _glow or _luma, or null). mask is true for an alias
 * skin, whose fullbright layer is a mask (GL_GlowMask).
 *
 * Deliberate deviations from QuakeSpasm:
 * - The images are fetched and decoded after the load (pak.js defers image
 *   files, and the browser decodes png and jpg only asynchronously), so the
 *   8-bit texture shows until they arrive. They are then written into the same
 *   texture objects, so the materials already made with them need no change.
 * - A glow image on a texture with no fullbright pixels gets a blank
 *   fullbright layer now, for the same reason.
 * - gl_picmip and gl_max_size don't shrink the images.
 */
export function GL_LoadExternalTexture(texture, base, glow, mask) {
  const mod = loadmodel;
  if (glow !== null && texture._fullbright === undefined) {
    const fullbright = new THREE.DataTexture(
      mask === true ? NO_GLOW_MASK : NO_GLOW,
      1,
      1,
      THREE.RGBAFormat,
    );
    fullbright.name = texture.name + ":fullbright";
    GL_SetTextureFilter(fullbright, true);
    fullbright.wrapS = THREE.RepeatWrapping;
    fullbright.wrapT = THREE.RepeatWrapping;
    fullbright.generateMipmaps = true;
    fullbright.anisotropy = GL_TextureAnisotropy();
    fullbright.colorSpace = THREE.SRGBColorSpace;
    fullbright.needsUpdate = true;
    GL_RegisterTexture(fullbright);
    if (mod != null) mod._threeTextures.add(fullbright);
    texture._fullbright = fullbright;
  }

  const install = GL_InstallExternalTexture(mod, texture, base, glow, mask);
  pendingExternal.add(install);
  install.finally(() => pendingExternal.delete(install));
}

/**
 * External alias skins, which QuakeSpasm and Ironwail don't have for .mdl:
 * QSS gl_model.c Mod_LoadAllSkins' DarkPlaces naming, name being
 * <model>_<skinnum> (progs/player.mdl_0), with name_glow, else name_luma, as
 * the fullbright layer. As in QSS, only single skins are looked for, not skin
 * groups. Not ported: QSS's gl_load24bit cvar (default 1), and the _pants and
 * _shirt layers. R_TranslatePlayerSkin builds a coloured player's skin from
 * the 8-bit texels, so that keeps the original skin.
 */
export function GL_LoadExternalSkin(texture, name) {
  const base = Image_FindExternal(name);
  if (base === null) {
    return;
  }

  let glow = Image_FindExternal(name + "_glow");
  if (glow === null) {
    glow = Image_FindExternal(name + "_luma");
  }

  GL_LoadExternalTexture(texture, base, glow, true);
}

/** Resolves when every external texture asked for so far is in place. */
export async function GL_WaitExternalTextures() {
  while (pendingExternal.size > 0) {
    await Promise.all(pendingExternal);
  }
}

async function GL_InstallExternalTexture(mod, texture, base, glow, mask) {
  try {
    const images = await Promise.all([
      Image_LoadExternal(base),
      glow !== null ? Image_LoadExternal(glow) : null,
    ]);
    const image = images[0];
    const glowImage = images[1];

    // Mod_ClearAll freed the model while the images were fetched
    if (mod != null && mod._threeTextures.has(texture) === false) {
      return;
    }
    if (image === null) {
      Con_Printf("Couldn't load " + base + "\n");
      return;
    }

    GL_SetTextureImage(texture, image.data, image.width, image.height);

    // QuakeSpasm: an external image's fullbright layer is its glow image or
    // none; the 8-bit pixels' fullbrights don't apply to it
    const fullbright = texture._fullbright;
    if (fullbright === undefined) {
      return;
    }
    if (glowImage !== null) {
      GL_SetTextureImage(
        fullbright,
        mask === true ? GL_GlowMask(glowImage.data) : glowImage.data,
        glowImage.width,
        glowImage.height,
      );
    } else {
      GL_SetTextureImage(
        fullbright,
        mask === true ? NO_GLOW_MASK : NO_GLOW,
        1,
        1,
      );
    }
  } catch (e) {
    Con_Printf("Couldn't load " + base + ": " + e.message + "\n");
  }
}

// New RGBA pixels, top row first, for a texture already in use. Disposing
// it first frees the GL texture, so the next draw allocates one of the new
// size; the materials keep the texture object.
function GL_SetTextureImage(texture, data, width, height) {
  texture.dispose();
  texture.image = { data: data, width: width, height: height };
  texture.needsUpdate = true;
}

/**
 * An alias skin's fullbright mask from a _glow or _luma image. The alias
 * shader (gl_mesh.js AliasMaterial) shows the skin unlit by the mask's alpha,
 * where QSS adds the glow image's colour to the lit skin, so the alpha is the
 * glow's brightest channel: the skin glows where the glow image is bright.
 * Deliberate deviation: a glow colour unlike the skin's is not shown.
 */
export function GL_GlowMask(data) {
  const mask = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i += 4) {
    const m = Math.max(data[i], data[i + 1], data[i + 2]);
    mask[i + 3] = (m * data[i + 3] + 127) / 255 | 0;
  }
  return mask;
}

// R_InitTextures

export function R_InitTextures() {
  if (r_notexture_mip != null && r_notexture_mip.gl_texture != null) {
    return r_notexture_mip;
  }

  const fallback = new texture_t();
  fallback.name = "notexture";
  fallback.width = 16;
  fallback.height = 16;

  const totalSize = 16 * 16 + 8 * 8 + 4 * 4 + 2 * 2;
  fallback.pixels = new Uint8Array(totalSize);
  fallback.offsets[0] = 0;
  fallback.offsets[1] = 16 * 16;
  fallback.offsets[2] = fallback.offsets[1] + 8 * 8;
  fallback.offsets[3] = fallback.offsets[2] + 4 * 4;

  for (let m = 0; m < MIPLEVELS; m++) {
    const size = 16 >> m;
    const half = 8 >> m;
    let offset = fallback.offsets[m];
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const alternate = (y < half) !== (x < half);
        fallback.pixels[offset++] = alternate === true ? 0 : 0xff;
      }
    }
  }

  const rgba = new Uint8Array(16 * 16 * 4);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const index = (y * 16 + x) * 4;
      const alternate = (y < 8) !== (x < 8);
      rgba[index] = alternate === true ? 255 : 0;
      rgba[index + 1] = 0;
      rgba[index + 2] = alternate === true ? 255 : 0;
      rgba[index + 3] = 255;
    }
  }

  const texture = new THREE.DataTexture(rgba, 16, 16, THREE.RGBAFormat);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.needsUpdate = true;
  fallback.gl_texture = texture;

  r_notexture_mip = fallback;
  return r_notexture_mip;
}
