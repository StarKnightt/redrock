/* Full frames of the landing burst, one per frame, plus a 3.5x crop on the
 * car — the same drive dustjudge.mjs makes, so the frame numbers line up.
 *
 * dustjudge's crops are 200x113 px of source, which is the right window when
 * the burst is around the car and useless when the camera is somewhere
 * unexpected. This keeps the whole frame so the composition can be read.
 *
 * Read-only.
 *
 *   node tools/dustframes.mjs [--seed 22] [--ramp 1] [--tag dustf] [--n 26]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEED = +flag('seed', 22);
const RAMP = +flag('ramp', 1);
const N = +flag('n', 26);
const TAG = flag('tag', `dustf${SEED}`);
const WANT = (flag('frames', '') || '').split(',').filter(Boolean).map(Number);

const outDir = path.join(ROOT, 'shots', TAG);
fs.mkdirSync(outDir, { recursive: true });
const save = (f, url) => fs.writeFileSync(path.join(outDir, f), Buffer.from(url.split(',')[1], 'base64'));

await run({ width: 1600, height: 900, hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0&ink=1` },
  async ({ page }) => {
  const n = await page.evaluate(() => { window.__game.setPaused(true); return window.__game.track.ramps.length; });
  const idx = Math.min(RAMP, n - 1);

  await page.evaluate((i) => {
    const g = window.__game, r = g.track.ramps[i];
    g.autopilot(true, 0.85);
    g.driveTo((r.pad0 - 60) / g.track.length, { runUp: 320, maxSec: 45 });
    const p = g.player;
    let k = 0;
    while (k++ < 900) { g.step(1 / 60); if (p.launched && p.sinceLaunch > 0.05 && !p.airborne) break; }
  }, idx);

  for (let f = 0; f <= N; f++) {
    const want = WANT.length === 0 || WANT.includes(f);
    const out = await page.evaluate((want) => {
      const g = window.__game;
      g.setPaused(true);
      g.renderOnce();
      const cv = g.renderer.domElement, w = cv.width, h = cv.height;
      let full = null, crop = null;
      if (want) {
        full = cv.toDataURL('image/png');
        const c = document.createElement('canvas');
        const bw = 700, bh = 394, sw = bw / 3.5, sh = bh / 3.5;
        const q = g.player.pos.clone().project(g.camera);
        const cx = (q.x * 0.5 + 0.5) * w, cy = (-q.y * 0.5 + 0.5) * h;
        c.width = bw; c.height = bh;
        const ctx = c.getContext('2d');
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(cv, Math.max(0, Math.min(w - sw, cx - sw / 2)),
          Math.max(0, Math.min(h - sh, cy - sh / 2)), sw, sh, 0, 0, bw, bh);
        crop = c.toDataURL('image/png');
      }
      const cp = g.camera.position;
      const d = Math.hypot(cp.x - g.player.pos.x, cp.y - g.player.pos.y, cp.z - g.player.pos.z);
      /* Burst age, straight off the pool. This tool unpauses at the end of one
         round trip and pauses at the start of the next, so the game's own loop
         runs free in between and a "frame" here is worth however many sim
         steps the round trip took. Reporting the true age alongside the frame
         index is the only way to know what this tool's frame axis is actually
         measuring, and it is why the age column must never be dropped.

         This is a screenshot tool, so the loose frame axis costs it nothing.
         Do not copy the stepping: dustjudge.mjs used to share it and reported
         durations off it, which made its "frames" worth 3-4 sixtieths each.
         dustjudge.mjs and dustlife.mjs now keep the whole sweep inside one
         evaluate, and they are the tools to trust for duration. */
      const pool = g.effects.particles;
      let age = 0;
      for (let i = 0; i < pool.max; i++) {
        if (pool.active[i] && pool.kind[i] > 3.5) age = Math.max(age, pool.ages[i]);
      }
      g.setPaused(false);
      g.step(1 / 60);
      return { full, crop, camDist: +d.toFixed(2), age: +age.toFixed(3) };
    }, want);
    if (out.full) save(`f${String(f).padStart(2, '0')}.png`, out.full);
    if (out.crop) save(`f${String(f).padStart(2, '0')}-crop.png`, out.crop);
    console.log(`  frame ${String(f).padStart(2)}  camera ${out.camDist} m from car`
      + `  burst age ${out.age.toFixed(3)}`);
  }
  console.log(`  → shots/${TAG}`);
});

finish(process.exitCode || 0);
