/* CRITIC PROBE — the longest stretch of the race with nobody in view.
 *
 * tools/cadence.mjs asks this of the landmark schedule and asks it the right
 * way: by closest approach, not by slot distance. It cannot be pointed at the
 * crowd, because the crowd is not in the landmark schedule. This asks the
 * same question of the crowd, and asks it harder — not "how close does the
 * road come to a group" but "is a group on the screen", which is the only
 * version of the question a player can perceive.
 *
 * Ground truth is the frame. The car runs one full lap on autopilot; every
 * SAMPLE seconds the pipeline renders twice, once with the crowd mesh visible
 * and once with it hidden, and the difference is the crowd's footprint in
 * pixels. Hiding the mesh takes the outline prepass with it — outline.js
 * mirrors `mesh.visible` onto its prepass proxy — so the diff is the figures
 * and their ink, not the figures alone.
 *
 * Two thresholds, because "on screen" and "legible" are different claims:
 *   present   any pixel at all
 *   legible   tallest figure in frame >= MINPX pixels
 *
 * performance.now() is pinned across each pair, so the grass and the turbines
 * cannot contribute a difference; the printed drift column is that guarantee
 * being checked rather than assumed.
 *
 *   node tools/zzcadence.mjs [--seed 22] [--sample 0.25] [--minpx 12]
 */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEED = flag('seed', '22');
const SAMPLE = Number(flag('sample', '0.25'));
const MINPX = Number(flag('minpx', '12'));

await run({
  width: 1600, height: 900,
  hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0`,
}, async ({ page }) => {
  page.setDefaultTimeout(600_000);
  const out = await page.evaluate(([sample, minpx]) => {
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
    /* Count and vertical extent of the crowd's footprint. Height is measured
       per connected column rather than as one global bounding box: two groups
       are never in frame together by design, but a flag on a raised arm and a
       sitter on a rail are, and a single box over both overstates the figure
       height. Tallest column is the tallest figure, near enough. */
    const foot = (a, b) => {
      let n = 0;
      const colTop = new Int32Array(W).fill(-1);
      const colBot = new Int32Array(W).fill(-1);
      for (let i = 0, p = 0; i < a.length; i += 4, p++) {
        if (Math.abs(a[i] - b[i]) > 6 || Math.abs(a[i + 1] - b[i + 1]) > 6
          || Math.abs(a[i + 2] - b[i + 2]) > 6) {
          n++;
          const x = p % W, y = H - 1 - ((p / W) | 0);
          if (colTop[x] < 0 || y < colTop[x]) colTop[x] = y;
          if (y > colBot[x]) colBot[x] = y;
        }
      }
      let tall = 0;
      for (let x = 0; x < W; x++) if (colTop[x] >= 0) tall = Math.max(tall, colBot[x] - colTop[x] + 1);
      return { n, tall };
    };

    g.setPaused(true);
    g.goTo(0.0005);
    g.autopilot(true, 0.85);
    g.warp(0.5);

    const every = Math.max(1, Math.round(sample * 60));
    const samples = [];
    let frames = 0, driftMax = 0;
    const LIMIT = 60 * 60 * 6;   // six minutes of simulation, a hard stop

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
      const withC = grab();
      g.renderOnce();
      const drift = foot(withC, grab()).n;
      if (drift > driftMax) driftMax = drift;
      mesh.visible = false; if (rails) rails.visible = false;
      g.renderOnce();
      const without = grab();
      mesh.visible = true; if (rails) rails.visible = true;
      performance.now = real;

      const f = foot(withC, without);
      samples.push({
        t: +(frames / 60).toFixed(2), s: +g.player.s.toFixed(0),
        kmh: +g.player.kmh.toFixed(0), n: f.n, tall: f.tall,
      });
    }

    const lap = frames / 60;
    const gapsOf = pred => {
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

    const present = gapsOf(sm => sm.n > 0);
    const legible = gapsOf(sm => sm.tall >= minpx);

    /* Contiguous runs where someone IS on screen — the events themselves, and
       how long each one lasts. A group that is technically present for eight
       seconds as a four-pixel smudge is not an event. */
    const onRuns = [];
    let cur = null;
    for (const sm of samples) {
      if (sm.tall >= minpx) {
        if (!cur) cur = { t0: sm.t, s0: sm.s, peak: 0, peakN: 0 };
        cur.t1 = sm.t; cur.s1 = sm.s;
        cur.peak = Math.max(cur.peak, sm.tall);
        cur.peakN = Math.max(cur.peakN, sm.n);
      } else if (cur) { onRuns.push(cur); cur = null; }
    }
    if (cur) onRuns.push(cur);

    return {
      lap: +lap.toFixed(1), nSamples: samples.length, driftMax,
      length: +t.length.toFixed(0),
      present: present.slice(0, 6), legible: legible.slice(0, 6),
      onRuns: onRuns.map(r => ({
        t0: +r.t0.toFixed(1), t1: +r.t1.toFixed(1),
        dt: +(r.t1 - r.t0).toFixed(1), s0: r.s0, s1: r.s1,
        peak: r.peak, peakN: r.peakN,
      })),
      onTotal: +onRuns.reduce((a, r) => a + (r.t1 - r.t0), 0).toFixed(1),
    };
  }, [SAMPLE, MINPX]);

  if (out.none) { console.log('  no crowd'); return; }
  console.log(`\n  seed ${SEED} — one lap, ${out.lap} s over ${out.length} m,`
    + ` ${out.nSamples} samples every ${SAMPLE} s`);
  console.log(`  pinned-clock drift across a static pair: ${out.driftMax} px`
    + `${out.driftMax ? '   ◀── NOT CLEAN' : '  (clean)'}`);

  console.log(`\n  EVENTS — contiguous stretches with a figure >= ${MINPX} px on screen:`);
  console.log('     #   from      to      lasts    s range        tallest  peak px');
  out.onRuns.forEach((r, i) => {
    console.log(`    ${String(i + 1).padStart(2)}  ${String(r.t0).padStart(6)} s`
      + `  ${String(r.t1).padStart(6)} s  ${String(r.dt).padStart(6)} s`
      + `  ${String(r.s0).padStart(5)}–${String(r.s1).padStart(5)}`
      + `  ${String(r.peak).padStart(8)} px  ${String(r.peakN).padStart(6)}`);
  });
  console.log(`\n  total time with a legible group on screen: ${out.onTotal} s`
    + ` of ${out.lap} s  (${(100 * out.onTotal / out.lap).toFixed(1)}%)`);

  console.log(`\n  LONGEST STRETCHES WITH NOBODY LEGIBLE (>= ${MINPX} px):`);
  for (const gp of out.legible) {
    console.log(`    ${String(gp.dt).padStart(6)} s   t ${gp.t0}–${gp.t1} s`
      + `   s ${gp.s0}–${gp.s1}  (${gp.ds} m)`);
  }
  console.log('\n  LONGEST STRETCHES WITH NOT ONE CROWD PIXEL:');
  for (const gp of out.present) {
    console.log(`    ${String(gp.dt).padStart(6)} s   t ${gp.t0}–${gp.t1} s`
      + `   s ${gp.s0}–${gp.s1}  (${gp.ds} m)`);
  }
  console.log();
});
finish(process.exitCode || 0);
