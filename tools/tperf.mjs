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
       * But the accumulated figure is then the sum over ALL the passes. It is
       * the GPU's real workload and it is worth having, but it is NOT the
       * stage's triangle count, and the ~736k figure this tool used to print
       * under a bare "triangles" heading has been read as a budget breach at
       * least once. Both are printed, each under its own name.
       *
       * ── WHAT THE EXCESS ACTUALLY IS, because this note used to get it wrong
       *
       * The list above — normals prepass, opt-in prepass, beauty pass, quad —
       * accounts for about 2x the scene plus one triangle, not the 3x that was
       * being measured. The missing third was THE SUN'S SHADOW PASS, and it
       * was in there twice: three runs its shadow pass at the top of every
       * renderer.render(), and the pipeline made two of them over a lit scene.
       * Measured directly (tools/shcost.mjs, seed 22, open station): 255,471
       * beauty + ~255,471 normals + 263,830 shadow + 1 quad = 774,761, which
       * is the 3.03x this tool reported.
       *
       * The shadow pass is invisible to every other triangle report in the
       * tree for one reason: three calls info.reset() AFTER the shadow pass
       * (three.module.js:30081 then 30087), so any tool leaving info.autoReset
       * at its default cannot see it. This tool holds the reset off and so is
       * the only place it shows up — as an unexplained third of the workload.
       *
       * ── THE FIGURE HAS MOVED, AND DOWNWARDS IS CORRECT
       *
       * src/render/outline.js now builds the map once per frame instead of
       * twice. That removes one shadow pass from this column and nothing else.
       * Measured at 1920x1080, seed 22, mid-bore: 746,057 -> 621,570 all-pass
       * triangles and 273 -> 211 calls, i.e. 124,487 triangles and 62 calls
       * gone, while "scene tri" holds at 248,547 exactly. Ratio 3.00x -> 2.50x.
       * A DROP HERE IS THE SAVING, NOT A REGRESSION. */
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
    + `\n  "all-pass tri" is that plus the normals prepass, the opt-in prepass, THE`
    + `\n  SUN'S SHADOW PASS and the composite quad:`
    + ` ${(worst.tris / Math.max(1, worst.sceneTris)).toFixed(2)}x the scene here.`
    + `\n  It is the GPU's workload, not a budget. The shadow pass is the reason this`
    + `\n  is not simply 2x, and it is invisible to every other triangle report in the`
    + `\n  tree because three resets renderer.info AFTER it; this tool holds the reset`
    + `\n  off. It used to be counted TWICE (2.9-3.0x) because the pipeline built the`
    + `\n  map once per scene pass; it now builds it once per frame, so this column`
    + `\n  dropped by ~124,500 triangles and ~62 calls. THAT DROP IS THE SAVING.\n`);
});
finish(process.exitCode || 0);
