# Plan: Top-Down 3D Maze Game (Browser)

A small, top-down 3D maze. The player controls a **sphere** that rolls around a
grid, avoiding walls, and reaches an exit. Runs entirely in the browser.

- **Library:** Three.js `0.186.1` (ES modules via CDN + import map)
- **Scope:** Single-page game, no build step, no server required
- **Estimated size:** ~200–250 lines of JS across 2 files
- **Difficulty:** Easy (see "Why this is easy" below)

---

## 1. Game design

| Element | Decision |
|---|---|
| Perspective | Top-down (camera above the maze, angled slightly for 3D depth) |
| Player | A sphere (`SphereGeometry`) that rolls |
| Movement | Continuous — hold keys to move (WASD **and** arrow keys) |
| Maze | Defined as a 2D array of strings; walls = `#`, floor = `.`, start = `S`, exit = `E` |
| Collision | Axis-separated AABB vs. wall-grid cells (sphere slides along walls) |
| Win | Sphere center reaches the exit cell → overlay "You win!" |
| Camera mode | **Fixed**, framed to show the whole maze (optional follow-cam later) |

### Controls
- `W` / `↑` — move away from camera (up the board)
- `S` / `↓` — move toward camera
- `A` / `←` — left
- `D` / `→` — right
- `R` — reset level

---

## 2. Why this is easy

Everything maps to a handful of Three.js primitives:

| Piece | Three.js API |
|---|---|
| Scene / camera / renderer | `Scene`, `PerspectiveCamera`, `WebGLRenderer` |
| Floor | `PlaneGeometry` (rotated flat) |
| Grid lines | `GridHelper` |
| Walls | `BoxGeometry` meshes (one per wall cell) |
| Player | `SphereGeometry` + `Mesh` |
| Lighting | dark arena: `AmbientLight` (faint) + player-carried `PointLight`; emissive ball |
| Loop | `renderer.setAnimationLoop(...)` |

The only non-trivial piece is collision, and the grid makes that trivial — we never
need a physics engine.

---

## 3. File structure

```
3_d_test/
├── index.html      # canvas, import map, HUD overlay
├── main.js         # Three.js scene + game loop
├── maze.js         # maze data + collision (no Three.js dep, node-testable)
├── test.mjs        # node test.mjs  → collision + traversability checks
└── PLAN.md         # this file
```

Optional split later: `player.js` (movement/camera tuning).

### index.html sketch
```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Maze</title>
    <style>/* fullscreen canvas + HUD overlay */</style>
    <script type="importmap">
      { "imports": { "three": "https://unpkg.com/three@0.186.1/build/three.module.js" } }
    </script>
  </head>
  <body>
    <div id="hud">WASD / arrows to move · R to reset</div>
    <div id="win" hidden>You win!</div>
    <script type="module" src="./main.js"></script>
  </body>
</html>
```

---

## 4. Coordinate system & data model

- `CELL` = 4 world units. World X = `col * CELL`, world Z = `row * CELL`.
- Y is up. The sphere sits at `y = radius` so it rests on the floor.
- Sphere radius ≈ `1.3` (must stay < `CELL / 2` so it can pass corridors).

Maze data (readable, easy to edit):
```js
const MAZE = [
  "#########",
  "#S..#...#",
  "#.#.#.#.#",
  "#.#...#.#",
  "#.#####.#",
  "#.......#",
  "#.#####E#",
  "#########",
];
```
Parsed once into:
- `walls`: `Set<"col,row">` for O(1) lookup
- `start`, `exit`: `{ col, row }`
- `bounds`: maze width/height in cells (for camera framing)

---

## 5. Core algorithms

### 5a. Movement with axis-separated collision
```js
const speed = 12;           // units / second
const keys = new Set();     // keydown/keyup

function update(dt) {
  let dx = 0, dz = 0;
  if (keys.has("ArrowUp")    || keys.has("KeyW")) dz -= 1;
  if (keys.has("ArrowDown")  || keys.has("KeyS")) dz += 1;
  if (keys.has("ArrowLeft")  || keys.has("KeyA")) dx -= 1;
  if (keys.has("ArrowRight") || keys.has("KeyD")) dx += 1;

  // normalize so diagonal isn't faster
  if (dx || dz) {
    const len = Math.hypot(dx, dz);
    dx = (dx / len) * speed * dt;
    dz = (dz / len) * speed * dt;
  }

  // move each axis independently -> slides along walls
  if (!hitsWall(pos.x + dx, pos.z)) pos.x += dx;
  if (!hitsWall(pos.x, pos.z + dz)) pos.z += dz;

  sphere.position.set(pos.x, RADIUS, pos.z);
  rollSphere(dx, dz);   // cosmetics: rotate sphere to look like rolling
}
```

### 5b. Wall test
Treat the player as a circle of radius `R`. Check every wall cell whose AABB is
within `R` of the new position:
```js
function hitsWall(x, z) {
  const c0 = Math.floor((x - R) / CELL), c1 = Math.floor((x + R) / CELL);
  const r0 = Math.floor((z - R) / CELL), r1 = Math.floor((z + R) / CELL);
  for (let c = c0; c <= c1; c++)
    for (let r = r0; r <= r1; r++)
      if (walls.has(`${c},${r}`)) return true;
  return false;
}
```
(Good enough for a grid maze; blocks corners cleanly because corridors are wide.)

### 5c. Win check
```js
const exitWorld = { x: exit.col * CELL, z: exit.row * CELL };
if (Math.hypot(pos.x - exitWorld.x, pos.z - exitWorld.z) < CELL * 0.4) win();
```

---

## 6. Build milestones (checklist)

1. **Scaffold** — `index.html` + import map + empty canvas + render loop.
2. **Scene** — camera (top-down, framed to maze), lights, floor plane, `GridHelper`.
3. **Maze render** — parse `MAZE`; spawn a `Box` per wall cell (use `InstancedMesh`
   or a merged geometry for cleanliness); start marker + exit marker (colored tile).
4. **Player** — sphere mesh resting on the floor.
5. **Input** — keydown/keyup tracking + movement **without** collision (verify feel).
6. **Collision** — add `hitsWall` and axis-separated movement.
7. **Win state** — detect exit, show overlay, freeze input, `R` resets.
8. **Polish** — shadows, materials, HUD text, camera framing, sphere roll animation.
9. **Verify** — open `index.html`, play through the maze start → exit.

### Stretch goals (only if wanted)
- Follow camera that tracks the sphere
- Timer / move counter, best-time in `localStorage`
- Multiple levels + level progression
- Keyboard-grid (tile-snap) movement mode instead of continuous
- Collectible pickups, keys, or a minimap
- Sound effects

---

## 7. Decision points (defaults chosen, override if you like)

| Decision | Default | Alternative |
|---|---|---|
| Camera | Fixed, shows whole maze | Follow-cam behind the sphere |
| Movement | Continuous + slide | Tile-snapped (one cell per tap) |
| Projection | Perspective (3D look) | Orthographic (true flat top-down) |
| Delivery | 2 files, no build step | Vite project, `npm install three` |
| Serving | Open `index.html` directly | `python3 -m http.server` (needed if modules block `file://`) |

> Note: ES-module import maps work over `file://` in most browsers, but if the
> browser blocks it, run `python3 -m http.server` in the project folder and open
> `http://localhost:8000`.
