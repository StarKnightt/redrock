/* kb* probe — a native chase-camera frame at a station, plus boot crops.
 *
 * Drives the car in with the autopilot rather than parking it, pins
 * performance.now() across the capture, discards frame 0, renders through
 * g.pipeline.render() at 1600x900 and writes the frame untouched. Then, for
 * every crowd figure within reach of the station, writes a 200x200 crop of
 * that same frame centred on the figure's feet — cut from the pixels, no
 * scaling of any kind.
 *
 *   node tools/kbshot.mjs --seed 1 --at 1478 --label residual [--reach 60]
 *                         [--stops 30,18,10]
 */
import fs from 'node:fs';
import path from 'node:path';
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEED = flag('seed', '1');
const AT = Number(flag('at', '1478'));
const LABEL = flag('label', 'shot');
const REACH = Number(flag('reach', '60'));
const STOPS = flag('stops', '30,18,10').split(',').map(Number);
const DIR = path.resolve(`shots/r2b-${SEED}`);

await run({
  width: 1600, height: 900,
  hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0`,
}, async ({ page }) => {
  page.setDefaultTimeout(900_000);
  const out = await page.evaluate(([at, reach, stops]) => {
    const g = window.__game;
    const THREE = g.THREE;
    const t = g.track;
    const W = g.renderer.domElement.width, H = g.renderer.domElement.height;
    const gl = g.renderer.getContext();
    const mesh = g.scene.getObjectByName('crowd-figures');
    const place = mesh ? mesh.geometry.getAttribute('aPlace') : null;

    const grab = () => {
      const px = new Uint8Array(W * H * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return px;
    };
    const idx = (x, yTop) => (H - 1 - yTop) * W + x;
    const cropPNG = (buf, cx, cy, S) => {
      const x0 = Math.max(0, Math.min(W - S, Math.round(cx) - (S >> 1)));
      const y0 = Math.max(0, Math.min(H - S, Math.round(cy) - (S >> 1)));
      const c = document.createElement('canvas');
      c.width = S; c.height = S;
      const ctx = c.getContext('2d');
      const img = ctx.createImageData(S, S);
      for (let yy = 0; yy < S; yy++) {
        for (let xx = 0; xx < S; xx++) {
          const p = idx(x0 + xx, y0 + yy) * 4, q = (yy * S + xx) * 4;
          img.data[q] = buf[p]; img.data[q + 1] = buf[p + 1];
          img.data[q + 2] = buf[p + 2]; img.data[q + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
      return c.toDataURL('image/png');
    };
    const full = buf => {
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const ctx = c.getContext('2d');
      const img = ctx.createImageData(W, H);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const p = idx(x, y) * 4, q = (y * W + x) * 4;
          img.data[q] = buf[p]; img.data[q + 1] = buf[p + 1];
          img.data[q + 2] = buf[p + 2]; img.data[q + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
      return c.toDataURL('image/png');
    };

    const shots = [];
    g.setPaused(true);
    g.autopilot(true, 0.85);
    for (const backM of stops) {
      const target = Math.max(1, at - backM);
      g.goTo(Math.max(0, target - 160) / t.length);
      g.warp(0.75);
      for (let k = 0; k < 900 && g.player.s < target; k++) g.step(1 / 60);

      const real = performance.now.bind(performance);
      const pinned = real();
      performance.now = () => pinned;
      g.renderOnce();                    // frame 0, discarded
      g.renderOnce();
      const A = grab();
      g.camera.updateMatrixWorld();
      const crops = [];
      if (place) {
        const f = t.frameAt(at);
        for (let i = 0; i < place.count; i++) {
          const p = new THREE.Vector3(place.getX(i), place.getY(i), place.getZ(i));
          if (Math.hypot(p.x - f.pos.x, p.z - f.pos.z) > reach) continue;
          const q = p.clone().project(g.camera);
          if (q.z < -1 || q.z > 1) continue;
          const sx = (q.x * 0.5 + 0.5) * W, sy = (-q.y * 0.5 + 0.5) * H;
          if (sx < -100 || sx > W + 100 || sy < -100 || sy > H + 100) continue;
          const vp = p.clone().applyMatrix4(g.camera.matrixWorldInverse);
          crops.push({
            i, sx: Math.round(sx), sy: Math.round(sy), range: +(-vp.z).toFixed(1),
            onScreen: sx >= 0 && sx < W && sy >= 0 && sy < H,
            url: cropPNG(A, sx, sy, 200),
          });
        }
      }
      shots.push({
        backM, s: +g.player.s.toFixed(1), kmh: +g.player.kmh.toFixed(0),
        cam: [+g.camera.position.x.toFixed(1), +g.camera.position.y.toFixed(1), +g.camera.position.z.toFixed(1)],
        url: full(A), crops,
      });
      performance.now = real;
    }
    g.autopilot(false);
    return { shots };
  }, [AT, REACH, STOPS]);

  fs.mkdirSync(DIR, { recursive: true });
  for (const s of out.shots) {
    const f = path.join(DIR, `kbshot-${LABEL}-at${AT}-back${s.backM}-s${Math.round(s.s)}.png`);
    fs.writeFileSync(f, Buffer.from(s.url.split(',')[1], 'base64'));
    console.log(`FRAME ${f}   car at s=${s.s} (${s.kmh} km/h) cam=[${s.cam}]`);
    for (const c of s.crops) {
      const cf = path.join(DIR, `kbcrop-${LABEL}-at${AT}-back${s.backM}-fig${c.i}-feet.png`);
      fs.writeFileSync(cf, Buffer.from(c.url.split(',')[1], 'base64'));
      console.log(`   crop fig ${String(c.i).padStart(3)} at screen (${c.sx},${c.sy})`
        + ` ${c.range} m away  onScreen=${c.onScreen}   ${cf}`);
    }
  }
});
finish(process.exitCode || 0);
