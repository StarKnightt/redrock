/* Review probe (read-only): what SHAPE is the landing burst, and how high does
 * it actually stand?
 *
 * Every existing tool measures the burst by area, tone count, ink share and
 * duration. All four can be satisfied by a smooth cream ribbon lying flat on
 * the road, which is what magnified captures appear to show. Two things they
 * do not measure:
 *
 *   HEIGHT, in metres rather than pixels. A rod is projected from the
 *   touchdown point straight up the road's normal at 0/1/2/3/4 m, and the
 *   plume mask's topmost pixel is read against those rungs. That is
 *   camera-independent: a burst that stands one metre reads as one metre from
 *   any boom length.
 *
 *   SHAPE, as connected components and their convexity. A cluster of round
 *   puffs is many mid-sized islands each close to its own convex hull. One
 *   long tortuous ribbon is a single island whose area is a small fraction of
 *   its bounding box and of its hull. That ratio is the difference between
 *   "dust" and "a piece of torn card".
 *
 * The plume mask is taken exactly as dustjudge/dustlife take it: render with
 * the pool, render with pool.mesh hidden, difference. Everything runs inside
 * one page.evaluate stepping a fixed 1/60 so rows are on an exact clock.
 *
 * Nothing under src/ is touched.
 *
 * ─── THREE THINGS THIS TOOL USED TO GET WRONG ────────────────────────────
 *
 * 1. THE CLOCK WAS NOT PINNED. src/world/environment.js sets a shader uniform
 *    from performance.now() inside onBeforeRender, so the "with pool" and
 *    "without pool" renders were a frame of grass apart and every blade that
 *    moved between them landed in the plume mask. It is a bounding box, so
 *    one stray blade at each corner sets it: measured on seed 40, unpinned
 *    this reported a 1080x807 px box where the pinned instrument beside it
 *    read 437x339. Pinned now, across both renders of each frame.
 *
 * 2. THE HEIGHT COLUMN EXTRAPOLATED OFF ITS OWN ROD. The rod has rungs at
 *    0..4 m; a top pixel above the 4 m rung was extended off the last PAIR of
 *    rungs, and near the horizon those two rungs are a pixel apart, so the
 *    division blew up — 13.50 m on a burst that stands about one, and 309,441
 *    m elsewhere. There is no honest reading above the rod, so above the rod
 *    it now REFUSES: the column reads ">4" and the summary says how many
 *    frames could not be measured. When the top pixel is grass rather than
 *    dust — which is what put it above the rod in the first place — item 1
 *    has already dealt with it.
 *
 * 3. THE ISLAND COUNT WAS WITHDRAWN as a gate for rewarding fragmentation: a
 *    burst that shatters into confetti scores better on it than one clean
 *    mass. It is still printed, because it is a fact about the picture, but
 *    the summary now leads with the largest island's SHARE of the plume,
 *    which is what tools/b5burst.mjs gates on and is the right way round.
 *
 * Frame 0 is the driveTo artifact and is excluded from every mean.
 *
 *   node tools/c2burst.mjs [--seed 22] [--ramp 1] [--n 30] [--shots 1,4,10]
 *                          [--zoom 3] [--tag name]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEED = +flag('seed', 22);
const RAMP = +flag('ramp', 1);
const N = +flag('n', 30);
const ZOOM = +flag('zoom', 3);
const SHOTS = (flag('shots', '1,4,10') || '').split(',').filter(Boolean).map(Number);
const TAG = flag('tag', `c2burst${SEED}`);
/* An island under this many pixels is not a shape the eye counts. Same floor
   wheelnear uses, so the two are comparable. */
const MIN_ISLAND = 90;

await run({ width: 1600, height: 900, hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0&ink=1` },
  async ({ page }) => {
    const nRamps = await page.evaluate(() => {
      window.__game.setPaused(true);
      return window.__game.track.ramps.length;
    });
    const idx = Math.min(RAMP, nRamps - 1);

    const out = await page.evaluate(([i, frames, shots, minIsland, zoom]) => {
      const g = window.__game, p = g.player, r = g.track.ramps[i];
      const pool = g.effects.particles;
      const THREE = g.THREE;
      const cv = g.renderer.domElement, w = cv.width, h = cv.height;
      const tmp = document.createElement('canvas');
      tmp.width = w; tmp.height = h;
      const tc = tmp.getContext('2d');
      const grab = () => { g.renderOnce(); tc.drawImage(cv, 0, 0); return tc.getImageData(0, 0, w, h).data; };
      const proj = (v) => {
        const q = v.clone().project(g.camera);
        return { x: (q.x * 0.5 + 0.5) * w, y: (-q.y * 0.5 + 0.5) * h };
      };

      g.setPaused(true);
      if (g.race?.entries) g.race.entries.length = 0;
      /* The page runs its own loop until this evaluate arrives, and those
         frames draw from the pool's RNG, so where the sequence starts depends
         on the wall clock. Without this reset two runs of the SAME build
         disagree — measured here at a couple of pixels of box and half an
         island — and no before/after comparison off this tool means anything.
         tools/b5burst.mjs does the same, for the same reason. */
      for (let j = 0; j < pool.max; j++) {
        pool.active[j] = 0; pool.scales[j * 2] = pool.scales[j * 2 + 1] = 0;
      }
      pool.live = 0; pool.cursor = 0; pool._resetRandom();
      g.autopilot(true, 0.85);
      g.driveTo((r.pad0 - 60) / g.track.length, { runUp: 320, maxSec: 45 });

      /* Fly it, then stop on the frame of touchdown. */
      let n = 0, wasAir = false, apex = 0;
      while (n++ < 900) {
        g.step(1 / 60);
        if (p.airborne) { wasAir = true; apex = Math.max(apex, p.height); }
        if (wasAir && !p.airborne) break;
      }
      /* Where the wheels came down, frozen: the rod is anchored to the world,
         not to the car, so it does not walk away with it. */
      const f0 = g.track.frameAt(p.s);
      const touch = p.pos.clone().addScaledVector(f0.up, -p.height);
      const upW = f0.up.clone();

      const real = performance.now.bind(performance);
      const rows = [], pngs = [];
      for (let f = 0; f < frames; f++) {
        g.setPaused(true);
        /* One clock across the pair, or the difference between them is
           partly weather. See the header. */
        const tPin = real(); performance.now = () => tPin;
        const shown = grab();
        pool.mesh.visible = false;
        const bare = grab();
        pool.mesh.visible = true;

        /* The rod, in screen pixels, re-projected every frame through the live
           camera so a moving lens cannot fake a taller plume.
           A rod behind the lens has no screen position at all: project()
           divides by w and a point behind the camera comes back mirrored, so
           the rungs invert and every reading taken off them is nonsense. The
           car drives past the touchdown point about a third of the way
           through a thirty-frame sweep, and from that frame on this used to
           print "0.00 m" with a risePx of -12440 beside it — a reading of
           zero that is really no reading. Validity is checked here once and
           the whole height column refuses when the rod is not in front. */
        g.camera.updateMatrixWorld();
        const rodOk = (() => {
          const inv = g.camera.matrixWorldInverse;
          for (const m of [0, 4]) {
            const v = touch.clone().addScaledVector(upW, m).applyMatrix4(inv);
            if (-v.z <= g.camera.near) return false;
          }
          return true;
        })();
        const rung = [0, 1, 2, 3, 4].map(m => proj(touch.clone().addScaledVector(upW, m)).y);
        /* Rungs must climb the screen as they climb the world. If they do not,
           something about the projection is not what this assumes. */
        const rodSane = rodOk && rung.every((y, k) => k === 0 || y < rung[k - 1]);
        const carLen = (() => {
          const a = proj(p.pos.clone().addScaledVector(p.forward, 2.05));
          const b = proj(p.pos.clone().addScaledVector(p.forward, -2.05));
          return Math.hypot(a.x - b.x, a.y - b.y);
        })();

        const mask = new Uint8Array(w * h);
        let plume = 0, top = h, bot = -1, x0 = w, x1 = -1;
        for (let q = 0; q < shown.length; q += 4) {
          const dr = Math.abs(shown[q] - bare[q]) + Math.abs(shown[q + 1] - bare[q + 1])
            + Math.abs(shown[q + 2] - bare[q + 2]);
          if (dr <= 12) continue;
          const idx2 = q >> 2, x = idx2 % w, y = (idx2 / w) | 0;
          mask[idx2] = 1; plume++;
          if (y < top) top = y; if (y > bot) bot = y;
          if (x < x0) x0 = x; if (x > x1) x1 = x;
        }

        /* Metres of standing height, by inverting the rod. Linear between the
           two rungs the top pixel falls between.
           A top pixel ABOVE the 4 m rung is not measurable with this rod and
           is not guessed at. Extrapolating off the last pair used to be the
           answer and it is a division by the screen-space gap between two
           rungs that converge towards the horizon: it returned 13.50 m for a
           burst standing about a metre, and 309,441 m on another seed. Those
           are not large heights, they are a broken instrument, and they were
           read as heights. `metres` is null in that case and the row says
           ">4". */
        let metres = 0;
        if (!rodSane) metres = null;                  // rod off the lens: no reading
        else if (plume) {
          if (top >= rung[0]) metres = 0;
          else if (top < rung[4]) metres = null;      // above the rod: no reading
          else {
            for (let k = 1; k < rung.length; k++) {
              if (top >= rung[k]) {
                metres = (k - 1) + (rung[k - 1] - top) / Math.max(1e-3, rung[k - 1] - rung[k]);
                break;
              }
            }
          }
        }

        /* Components, and how convex each one is. */
        const seen = new Uint8Array(w * h);
        const stack = new Int32Array(w * h);
        const islands = [];
        for (let q = 0; q < mask.length; q++) {
          if (!mask[q] || seen[q]) continue;
          let sp = 0, area = 0, ax0 = w, ax1 = -1, ay0 = h, ay1 = -1;
          stack[sp++] = q; seen[q] = 1;
          while (sp) {
            const c = stack[--sp];
            const x = c % w, y = (c / w) | 0;
            area++;
            if (x < ax0) ax0 = x; if (x > ax1) ax1 = x;
            if (y < ay0) ay0 = y; if (y > ay1) ay1 = y;
            if (x > 0 && mask[c - 1] && !seen[c - 1]) { seen[c - 1] = 1; stack[sp++] = c - 1; }
            if (x < w - 1 && mask[c + 1] && !seen[c + 1]) { seen[c + 1] = 1; stack[sp++] = c + 1; }
            if (y > 0 && mask[c - w] && !seen[c - w]) { seen[c - w] = 1; stack[sp++] = c - w; }
            if (y < h - 1 && mask[c + w] && !seen[c + w]) { seen[c + w] = 1; stack[sp++] = c + w; }
          }
          if (area >= minIsland) {
            islands.push({ area, w: ax1 - ax0 + 1, h: ay1 - ay0 + 1, fill: area / ((ax1 - ax0 + 1) * (ay1 - ay0 + 1)) });
          }
        }
        islands.sort((a, b) => b.area - a.area);
        const needles = islands.filter(s => s.area < 4000
          && Math.max(s.h / s.w, s.w / s.h) > 2.2).length;
        const big = islands[0];

        rows.push({
          f,
          plume: +(plume / (w * h) * 100).toFixed(3),
          top: plume ? top : -1,
          rise: metres === null ? null : +metres.toFixed(2),
          risePx: (plume && rodSane) ? +(rung[0] - top).toFixed(0) : null,
          wPx: plume ? x1 - x0 + 1 : 0,
          hPx: plume ? bot - top + 1 : 0,
          carLen: +carLen.toFixed(0),
          islands: islands.length,
          needles,
          /* Of the biggest island: what share of its own bounding box it fills.
             A round puff is ~0.7-0.8. A long tortuous ribbon is under 0.35. */
          fill: big ? +big.fill.toFixed(2) : 0,
          bigShare: big ? +(big.area / Math.max(plume, 1) * 100).toFixed(0) : 0,
          bigAspect: big ? +(big.w / Math.max(1, big.h)).toFixed(2) : 0,
          kmh: +(p.speed * 3.6).toFixed(0),
        });

        if (shots.includes(f)) {
          g.renderOnce();
          const c = document.createElement('canvas');
          const bw = 1000, bh = 560, sw = bw / zoom, sh = bh / zoom;
          const q = p.pos.clone().project(g.camera);
          c.width = bw; c.height = bh;
          const ctx = c.getContext('2d');
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(cv, Math.max(0, Math.min(w - sw, (q.x * 0.5 + 0.5) * w - sw / 2)),
            Math.max(0, Math.min(h - sh, (-q.y * 0.5 + 0.5) * h - sh * 0.45)), sw, sh, 0, 0, bw, bh);
          pngs.push({ f, full: cv.toDataURL('image/png'), crop: c.toDataURL('image/png') });
        }

        performance.now = real;
        g.setPaused(false);
        g.step(1 / 60);
      }
      g.autopilot(false);
      return { rows, pngs, apex: +apex.toFixed(2), lip: r.lip };
    }, [idx, N, SHOTS, MIN_ISLAND, ZOOM]);

    const dir = path.join(ROOT, 'shots', TAG);
    fs.mkdirSync(dir, { recursive: true });
    for (const s of out.pngs) {
      const nn = String(s.f).padStart(2, '0');
      fs.writeFileSync(path.join(dir, `f${nn}.png`), Buffer.from(s.full.split(',')[1], 'base64'));
      fs.writeFileSync(path.join(dir, `f${nn}-crop.png`), Buffer.from(s.crop.split(',')[1], 'base64'));
    }
    console.log(`\n  seed ${SEED} ramp ${idx} (lip ${out.lip}) — apex ${out.apex} m  → shots/${TAG}`);
    console.log('\n  frame  plume%   rise m  risePx   box wxh    carLen  islands  needles  big%  fill  aspect  km/h');
    for (const r of out.rows) {
      console.log(`  ${String(r.f).padStart(5)}${r.f === 0 ? '*' : ' '}${r.plume.toFixed(3).padStart(7)}`
        + ` ${(r.rise === null ? (r.risePx === null ? 'no rod' : '>4') : r.rise.toFixed(2)).padStart(8)}`
        + ` ${(r.risePx === null ? '—' : String(r.risePx)).padStart(7)}`
        + ` ${(r.wPx + 'x' + r.hPx).padStart(10)} ${String(r.carLen).padStart(9)}`
        + ` ${String(r.islands).padStart(8)} ${String(r.needles).padStart(8)}`
        + ` ${String(r.bigShare).padStart(5)} ${r.fill.toFixed(2).padStart(5)}`
        + ` ${r.bigAspect.toFixed(2).padStart(7)} ${String(r.kmh).padStart(5)}`);
    }
    /* Frame 0 is the driveTo artifact — edge pixels, about a quarter of a per
       cent of frame — and is printed above and counted in nothing. */
    const live = out.rows.slice(1).filter(r => r.plume > 0.2);
    if (live.length) {
      const m = k => live.reduce((a, r) => a + r[k], 0) / live.length;
      const measured = live.filter(r => r.rise !== null);
      console.log(`\n  over ${live.length} frames with a plume (frame 0 excluded — driveTo artifact):`);
      if (measured.length) {
        console.log(`    peak standing height ${Math.max(...measured.map(r => r.rise)).toFixed(2)} m`
          + `  (mean ${(measured.reduce((a, r) => a + r.rise, 0) / measured.length).toFixed(2)} m)`
          + (measured.length < live.length
            ? `  — over the ${measured.length} frames the rod could read;`
              + ` ${live.length - measured.length} could not be measured (top above the 4 m`
              + ' rung, or the rod behind the lens) and were NOT estimated'
            : ''));
      } else {
        console.log('    standing height: NOT MEASURABLE — every frame\'s top pixel is above the'
          + ' 4 m rod. No number is reported rather than one extrapolated off the horizon.');
      }
      console.log(`    plume box is ${m('wPx').toFixed(0)} px wide by ${m('hPx').toFixed(0)} px tall`
        + `  — car is ${m('carLen').toFixed(0)} px long`);
      /* Share first, count second, and the count is not a gate: it rewards a
         burst for shattering. See the header. */
      console.log(`    biggest island holds ${m('bigShare').toFixed(0)}% of the plume`
        + ` and fills ${m('fill').toFixed(2)} of its own box, aspect ${m('bigAspect').toFixed(2)}`);
      console.log(`    ${m('islands').toFixed(1)} islands and ${m('needles').toFixed(1)} needles`
        + ' per frame — descriptive only; island COUNT was withdrawn as a gate'
        + '\n      because a burst that fragments scores better on it than one clean mass.');
    }
  });

finish(process.exitCode || 0);
