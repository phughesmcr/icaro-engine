// vid_quality presets (web-only), the vid_dprcap pixel-ratio cap, the
// dlight bucket cap and the particle limit.

await import("../src/gl_rsurf.js"); // load the renderer graph first (import cycle)
const { VID_ComputePixelRatio, vid_dprcap, VID_CheckPixelRatio } = await import(
  "../src/vid.js"
);
const gl_rmain = await import("../src/gl_rmain.js");
const THREE = await import("three");
const glquake = await import("../src/glquake.js");
const gl_rlight = await import("../src/gl_rlight.js");
const r_part = await import("../src/r_part.js");
const { cl, cl_dlights } = await import("../src/client.js");
const { r_origin } = await import("../src/render.js");
const { Cvar_RegisterVariable, Cvar_FindVar, Cvar_Set } = await import(
  "../src/cvar.js"
);
const { R_SetParticleLimit, R_GetParticleLimit, r_numparticles } = await import(
  "../src/r_part.js"
);
const { advancedPages } = await import("../src/menu_cvars.js");

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

// The cvars a preset writes: the real objects (R_Init isn't run here), and
// stand-ins for host_maxfps and gl_texture_anisotropy.
for (
  const name of [
    "vid_dprcap",
    "vid_quality",
    "r_particlecap",
    "gl_dlightcap",
    "host_maxfps",
    "gl_texture_anisotropy",
  ]
) {
  if (Cvar_FindVar(name) === null) {
    const real = {
      vid_dprcap,
      vid_quality: gl_rmain.vid_quality,
      r_particlecap: gl_rmain.r_particlecap,
      gl_dlightcap: gl_rmain.gl_dlightcap,
    }[name];
    const cvar = real !== undefined ?
      real :
      { name, string: "0", value: 0, archive: false };
    cvar.archive = false; // keep the test out of localStorage
    Cvar_RegisterVariable(cvar);
  }
}

const names = [
  "vid_dprcap",
  "vid_quality",
  "r_particlecap",
  "gl_dlightcap",
  "host_maxfps",
  "gl_texture_anisotropy",
];

function withSavedCvars(fn) {
  const saved = names.map((n) => [n, Cvar_FindVar(n).string]);
  try {
    fn();
  } finally {
    for (const [n, v] of saved) Cvar_Set(n, v);
    gl_rmain.R_ResetQuality();
  }
}

Deno.test("VID_ComputePixelRatio applies the vid_dprcap cap", () => {
  assertEqual(
    VID_ComputePixelRatio(3, null, true, 0),
    2,
    "cap 0 keeps the touch rule",
  );
  assertEqual(
    VID_ComputePixelRatio(3, null, false, 0),
    3,
    "cap 0 leaves desktop alone",
  );
  assertEqual(VID_ComputePixelRatio(3, null, true, 1), 1, "cap 1 on a phone");
  assertEqual(
    VID_ComputePixelRatio(3, null, false, 1.5),
    1.5,
    "cap applies on desktop",
  );
  assertEqual(
    VID_ComputePixelRatio(1, null, true, 2),
    1,
    "cap does not raise the ratio",
  );
  assertEqual(
    VID_ComputePixelRatio(3, null, true, 3),
    3,
    "cap above 2 lifts the touch cap",
  );
  assertEqual(
    VID_ComputePixelRatio(3, 2.5, true, 1),
    2.5,
    "?dpr= number beats the cap",
  );
  assertEqual(
    VID_ComputePixelRatio(3, "native", true, 1),
    3,
    "?dpr=native beats the cap",
  );
});

Deno.test("VID_CheckPixelRatio fires a resize when vid_dprcap changes", () => {
  const oldWindow = globalThis.window;
  const oldValue = vid_dprcap.value;
  let events = 0;
  globalThis.window = {
    dispatchEvent: (e) => {
      if (e.type === "resize") events++;
      return true;
    },
  };
  try {
    VID_CheckPixelRatio();
    const base = events;
    VID_CheckPixelRatio();
    assertEqual(events, base, "no change, no event");
    vid_dprcap.value = 1;
    VID_CheckPixelRatio();
    assertEqual(events, base + 1, "changed");
    VID_CheckPixelRatio();
    assertEqual(events, base + 1, "once per change");
  } finally {
    vid_dprcap.value = oldValue;
    VID_CheckPixelRatio();
    if (oldWindow === undefined) delete globalThis.window;
    else globalThis.window = oldWindow;
  }
});

Deno.test("vid_quality presets write the underlying cvars", () => {
  withSavedCvars(() => {
    gl_rmain.R_ApplyQualityPreset(0);
    assertEqual(Cvar_FindVar("vid_dprcap").value, 1, "battery dprcap");
    assertEqual(Cvar_FindVar("host_maxfps").value, 30, "battery maxfps");
    assertEqual(Cvar_FindVar("gl_dlightcap").value, 4, "battery dlights");
    assertEqual(Cvar_FindVar("r_particlecap").value, 2048, "battery particles");
    assertEqual(
      Cvar_FindVar("gl_texture_anisotropy").value,
      1,
      "battery anisotropy",
    );

    gl_rmain.R_ApplyQualityPreset(1);
    assertEqual(Cvar_FindVar("host_maxfps").value, 60, "balanced maxfps");
    assertEqual(Cvar_FindVar("vid_dprcap").value, 1.5, "balanced dprcap");

    gl_rmain.R_ApplyQualityPreset(2);
    assertEqual(Cvar_FindVar("host_maxfps").value, 250, "high maxfps");
    assertEqual(Cvar_FindVar("vid_dprcap").value, 0, "high dprcap");
    assertEqual(Cvar_FindVar("gl_dlightcap").value, 64, "high dlights");
    assertEqual(Cvar_FindVar("r_particlecap").value, 0, "high particles");

    Cvar_Set("host_maxfps", "45");
    gl_rmain.R_ApplyQualityPreset(3);
    assertEqual(Cvar_FindVar("host_maxfps").value, 45, "custom writes nothing");
  });
});

Deno.test("R_CheckQuality applies a change once and leaves later hand edits alone", () => {
  withSavedCvars(() => {
    const oldWindow = globalThis.window;
    globalThis.window = { dispatchEvent: () => true };
    try {
      Cvar_Set("vid_quality", "3");
      Cvar_Set("host_maxfps", "72");
      gl_rmain.R_ResetQuality();
      gl_rmain.R_CheckQuality(); // first frame: records, applies nothing
      assertEqual(
        Cvar_FindVar("host_maxfps").value,
        72,
        "first check applies nothing",
      );

      Cvar_Set("vid_quality", "0");
      gl_rmain.R_CheckQuality();
      assertEqual(Cvar_FindVar("host_maxfps").value, 30, "preset applied");

      Cvar_Set("host_maxfps", "60");
      gl_rmain.R_CheckQuality();
      gl_rmain.R_CheckQuality();
      assertEqual(Cvar_FindVar("host_maxfps").value, 60, "hand edit kept");

      // a saved preset at startup does not overwrite hand-tuned cvars
      gl_rmain.R_ResetQuality();
      gl_rmain.R_CheckQuality();
      assertEqual(
        Cvar_FindVar("host_maxfps").value,
        60,
        "startup keeps the saved value",
      );
    } finally {
      if (oldWindow === undefined) delete globalThis.window;
      else globalThis.window = oldWindow;
    }
  });
});

Deno.test("gl_dlightcap caps the dlight bucket", () => {
  withSavedCvars(() => {
    Cvar_Set("gl_dlightcap", "64");
    assertEqual(gl_rmain.R_DlightBucketCap(), 64, "default cap");
    assertEqual(gl_rmain.R_DlightBucket(40), 64, "unchanged below the cap");
    Cvar_Set("gl_dlightcap", "8");
    assertEqual(gl_rmain.R_DlightBucketCap(), 8, "cap 8");
    assertEqual(gl_rmain.R_DlightBucket(3), 4, "small count");
    assertEqual(gl_rmain.R_DlightBucket(40), 8, "capped");
    Cvar_Set("gl_dlightcap", "10");
    assertEqual(gl_rmain.R_DlightBucketCap(), 16, "rounds up to a bucket");
    Cvar_Set("gl_dlightcap", "1");
    assertEqual(gl_rmain.R_DlightBucketCap(), 4, "floor");
    Cvar_Set("gl_dlightcap", "500");
    assertEqual(gl_rmain.R_DlightBucketCap(), 64, "ceiling");
  });
});

Deno.test("R_SetParticleLimit bounds the limit by the pool", () => {
  try {
    R_SetParticleLimit(0);
    assertEqual(R_GetParticleLimit(), r_numparticles, "zero = whole pool");
    R_SetParticleLimit(2048);
    assertEqual(R_GetParticleLimit(), 2048, "set");
    R_SetParticleLimit(10);
    assertEqual(R_GetParticleLimit(), 512, "floor is the C minimum");
    R_SetParticleLimit(1e9);
    assertEqual(R_GetParticleLimit(), r_numparticles, "capped at the pool");
  } finally {
    R_SetParticleLimit(0);
  }
});

Deno.test("the Graphics menu page lists the preset and the resolution cap", () => {
  const graphics = advancedPages.find((p) => p.title === "Graphics");
  for (const cvar of ["vid_quality", "vid_dprcap"]) {
    if (graphics.items.find((i) => i.cvar === cvar) === undefined) {
      throw new Error("missing " + cvar);
    }
  }
});

Deno.test("a saved vid_quality is adopted at the first check without writing its cvars", () => {
  withSavedCvars(() => {
    const oldWindow = globalThis.window;
    globalThis.window = { dispatchEvent: () => true };
    try {
      // config.cfg has run: a saved preset and hand-tuned values
      Cvar_Set("vid_quality", "0");
      Cvar_Set("host_maxfps", "72");
      Cvar_Set("gl_dlightcap", "32");
      Cvar_Set("r_particlecap", "4096");
      gl_rmain.R_ResetQuality();

      gl_rmain.R_CheckQuality(); // first frame
      assertEqual(Cvar_FindVar("host_maxfps").value, 72, "maxfps kept");
      assertEqual(Cvar_FindVar("gl_dlightcap").value, 32, "dlightcap kept");
      assertEqual(
        Cvar_FindVar("r_particlecap").value,
        4096,
        "particlecap kept",
      );
      assertEqual(
        R_GetParticleLimit(),
        4096,
        "the live particle limit follows the cvar",
      );

      gl_rmain.R_CheckQuality();
      assertEqual(Cvar_FindVar("host_maxfps").value, 72, "still kept");

      Cvar_Set("vid_quality", "1");
      gl_rmain.R_CheckQuality();
      assertEqual(
        Cvar_FindVar("host_maxfps").value,
        60,
        "a later change applies",
      );
    } finally {
      R_SetParticleLimit(0);
      if (oldWindow === undefined) delete globalThis.window;
      else globalThis.window = oldWindow;
    }
  });
});

Deno.test("particle live count follows the limit, dying particles and R_ClearParticles", () => {
  const oldTime = cl.time;
  const oldOldtime = cl.oldtime;
  const oldTextures = glquake._allGameTextures.slice();
  const scene = new THREE.Scene();
  const org = new Float32Array(3);

  // Each explosion asks for 1024 particles; returns how many are drawn
  function explodeAndDraw(explosions, time) {
    cl.time = time;
    cl.oldtime = time;
    for (let i = 0; i < explosions; i++) r_part.R_ParticleExplosion(org);
    r_part.R_DrawParticles();
    return scene.children.length > 0 ?
      scene.children[0].geometry.drawRange.count :
      0;
  }

  try {
    r_part.R_InitParticles();
    r_part.R_SetParticleExternals({ scene: scene });

    R_SetParticleLimit(2048);
    assertEqual(explodeAndDraw(5, 10), 2048, "allocation stops at the limit");

    // the particles die; the free paths in R_DrawParticles give the count back
    r_part.R_DrawParticles(); // same time: nothing dies, nothing allocates
    cl.time = 100;
    cl.oldtime = 100;
    r_part.R_DrawParticles();
    assertEqual(scene.children.length, 0, "all dead, mesh removed");
    assertEqual(explodeAndDraw(5, 100), 2048, "room again after they died");

    // R_ClearParticles resets the count, with no draw in between
    r_part.R_ClearParticles();
    assertEqual(
      explodeAndDraw(1, 100),
      1024,
      "allocation resumes after a clear",
    );

    // raising the limit lets more in, lowering stops new ones only
    R_SetParticleLimit(3072);
    assertEqual(explodeAndDraw(5, 100), 3072, "raised limit");
    R_SetParticleLimit(512);
    assertEqual(
      explodeAndDraw(1, 100),
      3072,
      "lowered limit allocates nothing, keeps the live ones",
    );
  } finally {
    R_SetParticleLimit(0);
    r_part.R_ClearParticles();
    r_part.R_DrawParticles();
    cl.time = oldTime;
    cl.oldtime = oldOldtime;
    glquake._allGameTextures.splice(
      0,
      glquake._allGameTextures.length,
      ...oldTextures,
    );
  }
});

Deno.test("R_RenderDlights adds at most the dlight cap of PointLights, live", () => {
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

    for (let i = 0; i < 6; i++) {
      cl_dlights[i].origin.fill(0);
      cl_dlights[i].radius = 200;
      cl_dlights[i].minlight = 32;
      cl_dlights[i].die = 20;
    }

    const count = () =>
      scene.children.filter((c) => c instanceof THREE.PointLight).length;

    gl_rlight.R_SetDlightLimit(64);
    gl_rlight.R_RenderDlights(cl, scene);
    assertEqual(count(), 6, "cap above the count: all drawn");

    gl_rlight.R_SetDlightLimit(4);
    gl_rlight.R_RenderDlights(cl, scene);
    assertEqual(count(), 4, "cap below the count: min( N, cap )");

    gl_rlight.R_SetDlightLimit(2);
    gl_rlight.R_RenderDlights(cl, scene);
    assertEqual(count(), 2, "shrinking the cap removes the extras");

    gl_rlight.R_SetDlightLimit(64);
    gl_rlight.R_RenderDlights(cl, scene);
    assertEqual(count(), 6, "growing it brings them back");
  } finally {
    gl_rlight.R_SetDlightLimit(64);
    glquake.gl_flashblend.value = oldFlashblend;
    cl.time = oldTime;
    r_origin.set(oldOrigin);
    cl_dlights.forEach((light, i) => {
      light.die = oldLights[i].die;
      light.radius = oldLights[i].radius;
      light.minlight = oldLights[i].minlight;
      light.origin.set(oldLights[i].origin);
    });
    gl_rlight.R_RemoveDlights();
  }
});
