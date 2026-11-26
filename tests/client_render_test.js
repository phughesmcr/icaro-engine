// Bootstrap the renderer's existing circular module graph in its safe order.
await import("../src/gl_rsurf.js");

const glquake = await import("../src/glquake.js");
const gl_rlight = await import("../src/gl_rlight.js");
const r_part = await import("../src/r_part.js");
const view = await import("../src/view.js");
const THREE = await import("three");
const { cl, cls, cl_dlights } = await import("../src/client.js");
const { sv } = await import("../src/server.js");
const { r_origin } = await import("../src/render.js");

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

function assertNear(actual, expected, message, epsilon = 1e-6) {
  if (
    Number.isFinite(actual) === false || Math.abs(actual - expected) > epsilon
  ) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

Deno.test("dynamic light brightness comes from the radius, not the time left", () => {
  const oldFlashblend = glquake.gl_flashblend.value;
  const oldTime = cl.time;
  const oldOrigin = new Float32Array(r_origin);
  const oldLights = cl_dlights.map((light) => ({
    die: light.die,
    radius: light.radius,
    minlight: light.minlight,
    origin: new Float32Array(light.origin),
  }));
  const scene = new THREE.Scene();

  try {
    glquake.gl_flashblend.value = 1;
    cl.time = 10;
    r_origin.set([1000, 1000, 1000]);
    for (const light of cl_dlights) {
      light.die = 0;
      light.radius = 0;
    }

    const light = cl_dlights[0];
    light.origin.fill(0);
    light.radius = 200;
    light.minlight = 32;

    light.die = 10.1;
    gl_rlight.R_RenderDlights(cl, scene);
    assertEqual(scene.children.length, 1, "light attached");
    const pointLight = scene.children[0];
    const shortLived = pointLight.intensity;

    light.die = 10.5;
    gl_rlight.R_RenderDlights(cl, scene);
    assertNear(
      pointLight.intensity,
      shortLived,
      "intensity independent of die",
    );
    assertNear(
      pointLight.intensity,
      200 * (2 * glquake.LIGHTMAP_INTENSITY / 255) * 0.625,
      "intensity matches the lightmap scale",
    );
    assertNear(pointLight.distance, 200 - 32, "reach stops at minlight");
    assertEqual(pointLight.decay, 0, "no inverse-square falloff");

    light.radius = 100;
    gl_rlight.R_RenderDlights(cl, scene);
    assertNear(
      pointLight.intensity,
      shortLived / 2,
      "intensity scales with radius",
    );

    light.radius = 30;
    gl_rlight.R_RenderDlights(cl, scene);
    assertEqual(
      scene.children.length,
      0,
      "radius inside minlight adds no light",
    );
  } finally {
    glquake.gl_flashblend.value = oldFlashblend;
    cl.time = oldTime;
    r_origin.set(oldOrigin);
    cl_dlights.forEach((light, i) => {
      light.die = oldLights[i].die;
      light.radius = oldLights[i].radius;
      light.minlight = oldLights[i].minlight;
      light.origin.set(oldLights[i].origin);
    });
    gl_rlight.R_RenderDlights(cl, scene);
  }
});

Deno.test("cshift percent truncates like a C int", () => {
  const cshift = cl.cshifts[0];
  const old = cshift.percent;

  try {
    cshift.percent = 12.9;
    assertEqual(cshift.percent, 12, "positive truncation");
    cshift.percent -= 0.5;
    assertEqual(cshift.percent, 11, "decrement truncation");
    cshift.percent = -3.7;
    assertEqual(cshift.percent, -3, "negative truncation toward zero");
  } finally {
    cshift.percent = old;
  }
});

Deno.test("particle shader patch applies the GLQuake size curve", () => {
  const shader = {
    uniforms: {},
    vertexShader: [
      "uniform float size;",
      "uniform float scale;",
      "void main() {",
      "\tgl_PointSize = size;",
      "\t#ifdef USE_SIZEATTENUATION",
      "\t\tbool isPerspective = isPerspectiveMatrix( projectionMatrix );",
      "\t\tif ( isPerspective ) gl_PointSize *= ( scale / - mvPosition.z );",
      "\t#endif",
      "}",
    ].join("\n"),
  };

  r_part.R_PatchParticleShader(shader);

  assertEqual(
    shader.uniforms.quakeUnits != null,
    true,
    "quakeUnits uniform bound",
  );
  assertEqual(
    shader.vertexShader.includes("uniform float quakeUnits;"),
    true,
    "uniform declared",
  );
  assertEqual(
    shader.vertexShader.includes("1.0 + qdepth * 0.004"),
    true,
    "distance growth",
  );
  assertEqual(
    shader.vertexShader.includes("qdepth < 20.0"),
    true,
    "near clamp",
  );
  assertEqual(
    shader.vertexShader.includes("projectionMatrix[ 1 ][ 1 ]"),
    true,
    "world-size projection",
  );
  assertEqual(
    shader.vertexShader.includes("( scale / - mvPosition.z );"),
    false,
    "stock attenuation replaced",
  );
});

Deno.test("view effects use entity state when prediction is not running", () => {
  const oldActive = sv.active;
  const oldDemo = cls.demoplayback;

  try {
    sv.active = true;
    cls.demoplayback = false;
    assertEqual(view.V_UsePrediction(), false, "local server");

    sv.active = false;
    cls.demoplayback = true;
    assertEqual(view.V_UsePrediction(), false, "demo playback");
  } finally {
    sv.active = oldActive;
    cls.demoplayback = oldDemo;
  }
});

Deno.test("lightmap shader patch doubles the lightmap for gl_overbright", async () => {
  const { R_PatchLightmapShader } = await import("../src/gl_rsurf.js");
  const shader = {
    uniforms: {},
    fragmentShader: [
      "uniform vec3 emissive;",
      "void main() {",
      "\t#include <lights_fragment_maps>",
      "\tvec3 outgoingLight = vec3( 0.0 );",
      "\t#include <opaque_fragment>",
      "}",
    ].join("\n"),
  };

  R_PatchLightmapShader(shader);

  const fs = shader.fragmentShader;
  assertEqual(shader.uniforms.quakeLightmapScale != null, true, "uniform");
  assertEqual(
    fs.includes("uniform float quakeLightmapScale;"),
    true,
    "declared",
  );
  // the scale applies to the display-space texel, after Three's lightmap
  const mapsAt = fs.indexOf("#include <lights_fragment_maps>");
  const scaleAt = fs.indexOf(
    "sRGBTransferOETF( lightMapTexel ).rgb * quakeLightmapScale",
  );
  assertEqual(mapsAt !== -1 && scaleAt > mapsAt, true, "scale after maps");
  assertEqual(
    fs.includes("- lightMapIrradiance"),
    true,
    "replaces Three's lightmap irradiance",
  );
  const clampAt = fs.indexOf("min( outgoingLight, vec3( 1.0 ) )");
  const opaqueAt = fs.indexOf("#include <opaque_fragment>");
  assertEqual(clampAt !== -1 && clampAt < opaqueAt, true, "clamp before out");
});

Deno.test("lightmap shader patch adds the r_lightmap switch", async () => {
  const { R_PatchLightmapShader } = await import("../src/gl_rsurf.js");
  const shader = {
    uniforms: {},
    fragmentShader: [
      "uniform vec3 emissive;",
      "void main() {",
      "\t#include <map_fragment>",
      "\t#include <emissivemap_fragment>",
      "}",
    ].join("\n"),
  };

  R_PatchLightmapShader(shader);

  assertEqual(shader.uniforms.quakeLightmapOnly != null, true, "uniform bound");
  assertEqual(
    shader.fragmentShader.includes("uniform float quakeLightmapOnly;"),
    true,
    "uniform declared",
  );
  assertEqual(
    shader.fragmentShader.includes(
      "mix( diffuseColor.rgb, vec3( 1.0 ), quakeLightmapOnly )",
    ),
    true,
    "diffuse swapped for white",
  );
  assertEqual(
    shader.fragmentShader.includes(
      "totalEmissiveRadiance *= 1.0 - quakeLightmapOnly;",
    ),
    true,
    "fullbright emissive dropped",
  );
});
