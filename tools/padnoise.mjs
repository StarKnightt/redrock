/* The noise floor of the buried-pixel test.
 *
 * c2padburied.mjs measures the pad by differencing two renders and counting
 * pixels that changed. That is only valid if nothing else changes between them,
 * and this stage has grass that sways, birds that fly and dust that drifts. So
 * before believing any percentage it reports, it is worth knowing what it
 * reports when the answer is known.
 *
 * Three readings per station, all with the identical differencing code:
 *
 *   still      two renders with nothing whatever changed, differenced against
 *              each other. Anything above zero here is animation, not geometry.
 *   pad        the real measurement: pad hidden, pad shown, pad shown with the
 *              depth test off.
 *   floating   the same measurement with the pad translated two metres into the
 *              air, where it cannot be buried by anything. Whatever this reports
 *              is the floor the real measurement is standing on.
 *
 * This tool found the floor and then stood on it. It ran with the animation
 * clock free, so the "still" reading it printed as the noise floor WAS the
 * noise it was measuring — and being the same noise, it did not stand out.
 * The floor is not a fact about the stage, it is a fact about how the frames
 * were taken: pin performance.now() across the renders and it collapses.
 * Measured through tools/r3pad.mjs, which runs the identical diff() and has a
 * --nofreeze switch, on seed 40: free, mean still 998 px² and a pad floating
 * two metres in the air scores 12.1% "buried"; pinned, eight of nine stations
 * read exactly 0 px still and floating falls to 2.7%.
 *
 * So the clock is pinned here too, and the first grab after each drive-in is
 * discarded. The "still" column is kept and is now what it always claimed to
 * be: whatever noise is left after both house rules have been obeyed. If it
 * is not zero, something new is moving.
 *
 *   node tools/padnoise.mjs [--seeds 22,40] [--at 40,25,14]
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
        const g = window.__game;
        const cv = g.renderer.domElement, w = cv.width, h = cv.height;
        const tmp = document.createElement('canvas');
        tmp.width = w; tmp.height = h;
        const tc = tmp.getContext('2d');
        const grab = () => { g.renderOnce(); tc.drawImage(cv, 0, 0); return tc.getImageData(0, 0, w, h).data; };
        const realNow = performance.now.bind(performance);
        const pad = g.scene.getObjectByName('ramp-pad');
        if (!pad) return { err: 'no mesh named ramp-pad' };
        const mats = Array.isArray(pad.material) ? pad.material : [pad.material];
        /* Byte for byte c2padburied's own comparison. */
        const diff = (a, b) => {
          let n = 0;
          for (let q = 0; q < a.length; q += 4) {
            if (Math.abs(a[q] - b[q]) + Math.abs(a[q + 1] - b[q + 1])
              + Math.abs(a[q + 2] - b[q + 2]) > 12) n++;
          }
          return n;
        };
        const measure = () => {
          pad.visible = false;
          const bare = grab();
          pad.visible = true;
          const onDepth = grab();
          const wasTest = mats.map(m => m.depthTest);
          const wasWrite = mats.map(m => m.depthWrite);
          mats.forEach(m => { m.depthTest = false; m.depthWrite = false; m.needsUpdate = true; });
          const free = grab();
          mats.forEach((m, k) => { m.depthTest = wasTest[k]; m.depthWrite = wasWrite[k]; m.needsUpdate = true; });
          const drawn = diff(onDepth, bare), whole = diff(free, bare);
          return { drawn, whole, buried: whole ? +((1 - drawn / whole) * 100).toFixed(1) : 0 };
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
            const a = grab(), b = grab();
            const still = diff(a, b);
            const real = measure();
            pad.position.y += 2;
            const floating = measure();
            pad.position.y -= 2;
            performance.now = realNow;
            rows.push({ lip: r.lip, d, still, real, floating });
          }
        }
        g.autopilot(false);
        return { seed: g.track.seed, rows };
      }, [RUNGS]);

      if (out.err) { console.log('  ' + out.err); return; }
      console.log(`\n  seed ${out.seed} — the buried test against its own noise floor`);
      console.log('     lip   m short   still px²   pad whole px²   pad buried   floating buried');
      for (const r of out.rows) {
        console.log(`  ${String(r.lip).padStart(6)} ${String(r.d).padStart(9)}`
          + ` ${String(r.still).padStart(11)} ${String(r.real.whole).padStart(15)}`
          + ` ${(r.real.buried + '%').padStart(12)} ${(r.floating.buried + '%').padStart(17)}`);
      }
      const mean = k => out.rows.reduce((a, r) => a + (k === 'real' ? r.real.buried : r.floating.buried), 0)
        / (out.rows.length || 1);
      const stillMean = out.rows.reduce((a, r) => a + r.still, 0) / (out.rows.length || 1);
      console.log(`  mean: pad ${mean('real').toFixed(1)}%   floating ${mean('floating').toFixed(1)}%`
        + `   pixels changing with nothing changed ${stillMean.toFixed(0)}`);
    });
}

finish(process.exitCode || 0);
