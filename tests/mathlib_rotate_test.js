// Tests for RotatePointAroundVector and its helpers in src/mathlib.js, which
// reuse module-level scratch instead of allocating on every call.

import {
  PerpendicularVector,
  RotatePointAroundVector,
  VectorNormalize,
} from "../src/mathlib.js";

// Rodrigues' rotation of `p` about unit axis `k` by `deg` degrees, in doubles.
function rodrigues(k, p, deg) {
  const t = deg * Math.PI / 180;
  const c = Math.cos(t), s = Math.sin(t);
  const kp = k[0] * p[0] + k[1] * p[1] + k[2] * p[2];
  const cx = [
    k[1] * p[2] - k[2] * p[1],
    k[2] * p[0] - k[0] * p[2],
    k[0] * p[1] - k[1] * p[0],
  ];
  return [0, 1, 2].map((i) => p[i] * c + cx[i] * s + k[i] * kp * (1 - c));
}

function unit(x, y, z) {
  const v = new Float32Array([x, y, z]);
  VectorNormalize(v);
  return v;
}

function assertClose(got, want, label) {
  for (let i = 0; i < 3; i++) {
    if (Math.abs(got[i] - want[i]) > 1e-5) {
      throw new Error(`${label}: [${Array.from(got)}] != [${want}]`);
    }
  }
}

// Axes whose smallest component sits at each index, so PerpendicularVector
// picks every `pos` in turn.
const CASES = [
  [unit(0.1, 0.7, 0.7), unit(1, 0.2, -0.3), 37.5],
  [unit(0.6, 0.05, 0.8), unit(-0.4, 1, 0.1), -52],
  [unit(0.3, 0.9, 0.02), unit(0.5, 0.5, 0.7), 90 - 45],
  [unit(0, 0, 1), unit(1, 0, 0), 90],
];

Deno.test("RotatePointAroundVector matches Rodrigues rotation", () => {
  const dst = new Float32Array(3);
  for (const [dir, point, deg] of CASES) {
    RotatePointAroundVector(dst, dir, point, deg);
    assertClose(dst, rodrigues(dir, point, deg), `deg ${deg}`);
  }
});

Deno.test("RotatePointAroundVector gives the same result after other calls", () => {
  const first = CASES.map(([dir, point, deg]) => {
    const dst = new Float32Array(3);
    RotatePointAroundVector(dst, dir, point, deg);
    return dst;
  });

  // Run the cases again in reverse, interleaved with PerpendicularVector,
  // so any state left in the shared scratch would show up.
  const tmp = new Float32Array(3);
  for (let n = CASES.length - 1; n >= 0; n--) {
    const [dir, point, deg] = CASES[n];
    PerpendicularVector(tmp, point);
    const dst = new Float32Array(3);
    RotatePointAroundVector(dst, dir, point, deg);
    for (let i = 0; i < 3; i++) {
      if (dst[i] !== first[n][i]) {
        throw new Error(
          `case ${n}: [${Array.from(dst)}] != [${Array.from(first[n])}]`,
        );
      }
    }
  }
});
