# Icaro Engine

A Three.js-based Quake engine port, forked from [three-quake](https://github.com/mrdoob/three-quake).

### Assets

Shareware `pak0.pak` included (Episode 1).  
For the full game, copy `pak1.pak` from the `id1` folder of a registered copy of Quake to `static/pak1.pak` (lower case).
The client and the room server load `pak0.pak`, `pak1.pak`, ... until one is missing.
Registered data must not be committed or deployed publicly; `.gitignore` excludes `static/pak1.pak`.

### License

Code: GPL v2

### Credits

- Original game by id Software ([source](https://github.com/id-Software/Quake))
- Original Three.js port (`three-quake`) by [@mrdoob](https://github.com/mrdoob) with [@claude](https://github.com/claude)
