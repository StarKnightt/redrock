/* Landing-burst gate, corrected. One instrument, one run, per seed.
 *
 * This exists because the three probes that were being read together each
 * carried a defect the round-3 critic named:
 *
 *   - the first grab() after a long driveTo carries an artifact that inflates
 *     the plume mask by ~0.25% of frame with EDGE pixels, which is where ink
 *     lives, and can turn a 3.5% ink reading into 26.7%. Frame 0 is measured
 *     and printed, and excluded from every mean.
 *   - src/world/environment.js sets a shader uniform from performance.now()
 *     inside onBeforeRender, so two renders of an unchanged scene are
 *     different images. performance.now() is pinned across each measurement
 *     triple, exactly as tools/r3pad.mjs and tools/r3ink.mjs do.
 *   - c2burst's island COUNT rewards fragmentation, which is the defect. The
 *     gate here is the largest island's SHARE of the plume, with a floor.
 *   - c2burst's height column extrapolates off the end of its 4 m rod and is
 *     not read at all. Reach is reported in metres from the pool's own
 *     instance state instead, which is camera-independent by construction.
 *
 * Screen-space columns (plume, ink, islands, box) are measured on the same
 * pool-visible / pool-hidden difference every other probe uses. World-space
 * columns come from the live instances: track.project() gives each puff's
 * lateral offset and height in metres, so "outside the kerbs" and "hanging in
 * mid-air" are answered in metres rather than guessed from pixels.
 *
 * Nothing under src/ is touched.
 *
 *   node tools/b5burst.mjs [--seed 22] [--ramp 1] [--n 30] [--at 0.42]
 */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEEDS = flag('seeds', flag('seed', '22')).split(',').map(Number);
const RAMP = +flag('ramp', 1);
const N = +flag('n', 30);
const AT = +flag('at', 0.42);
/* Same floor wheelnear and c2burst use, so island counts stay comparable. */
const MIN_ISLAND = 90;

for (const SEED of SEEDS) {
  await run({ width: 1600, height: 900, hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0&ink=1` },
    async ({ page }) => {
      const out = await page.evaluate(([ramp, frames, minIsland, at]) => {
        const g = window.__game, p = g.player;
        const pool = g.effects.particles;
        const cv = g.renderer.domElement, w = cv.width, h = cv.height;
        const tmp = document.createElement('canvas');
        tmp.width = w; tmp.height = h;
        const tc = tmp.getContext('2d');
        const grab = () => { g.renderOnce(); tc.drawImage(cv, 0, 0); return tc.getImageData(0, 0, w, h).data; };
        const proj = (v) => {
          const q = v.clone().project(g.camera);
          return { x: (q.x * 0.5 + 0.5) * w, y: (-q.y * 0.5 + 0.5) * h };
        };
        const real = performance.now.bind(performance);

        /* The three renders of one frame, with the animation clock pinned so
           they differ only in the one thing each is meant to differ in. */
        const carParts = [];
        g.scene.traverse(o => { if (/^(shell|wheel\d)/.test(o.name)) carParts.push(o); });
        /* The burst alone, with the rest of the pool left standing.
         *
         * The plume mask below is a pool-visible / pool-hidden difference, so
         * it is every particle the pool owns and not the landing burst. On a
         * seed where the car is still throwing a speed veil that does not
         * matter for ink, which is a ratio, but it wrecks duration: measured
         * on seed 40, frames 19-29 of the mask are byte-identical between two
         * builds whose bursts differ completely, because by then the mask is
         * the car's ordinary dust. Read against the burst's own peak, that
         * tail is counted as burst life — and it moves when the peak moves, so
         * a build that makes the burst smaller measures as a longer event.
         * Hiding only the burst instances answers the question that was meant.
         */
        const hideBurst = () => {
          const kept = [];
          for (let i = 0; i < pool.max; i++) {
            if (pool.kind[i] < 4.5) continue;
            kept.push([i, pool.scales[i * 2], pool.scales[i * 2 + 1]]);
            pool.scales[i * 2] = pool.scales[i * 2 + 1] = 0;
          }
          pool.scaleAttr.needsUpdate = true;
          const img = grab();
          for (const [i, sx, sy] of kept) { pool.scales[i * 2] = sx; pool.scales[i * 2 + 1] = sy; }
          pool.scaleAttr.needsUpdate = true;
          return img;
        };

        const shots = () => {
          const t = real(); performance.now = () => t;
          const shown = grab();
          const noBurst = hideBurst();
          pool.mesh.visible = false;
          const bare = grab();
          pool.mesh.visible = true;
          g.pipeline.inkEnabled = false;
          const noink = grab();
          g.pipeline.inkEnabled = true;
          const was = carParts.map(o => o.visible);
          carParts.forEach(o => { o.visible = false; });
          const noCar = grab();
          carParts.forEach((o, i) => { o.visible = was[i]; });
          performance.now = real;
          return { shown, bare, noink, noCar, noBurst };
        };

        const screen = () => {
          const { shown, bare, noink, noCar, noBurst } = shots();
          let burstPx = 0;
          for (let q = 0; q < shown.length; q += 4) {
            if (Math.abs(shown[q] - noBurst[q]) + Math.abs(shown[q + 1] - noBurst[q + 1])
              + Math.abs(shown[q + 2] - noBurst[q + 2]) > 12) burstPx++;
          }
          /* How much of the car is still on screen. A plume that reads as one
             mass is also a plume that can hide the hero behind it, and that is
             a real cost of merging the lobes, so it is measured rather than
             assumed: the car's parts are hidden and the frame differenced,
             which counts only the car pixels the plume is not already over. */
          let carVis = 0;
          for (let q = 0; q < shown.length; q += 4) {
            if (Math.abs(shown[q] - noCar[q]) + Math.abs(shown[q + 1] - noCar[q + 1])
              + Math.abs(shown[q + 2] - noCar[q + 2]) > 12) carVis++;
          }
          const mask = new Uint8Array(w * h);
          let plume = 0, inked = 0, world = 0, inkWorld = 0;
          let top = h, bot = -1, x0 = w, x1 = -1;
          for (let q = 0; q < shown.length; q += 4) {
            const dr = Math.abs(shown[q] - bare[q]) + Math.abs(shown[q + 1] - bare[q + 1])
              + Math.abs(shown[q + 2] - bare[q + 2]);
            const drop = (0.2126 * (noink[q] - shown[q]) + 0.7152 * (noink[q + 1] - shown[q + 1])
              + 0.0722 * (noink[q + 2] - shown[q + 2])) / 255;
            if (dr > 12) {
              const c = q >> 2, x = c % w, y = (c / w) | 0;
              mask[c] = 1; plume++;
              if (drop > 0.02) inked++;
              if (y < top) top = y; if (y > bot) bot = y;
              if (x < x0) x0 = x; if (x > x1) x1 = x;
            } else { world++; if (drop > 0.02) inkWorld++; }
          }
          /* Connected components, four-neighbour, same as c2burst. */
          const seen = new Uint8Array(w * h);
          const stack = new Int32Array(w * h);
          const areas = [];
          for (let q = 0; q < mask.length; q++) {
            if (!mask[q] || seen[q]) continue;
            let sp = 0, area = 0;
            stack[sp++] = q; seen[q] = 1;
            while (sp) {
              const c = stack[--sp];
              const x = c % w, y = (c / w) | 0;
              area++;
              if (x > 0 && mask[c - 1] && !seen[c - 1]) { seen[c - 1] = 1; stack[sp++] = c - 1; }
              if (x < w - 1 && mask[c + 1] && !seen[c + 1]) { seen[c + 1] = 1; stack[sp++] = c + 1; }
              if (y > 0 && mask[c - w] && !seen[c - w]) { seen[c - w] = 1; stack[sp++] = c - w; }
              if (y < h - 1 && mask[c + w] && !seen[c + w]) { seen[c + w] = 1; stack[sp++] = c + w; }
            }
            if (area >= minIsland) areas.push(area);
          }
          areas.sort((a, b) => b - a);
          const carLen = (() => {
            const a = proj(p.pos.clone().addScaledVector(p.forward, 2.05));
            const b = proj(p.pos.clone().addScaledVector(p.forward, -2.05));
            return Math.hypot(a.x - b.x, a.y - b.y);
          })();
          return {
            plumePct: +(plume / (w * h) * 100).toFixed(3),
            burstPct: +(burstPx / (w * h) * 100).toFixed(3),
            plumePx: plume,
            inkedPx: inked,
            ink: +(plume ? inked / plume * 100 : 0).toFixed(2),
            world: +(inkWorld / world * 100).toFixed(2),
            islands: areas.length,
            big: +(plume ? (areas[0] || 0) / plume * 100 : 0).toFixed(0),
            wPx: plume ? x1 - x0 + 1 : 0,
            hPx: plume ? bot - top + 1 : 0,
            carPx: +carLen.toFixed(0),
            boxCars: +(plume ? (x1 - x0 + 1) / Math.max(carLen, 1) : 0).toFixed(1),
            carVis,
          };
        };

        /* What the pool actually has in the world, in metres. A puff's own
           half-extent is added, so "outside the kerbs" means the drawn shape
           crosses the kerb and not merely its centre. */
        const world = () => {
          let n = 0, maxLat = 0, overKerb = 0, worstOver = 0, minFoot = 1e9;
          let airborne = 0, maxTop = 0, halfW = 0, maxSpan = 0;
          for (let i = 0; i < pool.max; i++) {
            if (!pool.active[i] || pool.kind[i] < 4.5) continue;
            const c = new g.THREE.Vector3(
              pool.centers[i * 3], pool.centers[i * 3 + 1], pool.centers[i * 3 + 2]);
            const sx = pool.scales[i * 2], sy = pool.scales[i * 2 + 1];
            const q = g.track.project(c, p.s);
            const half = q.width * 0.5;
            halfW = half;
            n++;
            const reach = Math.abs(q.lat) + sx * 0.5;
            if (reach > maxLat) maxLat = reach;
            if (reach > half) { overKerb++; worstOver = Math.max(worstOver, reach - half); }
            const foot = q.height - sy * 0.5;
            if (foot < minFoot) minFoot = foot;
            if (foot > 0.55) airborne++;
            maxTop = Math.max(maxTop, q.height + sy * 0.5);
            maxSpan = Math.max(maxSpan, sx, sy);
          }
          return {
            n,
            maxLat: +maxLat.toFixed(2),
            halfW: +halfW.toFixed(2),
            overKerb,
            worstOver: +worstOver.toFixed(2),
            minFoot: n ? +minFoot.toFixed(2) : 0,
            airborne,
            reachM: +maxTop.toFixed(2),
            maxSpan: +maxSpan.toFixed(2),
          };
        };

        g.setPaused(true);
        if (g.race?.entries) g.race.entries.length = 0;
        /* The page runs its own loop until this evaluate arrives, and those
           frames draw from the pool's RNG. The offset is wall-clock dependent,
           so without this two runs of the same build disagree by a couple of
           points of ink and no before/after comparison means anything. */
        for (let i = 0; i < pool.max; i++) {
          pool.active[i] = 0; pool.scales[i * 2] = pool.scales[i * 2 + 1] = 0;
        }
        pool.live = 0; pool.cursor = 0; pool._resetRandom();

        /* 1. The near-wheel veil, which passes and must not change. Frame 0 is
              the driveTo artifact and is excluded below. */
        g.autopilot(true, 1.0);
        g.driveTo(at, { runUp: 420, maxSec: 60 });
        for (let k = 0; k < 90; k++) g.step(1 / 60);
        const veil = [];
        for (let f = 0; f < 6; f++) { g.setPaused(true); veil.push(screen()); g.setPaused(false); g.step(1 / 60); }

        /* 2. The landing burst, from the frame of touchdown. */
        const r = g.track.ramps[Math.min(ramp, g.track.ramps.length - 1)];
        g.autopilot(true, 0.85);
        g.driveTo((r.pad0 - 60) / g.track.length, { runUp: 320, maxSec: 45 });
        let k = 0, wasAir = false;
        while (k++ < 900) { g.step(1 / 60); if (p.airborne) wasAir = true; if (wasAir && !p.airborne) break; }
        const land = [], geo = [];
        let govP99 = 0;
        const cov = [];
        for (let f = 0; f < frames; f++) {
          g.setPaused(true);
          land.push(screen());
          geo.push(world());
          cov.push(pool.coverage);
          g.setPaused(false);
          g.step(1 / 60);
        }
        cov.sort((a, b) => a - b);
        govP99 = cov[Math.min(cov.length - 1, Math.floor(cov.length * 0.99))];

        g.autopilot(false);
        return { seed: g.track.seed, lip: r.lip, veil, land, geo, govP99: +govP99.toFixed(3) };
      }, [RAMP, N, MIN_ISLAND, AT]);

      const drop0 = rows => rows.slice(1);
      const mean = (rows, k) => rows.reduce((a, r) => a + r[k], 0) / Math.max(rows.length, 1);

      console.log(`\n  seed ${out.seed}, ramp lip ${out.lip}`);
      console.log('\n  near-wheel veil (frame 0 is the driveTo artifact; excluded from the mean)');
      console.log('   frame   plume%   ink%   world%');
      out.veil.forEach((r, i) => console.log(`   ${String(i).padStart(5)}${i === 0 ? '*' : ' '}`
        + `${r.plumePct.toFixed(3).padStart(7)} ${r.ink.toFixed(2).padStart(6)} ${r.world.toFixed(2).padStart(8)}`));
      const v = drop0(out.veil);
      console.log(`   veil ink ${mean(v, 'ink').toFixed(2)}%   world ${mean(v, 'world').toFixed(2)}%`);

      console.log('\n  landing burst, from touchdown');
      /* The car column used to print under the "puffs" heading and the puff
         count under "|lat|m", so every column from there right was read one
         to the left of its own name. */
      console.log('   frame   plume%  burst%   ink%  world%  islands  big%   box wxh   car  boxCars'
        + '   carVis  puffs  |lat|m  half  over  air  reach m');
      out.land.forEach((r, i) => {
        const q = out.geo[i];
        console.log(`   ${String(i).padStart(5)} ${r.plumePct.toFixed(3).padStart(7)}`
          + ` ${r.burstPct.toFixed(3).padStart(7)}`
          + ` ${r.ink.toFixed(2).padStart(6)} ${r.world.toFixed(2).padStart(6)}`
          + ` ${String(r.islands).padStart(8)} ${String(r.big).padStart(5)}`
          + ` ${(r.wPx + 'x' + r.hPx).padStart(10)} ${String(r.carPx).padStart(5)}`
          + ` ${r.boxCars.toFixed(1).padStart(8)} ${String(r.carVis).padStart(6)}`
          + ` ${String(q.n).padStart(7)} ${q.maxLat.toFixed(2).padStart(7)}`
          + ` ${q.halfW.toFixed(2).padStart(5)} ${String(q.overKerb).padStart(5)}`
          + ` ${String(q.airborne).padStart(4)} ${q.reachM.toFixed(2).padStart(8)}`);
      });

      const live = out.land.filter(r => r.plumePct > 0.2);
      const peak = Math.max(...out.land.map(r => r.plumePct));
      const above = out.land.filter(r => r.plumePct >= peak * 0.15).length;
      if (live.length) {
        console.log(`\n  over ${live.length} frames with a plume:`);
        console.log(`    ink ${mean(live, 'ink').toFixed(2)}%  against world ${mean(live, 'world').toFixed(2)}%`
          + `  — ${(mean(live, 'ink') / mean(live, 'world')).toFixed(2)}x the frame`);
        /* Every frame counted once weights a plume of two hundred pixels the
           same as the peak, and the last frames of a burst are two hundred
           pixels of dissolving fragments. Over the whole event, of all the
           pixels the burst painted, this is the share that carried ink. */
        const tot = live.reduce((a, r) => a + r.plumePx, 0);
        const tin = live.reduce((a, r) => a + r.inkedPx, 0);
        console.log(`    ink over the whole event, area-weighted: ${(tin / tot * 100).toFixed(2)}%`);
        const grown = live.filter(r => r.big >= 60);
        if (grown.length) {
          const gt = grown.reduce((a, r) => a + r.plumePx, 0);
          const gi = grown.reduce((a, r) => a + r.inkedPx, 0);
          console.log(`    ...over the ${grown.length} frames the mass is still one island:`
            + ` ${(gi / gt * 100).toFixed(2)}%`);
        }
        console.log(`    largest island holds ${mean(live, 'big').toFixed(0)}% of the plume`
          + `, over ${mean(live, 'islands').toFixed(1)} islands`);
        console.log(`    box ${mean(live, 'wPx').toFixed(0)} x ${mean(live, 'hPx').toFixed(0)} px`
          + `, car ${mean(live, 'carPx').toFixed(0)} px — ${mean(live, 'boxCars').toFixed(1)} car lengths wide`
          + ` (worst ${Math.max(...live.map(r => r.boxCars)).toFixed(1)})`);
        const bpeak = Math.max(...out.land.map(r => r.burstPct));
        const babove = out.land.filter(r => r.burstPct >= bpeak * 0.15).length;
        console.log(`    duration ${above} frames above 15% of peak (${(above / 60).toFixed(2)} s)`
          + ` — of the whole pool's mask`);
        console.log(`    duration ${babove} frames above 15% of peak (${(babove / 60).toFixed(2)} s)`
          + ` — of the burst's own pixels`);
        /* The ratio test is the brief's, and it is kept, but on a burst that
           ramps steeply it mostly reports how the FIRST frame compares to the
           peak: on seed 40 frames 0-3 sit within 15% of each other, so a small
           change in that ratio flips three frames at once. How many frames the
           burst is actually drawn on does not have that problem. */
        const drawn = out.land.filter(r => r.burstPct > 0.02).length;
        const last = out.land.reduce((a, r, i) => (r.burstPct > 0.02 ? i : a), -1);
        console.log(`    the burst is drawn on ${drawn} frames (${(drawn / 60).toFixed(2)} s)`
          + `, last on frame ${last}`);
        console.log(`    car still visible: ${Math.min(...out.land.map(r => r.carVis))} px at worst`
          + `, ${mean(live, "carVis").toFixed(0)} px mean over the plume's life`);
        const g2 = out.geo.filter(q => q.n > 0);
        console.log(`    world: worst |lat| ${Math.max(...g2.map(q => q.maxLat)).toFixed(2)} m`
          + ` against a ${g2[0].halfW.toFixed(2)} m half-road`
          + `, ${Math.max(...g2.map(q => q.overKerb))} puffs over the kerb at worst`
          + ` (by ${Math.max(...g2.map(q => q.worstOver)).toFixed(2)} m)`);
        console.log(`    world: the lowest puff's foot sits between`
          + ` ${Math.min(...g2.map(q => q.minFoot)).toFixed(2)} m and`
          + ` ${Math.max(...g2.map(q => q.minFoot)).toFixed(2)} m of the road over the event`);
        console.log(`    world: ${Math.max(...g2.map(q => q.airborne))} puffs with their foot`
          + ` over 0.55 m off the road at worst; plume reaches ${Math.max(...g2.map(q => q.reachM)).toFixed(2)} m`);
        console.log(`    governor coverage p99 over these frames: ${out.govP99}`);
      }
    });
}

finish(process.exitCode || 0);
