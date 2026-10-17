// Drive a real Chrome over the DevTools protocol with *trusted* key events.
//
// Synthetic KeyboardEvents (dispatchEvent) never touch the browser's own key
// handling, so they cannot reproduce a key that the browser swallows before the
// page sees it. Input.dispatchKeyEvent goes through the same path as a physical
// key press, which is what this checks:
//
//   node smoke/cdp.mjs                     # Space held + ArrowLeft
//   node smoke/cdp.mjs "ArrowLeft,Space"   # any order, comma separated
//
// Prints the key events the page received and the yaw swing of the craft.

import { spawn } from "node:child_process";
import { rmSync } from "node:fs";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9333;
const PROFILE = new URL("./.chrome-profile", import.meta.url).pathname;
// "headless" has no compositor, no focus ring and no scroll path, so it cannot
// reproduce everything a real window does. HEADFUL=1 opens a real window (parked
// off-screen so it does not steal focus) and drives that instead.
const HEADFUL = !!process.env.HEADFUL;
const GAME = "http://127.0.0.1:8000/index.html";

const KEYS = {
  Space: { key: " ", code: "Space", vk: 32, text: " " },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  KeyW: { key: "w", code: "KeyW", vk: 87 },
  KeyA: { key: "a", code: "KeyA", vk: 65 },
  KeyD: { key: "d", code: "KeyD", vk: 68 },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  ...(HEADFUL ? ["--window-position=-3000,-3000"] : ["--headless=new"]),
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROFILE}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--enable-unsafe-swiftshader",
  "--no-sandbox",
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
  return r.result.value;
};

await send("Page.enable");
await send("Runtime.enable");

// headless Chrome does not pump rAF without a compositor, so the game loop needs
// the same shim the browser smoke page uses. Installed before main.js loads.
await send("Page.addScriptToEvaluateOnNewDocument", {
  source: `
    (function () {
      window.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 16);
      window.cancelAnimationFrame = (h) => clearTimeout(h);
      window.__seen = [];
      addEventListener("keydown", (e) => window.__seen.push("down:" + (e.code || "?")), true);
      addEventListener("keyup", (e) => window.__seen.push("up:" + (e.code || "?")), true);
    })();
  `,
});

await send("Page.navigate", { url: GAME });
for (let i = 0; i < 100; i++) {
  if (await evaluate("!!window.UFO")) break;
  await sleep(100);
}
if (!(await evaluate("!!window.UFO"))) {
  console.log("FAILED: the game never booted");
  process.exit(1);
}
await sleep(400);
await evaluate("window.__seen.length = 0");
const yaw0 = await evaluate("UFO.yaw");

const sequence = (process.argv[2] || "Space,ArrowLeft").split(",").map((s) => s.trim()).filter(Boolean);
const keys = sequence.map((name) => {
  const k = KEYS[name];
  if (!k) throw new Error(`unknown key ${name}`);
  return k;
});

for (const k of keys) {
  await send("Input.dispatchKeyEvent", {
    type: k.text ? "keyDown" : "rawKeyDown",
    key: k.key, code: k.code,
    windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk,
    ...(k.text ? { text: k.text, unmodifiedText: k.text } : {}),
  });
  await sleep(120);
}

// Sample while everything is held: if a key is being swallowed, it either never
// reaches the held set or is dropped again straight away.
const track = [];
for (let i = 0; i < 5; i++) {
  await sleep(220);
  track.push(await evaluate(
    `(${JSON.stringify(sequence)}) + " => " + UFO.keys.length + " keys, heldArrow=" + UFO.keys.includes("ArrowLeft") + ", yaw=" + UFO.yaw.toFixed(3)`
  ));
}
const yaw1 = await evaluate("UFO.yaw");
const seen = await evaluate("window.__seen");
const state = await evaluate("JSON.stringify({ state: UFO.state, hp: UFO.hp, keys: UFO.keys, stuck: UFO.stuck })");

for (const k of [...keys].reverse()) {
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk });
}

console.log(`held: ${sequence.join(" + ")}`);
console.log(`events the page saw: ${JSON.stringify(seen)}`);
for (const line of track) console.log(`  ${line}`);
console.log(`yaw: ${yaw0.toFixed(3)} -> ${yaw1.toFixed(3)}  (dYaw ${(yaw1 - yaw0).toFixed(3)} rad)`);
console.log(`at the end: ${state}`);
console.log(yaw1 < yaw0 - 0.05 ? "RESULT: turned LEFT" : yaw1 > yaw0 + 0.05 ? "RESULT: turned RIGHT" : "RESULT: no turn");

ws.close();
process.exit(0);
