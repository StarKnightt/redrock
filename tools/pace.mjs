/* "Every five seconds of driving has something new to look at" — checked.
 *
 * Two jobs. First it drives a real lap and records where the car is against
 * the clock, so the point-mass speed model the landmark scheduler places
 * against can be compared with what the car actually does rather than
 * assumed. Second it reads the schedule the scheduler produced and prints the
 * gap between consecutive landmarks in seconds, which is the acceptance
 * criterion stated as a number.
 *
 *   node tools/pace.mjs [--seed 22]
 */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEED = flag('seed', '22');

await run({ width: 640, height: 360, hash: `manual&tier=high&seed=${SEED}&cap=60&hud=0` }, async ({ page }) => {
  const out = await page.evaluate(async () => {
    const g = window.__game;
    const env = g.scene.getObjectByName('environment') || g.scene;
    let schedule = null, lapTime = null, paceCurve = null;
    g.scene.traverse(o => {
      if (o.userData && o.userData.schedule) {
        schedule = o.userData.schedule;
        lapTime = o.userData.lapTime;
        paceCurve = o.userData.paceCurve;
      }
    });

    /* A real lap, stepped by the physics rather than by driveTo, so the pace
       recorded is the car's and not the placement model's. */
    const samples = [];
    g.setPaused(false);
    g.autopilot(true, 0.85);
    g.goTo(0.0005);
    const dt = 1 / 60;
    let t = 0;
    for (let i = 0; i < 60 * 400; i++) {
      g.step(dt);
      t += dt;
      if (i % 15 === 0) samples.push([t, g.player.s, g.player.speed ?? 0]);
      if (g.player.s > g.track.length - 40) break;
    }
    g.autopilot(false);
    return { schedule, lapTime, paceCurve, samples, length: g.track.length };
  });

  const { schedule, lapTime, paceCurve, samples, length } = out;
  console.log(`\n  route ${length.toFixed(0)} m`);
  if (samples.length > 2) {
    const real = samples[samples.length - 1][0];
    console.log(`  modelled lap ${lapTime.toFixed(1)} s   driven lap ${real.toFixed(1)} s`
      + `   (model is ${((lapTime / real - 1) * 100).toFixed(0)}% off)`);
    /* Where the two disagree matters more than the total: a lap time that
       matches by luck while the halves cancel would still put landmarks in the
       wrong places. Compared as a fraction of the lap so a uniformly slower car
       does not register as a placement error — what would is the model
       reaching a third of the way round while the car is at half. */
    const modelAt = s => {
      const k = Math.min(paceCurve.length - 1, Math.max(0, s / length * (paceCurve.length - 1)));
      const i = Math.floor(k);
      const [, a] = paceCurve[i], [, b] = paceCurve[Math.min(paceCurve.length - 1, i + 1)];
      return a + (b - a) * (k - i);
    };
    let worst = 0, worstAt = 0;
    for (const [tt, s] of samples) {
      const err = Math.abs(modelAt(s) / lapTime - tt / real);
      if (err > worst) { worst = err; worstAt = s; }
    }
    console.log(`  worst shape error ${(worst * 100).toFixed(1)}% of the lap, at s=${worstAt.toFixed(0)}`
      + `  (how far the model's idea of "half way in time" is from the car's)`);
  }

  if (!schedule) { console.log('  no schedule found on the environment'); return; }
  console.log(`\n  ${schedule.length} landmark events across ${lapTime.toFixed(0)} s\n`);
  let prev = 0, worst = 0, worstAt = '';
  const counts = {};
  for (const e of schedule) {
    const gap = e.t - prev;
    counts[e.kind] = (counts[e.kind] || 0) + 1;
    if (gap > worst) { worst = gap; worstAt = `${prev.toFixed(1)}–${e.t.toFixed(1)} s`; }
    console.log(`    ${e.t.toFixed(1).padStart(6)} s   +${gap.toFixed(1).padStart(4)} s   `
      + `s=${e.s.toFixed(0).padStart(4)}   ${e.kind}`);
    prev = e.t;
  }
  const tail = lapTime - prev;
  if (tail > worst) { worst = tail; worstAt = `${prev.toFixed(1)}–${lapTime.toFixed(1)} s (to the flag)`; }
  console.log(`\n  counts: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  console.log(`  longest gap ${worst.toFixed(1)} s at ${worstAt}`);
  console.log(`  mean gap ${(lapTime / (schedule.length + 1)).toFixed(1)} s`);
});

finish(process.exitCode || 0);
