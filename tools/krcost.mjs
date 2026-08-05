/* ROUND-2 RE-CHECK — what the crowd costs, resolved below the clock tick.
 *
 * tools/crowdperf.mjs times the animation-frame callback with
 * performance.now(). Two things make it unable to answer this question:
 *
 *   resolution   Chromium clamps performance.now() to 100 us, so its medians
 *                come out on a 0.1 ms lattice. A 0.05 ms answer is one lattice
 *                step: it is the difference between two quantised numbers, not
 *                a measurement of anything.
 *   what it times  the callback returns as soon as the draw calls are queued.
 *                On a GPU-bound frame that is not the cost.
 *
 * So: batch. Render the same pinned frame M times and then read one pixel,
 * which blocks until the GPU has drained, and time the batch. Per-frame cost is
 * the batch over M, and with M = 200 the resolution is 5 us. Crowd shown and
 * hidden are alternated in blocks so a thermal or scheduler drift over the run
 * cannot be read as a cost, and the whole thing is repeated.
 *
 * A real GPU timer query is tried first and reported if it exists;
 * EXT_disjoint_timer_query_webgl2 is normally off in Chrome.
 *
 *   node tools/krcost.mjs [--seed 22] [--m 200] [--reps 6]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEED = flag('seed', '22');
const M = +flag('m', 200);
const REPS = +flag('reps', 6);

let out = null;
await run({
  width: 1600, height: 900,
  hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0`,
}, async ({ page, gl }) => {
  out = await page.evaluate(([M, REPS]) => {
    const g = window.__game;
    const t = g.track;
    const glc = g.renderer.getContext();
    const mesh = g.scene.getObjectByName('crowd-figures');
    const rail = g.scene.getObjectByName('crowd-barriers');

    const timerExt = glc.getExtension('EXT_disjoint_timer_query_webgl2')
      || glc.getExtension('EXT_disjoint_timer_query');

    // the busiest site, which is the worst case
    const sites = g.crowd.sites;
    let site = sites[0];
    for (const c of sites) {
      const n = c.groups.reduce((a, b) => a + b.n, 0);
      if (!site || n > site.groups.reduce((a, b) => a + b.n, 0)) site = c;
    }
    g.setPaused(true);
    g.autopilot(true, 0.85);
    g.goTo(Math.max(0, site.s - 220) / t.length);
    g.warp(0.75);
    for (let k = 0; k < 400 && g.player.s < site.s - 24; k++) g.step(1 / 60);

    const real = performance.now.bind(performance);
    const pinned = real();
    performance.now = () => pinned;

    const one = new Uint8Array(4);
    /* One pixel out of the default framebuffer. readPixels is a synchronous
       round trip, so it does not return until the queued work is done — which
       is the whole point of putting it at the end of a batch. */
    const drain = () => {
      glc.bindFramebuffer(glc.FRAMEBUFFER, null);
      glc.readPixels(0, 0, 1, 1, glc.RGBA, glc.UNSIGNED_BYTE, one);
    };
    const show = v => { mesh.visible = v; if (rail) rail.visible = v; };

    const batch = (m) => {
      drain();
      const t0 = real();
      for (let i = 0; i < m; i++) g.renderOnce();
      drain();
      return real() - t0;
    };

    show(true);  for (let i = 0; i < 40; i++) g.renderOnce();   // warm up, shaders compiled
    show(false); for (let i = 0; i < 40; i++) g.renderOnce();
    drain();

    const on = [], off = [];
    let calls = { on: 0, off: 0 }, tris = { on: 0, off: 0 };
    for (let r = 0; r < REPS; r++) {
      // shown first on even reps, hidden first on odd, so order cannot bias
      const order = r % 2 ? [false, true] : [true, false];
      for (const v of order) {
        show(v);
        g.renderOnce();
        const st = g.pipeline.stats;
        if (v) { calls.on = st.calls; tris.on = st.triangles; }
        else { calls.off = st.calls; tris.off = st.triangles; }
        const ms = batch(M) / M;
        (v ? on : off).push(+ms.toFixed(4));
      }
    }

    let gpuTimer = null;
    if (timerExt) {
      const q = glc.createQuery();
      glc.beginQuery(timerExt.TIME_ELAPSED_EXT, q);
      show(true); for (let i = 0; i < 20; i++) g.renderOnce();
      glc.endQuery(timerExt.TIME_ELAPSED_EXT);
      gpuTimer = 'extension present — see raw json';
      try { glc.deleteQuery(q); } catch (e) { /* ignore */ }
    }

    performance.now = real;
    show(true);

    const med = v => { const s = v.slice().sort((a, b) => a - b); return s[s.length >> 1]; };
    return {
      site: site.kind, siteS: Math.round(site.s), siteN: site.groups.reduce((a, b) => a + b.n, 0),
      figures: g.crowd.figures, atS: Math.round(g.player.s),
      M, REPS, on, off,
      medOn: med(on), medOff: med(off),
      minOn: Math.min(...on), minOff: Math.min(...off),
      calls, tris,
      timerQuery: timerExt ? (gpuTimer || 'present') : 'ABSENT — no GPU timer query in this browser',
      clockGranularity: (() => {
        // smallest non-zero step performance.now() will report
        let best = Infinity;
        for (let i = 0; i < 20000; i++) {
          const a = real(), b = real();
          if (b > a && b - a < best) best = b - a;
        }
        return +best.toFixed(4);
      })(),
    };
  }, [M, REPS]);
  out.adapter = gl.renderer;
});

if (out) {
  console.log(`\n  seed ${SEED} — ${out.site} s=${out.siteS} (${out.siteN} figures at the site,`
    + ` ${out.figures} on the stage), car at s=${out.atS}`);
  console.log(`  ${out.adapter}`);
  console.log(`  ${out.M} renders a batch, ${out.REPS} alternating blocks each way,`
    + ` clock pinned, one readPixels to drain the GPU at each end of a batch`);
  console.log(`  performance.now() granularity here: ${out.clockGranularity} ms`);
  console.log(`  GPU timer query: ${out.timerQuery}`);
  console.log(`\n    crowd shown   ${out.on.map(v => v.toFixed(3)).join('  ')}   ms/frame`);
  console.log(`    crowd hidden  ${out.off.map(v => v.toFixed(3)).join('  ')}   ms/frame`);
  console.log(`\n    median shown  ${out.medOn.toFixed(3)} ms   hidden ${out.medOff.toFixed(3)} ms`
    + `   →  crowd = ${(out.medOn - out.medOff).toFixed(3)} ms`);
  console.log(`    minimum shown ${out.minOn.toFixed(3)} ms   hidden ${out.minOff.toFixed(3)} ms`
    + `   →  crowd = ${(out.minOn - out.minOff).toFixed(3)} ms`);
  console.log(`    draw calls    shown ${out.calls.on}  hidden ${out.calls.off}`
    + `   (beauty pass triangles ${out.tris.on} vs ${out.tris.off},`
    + ` difference ${out.tris.on - out.tris.off})`);
  const f = path.join(ROOT, '.meas', 'r2', `krcost-${SEED}.json`);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(out, null, 1));
  console.log(`\n  → ${f}`);
}
finish(process.exitCode || 0);
