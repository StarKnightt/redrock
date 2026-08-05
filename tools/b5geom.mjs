/* Diagnostic (read-only): where does a landing burst actually put its puffs?
 *
 * Wraps emitLandingBurst to record the arguments it is called with, then dumps
 * every burst instance's lateral offset, height and half-extent in metres at
 * the frame of touchdown and a few frames after. Answers "outside the kerbs"
 * and "hanging in mid-air" in the units the track is built in.
 *
 *   node tools/b5geom.mjs [--seeds 22,40] [--ramp 1]
 */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEEDS = flag('seeds', '22,40').split(',').map(Number);
const RAMP = +flag('ramp', 1);

for (const SEED of SEEDS) {
  await run({ width: 1600, height: 900, hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0&ink=1` },
    async ({ page }) => {
      const out = await page.evaluate(([ramp]) => {
        const g = window.__game, p = g.player;
        const pool = g.effects.particles;
        g.setPaused(true);
        if (g.race?.entries) g.race.entries.length = 0;

        let call = null;
        const orig = pool.emitLandingBurst.bind(pool);
        pool.emitLandingBurst = (point, car, strength, surface, scale) => {
          const q = g.track.project(point.clone(), p.s);
          call = {
            strength: +strength.toFixed(3), surface: +(surface || 0).toFixed(2),
            scale: +scale.toFixed(3), speed: +(car.speed || 0).toFixed(1),
            lat: +q.lat.toFixed(2), halfW: +(q.width * 0.5).toFixed(2),
          };
          return orig(point, car, strength, surface, scale);
        };

        const r = g.track.ramps[Math.min(ramp, g.track.ramps.length - 1)];
        g.autopilot(true, 0.85);
        g.driveTo((r.pad0 - 60) / g.track.length, { runUp: 320, maxSec: 45 });
        let k = 0, wasAir = false;
        while (k++ < 900) { g.step(1 / 60); if (p.airborne) wasAir = true; if (wasAir && !p.airborne) break; }

        const snap = () => {
          const rows = [];
          for (let i = 0; i < pool.max; i++) {
            if (!pool.active[i] || pool.kind[i] < 4.5) continue;
            const c = new g.THREE.Vector3(
              pool.centers[i * 3], pool.centers[i * 3 + 1], pool.centers[i * 3 + 2]);
            const q = g.track.project(c, p.s);
            rows.push({
              lat: +q.lat.toFixed(2), h: +q.height.toFixed(2),
              sx: +pool.scales[i * 2].toFixed(2), sy: +pool.scales[i * 2 + 1].toFixed(2),
              halfW: +(q.width * 0.5).toFixed(2), age: +pool.ages[i].toFixed(2),
            });
          }
          return rows;
        };
        const at0 = snap();
        for (let f = 0; f < 10; f++) g.step(1 / 60);
        const at10 = snap();
        g.autopilot(false);
        return { seed: g.track.seed, call, at0, at10 };
      }, [RAMP]);

      console.log(`\n  seed ${out.seed} — emitLandingBurst(${JSON.stringify(out.call)})`);
      const show = (name, rows) => {
        console.log(`\n   ${name}: ${rows.length} puffs`);
        console.log('      lat m   halfW   over    h m    sx     sy    foot m');
        for (const r of rows) {
          const over = Math.abs(r.lat) + r.sx * 0.5 - r.halfW;
          console.log(`   ${r.lat.toFixed(2).padStart(8)} ${r.halfW.toFixed(2).padStart(7)}`
            + ` ${over.toFixed(2).padStart(6)} ${r.h.toFixed(2).padStart(6)}`
            + ` ${r.sx.toFixed(2).padStart(6)} ${r.sy.toFixed(2).padStart(6)}`
            + ` ${(r.h - r.sy * 0.5).toFixed(2).padStart(9)}`);
        }
      };
      show('at touchdown', out.at0);
      show('10 frames later', out.at10);
    });
}

finish(process.exitCode || 0);
