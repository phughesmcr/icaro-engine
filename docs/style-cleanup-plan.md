# Style cleanup plan

Status: tier 0 done on `refactor/fmt-prep`; tiers 1–4 not started. Measured on `dev` at b8f46e7 (2026-11-26),
after #205–#215 merged.

Decisions made: adopt `deno fmt` with the settings below, collapse comment
banners to `//` lines, and include `tests/`.

## What the noise is, and where it came from

Most of the whitespace isn't C style. Blank lines after `{` and before `}`, and
`foo( a, b )` spacing, are mrdoob's three.js house style, inherited from
three-quake. The C-derived parts are the comment banners and the
`//` / `// Section` / `//` boxes.

Measured over `src/`, `main.js`, `tests/`, `server/` and `cloudflare/lobby/src/`
(141k lines, 38k of them blank):

| Pattern | Count | Handled by |
| --- | --- | --- |
| Blank line straight after `{` | 9,925 | `deno fmt` |
| Blank line straight before `}` | 9,986 | `deno fmt` |
| Lines with `( x )` paren padding | ~37,600 | `deno fmt` |
| Lines with `[ x ]` bracket padding | ~9,700 | `deno fmt` |
| `/*` / `=====` / Name / `=====` / `*/` banners in `src/` and `main.js` | 1,202 (756 with notes) | banner codemod |
| Empty `//` lines (mostly `//` / `// Section` / `//` boxes) | 434 | banner codemod |
| `if ( !x )` / `while ( !x )` falsy checks | 553 | not swept (tier 4) |
| Bare `let a, b;` hoisted to the top of a function, in `src/` | 162 | not swept (tier 4) |
| `for ( i = 0; …` on an outer variable, in `src/` | 42 | not swept (tier 4) |

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
    "**/*.html", "**/*.css", "**/*.svg", "**/*.md"
  ]
}
```

The pinned Deno (2.9.8) accepts every option. `server/deno.json` has no `fmt`
block, so the root settings apply under `server/` too (checked: formatting
`server/` with `--config deno.json` gives identical output). `**/*.md` comes
out of `exclude` in tier 3.

## Scope

- Formatted: `main.js`, `sw.js`, `src/`, `server/`, `tests/`, `cloudflare/`,
  `tools/` (JS and TS), and the JSON and JSONC files outside the excluded
  folders (`deno.json`, `server/deno.json`, both `wrangler.jsonc`).
- `server/` was going to keep its own formatting. A single formatter for the
  whole repository replaces that rule. Most of `server/` is tab-indented;
  only four `.ts` drivers use two spaces (`client_address.ts`,
  `net_websocket_server.ts`, `net_webtransport_server.ts`, `quic_listen.ts`).
  It is small, so it changes least (+4.3k / -3.3k lines).
- `tools/` has no tests and isn't linted or run in CI. For those files the AST
  check below is the only proof that nothing changed.
- Not formatted: `static/`, `tests/fixtures/`, `.claude/`, `.vscode/`, HTML,
  CSS and SVG (`index.html` and `tools/webrtc_spike/index.html` need a
  browser check, so they wait), and Markdown until tier 3.

## Trial results

Run on a copy of `dev` at b8f46e7 with the config above and the tier 0 test
fixes applied:

- `deno fmt` changed 304 files: +113k / -104k lines. By folder: `src/`
  +61.4k/-58.3k (89 files), `tests/` +44.1k/-39.3k (177 files), `server/`
  +4.3k/-3.3k, `tools/` +2.5k/-2.4k, `cloudflare/` +0.3k/-0.2k, `main.js`
  +0.3k/-0.3k. The only non-code files it touched were `server/deno.json` and
  the two `wrangler.jsonc` files.
- `deno task test`: 961 passed, 0 failed. `deno task lint` and
  `deno task check` pass. Running `deno fmt --check` straight after reports
  nothing, so the formatter is stable.
- Without the tier 0 fixes, two tests fail because they read source files as
  text and match the old layout:
  - `tests/pr_exec_ops_test.js` looks for `switch ( code[ o ] )` and parses
    case labels with `/^case (\d+): \{? ?\/\/ (OP_\w+)/`.
  - `tests/menu_advanced_test.js` collects cvar defaults with
    `new cvar_t\( '…', '…'` and `name: '…', string: '…'`.
  The fixed patterns find the same 199 cvar defaults in the old and the new
  layout. No other test reads `src/`, `server/` or `main.js` as text.
- `tools/port_inventory.py` isn't run in CI, but its JS regexes assume single
  quotes (`new cvar_t\(\s*'`, `Cmd_AddCommand\(\s*'`, `name:\s*'`). After the
  switch to double quotes it would find no cvars or commands and report them
  all as missing, with no error. With both quotes accepted, it finds the same
  119 cvars, 80 cvar objects and 153 commands before and after formatting.
- Table files grow a lot because each array entry gets its own line:
  `src/anorm_dots.js` (+4,112 lines), `src/progdefs.js` (+516) and
  `src/menu_cvars.js` (+334).
- The formatter leaves comments alone: banners survive as they are, just
  re-indented.
- Lines over 80 characters in `src/` drop from 2,108 (counting a tab as one)
  to 455. The rest are long strings and comments, which the formatter doesn't
  break.

## Tiers

Each tier is a separate PR. A sweep commit holds only the tool's output, and
any hand edits go in an earlier commit.

### Tier 0: preparation (no formatting)

Done on `refactor/fmt-prep`:

1. The two source-reading tests accept either layout: any spacing around
   `(`, `[` and `{`, and either quote. `menu_advanced_test.js` still finds
   the same 199 cvar defaults.
2. `tools/port_inventory.py`'s JS patterns accept either quote, including
   the `''` stub body and the `Cvar_VariableValue( '…' )` reads. Its output
   (both modes) is byte-identical on the current code and on a copy
   formatted with the settings above.
3. Six tables keep their rows under a `// deno-fmt-ignore` line:
   `r_avertexnormal_dots` (`src/anorm_dots.js`), `crctable`
   (`src/crc.js`), `turbsin` (`src/gl_warp.js`), `pop` (`src/common.js`),
   its test copy `popShorts` (`tests/sv_engine_fixes_test.js`) and
   `advancedPages` (`src/menu_cvars.js`). Without the markers they grow by
   4,112, 219, 204, 43, 23 and 344 lines. `src/progdefs.js` has no marker:
   it grows because one-line getters and setters get one statement per line,
   which is ordinary code formatting, and its `globalvars_t_fields` rows
   stay one per line anyway.
4. `tools/fmt_ast_check.js <base-ref> [<file>...]` compares each changed
   `.js`/`.ts` file's syntax tree with its version at `<base-ref>`, using
   `@babel/parser` 8.1.3 (pinned in `deno.lock`). It ignores
   positions, comments, raw text and redundant parentheses, and accepts:
   - a block holding one statement and that statement on its own
     (`useBraces`). That includes a lone `if`: the trees are already
     parsed, so an `else` belongs to the same `if` either way;
   - an empty statement dropped from a statement list;
   - a quoted and an unquoted property key with the same name
     (`quoteProps`);
   - a different order of the names inside one `import { … }` or
     `export { … }`.
   Anything else fails, including import declarations that moved: some
   modules are in import cycles where order matters (AGENTS.md "Engine
   gotchas"). On a copy of this branch formatted with the settings above,
   every changed file matches (302 files, about 4 seconds). After
   formatting, a changed number, a changed string or two swapped import
   declarations are each reported.

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
  - `.editorconfig`: `indent_style = space` and `indent_size = 2` under
    `[*]`, and remove the now-redundant
    `[server/{client_address,net_websocket_server,net_webtransport_server,quic_listen}.ts]`
    section.
  - `.vscode/settings.json`: `editor.insertSpaces: true`,
    `editor.tabSize: 2`, and optionally `editor.formatOnSave: true` with
    Deno as the formatter. The sandbox protects this file, so the maintainer
    makes this edit or it is made outside the sandbox.
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

### Tier 2: banners and comment boxes (comments only)

- Name-only banners become one line: `/*\n===\nSV_Init\n===\n*/` →
  `// SV_Init`. That keeps the AGENTS.md rule that a ported function's
  comment names its C function, and keeps the name greppable against the C
  source.
- Banners with notes (756) become `// SV_MarkDatagram` followed by the notes
  as `//` lines, word for word. Notes such as "Not in C" and deviation notes
  must survive unchanged.
- Section dividers (`/*\n=====\n\nEVENT MESSAGES\n\n=====\n*/`) become
  `// EVENT MESSAGES` with one blank line above.
- `//` / `// Movetype constants` / `//` boxes become `// Movetype constants`.
- Tool: a codemod script (`tools/collapse_banners.js`), run once, then
  `deno fmt`. Optionally add a lint plugin rule (`deno.json` `lint.plugins`)
  that rejects new `===` banners.
- Verify:
  - `tools/fmt_ast_check.js` passes (it ignores comments).
  - Every identifier on a banner's name line still appears in a comment in
    the same file.
  - `deno fmt --check` and `deno task ci` pass.
- AGENTS.md "Port fidelity": give the banner format.

### Tier 3: Markdown

`proseWrap: "always"` rewraps every Markdown file to 80 columns. A trial
without the exclusion changed +4.1k / -2.9k lines of Markdown. It goes in its
own docs PR because the status docs collect most merge conflicts (AGENTS.md
"Git workflow"). That PR removes `**/*.md` from `fmt.exclude`. Check that
the YAML front matter in `.claude/skills/*/SKILL.md` and `.claude/agents/*.md`
survives, or keep `.claude/` excluded.

### Tier 4: C idioms in code (not a sweep)

The 553 `!x` checks, 162 hoisted `let` declarations and 42 outer loop
variables change behaviour or mirror the C on purpose. `!x` is not
`x === null` when `x` can be `0`, `''` or `undefined`. Fix them file by file,
when a PR is already editing that file and its tests cover the change.

## Sequencing with open PRs

One PR is open: #216 (MCP SDK), which touches `server/agent_mcp.ts`,
`tests/agent_mcp_*.js`, `tests/agent_goto_test.js`, `deno.json`, `deno.lock`,
`server/deno.json` and docs.

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
   output and nothing else, and the branch is already formatted, so where
   both sides changed a hunk the branch's version is right.

   Tested on #215's head, against `dev` as it was before #215 merged: the
   tree this recipe produced was identical to the result of merging #215
   normally and then running `deno fmt`.
3. Do tier 2 straight after tier 1, with the same recipe using its codemod
   commit.

The SHAs of the sweep commits (tier 1 commit 2 and the tier 2 codemod commit)
go into `.git-blame-ignore-revs`. GitHub reads that file automatically;
locally, run `git config blame.ignoreRevsFile .git-blame-ignore-revs`. PRs
merge with merge commits, so the SHAs survive. List the sweep commits, not
the merge commits.

## Side effects to expect

- `src/x.js:123` line references in the snapshot docs (`docs/port-review.md`
  and others) go stale. They are snapshots, so leave them, or fix the ones
  still in use in the tier 3 docs PR.
- Reading the port side by side with the C changes: C uses tabs and
  `foo( a )` spacing. The `quake-c-reference` skill finds functions by name
  and compares behaviour, not layout, so its steps still apply.
- `.claude/hooks/lint-delta.sh` compares lint findings, not layout, so it is
  unaffected.
