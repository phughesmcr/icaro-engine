---
name: pr
description: Verify the current branch and open a pull request against dev. Covers the base check, tests, lint, signed commit, push, and gh pr create.
disable-model-invocation: true
argument-hint: "[optional PR title or notes]"
---

# Open a PR against `dev`

Notes from the user: $ARGUMENTS

Stop and report if any step fails. Never target `main`, and don't merge the PR
unless the user asks (see step 8).

1. **Base.** Run `git fetch origin dev` then
   `git merge-base --is-ancestor origin/dev HEAD`. If it fails, tell the user
   how far behind `dev` the branch is, and ask whether to merge `origin/dev`
   in. Don't rebase.
2. **Scope.** Run `git diff --stat origin/dev...HEAD` and `git status`.
   - Make sure nothing unrelated is in the diff: no registered paks, `*.pem`
     files, or `.claude/` scratch files.
   - If parallel sessions own other files, check that you only touched yours.
3. **CI checks.** Run `NO_COLOR=1 deno task ci` (`deno fmt --check`,
   `deno task test`, `deno task lint`, `deno task check`) and record the test
   pass count.
   - Run `deno fmt` first if formatting fails.
   - Keep C-parity parameters with a `_` prefix rather than deleting them.
4. **Commit.**
   - Use short imperative subjects: no prefix, no trailing period.
   - Commits are SSH-signed; never pass `-c commit.gpgsign=false`.
   - No attribution lines.
5. **Push.** Run `git push -u origin HEAD`.
6. **PR.** Write the body to a uniquely named file in `$TMPDIR` and run
   `gh pr create --base dev --title "<title>" --body-file <file>`. The body
   covers:
   - **Why**: the problem and the reference behaviour being restored, citing
     the reference's file and function where relevant (id's C, QuakeSpasm or
     Ironwail; none for Icaro's own features).
   - **Changes**: each finding as fixed or not fixed, with the reason.
   - **Verification**: test pass count, lint/check result, and any browser or
     manual checks.
   - **Not verified**: browser rendering, real phone/headset, live QUIC,
     registered/mission-pack data, whichever apply.
   - **Left out**: work that needs files you don't own, and follow-ups.
7. Report the PR URL, then stop. Merge only if the user asks in chat and CI has
   passed: `gh pr merge <n> --merge`. Never squash, rebase or enable
   auto-merge.
