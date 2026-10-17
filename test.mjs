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
    a.exit.col === b.exit.col && a.exit.row === b.exit.row;
  ok(same, "same seed produces the same level");
}

/* per-level checks */
for (const [lvl, cols, rows] of [[1, 25, 25], [3, 29, 29], [8, 39, 39]]) {
  const L = createLevel({ cols, rows, seed: 1000 + lvl });

  ok(L.cols === cols && L.rows === rows, `L${lvl}: grid is ${cols}x${rows}`);

  let borderOk = true;
  for (let c = 0; c < cols; c++) if (!L.walls.has(`${c},0`) || !L.walls.has(`${c},${rows - 1}`)) borderOk = false;
  for (let r = 0; r < rows; r++) if (!L.walls.has(`0,${r}`) || !L.walls.has(`${cols - 1},${r}`)) borderOk = false;
  ok(borderOk, `L${lvl}: walls fully enclose the level`);

  ok(!L.walls.has(`${L.start.col},${L.start.row}`), `L${lvl}: start cell is open`);
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
            const kk = `${a + dc},${b + dr}`;
            if (L.walls.has(kk) || seen.has(kk)) continue;
            seen.add(kk);
            stack.push([a + dc, b + dr]);
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
    while (!L.walls.has(`${to},${row}`)) to++;
    const from = to - 1;
    const faceX = L.cellToWorldX(to) - CELL / 2;
    let cx = L.cellToWorldX(from);
    const cz = L.cellToWorldZ(row);
    for (let i = 0; i < 400; i++) { const r = L.slide(cx, cz, 0.3, 0); cx = r.x; }
    const want = faceX - COLL - 0.002;
    ok(Math.abs(cx - want) < 0.06 && !L.hitsWall(cx, cz), `L${lvl}: +x cast stops flush at the wall`);
  }
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL TESTS PASSED");
process.exit(failures ? 1 : 0);
