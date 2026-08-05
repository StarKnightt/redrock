/* Which of the sweep's differences are real?
 *
 * tools/kwgrid.mjs prints a 32-seed mean for a dozen balance metrics. A mean is
 * not a measurement until it has an error bar, and on this simulation the bar
 * is large: a four-minute four-car race is chaotic, so two runs of the same
 * seed from initial conditions one part in a billion apart are two independent
 * draws from the same distribution. That pair — `kwgrid --jitter` against
 * `kwgrid` — is therefore a direct estimate of the per-seed spread, with the
 * change under test held at zero.
 *
 * From the paired differences d_i = a_i - b_i over the seeds:
 *
 *   sd(d) estimates the spread of a difference of two draws, so the spread of
 *   one draw is sd(d)/sqrt(2), and the standard error on a 32-seed mean is
 *   sd(d)/sqrt(2*n). A difference between two sweeps is a difference of two
 *   such means, so its own standard error is sd(d)/sqrt(n) — which is the
 *   number printed, and the one to judge an observed delta against.
 *
 * Reading the paired run's own aggregate delta as "the noise" underestimates
 * it: one draw of a quantity whose standard error is 2 points can easily land
 * within 0.1 of its partner, and that says nothing about the next pair.
 *
 *   node tools/kwstat.mjs --noise pre,pre-jitter --a B-pole --b B-rev
 */
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const load = (t) => JSON.parse(fs.readFileSync(path.join('.meas', t + '.json'), 'utf8')).all;

const [n0, n1] = flag('noise', 'pre,pre-jitter').split(',');
const NOISE = [load(n0), load(n1)];
const SETS = (flag('sets', null) || `${flag('a', 'B-pole')},${flag('b', 'B-rev')}`)
  .split(',').map(t => [t, load(t)]);

/* Every metric is a per-seed scalar, so each is a mean over seeds and each gets
   the same treatment. `won` is boolean per seed and is counted as a rate. */
const METRICS = [
  ['finish spread (s)', o => o.spread],
  ['lead changes', o => o.leadChanges],
  ['  ...in the last 70%', o => o.lateLead],
  ['  ...player-involved', o => o.playerLeadChanges],
  ['overtakes', o => o.overtakes],
  ['  ...in the last 70%', o => o.lateSeventy],
  ['player overtakes', o => o.playerOvertakes],
  ['passes made', o => o.gained],
  ['passes suffered', o => o.lost],
  ['within 60 m of a rival (%)', o => o.nearPct],
  ['player led (%)', o => o.ledPct],
  ['player wins (rate)', o => (o.won ? 1 : 0)],
  ['mean finishing position', o => o.finalPos],
  ['lonely tail (s)', o => o.lonelyTail],
  ['impact episodes', o => o.collisions],
  ['contact (% of frames)', o => o.touchPct],
  ['deepest interpenetration (m)', o => o.deepest],
  ['rival recoveries', o => o.rivalRecoveries],
  ['cars finished (of 4)', o => o.finishers],
  /* The band, because a reversed grid inverts which side of it the player sits
     on. `ahead of player` is the exposure — the fraction of the race a rival
     spends in the half of the band that CUTS it — and mean boost is what the
     whole chain actually delivers to the driver. If the band were working
     against the change, rival boost would fall. */
  ['rival mean band', o => mean(o.bands.map(b => b.band))],
  ['rival mean boost', o => mean(o.bands.map(b => b.boost))],
  ['rival % ahead of player', o => mean(o.bands.map(b => b.aheadPct))],
];

const seeds = Object.keys(NOISE[0]).map(Number).sort((a, b) => a - b)
  .filter(s => SETS.every(([, m]) => m[s]));
const n = seeds.length;

const sd = (xs) => {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / Math.max(1, xs.length - 1));
};

console.log(`\n  ${n} seeds.  noise pair: ${n0} vs ${n1}`);
console.log(`  se = standard error on a DIFFERENCE of two ${n}-seed means, from that pair.`);
console.log(`  A delta is called real at |delta| > 2*se.\n`);

const head = 'metric'.padEnd(30) + SETS.map(([t]) => t.padStart(11)).join('')
  + '        se   ' + SETS.slice(1).map(([t]) => `Δ vs ${SETS[0][0]}`).join('   ');
console.log('  ' + head);
console.log('  ' + '-'.repeat(head.length));

for (const [name, f] of METRICS) {
  const d = seeds.map(s => f(NOISE[0][s]) - f(NOISE[1][s]));
  const se = sd(d) / Math.sqrt(n);
  const means = SETS.map(([, m]) => mean(seeds.map(s => f(m[s]))));
  const deltas = means.slice(1).map((v, i) => {
    const dv = v - means[0];
    const real = Math.abs(dv) > 2 * se;
    return `${dv >= 0 ? '+' : ''}${dv.toFixed(2)}${real ? ' REAL' : '  (ns)'}`;
  });
  console.log('  ' + name.padEnd(30)
    + means.map(v => v.toFixed(2).padStart(11)).join('')
    + se.toFixed(2).padStart(10) + '   '
    + deltas.map(x => x.padStart(13)).join('   '));
}

console.log('\n  (ns) = not separable from run-to-run chaos at this sample size.');
