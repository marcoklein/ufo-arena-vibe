// Node test for the maze/level module. Run: node test.mjs
import { CELL, RADIUS, COLL, createLevel } from "./maze.js";

let failures = 0;
const ok = (cond, msg) => { console.log((cond ? "  PASS " : "  FAIL ") + msg); if (!cond) failures++; };

/* determinism */
{
  const a = createLevel({ cols: 25, rows: 25, seed: 42 });
  const b = createLevel({ cols: 25, rows: 25, seed: 42 });
  const same = a.walls.size === b.walls.size &&
    [...a.walls].every((k) => b.walls.has(k)) &&
    a.start.col === b.start.col && a.start.row === b.start.row &&
    a.exit.col === b.exit.col && a.exit.row === b.exit.row &&
    JSON.stringify(a.lifts) === JSON.stringify(b.lifts);
  ok(same, "same seed produces the same level");
}

/* per-level checks */
for (const [lvl, cols, rows] of [[1, 25, 25], [3, 29, 29], [8, 39, 39]]) {
  const L = createLevel({ cols, rows, seed: 1000 + lvl });

  ok(L.cols === cols && L.rows === rows, `L${lvl}: grid is ${cols}x${rows}`);

  // the rim is a band of nothing: no wall round the map any more, but a hole on
  // every border cell, and nothing at all beyond it
  let rim = true;
  for (let c = 0; c < cols; c++) {
    if (!L.pits.has(`${c},0`) || !L.pits.has(`${c},${rows - 1}`)) rim = false;
    if (L.walls.has(`${c},0`) || L.walls.has(`${c},${rows - 1}`)) rim = false;
  }
  for (let r = 0; r < rows; r++) {
    if (!L.pits.has(`0,${r}`) || !L.pits.has(`${cols - 1},${r}`)) rim = false;
    if (L.walls.has(`0,${r}`) || L.walls.has(`${cols - 1},${r}`)) rim = false;
  }
  ok(rim, `L${lvl}: the edge is a void band, not a wall`);
  {
    const out = L.cellToWorldX(-3);
    const edge = L.cellToWorldX(0);
    ok(L.holeAt(out, 0) && L.holeAt(edge, 0), `L${lvl}: and off the map there is no ground at all`);
    ok(!L.hitsWall(edge, 0) && L.hitsGround(edge, 0),
      `L${lvl}: the craft can fly out over the rim, a walker cannot`);
  }

  ok(!L.walls.has(`${L.start.col},${L.start.row}`), `L${lvl}: start cell is open`);
  ok(L.rooms[0].w >= 8 && L.rooms[0].h >= 8,
    `L${lvl}: the start room is big enough for the camera (${L.rooms[0].w}x${L.rooms[0].h})`);
  ok(!L.walls.has(`${L.exit.col},${L.exit.row}`), `L${lvl}: exit cell is open`);
  ok(L.openCells.length > cols * rows * 0.3, `L${lvl}: level is open enough (${L.openCells.length} free cells)`);

  const sx = L.cellToWorldX(L.start.col);
  const sz = L.cellToWorldZ(L.start.row);
  const ex = L.cellToWorldX(L.exit.col);
  const ez = L.cellToWorldZ(L.exit.row);
  ok(!L.hitsWall(sx, sz), `L${lvl}: start position is not inside a wall`);

  /* exit reachable from start, walking the free space on a fine grid */
  {
    const STEP = 0.5;
    const key = (x, z) => `${Math.round(x / STEP)},${Math.round(z / STEP)}`;
    const seen = new Set([key(sx, sz)]);
    const stack = [[sx, sz]];
    let reached = false;
    while (stack.length) {
      const [x, z] = stack.pop();
      if (Math.hypot(x - ex, z - ez) < CELL * 0.5) { reached = true; break; }
      for (const [dx, dz] of [[STEP, 0], [-STEP, 0], [0, STEP], [0, -STEP]]) {
        const nx = x + dx;
        const nz = z + dz;
        // stay inside the map: past the void rim there is no floor to walk on
        if (Math.abs(nx) > (cols - 1) * CELL / 2 || Math.abs(nz) > (rows - 1) * CELL / 2) continue;
        const k = key(nx, nz);
        if (seen.has(k)) continue;
        seen.add(k);
        if (!L.hitsWall(nx, nz)) stack.push([nx, nz]);
      }
    }
    ok(reached, `L${lvl}: exit is reachable from start`);
  }

  /* the layout is a network, not a single corridor: free space should contain
     loops, and some of it should be single-cell squeezes */
  {
    let open = 0;
    let adj = 0;
    for (let r = 1; r < rows - 1; r++) {
      for (let c = 1; c < cols - 1; c++) {
        if (L.walls.has(`${c},${r}`)) continue;
        open++;
        if (!L.walls.has(`${c + 1},${r}`)) adj++;
        if (!L.walls.has(`${c},${r + 1}`)) adj++;
      }
    }
    let comps = 0;
    {
      const seen = new Set();
      for (const [c, r] of L.openCells) {
        const k = `${c},${r}`;
        if (seen.has(k)) continue;
        comps++;
        const stack = [[c, r]];
        seen.add(k);
        while (stack.length) {
          const [a, b] = stack.pop();
          for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const cc = a + dc;
            const rr = b + dr;
            if (cc < 1 || rr < 1 || cc >= cols - 1 || rr >= rows - 1) continue;
            const kk = `${cc},${rr}`;
            if (L.walls.has(kk) || seen.has(kk)) continue;
            seen.add(kk);
            stack.push([cc, rr]);
          }
        }
      }
    }
    const cycles = adj - open + comps;
    ok(cycles > 0, `L${lvl}: layout has ${cycles} loop(s), so routes branch`);
    ok(L.stats.tight > 0 && L.stats.tight / L.stats.links > 0.25,
      `L${lvl}: corridors mix widths (${L.stats.tight}/${L.stats.links} single-cell squeezes)`);
    ok(L.stats.stubs > 0, `L${lvl}: dead ends hang off the corridors (${L.stats.stubs} stubs)`);
  }

  /* every room is themed, and its props sit on solid rock */
  {
    const themed = L.rooms.every((r) => Number.isInteger(r.theme) && r.theme >= 0);
    ok(themed, `L${lvl}: all ${L.rooms.length} rooms carry a theme`);
    ok(L.wallTheme.size > 0, `L${lvl}: walls are tinted by the room they line (${L.wallTheme.size} cells)`);
    let solid = true;
    for (const key of L.features.keys()) if (!L.walls.has(key)) solid = false;
    ok(solid && L.features.size > 0, `L${lvl}: room props are mounted on walls (${L.features.size} of them)`);
    const distinct = new Set(L.rooms.map((r) => r.theme));
    ok(distinct.size > 1, `L${lvl}: rooms are visually distinct (${distinct.size} themes in use)`);
    const lint = [...L.wallTheme.values()].every((v) => v >= 0 && v < 6);
    ok(lint, `L${lvl}: wall tints are valid theme indices`);
  }

  /* random walk must never leave the player inside a wall */
  let rngState = 1000 + lvl;
  const rnd = () => (rngState = (rngState * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  let x = sx;
  let z = sz;
  let buried = 0;
  for (let i = 0; i < 60000; i++) {
    const a = rnd() * Math.PI * 2;
    const r = L.slide(x, z, Math.cos(a) * 0.25, Math.sin(a) * 0.25);
    x = r.x;
    z = r.z;
    if (L.hitsWall(x, z)) buried++;
  }
  ok(buried === 0, `L${lvl}: player never ends inside a wall (60k moves)`);

  /* enemies use a smaller radius — check that too */
  let ex2 = sx;
  let ez2 = sz;
  let eBuried = 0;
  for (let i = 0; i < 20000; i++) {
    const a = rnd() * Math.PI * 2;
    const r = L.slide(ex2, ez2, Math.cos(a) * 0.25, Math.sin(a) * 0.25, 1.0);
    ex2 = r.x;
    ez2 = r.z;
    if (L.hitsWall(ex2, ez2, 1.0)) eBuried++;
  }
  ok(eBuried === 0, `L${lvl}: enemy radius never ends inside a wall`);

  /* casting straight at a wall stops flush at its face */
  {
    const row = L.start.row;
    let to = L.start.col;
    while (to < cols - 1 && !L.walls.has(`${to},${row}`)) to++;
    const from = to - 1;
    const faceX = L.cellToWorldX(to) - CELL / 2;
    let cx = L.cellToWorldX(from);
    const cz = L.cellToWorldZ(row);
    for (let i = 0; i < 400; i++) { const r = L.slide(cx, cz, 0.3, 0); cx = r.x; }
    const want = faceX - COLL - 0.002;
    ok(Math.abs(cx - want) < 0.06 && !L.hitsWall(cx, cz), `L${lvl}: +x cast stops flush at the wall`);
  }
}

/* the level above the floor: raised runs, holes in the floor, and vaults */
for (const [lvl, cols, rows] of [[1, 25, 25], [3, 29, 29], [8, 39, 39]]) {
  const L = createLevel({ cols, rows, seed: 1000 + lvl });

  ok(L.upper.size >= 2, `L${lvl}: the level has raised runs (${L.upper.size} block cells)`);
  ok([...L.upper].every((k) => L.walls.has(k) && L.wallKind.get(k) === "O"),
    `L${lvl}: every raised cell is a low block, not a wall`);

  const chained = [...L.upper].filter((k) => {
    const [c, r] = k.split(",").map(Number);
    return [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dc, dr]) => L.upper.has(`${c + dc},${r + dr}`));
  }).length;
  ok(chained >= 4, `L${lvl}: the runs connect up instead of being lone pillars (${chained} joined)`);

  // a run stays a clear cell inside a room, so no doorway is ever pinched or a
  // room rim ever closed off
  const inRoomClear = [...L.upper].every((k) => {
    const [c, r] = k.split(",").map(Number);
    return L.rooms.some((room) =>
      c >= room.x + 1 && c <= room.x + room.w - 2 &&
      r >= room.y + 1 && r <= room.y + room.h - 2);
  });
  ok(inRoomClear, `L${lvl}: runs keep one cell clear of every room edge`);

  ok(!L.upper.has(`${L.start.col},${L.start.row}`), `L${lvl}: the start cell stays open`);
  ok(!L.upper.has(`${L.exit.col},${L.exit.row}`), `L${lvl}: and so does the exit cell`);

  // holes: cells with no ground in them. Not walls: the craft flies over them,
  // and what keeps it up is the same meter that keeps it up a level higher.
  ok(L.pits.size > 0, `L${lvl}: the floor has holes in it (${L.pits.size} cells)`);
  ok([...L.pits].every((k) => !L.walls.has(k) && L.wallKind.get(k) === "P"),
    `L${lvl}: a hole is its own kind of cell - no rock in it, no ground under it`);
  ok([...L.pits].every((k) => !L.upper.has(k)), `L${lvl}: no cell is both a block and a hole`);
  // room holes keep a cell clear of every room edge, so neither can cut a room in
  // half; a void run is a corridor by definition and is checked for connectivity
  // instead (the walk from the start is recounted, and a run that severs anything
  // is taken back)
  const roomPits = [...L.pits].filter((k) => {
    if (L.voids.has(k)) return false;
    const [c, r] = k.split(",").map(Number);
    return !L.isBorderCell(c, r);   // the rim is a hole too, and it is not in a room
  });
  const pitsClear = roomPits.every((k) => {
    const [c, r] = k.split(",").map(Number);
    return L.rooms.some((room) =>
      c >= room.x + 1 && c <= room.x + room.w - 2 &&
      r >= room.y + 1 && r <= room.y + room.h - 2);
  });
  ok(pitsClear, `L${lvl}: room holes keep clear of every room edge (${roomPits.length} of ${L.pits.size})`);
  ok(L.stats.voids === L.voids.size && [...L.voids].every((k) => L.pits.has(k)),
    `L${lvl}: ${L.voids.size} hole cells are corridor voids, and they are holes all the same`);
  const voidOffFloor = [...L.voids].every((k) => {
    const [c, r] = k.split(",").map(Number);
    return !L.rooms.some((room) =>
      c >= room.x && c <= room.x + room.w - 1 && r >= room.y && r <= room.y + room.h - 1);
  });
  ok(voidOffFloor, `L${lvl}: a void is a corridor, never a room`);
  ok(L.roofs.size > 0, `L${lvl}: tunnels roof part of the corridors (${L.roofs.size} cells)`);
  const roofsOffHoles = [...L.roofs].every((k) => !L.pits.has(k) && !L.walls.has(k));
  ok(roofsOffHoles, `L${lvl}: nothing is roofed over a hole, and a roof is not rock`);
  // and the level above is stopped by a roof: it is in the upper solid set but not
  // in the floor one
  {
    const key = [...L.roofs][0];
    if (key) {
      const [c, r] = key.split(",").map(Number);
      const x = L.cellToWorldX(c);
      const z = L.cellToWorldZ(r);
      const liftSkip = (cc, rr) => {
        const h = L.wallKind.get(`${cc},${rr}`) === "O" ? 2.6 : 4.5;
        return h < 3.35;
      };
      ok(!L.hitsWall(x, z), `L${lvl}: on the floor a tunnel is open`);
      ok(L.hitsWall(x, z, RADIUS, liftSkip, L.upperSolids),
        `L${lvl}: but one level up it is a wall`);
      ok(L.upperSolids.has(key) && !L.walls.has(key), `L${lvl}: and only in the upper layer`);
    }
  }
  ok(!L.pits.has(`${L.start.col},${L.start.row}`) && !L.pits.has(`${L.exit.col},${L.exit.row}`),
    `L${lvl}: and never take the start or the exit`);

  // the two collision layers: the craft flies over a hole (and pays to), a walker
  // goes round it because there is no ground to walk on
  const hole = [...L.pits][0];
  if (hole) {
    const [hc, hr] = hole.split(",").map(Number);
    const hx = L.cellToWorldX(hc);
    const hz = L.cellToWorldZ(hr);
    ok(!L.hitsWall(hx, hz), `L${lvl}: nothing stops the craft at a hole - it is open air`);
    ok(L.holeAt(hx, hz), `L${lvl}: and there is no ground under it`);
    ok(L.hitsGround(hx, hz), `L${lvl}: a walker is stopped by it all the same`);
    ok(!L.holeAt(L.cellToWorldX(L.start.col), L.cellToWorldZ(L.start.row)),
      `L${lvl}: while the start pad is on solid floor`);
  }
  // vaults: a sealed pocket with a pad in it
  for (const v of L.vaults) {
    const pad = L.lifts.find((l) => l.col === v.col && l.row === v.row && l.vault);
    ok(!!pad, `L${lvl}: the vault pocket has a pad in it (${v.col},${v.row})`);
    ok(!L.hitsWall(L.cellToWorldX(v.col), L.cellToWorldZ(v.row)), `L${lvl}: and the pocket itself is floor`);
    // the floor way in is shut: every side of the pocket is rock
    const sealed = [[1, 0], [-1, 0], [0, 1], [0, -1]]
      .every(([dc, dr]) => L.walls.has(`${v.col + dc},${v.row + dr}`));
    ok(sealed, `L${lvl}: a vault only opens from above`);
  }
  if (L.vaults.length) {
    ok(L.vaults.every((v) => !L.upper.has(`${v.col},${v.row}`)), `L${lvl}: the pocket itself stays open`);
  }

  // the point of the upper level: a pad has to be near enough to use it
  const padNear = L.lifts.some((l) => [...L.upper].some((k) => {
    const [c, r] = k.split(",").map(Number);
    return Math.abs(c - l.col) <= 4 && Math.abs(r - l.row) <= 4;
  }));
  ok(padNear, `L${lvl}: a lift pad stands beside the level above`);
}

/* a level built before the lift is introduced has none of it - only the rim */
for (const lvl of [1, 2, 3]) {
  const L = createLevel({ cols: 25, rows: 25, seed: 1000 + lvl, liftCount: 0, upper: false });
  const inner = [...L.pits].filter((k) => {
    const [c, r] = k.split(",").map(Number);
    return !L.isBorderCell(c, r);
  });
  ok(L.upper.size === 0 && inner.length === 0 && L.lifts.length === 0,
    `L${lvl}: with the lift switched off there is no level above and no holes in the floor`);
  ok(L.pits.size > 0, `L${lvl}: but the rim of nothing is always there (${L.pits.size} cells)`);
}

/* lift pads: the way up onto the deck above the maze */
for (const [lvl, cols, rows, count] of [[1, 25, 25, 2], [3, 29, 29, 3], [8, 39, 39, 5]]) {
  const L = createLevel({ cols, rows, seed: 1000 + lvl, liftCount: count });
  const plain = L.lifts.filter((l) => !l.vault);

  ok(plain.length === count, `L${lvl}: ${plain.length} lift pads on the level`);
  ok(new Set(L.lifts.map((l) => `${l.col},${l.row}`)).size === L.lifts.length,
    `L${lvl}: every pad has its own cell`);

  const roomy = plain.every(({ col, row }) => {
    if (L.walls.has(`${col},${row}`)) return false;
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      if (L.walls.has(`${col + dc},${row + dr}`)) return false;
    }
    return true;
  });
  ok(roomy, `L${lvl}: pads sit on open floor with room around them`);

  const away = plain.every(({ col, row }) =>
    Math.abs(col - L.start.col) + Math.abs(row - L.start.row) >= 3 &&
    Math.abs(col - L.exit.col) + Math.abs(row - L.exit.row) >= 4);
  ok(away, `L${lvl}: pads are kept off the start pad and the exit cell`);

  // every pad can be driven to, and the closest one is a run short of the exit
  {
    const seen = new Set([`${L.start.col},${L.start.row}`]);
    const q = [[L.start.col, L.start.row]];
    for (let i = 0; i < q.length; i++) {
      const [c, r] = q[i];
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const cc = c + dc;
        const rr = r + dr;
        if (cc < 1 || rr < 1 || cc >= cols - 1 || rr >= rows - 1) continue;
        const k = `${cc},${rr}`;
        if (L.walls.has(k) || seen.has(k)) continue;
        seen.add(k);
        q.push([cc, rr]);
      }
    }
    ok(plain.every(({ col, row }) => seen.has(`${col},${row}`)), `L${lvl}: every pad can be driven to`);
    const toExit = Math.min(...plain.map(({ col, row }) => Math.abs(col - L.exit.col) + Math.abs(row - L.exit.row)));
    ok(toExit <= 8, `L${lvl}: one pad is a short run from the exit (${toExit} cells)`);
  }
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL TESTS PASSED");
process.exit(failures ? 1 : 0);
