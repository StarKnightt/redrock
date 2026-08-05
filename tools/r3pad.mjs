/* Round-3 review instrument (read-only): the boost pad, measured twice.
 *
 * c2padburied.mjs differences two renders. src/world/environment.js sets a
 * shader uTime from performance.now() inside onBeforeRender, so two renders of
 * an unchanged scene are not the same image and the difference counts the
 * grass. This runs the identical differencing code with performance.now()
 * pinned for the duration of each measurement, which makes consecutive renders
 * bit-identical and collapses that floor to whatever is left.
 *
 * Four readings a station, all through the same diff():
 *   still      two renders, nothing changed. The floor.
 *   pad        the real measurement.
 *   floating   pad lifted 2 m, where nothing can occlude it. Must read 0.
 *   sunk       pad dropped 40 mm, which should bury a lot of it. The signal
 *              check: an instrument that cannot see a pad it is told to bury
 *              is measuring nothing.
 *
 * Also prints the site's geometry in metres, because lat in track.js is
 * normalised to half-width and several probes read it as metres.
 *
 * Nothing under src/ is touched.
 *
 *   node tools/r3pad.mjs [--seeds 22,40] [--at 40,25,14] [--nofreeze]
 */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEEDS = flag('seeds', '22,40').split(',').map(Number);
const RUNGS = (flag('at', '40,25,14') || '').split(',').map(Number);
const FREEZE = !args.includes('--nofreeze');

for (const SEED of SEEDS) {
  await run({ width: 1600, height: 900, hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0&ink=1` },
    async ({ page }) => {
      const out = await page.evaluate(([rungs, freeze]) => {
        const g = window.__game;
        const cv = g.renderer.domElement, w = cv.width, h = cv.height;
        const tmp = document.createElement('canvas');
        tmp.width = w; tmp.height = h;
        const tc = tmp.getContext('2d');
        const grab = () => { g.renderOnce(); tc.drawImage(cv, 0, 0); return tc.getImageData(0, 0, w, h).data; };
        const pad = g.scene.getObjectByName('ramp-pad');
        if (!pad) return { err: 'no mesh named ramp-pad' };
        const mats = Array.isArray(pad.material) ? pad.material : [pad.material];

        /* Byte for byte c2padburied's comparison. */
        const diff = (a, b) => {
          let n = 0;
          for (let q = 0; q < a.length; q += 4) {
            if (Math.abs(a[q] - b[q]) + Math.abs(a[q + 1] - b[q + 1])
              + Math.abs(a[q + 2] - b[q + 2]) > 12) n++;
          }
          return n;
        };
        const real = performance.now.bind(performance);
        const pin = () => { if (freeze) { const t = real(); performance.now = () => t; } };
        const unpin = () => { performance.now = real; };

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

        const rows = [], geom = [];
        for (const r of g.track.ramps) {
          const f = g.track.frameAt((r.pad0 + r.pad1) * 0.5);
          geom.push({
            lip: r.lip, width: +f.width.toFixed(2),
            padHalfM: +(0.92 * f.width * 0.5).toFixed(2),
            padLen: +(r.pad1 - r.pad0).toFixed(1),
          });
          for (const d of rungs) {
            g.driveTo((r.pad0 - d) / g.track.length, { runUp: 340, maxSec: 45 });
            g.setPaused(true);
            pin();
            /* Throw the first grab away. Pinning alone got eight of these
               nine stations to a still-difference of exactly zero and left
               the first at 6097 px — the driveTo artifact, which is the other
               house rule and which this tool was not obeying. With the
               warm-up grab discarded all nine read 0. */
            grab();
            const a = grab(), b = grab();
            const still = diff(a, b);
            const now = measure();
            pad.position.y += 2;
            const floating = measure();
            pad.position.y -= 2.04;
            const sunk = measure();
            pad.position.y += 0.04;
            unpin();
            rows.push({ lip: r.lip, d, still, now, floating, sunk });
          }
        }
        g.autopilot(false);
        return { seed: g.track.seed, rows, geom };
      }, [RUNGS, FREEZE]);

      if (out.err) { console.log('  ' + out.err); return; }
      console.log(`\n  seed ${out.seed} — pad burial, animation clock ${FREEZE ? 'FROZEN' : 'free'}`);
      console.log('  site geometry:');
      for (const gm of out.geom) {
        console.log(`     lip ${gm.lip}: road ${gm.width} m wide, pad reaches ±${gm.padHalfM} m`
          + ` from the centreline, ${gm.padLen} m long`);
      }
      console.log('\n     lip   m short   still px²   whole px²   buried   floating(=0?)   sunk 40mm');
      for (const r of out.rows) {
        console.log(`  ${String(r.lip).padStart(6)} ${String(r.d).padStart(9)}`
          + ` ${String(r.still).padStart(11)} ${String(r.now.whole).padStart(11)}`
          + ` ${(r.now.buried + '%').padStart(8)} ${(r.floating.buried + '%').padStart(15)}`
          + ` ${(r.sunk.buried + '%').padStart(11)}`);
      }
      const mean = f => out.rows.reduce((a, r) => a + f(r), 0) / (out.rows.length || 1);
      console.log(`\n  mean: still ${mean(r => r.still).toFixed(0)} px²`
        + `   pad ${mean(r => r.now.buried).toFixed(1)}%`
        + `   floating ${mean(r => r.floating.buried).toFixed(1)}%`
        + `   sunk 40 mm ${mean(r => r.sunk.buried).toFixed(1)}%`);
    });
}

finish(process.exitCode || 0);
