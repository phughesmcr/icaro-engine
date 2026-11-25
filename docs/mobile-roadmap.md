# Mobile roadmap

Goal: make Icaro the most mobile-friendly Quake engine. This is a snapshot
taken against `dev` at 1d933a6 (2026-11-25). Check claims against the code
before relying on them.

## How it was made

Five read-only explorers each took one angle: controls and HUD, rendering and
thermals, delivery and offline, lifecycle and networking, and the competitive
landscape. A sixth pass ran the client in Chromium with mobile emulation
(Pixel 8 UA, touch, DPR 2) in portrait 375x812 and landscape 740x360. That
pass inspected the DOM and engine state from JavaScript (control layout,
canvas sizes, `e1m1` loading); nobody looked at the rendered frames.
Emulation is not a device. Nothing here was tested on a real phone.

Every code path in the "Confirmed bugs" table was checked against the code.
Where the bug needs a device event to trigger (an iOS interruption, a
dropped socket, context loss), the trigger is assumed, and the table says
so. Browser-support and competitor claims are unverified unless a source
is given. The explorers mostly could not fetch primary sources.

Everything proposed is web-layer or opt-in. None of it changes NQ server
physics or the C-faithful defaults. Any item that adds behaviour the C lacks
is marked **deviation** and needs the usual comment and PR note.

## What already exists

- `src/touch.js`:
  - floating nipplejs move stick and drag-to-look;
  - FIRE and JUMP hold buttons that also aim while held;
  - weapon next/prev and a pause/menu button;
  - gyro aim with the iOS permission flow;
  - Android haptics;
  - cvars: `touch_sensitivity`, `touch_size`, `touch_opacity`,
    `touch_lefthanded`, `touch_gyro`, `touch_gyro_sensitivity`,
    `touch_haptics`;
  - safe-area insets;
  - wake lock;
  - fullscreen and landscape lock on the first tap;
  - menu tap-to-select and drag-for-arrows;
  - a sys bar with Back and an on-screen keyboard.
- `src/in_web.js`: standard-mapping gamepad with Ironwail `joy_*` deadzone and
  curve cvars, and visibility handling that blocks sound and clears input.
- `src/snd_dma.js`: audio unlock on gesture, and block/unblock on visibility.
- `host_maxfps` 72 cap. The `setAnimationLoop` callback returns early
  between frames.
- `src/pak.js`: lazy HTTP Range reads for paks over 64 MB.
- `manifest.webmanifest`: display fullscreen, landscape, and a 512 icon.
  `index.html` sets Apple web-app tags and `viewport-fit=cover`.
- `?room=` survives in the URL, so a reload rejoins a multiplayer room as a
  new client.

## Confirmed bugs

| # | Bug | Evidence | Effort |
|---|-----|----------|--------|
| B1 | After a call, Siri or an alarm, iOS leaves the AudioContext `interrupted`. `S_UnlockAudio` resumes only `suspended`, so taps never bring sound back. Only a hide/show cycle does (`S_UnblockSound` handles every state). No `statechange` listener. Code confirmed; the iOS state is assumed. | `src/snd_dma.js:233`, `:277` | S |
| B2 | A dropped connection (iOS freezes a background page, or Wi-Fi changes to cellular) calls `Host_Error` and drops the player to the menu. There is no rejoin. `pagehide` sends `clc_disconnect` and has no `pageshow` counterpart. Code confirmed; iOS socket behaviour assumed. | `src/cl_main.js:1418`, `src/net_websocket.js:243`, `src/net_webtransport.js:257` | M |
| B3 | List menus (Options, Load/Save, Touch Controls, Advanced) use 8-unit rows, about 11-12 CSS px on phones: `_uiScale = floor( physH / 240 )` gives 3 at 740x360 DPR 2. `M_RowAt` maps a tap to the exact row, so a slightly-off tap selects the neighbour. The Main, Single Player and Multiplayer menus use 20-unit rows (about 30 CSS px) and are fine. | `src/gl_draw.js:129`, `src/menu.js:3657-3678` | M |
| B4 | Move-stick speed ramps to 1x, then jumps to 2x (`cl_movespeedkey`) at the run threshold. There is no steady fast walk, and a slight overshoot lurches. | `src/touch.js:1013-1032` | S |
| B5 | The touch overlay stays up while a gamepad (Backbone, Kishi) drives, covering the HUD. Only a mouse pointer switches touch mode off (`handlePointerDown`/`handlePointerMove`); gamepad input doesn't, and there is no `gamepadconnected` listener. | `src/in_web.js:1339-1365`, `:383` | S |
| B6 | No WebGL context-loss handling. If the browser drops the context, the screen goes black until a reload. Lightmaps, the screenwarp framebuffer and `depthRange` state need re-upload on restore. Code confirmed; how often mobile browsers drop the context is assumed. | none in `src/`. `src/vid.js:211`, `src/gl_rsurf.js:2458`, `src/gl_screenwarp.js:165` | M |
| B7 | Portrait plays without a prompt. Orientation lock is only requested with fullscreen, which iPhone Safari tabs are believed not to support (unverified). FOV is vert-locked at 4:3 (`fov_y` ≈ 73.7°), so a 375x812 portrait view gets about 38° horizontal FOV. | `src/gl_screen.js:478-479`, `src/touch.js:1346` | S (prompt) |
| B8 | Nit: `touch_size` clamps to 2 but the menu slider stops at 1.6. | `src/touch.js:311`, `src/menu.js:2197` | S |

## Gaps confirmed absent (grep of `src/`, `main.js`)

- service worker or Cache API;
- IndexedDB or OPFS;
- `navigator.storage.persist`;
- `webglcontextlost`;
- `renderer.compile` or `compileAsync`;
- `gamepadconnected`;
- AudioContext `statechange`;
- file picker or drag-and-drop for paks;
- automatic rejoin after a dropped connection (the C `reconnect` command exists, `src/host_cmd.js:66`, but only resets the signon).

## Roadmap, ranked by impact over effort

### Tier 1: quick wins (S)

1. **Fix iOS audio after interruptions (B1).** Resume on any state other
   than `running` or `closed`, and add a `statechange` listener. Deviation:
   web-only.
2. **Pause on hide in single player** (open the menu or set `sv.paused`).
   The loop already stops while hidden and frametime is clamped on return,
   but the player comes back straight into live action, often mid-fight
   after a notification. Deviation.
3. **Cap DPR on touch devices.** Set `min( devicePixelRatio, 2 )` by
   default with a cvar, and apply the same cap to the 2D overlay canvas
   (`src/vid.js:224`, `:286`, `src/gl_draw.js:607`). A DPR-3 phone
   currently renders about 3M pixels per frame. This is likely the biggest
   battery and thermal cost. Deviation, like `?scale=`.
4. **Hide touch controls when a gamepad connects (B5)** and show them on
   the next touch. Add controller rumble through `vibrationActuator`
   (support on iOS unverified).
5. **Smooth the stick (B4).** Make speed continuous up to the run speed, or
   expose `cl_movespeedkey` in the touch menu.
6. **Call `navigator.storage.persist()`** on the first save. Configs and
   saves live only in localStorage (`src/cvar.js:33`,
   `src/host_cmd.js:1426`). Safari's 7-day script-storage cap can delete
   them for non-installed sites (unverified;
   https://webkit.org/blog/10218/).
7. **Portrait prompt (B7).** Show a "rotate your phone" overlay in portrait
   while in game. A horizontal FOV floor is the alternative, but that is a
   deviation.
8. **Complete the manifest:** `id`, `description`, a 192 icon, a maskable
   icon, `categories`, `screenshots`, `launch_handler`, and iOS
   `apple-touch-startup-image` splash screens.

### Tier 2: core mobile features (M)

9. **Offline PWA.** Add a service worker that precaches the shell, `src/`,
   `pak0.pak` and the version-pinned three and nipplejs (better, vendor
   them), and runtime-caches `maps/` and music. Repeat launches become
   instant and the game plays in airplane mode. (Whether Chromium still
   requires a service worker for its install prompt is unverified.) The Cache API can't serve Range requests, so cache a
   lazy pak whole or add a Range-from-cache handler.
10. **Touch-sized menus (B3).** Snap taps to the nearest item and add a
    touch-only scale for the 8-unit list menus. Lowering `scr_conheight`
    barely helps: it is floored at 200 (`src/gl_draw.js:160`).
11. **Direct weapon select.** Add a hold-to-open weapon wheel on the WPN
    button, or tap the status-bar weapon icons. Today only `impulse 10` and
    `impulse 12` cycle. The 2021 rerelease (per a Nintendo Life update
    article) and Quad Touch (per a forum post) reportedly have a wheel.
    The commands are C-faithful; the UI is a deviation.
12. **In-game overlay buttons** for quick save and quick load (C commands
    `save quick` and `load quick`), console and chat, and swim down
    (`+movedown`, C-faithful).
13. **Survive a lost connection (B2).** On `visibilitychange`, `pageshow` or
    `online`, if the player was in game and the connection is dead, show
    "Reconnecting…" and re-run `connect` to the same room. Fall back to
    `wss://` once if WebTransport fails to open (UDP blocked). The player
    gets a fresh slot: NQ has no identity resume, and server-side resume
    with score is a later L item. Deviation.
14. **Autosave on hide in single player** into a reserved slot, and offer
    "Continue" on the next load. iOS discards background tabs. Deviation.
15. **Context-loss recovery (B6).**
16. **Warm up shaders after map load.** Call `renderer.compileAsync` behind
    the loading screen, including the padded dlight buckets. The comment at
    `src/gl_rmain.js:1967` measured 20-250 ms hitches the first time each
    dlight bucket appears.
17. **Quality and battery presets:** one cvar setting DPR cap,
    `host_maxfps` (30 or 60), dlight bucket cap (`R_DlightBucket`,
    `src/gl_rmain.js:1999`), particle count and anisotropy. Shown in the
    menu. Deviation.

### Tier 3: differentiators (L)

18. **HUD layout editor with saved profiles.** Drag, resize and hide each
    button; add custom bindable buttons that run any command, for impulses
    and mod commands. CoD Mobile, PUBG Mobile, Fortnite and Delta Touch
    have one, per guides and store listings rather than official docs.
    This looks like Icaro's clearest gap against the field.
19. **Gyro modes.** Always on, only while touching the look area
    (Fortnite's model, ratchet-friendly), only while FIRE is held. Add a
    gyro dead zone and smoothing, as idTech4A++ did in 2026.
20. **Look curve.** A drag-look acceleration curve that scales with screen
    size, so a tablet needs no more finger travel than a phone.
21. **Bring your own data.** A file picker copies `pak1.pak`, mission packs
    or rerelease paks into OPFS or IndexedDB, mounted through a new
    `pak_reader_t`, with `Blob.slice` for the lazy path. This is the only
    legal route to registered Quake on a phone, because that data must
    never be hosted. Add save, config and demo export/import, and
    `navigator.share` for demos.
22. **Dynamic resolution.** Drive the scale from a frame-time EMA with
    hysteresis and coarse steps, hooked into `Host_Frame` and `VID_Resize`.
23. **Store wrappers.** A TWA for Play (needs item 9 and Digital Asset
    Links). Capacitor for the App Store, bundling only `pak0`. Check Apple
    guidelines 4.2 and 5.2 first.
24. **Aim assist slider.** Map a touch-menu setting onto server `sv_aim`
    values (a wider cone) rather than client-side magnetism, so the server
    stays NQ-faithful.

### Where Icaro can lead

- **Quake from a link.** Tap a URL, it installs and plays offline (item 9).
  Share a room link through `navigator.share` to invite a friend in one
  tap. No touch Quake surveyed does this; the touch-Quake ports found are
  Android apps that need user-supplied data.
- **One URL for touch, gamepad, gyro and WebXR.** `webxr.js` already
  exists.
- **Touch-native Quake movement aids** (deviations, opt-in). Examples: a
  bunny-hop or strafe-jump assist, a rocket-jump button. The survey found
  none in other products, but that is absence of evidence only.

## Unverified platform facts to check on devices

- **iOS WebTransport.** Safari 26.4 added WebTransport per WebKit's 26.4
  features post, but the platform list is unconfirmed. Older iPhones
  should fall back to WebSocket automatically (`NET_UseWebSocket`,
  `src/net_main.js:546`).
- **Fullscreen and orientation lock on iPhone.** The element Fullscreen
  API and orientation lock are believed unavailable in iPhone Safari, so
  Add to Home Screen is the only way to remove browser chrome.
- **Vibration on iOS.** `navigator.vibrate` is believed unsupported on iOS.
- **QUIC connection migration** across a Wi-Fi to cellular change in
  browser WebTransport: no source found.
- **Audio unlock.** iOS may accept the audio unlock only on `touchend`
  (today `src/in_web.js:1372` unlocks on `touchstart`).
- **Context loss.** Whether iOS drops the WebGL context in background or
  under memory pressure, and how often.

## Device test plan for any mobile PR

Test on an iPhone in Safari, both as a tab and from the Home Screen, and on
an Android phone in Chrome. On each:

- cold load on 4G;
- rotate the phone;
- play E1M1 for 5 minutes, then check heat and battery;
- take a phone call mid-game, then check sound;
- background the app for 10 s and for 5 min, in single player and in
  multiplayer;
- switch from Wi-Fi to cellular in multiplayer;
- pair a Bluetooth controller;
- tap each menu item.
