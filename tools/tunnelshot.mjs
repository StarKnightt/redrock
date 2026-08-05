/* The tunnel, as pictures and as numbers.
 *
 * Drives the chase camera to stations named relative to the bore rather than
 * to absolute arc length, because the site is picked per seed and hard-coding
 * `--t 0.4787` only ever describes seed 22. Every frame also gets its value
 * histogram, so "dark but legible" is a spread and a modal-bucket percentage
 * rather than an impression.
 *
 *   node tools/tunnelshot.mjs [--seed 22] [--out tunnel] [--free]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, capture } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEED = flag('seed', '22');
const OUT = path.join(ROOT, 'shots', flag('out', 'tunnel'));
const FREE = args.includes('--free');

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

/* Offsets from the portals, in metres. Negative is before the entry mouth,
   values above the length are past the exit. */
const MARKS = [
  ['approach-160', -160], ['approach-90', -90], ['approach-45', -45],
  ['portal-12', -12], ['inside-a', 0.22], ['inside-b', 0.5], ['inside-c', 0.72],
  ['exit-55', 0.62], ['exit-30', 0.78], ['exit-12', 0.91], ['past-40', 40],
];

await run({
  width: 1024, height: 576,
  hash: `manual&tier=high&seed=${SEED}&cap=60&ink=1`,
}, async ({ page }) => {
  const span = await page.evaluate(() => window.__game.field.tunnel);
  if (!span) { console.log('  no tunnel on this seed'); return; }
  const trackLength = await page.evaluate(() => window.__game.track.length);
  const length = span.s1 - span.s0;
  console.log(`\n  seed ${SEED}  bore s${span.s0.toFixed(0)}-${span.s1.toFixed(0)}`
    + `  ${length.toFixed(0)} m  wall ${span.wall.toFixed(0)} m  bend ${span.bend.toFixed(1)} m\n`);
  console.log('  name              s      rung occupancy 0..7                       modal  spread');

  for (const [name, off] of MARKS) {
    const s = off > -1 && off < 1.001 ? span.s0 + length * off
      : off < 0 ? span.s0 + off : span.s1 + off;
    const out = await page.evaluate(async ([t, free]) => {
      const g = window.__game;
      g.driveTo(t);
      g.setPaused(true);
      if (free) {
        const f = g.track.frameAt(g.player.s);
        g.camera.position.set(f.pos.x, f.pos.y + 2.2, f.pos.z);
        const a = g.track.frameAt(Math.min(g.track.length - 1, g.player.s + 40));
        g.camera.lookAt(a.pos.x, a.pos.y + 2.2, a.pos.z);
        g.camera.updateMatrixWorld();
      }
      g.renderOnce();
      const cv = g.renderer.domElement;
      const w = cv.width, h = cv.height;
      const tmp = document.createElement('canvas');
      tmp.width = w; tmp.height = h;
      const ctx = tmp.getContext('2d');
      ctx.drawImage(cv, 0, 0);
      const px = ctx.getImageData(0, 0, w, h).data;
      const rungs = new Array(8).fill(0);
      let lo = 9, hi = -9, n = 0;
      for (let i = 0; i < px.length; i += 4) {
        const L = (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) / 255;
        rungs[Math.min(7, Math.floor(L * 8))]++;
        lo = Math.min(lo, L); hi = Math.max(hi, L); n++;
      }
      return { rungs: rungs.map(r => +(100 * r / n).toFixed(1)), lo: +lo.toFixed(3), hi: +hi.toFixed(3), s: g.player.s };
    }, [Math.max(0.0005, s / trackLength), FREE]);

    await capture(page, path.join(OUT, `${name}.png`));
    const modal = Math.max(...out.rungs);
    console.log(`  ${name.padEnd(14)} ${out.s.toFixed(0).padStart(5)}   `
      + out.rungs.map(v => String(v).padStart(5)).join('')
      + `   ${modal.toFixed(1).padStart(5)}%  ${out.lo.toFixed(2)}-${out.hi.toFixed(2)}`);
  }
  /* Mean frame brightness every few metres through both mouths. The brief's
     "must not strobe or pop" is a claim about the derivative of this curve,
     and eyeballing eleven stills cannot settle it. */
  const SWEEP = 3;
  console.log(`\n  brightness sweep (mean frame luma, step ${SWEEP} m)\n`);
  for (const [label, from, to] of [
    ['entry', span.s0 - 45, span.s0 + 45],
    ['exit', span.s1 - 45, span.s1 + 45],
  ]) {
    const row = [];
    for (let s = from; s <= to; s += SWEEP) {
      row.push(await page.evaluate(async t => {
        const g = window.__game;
        g.driveTo(t);
        g.setPaused(true);
        g.renderOnce();
        const cv = g.renderer.domElement, w = cv.width, h = cv.height;
        const tmp = document.createElement('canvas');
        tmp.width = w; tmp.height = h;
        const ctx = tmp.getContext('2d');
        ctx.drawImage(cv, 0, 0);
        const px = ctx.getImageData(0, 0, w, h).data;
        let sum = 0;
        for (let i = 0; i < px.length; i += 4) {
          sum += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
        }
        return +(sum / (px.length / 4) / 255).toFixed(3);
      }, Math.max(0.0005, s / trackLength)));
    }
    let worst = 0;
    for (let i = 1; i < row.length; i++) worst = Math.max(worst, Math.abs(row[i] - row[i - 1]));
    console.log(`  ${label.padEnd(6)} ${row.join(' ')}`);
    /* Per frame is the number that decides whether this reads as a pop. A car
       at racing speed covers about half a metre a frame, so the worst sample
       gap divided by the sample spacing is the per-metre rate and half of it
       is the per-frame change. */
    console.log(`         worst ${worst.toFixed(3)} per ${SWEEP} m`
      + ` = ${(worst / SWEEP / 2).toFixed(4)} per frame at 30 m/s`);
  }

  console.log(`\n  → shots/${path.basename(OUT)}`);
});

finish(process.exitCode || 0);
