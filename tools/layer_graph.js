// Measures the import graph of src/, main.js and server/ against the layer
// plan in docs/architecture-plan.md (step 1, "Checker and ratchet"). Web-only
// tooling, no C source.
//
// Layers, lowest first: platform, core, game (games/quake), app (entry
// points). A module may import its own layer or a lower one. Core and game
// may import only target-neutral platform modules; the browser-only and
// Deno-only ones are imported by entry points, which register them. LAYERS
// below says where each file goes once the plan's moves are done, not where
// it is now. A file the plan splits is listed under the layer most of it
// goes to.
//
// Two kinds of violation are counted, as unique (importer, imported) file
// pairs; static imports, re-exports and string-literal import() count,
// `import type` does not:
//   upward  an import from a lower layer to a higher one
//   target  core or game importing a browser-only or Deno-only module
// Cycles (static imports only) are reported but not ratcheted: the plan
// allows them inside a layer.
//
// tests/layer_graph_test.js fails when a violation appears that is not in
// tools/layer_baseline.txt, when one listed there has gone, or when a file is
// missing from LAYERS. Each step of the plan lowers the baseline.
//
// Usage, from the repository root:
//   deno task layers             report violations and cycles
//   deno task layers --check     the test's checks; exits 1 on a problem
//   deno task layers --update    rewrite tools/layer_baseline.txt
//   deno task layers --json      the analysis as JSON
// --root=<dir> analyses another checkout (needs --allow-read for it).

import { parse } from "@babel/parser";

/**
 * The layer of every module the checker reads. Values:
 *   browser   platform, browser-only (platform/browser/)
 *   deno      platform, Deno-only (platform/deno/, in server/ for now)
 *   platform  platform, target-neutral
 *   core      core/
 *   game      games/quake/
 *   app       entry points and the services that compose the layers
 * A new file must be added here (docs/architecture-plan.md, File-by-file
 * assignment); later steps of the plan edit this table.
 */
export const LAYERS = {
  // platform/browser/
  "src/autosave.js": "browser",
  // Not in the plan: tracker music through libopenmpt and Web Audio.
  "src/bgm_tracker.js": "browser",
  "src/cd_audio.js": "browser", // split
  "src/gl_contextloss.js": "browser",
  // Not in the plan: keeps a browser-hosted room running while its tab is
  // hidden (visibility, a Worker's ticks). Its server and console imports
  // become hooks registered by main.js.
  "src/host_hidden.js": "browser",
  // Not in the plan: the Worker script host_hidden.js starts.
  "src/host_tick_worker.js": "browser",
  "src/in_web.js": "browser", // split
  // Not in the plan (later than it): the intro page gating main.js (DOM).
  "src/intro.js": "browser",
  // Not in the plan: downloads LibreQuake into the browser's storage.
  "src/librequake.js": "browser",
  "src/net_rtclobby.js": "browser", // split
  "src/net_webrtc.js": "browser",
  "src/net_websocket.js": "browser",
  "src/net_webtransport.js": "browser",
  "src/pwa_launch.js": "browser",
  "src/touch.js": "browser", // split
  "src/touch_editor.js": "browser",
  "src/touch_layout.js": "browser",
  "src/turnstile.js": "browser",
  // Not in the plan: the page's URL parameters (imported by main.js, intro
  // and vid). Its menu_cvars import becomes a hook or moves with the cvars.
  "src/url_config.js": "browser",
  "src/userdata.js": "browser", // split
  "src/vid.js": "browser", // split
  // Not in the plan: vid_vsync's frame loop (requestAnimationFrame or a
  // MessageChannel loop, paused while the page is hidden).
  "src/vid_vsync.js": "browser",
  // Not in the plan: the Screen Wake Lock shared by touch and hosting.
  "src/wake_lock.js": "browser",
  "src/webxr.js": "browser",
  // platform/deno/, staying in server/ for now
  "server/browser_shim.js": "deno",
  "server/client_address.ts": "deno",
  "server/net_websocket_server.ts": "deno",
  "server/net_webtransport_server.ts": "deno",
  "server/quic_listen.ts": "deno",
  "server/sys_server.ts": "deno",
  // platform, target-neutral: sys's print and error hooks (its DOM code is
  // split out to platform/browser/)
  "src/sys.js": "platform",
  // core: files and data
  "src/anorm_dots.js": "core",
  "src/bspfile.js": "core",
  "src/common.js": "core", // split, step 12
  "src/crc.js": "core",
  "src/image.js": "core",
  "src/mathlib.js": "core",
  "src/pak.js": "core",
  "src/unicode_translit.js": "core",
  "src/wad.js": "core",
  "src/zone.js": "core",
  // core: console and commands
  "src/cmd.js": "core",
  "src/console.js": "core",
  "src/cvar.js": "core",
  "src/keys.js": "core",
  // core: QuakeC VM
  "src/pr_comp.js": "core",
  "src/pr_edict.js": "core",
  "src/pr_exec.js": "core",
  "src/pr_sprintf.js": "core",
  "src/progs.js": "core",
  // core: net
  "src/net.js": "core", // split
  "src/net_loop.js": "core",
  "src/net_main.js": "core",
  // core: sound
  "src/snd_dma.js": "core",
  "src/snd_mem.js": "core",
  "src/snd_mix.js": "core",
  // Not in the plan: finds the music inside an Unreal .umx (pure parsing).
  "src/snd_umx.js": "core",
  "src/sound.js": "core",
  // core: models (gl_model.js is a facade over the #280 split)
  "src/gl_md5.js": "core",
  "src/gl_model.js": "core",
  "src/gl_model_upload.js": "core",
  "src/mod_alias.js": "core",
  "src/mod_brush.js": "core",
  "src/mod_sprite.js": "core",
  "src/mod_types.js": "core",
  "src/model.js": "core",
  // core: renderer
  "src/gl_draw.js": "core",
  "src/gl_entalpha.js": "core",
  "src/gl_fog.js": "core",
  "src/gl_gamma.js": "core",
  "src/gl_mesh.js": "core",
  "src/gl_rdebug.js": "core",
  "src/gl_refrag.js": "core",
  "src/gl_rlight.js": "core",
  "src/gl_rmain.js": "core",
  "src/gl_rmirror.js": "core",
  "src/gl_rmisc.js": "core",
  "src/gl_rsurf.js": "core",
  "src/gl_screenwarp.js": "core",
  "src/gl_sky.js": "core",
  "src/gl_softemu.js": "core",
  "src/gl_warmup.js": "core",
  "src/gl_warp.js": "core",
  "src/glquake.js": "core",
  "src/r_part.js": "core",
  "src/render.js": "core",
  "src/vid_dynres.js": "core",
  // games/quake/: shared
  "src/default_cfg.js": "game",
  "src/host.js": "game",
  "src/host_cmd.js": "game",
  "src/pr_cmds.js": "game",
  "src/progdefs.js": "game",
  "src/protocol.js": "game", // split: ENTALPHA_* move to core
  "src/quakedef.js": "game", // split: engine limits move to core
  "src/room_rules.js": "game",
  // games/quake/: client
  "src/chase.js": "game",
  "src/cl_demo.js": "game",
  "src/cl_input.js": "game",
  "src/cl_main.js": "game",
  "src/cl_parse.js": "game",
  "src/cl_pred.js": "game",
  "src/cl_reconnect.js": "game",
  "src/cl_tent.js": "game",
  "src/client.js": "game",
  "src/gl_screen.js": "game",
  "src/menu.js": "game",
  "src/menu_cvars.js": "game",
  "src/pmove.js": "game",
  "src/sbar.js": "game",
  "src/view.js": "game",
  // games/quake/: server
  "src/server.js": "game",
  "src/sv_main.js": "game",
  "src/sv_move.js": "game",
  "src/sv_phys.js": "game",
  "src/sv_user.js": "game",
  "src/world.js": "game",
  // games/quake/: agent
  "src/agent.js": "game",
  "src/nav.js": "game",
  // entry points, and the lobby's helpers that import nothing from src/
  "main.js": "app",
  "server/agent_mcp.ts": "app",
  // Not in the plan: the default game data config for servers and tests.
  "server/game_data.js": "app",
  "server/game_server.js": "app",
  "server/headless_host.js": "app",
  "server/lobby_rtc.js": "app",
  "server/lobby_server.js": "app",
  "server/room_config.js": "app",
  "server/room_process_manager.ts": "app",
  "server/turnstile.js": "app",
};

/** Rank of each layer; an import may not go to a higher rank. */
const RANK = { browser: 0, deno: 0, platform: 0, core: 1, game: 2, app: 3 };

/** Layers that core and game may not import. */
const TARGET_SPECIFIC = new Set(["browser", "deno"]);

/** Layers whose importers the target rule applies to. */
const NEUTRAL = new Set(["core", "game"]);

/** The baseline, relative to the root. */
export const BASELINE_FILE = "tools/layer_baseline.txt";

/** The command that rewrites the baseline. */
export const UPDATE_COMMAND = "deno task layers --update";

const DEFAULT_ROOT = decodeURIComponent(
  new URL("../", import.meta.url).pathname,
);

const SOURCE_EXT = /\.(js|ts)$/;

/** Lists the analysed files under root, as sorted root-relative paths. */
function listFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const e of Deno.readDirSync(`${root}/${dir}`)) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory) walk(p);
      else if (e.isFile && SOURCE_EXT.test(e.name)) out.push(p);
    }
  };
  for (const name of ["main.js"]) {
    try {
      if (Deno.statSync(`${root}/${name}`).isFile) out.push(name);
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    }
  }
  walk("src");
  walk("server");
  return out.sort();
}

/** Resolves an import specifier to a root-relative path, or null if external. */
function resolveSpec(from, spec) {
  if (!spec.startsWith("./") && !spec.startsWith("../")) return null;
  const parts = from.split("/").slice(0, -1);
  for (const s of spec.split("/")) {
    if (s === ".") continue;
    if (s === "..") parts.pop();
    else parts.push(s);
  }
  return parts.join("/");
}

/** Visits every AST node below node, skipping position data. */
function walkAst(node, fn) {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const c of node) walkAst(c, fn);
    return;
  }
  if (typeof node.type === "string") fn(node);
  for (const k in node) {
    if (
      k === "loc" || k === "start" || k === "end" || k === "extra" ||
      k === "leadingComments" || k === "trailingComments" ||
      k === "innerComments"
    ) continue;
    const v = node[k];
    if (v !== null && typeof v === "object") walkAst(v, fn);
  }
}

/** The imports of one file: [{ spec, kind, names }]. */
function readImports(path, text) {
  const ast = parse(text, {
    sourceType: "module",
    plugins: path.endsWith(".ts") ? ["typescript"] : [],
  });
  const out = [];
  for (const n of ast.program.body) {
    if (n.type === "ImportDeclaration") {
      if (n.importKind === "type") continue;
      const names = n.specifiers.filter((s) => s.importKind !== "type")
        .map((s) =>
          s.type === "ImportSpecifier" ?
            (s.imported.name ?? s.imported.value) :
            s.type === "ImportNamespaceSpecifier" ?
            "*" :
            "default"
        );
      out.push({ spec: n.source.value, kind: "static", names });
    } else if (n.type === "ExportAllDeclaration") {
      if (n.exportKind === "type") continue;
      out.push({ spec: n.source.value, kind: "static", names: ["*"] });
    } else if (n.type === "ExportNamedDeclaration" && n.source !== null) {
      if (n.exportKind === "type") continue;
      const names = n.specifiers.map((s) => s.local.name ?? s.local.value);
      out.push({ spec: n.source.value, kind: "static", names });
    }
  }
  walkAst(ast.program, (n) => {
    if (n.type === "ImportExpression") {
      const a = n.source;
      if (a.type === "StringLiteral") {
        out.push({ spec: a.value, kind: "dynamic", names: ["*"] });
      }
    }
  });
  return out;
}

/** Tarjan's strongly connected components of size > 1, largest first. */
function cyclesOf(nodes, adj) {
  let index = 0;
  const idx = new Map();
  const low = new Map();
  const on = new Set();
  const stack = [];
  const out = [];
  const strong = (v) => {
    idx.set(v, index);
    low.set(v, index);
    index++;
    stack.push(v);
    on.add(v);
    for (const w of adj.get(v) ?? []) {
      if (!idx.has(w)) {
        strong(w);
        low.set(v, Math.min(low.get(v), low.get(w)));
      } else if (on.has(w)) low.set(v, Math.min(low.get(v), idx.get(w)));
    }
    if (low.get(v) === idx.get(v)) {
      const c = [];
      let w;
      do {
        w = stack.pop();
        on.delete(w);
        c.push(w);
      } while (w !== v);
      if (c.length > 1) out.push(c.sort());
    }
  };
  for (const v of nodes) if (!idx.has(v)) strong(v);
  return out.sort((a, b) => b.length - a.length || a[0].localeCompare(b[0]));
}

function adjacency(edges) {
  const adj = new Map();
  for (const e of edges) {
    if (!adj.has(e.from)) adj.set(e.from, new Set());
    adj.get(e.from).add(e.to);
  }
  return adj;
}

/** The baseline line for a violation. */
export function violationKey(v) {
  return `${v.kind} ${v.from} -> ${v.to}`;
}

/**
 * Reads the import graph under root and classifies it with layers.
 * Returns { files, edges, unassigned, stale, violations, cycles,
 * layerCycles, three }.
 */
export function analyse(root = DEFAULT_ROOT, layers = LAYERS) {
  const files = listFiles(root);
  const known = new Set(files);
  const pairs = new Map();
  const three = [];
  for (const f of files) {
    const text = Deno.readTextFileSync(`${root}/${f}`);
    for (const imp of readImports(f, text)) {
      if (imp.spec === "three" || imp.spec.startsWith("three/")) {
        if (!three.includes(f)) three.push(f);
        continue;
      }
      const to = resolveSpec(f, imp.spec);
      if (to === null || !known.has(to)) continue;
      const k = `${f}>${to}`;
      let e = pairs.get(k);
      if (e === undefined) {
        e = { from: f, to, static: false, names: [] };
        pairs.set(k, e);
      }
      if (imp.kind === "static") e.static = true;
      for (const n of imp.names) if (!e.names.includes(n)) e.names.push(n);
    }
  }
  const edges = [...pairs.values()];
  const layerOf = (f) => Object.hasOwn(layers, f) ? layers[f] : null;
  const unassigned = files.filter((f) => layerOf(f) === null);
  const stale = Object.keys(layers).filter((f) => !known.has(f)).sort();

  const violations = [];
  for (const e of edges) {
    const a = layerOf(e.from);
    const b = layerOf(e.to);
    if (a === null || b === null) continue;
    const base = {
      from: e.from,
      to: e.to,
      fromLayer: a,
      toLayer: b,
      dynamic: !e.static,
      names: e.names,
    };
    if (RANK[b] > RANK[a]) violations.push({ kind: "upward", ...base });
    if (NEUTRAL.has(a) && TARGET_SPECIFIC.has(b)) {
      violations.push({ kind: "target", ...base });
    }
  }
  violations.sort((x, y) => violationKey(x).localeCompare(violationKey(y)));

  const staticEdges = edges.filter((e) => e.static);
  const cycles = cyclesOf(files, adjacency(staticEdges));
  const within = staticEdges.filter((e) =>
    layerOf(e.from) !== null && layerOf(e.from) === layerOf(e.to)
  );
  const layerCycles = cyclesOf(files, adjacency(within))
    .map((c) => ({ layer: layerOf(c[0]), files: c }));

  return {
    files,
    edges,
    unassigned,
    stale,
    violations,
    cycles,
    layerCycles,
    three: three.sort(),
  };
}

/** Parses baseline text into its sorted violation lines. */
export function parseBaseline(text) {
  return text.split("\n").map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#")).sort();
}

/** The baseline text for an analysis. */
export function formatBaseline(result) {
  const lines = result.violations.map(violationKey);
  const counts = countByKind(result.violations);
  return [
    "# Import edges that break the layer rule today (tools/layer_graph.js).",
    `# Written by \`${UPDATE_COMMAND}\`; don't edit by hand.`,
    "# tests/layer_graph_test.js fails if an edge is added to or gone from",
    "# this list; each step of docs/architecture-plan.md lowers it.",
    `# upward ${counts.upward}, target ${counts.target}`,
    ...lines,
    "",
  ].join("\n");
}

/** Violation counts: { upward, target }. */
export function countByKind(violations) {
  const out = { upward: 0, target: 0 };
  for (const v of violations) out[v.kind]++;
  return out;
}

function describe(v) {
  const names = v.names.length > 8 ?
    `${v.names.slice(0, 8).join(", ")}, ... (${v.names.length})` :
    v.names.join(", ");
  return `${v.kind} ${v.from} (${v.fromLayer}) -> ${v.to} (${v.toLayer})` +
    `${v.dynamic ? " [import()]" : ""}: ${names}`;
}

/**
 * Compares an analysis with the baseline text. Returns a list of problems,
 * each a message for the author; empty when the graph matches.
 */
export function check(result, baselineText) {
  const problems = [];
  for (const f of result.unassigned) {
    problems.push(
      `${f} has no layer. Add it to LAYERS in tools/layer_graph.js (see ` +
        "docs/architecture-plan.md, File-by-file assignment), then run " +
        `\`${UPDATE_COMMAND}\`.`,
    );
  }
  for (const f of result.stale) {
    problems.push(
      `LAYERS in tools/layer_graph.js names ${f}, which no longer exists. ` +
        "Remove its row (or rename it if the file moved).",
    );
  }
  const base = new Set(parseBaseline(baselineText));
  const now = new Map(result.violations.map((v) => [violationKey(v), v]));
  for (const [k, v] of now) {
    if (base.has(k)) continue;
    problems.push(
      `New import that breaks the layer rule: ${describe(v)}. Reach the ` +
        "higher layer through a hook (the *_SetExternals functions, or a " +
        "driver table) or import from a lower layer instead; see " +
        "docs/architecture-plan.md. If it can't be avoided yet, record it " +
        `with \`${UPDATE_COMMAND}\` and say why in the PR.`,
    );
  }
  for (const k of base) {
    if (now.has(k)) continue;
    problems.push(
      `Violation gone: ${k}. Lower the baseline: run \`${UPDATE_COMMAND}\` ` +
        `and commit ${BASELINE_FILE}.`,
    );
  }
  return problems;
}

/** Reads the baseline under root; empty text if there is none. */
export function readBaseline(root = DEFAULT_ROOT) {
  try {
    return Deno.readTextFileSync(`${root}/${BASELINE_FILE}`);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return "";
    throw e;
  }
}

function tally(violations, kind) {
  const m = new Map();
  for (const v of violations) {
    if (v.kind !== kind) continue;
    const k = `${v.fromLayer} -> ${v.toLayer}`;
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`)
    .join(", ");
}

function report(result) {
  const p = (s = "") => console.log(s);
  const counts = countByKind(result.violations);
  const src = result.files.filter((f) => f.startsWith("src/")).length;
  p(`files: ${result.files.length} (src ${src}), import pairs: ${result.edges.length}`);
  if (result.unassigned.length > 0) {
    p(`unassigned (add to LAYERS): ${result.unassigned.join(" ")}`);
  }
  if (result.stale.length > 0) {
    p(`LAYERS rows with no file: ${result.stale.join(" ")}`);
  }
  p(`upward: ${counts.upward} (${tally(result.violations, "upward")})`);
  p(`target: ${counts.target} (${tally(result.violations, "target")})`);
  for (const kind of ["upward", "target"]) {
    p();
    p(
      kind === "upward" ?
        "Upward imports:" :
        "Browser-only or Deno-only modules imported by core or game:",
    );
    for (const v of result.violations) {
      if (v.kind === kind) p(`  ${describe(v).slice(kind.length + 1)}`);
    }
  }
  p();
  p(`Cycles (static imports): ${
    result.cycles.map((c) => c.length).join(", ") || "none"
  }`);
  for (const c of result.cycles) p(`  ${c.length}: ${c.join(" ")}`);
  p();
  p(
    "Cycles left inside each layer if every violation were cut: " +
      (result.layerCycles.map((c) => `${c.layer} ${c.files.length}`)
        .join(", ") || "none"),
  );
  for (const c of result.layerCycles) {
    p(`  ${c.layer} ${c.files.length}: ${c.files.join(" ")}`);
  }
  p();
  p(`three importers (${result.three.length}): ${result.three.join(" ")}`);
}

if (import.meta.main) {
  const args = Deno.args;
  const rootArg = args.find((a) => a.startsWith("--root="));
  const root = rootArg !== undefined ? rootArg.slice(7) : DEFAULT_ROOT;
  const result = analyse(root);
  if (args.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else if (args.includes("--update")) {
    if (result.unassigned.length > 0 || result.stale.length > 0) {
      for (const msg of check(result, formatBaseline(result))) {
        console.error(msg);
      }
      console.error("Baseline not written: fix LAYERS first.");
      Deno.exit(1);
    }
    const before = parseBaseline(readBaseline(root));
    const text = formatBaseline(result);
    Deno.writeTextFileSync(`${root}/${BASELINE_FILE}`, text);
    const after = parseBaseline(text);
    const counts = countByKind(result.violations);
    console.log(
      `${BASELINE_FILE}: upward ${counts.upward}, target ${counts.target} ` +
        `(${after.filter((l) => !before.includes(l)).length} added, ` +
        `${before.filter((l) => !after.includes(l)).length} removed)`,
    );
  } else if (args.includes("--check")) {
    const problems = check(result, readBaseline(root));
    for (const msg of problems) console.error(msg);
    if (problems.length > 0) Deno.exit(1);
    const counts = countByKind(result.violations);
    console.log(
      `layers ok: upward ${counts.upward}, target ${counts.target}`,
    );
  } else {
    report(result);
  }
}
