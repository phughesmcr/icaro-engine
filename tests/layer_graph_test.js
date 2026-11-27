// The layer ratchet from docs/architecture-plan.md (step 1): src/, main.js
// and server/ may not gain an import that breaks the layer rule, and the
// baseline in tools/layer_baseline.txt must drop the ones that have gone.

import {
  analyse,
  check,
  countByKind,
  formatBaseline,
  parseBaseline,
  readBaseline,
  UPDATE_COMMAND,
  violationKey,
} from "../tools/layer_graph.js";

Deno.test("layer graph matches tools/layer_baseline.txt", () => {
  const problems = check(analyse(), readBaseline());
  if (problems.length > 0) {
    throw new Error(
      `${problems.length} layer problem(s):\n${problems.join("\n")}\n` +
        `After fixing LAYERS or the imports, \`${UPDATE_COMMAND}\` ` +
        "rewrites the baseline.",
    );
  }
});

/** Writes files (path -> text) into a new temporary tree; returns its root. */
function makeTree(files) {
  const root = Deno.makeTempDirSync({ prefix: "layer_graph_test_" });
  for (const [path, text] of Object.entries(files)) {
    const dir = path.split("/").slice(0, -1).join("/");
    if (dir !== "") Deno.mkdirSync(`${root}/${dir}`, { recursive: true });
    Deno.writeTextFileSync(`${root}/${path}`, text);
  }
  return root;
}

const TREE = {
  "main.js": 'import "./src/game.js";\nimport "./src/web.js";\n',
  "src/sys.js": "export const x = 1;\n",
  "src/core.js": 'import { g } from "./game.js";\nimport "./sys.js";\n',
  "src/game.js": 'import { w } from "./web.js";\nimport "./core.js";\n' +
    'import "three";\n' +
    'export const g = 1;\nexport const w2 = () => import("./late.js");\n',
  "src/late.js": 'export * from "./web.js";\n',
  "src/web.js": 'export { x } from "./sys.js";\nexport const w = 1;\n',
  "src/app_only.js": "export const T = 1;\n",
  "server/drv.ts": 'import type { g } from "../src/game.js";\n',
};

const TREE_LAYERS = {
  "main.js": "app",
  "src/sys.js": "platform",
  "src/core.js": "core",
  "src/game.js": "game",
  "src/late.js": "game",
  "src/web.js": "browser",
  "src/app_only.js": "app",
  "server/drv.ts": "deno",
};

Deno.test("layer graph finds upward, target and cycle edges", () => {
  const root = makeTree(TREE);
  try {
    const r = analyse(root, TREE_LAYERS);
    const keys = r.violations.map(violationKey);
    const want = [
      "target src/game.js -> src/web.js",
      "target src/late.js -> src/web.js",
      "upward src/core.js -> src/game.js",
    ];
    if (JSON.stringify(keys) !== JSON.stringify(want)) {
      throw new Error(`violations ${JSON.stringify(keys)}`);
    }
    const late = r.violations.find((v) => v.from === "src/late.js");
    if (late === undefined || late.dynamic !== false) {
      throw new Error("re-export should count as a static edge");
    }
    if (!r.edges.some((e) => e.to === "src/late.js" && !e.static)) {
      throw new Error("import() of a string literal should count");
    }
    if (r.edges.some((e) => e.from === "server/drv.ts")) {
      throw new Error("import type should not count");
    }
    if (JSON.stringify(r.cycles) !== '[["src/core.js","src/game.js"]]') {
      throw new Error(`cycles ${JSON.stringify(r.cycles)}`);
    }
    if (JSON.stringify(r.three) !== '["src/game.js"]') {
      throw new Error(`three ${JSON.stringify(r.three)}`);
    }
    const counts = countByKind(r.violations);
    if (counts.upward !== 1 || counts.target !== 2) {
      throw new Error(`counts ${JSON.stringify(counts)}`);
    }
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("layer check fails on new, gone, unassigned and stale", () => {
  const root = makeTree(TREE);
  try {
    const r = analyse(root, TREE_LAYERS);
    const baseline = formatBaseline(r);
    if (check(r, baseline).length !== 0) {
      throw new Error(`clean tree: ${check(r, baseline).join("\n")}`);
    }
    if (parseBaseline(baseline).length !== r.violations.length) {
      throw new Error("baseline should list every violation");
    }

    // An edge not in the baseline
    const fewer = baseline.replace("upward src/core.js -> src/game.js\n", "");
    const added = check(r, fewer);
    if (added.length !== 1 || !added[0].startsWith("New import")) {
      throw new Error(`added: ${added.join("\n")}`);
    }
    if (!added[0].includes(UPDATE_COMMAND)) {
      throw new Error("the message should name the update command");
    }

    // A baseline edge that has gone
    const more = `${baseline}upward src/sys.js -> src/core.js\n`;
    const gone = check(r, more);
    if (gone.length !== 1 || !gone[0].startsWith("Violation gone")) {
      throw new Error(`gone: ${gone.join("\n")}`);
    }

    // A file with no layer, and a layer row with no file
    const layers = { ...TREE_LAYERS, "src/removed.js": "core" };
    delete layers["src/late.js"];
    const r2 = analyse(root, layers);
    const msgs = check(r2, formatBaseline(r2));
    if (!msgs.some((m) => m.startsWith("src/late.js has no layer"))) {
      throw new Error(`unassigned: ${msgs.join("\n")}`);
    }
    if (!msgs.some((m) => m.includes("names src/removed.js"))) {
      throw new Error(`stale: ${msgs.join("\n")}`);
    }
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});
