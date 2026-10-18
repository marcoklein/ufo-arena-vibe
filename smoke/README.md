# Tests & tooling

Everything here is test-only. The game itself is `../index.html` + `../main.js` +
`../maze.js`, with no build step and no dependencies to install.

Start the dev server first, then play at <http://127.0.0.1:8000>:

```
python3 -m http.server 8000 --bind 127.0.0.1
```

## 1. Level generation and collision — `../test.mjs`

Pure Node, no browser, no stubs. Generates levels at several sizes and checks
the walls enclose the space, start/exit are open and connected, and a 60k-move
random walk never leaves the craft buried in a wall.

```
node test.mjs
```

## 2. Gameplay in Node — `smoke/run.mjs`

Boots the **real** `main.js` against a stubbed three.js (`three-mock.js`, wired
up by `loader.mjs`) and a fake DOM, then drives the actual game loop with
scripted input: drives, turns, shoots, kills a monster, takes contact damage,
reaches the exit, advances a level, dies and restarts.

```
node --import ./smoke/loader.mjs smoke/run.mjs
```

## 3. Gameplay in a real browser — `smoke/browser.html`

Loads the real markup, styles and three.js from `../index.html`, renders real
WebGL frames, and reports the result in a `<pre id="probe">`. Needs the dev
server running and Chrome; see `smoke/shot.mjs` for the invocation.
## 4. Screenshots — `smoke/shot.mjs`

Headless `--screenshot` cannot composite WebGL, so this renders a frame, reads
the canvas back with `toDataURL()`, and writes a PNG into `smoke/out/` (which is
generated output and not tracked by git).

```
node smoke/shot.mjs smoke/out/arena.png                  # craft in the arena
node smoke/shot.mjs smoke/out/enemy.png "&pose=enemy"    # parked next to a monster
node smoke/shot.mjs smoke/out/exit.png  "&pose=exit"     # the exit beacon
node smoke/shot.mjs smoke/out/prop.png  "&pose=prop"     # a themed room's wall props
node smoke/shot.mjs smoke/out/shade.png "&pose=shade"    # a shade closing in
node smoke/shot.mjs smoke/out/rift.png  "&pose=rift"     # a monster spawn point
node smoke/shot.mjs smoke/out/boom-enemy.png "&boom=enemy"   # freeze mid-fireball
node smoke/shot.mjs smoke/out/boom-player.png "&boom=player" # the craft going up
```

Poses: `none`, `enemy`, `exit`, `prop`, `lurk` (a shade still asleep), `shade`
(a shade awake and hunting), `rift`. Extras: `&boom=enemy|player` (detonate and
freeze mid-blast), `&range=N` (how far away the kill happens), `&keys=1` (report
the yaw swing of a scripted drive-and-steer), `&hunt=1` (wake a shade),
`&ram=1` (run a red diamond into the hull and report what it cost), `&settle=N`
(let the level run by itself for N frames before the probe reads it).

## 5. Trusted key events — `smoke/cdp.mjs`

Synthetic `KeyboardEvent`s never touch the browser's own key handling, so they
cannot reproduce a key the browser swallows before the page sees it. This drives
a real Chrome over the DevTools protocol with `Input.dispatchKeyEvent`, which
goes through the same path as a physical key press:

```
node smoke/cdp.mjs "KeyW,Space,ArrowLeft"
HEADFUL=1 node smoke/cdp.mjs "Space,ArrowLeft"   # a real (off-screen) window
```

It prints the events the page received, the held-key set and the yaw swing, which
is how the "left arrow while holding space" report was pinned down to the
keyboard's rollover rather than the game.

## 6. Level map — `smoke/map.html`

Draws the generated layout flat so the shape of a level can be judged at a
glance: rooms outlined in their theme colour, corridors in grey, dead ends
visible, start green, exit gold. Needs the dev server.

```
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --no-sandbox --window-size=960,1000 \
  --screenshot=smoke/out/map-8.png \
  "http://127.0.0.1:8000/smoke/map.html?level=8"
```

## Debug handle

`main.js` exposes `window.UFO` in the browser console:

```js
UFO.level, UFO.hp, UFO.kills, UFO.monsters, UFO.state
UFO.enemies, UFO.bullets, UFO.pos, UFO.exit, UFO.yaw
UFO.rooms, UFO.props, UFO.stats, UFO.explosions, UFO.particles
UFO.shades, UFO.hunted, UFO.rifts, UFO.riftsOpened, UFO.gore, UFO.splats, UFO.keys
UFO.move(x, z), UFO.aim(x, z), UFO.damage(n), UFO.kill(), UFO.killPlayer(), UFO.stuckAt(x, z)
```
