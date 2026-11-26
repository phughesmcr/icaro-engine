// Bootstrap the renderer's existing circular module graph in its safe order.
await import("../src/gl_rsurf.js");

const glquake = await import("../src/glquake.js");
const gl_rmain = await import("../src/gl_rmain.js");
const gl_rlight = await import("../src/gl_rlight.js");
const THREE = await import("three");
const { cl, cl_dlights } = await import("../src/client.js");

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

Deno.test("R_DlightBucket rounds a light count up to 4, 8, 16, 32 or 64", () => {
  const cases = [[0, 0], [1, 4], [4, 4], [5, 8], [9, 16], [17, 32], [33, 64], [
    64,
    64,
  ]];
  for (const [count, bucket] of cases) {
    assertEqual(gl_rmain.R_DlightBucket(count), bucket, "bucket for " + count);
  }
});

Deno.test("dynamic lights keep the scene light count on a bucket boundary", () => {
  const oldFlashblend = glquake.gl_flashblend.value;
  const oldTime = cl.time;
  const oldLights = cl_dlights.map((light) => ({
    die: light.die,
    radius: light.radius,
    minlight: light.minlight,
    origin: new Float32Array(light.origin),
  }));
  const scene = new THREE.Scene();

  function render(active) {
    for (let i = 0; i < cl_dlights.length; i++) {
      const light = cl_dlights[i];
      light.die = i < active ? 11 : 0;
      light.radius = i < active ? 200 : 0;
      light.minlight = 0;
      light.origin.set([1000, 1000, 1000]);
    }

    gl_rlight.R_RenderDlights(cl, scene);
    gl_rmain.R_PadDlights(scene);

    let lit = 0;
    for (const child of scene.children) {
      if (child instanceof THREE.PointLight && child.intensity > 0) lit++;
    }

    return { total: scene.children.length, lit };
  }

  try {
    glquake.gl_flashblend.value = 1;
    cl.time = 10;

    for (
      const [active, total] of [
        [0, 0],
        [1, 4],
        [3, 4],
        [5, 8],
        [20, 32],
        [64, 64],
        [2, 4],
        [0, 0],
      ]
    ) {
      const result = render(active);
      assertEqual(
        result.total,
        total,
        "scene lights for " + active + " dlights",
      );
      assertEqual(result.lit, active, "lit lights for " + active + " dlights");
    }

    // A light that has died is not counted, as in R_RenderDlights
    render(2);
    cl_dlights[1].die = 9;
    gl_rlight.R_RenderDlights(cl, scene);
    gl_rmain.R_PadDlights(scene);
    assertEqual(scene.children.length, 4, "scene lights after one died");
    assertEqual(gl_rmain.R_CountRenderedDlights(), 1, "dead light not counted");

    // gl_flashblend 0 draws no PointLights, so the fillers go
    glquake.gl_flashblend.value = 0;
    assertEqual(
      gl_rmain.R_CountRenderedDlights(),
      0,
      "no count without flashblend",
    );
    const pooled = scene.children.filter((child) => child.intensity > 0).length;
    gl_rmain.R_PadDlights(scene);
    assertEqual(
      scene.children.length,
      pooled,
      "fillers removed without flashblend",
    );
  } finally {
    glquake.gl_flashblend.value = 1;
    cl.time = 10;
    for (const light of cl_dlights) {
      light.die = 0;
      light.radius = 0;
    }

    gl_rlight.R_RenderDlights(cl, scene);
    gl_rmain.R_PadDlights(scene);

    glquake.gl_flashblend.value = oldFlashblend;
    cl.time = oldTime;
    cl_dlights.forEach((light, i) => {
      light.die = oldLights[i].die;
      light.radius = oldLights[i].radius;
      light.minlight = oldLights[i].minlight;
      light.origin.set(oldLights[i].origin);
    });
  }
});
