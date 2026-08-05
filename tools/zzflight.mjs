/* Does a jump read as a jump?
 *
 * The launch is measured everywhere in tools/ except in the only unit that
 * matters, which is what the frame tells the player. A car four metres up
 * behind a chase camera that rose with it is drawn in exactly the place a car
 * on the road would be drawn; the only thing in the picture that can say
 * otherwise is the shadow it left on the ground. So this measures the
 * shadow — in pixels, at the apex, against a control frame taken with the
 * wheels down — and the screen-space daylight under the car with it.
 *
 * Method: the same frame rendered twice, once with the car casting and once
 * not. The difference is the car's own shadow and nothing else, because
 * nothing else in the scene changed. performance.now is pinned, because
 * src/world/environment.js drives a uniform from it and two renders of a
 * still scene otherwise differ; frame 0 after any state change is discarded.
 *
 *   node tools/zzflight.mjs [--seed 22] [--tag flight22]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, capture } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEEDS = flag('seeds', flag('seed', '22')).split(',').map(Number);
const TAG = flag('tag', 'flight');

const outDir = path.join(ROOT, 'shots', TAG);
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

for (const SEED of SEEDS) {
  await run({
    width: 1600, height: 900,
    hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0`,
  }, async ({ page }) => {
    const ramps = await page.evaluate(() => {
      window.__game.setPaused(true);
      return (window.__game.track.ramps || []).map(r => ({ lip: r.lip, pad0: r.pad0 }));
    });
    console.log(`\n  seed ${SEED} — ${ramps.length} ramps`);
    console.log('    site   moment    h      boom   car px   shadow px   shadow box'
      + '            gap car→ground');

    const probe = () => page.evaluate(() => {
      const g = window.__game;
      const THREE = g.THREE;
      g.setPaused(true);
      const cv = g.renderer.domElement, w = cv.width, h = cv.height;
      const tmp = document.createElement('canvas');
      tmp.width = w; tmp.height = h;
      const tc = tmp.getContext('2d');
      const grab = () => {
        g.renderOnce(); tc.drawImage(cv, 0, 0);
        return tc.getImageData(0, 0, w, h).data;
      };
      const realNow = performance.now.bind(performance);
      const tPin = realNow(); performance.now = () => tPin;

      /* Casting, then not. The car's own pixels are identical in both, so the
         difference is exactly the shadow it throws. */
      const casters = [];
      g.playerView.root.traverse(o => { if (o.isMesh && o.castShadow) casters.push(o); });
      grab();
      const on = grab();
      for (const o of casters) o.castShadow = false;
      grab();
      const off = grab();
      for (const o of casters) o.castShadow = true;

      /* And where the car is on screen, plus the point on the ground directly
         under it — the daylight between those two is what "in the air" looks
         like from behind. */
      const p = g.player;
      const cam = g.camera;
      const proj = (v) => {
        const q = v.clone().project(cam);
        return { x: (q.x * 0.5 + 0.5) * w, y: (-q.y * 0.5 + 0.5) * h, z: q.z };
      };
      const carPt = proj(new THREE.Vector3(p.pos.x, p.pos.y, p.pos.z));
      const f = g.track.frameAt(p.s);
      const ground = new THREE.Vector3();
      p.surfaceAt(p.s, p.lat, ground);
      const gndPt = proj(ground);

      let px = 0, x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          const d = Math.abs(on[i] - off[i]) + Math.abs(on[i + 1] - off[i + 1])
            + Math.abs(on[i + 2] - off[i + 2]);
          if (d <= 12) continue;
          px++;
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
      performance.now = realNow;

      /* The car's own footprint on screen, so "shadow px" has a scale. */
      const box = new THREE.Box3().setFromObject(g.playerView.root);
      const cs = [];
      for (const sx of [box.min.x, box.max.x]) {
        for (const sy of [box.min.y, box.max.y]) {
          for (const sz of [box.min.z, box.max.z]) cs.push(proj(new THREE.Vector3(sx, sy, sz)));
        }
      }
      const cx0 = Math.min(...cs.map(c => c.x)), cx1 = Math.max(...cs.map(c => c.x));
      const cy0 = Math.min(...cs.map(c => c.y)), cy1 = Math.max(...cs.map(c => c.y));

      return {
        h: +p.height.toFixed(2), kmh: +p.kmh.toFixed(0),
        boom: +g.camera.position.distanceTo(p.pos).toFixed(2),
        air: +g.chase.air.toFixed(2),
        fov: +g.camera.fov.toFixed(1),
        pitch: +(p.airPitch * 180 / Math.PI).toFixed(1),
        shadowPx: px,
        shadowBox: px ? [x0, y0, x1 - x0 + 1, y1 - y0 + 1] : null,
        carPx: Math.round((cx1 - cx0) * (cy1 - cy0)),
        carW: Math.round(cx1 - cx0),
        /* Screen distance from the bottom of the car to the ground point
           beneath it. On the road this is a couple of pixels; in the air it
           is what the player has to notice, and only if something marks it. */
        gap: Math.round(gndPt.y - cy1),
      };
    });

    const STEP = (until, arg = 0, limit = 900) => page.evaluate(([until, arg, limit]) => {
      const g = window.__game, p = g.player;
      const test = {
        pad: () => p.s >= arg,
        apex: () => p.airborne && p.vertVel <= 0,
        mid: () => p.airborne && p.sinceLaunch > 0.9,
      }[until];
      let n = 0;
      while (n++ < limit) { g.step(1 / 60); if (test()) break; }
      return n < limit;
    }, [until, arg, limit]);

    for (let i = 0; i < ramps.length; i++) {
      const r = ramps[i];
      await page.evaluate(s => {
        const g = window.__game;
        g.autopilot(true, 0.85);
        g.driveTo(s / g.track.length, { runUp: 320, maxSec: 45 });
      }, r.pad0 - 60);

      /* Control: wheels on the road, same camera, same everything. */
      await STEP('pad', r.pad0 - 40);
      const road = await probe();
      await capture(page, path.join(outDir, `s${SEED}-r${i}-road.png`));

      await STEP('apex');
      const apex = await probe();
      await capture(page, path.join(outDir, `s${SEED}-r${i}-apex.png`));
      await page.evaluate(() => window.__game.autopilot(false));

      for (const [name, m] of [['on road', road], ['APEX', apex]]) {
        console.log(`    r${i}  ${name.padEnd(9)} ${String(m.h).padStart(5)} m`
          + ` ${String(m.boom).padStart(6)}  ${String(m.carPx).padStart(6)}`
          + ` ${String(m.shadowPx).padStart(10)}   `
          + `${(m.shadowBox ? m.shadowBox.join(',') : 'NO SHADOW IN FRAME').padEnd(22)}`
          + ` ${String(m.gap).padStart(5)} px`);
      }
    }
  });
}

console.log(`\n  → shots/${TAG}`);
finish(process.exitCode || 0);
