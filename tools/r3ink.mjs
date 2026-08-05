/* Round-3 review instrument (read-only): ink density on the landing burst and
 * on the near-wheel veil, measured by one piece of code in one run.
 *
 * The claim under review is that a 4% ink target is unreachable for any dust in
 * this game, evidenced by a veil that reads 26.7%. That can only be adjudicated
 * if both are measured the same way on the same build, so this does both in one
 * page and prints them side by side.
 *
 * ink% is wheelnear's definition: of the pixels the pool adds to the frame, the
 * share that get darker when pipeline.inkEnabled is turned off. world% is the
 * same test on every pixel the pool did not touch, which is the frame's own
 * line density and the only fair thing to compare against.
 *
 * The animation clock is pinned across each triple so the pool/ink/bare renders
 * differ only in what they are meant to differ in.
 *
 *   node tools/r3ink.mjs [--seed 22] [--ramp 1] [--at 0.42]
 */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEED = +flag('seed', 22);
const RAMP = +flag('ramp', 1);
const AT = +flag('at', 0.42);

await run({ width: 1600, height: 900, hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0&ink=1` },
  async ({ page }) => {
    const out = await page.evaluate(([idx, at]) => {
      const g = window.__game, p = g.player;
      const pool = g.effects.particles;
      const cv = g.renderer.domElement, w = cv.width, h = cv.height;
      const tmp = document.createElement('canvas');
      tmp.width = w; tmp.height = h;
      const tc = tmp.getContext('2d');
      const grab = () => { g.renderOnce(); tc.drawImage(cv, 0, 0); return tc.getImageData(0, 0, w, h).data; };
      const real = performance.now.bind(performance);

      const measure = () => {
        const t = real(); performance.now = () => t;
        const shown = grab();
        pool.mesh.visible = false;
        const bare = grab();
        pool.mesh.visible = true;
        g.pipeline.inkEnabled = false;
        const noink = grab();
        g.pipeline.inkEnabled = true;
        performance.now = real;
        let plume = 0, inked = 0, world = 0, inkWorld = 0;
        for (let q = 0; q < shown.length; q += 4) {
          const dr = Math.abs(shown[q] - bare[q]) + Math.abs(shown[q + 1] - bare[q + 1])
            + Math.abs(shown[q + 2] - bare[q + 2]);
          const drop = (0.2126 * (noink[q] - shown[q]) + 0.7152 * (noink[q + 1] - shown[q + 1])
            + 0.0722 * (noink[q + 2] - shown[q + 2])) / 255;
          if (dr > 12) { plume++; if (drop > 0.02) inked++; }
          else { world++; if (drop > 0.02) inkWorld++; }
        }
        return {
          plumePct: +(plume / (w * h) * 100).toFixed(3),
          ink: +(plume ? inked / plume * 100 : 0).toFixed(2),
          world: +(inkWorld / world * 100).toFixed(2),
          kmh: Math.round(p.speed * 3.6),
        };
      };

      g.setPaused(true);
      if (g.race?.entries) g.race.entries.length = 0;

      /* 1. The near-wheel veil at racing speed on a straight. */
      g.autopilot(true, 1.0);
      g.driveTo(at, { runUp: 420, maxSec: 60 });
      for (let k = 0; k < 90; k++) g.step(1 / 60);
      const veil = [];
      for (let f = 0; f < 6; f++) { g.setPaused(true); veil.push(measure()); g.setPaused(false); g.step(1 / 60); }

      /* 2. The landing burst off a ramp, frame by frame from touchdown. */
      const r = g.track.ramps[Math.min(idx, g.track.ramps.length - 1)];
      g.autopilot(true, 0.85);
      g.driveTo((r.pad0 - 60) / g.track.length, { runUp: 320, maxSec: 45 });
      let n = 0, wasAir = false;
      while (n++ < 900) { g.step(1 / 60); if (p.airborne) wasAir = true; if (wasAir && !p.airborne) break; }
      const land = [];
      for (let f = 0; f < 14; f++) { g.setPaused(true); land.push(measure()); g.setPaused(false); g.step(1 / 60); }

      g.autopilot(false);
      return { seed: g.track.seed, veil, land, lip: r.lip };
    }, [RAMP, AT]);

    const show = (name, rows) => {
      console.log(`\n  ${name}`);
      console.log('   frame   plume%   ink on plume%   ink on world%   ratio   km/h');
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        console.log(`   ${String(i).padStart(5)} ${r.plumePct.toFixed(3).padStart(8)}`
          + ` ${r.ink.toFixed(2).padStart(15)} ${r.world.toFixed(2).padStart(15)}`
          + ` ${(r.ink / Math.max(0.01, r.world)).toFixed(2).padStart(7)} ${String(r.kmh).padStart(6)}`);
      }
      const m = k => rows.reduce((a, r) => a + r[k], 0) / rows.length;
      console.log(`   mean ink ${m('ink').toFixed(2)}%  against world ${m('world').toFixed(2)}%`
        + `  — ${(m('ink') / m('world')).toFixed(2)}x the frame`);
    };
    console.log(`\n  seed ${out.seed}, ramp lip ${out.lip} — ink density, one instrument, one run`);
    show('near-wheel veil, straight at racing speed', out.veil);
    show('landing burst, from the frame of touchdown', out.land);
  });

finish(process.exitCode || 0);
