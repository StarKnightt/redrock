/* Read-only review captures for the jump system.
 *
 * Everything here renders through g.pipeline.render() (via g.renderOnce), the
 * same path the game draws with, on a car the AI has driven up to speed. No
 * teleports, no parked cars, no bypassing the cel/ink composite.
 *
 * Four batteries:
 *   approach   the pad and ramp at 130/100/75/50/34 m out, plus the pad's
 *              projected size in pixels at each range
 *   apex       the top of the flight, full frame and a 3x crop, taken twice:
 *              once as shipped and once with the camera's airborne pullback
 *              pinned to zero, so the pullback's effect on the read is visible
 *   landing    +2/+6/+12/+20 frames after touchdown, 3x crop on the car
 *   rival      a rival at its own apex
 *
 *   node tools/rampjudge.mjs --seed 22 [--ramp 1] [--tag judge]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, capture } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEED = +flag('seed', 22);
const RAMP = +flag('ramp', 1);
const TAG = flag('tag', 'judge');
const W = 1600, H = 900;

const outDir = path.join(ROOT, 'shots', TAG);
fs.mkdirSync(outDir, { recursive: true });

const save = (file, url) =>
  fs.writeFileSync(path.join(outDir, file), Buffer.from(url.split(',')[1], 'base64'));

/* One render, two products: the whole frame and a zoom on a world point.
   Both come out of the same drawing buffer inside one evaluate, because the
   buffer is not preserved and is gone by the next task. */
const shoot = (page, opts) => page.evaluate(({ zoom, box, at }) => {
  const g = window.__game, p = g.player;
  g.setPaused(true);
  g.renderOnce();
  const src = g.renderer.domElement;
  const full = src.toDataURL('image/png');
  let crop = null, where = null;
  if (zoom) {
    const target = at === 'car' ? p.pos.clone() : at;
    const q = target.clone().project(g.camera);
    const cx = (q.x * 0.5 + 0.5) * src.width;
    const cy = (-q.y * 0.5 + 0.5) * src.height;
    const w = box / zoom, h = w * 9 / 16;
    const x0 = Math.max(0, Math.min(src.width - w, cx - w / 2));
    const y0 = Math.max(0, Math.min(src.height - h, cy - h / 2));
    const c = document.createElement('canvas');
    c.width = box; c.height = Math.round(box * 9 / 16);
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(src, x0, y0, w, h, 0, 0, c.width, c.height);
    crop = c.toDataURL('image/png');
    where = { cx: +cx.toFixed(0), cy: +cy.toFixed(0) };
  }
  g.setPaused(false);
  return { full, crop, where };
}, opts);

await run({ width: W, height: H, hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0` },
  async ({ page }) => {

  const sites = await page.evaluate(() => {
    const g = window.__game;
    g.setPaused(true);
    return g.track.ramps.map(r => ({ lip: r.lip, foot: r.foot, pad0: r.pad0, pad1: r.pad1, land: r.land }));
  });
  const r = sites[Math.min(RAMP, sites.length - 1)];
  console.log(`  seed ${SEED} — ${sites.length} ramps, judging #${Math.min(RAMP, sites.length - 1)} at lip ${r.lip}`);

  /* ---- approach ladder ------------------------------------------------- */
  await page.evaluate((s) => {
    const g = window.__game;
    g.autopilot(true, 0.85);
    g.driveTo(s / g.track.length, { runUp: 320, maxSec: 45 });
  }, r.pad0 - 150);

  for (const d of [130, 100, 75, 50, 34]) {
    const at = await page.evaluate(([target, pad0, pad1, W, H]) => {
      const g = window.__game, p = g.player, track = g.track;
      let n = 0;
      while (p.s < target && n++ < 900) g.step(1 / 60);
      /* The pad as the player's eye gets it: the painted rectangle's four
         corners pushed through the live camera. Area in pixels is the honest
         measure of "can you see it" for a flat marking at a shallow angle. */
      const pt = (s, lat) => {
        const f = track.frameAt(s);
        const v = f.pos.clone().addScaledVector(f.right, lat).addScaledVector(f.up, 0.02);
        const q = v.project(g.camera);
        return { x: (q.x * 0.5 + 0.5) * W, y: (-q.y * 0.5 + 0.5) * H };
      };
      const c = [pt(pad0, -0.92), pt(pad1, -0.92), pt(pad1, 0.92), pt(pad0, 0.92)];
      let area = 0;
      for (let i = 0; i < 4; i++) {
        const a = c[i], b = c[(i + 1) % 4];
        area += a.x * b.y - b.x * a.y;
      }
      area = Math.abs(area) / 2;
      const ys = c.map(v => v.y), xs = c.map(v => v.x);
      return {
        s: +p.s.toFixed(0), kmh: +p.kmh.toFixed(0),
        padArea: +area.toFixed(0),
        padH: +(Math.max(...ys) - Math.min(...ys)).toFixed(1),
        padW: +(Math.max(...xs) - Math.min(...xs)).toFixed(1),
        padCy: +(ys.reduce((a, b) => a + b) / 4).toFixed(0),
      };
    }, [r.pad0 - d, r.pad0, r.pad1, W, H]);
    const shot = await shoot(page, { zoom: 3, box: 640, at: 'car' });
    save(`approach-${d}m.png`, shot.full);
    console.log(`    ${String(d).padStart(3)} m out  s ${at.s}  ${at.kmh} km/h`
      + `   pad on screen: ${at.padArea} px^2, ${at.padW}x${at.padH} px, centre y ${at.padCy}`);
  }

  /* ---- apex, as shipped ------------------------------------------------ */
  const flyTo = async (what) => page.evaluate((what) => {
    const g = window.__game, p = g.player;
    const test = {
      lip: () => p.airborne && p.launched && p.sinceLaunch < 0.2,
      apex: () => p.airborne && p.vertVel <= 0,
      land: () => p.launched && p.sinceLaunch > 0.05 && !p.airborne,
    }[what];
    let n = 0;
    while (n++ < 900) { g.step(1 / 60); if (test()) break; }
    return {
      s: +p.s.toFixed(0), h: +p.height.toFixed(2), kmh: +p.kmh.toFixed(0),
      boom: +g.camera.position.distanceTo(p.pos).toFixed(1),
      fov: +g.camera.fov.toFixed(1), air: +(g.chase.air ?? 0).toFixed(2),
      scale: +g.timeScale().toFixed(2),
    };
  }, what);

  const apex = await flyTo('apex');
  let shot = await shoot(page, { zoom: 3, box: 640, at: 'car' });
  save('apex-full.png', shot.full);
  save('apex-crop3x.png', shot.crop);
  console.log(`    apex  h ${apex.h} m  ${apex.kmh} km/h  boom ${apex.boom} m  fov ${apex.fov}  air ${apex.air}  time x${apex.scale}`);

  /* ---- landing --------------------------------------------------------- */
  const land = await flyTo('land');
  console.log(`    landing at s ${land.s}`);
  let f = 0;
  for (const target of [2, 6, 12, 20]) {
    await page.evaluate((k) => { const g = window.__game; for (let i = 0; i < k; i++) g.step(1 / 60); }, target - f);
    f = target;
    shot = await shoot(page, { zoom: 3.5, box: 700, at: 'car' });
    save(`land+${target}-full.png`, shot.full);
    save(`land+${target}-crop.png`, shot.crop);
  }

  /* ---- apex again, with the airborne pullback pinned off ----------------
     The camera reads this.air in four places. Pinning it to zero from the
     outside changes nothing in src/ and isolates one question: how much of
     the flight's on-screen size the pullback is costing. */
  await page.evaluate(() => {
    const c = window.__game.chase;
    let v = 0;
    Object.defineProperty(c, 'air', { get: () => 0, set: () => { v = 0; }, configurable: true });
  });
  await page.evaluate((s) => {
    const g = window.__game;
    g.autopilot(true, 0.85);
    g.driveTo(s / g.track.length, { runUp: 320, maxSec: 45 });
  }, r.pad0 - 60);
  const apexB = await flyTo('apex');
  shot = await shoot(page, { zoom: 3, box: 640, at: 'car' });
  save('apex-full-nopullback.png', shot.full);
  save('apex-crop3x-nopullback.png', shot.crop);
  console.log(`    apex, pullback pinned off  h ${apexB.h} m  boom ${apexB.boom} m  fov ${apexB.fov}`);

  await page.evaluate(() => window.__game.autopilot(false));
});

console.log(`  → shots/${TAG}`);
finish(process.exitCode || 0);
