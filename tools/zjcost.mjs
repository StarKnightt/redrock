/* What the plumb ground mark costs, and the one claim about it that is
 * structural rather than tuned.
 *
 * The claim: the mark takes no ink. The composite derives every ink term —
 * depth, ID and crease — from the normals target alone (src/render/outline.js
 * reads tColor only for the base colour and the impact split), and the mark is
 * kept out of the pass that fills that target the same way the skid marks are,
 * by collapsing its draw range while a scene override is active. So it cannot
 * move an ink pixel. Structural arguments have been wrong on this project
 * before, so this measures it: the ink layer is isolated by rendering with the
 * ink on and off, and that layer is compared between a frame with the mark and
 * a frame without one. Not the counts — the pixels. A single disagreement fails
 * the claim.
 *
 * And the cost: draw calls, triangles and frame time, with the mark drawn and
 * hidden, at the apex where it is largest on screen.
 *
 * performance.now is pinned for the image work and released for the timing.
 *
 *   node tools/zjcost.mjs [--seeds 22,40]
 */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';
import { STEP_TO } from './zjprobe.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEEDS = flag('seeds', '22,40').split(',').map(Number);
const W = 1600, H = 900;

let fails = 0;

const PROBE = () => {
  const g = window.__game;
  g.setPaused(true);
  const cv = g.renderer.domElement, w = cv.width, h = cv.height;
  const tmp = document.createElement('canvas');
  tmp.width = w; tmp.height = h;
  const tc = tmp.getContext('2d', { willReadFrequently: true });
  const grab = () => {
    g.renderOnce(); tc.drawImage(cv, 0, 0);
    return tc.getImageData(0, 0, w, h).data;
  };
  const mark = g.effects.airMark.mesh;
  const realNow = performance.now.bind(performance);
  const tPin = realNow(); performance.now = () => tPin;

  /* The ink layer, twice: once with the mark in the frame and once without. The
     layer is the set of pixels the ink pass changes, so it is exactly what the
     mark is claimed not to touch. */
  const inkLayer = () => {
    g.pipeline.inkEnabled = true;
    grab();
    const on = grab();
    g.pipeline.inkEnabled = false;
    grab();
    const off = grab();
    g.pipeline.inkEnabled = true;
    const set = new Uint8Array(w * h);
    let n = 0;
    for (let p = 0; p < w * h; p++) {
      const i = p * 4;
      const d = Math.abs(on[i] - off[i]) + Math.abs(on[i + 1] - off[i + 1])
        + Math.abs(on[i + 2] - off[i + 2]);
      if (d > 12) { set[p] = 1; n++; }
    }
    return { set, n };
  };

  mark.visible = true;
  const withMark = inkLayer();
  mark.visible = false;
  const without = inkLayer();
  mark.visible = true;

  let differ = 0;
  for (let p = 0; p < w * h; p++) if (withMark.set[p] !== without.set[p]) differ++;

  performance.now = realNow;

  /* Cost. renderer.info is snapshotted by the pipeline before the composite, so
     pipeline.stats is the scene's own cost rather than one full-screen quad. */
  const cost = () => {
    g.renderOnce();
    return { calls: g.pipeline.stats.calls, tris: g.pipeline.stats.triangles };
  };
  mark.visible = true;
  const costOn = cost();
  mark.visible = false;
  const costOff = cost();
  mark.visible = true;

  /* Frame time, real clock, best of a warm run so a stray scheduling spike does
     not become the headline. Forty renders each way, alternating, so drift in
     the machine's state is shared between them rather than landing on one. */
  const time = (visible) => {
    mark.visible = visible;
    for (let i = 0; i < 5; i++) g.renderOnce();
    const t0 = realNow();
    for (let i = 0; i < 40; i++) g.renderOnce();
    return (realNow() - t0) / 40;
  };
  const warm = [time(true), time(false)];
  const msOn = Math.min(warm[0], time(true));
  const msOff = Math.min(warm[1], time(false));
  mark.visible = true;

  return {
    h: +g.player.height.toFixed(2),
    inkOn: withMark.n, inkOff: without.n, inkDiffer: differ,
    skips: g.effects.airMark.mesh.userData.fxOverrideSkips,
    calls: [costOn.calls, costOff.calls],
    tris: [costOn.tris, costOff.tris],
    ms: [+msOn.toFixed(3), +msOff.toFixed(3)],
  };
};

for (const SEED of SEEDS) {
  await run({ width: W, height: H, hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0&ink=1` },
    async ({ page }) => {
      const ramps = await page.evaluate(() => {
        window.__game.setPaused(true);
        return (window.__game.track.ramps || []).map(r => ({ pad0: r.pad0 }));
      });
      console.log(`\n─── seed ${SEED} ───`);
      console.log('  site    h     ink px with / without      pixels that differ'
        + '     draw calls    triangles      ms/frame');
      for (let i = 0; i < ramps.length; i++) {
        await page.evaluate(s => {
          const g = window.__game;
          g.autopilot(true, 0.85);
          g.driveTo(s / g.track.length, { runUp: 320, maxSec: 45 });
        }, ramps[i].pad0 - 60);
        await page.evaluate(STEP_TO, ['apex', 0, 900]);
        const m = await page.evaluate(PROBE);
        await page.evaluate(() => window.__game.autopilot(false));
        if (m.inkDiffer !== 0) fails++;
        if (m.skips < 1) fails++;
        console.log(`  r${i}   ${String(m.h).padStart(4)}`
          + `  ${String(m.inkOn).padStart(8)} / ${String(m.inkOff).padStart(8)}`
          + `   ${String(m.inkDiffer).padStart(18)}`
          + `     ${m.calls[0]} / ${m.calls[1]}`
          + `   ${m.tris[0]} / ${m.tris[1]}`
          + `   ${m.ms[0].toFixed(3)} / ${m.ms[1].toFixed(3)}`);
      }
    });
}

/* And the other half of "costs nothing": it must not be there. The mark fades in
   between 0.18 m and 0.75 m of height, and no berm, kerb or crest on this stage
   is supposed to lift the car that far — but "supposed to" is what the whole
   incidental-terrain investigation was about, so it is counted rather than
   assumed. A mark that flickers on over every bump is a worse defect than the
   one it was built to fix. */
for (const SEED of SEEDS) {
  await run({ width: 640, height: 360, hash: `manual&tier=low&seed=${SEED}&cap=0&hud=0` },
    async ({ page }) => {
      const out = await page.evaluate(() => {
        const g = window.__game, p = g.player;
        g.setPaused(true);
        /* From the grid. Stepping from wherever the boot left the car makes this
           a different descent every run — see tools/zjdet.mjs. */
        g.restart();
        g.autopilot(true, 0.85);
        g.countdown.skip();
        const lips = (g.track.ramps || []).map(r => r.lip);
        let frames = 0, drawn = 0, drawnAway = 0, worstAway = 0;
        const away = [];
        for (let n = 0; n < 60 * 260; n++) {
          g.step(1 / 60);
          if (p.finished) break;
          frames++;
          if (!g.effects.airMark.mesh.visible) continue;
          drawn++;
          /* Near a lip is the mark doing its job. Anywhere else is the
             question. 90 m covers the whole flight from any of them. */
          const nearLip = lips.some(l => Math.abs(p.s - l) < 90);
          if (!nearLip) {
            drawnAway++;
            if (p.height > worstAway) worstAway = p.height;
            away.push(Math.round(p.s));
          }
        }
        g.autopilot(false);
        return {
          frames, drawn, drawnAway, worstAway: +worstAway.toFixed(2),
          where: [...new Set(away.map(s => Math.round(s / 50) * 50))].slice(0, 12),
        };
      });
      console.log(`\n  seed ${SEED} — a full descent, ${out.frames} frames:`
        + ` the mark is drawn on ${out.drawn}`
        + ` (${(100 * out.drawn / out.frames).toFixed(2)}%),`
        + ` of which ${out.drawnAway} are not within 90 m of a lip`
        + ` (${(100 * out.drawnAway / out.frames).toFixed(2)}%)`);
      if (out.drawnAway) {
        console.log(`    away from the lips it reaches ${out.worstAway} m,`
          + ` around s = ${out.where.join(', ')}`);
      }
    });
}

console.log(fails
  ? `\n  FAIL — the mark moved ink, or was not excluded from the override pass`
  : `\n  PASS — the ink layer is pixel-identical with the mark and without it`);
if (fails) process.exitCode = 1;
finish(process.exitCode || 0);
