/* Walk a stretch of road and ask, station by station, why nobody can stand
 * there. Two holes survive the pacing pass — seed 22's t 78–130 s and seed
 * 40's t 84–121 s — and the scheduler reports both as "nothing stands up
 * inside it". This says which gate is doing the refusing: the footing, the
 * sightline, or the corridor being too narrow to hold a group at all.
 *
 *   node tools/wwalk.mjs --seed 40 --from 1780 --to 2180
 */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEED = flag('seed', '40');
const FROM = +flag('from', '1780'), TO = +flag('to', '2180'), STEP = +flag('step', '20');

await run({
  width: 640, height: 360,
  hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0`,
}, async ({ page }) => {
  page.setDefaultTimeout(600_000);
  const out = await page.evaluate(({ FROM, TO, STEP }) => {
    const g = window.__game;
    const env = g.scene.getObjectByName('environment') || g.stage.getObjectByName('environment');
    const probe = env?.userData?.crowdProbe;
    const rows = [];
    for (let s = FROM; s <= TO; s += STEP) {
      for (const side of [-1, 1]) {
        const r = probe.why(s, side);
        rows.push({
          s, side, u: r.u,
          why: r.u === null ? (r.trace[r.trace.length - 1] || '?') : r.seen.join(' '),
        });
      }
    }
    return rows;
  }, { FROM, TO, STEP });

  console.log(`\n══ seed ${SEED}, s ${FROM}–${TO}`);
  const tally = new Map();
  for (const r of out) {
    const key = r.u === null ? r.why.replace(/[\d.]+/g, '#') : 'STANDS';
    tally.set(key, (tally.get(key) || 0) + 1);
    console.log(`  s=${String(r.s).padStart(5)} side ${String(r.side).padStart(2)}  `
      + (r.u === null ? `no  — ${r.why}` : `u=${r.u.toFixed(2)}  ${r.why}`));
  }
  console.log('\n  refusals by reason:');
  for (const [k, n] of [...tally].sort((a, b) => b[1] - a[1])) console.log(`   ${String(n).padStart(3)}  ${k}`);
});
finish(process.exitCode || 0);
