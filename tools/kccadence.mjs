/* AUDIT PROBE (round 2) — corrected copy of tools/zzcadence.mjs.
 *
 * Same question, same method: one lap on autopilot, and every SAMPLE seconds
 * the crowd's footprint measured by ablation off the real frame. What changed,
 * and why:
 *
 *  1. LEGIBLE FRACTION. zzcadence sums each on-screen run as (t1 - t0) where
 *     t0 and t1 are the first and last PASSING sample. A run of one sample
 *     therefore contributes zero seconds, and every run is short by one whole
 *     sample interval. On seed 22 that is 33 runs x 0.25 s = 8.25 s thrown
 *     away, which is 3.4 points of a 28.9% figure. Under the midpoint
 *     convention a run of k passing samples covers k*SAMPLE seconds, so that
 *     is what this sums. Self-check: sum(holes) + sum(runs) must equal the lap,
 *     and under zzcadence's arithmetic it does not.
 *     (Its HOLE durations are right under the same convention — a hole from
 *     the first failing sample to the first passing one is t1-t0 — so the
 *     longest-dead-stretch numbers need no correction. Both are printed.)
 *
 *  2. FIGURES vs FIGURES-PLUS-RAILS. zzcadence hides `crowd-figures` and
 *     `crowd-barriers` together and then calls the tallest column in the diff
 *     "the tallest figure". A sitters' rail is part of the crowd but it is not
 *     a figure. Both are measured here from the same pinned render: the
 *     figures-only diff (rails left visible) and the whole-crowd diff.
 *
 *  3. THREE THRESHOLDS from one pass — any pixel, 12 px, 20 px — because the
 *     audit asks for holes at 20 px and re-driving the lap per threshold would
 *     be three laps for data already in hand.
 *
 *  4. COLUMN HEIGHT, two ways. zzcadence's `tall` is the full vertical extent
 *     of diff pixels in one image column, which its own comment calls
 *     "connected" without testing connectivity: a head at y=400 and another
 *     group's boots at y=500 in the same column read as a 101 px figure.
 *     Also printed is the longest contiguous run in that column, allowing
 *     gaps of up to 3 px for the ink pass and for the air under a raised arm.
 *     If the two agree the metric is not what is being argued about.
 *
 *  5. Two renders after every visibility change, not one, so "discard frame 0"
 *     holds on both sides of the ablation and not just the first.
 *
 * Discipline kept from the original: performance.now() pinned across every
 * pair with the drift printed rather than assumed, 1600x900 through
 * g.pipeline.render(), autopilot on the wheel at 0.85.
 *
 *   node tools/kccadence.mjs [--seed 22] [--sample 0.25] [--json path]
 */
import fs from 'node:fs';
import path from 'node:path';
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEED = flag('seed', '22');
const SAMPLE = Number(flag('sample', '0.25'));
const JSONP = flag('json', '');

await run({
  width: 1600, height: 900,
  hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0`,
}, async ({ page }) => {
  page.setDefaultTimeout(900_000);
  const out = await page.evaluate(([sample]) => {
    const g = window.__game;
    const t = g.track;
    if (!g.crowd) return { none: true };
    const W = g.renderer.domElement.width, H = g.renderer.domElement.height;
    const gl = g.renderer.getContext();
    const mesh = g.scene.getObjectByName('crowd-figures');
    const rails = g.scene.getObjectByName('crowd-barriers');

    const grab = () => {
      const px = new Uint8Array(W * H * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return px;
    };
    const GAPOK = 3;
    const foot = (a, b) => {
      let n = 0;
      const colTop = new Int32Array(W).fill(-1);
      const colBot = new Int32Array(W).fill(-1);
      /* Per-column occupancy, so the contiguous-run metric can be computed
         without a second pass over the whole image. */
      const hit = new Uint8Array(W * H);
      for (let i = 0, p = 0; i < a.length; i += 4, p++) {
        if (Math.abs(a[i] - b[i]) > 6 || Math.abs(a[i + 1] - b[i + 1]) > 6
          || Math.abs(a[i + 2] - b[i + 2]) > 6) {
          n++;
          const x = p % W, y = H - 1 - ((p / W) | 0);
          if (colTop[x] < 0 || y < colTop[x]) colTop[x] = y;
          if (y > colBot[x]) colBot[x] = y;
          hit[y * W + x] = 1;
        }
      }
      let tall = 0, solid = 0;
      for (let x = 0; x < W; x++) {
        if (colTop[x] < 0) continue;
        tall = Math.max(tall, colBot[x] - colTop[x] + 1);
        let cur = 0, gap = 0, bestRun = 0;
        for (let y = colTop[x]; y <= colBot[x]; y++) {
          if (hit[y * W + x]) { cur += gap + 1; gap = 0; if (cur > bestRun) bestRun = cur; }
          else { gap++; if (gap > GAPOK) { cur = 0; gap = 0; } }
        }
        if (bestRun > solid) solid = bestRun;
      }
      return { n, tall, solid };
    };

    g.setPaused(true);
    g.goTo(0.0005);
    g.autopilot(true, 0.85);
    g.warp(0.5);

    const every = Math.max(1, Math.round(sample * 60));
    const samples = [];
    let frames = 0, driftMax = 0;
    const LIMIT = 60 * 60 * 6;

    while (g.player.s < t.length - 3 && frames < LIMIT) {
      g.step(1 / 60);
      frames++;
      if (frames % every) continue;

      const real = performance.now.bind(performance);
      const pinned = real();
      performance.now = () => pinned;
      mesh.visible = true; if (rails) rails.visible = true;
      g.renderOnce();               // frame 0, discarded
      g.renderOnce();
      const both = grab();
      g.renderOnce();
      const drift = foot(both, grab()).n;
      if (drift > driftMax) driftMax = drift;
      // figures only: rails stay in the frame
      mesh.visible = false;
      g.renderOnce(); g.renderOnce();
      const noFig = grab();
      // and the whole crowd, the way zzcadence measures it
      if (rails) rails.visible = false;
      g.renderOnce(); g.renderOnce();
      const noAny = grab();
      mesh.visible = true; if (rails) rails.visible = true;
      g.renderOnce();
      performance.now = real;

      const fig = foot(both, noFig);
      const all = foot(both, noAny);
      samples.push({
        t: +(frames / 60).toFixed(2), s: +g.player.s.toFixed(0),
        kmh: +g.player.kmh.toFixed(0),
        n: fig.n, tall: fig.tall, solid: fig.solid,
        nAll: all.n, tallAll: all.tall,
      });
    }

    const lap = frames / 60;
    /* Holes: from the first failing sample to the first passing one, which is
       the midpoint-convention duration and is what zzcadence reports. */
    const holesOf = pred => {
      const runs = [];
      let start = null;
      for (const sm of samples) {
        if (pred(sm)) {
          if (start !== null) { runs.push({ t0: start.t, t1: sm.t, s0: start.s, s1: sm.s }); start = null; }
        } else if (start === null) start = sm;
      }
      if (start !== null) {
        const last = samples[samples.length - 1];
        runs.push({ t0: start.t, t1: last.t, s0: start.s, s1: last.s });
      }
      return runs.map(r => ({ ...r, dt: +(r.t1 - r.t0).toFixed(2), ds: r.s1 - r.s0 }))
        .sort((a, b) => b.dt - a.dt);
    };
    /* Runs: k passing samples is k*SAMPLE seconds. zzcadence charges (k-1). */
    const runsOf = pred => {
      const out2 = [];
      let cur = null;
      for (const sm of samples) {
        if (pred(sm)) {
          if (!cur) cur = { t0: sm.t, s0: sm.s, k: 0, peak: 0, peakN: 0 };
          cur.t1 = sm.t; cur.s1 = sm.s; cur.k++;
          cur.peak = Math.max(cur.peak, sm.tall);
          cur.peakN = Math.max(cur.peakN, sm.n);
        } else if (cur) { out2.push(cur); cur = null; }
      }
      if (cur) out2.push(cur);
      return out2.map(r => ({
        t0: r.t0, t1: r.t1, s0: r.s0, s1: r.s1, k: r.k,
        dt: +(r.k * sample).toFixed(2), dtZZ: +(r.t1 - r.t0).toFixed(2),
        peak: r.peak, peakN: r.peakN,
      }));
    };

    const at = px => {
      const pred = px === 0 ? (sm => sm.n > 0) : (sm => sm.tall >= px);
      const runs = runsOf(pred);
      return {
        holes: holesOf(pred).slice(0, 10),
        runs,
        onTotal: +runs.reduce((a, r) => a + r.dt, 0).toFixed(2),
        onTotalZZ: +runs.reduce((a, r) => a + r.dtZZ, 0).toFixed(2),
      };
    };

    return {
      lap: +lap.toFixed(2), nSamples: samples.length, driftMax,
      length: +t.length.toFixed(0),
      sites: g.crowd.sites.map(p => ({
        kind: p.kind, s: +p.s.toFixed(0), side: p.side, seen: p.seen ?? null,
        n: (p.groups || []).reduce((a, b) => a + b.n, 0),
      })),
      px0: at(0), px12: at(12), px20: at(20),
      /* Where the two column metrics part company, as a check on the metric
         rather than on the crowd. */
      metric: {
        maxTall: Math.max(...samples.map(s2 => s2.tall)),
        worstSplit: samples.map(s2 => ({ t: s2.t, tall: s2.tall, solid: s2.solid }))
          .filter(s2 => s2.tall >= 12 && s2.solid < 12).length,
        railOnly: samples.filter(s2 => s2.tall < 12 && s2.tallAll >= 12).length,
      },
      samples,
    };
  }, [SAMPLE]);

  if (out.none) { console.log('  no crowd'); return; }
  const pc = v => (100 * v / out.lap).toFixed(1);
  console.log(`\n  seed ${SEED} — one lap, ${out.lap} s over ${out.length} m,`
    + ` ${out.nSamples} samples every ${SAMPLE} s`);
  console.log(`  pinned-clock drift across a static pair: ${out.driftMax} px`
    + `${out.driftMax ? '   <-- NOT CLEAN' : '  (clean)'}`);
  console.log(`  sites in g.crowd.sites: ${out.sites.length}`
    + `  (${out.sites.reduce((a, s) => a + s.n, 0)} figures in groups)`);

  for (const [name, key] of [['ANY PIXEL', 'px0'], ['>= 12 px', 'px12'], ['>= 20 px', 'px20']]) {
    const b = out[key];
    console.log(`\n  ── ${name} ──────────────────────────────────`);
    console.log(`  on screen: ${b.onTotal} s of ${out.lap} s  (${pc(b.onTotal)}%)`
      + `    [zzcadence arithmetic: ${b.onTotalZZ} s = ${pc(b.onTotalZZ)}%]`);
    console.log(`  ${b.runs.length} separate events`);
    console.log('  longest holes:');
    for (const h of b.holes.slice(0, 8)) {
      console.log(`    ${String(h.dt).padStart(6)} s   t ${h.t0}–${h.t1} s`
        + `   s ${h.s0}–${h.s1}  (${h.ds} m)`);
    }
  }

  console.log(`\n  EVENTS (>= 12 px), figures only:`);
  console.log('     #   from      to     k   ours    zz     s range       peak px');
  out.px12.runs.forEach((r, i) => {
    console.log(`    ${String(i + 1).padStart(2)}  ${String(r.t0).padStart(6)} s`
      + `  ${String(r.t1).padStart(6)} s ${String(r.k).padStart(3)}`
      + ` ${String(r.dt).padStart(6)} ${String(r.dtZZ).padStart(6)}`
      + `  ${String(r.s0).padStart(5)}–${String(r.s1).padStart(5)}`
      + `  ${String(r.peak).padStart(6)} px`);
  });

  console.log(`\n  metric check: tallest column all lap ${out.metric.maxTall} px;`
    + ` samples where full-extent >= 12 but longest contiguous run < 12: ${out.metric.worstSplit};`
    + ` samples legible only once the sitters' rail is counted: ${out.metric.railOnly}`);
  console.log();

  if (JSONP) {
    fs.mkdirSync(path.dirname(JSONP), { recursive: true });
    fs.writeFileSync(JSONP, JSON.stringify(out, null, 1));
    console.log('  json → ' + JSONP);
  }
});
finish(process.exitCode || 0);
