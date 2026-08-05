/* CRITIC PROBE — is the "no local maxima" claim true?
 *
 * environment.js line ~5492 claims this stage has zero local maxima in its
 * elevation profile at a 15 cm prominence threshold, on seeds 22, 1 and 40,
 * and that the largest convexity lifts the road 2.2 m above the chord between
 * points 70 m either side. Written from scratch rather than reusing anything
 * the implementer wrote, because the whole point is not to inherit their
 * definition of "hill".
 *
 * Three independent measures, because "hilltop" is not one thing:
 *
 *   maxima     true topographic local maxima with prominence, computed the
 *              way a topographer would: for each candidate peak, walk out
 *              both ways to the lower of the two flanking minima before the
 *              profile exceeds the peak again. That number is the prominence.
 *   rises      any contiguous stretch where the road gains height at all,
 *              and how much. A 470 m net descent can still climb in places,
 *              and a climb followed by a fall is a crest to a driver whether
 *              or not it is a topographic peak.
 *   convexity  the implementer's own metric — height above the chord between
 *              s±W — reported over a sweep of W so it cannot be a lucky
 *              window. This is what actually hides road from a driver.
 *
 *   node tools/zzhills.mjs [--seeds 22,1,40] [--prom 0.15]
 */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEEDS = flag('seeds', '22,1,40').split(',');
const PROM = Number(flag('prom', '0.15'));

for (const SEED of SEEDS) {
  await run({
    width: 320, height: 200,
    hash: `manual&tier=high&seed=${SEED}&cap=60&hud=0`,
  }, async ({ page }) => {
    const out = await page.evaluate(([prom]) => {
      const g = window.__game;
      const t = g.track;
      const L = t.length;
      const STEP = 1;
      const n = Math.floor(L / STEP);
      const y = new Float64Array(n + 1);
      for (let i = 0; i <= n; i++) y[i] = t.frameAt(i * STEP).pos.y;

      /* Local maxima with true prominence. A sample is a peak if it is >= both
         neighbours and > at least one; prominence is the peak height minus the
         higher of the two "key cols" — the highest low point on the way out to
         higher ground in each direction. Ends of the profile count as reaching
         higher ground only if nothing higher exists that way, in which case the
         flank minimum stands. */
      const peaks = [];
      for (let i = 1; i < n; i++) {
        if (!(y[i] >= y[i - 1] && y[i] >= y[i + 1] && (y[i] > y[i - 1] || y[i] > y[i + 1]))) continue;
        // Walk left
        let colL = y[i];
        for (let j = i - 1; j >= 0; j--) {
          if (y[j] > y[i]) break;
          if (y[j] < colL) colL = y[j];
        }
        let colR = y[i];
        for (let j = i + 1; j <= n; j++) {
          if (y[j] > y[i]) break;
          if (y[j] < colR) colR = y[j];
        }
        const p = y[i] - Math.max(colL, colR);
        if (p >= prom) peaks.push({ s: i * STEP, y: y[i], prom: p });
      }
      peaks.sort((a, b) => b.prom - a.prom);

      /* Contiguous rises: stretches where elevation is monotonically
         non-decreasing over a window, with total gain. Smoothed over 5 m so
         mesh-level noise does not manufacture ten thousand of them. */
      const SM = 5;
      const ys = new Float64Array(n + 1);
      for (let i = 0; i <= n; i++) {
        let a = 0, c = 0;
        for (let k = -SM; k <= SM; k++) {
          const j = i + k;
          if (j < 0 || j > n) continue;
          a += y[j]; c++;
        }
        ys[i] = a / c;
      }
      const rises = [];
      let start = null;
      for (let i = 1; i <= n; i++) {
        const up = ys[i] > ys[i - 1];
        if (up && start === null) start = i - 1;
        if (!up && start !== null) {
          const gain = ys[i - 1] - ys[start];
          if (gain > 0.25) rises.push({ s0: start, s1: i - 1, gain, len: i - 1 - start });
          start = null;
        }
      }
      if (start !== null) {
        const gain = ys[n] - ys[start];
        if (gain > 0.25) rises.push({ s0: start, s1: n, gain, len: n - start });
      }
      rises.sort((a, b) => b.gain - a.gain);

      /* Convexity above the chord, swept over half-widths. */
      const conv = [];
      for (const W of [30, 50, 70, 100, 150]) {
        let best = -Infinity, bestS = 0;
        for (let i = W; i <= n - W; i++) {
          const c = y[i] - 0.5 * (y[i - W] + y[i + W]);
          if (c > best) { best = c; bestS = i; }
        }
        conv.push({ W, rise: best, s: bestS });
      }

      /* Net profile shape, for context. */
      let hi = -Infinity, lo = Infinity, hiS = 0, loS = 0;
      for (let i = 0; i <= n; i++) {
        if (y[i] > hi) { hi = y[i]; hiS = i; }
        if (y[i] < lo) { lo = y[i]; loS = i; }
      }

      /* Where does the crowd actually stand, and did any of it land on a
         convexity? Reported so the two questions can be compared directly. */
      const sites = (g.crowd?.sites || []).map(s => ({ kind: s.kind, s: Math.round(s.s) }));

      return {
        L, peaks: peaks.slice(0, 12), nPeaks: peaks.length,
        rises: rises.slice(0, 8), nRises: rises.length,
        conv, hi, lo, hiS, loS, sites,
        totalDrop: y[0] - y[n],
      };
    }, [PROM]);

    console.log(`\n══ seed ${SEED} — track ${out.L.toFixed(0)} m`);
    console.log(`   profile: high ${out.hi.toFixed(1)} m at s=${out.hiS}, `
      + `low ${out.lo.toFixed(1)} m at s=${out.loS}, `
      + `start-to-end drop ${out.totalDrop.toFixed(1)} m`);
    console.log(`\n   LOCAL MAXIMA at prominence >= ${PROM} m: ${out.nPeaks}`);
    for (const p of out.peaks) {
      console.log(`     s=${String(p.s).padStart(5)}  y=${p.y.toFixed(1).padStart(7)} m`
        + `  prominence ${p.prom.toFixed(2)} m`);
    }
    console.log(`\n   CONTIGUOUS RISES (5 m smoothed, gain > 0.25 m): ${out.nRises}`);
    for (const rr of out.rises) {
      console.log(`     s=${String(rr.s0).padStart(5)}–${String(rr.s1).padStart(5)}`
        + `  (${String(rr.len).padStart(4)} m)  gain ${rr.gain.toFixed(2)} m`
        + `  grade ${(100 * rr.gain / Math.max(rr.len, 1)).toFixed(1)}%`);
    }
    console.log('\n   CONVEXITY above the chord between s±W:');
    for (const c of out.conv) {
      console.log(`     W=${String(c.W).padStart(4)} m   max ${c.rise.toFixed(2)} m at s=${c.s}`);
    }
    console.log(`\n   crowd sites: ${out.sites.map(s => `${s.kind}@${s.s}`).join(', ')}`);
  });
}
console.log();
finish(process.exitCode || 0);
