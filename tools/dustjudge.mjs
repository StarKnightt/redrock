/* The landing burst: air, or matter?
 *
 * Drives a real ramp landing and, on every frame of the burst's life, renders
 * the same frozen frame three ways through g.pipeline.render():
 *
 *   with particles + ink     what the player sees
 *   without particles        gives an exact plume mask by difference
 *   with particles, no ink   gives the ink the pass draws, by difference
 *
 * From those three: how much of the frame the plume covers, how many distinct
 * quantised values it contains (a cloud has some, a solid has one), and what
 * share of the plume's pixels the ink pass darkens — the number that ran
 * 0.1-1.8% on particles against 10-22% on world geometry when they last read
 * as pasted on.
 *
 * Nothing under src/ is touched. Read-only.
 *
 * THE FRAME COLUMN IS SIXTIETHS, and it was not always. This used to run one
 * page.evaluate per frame, ending each with `setPaused(false); step(1/60)`
 * and then returning to node — so the page's own rAF loop kept running across
 * the round trip and a "frame" here was worth three or four sim steps
 * depending on how the machine felt. Durations read off it were wrong by that
 * factor, and tools/dustlife.mjs exists partly because of it. The whole sweep
 * now runs inside a single evaluate, paused throughout, stepping exactly 1/60
 * — no rAF callback can fire during a synchronous evaluate, so every row is
 * one sixtieth after the last one and dustjudge and dustlife are on the same
 * clock.
 *
 * Two more things this had wrong, both of them house rules:
 *   - performance.now() is pinned across each measurement triple.
 *     src/world/environment.js sets a shader uniform from it inside
 *     onBeforeRender, so unpinned, the "with particles" and "without
 *     particles" renders differ by a frame of swaying grass and the plume
 *     mask picks the grass up.
 *   - frame 0 is the driveTo artifact — the first grab after a long drive
 *     carries edge pixels worth about a quarter of a per cent of frame — and
 *     is printed but excluded from the peak and the duration.
 *
 *   node tools/dustjudge.mjs [--seed 22] [--ramp 1]
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
const TAG = flag('tag', `dust${SEED}`);
const W = 1600, H = 900;

const outDir = path.join(ROOT, 'shots', TAG);
fs.mkdirSync(outDir, { recursive: true });
const save = (f, url) => fs.writeFileSync(path.join(outDir, f), Buffer.from(url.split(',')[1], 'base64'));

await run({ width: W, height: H, hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0&ink=1` },
  async ({ page }) => {
  const n = await page.evaluate(() => { window.__game.setPaused(true); return window.__game.track.ramps.length; });
  const idx = Math.min(RAMP, n - 1);

  const rows = await page.evaluate(([i, frames, shotAt]) => {
    const g = window.__game, r = g.track.ramps[i];
    const p = g.player;
    g.setPaused(true);
    g.autopilot(true, 0.85);
    g.driveTo((r.pad0 - 60) / g.track.length, { runUp: 320, maxSec: 45 });
    let k = 0;
    while (k++ < 900) { g.step(1 / 60); if (p.launched && p.sinceLaunch > 0.05 && !p.airborne) break; }

    const cv = g.renderer.domElement, w = cv.width, h = cv.height;
    const tmp = document.createElement('canvas');
    tmp.width = w; tmp.height = h;
    const tc = tmp.getContext('2d', { willReadFrequently: true });
    const grab = () => { g.renderOnce(); tc.drawImage(cv, 0, 0); return tc.getImageData(0, 0, w, h).data; };
    const real = performance.now.bind(performance);
    const mesh = g.effects.particles.mesh;
    const out = [];

    for (let f = 0; f < frames; f++) {
      const want = shotAt.includes(f);
      /* One clock for the whole triple. Without this the three renders are
         three different moments of grass and dust and the difference between
         them is weather rather than particles. */
      const t = real(); performance.now = () => t;
      const shown = grab();
      mesh.visible = false;
      const bare = grab();
      mesh.visible = true;
      g.pipeline.inkEnabled = false;
      const noink = grab();
      g.pipeline.inkEnabled = true;

      let plume = 0, inkPlume = 0, inkWorld = 0, world = 0;
      let y0 = h, y1 = 0, x0 = w, x1 = 0;
      const vals = new Map();
      for (let q = 0, px = 0; q < shown.length; q += 4, px++) {
        const dr = Math.abs(shown[q] - bare[q]) + Math.abs(shown[q + 1] - bare[q + 1])
          + Math.abs(shown[q + 2] - bare[q + 2]);
        const lumShown = 0.2126 * shown[q] + 0.7152 * shown[q + 1] + 0.0722 * shown[q + 2];
        const lumNoink = 0.2126 * noink[q] + 0.7152 * noink[q + 1] + 0.0722 * noink[q + 2];
        const inked = (lumNoink - lumShown) / 255 > 0.02;
        if (dr > 12) {
          plume++;
          if (inked) inkPlume++;
          const y = (px / w) | 0, x = px % w;
          if (y < y0) y0 = y; if (y > y1) y1 = y;
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          const key = `${shown[q] >> 3},${shown[q + 1] >> 3},${shown[q + 2] >> 3}`;
          vals.set(key, (vals.get(key) || 0) + 1);
        } else {
          world++;
          if (inked) inkWorld++;
        }
      }
      /* Only the buckets that are actually a share of the plume, so one
         stray antialiased pixel is not counted as a tone. */
      let tones = 0;
      for (const v of vals.values()) if (v / Math.max(plume, 1) > 0.02) tones++;

      let crop = null;
      if (want) {
        g.renderOnce();
        const c = document.createElement('canvas');
        const bw = 700, bh = 394;
        const q = p.pos.clone().project(g.camera);
        const cx = (q.x * 0.5 + 0.5) * w, cy = (-q.y * 0.5 + 0.5) * h;
        const sw = bw / 3.5, sh = bh / 3.5;
        c.width = bw; c.height = bh;
        const ctx = c.getContext('2d');
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(cv, Math.max(0, Math.min(w - sw, cx - sw / 2)),
          Math.max(0, Math.min(h - sh, cy - sh / 2)), sw, sh, 0, 0, bw, bh);
        crop = c.toDataURL('image/png');
      }
      performance.now = real;

      out.push({
        f,
        plumePct: +(plume / (w * h) * 100).toFixed(3),
        tones, plumePx: plume,
        inkPlume: +(plume ? inkPlume / plume * 100 : 0).toFixed(2),
        inkWorld: +(inkWorld / world * 100).toFixed(2),
        boxH: plume ? y1 - y0 : 0, boxW: plume ? x1 - x0 : 0,
        crop,
      });
      /* Exactly one sixtieth, and nothing else runs in between. */
      g.step(1 / 60);
    }
    g.autopilot(false);
    return out;
  }, [idx, 27, [0, 1, 2, 4, 7, 11, 16, 22]]);

  console.log('  frame   plume % of frame   values in plume   ink on plume   ink on world   plume height px');
  for (const out of rows) {
    if (out.crop) save(`f${String(out.f).padStart(2, '0')}.png`, out.crop);
    console.log(`  ${String(out.f).padStart(5)}${out.f === 0 ? '*' : ' '}  ${out.plumePct.toFixed(3).padStart(14)}`
      + ` ${String(out.tones).padStart(17)} ${(out.inkPlume.toFixed(2) + '%').padStart(14)}`
      + ` ${(out.inkWorld.toFixed(2) + '%').padStart(14)} ${String(out.boxH).padStart(16)}`);
  }
  /* Frame 0 out of every verdict: it is the drive-in artifact, it is edge
     pixels, and edges are where ink lives. */
  const live = rows.slice(1);
  const peak = live.reduce((a, b) => (b.plumePx > a.plumePx ? b : a), live[0]);
  const alive = live.filter(r => r.plumePx > peak.plumePx * 0.15).length;
  console.log('\n  * frame 0 is the driveTo artifact and is excluded from everything below.');
  console.log(`  peak plume ${peak.plumePct}% of frame at frame ${peak.f},`
    + ` ${peak.boxW}x${peak.boxH} px, ${peak.tones} tone(s)`);
  console.log(`  visible for ${alive} frames (${(alive / 60).toFixed(2)} s at 60 Hz)`
    + '  — true sixtieths: the sweep runs in one evaluate');
  console.log(`  ink on plume at peak ${peak.inkPlume}%  vs  ink on world ${peak.inkWorld}%`);
});

console.log(`  → shots/${TAG}`);
finish(process.exitCode || 0);
