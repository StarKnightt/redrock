/* Pilot for the round-2 crowd audit: prove the method before spending an hour
 * of laps on it.
 *
 * Four things have to hold or the density sweep means nothing:
 *   1  the frozen snapshot boots and steps
 *   2  a pinned performance.now() makes two renders of one state identical
 *   3  hiding a single instance by pushing its aPlace under the world is a
 *      clean per-figure ablation, and the per-figure footprints add up to the
 *      whole-mesh footprint
 *   4  it is fast enough for ~1000 samples a lap
 *
 *   node tools/kspilot.mjs [--seed 22]
 */
import { run } from './harness.mjs';
import { freeze } from './kssnap.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEED = flag('seed', '22');

const snap = await freeze();
console.log(`snapshot taken ${snap.stamp}`);

await run({
  width: 1600, height: 900,
  url: `${snap.base}/#manual&tier=high&seed=${SEED}&cap=0&hud=0`,
}, async ({ page }) => {
  page.setDefaultTimeout(600_000);
  const out = await page.evaluate(() => {
    const g = window.__game;
    const T = g.THREE;
    const W = g.renderer.domElement.width, H = g.renderer.domElement.height;
    const gl = g.renderer.getContext();
    const mesh = g.scene.getObjectByName('crowd-figures');
    const rails = g.scene.getObjectByName('crowd-barriers');
    const A = mesh.geometry.attributes;
    const N = A.aPlace.count;
    const notes = [];

    /* Step throws every frame on this snapshot: Game.step calls
       this.holdCamera and the instance has no such method. Everything the
       measurement needs — the physics substeps, ChaseCamera.update, the crowd
       uniform block, pipeline.update — runs BEFORE that line, so the sim and
       the camera advance correctly and the throw is caught and counted rather
       than worked around. */
    let threw = 0, lastErr = '';
    const step = dt => {
      try { g.step(dt); } catch (e) { threw++; lastErr = String(e.message || e); }
    };

    g.setPaused(true);
    g.goTo(0.0005);
    g.autopilot(true, 0.85);
    g.warp(0.5);
    for (let i = 0; i < 60; i++) step(1 / 60);
    notes.push(`60 steps: s=${g.player.s.toFixed(1)} kmh=${g.player.kmh.toFixed(0)}`
      + ` threw=${threw} (${lastErr.slice(0, 60)})`);

    const full = () => {
      const px = new Uint8Array(W * H * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return px;
    };
    const rect = (x, y, w, h) => {
      const px = new Uint8Array(w * h * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return px;
    };
    const diffN = (a, b) => {
      let n = 0;
      for (let i = 0; i < a.length; i += 4) {
        if (Math.abs(a[i] - b[i]) > 6 || Math.abs(a[i + 1] - b[i + 1]) > 6
          || Math.abs(a[i + 2] - b[i + 2]) > 6) n++;
      }
      return n;
    };

    // Drive up to the first site with people in it and stop 40 m short.
    const site = g.crowd.sites.find(p => p.kind !== 'start line');
    while (g.player.s < site.s - 40) step(1 / 60);
    notes.push(`at s=${g.player.s.toFixed(0)}, site ${site.kind} at s=${site.s.toFixed(0)}`);

    const real = performance.now.bind(performance);
    const pinned = real();
    performance.now = () => pinned;

    const t0 = real();
    g.renderOnce(); g.renderOnce();
    const base = full();
    const tRender = real() - t0;
    g.renderOnce();
    const drift = diffN(base, full());

    mesh.visible = false; if (rails) rails.visible = false;
    g.renderOnce();
    const none = full();
    mesh.visible = true; if (rails) rails.visible = true;
    const whole = diffN(base, none);

    /* Per-figure ablation. The instance is pushed a hundred kilometres under
       the world rather than hidden — there is no per-instance visibility on an
       InstancedBufferGeometry — and restored straight after. */
    const P = A.aPlace.array;
    const hide = i => {
      const y = P[i * 4 + 1];
      P[i * 4 + 1] = -1e5; A.aPlace.needsUpdate = true;
      return () => { P[i * 4 + 1] = y; A.aPlace.needsUpdate = true; };
    };

    const t1 = real();
    let sum = 0, hits = 0;
    const per = [];
    for (let i = 0; i < N; i++) {
      const back = hide(i);
      g.renderOnce();
      const n = diffN(base, full());
      back();
      if (n) { hits++; sum += n; per.push({ i, n }); }
    }
    const tAll = real() - t1;
    performance.now = real;

    return {
      W, H, N, notes, threw, lastErr, tRender: +tRender.toFixed(1), drift,
      whole, sum, hits, per,
      perFigureMs: +(tAll / N).toFixed(1),
    };
  });

  console.log(`\n  ${out.W}x${out.H}, ${out.N} instances`);
  out.notes.forEach(n => console.log('  ' + n));
  console.log(`  step() threw ${out.threw} times: ${out.lastErr}`);
  console.log(`  pinned-clock drift across a static pair: ${out.drift} px`
    + `${out.drift ? '   ◀── NOT CLEAN' : '  (clean)'}`);
  console.log(`  whole-mesh footprint: ${out.whole} px`);
  console.log(`  sum of per-figure footprints: ${out.sum} px over ${out.hits} figures`);
  console.log(`    ratio sum/whole = ${(out.sum / Math.max(out.whole, 1)).toFixed(3)}`);
  console.log(`  cost: 2 renders + full read = ${out.tRender} ms;`
    + ` per-figure ablate+render+full read = ${out.perFigureMs} ms`);
  console.log('  per-figure: ' + out.per.map(p => `${p.i}:${p.n}`).join(' '));
  console.log();
});
snap.close();
finish(process.exitCode || 0);
