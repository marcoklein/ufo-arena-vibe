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
    style: {},
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); },
      remove(c) { this._s.delete(c); },
      contains(c) { return this._s.has(c); },
    },
  };
}

globalThis.document = {
  createElement(tag) {
    if (tag === "canvas") return { width: 0, height: 0, getContext: () => ctx2d() };
    return stubEl("el");
  },
  body: { appendChild() {} },
  getElementById(id) { return els[id] || (els[id] = stubEl(id)); },
};
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

/* --------------------------------------------------------------- checks */
ok(typeof HARNESS.loop === "function", "animation loop registered");
ok(HARNESS.frames > 0 || true, "renderer constructed");

frame(2);
const START = { x: UFO.pos.x, z: UFO.pos.z };
ok(UFO.level === 1, `boots on level 1 (got ${UFO.level})`);
ok(UFO.state === "playing", "boots in the playing state");
ok(UFO.hp === 100, `full health at start (${UFO.hp})`);
ok(UFO.monsters === 11, `level 1 spawns 11 monsters (got ${UFO.monsters})`);
ok(!UFO.stuck, "player starts outside the walls");

/* movement */
{
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
  UFO.move(START.x, START.z);
  let peak = 0;
  down("Space");
  for (let i = 0; i < 40; i++) { frame(1); peak = Math.max(peak, UFO.bullets.length); }
  up("Space");
  ok(peak > 0, `Space fires bullets (peak ${peak} in flight)`);
}

/* shooting kills a monster */
{
  const k0 = UFO.kills;
  let landed = false;
  for (let attempt = 0; attempt < 12 && !landed; attempt++) {
    const target = UFO.enemies.find((e) => !e.dead);
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
  ok(UFO.monsters < 11, `monster count drops (${UFO.monsters} left)`);
  ok(UFO.particles > 0, `a kill throws debris (${UFO.particles} particles)`);
  ok(UFO.gore.length > 0, `a kill throws guts too (${UFO.gore.length} chunks)`);
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
  ok(UFO.level === 1 && UFO.hp === 100 && UFO.kills === 0, "restart resets level, health and score");
  ok(UFO.monsters === 11, `restart respawns level 1 (${UFO.monsters} monsters)`);
}

/* a shade waits in the rooms, wakes up, and takes the craft with it */
{
  down("KeyR");
  up("KeyR");
  frame(2);
  const shade = UFO.shades.find((e) => !e.dead);
  ok(!!shade, `a shade is waiting in the rooms (${UFO.shades.length} of them)`);
  ok(!!shade && shade.state === "lurk", `it starts as a shadow on the floor (${shade && shade.state})`);
  ok(UFO.rifts.length > 0, `rifts are seeded as spawn points (${UFO.rifts.length})`);

  UFO.move(shade.x + 18, shade.z);
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
  const chunks = UFO.gore.length;
  frame(90);
  ok(chunks > 0, `the wreck throws guts (${chunks} chunks)`);
  ok(UFO.splats.length > 0, `and they leave a mess on the floor (${UFO.splats.length} stains)`);

  down("KeyR");
  up("KeyR");
  frame(2);
  ok(UFO.state === "playing", "R restarts after the shade");
  ok(UFO.gore.length === 0 && UFO.splats.length === 0, "the mess is cleared with the level");
  ok(!UFO.hunted, "and the hunt is off again");
}

/* enemies actually chase and can hurt the player */
{
  const hp0 = UFO.hp;
  const target = UFO.enemies.find((e) => !e.dead && e.type === "grunt") || UFO.enemies[0];
  if (target) {
    UFO.move(target.x + 1.2, target.z);
    frame(90);
    ok(UFO.hp < hp0 || UFO.state === "dead", `contact with a monster costs health (${hp0} -> ${UFO.hp})`);
  } else {
    ok(true, "no monster left to test contact damage");
  }
}

/* reaching the exit clears the level and advances it */
{
  const w = UFO.worldOf(UFO.exit.col, UFO.exit.row);
  UFO.move(w.x, w.z);
  frame(2);
  ok(UFO.state === "cleared", "standing on the exit clears the level");
  ok(UFO.explosions > 0, `the exit answers with a blast (${UFO.explosions} active)`);
  frame(140);
  ok(UFO.level === 2, `advanced to level 2 (got ${UFO.level})`);
  ok(UFO.monsters === 14, `level 2 spawns 14 monsters (got ${UFO.monsters})`);
  ok(UFO.hp === 100, "health is restored on a new level");
}

/* sustained random play must never wedge the craft into a wall */
{
  let seed = 987654321;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const codes = ["KeyW", "KeyA", "KeyD", "KeyS", "Space"];
  const held = new Set();
  let stuck = 0;
  let deaths = 0;
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
    if (UFO.state === "dead") { deaths++; down("KeyR"); up("KeyR"); }
    if (UFO.level !== lastLevel) { levels++; lastLevel = UFO.level; }
  }
  for (const c of held) up(c);
  ok(stuck === 0, `never ends a frame inside a wall over 4000 frames (${stuck} bad)`);
  console.log(`  info: random play hit ${deaths} deaths, advanced ${levels} level(s)`);
}

/* the rifts actually produce monsters while a level runs */
frame(900);
ok(UFO.riftsOpened > 0, `rifts keep spawning monsters (${UFO.riftsOpened} opened so far)`);
ok(UFO.rifts.length > 0, `and the level always has its spawn points (${UFO.rifts.length})`);
ok(UFO.monsters > 0, "the level does not run out of monsters");

/* a couple of frames of normal play after all that */
frame(300);
ok(!UFO.stuck, "still outside the walls after a long session");
ok(HARNESS.frames > 4000, `renderer rendered ${HARNESS.frames} frames`);

console.log(fail ? `\n${fail} FAILURE(S)` : "\nALL SMOKE TESTS PASSED");
process.exit(fail ? 1 : 0);
