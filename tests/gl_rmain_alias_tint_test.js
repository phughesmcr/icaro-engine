// R_SetupAliasLighting: id's alias-model lighting (gl_rmain.c) carrying
// QuakeSpasm's lightcolor, so .lit maps tint alias models. Without a .lit the
// shade must equal id's scalar shadelight exactly. Every world here is
// synthetic: commercial data must never be committed.

// Bootstrap the renderer's existing circular module graph in its safe order.
await import("../src/gl_rsurf.js");

const gl_rmain = await import("../src/gl_rmain.js");
const glquake = await import("../src/glquake.js");
const { cl, cl_dlights, MAX_DLIGHTS } = await import("../src/client.js");
const { r_avertexnormal_dots } = await import("../src/anorm_dots.js");
const { VectorSubtract, Length } = await import("../src/mathlib.js");

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

function assertClose(actual, expected, message) {
  if (Math.abs(actual - expected) > 1e-9) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

const LEAF = { contents: -1 };

// One lightmapped floor at height 0, 128x128 units around the origin, every
// luxel `rgb` in light style 0. A single value gives a mono map.
function floor(rgb) {
  const plane = { type: 2, normal: new Float32Array([0, 0, 1]), dist: 0 };
  const lit = rgb.length === 3;
  const samples = new Uint8Array(9 * 9 * rgb.length);
  for (let i = 0; i < samples.length; i++) samples[i] = rgb[i % rgb.length];
  const surface = {
    flags: 0,
    plane: plane,
    texinfo: { vecs: [[1, 0, 0, 0], [0, 1, 0, 0]] },
    texturemins: [-64, -64],
    extents: [128, 128],
    samples: samples,
    rgbsamples: lit,
    sampleOffset: 0,
    styles: [0, 255, 255, 255],
  };
  const node = {
    contents: 0,
    plane: plane,
    children: [LEAF, LEAF],
    firstsurface: 0,
    numsurfaces: 1,
  };
  return { lightdata: new Uint8Array(1), nodes: [node], surfaces: [surface] };
}

function aliasEntity(name = "progs/test.mdl") {
  return {
    origin: new Float32Array([0, 0, 10]),
    angles: new Float32Array([0, 45, 0]),
    model: { name: name, maxs: new Float32Array([16, 16, 16]) },
  };
}

// Runs fn with the given world, view entity, player count and dlights
// ({ origin, radius }), restoring the client state afterwards.
function withClient(
  { world, viewent = null, maxclients = 1, dlights = [], overbright = 0 },
  fn,
) {
  const saved = {
    overbright: glquake.gl_overbright_models.value,
    worldmodel: cl.worldmodel,
    viewent: cl.viewent,
    maxclients: cl.maxclients,
    time: cl.time,
    style: glquake.d_lightstylevalue[0],
  };
  const savedDlights = cl_dlights.map((d) => ({
    origin: Float32Array.from(d.origin),
    radius: d.radius,
    die: d.die,
  }));
  try {
    // id's clamps unless a test asks for gl_overbright_models
    glquake.gl_overbright_models.value = overbright;
    cl.worldmodel = world;
    cl.viewent = viewent;
    cl.maxclients = maxclients;
    cl.time = 10;
    glquake.d_lightstylevalue[0] = 256;
    for (let i = 0; i < MAX_DLIGHTS; i++) cl_dlights[i].die = 0;
    dlights.forEach((d, i) => {
      cl_dlights[i].origin.set(d.origin);
      cl_dlights[i].radius = d.radius;
      cl_dlights[i].die = 20;
      cl_dlights[i].color.set(d.color ?? [1, 1, 1]);
    });
    fn();
  } finally {
    glquake.gl_overbright_models.value = saved.overbright;
    cl.worldmodel = saved.worldmodel;
    cl.viewent = saved.viewent;
    cl.maxclients = saved.maxclients;
    cl.time = saved.time;
    glquake.d_lightstylevalue[0] = saved.style;
    savedDlights.forEach((d, i) => {
      cl_dlights[i].origin.set(d.origin);
      cl_dlights[i].radius = d.radius;
      cl_dlights[i].die = d.die;
      cl_dlights[i].color.fill(1);
    });
  }
}

// The scalar shadelight of R_DrawAliasModel before .lit support: id's
// gl_rmain.c lighting block, transcribed. `adds` are the dlights'
// radius - distance, in order.
function idShadelight(
  light,
  { gun = false, player = false, flame = false, adds = [] },
) {
  let ambientlight, shadelight;
  ambientlight = shadelight = light;
  if (gun && ambientlight < 24) {
    ambientlight = shadelight = 24;
  }
  for (const add of adds) {
    if (add > 0) {
      ambientlight += add;
      shadelight += add;
    }
  }
  if (ambientlight > 128) {
    ambientlight = 128;
  }
  if (ambientlight + shadelight > 192) {
    shadelight = 192 - ambientlight;
  }
  if (player && ambientlight < 8) {
    ambientlight = shadelight = 8;
  }
  if (flame) {
    ambientlight = shadelight = 256;
  }
  return shadelight / 200.0;
}

function shade(e) {
  const dots = gl_rmain.R_SetupAliasLighting(e);
  return { dots, c: gl_rmain.shadecolor };
}

// dlight above the entity at `dist` units, so add = radius - dist
function dlightAt(dist, radius) {
  return { origin: [0, 0, 10 + dist], radius: radius };
}

Deno.test("R_SetupAliasLighting: without a .lit the shade is id's shadelight exactly", () => {
  const cases = [];
  // plain, the clamp's three ranges (<= 96, (96, 128], > 128)
  for (const light of [0, 5, 23, 24, 60, 96, 97, 110, 128, 129, 200, 255]) {
    cases.push({ light, opts: {} });
  }
  // gun floor before a dlight, and with a non-integer dlight add
  cases.push({ light: 0, opts: { gun: true }, dlights: [dlightAt(0, 10)] });
  cases.push({
    light: 3,
    opts: { gun: true },
    dlights: [dlightAt(0.3, 17.7), dlightAt(1.1, 40.25)],
  });
  cases.push({
    light: 30,
    opts: { gun: true },
    dlights: [dlightAt(2.7, 100.9)],
  });
  // dlights pushing into each clamp range
  cases.push({ light: 70, opts: {}, dlights: [dlightAt(0.6, 33.3)] });
  cases.push({
    light: 90,
    opts: {},
    dlights: [dlightAt(1.3, 80.1), dlightAt(0.2, 9.9)],
  });
  // a player below 8, and one clamped
  cases.push({ light: 2, opts: { player: true } });
  cases.push({
    light: 2,
    opts: { player: true },
    dlights: [dlightAt(0.4, 3.1)],
  });
  cases.push({ light: 150, opts: { player: true } });
  // torches
  cases.push({
    light: 40,
    opts: { flame: true },
    dlights: [dlightAt(0.5, 20.5)],
  });

  for (const { light, opts, dlights = [] } of cases) {
    const e = aliasEntity(opts.flame ? "progs/flame2.mdl" : "progs/test.mdl");
    const viewent = opts.gun ? e : null;
    if (opts.player) e._entityIndex = 1;
    withClient({
      world: floor([light]),
      viewent,
      maxclients: opts.player ? 4 : 1,
      dlights,
    }, () => {
      // each dlight's add, computed as gl_rmain.js does
      const adds = dlights.map((_d, i) => {
        const dist = [0, 0, 0];
        VectorSubtract(e.origin, cl_dlights[i].origin, dist);
        return cl_dlights[i].radius - Length(dist);
      });
      const expected = idShadelight(light, { ...opts, adds });
      const { dots, c } = shade(e);
      const label = `light ${light} ${JSON.stringify(opts)} adds ${
        adds.join(",")
      }`;
      assertEqual(
        dots,
        r_avertexnormal_dots[2],
        `${label}: shadedots row for yaw 45`,
      );
      assertEqual(c[0], expected, `${label}: r`);
      assertEqual(c[1], expected, `${label}: g`);
      assertEqual(c[2], expected, `${label}: b`);
    });
  }
});

Deno.test("R_SetupAliasLighting: a .lit tints the shade", () => {
  withClient({ world: floor([80, 40, 20]) }, () => {
    const { c } = shade(aliasEntity());
    assertEqual(c[0], 80 / 200, "r");
    assertEqual(c[1], 40 / 200, "g");
    assertEqual(c[2], 20 / 200, "b");
  });
});

Deno.test("R_SetupAliasLighting: a coloured shade over the clamp keeps its hue", () => {
  // mean 120 (ambient 120 + shade 120 > 192): id clamps shadelight to 72
  withClient({ world: floor([240, 90, 30]) }, () => {
    const { c } = shade(aliasEntity());
    const k = 72 / 120;
    assertClose(c[0], 240 * k / 200, "r");
    assertClose(c[1], 90 * k / 200, "g");
    assertClose(c[2], 30 * k / 200, "b");
  });
});

Deno.test("R_SetupAliasLighting: a coloured dlight tints the shade", () => {
  // the 2021 quad glow: a blue dlight adding 20 lifts shadelight by 20 and
  // each channel by 20 times its colour (QuakeSpasm R_SetupAliasLighting)
  const blue = Object.assign(dlightAt(0, 20), { color: [0.25, 0.25, 1] });
  withClient({ world: floor([30, 30, 30]), dlights: [blue] }, () => {
    const { c } = shade(aliasEntity());
    assertClose(c[0], 35 / 200, "r");
    assertClose(c[1], 35 / 200, "g");
    assertClose(c[2], 50 / 200, "b");
  });
});

Deno.test("R_SetupAliasLighting: floors and dlights lift every channel alike", () => {
  // gun in a dim red light: mean 3 (R_LightPoint's integer mean), lifted to
  // 24 by adding 21 to each channel, then a white dlight adds 10 to each
  const e = aliasEntity();
  withClient({
    world: floor([9, 0, 0]),
    viewent: e,
    dlights: [dlightAt(0, 10)],
  }, () => {
    const { c } = shade(e);
    assertClose(c[0], (9 + 21 + 10) / 200, "r");
    assertClose(c[1], (0 + 21 + 10) / 200, "g");
    assertClose(c[2], (0 + 21 + 10) / 200, "b");
  });

  // player in near darkness: mean 1 lifted to 8
  const p = aliasEntity();
  p._entityIndex = 1;
  withClient({ world: floor([0, 3, 0]), maxclients: 4 }, () => {
    const { c } = shade(p);
    assertClose(c[0], 7 / 200, "r");
    assertClose(c[1], 10 / 200, "g");
    assertClose(c[2], 7 / 200, "b");
  });

  // torches stay white
  withClient({ world: floor([200, 10, 10]) }, () => {
    const { c } = shade(aliasEntity("progs/flame.mdl"));
    assertEqual(c[0], 256 / 200, "flame r");
    assertEqual(c[1], 256 / 200, "flame g");
    assertEqual(c[2], 256 / 200, "flame b");
  });
});

Deno.test("R_SetupAliasLighting: gl_overbright_models clamps the sum at 288 and lights torches", () => {
  // under 96 a channel: id's shade, unclamped
  withClient({ world: floor([60]), overbright: 1 }, () => {
    const { c } = shade(aliasEntity());
    assertEqual(c[0], 60 / 200, "dim r");
    assertEqual(c[2], 60 / 200, "dim b");
  });

  // mono 200: QuakeSpasm scales the sum 600 to 288 (96 each), where id gives
  // 192 - 128 = 64
  withClient({ world: floor([200]), overbright: 1 }, () => {
    const { c } = shade(aliasEntity());
    assertClose(c[0], 96 / 200, "bright r");
    assertClose(c[1], 96 / 200, "bright g");
  });

  // a coloured shade keeps its hue
  withClient({ world: floor([240, 90, 30]), overbright: 1 }, () => {
    const { c } = shade(aliasEntity());
    const k = 288 / 360;
    assertClose(c[0], 240 * k / 200, "hue r");
    assertClose(c[1], 90 * k / 200, "hue g");
    assertClose(c[2], 30 * k / 200, "hue b");
  });

  // no flame hack: the torch is lit as any model, its fullbrights do the rest
  withClient({ world: floor([60]), overbright: 1 }, () => {
    const { c } = shade(aliasEntity("progs/flame.mdl"));
    assertEqual(c[0], 60 / 200, "flame lit normally");
  });
});
