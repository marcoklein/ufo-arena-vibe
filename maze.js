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
function generate(cols, rows, rng, maxRooms = 99, tower = 0.35) {
  const grid = [];
  for (let r = 0; r < rows; r++) grid.push(new Array(cols).fill("#"));

  const rooms = [];
  const tries = cols * rows;
  const carveBudget = cols * rows * 0.45;
  let carved = 0;

  // The room you start in is always at least 8x8 cells: the chase camera sits 9.5
  // units behind the craft, and a small room would keep pulling it in until it is
  // staring at the back of the saucer. 8 cells is 32 units, so the camera has all
  // the room it needs behind the start cell.
  if (cols >= 12 && rows >= 12) {
    // 8 cells across, or 9 where the map has the room to spare (a 15-wide tutorial
    // map needs to keep four columns free for the room the exit goes in)
    const w = Math.min(9, Math.max(8, cols - 7));
    const h = Math.min(9, Math.max(8, rows - 7));
    // tucked into a corner, so the rest of the map is one open block of rock to
    // carve the other rooms out of
    const x = 1 + Math.floor(rng() * 2);
    const y = 1 + Math.floor(rng() * 2);
    carveRect(grid, x, y, w, h);
    rooms.push({ x, y, w, h, cx: x + (w >> 1), cy: y + (h >> 1), pillars: false });
    carved += w * h;
  }

  // on the tiny tutorial levels two rooms have to fit side by side, so the rooms
  // are kept small there instead of one room eating the map
  const maxRoom = maxRooms <= 3 ? Math.max(4, Math.floor(cols / 3)) : 9;
  for (let i = 0; i < tries && carved < carveBudget; i++) {
    if (rooms.length >= maxRooms) break;
    const w = 4 + Math.floor(rng() * (maxRoom - 3)); // 4..maxRoom cells
    const h = 4 + Math.floor(rng() * (maxRoom - 3));
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
  // a crowded level gets columns in nearly every hall, an open one almost none
  for (const room of rooms) {
    if (room.w < 7 || room.h < 7 || rng() < 0.35 - tower * 0.3) continue;
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

/* --------------------------------------------------------- the upper level */// The low blocks are the level above the floor: their tops are driven on and the
// gaps between them are hovered over. Lone pillars made that level meaningless,
// so the layout is built for it. Every room that can take one gets a build:
//
//   causeway  a line of blocks across the room with holes punched through it, so
//             the raised route runs straight and the floor route has to go round
//   plateau   a landing to stand and fight on, with a hole in the middle of it
//   vault     a ring of blocks around a pocket of floor, with a lift pad inside:
//             the only way in is to hover over the ring, and the pad gets you out
//   stepping  lone blocks to hop between, with holes drilled in beside them
//
// On top of that, rooms get loose holes: cells with no floor in them at all. At
// floor level a hole is a wall; one level up it is nothing, so it has to be
// hovered across. A hole punched in a raised run is exactly the same idea.
//
// Nothing is stamped in the start room, in a corridor, or within one cell of a
// room's edge. So no doorway is ever pinched, the inside rim of every room stays
// walkable, and neither a block nor a hole can cut a room in half.
function stampUpperLevel(grid, rooms, cols, rng, { startDeck = false, voidFloor = false } = {}) {
  const upper = new Set();   // low blocks: the level above the floor
  const holes = new Set();   // holes in the floor: nothing up there to land on
  const vaults = [];         // courtyards that only open from above
  const vaultRings = new Set(); // ...and the rings of blocks round them
  const roomCells = new Set();
  for (const room of rooms) {
    for (let r = room.y; r < room.y + room.h; r++) {
      for (let c = room.x; c < room.x + room.w; c++) roomCells.add(`${c},${r}`);
    }
  }
  // a cell that touches a corridor is a doorway approach: never build there
  const doorway = (c, r) => [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dc, dr]) => {
    const cc = c + dc;
    const rr = r + dr;
    return grid[rr] && grid[rr][cc] === "." && !roomCells.has(`${cc},${rr}`);
  });
  const clear = (c, r) => grid[r] && grid[r][c] === "." && !doorway(c, r);
  const raise = (c, r) => {
    if (!clear(c, r)) return false;
    grid[r][c] = "#";
    upper.add(`${c},${r}`);
    return true;
  };
  const drill = (c, r) => {
    if (!clear(c, r)) return false;
    grid[r][c] = "#";
    holes.add(`${c},${r}`);
    return true;
  };
  const demote = (c, r) => { // a raised cell becomes a hole in the deck
    const key = `${c},${r}`;
    if (!upper.has(key)) return false;
    upper.delete(key);
    holes.add(key);
    return true;
  };

  /* a run straight across the room, with holes in it to hover */
  const causeway = (x0, y0, x1, y1, iw, ih) => {
    const horiz = rng() < 0.6;
    const a0 = horiz ? x0 : y0;
    const a1 = horiz ? x1 : y1;
    const mid = horiz ? y0 + ((ih - 1) >> 1) : x0 + ((iw - 1) >> 1);
    const len = a1 - a0;
    const gapCount = len >= 5 ? 2 : 1;
    const gaps = new Set();
    for (let g = 0; g < gapCount; g++) gaps.add(1 + Math.floor(rng() * Math.max(1, len - 1)));
    let made = 0;
    for (let k = 0; k <= len; k++) {
      const c = horiz ? a0 + k : mid;
      const r = horiz ? mid : a0 + k;
      if (gaps.has(k)) { if (drill(c, r)) made++; }
      else if (raise(c, r)) made++;
    }
    // a landing at one end: somewhere to come down on and get your bearings.
    // It stays in the build's box, so it never reaches into the room's rim.
    for (let k = 0; k < 2; k++) {
      for (const s of [-1, 1]) {
        if (rng() < 0.45) continue;
        const c = horiz ? a0 + k : mid + s;
        const r = horiz ? mid + s : a0 + k;
        if (c < x0 || c > x1 || r < y0 || r > y1) continue;
        if (raise(c, r)) made++;
      }
    }
    return made;
  };

  /* a deck to stand on, with a hole in the middle of it */
  const plateau = (x0, y0, x1, y1, iw, ih) => {
    const pw = iw >= 4 && rng() < 0.4 ? 3 : 2;
    const ph = ih >= 4 && rng() < 0.4 ? 3 : 2;
    const cx = x0 + Math.floor(rng() * Math.max(1, iw - pw + 1));
    const cy = y0 + Math.floor(rng() * Math.max(1, ih - ph + 1));
    let made = 0;
    for (let r = cy; r < cy + ph; r++) {
      for (let c = cx; c < cx + pw; c++) if (raise(c, r)) made++;
    }
    if (made >= 4) {
      // the deck itself has to be hopped across
      if (!demote(cx + ((pw - 1) >> 1), cy + ((ph - 1) >> 1))) demote(cx, cy);
    }
    return made;
  };

  /* A ring of blocks round a courtyard: hover in over the ring, and the pad in the
     middle takes you out again. The courtyard is 3x3 cells, so the pad in its
     centre has open floor on all four sides - room to drive off it, which is what
     lets a spent pad re-arm, and room to sit beside it and recharge. The ring may
     hug the wall of its room (there is always a lane round one side, since the ring
     is a cell narrower than the room), but no ring cell may sit on a doorway. */
  const vault = (room, keepOut = null) => {
    const SIDE = 5;
    const mid = 2;
    if (room.w < SIDE + 1 || room.h < SIDE + 1) return 0;
    for (let attempt = 0; attempt < 8; attempt++) {
      const cx = room.x + Math.floor(rng() * (room.w - SIDE + 1));
      const cy = room.y + Math.floor(rng() * (room.h - SIDE + 1));
      // a courtyard round the cell the run starts on would trap the craft in its
      // own landing pad
      if (keepOut &&
          Math.abs(cx + mid - keepOut.col) <= 1 && Math.abs(cy + mid - keepOut.row) <= 1) continue;
      const ring = [];
      for (let r = cy; r < cy + SIDE; r++) {
        for (let c = cx; c < cx + SIDE; c++) {
          const edge = c === cx || c === cx + SIDE - 1 || r === cy || r === cy + SIDE - 1;
          if (edge) ring.push([c, r]);
        }
      }
      // a pillar standing in the way of the ring, or in the courtyard itself, is
      // scenery: take it out, so a courtyard can be cut into a hall with columns
      for (let r = cy; r < cy + SIDE; r++) {
        for (let c = cx; c < cx + SIDE; c++) {
          if (grid[r][c] === "#" && !doorway(c, r)) grid[r][c] = ".";
        }
      }
      if (!ring.every(([c, r]) => clear(c, r))) continue; // a broken ring is no vault
      let made = 0;
      for (const [c, r] of ring) {
        if (raise(c, r)) made++;
        vaultRings.add(`${c},${r}`);
      }
      // a landing run off one side, so there is somewhere to come down outside it
      const [dc, dr] = [[1, 0], [-1, 0], [0, 1], [0, -1]][Math.floor(rng() * 4)];
      for (let k = 1; k <= 2; k++) {
        const c = cx + mid + dc * (mid + k);
        const r = cy + mid + dr * (mid + k);
        if (c < room.x + 1 || c > room.x + room.w - 2 || r < room.y + 1 || r > room.y + room.h - 2) break;
        if (raise(c, r)) made++;
      }
      vaults.push({ col: cx + mid, row: cy + mid }); // the middle of the courtyard
      return made;
    }
    return 0;
  };

  /* lone blocks to hop between, and holes to hop over */
  const stepping = (x0, y0, x1, y1, iw, ih) => {
    let made = 0;
    for (let i = 0; i < 14 && made < 4; i++) {
      if (raise(x0 + Math.floor(rng() * iw), y0 + Math.floor(rng() * ih))) made++;
    }
    let cut = 0;
    for (let i = 0; i < 14 && cut < 3; i++) {
      const c = x0 + Math.floor(rng() * iw);
      const r = y0 + Math.floor(rng() * ih);
      const nextToStone = [[1, 0], [-1, 0], [0, 1], [0, -1]]
        .some(([dc, dr]) => upper.has(`${c + dc},${r + dr}`));
      if (nextToStone && drill(c, r)) cut++;
    }
    return made + cut;
  };

  const want = Math.max(4, Math.min(10, Math.floor(cols / 4)));
  const order = rooms.map((_, i) => i).filter((i) => i > 0); // never the start room
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }

  // the bounds a build may use: one cell clear of the room edge, and clear of any
  // doorway approach, so the inside rim of the room always stays walkable
  const box = (room) => {
    const x0 = room.x + 1;
    const y0 = room.y + 1;
    const x1 = room.x + room.w - 2;
    const y1 = room.y + room.h - 2;
    return { x0, y0, x1, y1, iw: x1 - x0 + 1, ih: y1 - y0 + 1 };
  };

  let made = 0;

  // The level that introduces the lift gets a small deck in the room you start in,
  // so the pad that comes with it has something to land on straight away. It never
  // covers the start cell itself, and it shrinks to fit a small room: even one
  // block is enough to show that up there is a place to stand.
  if (startDeck) {
    const room = rooms[0];
    const b = box(room);
    for (const [pw, ph] of [[2, 2], [2, 1], [1, 2], [1, 1]]) {
      let best = null;
      let bestD = Infinity;
      for (let r = b.y0; r <= b.y1 - ph + 1; r++) {
        for (let c = b.x0; c <= b.x1 - pw + 1; c++) {
          const cells = [];
          for (let rr = r; rr < r + ph; rr++) for (let cc = c; cc < c + pw; cc++) cells.push([cc, rr]);
          if (cells.some(([cc, rr]) => cc === room.cx && rr === room.cy)) continue; // the craft starts there
          if (!cells.every(([cc, rr]) => clear(cc, rr))) continue;
          const d = Math.abs(c - room.cx) + Math.abs(r - room.cy);
          if (d < bestD) { bestD = d; best = cells; }
        }
      }
      if (best) {
        for (const [c, r] of best) raise(c, r);
        made++;
        break;
      }
    }
  }

  // first dibs: the biggest room that can take a ring gets the vault, because a
  // sealed courtyard with its own pad is the clearest answer to "what is the
  // level above for?" - and it needs the room to spare. A level with no floor has
  // no use for a courtyard in it, so those get none.
  let reserved = -1;
  if (!voidFloor) {
    const fits = (idx) => rooms[idx].w >= 6 && rooms[idx].h >= 6;
    const others = order.filter(fits).sort((a, b) => rooms[b].w * rooms[b].h - rooms[a].w * rooms[a].h);
    for (const idx of others) {
      if (vault(rooms[idx]) >= 3) { reserved = idx; made++; break; }
    }
    if (reserved < 0 && fits(0)) {
      const keep = { col: rooms[0].cx, row: rooms[0].cy };
      if (vault(rooms[0], keep) >= 3) { reserved = 0; made++; }
    }
  }

  for (const idx of order) {
    if (made >= want) break;
    if (idx === reserved) continue;
    const { x0, y0, x1, y1, iw, ih } = box(rooms[idx]);
    if (iw < 2 || ih < 2) continue;

    const roll = rng();
    let cells;
    if (!voidFloor && rooms[idx].w >= 6 && rooms[idx].h >= 6 && roll < 0.34) {
      const keep = idx === 0 ? { col: rooms[0].cx, row: rooms[0].cy } : null;
      cells = vault(rooms[idx], keep);
    }
    else if (roll < 0.55) cells = causeway(x0, y0, x1, y1, iw, ih);
    else if (roll < 0.78) cells = plateau(x0, y0, x1, y1, iw, ih);
    else cells = stepping(x0, y0, x1, y1, iw, ih);
    if (cells >= 2) made++;
  }

  /* ------------------------------------------------------ corridors of void */
  // Stretches of corridor with no floor in them at all. This is the point of the
  // hover on the floor: the gap is in the way of your wheels and the only way
  // across it is over it. A run is only taken if the level survives it - the walk
  // from the start is recounted after each one and the run is taken back if it cut
  // anything off - so a void is always a shortcut or a risk, never the only road.
  //
  // A level whose whole floor is a void (see createLevel) has no use for either
  // of these: there is nothing left to cut, and nothing left to roof over.
  const voids = new Set();
  const roofs = new Set();
  if (!voidFloor) {
  const startRoom = rooms[0];
  const rowCount = grid.length;
  const walkCount = () => {
    const seen = new Set([`${startRoom.cx},${startRoom.cy}`]);
    const q = [[startRoom.cx, startRoom.cy]];
    for (let i = 0; i < q.length; i++) {
      const [c, r] = q[i];
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const cc = c + dc;
        const rr = r + dr;
        if (cc < 1 || rr < 1 || cc >= cols - 1 || rr >= rowCount - 1) continue;
        if (grid[rr][cc] === "#") continue;
        const k = `${cc},${rr}`;
        if (seen.has(k)) continue;
        seen.add(k);
        q.push([cc, rr]);
      }
    }
    return seen;
  };
  {
    const reach = walkCount();
    const base = reach.size;
    const corridor = (c, r) =>
      grid[r] && grid[r][c] === "." && !roomCells.has(`${c},${r}`);
    let runs = 0;
    for (let attempt = 0; attempt < 90 && runs < 4; attempt++) {
      const c = 2 + Math.floor(rng() * (cols - 4));
      const r = 2 + Math.floor(rng() * (rowCount - 4));
      if (!corridor(c, r) || !reach.has(`${c},${r}`)) continue;
      // a straight run along the corridor, never at a junction or a corner
      const h = grid[r][c - 1] === "." && grid[r][c + 1] === ".";
      const v = grid[r - 1] && grid[r - 1][c] === "." && grid[r + 1] && grid[r + 1][c] === ".";
      if (h === v) continue;
      const len = 2 + (rng() < 0.35 ? 1 : 0);
      const cells = [];
      for (let k = 0; k < len; k++) {
        const cc = h ? c + k : c;
        const rr = h ? r : r + k;
        if (!corridor(cc, rr) || !reach.has(`${cc},${rr}`)) break;
        cells.push([cc, rr]);
      }
      if (cells.length < 2) continue;
      for (const [cc, rr] of cells) grid[rr][cc] = "#";
      if (walkCount().size !== base - cells.length) {
        for (const [cc, rr] of cells) grid[rr][cc] = ".";
        continue;
      }
      for (const [cc, rr] of cells) {
        const key = `${cc},${rr}`;
        holes.add(key);
        voids.add(key);
      }
      runs++;
    }
  }

  /* ----------------------------------------------------------- the tunnels */
  // A roof over a corridor. Nothing changes on the floor - you drive under it,
  // and so does everything that walks - but one level up it is solid rock. So the
  // level above is not a free flight path over the whole map: there are places
  // where the only way on is down, out from under the roof, and back up on the
  // other side (or round, on the floor).
  {
    const corridor = (c, r) => grid[r] && grid[r][c] === "." && !roomCells.has(`${c},${r}`);
    const wantRoofs = Math.max(2, Math.min(8, Math.floor(cols / 5)));
    let runs = 0;
    for (let attempt = 0; attempt < 140 && runs < wantRoofs; attempt++) {
      const c = 2 + Math.floor(rng() * (cols - 4));
      const r = 2 + Math.floor(rng() * (rowCount - 4));
      if (!corridor(c, r)) continue;
      const h = grid[r][c - 1] === "." && grid[r][c + 1] === ".";
      const v = grid[r - 1] && grid[r - 1][c] === "." && grid[r + 1] && grid[r + 1][c] === ".";
      if (h === v) continue;                 // junctions and corners are not tunnels
      if (holes.has(`${c},${r}`)) continue;  // nothing to roof over a hole
      const len = 2 + (rng() < 0.4 ? 1 : 0);
      const cells = [];
      for (let k = 0; k < len; k++) {
        const cc = h ? c + k : c;
        const rr = h ? r : r + k;
        if (!corridor(cc, rr) || holes.has(`${cc},${rr}`)) break;
        if (roofs.has(`${cc},${rr}`)) break;
        cells.push([cc, rr]);
      }
      if (cells.length < 2) continue;
      for (const [cc, rr] of cells) roofs.add(`${cc},${rr}`);
      runs++;
    }
  }
  } // not a void floor: the tunnels and the corridor voids are only for levels with a floor

  return { upper, holes, vaults, vaultRings, voids, roofs };
}

/* ------------------------------------------------------------------ level */
export function createLevel({
  cols = 25, rows = 25, seed = 1, liftCount = 2, upper: wantUpper = true, rooms: maxRooms = 99,
  startPad = false, startDeck = false, tower = 0.35, voidFloor = false,
} = {}) {
  const rng = makeRng(seed);
  const { grid, rooms, stats } = generate(cols, rows, rng, maxRooms, tower);
  // the level above the floor, and the holes in it. Levels before the lift is
  // introduced are built without any of it.
  const built = wantUpper
    ? stampUpperLevel(grid, rooms, cols, rng, { startDeck, voidFloor })
    : { upper: new Set(), holes: new Set(), vaults: [], vaultRings: new Set(), voids: new Set(), roofs: new Set() };
  const upper = built.upper;
  const pits = built.holes;
  // The edge of the world is a band of nothing, not a nine-metre wall. The craft
  // can fly out over it - and then there is no ground under the hull at all, so
  // the same hover that crosses a hole is all that keeps it there, and off the map
  // there is nothing at all (see holeAt). That is the whole rim: not something to
  // fly around, something to fall off.
  const rim = new Set();
  for (let c = 0; c < cols; c++) {
    rim.add(`${c},0`);
    rim.add(`${c},${rows - 1}`);
  }
  for (let r = 0; r < rows; r++) {
    rim.add(`0,${r}`);
    rim.add(`${cols - 1},${r}`);
  }
  for (const key of rim) pits.add(key);
  const vaults = built.vaults;
  const vaultRings = built.vaultRings;
  const voids = built.voids;
  const roofs = built.roofs;
  stats.upper = upper.size;
  stats.pits = pits.size;
  stats.voids = voids.size;
  stats.roofs = roofs.size;
  stats.vaults = vaults.length;
  const isBorderCell = (c, r) => c === 0 || r === 0 || c === cols - 1 || r === rows - 1;

  const walls = new Set();
  const wallKind = new Map(); // "#" plain · "X" tower · "O" low block · "P" hole
  const openCells = [];

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (grid[r][c] !== "#") {
        openCells.push([c, r]);
        continue;
      }
      const key = `${c},${r}`;
      if (pits.has(key)) {
        // A hole is not a wall: there is simply no ground in it. The craft flies
        // over it and has to hold itself up; a walker has to go round. It stays
        // out of `walls` (and out of `openCells`: nothing spawns on a hole) so
        // the craft's own collision lets it over, and out of the floor BFS so an
        // exit is never picked behind one.
        wallKind.set(key, "P");
        continue;
      }
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
      // thick rock becomes tall towers, lone pillars become low blocks - and the
      // level's character decides how much of it stands up into a monolith, which
      // is a wall you cannot see over at all
      let kind = n >= 4 ? "X" : n <= 1 ? "O" : "#";
      if (tower > 0.55 && rng() < (tower - 0.55) * 0.9) kind = "S";
      else if (kind !== "X" && rng() < tower * 0.6) kind = "X";
      wallKind.set(key, kind);
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
  // Furthest room, both by walking distance and by plain distance: a goal that is
  // physically round the next corner but only reachable by a long loop is no good
  // as "the far side of the level". The room's centre may have been built over (a
  // deck or a hole in it), so each room offers the reachable cell nearest its
  // centre instead of only the centre itself.
  let exit = start;
  let bestScore = -1;
  for (const room of rooms) {
    let pick = null;
    let bestD = Infinity;
    for (let r = room.y; r < room.y + room.h; r++) {
      for (let c = room.x; c < room.x + room.w; c++) {
        const d = dist[idx(c, r)];
        if (d < 0 || walls.has(`${c},${r}`)) continue;
        const dc = Math.abs(c - room.cx) + Math.abs(r - room.cy);
        if (dc < bestD) { bestD = dc; pick = { col: c, row: r, d }; }
      }
    }
    if (!pick) continue;
    const score = pick.d + 0.9 * Math.hypot(pick.col - start.col, pick.row - start.row);
    if (score > bestScore) { bestScore = score; exit = { col: pick.col, row: pick.row }; }
  }
  // a one-room level still needs somewhere else to go, or the run would be over
  // the moment it started: take the far corner of the room you begin in
  if (exit.col === start.col && exit.row === start.row) {
    const room = rooms[0];
    let best = -1;
    for (let r = room.y + 1; r <= room.y + room.h - 2; r++) {
      for (let c = room.x + 1; c <= room.x + room.w - 2; c++) {
        const key = `${c},${r}`;
        if (walls.has(key) || pits.has(key)) continue;
        const d = Math.hypot(c - start.col, r - start.row);
        if (d > best + 1e-6) { best = d; exit = { col: c, row: r }; }
      }
    }
  }

  // a raised run or a hole must never swallow the exit cell itself
  {
    const key = `${exit.col},${exit.row}`;
    if (upper.has(key) || pits.has(key)) {
      if (upper.has(key)) { upper.delete(key); stats.upper--; }
      if (pits.has(key)) { pits.delete(key); stats.pits--; }
      grid[exit.row][exit.col] = ".";
      walls.delete(key);
      wallKind.delete(key);
      openCells.push([exit.col, exit.row]);
    }
    for (let i = vaults.length - 1; i >= 0; i--) {
      if (vaults[i].col === exit.col && vaults[i].row === exit.row) vaults.splice(i, 1);
    }
  }

  /* ------------------------------------------------------ the void floor */
  // One level is all holes down there. The floor survives only in the room you
  // start in and the room the exit is in; everywhere else is a void, and the
  // level above is the only way across. A raised run is laid along the walk from
  // the start to the exit first, so the road always joins the two places that
  // still have ground - and it is raised *before* the floor goes, so it is the
  // same walk a walker would have taken.
  if (voidFloor) {
    const at = (c, r) => r * cols + c;
    const floor = (c, r) => c > 0 && r > 0 && c < cols - 1 && r < rows - 1 &&
      grid[r][c] === "." && !walls.has(`${c},${r}`);
    // the walk from the start to the exit, over the floor as it stands
    const prev = new Int32Array(cols * rows).fill(-1);
    const seen = new Uint8Array(cols * rows);
    const q = [[start.col, start.row]];
    seen[at(start.col, start.row)] = 1;
    for (let h = 0; h < q.length; h++) {
      const [c, r] = q[h];
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const cc = c + dc;
        const rr = r + dr;
        if (!floor(cc, rr) || seen[at(cc, rr)]) continue;
        seen[at(cc, rr)] = 1;
        prev[at(cc, rr)] = at(c, r);
        q.push([cc, rr]);
      }
    }
    const road = [];
    if (seen[at(exit.col, exit.row)]) {
      for (let k = at(exit.col, exit.row); k !== at(start.col, start.row) && k >= 0; k = prev[k]) {
        road.push([k % cols, Math.floor(k / cols)]);
      }
      road.reverse();
    }
    // Raise the walk, plus one cell beside it, so there is a road wide enough to
    // drive and to pass a warden standing on it. Neither the start cell nor the
    // exit cell is ever built over: those two are floor, and stay floor.
    const raised = [];
    for (const [c, r] of road) {
      for (const [dc, dr] of [[0, 0], [1, 0], [0, 1]]) {
        const cc = c + dc;
        const rr = r + dr;
        if (cc === start.col && rr === start.row) continue;
        if (cc === exit.col && rr === exit.row) continue;
        if (!floor(cc, rr)) continue;
        const key = `${cc},${rr}`;
        grid[rr][cc] = "#";
        upper.add(key);
        walls.add(key);
        wallKind.set(key, "O");
        raised.push(key);
      }
    }
    // a raised cell is a block, not floor: it leaves the list of places anything
    // can stand or spawn
    for (let i = openCells.length - 1; i >= 0; i--) {
      const [c, r] = openCells[i];
      if (upper.has(`${c},${r}`)) openCells.splice(i, 1);
    }
    // and then the floor goes: everything outside the two rooms with ground left
    const keep = new Set();
    const keepRoom = (room) => {
      for (let r = room.y; r < room.y + room.h; r++) {
        for (let c = room.x; c < room.x + room.w; c++) keep.add(`${c},${r}`);
      }
    };
    keepRoom(rooms[0]);
    const exitRoom = rooms.find((room) =>
      exit.col >= room.x && exit.col < room.x + room.w &&
      exit.row >= room.y && exit.row < room.y + room.h);
    if (exitRoom) keepRoom(exitRoom);
    // a small island round the exit itself, whatever shape its room turned out to be
    for (let dr = -2; dr <= 2; dr++) {
      for (let dc = -2; dc <= 2; dc++) keep.add(`${exit.col + dc},${exit.row + dr}`);
    }
    for (let i = openCells.length - 1; i >= 0; i--) {
      const [c, r] = openCells[i];
      const key = `${c},${r}`;
      if (keep.has(key) || upper.has(key)) continue;
      openCells.splice(i, 1);
      grid[r][c] = "#";
      pits.add(key);
      wallKind.set(key, "P");
      stats.pits++;
    }
    stats.voidFloor = true;
    stats.road = raised.length;
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
          if (wallKind.get(key) === "P") continue; // a hole takes no tint and no prop
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
  // can be flown in over the guards. A pad is also put inside every vault, which
  // is sealed at floor level: hover over the ring to get in, and that pad is the
  // way back out - the pocket is where you go to get your hover back.
  const wantLifts = Math.max(0, Math.min(6, Math.round(liftCount)));
  const lifts = [];
  for (const v of vaults) lifts.push({ col: v.col, row: v.row, vault: true });
  {
    const at = (c, r) => r * cols + c;
    const reachable = (c, r) => c > 0 && r > 0 && c < cols - 1 && r < rows - 1 && dist[at(c, r)] >= 0;
    // A pad wants a 3x3 of open floor round it: room to drive on and off it from
    // any side, which is also what lets a spent pad re-arm. Where the map is too
    // tight for that, the four sides are the minimum.
    const padFits = (full) => openCells.filter(([c, r]) => {
      if (!reachable(c, r)) return false;
      // not right under the start pad, and a real run short of the exit, so a
      // lift is a shortcut over the guard ring rather than a step onto the goal
      if (Math.abs(c - start.col) + Math.abs(r - start.row) < 3) return false;
      if (Math.abs(c - exit.col) + Math.abs(r - exit.row) < 4) return false;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (!full && dc !== 0 && dr !== 0) continue; // the diagonals are the extra
          if (walls.has(`${c + dc},${r + dr}`)) return false;
          if (pits.has(`${c + dc},${r + dr}`)) return false;
          if (roofs.has(`${c + dc},${r + dr}`)) return false;
        }
      }
      return true;
    });
    let roomy = padFits(true);
    if (roomy.length < wantLifts) roomy = padFits(false);
    const pool = roomy.length >= wantLifts
      ? roomy
      : openCells.filter(([c, r]) => reachable(c, r) &&
        ![-1, 0, 1].some((dc) => [-1, 0, 1].some((dr) => roofs.has(`${c + dc},${r + dr}`))));
    // a pad is only worth finding if the level above it is worth being on
    const nearUpper = (c, r) => {
      for (let dr = -4; dr <= 4; dr++) {
        for (let dc = -4; dc <= 4; dc++) if (upper.has(`${c + dc},${r + dr}`)) return true;
      }
      return false;
    };

    if (pool.length && wantLifts > 0) {
      const toExit = (c, r) => Math.abs(c - exit.col) + Math.abs(r - exit.row);
      const toStart = (c, r) => Math.abs(c - start.col) + Math.abs(r - start.row);
      const fixed = lifts.length;
      const push = (c, r) => {
        if (lifts.length - fixed >= wantLifts) return;
        if (lifts.some((l) => l.col === c && l.row === r)) return;
        lifts.push({ col: c, row: r });
      };

      // the level that introduces the lift gets its pad in the room you start in,
      // so it can be tried before anything else
      if (startPad) {
        let pick = null;
        let best = Infinity;
        for (const [c, r] of pool) {
          const d = toStart(c, r);
          if (d < 2 || d > 6) continue;
          if (best > d) { best = d; pick = [c, r]; }
        }
        if (pick) push(pick[0], pick[1]);
      }

      // one pad always stands beside a raised run, and it is the one nearest the
      // start: the level above is a thing you should trip over early, not a
      // secret at the far end of the map
      const near = pool.filter(([c, r]) => nearUpper(c, r));
      if (near.length) {
        let pick = near[0];
        for (const cell of near) if (toStart(cell[0], cell[1]) < toStart(pick[0], pick[1])) pick = cell;
        push(pick[0], pick[1]);
      }

      // the staging pad: as near the exit as it is allowed to be
      let pick = null;
      let best = -Infinity;
      for (const [c, r] of pool) {
        const fromStart = toStart(c, r);
        const score = -toExit(c, r) * 1.6 + Math.min(fromStart, 14) * 0.4 + (nearUpper(c, r) ? 5 : 0);
        if (score > best) { best = score; pick = [c, r]; }
      }
      if (pick) push(pick[0], pick[1]);

      // then spread the rest as far from each other and the start as possible
      while (lifts.length - fixed < wantLifts) {
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
    stats.lifts = lifts.filter((l) => !l.vault).length;
    stats.vaultPads = lifts.length - stats.lifts;
  }

  /* ---------------------------------------------------------- collision */
  // Two sets, because the craft and the things that walk are not the same kind of
  // thing. `walls` is rock: it stops the craft. `ground` is rock plus the holes in
  // the floor: a hole does not stop the craft (it flies over it on the meter) but
  // a walker would fall in, so for a walker it is as solid as a wall.
  const ground = new Set(walls);
  for (const key of pits) ground.add(key);

  const halfCols = (cols - 1) / 2;
  const halfRows = (rows - 1) / 2;
  const cellToWorldX = (c) => (c - halfCols) * CELL;
  const cellToWorldZ = (r) => (r - halfRows) * CELL;
  const colOf = (x) => Math.floor(x / CELL + halfCols + 0.5);
  const rowOf = (z) => Math.floor(z / CELL + halfRows + 0.5);
  const SKIN = 2e-3;

  // minimal push to separate a circle from cell (c,r); null if no overlap.
  // `skip(c,r)` lets a caller fly over chosen cells (see the hover lift in
  // main.js: one level up, everything lower than the hull is not in the way).
  function pushOut(x, z, c, r, rad, skip, set = walls) {
    if (!set.has(`${c},${r}`)) return null;
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

  function hitsWall(x, z, rad = COLL, skip = null, set = walls) {
    const c0 = colOf(x - rad);
    const c1 = colOf(x + rad);
    const r0 = rowOf(z - rad);
    const r1 = rowOf(z + rad);
    for (let c = c0; c <= c1; c++)
      for (let r = r0; r <= r1; r++)
        if (pushOut(x, z, c, r, rad, skip, set)) return true;
    return false;
  }

  function resolve(x, z, rad = COLL, skip = null, set = walls) {
    for (let it = 0; it < 8; it++) {
      let best = null;
      let bestDepth = 0;
      const c0 = colOf(x - rad);
      const c1 = colOf(x + rad);
      const r0 = rowOf(z - rad);
      const r1 = rowOf(z + rad);
      for (let c = c0; c <= c1; c++)
        for (let r = r0; r <= r1; r++) {
          const p = pushOut(x, z, c, r, rad, skip, set);
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

  function slide(x, z, dx, dz, rad = COLL, skip = null, set = walls) {
    if (hitsWall(x, z, rad, skip, set)) {
      const r0 = resolve(x, z, rad, skip, set);
      x = r0.x;
      z = r0.z;
    }
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dz) / (rad * 0.5)));
    const sx = dx / steps;
    const sz = dz / steps;
    for (let i = 0; i < steps; i++) {
      const p = resolve(x + sx, z + sz, rad, skip, set);
      if (!hitsWall(p.x, p.z, rad, skip, set)) { x = p.x; z = p.z; continue; }
      const a = resolve(x + sx, z, rad, skip, set);
      if (!hitsWall(a.x, a.z, rad, skip, set)) { x = a.x; z = a.z; continue; }
      const b = resolve(x, z + sz, rad, skip, set);
      if (!hitsWall(b.x, b.z, rad, skip, set)) { x = b.x; z = b.z; continue; }
      break;
    }
    return { x, z };
  }

  // what the craft runs into one level up: rock and the roofs, with the low blocks
  // left to the skip predicate (they are underneath the hull up there)
  const upperSolids = new Set(walls);
  for (const key of roofs) upperSolids.add(key);

  return {
    cols, rows, walls, ground, wallKind, wallTheme, features, rooms, stats, openCells, start, exit, lifts, upper,
    pits, rim, voids, vaults, vaultRings, roofs, upperSolids,
    cellToWorldX, cellToWorldZ, hitsWall, resolve, slide,
    isBorderCell,
    // what a walker uses: a hole stops it just like a wall does
    walk: (x, z, dx, dz, rad = COLL) => slide(x, z, dx, dz, rad, null, ground),
    hitsGround: (x, z, rad = COLL) => hitsWall(x, z, rad, null, ground),
    // is there a hole in the floor under this point? Off the map there is nothing
    // at all, so that counts as a hole too: fly out over the rim and the meter is
    // the only thing between the craft and the drop.
    holeAt: (x, z) => {
      const c = colOf(x);
      const r = rowOf(z);
      if (c < 0 || r < 0 || c >= cols || r >= rows) return true;
      return pits.has(`${c},${r}`);
    },
    worldOf: (c, r) => ({ x: cellToWorldX(c), z: cellToWorldZ(r) }),
    cellOf: (x, z) => ({ col: colOf(x), row: rowOf(z) }),
  };
}
