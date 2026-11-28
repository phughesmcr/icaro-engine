// Ported from: QuakeSpasm Quake/image.c (Image_LoadTGA) and Ironwail
// Quake/image.c (Image_LoadImage) -- loading external images
//
// The skyboxes (gl_sky.js) read targa only: the 2021 rerelease add-ons ship
// their skyboxes as .tga. External textures (Image_FindExternal,
// Image_LoadExternal) also take png and jpg, decoded by the browser.

import { Con_Printf } from "./common.js";
import { COM_EnsureFile, COM_FileExists, COM_FindFile } from "./pak.js";

/**
 * returns { data, width, height }, data being RGBA top to bottom, or null.
 *
 * Ironwail tries name.png, .tga and .jpg (through stb_image), then .pcx and
 * .lmp. Only .tga is ported: the browser decodes png and jpg only
 * asynchronously, and each name tried and missing is a loose-file request
 * (COM_EnsureFile). The caller makes sure the file has been fetched.
 */
export function Image_LoadImage(name) {
  const loadfilename = name + ".tga";
  const file = COM_FindFile(loadfilename);
  if (file === null) {
    return null;
  }

  return Image_LoadTGA(file.data.subarray(0, file.size), loadfilename);
}

// External textures (mod_brush.js Mod_LoadTextures, mod_alias.js skins,
// through gl_model_upload.js GL_LoadExternalTexture)

/**
 * Ironwail image.c Image_LoadImage's order for the formats a browser can
 * decode: png, tga, jpg (pcx and lmp are not looked for).
 */
export const IMAGE_EXTENSIONS = [".png", ".tga", ".jpg"];

/**
 * The first of name.png, name.tga and name.jpg in the search path, or null.
 *
 * Deliberate deviation: Ironwail opens each name in turn; this asks only the
 * directories of the paks in the search path (the player's own paks too) and
 * the virtual files (COM_FileExists), never the server, so a map whose
 * textures have no replacement costs no request. A loose image, on the
 * server (static/textures/) or among the player's imported loose files, is
 * therefore not found: replacements go in a pak.
 */
export function Image_FindExternal(name) {
  for (let i = 0; i < IMAGE_EXTENSIONS.length; i++) {
    const filename = name + IMAGE_EXTENSIONS[i];
    if (COM_FileExists(filename) >= 0) {
      return filename;
    }
  }

  return null;
}

/**
 * Fetches (from its pak, if deferred) and decodes filename, one that
 * Image_FindExternal returned. Resolves to { data, width, height }, data RGBA
 * top row first, or null. A .tga is read by Image_LoadTGA; .png and .jpg by
 * the browser (Image_DecodeBrowser), so not under Deno.
 */
export async function Image_LoadExternal(filename) {
  if (await COM_EnsureFile(filename) === false) {
    return null;
  }

  const file = COM_FindFile(filename);
  if (file === null) {
    return null;
  }

  const buf = file.data.subarray(0, file.size);
  if (filename.endsWith(".tga")) {
    return Image_LoadTGA(buf, filename);
  }

  return await Image_DecodeBrowser(
    buf,
    filename.endsWith(".png") ? "image/png" : "image/jpeg",
    filename,
  );
}

/**
 * Not in the C: decodes a png or jpg with createImageBitmap and reads its
 * pixels back through an OffscreenCanvas. Resolves to { data, width, height }
 * or null (with a message), and to null where there is no OffscreenCanvas
 * (Deno). The canvas stores premultiplied colour, so a half-transparent
 * texel's colour may come back off by a step.
 */
async function Image_DecodeBrowser(buf, type, filename) {
  if (
    typeof createImageBitmap !== "function" ||
    typeof OffscreenCanvas !== "function"
  ) {
    return null;
  }

  let bitmap = null;
  try {
    bitmap = await createImageBitmap(new Blob([buf], { type: type }), {
      premultiplyAlpha: "none",
      colorSpaceConversion: "none",
    });
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    const pixels = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    return {
      data: new Uint8Array(pixels.data.buffer),
      width: bitmap.width,
      height: bitmap.height,
    };
  } catch (e) {
    Con_Printf("Couldn't decode " + filename + ": " + e.message + "\n");
    return null;
  } finally {
    if (bitmap !== null) bitmap.close();
  }
}

// Targa

/**
 * Reads an uncompressed paletted (type 1), truecolor (2) or grayscale (3)
 * targa, or a run-length encoded truecolor one (10), at 24 or 32 bits per
 * pixel. Returns { data, width, height } with data RGBA, top row first, or
 * null.
 *
 * Deliberate deviation: QuakeSpasm calls Sys_Error for an unsupported targa,
 * which ends the game for a bad skybox face. This warns and returns null, as
 * Ironwail (stb_image) does. Reads past the end of the file give 0 rather
 * than C's EOF.
 */
export function Image_LoadTGA(buf, loadfilename = "") {
  if (buf.length < 18) {
    Con_Printf("Image_LoadTGA: " + loadfilename + " is too short\n");
    return null;
  }

  const id_length = buf[0];
  const colormap_type = buf[1];
  const image_type = buf[2];
  // colormap_index (buf[ 3 ], buf[ 4 ]) is unused, as in QuakeSpasm
  const colormap_length = buf[5] | (buf[6] << 8);
  const colormap_size = buf[7];
  // x_origin, y_origin (buf[ 8 ] to buf[ 11 ]) are unused, as in QuakeSpasm
  const width = buf[12] | (buf[13] << 8);
  const height = buf[14] | (buf[15] << 8);
  const pixel_size = buf[16];
  const attributes = buf[17];

  if (image_type === 1) {
    if (pixel_size !== 8 || colormap_size !== 24 || colormap_length > 256) {
      Con_Printf(
        "Image_LoadTGA: " + loadfilename + " has an " + colormap_size +
          "bit palette\n",
      );
      return null;
    }
  } else {
    if (image_type !== 2 && image_type !== 3 && image_type !== 10) {
      Con_Printf(
        "Image_LoadTGA: " + loadfilename +
          " is not a type 2, 3, or 10 targa (" + image_type + ")\n",
      );
      return null;
    }

    if (image_type === 3) {
      if (colormap_type !== 0 || pixel_size !== 8) {
        Con_Printf(
          "Image_LoadTGA: " + loadfilename + " is not a 8bit grayscale targa\n",
        );
        return null;
      }
    } else if (
      colormap_type !== 0 || (pixel_size !== 32 && pixel_size !== 24)
    ) {
      Con_Printf(
        "Image_LoadTGA: " + loadfilename + " is not a 24bit or 32bit targa\n",
      );
      return null;
    }
  }

  const columns = width;
  const rows = height;
  const upside_down = (attributes & 0x20) === 0; //johnfitz -- fix for upside-down targas

  const targa_rgba = new Uint8Array(columns * rows * 4);

  let pos = 18 + id_length; // skip TARGA image comment
  const end = buf.length;
  const getc = () => (pos < end ? buf[pos++] : 0);

  if (image_type === 1) { // Uncompressed, paletted images
    const palette = new Uint8Array(256 * 4);
    // palette data comes first
    for (let i = 0; i < colormap_length; i++) {
      // this palette data is bgr.
      palette[i * 4 + 2] = getc();
      palette[i * 4 + 1] = getc();
      palette[i * 4 + 0] = getc();
      palette[i * 4 + 3] = 255;
    }

    for (let row = rows - 1; row >= 0; row--) {
      const realrow = upside_down ? row : rows - 1 - row;
      let pixbuf = realrow * columns * 4;

      for (let column = 0; column < columns; column++) {
        const i = getc();
        targa_rgba[pixbuf++] = palette[i * 4 + 0];
        targa_rgba[pixbuf++] = palette[i * 4 + 1];
        targa_rgba[pixbuf++] = palette[i * 4 + 2];
        targa_rgba[pixbuf++] = palette[i * 4 + 3];
      }
    }
  } else if (image_type === 2) { // Uncompressed, RGB images
    for (let row = rows - 1; row >= 0; row--) {
      //johnfitz -- fix for upside-down targas
      const realrow = upside_down ? row : rows - 1 - row;
      let pixbuf = realrow * columns * 4;
      //johnfitz
      for (let column = 0; column < columns; column++) {
        const blue = getc();
        const green = getc();
        const red = getc();
        const alphabyte = pixel_size === 32 ? getc() : 255;
        targa_rgba[pixbuf++] = red;
        targa_rgba[pixbuf++] = green;
        targa_rgba[pixbuf++] = blue;
        targa_rgba[pixbuf++] = alphabyte;
      }
    }
  } else if (image_type === 3) { // Uncompressed grayscale images
    for (let row = rows - 1; row >= 0; row--) {
      const realrow = upside_down ? row : rows - 1 - row;
      let pixbuf = realrow * columns * 4;

      for (let column = 0; column < columns; column++) {
        const gray = getc();
        targa_rgba[pixbuf++] = gray; // R
        targa_rgba[pixbuf++] = gray; // G
        targa_rgba[pixbuf++] = gray; // B
        targa_rgba[pixbuf++] = 255; // A
      }
    }
  } else { // image_type 10: Runlength encoded RGB images
    let red = 0, green = 0, blue = 0, alphabyte = 0;
    breakOut:
    for (let row = rows - 1; row >= 0; row--) {
      //johnfitz -- fix for upside-down targas
      let realrow = upside_down ? row : rows - 1 - row;
      let pixbuf = realrow * columns * 4;
      //johnfitz
      for (let column = 0; column < columns;) {
        const packetHeader = getc();
        const packetSize = 1 + (packetHeader & 0x7f);
        if (packetHeader & 0x80) { // run-length packet
          blue = getc();
          green = getc();
          red = getc();
          alphabyte = pixel_size === 32 ? getc() : 255;

          for (let j = 0; j < packetSize; j++) {
            targa_rgba[pixbuf++] = red;
            targa_rgba[pixbuf++] = green;
            targa_rgba[pixbuf++] = blue;
            targa_rgba[pixbuf++] = alphabyte;
            column++;
            if (column === columns) { // run spans across rows
              column = 0;
              if (row > 0) {
                row--;
              } else {
                break breakOut;
              }
              //johnfitz -- fix for upside-down targas
              realrow = upside_down ? row : rows - 1 - row;
              pixbuf = realrow * columns * 4;
              //johnfitz
            }
          }
        } else { // non run-length packet
          for (let j = 0; j < packetSize; j++) {
            blue = getc();
            green = getc();
            red = getc();
            alphabyte = pixel_size === 32 ? getc() : 255;
            targa_rgba[pixbuf++] = red;
            targa_rgba[pixbuf++] = green;
            targa_rgba[pixbuf++] = blue;
            targa_rgba[pixbuf++] = alphabyte;
            column++;
            if (column === columns) { // pixel packet run spans across rows
              column = 0;
              if (row > 0) {
                row--;
              } else {
                break breakOut;
              }
              //johnfitz -- fix for upside-down targas
              realrow = upside_down ? row : rows - 1 - row;
              pixbuf = realrow * columns * 4;
              //johnfitz
            }
          }
        }
      }
    }
  }

  return { data: targa_rgba, width, height };
}
