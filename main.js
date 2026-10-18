import * as THREE from "three";
import { CELL, RADIUS, createLevel, makeRng } from "./maze.js";
import { THEMES } from "./themes.js";
import { gameAudio } from "./audio.js";
import { blank, pickStore, readSave, reachLevel, writeSave } from "./save.js";

/* ------------------------------------------------------------------ config */
const SPEED = 16;        // forward speed, units/second
const TURN_SPEED = 2.8;  // turn rate, radians/second
const WALL_H = 4.5;      // standard wall height
const TOWER_H = 7.5;     // thick rock towers
const MONOLITH_H = 12.5; // the tall stuff: above the camera, so you cannot see over
const BORDER_H = 9;      // perimeter walls
const HOVER = 1.6;       // how high the saucer floats
const MAX_BANK = 0.3;    // lean into turns

const CAM_DIST = 9.5;    // third-person distance behind the craft
const CAM_HEIGHT = 6.5;  // camera height

const PLAYER_HP = 100;
const HURT_COOLDOWN = 0.9;
const FIRE_COOLDOWN = 0.16;
const BULLET_SPEED = 48;
const BULLET_LIFE = 1.0;
const BULLET_R = 0.35;
const NOSE = 1.5;        // muzzle offset from the craft centre

const ENEMY_R = 1.05;
const TOUCH_DMG = 12;      // a spitter brushing past you
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/* The red diamonds are floating mines. Touching one latches it on, and then it
   swells and blinks for a moment before going off, so there is a window to back
   away. Sitting on top of one is another matter: that goes off where it stands.
   Close in, the blast simply ends the run - landing next to a mine, or stopping
   beside one, is not something you survive - and out to blastR it still takes
   nearly half the bar. The kill ring is painted on the floor while the fuse
   burns, so the price of standing still is visible. */
const MINE = {
  fuse: 1.4,             // seconds of "get out of here" once it has latched on
  tripR: 1.2,            // this close to the middle and it does not wait
  killR: 3.2,            // inside this the blast is the end of the run
  blastR: 8.5,           // outside this you eat nothing
  dmg: PLAYER_HP * 0.45, // and at the rim of the kill ring it still costs this
};

/* the shade: a corner-crawler that ends the run the moment it touches you. It
   gives up once you are properly out of reach, so it never trails you for ever. */
const LURK = {
  wake: 21,          // distance at which it stirs
  leash: 34,         // beyond this it loses interest...
  giveUp: 0.8,       // ...after this long out there
  stalkSpeed: 4.6,   // the slow, inevitable approach
  chargeSpeed: 23,   // then the lunge
  chargeDist: 12,
  stalkTime: 1.8,
  dashTime: 0.8,     // a straight line: sidestep and it slams into a wall
  recover: 0.95,     // ...which leaves it open for a moment
  radius: 1.35,
  hp: 15,
};

/* rifts: standing tears in the level that keep producing monsters. They are not
   scenery: a tear can be shot to pieces, and then it stops producing anything. */
const RIFT = {
  warn: 17,          // a nearby rift always telegraphs before it opens
  warnTime: 1.3,
  base: 11,          // seconds between openings before level scaling
  min: 4.5,
  cap: 6,            // extra monsters allowed on top of the level's own
  grace: (n) => Math.max(7, 20 - n), // breathing room at the start of a level
  r: 1.9,            // a bolt that passes this close to the tear goes into it
  hp: (n) => Math.min(24, 8 + n * 2), // bolts it takes to tear one down...
  fuse: 2.4,         // ...and then this long coming apart before it goes
  blast: 8.5,        // how far the end of it is felt
  dmg: PLAYER_HP * 0.2, // what standing at the centre of that blast costs
};

// The blocks standing on the floor are the level above it: every block top is a
// place to be, and a lift pad raises the craft exactly that one block.
const BLOCK_H = 2.6;

/* The lift. A pad picks the craft up exactly one level - the height of a low
   block - and holds it there. Up on that level there is no floor, only the block
   tops, so the craft is only *supported* where a block is underneath; everywhere
   else it is hovering, and hovering is what drains the meter. The meter fills up
   again on the floor (and on a block top), and when it is empty the craft sinks
   back down. */
const LIFT = {
  alt: BLOCK_H,     // one level: exactly the height of a low block
  time: 2.8,        // seconds of hover in a full meter
  drain: 1,         // meter per second while there is no ground underneath
  regen: 1.6,       // and how fast it fills on the ground
  minCharge: 0.6,   // no pad will lift you on less than this
  rise: 0.4,        // climb time
  fall: 0.35,       // and back down: the round trip is short on purpose
  speed: 1.25,      // speed while up on the block level
  padR: 2.1,        // drive this close to a charged pad and it takes you up
  armR: 4.5,        // drive this far off a used pad and it re-arms
  warn: 0.8,        // the last stretch: the HUD and the drop marker go red
  safe: 0.45,       // above this the floor cannot reach you
  fly: 0.85,        // above this the blocks are underneath, not in the way
};

const WALL_STYLE = {
  "#": { h: WALL_H, color: 0x3b4a5e },  // plain rock
  X: { h: TOWER_H, color: 0x2f6b70 },   // tower
  S: { h: MONOLITH_H, color: 0x39465c },// monolith: taller than the camera
  O: { h: BLOCK_H, color: 0x7a4f3a },   // low block: the level above the floor
  B: { h: BORDER_H, color: 0x33415a },  // perimeter (the rim is void now)
};
const CROWN_COOL = 0x49b8ff;
const CROWN_WARM = 0xffa53d;

/* ------------------------------------------------------------- the ladder */
// Nothing is thrown at the player before the level that introduces it, and every
// new thing arrives on a level of its own, so there is room to work out what it
// does before the next one lands:
//
//   1  red diamonds, and nothing else        (two rooms, learn the mines)
//   2  + spitters                            (still two rooms)
//   3  + shades
//   4  + the level above: lift pads, raised decks, holes and tunnels, and a pad
//      in the room you start in so it can be tried straight away
//   5  + spawners: a room full of rifts, so it is obvious where monsters come from
//   6  + wardens, and a level with the floor taken away: the level above is the
//      only road from the start room to the exit room, and it is held by wardens
//   7+ everything at once, in bigger numbers - but the maps stop growing, so it
//      gets denser rather than emptier
const UNLOCK = { spitter: 2, shade: 3, upper: 4, rift: 5, warden: 6 };
const allow = (thing, n) => n >= UNLOCK[thing];

/* The warden level is a different place from every other one: the floor is gone.
   A road of blocks is the only way across, so nothing walks down there and there
   is nothing to send after you - what is up on the blocks is the whole level, and
   it is wardens. It is the level that says what the level above is for. */
const isVoid = (n) => levelPlace(n) === "void";

// The first two levels are little more than a room each: nowhere to hide, nothing
// but the one new thing to work out. Then the size climbs to a ceiling and stays
// there, so the late levels are won on the mechanics, not on map size.
const levelSize = (n) => (n <= 2 ? 13 + n * 2 : n === 3 ? 21 : Math.min(35, 23 + (n - 4) * 2));
const levelEnemies = (n) => (isVoid(n) ? 0 : Math.min(26, 3 + n * 2)); // roaming hunters
const levelGuards = (n) => (isVoid(n) ? 0 : Math.min(10, n));          // defenders ringing the exit
const levelLurkers = (n) => (allow("shade", n) && !isVoid(n) ? Math.min(4, 1 + Math.floor((n - 3) / 2)) : 0);
const levelRifts = (n) => (allow("rift", n) && !isVoid(n) ? Math.min(7, 2 + Math.floor(n / 2)) : 0);
const levelLifts = (n) => (allow("upper", n) ? (isVoid(n) ? 3 : Math.min(6, 2 + Math.floor((n - 4) / 2))) : 0);
const levelWardens = (n) => (allow("warden", n) ? (isVoid(n) ? 10 : Math.min(8, 2 + Math.floor((n - 6) / 2))) : 0);

/* Every level has a character: some are wide open, some are a thicket of towers
   and monoliths you cannot see over. It swings from one extreme to the other,
   deterministically per level, so a level number always looks the same. The first
   two stay open, because that is where you are learning to look around. */
const levelTowerness = (n) => {
  if (n <= 2) return 0.12;
  const r = makeRng(4242 + n)();
  return r < 0.45 ? r * 0.5 : Math.min(1, 0.5 + (r - 0.45) * 0.95);
};
// and things that shoot, standing on the block tops: the level above has its own
// garrison, so rushing it is not a free ride
const levelDeckers = (n) => (allow("warden", n) ? (isVoid(n) ? 2 : Math.min(6, 1 + Math.floor((n - 6) / 2))) : 0);

/* -------------------------------------------------------------- the places */
// Not every level is a bigger version of the last one. Some are a *place*: the
// floor is gone, or the map is a warren of small cells, or every corridor is
// roofed in, or everything that hunts is in one hall, or the lamp barely reaches.
// The counts still climb with the level, but the level you are standing in keeps
// changing, so a run is not one long ramp - and the monsters never change at all,
// only where they are put.
//
// Level 6 introduces the wardens with the floor taken away; 7 to 10 are one place
// each; from 11 on the places cycle, so every five levels the ground changes under
// you again.
const PLACE_CYCLE = ["warren", "tunnels", "arena", "blackout", "void"];
const PLACES = {
  warren: { tip: "THE WARREN: tight cells, no halls, and they are already in there with you." },
  tunnels: { tip: "ROOFED IN: the level above is closed over every corridor. This one is fought on the floor." },
  arena: { tip: "THE ARENA: the hunters are all in one big hall, and the rest of the level is empty." },
  blackout: { tip: "BLACKOUT: the lamp barely reaches. Drive by memory.", dark: 0.5 },
  void: { tip: "THE FLOOR IS GONE: cross on the blocks, and shoot the globs out of the air." },
};
function levelPlace(n) {
  if (n < UNLOCK.warden) return "none";
  if (n === UNLOCK.warden) return "void";
  if (n <= UNLOCK.warden + PLACE_CYCLE.length - 1) return PLACE_CYCLE[n - UNLOCK.warden - 1];
  return PLACE_CYCLE[(n - UNLOCK.warden - 1) % PLACE_CYCLE.length];
}
let place = "none";
const placeOf = () => PLACES[place] || null;

/* ------------------------------------------------------------ the palette */
// One look per level, and no two levels in a row look alike. The rock, the level
// above, the glowing trim, the floor light, the fog and the tower lights all move
// together, and a level dresses its rooms from two or three themes instead of all
// six - so one level is a green level, the next is ember, and the one after is
// louder than both. It is deterministic: a level number always looks the same.
//
// `shade` multiplies every wall colour (a level can be a dark one), `lampPower`
// is the craft's own light, and `themes` are the room themes this level draws
// from, in order.
const PALETTES = [
  {
    id: "slate", rock: 0x3f4d61, tower: 0x2f6b70, monolith: 0x3a4762, block: 0x7a4f3a,
    border: 0x33415a, trim: 0x49b8ff, trimWarm: 0xffa53d, fog: 0x02040a, floor: 0x9fb3c8,
    ambient: 0x1a2636, lamp: 0xffe4bc, mast: 0x8fa3bb, tip: 0xff9a6b,
    crown: "rim", shade: 0.85, lampPower: 1, themes: [0, 2],
  },
  {
    id: "moss", rock: 0x33503f, tower: 0x2c6b52, monolith: 0x2f4a3a, block: 0x5e6b32,
    border: 0x2b4032, trim: 0x76ff9a, trimWarm: 0xd6ff6a, fog: 0x020806, floor: 0x9dc2a6,
    ambient: 0x16281c, lamp: 0xfff0c8, mast: 0x7fa88c, tip: 0xb6ffc8,
    crown: "none", shade: 0.8, lampPower: 0.95, themes: [3, 5, 0],
  },
  {
    id: "ember", rock: 0x5a3a30, tower: 0x7a4a26, monolith: 0x4a3226, block: 0x8a5230,
    border: 0x462e26, trim: 0xff7a2f, trimWarm: 0xffc06a, fog: 0x0a0402, floor: 0xc4a488,
    ambient: 0x2a1a12, lamp: 0xffd9a0, mast: 0xb08a6a, tip: 0xffb066,
    crown: "cap", shade: 0.82, lampPower: 0.9, themes: [1, 5],
  },
  {
    id: "frost", rock: 0x3d5c6b, tower: 0x2f7f92, monolith: 0x35576b, block: 0x4a6a80,
    border: 0x34525f, trim: 0x9fe8ff, trimWarm: 0xbfe9ff, fog: 0x02070c, floor: 0xc3dbe8,
    ambient: 0x18283a, lamp: 0xe8f4ff, mast: 0x9fc4d6, tip: 0xd8f6ff,
    crown: "rim", shade: 0.92, lampPower: 0.9, themes: [2, 0],
  },
  {
    id: "violet", rock: 0x473d68, tower: 0x5a3f8f, monolith: 0x3f3560, block: 0x6a4a86,
    border: 0x392f56, trim: 0xa98bff, trimWarm: 0xff8bd0, fog: 0x050210, floor: 0xb9acd6,
    ambient: 0x1e1830, lamp: 0xf0e4ff, mast: 0x9d8ec4, tip: 0xd8c8ff,
    crown: "cap", shade: 0.86, lampPower: 1, themes: [4, 0],
  },
  {
    id: "toxic", rock: 0x36543c, tower: 0x4a6b2a, monolith: 0x2f4a2f, block: 0x6b7a2f,
    border: 0x2c4430, trim: 0xbaff5e, trimWarm: 0xffe14d, fog: 0x040802, floor: 0xb8d296,
    ambient: 0x1a2414, lamp: 0xf6ffd0, mast: 0x93a878, tip: 0xe6ff8a,
    crown: "none", shade: 0.82, lampPower: 0.95, themes: [3, 1],
  },
  {
    id: "candy", rock: 0x3c4f74, tower: 0x2f8fa8, monolith: 0x463a72, block: 0x8a4a6a,
    border: 0x35446b, trim: 0x63f5ff, trimWarm: 0xff7ac8, fog: 0x04030c, floor: 0xc4bde8,
    ambient: 0x1c1a34, lamp: 0xffe8f6, mast: 0x9a9cc8, tip: 0xffa8e8,
    crown: "cap", shade: 0.9, lampPower: 0.9, themes: [0, 4, 1],
  },
];
// The first two levels keep the plain slate look - that is where you are learning
// to look around - and from level 3 the looks walk a fixed cycle, so consecutive
// levels never share one and every look comes round once every six levels.
const PALETTE_STRIDE = 5; // coprime with the number of rotating palettes
function levelPalette(n) {
  if (n <= 2) return PALETTES[0];
  const rotating = PALETTES.length - 1;
  return PALETTES[1 + (((n - 3) * PALETTE_STRIDE) % rotating)];
}
let palette = PALETTES[0];
let themeMap = PALETTES[0].themes;
// the rock colour for a wall kind, out of the level's palette
const paletteRock = (kind) => (kind === "X" ? palette.tower
  : kind === "S" ? palette.monolith
  : kind === "B" ? palette.border
  : kind === "O" ? palette.block
  : palette.rock);
// a room theme, as this level dresses it: the level only uses its own few
const themeAt = (t) => (t === undefined || t === null ? undefined : themeMap[t % themeMap.length]);

/* everything about the palette that is not per-cell: the fog, the sky, the floor,
   the craft's own lamp, and the shared materials the level is built from */
function applyPalette() {
  // a place can be darker than its palette: the blackout level is the palette with
  // the lamp turned down and the fog pulled in, so you see a bubble and nothing else
  const dark = placeOf() && placeOf().dark ? placeOf().dark : 1;
  scene.fog.color.setHex(palette.fog);
  scene.background.setHex(palette.fog);
  scene.fog.near = 26 * (dark < 1 ? 0.5 : 1);
  scene.fog.far = 110 * (dark < 1 ? 0.5 : 1);
  ambientLight.color.setHex(palette.ambient);
  playerLight.color.setHex(palette.lamp);
  playerLight.intensity = LAMP.power * (palette.lampPower ?? 1) * dark;
  playerLight.distance = LAMP.reach * (dark < 1 ? 0.62 : 1);
  floor.material.color.setHex(palette.floor);
  roofMat.color.setHex(palette.rock);
  roofTrimMat.color.setHex(palette.trim);
  roofTrimMat.emissive.setHex(palette.trim);
  pitEdgeMat.color.setHex(palette.trim);
  roofLampMat.color.setHex(palette.trim);
  ventMats.forEach((m, i) => {
    const c = [palette.trim, palette.trimWarm, palette.block][i] ?? palette.trim;
    m.color.setHex(c);
    m.emissive.setHex(c);
  });
}

/* The warden: rooted on the raised runs, and only interested in things on its
   own level. It sits there half asleep while you are on the floor; the moment the
   craft comes up within reach its eye opens, the chamber winds up, and it spits a
   glob across the block level. It cannot reach the floor and the floor cannot
   reach it, so the level above is a fight of its own - one you only have a couple
   of hover seconds to win. */
const WARDEN = {
  aggro: 30,        // it only wakes for something up on its level
  wake: 0.5,        // the eye opening
  charge: 0.85,     // the tell before a glob
  rate: 2.2,        // seconds between globs
  shotSpeed: 13,    // heavy and slow: you can see it coming
  dmg: 12,
  drain: 1.5,       // a glob drinks this much hover on top of the damage
  knock: 52,        // and throws the craft back at this speed...
  knockDecay: 4.2,  // ...bleeding away over most of a second
  blast: 9.5,       // how far its shell is felt when it goes off
  r: 0.95,
  top: BLOCK_H + 0.62, // where it sits: on the block top
};

const ROAM_AGGRO = 32;   // how far a roamer goes looking for you
const GUARD_AGGRO = 15;  // how far an exit defender strays from its post

/* ------------------------------------------------------------------- rng */
let decor = makeRng(777); // per-level decoration randomness

/* ------------------------------------------------------------------ canvas */
function makeCanvas(size) {
  const cv = document.createElement("canvas");
  cv.width = cv.height = size;
  return { cv, ctx: cv.getContext("2d") };
}

const texRng = makeRng(20240);
function speckle(ctx, s, count, alpha, lo = 110, hi = 250) {
  for (let i = 0; i < count; i++) {
    const v = (lo + texRng() * (hi - lo)) | 0;
    ctx.fillStyle = `rgba(${v},${v + 4},${v + 10},${(alpha * (0.4 + texRng() * 0.6)).toFixed(3)})`;
    ctx.fillRect(texRng() * s, texRng() * s, 1 + texRng() * 2, 1 + texRng() * 2);
  }
}

function blotches(ctx, s, count, rgba, maxR) {
  for (let i = 0; i < count; i++) {
    const x = texRng() * s;
    const y = texRng() * s;
    const r = 8 + texRng() * maxR;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(${rgba},${(0.08 + texRng() * 0.18).toFixed(3)})`);
    g.addColorStop(1, `rgba(${rgba},0)`);
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
}

function floorTexture() {
  const s = 256;
  const { cv, ctx } = makeCanvas(s);
  ctx.fillStyle = "#0c1219";
  ctx.fillRect(0, 0, s, s);
  speckle(ctx, s, 1600, 0.2, 60, 150);
  blotches(ctx, s, 18, "0,0,0", 60);

  ctx.strokeStyle = "rgba(0,0,0,0.55)";
  ctx.lineWidth = 1.5;
  for (let i = 0; i < 5; i++) {
    let x = texRng() * s;
    let y = texRng() * s;
    ctx.beginPath();
    ctx.moveTo(x, y);
    for (let k = 0; k < 6; k++) {
      x += (texRng() - 0.5) * 70;
      y += (texRng() - 0.5) * 70;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  // one tile per maze cell
  ctx.strokeStyle = "rgba(96,152,176,0.42)";
  ctx.lineWidth = 3;
  ctx.strokeRect(0, 0, s, s);

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

function wallTexture() {
  const s = 256;
  const { cv, ctx } = makeCanvas(s);
  ctx.fillStyle = "#98a2b0";
  ctx.fillRect(0, 0, s, s);

  for (let i = 0; i < 90; i++) {
    ctx.fillStyle = `rgba(66,80,100,${(0.03 + texRng() * 0.07).toFixed(3)})`;
    ctx.fillRect(texRng() * s, 0, 1 + texRng() * 3, s);
  }
  ctx.strokeStyle = "rgba(42,54,70,0.5)";
  ctx.lineWidth = 2;
  for (const y of [s * 0.25, s * 0.5, s * 0.75]) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(s, y);
    ctx.stroke();
  }
  speckle(ctx, s, 3000, 0.18);
  blotches(ctx, s, 24, "26,36,50", 34);
  for (let i = 0; i < 14; i++) {
    ctx.strokeStyle = `rgba(${(90 + texRng() * 60) | 0},${(60 + texRng() * 40) | 0},${(40 + texRng() * 30) | 0},${(0.06 + texRng() * 0.14).toFixed(3)})`;
    ctx.lineWidth = 1 + texRng() * 3;
    const x = texRng() * s;
    const y = texRng() * s;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + (texRng() - 0.5) * 90, y + (texRng() - 0.5) * 20);
    ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

function ventTexture() {
  const s = 128;
  const { cv, ctx } = makeCanvas(s);
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, "rgba(255,255,255,0.95)");
  g.addColorStop(0.4, "rgba(255,255,255,0.30)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  ctx.strokeStyle = "rgba(255,255,255,0.65)";
  ctx.lineWidth = 3;
  for (let r = 14; r < s / 2; r += 15) {
    ctx.beginPath();
    ctx.arc(s / 2, s / 2, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function envTexture() {
  // A tiny procedural sky so metals have something to reflect. Kept dark and
  // cool so it does not wash out the gloom.
  const s = 128;
  const { cv, ctx } = makeCanvas(s);
  const g = ctx.createLinearGradient(0, 0, 0, s);
  g.addColorStop(0, "#1b2432");
  g.addColorStop(0.48, "#0c1621");
  g.addColorStop(0.55, "#1c2836");
  g.addColorStop(1, "#05080d");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  for (const [x, y, r, c] of [[0.28, 0.2, 30, "255,226,180"], [0.72, 0.32, 24, "120,214,255"]]) {
    const rg = ctx.createRadialGradient(s * x, s * y, 0, s * x, s * y, r);
    rg.addColorStop(0, `rgba(${c},0.7)`);
    rg.addColorStop(1, `rgba(${c},0)`);
    ctx.fillStyle = rg;
    ctx.fillRect(0, 0, s, s);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function padTexture() {
  // A soft glowing band around the room edge, plus faint inner gridwork. The
  // theme colour comes from the material, so one texture serves every theme.
  const s = 256;
  const { cv, ctx } = makeCanvas(s);
  if ("filter" in ctx) ctx.filter = "blur(6px)";
  ctx.strokeStyle = "rgba(255,255,255,0.85)";
  ctx.lineWidth = 18;
  ctx.strokeRect(22, 22, s - 44, s - 44);
  if ("filter" in ctx) ctx.filter = "blur(16px)";
  ctx.strokeStyle = "rgba(255,255,255,0.45)";
  ctx.lineWidth = 16;
  ctx.strokeRect(30, 30, s - 60, s - 60);
  if ("filter" in ctx) ctx.filter = "none";

  ctx.strokeStyle = "rgba(255,255,255,0.07)";
  ctx.lineWidth = 1;
  for (let k = 1; k < 4; k++) {
    const t = (k / 4) * s;
    ctx.beginPath(); ctx.moveTo(t, 34); ctx.lineTo(t, s - 34); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(34, t); ctx.lineTo(s - 34, t); ctx.stroke();
  }

  ctx.strokeStyle = "rgba(255,255,255,0.95)";
  ctx.lineWidth = 11;
  const arm = 44;
  for (const [x, y, dx, dy] of [[22, 22, 1, 1], [s - 22, 22, -1, 1], [22, s - 22, 1, -1], [s - 22, s - 22, -1, -1]]) {
    ctx.beginPath();
    ctx.moveTo(x + dx * arm, y);
    ctx.lineTo(x, y);
    ctx.lineTo(x, y + dy * arm);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/* ------------------------------------------------------------- three setup */
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x02040a);
scene.fog = new THREE.Fog(0x02040a, 26, 110);

const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 1, 4000);
camera.updateProjectionMatrix();

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
// just over 1: with the craft's own lamp this close to the rock, a hotter
// exposure turns every flat top into snow
renderer.toneMappingExposure = 0.96;
document.body.appendChild(renderer.domElement);

// dull reflections for the metalwork; deliberately weak so the gloom survives
{
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromEquirectangular(envTexture()).texture;
  // weak on purpose: this is what the metal reflects, but it is also a soft light
  // on everything that faces up, and a brighter one paints the block tops white
  scene.environmentIntensity = 0.32;
  pmrem.dispose();
}

/* ------------------------------------------------------------------ lights */
const ambientLight = new THREE.AmbientLight(0x1a2636, 0.22);
scene.add(ambientLight);

// The craft's lamp: what it reaches is what you see. Any real falloff makes a light
// bright enough to reach across a room about twenty times brighter three units
// away, and that is what painted every flat top white. So this one does not fall
// off with distance at all - it holds its brightness and simply stops at its reach,
// fading out over the last stretch. The near field is stone, the far field is dark,
// and the bubble is the same brightness all the way through.
const LAMP = { power: 2.4, reach: 56 };
const playerLight = new THREE.PointLight(0xffe4bc, LAMP.power, LAMP.reach, 0);
playerLight.position.set(0, HOVER, 0);
playerLight.castShadow = true;
playerLight.shadow.mapSize.set(1024, 1024);
playerLight.shadow.bias = -0.0025;
playerLight.shadow.camera.far = 120;
scene.add(playerLight);

/* ----------------------------------------------------- shared resources */
const floorTex = floorTexture();
const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(1, 1),
  new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.95, metalness: 0 })
);
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);

const boxGeo = new THREE.BoxGeometry(CELL, 1, CELL);
const crownGeo = new THREE.BoxGeometry(CELL * 0.94, 0.3, CELL * 0.94);
const mastGeo = new THREE.CylinderGeometry(0.05, 0.07, 2.4, 6);
const tipGeo = new THREE.SphereGeometry(0.15, 10, 8);
const ventGeo = new THREE.PlaneGeometry(CELL * 0.6, CELL * 0.6);
const pitGeo = new THREE.PlaneGeometry(CELL, CELL);
const pitEdgeXGeo = new THREE.PlaneGeometry(CELL, 0.22);
const pitEdgeZGeo = new THREE.PlaneGeometry(0.22, CELL);
const roofGeo = new THREE.BoxGeometry(CELL, 1.5, CELL);
const roofLampGeo = new THREE.PlaneGeometry(CELL * 0.86, CELL * 0.86);
const ROOF_Y = 4.05;   // the slab spans 3.3 .. 4.8: over the hull on the floor,
                       // straight through it one level up
const markerGeo = new THREE.PlaneGeometry(CELL * 0.82, CELL * 0.82);
const exitPillarGeo = new THREE.CylinderGeometry(CELL * 0.38, CELL * 0.38, 14, 22, 1, true);

const wallTex = wallTexture();
// A hole is simply no floor: a flat, pure black square, square to the grid, and
// only the lip of the opening is drawn. Where two holes meet there is no lip at
// all, so a void run reads as one opening rather than a grid of tiles.
//
// Neither the hole nor its lip is fogged: fog tints a black square towards the fog
// colour, which is exactly what made distant holes read as grey-blue tiles instead
// of as nothing. A hole is black at any distance.
const PIT_Y = 0.02;  // the hole itself
const PAD_Y = 0.012; // the room pad, under it
const pitMat = new THREE.MeshBasicMaterial({ color: 0x000000, toneMapped: false, fog: false });
const pitEdgeMat = new THREE.MeshBasicMaterial({
  color: 0xd8eeff, transparent: true, opacity: 0.8,
  blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, fog: false,
});
const roofMat = new THREE.MeshStandardMaterial({
  color: 0x5d6a7e, map: wallTex, bumpMap: wallTex, bumpScale: 0.4,
  roughness: 0.88, metalness: 0.05, emissive: 0x0b1622, emissiveIntensity: 1,
});
const roofLampMat = new THREE.MeshBasicMaterial({
  color: 0x9fe8ff, transparent: true, opacity: 0.34, side: THREE.DoubleSide,
  blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
});
// a lit edge round the underside, so a tunnel reads as a ceiling and not as a
// black wall dropped into the corridor
const roofTrimMat = new THREE.MeshStandardMaterial({
  color: CROWN_COOL, emissive: CROWN_COOL, emissiveIntensity: 1.3, roughness: 0.5,
});
const wallMat = new THREE.MeshStandardMaterial({
  color: 0xffffff, map: wallTex, bumpMap: wallTex, bumpScale: 0.4,
  roughness: 0.85, metalness: 0.05, emissive: 0x0a1420, emissiveIntensity: 1,
});
const crownCoolMat = new THREE.MeshStandardMaterial({ color: CROWN_COOL, emissive: CROWN_COOL, emissiveIntensity: 2.6, roughness: 0.4 });
const crownWarmMat = new THREE.MeshStandardMaterial({ color: CROWN_WARM, emissive: CROWN_WARM, emissiveIntensity: 2.6, roughness: 0.4 });
const crownMatCache = new Map([[`${CROWN_COOL}:2.6`, crownCoolMat], [`${CROWN_WARM}:2.6`, crownWarmMat]]);
function crownMaterial(color, glow = 2.6) {
  const id = `${color}:${glow}`;
  let mat = crownMatCache.get(id);
  if (!mat) {
    mat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: glow, roughness: 0.4 });
    crownMatCache.set(id, mat);
  }
  return mat;
}
// the trim on top of the rock, per level: a glowing cap, a thin rim, or nothing.
// Every wall cell carrying a bright square is a look of its own, and it is not the
// look of every level.
const CROWN_STYLE = {
  cap: { h: 0.3, glow: 2.6 },
  rim: { h: 0.11, glow: 1.5 },
  none: null,
};
// tower lights, in the level's own colours
const mastMatCache = new Map();
function mastMaterial(color) {
  let mat = mastMatCache.get(color);
  if (!mat) {
    mat = new THREE.MeshStandardMaterial({
      color, metalness: 0.7, roughness: 0.45, emissive: color, emissiveIntensity: 0.4,
    });
    mastMatCache.set(color, mat);
  }
  return mat;
}
const tipMatCache = new Map();
function tipMaterial(color) {
  let mat = tipMatCache.get(color);
  if (!mat) {
    mat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 3 });
    tipMatCache.set(color, mat);
  }
  return mat;
}
const ventTex = ventTexture();
const ventMats = [0x38e8d8, 0xffa53d, 0x8b7bff].map((c) => new THREE.MeshStandardMaterial({
  map: ventTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  color: c, emissive: c, emissiveIntensity: 1.4,
}));
const markerStartMat = new THREE.MeshStandardMaterial({ color: 0x2ee6a6, emissive: 0x2ee6a6, emissiveIntensity: 1.6, roughness: 0.55 });
const markerExitMat = new THREE.MeshStandardMaterial({ color: 0xffd23f, emissive: 0xffd23f, emissiveIntensity: 2.2, roughness: 0.55 });

/* room dressing: a glowing floor pad per room, and props standing on the walls
   that line it. Both are reused across levels, so nothing here is disposed. */
const padGeo = new THREE.PlaneGeometry(1, 1);
const padTex = padTexture();
const padMatCache = new Map();
function padMaterial(theme) {
  let mat = padMatCache.get(theme);
  if (!mat) {
    mat = new THREE.MeshBasicMaterial({
      map: padTex, color: THEMES[theme].pad, transparent: true, opacity: 0.42,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    });
    padMatCache.set(theme, mat);
  }
  return mat;
}

const propGeo = {
  crystal: new THREE.ConeGeometry(0.72, 3.0, 5),
  beacon: new THREE.CylinderGeometry(0.16, 0.24, 3.4, 8),
  vent: new THREE.BoxGeometry(CELL * 0.46, 0.8, CELL * 0.46),
};
const propMatCache = new Map();
function propMaterial(color) {
  let mat = propMatCache.get(color);
  if (!mat) {
    mat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1.8, roughness: 0.35, metalness: 0.25 });
    propMatCache.set(color, mat);
  }
  return mat;
}

const exitPillarMat = new THREE.MeshBasicMaterial({
  color: 0xffd23f, transparent: true, opacity: 0.16, side: THREE.DoubleSide,
  blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
});

/* ------------------------------------------------------- world building */
const worldGroup = new THREE.Group();
scene.add(worldGroup);
let currentWallMesh = null;
let currentRoofMesh = null;
let level = null;

function clearWorld() {
  for (const child of worldGroup.children.slice()) {
    worldGroup.remove(child);
    if (child.isInstancedMesh) child.dispose();
  }
  currentWallMesh = null;
  currentRoofMesh = null;
}

function buildWorld(L) {
  clearWorld();

  // the floor stops at the rim: the edge of the map is a band of nothing, and
  // beyond that band there is no floor to see, only the dark
  const size = Math.max(L.cols, L.rows) * CELL;
  floor.scale.set(size, size, 1);
  floorTex.repeat.set(size / CELL, size / CELL);

  /* walls: per-instance height + colour. Cells with a hole in them are walls for
     collision but have nothing standing in them, so they are built separately. */
  const boxCells = [...L.walls].filter((key) => L.wallKind.get(key) !== "P");
  const wallMesh = new THREE.InstancedMesh(boxGeo, wallMat, boxCells.length);
  wallMesh.castShadow = true;
  wallMesh.receiveShadow = true;
  const heights = new Map();
  {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const p = new THREE.Vector3();
    const s = new THREE.Vector3();
    const col = new THREE.Color();
    let i = 0;
    for (const key of boxCells) {
      const [c, r] = key.split(",").map(Number);
      const kind = L.isBorderCell(c, r) ? "B" : L.wallKind.get(key) ?? "#";
      const style = WALL_STYLE[kind] ?? WALL_STYLE["#"];
      const h = style.h * (0.97 + decor() * 0.06);
      heights.set(key, h);
      p.set(L.cellToWorldX(c), h / 2, L.cellToWorldZ(r));
      s.set(1, h, 1);
      m.compose(p, q, s);
      wallMesh.setMatrixAt(i, m);
      // walls lining a themed room take that room's colour. The raised runs are
      // the level above the floor, so they keep one look all over the maze.
      const theme = themeAt(L.wallTheme.get(key));
      const raised = L.upper && L.upper.has(key);
      col.setHex(raised ? palette.block : theme === undefined ? paletteRock(kind) : THEMES[theme].wall)
        .multiplyScalar((palette.shade ?? 0.85) + decor() * 0.3);
      wallMesh.setColorAt(i, col);
      i++;
    }
    wallMesh.instanceMatrix.needsUpdate = true;
    if (wallMesh.instanceColor) wallMesh.instanceColor.needsUpdate = true;
    // a hole is a wall cell with nothing in it: zero height, so one level up the
    // hull passes over it and there is nothing underneath to stand on
    for (const key of L.pits) heights.set(key, 0);
    wallTop = heights;
  }
  worldGroup.add(wallMesh);
  currentWallMesh = wallMesh;

  /* the holes themselves: dark, torn at the rim, flat on the floor. At floor
     level they read as somewhere not to drive; from the level above as somewhere
     that has to be hovered across. */
  for (const key of L.pits) {
    const [c, r] = key.split(",").map(Number);
    const x = L.cellToWorldX(c);
    const z = L.cellToWorldZ(r);
    const hole = new THREE.Mesh(pitGeo, pitMat);
    hole.rotation.x = -Math.PI / 2;
    hole.position.set(x, PIT_Y, z);
    worldGroup.add(hole);
    // only the lip, and only where the opening meets the floor
    for (const [dc, dr, geo] of [
      [0, -1, pitEdgeXGeo], [0, 1, pitEdgeXGeo], [-1, 0, pitEdgeZGeo], [1, 0, pitEdgeZGeo],
    ]) {
      if (L.pits.has(`${c + dc},${r + dr}`)) continue;
      const lip = new THREE.Mesh(geo, pitEdgeMat);
      lip.rotation.x = -Math.PI / 2;
      lip.position.set(x + dc * CELL / 2, 0.05, z + dr * CELL / 2);
      worldGroup.add(lip);
    }
  }

  /* tunnels: a roof over a corridor. From the floor it is a low ceiling with a
     strip of light under it; from the level above it is a wall, so the open sky
     over the maze is not a free road. */
  if (L.roofs && L.roofs.size) {
    const roofMesh = new THREE.InstancedMesh(roofGeo, roofMat, L.roofs.size);
    const m = new THREE.Matrix4();
    let i = 0;
    for (const key of L.roofs) {
      const [c, r] = key.split(",").map(Number);
      const x = L.cellToWorldX(c);
      const z = L.cellToWorldZ(r);
      m.setPosition(x, ROOF_Y, z);
      roofMesh.setMatrixAt(i++, m);
      // height for the collision: well above the hull, so the skip predicate never
      // takes it away one level up
      wallTop.set(key, ROOF_Y + 0.75);
      const lamp = new THREE.Mesh(roofLampGeo, roofLampMat);
      lamp.rotation.x = Math.PI / 2;
      lamp.position.set(x, ROOF_Y - 0.77, z);
      worldGroup.add(lamp);
      const trim = new THREE.Mesh(crownGeo, roofTrimMat);
      trim.position.set(x, ROOF_Y - 0.82, z);
      worldGroup.add(trim);
    }
    roofMesh.instanceMatrix.needsUpdate = true;
    roofMesh.castShadow = true;
    worldGroup.add(roofMesh);
    currentRoofMesh = roofMesh;
  }

  /* glowing crown trim — one instanced mesh per colour, so a themed room is
     outlined in its own colour. Some levels wear a full cap of it, some only a thin
     rim, and some none at all: it is a level's own look, not a constant. */
  const crown = CROWN_STYLE[palette.crown ?? "cap"];
  if (crown) {
    const groups = new Map(); // colour -> wall keys
    for (const key of L.walls) {
      if (L.wallKind.get(key) === "P") continue; // a hole has no crown to trim
      const [c, r] = key.split(",").map(Number);
      const theme = themeAt(L.wallTheme.get(key));
      const kind = L.wallKind.get(key);
      const color = L.isBorderCell(c, r) ? palette.trim
        : L.upper && L.upper.has(key) ? palette.trimWarm
        : theme !== undefined ? THEMES[theme].trim
        : kind === "O" ? palette.trimWarm
        : palette.trim;
      if (!groups.has(color)) groups.set(color, []);
      groups.get(color).push(key);
    }
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const p = new THREE.Vector3();
    const sc = new THREE.Vector3(1, crown.h / 0.3, 1);
    for (const [color, cells] of groups) {
      const mesh = new THREE.InstancedMesh(crownGeo, crownMaterial(color, crown.glow), cells.length);
      cells.forEach((key, i) => {
        const [c, r] = key.split(",").map(Number);
        p.set(L.cellToWorldX(c), (heights.get(key) ?? WALL_H) + 0.05, L.cellToWorldZ(r));
        m.compose(p, q, sc);
        mesh.setMatrixAt(i, m);
      });
      mesh.instanceMatrix.needsUpdate = true;
      worldGroup.add(mesh);
    }
  }

  /* glowing floor pad marking out each room. It is drawn *under* the holes (which
     are opaque black squares just above it), so a hole in a room is a hole and
     nothing else - no glow, no artwork, just the lip of the opening. */
  for (const room of L.rooms) {
    const pad = new THREE.Mesh(padGeo, padMaterial(themeAt(room.theme) ?? 0));
    pad.rotation.x = -Math.PI / 2;
    pad.scale.set(room.w * CELL, room.h * CELL, 1);
    pad.position.set(
      L.cellToWorldX(room.x + (room.w - 1) / 2), PAD_Y, L.cellToWorldZ(room.y + (room.h - 1) / 2)
    );
    worldGroup.add(pad);
  }

  /* props standing on the walls that line each themed room */
  if (L.features.size) {
    const byKind = new Map(); // theme -> wall keys
    for (const [key, f] of L.features) {
      const t = themeAt(f.theme) ?? 0;
      if (!byKind.has(t)) byKind.set(t, []);
      byKind.get(t).push(key);
    }
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const p = new THREE.Vector3();
    const s = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    for (const [t, keys] of byKind) {
      const theme = THEMES[t];
      const kind = theme.kind;
      if (!propGeo[kind]) continue;
      const mesh = new THREE.InstancedMesh(propGeo[kind], propMaterial(theme.prop), keys.length);
      const half = kind === "vent" ? 0.4 : kind === "crystal" ? 1.5 : 1.7;
      keys.forEach((key, i) => {
        const [c, r] = key.split(",").map(Number);
        const base = heights.get(key) ?? WALL_H;
        const sc = 0.78 + decor() * 0.55;
        q.setFromAxisAngle(up, decor() * Math.PI * 2);
        p.set(L.cellToWorldX(c), base + half * sc, L.cellToWorldZ(r));
        s.set(sc, sc, sc);
        m.compose(p, q, s);
        mesh.setMatrixAt(i, m);
      });
      mesh.instanceMatrix.needsUpdate = true;
      worldGroup.add(mesh);
    }
  }

  /* antenna masts on some towers */
  const towers = [...L.walls].filter((key) => {
    const [c, r] = key.split(",").map(Number);
    return !L.isBorderCell(c, r) && L.wallKind.get(key) === "X" && (c * 7 + r * 13) % 3 === 0;
  });
  if (towers.length) {
    const mastMesh = new THREE.InstancedMesh(mastGeo, mastMaterial(palette.mast), towers.length);
    const tipMesh = new THREE.InstancedMesh(tipGeo, tipMaterial(palette.tip), towers.length);
    const m = new THREE.Matrix4();
    towers.forEach((key, i) => {
      const [c, r] = key.split(",").map(Number);
      const top = heights.get(key) ?? WALL_H;
      m.setPosition(L.cellToWorldX(c), top + 1.2, L.cellToWorldZ(r));
      mastMesh.setMatrixAt(i, m);
      m.setPosition(L.cellToWorldX(c), top + 2.45, L.cellToWorldZ(r));
      tipMesh.setMatrixAt(i, m);
    });
    mastMesh.instanceMatrix.needsUpdate = true;
    tipMesh.instanceMatrix.needsUpdate = true;
    worldGroup.add(mastMesh, tipMesh);
  }

  /* floor vents */
  let vi = 0;
  for (let r = 1; r < L.rows - 1; r++) {
    for (let c = 1; c < L.cols - 1; c++) {
      if (L.walls.has(`${c},${r}`)) continue;
      if ((c * 5 + r * 3) % 13 !== 0) continue;
      const plate = new THREE.Mesh(ventGeo, ventMats[vi++ % ventMats.length]);
      plate.rotation.x = -Math.PI / 2;
      plate.rotation.z = decor() * Math.PI;
      plate.position.set(L.cellToWorldX(c), 0.04, L.cellToWorldZ(r));
      worldGroup.add(plate);
    }
  }

  /* start marker, exit marker + light column */
  const mkStart = new THREE.Mesh(markerGeo, markerStartMat);
  mkStart.rotation.x = -Math.PI / 2;
  mkStart.position.set(L.cellToWorldX(L.start.col), 0.03, L.cellToWorldZ(L.start.row));
  worldGroup.add(mkStart);

  const mkExit = new THREE.Mesh(markerGeo, markerExitMat);
  mkExit.rotation.x = -Math.PI / 2;
  mkExit.position.set(L.cellToWorldX(L.exit.col), 0.03, L.cellToWorldZ(L.exit.row));
  worldGroup.add(mkExit);

  const pillar = new THREE.Mesh(exitPillarGeo, exitPillarMat);
  pillar.position.set(L.cellToWorldX(L.exit.col), 7, L.cellToWorldZ(L.exit.row));
  worldGroup.add(pillar);

  buildLiftPads(L);
}

/* ------------------------------------------------------------- lift pads */
// A pad is a light well: a ring on the floor, a faint column all the way up to
// the deck and a cap ring at deck height, so from across the level you can see
// both where it is and that there is a level above you to get to.
const liftRingGeo = new THREE.RingGeometry(1.15, 1.6, 40);
const liftDiscGeo = new THREE.RingGeometry(0, 1.12, 40);
const liftColumnGeo = new THREE.CylinderGeometry(1.25, 1.25, LIFT.alt, 20, 1, true);
const liftCapGeo = new THREE.RingGeometry(0.9, 1.3, 36);
const liftArrowGeo = new THREE.ConeGeometry(0.34, 0.62, 4);
const LIFT_COOL = 0x5ef0ff;

function buildLiftPad(x, z) {
  const group = new THREE.Group();
  const mk = (opacity) => new THREE.MeshBasicMaterial({
    color: LIFT_COOL, transparent: true, opacity, side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
  });
  const ringMat = mk(0.55);
  const ring = new THREE.Mesh(liftRingGeo, ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.06;
  group.add(ring);

  const discMat = mk(0.12);
  const disc = new THREE.Mesh(liftDiscGeo, discMat);
  disc.rotation.x = -Math.PI / 2;
  disc.position.y = 0.05;
  group.add(disc);

  const colMat = mk(0.05);
  const column = new THREE.Mesh(liftColumnGeo, colMat);
  column.position.y = LIFT.alt / 2;
  group.add(column);

  const capMat = mk(0.4);
  const cap = new THREE.Mesh(liftCapGeo, capMat);
  cap.rotation.x = -Math.PI / 2;
  cap.position.y = LIFT.alt;
  group.add(cap);

  const arrowMat = mk(0.85);
  const arrow = new THREE.Mesh(liftArrowGeo, arrowMat);
  arrow.position.y = 2.1;
  group.add(arrow);

  group.position.set(x, 0, z);
  worldGroup.add(group);
  return {
    x, z, group, ring, ringMat, disc, discMat, column, colMat, cap, capMat, arrow, arrowMat,
    used: false, t: decor() * 9,
  };
}

function buildLiftPads(L) {
  pads = [];
  for (const cell of L.lifts) {
    const pad = buildLiftPad(L.cellToWorldX(cell.col), L.cellToWorldZ(cell.row));
    pad.col = cell.col;
    pad.row = cell.row;
    if (cell.vault) {
      // the pad sits in the middle of a courtyard with a cell of open floor on
      // every side, so it is simply driven onto like any other pad
      pad.vault = true;
      pad.r = LIFT.padR + 0.8;
      pad.group.scale.set(1.25, 1, 1.25);
    } else {
      pad.r = LIFT.padR;
    }
    pads.push(pad);
  }
  // ordinary pads first: they are the ones you can drive up to from anywhere,
  // and the probes and poses use pads[0] as "a normal one"
  pads.sort((a, b) => (a.vault ? 1 : 0) - (b.vault ? 1 : 0));
}

// Where the craft would come down: the floor, or the top of whatever wall is
// under it. The marker turns red when the clock is nearly out.
function wallTopAt(x, z) {
  const cell = level.cellOf(x, z);
  return wallTop.get(`${cell.col},${cell.row}`) ?? 0.06;
}

const dropRingGeo = new THREE.RingGeometry(0.72, 1.02, 30);
const dropRingMat = new THREE.MeshBasicMaterial({
  color: 0x8ff6ff, transparent: true, opacity: 0.5, side: THREE.DoubleSide,
  blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
});
const dropRingWarnMat = new THREE.MeshBasicMaterial({
  color: 0xff6b6b, transparent: true, opacity: 0.5, side: THREE.DoubleSide,
  blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
});
const dropRing = new THREE.Mesh(dropRingGeo, dropRingMat);
dropRing.rotation.x = -Math.PI / 2;
dropRing.visible = false;
scene.add(dropRing);

/* ------------------------------------------------------------------ player */
// Built around a unit-radius disc (the hull silhouette is r = 1), so anything
// meant to be seen must sit at r > 1 or clearly above the hull top.
function buildUfo() {
  const group = new THREE.Group();
  const metal = new THREE.MeshStandardMaterial({ color: 0xc9d6e6, metalness: 0.45, roughness: 0.3, emissive: 0x121d2a, emissiveIntensity: 1 });
  const darkMetal = new THREE.MeshStandardMaterial({ color: 0x2b333f, metalness: 0.5, roughness: 0.5, emissive: 0x0a1017, emissiveIntensity: 1 });

  const belly = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), darkMetal);
  belly.scale.set(0.86, 0.42, 0.86);
  belly.position.y = -0.1;
  group.add(belly);

  const hull = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), metal);
  hull.scale.set(1, 0.28, 1);
  group.add(hull);

  // equator band — just outside the hull so it reads as a rim
  const band = new THREE.Mesh(
    new THREE.TorusGeometry(1.015, 0.05, 12, 72),
    new THREE.MeshStandardMaterial({ color: 0x38e8d8, emissive: 0x38e8d8, emissiveIntensity: 2.8, metalness: 0.4, roughness: 0.3 })
  );
  band.rotation.x = Math.PI / 2;
  group.add(band);

  const deck = new THREE.Mesh(new THREE.CylinderGeometry(0.46, 0.6, 0.12, 40), metal);
  deck.position.y = 0.17;
  group.add(deck);

  const domeMat = new THREE.MeshStandardMaterial({
    color: 0xa5f3fc, transparent: true, opacity: 0.6,
    emissive: 0x35d6e8, emissiveIntensity: 1.2, metalness: 0.2, roughness: 0.05,
  });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(0.4, 32, 20, 0, Math.PI * 2, 0, Math.PI / 2), domeMat);
  dome.position.y = 0.2;
  group.add(dome);

  // four dashed arcs sweeping around the rim
  const ringGroup = new THREE.Group();
  ringGroup.rotation.x = Math.PI / 2;
  const ringSpin = new THREE.Group();
  const ringMat = new THREE.MeshStandardMaterial({ color: 0x8b7bff, emissive: 0x8b7bff, emissiveIntensity: 2.4, metalness: 0.5, roughness: 0.3 });
  for (let i = 0; i < 4; i++) {
    const arc = new THREE.Mesh(new THREE.TorusGeometry(1.09, 0.026, 8, 20, Math.PI * 0.55), ringMat);
    arc.rotation.z = (i / 4) * Math.PI * 2;
    ringSpin.add(arc);
  }
  ringGroup.add(ringSpin);
  group.add(ringGroup);

  // running lights around the rim
  const spinner = new THREE.Group();
  const dotMat = new THREE.MeshStandardMaterial({ color: 0xfff3d6, emissive: 0xffd27d, emissiveIntensity: 3.2 });
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.07, 10, 8), dotMat);
    dot.position.set(Math.cos(a) * 1.06, 0, Math.sin(a) * 1.06);
    spinner.add(dot);
  }
  group.add(spinner);

  // hull plates, sitting on the sloped top so the surface is not bare
  const panelMat = new THREE.MeshStandardMaterial({ color: 0x7f8c9e, metalness: 0.6, roughness: 0.35, emissive: 0x141c26, emissiveIntensity: 1 });
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.3;
    const panel = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.06, 0.16), panelMat);
    panel.position.set(Math.cos(a) * 0.68, 0.208, Math.sin(a) * 0.68);
    panel.rotation.y = -a;
    panel.rotation.z = 0.16;
    group.add(panel);
  }

  const beacon = new THREE.Mesh(
    new THREE.SphereGeometry(0.075, 12, 10),
    new THREE.MeshStandardMaterial({ color: 0xff6b6b, emissive: 0xff3b3b, emissiveIntensity: 3.2 })
  );
  beacon.position.y = 0.64;
  group.add(beacon);

  // cannon under the nose (local -Z is forward), tip poking past the rim
  const gunMat = new THREE.MeshStandardMaterial({ color: 0x546274, metalness: 0.7, roughness: 0.3, emissive: 0x0d2530, emissiveIntensity: 1 });
  const gun = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.11, 0.8, 12), gunMat);
  gun.rotation.x = Math.PI / 2;
  gun.position.set(0, -0.1, -0.68);
  group.add(gun);
  const gunRing = new THREE.Mesh(new THREE.TorusGeometry(0.1, 0.028, 8, 20), band.material);
  gunRing.position.set(0, -0.1, -1.06);
  group.add(gunRing);

  const muzzle = new THREE.Mesh(
    new THREE.SphereGeometry(0.28, 10, 8),
    new THREE.MeshBasicMaterial({ color: 0xbdf6ff, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false })
  );
  muzzle.position.set(0, -0.1, -1.12);
  muzzle.visible = false;
  group.add(muzzle);

  return { group, spinner, beacon, ringSpin, band, domeMat, muzzle };
}

const {
  group: ufo, spinner: ufoSpinner, beacon: ufoBeacon,
  ringSpin: ufoRing, band: ufoBand, domeMat: ufoDomeMat, muzzle: ufoMuzzle,
} = buildUfo();
ufo.scale.setScalar(RADIUS);

const rig = new THREE.Group();
rig.add(ufo);
scene.add(rig);

const beam = new THREE.Mesh(
  new THREE.ConeGeometry(0.9, 1, 28, 1, true),
  new THREE.MeshBasicMaterial({
    color: 0x66e8ff, transparent: true, opacity: 0.12, side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending, depthWrite: false,
  })
);
scene.add(beam);

const glow = new THREE.Sprite(
  new THREE.SpriteMaterial({
    map: (() => {
      const s = 256;
      const { cv, ctx } = makeCanvas(s);
      const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
      g.addColorStop(0, "rgba(255,226,170,0.85)");
      g.addColorStop(0.35, "rgba(255,190,110,0.30)");
      g.addColorStop(1, "rgba(255,170,80,0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, s, s);
      const tex = new THREE.CanvasTexture(cv);
      tex.colorSpace = THREE.SRGBColorSpace;
      return tex;
    })(),
    blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
  })
);
glow.scale.setScalar(RADIUS * 3.5);
scene.add(glow);

/* ------------------------------------------------------------------ dust */
// Motes drifting up through the level. Additive and dim, so they read as dust -
// but 900 of them spread over the whole map means some of them always drift
// straight through the hull, and up on the block level that reads as snow
// falling through the craft. So the field keeps a clear pocket around it: any
// mote that comes inside the bubble is pushed back out to the rim, and nothing
// ever cuts through the saucer.
const DUST = 900;
const DUST_SPREAD = 260;
const DUST_BUBBLE_R = 3.6;   // how wide the clear pocket round the craft is
const DUST_BUBBLE_Y = 2.6;   // ...and how tall
const dustPos = new Float32Array(DUST * 3);
const dustRise = new Float32Array(DUST);
for (let i = 0; i < DUST; i++) {
  dustPos[i * 3] = (decor() - 0.5) * DUST_SPREAD;
  dustPos[i * 3 + 1] = decor() * 10;
  dustPos[i * 3 + 2] = (decor() - 0.5) * DUST_SPREAD;
  dustRise[i] = 0.15 + decor() * 0.5;
}
const dustGeo = new THREE.BufferGeometry();
dustGeo.setAttribute("position", new THREE.BufferAttribute(dustPos, 3));
scene.add(new THREE.Points(dustGeo, new THREE.PointsMaterial({
  color: 0xa8c8ff, size: 0.1, transparent: true, opacity: 0.3,
  blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
})));

function updateDust(dt) {
  const a = dustGeo.attributes.position.array;
  const cx = pos.x;
  const cy = rig.position.y;
  const cz = pos.z;
  const r2 = DUST_BUBBLE_R * DUST_BUBBLE_R;
  for (let i = 0; i < DUST; i++) {
    const x = i * 3;
    const y = x + 1;
    const z = x + 2;
    a[y] += dustRise[i] * dt;
    if (a[y] > 10.5) a[y] = 0.2;
    const dx = a[x] - cx;
    const dz = a[z] - cz;
    if (Math.abs(a[y] - cy) > DUST_BUBBLE_Y) continue;
    const d2 = dx * dx + dz * dz;
    if (d2 >= r2) continue;
    const d = Math.sqrt(d2);
    if (d < 1e-4) { a[x] = cx + DUST_BUBBLE_R; a[z] = cz; continue; }
    const k = DUST_BUBBLE_R / d;
    a[x] = cx + dx * k;
    a[z] = cz + dz * k;
  }
  dustGeo.attributes.position.needsUpdate = true;
}

/* --------------------------------------------------------------- enemies */
const enemyGroup = new THREE.Group();
scene.add(enemyGroup);
const enemyBodyGeo = new THREE.IcosahedronGeometry(1, 0);
const enemyEyeGeo = new THREE.SphereGeometry(0.22, 10, 8);
const enemyBodyMat = {
  spitter: new THREE.MeshStandardMaterial({ color: 0x8a53f0, roughness: 0.55, metalness: 0.2, emissive: 0x6a2fe0, emissiveIntensity: 0.3 }),
};
const enemyEyeMat = {
  spitter: new THREE.MeshStandardMaterial({ color: 0xe8dcff, emissive: 0xb892ff, emissiveIntensity: 2 }),
};
const ENEMY_SPEC = {
  grunt: { hp: 2, speed: 5.4 },
  spitter: { hp: 3, speed: 3.8 },
  warden: { hp: 3, speed: 0 },
};
// how often a spitter fires, and how long a warden winds up: the same everywhere
const SPIT_RATE = 2.4;

/* ------------------------------------------------------------ the spitter */
// The one that shoots. A mine reads as a mine; this has to read as a *gun*: a
// snout aimed at you and a chamber on the end of it that lights up hotter and
// hotter until it fires, then kicks back. The glow is the warning.
const spitterSnoutGeo = new THREE.ConeGeometry(0.34, 0.9, 6);
const spitterMouthGeo = new THREE.SphereGeometry(0.17, 8, 6);
const spitterFinGeo = new THREE.BoxGeometry(0.09, 0.46, 0.34);
const spitterSnoutMat = new THREE.MeshStandardMaterial({
  color: 0x2b1c4d, roughness: 0.5, metalness: 0.45, emissive: 0x3a1a66, emissiveIntensity: 0.4,
});
const spitterFinMat = new THREE.MeshStandardMaterial({
  color: 0x3a2a63, roughness: 0.6, metalness: 0.35, emissive: 0x2a1550, emissiveIntensity: 0.35,
});
const spitterMouthMat = new THREE.MeshStandardMaterial({
  color: 0xffe0ff, emissive: 0xb44bff, emissiveIntensity: 0.8,
});

function buildSpitter() {
  const group = new THREE.Group();
  const body = new THREE.Mesh(enemyBodyGeo, enemyBodyMat.spitter);
  group.add(body);
  const eye = new THREE.Mesh(enemyEyeGeo, enemyEyeMat.spitter);
  eye.position.set(0, 0.1, -0.6);
  group.add(eye);
  // local -Z is "at the player": the group is yawed onto the craft every frame
  const snout = new THREE.Mesh(spitterSnoutGeo, spitterSnoutMat);
  snout.rotation.x = -Math.PI / 2;
  snout.position.set(0, -0.05, -0.72);
  group.add(snout);
  const mouthMat = spitterMouthMat.clone(); // its own, so it can charge up
  const mouth = new THREE.Mesh(spitterMouthGeo, mouthMat);
  mouth.position.set(0, -0.05, -1.12);
  group.add(mouth);
  for (const side of [-1, 1]) {
    const fin = new THREE.Mesh(spitterFinGeo, spitterFinMat);
    fin.position.set(side * 0.74, 0.06, 0.12);
    fin.rotation.z = side * 0.34;
    group.add(fin);
  }
  return { group, body, eye, snout, mouth, mouthMat };
}

/* ------------------------------------------------------------ the warden */
// It has no legs, because its level is small and it only has to hold it: a stone
// bulb grown on a block top, roots into the stone, one big eye behind a ringed
// mouth. Every level above the floor gets one more of them.
const wardenRootGeo = new THREE.ConeGeometry(0.55, 0.5, 7);
const wardenBodyGeo = new THREE.IcosahedronGeometry(0.62, 0);
const wardenEyeGeo = new THREE.SphereGeometry(0.19, 10, 8);
const wardenLipGeo = new THREE.TorusGeometry(0.34, 0.09, 6, 16);
const wardenSpikeGeo = new THREE.ConeGeometry(0.11, 0.42, 5);
const wardenRootMat = new THREE.MeshStandardMaterial({
  color: 0x4f3620, roughness: 0.9, metalness: 0.1, emissive: 0x2a1206, emissiveIntensity: 0.6,
});
const wardenBodyMat = new THREE.MeshStandardMaterial({
  color: 0x5c4d33, roughness: 0.75, metalness: 0.2, emissive: 0x2c220c, emissiveIntensity: 0.5,
});
const wardenLipMatBase = new THREE.MeshStandardMaterial({
  color: 0xb8ff59, emissive: 0x9dff3c, emissiveIntensity: 1.2, roughness: 0.4,
});
const wardenEyeMatBase = new THREE.MeshStandardMaterial({
  color: 0xeaffc0, emissive: 0xc8ff5e, emissiveIntensity: 1.6,
});
const wardenSpikeMat = new THREE.MeshStandardMaterial({
  color: 0x4e3a22, roughness: 0.85, metalness: 0.2, emissive: 0x1c1004, emissiveIntensity: 0.5,
});

function buildWarden() {
  const group = new THREE.Group();
  const root = new THREE.Mesh(wardenRootGeo, wardenRootMat);
  root.position.y = 0.22;
  group.add(root);

  const body = new THREE.Mesh(wardenBodyGeo, wardenBodyMat);
  body.position.y = 0.72;
  group.add(body);

  // the mouth points down local -Z, which is where the craft is
  const lipMat = wardenLipMatBase.clone();
  const lip = new THREE.Mesh(wardenLipGeo, lipMat);
  lip.position.set(0, 0.76, -0.52);
  group.add(lip);
  const eyeMat = wardenEyeMatBase.clone();
  const eye = new THREE.Mesh(wardenEyeGeo, eyeMat);
  eye.position.set(0, 0.76, -0.54);
  group.add(eye);

  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + 0.4;
    const spike = new THREE.Mesh(wardenSpikeGeo, wardenSpikeMat);
    spike.position.set(Math.cos(a) * 0.52, 0.78 + Math.sin(a * 2) * 0.1, Math.sin(a) * 0.4);
    spike.rotation.z = Math.cos(a) * 0.9;
    spike.rotation.x = Math.sin(a) * 0.7;
    group.add(spike);
  }
  group.scale.setScalar(1.15); // a size you can read from the other end of a run
  return { group, body, eye, lip, lipMat, eyeMat };
}

/* ------------------------------------------------------------ the mine */
// A red diamond is a floating mine: a riveted hull, ten horns, a running light,
// and a ring on the floor that paints exactly how far the blast reaches.
const mineHullGeo = new THREE.IcosahedronGeometry(0.62, 0);
const mineHornGeo = new THREE.ConeGeometry(0.15, 0.62, 5);
const mineLampGeo = new THREE.SphereGeometry(0.2, 10, 8);
const mineRingGeo = new THREE.RingGeometry(0.86, 1, 44);
const mineDomeGeo = new THREE.RingGeometry(0, 1, 40);
const mineHullMat = new THREE.MeshStandardMaterial({
  color: 0x8f2418, roughness: 0.5, metalness: 0.55, emissive: 0xd42a2a, emissiveIntensity: 0.22,
});
const mineHornMat = new THREE.MeshStandardMaterial({
  color: 0x2a2f3a, roughness: 0.45, metalness: 0.7, emissive: 0x5a1208, emissiveIntensity: 0.3,
});
const mineLampMat = new THREE.MeshStandardMaterial({
  color: 0xffe0d0, emissive: 0xff4a2a, emissiveIntensity: 1.2,
});
const mineRingMat = new THREE.MeshBasicMaterial({
  color: 0xff5a2a, transparent: true, opacity: 0.5,
  blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
});
const mineDomeMat = new THREE.MeshBasicMaterial({
  color: 0xff3010, transparent: true, opacity: 0.08,
  blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
});

// ten horns: four around the equator, four raked up, two hanging down
const MINE_HORN_WAYS = [
  [0, 0], [Math.PI / 2, 0], [Math.PI, 0], [-Math.PI / 2, 0],
  [Math.PI / 4, 0.5], [(3 * Math.PI) / 4, 0.5], [-(3 * Math.PI) / 4, 0.5], [-Math.PI / 4, 0.5],
  [0, -0.55], [Math.PI, -0.55],
];
const MINE_HORNS = MINE_HORN_WAYS.map(([az, el]) => {
  const dir = new THREE.Vector3(
    Math.cos(el) * Math.sin(az),
    Math.sin(el),
    Math.cos(el) * Math.cos(az)
  );
  return { dir, quat: new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir) };
});

// one instanced mesh per mine: ten horns for a single draw call
const hornDummy = new THREE.Object3D();
function placeMineHorns(inst, swell) {
  for (let i = 0; i < MINE_HORNS.length; i++) {
    const h = MINE_HORNS[i];
    hornDummy.position.copy(h.dir).multiplyScalar(0.6 * swell);
    hornDummy.quaternion.copy(h.quat);
    hornDummy.scale.setScalar(swell);
    hornDummy.updateMatrix();
    inst.setMatrixAt(i, hornDummy.matrix);
  }
  inst.instanceMatrix.needsUpdate = true;
}

function buildMine(x, z) {
  const group = new THREE.Group();
  const hull = new THREE.Group(); // everything that swells when it arms
  group.add(hull);

  const body = new THREE.Mesh(mineHullGeo, mineHullMat);
  hull.add(body);

  const horns = new THREE.InstancedMesh(mineHornGeo, mineHornMat, MINE_HORNS.length);
  placeMineHorns(horns, 1);
  hull.add(horns);

  // its own light, so this one can blink on its own schedule
  const lampMat = mineLampMat.clone();
  const lamp = new THREE.Mesh(mineLampGeo, lampMat);
  lamp.position.set(0, 0, -0.34);
  hull.add(lamp);

  // the kill zone, flat on the floor: hidden until it arms
  const ringMat = mineRingMat.clone();
  const ring = new THREE.Mesh(mineRingGeo, ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.scale.setScalar(MINE.blastR);
  ring.visible = false;
  group.add(ring);

  const domeMat = mineDomeMat.clone();
  const dome = new THREE.Mesh(mineDomeGeo, domeMat);
  dome.rotation.x = -Math.PI / 2;
  dome.scale.setScalar(MINE.blastR);
  dome.visible = false;
  group.add(dome);

  group.position.set(x, 1.1, z);
  return { group, hull, body, horns, lamp, ring, dome, lampMat, ringMat, domeMat };
}

let enemies = [];

// Wall cells in world units, filtered by kind: the probes and the tests use it to
// find a low block to stand on or a real wall to be stopped by.
function cellsOfKind(kind) {
  const out = [];
  for (const [key, k] of level.wallKind) {
    if (kind && !kind(k)) continue;
    const [c, r] = key.split(",").map(Number);
    out.push({ col: c, row: r, x: level.cellToWorldX(c), z: level.cellToWorldZ(r) });
  }
  return out;
}

// Every monster is the same monster on every level: same hit points, same speed,
// same rate of fire, same knock. The level decides *where* things stand and how
// many there are, never what they are - so what you learn on one level holds on
// the next one, and a warden that hits you gently is not a thing that can exist.
function spawnEnemy(type, x, z, { guard = false, deck = false } = {}) {
  if (type === "lurker") return spawnShade(x, z);
  const spec = ENEMY_SPEC[type];
  const mine = type === "grunt" ? buildMine(x, z) : null;
  const spitter = type === "spitter" ? buildSpitter() : null;
  const warden = type === "warden" ? buildWarden() : null;
  const { group, body, eye } = mine || spitter || warden;
  const up = type === "warden" || deck; // on the block level, not the floor
  if (up) group.position.set(x, BLOCK_H, z);
  else if (!mine) group.position.set(x, 1.1, z);
  enemyGroup.add(group);

  const hp = spec.hp;
  return {
    type, group, body, eye, mine, spitter, warden, deck: up && type === "spitter",
    level: up ? 1 : 0,
    state: type === "warden" ? "lurk" : null,
    x, z, hp, maxHp: hp, r: warden ? WARDEN.r : ENEMY_R,
    speed: spec.speed,
    fireT: 1 + decor(),
    fireRate: SPIT_RATE,
    rate: WARDEN.rate,
    knock: WARDEN.knock,
    hitT: 0,
    recoilT: 0,
    dead: false,
    // mines only:  armed => the fuse is burning, and it is about to go off
    armed: false,
    fuse: 0,
    phase: fxRng() * Math.PI * 2,
    t: fxRng() * 6,
    // Guards hold a post (and are the reason the exit is still defended);
    // roamers come looking for you but give up and drift home again.
    guard,
    aggro: guard
      ? (type === "spitter" ? 34 : GUARD_AGGRO)
      : (type === "spitter" ? 46 : ROAM_AGGRO),
    homeX: x,
    homeZ: z,
    leash: guard ? 4 : 9,
    wanderA: fxRng() * Math.PI * 2,
    wanderR: 1.2 + fxRng() * 2.6,
    wanderT: fxRng() * 10,
  };
}

// where an idle monster is idly drifting towards: a slow orbit of its post
function postTarget(e) {
  const t = e.wanderT * 0.55 + e.wanderA;
  return { x: e.homeX + Math.cos(t) * e.wanderR, z: e.homeZ + Math.sin(t) * e.wanderR * 0.8 };
}

function idleStep(e, dt) {
  const home = Math.hypot(e.x - e.homeX, e.z - e.homeZ);
  let tx, tz, spd;
  if (home > e.leash) {
    tx = e.homeX; tz = e.homeZ; spd = e.speed * 0.6;
  } else {
    const p = postTarget(e);
    tx = p.x; tz = p.z; spd = e.speed * 0.3;
  }
  const dx = tx - e.x;
  const dz = tz - e.z;
  const d = Math.hypot(dx, dz);
  if (d < 0.4) return;
  const r = level.walk(e.x, e.z, (dx / d) * spd * dt, (dz / d) * spd * dt, ENEMY_R);
  e.x = r.x;
  e.z = r.z;
}

/* --------------------------------------------------------------- bullets */
const bulletGroup = new THREE.Group();
scene.add(bulletGroup);

/* The shots are not balls. Your cannon throws a needle of light; a spitter spits
   a tumbling seed with a ring around it, so what is coming at you is never in
   doubt. Both geometries point along +Y, so a shot is aimed by turning that axis
   onto its velocity. */
const boltGeo = new THREE.ConeGeometry(0.34, 2.4, 6);
const seedGeo = new THREE.OctahedronGeometry(0.5, 0);
const seedRingGeo = new THREE.TorusGeometry(0.6, 0.1, 6, 14);
const boltMat = new THREE.MeshBasicMaterial({ color: 0x9defff, toneMapped: false });
const seedMat = new THREE.MeshBasicMaterial({ color: 0xffa8e8, toneMapped: false });
const seedRingMat = new THREE.MeshBasicMaterial({ color: 0xb44bff, toneMapped: false });
// the warden's shell: fat, and it goes off like a mine when it lands
const globGeo = new THREE.IcosahedronGeometry(0.78, 1);
const globMat = new THREE.MeshBasicMaterial({ color: 0xc8ff5e, toneMapped: false });

// the glow rides along as a sprite child; built on first use, because the spark
// texture lives further down the file
let shotGlowMats = null;
function shotGlow(kind) {
  if (!shotGlowMats) {
    shotGlowMats = {
      bolt: new THREE.SpriteMaterial({
        map: sparkTex, color: 0x6ce9ff, transparent: true, opacity: 0.7,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }),
      seed: new THREE.SpriteMaterial({
        map: sparkTex, color: 0xb44bff, transparent: true, opacity: 0.75,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }),
      glob: new THREE.SpriteMaterial({
        map: sparkTex, color: 0x9dff3c, transparent: true, opacity: 0.95,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }),
    };
  }
  return shotGlowMats[kind];
}

const SHOT_UP = new THREE.Vector3(0, 1, 0);
const shotDir = new THREE.Vector3();

let bullets = [];
let eBullets = [];

function addBullet(list, kind, x, y, z, vx, vz, life, dmg, level = 0, opts = {}) {
  const isSeed = kind === "seed";
  const isGlob = kind === "glob";
  const mesh = new THREE.Mesh(
    isGlob ? globGeo : isSeed ? seedGeo : boltGeo,
    isGlob ? globMat : isSeed ? seedMat : boltMat
  );
  shotDir.set(vx, 0, vz).normalize();
  mesh.quaternion.setFromUnitVectors(SHOT_UP, shotDir);
  mesh.position.set(x, y, z);
  if (isSeed) {
    const ring = new THREE.Mesh(seedRingGeo, seedRingMat);
    ring.rotation.x = Math.PI / 2; // a ring across the flight axis
    mesh.add(ring);
  }
  const glow = new THREE.Sprite(shotGlow(isGlob ? "glob" : isSeed ? "seed" : "bolt"));
  glow.scale.setScalar(isGlob ? 1.6 : isSeed ? 1.3 : 0.85);
  mesh.add(glow);
  bulletGroup.add(mesh);
  // what it takes to touch it: a fat glob is a wide target, a seed a small one
  const r = isGlob ? 0.85 : isSeed ? 0.5 : BULLET_R;
  list.push({ x, y, z, vx, vz, life, dmg, mesh, kind, seed: isSeed, level, r, knock: opts.knock || 0 });
}

/* ------------------------------------------------------------- explosions */
// CPU-driven particle bursts. Each blast owns one small Points cloud that is
// filled once and then animated for its (short) lifetime; big ones also throw a
// shockwave shell, a ground ring and a brief light.
const fxRng = makeRng(9001);

function hexRgb(hex) {
  return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
}

const sparkTex = (() => {
  const s = 128;
  const { cv, ctx } = makeCanvas(s);
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.3, "rgba(255,255,255,0.7)");
  g.addColorStop(0.65, "rgba(255,255,255,0.16)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
})();

const shellGeo = new THREE.SphereGeometry(1, 16, 12);
const shockGeo = new THREE.RingGeometry(0.5, 1, 32);
const explosions = [];
const fxQueue = [];

// A small fixed pool of lights, always on the scene even at 0 intensity: three
// rebuilds its shaders whenever the light count changes, so the count must not
// move while the game is running.
const fxLights = [];
for (let i = 0; i < 3; i++) {
  const light = new THREE.PointLight(0xffc98a, 0, 60, 2);
  scene.add(light);
  fxLights.push({ light, t: 0, max: 0.3, power: 0 });
}
let fxLightCursor = 0;

function later(delay, fn) {
  fxQueue.push({ t: delay, fn });
}

function spawnBurst(x, y, z, {
  color = 0xffa24a,
  hot = 0xfff3d2,
  count = 26,
  speed = 15,
  size = 0.55,
  life = 0.8,
  gravity = 9,
  drag = 2.6,
  spread = 0.5,
  shell = 0,
  shock = 0,
  glow = 0,
  flash = 0,
  blending = "additive",
} = {}) {
  const p = new Float32Array(count * 3);
  const c = new Float32Array(count * 3);
  const v = new Float32Array(count * 3);
  const [br, bg, bb] = hexRgb(color);
  const [hr, hg, hb] = hexRgb(hot);

  for (let i = 0; i < count; i++) {
    const th = fxRng() * Math.PI * 2;
    const ph = Math.acos(2 * fxRng() - 1);
    const sp = speed * (0.3 + fxRng() * 0.95);
    v[i * 3] = Math.sin(ph) * Math.cos(th) * sp;
    v[i * 3 + 1] = Math.abs(Math.cos(ph)) * sp * 0.85 + sp * 0.3; // biased upward
    v[i * 3 + 2] = Math.sin(ph) * Math.sin(th) * sp;
    p[i * 3] = x + (fxRng() - 0.5) * spread;
    p[i * 3 + 1] = y + (fxRng() - 0.5) * spread;
    p[i * 3 + 2] = z + (fxRng() - 0.5) * spread;
    const t = fxRng() * fxRng(); // mostly the bright core colour
    c[i * 3] = hr + (br - hr) * t;
    c[i * 3 + 1] = hg + (bg - hg) * t;
    c[i * 3 + 2] = hb + (bb - hb) * t;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(p, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(c, 3));
  const normal = blending === "normal";
  const points = new THREE.Points(geo, new THREE.PointsMaterial({
    map: sparkTex, size, sizeAttenuation: true, transparent: true,
    blending: normal ? THREE.NormalBlending : THREE.AdditiveBlending,
    depthWrite: false, vertexColors: true, toneMapped: !normal,
  }));
  scene.add(points);

  let shellMesh = null;
  if (shell) {
    shellMesh = new THREE.Mesh(shellGeo, new THREE.MeshBasicMaterial({
      color: hot, transparent: true, opacity: 0.8,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    }));
    shellMesh.position.set(x, y, z);
    scene.add(shellMesh);
  }

  let shockMesh = null;
  if (shock) {
    shockMesh = new THREE.Mesh(shockGeo, new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.7, side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    }));
    shockMesh.rotation.x = -Math.PI / 2;
    shockMesh.position.set(x, 0.08, z);
    scene.add(shockMesh);
  }

  let glowSprite = null;
  if (glow) {
    // a billboarded ball of light: the thing that actually reads as a bang
    glowSprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: sparkTex, color: hot, transparent: true, opacity: 1,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    }));
    glowSprite.position.set(x, y + 0.2, z);
    glowSprite.scale.setScalar(glow * 0.35);
    scene.add(glowSprite);
  }

  if (flash) {
    const f = fxLights[fxLightCursor++ % fxLights.length];
    f.light.position.set(x, y + 0.4, z);
    f.light.intensity = flash;
    f.power = flash;
    f.t = 0;
    f.max = 0.28;
  }

  explosions.push({
    t: 0, life, count, gravity, drag, size, pos: p, vel: v,
    geo, points, shellMesh, shockMesh, glowSprite,
    shellSize: shell, shockSize: shock, glowSize: glow,
  });
}

const BOOM = {
  // a monster going up
  enemy: (type) => ({
    color: type === "spitter" ? 0xa06bff : 0xff7a3c,
    hot: type === "spitter" ? 0xf4e9ff : 0xfff2d4,
    count: 46, speed: 19, size: 0.85, life: 0.95,
    shell: 2.2, shock: 4.2, glow: 6.5, flash: 340,
  }),
  // a pad throwing the craft up: a ring of light and dust off the floor
  lift: () => ({
    color: 0x5ef0ff, hot: 0xf2ffff, count: 30, speed: 13, size: 0.7, life: 0.8,
    shock: 3.4, glow: 2.2, flash: 120,
  }),
  // and the touchdown: dust, no fire
  land: () => ({
    color: 0x8fa8bd, hot: 0xe8f4ff, count: 26, speed: 9, size: 0.6, life: 0.7,
    gravity: 6, shock: 2.8, blending: "normal",
  }),
  // a warden's glob bursting on the hull
  glob: () => ({
    color: 0x9dff3c, hot: 0xeaffc0, count: 22, speed: 10, size: 0.6, life: 0.55,
    gravity: 5, drag: 4, spread: 0.4,
  }),
  // a bullet puckering out against rock
  spark: () => ({
    color: 0x8fc6ff, hot: 0xffffff, count: 7, speed: 9, size: 0.24,
    life: 0.22, gravity: 1.5, drag: 7, spread: 0.25,
  }),
  // the craft itself
  player: () => ({
    color: 0x49c8ff, hot: 0xdff6ff, count: 150, speed: 34, size: 1.35,
    life: 1.8, gravity: 11, drag: 1.9, spread: 1.4,
    shell: 4, shock: 16, glow: 15, flash: 1000,
  }),
  // the exit answering when you finally reach it
  exit: () => ({
    color: 0xffd23f, hot: 0xfffbe6, count: 60, speed: 22, size: 0.8,
    life: 1.0, gravity: 8, drag: 2.4, spread: 1, shell: 3, shock: 7, glow: 10, flash: 420,
  }),
  // a shade going up: violet, huge, and it takes the light with it
  shade: () => ({
    color: 0x8a3cff, hot: 0xe6d2ff, count: 72, speed: 25, size: 1.05,
    life: 1.15, gravity: 9, drag: 2.1, spread: 1.2,
    shell: 3.4, shock: 8, glow: 12, flash: 520,
  }),
  // the moment a shade stops pretending to be part of the dark
  shadeWake: () => ({
    color: 0x6a2ad6, hot: 0xd6b0ff, count: 44, speed: 16, size: 0.9,
    life: 0.85, gravity: 4, drag: 3, spread: 1,
    shell: 2.2, shock: 6, glow: 10, flash: 380,
  }),
  // its trail: near-black smoke that hangs in the corridor
  shadeSmoke: () => ({
    color: 0x1a0630, hot: 0x4a1d80, count: 10, speed: 5, size: 1.7,
    life: 0.8, gravity: -1.4, drag: 3.2, spread: 1.3, blending: "normal",
  }),
  // a rift tearing open
  rift: () => ({
    color: 0x8f4bff, hot: 0xf0e2ff, count: 38, speed: 15, size: 0.8,
    life: 0.75, gravity: 7, drag: 2.6, spread: 0.9,
    shell: 1.9, shock: 4.4, glow: 7.5, flash: 300,
  }),
  // a mine latching on: a hard clunk and a shower of sparks
  arm: () => ({
    color: 0xffb066, hot: 0xffffff, count: 24, speed: 13, size: 0.5,
    life: 0.45, gravity: 7, drag: 4, spread: 0.6, glow: 4, flash: 220,
  }),
  // and then the mine itself: a flat orange fireball as wide as its kill zone
  mine: () => ({
    color: 0xff7a2a, hot: 0xfff0c8, count: 78, speed: 27, size: 1.15,
    life: 1.1, gravity: 9, drag: 2.1, spread: 1.3,
    shell: 3.2, shock: MINE.blastR, glow: 13, flash: 620,
  }),
  // the dust and grit thrown up behind flying wreckage
  grit: (color = 0x2b1a12, hot = 0xffa860) => ({
    color, hot, count: 26, speed: 12, size: 0.7,
    life: 0.7, gravity: 13, drag: 3.4, spread: 0.9, blending: "normal",
  }),
};

/* --------------------------------------------------- the hover thruster */
// Rings pushed down out of the hull and a flare under it - but only while the
// craft is actually holding itself up on its own. Stand on a block top and it all
// stops, so "am I spending energy?" is something you can see, not read.
const hoverFx = new THREE.Group();
rig.add(hoverFx);

const hoverRingGeo = new THREE.RingGeometry(0.55, 0.78, 28);
const hoverRings = [0, 1, 2].map(() => {
  const ring = new THREE.Mesh(hoverRingGeo, new THREE.MeshBasicMaterial({
    color: 0x8ff6ff, transparent: true, opacity: 0, side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
  }));
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = -0.45;
  hoverFx.add(ring);
  return ring;
});

const hoverFlare = new THREE.Sprite(new THREE.SpriteMaterial({
  map: sparkTex, color: 0x9df6ff, transparent: true, opacity: 0.9,
  blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
}));
hoverFlare.scale.setScalar(1.9);
hoverFlare.position.y = -0.55;
hoverFx.add(hoverFlare);

const hoverArcMat = new THREE.MeshBasicMaterial({
  color: 0xd6fbff, transparent: true, opacity: 0.6,
  blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
});
const hoverArcGeo = new THREE.TorusGeometry(0.92, 0.028, 6, 20, Math.PI * 1.15);
const hoverArcs = [0, 1].map((i) => {
  const arc = new THREE.Mesh(hoverArcGeo, hoverArcMat);
  arc.rotation.x = Math.PI / 2;
  arc.position.y = -0.3;
  arc.rotation.z = i * Math.PI;
  hoverFx.add(arc);
  return arc;
});
hoverFx.visible = false;

function updateHoverFx(t) {
  // the hover is the only time it is spending energy on staying up: one level up
  // with no block underneath, or on the floor over a hole
  const spending = falling > 0 ||
    (((lift > 0.06 || liftUp) && !onBlockLevel()) || overHole());
  hoverFx.visible = spending;
  if (!spending) return;

  // the meter is the strain: emptier means working harder
  const strain = 1 - clamp01(charge / LIFT.time);
  const period = 0.5 - strain * 0.16;
  for (let i = 0; i < hoverRings.length; i++) {
    const k = ((t / period) + i / hoverRings.length) % 1;
    const ring = hoverRings[i];
    ring.scale.setScalar(0.75 + k * 1.8);
    ring.position.y = -0.42 - k * 0.85;
    ring.material.opacity = (1 - k) * (0.4 + strain * 0.3);
  }
  const pulse = 0.5 + 0.5 * Math.sin(t * (16 + strain * 12));
  hoverFlare.scale.setScalar(1.55 + pulse * 0.5 + strain * 0.5);
  hoverFlare.material.opacity = 0.4 + pulse * 0.25 + strain * 0.25;
  hoverArcs[0].rotation.z = t * (3.4 + strain * 3);
  hoverArcs[1].rotation.z = Math.PI - t * (2.6 + strain * 2.4);
  hoverArcMat.opacity = 0.35 + strain * 0.45;
}

function blowUpPlayer() {
  spawnBurst(pos.x, HOVER, pos.z, BOOM.player());
  ufo.visible = false;
  shake = Math.min(1.6, shake + 1.2);
  // a few secondary detonations rolling out of the wreck
  for (let i = 0; i < 5; i++) {
    const a = fxRng() * Math.PI * 2;
    const r = 1.5 + fxRng() * 3.5;
    later(0.12 + i * 0.14, () => spawnBurst(
      pos.x + Math.cos(a) * r, HOVER + (fxRng() - 0.3) * 1.2, pos.z + Math.sin(a) * r,
      {
        color: 0xffb066, hot: 0xfff0cf, count: 34, speed: 18, size: 0.9, life: 0.9,
        shell: 2.5, shock: 4.5, glow: 8, flash: 280,
      }
    ));
  }
}

function updateExplosions(dt) {
  for (let i = explosions.length - 1; i >= 0; i--) {
    const e = explosions[i];
    e.t += dt;
    const k = e.t / e.life;
    if (k >= 1) {
      scene.remove(e.points);
      e.geo.dispose();
      e.points.material.dispose();
      if (e.shellMesh) { scene.remove(e.shellMesh); e.shellMesh.material.dispose(); }
      if (e.shockMesh) { scene.remove(e.shockMesh); e.shockMesh.material.dispose(); }
      if (e.glowSprite) { scene.remove(e.glowSprite); e.glowSprite.material.dispose(); }
      explosions.splice(i, 1);
      continue;
    }

    const damp = Math.exp(-e.drag * dt);
    const a = e.pos;
    for (let n = 0; n < e.count; n++) {
      const ix = n * 3;
      const iy = ix + 1;
      const iz = ix + 2;
      e.vel[iy] -= e.gravity * dt;
      e.vel[ix] *= damp;
      e.vel[iy] *= damp;
      e.vel[iz] *= damp;
      a[ix] += e.vel[ix] * dt;
      a[iy] += e.vel[iy] * dt;
      a[iz] += e.vel[iz] * dt;
      if (a[iy] < 0.08) { a[iy] = 0.08; e.vel[iy] *= -0.3; } // skitter along the floor
    }
    e.geo.attributes.position.needsUpdate = true;
    e.points.material.opacity = (1 - k) * (1 - k);
    e.points.material.size = e.size * (1 - k * 0.55);

    if (e.shellMesh) {
      e.shellMesh.scale.setScalar(e.shellSize * (0.2 + k * 0.85));
      e.shellMesh.material.opacity = 0.5 * Math.pow(1 - k, 1.6);
    }
    if (e.shockMesh) {
      e.shockMesh.scale.setScalar(e.shockSize * (0.3 + k * 1.5));
      e.shockMesh.material.opacity = 0.75 * Math.pow(1 - k, 2);
    }
    if (e.glowSprite) {
      // snap open, then collapse
      const g = Math.min(1, k / 0.18);
      e.glowSprite.scale.setScalar(e.glowSize * (0.35 + g * 0.95) * (1 - k * 0.3));
      e.glowSprite.material.opacity = Math.pow(1 - k, 1.5);
    }
  }

  for (const f of fxLights) {
    if (f.t >= f.max) continue;
    f.t += dt;
    const k = Math.min(1, f.t / f.max);
    f.light.intensity = f.power * Math.pow(1 - k, 2.2);
    if (k >= 1) f.light.intensity = 0;
  }

  for (let i = fxQueue.length - 1; i >= 0; i--) {
    fxQueue[i].t -= dt;
    if (fxQueue[i].t <= 0) {
      const fn = fxQueue[i].fn;
      fxQueue.splice(i, 1);
      fn();
    }
  }
}

function clearExplosions() {
  for (const e of explosions) {
    scene.remove(e.points);
    if (e.shellMesh) scene.remove(e.shellMesh);
    if (e.shockMesh) scene.remove(e.shockMesh);
    if (e.glowSprite) scene.remove(e.glowSprite);
  }
  explosions.length = 0;
  fxQueue.length = 0;
  for (const f of fxLights) { f.light.intensity = 0; f.t = f.max; }
}

/* ---------------------------------------------------------------- debris */
// What is left of a thing that just came apart: shards, slivers and embers that
// arc out, bounce, settle on the floor, and leave a scorch that fades much
// later. Not meat: wreckage.
const debrisGroup = new THREE.Group();
scene.add(debrisGroup);

const debrisShardGeo = new THREE.IcosahedronGeometry(0.2, 0);
const debrisSliverGeo = new THREE.BoxGeometry(0.11, 0.11, 0.5);
const debrisPlateGeo = new THREE.BoxGeometry(0.32, 0.06, 0.24);

function splatTexture() {
  const s = 128;
  const { cv, ctx } = makeCanvas(s);
  for (let i = 0; i < 10; i++) {
    const x = s * (0.18 + texRng() * 0.64);
    const y = s * (0.18 + texRng() * 0.64);
    const r = s * (0.07 + texRng() * 0.25);
    ctx.fillStyle = `rgba(255,255,255,${(0.45 + texRng() * 0.55).toFixed(2)})`;
    ctx.beginPath();
    ctx.ellipse(x, y, r, r * (0.6 + texRng() * 0.7), texRng() * 3, 0, Math.PI * 2);
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const splatGeo = new THREE.RingGeometry(0.16, 1, 18);
const splatTex = splatTexture();

// One palette per thing that comes apart. Three materials each, so a hundred
// pieces of wreckage are still three materials.
function debrisPalette({ dark, mid, hot, ember, grit, gritHot, scorch, scorchDim }) {
  return {
    mats: [
      new THREE.MeshStandardMaterial({ color: dark, roughness: 0.72, metalness: 0.45, emissive: ember, emissiveIntensity: 0.3 }),
      new THREE.MeshStandardMaterial({ color: mid, roughness: 0.5, metalness: 0.5, emissive: ember, emissiveIntensity: 0.75 }),
      new THREE.MeshStandardMaterial({ color: hot, roughness: 0.32, metalness: 0.25, emissive: ember, emissiveIntensity: 1.6 }),
    ],
    grit, gritHot,
    scorch: [
      new THREE.MeshBasicMaterial({ map: splatTex, color: scorch, transparent: true, opacity: 0.78, depthWrite: false }),
      new THREE.MeshBasicMaterial({ map: splatTex, color: scorchDim, transparent: true, opacity: 0.7, depthWrite: false }),
    ],
  };
}

const DEBRIS = {
  // a mine going off: scorched steel and embers
  blast: debrisPalette({
    dark: 0x2b1a12, mid: 0x8a3d16, hot: 0xffa855, ember: 0xff6a1a,
    grit: 0x2b1a12, gritHot: 0xffa860, scorch: 0x3a1c0c, scorchDim: 0x1d0d07,
  }),
  spitter: debrisPalette({
    dark: 0x1d1636, mid: 0x5b34a8, hot: 0xc79bff, ember: 0x8b4bff,
    grit: 0x1a1030, gritHot: 0xb892ff, scorch: 0x2a1c4a, scorchDim: 0x140c26,
  }),
  shade: debrisPalette({
    dark: 0x110a20, mid: 0x3d1a63, hot: 0x9a5cff, ember: 0x6a2ad6,
    grit: 0x120826, gritHot: 0x9a5cff, scorch: 0x1e0f3a, scorchDim: 0x0e0619,
  }),
  player: debrisPalette({
    dark: 0x143038, mid: 0x2f8fa8, hot: 0x9be9ff, ember: 0x27d8ff,
    grit: 0x102428, gritHot: 0x6ce9ff, scorch: 0x14404d, scorchDim: 0x0a2028,
  }),
};

let debris = [];
const splats = [];

function addSplat(x, z, palette) {
  const pal = DEBRIS[palette] || DEBRIS.blast;
  const mesh = new THREE.Mesh(splatGeo, pal.scorch[fxRng() < 0.5 ? 0 : 1]);
  mesh.rotation.x = -Math.PI / 2;
  mesh.rotation.z = fxRng() * Math.PI * 2;
  mesh.scale.setScalar(0.85 + fxRng() * 1.7);
  mesh.position.set(x, 0.022 + splats.length * 0.0005, z);
  debrisGroup.add(mesh);
  splats.push({ mesh, t: 0, life: 22 + fxRng() * 12 });
  if (splats.length > 54) {
    const old = splats.shift();
    debrisGroup.remove(old.mesh);
  }
}

function spawnDebris(x, y, z, {
  palette = "blast", count = 12, speed = 14, lift = 11, spread = 0.8, life = 11,
} = {}) {
  const pal = DEBRIS[palette] || DEBRIS.blast;
  for (let i = 0; i < count; i++) {
    const pick = fxRng();
    const mesh = new THREE.Mesh(
      pick < 0.4 ? debrisSliverGeo : pick < 0.65 ? debrisPlateGeo : debrisShardGeo,
      pal.mats[fxRng() < 0.4 ? 2 : fxRng() < 0.6 ? 1 : 0]
    );
    const th = fxRng() * Math.PI * 2;
    const sp = speed * (0.35 + fxRng() * 0.95);
    const sx = 0.5 + fxRng() * 0.95;
    const sy = 0.5 + fxRng() * 0.7;
    const sz = 0.5 + fxRng() * 0.95;
    mesh.scale.set(sx, sy, sz);
    debrisGroup.add(mesh);
    debris.push({
      mesh, sx, sy, sz, palette,
      x: x + (fxRng() - 0.5) * spread,
      y: y + (fxRng() - 0.5) * spread,
      z: z + (fxRng() - 0.5) * spread,
      vx: Math.cos(th) * sp,
      vy: lift * (0.35 + fxRng() * 0.95),
      vz: Math.sin(th) * sp,
      spin: [(fxRng() - 0.5) * 15, (fxRng() - 0.5) * 15, (fxRng() - 0.5) * 15],
      t: 0,
      life: life * (0.65 + fxRng() * 0.7),
      rest: false,
      settled: false,
    });
  }
  spawnBurst(x, y, z, BOOM.grit(pal.grit, pal.gritHot));
  while (debris.length > 120) {
    const old = debris.shift();
    debrisGroup.remove(old.mesh);
  }
}

function updateDebris(dt) {
  for (let i = debris.length - 1; i >= 0; i--) {
    const g = debris[i];
    g.t += dt;
    if (g.t >= g.life) {
      debrisGroup.remove(g.mesh);
      debris.splice(i, 1);
      continue;
    }
    if (!g.rest) {
      g.vy -= 17 * dt;
      g.x += g.vx * dt;
      g.y += g.vy * dt;
      g.z += g.vz * dt;
      g.vx *= 0.995;
      g.vz *= 0.995;
      g.mesh.rotation.x += g.spin[0] * dt;
      g.mesh.rotation.y += g.spin[1] * dt;
      g.mesh.rotation.z += g.spin[2] * dt;
      if (g.y <= 0.18) {
        g.y = 0.18;
        g.vy *= -0.34;
        g.vx *= 0.55;
        g.vz *= 0.55;
        g.spin[0] *= 0.4;
        g.spin[1] *= 0.4;
        g.spin[2] *= 0.4;
        if (!g.settled) {
          g.settled = true;
          addSplat(g.x, g.z, g.palette);
        }
        if (Math.abs(g.vy) < 1.6) {
          g.vy = 0;
          g.rest = true;
        }
      }
      g.mesh.position.set(g.x, g.y, g.z);
    }
    const k = g.t / g.life;
    const fade = k < 0.72 ? 1 : Math.max(0.001, 1 - (k - 0.72) / 0.28);
    g.mesh.scale.set(g.sx * fade, g.sy * fade, g.sz * fade);
  }

  for (let i = splats.length - 1; i >= 0; i--) {
    const s = splats[i];
    s.t += dt;
    if (s.t >= s.life) {
      debrisGroup.remove(s.mesh);
      splats.splice(i, 1);
    }
  }
}

function clearDebris() {
  for (const g of debris) debrisGroup.remove(g.mesh);
  debris = [];
  for (const s of splats) debrisGroup.remove(s.mesh);
  splats.length = 0;
}

/* ----------------------------------------------------------- the shade */
// The dark itself, out of the maze. It waits in a room looking like a shadow on
// the floor, walks you down slowly, then throws itself at you. Touching it is
// the end of the run: you both go up.
const shadeCoreGeo = new THREE.IcosahedronGeometry(1.12, 1);
const shadeShardGeo = new THREE.IcosahedronGeometry(0.36, 0);
// a sparse cage: a dense one just fogs the black into grey
const shadeShellGeo = new THREE.IcosahedronGeometry(1.12, 0);
const shadeEyeGeo = new THREE.SphereGeometry(0.16, 8, 6);
const shadePoolGeo = new THREE.RingGeometry(0, 1.75, 26);
const shadeRingGeo = new THREE.TorusGeometry(1.15, 0.085, 6, 22);

function shadeLook() {
  const group = new THREE.Group();

  // a hole, not a body: albedo zero, so nothing lights it
  const coreMat = new THREE.MeshStandardMaterial({
    color: 0x000000, roughness: 1, metalness: 0, emissive: 0x000000, emissiveIntensity: 0,
  });
  const core = new THREE.Mesh(shadeCoreGeo, coreMat);
  core.position.y = 1.05;
  group.add(core);

  // just enough wire to hint at a shape inside the black
  const shellMat = new THREE.MeshBasicMaterial({
    color: 0x7a3ce0, wireframe: true, transparent: true, opacity: 0.04, toneMapped: false,
  });
  const shell = new THREE.Mesh(shadeShellGeo, shellMat);
  shell.position.y = 1.05;
  shell.scale.setScalar(1.46);
  group.add(shell);

  const shardMat = new THREE.MeshStandardMaterial({
    color: 0x0d0718, roughness: 0.75, metalness: 0.1, emissive: 0x54159e, emissiveIntensity: 0.22,
  });
  const shards = [];
  for (let i = 0; i < 6; i++) {
    const m = new THREE.Mesh(shadeShardGeo, shardMat);
    m.userData = {
      a: (i / 6) * Math.PI * 2,
      base: 1.45 + (i % 3) * 0.36,
      y: 0.45 + (i % 4) * 0.4,
      spin: 1 + i * 0.35,
    };
    group.add(m);
    shards.push(m);
  }

  const eyeMat = new THREE.MeshBasicMaterial({ color: 0xf3e0ff, toneMapped: false, transparent: true, opacity: 0.35 });
  const eyeL = new THREE.Mesh(shadeEyeGeo, eyeMat);
  const eyeR = new THREE.Mesh(shadeEyeGeo, eyeMat);
  eyeL.position.set(-0.33, 1.3, -0.8);
  eyeR.position.set(0.33, 1.3, -0.8);
  group.add(eyeL, eyeR);

  const poolMat = new THREE.MeshBasicMaterial({
    color: 0x020106, transparent: true, opacity: 0.6, depthWrite: false, side: THREE.DoubleSide,
  });
  const pool = new THREE.Mesh(shadePoolGeo, poolMat);
  pool.rotation.x = -Math.PI / 2;
  pool.scale.setScalar(1.35);
  pool.position.y = -1.02;
  group.add(pool);

  const ringMat = new THREE.MeshBasicMaterial({
    color: 0x9a5cff, transparent: true, opacity: 0, toneMapped: false, side: THREE.DoubleSide,
  });
  const ring = new THREE.Mesh(shadeRingGeo, ringMat);
  ring.position.y = 1.05;
  group.add(ring);

  const auraMat = new THREE.SpriteMaterial({
    map: sparkTex, color: 0x12042a, transparent: true, opacity: 0.45, depthWrite: false,
  });
  const aura = new THREE.Sprite(auraMat);
  aura.position.y = 1.0;
  aura.scale.setScalar(6.2);
  group.add(aura);

  return {
    group, core, shell, shards, eyes: [eyeL, eyeR], pool, ring, aura,
    coreMat, shellMat, shardMat, eyeMat, poolMat, ringMat, auraMat,
  };
}

function spawnShade(x, z) {
  const look = shadeLook();
  look.group.position.set(x, 0.7, z);
  enemyGroup.add(look.group);
  const hp = LURK.hp;
  return {
    ...look,
    type: "lurker", group: look.group, level: 0,
    x, z, hp, maxHp: hp, r: LURK.radius,
    speed: LURK.stalkSpeed, dead: false, hitT: 0, guard: false,
    homeX: x, homeZ: z, aggro: LURK.wake, leash: 0,
    state: "lurk", t: 0, phase: fxRng() * 6.28,
    wakeT: 0, wakeDur: 0.75, stalkT: 0, chargeT: 0, recoverT: 0,
    cdx: 0, cdz: 0, trailT: 0,
  };
}

function wakeShade(e) {
  e.state = "wake";
  e.wakeT = e.wakeDur;
  spawnBurst(e.x, 1.2, e.z, BOOM.shadeWake());
  gameAudio.sfx("shadeWake", { x: e.x, z: e.z });
  gameAudio.poke(1);
  shake = Math.min(1.6, shake + 0.75);
  hurtFlash = Math.min(1, hurtFlash + 0.22);
}

function shadeKills(e) {
  if (state !== "playing") return;
  if (airborne()) return; // it cannot reach the deck either
  killEnemy(e);
  killPlayer();
}

function stepShade(e, dt) {
  const dx = pos.x - e.x;
  const dz = pos.z - e.z;
  const d = Math.hypot(dx, dz) || 1e-6;
  const ux = dx / d;
  const uz = dz / d;
  e.t += dt;
  e.hitT = Math.max(0, e.hitT - dt);

  // out of reach for long enough and it loses you: back to a shadow where it is,
  // instead of trailing the craft across the whole level
  if (e.state !== "lurk") {
    if (d > LURK.leash) {
      e.offT = (e.offT || 0) + dt;
      if (e.offT > LURK.giveUp) {
        e.state = "lurk";
        e.offT = 0;
        e.group.position.set(e.x, 0.7, e.z);
        e.ringMat.opacity = 0;
        e.ring.scale.setScalar(1);
        spawnBurst(e.x, 0.8, e.z, BOOM.shadeSmoke());
        gameAudio.sfx("shadeSettle", { x: e.x, z: e.z });
      }
    } else {
      e.offT = 0;
    }
  }

  const pulse = 0.5 + 0.5 * Math.sin(e.t * 3.6 + e.phase);
  const awake = e.state !== "lurk";

  for (const m of e.shards) {
    const u = m.userData;
    const a = u.a + e.t * u.spin * (awake ? 1.6 : 0.3);
    const r = u.base * (e.state === "wake" ? 1 + (1 - Math.max(0, e.wakeT) / e.wakeDur) * 1.1 : 1);
    m.position.set(Math.cos(a) * r, u.y + Math.sin(e.t * 2 + u.a) * 0.18, Math.sin(a) * r);
    m.rotation.set(e.t * 1.7 + u.a, e.t * 2.2, e.t * 0.9);
    m.scale.setScalar(awake ? 0.85 + pulse * 0.35 : 0.7);
  }
  e.shell.rotation.set(e.t * 0.5, e.t * 0.8, e.t * 0.35);
  e.pool.rotation.z = e.t * 0.35;
  e.core.scale.setScalar(1 + (e.state === "lurk" ? pulse * 0.05 : pulse * 0.12));
  // the shadow it casts stays on the floor no matter how high it rears up
  e.pool.position.y = 0.04 - e.group.position.y;

  if (e.state === "lurk") {
    e.group.position.set(e.x, 0.7 + Math.sin(e.t * 1.4 + e.phase) * 0.05, e.z);
    // it keeps its eyes on you even while it pretends to be a shadow
    e.group.rotation.y += (Math.atan2(-dx, -dz) - e.group.rotation.y) * Math.min(1, dt * 1.5);
    e.eyeMat.opacity = 0.22 + pulse * 0.3;
    e.poolMat.opacity = 0.55 + pulse * 0.16;
    e.auraMat.opacity = 0.4 + pulse * 0.12;
    e.shellMat.opacity = 0.05 + pulse * 0.05;
    if (d < LURK.wake) wakeShade(e);
    return;
  }

  if (e.state === "wake") {
    e.wakeT -= dt;
    const k = 1 - Math.max(0, e.wakeT) / e.wakeDur;
    e.group.position.set(e.x, 0.7 + k * 1.15, e.z);
    e.group.rotation.y = Math.atan2(-dx, -dz);
    e.eyeMat.opacity = 1;
    e.auraMat.opacity = 0.5 + k * 0.35;
    e.poolMat.opacity = 0.7 + k * 0.25;
    e.shellMat.opacity = 0.15 + k * 0.35;
    e.ringMat.opacity = 0.5 * (1 - k);
    e.ring.scale.setScalar(1 + k * 2.8);
    e.ring.rotation.z = e.t * 4;
    if (e.wakeT <= 0) {
      e.state = "stalk";
      e.stalkT = LURK.stalkTime;
      e.ringMat.opacity = 0;
      e.ring.scale.setScalar(1);
    }
    return;
  }

  if (e.state === "stalk") {
    e.stalkT -= dt;
    const r = level.walk(e.x, e.z, ux * LURK.stalkSpeed * dt, uz * LURK.stalkSpeed * dt, LURK.radius);
    e.x = r.x;
    e.z = r.z;
    e.group.position.set(e.x, 1.05 + Math.sin(e.t * 2.3) * 0.12, e.z);
    e.group.rotation.y = Math.atan2(-dx, -dz);

    e.auraMat.opacity = 0.55;
    e.poolMat.opacity = 0.8;
    e.shellMat.opacity = 0.14 + pulse * 0.12;
    if (e.stalkT <= 0 || d < LURK.chargeDist) {
      e.state = "charge";
      e.chargeT = 0;
      e.cdx = ux;
      e.cdz = uz;
      e.trailT = 0;
      spawnBurst(e.x, 1.2, e.z, BOOM.shadeWake());
      gameAudio.sfx("shadeCharge", { x: e.x, z: e.z });
      shake = Math.min(1.6, shake + 0.5);
    }
  } else if (e.state === "charge") {
    e.chargeT += dt;
    const px = e.x;
    const pz = e.z;
    const r = level.walk(e.x, e.z, e.cdx * LURK.chargeSpeed * dt, e.cdz * LURK.chargeSpeed * dt, LURK.radius);
    e.x = r.x;
    e.z = r.z;
    e.trailT -= dt;
    if (e.trailT <= 0) {
      e.trailT = 0.045;
      spawnBurst(e.x, 0.9, e.z, BOOM.shadeSmoke());
    }
    e.group.position.set(e.x, 0.95, e.z);
    e.group.rotation.y = Math.atan2(-e.cdx, -e.cdz);
    e.shellMat.opacity = 0.42 + pulse * 0.22;
    e.auraMat.opacity = 0.68;
    e.poolMat.opacity = 0.5;
    const moved = Math.hypot(e.x - px, e.z - pz);
    if (e.chargeT > LURK.dashTime || moved < LURK.chargeSpeed * dt * 0.35) {
      // a wall stopped it, and that is the shake: it gets the heavy one. Running
      // out of dash instead is the same event, quieter.
      const slammed = moved < LURK.chargeSpeed * dt * 0.35;
      e.state = "recover";
      e.recoverT = LURK.recover;
      shake = Math.min(1.5, shake + 0.55);
      spawnBurst(e.x, 0.9, e.z, BOOM.shadeSmoke());
      gameAudio.sfx("shadeCrash", { x: e.x, z: e.z, vol: slammed ? 1 : 0.5 });
    }
  } else {
    e.recoverT -= dt;
    e.group.position.set(e.x, 0.9 + Math.sin(e.t * 9) * 0.07, e.z);
    e.shellMat.opacity = 0.12 + pulse * 0.1;
    e.auraMat.opacity = 0.42;
    e.poolMat.opacity = 0.6;
    if (e.recoverT <= 0) {
      e.state = "stalk";
      e.stalkT = LURK.stalkTime * 0.55;
    }
  }

  if (d < LURK.radius + RADIUS + 0.2) shadeKills(e);
}

// The warden does not move: it holds the level above the floor. It only wakes
// for something on that level, winds up (the eye is the tell) and spits a glob.
// On the floor you can walk right under it and it will not care.
function stepWarden(e, dt) {
  const dx = pos.x - e.x;
  const dz = pos.z - e.z;
  const d = Math.hypot(dx, dz) || 1e-6;
  const ux = dx / d;
  const uz = dz / d;
  e.t += dt;
  e.hitT = Math.max(0, e.hitT - dt);
  e.recoilT = Math.max(0, e.recoilT - dt);

  const awake = craftLevel() === 1 && d < WARDEN.aggro;
  if (awake) {
    if (e.state !== "awake") {
      e.state = "awake";
      e.fireT = WARDEN.charge;
      gameAudio.sfx("wardenWake", { x: e.x, z: e.z });
      gameAudio.poke(0.35);
    }
    e.fireT -= dt;
    if (e.fireT <= 0) {
      e.fireT = (e.rate || WARDEN.rate) * (0.85 + decor() * 0.3);
      // it flies on the craft's level, so a glob is a thing that can reach you
      addBullet(eBullets, "glob", e.x + ux * 1.15, HOVER + LIFT.alt - 0.1, e.z + uz * 1.15,
        ux * WARDEN.shotSpeed, uz * WARDEN.shotSpeed, 3.2, WARDEN.dmg, 1,
        { knock: e.knock || WARDEN.knock });
      gameAudio.sfx("wardenShot", { x: e.x, z: e.z });
      e.recoilT = 0.22;
    }
  } else {
    if (e.state === "awake") e.state = "lurk";
    e.fireT = Math.max(e.fireT, WARDEN.charge * 0.6);
  }

  const charge = awake ? clamp01(1 - e.fireT / WARDEN.charge) : 0;
  const pulse = 0.5 + 0.5 * Math.sin(e.t * 2.2 + e.phase);
  e.warden.eyeMat.emissiveIntensity = 0.7 + charge * 5 + pulse * 0.4;
  e.warden.eye.scale.setScalar(0.85 + charge * 0.7 + (e.hitT > 0 ? 0.6 : 0));
  e.warden.lipMat.emissiveIntensity = 0.6 + charge * 3.4;
  e.warden.body.scale.setScalar(1 + charge * 0.1 + e.hitT * 1.2 - e.recoilT * 0.6);
  e.group.position.set(e.x, BLOCK_H + Math.sin(e.t * 1.6 + e.phase) * 0.04, e.z);
  e.group.rotation.y = Math.atan2(-dx, -dz);
  e.group.rotation.z = Math.sin(e.t * 1.1 + e.phase) * 0.05;

  // rooted, but solid: flying through one on its own level hurts
  if (awake && d < WARDEN.r + RADIUS + 0.1) hurtPlayer(TOUCH_DMG * 0.6);
}

/* ------------------------------------------------------- monster rifts */
// Spawn points: a standing ring of dark energy on the floor. It hums, then
// tears open and something crawls out. Shoot it and it comes apart for good.
const RIFT_TINT = 0x8f4bff;   // a healthy tear...
const RIFT_TINT_HURT = 0xff4b5e; // ...and one that has taken a beating

// blend two hex colours, for the tint of a tear as its hit points run down
function mixHex(a, b, k) {
  const t = Math.max(0, Math.min(1, k));
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  return (Math.round(ar + (br - ar) * t) << 16) |
    (Math.round(ag + (bg - ag) * t) << 8) |
    Math.round(ab + (bb - ab) * t);
}

const riftGroup = new THREE.Group();
scene.add(riftGroup);
const riftRingGeo = new THREE.TorusGeometry(1.75, 0.21, 8, 26);
const riftRing2Geo = new THREE.TorusGeometry(1.32, 0.1, 6, 20);
const riftDiscGeo = new THREE.RingGeometry(0, 2.3, 26);
const riftRingMat = new THREE.MeshBasicMaterial({ color: 0x8f4bff, transparent: true, opacity: 0.5, toneMapped: false });
const riftDiscMat = new THREE.MeshBasicMaterial({ color: 0x05020c, transparent: true, opacity: 0.72, depthWrite: false, side: THREE.DoubleSide });
const riftGlowMat = new THREE.SpriteMaterial({ map: sparkTex, color: 0x5a1fb0, transparent: true, opacity: 0.3, depthWrite: false });

let rifts = [];
let riftMotes = null;
let riftsOpened = 0;
let riftsClosed = 0;

function disposeMotes() {
  if (!riftMotes) return;
  scene.remove(riftMotes);
  riftMotes.geometry.dispose();
  riftMotes.material.dispose();
  riftMotes = null;
}

function disposeRift(rf) {
  riftGroup.remove(rf.ring, rf.ring2, rf.disc, rf.glow);
  rf.ring.material.dispose();
  rf.ring2.material.dispose();
  rf.disc.material.dispose();
  rf.glow.material.dispose();
}

function clearRifts() {
  for (const rf of rifts) disposeRift(rf);
  rifts = [];
  disposeMotes();
}

// each rift owns a share of one Points cloud, so the drift costs a single draw
function buildRiftMotes() {
  disposeMotes();
  if (!rifts.length) return;
  const per = 16;
  const n = rifts.length * per;
  const p = new Float32Array(n * 3);
  const c = new Float32Array(n * 3);
  const [cr, cg, cb] = hexRgb(0x9a5cff);
  const motes = [];
  for (let i = 0; i < n; i++) {
    const rf = rifts[Math.floor(i / per)];
    const m = { rf, a: decor() * 6.28, r: 0.35 + decor() * 1.15, y: decor() * 3.4, sp: 0.5 + decor() * 1.1 };
    motes.push(m);
    p[i * 3] = rf.x + Math.cos(m.a) * m.r;
    p[i * 3 + 1] = m.y;
    p[i * 3 + 2] = rf.z + Math.sin(m.a) * m.r;
    c[i * 3] = cr;
    c[i * 3 + 1] = cg;
    c[i * 3 + 2] = cb;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(p, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(c, 3));
  riftMotes = new THREE.Points(geo, new THREE.PointsMaterial({
    map: sparkTex, size: 0.34, sizeAttenuation: true, transparent: true, opacity: 0.8,
    blending: THREE.AdditiveBlending, depthWrite: false, vertexColors: true, toneMapped: false,
  }));
  riftMotes.userData = { motes, p, t: 0 };
  scene.add(riftMotes);
}

function makeRifts(count, rng, { intro = false, grace = 0 } = {}) {
  clearRifts();
  if (count <= 0) return;
  const span = Math.max(level.cols, level.rows) * CELL;
  const spacing = Math.min(32, span * 0.32);
  const spots = [];
  if (intro) {
    // One rift, standing between the craft and the exit, so it is the first thing
    // in front of you and the monsters come from where you are looking - not from
    // somewhere behind the start.
    const ex = level.cellToWorldX(level.exit.col);
    const ez = level.cellToWorldZ(level.exit.row);
    const dx = ex - pos.x;
    const dz = ez - pos.z;
    const d = Math.hypot(dx, dz) || 1;
    const tx = pos.x + (dx / d) * Math.min(18, d * 0.45);
    const tz = pos.z + (dz / d) * Math.min(18, d * 0.45);
    let best = null;
    let bestD = Infinity;
    for (const [c, r] of level.openCells) {
      const x = level.cellToWorldX(c);
      const z = level.cellToWorldZ(r);
      if (Math.hypot(x - pos.x, z - pos.z) < 9) continue; // room to see it first
      const dd = Math.hypot(x - tx, z - tz);
      if (dd < bestD) { bestD = dd; best = { x, z }; }
    }
    if (best) spots.push(best);
  } else {
    const pool = level.openCells.filter(([c, r]) =>
      Math.hypot(level.cellToWorldX(c) - pos.x, level.cellToWorldZ(r) - pos.z) > Math.min(30, span * 0.28));
    for (let i = 0; i < count * 16 && spots.length < count && pool.length; i++) {
      const [c, r] = pool.splice(Math.floor(rng() * pool.length), 1)[0];
      const x = level.cellToWorldX(c);
      const z = level.cellToWorldZ(r);
      if (spots.some((s) => Math.hypot(s.x - x, s.z - z) < spacing)) continue;
      spots.push({ x, z });
    }
  }
  for (const [i, s] of spots.entries()) {
    const ring = new THREE.Mesh(riftRingGeo, riftRingMat.clone());
    const ring2 = new THREE.Mesh(riftRing2Geo, riftRingMat.clone());
    const disc = new THREE.Mesh(riftDiscGeo, riftDiscMat.clone());
    const glow = new THREE.Sprite(riftGlowMat.clone());
    // its own tint, so a tear that has taken a beating can go red on its own
    ring.material.color = new THREE.Color(RIFT_TINT);
    ring2.material.color = new THREE.Color(RIFT_TINT);
    ring.position.set(s.x, 1.05, s.z);
    ring2.position.set(s.x, 1.05, s.z);
    ring2.rotation.y = Math.PI / 2;
    ring2.rotation.x = 0.5;
    ring2.material.opacity = 0.32;
    disc.rotation.x = -Math.PI / 2;
    disc.position.set(s.x, 0.05, s.z);
    glow.position.set(s.x, 1.0, s.z);
    glow.scale.setScalar(5.6);
    riftGroup.add(ring, ring2, disc, glow);
    const hp = RIFT.hp(GAME.level);
    rifts.push({
      x: s.x, z: s.z, ring, ring2, disc, glow,
      t: (grace || RIFT.grace(GAME.level)) + i * 1.7 + rng() * 4,
      warnT: 0, spin: rng() * 6.28,
      hp, maxHp: hp, hitT: 0, dying: false, fuseT: 0, dead: false,
    });
  }
  buildRiftMotes();
}

function riftInterval() {
  return Math.max(RIFT.min, RIFT.base - GAME.level * 0.35) * (0.7 + decor() * 0.6);
}

function openRift(rf) {
  rf.warnT = 0;
  rf.t = riftInterval();
  riftsOpened++;
  const power = GAME.level;
  const canSpit = allow("spitter", GAME.level);
  const type = canSpit && decor() < (power < 3 ? 0.12 : 0.4) ? "spitter" : "grunt";
  const e = spawnEnemy(type, rf.x, rf.z);
  e.fromRift = true;
  enemies.push(e);
  spawnBurst(rf.x, 1.1, rf.z, BOOM.rift());
  gameAudio.sfx("rift", { x: rf.x, z: rf.z });
  gameAudio.poke(0.35);
  const d = Math.hypot(pos.x - rf.x, pos.z - rf.z);
  if (d < 22) shake = Math.min(1.3, shake + 0.32 * (1 - d / 22));
}

function updateRiftMotes(dt) {
  if (!riftMotes) return;
  const { motes, p } = riftMotes.userData;
  riftMotes.userData.t += dt;
  const t = riftMotes.userData.t;
  for (let i = 0; i < motes.length; i++) {
    const m = motes[i];
    if (m.rf.dead) {
      // the tear is gone: park its share of the drift out of sight
      p[i * 3 + 1] = -80;
      continue;
    }
    m.y += m.sp * dt;
    if (m.y > 3.6) m.y = 0.02;
    const a = m.a + t * 0.45;
    p[i * 3] = m.rf.x + Math.cos(a) * m.r;
    p[i * 3 + 1] = m.y;
    p[i * 3 + 2] = m.rf.z + Math.sin(a) * m.r;
  }
  riftMotes.geometry.attributes.position.needsUpdate = true;
}

/* A bolt landing on a tear: it flinches, and enough of them and it starts to
   come apart. The collapse is not instant - the tear howls, flares and throws
   sparks for a couple of seconds, which is your warning to be somewhere else. */
function hurtRift(rf, dmg) {
  if (rf.dying) return;
  rf.hp -= dmg;
  rf.hitT = 0.14;
  spawnBurst(rf.x, 1.15, rf.z, BOOM.spark());
  gameAudio.sfx("hit", { x: rf.x, z: rf.z });
  if (rf.hp > 0) return;
  rf.hp = 0;
  rf.dying = true;
  rf.fuseT = RIFT.fuse;
  spawnBurst(rf.x, 1.1, rf.z, BOOM.rift());
  gameAudio.sfx("riftDie", { x: rf.x, z: rf.z });
  gameAudio.poke(0.6);
  shake = Math.min(1.4, shake + 0.35);
}

/* the end of it: it goes up, and takes whatever is standing in the blast with it */
function riftGone(rf) {
  const i = rifts.indexOf(rf);
  if (i >= 0) rifts.splice(i, 1);
  rf.dead = true;
  disposeRift(rf);
  riftsClosed++;
  spawnBurst(rf.x, 1.2, rf.z, BOOM.rift());
  spawnBurst(rf.x, 1.0, rf.z, BOOM.mine());
  spawnDebris(rf.x, 1.2, rf.z, {
    palette: "blast", count: 14, speed: 15, lift: 12, spread: 1.1, life: 10,
  });
  gameAudio.sfx("boom", { x: rf.x, z: rf.z });
  gameAudio.poke(0.8);
  // the things it was feeding on are the first to go
  for (const e of enemies) {
    if (e.dead || e.deck || e.type === "warden") continue; // up on the blocks, out of it
    const d = Math.hypot(e.x - rf.x, e.z - rf.z);
    if (d >= RIFT.blast) continue;
    if (d < RIFT.blast * 0.45) killEnemy(e, { credit: true });
    else {
      e.hp -= 6;
      e.hitT = 0.12;
    }
  }
  // and it costs you if you were standing in it
  const d = Math.hypot(pos.x - rf.x, pos.z - rf.z);
  if (d < RIFT.blast) {
    const k = 1 - d / RIFT.blast;
    hurtPlayer(RIFT.dmg * k);
    shake = Math.min(1.8, shake + 0.9 * k);
    hurtFlash = Math.min(1, hurtFlash + 0.3 * k);
  } else {
    shake = Math.min(1.6, shake + 0.4);
  }
  if (!rifts.length) disposeMotes(); // nothing left to drift around
}

function updateRifts(dt) {
  if (!rifts.length) {
    updateRiftMotes(dt);
    return;
  }
  const alive = monstersLeft();
  const cap = levelEnemies(GAME.level) + levelGuards(GAME.level) + RIFT.cap;
  const doomed = [];
  for (const rf of rifts) {
    rf.spin += dt;
    rf.hitT = Math.max(0, rf.hitT - dt);

    if (rf.dying) {
      // not a spawner any more: a hole coming apart, and it is loud about it
      rf.fuseT -= dt;
      const k = 1 - Math.max(0, rf.fuseT) / RIFT.fuse;
      const flick = 0.5 + 0.5 * Math.sin(rf.spin * (16 + k * 34));
      rf.ring.rotation.z = rf.spin * (3 + k * 8);
      rf.ring.rotation.x = Math.sin(rf.spin * 6) * 0.5;
      rf.ring.position.y = 1.05 + Math.sin(rf.spin * 9) * 0.3;
      rf.ring.scale.setScalar(1 + k * 0.9 + flick * 0.14);
      rf.ring.material.opacity = 0.45 + flick * 0.55;
      rf.ring2.rotation.z = -rf.spin * (4 + k * 10);
      rf.ring2.position.y = 1.05 + Math.cos(rf.spin * 11) * 0.4;
      rf.ring2.scale.setScalar(1 + k * 1.3 + flick * 0.2);
      rf.ring2.material.opacity = 0.3 + flick * 0.65;
      rf.disc.rotation.z = -rf.spin * (0.55 + k * 2);
      rf.disc.scale.setScalar(1 + k * 0.5);
      rf.disc.material.opacity = 0.72 + k * 0.24;
      rf.glow.material.opacity = 0.35 + k * 0.6;
      rf.glow.scale.setScalar(5.6 + k * 8 + flick * 2.4);
      if (decor() < dt * 24) spawnBurst(rf.x, 0.6 + decor() * 1.8, rf.z, BOOM.spark());
      if (rf.fuseT <= 0) doomed.push(rf);
      continue;
    }

    rf.ring.rotation.z = rf.spin * 1.3;
    rf.ring.rotation.x = Math.sin(rf.spin * 0.6) * 0.25;
    rf.ring.position.y = 1.05 + Math.sin(rf.spin * 1.7) * 0.1;
    rf.ring2.rotation.z = -rf.spin * 1.9;
    rf.ring2.position.y = 1.05 + Math.cos(rf.spin * 1.4) * 0.16;
    rf.disc.rotation.z = -rf.spin * 0.55;

    if (rf.warnT > 0) {
      rf.warnT -= dt;
      const k = 1 - Math.max(0, rf.warnT) / RIFT.warnTime;
      rf.ring.scale.setScalar(1 + k * 1.1);
      rf.ring.material.opacity = 0.5 + k * 0.5;
      rf.ring2.scale.setScalar(1 + k * 1.5);
      rf.ring2.material.opacity = 0.32 + k * 0.6;
      rf.disc.material.opacity = 0.72 + k * 0.2;
      rf.glow.material.opacity = 0.3 + k * 0.55;
      rf.glow.scale.setScalar(5.6 + k * 7);
      if (rf.warnT <= 0) openRift(rf);
      continue;
    }

    // a tear that has taken bolts reads as one: it goes red, dims and shudders
    const hurt = rf.maxHp ? 1 - rf.hp / rf.maxHp : 0;
    const shakeIt = hurt * 0.09 + rf.hitT * 0.5;
    rf.ring.material.color.setHex(mixHex(RIFT_TINT, RIFT_TINT_HURT, hurt));
    rf.ring2.material.color.setHex(mixHex(RIFT_TINT, RIFT_TINT_HURT, hurt));
    rf.ring.scale.setScalar(1 + rf.hitT * 1.8);
    rf.ring.material.opacity = 0.36 + 0.16 * Math.sin(rf.spin * 2.3) + hurt * 0.3;
    rf.ring2.scale.setScalar(1 + rf.hitT * 1.2);
    rf.ring2.material.opacity = 0.22 + 0.12 * Math.sin(rf.spin * 3.1) + hurt * 0.3;
    rf.disc.material.opacity = 0.66 - hurt * 0.18;
    rf.glow.material.opacity = 0.26 + 0.1 * Math.sin(rf.spin * 1.9) + hurt * 0.2;
    rf.glow.scale.setScalar(5.6 + Math.sin(rf.spin * 2.1) * 0.7 - hurt * 1.2);
    if (shakeIt > 0) {
      rf.ring.position.y += Math.sin(rf.spin * 40) * shakeIt * 0.4;
      rf.ring2.position.y += Math.cos(rf.spin * 47) * shakeIt * 0.4;
    }

    rf.t -= dt;
    if (rf.t > 0) continue;
    if (alive >= cap) {
      rf.t = 2.5; // holds the pressure where the level can still be fought
      continue;
    }
    if (Math.hypot(pos.x - rf.x, pos.z - rf.z) < RIFT.warn) rf.warnT = RIFT.warnTime;
    else openRift(rf);
  }
  for (const rf of doomed) riftGone(rf);
  updateRiftMotes(dt);
}

/* ------------------------------------------------------------------ input */
// A key is tracked by its physical code *and* by the character it produces, so
// the controls still work on layouts where the A key does not report KeyA
// (AZERTY, Dvorak, ...), and releasing a key always clears the same entries
// that pressing it added.
const keys = new Set();
let mouseDown = false;

function keyAliases(e) {
  const out = new Set();
  if (e.code) { out.add(e.code); out.add(e.code.toLowerCase()); }
  const k = e.key;
  if (typeof k === "string" && k.length) {
    out.add(k);
    if (k.length === 1) { out.add(k.toLowerCase()); out.add(k.toUpperCase()); }
  }
  return out;
}
const held = (...names) => names.some((n) => keys.has(n));

addEventListener("keydown", (e) => {
  const names = keyAliases(e);
  // the very first key press is the gesture the browser wants before it lets
  // anything make a sound
  gameAudio.unlock();
  if (names.has("KeyM") || names.has("m") || names.has("M")) {
    if (!e.repeat) toggleSound();
    return;
  }
  if (names.has("KeyF") || names.has("f") || names.has("F")) {
    if (!e.repeat) toggleFullscreen();
    return;
  }
  // the start screen: Enter carries on where you got to, N starts over
  if (state === "menu") {
    if (names.has("Enter") || names.has("NumpadEnter")) {
      if (!e.repeat) chooseStart(menuChoice);
    } else if (names.has("KeyN") || names.has("n") || names.has("N")) {
      if (!e.repeat) chooseStart(1);
    }
    return;
  }
  // and from the results card, Enter goes back to the start screen
  if (state === "dead" && (names.has("Enter") || names.has("NumpadEnter"))) {
    if (!e.repeat) showMenu();
    return;
  }
  if (names.has("KeyR") || names.has("r") || names.has("R")) {
    if (!e.repeat) restartGame();   // the same level, dead or not
    for (const n of names) keys.add(n);
    return;
  }
  if (names.has("Space") || names.has(" ") || names.has("ArrowLeft") || names.has("ArrowRight") ||
      names.has("ArrowUp") || names.has("ArrowDown")) e.preventDefault();
  for (const n of names) keys.add(n);
});
addEventListener("keyup", (e) => { for (const n of keyAliases(e)) keys.delete(n); });
addEventListener("blur", () => { keys.clear(); mouseDown = false; });
renderer.domElement.addEventListener("pointerdown", (e) => {
  mouseDown = true;
  gameAudio.unlock();
  if (e.cancelable) e.preventDefault();
});
addEventListener("pointerup", () => { mouseDown = false; });
addEventListener("pointercancel", () => { mouseDown = false; });

/* ------------------------------------------------------------------ state */
const el = {
  level: document.getElementById("lvl"),
  kills: document.getElementById("kills"),
  left: document.getElementById("left"),
  snd: document.getElementById("snd"),
  hp: document.getElementById("hpbar"),
  overlay: document.getElementById("overlay"),
  ovTitle: document.getElementById("ovtitle"),
  ovSub: document.getElementById("ovsub"),
  hurt: document.getElementById("hurt"),
  hunt: document.getElementById("hunt"),
  veil: document.getElementById("huntveil"),
  lift: document.getElementById("lift"),
  liftLab: document.getElementById("liftlab"),
  liftBar: document.getElementById("liftbar"),
  hint: document.getElementById("hint"),
  btnCont: document.getElementById("btncont"),
  btnNew: document.getElementById("btnnew"),
};

// the start screen is the one place the mouse is for anything but shooting
if (el.btnCont && el.btnCont.addEventListener) {
  el.btnCont.addEventListener("click", () => chooseStart(menuChoice));
}
if (el.btnNew && el.btnNew.addEventListener) {
  el.btnNew.addEventListener("click", () => chooseStart(1));
}

const GAME = { level: 1, kills: 0 };
let state = "playing"; // "menu" | "playing" | "cleared" | "dead"

/* --------------------------------------------------------------- progress */
// The highest level reached is kept in the browser, so a session can be picked
// up at the deepest level seen. The start screen is the only place that reads
// it; every level start writes it.
const saveStore = pickStore(globalThis);
let SAVE = blank();
let menuChoice = 1; // what Enter does on the start screen
let hp = PLAYER_HP;
let hurtT = 0;
let hurtFlash = 0;
let shake = 0;
let fireT = 0;
let clearedT = 0;
let muzzleT = 0;
let elapsed = 0;
let hunted = false;
let huntT = 0;
let huntVeil = 0;

// the level above the floor: the block tops
let lift = 0;          // 0 = on the floor, 1 = up on the block level (smoothed)
let liftUp = false;    // is the craft trying to be up there
let charge = LIFT.time; // the hover meter, in seconds
let liftWarned = 0;    // which warning has fired
let liftHudState = ""; // "off" | "near" | "hover" | "block"
let liftDenyT = 0;     // HUD flash when the guns are asked for mid-hover
let shoveX = 0;        // a glob hit throwing the craft, in units/second
let shoveZ = 0;
let pads = [];
let wallTop = new Map();
let towerness = 0.35;  // this level's character: open, or a thicket of towers
let falling = 0;       // seconds into a fall out of the world (0 = not falling)

// Is the craft high enough that the floor cannot touch it?
const airborne = () => lift >= LIFT.safe;

// Which of the two levels the craft is on. Shots, globs and touches all carry a
// level, and only things on the same level can reach each other.
const craftLevel = () => (lift >= LIFT.fly ? 1 : 0);

// Is there a hole in the floor under the craft? Then there is no ground at all:
// the craft holds itself up on the meter exactly as it does one level higher, and
// when the meter is gone it falls. Over ordinary floor there is always ground.
const overHole = () => level.holeAt(pos.x, pos.z);

// How high under the craft has to be clear for it to pass: everything lower than
// the hull is flown over, everything taller still blocks. At floor level nothing
// is clear, so the maze is exactly what it was.
const belly = () => HOVER + lift * LIFT.alt - 0.85;
function overWalls(c, r) {
  // on the floor nothing is clear: holes included
  if (lift < LIFT.fly) return false;
  const h = wallTop.get(`${c},${r}`);
  return h !== undefined && h < belly();
}

// The same for something that is flying on the level above (a shot up there):
// low blocks are underneath it, walls and towers are not.
const UPPER_CLEAR = HOVER + LIFT.alt - 0.85;
function overLowWalls(c, r) {
  const h = wallTop.get(`${c},${r}`);
  return h !== undefined && h < UPPER_CLEAR;
}

// What the hull runs into right now. On the floor that is rock; one level up it is
// rock plus the roofs over the tunnels, because the level above does not get to
// fly through a corridor that has a ceiling on it. (The low blocks are in `walls`
// too, but the skip predicate takes them away one level up.)
const craftSolids = () => (lift >= LIFT.fly ? level.upperSolids : level.walls);

// Ground at the level the craft is at: a block top under it, not the floor far
// below, and not the roof over a tunnel either. This is what decides between
// "standing on the level" and "hovering".
function onBlockLevel() {
  const h = wallTopAt(pos.x, pos.z);
  return h >= BLOCK_H * 0.8 && h <= BLOCK_H * 1.2;
}

const pos = new THREE.Vector3();
let yaw = 0;
let bank = 0;
let bobT = 0;

function monstersLeft() {
  let n = 0;
  for (const e of enemies) if (!e.dead) n++;
  return n;
}

function clearEntities() {
  for (const e of enemies) enemyGroup.remove(e.group);
  enemies = [];
  for (const b of bullets) bulletGroup.remove(b.mesh);
  for (const b of eBullets) bulletGroup.remove(b.mesh);
  bullets = [];
  eBullets = [];
}

function showOverlay(title, sub) {
  el.ovTitle.textContent = title;
  el.ovSub.textContent = sub;
  el.overlay.classList.add("show");
}
function hideOverlay() {
  el.overlay.classList.remove("show");
  el.overlay.classList.remove("menu");
}

/* ------------------------------------------------------------- start screen */
// The first thing on screen: what the last run left behind, and two ways in -
// carry on at the deepest level reached, or start again from the top.
function showMenu() {
  state = "menu";
  SAVE = readSave(saveStore);
  const best = SAVE.best;
  el.ovTitle.textContent = "UFO ARENA";
  el.ovSub.innerHTML = best > 1
    ? `Best level reached: <b>${best}</b> · ${SAVE.kills} kills · kept in this browser`
    : "Dark maze, one saucer, a way out.";
  el.btnCont.innerHTML = best > 1
    ? `Continue &middot; level <b>${best}</b>`
    : "Start &middot; level <b>1</b>";
  el.btnNew.style.display = best > 1 ? "" : "none";
  menuChoice = best > 1 ? best : 1;
  el.overlay.classList.add("show", "menu");
  resetTip(); // the controls line, not the arrival line of whatever level is behind it
}

// picking a level from the menu: a run starts with a clean score, and the level
// start writes the save
function chooseStart(n) {
  hideOverlay();
  GAME.kills = 0;
  startLevel(Math.max(1, Math.floor(n) || 1));
}

/* fullscreen: F, so the whole screen is the level. Nothing else changes - the
   HUD and the hint are sized off the viewport anyway, and the resize handler that
   is already there keeps the canvas in step. */
function toggleFullscreen() {
  const doc = document;
  const root = doc && doc.documentElement;
  if (!root) return;
  if (doc.fullscreenElement) {
    if (doc.exitFullscreen) doc.exitFullscreen();
    return;
  }
  if (typeof root.requestFullscreen === "function") {
    const p = root.requestFullscreen();
    if (p && typeof p.catch === "function") p.catch(() => {});
  }
}

/* sound: one key, and the setting sticks. The HUD says which way it is. */
function updateSoundHud() {
  const off = gameAudio.muted;
  el.snd.textContent = off ? "sound off" : "sound on";
  if (off) el.snd.classList.add("off");
  else el.snd.classList.remove("off");
}
function toggleSound() {
  gameAudio.toggleMute();
  updateSoundHud();
}

function startLevel(n, { record = true } = {}) {
  GAME.level = n;
  // the level's place and look, before a single thing is built out of it
  place = levelPlace(n);
  palette = levelPalette(n);
  themeMap = palette.themes;
  applyPalette();
  // the level you are on is the level you have reached: the save only ever goes
  // up, so this cannot lose a deeper level than the one being played
  if (record) SAVE = writeSave(saveStore, reachLevel(SAVE, n, GAME.kills));
  decor = makeRng(777 + n);
  const size = levelSize(n);
  towerness = levelTowerness(n);
  level = createLevel({
    cols: size, rows: size, seed: 1000 + n,
    liftCount: levelLifts(n), upper: allow("upper", n),
    rooms: n <= 2 ? 2 : n === 3 ? 4 : 99,
    startPad: n === UNLOCK.upper || isVoid(n),
    startDeck: n === UNLOCK.upper || isVoid(n),
    tower: towerness,
    // a place, if this level is one: the void level is the level above with the
    // floor taken away, a warren is all small cells, a roofed level is all tunnels
    voidFloor: place === "void",
    warren: place === "warren",
    roofed: place === "tunnels",
  });
  buildWorld(level);
  clearEntities();
  clearExplosions();
  clearDebris();
  clearRifts();
  ufo.visible = true;

  pos.set(level.cellToWorldX(level.start.col), HOVER, level.cellToWorldZ(level.start.row));
  lift = 0;
  liftUp = false;
  falling = 0;
  shoveX = 0;
  shoveZ = 0;
  charge = LIFT.time;
  liftWarned = 0;
  liftDenyT = 0;
  liftHudState = "";
  el.lift.classList.remove("on");
  el.lift.classList.remove("warn");
  el.lift.classList.remove("near");
  el.lift.classList.remove("block");
  el.lift.classList.remove("charging");
  el.lift.classList.remove("deny");
  el.liftBar.style.width = "100%";
  yaw = 0;
  // the two teaching levels (and the one that introduces the spawner) start
  // pointing the way out, so the level opens in front of the craft instead of
  // behind it
  if (n <= 2 || n === UNLOCK.rift) {
    const ex0 = level.cellToWorldX(level.exit.col);
    const ez0 = level.cellToWorldZ(level.exit.row);
    yaw = Math.atan2(ex0 - pos.x, -(ez0 - pos.z));
  }
  bank = 0;
  bobT = 0;
  hp = PLAYER_HP;
  hurtT = 0;
  hurtFlash = 0;
  huntVeil = 0;
  hunted = false;
  el.hunt.style.display = "none";
  el.veil.style.opacity = "0";
  shake = 0;
  fireT = 0;
  muzzleT = 0;
  elapsed = 0;
  state = "playing";
  clearedT = 0;
  camPos.set(pos.x, CAM_HEIGHT, pos.z + CAM_DIST);
  updateUfo(0, 0, 0);
  updateCamera(1);

  const rng = makeRng(5000 + n);
  const near = (c, r, cx, cz) => Math.hypot(level.cellToWorldX(c) - cx, level.cellToWorldZ(r) - cz);
  // the first levels are small on purpose, so every "far enough away" radius has
  // to shrink with the map or nothing would ever spawn
  const span = Math.max(level.cols, level.rows) * CELL;
  const awayR = Math.min(34, span * 0.34);

  /* roamers, spread over the level and well away from the start pad. Before the
     spitters are introduced every hunter is a red diamond, so level 1 is mines
     and nothing else. */
  const canSpit = allow("spitter", n);
  // a two-room level has nowhere that is 34 units from the start, so the ring
  // closes in rather than leaving the level empty
  let spawns = level.openCells.filter(([c, r]) => near(c, r, pos.x, pos.z) > awayR);
  for (const r0 of [Math.min(awayR, 16), 10]) {
    if (spawns.length >= levelEnemies(n)) break;
    spawns = level.openCells.filter(([c, r]) => near(c, r, pos.x, pos.z) > r0);
  }
  // the arena: every hunter is put in the biggest hall there is, and nowhere else.
  // Walking round it is a real choice, and so is not going in at all.
  const inRoom = (room, c, r) =>
    c >= room.x && c < room.x + room.w && r >= room.y && r < room.y + room.h;
  const arena = place === "arena"
    ? level.rooms.slice(1).reduce((best, r) => (!best || r.w * r.h > best.w * best.h ? r : best), null)
    : null;
  if (arena) spawns = level.openCells.filter(([c, r]) => inRoom(arena, c, r));
  for (let i = 0; i < levelEnemies(n) && spawns.length; i++) {
    const [c, r] = spawns.splice(Math.floor(rng() * spawns.length), 1)[0];
    const type = canSpit && rng() < 0.38 ? "spitter" : "grunt";
    enemies.push(spawnEnemy(type, level.cellToWorldX(c), level.cellToWorldZ(r)));
  }

  /* defenders ringing the exit, so the run cannot simply be walked to the end */
  const ex = level.cellToWorldX(level.exit.col);
  const ez = level.cellToWorldZ(level.exit.row);
  const ringCells = level.openCells.filter(([c, r]) => {
    const d = near(c, r, ex, ez);
    return d > CELL * 1.1 && d < 26;
  });
  for (let i = 0; i < levelGuards(n) && ringCells.length; i++) {
    const [c, r] = ringCells.splice(Math.floor(rng() * ringCells.length), 1)[0];
    const type = canSpit && rng() < 0.4 ? "spitter" : "grunt";
    enemies.push(spawnEnemy(type, level.cellToWorldX(c), level.cellToWorldZ(r), { guard: true }));
  }

  /* shades: waiting in the rooms, well away from the start pad and the exit.
     Only from the level that introduces them on. */
  const roomCells = [];
  const shadeAway = Math.min(38, span * 0.4);
  const shadeExit = Math.min(20, span * 0.2);
  for (let i = 1; i < level.rooms.length; i++) {
    const room = level.rooms[i];
    for (let r = room.y; r < room.y + room.h; r++) {
      for (let c = room.x; c < room.x + room.w; c++) {
        const key = `${c},${r}`;
        if (level.walls.has(key) || level.pits.has(key)) continue; // not inside rock, a block or a hole
        if (near(c, r, pos.x, pos.z) < shadeAway) continue;
        if (near(c, r, ex, ez) < shadeExit) continue;
        roomCells.push([c, r]);
      }
    }
  }
  // ...and in the arena the shades are in that hall too
  const shadeCells = arena ? roomCells.filter(([c, r]) => inRoom(arena, c, r)) : roomCells;
  for (let i = 0; i < levelLurkers(n) && shadeCells.length; i++) {
    const [c, r] = shadeCells.splice(Math.floor(rng() * shadeCells.length), 1)[0];
    enemies.push(spawnShade(level.cellToWorldX(c), level.cellToWorldZ(r)));
  }

  /* the garrison of the level above: wardens rooted on the raised runs, and
     spitters standing on the block tops, both of which only reach that level.
     This is what makes the second level a fight rather than a shortcut. */
  {
    const spots = [];
    // on the void level there is no floor to be "away" from: the road starts in
    // the room you are standing in, and the wardens are posted along it and on the
    // islands round it, closer together, so the crossing is a gauntlet
    const wardMin = isVoid(n) ? 10 : Math.min(22, span * 0.24);
    const wardGap = isVoid(n) ? 13 : 18;
    for (const key of level.upper) {
      const [c, r] = key.split(",").map(Number);
      if (near(c, r, pos.x, pos.z) < wardMin) continue;
      if (spots.some((w) => Math.hypot(w.x - level.cellToWorldX(c), w.z - level.cellToWorldZ(r)) < wardGap)) continue;
      spots.push({ x: level.cellToWorldX(c), z: level.cellToWorldZ(r) });
    }
    const take = () => spots.splice(Math.floor(rng() * spots.length), 1)[0];
    for (let i = 0; i < levelWardens(n) && spots.length; i++) {
      const spot = take();
      enemies.push(spawnEnemy("warden", spot.x, spot.z));
    }
    for (let i = 0; i < levelDeckers(n) && spots.length; i++) {
      const spot = take();
      enemies.push(spawnEnemy("spitter", spot.x, spot.z, { deck: true }));
    }
  }

  /* rifts: standing spawn points that keep the pressure up. The level that
     introduces them puts four of them round the starting room, so what a spawner
     is and where the monsters come from is not something to work out. */
  if (n === UNLOCK.rift) makeRifts(1, rng, { intro: true, grace: 4 });
  else makeRifts(levelRifts(n), rng);

  hideOverlay();
  updateHud();
  updateSoundHud();
  // the score is composed per level: new key, new tempo, more going on
  gameAudio.music({ level: n, state: "playing" });
  gameAudio.poke(0.45);            // a phrase on arrival, then it waits for you
  if (n > 1) gameAudio.sfx("levelUp");
  // and one line about whatever has just been introduced - or about the place this
  // level is - then the controls again
  if (ARRIVALS[n]) showTip(ARRIVALS[n]);
  else if (placeOf() && placeOf().tip) showTip(placeOf().tip);
  else resetTip();
}

/* ----------------------------------------------------------- the arrival */
// Each new mechanic gets a level of its own, and the line at the bottom of the
// screen says what it is for the first few seconds of it, before going back to
// the controls. After the last introduction the levels are just combinations.
const CONTROLS_HINT = el.hint.innerHTML;
const ARRIVALS = {
  1: "RED DIAMONDS: they follow you, latch on and blow. Keep your distance.",
  2: "NEW - SPITTERS: watch the chamber light up, then be somewhere else.",
  3: "NEW - SHADES: they wake when you get close, and they do not miss. Get out of reach.",
  4: "NEW - LIFT PADS: one level up. Up there the blocks are a road, and the holes cost hover.",
  5: "NEW - SPAWNERS: those rings keep making monsters. Shoot one down to close it for good.",
  6: "NEW - WARDENS: the floor is gone. Cross on the blocks, and shoot their globs out of the air.",
};
let tipT = 0;
function showTip(html, secs = 8) {
  el.hint.innerHTML = html;
  tipT = secs;
}
function resetTip() {
  tipT = 0;
  el.hint.innerHTML = CONTROLS_HINT;
}
function updateTip(dt) {
  if (tipT <= 0) return;
  tipT -= dt;
  if (tipT <= 0) resetTip();
}

// Dying puts you back at the start of the level you were on, not the whole run:
// the ladder is the thing to get through, and being sent back to level 1 would
// make every death a slog. The kill count is a running score and carries over.
function restartGame() {
  startLevel(GAME.level);
}

function killPlayer({ blast = true } = {}) {
  if (state !== "playing") return;
  hp = 0;
  state = "dead";
  gameAudio.sfx("death");
  gameAudio.music({ state: "dead" });
  if (blast) {
    blowUpPlayer();
    // and it comes apart: hull plates, glowing coolant, embers
    spawnDebris(pos.x, HOVER, pos.z, {
      palette: "player", count: 24, speed: 18, lift: 13, spread: 1.2, life: 13,
    });
    shake = 1.7;
    hurtFlash = 1;
  } else {
    // went down a hole: there is nothing left to blow up, it is just gone
    shake = 0.5;
    ufo.visible = false;
  }
  // let the wreck burn for a beat before the results card covers it
  later(1.5, () => {
    if (state !== "dead") return;
    showOverlay("GAME OVER",
      `Reached level ${GAME.level} · ${GAME.kills} kills · R restarts level ${GAME.level} · Enter for the start screen`);
  });
}

// The meter ran out with a hole underneath: there is no ground to come down onto,
// so the craft drops out of the world. It falls for a moment - long enough to see
// it go - and then the run is over. This is the same rule as the level above: no
// ground under the hull, no hover left, down you go. Only this time nothing catches
// you at the bottom.
const FALL_OUT = 1.15;
function fallOutOfWorld() {
  if (falling > 0 || state !== "playing") return;
  falling = 0.0001;
  charge = 0;
  liftUp = false;
  lift = 0;
  liftWarned = 2;
  gameAudio.sfx("voidFall", { x: pos.x, z: pos.z });
  gameAudio.poke(0.9);
  shake = Math.min(1.5, shake + 0.5);
}

// `pierce` ignores the invulnerability window: a blast always lands, so being
// caught next to a mine is never a free walk-away.
function hurtPlayer(dmg, { pierce = false } = {}) {
  if (state !== "playing" || (hurtT > 0 && !pierce)) return;
  hp -= dmg;
  hurtT = HURT_COOLDOWN;
  hurtFlash = Math.min(1, hurtFlash + 0.5 + dmg * 0.02);
  shake = Math.min(1.2, shake + 0.16);
  gameAudio.sfx("hurt");
  gameAudio.poke(0.45);
  if (hp <= 0) killPlayer();
}

function killEnemy(e, { credit = true, quiet = false } = {}) {
  if (e.dead) return;
  e.dead = true;
  enemyGroup.remove(e.group);
  if (credit) GAME.kills++;
  gameAudio.poke(0.35);
  if (!quiet) {
    const ey = e.group.position.y || 1.1; // a decker comes apart up on the blocks
    gameAudio.sfx(e.type === "lurker" ? "killShade" : "kill", { x: e.x, z: e.z });
    if (e.type === "lurker") {
      spawnBurst(e.x, 1.2, e.z, BOOM.shade());
      spawnDebris(e.x, 1.2, e.z, { palette: "shade", count: 16, speed: 15, lift: 11, spread: 1, life: 11 });
    } else if (e.type === "grunt") {
      spawnBurst(e.x, 1.1, e.z, BOOM.enemy(e.type));
      spawnDebris(e.x, 1.1, e.z, { palette: "blast", count: 10, speed: 13, lift: 10, spread: 0.8, life: 9 });
    } else {
      spawnBurst(e.x, ey, e.z, BOOM.enemy(e.type));
      spawnDebris(e.x, ey, e.z, { palette: "spitter", count: 8, speed: 12, lift: 9, spread: 0.7, life: 8 });
    }
  }
  const d = Math.hypot(pos.x - e.x, pos.z - e.z);
  if (d < 14) shake = Math.min(1.2, shake + 0.22 * (1 - d / 14));
}

/* ------------------------------------------------------------ mine logic */
// Point blank is instant death; from there the price falls off to nothing at
// blastR, so backing away is always worth it and standing still never is.
function blastDamage(d) {
  if (d >= MINE.blastR) return 0;
  if (d <= MINE.killR) return PLAYER_HP;
  const k = (d - MINE.killR) / (MINE.blastR - MINE.killR);
  return Math.round(MINE.dmg * (1 - k));
}

// It has reached you. Now it latches on, swells, blinks faster and paints its
// kill zone on the floor: 1.4 seconds to decide what you are worth.
function armMine(e) {
  if (e.armed || e.dead) return;
  e.armed = true;
  e.fuse = MINE.fuse;
  e.beepT = 0.32;              // the first beep lands just after the chirp
  e.mine.ring.visible = true;
  e.mine.dome.visible = true;
  spawnBurst(e.x, 1.0, e.z, BOOM.arm());
  shake = Math.min(1.4, shake + 0.35);
  gameAudio.sfx("mineArm", { x: e.x, z: e.z });
  gameAudio.poke(0.5);
}

function detonateMine(e, { credit = false } = {}) {
  if (e.dead) return;
  e.armed = false;
  const d = Math.hypot(pos.x - e.x, pos.z - e.z);
  killEnemy(e, { credit, quiet: true });
  spawnBurst(e.x, 1.0, e.z, BOOM.mine());
  spawnDebris(e.x, 1.0, e.z, { palette: "blast", count: 20, speed: 20, lift: 14, spread: 1.2, life: 13 });
  gameAudio.sfx("boom", { x: e.x, z: e.z });
  gameAudio.poke(0.75);
  const dmg = airborne() ? 0 : blastDamage(d); // a floor blast does not reach the level above
  if (dmg > 0) {
    hurtFlash = Math.min(1, hurtFlash + 0.3);
    hurtPlayer(dmg, { pierce: true });
  }
  shake = Math.min(1.6, shake + 1.1 * Math.max(0, 1 - d / 26));
}

function stepMine(e, dt) {
  const dx = pos.x - e.x;
  const dz = pos.z - e.z;
  const d = Math.hypot(dx, dz) || 1e-6;
  const ux = dx / d;
  const uz = dz / d;
  e.t += dt;
  e.hitT = Math.max(0, e.hitT - dt);
  e.wanderT += dt;

  // right over the middle of it: no fuse, no driving through. Up on the deck
  // you are not on top of it at all.
  if (!airborne() && d < MINE.tripR) {
    detonateMine(e);
    return;
  }

  if (e.armed) {
    // planted, swelling, blinking: the fuse is the whole point
    e.fuse -= dt;
    const k = 1 - Math.max(0, e.fuse) / MINE.fuse;
    // and the fuse counts down out loud: the beeps quicken and climb
    e.beepT -= dt;
    if (e.beepT <= 0) {
      e.beepT = 0.55 - k * 0.42;
      gameAudio.sfx("mineBeep", { x: e.x, z: e.z, pitch: k });
    }
    const blink = 0.5 + 0.5 * Math.sin(e.t * (13 + k * 46));
    const swell = 1 + k * 0.5 + blink * 0.05;
    e.mine.hull.scale.setScalar(swell);
    placeMineHorns(e.mine.horns, 1 + k * 0.7);
    e.mine.lampMat.emissiveIntensity = 1.2 + blink * 3.4 + k * 2;
    e.mine.lamp.scale.setScalar(0.85 + blink * 0.5 + k * 0.3);
    e.mine.ringMat.opacity = 0.3 + blink * 0.45;
    e.mine.domeMat.opacity = 0.04 + blink * 0.05 + k * 0.06;
    const grow = 0.28 + k * 0.72;
    e.mine.ring.scale.setScalar(MINE.blastR * grow);
    e.mine.dome.scale.setScalar(MINE.blastR * grow);
    // it bobs where it stopped, so the kill zone stays readable on the floor
    e.group.position.set(e.x, 1.0 + Math.sin(e.t * 3.2) * 0.06, e.z);
    e.group.rotation.y += dt * 1.6;
    e.mine.ring.position.y = 0.03 - e.group.position.y;
    e.mine.dome.position.y = 0.05 - e.group.position.y;
    if (e.fuse <= 0) detonateMine(e);
    return;
  }

  const blink = 0.5 + 0.5 * Math.sin(e.t * 3.2 + e.phase);
  e.mine.hull.scale.setScalar(1 + blink * 0.05 + e.hitT * 1.4);
  e.mine.lampMat.emissiveIntensity = 0.5 + blink * 1.6;
  e.mine.lamp.scale.setScalar(0.8 + blink * 0.3);
  e.group.position.set(e.x, 1.1 + Math.sin(bobT * 2.5 + e.x * 0.5) * 0.16, e.z);
  e.group.rotation.y = Math.atan2(-dx, -dz);

  if (d < e.aggro) {
    const r = level.walk(e.x, e.z, ux * e.speed * dt, uz * e.speed * dt, ENEMY_R);
    e.x = r.x;
    e.z = r.z;
  } else {
    idleStep(e, dt);
  }
  if (!airborne() && d < (e.r || ENEMY_R) + RADIUS + 0.2) armMine(e);
}

function tryFire() {
  if (state !== "playing" || falling) return;
  if (lift > 0.02 && lift < LIFT.fly) {
    // mid-ride the lift field holds the guns: say so on the HUD, do not eat the key
    el.lift.classList.add("deny");
    liftDenyT = 0.28;
    return;
  }
  if (fireT > 0) return;
  fireT = FIRE_COOLDOWN;
  const fx = Math.sin(yaw);
  const fz = -Math.cos(yaw);
  const level = craftLevel();
  addBullet(bullets, "bolt", pos.x + fx * NOSE, HOVER + level * LIFT.alt, pos.z + fz * NOSE,
    fx * BULLET_SPEED, fz * BULLET_SPEED, BULLET_LIFE, 1, level);
  ufoMuzzle.visible = true;
  muzzleT = 0.06;
  gameAudio.sfx("shoot");
  gameAudio.poke(0.14);
}

/* ------------------------------------------------------------- the lift */
// Pads take the craft up one level onto the block tops. Up there the floor is
// out of reach: where a block is underneath it is supported and the meter fills,
// where there is only open floor below it is hovering and the meter runs. Empty
// meter, back down to the floor, where it fills again.
//
// A hole in the floor is the same situation one level down: there is no ground
// under the craft, so it holds itself up on the same meter. Run it dry over a
// hole and there is nothing to come down onto, and down it goes - out of the
// world. That is the whole rule, one level up or on the floor: ground, or hover.
function updateLift(dt) {
  let near = false;
  const charged = charge >= LIFT.minCharge;
  const holeUnder = overHole();
  const craftCell = level.cellOf(pos.x, pos.z);
  for (const p of pads) {
    p.t += dt;
    // A used pad re-arms as soon as the craft is off its cell again. Measured by
    // cell rather than by distance, so a pad in a courtyard - where you cannot get
    // far from it - re-arms by driving one cell aside, and can never strand you.
    const onPad = craftCell.col === p.col && craftCell.row === p.row;
    if (p.used && lift <= 0.001 && !onPad) p.used = false;
    const ready = !p.used && charged;
    const pulse = 0.5 + 0.5 * Math.sin(p.t * 2.6);
    p.ring.rotation.z = p.t * (ready ? 0.7 : 0.14);
    p.ringMat.opacity = ready ? 0.42 + pulse * 0.28 : 0.09;
    p.discMat.opacity = ready ? 0.1 + pulse * 0.07 : 0.03;
    p.colMat.opacity = ready ? 0.05 + pulse * 0.04 : 0.012;
    p.capMat.opacity = ready ? 0.26 + pulse * 0.3 : 0.05;
    p.arrow.visible = ready;
    p.arrow.position.y = 1.15 + Math.sin(p.t * 2.2) * 0.12;
    p.arrow.rotation.y = p.t * 1.3;
    if (!p.used && lift <= 0.001 && Math.hypot(pos.x - p.x, pos.z - p.z) < 9) near = true;
  }

  // a charged pad under the craft takes it up exactly one level
  if (state === "playing" && !falling && lift <= 0.001) {
    for (const p of pads) {
      if (p.used || !charged) continue;
      if (Math.hypot(pos.x - p.x, pos.z - p.z) > (p.r ?? LIFT.padR)) continue;
      p.used = true;
      liftUp = true;
      liftWarned = 0;
      gameAudio.sfx("liftUp", { x: p.x, z: p.z });
      gameAudio.poke(0.5);
      spawnBurst(p.x, 0.25, p.z, BOOM.lift());
      shake = Math.min(1.1, shake + 0.2);
      break;
    }
  }

  const held = lift > 0.5 && onBlockLevel(); // a block top under the craft

  if (falling) {
    // nothing left to hold it: the craft is already going down and out
    charge = 0;
  } else if (liftUp) {
    if (lift < 1) {
      const wasBelow = lift < LIFT.fly;
      lift = Math.min(1, lift + dt / LIFT.rise);
      // the moment the hull is high enough for the level above, whatever is up
      // there (a roof over a tunnel) pushes it aside instead of swallowing it
      if (wasBelow && lift >= LIFT.fly) {
        const r = level.resolve(pos.x, pos.z, RADIUS, overWalls, level.upperSolids);
        pos.x = r.x;
        pos.z = r.z;
      }
    } else if (held) {
      // standing on the level: no cost, and it fills back up
      charge = Math.min(LIFT.time, charge + dt * LIFT.regen);
      liftWarned = 0;
    } else {
      // no ground underneath: this is the hover, and it costs
      charge -= dt * LIFT.drain;
      if (liftWarned === 0 && charge <= LIFT.warn) {
        liftWarned = 1;
        gameAudio.sfx("liftWarn");
      } else if (liftWarned === 1 && charge <= LIFT.warn * 0.4) {
        liftWarned = 2;
        gameAudio.sfx("liftWarn", { pitch: 1 });
      }
      if (charge <= 0) {
        charge = 0;
        liftUp = false;
        gameAudio.sfx("liftFall");
      }
    }
  } else if (lift > 0) {
    const was = lift;
    lift = Math.max(0, lift - dt / LIFT.fall);
    // coming down: whatever is still too tall for the hull pushes it aside
    if (lift < LIFT.fly) {
      const r = level.resolve(pos.x, pos.z, RADIUS, overWalls, craftSolids());
      pos.x = r.x;
      pos.z = r.z;
    }
    if (was > 0 && lift === 0) {
      spawnBurst(pos.x, 0.2, pos.z, BOOM.land());
      shake = Math.min(1.2, shake + 0.32);
      gameAudio.sfx("liftLand", { x: pos.x, z: pos.z });
    }
  } else if (state === "playing" && holeUnder) {
    // on the floor over a hole: no ground, so the same meter holds it up
    charge -= dt * LIFT.drain;
    if (liftWarned === 0 && charge <= LIFT.warn) {
      liftWarned = 1;
      gameAudio.sfx("liftWarn");
    } else if (liftWarned === 1 && charge <= LIFT.warn * 0.4) {
      liftWarned = 2;
      gameAudio.sfx("liftWarn", { pitch: 1 });
    }
    if (charge <= 0) fallOutOfWorld();
  }

  // on solid floor the meter fills up again
  if (!falling && !liftUp && lift <= 0.001 && !holeUnder) {
    charge = Math.min(LIFT.time, charge + dt * LIFT.regen);
  }

  if (liftDenyT > 0) {
    liftDenyT -= dt;
    if (liftDenyT <= 0) el.lift.classList.remove("deny");
  }

  // the HUD row: a sign by a charged pad, the meter while you are up (or over a
  // hole, where the same meter is the thing keeping you up)
  const hovering = lift > 0.001 || liftUp;
  const key = hovering
    ? (held ? "block" : "hover")
    : holeUnder && state === "playing" ? "hover"
    : near ? (charged ? "near" : "charging") : "off";
  if (key !== liftHudState) {
    liftHudState = key;
    for (const c of ["on", "near", "block", "charging", "warn"]) el.lift.classList.remove(c);
    if (key !== "off") el.lift.classList.add("on");
    if (key === "near") el.lift.classList.add("near");
    if (key === "block") el.lift.classList.add("block");
    if (key === "charging") el.lift.classList.add("charging");
  }
  if (key === "hover" || key === "block") {
    const left = Math.max(0, charge);
    el.liftLab.textContent = key === "block" ? "BLOCK LEVEL" : `HOVER ${left.toFixed(1)}s`;
    el.liftBar.style.width = `${Math.min(100, (left / LIFT.time) * 100).toFixed(1)}%`;
    if (key === "hover" && left <= LIFT.warn) el.lift.classList.add("warn");
    else el.lift.classList.remove("warn");
  } else if (key === "near") {
    el.liftLab.textContent = "LIFT READY";
    el.liftBar.style.width = "100%";
  } else if (key === "charging") {
    el.liftLab.textContent = "LIFT CHARGING";
    el.liftBar.style.width = `${Math.min(100, (charge / LIFT.time) * 100).toFixed(0)}%`;
  } else {
    el.liftLab.textContent = "HOVER";
    el.liftBar.style.width = "100%";
  }
}

/* ------------------------------------------------------------------- step */
function updateUfo(dt, thrust, turn) {
  bobT += dt;
  ufoSpinner.rotation.y += dt * 2.4;
  ufoRing.rotation.z -= dt * 1.7;
  ufoBeacon.visible = Math.sin(bobT * 5) > -0.3;
  const pulse = 0.5 + 0.5 * Math.sin(bobT * 4);
  ufoBand.material.emissiveIntensity = 1.8 + pulse * 1.4;
  ufoDomeMat.emissiveIntensity = 0.8 + pulse * 0.9;

  if (muzzleT > 0) {
    muzzleT -= dt;
    if (muzzleT <= 0) ufoMuzzle.visible = false;
  }

  const k = 1 - Math.exp(-10 * dt);
  bank += (-turn * MAX_BANK - bank) * k;

  const alt = lift * LIFT.alt;
  const bob = Math.sin(bobT * 3) * (0.07 + lift * 0.11);
  const rigY = HOVER + alt + bob;
  // a fall out of the world: the craft drops away, tumbling, until the run ends
  let drop = 0;
  let spin = 0;
  if (falling > 0) {
    falling += dt;
    drop = Math.min(40, 9 * falling * falling + 2.2 * falling);
    spin = falling * 5.5;
    if (falling >= FALL_OUT) killPlayer({ blast: false });
  }
  rig.position.set(pos.x, rigY - drop, pos.z);
  rig.rotation.y = -yaw + spin;
  ufo.rotation.set(-thrust * 0.05 * (1 - lift * 0.5), 0, bank * (1 + lift * 0.35));

  const beamH = Math.max(0.1, rigY - 0.5 - 0.06);
  beam.scale.set(1 + lift * 0.45, beamH, 1 + lift * 0.45);
  beam.position.set(pos.x, 0.06 + beamH / 2, pos.z);
  beam.material.opacity = (0.06 + pulse * 0.05) * (1 - lift * 0.45);

  playerLight.position.set(pos.x, rigY + 0.55, pos.z);
  glow.position.set(pos.x, rigY + 0.5, pos.z);

  updateHoverFx(bobT);

  // where it would come down, marked on the floor (or on the roof) below
  dropRing.visible = lift > 0.03;
  if (dropRing.visible) {
    dropRing.position.set(pos.x, wallTopAt(pos.x, pos.z) + 0.05, pos.z);
    dropRing.scale.setScalar(1 + Math.sin(bobT * 4) * 0.06);
    const warn = liftUp && !onBlockLevel() && charge <= LIFT.warn;
    dropRing.material = warn ? dropRingWarnMat : dropRingMat;
    dropRing.material.opacity = 0.22 + lift * 0.3;
  }
}

function step(dt) {
  fireT -= dt;
  hurtT -= dt;
  // once it is going down there is nothing left to steer
  if (falling) {
    updateUfo(dt, 0, 0);
    elapsed += dt;
    return;
  }
  if (mouseDown || held("Space", " ")) tryFire();

  let turn = 0;
  if (held("KeyA", "a", "ArrowLeft")) turn -= 1;
  if (held("KeyD", "d", "ArrowRight")) turn += 1;
  let thrust = 0;
  if (held("KeyW", "w", "ArrowUp")) thrust += 1;
  if (held("KeyS", "s", "ArrowDown")) thrust -= 1;

  if (turn) yaw += turn * TURN_SPEED * dt;
  if (thrust) {
    const fx = Math.sin(yaw);
    const fz = -Math.cos(yaw);
    const sp = SPEED * (lift >= LIFT.fly ? LIFT.speed : 1);
    // one level up the low blocks are underneath: everything taller still stops
    // the craft, so the maze is only opened up by exactly the height it gained
    const r = level.slide(pos.x, pos.z, fx * thrust * sp * dt, fz * thrust * sp * dt,
      RADIUS, overWalls, craftSolids());
    pos.x = r.x;
    pos.z = r.z;
  }

  // and a knockback, which bleeds away on its own
  if (Math.abs(shoveX) + Math.abs(shoveZ) > 0.02) {
    const r = level.slide(pos.x, pos.z, shoveX * dt, shoveZ * dt, RADIUS, overWalls, craftSolids());
    pos.x = r.x;
    pos.z = r.z;
    const k = Math.exp(-WARDEN.knockDecay * dt);
    shoveX *= k;
    shoveZ *= k;
  } else {
    shoveX = 0;
    shoveZ = 0;
  }

  updateUfo(dt, thrust, turn);
  elapsed += dt;
}

function updateEnemies(dt) {
  for (const e of enemies) {
    if (e.dead) continue;
    if (e.type === "lurker") {
      stepShade(e, dt);
      continue;
    }
    if (e.type === "grunt") {
      stepMine(e, dt);
      continue;
    }
    if (e.type === "warden") {
      stepWarden(e, dt);
      continue;
    }
    const dx = pos.x - e.x;
    const dz = pos.z - e.z;
    const d = Math.hypot(dx, dz) || 1e-6;
    const ux = dx / d;
    const uz = dz / d;
    // what is left here is the spitter. On the floor it keeps its distance and
    // shoots; rooted on a block top (a "decker") it does not move at all - it is
    // the garrison of the level above, and it only ever shoots at that level.
    const engaged = e.deck ? craftLevel() === 1 && d < e.aggro : d < e.aggro;
    e.wanderT += dt;

    if (engaged) {
      if (!e.deck) {
        const want = 16;
        const move = d > want + 3 ? 1 : d < want - 3 ? -1 : 0;
        if (move) {
          const r = level.walk(e.x, e.z, ux * move * e.speed * dt, uz * move * e.speed * dt, ENEMY_R);
          e.x = r.x;
          e.z = r.z;
        }
      }
      e.fireT -= dt;
      if (e.fireT <= 0) {
        e.fireT = e.fireRate * (0.7 + decor() * 0.6);
        const shotY = e.level === 1 ? BLOCK_H + 1.05 : 1.05;
        addBullet(eBullets, "seed", e.x + ux * 1.35, shotY, e.z + uz * 1.35,
          ux * 22, uz * 22, 2.6, 8, e.level);
        gameAudio.sfx("enemyShot", { x: e.x, z: e.z });
        e.recoilT = 0.18; // it kicks back, and you can see it
      }
    } else if (!e.deck) {
      idleStep(e, dt);
      e.fireT = Math.max(e.fireT, 0); // no pot-shots from across the level
    }
    // it can only touch what is on its own level
    if (craftLevel() === e.level && d < (e.r || ENEMY_R) + RADIUS + 0.2) hurtPlayer(TOUCH_DMG * 0.5);

    e.hitT = Math.max(0, e.hitT - dt);
    e.recoilT = Math.max(0, e.recoilT - dt);
    // it charges up before it spits: the chamber swells and glows harder the
    // closer it is to firing, which is the tell you get to react to
    const charge = engaged ? clamp01(1 - e.fireT / 0.75) : 0;
    const bob = Math.sin(bobT * 2.5 + e.x * 0.5) * 0.16;
    const s = 1 + e.hitT * 2.5 + charge * 0.12;
    e.group.position.set(e.x, (e.level === 1 ? BLOCK_H : 0) + 1.1 + bob, e.z);
    e.group.rotation.y = Math.atan2(-dx, -dz);
    e.group.rotation.z = Math.sin(bobT * 3 + e.z) * 0.16;
    e.body.scale.setScalar(s);
    e.spitter.mouthMat.emissiveIntensity = 0.8 + charge * 4.5;
    e.spitter.mouth.scale.setScalar(0.7 + charge * 0.8);
    e.spitter.snout.position.z = -0.72 + e.recoilT * 0.55;
    e.spitter.mouth.position.z = -1.12 + e.recoilT * 0.55;
  }
}

/* A bolt meeting a shot in flight: the shot comes apart where it is, not on the
   hull. A glob still goes off - it just goes off out there, and the shove it
   carries is the only thing you feel for knocking it down that close. */
function shootDown(j) {
  const o = eBullets[j];
  eBullets.splice(j, 1);
  bulletGroup.remove(o.mesh);
  gameAudio.sfx("shotDown", { x: o.x, z: o.z });
  if (o.kind === "glob") {
    spawnBurst(o.x, o.y, o.z, BOOM.glob());
    spawnBurst(o.x, o.y, o.z, BOOM.mine());
    gameAudio.sfx("boom", { x: o.x, z: o.z });
    const d = Math.hypot(pos.x - o.x, pos.z - o.z);
    if (d < WARDEN.blast) {
      const k = 1 - d / WARDEN.blast;
      shake = Math.min(1.6, shake + 0.7 * k);
      const v = Math.hypot(o.vx, o.vz) || 1;
      const knock = o.knock || WARDEN.knock;
      shoveX += (o.vx / v) * knock * 0.3 * k;
      shoveZ += (o.vz / v) * knock * 0.3 * k;
    }
  } else {
    spawnBurst(o.x, o.y, o.z, BOOM.spark());
  }
}

function updateBullets(dt) {
  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    b.x += b.vx * dt;
    b.z += b.vz * dt;
    b.life -= dt;
    let kill = b.life <= 0;
    let hitRock = false;
    const skip = b.level === 1 ? overLowWalls : null;
    if (!kill && level.hitsWall(b.x, b.z, BULLET_R, skip, b.level === 1 ? level.upperSolids : level.walls)) {
      kill = true;
      hitRock = true;
    }
    if (!kill) {
      for (const e of enemies) {
        if (e.dead) continue;
        if ((e.level || 0) !== b.level) continue; // not on the same level
        if (Math.hypot(e.x - b.x, e.z - b.z) < (e.r || ENEMY_R) + BULLET_R) {
          e.hp -= b.dmg;
          e.hitT = 0.12;
          gameAudio.sfx("hit", { x: e.x, z: e.z });
          // a mine that has already latched on goes off where it stands, so
          // shooting the blinking thing next to you is not a way out
          if (e.hp <= 0) {
            if (e.armed) detonateMine(e, { credit: true });
            else killEnemy(e);
          }
          kill = true;
          break;
        }
      }
    }
    if (!kill) {
      // and a shot can be knocked out of the air: a warden's glob is heavy and
      // slow precisely so that the answer to it is your gun, not just running
      for (let j = eBullets.length - 1; j >= 0; j--) {
        const o = eBullets[j];
        if (o.level !== b.level) continue;
        if (Math.hypot(o.x - b.x, o.z - b.z) > o.r + b.r) continue;
        shootDown(j);
        kill = true;
        break;
      }
    }
    if (!kill) {
      // the tears stand up off the floor, so a bolt from either level goes into
      // one: a spawner is a thing you can do something about
      for (const rf of rifts) {
        if (rf.dying) continue;
        if (Math.hypot(rf.x - b.x, rf.z - b.z) > RIFT.r + b.r) continue;
        hurtRift(rf, b.dmg);
        kill = true;
        break;
      }
    }
    if (hitRock) spawnBurst(b.x, b.y, b.z, BOOM.spark());
    if (kill) {
      bulletGroup.remove(b.mesh);
      bullets.splice(i, 1);
    } else {
      b.mesh.position.set(b.x, b.y, b.z);
    }
  }

  for (let i = eBullets.length - 1; i >= 0; i--) {
    const b = eBullets[i];
    b.x += b.vx * dt;
    b.z += b.vz * dt;
    b.life -= dt;
    let kill = b.life <= 0;
    let hitRock = false;
    const skip = b.level === 1 ? overLowWalls : null;
    if (!kill && level.hitsWall(b.x, b.z, BULLET_R, skip, b.level === 1 ? level.upperSolids : level.walls)) {
      kill = true;
      hitRock = true;
    }
    if (!kill && b.level === craftLevel() && Math.hypot(pos.x - b.x, pos.z - b.z) < RADIUS + BULLET_R) {
      if (b.kind === "glob") {
        // a warden's shell does not only bite: it goes off on the hull, drinks the
        // hover and throws the craft back hard
        hurtPlayer(b.dmg);
        charge = Math.max(0, charge - WARDEN.drain);
        const v = Math.hypot(b.vx, b.vz) || 1;
        const knock = b.knock || WARDEN.knock;
        shoveX = (b.vx / v) * knock;
        shoveZ = (b.vz / v) * knock;
        spawnBurst(b.x, b.y, b.z, BOOM.glob());
        spawnBurst(b.x, b.y, b.z, BOOM.mine());
        spawnDebris(b.x, b.y, b.z, {
          palette: "blast", count: 12, speed: 16, lift: 12, spread: 1, life: 9,
        });
        gameAudio.sfx("globHit");
        gameAudio.sfx("boom", { x: b.x, z: b.z });
        gameAudio.poke(0.7);
        shake = Math.min(1.7, shake + 0.85);
        hurtFlash = Math.min(1, hurtFlash + 0.35);
      } else {
        hurtPlayer(b.dmg);
      }
      kill = true;
    }
    if (hitRock) {
      if (b.kind === "glob") {
        // a shell that meets rock still goes off
        spawnBurst(b.x, b.y, b.z, BOOM.glob());
        spawnBurst(b.x, b.y, b.z, BOOM.mine());
        gameAudio.sfx("boom", { x: b.x, z: b.z });
        const d = Math.hypot(pos.x - b.x, pos.z - b.z);
        if (d < WARDEN.blast) shake = Math.min(1.6, shake + 0.7 * (1 - d / WARDEN.blast));
      } else {
        spawnBurst(b.x, b.y, b.z, BOOM.spark());
      }
    }
    if (kill) {
      bulletGroup.remove(b.mesh);
      eBullets.splice(i, 1);
    } else {
      b.mesh.position.set(b.x, b.y, b.z);
    }
  }
}

function checkExit() {
  if (lift > 0.05) return; // flying over the exit is not reaching it
  const ex = level.cellToWorldX(level.exit.col);
  const ez = level.cellToWorldZ(level.exit.row);
  if (Math.hypot(pos.x - ex, pos.z - ez) < CELL * 0.5) {
    state = "cleared";
    clearedT = 0;
    spawnBurst(ex, 1.4, ez, BOOM.exit());
    gameAudio.sfx("exit");
    gameAudio.poke(0.9);
    shake = Math.min(1.3, shake + 0.5);
    later(0.85, () => {
      if (state !== "cleared") return;
      showOverlay(`LEVEL ${GAME.level} CLEARED`, "Descending to the next level…");
    });
  }
}

function updateHud() {
  el.level.textContent = `Level ${GAME.level}`;
  el.kills.textContent = `${GAME.kills} kills`;
  const spawners = rifts.length;
  el.left.textContent = spawners
    ? `${monstersLeft()} monsters · ${spawners} spawners`
    : `${monstersLeft()} monsters`;
  el.hp.style.width = `${(hp / PLAYER_HP) * 100}%`;
}

// The shade being awake is the loudest thing on screen: the walls press in, the
// HUD shouts, and the craft starts rattling even before it charges.
function updateHunt(dt) {
  let any = false;
  if (state === "playing") {
    for (const e of enemies) {
      if (!e.dead && e.type === "lurker" && e.state !== "lurk") {
        any = true;
        break;
      }
    }
  }
  if (any !== hunted) {
    hunted = any;
    gameAudio.hunt(any);
    el.hunt.style.display = any ? "block" : "none";
    if (any) shake = Math.min(1.5, shake + 0.45);
  }
  huntT += dt;
  const target = hunted ? 0.42 + 0.24 * Math.sin(huntT * 5.5) : 0;
  huntVeil += (target - huntVeil) * Math.min(1, dt * 6);
  if (hunted) shake = Math.min(1.4, shake + dt * 0.35);
  el.veil.style.opacity = huntVeil.toFixed(3);
}

/* ------------------------------------------------------- third-person cam */
const camPos = new THREE.Vector3();
const camRay = new THREE.Raycaster();
// test-only: a still or a probe can put the camera exactly where it wants, so a
// feature can be photographed from above instead of guessed at from the chase cam
let camOverride = null;
const camAnchor = new THREE.Vector3();
const camDesired = new THREE.Vector3();
const camDir = new THREE.Vector3();

function updateCamera(dt) {
  if (camOverride) {
    camera.position.set(camOverride.x, camOverride.y, camOverride.z);
    camera.lookAt(camOverride.tx, camOverride.ty, camOverride.tz);
    return;
  }
  const fx = Math.sin(yaw);
  const fz = -Math.cos(yaw);

  const k = 1 - Math.exp(-12 * dt);
  camPos.x += (pos.x - fx * CAM_DIST - camPos.x) * k;
  camPos.z += (pos.z - fz * CAM_DIST - camPos.z) * k;

  camAnchor.set(pos.x, HOVER + lift * LIFT.alt + 0.8, pos.z);
  // under a tunnel roof the chase camera would sit above the ceiling and stare at
  // the outside of it: duck under the roof instead, inside the corridor
  const underRoof = wallTopAt(pos.x, pos.z) > 4;
  const camY = underRoof ? Math.min(CAM_HEIGHT, ROOF_Y - 1.0) : CAM_HEIGHT;
  camDesired.set(camPos.x, camY + lift * LIFT.alt * 0.6, camPos.z);
  camDir.copy(camDesired).sub(camAnchor);
  const dist = camDir.length();
  camDir.divideScalar(dist || 1);
  camRay.set(camAnchor, camDir);
  camRay.far = dist;
  // anything solid between the craft and the camera pulls the camera in: walls,
  // and the roof slabs over the tunnels
  const hits = [];
  if (currentWallMesh) hits.push(...camRay.intersectObject(currentWallMesh, false));
  if (currentRoofMesh) hits.push(...camRay.intersectObject(currentRoofMesh, false));
  hits.sort((a, b) => a.distance - b.distance);
  const hit = hits[0];
  if (hit) camDesired.copy(camAnchor).addScaledVector(camDir, Math.max(3, hit.distance - 0.6));

  camera.position.copy(camDesired);

  // impacts rattle the camera
  if (shake > 0.001) {
    const amp = shake * 0.8;
    camera.position.x += (fxRng() - 0.5) * amp;
    camera.position.y += (fxRng() - 0.5) * amp;
    camera.position.z += (fxRng() - 0.5) * amp;
    shake = Math.max(0, shake - dt * 2.2);
  }

  camera.lookAt(pos.x + fx * 1.5, HOVER + lift * LIFT.alt + 0.6, pos.z + fz * 1.5);
}

function updateDamageUi(dt) {
  if (hurtFlash <= 0 && el.hurt.style.opacity === "0") return;
  hurtFlash = Math.max(0, hurtFlash - dt * 2.4);
  el.hurt.style.opacity = (hurtFlash * 0.8).toFixed(3);
}

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

/* ------------------------------------------------------------ debug handle */
// handy from the browser console: UFO.level, UFO.enemies, UFO.move(x, z), ...
globalThis.UFO = {
  get level() { return GAME.level; },
  get state() { return state; },
  get hp() { return hp; },
  get kills() { return GAME.kills; },
  get monsters() { return monstersLeft(); },
  get guards() { return enemies.filter((e) => !e.dead && e.guard).length; },
  get enemies() { return enemies; },
  get bullets() { return bullets; },
  get eBullets() { return eBullets; },
  get explosions() { return explosions.length; },
  get particles() { return explosions.reduce((n, e) => n + e.count, 0); },
  get pos() { return pos; },
  get yaw() { return yaw; },
  set yaw(v) { yaw = v; },
  get stuck() { return level.hitsWall(pos.x, pos.z, RADIUS, overWalls, craftSolids()); },
  stuckAt: (x, z) => level.hitsWall(x, z),
  get keys() { return [...keys]; },
  get shades() { return enemies.filter((e) => e.type === "lurker"); },
  get wardens() { return enemies.filter((e) => e.type === "warden"); },
  get hoverFx() { return hoverFx; },
  get levelNow() { return craftLevel(); },
  get rifts() { return rifts; },
  get riftsOpened() { return riftsOpened; },
  get riftsClosed() { return riftsClosed; },
  // a shot in the air, for a test that wants one exactly where it wants it
  shot(kind, x, z, vx, vz, level = 0) {
    addBullet(eBullets, kind, x, HOVER + level * LIFT.alt - 0.1, z, vx, vz, 3.2, WARDEN.dmg, level);
  },
  get debris() { return debris; },
  get splats() { return splats; },
  get hunted() { return hunted; },
  get mine() { return MINE; },
  get lift() { return lift; },
  get liftUp() { return liftUp; },
  get charge() { return charge; },
  get alt() { return lift * LIFT.alt; },
  get pads() { return pads; },
  get liftCfg() { return LIFT; },
  get onBlock() { return onBlockLevel(); },
  // holes in the floor: no ground at all, and the same meter holds you up
  get pits() { return [...level.pits].map((key) => {
    const [c, r] = key.split(",").map(Number);
    return { col: c, row: r, x: level.cellToWorldX(c), z: level.cellToWorldZ(r) };
  }); },
  get vaults() { return level.vaults; },
  // what a hole looks like: pure black, never fogged, and drawn above the room pads
  get pitLook() {
    return {
      color: pitMat.color.getHex(), fog: pitMat.fog, y: PIT_Y,
      padY: PAD_Y, lipColor: pitEdgeMat.color.getHex(), lipFog: pitEdgeMat.fog,
    };
  },
  // the holes in the floor, with the band of nothing round the map left out
  get holes() { return [...level.pits].filter((k) => !level.rim.has(k)).map((key) => {
    const [c, r] = key.split(",").map(Number);
    return { col: c, row: r, x: level.cellToWorldX(c), z: level.cellToWorldZ(r) };
  }); },
  // the band of nothing round the map (the only holes on the first levels)
  get rim() { return [...level.rim].map((key) => {
    const [c, r] = key.split(",").map(Number);
    return { col: c, row: r, x: level.cellToWorldX(c), z: level.cellToWorldZ(r) };
  }); },
  get towerness() { return towerness; },
  // walls taller than the camera: towers and monoliths
  get towers() { return cellsOfKind((k) => k === "X" || k === "S"); },
  get monoliths() { return cellsOfKind((k) => k === "S"); },
  get roofs() { return [...level.roofs].map((key) => {
    const [c, r] = key.split(",").map(Number);
    return { col: c, row: r, x: level.cellToWorldX(c), z: level.cellToWorldZ(r) };
  }); },
  get overHole() { return overHole(); },
  holeAt: (x, z) => level.holeAt(x, z),
  get falling() { return falling; },
  get craftVisible() { return ufo.visible; },
  get camPos() { return { x: camera.position.x, y: camera.position.y, z: camera.position.z }; },
  // the dust field, and the bubble kept clear around the craft
  // what the level's light is doing: a place can turn the lamp down
  get lamp() {
    return { intensity: playerLight.intensity, distance: playerLight.distance, fog: scene.fog.far };
  },
  get place() { return place; },
  get dust() { return dustGeo.attributes.position.array; },
  get dustBubble() { return { r: DUST_BUBBLE_R, y: DUST_BUBBLE_Y }; },
  get tip() { return { text: el.hint.innerHTML, t: tipT }; },
  get controlsHint() { return CONTROLS_HINT; },
  // wall cells by kind, in world units (the tests and the probe steer by these)
  get blocks() { return cellsOfKind((k) => k === "O"); },
  get highWalls() { return cellsOfKind((k) => k !== "O" && k !== "P"); },
  blockedAt: (x, z) => level.hitsWall(x, z, RADIUS, overWalls,
    lift >= LIFT.fly ? level.upperSolids : level.walls),
  wallTopAt: (x, z) => wallTopAt(x, z),
  blastAt: (d) => blastDamage(d),
  get audio() { return gameAudio; },
  killPlayer,
  despawn(e) { killEnemy(e, { credit: false, quiet: true }); },
  get exit() { return level.exit; },
  // the cell the run starts on (the `start(n)` method below is the level starter)
  get startCell() { return level.start; },
  get rooms() { return level.rooms; },
  get props() {
    return [...level.features.keys()].map((key) => {
      const [c, r] = key.split(",").map(Number);
      return { key, x: level.cellToWorldX(c), z: level.cellToWorldZ(r) };
    });
  },
  get stats() { return level.stats; },
  worldOf: (c, r) => level.worldOf(c, r),
  // ...and a camera that ignores the chase for one still
  cam(x, y, z, tx, ty, tz) { camOverride = { x, y, z, tx, ty, tz }; },
  camOff() { camOverride = null; },
  start(n) {
    // a test or a console call starts a level straight away, past the menu
    hideOverlay();
    startLevel(Math.max(1, Math.floor(n)));
  },
  get save() { return { ...SAVE }; },
  get inMenu() { return state === "menu"; },
  get menuChoice() { return menuChoice; },
  toMenu() { showMenu(); },
  choose(n) { chooseStart(Math.max(1, Math.floor(n) || 1)); },
  get ladder() { return { unlock: UNLOCK, enemies: levelEnemies(GAME.level), guards: levelGuards(GAME.level), shades: levelLurkers(GAME.level), rifts: levelRifts(GAME.level), lifts: levelLifts(GAME.level), wardens: levelWardens(GAME.level) }; },
  aim(x, z) { yaw = Math.atan2(x - pos.x, -(z - pos.z)); },
  move(x, z) { pos.x = x; pos.z = z; },
  damage(n) { hurtPlayer(n); },
  kill() { for (const e of enemies) if (!e.dead) killEnemy(e); },
};

/* ------------------------------------------------------------------- go */
// The world is built first (so the start screen has the level behind it), then
// the menu takes over until a level is picked.
startLevel(1, { record: false });
showMenu();

const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05);
  // where the ears are, before anything this frame wants to be heard
  gameAudio.listener(pos.x, pos.z, yaw);

  if (state === "playing") {
    step(dt);
    updateLift(dt);
    updateEnemies(dt);
    updateBullets(dt);
    checkExit();
    // the exit is where the run is decided, and the score knows it
    const ex = level.cellToWorldX(level.exit.col);
    const ez = level.cellToWorldZ(level.exit.row);
    if (Math.hypot(pos.x - ex, pos.z - ez) < 26) gameAudio.poke(0.55 * dt);
  } else {
    updateLift(dt);
    updateUfo(dt, 0, 0);
    if (state === "cleared") {
      clearedT += dt;
      if (clearedT > 1.7) startLevel(GAME.level + 1);
    }
  }

  updateCamera(dt);
  updateDust(dt);
  updateExplosions(dt);
  updateDebris(dt);
  if (state === "playing") updateRifts(dt);
  updateHunt(dt);
  updateHud();
  updateDamageUi(dt);
  updateTip(dt);
  renderer.render(scene, camera);
});
