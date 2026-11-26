# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## Claude Code notes

- Signed `git commit`, `git push`, `git fetch` and `gh` fail inside the
  sandbox (no SSH-agent socket, GitHub blocked). Run them outside it from the
  start; don't wait for a failure.
- `$TMPDIR` differs inside and outside the sandbox, and other sessions share
  it. Give temp files unique names (e.g. a PR body file). Write a file that an
  unsandboxed command will read with that same unsandboxed call, or pass its
  absolute path.
- zsh process substitution (`diff <(...) <(...)`) fails in the sandbox. Use
  temp files.
- Set `NO_COLOR=1` on `deno` commands whose output you parse.
- A PostToolUse hook reports new `deno lint` problems in each `.js`/`.ts` file
  you edit, compared with `HEAD`. Fix them, or justify them as C-parity
  leftovers. It skips the folders `deno task lint` doesn't cover (`tools/`,
  `docs/`, `static/`).
- A PreToolUse hook (`.claude/hooks/wrangler-guard.sh`) blocks a wrangler
  deploy, publish or upload from a folder with no Wrangler config, such as
  the repository root. `cd cloudflare/lobby` first, or pass `--config`.
- Before opening a PR, run the `reviewer` agent on the whole diff. Run
  `docs-checker` too when commands, config or docs changed. Both are defined
  in `.claude/agents/`. `/pr` runs the whole checklist.
- Use the `quake-c-reference` skill when a change needs the original C source.
