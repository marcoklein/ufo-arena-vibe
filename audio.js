/* ------------------------------------------------------------------ audio */
// Everything you hear is synthesised at runtime out of oscillators, noise and
// filters: no sample library, no engine, nothing to download. The score is
// composed per level from a table of keys, modes, tempos and patterns, so level
// 7 really is a different piece of music than level 1.
//
// Two rules keep this safe to bolt onto a game that already works:
//
//   - nothing browser-shaped happens at import time. In Node (the smoke
//     harness) there is no AudioContext, so the engine stays "off" and every
//     call is a no-op that still records what it was asked to play.
//   - the music never rides on the game loop. It writes itself ahead of the
//     audio clock from its own timer, so a heavy frame cannot make it stutter.
//
// `measure()` renders a stretch of the score (and any sound effects) through an
// OfflineAudioContext and reports real RMS numbers, which is how the test suite
// checks that this actually makes noise without anyone having to listen.

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v) => clamp(v, 0, 1);
const midi = (n) => 440 * 2 ** ((n - 69) / 12);

/* Seeded, and deliberately not the game's rng: audio must never take a draw out
   of a gameplay stream, or the level layouts would shift under it. */
function makeRng(seed) {
  let a = (seed >>> 0) || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------ mix */
const MASTER_VOL = 0.85;
const MUSIC_VOL = 0.3;
const MUSIC_DUCK = 0.1;   // while the run is over the score gets out of the way
const SFX_VOL = 0.5;
const SFX_RANGE = 34;     // a sound still carries this far, then it is gone
const SFX_NEAR = 4;       // inside this it is at full volume
const LOOKAHEAD = 0.16;   // how far ahead of the clock the score is written
const PUMP_MS = 40;       // how often it is topped up

/* The music is not a loop that runs forever. It comes in when something is
   happening, plays a phrase, and then stops again, so exploring a quiet level is
   actually quiet. Energy is what decides: the game pokes it when you shoot, when
   something dies, when a mine arms, when a rift opens, when the shade wakes, when
   you get close to the exit. It bleeds away on its own. */
const MUSIC_PHRASE = 4;    // bars played in one go
const MUSIC_REST = 2;      // bars of silence before it can start again
const MUSIC_DECAY = 0.978; // how fast the room calms down, per sixteenth note
const MUSIC_KEEP = 0.22;   // still something happening: play the next phrase
const MUSIC_START = 0.32;  // enough to come in from silence

/* ---------------------------------------------------------------- buffers */
// A 2.6s reverb tail made from darkened noise: cheap, and it gives the cavern a
// sense of size without shipping an impulse response file.
function impulse(ctx, seconds = 2.6, decay = 2.4) {
  const rate = ctx.sampleRate;
  const n = Math.max(1, Math.floor(rate * seconds));
  const buf = ctx.createBuffer(2, n, rate);
  const rnd = makeRng(913);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let prev = 0;
    for (let i = 0; i < n; i++) {
      const white = rnd() * 2 - 1;
      prev = prev * 0.74 + white * 0.26;          // one-pole lowpass: dark tail
      d[i] = prev * (1 - i / n) ** decay;
    }
  }
  return buf;
}

function noiseBuffer(ctx, seconds = 2) {
  const rate = ctx.sampleRate;
  const n = Math.floor(rate * seconds);
  const buf = ctx.createBuffer(1, n, rate);
  const d = buf.getChannelData(0);
  const rnd = makeRng(4097);
  for (let i = 0; i < n; i++) d[i] = rnd() * 2 - 1;
  return buf;
}

/* ------------------------------------------------------------- voice kit */
// The three primitives every sound here is built from: an envelope, an
// oscillator with a pitch sweep, and a burst of filtered noise.

function envGain(ctx, t, a, dur, peak) {
  const g = ctx.createGain();
  const atk = Math.max(0.001, a);
  const end = Math.max(atk + 0.02, dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + atk);
  g.gain.exponentialRampToValueAtTime(0.0001, t + end);
  return g;
}

// The shared tail every voice plugs into: volume, stereo placement and, when the
// sound is far away, a lowpass so distance sounds like distance rather than just
// "quieter".
function voiceOut(rig, o = {}, bus) {
  const ctx = rig.ctx;
  const head = ctx.createGain();
  head.gain.value = o.vol == null ? 1 : o.vol;
  let tail = head;
  const pan = o.pan || 0;
  if (ctx.createStereoPanner && Math.abs(pan) > 0.01) {
    const p = ctx.createStereoPanner();
    p.pan.value = clamp(pan, -1, 1);
    tail.connect(p);
    tail = p;
  }
  if (o.muffle) {
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = clamp(o.muffle, 200, 18000);
    tail.connect(lp);
    tail = lp;
  }
  tail.connect(bus || rig.sfxBus);
  return head;
}

function osc(ctx, type, f0, f1, t, dur, detune = 0) {
  const o = ctx.createOscillator();
  o.type = type;
  if (detune) o.detune.value = detune;
  o.frequency.setValueAtTime(Math.max(1, f0), t);
  if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + Math.max(0.01, dur));
  o.start(t);
  o.stop(t + dur + 0.08);
  return o;
}

function tone(rig, t, {
  type = "sawtooth", f0 = 220, f1, dur = 0.3, peak = 0.3, a = 0.006,
  sub = 0, spread = 0, bus, vol, pan, muffle,
} = {}) {
  const ctx = rig.ctx;
  const head = voiceOut(rig, { vol, pan, muffle }, bus);
  const g = envGain(ctx, t, a, dur, peak);
  g.connect(head);
  osc(ctx, type, f0, f1, t, dur).connect(g);
  if (spread) {
    osc(ctx, type, f0, f1, t, dur, spread).connect(g);
    osc(ctx, type, f0, f1, t, dur, -spread).connect(g);
  }
  if (sub) {
    const s = ctx.createGain();
    s.gain.value = sub;
    s.connect(g);
    osc(ctx, "sine", f0 / 2, (f1 || f0) / 2, t, dur * 1.15).connect(s);
  }
}

function noiseHit(rig, t, {
  dur = 0.2, peak = 0.3, a = 0.002, lp = 0, hp = 0, bp = 0, q = 1,
  sweep = 0, bus, vol, pan, muffle,
} = {}) {
  const ctx = rig.ctx;
  const head = voiceOut(rig, { vol, pan, muffle }, bus);
  const g = envGain(ctx, t, a, dur, peak);
  let node = g;
  const filter = (type, freq) => {
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(Math.max(40, freq), t);
    if (sweep) f.frequency.exponentialRampToValueAtTime(Math.max(40, sweep), t + dur);
    f.Q.value = q;
    node.connect(f);
    node = f;
  };
  if (lp) filter("lowpass", lp);
  if (hp) filter("highpass", hp);
  if (bp) filter("bandpass", bp);
  node.connect(head);
  const src = ctx.createBufferSource();
  src.buffer = rig.noise;
  src.loop = true;
  src.connect(g);
  src.start(t);
  src.stop(t + dur + 0.06);
}

/* ------------------------------------------------------------- the sounds */
// One entry per sound in the game. Each is a handful of oscillators and filters
// with a deliberate shape: arming a mine is a latch and a rising chirp, the
// detonation is a sub drop plus a blast, and the fuse beep is high and piercing
// so it cuts through everything else while you decide whether to run.

const SFX = {
  // the cannon: a bright zap with a click on the front
  shoot(rig, t, o) {
    tone(rig, t, { type: "square", f0: 1150, f1: 250, dur: 0.09, peak: 0.2, a: 0.002, ...o });
    noiseHit(rig, t, { dur: 0.03, peak: 0.08, hp: 2200, ...o });
  },
  // a bullet biting a hull
  hit(rig, t, o) {
    noiseHit(rig, t, { dur: 0.05, peak: 0.22, bp: 2400, q: 0.9, ...o });
    tone(rig, t, { type: "sine", f0: 1500, f1: 900, dur: 0.06, peak: 0.1, ...o });
  },
  // something coming apart: a metallic pop
  kill(rig, t, o) {
    noiseHit(rig, t, { dur: 0.3, peak: 0.3, bp: 1100, sweep: 180, q: 0.7, ...o });
    tone(rig, t, { type: "triangle", f0: 240, f1: 80, dur: 0.22, peak: 0.18, ...o });
  },
  // a shade dying is lower and wetter than anything else
  killShade(rig, t, o) {
    tone(rig, t, { type: "sawtooth", f0: 170, f1: 34, dur: 0.8, peak: 0.3, sub: 0.5, ...o });
    noiseHit(rig, t, { dur: 0.9, peak: 0.26, lp: 1400, sweep: 110, ...o });
  },
  // a spitter answering: lower, warblier, and it comes from over there
  enemyShot(rig, t, o) {
    tone(rig, t, { type: "square", f0: 540, f1: 150, dur: 0.15, peak: 0.15, a: 0.004, spread: 40, ...o });
  },
  // a mine going off: sub drop, blast, crack, long tail
  boom(rig, t, o) {
    tone(rig, t, { type: "sine", f0: 120, f1: 27, dur: 0.95, peak: 0.8, a: 0.003, ...o });
    noiseHit(rig, t, { dur: 0.95, peak: 0.5, lp: 3200, sweep: 90, ...o });
    noiseHit(rig, t, { dur: 0.06, peak: 0.3, hp: 3000, ...o });
    tone(rig, t, { type: "sawtooth", f0: 300, f1: 60, dur: 0.4, peak: 0.16, ...o });
  },
  // it latched on: a clunk and a chirp
  mineArm(rig, t, o) {
    noiseHit(rig, t, { dur: 0.06, peak: 0.26, bp: 1500, q: 0.8, ...o });
    tone(rig, t, { type: "square", f0: 480, f1: 1500, dur: 0.2, peak: 0.16, a: 0.004, ...o });
  },
  // the fuse: short, high, and it climbs as the clock runs down
  mineBeep(rig, t, o) {
    tone(rig, t, { type: "square", f0: 1500 + (o.pitch || 0) * 1000, dur: 0.055, peak: 0.13, a: 0.002, ...o });
  },
  // the hull taking one
  hurt(rig, t, o) {
    tone(rig, t, { type: "sawtooth", f0: 200, f1: 120, dur: 0.2, peak: 0.26, a: 0.002, spread: 60, ...o });
    noiseHit(rig, t, { dur: 0.16, peak: 0.22, lp: 2200, sweep: 400, ...o });
  },
  // the craft going up
  death(rig, t, o) {
    tone(rig, t, { type: "sawtooth", f0: 420, f1: 28, dur: 1.6, peak: 0.4, sub: 0.55, ...o });
    noiseHit(rig, t, { dur: 1.8, peak: 0.42, lp: 4200, sweep: 80, ...o });
    tone(rig, t, { type: "sine", f0: 95, f1: 20, dur: 1.5, peak: 0.5, a: 0.004, ...o });
  },
  // the exit answering: rising pings
  exit(rig, t, o) {
    [0, 4, 7, 12].forEach((semi, i) => {
      tone(rig, t + i * 0.11, { type: "triangle", f0: midi(69 + semi), dur: 0.42, peak: 0.2, a: 0.004, ...o });
    });
  },
  // a level cleared: the same figure, quicker and higher
  levelUp(rig, t, o) {
    [0, 7, 12].forEach((semi, i) => {
      tone(rig, t + i * 0.08, { type: "square", f0: midi(64 + semi), dur: 0.3, peak: 0.16, ...o });
    });
  },
  // a rift tearing open
  rift(rig, t, o) {
    noiseHit(rig, t, { dur: 0.55, peak: 0.26, bp: 2600, sweep: 200, q: 1.6, ...o });
    tone(rig, t, { type: "sawtooth", f0: 760, f1: 110, dur: 0.5, peak: 0.16, ...o });
  },
  // a rift giving way: the tear howling as it comes apart, longer and lower
  riftDie(rig, t, o) {
    noiseHit(rig, t, { dur: 1.15, peak: 0.3, bp: 2400, sweep: 120, q: 1.2, ...o });
    tone(rig, t, { type: "sawtooth", f0: 640, f1: 62, dur: 1.05, peak: 0.28, a: 0.01, sub: 0.45, ...o });
    tone(rig, t + 0.1, { type: "square", f0: 420, f1: 130, dur: 0.75, peak: 0.1, spread: 30, ...o });
    noiseHit(rig, t + 0.35, { dur: 0.7, peak: 0.16, bp: 1400, sweep: 90, ...o });
  },
  // a shot knocked out of the air: a bright ping with a scrape on it
  shotDown(rig, t, o) {
    tone(rig, t, { type: "square", f0: 2300, f1: 640, dur: 0.07, peak: 0.17, a: 0.001, ...o });
    tone(rig, t + 0.01, { type: "triangle", f0: 3300, f1: 1500, dur: 0.13, peak: 0.1, ...o });
    noiseHit(rig, t, { dur: 0.05, peak: 0.15, hp: 3000, ...o });
  },
  // the shade deciding you are worth it: a low, sour cluster
  shadeWake(rig, t, o) {
    tone(rig, t, { type: "sawtooth", f0: 92, dur: 1.2, peak: 0.24, a: 0.05, spread: 22, ...o });
    tone(rig, t, { type: "sawtooth", f0: 130, dur: 1.2, peak: 0.14, a: 0.09, ...o });
    noiseHit(rig, t, { dur: 1.3, peak: 0.22, lp: 420, sweep: 90, ...o });
  },
  // the lunge: a rolling mass with a rising growl, and you hear it commit
  shadeCharge(rig, t, o) {
    // the weight of it rolling at you, opening up as it comes
    noiseHit(rig, t, { dur: 0.78, peak: 0.4, lp: 160, sweep: 1200, q: 1.2, ...o });
    // something rising underneath: it is not slowing down
    tone(rig, t, { type: "sawtooth", f0: 44, f1: 98, dur: 0.8, peak: 0.3, a: 0.03, spread: 30, sub: 0.6, ...o });
    // and metal dragging across stone
    noiseHit(rig, t, { dur: 0.5, peak: 0.13, bp: 1400, sweep: 3600, q: 2.2, ...o });
    // a high harmonic on top so it cuts through the score
    tone(rig, t + 0.05, { type: "square", f0: 620, f1: 1500, dur: 0.6, peak: 0.08, a: 0.12, spread: 40, ...o });
  },
  // a pad taking the craft up: a column of air with a bright edge on it
  liftUp(rig, t, o) {
    tone(rig, t, { type: "sine", f0: 82, f1: 640, dur: 0.85, peak: 0.3, a: 0.02, sub: 0.5, ...o });
    noiseHit(rig, t, { dur: 0.9, peak: 0.22, bp: 820, sweep: 5200, q: 1.1, ...o });
    tone(rig, t + 0.1, { type: "square", f0: 210, f1: 840, dur: 0.55, peak: 0.07, a: 0.03, spread: 25, ...o });
    // and it settles into a note up there
    tone(rig, t + 0.5, { type: "triangle", f0: midi(76), dur: 0.55, peak: 0.13, a: 0.02, ...o });
  },
  // the clock on the deck: two short, insistent beeps
  liftWarn(rig, t, o) {
    const f = 1160 + (o.pitch || 0) * 220;
    tone(rig, t, { type: "square", f0: f, dur: 0.09, peak: 0.24, a: 0.002, ...o });
    tone(rig, t, { type: "sine", f0: f * 0.5, dur: 0.15, peak: 0.12, a: 0.002, ...o });
    tone(rig, t + 0.15, { type: "square", f0: f, dur: 0.09, peak: 0.19, a: 0.002, ...o });
  },
  // the deck letting go: air falling away underneath
  liftFall(rig, t, o) {
    noiseHit(rig, t, { dur: 0.9, peak: 0.2, bp: 4200, sweep: 300, q: 0.9, ...o });
    tone(rig, t, { type: "sine", f0: 620, f1: 90, dur: 0.85, peak: 0.2, a: 0.01, ...o });
  },
  // touchdown
  liftLand(rig, t, o) {
    tone(rig, t, { type: "sine", f0: 132, f1: 38, dur: 0.45, peak: 0.42, a: 0.003, ...o });
    noiseHit(rig, t, { dur: 0.4, peak: 0.3, lp: 1600, sweep: 140, ...o });
    tone(rig, t, { type: "triangle", f0: 220, f1: 140, dur: 0.2, peak: 0.1, spread: 40, ...o });
  },
  // and there was no floor: the long one, all the way down
  voidFall(rig, t, o) {
    noiseHit(rig, t, { dur: 1.6, peak: 0.26, bp: 2600, sweep: 90, q: 0.6, ...o });
    tone(rig, t, { type: "sine", f0: 300, f1: 28, dur: 1.5, peak: 0.24, a: 0.02, ...o });
    tone(rig, t + 0.5, { type: "triangle", f0: 160, f1: 22, dur: 1.1, peak: 0.12, ...o });
  },
  // a warden glob bursting on the hull: wet, and the hover going with it
  globHit(rig, t, o) {
    noiseHit(rig, t, { dur: 0.24, peak: 0.28, lp: 950, sweep: 180, ...o });
    tone(rig, t, { type: "sine", f0: 320, f1: 68, dur: 0.34, peak: 0.24, a: 0.003, ...o });
    tone(rig, t + 0.02, { type: "square", f0: 940, f1: 230, dur: 0.16, peak: 0.08, ...o });
  },
  // the shade losing you: the growl going back down
  shadeSettle(rig, t, o) {
    tone(rig, t, { type: "sawtooth", f0: 132, f1: 58, dur: 1.1, peak: 0.17, a: 0.04, ...o });
    noiseHit(rig, t, { dur: 1.2, peak: 0.12, lp: 360, sweep: 120, ...o });
  },
  // a warden opening its eye: stone grinding, and a whine coming up
  wardenWake(rig, t, o) {
    noiseHit(rig, t, { dur: 0.7, peak: 0.3, bp: 700, sweep: 1600, q: 1.4, ...o });
    tone(rig, t, { type: "triangle", f0: 180, f1: 430, dur: 0.7, peak: 0.24, a: 0.05, ...o });
    tone(rig, t + 0.12, { type: "sine", f0: 640, f1: 980, dur: 0.5, peak: 0.14, a: 0.08, ...o });
  },
  // and spitting a glob: wet, heavy, short
  wardenShot(rig, t, o) {
    tone(rig, t, { type: "triangle", f0: 330, f1: 105, dur: 0.22, peak: 0.34, a: 0.004, ...o });
    noiseHit(rig, t, { dur: 0.18, peak: 0.24, lp: 1100, sweep: 320, ...o });
  },
  // it meets a wall: the one that shakes the camera
  shadeCrash(rig, t, o) {
    tone(rig, t, { type: "sine", f0: 98, f1: 27, dur: 0.55, peak: 0.75, a: 0.002, ...o });
    noiseHit(rig, t, { dur: 0.42, peak: 0.45, lp: 2800, sweep: 150, ...o });
    tone(rig, t, { type: "triangle", f0: 190, f1: 118, dur: 0.26, peak: 0.18, spread: 55, ...o });
    noiseHit(rig, t + 0.03, { dur: 0.32, peak: 0.13, hp: 3200, ...o });
  },
};

/* ------------------------------------------------------------- the score */
// Levels walk a fixed sequence of keys and modes, so a run has an arc: level 1
// is a slow A aeolian pulse with almost nothing happening in it, and by level 10
// it is a fast locrian thing with arpeggios, snare and bells on top.

const MODES = {
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  locrian: [0, 1, 3, 5, 6, 8, 10],
};
const ROOTS = [55.0, 58.27, 61.74, 65.41, 49.0, 73.42, 51.91, 43.65]; // A1 Bb1 B1 C2 G1 D2 G#1 F1
const MODE_ORDER = ["aeolian", "phrygian", "aeolian", "dorian", "phrygian", "locrian"];

// Four chords per loop, as scale degrees: i-VI-iv-VII and friends.
const PROGS = [
  [0, 5, 3, 6],
  [0, 3, 4, 0],
  [0, 6, 5, 6],
  [0, 1, 5, 4],
  [0, 4, 1, 6],
];

const KICK_PATTERNS = [[0, 8], [0, 6, 10], [0, 3, 6, 10], [0, 3, 6, 10, 13]];
const BASS_PATTERNS = [
  [[0, 0], [3, 0], [6, 7], [8, 0], [11, 0], [14, 7]],
  [[0, 0], [2, 0], [4, 0], [6, 0], [10, 7], [12, 0], [14, -5]],
  [[0, 0], [6, 0], [8, -5], [14, 7]],
  [[0, 0], [2, 12], [4, 0], [6, 7], [8, 0], [10, 12], [12, 7], [14, 0]],
];
const ARP_FIGURES = [
  [[4, 0], [6, 2], [8, 4], [10, 2], [12, 4], [14, 6]],
  [[2, 4], [4, 2], [6, 0], [10, 2], [12, 4], [14, 2]],
  [[0, 0], [2, 2], [4, 4], [6, 7], [8, 4], [10, 2], [12, 0], [14, 2]],
  [[4, 7], [6, 4], [8, 2], [10, 0], [12, 2], [14, 4]],
];

// The tune. One motif per level, in scale degrees over that bar's chord, played
// an octave up: this is the part you can hum afterwards, and it is what makes a
// level sound like a piece of music instead of a pulse.
const MOTIFS = [
  [[0, 0], [6, 2], [8, 4], [12, 2]],
  [[0, 4], [3, 2], [6, 0], [10, 2], [14, 4]],
  [[0, 0], [4, 2], [6, 4], [10, 2], [12, 0]],
  [[0, 4], [2, 2], [6, 0], [8, 4], [14, 2]],
  [[0, 0], [3, 4], [6, 2], [8, 4], [12, 7]],
];

// Everything the score needs to know about a level. Pure: same level in, same
// music out, which is what makes the offline measurements repeatable.
function arrangement(level) {
  const L = Math.max(1, Math.round(level) || 1);
  const stage = Math.min(L - 1, 11);
  const bpm = Math.min(152, 74 + stage * 7);
  return {
    level: L,
    root: ROOTS[stage % ROOTS.length],
    mode: MODE_ORDER[Math.floor(stage / 2) % MODE_ORDER.length],
    bpm,
    prog: PROGS[stage % PROGS.length],
    kick: KICK_PATTERNS[Math.min(KICK_PATTERNS.length - 1, Math.floor(stage / 3))],
    bass: BASS_PATTERNS[stage % BASS_PATTERNS.length],
    arp: ARP_FIGURES[stage % ARP_FIGURES.length],
    motif: MOTIFS[stage % MOTIFS.length],
    layers: {
      pad: true,
      bass: true,
      kick: true,
      melody: true,
      hat: stage >= 1,
      arp: stage >= 2,
      snare: stage >= 3,
      bells: stage >= 4,
      lead: stage >= 7,
    },
    stepDur: 60 / bpm / 4, // one sixteenth note
  };
}

// A scale degree (which may run past the octave) in the arrangement's key.
function degreeNote(arr, deg, octave = 0) {
  const mode = MODES[arr.mode] || MODES.aeolian;
  const d = ((deg % 7) + 7) % 7;
  const extra = Math.floor(deg / 7);
  return arr.root * 2 ** ((mode[d] + 12 * (extra + octave)) / 12);
}

/* ---------------------------------------------------------- score voices */
function mKick(rig, t, p) {
  tone(rig, t, { type: "sine", f0: 145, f1: 44, dur: 0.3, peak: 0.75 * p, a: 0.003, bus: rig.musicBus });
  noiseHit(rig, t, { dur: 0.02, peak: 0.1 * p, hp: 1400, bus: rig.musicBus });
}
function mHat(rig, t, p, open) {
  noiseHit(rig, t, { dur: open ? 0.11 : 0.028, peak: 0.1 * p, hp: 7800, bus: rig.musicBus });
}
function mSnare(rig, t, p) {
  noiseHit(rig, t, { dur: 0.14, peak: 0.22 * p, bp: 1900, q: 1.1, bus: rig.musicBus });
  tone(rig, t, { type: "triangle", f0: 195, f1: 150, dur: 0.09, peak: 0.09 * p, bus: rig.musicBus });
}
function mBass(rig, t, f, dur, p, open) {
  tone(rig, t, {
    type: "sawtooth", f0: f, dur, peak: 0.26 * p, a: open ? 0.02 : 0.006,
    sub: 0.55, bus: rig.musicBus, muffle: open ? 900 : 1500,
  });
  tone(rig, t, { type: "square", f0: f * 0.5, dur: dur * 0.9, peak: 0.1 * p, bus: rig.musicBus });
}
function mPad(rig, t, freqs, dur, p) {
  for (const f of freqs) {
    tone(rig, t, {
      type: "sawtooth", f0: f, dur, peak: 0.05 * p, a: 0.9, spread: 9,
      bus: rig.musicBus, muffle: 1100,
    });
  }
}
function mArp(rig, t, f, p) {
  tone(rig, t, { type: "square", f0: f, dur: 0.14, peak: 0.075 * p, a: 0.003, bus: rig.musicBus });
}
function mBell(rig, t, f, p) {
  tone(rig, t, { type: "triangle", f0: f, dur: 1.1, peak: 0.07 * p, a: 0.004, bus: rig.musicBus });
}
function mLead(rig, t, f, p) {
  tone(rig, t, { type: "sawtooth", f0: f, dur: 0.5, peak: 0.07 * p, a: 0.05, spread: 26, bus: rig.musicBus });
}
// the motif voice: soft attack, a touch of detune, sitting above the pad
function mSing(rig, t, f, dur, p) {
  tone(rig, t, { type: "triangle", f0: f, dur, peak: 0.13 * p, a: 0.045, spread: 6, bus: rig.musicBus, muffle: 2600 });
}
// the shade being awake sits under the whole mix as a sour drone
function mDread(rig, t, f, dur, p) {
  tone(rig, t, { type: "sawtooth", f0: f, dur, peak: 0.18 * p, a: 0.8, spread: 13, bus: rig.musicBus, muffle: 700 });
}

/* --------------------------------------------------------- the sequencer */
// One sixteenth note of the score, in one place, so the live timer and the
// offline renderer walk exactly the same timeline.

// Four levels of "how much is going on", from a low pulse to the full thing.
function tierFor(act) {
  if (act > 0.78) return 4;
  if (act > 0.55) return 3;
  if (act > 0.34) return 2;
  return 1;
}

// Called on the downbeat of every bar: keep the phrase going, land it, or stay
// quiet. This is the whole "do not play all the time" rule.
function barDecision(rig) {
  const act = clamp01(rig.energy);
  if (rig.hunted) {
    rig.on = true;
    rig.tier = 4;
    rig.rest = 0;
    return;
  }
  if (rig.barsLeft > 0) {
    rig.barsLeft--;
    if (rig.on) rig.tier = tierFor(act); // it can gather or thin out bar by bar
    return;
  }
  if (rig.on) {
    if (act > MUSIC_KEEP) {
      rig.tier = tierFor(act);
      rig.barsLeft = MUSIC_PHRASE;
      return;
    }
    rig.on = false; // the phrase ends and the level goes quiet again
    rig.tier = 0;
    rig.rest = MUSIC_REST;
    return;
  }
  if (rig.rest > 0) {
    rig.rest--;
    rig.tier = 0;
    return;
  }
  if (act > MUSIC_START) {
    rig.on = true;
    rig.tier = tierFor(act);
    rig.barsLeft = MUSIC_PHRASE;
  } else {
    rig.tier = 0;
  }
}

function scheduleStep(rig, step) {
  const arr = rig.arr;
  if (!arr) return;
  // scripted pokes land on their own step, which is what offline runs use
  while (rig.pokes.length && rig.pokes[0][0] <= step) {
    rig.energy = clamp01(rig.energy + rig.pokes.shift()[1]);
  }
  const bar = Math.floor(step / 16);
  const s = step - bar * 16;
  if (s === 0) barDecision(rig);
  rig.energy *= MUSIC_DECAY;
  if (!rig.on) return; // a rest: no notes at all

  const t = rig.musicT0 + step * arr.stepDur;
  const chord = arr.prog[bar % arr.prog.length];
  const L = arr.layers;
  const T = rig.tier;
  // every eighth bar the drums drop out for one bar: a breath
  const breath = bar % 8 === 7;
  const p = 1;

  if (T >= 2 && L.kick && !breath && arr.kick.includes(s)) { mKick(rig, t, p); rig.notes++; }
  if (T >= 2 && L.hat && !breath) {
    const on = L.snare ? s % 2 === 1 : s % 4 === 2;
    if (on) { mHat(rig, t, p, s % 8 === 6); rig.notes++; }
  }
  if (T >= 3 && L.snare && !breath && (s === 4 || s === 12)) { mSnare(rig, t, p); rig.notes++; }

  if (L.bass) {
    for (const [bs, off] of arr.bass) {
      if (bs !== s) continue;
      mBass(rig, t, degreeNote(arr, chord) * 2 ** (off / 12), arr.stepDur * (off === 0 ? 2.6 : 1.6), p, off !== 0);
      rig.notes++;
    }
  }

  // the sparkly layers are the first thing the shade takes away
  if (T >= 3 && L.arp && !rig.hunted) {
    for (const [as, deg] of arr.arp) {
      if (as !== s) continue;
      mArp(rig, t, degreeNote(arr, chord + deg, 1), p);
      rig.notes++;
    }
  }

  // the tune: an octave above the pad, on the chord, so it is melodic rather
  // than just movement. It survives the shade waking up.
  if (T >= 2 && L.melody) {
    for (const [ms, deg] of arr.motif) {
      if (ms !== s) continue;
      mSing(rig, t, degreeNote(arr, chord + deg, 1), arr.stepDur * 2.6, p);
      rig.notes++;
    }
  }

  // one long chord per bar, plus the tension layer when the shade is awake
  if (s === 0) {
    if (L.pad) {
      const shape = L.bells ? [0, 2, 4, 6] : [0, 2, 4]; // a seventh once it is busy
      const notes = shape.map((d) => degreeNote(arr, chord + d));
      mPad(rig, t, notes, arr.stepDur * 17, p);
      rig.notes += notes.length;
    }
    if (T >= 4 && L.lead) { mLead(rig, t, degreeNote(arr, chord, 1) * 2 ** (6 / 12), p); rig.notes++; }
  }
  if (T >= 3 && L.bells && !rig.hunted && (s === 6 || s === 14)) {
    mBell(rig, t, degreeNote(arr, chord + (s === 6 ? 4 : 9), 2), p);
    rig.notes++;
  }
  if (T >= 4 && rig.hunted) {
    // the shade is up: a beating tritone drone under everything, sour notes over
    // the top, and the snares double up. This is a change of character, not a
    // layer being switched on.
    if (s === 0) {
      const f = degreeNote(arr, chord, 0) * 2 ** (6 / 12);
      mDread(rig, t, f, arr.stepDur * 15, p);
      mDread(rig, t, f * 1.06, arr.stepDur * 15, p * 0.8);
      rig.notes += 2;
    }
    if (s % 4 === 1) { mLead(rig, t, degreeNote(arr, chord + 6, 1), p); rig.notes++; }
    if (L.snare && (s === 2 || s === 10)) { mSnare(rig, t, p * 0.8); rig.notes++; }
  }
}

const stepTime = (rig, step) => rig.musicT0 + step * (rig.arr ? rig.arr.stepDur : 0.2);

/* ------------------------------------------------------------- the engine */
// One engine over any (On|Off)lineAudioContext. The parts that do not need a
// context (the log, the mute state, which level's music is playing) work without
// one, so the smoke harness can check the wiring in plain Node.

function loadMuted() {
  try {
    return globalThis.localStorage?.getItem("ufo.sound") === "off";
  } catch {
    return false; // private mode, or no DOM at all
  }
}
function saveMuted(v) {
  try {
    globalThis.localStorage?.setItem("ufo.sound", v ? "off" : "on");
  } catch {
    /* the setting just will not stick */
  }
}

function makeEngine({ ctx = null } = {}) {
  const eng = {
    ctx,
    rig: null,
    state: ctx ? "ready" : "off",
    muted: loadMuted(),
    log: [],
    level: 0,
    hunted: false,
    runState: "playing",
    energy: 0,      // how much is going on; the music lives off this
    gestured: false,
    lx: 0,
    lz: 0,
    lyaw: 0,
  };

  const record = (name) => {
    eng.log.push(name);
    if (eng.log.length > 64) eng.log.shift();
  };

  /* the game tells us where the craft is and which way it points, and the rest
     is derived: this module never has to know anything about gameplay */
  eng.listener = (x, z, yaw) => {
    eng.lx = x;
    eng.lz = z;
    eng.lyaw = yaw;
  };

  eng.hunt = (on) => {
    eng.hunted = !!on;
    if (eng.rig) eng.rig.hunted = eng.hunted;
  };

  // something happened, so the room got louder. Everything the game does that is
  // worth scoring comes through here.
  eng.poke = (amount = 0.3) => {
    eng.energy = clamp01(eng.energy + amount);
    if (eng.rig) eng.rig.energy = clamp01(eng.rig.energy + amount);
  };

  eng.music = (o = {}) => {
    if (o.level != null) eng.level = Math.round(o.level);
    if (o.state) eng.runState = o.state;
    const rig = eng.rig;
    if (!rig) return;
    const fresh = !rig.arr;
    if (eng.level && (fresh || rig.arr.level !== eng.level)) {
      rig.arr = arrangement(eng.level);
      rig.step = 0;
      rig.musicT0 = ctx.currentTime + 0.08;
      // a real level change starts from quiet and waits for something to happen;
      // a rig being built for the first time inherits what the game already did
      if (!fresh) {
        rig.energy = 0;
        rig.on = false;
        rig.tier = 0;
        rig.rest = 0;
        rig.barsLeft = 0;
        rig.pokes.length = 0;
      }
      if (rig.delay) rig.delay.delayTime.value = clamp(rig.arr.stepDur * 3, 0.05, 1);
    }
    if (!rig.arr) {
      rig.arr = arrangement(eng.level || 1);
      rig.step = 0;
      rig.musicT0 = ctx.currentTime + 0.08;
    }
    applyMusicGain(eng);
  };

  // Browsers hand out a suspended AudioContext until they are good and ready
  // (a gesture, a visible page, a policy). Every gesture tries to start it, and
  // this retries politely until it takes: at most four times a second, and never
  // before the player has touched anything.
  let wakeT = 0;
  const wake = () => {
    if (!eng.gestured || ctx.state !== "suspended") return;
    const now = Date.now();
    if (now - wakeT < 250) return;
    wakeT = now;
    ctx.resume()?.catch?.(() => {});
  };
  eng.wake = wake;

  eng.sfx = (name, o = {}) => {
    record(name);
    const rig = eng.rig;
    if (!rig) return;
    const voice = SFX[name];
    if (!voice) return;
    wake();
    const spot = place(eng, o);
    if (spot.vol <= 0.004) return;
    voice(rig, o.at == null ? ctx.currentTime + 0.008 : Math.max(ctx.currentTime, o.at), { ...o, ...spot });
  };

  eng.setMuted = (v) => {
    eng.muted = !!v;
    saveMuted(eng.muted);
    if (eng.rig) {
      applyMute(eng);
      applyMusicGain(eng);
    }
  };
  eng.toggleMute = () => {
    eng.setMuted(!eng.muted);
    return eng.muted;
  };

  eng.stats = () => ({
    state: eng.rig ? ctx.state : "off",
    muted: eng.muted,
    level: eng.level,
    hunted: eng.hunted,
    runState: eng.runState,
    energy: Number((eng.rig ? eng.rig.energy : eng.energy).toFixed(3)),
    playing: eng.rig ? eng.rig.on : false,
    tier: eng.rig ? eng.rig.tier : 0,
    notes: eng.rig ? eng.rig.notes : 0,
    step: eng.rig ? eng.rig.step : 0,
    arr: eng.rig ? eng.rig.arr : null,
  });

  // the log is the one thing that works with and without a context: it is how
  // the smoke harness checks that the game asked for the right sounds
  eng.clear = () => {
    eng.log.length = 0;
    eng.energy = 0;
    if (eng.rig) {
      eng.rig.notes = 0;
      eng.rig.energy = 0;
    }
  };

  // loudest sample that left the mix in the last ~46ms, so a live run can be
  // checked for sound without ears
  eng.peak = () => {
    const rig = eng.rig;
    if (!rig || !rig.analyser) return 0;
    const buf = rig.peakBuf || (rig.peakBuf = new Float32Array(rig.analyser.fftSize));
    rig.analyser.getFloatTimeDomainData(buf);
    let peak = 0;
    for (let i = 0; i < buf.length; i++) {
      const a = buf[i] < 0 ? -buf[i] : buf[i];
      if (a > peak) peak = a;
    }
    return Number(peak.toFixed(4));
  };

  if (!ctx) return eng;

  /* ------------------------------------------------------------- the graph */
  const rig = {
    ctx,
    noise: noiseBuffer(ctx),
    notes: 0,
    step: 0,
    musicT0: 0,
    arr: null,
    hunted: eng.hunted,
    ducked: false,
    energy: eng.energy,
    on: false,
    tier: 0,
    rest: 0,
    barsLeft: 0,
    pokes: [],
  };
  {
    const master = ctx.createGain();
    master.gain.value = 0.0001;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.knee.value = 22;
    comp.ratio.value = 3.4;
    comp.attack.value = 0.006;
    comp.release.value = 0.25;

    const musicBus = ctx.createGain();
    musicBus.gain.value = MUSIC_VOL;
    const sfxBus = ctx.createGain();
    sfxBus.gain.value = SFX_VOL;

    const musicTone = ctx.createBiquadFilter();
    musicTone.type = "lowpass";
    musicTone.frequency.value = 3400;
    musicTone.Q.value = 0.4;

    const verb = ctx.createConvolver();
    verb.buffer = impulse(ctx);
    const verbOut = ctx.createGain();
    verbOut.gain.value = 1;
    const musicVerb = ctx.createGain();
    musicVerb.gain.value = 0.34;
    const sfxVerb = ctx.createGain();
    sfxVerb.gain.value = 0.16;

    // after the master, before the speakers: what actually leaves the mix, which
    // is what a test can read back when nobody can listen
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;

    const delay = ctx.createDelay(1);
    delay.delayTime.value = 0.3;
    const delayFb = ctx.createGain();
    delayFb.gain.value = 0.32;
    const delaySend = ctx.createGain();
    delaySend.gain.value = 0.16;
    const delayOut = ctx.createGain();
    delayOut.gain.value = 0.5;

    musicBus.connect(musicTone);
    musicTone.connect(comp);
    musicTone.connect(musicVerb);
    musicVerb.connect(verb);
    musicTone.connect(delaySend);
    delaySend.connect(delay);
    delay.connect(delayFb);
    delayFb.connect(delay);
    delay.connect(delayOut);
    delayOut.connect(comp);
    sfxBus.connect(comp);
    sfxBus.connect(sfxVerb);
    sfxVerb.connect(verb);
    verb.connect(verbOut);
    verbOut.connect(comp);
    comp.connect(master);
    master.connect(analyser);
    analyser.connect(ctx.destination);

    Object.assign(rig, { master, comp, musicBus, sfxBus, musicTone, verb, delay, delaySend, analyser });
    const now = ctx.currentTime;
    master.gain.setValueAtTime(0.0001, now);
    master.gain.exponentialRampToValueAtTime(eng.muted ? 0.0001 : MASTER_VOL, now + 0.6);
  }
  eng.rig = rig;

  eng.pumpTo = (until) => {
    let guard = 0;
    while (rig.arr && stepTime(rig, rig.step) < until && guard++ < 8192) {
      scheduleStep(rig, rig.step);
      rig.step++;
    }
  };
  // Offline contexts are driven by their renderer, so they must not start a
  // timer. The live one writes the next 160ms of score every 40ms.
  if (typeof ctx.startRendering !== "function" && typeof globalThis.setInterval === "function") {
    const timer = globalThis.setInterval(() => {
      try {
        if (!rig.arr) return;
        wake();
        if (ctx.state !== "running") return;
        eng.pumpTo(ctx.currentTime + LOOKAHEAD);
      } catch {
        /* a broken timer must never take the game down */
      }
    }, PUMP_MS);
    if (timer && typeof timer.unref === "function") timer.unref();
  }

  // if a level is already playing, restart the score now that we have a context
  if (eng.level) eng.music({ level: eng.level, state: eng.runState });
  return eng;
}

function place(eng, o) {
  if (o.x == null || o.z == null) return { vol: o.vol == null ? 1 : o.vol, pan: 0, muffle: 0 };
  const dx = o.x - eng.lx;
  const dz = o.z - eng.lz;
  const d = Math.hypot(dx, dz);
  let vol = d <= SFX_NEAR ? 1 : clamp01(1 - (d - SFX_NEAR) / (SFX_RANGE - SFX_NEAR));
  vol = vol * vol * (o.vol == null ? 1 : o.vol);
  const right = (dx * Math.cos(eng.lyaw) + dz * Math.sin(eng.lyaw)) / (d || 1);
  return { vol, pan: clamp(right, -1, 1), muffle: d > SFX_NEAR ? 400 + 14000 * vol ** 1.4 : 0 };
}

function applyMute(eng) {
  const ctx = eng.ctx;
  const now = ctx.currentTime;
  eng.rig.master.gain.cancelScheduledValues(now);
  eng.rig.master.gain.setTargetAtTime(eng.muted ? 0.0001 : MASTER_VOL, now, 0.05);
}

// The score's own level: out of the way while the run is over, gone entirely when
// the sound is off. Whether it is *playing* is a different matter - that is the
// sequencer's business (see barDecision).
function applyMusicGain(eng) {
  const rig = eng.rig;
  if (!rig) return;
  const now = eng.ctx.currentTime;
  const target = eng.muted ? 0.0001 : eng.runState === "playing" ? MUSIC_VOL : MUSIC_DUCK;
  rig.musicBus.gain.cancelScheduledValues(now);
  rig.musicBus.gain.setTargetAtTime(target, now, 0.2);
}

/* ----------------------------------------------------------- the singleton */
// No AudioContext is built until the player touches something: browsers refuse
// to start audio without a gesture, and building one early is a console warning
// for nothing.

function watchVisibility(eng) {
  try {
    if (!globalThis.document || !document.addEventListener) return;
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) eng.ctx.suspend?.()?.catch?.(() => {});
      else if (!eng.muted) eng.ctx.resume?.()?.catch?.(() => {});
    });
  } catch {
    /* no document: fine */
  }
}

function createGameAudio() {
  let eng = makeEngine({ ctx: null });

  const api = {
    get enabled() { return !!eng.rig; },
    get state() { return eng.rig ? eng.stats().state : "off"; },
    get muted() { return eng.muted; },
    get log() { return eng.log; },
    get energy() { return eng.stats().energy; },
    get level() { return eng.level; },
    get hunted() { return eng.hunted; },
    get arrangement() { return eng.level ? arrangement(eng.level) : null; },
    get context() { return eng.ctx; },   // for debugging from the console
    stats: () => eng.stats(),

    // Called from the first key or click: this is the gesture browsers want
    // before they let anything make a sound.
    unlock() {
      const live = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (typeof live !== "function") return false;
      try {
        if (!eng.rig) {
          // whatever the game did before the player touched anything is carried
          // over, energy included: the level-start phrase should still play
          const { level, runState, muted, hunted, energy } = eng;
          eng = makeEngine({ ctx: new live() });
          eng.level = level;
          eng.runState = runState;
          eng.hunted = hunted;
          eng.energy = energy;
          if (eng.rig) {
            eng.rig.hunted = hunted;
            eng.rig.energy = energy;
          }
          eng.muted = muted;
          if (eng.level) eng.music({ level: eng.level, state: runState });
          if (muted) applyMute(eng);
          watchVisibility(eng);
        }
        eng.gestured = true;
        // a context can come up suspended even here, and a gesture is the moment
        // the browser is most likely to let it start
        if (eng.ctx && eng.ctx.state === "suspended") eng.ctx.resume()?.catch?.(() => {});
        return true;
      } catch {
        eng = makeEngine({ ctx: null });
        return false;
      }
    },
    sfx: (name, o) => eng.sfx(name, o),
    listener: (x, z, yaw) => eng.listener(x, z, yaw),
    music: (o) => eng.music(o),
    hunt: (on) => eng.hunt(on),
    poke: (amount) => eng.poke(amount),
    setMuted: (v) => eng.setMuted(v),
    toggleMute: () => eng.toggleMute(),
    peak: () => eng.peak(),
    clear: () => eng.clear(),
  };
  return api;
}

export const gameAudio = createGameAudio();

/* -------------------------------------------------------------- measuring */
// An offline render of the real voices, so the test suite can prove that the
// score and every effect actually make noise, how loud they are, and that the
// pans and the distance falloff do what they claim.

function windowRms(buf, from, to) {
  const sr = buf.sampleRate;
  const a = Math.max(0, Math.floor(from * sr));
  const b = Math.min(buf.length, Math.floor(to * sr));
  const frames = Math.max(1, b - a);
  // a rough band split, so a change of character shows up as a number: one-pole
  // lowpass for the bottom, and whatever is left of the signal for the top
  const k = 1 - Math.exp((-2 * Math.PI * 250) / sr);
  let sumL = 0;
  let sumR = 0;
  let lowSum = 0;
  let highSum = 0;
  let peak = 0;
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const d = buf.getChannelData(ch);
    let sum = 0;
    let lp = 0;
    for (let i = a; i < b; i++) {
      const v = d[i];
      sum += v * v;
      lp += (v - lp) * k;
      lowSum += lp * lp;
      const hi = v - lp;
      highSum += hi * hi;
      const av = v < 0 ? -v : v;
      if (av > peak) peak = av;
    }
    if (ch === 0) sumL = sum;
    else sumR = sum;
  }
  const rmsL = Math.sqrt(sumL / frames);
  const rmsR = Math.sqrt(sumR / frames);
  return {
    rms: Number(((rmsL + rmsR) / 2).toFixed(5)),
    rmsL: Number(rmsL.toFixed(5)),
    rmsR: Number(rmsR.toFixed(5)),
    low: Number(Math.sqrt(lowSum / (frames * buf.numberOfChannels)).toFixed(5)),
    high: Number(Math.sqrt(highSum / (frames * buf.numberOfChannels)).toFixed(5)),
    peak: Number(peak.toFixed(4)),
    pan: Number(((rmsR - rmsL) / Math.max(1e-6, rmsR + rmsL)).toFixed(3)),
  };
}

export async function measure({
  seconds = 6, level = 1, hunted = false, sfx = [], spacing = 0.75, music = true,
  at = { x: 5, z: -3 }, pokes = [], slices = 0,
} = {}) {
  const OAC = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (typeof OAC !== "function") return { error: "no OfflineAudioContext here" };
  const rate = 44100;
  const ctx = new OAC(2, Math.ceil(rate * seconds), rate);
  const eng = makeEngine({ ctx });
  eng.listener(0, 0, 0);
  if (music) eng.music({ level, state: "playing" });
  eng.hunt(hunted);

  // scripted pokes, given in seconds, land on their own step: same code path as
  // the game poking the engine, just on a fixed timeline
  const arr = eng.rig.arr;
  if (arr) {
    for (const [t, amount] of pokes) {
      eng.rig.pokes.push([Math.max(0, Math.round(t / arr.stepDur)), amount]);
    }
    eng.rig.pokes.sort((a, b) => a[0] - b[0]);
  }

  const slots = [];
  sfx.forEach((entry, i) => {
    const name = typeof entry === "string" ? entry : entry.name;
    const label = (typeof entry === "object" && entry.label) || name;
    const spot = typeof entry === "object" && entry.at ? entry.at : at;
    const t = 0.7 + i * spacing;
    slots.push({ name, label, from: t, to: t + spacing });
    eng.sfx(name, { ...spot, at: t });
  });

  const end = 0.7 + sfx.length * spacing + 1.5;
  if (music) eng.pumpTo(Math.max(end, seconds));

  const buf = await ctx.startRendering();
  const windows = {};
  for (const s of slots) windows[s.label] = windowRms(buf, s.from, Math.min(s.to, seconds));

  // an optional second-by-second trace, which is how the "and then it goes quiet"
  // behaviour is checked
  const timeline = [];
  if (slices > 0) {
    for (let t = 0; t < seconds; t += slices) {
      const w = windowRms(buf, t, Math.min(seconds, t + slices));
      timeline.push({ t: Number(t.toFixed(2)), rms: w.rms });
    }
  }

  const rig = eng.rig;
  return {
    seconds,
    level,
    hunted,
    notes: rig.notes,
    steps: rig.step,
    arr: rig.arr,
    played: rig.barsLeft > 0 || rig.on,
    tier: rig.tier,
    energy: Number(rig.energy.toFixed(3)),
    overall: windowRms(buf, 0, seconds),
    windows,
    timeline,
  };
}
