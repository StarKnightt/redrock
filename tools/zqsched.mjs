/* The crowd schedule in seconds, which is the unit the rule is written in.
 *
 * tools/zzcadence.mjs answers the same question off the frame and is the
 * ground truth; this is the generator's own view of it, and the two being
 * printed in the same unit is the point. A disagreement between them is
 * either the speed model or a group nobody can see, and both are worth
 * knowing about before a lap is rendered.
 *
 *   node tools/zqsched.mjs [--seeds 22,1,40]
 */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEEDS = flag('seeds', '22,1,40').split(',');

for (const SEED of SEEDS) {
  await run({
    width: 640, height: 360,
    hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0`,
  }, async ({ page }) => {
    const out = await page.evaluate(() => {
      const g = window.__game;
      const env = g.scene.getObjectByName('environment') || g.stage.getObjectByName('environment');
      const probe = env?.userData?.crowdProbe;
      if (!probe || !g.crowd) return { none: true };
      const clock = probe.clock;
      const rows = g.crowd.sites.map(s => ({
        kind: s.kind, s: Math.round(s.s), t: +clock(s.s).toFixed(1),
        n: s.groups.reduce((a, b) => a + b.n, 0),
        cheer: !!s.cheer, seen: s.seen ?? null, side: s.side,
      })).sort((a, b) => a.s - b.s);
      return {
        rows, lap: +clock.lap.toFixed(1), L: +g.track.length.toFixed(0),
        plan: probe.plan ? probe.plan() : null,
      };
    });
    if (out.none) { console.log(`  seed ${SEED}: no crowd`); return; }

    console.log(`\n══ seed ${SEED} — ${out.L} m, modelled lap ${out.lap} s, ${out.rows.length} sites`);
    console.log('    site            s        t     side  n   run-in seen   squad');
    let prev = 0, worst = 0, worstAt = '';
    for (const r of out.rows) {
      const gap = r.t - prev;
      if (gap > worst) { worst = gap; worstAt = `before ${r.kind} at s=${r.s}`; }
      console.log(`    ${r.kind.padEnd(14)} ${String(r.s).padStart(5)}`
        + `  ${String(r.t).padStart(7)} s  ${String(r.side).padStart(3)}`
        + `  ${String(r.n).padStart(2)}  ${String(r.seen ?? '-').padStart(6)}/5`
        + `   ${r.cheer ? 'cheer squad' : ''}`
        + `      ${gap > 35 ? `◀── ${gap.toFixed(0)} s with nobody` : ''}`);
      prev = r.t;
    }
    const tail = out.lap - prev;
    if (tail > worst) { worst = tail; worstAt = 'after the last site to the line'; }
    console.log(`    ${'(the line)'.padEnd(14)} ${String(out.L).padStart(5)}  ${String(out.lap.toFixed(1)).padStart(7)} s`
      + `${tail > 35 ? `                              ◀── ${tail.toFixed(0)} s with nobody` : ''}`);
    console.log(`\n    longest modelled gap: ${worst.toFixed(1)} s  (${worstAt})`);
    if (out.plan && args.includes('--plan')) {
      console.log('\n    how the schedule was arrived at:');
      for (const line of out.plan) console.log('      ' + line);
    }
  });
}
console.log();
finish(process.exitCode || 0);
