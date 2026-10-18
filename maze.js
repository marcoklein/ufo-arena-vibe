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

/* --------------------------------------------------------- the upper level */
// The low blocks are the level above the floor: their tops are driven on and the
// gaps between them are hovered over. Lone pillars made that level meaningless,
// so the layout is built for it: rooms get raised runs - a walkway across the
// room with one or two gaps to hover, or a plateau to stand on - and the lift
// pads are put beside them. Nothing is stamped in the start room, in a corridor,
// or within one cell of a room's edge, so no doorway is ever pinched.
function stampUpperLevel(grid, rooms, cols, rng) {
  const stamped = new Set();
  const roomCells = new Set();
  for (const room of rooms) {
    for (let r = room.y; r < room.y + room.h; r++) {
      for (let c = room.x; c < room.x + room.w; c++) roomCells.add(`${c},${r}`);
    }
  }
  // a cell that touches a corridor is a doorway approach: never raise that
  const doorway = (c, r) => [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dc, dr]) => {
    const cc = c + dc;
    const rr = r + dr;
    return grid[rr] && grid[rr][cc] === "." && !roomCells.has(`${cc},${rr}`);
  });
  const set = (c, r) => {
    if (grid[r][c] !== ".") return false;
    if (doorway(c, r)) return false;
    grid[r][c] = "#";
    stamped.add(`${c},${r}`);
    return true;
  };

  const want = Math.max(2, Math.min(6, Math.floor(cols / 8)));
  const order = rooms.map((_, i) => i).filter((i) => i > 0); // never the start room
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }

  let made = 0;
  for (const idx of order) {
    if (made >= want) break;
    const room = rooms[idx];
    const x0 = room.x + 1;
    const y0 = room.y + 1;
    const x1 = room.x + room.w - 2;
    const y1 = room.y + room.h - 2;
    if (x1 - x0 < 3 || y1 - y0 < 3) continue;

    let cells = 0;
    if (rng() < 0.32) {
      // a plateau: somewhere to stand up there, and a chunk out of the floor
      const pw = 2 + (rng() < 0.45 ? 1 : 0);
      const ph = 2;
      const cx = x0 + Math.floor(rng() * Math.max(1, x1 - x0 - pw + 1));
      const cy = y0 + Math.floor(rng() * Math.max(1, y1 - y0 - ph + 1));
      for (let r = cy; r < cy + ph; r++) {
        for (let c = cx; c < cx + pw; c++) if (set(c, r)) cells++;
      }
    } else {
      // a walkway across the room, with gaps in it: the raised route is straight,
      // the floor route has to go round, and the gaps are what the hover is for
      const horiz = rng() < 0.55;
      const len = horiz ? x1 - x0 : y1 - y0;
      const gaps = new Set();
      const gapCount = len >= 6 ? 2 : 1;
      for (let g = 0; g < gapCount; g++) gaps.add(1 + Math.floor(rng() * Math.max(1, len - 1)));
      if (horiz) {
        const row = y0 + Math.floor((y1 - y0) / 2);
        for (let k = 0; k <= len; k++) if (!gaps.has(k) && set(x0 + k, row)) cells++;
      } else {
        const col = x0 + Math.floor((x1 - x0) / 2);
        for (let k = 0; k <= len; k++) if (!gaps.has(k) && set(col, y0 + k)) cells++;
      }
    }
    if (cells >= 3) made++;
  }
  return stamped;
}

/* ------------------------------------------------------------------ level */
export function createLevel({ cols = 25, rows = 25, seed = 1, liftCount = 2 } = {}) {
  const rng = makeRng(seed);
  const { grid, rooms, stats } = generate(cols, rows, rng);
  const upper = stampUpperLevel(grid, rooms, cols, rng); // the level above the floor
  stats.upper = upper.size;
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
      if (upper.has(key)) {
        // a raised run: low enough to be flown over, high enough to stand on
        wallKind.set(key, "O");
        continue;
      }
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

  // a raised run must never swallow the exit cell itself
  {
    const key = `${exit.col},${exit.row}`;
    if (upper.has(key)) {
      upper.delete(key);
      grid[exit.row][exit.col] = ".";
      walls.delete(key);
      wallKind.delete(key);
      openCells.push([exit.col, exit.row]);
      stats.upper--;
    }
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

  /* ----------------------------------------------------------- lift pads */
  // Pads that throw the craft up onto the deck above the maze. They have to sit
  // on open floor with room around them, they are spread over the level, and one
  // of them is put as close to the exit as the rules allow, so the last stretch
  // can be flown in over the guards.
  const wantLifts = Math.max(0, Math.min(6, Math.round(liftCount)));
  const lifts = [];
  {
    const at = (c, r) => r * cols + c;
    const reachable = (c, r) => c > 0 && r > 0 && c < cols - 1 && r < rows - 1 && dist[at(c, r)] >= 0;
    const roomy = openCells.filter(([c, r]) => {
      if (!reachable(c, r)) return false;
      // not right under the start pad, and a real run short of the exit, so a
      // lift is a shortcut over the guard ring rather than a step onto the goal
      if (Math.abs(c - start.col) + Math.abs(r - start.row) < 3) return false;
      if (Math.abs(c - exit.col) + Math.abs(r - exit.row) < 4) return false;
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (walls.has(`${c + dc},${r + dr}`)) return false;
      }
      return true;
    });
    const pool = roomy.length >= wantLifts ? roomy : openCells.filter(([c, r]) => reachable(c, r));
    // a pad is only worth finding if the level above it is worth being on
    const nearUpper = (c, r) => {
      for (let dr = -4; dr <= 4; dr++) {
        for (let dc = -4; dc <= 4; dc++) if (upper.has(`${c + dc},${r + dr}`)) return true;
      }
      return false;
    };

    if (pool.length && wantLifts > 0) {
      const toExit = (c, r) => Math.abs(c - exit.col) + Math.abs(r - exit.row);
      const push = (c, r) => {
        if (lifts.length >= wantLifts) return;
        if (lifts.some((l) => l.col === c && l.row === r)) return;
        lifts.push({ col: c, row: r });
      };

      // one pad always stands beside a raised run, so there is something to fly
      // onto: the such spot nearest the exit
      const near = pool.filter(([c, r]) => nearUpper(c, r));
      if (near.length) {
        let pick = near[0];
        for (const cell of near) if (toExit(cell[0], cell[1]) < toExit(pick[0], pick[1])) pick = cell;
        push(pick[0], pick[1]);
      }

      // the staging pad: as near the exit as it is allowed to be
      let pick = null;
      let best = -Infinity;
      for (const [c, r] of pool) {
        const fromStart = Math.abs(c - start.col) + Math.abs(r - start.row);
        const score = -toExit(c, r) * 1.6 + Math.min(fromStart, 14) * 0.4 + (nearUpper(c, r) ? 5 : 0);
        if (score > best) { best = score; pick = [c, r]; }
      }
      if (pick) push(pick[0], pick[1]);

      // then spread the rest as far from each other and the start as possible
      while (lifts.length < wantLifts) {
        let next = null;
        let bestSpread = -Infinity;
        for (const [c, r] of pool) {
          if (lifts.some((l) => l.col === c && l.row === r)) continue;
          let spacing = Math.hypot(c - start.col, r - start.row) * 1.15;
          for (const l of lifts) spacing = Math.min(spacing, Math.hypot(c - l.col, r - l.row));
          if (nearUpper(c, r)) spacing += 3;
          if (spacing > bestSpread) { bestSpread = spacing; next = [c, r]; }
        }
        if (!next) break;
        push(next[0], next[1]);
      }
    }
    stats.lifts = lifts.length;
  }

  /* ---------------------------------------------------------- collision */
  const halfCols = (cols - 1) / 2;
  const halfRows = (rows - 1) / 2;
  const cellToWorldX = (c) => (c - halfCols) * CELL;
  const cellToWorldZ = (r) => (r - halfRows) * CELL;
  const colOf = (x) => Math.floor(x / CELL + halfCols + 0.5);
  const rowOf = (z) => Math.floor(z / CELL + halfRows + 0.5);
  const SKIN = 2e-3;

  // minimal push to separate a circle from wall cell (c,r); null if no overlap.
  // `skip(c,r)` lets a caller fly over chosen wall cells (see the hover lift in
  // main.js: one block up, everything lower than the hull is not in the way).
  function pushOut(x, z, c, r, rad, skip) {
    if (!walls.has(`${c},${r}`)) return null;
    if (skip && skip(c, r)) return null;
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

  function hitsWall(x, z, rad = COLL, skip = null) {
    const c0 = colOf(x - rad);
    const c1 = colOf(x + rad);
    const r0 = rowOf(z - rad);
    const r1 = rowOf(z + rad);
    for (let c = c0; c <= c1; c++)
      for (let r = r0; r <= r1; r++)
        if (pushOut(x, z, c, r, rad, skip)) return true;
    return false;
  }

  function resolve(x, z, rad = COLL, skip = null) {
    for (let it = 0; it < 8; it++) {
      let best = null;
      let bestDepth = 0;
      const c0 = colOf(x - rad);
      const c1 = colOf(x + rad);
      const r0 = rowOf(z - rad);
      const r1 = rowOf(z + rad);
      for (let c = c0; c <= c1; c++)
        for (let r = r0; r <= r1; r++) {
          const p = pushOut(x, z, c, r, rad, skip);
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

  function slide(x, z, dx, dz, rad = COLL, skip = null) {
    if (hitsWall(x, z, rad, skip)) {
      const r0 = resolve(x, z, rad, skip);
      x = r0.x;
      z = r0.z;
    }
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dz) / (rad * 0.5)));
    const sx = dx / steps;
    const sz = dz / steps;
    for (let i = 0; i < steps; i++) {
      const p = resolve(x + sx, z + sz, rad, skip);
      if (!hitsWall(p.x, p.z, rad, skip)) { x = p.x; z = p.z; continue; }
      const a = resolve(x + sx, z, rad, skip);
      if (!hitsWall(a.x, a.z, rad, skip)) { x = a.x; z = a.z; continue; }
      const b = resolve(x, z + sz, rad, skip);
      if (!hitsWall(b.x, b.z, rad, skip)) { x = b.x; z = b.z; continue; }
      break;
    }
    return { x, z };
  }

  return {
    cols, rows, walls, wallKind, wallTheme, features, rooms, stats, openCells, start, exit, lifts, upper,
    cellToWorldX, cellToWorldZ, hitsWall, resolve, slide,
    isBorderCell,
    worldOf: (c, r) => ({ x: cellToWorldX(c), z: cellToWorldZ(r) }),
    cellOf: (x, z) => ({ col: colOf(x), row: rowOf(z) }),
  };
}
