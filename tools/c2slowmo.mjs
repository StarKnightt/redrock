/* Review probe (read-only): the shape of the slow motion.
 *
 * The brief asks for "slight slow-mo for 0.5 seconds". Two numbers decide
 * whether that is what ships: how deep the dip goes, and how long wall-clock
 * time is actually spent below full speed. A tool that reports only the
 * minimum time scale cannot tell 0.45 for two frames from 0.45 for a second
 * and a half, and those are different features.
 *
 * The trace is taken at a fixed 1/60 of sim time per step, and the wall-clock
 * cost of each step is dt/scale, so summing that over the frames below
 * threshold gives the seconds the player waits.
 *
 * Nothing under src/ is touched.
 *
 *   node tools/c2slowmo.mjs [--seeds 22,40]
 */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEEDS = flag('seeds', '22,40').split(',').map(Number);

for (const SEED of SEEDS) {
  await run({ width: 640, height: 360, hash: `manual&tier=low&seed=${SEED}&cap=0&hud=0` },
    async ({ page }) => {
      const out = await page.evaluate(() => {
        const g = window.__game, p = g.player;
        g.setPaused(true);
        if (g.race?.entries) g.race.entries.length = 0;
        g.autopilot(true, 0.85);
        const rows = [];
        for (const r of g.track.ramps) {
          g.driveTo((r.pad0 - 60) / g.track.length, { runUp: 320, maxSec: 45 });
          let n = 0, wasAir = false;
          const tr = [];
          while (n++ < 700) {
            const sc = g.timeScale();
            if (wasAir || p.airborne) tr.push({ sc: +sc.toFixed(3), air: p.airborne ? 1 : 0, h: +p.height.toFixed(2) });
            g.step(1 / 60);
            if (p.airborne) wasAir = true;
            if (wasAir && !p.airborne && tr.length > 30) {
              if (tr.slice(-20).every(x => x.sc > 0.995)) break;
            }
          }
          const dip = tr.filter(x => x.sc < 0.99);
          /* Wall seconds: each row advances 1/60 of sim time, which costs
             (1/60)/scale of real time. */
          const wall = dip.reduce((a, x) => a + (1 / 60) / Math.max(0.01, x.sc), 0);
          const simAir = tr.filter(x => x.air).length / 60;
          const wallAir = tr.filter(x => x.air).reduce((a, x) => a + (1 / 60) / Math.max(0.01, x.sc), 0);
          rows.push({
            lip: r.lip,
            min: Math.min(...tr.map(x => x.sc)),
            frames: dip.length,
            simDip: +(dip.length / 60).toFixed(3),
            wallDip: +wall.toFixed(3),
            simAir: +simAir.toFixed(2),
            wallAir: +wallAir.toFixed(2),
            hAtEnd: dip.length ? tr[dip.length - 1].h : 0,
            apex: Math.max(...tr.map(x => x.h)),
            head: tr.slice(0, 46).map(x => x.sc),
          });
        }
        g.autopilot(false);
        return { seed: g.track.seed, rows };
      });

      console.log(`\n─── seed ${out.seed} — slow motion ───`);
      console.log('     lip   min x   frames   sim s   wall s   height when it ends   apex m   air sim/wall');
      for (const r of out.rows) {
        console.log(`  ${String(r.lip).padStart(6)} ${r.min.toFixed(2).padStart(7)}`
          + ` ${String(r.frames).padStart(8)} ${r.simDip.toFixed(2).padStart(7)}`
          + ` ${r.wallDip.toFixed(2).padStart(8)} ${(r.hAtEnd.toFixed(2) + ' m').padStart(21)}`
          + ` ${r.apex.toFixed(2).padStart(8)}   ${r.simAir.toFixed(2)}/${r.wallAir.toFixed(2)} s`);
      }
      console.log('  scale, frame by frame from the launch:');
      console.log('   ' + out.rows[0].head.map(v => v.toFixed(2)).join(' '));
    });
}

finish(process.exitCode || 0);
