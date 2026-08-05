/* Proof shots of the HUD, standalone.
 *
 * The overlay is pure 2D canvas, so unlike shoot.mjs this never needs the GL
 * scene or the GPU flags — plain headless Chromium is enough and cheap. The
 * page (tools/hud.html) exposes window.__hud.shoot(), which sizes the canvas,
 * settles the needle spring against the requested state and hands back a PNG
 * of the backing store — so a dpr-2 shot really is 2x pixels, whatever the
 * browser context thinks its scale factor is.
 *
 *   node tools/hud.mjs
 */
import { chromium } from 'playwright';
import './tame.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from './harness.mjs';
import { guard, finish } from './tame.mjs';
import { checkAsync } from './check.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(ROOT, 'shots', 'hud');

const STATES = {
  start: {
    speed: 0, rpm: 0.06, gear: 0, position: 1, fieldSize: 4,
    time: 0, progress: 0, delta: null, finished: false,
  },
  mid: {
    speed: 143 / 3.6, rpm: 0.72, gear: 3, position: 2, fieldSize: 4,
    time: 154.327, progress: 0.5, delta: 1.2, finished: false,
  },
  fast: {
    speed: 186 / 3.6, rpm: 0.93, gear: 5, position: 1, fieldSize: 4,
    time: 297.481, progress: 0.94, delta: -0.85, finished: false,
  },
};

const SHOTS = [
  ['start-1920', 1920, 1080, 1, 'start'],
  ['mid-1920', 1920, 1080, 1, 'mid'],
  ['fast-1920', 1920, 1080, 1, 'fast'],
  ['mid-1280', 1280, 720, 1, 'mid'],
  ['mid-2560', 2560, 1440, 1, 'mid'],
  ['mid-ultrawide', 2560, 1080, 1, 'mid'],
  ['mid-1280-dpr2', 1280, 720, 2, 'mid'],
];

const bad = await checkAsync();
if (bad.length) {
  console.error('✗ parse errors — not launching a browser:\n' + bad.join('\n'));
  finish(1);
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const srv = serve();
await new Promise(r => srv.listen(0, r));
const url = `http://localhost:${srv.address().port}/tools/hud.html`;

const browser = guard(await chromium.launch({ headless: true }));
guard(srv);

const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const errs = [];
page.on('pageerror', e => errs.push('[pageerror] ' + (e.stack || e.message || e)));
page.on('console', m => { if (m.type() === 'error') errs.push('[console] ' + m.text()); });

console.log(`→ ${url}`);
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__hud, null, { timeout: 20_000 });

for (const [name, w, h, dpr, stateKey] of SHOTS) {
  const data = await page.evaluate(
    ({ w, h, dpr, state }) => window.__hud.shoot(w, h, dpr, state),
    { w, h, dpr, state: STATES[stateKey] });
  const file = path.join(outDir, name + '.png');
  fs.writeFileSync(file, Buffer.from(data.split(',')[1], 'base64'));
  console.log(`  ${name}.png  ${w * dpr}x${h * dpr}  (${stateKey})`);
}

/* Per-frame cost, measured where it matters: update + draw at the real dpr,
   averaged over enough frames that the timer's 5 us granularity is noise. */
const cost = await page.evaluate(() => {
  const { hud } = window.__hud;
  hud.resize(1920, 1080, 1);
  const st = {
    speed: 40, rpm: 0.7, gear: 3, position: 2, fieldSize: 4,
    time: 154.327, progress: 0.5, delta: 1.2, finished: false,
  };
  const N = 300;
  const t0 = performance.now();
  for (let i = 0; i < N; i++) {
    st.time += 1 / 60;
    hud.update(1 / 60, st);
    hud.draw();
  }
  return (performance.now() - t0) / N;
});
console.log(`\n  per-frame update+draw: ${cost.toFixed(3)} ms at 1920x1080`);

if (errs.length) {
  console.log('\n─── page errors ───');
  [...new Set(errs)].forEach(e => console.log(' ', e));
}
console.log(`  → shots/hud`);
if (errs.length) process.exitCode = 1;
finish(process.exitCode || 0);
