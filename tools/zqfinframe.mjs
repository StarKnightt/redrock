/* Are the finish crowd and the finish gate in the same picture?
 *
 * D1 has two halves. The first is occlusion, which tools/zzseen.mjs answers
 * by ablation and which is the half everything so far has measured. The
 * second is staging: "at 40 m the crowd and the finish gate were not in the
 * same visual field". A group can be 7/7 visible down the whole run-in and
 * still be a group beside a road rather than a group at a finish line, if the
 * gate is never on screen at the same time.
 *
 * Same instrument as everywhere else, pointed at two objects instead of one:
 * render the frame, hide the crowd and diff, hide the gate and diff. Both
 * footprints come out of the same frame at the same eye point, so "in the
 * same visual field" is a fact about one image and not a comparison between
 * two runs. The gap between the two bounding boxes, in pixels and as a
 * fraction of frame width, is the staging number.
 *
 * Discipline, as the rest of the crowd probes: performance.now() pinned
 * across every render in a station, frame 0 after each drive-in discarded,
 * 1600x900 through g.pipeline.render(), car driven in by the autopilot.
 *
 *   node tools/zqfinframe.mjs [--seeds 22,1,40] [--backs 90,70,55,40,28,18,10]
 */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEEDS = flag('seeds', '22,1,40').split(',');
const BACKS = flag('backs', '90,70,55,40,28,18,10').split(',').map(Number);

for (const SEED of SEEDS) {
  await run({
    width: 1600, height: 900,
    hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0`,
  }, async ({ page }) => {
    const res = await page.evaluate(([backs]) => {
      const g = window.__game;
      const t = g.track;
      const crowd = g.crowd;
      if (!crowd) return { none: true };
      const W = g.renderer.domElement.width, H = g.renderer.domElement.height;
      const gl = g.renderer.getContext();

      const mesh = g.scene.getObjectByName('crowd-figures');
      const gate = g.stage.getObjectByName('gate-finish');
      if (!mesh || !gate) return { none: true, why: !gate ? 'no gate-finish' : 'no crowd mesh' };

      const grab = () => {
        const px = new Uint8Array(W * H * 4);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
        return px;
      };
      const diff = (a, b) => {
        let n = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
        for (let i = 0, p = 0; i < a.length; i += 4, p++) {
          if (Math.abs(a[i] - b[i]) > 6 || Math.abs(a[i + 1] - b[i + 1]) > 6
            || Math.abs(a[i + 2] - b[i + 2]) > 6) {
            n++;
            const x = p % W, yy = H - 1 - ((p / W) | 0);
            if (x < x0) x0 = x; if (x > x1) x1 = x;
            if (yy < y0) y0 = yy; if (yy > y1) y1 = yy;
          }
        }
        return n ? { n, x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 } : { n: 0 };
      };

      const site = crowd.sites.find(s => s.kind === 'finish');
      if (!site) return { none: true, why: 'no finish site' };

      g.autopilot(true, 0.85);
      const rows = [];
      for (const back of backs) {
        const s = site.s - back;
        if (s < 30) continue;
        g.setPaused(true);
        g.goTo(Math.max(0, s - 55) / t.length);
        g.warp(0.75);
        for (let k = 0; k < 260 && g.player.s < s; k++) g.step(1 / 60);

        const real = performance.now.bind(performance);
        const pinned = real();
        performance.now = () => pinned;
        g.renderOnce();                     // frame 0, discarded
        g.renderOnce();
        const base = grab();
        g.renderOnce();
        const drift = diff(base, grab()).n;

        mesh.visible = false;
        g.renderOnce();
        const dCrowd = diff(base, grab());
        mesh.visible = true;

        gate.visible = false;
        g.renderOnce();
        const dGate = diff(base, grab());
        gate.visible = true;
        performance.now = real;

        /* Horizontal separation between the two silhouettes, zero when they
           overlap. The vertical axis is not interesting here — the gate spans
           the road above head height by construction. */
        let sep = null;
        if (dCrowd.n && dGate.n) {
          sep = Math.max(0, Math.max(dCrowd.x0, dGate.x0) - Math.min(dCrowd.x1, dGate.x1));
        }
        rows.push({
          back, s: g.player.s, drift,
          crowd: dCrowd.n, crowdH: dCrowd.n ? dCrowd.h : 0,
          crowdBox: dCrowd.n ? [dCrowd.x0, dCrowd.x1] : null,
          gate: dGate.n, gateBox: dGate.n ? [dGate.x0, dGate.x1] : null,
          sep,
        });
      }
      return { seed: t.seed, L: t.length, siteS: site.s, W, rows };
    }, [BACKS]);

    if (res.none) { console.log('  no crowd/gate —', res.why || ''); return; }
    console.log(`\n  seed ${res.seed} — finish crowd at s=${res.siteS.toFixed(0)},`
      + ` gate at s=${(res.L - 12).toFixed(0)}, line at ${res.L.toFixed(0)}`);
    console.log('     back    crowd px  tallest   gate px    x-gap    both in frame   drift');
    let both = 0;
    for (const r of res.rows) {
      const ok = r.crowd > 0 && r.gate > 0;
      if (ok) both++;
      console.log(`    ${String(r.back).padStart(4)} m  ${String(r.crowd).padStart(9)}`
        + `  ${String(r.crowdH).padStart(5)} px  ${String(r.gate).padStart(8)}`
        + `  ${(r.sep === null ? '  —' : r.sep + ' px').padStart(8)}`
        + `        ${ok ? 'YES' : 'no '}       ${r.drift}`);
    }
    console.log(`    both on screen at ${both} of ${res.rows.length} stations`);
  });
}

/* Not `finish()`. `finish` defaults its argument to 0, so a bare call is
   `finish(0)` — the discarded exit code the 67-tool repair removed, in a
   spelling a grep for "finish(0)" cannot match. Measured: with a syntax error in
   src/core/util.js this tool printed "parse errors — not launching a browser",
   photographed nothing, and exited 0. */
finish(process.exitCode || 0);
