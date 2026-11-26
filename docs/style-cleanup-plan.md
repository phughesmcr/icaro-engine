# Style cleanup plan

Status: plan only, nothing done. Measured on `dev` at 1783d42 (2026-11-26).

Decisions made: adopt `deno fmt` with the settings below, collapse comment
banners to `//` lines, and include `tests/`.

## What the noise is, and where it came from

Most of the whitespace isn't C style. Blank lines after `{` and before `}`, and
`foo( a, b )` spacing, are mrdoob's three.js house style, inherited from
three-quake. The C-derived parts are the comment banners and the
`//` / `// Section` / `//` boxes.

Measured over `src/`, `main.js`, `tests/`, `server/` and `cloudflare/`
(135k lines, 36k of them blank):

| Pattern | Count | Handled by |
| --- | --- | --- |
| Blank line straight after `{` | 9,475 | `deno fmt` |
| Blank line straight before `}` | 9,539 | `deno fmt` |
| Lines with `( x )` paren padding | ~35,000 | `deno fmt` |
| Lines with `[ x ]` bracket padding | ~9,400 | `deno fmt` |
| `/* ===== Name ===== */` banners | 1,172 (445 name only, 727 with notes) | banner codemod |
| `//` / `// Section` / `//` boxes | ~376 | banner codemod |
| `if ( !x )` falsy checks | 542 | not swept (tier 4) |
| Bare `let a, b;` hoisted to the top of a function | 161 | not swept (tier 4) |
| `for ( i = 0; …` on an outer variable | 42 | not swept (tier 4) |

## Target format

The `fmt` block for root `deno.json`:

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
  "exclude": ["static/", "tests/fixtures/", ".claude/", ".vscode/", "**/*.html", "**/*.css", "**/*.svg"]
}
```

Deno 2.9.8 (the pinned version) accepts every option. The `exclude` list is
new; the reasons are below.

## Trial results

Run on a copy of the whole repository at 1783d42 with the config above, but
without `exclude`:

- `deno fmt` changed 310 files: +112k / -102k lines. Code alone: 289 of 297
  files, +108k / -100k. By folder: `src/` +59.5k/-56.5k, `tests/`
  +41.5k/-37.0k, `server/` +4.2k/-3.2k, `tools/` +2.6k/-2.4k,
  `cloudflare/` +0.3k/-0.3k. Markdown: +4.1k/-2.9k.
- `deno task lint` and `deno task check` pass.
- `deno task test`: 880 passed, 2 failed. Both tests read source files as
  text and match the old formatting:
  - `tests/pr_exec_ops_test.js` searches for `switch ( code[ o ] )`.
  - `tests/menu_advanced_test.js` matches `new cvar_t\( '…', '…'`.
- `tools/port_inventory.py` isn't run in CI, but its JS regexes assume
  single quotes (`new cvar_t\(\s*'`, `Cmd_AddCommand\(\s*'`). After the switch
  to double quotes it would find no cvars or commands and report them all as
  missing, without an error.
- Without `exclude`, the formatter also rewrote `.vscode/settings.json` (which
  the sandbox protects), `.claude/settings.json`, `static/icon.svg`,
  `index.html` and `tools/webrtc_spike/index.html`.
- Table files grow a lot because each array entry gets its own line:
  `src/anorm_dots.js` (+4,112 lines), `src/progdefs.js` (+516) and
  `src/menu_cvars.js` (+334).
- The formatter doesn't touch comments, so banners survive unchanged.
- 1,949 lines in `src/` are over 80 columns. The formatter breaks code but
  not long strings or comments, so some lines will stay over 80.

## Tiers

Each tier is a separate PR. A sweep commit holds only the tool's output, and
any hand edits go in an earlier commit.

### Tier 0: preparation (no formatting)

1. Change the two source-reading tests so they work with both formats. Match
   `switch\s*\(\s*code\[\s*o\s*\]\s*\)` and `new cvar_t\(\s*(['"])…\1`.
2. Change `tools/port_inventory.py`'s JS regexes to accept either quote. Run
   it before and after the change to check its output is the same.
3. Add `// deno-fmt-ignore-file` to tables that are clearer in rows, with a
   reason: `src/anorm_dots.js` and any rows in `src/progdefs.js` or
   `src/menu_cvars.js` that are laid out as tables. Use `// deno-fmt-ignore`
   on single statements where only one table in a file needs it.
4. Add `tools/fmt_ast_check.js`. For each file, it parses the version before
   and after (with `npm:@babel/parser`, which also reads TypeScript), drops
   positions, `raw` text and comments, and treats as equal: a block holding
   one statement and that statement on its own (`useBraces`), a quoted and an
   unquoted property key (`quoteProps`), and import or export names in a
   different order. It fails on any other difference.

### Tier 1: `deno fmt` sweep

- Commit 1: add the `fmt` block to `deno.json`. Add `deno fmt --check` to
  `deno task ci` and as a CI step in `.github/workflows/ci.yml`, ahead of
  `deno task test`. Update the rules:
  - AGENTS.md "Lint and format": replace "Never run `deno fmt` without
    `--check`" with "Run `deno fmt` before committing; CI runs
    `deno fmt --check`".
  - AGENTS.md "Code style": drop the tabs and paren-spacing rule and the
    "`server/` keeps its own formatting" line, and say the formatter decides
    layout.
  - `.claude/skills/pr/SKILL.md`: drop "Don't run `deno fmt`".
  - `.editorconfig`: `indent_style = space`, `indent_size = 2`.
  - `.vscode/settings.json`: `editor.insertSpaces: true`,
    `editor.tabSize: 2`, and optionally `editor.formatOnSave: true` with
    Deno as the formatter. The sandbox protects this file, so the maintainer
    makes this edit or it is made outside the sandbox. PR #207 also edits
    editor config, so land it first or fold this edit into it.
- Commit 2: run `deno fmt` on the JS, TS and JSON files. Nothing else goes in
  this commit.
- Verify:
  - `tools/fmt_ast_check.js` passes on every changed file.
  - Running `deno fmt` a second time changes nothing.
  - `deno task ci` passes.
  - The checksums from `tools/bench/server_bench.js`, `build_bench.js`,
    `model_bench.js` and `net_bench.js` match before and after.
  - A browser smoke test of the client: serve with the `static` preview, load
    e1m1, open the menu and the console. `src/` touches `window` and
    `document`, and CI doesn't cover rendering.

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
- Tool: a codemod script (`tools/collapse_banners.js`), run once, then
  `deno fmt`. Optionally add a lint plugin rule (`deno.json` `lint.plugins`)
  that rejects new `===` banners.
- Verify:
  - `tools/fmt_ast_check.js` passes, since it ignores comments.
  - Every identifier on a banner's name line still appears in a comment in
    the same file.
  - `deno fmt --check` and `deno task ci` pass.
- AGENTS.md "Port fidelity": give the banner format.

### Tier 3: Markdown

`proseWrap: "always"` rewraps every Markdown file to 80 columns
(+4.1k / -2.9k lines). This goes in its own docs PR because the status docs
collect most merge conflicts (AGENTS.md "Git workflow"). Until it lands, keep
`**/*.md` in `fmt.exclude`. When it lands, check that the skills' YAML front
matter in `.claude/skills/*/SKILL.md` survives, or keep `.claude/` excluded.

### Tier 4: C idioms in code (not a sweep)

The 542 `!x` checks, 161 hoisted `let` declarations and 42 outer loop
variables change behaviour or mirror the C on purpose. `!x` is not
`x === null` when `x` can be `0`, `''` or `undefined`. Fix them file by file,
when a PR is already editing that file and its tests cover the change.

## Sequencing with open PRs

The formatter touches nearly every file, so splitting the sweep by file no
longer avoids conflicts. Eleven PRs are open (#205–#215).

1. Merge or close the open PRs, and hold new feature PRs until tier 1 lands.
   This is the cheapest option.
2. A PR still open after the sweep catches up like this. Here `prep` is the
   tier 1 config commit (commit 1) and `sweep` is the formatter commit
   (commit 2), both as they exist on `dev`.

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

   `-X ours` is safe there only because `sweep` holds formatter output and
   nothing else. The branch is already formatted, so where both sides changed
   a hunk the branch's version is right. Then run `deno task ci`.
3. Do tier 2 straight after tier 1, before new PRs pile up, with the same
   recipe.

The SHAs of the sweep commits (tier 1 commit 2 and the tier 2 codemod commit)
go into `.git-blame-ignore-revs`. GitHub reads the file automatically;
locally, run `git config blame.ignoreRevsFile .git-blame-ignore-revs`. PRs
merge with merge commits, so the SHAs survive. List the sweep commits, not
the merge commits.

## Side effects to expect

- `src/x.js:123` line references in the snapshot docs (`docs/port-review.md`
  and others) go stale. They are snapshots, so leave them, or fix the ones
  still in use in the tier 3 docs PR.
- Diffs read against the C source change: C uses `foo( a )` spacing and tabs.
  The `quake-c-reference` skill compares by function, so it still works.
- `.claude/hooks/lint-delta.sh` compares lint findings, not layout, so it is
  unaffected.
