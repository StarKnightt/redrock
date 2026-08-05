/* A rival's plumb mark: is it a shadow, or is it the small dark patch on a
 * distant road that this project keeps shipping by accident?
 *
 * The player's mark is looked at from nine metres and is a hundred and sixty
 * pixels across, where there is no question about what it is. A rival's is
 * looked at from wherever the race puts it, and a four-metre mark at a hundred
 * metres is a dozen pixels — which is the size at which every previous version
 * of this failure has been reported. So the mark is faded out over the same
 * 70-150 m window the follow dust uses, and this checks what is left inside it.
 *
 * Nothing is placed and nothing is posed: the player is driven by autopilot to
 * the approach of each lip in turn, which is where the field is bunched and
 * where rivals leave the ground, and the race is then stepped until a rival is
 * airborne, in frame, and inside the fade window. At each hit it reports, by
 * ablation of that one rival's mark: how many pixels it covers, how wide it is,
 * its value ratio to the ground it covers, and the rival's own silhouette for
 * scale.
 *
 * One gate, and it is about the recurring failure rather than about the mark
 * being present: a mark larger on screen than the car it belongs to is not
 * reading as that car's shadow. There is deliberately no lower bound. A small
 * count here is not evidence of a defect — a rival barely off the ground has its
 * own ground point behind its own bodywork, which is true of the player at the
 * same height — so the count is reported and the fade's own value is the thing
 * being checked.
 *
 *   node tools/zjrival.mjs [--seeds 22,40] [--n 6]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, capture } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEEDS = flag('seeds', '22,40').split(',').map(Number);
const N = +flag('n', 6);
const W = 1600, H = 900;
/* A mark bigger on screen than the car it belongs to is not that car's shadow. */
const AREA_MAX = 1.0;
let fails = 0;

const outDir = path.join(ROOT, 'shots', 'zjrival');
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

/* Step the race until a rival is airborne, in frame and inside the mark's
   fade window. Returns which follower slot it is, so the probe can ablate that
   one mark rather than all of them. */
const FIND = ([limit]) => {
  const g = window.__game, THREE = g.THREE;
  const cars = (g.race?.entries || []).map(e => e.car).filter(c => c && c !== g.player);
  for (let n = 0; n < limit; n++) {
    g.step(1 / 60);
    for (let i = 0; i < cars.length; i++) {
      const c = cars[i];
      /* High enough that the mark is clear of the car's own bodywork. Below
         about two metres a rival's ground point projects inside its own
         silhouette and the mark ablates to nothing — which is true of the player
         at the same height and is the reason the fade-in starts where it does,
         not a fact about rivals. Sampling there measures the occlusion, not the
         mark. */
      if (!c.airborne || (c.height || 0) < 2.5) continue;
      const d = g.camera.position.distanceTo(c.pos);
      /* A floor as well as a ceiling, but a low floor: the census at the foot of
         this file measures where rivals actually are when they are airborne and
         in frame, and it is 3 to 54 m on one seed and 5 to 21 m on the other.
         Nothing sits out at the fade window. A ceiling of 140 m is kept so the
         faded end would be caught if the field ever spread that far, and the
         floor is only there to exclude a rival close enough that its own body
         covers its ground point. */
      if (d < 12 || d > 140) continue;
      const q = c.pos.clone().project(g.camera);
      if (q.x < -0.92 || q.x > 0.92 || q.y < -0.92 || q.y > 0.92 || q.z > 1) continue;
      /* Which mark belongs to it: the follow list is the race field in order,
         and the marks are held by position in that list. */
      const slot = g.effects._followers.findIndex(f => f.car === c);
      if (slot < 0) continue;
      return { slot, dist: +d.toFixed(1), h: +(c.height).toFixed(2), t: +g.player.raceTime.toFixed(1) };
    }
  }
  return null;
};

const MEASURE = ([slot]) => {
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
  const realNow = performance.now.bind(performance);
  const tPin = realNow(); performance.now = () => tPin;

  const air = g.effects._followMarks[slot];
  const mark = air.mesh;
  const car = g.effects._followers[slot].car;
  /* Why a zero is a zero. A mark can measure nothing for three quite different
     reasons and only one of them is a defect: it was never drawn, or it was
     drawn behind its own car, or it was drawn onto ground already in shadow.
     The mark is placed by a uniform rather than by the mesh's transform — the
     vertices live in the ellipse's own space — so the centre has to be read from
     there. The mesh itself sits at its parent's origin and says nothing. */
  const why = (() => {
    const p = air.material.uniforms.uCentre.value.clone();
    const q = p.clone().project(g.camera);
    const c = car.pos.clone().project(g.camera);
    return {
      visible: mark.visible, strength: +(air.strength ?? 1).toFixed(3),
      at: [Math.round((q.x * 0.5 + 0.5) * w), Math.round((-q.y * 0.5 + 0.5) * h)],
      carAt: [Math.round((c.x * 0.5 + 0.5) * w), Math.round((-c.y * 0.5 + 0.5) * h)],
      inFrame: q.x >= -1 && q.x <= 1 && q.y >= -1 && q.y <= 1 && q.z <= 1,
      drop: +p.distanceTo(car.pos).toFixed(2),
      outer: +air.outer.toFixed(2),
      core: +air.material.uniforms.uCore.value.toFixed(3),
    };
  })();
  grab();
  const on = grab();
  mark.visible = false;
  grab();
  const off = grab();
  mark.visible = true;
  performance.now = realNow;

  const lum = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
  let px = 0, x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
  const ratios = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const d = Math.abs(on[i] - off[i]) + Math.abs(on[i + 1] - off[i + 1])
        + Math.abs(on[i + 2] - off[i + 2]);
      if (d <= 12) continue;
      px++;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      const a = lum(off, i);
      if (a >= 4) ratios.push(lum(on, i) / a);
    }
  }
  ratios.sort((a, b) => a - b);
  const q = p => (ratios.length ? +ratios[Math.floor(p * ratios.length)].toFixed(3) : null);

  /* The rival's own silhouette, for scale: a mark much bigger than the car it
     belongs to is not reading as that car's shadow. */
  const view = (g.race.entries.find(e => e.car === car) || {}).view;
  let carPx = 0;
  if (view?.root) {
    const was = view.root.visible;
    view.root.visible = false;
    grab();
    const noCar = grab();
    view.root.visible = was;
    for (let i = 0; i < off.length; i += 4) {
      const d = Math.abs(off[i] - noCar[i]) + Math.abs(off[i + 1] - noCar[i + 1])
        + Math.abs(off[i + 2] - noCar[i + 2]);
      if (d > 12) carPx++;
    }
  }

  return {
    px, carPx, why,
    w: px ? x1 - x0 + 1 : 0, hPx: px ? y1 - y0 + 1 : 0,
    r10: q(0.10), r50: q(0.50),
  };
};

for (const SEED of SEEDS) {
  await run({ width: W, height: H, hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0` },
    async ({ page }) => {
      const lips = await page.evaluate(() => {
        window.__game.setPaused(true);
        return (window.__game.track.ramps || []).map(r => r.pad0);
      });
      console.log(`\n─── seed ${SEED} ───`);
      console.log('   t     range    h     mark px   mark w x h   rival px'
        + '   ratio 10/50   mark / rival area');
      let found = 0;
      /* Each lip in turn, and a second pass over them, since which rival is in
         frame at a lip depends on where the field has got to. The player is
         driven there rather than dropped: driveTo runs the autopilot in, so the
         car arrives loaded and at speed and the camera has settled. */
      for (let k = 0; k < N && found < N; k++) {
        const lip = lips[k % lips.length];
        await page.evaluate(s => {
          const g = window.__game;
          g.autopilot(true, 1.0);
          g.driveTo(s / g.track.length, { runUp: 320, maxSec: 45 });
        }, Math.max(120, lip - 200 - Math.floor(k / lips.length) * 40));
        const hit = await page.evaluate(FIND, [900]);
        if (!hit) continue;
        const m = await page.evaluate(MEASURE, [hit.slot]);
        await capture(page, path.join(outDir, `s${SEED}-${found}-${hit.dist}m.png`));
        found++;
        const area = m.carPx ? m.px / m.carPx : 0;
        const bad = area > AREA_MAX;
        if (bad) fails++;
        console.log(`  ${String(hit.t).padStart(5)} ${String(hit.dist).padStart(7)} m`
          + ` ${String(hit.h).padStart(5)} ${String(m.px).padStart(9)}`
          + `   ${String(m.w).padStart(4)} x ${String(m.hPx).padStart(3)}`
          + ` ${String(m.carPx).padStart(10)}`
          + `   ${String(m.r10 ?? '—').padStart(5)} / ${String(m.r50 ?? '—').padStart(5)}`
          + ` ${(m.carPx ? area.toFixed(2) + 'x' : '—').padStart(19)}`
          + (bad ? '   ← FAIL' : ''));
        if (m.px < 120) {
          console.log(`         mark visible ${m.why.visible}, strength ${m.why.strength},`
            + ` core x${m.why.core}, outer ${m.why.outer}, ${m.why.drop} m under the car`);
          console.log(`         mark at ${m.why.at[0]},${m.why.at[1]}`
            + ` and the car at ${m.why.carAt[0]},${m.why.carAt[1]}`
            + ` (mark in frame: ${m.why.inFrame})`);
        }
      }
      if (!found) console.log('   no rival went airborne in frame and in range');
    });
}

/* How often this is on screen at all, which the hits above cannot say. A full
   race, simulation only, counting every frame in which a rival is airborne: how
   many put it in frame, at what range, and how many of those are high enough for
   the mark to be clear of the car's own bodywork. This is the number that decides
   whether rival marks are worth having, and it is cheap because nothing renders. */
const CENSUS = () => {
  const g = window.__game, p = g.player;
  g.setPaused(true);
  /* From the grid, not from wherever the boot left the car — see tools/zjdet.mjs,
     which exists because this line was missing and the census disagreed with
     itself by an order of magnitude. */
  g.restart();
  g.autopilot(true, 0.9);
  g.countdown.skip();
  const cars = (g.race?.entries || []).map(e => e.car).filter(c => c && c !== g.player);
  let frames = 0, airAny = 0, inFrame = 0, clear = 0, faded = 0;
  let near = 1e9, far = -1e9, hMax = 0;
  for (let n = 0; n < 60 * 300; n++) {
    g.step(1 / 60);
    if (p.finished) break;
    frames++;
    let sawAir = false, sawFrame = false, sawClear = false, sawFaded = false;
    for (const c of cars) {
      if (!c.airborne || (c.height || 0) < 0.18) continue;
      sawAir = true;
      const q = c.pos.clone().project(g.camera);
      if (q.x < -1 || q.x > 1 || q.y < -1 || q.y > 1 || q.z > 1) continue;
      sawFrame = true;
      const d = g.camera.position.distanceTo(c.pos);
      if (d < near) near = d;
      if (d > far) far = d;
      if (d > 150) { sawFaded = true; continue; }
      if (c.height > hMax) hMax = c.height;
      if (c.height >= 2.5) sawClear = true;
    }
    if (sawAir) airAny++;
    if (sawFrame) inFrame++;
    if (sawClear) clear++;
    if (sawFaded) faded++;
  }
  g.autopilot(false);
  return {
    frames, airAny, inFrame, clear, faded,
    near: near < 1e9 ? +near.toFixed(0) : null,
    far: far > -1e9 ? +far.toFixed(0) : null,
    hMax: +hMax.toFixed(2),
  };
};

for (const SEED of SEEDS) {
  await run({ width: 640, height: 360, hash: `manual&tier=low&seed=${SEED}&cap=0&hud=0` },
    async ({ page }) => {
      const c = await page.evaluate(CENSUS);
      console.log(`\n  seed ${SEED} — a full race, ${c.frames} frames:`
        + ` a rival is off the ground on ${c.airAny}`
        + ` (${(100 * c.airAny / c.frames).toFixed(1)}%),`
        + ` in frame on ${c.inFrame} (${(100 * c.inFrame / c.frames).toFixed(1)}%)`);
      console.log(`    of those, ${c.clear} frames`
        + ` (${(100 * c.clear / c.frames).toFixed(1)}%) have one inside the fade window`
        + ` and high enough for its mark to clear its own body — peak ${c.hMax} m`);
      console.log(`    in-frame range ${c.near} .. ${c.far} m;`
        + ` ${c.faded} frames are beyond the 150 m fade and draw nothing`);
    });
}

console.log(fails
  ? `\n  FAIL — ${fails} rival mark(s) covered more of the frame than their own car`
  : `\n  PASS — every rival mark stayed smaller on screen than the car it belongs to`);
console.log('  → shots/zjrival');
if (fails) process.exitCode = 1;
finish(process.exitCode || 0);
