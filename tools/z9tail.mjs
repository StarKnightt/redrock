/* The dissolution tail of the landing burst, measured where b5burst's island
 * gate cannot see it.
 *
 * b5burst reports the largest island's share of the WHOLE-POOL mask averaged
 * over the whole event, and both of those hide the tail: the peak frames are
 * genuinely one mass, and the pool's other classes are painting lumps of their
 * own. This looks at the burst's own pixels, frame by frame, and asks the
 * question the report actually asks — how many separate PALE shapes are there.
 *
 * "Pale" is the reported defect's own word and it is the load-bearing part of
 * the metric. The pool draws opaque (transparent: false, gl_FragColor alpha
 * 1.0), so a burst fragment can be present in a difference mask and still be
 * within a rung of the road it covers, which is not a shape anyone counts. A
 * mask pixel is counted only if the burst made it brighter than what it
 * covers by more than --lift of 255. Eight is about one rung of this palette.
 *
 * The erosion the critic proposed is reported too, at radii 0..2, and on this
 * build it is a no-op — see the sweep at the foot of every run. There are no
 * faint alpha halos bridging the lumps because there is no alpha.
 *
 * Everything this project has been misled by is handled as b5burst handles it:
 * the mask is BURST-ONLY (kind >= 4.5 zeroed) and not the whole-pool
 * difference; performance.now() is pinned across every measurement group;
 * frame 0 after the long driveTo is starred and excluded from every
 * aggregate; capture is 1600x900 through g.pipeline.render() with the car
 * driven in by autopilot and driveTo.
 *
 *   node tools/z9tail.mjs [--seeds 22,40] [--n 22] [--lift 8] [--floor 90]
 *                         [--erode 2] [--tag base] [--shots 1] [--from 13]
 */
import fs from 'node:fs';
import path from 'node:path';
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEEDS = flag('seeds', flag('seed', '22,40')).split(',').map(Number);
const RAMP = +flag('ramp', 1);
const N = +flag('n', 22);
const AT = +flag('at', 0.42);
const LIFT = +flag('lift', 8);
const FLOOR = +flag('floor', 90);
const ERODE = +flag('erode', 2);
const TAG = flag('tag', 'base');
const SHOTS = +flag('shots', 1);
const FROM = +flag('from', 13);
/* A fixed native-resolution window on the tail, for before/after plates. */
const CROP = flag('crop', '380,600,900,300').split(',').map(Number);

const summary = [];

for (const SEED of SEEDS) {
  await run({ width: 1600, height: 900, hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0&ink=1` },
    async ({ page }) => {
      const out = await page.evaluate(([ramp, frames, at, liftMin, floor, erodeMax, from, shots, cropArg]) => {
        const g = window.__game, p = g.player;
        const pool = g.effects.particles;
        const cropRect = cropArg;
        const cv = g.renderer.domElement, w = cv.width, h = cv.height;
        const tmp = document.createElement('canvas');
        tmp.width = w; tmp.height = h;
        const tc = tmp.getContext('2d', { willReadFrequently: true });
        const grab = () => { g.renderOnce(); tc.drawImage(cv, 0, 0); return tc.getImageData(0, 0, w, h).data; };
        const real = performance.now.bind(performance);
        const lum = (d, q) => 0.2126 * d[q] + 0.7152 * d[q + 1] + 0.0722 * d[q + 2];

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

        /* Four-neighbour erosion: a diamond of radius r after r passes, which
           is the cheapest element that cannot favour an axis. */
        const erodeOnce = (src, dst) => {
          for (let y = 0; y < h; y++) {
            const row = y * w;
            for (let x = 0; x < w; x++) {
              const c = row + x;
              dst[c] = (src[c]
                && x > 0 && src[c - 1] && x < w - 1 && src[c + 1]
                && y > 0 && src[c - w] && y < h - 1 && src[c + w]) ? 1 : 0;
            }
          }
        };

        const seen = new Uint8Array(w * h);
        const stack = new Int32Array(w * h);
        const label = (mask) => {
          seen.fill(0);
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
            if (area >= floor) areas.push(area);
          }
          areas.sort((a, b) => b - a);
          const kept = areas.reduce((a, b) => a + b, 0);
          return { n: areas.length, big: kept ? +(areas[0] / kept * 100).toFixed(0) : 0, kept };
        };

        const maskA = new Uint8Array(w * h);
        const maskB = new Uint8Array(w * h);
        const maskC = new Uint8Array(w * h);

        const frame = (wantShot) => {
          const t = real(); performance.now = () => t;
          const shown = grab();
          const noBurst = hideBurst();
          g.pipeline.inkEnabled = false;
          const noink = grab();
          g.pipeline.inkEnabled = true;
          performance.now = real;

          maskA.fill(0); maskC.fill(0);
          let px = 0, pale = 0, inked = 0, inkedPale = 0;
          /* Invariant 3's own quantity: the value the shape has relative to
             the value of what it covers. */
          let onSum = 0, underSum = 0;
          const lifts = [];
          for (let q = 0, c = 0; q < shown.length; q += 4, c++) {
            if (Math.abs(shown[q] - noBurst[q]) + Math.abs(shown[q + 1] - noBurst[q + 1])
              + Math.abs(shown[q + 2] - noBurst[q + 2]) <= 12) continue;
            maskA[c] = 1; px++;
            const a = lum(shown, q), b = lum(noBurst, q);
            const d = a - b;
            lifts.push(d);
            onSum += a; underSum += b;
            const drop = (lum(noink, q) - lum(shown, q)) / 255;
            if (drop > 0.02) inked++;
            if (d > liftMin) {
              maskC[c] = 1; pale++;
              if (drop > 0.02) inkedPale++;
            }
          }
          lifts.sort((a, b) => a - b);
          const pick = (f) => lifts.length ? +lifts[Math.min(lifts.length - 1,
            Math.floor(lifts.length * f))].toFixed(1) : 0;

          const raw = [label(maskA)];
          let cur = maskA, nxt = maskB;
          for (let r = 1; r <= erodeMax; r++) {
            erodeOnce(cur, nxt);
            const s = cur; cur = nxt; nxt = s;
            raw.push(label(cur));
          }
          const paleIsl = label(maskC);

          let shot = null, over = null, crop = null;
          if (wantShot && px > 0) {
            shot = tmp.toDataURL('image/png');
            /* A fixed window at native resolution, same rectangle every frame
               and every build, so two captures can be laid over each other.
               A crop of the mask's own bounding box was tried first and is
               useless for comparison: the box moves and rescales. */
            if (cropRect) {
              const [cx, cy, cw, ch] = cropRect;
              const cc = document.createElement('canvas');
              cc.width = cw; cc.height = ch;
              cc.getContext('2d').drawImage(tmp, cx, cy, cw, ch, 0, 0, cw, ch);
              crop = cc.toDataURL('image/png');
            }
            const oc = document.createElement('canvas');
            oc.width = w; oc.height = h;
            const octx = oc.getContext('2d');
            octx.drawImage(tmp, 0, 0);
            const im = octx.getImageData(0, 0, w, h);
            for (let c = 0, q = 0; c < maskC.length; c++, q += 4) {
              if (!maskC[c]) continue;
              im.data[q] = 255; im.data[q + 1] = 0; im.data[q + 2] = 200;
            }
            octx.putImageData(im, 0, 0);
            over = oc.toDataURL('image/png');
          }

          /* How near the lens the puffs are, because the vertex shader's near
             window (NEAR_GONE..NEAR_FULL) scales an instance down about its own
             centre once it is inside it — which is a shrink, and a shrink is
             what spends the overlap that holds the mass together. */
          let live = 0, ageMax = 0, depthMin = 1e9, depthSum = 0, nearSum = 0;
          let spreadMax = 0, spreadSum = 0;
          const cp = g.camera.position;
          for (let i = 0; i < pool.max; i++) {
            if (!pool.active[i] || pool.kind[i] < 4.5) continue;
            live++;
            if (pool.ages[i] > ageMax) ageMax = pool.ages[i];
            const dx = pool.centers[i * 3] - cp.x;
            const dy = pool.centers[i * 3 + 1] - cp.y;
            const dz = pool.centers[i * 3 + 2] - cp.z;
            const d = Math.hypot(dx, dy, dz);
            if (d < depthMin) depthMin = d;
            depthSum += d;
            const t = Math.min(1, Math.max(0, (d - 1.10) / (3.20 - 1.10)));
            nearSum += t * t * (3 - 2 * t);
            /* vSpread as the shader sees it: the instance's larger extent over
               its view depth, i.e. its angular size. */
            const sp = Math.max(pool.scales[i * 2], pool.scales[i * 2 + 1]) / Math.max(d, 0.01);
            if (sp > spreadMax) spreadMax = sp;
            spreadSum += sp;
          }
          return {
            px, pale, live, shot, over, crop,
            ageMax: +ageMax.toFixed(2),
            depthMin: live ? +depthMin.toFixed(2) : 0,
            depthMean: live ? +(depthSum / live).toFixed(2) : 0,
            near: live ? +(nearSum / live).toFixed(2) : 0,
            spread: live ? +(spreadSum / live).toFixed(2) : 0,
            spreadMax: +spreadMax.toFixed(2),
            liftMean: lifts.length ? +(lifts.reduce((a, b) => a + b, 0) / lifts.length).toFixed(1) : 0,
            ratio: underSum > 0 ? +(onSum / underSum).toFixed(2) : 0,
            liftP50: pick(0.50), liftP95: pick(0.95),
            ink: px ? +(inked / px * 100).toFixed(1) : 0,
            inkPale: pale ? +(inkedPale / pale * 100).toFixed(1) : 0,
            raw, paleIsl,
          };
        };

        g.setPaused(true);
        if (g.race?.entries) g.race.entries.length = 0;
        for (let i = 0; i < pool.max; i++) {
          pool.active[i] = 0; pool.scales[i * 2] = pool.scales[i * 2 + 1] = 0;
        }
        pool.live = 0; pool.cursor = 0; pool._resetRandom();

        const r = g.track.ramps[Math.min(ramp, g.track.ramps.length - 1)];
        g.autopilot(true, 0.85);
        g.driveTo((r.pad0 - 60) / g.track.length, { runUp: 320, maxSec: 45 });
        let k = 0, wasAir = false;
        while (k++ < 900) { g.step(1 / 60); if (p.airborne) wasAir = true; if (wasAir && !p.airborne) break; }

        const rows = [];
        for (let f = 0; f < frames; f++) {
          g.setPaused(true);
          rows.push(frame(shots && f >= from));
          g.setPaused(false);
          g.step(1 / 60);
        }
        g.autopilot(false);
        return { seed: g.track.seed, rows };
      }, [RAMP, N, AT, LIFT, FLOOR, ERODE, FROM, SHOTS, CROP]);

      const dir = path.join('shots', `z9-${TAG}-${out.seed}`);
      fs.mkdirSync(dir, { recursive: true });
      out.rows.forEach((r, i) => {
        if (!r.shot) return;
        const n = String(i).padStart(2, '0');
        fs.writeFileSync(path.join(dir, `f${n}.png`), Buffer.from(r.shot.split(',')[1], 'base64'));
        fs.writeFileSync(path.join(dir, `f${n}-pale.png`), Buffer.from(r.over.split(',')[1], 'base64'));
        if (r.crop) {
          fs.writeFileSync(path.join(dir, `f${n}-crop.png`), Buffer.from(r.crop.split(',')[1], 'base64'));
        }
        delete r.shot; delete r.over; delete r.crop;
      });

      console.log(`\n  seed ${out.seed}  [${TAG}]  burst-only mask;`
        + ` pale = brighter than what it covers by >${LIFT}/255; islands floored at ${FLOOR} px`);
      console.log('   frame  burstPx   palePx  live  vAge  lensM min/mean  near  x_gnd sprd/max'
        + '   lift mean/p50/p95   ink%  inkPale%'
        + '   pale n/big%   raw n/big%  e1 n/big%  e2 n/big%');
      out.rows.forEach((r, i) => {
        console.log(`   ${String(i).padStart(5)}${i === 0 ? '*' : ' '}`
          + `${String(r.px).padStart(7)} ${String(r.pale).padStart(8)}`
          + ` ${String(r.live).padStart(5)} ${r.ageMax.toFixed(2).padStart(5)}`
          + ` ${r.depthMin.toFixed(2).padStart(7)}/${r.depthMean.toFixed(2).padStart(5)}`
          + ` ${r.near.toFixed(2).padStart(5)} ${r.ratio.toFixed(2).padStart(5)}`
          + ` ${r.spread.toFixed(2).padStart(5)}/${r.spreadMax.toFixed(2).padStart(4)}`
          + ` ${String(r.liftMean).padStart(7)}/${String(r.liftP50).padStart(5)}/${String(r.liftP95).padStart(5)}`
          + ` ${r.ink.toFixed(1).padStart(6)} ${r.inkPale.toFixed(1).padStart(9)}`
          + `   ${String(r.paleIsl.n).padStart(4)}/${String(r.paleIsl.big).padStart(3)}`
          + r.raw.map(L => `   ${String(L.n).padStart(3)}/${String(L.big).padStart(3)}`).join(''));
      });

      const live = out.rows.map((r, i) => ({ ...r, i })).filter(r => r.i > 0 && r.px > 0);
      if (!live.length) { console.log('    no burst'); return; }
      const peak = Math.max(...live.map(r => r.px));
      const peakAt = live.find(r => r.px === peak).i;
      const tail = live.filter(r => r.i > peakAt);
      const draw = live[live.length - 1].i;
      /* Invariant 3 states the ceiling as a ratio to the ground the particle
         came off. It is applied at emit time against an authored swatch, so
         it can hold there and be broken on screen — this is that ratio
         measured where it is actually seen. */
      console.log(`\n    value against what it covers: ${Math.max(...live.map(r => r.ratio)).toFixed(2)}x`
        + ` at worst, ${(live.reduce((a, r) => a + r.ratio * r.px, 0)
          / live.reduce((a, r) => a + r.px, 0)).toFixed(2)}x area-weighted`
        + `  (invariant 3's ceiling is 2.05)`);
      console.log(`    peak ${peak} px at frame ${peakAt}; drawn to frame ${draw};`
        + ` tail ${tail.length ? tail[0].i + '..' + tail[tail.length - 1].i : '(none)'}`);
      const t = tail.filter(x => x.pale > 0);
      const worstBig = t.length ? Math.min(...t.map(x => x.paleIsl.big)) : 100;
      const worstN = t.length ? Math.max(...t.map(x => x.paleIsl.n)) : 0;
      console.log(`    over the tail: pale islands peak at ${worstN}`
        + `, largest pale island falls to ${worstBig}%`);
      console.log(`    last frame drawn carries ${live[live.length - 1].pale} pale px`
        + ` in ${live[live.length - 1].paleIsl.n} islands`);
      console.log(`    erosion sweep over the tail (raw / e1 / e2), largest-island %: `
        + [0, 1, 2].map(r => (t.length ? Math.min(...t.map(x => x.raw[r].big)) : 100) + '%').join(' / '));
      summary.push({ seed: out.seed, worstN, worstBig, peakAt, draw,
        lastPale: live[live.length - 1].pale });
    });
}

console.log('\n  ── summary ──');
for (const s of summary) {
  console.log(`  ${TAG} seed ${s.seed}: peak f${s.peakAt}, drawn to f${s.draw},`
    + ` tail pale islands <= ${s.worstN}, largest pale island >= ${s.worstBig}%,`
    + ` last frame ${s.lastPale} pale px`);
}

finish(process.exitCode || 0);
