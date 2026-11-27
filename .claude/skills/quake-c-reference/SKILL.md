---
name: quake-c-reference
description: Fetch id Software's original Quake C source and compare a ported function in src/ against it. Use when fixing a fidelity bug in vanilla-Quake code (id1, GLQuake, the NetQuake server, QW prediction), deciding whether such code is dead or unported, checking a cvar/command name against id's C, or reviewing a change to ported engine code. Other layers have other references (AGENTS.md, Compatibility and fidelity).
---

# Compare against the original C

The reference for vanilla Quake is
[id-Software/Quake](https://github.com/id-Software/Quake). Code for protocols
666/999, BSP2, fog and the like follows QuakeSpasm or Ironwail, the rerelease
follows Ironwail, and Icaro's own features have no reference: see AGENTS.md,
Compatibility and fidelity.
`docs/port-review.md` was written against commit `bf4ac42`.
- `WinQuake/` holds WinQuake (software) and GLQuake (`gl_*.c`). It is the
  reference for the vanilla parts of `src/`, including the server (`sv_*.c`,
  `pr_*.c`, `world.c`, `host*.c`).
- `QW/` holds QuakeWorld. It is the reference only for client prediction
  (`QW/client/pmove.c`, `pmovetst.c`, `cl_pred.c`) and delta packet entities.

## Get it

Reuse `/tmp/idquake` or clone it there:

```bash
[ -d /tmp/idquake/WinQuake ] || git clone --depth 1 https://github.com/id-Software/Quake.git /tmp/idquake
```

If you can't fetch it, say that your comparison is from memory and mark those
claims unverified.

## Compare

1. Find the JS function and its C counterpart. Names match, and the JS file's
   header names its C source:
   `rg -n "^\w.*\bSV_Physics_Toss\b" /tmp/idquake/WinQuake`.
2. Read both in full, including the C macros and globals the function uses
   (`quakedef.h`, `progs.h`, `server.h`, `glquake.h`).
3. Look for behavioural differences, not style differences. Common sources:
   - integer vs float arithmetic (C `int` truncation, `(int)` casts, `& 0xff`)
   - `qboolean`/pointer truthiness ported as falsy checks
   - a C global shared across files that became separate module copies in JS
   - code paths and cvars that were never ported
   - little-endian `short`/`long` reads in `MSG_*`
4. Decide:
   - **The port diverges from its layer's reference by mistake**: restore
     that behaviour, and add a test that fails without the fix.
   - **The C oddity is intentional or harmless**: keep it, with a comment
     citing the C (and `// deno-lint-ignore <rule>` if lint flags it).
   - **The divergence is deliberate** (web platform, Three.js, WebTransport):
     keep it, and comment why it differs.

Cite the C file and function in your notes or PR body (e.g.
`WinQuake/sv_phys.c SV_Physics_Toss`).
