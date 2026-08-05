/* Which class is painting the pale lumps at the tail of a landing.
 *
 * The report this was written for says the burst "breaks into 8-11 discrete
 * pale shapes" in its last three to five frames. b5burst counts 14, 16 and 10
 * islands over exactly those frames — on the WHOLE-POOL mask, which is every
 * particle the pool owns. This decomposes that mask by kind, so the count is
 * attributed rather than assumed, and dumps a colour-coded overlay so the
 * attribution can be looked at.
 *
 * One diff per kind bucket, each against the same pinned clock, with frame 0
 * of the run discarded. 1600x900 through g.pipeline.render().
 *
 *   node tools/z9who.mjs [--seeds 22,40] [--n 20] [--from 12] [--tag base]
 */
import fs from 'node:fs';
import path from 'node:path';
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEEDS = flag('seeds', '22,40').split(',').map(Number);
const RAMP = +flag('ramp', 1);
const N = +flag('n', 20);
const FROM = +flag('from', 12);
const FLOOR = +flag('floor', 90);
const TAG = flag('tag', 'base');

for (const SEED of SEEDS) {
  await run({ width: 1600, height: 900, hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0&ink=1` },
    async ({ page }) => {
      const out = await page.evaluate(([ramp, frames, from, floor]) => {
        const g = window.__game, p = g.player;
        const pool = g.effects.particles;
        const cv = g.renderer.domElement, w = cv.width, h = cv.height;
        const tmp = document.createElement('canvas');
        tmp.width = w; tmp.height = h;
        const tc = tmp.getContext('2d', { willReadFrequently: true });
        const grab = () => { g.renderOnce(); tc.drawImage(cv, 0, 0); return tc.getImageData(0, 0, w, h).data; };
        const real = performance.now.bind(performance);

        /* The buckets are the file's own kind bands, not arbitrary cuts:
           the veil, the drift filler, the soft dust, thrown chunks, the speed
           wake, and the landing burst's puffs. */
        const BUCKETS = [
          ['veil', 0.02, 0.10, [255, 60, 60]],
          ['drift', 0.10, 0.35, [255, 190, 40]],
          ['soft', 0.35, 0.50, [60, 255, 90]],
          ['puff', -1, 0.02, [40, 200, 255]],
          ['chunk', 0.5, 1.5, [200, 60, 255]],
          ['streak', 1.5, 2.5, [255, 255, 255]],
          ['burst', 4.5, 99, [255, 0, 200]],
        ];

        const hideBand = (lo, hi) => {
          const kept = [];
          for (let i = 0; i < pool.max; i++) {
            const k = pool.kind[i];
            if (!(k > lo && k <= hi)) continue;
            kept.push([i, pool.scales[i * 2], pool.scales[i * 2 + 1]]);
            pool.scales[i * 2] = pool.scales[i * 2 + 1] = 0;
          }
          pool.scaleAttr.needsUpdate = true;
          const img = grab();
          for (const [i, sx, sy] of kept) { pool.scales[i * 2] = sx; pool.scales[i * 2 + 1] = sy; }
          pool.scaleAttr.needsUpdate = true;
          return img;
        };

        const seen = new Uint8Array(w * h);
        const stack = new Int32Array(w * h);
        const label = (mask) => {
          seen.fill(0);
          const areas = [];
          for (let q = 0; q < mask.length; q++) {
            if (!mask[q] || seen[q]) continue;
            let sp = 0, area = 0;
            stack[sp++] = q; seen[q] = 1;
            while (sp) {
              const c = stack[--sp];
              const x = c % w, y = (c / w) | 0;
              area++;
              if (x > 0 && mask[c - 1] && !seen[c - 1]) { seen[c - 1] = 1; stack[sp++] = c - 1; }
              if (x < w - 1 && mask[c + 1] && !seen[c + 1]) { seen[c + 1] = 1; stack[sp++] = c + 1; }
              if (y > 0 && mask[c - w] && !seen[c - w]) { seen[c - w] = 1; stack[sp++] = c - w; }
              if (y < h - 1 && mask[c + w] && !seen[c + w]) { seen[c + w] = 1; stack[sp++] = c + w; }
            }
            if (area >= floor) areas.push(area);
          }
          areas.sort((a, b) => b - a);
          return areas;
        };

        const lum = (d, q) => 0.2126 * d[q] + 0.7152 * d[q + 1] + 0.0722 * d[q + 2];

        g.setPaused(true);
        if (g.race?.entries) g.race.entries.length = 0;
        for (let i = 0; i < pool.max; i++) {
          pool.active[i] = 0; pool.scales[i * 2] = pool.scales[i * 2 + 1] = 0;
        }
        pool.live = 0; pool.cursor = 0; pool._resetRandom();

        const r = g.track.ramps[Math.min(ramp, g.track.ramps.length - 1)];
        g.autopilot(true, 0.85);
        g.driveTo((r.pad0 - 60) / g.track.length, { runUp: 320, maxSec: 45 });
        let k = 0, wasAir = false;
        while (k++ < 900) { g.step(1 / 60); if (p.airborne) wasAir = true; if (wasAir && !p.airborne) break; }

        const rows = [];
        for (let f = 0; f < frames; f++) {
          g.setPaused(true);
          const t = real(); performance.now = () => t;
          const shown = grab();
          const shots = BUCKETS.map(([, lo, hi]) => hideBand(lo, hi));
          pool.mesh.visible = false;
          const bare = grab();
          pool.mesh.visible = true;
          performance.now = real;

          const overlay = new Uint8ClampedArray(shown);
          const per = [];
          const mask = new Uint8Array(w * h);
          BUCKETS.forEach(([name, , , rgb], bi) => {
            const alt = shots[bi];
            mask.fill(0);
            let px = 0, pale = 0, liftSum = 0;
            for (let q = 0, c = 0; q < shown.length; q += 4, c++) {
              if (Math.abs(shown[q] - alt[q]) + Math.abs(shown[q + 1] - alt[q + 1])
                + Math.abs(shown[q + 2] - alt[q + 2]) <= 12) continue;
              mask[c] = 1; px++;
              const d = lum(shown, q) - lum(alt, q);
              liftSum += d;
              /* "Pale" is the reported defect's own word: brighter than what
                 it covers by a step the eye can see against a flat cel fill.
                 Eight of 255 is about 3%, which is roughly one rung of this
                 palette's own quantisation. */
              if (d > 8) {
                pale++;
                if (f >= from) {
                  overlay[q] = rgb[0]; overlay[q + 1] = rgb[1]; overlay[q + 2] = rgb[2];
                }
              }
            }
            const areas = label(mask);
            /* Islands of the PALE part only, which is what "the eye counts
               them" is a claim about. */
            for (let c = 0; c < mask.length; c++) {
              if (!mask[c]) continue;
              const q = c * 4;
              if (lum(shown, q) - lum(shots[bi], q) <= 8) mask[c] = 0;
            }
            const paleAreas = label(mask);
            per.push({
              name, px, pale,
              lift: px ? +(liftSum / px).toFixed(1) : 0,
              n: areas.length,
              nPale: paleAreas.length,
              big: areas.length ? +(areas[0] / areas.reduce((a, b) => a + b, 0) * 100).toFixed(0) : 0,
            });
          });
          /* And the whole pool at once, which is the mask b5burst's island
             column is actually computed on. */
          mask.fill(0);
          let poolPx = 0, poolPale = 0;
          for (let q = 0, c = 0; q < shown.length; q += 4, c++) {
            if (Math.abs(shown[q] - bare[q]) + Math.abs(shown[q + 1] - bare[q + 1])
              + Math.abs(shown[q + 2] - bare[q + 2]) <= 12) continue;
            mask[c] = 1; poolPx++;
            if (lum(shown, q) - lum(bare, q) > 8) poolPale++;
          }
          const poolAreas = label(mask);
          for (let c = 0; c < mask.length; c++) {
            if (!mask[c]) continue;
            const q = c * 4;
            if (lum(shown, q) - lum(bare, q) <= 8) mask[c] = 0;
          }
          const poolPaleAreas = label(mask);

          let url = null;
          if (f >= from) {
            const oc = document.createElement('canvas');
            oc.width = w; oc.height = h;
            const octx = oc.getContext('2d');
            octx.putImageData(new ImageData(overlay, w, h), 0, 0);
            url = oc.toDataURL('image/png');
          }
          rows.push({
            per, url,
            poolPx, poolPale, poolN: poolAreas.length, poolPaleN: poolPaleAreas.length,
          });
          g.setPaused(false);
          g.step(1 / 60);
        }
        g.autopilot(false);
        return { seed: g.track.seed, rows, names: BUCKETS.map(b => b[0]) };
      }, [RAMP, N, FROM, FLOOR]);

      const dir = path.join('shots', `z9who-${TAG}-${out.seed}`);
      fs.mkdirSync(dir, { recursive: true });
      out.rows.forEach((r, i) => {
        if (!r.url) return;
        fs.writeFileSync(path.join(dir, `f${String(i).padStart(2, '0')}.png`),
          Buffer.from(r.url.split(',')[1], 'base64'));
        delete r.url;
      });

      console.log(`\n  seed ${out.seed} — pale = the class is brighter than what it covers by >8/255`
        + `\n  (frame 0 is the driveTo artifact; islands floored at ${FLOOR} px)`);
      console.log('   frame | pool px/pale/isl/paleIsl | '
        + out.names.map(n => n.padStart(10)).join(' | '));
      out.rows.forEach((r, i) => {
        console.log(`   ${String(i).padStart(5)}${i === 0 ? '*' : ' '}|`
          + ` ${String(r.poolPx).padStart(6)}/${String(r.poolPale).padStart(6)}`
          + `/${String(r.poolN).padStart(3)}/${String(r.poolPaleN).padStart(3)} | `
          + r.per.map(b => `${String(b.pale).padStart(5)}px ${String(b.nPale).padStart(2)}i`
            .padStart(10)).join(' | '));
      });
    });
}

finish(process.exitCode || 0);
