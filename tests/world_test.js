import {
  CONTENTS_EMPTY,
  CONTENTS_SOLID,
  CONTENTS_WATER,
} from "../src/bspfile.js";
import {
  SV_HullForBox,
  SV_HullPointContents,
  SV_InitBoxHull,
  SV_RecursiveHullCheck,
  trace_t,
} from "../src/world.js";

function assertNear(actual, expected, epsilon, message) {
  if (
    Number.isFinite(actual) !== true || Math.abs(actual - expected) > epsilon
  ) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

Deno.test("SV_RecursiveHullCheck supports hulls deeper than the scratch pool", () => {
  const nodeCount = 64;
  const planes = [];
  const clipnodes = [];

  for (let i = 0; i < nodeCount; i++) {
    planes.push({
      type: 0,
      dist: 90 - i,
      normal: new Float32Array([1, 0, 0]),
    });
    clipnodes.push({
      planenum: i,
      children: new Int16Array([
        CONTENTS_EMPTY,
        i === nodeCount - 1 ? CONTENTS_SOLID : i + 1,
      ]),
    });
  }

  const hull = {
    firstclipnode: 0,
    lastclipnode: nodeCount - 1,
    clipnodes: clipnodes,
    planes: planes,
  };
  const start = new Float32Array([100, 0, 0]);
  const end = new Float32Array([-100, 0, 0]);
  const trace = new trace_t();
  trace.fraction = 1;
  trace.allsolid = true;
  trace.endpos.set(end);

  const clear = SV_RecursiveHullCheck(
    hull,
    hull.firstclipnode,
    0,
    1,
    start,
    end,
    trace,
  );

  if (clear !== false) {
    throw new Error("expected the trace to hit the final solid leaf");
  }
  if (trace.allsolid !== false) {
    throw new Error("expected the trace to pass through empty space");
  }
  if (trace.inopen !== true || trace.startsolid !== false) {
    throw new Error("expected an open-to-solid trace");
  }
  assertNear(trace.endpos[0], 27.03125, 0.00001, "impact position");
  assertNear(trace.fraction, 0.36484375, 0.00001, "impact fraction");
  assertNear(trace.plane.normal[0], 1, 0.00001, "impact plane normal");
  assertNear(trace.plane.dist, 27, 0.00001, "impact plane distance");
});

// Reference: the object-tree walk SV_RecursiveHullCheck and
// SV_HullPointContents used before they read flat typed-array copies of the
// hull. The flat walk must give bit-identical traces.
const REF_DIST_EPSILON = 0.03125;

function refPointContents(hull, num, p) {
  while (num >= 0) {
    const node = hull.clipnodes[num];
    const plane = hull.planes[node.planenum];
    let d;
    if (plane.type < 3) {
      d = p[plane.type] - plane.dist;
    } else {
      d = (plane.normal[0] * p[0] + plane.normal[1] * p[1] +
        plane.normal[2] * p[2]) - plane.dist;
    }
    num = d < 0 ? node.children[1] : node.children[0];
  }

  return num;
}

function refHullCheck(hull, num, p1f, p2f, p1, p2, trace) {
  if (num < 0) {
    if (num !== CONTENTS_SOLID) {
      trace.allsolid = false;
      if (num === CONTENTS_EMPTY) {
        trace.inopen = true;
      } else {
        trace.inwater = true;
      }
    } else {
      trace.startsolid = true;
    }

    return true;
  }

  const node = hull.clipnodes[num];
  const plane = hull.planes[node.planenum];
  let t1, t2;
  if (plane.type < 3) {
    t1 = p1[plane.type] - plane.dist;
    t2 = p2[plane.type] - plane.dist;
  } else {
    const n = plane.normal;
    t1 = (n[0] * p1[0] + n[1] * p1[1] + n[2] * p1[2]) - plane.dist;
    t2 = (n[0] * p2[0] + n[1] * p2[1] + n[2] * p2[2]) - plane.dist;
  }

  if (t1 >= 0 && t2 >= 0) {
    return refHullCheck(hull, node.children[0], p1f, p2f, p1, p2, trace);
  }
  if (t1 < 0 && t2 < 0) {
    return refHullCheck(hull, node.children[1], p1f, p2f, p1, p2, trace);
  }

  let frac = t1 < 0 ?
    (t1 + REF_DIST_EPSILON) / (t1 - t2) :
    (t1 - REF_DIST_EPSILON) / (t1 - t2);
  if (frac < 0) frac = 0;
  if (frac > 1) frac = 1;

  let midf = p1f + (p2f - p1f) * frac;
  const mid = new Float32Array(3);
  for (let i = 0; i < 3; i++) {
    mid[i] = p1[i] + frac * (p2[i] - p1[i]);
  }

  const side = t1 < 0 ? 1 : 0;
  if (!refHullCheck(hull, node.children[side], p1f, midf, p1, mid, trace)) {
    return false;
  }
  if (refPointContents(hull, node.children[side ^ 1], mid) !== CONTENTS_SOLID) {
    return refHullCheck(
      hull,
      node.children[side ^ 1],
      midf,
      p2f,
      mid,
      p2,
      trace,
    );
  }
  if (trace.allsolid) {
    return false;
  }

  if (!side) {
    trace.plane.normal.set(plane.normal);
    trace.plane.dist = plane.dist;
  } else {
    for (let i = 0; i < 3; i++) {
      trace.plane.normal[i] = 0 - plane.normal[i];
    }
    trace.plane.dist = -plane.dist;
  }

  while (refPointContents(hull, hull.firstclipnode, mid) === CONTENTS_SOLID) {
    frac -= 0.1;
    if (frac < 0) {
      trace.fraction = midf;
      trace.endpos.set(mid);
      return false;
    }

    midf = p1f + (p2f - p1f) * frac;
    for (let i = 0; i < 3; i++) {
      mid[i] = p1[i] + frac * (p2[i] - p1[i]);
    }
  }

  trace.fraction = midf;
  trace.endpos.set(mid);
  return false;
}

function makeRandom(seed) {
  return function () {
    seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// A complete binary clip tree with axial and non-axial planes and random
// empty, water and solid leaves, shaped like Mod_LoadClipnodes output
function makeRandomHull(rand, nodeCount) {
  const leaves = [CONTENTS_EMPTY, CONTENTS_SOLID, CONTENTS_WATER];
  const planes = [];
  const clipnodes = [];
  for (let i = 0; i < nodeCount; i++) {
    const type = Math.floor(rand() * 4) === 3 ?
      3 + Math.floor(rand() * 3) :
      Math.floor(rand() * 3);
    const normal = new Float32Array(3);
    if (type < 3) {
      normal[type] = 1;
    } else {
      const x = rand() - 0.5, y = rand() - 0.5, z = rand() - 0.5;
      const len = Math.sqrt(x * x + y * y + z * z);
      normal[0] = x / len;
      normal[1] = y / len;
      normal[2] = z / len;
    }

    planes.push({ type, dist: Math.fround((rand() - 0.5) * 200), normal });
    const children = new Int16Array(2);
    for (let s = 0; s < 2; s++) {
      const c = 2 * i + 1 + s;
      children[s] = c < nodeCount ? c : leaves[Math.floor(rand() * 3)];
    }

    clipnodes.push({ planenum: i, children });
  }

  return { firstclipnode: 0, lastclipnode: nodeCount - 1, clipnodes, planes };
}

function newTrace(end) {
  const trace = new trace_t();
  trace.fraction = 1;
  trace.allsolid = true;
  trace.endpos.set(end);
  return trace;
}

function assertSameTrace(a, b, message) {
  const fields = ["allsolid", "startsolid", "inopen", "inwater", "fraction"];
  for (const f of fields) {
    if (!Object.is(a[f], b[f])) {
      throw new Error(`${message}: ${f} ${a[f]} !== ${b[f]}`);
    }
  }
  for (let i = 0; i < 3; i++) {
    if (!Object.is(a.endpos[i], b.endpos[i])) {
      throw new Error(
        `${message}: endpos[${i}] ${a.endpos[i]} !== ${b.endpos[i]}`,
      );
    }
    if (!Object.is(a.plane.normal[i], b.plane.normal[i])) {
      throw new Error(`${message}: plane.normal[${i}] differs`);
    }
  }

  if (!Object.is(a.plane.dist, b.plane.dist)) {
    throw new Error(
      `${message}: plane.dist ${a.plane.dist} !== ${b.plane.dist}`,
    );
  }
}

function compareTraces(hull, rand, count, span, label) {
  const start = new Float32Array(3), end = new Float32Array(3);
  for (let n = 0; n < count; n++) {
    for (let i = 0; i < 3; i++) {
      start[i] = (rand() - 0.5) * span;
      end[i] = (rand() - 0.5) * span;
    }

    const got = newTrace(end), want = newTrace(end);
    const gotClear = SV_RecursiveHullCheck(
      hull,
      hull.firstclipnode,
      0,
      1,
      start,
      end,
      got,
    );
    const wantClear = refHullCheck(
      hull,
      hull.firstclipnode,
      0,
      1,
      start,
      end,
      want,
    );
    if (gotClear !== wantClear) {
      throw new Error(
        `${label} trace ${n}: returned ${gotClear}, reference ${wantClear}`,
      );
    }
    assertSameTrace(got, want, `${label} trace ${n}`);
    if (
      SV_HullPointContents(hull, hull.firstclipnode, start) !==
        refPointContents(hull, hull.firstclipnode, start)
    ) {
      throw new Error(`${label} point ${n}: contents differ`);
    }
  }
}

Deno.test("SV_RecursiveHullCheck matches the object-tree walk on random hulls", () => {
  const rand = makeRandom(7);
  for (let h = 0; h < 20; h++) {
    compareTraces(makeRandomHull(rand, 63), rand, 500, 300, `hull ${h}`);
  }
});

Deno.test("SV_RecursiveHullCheck sees new planes for the same clipnodes", () => {
  const rand = makeRandom(11);
  const hull = makeRandomHull(rand, 31);
  compareTraces(hull, rand, 200, 300, "first planes");

  // Same clipnodes array, new planes array: the flat copy must be rebuilt
  hull.planes = hull.planes.map((p) => ({
    type: p.type,
    dist: Math.fround(p.dist + 17),
    normal: p.normal,
  }));
  compareTraces(hull, rand, 200, 300, "replaced planes");

  // Same clipnodes array object, grown: also rebuilt
  const extra = makeRandomHull(rand, 63);
  hull.clipnodes.length = 0;
  hull.clipnodes.push(...extra.clipnodes);
  hull.planes = extra.planes;
  hull.lastclipnode = 62;
  compareTraces(hull, rand, 200, 300, "grown clipnodes");
});

Deno.test("SV_HullForBox traces match the object-tree walk for each box", () => {
  SV_InitBoxHull();
  const rand = makeRandom(23);
  const mins = new Float32Array(3), maxs = new Float32Array(3);
  for (let b = 0; b < 50; b++) {
    for (let i = 0; i < 3; i++) {
      mins[i] = -1 - rand() * 40;
      maxs[i] = 1 + rand() * 40;
    }

    const hull = SV_HullForBox(mins, maxs);
    compareTraces(hull, rand, 100, 160, `box ${b}`);
  }
});
