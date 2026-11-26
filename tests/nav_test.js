// Navigation graph (src/nav.js) on the data's level map (GD_MAPS.level in
// server/game_data.js; the expectations are e1m1's): build time, paths
// from the player start to the exit and to items, and waypoint sanity.

// nav.js first: it must load on its own, as the browser and tools use it
const nav = await import("../src/nav.js");
const { COM_EnsureFile } = await import("../src/pak.js");
const { GD_MAPS } = await import("../server/game_data.js");
const { TD_Mount } = await import("./test_data.js");
const { COM_InitArgv } = await import("../src/common.js");
const { Memory_Init } = await import("../src/zone.js");
const { Mod_Init, Mod_ForName } = await import("../src/gl_model.js");
const { cls, ca_dedicated } = await import("../src/client.js");

function assert(cond, message) {
  if (cond !== true) {
    throw new Error(message);
  }
}

const MAP = GD_MAPS.level;
const MAP_FILE = "maps/" + MAP + ".bsp";

// The map's info_player_start, and items from its entity lump
const START = [480, -352, 88];
const ITEMS = {
  item_armor1: [688, 480, 80],
  weapon_supershotgun: [-360, 2912, -80],
  item_artifact_super_damage: [544, 2480, -88],
  item_artifact_envirosuit: [712, 2040, -408],
};

// Quiet the engine's console output ("backup past 0" from hull traces)
async function quietly(fn) {
  const log = console.log, debug = console.debug;
  console.log = () => {};
  console.debug = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
    console.debug = debug;
  }
}

let world = null;
async function loadE1M1() {
  if (world !== null) {
    return world;
  }
  const state = cls.state;
  await quietly(async () => {
    COM_InitArgv(["nav_test"]);
    Memory_Init();
    Mod_Init();
    // the repository's data alone: a local registered pak1.pak beside the
    // shareware pak0 isn't mounted, as these expectations are for its map
    await TD_Mount();
    assert(await COM_EnsureFile(MAP_FILE) === true, MAP + " present");
    cls.state = ca_dedicated; // no textures: as the Deno server loads maps
    try {
      world = Mod_ForName(MAP_FILE, true);
    } finally {
      cls.state = state;
    }
  });
  return world;
}

let graph = null;
async function build() {
  if (graph === null) {
    const w = await loadE1M1();
    graph = await quietly(() => nav.Nav_Build(w));
  }

  return graph;
}

function pathFlags(path) {
  let f = 0;
  for (let i = 0; i < path.count; i++) {
    f |= path.flags[i];
  }
  return f;
}

// Every step of a path is a move the link types allow
function checkWaypoints(g, path, label) {
  for (let i = 1; i < path.count; i++) {
    const f = path.flags[i];
    const dx = path.pos[i * 3] - path.pos[i * 3 - 3];
    const dy = path.pos[i * 3 + 1] - path.pos[i * 3 - 2];
    const dz = path.pos[i * 3 + 2] - path.pos[i * 3 - 1];
    const h = Math.sqrt(dx * dx + dy * dy);
    if ((f & (nav.NAV_LINK_TELEPORT | nav.NAV_LINK_PLAT)) !== 0) {
      continue;
    }
    assert(
      h <= g.grid * Math.SQRT2 + 33,
      `${label}: step ${i} is ${h.toFixed(1)} units across`,
    );
    if ((f & nav.NAV_LINK_SWIM) !== 0) {
      continue;
    }
    // walking climbs at most a step (18) per 16-unit sub-step
    const maxRise = (f & nav.NAV_LINK_JUMP) !== 0 ? 40 : 18 * Math.ceil(h / 16);
    assert(
      dz <= maxRise + 0.1,
      `${label}: step ${i} rises ${dz.toFixed(1)} (flags ${f})`,
    );
  }
}

Deno.test("Nav_Build: e1m1 builds quickly into a connected graph", async () => {
  const w = await loadE1M1();
  const g = await build();
  console.log(
    `e1m1 nav: ${g.node_count} nodes, ${g.link_count} links, ${
      g.build_ms.toFixed(1)
    } ms (first build)`,
  );
  // generous for CI machines; about 0.1 s on an M-series Mac
  assert(g.build_ms < 3000, `build took ${g.build_ms.toFixed(0)} ms`);
  assert(
    g.node_count > 2000 && g.node_count < 20000,
    `node count ${g.node_count}`,
  );
  assert(g.link_count > g.node_count * 3, `link count ${g.link_count}`);

  // most nodes in one component
  const comp = nav.Nav_Components(g);
  const sizes = new Map();
  for (let i = 0; i < g.node_count; i++) {
    sizes.set(comp[i], (sizes.get(comp[i]) || 0) + 1);
  }
  const biggest = Math.max(...sizes.values());
  assert(
    biggest > g.node_count * 0.95,
    `largest component ${biggest} of ${g.node_count}`,
  );

  // CSR links are in range
  assert(
    g.link_start[0] === 0 && g.link_start[g.node_count] === g.link_count,
    "link_start bounds",
  );
  for (let i = 0; i < g.node_count; i++) {
    assert(
      g.link_start[i] <= g.link_start[i + 1],
      `link_start not monotonic at ${i}`,
    );
  }
  for (let l = 0; l < g.link_count; l++) {
    assert(
      g.link_to[l] >= 0 && g.link_to[l] < g.node_count,
      `link ${l} to ${g.link_to[l]}`,
    );
  }

  // a second build gives the same graph
  const g2 = await quietly(() => nav.Nav_Build(w));
  assert(
    g2.node_count === g.node_count && g2.link_count === g.link_count,
    "rebuild counts",
  );
  for (let i = 0; i < g.node_pos.length; i++) {
    assert(g2.node_pos[i] === g.node_pos[i], "rebuild node_pos");
  }
  for (let l = 0; l < g.link_count; l++) {
    assert(
      g2.link_to[l] === g.link_to[l] && g2.link_flags[l] === g.link_flags[l],
      "rebuild links",
    );
  }
});

Deno.test("Nav_Build: e1m1 entities mark doors, plats, the teleporter and the exit", async () => {
  const g = await build();
  let doorLinks = 0, platLinks = 0, teleLinks = 0, dropLinks = 0, jumpLinks = 0;
  for (let l = 0; l < g.link_count; l++) {
    if ((g.link_flags[l] & nav.NAV_LINK_DROP) !== 0) dropLinks++;
    if ((g.link_flags[l] & nav.NAV_LINK_JUMP) !== 0) jumpLinks++;
    if ((g.link_flags[l] & nav.NAV_LINK_DOOR) !== 0) doorLinks++;
    if ((g.link_flags[l] & nav.NAV_LINK_PLAT) !== 0) platLinks++;
    if ((g.link_flags[l] & nav.NAV_LINK_TELEPORT) !== 0) teleLinks++;
  }

  assert(doorLinks > 0, "door links");
  assert(platLinks > 0, "plat ride links");
  assert(teleLinks > 0, "teleport links");
  assert(dropLinks > 0, "drop links");
  assert(jumpLinks > 0, "jump links");

  const tele = g.ents.find((e) => e.classname === "trigger_teleport");
  assert(
    tele !== undefined && tele.dest_node >= 0,
    "teleporter has a destination node",
  );

  // a node in the teleporter leads straight to the destination
  const te = g.ents.indexOf(tele);
  let inside = -1;
  for (let i = 0; i < g.node_count && inside < 0; i++) {
    if (
      (g.node_flags[i] & nav.NAV_NODE_TELEPORT) !== 0 && g.node_ent[i] === te
    ) inside = i;
  }
  assert(inside >= 0, "teleporter nodes");
  const tp = nav.Nav_FindPathNodes(g, inside, tele.dest_node);
  assert(
    tp !== null && tp.count === 2 &&
      (tp.flags[1] & nav.NAV_LINK_TELEPORT) !== 0 && tp.cost === 16,
    "teleport hop",
  );
  const exit = g.ents.find((e) => e.classname === "trigger_changelevel");
  assert(
    exit !== undefined && exit.map === GD_MAPS.next && exit.nodes > 0,
    "exit nodes",
  );

  // the bridge over the slime is a door, raised by a button
  const bridge = g.ents.find((e) =>
    e.classname === "func_door" && e.targetname === "t2"
  );
  assert(
    bridge !== undefined && bridge.opens === "trigger",
    "bridge opens by trigger",
  );
  assert(
    bridge.activators.some((a) => a.classname === "func_button"),
    "bridge button",
  );
});

Deno.test("Nav_FindPath: e1m1 start to the exit", async () => {
  const g = await build();
  const exit = g.ents.find((e) => e.classname === "trigger_changelevel");
  const centre = [0, 1, 2].map((k) => (exit.mins[k] + exit.maxs[k]) / 2);
  const t = performance.now();
  const path = nav.Nav_FindPath(g, START, centre);
  const ms = performance.now() - t;
  assert(path !== null, "no path to the exit");
  console.log(
    `e1m1 start to exit: ${path.count} waypoints, cost ${
      path.cost.toFixed(0)
    }, ${ms.toFixed(2)} ms`,
  );
  const last = path.node[path.count - 1];
  assert(
    (g.node_flags[last] & nav.NAV_NODE_EXIT) !== 0,
    "path ends in the exit trigger",
  );
  assert(
    (pathFlags(path) & nav.NAV_LINK_DOOR) !== 0,
    "path goes through a door",
  );
  checkWaypoints(g, path, "exit");

  // starts at the node nearest the start
  const first = path.node[0];
  const d = Math.hypot(
    g.node_pos[first * 3] - START[0],
    g.node_pos[first * 3 + 1] - START[1],
    g.node_pos[first * 3 + 2] - START[2],
  );
  assert(d < 32, `first waypoint ${d.toFixed(1)} units from the start`);
});

Deno.test("Nav_FindPath: e1m1 start to items", async () => {
  const g = await build();
  for (const [name, p] of Object.entries(ITEMS)) {
    const path = nav.Nav_FindPath(g, START, p);
    assert(path !== null, `no path to ${name}`);
    const k = path.count - 1;
    const d = Math.hypot(path.pos[k * 3] - p[0], path.pos[k * 3 + 1] - p[1]);
    assert(d < 64, `${name}: path ends ${d.toFixed(1)} units away`);
    checkWaypoints(g, path, name);
  }
});

Deno.test("Nav_FindPath: unreachable and off-map targets give null", async () => {
  const g = await build();
  assert(nav.Nav_NearestNode(g, [99999, 99999, 0]) === -1, "off-map nearest");
  assert(
    nav.Nav_FindPath(g, START, [99999, 99999, 0]) === null,
    "off-map path",
  );

  // a node the start can't reach (outside its forward closure)
  const s = nav.Nav_NearestNode(g, START);
  const seen = new Uint8Array(g.node_count);
  const stack = [s];
  seen[s] = 1;
  while (stack.length > 0) {
    const n = stack.pop();
    for (let l = g.link_start[n]; l < g.link_start[n + 1]; l++) {
      const m = g.link_to[l];
      if (seen[m] === 0) {
        seen[m] = 1;
        stack.push(m);
      }
    }
  }

  const unreachable = seen.indexOf(0);
  assert(unreachable >= 0, "some node is unreachable");
  assert(
    nav.Nav_FindPathNodes(g, s, unreachable) === null,
    "path to an unreachable node",
  );
});

Deno.test("Nav_FindPath: queries reuse the graph's path buffer", async () => {
  const g = await build();
  const a = nav.Nav_FindPath(g, START, ITEMS.item_armor1);
  const count = a.count;
  const b = nav.Nav_FindPath(g, START, ITEMS.weapon_supershotgun);
  assert(a === b && a === g.path, "same path object");
  assert(b.count !== count, "overwritten by the second query");

  // a trivial path: start to itself
  const s = nav.Nav_NearestNode(g, START);
  const p = nav.Nav_FindPathNodes(g, s, s);
  assert(p !== null && p.count === 1 && p.cost === 0, "path to itself");

  // bad node indices
  assert(
    nav.Nav_FindPathNodes(g, -1, s) === null &&
      nav.Nav_FindPathNodes(g, s, g.node_count) === null,
    "out-of-range nodes",
  );
});
