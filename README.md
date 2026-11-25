# Icaro Engine

A Three.js-based Quake engine port, forked from [three-quake](https://github.com/mrdoob/three-quake).

### Assets

Shareware `pak0.pak` included (Episode 1).  
For the full game, copy `pak1.pak` from the `id1` folder of a registered copy of Quake to `static/pak1.pak` (lower case).
The client and the room server load `pak0.pak`, `pak1.pak`, ... until one is missing.
A pak over 64 MB (such as the 2021 rerelease's) is not downloaded whole: the client reads its directory and the files the engine needs at startup with HTTP Range requests, and fetches each map when it is first loaded. That needs a web server that honours Range; `python3 -m http.server` doesn't, so it sends the whole pak instead, which still works. The room server reads big paks from disk as needed.
Registered data must not be committed or deployed publicly; `.gitignore` excludes `static/pak1.pak`.

#### Mission packs

To play *Scourge of Armagon* or *Dissolution of Eternity*, copy the pack's `pak0.pak` to `static/hipnotic/pak0.pak` or `static/rogue/pak0.pak` and open the page with `?game=hipnotic` or `?game=rogue`.
This is WinQuake's `-hipnotic` / `-rogue`: the pack's paks load after id1's, so its progs, graphics and maps win, and the status bar and multiplayer menu switch to the pack's layout and levels.
Mission packs need the registered `static/pak1.pak`. For multiplayer, start the lobby (or `game_server.js`) with the same `-hipnotic` or `-rogue` flag.
`.gitignore` excludes `static/hipnotic/` and `static/rogue/`.

#### Quake (2021 rerelease)

Copy the rerelease's `id1`, `hipnotic`, `rogue`, `mg1`, `mg3`, `dopa` and `ctf` folders to `static/rerelease/` and open the page with `?base=rerelease`. This is the C `-basedir`: id1's paks load from `static/rerelease/id1/`, and `?game=` directories from `static/rerelease/<game>/`.
`?game=mg1`, `mg3`, `dopa` or `ctf` is the C `-game <dir>`: the folder's paks load after id1's (without `?base=rerelease`, from `static/<game>/`). Music plays from the game folder's `music/trackNN.ogg`, then id1's, and loose files such as custom maps are looked up the same way, then in `static/`.
Pak names may be upper case (`PAK0.PAK`). The rerelease's paks are large, so they load lazily (see above); serve them with a Range-capable server.
The rerelease's maps load with its own progs, BSP2 included; skyboxes, `.lit` lighting, fog, the effect lights and MD5 models are supported too, and [docs/rerelease-gaps.md](docs/rerelease-gaps.md) records how each gap was closed. `.gitignore` excludes `static/rerelease/`, `static/id1/` and the add-on folders.
For multiplayer, start the lobby (or `game_server.js`) with `-pak ../static/rerelease/id1/pak0.pak` and the same `-game` or mission-pack flag.

### Mobile

On phones and tablets the game shows touch controls. Play in landscape.

- **Left side:** a floating move stick ([nipplejs](https://github.com/yoannmoinet/nipplejs), loaded from jsDelivr). Push it to the edge to run.
- **Right side:** drag to look. You can also drag on FIRE or JUMP to aim while holding them.
- **Buttons:** FIRE, JUMP, next and previous weapon, and pause (which opens the menu).
- **Menus and console:** tap menu items directly. While a menu or the console is open, a bar at the top gives you Back and a keyboard button.
- **Options → Touch controls:** look speed, gyro aiming, gyro speed, invert look, left-handed layout (swaps the sides and mirrors the buttons), button size and opacity, and vibration. Settings are saved as `touch_*` cvars, except Invert Look, which is `m_pitch`.
- **Gyro aiming:** off by default. On iOS, the motion permission prompt appears the first time you tap after turning it on.
- **Fullscreen on iPhone:** use Safari's *Add to Home Screen*. iOS doesn't allow fullscreen in a browser tab, but the installed app runs fullscreen.

### Smart TVs and slow GPUs

- **Render scale:** add `?scale=0.5` to the URL to draw the 3D view at half the screen resolution (a quarter of the pixels) and stretch it to fill the page. Values from 0.25 to 1 work; menus and the status bar stay at full resolution. This is a web-only option with no GLQuake equivalent.
- **Particle limit:** `?particles=2048` is the C `-particles 2048`: it sets how many particles can be alive at once. The default is Ironwail's 16384 (id's was 2048), values below 512 are raised to 512, and values above 262144 are ignored. With a lower limit, busy scenes drop particles instead of drawing more of them.
- **Fullscreen without pointer lock:** browsers that refuse pointer lock (Samsung TV browsers, for example) go fullscreen instead: click in the game twice (the first refusal might be temporary). Look around with a gamepad or the arrow keys.
- **Back button:** once you have clicked, tapped or pressed a key (other than Escape or a modifier), the browser's Back (a TV remote's Back key, Android's back gesture, Alt+Left) acts as Escape instead of leaving the page: it opens the menu in game and goes back a level in menus. To leave, use the address bar or close the tab. This is a web-only addition.
- **Gamepads:** controllers that report the browser's `standard` mapping work as they are. Paired to a Samsung TV, a DualSense works in its browser. The sticks' dead zones and response curves can be tuned in Options > Advanced > Controller, or in the console with Ironwail's `joy_deadzone_move`, `joy_deadzone_look`, `joy_outer_threshold_move`, `joy_outer_threshold_look`, `joy_exponent` and `joy_exponent_move` cvars.

### Multiplayer

The page joins online games through a lobby (`deno task lobby`). `?server=` picks the lobby, `?transport=ws` or `?transport=wt` picks WebSocket or WebTransport, and `?room=` joins a room. [server/README.md](server/README.md) covers running the servers, these parameters, and serving through a Cloudflare Tunnel.

### License

Code: GPL v2

### Credits

- Original game by id Software ([source](https://github.com/id-Software/Quake))
- Original Three.js port (`three-quake`) by [@mrdoob](https://github.com/mrdoob) with [@claude](https://github.com/claude)
- Engine fixes and limit raises ported from [Ironwail](https://github.com/andrei-drexler/ironwail) by Andrei Drexler, and its ancestors [QuakeSpasm](https://sourceforge.net/projects/quakespasm/) and FitzQuake (GPL v2 or later)
