/* Native-resolution frames of a crowd site, plus a crop around its feet.
 *
 * tools/crowdshot.mjs cannot be used for this: its closest-frame walk breaks
 * on `now > last + 4`, and through a hairpin the straight-line distance to a
 * fixed point rises while the car is still driving towards it, so it stops
 * early and shoots from wherever it happened to be — seed 22's hairpin frame
 * was taken at 87 m. This drives to a station and shoots there, full stop.
 *
 * The crop is the point of it. tools/zzfoot.mjs reports a ratio between the
 * depth under a figure's feet and the figure's own depth, and calls anything
 * under 0.80 a "foreground occluder" — which covers both a figure standing in
 * mid air and a figure standing behind a berm, and those are not the same
 * defect. A 2x crop of the boots settles which one it is.
 *
 *   node tools/zqshot.mjs --seed 22 --at 5050 --back 20 --tag ramp
 *   node tools/zqshot.mjs --seed 22 --at 5572 --backs 60,40,25,15 --tag finish
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEED = flag('seed', '22');
const AT = Number(flag('at', '0'));
const BACKS = flag('backs', flag('back', '20')).split(',').map(Number);
const TAG = flag('tag', 'site');
const GRID = args.includes('--grid');

const outDir = path.join(ROOT, 'shots', 'zq');
fs.mkdirSync(outDir, { recursive: true });

await run({
  width: 1600, height: 900,
  hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0`,
}, async ({ page }) => {
  page.setDefaultTimeout(600_000);
  const shots = await page.evaluate(([at, backs, grid]) => {
    const g = window.__game;
    const THREE = g.THREE;
    const t = g.track;
    const mesh = g.scene.getObjectByName('crowd-figures');
    const place = mesh.geometry.getAttribute('aPlace');
    const W = g.renderer.domElement.width, H = g.renderer.domElement.height;
    const out = [];

    g.setPaused(true);
    if (grid) {
      g.goTo(34 / t.length);
      g.crowd.setHype(1);
    } else {
      g.autopilot(true, 0.85);
    }

    for (const back of backs) {
      if (!grid) {
        g.goTo(Math.max(0, at - back - 60) / t.length);
        g.warp(0.75);
        for (let k = 0; k < 320 && g.player.s < at - back; k++) g.step(1 / 60);
      }
      const real = performance.now.bind(performance);
      const pinned = real();
      performance.now = () => pinned;
      g.renderOnce();                 // frame 0, discarded
      g.renderOnce();
      const full = g.renderer.domElement.toDataURL('image/png');
      performance.now = real;

      /* Where the figures of interest landed on screen, so the crop can be
         put on their feet rather than in the middle of the frame. */
      const cam = g.camera;
      cam.updateMatrixWorld();
      let x0 = 1e9, x1 = -1e9, y1 = -1e9, n = 0;
      const v = new THREE.Vector3();
      for (let i = 0; i < place.count; i++) {
        const wx = place.getX(i), wy = place.getY(i), wz = place.getZ(i);
        if (Math.abs(wx - (grid ? wx : wx)) > 1e9) continue;
        v.set(wx, wy, wz);
        const ds = Math.hypot(v.x - cam.position.x, v.z - cam.position.z);
        if (ds > 60) continue;
        const p = v.clone().project(cam);
        if (p.z > 1 || Math.abs(p.x) > 1.2) continue;
        const sx = (p.x * 0.5 + 0.5) * W, sy = (-p.y * 0.5 + 0.5) * H;
        x0 = Math.min(x0, sx); x1 = Math.max(x1, sx); y1 = Math.max(y1, sy);
        n++;
      }
      /* A 2x crop centred on the feet, drawn with smoothing off so what comes
         out is the shipped pixels magnified and not a resampling of them. */
      let crop = null;
      if (n) {
        const cw = Math.max(220, Math.round(x1 - x0) + 200), ch = 200;
        const cx = Math.round((x0 + x1) / 2 - cw / 2);
        const cy = Math.round(y1 - ch * 0.62);
        const c = document.createElement('canvas');
        c.width = cw * 2; c.height = ch * 2;
        const ctx = c.getContext('2d');
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(g.renderer.domElement, cx, cy, cw, ch, 0, 0, cw * 2, ch * 2);
        crop = c.toDataURL('image/png');
      }
      out.push({
        back, s: +g.player.s.toFixed(0), full, crop, n,
        box: n ? [Math.round(x0), Math.round(x1), Math.round(y1)] : null,
      });
    }
    if (grid) g.crowd.setHype(0); else g.autopilot(false);
    return out;
  }, [AT, BACKS, GRID]);

  for (const sh of shots) {
    const base = `${TAG}-seed${SEED}-${GRID ? 'grid' : 'at' + AT}-back${sh.back}`;
    const file = path.join(outDir, base + '.png');
    fs.writeFileSync(file, Buffer.from(sh.full.split(',')[1], 'base64'));
    if (sh.crop) {
      fs.writeFileSync(path.join(outDir, base + '-feet.png'),
        Buffer.from(sh.crop.split(',')[1], 'base64'));
    }
    console.log(`  ${file}   car at s=${sh.s}, ${sh.n} figures within 60 m`
      + `${sh.box ? `, feet near x ${sh.box[0]}–${sh.box[1]} y ${sh.box[2]}` : ''}`);
  }
});
finish(process.exitCode || 0);
