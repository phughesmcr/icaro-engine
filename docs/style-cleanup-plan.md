# Style cleanup plan

Status: plan only, nothing done. Measured on `dev` at 1783d42 (2026-11-26).

## What the noise is, and where it came from

Most of the whitespace isn't C style. Blank lines after `{` and before `}`, and
`foo( a, b )` spacing, are mrdoob's three.js house style, inherited from
three-quake. The C-derived parts are the comment banners and the
`//` / `// Section` / `//` boxes.

Measured over `src/`, `main.js`, `tests/`, `server/` and `cloudflare/`
(135k lines, 36k of them blank):

| Pattern | Count | Origin |
| --- | --- | --- |
| Blank line straight after `{` | 9,475 | three.js style |
| Blank line straight before `}` | 9,539 | three.js style |
| Lines with `( x )` paren padding | ~35,000 | three.js style (AGENTS.md requires it) |
| Lines with `[ x ]` bracket padding | ~9,400 | three.js style (AGENTS.md requires it) |
| `/* ===== Name ===== */` banners | 1,172 (445 name only, 727 with notes) | C |
| `//` / `// Section` / `//` boxes | ~376 | C |
| Double blank lines, trailing spaces | 15, 0 | none |
| `if ( !x )` falsy checks | 542 | C, breaks Golden Rule #2 |
| Bare `let a, b;` hoisted to the top of a function | 161 | C |
| `for ( i = 0; …` on an outer variable | 42 | C |

The padded blocks alone are about 19,000 lines: 14% of the code. Of those,
`src/` has 11,700, `tests/` 7,200 and `server/` 5. `server/` indents with
spaces and keeps its own formatting.

## Decision 1: target style

**A. Keep the house style and remove only the padding (recommended).** Delete
blank lines that pad blocks, and collapse banners (tier 2). The paren spacing
stays. The diff is deletions only, so it's easy to prove neutral and easy to
reapply on a PR branch. The code still lines up with the C for side-by-side
reading. Enforcement is a small Deno lint plugin
(`tools/lint/style_plugin.js`, listed in `deno.json` `lint.plugins`) with an
autofix, so `deno task lint` and CI catch regressions.

**B. Adopt `deno fmt`.** A trial on a copy of `src/` (tabs, single quotes,
line width 120) changed all 85 files: +35.5k / -36.7k lines. It does remove
block padding, but it also:

- drops the paren and bracket padding on about 35k lines;
- sorts and expands imports to one name per line;
- adds braces to braceless `if`/`for` bodies, which changes the token stream;
- expands numeric tables (`anorm_dots.js` grew by 4,468 lines), so tables
  need `// deno-fmt-ignore-file`.

You get a standard formatter and `deno fmt --check` in CI with no custom
tooling. The cost is that almost every line in the repository is rewritten,
every open PR conflicts everywhere, and the neutrality proof is harder.

B can follow A later. A makes B's diff smaller.

## Tiers

Each tier is a separate PR. Tiers 1 and 2 each contain a tool commit and a
sweep commit, and the sweep commit holds only the tool's output.

### Tier 1: block padding (whitespace only)

- Add the lint plugin with two rules. `no-padded-blocks` rejects a blank line
  after `{` or before `}` in blocks, classes and object literals; a blank line
  before a leading comment counts. `no-multiple-blank-lines` rejects two blank
  lines in a row. Both have autofixes. The plugin works from the AST, so
  template literals and strings are safe.
- Run `deno lint --fix` on `main.js`, `src/`, `tests/` and `cloudflare/`.
- Leave `server/` out: it has 5 cases and its own formatting rules.
- Proof of neutrality: `git diff --ignore-blank-lines --exit-code` on the
  sweep commit is empty, which means only blank lines were removed. Then
  `deno task ci`, and checksums from `tools/bench/server_bench.js`,
  `build_bench.js`, `model_bench.js` and `net_bench.js` that match before and
  after.
- AGENTS.md "Code style": add "no blank line after `{` or before `}`".

### Tier 2: banners and comment boxes (comments only)

- Name-only banners (445) become one line:
  `/*\n===\nSV_Init\n===\n*/` → `// SV_Init`. That keeps the AGENTS.md rule
  that a ported function's comment names its C function, and keeps the name
  greppable against the C source.
- Banners with notes (727) become `// SV_MarkDatagram` followed by the notes
  as `//` lines, word for word. Notes such as "Not in C" and deviation notes
  must survive unchanged.
- Section dividers (`/*\n=====\n\nEVENT MESSAGES\n\n=====\n*/`) become
  `// EVENT MESSAGES` with one blank line above.
- `//` / `// Movetype constants` / `//` boxes become `// Movetype constants`.
- Tool: a codemod script (`tools/lint/collapse_banners.js`), run once, plus a
  plugin rule that rejects new `===` banners.
- Proof of neutrality: for every file, the token stream with comments removed
  is identical before and after (a small script using the plugin AST, or
  `npm:acorn` tokens). A second check: every identifier that appeared on a
  banner's name line still appears in a comment in the same file. Then
  `deno task ci`.
- AGENTS.md "Port fidelity": give the banner format.

### Tier 3: C idioms in code (not a sweep)

The 542 `!x` checks, 161 hoisted `let` declarations and 42 outer loop
variables change tokens, and some change behaviour: `!x` is not
`x === null` when `x` can be `0`, `''` or `undefined`, and many hoisted
variables mirror the C on purpose. Don't do these mechanically. Fix them per
file, when a PR is already editing that file and its tests cover the change.
Optionally add a report-only lint rule that lists `!x` on object-typed
variables.

## Scope

- In: `main.js`, `src/`, `tests/`, `cloudflare/lobby/`.
- Out: `server/` (its own formatting), `tools/` (not linted), `static/`,
  `docs/`.

## Sequencing with open PRs

Eleven PRs are open (#205–#215). Between them they touch these code files:

`main.js`, `src/agent.js`, `src/cl_main.js`, `src/cl_parse.js`,
`src/cl_reconnect.js`, `src/gl_rlight.js`, `src/gl_rmain.js`, `src/gl_rsurf.js`,
`src/gl_screen.js`, `src/gl_screenwarp.js`, `src/host.js`, `src/host_cmd.js`,
`src/in_web.js`, `src/menu.js`, `src/menu_cvars.js`, `src/nav.js`,
`src/net_main.js`, `src/net_websocket.js`, `src/net_webtransport.js`,
`src/r_part.js`, `src/touch.js`, `src/vid.js`, `tests/agent_mcp_test.js`,
`tests/in_web_input_test.js`, `tests/menu_test.js`, plus new files those PRs
add.

1. **Tier 1a:** sweep every in-scope file not in that list. No conflicts.
2. **Tier 1b:** sweep the listed files after their PRs merge. A PR that is
   still open by then rebases with this recipe: merge the last `dev` before
   the sweep into the branch, run `deno lint --fix`, commit, then merge `dev`.
   The fixer is idempotent, so only real conflicts are left.
3. **Tier 2:** same split and the same recipe, using the codemod.
4. New PRs opened after 1a land pick the rule up from `deno task lint`.

Each sweep commit's SHA goes into `.git-blame-ignore-revs`. GitHub reads the
file automatically; locally, run
`git config blame.ignoreRevsFile .git-blame-ignore-revs`. PRs merge with
merge commits, so the SHAs survive. List the sweep commit, not the merge
commit.

## Open questions

1. Style A or B? The plan above assumes A.
2. Banner format for notes: `//` lines (as above) or a `/** … */` block?
3. Is `tests/` in scope for tier 1? It's 7,200 lines of padding, and the same
   tool handles it.
