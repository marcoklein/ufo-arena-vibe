import * as THREE from "three";
import { CELL, RADIUS, createLevel, makeRng } from "./maze.js";
import { THEMES } from "./themes.js";

/* ------------------------------------------------------------------ config */
const SPEED = 16;        // forward speed, units/second
const TURN_SPEED = 2.8;  // turn rate, radians/second
const WALL_H = 4.5;      // standard wall height
const TOWER_H = 7.5;     // thick rock towers
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
const TOUCH_DMG = 12;

const WALL_STYLE = {
  "#": { h: WALL_H, color: 0x3b4a5e },  // plain rock
  X: { h: TOWER_H, color: 0x2f6b70 },   // tower
  O: { h: 2.6, color: 0x7a4f3a },       // low block
  B: { h: BORDER_H, color: 0x33415a },  // perimeter
};
const CROWN_COOL = 0x49b8ff;
const CROWN_WARM = 0xffa53d;

const levelSize = (n) => Math.min(45, 23 + n * 2);    // grid is N x N
const levelEnemies = (n) => Math.min(30, 5 + n * 2);  // roaming hunters
const levelGuards = (n) => Math.min(12, 2 + n);       // defenders ringing the exit

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
  g.addColorStop(0, "#22344b");
  g.addColorStop(0.48, "#101c2b");
  g.addColorStop(0.55, "#2a3a4e");
  g.addColorStop(1, "#05080d");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  for (const [x, y, r, c] of [[0.28, 0.2, 30, "255,226,180"], [0.72, 0.32, 24, "120,214,255"]]) {
    const rg = ctx.createRadialGradient(s * x, s * y, 0, s * x, s * y, r);
    rg.addColorStop(0, `rgba(${c},0.85)`);
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
renderer.toneMappingExposure = 1.15;
document.body.appendChild(renderer.domElement);

// dull reflections for the metalwork; deliberately weak so the gloom survives
{
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromEquirectangular(envTexture()).texture;
  scene.environmentIntensity = 0.4;
  pmrem.dispose();
}

/* ------------------------------------------------------------------ lights */
scene.add(new THREE.AmbientLight(0x1a2636, 0.14));

const playerLight = new THREE.PointLight(0xffe4bc, 220, 190, 1.5);
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
const markerGeo = new THREE.PlaneGeometry(CELL * 0.82, CELL * 0.82);
const exitPillarGeo = new THREE.CylinderGeometry(CELL * 0.38, CELL * 0.38, 14, 22, 1, true);

const wallTex = wallTexture();
const wallMat = new THREE.MeshStandardMaterial({
  color: 0xffffff, map: wallTex, bumpMap: wallTex, bumpScale: 0.4,
  roughness: 0.85, metalness: 0.05, emissive: 0x0a1420, emissiveIntensity: 1,
});
const crownCoolMat = new THREE.MeshStandardMaterial({ color: CROWN_COOL, emissive: CROWN_COOL, emissiveIntensity: 2.6, roughness: 0.4 });
const crownWarmMat = new THREE.MeshStandardMaterial({ color: CROWN_WARM, emissive: CROWN_WARM, emissiveIntensity: 2.6, roughness: 0.4 });
const crownMatCache = new Map([[CROWN_COOL, crownCoolMat], [CROWN_WARM, crownWarmMat]]);
function crownMaterial(color) {
  let mat = crownMatCache.get(color);
  if (!mat) {
    mat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 2.6, roughness: 0.4 });
    crownMatCache.set(color, mat);
  }
  return mat;
}
const mastMat = new THREE.MeshStandardMaterial({ color: 0x8fa3bb, metalness: 0.7, roughness: 0.45, emissive: 0x1b3f47, emissiveIntensity: 0.8 });
const tipMat = new THREE.MeshStandardMaterial({ color: 0xff9a6b, emissive: 0xff5a3c, emissiveIntensity: 3 });
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
      map: padTex, color: THEMES[theme].pad, transparent: true, opacity: 0.55,
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
let level = null;

function clearWorld() {
  for (const child of worldGroup.children.slice()) {
    worldGroup.remove(child);
    if (child.isInstancedMesh) child.dispose();
  }
}

function buildWorld(L) {
  clearWorld();

  const size = Math.max(L.cols, L.rows) * CELL;
  floor.scale.set(size * 3, size * 3, 1);
  floorTex.repeat.set((size * 3) / CELL, (size * 3) / CELL);

  /* walls: per-instance height + colour */
  const wallMesh = new THREE.InstancedMesh(boxGeo, wallMat, L.walls.size);
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
    for (const key of L.walls) {
      const [c, r] = key.split(",").map(Number);
      const kind = L.isBorderCell(c, r) ? "B" : L.wallKind.get(key) ?? "#";
      const style = WALL_STYLE[kind] ?? WALL_STYLE["#"];
      const h = style.h * (0.97 + decor() * 0.06);
      heights.set(key, h);
      p.set(L.cellToWorldX(c), h / 2, L.cellToWorldZ(r));
      s.set(1, h, 1);
      m.compose(p, q, s);
      wallMesh.setMatrixAt(i, m);
      // walls lining a themed room take that room's colour
      const theme = L.wallTheme.get(key);
      col.setHex(theme === undefined ? style.color : THEMES[theme].wall).multiplyScalar(0.85 + decor() * 0.35);
      wallMesh.setColorAt(i, col);
      i++;
    }
    wallMesh.instanceMatrix.needsUpdate = true;
    if (wallMesh.instanceColor) wallMesh.instanceColor.needsUpdate = true;
  }
  worldGroup.add(wallMesh);
  currentWallMesh = wallMesh;

  /* glowing crown trim — one instanced mesh per colour, so a themed room is
     outlined in its own colour */
  {
    const groups = new Map(); // colour -> wall keys
    for (const key of L.walls) {
      const [c, r] = key.split(",").map(Number);
      const theme = L.wallTheme.get(key);
      const kind = L.wallKind.get(key);
      const color = L.isBorderCell(c, r) ? CROWN_COOL
        : theme !== undefined ? THEMES[theme].trim
        : kind === "O" ? CROWN_WARM
        : CROWN_COOL;
      if (!groups.has(color)) groups.set(color, []);
      groups.get(color).push(key);
    }
    const m = new THREE.Matrix4();
    for (const [color, cells] of groups) {
      const mesh = new THREE.InstancedMesh(crownGeo, crownMaterial(color), cells.length);
      cells.forEach((key, i) => {
        const [c, r] = key.split(",").map(Number);
        m.setPosition(L.cellToWorldX(c), (heights.get(key) ?? WALL_H) + 0.05, L.cellToWorldZ(r));
        mesh.setMatrixAt(i, m);
      });
      mesh.instanceMatrix.needsUpdate = true;
      worldGroup.add(mesh);
    }
  }

  /* glowing floor pad marking out each room */
  for (const room of L.rooms) {
    const pad = new THREE.Mesh(padGeo, padMaterial(room.theme));
    pad.rotation.x = -Math.PI / 2;
    pad.scale.set(room.w * CELL, room.h * CELL, 1);
    pad.position.set(
      L.cellToWorldX(room.x + (room.w - 1) / 2), 0.025, L.cellToWorldZ(room.y + (room.h - 1) / 2)
    );
    worldGroup.add(pad);
  }

  /* props standing on the walls that line each themed room */
  if (L.features.size) {
    const byKind = new Map(); // "theme:kind" -> wall keys
    for (const [key, f] of L.features) {
      const id = `${f.theme}:${f.kind}`;
      if (!byKind.has(id)) byKind.set(id, []);
      byKind.get(id).push(key);
    }
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const p = new THREE.Vector3();
    const s = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    for (const [id, keys] of byKind) {
      const [themeIdx, kind] = id.split(":");
      const theme = THEMES[Number(themeIdx)];
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
    const mastMesh = new THREE.InstancedMesh(mastGeo, mastMat, towers.length);
    const tipMesh = new THREE.InstancedMesh(tipGeo, tipMat, towers.length);
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
}

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
const DUST = 900;
const DUST_SPREAD = 260;
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
  for (let i = 0; i < DUST; i++) {
    const y = i * 3 + 1;
    a[y] += dustRise[i] * dt;
    if (a[y] > 10.5) a[y] = 0.2;
  }
  dustGeo.attributes.position.needsUpdate = true;
}

/* --------------------------------------------------------------- enemies */
const enemyGroup = new THREE.Group();
scene.add(enemyGroup);
const enemyBodyGeo = new THREE.IcosahedronGeometry(1, 0);
const enemyEyeGeo = new THREE.SphereGeometry(0.22, 10, 8);
const enemyBodyMat = {
  grunt: new THREE.MeshStandardMaterial({ color: 0xe04a4a, roughness: 0.55, metalness: 0.2, emissive: 0xd42a2a, emissiveIntensity: 0.3 }),
  spitter: new THREE.MeshStandardMaterial({ color: 0x8a53f0, roughness: 0.55, metalness: 0.2, emissive: 0x6a2fe0, emissiveIntensity: 0.3 }),
};
const enemyEyeMat = {
  grunt: new THREE.MeshStandardMaterial({ color: 0xffdcdc, emissive: 0xff8080, emissiveIntensity: 2 }),
  spitter: new THREE.MeshStandardMaterial({ color: 0xe8dcff, emissive: 0xb892ff, emissiveIntensity: 2 }),
};
const ENEMY_SPEC = {
  grunt: { hp: 2, speed: 5.4 },
  spitter: { hp: 3, speed: 3.8 },
};

let enemies = [];

function spawnEnemy(type, x, z, power, { guard = false, hpBonus = 0 } = {}) {
  const spec = ENEMY_SPEC[type];
  const group = new THREE.Group();
  const body = new THREE.Mesh(enemyBodyGeo, enemyBodyMat[type]);
  group.add(body);
  const eye = new THREE.Mesh(enemyEyeGeo, enemyEyeMat[type]);
  eye.position.set(0, 0.1, -0.6);
  group.add(eye);
  group.position.set(x, 1.1, z);
  enemyGroup.add(group);

  const hp = spec.hp + Math.floor(power / 3) + hpBonus;
  return {
    type, group, body, eye,
    x, z, hp, maxHp: hp,
    speed: spec.speed * (1 + power * 0.05),
    fireT: 1 + decor(),
    fireRate: Math.max(0.7, 2.4 - power * 0.13),
    hitT: 0,
    dead: false,
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
  const r = level.slide(e.x, e.z, (dx / d) * spd * dt, (dz / d) * spd * dt, ENEMY_R);
  e.x = r.x;
  e.z = r.z;
}

/* --------------------------------------------------------------- bullets */
const bulletGroup = new THREE.Group();
scene.add(bulletGroup);
const bulletGeo = new THREE.SphereGeometry(0.22, 10, 8);
const playerBulletMat = new THREE.MeshBasicMaterial({ color: 0xa8f4ff, toneMapped: false });
const enemyBulletMat = new THREE.MeshBasicMaterial({ color: 0xff7bd8, toneMapped: false });

let bullets = [];
let eBullets = [];

function addBullet(list, mat, x, y, z, vx, vz, life, dmg) {
  const mesh = new THREE.Mesh(bulletGeo, mat);
  mesh.position.set(x, y, z);
  bulletGroup.add(mesh);
  list.push({ x, y, z, vx, vz, life, dmg, mesh });
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
  flash = 0,
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
  const points = new THREE.Points(geo, new THREE.PointsMaterial({
    map: sparkTex, size, sizeAttenuation: true, transparent: true,
    blending: THREE.AdditiveBlending, depthWrite: false, vertexColors: true, toneMapped: false,
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
    geo, points, shellMesh, shockMesh, shellSize: shell, shockSize: shock,
  });
}

const BOOM = {
  // a monster going up
  enemy: (type) => ({
    color: type === "spitter" ? 0xa06bff : 0xff7a3c,
    hot: type === "spitter" ? 0xf2e6ff : 0xfff0cf,
    count: 34, speed: 16, size: 0.6, life: 0.85,
    shell: 2.8, shock: 3.4, flash: 230,
  }),
  // a bullet puckering out against rock
  spark: () => ({
    color: 0x8fc6ff, hot: 0xffffff, count: 7, speed: 9, size: 0.24,
    life: 0.22, gravity: 1.5, drag: 7, spread: 0.25,
  }),
  // the craft itself
  player: () => ({
    color: 0x5fe6ff, hot: 0xffffff, count: 110, speed: 30, size: 1.0,
    life: 1.5, gravity: 11, drag: 1.9, spread: 1.4, shell: 9, shock: 12, flash: 900,
  }),
};

function blowUpPlayer() {
  spawnBurst(pos.x, HOVER, pos.z, BOOM.player());
  ufo.visible = false;
  shake = Math.min(1.6, shake + 1.2);
  // a few secondary detonations rolling out of the wreck
  for (let i = 0; i < 4; i++) {
    const a = fxRng() * Math.PI * 2;
    const r = 1.5 + fxRng() * 3.5;
    later(0.1 + i * 0.13, () => spawnBurst(
      pos.x + Math.cos(a) * r, HOVER + (fxRng() - 0.3) * 1.2, pos.z + Math.sin(a) * r,
      { color: 0xffb066, hot: 0xfff0cf, count: 26, speed: 17, size: 0.65, life: 0.85, shell: 3, shock: 3.4, flash: 220 }
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
      e.shellMesh.scale.setScalar(e.shellSize * (0.25 + k * 1.15));
      e.shellMesh.material.opacity = 0.8 * Math.pow(1 - k, 1.7);
    }
    if (e.shockMesh) {
      e.shockMesh.scale.setScalar(e.shockSize * (0.3 + k * 1.5));
      e.shockMesh.material.opacity = 0.7 * Math.pow(1 - k, 2);
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
  }
  explosions.length = 0;
  fxQueue.length = 0;
  for (const f of fxLights) { f.light.intensity = 0; f.t = f.max; }
}

/* ------------------------------------------------------------------ input */
const keys = new Set();
let mouseDown = false;
addEventListener("keydown", (e) => {
  if (e.code === "KeyR") {
    if (state === "dead") restartGame();
    else startLevel(GAME.level);
    return;
  }
  if (e.code.startsWith("Arrow") || e.code === "Space") e.preventDefault();
  keys.add(e.code);
});
addEventListener("keyup", (e) => keys.delete(e.code));
addEventListener("blur", () => { keys.clear(); mouseDown = false; });
renderer.domElement.addEventListener("pointerdown", () => { mouseDown = true; });
addEventListener("pointerup", () => { mouseDown = false; });

/* ------------------------------------------------------------------ state */
const el = {
  level: document.getElementById("lvl"),
  kills: document.getElementById("kills"),
  left: document.getElementById("left"),
  hp: document.getElementById("hpbar"),
  overlay: document.getElementById("overlay"),
  ovTitle: document.getElementById("ovtitle"),
  ovSub: document.getElementById("ovsub"),
  hurt: document.getElementById("hurt"),
};

const GAME = { level: 1, kills: 0 };
let state = "playing"; // "playing" | "cleared" | "dead"
let hp = PLAYER_HP;
let hurtT = 0;
let hurtFlash = 0;
let shake = 0;
let fireT = 0;
let clearedT = 0;
let muzzleT = 0;
let elapsed = 0;

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
}

function startLevel(n) {
  GAME.level = n;
  decor = makeRng(777 + n);
  level = createLevel({ cols: levelSize(n), rows: levelSize(n), seed: 1000 + n });
  buildWorld(level);
  clearEntities();
  clearExplosions();
  ufo.visible = true;

  pos.set(level.cellToWorldX(level.start.col), HOVER, level.cellToWorldZ(level.start.row));
  yaw = 0;
  bank = 0;
  bobT = 0;
  hp = PLAYER_HP;
  hurtT = 0;
  hurtFlash = 0;
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

  /* roamers, spread over the level and well away from the start pad */
  const spawns = level.openCells.filter(([c, r]) => near(c, r, pos.x, pos.z) > 34);
  for (let i = 0; i < levelEnemies(n) && spawns.length; i++) {
    const [c, r] = spawns.splice(Math.floor(rng() * spawns.length), 1)[0];
    const type = rng() < 0.33 ? "spitter" : "grunt";
    enemies.push(spawnEnemy(type, level.cellToWorldX(c), level.cellToWorldZ(r), n));
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
    const type = rng() < 0.4 ? "spitter" : "grunt";
    enemies.push(spawnEnemy(type, level.cellToWorldX(c), level.cellToWorldZ(r), n, { guard: true, hpBonus: 1 }));
  }

  hideOverlay();
  updateHud();
}

function restartGame() {
  GAME.kills = 0;
  startLevel(1);
}

function hurtPlayer(dmg) {
  if (state !== "playing" || hurtT > 0) return;
  hp -= dmg;
  hurtT = HURT_COOLDOWN;
  hurtFlash = Math.min(1, hurtFlash + 0.5 + dmg * 0.02);
  shake = Math.min(1.2, shake + 0.16);
  if (hp <= 0) {
    hp = 0;
    state = "dead";
    blowUpPlayer();
    showOverlay("GAME OVER", `Reached level ${GAME.level} · ${GAME.kills} kills · press R to restart`);
  }
}

function killEnemy(e) {
  e.dead = true;
  enemyGroup.remove(e.group);
  GAME.kills++;
  spawnBurst(e.x, 1.1, e.z, BOOM.enemy(e.type));
  const d = Math.hypot(pos.x - e.x, pos.z - e.z);
  if (d < 14) shake = Math.min(1.2, shake + 0.22 * (1 - d / 14));
}

function tryFire() {
  if (fireT > 0 || state !== "playing") return;
  fireT = FIRE_COOLDOWN;
  const fx = Math.sin(yaw);
  const fz = -Math.cos(yaw);
  addBullet(bullets, playerBulletMat, pos.x + fx * NOSE, HOVER, pos.z + fz * NOSE,
    fx * BULLET_SPEED, fz * BULLET_SPEED, BULLET_LIFE, 1);
  ufoMuzzle.visible = true;
  muzzleT = 0.06;
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

  const bob = Math.sin(bobT * 3) * 0.07;
  const rigY = HOVER + bob;
  rig.position.set(pos.x, rigY, pos.z);
  rig.rotation.y = -yaw;
  ufo.rotation.set(-thrust * 0.05, 0, bank);

  const beamH = Math.max(0.1, rigY - 0.5 - 0.06);
  beam.scale.set(1, beamH, 1);
  beam.position.set(pos.x, 0.06 + beamH / 2, pos.z);
  beam.material.opacity = 0.06 + pulse * 0.05;

  playerLight.position.set(pos.x, HOVER + 0.55, pos.z);
  glow.position.set(pos.x, HOVER + 0.5, pos.z);
}

function step(dt) {
  fireT -= dt;
  hurtT -= dt;
  if (keys.has("Space") || mouseDown) tryFire();

  let turn = 0;
  if (keys.has("KeyA") || keys.has("ArrowLeft")) turn -= 1;
  if (keys.has("KeyD") || keys.has("ArrowRight")) turn += 1;
  let thrust = 0;
  if (keys.has("KeyW") || keys.has("ArrowUp")) thrust += 1;
  if (keys.has("KeyS") || keys.has("ArrowDown")) thrust -= 1;

  if (turn) yaw += turn * TURN_SPEED * dt;
  if (thrust) {
    const fx = Math.sin(yaw);
    const fz = -Math.cos(yaw);
    const r = level.slide(pos.x, pos.z, fx * thrust * SPEED * dt, fz * thrust * SPEED * dt);
    pos.x = r.x;
    pos.z = r.z;
  }

  updateUfo(dt, thrust, turn);
  elapsed += dt;
}

function updateEnemies(dt) {
  for (const e of enemies) {
    if (e.dead) continue;
    const dx = pos.x - e.x;
    const dz = pos.z - e.z;
    const d = Math.hypot(dx, dz) || 1e-6;
    const ux = dx / d;
    const uz = dz / d;
    const engaged = d < e.aggro;
    e.wanderT += dt;

    if (e.type === "grunt") {
      if (engaged) {
        const r = level.slide(e.x, e.z, ux * e.speed * dt, uz * e.speed * dt, ENEMY_R);
        e.x = r.x;
        e.z = r.z;
      } else {
        idleStep(e, dt);
      }
      if (d < ENEMY_R + RADIUS + 0.2) hurtPlayer(TOUCH_DMG);
    } else {
      if (engaged) {
        const want = 16;
        const move = d > want + 3 ? 1 : d < want - 3 ? -1 : 0;
        if (move) {
          const r = level.slide(e.x, e.z, ux * move * e.speed * dt, uz * move * e.speed * dt, ENEMY_R);
          e.x = r.x;
          e.z = r.z;
        }
        e.fireT -= dt;
        if (e.fireT <= 0) {
          e.fireT = e.fireRate * (0.7 + decor() * 0.6);
          addBullet(eBullets, enemyBulletMat, e.x + ux, 1.1, e.z + uz, ux * 22, uz * 22, 2.6, 8);
        }
      } else {
        idleStep(e, dt);
        e.fireT = Math.max(e.fireT, 0); // no pot-shots from across the level
      }
      if (d < ENEMY_R + RADIUS + 0.2) hurtPlayer(TOUCH_DMG * 0.5);
    }

    e.hitT = Math.max(0, e.hitT - dt);
    const bob = Math.sin(bobT * 2.5 + e.x * 0.5) * 0.16;
    const s = 1 + e.hitT * 2.5;
    e.group.position.set(e.x, 1.1 + bob, e.z);
    e.group.rotation.y = Math.atan2(-dx, -dz);
    e.group.rotation.z = Math.sin(bobT * 3 + e.z) * 0.16;
    e.body.scale.setScalar(s);
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
    if (!kill && level.hitsWall(b.x, b.z, BULLET_R)) { kill = true; hitRock = true; }
    if (!kill) {
      for (const e of enemies) {
        if (e.dead) continue;
        if (Math.hypot(e.x - b.x, e.z - b.z) < ENEMY_R + BULLET_R) {
          e.hp -= b.dmg;
          e.hitT = 0.12;
          if (e.hp <= 0) killEnemy(e);
          kill = true;
          break;
        }
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
    if (!kill && level.hitsWall(b.x, b.z, BULLET_R)) { kill = true; hitRock = true; }
    if (!kill && Math.hypot(pos.x - b.x, pos.z - b.z) < RADIUS + BULLET_R) {
      hurtPlayer(b.dmg);
      kill = true;
    }
    if (hitRock) spawnBurst(b.x, b.y, b.z, BOOM.spark());
    if (kill) {
      bulletGroup.remove(b.mesh);
      eBullets.splice(i, 1);
    } else {
      b.mesh.position.set(b.x, b.y, b.z);
    }
  }
}

function checkExit() {
  const ex = level.cellToWorldX(level.exit.col);
  const ez = level.cellToWorldZ(level.exit.row);
  if (Math.hypot(pos.x - ex, pos.z - ez) < CELL * 0.5) {
    state = "cleared";
    clearedT = 0;
    showOverlay(`LEVEL ${GAME.level} CLEARED`, "Descending to the next level…");
  }
}

function updateHud() {
  el.level.textContent = `Level ${GAME.level}`;
  el.kills.textContent = `${GAME.kills} kills`;
  el.left.textContent = `${monstersLeft()} monsters`;
  el.hp.style.width = `${(hp / PLAYER_HP) * 100}%`;
}

/* ------------------------------------------------------- third-person cam */
const camPos = new THREE.Vector3();
const camRay = new THREE.Raycaster();
const camAnchor = new THREE.Vector3();
const camDesired = new THREE.Vector3();
const camDir = new THREE.Vector3();

function updateCamera(dt) {
  const fx = Math.sin(yaw);
  const fz = -Math.cos(yaw);

  const k = 1 - Math.exp(-12 * dt);
  camPos.x += (pos.x - fx * CAM_DIST - camPos.x) * k;
  camPos.z += (pos.z - fz * CAM_DIST - camPos.z) * k;

  camAnchor.set(pos.x, HOVER + 0.8, pos.z);
  camDesired.set(camPos.x, CAM_HEIGHT, camPos.z);
  camDir.copy(camDesired).sub(camAnchor);
  const dist = camDir.length();
  camDir.divideScalar(dist || 1);
  camRay.set(camAnchor, camDir);
  camRay.far = dist;
  const hit = currentWallMesh ? camRay.intersectObject(currentWallMesh, false)[0] : null;
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

  camera.lookAt(pos.x + fx * 1.5, HOVER + 0.6, pos.z + fz * 1.5);
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
  get explosions() { return explosions.length; },
  get particles() { return explosions.reduce((n, e) => n + e.count, 0); },
  get pos() { return pos; },
  get yaw() { return yaw; },
  set yaw(v) { yaw = v; },
  get stuck() { return level.hitsWall(pos.x, pos.z); },
  stuckAt: (x, z) => level.hitsWall(x, z),
  get exit() { return level.exit; },
  get rooms() { return level.rooms; },
  get props() {
    return [...level.features.keys()].map((key) => {
      const [c, r] = key.split(",").map(Number);
      return { key, x: level.cellToWorldX(c), z: level.cellToWorldZ(r) };
    });
  },
  get stats() { return level.stats; },
  worldOf: (c, r) => level.worldOf(c, r),
  aim(x, z) { yaw = Math.atan2(x - pos.x, -(z - pos.z)); },
  move(x, z) { pos.x = x; pos.z = z; },
  damage(n) { hurtPlayer(n); },
  kill() { for (const e of enemies) if (!e.dead) killEnemy(e); },
};

/* ------------------------------------------------------------------- go */
startLevel(1);

const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05);

  if (state === "playing") {
    step(dt);
    updateEnemies(dt);
    updateBullets(dt);
    checkExit();
  } else {
    updateUfo(dt, 0, 0);
    if (state === "cleared") {
      clearedT += dt;
      if (clearedT > 1.7) startLevel(GAME.level + 1);
    }
  }

  updateCamera(dt);
  updateDust(dt);
  updateExplosions(dt);
  updateHud();
  updateDamageUi(dt);
  renderer.render(scene, camera);
});
