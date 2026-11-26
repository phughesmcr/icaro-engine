// Synthetic BSP29 and BSP2 maps for tests. Commercial map data must never be
// committed, so tests build what they need from a description.

import * as bspfile from "../src/bspfile.js";

// ----------------------------------------------------------------------------
// Synthetic BSP builder: one description, written as BSP29 or BSP2
// ----------------------------------------------------------------------------

export function buildBsp(version, lumps) {
  const header = 4 + bspfile.HEADER_LUMPS * 8;
  let size = header;
  for (let i = 0; i < bspfile.HEADER_LUMPS; i++) {
    size += (lumps[i] !== undefined) ? (lumps[i].length + 3) & ~3 : 0;
  }

  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  view.setInt32(0, version, true);

  let ofs = header;
  for (let i = 0; i < bspfile.HEADER_LUMPS; i++) {
    const lump = lumps[i];
    const len = lump !== undefined ? lump.length : 0;
    view.setInt32(4 + i * 8, len > 0 ? ofs : 0, true);
    view.setInt32(4 + i * 8 + 4, len, true);
    if (len > 0) {
      bytes.set(lump, ofs);
      ofs += (len + 3) & ~3;
    }
  }

  return bytes;
}

export function lump(count, size, fill) {
  const out = new Uint8Array(count * size);
  const view = new DataView(out.buffer);
  for (let i = 0; i < count; i++) {
    fill(view, i * size, i);
  }
  return out;
}

// Leaf and node children are given as signed values: >= 0 is a node,
// -1 - n is leaf n. Clipnode children: >= 0 is a clipnode, < 0 contents.
//
// map: {
//   planes: count, vertexes: [ [ x, y, z ] ], edges: [ [ v0, v1 ] ],
//   surfedges: [ int ], texinfo: count,
//   faces: [ { planenum, side, firstedge, numedges, texinfo, styles, lightofs } ],
//   marksurfaces: [ int ],
//   leafs: [ { contents, mins, maxs, firstmark, nummark, ambient } ],
//   nodes: [ { planenum, children, mins, maxs, firstface, numfaces } ],
//   clipnodes: [ [ planenum, child0, child1 ] ], visleafs,
//   lighting: Uint8Array (optional)
// }
export function writeMap(bsp2, map) {
  const L = [];
  L[bspfile.LUMP_PLANES] = lump(map.planes, 20, (v, o, i) => {
    v.setFloat32(o + (i % 3) * 4, 1, true); // axial normal
    v.setFloat32(o + 12, i * 8, true); // dist
    v.setInt32(o + 16, i % 3, true); // PLANE_X/Y/Z
  });
  L[bspfile.LUMP_VERTEXES] = lump(map.vertexes.length, 12, (v, o, i) => {
    for (let j = 0; j < 3; j++) {
      v.setFloat32(o + j * 4, map.vertexes[i][j], true);
    }
  });
  L[bspfile.LUMP_EDGES] = lump(map.edges.length, bsp2 ? 8 : 4, (v, o, i) => {
    if (bsp2) {
      v.setUint32(o, map.edges[i][0], true);
      v.setUint32(o + 4, map.edges[i][1], true);
    } else {
      v.setUint16(o, map.edges[i][0], true);
      v.setUint16(o + 2, map.edges[i][1], true);
    }
  });
  L[bspfile.LUMP_SURFEDGES] = lump(
    map.surfedges.length,
    4,
    (v, o, i) => v.setInt32(o, map.surfedges[i], true),
  );
  L[bspfile.LUMP_TEXINFO] = lump(map.texinfo, 40, (v, o) => {
    v.setFloat32(o, 1, true); // s = x
    v.setFloat32(o + 16 + 4, 1, true); // t = y
  });
  L[bspfile.LUMP_FACES] = lump(map.faces.length, bsp2 ? 28 : 20, (v, o, i) => {
    const f = map.faces[i];
    if (bsp2) {
      v.setInt32(o, f.planenum, true);
      v.setInt32(o + 4, f.side, true);
      v.setInt32(o + 8, f.firstedge, true);
      v.setInt32(o + 12, f.numedges, true);
      v.setInt32(o + 16, f.texinfo, true);
      for (let j = 0; j < 4; j++) v.setUint8(o + 20 + j, f.styles[j]);
      v.setInt32(o + 24, f.lightofs, true);
    } else {
      v.setInt16(o, f.planenum, true);
      v.setInt16(o + 2, f.side, true);
      v.setInt32(o + 4, f.firstedge, true);
      v.setInt16(o + 8, f.numedges, true);
      v.setInt16(o + 10, f.texinfo, true);
      for (let j = 0; j < 4; j++) v.setUint8(o + 12 + j, f.styles[j]);
      v.setInt32(o + 16, f.lightofs, true);
    }
  });
  L[bspfile.LUMP_MARKSURFACES] = lump(
    map.marksurfaces.length,
    bsp2 ? 4 : 2,
    (v, o, i) => {
      if (bsp2) v.setUint32(o, map.marksurfaces[i], true);
      else v.setUint16(o, map.marksurfaces[i], true);
    },
  );
  L[bspfile.LUMP_LEAFS] = lump(map.leafs.length, bsp2 ? 44 : 28, (v, o, i) => {
    const l = map.leafs[i];
    v.setInt32(o, l.contents, true);
    v.setInt32(o + 4, -1, true); // no vis
    for (let j = 0; j < 3; j++) {
      if (bsp2) {
        v.setFloat32(o + 8 + j * 4, l.mins[j], true);
        v.setFloat32(o + 20 + j * 4, l.maxs[j], true);
      } else {
        v.setInt16(o + 8 + j * 2, l.mins[j], true);
        v.setInt16(o + 14 + j * 2, l.maxs[j], true);
      }
    }

    if (bsp2) {
      v.setUint32(o + 32, l.firstmark, true);
      v.setUint32(o + 36, l.nummark, true);
    } else {
      v.setUint16(o + 20, l.firstmark, true);
      v.setUint16(o + 22, l.nummark, true);
    }

    for (let j = 0; j < 4; j++) {
      v.setUint8(o + (bsp2 ? 40 : 24) + j, l.ambient[j]);
    }
  });
  L[bspfile.LUMP_NODES] = lump(map.nodes.length, bsp2 ? 44 : 24, (v, o, i) => {
    const n = map.nodes[i];
    v.setInt32(o, n.planenum, true);
    for (let j = 0; j < 2; j++) {
      if (bsp2) v.setInt32(o + 4 + j * 4, n.children[j], true);
      else v.setInt16(o + 4 + j * 2, n.children[j], true);
    }

    for (let j = 0; j < 3; j++) {
      if (bsp2) {
        v.setFloat32(o + 12 + j * 4, n.mins[j], true);
        v.setFloat32(o + 24 + j * 4, n.maxs[j], true);
      } else {
        v.setInt16(o + 8 + j * 2, n.mins[j], true);
        v.setInt16(o + 14 + j * 2, n.maxs[j], true);
      }
    }

    if (bsp2) {
      v.setUint32(o + 36, n.firstface, true);
      v.setUint32(o + 40, n.numfaces, true);
    } else {
      v.setUint16(o + 20, n.firstface, true);
      v.setUint16(o + 22, n.numfaces, true);
    }
  });
  L[bspfile.LUMP_CLIPNODES] = lump(
    map.clipnodes.length,
    bsp2 ? 12 : 8,
    (v, o, i) => {
      const c = map.clipnodes[i];
      v.setInt32(o, c[0], true);
      for (let j = 0; j < 2; j++) {
        if (bsp2) v.setInt32(o + 4 + j * 4, c[1 + j], true);
        else v.setInt16(o + 4 + j * 2, c[1 + j], true);
      }
    },
  );
  if (map.lighting !== undefined) {
    L[bspfile.LUMP_LIGHTING] = map.lighting;
  }
  L[bspfile.LUMP_MODELS] = lump(1, 64, (v, o) => {
    for (let j = 0; j < 3; j++) {
      v.setFloat32(o + j * 4, -64, true);
      v.setFloat32(o + 12 + j * 4, 64, true);
    }

    v.setInt32(o + 52, map.visleafs, true);
    v.setInt32(o + 60, map.faces.length, true);
  });
  return buildBsp(bsp2 ? bspfile.BSP2VERSION_BSP2 : bspfile.BSPVERSION, L);
}

// A small map that fits both formats: a square face and a triangle, two
// nodes over three leafs (one of them water), and a two-node clip hull.
export function smallMap() {
  return {
    planes: 3,
    vertexes: [[0, 0, 0], [64, 0, 0], [64, 64, 0], [0, 64, 0], [32, 96, 16]],
    edges: [[0, 0], [0, 1], [1, 2], [2, 3], [3, 0], [2, 4], [4, 3]],
    surfedges: [1, 2, 3, 4, -3, 5, 6],
    texinfo: 1,
    faces: [
      {
        planenum: 2,
        side: 0,
        firstedge: 0,
        numedges: 4,
        texinfo: 0,
        styles: [0, 1, 255, 255],
        lightofs: -1,
      },
      {
        planenum: 1,
        side: 1,
        firstedge: 4,
        numedges: 3,
        texinfo: 0,
        styles: [5, 255, 255, 255],
        lightofs: 64,
      },
    ],
    marksurfaces: [0, 1, 1],
    leafs: [
      {
        contents: bspfile.CONTENTS_SOLID,
        mins: [0, 0, 0],
        maxs: [0, 0, 0],
        firstmark: 0,
        nummark: 0,
        ambient: [0, 0, 0, 0],
      },
      {
        contents: bspfile.CONTENTS_EMPTY,
        mins: [-64, -64, -32],
        maxs: [0, 64, 32],
        firstmark: 0,
        nummark: 2,
        ambient: [1, 2, 3, 4],
      },
      {
        contents: bspfile.CONTENTS_WATER,
        mins: [0, -64, -32],
        maxs: [64, 64, 32],
        firstmark: 2,
        nummark: 1,
        ambient: [9, 0, 0, 7],
      },
    ],
    nodes: [
      {
        planenum: 0,
        children: [1, -1 - 1],
        mins: [-64, -64, -32],
        maxs: [64, 64, 32],
        firstface: 0,
        numfaces: 1,
      },
      {
        planenum: 1,
        children: [-1 - 2, -1 - 0],
        mins: [0, -64, -32],
        maxs: [64, 64, 32],
        firstface: 1,
        numfaces: 1,
      },
    ],
    clipnodes: [[0, 1, bspfile.CONTENTS_EMPTY], [
      1,
      bspfile.CONTENTS_WATER,
      bspfile.CONTENTS_SOLID,
    ]],
    visleafs: 2,
  };
}
