// Render the game's score and every sound effect offline in a real browser and
// put numbers on them: this is how the audio layer is checked without anybody
// having to listen to it.
//
//   node smoke/audio.mjs            # table of measured levels
//   node smoke/audio.mjs --json     # the raw measurements
//
// The offline renders need real time, which is why this drives Chrome over the
// DevTools protocol instead of using --dump-dom with a virtual time budget: the
// virtual clock fast-forwards to the end of the budget while the audio thread is
// still rendering, so the page gets dumped mid-measurement.
//
// Needs the dev server running:  python3 -m http.server 8000 --bind 127.0.0.1
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9334;
const PROFILE = new URL("./.chrome-profile-audio", import.meta.url).pathname;
const BENCH = "http://127.0.0.1:8000/smoke/audio.html";
const JSON_ONLY = process.argv.includes("--json");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  "--headless=new",
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROFILE}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--enable-unsafe-swiftshader",
  "--no-sandbox",
  "--autoplay-policy=no-user-gesture-required",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--window-size=960,600",
  "about:blank",
], { stdio: "ignore" });

const cleanup = () => {
  try { chrome.kill("SIGKILL"); } catch {}
  try { rmSync(PROFILE, { recursive: true, force: true }); } catch {}
};
process.on("exit", cleanup);

async function target() {
  for (let i = 0; i < 100; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page");
      if (page) return page;
    } catch {}
    await sleep(100);
  }
  throw new Error("chrome never opened a debugging port");
}

const page = await target();
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let nextId = 1;
const pending = new Map();
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  if (msg.error) p.rej(new Error(msg.error.message));
  else p.res(msg.result);
};
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = nextId++;
  pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  }
  return r.result.value;
};

await send("Page.enable");
await send("Runtime.enable");
await send("Page.navigate", { url: BENCH });
for (let i = 0; i < 100; i++) {
  if (await evaluate("!!(window.BENCH && window.BENCH.ready)")) break;
  await sleep(100);
}
if (!(await evaluate("!!(window.BENCH && window.BENCH.ready)"))) {
  console.error("FAILED: the audio bench never loaded");
  cleanup();
  process.exit(1);
}

// Everything measured here, in one trip: the whole checklist for the sound.
const SPEC = `(async () => {
  const A = window.GAME_AUDIO;
  const measure = window.MEASURE;
  const names = ["shoot", "hit", "kill", "killShade", "enemyShot", "boom", "mineArm",
    "mineBeep", "hurt", "death", "exit", "levelUp", "rift", "shadeWake", "shadeCharge", "shadeCrash",
    "liftUp", "liftWarn", "liftFall", "liftLand", "wardenWake", "wardenShot"];
  const t0 = performance.now();

  // the render has to be long enough for the last sound in the list, or that one
  // measures as silence (which is exactly how liftLand was caught being cut off)
  const sfxSeconds = 0.7 + names.length * 1.4 + 2;
  const fx = await measure({ seconds: sfxSeconds, level: 1, music: false, sfx: names, spacing: 1.4 });
  const sfx = Object.fromEntries(Object.entries(fx.windows).map(([k, v]) => [k, { rms: v.rms, peak: v.peak }]));

  const scoreAt = async (level, hunted) => {
    const m = await measure({ seconds: 8, level, hunted, pokes: [[0, 1], [5, 1]] });
    return {
      rms: m.overall.rms, low: m.overall.low, high: m.overall.high,
      peak: m.overall.peak, notes: m.notes, steps: m.steps,
      bpm: m.arr.bpm, mode: m.arr.mode, root: +m.arr.root.toFixed(1),
      motif: m.arr.motif.map(([step, deg]) => step + ":" + deg).join(" "),
      layers: Object.entries(m.arr.layers).filter(([, v]) => v).map(([k]) => k).join("+"),
    };
  };
  const score = {
    l1: await scoreAt(1),
    l5: await scoreAt(5),
    l9: await scoreAt(9),
    l9hunted: await scoreAt(9, true),
  };

  // does it only play when something is happening, and does it stop again
  const kept = await measure({
    seconds: 26, level: 1, slices: 1,
    pokes: [[0, 1], [3, 1], [6, 1], [9, 1], [12, 1], [15, 1], [18, 1], [21, 1], [24, 1]],
  });
  const burst = await measure({ seconds: 26, level: 1, slices: 1, pokes: [[0, 1]] });
  const huntedOnly = await measure({ seconds: 14, level: 1, hunted: true, slices: 1 });
  const dynamics = { kept, burst, huntedOnly };

  // the same blip placed to the right, to the left, and far away
  const pan = await measure({
    seconds: 5, level: 1, music: false, spacing: 1.3,
    sfx: [
      { name: "mineBeep", label: "right", at: { x: 8, z: 0 } },
      { name: "mineBeep", label: "left", at: { x: -8, z: 0 } },
      { name: "mineBeep", label: "far", at: { x: 30, z: 0 } },
    ],
  });

  // and the mute switch has to silence the render
  A.setMuted(true);
  const quiet = await measure({ seconds: 8, level: 5, pokes: [[0, 1], [3, 1]] });
  A.setMuted(false);
  const loud = await measure({ seconds: 8, level: 5, pokes: [[0, 1], [3, 1]] });

  return JSON.stringify({
    ms: Math.round(performance.now() - t0),
    sfx, score, dynamics: dynamics, placement: pan.windows,
    mute: { muted: quiet.overall.rms, unmuted: loud.overall.rms },
  });
})()`;

const raw = await evaluate(SPEC);
const data = JSON.parse(raw);

/* ------------------------------------------------------------ the live half */
// The offline renders prove the voices make sound. This proves the *game* does:
// the real page, a real (trusted) key press to satisfy the autoplay policy, the
// score running on its own clock in real time, and the mixer's output measured
// at the master bus.
const GAME = "http://127.0.0.1:8000/index.html";
await send("Page.navigate", { url: GAME });
let booted = false;
for (let i = 0; i < 100; i++) {
  if (await evaluate("!!window.UFO")) { booted = true; break; }
  await sleep(100);
}
const live = { booted };
if (booted) {
  await evaluate("UFO.audio.setMuted(false)");
  live.beforeGesture = await evaluate("UFO.audio.state");
  live.level = await evaluate("UFO.audio.level");

  const tap = async (code, key, vk) => {
    await send("Input.dispatchKeyEvent", {
      type: "rawKeyDown", key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
    });
    await sleep(120);
    await send("Input.dispatchKeyEvent", {
      type: "keyUp", key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
    });
    await sleep(120);
  };

  // a couple of key presses (one to satisfy autoplay, one to shoot), then listen
  // to the master bus for a few seconds of real time
  await tap("KeyW", "w", 87);
  await tap("Space", " ", 32);
  live.peak = await evaluate(`(async () => {
    let peak = 0;
    const id = setInterval(() => { peak = Math.max(peak, UFO.audio.peak()); }, 10);
    await new Promise((r) => setTimeout(r, 5000));
    clearInterval(id);
    return peak;
  })()`);
  live.afterGesture = await evaluate("UFO.audio.state");
  live.scheduled = await evaluate("UFO.audio.stats().notes");
  live.steps = await evaluate("UFO.audio.stats().step");

  // and with the sound off the same window is silent
  live.mutedPeak = await evaluate(`(async () => {
    UFO.audio.setMuted(true);
    await new Promise((r) => setTimeout(r, 250));
    let peak = 0;
    const id = setInterval(() => { peak = Math.max(peak, UFO.audio.peak()); }, 10);
    await new Promise((r) => setTimeout(r, 800));
    clearInterval(id);
    UFO.audio.setMuted(false);
    return peak;
  })()`);

  // why a browser might have refused to start (headless pages count as hidden)
  live.why = JSON.parse(await evaluate(`JSON.stringify({
    visibility: document.visibilityState,
    focused: document.hasFocus(),
    everTouched: navigator.userActivation ? navigator.userActivation.hasBeenActive : null,
    rate: UFO.audio.context && UFO.audio.context.sampleRate,
  })`));
}

if (JSON_ONLY) {
  console.log(JSON.stringify({ ...data, live }, null, 2));
  ws.close();
  process.exit(0);
}

/* --------------------------------------------------------------- the report */
let fail = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  PASS " : "  FAIL ") + msg);
  if (!cond) fail++;
};

console.log(`offline renders took ${data.ms}ms\n`);

console.log("every sound makes noise (peak, and rms of its own window):");
for (const [name, v] of Object.entries(data.sfx)) {
  ok(v.peak > 0.04 && v.rms > 0.0005, `${name.padEnd(12)} peak ${v.peak.toFixed(3)}  rms ${v.rms.toFixed(4)}`);
}

console.log("\nthe lurker carries weight:");
ok(data.sfx.shadeCharge.peak > 0.3, `the lunge rolls in loud (peak ${data.sfx.shadeCharge.peak})`);
ok(data.sfx.shadeCrash.peak > 0.3, `and the crash lands as hard as a mine going off (peak ${data.sfx.shadeCrash.peak} vs boom ${data.sfx.boom.peak})`);

console.log("\nthe score, and it changes per level:");
const s = data.score;
ok(s.l1.rms > 0.005, `level 1 renders sound (rms ${s.l1.rms}, peak ${s.l1.peak})`);
ok(s.l1.notes > 20, `and schedules notes over 8s (${s.l1.notes} notes, ${s.l1.steps} steps)`);
ok(s.l1.bpm !== s.l5.bpm || s.l1.root !== s.l5.root, `level 5 is a different piece (${s.l1.bpm}bpm/${s.l1.mode} vs ${s.l5.bpm}bpm/${s.l5.mode})`);
ok(s.l9.bpm > s.l1.bpm, `and level 9 drives harder (${s.l1.bpm} -> ${s.l9.bpm} bpm)`);
ok(s.l1.layers !== s.l9.layers, `with more going on (${s.l1.layers} -> ${s.l9.layers})`);
ok(s.l1.motif !== s.l5.motif && s.l5.motif !== s.l9.motif && s.l1.motif !== s.l9.motif, `each level gets its own tune (${s.l1.motif} / ${s.l5.motif} / ${s.l9.motif})`);
ok(s.l9hunted.notes !== s.l9.notes, `the shade swaps layers rather than adding them (${s.l9.notes} -> ${s.l9hunted.notes} notes)`);
ok(s.l9hunted.low > s.l9.low * 1.02, `a deep drone comes in under it (low ${s.l9.low} -> ${s.l9hunted.low})`);
ok(s.l9hunted.rms > s.l9.rms * 1.02, `and the mix measurably changes (rms ${s.l9.rms} -> ${s.l9hunted.rms})`);
for (const [k, v] of Object.entries(s)) {
  console.log(`  info: ${k.padEnd(9)} ${v.bpm}bpm ${v.mode.padEnd(8)} root ${v.root}Hz  rms ${v.rms} (low ${v.low} high ${v.high})  notes ${v.notes}\n        layers ${v.layers}\n        motif  ${v.motif}`);
}

console.log("\nthe score only plays when something is happening:");
const sliceAt = (t, tl) => (tl.find((x) => x.t === t) || {}).rms || 0;
const loudUntil = (tl) => tl.reduce((last, x) => (x.rms > 0.002 ? x.t : last), -1);
const dyn = data.dynamics;

ok(sliceAt(1, dyn.burst.timeline) > 0.003, `one thing happening and the music comes in (rms ${sliceAt(1, dyn.burst.timeline)} at 1s)`);
ok(dyn.burst.notes > 40, `it plays a phrase for it (${dyn.burst.notes} voices)`);
ok(loudUntil(dyn.burst.timeline) < 21, `and then stops of its own accord (last sound at ${loudUntil(dyn.burst.timeline)}s)`);
ok(sliceAt(25, dyn.burst.timeline) < 0.001, `leaving the level properly quiet (rms ${sliceAt(25, dyn.burst.timeline)} at 25s)`);
ok(sliceAt(25, dyn.kept.timeline) > 0.002, `keep poking it and it keeps playing (rms ${sliceAt(25, dyn.kept.timeline)} at 25s)`);
ok(sliceAt(5, dyn.huntedOnly.timeline) > 0.003 && sliceAt(13, dyn.huntedOnly.timeline) > 0.003, `and the shade awake holds it on with no action at all (rms ${sliceAt(13, dyn.huntedOnly.timeline)} at 13s)`);
console.log(`  info: one poke -> music until ${loudUntil(dyn.burst.timeline)}s, then silence`);
console.log(`  info: poked every 3s -> rms ${sliceAt(25, dyn.kept.timeline)} at 25s`);
console.log(`  info: hunted, no pokes -> rms ${sliceAt(3, dyn.huntedOnly.timeline)} / ${sliceAt(8, dyn.huntedOnly.timeline)} / ${sliceAt(13, dyn.huntedOnly.timeline)} at 3/8/13s`);

console.log("\nplacement:");
const p = data.placement;
ok(p.right.pan > 0.2, `a sound to the right leans right (pan ${p.right.pan})`);
ok(p.left.pan < -0.2, `and one to the left leans left (pan ${p.left.pan})`);
ok(p.far.rms < p.right.rms * 0.6, `and 30 units away is much quieter (${p.far.rms} vs ${p.right.rms})`);

console.log("\nthe mute switch:");
ok(data.mute.muted < data.mute.unmuted * 0.05, `muted renders are silent (${data.mute.muted} vs ${data.mute.unmuted})`);
ok(data.mute.unmuted > 0.005, "and unmuted ones are not");

console.log("\nthe real game, in real time:");
ok(live.booted, "the game boots in a real browser");
if (live.booted) {
  ok(live.beforeGesture === "off", `nothing is running before the player touches anything (${live.beforeGesture})`);
  ok(live.level === 1, `and the score knows the level (${live.level})`);
  ok(live.peak > 0.01, `a key press gets sound out of the master bus (peak ${live.peak})`);
  ok(live.afterGesture === "running", `the context is running by then (${live.afterGesture})`);
  ok(live.steps > 10, `the score advances on its own clock (${live.steps} steps, ${live.scheduled} voices)`);
  ok(live.mutedPeak < 0.005, `and the mute leaves the bus silent (peak ${live.mutedPeak})`);
  console.log(`  info: page ${live.why.visibility}, focus ${live.why.focused}, touched ${live.why.everTouched}, ${live.why.rate}Hz`);
}

ws.close();
console.log(fail ? `\n${fail} AUDIO CHECK(S) FAILED` : "\nALL AUDIO CHECKS PASSED");
cleanup();
process.exit(fail ? 1 : 0);
