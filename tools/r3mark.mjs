/* Round-3 review instrument (read-only): what each marking is worth against
 * the road it is actually painted on.
 *
 * markprobe.mjs takes its road reference at ±2.6 and ±3.2 m from the
 * centreline. lat in track.js is normalised to half-width, and the pad is
 * PAD_HALF = 0.92 of it — 4.4 to 5.5 m on these sites — so those four samples
 * land on the pad. The reference is the thing being measured.
 *
 * This takes the reference the only way that cannot be argued with: read the
 * pixel, hide every ramp-* mesh, render again with the animation clock pinned
 * so the two frames are otherwise identical, and read the same pixel. The
 * difference is exactly what the paint adds to the road under it.
 *
 * Also reports, for context, an unpainted-tarmac reference sampled 12 m
 * upstream of the pad at the same laterals, and what markprobe's own reference
 * would have read at this station.
 *
 *   node tools/r3mark.mjs [--seed 22] [--ramp 1] [--from 40]
 */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEEDS = flag('seeds', '22').split(',').map(Number);
const RAMP = +flag('ramp', 1);
const FROMS = (flag('from', '40,25') || '').split(',').map(Number);

for (const SEED of SEEDS) {
  await run({ width: 1600, height: 900, hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0&ink=1` },
    async ({ page }) => {
      const out = await page.evaluate(([idx, froms]) => {
        const g = window.__game, p = g.player, track = g.track;
        const cv = g.renderer.domElement, w = cv.width, h = cv.height;
        const tmp = document.createElement('canvas');
        tmp.width = w; tmp.height = h;
        const tc = tmp.getContext('2d');
        const grab = () => { g.renderOnce(); tc.drawImage(cv, 0, 0); return tc.getImageData(0, 0, w, h).data; };
        const marks = [];
        g.scene.traverse(o => { if (o.isMesh && /^ramp-/.test(o.name || '')) marks.push(o); });

        g.setPaused(true);
        if (g.race?.entries) g.race.entries.length = 0;
        const r = track.ramps[Math.min(idx, track.ramps.length - 1)];
        g.autopilot(true, 0.85);

        const real = performance.now.bind(performance);
        const lum = (a, i) => (0.2126 * a[i] + 0.7152 * a[i + 1] + 0.0722 * a[i + 2]) / 255;
        const stations = [];

        for (const from of froms) {
          g.driveTo((r.pad0 - from) / track.length, { runUp: 340, maxSec: 45 });
          g.setPaused(true);
          const t = real(); performance.now = () => t;
          const shown = grab();
          const was = marks.map(o => o.visible);
          marks.forEach(o => { o.visible = false; });
          const bare = grab();
          marks.forEach((o, k) => { o.visible = was[k]; });
          performance.now = real;

          const project = (s, lat) => {
            const f = track.frameAt(s);
            const v = f.pos.clone().addScaledVector(f.right, lat * f.width * 0.5)
              .addScaledVector(f.up, 0.034 + track.rampHeight(s, 0));
            const q = v.clone().project(g.camera);
            return { x: Math.round((q.x * 0.5 + 0.5) * w), y: Math.round((-q.y * 0.5 + 0.5) * h) };
          };
          /* Brightest painted pixel in a window, and the same pixel with the
             paint gone. Same index both times, so the pair is exact. */
          const feature = (name, s, lat, win = 3) => {
            const c = project(s, lat);
            let best = null;
            for (let dy = -win; dy <= win; dy++) for (let dx = -win; dx <= win; dx++) {
              const x = c.x + dx, y = c.y + dy;
              if (x < 0 || y < 0 || x >= w || y >= h) continue;
              const i = (y * w + x) * 4;
              const L = lum(shown, i);
              if (!best || L > best.L) best = { i, x, y, L };
            }
            if (!best) return { name, off: true };
            const i = best.i;
            const under = lum(bare, i);
            const hex = a => '#' + [a[i], a[i + 1], a[i + 2]].map(v => v.toString(16).padStart(2, '0')).join('');
            const mx = Math.max(shown[i], shown[i + 1], shown[i + 2]);
            const mn = Math.min(shown[i], shown[i + 1], shown[i + 2]);
            return {
              name, dist: Math.round(s - p.s), px: `${best.x},${best.y}`,
              paint: hex(shown), road: hex(bare),
              lumPaint: +best.L.toFixed(3), lumRoad: +under.toFixed(3),
              contrast: +Math.abs(best.L - under).toFixed(3),
              sat: +((mx - mn) / (mx || 1)).toFixed(2),
              changed: Math.abs(shown[i] - bare[i]) + Math.abs(shown[i + 1] - bare[i + 1])
                + Math.abs(shown[i + 2] - bare[i + 2]) > 12,
            };
          };
          /* Unpainted tarmac, 12 m before the pad, same laterals. */
          const tarmac = (() => {
            const L = [];
            for (const lat of [-0.6, -0.3, 0, 0.3, 0.6]) {
              const c = project(r.pad0 - 12, lat);
              if (c.x < 0 || c.y < 0 || c.x >= w || c.y >= h) continue;
              L.push(lum(bare, (c.y * w + c.x) * 4));
            }
            L.sort((a, b) => a - b);
            return L.length ? +L[L.length >> 1].toFixed(3) : null;
          })();
          /* What markprobe's reference reads here: ±2.6/±3.2 METRES, on the
             painted frame. */
          const mpRef = (() => {
            const f = track.frameAt((r.pad0 + r.pad1) / 2);
            const L = [];
            for (const m of [-3.2, -2.6, 2.6, 3.2]) {
              const v = f.pos.clone().addScaledVector(f.right, m)
                .addScaledVector(f.up, 0.034 + track.rampHeight(f.s, 0));
              const q = v.clone().project(g.camera);
              const x = Math.round((q.x * 0.5 + 0.5) * w), y = Math.round((-q.y * 0.5 + 0.5) * h);
              if (x < 0 || y < 0 || x >= w || y >= h) continue;
              const i = (y * w + x) * 4;
              L.push({ L: +lum(shown, i).toFixed(3), onPad: Math.abs(shown[i] - bare[i])
                + Math.abs(shown[i + 1] - bare[i + 1]) + Math.abs(shown[i + 2] - bare[i + 2]) > 12 });
            }
            return { lat: +(2.6 / (f.width * 0.5)).toFixed(2), samples: L,
              onPad: L.filter(x => x.onPad).length, n: L.length };
          })();

          const rows = [feature('pad bed', (r.pad0 + r.pad1) / 2, 0.75)];
          rows.push(feature('pad core', (r.pad0 + r.pad1) / 2, 0));
          for (let k = 0; k < 3; k++) rows.push(feature(`pad chevron ${k + 1}`, r.pad0 + 0.5 + k * 1.75 + 0.85, 0));
          for (let k = 0; k < 5; k++) rows.push(feature(`face chevron ${k + 1}`, r.foot + 2.5 + k * 3.2, 0.6));
          rows.push(feature('lip stripe', r.lip, 0));
          stations.push({ from, s: Math.round(p.s), kmh: Math.round(p.speed * 3.6), rows, tarmac, mpRef });
        }
        g.autopilot(false);
        return { seed: track.seed, lip: r.lip, stations, marks: marks.map(o => o.name) };
      }, [RAMP, FROMS]);

      console.log(`\n  seed ${out.seed}, ramp lip ${out.lip} — paint against the road under it`);
      console.log(`  meshes hidden for the reference: ${out.marks.join(', ')}`);
      for (const st of out.stations) {
        console.log(`\n  ── from ${st.from} m short of the pad, s ${st.s}, ${st.kmh} km/h`);
        console.log(`     unpainted tarmac 12 m before the pad reads luma ${st.tarmac}`);
        console.log(`     markprobe's ±2.6 m reference is lat ${st.mpRef.lat} of half-width;`
          + ` ${st.mpRef.onPad} of ${st.mpRef.n} of its samples are ON THE PAINT`
          + `  (${st.mpRef.samples.map(x => x.L.toFixed(2) + (x.onPad ? '*' : '')).join(' ')})`);
        console.log('     feature           m ahead   paint     road      luma  →  luma    contrast   sat   drawn');
        for (const r of st.rows) {
          if (r.off) { console.log(`     ${r.name.padEnd(17)} off screen`); continue; }
          console.log(`     ${r.name.padEnd(17)} ${String(r.dist).padStart(7)}   ${r.paint}   ${r.road}`
            + `   ${r.lumRoad.toFixed(3)} → ${r.lumPaint.toFixed(3)}`
            + `   ${r.contrast.toFixed(3).padStart(9)} ${r.sat.toFixed(2).padStart(5)}`
            + `   ${r.changed ? 'yes' : 'NO'}`);
        }
      }
    });
}

finish(process.exitCode || 0);
