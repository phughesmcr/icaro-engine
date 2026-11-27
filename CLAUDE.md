# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with
code in this repository.

@AGENTS.md

## Claude Code notes

- Set `NO_COLOR=1` on `deno` commands whose output you parse.
- Use unique names in `$TMPDIR` (other sessions share it).
- Inside a worktree, use `Read`, `Edit`, `Write`, `Grep`, and simple
  single-command `Bash` calls — avoid Bash heredocs or `git -C` loops that trip
  worktree isolation checks.
- Do not add hooks, CI gates, allowlists/denylists, security headers, wrapper
  scripts, or new agent/skill files unless explicitly asked.
- If a tool call is blocked by a permission classifier, `no verdict`, or site
  permissions, stop retrying that tool immediately and report the block once.
- Use the `quake-c-reference` skill when a change to vanilla-Quake code needs
  the original C source.
