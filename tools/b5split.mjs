/* Diagnostic (read-only): WHICH term inks the landing burst?
 *
 * ink% on the plume is measured four ways on the same pinned frame:
 *   all      the shipping composite
 *   no id    uIdEdge = 0, so only the depth and crease terms can draw
 *   no depth uDepthEdge raised out of reach, so only id and crease can draw
 *   none     ink off, the floor (must read 0)
 *
 * Also reports the plume mask's own perimeter share: of the pixels the pool
 * adds to the frame, how many have a neighbour that is NOT plume. A lacy mask
 * has a large one, and a lacy mask cannot be made to carry little ink by any
 * change to the pen, because every one of those pixels is a real boundary
 * between dust and road.
 *
 *   node tools/b5split.mjs [--seeds 22,40] [--ramp 1] [--at 6]
 */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEEDS = flag('seeds', '22,40').split(',').map(Number);
const RAMP = +flag('ramp', 1);
const AT = +flag('at', 6);

for (const SEED of SEEDS) {
  await run({ width: 1600, height: 900, hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0&ink=1` },
    async ({ page }) => {
      const out = await page.evaluate(([ramp, at]) => {
        const g = window.__game, p = g.player;
        const pool = g.effects.particles;
        const cv = g.renderer.domElement, w = cv.width, h = cv.height;
        const tmp = document.createElement('canvas');
        tmp.width = w; tmp.height = h;
        const tc = tmp.getContext('2d');
        const grab = () => { g.renderOnce(); tc.drawImage(cv, 0, 0); return tc.getImageData(0, 0, w, h).data; };
        const real = performance.now.bind(performance);
        const u = g.pipeline.quadMat?.uniforms;

        g.setPaused(true);
        if (g.race?.entries) g.race.entries.length = 0;
        const r = g.track.ramps[Math.min(ramp, g.track.ramps.length - 1)];
        g.autopilot(true, 0.85);
        g.driveTo((r.pad0 - 60) / g.track.length, { runUp: 320, maxSec: 45 });
        let k = 0, wasAir = false;
        while (k++ < 900) { g.step(1 / 60); if (p.airborne) wasAir = true; if (wasAir && !p.airborne) break; }
        for (let f = 0; f < at; f++) g.step(1 / 60);
        g.setPaused(true);

        if (!u) return { err: 'no composite uniforms found' };
        const t = real(); performance.now = () => t;
        const shown = grab();
        pool.mesh.visible = false;
        const bare = grab();
        pool.mesh.visible = true;

        const mask = new Uint8Array(w * h);
        let plume = 0;
        for (let q = 0; q < shown.length; q += 4) {
          const dr = Math.abs(shown[q] - bare[q]) + Math.abs(shown[q + 1] - bare[q + 1])
            + Math.abs(shown[q + 2] - bare[q + 2]);
          if (dr > 12) { mask[q >> 2] = 1; plume++; }
        }
        /* Chamfer distance from every plume pixel to the nearest pixel that is
           not plume, so "how much of this mask is within B pixels of its own
           edge" can be read off directly. That is the ink a pen of band B must
           lay down on a mask of this shape, whatever the pen is looking at. */
        const BIG = 1e6;
        const dt = new Float32Array(w * h);
        for (let c = 0; c < mask.length; c++) dt[c] = mask[c] ? BIG : 0;
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const c = y * w + x;
            if (!dt[c]) continue;
            let v = dt[c];
            if (x > 0) v = Math.min(v, dt[c - 1] + 1); else v = Math.min(v, 1);
            if (y > 0) v = Math.min(v, dt[c - w] + 1); else v = Math.min(v, 1);
            if (x > 0 && y > 0) v = Math.min(v, dt[c - w - 1] + 1.414);
            if (x < w - 1 && y > 0) v = Math.min(v, dt[c - w + 1] + 1.414);
            dt[c] = v;
          }
        }
        for (let y = h - 1; y >= 0; y--) {
          for (let x = w - 1; x >= 0; x--) {
            const c = y * w + x;
            if (!dt[c]) continue;
            let v = dt[c];
            if (x < w - 1) v = Math.min(v, dt[c + 1] + 1); else v = Math.min(v, 1);
            if (y < h - 1) v = Math.min(v, dt[c + w] + 1); else v = Math.min(v, 1);
            if (x < w - 1 && y < h - 1) v = Math.min(v, dt[c + w + 1] + 1.414);
            if (x > 0 && y < h - 1) v = Math.min(v, dt[c + w - 1] + 1.414);
            dt[c] = v;
          }
        }
        const band = (b) => {
          let n = 0;
          for (let c = 0; c < mask.length; c++) if (mask[c] && dt[c] <= b) n++;
          return +(n / Math.max(plume, 1) * 100).toFixed(1);
        };
        const perim = band(1);
        const bands = [1, 2, 3, 4, 6].map(b => ({ b, pct: band(b) }));

        /* Ink is measured against the same no-ink render every time, so the
           four rows differ only in which term of the pen was allowed to run. */
        g.pipeline.inkEnabled = false;
        const noink = grab();
        g.pipeline.inkEnabled = true;
        const inkOn = (img) => {
          let inked = 0;
          for (let q = 0; q < img.length; q += 4) {
            if (!mask[q >> 2]) continue;
            const drop = (0.2126 * (noink[q] - img[q]) + 0.7152 * (noink[q + 1] - img[q + 1])
              + 0.0722 * (noink[q + 2] - img[q + 2])) / 255;
            if (drop > 0.02) inked++;
          }
          return +(inked / Math.max(plume, 1) * 100).toFixed(2);
        };

        /* Two renders of the unchanged, pinned frame. Anything but 0.00 here
           is instrument noise and every row below has to be read over it. */
        const a = grab(), b2 = grab();
        let still = 0;
        for (let q = 0; q < a.length; q += 4) {
          if (Math.abs(a[q] - b2[q]) + Math.abs(a[q + 1] - b2[q + 1])
            + Math.abs(a[q + 2] - b2[q + 2]) > 0) still++;
        }

        /* The same measurement on the car, in the same frame, through the same
           code. The frame's "world%" is mostly road and sky — large smooth
           areas with almost no boundary in them — so it is the wrong thing to
           hold a small ragged mass to. The hero object is the right one: it is
           the same size on screen, it is drawn by the same pen, and whatever
           it reads is what "drawn like the rest of this picture" means here. */
        const carParts = [];
        g.scene.traverse(o => { if (/^(shell|wheel\d)/.test(o.name) && o.visible) carParts.push(o); });
        carParts.forEach(o => { o.visible = false; });
        const noCar = grab();
        carParts.forEach(o => { o.visible = true; });
        let carPx = 0, carInk = 0;
        for (let q = 0; q < shown.length; q += 4) {
          const dr = Math.abs(shown[q] - noCar[q]) + Math.abs(shown[q + 1] - noCar[q + 1])
            + Math.abs(shown[q + 2] - noCar[q + 2]);
          if (dr <= 12) continue;
          carPx++;
          const drop = (0.2126 * (noink[q] - shown[q]) + 0.7152 * (noink[q + 1] - shown[q + 1])
            + 0.0722 * (noink[q + 2] - shown[q + 2])) / 255;
          if (drop > 0.02) carInk++;
        }

        const id0 = u.uIdEdge.value, dp0 = u.uDepthEdge.value, nm0 = u.uNormalEdge.value;
        const all = inkOn(shown);
        u.uIdEdge.value = 0; const noId = inkOn(grab()); u.uIdEdge.value = id0;
        u.uDepthEdge.value = 1e6; const noDepth = inkOn(grab()); u.uDepthEdge.value = dp0;
        u.uNormalEdge.value = 1e6; const noCrease = inkOn(grab()); u.uNormalEdge.value = nm0;
        u.uIdEdge.value = 0; u.uDepthEdge.value = 1e6; u.uNormalEdge.value = 1e6;
        const none = inkOn(grab());
        u.uIdEdge.value = id0; u.uDepthEdge.value = dp0; u.uNormalEdge.value = nm0;
        performance.now = real;
        g.autopilot(false);
        return {
          seed: g.track.seed, plume: +(plume / (w * h) * 100).toFixed(3),
          perim, bands, still: +(still / (w * h) * 100).toFixed(3),
          carPx: +(carPx / (w * h) * 100).toFixed(3),
          carInk: +(carInk / Math.max(carPx, 1) * 100).toFixed(2),
          all, noId, noDepth, noCrease, none,
        };
      }, [RAMP, AT]);

      if (out.err) { console.log('  ' + out.err); return; }
      console.log(`\n  seed ${out.seed}, ${AT} frames after touchdown — plume ${out.plume}% of frame`);
      console.log(`    two renders of the same pinned frame differ on ${out.still}% of the frame`);
      console.log('    share of the plume mask within B px of its own edge:');
      console.log('      ' + out.bands.map(x => `B=${x.b}: ${x.pct}%`).join('   '));
      console.log(`    ink on plume, everything on        ${out.all}%`);
      console.log(`    ink on plume, id term off          ${out.noId}%`);
      console.log(`    ink on plume, depth term off       ${out.noDepth}%`);
      console.log(`    ink on plume, crease term off      ${out.noCrease}%`);
      console.log(`    ink on plume, all three off        ${out.none}%  (floor, must be 0)`);
      console.log(`    ink on the CAR, same frame         ${out.carInk}%`
        + `   (car is ${out.carPx}% of the frame)`);
    });
}

finish(process.exitCode || 0);
