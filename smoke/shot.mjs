// Render one frame of the game in headless Chrome and write it to a PNG.
// Headless --screenshot cannot composite WebGL, so the page reads the canvas
// back with toDataURL() and this script decodes it.
//
//   node smoke/shot.mjs [outfile] [extraQuery] [fitWidth]
//
// Needs the dev server running:  python3 -m http.server 8000 --bind 127.0.0.1
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const out = resolve(process.argv[2] || "smoke/out/shot.png");
const extra = process.argv[3] || "";
const size = process.argv[4] || "960,600";

const url = `http://127.0.0.1:8000/smoke/browser.html?data=1${extra}`;

const dom = execFileSync(
  CHROME,
  [
    "--headless=new",
    "--enable-unsafe-swiftshader",
    "--no-sandbox",
    `--window-size=${size}`,
    "--virtual-time-budget=9000",
    "--dump-dom",
    url,
  ],
  { encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "ignore"] }
);

const match = dom.match(/id="shot"[^>]*>([^<]*)</);
if (!match) {
  console.error("No canvas readback found — the page probably threw. Dumping probe:");
  console.error(dom.match(/id="probe">([^<]*)</)?.[1] ?? dom.slice(-800));
  process.exit(1);
}

const base64 = match[1].trim().replace(/^data:image\/png;base64,/, "");
if (base64.length < 100) {
  console.error("Canvas readback is empty.");
  process.exit(1);
}

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, Buffer.from(base64, "base64"));
console.log(`${out}  (${(base64.length / 1365).toFixed(0)} KB)`);
