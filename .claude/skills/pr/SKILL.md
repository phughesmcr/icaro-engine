---
name: pr
description: Verify the current branch and open a pull request against dev. Covers the base check, tests, lint, review agents, signed commit, push, and gh pr create.
disable-model-invocation: true
argument-hint: "[optional PR title or notes]"
---

# Open a PR against `dev`

Notes from the user: $ARGUMENTS

Stop and report if any step fails. Never merge the PR, and never target `main`.

1. **Base.** `git fetch origin dev` (outside the sandbox). Then
   `git merge-base --is-ancestor origin/dev HEAD`. If it fails, tell the user
   how far behind `dev` the branch is, and ask whether to merge `origin/dev`
   in. Don't rebase.
2. **Scope.** Run `git diff --stat origin/dev...HEAD` and `git status`.
   - Make sure nothing unrelated is in the diff: no registered paks, `*.pem`
     files, or `.claude/` scratch files.
   - If parallel sessions own other files, check that you only touched yours.
3. **Tests.** Run `NO_COLOR=1 deno task test` and record the pass count.
4. **Type check.** Run `deno task check`. It covers the client and server
   entry points and the TypeScript tests.
5. **Lint.** Run `deno task lint`. It must pass with zero problems; CI runs
   the same command.
   - Keep C-parity parameters with a `_` prefix rather than deleting them.
   - Don't run `deno fmt` (only `--check`).
6. **Review.**
   - Run the `reviewer` agent on the whole diff. It and `docs-checker` are
     user-level agents; if they aren't installed, do the review yourself.
   - Run `docs-checker` too if commands, config, docs or exported APIs changed.
   - Fix what they report, or note why you didn't. If the fixes are big, rerun
     steps 3–5.
7. **Commit.**
   - Use short imperative subjects: no prefix, no trailing period.
   - Run `git commit` outside the sandbox, because it is SSH-signed.
   - Never pass `-c commit.gpgsign=false`.
   - No attribution lines.
8. **Push.** Run `git push -u origin HEAD` outside the sandbox.
9. **PR.** Write the body to a uniquely named file, using the same
   unsandboxed call that runs
   `gh pr create --base dev --title "<title>" --body-file <file>`. The body
   covers:
   - **Why**: the problem and the C behaviour being restored, citing the C
     file and function where relevant.
   - **Changes**: each finding as fixed or not fixed, with the reason.
   - **Verification**: the test count before and after, the lint result, and
     any browser or manual checks.
   - **Not verified**: browser rendering, real phone/headset, live QUIC,
     registered/mission-pack data, whichever apply.
   - **Left out**: work that needs files you don't own, and follow-ups.
10. Report the PR URL. Leave merging to the maintainer, who uses merge commits.
