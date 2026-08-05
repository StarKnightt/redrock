/* Is the seed-40 plume really over the kerb, or is the instrument?
 *
 * b5burst reports 12 puffs outside the kerb by 4.29 m on seed 40, on every
 * frame including the touchdown frame. It gets that from
 * track.project(puff, p.s) — the puff's lateral offset measured in the road
 * frame AT THE CAR'S OWN STATION. For a mass that is left behind on a road
 * that bends, that is not the puff's distance from its own piece of kerb, and
 * on a bend it will read large even for dust lying dead centre.
 *
 * So this asks the same question three ways on the same frame:
 *   - the car's own lateral offset, which the plume is placed relative to;
 *   - each puff projected at the CAR's station, which is what b5burst does;
 *   - each puff projected at ITS OWN nearest station, found by a short search,
 *     which is the distance to the kerb it is actually next to.
 *
 *   node tools/x4lat.mjs --seeds 22,40 --n 16
 */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEEDS = flag('seeds', '22,40').split(',').map(Number);
const RAMP = +flag('ramp', 1);
const N = +flag('n', 16);

for (const SEED of SEEDS) {
  await run({ width: 1600, height: 900, hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0&ink=1` },
    async ({ page }) => {
      const out = await page.evaluate(([idx, frames]) => {
        const g = window.__game, p = g.player;
        const pool = g.effects.particles;

        /* project(p, hint) already runs its own +-90 m search off the hint and
           returns the nearest station, so passing the car's s is a search
           window and not a frame of reference. The plume never leaves that
           window. Passing -1 makes it search the whole track instead, which is
           the same answer arrived at without the hint — printed alongside so
           the hint can be ruled out as the cause of a large reading. */

        g.setPaused(true);
        if (g.race?.entries) g.race.entries.length = 0;
        for (let i = 0; i < pool.max; i++) {
          pool.active[i] = 0; pool.scales[i * 2] = pool.scales[i * 2 + 1] = 0;
        }
        pool.live = 0; pool.cursor = 0; pool._resetRandom();

        const r = g.track.ramps[Math.min(idx, g.track.ramps.length - 1)];
        g.autopilot(true, 0.85);
        g.driveTo((r.pad0 - 60) / g.track.length, { runUp: 320, maxSec: 45 });
        let k = 0, wasAir = false;
        while (k++ < 900) { g.step(1 / 60); if (p.airborne) wasAir = true; if (wasAir && !p.airborne) break; }

        const probeKeys = Object.keys(g.track.project(p.pos, p.s));
        const rows = [];
        for (let f = 0; f < frames; f++) {
          const carQ = g.track.project(p.pos, p.s);
          let atCar = 0, atOwn = 0, overCar = 0, overOwn = 0, halfCar = carQ.width * 0.5, halfOwn = 0;
          let n = 0;
          for (let i = 0; i < pool.max; i++) {
            if (!pool.active[i] || pool.kind[i] < 4.5) continue;
            const v = new g.THREE.Vector3(
              pool.centers[i * 3], pool.centers[i * 3 + 1], pool.centers[i * 3 + 2]);
            const sx = pool.scales[i * 2];
            const a = g.track.project(v, p.s);
            const b = g.track.project(v, -1);
            const ra = Math.abs(a.lat) + sx * 0.5, rb = Math.abs(b.lat) + sx * 0.5;
            if (ra > atCar) atCar = ra;
            if (rb > atOwn) atOwn = rb;
            if (ra > a.width * 0.5) overCar++;
            if (rb > b.width * 0.5) overOwn++;
            halfOwn = b.width * 0.5;
            n++;
          }
          rows.push({
            f, n,
            carLat: +carQ.lat.toFixed(2),
            carHalf: +halfCar.toFixed(2),
            atCar: +atCar.toFixed(2), overCar,
            atOwn: +atOwn.toFixed(2), overOwn, halfOwn: +halfOwn.toFixed(2),
          });
          g.setPaused(false); g.step(1 / 60); g.setPaused(true);
        }
        g.autopilot(false);
        return { seed: g.track.seed, keys: probeKeys, rows };
      }, [RAMP, N]);

      console.log(`\n  seed ${out.seed} — project() keys: ${out.keys.join(', ')}`);
      console.log('   frame  puffs   car lat   car half |  reach@car  over |  reach@own  half@own  over');
      for (const r of out.rows) {
        console.log(`   ${String(r.f).padStart(5)} ${String(r.n).padStart(6)}`
          + ` ${r.carLat.toFixed(2).padStart(9)} ${r.carHalf.toFixed(2).padStart(10)} |`
          + ` ${r.atCar.toFixed(2).padStart(9)} ${String(r.overCar).padStart(5)} |`
          + ` ${r.atOwn.toFixed(2).padStart(10)} ${r.halfOwn.toFixed(2).padStart(9)}`
          + ` ${String(r.overOwn).padStart(5)}`);
      }
    });
}

finish(process.exitCode || 0);
