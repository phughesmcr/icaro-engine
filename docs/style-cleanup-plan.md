# Style cleanup plan

Status: tier 0 done (#217); tier 1 done (#218); tier 2 done (#219); tier 3 done
(#220); tier 4 goes file by file (see below). Measured on `dev` at b8f46e7
(2026-11-26), after #205–#215 merged.

Decisions made: adopt `deno fmt` with the settings below, and include `tests/`.
Comment banners go: `/** */` documents a declaration, and every other comment is
`//` (this replaced the first decision, which made every banner `//` lines).

## What the noise is, and where it came from

Most of the whitespace isn't C style. Blank lines after `{` and before `}`, and
`foo( a, b )` spacing, are mrdoob's three.js house style, inherited from
three-quake. The C-derived parts are the comment banners and the `//` /
`// Section` / `//` boxes.

Measured over `src/`, `main.js`, `tests/`, `server/` and `cloudflare/lobby/src/`
(141k lines, 38k of them blank):

| Pattern                                                                | Count                  | Handled by         |
| ---------------------------------------------------------------------- | ---------------------- | ------------------ |
| Blank line straight after `{`                                          | 9,925                  | `deno fmt`         |
| Blank line straight before `}`                                         | 9,986                  | `deno fmt`         |
| Lines with `( x )` paren padding                                       | ~37,600                | `deno fmt`         |
| Lines with `[ x ]` bracket padding                                     | ~9,700                 | `deno fmt`         |
| `/*` / `=====` / Name / `=====` / `*/` banners in `src/` and `main.js` | 1,202 (756 with notes) | banner codemod     |
| Empty `//` lines (mostly `//` / `// Section` / `//` boxes)             | 434                    | banner codemod     |
| `if ( !x )` / `while ( !x )` falsy checks                              | 553                    | not swept (tier 4) |
| Bare `let a, b;` hoisted to the top of a function, in `src/`           | 162                    | not swept (tier 4) |
| `for ( i = 0; …` on an outer variable, in `src/`                       | 42                     | not swept (tier 4) |

The padded blocks come to about 20,000 lines: 12,100 in `src/`, 7,700 in
`tests/` and 5 in `server/`.

## Target format

This replaces the `"fmt": { "exclude": ["./"] }` block that #207 added to root
`deno.json`:

```json
"fmt": {
  "useTabs": false,
  "indentWidth": 2,
  "lineWidth": 80,
  "semiColons": true,
  "singleQuote": false,
  "proseWrap": "always",
  "bracePosition": "sameLine",
  "nextControlFlowPosition": "sameLine",
  "operatorPosition": "sameLine",
  "useBraces": "whenNotSingleLine",
  "trailingCommas": "onlyMultiLine",
  "quoteProps": "asNeeded",
  "typeLiteral.separatorKind": "semiColon",
  "sortNamedImports": "caseInsensitive",
  "sortNamedExports": "caseInsensitive",
  "newLineKind": "lf",
  "exclude": [
    "static/", "tests/fixtures/", ".claude/", ".vscode/",
    "**/*.html", "**/*.css", "**/*.svg"
  ]
}
```

The pinned Deno (2.9.8) accepts every option. `server/deno.json` has no `fmt`
block, so the root settings apply under `server/` too (checked: formatting
`server/` with `--config deno.json` gives identical output). Tiers 1 and 2 also
excluded `**/*.md`; tier 3 removed it.

## Scope

- Formatted: `main.js`, `sw.js`, `src/`, `server/`, `tests/`, `cloudflare/`,
  `tools/` (JS and TS), and the JSON and JSONC files outside the excluded
  folders (`deno.json`, `server/deno.json`, both `wrangler.jsonc`).
- `server/` was going to keep its own formatting. A single formatter for the
  whole repository replaces that rule. Most of `server/` is tab-indented; only
  four `.ts` drivers use two spaces (`client_address.ts`,
  `net_websocket_server.ts`, `net_webtransport_server.ts`, `quic_listen.ts`). It
  is small, so it changes least (+4.3k / -3.3k lines).
- `tools/` has no tests and isn't linted or run in CI. For those files the AST
  check below is the only proof that nothing changed.
- Not formatted: `static/`, `tests/fixtures/`, `.claude/`, `.vscode/`, HTML, CSS
  and SVG (`index.html` and `tools/webrtc_spike/index.html` need a browser
  check, so they wait). Markdown was left out until tier 3.

## Trial results

Run on a copy of `dev` at b8f46e7 with the config above and the tier 0 test
fixes applied:

- `deno fmt` changed 304 files: +113k / -104k lines. By folder: `src/`
  +61.4k/-58.3k (89 files), `tests/` +44.1k/-39.3k (177 files), `server/`
  +4.3k/-3.3k, `tools/` +2.5k/-2.4k, `cloudflare/` +0.3k/-0.2k, `main.js`
  +0.3k/-0.3k. The only non-code files it touched were `server/deno.json` and
  the two `wrangler.jsonc` files.
- `deno task test`: 961 passed, 0 failed. `deno task lint` and `deno task check`
  pass. Running `deno fmt --check` straight after reports nothing, so the
  formatter is stable.
- Without the tier 0 fixes, two tests fail because they read source files as
  text and match the old layout:
  - `tests/pr_exec_ops_test.js` looks for `switch ( code[ o ] )` and parses case
    labels with `/^case (\d+): \{? ?\/\/ (OP_\w+)/`.
  - `tests/menu_advanced_test.js` collects cvar defaults with
    `new cvar_t\( '…', '…'` and `name: '…', string: '…'`. The fixed patterns
    find the same 199 cvar defaults in the old and the new layout. No other test
    reads `src/`, `server/` or `main.js` as text.
- `tools/port_inventory.py` isn't run in CI, but its JS regexes assume single
  quotes (`new cvar_t\(\s*'`, `Cmd_AddCommand\(\s*'`, `name:\s*'`). After the
  switch to double quotes it would find no cvars or commands and report them all
  as missing, with no error. With both quotes accepted, it finds the same 119
  cvars, 80 cvar objects and 153 commands before and after formatting.
- Table files grow a lot because each array entry gets its own line:
  `src/anorm_dots.js` (+4,112 lines), `src/progdefs.js` (+516) and
  `src/menu_cvars.js` (+334).
- The formatter leaves comments alone: banners survive as they are, just
  re-indented.
- Lines over 80 characters in `src/` drop from 2,108 (counting a tab as one)
  to 455. The rest are long strings and comments, which the formatter doesn't
  break.

## Tiers

Each tier is a separate PR. A sweep commit holds only the tool's output, and any
hand edits go in an earlier commit.

### Tier 0: preparation (no formatting)

Done on `refactor/fmt-prep`:

1. The two source-reading tests accept either layout: any spacing around `(`,
   `[` and `{`, and either quote. `menu_advanced_test.js` still finds the same
   199 cvar defaults.
2. `tools/port_inventory.py`'s JS patterns accept either quote, including the
   `''` stub body and the `Cvar_VariableValue( '…' )` reads. Its output (both
   modes) is byte-identical on the current code and on a copy formatted with the
   settings above.
3. Six tables keep their rows under a `// deno-fmt-ignore` line:
   `r_avertexnormal_dots` (`src/anorm_dots.js`), `crctable` (`src/crc.js`),
   `turbsin` (`src/gl_warp.js`), `pop` (`src/common.js`), its test copy
   `popShorts` (`tests/sv_engine_fixes_test.js`) and `advancedPages`
   (`src/menu_cvars.js`). Without the markers they grow by 4,112, 219, 204, 43,
   23 and 344 lines. `src/progdefs.js` has no marker: it grows because one-line
   getters and setters get one statement per line, which is ordinary code
   formatting, and its `globalvars_t_fields` rows stay one per line anyway.
4. `tools/fmt_ast_check.js <base-ref> [<file>...]` compares each changed
   `.js`/`.ts` file's syntax tree with its version at `<base-ref>`, using
   `@babel/parser` 8.1.3 (pinned in `deno.lock`). It ignores positions,
   comments, raw text and redundant parentheses, and accepts:
   - a block holding one statement and that statement on its own (`useBraces`).
     That includes a lone `if`: the trees are already parsed, so an `else`
     belongs to the same `if` either way;
   - an empty statement dropped from a statement list;
   - a quoted and an unquoted property key with the same name (`quoteProps`);
   - a different order of the names inside one `import { … }` or `export { … }`.
     Anything else fails, including import declarations that moved: some modules
     are in import cycles where order matters (AGENTS.md "Engine gotchas"). On a
     copy of this branch formatted with the settings above, every changed file
     matches (302 files, about 4 seconds). After formatting, a changed number, a
     changed string or two swapped import declarations are each reported.

### Tier 1: `deno fmt` sweep

- Commit 1, config and rules:
  - Replace the `fmt` block in `deno.json` with the one above.
  - Add `deno fmt --check` to `deno task ci`, and add it as a step in
    `.github/workflows/ci.yml` ahead of `deno task test`.
  - AGENTS.md "Lint and format": replace "`deno fmt` is off … Don't remove the
    exclusion" with "Run `deno fmt` before committing; CI runs
    `deno fmt --check`".
  - AGENTS.md "Code style": drop the tabs and paren-spacing rule and the
    "`server/` keeps its own formatting" line, and say the formatter decides
    layout.
  - `.claude/skills/pr/SKILL.md`: drop "Don't format with `deno fmt`".
  - `.editorconfig`: `indent_style = space` and `indent_size = 2` under `[*]`,
    and remove the now-redundant
    `[server/{client_address,net_websocket_server,net_webtransport_server,quic_listen}.ts]`
    section.
  - `.vscode/settings.json`: `editor.insertSpaces: true`, `editor.tabSize: 2`,
    and optionally `editor.formatOnSave: true` with Deno as the formatter. The
    sandbox protects this file, so the maintainer makes this edit or it is made
    outside the sandbox.
- Commit 2: run `deno fmt`. Nothing else goes in this commit.
- Verify:
  - `tools/fmt_ast_check.js` passes on every changed file.
  - `deno fmt --check` passes.
  - `deno task ci` passes.
  - The checksums from `tools/bench/server_bench.js`, `build_bench.js`,
    `model_bench.js` and `net_bench.js` match before and after.
  - A browser smoke test of the client: serve with the `static` preview, load
    e1m1, and open the menu and the console. `src/` touches `window` and
    `document`, and CI doesn't cover rendering.
- Add the commit 2 SHA to `.git-blame-ignore-revs`.

Results, on `refactor/deno-fmt` (commit 2 is 21dc0a3):

- `deno fmt` changed 307 files (+107,587/−103,827 lines).
- `tools/fmt_ast_check.js` against `dev` (1c690bd): 303 of 303 changed
  `.js`/`.ts` files match. The other four are `deno.json`, `server/deno.json`
  and the two `wrangler.jsonc` files.
- `deno fmt --check` is clean, and `deno task ci` passes (963 tests, lint,
  type-check).
- Every checksum and hash from the server, build, model and net benchmarks is
  identical before and after.
- Browser smoke test with the `static` preview: e1m1 loads and plays, and the
  main menu, the Options menu and the console work. The only console errors are
  404s for `pak1.pak`, which isn't present.

### Tier 2: banners and comment boxes (comments only)

`/** */` documents a declaration; everything else is `//`. The codemod,
`tools/collapse_banners.js`, decides from the syntax tree, so strings and code
are never touched. Its header gives the rules:

- A banner directly on a top-level declaration or class member, whose first line
  is the declaration's name:
  - with notes, it becomes `/** notes */`, the name line dropped and the notes
    kept word for word. Notes such as "Not in C" and deviation notes survive
    unchanged, and now show on hover in an editor;
  - with no notes, it is deleted: the declaration below carries the same C name.
- A banner whose first line names something else (a C function above its scratch
  variables, `Cmd_Unalias_f -- johnfitz`, a pair such as
  `S_AmbientOff / S_AmbientOn`) becomes `//` lines, so the C name it records
  stays where it was.
- A plain block directly on a declaration becomes `/** */`, unless its first
  line is only another name.
- Every other block (section dividers, file notes, comments inside functions)
  becomes `//` lines, rules dropped and relative indentation kept.
- Runs of `//` lines lose rule lines and empty `//` lines at either end, and
  `====` rules inside them.
- A block made into `//` lines gets a blank line after it when a `//` comment
  follows directly, so the two don't read as one.
- Left alone: existing `/** */`, comments sharing a line with code, and
  directives (`deno-lint-ignore`, `deno-fmt-ignore`, `@ts-*`).
- Then `deno fmt`. A second run of the codemod changes nothing.

Verify:

- `tools/fmt_ast_check.js` passes (it ignores comments, so it proves the code is
  untouched).
- `tools/collapse_banners.js --verify <base>`: the words of every file's
  comments match in order, and the only words gone are names declared in that
  file that stood alone on their line.
- The number of directive comments is unchanged.
- `tools/port_inventory.py` output is byte-identical, in both modes.
- `deno fmt --check` and `deno task ci` pass. The code is unchanged, so the
  benchmarks and a browser check add nothing.

Results (#219):

- The codemod deleted 301 name-only banners and 2 blocks of rules only. It made
  633 banners into doc comments (name line dropped) and 28 plain blocks into doc
  comments. It made 312 blocks into `//` lines, 118 of them banners naming
  something else. It trimmed 381 `//` runs and deleted 20 that were only rules.
- With `deno fmt`: 109 files, +3,862/−10,597 lines.
- `fmt_ast_check.js`: 109 of 109 files match. `--verify`: 306 of 306 files keep
  their comment text, and 934 names went (301 + 633).
- 13 directive comments before and after.
- `port_inventory.py` showed a bug: it removed `/* */` before `//`, so a `/*`
  quoted inside a `//` comment in `gl_md5.js` hid 211 lines. It now removes both
  in one pass. Its output on the old tree is unchanged by the fix, and it is
  byte-identical before and after the sweep.

### Tier 3: Markdown

`proseWrap: "always"` rewraps every Markdown file to 80 columns. A trial without
the exclusion changed +4.1k / -2.9k lines of Markdown. It goes in its own docs
PR because the status docs collect most merge conflicts (AGENTS.md "Git
workflow"). That PR removes `**/*.md` from `fmt.exclude`. `.claude/` stays
excluded, so the YAML front matter of its skills and agents isn't touched.

Results (#220):

- One sweep commit: 17 Markdown files, +4,222 / -3,060 lines, the `exclude`
  change in `deno.json` included. Of the other 5 tracked Markdown files, the 4
  under `.claude/` are excluded and `.github/pull_request_template.md` was
  already formatted.
- Rendered with markdown-it (CommonMark and GFM tables) before and after, all 17
  files give the same prose once whitespace is collapsed. Two code blocks
  changed, both whitespace only: `deno fmt` formats fenced YAML and JS
  (`server/README.md`, `docs/port-review.md`).
- dprint pads every row of a table to its widest cell, and there's no option to
  turn that off. One long cell widens the whole table: `docs/port-review.md`
  accounts for +1,345 / -475 of the lines, and some of its rows are now 377
  characters wide. They render the same.

### Tier 4: C idioms in code (not a sweep)

The 553 `!x` checks, 162 hoisted `let` declarations and 42 outer loop variables
change behaviour or mirror the C on purpose. `!x` is not `x === null` when `x`
can be `0`, `''` or `undefined`. Fix them file by file, when a PR is already
editing that file and its tests cover the change.

## Sequencing with open PRs

When this was written one PR was open: #216 (MCP SDK, since merged), which
touched `server/agent_mcp.ts`, `tests/agent_mcp_*.js`,
`tests/agent_goto_test.js`, `deno.json`, `deno.lock`, `server/deno.json` and
docs.

1. Land #216 (or any PR close to done) before tier 1 commit 2, and hold new
   feature PRs until tiers 1 and 2 land.
2. A PR still open after the sweep catches up as follows. `prep` is tier 1
   commit 1 and `sweep` is tier 1 commit 2, both as they exist on `dev`.

   ```bash
   git merge prep
   ```

   ```bash
   deno fmt && git commit -am "Format with deno fmt"
   ```

   ```bash
   git merge -X ours sweep
   ```

   ```bash
   deno fmt --check && git merge origin/dev
   ```

   Then run `deno task ci`. `-X ours` works because `sweep` holds formatter
   output and nothing else, and the branch is already formatted, so where both
   sides changed a hunk the branch's version is right.

   Tested on #215's head, against `dev` as it was before #215 merged: the tree
   this recipe produced was identical to the result of merging #215 normally and
   then running `deno fmt`.
3. Do tier 2 straight after tier 1. An open PR catches up with the same steps:
   `prep` is tier 2 commit 1 (the codemod) and `sweep` is tier 2 commit 2, and
   the second step runs the codemod before `deno fmt`:

   ```bash
   deno run --allow-read --allow-write --allow-run=git tools/collapse_banners.js && deno fmt && git commit -am "Collapse the comment banners"
   ```
4. Tier 3 has no prep commit: the sweep (`a4843f9`) carries the `exclude`
   change. Its parent is `dev` at #219's merge, so a PR branched earlier merges
   that parent first, resolving conflicts normally (after steps 2 and 3 if it
   predates them). Only then is `-X ours` safe, because the sweep is all that is
   left to merge:

   ```bash
   git merge a4843f9^
   ```

   ```bash
   git merge -X ours a4843f9 && deno fmt
   ```

   ```bash
   git diff --quiet || git commit -am "Format the Markdown with deno fmt"
   ```

   ```bash
   deno fmt --check && git merge origin/dev
   ```

   Then run `deno task ci`. Tested on a scratch branch from `6469eb6` that
   edited a paragraph and a table row in `docs/port-review.md` and a line in
   AGENTS.md: the tree it produced was identical to the branch's edits formatted
   with `deno fmt`.

The SHAs of the sweep commits (tier 1 commit 2, tier 2 commit 2 and the tier 3
sweep) go into `.git-blame-ignore-revs`. GitHub reads that file automatically;
locally, run `git config blame.ignoreRevsFile .git-blame-ignore-revs`. PRs merge
with merge commits, so the SHAs survive. List the sweep commits, not the merge
commits.

## Side effects to expect

- `src/x.js:123` line references in the snapshot docs (`docs/port-review.md` and
  others) go stale. They are snapshots, so leave them. Tier 3 only reformatted
  the docs and fixed none of them.
- Reading the port side by side with the C changes: C uses tabs and `foo( a )`
  spacing. The `quake-c-reference` skill finds functions by name and compares
  behaviour, not layout, so its steps still apply.
- `.claude/hooks/lint-delta.sh` compares lint findings, not layout, so it is
  unaffected.
