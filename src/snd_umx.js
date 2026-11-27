// Ported from: QuakeSpasm Quake/snd_umx.c -- Unreal UMX container support
// (O. Sezer, GPL-2.0-or-later; UPKG parsing partially based on Andy Ward's
// Unreal Media Ripper). https://github.com/sezero/quakespasm
//
// A .umx is an Unreal package whose one export is a tracker module (or a
// WAV/MP2 stream). This finds that export, as S_UMX_CodecOpenStream does,
// so the music player can hand the inner bytes to the matching decoder.
// Deviation: C reads through a file handle and can read past what it
// checked; here every read is bounds-checked against the buffer, and a read
// past the end sees zeros, as the C memsets its buffers before reading.

const UPKG_HDR_TAG = 0x9e2a83c1;
const UPKG_HDR_SIZE = 64;

const UMUSIC_IT = 0;
const UMUSIC_S3M = 1;
const UMUSIC_XM = 2;
const UMUSIC_MOD = 3;
const UMUSIC_WAV = 4;
const UMUSIC_MP2 = 5;

/** mustype[] in snd_umx.c, lower-cased: the format of each UMUSIC_* type */
export const UMX_TYPES = ["it", "s3m", "xm", "mod", "wav", "mp2"];

/** A byte, or 0 past the end of the buffer */
function byteAt(data, pos) {
  return pos >= 0 && pos < data.length ? data[pos] : 0;
}

function int32At(data, pos) {
  return (byteAt(data, pos) | (byteAt(data, pos + 1) << 8) |
    (byteAt(data, pos + 2) << 16) | (byteAt(data, pos + 3) << 24));
}

/** Whether the bytes at pos spell str */
function matchAt(data, pos, str) {
  for (let i = 0; i < str.length; i++) {
    if (byteAt(data, pos + i) !== str.charCodeAt(i)) {
      return false;
    }
  }
  return true;
}

/**
 * get_fci: decodes an FCompactIndex at data[cursor.pos] and advances
 * cursor.pos past it.
 */
export function UMX_GetFCI(data, cursor) {
  const pos = cursor.pos;
  const b0 = byteAt(data, pos);
  let size = 1;
  let a = b0 & 0x3f;

  if (b0 & 0x40) {
    size++;
    const b1 = byteAt(data, pos + 1);
    a |= (b1 & 0x7f) << 6;
    if (b1 & 0x80) {
      size++;
      const b2 = byteAt(data, pos + 2);
      a |= (b2 & 0x7f) << 13;
      if (b2 & 0x80) {
        size++;
        const b3 = byteAt(data, pos + 3);
        a |= (b3 & 0x7f) << 20;
        if (b3 & 0x80) {
          size++;
          a |= (byteAt(data, pos + 4) & 0x3f) << 27;
        }
      }
    }
  }

  if (b0 & 0x80) {
    a = -a;
  }

  cursor.pos += size;
  return a | 0;
}

/** get_objtype: checks the export's data really is the format it claims */
function getObjType(data, ofs, type) {
  for (;;) {
    if (type === UMUSIC_IT) {
      return matchAt(data, ofs, "IMPM") ? UMUSIC_IT : -1;
    }

    if (type === UMUSIC_XM) {
      if (!matchAt(data, ofs, "Extended Module:")) return -1;
      if (byteAt(data, ofs + 16) !== 0x20) return -1;
      if (byteAt(data, ofs + 32 + 5) !== 0x1a) return -1;
      return UMUSIC_XM;
    }

    if (type === UMUSIC_MP2) {
      const u = ((byteAt(data, ofs) << 8) | byteAt(data, ofs + 1)) & 0xfffe;
      return (u === 0xfffc || u === 0xfff4) ? UMUSIC_MP2 : -1;
    }

    if (type === UMUSIC_WAV) {
      return (matchAt(data, ofs, "RIFF") && matchAt(data, ofs + 8, "WAVE")) ?
        UMUSIC_WAV :
        -1;
    }

    if (type === UMUSIC_S3M) {
      if (matchAt(data, ofs + 44, "SCRM")) return UMUSIC_S3M;
      // SpaceMarines.umx and Starseek.umx from Return to NaPali report as
      // "s3m" whereas the actual music format is "it"
      type = UMUSIC_IT;
      continue;
    }

    if (type === UMUSIC_MOD) {
      return (matchAt(data, ofs + 1080, "M.K.") ||
          matchAt(data, ofs + 1080, "M!K!")) ?
        UMUSIC_MOD :
        -1;
    }

    return -1;
  }
}

/**
 * read_export: skips the export's object header at ofs; returns its
 * type_name index, the data offset and the data size, or null.
 */
function readExport(data, version, ofs) {
  // C reads 40 bytes here and fails on a short read
  if (ofs + 40 > data.length) return null;

  const cursor = { pos: ofs };
  if (version < 40) cursor.pos += 8;
  if (version < 60) cursor.pos += 16;
  UMX_GetFCI(data, cursor); // skip junk
  const t = UMX_GetFCI(data, cursor); // type_name
  if (version > 61) cursor.pos += 4; // skip export size
  const size = UMX_GetFCI(data, cursor);
  return { type: t, ofs: cursor.pos, size };
}

/** read_typname: the name table's entry idx, or null */
function readTypeName(data, header, idx) {
  if (idx < 0 || idx >= header.nameCount) return null;

  let l = 0;
  let start = 0;
  for (let i = 0; i <= idx; i++) {
    start = header.nameOffset + l;
    if (start >= data.length) return null;
    if (header.version >= 64) {
      // numchars *including* terminator
      const s = (byteAt(data, start) << 24) >> 24;
      if (s <= 0) return null;
      l += s + 5; // 1 for buf[0], 4 for int32_t name_flags
    } else {
      let n = 0;
      while (n < 63 && byteAt(data, start + n) !== 0) n++;
      l += n + 5; // 1 for terminator, 4 for int32_t name_flags
    }
  }

  // C copies at most 63 bytes, up to the first NUL
  let name = "";
  const from = header.version >= 64 ? start + 1 : start;
  const end = start + 63;
  for (let p = from; p < end; p++) {
    const c = byteAt(data, p);
    if (c === 0) break;
    name += String.fromCharCode(c);
  }
  return name;
}

/** probe_header: the package header, or null if it isn't one */
function probeHeader(data) {
  if (data.length < UPKG_HDR_SIZE) return null;
  if ((int32At(data, 0) >>> 0) !== UPKG_HDR_TAG) return null;

  const header = {
    version: int32At(data, 4),
    nameCount: int32At(data, 12),
    nameOffset: int32At(data, 16),
    exportCount: int32At(data, 20),
    exportOffset: int32At(data, 24),
    importCount: int32At(data, 28),
    importOffset: int32At(data, 32),
  };

  if (
    header.nameCount < 0 || header.exportCount < 0 ||
    header.importCount < 0 || header.nameOffset < 36 ||
    header.exportOffset < 36 || header.importOffset < 36
  ) {
    return null;
  }

  return header;
}

/**
 * process_upkg / probe_umx: finds the music in a .umx file's bytes.
 * Returns { type, offset, size } where type is one of UMX_TYPES and the
 * music is data.subarray(offset, offset + size), or null for a file that
 * isn't a UMX with music the reference would play.
 */
export function UMX_FindMusic(data) {
  const header = probeHeader(data);
  if (header === null) return null;

  const fsiz = data.length;
  if (
    header.nameOffset >= fsiz || header.exportOffset >= fsiz ||
    header.importOffset >= fsiz
  ) {
    return null;
  }

  // The offset and size of the first IT, S3M or XM, from the exports
  // table. A umx should have only one export; Kran32.umx from Unreal has
  // two, both pointing to the same music.
  const cursor = { pos: header.exportOffset };
  UMX_GetFCI(data, cursor); // skip class_index
  UMX_GetFCI(data, cursor); // skip super_index
  if (header.version >= 60) cursor.pos += 4; // skip int32 package_index
  UMX_GetFCI(data, cursor); // skip object_name
  cursor.pos += 4; // skip int32 object_flags
  const serialSize = UMX_GetFCI(data, cursor);
  if (serialSize <= 0) return null;
  const serialOffset = UMX_GetFCI(data, cursor);
  if (serialOffset < 0 || serialOffset > fsiz - 40) return null;

  const exp = readExport(data, header.version, serialOffset);
  if (exp === null || exp.type < 0) return null;
  if (exp.size <= 0 || exp.size > fsiz - exp.ofs) return null;

  const name = readTypeName(data, header, exp.type);
  if (name === null) return null;

  const claimed = UMX_TYPES.indexOf(name.toLowerCase());
  if (claimed < 0) return null;

  const type = getObjType(data, exp.ofs, claimed);
  if (type < 0) return null;

  return { type: UMX_TYPES[type], offset: exp.ofs, size: exp.size };
}
