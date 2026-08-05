/* Native-pixel crops of the landing, so the burst can be judged at 1:1.
 *
 * A 1600x900 frame does not survive being looked at through a viewer that
 * fits it to a page — round 3's whole finding was that this burst reads well
 * magnified and badly at native scale, so a downscaled 1600x900 is exactly the
 * wrong picture to argue from. This renders the full frame and then copies a
 * WxH window out of it at one screen pixel per image pixel, with no filtering
 * of any kind.
 *
 * The window is centred on the car's screen position unless --cx/--cy are
 * given, so the same window follows the car down the road.
 *
 *   node tools/x4crop.mjs --seed 22 --n 20 --w 640 --h 360 --out shots/x4c-22
 */
import fs from 'node:fs';
import path from 'node:path';
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEED = +flag('seed', 22);
const RAMP = +flag('ramp', 1);
const N = +flag('n', 20);
const CW = +flag('w', 640);
const CH = +flag('h', 360);
const DY = +flag('dy', 40);           // window centre below the car's origin
const OUT = flag('out', `shots/x4c-${SEED}`);
const PAIR = args.includes('--pair');
const UNGATE = args.includes('--ungate');

fs.mkdirSync(OUT, { recursive: true });

await run({ width: 1600, height: 900, hash: `manual&tier=high&seed=${SEED}&cap=0&hud=0&ink=1` },
  async ({ page }) => {
    const info = await page.evaluate(([idx, cw, ch]) => {
      const g = window.__game, p = g.player;
      const pool = g.effects.particles;
      g.setPaused(true);
      if (g.race?.entries) g.race.entries.length = 0;
      for (let i = 0; i < pool.max; i++) {
        pool.active[i] = 0; pool.scales[i * 2] = pool.scales[i * 2 + 1] = 0;
      }
      pool.live = 0; pool.cursor = 0; pool._resetRandom();

      const r = g.track.ramps[Math.min(idx, g.track.ramps.length - 1)];
      g.autopilot(true, 0.85);
      g.driveTo((r.pad0 - 60) / g.track.length, { runUp: 320, maxSec: 45 });
      let k = 0, wasAir = false;
      while (k++ < 900) {
        g.step(1 / 60);
        if (p.airborne) wasAir = true;
        if (wasAir && !p.airborne) break;
      }
      g.setPaused(true);
      const cv = g.renderer.domElement;
      const tmp = document.createElement('canvas');
      tmp.width = cw; tmp.height = ch;
      window.__x4 = {
        t0: performance.now(), f: 0, real: performance.now.bind(performance),
        pool, tmp, tc: tmp.getContext('2d'), cw, ch,
      };
      /* The burst's ink class, swapped in the prepass material's own source so
         the composite's interior-suppression gate stops firing. Class 8 is
         unclassified and takes the same uWOther pen weight class 7 takes, so
         the ONLY difference is the gate. Nothing under src/ is touched. */
      const mat = pool.prepassMaterial;
      window.__x4.SRC = mat.fragmentShader;
      window.__x4.UNG = mat.fragmentShader.replace('mix(6.0, 7.0, isBurstWall)', 'mix(6.0, 8.0, isBurstWall)');
      window.__x4.mat = mat;
      g.renderOnce();
      return { seed: g.track.seed, lip: r.lip, kmh: Math.round(p.speed * 3.6),
               patched: window.__x4.UNG !== window.__x4.SRC };
    }, [RAMP, CW, CH]);

    console.log(`  seed ${info.seed}, ramp lip ${info.lip}, touchdown at ${info.kmh} km/h`);

    const dump = async (hide) => await page.evaluate(([hideBurst, dy]) => {
      const g = window.__game, s = window.__x4, pool = s.pool, p = g.player;
      const t = s.t0 + s.f * (1000 / 60);
      performance.now = () => t;
      if (hideBurst === 'ungate') { s.mat.fragmentShader = s.UNG; s.mat.needsUpdate = true; }
      let kept = null;
      if (hideBurst === true) {
        kept = [];
        for (let i = 0; i < pool.max; i++) {
          if (pool.kind[i] < 4.5) continue;
          kept.push([i, pool.scales[i * 2], pool.scales[i * 2 + 1]]);
          pool.scales[i * 2] = pool.scales[i * 2 + 1] = 0;
        }
        pool.scaleAttr.needsUpdate = true;
      }
      g.renderOnce();
      const cv = g.renderer.domElement;
      const q = p.pos.clone().project(g.camera);
      const cx = Math.round((q.x * 0.5 + 0.5) * cv.width);
      const cy = Math.round((-q.y * 0.5 + 0.5) * cv.height) + dy;
      const x0 = Math.max(0, Math.min(cv.width - s.cw, cx - (s.cw >> 1)));
      const y0 = Math.max(0, Math.min(cv.height - s.ch, cy - (s.ch >> 1)));
      /* One screen pixel per image pixel: source rect and dest rect are the
         same size, so no resampling filter can touch the ink. */
      s.tc.clearRect(0, 0, s.cw, s.ch);
      s.tc.drawImage(cv, x0, y0, s.cw, s.ch, 0, 0, s.cw, s.ch);
      const url = s.tmp.toDataURL('image/png');
      if (kept) {
        for (const [i, sx, sy] of kept) { pool.scales[i * 2] = sx; pool.scales[i * 2 + 1] = sy; }
        pool.scaleAttr.needsUpdate = true;
      }
      if (hideBurst === 'ungate') { s.mat.fragmentShader = s.SRC; s.mat.needsUpdate = true; g.renderOnce(); }
      performance.now = s.real;
      return url;
    }, [hide, DY]);

    const write = (url, file) =>
      fs.writeFileSync(file, Buffer.from(url.split(',')[1], 'base64'));

    for (let f = 0; f < N; f++) {
      write(await dump(false), path.join(OUT, `c${String(f).padStart(2, '0')}.png`));
      if (PAIR) write(await dump(true), path.join(OUT, `c${String(f).padStart(2, '0')}-no.png`));
      if (UNGATE) write(await dump('ungate'), path.join(OUT, `c${String(f).padStart(2, '0')}-ungated.png`));
      await page.evaluate(() => {
        const g = window.__game, s = window.__x4;
        s.f++; g.setPaused(false); g.step(1 / 60); g.setPaused(true);
      });
    }
    console.log(`  wrote ${N} ${CW}x${CH} native crops to ${OUT}`);
  });

finish(process.exitCode || 0);
