// Collapse the C-style comment banners (tier 2 of docs/style-cleanup-plan.md).
//
// Usage, from the repository root:
//   deno run --allow-read --allow-write --allow-run=git tools/collapse_banners.js [--dry] [<file>...]
//   deno run --allow-read --allow-run=git tools/collapse_banners.js --verify <base-ref> [<file>...]
//
// With no files it takes every tracked .js and .ts file that deno fmt
// formats. Run deno fmt afterwards. Running it twice changes nothing.
//
// Rules, for a /* */ comment on lines of its own:
//   - Rule lines (====, ----) and blank lines at either end are dropped.
//   - On a top-level declaration or class member (directly below, no blank
//     line between, directive comments allowed):
//       - a block whose only text is the declaration's name is deleted;
//       - a block whose first line is the name, followed by notes, becomes a
//         /** */ doc comment holding the notes;
//       - a banner whose first line names something else becomes // lines,
//         so the C name it records stays put;
//       - a block with no rule lines becomes a /** */ doc comment, unless
//         its first line is only a name, and not the declaration's;
//   - Anywhere else it becomes // lines.
// A run of // lines loses rule lines and empty // lines at either end, and
// ==== rules inside it. A block made into // lines gets a blank line after it
// when a // comment follows directly.
// Doc comments (/** */), comments sharing a line with code, and directives
// (deno-lint-ignore, deno-fmt-ignore, @ts-*) are left alone. The text inside
// a comment is kept word for word, with its relative indentation.
//
// --verify compares the comment text of each file with its version at
// <base-ref>: the words must match in order, and the only words allowed to
// go are names declared in the file that stood alone on their line (the
// deleted name-only banners and titles). Exit status: 0 when every file passes, 1 otherwise.

import { parse } from "npm:@babel/parser@8.1.3";

const RULE = /^[=\-*]{4,}$/;
// A title line that is only a name: a C function's, when it isn't the
// declaration's own
const IDENT = /^[A-Za-z_$][\w$]*$/;
const DIRECTIVE = /^\s*(deno-|@ts-|eslint|prettier|<reference)/;

function parseSource(text, path) {
  return parse(text, {
    sourceType: "module",
    plugins: path.endsWith(".ts") ? ["typescript"] : [],
  });
}

function declName(node) {
  if (node === null || node === undefined) return null;
  switch (node.type) {
    case "ExportNamedDeclaration":
    case "ExportDefaultDeclaration":
      return declName(node.declaration);
    case "VariableDeclaration":
      return node.declarations[0].id.type === "Identifier" ?
        node.declarations[0].id.name :
        "";
    case "ClassMethod":
    case "ClassPrivateMethod":
    case "ClassProperty":
    case "ClassPrivateProperty":
    case "ClassAccessorProperty":
    case "TSDeclareMethod":
      return node.key.name ?? node.key.id?.name ?? node.key.value ?? "";
    default:
      return node.id?.name ?? "";
  }
}

// Start offset -> name of each declaration a doc comment can document:
// top-level statements that declare something, and class members
function documentable(ast) {
  const out = new Map();
  const DECL =
    /Declaration$|^TSDeclareFunction$|^TSModuleDeclaration$|^TSEnumDeclaration$/;
  function visitClass(cls) {
    for (const m of cls.body.body) out.set(m.start, declName(m));
  }
  for (const stmt of ast.program.body) {
    if (!DECL.test(stmt.type) || stmt.type === "ImportDeclaration") continue;
    if (stmt.type === "ExportNamedDeclaration" && stmt.declaration === null) {
      continue;
    }
    out.set(stmt.start, declName(stmt));
    const inner = stmt.declaration ?? stmt;
    if (inner.type === "ClassDeclaration") visitClass(inner);
  }
  return out;
}

function lineStart(text, at) {
  return text.lastIndexOf("\n", at - 1) + 1;
}

function lineEnd(text, at) {
  const nl = text.indexOf("\n", at);
  return nl < 0 ? text.length : nl;
}

function ownLine(text, c) {
  const before = text.slice(lineStart(text, c.start), c.start);
  const after = text.slice(c.end, lineEnd(text, c.end));
  return /^[ \t]*$/.test(before) && /^[ \t]*$/.test(after);
}

// The block's text as lines: star prefixes, outer rules and outer blank lines
// removed, common indent stripped
function blockLines(value) {
  let lines = value.split("\n");
  const inner = lines.slice(1).filter((l) => l.trim() !== "");
  if (inner.length > 0 && inner.every((l) => /^\s*\*/.test(l))) {
    lines = lines.map((l, i) => i === 0 ? l : l.replace(/^\s*\*+ ?/, ""));
  }
  lines = lines.map((l) => l.replace(/\s+$/, ""));
  let hasRule = false;
  const isEdge = (l) => l.trim() === "" || RULE.test(l.trim());
  while (lines.length > 0 && isEdge(lines[0])) {
    if (RULE.test(lines[0].trim())) hasRule = true;
    lines.shift();
  }
  while (lines.length > 0 && isEdge(lines[lines.length - 1])) {
    if (RULE.test(lines[lines.length - 1].trim())) hasRule = true;
    lines.pop();
  }
  // A rule straight under the title: "==== / Name / ==== / notes"
  if (lines.length > 1 && RULE.test(lines[1].trim())) {
    hasRule = true;
    lines.splice(1, 1);
  }
  const indents = lines.filter((l) => l.trim() !== "").map((l) =>
    /^\s*/.exec(l)[0].length
  );
  const cut = indents.length > 0 ? Math.min(...indents) : 0;
  lines = lines.map((l) => l.slice(cut));
  // A title centred with tabs
  if (lines.length > 0) lines[0] = lines[0].trimStart();
  return { lines, hasRule };
}

function asLineComments(lines, indent) {
  return lines.map((l) => indent + (l === "" ? "//" : "// " + l)).join("\n");
}

function asDocComment(lines, indent) {
  if (lines.length === 1 && indent.length + lines[0].length + 7 <= 80) {
    return indent + "/** " + lines[0] + " */";
  }
  return [
    indent + "/**",
    ...lines.map((l) => indent + (l === "" ? " *" : " * " + l)),
    indent + " */",
  ].join("\n");
}

// What follows comment c: a documentable declaration directly below it
// (directive line comments allowed between), or null
function target(text, ast, docs, c, comments, index) {
  let at = c.end;
  let k = index + 1;
  for (;;) {
    const gap = text.slice(at, comments[k]?.start ?? text.length);
    const m = /^[ \t]*\n[ \t]*/.exec(gap);
    if (m === null) return null; // same line, or a blank line between
    const next = at + m[0].length;
    const nc = comments[k];
    if (nc !== undefined && nc.start === next) {
      if (nc.type !== "CommentLine" || !DIRECTIVE.test(nc.value)) return null;
      at = nc.end;
      k++;
      continue;
    }
    return docs.has(next) ? docs.get(next) : null;
  }
}

function precededByDirective(text, comments, index) {
  const prev = comments[index - 1];
  if (prev === undefined || prev.type !== "CommentLine") return false;
  if (!DIRECTIVE.test(prev.value)) return false;
  return /^[ \t]*\n[ \t]*$/.test(text.slice(prev.end, comments[index].start));
}

export function collapse(text, path) {
  const ast = parseSource(text, path);
  const docs = documentable(ast);
  const comments = ast.comments;
  const edits = []; // [start, end, replacement]
  const report = [];

  for (let i = 0; i < comments.length; i++) {
    const c = comments[i];
    if (c.type !== "CommentBlock") continue;
    if (c.value.startsWith("*") && !c.value.startsWith("**")) continue;
    if (c.value.startsWith("*") && c.value === "*") continue;
    if (!ownLine(text, c)) continue;
    if (precededByDirective(text, comments, i)) continue;

    const start = lineStart(text, c.start);
    const end = Math.min(lineEnd(text, c.end) + 1, text.length);
    const indent = text.slice(start, c.start);
    const { lines, hasRule } = blockLines(c.value);
    const name = target(text, ast, docs, c, comments, i);
    const line = c.loc.start.line;

    let out;
    let action;
    if (lines.length === 0) {
      out = "";
      action = "delete (rules only)";
    } else if (name !== null && lines[0].trim() === name) {
      const notes = lines.slice(1);
      while (notes.length > 0 && notes[0].trim() === "") notes.shift();
      if (notes.length === 0) {
        out = "";
        action = "delete (name only)";
      } else {
        out = asDocComment(notes, indent) + "\n";
        action = "doc (name dropped)";
      }
    } else if (name !== null && !hasRule && !IDENT.test(lines[0].trim())) {
      out = asDocComment(lines, indent) + "\n";
      action = "doc";
    } else {
      out = asLineComments(lines, indent) + "\n";
      // Keep it apart from a // comment right below, which says something else
      if (/^[ \t]*\/\//.test(text.slice(end, lineEnd(text, end)))) out += "\n";
      action = name !== null ? "lines (other name)" : "lines";
    }
    edits.push([start, end, out]);
    report.push({ line, action, name, title: lines[0] ?? "" });
  }

  // Runs of // lines, each on its own line, on consecutive lines
  for (let i = 0; i < comments.length;) {
    const c = comments[i];
    if (c.type !== "CommentLine" || !ownLine(text, c)) {
      i++;
      continue;
    }
    let j = i + 1;
    while (
      j < comments.length && comments[j].type === "CommentLine" &&
      ownLine(text, comments[j]) &&
      comments[j].loc.start.line === comments[j - 1].loc.start.line + 1 &&
      comments[j].loc.start.column === c.loc.start.column
    ) j++;
    const run = comments.slice(i, j);
    i = j;
    if (run.some((r) => DIRECTIVE.test(r.value))) continue;
    if (run.some((r) => r.value.startsWith("/"))) continue; // /// <reference>
    const edge = (r) => r.value.trim() === "" || RULE.test(r.value.trim());
    let a = 0;
    let b = run.length;
    while (a < b && edge(run[a])) a++;
    while (b > a && edge(run[b - 1])) b--;
    // Inside the run only rules of = go: --- can be part of a table
    const keep = run.slice(a, b).filter((r) => !/^={4,}$/.test(r.value.trim()));
    if (a === 0 && b === run.length && keep.length === run.length) continue;
    const start = lineStart(text, run[0].start);
    const end = Math.min(
      lineEnd(text, run[run.length - 1].end) + 1,
      text.length,
    );
    const out = keep.map((r) =>
      text.slice(lineStart(text, r.start), r.end) + "\n"
    ).join("");
    edits.push([start, end, out]);
    report.push({
      line: run[0].loc.start.line,
      action: keep.length === 0 ? "delete // rules" : "trim // run",
      name: null,
      title: keep.length === 0 ? "" : keep[0].value.trim(),
    });
  }

  edits.sort((x, y) => y[0] - x[0]);
  let result = text;
  for (const [s, e, r] of edits) {
    result = result.slice(0, s) + r + result.slice(e);
  }
  return { result, report };
}

// --verify: the words of every comment, in order
function commentWords(text, path) {
  const ast = parseSource(text, path);
  const words = []; // [word, alone on its line]
  for (const c of ast.comments) {
    for (const line of c.value.split("\n")) {
      const t = line.replace(/^\s*\*(?!\/)/, "").replace(/[=\-*]{4,}/g, " ");
      const ws = t.split(/\s+/).filter((w) => w !== "" && w !== "*");
      for (const w of ws) words.push([w, ws.length === 1]);
    }
  }
  const declared = new Set();
  (function walk(n) {
    if (n === null || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (typeof n.type === "string") {
      const name = declName(n);
      if (/Declaration$|^Class(Private)?(Method|Property)$/.test(n.type)) {
        if (name !== null && name !== "") declared.add(name);
      }
    }
    for (const k of Object.keys(n)) {
      if (k !== "loc" && k !== "comments" && !k.endsWith("Comments")) {
        walk(n[k]);
      }
    }
  })(ast.program);
  return { words, declared };
}

function verifyFile(before, after, path) {
  const a = commentWords(before, path).words;
  const { words: b, declared } = commentWords(after, path);
  const dropped = [];
  let j = 0;
  for (let i = 0; i < a.length; i++) {
    const [word, alone] = a[i];
    if (j < b.length && word === b[j][0]) {
      j++;
    } else if (alone && declared.has(word)) {
      dropped.push(word); // a banner's name line
    } else {
      return {
        ok: false,
        why: "word " + JSON.stringify(word) + " lost or changed",
      };
    }
  }
  if (j !== b.length) {
    return { ok: false, why: "new word " + JSON.stringify(b[j][0]) };
  }
  return { ok: true, dropped };
}

async function git(args) {
  const out = await new Deno.Command("git", {
    args,
    stdout: "piped",
    stderr: "piped",
  })
    .output();
  if (out.success !== true) {
    throw new Error(
      "git " + args.join(" ") + ": " + new TextDecoder().decode(out.stderr),
    );
  }
  return new TextDecoder().decode(out.stdout);
}

async function defaultFiles(ref) {
  const roots = [
    "main.js",
    "sw.js",
    "src",
    "server",
    "tests",
    "cloudflare",
    "tools",
  ];
  const args = ref === null ?
    ["ls-files", "--", ...roots] :
    ["ls-tree", "-r", "--name-only", ref, "--", ...roots];
  return (await git(args)).split("\n").filter((f) =>
    /\.(js|ts)$/.test(f) && !f.startsWith("tests/fixtures/") &&
    f !== "tools/collapse_banners.js"
  );
}

async function main(args) {
  if (args[0] === "--verify") {
    if (args.length < 2) {
      console.error(
        "usage: tools/collapse_banners.js --verify <base-ref> [<file>...]",
      );
      return 2;
    }
    const base = args[1];
    const files = args.length > 2 ? args.slice(2) : await defaultFiles(base);
    let bad = 0;
    let droppedCount = 0;
    for (const f of files) {
      const r = verifyFile(
        await git(["show", base + ":" + f]),
        await Deno.readTextFile(f),
        f,
      );
      if (!r.ok) {
        console.log(f + ": " + r.why);
        bad++;
      } else droppedCount += r.dropped.length;
    }
    console.log(
      (files.length - bad) + " of " + files.length +
        " files keep their comment text; " +
        droppedCount + " declared names dropped",
    );
    return bad === 0 ? 0 : 1;
  }

  const dry = args[0] === "--dry";
  const files = dry ? args.slice(1) : args;
  const list = files.length > 0 ? files : await defaultFiles(null);
  const totals = {};
  for (const f of list) {
    const text = await Deno.readTextFile(f);
    const { result, report } = collapse(text, f);
    for (const r of report) {
      totals[r.action] = (totals[r.action] ?? 0) + 1;
      if (dry) {
        console.log(
          f + ":" + r.line + " " + r.action +
            (r.name !== null ? " [" + r.name + "]" : "") + " " +
            JSON.stringify(r.title),
        );
      }
    }
    if (!dry && result !== text) await Deno.writeTextFile(f, result);
  }
  for (const k of Object.keys(totals).sort()) {
    console.log(String(totals[k]).padStart(6) + " " + k);
  }
  return 0;
}

if (import.meta.main) Deno.exit(await main(Deno.args));
