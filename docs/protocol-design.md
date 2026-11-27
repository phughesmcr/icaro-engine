# Icaro protocol design

Status: migration steps 1 to 3 are built (PRs #274, #278 and #288); steps 4 to 6
are design only. Icaro citations are `file:line` on `dev` at `bbcb183`
(2026-11-26), before step 1, so "Where Icaro is now" describes that commit.

Reference sources were read at pinned commits. Their citations are
`repo/path:line` at these commits:

| Short name | Repository                    | Commit                                     |
| ---------- | ----------------------------- | ------------------------------------------ |
| `fteqw`    | `fte-team/fteqw`              | `f09ac7cccd2d713ddf881d3f1324703082c2cfe4` |
| `qss`      | `Shpoike/Quakespasm`          | `4c0c55f7830715cf8670f586c7be01ebce262d23` |
| `ironwail` | `andrei-drexler/ironwail`     | `3fa96fe3a2119b17c7be4f7b747ea3e7c3c455aa` |
| `dp`       | `DarkPlacesEngine/DarkPlaces` | `6d754e4372fea51fd97689231ecd2ebcbb4c9ad7` |

The protocol strategy comes from the November audit (PR #251,
`docs/audit/compat-standard.md` on `agent/audit`), and the engine's direction
from PR #245 (`docs/vision.md` on `agent/vision-rules`). Neither is on `dev`
yet.

## Already decided

- Keep `PROTOCOL_ICARO` (1015, `src/protocol.js:26`) as the base.
- Add a capability word to the server hello.
- Move Icaro's private svcs into a reserved range. Today `svc_playerinfo` 42 is
  Fitz `svc_spawnbaseline2`, and 47 to 49 are KEX `svc_updatesocial`,
  `svc_updateplinfo` and `svc_rawprint` (`ironwail/Quake/protocol.h:205`,
  `:215-217`).
- The client dispatches per protocol, with readers for NetQuake 15, FitzQuake
  666 and RMQ 999 for other engines' demos. Servers never send 666 or 999.
- Only Icaro clients and servers talk to each other.

New requirement: the protocol must leave room for games that are not Quake, such
as Hexen II and custom Icaro games.

## Summary of the design

- The svc byte space splits into two layers.
  - **Game layer, 0 to 95.** Numbers and payloads belong to the game, because
    QuakeC writes them as raw bytes. Each game profile (Quake, later Hexen II)
    has its own table here, and a table may override a shared number.
  - **Engine layer, 96 to 127.** These are Icaro's own messages, the same for
    every game. 127 is a length-prefixed escape for optional extensions.
  - **128 to 255** keep the NetQuake fast-update meaning in the 15, 666 and 999
    readers. Icaro's server never sends them.
- The hello is `svc_serverinfo` with `1015`, then a `0` byte where 1015 used to
  put `maxclients`. Then come a revision number, a game profile id, and two
  capability sets: required and optional. An old client reads the 0 as
  `maxclients` and stops with "Bad maxclients (0)". A new client can tell a
  legacy 1015 stream from a versioned one by the same byte.
- The capabilities are the server's statement about its stream. The client
  doesn't reply. Signon buffers are shared by all clients and recorded in demos,
  so features that shape them can't differ per client, and demos replay what the
  server declared. A client reply is left as an open question.
- Required capabilities may change layouts. A client that lacks one refuses to
  connect and names it. Optional capabilities only add escape messages, which a
  client skips by length.
- Entities, players and baselines get extension room. `PE_*` bit 15 and `PF_*`
  bit 15 become extend bits. Baselines move to a delta-from-null encoding, as
  FTE's `svcfte_spawnbaseline2` does, so new entity fields get baselines for
  free.
- The client parser becomes a table per (protocol, revision, game profile). 15,
  666 and 999 are tables for other engines' demos. 1015 has one table per
  revision.

## Where Icaro is now

- **Hello.** `SV_SendServerinfo` writes `svc_serverinfo`, then `PROTOCOL_ICARO`,
  then `maxclients`, the game type, the level name, the model list and the sound
  list (`src/sv_main.js:570-602`). Nothing describes the features in use.
- **Client check.** `CL_ParseServerInfo` accepts 15 or 1015 and errors otherwise
  (`src/cl_parse.js:461-468`). It then switches coordinate width with
  `MSG_SetCoord32` (`src/cl_parse.js:469`, `src/common.js:492-502`). Any
  `maxclients` below 1 is a `Host_Error` (`src/cl_parse.js:473-474`).
  `svc_version` repeats the check mid-stream (`src/cl_parse.js:1560-1571`).
- **Dispatch.** One `switch (cmd)` covers both protocols
  (`src/cl_parse.js:1541-1790`), with `cl.protocol === PROTOCOL_ICARO` tests
  inside the shared parsers (for example `src/cl_parse.js:1106`, `:1199-1200`,
  `:1453-1454`). A command byte with the high bit set is a NetQuake fast update
  (`src/cl_parse.js:1527-1533`).
- **Private numbers.** `svc_playerinfo` 42 (`src/protocol.js:162`),
  `svc_packetentities` 47, `svc_deltapacketentities` 48 and `svc_serversequence`
  49 (`src/protocol.js:208-210`). There is also `clc_delta` 5
  (`src/protocol.js:212`, repeated in `src/sv_user.js:105`).
- **KEX numbers already used.** `svc_achievement` 52 and `svc_localsound` 56
  (`src/protocol.js:132`, `:135`) match Ironwail
  (`ironwail/Quake/protocol.h:221`, `:225`).
- **Extension room is nearly gone.**
  - Packet entities use a byte of `PE_*` bits, then a second byte when
    `PE_MOREBITS` is set. Bits 8 to 14 are taken, so only bit 15 is free
    (`src/protocol.js:220-244`, writer `src/sv_main.js:1034-1036`).
  - `svc_playerinfo` sends its `PF_*` flags as a short
    (`src/sv_main.js:1796-1798`). Bits 0 to 14 are taken, so only bit 15 is free
    (`src/protocol.js:167-186`).
  - `svc_spawnbaseline` has a fixed layout: short entity, short model, short
    frame, colormap, skin, coords and angles, and alpha
    (`src/sv_main.js:2216-2231`). A new entity field can't get a baseline
    without a new layout.
- **The server never sends fast updates.** No `src/sv_*.js` file writes
  `U_SIGNAL` or a command byte with the high bit set. The client's fast-update
  path is reached only by protocol 15 demos.
- **Transports.** WebTransport, WebSocket and WebRTC open with an `"ICARO"`
  hello carrying `WT_PROTOCOL_VERSION` 1 (`src/net.js:258-271`). On a version
  mismatch the host rejects the client with "Protocol version N not supported
  (server uses M)" before any game data (`src/net_webrtc.js:626-638`; the
  WebSocket and WebTransport servers do the same). `NET_PROTOCOL_VERSION` and
  `CCREQ_CONNECT` (`src/net.js:23`, `:26`) are defined but nothing uses them.
  Loopback games and demos have no transport hello at all.
- **Demos.** Recording must start before connecting (`src/cl_demo.js:297-302`),
  so a demo always starts with `svc_serverinfo`. Demos from builds before 1015
  stopped playing when 1015 arrived (`src/protocol.js:24-25`).

## What other engines do

### FTEQW: extension words

- **Two 32-bit words.** `PEXT_*` (`fteqw/engine/common/protocol.h:24-58`) and
  `PEXT2_*` (`:80-90`). The second word exists because the first filled up:
  `PEXT_HEXEN2` is bit 21 and `PEXT_DPFLAGS` is bit 31 (`:48`, `:58`). Each word
  is tagged with a four-character marker, `"FTEX"` or `"FTE2"`, and there is a
  variable-length block form, `"vlen"` (`:139-142`).
- **QuakeWorld negotiation.**
  - The server lists its masks after the challenge
    (`fteqw/engine/server/sv_main.c:1759-1783`).
  - The client ANDs them with what it supports
    (`fteqw/engine/client/cl_main.c:718-728`) and sends the result in its
    `connect` string (`:887-893`).
  - The server ANDs again (`fteqw/engine/server/sv_main.c:2185-2188`). It then
    repeats the final set in `svc_serverdata`, before the protocol long
    (`fteqw/engine/server/sv_user.c:368-383`), so demos carry it.
- **NetQuake negotiation.** NetQuake's connect packet has no room for this.
  - The server stuffs `cmd protocols` and `cmd pext`
    (`fteqw/engine/server/sv_user.c:577-590`).
  - The client answers with `pext <marker> <mask> ...` as a string command
    (`fteqw/engine/common/cmd.c:2830-2843`).
  - The server writes the agreed words before the protocol number
    (`fteqw/engine/server/sv_user.c:822-831`).
  - For NetQuake clients the server drops the `PEXT1` bits that depend on QW's
    entity deltas (`fteqw/engine/common/net_chan.c:112` onward).
- **One flat svc space.**
  - FTE names messages by family: `svcnq_`, `svcqw_`, `svcfitz_`, `svcdp_`,
    `svcfte_` and `svcqex_` (`fteqw/engine/common/protocol.h:228-414`).
  - The same number means different things in different families: 37 to 44 (Fitz
    or QW), 46 to 58 (KEX or QW, `:387-399`) and 50 to 62 (DP or FTE-QW).
  - It copes with two parsers, `CLQW_ParseServerMessage` and
    `CLNQ_ParseServerMessage` (`fteqw/engine/client/cl_parse.c:7616`, `:9381`).
    Inside the NetQuake one, `cls.qex` reinterprets 52 as `svcqex_achievement`
    (`:9956-9957`).
  - FTE's own numbers run to `svcfte_spawnstaticsound2` 94, commented "_sigh_"
    (`fteqw/engine/common/protocol.h:369`).
- **Length framing came late.** `svcfte_cgamepacket_sized` 90 and
  `svcfte_temp_entity_sized` 91 are copies of older messages "with an extra
  short size right after the svc" (`fteqw/engine/common/protocol.h:365-367`).
- **`PEXT2_REPLACEMENTDELTAS`** (`fteqw/engine/common/protocol.h:83`).
  - It carries entities as `svcfte_updateentities` 86, using `UF_*` bits
    (`fteqw/engine/common/protocol.h:763-799`).
  - The bits cascade a byte at a time: `UF_EXTEND1` (bit 7), `UF_EXTEND2` (15),
    `UF_EXTEND3` (23). The writer sets each one when a later byte has bits
    (`fteqw/engine/server/sv_ents.c:1141-1145`).
  - The reader has no way to skip an unknown bit. `UF_EXTEND4` ends the game
    (`fteqw/engine/client/cl_ents.c:630-636`).
  - Baselines use the same delta encoding, from a null state
    (`SVFTE_EmitBaseline`, `fteqw/engine/server/sv_ents.c:1453`;
    `CLFTE_ParseBaseline`, `fteqw/engine/client/cl_ents.c:1020`).
  - Entity numbers are a short with remove in bit 15. Bit 14 adds a byte, for 22
    bits in all (`SV_EmitDeltaEntIndex`, `fteqw/engine/server/sv_ents.c:279`).
- **Cautionary cases.**
  - `PEXT2_LERPTIME` redefines an existing bit, `UF_16BIT`
    (`fteqw/engine/common/protocol.h:90`).
  - `PEXT2_DEPRECATEDORNEW` names outdated bits (`:93`). Nothing else in the
    files read refers to it.

### FTEQW: Hexen II

FTE's Hexen II support is the main precedent for a game that isn't Quake. Its
NetQuake-protocol reader is for demos only, and its own comments say it is
incomplete.

- **Two paths.**
  - NetQuake-style Hexen II is protocol 19 (`fteqw/engine/common/net.h:405`).
    The client accepts it only when playing a demo. Live, it says "Unable to
    connect to standard Hexen2 servers"
    (`fteqw/engine/client/cl_parse.c:3976-3981`).
  - Live Hexen II runs over QuakeWorld plus `PEXT_HEXEN2`, because H2 "doesn't
    really match either protocol" (`fteqw/engine/client/cl_main.c:1212`).
- **H2 svc numbers.**
  - FTE defines them locally in the client, 34 to 53: `svch2_particle2` 34
    through `svch2_soundpos` 53 (`fteqw/engine/client/cl_parse.c:9089-9110`).
  - They overlap Fitz 37 and 40 to 44, KEX 38 and 45 to 53, DP 50 to 53 and QW
    35 to 53. They also overlap Icaro's 42 and 47 to 49.
  - The demo reader runs an H2 pre-pass, `CLH2_ParseServerSubMessage`
    (`fteqw/engine/client/cl_parse.c:9111`). It falls back to the NetQuake
    switch for anything the pre-pass doesn't take (`:9424-9431`).
  - Several H2 messages end the game as "Unimplemented" (`:9368-9371`).
- **Shared numbers with different payloads.** In FTE's server-side translator,
  H2's `svc_intermission` carries one more byte than Quake's
  (`fteqw/engine/server/net_preparse.c:1127-1131`).
- **Translate on the server.**
  - For live games, `net_preparse.c` parses what H2 QuakeC writes and rewrites
    it for each client's protocol. It swallows `svch2_setviewflags` and
    `svch2_setviewtint`, and turns `svch2_setangles_lerp` into `svc_setangle`
    (`fteqw/engine/server/net_preparse.c:1153-1170`).
  - The game is chosen by `progstype == PROG_H2`
    (`fteqw/engine/server/progs.h:57`).
- **Player class.**
  - `svch2_updateclass` is `[player][byte class]`. FTE's client stores it as the
    player's `cl_playerclass` userinfo
    (`fteqw/engine/client/cl_parse.c:9262-9267`).
  - The server patches the class digit into the model name of
    `FL_CLASS_DEPENDENT` entities. The client only sees a model index
    (`fteqw/engine/server/sv_ents.c:3630-3640`).
- **Entity fields.**
  - `entity_state_t` holds `scale`, `hexen2flags` (drawflags) and `abslight`
    (`fteqw/engine/common/protocol.h:1281-1285`). Drawflags pack a light mode
    and scale type (`:1887` onward).
  - Over QW they are `U_DRAWFLAGS` and `U_ABSLIGHT`, read only when
    `PEXT_HEXEN2` was agreed (`fteqw/engine/common/protocol.h:745-746`,
    `fteqw/engine/client/cl_ents.c:543-545`).
  - The H2 demo path has its own `UH2_*` update bits, `UH2_MOREBITS` through
    `UH2_COLORMAP` at bit 19 (`fteqw/engine/client/cl_ents.c:1855-1876`).
  - H2 baselines force short models
    (`fteqw/engine/client/cl_parse.c:5044-5045`).
- **Stats.**
  - Hexen II stats start at 32: `STAT_H2_LEVEL` through `STAT_H2_OBJECTIVE2`,
    including string stats such as `STAT_H2_PUZZLE8`
    (`fteqw/engine/common/bothdefs.h:991-1048`).
  - `MAX_CL_STATS` is 256 (`:1088`). The server sends more than 32 stats only to
    clients with `PEXT_HEXEN2`, `PEXT_CSQC` or DP6/DP7
    (`fteqw/engine/server/sv_send.c:2323-2326`).
  - The H2 demo path reads inventory from `svch2_updateinv`
    (`fteqw/engine/client/cl_parse.c:9268` onward).
- **Temp entities.** All games share one TE enum, with H2 at 24 to 33
  (`fteqw/engine/common/protocol.h:1110-1120`).

### Quakespasm-Spiked

- **FTE extensions over NetQuake.**
  - The server stuffs `cmd pext` (`qss/Quake/sv_main.c:1915-1920`).
  - The client answers with `pext <marker> <mask> ...`
    (`qss/Quake/cmd.c:965-972`), and with `protocols ...` when asked
    (`:959-964`).
  - The server writes each agreed word as a marker and a mask, before the base
    protocol number (`qss/Quake/sv_main.c:2042-2052`).
  - This costs one round trip before `svc_serverinfo`.
- **Gated parsing.** Each FTE or DP case checks the protocol or the agreed
  `PEXT2` bits, and errors with "extension not active" when they aren't set (for
  example `qss/Quake/cl_parse.c:2792`, `:2839-2851`).
- **Collisions by protocol test.** Case 52 is `svcdp_effect` under DP7 and
  `svc_achievement` otherwise (`qss/Quake/cl_parse.c:2826-2835`).

### DarkPlaces

- **A new protocol number per revision.** DP1 to DP8 are 96, 97 and 3500 to 3505
  (`dp/protocol.c:48-66`). The enum is "purely for internal use, never sent in
  network protocol" (`dp/common.h:129`).
- **An svc range of its own.** "LadyHavoc: my svc_ range, 50-69"
  (`dp/protocol.h:268`). DP uses 50 to 62 (`:269-282`).
- **Entity bits cascade like FTE's.** `E5_EXTEND1` to `E5_EXTEND3` chain the
  bytes (`dp/protocol.h:742-823`, reader `dp/cl_ents5.c:9-18`). `E5_EXTEND4` is
  never read. As in FTE, unknown bits can't be skipped.
- **QuakeC stats.** QuakeC can add stats from 32 to 219; above that are engine
  movevars (`dp/qstats.h:28-29`).
- **No Hexen II.** `dp/prvm_edict.c:2522` says the Hexen II progs format is not
  supported.

### Ironwail and KEX

- **The numbers.**
  - 15, 666 and 999 (`ironwail/Quake/protocol.h:28-30`).
  - 999 adds a `PRFL_*` long after the protocol number, for angle and coordinate
    widths (`ironwail/Quake/protocol.h:33-40`,
    `ironwail/Quake/cl_parse.c:315-326`).
  - `PRFL_MOREFLAGS` (bit 31) is marked "not supported"
    (`ironwail/Quake/protocol.h:40`), so the RMQ word can't grow.
- **Collision.** The rerelease's numbers (38 and 45 to 56,
  `ironwail/Quake/protocol.h:211-225`) sit on DP's at 50 to 56. Ironwail notes
  that "svc_achievement has same value as svcdp_effect!"
  (`ironwail/Quake/protocol.h:220`).
- **Rerelease messages.** Ironwail parses only `svc_achievement` and
  `svc_localsound`. The other rerelease numbers fall to "Illegible server
  message" (`ironwail/Quake/cl_parse.c:1124-1128`).

### Lessons for Icaro

1. **Game code owns low numbers.** QuakeC writes svc bytes by hand, so a game's
   own numbers can't move. Hexen II and Quake disagree from 34 up. A non-Quake
   game needs its own table, not just extra entries.
2. **Low numbers are crowded.** NetQuake, QW, Fitz, KEX and DP between them use
   most numbers up to 62, and FTE's own run to 94. No engine read uses 95 to
   127, the space left below the fast-update bit.
3. **The agreed set must be in the server's stream.** FTE and QSS both write it
   before the protocol long. Otherwise demos can't be replayed.
4. **Words fill up.** FTE needed a second word. RMQ's `MOREFLAGS` was never
   supported. Plan a count, not a fixed word.
5. **Bits without lengths can't be skipped.** FTE and DP readers die on an
   unknown entity bit. FTE had to add `_sized` copies of messages later. Put
   lengths on anything optional from the start.
6. **Server-side translation works but costs a second parser.** FTE's
   `net_preparse.c` keeps one wire format for every game. Icaro passes QuakeC
   writes straight through today, so per-game tables fit it better.

## Design

### Two layers

| Layer  | svc range | Who writes it                    | Who defines it      |
| ------ | --------- | -------------------------------- | ------------------- |
| Game   | 0 to 95   | QuakeC by hand, and the engine   | The game profile    |
| Engine | 96 to 127 | The engine only                  | This document       |
| (none) | 128-255   | Fast updates in 15/666/999 demos | NetQuake, read-only |

- **Game layer.** Numbers and payloads follow the game. In the Quake profile
  they follow NetQuake, plus the KEX numbers that Icaro reads today (52, 56) and
  the Fitz numbers that migration step 2 adds (37, 40, 41). Icaro's wider fields
  still apply, as today: coordinates, model indexes and sound indexes.
  - A profile may give a shared number a different payload, as H2 does for
    `svc_intermission`.
  - The engine writes some game-layer messages itself: `svc_serverinfo`,
    `svc_clientdata`, `svc_sound`, `svc_temp_entity` relays. Their layout is
    part of the profile and the revision.
- **Engine layer.** Opcodes 96 to 126 are defined by a revision or by a required
  capability. A client must know every one it can receive, so they carry no
  length. 127 is the escape for everything optional.
- **128 to 255.** Under 1015 these stay unassigned. The 15, 666 and 999 readers
  keep the fast-update meaning. Reclaiming them is an open question.

Clients send far less, and only Icaro servers read it, so the same split applies
to `clc`: 0 to 4 stay NetQuake's, and Icaro's own move to 96 to 127. `clc_delta`
5 doesn't collide with anything (it is QW's `clc_delta` in
`fteqw/engine/common/protocol.h:565`). It moves anyway so one rule covers both
directions.

### Number mapping

| Message                   | 1015 today | Versioned 1015 | Note                                  |
| ------------------------- | ---------- | -------------- | ------------------------------------- |
| `svc_playerinfo`          | 42         | 96             | 42 is Fitz `svc_spawnbaseline2`       |
| `svc_packetentities`      | 47         | 97             | 47 is KEX `svc_updatesocial`          |
| `svc_deltapacketentities` | 48         | 98             | 48 is KEX `svc_updateplinfo`          |
| `svc_serversequence`      | 49         | 99             | 49 is KEX `svc_rawprint`              |
| `svc_icaro_baseline`      | (new)      | 100            | Delta-from-null baseline, revision 2  |
| `svc_icaro_static`        | (new)      | 101            | Delta-from-null static, revision 2    |
| (reserved)                |            | 102 to 126     | Allocated here, one row per message   |
| `svc_icaro_ext`           | (new)      | 127            | Length-prefixed escape                |
| `svc_achievement`         | 52         | 52             | Quake profile, KEX number             |
| `svc_localsound`          | 56         | 56             | Quake profile, KEX number             |
| `clc_delta`               | 5          | 96             | `clc` 96 to 127 are Icaro's           |
| `clc_icaro_ext`           | (new)      | 127            | Client escape, same layout as the svc |

The renumbered messages keep their payloads. Only the opcode changes.

### The hello

`svc_serverinfo` (11), under the versioned protocol:

```
byte    11            svc_serverinfo
long    1015          PROTOCOL_ICARO
byte    0             hello marker (legacy 1015 sent maxclients >= 1 here)
short   revision      Icaro wire revision, 1 for the first versioned hello
string  game          game profile id: "quake"; later "hexen2"
byte    nreq          number of required capability words
long    req[nreq]     required capabilities in use, word 0 first
byte    nopt          number of optional capability words
long    opt[nopt]     optional capabilities in use
byte    maxclients    from here on, the body as in 1015 today
byte    gametype
string  levelname
string  models[]...   then a 0 byte
string  sounds[]...   then a 0 byte
```

- **Old clients.** They read the 0 as `maxclients` and stop with "Bad maxclients
  (0) from server" (`src/cl_parse.js:473-474`). That is a clean failure, not a
  misparse. Over the network they never get that far, because
  `WT_PROTOCOL_VERSION` is bumped in the same change (see Transports).
- **Legacy demos.** A new reader sees a byte of 1 or more after `1015` and knows
  the stream is pre-revision 1015 ("revision 0"). It can play it with the
  revision 0 table, or refuse. Which one is an open question.
- **Game id.** The id names the message set, not the game directory. `rogue`,
  `hipnotic`, `mg1` and the other mods all use `"quake"`. A profile id is never
  reused for a different set.
- **Capabilities describe the stream.** The words say which features this stream
  uses. They don't list everything the server could do.

### Capabilities

- **Required.** A required capability may change the layout of an existing
  message, add entity, player or clientdata bits, or enable an engine opcode in
  96 to 126. If any required bit is unknown to the client, it refuses with a
  message that names the bits, for example "Server uses Icaro features this
  client lacks (required 0:0x00000004). Update the client."
- **Optional.** An optional capability may only add `svc_icaro_ext` messages. A
  client that doesn't know the bit skips them by length.
- **Two bit spaces.** Required and optional capabilities are numbered
  separately. A capability is one or the other, for good.
- **Revision 1 has today's features**, on the new numbers. It includes 32-bit
  coordinates, short model and sound indexes, packet entities, `svc_playerinfo`,
  the SU and SND extension bits, and entity alpha. These are not capabilities.
  The server has no path without them, so a bit for them could only ever be set.
  The audit suggested turning today's features into bits; this design keeps bits
  for features the server can turn off.
- **No per-client tailoring.** The hello itself goes to each client's own
  message buffer (`src/sv_main.js:570-576`), but the signon buffers that follow
  it are built once per map and shared by every client
  (`src/sv_main.js:2164-2172`, sent at `:810-829`). A capability that changes
  how signon messages are laid out therefore has to be the same for every
  client, so the stream's capabilities are per server, not per client.

Proposed first allocations (to be confirmed in the PRs that add them):

| Space    | Bit | Name                 | Meaning                                          |
| -------- | --- | -------------------- | ------------------------------------------------ |
| required | 0   | `ICAP_ENTITY_EXTRAS` | `PE_EXTEND2` / `PF_EXTEND` byte: scale, colormod |
| required | 1   | `ICAP_GAME_FIELDS`   | Profile-defined entity and player bits in use    |
| optional | 0   | (none yet)           | First optional extension, e.g. voice or hints    |

### The escape message

```
byte    127           svc_icaro_ext (or clc_icaro_ext)
short   id            extension id
short   length        bytes of payload that follow
byte    payload[length]
```

- Ids from `0x0000` to `0x7fff` are engine extensions, allocated in this
  document. Ids from `0x8000` to `0xffff` belong to the game profile named in
  the hello.
- A client that doesn't know the id, or whose optional capability isn't set,
  skips `length` bytes. A known id whose payload is shorter than `length` skips
  the rest, so an extension can grow at its end without a new id.
- Escape messages may go in signon buffers. A client that doesn't know them
  skips them, so the shared buffers stay valid for every client.
- The length is a short, like FTE's `_sized` messages
  (`fteqw/engine/common/protocol.h:365-367`). A message can't exceed
  `NET_MAXMESSAGE` anyway.

### Entity, player and baseline extension room

- **Packet entities.** Bit 15 of the second byte becomes `PE_EXTEND2`, so a
  third byte follows.
  - Bits 16 to 22 are engine fields: scale and colormod first (Ironwail's
    `U_SCALE`, `ironwail/Quake/protocol.h:66`).
  - Bit 23 is `PE_EXTEND3`, so a fourth byte follows.
  - Bits 24 to 30 are game-profile fields. Bit 31 must be 0, so a reader can
    fail clearly instead of misparsing.
  - Like FTE's `UF_*`, each byte is written only when it or a later byte has
    bits set.
- **Player info.** `PF_*` bit 15 becomes `PF_EXTEND`, so a byte of `PF_*` bits
  16 to 23 follows. Bits 16 to 19 are engine fields (the player's scale and
  colormod), 20 to 22 are game-profile fields, and bit 23 is `PF_EXTEND2`, kept
  for a further byte so this word doesn't fill up like RMQ's.
- **Client data.** Icaro sends only `SU_EXTEND1`, `SU_EXTEND2`,
  `SU_WEAPONFRAME2` and `SU_WEAPONALPHA` of Ironwail's set
  (`src/protocol.js:62-68`). Bit 31 is Ironwail's `SU_EXTEND3`. `svc_clientdata`
  is a game-layer message, so a profile that needs a different layout defines
  its own (see Hexen II).
- **Baselines (revision 2).** `svc_icaro_baseline` (100) and `svc_icaro_static`
  (101) send an entity as a packet-entity delta from a null state, the way
  `SVFTE_EmitBaseline` does (`fteqw/engine/server/sv_ents.c:1453`). Every field
  added to `PE_*` then has a baseline without a new message. Under 1015 the
  server stops sending `svc_spawnbaseline` (22) and `svc_spawnstatic` (20). The
  15, 666 and 999 readers keep them.

Bits on these paths have no lengths, so every one of them is either part of a
revision or behind a required capability. Rule 4 below says so.

### Game profiles

A game profile is everything about the wire that depends on the game. It is
named by the hello's `game` string. The Quake profile is today's behaviour. A
profile defines:

- the game-layer svc table (0 to 95), with handlers and payloads, including
  overrides of shared numbers;
- its temp-entity table, since TE numbers are game-layer too;
- the entity and player bits it uses in the profile ranges (`PE` 24 to 30, `PF`
  20 to 22), with the fields they fill;
- its stats: how many (`MAX_CL_STATS` is 32 in `src/quakedef.js:54`) and which
  are strings;
- its `svc_clientdata` layout;
- its escape ids from `0x8000` up;
- later, its movement rules for prediction (`pmove.js`, movevars).

The client builds its parse table from the protocol, the revision and the
profile. The server picks the profile from the game it is running. A client
without the profile refuses with "This client can't play <game>".

### Worked example: Hexen II

Everything below about Hexen II is as FTE defines it. Raven's source and uHexen2
were not checked (see Not verified).

- **Profile `"hexen2"`.** Its game-layer table is Quake's 0 to 33, plus H2's 34
  to 53 in place of Quake's and Fitz's (`svch2_particle2` 34 through
  `svch2_soundpos` 53, `fteqw/engine/client/cl_parse.c:9089-9110`).
  - This is why the engine messages have to leave 42 and 47 to 49. Under the
    versioned protocol, an H2 game's `svch2_starteffect` 42 and `svch2_ref` 47
    can't be mistaken for Icaro's player or entity messages.
  - `svc_intermission` takes H2's extra byte. The handler belongs to the profile
    (`fteqw/engine/server/net_preparse.c:1127-1131`).
  - Icaro passes H2 QuakeC writes through unchanged, so H2's own
    `svch2_setviewflags`, `svch2_setviewtint` and `svch2_setangles_lerp` reach
    the client as H2 wrote them. Unlike FTE, which translates them
    (`fteqw/engine/server/net_preparse.c:1153-1170`), nothing is lost.
- **Entities.** H2 entities go through Icaro's packet entities, not H2's
  `svch2_ref`, which FTE's reader handles with `CLH2_ParseEntities`
  (`fteqw/engine/client/cl_parse.c:9344-9350`).
  - Scale uses the engine's scale bit.
  - The two H2-only fields use the profile range: drawflags (the light mode and
    scale type, `fteqw/engine/common/protocol.h:1887` onward) at bit 24, and
    `abslight` at bit 25. This is the same pair FTE adds as `U_DRAWFLAGS` and
    `U_ABSLIGHT` (`:745-746`).
  - `svc_playerinfo` carries them for players in `PF` bits 20 and 21.
- **Player class.**
  - The server keeps H2's `svch2_updateclass` `[player][byte class]` in the H2
    table (FTE's reader: `fteqw/engine/client/cl_parse.c:9262-9267`). Icaro has
    no userinfo, so the class lives on the scoreboard entry, like name and
    colour.
  - Class-dependent models are picked on the server, as in FTE
    (`fteqw/engine/server/sv_ents.c:3630-3640`). The client only sees a model
    index, so the entity path needs nothing new.
  - How the player picks a class is a string command; its name is not checked.
- **Stats and inventory.**
  - The profile sets the stat count to cover H2's stats from 32 up, including
    string stats (`fteqw/engine/common/bothdefs.h:991-1048`).
  - `svc_updatestat`'s index is already a byte.
  - `svch2_updateinv` (49 in the H2 table) stays an H2 message.
- **Client data.** H2's `svc_clientdata` differs from Quake's; for example FTE
  doesn't default the view height for H2
  (`fteqw/engine/client/cl_parse.c:4393-4394`). The H2 profile defines its own
  layout for 15, with Icaro's wide fields.
- **Temp entities.** The H2 TE table is the profile's own. FTE puts the stream
  effects at 24 to 33 (`fteqw/engine/common/protocol.h:1110-1120`). A profile
  table avoids sharing one enum across games.
- **Out of scope here.** These are not protocol questions: H2 movement and
  per-class hulls for prediction, the H2 progs format and builtins, H2 BSP and
  model formats, and the H2 status bar.

A custom Icaro game works the same way. It either uses the Quake profile and
adds escape ids from `0x8000`, or registers its own profile id.

### Versioning rules

1. `1015` is the protocol family and never changes. An Icaro stream is
   identified by `1015` followed by the `0` marker.
2. **The revision** covers everything that isn't behind a capability. Any change
   to a base layout, an opcode or a profile's table bumps it.
3. **A server sends one revision.** A client plays its current revision live. It
   may keep older revisions' tables to play old demos.
4. **Unframed paths are never optional.** A new bit on an unframed path (`PE_*`,
   `PF_*`, `SU_*`, sound flags, opcodes 96 to 126) is part of a revision or
   behind a required capability.
5. **Optional means escape.** Optional capabilities only add escape messages.
6. **Bits and ids are never reused or redefined.** A retired bit stays reserved.
   FTE's `PEXT2_LERPTIME`, which redefines `UF_16BIT`
   (`fteqw/engine/common/protocol.h:90`), is the case to avoid.
7. **Folding.** When a required capability is always on, the next revision can
   make it part of the base and retire the bit.
8. **Full words.** When a word is full, the server sends one more (the counts
   `nreq` and `nopt`). No new mechanism is needed.
9. **Both sides in one PR.** A wire change updates the server, the client and
   the tests in the same PR (AGENTS.md, Port fidelity), and adds a row to this
   document's tables.
10. **`svc_version`.** Under Icaro it must name `1015` and can't change the
    revision or profile. Anything else is a `Host_Error`. The 15, 666 and 999
    readers keep their engines' behaviour.

### Transports, loopback and demos

- **Network clients.** `WT_PROTOCOL_VERSION` (`src/net.js:271`) gates
  WebTransport, WebSocket and WebRTC before any game data. Bump it whenever the
  revision changes, so a stale client (for example a cached PWA joining a newer
  browser-hosted room) is turned away with "Protocol version N not supported"
  (`src/net_webrtc.js:636-637`) before the hello. Don't rely on the hello for
  that.
- **Loopback and demos.** These have no transport hello. The hello is their only
  source of truth, and the capability check is the backstop for everyone.
- **Unused constants.** `NET_PROTOCOL_VERSION` and `CCREQ_CONNECT` belong to
  NetQuake's datagram driver, which Icaro doesn't use. They can be deleted, or
  kept to mirror `net.h`; either way they take no part in versioning.

### Client dispatch and the 15, 666 and 999 readers

- **Reader selection.** `CL_ParseServerInfo` reads the protocol long and picks a
  reader. For 1015 it then reads the marker, revision and profile.
- **What a reader is.** A reader is a plain object:
  - the coordinate and angle encodings, replacing `MSG_SetCoord32`'s single
    switch;
  - a 256-entry handler table, or 128 entries plus a fast-update handler for 15,
    666 and 999;
  - its baseline, static and static-sound parsers.
- **How the tables are built.** Handlers whose payloads agree are shared.
  `CL_ParseServerMessage` becomes one table lookup instead of a switch.
- **The readers.**

| Reader      | Coords             | Fast updates   | Extra svcs                                    |
| ----------- | ------------------ | -------------- | --------------------------------------------- |
| 15          | short              | NetQuake `U_*` | none                                          |
| 666         | short              | Fitz `U_*`     | 37, 40, 41, 42 to 44, 52, 56                  |
| 999         | per `PRFL_*` flags | Fitz `U_*`     | as 666                                        |
| 1015 rev 0  | int32              | none           | 42, 47 to 49, 52, 56 (only if kept for demos) |
| 1015 rev 1+ | int32              | none           | the profile's table, engine 96 to 127         |

- **Ironwail is the reference** for 666 and 999: `CL_ParseServerInfo`'s flags
  long (`ironwail/Quake/cl_parse.c:315-326`), the `U_EXTEND1`..`U_SCALE` bits
  and `B_*` baseline bits (`ironwail/Quake/protocol.h:42-70`, `:125-128`), and
  the Fitz cases.
- **Rerelease-only numbers** (38, 45 to 51, 53 to 55) end the demo as Ironwail
  does (`ironwail/Quake/cl_parse.c:1124-1128`) unless a demo is found that needs
  them.
- **Fog, skybox and `bf`.** The 37, 40 and 41 handlers are shared by the 666,
  999 and Quake-profile tables. QuakeC that writes them by hand works on Icaro
  too.

## Migration plan

Each step is one PR. "Wire break" means a client and server from either side of
the PR can't play together, and a demo recorded before it may stop playing.

1. **Table-driven client dispatch.** No wire break.
   - Turn the `switch` in `CL_ParseServerMessage` into a handler table per
     reader.
   - Replace `MSG_SetCoord32` with a reader's coordinate and angle modes.
   - 15 and 1015 behave as before; the net bench checksum must not change.
   - Files: `src/cl_parse.js`, `src/common.js`; tests in
     `tests/protocol_icaro_test.js`.
2. **666 and 999 demo readers.** Client only, no wire break.
   - Add the Fitz `U_*`, `B_*` and `PRFL_*` constants.
   - Add the 666/999 `CL_ParseUpdate`, baseline, static, static-sound and
     clientdata variants, the `PRFL_*` coordinate and angle modes, and handlers
     for 37, 40, 41 and 42 to 44.
   - Files: `src/protocol.js`, `src/cl_parse.js`, `src/common.js`,
     `src/gl_fog.js` (41), `src/gl_sky.js` (37), `src/view.js` (40); new tests
     with hand-built 666 and 999 messages. The audit's finding 1 (PR #251) is
     this step.
3. **The versioned hello and the renumber.** Wire break. The hello and the
   renumber go in together so the wire breaks once.
   - Write the hello with revision 1, `"quake"` and empty capability words.
   - Move 42 and 47 to 49 to 96 to 99, and `clc_delta` to 96.
   - Add `svc_icaro_ext` and `clc_icaro_ext` with the skip rule.
   - Bump `WT_PROTOCOL_VERSION`.
   - Files:
     - `src/protocol.js`;
     - `src/sv_main.js` (`SV_SendServerinfo`, the playerinfo, packet-entity and
       sequence writers);
     - `src/cl_parse.js` (hello reader, revision 1 table, revision 0 table if
       kept);
     - `src/sv_user.js` (its copy of the `clc_*` constants, lines 99-105, and
       the `clc_delta` case at 613);
     - `src/cl_input.js` (`clc_delta`);
     - `src/net.js` (`WT_PROTOCOL_VERSION`).
   - Tests that build or read these messages:
     - `tests/protocol_icaro_test.js`
     - `tests/sv_signon_test.js`
     - `tests/sv_packetentities_test.js`
     - `tests/cl_pred_nq_test.js`
     - `tests/cl_nolerp_test.js`
     - `tests/cl_review_fixes_test.js`
     - `tests/cl_parse_lazy_map_test.js`
   - Tools:
     - `tools/room_bench.js:238` checks for `svc_serversequence` by its literal
       49.
     - `tools/bench/net_bench.js` prints a checksum of the bytes sent, which
       changes. Record the new value in the PR.
4. **Game profile registry.** No wire break.
   - Move the Quake-specific tables (game-layer svcs, TEs, stats, clientdata)
     behind a `"quake"` profile object that the reader and the server both look
     up.
   - Files: a new `src/game_profile.js`, `src/cl_parse.js`, `src/cl_tent.js`,
     `src/sv_main.js`.
5. **Revision 2: delta baselines and entity extras.** Wire break, and the first
   required capability.
   - Add `svc_icaro_baseline` and `svc_icaro_static`, `PE_EXTEND2` and
     `PF_EXTEND`, and `ICAP_ENTITY_EXTRAS` with scale and colormod.
   - The client keeps the revision 1 table, so revision 1 demos still play.
   - Files: `src/protocol.js`, `src/sv_main.js` (`SV_CreateBaseline`,
     `SV_WriteEntitiesToClient`, the player writer), `src/cl_parse.js`, the
     renderer (scale), `tests/sv_packetentities_test.js`,
     `tests/sv_signon_test.js`, `tools/bench/net_bench.js` (checksum).
6. **Hexen II profile.** Later, and not protocol-only. The protocol part is a
   `"hexen2"` profile:
   - its table, TE table, stats, clientdata and the two entity fields;
   - built on steps 3 to 5.
   - The game itself (progs, BSP, models, physics, HUD) is far larger, and needs
     its own design.

Steps 2 and 4 build on the tables from step 1, and can go in either order after
it. Step 3 also comes after step 1, and before step 5.

## Not verified

- Hexen II facts come only from FTE's code. Raven's Hexen II source and uHexen2
  were not read. FTE's NetQuake-protocol H2 reader is for demos only and
  incomplete by its own comments (`fteqw/engine/client/cl_parse.c:3976-3981`,
  `:9368-9371`).
- KEX (the 2021 rerelease) was read only through Ironwail's and QSS's
  definitions, not from a KEX server or a rerelease demo.
- No 666, 999 or Hexen II demo file was parsed. No engine was run.
- The free range 95 to 127 is free in the four engines read. vkQuake, JoeQuake,
  ezQuake and other ports were not checked.
- The skip rule for escape messages assumes `MSG_ReadShort` lengths fit inside
  one message. No measurement was made of how much the 4 extra bytes per escape
  message cost.

## Open questions for the maintainer

1. **Old 1015 demos.** Keep a revision 0 reader so demos recorded before the
   versioned hello still play? It is cheap with tables (the old numbers 42 and
   47 to 49, the old hello). Recommendation: keep it for one release, then
   decide.
2. **A client reply.** Should the client be able to answer the hello with the
   optional capabilities it wants (for example voice), FTE- and QSS-style? That
   needs per-client data outside the shared signon buffers. The design doesn't
   need it yet.
3. **128 to 255.** Icaro's server never sends fast updates, so 1015 could
   reclaim the high half of the byte. Recommendation: not now. 96 to 127 plus
   the escape is enough, and a mistake there would be hard to spot.
4. **Hexen II: pass-through or translation?** This design passes H2 QuakeC
   writes to the client with an H2 table. FTE translates them on the server into
   one wire format. Pass-through matches how Icaro works today.
5. **Protocol 19 demos.** Should the client also read NetQuake-protocol Hexen II
   demos, as FTE does? Only useful once the H2 profile exists.
6. **The profile id.** A string (proposed: readable, and custom games can pick
   one) or a registered number?
7. **`clc_delta`.** Move it to 96 for one rule in both directions (proposed), or
   leave it at QW's 5, where nothing collides?
8. **Revision 2 timing.** Ship the delta baselines with the renumber (one wire
   break) or separately (smaller PRs, two breaks)? This plan separates them and
   keeps the revision 1 table for demos.
9. **Rerelease svcs in demos.** End the demo on 38, 45 to 51 and 53 to 55, as
   Ironwail does, or skip them? Skipping needs their payload layouts, which were
   not read.
10. **Publishing the standard.** Should the svc tables, the hello and the
    capability list move to a standalone spec once step 3 lands, for other
    engines or tools that want to read Icaro demos?
