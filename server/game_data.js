// The game data the repository's own code runs on when nobody names other
// data (web-only, no C counterpart): the tests, the benchmarks in
// tools/bench/, the headless host (headless_host.js) and the agent MCP
// server, the servers' default -pak, the nav graphs (tools/nav/nav_build.js)
// and the room benchmarks. One place, so a change of data is one edit here
// and in the tests' expectations. A player's own data (id1, the mission
// packs, the rerelease) is chosen with -pak, -game, ?base= or the Game data
// panel, as before, and nothing here changes how it loads.
//
// The data is id's shareware pak0, committed at static/pak0.pak.

/** What the data is, for text that names it (the agent MCP server's). */
export const GD_TITLE = "id1 shareware episode 1";

/** The id1 pak, relative to the repository root (deno tasks, -pak). */
export const GD_PAK = "static/pak0.pak";

/**
 * True when pak1.pak, pak2.pak... beside GD_PAK belong to the data and are
 * mounted too (headless_init's pak_sequence). The servers always mount the
 * sequence.
 */
export const GD_PAK_SEQUENCE = false;

/** The repository root, as a file system path ending in a slash. */
export const GD_ROOT = decodeURIComponent(
  new URL("../", import.meta.url).pathname,
);

/** GD_PAK as a file system path. */
export const GD_PAK_PATH = GD_ROOT + GD_PAK;

/** The directory holding GD_PAK (id1's), a file system path with a slash. */
export const GD_ID1_DIR = GD_PAK_PATH.slice(
  0,
  GD_PAK_PATH.lastIndexOf("/") + 1,
);

/**
 * The basedir holding the data (common.c's basedir: id1/ lives in it, or is
 * it, as static/ is for static/pak0.pak), as a file system path ending in a
 * slash. Loose files (maps/, music/) are looked up below it.
 */
export const GD_BASE_DIR = GD_ROOT + "static/";

/**
 * Maps by role, for code that needs a level of some kind rather than a
 * particular one:
 * - hub: the start map, where a new game begins (servers' default map).
 * - level: a single-player level with monsters, doors and an exit, the one
 *   tests and agent tools load by default.
 * - next: the level that level's exit leads to.
 */
export const GD_MAPS = Object.freeze({
  hub: "start",
  level: "e1m1",
  next: "e1m2",
});

/**
 * The benchmarks' default map lists (tools/bench/*.js, -maps overrides).
 * Their checksums are recorded per map, so a list changes only with the data.
 */
export const GD_BENCH_MAPS = Object.freeze({
  server: Object.freeze(["start", "e1m1", "e1m3", "e1m6"]),
  build: Object.freeze(["start", "e1m1", "e1m3", "e1m6", "e2m3"]),
  world: Object.freeze(["start", "e1m1", "e1m3", "e1m6", "e2m3"]),
  net: Object.freeze(["e1m3", "e1m7", "dm3", "e1m2:coop"]),
  load: Object.freeze([
    "maps/start.bsp",
    "maps/e1m1.bsp",
    "maps/e1m3.bsp",
    "maps/e1m6.bsp",
  ]),
});
