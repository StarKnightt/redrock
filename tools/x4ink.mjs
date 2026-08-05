/* Round-4 adjudication instrument: WHERE the ink lands on the burst.
 *
 * The dispute is whether a 3-4% ink target is reachable. Both sides have been
 * arguing from one scalar — the share of plume pixels that carry ink — and that
 * scalar cannot distinguish the two things that matter:
 *
 *   a contour round one mass, which is what the house style wants, from
 *   a web of lines through its interior, which is what round 3 failed it for.
 *
 * So this decomposes it. For every frame it builds the burst's own mask (the
 * burst instances hidden, differenced against the frame with them shown — not
 * the whole pool, which on seed 40 is mostly the car's speed veil), takes the
 * ink map from an ink-on / ink-off pair, and splits the inked pixels by their
 * distance to the mask's boundary. It reports, on the same frame and by the
 * same code:
 *
 *   area, perimeter, equivalent radius R, circularity P/(2*pi*R)
 *   ink%, and the share of that ink lying within 1, 2, 3 px of the edge
 *   the implied pen band, = inked area / perimeter
 *   the CAR's ink% and the world's ink%, measured identically
 *
 * and writes a false-colour map so the interior lines can be looked at rather
 * than inferred: mask grey, edge-band ink green, interior ink red.
 *
 * Clock pinned, pool re-seeded, frame 0 flagged and excluded, per the
 * discipline every previous round was burned by skipping.
 *
 *   node tools/x4ink.mjs --seed 22 --n 20 --out shots/x4i-22
 */
import fs from 'node:fs';
import path from 'node:path';
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEEDS = flag('seeds', flag('seed', '22')).split(',').map(Number);
const RAMP = +flag('ramp', 1);
const N = +flag('n', 20);
const AT = +flag('at', 0.42);
const OUT = flag('out', '');
const MAPS = flag('maps', '');        // comma-separated frame indices to draw

for (const SEED of SEEDS) {
  await run({ width: 1600, height: 900, hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0&ink=1` },
    async ({ page }) => {
      const out = await page.evaluate(([idx, frames, at, maps]) => {
        const g = window.__game, p = g.player;
        const pool = g.effects.particles;
        const cv = g.renderer.domElement, w = cv.width, h = cv.height;
        const tmp = document.createElement('canvas');
        tmp.width = w; tmp.height = h;
        const tc = tmp.getContext('2d', { willReadFrequently: true });
        const grab = () => { g.renderOnce(); tc.drawImage(cv, 0, 0); return tc.getImageData(0, 0, w, h).data; };
        const real = performance.now.bind(performance);
        const wantMap = new Set(maps);

        const carParts = [];
        g.scene.traverse(o => { if (/^(shell|wheel\d)/.test(o.name)) carParts.push(o); });

        const withBurstHidden = (fn) => {
          const kept = [];
          for (let i = 0; i < pool.max; i++) {
            if (pool.kind[i] < 4.5) continue;
            kept.push([i, pool.scales[i * 2], pool.scales[i * 2 + 1]]);
            pool.scales[i * 2] = pool.scales[i * 2 + 1] = 0;
          }
          pool.scaleAttr.needsUpdate = true;
          const r = fn();
          for (const [i, sx, sy] of kept) { pool.scales[i * 2] = sx; pool.scales[i * 2 + 1] = sy; }
          pool.scaleAttr.needsUpdate = true;
          return r;
        };

        /* A pixel is "inked" if turning the ink pass off makes it brighter.
           Same test wheelnear, r3ink and b5burst use, so the numbers compare. */
        const inkOf = (shown, noink, q) =>
          (0.2126 * (noink[q] - shown[q]) + 0.7152 * (noink[q + 1] - shown[q + 1])
            + 0.0722 * (noink[q + 2] - shown[q + 2])) / 255;

        const measure = (frameNo) => {
          const t = real(); performance.now = () => t;
          const shown = grab();
          const noBurst = withBurstHidden(grab);
          g.pipeline.inkEnabled = false;
          const noink = grab();
          g.pipeline.inkEnabled = true;
          const was = carParts.map(o => o.visible);
          carParts.forEach(o => { o.visible = false; });
          const noCar = grab();
          carParts.forEach((o, i) => { o.visible = was[i]; });
          performance.now = real;

          const mask = new Uint8Array(w * h);
          const car = new Uint8Array(w * h);
          const ink = new Uint8Array(w * h);
          let area = 0, carArea = 0, worldArea = 0, worldInk = 0, carInk = 0;
          for (let q = 0, c = 0; q < shown.length; q += 4, c++) {
            const db = Math.abs(shown[q] - noBurst[q]) + Math.abs(shown[q + 1] - noBurst[q + 1])
              + Math.abs(shown[q + 2] - noBurst[q + 2]);
            const dc = Math.abs(shown[q] - noCar[q]) + Math.abs(shown[q + 1] - noCar[q + 1])
              + Math.abs(shown[q + 2] - noCar[q + 2]);
            const isInk = inkOf(shown, noink, q) > 0.02 ? 1 : 0;
            ink[c] = isInk;
            if (db > 12) { mask[c] = 1; area++; }
            else if (dc > 12) { car[c] = 1; carArea++; if (isInk) carInk++; }
            else { worldArea++; if (isInk) worldInk++; }
          }

          /* Perimeter and a bounded distance-to-edge, four-neighbour. A mask
             pixel with a non-mask neighbour is at distance 1; the transform is
             then three dilations inward, which is all the depth the question
             needs (the pen is a couple of pixels wide). */
          const dist = new Uint8Array(w * h);   // 0 = not mask, 1..4 = rings, 5 = deeper
          let perim = 0;
          for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
              const c = y * w + x;
              if (!mask[c]) continue;
              const edge = (x === 0 || !mask[c - 1]) || (x === w - 1 || !mask[c + 1])
                || (y === 0 || !mask[c - w]) || (y === h - 1 || !mask[c + w]);
              if (edge) { dist[c] = 1; perim++; } else dist[c] = 5;
            }
          }
          for (let ring = 2; ring <= 4; ring++) {
            const add = [];
            for (let y = 1; y < h - 1; y++) {
              for (let x = 1; x < w - 1; x++) {
                const c = y * w + x;
                if (dist[c] !== 5) continue;
                if (dist[c - 1] === ring - 1 || dist[c + 1] === ring - 1
                  || dist[c - w] === ring - 1 || dist[c + w] === ring - 1) add.push(c);
              }
            }
            for (const c of add) dist[c] = ring;
          }

          const band = [0, 0, 0, 0, 0, 0];      // inked count by ring
          const ringArea = [0, 0, 0, 0, 0, 0];
          let inked = 0;
          for (let c = 0; c < mask.length; c++) {
            if (!mask[c]) continue;
            ringArea[dist[c]]++;
            if (ink[c]) { inked++; band[dist[c]]++; }
          }

          /* Islands, four-neighbour, floor 90 px — same as every other probe. */
          const seen = new Uint8Array(w * h);
          const stack = new Int32Array(w * h);
          const areas = [];
          for (let q = 0; q < mask.length; q++) {
            if (!mask[q] || seen[q]) continue;
            let sp = 0, a = 0;
            stack[sp++] = q; seen[q] = 1;
            while (sp) {
              const c = stack[--sp];
              const x = c % w, y = (c / w) | 0; a++;
              if (x > 0 && mask[c - 1] && !seen[c - 1]) { seen[c - 1] = 1; stack[sp++] = c - 1; }
              if (x < w - 1 && mask[c + 1] && !seen[c + 1]) { seen[c + 1] = 1; stack[sp++] = c + 1; }
              if (y > 0 && mask[c - w] && !seen[c - w]) { seen[c - w] = 1; stack[sp++] = c - w; }
              if (y < h - 1 && mask[c + w] && !seen[c + w]) { seen[c + w] = 1; stack[sp++] = c + w; }
            }
            if (a >= 90) areas.push(a);
          }
          areas.sort((a, b) => b - a);

          let url = null;
          if (wantMap.has(frameNo) && area > 0) {
            const img = tc.createImageData(w, h);
            for (let c = 0, q = 0; c < mask.length; c++, q += 4) {
              let r = 18, gg = 18, b = 22;
              if (mask[c]) {
                r = 90; gg = 90; b = 96;
                if (ink[c]) {
                  if (dist[c] <= 2) { r = 40; gg = 230; b = 90; }   // contour
                  else { r = 255; gg = 50; b = 50; }                // interior line
                }
              } else if (car[c]) { r = 60; gg = 40; b = 120; }
              img.data[q] = r; img.data[q + 1] = gg; img.data[q + 2] = b; img.data[q + 3] = 255;
            }
            tc.putImageData(img, 0, 0);
            url = tmp.toDataURL('image/png');
          }

          const R = Math.sqrt(area / Math.PI);
          return {
            area, perim,
            R: +R.toFixed(1),
            circ: +(area ? perim / (2 * Math.PI * R) : 0).toFixed(2),
            ink: +(area ? inked / area * 100 : 0).toFixed(2),
            inked,
            /* Of the inked pixels, the share within two pixels of the edge. */
            edgeShare: +(inked ? (band[1] + band[2]) / inked * 100 : 0).toFixed(1),
            interior: +(inked ? (band[3] + band[4] + band[5]) / inked * 100 : 0).toFixed(1),
            /* Interior ink as a share of interior AREA — the honest measure of
               "lines through the middle", independent of how big the rim is. */
            interiorDensity: +(ringArea[3] + ringArea[4] + ringArea[5]
              ? (band[3] + band[4] + band[5]) / (ringArea[3] + ringArea[4] + ringArea[5]) * 100 : 0).toFixed(2),
            rim2Area: +(area ? (ringArea[1] + ringArea[2]) / area * 100 : 0).toFixed(1),
            penBand: +(perim ? inked / perim : 0).toFixed(2),
            islands: areas.length,
            big: +(area ? (areas[0] || 0) / area * 100 : 0).toFixed(0),
            carInk: +(carArea ? carInk / carArea * 100 : 0).toFixed(2),
            carArea,
            worldInk: +(worldArea ? worldInk / worldArea * 100 : 0).toFixed(2),
            url,
          };
        };

        g.setPaused(true);
        if (g.race?.entries) g.race.entries.length = 0;
        for (let i = 0; i < pool.max; i++) {
          pool.active[i] = 0; pool.scales[i * 2] = pool.scales[i * 2 + 1] = 0;
        }
        pool.live = 0; pool.cursor = 0; pool._resetRandom();

        /* The veil, measured by the same code, because it is the number the
           3-4% target was set from and it has to be comparable. */
        g.autopilot(true, 1.0);
        g.driveTo(at, { runUp: 420, maxSec: 60 });
        for (let k = 0; k < 90; k++) g.step(1 / 60);
        const veil = [];
        for (let f = 0; f < 5; f++) { g.setPaused(true); veil.push(measure(-1)); g.setPaused(false); g.step(1 / 60); }

        const r = g.track.ramps[Math.min(idx, g.track.ramps.length - 1)];
        g.autopilot(true, 0.85);
        g.driveTo((r.pad0 - 60) / g.track.length, { runUp: 320, maxSec: 45 });
        let k = 0, wasAir = false;
        while (k++ < 900) { g.step(1 / 60); if (p.airborne) wasAir = true; if (wasAir && !p.airborne) break; }
        const land = [];
        for (let f = 0; f < frames; f++) {
          g.setPaused(true);
          land.push(measure(f));
          g.setPaused(false);
          g.step(1 / 60);
        }
        g.autopilot(false);
        return { seed: g.track.seed, veil, land };
      }, [RAMP, N, AT, MAPS ? MAPS.split(',').map(Number) : []]);

      console.log(`\n  seed ${out.seed} — where the ink lands`);
      const v = out.veil.slice(1).filter(r => r.area > 0);
      if (v.length) {
        const m = k => v.reduce((a, r) => a + r[k], 0) / v.length;
        console.log(`  near-wheel veil (VOLUMETRIC class, draws no contour of its own):`
          + ` ink ${m('ink').toFixed(2)}%  area ${m('area').toFixed(0)} px  R ${m('R').toFixed(0)} px`
          + `  circ ${m('circ').toFixed(2)}  of its ink, ${m('edgeShare').toFixed(0)}% is on its rim`);
      }
      console.log('\n   frame     area  perim      R  circ    ink%  rim2%  edge%  int%  intDens%  penpx'
        + '  isl  big%   car ink%   world%');
      out.land.forEach((r, i) => {
        console.log(`   ${String(i).padStart(5)}${i === 0 ? '*' : ' '}`
          + `${String(r.area).padStart(8)} ${String(r.perim).padStart(6)} ${r.R.toFixed(1).padStart(6)}`
          + ` ${r.circ.toFixed(2).padStart(5)} ${r.ink.toFixed(2).padStart(7)}`
          + ` ${r.rim2Area.toFixed(1).padStart(6)} ${r.edgeShare.toFixed(1).padStart(6)}`
          + ` ${r.interior.toFixed(1).padStart(5)} ${r.interiorDensity.toFixed(2).padStart(9)}`
          + ` ${r.penBand.toFixed(2).padStart(6)} ${String(r.islands).padStart(4)}`
          + ` ${String(r.big).padStart(5)} ${r.carInk.toFixed(2).padStart(10)}`
          + ` ${r.worldInk.toFixed(2).padStart(8)}`);
        if (r.url && OUT) {
          fs.mkdirSync(OUT, { recursive: true });
          const f = path.join(OUT, `ink${String(i).padStart(2, '0')}.png`);
          fs.writeFileSync(f, Buffer.from(r.url.split(',')[1], 'base64'));
          console.log(`         -> ${f}`);
        }
      });
      const live = out.land.slice(1).filter(r => r.area > 400);
      if (live.length) {
        const m = k => live.reduce((a, r) => a + r[k], 0) / live.length;
        const tot = live.reduce((a, r) => a + r.area, 0);
        const tin = live.reduce((a, r) => a + r.inked, 0);
        console.log(`\n  over ${live.length} live frames (frame 0 excluded):`);
        console.log(`    ink ${(tin / tot * 100).toFixed(2)}% area-weighted, ${m('ink').toFixed(2)}% per-frame`);
        console.log(`    of that ink, ${m('edgeShare').toFixed(0)}% lies within 2 px of the mask edge;`
          + ` the interior carries ${m('interiorDensity').toFixed(2)}% ink`);
        console.log(`    pen band ${m('penBand').toFixed(2)} px, circularity ${m('circ').toFixed(2)},`
          + ` R ${m('R').toFixed(0)} px`);
        console.log(`    car ink ${m('carInk').toFixed(2)}%, world ink ${m('worldInk').toFixed(2)}%`
          + ` — burst is ${(m('ink') / m('carInk')).toFixed(2)}x the car,`
          + ` ${(m('ink') / m('worldInk')).toFixed(2)}x the frame`);
      }
    });
}

finish(process.exitCode || 0);
