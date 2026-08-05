/* Does the volumetric ink class change anything for objects that are not
 * volumetric?
 *
 * The gate added to the composite is written so that every factor it
 * introduces is exactly 1.0 in a frame with no volumetric surface in it, and
 * the extra prepass pass returns before touching the renderer when nothing
 * that has opted in is visible. This checks both claims rather than asserting
 * them: it freezes a frame with the particle system stubbed out, reads the
 * default framebuffer, then recompiles the composite with the gate textually
 * removed and reads it again. The two buffers must be identical byte for
 * byte, not merely close.
 *
 * A cross-process comparison cannot do this — the stage animates and two runs
 * of the same capture never agree to the byte — so both halves are rendered
 * from the same frozen frame in the same process.
 *
 *   node tools/inkparity.mjs [--t 0.44]
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { run, capture } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const T = +flag('t', 0.44);

const outDir = path.join(ROOT, 'shots', 'ink-parity');
fs.mkdirSync(outDir, { recursive: true });

// The exact lines the gate adds, so the "before" build can be reconstructed.
const GATE = [
  'depthEdge *= solid;',
  'normalEdge *= solid;',
  'idEdge *= solid * (1.0 - volumeNear);',
];

await run({ width: 1600, height: 900, hash: 'manual&tier=high&seed=22&cap=60&hud=0&ink=1' },
  async ({ page }) => {
    const out = await page.evaluate(({ t, gate }) => {
      const g = window.__game;
      g.driveTo(t);
      g.setPaused(true);

      /* The stage's foliage and water are driven straight off the wall clock
         in onBeforeRender, so two renders of a paused frame do not otherwise
         agree with each other, let alone across a shader change. */
      const realNow = performance.now.bind(performance);
      const frozen = realNow();
      performance.now = () => frozen;

      const r = g.renderer;
      const gl = r.getContext();
      const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
      const read = () => {
        g.renderOnce();
        const buf = new Uint8Array(W * H * 4);
        gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
        return buf;
      };
      const same = (a, b) => {
        let first = -1, count = 0, worst = 0;
        let x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1;
        for (let i = 0; i < a.length; i++) {
          if (a[i] === b[i]) continue;
          if (first < 0) first = i;
          count++;
          worst = Math.max(worst, Math.abs(a[i] - b[i]));
          const px = (i >> 2) % W, py = (i >> 2) / W | 0;
          if (px < x0) x0 = px; if (px > x1) x1 = px;
          if (py < y0) y0 = py; if (py > y1) y1 = py;
        }
        return count ? { first, count, worst, box: [x0, y0, x1, y1] } : -1;
      };

      // Warm up: the first render after the drive still settles a shadow map.
      for (let i = 0; i < 4; i++) g.renderOnce();

      /* What the opt-in prepass pass costs, on a frozen frame with the plume
         at its densest, timed against the same frame with the pass stubbed
         out. A one-pixel read after each render forces the queue to drain, so
         this is wall time for the whole frame and not just its submission. */
      const drain = new Uint8Array(4);
      const bench = () => {
        for (let i = 0; i < 8; i++) g.renderOnce();
        const t0 = realNow();
        for (let i = 0; i < 120; i++) {
          g.renderOnce();
          gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, drain);
        }
        return (realNow() - t0) / 120;
      };
      const livePlume = g.effects.particles.live;
      const optIn = g.pipeline._renderPrepassOptIns.bind(g.pipeline);
      const msWith = bench();
      g.pipeline._renderPrepassOptIns = () => {};
      const msWithout = bench();
      g.pipeline._renderPrepassOptIns = optIn;

      // No particles anywhere: this is the frame every other object inks in.
      g.effects.reset();
      g.effects.update = () => {};
      for (let i = 0; i < 4; i++) g.renderOnce();

      const withGate = read();
      const control = read();

      const mat = g.pipeline.quadMat;
      const src = mat.fragmentShader;
      let stripped = src;
      for (const line of gate) stripped = stripped.replace(line, '');
      const removed = gate.filter(line => src.includes(line)).length;
      mat.fragmentShader = stripped;
      mat.needsUpdate = true;
      const withoutGate = read();
      mat.fragmentShader = src;
      mat.needsUpdate = true;
      /* What the opt-in pass actually costs, counted rather than reasoned
         about: scene renders per frame with the plume hidden and with it
         drawn. The first number must match the build without the mechanism. */
      const realRender = r.render.bind(r);
      let renders = 0;
      r.render = (...a) => { renders++; return realRender(...a); };
      renders = 0; g.renderOnce();
      const rendersEmpty = renders;
      g.effects.particles.mesh.visible = true;
      renders = 0; g.renderOnce();
      const rendersWithPlume = renders;
      g.effects.particles.mesh.visible = false;
      r.render = realRender;

      performance.now = realNow;

      return {
        pixels: W * H,
        particlesVisible: g.effects.particles.mesh.visible,
        gateLinesFound: removed,
        controlFirstDiff: same(withGate, control),
        parityFirstDiff: same(withGate, withoutGate),
        rendersEmpty, rendersWithPlume,
        livePlume, msWith: +msWith.toFixed(3), msWithout: +msWithout.toFixed(3),
      };
    }, { t: T, gate: GATE });

    console.log('  ' + JSON.stringify(out, null, 1).replace(/\n\s*/g, ' '));
    const ok = out.gateLinesFound === GATE.length
      && out.controlFirstDiff === -1
      && out.parityFirstDiff === -1
      && out.particlesVisible === false;
    console.log(ok
      ? `  PASS  ${out.pixels} pixels identical with and without the gate`
      : '  FAIL  see the diff indices above');
    if (!ok) process.exitCode = 1;
    await capture(page, path.join(outDir, 'no-particles.png'));
    console.log('  → shots/ink-parity');
  });

finish(process.exitCode || 0);
