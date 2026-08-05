/* Score stage layouts across seeds.
 *
 * The generator is deterministic and has no DOM dependency, so this runs in
 * node in a fraction of a second per seed — no browser, no GPU. Picking the
 * stage by eye across three screenshots is how a knotted layout survives; this
 * ranks every candidate against the things that actually went wrong.
 *
 *   node tools/seeds.mjs [count]
 */
import { Track } from '../src/world/track.js';

const COUNT = +(process.argv[2] || 40);
const rows = [];

for (let seed = 1; seed <= COUNT; seed++) {
  const t = new Track(seed);
  let maxBank = 0, straight = 0;
  const radii = [];
  for (const f of t.frames) {
    maxBank = Math.max(maxBank, Math.abs(f.bank));
    if (Math.abs(f.curv) < 0.0015) straight += 3;
    if (Math.abs(f.curv) > 0.004) radii.push(1 / Math.abs(f.curv));
  }
  radii.sort((a, b) => a - b);
  const drop = t.startY - t.endY;
  const worst = t.crossings.length ? Math.min(...t.crossings.map(c => c.dy)) : 99;
  let spanX = 0, spanZ = 0, x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
  for (const f of t.frames) {
    x0 = Math.min(x0, f.pos.x); x1 = Math.max(x1, f.pos.x);
    z0 = Math.min(z0, f.pos.z); z1 = Math.max(z1, f.pos.z);
  }
  spanX = x1 - x0; spanZ = z1 - z0;

  /* A knot costs a lot, a tight knot costs more. Beyond that we want length,
     drop, a real proportion of straight, a wide spread of corner radii, and a
     basin that is roughly square rather than a narrow column. */
  const knotPenalty = t.crossings.length * 6 + (worst < 99 ? Math.max(0, 26 - worst) : 0);
  const aspect = Math.min(spanX, spanZ) / Math.max(spanX, spanZ);
  const score =
    -knotPenalty
    + Math.min(t.length, 5600) / 400
    + drop / 40
    + Math.min(straight / t.length, 0.3) * 40
    + Math.min((radii[radii.length - 1] || 0) / (radii[0] || 1), 12)
    + aspect * 14;

  rows.push({
    seed, score: +score.toFixed(1), len: Math.round(t.length), drop: Math.round(drop),
    grade: +((drop / t.length) * 100).toFixed(1),
    knots: t.crossings.length, worst: worst === 99 ? '-' : worst.toFixed(0),
    bank: +((maxBank * 180) / Math.PI).toFixed(1),
    strPct: Math.round((straight / t.length) * 100),
    rMin: Math.round(radii[0] || 0), rMax: Math.round(radii[radii.length - 1] || 0),
    basin: `${Math.round(spanX)}x${Math.round(spanZ)}`,
  });
}

rows.sort((a, b) => b.score - a.score);
const head = ['seed', 'score', 'len', 'drop', 'grade', 'knots', 'worst', 'bank', 'strPct', 'rMin', 'rMax', 'basin'];
console.log(head.map(h => h.padStart(7)).join(''));
for (const r of rows.slice(0, 14)) console.log(head.map(h => String(r[h]).padStart(7)).join(''));
console.log(`\nmedian knots: ${rows.map(r => r.knots).sort((a, b) => a - b)[rows.length >> 1]}`);
