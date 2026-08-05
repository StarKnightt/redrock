/* What the tunnel costs at run time, measured where it is.
 *
 * A whole-lap average hides a hundred-metre section. This parks the car on the
 * approach and drives it through the bore, sampling triangles, draw calls and
 * frame time on the way in, inside and on the way out, so the interior has its
 * own numbers rather than the stage's.
 *
 *   node tools/tperf.mjs [--seed 22]
 */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEED = flag('seed', '22');

await run({ width: 1920, height: 1080, hash: `manual&tier=high&seed=${SEED}&cap=0` }, async ({ page }) => {
  const out = await page.evaluate(async () => {
    const g = window.__game;
    const span = g.field.tunnel;
    const L = g.track.length;
    const marks = [
      ['approach 160 m', span.s0 - 160], ['approach 60 m', span.s0 - 60],
      ['portal', span.s0 - 4], ['inside, first third', span.s0 + (span.s1 - span.s0) * 0.33],
      ['inside, mid', (span.s0 + span.s1) / 2],
      ['inside, last third', span.s0 + (span.s1 - span.s0) * 0.72],
      ['exit', span.s1 - 6], ['past 60 m', span.s1 + 60],
    ];
    const rows = [];
    for (const [name, s] of marks) {
      g.driveTo(Math.max(0, Math.min(L - 5, s)) / L);
      g.setPaused(true);
      const times = [];
      let tris = 0, calls = 0;
      /* TWO triangle counts, because one of them has already been misread.
       *
       * The cel pipeline is several renderer.render() calls — a normals
       * prepass, an opt-in prepass, the beauty pass and a fullscreen
       * composite — and `renderer.info` is reset at the top of each of them.
       * Whatever it holds when the frame ends therefore describes the
       * composite's quad: one triangle, one call, on every seed and every
       * station. That is why the reset is held off below.
       *
       * But the accumulated figure is then the sum over ALL the passes, and
       * it runs at almost exactly 3x the scene — measured 738,315 against a
       * 246,514 scene on seed 22. It is the GPU's real workload and it is
       * worth having, but it is NOT the stage's triangle count, and the
       * ~736k figure this tool used to print under a bare "triangles"
       * heading has been read as a budget breach at least once. Both are
       * printed, each under its own name. */
      g.renderOnce();
      const scene = { ...g.pipeline.stats };   // beauty pass alone
      g.renderer.info.autoReset = false;
      for (let n = 0; n < 24; n++) {
        g.renderer.info.reset();
        const t0 = performance.now();
        g.renderOnce();
        times.push(performance.now() - t0);
        tris = Math.max(tris, g.renderer.info.render.triangles);
        calls = Math.max(calls, g.renderer.info.render.calls);
      }
      g.renderer.info.autoReset = true;
      g.renderer.info.reset();
      times.sort((a, b) => a - b);
      rows.push({
        name,
        s,
        tris, calls,
        sceneTris: scene.triangles, sceneCalls: scene.calls,
        median: times[times.length >> 1],
        p95: times[Math.floor(times.length * 0.95)],
      });
    }
    return { rows, s0: span.s0, s1: span.s1 };
  });
  console.log(`\n  bore ${out.s0.toFixed(0)}–${out.s1.toFixed(0)} m, 1920x1080, high tier\n`);
  console.log('  position                  station   scene tri   calls'
    + '   all-pass tri   calls   ms median   ms p95');
  for (const r of out.rows) {
    console.log(`  ${r.name.padEnd(22)} ${String(Math.round(r.s)).padStart(7)}`
      + ` ${String(r.sceneTris).padStart(11)} ${String(r.sceneCalls).padStart(7)}`
      + ` ${String(r.tris).padStart(14)} ${String(r.calls).padStart(7)}`
      + ` ${r.median.toFixed(2).padStart(11)} ${r.p95.toFixed(2).padStart(8)}`);
  }
  const worst = out.rows.reduce((a, b) => (b.sceneTris > a.sceneTris ? b : a), out.rows[0]);
  console.log(`\n  "scene tri" is what the stage costs — the beauty pass, snapshotted by the`
    + `\n  pipeline before the composite resets renderer.info. Compare budgets against it.`
    + `\n  "all-pass tri" is that plus the normals prepass, the opt-in prepass and the`
    + `\n  composite quad: about ${(worst.tris / Math.max(1, worst.sceneTris)).toFixed(1)}x`
    + ` the scene here. It is the GPU's workload, not a budget.\n`);
});
finish(process.exitCode || 0);
