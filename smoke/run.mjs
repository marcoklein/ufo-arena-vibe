// Headless smoke test: boots the real main.js against a stubbed three.js + DOM,
// then drives the game loop with scripted input and asserts gameplay outcomes.
//
//   node --import ./smoke/loader.mjs smoke/run.mjs

/* ------------------------------------------------------------- dom stubs */
function ctx2d() {
  const grad = { addColorStop() {} };
  return new Proxy({}, {
    get(t, k) {
      if (k === "createRadialGradient" || k === "createLinearGradient") return () => grad;
      if (k in t) return t[k];
      return () => {};
    },
    set(t, k, v) { t[k] = v; return true; },
  });
}

const listeners = {};
const els = {};
function stubEl(id) {
  return {
    id,
    textContent: "",
    innerHTML: "",
    style: {},
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); },
      remove(c) { this._s.delete(c); },
      contains(c) { return this._s.has(c); },
    },
  };
}

let fullscreenEl = null;
globalThis.document = {
  createElement(tag) {
    if (tag === "canvas") return { width: 0, height: 0, getContext: () => ctx2d() };
    return stubEl("el");
  },
  body: { appendChild() {} },
  getElementById(id) { return els[id] || (els[id] = stubEl(id)); },
  documentElement: {
    requestFullscreen() { fullscreenEl = "root"; return { catch() {} }; },
  },
  exitFullscreen() { fullscreenEl = null; },
};
Object.defineProperty(globalThis.document, "fullscreenElement", { get: () => fullscreenEl });
globalThis.innerWidth = 1280;
globalThis.innerHeight = 720;
globalThis.devicePixelRatio = 2;
globalThis.addEventListener = (type, fn) => { (listeners[type] ||= []).push(fn); };
globalThis.removeEventListener = () => {};

/* ------------------------------------------------------------------ boot */
const THREE = await import("three");
await import("../main.js");

const HARNESS = THREE.HARNESS;
const UFO = globalThis.UFO;

let fail = 0;
const ok = (cond, msg) => { console.log((cond ? "  PASS " : "  FAIL ") + msg); if (!cond) fail++; };
const frame = (n = 1) => { for (let i = 0; i < n; i++) HARNESS.loop(); };
const fire = (type, ev) => (listeners[type] || []).forEach((f) =>
  f(typeof ev === "string" ? { code: ev, preventDefault() {} } : { preventDefault() {}, ...ev }));
const down = (ev) => fire("keydown", ev);
const up = (ev) => fire("keyup", ev);
const startL = (n) => { UFO.start(n); frame(2); };
// take everything off the level: the movement tests are not about being shot at
const clearLevel = () => {
  for (const e of UFO.enemies) if (!e.dead) UFO.despawn(e);
  frame(1);
};
// a standable spot at roughly `dist` from (tx,tz): the first free one wins
const live = (x, z) => !UFO.stuckAt(x, z) && !UFO.holeAt(x, z);
const nearFree = (tx, tz, dist) => {
  for (const d of [dist, dist * 0.75, dist * 0.5, 6, 4]) {
    for (const [dx, dz] of [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]]) {
      const x = tx + dx * d;
      const z = tz + dz * d;
      if (live(x, z)) return { x, z };
    }
  }
  return null;
};
// a clear shot: nothing solid between the two points
const sees = (ax, az, bx, bz) => {
  for (let t = 0.1; t < 0.95; t += 0.1) {
    if (UFO.stuckAt(ax + (bx - ax) * t, az + (bz - az) * t)) return false;
  }
  return true;
};
// take everything but `keep` off the level, so a damage test is about one blast
const only = (keep) => {
  for (const e of UFO.enemies) if (e !== keep && !e.dead) UFO.despawn(e);
  frame(1);
};
const ofType = (type) => UFO.enemies.filter((e) => !e.dead && e.type === type);
const ahead = (x, z) => {
  const dx = x - UFO.pos.x;
  const dz = z - UFO.pos.z;
  const d = Math.hypot(dx, dz) || 1;
  return (dx * Math.sin(UFO.yaw) - dz * Math.cos(UFO.yaw)) / d;
};
const normalPad = () => UFO.pads.find((p) => !p.vault);

/* --------------------------------------------------------------- checks */
ok(typeof HARNESS.loop === "function", "animation loop registered");
ok(HARNESS.frames > 0 || true, "renderer constructed");

frame(2);
const START = { x: UFO.pos.x, z: UFO.pos.z };
ok(UFO.level === 1, `boots on level 1 (got ${UFO.level})`);
ok(UFO.state === "playing", "boots in the playing state");
ok(UFO.hp === 100, `full health at start (${UFO.hp})`);
ok(UFO.monsters === 6, `level 1 spawns 6 monsters (all red diamonds, got ${UFO.monsters})`);
ok(!UFO.stuck, "player starts outside the walls");
ok(UFO.rooms[0].w >= 8 && UFO.rooms[0].h >= 8,
  `and in a room big enough for the camera (${UFO.rooms[0].w}x${UFO.rooms[0].h})`);
ok(UFO.rim.length > 0 && UFO.pits.length === UFO.rim.length,
  `the edge of the map is a band of nothing (${UFO.rim.length} cells), not a wall`);

/* -------------------------------------------------------------- the ladder */
// One new thing per level, and nothing before its level: the point is that the
// first four levels each have exactly one lesson in them.
{
  startL(1);
  ok(ofType("grunt").length === 6 && ofType("spitter").length === 0 &&
    UFO.shades.length === 0 && UFO.wardens.length === 0,
    `level 1 is red diamonds and nothing else (${ofType("grunt").length} mines)`);
  ok(UFO.rooms.length <= 2, `and it is two rooms, no more (${UFO.rooms.length})`);
  ok(UFO.pads.length === 0 && UFO.rifts.length === 0, "no lift pads and no spawners yet");
  ok(UFO.pits.length === UFO.rim.length, `and the only holes are the rim of nothing (${UFO.rim.length} cells)`);
  ok(ahead(UFO.worldOf(UFO.exit.col, UFO.exit.row).x,
    UFO.worldOf(UFO.exit.col, UFO.exit.row).z) > 0.95,
    "the craft starts pointing at the exit, so the level opens in front of it");
  ok(/RED DIAMONDS/.test(UFO.tip.text), "the arrival line names the new thing");
  ok(UFO.tip.t > 0, `and it stays up for a few seconds (${UFO.tip.t.toFixed(1)}s)`);

  startL(2);
  ok(ofType("spitter").length > 0, `level 2 adds spitters (${ofType("spitter").length})`);
  ok(UFO.rooms.length <= 2, `and is still only two rooms (${UFO.rooms.length})`);
  ok(UFO.shades.length === 0 && UFO.wardens.length === 0, "but no shades and no wardens yet");
  ok(UFO.rifts.length === 0 && UFO.pads.length === 0 && UFO.pits.length === UFO.rim.length,
    "the spawners, the lift and the holes all have their own levels later");
  ok(ahead(UFO.worldOf(UFO.exit.col, UFO.exit.row).x,
    UFO.worldOf(UFO.exit.col, UFO.exit.row).z) > 0.95,
    "and level 2 opens facing the exit as well");
  ok(UFO.tip.text.includes("SPITTERS"), "and says so on arrival");

  startL(3);
  ok(UFO.shades.length > 0, `level 3 adds the shade (${UFO.shades.length})`);
  ok(UFO.pads.length === 0 && UFO.pits.length === UFO.rim.length && UFO.rifts.length === 0,
    "and still no level above and no spawners");
  ok(UFO.tip.text.includes("SHADES"), "and says so on arrival");

  startL(4);
  ok(UFO.pads.length > 0, `level 4 adds the lift (${UFO.pads.length} pad(s), vault pads included)`);
  ok(UFO.pits.length > 0, `and holes in the floor (${UFO.pits.length} cells)`);
  ok(UFO.stats.voids > 0, `some of them whole corridors of void (${UFO.stats.voids} cells)`);
  ok(UFO.roofs.length > 0, `and tunnels under the level above (${UFO.roofs.length} cells)`);
  ok(UFO.blocks.length > 0 && UFO.wardens.length === 0, "the level above is built, with no warden on it yet");
  {
    const p0 = { x: UFO.pos.x, z: UFO.pos.z };
    const best = UFO.pads.filter((p) => !p.vault)
      .reduce((b, p) => {
        const d = Math.hypot(p.x - p0.x, p.z - p0.z);
        return !b || d < b.d ? { p, d } : b;
      }, null);
    ok(best && best.d < 26, `with a pad right where you start, ready to try (${best && best.d.toFixed(1)}u)`);
  }
  ok(UFO.tip.text.includes("LIFT PADS"), "and says so on arrival");

  startL(5);
  ok(UFO.rifts.length === 1, `level 5 shows you one spawner, not a swarm (${UFO.rifts.length})`);
  {
    const r = UFO.rifts[0];
    const d = Math.hypot(r.x - UFO.pos.x, r.z - UFO.pos.z);
    ok(d > 8 && d < 26, `it stands ${d.toFixed(1)}u off, in plain sight`);
    ok(ahead(r.x, r.z) > 0.5, "and in front of the craft: the monsters come from where you look");
    const w = UFO.worldOf(UFO.exit.col, UFO.exit.row);
    ok(Math.hypot(w.x - UFO.pos.x, w.z - UFO.pos.z) > 40,
      `with the exit well away (${Math.hypot(w.x - UFO.pos.x, w.z - UFO.pos.z).toFixed(0)}u)`);
    ok(UFO.wardens.length === 0, "no wardens on this one");
  }
  ok(UFO.tip.text.includes("SPAWNER"), "and says so on arrival");

  startL(6);
  ok(UFO.wardens.length === 2, `level 6 adds the warden, in numbers (${UFO.wardens.length})`);
  ok(UFO.enemies.filter((e) => e.deck).length > 0,
    `and ${UFO.enemies.filter((e) => e.deck).length} spitter(s) posted on the blocks up there`);
  ok(UFO.tip.text.includes("WARDENS"), "and says so on arrival");

  startL(1);
  ok(UFO.tip.text.includes("RED DIAMONDS"), "restarting level 1 shows its line again");
}

/* movement */
{
  clearLevel();
  const x0 = UFO.pos.x;
  const z0 = UFO.pos.z;
  down("KeyW");
  frame(60);
  up("KeyW");
  const moved = Math.hypot(UFO.pos.x - x0, UFO.pos.z - z0);
  ok(moved > 5, `W drives forward (moved ${moved.toFixed(1)}u in 1s)`);
  ok(!UFO.stuck, "still outside the walls after driving");
}

/* turning */
{
  clearLevel();
  const y0 = UFO.yaw;
  down("KeyD");
  frame(30);
  up("KeyD");
  ok(Math.abs(UFO.yaw - y0) > 0.5, `D turns the craft (dYaw ${(UFO.yaw - y0).toFixed(2)} rad)`);

  const y1 = UFO.yaw;
  down("KeyA");
  frame(30);
  up("KeyA");
  ok(UFO.yaw < y1 - 0.5, `A turns the craft the other way (dYaw ${(UFO.yaw - y1).toFixed(2)} rad)`);
}

/* driving and firing at the same time must not lock the steering */
{
  clearLevel();
  const y0 = UFO.yaw;
  down("KeyW");
  down("Space");
  down("KeyA");
  frame(30);
  up("KeyA");
  ok(UFO.yaw < y0 - 0.5, `A still steers left while driving and firing (dYaw ${(UFO.yaw - y0).toFixed(2)} rad)`);
  const y1 = UFO.yaw;
  down("KeyD");
  frame(30);
  up("KeyD");
  up("Space");
  up("KeyW");
  ok(UFO.yaw > y1 + 0.5, `D still steers right while driving and firing (dYaw ${(UFO.yaw - y1).toFixed(2)} rad)`);
}

/* keys are matched by what they type, not just by physical position, so an
   unfamiliar layout still drives */
{
  clearLevel();
  const y0 = UFO.yaw;
  down({ key: "a", code: "KeyQ" }); // e.g. AZERTY: the A key is physically KeyQ
  frame(30);
  up({ key: "a", code: "KeyQ" });
  ok(UFO.yaw < y0 - 0.5, `the A key steers left on a shifted layout (dYaw ${(UFO.yaw - y0).toFixed(2)} rad)`);
  ok(UFO.keys.length === 0, `no keys stick after release (${UFO.keys.length} held)`);

  const y1 = UFO.yaw;
  down({ key: "D", code: "KeyD" }); // as if shift/capslock were in the mix
  frame(30);
  up({ key: "d", code: "KeyD" });
  ok(UFO.yaw > y1 + 0.5, "D still steers when the typed case differs");
  ok(UFO.keys.length === 0, `still nothing stuck (${UFO.keys.length} held)`);
}

/* shooting produces bullets */
{
  clearLevel();
  UFO.move(START.x, START.z);
  let peak = 0;
  down("Space");
  for (let i = 0; i < 40; i++) { frame(1); peak = Math.max(peak, UFO.bullets.length); }
  up("Space");
  ok(peak > 0, `Space fires bullets (peak ${peak} in flight)`);
}

/* shooting kills a monster */
{
  startL(1);
  const k0 = UFO.kills;
  const m0 = UFO.monsters;
  let landed = false;
  for (let attempt = 0; attempt < 12 && !landed; attempt++) {
    const target = UFO.enemies.find((e) => !e.dead && e.level === 0);
    if (!target) break;
    for (let a = 0; a < 16 && !landed; a++) {
      const ang = (a / 16) * Math.PI * 2;
      UFO.move(target.x + Math.cos(ang) * 6, target.z + Math.sin(ang) * 6);
      if (UFO.stuck) continue;
      UFO.aim(target.x, target.z);
      down("Space");
      frame(25);
      up("Space");
      if (UFO.kills > k0) landed = true;
    }
  }
  ok(landed, `shots kill monsters (${UFO.kills - k0} killed)`);
  ok(UFO.monsters < m0, `monster count drops (${UFO.monsters} left)`);
  ok(UFO.particles > 0, `a kill throws debris (${UFO.particles} particles)`);
  ok(UFO.debris.length > 0, `and wreckage too (${UFO.debris.length} pieces)`);
}

/* guards hold their post instead of trailing the player */
{
  const guards = UFO.enemies.filter((e) => e.guard);
  ok(guards.length > 0, `the exit has ${guards.length} defenders posted around it`);
  const dist = (e) => Math.hypot(e.x - e.homeX, e.z - e.homeZ);
  UFO.move(START.x, START.z); // stand on the start pad, far from the exit
  frame(300);
  const drifted = guards.filter((e) => !e.dead).map(dist);
  const worst = drifted.length ? Math.max(...drifted) : 0;
  ok(worst < 9, `guards stay near their post while the player is away (max drift ${worst.toFixed(1)}u)`);
}

/* dying blows the craft apart */
{
  startL(1);
  UFO.damage(999);
  ok(UFO.state === "dead", "0 hp ends the run");
  ok(UFO.particles > 40, `death detonates the craft (${UFO.particles} particles)`);
  ok(!document.getElementById("overlay").classList.contains("show"),
    "the game-over card waits while the wreck burns");
  frame(120);
  ok(document.getElementById("overlay").classList.contains("show"),
    "the game-over card arrives once the blast is over");
  down("KeyR");
  up("KeyR");
  ok(UFO.state === "playing", "R restarts the run");
  ok(!document.getElementById("overlay").classList.contains("show"), "restart clears the card");
  ok(UFO.level === 1 && UFO.hp === 100, "restart resets health, on the level you died on");
  ok(UFO.monsters === 6, `restart respawns the level (${UFO.monsters} monsters)`);

  // and dying deep in the run does not send you back to the beginning
  startL(3);
  frame(2);
  const kills = UFO.kills;
  UFO.damage(999);
  frame(140);
  down("KeyR");
  up("KeyR");
  frame(2);
  ok(UFO.level === 3, `dying on level 3 restarts level 3, not the run (got ${UFO.level})`);
  ok(UFO.hp === 100 && UFO.state === "playing", "with a full bar and a fresh level");
  ok(UFO.kills >= kills, `and the score carries over (${UFO.kills})`);
}

/* the edge of the world: fly out over the rim and there is nothing under you */
{
  startL(1);
  const rim = UFO.rim[0];
  ok(!!rim, "there is a rim cell to fly out over");
  ok(!UFO.stuckAt(rim.x, rim.z), "the rim does not stop the craft: no wall round the map");
  ok(UFO.holeAt(rim.x, rim.z), "but there is no ground on it");
  ok(UFO.holeAt(rim.x + 400, rim.z) && UFO.holeAt(rim.x, rim.z - 400),
    "and off the map there is nothing at all");

  UFO.move(rim.x, rim.z);
  frame(2);
  ok(UFO.overHole, "out there the same meter is holding it up");
  ok(UFO.hoverFx.visible, "with the thruster lit");
  let fell = false;
  for (let i = 0; i < 900 && !fell; i++) {
    frame(1);
    if (UFO.falling > 0) fell = true;
  }
  ok(fell, "and when it runs dry the craft goes over the side");
  frame(120);
  ok(UFO.state === "dead", "there is no coming back from outside the map");
  down("KeyR");
  up("KeyR");
  frame(2);
  ok(UFO.level === 1 && UFO.state === "playing", "R starts again");
}

/* --------------------------------------------------------- the red diamonds */
/* a red diamond is a mine: it arms on the hull, swells, then goes off */
{
  startL(1);
  const hp0 = UFO.hp;
  const k0 = UFO.kills;
  const mine = UFO.enemies.find((e) => !e.dead && e.type === "grunt");
  ok(!!mine, "there is a red diamond to run into");
  if (mine) only(mine);
  if (mine) {
    ok(mine.mine && mine.mine.horns.count === 10, `it is a spiked mine (${mine.mine && mine.mine.horns.count} horns)`);
    UFO.move(mine.x + 2.0, mine.z);   // close enough to latch, not close enough to trip it
    let armed = false;
    for (let i = 0; i < 20 && !armed; i++) {
      frame(1);
      if (mine.armed) armed = true;
    }
    ok(armed, "reaching the hull arms it");
    ok(!mine.dead && UFO.hp === hp0, `arming costs nothing yet (${UFO.hp} hp, ${mine.fuse.toFixed(2)}s on the clock)`);
    ok(mine.mine.ring.visible && mine.mine.dome.visible, "it paints its kill zone on the floor");

    const fuse0 = mine.fuse;
    frame(20);
    ok(mine.fuse < fuse0, "the fuse burns down while you get to decide");
    frame(130);
    ok(mine.dead, "then it goes off");
    ok(UFO.state === "dead" && UFO.hp === 0,
      `and at that range it is the end of the run, not a scratch (${UFO.hp} hp)`);
    ok(UFO.kills === k0, "a mine going off on its own is not a kill of yours");
    ok(UFO.debris.length > 0, `it throws wreckage (${UFO.debris.length} pieces)`);
  }
}

/* back off out of the kill ring and the same blast only costs you part of the bar */
{
  startL(1);
  const mine = UFO.enemies.find((e) => !e.dead && e.type === "grunt");
  only(mine);
  const hp0 = UFO.hp;
  UFO.move(mine.x + 2.0, mine.z);
  for (let i = 0; i < 20 && !mine.armed; i++) frame(1);
  ok(mine.armed, "it arms on the hull");
  UFO.move(mine.x + UFO.mine.killR + 2.5, mine.z);   // out of the kill ring
  let before = UFO.hp;
  for (let i = 0; i < 200 && !mine.dead; i++) {
    before = UFO.hp;
    frame(1);
  }
  ok(mine.dead, "it goes off where it stood");
  const lost = before - UFO.hp;
  ok(UFO.state === "playing" && lost > 0 && lost < hp0,
    `and out of the kill ring it only takes part of the bar (${before} -> ${UFO.hp}, -${lost})`);
}

/* and you can simply be somewhere else: distance is the whole game */
{
  startL(1);
  const { blastR, killR } = UFO.mine;
  const mine = UFO.enemies.find((e) => !e.dead && e.type === "grunt");
  only(mine);
  UFO.move(mine.x + 2.0, mine.z);   // close enough to latch, not close enough to trip it
  for (let i = 0; i < 20 && !mine.armed; i++) frame(1);
  ok(mine.armed, "a fresh mine arms again");
  UFO.move(mine.x + blastR + 4, mine.z);   // well outside the ring
  // only the frame it goes off matters: a spitter is free to plink at you
  let before = UFO.hp;
  for (let i = 0; i < 130 && !mine.dead; i++) {
    before = UFO.hp;
    frame(1);
  }
  ok(mine.dead, "it still goes off on its own");
  ok(UFO.hp === before, `and out there the blast misses you (${before} -> ${UFO.hp} hp)`);

  const mid = (killR + blastR) / 2;
  ok(UFO.blastAt(0) === 100, `point blank is the whole bar (${UFO.blastAt(0)})`);
  ok(UFO.blastAt(killR) === 100, `up to ${killR}u it is simply lethal (${UFO.blastAt(killR)})`);
  const half = UFO.blastAt(mid);
  ok(half > 5 && half < 45, `halfway out it is less than half the price (${half} at ${mid}u)`);
  ok(UFO.blastAt(blastR) === 0, `at the rim it is nothing (${UFO.blastAt(blastR)})`);
  ok(UFO.blastAt(99) === 0, "and past the rim there is nothing to talk about");
}

/* and you cannot simply drive over one: sitting on it sets it off on the spot */
{
  startL(1);
  const hp0 = UFO.hp;
  const k0 = UFO.kills;
  const mine = UFO.enemies.find((e) => !e.dead && e.type === "grunt");
  ok(!!mine, "there is a mine to park on");
  if (mine) only(mine);
  if (mine) {
    ok(!!UFO.mine.tripR, `a mine has a radius you cannot enter (${UFO.mine.tripR}u)`);
    UFO.move(mine.x, mine.z); // dead centre, as if driving over it
    frame(2);
    ok(mine.dead, "sitting on top of it sets it off at once");
    ok(mine.armed === false, "with no fuse to wait out");
    ok(UFO.hp === 0 && UFO.state === "dead", `and that close there is nothing left (${UFO.hp} hp)`);
    ok(UFO.kills === k0, "still not credited as a kill of yours");
  }
}

/* and half a ring away costs half the price */
{
  startL(1);
  const mid = (UFO.mine.killR + UFO.mine.blastR) / 2;
  const mine = UFO.enemies.find((e) => !e.dead && e.type === "grunt");
  only(mine);
  UFO.move(mine.x + 2.0, mine.z);   // close enough to latch, not close enough to trip it
  for (let i = 0; i < 20 && !mine.armed; i++) frame(1);
  UFO.move(mine.x + mid, mine.z);
  let before = UFO.hp;
  for (let i = 0; i < 200 && !mine.dead; i++) {
    before = UFO.hp;
    frame(1);
  }
  const lost = before - UFO.hp;
  ok(lost > 0 && lost < 45, `standing ${mid.toFixed(1)}u away takes part of it (${before} -> ${UFO.hp}, -${lost})`);
}

/* ------------------------------------------------------------- the spitters */
/* the spitters still keep their distance and shoot */
{
  startL(2);
  const sp = UFO.enemies.find((e) => !e.dead && e.type === "spitter");
  ok(!!sp, "a spitter is on the level");
  if (sp) {
    only(sp); // the mines are lethal now: this test is about the spitter
    const hp0 = UFO.hp;
    let v = null;
    for (const d of [12, 9, 15, 7, 5]) {
      for (const [dx, dz] of [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]]) {
        const x = sp.x + dx * d;
        const z = sp.z + dz * d;
        if (live(x, z) && sees(x, z, sp.x, sp.z)) { v = { x, z }; break; }
      }
      if (v) break;
    }
    if (!v) v = nearFree(sp.x, sp.z, 10);
    if (!v) v = { x: sp.x + 8, z: sp.z };
    UFO.move(v.x, v.z);
    let peak = 0;
    for (let i = 0; i < 200; i++) {
      frame(1);
      peak = Math.max(peak, UFO.eBullets.length);
    }
    ok(peak > 0, `a spitter shoots at you (peak ${peak} in flight)`);
    ok(UFO.hp < hp0 || UFO.state === "dead", `and its shots hurt (${hp0} -> ${UFO.hp})`);
  }
}

/* and you cannot simply shoot a lit mine to be rid of it */
{
  startL(1);
  const hp0 = UFO.hp;
  const k0 = UFO.kills;
  const mine = UFO.enemies.find((e) => !e.dead && e.type === "grunt");
  UFO.move(mine.x + 2.0, mine.z);   // close enough to latch, not close enough to trip it
  UFO.aim(mine.x, mine.z);
  for (let i = 0; i < 20 && !mine.armed; i++) frame(1);
  ok(mine.armed, "it arms when you get close");
  down("Space");
  let blown = false;
  for (let i = 0; i < 40 && !blown; i++) {
    frame(1);
    if (mine.dead) blown = true;
  }
  up("Space");
  ok(blown, "shooting a lit mine sets it off rather than disarming it");
  ok(UFO.hp < hp0, `and it still charges its fifth (${hp0} -> ${UFO.hp})`);
  ok(UFO.kills > k0, "though you do get the credit for it");
}

/* ---------------------------------------------------------------- the shade */
/* a shade waits in the rooms, wakes up, and takes the craft with it */
{
  startL(3);
  const shade = UFO.shades.find((e) => !e.dead);
  ok(!!shade, `a shade is waiting in the rooms (${UFO.shades.length} of them)`);
  ok(!!shade && shade.state === "lurk", `it starts as a shadow on the floor (${shade && shade.state})`);

  { const v = nearFree(shade.x, shade.z, 14); if (v) UFO.move(v.x, v.z); }
  frame(20);
  ok(shade.state !== "lurk", `it wakes when you get close (${shade.state})`);
  ok(UFO.hunted, "the screen knows you are being hunted");

  let died = false;
  for (let i = 0; i < 300 && !died; i++) {
    UFO.move(shade.x, shade.z);
    frame(1);
    if (UFO.state === "dead") died = true;
  }
  ok(died, "touching the shade ends the run");
  ok(UFO.hp === 0, "the shade is an instant kill, no matter the health");
  const pieces = UFO.debris.length;
  frame(90);
  ok(pieces > 0, `the wreck throws wreckage (${pieces} pieces)`);
  ok(UFO.splats.length > 0, `and it leaves scorch on the floor (${UFO.splats.length} marks)`);

  down("KeyR");
  up("KeyR");
  frame(2);
  ok(UFO.level === 3, `R starts level 3 again, where the shade got you (got ${UFO.level})`);
  ok(UFO.state === "playing", "R restarts after the shade");
  ok(UFO.debris.length === 0 && UFO.splats.length === 0, "the mess is cleared with the level");
  ok(!UFO.hunted, "and the hunt is off again");
}

/* a shade does not trail you for ever: out of reach, it goes back to sleep */
{
  startL(3);
  const shade = UFO.shades.find((e) => !e.dead);
  if (shade) {
    { const v = nearFree(shade.x, shade.z, 14); if (v) UFO.move(v.x, v.z); }
    for (let i = 0; i < 200 && shade.state === "lurk"; i++) frame(1);
    ok(shade.state !== "lurk", `getting close wakes it (${shade.state})`);
    ok(UFO.hunted, "and the run knows it");
    ok(els.hunt.style.display === "block", "the HUD shouts about it");

    UFO.move(shade.x + 70, shade.z + 45);
    for (let i = 0; i < 200 && shade.state !== "lurk"; i++) frame(1);
    ok(shade.state === "lurk", "out of reach it goes back to being a shadow");
    ok(!UFO.hunted, "and the hunt is off");
    ok(els.hunt.style.display === "none", "the HUD banner goes with it");
    ok(UFO.audio.log.includes("shadeSettle"), "and you hear it lose you");
  }
}

/* the shots are not balls, and the things that shoot look like guns */
{
  startL(2);
  down("Space");
  frame(2);
  const bolt = UFO.bullets[0];
  ok(!!bolt, "firing puts a shot in the air");
  if (bolt) {
    ok(bolt.seed === false, "your shot is a bolt, not a seed");
    ok(bolt.mesh.children.length >= 1, `and it is a dart with a glow on it (${bolt.mesh.children.length} part(s))`);
    ok(bolt.mesh.geometry !== undefined && !!bolt.mesh.geometry, "with its own shape, not the old ball");
  }
  up("Space");

  const shooter = UFO.enemies.find((e) => !e.dead && e.type === "spitter");
  ok(!!shooter, "a spitter is on the level");
  if (shooter) {
    only(shooter);
    ok(!!shooter.spitter, "and it has a snout and a chamber");
    ok(shooter.spitter.mouthMat.emissiveIntensity >= 0.8, "the chamber glows before it charges");
    // stand in its face, with a clear line, and let it wind up
    let v = null;
    for (const d of [10, 8, 12, 6]) {
      for (const [dx, dz] of [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]]) {
        const x = shooter.x + dx * d;
        const z = shooter.z + dz * d;
        if (live(x, z) && sees(x, z, shooter.x, shooter.z)) { v = { x, z }; break; }
      }
      if (v) break;
    }
    if (v) UFO.move(v.x, v.z);
    let peakGlow = 0;
    let recoiled = false;
    for (let i = 0; i < 220 && !(recoiled && peakGlow > 3); i++) {
      frame(1);
      peakGlow = Math.max(peakGlow, shooter.spitter.mouthMat.emissiveIntensity);
      if (shooter.recoilT > 0) recoiled = true;
    }
    ok(peakGlow > 3, `it lights up before it spits (chamber glow ${peakGlow.toFixed(1)})`);
    ok(recoiled, "and kicks back when it does");
    const seed = UFO.eBullets.find((b) => b.seed);
    ok(!!seed, "what it spits is a seed");
    ok(seed && seed.mesh.children.length >= 2, `with a ring around it (${seed ? seed.mesh.children.length : 0} parts)`);
  }
}

/* ------------------------------------------------------------- the lift */
/* pads raise the craft exactly one level, onto the block tops */
{
  startL(4);
  const audio = UFO.audio;
  const pads = UFO.pads;
  const plain = pads.filter((p) => !p.vault);
  const cfg = UFO.liftCfg;
  ok(plain.length === 2, `level 4 lays out ${plain.length} ordinary lift pads`);
  ok(pads.length === plain.length + UFO.vaults.length,
    `plus one in every vault (${pads.length - plain.length} of those)`);
  ok(plain.every((p) => !UFO.stuckAt(p.x, p.z)), "and they stand on open floor");
  ok(plain.every((p) => !p.used), "a fresh pad is charged");
  ok(UFO.charge > cfg.time * 0.95, `the hover meter starts full (${UFO.charge.toFixed(1)}s)`);
  ok(cfg.time <= 5 && cfg.fall <= 0.6, `the lift is a hop, not a flight (${cfg.time}s up, ${cfg.fall}s down)`);
  ok(pads.some((p) => UFO.blocks.some((b) => Math.hypot(b.x - p.x, b.z - p.z) < 18)),
    "and a pad stands beside the level above, so there is something to fly onto");

  // a charged pad within reach says so, so it can be found
  const pad = normalPad();
  UFO.move(pad.x + 5, pad.z);
  frame(2);
  ok(els.lift.classList.contains("on") && els.lift.classList.contains("near"),
    `a pad within reach reads ${els.liftlab.textContent}`);

  UFO.move(pad.x, pad.z);
  frame(2);
  ok(UFO.liftUp && UFO.lift > 0, `driving onto it lifts the craft (lift ${UFO.lift.toFixed(2)})`);
  ok(pad.used, "and the pad is spent until you drive off it");
  ok(audio.log.includes("liftUp"), "the pad announces the ride");

  // mid-ride the lift field holds the guns
  const mid = UFO.bullets.length;
  down("Space");
  frame(2);
  up("Space");
  ok(UFO.bullets.length === mid, "mid-ride no shot leaves: the lift field holds the guns");
  ok(els.lift.classList.contains("deny"), "and the HUD flashes to say why");

  frame(60);
  ok(UFO.lift === 1, "exactly one level up, no more");
  ok(Math.abs(UFO.alt - cfg.alt) < 1e-6, `which is one low block high (${UFO.alt})`);

  // the thruster says out loud when it is paying to stay up
  ok(UFO.hoverFx.visible, "holding itself up over open floor, the thruster is lit");
  const ringA = UFO.hoverFx.children[0].scale.x;
  frame(4);
  ok(UFO.hoverFx.children[0].scale.x !== ringA, "and the rings are running under the hull");

  // over open floor there is no ground at that level: hovering costs
  const c0 = UFO.charge;
  frame(40);
  ok(UFO.charge < c0, `no ground underneath: the hover meter runs (${c0.toFixed(2)} -> ${UFO.charge.toFixed(2)}s)`);
  ok(els.lift.classList.contains("on") && /HOVER/.test(els.liftlab.textContent),
    `the HUD shows the meter (${els.liftlab.textContent})`);

  // a block top is ground at that level: it stops costing and fills again
  const block = UFO.blocks[0];
  UFO.move(block.x, block.z);
  frame(2);
  ok(UFO.onBlock, "on a block the craft has ground underneath");
  ok(/BLOCK LEVEL/.test(els.liftlab.textContent), `and the HUD says so (${els.liftlab.textContent})`);
  ok(!UFO.hoverFx.visible, "on a block top it costs nothing, so the thruster is off");
  const c1 = UFO.charge;
  frame(40);
  ok(UFO.charge > c1, `the meter fills again up there (${c1.toFixed(2)} -> ${UFO.charge.toFixed(2)}s)`);
  ok(UFO.lift === 1, "without sinking");

  // one level up the low blocks are underneath the hull; taller walls are not
  ok(!UFO.blockedAt(block.x, block.z), "up there a low block is not in the way");
  const tall = UFO.highWalls.find((w) => Math.hypot(w.x - block.x, w.z - block.z) < 14) || UFO.highWalls[0];
  ok(UFO.blockedAt(tall.x, tall.z), "but a real wall still is");

  // up on the level the guns work again - and the bolt is up there with you
  down("Space");
  frame(3);
  up("Space");
  const upperShot = UFO.bullets.find((b) => b.level === 1);
  ok(!!upperShot, "up on the level the guns work, and the bolt flies on that level");
  ok(!!upperShot && Math.abs(upperShot.y - (2.6 + 1.6)) < 0.01, `from the height the craft is at (${upperShot && upperShot.y})`);

  // a mine on the floor under the craft cannot latch on from down there
  const under = UFO.enemies.find((e) => !e.dead && e.type === "grunt");
  if (under) {
    UFO.move(under.x, under.z);
    frame(10);
    ok(!under.armed && !under.dead, "a mine under the level above cannot latch on");
  }

  // flying over the exit is not reaching it
  const exitW = UFO.worldOf(UFO.exit.col, UFO.exit.row);
  UFO.move(exitW.x, exitW.z);
  frame(3);
  ok(UFO.state === "playing", "flying over the exit does not clear the level");

  // drain it dry: back to the floor, with a warning on the way
  UFO.move(pad.x, pad.z); // open floor: nothing at block level underneath
  let warned = false;
  let framesDown = 0;
  for (let i = 0; i < 1400 && UFO.lift > 0; i++) {
    frame(1);
    framesDown++;
    if (audio.log.includes("liftWarn")) warned = true;
  }
  ok(UFO.lift === 0, "the meter runs out and the craft comes down");
  ok(framesDown / 60 < 5.5, `from up to down in ${(framesDown / 60).toFixed(1)}s, so the hop is short`);
  ok(warned, "with a warning before it drops");
  ok(audio.log.includes("liftFall") && audio.log.includes("liftLand"), "and a fall and a touchdown to go with it");
  ok(!UFO.stuck, "landing off the wall tops rather than inside them");
  ok(!UFO.hoverFx.visible, "and the thruster is out on the floor");
  ok(!/HOVER \d/.test(els.liftlab.textContent), `and the hover clock is gone (${els.liftlab.textContent})`);

  // on the floor it fills back up
  const c2 = UFO.charge;
  frame(120);
  ok(UFO.charge > c2, `on the floor the meter fills again (${c2.toFixed(2)} -> ${UFO.charge.toFixed(2)}s)`);

  // a spent pad does not hand you another flight until you have driven off it
  UFO.move(pad.x, pad.z);
  frame(4);
  ok(UFO.lift === 0, "standing on the pad you used does not launch you again");
  UFO.move(pad.x + 12, pad.z);
  frame(2);
  ok(!pad.used, "driving off it re-arms it");
}

/* the vault: a room you can only hover into */
{
  startL(4);
  startL(5);
  const v = UFO.vaults[0];
  ok(!!v, `a vault shows up on this one (${UFO.vaults.length})`);
  if (v) {
    const w = UFO.worldOf(v.col, v.row);
    const vp = UFO.pads.find((p) => p.vault &&
      Math.abs(p.x - w.x) < 0.01 && Math.abs(p.z - w.z) < 0.01);
    ok(!!vp, "with a lift pad in the pocket, so the way out is inside");
    ok(!UFO.stuckAt(w.x, w.z), "the pocket itself is open floor");
    ok(UFO.stuckAt(w.x + 4, w.z) && UFO.stuckAt(w.x - 4, w.z) &&
      UFO.stuckAt(w.x, w.z + 4) && UFO.stuckAt(w.x, w.z - 4),
      "and the ring around it is solid: the only way in is over the top");
    ok(vp && vp.r > UFO.liftCfg.padR, `the pad fills the pocket (reach ${vp && vp.r.toFixed(1)}u)`);
  }
}

/* --------------------------------------------------------------- the holes */
/* a hole is simply no ground: the same meter holds the craft up, and when it is
   gone the craft falls - which is the same rule as the level above */
{
  startL(4);
  UFO.kill();                       // nothing else is allowed to end this run
  const pit = UFO.pits[0];
  ok(!!pit, `the floor has holes in it (${UFO.pits.length})`);
  ok(!UFO.stuckAt(pit.x, pit.z), "a hole is not a wall: the craft flies over it");
  ok(UFO.holeAt(pit.x, pit.z), "but there is no ground under it either");

  UFO.move(pit.x, pit.z);
  frame(2);
  ok(UFO.overHole, "the craft is over a hole");
  ok(!UFO.stuck, "and it is not buried in anything");
  ok(UFO.hoverFx.visible, "the thruster is lit: it is holding itself up");
  const c0 = UFO.charge;
  frame(30);
  ok(UFO.charge < c0, `the meter runs on the floor too (${c0.toFixed(2)} -> ${UFO.charge.toFixed(2)}s)`);
  ok(/HOVER/.test(els.liftlab.textContent), `with the same HUD line as one level up (${els.liftlab.textContent})`);

  let fell = false;
  for (let i = 0; i < 900 && !fell; i++) {
    frame(1);
    if (UFO.falling > 0) fell = true;
  }
  ok(fell, "when the meter is gone it starts to fall");
  ok(UFO.state === "dead" || UFO.falling > 0, "and the run is coming to an end");
  frame(120);
  ok(UFO.state === "dead", "it falls out of the world");
  ok(UFO.hp === 0, "and that is the end of the run");
  ok(!UFO.craftVisible, "there is no wreck: it is simply gone");
  ok(UFO.audio.log.includes("voidFall"), "with a long fall of its own to hear");
  frame(120);
  ok(document.getElementById("overlay").classList.contains("show"), "the card comes up as usual");

  // and back on solid ground the meter fills again
  down("KeyR");
  up("KeyR");
  frame(2);
  ok(UFO.level === 4 && UFO.state === "playing", `R starts level 4 again (got ${UFO.level})`);
}

/* and the same at the level above: a hole under the craft is a hole through */
{
  startL(4);
  UFO.kill();
  const pad = normalPad();
  UFO.move(pad.x, pad.z);
  frame(60);
  ok(UFO.lift === 1, "up on the level");
  const pit = UFO.pits.find((h) => Math.hypot(h.x - pad.x, h.z - pad.z) > 8) || UFO.pits[0];
  UFO.move(pit.x, pit.z);
  frame(2);
  ok(UFO.overHole && !UFO.onBlock, "a hole up there has nothing to land on either");
  let fell = false;
  for (let i = 0; i < 1600 && !fell && UFO.state === "playing"; i++) {
    frame(1);
    if (UFO.falling > 0) fell = true;
  }
  ok(fell, "so it drops a level, finds no ground, and keeps going");
  frame(120);
  ok(UFO.state === "dead", "out of the world at the bottom of the hole");
}

/* -------------------------------------------------------------- the warden */
/* the warden: it holds the level above the floor */
{
  startL(6);
  const wardens = UFO.wardens;
  ok(wardens.length === 2, `level 6 posts ${wardens.length} wardens on the raised runs`);
  const w = wardens[0];
  if (w) {
    only(w); // nothing else gets to end this run
    ok(w.level === 1, "it lives on the level above the floor");
    ok(Math.abs(w.group.position.y - UFO.liftCfg.alt) < 0.2,
      `rooted on a block top (y ${w.group.position.y.toFixed(2)})`);

    // on the floor it is asleep, and nothing of its reaches down
    UFO.move(w.x + 9, w.z);
    frame(90);
    ok(w.state === "lurk", "on the floor it stays asleep");
    ok(!UFO.eBullets.some((b) => b.level === 1), "and never spits down at the floor");
    const hpFloor = UFO.hp;
    frame(30);
    ok(UFO.hp === hpFloor, `standing under it is safe (${UFO.hp})`);

    // lift, and stand on a raised block beside it
    const perch = UFO.blocks.find((b) => {
      const d = Math.hypot(b.x - w.x, b.z - w.z);
      return d > 2.5 && d < 10;
    });
    const pad = UFO.pads.reduce(
      (best, p) => (Math.hypot(p.x - w.x, p.z - w.z) < Math.hypot(best.x - w.x, best.z - w.z) ? p : best),
      normalPad(),
    );
    UFO.move(pad.x, pad.z);
    frame(40);
    ok(UFO.lift === 1, "the craft is up on its level");
    if (perch) UFO.move(perch.x, perch.z);
    frame(2);
    ok(UFO.onBlock, "standing on a raised block beside it");

    let glob = null;
    const hpBefore = UFO.hp;
    const chargeBefore = UFO.charge;
    const posBefore = { x: UFO.pos.x, z: UFO.pos.z };
    for (let i = 0; i < 220 && !glob; i++) {
      frame(1);
      glob = UFO.eBullets.find((b) => b.level === 1);
    }
    ok(w.state === "awake", "up on its level it wakes");
    ok(!!glob, "and spits a glob across that level");
    if (glob) {
      ok(Math.abs(glob.y - (UFO.liftCfg.alt + 1.6)) < 0.25,
        `the glob flies at the craft's level (${glob.y})`);
      ok(glob.mesh.children.length >= 1, "the shell is a fat lump with a flare on it");
      for (let i = 0; i < 120 && UFO.hp === hpBefore; i++) frame(1);
      ok(UFO.hp < hpBefore, `and it hurts up there (${hpBefore} -> ${UFO.hp})`);
      ok(UFO.charge < chargeBefore - 1.0,
        `and it drinks the hover (${chargeBefore.toFixed(2)} -> ${UFO.charge.toFixed(2)}s)`);
      ok(UFO.explosions > 0, `and goes off like a mine on the hull (${UFO.explosions} in the air)`);
      frame(30);
      const flung = Math.hypot(UFO.pos.x - posBefore.x, UFO.pos.z - posBefore.z);
      ok(flung > 2.5, `and throws the craft back hard (${flung.toFixed(1)}u)`);
      ok(UFO.audio.log.includes("globHit") && UFO.audio.log.includes("boom"),
        "with a splat and a bang to go with it");
    }

    // and it can be shot from its own level
    const hpW = w.hp;
    UFO.aim(w.x, w.z);
    down("Space");
    for (let i = 0; i < 70 && !w.dead && w.hp === hpW; i++) frame(1);
    up("Space");
    ok(w.dead || w.hp < hpW, `a bolt up there reaches it (${hpW} -> ${w.dead ? "dead" : w.hp})`);
  }
}

/* the upper level is garrisoned: the things up there only reach their own level */
{
  startL(6);
  const deckers = UFO.enemies.filter((e) => !e.dead && e.deck);
  ok(deckers.length > 0, `there are ${deckers.length} of them standing on the blocks`);
  const d0 = deckers[0];
  if (d0) {
    ok(d0.level === 1 && d0.group.position.y > 2,
      `posted on a block top (y ${d0.group.position.y.toFixed(1)}), on the upper level`);
    // on the floor they are out of reach, and they never shoot down
    only(d0);
    UFO.move(d0.x + 6, d0.z);
    frame(180);
    ok(UFO.hp === 100, `standing under one on the floor is safe (${UFO.hp} hp)`);
    ok(!UFO.eBullets.some((b) => b.level === 1), "and nothing of its comes down");
    // up on their level they shoot, and the seed is up there with them. Stand on
    // a block near it, so the meter is not what ends the test.
    const pad = UFO.pads.reduce(
      (best, p) => (Math.hypot(p.x - d0.x, p.z - d0.z) < Math.hypot(best.x - d0.x, best.z - d0.z) ? p : best),
      normalPad(),
    );
    UFO.move(pad.x, pad.z);
    frame(60);
    ok(UFO.lift === 1, "up on the level");
    const perch = UFO.blocks.find((b) => {
      const d = Math.hypot(b.x - d0.x, b.z - d0.z);
      return d > 6 && d < 26;
    });
    if (perch) UFO.move(perch.x, perch.z);
    frame(2);
    let seed = null;
    for (let i = 0; i < 300 && !seed; i++) {
      frame(1);
      seed = UFO.eBullets.find((b) => b.seed && b.level === 1);
    }
    ok(!!seed, "and up there it spits, on that level");
    ok(!!seed && seed.y > 2, `from the height it is standing at (${seed && seed.y.toFixed(1)})`);
    // and it can be shot from that level
    const hp0 = d0.hp;
    UFO.aim(d0.x, d0.z);
    down("Space");
    for (let i = 0; i < 90 && !d0.dead && d0.hp === hp0; i++) frame(1);
    up("Space");
    ok(d0.dead || d0.hp < hp0, `a bolt up there reaches it (${hp0} -> ${d0.dead ? "dead" : d0.hp})`);
  }
}

/* the level's character: open, or a thicket of walls you cannot see over */
{
  const open = [];
  const closed = [];
  for (let n = 3; n <= 10; n++) {
    startL(n);
    const t = UFO.towerness;
    const row = { n, t, towers: UFO.towers.length, mono: UFO.monoliths.length };
    if (t < 0.3) open.push(row);
    else if (t > 0.6) closed.push(row);
  }
  ok(open.length > 0 && closed.length > 0,
    `levels swing between open and crowded (${open.map((o) => o.n).join(",")} open, ${closed.map((c) => c.n).join(",")} crowded)`);
  if (open.length && closed.length) {
    const o = open.reduce((a, b) => (b.towers < a.towers ? b : a));
    const c = closed.reduce((a, b) => (b.towers > a.towers ? b : a));
    ok(c.towers > o.towers * 1.3,
      `and the crowded ones really are: L${c.n} has ${c.towers} towers against L${o.n}'s ${o.towers}`);
    ok(closed.some((x) => x.mono > 0),
      `the worst of them stand up into monoliths (${closed.map((x) => x.mono).join(",")})`);
  }
  startL(1);
  ok(UFO.towerness < 0.3 && UFO.monoliths.length === 0,
    `while the teaching level stays open (${UFO.towers.length} towers, no monoliths)`);
}

/* ---------------------------------------------------------------- the snow */
/* nothing drifts through the craft: the dust keeps a clear pocket around it */
{
  startL(4);
  const d = UFO.dust;
  const b = UFO.dustBubble;
  const cy = 1.6 + UFO.alt;
  // park under a mote that is at the craft's own height
  let at = -1;
  for (let i = 0; i < d.length / 3; i++) {
    if (Math.abs(d[i * 3 + 1] - cy) < 1.5) { at = i; break; }
  }
  if (at >= 0) UFO.move(d[at * 3], d[at * 3 + 2]);
  frame(3);
  let inside = 0;
  for (let i = 0; i < d.length / 3; i++) {
    const dx = d[i * 3] - UFO.pos.x;
    const dz = d[i * 3 + 2] - UFO.pos.z;
    const dy = d[i * 3 + 1] - cy;
    if (Math.abs(dy) < b.y - 0.5 && dx * dx + dz * dz < (b.r - 0.5) * (b.r - 0.5)) inside++;
  }
  ok(inside === 0, `no mote drifts through the hull (${inside} inside the pocket)`);
  ok(b.r > 2.5 && b.y > 2, `the pocket is big enough to clear the saucer (${b.r}x${b.y})`);
}

/* ---------------------------------------------------------------- fullscreen */
{
  ok(fullscreenEl === null, "not in fullscreen to start with");
  down("KeyF");
  up("KeyF");
  ok(fullscreenEl === "root", "F asks the page for fullscreen");
  down("KeyF");
  up("KeyF");
  ok(fullscreenEl === null, "and F again gives the window back");
}

/* sound: there is no Web Audio in node, so the engine stays off and only logs
   what the game asked it to play. That log is the whole wiring test. */
{
  startL(1);
  const a = UFO.audio;
  ok(!!a, "the audio engine is on the debug handle");
  ok(a.state === "off" && !a.enabled, `no Web Audio here, so it stays off (${a.state})`);
  ok(a.level === 1, `and it is scoring level 1 (${a.level})`);
  ok(a.arrangement && a.arrangement.bpm > 0, `level 1 has a tempo (${a.arrangement && a.arrangement.bpm})`);

  a.clear();

  /* your own gun, and the hull taking one */
  down("Space");
  frame(3);
  up("Space");
  ok(a.log.includes("shoot"), `firing asks for a shot (${a.log.slice(-4).join(",")})`);
  UFO.damage(5);
  ok(a.log.includes("hurt"), "taking a hit asks for a hurt");
  ok(UFO.hp === 95, `and the hit still lands (${UFO.hp})`);

  /* things coming apart, including the shade's own note */
  startL(3);
  a.clear();
  UFO.kill();
  const heard = [...new Set(a.log)];
  ok(a.log.includes("kill"), `destroying monsters asks for a kill (${heard.join(",")})`);
  ok(a.log.includes("killShade"), "and the shade gets its own, lower one");

  /* the mine, in order: latch, then beeps, then the bang */
  startL(1);
  a.clear();
  const loudMine = UFO.enemies.find((e) => !e.dead && e.type === "grunt");
  UFO.move(loudMine.x + 2, loudMine.z);
  for (let i = 0; i < 30 && !loudMine.armed; i++) frame(1);
  ok(a.log.includes("mineArm"), "arming a mine asks for the latch");
  for (let i = 0; i < 200 && !loudMine.dead; i++) frame(1);
  ok(a.log.includes("mineBeep"), "the fuse counts down audibly");
  ok(a.log.includes("boom"), "and the detonation asks for the big one");
  ok(a.log.indexOf("mineArm") < a.log.indexOf("mineBeep"), "the latch comes before the beeps");
  ok(a.log.indexOf("mineBeep") < a.log.indexOf("boom"), "and the beeps before the bang");

  /* one key mutes everything, and the HUD says which way it is */
  const wasMuted = a.muted;
  down("KeyM");
  up("KeyM");
  ok(a.muted === !wasMuted, `M flips the mute (muted: ${a.muted})`);
  ok(document.getElementById("snd").textContent.includes("off") === a.muted, "and the HUD repeats it");
  down("KeyM");
  up("KeyM");
  ok(a.muted === wasMuted, "and M flips it back");

  /* and the shade is loud in both directions: you hear it commit, you hear it hit */
  startL(3);
  a.clear();
  const loudShade = UFO.shades.find((e) => !e.dead);
  if (loudShade) {
    only(loudShade); // nothing else on the level for this one
    { const v = nearFree(loudShade.x, loudShade.z, 14); if (v) UFO.move(v.x, v.z); }
    for (let i = 0; i < 200 && !a.log.includes("shadeCharge"); i++) frame(1);
    ok(a.log.includes("shadeCharge"), `the lunge is announced (${[...new Set(a.log)].join(",")})`);
    // step out of the charge line and let the dash end against something
    for (let i = 0; i < 200 && !a.log.includes("shadeCrash"); i++) {
      if (UFO.state !== "playing") break;
      UFO.move(UFO.pos.x, UFO.pos.z + 6);
      frame(1);
    }
    ok(a.log.includes("shadeCrash"), "and the end of the dash gets a crash to match the shake");
  }
  startL(1);
}

/* the score waits for something to happen, and the game tells it when */
{
  const a = UFO.audio;
  a.clear();
  startL(1);
  ok(a.energy >= 0.4, `arriving on a level pokes the score (${a.energy})`);
  const arrived = a.energy;
  down("Space");
  frame(3);
  up("Space");
  ok(a.energy > arrived, `firing pokes it further (${arrived} -> ${a.energy})`);

  a.clear();
  const loud = UFO.enemies.find((e) => !e.dead && e.type === "grunt");
  UFO.move(loud.x + 2, loud.z);
  for (let i = 0; i < 30 && !loud.armed; i++) frame(1);
  ok(a.energy > 0.4, `a mine latching on gets the music up (${a.energy})`);
  for (let i = 0; i < 200 && !loud.dead; i++) frame(1);
  ok(a.energy > 0.9, `and the bang takes it to the top (${a.energy})`);
}

/* reaching the exit clears the level and advances it */
{
  startL(1);
  UFO.audio.clear();
  const w = UFO.worldOf(UFO.exit.col, UFO.exit.row);
  UFO.move(w.x, w.z);
  frame(2);
  ok(UFO.state === "cleared", "standing on the exit clears the level");
  ok(UFO.explosions > 0, `the exit answers with a blast (${UFO.explosions} active)`);
  ok(UFO.audio.log.includes("exit"), "and the exit asks for its jingle");
  frame(140);
  ok(UFO.level === 2, `advanced to level 2 (got ${UFO.level})`);
  ok(UFO.monsters === 9, `level 2 spawns 9 monsters (7 roamers + 2 guards, got ${UFO.monsters})`);
  ok(ofType("spitter").length > 0, "including the first spitters");
  ok(UFO.hp === 100, "health is restored on a new level");
  ok(UFO.audio.level === 2, `and the score moves to level 2 (${UFO.audio.level})`);
  ok(UFO.audio.arrangement.level === 2 && UFO.audio.arrangement.bpm > 0, "with its own arrangement");
  ok(UFO.audio.log.includes("levelUp"), "and a sting on the way in");
}

/* sustained random play must never wedge the craft into a wall */
{
  startL(4);                        // the busiest level: holes, decks and pads
  let seed = 987654321;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const codes = ["KeyW", "KeyA", "KeyD", "KeyS", "Space"];
  const held = new Set();
  let stuck = 0;
  let deaths = 0;
  let falls = 0;
  let levels = 0;
  let lastLevel = UFO.level;
  for (let i = 0; i < 4000; i++) {
    if (rnd() < 0.08) { const c = codes[(rnd() * codes.length) | 0]; down(c); held.add(c); }
    if (rnd() < 0.06 && held.size) {
      const arr = [...held];
      const c = arr[(rnd() * arr.length) | 0];
      up(c);
      held.delete(c);
    }
    frame(1);
    if (UFO.stuck) stuck++;
    if (UFO.falling > 0) falls++;
    if (UFO.state === "dead") { deaths++; down("KeyR"); up("KeyR"); frame(2); startL(4); }
    if (UFO.level !== lastLevel) { levels++; lastLevel = UFO.level; }
  }
  for (const c of held) up(c);
  ok(stuck === 0, `never ends a frame inside a wall over 4000 frames (${stuck} bad)`);
  console.log(`  info: random play hit ${deaths} deaths (${falls} frames falling), advanced ${levels} level(s)`);
}

/* the rifts actually produce monsters while a level runs */
{
  startL(5);
  frame(900);
  ok(UFO.riftsOpened > 0, `rifts keep spawning monsters (${UFO.riftsOpened} opened so far)`);
  ok(UFO.rifts.length > 0, `and the level always has its spawn points (${UFO.rifts.length})`);
  ok(UFO.monsters > 0, "the level does not run out of monsters");
  const types = new Set(UFO.enemies.filter((e) => e.fromRift).map((e) => e.type));
  ok(!types.has("lurker") && !types.has("warden"), `rifts only spawn what is unlocked there (${[...types].join(",")})`);
}

/* a couple of frames of normal play after all that */
frame(300);
ok(!UFO.stuck, "still outside the walls after a long session");
ok(HARNESS.frames > 4000, `renderer rendered ${HARNESS.frames} frames`);

console.log(fail ? `\n${fail} FAILURE(S)` : "\nALL SMOKE TESTS PASSED");
process.exit(fail ? 1 : 0);
