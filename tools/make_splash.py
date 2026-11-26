#!/usr/bin/env python3
"""Writes the iOS launch images: static/icon.png centred on black.

iOS shows an apple-touch-startup-image while a Home Screen app starts, but only
if the image has exactly the screen's size in pixels, so there is one per screen
size and orientation. Android builds its splash screen from the manifest.

Run from the repository root:

    python3 tools/make_splash.py

It writes static/splash/<width>x<height>.png and rewrites the <link> tags
between the "splash" marker comments in index.html. Standard library only; not
linted or run in CI (tests/manifest_test.js checks the output).
"""

import pathlib
import re
import struct
import zlib

# Portrait screens as (CSS width, CSS height, device pixel ratio)
SCREENS = [
    # iPhone
    (375, 667, 2),
    (414, 736, 3),
    (375, 812, 3),
    (414, 896, 2),
    (414, 896, 3),
    (390, 844, 3),
    (428, 926, 3),
    (393, 852, 3),
    (430, 932, 3),
    (402, 874, 3),
    (420, 912, 3),
    (440, 956, 3),
    # iPad
    (744, 1133, 2),
    (768, 1024, 2),
    (810, 1080, 2),
    (820, 1180, 2),
    (834, 1112, 2),
    (834, 1194, 2),
    (834, 1210, 2),
    (1024, 1366, 2),
    (1032, 1376, 2),
]

ICON_FRACTION = 0.4  # of the screen's short side, never above the source size

ROOT = pathlib.Path(__file__).resolve().parent.parent
ICON = ROOT / "static" / "icon.png"
OUT = ROOT / "static" / "splash"
INDEX = ROOT / "index.html"
BEGIN = "<!-- splash: written by tools/make_splash.py -->"
END = "<!-- /splash -->"


def read_png_rgb(path):
    """Decodes an 8-bit RGB, non-interlaced PNG to a list of row bytes."""
    data = path.read_bytes()
    width, height, depth, colour, _, _, interlace = struct.unpack(
        ">IIBBBBB", data[16:29])
    if (depth, colour, interlace) != (8, 2, 0):
        raise SystemExit(f"{path}: expected 8-bit RGB without interlacing")

    idat = b""
    pos = 8
    while pos < len(data):
        length, kind = struct.unpack(">I4s", data[pos:pos + 8])
        if kind == b"IDAT":
            idat += data[pos + 8:pos + 8 + length]
        pos += 12 + length

    raw = zlib.decompress(idat)
    stride = width * 3
    rows = []
    previous = bytearray(stride)
    for y in range(height):
        start = y * (stride + 1)
        kind = raw[start]
        row = bytearray(raw[start + 1:start + 1 + stride])
        for i in range(stride):
            a = row[i - 3] if i >= 3 else 0
            b = previous[i]
            c = previous[i - 3] if i >= 3 else 0
            if kind == 1:
                row[i] = (row[i] + a) & 255
            elif kind == 2:
                row[i] = (row[i] + b) & 255
            elif kind == 3:
                row[i] = (row[i] + (a + b) // 2) & 255
            elif kind == 4:
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                predictor = a if pa <= pb and pa <= pc else b if pb <= pc else c
                row[i] = (row[i] + predictor) & 255
        rows.append(bytes(row))
        previous = row
    return width, height, rows


def scale(width, height, rows, size):
    """Shrinks a square image to size x size, averaging the covered pixels."""
    if size == width == height:
        return rows
    spans = [(i * width // size, max((i + 1) * width // size,
                                     i * width // size + 1))
             for i in range(size)]
    out = []
    for y0, y1 in spans:
        row = bytearray()
        for x0, x1 in spans:
            count = (y1 - y0) * (x1 - x0)
            for channel in range(3):
                total = sum(sum(rows[y][x0 * 3 + channel:x1 * 3:3])
                            for y in range(y0, y1))
                row.append((total + count // 2) // count)
        out.append(bytes(row))
    return out


def chunk(kind, body):
    return (struct.pack(">I", len(body)) + kind + body +
            struct.pack(">I", zlib.crc32(kind + body)))


def write_png(path, width, height, icon):
    """Writes a width x height black RGB PNG with the icon rows centred."""
    size = len(icon)
    left = (width - size) // 2
    top = (height - size) // 2
    black = bytes(1 + width * 3)  # filter byte 0, then black pixels
    pad_left = bytes(1 + left * 3)
    pad_right = bytes((width - left - size) * 3)
    raw = b"".join([black] * top +
                   [pad_left + row + pad_right for row in icon] +
                   [black] * (height - top - size))
    path.write_bytes(
        b"\x89PNG\r\n\x1a\n" +
        chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)) +
        chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


def main():
    icon_width, icon_height, icon_rows = read_png_rgb(ICON)
    OUT.mkdir(exist_ok=True)
    scaled = {}
    links = []
    for css_width, css_height, ratio in SCREENS:
        short, long = css_width * ratio, css_height * ratio
        size = min(icon_width, round(short * ICON_FRACTION))
        if size not in scaled:
            scaled[size] = scale(icon_width, icon_height, icon_rows, size)
        for orientation, width, height in (("portrait", short, long),
                                           ("landscape", long, short)):
            name = f"{width}x{height}.png"
            write_png(OUT / name, width, height, scaled[size])
            media = (f"(device-width: {css_width}px) and "
                     f"(device-height: {css_height}px) and "
                     f"(-webkit-device-pixel-ratio: {ratio}) and "
                     f"(orientation: {orientation})")
            links.append(f'\t<link rel="apple-touch-startup-image" '
                         f'media="{media}" href="static/splash/{name}">')

    html = INDEX.read_text()
    block = BEGIN + "\n" + "\n".join(links) + "\n\t" + END
    html, count = re.subn(re.escape(BEGIN) + ".*?" + re.escape(END),
                          lambda _: block, html, flags=re.S)
    if count != 1:
        raise SystemExit("index.html: splash marker comments not found")
    INDEX.write_text(html)
    print(f"{len(links)} images in {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
