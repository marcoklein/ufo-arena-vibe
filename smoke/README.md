# Tests & tooling

Everything here is test-only. The game itself is `../index.html` + `../main.js` +
`../audio.js` + `../maze.js` + `../themes.js` + `../save.js`, with no build step and
no dependencies to install.

Start the dev server first, then play at <http://127.0.0.1:8000>:

```
python3 -m http.server 8000 --bind 127.0.0.1
```

## 1. Level generation and collision — `../test.mjs`

Pure Node, no browser, no stubs. Generates levels at several sizes and checks
the start/exit are open and connected, and a 60k-move random walk never leaves the
craft buried in a wall. The edge of the map is a band of nothing rather than a
wall: the border cells are holes, the craft can fly out over them (and off the map
there is no ground at all), anything that walks is still stopped, and the room you
start in is always at least 8x8 cells so the chase camera has somewhere to sit
behind the craft.

```
node test.mjs
```

It also checks the two levels and the holes in them:

* the raised decks (a run of low blocks is what the craft drives on up there, and
  the gaps between them are what it hovers over) stay inside rooms with a cell to
  spare at every edge, never on a doorway approach, never on the start or exit
  cell, and at least one lift pad stands beside one;
* a vault is a ring of blocks round a 3x3 courtyard with a lift pad in the middle:
  the only way in is to hover over the ring, the courtyard is a full 3x3 of open
  floor, and the pad has a cell of open floor on every side - so it can always be
  driven off, which is what lets it re-arm. A pad that could not be driven off (a
  one-cell pocket) used to strand the craft inside it;
* a hole is not a wall: it is a cell with no ground. `hitsWall` (the craft) lets
  it through, `hitsGround` (anything that walks) does not, and `holeAt` says it is
  a hole. Room holes keep a cell clear of every room edge; a *void* run is a
  corridor segment with no floor at all, taken only if the walk from the start
  survives it - so a void is a shortcut or a risk, never the only road;
* a roof is a tunnel: solid in the level above, open on the floor, and never over
  a hole or a pad. There are more of them the bigger the map, because they are what
  stops the level above from being a free flight path over everything;
* the pads themselves are one and up per level, each on open floor with a 3x3 of
  room around it (the four sides at the very least), in its own cell, not on the start or the exit, reachable on foot, and
  one of them a short run from the exit. The level that introduces the lift also
  gets a pad (and a small deck) in the room you start in;
* a *void floor* level (the warden level) has almost no floor at all: the floor
  survives only in the start room and the exit room, the start and exit cells
  themselves always have ground, the floor walk from the start never leaves the
  start room, no courtyard is cut into it, and a raised road of blocks runs from
  the start cell to the exit cell at block level - so the level above is the only
  way across, and there is a pad within reach of the start to get up there.

Every level also has a *character*: a `tower` value from 0 to 1 that decides how
much of the rock stands up into towers (7.5 units) and monoliths (12.5 - taller
than the camera, so you cannot see over them) and how many of the halls get
columns. It swings from one extreme to the other deterministically per level, so
some levels are wide open and some are a canyon of walls to thread. The first two
stay open.

And some levels are a *place* rather than a bigger number (see the gameplay
section): the floor taken away, a warren of small cells, every corridor roofed in,
all the hunters in one hall, or a blackout. `warren` and `roofed` are the two
options the maze module takes for those (a warren is carved from 4-5 cell rooms,
a roofed level puts a tunnel over every corridor cell and cuts no corridor holes,
because there is nothing left to roof one with).

The first two levels are built with two rooms and nothing else, so the first
lesson has nowhere to hide.

### Saved progress — `../save.js`

Pure and storage-agnostic: `readSave`/`writeSave` take the store they work on, so
the Node tests drive them with a fake one and the game drives them with
`localStorage` (falling back to an in-memory store if the browser refuses storage,
because a refused save must never stop the game from starting). What is kept is the
highest level reached, the level last played, and the kills that got you there,
under a version tag so later additions can read an older save. Anything unreadable,
truncated or hand-edited reads as an empty save rather than throwing mid-level.

`test.mjs` checks the parsing, that `best` only ever goes up (and that the score
that set it travels with it), the store round trip, and both refusal paths.

### Monsters never change — a rule

A monster type has one set of numbers, in `ENEMY_SPEC`, and no level may touch it:
the same hit points, speed, rate of fire, damage and knock wherever it turns up,
and the same on level 18 as on level 1. What a level decides is *where* things
stand and how many there are. A warden that hits you gently on one level is not a
thing that can exist - what you learn about a monster has to hold everywhere. The
Node gameplay test walks every type over fifteen levels and checks that all of them
report one and the same stat line, and that the roles (a guard holding a post, a
spitter rooted on a block) change placement only.

## 2. Gameplay in Node — `smoke/run.mjs`

Boots the **real** `main.js` against a stubbed three.js (`three-mock.js`, wired
up by `loader.mjs`) and a fake DOM, then drives the actual game loop with
scripted input: drives, turns, shoots, kills a monster, arms a mine and eats the
blast (at that range it is instant death now, and backing out of the kill ring is
the only way to survive one), parks on top of one and watches it go off on the spot,
walks out of one and does not, knocks a spitter's seed and a warden's glob out of
the air with its own gun and checks that neither reaches the hull, shoots a spawner
to pieces and checks that it comes apart, goes quiet and never opens again, gets
into a vault courtyard, takes the pad out, comes
back down inside it and checks the pad re-arms so it can leave again, rides a lift
pad up one level and checks what that level does (low blocks
underneath, walls still in the way, the hover meter draining over open floor and
filling on a block top, shots and globs carrying the level they are fired on, a
mine underneath that cannot latch on, the thruster lit only while it is paying to
stay up), meets the garrison up there and checks that it sleeps while the craft is
on the floor, that the wardens wake and the spitters standing on the blocks only
ever shoot at their own level, that a shell drinks the hover, goes off like a mine
and throws the craft back hard, wakes a shade and then walks out of its reach
to watch it give up, counts what the spitters are carrying, walks the whole
ladder (level 1 is six red diamonds in two rooms, 2 adds spitters, 3 the shade, 4
the lift and a pad where you start, 5 a single spawner standing between the craft
and the exit, 6 the warden with the floor taken away - ten wardens on the road, no
floor monsters, no spawners, a pad to get up and a road of blocks from the start to
the exit), walks the places (7 a warren of small cells, 8 roofed in over every
corridor with the level above solid and the floor open, 9 an arena with every
hunter in one hall and the rest of the level empty, 10 a blackout with a weaker,
shorter lamp and nearer fog, and 11 and 13 showing that the places come round
again deeper in),
drives onto a hole and checks the same meter holds it up on the floor as one level
up and that running dry drops it out of the world, flies out over the rim of the
map and checks there is no way back, checks that a tunnel is open underneath and
solid above, that no mote drifts through the hull, checks that the score is only
poked by things worth scoring, reaches the exit, advances a level, dies and
restarts **on the level it died on**, presses F for fullscreen, and drives the start
screen: a save with nothing in it offers a plain start, playing writes the level
into `localStorage`, the best never goes down, the kills that set the record are
kept with it, Enter carries on at the deepest level reached, New game starts at
level 1 without losing the record, and Enter on the results card comes back to the
start screen.

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
node smoke/shot.mjs smoke/out/mine.png  "&pose=mine"     # a red diamond, spiked and blinking
node smoke/shot.mjs smoke/out/fuse.png  "&pose=fuse"     # caught in one when it arms
node smoke/shot.mjs smoke/out/blast.png "&pose=blast"    # ...and the moment it goes off
node smoke/shot.mjs smoke/out/pad.png    "&pose=pad"       # a lift pad and its level marker
node smoke/shot.mjs smoke/out/block.png  "&pose=block"     # up one level, over a block top
node smoke/shot.mjs smoke/out/run.png    "&pose=run"       # a raised run seen from the floor
node smoke/shot.mjs smoke/out/warden.png "&pose=warden"    # a warden charging a glob
node smoke/shot.mjs smoke/out/hover.png  "&pose=hover"     # the thruster under a hovering craft
node smoke/shot.mjs smoke/out/volley.png "&boom=volley"      # your bolts in the air
node smoke/shot.mjs smoke/out/seeds.png  "&boom=seeds"       # a spitter with a seed out
node smoke/shot.mjs smoke/out/boom-enemy.png "&boom=enemy"   # freeze mid-fireball
node smoke/shot.mjs smoke/out/boom-player.png "&boom=player" # the craft going up
```

Poses: `none`, `enemy`, `exit`, `prop`, `tour` (a wide look over the whole level,
for judging a level's palette at a glance), `void` (the void level from above: the
road of blocks and the holes either side), `lurk` (a shade still asleep), `shade`
(a shade awake and hunting), `rift`, `mine`, `fuse` (mid-fuse, kill ring out),
`blast` (the instant after a mine goes off), `pad` (a lift pad from the floor),
`block` (the craft up one level, standing over a low block), `run` (a raised run
from the floor, so both levels are in one frame), `warden` (up on the block level
with a warden, caught winding a glob up), `hover` (up on the block level with the
meter running, so the thruster is lit), `pit` (a hole in the floor, a few paces
ahead), `pitair` (standing on a deck at the lip of a hole), `holeTop` (straight
down over a hole: the flat black square and its lip), `tunnel` (down under a roof,
where the level above is closed), `spawners` (the introduction level, with its one
spawner opening in front of the craft), `edge` (inside the map, looking out over the
rim of nothing), `vaultTop` (straight down over a courtyard: the ring, the floor and
the pad in the middle). Extras: `&menu` (keep the start screen up for the probe
instead of starting a level), `&best=N&kills=M` (seed a save before the game reads
it, so the start screen can be probed and photographed with something to continue
from), `&boom=enemy|player`
(detonate and freeze mid-blast), `&range=N` (how far away the kill happens),
`&keys=1` (report the yaw swing of a scripted drive-and-steer), `&hunt=1` (wake a
shade), `&mine=1` (arm a red diamond, see the fuse, then the damage it did),
`&audio=1` (bring the audio up on a key press and report what it did),
`&boom=volley` (hold fire with a bolt clear of the craft's own glow) and
`&boom=seeds` (wait for a spitter's chamber to light up, then hold the frame until
the seed it spits is in the air), `&lift=1` (take a pad up one level and report the
level: altitude, meter, whether a block is underneath, whether a wall still blocks,
and what the wardens up there are doing),
`&holes=1` (drive onto a hole and report that it is open, that there is no ground,
that the thruster is holding the craft up and what the HUD says),
`&settle=N` (let the level run by itself for N frames before the probe reads it).
`&level=N` picks the level a pose or probe runs on; without it the pose picks the
level that introduces what it shows (a spitter on 2, a shade on 3, a lift pad on
4, spawners on 5, a warden on 6). The first two levels, and the spawner level,
start with the craft pointing at the exit. The probe reports `shots` (how many of each kind
are in the air), the ladder (what is unlocked and how many of each), the upper
level (holes, voids, roofs, vaults, decks, pads, the rim, the towers and monoliths
and how far the nearest pad is from the start), the start room's size, how far the chase camera actually got
from the craft (`camDist`: a room too small shows up as a camera jammed against the
saucer), the dust pocket, the arrival tip and the hint line, and the start screen
(`menu`, what the save holds, the raw `localStorage` entry, the two buttons and what
they say).

Every level also has a *palette*: the rock, the level above, the glowing trim, the
floor light, the fog and the tower lights all move together, and each level dresses
its rooms from two or three themes rather than all six, so one level is a green
level, the next is ember and the one after is louder than both. It is a fixed cycle
from level 3 on (levels 1 and 2 keep the plain slate look), so consecutive levels
never share one, and it is deterministic: a level number always looks the same.
Each palette also picks what sits on top of the rock - a full glowing cap of trim,
a thin rim, or nothing at all - because a bright little square on every single wall
cell is one look, not every look.

The craft's lamp holds its brightness and stops at its reach rather than falling
off with distance: a light bright enough to reach across a room is about twenty
times brighter three units away, which is what used to paint every flat top white.
The sky the metals reflect is dim, and a place can turn the lamp down further (the
blackout level is the palette with the lamp halved and the fog pulled in). The probe
reports `place` and `lamp` (intensity, reach, fog).

## 5. Sound — `smoke/audio.mjs` (+ `smoke/audio.html`)

The score and every effect are synthesised at runtime (see `../audio.js`): no
sample library, no engine, nothing downloaded. Two layers check it:

```js
node smoke/audio.mjs          # measure levels, panning, mute, and the live game
node smoke/audio.mjs --json   # the same numbers, raw
```

It renders the real voices through an `OfflineAudioContext` and reports RMS and
peak per sound, per level, for each channel — so "is it audible, does it change
per level, does the pan work, does mute silence it" are all numbers, not opinions.
It also renders the score on a scripted timeline of pokes (`pokes: [[seconds,
amount]]`) and traces the level second by second, which is how the music is
checked to come in on action, play a phrase, and then stop again.
Then it opens the **real game** in a real Chrome over the DevTools protocol,
presses a key for the autoplay gesture, and samples the mixer's master bus in
real time to prove that sound actually leaves the game.

This one drives Chrome over CDP rather than using `--dump-dom` with a virtual
time budget: the virtual clock fast-forwards to the end of the budget while the
audio thread is still rendering, so the page gets dumped mid-measurement.

`&audio=1` in `smoke/browser.html` is the live half that does fit the
`--dump-dom` style: does the engine come up on a gesture, does the score run on
its own clock, does `M` silence it and does the HUD say so.

## 6. Trusted key events — `smoke/cdp.mjs`

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

## 7. Level map — `smoke/map.html`

Draws the generated layout flat so the shape of a level can be judged at a
glance: rooms outlined in their theme colour, corridors in grey, dead ends
visible, start green, exit gold. Both levels are in it: the raised decks (the
block tops that make up the level above the floor) in gold, the lift pads as cyan
rings (violet for the one in a vault), vault pockets in magenta, holes as pure
black with only the lip drawn, and tunnels as a short bar across the corridor.
Needs the dev server.

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
UFO.shades, UFO.hunted, UFO.rifts, UFO.riftsOpened, UFO.debris, UFO.splats, UFO.keys
UFO.mine, UFO.blastAt(d), UFO.audio
UFO.pads, UFO.blocks, UFO.highWalls, UFO.wallTopAt(x, z), UFO.blockedAt(x, z)
UFO.lift, UFO.alt, UFO.charge, UFO.liftUp, UFO.onBlock, UFO.liftCfg
UFO.wardens, UFO.levelNow       // the thing up top, and which level the craft is on
UFO.hoverFx                     // the thruster: visible exactly while it is paying to stay up
UFO.pits, UFO.rim, UFO.voids, UFO.roofs, UFO.vaults, UFO.holeAt(x, z), UFO.overHole
UFO.towerness, UFO.towers, UFO.monoliths   // this level's character
UFO.camPos                      // where the chase camera ended up (is it jammed?)
UFO.falling                     // > 0 while it is dropping out of the world
UFO.dust, UFO.dustBubble        // the motes, and the pocket kept clear round the craft
UFO.ladder, UFO.tip, UFO.controlsHint
UFO.riftsOpened, UFO.riftsClosed   // how many tears have opened and been torn down
UFO.shot(kind, x, z, vx, vz, level)  // put a shot in the air where a test wants one
UFO.startCell                   // the cell the run starts on
UFO.place                       // which place this level is, if it is one
UFO.lamp                        // what the level's light is doing (intensity, reach, fog)
UFO.start(n)                    // jump straight to a level, past the menu (the tests use this)
UFO.save, UFO.inMenu, UFO.menuChoice, UFO.toMenu(), UFO.choose(n)   // saved progress
UFO.cam(x, y, z, tx, ty, tz)    // test-only camera override for a still, UFO.camOff()
UFO.despawn(e)                  // quietly remove one enemy (test scaffolding)
UFO.bullets[0].level            // every shot carries the level it was fired on
UFO.move(x, z), UFO.aim(x, z), UFO.damage(n), UFO.kill(), UFO.killPlayer(), UFO.stuckAt(x, z)

// sound
UFO.audio.state, UFO.audio.muted, UFO.audio.log, UFO.audio.arrangement
UFO.audio.stats()            // context state, level, hunt, voices written
UFO.audio.peak()             // loudest sample on the master bus in the last ~46ms
UFO.audio.toggleMute(), UFO.audio.sfx(name, { x, z }), UFO.audio.music({ level })
UFO.audio.poke(0.4)          // something happened: let the score hear about it
UFO.audio.energy             // how much is going on (0..1); the music lives off it
UFO.audio.stats().playing    // is the score playing right now, and at which tier
```
