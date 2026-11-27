// server/headless_host.js: the whole engine (Host_Init, a local server and a
// client over the loopback driver) runs under Deno on the shareware pak, with
// no browser and no WebGL, and the client's state advances frame by frame.

import {
  headless_frame,
  HEADLESS_FRAMETIME,
  headless_init,
  headless_map,
} from "../server/headless_host.js";
import { ca_connected, cl, cl_entities, cls, SIGNONS } from "../src/client.js";
import { sv, svs } from "../src/server.js";
import { Cbuf_AddText } from "../src/cmd.js";
import { key_dest, key_game } from "../src/keys.js";
import { STAT_HEALTH } from "../src/quakedef.js";
import { GD_MAPS } from "../server/game_data.js";

function assert(cond, message) {
  if (cond !== true) {
    throw new Error(message);
  }
}

// Host_Init runs once per process, so every test shares this host and they
// run in order
await headless_init();

function stepFrames(count) {
  let ran = 0;
  for (let i = 0; i < count; i++) {
    if (headless_frame() === true) ran++;
  }

  return ran;
}

function playerOrigin() {
  const ent = cl_entities[cl.viewentity];
  return [ent.origin[0], ent.origin[1], ent.origin[2]];
}

Deno.test("headless: map e1m1 signs a loopback client on", async () => {
  const frames = await headless_map(GD_MAPS.level);

  assert(frames < 20, "signon took " + frames + " frames");
  assert(cls.signon === SIGNONS, "cls.signon " + cls.signon);
  assert(cls.state === ca_connected, "cls.state " + cls.state);
  assert(cls.demoplayback === false, "a demo is playing");
  assert(
    cls.netcon !== null && cls.netcon.address === "localhost",
    "not on the loopback driver",
  );
  assert(
    sv.active === true && sv.name === GD_MAPS.level,
    "server map " + sv.name,
  );
  assert(svs.maxclients === 1, "maxclients " + svs.maxclients);
  assert(
    cl.worldmodel !== null &&
      cl.worldmodel.name === "maps/" + GD_MAPS.level + ".bsp",
    "client world model",
  );
  assert(
    key_dest === key_game,
    "key_dest " + key_dest + ": the server would not run physics",
  );
});

Deno.test("headless: frames advance client time, stats and entities", () => {
  const cltime = cl.time;
  const svtime = sv.time;

  const ran = stepFrames(720);

  assert(ran === 720, ran + " of 720 frames ran");
  const expected = 720 * HEADLESS_FRAMETIME;
  assert(
    Math.abs(sv.time - svtime - expected) < 0.01,
    "sv.time advanced " + (sv.time - svtime),
  );
  assert(
    Math.abs(cl.time - cltime - expected) < 0.05,
    "cl.time advanced " + (cl.time - cltime),
  );
  assert(cl.stats[STAT_HEALTH] === 100, "health " + cl.stats[STAT_HEALTH]);

  // The signon sent a baseline for each of the map's entities; updates come
  // only for those in the player's PVS, which at e1m1's start is the player
  // and the shells box
  let baselines = 0;
  let seen = 0;
  for (let i = 1; i < cl.num_entities; i++) {
    if (cl_entities[i].baseline.modelindex !== 0) baselines++;
    if (cl_entities[i].model !== null) seen++;
  }

  const player = cl_entities[cl.viewentity];
  assert(baselines > 50, baselines + " entity baselines with a model");
  assert(seen >= 2, seen + " entities with a model");
  assert(
    player.model !== null && player.model.name === "progs/player.mdl",
    "player model",
  );
  assert(player.msgtime === cl.mtime[0], "player not in the latest update");
});

Deno.test("headless: console commands move the player", () => {
  const start = playerOrigin();
  try {
    Cbuf_AddText("+forward\n");
    stepFrames(72);
  } finally {
    Cbuf_AddText("-forward\n");
    stepFrames(2);
  }

  const end = playerOrigin();
  const moved = Math.hypot(end[0] - start[0], end[1] - start[1]);
  assert(
    moved > 50,
    "player moved " + moved + " units in a second of +forward",
  );
});

Deno.test("headless: a second map waits for the new level", async () => {
  await headless_map(GD_MAPS.next);

  assert(cls.signon === SIGNONS, "cls.signon " + cls.signon);
  assert(sv.name === GD_MAPS.next, "server map " + sv.name);
  assert(
    cl.worldmodel !== null &&
      cl.worldmodel.name === "maps/" + GD_MAPS.next + ".bsp",
    "client world model",
  );

  const cltime = cl.time;
  stepFrames(72);
  assert(cl.time > cltime + 0.9, "cl.time advanced " + (cl.time - cltime));
});

Deno.test("headless: a missing map rejects instead of hanging", async () => {
  let error = null;
  try {
    await headless_map("nosuchmap", 30);
  } catch (e) {
    error = e;
  }

  assert(
    error !== null && /did not start/.test(error.message),
    "expected a rejection, got " + error,
  );
  // The old level keeps running
  assert(
    cls.signon === SIGNONS && sv.name === GD_MAPS.next,
    "e1m2 is no longer running",
  );
});
