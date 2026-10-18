// Minimal stand-in for three.js: enough surface for main.js to boot and for a
// scripted game loop to run headlessly. Not a renderer, just a state machine.

class Vec {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  copy(v) { return this.set(v.x, v.y, v.z); }
  sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
  add(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
  addScaledVector(v, s) { this.x += v.x * s; this.y += v.y * s; this.z += v.z * s; return this; }
  multiplyScalar(s) { this.x *= s; this.y *= s; this.z *= s; return this; }
  setScalar(s) { this.x = s; this.y = s; this.z = s; return this; }
  divideScalar(s) { return this.multiplyScalar(1 / s); }
  length() { return Math.hypot(this.x, this.y, this.z); }
  lengthSq() { return this.x * this.x + this.y * this.y + this.z * this.z; }
  clone() { return new Vec(this.x, this.y, this.z); }
}

class Euler {
  constructor() { this.x = 0; this.y = 0; this.z = 0; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
}

class Scale {
  constructor() { this.x = 1; this.y = 1; this.z = 1; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  setScalar(s) { return this.set(s, s, s); }
}

class Obj3D {
  constructor() {
    this.children = [];
    this.parent = null;
    this.position = new Vec();
    this.rotation = new Euler();
    this.quaternion = new Quaternion();
    this.scale = new Scale();
    this.matrix = new Matrix4();
    this.visible = true;
  }
  add(...objs) {
    for (const o of objs) { this.children.push(o); o.parent = this; }
    return this;
  }
  remove(o) {
    const i = this.children.indexOf(o);
    if (i >= 0) { this.children.splice(i, 1); o.parent = null; }
    return this;
  }
  traverse(fn) { fn(this); for (const c of this.children) c.traverse(fn); }
  updateMatrix() {}
  updateMatrixWorld() {}
  lookAt() {}
}

export class Group extends Obj3D {}
export class Object3D extends Obj3D {}
export class Scene extends Obj3D {
  constructor() { super(); this.background = null; this.fog = null; }
}
export class Sprite extends Obj3D {
  constructor(material) { super(); this.material = material; this.isSprite = true; }
}
export class Points extends Obj3D {
  constructor(geometry, material) { super(); this.geometry = geometry; this.material = material; this.isPoints = true; }
}

export class Mesh extends Obj3D {
  constructor(geometry, material) {
    super();
    this.geometry = geometry;
    this.material = material;
    this.castShadow = false;
    this.receiveShadow = false;
    this.isMesh = true;
  }
}

export class InstancedMesh extends Mesh {
  constructor(geometry, material, count) {
    super(geometry, material);
    this.count = count;
    this.isInstancedMesh = true;
    this.instanceMatrix = { needsUpdate: true };
    this.instanceColor = { needsUpdate: true };
  }
  setMatrixAt(i, m) {}
  setColorAt(i, c) {}
  dispose() { this.disposed = true; }
}

class Geo { constructor(...a) { this.args = a; } dispose() {} }
export class BoxGeometry extends Geo {}
export class PlaneGeometry extends Geo {}
export class SphereGeometry extends Geo {}
export class CylinderGeometry extends Geo {}
export class ConeGeometry extends Geo {}
export class TorusGeometry extends Geo {}
export class RingGeometry extends Geo {}
export class IcosahedronGeometry extends Geo {}

export class BufferGeometry {
  constructor() { this.attributes = {}; }
  setAttribute(name, attr) { this.attributes[name] = attr; return this; }
  dispose() {}
}
export class BufferAttribute {
  constructor(array, itemSize) { this.array = array; this.itemSize = itemSize; this.needsUpdate = false; }
}

export class Color {
  constructor(hex = 0) { this.value = hex; }
  setHex(h) { this.value = h; return this; }
  set(h) { this.value = h; return this; }
  multiplyScalar(s) { this.value = Math.floor((this.value || 0) * s); return this; }
  getHex() { return this.value; }
}

class Material {
  constructor(opts = {}) { Object.assign(this, opts); this.emissiveIntensity = opts.emissiveIntensity ?? 1; this.dispose = () => {}; }
  clone() { return new this.constructor(this); }
}
export class MeshStandardMaterial extends Material {}
export class MeshBasicMaterial extends Material {}
export class SpriteMaterial extends Material {}
export class PointsMaterial extends Material {}
export class CanvasTexture {
  constructor(canvas) { this.image = canvas; this.repeat = new Vec(1, 1, 0); this.colorSpace = null; this.wrapS = 0; this.wrapT = 0; this.anisotropy = 1; }
  dispose() {}
}
export class Fog { constructor(color, near, far) { this.color = color; this.near = near; this.far = far; } }
export class PerspectiveCamera extends Obj3D {
  constructor(fov, aspect, near, far) { super(); this.fov = fov; this.aspect = aspect; this.near = near; this.far = far; }
  updateProjectionMatrix() {}
}
export class Raycaster {
  constructor() { this.ray = { origin: new Vec(), direction: new Vec() }; this.near = 0; this.far = Infinity; this.n = 0; }
  set(origin, dir) { this.ray.origin = origin; this.ray.direction = dir; this.n++; return this; }
  intersectObject() { return []; }
}
export class PointLight extends Obj3D {
  constructor(color, intensity, distance, decay) {
    super();
    this.color = color; this.intensity = intensity; this.distance = distance; this.decay = decay;
    this.castShadow = false;
    this.shadow = { mapSize: { set() {} }, bias: 0, camera: { far: 500 } };
  }
}
export class AmbientLight extends Obj3D {
  constructor(color, intensity) { super(); this.color = color; this.intensity = intensity; }
}
export class Matrix4 {
  compose() { return this; }
  setPosition() { return this; }
  identity() { return this; }
}
export class Quaternion {
  identity() { return this; }
  copy() { return this; }
  setFromAxisAngle() { return this; }
  setFromUnitVectors() { return this; }
}
export class Clock {
  constructor() { this.t = 0; }
  getDelta() { const d = HARNESS.dt; HARNESS.dt = 1 / 60; return d; }
  getElapsedTime() { return this.t; }
}

export const SRGBColorSpace = "srgb";
export const RepeatWrapping = 1000;
export const EquirectangularReflectionMapping = 303;
export const AdditiveBlending = 2;
export const NormalBlending = 1;
export const DoubleSide = 2;
export const PCFSoftShadowMap = 2;
export const ACESFilmicToneMapping = 4;
export const Vector3 = Vec;

export class PMREMGenerator {
  constructor() {}
  fromEquirectangular() { return { texture: { isTexture: true } }; }
  compileEquirectangularShader() {}
  dispose() {}
}

export const HARNESS = {
  dt: 1 / 60,
  loop: null,
  renderer: null,
  frames: 0,
};

export class WebGLRenderer {
  constructor() {
    this.domElement = { addEventListener() {} };
    this.shadowMap = { enabled: false, type: 0 };
    this.toneMapping = 0;
    this.toneMappingExposure = 1;
    HARNESS.renderer = this;
  }
  setPixelRatio() {}
  setSize() {}
  render() { HARNESS.frames++; }
  setAnimationLoop(cb) { HARNESS.loop = cb; }
  dispose() {}
}
