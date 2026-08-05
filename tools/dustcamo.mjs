/* Does the road the dust lands on camouflage it?
 *
 * The wildflowers had this exact defect and it was settled with a measurement
 * rather than an opinion: the pale flower sat at luma 0.96, inside the dust's
 * own 0.79-0.93 band, and moved to a chromatic lilac-blue at 0.65. This does
 * the same measurement for the road surface under a ramp landing, which is
 * where the biggest dust curtain on the stage is thrown.
 *
 * Three renders of the same frozen landing frame through g.pipeline.render():
 *
 *   shown            particles + road, what the player sees
 *   bare             particles hidden  -> plume mask by difference
 *   bare, no road    road hidden too   -> road mask by difference
 *
 * From those: the plume's luma band, the road's luma distribution behind and
 * around it, and the share of road pixels sitting inside the plume's band —
 * which is the camouflage, as a number. Saturation is reported alongside,
 * because the flower fix worked by moving hue, not only value.
 *
 * Read-only. Nothing under src/ is touched and nothing is written.
 *
 *   node tools/dustcamo.mjs [--seed 22] [--ramp 1]
 */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEEDS = flag('seeds', flag('seed', '22')).split(',').map(Number);
const RAMP = +flag('ramp', 1);
const W = 1600, H = 900;

for (const SEED of SEEDS) {
  await run({ width: W, height: H, hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0&ink=1` },
    async ({ page }) => {
      const n = await page.evaluate(() => {
        window.__game.setPaused(true);
        return window.__game.track.ramps.length;
      });
      const idx = Math.min(RAMP, n - 1);

      /* A real landing, driven in by the AI at racing speed. */
      await page.evaluate((i) => {
        const g = window.__game, r = g.track.ramps[i];
        g.autopilot(true, 0.85);
        g.driveTo((r.pad0 - 60) / g.track.length, { runUp: 320, maxSec: 45 });
        const p = g.player;
        let k = 0;
        while (k++ < 1400) { g.step(1 / 60); if (p.launched && p.sinceLaunch > 0.05 && !p.airborne) break; }
      }, idx);

      /* The plume is only worth measuring at its peak, and the peak is a few
         frames after touchdown rather than on it. Stepped forward one frame at
         a time and the widest one kept. */
      const rows = [];
      for (let f = 0; f <= 10; f++) {
        const out = await page.evaluate(() => {
          const g = window.__game;
          const cv = g.renderer.domElement, w = cv.width, h = cv.height;
          const tmp = document.createElement('canvas');
          tmp.width = w; tmp.height = h;
          const tc = tmp.getContext('2d');
          const grab = () => { g.renderOnce(); tc.drawImage(cv, 0, 0); return tc.getImageData(0, 0, w, h).data; };
          const realNow = performance.now.bind(performance);

          const mesh = g.effects.particles.mesh;
          let road = null;
          g.scene.traverse(o => { if (o.isMesh && o.name === 'road') road = o; });

          g.setPaused(true);
          /* One clock for the three renders. The plume mask and the road mask
             are both taken by difference, so unpinned every swaying blade
             lands in one or the other — see src/world/environment.js, which
             sets a shader uniform from performance.now() in onBeforeRender.
             (This tool still crosses back into node once per frame, so its
             frame index is not exactly sixtieths. It reports no duration and
             no frame count — only the widest frame's colour statistics — so
             that costs it nothing. Do not add a duration column here without
             first moving the loop inside one evaluate, the way
             tools/dustlife.mjs and tools/dustjudge.mjs do.) */
          const tPin = realNow(); performance.now = () => tPin;
          const shown = grab();
          mesh.visible = false;
          const bare = grab();
          road.visible = false;
          const noroad = grab();
          road.visible = true;
          mesh.visible = true;
          performance.now = realNow;

          const lum = (a, i) => (0.2126 * a[i] + 0.7152 * a[i + 1] + 0.0722 * a[i + 2]) / 255;
          const sat = (a, i) => {
            const r = a[i] / 255, gg = a[i + 1] / 255, b = a[i + 2] / 255;
            const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b);
            return mx <= 1e-4 ? 0 : (mx - mn) / mx;
          };
          const plumeL = [], plumeS = [], roadL = [], roadS = [];
          for (let i = 0; i < shown.length; i += 4) {
            const dPlume = Math.abs(shown[i] - bare[i]) + Math.abs(shown[i + 1] - bare[i + 1])
              + Math.abs(shown[i + 2] - bare[i + 2]);
            if (dPlume > 12) { plumeL.push(lum(shown, i)); plumeS.push(sat(shown, i)); continue; }
            const dRoad = Math.abs(bare[i] - noroad[i]) + Math.abs(bare[i + 1] - noroad[i + 1])
              + Math.abs(bare[i + 2] - noroad[i + 2]);
            if (dRoad > 12) { roadL.push(lum(bare, i)); roadS.push(sat(bare, i)); }
          }
          g.setPaused(false);
          g.step(1 / 60);
          return { plumeL, plumeS, roadL, roadS };
        });
        rows.push(out);
      }

      const best = rows.reduce((a, b) => (b.plumeL.length > a.plumeL.length ? b : a), rows[0]);
      const pct = (a, q) => (a.length ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1,
        Math.floor(q * a.length))] : 0);
      const f3 = v => v.toFixed(3);

      const pl = best.plumeL, rl = best.roadL;
      const lo = pct(pl, 0.10), hi = pct(pl, 0.90);
      const inside = rl.filter(v => v >= lo && v <= hi).length;
      const bright = rl.filter(v => v >= lo).length;

      console.log(`\n  seed ${SEED} ramp ${idx}   plume ${pl.length} px, road ${rl.length} px`);
      console.log('              p10    p50    p90    mean sat');
      console.log(`  plume     ${f3(lo)}  ${f3(pct(pl, 0.5))}  ${f3(hi)}`
        + `    ${f3(best.plumeS.reduce((a, b) => a + b, 0) / Math.max(1, best.plumeS.length))}`);
      console.log(`  road      ${f3(pct(rl, 0.10))}  ${f3(pct(rl, 0.5))}  ${f3(pct(rl, 0.90))}`
        + `    ${f3(best.roadS.reduce((a, b) => a + b, 0) / Math.max(1, best.roadS.length))}`);
      console.log(`  road p99  ${f3(pct(rl, 0.99))}   road max ${f3(pct(rl, 0.999))}`);
      console.log(`  road pixels inside the plume's own luma band [${f3(lo)}..${f3(hi)}]:`
        + ` ${(inside / Math.max(1, rl.length) * 100).toFixed(2)}%`);
      console.log(`  road pixels at or above the plume's p10: `
        + `${(bright / Math.max(1, rl.length) * 100).toFixed(2)}%`);
    });
}

finish(process.exitCode || 0);
