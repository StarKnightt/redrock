/* What each of the three airborne camera terms is actually worth.
 *
 * The shipped camera used to pull the boom back 5 m, climb 2.4 m and widen
 * the lens 6 degrees over the course of a flight, and the review measured the
 * last two as a net subtraction from the very thing they existed to show. The
 * three terms are now knobs on ChaseCamera (`airBoom`, `airLift`, `airFov`),
 * so this drives the same launches once per configuration and reports what
 * each one does to the picture. Same seed, same ramp, same AI run-in, and the
 * flights are deterministic, so the only thing that differs between rows is
 * the camera.
 *
 * The measurement is showheight's, deliberately, so the numbers here and
 * there are the same numbers: the on-screen gap between the car's origin and
 * the road point directly beneath it, and the car's own projected length as
 * the ruler.
 *
 * Reported per metre of apex as well as raw, because separation grows with
 * height and the point is to compare cameras rather than jumps. Note that
 * px/m is not constant in height even for one camera — the ground point runs
 * away down the frame as the car climbs — so it is only comparable between
 * rows of the same jump, which is what it is used for here.
 *
 *   node tools/airlift.mjs [--seeds 22,40]
 */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEEDS = flag('seeds', '22,40').split(',').map(Number);
const W = 1600, H = 900;

const CONFIGS = [
  { name: 'shipped   boom+5', boom: 5.0, lift: 0, fov: 0 },
  { name: 'previous  +lift+fov', boom: 5.0, lift: 2.4, fov: 6 },
  { name: 'lift only', boom: 5.0, lift: 2.4, fov: 0 },
  { name: 'fov only', boom: 5.0, lift: 0, fov: 6 },
  { name: 'no pullback at all', boom: 0, lift: 0, fov: 0 },
  { name: 'boom +8', boom: 8.0, lift: 0, fov: 0 },
  { name: 'boom +1.5', boom: 1.5, lift: 0, fov: 0 },
  { name: 'boom +2.5', boom: 2.5, lift: 0, fov: 0 },
  { name: 'boom +3.5', boom: 3.5, lift: 0, fov: 0 },
];

const rows = [];

for (const SEED of SEEDS) {
  await run({ width: W, height: H, hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0` },
    async ({ page }) => {
      const out = await page.evaluate(([W, H, configs]) => {
        const g = window.__game, p = g.player, track = g.track, L = track.length;
        g.setPaused(true);
        if (g.race?.entries) g.race.entries.length = 0;
        const proj = (v) => {
          const q = v.clone().project(g.camera);
          return { x: (q.x * 0.5 + 0.5) * W, y: (-q.y * 0.5 + 0.5) * H };
        };
        const res = [];
        g.autopilot(true, 0.85);
        for (let ri = 0; ri < track.ramps.length; ri++) {
          const r = track.ramps[ri];
          for (const c of configs) {
            g.chase.airBoom = c.boom; g.chase.airLift = c.lift; g.chase.airFov = c.fov;
            g.driveTo((r.pad0 - 60) / L, { runUp: 320, maxSec: 45 });
            let wasAir = false, n = 0, done = 0, best = null;
            while (n++ < 900) {
              g.step(1 / 60);
              if (p.airborne) wasAir = true;
              if (wasAir) {
                const up = track.frameAt(p.s).up;
                const car = proj(p.pos);
                const gnd = proj(p.pos.clone().addScaledVector(up, -p.height));
                const nose = proj(p.pos.clone().addScaledVector(p.forward, 2.05));
                const tail = proj(p.pos.clone().addScaledVector(p.forward, -2.05));
                const s = {
                  h: p.height, sep: gnd.y - car.y, carY: car.y, carX: car.x,
                  lenPx: Math.hypot(nose.x - tail.x, nose.y - tail.y),
                  boom: g.camera.position.distanceTo(p.pos), fov: g.camera.fov,
                };
                if (!best || s.h > best.h) best = s;
              }
              if (wasAir && !p.airborne) { if (++done > 8) break; }
            }
            if (best) {
              res.push({
                lip: r.lip, cfg: c.name,
                h: +best.h.toFixed(2), sep: +best.sep.toFixed(1),
                perM: +(best.sep / Math.max(best.h, 1e-3)).toFixed(1),
                len: +best.lenPx.toFixed(1), carY: +best.carY.toFixed(0),
                boom: +best.boom.toFixed(1), fov: +best.fov.toFixed(1),
              });
            }
          }
        }
        g.chase.airBoom = 5.0; g.chase.airLift = 0; g.chase.airFov = 0;
        g.autopilot(false);
        return { seed: track.seed, res };
      }, [W, H, CONFIGS]);

      console.log(`\n─── seed ${out.seed} ───`);
      console.log('   lip   camera                 apex m   sep px   px/m   car px   carY   boom   fov');
      for (const r of out.res) {
        rows.push({ seed: out.seed, ...r });
        console.log(`  ${String(r.lip).padStart(5)}   ${r.cfg.padEnd(20)}`
          + ` ${r.h.toFixed(2).padStart(7)}  ${r.sep.toFixed(1).padStart(7)}`
          + ` ${r.perM.toFixed(1).padStart(6)}  ${r.len.toFixed(0).padStart(7)}  ${String(r.carY).padStart(5)}`
          + `  ${r.boom.toFixed(1).padStart(5)} ${r.fov.toFixed(1).padStart(5)}`);
      }
    });
}

console.log('\n  ═══ per configuration, averaged over every launch ═══');
console.log('   camera                 apex m   sep px   px/m   car px   carY');
for (const c of CONFIGS) {
  const set = rows.filter(r => r.cfg === c.name);
  if (!set.length) continue;
  const m = k => set.reduce((a, r) => a + r[k], 0) / set.length;
  console.log(`  ${c.name.padEnd(20)} ${m('h').toFixed(2).padStart(7)}`
    + ` ${m('sep').toFixed(1).padStart(7)} ${m('perM').toFixed(1).padStart(6)}`
    + ` ${m("len").toFixed(1).padStart(7)} ${m("carY").toFixed(0).padStart(6)}`);
}

finish(process.exitCode || 0);
