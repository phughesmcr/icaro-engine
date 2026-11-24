---
name: quake-c-reference
description: Fetch id Software's original Quake C source and compare a ported function in src/ against it. Use when fixing a port-fidelity bug, deciding whether code is dead or unported, checking a cvar/command name, or reviewing a change to ported engine code.
---

# Compare against the original C

The reference is [id-Software/Quake](https://github.com/id-Software/Quake).
`docs/port-review.md` was written against commit `bf4ac42`.
- `WinQuake/` holds WinQuake (software) and GLQuake (`gl_*.c`). It is the
  reference for `src/` in general, including the server (`sv_*.c`, `pr_*.c`,
  `world.c`, `host*.c`).
- `QW/` holds QuakeWorld. It is the reference only for client prediction
  (`QW/client/pmove.c`, `pmovetst.c`, `cl_pred.c`) and delta packet entities.

## Get it

Reuse an existing checkout if one is already in `$TMPDIR`:

```bash
ls -d "$TMPDIR"/idquake/WinQuake 2>/dev/null || git clone --depth 1 https://github.com/id-Software/Quake.git "$TMPDIR/idquake"
```

The clone needs network access to github.com. If the sandbox blocks it, rerun
it outside the sandbox. If you can't fetch it at all, say that your comparison
is from memory and mark those claims unverified.

## Compare

1. Find the JS function and its C counterpart. Names match, and the JS file's
   header names its C source:
   `rg -n "^\w.*\bSV_Physics_Toss\b" "$TMPDIR/idquake/WinQuake"`.
2. Read both in full, including the C macros and globals the function uses
   (`quakedef.h`, `progs.h`, `server.h`, `glquake.h`).
3. Look for behavioural differences, not style differences. Common sources:
   - integer vs float arithmetic (C `int` truncation, `(int)` casts, `& 0xff`)
   - `qboolean`/pointer truthiness ported as falsy checks
   - a C global shared across files that became separate module copies in JS
   - code paths and cvars that were never ported
   - little-endian `short`/`long` reads in `MSG_*`
4. Decide:
   - **The port diverges by mistake**: restore the C behaviour, and add a
     test that fails without the fix.
   - **The C oddity is intentional or harmless**: keep it, with a comment
     citing the C (and `// deno-lint-ignore <rule>` if lint flags it).
   - **The divergence is deliberate** (web platform, Three.js, WebTransport):
     keep it, and comment why it differs.

Cite the C file and function in your notes or PR body (e.g.
`WinQuake/sv_phys.c SV_Physics_Toss`).
