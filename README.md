# Icaro Engine

A Three.js-based web game engine that runs Quake, forked from
[three-quake](https://github.com/mrdoob/three-quake). `docs/vision.md` gives the
goals.

### Assets

Shareware `pak0.pak` included (Episode 1).\
For the full game, copy `pak1.pak` from the `id1` folder of a registered copy of
Quake to `static/pak1.pak` (lower case). The client and the room server load
`pak0.pak`, `pak1.pak`, ... until one is missing. A pak over 64 MB (such as the
2021 rerelease's) is not downloaded whole: the client reads its directory and
the files the engine needs at startup with HTTP Range requests, and fetches each
map when it is first loaded. That needs a web server that honours Range, such as
`deno task serve` (Deno's file server on http://localhost:8137/);
`python3 -m http.server` doesn't, so it sends the whole pak instead, which still
works. The room server reads big paks from disk as needed. Registered data must
not be committed or deployed publicly; `.gitignore` excludes `static/pak1.pak`.

#### Mission packs

To play _Scourge of Armagon_ or _Dissolution of Eternity_, copy the pack's
`pak0.pak` to `static/hipnotic/pak0.pak` or `static/rogue/pak0.pak` and open the
page with `?game=hipnotic` or `?game=rogue`. This is WinQuake's `-hipnotic` /
`-rogue`: the pack's paks load after id1's, so its progs, graphics and maps win,
and the status bar and multiplayer menu switch to the pack's layout and levels.
Mission packs need the registered `static/pak1.pak`. For multiplayer, start the
lobby (or `game_server.js`) with the same `-hipnotic` or `-rogue` flag.
`.gitignore` excludes `static/hipnotic/` and `static/rogue/`.

#### Quake (2021 rerelease)

Copy the rerelease's `id1`, `hipnotic`, `rogue`, `mg1`, `mg3`, `dopa` and `ctf`
folders to `static/rerelease/` and open the page with `?base=rerelease`. This is
the C `-basedir`: id1's paks load from `static/rerelease/id1/`, and `?game=`
directories from `static/rerelease/<game>/`. `?game=mg1`, `mg3`, `dopa` or `ctf`
is the C `-game <dir>`: the folder's paks load after id1's (without
`?base=rerelease`, from `static/<game>/`). Music plays from the game folder's
`music/trackNN.ogg`, then id1's, and loose files such as custom maps are looked
up the same way, then in `static/`. Pak names may be upper case (`PAK0.PAK`).
The rerelease's paks are large, so they load lazily (see above); serve them with
a Range-capable server. The rerelease's maps load with its own progs, BSP2
included; skyboxes, `.lit` lighting, fog, the effect lights and MD5 models are
supported too, and [docs/rerelease-gaps.md](docs/rerelease-gaps.md) records how
each gap was closed. `.gitignore` excludes `static/rerelease/`, `static/id1/`
and the add-on folders. For multiplayer, start the lobby (or `game_server.js`)
with `-pak ../static/rerelease/id1/pak0.pak` and the same `-game` or
mission-pack flag.

#### Your own data in the browser

Where there is no `static/` folder to copy into (the public site, or a phone),
**Options → Game data** (or the `menu_gamedata` command) adds your own paks from
a file picker. They are kept in this browser's storage on this device only, are
recognised by what they hold rather than their names, and load at the next start
in place of the files the game would fetch. Its Play buttons start each game the
stored paks allow. The panel also imports and exports saves, `config.cfg` and
demos.

### Mobile

On phones and tablets the game shows touch controls. Play in landscape.

- **Left side:** a floating move stick
  ([nipplejs](https://github.com/yoannmoinet/nipplejs), loaded from jsDelivr).
  Push it to the edge to run.
- **Right side:** drag to look. You can also drag on FIRE or JUMP to aim while
  holding them.
- **Buttons:** FIRE, JUMP, DOWN (swim down), next and previous weapon, and pause
  (which opens the menu). Hold the next-weapon button to open a weapon wheel,
  slide to a weapon and let go. Beside pause, SAVE and LOAD quick-save and
  quick-load in single player, CON opens the console, and CHAT types a message
  in multiplayer.
- **Menus and console:** tap menu items directly. While a menu or the console is
  open, a bar at the top gives you Back and a keyboard button.
- **Options → Touch controls:** look speed, gyro aiming, gyro speed, gyro dead
  zone and smoothing, invert look, left-handed layout (swaps the sides and
  mirrors the buttons), look speed scaled to screen size (on by default, so a
  drag across the same share of a tablet's screen turns as far as on a phone),
  look acceleration, button size and opacity, and vibration. Settings are saved
  as `touch_*` cvars, except Invert Look, which is `m_pitch`.
- **Edit Layout** (in Options → Touch controls, or the `touch_editlayout`
  command): drag, resize and hide the buttons, and add buttons that run any
  console command (`+attack` is held while pressed). Layouts are saved on the
  device as named profiles; `touch_layout <name>` switches to one.
- **Gyro aiming:** off by default. It can be always on, on only while a finger
  aims (lift it to re-centre the phone), or on only while FIRE is held. On iOS,
  the motion permission prompt appears the first time you tap after turning it
  on.
- **Aim assist** (Options → Touch controls): sets how wide the autoaim cone is
  in a game this browser runs (single player, or a game you host), through
  `sv_aim`. The lowest level turns autoaim off and the middle one is Quake's
  own. It has no effect in an online lobby room.
- **Fullscreen on iPhone:** use Safari's _Add to Home Screen_. iOS doesn't allow
  fullscreen in a browser tab, but the installed app runs fullscreen.

### Smart TVs and slow GPUs

- **Render scale:** add `?scale=0.5` to the URL to draw the 3D view at half the
  screen resolution (a quarter of the pixels) and stretch it to fill the page.
  Values from 0.25 to 1 work; menus and the status bar stay at full resolution.
  This is a web-only option with no GLQuake equivalent.
- **Pixel ratio:** on phones and tablets (coarse primary pointer, no fine
  pointer) the device pixel ratio is capped at 2 for both the 3D view and the
  menu/HUD canvas, which cuts the pixels drawn on DPR-3 screens by more than
  half. Add `?dpr=native` to remove the cap, or `?dpr=1.5` (0.5 to 4) to set the
  ratio yourself, on any device. Web-only, no GLQuake equivalent.
- **Particle limit:** `?particles=2048` is the C `-particles 2048`: it sets how
  many particles can be alive at once. The default is Ironwail's 16384 (id's was
  2048), values below 512 are raised to 512, and values above 262144 are
  ignored. With a lower limit, busy scenes drop particles instead of drawing
  more of them.
- **Fullscreen without pointer lock:** browsers that refuse pointer lock
  (Samsung TV browsers, for example) go fullscreen instead: click in the game
  twice (the first refusal might be temporary). Look around with a gamepad or
  the arrow keys.
- **Back button:** once you have clicked, tapped or pressed a key (other than
  Escape or a modifier), the browser's Back (a TV remote's Back key, Android's
  back gesture, Alt+Left) acts as Escape instead of leaving the page: it opens
  the menu in game and goes back a level in menus. To leave, use the address bar
  or close the tab. This is a web-only addition.
- **Gamepads:** controllers that report the browser's `standard` mapping work as
  they are. Paired to a Samsung TV, a DualSense works in its browser. The
  sticks' dead zones and response curves can be tuned in Options > Advanced >
  Controller, or in the console with Ironwail's `joy_deadzone_move`,
  `joy_deadzone_look`, `joy_outer_threshold_move`, `joy_outer_threshold_look`,
  `joy_exponent` and `joy_exponent_move` cvars.

### AI agents

The page has a JavaScript API for LLM agents and scripts, `window.icaro`: run
`icaro.help()` in the page. `?agent=lockstep` freezes the game between the
agent's steps (`?agent=realtime` leaves it running), and `?map=e1m1&skill=1`
starts a map instead of the intro demos.
[docs/agent-interface.md](docs/agent-interface.md) has the design. This is a
web-only addition.

### Multiplayer

The page joins online games through a lobby (`deno task lobby`). `?server=`
picks the lobby, `?transport=ws` or `?transport=wt` picks WebSocket or
WebTransport, and `?room=` joins a room. `?listen=N` starts the page with N
player slots, and deathmatch on when N is above 1, as `-listen N` does in Quake,
for hosting a game in the browser. [server/README.md](server/README.md) covers
running the servers, these parameters, and serving through a Cloudflare Tunnel.

### License

Code: GNU GPL version 2 ([LICENSE](LICENSE)), as id Software released
[Quake's source](https://github.com/id-Software/Quake/blob/master/readme.txt)
under the GPL. For a game built on Icaro:

- **Your game's data may stay proprietary.** That covers your own maps, models,
  textures, sounds and music. Shipping a separate work alongside the engine
  doesn't by itself bring it under the GPL ([section 2](LICENSE), "mere
  aggregation").
- **Engine changes and any desktop build must offer source.** When you
  distribute a changed engine, or the engine in a compiled or packaged form (a
  desktop build, say), changed or not, offer its complete source under the GPL
  ([sections 2 and 3](LICENSE)). Copies of the unchanged source keep its notices
  and come with the licence ([section 1](LICENSE)).

The GPL covers the code only. The shareware `pak0.pak` that comes with this
repository has other terms, which restrict commercial use and distribution. The
Quake artwork and logo in it are id's art and marks, with no confirmed licence.
Check these before you ship any with your game. [THIRD_PARTY.md](THIRD_PARTY.md)
lists them, and the other code and data Icaro ships or loads that it didn't
write.

### Credits

- Original game by id Software ([source](https://github.com/id-Software/Quake))
- Original Three.js port (`three-quake`) by [@mrdoob](https://github.com/mrdoob)
  with [@claude](https://github.com/claude)
- Engine fixes and limit raises ported from
  [Ironwail](https://github.com/andrei-drexler/ironwail) by Andrei Drexler, and
  its ancestors [QuakeSpasm](https://sourceforge.net/projects/quakespasm/) and
  FitzQuake (GPL v2 or later)
