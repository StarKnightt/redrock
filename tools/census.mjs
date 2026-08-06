/* Is the world still populated?
 *
 * Nothing in the suite gated this, and for a game whose whole identity is a dense
 * procedural coast that is a serious hole. It was found the expensive way. A
 * course-wide keepout added to src/world/environment.js to stop vegetation being
 * planted on the road was, in its first form, missing an along-track test: it
 * deleted 1600 of 8290 scenery placements a seed — 19% of the world, including the
 * whole berm rank — and EVERY GATE STAYED GREEN. `verge` was green because
 * over-deleting is a superset of "nothing in the corridor"; `boot` was green
 * because a thinner world still boots; `budget` was green because fewer triangles
 * is the safe direction of a ceiling. The only thing that caught it was a
 * disagreement between a probe's drop count and `budget`'s printed instance count,
 * which is luck, not design.
 *
 * So: count what got placed, per seed, per category, and refuse a world that has
 * quietly lost its scenery.
 *
 *   node tools/census.mjs [--seeds 22,1,...] [--dump] [--all]
 *
 * `--dump` prints a BASELINE block ready to paste over the one below, which is how
 * a deliberate content change is re-baselined. `--all` lists every category rather
 * than only the ones that moved.
 */
import { Track } from '../src/world/track.js';
import { buildEnvironment } from '../src/world/environment.js';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const has = k => args.includes('--' + k);
/* The shipped set, matching tools/boot.mjs and tools/verge.mjs. */
const BOOT_SEEDS = '22,1,7,12,14,16,20,23,26,27,28,34,36,40';
const SEEDS = String(flag('seeds', BOOT_SEEDS))
  .split(',').map(s => +s.trim()).filter(Number.isFinite);
const DUMP = has('dump');
const ALL = has('all');

if (!SEEDS.length) {
  console.log('  ✗ no seeds to census');
  process.exit(1);
}

/* ------------------------------------------------------------------ *
 * What is counted
 * ------------------------------------------------------------------ */

/* Instanced placements only. A merged static mesh either exists or does not and
 * `boot` already dies if a builder throws; what can thin silently is a rank that
 * places fewer things than it used to.
 *
 * Grouped by family, not by mesh: `ridge-trees-0` and `ridge-trees-1` are two
 * proxy variants chosen per plant by `r.chance(0.3)`, so the split between them is
 * an implementation detail that can shift without the world thinning at all.
 * Counting the family avoids a gate that fires on a coin-flip. The cost is stated
 * in the limits section at the bottom of this file. */
const family = name => name.replace(/-\d+$/, '');

function census(seed) {
  const track = new Track(seed);
  const env = buildEnvironment(track, { seed });
  const counts = new Map();
  env.traverse((o) => {
    if (!o.isInstancedMesh) return;
    const key = family(o.name);
    counts.set(key, (counts.get(key) || 0) + o.count);
  });
  return counts;
}

/* ------------------------------------------------------------------ *
 * The bars, and where every number came from
 * ------------------------------------------------------------------ */

/* A FLOOR, not a band, and per category rather than in total.
 *
 * Per category. A total hides one category vanishing while another grows. It would
 * in fact have caught this particular near miss — the total fell 19% — but only
 * because the bug was indiscriminate. Measured per family, the same bug ranges from
 * -24.4% (ridge-trees) to -1.4% (leafy-shrubs), so a bug that hit one family hard
 * and left the rest alone could hide inside a total and not inside this. The usual
 * argument against per-category is noise; there is none here, because a seed's
 * counts are fully deterministic, so the extra strictness costs nothing.
 *
 * A floor rather than a two-sided band, for the same reason. With no noise to
 * absorb, the margin is not a confidence interval — it is a policy about how large a
 * deliberate change may pass without being written down. The failure this gate
 * exists for is loss. Growth is the change this project makes constantly and on
 * purpose, because density is load-bearing here, so a symmetric band would fire on
 * the most common legitimate edit in the repository. That is precisely how a gate
 * becomes something people re-baseline reflexively and then stop reading. Growth is
 * therefore reported and not failed — except past CEILING_MULT, which no deliberate
 * content change plausibly reaches and a runaway loop easily does.
 *
 * DROP_FRAC = 0.05. Derived from the two changes to this filter that have actually
 * happened, which bracket it by a wide margin:
 *   - the correct fix (the shipped course-wide keepout) moves no family on any seed
 *     by more than 0.25% — 12 placements of 5539 ridge-trees on seed 1. 5% sits 20x
 *     above the largest real incidental change measured.
 *   - the near miss deletes at least 18.5% of ridge-trees and 11.5% of boulders on
 *     EVERY ONE of the fourteen seeds, and at least 10.0% of coastal-trees. 5% sits
 *     more than 2x below the smallest of those, so the gate catches it three
 *     independent ways rather than by a whisker.
 *
 * DROP_MIN = 8 placements. A family of nine turbine rotors losing one is -11% and
 * means nothing; without an absolute floor the gate would be noise on the small
 * families. 8 is far below any loss that matters — the near miss sheds 861 to 1359
 * ridge-trees per seed — and above the ±1 that small families move over.
 *
 * A family emptying is always a failure whatever its size, because DROP_MIN would
 * otherwise let the two lighthouse beams disappear in silence. */
const DROP_FRAC = 0.05;
const DROP_MIN = 8;
const GROW_FRAC = 0.05;
/* Deliberate content growth in this repository arrives in increments; a rank added
   or a stride shortened moves a family by tens of per cent, not multiples. A loop
   whose bound has broken multiplies it. 3x sits above the former and below the
   latter. Measured against the `census-runaway` break, which puts six times the
   corridor-floor rank in: ridge-trees land at 1.45x to 1.50x across the fourteen
   seeds, which passes this bar deliberately and fails `budget` instead, at 17,043
   triangles over the ceiling. See the note on over-population at the foot of this
   file. */
const CEILING_MULT = 3;

/* ------------------------------------------------------------------ *
 * BASELINE — regenerate with --dump
 * ------------------------------------------------------------------ */

const BASELINE = {
  'blaze-heads': { 22: 324, 1: 237, 7: 288, 12: 218, 14: 288, 16: 196, 20: 220, 23: 249, 26: 226, 27: 154, 28: 247, 34: 213, 36: 204, 40: 208 },
  'blaze-stems': { 22: 324, 1: 237, 7: 288, 12: 218, 14: 288, 16: 196, 20: 220, 23: 249, 26: 226, 27: 154, 28: 247, 34: 213, 36: 204, 40: 208 },
  'block-clouds': { 22: 100, 1: 100, 7: 100, 12: 100, 14: 100, 16: 100, 20: 100, 23: 100, 26: 100, 27: 100, 28: 100, 34: 100, 36: 100, 40: 100 },
  'boulders': { 22: 1671, 1: 1576, 7: 1711, 12: 1567, 14: 1595, 16: 1564, 20: 1582, 23: 1668, 26: 1578, 27: 1524, 28: 1586, 34: 1602, 36: 1527, 40: 1612 },
  'coastal-trees': { 22: 485, 1: 478, 7: 515, 12: 482, 14: 469, 16: 429, 20: 432, 23: 431, 26: 435, 27: 422, 28: 478, 34: 430, 36: 474, 40: 450 },
  'corner-hay-bales': { 22: 24, 1: 37, 7: 32, 12: 31, 14: 24, 16: 32, 20: 32, 23: 28, 26: 37, 27: 39, 28: 24, 34: 33, 36: 32, 40: 35 },
  'corner-tyre-barriers': { 22: 79, 1: 77, 7: 46, 12: 99, 14: 80, 16: 61, 20: 55, 23: 63, 26: 57, 27: 62, 28: 67, 34: 72, 36: 72, 40: 82 },
  'flower-heads': { 22: 108, 1: 127, 7: 90, 12: 103, 14: 95, 16: 102, 20: 97, 23: 120, 26: 108, 27: 116, 28: 98, 34: 87, 36: 94, 40: 118 },
  'flower-stems': { 22: 108, 1: 127, 7: 90, 12: 103, 14: 95, 16: 102, 20: 97, 23: 120, 26: 108, 27: 116, 28: 98, 34: 87, 36: 94, 40: 118 },
  'hairpin-chevron-signs': { 22: 30, 1: 30, 7: 30, 12: 30, 14: 30, 16: 30, 20: 30, 23: 30, 26: 30, 27: 30, 28: 30, 34: 30, 36: 30, 40: 30 },
  'headland-depth': { 22: 19, 1: 20, 7: 20, 12: 20, 14: 20, 16: 19, 20: 19, 23: 19, 26: 21, 27: 20, 28: 20, 34: 19, 36: 21, 40: 19 },
  'leafy-shrubs': { 22: 424, 1: 430, 7: 444, 12: 465, 14: 413, 16: 379, 20: 413, 23: 346, 26: 412, 27: 383, 28: 430, 34: 405, 36: 470, 40: 431 },
  'lighthouse-beams': { 22: 2, 1: 2, 7: 2, 12: 2, 14: 2, 16: 2, 20: 2, 23: 2, 26: 2, 27: 2, 28: 2, 34: 2, 36: 2, 40: 2 },
  'ridge-trees': { 22: 5710, 1: 5527, 7: 5338, 12: 5161, 14: 5558, 16: 4548, 20: 4582, 23: 5132, 26: 4707, 27: 4722, 28: 5058, 34: 4879, 36: 4613, 40: 5006 },
  'swaying-roadside-grass': { 22: 829, 1: 808, 7: 805, 12: 715, 14: 795, 16: 718, 20: 677, 23: 751, 26: 695, 27: 666, 28: 737, 34: 759, 36: 710, 40: 793 },
  'turbine-rotors': { 22: 12, 1: 11, 7: 13, 12: 11, 14: 8, 16: 7, 20: 11, 23: 16, 26: 8, 27: 12, 28: 10, 34: 9, 36: 11, 40: 9 },
  'verge-markers': { 22: 564, 1: 478, 7: 488, 12: 455, 14: 520, 16: 380, 20: 382, 23: 488, 26: 377, 27: 432, 28: 447, 34: 419, 36: 411, 40: 426 },
};

/* ------------------------------------------------------------------ *
 * Run
 * ------------------------------------------------------------------ */

const measured = new Map();
for (const seed of SEEDS) measured.set(seed, census(seed));

function dumpBaseline() {
  const families = [...new Set([...measured.values()].flatMap(m => [...m.keys()]))].sort();
  console.log('const BASELINE = {');
  for (const f of families) {
    const row = SEEDS.map(s => `${s}: ${measured.get(s).get(f) || 0}`).join(', ');
    console.log(`  '${f}': { ${row} },`);
  }
  console.log('};');
}

if (DUMP) { dumpBaseline(); process.exit(0); }

if (!Object.keys(BASELINE).length) {
  dumpBaseline();
  console.log('\n  ✗ no baseline recorded — paste the block above into tools/census.mjs');
  process.exit(1);
}

/* Every family named in the baseline is checked on every seed the baseline knows
   about, so a family that stops being built at all reads as zero rather than as
   nothing to compare. That is the direction this gate is for. */
const rows = [];
let lost = 0, runaway = 0, grew = 0, checked = 0, unbaselined = 0;

for (const seed of SEEDS) {
  const counts = measured.get(seed);
  for (const [f, byseed] of Object.entries(BASELINE)) {
    const base = byseed[seed];
    if (base === undefined) continue;      // seed outside the baseline, see --dump
    checked++;
    const now = counts.get(f) || 0;
    const delta = now - base;
    const frac = base ? delta / base : 0;
    let verdict = null;
    if (now === 0 && base > 0) verdict = 'EMPTY';
    else if (delta < 0 && -frac >= DROP_FRAC && -delta >= DROP_MIN) verdict = 'THINNED';
    else if (base > 0 && now >= base * CEILING_MULT) verdict = 'RUNAWAY';
    else if (frac >= GROW_FRAC) verdict = 'grew';
    if (verdict === 'EMPTY' || verdict === 'THINNED') lost++;
    else if (verdict === 'RUNAWAY') runaway++;
    else if (verdict === 'grew') grew++;
    if (verdict || ALL) rows.push({ seed, f, base, now, delta, frac, verdict });
  }
  /* A family that appears in the build but not in the baseline is not judged. Say
     so rather than pass over it — an unjudged category is how this hole opened. */
  for (const f of counts.keys()) if (!(f in BASELINE)) unbaselined++;
}

const pct = v => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`;
for (const r of rows.sort((a, b) => a.frac - b.frac)) {
  const tag = r.verdict === 'EMPTY' || r.verdict === 'THINNED' ? '✗'
    : r.verdict === 'RUNAWAY' ? '✗' : r.verdict === 'grew' ? '!' : ' ';
  console.log(`  ${tag} seed ${String(r.seed).padStart(2)}  ${r.f.padEnd(24)}`
    + ` ${String(r.base).padStart(5)} → ${String(r.now).padStart(5)}`
    + `  ${pct(r.frac).padStart(7)}  ${r.verdict || ''}`);
}

/* A gate with nothing to check has not passed. */
if (!checked) {
  console.log('  ✗ nothing was censused');
  process.exit(1);
}

console.log(`\n  ${checked} category-seed pairs checked across ${SEEDS.length} seed(s)`
  + `${unbaselined ? `, ${unbaselined} not in the baseline` : ''}`);

if (lost || runaway) {
  if (lost) {
    console.log(`  ✗ the world has thinned: ${lost} category-seed pair(s) below the`
      + ` floor of ${DROP_FRAC * 100}% and ${DROP_MIN} placements`);
  }
  if (runaway) {
    console.log(`  ✗ scenery has run away: ${runaway} pair(s) at or past ${CEILING_MULT}x`
      + ' the baseline');
  }
  console.log('  If the change was deliberate, re-baseline with:'
    + ' node tools/census.mjs --dump');
  process.exit(1);
}

console.log(`  ✓ the world is still populated${grew ? ` (${grew} pair(s) grew, which is` +
  ' allowed and only noted)' : ''}`);
process.exit(0);

/* ------------------------------------------------------------------ *
 * What this gate cannot see
 * ------------------------------------------------------------------ *
 *
 * Worth being explicit, because a gate trusted past its reach is worse than none.
 *
 * 1. POSITION. It counts placements, it does not look at where they are. A build
 *    that put every tree inside the cliff, or all of them at the origin, censuses
 *    identically. `verge` covers one narrow aspect of position — the driving
 *    corridor — and nothing covers "buried in rock" or "hanging in the air".
 * 2. A SLOW RATCHET. This is the real limit. A loss of 4% a round is invisible to a
 *    5% floor forever, and eight such rounds would take a third of the scenery
 *    without ever going red. The floor cannot be closed to zero without failing on
 *    every deliberate edit, so this is a trade and not an oversight. What makes it
 *    survivable is that the baseline is a written record: a reviewer comparing a
 *    --dump against the committed block sees drift a gate cannot.
 * 3. VARIANT SPLITS, deliberately. `ridge-trees-0` giving ground to `ridge-trees-1`
 *    is not a thinning and does not register, because the split is a per-plant coin
 *    flip.
 * 4. SEEDS OUTSIDE THE SHIPPED FOURTEEN. Same limit `boot` and `verge` have.
 * 5. CATEGORIES NOT BUILT BY buildEnvironment. Crowd figures, for instance, are
 *    assembled elsewhere and never reach this traverse. The count of unbaselined
 *    families is printed so a new category cannot slip in unjudged.
 * 6. GEOMETRY GETTING CHEAPER at a constant count — a tree silhouette quietly
 *    dropping from eight triangles to two. `budget` sees that; this does not.
 *
 * ON OVER-POPULATION, and why it is a note rather than a bar.
 *
 * Growth past 5% is printed and passes. The reasoning is that the upper direction is
 * already gated by the thing that actually suffers from it: `budget` fails at
 * 260,000 triangles and currently has 1297 spare, so scenery cannot grow much on the
 * budget seed without going red. That cover is genuinely partial — `budget` reads one
 * seed, and `boot` prints per-seed triangles without gating them — so the distant
 * CEILING_MULT bar exists to catch a runaway loop on the other thirteen.
 *
 * This was tested rather than assumed. The `census-runaway` break puts six times the
 * corridor-floor rank in; ridge-trees rise 45.4% to 49.8% across the fourteen seeds,
 * this gate notes the growth and passes, and `budget` fails at 277,043 triangles
 * against a 260,000 ceiling. So the division of labour holds: this gate owns the
 * direction nothing else watches, and defers the direction something already does,
 * to the tool that measures the cost rather than the count. Gating growth here as
 * well would fail on deliberate content additions — the most common legitimate edit
 * in this repository — while telling us nothing `budget` does not. */
