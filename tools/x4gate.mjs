/* The gate, and its calibration.
 *
 * Round 3 failed the burst for internal contours and set a 3-4% absolute ink
 * target. Both halves of that need adjudicating, and neither can be done with
 * a single scalar, so this measures two things and calibrates the second
 * against a build where the defect is known to be present.
 *
 * 1. DEEP INTERIOR INK. The pen's band on this mass measures five to six
 *    pixels wide, so "ink more than two pixels from the edge" is still the
 *    contour and classifying it as interior is a measurement error — it is the
 *    error that makes a clean mass look like a hatched one. The distance
 *    transform here runs twelve rings deep and the gate reads the ink density
 *    at depth >= 8 px, which no contour of a 6 px pen can reach. That is
 *    exactly the quantity round 3 named: lines ruled through the middle of the
 *    mass rather than round it.
 *
 * 2. THE CALIBRATION. The composite suppresses the depth term only where the
 *    centre tap and all four neighbours carry the burst class. Defeat that and
 *    you get, on today's geometry, precisely the pen behaviour round 3 was
 *    looking at. It is defeated here without touching src/: the particle
 *    prepass writes its class as a GLSL literal, so the probe swaps 7.0 for
 *    8.0 in the material's own source at runtime and recompiles. Class 8 is
 *    unclassified, so it takes the same uWOther pen weight the burst already
 *    takes and differs in one respect only — the interior gate no longer
 *    fires. Restored afterwards.
 *
 *   node tools/x4gate.mjs --seeds 22,40 --n 18 --out shots/x4g
 */
import fs from 'node:fs';
import path from 'node:path';
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEEDS = flag('seeds', flag('seed', '22')).split(',').map(Number);
const RAMP = +flag('ramp', 1);
const N = +flag('n', 18);
const OUT = flag('out', 'shots/x4g');
const MAPS = (flag('maps', '4,9,13')).split(',').map(Number);

fs.mkdirSync(OUT, { recursive: true });

for (const SEED of SEEDS) {
  await run({ width: 1600, height: 900, hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0&ink=1` },
    async ({ page }) => {
      const out = await page.evaluate(([idx, frames, maps]) => {
        const g = window.__game, p = g.player;
        const pool = g.effects.particles;
        const cv = g.renderer.domElement, w = cv.width, h = cv.height;
        const tmp = document.createElement('canvas');
        tmp.width = w; tmp.height = h;
        const tc = tmp.getContext('2d', { willReadFrequently: true });
        const grab = () => { g.renderOnce(); tc.drawImage(cv, 0, 0); return tc.getImageData(0, 0, w, h).data; };
        const real = performance.now.bind(performance);
        const wantMap = new Set(maps);
        const DEEP = 8;          // px from the edge at which a stroke cannot be the contour
        const RINGS = 12;

        const mat = pool.prepassMaterial;
        const SRC = mat.fragmentShader;
        const UNGATED = SRC.replace('mix(6.0, 7.0, isBurstWall)', 'mix(6.0, 8.0, isBurstWall)');
        if (UNGATED === SRC) throw new Error('could not find the burst class literal in the prepass');
        const setGate = (on) => {
          mat.fragmentShader = on ? SRC : UNGATED;
          mat.needsUpdate = true;
          g.renderOnce();          // force the recompile before anything is measured
        };

        const hideBurst = (fn) => {
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

        const measure = (frameNo, tag) => {
          const t = real(); performance.now = () => t;
          const shown = grab();
          const noBurst = hideBurst(grab);
          g.pipeline.inkEnabled = false;
          const noink = grab();
          g.pipeline.inkEnabled = true;
          performance.now = real;

          const mask = new Uint8Array(w * h);
          const ink = new Uint8Array(w * h);
          let area = 0;
          for (let q = 0, c = 0; q < shown.length; q += 4, c++) {
            const db = Math.abs(shown[q] - noBurst[q]) + Math.abs(shown[q + 1] - noBurst[q + 1])
              + Math.abs(shown[q + 2] - noBurst[q + 2]);
            const drop = (0.2126 * (noink[q] - shown[q]) + 0.7152 * (noink[q + 1] - shown[q + 1])
              + 0.0722 * (noink[q + 2] - shown[q + 2])) / 255;
            ink[c] = drop > 0.02 ? 1 : 0;
            if (db > 12) { mask[c] = 1; area++; }
          }
          if (!area) return { area: 0 };

          const dist = new Uint8Array(w * h);
          let perim = 0;
          for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
              const c = y * w + x;
              if (!mask[c]) continue;
              const edge = (x === 0 || !mask[c - 1]) || (x === w - 1 || !mask[c + 1])
                || (y === 0 || !mask[c - w]) || (y === h - 1 || !mask[c + w]);
              if (edge) { dist[c] = 1; perim++; } else dist[c] = 255;
            }
          }
          for (let ring = 2; ring <= RINGS; ring++) {
            const add = [];
            for (let y = 1; y < h - 1; y++) {
              for (let x = 1; x < w - 1; x++) {
                const c = y * w + x;
                if (dist[c] !== 255) continue;
                if (dist[c - 1] === ring - 1 || dist[c + 1] === ring - 1
                  || dist[c - w] === ring - 1 || dist[c + w] === ring - 1) add.push(c);
              }
            }
            for (const c of add) dist[c] = ring;
          }

          let inked = 0, deepArea = 0, deepInk = 0;
          for (let c = 0; c < mask.length; c++) {
            if (!mask[c]) continue;
            const d = dist[c] === 255 ? RINGS + 1 : dist[c];
            if (ink[c]) inked++;
            if (d >= DEEP) { deepArea++; if (ink[c]) deepInk++; }
          }

          let url = null;
          if (wantMap.has(frameNo)) {
            const img = tc.createImageData(w, h);
            for (let c = 0, q = 0; c < mask.length; c++, q += 4) {
              let r = 16, gg = 16, b = 20;
              if (mask[c]) {
                const d = dist[c] === 255 ? RINGS + 1 : dist[c];
                r = 86; gg = 86; b = 92;
                if (ink[c]) {
                  if (d < DEEP) { r = 40; gg = 225; b = 95; }     // contour band
                  else { r = 255; gg = 40; b = 40; }              // a line through the middle
                }
              }
              img.data[q] = r; img.data[q + 1] = gg; img.data[q + 2] = b; img.data[q + 3] = 255;
            }
            tc.putImageData(img, 0, 0);
            url = tmp.toDataURL('image/png');
          }

          const R = Math.sqrt(area / Math.PI);
          return {
            tag, area, perim, inked,
            R: +R.toFixed(1),
            circ: +(perim / (2 * Math.PI * R)).toFixed(2),
            ink: +(inked / area * 100).toFixed(2),
            band: +(inked / perim).toFixed(2),
            deepArea,
            deepInk: +(deepArea ? deepInk / deepArea * 100 : 0).toFixed(2),
            deepShare: +(area ? deepArea / area * 100 : 0).toFixed(1),
            url,
          };
        };

        g.setPaused(true);
        if (g.race?.entries) g.race.entries.length = 0;
        for (let i = 0; i < pool.max; i++) {
          pool.active[i] = 0; pool.scales[i * 2] = pool.scales[i * 2 + 1] = 0;
        }
        pool.live = 0; pool.cursor = 0; pool._resetRandom();

        const r = g.track.ramps[Math.min(idx, g.track.ramps.length - 1)];
        g.autopilot(true, 0.85);
        g.driveTo((r.pad0 - 60) / g.track.length, { runUp: 320, maxSec: 45 });
        let k = 0, wasAir = false;
        while (k++ < 900) { g.step(1 / 60); if (p.airborne) wasAir = true; if (wasAir && !p.airborne) break; }

        /* Both builds on the SAME frame, so nothing but the class differs. */
        const gated = [], ungated = [];
        for (let f = 0; f < frames; f++) {
          g.setPaused(true);
          setGate(true);  gated.push(measure(f, 'gated'));
          setGate(false); ungated.push(measure(f, 'ungated'));
          setGate(true);
          g.setPaused(false);
          g.step(1 / 60);
        }
        mat.fragmentShader = SRC; mat.needsUpdate = true;
        g.autopilot(false);
        return { seed: g.track.seed, gated, ungated };
      }, [RAMP, N, MAPS]);

      console.log(`\n  seed ${out.seed} — the burst-class gate, on and off, same frames`);
      console.log('   frame       area   perim      R  circ    ink%   band px   deep area   DEEP INK%'
        + '     |  ungated ink%   ungated DEEP INK%');
      for (let i = 0; i < out.gated.length; i++) {
        const a = out.gated[i], b = out.ungated[i];
        if (!a.area) { console.log(`   ${String(i).padStart(5)}   (no burst)`); continue; }
        console.log(`   ${String(i).padStart(5)}${i === 0 ? '*' : ' '}`
          + `${String(a.area).padStart(9)} ${String(a.perim).padStart(7)} ${a.R.toFixed(1).padStart(6)}`
          + ` ${a.circ.toFixed(2).padStart(5)} ${a.ink.toFixed(2).padStart(7)} ${a.band.toFixed(2).padStart(9)}`
          + ` ${String(a.deepArea).padStart(11)} ${a.deepInk.toFixed(2).padStart(11)}`
          + `     | ${b.ink.toFixed(2).padStart(12)} ${b.deepInk.toFixed(2).padStart(19)}`);
        for (const r of [a, b]) {
          if (!r.url) continue;
          const f = path.join(OUT, `s${out.seed}-f${String(i).padStart(2, '0')}-${r.tag}.png`);
          fs.writeFileSync(f, Buffer.from(r.url.split(',')[1], 'base64'));
        }
      }
      const live = out.gated.slice(1).filter(r => r.area > 2000);
      const liveU = out.ungated.slice(1).filter(r => r.area > 2000);
      if (live.length) {
        const m = (rows, k) => rows.reduce((a, r) => a + r[k], 0) / rows.length;
        const wa = (rows, num, den) => rows.reduce((a, r) => a + r[num], 0)
          / rows.reduce((a, r) => a + r[den], 0) * 100;
        console.log(`\n  over ${live.length} live frames, frame 0 excluded:`);
        console.log(`    GATED    ink ${wa(live, 'inked', 'area').toFixed(2)}%   `
          + `DEEP INTERIOR ink ${m(live, 'deepInk').toFixed(2)}%   `
          + `pen band ${m(live, 'band').toFixed(2)} px   circ ${m(live, 'circ').toFixed(2)}   `
          + `R ${m(live, 'R').toFixed(0)} px`);
        console.log(`    UNGATED  ink ${wa(liveU, 'inked', 'area').toFixed(2)}%   `
          + `DEEP INTERIOR ink ${m(liveU, 'deepInk').toFixed(2)}%   `
          + `pen band ${m(liveU, 'band').toFixed(2)} px   circ ${m(liveU, 'circ').toFixed(2)}`);
        /* The empirical law both sides are arguing about, fitted here rather
           than asserted: ink% x R should be a constant if ink is a contour. */
        const kk = live.map(r => r.ink * r.R);
        console.log(`    ink% x R = ${Math.min(...kk).toFixed(0)}..${Math.max(...kk).toFixed(0)}`
          + ` (mean ${(kk.reduce((a, b) => a + b, 0) / kk.length).toFixed(0)})`
          + ` — if ink is a contour this is constant, and 2*circ*band predicts`
          + ` ${(2 * m(live, 'circ') * m(live, 'band') * 100).toFixed(0)}`);
      }
    });
}

finish(process.exitCode || 0);
