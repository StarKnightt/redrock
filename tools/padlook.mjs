/* Close-range look at the markings themselves, and what colour they are.
 *
 * The approach ladder says the pad is a few pixels at range. This answers the
 * other half: at the range where it IS resolvable, what is actually drawn —
 * the pad strip, the pad chevrons, the ramp-face chevrons and the lip stripe —
 * and what colours come back out of the finished frame.
 *
 * Every frame goes through g.pipeline.render(). Pixels are read back from the
 * same drawing buffer in the same task.
 *
 *   node tools/padlook.mjs [--seed 22] [--ramp 1]
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
const TAG = flag('tag', `padlook${SEED}`);
const W = 1600, H = 900;

const outDir = path.join(ROOT, 'shots', TAG);
fs.mkdirSync(outDir, { recursive: true });
const save = (f, url) => fs.writeFileSync(path.join(outDir, f), Buffer.from(url.split(',')[1], 'base64'));

await run({ width: W, height: H, hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0` },
  async ({ page }) => {
  const sites = await page.evaluate(() => {
    const g = window.__game; g.setPaused(true);
    return g.track.ramps.map(r => ({ lip: r.lip, foot: r.foot, pad0: r.pad0, pad1: r.pad1 }));
  });
  const r = sites[Math.min(RAMP, sites.length - 1)];

  /* Two viewpoints, both from a moving car so the pipeline sees what it sees
     in play: one with the pad filling the near road, one with the whole ramp
     face and its lip in the middle distance. */
  for (const [name, at, look] of [
    ['pad-12m', r.pad0 - 12, r.pad0 + 3],
    ['ramp-30m', r.foot - 30, r.foot + 12],
    ['lip-15m', r.foot - 4, r.lip],
  ]) {
    const out = await page.evaluate(([target, lookS, W, H]) => {
      const g = window.__game, p = g.player, track = g.track;
      g.autopilot(true, 0.85);
      g.driveTo((target - 60) / track.length, { runUp: 300, maxSec: 45 });
      let n = 0;
      while (p.s < target && n++ < 600) g.step(1 / 60);
      g.setPaused(true);
      g.renderOnce();
      const src = g.renderer.domElement;
      const full = src.toDataURL('image/png');

      /* Where the marking lands on screen, then the pixels there. */
      const f = track.frameAt(lookS);
      const v = f.pos.clone().addScaledVector(f.up, 0.05 + track.rampHeight(lookS, 0));
      const q = v.clone().project(g.camera);
      const cx = Math.round((q.x * 0.5 + 0.5) * src.width);
      const cy = Math.round((-q.y * 0.5 + 0.5) * src.height);

      const box = 560, bw = Math.min(src.width, box), bh = Math.round(bw * 9 / 16);
      const x0 = Math.max(0, Math.min(src.width - bw, cx - bw / 2));
      const y0 = Math.max(0, Math.min(src.height - bh, cy - bh / 2));
      const c = document.createElement('canvas');
      c.width = bw * 2; c.height = bh * 2;
      const ctx = c.getContext('2d');
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(src, x0, y0, bw, bh, 0, 0, c.width, c.height);
      const crop = c.toDataURL('image/png');

      /* Colour census of the crop region: quantised buckets, most common
         first. The cel ladder means a correct frame has very few of them. */
      const rd = document.createElement('canvas');
      rd.width = bw; rd.height = bh;
      const rc = rd.getContext('2d');
      rc.drawImage(src, x0, y0, bw, bh, 0, 0, bw, bh);
      const px = rc.getImageData(0, 0, bw, bh).data;
      const hist = new Map();
      let dark = 0, warm = 0, total = 0;
      for (let i = 0; i < px.length; i += 4) {
        const R = px[i], G = px[i + 1], B = px[i + 2];
        total++;
        const lum = (0.2126 * R + 0.7152 * G + 0.0722 * B) / 255;
        if (lum < 0.16) dark++;
        // "warm" = the yellow/red half of the wheel, well clear of neutral.
        const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
        if (mx - mn > 40 && R === mx && B === mn) warm++;
        const k = `${R >> 4},${G >> 4},${B >> 4}`;
        hist.set(k, (hist.get(k) || 0) + 1);
      }
      const top = [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
        .map(([k, n]) => {
          const [a, b2, c2] = k.split(',').map(Number);
          return { hex: '#' + [(a << 4) + 8, (b2 << 4) + 8, (c2 << 4) + 8]
            .map(v => v.toString(16).padStart(2, '0')).join(''), pct: +(n / total * 100).toFixed(1) };
        });
      g.setPaused(false);
      g.autopilot(false);
      return {
        s: +p.s.toFixed(0), kmh: +p.kmh.toFixed(0), cx, cy,
        buckets: hist.size, top,
        inkPct: +(dark / total * 100).toFixed(2),
        warmPct: +(warm / total * 100).toFixed(2),
        full, crop,
      };
    }, [at, look, W, H]);
    save(`${name}.png`, out.full);
    save(`${name}-crop.png`, out.crop);
    console.log(`  ${name.padEnd(9)} s ${out.s} ${out.kmh} km/h  marking at (${out.cx},${out.cy})`
      + `  ${out.buckets} colour buckets  ink ${out.inkPct}%  warm(red/yellow) ${out.warmPct}%`);
    console.log(`      top: ${out.top.map(t => `${t.hex} ${t.pct}%`).join('  ')}`);
  }
});

console.log(`  → shots/${TAG}`);
finish(process.exitCode || 0);
