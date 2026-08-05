/* How long the slow motion lasts, in the player's own seconds.
 *
 * Written because the same trace can be read two ways and the two answers
 * differ by the time scale itself. Game.step(dt) takes dt as *wall* time and
 * spends dt * timeScale() of it on the simulation — so a tool that steps 1/60
 * advances one 60th of a second of the player's life and rather less than that
 * of the car's. Reading those frames as simulation time and multiplying the
 * wall cost by 1/scale counts the dilation twice, and reports 1.58 s for a
 * window the player experiences as 0.79.
 *
 * This measures both clocks off the same frames and prints them side by side,
 * so the ratio is visible rather than assumed:
 *
 *   wall   frames below full speed, times the frame time. What a stopwatch
 *          beside the monitor would read.
 *   sim    how far the car's own clock advanced over those same frames, taken
 *          from Car.sinceLaunch, which the physics counts in scaled seconds.
 *
 * sim/wall over the window must come out at roughly the mean time scale. If it
 * does not, one of the two clocks is being read wrong.
 *
 *   node tools/slowclock.mjs [--seeds 22,40] [--fps 60]
 */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEEDS = flag('seeds', '22,40').split(',').map(Number);
const FPS = +flag('fps', 60);

for (const SEED of SEEDS) {
  await run({ width: 640, height: 360, hash: `manual&tier=low&seed=${SEED}&cap=0&hud=0` },
    async ({ page }) => {
      const out = await page.evaluate(([fps]) => {
        const g = window.__game, p = g.player;
        const dt = 1 / fps;
        g.setPaused(true);
        if (g.race?.entries) g.race.entries.length = 0;
        g.autopilot(true, 0.85);
        const rows = [];
        for (const r of g.track.ramps) {
          g.driveTo((r.pad0 - 60) / g.track.length, { runUp: 320, maxSec: 45 });
          let n = 0, wasAir = false, dipFrames = 0, airFrames = 0;
          let simAtDipStart = null, simAtDipEnd = null, deepest = 1;
          let hAtEnd = 0, apex = 0, scaleSum = 0;
          while (n++ < 900) {
            const sc = g.timeScale();
            if (sc < 0.99) {
              if (simAtDipStart === null) simAtDipStart = p.sinceLaunch;
              dipFrames++; scaleSum += sc;
              deepest = Math.min(deepest, sc);
              simAtDipEnd = p.sinceLaunch;
              hAtEnd = p.height;
            }
            if (p.airborne) { airFrames++; wasAir = true; }
            apex = Math.max(apex, p.height);
            g.step(dt);
            if (wasAir && !p.airborne && n > 40 && g.timeScale() > 0.995) break;
          }
          rows.push({
            lip: r.lip, deepest: +deepest.toFixed(2), dipFrames,
            wall: +(dipFrames / fps).toFixed(3),
            sim: +((simAtDipEnd - simAtDipStart) || 0).toFixed(3),
            meanScale: dipFrames ? +(scaleSum / dipFrames).toFixed(3) : 1,
            airWall: +(airFrames / fps).toFixed(2),
            hAtEnd: +hAtEnd.toFixed(2), apex: +apex.toFixed(2),
          });
        }
        g.autopilot(false);
        return { seed: g.track.seed, rows };
      }, [FPS]);

      console.log(`\n─── seed ${out.seed} — slow motion on the player's clock, ${FPS} fps ───`);
      console.log('     lip   deepest   frames   wall s   sim s   sim/wall   mean x'
        + '   flight wall s   height at release   apex');
      for (const r of out.rows) {
        const ratio = r.wall ? (r.sim / r.wall) : 0;
        console.log(`  ${String(r.lip).padStart(6)} ${r.deepest.toFixed(2).padStart(9)}`
          + ` ${String(r.dipFrames).padStart(8)} ${r.wall.toFixed(2).padStart(8)}`
          + ` ${r.sim.toFixed(2).padStart(7)} ${ratio.toFixed(2).padStart(10)}`
          + ` ${r.meanScale.toFixed(2).padStart(8)} ${r.airWall.toFixed(2).padStart(15)}`
          + ` ${(r.hAtEnd.toFixed(2) + ' m').padStart(19)} ${r.apex.toFixed(2).padStart(6)}`);
      }
    });
}

finish(process.exitCode || 0);
