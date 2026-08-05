/* The landing burst, frame by frame, on an exact clock.
 *
 * tools/dustjudge.mjs is the gate and stays the gate — but it renders one
 * frame per round trip to the browser and unpauses in between, so the game's
 * own loop runs free while the tool is not looking and a "frame" there is
 * worth one or two sim steps depending on how the machine felt. That is fine
 * for a verdict and useless for tuning: two runs of the same drive do not put
 * the same moment on the same row.
 *
 * This does the whole sweep inside a single page.evaluate — pause, render
 * three ways, measure, step exactly 1/60, repeat — so every row is exactly
 * one sixtieth of a second after the last one, and a change to a curve in
 * particles.js shows up as a change in the column and not as drift. The three
 * renders are the same three dustjudge uses, so the numbers are comparable:
 * with particles, without (an exact plume mask by difference), and with
 * particles but no ink (an exact ink mask by difference).
 *
 * It also reports what the pool thinks it is doing — instance ages, the
 * curtain's height and radius in metres, its distance from the lens and where
 * it lands on screen — which is what separates "the dust died" from "the dust
 * left the picture". Those two failures look identical in a coverage column
 * and want opposite fixes.
 *
 * Read-only. Nothing under src/ is touched.
 *
 *   node tools/dustlife.mjs [--seed 22] [--ramp 1] [--n 40]
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
const N = +flag('n', 40);
const SHOTS = (flag('shots', '') || '').split(',').filter(Boolean).map(Number);
/* Which of the burst's two primitives to draw. The curtain and the ground
   sheet fail in different places and want different fixes, and in a finished
   frame they are the same colour lying on top of each other, so a capture of
   the pair cannot say which one drew the shape you are looking at. */
const ONLY = flag('only', 'all');
/* Frame at which to take the curtain apart instance by instance. Every capture
   of this effect so far has been of the composite, and a composite cannot say
   which of the twenty-four quads drew the shape that is wrong — three rounds
   of reasoning about foreshortening were spent on a silhouette that turned out
   not to belong to the segment they were about. This draws each instance on
   its own and reports the box it covers, so the spire in a column of pixels
   can be traced to the instance that owns it. */
const ANATOMY = flag('anatomy', '');
/* Nth drawn burst instance, in ring order, rendered on its own. */
const SOLO = flag('solo', '');
const BYKIND = args.includes('--bykind');
/* Horizontal offset of the magnified crop, in screen widths from the car. The
   flanks of the ring are the part that has been failing review and they are
   half a frame away from the car, so a crop centred on the car is exactly the
   crop that cannot show them. */
const PAN = +flag('pan', 0);
/* --kind lo,hi keeps only that kind band. */
const KEEP = flag('kind', '') ? flag('kind', '').split(',').map(Number) : null;
const TAG = flag('tag', `dustlife${SEED}`);

await run({ width: 1600, height: 900, hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0&ink=1` },
  async ({ page }) => {
  const n = await page.evaluate(() => { window.__game.setPaused(true); return window.__game.track.ramps.length; });
  const idx = Math.min(RAMP, n - 1);

  const out = await page.evaluate(([i, frames, shots, only, anatomy, solo, byKind, pan, keep]) => {
    const g = window.__game, r = g.track.ramps[i];
    const p = g.player;
    const pool = g.effects.particles;
    const events = [];
    const realBurst = pool.emitLandingBurst.bind(pool);
    pool.emitLandingBurst = (point, car, strength, surface, scale) => {
      events.push(`land  strength ${(+strength).toFixed(2)}  scale ${(+scale).toFixed(2)}`
        + `  speed ${(car.speed || 0).toFixed(1)} m/s`);
      return realBurst(point, car, strength, surface, scale);
    };
    g.autopilot(true, 0.85);
    g.driveTo((r.pad0 - 60) / g.track.length, { runUp: 320, maxSec: 45 });
    let k = 0, air = 0;
    while (k++ < 900) {
      g.step(1 / 60);
      if (p.airborne) air += 1 / 60;
      if (p.launched && p.sinceLaunch > 0.05 && !p.airborne) break;
    }

    const cv = g.renderer.domElement, w = cv.width, h = cv.height;
    const tmp = document.createElement('canvas');
    tmp.width = w; tmp.height = h;
    const tc = tmp.getContext('2d');
    const grab = () => { g.renderOnce(); tc.drawImage(cv, 0, 0); return tc.getImageData(0, 0, w, h).data; };
    /* src/world/environment.js sets a shader uniform from performance.now()
       inside onBeforeRender, so two renders of a frozen scene are genuinely
       different images and the pool-visible / pool-hidden difference picks up
       swaying grass along with the dust. Pinned across each frame's renders,
       the way r3ink, r3pad, x4gate and b5burst all do it. */
    const realNow = performance.now.bind(performance);
    const V = p.pos.constructor;
    const fwd = new V();
    const v = new V();
    const cp = new V();
    const rows = [];
    const pngs = [];

    /* Suppressed by scaling the quad to nothing rather than by clearing
       active, so the pool's own bookkeeping — ages, coverage, the governor —
       runs exactly as it would in the finished frame and only the drawing
       changes. */
    const hide = () => {
      /* Keep one exact kind band and drop everything else. The wall/sheet pair
         above only ever suppressed the other half of the burst, so a shape that
         was in neither survived both runs and looked, twice, like whichever of
         them was left — which is how the needles got attributed first to the
         landing and then to the sheet. Naming the band leaves nothing to
         infer: if the shape is still there, it is that band. */
      if (keep) {
        for (let j = 0; j < pool.max; j++) {
          if (!pool.active[j] || (pool.kind[j] >= keep[0] && pool.kind[j] <= keep[1])) continue;
          pool.scaleAttr.array[j * 2] = 0; pool.scaleAttr.array[j * 2 + 1] = 0;
        }
        pool.scaleAttr.needsUpdate = true;
        return;
      }
      if (only === 'all') return;
      const lo = only === 'wall' ? 2.5 : 3.5, hi = only === 'wall' ? 3.5 : 4.5;
      for (let j = 0; j < pool.max; j++) {
        if (!pool.active[j] || pool.kind[j] < lo || pool.kind[j] > hi) continue;
        pool.scaleAttr.array[j * 2] = 0; pool.scaleAttr.array[j * 2 + 1] = 0;
      }
      pool.scaleAttr.needsUpdate = true;
    };

    for (let f = 0; f < frames; f++) {
      g.setPaused(true);
      const tPin = realNow(); performance.now = () => tPin;
      hide();
      const shown = grab();
      if (shots.includes(f)) {
        g.renderOnce();
        const c = document.createElement('canvas');
        const bw = 800, bh = 450, sw = bw / 3.0, sh = bh / 3.0;
        const q = p.pos.clone().project(g.camera);
        q.x += pan * 2.0;
        c.width = bw; c.height = bh;
        const ctx = c.getContext('2d');
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(cv, Math.max(0, Math.min(w - sw, (q.x * 0.5 + 0.5) * w - sw / 2)),
          Math.max(0, Math.min(h - sh, (-q.y * 0.5 + 0.5) * h - sh / 2)), sw, sh, 0, 0, bw, bh);
        pngs.push({ f, full: cv.toDataURL('image/png'), crop: c.toDataURL('image/png') });
      }
      const shot = shots.includes(f);
      pool.mesh.visible = false;
      const bare = grab();
      /* The same crop with the whole pool hidden. Attribution by paint says
         which class drew a shape only if the shape is in the pool at all, and
         twice now a shape has been read off a painted capture and chased
         through the wrong file. This says, with no inference, whether the
         thing in the crop is dust or is the world. */
      if (shots.includes(f)) {
        const bc = document.createElement('canvas');
        bc.width = 800; bc.height = 450;
        const bx = bc.getContext('2d');
        bx.imageSmoothingEnabled = false;
        const bq = p.pos.clone().project(g.camera);
        bx.drawImage(cv, Math.max(0, Math.min(w - 800 / 3, (bq.x * 0.5 + 0.5) * w - 400 / 3)),
          Math.max(0, Math.min(h - 450 / 3, (-bq.y * 0.5 + 0.5) * h - 225 / 3)),
          800 / 3, 450 / 3, 0, 0, 800, 450);
        pngs.push({ f: 800 + f, full: cv.toDataURL('image/png'), crop: bc.toDataURL('image/png') });
      }
      pool.mesh.visible = true;
      g.pipeline.inkEnabled = false;
      const noink = grab();
      g.pipeline.inkEnabled = true;

      let plume = 0, inkPlume = 0, inkWorld = 0, world = 0;
      /* Ink mass as well as ink coverage. dustjudge counts a pixel as inked
         at a two per cent drop in luma, which a wide soft stroke trips a long
         way from its centre, so coverage alone cannot tell a confident
         contour from a scribble. Summing the drops says how much pen was
         spent per unit of picture, which is the comparison that means
         something between a torn cloud and a road. And the top-bucket share
         says whether the plume's brightest rungs are separate values or one
         clipped white — the measurable form of "a single flat value". */
      let inkMassPlume = 0, inkMassWorld = 0, plumeTop = 0;
      const vals = new Map();
      /* Kept because the anatomy scan needs it. Re-rendering the frame once per
         instance turns out not to reproduce it exactly — foliage and sky move
         with every render, by hundreds of levels in the trees at the left edge
         — so a difference taken against a reference render is only meaningful
         where the burst could possibly have drawn. This is that region. */
      const inPlume = new Uint8Array(w * h);
      for (let q = 0; q < shown.length; q += 4) {
        const dr = Math.abs(shown[q] - bare[q]) + Math.abs(shown[q + 1] - bare[q + 1])
          + Math.abs(shown[q + 2] - bare[q + 2]);
        const ls = 0.2126 * shown[q] + 0.7152 * shown[q + 1] + 0.0722 * shown[q + 2];
        const ln = 0.2126 * noink[q] + 0.7152 * noink[q + 1] + 0.0722 * noink[q + 2];
        const drop = (ln - ls) / 255;
        if (dr > 12) {
          plume++;
          inPlume[q >> 2] = 1;
          if (drop > 0.02) { inkPlume++; inkMassPlume += drop; }
          if (ls / 255 > 0.90) plumeTop++;
          const key = `${shown[q] >> 3},${shown[q + 1] >> 3},${shown[q + 2] >> 3}`;
          vals.set(key, (vals.get(key) || 0) + 1);
        } else {
          world++;
          if (drop > 0.02) { inkWorld++; inkMassWorld += drop; }
        }
      }
      let tones = 0;
      for (const c of vals.values()) if (c / Math.max(plume, 1) > 0.02) tones++;

      /* The ink mask itself, drawn. A number cannot tell a contour from a
         wash — both raise coverage — but a picture of where the pen went can,
         so on shot frames the plume is painted flat grey and every pixel the
         ink darkened is painted red at the strength of the darkening. A line
         around the mass is a contour; red spread through the middle is a
         stain, and the two want opposite fixes. */
      if (shot) {
        const m = document.createElement('canvas');
        m.width = w; m.height = h;
        const mc = m.getContext('2d');
        const img = mc.createImageData(w, h);
        for (let q = 0; q < shown.length; q += 4) {
          const dr = Math.abs(shown[q] - bare[q]) + Math.abs(shown[q + 1] - bare[q + 1])
            + Math.abs(shown[q + 2] - bare[q + 2]);
          const drop = (0.2126 * (noink[q] - shown[q]) + 0.7152 * (noink[q + 1] - shown[q + 1])
            + 0.0722 * (noink[q + 2] - shown[q + 2])) / 255;
          const hot = Math.max(0, Math.min(1, drop / 0.25));
          const on = dr > 12;
          img.data[q] = on ? 60 + hot * 195 : (drop > 0.02 ? 40 : 16);
          img.data[q + 1] = on ? 60 + (1 - hot) * 110 : (drop > 0.02 ? 70 : 16);
          img.data[q + 2] = on ? 60 + (1 - hot) * 110 : (drop > 0.02 ? 150 : 16);
          img.data[q + 3] = 255;
        }
        mc.putImageData(img, 0, 0);
        pngs[pngs.length - 1].mask = m.toDataURL('image/png');
      }

      g.camera.updateMatrixWorld();
      cp.setFromMatrixPosition(g.camera.matrixWorld);
      fwd.set(0, 0, -1).transformDirection(g.camera.matrixWorld);
      let bursts = 0, age = 0, wallH = 0, ringR = 0, d0 = 1e9, d1 = -1e9, foot = 0;
      /* How square each curtain segment is to the lens, which is the quantity
         the flank fix blends on. A chord whose tangent runs down the eye ray
         has nothing to project, so this is the number that says which of the
         twelve the approximation cannot draw. */
      const facings = [];
      const right = new V().set(1, 0, 0).transformDirection(g.camera.matrixWorld);
      const upV = new V().set(0, 1, 0).transformDirection(g.camera.matrixWorld);
      for (let j = 0; j < pool.max; j++) {
        if (!pool.active[j] || pool.kind[j] <= 2.5) continue;
        bursts++;
        age = Math.max(age, pool.ages[j]);
        if (pool.kind[j] <= 3.5) continue;
        const p3 = j * 3;
        wallH = Math.max(wallH, pool.scales[j * 2 + 1]);
        ringR = Math.max(ringR, Math.hypot(pool.centers[p3] - pool.origins[p3],
          pool.centers[p3 + 2] - pool.origins[p3 + 2]));
        v.set(pool.axes[p3], pool.axes[p3 + 1], pool.axes[p3 + 2]).normalize();
        facings.push(Math.hypot(v.dot(right), v.dot(upV)));
        v.set(pool.centers[p3], pool.centers[p3 + 1], pool.centers[p3 + 2]);
        const depth = v.clone().sub(cp).dot(fwd);
        d0 = Math.min(d0, depth); d1 = Math.max(d1, depth);
        foot = Math.max(foot, pool.centers[p3 + 1] - pool.scales[j * 2 + 1] * 0.5
          - (pool.origins[p3 + 1] - pool.baseSizeY[j] * 0.5));
      }
      rows.push({
        f, plume: +(plume / (w * h) * 100).toFixed(3), tones,
        ink: +(plume ? inkPlume / plume * 100 : 0).toFixed(2),
        world: +(inkWorld / world * 100).toFixed(2),
        mass: +(plume ? inkMassPlume / plume : 0).toFixed(3),
        massW: +(inkMassWorld / world).toFixed(3),
        top: +(plume ? plumeTop / plume * 100 : 0).toFixed(1),
        bursts, age: +age.toFixed(3), wallH: +wallH.toFixed(2), ringR: +ringR.toFixed(2),
        d0: bursts ? +d0.toFixed(1) : 0, d1: bursts ? +d1.toFixed(1) : 0,
        foot: +foot.toFixed(2), cover: +pool.coverage.toFixed(2), gate: +pool.gate.toFixed(2),
        fMin: +(facings.length ? Math.min(...facings) : 0).toFixed(2),
        fLo: +(facings.slice().sort((a, b) => a - b)[1] ?? 0).toFixed(2),
      });

      if (f === anatomy) {
        /* Every segment in one render, each a different hue. Differencing one
           instance at a time against a reference render was the obvious way to
           do this and it does not work here — the frame is not reproducible to
           the pixel — whereas a single render with the ring painted by index is
           exact, immediate, and answers the only question being asked: which
           quad drew the shape that is wrong. */
        const paint = [];
        for (let j = 0; j < pool.max; j++) {
          if (!pool.active[j]) continue;
          if (!byKind && pool.kind[j] <= 2.5) continue;
          paint.push([j, pool.colors[j * 3], pool.colors[j * 3 + 1], pool.colors[j * 3 + 2],
            pool.kind[j]]);
        }
        /* Cycled every four rather than swept round the wheel, so neighbours
           are never a similar colour and a fin standing beside a billow cannot
           be mistaken for part of it. */
        const wheel = [[1, 0.1, 0.1], [0.1, 1, 0.1], [0.2, 0.4, 1], [1, 0.9, 0.1]];
        /* One segment kept and the rest scaled away, when asked. A quad that
           only ever appears beside eleven others cannot be told apart from
           them; alone, its silhouette is its own. */
        if (solo >= 0) {
          paint.forEach(([j], k) => {
            if (k === solo) return;
            pool.scales[j * 2] = 0; pool.scales[j * 2 + 1] = 0;
          });
          pool.scaleAttr.needsUpdate = true;
        }
        paint.forEach(([j, , , , kd], k) => {
          /* Every flavour of dust separately, not just the four silhouette
             families. The sub-kinds below 0.5 all share plumeSdf and all read
             as "dust" to the shader's own test, but they are emitted by
             different events with different sizes and one of them opts out of
             erosion entirely — so a capture that lumps them together cannot say
             which one drew a shape. */
          const rgb = byKind
            ? [[1, 0.15, 0.15], [1, 0.55, 0.0], [0.6, 0.2, 0.9], [0.15, 1, 0.15],
              [0.1, 0.9, 0.9], [0.2, 0.4, 1], [1, 0.9, 0.1], [1, 0.2, 1]][
              kd < 0.02 ? 0 : kd < 0.10 ? 1 : kd < 0.35 ? 2 : kd < 0.5 ? 3
                : kd < 1.5 ? 4 : kd < 2.5 ? 5 : kd < 3.5 ? 6 : 7]
            : wheel[solo >= 0 ? (k === solo ? 0 : 1) : k % 4];
          pool.colors[j * 3] = rgb[0] * 0.62;
          pool.colors[j * 3 + 1] = rgb[1] * 0.62;
          pool.colors[j * 3 + 2] = rgb[2] * 0.62;
        });
        pool.colorAttr.needsUpdate = true;
        g.renderOnce();
        const pc = document.createElement('canvas');
        const pw = 1000, ph = 560;
        pc.width = pw; pc.height = ph;
        const pctx = pc.getContext('2d');
        pctx.imageSmoothingEnabled = false;
        const pq = p.pos.clone().project(g.camera);
        pctx.drawImage(cv, Math.max(0, Math.min(w - pw / 2.5, (pq.x * 0.5 + 0.5) * w - pw / 5)),
          Math.max(0, Math.min(h - ph / 2.5, (-pq.y * 0.5 + 0.5) * h - ph / 5)),
          pw / 2.5, ph / 2.5, 0, 0, pw, ph);
        pngs.push({ f: 900 + f, full: cv.toDataURL('image/png'), crop: pc.toDataURL('image/png') });
        for (const [j, r0, g0, b0] of paint) {
          pool.colors[j * 3] = r0; pool.colors[j * 3 + 1] = g0; pool.colors[j * 3 + 2] = b0;
        }
        pool.colorAttr.needsUpdate = true;
      }
      performance.now = realNow;
      g.setPaused(false);
      g.step(1 / 60);
    }
    return { rows, events, pngs, air: +air.toFixed(2) };
  }, [idx, N, SHOTS, ONLY, ANATOMY === '' ? -1 : +ANATOMY, SOLO === '' ? -1 : +SOLO, BYKIND, PAN, KEEP]);

  if (out.pngs.length) {
    const dir = path.join(ROOT, 'shots', TAG);
    fs.mkdirSync(dir, { recursive: true });
    for (const s of out.pngs) {
      const nn = String(s.f).padStart(2, '0');
      fs.writeFileSync(path.join(dir, `f${nn}.png`), Buffer.from(s.full.split(',')[1], 'base64'));
      fs.writeFileSync(path.join(dir, `f${nn}-crop.png`), Buffer.from(s.crop.split(',')[1], 'base64'));
      if (s.mask) fs.writeFileSync(path.join(dir, `f${nn}-ink.png`), Buffer.from(s.mask.split(',')[1], 'base64'));
    }
    console.log(`  → shots/${TAG}`);
  }

  console.log(`  air ${out.air}s`);
  for (const e of out.events) console.log('  ' + e);
  console.log('\n  frame  plume%  tones   ink%  world%   mass  massW   top%  age  wallH  depth       cover  gate  face2');
  for (const r of out.rows) {
    console.log(`  ${String(r.f).padStart(5)} ${r.plume.toFixed(3).padStart(6)}`
      + ` ${String(r.tones).padStart(6)} ${r.ink.toFixed(2).padStart(6)}`
      + ` ${r.world.toFixed(2).padStart(7)} ${r.mass.toFixed(3).padStart(6)}`
      + ` ${r.massW.toFixed(3).padStart(6)} ${r.top.toFixed(1).padStart(6)}`
      + ` ${r.age.toFixed(3).padStart(5)} ${r.wallH.toFixed(2).padStart(6)}`
      + ` ${(r.d0.toFixed(1) + '..' + r.d1.toFixed(1)).padStart(11)}`
      + ` ${r.cover.toFixed(2).padStart(6)} ${r.gate.toFixed(2).padStart(5)}`
      + ` ${r.fMin.toFixed(2).padStart(5)} ${r.fLo.toFixed(2).padStart(5)}`);
  }
  /* Frame 0 is the first grab after a long driveTo and carries an artifact
     worth about a quarter of a per cent of frame in EDGE pixels, so it is
     printed above and counted in nothing. */
  const live = out.rows.slice(1);
  const peak = live.reduce((a, b) => (b.plume > a.plume ? b : a), live[0]);
  const alive = live.filter(r => r.plume > peak.plume * 0.15).length;
  console.log(`\n  peak ${peak.plume}% at frame ${peak.f}, ink ${peak.ink}% vs world ${peak.world}%`
    + `, ink mass ${peak.mass} vs world ${peak.massW}, top bucket ${peak.top}%`);
  console.log(`  above 15% of peak for ${alive} frames (${(alive / 60).toFixed(2)} s at 60 Hz)`
    + '   — frame 0 excluded (driveTo artifact)');

});

finish(process.exitCode || 0);
