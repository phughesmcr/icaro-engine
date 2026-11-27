# Third-party software and data

What Icaro Engine ships or loads that it didn't write, with each item's licence
and source. Icaro's own licence is in [LICENSE](LICENSE) (GNU GPL version 2);
[README.md](README.md#license) says what that means for games built on it. The
items below keep their own terms, and **some of them are not under the GPL or
any other open-source licence**.

This is a record of what the sources say, not legal advice. **Not confirmed**
marks what couldn't be checked.

- **Shipped** means a file or code in this repository, so also in the deployed
  client or the room image if their file lists include it
  ([cloudflare/client/build.js](cloudflare/client/build.js),
  [server/Dockerfile](server/Dockerfile)).
- **Loaded** means fetched or installed to run the game, a server or a tool, but
  not kept in this repository.
- Not listed: developers' own tools (the Deno CLI on their machine, git, Docker,
  Wrangler, GitHub Actions), and data a player adds. Registered Quake data, the
  mission packs, the 2021 rerelease and CD rips are gitignored and are neither
  committed nor shipped.

**To add an entry**, add a bullet to the section it belongs in, in this form, so
that two branches adding entries rarely touch the same lines:

```markdown
- **Name and version.** What it is and where Icaro uses it. Licence: [name](link
  to the licence text or statement). Source: [name](link).
```

## Game data

- **Quake shareware `pak0.pak` (v1.06).** No longer shipped. It was in the
  repository as `static/pak0.pak` (from
  [three-quake](https://github.com/mrdoob/three-quake)), the client and the room
  image until LibreQuake replaced it; it remains in the repository's git
  history, which was not rewritten. Copyright id Software, **proprietary, not
  GPL**:
  [Quake shareware Limited Use Software License Agreement](https://github.com/id-Software/Quake/blob/bf4ac424ce754894ac8f1dae6a3981954bc9852d/WinQuake/data/SLICNSE.TXT)
  (dated June 21, 1996). A player may still add their own copy, or registered
  Quake's paks, in Options, Game data; those stay in that player's browser.
- **LibreQuake v0.09-beta.** Loaded: the browser's default game data, a free
  replacement for id1's. [src/librequake.js](src/librequake.js) downloads the
  pinned `full.zip` or `lite.zip` when a player asks for it and keeps the files,
  its `docs/` licence files included, in that player's browser storage.
  **Shipped in the game-room image:** `server/Dockerfile` fetches `full.zip`
  (SHA-256 checked) while building and keeps `id1/pak0.pak`, `id1/pak1.pak` and
  the loose `id1/maps/`, with the zip's licence texts (`id1/docs/copying`,
  `id1/docs/misc-docs/copying` and `id1/docs/readme-important-licence-info`),
  which the BSD 3-clause licence asks a redistribution to reproduce;
  `tools/check_container_image.sh` fails if one is missing. The tests,
  benchmarks and servers use the same files, which `deno task fetch-data`
  (`tools/fetch_data.js`) puts in the gitignored `static/librequake/`. Nothing
  of it is in this repository or the deployed client
  ([docs/librequake-content.md](docs/librequake-content.md) covers hosting).
  Licence: models, textures, sounds and maps under the BSD 3-clause licence
  (`docs/COPYING` in the zip); the QuakeC, `progs.dat` and `pop.lmp` under the
  GPL-2 (`docs/misc-docs/COPYING`), as the zip's
  `docs/README-IMPORTANT-LICENCE-INFO` says. Source:
  [lavenderdotpet/LibreQuake](https://github.com/lavenderdotpet/LibreQuake).

## Images, icons and fonts

All shipped in the repository and the client. None of them is id Software's art.

- **The Icaro mark: `static/icon.svg`.** The page icon, a sun above two raised
  wings. Drawn for Icaro; Icaro's own, under the repository's licence
  ([LICENSE](LICENSE)).
- **Other icons and launch images:** `static/icon.png`, `static/icon-192.png`,
  `static/icon-maskable-512.png`, `static/apple-touch-icon.png` and
  `static/splash/*.png` are renderings of `icon.svg` (the maskable one scaled to
  fit the safe zone). [tools/make_splash.py](tools/make_splash.py) makes the
  launch images from `icon.png`. Same licence as `icon.svg`.
- **Menu label: `static/mainmenu.png`.** The main menu's Continue row, which
  Icaro adds above Quake's rows while in a game, in plain block letters drawn
  for Icaro. Icaro's own, under the repository's licence. The other menu rows
  and graphics come from the loaded game data.
- **Screenshots: `static/screenshots/`.** Icaro playing LibreQuake, for the web
  app manifest. The captures are Icaro's; the art they show is LibreQuake's,
  under the BSD 3-clause licence (see LibreQuake under Game data), apart from
  the Continue row above.
- **Fonts:** none shipped or loaded. The page's own text uses the browser's
  fonts, and the game's lettering comes from the loaded game data.

## Ported and derived code

Shipped as JavaScript and TypeScript in `src/`, `server/` and `main.js`. These
are ports and changes, so the files are not copies of the originals. A file's
header or a comment names what it follows; to list the files that cite the later
ports:

```bash
rg -il 'ironwail|quakespasm|fitzquake|johnfitz' src server main.js
```

- **Quake (WinQuake, GLQuake and QuakeWorld), id Software.** The engine is a
  port of it. Licence:
  [GPL version 2 or later](https://github.com/id-Software/Quake/blob/bf4ac424ce754894ac8f1dae6a3981954bc9852d/WinQuake/common.c#L1-L19)
  (file headers; see also id's
  [readme](https://github.com/id-Software/Quake/blob/bf4ac424ce754894ac8f1dae6a3981954bc9852d/readme.txt)).
  Source: [id-Software/Quake](https://github.com/id-Software/Quake).
- **three-quake, mrdoob.** The Three.js port that Icaro was forked from, made
  with Claude. This repository's history includes three-quake's up to commit
  [`6d6177b`](https://github.com/mrdoob/three-quake/commit/6d6177b11f81f390d8e527dd5dd738d981eb13fa).
  Licence:
  [GPL version 2](https://github.com/mrdoob/three-quake/blob/6d6177b11f81f390d8e527dd5dd738d981eb13fa/LICENSE)
  (its README says "Code: GPL v2"). Source:
  [mrdoob/three-quake](https://github.com/mrdoob/three-quake).
- **Ironwail, Andrei Drexler and its other authors.** Fixes, limits and whole
  features: the headers of `gl_fog.js`, `gl_sky.js`, `gl_md5.js`,
  `gl_entalpha.js`, `gl_screenwarp.js`, `gl_gamma.js`, `image.js`,
  `pr_sprintf.js`, `default_cfg.js` and `unicode_translit.js` cite it, as do
  comments elsewhere. Licence:
  [GPL version 2 or later](https://github.com/andrei-drexler/ironwail/blob/3fa96fe3a2119b17c7be4f7b747ea3e7c3c455aa/Quake/gl_fog.c#L1-L23)
  (file headers;
  [LICENSE.txt](https://github.com/andrei-drexler/ironwail/blob/3fa96fe3a2119b17c7be4f7b747ea3e7c3c455aa/LICENSE.txt)).
  Source: [andrei-drexler/ironwail](https://github.com/andrei-drexler/ironwail).
- **QuakeSpasm, and FitzQuake before it.** `image.js` ports its TGA loader,
  `gl_gamma.js` its gamma and contrast shader, `default_cfg.js` carries its
  `default.cfg` (by way of Ironwail), and comments elsewhere cite its changes
  and FitzQuake's (John Fitzgibbons), some of which credit MarkV. Licence:
  [GPL version 2 or later](https://github.com/sezero/quakespasm/blob/13f16f2b28f288ba29a0222c28bcf1e41d60cc5a/Quake/image.c#L1-L21)
  (file headers, which name FitzQuake's authors too). Source:
  [QuakeSpasm](https://sourceforge.net/projects/quakespasm/)
  ([sezero/quakespasm](https://github.com/sezero/quakespasm)).
- **QuakeSpasm `snd_umx.c`, O. Sezer.** `snd_umx.js` ports its Unreal UMX
  container parser (which its header says is partly based on Andy Ward's Unreal
  Media Ripper), and `cd_audio.js` follows `bgmusic.c` for the music formats,
  their search order and the `music` commands. Licence:
  [GPL version 2 or later](https://github.com/sezero/quakespasm/blob/13f16f2b28f288ba29a0222c28bcf1e41d60cc5a/Quake/snd_umx.c#L1-L22)
  (file header). Source:
  [sezero/quakespasm](https://github.com/sezero/quakespasm).
- **Quakespasm-Spiked, Spike.** `gl_model.js` cites it for two features (holey
  alias skins and the water visibility check), and `world.js` credits Spike for
  a fix taken by way of Ironwail. Licence:
  [GPL version 2 or later](https://github.com/Shpoike/Quakespasm/blob/4c0c55f7830715cf8670f586c7be01ebce262d23/Quake/gl_model.c#L1-L22)
  (file headers). Source:
  [Shpoike/Quakespasm](https://github.com/Shpoike/Quakespasm).
- **DarkPlaces `sprintf`.** `pr_sprintf.js` ports Ironwail's
  `PF_sprintf_internal`, which its header traces to DarkPlaces' `VM_sprintf`.
  Licence: DarkPlaces'
  [`prvm_cmds.c`](https://github.com/DarkPlacesEngine/darkplaces/blob/6d754e4372fea51fd97689231ecd2ebcbb4c9ad7/prvm_cmds.c#L1-L6)
  has no licence block of its own, only a note that the same copyright as in
  `pr_cmds` applies (id's
  [`pr_cmds.c`](https://github.com/id-Software/Quake/blob/bf4ac424ce754894ac8f1dae6a3981954bc9852d/WinQuake/pr_cmds.c)
  is GPL version 2 or later). Source:
  [DarkPlacesEngine/darkplaces](https://github.com/DarkPlacesEngine/darkplaces).
- **Unidecode tables.** `unicode_translit.js` is the table from Ironwail's
  [`unicode_translit.h`](https://github.com/andrei-drexler/ironwail/blob/3fa96fe3a2119b17c7be4f7b747ea3e7c3c455aa/Quake/unicode_translit.h),
  which is generated with the Python `unidecode` package. Licence:
  [GPL version 2 or later](https://github.com/avian2/unidecode/blob/158ec2c7e7b5d4bc7894cb2a99e050cdf3229c48/README.rst#copyright)
  (original tables copyright Sean M. Burke, later additions Tomaž Šolc). Source:
  [avian2/unidecode](https://github.com/avian2/unidecode).

## Libraries the page loads

`index.html`'s import map loads these from jsDelivr, with integrity hashes, and
[sw.js](sw.js) caches them in the player's browser. The map also names
`three/addons/`, which nothing imports. Under Deno, `three` is Icaro's own
`server/browser_shim.js` instead.

- **Three.js 0.183.0** (`three.module.js` and `three.core.js`). The renderer.
  Licence: [MIT](https://github.com/mrdoob/three.js/blob/r183/LICENSE). Source:
  [mrdoob/three.js](https://github.com/mrdoob/three.js/tree/r183).
  `tests/three_r183_shaders.js` copies two of its fragment shaders for the
  shader-patch tests.
- **nipplejs 1.0.4.** The touch move stick. Licence:
  [MIT](https://github.com/yoannmoinet/nipplejs/blob/v1.0.4/LICENSE). Source:
  [yoannmoinet/nipplejs](https://github.com/yoannmoinet/nipplejs/tree/v1.0.4).
- **zip.js 2.25.0** (`dist/zip-core-external.min.js`). Unpacks LibreQuake's
  download; imported only when a download is unpacked. Licence:
  [BSD 3-clause](https://cdn.jsdelivr.net/npm/@zip.js/zip.js@2.25.0/LICENSE).
  Source: [gildas-lormeau/zip.js](https://github.com/gildas-lormeau/zip.js).
- **libopenmpt 0.8.10, from chiptune3 0.8.10** (`libopenmpt.worklet.js`, an
  Emscripten build with the WebAssembly inlined). Plays tracker music (`.mod`,
  `.s3m`, `.xm`, `.it`, and the module in a `.umx`) through
  [src/bgm_tracker.js](src/bgm_tracker.js); imported only when such a file is
  found. Licence: libopenmpt is
  [BSD 3-clause](https://raw.githubusercontent.com/OpenMPT/openmpt/master/LICENSE);
  chiptune3's own code is
  [MIT](https://cdn.jsdelivr.net/npm/chiptune3@0.8.10/LICENSE), which says the
  compiled libopenmpt keeps the OpenMPT BSD licence. Icaro loads only the
  compiled libopenmpt file, not chiptune3's player. Source:
  [OpenMPT](https://lib.openmpt.org/libopenmpt/) and
  [DrSnuggles/chiptune](https://github.com/DrSnuggles/chiptune).

## Hosted services

Code and services from other hosts that the game calls. Icaro ships none of
them.

- **Cloudflare Turnstile `api.js`.** The page loads it from
  `challenges.cloudflare.com` to check a player before creating a room, and the
  lobbies call Turnstile's Siteverify. Proprietary: no open-source licence
  found. Terms: whatever the site owner agreed with Cloudflare (**not
  confirmed** which document); data handling:
  [Turnstile Privacy Addendum](https://www.cloudflare.com/turnstile-privacy-policy/).
  Source: [Turnstile docs](https://developers.cloudflare.com/turnstile/).
- **Cloudflare STUN and TURN.** Browser-hosted rooms use them to connect
  players; they are network services, with no code to ship. Terms: Cloudflare's.
  Source:
  [Cloudflare TURN docs](https://developers.cloudflare.com/realtime/turn/).

## Servers, packages and tools

npm and JSR package versions are pinned in [deno.lock](deno.lock). None of these
packages is in this repository or the client. `server/game_server.js` imports no
npm package.

- **MCP TypeScript SDK: `@modelcontextprotocol/server` and
  `@modelcontextprotocol/core` 2.4.0.** Loaded by `server/agent_mcp.ts` only.
  Licence:
  [Apache-2.0](https://registry.npmjs.org/@modelcontextprotocol/server/2.4.0)
  per the packages' metadata; the repository's
  [LICENSE](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/LICENSE)
  says it is moving from MIT, and some contributions remain MIT. The Apache
  Foundation reports that the FSF
  [doesn't consider Apache-2.0 compatible with GPL version 2](https://www.apache.org/licenses/GPL-compatibility.html),
  only with version 3. Source:
  [modelcontextprotocol/typescript-sdk](https://github.com/modelcontextprotocol/typescript-sdk).
- **zod 4.6.7.** Loaded by `server/agent_mcp.ts`, and a dependency of the MCP
  SDK. Licence: [MIT](https://github.com/colinhacks/zod/blob/v4.6.7/LICENSE).
  Source: [colinhacks/zod](https://github.com/colinhacks/zod).
- **`@babel/parser` 8.1.3,** with `@babel/types` 8.1.3,
  `@babel/helper-string-parser` 8.1.3 and `@babel/helper-validator-identifier`
  8.0.6. Loaded only by `tools/fmt_ast_check.js` and
  `tools/collapse_banners.js`. Licence:
  [MIT](https://github.com/babel/babel/blob/v8.1.3/LICENSE). Source:
  [babel/babel](https://github.com/babel/babel).
- **Deno standard library: `@std/http` 1.1.4** and the `@std` packages it
  depends on. Loaded by `deno task serve`. Licence:
  [MIT](https://github.com/denoland/std/blob/main/LICENSE); `@std/media-types`
  also carries a
  [vendored MIT licence](https://jsr.io/@std/media-types/1.1.0/vendor/LICENSE).
  Source: [denoland/std](https://github.com/denoland/std).
- **Deno 2.9.8 and the room image's base.** The image built from
  [server/Dockerfile](server/Dockerfile) starts from
  `denoland/deno:debian-2.9.8`, so whoever publishes that image also ships Deno,
  tini and Debian packages. Licences: Deno
  [MIT](https://github.com/denoland/deno/blob/v2.9.8/LICENSE.md), tini
  [MIT](https://github.com/krallin/tini/blob/master/LICENSE), and each Debian
  package its own (`/usr/share/doc/*/copyright` in the image). **Not
  confirmed:** the licences of the components built into the Deno binary.
  Source: [denoland/deno_docker](https://github.com/denoland/deno_docker).
- **Gymnasium and NumPy, versions not pinned.** Python packages that only
  [tools/gym/icaro_env.py](tools/gym/icaro_env.py) imports. Installing them
  brings their own dependencies, which aren't listed here. Licences: Gymnasium
  [MIT](https://github.com/Farama-Foundation/Gymnasium/blob/main/LICENSE), NumPy
  [BSD-3-Clause](https://github.com/numpy/numpy/blob/main/LICENSE.txt), with
  bundled parts under other permissive licences
  ([package metadata](https://pypi.org/pypi/numpy/json)). Sources:
  [Farama-Foundation/Gymnasium](https://github.com/Farama-Foundation/Gymnasium),
  [numpy/numpy](https://github.com/numpy/numpy).
