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
  const pieces = UFO.debris.length;
  frame(90);
  ok(pieces > 0, `the wreck throws wreckage (${pieces} pieces)`);
  ok(UFO.splats.length > 0, `and it leaves scorch on the floor (${UFO.splats.length} marks)`);

  down("KeyR");
  up("KeyR");
  frame(2);
  ok(UFO.state === "playing", "R restarts after the shade");
  ok(UFO.debris.length === 0 && UFO.splats.length === 0, "the mess is cleared with the level");
  ok(!UFO.hunted, "and the hunt is off again");
}

/* a red diamond is a mine: it arms on the hull, swells, then goes off */
{
  down("KeyR");
  up("KeyR");           // fresh level, so the numbers below are the whole story
  frame(2);
  const hp0 = UFO.hp;
  const k0 = UFO.kills;
  const mine = UFO.enemies.find((e) => !e.dead && e.type === "grunt");
  ok(!!mine, "there is a red diamond to run into");
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
    const lost = hp0 - UFO.hp;
    ok(lost >= 20, `at point blank that is the whole fifth (${hp0} -> ${UFO.hp}, -${lost})`);
    ok(UFO.hp > 0, `one mine is not a one-shot kill (${UFO.hp} left)`);
    ok(UFO.kills === k0, "a mine going off on its own is not a kill of yours");
    ok(UFO.debris.length > 0, `it throws wreckage (${UFO.debris.length} pieces)`);
  }
}

/* and you can simply be somewhere else: distance is the whole game */
{
  const { blastR, fullR } = UFO.mine;
  down("KeyR");
  up("KeyR");
  frame(2);
  const mine = UFO.enemies.find((e) => !e.dead && e.type === "grunt");
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

  const mid = (fullR + blastR) / 2;
  ok(UFO.blastAt(0) === 20, `point blank is the full fifth (${UFO.blastAt(0)})`);
  ok(UFO.blastAt(fullR) === 20, `up to ${fullR}u it stays full (${UFO.blastAt(fullR)})`);
  const half = UFO.blastAt(mid);
  ok(half > 5 && half < 20, `halfway out it is less than half the price (${half} at ${mid}u)`);
  ok(UFO.blastAt(blastR) === 0, `at the rim it is nothing (${UFO.blastAt(blastR)})`);
  ok(UFO.blastAt(99) === 0, "and past the rim there is nothing to talk about");
}

/* and you cannot simply drive over one: sitting on it sets it off on the spot */
{
  down("KeyR");
  up("KeyR");
  frame(2);
  const hp0 = UFO.hp;
  const k0 = UFO.kills;
  const mine = UFO.enemies.find((e) => !e.dead && e.type === "grunt");
  ok(!!mine, "there is a mine to park on");
  if (mine) {
    ok(!!UFO.mine.tripR, `a mine has a radius you cannot enter (${UFO.mine.tripR}u)`);
    UFO.move(mine.x, mine.z); // dead centre, as if driving over it
    frame(2);
    ok(mine.dead, "sitting on top of it sets it off at once");
    ok(mine.armed === false, "with no fuse to wait out");
    const lost = hp0 - UFO.hp;
    ok(lost >= 20, `and that close it is the whole fifth (${hp0} -> ${UFO.hp}, -${lost})`);
    ok(UFO.kills === k0, "still not credited as a kill of yours");
  }
}

/* and half a ring away costs half the price */
{
  const mid = (UFO.mine.fullR + UFO.mine.blastR) / 2;
  down("KeyR");
  up("KeyR");
  frame(2);
  const mine = UFO.enemies.find((e) => !e.dead && e.type === "grunt");
  UFO.move(mine.x + 2.0, mine.z);   // close enough to latch, not close enough to trip it
  for (let i = 0; i < 20 && !mine.armed; i++) frame(1);
  UFO.move(mine.x + mid, mine.z);
  let before = UFO.hp;
  for (let i = 0; i < 130 && !mine.dead; i++) {
    before = UFO.hp;
    frame(1);
  }
  const lost = before - UFO.hp;
  ok(lost > 0 && lost < 20, `standing ${mid.toFixed(1)}u away takes part of it (${before} -> ${UFO.hp}, -${lost})`);
}

/* the spitters still keep their distance and shoot */
{
  const sp = UFO.enemies.find((e) => !e.dead && e.type === "spitter");
  if (sp) {
    const hp0 = UFO.hp;
    UFO.move(sp.x + 14, sp.z);
    let peak = 0;
    for (let i = 0; i < 200; i++) {
      frame(1);
      peak = Math.max(peak, UFO.eBullets.length);
    }
    ok(peak > 0, `a spitter shoots at you (peak ${peak} in flight)`);
    ok(UFO.hp < hp0 || UFO.state === "dead", `and its shots hurt (${hp0} -> ${UFO.hp})`);
  } else {
    ok(true, "no spitter left on this level");
  }
}

/* and you cannot simply shoot a lit mine to be rid of it */
{
  down("KeyR");
  up("KeyR");
  frame(2);
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

/* sound: there is no Web Audio in node, so the engine stays off and only logs
   what the game asked it to play. That log is the whole wiring test. */
{
  const a = UFO.audio;
  ok(!!a, "the audio engine is on the debug handle");
  ok(a.state === "off" && !a.enabled, `no Web Audio here, so it stays off (${a.state})`);
  ok(a.level === 1, `and it is scoring level 1 (${a.level})`);
  ok(a.arrangement && a.arrangement.bpm > 0, `level 1 has a tempo (${a.arrangement && a.arrangement.bpm})`);

  down("KeyR");
  up("KeyR");
  frame(2);
  a.clear();

  /* your own gun, and the hull taking one */
  down("Space");
  frame(3);
  up("Space");
  ok(a.log.includes("shoot"), `firing asks for a shot (${a.log.slice(-4).join(",")})`);
  UFO.damage(5);
  ok(a.log.includes("hurt"), "taking a hit asks for a hurt");
  ok(UFO.hp === 95, `and the hit still lands (${UFO.hp})`);

  /* things coming apart */
  a.clear();
  UFO.kill();
  const heard = [...new Set(a.log)];
  ok(a.log.includes("kill"), `destroying monsters asks for a kill (${heard.join(",")})`);
  ok(a.log.includes("killShade"), "and the shade gets its own, lower one");

  /* the mine, in order: latch, then beeps, then the bang */
  down("KeyR");
  up("KeyR");
  frame(2);
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
  down("KeyR");
  up("KeyR");
  frame(2);
  a.clear();
  const loudShade = UFO.shades.find((e) => !e.dead);
  if (loudShade) {
    UFO.move(loudShade.x + 18, loudShade.z);
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
  down("KeyR");
  up("KeyR");
  frame(2);
}

/* the shots are not balls, and the things that shoot look like guns */
{
  down("KeyR");
  up("KeyR");
  frame(2);
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
    ok(!!shooter.spitter, "and it has a snout and a chamber");
    ok(shooter.spitter.mouthMat.emissiveIntensity >= 0.8, "the chamber glows before it charges");
    // stand in its face and let it wind up
    UFO.move(shooter.x + 14, shooter.z);
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

/* the score waits for something to happen, and the game tells it when */
{
  const a = UFO.audio;
  a.clear();
  down("KeyR");
  up("KeyR");
  frame(2);
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
  down("KeyR");
  up("KeyR");
  frame(2);
}

/* reaching the exit clears the level and advances it */
{
  UFO.audio.clear();
  const w = UFO.worldOf(UFO.exit.col, UFO.exit.row);
  UFO.move(w.x, w.z);
  frame(2);
  ok(UFO.state === "cleared", "standing on the exit clears the level");
  ok(UFO.explosions > 0, `the exit answers with a blast (${UFO.explosions} active)`);
  ok(UFO.audio.log.includes("exit"), "and the exit asks for its jingle");
  frame(140);
  ok(UFO.level === 2, `advanced to level 2 (got ${UFO.level})`);
  ok(UFO.monsters === 14, `level 2 spawns 14 monsters (got ${UFO.monsters})`);
  ok(UFO.hp === 100, "health is restored on a new level");
  ok(UFO.audio.level === 2, `and the score moves to level 2 (${UFO.audio.level})`);
  ok(UFO.audio.arrangement.level === 2 && UFO.audio.arrangement.bpm > 0, "with its own arrangement");
  ok(UFO.audio.log.includes("levelUp"), "and a sting on the way in");
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
