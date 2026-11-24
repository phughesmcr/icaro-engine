# Icaro Engine

A Three.js-based Quake engine port, forked from [three-quake](https://github.com/mrdoob/three-quake).

### Assets

Shareware `pak0.pak` included (Episode 1).  
For the full game, replace with your own `pak0.pak` from a registered copy of Quake.

### Mobile

On phones and tablets the game shows touch controls. Play in landscape.

- **Left side:** a floating move stick ([nipplejs](https://github.com/yoannmoinet/nipplejs), loaded from jsDelivr). Push it to the edge to run.
- **Right side:** drag to look. You can also drag on FIRE or JUMP to aim while holding them.
- **Buttons:** FIRE, JUMP, next and previous weapon, and pause (which opens the menu).
- **Menus and console:** tap menu items directly. While a menu or the console is open, a bar at the top gives you Back and a keyboard button.
- **Options → Touch controls:** look speed, gyro aiming, gyro speed, invert look, left-handed layout (swaps the sides and mirrors the buttons), button size and opacity, and vibration. Settings are saved as `touch_*` cvars, except Invert Look, which is `m_pitch`.
- **Gyro aiming:** off by default. On iOS, the motion permission prompt appears the first time you tap after turning it on.
- **Fullscreen on iPhone:** use Safari's *Add to Home Screen*. iOS doesn't allow fullscreen in a browser tab, but the installed app runs fullscreen.

### License

Code: GPL v2

### Credits

- Original game by id Software ([source](https://github.com/id-Software/Quake))
- Original Three.js port (`three-quake`) by [@mrdoob](https://github.com/mrdoob) with [@claude](https://github.com/claude)
