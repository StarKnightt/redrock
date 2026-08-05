/* zwhole — is a pacing hole a scheduling failure or a terrain fact?
 *
 * Walks a station range at a fine stride, both sides, and reports for each
 * station whether anybody can stand there (crowdStand), whether the analytic
 * sightline reaches them (crowdSightScore) and whether a real ray does. That is
 * the same triple `place()` consults, read off the build's own probe rather than
 * re-derived, so a range this reports as empty is empty for the scheduler too.
 *
 * The point of it is to tell the two causes of a hole apart. A hole the walker
 * skipped because its stride is eight metres is a bug in the walker; a hole with
 * no standable visible shoulder anywhere in it at two metres is the mountain.
 *
 *   node tools/zwhole.mjs [--seed 40] [--from 1000] [--to 1480] [--step 2]
 */
import { run } from './harness.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEED = flag('seed', '40');
const FROM = +flag('from', 1000);
const TO = +flag('to', 1480);
const STEP = +flag('step', 2);

await run({
  width: 320, height: 200,
  hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0`,
}, async ({ page }) => {
  const out = await page.evaluate(({ FROM, TO, STEP }) => {
    const g = window.__game;
    const P = g.scene.getObjectByName('environment').userData.crowdProbe;
    const rows = [];
    let stood = 0;
    for (let s = FROM; s <= TO; s += STEP) {
      for (const side of [-1, 1]) {
        const u = P.stand(s, side);
        if (u === null) continue;
        stood++;
        const ray = P.raySees(s, side, u);
        rows.push({
          s, side, u: +u.toFixed(2), t: +P.clock(s).toFixed(1),
          seen: P.sight(s, side, u), ray: ray.ok, why: ray.why,
        });
      }
    }
    return { rows, stood };
  }, { FROM, TO, STEP });

  console.log(`\n══ seed ${SEED} — stations ${FROM}–${TO} m every ${STEP} m, both`
    + ` sides: ${out.stood} that anybody can stand on`);
  for (const r of out.rows) {
    console.log(`  s=${String(r.s).padStart(5)} side ${r.side > 0 ? '+1' : '-1'}`
      + `  u=${r.u.toFixed(2)}  t=${r.t.toFixed(1)} s  sight ${r.seen}/5`
      + `  ray ${r.ray ? 'clear' : 'BLOCKED by ' + r.why}`);
  }
  const good = out.rows.filter(r => r.seen >= 2 && r.ray);
  console.log(`\n  ${good.length} station(s) clear the bar place() uses`
    + ' (standable, sight >= 2, ray clear)');
  if (!good.length) {
    console.log('  → the hole is the terrain, not the schedule: no stride would'
      + ' have found anything');
  }
  console.log();
});
