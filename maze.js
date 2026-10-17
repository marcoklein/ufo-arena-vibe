// Level generation + collision. No Three.js dependency, so it can be tested in Node.
//
// A level is a "rooms and corridors" layout: big rectangular rooms carved out of
// solid rock, joined by a branching network of wide and narrow corridors, with
// dead ends hung off the sides. Everything is deterministic for a seed, so a
// level number always produces the same map.

import { THEMES } from "./themes.js";

export const CELL = 4;       // world units per cell
export const RADIUS = 1.3;   // player radius
export const COLL = RADIUS;  // default collision radius

/* -------------------------------------------------------------------- rng */
export function makeRng(seed) {
  let a = (seed >>> 0) || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* -------------------------------------------------------------- carving */
function carveRect(grid, x, y, w, h) {
  const rows = grid.length;
  const cols = grid[0].length;
  const x1 = Math.min(cols - 2, x + w - 1);
  const y1 = Math.min(rows - 2, y + h - 1);
  for (let r = Math.max(1, y); r <= y1; r++)
    for (let c = Math.max(1, x); c <= x1; c++) grid[r][c] = ".";
}

function carveH(grid, x1, x2, y, w) {
  const cols = grid[0].length;
  const a = Math.max(1, Math.min(x1, x2));
  const b = Math.min(cols - 2, Math.max(x1, x2));
  const y0 = Math.max(1, Math.min(grid.length - 1 - w, y));
  for (let r = y0; r < y0 + w; r++)
    for (let c = a; c <= b; c++) grid[r][c] = ".";
}

function carveV(grid, y1, y2, x, w) {
  const rows = grid.length;
  const cols = grid[0].length;
  const a = Math.max(1, Math.min(y1, y2));
  const b = Math.min(rows - 2, Math.max(y1, y2));
  const x0 = Math.max(1, Math.min(cols - 1 - w, x));
  for (let r = a; r <= b; r++)
    for (let c = x0; c < x0 + w; c++) grid[r][c] = ".";
}

/* ------------------------------------------------------------- generation */
// A room and corridor dungeon. Rooms are carved first, then joined by an L of
// corridor; the join is a minimum spanning tree so every room is reachable,
// plus a handful of extra links so there is usually more than one way round.
// Corridors are deliberately a mix of 1 and 2 cells wide, and dead-end stubs
// are hung off them so the route to the exit is rarely obvious.
function generate(cols, rows, rng) {
  const grid = [];
  for (let r = 0; r < rows; r++) grid.push(new Array(cols).fill("#"));

  const rooms = [];
  const tries = cols * rows;
  const carveBudget = cols * rows * 0.45;
  let carved = 0;

  for (let i = 0; i < tries && carved < carveBudget; i++) {
    const w = 4 + Math.floor(rng() * 6); // 4..9 cells
    const h = 4 + Math.floor(rng() * 6);
    if (w > cols - 4 || h > rows - 4) continue;
    const x = 1 + Math.floor(rng() * (cols - 1 - w));
    const y = 1 + Math.floor(rng() * (rows - 1 - h));
    const overlaps = rooms.some(
      (o) => x < o.x + o.w + 1 && x + w + 1 > o.x && y < o.y + o.h + 1 && y + h + 1 > o.y
    );
    if (overlaps) continue;
    carveRect(grid, x, y, w, h);
    rooms.push({ x, y, w, h, cx: x + (w >> 1), cy: y + (h >> 1), pillars: false });
    carved += w * h;
  }

  if (rooms.length === 0) {
    const room = { x: 1, y: 1, w: cols - 2, h: rows - 2, pillars: false };
    room.cx = room.x + (room.w >> 1);
    room.cy = room.y + (room.h >> 1);
    carveRect(grid, room.x, room.y, room.w, room.h);
    rooms.push(room);
  }

  /* columns inside the bigger halls. Carved before the corridors so a corridor
     always wins and a pillar can never seal a doorway. */
  const stats = { rooms: rooms.length, roomCells: carved, links: 0, tight: 0, wide: 0, stubs: 0, pillarRooms: 0 };
  for (const room of rooms) {
    if (room.w < 7 || room.h < 7 || rng() < 0.35) continue;
    room.pillars = true;
    stats.pillarRooms++;
    for (let r = room.y + 2; r <= room.y + room.h - 3; r += 3) {
      for (let c = room.x + 2; c <= room.x + room.w - 3; c += 3) {
        if (Math.abs(c - room.cx) <= 1 && Math.abs(r - room.cy) <= 1) continue;
        grid[r][c] = "#";
      }
    }
  }

  /* --------------------------------------------------------------- links */
  const links = [];
  const linked = new Set();
  if (rooms.length > 1) {
    const edges = [];
    for (let i = 0; i < rooms.length; i++) {
      for (let j = i + 1; j < rooms.length; j++) {
        const dx = rooms[i].cx - rooms[j].cx;
        const dy = rooms[i].cy - rooms[j].cy;
        edges.push({ i, j, d: dx * dx + dy * dy });
      }
    }
    edges.sort((a, b) => a.d - b.d);

    const parent = rooms.map((_, i) => i);
    const find = (a) => {
      while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; }
      return a;
    };
    for (const e of edges) { // backbone: every room reachable, no loops yet
      const a = find(e.i);
      const b = find(e.j);
      if (a === b) continue;
      parent[a] = b;
      links.push(e);
      linked.add(`${e.i}:${e.j}`);
    }
    let extra = 0; // then a few shortcuts, so the map is not a tree
    const wantExtra = Math.max(1, Math.round(rooms.length * 0.3));
    for (const e of edges) {
      if (extra >= wantExtra) break;
      if (linked.has(`${e.i}:${e.j}`)) continue;
      if (rng() < 0.45) continue;
      links.push(e);
      extra++;
    }
  }

  const widen = (c, r, w) => {
    if (w === 1) carveRect(grid, c - 1, r - 1, 3, 3); // elbow room to turn
    else carveRect(grid, c, r, 2, 2);
  };

  for (const e of links) {
    const a = rooms[e.i];
    const b = rooms[e.j];
    const w = rng() < 0.62 ? 1 : 2; // most joins are single-cell squeezes
    stats.links++;
    if (w === 1) stats.tight++; else stats.wide++;
    if (rng() < 0.5 || a.cy === b.cy) {
      carveH(grid, a.cx, b.cx, a.cy, w);
      carveV(grid, a.cy, b.cy, b.cx, w);
      widen(b.cx, a.cy, w);
    } else {
      carveV(grid, a.cy, b.cy, a.cx, w);
      carveH(grid, a.cx, b.cx, b.cy, w);
      widen(a.cx, b.cy, w);
    }
  }

  /* ----------------------------------------------------------- dead ends */
  const inBounds = (c, r) => c > 0 && r > 0 && c < cols - 1 && r < rows - 1;
  const stubs = 2 + Math.floor(rooms.length * 1.3);
  for (let s = 0; s < stubs; s++) {
    let c = 0;
    let r = 0;
    let found = false;
    for (let t = 0; t < 30 && !found; t++) {
      c = 2 + Math.floor(rng() * (cols - 4));
      r = 2 + Math.floor(rng() * (rows - 4));
      found = grid[r][c] !== "#";
    }
    if (!found) continue;
    stats.stubs++;
    let dir = Math.floor(rng() * 4);
    const len = 3 + Math.floor(rng() * 7);
    const w = rng() < 0.55 ? 1 : 2;
    for (let k = 0; k < len; k++) {
      if (rng() < 0.3) dir = (dir + (rng() < 0.5 ? 1 : 3)) % 4;
      const dc = dir === 0 ? 1 : dir === 1 ? -1 : 0;
      const dr = dir === 2 ? 1 : dir === 3 ? -1 : 0;
      const nc = c + dc;
      const nr = r + dr;
      if (!inBounds(nc, nr) || !inBounds(nc + w - 1, nr + w - 1)) break;
      carveRect(grid, nc, nr, w, w);
      c = nc;
      r = nr;
    }
  }

  return { grid, rooms, stats };
}

/* ------------------------------------------------------------------ level */
export function createLevel({ cols = 25, rows = 25, seed = 1 } = {}) {
  const rng = makeRng(seed);
  const { grid, rooms, stats } = generate(cols, rows, rng);
  const isBorderCell = (c, r) => c === 0 || r === 0 || c === cols - 1 || r === rows - 1;

  const walls = new Set();
  const wallKind = new Map(); // "#" plain · "X" tower · "O" low block
  const openCells = [];

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (grid[r][c] !== "#") {
        openCells.push([c, r]);
        continue;
      }
      const key = `${c},${r}`;
      walls.add(key);
      if (isBorderCell(c, r)) {
        wallKind.set(key, "#");
        continue;
      }
      let n = 0;
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const cc = c + dc;
        const rr = r + dr;
        if (cc < 0 || rr < 0 || cc >= cols || rr >= rows) { n++; continue; }
        if (grid[rr][cc] === "#") n++;
      }
      // thick rock becomes tall towers, lone pillars become low blocks
      wallKind.set(key, n >= 4 ? "X" : n <= 1 ? "O" : "#");
    }
  }

  /* start = first room, exit = room furthest away (by BFS) */
  const first = rooms[0];
  const start = { col: first.cx, row: first.cy };
  const idx = (c, r) => r * cols + c;
  const dist = new Int32Array(cols * rows).fill(-1);
  const queue = [[start.col, start.row]];
  dist[idx(start.col, start.row)] = 0;
  for (let h = 0; h < queue.length; h++) {
    const [c, r] = queue[h];
    const d = dist[idx(c, r)];
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const cc = c + dc;
      const rr = r + dr;
      if (cc < 1 || rr < 1 || cc >= cols - 1 || rr >= rows - 1) continue;
      if (grid[rr][cc] === "#") continue;
      if (dist[idx(cc, rr)] !== -1) continue;
      dist[idx(cc, rr)] = d + 1;
      queue.push([cc, rr]);
    }
  }
  // Furthest room by walking distance, nudged towards the far corner of the map
  // so the goal is genuinely tucked away rather than one turn from the start.
  let exit = start;
  let bestScore = -1;
  for (const room of rooms) {
    const d = dist[idx(room.cx, room.cy)];
    if (d < 0) continue;
    const score = d + 0.35 * Math.hypot(room.cx - start.col, room.cy - start.row);
    if (score > bestScore) { bestScore = score; exit = { col: room.cx, row: room.cy }; }
  }

  /* ------------------------------------------------------ room character */
  // Each room gets a theme. The walls lining it are tinted in that theme, and a
  // few of them carry a prop, so a room reads as its own place from a distance.
  const wallTheme = new Map(); // wall key -> theme index
  const features = new Map();  // wall key -> { theme, kind }
  for (let i = 0; i < rooms.length; i++) {
    const room = rooms[i];
    room.theme = i === 0 ? 0 : Math.floor(rng() * THEMES.length);
    const border = [];
    for (let r = room.y; r < room.y + room.h; r++) {
      for (let c = room.x; c < room.x + room.w; c++) {
        for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const cc = c + dc;
          const rr = r + dr;
          if (isBorderCell(cc, rr)) continue;
          const key = `${cc},${rr}`;
          if (!walls.has(key) || wallTheme.has(key)) continue;
          wallTheme.set(key, room.theme);
          border.push(key);
        }
      }
    }
    const wanted = Math.min(4, Math.max(1, Math.round(border.length / 8)));
    for (let k = 0; k < wanted && border.length; k++) {
      const key = border.splice(Math.floor(rng() * border.length), 1)[0];
      features.set(key, { theme: room.theme, kind: THEMES[room.theme].kind });
    }
  }

  /* ---------------------------------------------------------- collision */
  const halfCols = (cols - 1) / 2;
  const halfRows = (rows - 1) / 2;
  const cellToWorldX = (c) => (c - halfCols) * CELL;
  const cellToWorldZ = (r) => (r - halfRows) * CELL;
  const colOf = (x) => Math.floor(x / CELL + halfCols + 0.5);
  const rowOf = (z) => Math.floor(z / CELL + halfRows + 0.5);
  const SKIN = 2e-3;

  // minimal push to separate a circle from wall cell (c,r); null if no overlap
  function pushOut(x, z, c, r, rad) {
    if (!walls.has(`${c},${r}`)) return null;
    const cx = cellToWorldX(c);
    const cz = cellToWorldZ(r);
    const h = CELL / 2;
    const nx = Math.max(cx - h, Math.min(x, cx + h));
    const nz = Math.max(cz - h, Math.min(z, cz + h));
    const dx = x - nx;
    const dz = z - nz;
    const d2 = dx * dx + dz * dz;
    if (d2 >= rad * rad) return null;

    const target = rad + SKIN;
    if (d2 > 1e-9) {
      const d = Math.sqrt(d2);
      const s = (target - d) / d;
      return { px: dx * s, pz: dz * s };
    }
    const left = x - (cx - h);
    const right = cx + h - x;
    const up = z - (cz - h);
    const down = cz + h - z;
    const m = Math.min(left, right, up, down);
    if (m === left) return { px: cx - h - target - x, pz: 0 };
    if (m === right) return { px: cx + h + target - x, pz: 0 };
    if (m === up) return { px: 0, pz: cz - h - target - z };
    return { px: 0, pz: cz + h + target - z };
  }

  function hitsWall(x, z, rad = COLL) {
    const c0 = colOf(x - rad);
    const c1 = colOf(x + rad);
    const r0 = rowOf(z - rad);
    const r1 = rowOf(z + rad);
    for (let c = c0; c <= c1; c++)
      for (let r = r0; r <= r1; r++)
        if (pushOut(x, z, c, r, rad)) return true;
    return false;
  }

  function resolve(x, z, rad = COLL) {
    for (let it = 0; it < 8; it++) {
      let best = null;
      let bestDepth = 0;
      const c0 = colOf(x - rad);
      const c1 = colOf(x + rad);
      const r0 = rowOf(z - rad);
      const r1 = rowOf(z + rad);
      for (let c = c0; c <= c1; c++)
        for (let r = r0; r <= r1; r++) {
          const p = pushOut(x, z, c, r, rad);
          if (!p) continue;
          const d = Math.hypot(p.px, p.pz);
          if (d > bestDepth) { bestDepth = d; best = p; }
        }
      if (!best) break;
      x += best.px;
      z += best.pz;
    }
    return { x, z };
  }

  function slide(x, z, dx, dz, rad = COLL) {
    if (hitsWall(x, z, rad)) {
      const r0 = resolve(x, z, rad);
      x = r0.x;
      z = r0.z;
    }
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dz) / (rad * 0.5)));
    const sx = dx / steps;
    const sz = dz / steps;
    for (let i = 0; i < steps; i++) {
      const p = resolve(x + sx, z + sz, rad);
      if (!hitsWall(p.x, p.z, rad)) { x = p.x; z = p.z; continue; }
      const a = resolve(x + sx, z, rad);
      if (!hitsWall(a.x, a.z, rad)) { x = a.x; z = a.z; continue; }
      const b = resolve(x, z + sz, rad);
      if (!hitsWall(b.x, b.z, rad)) { x = b.x; z = b.z; continue; }
      break;
    }
    return { x, z };
  }

  return {
    cols, rows, walls, wallKind, wallTheme, features, rooms, stats, openCells, start, exit,
    cellToWorldX, cellToWorldZ, hitsWall, resolve, slide,
    isBorderCell,
    worldOf: (c, r) => ({ x: cellToWorldX(c), z: cellToWorldZ(r) }),
    cellOf: (x, z) => ({ col: colOf(x), row: rowOf(z) }),
  };
}
