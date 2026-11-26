// gl_entalpha.js R_EntAlpha_ApplyMesh: alias model alpha (Ironwail r_alias.c)
// swaps the mesh's material for a cached transparent clone, keeps that
// clone in step with a per-entity material gl_mesh.js changes in place
// (the r_lerpmodels material), and swaps the base back when opaque.

const THREE = await import("three");
const { R_EntAlpha_ApplyMesh, R_EntAlpha_IsClone } = await import(
  "../src/gl_entalpha.js"
);
const { ENTALPHA_DEFAULT, ENTALPHA_ONE, ENTALPHA_ENCODE, ENTALPHA_DECODE } =
  await import("../src/protocol.js");

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

// The shim's Material has no clone(); this stands in for AliasMaterial
class FakeAliasMaterial extends THREE.Material {
  constructor() {
    super();
    this.map = null;
    this.alphaTest = 0;
    this.vertexColors = false;
    this.fullbrightMap = null;
    this.depthWrite = true;
    this.needsUpdate = false;
  }

  onBeforeCompile() {}

  customProgramCacheKey() {
    return "alias";
  }

  clone() {
    const m = new FakeAliasMaterial();
    m.map = this.map;
    m.alphaTest = this.alphaTest;
    m.vertexColors = this.vertexColors;
    m.fullbrightMap = this.fullbrightMap;
    m.side = this.side;
    return m;
  }
}

Deno.test("R_EntAlpha_ApplyMesh blends alias models and follows in-place skin changes", () => {
  const skinA = { name: "a" },
    skinB = { name: "b" },
    fullbright = { name: "fb" };
  const base = new FakeAliasMaterial();
  base.map = skinA;
  const mesh = { material: base };
  const e = { alpha: ENTALPHA_DEFAULT };

  // opaque: untouched
  R_EntAlpha_ApplyMesh(e, mesh);
  assertEqual(mesh.material, base, "opaque keeps the base");

  e.alpha = ENTALPHA_ENCODE(0.5);
  R_EntAlpha_ApplyMesh(e, mesh);
  const clone = mesh.material;
  if (clone === base) {
    throw new Error("translucent entity kept the opaque material");
  }
  assertEqual(R_EntAlpha_IsClone(clone), true, "R_EntAlpha_IsClone");
  assertEqual(R_EntAlpha_IsClone(base), false, "base is not a clone");
  assertEqual(clone.transparent, true, "transparent");
  assertEqual(clone.opacity, ENTALPHA_DECODE(e.alpha), "opacity");
  assertEqual(clone.depthWrite, false, "GLS_NO_ZWRITE");
  assertEqual(clone.side, THREE.DoubleSide, "no back face culling");
  assertEqual(base.transparent, false, "the shared base is left alone");

  // gl_mesh.js sets the base again next frame: the same clone comes back
  mesh.material = base;
  R_EntAlpha_ApplyMesh(e, mesh);
  assertEqual(mesh.material, clone, "cached clone reused");

  // the r_lerpmodels material takes another skin in place
  base.map = skinB;
  base.fullbrightMap = fullbright;
  base.alphaTest = 0.666;
  mesh.material = base;
  R_EntAlpha_ApplyMesh(e, mesh);
  assertEqual(mesh.material, clone, "same clone after the skin change");
  assertEqual(clone.map, skinB, "clone follows the map");
  assertEqual(
    clone.fullbrightMap,
    fullbright,
    "clone follows the fullbright mask",
  );
  // Ironwail tests the texel's alpha before the entity alpha: Three compares
  // opacity * texel alpha, so the threshold scales with the opacity
  assertEqual(
    clone.alphaTest,
    0.666 * ENTALPHA_DECODE(e.alpha),
    "clone follows alphaTest, scaled by its opacity",
  );
  assertEqual(clone.needsUpdate, true, "recompile after the skin change");

  // opaque again, with the clone still on the mesh (no gl_mesh.js reset)
  e.alpha = ENTALPHA_ONE;
  R_EntAlpha_ApplyMesh(e, mesh);
  assertEqual(mesh.material, base, "opaque swaps the base back");

  // disposing the base disposes its clones
  let disposed = false;
  clone.addEventListener("dispose", () => {
    disposed = true;
  });
  base.dispose();
  assertEqual(disposed, true, "clone disposed with its base");
});
