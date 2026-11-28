// Tiny generated music files for the music tests: a ProTracker module with
// one square-wave sample, and Unreal packages (.umx) that wrap a payload as
// snd_umx.c expects. Nothing here comes from a real game.

/** A 4-channel "M.K." module: one pattern, a C-2 on each row's channel 1 */
export function makeMOD(rows = 64) {
  const sampleLength = 64; // bytes; stored in words
  const patterns = 1;
  const out = new Uint8Array(1084 + patterns * 1024 + sampleLength);
  const title = "icaro test";
  for (let i = 0; i < title.length; i++) out[i] = title.charCodeAt(i);

  // sample 1: length, finetune 0, volume 64, loop over the whole sample
  const s1 = 20;
  out[s1 + 22] = (sampleLength / 2) >> 8;
  out[s1 + 23] = (sampleLength / 2) & 0xff;
  out[s1 + 25] = 64;
  out[s1 + 26] = 0;
  out[s1 + 27] = 0;
  out[s1 + 28] = (sampleLength / 2) >> 8;
  out[s1 + 29] = (sampleLength / 2) & 0xff;
  // the other 30 samples: loop length 1 word, as trackers write empty ones
  for (let i = 1; i < 31; i++) out[20 + i * 30 + 29] = 1;

  out[950] = 1; // song length
  out[951] = 127;
  out[952] = 0; // order 0 plays pattern 0
  out.set([0x4d, 0x2e, 0x4b, 0x2e], 1080); // "M.K."

  // a C-2 (period 428) of sample 1 every 4 rows on channel 1
  const period = 428;
  for (let row = 0; row < Math.min(rows, 64); row += 4) {
    const at = 1084 + row * 16;
    out[at] = (1 & 0xf0) | (period >> 8);
    out[at + 1] = period & 0xff;
    out[at + 2] = (1 & 0x0f) << 4;
  }

  // a square wave
  const sample = 1084 + patterns * 1024;
  for (let i = 0; i < sampleLength; i++) {
    out[sample + i] = i < sampleLength / 2 ? 0x40 : 0xc0;
  }
  return out;
}

/** A minimal RIFF WAVE file of silence */
export function makeWAV(frames = 64) {
  const out = new Uint8Array(44 + frames * 2);
  const view = new DataView(out.buffer);
  const tag = (at, s) => {
    for (let i = 0; i < 4; i++) out[at + i] = s.charCodeAt(i);
  };
  tag(0, "RIFF");
  view.setUint32(4, 36 + frames * 2, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 11025, true);
  view.setUint32(28, 22050, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, "data");
  view.setUint32(40, frames * 2, true);
  return out;
}

/** FCompactIndex bytes for v */
export function fci(v) {
  const negative = v < 0;
  let a = Math.abs(v);
  let b0 = a & 0x3f;
  if (negative) b0 |= 0x80;
  a >>>= 6;
  if (a !== 0) b0 |= 0x40;
  const out = [b0];
  while (a !== 0) {
    let b = a & 0x7f;
    a >>>= 7;
    if (a !== 0) b |= 0x80;
    out.push(b);
  }
  return out;
}

/**
 * An Unreal package with one export of class typeName ("MOD", "S3M", "IT",
 * "XM", "WAV" or "MP2") holding payload. version picks the name table and
 * export layouts snd_umx.c handles (61: Unreal, 68: Unreal Tournament).
 * claimedSize is the object size written in the export's header.
 */
export function makeUMX(
  payload,
  typeName,
  version = 61,
  claimedSize = payload.length,
) {
  const names = ["None", "Music", typeName, "IcaroTune"];
  const nameBytes = [];
  for (const name of names) {
    if (version >= 64) nameBytes.push(name.length + 1);
    for (let i = 0; i < name.length; i++) nameBytes.push(name.charCodeAt(i));
    nameBytes.push(0, 0, 0, 0, 0); // terminator, int32 flags
  }

  // the export's data: (version < 40 and < 60 prefixes not built here)
  // junk index, type_name index, (export size when > 61), object size
  const objectHeader = [...fci(0), ...fci(2)];
  if (version > 61) objectHeader.push(0, 0, 0, 0);
  objectHeader.push(...fci(claimedSize));

  const nameOffset = 64;
  const serialOffset = nameOffset + nameBytes.length;
  const serialSize = objectHeader.length + payload.length;
  const exportOffset = serialOffset + serialSize;

  const exportBytes = [...fci(-2), ...fci(0)]; // class (an import), super
  if (version >= 60) exportBytes.push(0, 0, 0, 0); // package index
  exportBytes.push(...fci(3)); // object name
  exportBytes.push(0, 0, 0, 0); // object flags
  exportBytes.push(...fci(serialSize), ...fci(serialOffset));
  const importOffset = exportOffset + exportBytes.length;

  const out = new Uint8Array(importOffset + 16);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x9e2a83c1, true);
  view.setInt32(4, version, true);
  view.setInt32(12, names.length, true);
  view.setInt32(16, nameOffset, true);
  view.setInt32(20, 1, true);
  view.setInt32(24, exportOffset, true);
  view.setInt32(28, 0, true);
  view.setInt32(32, importOffset, true);
  out.set(nameBytes, nameOffset);
  out.set(objectHeader, serialOffset);
  out.set(payload, serialOffset + objectHeader.length);
  out.set(exportBytes, exportOffset);
  return { bytes: out, offset: serialOffset + objectHeader.length };
}
