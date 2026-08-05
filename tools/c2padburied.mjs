/* Review probe (read-only): how much of the boost pad is under the road?
 *
 * A marking laid on a crowned road can lose pixels two ways and they look
 * alike from a distance: the road can shade it, or the road can occlude it.
 * They want opposite fixes, so the difference has to be measured rather than
 * eyeballed.
 *
 * The test is a two-render difference with the depth test taken off the pad's
 * own material and nothing else changed. With depth on, the pad draws only
 * where it is above the tarmac. With depth off, it draws everywhere it exists.
 * The shortfall is exactly the buried fraction — shading cannot move it,
 * because the same shader runs both times.
 *
 * Material state is restored before the tool returns; nothing under src/ is
 * touched and nothing is written except what is asked for.
 *
 * THE ANIMATION CLOCK IS PINNED across each station's three renders, and the
 * first grab after the drive-in is thrown away. Without those two this tool
 * counted swaying grass as pad: src/world/environment.js sets a shader
 * uniform from performance.now() inside onBeforeRender, so two renders of a
 * frozen scene are different images. Measured through tools/r3pad.mjs, which
 * runs byte-identical differencing code with a --nofreeze switch: unpinned,
 * two renders of an unchanged scene differ by 998 px² on average and a pad
 * lifted two metres into the air — where nothing whatever can occlude it —
 * scored 12.1% "buried". Pinned, eight of nine stations differ by exactly
 * 0 px and the floating pad falls to 2.7%. tools/r3pad.mjs remains the fuller
 * instrument; it adds a sunk-pad signal check this one has no equivalent of.
 *
 *   node tools/c2padburied.mjs [--seed 22] [--at 35,20,12]
 */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEEDS = flag('seeds', '22,40').split(',').map(Number);
const RUNGS = (flag('at', '40,25,14') || '').split(',').map(Number);

for (const SEED of SEEDS) {
  await run({ width: 1600, height: 900, hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0&ink=1` },
    async ({ page }) => {
      const out = await page.evaluate(([rungs]) => {
        const g = window.__game, p = g.player;
        const cv = g.renderer.domElement, w = cv.width, h = cv.height;
        const tmp = document.createElement('canvas');
        tmp.width = w; tmp.height = h;
        const tc = tmp.getContext('2d');
        const grab = () => { g.renderOnce(); tc.drawImage(cv, 0, 0); return tc.getImageData(0, 0, w, h).data; };
        const realNow = performance.now.bind(performance);

        const pad = g.scene.getObjectByName('ramp-pad');
        if (!pad) return { err: 'no mesh named ramp-pad' };
        const mats = Array.isArray(pad.material) ? pad.material : [pad.material];

        const area = (a, b) => {
          let n = 0;
          for (let q = 0; q < a.length; q += 4) {
            if (Math.abs(a[q] - b[q]) + Math.abs(a[q + 1] - b[q + 1])
              + Math.abs(a[q + 2] - b[q + 2]) > 12) n++;
          }
          return n;
        };

        g.setPaused(true);
        if (g.race?.entries) g.race.entries.length = 0;
        g.autopilot(true, 0.9);

        const rows = [];
        for (const r of g.track.ramps) {
          for (const d of rungs) {
            g.driveTo((r.pad0 - d) / g.track.length, { runUp: 340, maxSec: 45 });
            g.setPaused(true);
            const tPin = realNow(); performance.now = () => tPin;
            grab();                       // the drive-in artifact, discarded

            pad.visible = false;
            const bare = grab();
            pad.visible = true;
            const shownDepth = grab();

            const wasTest = mats.map(m => m.depthTest);
            const wasWrite = mats.map(m => m.depthWrite);
            mats.forEach(m => { m.depthTest = false; m.depthWrite = false; m.needsUpdate = true; });
            const shownFree = grab();
            mats.forEach((m, k) => { m.depthTest = wasTest[k]; m.depthWrite = wasWrite[k]; m.needsUpdate = true; });
            performance.now = realNow;

            const drawn = area(shownDepth, bare);
            const whole = area(shownFree, bare);
            rows.push({
              lip: r.lip, d,
              kmh: Math.round(p.speed * 3.6),
              drawn, whole,
              buried: whole ? +((1 - drawn / whole) * 100).toFixed(1) : 0,
            });
          }
        }
        g.autopilot(false);
        return { seed: g.track.seed, rows };
      }, [RUNGS]);

      if (out.err) { console.log('  ' + out.err); return; }
      console.log(`\n  seed ${out.seed} — boost pad, drawn vs whole`);
      console.log('     lip   m short   km/h   drawn px²   whole px²   buried');
      for (const r of out.rows) {
        console.log(`  ${String(r.lip).padStart(6)} ${String(r.d).padStart(9)}`
          + ` ${String(r.kmh).padStart(6)} ${String(r.drawn).padStart(11)}`
          + ` ${String(r.whole).padStart(11)} ${(r.buried + '%').padStart(8)}`);
      }
      const m = out.rows.reduce((a, r) => a + r.buried, 0) / (out.rows.length || 1);
      console.log(`  mean buried ${m.toFixed(1)}% over ${out.rows.length} readings`);
    });
}

finish(process.exitCode || 0);
